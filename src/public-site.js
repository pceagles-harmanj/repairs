'use strict';
/**
 * The user-facing site, served on its own port (PUBLIC_SITE_PORT) so that only
 * these routes are ever exposed off-network. It shares the database with the
 * tech app but has no access to the ticket API, no notes, and no device data
 * beyond the model and asset tag.
 *
 * Three ways in, in order of privacy:
 *   1. /t/<token>  magic link from an email  - unguessable, no login
 *   2. Google sign-in                        - shows every ticket for that address
 *   3. asset tag + email form                - both must match, rate limited
 *
 * What a user can see: status, the issue as reported, dates, and the status
 * history. Never internal notes, never other people's tickets.
 */
const crypto = require('crypto');
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const config = require('./config');
const { getDb } = require('./db');
const links = require('./lib/links');
const subscriptions = require('./subscriptions');
const publicAuth = require('./public-auth');
const { STATUSES, statusLabel } = require('./lib/statuses');

const esc = (v) =>
  v === null || v === undefined
    ? ''
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const statusColor = (key) => (STATUSES.find((s) => s.key === key) || { color: '#64748b' }).color;

// Plain-language explanation for each status - this is what users actually want.
const EXPLAIN = {
  new: 'We have the device checked in and it is in the queue.',
  diagnosing: 'A technician is figuring out what it needs.',
  in_progress: 'The repair is underway.',
  waiting_on_parts: 'We are waiting on a part to arrive before we can finish.',
  waiting_on_user: 'We need something from you before we can continue - check your email.',
  ready_for_pickup: 'The repair is finished. Come pick it up at the technology office.',
  closed: 'This repair is complete and the ticket is closed.',
  cancelled: 'This ticket was cancelled and no work is planned.',
};

const fmtDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// ---------------------------------------------------------------- views
const CSS = `
:root{--bg:${config.brand.wash};--panel:#fff;--border:${config.brand.border};--text:${config.brand.ink};
      --muted:${config.brand.muted};--accent:${config.brand.primary};--gold:${config.brand.accent}}
@media (prefers-color-scheme:dark){:root{--bg:#14100f;--panel:#1d1817;--border:#3a302e;--text:#f3efec;
      --muted:#b6a9a4;--accent:#e79ab0;--gold:${config.brand.accent}}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif}
.band{background:${config.brand.primary};color:#fff;border-bottom:4px solid var(--gold)}
.band .inner{max-width:680px;margin:0 auto;padding:14px 18px;display:flex;align-items:center;gap:14px}
/* The eagle's body is the same maroon as the band, so it needs a light disc
   behind it or it reads as a hole. */
.crest{height:46px;width:46px;flex:0 0 auto;background:#fff;border-radius:50%;padding:5px;
       object-fit:contain;box-shadow:0 1px 3px rgba(0,0,0,.25)}
.band .school{font:600 17px/1.3 inherit}
.band .dept{font:400 13px/1.4 inherit;opacity:.85}
.wrap{max-width:680px;margin:0 auto;padding:22px 18px 48px}
h1{font-size:21px;margin:0 0 4px}
h2{font-size:15px;margin:0 0 10px}
.sub{color:var(--muted);font-size:13.5px;margin:0 0 20px}
.card{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:18px;margin-bottom:16px}
.pill{display:inline-block;padding:3px 11px;border-radius:999px;color:#fff;font-size:12.5px;font-weight:600}
.kv{display:grid;grid-template-columns:130px 1fr;gap:6px 12px;font-size:14px;margin:14px 0 0}
.kv dt{color:var(--muted)}
.kv dd{margin:0}
label{display:block;margin-bottom:12px;font-size:13px;color:var(--muted);font-weight:600}
input[type=text],input[type=email]{width:100%;padding:10px;border:1px solid var(--border);border-radius:8px;background:var(--panel);color:var(--text);font-size:15px}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:10px 16px;font-size:15px;font-weight:600;cursor:pointer}
button:hover{filter:brightness(1.08)}
button.ghost{background:transparent;color:var(--accent);border:1px solid var(--border)}
.note{background:rgba(236,174,18,.16);border-left:3px solid var(--gold);border-radius:0 8px 8px 0;padding:10px 14px;font-size:13.5px;color:var(--text)}
.err{background:rgba(185,28,28,.1);color:#b91c1c;border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:16px}
.ok{background:rgba(22,163,74,.12);color:#15803d;border-radius:8px;padding:10px 14px;font-size:14px;margin-bottom:16px}
.highlight{background:var(--gold);color:#23180a;border-radius:10px;padding:14px 18px;font-weight:600;margin-bottom:16px}
ol.steps{list-style:none;padding:0;margin:14px 0 0}
ol.steps li{padding:8px 0 8px 16px;border-left:2px solid var(--border);position:relative;font-size:14px}
ol.steps li::before{content:'';position:absolute;left:-5px;top:14px;width:8px;height:8px;border-radius:50%;background:var(--border)}
ol.steps li.now::before{background:var(--gold);box-shadow:0 0 0 3px rgba(236,174,18,.3)}
ol.steps li.parts{color:var(--muted)}
ol.steps li.parts::before{background:var(--accent);opacity:.5}
ol.steps li.pending{opacity:.6}
ol.steps li.pending::before{background:transparent;border:2px solid var(--border);width:6px;height:6px}
ol.steps li .when{color:var(--muted);font-size:12.5px}
.check{display:flex;gap:9px;align-items:flex-start;margin-bottom:10px;font-weight:400;color:var(--text);font-size:14px}
.check input{margin-top:3px}
.foot{color:var(--muted);font-size:12.5px;text-align:center;margin-top:26px}
a{color:var(--accent)}
.ticket-row{display:block;text-decoration:none;color:inherit;border:1px solid var(--border);border-radius:10px;padding:12px 14px;margin-bottom:10px;background:var(--panel)}
.ticket-row:hover{border-color:var(--accent)}
`;

