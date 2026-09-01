'use strict';
const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { getDb } = require('./db');
const google = require('./google');
const session = require('./lib/session');
const backup = require('./backup');
const loaners = require('./loaners');
const tracking = require('./tracking');
const api = require('./routes/api');
const { createPublicApp } = require('./public-site');

function createApp() {
  getDb(); // open + migrate up front so a bad DB path fails loudly at boot
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser(config.sessionSecret));

  app.get('/healthz', (req, res) => res.json({ ok: true, version: require('../package.json').version }));

  // ---- session ----
  app.get('/api/session', (req, res) => {
    const user = session.currentUser(req);
    res.json({ password_required: Boolean(config.appPassword), signed_in: Boolean(user), user });
  });

  app.post('/api/session/login', (req, res) => {
    const { password, name } = req.body || {};
    if (!session.checkPassword(password)) return res.status(401).json({ error: 'Wrong password' });
    session.issue(res, (name && String(name).slice(0, 60)) || 'tech');
    res.json({ ok: true });
  });

  app.post('/api/session/logout', (req, res) => {
    session.clear(res);
    res.json({ ok: true });
  });

  // ---- Google OAuth redirect target ----
  app.get('/oauth2/callback', async (req, res) => {
    const { code, error, state } = req.query;
    // Only a signed-in tech may complete the flow (when a password is configured).
    if (!session.currentUser(req)) {
      return res.status(401).send(page('Sign in first', 'Sign in to Repair Tickets, then start the Google connection from Settings.'));
    }
    if (error) return res.status(400).send(page('Google sign-in cancelled', escape(String(error))));
    if (!code) return res.status(400).send(page('Missing code', 'Google did not return an authorization code.'));
    try {
      google.consumeAuthState(state === undefined ? '' : String(state));
      const { email } = await google.exchangeCode(String(code));
      google.resetClientCache();
      res.send(page('Google connected', `Signed in as <b>${escape(email || 'unknown account')}</b>. You can close this tab.`, true));
    } catch (err) {
      res.status(err.statusCode || 500).send(page('Could not connect Google', escape(err.message)));
    }
  });

  // ---- API ----
  app.use('/api', session.requireAuth, api);

  // ---- static frontend ----
  app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

  // ---- errors ----
  app.use((err, req, res, next) => { // eslint-disable-line no-unused-vars
    const status = err.statusCode || err.status || (err.code === 'GOOGLE_NOT_CONNECTED' ? 409 : 500);
    let message = googleErrorMessage(err);
    // Never hand a raw driver/SQL message to the browser.
    if (String(err.code || '').startsWith('SQLITE')) {
      console.error('[db error]', req.method, req.originalUrl, err.code, message);
      message = 'The database rejected that change. Check the values and try again.';
    } else if (status >= 500) {
      console.error('[error]', req.method, req.originalUrl, message);
    }
    res.status(status).json({ error: message, code: err.code || undefined });
  });

  return app;
}

/** Turn Google API error blobs into something a human can act on. */
function googleErrorMessage(err) {
  const raw = (err && err.message) || 'Server error';
  const detail = err && err.response && err.response.data && err.response.data.error;
  if (detail && detail.message) {
    if (detail.status === 'PERMISSION_DENIED' || detail.code === 403) {
      return `Google denied the request: ${detail.message}. Check that the signed-in account is a Workspace admin with device privileges and that the Admin SDK API is enabled.`;
    }
    return `Google API: ${detail.message}`;
  }
  if (/invalid_grant/i.test(raw)) return 'Google token is no longer valid. Reconnect Google in Settings.';
  return raw;
}

const escape = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const page = (title, body, ok = false) => `<!doctype html><meta charset="utf-8">
<title>${escape(title)}</title>
<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;max-width:560px;margin:15vh auto;padding:0 24px;line-height:1.6">
<h1 style="font-size:22px;color:${ok ? '#16a34a' : '#b91c1c'}">${escape(title)}</h1>
<p style="color:#374151">${body}</p>
<p><a href="/" style="color:#2563eb">Back to Repair Tickets</a></p>
</div>`;

/** http, or https when a cert/key pair is configured. */
function listen(app, { port, host, tls, label, url }) {
  let server;
  if (tls && tls.certPath && tls.keyPath) {
    server = https.createServer({ cert: fs.readFileSync(tls.certPath), key: fs.readFileSync(tls.keyPath) }, app);
  } else {
    server = http.createServer(app);
  }
  server.on('error', (err) => {
    if (err.code === 'EACCES' && port < 1024) {
      console.error(
        `\n${label} could not bind port ${port}: ports below 1024 need root.\n` +
        `  Use a high port (e.g. ${port === 80 ? 8081 : port + 8000}) and forward 443/80 to it at your firewall or proxy.\n`
      );
    } else if (err.code === 'EADDRINUSE') {
      console.error(`\n${label} could not bind port ${port}: something else is already using it.\n`);
    } else {
      console.error(`\n${label} failed to start on port ${port}: ${err.message}\n`);
    }
    process.exit(1);
  });
  server.listen(port, host, () => {
    const scheme = server instanceof https.Server ? 'https' : 'http';
    console.log(`${label} listening on ${scheme}://${host}:${port}${url ? `  (public URL ${url})` : ''}`);
  });
  return server;
}

function start() {
  const servers = [listen(createApp(), {
    port: config.port, host: config.host, tls: config.tls, label: 'Repair tickets', url: config.publicUrl,
  })];

  if (config.publicSite.enabled) {
    servers.push(listen(createPublicApp(), {
      port: config.publicSite.port, host: config.publicSite.host, tls: config.publicSite.tls,
      label: 'Public status site', url: config.publicSite.url,
    }));
  }

  backup.startScheduler();
  loaners.startScheduler();
  tracking.startScheduler();

  if (!google.isConfigured()) console.log('! GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set - device lookups and email are disabled until you add them to .env');
  if (!config.appPassword) console.log('! APP_PASSWORD is empty - anyone who can reach this port can use the app');
  if (config.dryRunEmail) console.log('! DRY_RUN_EMAIL=true - emails are logged, not sent');
  if (config.publicSite.enabled && !config.publicSite.url) console.log('! PUBLIC_SITE_URL is not set - status/unsubscribe links will be left out of emails');
  if (!config.loanerDue.remindersEnabled) console.log('! LOANER_REMINDERS_ENABLED=false - no loaner return reminders');
  console.log(`  Google redirect URI: ${config.redirectUri}`);
  for (const problem of config.redirectUriProblems()) console.log(`! ${problem}`);
  if (config.redirectUri.startsWith('https://') && !config.tls.certPath) {
    console.log('! The redirect URI is https but TLS_CERT_PATH/TLS_KEY_PATH are empty, so this app is serving plain http.');
    console.log('  Run `npm run check-oauth` for the fix.');
  }

  return servers;
}

if (require.main === module) start();

module.exports = { createApp, start, listen };
