'use strict';
const path = require('path');
// Tests set SKIP_DOTENV=1: a suite that reads the developer's own .env is not
// testing anything reliable, and this has produced three false failures already.
if (!process.env.SKIP_DOTENV) require('dotenv').config();

const bool = (v, dflt = false) => {
  if (v === undefined || v === null || v === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
};
const trimUrl = (v) => String(v || '').replace(/\/+$/, '');

/**
 * Normalise a URL from .env. A bare hostname is the classic mistake ("repairs.
 * internal.pceagles.org"): Google then receives a redirect_uri with no scheme and
 * answers "Error 400: invalid_request". Fix it up, say so, and never pass junk on.
 */
const normalizeUrl = (raw, label, { defaultScheme = 'https' } = {}) => {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) return '';
  let fixed = value;
  if (!/^https?:\/\//i.test(fixed)) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(fixed)) {
      console.warn(`! ${label}="${value}" is not an http(s) URL - ignoring it`);
      return '';
    }
    const scheme = /^(localhost|127\.0\.0\.1|\[::1\])(:|$)/i.test(fixed) ? 'http' : defaultScheme;
    fixed = `${scheme}://${fixed}`;
    console.warn(`! ${label} is missing a scheme - reading it as ${fixed}`);
  }
  try {
    const url = new URL(fixed);
    return url.origin + (url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, ''));
  } catch {
    console.warn(`! ${label}="${value}" is not a valid URL - ignoring it`);
    return '';
  }
};

/** Parse an integer setting, falling back (loudly) when it is not usable. */
const intInRange = (raw, dflt, min, max) => {
  if (raw === undefined || raw === null || String(raw).trim() === '') return dflt;
  const n = Number(String(raw).trim());
  if (!Number.isInteger(n) || n < min || n > max) {
    console.warn(`! "${raw}" is not a whole number between ${min} and ${max} - using ${dflt}`);
    return dflt;
  }
  return n;
};

// Internal app (the tech UI + API)
const publicUrl = normalizeUrl(process.env.PUBLIC_URL, 'PUBLIC_URL') || 'http://localhost:8080';

// Where Google sends the admin back after consent. Google only accepts https
// URLs or http://localhost, so this is deliberately separate from PUBLIC_URL:
// you can serve the app at http://10.0.0.5:8080 and still connect Google over
// an SSH tunnel to localhost, or serve https on an internal hostname.
const CALLBACK_PATH = '/oauth2/callback';
const redirectBase = normalizeUrl(process.env.OAUTH_REDIRECT_URI, 'OAUTH_REDIRECT_URI');
// The path is easy to forget, so add it when it is missing.
const redirectUri = redirectBase
  ? (redirectBase.endsWith(CALLBACK_PATH) ? redirectBase : redirectBase + CALLBACK_PATH)
  : publicUrl + CALLBACK_PATH;

// The user-facing site (status + email preferences), served on its own port.
const publicSiteUrl = normalizeUrl(process.env.PUBLIC_SITE_URL, 'PUBLIC_SITE_URL');

/** Problems worth refusing to start (or at least shouting about) at boot. */
function redirectUriProblems() {
  const problems = [];
  let url;
  try {
    url = new URL(redirectUri);
  } catch {
    return [`OAUTH_REDIRECT_URI / PUBLIC_URL do not form a valid URL (got "${redirectUri}")`];
  }
  const isLoopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname);
  if (url.protocol === 'http:' && !isLoopback) {
    problems.push(
      `Google will reject the redirect URI ${redirectUri}: anything that is not localhost must use https. ` +
      'Either set OAUTH_REDIRECT_URI=http://localhost:' + (process.env.PORT || 8080) + '/oauth2/callback ' +
      'and connect Google from a browser on this machine (or over an SSH tunnel), or serve https by setting ' +
      'TLS_CERT_PATH and TLS_KEY_PATH.'
    );
  }
  if (/\.local$|\.lan$|\.internal$/i.test(url.hostname)) {
    problems.push(
      `Google does not accept ${url.hostname} as a redirect host: it must be a real domain name (a private ` +
      'A record for a subdomain of a domain you own is fine - Google never resolves it) or localhost.'
    );
  }
  return problems;
}