function page(title, body, { extraHead = '' } = {}) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="${esc(config.brand.primary)}">
<title>${esc(title)}</title><style>${CSS}</style>${extraHead}</head>
<body>
<header class="band"><div class="inner">
  <img src="/logo.png" alt="" class="crest" width="46" height="46">
  <div>
    <div class="school">${esc(config.orgName)}</div>
    <div class="dept">${esc(config.helpdeskName)}</div>
  </div>
</div></header>
<div class="wrap">${body}
<p class="foot">${esc(config.orgName)} &middot; ${esc(config.helpdeskName)}</p>
</div></body></html>`;
}

const statusBlock = (t) => `
  <span class="pill" style="background:${esc(statusColor(t.status))}">${esc(statusLabel(t.status))}</span>
  <p style="margin:12px 0 0">${esc(EXPLAIN[t.status] || '')}</p>`;

/** "Parts shipped - expected Tuesday". No carrier, no tracking number. */
const partsNote = (t) =>
  t.parts_expectation
    ? `<div class="note" style="margin-top:14px">${esc(t.parts_expectation)}</div>`
    : '';

/**
 * The loaner, as a section of its own.
 *
 * The one thing this has to land is the swap: we hand the repaired device back
 * when the loaner comes in. Said once in passing, it gets missed and the student
 * turns up empty-handed; said plainly at the top of the page, it does not.
 */
function loanerCard(t) {
  const tag = t.loaner_asset_tag || t.loaner_serial;
  if (!tag) return '';
  const due = t.loaner_due || {};
  const out = !t.loaner_returned_at;
  const readyToSwap = out && (t.status === 'ready_for_pickup' || t.status === 'closed');

  const rows = [
    ['Loaner', esc(tag)],
    t.loaner_model ? ['Model', esc(t.loaner_model)] : null,
    t.loaner_issued_at ? ['Borrowed', esc(fmtDate(t.loaner_issued_at))] : null,
    out && due.due_day ? ['Due back', esc(due.due_label || due.due_day)] : null,
    !out ? ['Returned', esc(fmtDate(t.loaner_returned_at))] : null,
  ].filter(Boolean);

  const status = !out
    ? '<p style="margin:0">Thank you &mdash; this loaner is back with us. Nothing else to do.</p>'
    : due.overdue
    ? `<div class="err" style="margin:0 0 12px">This loaner was due back on ${esc(due.due_label || due.due_day)}.
        Please return it to the ${esc(config.helpdeskName)} as soon as you can.</div>`
    : due.due_today
    ? `<div class="note" style="margin:0 0 12px">This loaner is due back <b>today</b>.</div>`
    : '';

  const swap = readyToSwap
    ? `<div class="highlight" style="margin:0 0 14px">Bring loaner ${esc(tag)} with you.
        We hand your own device back when the loaner comes in.</div>`
    : out
    ? `<p style="margin:12px 0 0">Keep using it until your device is ready. When we tell you it is ready,
        <b>bring the loaner with you</b> &mdash; we swap the two over at the counter.</p>`
    : '';

  return `<div class="card">
    <h2>Your loaner device</h2>
    ${swap}
    ${status}
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    ${out ? `<p class="sub" style="margin:14px 0 0">Please look after it: it goes to the next student when you
      are done. If something goes wrong with the loaner itself, tell the ${esc(config.helpdeskName)}.</p>` : ''}
  </div>`;
}

function ticketPage(t, history) {
  // The repair's own steps, with the parts journey folded in where it happened,
  // so one list answers "what is happening" without a second widget.
  const merged = [
    ...history.map((h) => ({ kind: 'status', label: statusLabel(h.status), at: h.at, done: true })),
    // Only stages that actually happened, or a delivery still ahead of us -
    // stages the carrier skipped would just be noise here.
    ...(t.parts_milestones || [])
      .filter((m) => m.done || m.expected)
      .map((m) => ({
        kind: 'parts',
        label: m.label,
        at: m.at,
        done: m.done,
        expected: m.expected,
      })),
  ].sort((a, b) => {
    // Real timestamps, not string compare: ticket events are UTC ISO while
    // carrier scans arrive with their own offsets.
    const t = (m) => {
      const raw = m.at || m.expected;
      const ms = raw ? Date.parse(raw) : NaN;
      return Number.isNaN(ms) ? Infinity : ms;
    };
    return t(a) - t(b);
  });

  const lastDone = merged.filter((m) => m.done).pop();
  const steps = merged
    .map(
      (m) => `<li class="${m === lastDone ? 'now' : ''}${m.kind === 'parts' ? ' parts' : ''}${m.done ? '' : ' pending'}">
        ${esc(m.label)}
        <span class="when">${m.done ? esc(fmtDate(m.at)) : `expected ${esc(fmtDate(m.expected))}`}</span></li>`
    )
    .join('');
  return page(`Repair #${t.id}`, `
    <h1>Repair ticket #${esc(t.id)}</h1>
    <p class="sub">Last updated ${esc(fmtDate(t.updated_at))}</p>
    ${t.status === 'ready_for_pickup'
      ? `<div class="highlight">Your ${esc(t.model || 'device')} is fixed and waiting for you at the ${esc(config.helpdeskName)}.${
          (t.loaner_asset_tag || t.loaner_serial) && !t.loaner_returned_at
            ? ` Bring loaner ${esc(t.loaner_asset_tag || t.loaner_serial)} with you &mdash; we swap the two over.`
            : ''
        }</div>`
      : ''}
    <div class="card">
      ${statusBlock(t)}
      <dl class="kv">
        <dt>Device</dt><dd>${esc(t.model || 'Chromebook')}</dd>
        ${t.asset_tag ? `<dt>Asset tag</dt><dd>${esc(t.asset_tag)}</dd>` : ''}
        <dt>Reported issue</dt><dd>${esc(t.issue_description)}</dd>
        <dt>Opened</dt><dd>${esc(fmtDate(t.created_at))}</dd>
      </dl>
      ${partsNote(t)}
    </div>
    ${loanerCard(t)}
    <div class="card"><h2>Progress</h2><ol class="steps">${steps}</ol></div>
    ${(t.parts_milestones || []).some((m) => m.done)
      ? `<div class="card">
          <h2>Parts for this repair</h2>
          <p class="sub" style="margin:0 0 10px">${esc(t.parts_expectation || '')}</p>
          <ol class="steps">${(t.parts_milestones || [])
            .map((m) => `<li class="${m.current && m.done ? 'now' : ''}${m.done ? '' : ' pending'}">${esc(m.label)}
              <span class="when">${m.done
                ? esc(fmtDate(m.at))
                : m.expected
                ? `expected ${esc(fmtDate(m.expected))}`
                : m.skipped ? '' : 'not yet'}</span></li>`)
            .join('')}</ol>
        </div>`
      : ''}
    <div class="card">
      <h2>Emails about this repair</h2>
      <p class="sub" style="margin:0 0 12px">You can choose which updates we email you, or stop them entirely.
        Confirm your email address to continue - this link may have been forwarded.</p>
      <a href="/u/confirm/${esc(links.mint('t', t.id))}"><button class="ghost">Email preferences</button></a>
    </div>`);
}

function prefsPage(t, statuses, unsubscribed, message) {
  // Every status is offered (so a save can never silently drop one) and the boxes
  // stay enabled while unsubscribed, so unticking "stop all" restores a real list.
  const shown = unsubscribed && !statuses.length ? subscriptions.defaultStatuses() : statuses;
  const boxes = STATUSES.map(
    (s) => `<label class="check"><input type="checkbox" name="status" value="${esc(s.key)}"
      ${shown.includes(s.key) ? 'checked' : ''}>
      <span><b>${esc(s.label)}</b> &mdash; ${esc(EXPLAIN[s.key] || '')}</span></label>`
  ).join('');
  return page('Email preferences', `
    <h1>Email preferences</h1>
    <p class="sub">Repair ticket #${esc(t.id)} &middot; ${esc(t.user_email)}</p>
    ${message ? `<div class="ok">${esc(message)}</div>` : ''}
    <form method="post" action="/u/${esc(links.mint('u', t.id))}">
      <input type="hidden" name="statuses_present" value="1">
      <div class="card">
        <h2>Email me when this repair reaches:</h2>
        ${boxes}
        ${unsubscribed ? '<p class="note">All repair email to this address is currently stopped. Untick the box below and save to start again.</p>' : ''}
      </div>
      <div class="card">
        <label class="check"><input type="checkbox" name="unsubscribe_all" value="1" ${unsubscribed ? 'checked' : ''}>
          <span><b>Stop all repair emails to ${esc(t.user_email)}</b> &mdash; including future repairs. You can still
          check status on this site any time.</span></label>
      </div>
      <button type="submit">Save preferences</button>
      <a href="/t/${esc(links.mint('t', t.id))}" style="margin-left:12px">Back to repair status</a>
    </form>`);
}

function confirmPage(token, error) {
  return page('Confirm your email', `
    <h1>Confirm your email address</h1>
    <p class="sub">So that a forwarded link cannot change someone else's settings, type the address the
      repair emails go to.</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    <form method="post" action="/u/confirm/${esc(token)}">
      <div class="card">
        <label>Email address<input type="email" name="email" required autocomplete="email"></label>
        <button type="submit">Continue</button>
      </div>
    </form>`);
}

function notFoundPage(what = 'That link is not valid any more.') {
  return page('Not found', `<h1>We could not find that</h1><p class="sub">${esc(what)}</p>
    <div class="card"><p style="margin:0">Check the most recent email we sent you, or
    <a href="/">look up your device</a>.</p></div>`);
}

function homePage({ error, signedInAs, tickets, showLookup = false } = {}) {
  const signedIn = Boolean(signedInAs);
  const hasTickets = Boolean(tickets && tickets.length);

  const signIn = !signedIn && publicAuth.available()
    ? `<div class="card">
        <h2>Sign in with your school account</h2>
        <p class="sub" style="margin:0 0 12px">See every repair filed for your account.</p>
        <a href="/auth/google"><button type="button">Sign in with Google</button></a>
      </div>`
    : '';

  // The lookup form is for people who are not signed in - or who are, but have
  // nothing on their own account and are chasing a device filed under someone
  // else's name (a classroom cart, a sibling, a staff loaner).
  const lookup = config.publicSite.allowLookup && (!signedIn || showLookup)
    ? `<div class="card" id="lookup">
        <h2>Look up a repair</h2>
        <form method="post" action="/lookup">
          <label>Asset tag or serial number<input type="text" name="tag" required autocomplete="off"></label>
          <label>The email address on the ticket<input type="email" name="email" required autocomplete="email"
            value="${esc(signedIn ? signedInAs : '')}"></label>
          <button type="submit">Check status</button>
        </form>
        <p class="sub" style="margin:14px 0 0">Both have to match what is on the ticket.</p>
      </div>`
    : '';

  const list = hasTickets
    ? `<div class="card"><h2>Your repairs</h2>${tickets
        .map(
          (t) => `<a class="ticket-row" href="/t/${esc(links.mint('t', t.id))}">
            <span class="pill" style="background:${esc(statusColor(t.status))}">${esc(statusLabel(t.status))}</span>
            <b style="margin-left:8px">#${esc(t.id)}</b>
            <div class="sub" style="margin:6px 0 0">${esc(t.model || 'Device')}${t.asset_tag ? ` &middot; ${esc(t.asset_tag)}` : ''}
              &middot; ${esc((t.issue_description || '').slice(0, 70))}</div></a>`
        )
        .join('')}</div>`
    : '';

  // Signed in with nothing to show: say what to do next rather than leaving a
  // blank page that looks broken.
  const empty = signedIn && !hasTickets
    ? `<div class="card">
        <h2>No repairs on your account</h2>
        <p class="sub" style="margin:0 0 12px">Nothing has been filed for ${esc(signedInAs)}.</p>
        <p style="margin:0 0 12px">If you have handed a device in, check your email &mdash; every update we send
          contains a link straight to that repair, and it works even if the ticket was filed under a different
          address.</p>
        <p style="margin:0 0 14px">Otherwise, look it up with the asset tag from the sticker on the device.</p>
        ${config.publicSite.allowLookup && !showLookup
          ? '<a href="/?lookup=1#lookup"><button type="button">Look up a repair</button></a>'
          : ''}
      </div>`
    : '';

  const help = !signedIn
    ? `<div class="card"><p class="note" style="margin:0">The quickest way in is the link at the bottom of any
        repair email we send you &mdash; it opens your ticket directly.</p></div>`
    : '';

  return page(`${config.orgName} device repairs`, `
    <h1>Device repair status</h1>
    <p class="sub">${esc(config.orgName)} ${esc(config.helpdeskName)}</p>
    ${error ? `<div class="err">${esc(error)}</div>` : ''}
    ${signedIn ? `<p class="sub">Signed in as ${esc(signedInAs)} &middot; <a href="/signout">sign out</a></p>` : ''}
    ${list}${empty}${signIn}${lookup}${help}`,
    {});
}

// ---------------------------------------------------------------- data access
const publicTicket = (row) => ({
  id: row.id,
  status: row.status,
  model: row.model,
  asset_tag: row.asset_tag,
  issue_description: row.issue_description,
  created_at: row.created_at,
  updated_at: row.updated_at,
  loaner_serial: row.loaner_serial,
  parts_expectation: require('./shipments').expectationForTicket(row.id),
  parts_milestones: require('./shipments').milestonesForTicket(row.id),
  loaner_asset_tag: row.loaner_asset_tag,
  loaner_model: row.loaner_model,
  loaner_issued_at: row.loaner_issued_at,
  loaner_returned_at: row.loaner_returned_at,
  loaner_due: require('./loaners').dueInfo(row),
  user_email: row.user_email,
});

function loadTicket(id) {
  const row = getDb().prepare('SELECT * FROM tickets WHERE id = ?').get(id);
  return row || null;
}

/** Status history only - internal notes never leave the tech app. */
function statusHistory(ticket) {
  const events = getDb()
    .prepare(`SELECT to_status, created_at FROM ticket_events
              WHERE ticket_id = ? AND type IN ('created','status') AND to_status IS NOT NULL ORDER BY id ASC`)
    .all(ticket.id);
  if (!events.length) return [{ status: ticket.status, at: ticket.updated_at }];
  return events.map((e) => ({ status: e.to_status, at: e.created_at }));
}

function ticketsForEmail(email) {
  return getDb()
    .prepare(`SELECT * FROM tickets WHERE LOWER(COALESCE(user_email,'')) = ? ORDER BY id DESC LIMIT 25`)
    .all(String(email).trim().toLowerCase())
    .map(publicTicket);
}

function findByTagAndEmail(tag, email) {
  const t = String(tag || '').trim().toLowerCase();
  const e = String(email || '').trim().toLowerCase();
  if (!t || !e) return [];
  return getDb()
    .prepare(`SELECT * FROM tickets
              WHERE LOWER(COALESCE(user_email,'')) = @e
                AND (LOWER(COALESCE(asset_tag,'')) = @t OR LOWER(COALESCE(serial,'')) = @t)
              ORDER BY id DESC LIMIT 25`)
    .all({ t, e })
    .map(publicTicket);
}

// ---------------------------------------------------------------- rate limiting
const buckets = new Map();
const MAX_BUCKETS = 20000; // hard cap: a flood of spoofed sources cannot grow memory

/**
 * Per-source throttle. The client key is the real socket address unless
 * PUBLIC_TRUST_PROXY is on, because X-Forwarded-For is attacker-controlled when
 * this port is exposed directly - otherwise rotating one header defeats the limit.
 */
function clientKey(req) {
  if (config.publicSite.trustProxy) return req.ip || 'unknown';
  return (req.socket && (req.socket.remoteAddress || req.socket.localAddress)) || 'unknown';
}

function rateLimit({ max = 10, windowMs = 10 * 60 * 1000, name = 'default' } = {}) {
  return (req, res, next) => {
    // Buckets are per route family: somebody guessing asset tags should not also
    // lock themselves out of their own preferences page.
    const key = `${name}|${clientKey(req)}`;
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt < now) {
      if (buckets.size >= MAX_BUCKETS) {
        // Under a spoofing flood, stop tracking new sources and throttle globally
        // rather than growing without bound.
        for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
        if (buckets.size >= MAX_BUCKETS) {
          res.status(429).send(page('Busy', '<h1>Too busy right now</h1><p class="sub">Try again in a few minutes.</p>'));
          return;
        }
      }
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    b.count += 1;
    if (b.count > max) {
      res.status(429).send(page('Too many tries', `<h1>Too many attempts</h1>
        <p class="sub">Wait a few minutes and try again, or use the link in your repair email.</p>`));
      return;
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
}, 60 * 1000).unref?.();

// ---------------------------------------------------------------- public session
const PUBLIC_COOKIE = 'repairs_user';
const PUBLIC_TTL_MS = 12 * 60 * 60 * 1000;

const sign = (payload) => crypto.createHmac('sha256', links.secret()).update(payload).digest('base64url');

function issuePublicSession(res, email) {
  const payload = `${email}|${Date.now()}`;
  res.cookie(PUBLIC_COOKIE, `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: PUBLIC_TTL_MS,
    secure: (config.publicSite.url || '').startsWith('https://'),
  });
}

