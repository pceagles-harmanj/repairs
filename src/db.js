'use strict';
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { STATUSES } = require('./lib/statuses');
const { DEFAULT_TEMPLATES, TEMPLATE_KEYS } = require('./lib/email-templates');

let db;

function open(dbPath = config.dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const handle = new Database(dbPath);
  handle.pragma('journal_mode = WAL');
  handle.pragma('foreign_keys = ON');
  migrate(handle);
  migrateColumns(handle);
  seedTemplates(handle);
  return handle;
}

/** Add a column to an existing install without touching fresh ones. */
function addColumn(handle, table, column, decl) {
  const cols = handle.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) handle.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
}

function migrate(handle) {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );

    -- Local cache of Google Admin device records so the UI stays instant.
    CREATE TABLE IF NOT EXISTS devices (
      device_id      TEXT PRIMARY KEY,
      serial         TEXT,
      asset_tag      TEXT,
      model          TEXT,
      org_unit       TEXT,
      status         TEXT,
      annotated_user TEXT,
      annotated_location TEXT,
      notes          TEXT,
      recent_users   TEXT,      -- JSON array of emails, most recent first
      last_sync      TEXT,
      os_version     TEXT,
      auto_update_expiration TEXT,
      mac_address    TEXT,
      raw            TEXT,      -- full Google payload, JSON
      cached_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_devices_serial ON devices(serial);
    CREATE INDEX IF NOT EXISTS idx_devices_asset ON devices(asset_tag);

    CREATE TABLE IF NOT EXISTS tickets (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id         TEXT,
      serial            TEXT,
      asset_tag         TEXT,
      model             TEXT,
      user_email        TEXT,
      user_name         TEXT,
      issue_category    TEXT,
      issue_description TEXT NOT NULL,
      status            TEXT NOT NULL DEFAULT 'new',
      priority          TEXT NOT NULL DEFAULT 'normal',
      assigned_to       TEXT,
      location          TEXT,
      loaner_serial     TEXT,
      estimated_cost    REAL,
      notify_user       INTEGER NOT NULL DEFAULT 1,
      created_at        TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      closed_at         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_serial ON tickets(serial);
    CREATE INDEX IF NOT EXISTS idx_tickets_user ON tickets(user_email);
    CREATE INDEX IF NOT EXISTS idx_tickets_updated ON tickets(updated_at DESC);

    CREATE TABLE IF NOT EXISTS ticket_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      type        TEXT NOT NULL,   -- created | status | note | email | field
      from_status TEXT,
      to_status   TEXT,
      body        TEXT,
      author      TEXT,
      created_at  TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id, id);

    CREATE TABLE IF NOT EXISTS email_templates (
      status_key TEXT PRIMARY KEY,
      subject    TEXT NOT NULL,
      body       TEXT NOT NULL,
      auto_send  INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS email_log (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      to_email   TEXT NOT NULL,
      subject    TEXT,
      body       TEXT,
      status_key TEXT,
      result     TEXT NOT NULL,   -- sent | dry_run | error | skipped
      error      TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_email_ticket ON email_log(ticket_id, id DESC);

    -- Addresses that asked us to stop emailing entirely (from the public
    -- preferences page). Checked before every send, and when seeding a new ticket.
    CREATE TABLE IF NOT EXISTS email_optouts (
      email      TEXT PRIMARY KEY,
      source     TEXT,
      created_at TEXT NOT NULL
    );

    -- Parts and donor devices live in one list: the kind column tells them
    -- apart, and a donor carries the serial/asset tag of the machine.
    CREATE TABLE IF NOT EXISTS inventory_items (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      kind          TEXT NOT NULL DEFAULT 'part',   -- part | donor_device
      name          TEXT NOT NULL,
      part_number   TEXT,
      category      TEXT,
      fits_models   TEXT,
      location      TEXT,                            -- bin / shelf
      qty_on_hand   INTEGER NOT NULL DEFAULT 0,
      reorder_point INTEGER NOT NULL DEFAULT 0,
      serial        TEXT,                            -- donor devices
      asset_tag     TEXT,
      device_id     TEXT,                            -- Google Admin device, if linked
      donor_status  TEXT,                            -- intact | harvested | exhausted
      notes         TEXT,
      archived      INTEGER NOT NULL DEFAULT 0,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_items_kind ON inventory_items(kind, archived);
    CREATE INDEX IF NOT EXISTS idx_items_name ON inventory_items(name);

    -- Every change to a count, with why and for which ticket. The count on the
    -- item is the running total; this is the audit trail behind it.
    CREATE TABLE IF NOT EXISTS stock_moves (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL REFERENCES inventory_items(id) ON DELETE CASCADE,
      delta      INTEGER NOT NULL,
      reason     TEXT NOT NULL,   -- receive | use | harvest | adjust | scrap | return
      ticket_id  INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      note       TEXT,
      author     TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_moves_item ON stock_moves(item_id, id DESC);
    CREATE INDEX IF NOT EXISTS idx_moves_ticket ON stock_moves(ticket_id);

    -- Parts on the way. One shipment can carry lines for several tickets.
    CREATE TABLE IF NOT EXISTS shipments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor          TEXT,
      carrier         TEXT,
      tracking_number TEXT,
      status          TEXT NOT NULL DEFAULT 'ordered',  -- ordered | shipped | delayed | arrived | cancelled
      ordered_at      TEXT,
      shipped_at      TEXT,
      expected_day    TEXT,     -- YYYY-MM-DD
      received_at     TEXT,
      notes           TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_shipments_status ON shipments(status, expected_day);

    -- Carrier scans, newest last. Kept so the tech side can show where a package
    -- actually is; students only ever see the milestones derived from these.
    CREATE TABLE IF NOT EXISTS shipment_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id  INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      status       TEXT,          -- normalized: pre_transit | in_transit | out_for_delivery | delivered | exception
      code         TEXT,          -- carrier/provider tag, as reported
      description  TEXT,
      location     TEXT,
      happened_at  TEXT,
      created_at   TEXT NOT NULL,
      UNIQUE (shipment_id, happened_at, description)
    );
    CREATE INDEX IF NOT EXISTS idx_ship_events ON shipment_events(shipment_id, happened_at);

    CREATE TABLE IF NOT EXISTS shipment_lines (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id  INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      item_id      INTEGER REFERENCES inventory_items(id) ON DELETE SET NULL,
      description  TEXT,
      qty          INTEGER NOT NULL DEFAULT 1,
      received_qty INTEGER NOT NULL DEFAULT 0,
      ticket_id    INTEGER REFERENCES tickets(id) ON DELETE SET NULL,
      created_at   TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_lines_shipment ON shipment_lines(shipment_id, id);
    CREATE INDEX IF NOT EXISTS idx_lines_ticket ON shipment_lines(ticket_id);

    -- What we have already told each student about a shipment, so nothing is
    -- said twice.
    CREATE TABLE IF NOT EXISTS shipment_notices (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      shipment_id INTEGER NOT NULL REFERENCES shipments(id) ON DELETE CASCADE,
      ticket_id   INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind        TEXT NOT NULL,   -- shipped | arriving_today | arrived
      sent_on     TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      UNIQUE (shipment_id, ticket_id, kind)
    );

    -- One row per reminder actually sent, so a restart or a second pass in the
    -- same day cannot double-email a student.
    CREATE TABLE IF NOT EXISTS loaner_reminders (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_id  INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
      kind       TEXT NOT NULL,     -- due_tomorrow | due_today | overdue
      sent_on    TEXT NOT NULL,     -- YYYY-MM-DD
      due_on     TEXT,
      to_email   TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (ticket_id, kind, sent_on)
    );
    CREATE INDEX IF NOT EXISTS idx_loaner_reminders_ticket ON loaner_reminders(ticket_id, id DESC);

    -- Nightly backup results, so Settings can show whether last night worked.
    CREATE TABLE IF NOT EXISTS backups (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      path       TEXT,
      bytes      INTEGER,
      result     TEXT NOT NULL,   -- ok | error
      error      TEXT,
      duration_ms INTEGER,
      created_at TEXT NOT NULL
    );

    -- Full text search over the things techs actually type into the search box.
    CREATE VIEW IF NOT EXISTS ticket_search AS
      SELECT id,
             COALESCE(serial,'') || ' ' || COALESCE(asset_tag,'') || ' ' ||
             COALESCE(user_email,'') || ' ' || COALESCE(user_name,'') || ' ' ||
             COALESCE(issue_description,'') || ' ' || COALESCE(issue_category,'') || ' ' ||
             COALESCE(assigned_to,'') || ' ' || COALESCE(model,'') AS haystack
      FROM tickets;
  `);
}

function migrateColumns(handle) {
  // Automatic carrier tracking.
  addColumn(handle, 'shipments', 'tracking_status', 'TEXT');
  addColumn(handle, 'shipments', 'tracking_polled_at', 'TEXT');
  addColumn(handle, 'shipments', 'tracking_error', 'TEXT');
  addColumn(handle, 'shipments', 'carrier_eta_day', 'TEXT');
  addColumn(handle, 'shipments', 'delivered_at', 'TEXT');
  addColumn(handle, 'shipments', 'out_for_delivery_at', 'TEXT');

  // The loaner is a real Google device now, linked the same way as the repair unit.
  addColumn(handle, 'tickets', 'loaner_device_id', 'TEXT');
  addColumn(handle, 'tickets', 'loaner_asset_tag', 'TEXT');
  addColumn(handle, 'tickets', 'loaner_model', 'TEXT');
  addColumn(handle, 'tickets', 'loaner_issued_at', 'TEXT');
  addColumn(handle, 'tickets', 'loaner_returned_at', 'TEXT');
  // What we wrote onto the repaired device in Google Admin when the ticket closed.
  addColumn(handle, 'tickets', 'loaner_due_at', 'TEXT'); // YYYY-MM-DD, local days
  addColumn(handle, 'tickets', 'repair_summary', 'TEXT');
  addColumn(handle, 'tickets', 'repair_note_written_at', 'TEXT');

  // Per-ticket notification subscriptions: JSON array of status keys that email
  // the device's user. NULL means "not decided yet" and is seeded from the
  // template auto_send flags the first time the ticket needs it.
  addColumn(handle, 'tickets', 'notify_statuses', 'TEXT');
}

function seedTemplates(handle) {
  const insert = handle.prepare(
    `INSERT OR IGNORE INTO email_templates (status_key, subject, body, auto_send, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))`
  );
  for (const key of TEMPLATE_KEYS) {
    const t = DEFAULT_TEMPLATES[key];
    if (t) insert.run(key, t.subject, t.body, t.auto_send);
  }
}

/**
 * Overwrite the saved templates with the shipped defaults. Used by
 * Settings -> "Reset to the school templates" and `npm run reset-templates`,
 * because seeding only ever fills in gaps (it never clobbers your edits).
 */
function resetTemplates(handle = getDb(), { keepAutoSend = true } = {}) {
  const rows = handle.prepare('SELECT status_key, auto_send FROM email_templates').all();
  const current = Object.fromEntries(rows.map((r) => [r.status_key, r.auto_send]));
  const update = handle.prepare(
    `INSERT INTO email_templates (status_key, subject, body, auto_send, updated_at)
     VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(status_key) DO UPDATE SET subject = excluded.subject, body = excluded.body,
       auto_send = excluded.auto_send, updated_at = datetime('now')`
  );
  let changed = 0;
  for (const key of TEMPLATE_KEYS) {
    const t = DEFAULT_TEMPLATES[key];
    if (!t) continue;
    const autoSend = keepAutoSend && current[key] !== undefined ? current[key] : t.auto_send;
    update.run(key, t.subject, t.body, autoSend);
    changed += 1;
  }
  return changed;
}

function getDb() {
  if (!db) db = open();
  return db;
}

// --- tiny settings helpers ---------------------------------------------------
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  getDb()
    .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value);
}
function deleteSetting(key) {
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(key);
}
function getJsonSetting(key) {
  const raw = getSetting(key);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

module.exports = {
  open, getDb, getSetting, setSetting, deleteSetting, getJsonSetting, addColumn,
  resetTemplates, DEFAULT_TEMPLATES,
};
