'use strict';
/** Ticket data + lifecycle rules. The routes are a thin shell over this. */
const { getDb } = require('./db');
const config = require('./config');
const google = require('./google');
const mailer = require('./mailer');
const schoolDays = require('./lib/schooldays');
const subscriptions = require('./subscriptions');
const { STATUS_KEYS, OPEN_STATUS_KEYS, PRIORITY_KEYS, statusLabel, canonicalStatus } = require('./lib/statuses');

const now = () => new Date().toISOString();

const EDITABLE = [
  'device_id', 'serial', 'asset_tag', 'model', 'user_email', 'user_name',
  'issue_category', 'issue_description', 'priority', 'assigned_to', 'location',
  'loaner_serial', 'loaner_device_id', 'loaner_asset_tag', 'loaner_model',
  'estimated_cost', 'notify_user',
];

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

function addEvent(ticketId, event) {
  getDb()
    .prepare(
      `INSERT INTO ticket_events (ticket_id, type, from_status, to_status, body, author, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(ticketId, event.type, event.from_status || null, event.to_status || null, event.body || null, event.author || null, now());
}

function get(id) {
  return getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id) || null;
}

function events(ticketId) {
  return getDb().prepare('SELECT * FROM ticket_events WHERE ticket_id = ? ORDER BY id ASC').all(ticketId);
}

function detail(id) {
  const ticket = get(id);
  if (!ticket) return null;
  return {
    ...ticket,
    loaner_outstanding: Boolean(ticket.loaner_device_id || ticket.loaner_serial) && !ticket.loaner_returned_at,
    loaner_due: require('./loaners').dueInfo(ticket),
    parts_used: require('./inventory').partsForTicket(ticket.id),
    parts_fitted: require('./inventory').ticketParts(ticket.id),
    parts_cost: require('./inventory').ticketPartsCost(ticket.id),
    parts_incoming: require('./shipments').incomingForTicket(ticket.id),
    loaner_reminders_sent: getDb()
      .prepare('SELECT kind, sent_on FROM loaner_reminders WHERE ticket_id = ? ORDER BY id')
      .all(ticket.id),
    subscribed_statuses: subscriptions.parse(ticket),
    user_unsubscribed: subscriptions.isOptedOut(ticket.user_email),
    events: events(id),
    emails: mailer.ticketEmails(id),
  };
}

function list({ status, q, assignee, limit = 100, offset = 0 } = {}) {
  const where = [];
  const params = {};

  if (!status || status === 'open') {
    where.push(`status IN (${OPEN_STATUS_KEYS.map((s) => `'${s}'`).join(',')})`);
  } else if (status !== 'all') {
    const keys = String(status).split(',').map((s) => s.trim()).filter((s) => STATUS_KEYS.includes(s));
    if (!keys.length) throw badRequest('Unknown status filter');
    where.push(`status IN (${keys.map((_, i) => `@s${i}`).join(',')})`);
    keys.forEach((k, i) => { params[`s${i}`] = k; });
  }

  if (assignee) { where.push('LOWER(COALESCE(assigned_to,\'\')) = LOWER(@assignee)'); params.assignee = assignee; }

  if (q) {
    where.push(`id IN (SELECT id FROM ticket_search WHERE haystack LIKE @q)`);
    params.q = `%${String(q).trim()}%`;
  }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const rows = getDb()
    .prepare(`SELECT * FROM tickets ${clause} ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        updated_at DESC
      LIMIT @limit OFFSET @offset`)
    .all({ ...params, limit: Math.min(Number(limit) || 100, 500), offset: Number(offset) || 0 });
  const total = getDb().prepare(`SELECT COUNT(*) AS n FROM tickets ${clause}`).get(params).n;
  return { tickets: rows, total };
}

function validate(payload) {
  if (!payload.issue_description || !String(payload.issue_description).trim()) {
    throw badRequest('issue_description is required');
  }
  if (payload.priority && !PRIORITY_KEYS.includes(payload.priority)) throw badRequest('Unknown priority');
  if (payload.status && !STATUS_KEYS.includes(payload.status)) throw badRequest('Unknown status');
  if (payload.user_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(payload.user_email)) throw badRequest('user_email is not a valid email address');
}

async function create(payload, { author = null, notify } = {}) {
  if (payload.status) payload = { ...payload, status: canonicalStatus(payload.status) };
  validate(payload);
  const ts = now();
  const row = {
    device_id: payload.device_id || null,
    serial: payload.serial || null,
    asset_tag: payload.asset_tag || null,
    model: payload.model || null,
    user_email: payload.user_email ? String(payload.user_email).trim().toLowerCase() : null,
    user_name: payload.user_name || null,
    issue_category: payload.issue_category || null,
    issue_description: String(payload.issue_description).trim(),
    status: canonicalStatus(payload.status) || 'received',
    priority: payload.priority || 'normal',
    assigned_to: payload.assigned_to || author || null,
    location: payload.location || null,
    loaner_serial: payload.loaner_serial || null,
    loaner_device_id: payload.loaner_device_id || null,
    loaner_asset_tag: payload.loaner_asset_tag || null,
    loaner_model: payload.loaner_model || null,
    loaner_issued_at: payload.loaner_device_id || payload.loaner_asset_tag || payload.loaner_serial ? ts : null,
    estimated_cost: payload.estimated_cost === '' || payload.estimated_cost == null ? null : Number(payload.estimated_cost),
    notify_user: payload.notify_user === false || payload.notify_user === 0 ? 0 : 1,
    created_at: ts,
    updated_at: ts,
  };

  const info = getDb()
    .prepare(
      `INSERT INTO tickets (device_id, serial, asset_tag, model, user_email, user_name, issue_category,
        issue_description, status, priority, assigned_to, location, loaner_serial, loaner_device_id,
        loaner_asset_tag, loaner_model, loaner_issued_at, estimated_cost,
        notify_user, created_at, updated_at)
       VALUES (@device_id, @serial, @asset_tag, @model, @user_email, @user_name, @issue_category,
        @issue_description, @status, @priority, @assigned_to, @location, @loaner_serial, @loaner_device_id,
        @loaner_asset_tag, @loaner_model, @loaner_issued_at, @estimated_cost,
        @notify_user, @created_at, @updated_at)`
    )
    .run(row);

  const id = Number(info.lastInsertRowid);
  addEvent(id, { type: 'created', to_status: row.status, author, body: payload.initial_note || null });

  // Seed this ticket's own notification list (from the template defaults unless
  // the caller specified one, and empty if the address has unsubscribed).
  if (Array.isArray(payload.notify_statuses)) {
    subscriptions.save(id, subscriptions.isOptedOut(row.user_email) ? [] : payload.notify_statuses);
  } else {
    subscriptions.ensure(get(id));
  }

  const ticket = get(id);
  const email = await maybeEmail(ticket, row.status, { notify, author, note: payload.initial_note });
  return { ticket: get(id), email };
}

/** Auto-send rules: ticket opted in, template opted in, caller did not say no. */
async function maybeEmail(ticket, statusKey, { notify, note } = {}) {
  if (notify === false) return { result: 'skipped', reason: 'not_requested' };
  const tpl = mailer.getTemplate(statusKey);
  if (!tpl) return { result: 'skipped', reason: 'no_template' };
  if (notify !== true) {
    // This ticket's own subscription list decides (see src/subscriptions.js).
    const decision = subscriptions.decide(ticket, statusKey);
    if (!decision.send) return { result: 'skipped', reason: decision.reason };
  }
  const res = await mailer.sendStatusEmail(ticket, statusKey, { note });
  if (res.result === 'sent' || res.result === 'dry_run') {
    addEvent(ticket.id, {
      type: 'email',
      body: `${res.result === 'dry_run' ? '[dry run] ' : ''}Emailed ${res.to}: ${res.subject}`,
      author: 'system',
    });
  } else if (res.result === 'error') {
    addEvent(ticket.id, { type: 'email', body: `Email to ${res.to} FAILED: ${res.error}`, author: 'system' });
  }
  return res;
}

async function update(id, patch = {}, { author = null, notify, note } = {}) {
  const before = get(id);
  if (!before) return null;
  // Translate a renamed status before anything validates it.
  if (patch.status) patch = { ...patch, status: canonicalStatus(patch.status) };
  validate({ ...before, ...patch });

  const sets = [];
  const params = { id };
  const changes = [];

  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (field === 'user_email' && value) value = String(value).trim().toLowerCase();
    if (field === 'estimated_cost') value = value === '' || value == null ? null : Number(value);
    if (field === 'notify_user') value = value ? 1 : 0;
    if (value === '') value = null;
    if (String(before[field] ?? '') === String(value ?? '')) continue;
    sets.push(`${field} = @${field}`);
    params[field] = value;
    changes.push({ field, from: before[field], to: value });
  }

  if (Array.isArray(patch.notify_statuses)) {
    const wanted = subscriptions.clean(patch.notify_statuses);
    const current = subscriptions.parse(before);
    if (wanted.join(',') !== current.join(',')) {
      subscriptions.save(id, wanted);
      addEvent(id, {
        type: 'field',
        body: `email notifications: ${wanted.length ? wanted.map(statusLabel).join(', ') : 'none'}`,
        author,
      });
    }
  }

  let statusChanged = false;
  if (patch.status && patch.status !== before.status) {
    if (!STATUS_KEYS.includes(patch.status)) throw badRequest('Unknown status');
    sets.push('status = @status');
    params.status = patch.status;
    statusChanged = true;
    const closing = patch.status === 'closed' || patch.status === 'cancelled';
    sets.push('closed_at = @closed_at');
    params.closed_at = closing ? now() : null;
  }

  if (sets.length) {
    sets.push('updated_at = @updated_at');
    params.updated_at = now();
    getDb().prepare(`UPDATE tickets SET ${sets.join(', ')} WHERE id = @id`).run(params);
  }

  for (const c of changes) {
    addEvent(id, { type: 'field', body: `${c.field}: ${c.from ?? '-'} -> ${c.to ?? '-'}`, author });
  }
  if (statusChanged) {
    addEvent(id, { type: 'status', from_status: before.status, to_status: patch.status, body: note || null, author });
  } else if (note) {
    addEvent(id, { type: 'note', body: note, author });
  }

  let after = get(id);

  // Closing a ticket records the repair on the device itself, so the next tech
  // to open that Chromebook in Admin sees its history.
  let repairNote = null;
  const closing = statusChanged && patch.status === 'closed';
  if (closing && (config.repairNote.onClose || patch.repair_summary) && after.device_id) {
    repairNote = await writeRepairNote(id, { summary: patch.repair_summary, author });
    after = get(id);
  }

  let email = { result: 'skipped', reason: 'no_status_change' };
  if (statusChanged) email = await maybeEmail(after, after.status, { notify, note });
  else if (notify === true) email = await maybeEmail(after, after.status, { notify: true, note });

  return { ticket: get(id), email, status_changed: statusChanged, repair_note: repairNote };
}

async function addNote(id, { body, author = null, notify = false } = {}) {
  const ticket = get(id);
  if (!ticket) return null;
  if (!body || !String(body).trim()) throw badRequest('Note body is required');
  const text = String(body).trim();
  addEvent(id, { type: 'note', body: text, author });
  getDb().prepare('UPDATE tickets SET updated_at = ? WHERE id = ?').run(now(), id);
  let email = { result: 'skipped', reason: 'not_requested' };
  if (notify) email = await maybeEmail(get(id), ticket.status, { notify: true, note: text });
  return { ticket: get(id), email };
}

// --- loaners -----------------------------------------------------------------

/** Link a Google device as this ticket's loaner and stamp the checkout time. */
function issueLoaner(id, device, options = {}) {
  const { author = null } = options;
  const ticket = get(id);
  if (!ticket) return null;
  if (!device || !(device.device_id || device.asset_tag || device.serial)) throw badRequest('A loaner device is required');

  const ts = now();
  // Due back after the configured number of school days, weekends and holidays
  // skipped, unless the caller set a date explicitly.
  const dueDay = options.due_day || schoolDays.defaultDueDay(new Date(ts));

  getDb()
    .prepare(
      `UPDATE tickets SET loaner_device_id = @device_id, loaner_asset_tag = @asset_tag,
         loaner_serial = @serial, loaner_model = @model, loaner_issued_at = @now,
         loaner_returned_at = NULL, loaner_due_at = @due, updated_at = @now WHERE id = @id`
    )
    .run({
      id,
      device_id: device.device_id || null,
      asset_tag: device.asset_tag || null,
      serial: device.serial || null,
      model: device.model || null,
      due: dueDay,
      now: ts,
    });

  // A fresh loan starts a fresh reminder history.
  getDb().prepare('DELETE FROM loaner_reminders WHERE ticket_id = ?').run(id);

  const label = device.asset_tag || device.serial || device.device_id;
  addEvent(id, {
    type: 'field',
    body: `loaner issued: ${label}${device.model ? ` (${device.model})` : ''}, due back ${dueDay}`,
    author,
  });
  return get(id);
}

/** Mark the loaner returned. The link stays on the ticket as history. */
function returnLoaner(id, { author = null } = {}) {
  const ticket = get(id);
  if (!ticket) return null;
  if (!ticket.loaner_device_id && !ticket.loaner_serial) throw badRequest('No loaner is issued on this ticket');
  if (ticket.loaner_returned_at) return ticket;
  const ts = now();
  getDb().prepare('UPDATE tickets SET loaner_returned_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, id);
  const outFor = ticket.loaner_issued_at
    ? ` after ${schoolDays.calendarDaysBetween(schoolDays.toDayString(new Date(ticket.loaner_issued_at)), schoolDays.toDayString(new Date(ts)))} days`
    : '';
  const late = ticket.loaner_due_at && schoolDays.toDayString(new Date(ts)) > ticket.loaner_due_at ? ' (late)' : '';
  addEvent(id, { type: 'field', body: `loaner returned: ${ticket.loaner_asset_tag || ticket.loaner_serial}${outFor}${late}`, author });
  return get(id);
}

function clearLoaner(id, { author = null } = {}) {
  const ticket = get(id);
  if (!ticket) return null;
  getDb()
    .prepare(
      `UPDATE tickets SET loaner_device_id = NULL, loaner_asset_tag = NULL, loaner_serial = NULL,
         loaner_model = NULL, loaner_issued_at = NULL, loaner_returned_at = NULL,
         loaner_due_at = NULL, updated_at = ? WHERE id = ?`
    )
    .run(now(), id);
  getDb().prepare('DELETE FROM loaner_reminders WHERE ticket_id = ?').run(id);
  addEvent(id, { type: 'field', body: 'loaner link removed', author });
  return get(id);
}

// --- repair note written back to Google --------------------------------------

const isoDay = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The sentence we suggest (and, unedited, write) for the device's Admin notes. */
function defaultRepairSummary(ticket) {
  const lastNote = getDb()
    .prepare(`SELECT body FROM ticket_events WHERE ticket_id = ? AND type IN ('status','note')
              AND body IS NOT NULL AND body <> '' ORDER BY id DESC LIMIT 1`)
    .get(ticket.id);
  const what = (lastNote && lastNote.body) || ticket.issue_description || 'repair completed';
  const category = ticket.issue_category ? `${ticket.issue_category} - ` : '';
  return `${category}${what}`.trim();
}

function repairNoteLine(ticket, summary, author) {
  const who = author || ticket.assigned_to;
  return google.sanitizeNoteLine(
    `${isoDay()} Ticket #${ticket.id}: ${summary}${who ? ` (${who})` : ''}`
  );
}

