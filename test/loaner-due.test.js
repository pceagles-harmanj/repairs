'use strict';
/** Due dates on school days, and the reminder pass that chases them. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer, startPublicServer } = require('./helpers');

isolate();
process.env.PUBLIC_SITE_URL = 'https://repairs.example.org';
process.env.LOANER_ORG_UNIT = '/Devices/Loaners';
process.env.LOANER_DUE_SCHOOL_DAYS = '5';
process.env.SCHOOL_HOLIDAYS = '2026-11-25..2026-11-27,2026-12-24';
process.env.LOANER_OVERDUE_EVERY_DAYS = '3';
process.env.LOANER_MAX_OVERDUE_NUDGES = '3';
process.env.LOANER_DIGEST_TO = 'helpdesk@example.org';

const google = require('../src/google');
const loaners = require('../src/loaners');
const days = require('../src/lib/schooldays');
const { getDb } = require('../src/db');

// ---- fake Google (loaner pool only) ----
const LOANER = {
  device_id: 'dev-loaner-12', serial: 'LNR000012', asset_tag: 'Loaner-012',
  model: 'Acer Chromebook 511', org_unit: '/Devices/Loaners', notes: '', recent_users: [],
};
google.getDevice = async () => ({ ...LOANER });
// A loaner that is already out is refused now, so hand back a distinct device
// per asset tag rather than the same Loaner-012 every time.
const loanerFor = (term) => {
  const tag = google.normalizeLoanerTag(String(term || '12'));
  const n = tag.replace(/\D/g, '') || '12';
  return { ...LOANER, asset_tag: tag, device_id: `dev-loaner-${n}`, serial: `LNR${n.padStart(6, '0')}` };
};
google.searchLoaners = async (term) => [{ ...loanerFor(term), match: 'exact_asset_tag', exact: true, is_loaner: true }];
google.appendDeviceNote = async () => ({ notes: '', dropped: 0, line: '' });
google.getAccount = () => ({ email: 'it-admin@example.org' });

let srv;
let site;
test.before(async () => { srv = await startServer(); site = await startPublicServer(); });
test.after(async () => { await srv.close(); await site.close(); });

let loanerSeq = 100;
const makeLoan = async (over = {}) => {
  const { body } = await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      device_id: 'dev-student', serial: 'SER1', asset_tag: 'PC-1', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith', issue_description: 'Cracked screen',
      notify: false, ...over,
    },
  });
  loanerSeq += 1;
  await srv.call(`/api/tickets/${body.ticket.id}/loaner`, { method: 'POST', body: { asset_tag: String(loanerSeq) } });
  return body.ticket.id;
};

// The loan row owns these dates; the ticket columns are a mirror of it.
const setDue = (id, day) => {
  getDb().prepare('UPDATE loans SET due_at = ? WHERE ticket_id = ?').run(day, id);
  getDb().prepare('UPDATE tickets SET loaner_due_at = ? WHERE id = ?').run(day, id);
};
/** The tag actually handed out on this ticket - it differs per loan now. */
const tagFor = (id) =>
  getDb().prepare('SELECT loaner_asset_tag FROM loans WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id).loaner_asset_tag;

const shiftIssued = (id, isoDate) => {
  getDb().prepare('UPDATE loans SET issued_at = ? WHERE ticket_id = ?').run(isoDate, id);
  getDb().prepare('UPDATE tickets SET loaner_issued_at = ? WHERE id = ?').run(isoDate, id);
};

// ---- school-day arithmetic --------------------------------------------------

test('five school days from a Thursday is the next Thursday', () => {
  assert.equal(days.toDayString(days.addSchoolDays('2026-09-03', 5)), '2026-09-10');
});

test('a due date never lands on a weekend', () => {
  for (const start of ['2026-09-07', '2026-09-08', '2026-09-09', '2026-09-10', '2026-09-11']) {
    const due = days.addSchoolDays(start, 5);
    assert.ok([1, 2, 3, 4, 5].includes(days.isoWeekday(due)), `${start} -> ${days.toDayString(due)}`);
  }
});

test('holidays are skipped, including a multi-day break', () => {
  // Mon 2026-11-23 + 3 school days: Tue 24 is one, 25-27 are the break, Mon 30
  // is two, Tue Dec 1 is three.
  assert.equal(days.toDayString(days.addSchoolDays('2026-11-23', 3)), '2026-12-01');
  assert.equal(days.toDayString(days.addSchoolDays('2026-11-23', 2)), '2026-11-30');
  assert.equal(days.isSchoolDay('2026-11-26'), false);
  assert.equal(days.isSchoolDay('2026-12-24'), false);
  assert.equal(days.isSchoolDay('2026-12-23'), true);
});

test('issuing a loaner sets the due date automatically', async () => {
  const id = await makeLoan();
  const t = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.ok(t.loaner_due_at, 'a due date should be stamped');
  assert.equal(t.loaner_due_at, days.defaultDueDay(new Date(t.loaner_issued_at)));
  assert.equal(t.loaner_due.outstanding, true);
  assert.ok(t.events.some((e) => (e.body || '').includes('due back')));
});

test('the due date can be set and extended in school days', async () => {
  const id = await makeLoan();
  const set = await srv.call(`/api/tickets/${id}/loaner/due`, { method: 'PATCH', body: { due_day: '2026-09-10' } });
  assert.equal(set.body.due_day, '2026-09-10');

  const ext = await srv.call(`/api/tickets/${id}/loaner/due`, { method: 'PATCH', body: { extend_school_days: 3 } });
  // 2026-09-10 is a Thursday: +3 school days = Tuesday 2026-09-15
  assert.equal(ext.body.due_day, '2026-09-15');

  const bad = await srv.call(`/api/tickets/${id}/loaner/due`, { method: 'PATCH', body: { due_day: 'next friday' } });
  assert.equal(bad.status, 400);
});

test('a returned loaner keeps its dates but stops being outstanding', async () => {
  const id = await makeLoan();
  await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  const t = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.ok(t.loaner_due_at);
  assert.equal(t.loaner_due.outstanding, false);
  assert.ok(t.events.some((e) => (e.body || '').includes('loaner returned')));
});

// ---- the deployed-loaners view ---------------------------------------------

test('the loaners view reports days out and days since the repair finished', async () => {
  const id = await makeLoan();
  shiftIssued(id, new Date(Date.now() - 8 * 86400000).toISOString());
  setDue(id, days.toDayString(new Date(Date.now() - 2 * 86400000)));
  await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'closed', notify: false } });
  getDb().prepare('UPDATE tickets SET closed_at = ? WHERE id = ?').run(new Date(Date.now() - 3 * 86400000).toISOString(), id);

  const res = await srv.call('/api/loaners/out');
  const row = res.body.loaners.find((l) => l.ticket_id === id);
  assert.ok(row, 'the loan should be listed');
  assert.equal(row.days_out, 8);
  assert.equal(row.overdue, true);
  assert.equal(row.days_since_repair_done, 3);
  assert.ok(res.body.stats.overdue >= 1);
  assert.ok(res.body.stats.still_out_after_repair >= 1);
});

