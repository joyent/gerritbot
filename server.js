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
const mod_bunyan = require('bunyan');
const mod_crypto = require('crypto');
const mod_fs = require('fs');
const mod_gbot = require('gerritbot');
const mod_restify = require('restify-clients');
const mod_sshpk = require('sshpk');
const mod_supervisor = require('./lib/supervisor');

const COOKIE = mod_crypto.randomBytes(8).toString('base64');

var config = JSON.parse(
    mod_fs.readFileSync('etc/config.json').toString('utf-8'));

mod_assert.object(config, 'config');
mod_assert.optionalNumber(config.port, 'config.port');
if (config.port === undefined)
	config.port = 8080;

var log = mod_bunyan.createLogger({ name: 'makecheckbot' });

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

var server = new mod_supervisor.Server({
	docker: docker,
	gerrit: gerrit,
	config: config,
	cookie: COOKIE,
	log: log
});

server.start();
