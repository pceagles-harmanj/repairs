'use strict';
/**
 * A loan is "somebody has a school Chromebook that is not theirs".
 *
 * It used to be five columns on a repair ticket, which made the common case
 * impossible: a student who left their device at home needs a machine for the
 * day and there is nothing to repair. So the loan is its own record, the ticket
 * is optional, and the reason is not - a loaner handed out with no reason
 * recorded is how a fleet quietly goes missing.
 */
const config = require('./config');
const { getDb } = require('./db');
const google = require('./google');
const days = require('./lib/schooldays');

const now = () => new Date().toISOString();

const badRequest = (message) => {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
};

const conflict = (message) => {
  const err = new Error(message);
  err.statusCode = 409;
  return err;
};

/**
 * Why somebody has a loaner. Kept short on purpose: a list nobody scrolls gets
 * used, and `other` with a note catches the rest. `requires_note` marks the
 * ones where the bare reason tells you nothing useful later.
 */
const REASONS = [
  { value: 'repair', label: 'Their device is being repaired', wants_ticket: true },
  { value: 'left_at_home', label: 'Left their device at home' },
  { value: 'not_charged', label: 'Device not charged' },
  { value: 'lost', label: 'Device lost', requires_note: true },
  { value: 'stolen', label: 'Device stolen', requires_note: true },
  { value: 'at_vendor', label: 'Out for warranty / vendor repair' },
  { value: 'no_device_yet', label: 'New student, no device issued yet' },
  { value: 'event', label: 'Event, testing or field trip' },
  { value: 'staff', label: 'Staff or classroom use' },
  { value: 'other', label: 'Other', requires_note: true },
];

const OWN_DEVICE_STATES = [
  { value: 'in_shop', label: 'With us for repair' },
  { value: 'with_student', label: 'Still with the student' },
  { value: 'at_home', label: 'At home' },
  { value: 'at_vendor', label: 'At the vendor' },
  { value: 'lost', label: 'Lost or stolen' },
  { value: 'none', label: 'They have no device of their own' },
  { value: 'unknown', label: 'Not known' },
];

const RETURN_CONDITIONS = ['ok', 'damaged', 'not_returned'];

const reasonMeta = (value) => REASONS.find((r) => r.value === value) || null;
const reasonLabel = (value) => (reasonMeta(value) ? reasonMeta(value).label : value || '');

// --- reading -----------------------------------------------------------------

function get(id) {
  const row = getDb().prepare('SELECT * FROM loans WHERE id = ?').get(id);
  return row ? decorate(row) : null;
}

/** The loan shape the UI, the emails and the digest all read. */
function decorate(row, today = new Date()) {
  const outstanding = !row.returned_at;
  const todayDay = days.toDayString(today);
  const dueDay = row.due_at || null;
  const issuedDay = row.issued_at ? days.toDayString(new Date(row.issued_at)) : null;
  const endDay = row.returned_at ? days.toDayString(new Date(row.returned_at)) : todayDay;

  // A repair loan carries the ticket's own clock too: "repaired last Tuesday and
  // the loaner is still out" is the row a helpdesk actually chases.
  const ticket = row.ticket_id
    ? getDb().prepare('SELECT id, status, closed_at, asset_tag, model, user_email, user_name FROM tickets WHERE id = ?').get(row.ticket_id)
    : null;

  return {
    id: row.id,
    loan_id: row.id,
    ticket_id: row.ticket_id || null,
    ticket_status: ticket ? ticket.status : null,
    reason: row.reason,
    reason_label: reasonLabel(row.reason),
    reason_note: row.reason_note || null,
    // A ticketless loan still needs a person to chase, so fall back to the
    // ticket's contact when the loan itself was created from one.
    user_email: row.borrower_email || (ticket ? ticket.user_email : null),
    user_name: row.borrower_name || (ticket ? ticket.user_name : null),
    borrower_email: row.borrower_email || null,
    borrower_name: row.borrower_name || null,
    loaner_device_id: row.loaner_device_id || null,
    loaner_asset_tag: row.loaner_asset_tag || null,
    loaner_serial: row.loaner_serial || null,
    loaner_model: row.loaner_model || null,
    own_device_id: row.own_device_id || null,
    own_asset_tag: row.own_asset_tag || null,
    own_serial: row.own_serial || null,
    own_model: row.own_model || null,
    own_device_state: row.own_device_state || 'unknown',
    // Kept under the old names as well: the digest, the reminder templates and
    // the deployed-loaners table were all written against these.
    device_asset_tag: row.own_asset_tag || (ticket ? ticket.asset_tag : null),
    device_model: row.own_model || (ticket ? ticket.model : null),
    issued_at: row.issued_at,
    loaner_issued_at: row.issued_at,
    issued_by: row.issued_by || null,
    returned_at: row.returned_at || null,
    loaner_returned_at: row.returned_at || null,
    returned_by: row.returned_by || null,
    return_condition: row.return_condition || null,
    return_note: row.return_note || null,
    outstanding,
    due_day: dueDay,
    due_label: dueDay ? days.fromDayString(dueDay).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) : '',
    issued_day: issuedDay,
    days_out: issuedDay ? days.calendarDaysBetween(issuedDay, endDay) : null,
    school_days_out: issuedDay ? days.schoolDaysBetween(issuedDay, endDay) : null,
    days_until_due: dueDay ? days.calendarDaysBetween(todayDay, dueDay) : null,
    school_days_overdue: dueDay && dueDay < todayDay ? days.schoolDaysBetween(dueDay, todayDay) : 0,
    overdue: Boolean(outstanding && dueDay && dueDay < todayDay),
    due_today: Boolean(outstanding && dueDay === todayDay),
    due_tomorrow: Boolean(outstanding && dueDay && days.calendarDaysBetween(todayDay, dueDay) === 1),
    days_since_repair_done: ticket && ticket.closed_at
      ? days.calendarDaysBetween(days.toDayString(new Date(ticket.closed_at)), endDay)
      : null,
    repair_done_at: ticket ? ticket.closed_at || null : null,
  };
}

