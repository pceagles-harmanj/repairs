'use strict';
/**
 * All Google Workspace access lives here:
 *   - OAuth (browser sign-in, refresh token stored in the local DB)
 *   - Admin SDK Directory: ChromeOS device lookups + annotation write-back
 *   - Admin SDK Directory: user lookups (display name)
 *   - Gmail: sending status emails as the signed-in admin
 */
const crypto = require('crypto');
const { google } = require('googleapis');
const config = require('./config');
const { getDb, getSetting, setSetting, deleteSetting, getJsonSetting } = require('./db');

const TOKEN_KEY = 'google_token';
const ACCOUNT_KEY = 'google_account';

class NotConnectedError extends Error {
  constructor(msg = 'Google Workspace is not connected yet. Open Settings and click "Connect Google".') {
    super(msg);
    this.code = 'GOOGLE_NOT_CONNECTED';
    this.statusCode = 409;
  }
}
class NotConfiguredError extends Error {
  constructor(msg = 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are not set in .env') {
    super(msg);
    this.code = 'GOOGLE_NOT_CONFIGURED';
    this.statusCode = 500;
  }
}

function isConfigured() {
  return Boolean(config.google.clientId && config.google.clientSecret);
}

function newOAuthClient() {
  if (!isConfigured()) throw new NotConfiguredError();
  return new google.auth.OAuth2(config.google.clientId, config.google.clientSecret, config.redirectUri);
}

const STATE_KEY = 'google_oauth_state';
const STATE_TTL_MS = 15 * 60 * 1000;

/**
 * Build the consent URL with a single-use random `state`. The callback refuses any
 * code that does not carry it back, so nobody can push their own authorization
 * code (or a stray callback URL) at this app and take over the connection.
 */
function getAuthUrl() {
  const state = crypto.randomBytes(24).toString('base64url');
  setSetting(STATE_KEY, JSON.stringify({ state, createdAt: Date.now() }));
  return newOAuthClient().generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // guarantees we get a refresh_token back
    include_granted_scopes: true,
    scope: config.google.scopes,
    state,
  });
}

/** Validate and burn the state value from the callback. Throws if it does not match. */
function consumeAuthState(state) {
  const stored = getJsonSetting(STATE_KEY);
  deleteSetting(STATE_KEY);
  const bad = () => {
    const err = new Error('This sign-in link is no longer valid. Start again from Settings -> Connect Google.');
    err.statusCode = 400;
    return err;
  };
  if (!stored || !stored.state || !state) throw bad();
  if (Date.now() - Number(stored.createdAt || 0) > STATE_TTL_MS) throw bad();
  const a = Buffer.from(String(state));
  const b = Buffer.from(stored.state);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw bad();
}

async function exchangeCode(code) {
  const client = newOAuthClient();
  const { tokens } = await client.getToken(code);
  const existing = getJsonSetting(TOKEN_KEY) || {};
  // Google only returns refresh_token on first consent; keep the old one if absent.
  const merged = { ...existing, ...tokens };
  if (!merged.refresh_token) throw new Error('Google did not return a refresh token. Revoke the app at myaccount.google.com/permissions and try again.');
  setSetting(TOKEN_KEY, JSON.stringify(merged));
  client.setCredentials(merged);

  // Remember which account we are acting as (used as the From: address).
  let email = null;
  try {
    const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
    email = info.data.email || null;
  } catch { /* non-fatal */ }
  if (!email) {
    try {
      const prof = await google.gmail({ version: 'v1', auth: client }).users.getProfile({ userId: 'me' });
      email = prof.data.emailAddress || null;
    } catch { /* non-fatal */ }
  }
  setSetting(ACCOUNT_KEY, JSON.stringify({ email, connectedAt: new Date().toISOString(), scopes: merged.scope || '' }));
  return { email };
}

function getAccount() {
  return getJsonSetting(ACCOUNT_KEY);
}

