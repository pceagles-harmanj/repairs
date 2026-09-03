'use strict';
/**
 * Keeping shipment status in step with the carrier, quietly.
 *
 * A poller reads each open shipment's tracking number a few times a day (never
 * overnight), stores the carrier's scans, and moves our own status along:
 *
 *   label created / in transit  ->  shipped
 *   out for delivery            ->  shipped   (+ an "out for delivery" stamp)
 *   delivered                   ->  delivered (NOT received - see below)
 *   failed attempt / exception  ->  delayed
 *
 * Two deliberate limits:
 *
 * 1. It never sets `arrived`. Delivered is the carrier's word; arrived means a
 *    human checked the parts into stock. Students are told the difference.
 * 2. It never sends email. Nobody wants "your Chromebook part reached Memphis"
 *    at 2am. The only parts emails are the ones a tech triggers, plus the
 *    daily 8am "expected today" note.
 */
const config = require('./../config');
const { getDb } = require('./../db');
const { SHIPMENT_STATUS_FOR, LABEL, TRACKING_STATUSES } = require('./statuses');

const now = () => new Date().toISOString();

function provider() {
  const name = config.tracking.provider;
  if (!name || name === 'none') return null;
  if (name === 'mock') return require('./providers/mock');
  if (name === 'aftership') return require('./providers/aftership');
  if (name === 'ups') return require('./providers/ups');
  if (name === 'fedex') return require('./providers/fedex');
  if (name === 'usps') return require('./providers/usps');
  if (name === 'multi') return require('./providers/multi');
  console.warn(`! Unknown TRACKING_PROVIDER "${name}" - tracking updates are off`);
  return null;
}

const enabled = () => Boolean(provider());

function ticketEvent(ticketId, body) {
  if (!ticketId) return;
  getDb()
    .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, 'tracking', ?)`)
    .run(ticketId, body, now());
}

// --- storing what the carrier said -------------------------------------------

function saveEvents(shipmentId, events = []) {
  const insert = getDb().prepare(
    `INSERT OR IGNORE INTO shipment_events (shipment_id, status, code, description, location, happened_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  let added = 0;
  for (const e of events) {
    const info = insert.run(
      shipmentId,
      TRACKING_STATUSES.includes(e.status) ? e.status : 'unknown',
      e.code || null,
      e.description || null,
      e.location || null,
      e.happened_at || null,
      now()
    );
    added += info.changes;
  }
  return added;
}

function events(shipmentId, limit = 50) {
  return getDb()
    .prepare(`SELECT * FROM shipment_events WHERE shipment_id = ?
              ORDER BY COALESCE(happened_at, created_at) DESC, id DESC LIMIT ?`)
    .all(shipmentId, limit);
}

const firstTimeOf = (shipmentId, status) => {
  const row = getDb()
    .prepare(`SELECT happened_at FROM shipment_events WHERE shipment_id = ? AND status = ?
              ORDER BY COALESCE(happened_at, created_at) ASC LIMIT 1`)
    .get(shipmentId, status);
  return row ? row.happened_at : null;
};

// --- applying a result -------------------------------------------------------

/** Statuses a human owns; the poller never overwrites these. */
const HUMAN_OWNED = ['arrived', 'cancelled'];

/**
 * Fold one provider result into a shipment. Returns what changed, so the UI can
 * say "3 new scans, now out for delivery" without guessing.
 */
