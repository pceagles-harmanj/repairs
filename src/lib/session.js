'use strict';
/**
 * Optional shared-password gate. No APP_PASSWORD set => wide open (localhost use).
 * Cookie = base64url(name|issuedAt) . HMAC(secret). The signing secret comes from
 * SESSION_SECRET, or - if that is missing/left at the placeholder - a random one
 * generated on first use and stored in the database, so it is never guessable.
 */
const crypto = require('crypto');
const config = require('./../config');
const { getSetting, setSetting } = require('./../db');

const COOKIE = 'repairs_session';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PLACEHOLDERS = new Set(['', 'insecure-dev-secret', 'change-me-to-something-random']);

let secretCache = null;
function secret() {
  if (secretCache) return secretCache;
  if (!PLACEHOLDERS.has(config.sessionSecret)) {
    secretCache = config.sessionSecret;
    return secretCache;
  }
  let stored = getSetting('session_secret');
  if (!stored) {
    stored = crypto.randomBytes(32).toString('hex');
    setSetting('session_secret', stored);
    if (config.appPassword) console.log('! SESSION_SECRET was not set - generated one and stored it in the database');
  }
  secretCache = stored;
  return stored;
}

const sign = (value) => crypto.createHmac('sha256', secret()).update(value).digest('hex');

function issue(res, who = 'tech') {
  const payload = `${who.replace(/[|]/g, '/')}|${Date.now()}`;
  const token = `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: MAX_AGE_MS,
    secure: config.publicUrl.startsWith('https://'),
  });
}

function clear(res) {
  res.clearCookie(COOKIE);
}

function currentUser(req) {
  if (!config.appPassword) return { name: 'tech', anonymous: true };
  const token = req.cookies && req.cookies[COOKIE];
  if (!token || !token.includes('.')) return null;
  const [b64, mac] = token.split('.');
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = sign(payload);
  if (mac.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const [who, issuedAt] = payload.split('|');
  const age = Date.now() - Number(issuedAt || 0);
  if (!Number.isFinite(age) || age < 0 || age > MAX_AGE_MS) return null; // expired server-side too
  return { name: who || 'tech' };
}

function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  req.user = user;
  next();
}

function checkPassword(password) {
  if (!config.appPassword) return true;
  const a = Buffer.from(String(password || ''));
  const b = Buffer.from(config.appPassword);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { issue, clear, currentUser, requireAuth, checkPassword, COOKIE };
