/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_ws = require('ws');
const mod_assert = require('assert-plus');
const mod_fs = require('fs');
const mod_fsm = require('mooremachine');
const mod_util = require('util');
const mod_bunyan = require('bunyan');
const mod_crypto = require('crypto');
const mod_stream = require('stream');
const mod_restify = require('restify-clients');
const mod_sshpk = require('sshpk');
const mod_events = require('events');
const mod_http = require('http');
const mod_vasync = require('vasync');
const mod_gbot = require('gerritbot');

var config = JSON.parse(
    mod_fs.readFileSync('etc/config.json').toString('utf-8'));

mod_assert.object(config, 'config');
mod_assert.optionalNumber(config.port, 'config.port');
if (config.port === undefined)
	config.port = 8080;

var log = mod_bunyan.createLogger({ name: 'makecheckbot' });

var repoHasMakeCheck = {};
repoHasMakeCheck['joyent/illumos-extra'] = false;
repoHasMakeCheck['joyent/illumos-joyent'] = false;
repoHasMakeCheck['joyent/zfs_snapshot_tar'] = false;
repoHasMakeCheck['joyent/illumos-kvm'] = false;
repoHasMakeCheck['joyent/postgres'] = false;

var dockerKeyPem = mod_fs.readFileSync(config.docker.keyFile);
var dockerKey = mod_sshpk.parsePrivateKey(dockerKeyPem);
var id = mod_sshpk.identityFromDN('CN=' + config.docker.user);
var cert = mod_sshpk.createSelfSignedCertificate(id, dockerKey);

config.gerrit.log = log;
config.gerrit.recovery = {
	default: {
		timeout: 30000,
		maxTimeout: 120000,
		delay: 5000,
		maxDelay: 15000,
		retries: Infinity
	}
};
var gerrit = new mod_gbot.Client(config.gerrit);

var docker = mod_restify.createJsonClient({
	url: 'https://' + config.docker.host + ':2376',
	rejectUnauthorized: false,
	key: dockerKeyPem,
	cert: cert.toBuffer('pem')
});

const COOKIE = mod_crypto.randomBytes(8).toString('base64');

var spawning = {};

function spawnWorker() {
	var spawnCookie = mod_crypto.randomBytes(8).toString('base64');
	spawning[spawnCookie] = true;
	var agentUrl =
	    'http://' + config.my_name + ':' + config.port + '/agent.js';
	var payload = {
		Hostname: '',
		Domainname: '',
		User: '',
		AttachStdin: false,
		AttachStdout: false,
		AttachStderr: false,
		Tty: false,
		OpenStdin: false,
		StdinOnce: false,
		Env: [],
		Cmd: [
			'/usr/bin/bash', '-c',
			'export PATH=/opt/local/bin:/opt/local/sbin:$PATH; ' +
			'useradd -P "Primary Administrator" -s /usr/bin/bash ' +
				'-m build && ' +
			'pkgin -y up && ' +
			'pkgin -y in nodejs && ' +
			'curl -O ' + agentUrl + ' && ' +
			'npm install ws && ' +
			'/usr/lib/pfexecd && ' +
			'exec su - build -c "' +
				'exec node /tmp/agent.js ' + config.my_name +
				' ' + config.port + ' ' + COOKIE +
			'"'
		],
		Entrypoint: [],
		Image: config.slaves.image,
		Labels: { 'buildbot.worker': 'true' },
		Volumes: {},
		WorkingDir: '/tmp',
		NetworkDisabled: false,
		NetworkMode: config.docker.network,
		ExposedPorts: {},
		StopSignal: 'SIGTERM',
		HostConfig: {
			Binds: [],
			Links: [],
			LxcConf: {'lxc.utsname': 'docker'},
			Memory: 2048 * 1024 * 1024,
			Dns: ['8.8.8.8', '8.8.4.4']
		}
	};
	docker.post('/containers/create', payload,
	    function (err, req, res, obj) {
		if (err) {
			delete (spawning[spawnCookie]);
			log.error(err, 'spawning docker container');
		} else {
			var cid = obj.Id.slice(0, 12);
			log.info('created docker container %s', cid);
			docker.post('/containers/' + cid + '/start', {},
			    function (err2) {
				if (err2) {
					delete (spawning[spawnCookie]);
					log.error(err2,
					    'starting docker container %s',
					    cid);
				} else {
					delete (spawning[spawnCookie]);
					spawning[cid] = true;
					log.info('started docker container %s',
					    cid);
				}
			});
		}
	});
}

