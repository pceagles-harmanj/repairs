'use strict';
/**
 * Automatic carrier tracking: statuses follow the carrier, delivered is not the
 * same as received, and nothing emails a student about a truck.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer, startPublicServer } = require('./helpers');

isolate();
process.env.TRACKING_PROVIDER = 'mock';
process.env.TRACKING_POLL_MINUTES = '60';
process.env.PUBLIC_SITE_URL = 'https://repairs.example.org';

const tracking = require('../src/tracking');
const mock = require('../src/tracking/providers/mock');
const shipments = require('../src/shipments');
const inventory = require('../src/inventory');
const links = require('../src/lib/links');
const { getDb } = require('../src/db');

let srv;
let site;
test.before(async () => { srv = await startServer(); site = await startPublicServer(); });
test.after(async () => { await srv.close(); await site.close(); });
test.beforeEach(() => mock.clear());

const iso = (n) => new Date(Date.now() + n * 3600000).toISOString();

const newTicket = () =>
  srv.call('/api/tickets', {
    method: 'POST',
    body: { serial: 'S1', asset_tag: 'PC-1', model: 'Lenovo 300e', user_email: 'sam@example.org',
            user_name: 'Sam Smith', issue_description: 'Cracked screen', notify: false },
  });

async function makeShipment({ tracking_number: tn = '1Z999AA10123456784', ticketId = null } = {}) {
  const { body } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'PartsPeople', tracking_number: tn,
            lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  return body.shipment;
}

const emailCount = () => getDb().prepare('SELECT COUNT(*) AS n FROM email_log').get().n;

// ---- status mapping ---------------------------------------------------------

test('an in-transit scan moves the shipment to shipped', async () => {
  const s = await makeShipment();
  mock.queue(s.tracking_number, {
    status: 'in_transit',
    events: [{ status: 'in_transit', code: 'InTransit', description: 'Departed facility', location: 'Memphis, TN', happened_at: iso(-5) }],
  });
  const res = await tracking.pollOne(s.id);
  assert.equal(res.result, 'ok');
  assert.equal(res.from, 'ordered');
  assert.equal(res.to, 'shipped');
  assert.equal(res.new_events, 1);

  const after = shipments.get(s.id);
  assert.equal(after.status, 'shipped');
  assert.equal(after.tracking_status, 'in_transit');
  assert.equal(after.tracking_label, 'In transit');
  assert.ok(after.shipped_at, 'the shipped stamp is filled in');
  assert.equal(after.tracking_events.length, 1);
});

test('out for delivery is stamped and reads as such', async () => {
  const s = await makeShipment({ tracking_number: 'OFD1' });
  mock.queue('OFD1', {
    status: 'out_for_delivery',
    events: [{ status: 'out_for_delivery', description: 'On vehicle for delivery', happened_at: iso(-2) }],
  });
  await tracking.pollOne(s.id);
  const after = shipments.get(s.id);
  assert.equal(after.status, 'shipped', 'still shipped as far as the queue is concerned');
  assert.equal(after.tracking_status, 'out_for_delivery');
  assert.ok(after.out_for_delivery_at);
  assert.match(after.expectation, /out for delivery today/i);
});

test('delivered is NOT received: status becomes delivered and stock is untouched', async () => {
  const { body: created } = await newTicket();
  const ticketId = created.ticket.id;
  const item = inventory.create({ name: 'Screen 11.6', qty_on_hand: 0 });
  const { body } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { tracking_number: 'DLV1', lines: [{ item_id: item.id, qty: 2, ticket_id: ticketId }] },
  });
  const s = body.shipment;

  mock.queue('DLV1', {
    status: 'delivered',
    events: [{ status: 'delivered', description: 'Delivered, front office', happened_at: iso(-1) }],
  });
  await tracking.pollOne(s.id);

  const after = shipments.get(s.id);
  assert.equal(after.status, 'delivered');
  assert.ok(after.delivered_at);
  assert.equal(after.received_at, null);
  assert.equal(after.delivered_not_received, true);
  assert.equal(inventory.get(item.id).qty_on_hand, 0, 'delivered must not add stock');
  assert.match(after.expectation, /delivered to the school .*waiting to be checked in/i);

  // and receiving is still the human step that adds stock
  await srv.call(`/api/shipments/${s.id}/receive`, { method: 'POST', body: { notify: false } });
  assert.equal(inventory.get(item.id).qty_on_hand, 2);
  assert.equal(shipments.get(s.id).status, 'arrived');
});

test('a failed attempt marks the shipment delayed', async () => {
  const s = await makeShipment({ tracking_number: 'EXC1' });
  mock.queue('EXC1', { status: 'exception', events: [{ status: 'exception', description: 'Delivery attempted, no access', happened_at: iso(-3) }] });
  await tracking.pollOne(s.id);
  const after = shipments.get(s.id);
  assert.equal(after.status, 'delayed');
  assert.match(after.expectation, /snag with the carrier/i);
});

test('a late in-transit scan cannot un-deliver a package', async () => {
  const s = await makeShipment({ tracking_number: 'ORD1' });
  mock.queue('ORD1', { status: 'delivered', events: [{ status: 'delivered', description: 'Delivered', happened_at: iso(-2) }] });
  await tracking.pollOne(s.id);
  assert.equal(shipments.get(s.id).status, 'delivered');

  mock.queue('ORD1', { status: 'in_transit', events: [{ status: 'in_transit', description: 'Stray scan', happened_at: iso(-1) }] });
  await tracking.pollOne(s.id);
  assert.equal(shipments.get(s.id).status, 'delivered', 'status must not walk backwards');
});

test('a status a human owns is never overwritten', async () => {
  const s = await makeShipment({ tracking_number: 'HUM1' });
  await srv.call(`/api/shipments/${s.id}/receive`, { method: 'POST', body: { notify: false } });
  mock.queue('HUM1', { status: 'in_transit', events: [{ status: 'in_transit', description: 'Late scan', happened_at: iso(-1) }] });
  const res = await tracking.pollOne(s.id);
  assert.equal(res.result, 'skipped');
  assert.equal(res.reason, 'closed', 'a received shipment is not polled at all');
  assert.equal(shipments.get(s.id).status, 'arrived');
});

test("the carrier's ETA updates the expected day", async () => {
  const s = await makeShipment({ tracking_number: 'ETA1' });
  mock.queue('ETA1', { status: 'in_transit', eta_day: '2026-09-10', events: [] });
  const res = await tracking.pollOne(s.id);
  assert.equal(res.expected_day, '2026-09-10');
  const after = shipments.get(s.id);
  assert.equal(after.expected_day, '2026-09-10');
  assert.equal(after.carrier_eta_day, '2026-09-10');
});

// ---- the quiet part ---------------------------------------------------------

test('tracking updates never email anybody', async () => {
  const { body: created } = await newTicket();
  const s = await makeShipment({ tracking_number: 'QUIET1', ticketId: created.ticket.id });
  const before = emailCount();

  for (const status of ['pre_transit', 'in_transit', 'out_for_delivery', 'delivered']) {
    mock.queue('QUIET1', { status, events: [{ status, description: status, happened_at: iso(-1) }] });
    await tracking.pollOne(s.id);
  }
  assert.equal(emailCount(), before, 'not one email from four carrier movements');

  // but the tech-visible timeline does record it
  const detail = (await srv.call('/api/tickets/' + created.ticket.id)).body.ticket;
  assert.ok(detail.events.some((e) => (e.body || '').startsWith('carrier tracking:')));
});

test('a package already delivered gets no "arriving today" nudge', async () => {
  const { body: created } = await newTicket();
  const today = new Date();
  const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const { body } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { tracking_number: 'TODAY1', status: 'shipped', expected_day: day,
            lines: [{ description: 'Screen', qty: 1, ticket_id: created.ticket.id }] },
  });
  mock.queue('TODAY1', { status: 'delivered', events: [{ status: 'delivered', description: 'Delivered', happened_at: iso(-1) }] });
  await tracking.pollOne(body.shipment.id);

  const pass = await shipments.dailyPass({});
  assert.ok(!pass.arriving_today.includes(body.shipment.id), 'already on the doorstep');
  assert.equal(pass.sent.length, 0);
});

// ---- polling behaviour ------------------------------------------------------

test('polling respects the interval, and force overrides it', async () => {
  const s = await makeShipment({ tracking_number: 'POLL1' });
  mock.queue('POLL1', { status: 'in_transit', events: [] });
  await tracking.pollOne(s.id);

  assert.equal(tracking.dueForPoll({}).some((r) => r.id === s.id), false, 'just polled, not due again');
  assert.equal(tracking.dueForPoll({ force: true }).some((r) => r.id === s.id), true);
});

test('nothing is polled outside the configured hours', () => {
  const at = (h) => { const d = new Date(); d.setHours(h, 0, 0, 0); return d; };
  assert.equal(tracking.withinActiveHours(at(9)), true);
  assert.equal(tracking.withinActiveHours(at(2)), false, '2am is exactly the point');
  assert.equal(tracking.withinActiveHours(at(23)), false);
});

test('a provider failure is recorded, not thrown, and does not wreck the shipment', async () => {
  const s = await makeShipment({ tracking_number: 'ERR1' });
  mock.queue('ERR1', new Error('AfterShip: rate limit reached'));
  const res = await tracking.pollOne(s.id);
  assert.equal(res.result, 'error');
  assert.match(res.error, /rate limit/);
  const after = shipments.get(s.id);
  assert.match(after.tracking_error, /rate limit/);
  assert.equal(after.status, 'ordered', 'left as it was');
  assert.equal(tracking.status().with_errors >= 1, true);
});

test('duplicate scans are not stored twice', async () => {
  const s = await makeShipment({ tracking_number: 'DUP1' });
  const event = { status: 'in_transit', description: 'Arrived at facility', happened_at: iso(-4) };
  mock.queue('DUP1', { status: 'in_transit', events: [event] });
  const first = await tracking.pollOne(s.id);
  mock.queue('DUP1', { status: 'in_transit', events: [event, { ...event, description: 'Departed facility', happened_at: iso(-3) }] });
  const second = await tracking.pollOne(s.id);
  assert.equal(first.new_events, 1);
  assert.equal(second.new_events, 1, 'only the genuinely new scan');
  assert.equal(tracking.events(s.id).length, 2);
});

test('the whole thing is a no-op when no provider is configured', async () => {
  const saved = process.env.TRACKING_PROVIDER;
  const config = require('../src/config');
  config.tracking.provider = 'none';
  const res = await tracking.poll({ force: true, respectHours: false });
  assert.equal(res.skipped, 'tracking_disabled');
  assert.equal(tracking.enabled(), false);
  config.tracking.provider = saved;
});

// ---- what the student sees --------------------------------------------------

test('the public page shows parts milestones and the delivered-not-received line', async () => {
  const { body: created } = await newTicket();
  const ticketId = created.ticket.id;
  const { body } = await srv.call('/api/shipments', {
    method: 'POST',
    body: { vendor: 'PartsPeople', tracking_number: 'PUB1',
            lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  mock.queue('PUB1', {
    status: 'delivered',
    events: [
      { status: 'in_transit', description: 'Departed Memphis, TN', location: 'Memphis, TN', happened_at: iso(-30) },
      { status: 'out_for_delivery', description: 'On vehicle', location: 'Pella, IA', happened_at: iso(-6) },
      { status: 'delivered', description: 'Left at front office', location: 'Pella, IA', happened_at: iso(-2) },
    ],
  });
  await tracking.pollOne(body.shipment.id);
  await srv.call('/api/tickets/' + ticketId, { method: 'PATCH', body: { status: 'waiting_on_parts', notify: false } });

  const html = await (await fetch(site.base + '/t/' + links.mint('t', ticketId))).text();
  assert.match(html, /Parts for this repair/);
  assert.match(html, /Parts shipped/);
  assert.match(html, /Delivered to school/);
  assert.match(html, /waiting to be checked in/i);
  assert.match(html, /Checked in by the technology office/);

  // and none of the logistics
  assert.ok(!/PUB1/.test(html), 'no tracking number');
  assert.ok(!/Memphis/.test(html), 'no carrier locations');
  assert.ok(!/PartsPeople/.test(html), 'no vendor');
  assert.ok(!/aftership|ups|fedex/i.test(html), 'no carrier names');
});

test('techs do get the detail: scans with locations on the shipment', async () => {
  const s = await makeShipment({ tracking_number: 'TECH1' });
  mock.queue('TECH1', {
    status: 'in_transit',
    events: [{ status: 'in_transit', description: 'Departed facility', location: 'Memphis, TN', happened_at: iso(-4) }],
  });
  await tracking.pollOne(s.id);
  const res = await srv.call('/api/shipments/' + s.id);
  const events = res.body.shipment.tracking_events;
  assert.equal(events.length, 1);
  assert.equal(events[0].location, 'Memphis, TN');
  assert.equal(res.body.shipment.tracking_label, 'In transit');
});

test('the refresh-tracking endpoint works from the UI', async () => {
  const s = await makeShipment({ tracking_number: 'BTN1' });
  mock.queue('BTN1', { status: 'in_transit', events: [{ status: 'in_transit', description: 'Scan', happened_at: iso(-1) }] });
  const res = await srv.call(`/api/shipments/${s.id}/track`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(res.body.result, 'ok');
  assert.equal(res.body.shipment.status, 'shipped');
  assert.equal(res.body.tracking.provider, 'mock');
});

test('a parcel first seen as delivered still shows a shipped stage', async () => {
  const s = await makeShipment({ tracking_number: 'LATE1' });
  mock.queue('LATE1', {
    status: 'delivered',
    events: [
      { status: 'in_transit', description: 'Departed', happened_at: iso(-30) },
      { status: 'delivered', description: 'Delivered', happened_at: iso(-2) },
    ],
  });
  await tracking.pollOne(s.id);
  const after = shipments.get(s.id);
  assert.ok(after.shipped_at, 'shipped_at is backfilled from the first movement scan');

  const stages = Object.fromEntries(after.milestones.map((m) => [m.key, m]));
  assert.equal(stages.shipped.done, true);
  assert.equal(stages.delivered.done, true);
  assert.equal(stages.received.done, false);
  assert.equal(stages.out_for_delivery.done, false);
  assert.equal(stages.out_for_delivery.skipped, true, 'a stage the carrier never reported is skipped, not pending');
  assert.equal(stages.received.skipped, false, 'a stage still ahead of us is not skipped');
});

test('the progress list on the public page is in time order', async () => {
  const { body: created } = await newTicket();
  const ticketId = created.ticket.id;
  const { body } = await srv.call('/api/shipments', {
    method: 'POST', body: { tracking_number: 'ORDER1', lines: [{ description: 'Screen', qty: 1, ticket_id: ticketId }] },
  });
  mock.queue('ORDER1', {
    status: 'delivered',
    events: [
      { status: 'in_transit', description: 'Departed', happened_at: iso(-50) },
      { status: 'out_for_delivery', description: 'On vehicle', happened_at: iso(-8) },
      { status: 'delivered', description: 'Delivered', happened_at: iso(-2) },
    ],
  });
  await tracking.pollOne(body.shipment.id);

  const html = await (await fetch(site.base + '/t/' + links.mint('t', ticketId))).text();
  const progress = html.slice(html.indexOf('<h2>Progress</h2>'), html.indexOf('Parts for this repair'));
  const order = [...progress.matchAll(/<li[^>]*>\s*([^<]+?)\s*<span/g)].map((m) => m[1].trim());
  const pos = (label) => order.findIndex((l) => l === label);
  assert.ok(pos('Parts shipped') < pos('Out for delivery'), order.join(' -> '));
  assert.ok(pos('Out for delivery') < pos('Delivered to school'), order.join(' -> '));
  assert.ok(!/not yet/.test(progress), 'the merged list only shows stages that happened');
});

// ---- UPS directly, which costs nothing -------------------------------------

/**
 * config is read at require time, so credentials must be in place before the
 * provider loads - and taken back out afterwards, or the "no provider
 * configured" test above starts seeing a UPS provider.
 */
