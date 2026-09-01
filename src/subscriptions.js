'use strict';
/**
 * Who gets emailed, decided per ticket.
 *
 * Every ticket carries its own list of statuses that email the device's user.
 * The list is seeded from the "auto-send" switches on the templates when the
 * ticket is created, and after that it belongs to the ticket: a tech can edit it
 * in the drawer, and the user can edit it themselves from the link in any email.
 *
 * Three things can stop an email:
 *   1. the address is on the account-wide opt-out list (user unsubscribed)
 *   2. notify_user = 0 on the ticket (hard off for this ticket)
 *   3. the status is not in the ticket's list
 */
const { getDb } = require('./db');
const { STATUS_KEYS } = require('./lib/statuses');

const clean = (list) => [...new Set((list || []).map(String))].filter((s) => STATUS_KEYS.includes(s));

/** The statuses a brand-new ticket subscribes to: whatever templates auto-send. */
function defaultStatuses() {
  const rows = getDb().prepare('SELECT status_key FROM email_templates WHERE auto_send = 1').all();
  return clean(rows.map((r) => r.status_key));
}

function parse(ticket) {
  if (!ticket) return [];
  if (ticket.notify_statuses == null) return defaultStatuses();
  try {
    return clean(JSON.parse(ticket.notify_statuses));
  } catch {
    return defaultStatuses();
  }
}

function save(ticketId, statuses) {
  const list = clean(statuses);
  getDb()
    .prepare("UPDATE tickets SET notify_statuses = ?, updated_at = ? WHERE id = ?")
    .run(JSON.stringify(list), new Date().toISOString(), ticketId);
  return list;
}

/** Write the seeded list onto the row so it is visible and editable from then on. */
function ensure(ticket) {
  if (!ticket) return [];
  if (ticket.notify_statuses != null) return parse(ticket);
  const list = isOptedOut(ticket.user_email) ? [] : defaultStatuses();
  save(ticket.id, list);
  ticket.notify_statuses = JSON.stringify(list);
  return list;
}

// ---- account-wide opt-out ---------------------------------------------------

const norm = (email) => String(email || '').trim().toLowerCase();

function isOptedOut(email) {
  const e = norm(email);
  if (!e) return false;
  return Boolean(getDb().prepare('SELECT 1 FROM email_optouts WHERE email = ?').get(e));
}

function optOut(email, source = 'user') {
  const e = norm(email);
  if (!e) return false;
  getDb()
    .prepare('INSERT OR REPLACE INTO email_optouts (email, source, created_at) VALUES (?, ?, ?)')
    .run(e, source, new Date().toISOString());
  // Also clear the lists on that address's open tickets so nothing slips out.
  const ids = getDb().prepare('SELECT id FROM tickets WHERE LOWER(COALESCE(user_email,\'\')) = ?').all(e);
  for (const row of ids) save(row.id, []);
  return true;
}

function optIn(email) {
  const e = norm(email);
  if (!e) return false;
  getDb().prepare('DELETE FROM email_optouts WHERE email = ?').run(e);
  return true;
}

/** The whole decision, in one place. */
function decide(ticket, statusKey) {
  if (!ticket.user_email) return { send: false, reason: 'no_recipient' };
  if (isOptedOut(ticket.user_email)) return { send: false, reason: 'user_unsubscribed' };
  if (!ticket.notify_user) return { send: false, reason: 'ticket_notifications_off' };
  const list = ensure(ticket);
  if (!list.includes(statusKey)) return { send: false, reason: 'status_not_subscribed', statuses: list };
  return { send: true, statuses: list };
}

module.exports = { defaultStatuses, parse, save, ensure, decide, isOptedOut, optOut, optIn, clean };