test('returned loans leave the outstanding list and appear under returned', async () => {
  const id = await makeLoan();
  await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  const res = await srv.call('/api/loaners/out?include_returned=1');
  assert.ok(!res.body.loaners.some((l) => l.ticket_id === id));
  assert.ok(res.body.returned.some((l) => l.ticket_id === id));
});

// ---- reminders --------------------------------------------------------------

const today = () => days.toDayString(new Date());
const dayOffset = (n) => days.toDayString(new Date(Date.now() + n * 86400000));

test('the day-before reminder goes out once, and only once', async () => {
  const id = await makeLoan();
  setDue(id, dayOffset(1));

  const first = await loaners.runReminders({ reason: 'test' });
  const mine = first.sent.filter((s) => s.ticket_id === id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].kind, 'due_tomorrow');

  const second = await loaners.runReminders({ reason: 'test' });
  assert.equal(second.sent.filter((s) => s.ticket_id === id).length, 0, 'a second pass must not re-send');

  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.match(detail.emails[0].subject, /due back tomorrow/i);
  assert.ok(detail.events.some((e) => (e.body || '').includes('loaner reminder sent (due_tomorrow)')));
});

test('the due-day reminder mentions the date and the asset tag', async () => {
  const id = await makeLoan();
  setDue(id, today());
  const res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id)[0].kind, 'due_today');

  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const mail = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.match(mail.subject, /due back today/i);
  assert.match(mail.body, new RegExp(tagFor(id)));
  assert.ok(!mail.body.includes('{{'), 'no unrendered placeholders');
});

