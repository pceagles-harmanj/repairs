'use strict';
/* Repair Tickets frontend. No framework, no build step: plain DOM + fetch.
   Rendering style: build an HTML string with esc() around every value, drop it
   into a container, then wire listeners by id. Easy to read, easy to edit. */

const state = {
  meta: null,
  statusFilter: 'open',
  search: '',
  tickets: [],
  view: 'tickets',
  openTicketId: null,
  templates: [],
  activeTemplate: 'new',
  loanerFilter: 'out',
  loanerData: null,
  invTab: 'onhand',
  invSearch: '',
  invData: null,
  shipData: null,
};

// ---------------------------------------------------------------- utilities
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const esc = (v) =>
  v === null || v === undefined
    ? ''
    : String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(message, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' err' : '');
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 3000);
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('Signed out'); }
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const statusMeta = (key) =>
  (state.meta && state.meta.statuses.find((s) => s.key === key)) || { key, label: key, color: '#64748b' };

const statusPill = (key) => {
  const s = statusMeta(key);
  return `<span class="pill" style="background:${esc(s.color)}">${esc(s.label)}</span>`;
};

function relTime(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return String(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

const fullTime = (iso) => (iso ? new Date(iso).toLocaleString() : '');

const deviceLine = (t) =>
  [t.asset_tag ? `Asset ${esc(t.asset_tag)}` : null, esc(t.serial), esc(t.model)]
    .filter(Boolean)
    .join(' &middot; ') || 'No device';

// ---------------------------------------------------------------- barcode input
/**
 * Two ways to get an asset tag into a field:
 *
 *  - a handheld scanner, which is just a keyboard: it types the code and sends
 *    Enter. We clean the value (scanners add stray control characters and
 *    whitespace) and treat Enter as "search now".
 *  - the camera, via the browser's built-in BarcodeDetector. No library, no
 *    upload: frames never leave the machine.
 */
const cleanScan = (v) =>
  String(v == null ? '' : v)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const cameraScanSupported = () =>
  typeof window.BarcodeDetector === 'function' && Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);

/** Wire an input for scanner use: clean on input, Enter fires onScan. */
function attachScanner(input, onScan) {
  if (!input) return;
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const value = cleanScan(input.value);
    input.value = value;
    if (value) onScan(value);
  });
  input.addEventListener('paste', () => setTimeout(() => { input.value = cleanScan(input.value); }, 0));
}

/** Put a camera button next to an existing input, without touching the markup. */
function addScanButton(input, onResult) {
  if (!input || !cameraScanSupported() || input.dataset.scanReady) return;
  input.dataset.scanReady = '1';
  const wrap = document.createElement('div');
  wrap.className = 'scan-wrap';
  input.parentNode.insertBefore(wrap, input);
  wrap.appendChild(input);
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'btn scan';
  btn.innerHTML = '&#9635;';
  btn.title = 'Scan a barcode with the camera';
  btn.setAttribute('aria-label', 'Scan a barcode with the camera');
  btn.addEventListener('click', () => openCameraScanner((value) => {
    input.value = value;
    onResult(value);
  }));
  wrap.appendChild(btn);
}

const scanButtonHtml = (id, title = 'Scan a barcode with the camera') =>
  `<button type="button" class="btn scan" id="${id}" title="${esc(title)}" aria-label="${esc(title)}">&#9635;</button>`;

/** Camera scanner in a modal. Resolves through onResult with the decoded text. */
async function openCameraScanner(onResult) {
  if (!cameraScanSupported()) {
    toast('This browser has no built-in barcode scanner - use a handheld scanner or type the tag', true);
    return;
  }
  const panel = subOverlay(`<div class="modal" style="width:min(520px,calc(100% - 32px))">
    <header><h2>Scan an asset tag</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="scan-close">Cancel</button></header>
    <div class="body">
      <div class="scanner-box"><video id="scan-video" playsinline muted></video><div class="reticle"></div></div>
      <div class="scan-hint" id="scan-hint">Point the camera at the barcode on the device.</div>
    </div></div>`);

  let stream = null;
  let stop = false;
  const close = () => {
    stop = true;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    panel.close();
  };
  $('[data-x=scan-close]', panel.node).addEventListener('click', close);

  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
  } catch (err) {
    $('#scan-hint', panel.node).innerHTML = `<span style="color:var(--danger)">Could not open the camera: ${esc(err.message)}</span>`;
    return;
  }

  const video = $('#scan-video', panel.node);
  video.srcObject = stream;
  await video.play().catch(() => {});

  const detector = new window.BarcodeDetector({
    formats: ['code_128', 'code_39', 'codabar', 'ean_13', 'ean_8', 'itf', 'upc_a', 'upc_e', 'qr_code', 'data_matrix'],
  });

  const tick = async () => {
    if (stop) return;
    try {
      const found = await detector.detect(video);
      if (found && found.length) {
        const value = cleanScan(found[0].rawValue);
        if (value) {
          if (navigator.vibrate) navigator.vibrate(60);
          close();
          onResult(value);
          return;
        }
      }
    } catch { /* a frame that will not decode is normal */ }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ---------------------------------------------------------------- overlays
function closeOverlays() {
  $('#overlays').innerHTML = '';
  state.openTicketId = null;
}

/**
 * A modal stacked ON TOP of whatever is already open (the ticket drawer, usually).
 * overlay() replaces the contents of #overlays, which would unmount the drawer and
 * detach the very input a scan is meant to fill; this one appends instead.
 */
function subOverlay(html) {
  const node = document.createElement('div');
  node.className = 'sub-overlay';
  node.innerHTML = `<div class="scrim" data-subclose="1"></div>${html}`;
  $('#overlays').appendChild(node);
  const close = () => node.remove();
  node.querySelector('[data-subclose]').addEventListener('click', close);
  return { node, close };
}

function overlay(html, { wide = false } = {}) {
  const box = $('#overlays');
  box.innerHTML = `<div class="scrim" data-close="1"></div>${html}`;
  box.querySelector('[data-close]').addEventListener('click', closeOverlays);
  return box;
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOverlays(); });

// ---------------------------------------------------------------- boot
async function boot() {
  const session = await (await fetch('/api/session')).json();
  if (session.password_required && !session.signed_in) return showLogin();
  $('#login').hidden = true;
  $('#app').hidden = false;
  $('#logout-btn').hidden = !session.password_required;

  state.meta = await api('/meta');
  applyBrand(state.meta.brand);
  $('#dry-run-badge').hidden = !state.meta.dry_run_email;
  renderGoogleState(state.meta.google);
  renderStatusChips();
  await Promise.all([loadTickets(), loadStats()]);
  wireChrome();
}

/** Paint the UI in whatever BRAND_* colours the server is configured with. */
function applyBrand(brand) {
  if (!brand) return;
  const root = document.documentElement.style;
  if (brand.primary) root.setProperty('--brand', brand.primary);
  if (brand.primaryDark) root.setProperty('--brand-dark', brand.primaryDark);
  if (brand.accent) root.setProperty('--brand-accent', brand.accent);
}

function showLogin() {
  $('#app').hidden = true;
  $('#login').hidden = false;
  $('#login-form').onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await api('/session/login', { method: 'POST', body: { password: $('#login-password').value, name: $('#login-name').value } });
      location.reload();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
}

function wireChrome() {
  $$('nav.tabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));
  $('#new-ticket-btn').addEventListener('click', openNewTicket);
  $('#refresh-tickets').addEventListener('click', () => { loadTickets(); loadStats(); });
  $('#logout-btn').addEventListener('click', async () => {
    await api('/session/logout', { method: 'POST' });
    location.reload();
  });

  let timer;
  $('#ticket-search').addEventListener('input', (e) => {
    clearTimeout(timer);
    state.search = e.target.value;
    timer = setTimeout(loadTickets, 220);
  });

  $('#device-search-btn').addEventListener('click', () => searchDevicesView($('#device-search').value));
  attachScanner($('#device-search'), (value) => searchDevicesView(value));
  addScanButton($('#device-search'), (value) => searchDevicesView(value));
  $('#device-recent-btn').addEventListener('click', loadRecentDevices);
  $('#refresh-emails').addEventListener('click', loadEmailLog);
  $('#loaner-refresh').addEventListener('click', () => loadLoaners(true));
  $('#inv-refresh').addEventListener('click', () => loadInventoryView(true));
  $('#inv-add').addEventListener('click', () => (state.invTab === 'incoming' ? openShipmentForm() : openItemForm()));
  let invTimer;
  $('#inv-search').addEventListener('input', (e) => {
    clearTimeout(invTimer);
    state.invSearch = e.target.value;
    invTimer = setTimeout(() => loadInventoryView(true), 220);
  });
  attachScanner($('#inv-search'), () => loadInventoryView(true));
  addScanButton($('#inv-search'), () => loadInventoryView(true));
  registerServiceWorker();
}

function showView(name) {
  state.view = name;
  $$('nav.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
  if (name === 'settings') loadSettings();
  if (name === 'loaners') loadLoaners();
  if (name === 'inventory') loadInventoryView();
  if (name === 'devices' && !$('#device-hits').children.length) $('#devices-empty').hidden = false;
}

function renderGoogleState(g) {
  const el = $('#gstate');
  el.classList.toggle('connected', Boolean(g && g.connected));
  const txt = !g || !g.configured ? 'Google not configured' : g.connected ? `Google: ${g.email || 'connected'}` : 'Google not connected';
  $('.txt', el).textContent = txt;
  el.style.cursor = 'pointer';
  el.onclick = () => showView('settings');
}

// ---------------------------------------------------------------- ticket list
function renderStatusChips() {
  const chips = [{ key: 'open', label: 'Open' }, ...state.meta.statuses, { key: 'all', label: 'All' }];
  $('#status-chips').innerHTML = chips
    .map((c) => `<button class="chip${state.statusFilter === c.key ? ' active' : ''}" data-status="${esc(c.key)}">${esc(c.label)}</button>`)
    .join('');
  $$('#status-chips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.statusFilter = b.dataset.status;
      renderStatusChips();
      loadTickets();
    })
  );
}

