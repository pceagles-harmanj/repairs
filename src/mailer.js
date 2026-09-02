'use strict';
/**
 * Template rendering + the "send a status email" path (auto or manual).
 * Every attempt lands in email_log, so you can always see what went out.
 */
const config = require('./config');
const { getDb } = require('./db');
const google = require('./google');
const links = require('./lib/links');
const subscriptions = require('./subscriptions');
const { statusLabel } = require('./lib/statuses');

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function firstName(ticket) {
  if (ticket.user_name) return String(ticket.user_name).trim().split(/\s+/)[0];
  if (ticket.user_email) {
    const local = String(ticket.user_email).split('@')[0].replace(/[._-]+/g, ' ').trim();
    if (local) return local.split(' ')[0].replace(/^\w/, (c) => c.toUpperCase());
  }
  return 'there';
}

/** Lazy require: shipments needs mailer, so this cannot be a top-level import. */
function partsExpectation(ticket) {
  if (!ticket || !ticket.id) return '';
  try {
    return require('./shipments').expectationForTicket(ticket.id);
  } catch {
    return '';
  }
}

/** "You have loaner Loaner-012 in the meantime..." - empty when there is none. */
function loanerLine(ticket, statusKey) {
  const tag = ticket.loaner_asset_tag || ticket.loaner_serial;
  if (!tag || ticket.loaner_returned_at) return '';
  const status = statusKey || ticket.status;
  // The swap is the part people miss, so say it the same way everywhere.
  if (status === 'ready_for_pickup') {
    return `Bring loaner ${tag} with you - we hand your own device back when the loaner comes in.`;
  }
  if (status === 'closed') return `If you still have loaner ${tag}, please return it to the technology office.`;
  return `You have loaner ${tag} in the meantime - keep it until your device is ready, then bring it with you to swap.`;
}

function fmtDate(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}

function buildVars(ticket, extra = {}) {
  // When previewing another status, the wording should describe THAT status,
  // not the one the ticket happens to be in right now.
  const statusKey = extra.statusKey || ticket.status;
  // {{latest_note}} is ONLY ever the note the tech typed for this specific email.
  // It must never fall back to reading notes off the ticket: those are internal
  // (triage, billing, behaviour) and emailing them by accident is unacceptable.
  const note = typeof extra.note === 'string' ? extra.note : '';
  const vars = {
    ticket_number: ticket.id,
    status: statusKey,
    status_label: statusLabel(statusKey),
    priority: ticket.priority,
    user_email: ticket.user_email || '',
    user_name: ticket.user_name || ticket.user_email || '',
    first_name: firstName(ticket),
    serial: ticket.serial || 'n/a',
    asset_tag: ticket.asset_tag || 'n/a',
    asset_tag_suffix: ticket.asset_tag ? ` / asset ${ticket.asset_tag}` : '',
    model: ticket.model || 'device',
    issue_category: ticket.issue_category || '',
    issue_description: ticket.issue_description || '',
    assigned_to: ticket.assigned_to || 'the technology department',
    location: ticket.location || '',
    loaner_serial: ticket.loaner_serial || 'none',
    loaner_asset_tag: ticket.loaner_asset_tag || '',
    loaner_model: ticket.loaner_model || '',
    // Sentence-shaped values: empty when they do not apply, so a template never
    // shows a dangling label.
    loaner_line: loanerLine(ticket, statusKey),
    repair_line: ticket.repair_summary ? `What we did: ${ticket.repair_summary}` : '',
    repair_summary: ticket.repair_summary || '',
    estimated_cost: ticket.estimated_cost == null ? '' : `$${Number(ticket.estimated_cost).toFixed(2)}`,
    latest_note: note || '',
    created_at: fmtDate(ticket.created_at),
    updated_at: fmtDate(ticket.updated_at),
    org_name: config.orgName,
    helpdesk_name: config.helpdeskName,
    helpdesk_signature: config.helpdeskSignature,
    // Brand colours travel with the render, so changing BRAND_* in .env
    // re-themes templates that are already saved in the database.
    brand_primary: config.brand.primary,
    brand_primary_dark: config.brand.primaryDark,
    brand_accent: config.brand.accent,
    brand_ink: config.brand.ink,
    brand_muted: config.brand.muted,
    brand_wash: config.brand.wash,
    brand_border: config.brand.border,
    // Filled from any open shipment carrying a part for this ticket, so the
    // "waiting on parts" email can say when to expect it without extra work.
    parts_expected_line: partsExpectation(ticket),
    status_url: links.statusUrl(ticket.id) || '',
    unsubscribe_url: links.prefsUrl(ticket.id) || '',
    ...extra.vars,
  };
  return vars;
}

