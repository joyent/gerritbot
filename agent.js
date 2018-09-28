#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_fs = require('fs');
const mod_ws = require('ws');
const mod_cp = require('child_process');
const mod_fsm = require('mooremachine');
const mod_util = require('util');

var SERVER = process.argv[2];
var PORT = parseInt(process.argv[3], 10);
var COOKIE = process.argv[4];

process.chdir('/tmp');
process.env.PWD = '/tmp';
process.env.PATH =
    '/opt/local/sbin:/opt/local/bin:/usr/gnu/bin:/usr/bin:/usr/sbin:/bin:/sbin';
process.env.LANG = 'C';
process.env.LC_ALL = 'C';
process.env.TERM = 'vt100';

var UUID = mod_cp.spawnSync('zonename').stdout.toString('ascii').trim();

function AgentFSM() {
	this.af_retries = 5;
	this.af_timeout = 5000;
	this.af_delay = 3000;
	this.af_lastError = undefined;
	this.af_client = undefined;
	mod_fsm.FSM.call(this, 'init');
}
mod_util.inherits(AgentFSM, mod_fsm.FSM);

AgentFSM.prototype.connect = function () {
	this.emit('connectAsserted');
};

AgentFSM.prototype.state_init = function (S) {
	S.on(this, 'connectAsserted', function () {
		S.gotoState('connecting');
	});
};

AgentFSM.prototype.state_connecting = function (S) {
	var self = this;

	this.af_client = new mod_ws('ws://' + SERVER + ':' + PORT + '/');

	S.on(this.af_client, 'open', function () {
		S.gotoState('connected');
	});
	S.on(this.af_client, 'error', function (err) {
		self.af_lastError = err;
		S.gotoState('error');
	});
	S.on(this.af_client, 'close', function () {
		self.af_lastError = new Error('"close" emitted before connect');
		S.gotoState('error');
	});
	S.timeout(this.af_timeout, function () {
		self.af_lastError = new Error('Connect timeout');
		S.gotoState('error');
	});
};

AgentFSM.prototype.state_error = function (S) {
	console.error(this.af_lastError.stack);

	if (--this.af_retries <= 0) {
		console.error('Ran out of retries, giving up');
		process.exit(1);
		return;
	}

	this.af_client.on('error', function () { });
	this.af_client.terminate();
	this.af_client = undefined;

	S.timeout(this.af_delay, function () {
		S.gotoState('connecting');
	});
	this.af_timeout *= 2;
};

AgentFSM.prototype.state_connected = function (S) {
	var self = this;

	S.on(this.af_client, 'message', function (msg) {
		onMessage(self.af_client, msg);
	});
	S.on(this.af_client, 'error', function (err) {
		self.af_lastError = err;
		S.gotoState('error');
	});
	S.on(this.af_client, 'close', function () {
		self.af_lastError = new Error('Websocket closed unexpectedly');
		S.gotoState('error');
	});
	this.af_client.send(JSON.stringify({
		cookie: COOKIE,
		uuid: UUID
	}));
};

function onMessage(client, msg) {
	msg = JSON.parse(msg);
	var cookie = msg.cookie;
	if (msg.op === 'spawn') {
		var kid = mod_cp.spawn(msg.cmd, msg.args, msg.opts);
		console.log('%s: spawning %s %j', cookie, msg.cmd, msg.args);
		client.send(JSON.stringify({
			cookie: cookie,
			event: 'spawn',
			pid: kid.pid
		}));
		kid.stdout.on('readable', function () {
			var data;
			var evt = {
				cookie: cookie,
				event: 'data',
				stream: 'stdout',
				data: []
			};
			while ((data = kid.stdout.read()) !== null) {
				evt.data.push(data.toString('base64'));
			}
			if (evt.data.length > 0)
				client.send(JSON.stringify(evt));
		});
		kid.stdout.on('end', function () {
			var evt = {
				cookie: cookie,
				event: 'end',
				stream: 'stdout'
			};
			client.send(JSON.stringify(evt));
		});
		kid.stderr.on('readable', function () {
			var data;
			var evt = {
				cookie: cookie,
				event: 'data',
				stream: 'stderr',
				data: []
			};
			while ((data = kid.stderr.read()) !== null) {
				evt.data.push(data.toString('base64'));
			}
			if (evt.data.length > 0)
				client.send(JSON.stringify(evt));
		});
		kid.stderr.on('end', function () {
			var evt = {
				cookie: cookie,
				event: 'end',
				stream: 'stderr'
			};
			client.send(JSON.stringify(evt));
		});
		kid.on('close', function (status) {
			console.log('%s: exit %d', cookie, status);
			client.send(JSON.stringify({
				cookie: cookie,
				event: 'close',
				exitStatus: status
			}));
		});
	} else if (msg.op === 'chdir') {
		console.log('%s: chdir %s', msg.dir);
		try {
			process.chdir(msg.dir);
			process.env.PWD = process.cwd();
			client.send(JSON.stringify({
				cookie: cookie,
				event: 'done'
			}));
		} catch (e) {
			client.send(JSON.stringify({
				cookie: cookie,
				event: 'error',
				error: e.toString(),
				stack: e.stack
			}));
		}
	} else if (msg.op === 'addpath') {
		console.log('%s: addpath pre %j post %j', msg.pre, msg.post);
		var paths = process.env.PATH.split(':');
		(msg.pre || []).forEach(function (p) {
			paths.unshift(p);
		});
		(msg.post || []).forEach(function (p) {
			paths.push(p);
		});
		process.env.PATH = paths.join(':');
		client.send(JSON.stringify({
			cookie: cookie,
			event: 'done'
		}));
	} else if (msg.op === 'streamfile') {
		console.log('%s: get %s', msg.path);
		var str = mod_fs.createReadStream(msg.path);
		str.on('readable', function () {
			var data;
			while ((data = str.read()) !== null) {
				var evt = {
					cookie: cookie,
					event: 'data',
					stream: 'stream',
					data: [data.toString('base64')]
				};
				client.send(JSON.stringify(evt));
			}
		});
		str.on('end', function () {
			var evt = {
				cookie: cookie,
				event: 'end',
				stream: 'stream'
			};
			client.send(JSON.stringify(evt));
		});
		str.on('error', function (e) {
			var evt = {
				cookie: cookie,
				event: 'error',
				stream: 'stream',
				error: e.toString(),
				stack: e.stack,
				code: e.code
			};
			client.send(JSON.stringify(evt));
		});
	} else if (msg.op === 'kill') {
		var res = mod_cp.spawnSync('kill', msg.args);
		client.send(JSON.stringify({
			cookie: cookie,
			event: 'killed',
			exitStatus: res.status,
			stdout: res.stdout.toString('base64'),
			stderr: res.stderr.toString('base64')
		}));
	} else if (msg.op === 'exit') {
		process.exit(0);
	}
}

var fsm = new AgentFSM();
fsm.connect();