function status() {
  const token = getJsonSetting(TOKEN_KEY);
  const account = getAccount();
  return {
    configured: isConfigured(),
    connected: Boolean(token && token.refresh_token),
    email: account ? account.email : null,
    connectedAt: account ? account.connectedAt : null,
    scopes: account ? String(account.scopes || '').split(' ').filter(Boolean) : [],
    redirectUri: config.redirectUri,
  };
}

async function disconnect() {
  const token = getJsonSetting(TOKEN_KEY);
  if (token && token.refresh_token && isConfigured()) {
    try {
      const client = newOAuthClient();
      client.setCredentials(token);
      await client.revokeCredentials();
    } catch { /* already revoked - fine */ }
  }
  deleteSetting(TOKEN_KEY);
  deleteSetting(ACCOUNT_KEY);
}

let cachedClient = null;
function authClient() {
  const token = getJsonSetting(TOKEN_KEY);
  if (!token || !token.refresh_token) throw new NotConnectedError();
  if (!cachedClient) {
    cachedClient = newOAuthClient();
    // googleapis refreshes access tokens on its own; persist the new ones.
    cachedClient.on('tokens', (t) => {
      const current = getJsonSetting(TOKEN_KEY) || {};
      setSetting(TOKEN_KEY, JSON.stringify({ ...current, ...t }));
    });
  }
  cachedClient.setCredentials(getJsonSetting(TOKEN_KEY));
  return cachedClient;
}
function resetClientCache() { cachedClient = null; }

const directory = () => google.admin({ version: 'directory_v1', auth: authClient() });
const gmail = () => google.gmail({ version: 'v1', auth: authClient() });

// --- devices -----------------------------------------------------------------

function normalizeDevice(d) {
  const recentUsers = (d.recentUsers || [])
    .map((u) => u.email)
    .filter(Boolean);
  return {
    device_id: d.deviceId,
    serial: d.serialNumber || null,
    asset_tag: d.annotatedAssetId || null,
    model: d.model || null,
    org_unit: d.orgUnitPath || null,
    status: d.status || null,
    annotated_user: d.annotatedUser || null,
    annotated_location: d.annotatedLocation || null,
    notes: d.notes || null,
    recent_users: recentUsers,
    last_sync: d.lastSync || null,
    os_version: d.osVersion || null,
    auto_update_expiration: d.autoUpdateExpiration || null,
    mac_address: d.macAddress || null,
    most_recent_user: recentUsers[0] || d.annotatedUser || null,
    raw: d,
  };
}

function cacheDevice(device) {
  getDb()
    .prepare(
      `INSERT INTO devices (device_id, serial, asset_tag, model, org_unit, status, annotated_user,
         annotated_location, notes, recent_users, last_sync, os_version, auto_update_expiration,
         mac_address, raw, cached_at)
       VALUES (@device_id, @serial, @asset_tag, @model, @org_unit, @status, @annotated_user,
         @annotated_location, @notes, @recent_users, @last_sync, @os_version, @auto_update_expiration,
         @mac_address, @raw, @cached_at)
       ON CONFLICT(device_id) DO UPDATE SET
         serial=excluded.serial, asset_tag=excluded.asset_tag, model=excluded.model,
         org_unit=excluded.org_unit, status=excluded.status, annotated_user=excluded.annotated_user,
         annotated_location=excluded.annotated_location, notes=excluded.notes,
         recent_users=excluded.recent_users, last_sync=excluded.last_sync, os_version=excluded.os_version,
         auto_update_expiration=excluded.auto_update_expiration, mac_address=excluded.mac_address,
         raw=excluded.raw, cached_at=excluded.cached_at`
    )
    .run({
      ...device,
      recent_users: JSON.stringify(device.recent_users || []),
      raw: JSON.stringify(device.raw || {}),
      cached_at: new Date().toISOString(),
    });
  return device;
}

function readCachedDevice(deviceId) {
  const row = getDb().prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  return row ? hydrate(row) : null;
}