var slaves = [];
var httpServer = mod_http.createServer();
var server = new mod_ws.Server({ server: httpServer });

server.on('connection', function onConnection(ws) {
	var conn = new SlaveConnection({
		config: config,
		log: log
	});
	conn.accept(ws);
	runQueue();
});

httpServer.on('request', function (req, res) {
	if (req.url === '/agent.js') {
		res.writeHead(200);
		mod_fs.createReadStream('./agent.js').pipe(res);
	} else {
		res.writeHead(404);
		res.end();
	}
});

httpServer.listen(config.port);

function SlaveConnection(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.config, 'options.config');
	mod_assert.optionalObject(opts.log, 'options.log');
	this.sc_log = opts.log;
	this.sc_ws = undefined;
	if (this.sc_log === undefined)
		this.sc_log = mod_bunyan.createLogger({ name: 'connection '});
	this.sc_config = opts.config;
	this.sc_uuid = undefined;
	this.sc_kids = {};
	this.sc_lastMsg = [];
	slaves.push(this);
	mod_fsm.FSM.call(this, 'idle');
}
mod_util.inherits(SlaveConnection, mod_fsm.FSM);

SlaveConnection.prototype.accept = function (ws) {
	mod_assert.strictEqual(this.getState(), 'idle');
	this.sc_ws = ws;
	var req = this.sc_ws.upgradeReq;
	var sock = req.socket;
	this.sc_log = this.sc_log.child({
		client: sock.remoteAddress + ':' + sock.remotePort
	});
	this.emit('acceptAsserted');
};

SlaveConnection.prototype.state_idle = function (S) {
	S.on(this, 'acceptAsserted', function () {
		S.gotoState('auth');
	});
};

SlaveConnection.prototype.state_auth = function (S) {
	var self = this;
	S.timeout(5000, function () {
		S.gotoState('closing');
	});
	S.on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		var keys = Object.keys(msg).sort();
		if (msg.cookie === COOKIE && keys.length === 2 &&
		    keys[0] === 'cookie' && keys[1] === 'uuid') {
			self.sc_uuid = msg.uuid.replace(/-/g, '');
			var cid = self.sc_uuid.slice(0, 12);
			delete (spawning[cid]);
			self.sc_log.info('authenticated agent on %s', cid);
			self.sc_log = self.sc_log.child({ cid: cid });
			S.gotoState('setup');
		} else {
			self.sc_log.warn('failed to auth slave, disconnecting');
			S.gotoState('closing');
		}
	});
	S.on(this.sc_ws, 'close', function () {
		S.gotoState('closing');
	});
};

SlaveConnection.prototype.state_setup = function (S) {
	var self = this;
	S.on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this.sc_ws, 'close', function () {
		S.gotoState('closing');
	});
	S.gotoState('setup.pkgsrc');
};

SlaveConnection.prototype.state_setup.pkgsrc = function (S) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.sc_config.slaves.pkgsrc || []
	}, function (err) {
		if (err) {
			self.sc_log.error(err, 'failed to setup zone');
			S.gotoState('closing');
			return;
		}
		S.gotoState('setup.npm');
	});
	function processPkgsrc(instr, cb) {
		var cmd = 'pfexec';
		var args = ['/opt/local/bin/pkgin', '-y'];
		var m = instr.match(/^-(.+)$/);
		if (m) {
			args.push('rm');
			args.push(m[1]);
		} else {
			args.push('in');
			args.push(instr);
		}
		var kid = self.spawn(cmd, args);
		var errOut = '';
		S.on(kid.stderr, 'data', function (data) {
			errOut = errOut + data.toString('utf-8');
		});
		S.on(kid, 'close', function (exitStatus) {
			if (exitStatus === 0) {
				cb();
				return;
			}
			self.sc_log.error('failed to run pkgin cmd in zone',
			    {args: args, stderr: errOut});
			cb(new Error('pkgin command failed'));
		});
	}
};

SlaveConnection.prototype.state_setup.npm = function (S) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.sc_config.slaves.npm || []
	}, function (err) {
		if (err) {
			self.sc_log.error(err, 'failed to setup zone');
			S.gotoState('closing');
			return;
		}
		S.gotoState('setup.clean_old');
	});
	function processPkgsrc(instr, cb) {
		var cmd = 'pfexec';
		var args = ['/opt/local/bin/npm', 'install', '-g', instr];
		var kid = self.spawn(cmd, args);
		var errOut = '';
		S.on(kid.stderr, 'data', function (data) {
			errOut = errOut + data.toString('utf-8');
		});
		S.on(kid, 'close', function (exitStatus) {
			if (exitStatus === 0) {
				cb();
				return;
			}
			self.sc_log.error('failed to run npm cmd in zone',
			    {args: args, stderr: errOut});
			cb(new Error('npm command failed'));
		});
	}
};

