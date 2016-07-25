/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_gw = require('./lib/gerrit-watcher');
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
const mod_tls = require('tls');
const mod_cproc = require('child_process');
const mod_lstream = require('lstream');
const mod_vsjson = require('vstream-json-parser');
const mod_events = require('events');

var config = JSON.parse(
    mod_fs.readFileSync('etc/config.json').toString('utf-8'));

mod_assert.object(config, 'config');
mod_assert.optionalNumber(config.port, 'config.port');
if (config.port === undefined)
	config.port = 8080;

var log = mod_bunyan.createLogger({ name: 'gerritbot' });

var dockerKeyPem = mod_fs.readFileSync(config.docker.keyFile);
var dockerKey = mod_sshpk.parsePrivateKey(dockerKeyPem);
var id = mod_sshpk.identityFromDN('CN=' + config.docker.user);
var cert = mod_sshpk.createSelfSignedCertificate(id, dockerKey);

var dockerClients = config.docker.hosts.map(function (host) {
	return (mod_restify.createJsonClient({
		url: 'https://' + host + ':2376',
		rejectUnauthorized: false,
		key: dockerKeyPem,
		cert: cert.toBuffer('pem')
	}));
});
function docker() {
	var rand = mod_crypto.randomBytes(4).readUInt32BE(0);
	var idx = rand % dockerClients.length;
	return (dockerClients[idx]);
}

const COOKIE = mod_crypto.randomBytes(8).toString('base64');

var spawning = 0;

function spawnWorker() {
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
			'export PATH=/opt/local/bin:/opt/local/sbin:$PATH; pkgin -y up && pkgin -y in nodejs && curl -L https://github.com/arekinath/gerritbot/archive/master.tar.gz | gtar -zxvf - && cd gerritbot-master && npm install ws && node ./agent.js ' + config.my_name + ' ' + config.port + ' ' + COOKIE
		],
		Entrypoint: [],
		Image: config.slaves.image,
		Labels: { 'buildbot.worker': 'true' },
		Volumes: {},
		WorkingDir: '',
		NetworkDisabled: false,
		ExposedPorts: {},
		StopSignal: 'SIGTERM',
		HostConfig: {
			Binds: [],
			Links: [],
			LxcConf: {'lxc.utsname': 'docker'},
			Memory: 2048*1024*1024,
			Dns: ['8.8.8.8', '8.8.4.4']
		}
	};
	var client = docker();
	++spawning;
	client.post('/containers/create', payload,
	    function (err, req, res, obj) {
		if (err) {
			--spawning;
			log.error(err, 'spawning docker container');
		} else {
			var cid = obj.Id.slice(0, 12);
			log.info('created docker container %s', cid);
			client.post('/containers/' + cid + '/start',
			    function (err2) {
				if (err2) {
					--spawning;
					log.error(err2,
					    'starting docker container %s',
					    cid);
				} else {
					log.info('started docker container %s',
					    cid);
				}
			});
		}
	})
}

var slaves = [];
var server = new mod_ws.Server({ port: config.port });

server.on('connection', function onConnection(ws) {
	var conn = new SlaveConnection({
		config: config,
		log: log
	});
	conn.accept(ws);
	runQueue();
});

function SlaveConnection(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.config, 'options.config');
	mod_assert.optionalObject(opts.log, 'options.log');
	this.sc_log = opts.log;
	this.sc_ws = undefined;
	if (this.sc_log === undefined)
		this.sc_log = bunyan.createLogger({ name: 'connection '});
	this.sc_config = opts.config;
	this.sc_uuid = undefined;
	slaves.push(this);
	--spawning;
	mod_fsm.FSM.call(this, 'idle');
}
mod_util.inherits(SlaveConnection, mod_fsm.FSM);

SlaveConnection.prototype.accept = function (ws) {
	mod_assert.strictEqual(this.getState(), 'idle');
	this.sc_ws = ws;
	var req = this.sc_ws.upgradeReq;
	var sock = req.socket;
	this.sc_log = this.sc_log.child({
		client: { address: sock.remoteAddress, port: sock.remotePort },
		headers: req.headers
	});
	this.emit('acceptAsserted');
};

