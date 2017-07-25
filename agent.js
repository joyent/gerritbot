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
process.env.PWD = '/tmp';
process.env.PATH =
    '/opt/local/sbin:/opt/local/bin:/usr/gnu/bin:/usr/bin:/usr/sbin:/bin:/sbin';
process.env.LANG = 'C';
process.env.LC_ALL = 'C';
process.env.TERM = 'vt100';

var UUID = mod_cp.spawnSync('zonename').stdout.toString('ascii').trim();

var retries = 3;
var timeout = 5000;
var delay = 5000;

function connect() {
	var client;

	var timer = setTimeout(function () {
		timer = undefined;
		client.close();
		client.terminate();
		onClose();
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
	client.on('message', onMessage.bind(null, client));
	client.on('error', onError);
	client.on('close', onClose);
	function onClose() {
		if (timer === undefined)
			clearTimeout(timer);
		client.removeListener('message', onMessage);
		client.removeListener('error', onError);
		client.removeListener('close', onClose);
		if (--retries > 0) {
			setTimeout(connect, delay);
			delay *= 2;
		} else {
			process.exit(1);
		}
	}
	function onError(err) {
		console.error(err.stack);
		client.terminate();
		onClose();
	}
}

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

connect();