function publicSessionEmail(req) {
  const raw = req.cookies && req.cookies[PUBLIC_COOKIE];
  // cookie-parser turns a "j:{...}" value into an object; never assume a string.
  if (typeof raw !== 'string' || !raw.includes('.')) return null;
  const [b64, mac] = raw.split('.');
  let payload;
  try { payload = Buffer.from(b64, 'base64url').toString('utf8'); } catch { return null; }
  const expected = sign(payload);
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  const [email, ts] = payload.split('|');
  if (Date.now() - Number(ts || 0) > PUBLIC_TTL_MS) return null;
  return email || null;
}

async function verifyGoogleCredential(credential) {
  const { OAuth2Client } = require('google-auth-library');
  const clientId = config.publicSite.googleClientId;
  const client = new OAuth2Client(clientId);
  const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
  const payload = ticket.getPayload();
  if (!payload || !payload.email || !payload.email_verified) throw new Error('Google did not confirm that email address');
  const email = String(payload.email).toLowerCase();
  const domains = config.publicSite.allowedDomains;
  if (domains.length) {
    const domain = email.split('@')[1];
    const hd = String(payload.hd || '').toLowerCase();
    if (!domains.includes(domain) && !domains.includes(hd)) throw new Error('That account is not part of this organization');
  }
  return email;
}

