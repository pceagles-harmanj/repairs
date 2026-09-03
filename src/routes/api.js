'use strict';
const express = require('express');
const config = require('../config');
const tickets = require('../tickets');
const mailer = require('../mailer');
const google = require('../google');
const { resetTemplates } = require('../db');
const backup = require('../backup');
const loaners = require('../loaners');
const loans = require('../loans');
const inventory = require('../inventory');
const models = require('../models');
const shipments = require('../shipments');
const tracking = require('../tracking');
const links = require('../lib/links');
const subscriptions = require('../subscriptions');
const { STATUSES, PRIORITIES } = require('../lib/statuses');

const router = express.Router();
const authorOf = (req) => (req.body && req.body.author) || (req.user && req.user.name) || null;

// ---- meta -------------------------------------------------------------------
router.get('/meta', (req, res) => {
  res.json({
    statuses: STATUSES,
    priorities: PRIORITIES,
    build: config.build,
    org_name: config.orgName,
    helpdesk_name: config.helpdeskName,
    dry_run_email: config.dryRunEmail,
    allow_device_writeback: config.allowDeviceWriteback,
    google: google.status(),
    public_site: {
      enabled: config.publicSite.enabled,
      url: config.publicSite.url,
      port: config.publicSite.port,
      google_signin: require('../public-auth').available(),
      google_signin_blocked_by: require('../public-auth').why(),
      google_signin_redirect_uri: require('../public-auth').redirectUri(),
      allow_lookup: config.publicSite.allowLookup,
    },
    default_notify_statuses: subscriptions.defaultStatuses(),
    brand: config.brand,
    loaner: {
      org_unit: config.loaner.orgUnit,
      tag_prefix: config.loaner.tagPrefix,
      tag_pad: config.loaner.tagPad,
      due_school_days: config.loanerDue.schoolDays,
      reminders_enabled: config.loanerDue.remindersEnabled,
      reasons: loans.REASONS,
      own_device_states: loans.OWN_DEVICE_STATES,
      return_conditions: loans.RETURN_CONDITIONS,
    },
    loaner_template_keys: require('../lib/email-templates').LOANER_TEMPLATE_KEYS,
    parts_template_keys: require('../lib/email-templates').PARTS_TEMPLATE_KEYS,
    inventory: {
      kinds: inventory.KINDS,
      categories: inventory.CATEGORIES,
      donor_statuses: inventory.DONOR_STATUSES,
    },
    shipment_statuses: shipments.STATUSES,
    tracking: tracking.status(),
    repair_note_on_close: config.repairNote.onClose,
    categories: [
      'Cracked screen', 'Keyboard', 'Trackpad', 'Battery / charging', 'Charger / adapter',
      'Hinge / case', 'Speakers / audio', 'Camera', 'Ports', 'Wi-Fi / network',
      'Software / OS', 'Liquid damage', 'Lost / stolen', 'Other',
    ],
  });
});

router.get('/stats', (req, res) => res.json(tickets.stats()));

// ---- google -----------------------------------------------------------------
router.get('/google/status', (req, res) => res.json(google.status()));

router.get('/google/auth-url', (req, res) => {
  res.json({ url: google.getAuthUrl() });
});

router.post('/google/disconnect', async (req, res) => {
  await google.disconnect();
  google.resetClientCache();
  res.json({ ok: true, google: google.status() });
});

// ---- devices ----------------------------------------------------------------
router.get('/devices/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ devices: [] });
  const devices = await google.searchDevices(q, { limit: Number(req.query.limit) || 25 });
  res.json({ devices });
});

router.get('/devices/recent', async (req, res) => {
  res.json({ devices: await google.recentDevices(Number(req.query.limit) || 25) });
});

router.get('/devices/:deviceId', async (req, res) => {
  const device = await google.getDevice(req.params.deviceId, { force: req.query.refresh === '1' });
  const history = tickets.historyForSerial(device.serial);
  res.json({ device, ticket_history: history });
});

router.patch('/devices/:deviceId', async (req, res) => {
  const device = await google.updateDeviceAnnotations(req.params.deviceId, req.body || {});
  res.json({ device });
});

// ---- directory --------------------------------------------------------------
router.get('/users/lookup', async (req, res) => {
  const email = String(req.query.email || '').trim();
  if (!email) return res.status(400).json({ error: 'email is required' });
  res.json({ user: await google.getUser(email) });
});