async function loadStats() {
  const s = await api('/stats');
  const cards = [
    ['Open', s.open],
    ['New', s.by_status.new || 0],
    ['Waiting on parts', s.by_status.waiting_on_parts || 0],
    ['Ready for pickup', s.by_status.ready_for_pickup || 0],
    ['Opened this week', s.created_last_7_days],
    ['Closed this week', s.closed_last_7_days],
    ['Avg days to close', s.avg_days_to_close == null ? '-' : s.avg_days_to_close],
  ];
  $('#stats').innerHTML = cards.map(([label, n]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(label)}</span></div>`).join('');
}

async function loadTickets() {
  const params = new URLSearchParams({ status: state.statusFilter, limit: '250' });
  if (state.search.trim()) params.set('q', state.search.trim());
  const { tickets } = await api('/tickets?' + params);
  state.tickets = tickets;
  $('#tickets-empty').hidden = tickets.length > 0;
  $('#ticket-rows').innerHTML = tickets
    .map(
      (t) => `<tr class="clickable" data-id="${t.id}">
        <td class="mono"><b>#${t.id}</b></td>
        <td data-label="Device">${deviceLine(t)}</td>
        <td data-label="User">${esc(t.user_name || t.user_email || '-')}${t.user_name && t.user_email ? `<div class="small muted">${esc(t.user_email)}</div>` : ''}</td>
        <td data-label="Issue">${esc(t.issue_category ? t.issue_category + ' - ' : '')}${esc((t.issue_description || '').slice(0, 90))}${(t.issue_description || '').length > 90 ? '&hellip;' : ''}</td>
        <td>${statusPill(t.status)}${t.priority !== 'normal' ? `<div class="pri ${esc(t.priority)}">${esc(t.priority)}</div>` : ''}</td>
        <td data-label="Assigned">${esc(t.assigned_to || '-')}</td>
        <td class="small muted" data-label="Updated" title="${esc(fullTime(t.updated_at))}">${esc(relTime(t.updated_at))}</td>
      </tr>`
    )
    .join('');
  $$('#ticket-rows tr').forEach((tr) => tr.addEventListener('click', () => openTicket(Number(tr.dataset.id))));
}

// ---------------------------------------------------------------- ticket drawer
async function ensureTemplates() {
  if (!state.templates.length) state.templates = (await api('/templates')).templates;
  return state.templates;
}
const templateFor = (key) => state.templates.find((t) => t.status_key === key) || null;

async function openTicket(id) {
  state.openTicketId = id;
  overlay(`<aside class="drawer"><header><h2>Ticket #${id}</h2><div class="spacer" style="flex:1"></div>
    <button class="btn ghost sm" data-x="close">Close</button></header>
    <div class="body"><span class="spinner"></span> Loading&hellip;</div></aside>`);
  $('[data-x=close]').addEventListener('click', closeOverlays);
  await ensureTemplates();
  const data = await api('/tickets/' + id);
  renderTicketDrawer(data.ticket, data.ticket_history);
}

async function refreshTicket() {
  if (!state.openTicketId) return;
  const data = await api('/tickets/' + state.openTicketId);
  renderTicketDrawer(data.ticket, data.ticket_history);
  loadTickets();
  loadStats();
}

function renderTicketDrawer(t, history) {
  const statusOptions = state.meta.statuses
    .map((s) => `<option value="${esc(s.key)}"${s.key === t.status ? ' selected' : ''}>${esc(s.label)}</option>`)
    .join('');
  const priorityOptions = state.meta.priorities
    .map((p) => `<option value="${esc(p.key)}"${p.key === t.priority ? ' selected' : ''}>${esc(p.label)}</option>`)
    .join('');
  const categoryOptions = ['', ...state.meta.categories]
    .map((c) => `<option value="${esc(c)}"${c === (t.issue_category || '') ? ' selected' : ''}>${esc(c || '- none -')}</option>`)
    .join('');

  const timeline = t.events
    .slice()
    .reverse()
    .map((e) => {
      const head =
        e.type === 'status'
          ? `Status ${esc(statusMeta(e.from_status).label)} &rarr; <b>${esc(statusMeta(e.to_status).label)}</b>`
          : e.type === 'created'
          ? 'Ticket created'
          : e.type === 'email'
          ? 'Email'
          : e.type === 'field'
          ? 'Edited'
          : 'Note';
      return `<li class="t-${esc(e.type)}">
        <div class="meta">${head} &middot; ${esc(e.author || 'system')} &middot; <span title="${esc(fullTime(e.created_at))}">${esc(relTime(e.created_at))}</span></div>
        ${e.body ? `<div class="body">${esc(e.body)}</div>` : ''}
      </li>`;
    })
    .join('');

  const emails = t.emails.length
    ? `<table><thead><tr><th>When</th><th>To</th><th>Subject</th><th>Result</th></tr></thead><tbody>${t.emails
        .map(
          (e) => `<tr class="clickable" data-email="${e.id}"><td class="small">${esc(relTime(e.created_at))}</td>
            <td class="small">${esc(e.to_email)}</td><td class="small">${esc(e.subject || '')}</td>
            <td class="small" style="color:${e.result === 'sent' ? 'var(--ok)' : e.result === 'error' ? 'var(--danger)' : 'var(--muted)'}">${esc(e.result)}${e.error ? ' &#9432;' : ''}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="small muted">No emails sent for this ticket yet.</p>';

  const historyHtml = history && history.length
    ? `<ul class="small" style="margin:6px 0 0;padding-left:18px">${history
        .map((h) => `<li><a href="#" data-goto="${h.id}">#${h.id}</a> ${esc(statusMeta(h.status).label)} &mdash; ${esc((h.issue_description || '').slice(0, 70))} <span class="muted">(${esc(relTime(h.created_at))})</span></li>`)
        .join('')}</ul>`
    : '<p class="small muted">No earlier tickets for this serial.</p>';

  // The per-change checkbox follows THIS ticket's subscription list, not the
  // global template defaults - the ticket is the source of truth now.
  const subscribedTo = (key) =>
    Boolean(t.notify_user) && !t.user_unsubscribed && (t.subscribed_statuses || []).includes(key);
  const autoChecked = subscribedTo(t.status);

  const html = `<aside class="drawer">
    <header>
      <h2>Ticket #${t.id}</h2>${statusPill(t.status)}
      <div style="flex:1"></div>
      <span class="small muted">${esc(relTime(t.updated_at))}</span>
      <button class="btn ghost sm" data-x="close">Close</button>
    </header>
    <div class="body">
      <div class="card">
        <h2>Update status</h2>
        <div class="row">
          <label class="field" style="flex:1 1 200px"><span>Status</span><select id="d-status">${statusOptions}</select></label>
          <label class="field" style="flex:2 1 260px"><span>Note for this update (internal, and included in the email only if you send one)</span>
            <textarea id="d-note" style="min-height:60px" placeholder="Ordered replacement panel, ETA Friday."></textarea></label>
        </div>
        <div id="d-close-extras" hidden>
          <label class="field" style="margin-bottom:8px">
            <span>Repair summary &mdash; written onto the device in Google Admin when you close</span>
            <textarea id="d-repair-summary" style="min-height:54px;font-family:inherit;font-size:14px"
              placeholder="Replaced LCD assembly and tested"></textarea>
          </label>
          <div class="small muted" id="d-repair-preview"></div>
        </div>
        <div class="row" style="align-items:center">
          <label class="check" style="flex:1 1 auto" title="${t.user_unsubscribed ? 'This address has unsubscribed from all repair emails' : 'Checked automatically when this ticket subscribes to the new status'}">
            <input type="checkbox" id="d-notify" ${autoChecked ? 'checked' : ''} ${t.user_unsubscribed ? 'disabled' : ''}>
            Email ${esc(t.user_email || 'the user')} about this change${t.user_unsubscribed ? ' (unsubscribed)' : ''}</label>
          <button class="btn primary" id="d-save-status" style="flex:0 0 auto">Save update</button>
        </div>
        <div id="d-status-result"></div>
      </div>

      <div class="card">
        <h2>Ticket details</h2>
        <div class="row">
          <label class="field"><span>Priority</span><select id="d-priority">${priorityOptions}</select></label>
          <label class="field"><span>Assigned to</span><input type="text" id="d-assigned" value="${esc(t.assigned_to || '')}"></label>
          <label class="field"><span>Category</span><select id="d-category">${categoryOptions}</select></label>
        </div>
        <div class="row">
          <label class="field"><span>User email</span><input type="email" id="d-user-email" value="${esc(t.user_email || '')}"></label>
          <label class="field"><span>User name</span><input type="text" id="d-user-name" value="${esc(t.user_name || '')}"></label>
          <label class="field"><span>Location</span><input type="text" id="d-location" value="${esc(t.location || '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Estimated cost</span><input type="number" step="0.01" id="d-cost" value="${t.estimated_cost == null ? '' : esc(t.estimated_cost)}"></label>
          <label class="field" style="flex:2 1 320px"><span>Issue</span><input type="text" id="d-issue" value="${esc(t.issue_description)}"></label>
        </div>
        <div class="row" style="align-items:center">
          <label class="check" style="flex:1 1 auto"><input type="checkbox" id="d-notify-user" ${t.notify_user ? 'checked' : ''}>
            Send this user automatic status emails</label>
          <button class="btn" id="d-save-fields" style="flex:0 0 auto">Save details</button>
          <button class="btn ghost sm danger" id="d-delete" style="flex:0 0 auto">Delete ticket</button>
        </div>
        <p class="small muted" style="margin-bottom:0">Created ${esc(fullTime(t.created_at))}${t.closed_at ? ` &middot; closed ${esc(fullTime(t.closed_at))}` : ''}</p>
      </div>

      <div class="card">
        <h2>Device <button class="btn ghost sm" id="d-device-refresh" style="float:right">Refresh from Google</button></h2>
        <div id="d-device"><span class="small muted">${t.device_id ? 'Loading device from Google&hellip;' : 'No Google device linked. Use the Devices tab to find it, then create a ticket from there.'}</span></div>
      </div>

      <div class="card">
        <h2>Email notifications for this ticket</h2>
        ${t.user_unsubscribed
          ? `<div class="result-line err">${esc(t.user_email || 'This address')} has unsubscribed from all repair emails.
             Nothing will be sent, on any ticket, until they opt back in.
             <button class="btn sm" id="d-resub" style="margin-left:8px">Resubscribe them</button></div>`
          : ''}
        <p class="small muted" style="margin-top:0">This ticket emails ${esc(t.user_email || 'the user')} when it reaches
          the statuses checked below. Seeded from your template defaults; the user can change it themselves from any email.</p>
        <div class="row" style="gap:4px 18px">
          ${state.meta.statuses.map((s) => `<label class="check" style="flex:1 1 190px">
            <input type="checkbox" class="d-sub" value="${esc(s.key)}" ${(t.subscribed_statuses || []).includes(s.key) ? 'checked' : ''}
              ${t.user_unsubscribed ? 'disabled' : ''}>
            ${esc(s.label)}</label>`).join('')}
        </div>
        <div class="row" style="align-items:center;margin-top:10px">
          <button class="btn ghost sm" id="d-sub-none" style="flex:0 0 auto">Uncheck all</button>
          <button class="btn ghost sm" id="d-sub-default" style="flex:0 0 auto">Use template defaults</button>
          <div style="flex:1"></div>
          <button class="btn primary" id="d-sub-save" style="flex:0 0 auto">Save notifications</button>
        </div>
        <div id="d-sub-result"></div>
        <div id="d-links" class="small muted" style="margin-top:12px"></div>
      </div>

      <div class="card">
        <h2>Loaner</h2>
        <div id="d-loaner-panel"></div>
      </div>

      <div class="card">
        <h2>Parts</h2>
        <div id="d-parts"></div>
      </div>

      <div class="card">
        <h2>Send an email</h2>
        <div class="row">
          <label class="field" style="flex:1 1 200px"><span>Template</span>
            <select id="d-tpl">${state.meta.statuses.map((s) => `<option value="${esc(s.key)}"${s.key === t.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select></label>
          <label class="field" style="flex:2 1 240px"><span>Note for this email</span><input type="text" id="d-email-note" placeholder="Optional line to include"></label>
        </div>
        <label class="field"><span>Subject</span><input type="text" id="d-email-subject"></label>
        <label class="field"><span>Body (HTML, placeholders allowed)</span><textarea id="d-email-body" style="min-height:120px"></textarea></label>
        <div class="row" style="align-items:center">
          <button class="btn sm" id="d-email-preview" style="flex:0 0 auto">Refresh preview</button>
          <div style="flex:1"></div>
          <button class="btn primary" id="d-email-send" style="flex:0 0 auto">Send to ${esc(t.user_email || 'user')}</button>
        </div>
        <div id="d-email-preview-box" style="margin-top:12px"></div>
        <div id="d-email-result"></div>
      </div>

      <div class="card">
        <h2>Add a note</h2>
        <textarea id="d-new-note" placeholder="Internal by default. Notes are never emailed unless you check the box below."></textarea>
        <div class="row" style="align-items:center;margin-top:10px">
          <label class="check" style="flex:1 1 auto"><input type="checkbox" id="d-note-email"> Email this note to the user</label>
          <button class="btn" id="d-add-note" style="flex:0 0 auto">Add note</button>
        </div>
      </div>

      <div class="card"><h2>History for this serial</h2>${historyHtml}</div>
      <div class="card"><h2>Emails on this ticket</h2>${emails}</div>
      <div class="card"><h2>Activity</h2><ul class="timeline">${timeline}</ul></div>
    </div>
  </aside>`;

  const box = $('#overlays');
  box.innerHTML = `<div class="scrim" data-close="1"></div>` + html;
  box.querySelector('[data-close]').addEventListener('click', closeOverlays);
  $('[data-x=close]').addEventListener('click', closeOverlays);
  wireTicketDrawer(t);
}

function wireTicketDrawer(t) {
  const busy = async (btn, fn) => {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Working…';
    try { await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = label; }
  };
  const resultLine = (el, res) => {
    const map = {
      sent: ['ok', `Email sent to ${res.to}`],
      dry_run: ['info', `Dry run: email logged (not sent) for ${res.to}`],
      error: ['err', `Email failed: ${res.error}`],
    };
    const reasons = {
      not_requested: 'No email sent - you left the box unchecked',
      status_not_subscribed: 'No email sent - this ticket does not subscribe to that status',
      ticket_notifications_off: 'No email sent - notifications are off for this ticket',
      user_unsubscribed: 'No email sent - this address unsubscribed from all repair emails',
      no_recipient: 'No email sent - this ticket has no user email address',
      no_template: 'No email sent - that status has no template',
      no_status_change: 'No email sent - the status did not change',
    };
    const [cls, msg] = map[res.result] || ['info', reasons[res.reason] || `No email sent (${res.reason || res.result})`];
    el.innerHTML = `<div class="result-line ${cls}">${esc(msg)}</div>`;
  };

  // Closing writes a line onto the device in Google Admin: offer the wording.
  const closeExtras = $('#d-close-extras');
  const syncCloseExtras = async () => {
    const closing = $('#d-status').value === 'closed';
    const canWrite = Boolean(t.device_id) && state.meta.repair_note_on_close;
    closeExtras.hidden = !(closing && canWrite);
    if (closeExtras.hidden || $('#d-repair-summary').value) return;
    try {
      const info = await api(`/tickets/${t.id}/repair-note`);
      $('#d-repair-summary').value = info.summary || '';
      $('#d-repair-preview').textContent = `Will append: ${info.preview}`;
    } catch { /* offering a suggestion is optional */ }
  };
  $('#d-repair-summary').addEventListener('input', () => {
    const text = $('#d-repair-summary').value.trim();
    $('#d-repair-preview').textContent = text ? `Will append: ${todayStamp()} Ticket #${t.id}: ${text}` : '';
  });

  // status update - the checkbox reflects whether THIS ticket wants that status
  const subscribedTo = (key) =>
    Boolean(t.notify_user) && !t.user_unsubscribed && (t.subscribed_statuses || []).includes(key);
  $('#d-status').addEventListener('change', (e) => {
    $('#d-notify').checked = subscribedTo(e.target.value);
    syncCloseExtras();
  });
  syncCloseExtras();
  $('#d-save-status').addEventListener('click', (e) =>
    busy(e.target, async () => {
      const closing = $('#d-status').value === 'closed';
      const res = await api('/tickets/' + t.id, {
        method: 'PATCH',
        body: {
          status: $('#d-status').value,
          note: $('#d-note').value.trim() || undefined,
          notify: $('#d-notify').checked,
          repair_summary: closing ? $('#d-repair-summary').value.trim() || undefined : undefined,
        },
      });
      resultLine($('#d-status-result'), res.email);
      if (res.repair_note) {
        const note = res.repair_note;
        const cls = note.result === 'ok' ? 'ok' : note.result === 'error' ? 'err' : 'info';
        const msg = note.result === 'ok'
          ? `Wrote to the device in Google Admin: ${note.line}`
          : note.result === 'error'
          ? `Could not write the repair note to Google: ${note.error}`
          : `No repair note written (${note.reason})`;
        $('#d-status-result').innerHTML += `<div class="result-line ${cls}">${esc(msg)}</div>`;
      }
      toast('Ticket updated');
      const keepHtml = $('#d-status-result').innerHTML;
      await refreshTicket();
      if (keepHtml && $('#d-status-result')) $('#d-status-result').innerHTML = keepHtml;
    })
  );

  // field edits
  $('#d-save-fields').addEventListener('click', (e) =>
    busy(e.target, async () => {
      await api('/tickets/' + t.id, {
        method: 'PATCH',
        body: {
          priority: $('#d-priority').value,
          assigned_to: $('#d-assigned').value,
          issue_category: $('#d-category').value,
          user_email: $('#d-user-email').value,
          user_name: $('#d-user-name').value,
          location: $('#d-location').value,
          estimated_cost: $('#d-cost').value,
          issue_description: $('#d-issue').value,
          notify_user: $('#d-notify-user').checked,
          notify: false,
        },
      });
      toast('Details saved');
      await refreshTicket();
    })
  );

  $('#d-delete').addEventListener('click', async () => {
    if (!window.confirm(`Delete ticket #${t.id}? This cannot be undone.`)) return;
    await api('/tickets/' + t.id, { method: 'DELETE' });
    closeOverlays();
    toast('Ticket deleted');
    loadTickets();
    loadStats();
  });

  // notes
  $('#d-add-note').addEventListener('click', (e) =>
    busy(e.target, async () => {
      const body = $('#d-new-note').value.trim();
      if (!body) return toast('Nothing to add', true);
      const res = await api(`/tickets/${t.id}/notes`, { method: 'POST', body: { body, notify: $('#d-note-email').checked } });
      toast(res.email && res.email.result === 'sent' ? 'Note added and emailed' : 'Note added');
      await refreshTicket();
    })
  );

  // email composer
  const loadPreview = async () => {
    const res = await api(`/tickets/${t.id}/email/preview`, {
      method: 'POST',
      body: { status: $('#d-tpl').value, note: $('#d-email-note').value || undefined },
    });
    $('#d-email-subject').value = res.preview.subject;
    $('#d-email-body').value = res.preview.body;
    $('#d-email-preview-box').innerHTML = `<div class="small muted" style="margin-bottom:6px">Preview</div><div class="preview-frame">${res.preview.body}</div>`;
  };
  $('#d-tpl').addEventListener('change', () => loadPreview().catch((e) => toast(e.message, true)));
  $('#d-email-preview').addEventListener('click', (e) =>
    busy(e.target, async () => {
      const res = await api(`/tickets/${t.id}/email/preview`, {
        method: 'POST',
        body: { status: $('#d-tpl').value, note: $('#d-email-note').value || undefined, subject: $('#d-email-subject').value, body: $('#d-email-body').value },
      });
      $('#d-email-preview-box').innerHTML = `<div class="small muted" style="margin-bottom:6px">Preview</div><div class="preview-frame">${res.preview.body}</div>`;
    })
  );
  $('#d-email-send').addEventListener('click', (e) =>
    busy(e.target, async () => {
      const res = await api(`/tickets/${t.id}/email/send`, {
        method: 'POST',
        body: { status: $('#d-tpl').value, note: $('#d-email-note').value || undefined, subject: $('#d-email-subject').value, body: $('#d-email-body').value },
      });
      resultLine($('#d-email-result'), res);
      if (res.result === 'sent' || res.result === 'dry_run') toast('Email queued');
    })
  );
  loadPreview().catch(() => {});

  // email log rows
  $$('[data-email]').forEach((tr) => tr.addEventListener('click', () => showEmail(tr.dataset.email)));
  $$('[data-goto]').forEach((a) =>
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openTicket(Number(a.dataset.goto));
    })
  );

  // per-ticket notification subscriptions
  const setBoxes = (keys) => $$('.d-sub').forEach((b) => { b.checked = keys.includes(b.value); });
  $('#d-sub-none').addEventListener('click', () => setBoxes([]));
  $('#d-sub-default').addEventListener('click', () => setBoxes(state.meta.default_notify_statuses || []));
  $('#d-sub-save').addEventListener('click', (e) =>
    busy(e.target, async () => {
      const picked = $$('.d-sub').filter((b) => b.checked).map((b) => b.value);
      await api('/tickets/' + t.id, { method: 'PATCH', body: { notify_statuses: picked, notify: false } });
      toast(picked.length ? `Emails on: ${picked.map((k) => statusMeta(k).label).join(', ')}` : 'Emails off for this ticket');
      await refreshTicket();
    })
  );
  if ($('#d-resub')) {
    $('#d-resub').addEventListener('click', (e) =>
      busy(e.target, async () => {
        await api('/optouts', { method: 'POST', body: { email: t.user_email, action: 'in' } });
        toast('Resubscribed');
        await refreshTicket();
      })
    );
  }

  // shareable links for the user (only if the public site is configured)
  if (state.meta.public_site && state.meta.public_site.url) {
    api('/tickets/' + t.id + '/links')
      .then(({ status_url, prefs_url }) => {
        const box = $('#d-links');
        if (!box || !status_url) return;
        box.innerHTML = `Links for the user:
          <a href="${esc(status_url)}" target="_blank" rel="noreferrer">status page</a>
          <button class="btn ghost sm" data-copy="${esc(status_url)}">copy</button>
          &middot; <a href="${esc(prefs_url)}" target="_blank" rel="noreferrer">email preferences</a>
          <button class="btn ghost sm" data-copy="${esc(prefs_url)}">copy</button>`;
        $$('[data-copy]', box).forEach((b) =>
          b.addEventListener('click', async () => {
            try { await navigator.clipboard.writeText(b.dataset.copy); toast('Link copied'); }
            catch { toast('Copy failed - select the link instead', true); }
          })
        );
      })
      .catch(() => {});
  }

  renderLoanerPanel(t);
  renderPartsPanel(t);

  // device panel
  $('#d-device-refresh').addEventListener('click', (e) => busy(e.target, () => loadDevicePanel(t, true)));
  if (t.device_id) loadDevicePanel(t, false);
}

const todayStamp = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The loaner is a Google device like any other: search the loaner org unit by
 * asset tag (scan or type), link it, and mark it returned when it comes back.
 */
function renderLoanerPanel(t) {
  const box = $('#d-loaner-panel');
  if (!box) return;
  const tag = t.loaner_asset_tag || t.loaner_serial;
  const ou = (state.meta.loaner && state.meta.loaner.org_unit) || '/Devices/Loaners';

  if (tag) {
    const out = t.loaner_outstanding;
    const due = t.loaner_due || {};
    const dueLine = !out
      ? `returned ${esc(relTime(t.loaner_returned_at))}`
      : due.due_day
      ? due.overdue
        ? `<span style="color:var(--danger);font-weight:600">due ${esc(due.due_day)} &middot; ${esc(due.school_days_overdue)} school days overdue</span>`
        : due.due_today
        ? `<span style="color:var(--warn);font-weight:600">due back today</span>`
        : `due ${esc(due.due_day)} (${esc(due.days_until_due)} days)`
      : '<span class="muted">no due date set</span>';
    box.innerHTML = `
      <div class="loaner-linked">
        <div class="grow">
          <div><b>${esc(t.loaner_asset_tag || '(no asset tag)')}</b>
            ${t.loaner_serial ? `<span class="small muted mono"> &middot; ${esc(t.loaner_serial)}</span>` : ''}</div>
          <div class="small muted">${esc(t.loaner_model || 'Loaner device')} &middot;
            ${out ? `out ${esc(due.days_out == null ? '' : due.days_out + ' days')}` : ''} ${dueLine}</div>
        </div>
        ${out ? '<button class="btn sm" id="d-loaner-return">Mark returned</button>' : ''}
        <button class="btn ghost sm" id="d-loaner-change">Change</button>
        <button class="btn ghost sm danger" id="d-loaner-clear">Unlink</button>
      </div>
      ${out && (t.status === 'closed' || t.status === 'ready_for_pickup')
        ? `<div class="warn-line">This ticket still has loaner ${esc(tag)} checked out${due.repair_done_at ? ` &mdash; ${esc(due.days_since_repair_done)} days since the repair finished` : ''}. Mark it returned when it comes back.</div>`
        : ''}
      ${out ? `<div class="row" style="align-items:center;margin-top:12px">
        <label class="field" style="flex:0 1 190px;margin-bottom:0"><span>Due back</span>
          <input type="date" id="d-loaner-due" value="${esc(due.due_day || '')}"></label>
        <button class="btn ghost sm" id="d-loaner-plus3" style="flex:0 0 auto">+3 school days</button>
        <button class="btn ghost sm" id="d-loaner-plus5" style="flex:0 0 auto">+5</button>
        <div style="flex:1"></div>
        <button class="btn sm" id="d-loaner-due-save" style="flex:0 0 auto">Save due date</button>
      </div>
      ${(t.loaner_reminders_sent || []).length ? `<div class="small muted" style="margin-top:8px">Reminders sent:
        ${esc((t.loaner_reminders_sent || []).map((r) => `${r.kind.replace(/_/g, ' ')} on ${r.sent_on}`).join(' · '))}</div>` : ''}` : ''}`;
    if ($('#d-loaner-return')) {
      $('#d-loaner-return').addEventListener('click', async (e) => {
        e.target.disabled = true;
        try { await api(`/tickets/${t.id}/loaner/return`, { method: 'POST' }); toast('Loaner marked returned'); await refreshTicket(); }
        catch (err) { toast(err.message, true); e.target.disabled = false; }
      });
    }
    const saveDue = async (body) => {
      try {
        const res = await api(`/tickets/${t.id}/loaner/due`, { method: 'PATCH', body });
        toast(`Due back ${res.due_day}`);
        await refreshTicket();
      } catch (err) {
        toast(err.message, true);
      }
    };
    if ($('#d-loaner-due-save')) {
      $('#d-loaner-due-save').addEventListener('click', () => saveDue({ due_day: $('#d-loaner-due').value }));
      $('#d-loaner-plus3').addEventListener('click', () => saveDue({ extend_school_days: 3 }));
      $('#d-loaner-plus5').addEventListener('click', () => saveDue({ extend_school_days: 5 }));
    }
    $('#d-loaner-change').addEventListener('click', () => renderLoanerSearch(t, ou));
    $('#d-loaner-clear').addEventListener('click', async () => {
      if (!window.confirm('Remove the loaner link from this ticket?')) return;
      await api(`/tickets/${t.id}/loaner`, { method: 'DELETE' });
      toast('Loaner unlinked');
      await refreshTicket();
    });
    return;
  }

  renderLoanerSearch(t, ou);
}

function renderLoanerSearch(t, ou) {
  const box = $('#d-loaner-panel');
  box.innerHTML = `
    <p class="small muted" style="margin-top:0">Scan or type the loaner's asset tag. We look it up in
      <span class="mono">${esc(ou)}</span> in Google Admin, so the loaner is linked the same way as the repaired device.
      It will be due back in ${esc((state.meta.loaner && state.meta.loaner.due_school_days) || 5)} school days,
      which you can change after linking.</p>
    <div class="row" style="align-items:center">
      <div style="flex:2 1 220px"><input type="text" id="d-loaner-q" placeholder="e.g. 012, Loaner-012, or a serial"></div>
      <button class="btn" id="d-loaner-search" style="flex:0 0 auto">Find loaner</button>
      <button class="btn ghost sm" id="d-loaner-pool" style="flex:0 0 auto">Show pool</button>
    </div>
    <div class="device-hits" id="d-loaner-hits" style="margin-top:10px"></div>`;

  const hits = $('#d-loaner-hits');
  const issue = async (device) => {
    try {
      const res = await api(`/tickets/${t.id}/loaner`, { method: 'POST', body: { device_id: device.device_id } });
      toast(`Loaner ${device.asset_tag || device.serial} issued`);
      if (res.in_loaner_ou === false) toast('Note: that device is not in the loaner org unit', true);
      await refreshTicket();
    } catch (err) {
      toast(err.message, true);
    }
  };
  const show = (devices, normalized) => {
    if (!devices.length) {
      hits.innerHTML = `<p class="small muted">Nothing in ${esc(ou)} matches${normalized ? ` <b>${esc(normalized)}</b>` : ''}.
        Check the tag, or use "Show pool".</p>`;
      return;
    }
    hits.innerHTML = deviceHitsHtml(devices);
    $$('.hit', hits).forEach((el) =>
      el.addEventListener('click', () => issue(devices.find((d) => d.device_id === el.dataset.id)))
    );
  };
  const search = async () => {
    const q = cleanScan($('#d-loaner-q').value);
    if (!q) return;
    hits.innerHTML = '<span class="spinner"></span> Searching the loaner pool&hellip;';
    try {
      const { devices, normalized } = await api('/loaners/search?q=' + encodeURIComponent(q));
      // A single exact hit is what a scan should do: link it and move on.
      const exact = devices.filter((d) => d.exact);
      if (exact.length === 1) return issue(exact[0]);
      show(devices, normalized);
    } catch (err) {
      hits.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
    }
  };

  $('#d-loaner-search').addEventListener('click', search);
  attachScanner($('#d-loaner-q'), search);
  addScanButton($('#d-loaner-q'), search);
  $('#d-loaner-pool').addEventListener('click', async (e) => {
    e.target.disabled = true;
    hits.innerHTML = '<span class="spinner"></span> Loading the loaner pool&hellip;';
    try {
      const { devices } = await api('/loaners/pool');
      show(devices, '');
    } catch (err) {
      hits.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
    }
  });
}

async function loadDevicePanel(t, force) {
  const box = $('#d-device');
  if (!box || !t.device_id) return;
  box.innerHTML = '<span class="spinner"></span> Loading from Google&hellip;';
  try {
    const { device } = await api(`/devices/${encodeURIComponent(t.device_id)}${force ? '?refresh=1' : ''}`);
    box.innerHTML = deviceKv(device) + (state.meta.allow_device_writeback ? deviceEditForm(device) : '');
    if (state.meta.allow_device_writeback) wireDeviceEdit(device, () => loadDevicePanel(t, true));
  } catch (err) {
    box.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

function deviceKv(d) {
  return `<dl class="kv">
    <dt>Asset tag</dt><dd>${esc(d.asset_tag || '-')}</dd>
    <dt>Serial</dt><dd class="mono">${esc(d.serial || '-')}</dd>
    <dt>Model</dt><dd>${esc(d.model || '-')}</dd>
    <dt>Status</dt><dd>${esc(d.status || '-')}</dd>
    <dt>Assigned user</dt><dd>${esc(d.annotated_user || '-')}</dd>
    <dt>Most recent user</dt><dd>${esc(d.most_recent_user || '-')}</dd>
    <dt>Recent users</dt><dd class="small">${esc((d.recent_users || []).slice(0, 5).join(', ') || '-')}</dd>
    <dt>Org unit</dt><dd class="small">${esc(d.org_unit || '-')}</dd>
    <dt>Location</dt><dd>${esc(d.annotated_location || '-')}</dd>
    <dt>Notes</dt><dd style="white-space:pre-wrap">${esc(d.notes || '-')}</dd>
    <dt>Last sync</dt><dd class="small">${esc(fullTime(d.last_sync))}</dd>
    <dt>OS version</dt><dd class="small">${esc(d.os_version || '-')}</dd>
    <dt>Auto-update expires</dt><dd class="small">${esc(d.auto_update_expiration ? new Date(Number(d.auto_update_expiration)).toLocaleDateString() : '-')}</dd>
    <dt>Cached</dt><dd class="small muted">${esc(relTime(d.cached_at))}${d.stale ? ' (Google lookup failed, showing cache)' : ''}</dd>
  </dl>`;
}

function deviceEditForm(d) {
  return `<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Edit these in Google Admin</summary>
    <div class="row" style="margin-top:10px">
      <label class="field"><span>Asset tag</span><input type="text" id="g-asset" value="${esc(d.asset_tag || '')}"></label>
      <label class="field"><span>Assigned user</span><input type="text" id="g-user" value="${esc(d.annotated_user || '')}"></label>
      <label class="field"><span>Location</span><input type="text" id="g-location" value="${esc(d.annotated_location || '')}"></label>
    </div>
    <label class="field"><span>Notes</span><textarea id="g-notes" style="min-height:70px">${esc(d.notes || '')}</textarea></label>
    <button class="btn sm" id="g-save" data-device="${esc(d.device_id)}">Save to Google Admin</button>
  </details>`;
}

function wireDeviceEdit(d, after) {
  const btn = $('#g-save');
  if (!btn) return;
  attachScanner($('#g-asset'), () => {});
  addScanButton($('#g-asset'), () => {});
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      await api('/devices/' + encodeURIComponent(d.device_id), {
        method: 'PATCH',
        body: {
          asset_tag: $('#g-asset').value,
          annotated_user: $('#g-user').value,
          annotated_location: $('#g-location').value,
          notes: $('#g-notes').value,
        },
      });
      toast('Saved to Google Admin');
      if (after) await after();
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save to Google Admin';
    }
  });
}

async function showEmail(id) {
  const back = state.openTicketId; // so closing the email returns to the ticket
  const { email } = await api('/emails/' + id);
  overlay(`<div class="modal"><header><h2>${esc(email.subject || 'Email')}</h2><div style="flex:1"></div>
    <button class="btn ghost sm" data-x="c">Close</button></header>
    <div class="body">
      <p class="small muted">To ${esc(email.to_email)} &middot; ${esc(fullTime(email.created_at))} &middot; ${esc(email.result)}${email.error ? ' &mdash; ' + esc(email.error) : ''}</p>
      <div class="preview-frame">${email.body || ''}</div>
    </div></div>`);
  const goBack = () => (back ? openTicket(back) : closeOverlays());
  $('[data-x=c]').addEventListener('click', goBack);
  $('#overlays [data-close]').addEventListener('click', goBack);
}

// ---------------------------------------------------------------- new ticket
function openNewTicket(prefill = {}) {
  const device = prefill.device || null;
  overlay(`<div class="modal"><header><h2>New repair ticket</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="c">Cancel</button></header>
    <div class="body">
      <div class="card">
        <h2>1. Find the device</h2>
        <div class="row">
          <div style="flex:3 1 240px"><input type="search" id="n-device-q" placeholder="Serial, asset tag, or user email" value="${esc(prefill.query || '')}"></div>
          <button class="btn" id="n-device-search" style="flex:0 0 auto">Search Google</button>
          <button class="btn ghost sm" id="n-device-skip" style="flex:0 0 auto">No device / manual</button>
        </div>
        <div class="device-hits" id="n-device-hits" style="margin-top:10px"></div>
      </div>
      <div class="card" id="n-form-card" ${device ? '' : 'hidden'}>
        <h2>2. Ticket details</h2>
        <div class="row">
          <label class="field"><span>Serial</span><input type="text" id="n-serial" value="${esc(device ? device.serial || '' : '')}"></label>
          <label class="field"><span>Asset tag</span><input type="text" id="n-asset" value="${esc(device ? device.asset_tag || '' : '')}"></label>
          <label class="field"><span>Model</span><input type="text" id="n-model" value="${esc(device ? device.model || '' : '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>User email</span><input type="email" id="n-user-email" value="${esc(device ? device.most_recent_user || '' : '')}"></label>
          <label class="field"><span>User name</span><input type="text" id="n-user-name" value=""></label>
          <label class="field"><span>Location</span><input type="text" id="n-location" value="${esc(device ? device.annotated_location || '' : '')}"></label>
        </div>
        <div class="row">
          <label class="field"><span>Category</span><select id="n-category">${['', ...(state.meta.categories || [])].map((c) => `<option value="${esc(c)}">${esc(c || '- pick one -')}</option>`).join('')}</select></label>
          <label class="field"><span>Priority</span><select id="n-priority">${state.meta.priorities.map((p) => `<option value="${esc(p.key)}"${p.key === 'normal' ? ' selected' : ''}>${esc(p.label)}</option>`).join('')}</select></label>
          <label class="field"><span>Assigned to</span><input type="text" id="n-assigned" placeholder="Your name"></label>
        </div>
        <label class="field"><span>What is wrong?</span><textarea id="n-issue" style="min-height:70px;font-family:inherit;font-size:14px" placeholder="Cracked screen, lower right corner. Touch not responding."></textarea></label>
        <div class="row">
          <label class="field"><span>Loaner asset tag (optional)</span>
            <input type="text" id="n-loaner" placeholder="e.g. 012 or Loaner-012"></label>
          <label class="field"><span>Initial note for the user (optional)</span><input type="text" id="n-note"></label>
        </div>
        <label class="check"><input type="checkbox" id="n-notify" checked> Email the user that we received the device</label>
      </div>
      <div id="n-result"></div>
    </div>
    <footer><span class="small muted" id="n-hint">Pick a device or choose manual entry.</span>
      <button class="btn primary" id="n-create" ${device ? '' : 'disabled'}>Create ticket</button></footer>
  </div>`);

  $('[data-x=c]').addEventListener('click', closeOverlays);
  let selected = device;

  const showForm = () => {
    $('#n-form-card').hidden = false;
    $('#n-create').disabled = false;
    $('#n-hint').textContent = selected ? `Device: ${selected.serial || ''} ${selected.asset_tag ? '(' + selected.asset_tag + ')' : ''}` : 'Manual entry (no Google device linked)';
  };

  const runSearch = async () => {
    const q = $('#n-device-q').value.trim();
    if (!q) return;
    const hits = $('#n-device-hits');
    hits.innerHTML = '<span class="spinner"></span> Searching Google&hellip;';
    try {
      const { devices } = await api('/devices/search?q=' + encodeURIComponent(q));
      if (!devices.length) { hits.innerHTML = '<p class="small muted">Nothing matched. Try the full serial, or use manual entry.</p>'; return; }
      hits.innerHTML = deviceHitsHtml(devices);
      $$('.hit', hits).forEach((el) =>
        el.addEventListener('click', () => {
          selected = devices.find((d) => d.device_id === el.dataset.id);
          $$('.hit', hits).forEach((x) => x.classList.toggle('selected', x === el));
          $('#n-serial').value = selected.serial || '';
          $('#n-asset').value = selected.asset_tag || '';
          $('#n-model').value = selected.model || '';
          $('#n-user-email').value = selected.most_recent_user || '';
          $('#n-location').value = selected.annotated_location || '';
          showForm();
          lookupName();
        })
      );
    } catch (err) {
      hits.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
    }
  };

  const lookupName = async () => {
    const email = $('#n-user-email').value.trim();
    if (!email || !email.includes('@') || $('#n-user-name').value.trim()) return;
    try {
      const { user } = await api('/users/lookup?email=' + encodeURIComponent(email));
      if (user && user.name) $('#n-user-name').value = user.name;
    } catch { /* directory lookup is a nicety */ }
  };

  $('#n-device-search').addEventListener('click', runSearch);
  attachScanner($('#n-device-q'), runSearch);
  addScanButton($('#n-device-q'), runSearch);
  $('#n-device-skip').addEventListener('click', () => { selected = null; showForm(); });
  attachScanner($('#n-loaner'), () => {});
  addScanButton($('#n-loaner'), () => {});
  if (device) { showForm(); lookupName(); }

  $('#n-create').addEventListener('click', async (e) => {
    const btn = e.target;
    btn.disabled = true;
    btn.textContent = 'Creating…';
    try {
      const res = await api('/tickets', {
        method: 'POST',
        body: {
          device_id: selected ? selected.device_id : null,
          serial: $('#n-serial').value,
          asset_tag: $('#n-asset').value,
          model: $('#n-model').value,
          user_email: $('#n-user-email').value,
          user_name: $('#n-user-name').value,
          issue_category: $('#n-category').value,
          issue_description: $('#n-issue').value,
          priority: $('#n-priority').value,
          assigned_to: $('#n-assigned').value,
          location: $('#n-location').value,
          loaner_asset_tag: cleanScan($('#n-loaner').value),
          initial_note: $('#n-note').value,
          notify: $('#n-notify').checked,
        },
      });
      toast(`Ticket #${res.ticket.id} created` + (res.email && res.email.result === 'sent' ? ' and user emailed' : ''));
      if (res.email && res.email.result === 'error') toast('Ticket created, but the email failed: ' + res.email.error, true);
      loadTickets();
      loadStats();
      openTicket(res.ticket.id);
    } catch (err) {
      $('#n-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      btn.disabled = false;
      btn.textContent = 'Create ticket';
    }
  });
}

const MATCH_LABELS = {
  exact_asset_tag: 'exact asset tag',
  exact_serial: 'exact serial',
  user: 'this user',
  partial_asset_tag: 'asset tag starts with',
  partial_serial: 'serial starts with',
  other: '',
};

const deviceHitHtml = (d) => `<div class="hit" data-id="${esc(d.device_id)}">
  <div class="grow">
    <div><b class="mono">${esc(d.serial || '(no serial)')}</b>${d.asset_tag ? ` &middot; asset ${esc(d.asset_tag)}` : ''}
      ${d.match && MATCH_LABELS[d.match] ? `<span class="pill" style="background:${d.exact ? 'var(--ok)' : 'var(--border)'};color:${d.exact ? '#fff' : 'var(--muted)'};margin-left:6px">${esc(MATCH_LABELS[d.match])}</span>` : ''}</div>
    <div class="small muted">${esc(d.model || '')} &middot; ${esc(d.most_recent_user || 'no recent user')} &middot; ${esc(d.org_unit || '')}</div>
  </div>
  <div class="small muted">${esc(d.status || '')}</div>
</div>`;

/**
 * Google matches asset tags by prefix, so "24-1" also returns 24-111. Show the
 * exact hits on their own and tuck the prefix matches behind a disclosure.
 */
function deviceHitsHtml(devices) {
  const exact = devices.filter((d) => d.exact);
  const partial = devices.filter((d) => !d.exact);
  if (!exact.length || !partial.length) return devices.map(deviceHitHtml).join('');
  return (
    exact.map(deviceHitHtml).join('') +
    `<details style="margin-top:4px"><summary class="small muted" style="cursor:pointer">
      ${partial.length} other device${partial.length === 1 ? '' : 's'} whose tag or serial starts with the same text</summary>
      <div class="device-hits" style="margin-top:8px">${partial.map(deviceHitHtml).join('')}</div></details>`
  );
}

// ---------------------------------------------------------------- devices view
async function searchDevicesView(q) {
  const hits = $('#device-hits');
  $('#devices-empty').hidden = true;
  if (!q || !q.trim()) return;
  hits.innerHTML = '<span class="spinner"></span> Searching Google&hellip;';
  try {
    const { devices } = await api('/devices/search?q=' + encodeURIComponent(q.trim()));
    renderDeviceHits(devices);
  } catch (err) {
    hits.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

async function loadRecentDevices() {
  const hits = $('#device-hits');
  hits.innerHTML = '<span class="spinner"></span> Loading&hellip;';
  try {
    const { devices } = await api('/devices/recent?limit=25');
    renderDeviceHits(devices);
  } catch (err) {
    hits.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

function renderDeviceHits(devices) {
  const hits = $('#device-hits');
  if (!devices.length) { hits.innerHTML = '<p class="small muted">No devices matched.</p>'; return; }
  hits.innerHTML = deviceHitsHtml(devices);
  $$('.hit', hits).forEach((el) =>
    el.addEventListener('click', () => showDevice(devices.find((d) => d.device_id === el.dataset.id)))
  );
}

async function showDevice(device) {
  overlay(`<div class="modal"><header><h2>${esc(device.serial || 'Device')}</h2><div style="flex:1"></div>
    <button class="btn primary sm" id="dev-new-ticket">New ticket for this device</button>
    <button class="btn ghost sm" data-x="c">Close</button></header>
    <div class="body" id="dev-body"><span class="spinner"></span> Loading&hellip;</div></div>`);
  $('[data-x=c]').addEventListener('click', closeOverlays);
  $('#dev-new-ticket').addEventListener('click', () => openNewTicket({ device }));
  try {
    const { device: d, ticket_history } = await api('/devices/' + encodeURIComponent(device.device_id));
    $('#dev-body').innerHTML = `
      ${deviceKv(d)}
      ${state.meta.allow_device_writeback ? deviceEditForm(d) : ''}
      <h2 style="font-size:14px;margin:18px 0 6px">Repair history</h2>
      ${ticket_history.length
        ? `<ul class="small" style="padding-left:18px">${ticket_history.map((h) => `<li><a href="#" data-goto="${h.id}">#${h.id}</a> ${esc(statusMeta(h.status).label)} &mdash; ${esc((h.issue_description || '').slice(0, 80))} <span class="muted">(${esc(relTime(h.created_at))})</span></li>`).join('')}</ul>`
        : '<p class="small muted">No tickets have been filed for this serial.</p>'}`;
    if (state.meta.allow_device_writeback) wireDeviceEdit(d, () => showDevice(d));
    $$('[data-goto]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); openTicket(Number(a.dataset.goto)); }));
  } catch (err) {
    $('#dev-body').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- loaners page
const LOANER_FILTERS = [
  { key: 'out', label: 'All out' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'due_soon', label: 'Due today / tomorrow' },
  { key: 'after_repair', label: 'Repair done, still out' },
  { key: 'undated', label: 'No due date' },
  { key: 'returned', label: 'Recently returned' },
];

const dueClass = (l) => (l.overdue ? 'style="color:var(--danger);font-weight:600"' : l.due_today ? 'style="color:var(--warn);font-weight:600"' : '');

async function loadLoaners(force = false) {
  const box = $('#loaner-table');
  if (!state.loanerData || force) {
    box.innerHTML = '<span class="spinner"></span> Loading&hellip;';
    try {
      state.loanerData = await api('/loaners/out?include_returned=1');
    } catch (err) {
      box.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      return;
    }
  }
  renderLoanerStats();
  renderLoanerChips();
  renderLoanerTable();
  renderLoanerReminderCard();
}

function renderLoanerStats() {
  const s = state.loanerData.stats;
  // `secondary` tiles are hidden on phones, where vertical space is the scarce thing
  const cards = [
    ['Out on loan', s.out, false],
    ['Overdue', s.overdue, false],
    ['Due today', s.due_today, false],
    ['Repair done, still out', s.still_out_after_repair, false],
    ['Due tomorrow', s.due_tomorrow, true],
    ['No due date', s.no_due_date, true],
    ['Avg days out', s.avg_days_out, true],
    ['Longest out', s.longest_days_out, true],
  ];
  $('#loaner-stats').innerHTML = cards
    .map(([label, n, secondary]) => `<div class="stat${secondary ? ' secondary' : ''}">
      <b${label === 'Overdue' && n > 0 ? ' style="color:var(--danger)"' : ''}>${esc(n)}</b><span>${esc(label)}</span></div>`)
    .join('');
}

function renderLoanerChips() {
  $('#loaner-chips').innerHTML = LOANER_FILTERS
    .map((f) => `<button class="chip${state.loanerFilter === f.key ? ' active' : ''}" data-lf="${esc(f.key)}">${esc(f.label)}</button>`)
    .join('');
  $$('#loaner-chips .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.loanerFilter = b.dataset.lf;
      renderLoanerChips();
      renderLoanerTable();
    })
  );
}

function filteredLoaners() {
  const { loaners, returned } = state.loanerData;
  switch (state.loanerFilter) {
    case 'overdue': return loaners.filter((l) => l.overdue);
    case 'due_soon': return loaners.filter((l) => l.due_today || l.due_tomorrow);
    case 'after_repair': return loaners.filter((l) => l.repair_done_at && l.days_since_repair_done >= 1);
    case 'undated': return loaners.filter((l) => !l.due_day);
    case 'returned': return returned || [];
    default: return loaners;
  }
}

function renderLoanerTable() {
  const rows = filteredLoaners();
  const returnedView = state.loanerFilter === 'returned';
  if (!rows.length) {
    $('#loaner-table').innerHTML = '<div class="empty">Nothing here. Good.</div>';
    return;
  }
  $('#loaner-table').innerHTML = `<table class="bordered cards"><thead><tr>
      <th>Loaner</th><th>Student</th><th>${returnedView ? 'Returned' : 'Due'}</th>
      <th>Days out</th><th>Since repair done</th><th>Repair ticket</th><th>Reminders</th><th></th>
    </tr></thead><tbody>${rows.map((l) => `<tr data-ticket="${l.ticket_id}">
      <td data-label="Loaner"><b>${esc(l.loaner_asset_tag || l.loaner_serial || '?')}</b>
        <div class="small muted">${esc(l.loaner_model || '')}</div></td>
      <td data-label="Student">${esc(l.user_name || l.user_email || '-')}
        ${l.user_name && l.user_email ? `<div class="small muted">${esc(l.user_email)}</div>` : ''}</td>
      <td data-label="${returnedView ? 'Returned' : 'Due'}" ${returnedView ? '' : dueClass(l)}>
        ${returnedView ? esc(relTime(l.loaner_returned_at)) : l.due_day ? `${esc(l.due_day)}${l.overdue ? ` (${esc(l.school_days_overdue)} school days over)` : l.due_today ? ' (today)' : ''}` : '<span class="muted">not set</span>'}</td>
      <td data-label="Days out">${esc(l.days_out == null ? '-' : l.days_out)}</td>
      <td data-label="Since repair done">${l.repair_done_at ? esc(l.days_since_repair_done) : '<span class="muted">still open</span>'}</td>
      <td data-label="Ticket">#${esc(l.ticket_id)} <span class="small muted">${esc(l.status_label)}</span></td>
      <td data-label="Reminders" class="small muted">${l.reminder_count ? esc(l.reminders.map((r) => r.kind.replace(/_/g, ' ')).join(', ')) : 'none'}</td>
      <td class="row-actions">
        ${returnedView ? '' : `<button class="btn sm" data-return="${l.ticket_id}">Returned</button>
        <button class="btn ghost sm" data-extend="${l.ticket_id}">+5 days</button>`}
        <button class="btn ghost sm" data-open="${l.ticket_id}">Ticket</button>
      </td>
    </tr>`).join('')}</tbody></table>`;

  $$('#loaner-table [data-return]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/tickets/${b.dataset.return}/loaner/return`, { method: 'POST' });
        toast('Marked returned');
        await loadLoaners(true);
      } catch (err) { toast(err.message, true); b.disabled = false; }
    })
  );
  $$('#loaner-table [data-extend]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const res = await api(`/tickets/${b.dataset.extend}/loaner/due`, { method: 'PATCH', body: { extend_school_days: 5 } });
        toast(`Due ${res.due_day}`);
        await loadLoaners(true);
      } catch (err) { toast(err.message, true); b.disabled = false; }
    })
  );
  $$('#loaner-table [data-open]').forEach((b) => b.addEventListener('click', () => openTicket(Number(b.dataset.open))));
}

function renderLoanerReminderCard() {
  const r = state.loanerData.reminders;
  const box = $('#loaner-reminders');
  box.innerHTML = `
    <h2>Return reminders</h2>
    ${r.enabled
      ? `<p style="margin-top:0">Loaners are due back after <b>${esc(r.school_days)} school days</b> (weekends and holidays skipped).
         Students get an email the day before and the day it is due, then every ${esc(r.overdue_every_days)} days
         while overdue (up to ${esc(r.max_overdue_nudges)} times). Daily pass at <b>${esc(r.at)}</b>,
         next ${esc(fullTime(r.next_run))}.</p>
         <p class="small muted">${r.digest_enabled ? `Digest of overdue and due-today goes to <b>${esc(r.digest_to || 'the connected Google account')}</b>.` : 'Digest is off.'}
           Loaner pool: <span class="mono">${esc(r.org_unit)}</span>.
           ${r.holidays.length ? `${r.holidays.length} holiday dates configured.` : 'No holidays configured (SCHOOL_HOLIDAYS in .env).'}</p>`
      : '<div class="result-line info">Reminders are off (<span class="mono">LOANER_REMINDERS_ENABLED=false</span>).</div>'}
    <button class="btn" id="loaner-run-reminders">Run the reminder pass now</button>
    <button class="btn ghost sm" id="loaner-send-digest">Send me the digest</button>
    <div id="loaner-reminder-result"></div>`;

  $('#loaner-run-reminders').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Running…';
    try {
      const res = await api('/loaners/reminders/run', { method: 'POST' });
      const parts = [
        `${res.sent.length} reminder${res.sent.length === 1 ? '' : 's'} sent`,
        res.skipped.length ? `${res.skipped.length} skipped` : null,
        res.failed.length ? `${res.failed.length} failed` : null,
        res.digest ? `digest: ${res.digest.result}` : null,
      ].filter(Boolean);
      const line = `<div class="result-line ${res.failed.length ? 'err' : 'ok'}">${esc(parts.join(' · '))}</div>`;
      // Refresh first: re-rendering the card would otherwise wipe this message.
      await loadLoaners(true);
      if ($('#loaner-reminder-result')) $('#loaner-reminder-result').innerHTML = line;
    } catch (err) {
      $('#loaner-reminder-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
    } finally {
      e.target.disabled = false;
      e.target.textContent = 'Run the reminder pass now';
    }
  });
  $('#loaner-send-digest').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const { digest } = await api('/loaners/digest/send', { method: 'POST' });
      toast(`Digest: ${digest.result}${digest.to ? ' to ' + digest.to : ''}`, digest.result === 'error');
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });
}

