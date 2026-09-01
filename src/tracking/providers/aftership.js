'use strict';
/**
 * AfterShip as the tracking source: one key, every carrier we use.
 *
 * Two calls: register the number once (POST /trackings, a 409 means it is
 * already there, which is fine), then read it (GET /trackings/{slug}/{number}).
 * Their `tag` values are mapped onto our own small set of statuses in
 * ../statuses.js, so swapping providers does not touch the rest of the app.
 *
 * TRACKING_API_BASE exists because AfterShip has more than one live API
 * version; point it at whatever your account's docs show if v4 is not it.
 */
const config = require('./../../config');
const { fromAfterShipTag } = require('./../statuses');

// our carrier key -> AfterShip slug
const SLUG = {
  ups: 'ups',
  fedex: 'fedex',
  usps: 'usps',
  dhl: 'dhl',
  amazon: 'amazon',
};

async function request(path, { method = 'GET', body } = {}) {
  if (!config.tracking.apiKey) {
    const err = new Error('TRACKING_API_KEY is not set');
    err.statusCode = 500;
    throw err;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.tracking.timeoutMs);
  try {
    const res = await fetch(config.tracking.apiBase.replace(/\/+$/, '') + path, {
      method,
      headers: {
        'aftership-api-key': config.tracking.apiKey,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    if (!res.ok) {
      const message = (json && json.meta && json.meta.message) || `HTTP ${res.status}`;
      const err = new Error(`AfterShip: ${message}`);
      err.status = res.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

/** Ask AfterShip to start following this number. Safe to call again. */
async function register({ carrier, trackingNumber }) {
  const slug = SLUG[String(carrier || '').toLowerCase()];
  try {
    await request('/trackings', {
      method: 'POST',
      body: { tracking: { tracking_number: trackingNumber, ...(slug ? { slug } : {}) } },
    });
    return { registered: true };
  } catch (err) {
    // 409 = already tracked, 4xx on a duplicate is not a failure worth surfacing
    if (err.status === 409) return { registered: true, already: true };
    throw err;
  }
}

const dayOf = (value) => {
  if (!value) return null;
  const m = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
};

async function fetchTracking({ carrier, trackingNumber, register: doRegister = true }) {
  const slug = SLUG[String(carrier || '').toLowerCase()];
  if (doRegister) {
    try { await register({ carrier, trackingNumber }); } catch { /* reading may still work */ }
  }
  const path = slug
    ? `/trackings/${encodeURIComponent(slug)}/${encodeURIComponent(trackingNumber)}`
    : `/trackings?tracking_numbers=${encodeURIComponent(trackingNumber)}`;
  const json = await request(path);

  const tracking = (json && json.data && (json.data.tracking || (json.data.trackings || [])[0])) || null;
  if (!tracking) return { status: 'unknown', events: [] };

  const events = (tracking.checkpoints || []).map((c) => ({
    status: fromAfterShipTag(c.tag),
    code: c.tag || c.subtag || null,
    description: c.message || c.subtag_message || null,
    location: [c.city, c.state, c.country_name].filter(Boolean).join(', ') || c.location || null,
    happened_at: c.checkpoint_time || c.created_at || null,
  }));

  return {
    status: fromAfterShipTag(tracking.tag),
    provider_status: tracking.tag || null,
    eta_day: dayOf(tracking.expected_delivery) || dayOf((tracking.courier_estimated_delivery_date || {}).estimated_delivery_date),
    events,
    raw_slug: tracking.slug || slug || null,
  };
}

module.exports = { name: 'aftership', register, fetchTracking };