// ---- tickets ----------------------------------------------------------------
// Express gives an array when a query key repeats; keep only scalars.
const one = (v) => (Array.isArray(v) ? v[0] : v);
const str = (v) => (v === undefined || v === null ? undefined : String(one(v)));

const { canonicalStatus } = require('../lib/statuses');
const statusFilter = (raw) => {
  const value = str(raw);
  if (!value) return value;
  // "new" was renamed to "received"; a saved filter or bookmark still works.
  return value.split(',').map((part) => canonicalStatus(part) || part).join(',');
};

router.get('/tickets', (req, res) => {
  res.json(tickets.list({
    status: statusFilter(req.query.status),
    q: str(req.query.q),
    assignee: str(req.query.assignee),
    limit: str(req.query.limit),
    offset: str(req.query.offset),
  }));
});

router.post('/tickets', async (req, res) => {
  const { notify, ...payload } = req.body || {};

  // A loaner tag typed or scanned on the new-ticket form is resolved against the
  // loaner org unit so the ticket carries the real Google device, not just text.
  if (payload.loaner_asset_tag && !payload.loaner_device_id) {
    try {
      const hits = await google.searchLoaners(payload.loaner_asset_tag, { limit: 5 });
      const exact = hits.find((d) => d.exact) || (hits.length === 1 ? hits[0] : null);
      if (exact) {
        payload.loaner_device_id = exact.device_id;
        payload.loaner_asset_tag = exact.asset_tag || payload.loaner_asset_tag;
        payload.loaner_serial = exact.serial || null;
        payload.loaner_model = exact.model || null;
      } else {
        payload.loaner_asset_tag = google.normalizeLoanerTag(payload.loaner_asset_tag);
      }
    } catch {
      // Google unavailable: keep what the tech typed rather than failing the ticket.
      payload.loaner_asset_tag = google.normalizeLoanerTag(payload.loaner_asset_tag);
    }
  }

  const result = await tickets.create(payload, { author: authorOf(req), notify });
  res.status(201).json(result);
});

router.get('/tickets/:id', (req, res) => {
  const ticket = tickets.detail(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket, ticket_history: tickets.historyForSerial(ticket.serial, ticket.id) });
});

router.patch('/tickets/:id', async (req, res) => {
  const { notify, note, ...patch } = req.body || {};
  const result = await tickets.update(Number(req.params.id), patch, { author: authorOf(req), notify, note });
  if (!result) return res.status(404).json({ error: 'Ticket not found' });
  res.json(result);
});

router.post('/tickets/:id/notes', async (req, res) => {
  const { body, notify } = req.body || {};
  const result = await tickets.addNote(Number(req.params.id), { body, notify: Boolean(notify), author: authorOf(req) });
  if (!result) return res.status(404).json({ error: 'Ticket not found' });
  res.status(201).json(result);
});

router.delete('/tickets/:id', (req, res) => {
  if (!tickets.remove(Number(req.params.id))) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ok: true });
});

// ---- email ------------------------------------------------------------------
router.post('/tickets/:id/email/preview', (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status, note, subject, body } = req.body || {};
  const statusKey = status || ticket.status;
  const preview = mailer.compose(ticket, statusKey, { note, subject, body });
  if (!preview) return res.status(404).json({ error: `No template for status ${statusKey}` });
  res.json({ preview });
});

router.post('/tickets/:id/email/send', async (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const { status, note, subject, body } = req.body || {};
  const statusKey = status || ticket.status;

  // Anything the tech edited wins; anything left blank falls back to the template.
  const result = await mailer.sendStatusEmail(ticket, statusKey, { note, subject, body });
  if (result.result === 'skipped' && result.reason === 'no_recipient') {
    return res.status(400).json({ error: 'This ticket has no user email address.' });
  }

  if (result.result === 'sent' || result.result === 'dry_run') {
    tickets.addEvent(ticket.id, { type: 'email', body: `${result.result === 'dry_run' ? '[dry run] ' : ''}Emailed ${result.to}: ${result.subject}`, author: authorOf(req) || 'system' });
  } else if (result.result === 'error') {
    tickets.addEvent(ticket.id, { type: 'email', body: `Email FAILED: ${result.error}`, author: 'system' });
  }
  res.json(result);
});