/**
 * Append "what we did" to the repaired device's notes in Google Admin.
 * Never throws: a Google problem must not stop a ticket from closing.
 */
async function writeRepairNote(id, { summary, author = null } = {}) {
  const ticket = get(id);
  if (!ticket) return { result: 'skipped', reason: 'no_ticket' };
  if (!ticket.device_id) return { result: 'skipped', reason: 'no_google_device' };

  const text = String(summary || '').trim() || defaultRepairSummary(ticket);
  const line = repairNoteLine(ticket, text, author);
  try {
    const res = await google.appendDeviceNote(ticket.device_id, line);
    getDb()
      .prepare('UPDATE tickets SET repair_summary = ?, repair_note_written_at = ? WHERE id = ?')
      .run(text, now(), id);
    addEvent(id, { type: 'field', body: `wrote to Google Admin notes: ${line}`, author: author || 'system' });
    return { result: 'ok', line, notes: res.notes, dropped: res.dropped };
  } catch (err) {
    const message = (err && err.message) || String(err);
    addEvent(id, { type: 'field', body: `could not write the repair note to Google: ${message}`, author: 'system' });
    return { result: 'error', error: message, line };
  }
}

function remove(id) {
  const info = getDb().prepare('DELETE FROM tickets WHERE id = ?').run(id);
  return info.changes > 0;
}

