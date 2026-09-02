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
const models = require('./models');

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
  ...(row.kind === 'donor_device'
    ? (() => {
        const taken = getDb()
          .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS last FROM stock_moves WHERE item_id = ? AND reason = 'harvest'")
          .get(row.id);
        return { harvest_count: taken.n, last_harvest_at: taken.last || null };
      })()
    : {}),
  model_name: row.model_id
    ? (getDb().prepare('SELECT name FROM device_models WHERE id = ?').get(row.model_id) || {}).name || null
    : null,
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
  if (payload.model_name) setModel(id, payload.model_name);
  // The opening count is a movement like any other, so history starts at zero.
  if (qty !== 0) adjust(id, qty, { reason: 'receive', note: 'opening count', author });
  return get(id);
}

/** Point an item at a device model, creating the model if it is new. */
function setModel(id, name) {
  const clean = String(name || '').trim();
  const model = clean ? models.ensure(clean) : null;
  getDb().prepare('UPDATE inventory_items SET model_id = ?, updated_at = ? WHERE id = ?').run(model ? model.id : null, now(), id);
  return model;
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
  if ('model_name' in patch) setModel(id, patch.model_name);
  if (!sets.length) return get(id);
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

// --- donor parts -------------------------------------------------------------

const DONOR_PART_STATES = ['available', 'taken', 'broken'];

/** What is worth taking off this carcass, and what has already gone. */
function donorParts(donorId) {
  return getDb()
    .prepare(
      `SELECT p.*, i.name AS item_name, i.part_number, i.qty_on_hand
         FROM donor_parts p LEFT JOIN inventory_items i ON i.id = p.item_id
        WHERE p.donor_id = ?
        ORDER BY CASE p.state WHEN 'available' THEN 0 WHEN 'taken' THEN 1 ELSE 2 END, p.id`
    )
    .all(donorId);
}

/**
 * Add salvageable parts to a donor: either real inventory parts (usually ticked
 * off the model's part list) or free text for the things no part row covers -
 * "wifi card", "good bezel screws".
 */
function addDonorParts(donorId, entries = [], { author = null } = {}) {
  const donor = get(donorId);
  if (!donor) throw badRequest('No such donor device');
  if (donor.kind !== 'donor_device') throw badRequest('That inventory item is not a donor device');

  const insert = getDb().prepare(
    `INSERT INTO donor_parts (donor_id, item_id, label, state, note, created_at)
     VALUES (?, ?, ?, 'available', ?, ?)`
  );
  const added = [];
  const apply = getDb().transaction(() => {
    for (const entry of entries) {
      const itemId = entry && entry.item_id ? Number(entry.item_id) : null;
      const part = itemId ? get(itemId) : null;
      const label = String((entry && entry.label) || (part && part.label) || '').trim();
      if (!label) continue;
      const info = insert.run(donorId, part ? part.id : null, label, (entry && entry.note) || null, now());
      added.push(Number(info.lastInsertRowid));
    }
  });
  apply();
  if (added.length) {
    getDb()
      .prepare("UPDATE inventory_items SET donor_status = COALESCE(donor_status, 'intact'), updated_at = ? WHERE id = ?")
      .run(now(), donorId);
  }
  return donorParts(donorId);
}

function setDonorPartState(partId, state, { author = null, note = null } = {}) {
  if (!DONOR_PART_STATES.includes(state)) throw badRequest(`Unknown state "${state}"`);
  const row = getDb().prepare('SELECT * FROM donor_parts WHERE id = ?').get(partId);
  if (!row) throw badRequest('No such donor part');
  getDb()
    .prepare(
      `UPDATE donor_parts SET state = ?, note = COALESCE(?, note),
         taken_at = CASE WHEN ? = 'taken' THEN COALESCE(taken_at, ?) ELSE NULL END,
         taken_by = CASE WHEN ? = 'taken' THEN ? ELSE NULL END,
         taken_ticket_id = CASE WHEN ? = 'taken' THEN taken_ticket_id ELSE NULL END
       WHERE id = ?`
    )
    .run(state, note, state, now(), state, author, state, partId);
  refreshDonorStatus(row.donor_id);
  return getDb().prepare('SELECT * FROM donor_parts WHERE id = ?').get(partId);
}

function removeDonorPart(partId) {
  const row = getDb().prepare('SELECT * FROM donor_parts WHERE id = ?').get(partId);
  if (!row) return false;
  getDb().prepare('DELETE FROM donor_parts WHERE id = ?').run(partId);
  refreshDonorStatus(row.donor_id);
  return true;
}

/** intact -> harvested -> exhausted, worked out from the parts list. */
function refreshDonorStatus(donorId) {
  const rows = donorParts(donorId);
  if (!rows.length) return;
  const available = rows.filter((r) => r.state === 'available').length;
  const taken = rows.filter((r) => r.state === 'taken').length;
  const status = available === 0 ? 'exhausted' : taken > 0 ? 'harvested' : 'intact';
  getDb().prepare('UPDATE inventory_items SET donor_status = ?, updated_at = ? WHERE id = ?').run(status, now(), donorId);
}

// --- what went into a repair -------------------------------------------------

const PART_SOURCES = ['stock', 'donor', 'purchased'];

function ticketParts(ticketId) {
  return getDb()
    .prepare(
      `SELECT p.*, i.name AS item_name, i.part_number, d.name AS donor_name, d.asset_tag AS donor_asset_tag
         FROM ticket_parts p
         LEFT JOIN inventory_items i ON i.id = p.item_id
         LEFT JOIN inventory_items d ON d.id = p.donor_id
        WHERE p.ticket_id = ? AND p.removed_at IS NULL
        ORDER BY p.id DESC`
    )
    .all(ticketId)
    .map((r) => ({ ...r, line_cost: r.unit_cost == null ? null : Math.round(r.unit_cost * r.qty * 100) / 100 }));
}

function ticketPartsCost(ticketId) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(unit_cost * qty), 0) AS total FROM ticket_parts
        WHERE ticket_id = ? AND removed_at IS NULL AND unit_cost IS NOT NULL`
    )
    .get(ticketId);
  return Math.round(row.total * 100) / 100;
}

/**
 * Fit a part to a repair. Three provenances, one record:
 *   stock     - comes off the shelf, so the count drops
 *   donor     - comes off a specific carcass, so that donor part is marked taken
 *   purchased - bought for this repair, never stocked, but still costs money
 */
function fitPart(ticketId, spec = {}, { author = null } = {}) {
  const source = PART_SOURCES.includes(spec.source) ? spec.source : 'stock';
  const qty = Math.max(1, Math.trunc(Number(spec.qty) || 1));
  const cost = spec.unit_cost === '' || spec.unit_cost == null ? null : Number(spec.unit_cost);
  if (cost != null && !Number.isFinite(cost)) throw badRequest('Cost must be a number');

  let itemId = null;
  let donorId = null;
  let donorPartId = null;
  let description = String(spec.description || '').trim();

  if (source === 'stock') {
    const item = get(Number(spec.item_id));
    if (!item) throw badRequest('Pick a part from stock');
    adjust(item.id, -qty, { reason: 'use', ticketId, author, note: spec.note || null });
    itemId = item.id;
    description = description || item.label;
    ticketEvent(ticketId, `used ${qty} x ${item.label}${item.location ? ` from ${item.location}` : ''}`, author);
  } else if (source === 'donor') {
    const part = getDb().prepare('SELECT * FROM donor_parts WHERE id = ?').get(Number(spec.donor_part_id));
    if (!part) throw badRequest('Pick a part from a donor device');
    if (part.state !== 'available') throw badRequest(`That donor part is already marked "${part.state}"`);
    const donor = get(part.donor_id);
    getDb()
      .prepare("UPDATE donor_parts SET state = 'taken', taken_at = ?, taken_by = ?, taken_ticket_id = ? WHERE id = ?")
      .run(now(), author, ticketId, part.id);
    refreshDonorStatus(part.donor_id);
    getDb()
      .prepare(
        `INSERT INTO stock_moves (item_id, delta, reason, ticket_id, note, author, source, created_at)
         VALUES (?, 0, 'harvest', ?, ?, ?, 'donor', ?)`
      )
      .run(part.donor_id, ticketId, `took ${part.label} for this repair`, author, now());
    itemId = part.item_id;
    donorId = part.donor_id;
    donorPartId = part.id;
    description = description || part.label;
    ticketEvent(ticketId, `fitted ${part.label} taken from donor ${donor.asset_tag || donor.name}`, author);
  } else {
    if (!description) throw badRequest('Say what was bought');
    ticketEvent(
      ticketId,
      `fitted ${qty} x ${description} bought for this repair${spec.vendor ? ` from ${spec.vendor}` : ''}${cost != null ? ` at $${cost.toFixed(2)} each` : ''}`,
      author
    );
  }

  const info = getDb()
    .prepare(
      `INSERT INTO ticket_parts (ticket_id, source, item_id, donor_id, donor_part_id, description, qty,
         unit_cost, vendor, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ticketId, source, itemId, donorId, donorPartId, description, qty, cost,
      spec.vendor || null, author, now());
  return { id: Number(info.lastInsertRowid), parts: ticketParts(ticketId), cost: ticketPartsCost(ticketId) };
}