router.get('/templates', (req, res) => res.json({ templates: mailer.listTemplates() }));

router.put('/templates/:key', (req, res) => {
  const { subject, body, auto_send } = req.body || {};
  for (const [name, value] of [['subject', subject], ['body', body]]) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim()) {
      return res.status(400).json({ error: `Template ${name} cannot be empty` });
    }
  }
  res.json({ template: mailer.saveTemplate(req.params.key, { subject, body, auto_send }) });
});

// ---- loaners ---------------------------------------------------------------
router.get('/loaners/search', async (req, res) => {
  const q = String(one(req.query.q) || '').trim();
  if (!q) return res.json({ devices: [], normalized: '' });
  const devices = await google.searchLoaners(q, { limit: Number(one(req.query.limit)) || 25 });
  res.json({ devices, normalized: google.normalizeLoanerTag(q) });
});

router.get('/loaners/pool', async (req, res) => {
  res.json({ devices: await google.loanerPool({ limit: Number(one(req.query.limit)) || 60 }) });
});

router.post('/tickets/:id/loaner', async (req, res) => {
  const id = Number(req.params.id);
  const { device_id: deviceId, asset_tag: assetTag } = req.body || {};
  let device = null;

  if (deviceId) {
    device = await google.getDevice(deviceId);
  } else if (assetTag) {
    const hits = await google.searchLoaners(assetTag, { limit: 5 });
    const exact = hits.find((d) => d.exact) || (hits.length === 1 ? hits[0] : null);
    if (!exact) {
      return res.status(hits.length ? 409 : 404).json({
        error: hits.length
          ? `"${assetTag}" matched ${hits.length} loaners - pick one`
          : `No loaner with asset tag "${google.normalizeLoanerTag(assetTag)}" in ${config.loaner.orgUnit}`,
        candidates: hits,
      });
    }
    device = exact;
  } else {
    return res.status(400).json({ error: 'device_id or asset_tag is required' });
  }

  const ticket = tickets.issueLoaner(id, device, { author: authorOf(req), due_day: (req.body || {}).due_day });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket: tickets.detail(id), device, in_loaner_ou: google.isLoaner(device) });
});

// ---- loans: a loaner out, with or without a repair -------------------------
router.get('/loans', (req, res) => {
  const open = str(req.query.open);
  res.json({
    loans: loans.list({
      open: open === '0' ? false : open === 'all' ? null : true,
      borrowerEmail: str(req.query.email) || null,
      limit: Number(str(req.query.limit)) || 500,
    }),
    reasons: loans.REASONS,
    own_device_states: loans.OWN_DEVICE_STATES,
    stats: loaners.stats(),
  });
});

/**
 * Turn typed or scanned asset tags into real Google devices. Used by both the
 * dispatch and the edit routes, because correcting a mis-scanned tag needs
 * exactly the same lookup that creating it did.
 */
async function resolveDevices(body) {
  if (body.loaner_asset_tag && !body.loaner_device_id) {
    try {
      const hits = await google.searchLoaners(body.loaner_asset_tag, { limit: 5 });
      const exact = hits.find((d) => d.exact) || (hits.length === 1 ? hits[0] : null);
      if (exact) {
        body.loaner_device_id = exact.device_id;
        body.loaner_asset_tag = exact.asset_tag || body.loaner_asset_tag;
        body.loaner_serial = exact.serial || body.loaner_serial || null;
        body.loaner_model = exact.model || body.loaner_model || null;
      } else {
        body.loaner_asset_tag = google.normalizeLoanerTag(body.loaner_asset_tag);
      }
    } catch {
      // Google being unreachable must not stop a tech handing out a machine.
      body.loaner_asset_tag = google.normalizeLoanerTag(body.loaner_asset_tag);
    }
  }
  if (body.own_asset_tag && !body.own_device_id) {
    try {
      const hits = await google.searchDevices(body.own_asset_tag, { limit: 5 });
      const exact = hits.find((d) => d.exact) || (hits.length === 1 ? hits[0] : null);
      if (exact) {
        body.own_device_id = exact.device_id;
        body.own_asset_tag = exact.asset_tag || body.own_asset_tag;
        body.own_serial = exact.serial || body.own_serial || null;
        body.own_model = exact.model || body.own_model || null;
      }
    } catch { /* free text is fine */ }
  }
  return body;
}