function apply(shipment, result, { today = new Date() } = {}) {
  const db = getDb();
  const changed = { id: shipment.id, new_events: 0, from: shipment.status, to: shipment.status, tracking_status: result.status };

  changed.new_events = saveEvents(shipment.id, result.events);

  const sets = ['tracking_status = @tracking_status', 'tracking_polled_at = @polled', 'tracking_error = NULL'];
  const params = { id: shipment.id, tracking_status: result.status || 'unknown', polled: now() };

  // The carrier's ETA is better than our guess, but never overwrites a date a
  // tech typed unless the carrier actually moved it.
  if (result.eta_day && result.eta_day !== shipment.carrier_eta_day) {
    sets.push('carrier_eta_day = @eta');
    params.eta = result.eta_day;
    if (result.eta_day !== shipment.expected_day) {
      sets.push('expected_day = @eta2');
      params.eta2 = result.eta_day;
      changed.expected_day = result.eta_day;
    }
  }

  const deliveredAt = result.status === 'delivered'
    ? firstTimeOf(shipment.id, 'delivered') || now()
    : null;
  if (deliveredAt && !shipment.delivered_at) {
    sets.push('delivered_at = @delivered');
    params.delivered = deliveredAt;
    changed.delivered_at = deliveredAt;
  }
  const outAt = firstTimeOf(shipment.id, 'out_for_delivery');
  if (outAt && !shipment.out_for_delivery_at) {
    sets.push('out_for_delivery_at = @out');
    params.out = outAt;
  }

  // We may first hear about a parcel when it is already out for delivery (or
  // delivered). Backfill the shipped stamp from the earliest movement scan so
  // the student's progress list does not read "shipped: not yet, delivered: Tuesday".
  if (!shipment.shipped_at && ['out_for_delivery', 'delivered'].includes(result.status)) {
    const firstMove = firstTimeOf(shipment.id, 'in_transit')
      || firstTimeOf(shipment.id, 'pre_transit')
      || outAt
      || deliveredAt;
    if (firstMove) {
      sets.push('shipped_at = @backfill');
      params.backfill = firstMove;
    }
  }

  // Move our own status, unless a human already owns it.
  const wanted = SHIPMENT_STATUS_FOR[result.status];
  if (wanted && !HUMAN_OWNED.includes(shipment.status) && wanted !== shipment.status) {
    // Do not walk backwards: a late "in transit" scan must not un-deliver.
    const rank = { ordered: 0, shipped: 1, delayed: 1, delivered: 2 };
    if ((rank[wanted] ?? 0) >= (rank[shipment.status] ?? 0) || wanted === 'delayed') {
      sets.push('status = @status');
      params.status = wanted;
      changed.to = wanted;
      if (wanted === 'shipped' && !shipment.shipped_at) {
        sets.push('shipped_at = @shipped');
        params.shipped = now();
      }
    }
  }

  sets.push('updated_at = @polled');
  db.prepare(`UPDATE shipments SET ${sets.join(', ')} WHERE id = @id`).run(params);

  // Worth a line on the ticket timeline (techs read it), never an email.
  if (changed.to !== changed.from) {
    const lines = db.prepare('SELECT DISTINCT ticket_id FROM shipment_lines WHERE shipment_id = ? AND ticket_id IS NOT NULL').all(shipment.id);
    for (const { ticket_id: ticketId } of lines) {
      ticketEvent(ticketId, `carrier tracking: ${LABEL[result.status] || result.status} (shipment now ${changed.to})`);
    }
  }
  return changed;
}

function recordError(shipmentId, message) {
  getDb()
    .prepare('UPDATE shipments SET tracking_error = ?, tracking_polled_at = ?, updated_at = ? WHERE id = ?')
    .run(String(message).slice(0, 300), now(), now(), shipmentId);
}

// --- the poller --------------------------------------------------------------

function withinActiveHours(date = new Date()) {
  const { hourFrom, hourTo } = config.tracking;
  const h = date.getHours();
  return hourFrom <= hourTo ? h >= hourFrom && h <= hourTo : h >= hourFrom || h <= hourTo;
}

/** Open shipments with a tracking number that are due a check. */
function dueForPoll({ now: nowDate = new Date(), force = false, limit = config.tracking.maxPerRun } = {}) {
  const cutoff = new Date(nowDate.getTime() - config.tracking.pollMinutes * 60000).toISOString();
  return getDb()
    .prepare(
      `SELECT * FROM shipments
        WHERE tracking_number IS NOT NULL AND TRIM(tracking_number) <> ''
          AND status NOT IN ('arrived', 'cancelled')
          AND (@force = 1 OR tracking_polled_at IS NULL OR tracking_polled_at < @cutoff)
        ORDER BY COALESCE(tracking_polled_at, '') ASC
        LIMIT @limit`
    )
    .all({ force: force ? 1 : 0, cutoff, limit });
}