function hydrate(row) {
  let recent = [];
  let raw = {};
  try { recent = JSON.parse(row.recent_users || '[]'); } catch {}
  try { raw = JSON.parse(row.raw || '{}'); } catch {}
  return {
    ...row,
    recent_users: recent,
    most_recent_user: recent[0] || row.annotated_user || null,
    raw,
    from_cache: true,
  };
}

function cacheIsFresh(row) {
  if (!row || !row.cached_at) return false;
  const ageMin = (Date.now() - new Date(row.cached_at).getTime()) / 60000;
  return ageMin < config.deviceCacheTtlMinutes;
}

async function fetchDevice(deviceId) {
  const res = await directory().chromeosdevices.get({
    customerId: 'my_customer',
    deviceId,
    projection: 'FULL',
  });
  return cacheDevice(normalizeDevice(res.data));
}

/** Device detail, cache-first unless `force`. */
async function getDevice(deviceId, { force = false } = {}) {
  const row = getDb().prepare('SELECT * FROM devices WHERE device_id = ?').get(deviceId);
  if (!force && cacheIsFresh(row)) return hydrate(row);
  try {
    return await fetchDevice(deviceId);
  } catch (err) {
    if (row) return { ...hydrate(row), stale: true, lookup_error: err.message };
    throw err;
  }
}

/**
 * The only values Google's chromeosdevices.list accepts for orderBy. Anything
 * else is a 400 ("Invalid value at 'order_by'"), so we filter rather than trust
 * ourselves - there is no annotatedAssetId here, however much you want one.
 * https://developers.google.com/admin-sdk/directory/reference/rest/v1/chromeosdevices/list
 */
const VALID_ORDER_BY = [
  'annotatedLocation', 'annotatedUser', 'lastSync', 'notes', 'serialNumber', 'status', 'supportEndDate',
];

/** Build the list request in one place, dropping anything Google would reject. */
function deviceListParams({ query = null, orgUnitPath = null, maxResults = 25, orderBy = null, sortOrder = null } = {}) {
  const params = { customerId: 'my_customer', projection: 'FULL', maxResults };
  if (query) params.query = query;
  if (orgUnitPath) params.orgUnitPath = orgUnitPath;
  if (orderBy) {
    if (VALID_ORDER_BY.includes(orderBy)) {
      params.orderBy = orderBy;
      // sortOrder is only meaningful alongside a valid orderBy.
      if (sortOrder) params.sortOrder = sortOrder;
    } else {
      console.warn(`! ignoring unsupported device orderBy "${orderBy}" (Google accepts: ${VALID_ORDER_BY.join(', ')})`);
    }
  }
  return params;
}

async function listPage(query, maxResults = 25) {
  const res = await directory().chromeosdevices.list(
    deviceListParams({ query, maxResults, orderBy: 'lastSync', sortOrder: 'DESCENDING' })
  );
  return (res.data.chromeosdevices || []).map(normalizeDevice);
}

/**
 * Google's `asset_id:` and `id:` queries match by PREFIX, so asset tag "24-1"
 * also returns 24-111 and 24-214. We label every hit with how it matched and
 * sort exact matches to the front so the tech's paste lands on the right device.
 */
const MATCH_ORDER = { exact_asset_tag: 0, exact_serial: 1, user: 2, partial_asset_tag: 3, partial_serial: 4, other: 5 };

function classifyMatch(term, d) {
  const t = String(term || '').trim().toLowerCase();
  const asset = String(d.asset_tag || '').toLowerCase();
  const serial = String(d.serial || '').toLowerCase();
  const users = [d.annotated_user, ...(d.recent_users || [])].filter(Boolean).map((u) => String(u).toLowerCase());
  if (asset && asset === t) return 'exact_asset_tag';
  if (serial && serial === t) return 'exact_serial';
  if (users.includes(t)) return 'user';
  if (asset && asset.startsWith(t)) return 'partial_asset_tag';
  if (serial && serial.startsWith(t)) return 'partial_serial';
  if (asset.includes(t)) return 'partial_asset_tag';
  if (serial.includes(t)) return 'partial_serial';
  return 'other';
}