SlaveConnection.prototype.state_setup.clean_old = function (S) {
	var self = this;
	var kid = this.spawn('rm',
	    ['-rf',
	    '/home/build/jsstyle',
	    '/home/build/javascriptlint',
	    '/tmp/repo']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('setup.jsl_clone');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_setup.jsl_clone = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['clone',
	    'https://github.com/davepacheco/javascriptlint',
	    '/home/build/javascriptlint']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('setup.jsl_chdir');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_setup.jsl_chdir = function (S) {
	var self = this;
	var emitter = this.chdir('/home/build/javascriptlint');
	S.on(emitter, 'done', function () {
		S.gotoState('setup.jsl_build');
	});
	S.on(emitter, 'error', function (err) {
		self.sc_log.error(err, 'failed to chdir');
		S.gotoState('closing');
	});
};

SlaveConnection.prototype.state_setup.jsl_build = function (S) {
	var self = this;
	var kid = this.spawn('gmake', ['install']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('setup.jsstyle_clone');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_setup.jsstyle_clone = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['clone',
	    'https://github.com/davepacheco/jsstyle',
	    '/home/build/jsstyle']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('setup.lintpaths');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_setup.lintpaths = function (S) {
	var self = this;
	var emitter = this.addPath([
	    '/home/build/javascriptlint/build/install',
	    '/home/build/jsstyle'
	]);
	S.on(emitter, 'done', function () {
		S.gotoState('ready');
	});
	S.on(emitter, 'error', function (err) {
		self.sc_log.error(err, 'failed to add paths');
		S.gotoState('closing');
	});
};

SlaveConnection.prototype.state_ready = function (S) {
	var self = this;
	this.sc_log.info('ready to rock');
	S.on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this, 'claimAsserted', function () {
		S.gotoState('running');
	});
	S.on(this.sc_ws, 'close', function () {
		S.gotoState('closing');
	});
	runQueue();
};

SlaveConnection.prototype.build = function (change, patchset) {
	mod_assert.strictEqual(this.getState(), 'ready');
	this.sc_change = change;
	this.sc_patchset = patchset;
	this.emit('claimAsserted');
};

SlaveConnection.prototype.release = function () {
	mod_assert.strictEqual(this.getState(), 'running');
	this.emit('releaseAsserted');
};

SlaveConnection.prototype.state_running = function (S) {
	var self = this;
	this.sc_log.info('building %s #%d (ps %d)', this.sc_change.project,
	    this.sc_change.number, this.sc_patchset.number);
	S.on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this, 'releaseAsserted', function () {
		S.gotoState('closing');
	});
	S.on(this.sc_ws, 'close', function () {
		S.gotoState('closing');
	});
	S.gotoState('running.clone');
};

SlaveConnection.prototype.state_running.clone = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['clone',
	    'https://' + config.gerrit.host + '/' + this.sc_change.project,
	    '/tmp/repo']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('running.chdir');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_running.chdir = function (S) {
	var self = this;
	var emitter = this.chdir('/tmp/repo');
	S.on(emitter, 'done', function () {
		S.gotoState('running.fetch');
	});
	S.on(emitter, 'error', function (err) {
		self.sc_log.error(err, 'failed to chdir');
		S.gotoState('closing');
	});
};

SlaveConnection.prototype.state_running.fetch = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['fetch', 'origin', this.sc_patchset.ref]);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('running.checkout');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_running.checkout = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['checkout', '-f', 'FETCH_HEAD']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('running.findmake');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_running.findmake = function (S) {
	var self = this;
	var kid = this.spawn('gmake', ['-q', 'check']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0 || exitStatus === 1) {
			S.gotoState('running.makecheck');
			return;
		}
		if (repoHasMakeCheck[self.sc_change.project] === undefined)
			repoHasMakeCheck[self.sc_change.project] = false;
		self.sc_log.warn({status: exitStatus, stderr: errOut},
		    'make check first run failed, skipping');
		S.gotoState('closing');
	});
};

