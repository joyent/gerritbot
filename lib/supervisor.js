/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

'use strict';

const mod_assert = require('assert-plus');
const mod_crypto = require('crypto');
const mod_fs = require('fs');
const mod_fsm = require('mooremachine');
const mod_http = require('http');
const mod_jade = require('jade');
const mod_jsprim = require('jsprim');
const mod_path = require('path');
const mod_qs = require('querystring');
const mod_util = require('util');
const mod_worker = require('./worker');
const mod_ws = require('ws');

const AGENT_JS = mod_path.join(__dirname, 'agent.js');

function workerIsReady(w) {
	return (w.isInState('ready'));
}

function workerIsSettingUp(w) {
	return (w.isInState('setup'));
}

function assertSupervisorOptions(opts) {
	mod_assert.object(opts, 'opts');
	mod_assert.object(opts.config, 'opts.config');
	mod_assert.object(opts.docker, 'opts.docker');
	mod_assert.object(opts.gerrit, 'opts.gerrit');
	mod_assert.string(opts.cookie, 'opts.cookie');
	mod_assert.object(opts.log, 'opts.log');
}

/*
 * The SupervisorServer is responsible for managing zone creation and deletion,
 * and delegating checking patchsets to running zones.
 */
function SupervisorServer(opts) {
	assertSupervisorOptions(opts);

	var self = this;

	self.ss_cookie = opts.cookie;

	self.ss_docker = opts.docker;
	self.ss_gerrit = opts.gerrit;

	self.ss_config = opts.config;
	self.ss_log = opts.log;

	self.ss_checkrepos = mod_jsprim.deepCopy(self.ss_config.repos.check);

	self.ss_spawning = {};
	self.ss_queue = [];
	self.ss_workers = [];

	self.ss_tplCache = {};

	self.ss_http = mod_http.createServer();
	self.ss_server = new mod_ws.Server({
		server: self.ss_http
	});

	self.ss_server.on('connection', self.handleNewConnection.bind(self));

	self.ss_http.on('request', self.handleHttpRequest.bind(self));
	self.ss_http.listen(self.ss_config.port);

	self.ss_evs = self.ss_gerrit.eventStream();
	self.ss_evs.on('bootstrap', self.bootstrap.bind(self));
	self.ss_evs.stream.on('readable', self.handleNewPatchsets.bind(self));

	mod_fsm.FSM.call(self, 'stopped');
}
mod_util.inherits(SupervisorServer, mod_fsm.FSM);

SupervisorServer.prototype.spawnWorker = function spawnWorker() {
	var self = this;

	var spawnCookie = mod_crypto.randomBytes(8).toString('base64');
	var agentUrl = mod_util.format('http://%s:%d/agent.js',
	    self.ss_config.my_name, self.ss_config.port);
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
			'npm install ws@6.2.1 mooremachine && ' +
			'/usr/lib/pfexecd && ' +
			'exec su - build -c "' +
				'exec node /tmp/agent.js ' + self.ss_config.my_name +
				' ' + self.ss_config.port + ' ' + self.ss_cookie +
			'"'
		],
		Entrypoint: [],
		Image: self.ss_config.workers.image,
		Labels: { 'buildbot.worker': 'true' },
		Volumes: {},
		WorkingDir: '/tmp',
		NetworkDisabled: false,
		NetworkMode: self.ss_config.docker.network,
		ExposedPorts: {},
		StopSignal: 'SIGTERM',
		HostConfig: {
			Binds: [],
			Links: [],
			LxcConf: {'lxc.utsname': 'docker'},
			Memory: self.ss_config.workers.memory * 1024 * 1024,
			Dns: ['8.8.8.8', '8.8.4.4']
		}
	};

	function postCreate(err, req, res, obj) {
		if (err) {
			self.delSpawnStatus(spawnCookie);
			self.ss_log.error(err, 'spawning docker container');
			return;
		}

		var cid = obj.Id.slice(0, 12);
		self.ss_log.info('created docker container %s', cid);
		self.setSpawnStatus(spawnCookie, 'booting');

		self.ss_docker.post('/containers/' + cid + '/start', {},
		    function (err2) {
			if (err2) {
				self.delSpawnStatus(spawnCookie);
				self.ss_log.error(err2,
				    'starting docker container %s', cid);
				return;
			}

			self.delSpawnStatus(spawnCookie);
			self.setSpawnStatus(cid, 'booting');
			self.ss_log.info('started docker container %s', cid);
		});
	}

	self.setSpawnStatus(spawnCookie, 'provisioning');
	self.ss_docker.post('/containers/create', payload, postCreate);
};

