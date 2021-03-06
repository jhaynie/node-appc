/**
 * Performs authentication tasks including logging in the Appcelerator Network,
 * logging out, and checking session status.
 *
 * @module auth
 *
 * @copyright
 * Copyright (c) 2009-2013 by Appcelerator, Inc. All Rights Reserved.
 *
 * @license
 * Licensed under the terms of the Apache Public License
 * Please see the LICENSE included with this distribution for details.
 */

var __ = require('./i18n')(__dirname).__,
	fs = require('fs'),
	path = require('path'),
	crypto = require('crypto'),
	uuid = require('node-uuid'),
	wrench = require('wrench'),
	request = require('request'),
	net = require('./net'),
	mix = require('./util').mix,
	afs = require('./fs'),
	AppcException = require('./exception'),

	defaultTitaniumHomeDir = afs.resolvePath('~', '.titanium'),
	defaultLoginUrl = 'https://api.appcelerator.net/p/v1/sso-login',
	defaultLogoutUrl = 'https://api.appcelerator.net/p/v1/sso-logout',
	myAppc = 'https://my.appcelerator.com/',

	cachedStatus,
	cachedMid;

// common error codes for Authentication
exports.AUTH_ERR_BAD_UN_OR_PW 		= 'AUTH_ERR_BAD_UN_OR_PW';     		//user name or password incorrect
exports.AUTH_ERR_ACCT_NOT_ACTIVE    = 'AUTH_ERR_ACCT_NOT_ACTIVE';     	//the account needs to be activated on appcelerator
exports.AUTH_ERR_CONNECT_FAILURE    = 'AUTH_ERR_CONNECT_FAILURE';     	//unable to reach login server
exports.AUTH_ERR_LOGIN_SERVER_ERR   = 'AUTH_ERR_LOGIN_SERVER_ERR';     	//exception from login server
exports.AUTH_ERR_LOGOUT_NO_LOGIN    = 'AUTH_ERR_LOGOUT_NO_LOGIN';     	//logout while not logged in
exports.AUTH_ERR_INTERNAL_SVR_ERR   = 'AUTH_ERR_INTERNAL_SVR_ERR';     	//other internal server errors

/**
 * Authenticates a user into the Appcelerator Network.
 * @param {Object} args - Login arguments
 * @param {String} args.username - The email address to log in as
 * @param {String} args.password - The password
 * @param {String} args.mid - The specific mid to use (null by default)
 * @param {Function} args.callback(error, result) - The function to call once logged in or on error
 * @param {String} [args.titaniumHomeDir] - The Titanium home directory where the session files are stored
 * @param {String} [args.loginUrl] - The URL to authenticate against
 * @param {String} [args.proxy] - The proxy server to use
 */
exports.login = function login(args) {
	args || (args = {});
	args.titaniumHomeDir = afs.resolvePath(args.titaniumHomeDir || defaultTitaniumHomeDir);
	var dontWriteSession = !!(args.mid); // if we have a passed in mid, don't write it

	if (!dontWriteSession) {
		try {
			assertSessionFile(args.titaniumHomeDir);
		} catch (ex) {
			args.callback(ex);
			return;
		}
	}

	cachedStatus = null;
	var sessionFile = path.join(args.titaniumHomeDir, 'auth_session.json');

	exports.getMID(args.titaniumHomeDir, args.mid, function (mid) {
		// Otherwise we need to re-auth with the server
		request({
			uri: args.loginUrl || defaultLoginUrl,
			method: 'POST',
			proxy: args.proxy,
			jar: false, // don't save cookies
			headers: {
				'Content-Type': 'application/x-www-form-urlencoded'
			},
			body: net.urlEncode({
				un: args.username,
				pw: args.password,
				mid: mid
			})
		}, function (error, response, body) {
			try {
				if (error) {
					var ex = new Error(__('Error communicating with the server: %s', error));
					ex.code = exports.AUTH_ERR_CONNECT_FAILURE;
					throw ex;
				}

				var res = JSON.parse(body);
				if (res.success && !res.activated) {
					var ex = new Error(__('Account not activated. Please activate your account before continuing.'));
					ex.code = exports.AUTH_ERR_ACCT_NOT_ACTIVE;
					throw ex;
				}
				if (res.success) {
					var cookie = response.headers['set-cookie'];
					if (cookie && cookie.length === 1 && cookie[0].match('^PHPSESSID')) {
						// Create the result
						var result = {
							loggedIn: true,
							cookie: cookie[0],
							data: {}
						},
						omitKeys = ['success'];

						// add all the result keys into the data object
						Object.keys(res).forEach(function(k){
							omitKeys.indexOf(k)===-1 && (result.data[k]=res[k]);
						});

						if (!dontWriteSession) {
							// Write the data out to the session file
							if (!fs.existsSync(args.titaniumHomeDir)) {
								wrench.mkdirSyncRecursive(args.titaniumHomeDir);
							}
							fs.writeFileSync(sessionFile, JSON.stringify(result));
						}

						args.callback(null, result);
					} else {
						var ex = new Error(__('Server did not return a session cookie'));
						ex.code = exports.AUTH_ERR_INTERNAL_SVR_ERR;
						throw ex;
					}
				} else if (res.code === 4 || res.code === 5) {
					var ex = new Error(__('Invalid username or password. If you have forgotten your password, please visit %s.', myAppc.cyan));
					ex.code = exports.AUTH_ERR_BAD_UN_OR_PW;
					throw ex;
				} else {
					var ex = new Error(__('Invalid server response'));
					ex.code = exports.AUTH_ERR_LOGIN_SERVER_ERR;
					throw ex;
				}
			} catch (ex) {
				!ex.code && (ex.code = exports.AUTH_ERR_INTERNAL_SVR_ERR);
				!dontWriteSession && createLoggedOutSessionFile(args.titaniumHomeDir);
				args.callback(ex);
			}
		});
	});
};

