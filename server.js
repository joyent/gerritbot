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

var config = JSON.parse(
    mod_fs.readFileSync('etc/config.json').toString('utf-8'));

mod_assert.object(config, 'config');
mod_assert.optionalNumber(config.port, 'config.port');
if (config.port === undefined)
	config.port = 8080;

var log = mod_bunyan.createLogger({ name: 'gerritbot' });

var dockerKeyPem = mod_fs.readFileSync(config.docker.keyFile);
var dockerKey = mod_sshpk.parsePrivateKey(dockerKeyPem);
var id = mod_sshpk.Identity.forUser(config.docker.user);
var cert = mod_sshpk.Certificate.createSelfSigned(id, dockerKey);

var context = mod_tls.createSecureContext({
	key: dockerKeyPem,
	cert: cert.toBuffer('pem')
});
var dockerClients = config.docker.hosts.map(function (host) {
	return (mod_restify.createJsonClient({
		url: 'https://' + host + ':2376',
		secureContext: context,
		rejectUnauthorized: false
	}));
});
function docker() {
	var rand = mod_crypto.randomBytes(4).readUInt32BE(0);
	var idx = rand % dockerClients.length;
	return (dockerClients[idx]);
}

var slaves = [];
var server = new mod_ws.Server({ port: config.port });

const COOKIE = mod_crypto.randomBytes(8).toString('base64');

server.on('connection', function onConnection(ws) {
	var conn = new SlaveConnection({
		config: config,
		log: log
	});
	conn.accept(ws);
});

function SlaveConnection(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.object(opts.config, 'options.config');
	mod_assert.optionalObject(opts.log, 'options.log');
	this.sc_log = opts.log;
	this.sc_ws = undefined;
	if (this.sc_log === undefined)
		this.sc_log = bunyan.createLogger({ name: 'connection '});
	var req = this.sc_ws.upgradeReq;
	var sock = req.socket;
	this.sc_log = this.sc_log.child({
		client: { address: sock.remoteAddress, port: sock.remotePort },
		headers: req.headers
	});
	this.sc_config = opts.config;
	this.sc_uuid = undefined;
	slaves.push(this);
	mod_fsm.FSM.call(this, 'idle');
}
mod_util.inherits(SlaveConnection, mod_fsm.FSM);

SlaveConnection.prototype.accept = function (ws) {
	mod_assert.strictEqual(this.getState(), 'idle');
	this.sc_ws = ws;
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
			self.sc_log.debug('authenticated slave %s', msg.uuid);
			self.sc_uuid = msg.uuid;
			self.gotoState('setup');
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
	self.gotoState('setup.pkgsrc_up');
};

SlaveConnection.prototype.state_setup.pkgsrc_up = function (on) {
	var self = this;
	var kid = this.spawn('pfexec',
	    ['/opt/local/bin/pkgin', '-fy', 'up']);
	var errOut = '';
	on(kid.stderr, 'data', function (data) {
		errOut = errOut + data.toString('utf-8');
	});
	on(kid, 'close', function (exitStatus) {
		if (exitStatus === 0) {
			self.gotoState('setup.pkgsrc_fug');
			return;
		}
		self.sc_log.error('failed to run pkgin up in zone',
		    {stderr: errOut});
		self.gotoState('closing');
		return;
	});
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
	on(this.sc_ws, 'close', function () {
		self.gotoState('closing');
	});
};

SlaveConnection.prototype.state_closing = function () {
	this.sc_ws.close();
	var idx = slaves.indexOf(this);
	mod_assert.notStrictEqual(idx, -1);
	slaves.splice(idx, 1);
	this.gotoState('closed');
};

SlaveConnection.prototype.state_closed = function () {
};
