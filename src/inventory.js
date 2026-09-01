'use strict';
/**
 * Parts on hand, and donor devices being harvested for them.
 *
 * One list, two kinds: `part` (a shelf of screens, keyboards, chargers) and
 * `donor_device` (a whole machine kept for spares). The count on an item is the
 * running total; every change writes a row to stock_moves, so "where did the
 * last two batteries go" is always answerable.
 */
const { getDb } = require('./db');

const now = () => new Date().toISOString();

const KINDS = ['part', 'donor_device'];
const REASONS = ['receive', 'use', 'harvest', 'adjust', 'scrap', 'return'];
const CATEGORIES = [
  'Screen', 'Keyboard / palmrest', 'Battery', 'Charger', 'Charge port',
  'Trackpad', 'Hinge', 'Bezel / case', 'Speaker', 'Camera', 'Board', 'Cable', 'Other',
];
const DONOR_STATUSES = ['intact', 'harvested', 'exhausted'];

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

// --- items -------------------------------------------------------------------

const decorate = (row) => ({
  ...row,
  archived: Boolean(row.archived),
  low_stock: row.kind === 'part' && row.qty_on_hand <= row.reorder_point && row.reorder_point > 0,
  out_of_stock: row.qty_on_hand <= 0,
  label: row.part_number ? `${row.name} (${row.part_number})` : row.name,
});

function get(id) {
  const row = getDb().prepare('SELECT * FROM inventory_items WHERE id = ?').get(id);
  return row ? decorate(row) : null;
}

