/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

const Buffer = require('safer-buffer').Buffer;
const mod_assert = require('assert-plus');
const mod_bunyan = require('bunyan');
const mod_crypto = require('crypto');
const mod_events = require('events');
const mod_fsm = require('mooremachine');
const mod_stream = require('stream');
const mod_util = require('util');
const mod_vasync = require('vasync');

function assertWorkerOptions(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.config, 'options.config');
	mod_assert.object(opts.docker, 'options.docker');
	mod_assert.object(opts.gerrit, 'options.gerrit');
	mod_assert.object(opts.supervisor, 'options.supervisor');
	mod_assert.string(opts.cookie, 'options.cookie');
	mod_assert.optionalObject(opts.log, 'options.log');
}

function WorkerConnection(opts) {
	assertWorkerOptions(opts);

	this.wc_gerrit = opts.gerrit;
	this.wc_docker = opts.docker;
	this.wc_sup = opts.supervisor;

	this.wc_cookie = opts.cookie;

	this.wc_log = opts.log;

	this.wc_ws = undefined;
	if (this.wc_log === undefined)
		this.wc_log = mod_bunyan.createLogger({ name: 'connection '});
	this.wc_config = opts.config;
	this.wc_uuid = undefined;
	this.wc_kids = {};
	this.wc_lastMsg = [];

	mod_fsm.FSM.call(this, 'idle');
}
mod_util.inherits(WorkerConnection, mod_fsm.FSM);

WorkerConnection.prototype.accept = function (ws) {
	mod_assert.strictEqual(this.getState(), 'idle');
	this.wc_ws = ws;
	var req = this.wc_ws.upgradeReq;
	var sock = req.socket;
	this.wc_log = this.wc_log.child({
		client: sock.remoteAddress + ':' + sock.remotePort
	});
	this.emit('acceptAsserted');
};

WorkerConnection.prototype.state_idle = function (S) {
	S.on(this, 'acceptAsserted', function () {
		S.gotoState('auth');
	});
};

WorkerConnection.prototype.state_auth = function (S) {
	var self = this;
	var others = self.wc_sup.ss_workers.filter(function (wc) {
		return (!(wc.isInState('closed') || wc.isInState('closing')) &&
		    wc.wc_uuid === self.wc_uuid && wc !== self);
	});
	if (others.length > 0) {
		self.wc_log.error('duplicate client');
		S.gotoState('closing');
		return;
	}

	S.on(this.wc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.wc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		var keys = Object.keys(msg).sort();
		if (msg.cookie === self.wc_cookie && keys.length === 2 &&
		    keys[0] === 'cookie' && keys[1] === 'uuid') {
			self.wc_uuid = msg.uuid.replace(/-/g, '');
			var cid = self.wc_uuid.slice(0, 12);
			self.wc_sup.delSpawnStatus(cid);
			self.wc_log = self.wc_log.child({ cid: cid });
			self.wc_log.info('authenticated agent on %s', cid);
			S.gotoState('setup');
		} else {
			self.wc_log.warn('failed to auth worker, disconnecting');
			S.gotoState('closing');
		}
	});

	S.gotoStateTimeout(5000, 'closing');
	S.gotoStateOn(self.wc_ws, 'close', 'closing');
};

WorkerConnection.prototype.state_setup = function (S) {
	var self = this;
	S.on(this.wc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.wc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this.wc_ws, 'close', function () {
		S.gotoState('closing');
	});
	S.gotoState('setup.pkgsrc');
};

WorkerConnection.prototype.state_setup.pkgsrc = function (S) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.wc_config.workers.pkgsrc || []
	}, function (err) {
		if (err) {
			self.wc_log.error(err, 'failed to setup zone');
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
			self.wc_log.error('failed to run pkgin cmd in zone',
			    {args: args, stderr: errOut});
			cb(new Error('pkgin command failed'));
		});
	}
};

WorkerConnection.prototype.state_setup.npm = function (S) {
	var self = this;
	mod_vasync.forEachPipeline({
		func: processPkgsrc,
		inputs: this.wc_config.workers.npm || []
	}, function (err) {
		if (err) {
			self.wc_log.error(err, 'failed to setup zone');
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
			self.wc_log.error('failed to run npm cmd in zone',
			    {args: args, stderr: errOut});
			cb(new Error('npm command failed'));
		});
	}
};

