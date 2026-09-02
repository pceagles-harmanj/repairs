'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();

const mailer = require('../src/mailer');
const tickets = require('../src/tickets');
const { getDb } = require('../src/db');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

const newTicket = (over = {}) => ({
  serial: '5CD1234ABC',
  asset_tag: 'PC-1042',
  model: 'Lenovo 300e Chromebook',
  user_email: 'sam.smith@example.org',
  user_name: 'Sam Smith',
  issue_category: 'Cracked screen',
  issue_description: 'Screen cracked in the lower right corner.',
  priority: 'high',
  ...over,
});

test('template rendering substitutes placeholders and escapes values', () => {
  const out = mailer.render('Hi {{first_name}} <{{user_email}}> {{unknown_key}}', {
    first_name: 'Sam & "Alex"',
    user_email: 'a@b.org',
  });
  assert.equal(out, 'Hi Sam &amp; &quot;Alex&quot; <a@b.org> {{unknown_key}}');
});

test('first name falls back to the email local part', () => {
  const vars = mailer.buildVars({ id: 1, status: 'received', priority: 'normal', user_email: 'jane.doe@example.org', issue_description: 'x' });
  assert.equal(vars.first_name, 'Jane');
});

test('creating a ticket logs an event and sends the New template (dry run)', async () => {
  const res = await srv.call('/api/tickets', { method: 'POST', body: newTicket() });
  assert.equal(res.status, 201);
  const t = res.body.ticket;
  assert.equal(t.status, 'received');
  assert.equal(t.priority, 'high');
  assert.equal(res.body.email.result, 'dry_run', JSON.stringify(res.body.email));

  const detail = (await srv.call('/api/tickets/' + t.id)).body.ticket;
  assert.equal(detail.events[0].type, 'created');
  assert.equal(detail.emails.length, 1);
  assert.match(detail.emails[0].subject, /We have your device/);
});

test('a ticket with no description is rejected', async () => {
  const res = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ issue_description: '  ' }) });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /issue_description/);
});

test('a bad email address is rejected', async () => {
  const res = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ user_email: 'not-an-email' }) });
  assert.equal(res.status, 400);
});

test('status change records an event and emails when the template auto-sends', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify_user: false }) });
  const id = created.ticket.id;
  assert.equal(created.email.result, 'skipped');
  assert.equal(created.email.reason, 'ticket_notifications_off');

  // notifications off on the ticket -> no email
  const off = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'in_progress' } });
  assert.equal(off.body.status_changed, true);
  assert.equal(off.body.email.result, 'skipped');

  // explicit notify:true overrides the ticket setting
  const on = await srv.call('/api/tickets/' + id, {
    method: 'PATCH',
    body: { status: 'ready_for_pickup', note: 'Panel replaced, tested.', notify: true },
  });
  assert.equal(on.body.email.result, 'dry_run');

  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const statusEvents = detail.events.filter((e) => e.type === 'status');
  assert.equal(statusEvents.length, 2);
  assert.equal(statusEvents[1].to_status, 'ready_for_pickup');
  assert.equal(statusEvents[1].body, 'Panel replaced, tested.');
  const last = detail.emails[0];
  assert.match(last.subject, /your device is ready/);
});

test('notify:false suppresses an email the template would otherwise auto-send', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  assert.equal(created.email.result, 'skipped');
  const res = await srv.call('/api/tickets/' + created.ticket.id, {
    method: 'PATCH',
    body: { status: 'waiting_on_parts', notify: false },
  });
  assert.equal(res.body.email.result, 'skipped');
  assert.equal(res.body.email.reason, 'not_requested');
});

test('closing a ticket stamps closed_at; reopening clears it', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const id = created.ticket.id;
  const closed = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'closed', notify: false } });
  assert.ok(closed.body.ticket.closed_at);
  const reopened = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'in_progress', notify: false } });
  assert.equal(reopened.body.ticket.closed_at, null);
});

test('field edits are recorded as events', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const id = created.ticket.id;
  await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { assigned_to: 'jacob', estimated_cost: 45.5, notify: false } });
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.equal(detail.assigned_to, 'jacob');
  assert.equal(detail.estimated_cost, 45.5);
  const fields = detail.events.filter((e) => e.type === 'field').map((e) => e.body);
  assert.ok(fields.some((f) => f.startsWith('assigned_to:')));
  assert.ok(fields.some((f) => f.startsWith('estimated_cost:')));
});

test('a note can be emailed to the user on demand', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const id = created.ticket.id;
  const res = await srv.call(`/api/tickets/${id}/notes`, { method: 'POST', body: { body: 'Waiting on your OK for the $45 fee.', notify: true } });
  assert.equal(res.status, 201);
  assert.equal(res.body.email.result, 'dry_run');
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const full = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.ok(full.body.includes('Waiting on your OK'));
});

test('search matches serial, asset tag, user and issue text', async () => {
  await srv.call('/api/tickets', { method: 'POST', body: newTicket({ serial: 'ZZZ999QQQ', asset_tag: 'PC-777', issue_description: 'Hinge snapped clean off', notify: false }) });
  for (const q of ['ZZZ999QQQ', 'PC-777', 'hinge', 'sam.smith@example.org']) {
    const res = await srv.call('/api/tickets?status=all&q=' + encodeURIComponent(q));
    assert.ok(res.body.tickets.length > 0, `expected a hit for ${q}`);
  }
});

