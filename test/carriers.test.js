'use strict';
/**
 * Four carriers, three free APIs, and one that has none.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate } = require('./helpers');

isolate();

const { detectCarrier } = require('../src/tracking/carriers');
const statuses = require('../src/tracking/statuses');

/** Load the dispatcher with a chosen set of carrier credentials in place. */
function withCreds(env, fn) {
  const keys = ['UPS_CLIENT_ID', 'UPS_CLIENT_SECRET', 'FEDEX_CLIENT_ID', 'FEDEX_CLIENT_SECRET',
    'USPS_CLIENT_ID', 'USPS_CLIENT_SECRET'];
  const before = {};
  for (const k of keys) before[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  Object.assign(process.env, env);
  const drop = () => {
    for (const m of ['../src/config', '../src/tracking/providers/multi', '../src/tracking/providers/ups',
      '../src/tracking/providers/fedex', '../src/tracking/providers/usps']) {
      delete require.cache[require.resolve(m)];
    }
  };
  drop();
  const multi = require('../src/tracking/providers/multi');
  const restore = () => {
    for (const k of keys) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
    drop();
  };
  return Promise.resolve(fn(multi)).finally(restore);
}

const ALL = {
  UPS_CLIENT_ID: 'u', UPS_CLIENT_SECRET: 'u',
  FEDEX_CLIENT_ID: 'f', FEDEX_CLIENT_SECRET: 'f',
  USPS_CLIENT_ID: 's', USPS_CLIENT_SECRET: 's',
};

// ---- who is this parcel with -----------------------------------------------

test('each carrier is recognised from the number alone', () => {
  assert.equal(detectCarrier('1Z999AA10123456784'), 'ups');
  assert.equal(detectCarrier('9400 1118 9922 3033 0052 82'), 'usps');
  assert.equal(detectCarrier('EC123456789US'), 'usps');
  assert.equal(detectCarrier('779879671234'), 'fedex');
  assert.equal(detectCarrier('TBA303177217654'), 'amazon');
  assert.equal(detectCarrier('what is this'), null);
});

test('the tracking number outranks the carrier written on the shipment', () =>
  withCreds(ALL, (multi) => {
    // Amazon very often hands the parcel to UPS, and the vendor still says
    // "Amazon" on the order. The 1Z number is the harder fact.
    assert.equal(multi.carrierFor({ carrier: 'amazon', trackingNumber: '1Z999AA10123456784' }), 'ups');
    assert.equal(multi.carrierFor({ carrier: 'ups', trackingNumber: '9400111899223033005282' }), 'usps');
    // With an unrecognisable number, what the tech typed is all we have.
    assert.equal(multi.carrierFor({ carrier: 'fedex', trackingNumber: 'ABC123' }), 'fedex');
  }));

test('each carrier routes to its own provider', () =>
  withCreds(ALL, (multi) => {
    assert.equal(multi.providerFor({ trackingNumber: '1Z999AA10123456784' }).name, 'ups');
    assert.equal(multi.providerFor({ trackingNumber: '779879671234' }).name, 'fedex');
    assert.equal(multi.providerFor({ trackingNumber: '9400111899223033005282' }).name, 'usps');
    assert.deepEqual(multi.ready().sort(), ['fedex', 'ups', 'usps']);
  }));

test('Amazon Logistics is reported as unpollable rather than failing', () =>
  withCreds(ALL, (multi) => {
    assert.throws(
      () => multi.providerFor({ carrier: 'amazon', trackingNumber: 'TBA303177217654' }),
      (err) => {
        assert.equal(err.noProvider, true, 'flagged so the poller skips instead of erroring');
        assert.equal(err.reason, 'amazon_no_api');
        assert.match(err.message, /no public tracking API/);
        return true;
      }
    );
  }));

test('a carrier without credentials says so, distinctly from an unknown one', () =>
  withCreds({ UPS_CLIENT_ID: 'u', UPS_CLIENT_SECRET: 'u' }, (multi) => {
    assert.deepEqual(multi.ready(), ['ups']);
    assert.equal(multi.providerFor({ trackingNumber: '1Z999AA10123456784' }).name, 'ups');
    assert.throws(
      () => multi.providerFor({ trackingNumber: '779879671234' }),
      (err) => {
        assert.equal(err.reason, 'not_configured');
        assert.match(err.message, /FEDEX credentials/);
        return true;
      }
    );
    assert.throws(
      () => multi.providerFor({ trackingNumber: 'nonsense' }),
      (err) => {
        assert.equal(err.reason, 'unknown_carrier');
        return true;
      }
    );
  }));

test('register never throws for a carrier nobody can poll', () =>
  withCreds(ALL, async (multi) => {
    const out = await multi.register({ carrier: 'amazon', trackingNumber: 'TBA303177217654' });
    assert.equal(out.registered, false);
    assert.equal(out.reason, 'amazon_no_api');
  }));

// ---- status vocabularies ----------------------------------------------------

test('FedEx codes map onto our statuses, with the words as a fallback', () => {
  assert.equal(statuses.fromFedexCode('OC', 'Shipment information sent to FedEx'), 'pre_transit');
  assert.equal(statuses.fromFedexCode('AR', 'At local FedEx facility'), 'in_transit');
  assert.equal(statuses.fromFedexCode('OD', 'On FedEx vehicle for delivery'), 'out_for_delivery');
  assert.equal(statuses.fromFedexCode('DL', 'Delivered'), 'delivered');
  assert.equal(statuses.fromFedexCode('DE', 'Delivery exception'), 'exception');
  assert.equal(statuses.fromFedexCode('??', 'Delivered to front door'), 'delivered');
  assert.equal(statuses.fromFedexCode(null, null), 'unknown');
});

test('USPS status categories map onto our statuses', () => {
  assert.equal(statuses.fromUspsStatus('Pre-Shipment', 'Label created'), 'pre_transit');
  assert.equal(statuses.fromUspsStatus('In Transit', 'Moving through network'), 'in_transit');
  assert.equal(statuses.fromUspsStatus('Out for Delivery', ''), 'out_for_delivery');
  assert.equal(statuses.fromUspsStatus('Delivered', 'Left with individual'), 'delivered');
  assert.equal(statuses.fromUspsStatus('Alert', 'Delivery attempt failed'), 'exception');
  assert.equal(statuses.fromUspsStatus('Something New', 'Arrived at facility'), 'in_transit');
});

// ---- the two new providers, against recorded responses ---------------------

const okJson = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

test('a FedEx response turns into events and a status', () =>
  withCreds(ALL, async () => {
    const fedex = require('../src/tracking/providers/fedex');
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/oauth/token')) return okJson({ access_token: 'tok', expires_in: 3600 });
      return okJson({
        output: {
          completeTrackResults: [{
            trackingNumber: '779879671234',
            trackResults: [{
              latestStatusDetail: { code: 'OD', derivedCode: 'OD', description: 'On FedEx vehicle for delivery' },
              dateAndTimes: [
                { type: 'ESTIMATED_DELIVERY', dateTime: '2026-09-05T18:00:00-05:00' },
                { type: 'SHIP', dateTime: '2026-09-03T09:00:00-05:00' },
              ],
              scanEvents: [
                { derivedStatusCode: 'OD', eventDescription: 'On FedEx vehicle for delivery',
                  date: '2026-09-05T06:12:00-05:00',
                  scanLocation: { city: 'Pella', stateOrProvinceCode: 'IA', countryCode: 'US' } },
                { derivedStatusCode: 'AR', eventDescription: 'At local FedEx facility',
                  date: '2026-09-04T22:40:00-05:00',
                  scanLocation: { city: 'Des Moines', stateOrProvinceCode: 'IA', countryCode: 'US' } },
              ],
            }],
          }],
        },
      });
    };
    try {
      const out = await fedex.fetchTracking({ trackingNumber: '779879671234' });
      assert.equal(out.status, 'out_for_delivery');
      assert.equal(out.eta_day, '2026-09-05');
      assert.equal(out.events.length, 2);
      assert.equal(out.events[0].location, 'Pella, IA, US');
      assert.equal(out.raw_slug, 'fedex');
      // The estimate must come from the delivery date, not whichever came first.
      assert.equal(fedex.pickDate(
        [{ type: 'SHIP', dateTime: 'x' }, { type: 'ESTIMATED_DELIVERY', dateTime: 'y' }],
        ['ESTIMATED_DELIVERY']
      ), 'y');
    } finally { global.fetch = realFetch; }
  }));