/** Undo a fitted part: stock goes back, a donor part becomes available again. */
function unfitPart(ticketId, partId, { author = null } = {}) {
  const row = getDb().prepare('SELECT * FROM ticket_parts WHERE id = ? AND ticket_id = ?').get(partId, ticketId);
  if (!row) throw badRequest('No such part on this ticket');
  if (row.removed_at) return { parts: ticketParts(ticketId), cost: ticketPartsCost(ticketId) };

  if (row.source === 'stock' && row.item_id) {
    adjust(row.item_id, row.qty, { reason: 'return', ticketId, author, note: 'taken back off the repair' });
    ticketEvent(ticketId, `returned ${row.qty} x ${row.description} to stock`, author);
  } else if (row.source === 'donor' && row.donor_part_id) {
    getDb()
      .prepare("UPDATE donor_parts SET state = 'available', taken_at = NULL, taken_by = NULL, taken_ticket_id = NULL WHERE id = ?")
      .run(row.donor_part_id);
    refreshDonorStatus(row.donor_id);
    ticketEvent(ticketId, `put ${row.description} back on the donor`, author);
  } else {
    ticketEvent(ticketId, `removed ${row.description} from this repair`, author);
  }
  getDb().prepare('UPDATE ticket_parts SET removed_at = ? WHERE id = ?').run(now(), partId);
  return { parts: ticketParts(ticketId), cost: ticketPartsCost(ticketId) };
}

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