// ---------------------------------------------------------------- app
function createPublicApp() {
  const app = express();
  app.set('trust proxy', config.publicSite.trustProxy);
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json({ limit: '32kb' }));
  app.use(cookieParser());

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "img-src 'self' data:",
        "script-src https://accounts.google.com",
        "connect-src https://accounts.google.com",
        "frame-src https://accounts.google.com",
        "form-action 'self'",
        `frame-ancestors ${config.publicSite.frameAncestors}`,
      ].join('; ')
    );
    next();
  });

  app.get('/healthz', (req, res) => res.json({ ok: true, site: 'public' }));

  // The one static file this site serves. Everything else is rendered HTML, and
  // keeping it that way is what makes the public port safe to expose.
  app.get('/logo.png', (req, res) => {
    const file = path.join(__dirname, '..', 'public', 'icons', 'eagle-header.png');
    res.sendFile(file, { maxAge: '7d', headers: { 'Cache-Control': 'public, max-age=604800' } }, (err) => {
      if (err) res.status(404).end();
    });
  });

  app.get('/', (req, res) => {
    const email = publicSessionEmail(req);
    const showLookup = String(req.query.lookup || '') === '1';
    res.send(homePage(email ? { signedInAs: email, tickets: ticketsForEmail(email), showLookup } : {}));
  });

  // magic link -> status
  app.get('/t/:token', (req, res) => {
    const id = links.verify('t', req.params.token);
    if (!id) return res.status(404).send(notFoundPage());
    const row = loadTicket(id);
    if (!row) return res.status(404).send(notFoundPage('That repair ticket no longer exists.'));
    res.send(ticketPage(publicTicket(row), statusHistory(row)));
  });

  // magic link -> email preferences
  app.get('/u/:token', (req, res) => {
    const id = links.verify('u', req.params.token);
    if (!id) return res.status(404).send(notFoundPage());
    const row = loadTicket(id);
    if (!row) return res.status(404).send(notFoundPage('That repair ticket no longer exists.'));
    res.send(prefsPage(publicTicket(row), subscriptions.parse(row), subscriptions.isOptedOut(row.user_email), req.query.saved ? 'Saved. Thank you.' : ''));
  });

  // Prove you own the address before a forwarded status link can change settings.
  app.get('/u/confirm/:token', rateLimit({ max: 30, name: 'confirm' }), (req, res) => {
    const id = links.verify('t', req.params.token);
    if (!id || !loadTicket(id)) return res.status(404).send(notFoundPage());
    res.send(confirmPage(req.params.token));
  });

  app.post('/u/confirm/:token', rateLimit({ max: 12, name: 'confirm' }), (req, res) => {
    const id = links.verify('t', req.params.token);
    if (!id) return res.status(404).send(notFoundPage());
    const row = loadTicket(id);
    if (!row) return res.status(404).send(notFoundPage());
    const given = String((req.body && req.body.email) || '').trim().toLowerCase();
    const actual = String(row.user_email || '').trim().toLowerCase();
    if (!actual || given !== actual) {
      return res.status(403).send(confirmPage(req.params.token, 'That does not match the address on this ticket.'));
    }
    res.redirect(`/u/${links.mint('u', id)}`);
  });

  app.post('/u/:token', rateLimit({ max: 30, name: 'prefs' }), (req, res) => {
    const id = links.verify('u', req.params.token);
    if (!id) return res.status(404).send(notFoundPage());
    const row = loadTicket(id);
    if (!row) return res.status(404).send(notFoundPage('That repair ticket no longer exists.'));

    const unsubscribeAll = Boolean(req.body.unsubscribe_all);
    if (unsubscribeAll) {
      subscriptions.optOut(row.user_email, 'user');
    } else {
      subscriptions.optIn(row.user_email);
      // Browsers send repeated status=... fields; be lenient about a comma list too.
      const picked = []
        .concat(req.body.status || [])
        .flatMap((v) => String(v).split(','))
        .map((v) => v.trim())
        .filter(Boolean);
      // An empty selection is only honoured when the form actually offered the
      // checkboxes; otherwise (a bare unsubscribe form, a stripped POST) fall
      // back to the defaults instead of silencing the ticket by accident.
      const offered = Object.prototype.hasOwnProperty.call(req.body, 'statuses_present');
      subscriptions.save(id, offered ? picked : subscriptions.defaultStatuses());
    }
    getDb()
      .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, 'user', ?)`)
      .run(id, unsubscribeAll ? `unsubscribed ${row.user_email} from all repair emails` : `updated their own email preferences`, new Date().toISOString());
    res.redirect(`/u/${links.mint('u', id)}?saved=1`);
  });

  // one-click unsubscribe (RFC 8058) from the mail client's own button
  app.post('/u/:token/one-click', (req, res) => {
    const id = links.verify('u', req.params.token);
    if (!id) return res.status(404).json({ error: 'invalid' });
    const row = loadTicket(id);
    if (row) {
      subscriptions.optOut(row.user_email, 'one-click');
      getDb()
        .prepare(`INSERT INTO ticket_events (ticket_id, type, body, author, created_at) VALUES (?, 'field', ?, 'user', ?)`)
        .run(id, `one-click unsubscribed ${row.user_email}`, new Date().toISOString());
    }
    res.json({ ok: true });
  });

  // asset tag + email lookup
  app.post('/lookup', rateLimit({ max: 12, name: 'lookup' }), (req, res) => {
    if (!config.publicSite.allowLookup) return res.status(404).send(notFoundPage('Lookup is turned off.'));
    const { tag, email } = req.body || {};
    const tickets = findByTagAndEmail(tag, email);
    if (!tickets.length) {
      const signedInAs = publicSessionEmail(req);
      return res.status(404).send(homePage({
        error: 'No repair found for that asset tag and email address together. Check both, or use the link in your repair email.',
        signedInAs,
        tickets: signedInAs ? ticketsForEmail(signedInAs) : null,
        showLookup: true,
      }));
    }
    if (tickets.length === 1) return res.redirect(`/t/${links.mint('t', tickets[0].id)}`);
    res.send(homePage({ tickets, signedInAs: String(email).toLowerCase() }));
  });

  // Student sign-in: send them to Google...
  app.get('/auth/google', rateLimit({ max: 30, name: 'signin' }), (req, res) => {
    if (!publicAuth.available()) {
      return res.status(503).send(homePage({ error: `Google sign-in is not set up: ${publicAuth.why()}.` }));
    }
    const state = publicAuth.issueState(res, '/');
    res.redirect(publicAuth.authUrl(state));
  });

  // ...and take them back afterwards.
  app.get(publicAuth.CALLBACK_PATH, rateLimit({ max: 30, name: 'signin' }), async (req, res) => {
    const { code, state, error } = req.query;
    const expected = publicAuth.readState(req, state === undefined ? '' : String(state));
    publicAuth.clearState(res);

    if (error) {
      return res.status(400).send(homePage({ error: 'Sign-in was cancelled.' }));
    }
    if (!expected) {
      return res.status(400).send(homePage({ error: 'That sign-in attempt expired. Try again from this page.' }));
    }
    if (!code) {
      return res.status(400).send(homePage({ error: 'Google did not return a sign-in code. Try again.' }));
    }

    try {
      const identity = await publicAuth.exchangeCode(String(code));
      if (!publicAuth.domainAllowed(identity)) {
        return res.status(403).send(homePage({ error: 'That account is not part of this organization.' }));
      }
      issuePublicSession(res, identity.email);
      res.redirect(expected.returnTo || '/');
    } catch (err) {
      // Never echo Google/library detail onto a public page.
      console.error('[public site] student sign-in failed:', err.message);
      res.status(401).send(homePage({ error: 'We could not complete that sign-in. Try again, or use the link in your repair email.' }));
    }
  });

  // Legacy: the GIS button posts here when the site is served over https.
  // Google sign-in (Google Identity Services posts here)
  app.post('/signin', rateLimit({ max: 20, name: 'signin' }), async (req, res) => {
    const { credential, g_csrf_token: bodyToken } = req.body || {};
    const cookieToken = req.cookies && req.cookies.g_csrf_token;
    if (!credential) return res.status(400).send(homePage({ error: 'Google sign-in did not complete. Try again.' }));
    // Google Identity Services always double-submits this token; a missing one
    // means the POST did not come from a real sign-in, so require both.
    if (typeof cookieToken !== 'string' || typeof bodyToken !== 'string' || cookieToken !== bodyToken) {
      return res.status(400).send(homePage({ error: 'Sign-in could not be verified. Try again from this page.' }));
    }
    if (!config.publicSite.allowedDomains.length) {
      console.error('[public site] sign-in refused: PUBLIC_ALLOWED_DOMAINS is empty');
      return res.status(403).send(homePage({ error: 'Google sign-in is not configured. Use the link in your repair email.' }));
    }
    try {
      const email = await verifyGoogleCredential(credential);
      issuePublicSession(res, email);
      res.redirect('/');
    } catch (err) {
      // Never echo library/network detail to the public page.
      console.error('[public site] sign-in rejected:', err.message);
      const known = /not part of this organization|confirm that email/i.test(err.message || '');
      res.status(401).send(homePage({ error: known ? err.message : 'Could not verify that Google account. Try again.' }));
    }
  });

  app.get('/signout', (req, res) => {
    res.clearCookie(PUBLIC_COOKIE);
    res.redirect('/');
  });

  app.use((req, res) => res.status(404).send(notFoundPage('That page does not exist.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[public site error]', req.method, req.originalUrl, err.message);
    res.status(500).send(page('Something went wrong', `<h1>Something went wrong</h1>
      <p class="sub">Try again in a moment, or email the ${esc(config.helpdeskName)}.</p>`));
  });

  return app;
}

module.exports = { createPublicApp, findByTagAndEmail, ticketsForEmail, statusHistory, verifyGoogleCredential };