function list({ open = true, borrowerEmail = null, ticketId = null, limit = 500, today = new Date() } = {}) {
  const where = [];
  const params = {};
  if (open === true) where.push('returned_at IS NULL');
  if (open === false) where.push('returned_at IS NOT NULL');
  if (borrowerEmail) { where.push('LOWER(borrower_email) = @email'); params.email = String(borrowerEmail).toLowerCase(); }
  if (ticketId) { where.push('ticket_id = @ticketId'); params.ticketId = ticketId; }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  // Undated last: a loan with no due date sorts after every dated one.
  const order = open === false
    ? 'ORDER BY returned_at DESC'
    : "ORDER BY COALESCE(due_at, '9999-99-99'), id";
  return getDb()
    .prepare(`SELECT * FROM loans ${clause} ${order} LIMIT @limit`)
    .all({ ...params, limit: Math.min(Number(limit) || 500, 2000) })
    .map((r) => decorate(r, today));
}

/** Everything this person has out right now - the public site's question. */
function openForEmail(email) {
  if (!email) return [];
  return list({ open: true, borrowerEmail: email });
}

function forTicket(ticketId) {
  const rows = list({ open: null, ticketId, limit: 20 });
  // The open one is the interesting one; otherwise the most recent.
  return rows.find((l) => l.outstanding) || rows[rows.length - 1] || null;
}

/** Is this loaner already out to somebody? Returns the blocking loan, or null. */
function openLoanForDevice({ deviceId = null, assetTag = null, serial = null } = {}) {
  const row = getDb()
    .prepare(
      `SELECT * FROM loans
        WHERE returned_at IS NULL
          AND ((@deviceId IS NOT NULL AND loaner_device_id = @deviceId)
            OR (@assetTag IS NOT NULL AND LOWER(loaner_asset_tag) = LOWER(@assetTag))
            OR (@serial   IS NOT NULL AND LOWER(loaner_serial)    = LOWER(@serial)))
        ORDER BY id DESC LIMIT 1`
    )
    .get({ deviceId: deviceId || null, assetTag: assetTag || null, serial: serial || null });
  return row ? decorate(row) : null;
}

// --- writing -----------------------------------------------------------------