function withUps(fn) {
  const before = { id: process.env.UPS_CLIENT_ID, secret: process.env.UPS_CLIENT_SECRET };
  process.env.UPS_CLIENT_ID = 'test-client';
  process.env.UPS_CLIENT_SECRET = 'test-secret';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/tracking/providers/ups')];
  const ups = require('../src/tracking/providers/ups');
  const restore = () => {
    if (before.id === undefined) delete process.env.UPS_CLIENT_ID; else process.env.UPS_CLIENT_ID = before.id;
    if (before.secret === undefined) delete process.env.UPS_CLIENT_SECRET; else process.env.UPS_CLIENT_SECRET = before.secret;
    delete require.cache[require.resolve('../src/config')];
    delete require.cache[require.resolve('../src/tracking/providers/ups')];
  };
  return Promise.resolve(fn(ups)).finally(restore);
}

test('UPS status types map onto our own small vocabulary', () => {
  const { fromUpsStatus } = require('../src/tracking/statuses');
  assert.equal(fromUpsStatus({ type: 'M', description: 'Shipper created a label' }), 'pre_transit');
  assert.equal(fromUpsStatus({ type: 'I', description: 'Departed from facility' }), 'in_transit');
  assert.equal(fromUpsStatus({ type: 'O', description: 'Out for delivery' }), 'out_for_delivery');
  assert.equal(fromUpsStatus({ type: 'D', description: 'Delivered' }), 'delivered');
  assert.equal(fromUpsStatus({ type: 'X', description: 'Exception' }), 'exception');
  assert.equal(fromUpsStatus(null), 'unknown');

  // An unknown type falls back to the words rather than giving up.
  assert.equal(fromUpsStatus({ type: 'ZZ', description: 'Delivered to the dock' }), 'delivered');
  assert.equal(fromUpsStatus({ type: 'ZZ', description: 'Arrived at facility' }), 'in_transit');
  assert.equal(fromUpsStatus({ type: 'ZZ', description: 'Who knows' }), 'unknown');
});