SupervisorServer.prototype.runQuery = function runQuery(q) {
	var self = this;

	var incl = ['patch-sets'];
	var qstream = self.ss_gerrit.queryStream(q, incl);
	qstream.on('readable', function () {
		var change;
		while ((change = qstream.read()) !== null) {
			if (change.project === undefined ||
			    change.id === undefined) {
				continue;
			}
			var ps = change.patchSets[change.patchSets.length - 1];
			if (ps.isDraft === false)
				self.handleNewPatchset(change, ps);
		}
	});
};

SupervisorServer.prototype.bootstrap = function bootstrap() {
	this.runQuery('status:open AND NOT label:CI-Testing>=-1');
};

SupervisorServer.prototype.handleNewPatchsets = function handleNewPatchsets() {
	var event;

	while ((event = this.ss_evs.stream.read()) !== null) {
		if (event.type === 'patchset-created' &&
		    event.patchSet.kind !== 'NO_CHANGE' &&
		    event.patchSet.kind !== 'NO_CODE_CHANGE' &&
		    event.patchSet.isDraft === false) {
			this.handleNewPatchset(event.change, event.patchSet);
		}
	}
};

SupervisorServer.prototype.handleNewPatchset =
    function handleNewPatchset(change, ps) {
	if (this.isDisabledRepo(change.project)) {
		return;
	}

	this.ss_log.info('queued %s %d (#%d)',
	    change.project, change.number, ps.number);
	this.ss_queue.push([change, ps]);
	this.runQueue();
};

SupervisorServer.prototype.runQueue = function runQueue() {
	var workers = this.ss_workers;
	var spares = workers.filter(workerIsReady);
	var settingUp = workers.filter(workerIsSettingUp);

	var countSpawning = Object.keys(this.ss_spawning).length;
	var countNotBusy = spares.length + settingUp.length + countSpawning;
	var toMake = this.ss_config.spares - countNotBusy;

	if (workers.length + countSpawning + toMake > this.ss_config.max) {
		toMake = this.ss_config.max - (workers.length + countSpawning);
        }

	if (toMake > 0) {
		this.ss_log.info('to make: %d - spares: %d, settingUp: %d, ' +
		    'spawning: %d (total %d)',
		    toMake, spares.length, settingUp.length, countSpawning,
		    workers.length + countSpawning);
	}

	for (var j = 0; j < toMake; ++j) {
		this.spawnWorker();
	}

	while (spares.length > 0 && this.ss_queue.length > 0) {
		var item = this.ss_queue.shift();
		if (this.isDisabledRepo(item[0].project)) {
			continue;
		}

		var worker = spares.shift();
		worker.build.apply(worker, item);
	}
};

SupervisorServer.prototype.handleNewConnection = function (ws) {
	var self = this;

	var conn = new mod_worker.Connection({
		docker: self.ss_docker,
		gerrit: self.ss_gerrit,
		supervisor: self,
		config: self.ss_config,
		cookie: self.ss_cookie,
		log: self.ss_log
	});

	self.ss_workers.push(conn);

	conn.on('ready', function () {
		self.runQueue();
	});

	conn.on('closed', function () {
		var idx = self.ss_workers.indexOf(conn);
		mod_assert.notStrictEqual(idx, -1);
		self.ss_workers.splice(idx, 1);
	});

	conn.accept(ws);
};

/*
 * Set the informational status for a booting container.
 */
SupervisorServer.prototype.setSpawnStatus = function (cid, s) {
	mod_assert.string(cid, 'cid');
	mod_assert.string(s, 's');

	this.ss_spawning[cid] = s;
};

/*
 * Remove the information status for a container.
 */
SupervisorServer.prototype.delSpawnStatus = function (cid) {
	mod_assert.string(cid, 'cid');

	delete (this.ss_spawning[cid]);
};

/*
 * If a repository's "make check" status has not yet been determined,
 * set a new one.
 */