router.post('/loans', async (req, res, next) => {
  try {
    const body = await resolveDevices({ ...(req.body || {}) });
    const loan = loans.issue(body, { author: authorOf(req), force: Boolean(body.force) });
    // Best effort, and after the loan is safely recorded.
    const note = await loans.noteOnLoaner(
      loan,
      `Loaned to ${loan.borrower_email} (${loan.reason_label})${loan.due_day ? `, due ${loan.due_day}` : ''}`
    );
    res.status(201).json({ loan, google_note: note });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message, existing: err.existing || null });
    next(err);
  }
});

router.get('/loans/:id', (req, res) => {
  const loan = loans.get(Number(req.params.id));
  if (!loan) return res.status(404).json({ error: 'No such loan' });
  res.json({ loan, reasons: loans.REASONS, own_device_states: loans.OWN_DEVICE_STATES });
});

router.patch('/loans/:id', async (req, res, next) => {
  try {
    const body = { ...(req.body || {}) };
    // Only look things up when the tag actually changed, so a save that touches
    // the reason alone does not spend a Google call.
    const current = loans.get(Number(req.params.id));
    if (!current) return res.status(404).json({ error: 'No such loan' });
    if (body.loaner_asset_tag && body.loaner_asset_tag !== current.loaner_asset_tag) {
      delete body.loaner_device_id;
      delete body.loaner_serial;
    } else {
      delete body.loaner_asset_tag;
    }
    if (body.own_asset_tag && body.own_asset_tag !== current.own_asset_tag) {
      delete body.own_device_id;
      delete body.own_serial;
    } else if (!body.own_asset_tag && 'own_asset_tag' in body) {
      // Cleared on purpose: forget the whole device, not just its tag.
      body.own_device_id = null;
      body.own_serial = null;
      body.own_model = null;
    } else {
      delete body.own_asset_tag;
    }
    await resolveDevices(body);
    const loan = loans.update(Number(req.params.id), body, { author: authorOf(req) });
    res.json({ loan });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

/**
 * Tickets worth offering when attaching this loan to a repair: the borrower's
 * own, newest first. Saves hunting for a number in another tab.
 */
router.get('/loans/:id/ticket-options', (req, res) => {
  const loan = loans.get(Number(req.params.id));
  if (!loan) return res.status(404).json({ error: 'No such loan' });
  const email = loan.borrower_email || '';
  // 'all' so a closed ticket that is already attached still shows up; anything
  // else closed is noise when you are looking for the repair to link.
  const rows = email
    ? tickets.list({ q: email, status: 'all', limit: 25 }).tickets
      .filter((t) => !t.closed_at || t.id === loan.ticket_id)
    : [];
  res.json({
    tickets: rows.map((t) => ({
      id: t.id, status: t.status, asset_tag: t.asset_tag, model: t.model,
      issue_category: t.issue_category, issue_description: t.issue_description,
      created_at: t.created_at,
    })),
    attached: loan.ticket_id,
  });
});

router.post('/loans/:id/return', async (req, res, next) => {
  try {
    const { condition, note } = req.body || {};
    const loan = loans.returnLoan(Number(req.params.id), {
      author: authorOf(req), condition: condition || 'ok', note,
    });
    const gnote = await loans.noteOnLoaner(loan, `Returned by ${loan.borrower_email}${condition && condition !== 'ok' ? ` (${condition}: ${note || ''})` : ''}`);
    res.json({ loan, google_note: gnote });
  } catch (err) { next(err); }
});

// Attach a loan to a repair after the fact, or detach it (ticket_id: null).
router.post('/loans/:id/ticket', (req, res, next) => {
  try {
    const { ticket_id: ticketId } = req.body || {};
    res.json({ loan: loans.setTicket(Number(req.params.id), ticketId || null, { author: authorOf(req) }) });
  } catch (err) {
    if (err.statusCode === 409) return res.status(409).json({ error: err.message });
    next(err);
  }
});

router.delete('/loans/:id', (req, res) => {
  res.json(loans.remove(Number(req.params.id)));
});

// ---- the loaner fleet ------------------------------------------------------
/**
 * Every device in the loaner org unit, with whether it is out and to whom.
 * This is the "what can I hand out right now" question, which the pool endpoint
 * on its own could not answer.
 */
router.get('/loaners/fleet', async (req, res, next) => {
  try {
    const devices = await google.loanerPool({ limit: Number(str(req.query.limit)) || 200 });
    const open = loans.list({ open: true, limit: 1000 });
    const byDevice = new Map();
    const byTag = new Map();
    for (const l of open) {
      if (l.loaner_device_id) byDevice.set(l.loaner_device_id, l);
      if (l.loaner_asset_tag) byTag.set(String(l.loaner_asset_tag).toLowerCase(), l);
    }
    const rows = devices.map((d) => {
      const loan = byDevice.get(d.device_id) || byTag.get(String(d.asset_tag || '').toLowerCase()) || null;
      return {
        ...d,
        out: Boolean(loan),
        loan: loan
          ? {
            id: loan.id, borrower_email: loan.borrower_email, borrower_name: loan.borrower_name,
            reason: loan.reason, reason_label: loan.reason_label, due_day: loan.due_day,
            overdue: loan.overdue, ticket_id: loan.ticket_id, days_out: loan.days_out,
          }
          : null,
      };
    });
    // Available first: this list exists to answer "what can I hand out".
    rows.sort((a, b) => Number(a.out) - Number(b.out) || String(a.asset_tag || '').localeCompare(String(b.asset_tag || '')));
    // Loans whose device is not in the OU at all - worth flagging rather than hiding.
    const known = new Set(rows.map((r) => r.device_id));
    const strays = open.filter((l) => !l.loaner_device_id || !known.has(l.loaner_device_id));
    res.json({
      devices: rows,
      stats: {
        total: rows.length,
        available: rows.filter((r) => !r.out).length,
        out: rows.filter((r) => r.out).length,
        overdue: rows.filter((r) => r.loan && r.loan.overdue).length,
      },
      not_in_org_unit: strays,
    });
  } catch (err) { next(err); }
});

// ---- deployed loaners ------------------------------------------------------
router.get('/loaners/out', (req, res) => {
  res.json({
    loaners: loaners.listOutstanding(),
    returned: str(req.query.include_returned) === '1' ? loaners.listReturned({ limit: 50 }) : undefined,
    stats: loaners.stats(),
    reminders: loaners.status(),
  });
});

router.post('/loaners/reminders/run', async (req, res) => {
  res.json(await loaners.runReminders({ reason: 'manual (from the app)' }));
});

router.post('/loaners/digest/send', async (req, res) => {
  res.json({ digest: await loaners.sendDigest({}) });
});

router.patch('/tickets/:id/loaner/due', (req, res) => {
  const id = Number(req.params.id);
  const ticket = tickets.get(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  // Due dates belong to the loan now, so find this ticket's loan first.
  const loan = loans.forTicket(id);
  if (!loan) return res.status(400).json({ error: 'No loaner is issued on this ticket' });
  const { due_day: dueDay, extend_school_days: extend } = req.body || {};
  const day = extend !== undefined && extend !== null
    ? loaners.extendDue(loan.id, Number(extend), { author: authorOf(req) })
    : loaners.setDue(loan.id, dueDay, { author: authorOf(req) });
  res.json({ due_day: day, ticket: tickets.detail(id), loan: loans.get(loan.id) });
});

router.post('/tickets/:id/loaner/return', (req, res) => {
  const ticket = tickets.returnLoaner(Number(req.params.id), { author: authorOf(req) });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket: tickets.detail(Number(req.params.id)) });
});

router.delete('/tickets/:id/loaner', (req, res) => {
  const ticket = tickets.clearLoaner(Number(req.params.id), { author: authorOf(req) });
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ ticket: tickets.detail(Number(req.params.id)) });
});