/**
 * Logs the user out of the Appcelerator Network.
 * @param {Object} args - Logout arguments
 * @param {Function} args.callback(error, result) - The function to call once logged out or on error
 * @param {String} [args.titaniumHomeDir] - The Titanium home directory where the session files are stored
 * @param {String} [args.logoutUrl] - The URL to use to end session
 * @param {String} [args.proxy] - The proxy server to use
 */
exports.logout = function logout(args) {
	args || (args = {});
	args.titaniumHomeDir = afs.resolvePath(args.titaniumHomeDir || defaultTitaniumHomeDir);

	try {
		assertSessionFile(args.titaniumHomeDir);
	} catch (ex) {
		args.callback(ex);
		return;
	}

	cachedStatus = null;
	var sessionFile = path.join(args.titaniumHomeDir, 'auth_session.json');

	if (!fs.existsSync(sessionFile)) {
		// Create a default (logged out) session file
		args.callback(null, mix(createLoggedOutSessionFile(sessionFile), { success: true, alreadyLoggedOut: true }));
		return;
	}

	try {
		var session = JSON.parse(fs.readFileSync(sessionFile));
		if (session.loggedIn) {
			request({
				uri: args.logoutUrl || defaultLogoutUrl,
				method: 'GET',
				proxy: args.proxy,
				headers: {
					'Cookie': session.cookie
				}
			}, function (error, response, body) {
				var result = createLoggedOutSessionFile(sessionFile);
				try {
					if (error) {
						throw new Error(__('Error communicating with the server: %s', error));
					}

					var res = JSON.parse(body);
					if (res.success) {
						mix(result, { success: true, alreadyLoggedOut: false });
					} else {
						throw new Error(__('Error logging out from server: %s', res.reason));
					}

					args.callback(null, result);
				} catch (ex) {
					args.callback(ex, result);
				}
			});
		} else {
			args.callback(null, mix(session, { success: true, alreadyLoggedOut: true }));
		}
	} catch (ex) { // Invalid session file. This should never happen
		args.callback(ex, mix(createLoggedOutSessionFile(sessionFile), { success: true, alreadyLoggedOut: true }));
	}
};

/**
 * Returns whether the user is current logged in.
 * @param {Object} [args] - Status arguments
 * @param {String} [args.titaniumHomeDir] - The Titanium home directory where the session files are stored
 * @returns {Object} An object containing the session status
 */
