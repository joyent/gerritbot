#!/usr/bin/env node
/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

const mod_ws = require('ws');
const mod_cp = require('child_process');

var SERVER = process.argv[2];
var PORT = parseInt(process.argv[3], 10);
var COOKIE = process.argv[4];

process.chdir('/tmp');
process.env.PATH =
    '/opt/local/sbin:/opt/local/bin:/usr/gnu/bin:/usr/bin:/usr/sbin:/bin:/sbin';

var UUID = mod_cp.spawnSync('zonename').stdout.toString('ascii').trim();

var client;
var retries = 3;
var timeout = 5000;
var delay = 5000;

function connect() {
	var timer = setTimeout(function () {
		timer = undefined;
		client.close();
	}, timeout);
	timeout *= 2;

	client = new mod_ws('ws://' + SERVER + ':' + PORT + '/');
	client.on('open', function onOpen() {
		clearTimeout(timer);
		client.send(JSON.stringify({
			cookie: COOKIE,
			uuid: UUID
		}));
	});
	client.on('message', onMessage);
	client.on('error', function (err) {
		console.error(err.stack);
		onClose();
	});
	client.on('close', onClose);
	function onClose() {
		clearTimeout(timer);
		if (--retries > 0) {
			setTimeout(function () {
				connect();
			}, delay);
			delay *= 2;
		} else {
			process.exit(1);
		}
	}
}

function onMessage(msg) {
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

connect();
