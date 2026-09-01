'use strict';
/** Per-ticket notification lists, account-wide opt-out, and the email link footer. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();
process.env.PUBLIC_SITE_URL = 'https://repairs.example.org';

const subscriptions = require('../src/subscriptions');
const mailer = require('../src/mailer');
const links = require('../src/lib/links');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

const make = (over = {}) =>
  srv.call('/api/tickets', {
    method: 'POST',
    body: { serial: 'S1', asset_tag: 'PC-1', model: 'Chromebook', user_email: 'sam@example.org', user_name: 'Sam Smith', issue_description: 'Cracked screen', notify: false, ...over },
  });

test('a new ticket is seeded with the statuses whose templates auto-send', async () => {
  const { body } = await make();
  const detail = (await srv.call('/api/tickets/' + body.ticket.id)).body.ticket;
  assert.deepEqual(detail.subscribed_statuses.slice().sort(), subscriptions.defaultStatuses().slice().sort());
  assert.ok(detail.subscribed_statuses.includes('ready_for_pickup'));
  assert.ok(!detail.subscribed_statuses.includes('closed'), 'closed does not auto-send by default');
});

test('the ticket list decides, not the template: unchecking a status silences it', async () => {
  const { body } = await make();
  const id = body.ticket.id;
  await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { notify_statuses: ['closed'] } });

  const parts = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'waiting_on_parts' } });
  assert.equal(parts.body.email.result, 'skipped');
  assert.equal(parts.body.email.reason, 'status_not_subscribed');

  const closed = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'closed' } });
  assert.equal(closed.body.email.result, 'dry_run', 'closed was subscribed on this ticket');
});

test('adding a status to one ticket does not change any other ticket', async () => {
  const a = (await make()).body.ticket;
  const b = (await make()).body.ticket;
  await srv.call('/api/tickets/' + a.id, { method: 'PATCH', body: { notify_statuses: ['closed', 'diagnosing'] } });
  const bDetail = (await srv.call('/api/tickets/' + b.id)).body.ticket;
  assert.ok(!bDetail.subscribed_statuses.includes('diagnosing'));
});

test('the subscription change is written to the ticket timeline', async () => {
  const { body } = await make();
  await srv.call('/api/tickets/' + body.ticket.id, { method: 'PATCH', body: { notify_statuses: ['closed'] } });
  const detail = (await srv.call('/api/tickets/' + body.ticket.id)).body.ticket;
  assert.ok(detail.events.some((e) => (e.body || '').startsWith('email notifications:')));
});

test('an account-wide opt-out beats everything, including notify:true', async () => {
  const { body } = await make({ user_email: 'quiet@example.org' });
  const id = body.ticket.id;
  subscriptions.optOut('quiet@example.org', 'test');

  const res = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'ready_for_pickup', notify: true } });
  assert.equal(res.body.email.result, 'skipped');
  assert.equal(res.body.email.reason, 'user_unsubscribed');

  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.equal(detail.user_unsubscribed, true);
  assert.deepEqual(detail.subscribed_statuses, [], 'opting out clears the list on open tickets');

  // a brand-new ticket for that address starts silent too
  const fresh = await make({ user_email: 'quiet@example.org' });
  const freshDetail = (await srv.call('/api/tickets/' + fresh.body.ticket.id)).body.ticket;
  assert.deepEqual(freshDetail.subscribed_statuses, []);
});

test('a tech can resubscribe an address through the API', async () => {
  subscriptions.optOut('again@example.org', 'test');
  const ok = await srv.call('/api/optouts', { method: 'POST', body: { email: 'again@example.org', action: 'in' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.unsubscribed, false);
  const listed = await srv.call('/api/optouts');
  assert.ok(!listed.body.optouts.some((o) => o.email === 'again@example.org'));
});

test('emails carry a status link and an unsubscribe link', async () => {
  const { body } = await make();
  const id = body.ticket.id;
  const preview = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: {} })).body.preview;
  assert.ok(preview.body.includes(links.statusUrl(id)), 'status link missing');
  assert.ok(preview.body.includes(links.prefsUrl(id)), 'preferences link missing');
});

test('a template that mentions the links itself is left alone', () => {
  const body = mailer.ensureLinkFooter('<div><p>See {{status_url}}</p></div>');
  assert.equal(body, '<div><p>See {{status_url}}</p></div>');
  assert.match(mailer.ensureLinkFooter('<div><p>Hi</p></div>'), /unsubscribe_url/);
});

test('link tokens are single-purpose and tamper-proof', () => {
  const statusToken = links.mint('t', 42);
  const prefsToken = links.mint('u', 42);
  assert.equal(links.verify('t', statusToken), 42);
  assert.equal(links.verify('u', prefsToken), 42);
  assert.equal(links.verify('u', statusToken), null, 'a status link must not open preferences');
  assert.equal(links.verify('t', prefsToken), null);
  assert.equal(links.verify('t', '43.' + statusToken.split('.')[1]), null, 'id swap must fail');
  assert.equal(links.verify('t', '42.deadbeef'), null);
  assert.equal(links.verify('t', 'nonsense'), null);
});

test('an internal note is never emailed unless the tech attaches it to that email', async () => {
  const { body } = await make();
  const id = body.ticket.id;
  const secret = 'INTERNAL: bill the family $120, do not tell the student';
  await srv.call(`/api/tickets/${id}/notes`, { method: 'POST', body: { body: secret, notify: false } });

  // a later status change with no note typed must not carry the internal note
  const res = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'ready_for_pickup', notify: true } });
  assert.equal(res.body.email.result, 'dry_run');
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const sent = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.ok(!sent.body.includes(secret), 'internal note leaked into a status email');
  assert.ok(!sent.body.includes('INTERNAL'), 'internal note leaked into a status email');

  // the preview shown to the tech agrees
  const preview = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: { status: 'closed' } })).body.preview;
  assert.ok(!preview.body.includes(secret));

  // but a note typed with the change IS included - that is the whole point of the box
  const withNote = await srv.call('/api/tickets/' + id, {
    method: 'PATCH',
    body: { status: 'closed', note: 'Screen replaced, tested, returned to you.', notify: true },
  });
  assert.equal(withNote.body.email.result, 'dry_run');
  const after = (await srv.call('/api/tickets/' + id)).body.ticket;
  const second = (await srv.call('/api/emails/' + after.emails[0].id)).body.email;
  assert.ok(second.body.includes('Screen replaced, tested, returned to you.'));
  assert.ok(!second.body.includes(secret));
});

test('emailing a note on purpose sends that note and nothing else from the ticket', async () => {
  const { body } = await make();
  const id = body.ticket.id;
  await srv.call(`/api/tickets/${id}/notes`, { method: 'POST', body: { body: 'INTERNAL: parent is difficult', notify: false } });
  const res = await srv.call(`/api/tickets/${id}/notes`, {
    method: 'POST',
    body: { body: 'We need your OK for the $45 screen fee.', notify: true },
  });
  assert.equal(res.body.email.result, 'dry_run');
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const sent = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.ok(sent.body.includes('We need your OK for the $45 screen fee.'));
  assert.ok(!sent.body.includes('parent is difficult'));
});
