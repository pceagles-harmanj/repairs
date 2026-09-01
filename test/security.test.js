'use strict';
/** Regressions for the hardening pass: header injection, XSS, OAuth state, input validation. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { isolate, startServer } = require('./helpers');

isolate();

const google = require('../src/google');
const mailer = require('../src/mailer');

let srv;
test.before(async () => { srv = await startServer(); });
test.after(async () => { await srv.close(); });

const ticket = () => ({
  serial: '5CD1234ABC', model: 'Lenovo 300e', user_email: 'sam@example.org', user_name: 'Sam Smith',
  issue_description: "Won't charge; screen <cracked>", notify: false,
});

test('a CRLF in the subject cannot inject a mail header', () => {
  const raw = google.buildRawMessage({
    from: 'it@example.org', to: 'sam@example.org',
    subject: 'Ticket #1\r\nBcc: exfil@evil.example\r\nX-Evil: yes',
    html: '<p>hi</p>',
  });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  const headerBlock = decoded.split('\r\n\r\n')[0];
  assert.ok(!/^Bcc:/im.test(headerBlock), headerBlock);
  assert.ok(!/^X-Evil:/im.test(headerBlock), headerBlock);
  assert.match(headerBlock, /^Subject: Ticket #1 Bcc: exfil@evil\.example X-Evil: yes$/m);
});

test('a CRLF in the recipient cannot inject a mail header', () => {
  const raw = google.buildRawMessage({ from: 'it@example.org', to: 'a@b.org\r\nBcc: evil@x.org', subject: 'x', html: '<p>x</p>' });
  const decoded = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  assert.ok(!/^Bcc:/im.test(decoded.split('\r\n\r\n')[0]));
});

test('the plain-text part is readable: entities decoded, table rows separated', () => {
  const text = google.htmlToText(`<div><p>Hi Sam,</p><table><tr><td>Serial</td><td>5CD&amp;1</td></tr>
    <tr><td>Issue</td><td>Won&#39;t charge; screen &lt;cracked&gt;</td></tr></table><p>Thanks &mdash; IT</p></div>`);
  assert.ok(!/&#39;|&lt;|&gt;|&amp;|&mdash;/.test(text), text);
  assert.match(text, /Won't charge; screen <cracked>/);
  assert.match(text, /Serial: 5CD&1/);
  assert.match(text, /Thanks - IT/);
});

test('the OAuth callback refuses a code with no matching state', async () => {
  const res = await fetch(srv.base + '/oauth2/callback?code=attacker-code');
  assert.equal(res.status, 400);
  assert.match(await res.text(), /no longer valid/i);
});

test('the OAuth callback refuses a stale/forged state', async () => {
  const res = await fetch(srv.base + '/oauth2/callback?code=x&state=guessed');
  assert.equal(res.status, 400);
});

test('the OAuth error page escapes what Google sends back', async () => {
  const res = await fetch(srv.base + '/oauth2/callback?error=' + encodeURIComponent('<script>alert(1)</script>'));
  const html = await res.text();
  assert.ok(!html.includes('<script>alert(1)</script>'), html);
  assert.ok(html.includes('&lt;script&gt;'));
});

test('an edited subject alone still sends the edited subject', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: ticket() });
  const id = created.ticket.id;
  const res = await srv.call(`/api/tickets/${id}/email/send`, { method: 'POST', body: { subject: 'CUSTOM {{first_name}}', body: '' } });
  assert.equal(res.body.result, 'dry_run');
  assert.equal(res.body.subject, 'CUSTOM Sam');
  const detail = (await srv.call('/api/tickets/' + id)).body.ticket;
  const full = (await srv.call('/api/emails/' + detail.emails[0].id)).body.email;
  assert.equal(full.subject, 'CUSTOM Sam');
  assert.ok(full.body.includes('we have it') || full.body.includes('Sam'), 'template body kept');
});

test('preview and send agree on which text wins', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: ticket() });
  const id = created.ticket.id;
  const args = { subject: 'S {{ticket_number}}', body: '' };
  const p = (await srv.call(`/api/tickets/${id}/email/preview`, { method: 'POST', body: args })).body.preview;
  const s = (await srv.call(`/api/tickets/${id}/email/send`, { method: 'POST', body: args })).body;
  assert.equal(p.subject, s.subject);
  assert.ok(p.body.length > 0);
});

test('sending on a ticket with no user email is a 400, not a silent skip', async () => {
  const { body: created } = await srv.call('/api/tickets', { method: 'POST', body: { ...ticket(), user_email: undefined } });
  const res = await srv.call(`/api/tickets/${created.ticket.id}/email/send`, { method: 'POST', body: {} });
  assert.equal(res.status, 400);
});

test('a null template field is rejected with 400 instead of a database error', async () => {
  const res = await srv.call('/api/templates/closed', { method: 'PUT', body: { subject: null, body: null } });
  assert.equal(res.status, 400);
  const blank = await srv.call('/api/templates/closed', { method: 'PUT', body: { subject: '   ' } });
  assert.equal(blank.status, 400);
  const still = (await srv.call('/api/templates')).body.templates.find((t) => t.status_key === 'closed');
  assert.ok(still.subject.trim().length > 0);
});

test('a repeated query parameter does not blow up the list endpoint', async () => {
  const res = await srv.call('/api/tickets?assignee=a&assignee=b&status=all&q=x&q=y');
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(res.body.tickets));
});

test('mailer.compose returns null only when there is nothing at all to send', () => {
  const t = { id: 1, status: 'nonexistent_status', priority: 'normal', user_email: 'a@b.org', issue_description: 'x' };
  assert.equal(mailer.compose(t, 'nonexistent_status', {}), null);
  const custom = mailer.compose(t, 'nonexistent_status', { subject: 'Hi', body: '<p>Yo {{first_name}}</p>' });
  assert.equal(custom.subject, 'Hi');
  assert.match(custom.body, /Yo A/);
});