/** Check one shipment now. Used by the "refresh tracking" button. */
async function pollOne(shipmentId, { today = new Date() } = {}) {
  const p = provider();
  if (!p) return { result: 'skipped', reason: 'tracking_disabled' };
  const shipment = getDb().prepare('SELECT * FROM shipments WHERE id = ?').get(shipmentId);
  if (!shipment) return { result: 'skipped', reason: 'no_shipment' };
  if (!shipment.tracking_number) return { result: 'skipped', reason: 'no_tracking_number' };
  // Received or cancelled is the end of the story - and on a free API plan,
  // every call we do not make is one we still have.
  if (HUMAN_OWNED.includes(shipment.status)) return { result: 'skipped', reason: 'closed', id: shipmentId };

  try {
    const data = await p.fetchTracking({ carrier: shipment.carrier, trackingNumber: shipment.tracking_number });
    const changed = apply(shipment, data, { today });
    return { result: 'ok', ...changed };
  } catch (err) {
    // "No API exists for this carrier" is not a failure. An Amazon Logistics
    // parcel simply cannot be polled by anyone, so record why and stop asking
    // rather than filling the error column with the same message every 3 hours.
    if (err.noProvider) {
      markPolled(shipmentId);
      return { result: 'skipped', id: shipmentId, reason: err.reason, note: err.message };
    }
    recordError(shipmentId, err.message);
    return { result: 'error', id: shipmentId, error: err.message };
  }
}

/**
 * Stamp the poll time without touching the status. Used for parcels nobody can
 * poll, so they drop to the back of the queue instead of being retried first.
 */
function markPolled(shipmentId) {
  getDb()
    .prepare('UPDATE shipments SET tracking_polled_at = ? WHERE id = ?')
    .run(new Date().toISOString(), shipmentId);
}

/**
 * One pass over everything that is due. Quiet by design: it writes statuses and
 * scans, and sends nothing.
 */
async function poll({ force = false, today = new Date(), respectHours = true } = {}) {
  const p = provider();
  const summary = {
    provider: p ? p.name : null, checked: 0, updated: [], errors: [], unpollable: [], skipped: null,
  };
  if (!p) { summary.skipped = 'tracking_disabled'; return summary; }
  if (respectHours && !withinActiveHours(today)) { summary.skipped = 'outside_active_hours'; return summary; }

  for (const shipment of dueForPoll({ now: today, force })) {
    summary.checked += 1;
    const res = await pollOne(shipment.id, { today });
    if (res.result === 'error') summary.errors.push(res);
    else if (res.result === 'skipped' && res.reason) summary.unpollable.push(res);
    else if (res.result === 'ok' && (res.new_events > 0 || res.to !== res.from)) summary.updated.push(res);
  }
  return summary;
}

let timer = null;

function startScheduler() {
  if (!enabled()) return { scheduled: false, reason: 'tracking_disabled' };
  const everyMs = config.tracking.pollMinutes * 60000;
  const tick = async () => {
    try {
      const res = await poll({});
      if (res.updated.length || res.errors.length) {
        console.log(`[tracking] checked ${res.checked}, updated ${res.updated.length}, errors ${res.errors.length}`);
      }
    } catch (err) {
      console.error('[tracking] pass failed:', err.message);
    }
  };
  timer = setInterval(tick, everyMs);
  timer.unref?.();
  setTimeout(tick, 20000).unref?.();   // once shortly after boot
  console.log(`[tracking] ${config.tracking.provider} polling every ${config.tracking.pollMinutes}m between ${config.tracking.hourFrom}:00 and ${config.tracking.hourTo}:00`);
  return { scheduled: true };
}

function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
}

function status() {
  const db = getDb();
  const last = db.prepare('SELECT MAX(tracking_polled_at) AS at FROM shipments').get().at;
  const failing = db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE tracking_error IS NOT NULL AND status NOT IN ('arrived','cancelled')").get().n;
  return {
    enabled: enabled(),
    provider: config.tracking.provider,
    carriers_ready: config.tracking.provider === 'multi'
      ? require('./providers/multi').ready()
      : config.tracking.provider === 'none' ? [] : [config.tracking.provider],
    manual_carriers: ['amazon'],
    poll_minutes: config.tracking.pollMinutes,
    active_hours: `${String(config.tracking.hourFrom).padStart(2, '0')}:00-${String(config.tracking.hourTo).padStart(2, '0')}:00`,
    last_polled_at: last || null,
    with_errors: failing,
    watching: db.prepare("SELECT COUNT(*) AS n FROM shipments WHERE tracking_number IS NOT NULL AND status NOT IN ('arrived','cancelled')").get().n,
  };
}

module.exports = {
  enabled, provider, poll, pollOne, apply, saveEvents, events, status, HUMAN_OWNED,
  startScheduler, stopScheduler, withinActiveHours, dueForPoll, LABEL,
};
