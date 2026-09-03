'use strict';
/**
 * UPS directly, which is free.
 *
 * No aggregator, no per-lookup fee: you register an app on the UPS developer
 * portal, get a client id and secret, and call the tracking API with an OAuth
 * client-credentials token. UPS is the carrier most Chromebook parts arrive on,
 * so this covers the majority of shipments without paying anyone for
 * information that is on the carrier's own website.
 *
 * What you need in .env:
 *   TRACKING_PROVIDER=ups
 *   UPS_CLIENT_ID=...
 *   UPS_CLIENT_SECRET=...
 *   UPS_ACCOUNT_NUMBER=...      (optional, six digits)
 *   UPS_ENV=production          (or "test" to hit the CIE sandbox)
 *
 * The token is cached in memory until shortly before it expires; a poll every
 * three hours would otherwise fetch a new one for every single parcel.
 */
const config = require('./../../config');
const { fromUpsStatus } = require('./../statuses');

const hosts = () =>
  (config.tracking.ups.env === 'test'
    ? { auth: 'https://wwwcie.ups.com', api: 'https://wwwcie.ups.com' }
    : { auth: 'https://onlinetools.ups.com', api: 'https://onlinetools.ups.com' });

let token = { value: null, expiresAt: 0 };

function credentials() {
  const { clientId, clientSecret } = config.tracking.ups;
  if (!clientId || !clientSecret) {
    const err = new Error('UPS_CLIENT_ID and UPS_CLIENT_SECRET are not set');
    err.statusCode = 500;
    throw err;
  }
  return { clientId, clientSecret };
}

async function accessToken({ force = false } = {}) {
  // 60 seconds of slack: a token that expires mid-request is a failed poll.
  if (!force && token.value && Date.now() < token.expiresAt - 60000) return token.value;
  const { clientId, clientSecret } = credentials();
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(`${hosts().auth}/security/v1/oauth/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        ...(config.tracking.ups.accountNumber ? { 'x-merchant-id': config.tracking.ups.accountNumber } : {}),
      },
      body: 'grant_type=client_credentials',
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || !json || !json.access_token) {
      const message = (json && (json.response || json).errors?.[0]?.message)
        || (json && json.error_description) || `HTTP ${res.status}`;
      const err = new Error(`UPS auth: ${message}`);
      err.status = res.status;
      throw err;
    }
    const seconds = Number(json.expires_in) || 3600;
    token = { value: json.access_token, expiresAt: Date.now() + seconds * 1000 };
    return token.value;
  } finally {
    clearTimeout(timer);
  }
}

/** Nothing to register: UPS is queried by tracking number directly. */
async function register() {
  return { registered: true, already: true };
}

const dayOf = (value) => {
  if (!value) return null;
  // UPS dates are YYYYMMDD, times HHMMSS, both as bare strings.
  const m = String(value).match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const iso = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : null;
};

/** UPS gives date and time as separate digit strings; make one timestamp. */
function stamp(date, time) {
  const day = dayOf(date);
  if (!day) return null;
  const t = String(time || '').match(/^(\d{2})(\d{2})(\d{2})$/);
  return t ? `${day}T${t[1]}:${t[2]}:${t[3]}` : `${day}T12:00:00`;
}

const place = (loc) => {
  const a = (loc && loc.address) || {};
  return [a.city, a.stateProvince, a.countryCode].filter(Boolean).join(', ') || null;
};

async function callTracking(trackingNumber, bearer) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const url = `${hosts().api}/api/track/v1/details/${encodeURIComponent(trackingNumber)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        // Both of these are required; transId just has to be unique per call.
        transId: String(Date.now()),
        transactionSrc: config.tracking.ups.transactionSrc,
        Accept: 'application/json',
      },
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
  let { res, json } = await callTracking(trackingNumber, bearer);

  // A rejected token is worth exactly one retry with a fresh one.
  if (res.status === 401) {
    bearer = await accessToken({ force: true });
    ({ res, json } = await callTracking(trackingNumber, bearer));
  }

  if (!res.ok) {
    const message = (json && (json.response || json).errors?.[0]?.message) || `HTTP ${res.status}`;
    // UPS says "no tracking information available" for a number it has not
    // scanned yet. That is not an error - it is a label that has not moved.
    if (/no tracking information|not found/i.test(message)) {
      return { status: 'pre_transit', provider_status: 'no scans yet', events: [] };
    }
    const err = new Error(`UPS: ${message}`);
    err.status = res.status;
    throw err;
  }

  const shipment = ((json && json.trackResponse && json.trackResponse.shipment) || [])[0] || null;
  const pkg = ((shipment && shipment.package) || [])[0] || null;
  if (!pkg) return { status: 'unknown', events: [] };

  const activities = pkg.activity || [];
  const events = activities.map((a) => ({
    status: fromUpsStatus(a.status),
    code: (a.status && (a.status.type || a.status.code)) || null,
    description: (a.status && a.status.description) || null,
    location: place(a.location),
    happened_at: stamp(a.date, a.time),
  }));

  // currentStatus is not always present; the newest activity always is.
  const current = pkg.currentStatus || (activities[0] && activities[0].status) || null;
  const eta = (pkg.deliveryDate || []).find((d) => d.type === 'DEL' || d.type === 'SDD') || (pkg.deliveryDate || [])[0];

  return {
    status: fromUpsStatus(current),
    provider_status: (current && (current.description || current.type)) || null,
    eta_day: dayOf(eta && eta.date),
    events,
    raw_slug: 'ups',
  };
}

module.exports = { name: 'ups', register, fetchTracking, accessToken, stamp, dayOf };