function list({ kind, q, category, lowOnly, includeArchived = false, limit = 500 } = {}) {
  const where = [];
  const params = {};
  if (!includeArchived) where.push('archived = 0');
  if (kind && KINDS.includes(kind)) { where.push('kind = @kind'); params.kind = kind; }
  if (category) { where.push('category = @category'); params.category = category; }
  if (q) {
    where.push(`(name LIKE @q OR COALESCE(part_number,'') LIKE @q OR COALESCE(fits_models,'') LIKE @q
                 OR COALESCE(location,'') LIKE @q OR COALESCE(serial,'') LIKE @q OR COALESCE(asset_tag,'') LIKE @q)`);
    params.q = `%${String(q).trim()}%`;
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM inventory_items ${clause}
              ORDER BY kind, CASE WHEN qty_on_hand <= reorder_point THEN 0 ELSE 1 END, name
              LIMIT @limit`)
    .all({ ...params, limit: Math.min(Number(limit) || 500, 2000) })
    .map(decorate);
  return lowOnly ? rows.filter((r) => r.low_stock || r.out_of_stock) : rows;
}

function create(payload = {}, { author = null } = {}) {
  const kind = payload.kind && KINDS.includes(payload.kind) ? payload.kind : 'part';
  const name = String(payload.name || '').trim();
  if (!name) throw badRequest('A name is required');

  const qty = Number.isFinite(Number(payload.qty_on_hand)) ? Math.trunc(Number(payload.qty_on_hand)) : 0;
  const ts = now();
  const info = getDb()
    .prepare(
      `INSERT INTO inventory_items (kind, name, part_number, category, fits_models, location,
         qty_on_hand, reorder_point, serial, asset_tag, device_id, donor_status, notes,
         archived, created_at, updated_at)
       VALUES (@kind, @name, @part_number, @category, @fits_models, @location,
         0, @reorder_point, @serial, @asset_tag, @device_id, @donor_status, @notes,
         0, @ts, @ts)`
    )
    .run({
      kind,
      name,
      part_number: payload.part_number || null,
      category: payload.category || null,
      fits_models: payload.fits_models || null,
      location: payload.location || null,
      reorder_point: Math.max(0, Math.trunc(Number(payload.reorder_point) || 0)),
      serial: payload.serial || null,
      asset_tag: payload.asset_tag || null,
      device_id: payload.device_id || null,
      donor_status: kind === 'donor_device' ? (DONOR_STATUSES.includes(payload.donor_status) ? payload.donor_status : 'intact') : null,
      notes: payload.notes || null,
      ts,
    });

  const id = Number(info.lastInsertRowid);
  // The opening count is a movement like any other, so history starts at zero.
  if (qty !== 0) adjust(id, qty, { reason: 'receive', note: 'opening count', author });
  return get(id);
}

const EDITABLE = ['name', 'part_number', 'category', 'fits_models', 'location', 'reorder_point',
  'serial', 'asset_tag', 'device_id', 'donor_status', 'notes'];

function update(id, patch = {}, { author = null } = {}) {
  const before = get(id);
  if (!before) return null;
  const sets = [];
  const params = { id, ts: now() };
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (field === 'reorder_point') value = Math.max(0, Math.trunc(Number(value) || 0));
    if (value === '') value = null;
    if (String(before[field] ?? '') === String(value ?? '')) continue;
    sets.push(`${field} = @${field}`);
    params[field] = value;
  }
  if ('archived' in patch) { sets.push('archived = @archived'); params.archived = patch.archived ? 1 : 0; }
  if (!sets.length) return before;
  getDb().prepare(`UPDATE inventory_items SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  // Keep history: archive rather than delete when the item has been moved.
  const moves = getDb().prepare('SELECT COUNT(*) AS n FROM stock_moves WHERE item_id = ?').get(id).n;
  if (moves > 0) {
    update(id, { archived: true });
    return { archived: true };
  }
  const info = getDb().prepare('DELETE FROM inventory_items WHERE id = ?').run(id);
  return { deleted: info.changes > 0 };
}

// --- movements ---------------------------------------------------------------

/**
 * Change a count and record why. Negative deltas are refused when they would
 * take a part below zero - a wrong count is better fixed with an explicit
 * adjustment than hidden behind a negative.
 */
function adjust(id, delta, { reason = 'adjust', ticketId = null, note = null, author = null, allowNegative = false } = {}) {
  const item = get(id);
  if (!item) throw badRequest('No such inventory item');
  const step = Math.trunc(Number(delta));
  if (!Number.isFinite(step) || step === 0) throw badRequest('A non-zero whole number is required');
  if (!REASONS.includes(reason)) throw badRequest(`Unknown reason "${reason}"`);

  const next = item.qty_on_hand + step;
  if (next < 0 && !allowNegative) {
    throw badRequest(`Only ${item.qty_on_hand} of ${item.name} on hand`);
  }

  const db = getDb();
  const apply = db.transaction(() => {
    db.prepare('UPDATE inventory_items SET qty_on_hand = ?, updated_at = ? WHERE id = ?').run(next, now(), id);
    db.prepare(
      `INSERT INTO stock_moves (item_id, delta, reason, ticket_id, note, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(id, step, reason, ticketId || null, note || null, author || null, now());
  });
  apply();
  return get(id);
}

function moves({ itemId = null, ticketId = null, limit = 100 } = {}) {
  const where = [];
  const params = {};
  if (itemId) { where.push('m.item_id = @itemId'); params.itemId = itemId; }
  if (ticketId) { where.push('m.ticket_id = @ticketId'); params.ticketId = ticketId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return getDb()
    .prepare(`SELECT m.*, i.name, i.part_number, i.kind FROM stock_moves m
              JOIN inventory_items i ON i.id = m.item_id
              ${clause} ORDER BY m.id DESC LIMIT @limit`)
    .all({ ...params, limit: Math.min(Number(limit) || 100, 500) });
}

/** A tech fitted a part: take it off the shelf and note it on the ticket. */
function useOnTicket(ticketId, itemId, qty = 1, { author = null, note = null } = {}) {
  const item = get(itemId);
  if (!item) throw badRequest('No such inventory item');
  const count = Math.max(1, Math.trunc(Number(qty) || 1));
  const updated = adjust(itemId, -count, { reason: 'use', ticketId, note, author });
  ticketEvent(ticketId, `used ${count} x ${item.label}${item.location ? ` from ${item.location}` : ''}`, author);
  return updated;
}

/** Put a part back on the shelf (wrong part, or the repair was abandoned). */
function returnFromTicket(ticketId, itemId, qty = 1, { author = null } = {}) {
  const item = get(itemId);
  if (!item) throw badRequest('No such inventory item');
  const count = Math.max(1, Math.trunc(Number(qty) || 1));
  const updated = adjust(itemId, count, { reason: 'return', ticketId, note: 'returned to stock', author });
  ticketEvent(ticketId, `returned ${count} x ${item.label} to stock`, author);
  return updated;
}

/**
 * Take a part off a donor machine. Optionally lands it in a part's count -
 * useful when the part goes on the shelf rather than straight into a repair.
 */
function harvest(donorId, { partItemId = null, qty = 1, what = null, ticketId = null, author = null, exhausted = false } = {}) {
  const donor = get(donorId);
  if (!donor) throw badRequest('No such donor device');
  if (donor.kind !== 'donor_device') throw badRequest('That inventory item is not a donor device');
  const count = Math.max(1, Math.trunc(Number(qty) || 1));
  const label = what || (partItemId && get(partItemId) ? get(partItemId).label : 'a part');

  const db = getDb();
  db.prepare(
    `INSERT INTO stock_moves (item_id, delta, reason, ticket_id, note, author, created_at)
     VALUES (?, 0, 'harvest', ?, ?, ?, ?)`
  ).run(donorId, ticketId || null, `harvested ${count} x ${label}`, author || null, now());

  const donorState = exhausted ? 'exhausted' : 'harvested';
  db.prepare('UPDATE inventory_items SET donor_status = ?, updated_at = ? WHERE id = ?').run(donorState, now(), donorId);
  if (exhausted && donor.qty_on_hand > 0) {
    adjust(donorId, -donor.qty_on_hand, { reason: 'scrap', note: 'donor exhausted', author, allowNegative: true });
  }

  let part = null;
  if (partItemId) {
    part = adjust(partItemId, count, {
      reason: 'harvest',
      ticketId,
      note: `harvested from ${donor.name}${donor.asset_tag ? ` (${donor.asset_tag})` : ''}`,
      author,
    });
  }
  ticketEvent(ticketId, `harvested ${count} x ${label} from donor ${donor.asset_tag || donor.name}`, author);
  return { donor: get(donorId), part };
}

// --- views -------------------------------------------------------------------

// How a movement reads on a ticket. "receive" lands here when a shipment line
// was ordered for this ticket, and a zero-delta harvest is the donor's own log.
const DIRECTION = {
  use: 'used',
  return: 'returned to stock',
  receive: 'arrived for this ticket',
  harvest: 'harvested',
  scrap: 'scrapped',
  adjust: 'adjusted',
};

/** What went into this ticket, and what it cost the shelf. */
function partsForTicket(ticketId) {
  return moves({ ticketId, limit: 200 })
    .map((m) => ({
      move_id: m.id,
      item_id: m.item_id,
      name: m.name,
      part_number: m.part_number,
      kind: m.kind,
      qty: Math.abs(m.delta) || null,
      direction: DIRECTION[m.reason] || m.reason,
      fitted: m.reason === 'use',
      reason: m.reason,
      note: m.note,
      author: m.author,
      created_at: m.created_at,
    }))
    // Parts actually fitted first; everything else is context underneath.
    .sort((a, b) => Number(b.fitted) - Number(a.fitted) || b.move_id - a.move_id);
}

function stats() {
  const db = getDb();
  const parts = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(qty_on_hand), 0) AS units FROM inventory_items WHERE kind = 'part' AND archived = 0").get();
  const donors = db.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(qty_on_hand), 0) AS units FROM inventory_items WHERE kind = 'donor_device' AND archived = 0").get();
  const low = db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE kind = 'part' AND archived = 0 AND reorder_point > 0 AND qty_on_hand <= reorder_point").get().n;
  const out = db.prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE kind = 'part' AND archived = 0 AND qty_on_hand <= 0").get().n;
  const used30 = db.prepare("SELECT COALESCE(SUM(-delta), 0) AS n FROM stock_moves WHERE reason = 'use' AND created_at >= datetime('now', '-30 days')").get().n;
  return {
    part_lines: parts.n,
    part_units: parts.units,
    donor_lines: donors.n,
    donor_units: donors.units,
    low_stock: low,
    out_of_stock: out,
    used_last_30_days: used30,
  };
}

module.exports = {
  KINDS, REASONS, CATEGORIES, DONOR_STATUSES,
  get, list, create, update, remove, adjust, moves,
  useOnTicket, returnFromTicket, harvest, partsForTicket, stats,
};