test('status filters split open from closed work', async () => {
  const open = await srv.call('/api/tickets?status=open');
  const all = await srv.call('/api/tickets?status=all');
  const closed = await srv.call('/api/tickets?status=closed');
  assert.ok(all.body.total >= open.body.total);
  assert.ok(open.body.tickets.every((t) => t.status !== 'closed'));
  assert.ok(closed.body.tickets.every((t) => t.status === 'closed'));
  const bad = await srv.call('/api/tickets?status=bogus');
  assert.equal(bad.status, 400);
});

test('email preview renders without sending', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const before = getDb().prepare('SELECT COUNT(*) n FROM email_log').get().n;
  const res = await srv.call(`/api/tickets/${created.ticket.id}/email/preview`, { method: 'POST', body: { status: 'ready_for_pickup', note: 'Front desk pickup.' } });
  assert.equal(res.status, 200);
  assert.match(res.body.preview.subject, /your device is ready/);
  assert.ok(res.body.preview.body.includes('Front desk pickup.'));
  const after = getDb().prepare('SELECT COUNT(*) n FROM email_log').get().n;
  assert.equal(after, before, 'preview must not log an email');
});

test('templates can be edited and auto_send toggled', async () => {
  const res = await srv.call('/api/templates/closed', { method: 'PUT', body: { subject: 'All set #{{ticket_number}}', body: '<p>Done, {{first_name}}.</p>', auto_send: true } });
  assert.equal(res.status, 200);
  assert.equal(res.body.template.auto_send, 1);
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const patched = await srv.call('/api/tickets/' + created.ticket.id, { method: 'PATCH', body: { status: 'closed' } });
  assert.equal(patched.body.email.result, 'dry_run');
  const detail = (await srv.call('/api/tickets/' + created.ticket.id)).body.ticket;
  assert.match(detail.emails[0].subject, /^All set #/);
  await srv.call('/api/templates/closed', { method: 'PUT', body: { auto_send: false } });
});

test('device endpoints report a clear error when Google is not connected', async () => {
  const res = await srv.call('/api/devices/search?q=5CD1234ABC');
  assert.equal(res.status, 409);
  assert.match(res.body.error, /not connected/i);
});

test('a device cached locally is served without calling Google', async () => {
  const google = require('../src/google');
  google.cacheDevice(google.normalizeDevice({
    deviceId: 'dev-1',
    serialNumber: '5CD1234ABC',
    annotatedAssetId: 'PC-1042',
    model: 'Lenovo 300e Chromebook',
    orgUnitPath: '/Students/HS',
    status: 'ACTIVE',
    notes: 'Replaced keyboard 2025-09-02',
    recentUsers: [{ email: 'sam.smith@example.org' }, { email: 'old.user@example.org' }],
  }));
  const res = await srv.call('/api/devices/dev-1');
  assert.equal(res.status, 200);
  assert.equal(res.body.device.asset_tag, 'PC-1042');
  assert.equal(res.body.device.most_recent_user, 'sam.smith@example.org');
  assert.ok(res.body.ticket_history.length > 0, 'should surface tickets for the same serial');
});

test('stats summarise the queue', async () => {
  const res = await srv.call('/api/stats');
  assert.equal(res.status, 200);
  assert.ok(res.body.total >= 8);
  assert.ok(typeof res.body.open === 'number');
});

test('ticket history for a serial excludes the ticket itself', async () => {
  const { body: a } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ serial: 'HIST-1', notify: false }) });
  const { body: b } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ serial: 'HIST-1', notify: false }) });
  const detail = await srv.call('/api/tickets/' + b.ticket.id);
  const ids = detail.body.ticket_history.map((h) => h.id);
  assert.ok(ids.includes(a.ticket.id));
  assert.ok(!ids.includes(b.ticket.id));
});

test('tickets can be deleted', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  assert.equal((await srv.call('/api/tickets/' + created.ticket.id, { method: 'DELETE' })).status, 200);
  assert.equal((await srv.call('/api/tickets/' + created.ticket.id)).status, 404);
});

// ---- the new -> received rename --------------------------------------------

test('a ticket opens as "received", not "new"', async () => {
  const res = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  assert.equal(res.body.ticket.status, 'received');
  const { STATUSES } = require('../src/lib/statuses');
  assert.equal(STATUSES.find((s) => s.key === 'received').label, 'Received');
  assert.equal(STATUSES.some((s) => s.key === 'new'), false, 'the old key is gone from the workflow');
});

test('the old key still works where it might be typed or bookmarked', async () => {
  const { canonicalStatus } = require('../src/lib/statuses');
  assert.equal(canonicalStatus('new'), 'received');
  assert.equal(canonicalStatus('closed'), 'closed');

  // a saved filter link
  const filtered = await srv.call('/api/tickets?status=new');
  assert.equal(filtered.status, 200);
  assert.ok(filtered.body.tickets.every((t) => t.status === 'received'));

  // and an API caller setting it
  const { body: made } = await srv.call('/api/tickets', { method: 'POST', body: newTicket({ notify: false }) });
  const patched = await srv.call('/api/tickets/' + made.ticket.id, { method: 'PATCH', body: { status: 'new', notify: false } });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.ticket.status, 'received');
});