// ---- repair note on the device ---------------------------------------------
router.get('/tickets/:id/repair-note', (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const summary = ticket.repair_summary || tickets.defaultRepairSummary(ticket);
  res.json({
    summary,
    preview: tickets.repairNoteLine(ticket, summary, authorOf(req)),
    written_at: ticket.repair_note_written_at,
    has_google_device: Boolean(ticket.device_id),
    on_close: config.repairNote.onClose,
  });
});

router.post('/tickets/:id/repair-note', async (req, res) => {
  const ticket = tickets.get(Number(req.params.id));
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const result = await tickets.writeRepairNote(Number(req.params.id), {
    summary: (req.body || {}).summary,
    author: authorOf(req),
  });
  res.status(result.result === 'error' ? 502 : 200).json({ ...result, ticket: tickets.detail(Number(req.params.id)) });
});

// ---- per-ticket notification links + unsubscribe list ----------------------
router.get('/tickets/:id/links', (req, res) => {
  const id = Number(req.params.id);
  const ticket = tickets.get(id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ status_url: links.statusUrl(id), prefs_url: links.prefsUrl(id) });
});

router.get('/optouts', (req, res) => {
  res.json({ optouts: require('../db').getDb().prepare('SELECT * FROM email_optouts ORDER BY created_at DESC LIMIT 200').all() });
});