/**
 * Conditional sections, so a template never shows an empty label:
 *
 *   <!--if:latest_note--> ...only rendered when a note was typed... <!--/if-->
 *
 * Anything between the markers disappears when that value is empty.
 */
const SECTION = /<!--\s*if:([a-z0-9_]+)\s*-->([\s\S]*?)<!--\s*\/if\s*-->/gi;

function applySections(template, vars) {
  return String(template).replace(SECTION, (match, key, inner) => {
    const value = vars[key.toLowerCase()];
    return value === undefined || value === null || String(value).trim() === '' ? '' : inner;
  });
}

/** Replace {{placeholders}}; values are HTML-escaped, the template is not. */
function render(template, vars) {
  return applySections(template, vars).replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    const k = key.toLowerCase();
    if (!(k in vars)) return match;
    return escapeHtml(vars[k]);
  });
}

function getTemplate(statusKey) {
  return getDb().prepare('SELECT * FROM email_templates WHERE status_key = ?').get(statusKey) || null;
}

function listTemplates() {
  return getDb().prepare('SELECT * FROM email_templates ORDER BY rowid').all();
}

function saveTemplate(statusKey, { subject, body, auto_send }) {
  const existing = getTemplate(statusKey);
  if (!existing) {
    const err = new Error(`No template for status "${statusKey}"`);
    err.statusCode = 404;
    throw err;
  }
  for (const [name, value] of [['subject', subject], ['body', body]]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      const err = new Error(`Template ${name} cannot be empty`);
      err.statusCode = 400;
      throw err;
    }
  }
  getDb()
    .prepare(`UPDATE email_templates SET subject = ?, body = ?, auto_send = ?, updated_at = datetime('now') WHERE status_key = ?`)
    .run(
      subject === undefined ? existing.subject : subject,
      body === undefined ? existing.body : body,
      auto_send === undefined ? existing.auto_send : auto_send ? 1 : 0,
      statusKey
    );
  return getTemplate(statusKey);
}

/** Render without sending - powers the preview pane. */
const HAS_NOTE_PLACEHOLDER = /\{\{\s*latest_note\s*\}\}/i;

/**
 * If the tech typed a note but the chosen template has nowhere to put it,
 * add a spot rather than silently dropping what they wrote.
 */
function ensureNoteSlot(body) {
  if (HAS_NOTE_PLACEHOLDER.test(body)) return body;
  const lastDiv = body.lastIndexOf('</div>');
  const slot = '<p>{{latest_note}}</p>';
  return lastDiv === -1 ? body + slot : body.slice(0, lastDiv) + slot + body.slice(lastDiv);
}

/**
 * Render the message that would be sent: the status template, with any
 * subject/body the tech edited taking precedence. Non-empty overrides win;
 * blank ones fall back to the template so nothing is ever sent empty.
 */
const HAS_LINK_PLACEHOLDER = /\{\{\s*(status_url|unsubscribe_url)\s*\}\}/i;

/**
 * Every email should tell the user where to check the repair and how to change
 * what we send them. If the template does not mention either link, add a small
 * footer with both - as long as the public site is configured.
 */
function ensureLinkFooter(body) {
  if (!config.publicSite.url || HAS_LINK_PLACEHOLDER.test(body)) return body;
  const footer =
    '<p style="margin-top:18px;font-size:12px;color:#6b7280">' +
    '<a href="{{status_url}}" style="color:#2563eb">Check this repair\'s status</a>' +
    ' &middot; <a href="{{unsubscribe_url}}" style="color:#2563eb">Choose which emails you get</a>' +
    '</p>';
  const lastDiv = body.lastIndexOf('</div>');
  return lastDiv === -1 ? body + footer : body.slice(0, lastDiv) + footer + body.slice(lastDiv);
}

