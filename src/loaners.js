'use strict';
/**
 * Loaners that are out: due dates, the deployed-loaners view, and the daily
 * reminder pass.
 *
 * Reminders are transactional - they are about school property somebody still
 * has - so they ignore a ticket's status subscription list. They stop for an
 * address that unsubscribed entirely (mailer enforces that), when the loaner is
 * marked returned, or when the template's auto-send switch is off.
 */
const config = require('./config');
const { getDb } = require('./db');
const mailer = require('./mailer');
const google = require('./google');
const { statusLabel } = require('./lib/statuses');
const days = require('./lib/schooldays');

const now = () => new Date().toISOString();

const fmtDay = (day) => {
  if (!day) return '';
  const d = days.fromDayString(day);
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
};

const plural = (n, word) => `${n} ${word}${Math.abs(n) === 1 ? '' : 's'}`;

function addEvent(ticketId, body, author = 'system') {
  getDb()
    .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, ?, ?)`)
    .run(ticketId, body, author, now());
}

// --- one loaner's timing -----------------------------------------------------

/**
 * Everything the UI and the emails need about a loaner's clock:
 * how long it has been out, when it is due, how overdue, and how long it has
 * been sitting out since the repair was actually finished.
 */
function dueInfo(ticket, today = new Date()) {
  const outstanding = Boolean(ticket.loaner_device_id || ticket.loaner_asset_tag || ticket.loaner_serial) && !ticket.loaner_returned_at;
  const todayDay = days.toDayString(today);
  const dueDay = ticket.loaner_due_at || null;
  const issuedDay = ticket.loaner_issued_at ? days.toDayString(new Date(ticket.loaner_issued_at)) : null;
  const endDay = ticket.loaner_returned_at ? days.toDayString(new Date(ticket.loaner_returned_at)) : todayDay;

  const info = {
    outstanding,
    due_day: dueDay,
    due_label: fmtDay(dueDay),
    issued_day: issuedDay,
    days_out: issuedDay ? days.calendarDaysBetween(issuedDay, endDay) : null,
    school_days_out: issuedDay ? days.schoolDaysBetween(issuedDay, endDay) : null,
    days_until_due: dueDay ? days.calendarDaysBetween(todayDay, dueDay) : null,
    school_days_overdue: dueDay && dueDay < todayDay ? days.schoolDaysBetween(dueDay, todayDay) : 0,
    overdue: Boolean(outstanding && dueDay && dueDay < todayDay),
    due_today: Boolean(outstanding && dueDay === todayDay),
    due_tomorrow: Boolean(outstanding && dueDay && days.calendarDaysBetween(todayDay, dueDay) === 1),
    // The awkward one worth watching: repair finished, loaner never came back.
    days_since_repair_done: ticket.closed_at ? days.calendarDaysBetween(days.toDayString(new Date(ticket.closed_at)), endDay) : null,
    repair_done_at: ticket.closed_at || null,
  };
  return info;
}

/** The default due day for a loaner handed out now (school days, holidays skipped). */
const defaultDueDay = (issuedAt = new Date()) => days.defaultDueDay(issuedAt);

function setDue(ticketId, dueDay, { author = null } = {}) {
  const day = String(dueDay || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const err = new Error('A due date must look like 2026-09-10');
    err.statusCode = 400;
    throw err;
  }
  getDb().prepare('UPDATE tickets SET loaner_due_at = ?, updated_at = ? WHERE id = ?').run(day, now(), ticketId);
  addEvent(ticketId, `loaner due date set to ${day}`, author);
  return day;
}

/** Push the due date out by N school days from today (or from the due date if later). */
function extendDue(ticketId, schoolDays, { author = null } = {}) {
  const ticket = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(ticketId);
  if (!ticket) return null;
  const base = ticket.loaner_due_at && ticket.loaner_due_at > days.toDayString(new Date())
    ? days.fromDayString(ticket.loaner_due_at)
    : new Date();
  const day = days.toDayString(days.addSchoolDays(base, schoolDays));
  getDb().prepare('UPDATE tickets SET loaner_due_at = ?, updated_at = ? WHERE id = ?').run(day, now(), ticketId);
  addEvent(ticketId, `loaner due date extended by ${plural(schoolDays, 'school day')} to ${day}`, author);
  return day;
}

// --- the deployed-loaners view ----------------------------------------------

const OUTSTANDING_SQL = `
  SELECT * FROM tickets
   WHERE (loaner_device_id IS NOT NULL OR loaner_asset_tag IS NOT NULL OR loaner_serial IS NOT NULL)
     AND loaner_returned_at IS NULL`;

function decorate(row, today = new Date()) {
  const info = dueInfo(row, today);
  const reminders = getDb()
    .prepare('SELECT kind, sent_on FROM loaner_reminders WHERE ticket_id = ? ORDER BY id')
    .all(row.id);
  return {
    ticket_id: row.id,
    status: row.status,
    status_label: statusLabel(row.status),
    user_email: row.user_email,
    user_name: row.user_name,
    assigned_to: row.assigned_to,
    loaner_asset_tag: row.loaner_asset_tag,
    loaner_serial: row.loaner_serial,
    loaner_model: row.loaner_model,
    loaner_device_id: row.loaner_device_id,
    loaner_issued_at: row.loaner_issued_at,
    loaner_returned_at: row.loaner_returned_at,
    device_asset_tag: row.asset_tag,
    device_model: row.model,
    ...info,
    reminders,
    reminder_count: reminders.length,
  };
}

/** Everything currently out, soonest due first, undated last. */
function listOutstanding({ today = new Date() } = {}) {
  const rows = getDb().prepare(`${OUTSTANDING_SQL} ORDER BY COALESCE(loaner_due_at, '9999-99-99'), id`).all();
  return rows.map((r) => decorate(r, today));
}

/** Recently returned, for the "handed back" tab. */
function listReturned({ limit = 50, today = new Date() } = {}) {
  const rows = getDb()
    .prepare(`SELECT * FROM tickets WHERE loaner_returned_at IS NOT NULL ORDER BY loaner_returned_at DESC LIMIT ?`)
    .all(limit);
  return rows.map((r) => decorate(r, today));
}

function stats(today = new Date()) {
  const out = listOutstanding({ today });
  const overdue = out.filter((l) => l.overdue);
  const daysOut = out.map((l) => l.days_out).filter((n) => typeof n === 'number');
  return {
    out: out.length,
    due_today: out.filter((l) => l.due_today).length,
    due_tomorrow: out.filter((l) => l.due_tomorrow).length,
    overdue: overdue.length,
    no_due_date: out.filter((l) => !l.due_day).length,
    longest_days_out: daysOut.length ? Math.max(...daysOut) : 0,
    avg_days_out: daysOut.length ? Math.round((daysOut.reduce((a, b) => a + b, 0) / daysOut.length) * 10) / 10 : 0,
    // repair finished but the loaner is still out - the ones to chase first
    still_out_after_repair: out.filter((l) => l.repair_done_at && l.days_since_repair_done >= 1).length,
  };
}

// --- the daily reminder pass -------------------------------------------------

const REMINDER_TEMPLATE = {
  due_tomorrow: 'loaner_due_tomorrow',
  due_today: 'loaner_due_today',
  overdue: 'loaner_overdue',
};

function alreadySent(ticketId, kind, day) {
  return Boolean(
    getDb().prepare('SELECT 1 FROM loaner_reminders WHERE ticket_id = ? AND kind = ? AND sent_on = ?').get(ticketId, kind, day)
  );
}

function countSent(ticketId, kind) {
  return getDb().prepare('SELECT COUNT(*) AS n FROM loaner_reminders WHERE ticket_id = ? AND kind = ?').get(ticketId, kind).n;
}

function lastSentDay(ticketId, kind) {
  const row = getDb()
    .prepare('SELECT sent_on FROM loaner_reminders WHERE ticket_id = ? AND kind = ? ORDER BY sent_on DESC LIMIT 1')
    .get(ticketId, kind);
  return row ? row.sent_on : null;
}

function recordSent(ticketId, kind, day, dueOn, toEmail) {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO loaner_reminders (ticket_id, kind, sent_on, due_on, to_email, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(ticketId, kind, day, dueOn || null, toEmail || null, now());
}

/** Which reminder (if any) this loaner has earned today. */
function reminderDue(loaner, today = new Date()) {
  if (!loaner.outstanding || !loaner.due_day || !loaner.user_email) return null;
  const day = days.toDayString(today);

  if (loaner.overdue) {
    if (config.loanerDue.maxOverdueNudges <= 0) return null;
    if (countSent(loaner.ticket_id, 'overdue') >= config.loanerDue.maxOverdueNudges) return null;
    const last = lastSentDay(loaner.ticket_id, 'overdue');
    if (last && days.calendarDaysBetween(last, day) < config.loanerDue.overdueEveryDays) return null;
    // Do not nudge on the very first day past due if the due-day mail went today.
    if (!last && alreadySent(loaner.ticket_id, 'due_today', day)) return null;
    return 'overdue';
  }
  if (loaner.due_today && !alreadySent(loaner.ticket_id, 'due_today', day)) return 'due_today';
  if (loaner.due_tomorrow && !alreadySent(loaner.ticket_id, 'due_tomorrow', day)) return 'due_tomorrow';
  return null;
}

/** Extra placeholders the reminder templates use. */
function reminderVars(loaner) {
  const statusLine = loaner.repair_done_at
    ? 'Your own device is finished and back with you, so all we need now is the loaner.'
    : loaner.status === 'ready_for_pickup'
    ? 'Your device is repaired and waiting at the technology office - bring the loaner when you collect it.'
    : 'Your device is still with us; if you need the loaner longer than this, just say so.';
  const overduePhrase = loaner.school_days_overdue > 0
    ? `${plural(loaner.school_days_overdue, 'school day')} overdue`
    : 'due back now';
  return {
    loaner_due_date: loaner.due_label || loaner.due_day || '',
    loaner_status_line: statusLine,
    loaner_overdue_phrase: overduePhrase,
    loaner_days_out: loaner.days_out == null ? '' : String(loaner.days_out),
  };
}

/**
 * Send whatever reminders are owed today. Safe to run more than once a day:
 * every send is recorded, and a recorded send is never repeated.
 */
async function runReminders({ today = new Date(), reason = 'manual' } = {}) {
  const day = days.toDayString(today);
  const result = { day, reason, sent: [], skipped: [], failed: [], digest: null };
  if (!config.loanerDue.remindersEnabled) {
    result.skipped.push({ reason: 'reminders_disabled' });
    return result;
  }

  const outstanding = listOutstanding({ today });
  for (const loaner of outstanding) {
    const kind = reminderDue(loaner, today);
    if (!kind) continue;
    const templateKey = REMINDER_TEMPLATE[kind];
    const tpl = mailer.getTemplate(templateKey);
    if (!tpl || !tpl.auto_send) {
      result.skipped.push({ ticket_id: loaner.ticket_id, kind, reason: tpl ? 'template_off' : 'no_template' });
      continue;
    }

    const ticket = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(loaner.ticket_id);
    const res = await mailer.sendStatusEmail(ticket, templateKey, { vars: reminderVars(loaner) });
    if (res.result === 'sent' || res.result === 'dry_run') {
      recordSent(loaner.ticket_id, kind, day, loaner.due_day, loaner.user_email);
      addEvent(loaner.ticket_id, `loaner reminder sent (${kind}) to ${loaner.user_email}`);
      result.sent.push({ ticket_id: loaner.ticket_id, kind, to: res.to, result: res.result });
    } else if (res.result === 'error') {
      addEvent(loaner.ticket_id, `loaner reminder (${kind}) FAILED: ${res.error}`);
      result.failed.push({ ticket_id: loaner.ticket_id, kind, error: res.error });
    } else {
      result.skipped.push({ ticket_id: loaner.ticket_id, kind, reason: res.reason || res.result });
    }
  }

  // Parts on the way get their own "arriving today" notices in the same pass.
  try {
    const shipments = require('./shipments');
    result.parts = await shipments.dailyPass({ today });
  } catch (err) {
    result.parts = { error: err.message };
  }

  result.digest = await sendDigest({ today, outstanding, parts: result.parts });
  return result;
}

// --- the helpdesk digest -----------------------------------------------------

const esc = (v) => mailer.escapeHtml(v == null ? '' : v);

function partsSection(late, b) {
  if (!late || !late.length) return '';
  const row = (s) => `<tr>
    <td style="padding:7px 10px;border-top:1px solid ${b.border};font-weight:600">${esc(s.vendor || 'supplier')}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border}">${esc((s.lines || []).map((l) => l.description || l.item_name).filter(Boolean).join(', ') || '-')}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border};color:#b91c1c">${esc(s.expected_day || 'no date')}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border}">${esc((s.ticket_ids || []).map((id) => '#' + id).join(' ') || '-')}</td>
  </tr>`;
  return `<h2 style="font:600 15px/1.4 sans-serif;color:${b.ink};margin:22px 0 6px">Parts overdue to arrive (${late.length})</h2>
    <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font:14px/1.45 sans-serif;color:${b.ink}">
      <tr style="text-align:left;color:${b.muted};font-size:12px;text-transform:uppercase;letter-spacing:.04em">
        <th style="padding:4px 10px">Vendor</th><th style="padding:4px 10px">What</th>
        <th style="padding:4px 10px">Was due</th><th style="padding:4px 10px">Tickets</th>
      </tr>${late.map(row).join('')}
    </table>`;
}

function digestHtml(rows, day, parts = null) {
  const b = config.brand;
  const row = (l) => `<tr>
    <td style="padding:7px 10px;border-top:1px solid ${b.border};font-weight:600">${esc(l.loaner_asset_tag || l.loaner_serial)}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border}">${esc(l.user_name || l.user_email || '-')}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border};color:${l.overdue ? '#b91c1c' : b.ink}">
      ${esc(l.due_day || 'no date')}${l.overdue ? ` (${esc(l.school_days_overdue)} school days over)` : ''}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border}">${esc(l.days_out == null ? '-' : l.days_out)}</td>
    <td style="padding:7px 10px;border-top:1px solid ${b.border}">#${esc(l.ticket_id)} ${esc(l.status_label)}</td>
  </tr>`;

  const section = (title, list) => (list.length
    ? `<h2 style="font:600 15px/1.4 sans-serif;color:${b.ink};margin:22px 0 6px">${esc(title)} (${list.length})</h2>
       <table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;font:14px/1.45 sans-serif;color:${b.ink}">
         <tr style="text-align:left;color:${b.muted};font-size:12px;text-transform:uppercase;letter-spacing:.04em">
           <th style="padding:4px 10px">Loaner</th><th style="padding:4px 10px">Student</th>
           <th style="padding:4px 10px">Due</th><th style="padding:4px 10px">Days out</th><th style="padding:4px 10px">Ticket</th>
         </tr>
         ${list.map(row).join('')}
       </table>`
    : '');

  const overdue = rows.filter((l) => l.overdue);
  const dueToday = rows.filter((l) => l.due_today);
  const afterRepair = rows.filter((l) => !l.overdue && !l.due_today && l.repair_done_at && l.days_since_repair_done >= 1);
  const undated = rows.filter((l) => !l.due_day);

  return `<div style="font:15px/1.55 sans-serif;color:${b.ink};max-width:720px">
    <div style="background:${b.primary};color:#fff;padding:14px 18px;border-radius:8px 8px 0 0">
      <div style="font:600 16px/1.3 sans-serif">Loaners out &middot; ${esc(day)}</div>
      <div style="font-size:13px;opacity:.85">${esc(config.orgName)} ${esc(config.helpdeskName)}</div>
    </div>
    <div style="height:4px;background:${b.accent}"></div>
    <div style="border:1px solid ${b.border};border-top:0;border-radius:0 0 8px 8px;padding:6px 18px 20px">
      <p style="color:${b.muted};font-size:13.5px">${rows.length} loaner${rows.length === 1 ? '' : 's'} out
        &middot; ${overdue.length} overdue &middot; ${dueToday.length} due today</p>
      ${section('Overdue', overdue)}
      ${section('Due today', dueToday)}
      ${section('Repair finished, loaner still out', afterRepair)}
      ${section('No due date set', undated)}
      ${partsSection(parts && parts.late, b)}
      ${!rows.length && !(parts && parts.late && parts.late.length) ? '<p>Nothing is out on loan and no parts are late. Enjoy it.</p>' : ''}
    </div>
  </div>`;
}

async function sendDigest({ today = new Date(), outstanding = null, parts = null } = {}) {
  if (!config.loanerDue.digestEnabled) return { result: 'skipped', reason: 'digest_disabled' };
  const rows = outstanding || listOutstanding({ today });
  const worth = rows.filter((l) => l.overdue || l.due_today || (l.repair_done_at && l.days_since_repair_done >= 1) || !l.due_day);
  const lateParts = (parts && parts.late) || [];
  if (!worth.length && !lateParts.length) return { result: 'skipped', reason: 'nothing_to_report' };

  const account = google.getAccount();
  const to = config.loanerDue.digestTo || (account && account.email);
  if (!to) return { result: 'skipped', reason: 'no_digest_recipient' };

  const day = days.toDayString(today);
  const subject = lateParts.length
    ? `Loaners: ${worth.filter((l) => l.overdue).length} overdue, ${worth.filter((l) => l.due_today).length} due today; ${lateParts.length} parts late`
    : `Loaners: ${worth.filter((l) => l.overdue).length} overdue, ${worth.filter((l) => l.due_today).length} due today`;
  const html = digestHtml(rows, day, parts);

  if (config.dryRunEmail) {
    const id = mailer.logEmail({ to_email: to, subject, body: html, status_key: 'loaner_digest', result: 'dry_run' });
    return { result: 'dry_run', log_id: id, to, subject };
  }
  try {
    await google.sendEmail({ to, subject, html });
    const id = mailer.logEmail({ to_email: to, subject, body: html, status_key: 'loaner_digest', result: 'sent' });
    return { result: 'sent', log_id: id, to, subject };
  } catch (err) {
    const id = mailer.logEmail({ to_email: to, subject, body: html, status_key: 'loaner_digest', result: 'error', error: err.message });
    return { result: 'error', log_id: id, to, error: err.message };
  }
}

// --- scheduler ---------------------------------------------------------------

let timer = null;

function msUntilNextRun(nowDate = new Date()) {
  const next = new Date(nowDate);
  next.setHours(config.loanerDue.hour, config.loanerDue.minute, 0, 0);
  if (next <= nowDate) next.setDate(next.getDate() + 1);
  const ms = next - nowDate;
  return Number.isFinite(ms) && ms > 0 ? ms : 24 * 60 * 60 * 1000;
}

function startScheduler() {
  if (!config.loanerDue.remindersEnabled) return { scheduled: false, reason: 'disabled' };
  const arm = () => {
    const delay = msUntilNextRun();
    timer = setTimeout(async () => {
      try {
        const res = await runReminders({ reason: 'daily' });
        console.log(`[loaners] reminders: ${res.sent.length} sent, ${res.failed.length} failed, digest ${res.digest && res.digest.result}`);
      } catch (err) {
        console.error('[loaners] reminder pass failed:', err.message);
      }
      arm();
    }, delay);
    timer.unref?.();
    console.log(`[loaners] next reminder pass ${new Date(Date.now() + delay).toLocaleString()}`);
  };
  arm();
  return { scheduled: true };
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function status() {
  return {
    enabled: config.loanerDue.remindersEnabled,
    at: `${String(config.loanerDue.hour).padStart(2, '0')}:${String(config.loanerDue.minute).padStart(2, '0')}`,
    next_run: config.loanerDue.remindersEnabled ? new Date(Date.now() + msUntilNextRun()).toISOString() : null,
    school_days: config.loanerDue.schoolDays,
    overdue_every_days: config.loanerDue.overdueEveryDays,
    max_overdue_nudges: config.loanerDue.maxOverdueNudges,
    digest_enabled: config.loanerDue.digestEnabled,
    digest_to: config.loanerDue.digestTo || (google.getAccount() || {}).email || null,
    holidays: [...days.expandHolidays()].sort().slice(0, 60),
    org_unit: config.loaner.orgUnit,
  };
}

module.exports = {
  dueInfo, defaultDueDay, setDue, extendDue, listOutstanding, listReturned, stats,
  runReminders, reminderDue, reminderVars, sendDigest, digestHtml,
  startScheduler, stopScheduler, msUntilNextRun, status, fmtDay,
};