WorkerConnection.prototype.state_setup.clean_old = function (S) {
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
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_setup.jsl_clone = function (S) {
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
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_setup.jsl_chdir = function (S) {
	var self = this;
	var emitter = this.chdir('/home/build/javascriptlint');
	S.on(emitter, 'done', function () {
		S.gotoState('setup.jsl_build');
	});
	S.on(emitter, 'error', function (err) {
		self.wc_log.error(err, 'failed to chdir');
		S.gotoState('closing');
	});
};

WorkerConnection.prototype.state_setup.jsl_build = function (S) {
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
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_setup.jsstyle_clone = function (S) {
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
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_setup.lintpaths = function (S) {
	var self = this;
	var emitter = this.addPath([
	    '/home/build/javascriptlint/build/install',
	    '/home/build/jsstyle'
	]);
	S.on(emitter, 'done', function () {
		S.gotoState('ready');
	});
	S.on(emitter, 'error', function (err) {
		self.wc_log.error(err, 'failed to add paths');
		S.gotoState('closing');
	});
};

WorkerConnection.prototype.state_ready = function (S) {
	var self = this;

	S.on(this.wc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.wc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this, 'claimAsserted', function () {
		S.gotoState('running');
	});
	S.on(this, 'releaseAsserted', function () {
		S.gotoState('closing');
	});
	S.on(this.wc_ws, 'close', function () {
		S.gotoState('closing');
	});

	self.wc_log.info('ready to rock');
	self.emit('ready');
};

WorkerConnection.prototype.build = function (change, patchset) {
	mod_assert.strictEqual(this.getState(), 'ready');
	this.wc_change = change;
	this.wc_patchset = patchset;
	this.emit('claimAsserted');
};

WorkerConnection.prototype.release = function () {
	mod_assert.strictEqual(this.getState(), 'running');
	this.emit('releaseAsserted');
};

WorkerConnection.prototype.state_running = function (S) {
	var self = this;
	this.wc_log.info('building %s #%d (ps %d)', this.wc_change.project,
	    this.wc_change.number, this.wc_patchset.number);
	S.on(this.wc_ws, 'message', function onMessage(msg) {
		try {
			msg = JSON.parse(msg);
		} catch (e) {
			self.wc_log.error(e,
			    'failed to parse incoming message');
			S.gotoState('closing');
			return;
		}
		self.handleMessage(msg);
	});
	S.on(this, 'releaseAsserted', function () {
		S.gotoState('closing');
	});
	S.on(this.wc_ws, 'close', function () {
		S.gotoState('closing');
	});
	S.gotoState('running.clone');
};

WorkerConnection.prototype.state_running.clone = function (S) {
	var self = this;
	var host = self.wc_config.gerrit.host;
	var url = 'https://' + host + '/' + self.wc_change.project;
	var kid = self.spawn('git', ['clone', url, '/tmp/repo']);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('running.chdir');
			return;
		}
		self.wc_log.error({ stderr: errOut },
		    'failed to run command in zone');
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_running.chdir = function (S) {
	var self = this;
	var emitter = this.chdir('/tmp/repo');
	S.on(emitter, 'done', function () {
		S.gotoState('running.fetch');
	});
	S.on(emitter, 'error', function (err) {
		self.wc_log.error(err, 'failed to chdir');
		S.gotoState('closing');
	});
};

WorkerConnection.prototype.state_running.fetch = function (S) {
	var self = this;
	var kid = this.spawn('git',
	    ['fetch', 'origin', this.wc_patchset.ref]);
	var errOut = '';
	S.on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	S.on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			S.gotoState('running.checkout');
			return;
		}
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_running.checkout = function (S) {
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
		self.wc_log.error('failed to run command in zone',
		    {stderr: errOut});
		S.gotoState('closing');
		return;
	});
};

WorkerConnection.prototype.state_running.findmake = function (S) {
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
		self.wc_sup.setInitialRepoStatus(self.wc_change.project, false);
		self.wc_log.warn({status: exitStatus, stderr: errOut},
		    'make check first run failed, skipping');
		S.gotoState('closing');
	});
};

WorkerConnection.prototype.state_running.makecheck = function (S) {
	var self = this;
	var kid = this.spawn('gmake', ['check']);
	S.on(kid, 'close', function (exitStatus) {
		self.wc_status = exitStatus;
		if (exitStatus === 0) {
			self.wc_sup.setInitialRepoStatus(self.wc_change.project, true);
		}
		self.wc_log.info({status: exitStatus},
		    'make check first run done');
		S.gotoState('running.makecheck2');
	});
};