function addTicketEvent(ticketId, body, author = 'system') {
  if (!ticketId) return;
  getDb()
    .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, ?, ?)`)
    .run(ticketId, body, author, now());
}

/**
 * Hand out a loaner.
 *
 * `force` only overrides the "this student already has one" warning. A loaner
 * that is already out to somebody else is refused outright - two people cannot
 * both be holding the same Chromebook, and recording that they are makes the
 * whole list untrustworthy.
 */
function issue(payload = {}, { author = null, force = false } = {}) {
  const reason = String(payload.reason || '').trim();
  if (!reason) throw badRequest('Pick a reason for the loaner');
  const meta = reasonMeta(reason);
  if (!meta) throw badRequest(`Unknown reason "${reason}"`);

  const note = String(payload.reason_note || '').trim();
  if (meta.requires_note && !note) {
    throw badRequest(`"${meta.label}" needs a short note saying what happened`);
  }

  const loanerTag = String(payload.loaner_asset_tag || '').trim();
  const loanerSerial = String(payload.loaner_serial || '').trim();
  const loanerDeviceId = String(payload.loaner_device_id || '').trim();
  if (!loanerTag && !loanerSerial && !loanerDeviceId) {
    throw badRequest('Scan or type the loaner asset tag');
  }

  const email = String(payload.borrower_email || '').trim();
  if (!email) throw badRequest('Who is taking it? An email address is needed for reminders');

  const clash = openLoanForDevice({
    deviceId: loanerDeviceId || null, assetTag: loanerTag || null, serial: loanerSerial || null,
  });
  if (clash) {
    throw conflict(
      `${clash.loaner_asset_tag || clash.loaner_serial} is already out to `
      + `${clash.borrower_name || clash.borrower_email}${clash.due_day ? `, due ${clash.due_day}` : ''}`
      + `${clash.ticket_id ? ` (ticket #${clash.ticket_id})` : ''}. Return it first.`
    );
  }

  const held = openForEmail(email);
  if (held.length && !force) {
    const err = conflict(
      `${email} already has ${held.map((l) => l.loaner_asset_tag || l.loaner_serial).join(', ')} out. `
      + 'Send force:true to hand out a second one anyway.'
    );
    err.existing = held;
    throw err;
  }

  const issuedAt = now();
  const due = payload.due_at === null || payload.due_at === ''
    ? null
    : String(payload.due_at || days.toDayString(days.defaultDueDay(new Date(issuedAt))));
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) throw badRequest('A due date must look like 2026-09-10');

  const ticketId = payload.ticket_id ? Number(payload.ticket_id) : null;
  if (ticketId && !getDb().prepare('SELECT 1 FROM tickets WHERE id = ?').get(ticketId)) {
    throw badRequest(`No ticket #${ticketId}`);
  }

  const info = getDb()
    .prepare(
      `INSERT INTO loans (loaner_device_id, loaner_asset_tag, loaner_serial, loaner_model,
         borrower_email, borrower_name, reason, reason_note,
         own_device_id, own_asset_tag, own_serial, own_model, own_device_state,
         ticket_id, issued_at, issued_by, due_at, created_at, updated_at)
       VALUES (@loaner_device_id, @loaner_asset_tag, @loaner_serial, @loaner_model,
         @borrower_email, @borrower_name, @reason, @reason_note,
         @own_device_id, @own_asset_tag, @own_serial, @own_model, @own_device_state,
         @ticket_id, @issued_at, @issued_by, @due_at, @issued_at, @issued_at)`
    )
    .run({
      loaner_device_id: loanerDeviceId || null,
      loaner_asset_tag: loanerTag || null,
      loaner_serial: loanerSerial || null,
      loaner_model: payload.loaner_model || null,
      borrower_email: email,
      borrower_name: payload.borrower_name || null,
      reason,
      reason_note: note || null,
      own_device_id: payload.own_device_id || null,
      own_asset_tag: payload.own_asset_tag || null,
      own_serial: payload.own_serial || null,
      own_model: payload.own_model || null,
      own_device_state: payload.own_device_state || (reason === 'repair' ? 'in_shop' : 'unknown'),
      ticket_id: ticketId,
      issued_at: issuedAt,
      issued_by: author,
      due_at: due,
    });

  const id = Number(info.lastInsertRowid);
  syncTicketColumns(id);
  addTicketEvent(
    ticketId,
    `loaner ${loanerTag || loanerSerial} issued to ${email} (${reasonLabel(reason)})${due ? `, due ${due}` : ''}`,
    author
  );
  return get(id);
}

/** Take it back. */
function returnLoan(id, { author = null, condition = 'ok', note = null, at = null } = {}) {
  const loan = get(id);
  if (!loan) throw badRequest('No such loan');
  if (loan.returned_at) return loan;
  const state = RETURN_CONDITIONS.includes(condition) ? condition : 'ok';
  if (state === 'damaged' && !String(note || '').trim()) {
    throw badRequest('Say what the damage is');
  }
  const ts = at || now();
  getDb()
    .prepare(
      `UPDATE loans SET returned_at = ?, returned_by = ?, return_condition = ?, return_note = ?, updated_at = ?
        WHERE id = ?`
    )
    .run(ts, author, state, note || null, ts, id);
  syncTicketColumns(id);
  addTicketEvent(
    loan.ticket_id,
    `loaner ${loan.loaner_asset_tag || loan.loaner_serial} returned${state !== 'ok' ? ` (${state})` : ''}`,
    author
  );
  return get(id);
}

const EDITABLE = ['borrower_email', 'borrower_name', 'reason', 'reason_note', 'loaner_model',
  'own_device_id', 'own_asset_tag', 'own_serial', 'own_model', 'own_device_state', 'due_at'];

