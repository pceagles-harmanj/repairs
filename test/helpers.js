'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

/** Point config at a throwaway DB and keep email in dry-run before anything loads. */
function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repairs-test-'));
  process.env.DB_PATH = path.join(dir, 'test.db');
  process.env.DRY_RUN_EMAIL = 'true';
  process.env.APP_PASSWORD = '';
  process.env.GOOGLE_CLIENT_ID = '';
  process.env.GOOGLE_CLIENT_SECRET = '';
  process.env.ALLOW_DEVICE_WRITEBACK = 'true';
  // Keep the developer's .env from leaking into assertions.
  process.env.LOANER_DIGEST_TO = process.env.LOANER_DIGEST_TO || '';
  process.env.SCHOOL_HOLIDAYS = process.env.SCHOOL_HOLIDAYS || '';
  return dir;
}

async function startServer() {
  const { createApp } = require('../src/server');
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, { method = 'GET', body } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { server, base, call, close: () => new Promise((r) => server.close(r)) };
}

/** Boot the public-facing site on an ephemeral port. */
async function startPublicServer() {
  const { createPublicApp } = require('../src/public-site');
  const app = createPublicApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { server, base, close: () => new Promise((r) => server.close(r)) };
}

module.exports = { isolate, startServer, startPublicServer };
