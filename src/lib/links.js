'use strict';
/**
 * Signed, unguessable links for the public site. No database lookup is needed to
 * validate one: the ticket id travels in the URL with an HMAC over it.
 *
 *   status page      /t/<id>.<mac>   (read only)
 *   email preferences /u/<id>.<mac>  (can unsubscribe)
 *
 * The two kinds are signed separately, so a status link can never be used to
 * change someone's email settings. Rotate PUBLIC_LINK_SECRET (or delete the
 * generated one from the settings table) to invalidate every link ever sent.
 */
const crypto = require('crypto');
const config = require('./../config');
const { getSetting, setSetting } = require('./../db');

let cached = null;
function secret() {
  if (cached) return cached;
  if (process.env.PUBLIC_LINK_SECRET) {
    cached = process.env.PUBLIC_LINK_SECRET;
    return cached;
  }
  let stored = getSetting('public_link_secret');
  if (!stored) {
    stored = crypto.randomBytes(32).toString('hex');
    setSetting('public_link_secret', stored);
  }
  cached = stored;
  return stored;
}

const mac = (kind, id) =>
  crypto.createHmac('sha256', secret()).update(`${kind}:${id}`).digest('base64url').slice(0, 27);

function mint(kind, id) {
  return `${id}.${mac(kind, id)}`;
}

/** Returns the id, or null if the token is malformed or the signature is wrong. */
function verify(kind, token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [rawId, given] = token.split('.');
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const expected = mac(kind, id);
  const a = Buffer.from(String(given));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return id;
}

const base = () => config.publicSite.url;

const statusUrl = (ticketId) => (base() ? `${base()}/t/${mint('t', ticketId)}` : null);
const prefsUrl = (ticketId) => (base() ? `${base()}/u/${mint('u', ticketId)}` : null);

module.exports = { mint, verify, statusUrl, prefsUrl, secret };