function update(id, patch = {}, { author = null } = {}) {
  const before = get(id);
  if (!before) return null;
  if ('reason' in patch) {
    const meta = reasonMeta(String(patch.reason || '').trim());
    if (!meta) throw badRequest(`Unknown reason "${patch.reason}"`);
    const note = 'reason_note' in patch ? patch.reason_note : before.reason_note;
    if (meta.requires_note && !String(note || '').trim()) {
      throw badRequest(`"${meta.label}" needs a short note saying what happened`);
    }
  }
  if (patch.due_at) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(patch.due_at))) throw badRequest('A due date must look like 2026-09-10');
  }
  const sets = [];
  const params = { id, ts: now() };
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    let value = patch[field];
    if (value === '') value = null;
    sets.push(`${field} = @${field}`);
    params[field] = value;
  }
  if (!sets.length) return before;
  getDb().prepare(`UPDATE loans SET ${sets.join(', ')}, updated_at = @ts WHERE id = @id`).run(params);
  syncTicketColumns(id);
  return get(id);
}

/** Link a loan to a repair after the fact, or unlink it (ticketId = null). */
function setTicket(id, ticketId, { author = null } = {}) {
  const loan = get(id);
  if (!loan) throw badRequest('No such loan');
  const target = ticketId ? Number(ticketId) : null;
  if (target) {
    if (!getDb().prepare('SELECT 1 FROM tickets WHERE id = ?').get(target)) throw badRequest(`No ticket #${target}`);
    const other = getDb()
      .prepare('SELECT id FROM loans WHERE ticket_id = ? AND returned_at IS NULL AND id != ?')
      .get(target, id);
    if (other) throw conflict(`Ticket #${target} already has loan #${other.id} against it`);
  }
  // Leaving a ticket behind should not leave the ticket looking like it still
  // has a loaner out.
  const previous = loan.ticket_id;
  getDb().prepare('UPDATE loans SET ticket_id = ?, updated_at = ? WHERE id = ?').run(target, now(), id);
  if (previous && previous !== target) {
    clearTicketColumns(previous);
    addTicketEvent(previous, `loaner ${loan.loaner_asset_tag || loan.loaner_serial} unlinked from this ticket`, author);
  }
  syncTicketColumns(id);
  if (target) {
    addTicketEvent(target, `loaner ${loan.loaner_asset_tag || loan.loaner_serial} linked to this ticket`, author);
  }
  return get(id);
}

function remove(id) {
  const loan = get(id);
  if (!loan) return { deleted: false };
  getDb().prepare('DELETE FROM loan_reminders WHERE loan_id = ?').run(id);
  getDb().prepare('DELETE FROM loaner_reminders WHERE loan_id = ?').run(id);
  getDb().prepare('DELETE FROM loans WHERE id = ?').run(id);
  if (loan.ticket_id) clearTicketColumns(loan.ticket_id);
  return { deleted: true };
}

/**
 * The ticket columns are legacy but not dead: the ticket drawer, the status
 * emails and every existing template read them. The loan row is the truth, so
 * mirror it onto the ticket rather than asking every caller to change at once.
 */
function syncTicketColumns(loanId) {
  const row = getDb().prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  if (!row || !row.ticket_id) return;
  getDb()
    .prepare(
      `UPDATE tickets SET loaner_device_id = ?, loaner_asset_tag = ?, loaner_serial = ?, loaner_model = ?,
         loaner_issued_at = ?, loaner_returned_at = ?, loaner_due_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(row.loaner_device_id, row.loaner_asset_tag, row.loaner_serial, row.loaner_model,
      row.issued_at, row.returned_at, row.due_at, now(), row.ticket_id);
}

function clearTicketColumns(ticketId) {
  getDb()
    .prepare(
      `UPDATE tickets SET loaner_device_id = NULL, loaner_asset_tag = NULL, loaner_serial = NULL,
         loaner_model = NULL, loaner_issued_at = NULL, loaner_returned_at = NULL, loaner_due_at = NULL,
         updated_at = ? WHERE id = ?`
    )
    .run(now(), ticketId);
}

/**
 * Leave a line on the loaner in Google Admin, the same courtesy the repair unit
 * gets. Best effort: a loan must not fail because Google is unreachable.
 */
async function noteOnLoaner(loan, line) {
  if (!config.allowDeviceWriteback || !loan || !loan.loaner_device_id) return { skipped: true };
  try {
    await google.appendDeviceNote(loan.loaner_device_id, line);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  REASONS, OWN_DEVICE_STATES, RETURN_CONDITIONS,
  reasonMeta, reasonLabel, decorate,
  get, list, openForEmail, forTicket, openLoanForDevice,
  issue, returnLoan, update, setTicket, remove,
  syncTicketColumns, clearTicketColumns, noteOnLoaner,
};
