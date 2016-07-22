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

var SERVER = process.argv[1];
var PORT = parseInt(process.argv[2], 10);
var COOKIE = process.argv[3];

var UUID = mod_cp.spawnSync('zonename').stdout.toString('ascii').strip();

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
	client.on('close', function onClose() {
		clearTimeout(timer);
		if (--retries > 0) {
			setTimeout(function () {
				connect();
			}, delay);
			delay *= 2;
		} else {
			process.exit(1);
		}
	});
}

function onMessage(msg) {
	msg = JSON.parse(msg);
	var cookie = msg.cookie;
	if (msg.op === 'spawn') {
		var kid = mod_cp.spawn(msg.cmd, msg.args, msg.opts);
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
		kid.on('close', function (status) {
			client.send(JSON.stringify({
				cookie: cookie,
				event: 'close',
				exitStatus: status
			}));
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
