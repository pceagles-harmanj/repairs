'use strict';
/**
 * The http listener that exists only for links already sitting in inboxes.
 * Its one hard rule: never redirect to a host the request asked for.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const { isolate } = require('./helpers');

isolate();
const server = require('../src/server');

const listenOn = (target) =>
  new Promise((resolve) => {
    const s = server.redirectToHttps({ port: 0, host: '127.0.0.1', target, label: 'test' });
    s.on('listening', () => resolve(s));
  });

const get = (port, path, headers = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode, location: res.headers.location, cache: res.headers['cache-control'] });
    });
    req.on('error', reject);
    req.end();
  });

test('an old http magic link is sent to the same path on https', async () => {
  const s = await listenOn('https://repairs.internal.pceagles.org');
  const { port } = s.address();
  const res = await get(port, '/t/abc123def?from=email');

  assert.equal(res.status, 302);
  assert.equal(res.location, 'https://repairs.internal.pceagles.org/t/abc123def?from=email');
  // A permanent redirect would be cached past any decision to roll back.
  assert.equal(res.cache, 'no-store');
  s.close();
});

test('a forged Host header cannot bounce a magic link to another site', async () => {
  const s = await listenOn('https://repairs.internal.pceagles.org');
  const { port } = s.address();
  const res = await get(port, '/t/abc123def', { Host: 'evil.example.com' });

  assert.equal(res.status, 302);
  assert.ok(
    res.location.startsWith('https://repairs.internal.pceagles.org/'),
    `redirected to ${res.location} - the configured host must win over the request's`
  );
  s.close();
});

test('a scheme-relative path cannot smuggle in another origin', async () => {
  const s = await listenOn('https://repairs.internal.pceagles.org');
  const { port } = s.address();
  // //evil.example.com/x parses as a host when resolved against a base URL, so
  // the origin has to be pinned rather than concatenated blindly.
  const res = await get(port, '//evil.example.com/x');

  assert.ok(
    res.location.startsWith('https://repairs.internal.pceagles.org/'),
    `redirected to ${res.location}`
  );
  s.close();
});

test('a non-default https port is kept in the redirect', async () => {
  const s = await listenOn('https://repairs.internal.pceagles.org:8443');
  const { port } = s.address();
  const res = await get(port, '/tickets');
  assert.equal(res.location, 'https://repairs.internal.pceagles.org:8443/tickets');
  s.close();
});

// ---- the guards that stop a redirect loop ---------------------------------

test('a redirect port is refused when no certificate is configured', () => {
  const port = server.redirectPortFor({ redirectFromPort: 80, certPath: '', keyPath: '' }, 8443);
  assert.equal(port, 0, 'http would otherwise redirect to http, forever');
});

test('a redirect port equal to the site port is refused', () => {
  const port = server.redirectPortFor(
    { redirectFromPort: 8443, certPath: '/c.pem', keyPath: '/k.pem' }, 8443
  );
  assert.equal(port, 0);
});

test('a proper cert plus a different port is accepted', () => {
  const port = server.redirectPortFor(
    { redirectFromPort: 80, certPath: '/c.pem', keyPath: '/k.pem' }, 443
  );
  assert.equal(port, 80);
});