/** Milliseconds since epoch for a sync timestamp, or 0 when Google gave us none. */
function syncedAt(device) {
  const t = device && device.last_sync ? Date.parse(device.last_sync) : NaN;
  return Number.isFinite(t) ? t : 0;
}

/** Most recently synced first - the device someone is actually holding. */
function byNewestSync(a, b) {
  return syncedAt(b) - syncedAt(a);
}

function rankDevices(term, devices) {
  return devices
    .map((d) => {
      const match = classifyMatch(term, d);
      return { ...d, match, exact: match === 'exact_asset_tag' || match === 'exact_serial' };
    })
    .sort((a, b) => {
      // Match quality still wins: typing "24-1" must not bury 24-1 under a
      // freshly-synced 24-111. Newest-first only orders within a match class.
      const byMatch = MATCH_ORDER[a.match] - MATCH_ORDER[b.match];
      if (byMatch !== 0) return byMatch;
      const bySync = byNewestSync(a, b);
      if (bySync !== 0) return bySync;
      // Then shortest asset tag first: 24-1 before 24-111.
      const al = (a.asset_tag || a.serial || '').length;
      const bl = (b.asset_tag || b.serial || '').length;
      if (al !== bl) return al - bl;
      return String(a.asset_tag || a.serial || '').localeCompare(String(b.asset_tag || b.serial || ''));
    });
}

/**
 * Search Google for a device the way a tech would: paste a serial, an asset
 * tag, or a student's email. The Admin SDK has no OR operator, so we fire the
 * plausible queries in parallel and merge.
 */
async function searchDevices(term, { limit = 25 } = {}) {
  const t = String(term || '').trim();
  if (!t) return [];
  const queries = t.includes('@')
    ? [`user:${t}`, `recent_user:${t}`]
    : [`id:${t}`, `asset_id:${t}`, `recent_user:${t}`, t];

  const results = await Promise.allSettled(queries.map((q) => listPage(q, limit)));
  const merged = new Map();
  const failures = [];
  for (const r of results) {
    if (r.status === 'fulfilled') {
      for (const d of r.value) if (!merged.has(d.device_id)) merged.set(d.device_id, d);
    } else {
      failures.push(r.reason);
    }
  }
  // Every query failed: surface the real reason (not connected, 403, quota...).
  if (!merged.size && failures.length === results.length) {
    const first = failures[0];
    if (first && (first.code === 'GOOGLE_NOT_CONNECTED' || first.code === 'GOOGLE_NOT_CONFIGURED')) throw first;
    const err = new Error((first && first.message) || 'Device search failed');
    err.statusCode = first && first.statusCode ? first.statusCode : 502;
    err.response = first && first.response;
    throw err;
  }
  const ranked = rankDevices(t, [...merged.values()]).slice(0, limit);
  for (const d of ranked) cacheDevice(d);
  return ranked;
}

/** Recently synced devices, for the "browse" view. */
async function recentDevices(limit = 25) {
  const devices = await listPage(null, limit);
  for (const d of devices) cacheDevice(d);
  return devices;
}

/** Write asset tag / user / location / notes back to Google Admin. */
async function updateDeviceAnnotations(deviceId, fields) {
  if (!config.allowDeviceWriteback) {
    const err = new Error('Device write-back is disabled (ALLOW_DEVICE_WRITEBACK=false)');
    err.statusCode = 403;
    throw err;
  }
  const body = {};
  if (fields.asset_tag !== undefined) body.annotatedAssetId = fields.asset_tag;
  if (fields.annotated_user !== undefined) body.annotatedUser = fields.annotated_user;
  if (fields.annotated_location !== undefined) body.annotatedLocation = fields.annotated_location;
  if (fields.notes !== undefined) body.notes = fields.notes;
  if (!Object.keys(body).length) {
    const err = new Error('Nothing to update');
    err.statusCode = 400;
    throw err;
  }
  const res = await directory().chromeosdevices.update({
    customerId: 'my_customer',
    deviceId,
    projection: 'FULL',
    requestBody: body,
  });
  return cacheDevice(normalizeDevice(res.data));
}

