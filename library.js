(function(module) {
    "use strict";

    /*
     Welcome to the SSO OAuth plugin! If you're inspecting this code, you're probably looking to
     hook up NodeBB with your existing OAuth endpoint.

     Step 1: Fill in the "constants" section below with the requisite informaton. Either the "oauth"
     or "oauth2" section needs to be filled, depending on what you set "type" to.

     Step 2: Give it a whirl. If you see the congrats message, you're doing well so far!

     Step 3: Customise the `parseUserReturn` method to normalise your user route's data return into
     a format accepted by NodeBB. Instructions are provided there. (Line 146)

     Step 4: If all goes well, you'll be able to login/register via your OAuth endpoint credentials.
     */

    var User = module.parent.require('./user'),
        Groups = module.parent.require('./groups'),
        meta = module.parent.require('./meta'),
        db = module.parent.require('../src/database'),
        passport = module.parent.require('passport'),
        fs = module.parent.require('fs'),
        path = module.parent.require('path'),
        nconf = module.parent.require('nconf'),
        winston = module.parent.require('winston'),
        async = module.parent.require('async');

    var authenticationController = module.parent.require('./controllers/authentication');

    /**
     * REMEMBER
     *   Never save your OAuth Key/Secret or OAuth2 ID/Secret pair in code! It could be published and leaked accidentally.
     *   Save it into your config.json file instead:
     *
     *   {
	 *     ...
	 *     "oauth": {
	 *       "id": "someoauthid",
	 *       "secret": "youroauthsecret"
	 *     }
	 *     ...
	 *   }
     */

    var constants = Object.freeze({
            type: nconf.get('oauth:type'),	// Either 'oauth' or 'oauth2'
            name: nconf.get('oauth:name'),	// Something unique to your OAuth provider in lowercase, like "github", or "nodebb"
            oauth: {
                requestTokenURL: nconf.get('oauth:requestTokenURL'),
                accessTokenURL: nconf.get('oauth:accessTokenURL'),
                userAuthorizationURL: nconf.get('oauth:userAuthorizationURL'),
                consumerKey: nconf.get('oauth:key'),	// don't change this line
                consumerSecret: nconf.get('oauth:secret'),	// don't change this line
            },
            oauth2: {
                authorizationURL: nconf.get('oauth:authorizationURL'),
                tokenURL: nconf.get('oauth:tokenURL'),
                clientID: nconf.get('oauth:clientID'),	// don't change this line
                clientSecret: nconf.get('oauth:secret'),	// don't change this line
            },
            userRoute: nconf.get('oauth:userRoute')	// This is the address to your app's "user profile" API endpoint (expects JSON)
        }),
        configOk = false,
        OAuth = {}, passportOAuth, opts;

    if (!constants.name) {
        winston.error('[sso-oauth] Please specify a name for your OAuth provider (library.js:32)');
    } else if (!constants.type || (constants.type !== 'oauth' && constants.type !== 'oauth2')) {
        winston.error('[sso-oauth] Please specify an OAuth strategy to utilise (library.js:31)');
    } else if (!constants.userRoute) {
        winston.error('[sso-oauth] User Route required (library.js:31)');
    } else {
        configOk = true;
    }

    OAuth.getStrategy = function(strategies, callback) {
        if (configOk) {
            passportOAuth = require('passport-oauth')[constants.type === 'oauth' ? 'OAuthStrategy' : 'OAuth2Strategy'];

            if (constants.type === 'oauth') {
                // OAuth options
                opts = constants.oauth;
                opts.callbackURL = nconf.get('url') + '/auth/' + constants.name + '/callback';

                passportOAuth.Strategy.prototype.userProfile = function(token, secret, params, done) {
                    this._oauth.get(constants.userRoute, token, secret, function(err, body, res) {
                        if (err) { return done(new InternalOAuthError('failed to fetch user profile', err)); }

                        try {
                            var json = JSON.parse(body);
                            OAuth.parseUserReturn(json, function(err, profile) {
                                if (err) return done(err);
                                profile.provider = constants.name;

                                done(null, profile);
                            });
                        } catch(e) {
                            done(e);
                        }
                    });
                };
            } else if (constants.type === 'oauth2') {
                // OAuth 2 options
                opts = constants.oauth2;
                opts.callbackURL = nconf.get('url') + '/auth/' + constants.name + '/callback';

                passportOAuth.Strategy.prototype.userProfile = function(accessToken, done) {
                    console.log('I am here-------------------');
                    this._oauth2.get(constants.userRoute, accessToken, function(err, body, res) {
                        if (err) { return done(new InternalOAuthError('failed to fetch user profile', err)); }

                        try {
                            var json = JSON.parse(body);
                            OAuth.parseUserReturn(json, function(err, profile) {
                                if (err) return done(err);
                                profile.provider = constants.name;

                                done(null, profile);
                            });
                        } catch(e) {
                            done(e);
                        }
                    });
                };
            }

            opts.passReqToCallback = true;
            passport.use(constants.name, new passportOAuth(opts, function(req, token, secret, profile, done) {
                OAuth.login({
                    oAuthid: profile.id,
                    handle: profile.displayName,
                    email: profile.emails[0].value,
                    isAdmin: profile.isAdmin
                }, function(err, user) {
                    if (err) {
                        return done(err);
                    }

                    authenticationController.onSuccessfulLogin(req, user.uid);
                    done(null, user);
                });
            }));

            strategies.push({
                name: constants.name,
                url: '/auth/' + constants.name,
                callbackURL: '/auth/' + constants.name + '/callback',
                icon: 'fa-check-square',
                scope: (constants.scope || '').split(',')
            });

            callback(null, strategies);
        } else {
            callback(new Error('OAuth Configuration is invalid'));
        }
    };

    OAuth.parseUserReturn = function(data, callback) {
        // Alter this section to include whatever data is necessary
        // NodeBB *requires* the following: id, displayName, emails.
        // Everything else is optional.

        // Find out what is available by uncommenting this line:
        var profile = {};
        profile.id = data.user_id;
        profile.displayName = data.name;
        profile.emails = [{ value: data.email}];


        // Do you want to automatically make somebody an admin? This line might help you do that...
        profile.isAdmin = (data.role === 'superAdmin' || data.role === 'admin')? true : false;

        // Delete or comment out the next TWO (2) lines when you are ready to proceed
        //process.stdout.write('===\nAt this point, you\'ll need to customise the above section to id, displayName, and emails into the "profile" object.\n===');
        //return callback(new Error('Congrats! So far so good -- please see server log for details'));

        callback(null, profile);
    }

    OAuth.login = function(payload, callback) {
        OAuth.getUidByOAuthid(payload.oAuthid, function(err, uid) {
            if(err) {
                return callback(err);
            }

            if (uid !== null) {
                // Existing User
                callback(null, {
                    uid: uid
                });
            } else {
                // New User
                var success = function(uid) {
                    // Save provider-specific information to the user
                    User.setUserField(uid, constants.name + 'Id', payload.oAuthid);
                    db.setObjectField(constants.name + 'Id:uid', payload.oAuthid, uid);

                    if (payload.isAdmin) {
                        Groups.join('administrators', uid, function(err) {
                            callback(null, {
                                uid: uid
                            });
                        });
                    } else {
                        callback(null, {
                            uid: uid
                        });
                    }
                };

                User.getUidByEmail(payload.email, function(err, uid) {
                    if(err) {
                        return callback(err);
                    }

                    if (!uid) {
                        User.create({
                            username: payload.handle,
                            email: payload.email
                        }, function(err, uid) {
                            if(err) {
                                return callback(err);
                            }

                            success(uid);
                        });
                    } else {
                        success(uid); // Existing account -- merge
                    }
                });
            }
        });
    };

    OAuth.getUidByOAuthid = function(oAuthid, callback) {
        db.getObjectField(constants.name + 'Id:uid', oAuthid, function(err, uid) {
            if (err) {
                return callback(err);
            }
            callback(null, uid);
        });
    };

    OAuth.deleteUserData = function(data, callback) {
        async.waterfall([
            async.apply(User.getUserField, data.uid, constants.name + 'Id'),
            function(oAuthIdToDelete, next) {
                db.deleteObjectField(constants.name + 'Id:uid', oAuthIdToDelete, next);
            }
        ], function(err) {
            if (err) {
                winston.error('[sso-oauth] Could not remove OAuthId data for uid ' + data.uid + '. Error: ' + err);
                return callback(err);
            }

            callback(null, data);
        });
    };

    module.exports = OAuth;
}(module));