router.post('/optouts', (req, res) => {
  const { email, action } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email is required' });
  if (action === 'in') subscriptions.optIn(email);
  else subscriptions.optOut(email, 'tech');
  res.json({ ok: true, unsubscribed: subscriptions.isOptedOut(email) });
});

// ---- inventory: parts and donor devices ------------------------------------
router.get('/inventory', (req, res) => {
  res.json({
    items: inventory.list({
      kind: str(req.query.kind),
      q: str(req.query.q),
      category: str(req.query.category),
      lowOnly: str(req.query.low) === '1',
      includeArchived: str(req.query.archived) === '1',
    }),
    stats: inventory.stats(),
    recent_moves: inventory.moves({ limit: 30 }),
  });
});

router.post('/inventory', (req, res) => {
  res.status(201).json({ item: inventory.create(req.body || {}, { author: authorOf(req) }) });
});

router.get('/inventory/shopping-list', (req, res) => {
  const rows = inventory.shoppingList();
  res.json({ items: rows, text: inventory.shoppingListText(rows) });
});

router.get('/inventory/fitting', (req, res) => {
  res.json({ items: inventory.fitting(str(req.query.model), { limit: Number(str(req.query.limit)) || 25 }) });
});

router.get('/inventory/:id', (req, res) => {
  const item = inventory.detail(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'No such inventory item' });
  // `moves` stays at the top level: the UI has been reading it there.
  res.json({ item, moves: item.moves });
});

router.patch('/inventory/:id', (req, res) => {
  const item = inventory.update(Number(req.params.id), req.body || {}, { author: authorOf(req) });
  if (!item) return res.status(404).json({ error: 'No such inventory item' });
  res.json({ item });
});

router.delete('/inventory/:id', (req, res) => {
  res.json(inventory.remove(Number(req.params.id)));
});

router.post('/inventory/:id/adjust', (req, res) => {
  const { delta, reason, note, ticket_id: ticketId } = req.body || {};
  const item = inventory.adjust(Number(req.params.id), delta, {
    reason: reason || 'adjust', note, ticketId, author: authorOf(req),
  });
  res.json({ item, moves: inventory.moves({ itemId: item.id, limit: 20 }) });
});

router.post('/inventory/:id/harvest', (req, res) => {
  const { part_item_id: partItemId, qty, what, ticket_id: ticketId, exhausted } = req.body || {};
  res.json(inventory.harvest(Number(req.params.id), {
    partItemId, qty, what, ticketId, exhausted: Boolean(exhausted), author: authorOf(req),
  }));
});

// ---- donor part lists -------------------------------------------------------
router.get('/inventory/:id/parts', (req, res) => {
  const donor = inventory.get(Number(req.params.id));
  if (!donor) return res.status(404).json({ error: 'No such inventory item' });
  const suggestions = donor.model_id ? models.partsFor(donor.model_id) : [];
  res.json({ parts: inventory.donorParts(donor.id), suggestions });
});

router.post('/inventory/:id/parts', (req, res) => {
  const entries = Array.isArray(req.body && req.body.parts) ? req.body.parts : [req.body || {}];
  res.json({ parts: inventory.addDonorParts(Number(req.params.id), entries, { author: authorOf(req) }) });
});

router.patch('/inventory/:id/parts/:partId', (req, res) => {
  const { state, note } = req.body || {};
  const part = inventory.setDonorPartState(Number(req.params.partId), state, { author: authorOf(req), note });
  res.json({ part, parts: inventory.donorParts(Number(req.params.id)) });
});

