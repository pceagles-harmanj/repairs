'use strict';
/**
 * Device models as records rather than free text.
 *
 * A part says which models it fits (many-to-many: a charger fits the fleet, a
 * screen fits one machine), a donor carcass says which model it is, and from
 * those two facts the app can offer "here is what is worth taking off this
 * donor" and "here is what fits the device on this ticket".
 *
 * The list seeds itself from the models already in your Google fleet, so nobody
 * has to type "Lenovo 300e Chromebook Gen 3" correctly from memory.
 */
const { getDb } = require('./db');

const now = () => new Date().toISOString();

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

const decorate = (row) => ({
  ...row,
  archived: Boolean(row.archived),
  part_count: getDb().prepare('SELECT COUNT(*) AS n FROM item_models WHERE model_id = ?').get(row.id).n,
  donor_count: getDb()
    .prepare("SELECT COUNT(*) AS n FROM inventory_items WHERE model_id = ? AND kind = 'donor_device' AND archived = 0")
    .get(row.id).n,
});

function get(id) {
  const row = getDb().prepare('SELECT * FROM device_models WHERE id = ?').get(id);
  return row ? decorate(row) : null;
}

function byName(name) {
  const row = getDb().prepare('SELECT * FROM device_models WHERE LOWER(name) = LOWER(?)').get(String(name || '').trim());
  return row ? decorate(row) : null;
}

function list({ q, includeArchived = false, limit = 500 } = {}) {
  const where = [];
  const params = { limit: Math.min(Number(limit) || 500, 1000) };
  if (!includeArchived) where.push('archived = 0');
  if (q) {
    where.push("(name LIKE @q OR COALESCE(short_name,'') LIKE @q OR COALESCE(manufacturer,'') LIKE @q)");
    params.q = `%${String(q).trim()}%`;
  }
  return getDb()
    .prepare(`SELECT * FROM device_models ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name LIMIT @limit`)
    .all(params)
    .map(decorate);
}

/** Create, or return the existing one - "add if new" is the common case. */
function ensure(name, extra = {}) {
  const clean = String(name || '').trim();
  if (!clean) throw badRequest('A model name is required');
  const existing = byName(clean);
  if (existing) return existing;
  const ts = now();
  const info = getDb()
    .prepare(
      `INSERT INTO device_models (name, short_name, manufacturer, notes, archived, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`
    )
    .run(clean, extra.short_name || null, extra.manufacturer || guessManufacturer(clean), extra.notes || null, ts, ts);
  return get(Number(info.lastInsertRowid));
}

const KNOWN_MAKERS = ['Lenovo', 'HP', 'Acer', 'Dell', 'ASUS', 'Samsung', 'CTL', 'Apple', 'Google'];
const guessManufacturer = (name) => KNOWN_MAKERS.find((m) => new RegExp(`\\b${m}\\b`, 'i').test(name)) || null;