SlaveConnection.prototype.state_idle = function (on) {
	var self = this;
	on(this, 'acceptAsserted', function () {
		self.gotoState('auth');
	});
};

SlaveConnection.prototype.state_auth = function (on, once, timeout) {
	var self = this;
	timeout(5000, function () {
		self.gotoState('closing');
	});
	on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			self.gotoState('closing');
			return;
		}
		if (msg.cookie === COOKIE) {
			self.sc_log.info('authenticated slave %s', msg.uuid);
			self.sc_uuid = msg.uuid;
			self.gotoState('setup');
		} else {
			self.sc_log.warn('failed to auth slave, disconnecting');
			self.gotoState('closing');
		}
	});
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
};

SlaveConnection.prototype.state_setup = function (on) {
	var self = this;
	on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			self.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
	self.gotoState('setup.pkgsrc_fug');
};

SlaveConnection.prototype.state_setup.pkgsrc_fug = function (on) {
	var self = this;
	var kid = this.spawn('pfexec',
	    ['/opt/local/bin/pkgin', '-y', 'fug']);
	var errOut = '';
	on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			self.gotoState('setup.pkgsrc');
			return;
		}
		self.sc_log.error('failed to run pkgin fug in zone',
		    {stderr: errOut});
		self.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_setup.pkgsrc = function (on) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.sc_config.slaves.pkgsrc || []
	}, function (err) {
		if (err) {
			self.sc_log.error(err, 'failed to setup zone');
			self.gotoState('closing');
			return;
		}
		self.gotoState('setup.npm');
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
		on(kid.stderr, 'data', function (data) {
			errOut = errOut + data.toString('utf-8');
		});
		on(kid, 'close', function (exitStatus) {
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

SlaveConnection.prototype.state_setup.npm = function (on) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.sc_config.slaves.npm || []
	}, function (err) {
		if (err) {
			self.sc_log.error(err, 'failed to setup zone');
			self.gotoState('closing');
			return;
		}
		self.gotoState('ready');
	});
	function processPkgsrc(instr, cb) {
		var cmd = 'pfexec';
		var args = ['/opt/local/bin/npm', 'install', '-g', instr];
		var kid = self.spawn(cmd, args);
		var errOut = '';
		on(kid.stderr, 'data', function (data) {
			errOut = errOut + data.toString('utf-8');
		});
		on(kid, 'close', function (exitStatus) {
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

SlaveConnection.prototype.state_ready = function (on) {
	var self = this;
	this.sc_log.info('ready');
	on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			self.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
};

function RemoteReadable() {
	mod_stream.Readable.call(this, {});
}
mod_util.inherits(RemoteReadable, mod_stream.Readable);
RemoteReadable.prototype._read = function (size) {
};

SlaveConnection.prototype.handleMessage = function (msg) {
	mod_assert.string(msg.cookie, 'msg.cookie');
	var emitter = this.sc_kids[msg.cookie];
	mod_assert.object(emitter, 'emitter for ' + msg.cookie);
	if (msg.event === 'data') {
		var stream = emitter[msg.stream];
		msg.data.forEach(function (d) {
			stream.push(new Buffer(d, 'base64'));
		});
	} else if (msg.event === 'spawn') {
		emitter.emit('spawn', msg.pid);
		emitter.pid = msg.pid;
	} else if (msg.event === 'close') {
		emitter.emit('close', msg.exitStatus);
	}
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

	this.sc_ws.send(JSON.stringify(req));

	return (emitter);
};

SlaveConnection.prototype.state_ready = function (on) {
	on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			self.gotoState('closing');
			return;
		}
		self.emit('message', msg);
	});
	on(this, 'claimAsserted', function () {
		self.gotoState('running');
	});
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
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

SlaveConnection.prototype.state_running = function (on) {
	this.sc_log.info('building %s #%d (ps %d)', this.sc_change.project,
	    this.sc_change.number, this.sc_patchset.number);
	on(this.sc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.sc_log.error(e,
			    'failed to parse incoming message');
			self.gotoState('closing');
			return;
		}
		self.emit('message', msg);
	});
	on(this, 'releaseAsserted', function () {
		self.gotoState('closing');
	});
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
	self.gotoState('running.checkout');
};

