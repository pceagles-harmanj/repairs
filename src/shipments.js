'use strict';
/**
 * Parts on the way.
 *
 * A shipment is one package: vendor, carrier, tracking number, expected day.
 * Its lines say what is inside, how many, which inventory item it tops up, and
 * which ticket is waiting for it - so one order can serve several repairs.
 *
 * Students are told the simple thing ("parts shipped, expected Tuesday"). The
 * carrier and tracking number stay on the tech side.
 */
const { getDb } = require('./db');
const config = require('./config');
const mailer = require('./mailer');
const inventory = require('./inventory');
const tracking = require('./tracking');
const days = require('./lib/schooldays');

const now = () => new Date().toISOString();
// `delivered` is the carrier's word; `arrived` means a human checked the parts
// into stock. Both are "not finished" as far as the queue is concerned.
const STATUSES = ['ordered', 'shipped', 'delivered', 'delayed', 'arrived', 'cancelled'];
const OPEN_STATUSES = ['ordered', 'shipped', 'delivered', 'delayed'];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function ticketEvent(ticketId, body, author = 'system') {
  if (!ticketId) return;
  getDb()
    .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, ?, ?)`)
    .run(ticketId, body, author, now());
}

// --- carriers ----------------------------------------------------------------

/** Guess the carrier from the tracking number so nobody has to pick from a list. */
// Shared with the tracking providers, which need it without importing this file.
const { detectCarrier } = require('./tracking/carriers');

const TRACK_URL = {
  ups: (t) => `https://www.ups.com/track?tracknum=${encodeURIComponent(t)}`,
  fedex: (t) => `https://www.fedex.com/fedextrack/?trknbr=${encodeURIComponent(t)}`,
  usps: (t) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${encodeURIComponent(t)}`,
  amazon: (t) => `https://track.amazon.com/tracking/${encodeURIComponent(t)}`,
  dhl: (t) => `https://www.dhl.com/us-en/home/tracking.html?tracking-id=${encodeURIComponent(t)}`,
};

function trackingUrl(carrier, tracking) {
  if (!tracking) return null;
  const key = String(carrier || detectCarrier(tracking) || '').toLowerCase();
  const build = TRACK_URL[key];
  return build ? build(String(tracking).trim()) : null;
}

// --- shape -------------------------------------------------------------------

