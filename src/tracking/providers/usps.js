'use strict';
/**
 * USPS directly, free with a USPS business account.
 *
 * USPS replaced the old Web Tools XML service with a REST API on
 * apis.usps.com: OAuth client-credentials for a token (theirs last several
 * hours), then a GET per tracking number.
 *
 *   TRACKING_PROVIDER=multi   (or usps)
 *   USPS_CLIENT_ID=...        (consumer key from the developer portal)
 *   USPS_CLIENT_SECRET=...
 *
 * USPS has moved these paths before, so the base URL and the tracking path are
 * both overridable rather than baked in:
 *   USPS_API_BASE=https://apis.usps.com
 *   USPS_TRACK_PATH=/tracking/v3/tracking/{tracking}?expand=DETAIL
 */
const config = require('./../../config');
const { fromUspsStatus } = require('./../statuses');

let token = { value: null, expiresAt: 0 };

function credentials() {
  const { clientId, clientSecret } = config.tracking.usps;
  if (!clientId || !clientSecret) {
    const err = new Error('USPS_CLIENT_ID and USPS_CLIENT_SECRET are not set');
    err.statusCode = 500;
    throw err;
  }
  return { clientId, clientSecret };
}

const base = () => config.tracking.usps.apiBase.replace(/\/+$/, '');

async function accessToken({ force = false } = {}) {
  if (!force && token.value && Date.now() < token.expiresAt - 60000) return token.value;
  const { clientId, clientSecret } = credentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(`${base()}/oauth2/v3/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
        // Ask only for what this app does.
        scope: 'tracking',
      }),
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok || !json || !json.access_token) {
      const message = (json && (json.error_description || json.error || json.message)) || `HTTP ${res.status}`;
      const err = new Error(`USPS auth: ${message}`);
      err.status = res.status;
      throw err;
    }
    token = { value: json.access_token, expiresAt: Date.now() + (Number(json.expires_in) || 28800) * 1000 };
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

async function call(trackingNumber, bearer) {
  const path = config.tracking.usps.trackPath.replace('{tracking}', encodeURIComponent(trackingNumber));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(base() + path, {
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/json' },
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
    const message = (json && (json.error?.message || json.message || json.error)) || `HTTP ${res.status}`;
    if (res.status === 404 || /no record|not found/i.test(String(message))) {
      return { status: 'pre_transit', provider_status: 'no scans yet', events: [] };
    }
    const err = new Error(`USPS: ${message}`);
    err.status = res.status;
    throw err;
  }
  if (!json) return { status: 'unknown', events: [] };

  // USPS names the newest event's fields at the top level and repeats the
  // history under trackingEvents.
  const history = json.trackingEvents || json.eventSummaries || [];
  const events = history.map((e) => ({
    status: fromUspsStatus(e.eventType || e.eventCode, e.eventType || e.eventName),
    code: e.eventCode || e.eventType || null,
    description: e.eventType || e.eventName || null,
    location: [e.eventCity, e.eventState, e.eventCountry].filter(Boolean).join(', ') || null,
    happened_at: e.eventTimestamp || e.eventDateTime || null,
  }));

  return {
    status: fromUspsStatus(json.statusCategory, json.statusSummary),
    provider_status: json.statusSummary || json.statusCategory || null,
    eta_day: dayOf(json.expectedDeliveryDate || json.predictedDeliveryDate),
    events,
    raw_slug: 'usps',
  };
}

module.exports = { name: 'usps', register, fetchTracking, accessToken };