router.delete('/inventory/:id/parts/:partId', (req, res) => {
  inventory.removeDonorPart(Number(req.params.partId));
  res.json({ parts: inventory.donorParts(Number(req.params.id)) });
});

// ---- device models ----------------------------------------------------------
router.get('/models', (req, res) => {
  res.json({ models: models.list({ q: str(req.query.q), includeArchived: str(req.query.archived) === '1' }) });
});

router.post('/models', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: 'name is required' });
  res.status(201).json({ model: models.ensure(name, req.body || {}) });
});

router.get('/models/:id/parts', (req, res) => {
  res.json({ parts: models.partsFor(Number(req.params.id)) });
});

router.patch('/models/:id', (req, res) => {
  const model = models.update(Number(req.params.id), req.body || {});
  if (!model) return res.status(404).json({ error: 'No such model' });
  res.json({ model });
});

router.delete('/models/:id', (req, res) => {
  res.json({ ok: models.remove(Number(req.params.id)) });
});

router.post('/models/seed', async (req, res, next) => {
  try {
    res.json(await models.seedFromFleet());
  } catch (err) { next(err); }
});

// Which models does this part fit?
router.put('/inventory/:id/models', (req, res) => {
  const item = inventory.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'No such inventory item' });
  const list = Array.isArray(req.body && req.body.models) ? req.body.models : [];
  res.json({ models: models.setForItem(item.id, list), item: inventory.get(item.id) });
});

// ---- deprovisioning a donor -------------------------------------------------
router.get('/devices/:deviceId/deprovision', async (req, res, next) => {
  try {
    res.json({ check: await google.deprovisionCheck(req.params.deviceId), reasons: google.DEPROVISION_REASONS });
  } catch (err) { next(err); }
});

router.post('/devices/:deviceId/deprovision', async (req, res, next) => {
  try {
    const { reason, confirm } = req.body || {};
    // Deprovisioning cannot be undone, so the client has to say so out loud.
    if (confirm !== true && confirm !== 'yes') {
      return res.status(400).json({ error: 'This cannot be undone. Send confirm:true to go ahead.' });
    }
    res.json(await google.deprovisionDevice(req.params.deviceId, reason || 'retiring_device'));
  } catch (err) { next(err); }
});

// ---- parts on a ticket ------------------------------------------------------
router.get('/tickets/:id/parts', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.get(id)) return res.status(404).json({ error: 'Ticket not found' });
  res.json({
    used: inventory.partsForTicket(id),
    fitted: inventory.ticketParts(id),
    parts_cost: inventory.ticketPartsCost(id),
    incoming: shipments.incomingForTicket(id),
  });
});

// Fitting a part, whatever it came from: the shelf, a donor, or an order.
router.post('/tickets/:id/fitted', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.get(id)) return res.status(404).json({ error: 'Ticket not found' });
  res.status(201).json(inventory.fitPart(id, req.body || {}, { author: authorOf(req) }));
});

router.delete('/tickets/:id/fitted/:partId', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.get(id)) return res.status(404).json({ error: 'Ticket not found' });
  res.json(inventory.unfitPart(id, Number(req.params.partId), { author: authorOf(req) }));
});

// Donor parts that are still on the shelf, for the ticket's part picker.
router.get('/donor-parts', (req, res) => {
  const q = str(req.query.q);
  const rows = require('../db').getDb()
    .prepare(
      `SELECT p.id, p.label, p.item_id, d.id AS donor_id, d.name AS donor_name, d.asset_tag AS donor_asset_tag,
              COALESCE(m.name, d.fits_models) AS donor_models
         FROM donor_parts p
         JOIN inventory_items d ON d.id = p.donor_id
         LEFT JOIN device_models m ON m.id = d.model_id
        WHERE p.state = 'available' AND d.archived = 0
          AND (? = '' OR p.label LIKE ? OR d.name LIKE ? OR d.asset_tag LIKE ?
               OR COALESCE(m.name, '') LIKE ? OR COALESCE(d.fits_models, '') LIKE ?)
        ORDER BY d.name, p.label LIMIT 100`
    )
    .all(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  res.json({ parts: rows });
});

router.post('/tickets/:id/parts', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.get(id)) return res.status(404).json({ error: 'Ticket not found' });
  const { item_id: itemId, qty, note, direction } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'item_id is required' });
  const item = direction === 'return'
    ? inventory.returnFromTicket(id, Number(itemId), qty, { author: authorOf(req) })
    : inventory.useOnTicket(id, Number(itemId), qty, { author: authorOf(req), note });
  res.json({ item, ticket: tickets.detail(id) });
});