const fmtDay = (day) => {
  if (!day) return '';
  const d = days.fromDayString(day);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

/** The one sentence a student should see. Never mentions carriers or tracking. */
function expectationSentence(shipment, today = new Date()) {
  if (!shipment) return '';
  const todayDay = days.toDayString(today);
  if (shipment.status === 'arrived') return 'The parts for your repair have arrived and are on the bench.';
  if (shipment.status === 'cancelled') return '';

  // Delivered by the carrier, but nobody has checked it in yet - the honest
  // version, and the one that stops "it says delivered, where is my laptop".
  if (shipment.status === 'delivered' || shipment.tracking_status === 'delivered') {
    const when = shipment.delivered_at ? days.toDayString(new Date(shipment.delivered_at)) : todayDay;
    const wording = when === todayDay ? 'were delivered to the school today' : `were delivered to the school on ${fmtDay(when)}`;
    return `The parts for your repair ${wording} and are waiting to be checked in.`;
  }
  if (shipment.tracking_status === 'out_for_delivery') {
    return 'The parts for your repair are out for delivery today.';
  }
  if (shipment.tracking_status === 'exception') {
    return 'The delivery of your parts has hit a snag with the carrier. We are chasing it.';
  }
  if (!shipment.expected_day) {
    return shipment.status === 'shipped'
      ? 'The parts for your repair have shipped. We do not have a delivery date yet.'
      : 'The parts for your repair are on order.';
  }
  if (shipment.expected_day < todayDay) {
    return `The parts for your repair were due ${fmtDay(shipment.expected_day)} and have not turned up yet - we are chasing them.`;
  }
  if (shipment.expected_day === todayDay) return 'The parts for your repair are expected to arrive today.';
  const tomorrow = days.toDayString(new Date(today.getTime() + 86400000));
  if (shipment.expected_day === tomorrow) return 'The parts for your repair are expected tomorrow.';
  const verb = shipment.status === 'shipped' ? 'have shipped and are expected' : 'are on order, expected';
  return `The parts for your repair ${verb} ${fmtDay(shipment.expected_day)}.`;
}

function lines(shipmentId) {
  return getDb()
    .prepare(`SELECT l.*, i.name AS item_name, i.part_number, i.kind AS item_kind, i.location,
                     t.user_email, t.user_name, t.status AS ticket_status, t.asset_tag AS ticket_asset_tag
              FROM shipment_lines l
              LEFT JOIN inventory_items i ON i.id = l.item_id
              LEFT JOIN tickets t ON t.id = l.ticket_id
              WHERE l.shipment_id = ? ORDER BY l.id`)
    .all(shipmentId);
}

function decorate(row, today = new Date()) {
  const rows = lines(row.id);
  const todayDay = days.toDayString(today);
  const ticketIds = [...new Set(rows.map((l) => l.ticket_id).filter(Boolean))];
  return {
    ...row,
    lines: rows,
    ticket_ids: ticketIds,
    tracking_url: trackingUrl(row.carrier, row.tracking_number),
    open: OPEN_STATUSES.includes(row.status),
    late: Boolean(OPEN_STATUSES.includes(row.status) && row.expected_day && row.expected_day < todayDay),
    due_today: Boolean(OPEN_STATUSES.includes(row.status) && row.expected_day === todayDay),
    expected_label: fmtDay(row.expected_day),
    days_until_expected: row.expected_day ? days.calendarDaysBetween(todayDay, row.expected_day) : null,
    expectation: expectationSentence(row, today),
    delivered_not_received: Boolean(row.delivered_at && !row.received_at),
    tracking_label: row.tracking_status ? tracking.LABEL[row.tracking_status] || row.tracking_status : null,
    tracking_events: tracking.events(row.id, 25),
    milestones: milestones(row, today),
    notices: getDb().prepare('SELECT ticket_id, kind, sent_on FROM shipment_notices WHERE shipment_id = ?').all(row.id),
  };
}

/**
 * The student-facing version of "where are my parts": a handful of stages with
 * dates. No carrier, no city, no tracking number - a repair is not a parcel
 * hobby, and the people asking just want to know if it is close.
 */
function milestones(row, today = new Date()) {
  const stages = [
    { key: 'ordered', label: 'Parts ordered', at: row.ordered_at || row.created_at },
    { key: 'shipped', label: 'Parts shipped', at: row.shipped_at },
    { key: 'out_for_delivery', label: 'Out for delivery', at: row.out_for_delivery_at },
    { key: 'delivered', label: 'Delivered to school', at: row.delivered_at },
    { key: 'received', label: 'Checked in by the technology office', at: row.received_at },
  ];
  const reached = stages.filter((s) => s.at);
  const currentIndex = reached.length ? stages.indexOf(reached[reached.length - 1]) : 0;
  return stages.map((s, i) => ({
    ...s,
    done: Boolean(s.at),
    current: i === currentIndex,
    // A stage the carrier never reported but that is clearly behind us (no
    // out-for-delivery scan on a parcel already delivered) is shown quietly
    // rather than as "not yet", which would read like something is missing.
    skipped: !s.at && i < currentIndex,
    expected: !s.at && i > currentIndex && s.key === 'delivered' ? row.expected_day || null : null,
  }));
}

function get(id, today = new Date()) {
  const row = getDb().prepare('SELECT * FROM shipments WHERE id = ?').get(id);
  return row ? decorate(row, today) : null;
}

function list({ status = 'open', limit = 200, today = new Date() } = {}) {
  let clause = '';
  const params = { limit: Math.min(Number(limit) || 200, 500) };
  if (status === 'open') {
    clause = `WHERE status IN (${OPEN_STATUSES.map((s) => `'${s}'`).join(',')})`;
  } else if (status && status !== 'all' && STATUSES.includes(status)) {
    clause = 'WHERE status = @status';
    params.status = status;
  }
  return getDb()
    .prepare(`SELECT * FROM shipments ${clause}
              ORDER BY CASE WHEN status IN ('shipped','ordered','delayed') THEN 0 ELSE 1 END,
                       COALESCE(expected_day, '9999-99-99'), id DESC
              LIMIT @limit`)
    .all(params)
    .map((r) => decorate(r, today));
}

// --- writes ------------------------------------------------------------------

function create(payload = {}, { author = null } = {}) {
  const status = STATUSES.includes(payload.status) ? payload.status : 'ordered';
  const tracking = payload.tracking_number ? String(payload.tracking_number).trim() : null;
  const ts = now();
  const info = getDb()
    .prepare(
      `INSERT INTO shipments (vendor, carrier, tracking_number, status, ordered_at, shipped_at,
         expected_day, notes, created_at, updated_at)
       VALUES (@vendor, @carrier, @tracking, @status, @ordered_at, @shipped_at, @expected_day, @notes, @ts, @ts)`
    )
    .run({
      vendor: payload.vendor || null,
      carrier: (payload.carrier || detectCarrier(tracking) || null),
      tracking,
      status,
      ordered_at: payload.ordered_at || ts,
      shipped_at: status === 'shipped' ? payload.shipped_at || ts : payload.shipped_at || null,
      expected_day: payload.expected_day || null,
      notes: payload.notes || null,
      ts,
    });
  const id = Number(info.lastInsertRowid);
  for (const line of payload.lines || []) addLine(id, line, { author, quiet: true });
  return get(id);
}

const SHIPMENT_EDITABLE = ['vendor', 'carrier', 'tracking_number', 'ordered_at', 'shipped_at', 'expected_day', 'notes'];

function update(id, patch = {}, { author = null } = {}) {
  const before = get(id);
  if (!before) return null;
  const sets = [];
  const params = { id, ts: now() };
  for (const field of SHIPMENT_EDITABLE) {
    if (!(field in patch)) continue;
    let value = patch[field] === '' ? null : patch[field];
    if (field === 'expected_day' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw badRequest('Expected date must look like 2026-09-08');
    sets.push(`${field} = @${field}`);
    params[field] = value;
  }
  if (patch.status) {
    if (!STATUSES.includes(patch.status)) throw badRequest('Unknown shipment status');
    sets.push('status = @status');
    params.status = patch.status;
  }
  // Carrier follows the tracking number unless it was set by hand.
  if ('tracking_number' in patch && !('carrier' in patch)) {
    const guess = detectCarrier(patch.tracking_number);
    if (guess) { sets.push('carrier = @carrier'); params.carrier = guess; }
  }
  if (!sets.length) return before;
  getDb().prepare(`UPDATE shipments SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  return get(id);
}

function addLine(shipmentId, line = {}, { author = null, quiet = false } = {}) {
  const shipment = get(shipmentId);
  if (!shipment) throw badRequest('No such shipment');
  const itemId = line.item_id ? Number(line.item_id) : null;
  if (itemId && !inventory.get(itemId)) throw badRequest('No such inventory item');
  const description = line.description ? String(line.description).trim() : null;
  if (!itemId && !description) throw badRequest('A line needs an inventory item or a description');

  const info = getDb()
    .prepare(
      `INSERT INTO shipment_lines (shipment_id, item_id, description, qty, received_qty, ticket_id, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(shipmentId, itemId, description, Math.max(1, Math.trunc(Number(line.qty) || 1)), line.ticket_id || null, now());

  if (!quiet && line.ticket_id) {
    const label = description || (itemId ? inventory.get(itemId).label : 'a part');
    ticketEvent(line.ticket_id, `part on order: ${label}${shipment.expected_day ? `, expected ${shipment.expected_day}` : ''}`, author);
  }
  return { line_id: Number(info.lastInsertRowid), shipment: get(shipmentId) };
}

function removeLine(shipmentId, lineId) {
  getDb().prepare('DELETE FROM shipment_lines WHERE id = ? AND shipment_id = ?').run(lineId, shipmentId);
  return get(shipmentId);
}

function remove(id) {
  const info = getDb().prepare('DELETE FROM shipments WHERE id = ?').run(id);
  return info.changes > 0;
}

// --- telling students --------------------------------------------------------

const NOTICE_TEMPLATE = {
  shipped: 'parts_shipped',
  arriving_today: 'parts_arriving_today',
  arrived: 'parts_arrived',
};

function alreadyTold(shipmentId, ticketId, kind) {
  return Boolean(
    getDb().prepare('SELECT 1 FROM shipment_notices WHERE shipment_id = ? AND ticket_id = ? AND kind = ?').get(shipmentId, ticketId, kind)
  );
}

function recordTold(shipmentId, ticketId, kind) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO shipment_notices (shipment_id, ticket_id, kind, sent_on, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(shipmentId, ticketId, kind, days.toDayString(new Date()), now());
}

/** What this ticket is waiting for, in words a student can read. */
function ticketPartsSummary(shipment, ticketId) {
  const mine = shipment.lines.filter((l) => l.ticket_id === ticketId);
  const names = mine.map((l) => l.description || l.item_name).filter(Boolean);
  if (!names.length) return 'the parts for your repair';
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * Email the students whose tickets are on this shipment. Deduplicated per
 * shipment/ticket/kind, so re-saving a shipment cannot spam anybody.
 */
async function notifyTickets(shipmentId, kind, { author = null, force = false, today = new Date() } = {}) {
  const shipment = get(shipmentId, today);
  if (!shipment) return { sent: [], skipped: [{ reason: 'no_shipment' }] };
  const templateKey = NOTICE_TEMPLATE[kind];
  if (!templateKey) return { sent: [], skipped: [{ reason: 'unknown_kind' }] };

  const tpl = mailer.getTemplate(templateKey);
  const result = { kind, sent: [], skipped: [], failed: [] };
  if (!tpl) { result.skipped.push({ reason: 'no_template' }); return result; }
  if (!tpl.auto_send && !force) { result.skipped.push({ reason: 'template_off' }); return result; }

  for (const ticketId of shipment.ticket_ids) {
    if (!force && alreadyTold(shipmentId, ticketId, kind)) {
      result.skipped.push({ ticket_id: ticketId, reason: 'already_told' });
      continue;
    }
    const ticket = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
    if (!ticket) continue;
    if (!ticket.user_email) { result.skipped.push({ ticket_id: ticketId, reason: 'no_recipient' }); continue; }

    const res = await mailer.sendStatusEmail(ticket, templateKey, {
      vars: {
        parts_expected_line: expectationSentence(shipment, today),
        parts_expected_date: shipment.expected_label || '',
        parts_summary: ticketPartsSummary(shipment, ticketId),
      },
    });
    if (res.result === 'sent' || res.result === 'dry_run') {
      recordTold(shipmentId, ticketId, kind);
      ticketEvent(ticketId, `told ${ticket.user_email} about parts (${kind.replace(/_/g, ' ')})`, author || 'system');
      result.sent.push({ ticket_id: ticketId, to: res.to, result: res.result });
    } else if (res.result === 'error') {
      ticketEvent(ticketId, `parts email (${kind}) FAILED: ${res.error}`, 'system');
      result.failed.push({ ticket_id: ticketId, error: res.error });
    } else {
      result.skipped.push({ ticket_id: ticketId, reason: res.reason || res.result });
    }
  }
  return result;
}

/** Mark a shipment shipped (optionally with a date) and tell the students. */
async function markShipped(id, { expected_day: expectedDay, notify = true, author = null } = {}) {
  const patch = { status: 'shipped', shipped_at: now() };
  if (expectedDay !== undefined) patch.expected_day = expectedDay;
  const shipment = update(id, patch, { author });
  if (!shipment) return null;
  for (const ticketId of shipment.ticket_ids) {
    ticketEvent(ticketId, `parts shipped${shipment.expected_day ? `, expected ${shipment.expected_day}` : ''}`, author);
  }
  const notices = notify ? await notifyTickets(id, 'shipped', { author }) : { sent: [], skipped: [{ reason: 'not_requested' }] };
  return { shipment: get(id), notices };
}

/**
 * Receive a shipment: add what actually turned up to stock, mark it arrived,
 * and let the waiting students know their parts are here.
 */
async function receive(id, { lines: received = null, notify = true, author = null } = {}) {
  const shipment = get(id);
  if (!shipment) return null;

  const wanted = new Map((received || []).map((l) => [Number(l.id), Math.max(0, Math.trunc(Number(l.received_qty)))]));
  for (const line of shipment.lines) {
    const qty = wanted.has(line.id) ? wanted.get(line.id) : line.qty;
    if (!qty) continue;
    getDb().prepare('UPDATE shipment_lines SET received_qty = ? WHERE id = ?').run(qty, line.id);
    if (line.item_id) {
      inventory.adjust(line.item_id, qty, {
        reason: 'receive',
        ticketId: line.ticket_id,
        note: `received from ${shipment.vendor || 'supplier'}${shipment.tracking_number ? ` (${shipment.tracking_number})` : ''}`,
        author,
      });
    }
  }

  update(id, { status: 'arrived' }, { author });
  // Delivered-but-not-checked-in is now resolved.

  getDb().prepare('UPDATE shipments SET received_at = ?, updated_at = ? WHERE id = ?').run(now(), now(), id);
  for (const ticketId of shipment.ticket_ids) ticketEvent(ticketId, 'parts arrived', author);

  const notices = notify ? await notifyTickets(id, 'arrived', { author }) : { sent: [], skipped: [{ reason: 'not_requested' }] };
  return { shipment: get(id), notices };
}

// --- per-ticket views --------------------------------------------------------

/** Open shipments carrying something for this ticket. */
function incomingForTicket(ticketId, today = new Date()) {
  const rows = getDb()
    .prepare(`SELECT DISTINCT s.* FROM shipments s
              JOIN shipment_lines l ON l.shipment_id = s.id
              WHERE l.ticket_id = ? ORDER BY COALESCE(s.expected_day, '9999-99-99'), s.id DESC`)
    .all(ticketId)
    .map((r) => decorate(r, today));
  return rows;
}

/** The public-facing sentence for a ticket, or '' when nothing is on the way. */
function expectationForTicket(ticketId, today = new Date()) {
  const open = incomingForTicket(ticketId, today).filter((s) => s.open || s.status === 'arrived');
  if (!open.length) return '';
  // Soonest first; an arrived shipment only speaks if nothing is still coming.
  const stillComing = open.filter((s) => s.open);
  const chosen = stillComing.length ? stillComing[0] : open[0];
  return expectationSentence(chosen, today);
}

// --- the daily pass ----------------------------------------------------------

/** "Parts will arrive today" notices, plus the late list for the digest. */
async function dailyPass({ today = new Date(), author = 'system' } = {}) {
  const result = { arriving_today: [], late: [], sent: [], failed: [], skipped: [] };
  for (const shipment of list({ status: 'open', today })) {
    // Already on the doorstep? The "arriving today" note would be nonsense.
    if (shipment.due_today && shipment.status !== 'delivered' && !shipment.delivered_at) {
      result.arriving_today.push(shipment.id);
      const notices = await notifyTickets(shipment.id, 'arriving_today', { author, today });
      result.sent.push(...notices.sent);
      result.failed.push(...notices.failed);
      result.skipped.push(...notices.skipped);
    }
    if (shipment.late) result.late.push(shipment);
  }
  return result;
}

function stats(today = new Date()) {
  const open = list({ status: 'open', today });
  return {
    open: open.length,
    shipped: open.filter((s) => s.status === 'shipped').length,
    ordered: open.filter((s) => s.status === 'ordered').length,
    due_today: open.filter((s) => s.due_today && !s.delivered_at).length,
    delivered_not_received: open.filter((s) => s.delivered_not_received).length,
    late: open.filter((s) => s.late).length,
    tickets_waiting: new Set(open.flatMap((s) => s.ticket_ids)).size,
  };
}

/** Milestones for the shipment that matters most to this ticket. */
function milestonesForTicket(ticketId, today = new Date()) {
  const open = incomingForTicket(ticketId, today);
  if (!open.length) return [];
  const live = open.filter((s) => s.open);
  const chosen = live.length ? live[0] : open[0];
  return chosen.milestones || [];
}

module.exports = {
  STATUSES, OPEN_STATUSES, detectCarrier, trackingUrl, expectationSentence,
  milestones, milestonesForTicket,
  get, list, create, update, remove, addLine, removeLine,
  markShipped, receive, notifyTickets, incomingForTicket, expectationForTicket,
  dailyPass, stats, ticketPartsSummary, fmtDay,
};