// --- deprovisioning ----------------------------------------------------------

/**
 * Reasons Google accepts for taking a Chromebook off the licence. The two that
 * matter for a scrap pile are the retirement ones; the rest are here so the UI
 * can offer the right words for the right situation.
 */
const DEPROVISION_REASONS = [
  { value: 'retiring_device', label: 'Retiring the device (scrap / donor)' },
  { value: 'different_model_replacement', label: 'Replaced with a different model' },
  { value: 'same_model_replacement', label: 'Replaced with the same model' },
  { value: 'upgrade_transfer', label: 'Upgrade transfer' },
];

/**
 * Is this device still holding a licence? A donor sitting in Google Admin as
 * ACTIVE is a licence we are paying for and a device that still counts against
 * enrolment, so the parts page nags about it.
 */
async function deprovisionCheck(deviceId) {
  const device = await getDevice(deviceId).catch(() => null);
  if (!device) return { known: false, deprovisioned: false, status: null };
  const status = String(device.status || '').toUpperCase();
  return {
    known: true,
    deprovisioned: status === 'DEPROVISIONED',
    disabled: status === 'DISABLED',
    status: device.status || null,
    device_id: device.device_id,
    asset_tag: device.asset_tag,
    serial: device.serial,
    admin_url: adminDeviceUrl(device),
    writeback_enabled: config.allowDeviceWriteback,
  };
}

/** Deep link to the device in the Google Admin console, for the "do it yourself" path. */
function adminDeviceUrl(device) {
  const id = device && device.device_id;
  return id ? `https://admin.google.com/ac/chrome/devices/${encodeURIComponent(id)}` : null;
}

/**
 * Actually deprovision. This is one-way in Google - the device cannot be
 * re-enrolled without a wipe and a licence - so the API route guards it and the
 * UI asks twice.
 */
async function deprovisionDevice(deviceId, reason = 'retiring_device') {
  if (!config.allowDeviceWriteback) {
    const err = new Error('Device write-back is disabled (ALLOW_DEVICE_WRITEBACK=false)');
    err.statusCode = 403;
    throw err;
  }
  if (!DEPROVISION_REASONS.some((r) => r.value === reason)) {
    const err = new Error(`Unknown deprovision reason "${reason}"`);
    err.statusCode = 400;
    throw err;
  }
  await directory().chromeosdevices.action({
    customerId: 'my_customer',
    resourceId: deviceId,
    requestBody: { action: 'deprovision', deprovisionReason: reason },
  });
  // The action endpoint returns nothing useful, so re-read to get the new status.
  const fresh = await getDevice(deviceId, { force: true }).catch(() => null);
  return { ok: true, reason, device: fresh, check: await deprovisionCheck(deviceId) };
}

// --- loaners -----------------------------------------------------------------

/**
 * Techs type or scan "12", "loaner-12", "LOANER-012". Google needs the real
 * asset tag, so normalise to the house format (Loaner-012 by default).
 */