SlaveConnection.prototype.state_running.checkout = function (on) {
	var self = this;
	var kid = this.spawn('git',
	    ['clone',
	    'https://' + config.gerrit.host + '/' + this.sc_change.project,
	    'repo']);
	var errOut = '';
	on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			self.gotoState('running.chdir');
			return;
		}
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		self.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_running.chdir = function (on) {
	var self = this;
	var emitter = this.chdir('repo');
	on(emitter, 'done', function () {
		self.gotoState('running.makecheck');
	});
	on(emitter, 'error', function () {
		self.sc_log.error('failed to run command in zone',
		    {stderr: errOut});
		self.gotoState('closing');
		return;
	});
};

SlaveConnection.prototype.state_running.makecheck = function (on) {
	var self = this;
	var kid = this.spawn('gmake', ['check']);
	var errOut = '';
	var out = '';
	on(kid.stderr, 'data', function (data) {
		errOut += data.toString('utf-8');
	});
	on(kid.stdout, 'data', function (data) {
		out += data.toString('utf-8');
	});
	on(kid, 'close', function (exitStatus) {
		this.sc_out = out.split('\n');
		this.sc_err = errOut.split('\n');
		this.sc_status = exitStatus;
		log.error({status: exitStatus, stdout: out, stderr: errOut},
		    'make check done');
		self.gotoState('running.report');
	});
};

SlaveConnection.prototype.state_running.report = function (on) {
	self.gotoState('closing');
};

SlaveConnection.prototype.state_closing = function () {
	try {
		this.sc_ws.send(JSON.stringify({ op: 'exit' }));
	} catch (e) {
	}
	this.sc_ws.close();
	var idx = slaves.indexOf(this);
	mod_assert.notStrictEqual(idx, -1);
	slaves.splice(idx, 1);
	this.gotoState('closed');
};

SlaveConnection.prototype.state_closed = function () {
};

for (var i = 0; i < config.spares; ++i)
	spawnWorker();

config.gerrit.log = log;
var watcher = new mod_gw.GerritWatcher(config.gerrit);
var evs = watcher.eventStream();
evs.on('readable', function () {
	var event;
	while ((event = evs.read()) !== null) {
		if (event.type === 'patchset-created' &&
		    event.patchSet.kind === 'REWORK' &&
		    event.patchSet.isDraft === false) {
			handleNewPatchset(event.change, event.patchSet);
		}
	}
});

var kid = mod_cproc.spawn('ssh', ['-v', '-i', config.gerrit.keyFile,
    '-p', config.gerrit.port, config.gerrit.user + '@' + config.gerrit.host,
    'gerrit', 'query', '--format=JSON', '--patch-sets',
    'status:open', 'AND', 'NOT', 'label:CI-Testing>=-1']);

var outls = new mod_lstream();
var vsjson = new mod_vsjson();

kid.stdout.pipe(outls);
outls.pipe(vsjson);

vsjson.on('readable', function () {
	var change;
	while ((change = vsjson.read()) !== null) {
		if (change.project === undefined || change.id === undefined)
			continue;
		var ps = change.patchSets[change.patchSets.length - 1];
		if (ps.isDraft === false)
			handleNewPatchset(change, ps);
	}
});

var queue = [];
function handleNewPatchset(change, ps) {
	log.info('queued %s %d (#%d)',
	    change.project, change.number, ps.number);
	queue.push([change, ps]);
	runQueue();
}

function runQueue() {
	var spares = slaves.filter(function (s) {
		return (s.getState() === 'ready');
	});
	while (spares.length + spawning < config.spares)
		spawnWorker();
	while (spares.length > 0 && queue.length > 0) {
		var slave = spares.shift();
		var item = queue.shift();
		slave.build.apply(slave, item);
	}
}