/** How fast a part is going: the number that turns a low-stock flag into a decision. */
function usage(itemId, { days = 30 } = {}) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(-delta), 0) AS used, COUNT(DISTINCT ticket_id) AS tickets
         FROM stock_moves
        WHERE item_id = ? AND reason = 'use' AND created_at >= datetime('now', ?)`
    )
    .get(itemId, `-${Math.max(1, Math.trunc(days))} days`);
  return { days, used: row.used, tickets: row.tickets };
}

/** What has been taken off a donor, newest first. */
function harvests(donorId, limit = 20) {
  return getDb()
    .prepare(
      `SELECT id, note, ticket_id, author, created_at FROM stock_moves
        WHERE item_id = ? AND reason = 'harvest' ORDER BY id DESC LIMIT ?`
    )
    .all(donorId, limit);
}

/** Quantity of this part sitting on open shipments. */
function onOrder(itemId) {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(l.qty - l.received_qty), 0) AS qty
         FROM shipment_lines l JOIN shipments s ON s.id = l.shipment_id
        WHERE l.item_id = ? AND s.status IN ('ordered','shipped','delivered','delayed')`
    )
    .get(itemId);
  return row.qty;
}

/** Everything about one item, for the detail view. */
function detail(id) {
  const item = get(id);
  if (!item) return null;
  const isDonor = item.kind === 'donor_device';
  return {
    ...item,
    moves: moves({ itemId: id, limit: 100 }),
    usage_30: usage(id, { days: 30 }),
    usage_90: usage(id, { days: 90 }),
    on_order: isDonor ? 0 : onOrder(id),
    harvests: isDonor ? harvests(id) : [],
    donor_parts: isDonor ? donorParts(id) : [],
    models: isDonor ? (item.model_id ? [models.get(item.model_id)].filter(Boolean) : []) : models.forItem(id),
    tickets: getDb()
      .prepare(
        `SELECT DISTINCT m.ticket_id, t.status, t.asset_tag, t.issue_category, t.created_at
           FROM stock_moves m JOIN tickets t ON t.id = m.ticket_id
          WHERE m.item_id = ? AND m.ticket_id IS NOT NULL AND m.reason IN ('use','harvest')
          ORDER BY m.ticket_id DESC LIMIT 25`
      )
      .all(id),
    last_received: getDb()
      .prepare(
        `SELECT created_at, note FROM stock_moves WHERE item_id = ? AND reason = 'receive'
          ORDER BY id DESC LIMIT 1`
      )
      .get(id) || null,
  };
}