function stats() {
  const db = getDb();
  const byStatus = db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all();
  const counts = Object.fromEntries(byStatus.map((r) => [r.status, r.n]));
  const open = OPEN_STATUS_KEYS.reduce((sum, k) => sum + (counts[k] || 0), 0);
  const week = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE created_at >= datetime('now','-7 days')`).get().n;
  const closedWeek = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE closed_at >= datetime('now','-7 days')`).get().n;
  const avgDays = db
    .prepare(`SELECT AVG(julianday(closed_at) - julianday(created_at)) AS d FROM tickets WHERE closed_at IS NOT NULL`)
    .get().d;
  const assignees = db
    .prepare(`SELECT assigned_to, COUNT(*) AS n FROM tickets WHERE assigned_to IS NOT NULL AND assigned_to <> '' GROUP BY assigned_to ORDER BY n DESC LIMIT 20`)
    .all();
  return {
    by_status: counts,
    open,
    total: db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n,
    created_last_7_days: week,
    closed_last_7_days: closedWeek,
    avg_days_to_close: avgDays == null ? null : Math.round(avgDays * 10) / 10,
    assignees,
  };
}

/** Every ticket ever filed against a serial - the "has this thing broken before?" view. */
function historyForSerial(serial, excludeId) {
  if (!serial) return [];
  return getDb()
    .prepare(`SELECT id, status, issue_description, created_at, closed_at FROM tickets
              WHERE serial = ? AND id <> COALESCE(?, -1) ORDER BY id DESC LIMIT 25`)
    .all(serial, excludeId || null);
}

module.exports = {
  get, detail, events, list, create, update, addNote, remove, stats, historyForSerial, addEvent,
  issueLoaner, returnLoaner, clearLoaner, writeRepairNote, defaultRepairSummary, repairNoteLine,
};