test('overdue nudges repeat on the configured cadence and then stop', async () => {
  const id = await makeLoan();
  setDue(id, dayOffset(-1));

  // day 1 overdue -> nudge
  let res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id)[0].kind, 'overdue');

  // same day again -> nothing
  res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 0);

  // pretend the last nudge was 3 days ago, twice more, then it gives up
  // age only the most recent nudge, the way the calendar would
  const backdate = (n) => getDb()
    .prepare(`UPDATE loan_reminders SET sent_on = ?
              WHERE id = (SELECT id FROM loan_reminders WHERE ticket_id = ? AND kind = 'overdue' ORDER BY sent_on DESC, id DESC LIMIT 1)`)
    .run(dayOffset(-n), id);

  backdate(3);
  res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 1, 'second nudge');

  backdate(6);
  res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 1, 'third nudge');

  backdate(9);
  res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 0, 'stops after the maximum');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM loan_reminders WHERE ticket_id = ? AND kind = 'overdue'").get(id).n, 3);
});

test('a returned loaner is never chased', async () => {
  const id = await makeLoan();
  setDue(id, dayOffset(-2));
  await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  const res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 0);
});

test('swapping the loaner on a ticket starts the reminder history over', async () => {
  const id = await makeLoan();
  setDue(id, today());
  await loaners.runReminders({ reason: 'test' });
  const first = tagFor(id);
  assert.ok(getDb().prepare('SELECT COUNT(*) n FROM loaner_reminders WHERE ticket_id = ?').get(id).n > 0);

  // A different machine, because the first is still out until it comes back.
  const swap = await srv.call(`/api/tickets/${id}/loaner`, { method: 'POST', body: { asset_tag: '777' } });
  assert.equal(swap.status, 200);
  assert.notEqual(tagFor(id), first, 'the ticket now points at the new loaner');

  // The old loan was closed out rather than left dangling.
  const old = getDb()
    .prepare('SELECT returned_at, return_note FROM loans WHERE loaner_asset_tag = ?')
    .get(first);
  assert.ok(old.returned_at, 'the previous loaner is no longer counted as out');
  assert.match(old.return_note, /replaced/);

  // Reminders are per loan, so the new one starts clean.
  const loanId = getDb().prepare('SELECT id FROM loans WHERE ticket_id = ? ORDER BY id DESC LIMIT 1').get(id).id;
  assert.equal(getDb().prepare('SELECT COUNT(*) n FROM loaner_reminders WHERE loan_id = ?').get(loanId).n, 0);
});

test('an unsubscribed student is not chased by email, but still shows on the page', async () => {
  const subscriptions = require('../src/subscriptions');
  const id = await makeLoan({ user_email: 'quiet@example.org' });
  setDue(id, today());
  subscriptions.optOut('quiet@example.org', 'test');

  const res = await loaners.runReminders({ reason: 'test' });
  assert.equal(res.sent.filter((s) => s.ticket_id === id).length, 0);
  assert.ok(res.skipped.some((s) => s.ticket_id === id && s.reason === 'user_unsubscribed'));

  const page = await srv.call('/api/loaners/out');
  assert.ok(page.body.loaners.some((l) => l.ticket_id === id), 'still visible to the helpdesk');
  subscriptions.optIn('quiet@example.org');
});