// ---- shipments -------------------------------------------------------------
router.get('/shipments', (req, res) => {
  res.json({
    shipments: shipments.list({ status: str(req.query.status) || 'open' }),
    stats: shipments.stats(),
  });
});

router.post('/shipments', (req, res) => {
  res.status(201).json({ shipment: shipments.create(req.body || {}, { author: authorOf(req) }) });
});

router.get('/shipments/:id', (req, res) => {
  const shipment = shipments.get(Number(req.params.id));
  if (!shipment) return res.status(404).json({ error: 'No such shipment' });
  res.json({ shipment });
});

router.patch('/shipments/:id', (req, res) => {
  const shipment = shipments.update(Number(req.params.id), req.body || {}, { author: authorOf(req) });
  if (!shipment) return res.status(404).json({ error: 'No such shipment' });
  res.json({ shipment });
});

router.delete('/shipments/:id', (req, res) => {
  res.json({ ok: shipments.remove(Number(req.params.id)) });
});

router.post('/shipments/:id/lines', (req, res) => {
  res.status(201).json(shipments.addLine(Number(req.params.id), req.body || {}, { author: authorOf(req) }));
});

router.delete('/shipments/:id/lines/:lineId', (req, res) => {
  const shipment = shipments.removeLine(Number(req.params.id), Number(req.params.lineId));
  if (!shipment) return res.status(404).json({ error: 'No such shipment' });
  res.json({ shipment });
});

router.post('/shipments/:id/shipped', async (req, res) => {
  const { expected_day: expectedDay, notify } = req.body || {};
  const result = await shipments.markShipped(Number(req.params.id), {
    expected_day: expectedDay, notify: notify !== false, author: authorOf(req),
  });
  if (!result) return res.status(404).json({ error: 'No such shipment' });
  res.json(result);
});

router.post('/shipments/:id/receive', async (req, res) => {
  const { lines, notify } = req.body || {};
  const result = await shipments.receive(Number(req.params.id), {
    lines, notify: notify !== false, author: authorOf(req),
  });
  if (!result) return res.status(404).json({ error: 'No such shipment' });
  res.json(result);
});

router.post('/shipments/:id/track', async (req, res) => {
  const result = await tracking.pollOne(Number(req.params.id));
  res.json({ ...result, shipment: shipments.get(Number(req.params.id)), tracking: tracking.status() });
});

router.get('/tracking', (req, res) => {
  res.json({ tracking: tracking.status() });
});

router.post('/tracking/poll', async (req, res) => {
  res.json(await tracking.poll({ force: true, respectHours: false }));
});

router.post('/shipments/:id/notify', async (req, res) => {
  const { kind } = req.body || {};
  res.json(await shipments.notifyTickets(Number(req.params.id), kind || 'shipped', { author: authorOf(req), force: true }));
});

// ---- backups ---------------------------------------------------------------
router.get('/backups', (req, res) => {
  res.json({ status: backup.status(), history: backup.history(20) });
});

router.post('/backups/run', async (req, res) => {
  const result = await backup.runBackup({ reason: 'manual (from Settings)' });
  res.status(result.result === 'ok' ? 200 : 500).json({ ...result, status: backup.status() });
});

router.post('/templates/reset', (req, res) => {
  const keepAutoSend = (req.body || {}).keep_auto_send !== false;
  const changed = resetTemplates(undefined, { keepAutoSend });
  res.json({ ok: true, changed, templates: mailer.listTemplates() });
});

router.get('/emails', (req, res) => res.json({ emails: mailer.recentEmails(Number(req.query.limit) || 100) }));

router.get('/emails/:id', (req, res) => {
  const email = mailer.getEmail(Number(req.params.id));
  if (!email) return res.status(404).json({ error: 'Not found' });
  res.json({ email });
});

module.exports = router;