exports.status = function status(args) {
	if (cachedStatus) return cachedStatus;

	args || (args = {});
	args.titaniumHomeDir = afs.resolvePath(args.titaniumHomeDir || defaultTitaniumHomeDir);

	var sessionFile = path.join(args.titaniumHomeDir, 'auth_session.json'),
		result = {},
		session;

	if (fs.existsSync(sessionFile)) {
		try {
			// Fetch and parse the session data
			session = JSON.parse(fs.readFileSync(sessionFile));
			result = {
				loggedIn: session.loggedIn,
				uid: session.data && session.data.uid,
				guid: session.data && session.data.guid,
				email: session.data && session.data.email,
				cookie: session.cookie
			};
		} catch (e) { // Invalid session file. This should never happen
			result = createLoggedOutSessionFile(sessionFile);
		}
	} else {
		result = createLoggedOutSessionFile(sessionFile); // No prior history, create a new logged out file
	}

	return cachedStatus = result;
};

/**
 * for testing, remove the MID
 */
exports.resetMID = function resetMID() {
	cachedMid = null;
};

/**
 * Returns the machine id (mid) or generates a new one based on the computer's
 * primary network interface's MAC address.
 * @param {String} titaniumHomeDir - The Titanium home directory where the session files are stored
 * @param {String} mid - A cached mid to use if provided during login, defaults to null
 * @param {Function} callback - A callback to fire with the result
 */
exports.getMID = function getMID(titaniumHomeDir, mid, callback) {
	if (typeof mid === 'function') {
		callback = mid;
		mid = null;
	}
	if (cachedMid||mid) {
		callback(cachedMid||mid);
	} else {
		var midFile = path.join(titaniumHomeDir, 'mid.json');
		if (fs.existsSync(midFile)) {
			try {
				cachedMid = JSON.parse(fs.readFileSync(midFile)).mid;
				if (cachedMid) {
					callback(cachedMid);
					return;
				}
			} catch (e) {} // File/MID entry doesn't exist, so we need to recreate it
		}

		// If it got here, we couldn't fetch the previous MID
		net.interfaces(function (ifaces) {
			// Find the MAC address of the local ethernet card
			var macAddress,
				names = Object.keys(ifaces).sort(),
				i, j;

			for (i = 0; i < names.length; i++) {
				j = ifaces[names[i]];
				if (j.macAddress) {
					macAddress = j.macAddress;
					if (/^eth|en|Local Area Connection/.test(j)) {
						break;
					}
				}
			}

			macAddress || (macAddress = uuid.v4());

			// Create the MID, using the MAC address as a seed
			cachedMid = crypto.createHash('md5').update(macAddress).digest('hex');

			// Write the MID to its file
			if (!fs.existsSync(titaniumHomeDir)) {
				wrench.mkdirSyncRecursive(titaniumHomeDir);
			}
			fs.writeFileSync(midFile, JSON.stringify({ mid: cachedMid }));

			callback(cachedMid);
		});
	}
};

/**
 * Asserts the session file exists that the file is writable or the session file
 * does not exist and the Titanium home directory is writable.
 * @param {String} titaniumHomeDir - The Titanium home directory where the session files are stored
 * @throws {AppcException} If session file or Titanium home directory is not writable
 * @private
 */
function assertSessionFile(titaniumHomeDir) {
	var sessionFile = path.join(titaniumHomeDir, 'auth_session.json');

	// check that the file is writable
	if (fs.existsSync(sessionFile)) {
		if (!afs.isFileWritable(sessionFile)) {
			throw new AppcException(__('Session file "%s" is not writable', sessionFile), __('Please ensure the Titanium CLI has access to modify this file.'));
		}

	// check that the .titanium folder is writable
	} else if (!afs.isDirWritable(titaniumHomeDir)) {
		throw new AppcException(__('Directory "%s" is not writable', titaniumHomeDir), __('Please ensure the Titanium CLI has access to this directory.'));
	}
}

/**
 * Creates the session file with a logged out status.
 * @param {String} sessionFile - Path to the session file.
 * @returns {Object} An object contain the logged out session status
 * @private
 */
function createLoggedOutSessionFile(sessionFile) {
	var result = { loggedIn: false },
		titaniumHomeDir = path.dirname(sessionFile),
		session, loggedIn;
	try {
		session = JSON.parse(fs.readFileSync(sessionFile));
		loggedIn = session.loggedIn;
		if (!fs.existsSync(titaniumHomeDir)) {
			wrench.mkdirSyncRecursive(titaniumHomeDir);
		}
		fs.writeFileSync(sessionFile, JSON.stringify(result));
	} catch (e) {
		result.loggedIn = loggedIn;
		result.error = e;
	}
	return result;
}