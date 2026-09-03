'use strict';
/**
 * A loaner out with no repair attached: the case the old model could not
 * express. Also the two guards that keep the list trustworthy.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();
process.env.LOANER_ORG_UNIT = '/Devices/Loaners';
process.env.LOANER_DUE_SCHOOL_DAYS = '5';
process.env.LOANER_DIGEST_TO = 'helpdesk@example.org';

const google = require('../src/google');
const loans = require('../src/loans');
const loaners = require('../src/loaners');
const days = require('../src/lib/schooldays');
const { getDb } = require('../src/db');

const loanerFor = (term) => {
  const tag = google.normalizeLoanerTag(String(term));
  // strip the padding so the fake device ids stay readable: Loaner-012 -> 12
  const n = String(Number(tag.replace(/\D/g, '') || 1));
  return {
    device_id: `dev-loaner-${n}`, serial: `LNR${n.padStart(6, '0')}`, asset_tag: tag,
    model: 'Acer Chromebook 511', org_unit: '/Devices/Loaners', notes: '', recent_users: [],
  };
};
google.searchLoaners = async (term) => [{ ...loanerFor(term), match: 'exact_asset_tag', exact: true, is_loaner: true }];
google.searchDevices = async (term) => [{
  device_id: 'dev-own-1', serial: '5CD1234ABC', asset_tag: String(term).toUpperCase(),
  model: 'Lenovo 300e', org_unit: '/Students/HS', recent_users: ['sam@example.org'],
  match: 'exact_asset_tag', exact: true,
}];
google.loanerPool = async () => [loanerFor('12'), loanerFor('13'), loanerFor('14')];
google.appendDeviceNote = async () => ({ notes: '', dropped: 0, line: '' });
google.getAccount = () => ({ email: 'it@example.org' });

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });
// Hand everything back between tests. Without this a single failure leaves a
// loaner out and every later test fails on the double-issue guard instead of
// on its own subject.
test.afterEach(() => clearLoans());

const dispatch = (over = {}) =>
  srv.call('/api/loans', {
    method: 'POST',
    body: {
      loaner_asset_tag: '12',
      borrower_email: 'sam@example.org',
      borrower_name: 'Sam Smith',
      reason: 'left_at_home',
      author: 'Jacob',
      ...over,
    },
  });

const clearLoans = () =>
  getDb().prepare('UPDATE loans SET returned_at = ? WHERE returned_at IS NULL').run(new Date().toISOString());

test('a loaner goes out with no ticket at all', async () => {
  const res = await dispatch();
  assert.equal(res.status, 201);
  const loan = res.body.loan;

  assert.equal(loan.ticket_id, null, 'no repair is involved');
  assert.equal(loan.reason, 'left_at_home');
  assert.equal(loan.reason_label, 'Left their device at home');
  assert.equal(loan.loaner_asset_tag, 'Loaner-012');
  assert.equal(loan.loaner_device_id, 'dev-loaner-12', 'resolved against the loaner org unit');
  assert.equal(loan.outstanding, true);
  // The five-school-day default applies whether or not there is a repair.
  assert.equal(loan.due_day, days.toDayString(days.defaultDueDay(new Date(loan.issued_at))));

  // And it shows up in the deployed-loaners view alongside repair loans.
  const out = loaners.listOutstanding();
  assert.ok(out.some((l) => l.id === loan.id));
  assert.equal(loaners.stats().without_ticket, 1);
});

test('a reason is required, and some reasons demand a note', async () => {
  const none = await dispatch({ reason: '' });
  assert.equal(none.status, 400);
  assert.match(none.body.error, /reason/i);

  const bogus = await dispatch({ reason: 'because' });
  assert.equal(bogus.status, 400);

  // "lost" without a word about what happened is useless three months later.
  const bare = await dispatch({ reason: 'lost' });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /note/i);

  const withNote = await dispatch({ reason: 'lost', reason_note: 'left on the bus, family notified' });
  assert.equal(withNote.status, 201);
  assert.equal(withNote.body.loan.reason_note, 'left on the bus, family notified');
});

test('the same loaner cannot be out to two people', async () => {
  const first = await dispatch();
  assert.equal(first.status, 201);

  const second = await dispatch({ borrower_email: 'ava@example.org', borrower_name: 'Ava Jones' });
  assert.equal(second.status, 409);
  assert.match(second.body.error, /already out to Sam Smith/);
  assert.match(second.body.error, /Return it first/);

  // Force does not override this one - two people cannot hold one Chromebook.
  const forced = await dispatch({ borrower_email: 'ava@example.org', force: true });
  assert.equal(forced.status, 409);
});

test('a student who already has one is a warning, not a wall', async () => {
  await dispatch();
  const again = await dispatch({ loaner_asset_tag: '13' });
  assert.equal(again.status, 409);
  assert.match(again.body.error, /already has/);
  assert.ok(again.body.existing && again.body.existing.length === 1, 'the blocking loan comes back with it');

  const forced = await dispatch({ loaner_asset_tag: '13', force: true });
  assert.equal(forced.status, 201, 'a tech who means it can hand out a second');
});

test("the student's own device rides along on the loan", async () => {
  const res = await dispatch({ own_asset_tag: 'pc-1042', own_device_state: 'at_home' });
  assert.equal(res.status, 201);
  const loan = res.body.loan;
  assert.equal(loan.own_asset_tag, 'PC-1042');
  assert.equal(loan.own_device_id, 'dev-own-1', 'looked up in Google, not just typed');
  assert.equal(loan.own_serial, '5CD1234ABC');
  assert.equal(loan.own_device_state, 'at_home');
});

test('a loan can be adopted by a repair ticket later', async () => {
  const loan = (await dispatch({ reason: 'not_charged' })).body.loan;
  const ticket = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_description: 'Turns out the screen is cracked', notify: false,
    },
  })).body.ticket;

  const linked = await srv.call(`/api/loans/${loan.id}/ticket`, { method: 'POST', body: { ticket_id: ticket.id } });
  assert.equal(linked.status, 200);
  assert.equal(linked.body.loan.ticket_id, ticket.id);

  // The ticket drawer sees it, because loans.js mirrors onto the ticket columns.
  const detail = (await srv.call('/api/tickets/' + ticket.id)).body.ticket;
  assert.equal(detail.loaner_asset_tag, 'Loaner-012');
  assert.equal(detail.loaner_outstanding, true);
  assert.equal(detail.loan.id, loan.id);
  assert.ok(detail.events.some((e) => /linked to this ticket/.test(e.body || '')));

  // Detaching leaves the ticket clean rather than looking like it still has one.
  const un = await srv.call(`/api/loans/${loan.id}/ticket`, { method: 'POST', body: { ticket_id: null } });
  assert.equal(un.body.loan.ticket_id, null);
  const after = (await srv.call('/api/tickets/' + ticket.id)).body.ticket;
  assert.equal(after.loaner_asset_tag, null);
  assert.equal(after.loaner_outstanding, false);
});

test('returning records the condition, and damage needs describing', async () => {
  const loan = (await dispatch()).body.loan;

  const bare = await srv.call(`/api/loans/${loan.id}/return`, { method: 'POST', body: { condition: 'damaged' } });
  assert.equal(bare.status, 400);
  assert.match(bare.body.error, /damage/i);

  const done = await srv.call(`/api/loans/${loan.id}/return`, {
    method: 'POST', body: { condition: 'damaged', note: 'cracked lid corner', author: 'Jacob' },
  });
  assert.equal(done.status, 200);
  assert.equal(done.body.loan.outstanding, false);
  assert.equal(done.body.loan.return_condition, 'damaged');
  assert.equal(done.body.loan.return_note, 'cracked lid corner');
  assert.ok(done.body.loan.returned_at);

  // Out of the outstanding list, into the returned one.
  assert.ok(!loaners.listOutstanding().some((l) => l.id === loan.id));
  assert.ok(loaners.listReturned().some((l) => l.id === loan.id));
  // And the loaner is free to hand out again.
  assert.equal((await dispatch()).status, 201);
});

test('a ticketless loan still gets chased when it comes due', async () => {
  const loan = (await dispatch()).body.loan;
  getDb().prepare('UPDATE loans SET due_at = ? WHERE id = ?').run(days.toDayString(new Date()), loan.id);

  const res = await loaners.runReminders({ reason: 'test' });
  const mine = res.sent.filter((r) => r.loan_id === loan.id);
  assert.equal(mine.length, 1, 'the due-today reminder went out');
  assert.equal(mine[0].to, 'sam@example.org');

  // Once only, however many times the pass runs.
  const again = await loaners.runReminders({ reason: 'test' });
  assert.equal(again.sent.filter((r) => r.loan_id === loan.id).length, 0);

  // The wording must not promise a repair that does not exist.
  const logged = (await srv.call('/api/emails?limit=10')).body.emails
    .find((e) => e.status_key === 'loaner_due_today');
  const full = (await srv.call('/api/emails/' + logged.id)).body.email;
  assert.match(full.body, /your own device is not with us/i);
  assert.doesNotMatch(full.body, /still with us/i);
});

test('the fleet list says what is free and what is out', async () => {
  const loan = (await dispatch({ loaner_asset_tag: '13' })).body.loan;
  const res = await srv.call('/api/loaners/fleet');
  assert.equal(res.status, 200);

  assert.equal(res.body.stats.total, 3);
  assert.equal(res.body.stats.out, 1);
  assert.equal(res.body.stats.available, 2);

  // Available first, so the answer to "what can I hand out" is at the top.
  assert.equal(res.body.devices[0].out, false);
  const busy = res.body.devices.find((d) => d.asset_tag === 'Loaner-013');
  assert.equal(busy.out, true);
  assert.equal(busy.loan.borrower_email, 'sam@example.org');
  assert.equal(busy.loan.reason_label, 'Left their device at home');
  assert.equal(busy.loan.id, loan.id);
});

test('a loan on a device outside the loaner org unit is flagged, not hidden', async () => {
  // Typed in by hand when Google was unreachable, so it has no device id.
  loans.issue({
    loaner_asset_tag: 'Loaner-999', borrower_email: 'ava@example.org',
    reason: 'event', reason_note: 'robotics meet',
  }, { author: 'Jacob' });

  const res = await srv.call('/api/loaners/fleet');
  assert.equal(res.body.not_in_org_unit.length, 1);
  assert.equal(res.body.not_in_org_unit[0].loaner_asset_tag, 'Loaner-999');
});

test('old ticket loaners were moved into the loans table by the migration', () => {
  // The migration runs at open(); prove the shape it produces is what the rest
  // of the code expects, using a ticket row written the old way.
  const db = getDb();
  const ts = new Date().toISOString();
  db.prepare(
    `INSERT INTO tickets (serial, asset_tag, model, device_id, user_email, user_name, issue_description,
       status, priority, loaner_device_id, loaner_asset_tag, loaner_serial, loaner_issued_at, loaner_due_at,
       created_at, updated_at)
     VALUES ('OLD1', 'PC-9', 'Lenovo 300e', 'dev-old', 'old@example.org', 'Old Student', 'Screen',
       'received', 'normal', 'dev-loaner-99', 'Loaner-099', 'LNR000099', ?, '2026-09-10', ?, ?)`
  ).run(ts, ts, ts);
  const ticketId = db.prepare('SELECT id FROM tickets WHERE serial = ?').get('OLD1').id;

  require('../src/db').migrateData(db);

  const moved = db.prepare('SELECT * FROM loans WHERE ticket_id = ?').get(ticketId);
  assert.ok(moved, 'the legacy loaner became a loan');
  assert.equal(moved.reason, 'repair');
  assert.equal(moved.loaner_asset_tag, 'Loaner-099');
  assert.equal(moved.borrower_email, 'old@example.org');
  // The repair unit is the student's own device on a repair loan.
  assert.equal(moved.own_asset_tag, 'PC-9');
  assert.equal(moved.own_device_state, 'in_shop');
  assert.equal(moved.due_at, '2026-09-10');

  // Running it twice must not duplicate the loan.
  require('../src/db').migrateData(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM loans WHERE ticket_id = ?').get(ticketId).n, 1);
});

// ---- fixing a loan that is already out -------------------------------------

test('the details of a loan that is out can all be corrected', async () => {
  const loan = (await dispatch({ reason: 'not_charged' })).body.loan;

  const res = await srv.call('/api/loans/' + loan.id, {
    method: 'PATCH',
    body: {
      reason: 'left_at_home',
      borrower_name: 'Samuel Smith',
      own_asset_tag: 'pc-1042',
      own_device_state: 'at_home',
      due_at: '2026-09-30',
      author: 'Jacob',
    },
  });
  assert.equal(res.status, 200);
  const after = res.body.loan;
  assert.equal(after.reason, 'left_at_home');
  assert.equal(after.borrower_name, 'Samuel Smith');
  assert.equal(after.own_asset_tag, 'PC-1042');
  assert.equal(after.own_device_id, 'dev-own-1', 'the tag was looked up, not just stored');
  assert.equal(after.own_device_state, 'at_home');
  assert.equal(after.due_day, '2026-09-30');
  assert.equal(after.outstanding, true, 'still out');
});

test('a mis-scanned loaner tag can be corrected in place', async () => {
  const loan = (await dispatch()).body.loan;
  assert.equal(loan.loaner_asset_tag, 'Loaner-012');

  const res = await srv.call('/api/loans/' + loan.id, {
    method: 'PATCH', body: { loaner_asset_tag: '13', author: 'Jacob' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.loan.loaner_asset_tag, 'Loaner-013');
  assert.equal(res.body.loan.loaner_device_id, 'dev-loaner-13', 'relooked up in Google');

  // The freed machine can go out again, and the corrected one cannot double-book.
  assert.equal((await dispatch({ loaner_asset_tag: '12', borrower_email: 'ava@example.org' })).status, 201);
});

test('correcting a tag onto a machine already out is refused', async () => {
  const mine = (await dispatch()).body.loan;
  await dispatch({ loaner_asset_tag: '13', borrower_email: 'ava@example.org', borrower_name: 'Ava' });

  const res = await srv.call('/api/loans/' + mine.id, {
    method: 'PATCH', body: { loaner_asset_tag: '13' },
  });
  assert.equal(res.status, 409);
  assert.match(res.body.error, /already out to Ava/);
  assert.match(res.body.error, /Return that one first/);
});

test('a loan cannot be edited into having no contact address', async () => {
  const loan = (await dispatch()).body.loan;
  const res = await srv.call('/api/loans/' + loan.id, { method: 'PATCH', body: { borrower_email: '' } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /nobody can be reminded/);
});

test("the student's own device can be cleared, not just changed", async () => {
  const loan = (await dispatch({ own_asset_tag: 'pc-1042' })).body.loan;
  assert.equal(loan.own_device_id, 'dev-own-1');

  const res = await srv.call('/api/loans/' + loan.id, { method: 'PATCH', body: { own_asset_tag: '' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.loan.own_asset_tag, null);
  assert.equal(res.body.loan.own_device_id, null, 'the whole device is forgotten, not just the tag');
  assert.equal(res.body.loan.own_serial, null);
});

test('edits to a loan on a ticket are written into the ticket history', async () => {
  const ticket = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_description: 'Cracked screen', notify: false,
    },
  })).body.ticket;
  const loan = (await dispatch({ ticket_id: ticket.id })).body.loan;

  await srv.call('/api/loans/' + loan.id, {
    method: 'PATCH', body: { due_at: '2026-10-01', reason: 'at_vendor', author: 'Jacob' },
  });

  const events = (await srv.call('/api/tickets/' + ticket.id)).body.ticket.events.map((e) => e.body || '');
  assert.ok(events.some((b) => /due date set to 2026-10-01/.test(b)), events.join(' | '));
  assert.ok(events.some((b) => /reason changed to/.test(b)));
});

// ---- attaching a repair after the fact -------------------------------------

test("the student's own open tickets are offered for attaching", async () => {
  const loan = (await dispatch()).body.loan;

  const mine = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_description: 'Screen went black', notify: false,
    },
  })).body.ticket;
  // Somebody else's ticket must not be offered.
  const theirs = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: 'OTHER', asset_tag: 'PC-2', model: 'Lenovo 300e',
      user_email: 'ava@example.org', user_name: 'Ava Jones',
      issue_description: 'Keyboard', notify: false,
    },
  })).body.ticket;

  const res = await srv.call(`/api/loans/${loan.id}/ticket-options`);
  assert.equal(res.status, 200);
  assert.equal(res.body.attached, null);
  const ids = res.body.tickets.map((t) => t.id);
  assert.ok(ids.includes(mine.id), 'their own ticket is there');
  assert.ok(!ids.includes(theirs.id), "and nobody else's");

  // Attaching then works, and the ticket picks the loaner up.
  const linked = await srv.call(`/api/loans/${loan.id}/ticket`, { method: 'POST', body: { ticket_id: mine.id } });
  assert.equal(linked.status, 200);
  const detail = (await srv.call('/api/tickets/' + mine.id)).body.ticket;
  assert.equal(detail.loaner_asset_tag, 'Loaner-012');
  assert.equal(detail.loaner_outstanding, true);
});

test('two loans cannot be attached to one ticket', async () => {
  const ticket = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: 'S-A', asset_tag: 'PC-3', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_description: 'Hinge', notify: false,
    },
  })).body.ticket;

  const first = (await dispatch({ ticket_id: ticket.id })).body.loan;
  const second = (await dispatch({
    loaner_asset_tag: '13', borrower_email: 'ava@example.org', borrower_name: 'Ava', force: true,
  })).body.loan;

  const res = await srv.call(`/api/loans/${second.id}/ticket`, { method: 'POST', body: { ticket_id: ticket.id } });
  assert.equal(res.status, 409);
  assert.match(res.body.error, new RegExp(`already has loan #${first.id}`));
});

test('a bad ticket number is refused rather than silently ignored', async () => {
  const loan = (await dispatch()).body.loan;
  const res = await srv.call(`/api/loans/${loan.id}/ticket`, { method: 'POST', body: { ticket_id: 99999 } });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /No ticket #99999/);
});

test('a ticket can adopt a loaner the student already had out', async () => {
  // Monday: left it at home. Wednesday: the screen is cracked and a ticket is
  // opened. The loaner already in their hands should be reusable.
  const loan = (await dispatch({ reason: 'left_at_home' })).body.loan;
  const ticket = (await srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith',
      issue_description: 'Cracked screen', notify: false,
    },
  })).body.ticket;

  // This is what the drawer asks for: open loans for this student, unattached.
  const mine = (await srv.call('/api/loans?email=sam%40example.org')).body.loans.filter((l) => !l.ticket_id);
  assert.equal(mine.length, 1);
  assert.equal(mine[0].id, loan.id);

  const before = mine[0].due_day;
  await srv.call(`/api/loans/${loan.id}/ticket`, { method: 'POST', body: { ticket_id: ticket.id } });
  const after = (await srv.call('/api/loans/' + loan.id)).body.loan;

  assert.equal(after.ticket_id, ticket.id);
  assert.equal(after.due_day, before, 'the clock it was already on is kept');
  assert.equal(after.reason, 'left_at_home', 'and the original reason is not rewritten');
});
