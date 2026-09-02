'use strict';
/**
 * OAuth doctor:  npm run check-oauth
 *
 * Prints the exact redirect URI this install will send to Google, the exact
 * string to paste into the Cloud console, and anything that will make Google
 * answer "Error 400: invalid_request" or "redirect_uri_mismatch".
 */
const config = require('../src/config');
const google = require('../src/google');

const line = (s = '') => console.log(s);
const ok = (s) => console.log(`  [32m✓[0m ${s}`);
const bad = (s) => console.log(`  [31m✗[0m ${s}`);
const warn = (s) => console.log(`  [33m![0m ${s}`);

line();
line('Repair Tickets - OAuth check');
line('============================');
line();

// ---- 1. credentials ----
line('1. Client credentials (.env)');
if (!config.google.clientId) bad('GOOGLE_CLIENT_ID is empty');
else if (!/\.apps\.googleusercontent\.com$/.test(config.google.clientId)) {
  bad(`GOOGLE_CLIENT_ID does not look like a client id (should end in .apps.googleusercontent.com): ${config.google.clientId}`);
} else ok(`GOOGLE_CLIENT_ID ${config.google.clientId}`);

if (!config.google.clientSecret) bad('GOOGLE_CLIENT_SECRET is empty');
else if (!/^GOCSPX-/.test(config.google.clientSecret)) warn('GOOGLE_CLIENT_SECRET does not start with GOCSPX- (older secrets are fine)');
else ok('GOOGLE_CLIENT_SECRET is set');
line();

// ---- 2. the redirect URI ----
line('2. Redirect URI');
line(`   PUBLIC_URL          ${config.publicUrl}`);
line(`   OAUTH_REDIRECT_URI  ${process.env.OAUTH_REDIRECT_URI || '(unset - derived from PUBLIC_URL)'}`);
line();
line('   Paste EXACTLY this into Google Cloud Console ->');
line('   APIs & Services -> Credentials -> your OAuth client (type: Web application)');
line('   -> Authorized redirect URIs:');
line();
line(`       ${config.redirectUri}`);
line();

const problems = config.redirectUriProblems();
if (problems.length) problems.forEach(bad);
else ok('The redirect URI is a shape Google will accept');

const url = new URL(config.redirectUri);
const isLoopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
if (url.protocol === 'https:' && !config.tls.certPath) {
  warn(
    `This is an https URL but TLS_CERT_PATH / TLS_KEY_PATH are empty, so the app is serving plain http.\n` +
    `      Google would send the browser to ${config.redirectUri} and nothing would answer.\n` +
    `      Until you have a certificate, use:  OAUTH_REDIRECT_URI=http://localhost:${config.port}/oauth2/callback`
  );
}
if (isLoopback) {
  ok(`Loopback redirect: open the app as http://localhost:${url.port || 80} on this machine to connect`);
  line(`      (from another machine:  ssh -L ${url.port || 80}:localhost:${config.port} user@this-server)`);
}
line();

// ---- 3. public site ----
line('3. Public status site');
const publicAuth = require('../src/public-auth');
if (!config.publicSite.enabled) warn('PUBLIC_SITE_ENABLED=false - no user-facing site');
else if (!config.publicSite.url) warn('PUBLIC_SITE_URL is empty - emails will have no status/unsubscribe links');
else {
  ok(`PUBLIC_SITE_URL ${config.publicSite.url}  (serving on port ${config.publicSite.port})`);
  const siteUrl = new URL(config.publicSite.url);
  if (config.publicSite.port < 1024) {
    bad(`PUBLIC_SITE_PORT=${config.publicSite.port} needs root on macOS/Linux and the app will fail to start. Use 8081 and forward to it.`);
  }
  if (siteUrl.port && Number(siteUrl.port) !== config.publicSite.port) {
    warn(`The URL says port ${siteUrl.port} but PUBLIC_SITE_PORT is ${config.publicSite.port} - correct only if a proxy sits in front`);
  }
  if (!siteUrl.port && siteUrl.protocol === 'https:' && !config.publicSite.tls.certPath) {
    warn(`${siteUrl.origin} implies port 443 with TLS, but no PUBLIC_TLS_CERT_PATH is set - either terminate TLS in front, or put the real port in the URL`);
  }
  if (siteUrl.hostname === new URL(config.publicUrl).hostname && siteUrl.port === new URL(config.publicUrl).port) {
    bad('PUBLIC_SITE_URL and PUBLIC_URL are the same address - the tech app and the public site are two different listeners and need different hostnames or ports');
  }
  line();
  line('   Student sign-in (the redirect flow - no JavaScript origins needed):');
  if (publicAuth.available()) {
    ok(`allowed for: ${config.publicSite.allowedDomains.join(', ')}`);
  } else {
    warn(`off - ${publicAuth.why()}`);
  }
  line();
  line('   Add this to the SAME OAuth client under "Authorized redirect URIs":');
  line();
  line(`       ${publicAuth.redirectUri() || '(set PUBLIC_SITE_URL first)'}`);
  line();
  line('   Google\'s rendered "Sign in with Google" button is NOT used: it needs a');
  line('   secure context and an https JavaScript origin, so it cannot work on an');
  line('   internal http site. The redirect flow above works on http and https.');
}
line();

// ---- 4. connection state ----
line('4. Connection state');
const status = google.status();
if (!status.configured) bad('Not configured yet (see 1)');
else if (status.connected) {
  ok(`Connected as ${status.email} since ${status.connectedAt}`);
  line(`      Scopes: ${status.scopes.map((s) => s.split('/').pop()).join(', ')}`);
} else {
  warn('Not connected yet - start the app and use Settings -> Connect Google');
}
line();

line('Reminders that catch people out:');
line('  - The client must be type "Web application" (a Desktop client has no redirect URI field).');
line('  - Enable BOTH "Admin SDK API" and "Gmail API" on the project.');
line('  - OAuth consent screen: User type "Internal" keeps it to your Workspace, no verification.');
line('  - The URI must match character for character: scheme, host, port, and /oauth2/callback.');
line();
