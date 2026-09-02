'use strict';
/**
 * Student sign-in on the public site, without the "Sign in with Google" button.
 *
 * The GIS button (the one that renders itself in the page) needs a secure
 * context, and Google will not accept an http:// address as an Authorized
 * JavaScript origin at all. On an internal, plain-http site it simply cannot
 * work.
 *
 * The ordinary OAuth authorization-code flow can: it is a plain redirect to
 * Google and back, and only needs an Authorized *redirect URI* - the same kind
 * of entry the tech app already uses. So the "Sign in with Google" link sends
 * the browser to Google, Google sends it back to /auth/google/callback with a
 * code, and this module swaps that code for the user's identity server-side.
 *
 * Nothing about the student's Google account is stored: we read the verified
 * email, check the domain, and issue the same short session cookie the magic
 * links use.
 */
const crypto = require('crypto');
const config = require('./config');
const links = require('./lib/links');

const CALLBACK_PATH = '/auth/google/callback';
const STATE_COOKIE = 'repairs_oauth_state';
const STATE_TTL_MS = 10 * 60 * 1000;

const clientId = () => config.publicSite.oauthClientId || config.google.clientId;
const clientSecret = () => config.publicSite.oauthClientSecret || config.google.clientSecret;

/**
 * Where Google sends the student back. Must match the Cloud console exactly.
 *
 * PUBLIC_OAUTH_REDIRECT_URI wins when set - useful when the address students
 * type is not the one Google should return them to, or when you would rather
 * pin the exact string you registered. The callback path is appended if the
 * override leaves it off, since that is the easy half to forget.
 */
function redirectUri() {
  const override = config.publicSite.oauthRedirectUri;
  if (override) {
    return override.endsWith(CALLBACK_PATH) ? override : override.replace(/\/+$/, '') + CALLBACK_PATH;
  }
  const base = (config.publicSite.url || '').replace(/\/+$/, '');
  return base ? base + CALLBACK_PATH : '';
}

/**
 * Sign-in is only offered when it can actually work: a client, a secret, a
 * public URL to come back to, and a domain list to check against. Anything
 * missing and the page shows the lookup form instead of a button that 400s.
 */
function available() {
  return Boolean(clientId() && clientSecret() && redirectUri() && config.publicSite.allowedDomains.length);
}

function why() {
  if (!clientId()) return 'no OAuth client id (GOOGLE_CLIENT_ID, or PUBLIC_OAUTH_CLIENT_ID for a separate client)';
  if (!clientSecret()) return 'no OAuth client secret (GOOGLE_CLIENT_SECRET, or PUBLIC_OAUTH_CLIENT_SECRET)';
  if (!redirectUri()) return 'neither PUBLIC_SITE_URL nor PUBLIC_OAUTH_REDIRECT_URI is set, so there is nowhere for Google to send people back to';
  if (!config.publicSite.allowedDomains.length) return 'PUBLIC_ALLOWED_DOMAINS is empty, so any Google account could sign in';
  return null;
}

// --- state ------------------------------------------------------------------

const sign = (value) => crypto.createHmac('sha256', links.secret()).update(value).digest('base64url');

/** A signed, short-lived state value carried in a cookie and in the URL. */
function issueState(res, returnTo = '/') {
  const nonce = crypto.randomBytes(16).toString('base64url');
  const payload = `${nonce}|${Date.now()}|${returnTo}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  res.cookie(STATE_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',           // the callback is a top-level GET from Google
    maxAge: STATE_TTL_MS,
    secure: (config.publicSite.url || '').startsWith('https://'),
  });
  return token;
}

function readState(req, given) {
  const cookie = req.cookies && req.cookies[STATE_COOKIE];
  if (typeof cookie !== 'string' || typeof given !== 'string') return null;
  // Compare what came back from Google against what we put in the cookie.
  const a = Buffer.from(cookie);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const [b64, mac] = cookie.split('.');
  if (!b64 || !mac) return null;
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;

  const [, issuedAt, returnTo] = payload.split('|');
  if (Date.now() - Number(issuedAt || 0) > STATE_TTL_MS) return null;
  return { returnTo: returnTo && returnTo.startsWith('/') ? returnTo : '/' };
}

const clearState = (res) => res.clearCookie(STATE_COOKIE);

// --- the flow ---------------------------------------------------------------

/** Step one: where to send the browser. */
function authUrl(state) {
  const params = new URLSearchParams({
    client_id: clientId(),
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: 'openid email profile',
    state,
    // Students are signed in to several accounts; make them pick.
    prompt: 'select_account',
    include_granted_scopes: 'true',
  });
  // A hint, not a guarantee - the domain is still checked after the exchange.
  const [firstDomain] = config.publicSite.allowedDomains;
  if (firstDomain) params.set('hd', firstDomain);
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/**
 * Step two: swap the code for an identity. Exported so tests can stub it -
 * there is no way to exercise a real Google exchange offline.
 */
async function exchangeCode(code) {
  const { OAuth2Client } = require('google-auth-library');
  const client = new OAuth2Client(clientId(), clientSecret(), redirectUri());
  const { tokens } = await client.getToken(code);
  if (!tokens || !tokens.id_token) throw new Error('Google did not return an identity token');
  const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId() });
  const payload = ticket.getPayload() || {};
  if (!payload.email || !payload.email_verified) throw new Error('Google did not confirm an email address');
  return {
    email: String(payload.email).toLowerCase(),
    name: payload.name || null,
    hd: payload.hd ? String(payload.hd).toLowerCase() : null,
  };
}

/** The domain gate, applied to whatever came back. */
function domainAllowed({ email, hd }) {
  const domains = config.publicSite.allowedDomains;
  if (!domains.length) return false;
  const emailDomain = String(email || '').split('@')[1] || '';
  return domains.includes(emailDomain) || (hd ? domains.includes(hd) : false);
}

module.exports = {
  CALLBACK_PATH, STATE_COOKIE,
  available, why, redirectUri, authUrl, issueState, readState, clearState,
  exchangeCode, domainAllowed, clientId,
};
