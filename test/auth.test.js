'use strict';
/** The shared-password gate: forged cookies must not work, real logins must. */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { isolate, startServer } = require('./helpers');

isolate();
process.env.APP_PASSWORD = 'letmein';
process.env.SESSION_SECRET = 'insecure-dev-secret'; // the dangerous default this test guards against

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

const forge = (secret, name = 'attacker', issuedAt = Date.now()) => {
  const payload = `${name}|${issuedAt}`;
  const mac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return `repairs_session=${Buffer.from(payload).toString('base64url')}.${mac}`;
};

test('the API is closed without a session', async () => {
  const res = await fetch(srv.base + '/api/tickets');
  assert.equal(res.status, 401);
});

test('a cookie signed with the old built-in default secret is rejected', async () => {
  for (const guess of ['insecure-dev-secret', 'change-me-to-something-random', '']) {
    const res = await fetch(srv.base + '/api/tickets', { headers: { cookie: forge(guess) } });
    assert.equal(res.status, 401, `secret "${guess}" must not work`);
  }
});

test('the wrong password does not sign you in', async () => {
  const res = await fetch(srv.base + '/api/session/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope' }),
  });
  assert.equal(res.status, 401);
});

test('the right password signs you in and the session works', async () => {
  const login = await fetch(srv.base + '/api/session/login', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'letmein', name: 'jacob' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.getSetCookie()[0].split(';')[0];
  const list = await fetch(srv.base + '/api/tickets', { headers: { cookie } });
  assert.equal(list.status, 200);

  // author defaults to the signed-in name
  const created = await fetch(srv.base + '/api/tickets', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ issue_description: 'Screen flickers', notify: false }),
  });
  const { ticket } = await created.json();
  assert.equal(ticket.assigned_to, 'jacob');
});

test('a session older than 30 days is refused even with a valid signature', async () => {
  const { getSetting } = require('../src/db');
  const secret = getSetting('session_secret');
  assert.ok(secret && secret.length >= 32, 'a random secret should have been generated and stored');
  const stale = forge(secret, 'jacob', Date.now() - 31 * 24 * 60 * 60 * 1000);
  const res = await fetch(srv.base + '/api/tickets', { headers: { cookie: stale } });
  assert.equal(res.status, 401);
  const fresh = forge(secret, 'jacob');
  assert.equal((await fetch(srv.base + '/api/tickets', { headers: { cookie: fresh } })).status, 200);
});

test('the OAuth callback is closed to strangers when a password is set', async () => {
  const res = await fetch(srv.base + '/oauth2/callback?code=attacker-code');
  assert.equal(res.status, 401);
});
