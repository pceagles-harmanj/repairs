'use strict';
const express = require('express');
const config = require('../config');
const tickets = require('../tickets');
const mailer = require('../mailer');
const google = require('../google');
const { resetTemplates } = require('../db');
const backup = require('../backup');
const loaners = require('../loaners');
const inventory = require('../inventory');
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
    org_name: config.orgName,
    helpdesk_name: config.helpdeskName,
    dry_run_email: config.dryRunEmail,
    allow_device_writeback: config.allowDeviceWriteback,
    google: google.status(),
    public_site: {
      enabled: config.publicSite.enabled,
      url: config.publicSite.url,
      port: config.publicSite.port,
      google_signin: Boolean(config.publicSite.googleClientId),
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

router.get('/tickets', (req, res) => {
  res.json(tickets.list({
    status: str(req.query.status),
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
  const { due_day: dueDay, extend_school_days: extend } = req.body || {};
  const day = extend !== undefined && extend !== null
    ? loaners.extendDue(id, Number(extend), { author: authorOf(req) })
    : loaners.setDue(id, dueDay, { author: authorOf(req) });
  res.json({ due_day: day, ticket: tickets.detail(id) });
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

router.get('/inventory/:id', (req, res) => {
  const item = inventory.get(Number(req.params.id));
  if (!item) return res.status(404).json({ error: 'No such inventory item' });
  res.json({ item, moves: inventory.moves({ itemId: item.id, limit: 100 }) });
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

// ---- parts on a ticket ------------------------------------------------------
router.get('/tickets/:id/parts', (req, res) => {
  const id = Number(req.params.id);
  if (!tickets.get(id)) return res.status(404).json({ error: 'Ticket not found' });
  res.json({ used: inventory.partsForTicket(id), incoming: shipments.incomingForTicket(id) });
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