function update(id, patch = {}) {
  const before = get(id);
  if (!before) return null;
  const sets = [];
  const params = { id, ts: now() };
  for (const field of ['name', 'short_name', 'manufacturer', 'notes']) {
    if (!(field in patch)) continue;
    const value = patch[field] === '' ? null : patch[field];
    if (field === 'name' && !String(value || '').trim()) throw badRequest('A model name is required');
    sets.push(`${field} = @${field}`);
    params[field] = value;
  }
  if ('archived' in patch) { sets.push('archived = @archived'); params.archived = patch.archived ? 1 : 0; }
  if (!sets.length) return before;
  getDb().prepare(`UPDATE device_models SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  return get(id);
}

function remove(id) {
  const used = getDb().prepare('SELECT COUNT(*) AS n FROM item_models WHERE model_id = ?').get(id).n
    + getDb().prepare('SELECT COUNT(*) AS n FROM inventory_items WHERE model_id = ?').get(id).n;
  if (used > 0) {
    update(id, { archived: true });
    return { archived: true };
  }
  return { deleted: getDb().prepare('DELETE FROM device_models WHERE id = ?').run(id).changes > 0 };
}

// --- parts <-> models --------------------------------------------------------

/** The models a part fits. */
function forItem(itemId) {
  return getDb()
    .prepare(
      `SELECT m.* FROM device_models m JOIN item_models im ON im.model_id = m.id
        WHERE im.item_id = ? ORDER BY m.name`
    )
    .all(itemId)
    .map(decorate);
}

/** The parts that fit a model. */
function partsFor(modelId) {
  return getDb()
    .prepare(
      `SELECT i.* FROM inventory_items i JOIN item_models im ON im.item_id = i.id
        WHERE im.model_id = ? AND i.kind = 'part' AND i.archived = 0
        ORDER BY COALESCE(i.category, ''), i.name`
    )
    .all(modelId);
}

/**
 * Replace a part's model links. Accepts ids or names, creating models that do
 * not exist yet - which is what makes "type a new model and carry on" work.
 * The old free-text `fits_models` is kept in step so search and the fitting
 * heuristic keep working for parts nobody has linked up yet.
 */
function setForItem(itemId, models = []) {
  const db = getDb();
  const ids = [];
  for (const entry of models) {
    if (entry === null || entry === undefined || entry === '') continue;
    const model = typeof entry === 'number' || /^\d+$/.test(String(entry))
      ? get(Number(entry))
      : ensure(String(entry));
    if (model) ids.push(model.id);
  }
  const apply = db.transaction(() => {
    db.prepare('DELETE FROM item_models WHERE item_id = ?').run(itemId);
    const insert = db.prepare('INSERT OR IGNORE INTO item_models (item_id, model_id) VALUES (?, ?)');
    for (const id of [...new Set(ids)]) insert.run(itemId, id);
    const names = ids.length
      ? db.prepare(`SELECT name FROM device_models WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY name`)
          .all(...ids).map((r) => r.name).join(', ')
      : null;
    db.prepare('UPDATE inventory_items SET fits_models = ?, updated_at = ? WHERE id = ?').run(names, now(), itemId);
  });
  apply();
  return forItem(itemId);
}

// --- seeding -----------------------------------------------------------------

/**
 * Fill the list from what is actually in the fleet: every distinct model string
 * on a cached Google device, plus anything already typed into a part's
 * fits_models. Safe to run repeatedly.
 */
function seedFromFleet() {
  const db = getDb();
  const seen = new Set(list({ includeArchived: true }).map((m) => m.name.toLowerCase()));
  const candidates = new Set();

  for (const row of db.prepare("SELECT DISTINCT model FROM devices WHERE model IS NOT NULL AND TRIM(model) <> ''").all()) {
    candidates.add(String(row.model).trim());
  }
  for (const row of db.prepare("SELECT DISTINCT fits_models FROM inventory_items WHERE fits_models IS NOT NULL AND TRIM(fits_models) <> ''").all()) {
    for (const piece of String(row.fits_models).split(',')) {
      const name = piece.trim();
      if (name) candidates.add(name);
    }
  }

  let added = 0;
  for (const name of candidates) {
    if (seen.has(name.toLowerCase())) continue;
    ensure(name);
    seen.add(name.toLowerCase());
    added += 1;
  }
  return { added, total: list({ includeArchived: true }).length };
}

/** Link parts to models from their existing free text, once. */
function linkFromFreeText() {
  const db = getDb();
  const unlinked = db
    .prepare(
      `SELECT i.id, i.fits_models FROM inventory_items i
        WHERE i.kind = 'part' AND i.fits_models IS NOT NULL AND TRIM(i.fits_models) <> ''
          AND NOT EXISTS (SELECT 1 FROM item_models im WHERE im.item_id = i.id)`
    )
    .all();
  let linked = 0;
  for (const item of unlinked) {
    const names = String(item.fits_models).split(',').map((n) => n.trim()).filter(Boolean);
    if (!names.length) continue;
    setForItem(item.id, names);
    linked += 1;
  }
  return { linked };
}

module.exports = {
  get, byName, list, ensure, update, remove,
  forItem, partsFor, setForItem, seedFromFleet, linkFromFreeText, guessManufacturer,
};