SupervisorServer.prototype.setInitialRepoStatus = function (repo, s) {
	if (this.ss_checkrepos[repo] !== undefined) {
		return;
	}

	this.ss_checkrepos[repo] = s;
};

/*
 * Force a new "make check" status for a given repo.
 */
SupervisorServer.prototype.setRepoStatus = function (repo, s) {
	this.ss_checkrepos[repo] = s;
};

/*
 * Check whether this repo has been disabled due to either having failed to run
 * "make check" previously or having been manually disabled.
 */
SupervisorServer.prototype.isDisabledRepo = function (repo) {
	return (this.ss_checkrepos[repo] === false);
};

SupervisorServer.prototype.handleHttpRequest = function (req, res) {
	var self = this;
	var formdata = '';

	if (req.url === '/agent.js') {
		res.writeHead(200);
		mod_fs.createReadStream(AGENT_JS).pipe(res);
	} else if (req.url === '/status') {
		var tpl = self._getTpl('./status.html.tpl');
		var vars = {
			workers: self.ss_workers,
			overrides: self.ss_checkrepos,
			queue: self.ss_queue,
			spawning: self.ss_spawning
		};
		var html;
		try {
			html = tpl(vars);
		} catch (e) {
			html = e.stack;
		}
		res.writeHead(200, {
			'content-type': 'text/html'
		});
		res.write(html);
		res.end();
	} else if (req.url === '/override' && req.method === 'POST') {
		req.on('readable', function () {
			var chunk;
			while ((chunk = req.read()) !== null) {
				formdata += chunk.toString('utf-8');
			}
		});
		req.on('end', function () {
			var args = mod_qs.parse(formdata);
			if (args && args.repo) {
				if (args.clear) {
					self.setRepoStatus(args.repo,
					    undefined);
				} else if (args.value) {
					self.setRepoStatus(args.repo,
					    (args.value === 'true'));
				}
				res.writeHead(303, { 'location': '/status' });
				res.end();
			} else {
				res.writeHead(500);
				res.end();
			}
		});
	} else if (req.url === '/bootstrap' && req.method === 'POST') {
		self.bootstrap();
		res.writeHead(303, { 'location': '/status' });
		res.end();
	} else if (req.url === '/runquery' && req.method === 'POST') {
		req.on('readable', function () {
			var chunk;
			while ((chunk = req.read()) !== null) {
				formdata += chunk.toString('utf-8');
			}
		});
		req.on('end', function () {
			var args = mod_qs.parse(formdata);
			if (args && args.query) {
				self.runQuery(args.query);
				res.writeHead(303, { 'location': '/status' });
				res.end();
			} else {
				res.writeHead(500);
				res.end();
			}
		});
	} else {
		res.writeHead(404);
		res.end();
	}
};

/*
 * Do an initial queue run so that we spawn our spare instances, and then
 * wait for work.
 */
SupervisorServer.prototype.state_running = function (S) {
	var self = this;

	S.gotoStateOn(self, 'stopAsserted', 'stopping');

	S.interval(5000, function () {
		self.runQueue();
	});

	self.runQueue();
};

SupervisorServer.prototype.state_stopping = function (S) {
	this.ss_workers.forEach(function (w) {
		w.release();
	});

	S.gotoState('stopped');
};

SupervisorServer.prototype.state_stopped = function (S) {
	S.gotoStateOn(this, 'startAsserted', 'running');
};

SupervisorServer.prototype.start = function () {
	this.emit('startAsserted');
};

SupervisorServer.prototype.stop = function () {
	this.emit('stopAsserted');
};

SupervisorServer.prototype._getTpl = function getTpl(fn) {
	var stat = mod_fs.statSync(fn);
	var cache = this.ss_tplCache[fn];
	if (cache && stat.mtime.getTime() <= cache.mtime.getTime())
		return (cache.func);

	var tpl = mod_fs.readFileSync(fn, 'utf-8');
	var func;
	try {
		func = mod_jade.compile(tpl, {
			filename: fn,
			pretty: true
		});
	} catch (e) {
		this.ss_log.error(e, 'failed to compile template');
		func = function () { return ('Error'); };
	}
	this.ss_tplCache[fn] = { mtime: stat.mtime, func: func };
	return (func);
};

module.exports = {
	Server: SupervisorServer
};