function compose(ticket, statusKey, { note, subject, body, vars: extraVars } = {}) {
  const key = statusKey || ticket.status;
  const tpl = getTemplate(key);
  const override = (v) => (typeof v === 'string' && v.trim() ? v : null);
  const subjectOverride = override(subject);
  const bodyOverride = override(body);
  if (!tpl && !subjectOverride && !bodyOverride) return null;

  const vars = buildVars(ticket, { note, statusKey: key, vars: extraVars });
  let subjectSrc = subjectOverride || (tpl ? tpl.subject : '');
  let bodySrc = bodyOverride || (tpl ? tpl.body : '');
  if (vars.latest_note) bodySrc = ensureNoteSlot(bodySrc);
  bodySrc = ensureLinkFooter(bodySrc);

  return {
    status_key: key,
    auto_send: tpl ? Boolean(tpl.auto_send) : false,
    custom: Boolean(subjectOverride || bodyOverride),
    to: ticket.user_email || null,
    subject: render(subjectSrc, vars),
    body: render(bodySrc, vars),
  };
}

// Back-compat name used elsewhere in the codebase.
const preview = compose;

function logEmail(entry) {
  const info = getDb()
    .prepare(
      `INSERT INTO email_log (ticket_id, to_email, subject, body, status_key, result, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      entry.ticket_id || null,
      entry.to_email || '',
      entry.subject || null,
      entry.body || null,
      entry.status_key || null,
      entry.result,
      entry.error || null,
      new Date().toISOString()
    );
  return info.lastInsertRowid;
}

/**
 * Send a status email for a ticket.
 * Returns { result: 'sent' | 'dry_run' | 'skipped' | 'error', ... } and never throws
 * for delivery problems - a failed email must not roll back a status change.
 */
async function sendStatusEmail(ticket, statusKey, extra = {}) {
  const rendered = compose(ticket, statusKey, extra);
  if (!rendered) return { result: 'skipped', reason: 'no_template' };
  if (rendered.to && subscriptions.isOptedOut(rendered.to)) {
    logEmail({ ticket_id: ticket.id, to_email: rendered.to, subject: rendered.subject, body: rendered.body, status_key: rendered.status_key, result: 'skipped', error: 'recipient unsubscribed from repair emails' });
    return { result: 'skipped', reason: 'user_unsubscribed', to: rendered.to };
  }
  if (!rendered.to) {
    logEmail({ ticket_id: ticket.id, to_email: '', subject: rendered.subject, body: rendered.body, status_key: rendered.status_key, result: 'skipped', error: 'ticket has no user email' });
    return { result: 'skipped', reason: 'no_recipient' };
  }

  if (config.dryRunEmail) {
    const id = logEmail({ ticket_id: ticket.id, to_email: rendered.to, subject: rendered.subject, body: rendered.body, status_key: rendered.status_key, result: 'dry_run' });
    return { result: 'dry_run', log_id: id, to: rendered.to, subject: rendered.subject };
  }

  const prefsUrl = links.prefsUrl(ticket.id);
  const headers = prefsUrl
    ? { 'List-Unsubscribe': `<${prefsUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }
    : undefined;

  try {
    const sent = await google.sendEmail({ to: rendered.to, subject: rendered.subject, html: rendered.body, headers });
    const id = logEmail({ ticket_id: ticket.id, to_email: rendered.to, subject: rendered.subject, body: rendered.body, status_key: rendered.status_key, result: 'sent' });
    return { result: 'sent', log_id: id, to: rendered.to, subject: rendered.subject, message_id: sent.id };
  } catch (err) {
    const message = (err && err.message) || String(err);
    const id = logEmail({ ticket_id: ticket.id, to_email: rendered.to, subject: rendered.subject, body: rendered.body, status_key: rendered.status_key, result: 'error', error: message });
    return { result: 'error', log_id: id, to: rendered.to, error: message };
  }
}

function ticketEmails(ticketId, limit = 50) {
  return getDb()
    .prepare('SELECT id, to_email, subject, status_key, result, error, created_at FROM email_log WHERE ticket_id = ? ORDER BY id DESC LIMIT ?')
    .all(ticketId, limit);
}

function recentEmails(limit = 100) {
  return getDb()
    .prepare('SELECT id, ticket_id, to_email, subject, status_key, result, error, created_at FROM email_log ORDER BY id DESC LIMIT ?')
    .all(limit);
}

function getEmail(id) {
  return getDb().prepare('SELECT * FROM email_log WHERE id = ?').get(id) || null;
}

module.exports = {
  render, applySections, buildVars, getTemplate, listTemplates, saveTemplate, preview, compose, ensureLinkFooter,
  sendStatusEmail, logEmail, ticketEmails, recentEmails, getEmail, escapeHtml,
};
