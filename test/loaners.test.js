'use strict';
/**
 * Loaner linkage, the repair note written back to Google on close, and the
 * themed templates. Google is stubbed in-process: these tests are about our
 * logic, not about the network.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();
process.env.LOANER_ORG_UNIT = '/Devices/Loaners';

const google = require('../src/google');
const tickets = require('../src/tickets');
const mailer = require('../src/mailer');
const { getDb, resetTemplates, DEFAULT_TEMPLATES } = require('../src/db');

// ---- a small fake Google ----------------------------------------------------
const DEVICES = {
  'dev-student': {
    device_id: 'dev-student', serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
    org_unit: '/Students/High School', notes: 'Keyboard replaced 2025-09-02', recent_users: ['sam@example.org'],
  },
  'dev-loaner-12': {
    device_id: 'dev-loaner-12', serial: 'LNR000012', asset_tag: 'Loaner-012', model: 'Acer 511',
    org_unit: '/Devices/Loaners', notes: '', recent_users: [],
  },
  'dev-loaner-120': {
    device_id: 'dev-loaner-120', serial: 'LNR000120', asset_tag: 'Loaner-120', model: 'Acer 511',
    org_unit: '/Devices/Loaners', notes: '', recent_users: [],
  },
};
let failNextWrite = null;

google.getDevice = async (id) => {
  if (!DEVICES[id]) throw new Error('not found');
  return { ...DEVICES[id] };
};
google.searchLoaners = async (term) => {
  const tag = google.normalizeLoanerTag(term);
  const pool = Object.values(DEVICES).filter((d) => google.isLoaner(d));
  return google
    .rankDevices(tag, pool.filter((d) => d.asset_tag.toLowerCase().startsWith(tag.toLowerCase()) || d.serial.toLowerCase() === String(term).toLowerCase()))
    .map((d) => ({ ...d, is_loaner: true }));
};
google.loanerPool = async () => Object.values(DEVICES).filter((d) => google.isLoaner(d)).map((d) => ({ ...d }));
google.appendDeviceNote = async (deviceId, line, { maxChars = 500 } = {}) => {
  if (failNextWrite) {
    const err = new Error(failNextWrite);
    failNextWrite = null;
    throw err;
  }
  const device = DEVICES[deviceId];
  if (!device) throw new Error('device not found');
  const lines = (device.notes ? device.notes.split('\n') : []).concat(google.sanitizeNoteLine(line));
  let dropped = 0;
  while (lines.join('\n').length > maxChars && lines.length > 1) { lines.shift(); dropped += 1; }
  device.notes = lines.join('\n');
  return { device: { ...device }, notes: device.notes, dropped, line };
};

let srv;
test.before(async () => { srv = await startServer(); });

// A loaner that is already out is refused now - that is the point of the guard,
// and it has its own tests in loans.test.js. These tests are about the ticket
// link, so hand everything back between them and keep Loaner-012 available.
test.beforeEach(() => {
  getDb().prepare("UPDATE loans SET returned_at = ? WHERE returned_at IS NULL").run(new Date().toISOString());
});
test.after(async () => { await srv.close(); });

const newTicket = (over = {}) =>
  srv.call('/api/tickets', {
    method: 'POST',
    body: {
      device_id: 'dev-student', serial: '5CD1234ABC', asset_tag: 'PC-1042', model: 'Lenovo 300e',
      user_email: 'sam@example.org', user_name: 'Sam Smith', issue_category: 'Cracked screen',
      issue_description: 'Cracked lower right corner', notify: false, ...over,
    },
  });

// ---- loaner tag normalisation ----------------------------------------------

test('a scanned or typed tag is normalised to the house format', () => {
  assert.equal(google.normalizeLoanerTag('12'), 'Loaner-012');
  assert.equal(google.normalizeLoanerTag('loaner-12'), 'Loaner-012');
  assert.equal(google.normalizeLoanerTag('LOANER-012'), 'Loaner-012');
  assert.equal(google.normalizeLoanerTag('Loaner 7'), 'Loaner-007');
  assert.equal(google.normalizeLoanerTag('5CD1234ABC'), '5CD1234ABC', 'serials pass through');
});

test('searching 12 finds Loaner-012, not Loaner-120', async () => {
  const res = await srv.call('/api/loaners/search?q=12');
  assert.equal(res.status, 200);
  assert.equal(res.body.normalized, 'Loaner-012');
  assert.equal(res.body.devices[0].asset_tag, 'Loaner-012');
  assert.equal(res.body.devices[0].exact, true);
});

// ---- linking ----------------------------------------------------------------

test('a loaner is linked to the ticket like the repaired device is', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  const res = await srv.call(`/api/tickets/${id}/loaner`, { method: 'POST', body: { asset_tag: '12' } });
  assert.equal(res.status, 200);
  assert.equal(res.body.in_loaner_ou, true);

  const t = res.body.ticket;
  assert.equal(t.loaner_device_id, 'dev-loaner-12');
  assert.equal(t.loaner_asset_tag, 'Loaner-012');
  assert.equal(t.loaner_serial, 'LNR000012');
  assert.equal(t.loaner_model, 'Acer 511');
  assert.ok(t.loaner_issued_at);
  assert.equal(t.loaner_outstanding, true);
  assert.ok(t.events.some((e) => (e.body || '').includes('loaner issued: Loaner-012')));
});

test('a loaner tag typed on the new-ticket form is resolved to the real device', async () => {
  const { body } = await newTicket({ loaner_asset_tag: 'loaner-12' });
  const t = (await srv.call('/api/tickets/' + body.ticket.id)).body.ticket;
  assert.equal(t.loaner_device_id, 'dev-loaner-12');
  assert.equal(t.loaner_asset_tag, 'Loaner-012');
  assert.ok(t.loaner_issued_at);
});

test('an unknown loaner tag is a clear 404, not a silent link', async () => {
  const { body } = await newTicket();
  const res = await srv.call(`/api/tickets/${body.ticket.id}/loaner`, { method: 'POST', body: { asset_tag: '999' } });
  assert.equal(res.status, 404);
  assert.match(res.body.error, /Loaner-999/);
});

test('returning a loaner stamps the time and clears the outstanding flag', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  await srv.call(`/api/tickets/${id}/loaner`, { method: 'POST', body: { asset_tag: '12' } });
  const res = await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.ok(res.body.ticket.loaner_returned_at);
  assert.equal(res.body.ticket.loaner_outstanding, false);
  assert.equal(res.body.ticket.loaner_asset_tag, 'Loaner-012', 'the link stays as history');
});

test('emails mention the loaner while it is out, and stop once it is back', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  await srv.call(`/api/tickets/${id}/loaner`, { method: 'POST', body: { asset_tag: '12' } });

  const out = mailer.buildVars(tickets.get(id));
  assert.match(out.loaner_line, /Loaner-012/);
  assert.equal(out.loaner_asset_tag, 'Loaner-012');

  await srv.call(`/api/tickets/${id}/loaner/return`, { method: 'POST' });
  assert.equal(mailer.buildVars(tickets.get(id)).loaner_line, '');
});

test('the pickup email asks for the loaner back', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  await srv.call(`/api/tickets/${id}/loaner`, { method: 'POST', body: { asset_tag: '12' } });
  const preview = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: { status: 'ready_for_pickup' } })).body.preview;
  assert.match(preview.body, /bring loaner Loaner-012/i);
});

// ---- repair note written back to Google -------------------------------------

test('closing a ticket appends the repair to the device notes in Google', async () => {
  DEVICES['dev-student'].notes = 'Keyboard replaced 2025-09-02';
  const { body } = await newTicket();
  const id = body.ticket.id;
  const res = await srv.call('/api/tickets/' + id, {
    method: 'PATCH',
    body: { status: 'closed', repair_summary: 'Replaced LCD assembly and tested', notify: false },
  });

  assert.equal(res.body.repair_note.result, 'ok', JSON.stringify(res.body.repair_note));
  const line = res.body.repair_note.line;
  assert.match(line, /^\d{4}-\d{2}-\d{2} Ticket #\d+: Replaced LCD assembly and tested/);

  // the device keeps its old notes and gains ours
  assert.match(DEVICES['dev-student'].notes, /Keyboard replaced 2025-09-02/);
  assert.match(DEVICES['dev-student'].notes, /Replaced LCD assembly and tested/);

  const t = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.equal(t.repair_summary, 'Replaced LCD assembly and tested');
  assert.ok(t.repair_note_written_at);
  assert.ok(t.events.some((e) => (e.body || '').startsWith('wrote to Google Admin notes:')));
});

test('with no summary typed, a sensible one is built from the ticket', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  await srv.call(`/api/tickets/${id}/notes`, { method: 'POST', body: { body: 'Swapped the screen', notify: false } });
  const suggestion = (await srv.call(`/api/tickets/${id}/repair-note`)).body;
  assert.match(suggestion.summary, /Cracked screen - Swapped the screen/);
  assert.match(suggestion.preview, new RegExp(`Ticket #${id}`));

  const res = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'closed', notify: false } });
  assert.equal(res.body.repair_note.result, 'ok');
  assert.match(res.body.repair_note.line, /Cracked screen - Swapped the screen/);
});

test('a Google failure is reported but never blocks the close', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  failNextWrite = 'Quota exceeded';
  const res = await srv.call('/api/tickets/' + id, { method: 'PATCH', body: { status: 'closed', notify: false } });
  assert.equal(res.status, 200);
  assert.equal(res.body.ticket.status, 'closed', 'the ticket still closed');
  assert.equal(res.body.repair_note.result, 'error');
  assert.match(res.body.repair_note.error, /Quota exceeded/);
  const t = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.ok(t.events.some((e) => (e.body || '').includes('could not write the repair note')));
});

test('a ticket with no Google device just skips the write', async () => {
  const { body } = await newTicket({ device_id: null });
  const res = await srv.call('/api/tickets/' + body.ticket.id, { method: 'PATCH', body: { status: 'closed', notify: false } });
  assert.equal(res.body.ticket.status, 'closed');
  assert.equal(res.body.repair_note, null);
});

test('the notes field cannot grow past the limit: oldest lines drop first', async () => {
  DEVICES['dev-student'].notes = Array.from({ length: 12 }, (_, i) => `2020-01-${String(i + 1).padStart(2, '0')} old line number ${i} with padding text`).join('\n');
  const before = DEVICES['dev-student'].notes;
  assert.ok(before.length > 500);
  const { body } = await newTicket();
  await srv.call('/api/tickets/' + body.ticket.id, {
    method: 'PATCH',
    body: { status: 'closed', repair_summary: 'Newest repair', notify: false },
  });
  const after = DEVICES['dev-student'].notes;
  assert.ok(after.length <= 500, `notes should be trimmed, got ${after.length}`);
  assert.match(after, /Newest repair/, 'the new line survives');
  assert.ok(!after.includes('old line number 0'), 'the oldest line was dropped');
});

test('a newline in the summary cannot break the one-line-per-repair format', () => {
  const line = tickets.repairNoteLine({ id: 7, assigned_to: 'jacob' }, 'Replaced screen\nand keyboard\r\ntested', 'jacob');
  assert.ok(!/[\r\n]/.test(line));
  assert.match(line, /Replaced screen and keyboard tested \(jacob\)/);
});

// ---- themed templates -------------------------------------------------------

test('the shipped templates carry the school colours through render vars', async () => {
  const { body } = await newTicket();
  const preview = (await srv.call(`/api/tickets/${body.ticket.id}/email/preview`, { method: 'POST', body: {} })).body.preview;
  assert.match(preview.body, /#8A1538/, 'maroon header');
  assert.match(preview.body, /#ECAE12/, 'gold rule');
  assert.ok(!preview.body.includes('{{brand_primary}}'), 'placeholders must be substituted');
  assert.match(preview.subject, /We have your device/);
  assert.ok(!/<style|class=/.test(preview.body), 'email HTML stays inline-styled for mail clients');
});

test('resetting templates restores the shipped wording but keeps auto-send choices', async () => {
  await srv.call('/api/templates/closed', { method: 'PUT', body: { subject: 'mangled', body: '<p>mangled</p>', auto_send: true } });
  const res = await srv.call('/api/templates/reset', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.equal(res.body.changed, 16, 'ten status emails, three loaner reminders, three parts notices');

  const closed = (await srv.call('/api/templates')).body.templates.find((t) => t.status_key === 'closed');
  assert.equal(closed.subject, DEFAULT_TEMPLATES.closed.subject);
  assert.equal(closed.auto_send, 1, 'the auto-send switch the tech set is kept');
  assert.equal(getDb().prepare("SELECT COUNT(*) n FROM email_templates").get().n, 16);
});

test('resetTemplates can also restore the shipped auto-send defaults', () => {
  resetTemplates(undefined, { keepAutoSend: false });
  const closed = getDb().prepare("SELECT auto_send FROM email_templates WHERE status_key = 'closed'").get();
  assert.equal(closed.auto_send, DEFAULT_TEMPLATES.closed.auto_send);
});

test('an empty note leaves no dangling label in the email', async () => {
  const { body } = await newTicket();
  const id = body.ticket.id;
  const preview = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: {} })).body.preview;
  assert.ok(!/NOTE FROM US/i.test(preview.body), 'the note block should vanish when there is no note');
  assert.ok(!preview.body.includes('<!--if:'), 'section markers must not reach the recipient');

  const withNote = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: { note: 'Ordered a screen.' } })).body.preview;
  assert.match(withNote.body, /NOTE FROM US/i);
  assert.match(withNote.body, /Ordered a screen\./);
});

test('a ticket with no loaner has no loaner sentence at all', async () => {
  const { body } = await newTicket();
  const preview = (await srv.call(`/api/tickets/${body.ticket.id}/email/preview`, { method: 'POST', body: { status: 'ready_for_pickup' } })).body.preview;
  assert.ok(!/loaner/i.test(preview.body), preview.body.slice(0, 200));
});