/**
 * Parts on a ticket: what was fitted (straight off the shelf, with history) and
 * what is still on the way, with the sentence the student has been told.
 */
function renderPartsPanel(t) {
  const box = $('#d-parts');
  if (!box) return;
  const used = t.parts_used || [];
  const incoming = t.parts_incoming || [];

  box.innerHTML = `
    ${used.length
      ? `<table><tbody>${used.map((p) => `<tr>
          <td data-label="Part"><b>${esc(p.name)}</b>${p.part_number ? ` <span class="small muted mono">${esc(p.part_number)}</span>` : ''}
            <div class="small muted">${p.qty ? `${esc(p.qty)} ` : ''}${esc(p.direction)} &middot; ${esc(relTime(p.created_at))} &middot; ${esc(p.author || 'system')}${p.note && !p.fitted ? ` &middot; ${esc(p.note)}` : ''}</div></td>
          <td style="width:110px" class="row-actions">${p.fitted
            ? `<button class="btn ghost sm" data-part-return="${p.item_id}" data-qty="${p.qty}">Put back</button>` : ''}</td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="small muted" style="margin-top:0">No parts fitted yet.</p>'}

    <div class="row" style="align-items:flex-end;margin-top:10px">
      <label class="field" style="flex:2 1 220px;margin-bottom:0"><span>Fit a part from stock</span>
        <input type="text" id="d-part-q" placeholder="Search parts, bins, models" list="d-part-list" autocomplete="off">
        <datalist id="d-part-list"></datalist></label>
      <label class="field" style="flex:0 1 90px;margin-bottom:0"><span>Qty</span>
        <input type="number" id="d-part-qty" value="1" min="1"></label>
      <button class="btn" id="d-part-use" style="flex:0 0 auto">Use it</button>
    </div>
    <div id="d-part-hits" class="small muted" style="margin-top:6px"></div>

    <h2 style="font-size:14px;margin:18px 0 8px">On the way</h2>
    ${incoming.length
      ? incoming.map((s) => `<div class="loaner-linked" style="border-left-color:${s.late ? 'var(--danger)' : 'var(--brand-accent)'};margin-bottom:8px">
          <div class="grow">
            <div><span class="pill" style="background:${SHIP_BADGE[s.status] || 'var(--muted)'}">${esc(s.status)}</span>
              <b style="margin-left:8px">${esc(s.lines.filter((l) => l.ticket_id === t.id).map((l) => l.description || l.item_name).filter(Boolean).join(', ') || 'parts')}</b></div>
            <div class="small muted">${esc(s.expectation)}
              ${s.tracking_url ? ` &middot; <a href="${esc(s.tracking_url)}" target="_blank" rel="noreferrer">track ${esc(s.carrier || '')}</a>` : ''}</div>
          </div>
          <button class="btn ghost sm" data-ship-open="${s.id}">Open</button>
        </div>`).join('')
      : `<p class="small muted">Nothing on order for this ticket. <a href="#" id="d-part-order">Add a shipment</a>.</p>`}`;

  // typeahead over stock
  let matches = [];
  const search = async () => {
    const q = cleanScan($('#d-part-q').value);
    if (q.length < 2) { $('#d-part-hits').textContent = ''; return; }
    try {
      const { items } = await api('/inventory?kind=part&q=' + encodeURIComponent(q));
      matches = items;
      $('#d-part-list').innerHTML = items.map((i) => `<option value="${esc(i.label)}">`).join('');
      $('#d-part-hits').innerHTML = items.length
        ? items.slice(0, 4).map((i) => `${esc(i.label)} &mdash; ${esc(i.qty_on_hand)} in ${esc(i.location || 'stock')}`).join('<br>')
        : 'Nothing in stock matches. Add it under Inventory, or put it on a shipment.';
    } catch (err) {
      $('#d-part-hits').textContent = err.message;
    }
  };
  let partTimer;
  $('#d-part-q').addEventListener('input', () => { clearTimeout(partTimer); partTimer = setTimeout(search, 220); });
  attachScanner($('#d-part-q'), search);

  $('#d-part-use').addEventListener('click', (e) =>
    busyish(e.target, async () => {
      const text = cleanScan($('#d-part-q').value);
      const match = matches.find((i) => i.label === text || i.name === text) || (matches.length === 1 ? matches[0] : null);
      if (!match) { toast('Pick a part from the list first', true); return; }
      await api(`/tickets/${t.id}/parts`, { method: 'POST', body: { item_id: match.id, qty: Number($('#d-part-qty').value) || 1 } });
      toast(`Fitted ${match.name}`);
      state.invData = null;
      await refreshTicket();
    })
  );
  $$('[data-part-return]').forEach((b) =>
    b.addEventListener('click', (e) =>
      busyish(e.target, async () => {
        await api(`/tickets/${t.id}/parts`, {
          method: 'POST',
          body: { item_id: Number(b.dataset.partReturn), qty: Number(b.dataset.qty) || 1, direction: 'return' },
        });
        toast('Back on the shelf');
        state.invData = null;
        await refreshTicket();
      })
    )
  );
  $$('[data-ship-open]').forEach((b) =>
    b.addEventListener('click', async () => {
      const { shipment } = await api('/shipments/' + b.dataset.shipOpen);
      openShipmentForm(shipment);
    })
  );
  if ($('#d-part-order')) {
    $('#d-part-order').addEventListener('click', (e) => {
      e.preventDefault();
      openShipmentForm(null);
      // pre-fill the line for this ticket
      setTimeout(() => { if ($('#s-line-ticket')) $('#s-line-ticket').value = t.id; }, 50);
    });
  }
}

/** Small helper: disable a button while its work runs, and report failures. */
async function busyish(btn, fn) {
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try { await fn(); } catch (err) { toast(err.message, true); } finally { btn.disabled = false; btn.textContent = label; }
}

// ---------------------------------------------------------------- inventory
const INV_TABS = [
  { key: 'onhand', label: 'On hand' },
  { key: 'donors', label: 'Donor devices' },
  { key: 'low', label: 'Low stock' },
  { key: 'incoming', label: 'Incoming parts' },
];

async function loadInventoryView(force = false) {
  renderInvTabs();
  $('#inv-add').textContent = state.invTab === 'incoming' ? 'New shipment' : state.invTab === 'donors' ? 'Add donor device' : 'Add part';
  const body = $('#inv-body');
  if (state.invTab === 'incoming') {
    if (!state.shipData || force) {
      body.innerHTML = '<span class="spinner"></span> Loading&hellip;';
      try { state.shipData = await api('/shipments?status=open'); }
      catch (err) { body.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`; return; }
    }
    renderInvStats(state.shipData.stats, true);
    renderShipments();
    return;
  }
  if (!state.invData || force) {
    body.innerHTML = '<span class="spinner"></span> Loading&hellip;';
    const params = new URLSearchParams();
    if (state.invSearch.trim()) params.set('q', state.invSearch.trim());
    if (state.invTab === 'donors') params.set('kind', 'donor_device');
    if (state.invTab === 'low') params.set('low', '1');
    try { state.invData = await api('/inventory?' + params); }
    catch (err) { body.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`; return; }
  }
  renderInvStats(state.invData.stats, false);
  renderItems();
}

function renderInvTabs() {
  $('#inv-tabs').innerHTML = INV_TABS
    .map((t) => `<button class="chip${state.invTab === t.key ? ' active' : ''}" data-it="${esc(t.key)}">${esc(t.label)}</button>`)
    .join('');
  $$('#inv-tabs .chip').forEach((b) =>
    b.addEventListener('click', () => {
      state.invTab = b.dataset.it;
      state.invData = null;
      loadInventoryView(true);
    })
  );
}

function renderInvStats(stats, incoming) {
  const cards = incoming
    ? [['Open shipments', stats.open], ['On order', stats.ordered], ['In transit', stats.shipped],
       ['Delivered, not checked in', stats.delivered_not_received], ['Due today', stats.due_today],
       ['Late', stats.late], ['Tickets waiting', stats.tickets_waiting]]
    : [['Part lines', stats.part_lines], ['Units on hand', stats.part_units], ['Low stock', stats.low_stock],
       ['Out of stock', stats.out_of_stock], ['Donor devices', stats.donor_units], ['Used in 30 days', stats.used_last_30_days]];
  $('#inv-stats').innerHTML = cards
    .map(([label, n]) => `<div class="stat"><b${(label === 'Low stock' || label === 'Late') && n > 0 ? ' style="color:var(--warn)"' : ''}>${esc(n)}</b><span>${esc(label)}</span></div>`)
    .join('');
}

function renderItems() {
  const items = state.invData.items;
  const body = $('#inv-body');
  if (!items.length) {
    body.innerHTML = `<div class="empty">Nothing here yet. ${state.invSearch ? 'Try a different search.' : 'Use the button above to add one.'}</div>`;
    return;
  }
  const donorTab = state.invTab === 'donors';
  // Each row is labelled from ITS OWN kind, so a donor sitting in the mixed
  // "On hand" list does not read as a part with empty part-only columns.
  const row = (i) => {
    const donor = i.kind === 'donor_device';
    return `<tr data-item="${i.id}">
      <td data-label="${donor ? 'Donor device' : 'Part'}"><b>${esc(i.name)}</b>
        ${i.part_number ? `<div class="small muted mono">${esc(i.part_number)}</div>` : ''}
        ${i.category ? `<div class="small muted">${esc(i.category)}</div>` : ''}</td>
      <td data-label="${donor ? 'Serial / asset' : 'Fits'}" class="small">${esc(donor
        ? [i.serial, i.asset_tag].filter(Boolean).join(' / ') || '-'
        : i.fits_models || '-')}</td>
      <td data-label="Bin">${esc(i.location || '-')}</td>
      <td data-label="On hand"><b style="${i.out_of_stock ? 'color:var(--danger)' : i.low_stock ? 'color:var(--warn)' : ''}">${esc(i.qty_on_hand)}</b>
        ${i.low_stock ? '<span class="small" style="color:var(--warn)"> low</span>' : ''}</td>
      <td data-label="${donor ? 'Donor status' : 'Reorder at'}" class="small">${esc(donor ? i.donor_status || 'intact' : i.reorder_point || '-')}</td>
      <td class="row-actions">
        <button class="btn ghost sm" data-adj="${i.id}" data-d="1">+1</button>
        <button class="btn ghost sm" data-adj="${i.id}" data-d="-1">&minus;1</button>
        ${donor ? `<button class="btn sm" data-harvest="${i.id}">Harvest</button>` : ''}
        <button class="btn ghost sm" data-edit="${i.id}">Edit</button>
        <button class="btn ghost sm" data-hist="${i.id}">History</button>
      </td>
    </tr>`;
  };
  body.innerHTML = `<table class="bordered"><thead><tr>
      <th>${donorTab ? 'Donor device' : 'Part'}</th><th>${donorTab ? 'Serial / asset' : 'Fits'}</th>
      <th>Bin</th><th>On hand</th><th>${donorTab ? 'Status' : 'Reorder at'}</th><th></th>
    </tr></thead><tbody>${items.map(row).join('')}</tbody></table>`;

  const refresh = () => loadInventoryView(true);
  $$('#inv-body [data-adj]').forEach((b) =>
    b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        await api(`/inventory/${b.dataset.adj}/adjust`, { method: 'POST', body: { delta: Number(b.dataset.d), reason: 'adjust', note: 'counted by hand' } });
        await refresh();
      } catch (err) { toast(err.message, true); b.disabled = false; }
    })
  );
  $$('#inv-body [data-edit]').forEach((b) =>
    b.addEventListener('click', () => openItemForm(items.find((i) => i.id === Number(b.dataset.edit))))
  );
  $$('#inv-body [data-hist]').forEach((b) => b.addEventListener('click', () => showItemHistory(Number(b.dataset.hist))));
  $$('#inv-body [data-harvest]').forEach((b) =>
    b.addEventListener('click', () => openHarvestForm(items.find((i) => i.id === Number(b.dataset.harvest))))
  );
}