SlaveConnection.prototype.state_running.makecheck = function (S) {
	var self = this;
	var kid = this.spawn('gmake', ['check']);
	S.on(kid, 'close', function (exitStatus) {
		self.sc_status = exitStatus;
		if (exitStatus === 0)
			repoHasMakeCheck[self.sc_change.project] = true;
		self.sc_log.info({status: exitStatus},
		    'make check first run done');
		S.gotoState('running.makecheck2');
	});
};

SlaveConnection.prototype.state_running.makecheck2 = function (S) {
	var self = this;
	var kid = this.spawn('gmake', ['check']);
	var out = '';
	S.on(kid.stderr, 'data', function (data) {
		out += data.toString('utf-8');
	});
	S.on(kid.stdout, 'data', function (data) {
		out += data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		self.sc_out = out.split('\n');
		self.sc_status = exitStatus;
		self.sc_log.info({status: exitStatus, output: self.sc_out},
		    'make check done');
		S.gotoState('running.report');
	});
};

var JSL_RE = /^\/tmp\/repo\/([^(:]+)\(([0-9]+)\): (.+)$/;
var JSL_NULL_RE = /^\/tmp\/repo\/([^(:]+)$/;
var JSSTYLE_RE = /^([^:]+): ([0-9]+): (.+)$/;
var ESLINT_FILE_RE = /^\/tmp\/repo\/(.+)$/;
var ESLINT_RE = /^\s*([0-9]+):[0-9]+\s+([^ ]+)\s\s+(.+)\s\s+(.+)$/;
var BASHSTY_RE = /^([^:]+): ([0-9]+): (.+)$/;

SlaveConnection.prototype.state_running.report = function (S) {
	var self = this;
	var review = {};
	review.labels = {};
	if (this.sc_status === 0) {
		review.message = '"make check" passed ok';
		review.labels['CI-Testing'] = '+1';
	} else {
		review.message = '"make check" exited with status ' +
		    this.sc_status;
		review.labels['CI-Testing'] = '-1';

		var comments = [];
		var ls = this.sc_out;
		var mode = 'none';
		var esfile;
		var c, m;

		for (var i = 0; i < ls.length; ++i) {
			if (ls[i].match(/^\s*$/))
				continue;
			if (mode === 'jsl') {
				m = ls[i].match(JSL_RE);
				if (m) {
					c = {};
					c.path = m[1];
					c.line = parseInt(m[2], 10);
					c.message = m[3];
					comments.push(c);
					continue;
				} else if (ls[i].match(JSL_NULL_RE)) {
					continue;
				} else {
					mode = 'none';
				}
			}
			if (mode === 'jsstyle') {
				m = ls[i].match(JSSTYLE_RE);
				if (m) {
					c = {};
					c.path = m[1];
					c.line = parseInt(m[2], 10);
					c.message = m[3];
					comments.push(c);
					continue;
				} else if (ls[i].match(/^Unescaped left br/)) {
					continue;
				} else {
					mode = 'none';
				}
			}
			if (mode === 'eslint') {
				m = ls[i].match(ESLINT_FILE_RE);
				if (m) {
					esfile = m[1];
					continue;
				}
				m = ls[i].match(ESLINT_RE);
				if (m && esfile !== undefined) {
					c = {};
					c.path = esfile;
					c.line = parseInt(m[1], 10);
					c.message = m[3].trim();
					comments.push(c);
					continue;
				} else {
					mode = 'none';
				}
			}
			if (mode === 'bashsty') {
				m = ls[i].match(BASHSTY_RE);
				if (m) {
					c = {};
					c.path = m[1];
					c.line = parseInt(m[2], 10);
					c.message = m[3];
					comments.push(c);
					continue;
				} else {
					mode = 'none';
				}
			}
			if (ls[i].match(/^([^ ]+\/)?jsl /)) {
				mode = 'jsl';
			} else if (ls[i].match(/^([^ ]+\/)?jsstyle /)) {
				mode = 'jsstyle';
			} else if (ls[i].match(/^([^ ]+\/)?eslint /)) {
				mode = 'eslint';
			} else if (ls[i].match(/^([^ ]+\/)?bashstyle /)) {
				mode = 'bashsty';
			}
		}

		review.comments = {};
		comments.forEach(function (comment) {
			if (review.comments[comment.path] === undefined)
				review.comments[comment.path] = [];
			review.comments[comment.path].push(comment);
		});

		if (comments.length < 1) {
			var start = this.sc_out.length - 50;
			if (start < 0)
				start = 0;
			var lines = this.sc_out.slice(start,
			    this.sc_out.length);
			lines = lines.map(function (v) { return (' ' + v); });
			review.message += '\n\n' + lines.join('\n');
		}
	}
	review.project = this.sc_change.project;
	var spec = this.sc_change.number + ',' + this.sc_patchset.number;
	gerrit.review(spec, review, S.callback(function (err) {
		if (err) {
			self.sc_log.error({ err: err },
			    'failed to post review (report)');
			/*
			 * If we hit
			 * <https://bugs.chromium.org/p/gerrit/issues/detail?id=3475>
			 * then fallback to a dumber report that doesn't try
			 * to match 'make check' output to patchset files.
			 * See arekinath/gerritbot#1.
			 */
			var marker = 'not found in revision';
			if (err.message.search(marker) !== -1) {
				S.gotoState('running.reportfallback');
				return;
			}
		}
		S.gotoState('closing');
	}));
};

SlaveConnection.prototype.state_running.reportfallback = function (S) {
	mod_assert.ok(this.sc_status !== 0,
	    'this impl assumes the "make check" failed');

	var self = this;
	var review = {};
	review.labels = {};
	review.message = '"make check" exited with status ' + this.sc_status;
	review.labels['CI-Testing'] = '-1';

	var start = this.sc_out.length - 50;
	if (start < 0)
		start = 0;
	var lines = this.sc_out.slice(start,
	    this.sc_out.length);
	lines = lines.map(function (v) { return (' ' + v); });
	review.message += '\n\n' + lines.join('\n');

	review.project = this.sc_change.project;
	var spec = this.sc_change.number + ',' + this.sc_patchset.number;
	gerrit.review(spec, review, S.callback(function (err) {
		if (err) {
			self.sc_log.error({ err: err },
			    'failed to post review (reportfallback)');
		}
		S.gotoState('closing');
	}));
};

SlaveConnection.prototype.state_closing = function (S) {
	var self = this;
	try {
		this.sc_ws.send(JSON.stringify({ op: 'exit' }));
	} catch (e) {
		this.sc_log.warn({ err: e }, 'failed to send exit message');
	}
	this.sc_ws.close();
	var idx = slaves.indexOf(this);
	mod_assert.notStrictEqual(idx, -1);
	slaves.splice(idx, 1);
	if (this.sc_uuid !== undefined) {
		docker.del('/containers/' + this.sc_uuid + '?force=1',
		    function (err) {
			if (err) {
				self.sc_log.error(err, 'failed to destroy');
			}
		});
	}
	S.gotoState('closed');
};

SlaveConnection.prototype.state_closed = function () {
};

function RemoteReadable() {
	mod_stream.Readable.call(this, {});
}
mod_util.inherits(RemoteReadable, mod_stream.Readable);
RemoteReadable.prototype._read = function (_size) {
};

SlaveConnection.prototype.handleMessage = function (msg) {
	mod_assert.string(msg.cookie, 'msg.cookie');
	var emitter = this.sc_kids[msg.cookie];
	mod_assert.object(emitter, 'emitter for ' + msg.cookie);
	var stream;

	if (msg.event === 'data') {
		stream = emitter[msg.stream];
		msg.data.forEach(function (d) {
			stream.push(new Buffer(d, 'base64'));
		});
	} else if (msg.event === 'end') {
		stream = emitter[msg.stream];
		stream.push(null);
	} else if (msg.event === 'spawn') {
		emitter.emit('spawn', msg.pid);
		emitter.pid = msg.pid;
	} else if (msg.event === 'close') {
		emitter.emit('close', msg.exitStatus);
	} else if (msg.event === 'done') {
		emitter.emit('done');
	} else if (msg.event === 'error') {
		var err = new Error(msg.error);
		err.stack = msg.stack;
		err.code = msg.code;
		if (msg.stream)
			emitter[msg.stream].emit('error', err);
		else
			emitter.emit('error', err);
	} else {
		throw (new Error('Unknown event type ' + msg.event));
	}
	this.sc_lastMsg.push(msg);
	if (this.sc_lastMsg.length > 8)
		this.sc_lastMsg.shift();
};

SlaveConnection.prototype.spawn = function (cmd, args, opts) {
	var self = this;
	mod_assert.string(cmd, 'command');
	mod_assert.arrayOfString(args, 'arguments');
	mod_assert.optionalObject(opts, 'options');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'spawn';
	req.cmd = cmd;
	req.args = args;
	req.opts = opts || {};

	var emitter = new mod_events.EventEmitter();
	emitter.stdout = new RemoteReadable();
	emitter.stderr = new RemoteReadable();

	this.sc_kids[cookie] = emitter;

	var ended = 0;
	function onEnd() {
		if (++ended >= 3)
			delete (self.sc_kids[cookie]);
	}
	emitter.on('close', onEnd);
	emitter.stdout.on('end', onEnd);
	emitter.stderr.on('end', onEnd);

	this.sc_ws.send(JSON.stringify(req));

	return (emitter);
};

SlaveConnection.prototype.streamFile = function (path) {
	var self = this;
	mod_assert.string(path, 'path');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'streamfile';
	req.path = path;

	var emitter = new mod_events.EventEmitter();
	emitter.stream = new RemoteReadable();

	this.sc_kids[cookie] = emitter;

	emitter.on('error', function () {
		delete (self.sc_kids[cookie]);
	});
	emitter.stream.on('end', function () {
		delete (self.sc_kids[cookie]);
	});

	this.sc_ws.send(JSON.stringify(req));

	return (emitter);
};

SlaveConnection.prototype.chdir = function (dir) {
	var self = this;
	mod_assert.string(dir, 'dir');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'chdir';
	req.dir = dir;

	var emitter = new mod_events.EventEmitter();
	this.sc_kids[cookie] = emitter;

	emitter.on('done', function () {
		delete (self.sc_kids[cookie]);
	});
	emitter.on('error', function () {
		delete (self.sc_kids[cookie]);
	});

	this.sc_ws.send(JSON.stringify(req));

	return (emitter);
};

SlaveConnection.prototype.addPath = function (post, pre) {
	var self = this;
	mod_assert.arrayOfString(post, 'post');
	mod_assert.optionalArrayOfString(pre, 'pre');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'addpath';
	req.pre = pre;
	req.post = post;

	var emitter = new mod_events.EventEmitter();
	this.sc_kids[cookie] = emitter;

	emitter.on('done', function () {
		delete (self.sc_kids[cookie]);
	});
	emitter.on('error', function () {
		delete (self.sc_kids[cookie]);
	});

	this.sc_ws.send(JSON.stringify(req));

	return (emitter);
};

for (var i = 0; i < config.spares; ++i)
	spawnWorker();

var evs = gerrit.eventStream();
evs.on('bootstrap', function () {
	var q = 'status:open AND NOT label:CI-Testing>=-1';
	var incl = ['patch-sets'];
	var qstream = gerrit.queryStream(q, incl);
	qstream.on('readable', function () {
		var change;
		while ((change = qstream.read()) !== null) {
			if (change.project === undefined ||
			    change.id === undefined) {
				continue;
			}
			var ps = change.patchSets[change.patchSets.length - 1];
			if (ps.isDraft === false)
				handleNewPatchset(change, ps);
		}
	});
});
evs.stream.on('readable', function () {
	var event;
	while ((event = evs.stream.read()) !== null) {
		if (event.type === 'patchset-created' &&
		    event.patchSet.kind !== 'NO_CHANGE' &&
		    event.patchSet.kind !== 'NO_CODE_CHANGE' &&
		    event.patchSet.isDraft === false) {
			handleNewPatchset(event.change, event.patchSet);
		}
	}
});

var queue = [];
function handleNewPatchset(change, ps) {
	if (repoHasMakeCheck[change.project] === false)
		return;
	log.info('queued %s %d (#%d)',
	    change.project, change.number, ps.number);
	queue.push([change, ps]);
	runQueue();
}

function runQueue() {
	var spares = slaves.filter(function (s) {
		return (s.getState() === 'ready');
	});
	var settingUp = slaves.filter(function (s) {
		var st = s.getState();
		return (st.indexOf('setup') !== -1 ||
		    st === 'auth' || st === 'idle');
	});

	var countSpawning = Object.keys(spawning).length;
	var countNotBusy = spares.length + settingUp.length + countSpawning;
	var toMake = config.spares - countNotBusy;
	if (slaves.length + countSpawning + toMake > config.max)
		toMake = config.max - (slaves.length + countSpawning);
	if (toMake > 0) {
		log.info('to make: %d - spares: %d, settingUp: %d, ' +
		    'spawning: %d (total %d)',
		    toMake, spares.length, settingUp.length, countSpawning,
		    slaves.length + countSpawning);
	}

	for (var j = 0; j < toMake; ++j)
		spawnWorker();

	while (spares.length > 0 && queue.length > 0) {
		var slave = spares.shift();
		var item = queue.shift();
		if (repoHasMakeCheck[item[0].project] === false)
			continue;
		slave.build.apply(slave, item);
	}
}

setInterval(runQueue, 5000);