/**
 * Parts that fit a given device model, best match first. "Lenovo 300e
 * Chromebook Gen 3" should find a part whose fits_models says "Lenovo 300e",
 * so matching is done on words, not on the whole string.
 */
// Words that appear in every model name and therefore distinguish nothing.
// Without this, an HP part "fits" a Lenovo because both say "chromebook".
const GENERIC_MODEL_WORDS = new Set([
  'chromebook', 'chromebooks', 'laptop', 'notebook', 'gen', 'generation', 'series',
  'inch', 'education', 'edition', 'google', 'model', 'the', 'for', 'and', 'with', 'ee',
]);

function fitting(model, { limit = 25 } = {}) {
  const text = String(model || '').toLowerCase();
  if (!text) return [];
  const all = [...new Set(text.split(/[^a-z0-9]+/).filter((w) => w.length >= 2))];
  // Distinctive words only: "lenovo", "300e" - not "chromebook", "gen".
  const words = all.filter((w) => !GENERIC_MODEL_WORDS.has(w) && w.length >= 3);
  if (!words.length) return [];
  const rows = list({ kind: 'part', limit: 500 });
  return rows
    .map((item) => {
      const fits = String(item.fits_models || '').toLowerCase();
      if (!fits) return { ...item, fit_score: 0 };
      const hits = words.filter((w) => fits.includes(w)).length;
      // a full mention of the model beats a couple of shared words
      const exact = fits.includes(text) ? 5 : 0;
      return { ...item, fit_score: hits + exact };
    })
    .filter((i) => i.fit_score > 0)
    .sort((a, b) => b.fit_score - a.fit_score || b.qty_on_hand - a.qty_on_hand)
    .slice(0, limit);
}

/**
 * The shopping list: everything at or below its reorder point, with how fast it
 * is going and a suggested quantity, so the flag becomes an order.
 */
function shoppingList() {
  const items = list({ kind: 'part', limit: 1000 }).filter((i) => i.low_stock || i.out_of_stock);
  return items
    .map((item) => {
      const u30 = usage(item.id, { days: 30 });
      const u90 = usage(item.id, { days: 90 });
      const ordered = onOrder(item.id);
      // Enough to get back above the reorder point, plus a month's usage,
      // minus whatever is already on the way. Rounded up to something sane.
      const target = Math.max(item.reorder_point * 2, item.reorder_point + u30.used, 1);
      const suggested = Math.max(0, target - item.qty_on_hand - ordered);
      return {
        ...item,
        used_30: u30.used,
        used_90: u90.used,
        on_order: ordered,
        suggested_qty: suggested,
        // months of cover left at the current rate, for judging urgency
        months_left: u30.used > 0 ? Math.round((item.qty_on_hand / u30.used) * 10) / 10 : null,
      };
    })
    .sort((a, b) => Number(b.out_of_stock) - Number(a.out_of_stock) || b.used_30 - a.used_30);
}

/** The shopping list as text you can paste into an order or an email. */
function shoppingListText(rows = shoppingList()) {
  if (!rows.length) return 'Nothing is below its reorder point.';
  const lines = rows.map((r) => {
    const bits = [
      `${r.suggested_qty} x ${r.name}`,
      r.part_number ? `(${r.part_number})` : null,
      r.fits_models ? `for ${r.fits_models}` : null,
      `- ${r.qty_on_hand} on hand${r.on_order ? `, ${r.on_order} on order` : ''}`,
      r.used_30 ? `, ${r.used_30} used in 30 days` : '',
    ].filter(Boolean);
    return bits.join(' ');
  });
  return lines.join('\n');
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
  KINDS, REASONS, CATEGORIES, DONOR_STATUSES, DONOR_PART_STATES, PART_SOURCES,
  get, detail, list, create, update, remove, adjust, moves,
  useOnTicket, returnFromTicket, harvest, partsForTicket, stats,
  usage, harvests, onOrder, fitting, shoppingList, shoppingListText,
  setModel, donorParts, addDonorParts, setDonorPartState, removeDonorPart, refreshDonorStatus,
  ticketParts, ticketPartsCost, fitPart, unfitPart,
};