function openItemForm(item = null) {
  const donor = item ? item.kind === 'donor_device' : state.invTab === 'donors';
  const cats = (state.meta.inventory && state.meta.inventory.categories) || [];
  const { close } = subOverlay(`<div class="modal">
    <header><h2>${item ? 'Edit' : donor ? 'Add donor device' : 'Add part'}</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="item-cancel">Cancel</button></header>
    <div class="body">
      <div class="row">
        <label class="field" style="flex:2 1 260px"><span>${donor ? 'Device' : 'Part name'}</span>
          <input type="text" id="i-name" value="${esc(item ? item.name : '')}" placeholder="${donor ? 'Lenovo 300e donor' : 'LCD 11.6 30-pin'}"></label>
        ${donor ? '' : `<label class="field"><span>Part number</span><input type="text" id="i-pn" value="${esc(item ? item.part_number || '' : '')}"></label>`}
      </div>
      <div class="row">
        ${donor
          ? `<label class="field"><span>Serial</span><input type="text" id="i-serial" value="${esc(item ? item.serial || '' : '')}"></label>
             <label class="field"><span>Asset tag</span><input type="text" id="i-asset" value="${esc(item ? item.asset_tag || '' : '')}"></label>
             <label class="field"><span>Status</span><select id="i-donor-status">${(state.meta.inventory.donor_statuses || []).map((v) => `<option value="${esc(v)}"${item && item.donor_status === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`
          : `<label class="field"><span>Category</span><select id="i-cat"><option value="">- none -</option>${cats.map((c) => `<option value="${esc(c)}"${item && item.category === c ? ' selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
             <label class="field"><span>Fits which models</span><input type="text" id="i-fits" value="${esc(item ? item.fits_models || '' : '')}" placeholder="Lenovo 300e, 500e"></label>`}
      </div>
      <div class="row">
        <label class="field"><span>Bin / location</span><input type="text" id="i-loc" value="${esc(item ? item.location || '' : '')}" placeholder="Bin A3"></label>
        ${item ? '' : '<label class="field"><span>Count on hand now</span><input type="number" id="i-qty" value="0" min="0"></label>'}
        ${donor ? '' : `<label class="field"><span>Tell me when it drops to</span><input type="number" id="i-reorder" value="${esc(item ? item.reorder_point : 1)}" min="0"></label>`}
      </div>
      <label class="field"><span>Notes</span><textarea id="i-notes" style="min-height:60px;font-family:inherit;font-size:14px">${esc(item ? item.notes || '' : '')}</textarea></label>
      <div id="i-result"></div>
    </div>
    <footer>${item ? `<button class="btn ghost sm danger" id="i-delete">Remove</button><div style="flex:1"></div>` : ''}
      <button class="btn primary" id="i-save">${item ? 'Save' : 'Add'}</button></footer>
  </div>`);
  $('[data-x=item-cancel]').addEventListener('click', close);

  const collect = () => {
    const body = {
      name: $('#i-name').value.trim(),
      location: $('#i-loc').value.trim(),
      notes: $('#i-notes').value.trim(),
      kind: donor ? 'donor_device' : 'part',
    };
    if (donor) {
      body.serial = cleanScan($('#i-serial').value);
      body.asset_tag = cleanScan($('#i-asset').value);
      body.donor_status = $('#i-donor-status').value;
    } else {
      body.part_number = $('#i-pn').value.trim();
      body.category = $('#i-cat').value;
      body.fits_models = $('#i-fits').value.trim();
      body.reorder_point = Number($('#i-reorder').value) || 0;
    }
    if (!item) body.qty_on_hand = Number($('#i-qty').value) || 0;
    return body;
  };

  $('#i-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      if (item) await api('/inventory/' + item.id, { method: 'PATCH', body: collect() });
      else await api('/inventory', { method: 'POST', body: collect() });
      toast(item ? 'Saved' : 'Added to inventory');
      close();
      await loadInventoryView(true);
    } catch (err) {
      $('#i-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
  if ($('#i-delete')) {
    $('#i-delete').addEventListener('click', async () => {
      if (!window.confirm(`Remove ${item.name}? If it has history it is archived instead.`)) return;
      await api('/inventory/' + item.id, { method: 'DELETE' });
      toast('Removed');
      close();
      await loadInventoryView(true);
    });
  }
  if (donor) {
    attachScanner($('#i-asset'), () => {});
    addScanButton($('#i-asset'), () => {});
  }
}

async function showItemHistory(id) {
  const { item, moves } = await api('/inventory/' + id);
  const { close } = subOverlay(`<div class="modal">
    <header><h2>${esc(item.name)}</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="hist-close">Close</button></header>
    <div class="body">
      <p class="small muted" style="margin-top:0">${esc(item.qty_on_hand)} on hand${item.location ? ` in ${esc(item.location)}` : ''}
        ${item.reorder_point ? ` &middot; reorder at ${esc(item.reorder_point)}` : ''}</p>
      ${moves.length
        ? `<table class="bordered"><thead><tr><th>When</th><th>Change</th><th>Why</th><th>Ticket</th><th>Who</th></tr></thead>
           <tbody>${moves.map((m) => `<tr>
             <td class="small" data-label="When">${esc(relTime(m.created_at))}</td>
             <td data-label="Change" style="color:${m.delta < 0 ? 'var(--danger)' : m.delta > 0 ? 'var(--ok)' : 'var(--muted)'}">${m.delta > 0 ? '+' : ''}${esc(m.delta)}</td>
             <td class="small" data-label="Why">${esc(m.reason)}${m.note ? ` &middot; ${esc(m.note)}` : ''}</td>
             <td class="small" data-label="Ticket">${m.ticket_id ? `#${esc(m.ticket_id)}` : '-'}</td>
             <td class="small muted" data-label="Who">${esc(m.author || 'system')}</td></tr>`).join('')}</tbody></table>`
        : '<p class="small muted">No movements yet.</p>'}
    </div></div>`);
  $('[data-x=hist-close]').addEventListener('click', close);
}

function openHarvestForm(donor) {
  // Fetch the parts fresh: the list behind this view is filtered to donors, so
  // it has no parts in it to choose from.
  const { close } = subOverlay(`<div class="modal">
    <header><h2>Harvest from ${esc(donor.asset_tag || donor.name)}</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="h-cancel">Cancel</button></header>
    <div class="body">
      <label class="field"><span>What did you take?</span>
        <input type="text" id="h-what" placeholder="LCD panel, keyboard, hinge set"></label>
      <div class="row">
        <label class="field"><span>Add it to this part's count (optional)</span>
          <select id="h-part"><option value="">- do not add to stock -</option></select></label>
        <label class="field" style="flex:0 1 120px"><span>How many</span><input type="number" id="h-qty" value="1" min="1"></label>
      </div>
      <label class="field"><span>For which ticket (optional)</span><input type="number" id="h-ticket" placeholder="142"></label>
      <label class="check"><input type="checkbox" id="h-exhausted"> This donor is stripped &mdash; nothing useful left</label>
      <div id="h-result"></div>
    </div>
    <footer><button class="btn primary" id="h-save">Record harvest</button></footer>
  </div>`);
  $('[data-x=h-cancel]').addEventListener('click', close);

  api('/inventory?kind=part')
    .then(({ items }) => {
      const select = $('#h-part');
      if (!select) return;
      select.innerHTML = '<option value="">- do not add to stock -</option>' +
        items.map((p) => `<option value="${p.id}">${esc(p.label)} (${p.qty_on_hand} on hand)</option>`).join('');
    })
    .catch(() => {});

  $('#h-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api(`/inventory/${donor.id}/harvest`, {
        method: 'POST',
        body: {
          what: $('#h-what').value.trim(),
          part_item_id: $('#h-part').value ? Number($('#h-part').value) : null,
          qty: Number($('#h-qty').value) || 1,
          ticket_id: $('#h-ticket').value ? Number($('#h-ticket').value) : null,
          exhausted: $('#h-exhausted').checked,
        },
      });
      toast('Harvest recorded');
      close();
      await loadInventoryView(true);
    } catch (err) {
      $('#h-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- incoming parts
const SHIP_BADGE = {
  ordered: 'var(--muted)', shipped: 'var(--accent)', delivered: '#7c3aed',
  delayed: 'var(--warn)', arrived: 'var(--ok)', cancelled: 'var(--muted)',
};

function renderShipments() {
  const list = state.shipData.shipments;
  const body = $('#inv-body');
  if (!list.length) {
    body.innerHTML = '<div class="empty">Nothing on order. Use "New shipment" when you order parts.</div>';
    return;
  }
  body.innerHTML = list.map((s) => `<div class="card" data-ship="${s.id}" style="${s.late ? 'border-left:3px solid var(--danger)' : s.due_today ? 'border-left:3px solid var(--warn)' : ''}">
    <div class="row" style="align-items:flex-start">
      <div style="flex:2 1 260px">
        <div><span class="pill" style="background:${SHIP_BADGE[s.status] || 'var(--muted)'}">${esc(s.status)}</span>
          <b style="margin-left:8px">${esc(s.vendor || 'Parts order')}</b>
          ${s.late ? '<span class="small" style="color:var(--danger);margin-left:8px">late</span>' : s.due_today ? '<span class="small" style="color:var(--warn);margin-left:8px">due today</span>' : ''}</div>
        <div class="small muted" style="margin-top:4px">
          ${s.expected_day ? `Expected ${esc(s.expected_label)}${s.carrier_eta_day === s.expected_day ? ' (from the carrier)' : ''}` : 'No expected date yet'}
          ${s.tracking_number ? ` &middot; ${s.tracking_url ? `<a href="${esc(s.tracking_url)}" target="_blank" rel="noreferrer">${esc(s.carrier || 'track')} ${esc(s.tracking_number)}</a>` : esc(s.tracking_number)}` : ''}
          ${s.tracking_label ? ` &middot; <b>${esc(s.tracking_label)}</b>` : ''}
          ${s.tracking_polled_at ? ` &middot; checked ${esc(relTime(s.tracking_polled_at))}` : ''}
        </div>
        ${s.delivered_not_received ? '<div class="warn-line" style="margin-top:8px">Carrier says delivered, but nobody has checked it in yet.</div>' : ''}
        ${s.tracking_error ? `<div class="result-line err" style="margin-top:8px">Tracking: ${esc(s.tracking_error)}</div>` : ''}
        ${(s.tracking_events || []).length
          ? `<details style="margin-top:8px"><summary class="small muted" style="cursor:pointer">${esc(s.tracking_events.length)} carrier scans</summary>
              <ul class="small muted" style="margin:6px 0 0;padding-left:18px">${s.tracking_events.slice(0, 8).map((e) => `<li>${esc(e.description || e.status)}${e.location ? ` &mdash; ${esc(e.location)}` : ''}
                <span style="opacity:.7">${esc(e.happened_at ? relTime(e.happened_at) : '')}</span></li>`).join('')}</ul></details>`
          : ''}
      </div>
      <div class="row-actions" style="flex:1 1 auto;text-align:right">
        ${s.status === 'ordered' ? `<button class="btn sm" data-shipped="${s.id}">Mark shipped</button>` : ''}
        ${s.open ? `<button class="btn sm" data-receive="${s.id}">Receive</button>` : ''}
        ${s.tracking_number && s.open && state.meta.tracking && state.meta.tracking.enabled
          ? `<button class="btn ghost sm" data-track="${s.id}">Refresh tracking</button>` : ''}
        <button class="btn ghost sm" data-ship-edit="${s.id}">Edit</button>
      </div>
    </div>
    <table style="margin-top:10px"><tbody>${s.lines.map((l) => `<tr>
      <td data-label="Item">${esc(l.description || l.item_name || 'part')}${l.part_number ? ` <span class="small muted mono">${esc(l.part_number)}</span>` : ''}</td>
      <td data-label="Qty" style="width:90px">${esc(l.qty)}${l.received_qty ? ` <span class="small muted">(${esc(l.received_qty)} in)</span>` : ''}</td>
      <td data-label="For" style="width:220px">${l.ticket_id
        ? `<a href="#" data-goto-ticket="${l.ticket_id}">#${esc(l.ticket_id)}</a> <span class="small muted">${esc(l.user_name || l.user_email || '')}</span>`
        : '<span class="small muted">stock</span>'}</td>
    </tr>`).join('')}</tbody></table>
    ${s.notes ? `<p class="small muted" style="margin:8px 0 0">${esc(s.notes)}</p>` : ''}
    ${s.ticket_ids.length ? `<p class="small muted" style="margin:6px 0 0">Students told: ${esc(s.notices.length ? [...new Set(s.notices.map((n) => n.kind.replace(/_/g, ' ')))].join(', ') : 'nothing yet')}</p>` : ''}
  </div>`).join('');

  $$('#inv-body [data-shipped]').forEach((b) => b.addEventListener('click', () => openShippedForm(list.find((s) => s.id === Number(b.dataset.shipped)))));
  $$('#inv-body [data-receive]').forEach((b) => b.addEventListener('click', () => openReceiveForm(list.find((s) => s.id === Number(b.dataset.receive)))));
  $$('#inv-body [data-ship-edit]').forEach((b) => b.addEventListener('click', () => openShipmentForm(list.find((s) => s.id === Number(b.dataset.shipEdit)))));
  $$('#inv-body [data-track]').forEach((b) =>
    b.addEventListener('click', (e) =>
      busyish(e.target, async () => {
        const res = await api(`/shipments/${b.dataset.track}/track`, { method: 'POST' });
        toast(res.result === 'ok'
          ? `${res.new_events || 0} new scan${res.new_events === 1 ? '' : 's'}${res.to !== res.from ? ` - now ${res.to}` : ''}`
          : `No update (${res.reason || res.error})`, res.result === 'error');
        await loadInventoryView(true);
      })
    )
  );
  $$('#inv-body [data-goto-ticket]').forEach((a) =>
    a.addEventListener('click', (e) => { e.preventDefault(); openTicket(Number(a.dataset.gotoTicket)); })
  );
}

function openShipmentForm(shipment = null) {
  const { close } = subOverlay(`<div class="modal">
    <header><h2>${shipment ? 'Edit shipment' : 'New shipment'}</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="s-cancel">Cancel</button></header>
    <div class="body">
      <div class="row">
        <label class="field"><span>Vendor</span><input type="text" id="s-vendor" value="${esc(shipment ? shipment.vendor || '' : '')}" placeholder="PartsPeople"></label>
        <label class="field" style="flex:2 1 240px"><span>Tracking number (carrier is detected)</span>
          <input type="text" id="s-tracking" value="${esc(shipment ? shipment.tracking_number || '' : '')}" placeholder="1Z..."></label>
      </div>
      <div class="row">
        <label class="field"><span>Expected day</span><input type="date" id="s-expected" value="${esc(shipment ? shipment.expected_day || '' : '')}"></label>
        <label class="field"><span>Status</span>
          <select id="s-status">${(state.meta.shipment_statuses || []).map((v) => `<option value="${esc(v)}"${shipment && shipment.status === v ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <label class="field"><span>Notes (internal)</span><textarea id="s-notes" style="min-height:50px;font-family:inherit;font-size:14px">${esc(shipment ? shipment.notes || '' : '')}</textarea></label>

      <h2 style="font-size:14px;margin:18px 0 8px">What is in it</h2>
      <div id="s-lines"></div>
      <div class="row" style="align-items:flex-end">
        <label class="field" style="flex:2 1 200px"><span>Part or description</span>
          <input type="text" id="s-line-desc" placeholder="LCD 11.6 30-pin" list="s-line-items"></label>
        <label class="field" style="flex:0 1 90px"><span>Qty</span><input type="number" id="s-line-qty" value="1" min="1"></label>
        <label class="field" style="flex:0 1 130px"><span>For ticket</span><input type="number" id="s-line-ticket" placeholder="142"></label>
        <button class="btn sm" id="s-line-add" style="flex:0 0 auto;margin-bottom:12px">Add line</button>
      </div>
      <datalist id="s-line-items"></datalist>
      <div id="s-result"></div>
    </div>
    <footer>${shipment ? `<button class="btn ghost sm danger" id="s-delete">Delete</button><div style="flex:1"></div>` : ''}
      <button class="btn primary" id="s-save">${shipment ? 'Save' : 'Create shipment'}</button></footer>
  </div>`);
  $('[data-x=s-cancel]').addEventListener('click', close);
  attachScanner($('#s-tracking'), () => {});
  addScanButton($('#s-tracking'), () => {});

  // inventory items for the datalist, so a line can point at a real part
  let items = [];
  api('/inventory?kind=part').then(({ items: rows }) => {
    items = rows;
    $('#s-line-items').innerHTML = rows.map((i) => `<option value="${esc(i.label)}">`).join('');
  }).catch(() => {});

  let pending = [];
  const renderLines = () => {
    const existing = shipment ? shipment.lines : [];
    $('#s-lines').innerHTML = [...existing, ...pending].length
      ? `<table class="bordered"><tbody>${[...existing.map((l) => ({ ...l, saved: true })), ...pending].map((l, idx) => `<tr>
          <td data-label="Item">${esc(l.description || l.item_name || '')}</td>
          <td data-label="Qty" style="width:70px">${esc(l.qty)}</td>
          <td data-label="Ticket" style="width:90px">${l.ticket_id ? '#' + esc(l.ticket_id) : 'stock'}</td>
          <td style="width:60px">${l.saved
            ? `<button class="btn ghost sm" data-del-line="${l.id}">remove</button>`
            : `<button class="btn ghost sm" data-del-pending="${idx - existing.length}">remove</button>`}</td>
        </tr>`).join('')}</tbody></table>`
      : '<p class="small muted">No lines yet.</p>';

    $$('#s-lines [data-del-pending]').forEach((b) =>
      b.addEventListener('click', () => { pending.splice(Number(b.dataset.delPending), 1); renderLines(); })
    );
    $$('#s-lines [data-del-line]').forEach((b) =>
      b.addEventListener('click', async () => {
        await api(`/shipments/${shipment.id}/lines/${b.dataset.delLine}`, { method: 'DELETE' });
        toast('Line removed');
        close();
        await loadInventoryView(true);
      })
    );
  };
  renderLines();

  $('#s-line-add').addEventListener('click', () => {
    const text = $('#s-line-desc').value.trim();
    if (!text) return;
    const match = items.find((i) => i.label === text || i.name === text);
    const line = {
      item_id: match ? match.id : null,
      description: match ? null : text,
      item_name: match ? match.label : null,
      qty: Number($('#s-line-qty').value) || 1,
      ticket_id: $('#s-line-ticket').value ? Number($('#s-line-ticket').value) : null,
    };
    if (shipment) {
      api(`/shipments/${shipment.id}/lines`, { method: 'POST', body: line })
        .then(() => { toast('Line added'); close(); loadInventoryView(true); })
        .catch((err) => toast(err.message, true));
      return;
    }
    pending.push(line);
    $('#s-line-desc').value = '';
    $('#s-line-qty').value = '1';
    renderLines();
  });

  $('#s-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    const body = {
      vendor: $('#s-vendor').value.trim(),
      tracking_number: cleanScan($('#s-tracking').value),
      expected_day: $('#s-expected').value || null,
      status: $('#s-status').value,
      notes: $('#s-notes').value.trim(),
    };
    try {
      if (shipment) await api('/shipments/' + shipment.id, { method: 'PATCH', body });
      else await api('/shipments', { method: 'POST', body: { ...body, lines: pending } });
      toast(shipment ? 'Shipment saved' : 'Shipment created');
      close();
      await loadInventoryView(true);
    } catch (err) {
      $('#s-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
  if ($('#s-delete')) {
    $('#s-delete').addEventListener('click', async () => {
      if (!window.confirm('Delete this shipment? Lines and notices go with it.')) return;
      await api('/shipments/' + shipment.id, { method: 'DELETE' });
      toast('Deleted');
      close();
      await loadInventoryView(true);
    });
  }
}

function openShippedForm(shipment) {
  const waiting = shipment.ticket_ids.length;
  const { close } = subOverlay(`<div class="modal" style="width:min(520px,calc(100% - 32px))">
    <header><h2>Mark shipped</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="sh-cancel">Cancel</button></header>
    <div class="body">
      <label class="field"><span>Expected day</span><input type="date" id="sh-expected" value="${esc(shipment.expected_day || '')}"></label>
      <label class="check"><input type="checkbox" id="sh-notify" ${waiting ? 'checked' : 'disabled'}>
        Email the ${esc(waiting)} student${waiting === 1 ? '' : 's'} waiting on this${waiting ? '' : ' (no tickets linked)'}</label>
      <p class="small muted">They are told the day to expect it &mdash; never the carrier or tracking number.</p>
      <div id="sh-result"></div>
    </div>
    <footer><button class="btn primary" id="sh-save">Mark shipped</button></footer>
  </div>`);
  $('[data-x=sh-cancel]').addEventListener('click', close);
  $('#sh-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const res = await api(`/shipments/${shipment.id}/shipped`, {
        method: 'POST',
        body: { expected_day: $('#sh-expected').value || null, notify: $('#sh-notify').checked },
      });
      toast(`Marked shipped${res.notices.sent.length ? `, ${res.notices.sent.length} student(s) emailed` : ''}`);
      close();
      await loadInventoryView(true);
    } catch (err) {
      $('#sh-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}

function openReceiveForm(shipment) {
  const { close } = subOverlay(`<div class="modal">
    <header><h2>Receive ${esc(shipment.vendor || 'shipment')}</h2><div style="flex:1"></div>
      <button class="btn ghost sm" data-x="rc-cancel">Cancel</button></header>
    <div class="body">
      <p class="small muted" style="margin-top:0">Counts go straight onto the shelf. Change a number if the box came short.</p>
      <table class="bordered"><tbody>${shipment.lines.map((l) => `<tr>
        <td data-label="Item">${esc(l.description || l.item_name || 'part')}
          ${l.item_id ? '' : '<div class="small muted">not an inventory item - nothing to add to stock</div>'}</td>
        <td data-label="Ordered" style="width:90px">${esc(l.qty)}</td>
        <td data-label="Arrived" style="width:110px"><input type="number" data-line="${l.id}" value="${esc(l.qty)}" min="0"></td>
      </tr>`).join('')}</tbody></table>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="rc-notify" ${shipment.ticket_ids.length ? 'checked' : 'disabled'}>
        Email the ${esc(shipment.ticket_ids.length)} student${shipment.ticket_ids.length === 1 ? '' : 's'} that their parts are here</label>
      <div id="rc-result"></div>
    </div>
    <footer><button class="btn primary" id="rc-save">Receive into stock</button></footer>
  </div>`);
  $('[data-x=rc-cancel]').addEventListener('click', close);
  $('#rc-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      const lines = $$('#overlays [data-line]').map((input) => ({ id: Number(input.dataset.line), received_qty: Number(input.value) || 0 }));
      const res = await api(`/shipments/${shipment.id}/receive`, { method: 'POST', body: { lines, notify: $('#rc-notify').checked } });
      toast(`Received${res.notices.sent.length ? `, ${res.notices.sent.length} student(s) emailed` : ''}`);
      close();
      state.invData = null;
      await loadInventoryView(true);
    } catch (err) {
      $('#rc-result').innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
      e.target.disabled = false;
    }
  });
}

// ---------------------------------------------------------------- installable app
function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // Only over https or localhost - browsers refuse otherwise, and that is fine.
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// ---------------------------------------------------------------- settings
async function loadSettings() {
  const g = await api('/google/status');
  state.meta.google = g;
  renderGoogleState(g);
  const panel = $('#google-panel');
  if (!g.configured) {
    panel.innerHTML = `<div class="result-line err">GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET are missing from <span class="mono">.env</span>.</div>
      <p class="small muted">Create an OAuth client (type: Web application) in Google Cloud Console, add
      <span class="mono">${esc(g.redirectUri)}</span> as an authorized redirect URI, then put the id and secret in
      <span class="mono">.env</span> and restart. Full steps are in README.md.</p>`;
  } else if (g.connected) {
    panel.innerHTML = `<p>Connected as <b>${esc(g.email || 'unknown')}</b> <span class="small muted">since ${esc(fullTime(g.connectedAt))}</span></p>
      <p class="small muted">Scopes: ${esc(g.scopes.map((s) => s.split('/').pop()).join(', '))}</p>
      <button class="btn" id="g-reconnect">Reconnect</button>
      <button class="btn ghost sm danger" id="g-disconnect">Disconnect</button>`;
    $('#g-disconnect').addEventListener('click', async () => {
      if (!window.confirm('Disconnect Google? Device lookups and emails will stop working until you reconnect.')) return;
      await api('/google/disconnect', { method: 'POST' });
      loadSettings();
    });
    $('#g-reconnect').addEventListener('click', connectGoogle);
  } else {
    panel.innerHTML = `<p class="small muted">Sign in with a Workspace admin account that can read ChromeOS devices and send mail.</p>
      <button class="btn primary" id="g-connect">Connect Google</button>
      <p class="small muted" style="margin-bottom:0">Redirect URI in use: <span class="mono">${esc(g.redirectUri)}</span></p>`;
    $('#g-connect').addEventListener('click', connectGoogle);
  }
  await loadTemplates();
  renderTrackingPanel();
  await loadBackups();
  renderPublicSitePanel();
  await loadOptouts();
  await loadEmailLog();
}

// ---------------------------------------------------------------- backups
async function loadBackups() {
  const box = $('#backup-panel');
  try {
    const { status, history } = await api('/backups');
    const last = status.last;
    const lastLine = !last
      ? '<span class="muted">No backup has run yet.</span>'
      : `<span style="color:${last.result === 'ok' ? 'var(--ok)' : 'var(--danger)'}">${last.result === 'ok' ? 'Last backup OK' : 'Last backup FAILED'}</span>
         &middot; ${esc(relTime(last.created_at))}${last.bytes ? ` &middot; ${(last.bytes / 1048576).toFixed(2)} MB` : ''}
         ${last.error ? `<div class="result-line err" style="margin-top:8px">${esc(last.error)}</div>` : ''}
         ${last.path ? `<div class="small muted mono">${esc(last.path)}</div>` : ''}`;
    const t = status.target || {};
    const targetLine = t.dir
      ? `<div class="small muted" style="margin-top:6px">Target <span class="mono">${esc(t.dir)}</span> &middot;
           ${t.exists ? 'exists' : '<b style="color:var(--danger)">missing</b>'} &middot;
           ${t.writable ? 'writable' : '<b style="color:var(--danger)">not writable</b>'} &middot;
           ${t.is_mount ? 'a mounted share' : '<b style="color:var(--warn)">not a mount point</b>'} &middot;
           ${t.files == null ? '' : `${esc(t.files)} backup file${t.files === 1 ? '' : 's'} visible`}
           ${t.free_mb != null ? ` &middot; ${esc((t.free_mb / 1024).toFixed(1))} GB free` : ''}</div>
         ${t.problem ? `<div class="result-line err">${esc(t.problem)}</div>` : ''}
         ${t.warning ? `<div class="result-line err">${esc(t.warning)}</div>` : ''}`
      : '';
    box.innerHTML = `
      ${status.enabled
        ? `<p style="margin-top:0">Runs every day at <b>${esc(status.at)}</b> to <span class="mono">${esc(status.dir)}</span>,
           keeping ${esc(status.keep_days)} days${status.gzip ? ', gzipped' : ''}.
           <span class="small muted">Next run ${esc(fullTime(status.next_run))}.</span></p>`
        : `<div class="result-line info">Nightly backups are off. Set <span class="mono">BACKUP_DIR</span> in
           <span class="mono">.env</span> to your NAS mount (and leave <span class="mono">BACKUP_ENABLED=true</span>).</div>`}
      ${targetLine}
      <p style="margin-bottom:8px">${lastLine}</p>
      <button class="btn" id="backup-now">Back up now</button>
      ${history.length > 1
        ? `<details style="margin-top:12px"><summary class="small muted" style="cursor:pointer">Recent runs</summary>
           <table class="bordered" style="margin-top:8px"><tbody>${history
             .map((h) => `<tr><td class="small">${esc(relTime(h.created_at))}</td>
               <td class="small" style="color:${h.result === 'ok' ? 'var(--ok)' : 'var(--danger)'}">${esc(h.result)}</td>
               <td class="small mono">${esc(h.path || h.error || '')}</td></tr>`)
             .join('')}</tbody></table></details>`
        : ''}`;
    $('#backup-now').addEventListener('click', async (e) => {
      e.target.disabled = true;
      e.target.textContent = 'Backing up…';
      try {
        const res = await api('/backups/run', { method: 'POST' });
        toast(res.result === 'ok' ? `Backup written (${(res.bytes / 1048576).toFixed(2)} MB)` : 'Backup failed', res.result !== 'ok');
      } catch (err) {
        toast(err.message, true);
      } finally {
        loadBackups();
      }
    });
  } catch (err) {
    box.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

// ---------------------------------------------------------------- public site
function renderPublicSitePanel() {
  const ps = (state.meta && state.meta.public_site) || {};
  const box = $('#public-site-panel');
  if (!ps.enabled) {
    box.innerHTML = '<div class="result-line info">The public site is turned off (<span class="mono">PUBLIC_SITE_ENABLED=false</span>).</div>';
    return;
  }
  box.innerHTML = ps.url
    ? `<p style="margin-top:0">Serving on port <b>${esc(ps.port)}</b>, published as
       <a href="${esc(ps.url)}" target="_blank" rel="noreferrer">${esc(ps.url)}</a>.
       Google sign-in ${ps.google_signin ? 'enabled' : 'off'} &middot; asset tag lookup ${ps.allow_lookup ? 'enabled' : 'off'}.</p>
       <p class="small muted" style="margin-bottom:0">Status and preference links are included in every email.
       To embed in Google Sites, insert an Embed &rarr; By URL pointing at ${esc(ps.url)}.</p>`
    : `<div class="result-line info">Running on port ${esc(ps.port)}, but <span class="mono">PUBLIC_SITE_URL</span> is not set,
       so emails cannot include status or unsubscribe links yet.</div>`;
}

// ---------------------------------------------------------------- tracking
function renderTrackingPanel() {
  const box = $('#tracking-panel');
  if (!box) return;
  const t = (state.meta && state.meta.tracking) || {};
  box.innerHTML = t.enabled
    ? `<p style="margin-top:0">Provider <b>${esc(t.provider)}</b> &middot; every ${esc(t.poll_minutes)} minutes
         between ${esc(t.active_hours)} &middot; watching ${esc(t.watching)} shipment${t.watching === 1 ? '' : 's'}.
         ${t.last_polled_at ? `Last check ${esc(relTime(t.last_polled_at))}.` : 'No check yet.'}</p>
       ${t.with_errors ? `<div class="result-line err">${esc(t.with_errors)} shipment(s) have a tracking error - see the Incoming parts tab.</div>` : ''}
       <p class="small muted">Carrier movements update the shipment and the student's progress page. They never send
         email: the only parts emails are the ones you trigger and the 8am "expected today" note.</p>
       <button class="btn" id="tracking-poll">Check all tracking now</button>`
    : `<div class="result-line info">Automatic tracking is off. Set <span class="mono">TRACKING_API_KEY</span>
         (and optionally <span class="mono">TRACKING_PROVIDER</span>) in <span class="mono">.env</span> to turn it on;
         shipment statuses stay manual until then.</div>`;
  if ($('#tracking-poll')) {
    $('#tracking-poll').addEventListener('click', (e) =>
      busyish(e.target, async () => {
        const res = await api('/tracking/poll', { method: 'POST' });
        toast(`Checked ${res.checked}, updated ${res.updated.length}${res.errors.length ? `, ${res.errors.length} failed` : ''}`, res.errors.length > 0);
        state.meta.tracking = (await api('/tracking')).tracking;
        renderTrackingPanel();
      })
    );
  }
}

// ---------------------------------------------------------------- optouts
async function loadOptouts() {
  const box = $('#optout-panel');
  try {
    const { optouts } = await api('/optouts');
    box.innerHTML = optouts.length
      ? `<table class="bordered"><thead><tr><th>Address</th><th>When</th><th>Source</th><th></th></tr></thead><tbody>${optouts
          .map((o) => `<tr><td class="small">${esc(o.email)}</td><td class="small">${esc(relTime(o.created_at))}</td>
            <td class="small muted">${esc(o.source || '')}</td>
            <td><button class="btn ghost sm" data-resub="${esc(o.email)}">Resubscribe</button></td></tr>`)
          .join('')}</tbody></table>`
      : '<p class="small muted">Nobody has unsubscribed.</p>';
    $$('[data-resub]', box).forEach((b) =>
      b.addEventListener('click', async () => {
        await api('/optouts', { method: 'POST', body: { email: b.dataset.resub, action: 'in' } });
        toast('Resubscribed ' + b.dataset.resub);
        loadOptouts();
      })
    );
  } catch (err) {
    box.innerHTML = `<div class="result-line err">${esc(err.message)}</div>`;
  }
}

async function connectGoogle() {
  const { url } = await api('/google/auth-url');
  const win = window.open(url, '_blank');
  if (!win) { location.href = url; return; }
  toast('Finish the Google sign-in in the new tab, then come back.');
  const poll = setInterval(async () => {
    const g = await api('/google/status');
    if (g.connected) { clearInterval(poll); loadSettings(); toast('Google connected'); }
  }, 2500);
  setTimeout(() => clearInterval(poll), 180000);
}

async function loadTemplates() {
  state.templates = (await api('/templates')).templates;
  $('#tpl-list').innerHTML = state.meta.statuses
    .map((s) => {
      const t = templateFor(s.key);
      if (!t) return '';
      return `<button data-key="${esc(s.key)}" class="${state.activeTemplate === s.key ? 'active' : ''}">${esc(s.label)}
        <div class="small muted">${t.auto_send ? 'auto-sends' : 'manual only'}</div></button>`;
    })
    .join('');
  $$('#tpl-list button').forEach((b) =>
    b.addEventListener('click', () => { state.activeTemplate = b.dataset.key; loadTemplates(); })
  );
  const reset = $('#tpl-reset');
  if (reset && !reset.dataset.wired) {
    reset.dataset.wired = '1';
    reset.addEventListener('click', async () => {
      if (!window.confirm('Replace all email wording with the shipped school templates? Any edits you made will be lost.')) return;
      reset.disabled = true;
      try {
        const res = await api('/templates/reset', { method: 'POST', body: {} });
        toast(`Reset ${res.changed} templates`);
        await loadTemplates();
      } catch (err) {
        toast(err.message, true);
      } finally {
        reset.disabled = false;
      }
    });
  }
  renderTemplateEditor();
}

function renderTemplateEditor() {
  const t = templateFor(state.activeTemplate);
  const box = $('#tpl-editor');
  if (!t) { box.innerHTML = '<p class="small muted">Pick a status.</p>'; return; }
  box.innerHTML = `
    <label class="field"><span>Subject</span><input type="text" id="t-subject" value="${esc(t.subject)}"></label>
    <label class="field"><span>Body (HTML)</span><textarea id="t-body" style="min-height:220px">${esc(t.body)}</textarea></label>
    <div class="row" style="align-items:center">
      <label class="check" style="flex:1 1 auto"><input type="checkbox" id="t-auto" ${t.auto_send ? 'checked' : ''}>
        Send automatically when a ticket moves to "${esc(statusMeta(t.status_key).label)}"</label>
      <button class="btn primary" id="t-save" style="flex:0 0 auto">Save template</button>
    </div>
    <div class="small muted" style="margin-top:10px">Live preview (placeholders shown as-is)</div>
    <div class="preview-frame" id="t-preview">${t.body}</div>`;
  const sync = () => { $('#t-preview').innerHTML = $('#t-body').value; };
  $('#t-body').addEventListener('input', sync);
  $('#t-save').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await api('/templates/' + t.status_key, {
        method: 'PUT',
        body: { subject: $('#t-subject').value, body: $('#t-body').value, auto_send: $('#t-auto').checked },
      });
      toast('Template saved');
      await loadTemplates();
    } catch (err) {
      toast(err.message, true);
    } finally {
      e.target.disabled = false;
    }
  });
}

async function loadEmailLog() {
  const { emails } = await api('/emails?limit=100');
  $('#email-log').innerHTML = emails.length
    ? `<table class="bordered"><thead><tr><th>When</th><th>Ticket</th><th>To</th><th>Subject</th><th>Result</th></tr></thead>
       <tbody>${emails
         .map(
           (e) => `<tr class="clickable" data-email="${e.id}">
        <td class="small">${esc(relTime(e.created_at))}</td>
        <td class="small">${e.ticket_id ? '#' + e.ticket_id : '-'}</td>
        <td class="small">${esc(e.to_email)}</td>
        <td class="small">${esc(e.subject || '')}</td>
        <td class="small" style="color:${e.result === 'sent' ? 'var(--ok)' : e.result === 'error' ? 'var(--danger)' : 'var(--muted)'}">${esc(e.result)}</td></tr>`
         )
         .join('')}</tbody></table>`
    : '<p class="small muted">No emails yet.</p>';
  $$('#email-log [data-email]').forEach((tr) => tr.addEventListener('click', () => showEmail(tr.dataset.email)));
}

// ---------------------------------------------------------------- go
boot().catch((err) => {
  document.body.innerHTML = `<div style="max-width:520px;margin:12vh auto;font-family:system-ui;padding:0 20px">
    <h1 style="font-size:20px">Repair Tickets could not start</h1>
    <p style="color:#b91c1c">${esc(err.message)}</p>
    <p><a href="/">Try again</a></p></div>`;
});