WorkerConnection.prototype.state_running.makecheck2 = function (S) {
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
		self.wc_out = out.split('\n');
		self.wc_status = exitStatus;
		self.wc_log.info({status: exitStatus, output: self.wc_out},
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

WorkerConnection.prototype.state_running.report = function (S) {
	var self = this;
	var review = {};
	review.labels = {};
	if (this.wc_status === 0) {
		review.message = '"make check" passed ok';
		review.labels['CI-Testing'] = '+1';
	} else {
		review.message = '"make check" exited with status ' +
		    this.wc_status;
		review.labels['CI-Testing'] = '-1';

		var comments = [];
		var ls = this.wc_out;
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
			var start = this.wc_out.length - 50;
			if (start < 0)
				start = 0;
			var lines = this.wc_out.slice(start,
			    this.wc_out.length);
			lines = lines.map(function (v) { return (' ' + v); });
			review.message += '\n\n' + lines.join('\n');
		}
	}
	review.project = this.wc_change.project;
	var spec = this.wc_change.number + ',' + this.wc_patchset.number;

	if (this.wc_config.dryrun) {
		this.wc_log.info({ review: review },
		    'skipping posting review for %s; dryrun enabled', spec);
		S.gotoState('closing');
		return;
	}

	this.wc_gerrit.review(spec, review, S.callback(function (err) {
		if (err) {
			self.wc_log.error({ err: err },
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

WorkerConnection.prototype.state_running.reportfallback = function (S) {
	mod_assert.ok(this.wc_status !== 0,
	    'this impl assumes the "make check" failed');

	var self = this;
	var review = {};
	review.labels = {};
	review.message = '"make check" exited with status ' + this.wc_status;
	review.labels['CI-Testing'] = '-1';

	var start = this.wc_out.length - 50;
	if (start < 0)
		start = 0;
	var lines = this.wc_out.slice(start,
	    this.wc_out.length);
	lines = lines.map(function (v) { return (' ' + v); });
	review.message += '\n\n' + lines.join('\n');

	review.project = this.wc_change.project;
	var spec = this.wc_change.number + ',' + this.wc_patchset.number;
	this.wc_gerrit.review(spec, review, S.callback(function (err) {
		if (err) {
			self.wc_log.error({ err: err },
			    'failed to post review (reportfallback)');
		}
		S.gotoState('closing');
	}));
};

WorkerConnection.prototype.state_closing = function (S) {
	var self = this;
	try {
		this.wc_ws.send(JSON.stringify({ op: 'exit' }));
	} catch (e) {
		this.wc_log.warn({ err: e }, 'failed to send exit message');
	}
	this.wc_ws.close();
	if (this.wc_uuid !== undefined) {
		this.wc_docker.del('/containers/' + this.wc_uuid + '?force=1',
		    function (err) {
			if (err) {
				self.wc_log.error(err, 'failed to destroy');
			}
		});
	}
	S.gotoState('closed');
};

WorkerConnection.prototype.state_closed = function () {
	this.emit('closed');
};

function RemoteReadable() {
	mod_stream.Readable.call(this, {});
}
mod_util.inherits(RemoteReadable, mod_stream.Readable);
RemoteReadable.prototype._read = function (_size) {
};

WorkerConnection.prototype.handleMessage = function (msg) {
	mod_assert.string(msg.cookie, 'msg.cookie');
	var emitter = this.wc_kids[msg.cookie];
	mod_assert.object(emitter, 'emitter for ' + msg.cookie);
	var stream;

	if (msg.event === 'data') {
		stream = emitter[msg.stream];
		msg.data.forEach(function (d) {
			stream.push(Buffer.from(d, 'base64'));
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
	this.wc_lastMsg.push(msg);
	if (this.wc_lastMsg.length > 8)
		this.wc_lastMsg.shift();
};

WorkerConnection.prototype.spawn = function (cmd, args, opts) {
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

	this.wc_kids[cookie] = emitter;

	var ended = 0;
	function onEnd() {
		if (++ended >= 3)
			delete (self.wc_kids[cookie]);
	}
	emitter.on('close', onEnd);
	emitter.stdout.on('end', onEnd);
	emitter.stderr.on('end', onEnd);

	this.wc_ws.send(JSON.stringify(req));

	return (emitter);
};

WorkerConnection.prototype.streamFile = function (path) {
	var self = this;
	mod_assert.string(path, 'path');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'streamfile';
	req.path = path;

	var emitter = new mod_events.EventEmitter();
	emitter.stream = new RemoteReadable();

	this.wc_kids[cookie] = emitter;

	emitter.on('error', function () {
		delete (self.wc_kids[cookie]);
	});
	emitter.stream.on('end', function () {
		delete (self.wc_kids[cookie]);
	});

	this.wc_ws.send(JSON.stringify(req));

	return (emitter);
};

WorkerConnection.prototype.chdir = function (dir) {
	var self = this;
	mod_assert.string(dir, 'dir');

	var cookie = mod_crypto.randomBytes(9).toString('base64');
	var req = {};
	req.cookie = cookie;
	req.op = 'chdir';
	req.dir = dir;

	var emitter = new mod_events.EventEmitter();
	this.wc_kids[cookie] = emitter;

	emitter.on('done', function () {
		delete (self.wc_kids[cookie]);
	});
	emitter.on('error', function () {
		delete (self.wc_kids[cookie]);
	});

	this.wc_ws.send(JSON.stringify(req));

	return (emitter);
};

WorkerConnection.prototype.addPath = function (post, pre) {
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
	this.wc_kids[cookie] = emitter;

	emitter.on('done', function () {
		delete (self.wc_kids[cookie]);
	});
	emitter.on('error', function () {
		delete (self.wc_kids[cookie]);
	});

	this.wc_ws.send(JSON.stringify(req));

	return (emitter);
};


module.exports = {
	Connection: WorkerConnection
};