test('a FedEx number with no record reads as pre-transit, not an error', () =>
  withCreds(ALL, async () => {
    const fedex = require('../src/tracking/providers/fedex');
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/oauth/token')) return okJson({ access_token: 'tok', expires_in: 3600 });
      return okJson({
        output: { completeTrackResults: [{ trackResults: [{ error: { code: 'TRACKING.TRACKINGNUMBER.NOTFOUND', message: 'Tracking number not found' } }] }] },
      });
    };
    try {
      const out = await fedex.fetchTracking({ trackingNumber: '779879671234' });
      assert.equal(out.status, 'pre_transit');
      assert.deepEqual(out.events, []);
    } finally { global.fetch = realFetch; }
  }));

test('a USPS response turns into events and a status', () =>
  withCreds(ALL, async () => {
    const usps = require('../src/tracking/providers/usps');
    const realFetch = global.fetch;
    let trackUrl = null;
    global.fetch = async (url) => {
      if (String(url).includes('/oauth2/v3/token')) return okJson({ access_token: 'tok', expires_in: 28800 });
      trackUrl = String(url);
      return okJson({
        trackingNumber: '9400111899223033005282',
        statusCategory: 'In Transit',
        statusSummary: 'Moving through the network',
        expectedDeliveryDate: '2026-09-06',
        trackingEvents: [
          { eventType: 'Arrived at Post Office', eventTimestamp: '2026-09-05T08:14:00Z',
            eventCity: 'PELLA', eventState: 'IA' },
          { eventType: 'Accepted', eventTimestamp: '2026-09-03T17:02:00Z',
            eventCity: 'DES MOINES', eventState: 'IA' },
        ],
      });
    };
    try {
      const out = await usps.fetchTracking({ trackingNumber: '9400111899223033005282' });
      assert.equal(out.status, 'in_transit');
      assert.equal(out.eta_day, '2026-09-06');
      assert.equal(out.events.length, 2);
      assert.equal(out.events[0].location, 'PELLA, IA');
      // The number goes into the path, and the detail expansion is asked for.
      assert.match(trackUrl, /\/tracking\/v3\/tracking\/9400111899223033005282/);
      assert.match(trackUrl, /expand=DETAIL/);
    } finally { global.fetch = realFetch; }
  }));