test('UPS date and time strings become one timestamp', () => {
  const ups = require('../src/tracking/providers/ups');
  assert.equal(ups.stamp('20260903', '141500'), '2026-09-03T14:15:00');
  // Missing time is midday, not midnight: it stops a scan sorting into yesterday.
  assert.equal(ups.stamp('20260903', null), '2026-09-03T12:00:00');
  assert.equal(ups.stamp(null, '141500'), null);
  assert.equal(ups.dayOf('20260903'), '2026-09-03');
});

test('a UPS response turns into events and a status', async () => withUps(async (ups) => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        trackResponse: {
          shipment: [{
            package: [{
              trackingNumber: '1Z999AA10123456784',
              currentStatus: { type: 'O', description: 'Out For Delivery Today' },
              deliveryDate: [{ type: 'SDD', date: '20260904' }],
              activity: [
                { status: { type: 'O', description: 'Out For Delivery Today' }, date: '20260904', time: '060000',
                  location: { address: { city: 'Des Moines', stateProvince: 'IA', countryCode: 'US' } } },
                { status: { type: 'I', description: 'Arrived at Facility' }, date: '20260903', time: '231200',
                  location: { address: { city: 'Cedar Rapids', stateProvince: 'IA', countryCode: 'US' } } },
              ],
            }],
          }],
        },
      }),
    };
  };
  try {
    const out = await ups.fetchTracking({ trackingNumber: '1Z999AA10123456784' });
    assert.equal(out.status, 'out_for_delivery');
    assert.equal(out.eta_day, '2026-09-04');
    assert.equal(out.events.length, 2);
    assert.equal(out.events[0].location, 'Des Moines, IA, US');
    assert.equal(out.events[1].happened_at, '2026-09-03T23:12:00');
    assert.equal(out.raw_slug, 'ups');
  } finally {
    global.fetch = realFetch;
  }
}));

test('a label UPS has not scanned yet is pre-transit, not an error', async () => withUps(async (ups) => {
  const realFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('/oauth/token')) {
      return { ok: true, status: 200, text: async () => JSON.stringify({ access_token: 'tok', expires_in: 3600 }) };
    }
    return {
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ response: { errors: [{ code: '404', message: 'No tracking information available' }] } }),
    };
  };
  try {
    const out = await ups.fetchTracking({ trackingNumber: '1Z999AA10123456784' });
    assert.equal(out.status, 'pre_transit', 'a fresh label is not a failure');
    assert.deepEqual(out.events, []);
  } finally {
    global.fetch = realFetch;
  }
}));
