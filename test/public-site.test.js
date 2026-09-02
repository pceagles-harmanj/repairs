'use strict';
/** The user-facing site: magic links, lookup, preferences, and what it must never leak. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer, startPublicServer } = require('./helpers');

isolate();
process.env.PUBLIC_SITE_URL = 'https://repairs.example.org';
process.env.PUBLIC_ALLOW_LOOKUP = 'true';
process.env.PUBLIC_ALLOWED_DOMAINS = ''; // deliberately unconfigured: sign-in must fail closed
process.env.PUBLIC_TRUST_PROXY = 'false';

const links = require('../src/lib/links');
const subscriptions = require('../src/subscriptions');

let srv;
let site;
let ticketId;

test.before(async () => {
  srv = await startServer();
  site = await startPublicServer();
  const { body } = await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: 'SER-PUB-1', asset_tag: 'PC-4242', model: 'Acer Chromebook 511',
      user_email: 'Student.One@Example.org', user_name: 'Student One',
      issue_category: 'Cracked screen', issue_description: 'Screen cracked after a fall',
      notify: false,
    },
  });
  ticketId = body.ticket.id;
  await srv.call('/api/tickets/' + ticketId, {
    method: 'PATCH',
    body: { status: 'waiting_on_parts', note: 'INTERNAL: student was horsing around, charge the family', notify: false },
  });
});
test.after(async () => { await srv.close(); await site.close(); });

const get = (path) => fetch(site.base + path, { redirect: 'manual' });
// form values may be arrays: send them the way a browser does (repeated fields)
const post = (path, form) => {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) {
    for (const one of [].concat(v)) params.append(k, one);
  }
  return fetch(site.base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
    redirect: 'manual',
  });
};

test('a magic link shows the repair status', async () => {
  const res = await get('/t/' + links.mint('t', ticketId));
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Waiting on Parts/);
  assert.match(html, /PC-4242/);
  assert.match(html, /Screen cracked after a fall/);
  assert.match(html, /waiting on a part/i, 'plain-language explanation');
});

test('internal notes never appear on the public page', async () => {
  const html = await (await get('/t/' + links.mint('t', ticketId))).text();
  assert.ok(!/INTERNAL/i.test(html), 'internal note leaked to the public page');
  assert.ok(!/horsing around/i.test(html));
  assert.ok(!/SER-PUB-1/.test(html), 'serial number is not published');
});

test('a tampered or wrong-kind token is a 404', async () => {
  assert.equal((await get('/t/' + ticketId + '.badmac')).status, 404);
  assert.equal((await get('/t/' + links.mint('u', ticketId))).status, 404, 'prefs token must not open the status page');
  assert.equal((await get('/u/' + links.mint('t', ticketId))).status, 404);
  assert.equal((await get('/t/999999.' + links.mint('t', 999999).split('.')[1])).status, 404);
});

test('the preferences page lists the statuses and saves a new selection', async () => {
  const token = links.mint('u', ticketId);
  const html = await (await get('/u/' + token)).text();
  assert.match(html, /Email preferences/);
  assert.match(html, /Ready for Pickup/);

  const res = await post('/u/' + token, { statuses_present: '1', status: ['ready_for_pickup', 'closed'] });
  assert.equal(res.status, 302);
  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.deepEqual(detail.subscribed_statuses.slice().sort(), ['closed', 'ready_for_pickup']);
  assert.ok(detail.events.some((e) => (e.body || '').includes('their own email preferences')));
});

test('unsubscribe all stops mail for that address everywhere', async () => {
  const token = links.mint('u', ticketId);
  const res = await post('/u/' + token, { unsubscribe_all: '1' });
  assert.equal(res.status, 302);
  assert.equal(subscriptions.isOptedOut('student.one@example.org'), true);

  const patched = await srv.call('/api/tickets/' + ticketId, { method: 'PATCH', body: { status: 'ready_for_pickup', notify: true } });
  assert.equal(patched.body.email.result, 'skipped');
  assert.equal(patched.body.email.reason, 'user_unsubscribed');

  // and the user can turn it back on from the same page
  await post('/u/' + token, { statuses_present: '1', status: ['ready_for_pickup'] });
  assert.equal(subscriptions.isOptedOut('student.one@example.org'), false);
});

test('one-click unsubscribe (the mail client button) works', async () => {
  const res = await fetch(site.base + '/u/' + links.mint('u', ticketId) + '/one-click', { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(subscriptions.isOptedOut('student.one@example.org'), true);
  subscriptions.optIn('student.one@example.org');
});

test('lookup needs the asset tag AND the matching email', async () => {
  const wrongEmail = await post('/lookup', { tag: 'PC-4242', email: 'someone.else@example.org' });
  assert.equal(wrongEmail.status, 404);
  const wrongTag = await post('/lookup', { tag: 'PC-9999', email: 'student.one@example.org' });
  assert.equal(wrongTag.status, 404);

  const ok = await post('/lookup', { tag: 'pc-4242', email: 'STUDENT.ONE@example.org' });
  assert.equal(ok.status, 302, 'case-insensitive match redirects to the ticket');
  assert.match(ok.headers.get('location'), new RegExp('^/t/' + ticketId + '\\.'));
});

test('the serial number also works as a lookup key', async () => {
  const ok = await post('/lookup', { tag: 'ser-pub-1', email: 'student.one@example.org' });
  assert.equal(ok.status, 302);
});

test('lookup is rate limited', async () => {
  let sawLimit = false;
  for (let i = 0; i < 20; i += 1) {
    const res = await post('/lookup', { tag: 'PC-0000', email: 'nobody@example.org' });
    if (res.status === 429) { sawLimit = true; break; }
  }
  assert.ok(sawLimit, 'repeated guessing should hit the limiter');
});

test('the public pages set a restrictive CSP and allow only the configured embedders', async () => {
  const res = await get('/t/' + links.mint('t', ticketId));
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /frame-ancestors .*sites\.google\.com/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
});

test('the landing page offers lookup and does not leak any ticket', async () => {
  const html = await (await get('/')).text();
  assert.match(html, /Look up a repair/);
  assert.ok(!/PC-4242/.test(html));
});

test('unknown paths are a friendly 404, and errors are not stack traces', async () => {
  const res = await get('/nope');
  assert.equal(res.status, 404);
  const html = await res.text();
  assert.ok(!/at Object|node:internal/.test(html));
});

// ---------------------------------------------------------------------------
// Regressions from the second security review
// ---------------------------------------------------------------------------

test('the read-only status link does not contain a preferences token', async () => {
  const html = await (await get('/t/' + links.mint('t', ticketId))).text();
  const prefsToken = links.mint('u', ticketId).split('.')[1];
  assert.ok(!html.includes(prefsToken), 'status page leaked the preferences token');
  assert.match(html, /\/u\/confirm\//, 'it should offer the confirm-your-email step instead');
});

test('preferences via a forwarded status link require the right email address', async () => {
  const token = links.mint('t', ticketId);
  assert.equal((await get('/u/confirm/' + token)).status, 200);

  const wrong = await post('/u/confirm/' + token, { email: 'someone.else@example.org' });
  assert.equal(wrong.status, 403);
  assert.ok(!(await wrong.text()).includes(links.mint('u', ticketId)), 'must not hand over the token on failure');

  const right = await post('/u/confirm/' + token, { email: 'STUDENT.ONE@example.org' });
  assert.equal(right.status, 302);
  assert.match(right.headers.get('location'), new RegExp('^/u/' + ticketId + '\\.'));
});

test('unsubscribing then re-subscribing leaves a working list, not silence', async () => {
  const token = links.mint('u', ticketId);
  await post('/u/' + token, { unsubscribe_all: '1' });
  assert.equal(subscriptions.isOptedOut('student.one@example.org'), true);

  // the form the user gets while unsubscribed shows real (default) selections
  const html = await (await get('/u/' + token)).text();
  assert.ok(!/disabled/.test(html), 'checkboxes must stay usable while unsubscribed');

  // saving that form (boxes checked, "stop all" unticked) turns email back on
  const picked = ['received', 'in_progress', 'waiting_on_parts', 'waiting_on_user', 'ready_for_pickup'];
  await post('/u/' + token, { statuses_present: '1', status: picked });
  assert.equal(subscriptions.isOptedOut('student.one@example.org'), false);

  await srv.call('/api/tickets/' + ticketId, { method: 'PATCH', body: { status: 'in_progress', notify: false } });
  const res = await srv.call('/api/tickets/' + ticketId, { method: 'PATCH', body: { status: 'ready_for_pickup' } });
  assert.equal(res.body.email.result, 'dry_run', 'ready-for-pickup must email again');
});

test('a bare unsubscribe form cannot silently empty the list', async () => {
  const token = links.mint('u', ticketId);
  // no statuses_present marker and no boxes: treat as "restore the defaults"
  await post('/u/' + token, {});
  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.ok(detail.subscribed_statuses.length > 0);

  // but an explicit "none of them" is honoured
  await post('/u/' + token, { statuses_present: '1' });
  const after = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.deepEqual(after.subscribed_statuses, []);
  await post('/u/' + token, { statuses_present: '1', status: ['ready_for_pickup'] });
});

test('every status is offered on the preferences page, so a save cannot drop one', async () => {
  const { STATUS_KEYS } = require('../src/lib/statuses');
  const html = await (await get('/u/' + links.mint('u', ticketId))).text();
  for (const key of STATUS_KEYS) {
    assert.ok(html.includes(`value="${key}"`), `${key} missing from the preferences form`);
  }
});

test('spoofing X-Forwarded-For does not reset the rate limiter', async () => {
  let blocked = 0;
  for (let i = 0; i < 25; i += 1) {
    const res = await fetch(site.base + '/lookup', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-forwarded-for': `10.0.0.${i}` },
      body: new URLSearchParams({ tag: 'PC-NOPE-' + i, email: 'nobody@example.org' }).toString(),
      redirect: 'manual',
    });
    if (res.status === 429) blocked += 1;
  }
  assert.ok(blocked > 0, 'a rotating XFF header must not buy unlimited attempts');
});

test('a junk JSON cookie does not break the landing page', async () => {
  for (const value of ['j:{"a":1}', 'j:[1,2]', 'x.y', 'garbage']) {
    const res = await fetch(site.base + '/', { headers: { cookie: `repairs_user=${value}` } });
    assert.equal(res.status, 200, `cookie ${value} should not error`);
  }
});

test('Google sign-in fails closed and never echoes library detail', async () => {
  // no CSRF pair -> refused before any token work
  const noCsrf = await post('/signin', { credential: 'whatever' });
  assert.equal(noCsrf.status, 400);

  const res = await fetch(site.base + '/signin', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'g_csrf_token=abc' },
    body: new URLSearchParams({ credential: 'not-a-real-token', g_csrf_token: 'abc' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 403, 'PUBLIC_ALLOWED_DOMAINS is empty, so sign-in must be refused');
  const html = await res.text();
  assert.ok(!/certificate|proxy|ENOTFOUND|jwt|audience/i.test(html), 'no library detail in the page');
  assert.ok(!/accounts\.google\.com\/o\/oauth2/.test(html));
});

test('the sign-in button is hidden when it cannot work', async () => {
  const html = await (await get('/')).text();
  assert.ok(!/g_id_onload/.test(html), 'button should be hidden without an allowed domain list');
});