test('a USPS 404 is a label with no scans, not a failure', () =>
  withCreds(ALL, async () => {
    const usps = require('../src/tracking/providers/usps');
    const realFetch = global.fetch;
    global.fetch = async (url) => {
      if (String(url).includes('/oauth2/v3/token')) return okJson({ access_token: 'tok', expires_in: 28800 });
      return { ok: false, status: 404, text: async () => JSON.stringify({ error: { message: 'No record of that item' } }) };
    };
    try {
      const out = await usps.fetchTracking({ trackingNumber: '9400111899223033005282' });
      assert.equal(out.status, 'pre_transit');
    } finally { global.fetch = realFetch; }
  }));

// ---- how the poller behaves on a parcel nobody can poll --------------------

test('an Amazon parcel is skipped and its poll time stamped, not error-logged', async () => {
  // A real poll pass, with the dispatcher as the provider and every carrier set
  // up. The Amazon shipment must not land in the error column, and must not be
  // retried ahead of everything else on the next pass.
  const keys = { TRACKING_PROVIDER: 'multi', ...ALL };
  const before = {};
  for (const k of Object.keys(keys)) before[k] = process.env[k];
  Object.assign(process.env, keys);
  for (const m of ['../src/config', '../src/tracking', '../src/tracking/providers/multi']) {
    delete require.cache[require.resolve(m)];
  }
  const tracking = require('../src/tracking');
  const shipments = require('../src/shipments');

  try {
    const ship = shipments.create({
      vendor: 'Amazon Business',
      carrier: 'amazon',
      tracking_number: 'TBA303177217654',
      status: 'shipped',
    }, { author: 'Jacob' });

    const res = await tracking.poll({ force: true, respectHours: false });
    assert.equal(res.provider, 'multi');
    assert.equal(res.errors.length, 0, 'nothing goes in the error column');
    assert.equal(res.unpollable.length, 1);
    assert.equal(res.unpollable[0].reason, 'amazon_no_api');
    assert.match(res.unpollable[0].note, /by hand/);

    // The status is untouched and the poll time is stamped, so it queues last.
    const after = shipments.get(ship.id);
    assert.equal(after.status, 'shipped', 'a human still owns this one');
    assert.ok(after.tracking_polled_at, 'stamped so it is not retried first every pass');
    assert.equal(after.tracking_error, null, 'no error recorded');
    // The link out still works, which is the actual fallback for Amazon.
    assert.ok(after.tracking_url, 'a human can still click through to Amazon');
  } finally {
    for (const k of Object.keys(keys)) {
      if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k];
    }
    for (const m of ['../src/config', '../src/tracking', '../src/tracking/providers/multi']) {
      delete require.cache[require.resolve(m)];
    }
  }
});
