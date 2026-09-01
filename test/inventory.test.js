'use strict';
/** Parts on hand, donor devices, shipments, and what students are told. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer, startPublicServer } = require('./helpers');

isolate();
process.env.PUBLIC_SITE_URL = 'https://repairs.example.org';
// Explicit, so the suite does not depend on whatever .env happens to say.
process.env.LOANER_DIGEST_TO = 'helpdesk@example.org';
process.env.LOANER_DIGEST_ENABLED = 'true';

const inventory = require('../src/inventory');
const shipments = require('../src/shipments');
const loaners = require('../src/loaners');
const links = require('../src/lib/links');
const days = require('../src/lib/schooldays');
const { getDb } = require('../src/db');

let srv;
let site;
test.before(async () => { srv = await startServer(); site = await startPublicServer(); });
test.after(async () => { await srv.close(); await site.close(); });

const newTicket = (over = {}) =>
  srv.call('/api/tickets', {
    method: 'POST',
    body: {
      serial: 'SER1', asset_tag: 'PC-1', model: 'Lenovo 300e', user_email: 'sam@example.org',
      user_name: 'Sam Smith', issue_category: 'Cracked screen', issue_description: 'Cracked screen',
      notify: false, ...over,
    },
  });

const day = (n) => days.toDayString(new Date(Date.now() + n * 86400000));

// ---- items ------------------------------------------------------------------

test('a part can be added with a bin and a reorder point', async () => {
  const res = await srv.call('/api/inventory', {
    method: 'POST',
    body: { name: 'LCD 11.6 30-pin', part_number: 'LP116WH8', category: 'Screen',
            fits_models: 'Lenovo 300e', location: 'Bin A3', qty_on_hand: 4, reorder_point: 2 },
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.item.qty_on_hand, 4);
  assert.equal(res.body.item.low_stock, false);
  assert.equal(res.body.item.kind, 'part');

  // the opening count is a movement, so history starts from zero
  const detail = await srv.call('/api/inventory/' + res.body.item.id);
  assert.equal(detail.body.moves.length, 1);
  assert.equal(detail.body.moves[0].reason, 'receive');
  assert.equal(detail.body.moves[0].delta, 4);
});

test('a name is required', async () => {
  const res = await srv.call('/api/inventory', { method: 'POST', body: { qty_on_hand: 3 } });
  assert.equal(res.status, 400);
});

test('using parts on a ticket takes them off the shelf and onto the timeline', async () => {
  const { body: created } = await newTicket();
  const ticketId = created.ticket.id;
  const { body: made } = await srv.call('/api/inventory', {
    method: 'POST', body: { name: 'Keyboard 300e', location: 'Bin B1', qty_on_hand: 3, reorder_point: 1 },
  });

  const used = await srv.call(`/api/tickets/${ticketId}/parts`, { method: 'POST', body: { item_id: made.item.id, qty: 2 } });
  assert.equal(used.status, 200);
  assert.equal(used.body.item.qty_on_hand, 1);
  assert.equal(used.body.item.low_stock, true, '1 left with a reorder point of 1');

  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.ok(detail.events.some((e) => (e.body || '').includes('used 2 x Keyboard 300e from Bin B1')));
  assert.equal(detail.parts_used[0].qty, 2);
  assert.equal(detail.parts_used[0].direction, 'used');
});

test('you cannot use more than you have, and the count never goes negative', async () => {
  const { body: made } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Hinge left', qty_on_hand: 1 } });
  const { body: created } = await newTicket();
  const res = await srv.call(`/api/tickets/${created.ticket.id}/parts`, {
    method: 'POST', body: { item_id: made.item.id, qty: 5 },
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /Only 1 of Hinge left on hand/);
  assert.equal(inventory.get(made.item.id).qty_on_hand, 1);
});

test('a part fitted by mistake can go back on the shelf', async () => {
  const { body: made } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Charger 45W', qty_on_hand: 2 } });
  const { body: created } = await newTicket();
  const id = created.ticket.id;
  await srv.call(`/api/tickets/${id}/parts`, { method: 'POST', body: { item_id: made.item.id, qty: 1 } });
  const back = await srv.call(`/api/tickets/${id}/parts`, { method: 'POST', body: { item_id: made.item.id, qty: 1, direction: 'return' } });
  assert.equal(back.body.item.qty_on_hand, 2);
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  assert.ok(detail.events.some((e) => (e.body || '').includes('returned 1 x Charger 45W to stock')));
});

test('a donor device lives in the same list and records what was taken', async () => {
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'LCD 11.6', qty_on_hand: 0 } });
  const { body: donor } = await srv.call('/api/inventory', {
    method: 'POST',
    body: { kind: 'donor_device', name: 'Lenovo 300e donor', serial: 'DONOR1', asset_tag: 'PC-9001', qty_on_hand: 1 },
  });
  assert.equal(donor.item.donor_status, 'intact');

  const res = await srv.call(`/api/inventory/${donor.item.id}/harvest`, {
    method: 'POST', body: { part_item_id: part.item.id, qty: 1, what: 'LCD panel' },
  });
  assert.equal(res.body.donor.donor_status, 'harvested');
  assert.equal(res.body.part.qty_on_hand, 1, 'the harvested part landed in stock');

  const donorMoves = (await srv.call('/api/inventory/' + donor.item.id)).body.moves;
  assert.ok(donorMoves.some((m) => m.reason === 'harvest' && /LCD panel/.test(m.note)));

  const partMoves = (await srv.call('/api/inventory/' + part.item.id)).body.moves;
  assert.ok(partMoves.some((m) => m.reason === 'harvest' && /DONOR|donor/.test(m.note)));
});

test('a part with history is archived rather than deleted', async () => {
  const { body: made } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Speaker pair', qty_on_hand: 1 } });
  const res = await srv.call('/api/inventory/' + made.item.id, { method: 'DELETE' });
  assert.deepEqual(res.body, { archived: true });
  const list = await srv.call('/api/inventory');
  assert.ok(!list.body.items.some((i) => i.id === made.item.id), 'archived items drop out of the list');
  assert.ok(inventory.get(made.item.id), 'but the row and its history survive');
});

test('the inventory page reports low stock and what is running out', async () => {
  const res = await srv.call('/api/inventory?low=1');
  assert.ok(res.body.stats.part_lines >= 4);
  assert.ok(res.body.stats.low_stock >= 1);
  assert.ok(res.body.stats.used_last_30_days >= 3);
  assert.ok(res.body.items.every((i) => i.low_stock || i.out_of_stock));
});

// ---- shipments --------------------------------------------------------------

test('a carrier is recognised from the tracking number', () => {
  assert.equal(shipments.detectCarrier('1Z999AA10123456784'), 'ups');
  assert.equal(shipments.detectCarrier('9400111899223197428490'), 'usps');
  assert.equal(shipments.detectCarrier('TBA123456789012'), 'amazon');
  assert.equal(shipments.detectCarrier('123456789012'), 'fedex');
  assert.equal(shipments.detectCarrier('not a tracking number'), null);
  assert.match(shipments.trackingUrl(null, '1Z999AA10123456784'), /ups\.com/);
  assert.equal(shipments.trackingUrl('other', 'ABC'), null);
});

test('a shipment carries lines for several tickets', async () => {
  const a = (await newTicket()).body.ticket.id;
  const b = (await newTicket({ user_email: 'alex@example.org', user_name: 'Alex Jones' })).body.ticket.id;
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'LCD 11.6 IPS', qty_on_hand: 0 } });

  const res = await srv.call('/api/shipments', {
    method: 'POST',
    body: {
      vendor: 'PartsPeople', tracking_number: '1Z999AA10123456784', expected_day: day(3),
      lines: [
        { item_id: part.item.id, qty: 2, ticket_id: a },
        { description: 'Hinge set for #' + b, qty: 1, ticket_id: b },
      ],
    },
  });
  assert.equal(res.status, 201);
  const shipment = res.body.shipment;
  assert.equal(shipment.carrier, 'ups', 'carrier detected from the tracking number');
  assert.match(shipment.tracking_url, /ups\.com/);
  assert.equal(shipment.status, 'ordered');
  assert.deepEqual(shipment.ticket_ids.sort(), [a, b].sort());
  assert.equal(shipment.lines.length, 2);
});

test('marking a shipment shipped tells the waiting students once', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'PartsPeople', lines: [{ description: 'Screen for #' + ticketId, qty: 1, ticket_id: ticketId }] },
  });

  const res = await srv.call(`/api/shipments/${made.shipment.id}/shipped`, {
    method: 'POST', body: { expected_day: day(2), notify: true },
  });
  assert.equal(res.body.shipment.status, 'shipped');
  assert.equal(res.body.notices.sent.length, 1);

  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  const mail = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.match(mail.subject, /have shipped/i);
  assert.match(mail.body, /expected/i);
  assert.ok(!/1Z999|tracking/i.test(mail.body), 'students never see carrier or tracking details');

  // saving again must not re-send
  const again = await srv.call(`/api/shipments/${made.shipment.id}/shipped`, { method: 'POST', body: { notify: true } });
  assert.equal(again.body.notices.sent.length, 0);
  assert.equal(again.body.notices.skipped[0].reason, 'already_told');
});

test('notify:false stays quiet', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST', body: { lines: [{ description: 'Battery', qty: 1, ticket_id: ticketId }] },
  });
  const res = await srv.call(`/api/shipments/${made.shipment.id}/shipped`, {
    method: 'POST', body: { expected_day: day(1), notify: false },
  });
  assert.equal(res.body.notices.sent.length, 0);
  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.equal(detail.emails.length, 0);
});

test('receiving a shipment adds stock, marks it arrived and tells the students', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Trackpad 300e', qty_on_hand: 0 } });
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'PartsPeople', expected_day: day(1), lines: [{ item_id: part.item.id, qty: 3, ticket_id: ticketId }] },
  });

  const res = await srv.call(`/api/shipments/${made.shipment.id}/receive`, { method: 'POST', body: { notify: true } });
  assert.equal(res.body.shipment.status, 'arrived');
  assert.ok(res.body.shipment.received_at);
  assert.equal(inventory.get(part.item.id).qty_on_hand, 3);
  assert.equal(res.body.notices.sent.length, 1);

  const moves = (await srv.call('/api/inventory/' + part.item.id)).body.moves;
  assert.ok(moves.some((m) => m.reason === 'receive' && /PartsPeople/.test(m.note)));

  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.ok(detail.events.some((e) => (e.body || '').includes('parts arrived')));
  assert.match(detail.emails[0].subject, /Parts are here/i);
});

test('a short delivery only adds what actually turned up', async () => {
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Bezel', qty_on_hand: 0 } });
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST', body: { lines: [{ item_id: part.item.id, qty: 5 }] },
  });
  const lineId = made.shipment.lines[0].id;
  await srv.call(`/api/shipments/${made.shipment.id}/receive`, {
    method: 'POST', body: { lines: [{ id: lineId, received_qty: 2 }], notify: false },
  });
  assert.equal(inventory.get(part.item.id).qty_on_hand, 2);
  const shipment = (await srv.call('/api/shipments/' + made.shipment.id)).body.shipment;
  assert.equal(shipment.lines[0].received_qty, 2);
});

// ---- what the student sees --------------------------------------------------

test('the expectation sentence is plain English and hides logistics', () => {
  const base = { status: 'shipped', expected_day: day(0) };
  assert.match(shipments.expectationSentence({ ...base }), /expected to arrive today/);
  assert.match(shipments.expectationSentence({ ...base, expected_day: day(1) }), /expected tomorrow/);
  assert.match(shipments.expectationSentence({ ...base, expected_day: day(4) }), /have shipped and are expected/);
  assert.match(shipments.expectationSentence({ ...base, expected_day: day(-2) }), /have not turned up/);
  assert.match(shipments.expectationSentence({ status: 'ordered', expected_day: null }), /on order/);
  assert.match(shipments.expectationSentence({ status: 'arrived' }), /have arrived/);
  assert.equal(shipments.expectationSentence({ status: 'cancelled' }), '');
});

test('the waiting-on-parts email fills in the expected day by itself', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST', body: { lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  await srv.call(`/api/shipments/${made.shipment.id}/shipped`, { method: 'POST', body: { expected_day: day(3), notify: false } });

  const preview = (await srv.call(`/api/tickets/${ticketId}/email/preview`, {
    method: 'POST', body: { status: 'waiting_on_parts' },
  })).body.preview;
  assert.match(preview.body, /have shipped and are expected/);
  assert.ok(!preview.body.includes('{{parts_expected_line}}'));
});

test('the public status page shows the expectation, never the tracking number', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { tracking_number: '1Z999AA10123456784', vendor: 'PartsPeople',
            lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  await srv.call(`/api/shipments/${made.shipment.id}/shipped`, { method: 'POST', body: { expected_day: day(2), notify: false } });
  await srv.call('/api/tickets/' + ticketId, { method: 'PATCH', body: { status: 'waiting_on_parts', notify: false } });

  const html = await (await fetch(site.base + '/t/' + links.mint('t', ticketId))).text();
  assert.match(html, /have shipped and are expected/);
  assert.ok(!html.includes('1Z999AA10123456784'), 'no tracking number on the public page');
  assert.ok(!/PartsPeople/.test(html), 'no vendor on the public page');
});

// ---- the daily pass ---------------------------------------------------------

test('parts due today get one nudge, and late ones reach the digest', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: dueToday } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'Today Co', status: 'shipped', expected_day: day(0),
            lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  const lateTicket = (await newTicket({ user_email: 'late@example.org' })).body.ticket.id;
  await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'Slow Co', status: 'shipped', expected_day: day(-5),
            lines: [{ description: 'Keyboard', qty: 1, ticket_id: lateTicket }] },
  });

  const pass = await shipments.dailyPass({});
  assert.ok(pass.arriving_today.includes(dueToday.shipment.id));
  assert.equal(pass.sent.length, 1);
  assert.equal(pass.late.length, 1);
  assert.equal(pass.late[0].vendor, 'Slow Co');

  // second run the same day: nothing repeated
  const again = await shipments.dailyPass({});
  assert.equal(again.sent.length, 0);

  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  assert.match(detail.emails[0].subject, /should arrive today/i);
});

test('the loaner digest also lists parts that are late', async () => {
  const res = await loaners.runReminders({ reason: 'test' });
  assert.ok(res.parts, 'the daily pass covers parts too');
  assert.equal(res.digest.result, 'dry_run');
  const logged = (await srv.call('/api/emails?limit=10')).body.emails.find((e) => e.status_key === 'loaner_digest');
  const full = (await srv.call('/api/emails/' + logged.id)).body.email;
  assert.match(full.body, /Parts overdue to arrive/);
  assert.match(full.body, /Slow Co/);
  assert.match(logged.subject, /parts late/);
});

test('a ticket shows what it is waiting for and what went into it', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Palmrest', qty_on_hand: 1 } });
  await srv.call(`/api/tickets/${ticketId}/parts`, { method: 'POST', body: { item_id: part.item.id, qty: 1 } });
  await srv.call('/api/shipments', {
    method: 'POST', body: { vendor: 'X', expected_day: day(2), lines: [{ description: 'Cable', qty: 1, ticket_id: ticketId }] },
  });

  const res = await srv.call(`/api/tickets/${ticketId}/parts`);
  assert.equal(res.body.used.length, 1);
  assert.equal(res.body.used[0].name, 'Palmrest');
  assert.equal(res.body.incoming.length, 1);
  assert.equal(res.body.incoming[0].lines[0].description, 'Cable');
});

test('a ticket distinguishes parts fitted from parts that merely arrived', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: part } = await srv.call('/api/inventory', { method: 'POST', body: { name: 'Fan', qty_on_hand: 0 } });
  const { body: made } = await srv.call('/api/shipments', {
    method: 'POST', body: { vendor: 'V', lines: [{ item_id: part.item.id, qty: 2, ticket_id: ticketId }] },
  });
  await srv.call(`/api/shipments/${made.shipment.id}/receive`, { method: 'POST', body: { notify: false } });
  await srv.call(`/api/tickets/${ticketId}/parts`, { method: 'POST', body: { item_id: part.item.id, qty: 1 } });

  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  const fitted = detail.parts_used.filter((p) => p.fitted);
  const arrived = detail.parts_used.filter((p) => p.direction === 'arrived for this ticket');
  assert.equal(fitted.length, 1);
  assert.equal(fitted[0].qty, 1);
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].qty, 2);
  assert.equal(detail.parts_used[0].fitted, true, 'fitted parts sort first');
  assert.ok(!detail.parts_used.some((p) => p.direction === 'returned to stock'), 'a receipt is not a return');
});

test('a donor harvest reads as a harvest on the ticket, not a return', async () => {
  const ticketId = (await newTicket()).body.ticket.id;
  const { body: donor } = await srv.call('/api/inventory', {
    method: 'POST', body: { kind: 'donor_device', name: 'Donor 500e', asset_tag: 'PC-9100', qty_on_hand: 1 },
  });
  await srv.call(`/api/inventory/${donor.item.id}/harvest`, {
    method: 'POST', body: { what: 'hinge set', ticket_id: ticketId },
  });
  const detail = (await srv.call('/api/tickets/' + ticketId)).body.ticket;
  const row = detail.parts_used.find((p) => p.item_id === donor.item.id);
  assert.equal(row.direction, 'harvested');
  assert.equal(row.qty, null, 'a harvest log has no count of its own');
  assert.match(row.note, /hinge set/);
});
