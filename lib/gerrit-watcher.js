/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 *
 * Copyright (c) 2016, Joyent, Inc.
 */

module.exports = { GerritWatcher: GerritWatcher };

const mod_fsm = require('mooremachine');
const mod_cproc = require('child_process');
const mod_fs = require('fs');
const mod_util = require('util');
const mod_assert = require('assert-plus');
const mod_events = require('events');
const mod_stream = require('stream');
const mod_crypto = require('crypto');
const mod_verror = require('verror');
const mod_lstream = require('lstream');
const mod_vsjson = require('vstream-json-parser');
const mod_bunyan = require('bunyan');

function GerritWatcher(opts) {
	mod_assert.object(opts, 'options');
	mod_assert.string(opts.user, 'options.user');
	mod_assert.string(opts.host, 'options.host');
	mod_assert.string(opts.keyFile, 'options.keyFile');
	mod_assert.optionalNumber(opts.port, 'options.port');
	mod_assert.optionalObject(opts.log, 'options.log');
	this.gw_keyFile = opts.keyFile;
	this.gw_user = opts.user;
	if (opts.port === undefined)
		opts.port = 22;
	this.gw_port = opts.port;
	this.gw_host = opts.host;
	this.gw_tokill = [];
	this.gw_log = opts.log;
	if (opts.log === undefined)
		this.gw_log = bunyan.createLogger({ name: 'gerrit-watcher' });

	this.gw_kid = undefined;
	this.gw_errls = new mod_lstream();
	this.gw_outls = new mod_lstream();
	this.gw_vsjson = new mod_vsjson();
	this.gw_outls.pipe(this.gw_vsjson);

	var self = this;
	this.gw_outls.on('line', function (line) {
		self.gw_log.trace({ json: line }, 'got event');
	});

	mod_fsm.FSM.call(this, 'spawning');
}
mod_util.inherits(GerritWatcher, mod_fsm.FSM);

GerritWatcher.prototype.eventStream = function () {
	return (this.gw_vsjson);
};

const BAD_AUTH = /^Permission denied/;
const NEED_CAP = /^Capability ([^ ]+) is required/;
const CMD_START = /^debug1: Sending command: gerrit/;
const EXIT_STATUS = /^debug1: Exit status ([0-9-]+)/;

GerritWatcher.prototype.state_spawning = function (on) {
	var self = this;

	var opts = {};
	opts.env = {};
	opts.env.PATH = process.env.PATH;

	this.gw_kid = mod_cproc.spawn('ssh',
	    ['-v', '-i', this.gw_keyFile, '-p', this.gw_port,
	    '-o', 'ServerAliveInterval=10',
	    '-o', 'ServerAliveCountMax=1',
	    this.gw_user + '@' + this.gw_host,
	    'gerrit', 'stream-events'], opts);
	this.gw_log.info('spawned ssh for gerrit stream-events in pid %d',
	    this.gw_kid.pid);

	on(this.gw_kid, 'error', function (err) {
		self.gw_lastError = err;
		self.gotoState('error');
	});

	this.gw_kid.stderr.pipe(this.gw_errls);
	this.gw_kid.stdout.pipe(this.gw_outls);

	on(this.gw_errls, 'readable', function () {
		var line;
		while ((line = self.gw_errls.read()) !== null) {
			var m;
			if (line.match(BAD_AUTH)) {
				self.gw_lastError = new Error(
				    'Failed to authenticate to gerrit SSH');
				self.gotoState('error');
				return;
			} else if ((m = line.match(CMD_START))) {
				self.gotoState('running');
				return;
			}
		}
	});

	on(this.gw_kid, 'close', function (code) {
		self.gw_lastError = new Error('Exited with status ' + code);
		self.gotoState('error');
	});
};

GerritWatcher.prototype.state_running = function (on, once, timeout) {
	var self = this;
	on(this.gw_errls, 'readable', function () {
		var line;
		while ((line = self.gw_errls.read()) !== null) {
			var m;
			if ((m = line.match(NEED_CAP))) {
				self.gw_lastError = new mod_verror.VError(
				    'Gerrit refused access: the user "%s" ' +
				    'does not have capability "%s"',
				    self.gw_user, m[1]);
				self.gotoState('error');
				return;
			} else if ((m = line.match(EXIT_STATUS))) {
				self.gw_lastError = new mod_verror.VError(
				    'The remote command exited with status ' +
				    '%d unexpectedly', m[1]);
				self.gotoState('error');
				return;
			}
		}
	});
	on(this.gw_kid, 'close', function (code) {
		self.gw_log.warn('child process %d exited with status %d, ' +
		    'will respawn', self.gw_kid.pid, code);
		self.gotoState('spawning');
	});
	on(this, 'stopAsserted', function () {
		self.gotoState('stopping');
	});
	on(process, 'exit', function () {
		self.gotoState('stopping');
	});
};

GerritWatcher.prototype.stop = function () {
	mod_assert.strictEqual(this.getState(), 'running');
	this.emit('stopAsserted');
};

GerritWatcher.prototype.state_stopping = function (on) {
	var self = this;
	on(this.gw_kid, 'close', function (code) {
		self.gotoState('stopped');
	});
	mod_cproc.spawnSync('kill', [this.gw_kid.pid]);
};

GerritWatcher.prototype.state_stopped = function () {
	this.gw_kid = undefined;
};

GerritWatcher.prototype.state_error = function () {
	this.gw_kid = undefined;
	this.gw_log.error(this.gw_lastError, 'emitting error');
	this.emit('error', this.gw_lastError);
};