function normalizeLoanerTag(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const prefix = config.loaner.tagPrefix;
  const pad = config.loaner.tagPad;
  const bare = raw.replace(new RegExp('^' + prefix.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&') + '?', 'i'), '');
  const m = /^[-_ ]?(\d+)$/.exec(bare);
  if (!m) return raw;
  return prefix + m[1].padStart(pad, '0');
}

/** Is this device in the loaner org unit (or below it)? */
function isLoaner(device) {
  const ou = String((device && device.org_unit) || '').toLowerCase();
  const target = String(config.loaner.orgUnit || '').toLowerCase();
  if (!target || target === '/') return Boolean(ou);
  return ou === target || ou.startsWith(target + '/');
}

async function listOrgUnitPage(query, maxResults = 50) {
  // Asset tags are not a sortable field in this API, so sort by last sync and
  // let rankDevices put exact tag matches on top afterwards.
  const res = await directory().chromeosdevices.list(
    deviceListParams({
      query, orgUnitPath: config.loaner.orgUnit, maxResults,
      orderBy: 'lastSync', sortOrder: 'DESCENDING',
    })
  );
  return (res.data.chromeosdevices || []).map(normalizeDevice);
}

/** Search only the loaner org unit, by asset tag or serial. */
async function searchLoaners(term, { limit = 25 } = {}) {
  const raw = String(term || '').trim();
  if (!raw) return [];
  const tag = normalizeLoanerTag(raw);
  const queries = [...new Set([`asset_id:${tag}`, `asset_id:${raw}`, `id:${raw}`])];
  const results = await Promise.allSettled(queries.map((q) => listOrgUnitPage(q, limit)));

  const merged = new Map();
  const failures = [];
  for (const r of results) {
    if (r.status === 'fulfilled') for (const d of r.value) if (!merged.has(d.device_id)) merged.set(d.device_id, d);
    else failures.push(r.reason);
  }
  if (!merged.size && failures.length === results.length) {
    const first = failures[0];
    if (first && (first.code === 'GOOGLE_NOT_CONNECTED' || first.code === 'GOOGLE_NOT_CONFIGURED')) throw first;
    const err = new Error((first && first.message) || 'Loaner search failed');
    err.statusCode = (first && first.statusCode) || 502;
    err.response = first && first.response;
    throw err;
  }
  // Rank against the normalised tag so "12" lands on Loaner-012, not Loaner-120.
  const ranked = rankDevices(tag, [...merged.values()]).slice(0, limit);
  for (const d of ranked) cacheDevice(d);
  return ranked.map((d) => ({ ...d, is_loaner: true }));
}

/** The whole loaner pool, for a picker. */
async function loanerPool({ limit = 60 } = {}) {
  const devices = await listOrgUnitPage(null, limit);
  for (const d of devices) cacheDevice(d);
  // No search term here, so newest sync is the only useful order.
  return devices.sort(byNewestSync).map((d) => ({ ...d, is_loaner: true }));
}

// --- notes write-back --------------------------------------------------------

/**
 * Append one line to a device's Admin notes, keeping what is already there.
 * Google's notes field is finite, so when the limit is reached the OLDEST lines
 * are dropped - the recent repair history is the part people need.
 */
async function appendDeviceNote(deviceId, line, { maxChars = config.repairNote.maxChars } = {}) {
  const text = sanitizeNoteLine(line);
  if (!text) {
    const err = new Error('Nothing to write');
    err.statusCode = 400;
    throw err;
  }
  const device = await getDevice(deviceId, { force: true });
  const existing = String(device.notes || '').trim();
  let lines = existing ? existing.split(/\r?\n/) : [];
  lines.push(text);

  let dropped = 0;
  while (lines.join('\n').length > maxChars && lines.length > 1) {
    lines.shift();
    dropped += 1;
  }
  let notes = lines.join('\n');
  if (notes.length > maxChars) notes = notes.slice(0, maxChars); // one very long line

  const updated = await updateDeviceAnnotations(deviceId, { notes });
  return { device: updated, notes, dropped, line: text };
}

/** Notes are one-per-line, so newlines in the middle of a line would break parsing. */
function sanitizeNoteLine(line) {
  return String(line == null ? '' : line)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// --- users -------------------------------------------------------------------

const userCache = new Map();

async function getUser(email) {
  const key = String(email || '').toLowerCase();
  if (!key) return null;
  if (userCache.has(key)) return userCache.get(key);
  try {
    const res = await directory().users.get({ userKey: key, projection: 'basic' });
    const u = res.data;
    const info = {
      email: u.primaryEmail,
      name: (u.name && u.name.fullName) || null,
      given_name: (u.name && u.name.givenName) || null,
      org_unit: u.orgUnitPath || null,
      suspended: Boolean(u.suspended),
    };
    userCache.set(key, info);
    return info;
  } catch {
    userCache.set(key, null);
    return null;
  }
}

// --- gmail -------------------------------------------------------------------

/** Strip anything that could start a new header line (CR/LF, NUL) and trim. */
function sanitizeHeader(value) {
  // eslint-disable-next-line no-control-regex
  return String(value == null ? '' : value).replace(/[\r\n\u0000]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function encodeHeader(value) {
  const clean = sanitizeHeader(value);
  // RFC 2047 for non-ASCII subjects.
  // eslint-disable-next-line no-control-regex
  return /[^\x00-\x7F]/.test(clean)
    ? '=?UTF-8?B?' + Buffer.from(clean, 'utf8').toString('base64') + '?='
    : clean;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '-', ndash: '-', middot: '-', hellip: '...', rarr: '->' };

function decodeEntities(text) {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name) => (ENTITIES[name.toLowerCase()] !== undefined ? ENTITIES[name.toLowerCase()] : m));
}

/** Plain-text alternative for the multipart email. Keeps table rows readable. */
function htmlToText(html) {
  const text = String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, ': ')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').replace(/:\s*$/, '').trim())
    .filter((line, i, arr) => line !== '' || (i > 0 && arr[i - 1] !== ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildRawMessage({ from, fromName, to, subject, html, replyTo, headers: extraHeaders = {} }) {
  const boundary = 'rt_' + crypto.randomBytes(9).toString('hex');
  const text = htmlToText(html);

  const headers = [
    `From: ${fromName ? `${encodeHeader(fromName)} <${sanitizeHeader(from)}>` : sanitizeHeader(from)}`,
    `To: ${sanitizeHeader(to)}`,
    replyTo ? `Reply-To: ${sanitizeHeader(replyTo)}` : null,
    `Subject: ${encodeHeader(subject)}`,
    ...Object.entries(extraHeaders)
      .filter(([, v]) => v)
      .map(([k, v]) => `${sanitizeHeader(k)}: ${sanitizeHeader(v)}`),
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
  ].filter(Boolean);

  const message = [
    headers.join('\r\n'),
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    'Content-Transfer-Encoding: 8bit',
    '',
    html,
    `--${boundary}--`,
    '',
  ].join('\r\n');

  return Buffer.from(message, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendEmail({ to, subject, html, headers }) {
  const account = getAccount();
  const from = (account && account.email) || 'me';
  const raw = buildRawMessage({
    from,
    fromName: `${config.helpdeskName} (${config.orgName})`,
    to,
    subject,
    html,
    replyTo: from,
    headers,
  });
  const res = await gmail().users.messages.send({ userId: 'me', requestBody: { raw } });
  return { id: res.data.id, threadId: res.data.threadId, from };
}

module.exports = {
  NotConnectedError,
  NotConfiguredError,
  isConfigured,
  getAuthUrl,
  consumeAuthState,
  exchangeCode,
  status,
  getAccount,
  disconnect,
  resetClientCache,
  normalizeDevice,
  deviceListParams,
  VALID_ORDER_BY,
  cacheDevice,
  readCachedDevice,
  getDevice,
  searchDevices,
  rankDevices,
  byNewestSync,
  syncedAt,
  classifyMatch,
  recentDevices,
  updateDeviceAnnotations,
  DEPROVISION_REASONS,
  deprovisionCheck,
  deprovisionDevice,
  adminDeviceUrl,
  normalizeLoanerTag,
  isLoaner,
  searchLoaners,
  loanerPool,
  appendDeviceNote,
  sanitizeNoteLine,
  getUser,
  sendEmail,
  buildRawMessage,
  htmlToText,
  sanitizeHeader,
};
