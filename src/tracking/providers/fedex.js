'use strict';
/**
 * FedEx directly, which is also free.
 *
 * Same shape as the UPS provider: OAuth client-credentials for a token, then a
 * tracking call. FedEx differs in two ways worth knowing - the track call is a
 * POST with a JSON body (not a GET by number), and it can take up to 30 numbers
 * at once, though we ask one at a time because the poller works per shipment.
 *
 *   TRACKING_PROVIDER=multi   (or fedex)
 *   FEDEX_CLIENT_ID=...
 *   FEDEX_CLIENT_SECRET=...
 *   FEDEX_ENV=production      (or "sandbox")
 */
const config = require('./../../config');
const { fromFedexCode } = require('./../statuses');

const host = () =>
  (config.tracking.fedex.env === 'sandbox' ? 'https://apis-sandbox.fedex.com' : 'https://apis.fedex.com');

let token = { value: null, expiresAt: 0 };

function credentials() {
  const { clientId, clientSecret } = config.tracking.fedex;
  if (!clientId || !clientSecret) {
    const err = new Error('FEDEX_CLIENT_ID and FEDEX_CLIENT_SECRET are not set');
    err.statusCode = 500;
    throw err;
  }
  return { clientId, clientSecret };
}

async function accessToken({ force = false } = {}) {
  if (!force && token.value && Date.now() < token.expiresAt - 60000) return token.value;
  const { clientId, clientSecret } = credentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(`${host()}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || !json || !json.access_token) {
      const message = (json && (json.errors?.[0]?.message || json.error_description)) || `HTTP ${res.status}`;
      const err = new Error(`FedEx auth: ${message}`);
      err.status = res.status;
      throw err;
    }
    // FedEx tokens last an hour.
    token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1000 };
    return token.value;
  } finally {
    clearTimeout(timer);
  }
}

async function register() {
  return { registered: true, already: true };
}

const dayOf = (value) => {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

const place = (loc) => {
  if (!loc) return null;
  return [loc.city, loc.stateOrProvinceCode, loc.countryCode].filter(Boolean).join(', ') || null;
};

/** FedEx returns several date kinds in one array; pick the one we mean. */
function pickDate(dateAndTimes, types) {
  for (const type of types) {
    const hit = (dateAndTimes || []).find((d) => d.type === type);
    if (hit && hit.dateTime) return hit.dateTime;
  }
  return null;
}

async function call(trackingNumber, bearer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(`${host()}/track/v1/trackingnumbers`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${bearer}`,
        'Content-Type': 'application/json',
        'X-locale': 'en_US',
      },
      body: JSON.stringify({
        trackingInfo: [{ trackingNumberInfo: { trackingNumber } }],
        includeDetailedScans: true,
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    return { res, json };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTracking({ trackingNumber }) {
  let bearer = await accessToken();
  let { res, json } = await call(trackingNumber, bearer);
  if (res.status === 401) {
    bearer = await accessToken({ force: true });
    ({ res, json } = await call(trackingNumber, bearer));
  }
  if (!res.ok) {
    const message = (json && json.errors?.[0]?.message) || `HTTP ${res.status}`;
    const err = new Error(`FedEx: ${message}`);
    err.status = res.status;
    throw err;
  }

  const complete = ((json && json.output && json.output.completeTrackResults) || [])[0] || null;
  const result = ((complete && complete.trackResults) || [])[0] || null;
  if (!result) return { status: 'unknown', events: [] };

  // A number FedEx has no record of comes back as a trackResult with an error,
  // not an HTTP failure. Treat "not found" as a label that has not moved yet.
  const notFound = (result.error && /not found|no information|invalid/i.test(result.error.message || ''));
  if (notFound) return { status: 'pre_transit', provider_status: 'no scans yet', events: [] };

  const latest = result.latestStatusDetail || null;
  const events = (result.scanEvents || []).map((e) => ({
    status: fromFedexCode(e.derivedStatusCode || e.eventType, e.eventDescription),
    code: e.derivedStatusCode || e.eventType || null,
    description: e.eventDescription || null,
    location: place(e.scanLocation),
    happened_at: e.date || null,
  }));

  return {
    status: fromFedexCode(latest && (latest.derivedCode || latest.code), latest && latest.description),
    provider_status: (latest && (latest.description || latest.statusByLocale)) || null,
    eta_day: dayOf(pickDate(result.dateAndTimes, ['ESTIMATED_DELIVERY', 'ACTUAL_DELIVERY', 'APPOINTMENT_DELIVERY'])),
    events,
    raw_slug: 'fedex',
  };
}

module.exports = { name: 'fedex', register, fetchTracking, accessToken, pickDate };