test('the helpdesk digest lists what is overdue and due today', async () => {
  const a = await makeLoan();
  setDue(a, dayOffset(-4));
  const b = await makeLoan();
  setDue(b, today());

  const digest = await loaners.sendDigest({});
  assert.equal(digest.result, 'dry_run');
  assert.equal(digest.to, 'helpdesk@example.org');
  assert.match(digest.subject, /overdue/);

  const logged = (await srv.call('/api/emails?limit=5')).body.emails.find((e) => e.status_key === 'loaner_digest');
  assert.ok(logged, 'the digest is written to the email log');
  const full = (await srv.call('/api/emails/' + logged.id)).body.email;
  assert.match(full.body, /Overdue/);
  assert.match(full.body, new RegExp(tagFor(a)));
  assert.match(full.body, new RegExp(tagFor(b)));
});

test('the reminder schedule reports itself for Settings', () => {
  const status = loaners.status();
  assert.equal(status.enabled, true);
  assert.equal(status.school_days, 5);
  assert.equal(status.overdue_every_days, 3);
  assert.equal(status.digest_to, 'helpdesk@example.org');
  assert.ok(status.holidays.includes('2026-11-26'));
  const ms = loaners.msUntilNextRun(new Date());
  assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000);
});

// ---- what the student sees about the loaner --------------------------------

const links = require('../src/lib/links');
const publicPage = async (ticketId) =>
  (await fetch(site.base + '/t/' + links.mint('t', ticketId))).text();

test('the loaner has a section of its own with the details on it', async () => {
  const id = await makeLoan();
  const html = await publicPage(id);

  assert.match(html, /Your loaner device/);
  assert.match(html, new RegExp(tagFor(id)));
  assert.match(html, /Acer Chromebook 511/, 'the model is shown');
  assert.match(html, /Borrowed/);
  assert.match(html, /Due back/);
  assert.match(html, /bring the loaner with you/i, 'the swap is explained while it is out');
});

test('when the repair is ready, the swap is the loudest thing on the page', async () => {
  const id = await makeLoan();
  await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'ready_for_pickup', notify: false } });
  const html = await publicPage(id);

  // said in the banner at the top...
  assert.match(html, new RegExp(`is fixed and waiting for you.*Bring loaner ${tagFor(id)} with you`, 's'));
  // ...and again, emphasised, in the loaner section
  assert.match(html, new RegExp(`class="highlight"[^>]*>\\s*Bring loaner ${tagFor(id)} with you\\.\\s*We hand your own device back when the loaner comes in`));
});

test('an overdue loaner says so plainly', async () => {
  const id = await makeLoan();
  setDue(id, dayOffset(-3));
  const html = await publicPage(id);
  assert.match(html, /was due back on/i);
  assert.match(html, /as soon as you can/i);
});

test('a returned loaner thanks them and stops nagging', async () => {
  const id = await makeLoan();
  await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  const html = await publicPage(id);
  assert.match(html, /this loaner is back with us/i);
  assert.match(html, /Returned/);
  assert.ok(!/Bring loaner/.test(html), 'no swap instructions once it is back');
  assert.ok(!/due back/i.test(html));
});

test('a ticket with no loaner has no loaner section at all', async () => {
  const { body } = await srv.call('/api/tickets', {
    method: 'POST',
    body: { serial: 'NOLOAN', asset_tag: 'PC-77', model: 'Lenovo 300e', user_email: 'sam@example.org',
            issue_description: 'Battery', notify: false },
  });
  const html = await publicPage(body.ticket.id);
  assert.ok(!/Your loaner device/.test(html));
});

test('the pickup email uses the same words as the page', async () => {
  const id = await makeLoan();
  const preview = (await srv.call(`/api/tickets/${id}/email/preview`, {
    method: 'POST', body: { status: 'ready_for_pickup' },
  })).body.preview;
  assert.match(preview.body, new RegExp(`Bring loaner ${tagFor(id)} with you`));
  assert.match(preview.body, /we hand your own device back when the loaner comes in/i);
});
