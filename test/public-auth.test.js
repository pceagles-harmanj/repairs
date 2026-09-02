'use strict';
/**
 * Student sign-in over the redirect flow - the one that works on a plain-http
 * internal site, where Google's rendered button cannot.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer, startPublicServer } = require('./helpers');

isolate();
process.env.PUBLIC_SITE_URL = 'http://repairs.internal.example.org';
process.env.PUBLIC_ALLOWED_DOMAINS = 'example.org';
process.env.GOOGLE_CLIENT_ID = 'client-123.apps.googleusercontent.com';
process.env.GOOGLE_CLIENT_SECRET = 'GOCSPX-secret';

const publicAuth = require('../src/public-auth');
const links = require('../src/lib/links');

let srv;
let site;
test.before(async () => { srv = await startServer(); site = await startPublicServer(); });
test.after(async () => { await srv.close(); await site.close(); });

const get = (path, headers = {}) => fetch(site.base + path, { redirect: 'manual', headers });
const cookieFrom = (res, name) =>
  (res.headers.getSetCookie() || []).map((c) => c.split(';')[0]).find((c) => c.startsWith(name + '='));

// ---- configuration ---------------------------------------------------------

test('sign-in is offered only when it can actually work', () => {
  assert.equal(publicAuth.available(), true);
  assert.equal(publicAuth.why(), null);
  assert.equal(publicAuth.redirectUri(), 'http://repairs.internal.example.org/auth/google/callback');
});

test('the redirect URI is what you paste into the Cloud console', () => {
  // No port when the site is on 80, port included otherwise - it must match exactly.
  assert.match(publicAuth.redirectUri(), /^http:\/\/[^/]+\/auth\/google\/callback$/);
});

test('the authorize URL asks for identity only, and hints the school domain', () => {
  const url = new URL(publicAuth.authUrl('state-abc'));
  assert.equal(url.origin + url.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(url.searchParams.get('response_type'), 'code');
  assert.equal(url.searchParams.get('scope'), 'openid email profile');
  // whatever client is configured - the point is that it is carried through
  assert.equal(url.searchParams.get('client_id'), publicAuth.clientId());
  assert.ok(publicAuth.clientId().endsWith('.apps.googleusercontent.com'));
  assert.equal(url.searchParams.get('redirect_uri'), publicAuth.redirectUri());
  assert.equal(url.searchParams.get('state'), 'state-abc');
  assert.equal(url.searchParams.get('hd'), 'example.org');
  assert.equal(url.searchParams.get('prompt'), 'select_account');
});

// ---- the round trip --------------------------------------------------------

test('the sign-in link redirects to Google and sets a state cookie', async () => {
  const res = await get('/auth/google');
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const state = new URL(location).searchParams.get('state');
  assert.ok(state);

  const cookie = cookieFrom(res, publicAuth.STATE_COOKIE);
  assert.ok(cookie, 'the state is also stored in a cookie');
  assert.equal(cookie.split('=')[1], encodeURIComponent(state).replace(/%2E/g, '.'), 'the two match');
});

test('a callback with no state, or a forged one, is refused', async () => {
  assert.equal((await get('/auth/google/callback?code=abc')).status, 400);
  assert.equal((await get('/auth/google/callback?code=abc&state=made-up')).status, 400);

  // a real cookie, but a different state in the URL
  const start = await get('/auth/google');
  const cookie = cookieFrom(start, publicAuth.STATE_COOKIE);
  const res = await get('/auth/google/callback?code=abc&state=someone-elses', { cookie });
  assert.equal(res.status, 400);
  assert.match(await res.text(), /expired|try again/i);
});

test('a cancelled sign-in says so without a stack trace', async () => {
  const res = await get('/auth/google/callback?error=access_denied');
  assert.equal(res.status, 400);
  const html = await res.text();
  assert.match(html, /cancelled/i);
  assert.ok(!/at Object|node:internal/.test(html));
});

test('a good round trip signs the student in', async () => {
  const real = publicAuth.exchangeCode;
  publicAuth.exchangeCode = async () => ({ email: 'Student.One@Example.org', name: 'Student One', hd: 'example.org' });
  try {
    const start = await get('/auth/google');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = cookieFrom(start, publicAuth.STATE_COOKIE);

    const res = await get(`/auth/google/callback?code=good&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/');
    assert.ok(cookieFrom(res, 'repairs_user'), 'a session cookie is issued');

    // and the session works: their tickets page recognises them
    const session = cookieFrom(res, 'repairs_user');
    const home = await fetch(site.base + '/', { headers: { cookie: session } });
    assert.match(await home.text(), /student\.one@example\.org/i);
  } finally {
    publicAuth.exchangeCode = real;
  }
});

test('an account outside the allowed domains is refused', async () => {
  const real = publicAuth.exchangeCode;
  publicAuth.exchangeCode = async () => ({ email: 'someone@gmail.com', name: 'Someone', hd: null });
  try {
    const start = await get('/auth/google');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = cookieFrom(start, publicAuth.STATE_COOKIE);
    const res = await get(`/auth/google/callback?code=good&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(res.status, 403);
    assert.match(await res.text(), /not part of this organization/i);
    assert.equal(cookieFrom(res, 'repairs_user'), undefined, 'no session for an outsider');
  } finally {
    publicAuth.exchangeCode = real;
  }
});

test('a failure at Google is reported plainly, with the detail in the log only', async () => {
  const real = publicAuth.exchangeCode;
  publicAuth.exchangeCode = async () => { throw new Error('invalid_grant: redirect_uri_mismatch (http://…)'); };
  try {
    const start = await get('/auth/google');
    const state = new URL(start.headers.get('location')).searchParams.get('state');
    const cookie = cookieFrom(start, publicAuth.STATE_COOKIE);
    const res = await get(`/auth/google/callback?code=bad&state=${encodeURIComponent(state)}`, { cookie });
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.match(html, /could not complete that sign-in/i);
    assert.ok(!/redirect_uri_mismatch|invalid_grant/.test(html), 'library detail stays out of the page');
  } finally {
    publicAuth.exchangeCode = real;
  }
});

test('the domain gate accepts the hosted domain as well as the address', () => {
  assert.equal(publicAuth.domainAllowed({ email: 'a@example.org', hd: null }), true);
  assert.equal(publicAuth.domainAllowed({ email: 'a@alias.test', hd: 'example.org' }), true);
  assert.equal(publicAuth.domainAllowed({ email: 'a@gmail.com', hd: 'gmail.com' }), false);
});

test('the page offers the link, not the widget that cannot work on http', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /href="\/auth\/google"/);
  assert.match(html, /Sign in with Google/);
  assert.ok(!/g_id_onload|gsi\/client/.test(html), 'no Google Identity Services widget');
});

// ---- PUBLIC_OAUTH_REDIRECT_URI --------------------------------------------

test('an explicit redirect URI overrides the one derived from the site URL', () => {
  const config = require('../src/config');
  const saved = config.publicSite.oauthRedirectUri;
  try {
    config.publicSite.oauthRedirectUri = 'http://repairs.internal.example.org/auth/google/callback';
    assert.equal(publicAuth.redirectUri(), 'http://repairs.internal.example.org/auth/google/callback');
    assert.equal(new URL(publicAuth.authUrl('s')).searchParams.get('redirect_uri'), publicAuth.redirectUri());

    // the callback path is appended when the override leaves it off
    config.publicSite.oauthRedirectUri = 'http://repairs.internal.example.org';
    assert.equal(publicAuth.redirectUri(), 'http://repairs.internal.example.org/auth/google/callback');

    // and a trailing slash does not produce a double slash
    config.publicSite.oauthRedirectUri = 'http://repairs.internal.example.org/';
    assert.equal(publicAuth.redirectUri(), 'http://repairs.internal.example.org/auth/google/callback');
  } finally {
    config.publicSite.oauthRedirectUri = saved;
  }
});

test('with no override, the site URL still drives it', () => {
  const config = require('../src/config');
  const saved = config.publicSite.oauthRedirectUri;
  try {
    config.publicSite.oauthRedirectUri = '';
    assert.equal(publicAuth.redirectUri(), 'http://repairs.internal.example.org/auth/google/callback');
  } finally {
    config.publicSite.oauthRedirectUri = saved;
  }
});

test('the client id and secret fall back to the tech app\'s OAuth client', () => {
  const config = require('../src/config');
  const saved = config.publicSite.oauthClientId;
  try {
    config.publicSite.oauthClientId = '';
    assert.equal(publicAuth.clientId(), config.google.clientId, 'no separate client needed');
  } finally {
    config.publicSite.oauthClientId = saved;
  }
  assert.equal(publicAuth.available(), true);
});