/**
 * What is running. The version comes from package.json; the commit and build
 * date are injected at image build time (see Dockerfile), so a deployed
 * container can say exactly what it is without guessing.
 */
function buildInfo() {
  let version = '0.0.0';
  try { version = require('../package.json').version || version; } catch { /* keep the default */ }
  return {
    version,
    commit: (process.env.GIT_COMMIT || '').slice(0, 7) || null,
    built_at: process.env.BUILD_DATE || null,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
  };
}

module.exports = {
  build: buildInfo(),
  port: Number(process.env.PORT || 8080),
  callbackPath: CALLBACK_PATH,
  redirectUriProblems,
  host: process.env.HOST || '0.0.0.0',
  publicUrl,
  redirectUri,
  dbPath: path.resolve(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'repairs.db')),
  appPassword: process.env.APP_PASSWORD || '',
  sessionSecret: process.env.SESSION_SECRET || 'insecure-dev-secret',

  // TLS for the internal app. Set both to serve https directly (no nginx needed).
  tls: {
    certPath: process.env.TLS_CERT_PATH || '',
    keyPath: process.env.TLS_KEY_PATH || '',
    // Optional plain-http port that answers only with a redirect to https.
    // Its job is the links already sitting in people's inboxes.
    redirectFromPort: intInRange(process.env.TLS_REDIRECT_HTTP_PORT, 0, 0, 65535),
  },

  google: {
    clientId: process.env.GOOGLE_CLIENT_ID || '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET || '',
    scopes: [
      'openid',
      'email',
      'profile',
      'https://www.googleapis.com/auth/admin.directory.device.chromeos',
      'https://www.googleapis.com/auth/admin.directory.user.readonly',
      'https://www.googleapis.com/auth/gmail.send',
    ],
  },

  // ---- public site ----
  publicSite: {
    enabled: bool(process.env.PUBLIC_SITE_ENABLED, true),
    port: Number(process.env.PUBLIC_SITE_PORT || 8081),
    host: process.env.PUBLIC_SITE_HOST || '0.0.0.0',
    url: publicSiteUrl,
    // Google Sign-In (Google Identity Services) client id for the public page.
    // Usually the same OAuth client as above, with the public origin added under
    // "Authorized JavaScript origins". Blank = sign-in button hidden.
    googleClientId: process.env.PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    // Student sign-in uses the ordinary redirect flow, which needs a client
    // secret as well. Both default to the same Workspace OAuth client as the
    // tech app - only set them for a separate client.
    oauthClientId: process.env.PUBLIC_OAUTH_CLIENT_ID || process.env.PUBLIC_GOOGLE_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '',
    oauthClientSecret: process.env.PUBLIC_OAUTH_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '',
    // Where Google sends students back. Defaults to PUBLIC_SITE_URL +
    // /auth/google/callback; set it explicitly when the address students use is
    // not the address Google should return them to (a proxy, a different port,
    // or simply the string you already registered).
    oauthRedirectUri: normalizeUrl(process.env.PUBLIC_OAUTH_REDIRECT_URI, 'PUBLIC_OAUTH_REDIRECT_URI', { defaultScheme: 'http' }),
    // Only accept sign-ins from these email domains (comma separated).
    allowedDomains: String(process.env.PUBLIC_ALLOWED_DOMAINS || '')
      .split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
    // Trust X-Forwarded-For (only when a reverse proxy you control sits in front).
    // Off by default: with the port exposed directly, that header is attacker-set
    // and would defeat the rate limiter.
    trustProxy: bool(process.env.PUBLIC_TRUST_PROXY, false),
    // Allow the asset tag + email lookup form (magic links always work).
    allowLookup: bool(process.env.PUBLIC_ALLOW_LOOKUP, true),
    // Hostnames allowed to embed the public pages in an iframe (Google Sites).
    frameAncestors: String(process.env.PUBLIC_FRAME_ANCESTORS || "'self' https://sites.google.com https://*.googleusercontent.com"),
    tls: {
      certPath: process.env.PUBLIC_TLS_CERT_PATH || process.env.TLS_CERT_PATH || '',
      keyPath: process.env.PUBLIC_TLS_KEY_PATH || process.env.TLS_KEY_PATH || '',
      // The student site is the one that matters here: every magic link ever
      // emailed points at it, and those links are http until this is set.
      redirectFromPort: intInRange(process.env.PUBLIC_TLS_REDIRECT_HTTP_PORT, 0, 0, 65535),
    },
  },

  // ---- brand (sampled from pceagles.org; change here to re-theme everything) ----
  brand: {
    primary: process.env.BRAND_PRIMARY || '#8A1538',      // maroon
    primaryDark: process.env.BRAND_PRIMARY_DARK || '#6E1029',
    accent: process.env.BRAND_ACCENT || '#ECAE12',        // gold
    ink: process.env.BRAND_INK || '#10181F',
    muted: process.env.BRAND_MUTED || '#5B6770',
    wash: process.env.BRAND_WASH || '#F1F1F1',
    border: process.env.BRAND_BORDER || '#E6E4E1',
  },

  // ---- loaner pool ----
  loaner: {
    // Devices in this Google org unit (or below it) are loaners.
    orgUnit: (process.env.LOANER_ORG_UNIT || '/Devices/Loaners').replace(/\/+$/, '') || '/',
    // Only used to normalise what a tech types/scans: "12" -> "LOANER-012".
    tagPrefix: process.env.LOANER_TAG_PREFIX || 'Loaner-',
    tagPad: intInRange(process.env.LOANER_TAG_PAD, 3, 0, 8),
  },

  // ---- loaner due dates and return reminders ----
  loanerDue: {
    // Working days a loaner is out for by default (weekends and holidays skipped).
    schoolDays: intInRange(process.env.LOANER_DUE_SCHOOL_DAYS, 5, 0, 180),
    // Days of the week that count as school days: 1 = Monday ... 7 = Sunday.
    schoolWeekdays: String(process.env.LOANER_SCHOOL_WEEKDAYS || '1,2,3,4,5')
      .split(',').map((d) => Number(d.trim())).filter((d) => d >= 1 && d <= 7),
    // No school on these dates: YYYY-MM-DD, or YYYY-MM-DD..YYYY-MM-DD for a break.
    holidays: String(process.env.SCHOOL_HOLIDAYS || '').split(',').map((h) => h.trim()).filter(Boolean),
    remindersEnabled: bool(process.env.LOANER_REMINDERS_ENABLED, true),
    // Local time the daily reminder pass runs.
    hour: intInRange(process.env.LOANER_REMINDER_HOUR, 8, 0, 23),
    minute: intInRange(process.env.LOANER_REMINDER_MINUTE, 0, 0, 59),
    // Once overdue, nudge again every N days, this many times at most.
    overdueEveryDays: intInRange(process.env.LOANER_OVERDUE_EVERY_DAYS, 3, 1, 60),
    maxOverdueNudges: intInRange(process.env.LOANER_MAX_OVERDUE_NUDGES, 3, 0, 20),
    // Daily list of what is overdue / due today. Blank = the connected Google account.
    digestTo: process.env.LOANER_DIGEST_TO || '',
    digestEnabled: bool(process.env.LOANER_DIGEST_ENABLED, true),
  },

  // ---- automatic carrier tracking ----
  tracking: {
    // multi | ups | fedex | usps | aftership | mock | none.
    // Blank/none = statuses stay manual.
    //
    // `multi` is the one to use: it reads the tracking number, works out which
    // carrier it belongs to, and calls that carrier's own API. UPS, FedEx and
    // USPS all give those away free, so an aggregator is only worth paying for
    // if parcels arrive on carriers none of them cover. Amazon Logistics (TBA
    // numbers) has no public API at all and stays manual.
    provider: (
      process.env.TRACKING_PROVIDER
      || (process.env.UPS_CLIENT_ID || process.env.FEDEX_CLIENT_ID || process.env.USPS_CLIENT_ID
        ? 'multi'
        : process.env.TRACKING_API_KEY ? 'aftership' : 'none')
    ).toLowerCase(),
    ups: {
      clientId: process.env.UPS_CLIENT_ID || '',
      clientSecret: process.env.UPS_CLIENT_SECRET || '',
      accountNumber: process.env.UPS_ACCOUNT_NUMBER || '',
      env: (process.env.UPS_ENV || 'production').toLowerCase(),
      // UPS wants a source label on every call; it only shows up in their logs.
      transactionSrc: process.env.UPS_TRANSACTION_SRC || 'pceagles-repairs',
    },
    fedex: {
      clientId: process.env.FEDEX_CLIENT_ID || '',
      clientSecret: process.env.FEDEX_CLIENT_SECRET || '',
      env: (process.env.FEDEX_ENV || 'production').toLowerCase(),
    },
    usps: {
      clientId: process.env.USPS_CLIENT_ID || '',
      clientSecret: process.env.USPS_CLIENT_SECRET || '',
      // USPS has moved these before, so neither is baked in.
      apiBase: process.env.USPS_API_BASE || 'https://apis.usps.com',
      trackPath: process.env.USPS_TRACK_PATH || '/tracking/v3/tracking/{tracking}?expand=DETAIL',
    },
    apiKey: process.env.TRACKING_API_KEY || '',
    // Override if your account documents a different API version/host.
    apiBase: process.env.TRACKING_API_BASE || 'https://api.aftership.com/v4',
    // How often an open shipment is re-checked.
    pollMinutes: intInRange(process.env.TRACKING_POLL_MINUTES, 180, 15, 1440),
    // Only poll during these local hours - nobody needs carrier scans at 3am.
    hourFrom: intInRange(process.env.TRACKING_HOUR_FROM, 6, 0, 23),
    hourTo: intInRange(process.env.TRACKING_HOUR_TO, 21, 0, 23),
    // Safety rail on a free API plan.
    maxPerRun: intInRange(process.env.TRACKING_MAX_PER_RUN, 25, 1, 200),
    timeoutMs: intInRange(process.env.TRACKING_TIMEOUT_MS, 12000, 1000, 60000),
  },

  // ---- repair note written back to the device on close ----
  repairNote: {
    onClose: bool(process.env.WRITE_REPAIR_NOTE_ON_CLOSE, true),
    // Google's ChromeOS "notes" field is limited; keep the newest lines.
    maxChars: intInRange(process.env.DEVICE_NOTES_MAX_CHARS, 500, 100, 5000),
  },

  orgName: process.env.ORG_NAME || 'Our District',
  helpdeskName: process.env.HELPDESK_NAME || 'Technology Department',
  helpdeskSignature: process.env.HELPDESK_SIGNATURE || 'Technology Department',
  deviceCacheTtlMinutes: Number(process.env.DEVICE_CACHE_TTL_MINUTES || 720),
  dryRunEmail: bool(process.env.DRY_RUN_EMAIL, false),
  allowDeviceWriteback: bool(process.env.ALLOW_DEVICE_WRITEBACK, true),

  // ---- nightly backup ----
  backup: {
    dir: process.env.BACKUP_DIR || '',
    // A typo like "1:30am" must not turn into NaN and fire the job in a loop.
    hour: intInRange(process.env.BACKUP_HOUR, 1, 0, 23),
    minute: intInRange(process.env.BACKUP_MINUTE, 0, 0, 59),
    keepDays: intInRange(process.env.BACKUP_KEEP_DAYS, 30, 0, 3650),
    gzip: bool(process.env.BACKUP_GZIP, true),
    enabled: bool(process.env.BACKUP_ENABLED, true),
    // Refuse to "back up" onto the same disk as the database (an unmounted NAS
    // path silently becomes a local folder otherwise).
    allowSameDisk: bool(process.env.BACKUP_ALLOW_SAME_DISK, false),
    // Optional: the name of a file that exists ONLY on the NAS share (create it
    // once on the share itself). Device-number checks can be fooled; a file
    // that vanishes with the mount cannot.
    marker: process.env.BACKUP_MARKER_FILE || '',
    // SQLite writes here first (a real local disk), then the finished file is
    // copied to BACKUP_DIR. Network shares cannot be trusted with SQLite's own
    // file creation and locking.
    stagingDir: process.env.BACKUP_STAGING_DIR || '',
  },
};
