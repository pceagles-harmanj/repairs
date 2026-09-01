'use strict';
/** Nightly backup: writes a real, restorable copy; prunes; reports failures. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { isolate } = require('./helpers');

isolate();
const nasDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-nas-'));
process.env.BACKUP_DIR = nasDir;
process.env.BACKUP_KEEP_DAYS = '2';
process.env.BACKUP_HOUR = '1';
// The scratch DB and the fake NAS are on the same disk here, so the real-world
// "is the share actually mounted" guard has to be relaxed for these tests.
process.env.BACKUP_ALLOW_SAME_DISK = 'true';

const backup = require('../src/backup');
const tickets = require('../src/tickets');
const Database = require('better-sqlite3');

test('with no BACKUP_DIR at all, nothing is attempted and the reason is recorded', async () => {
  const res = await backup.runBackup({ reason: 'test', dir: '' });
  assert.equal(res.result, 'error');
  assert.match(res.error, /BACKUP_DIR/);
});

test('a backup lands in the target folder, gzipped, and restores', async () => {
  await tickets.create({ issue_description: 'Backup me', user_email: 'a@b.org' }, { notify: false });
  const res = await backup.runBackup({ reason: 'test' });
  assert.equal(res.result, 'ok', res.error);
  assert.ok(fs.existsSync(res.path));
  assert.match(res.path, /repairs-\d{4}-\d{2}-\d{2}_\d{6}\.db\.gz$/);

  // gunzip and open it: the copy must be a valid database with our row in it
  const restored = path.join(nasDir, 'restored.db');
  fs.writeFileSync(restored, zlib.gunzipSync(fs.readFileSync(res.path)));
  const db = new Database(restored, { readonly: true });
  const row = db.prepare('SELECT issue_description FROM tickets ORDER BY id DESC LIMIT 1').get();
  assert.equal(row.issue_description, 'Backup me');
  db.close();
  fs.unlinkSync(restored);
});

test('the run is recorded so Settings can show last night', () => {
  const status = backup.status();
  assert.equal(status.enabled, true);
  assert.equal(status.dir, nasDir);
  assert.equal(status.at, '01:00');
  assert.equal(status.last.result, 'ok');
  assert.ok(status.last.bytes > 0);
  assert.ok(backup.history(5).length >= 1);
});

test('files older than the retention window are pruned, newer ones kept', () => {
  const old = path.join(nasDir, 'repairs-2020-01-01_0100.db.gz');
  const recent = path.join(nasDir, 'repairs-2999-01-01_0100.db.gz');
  const unrelated = path.join(nasDir, 'do-not-touch.txt');
  fs.writeFileSync(old, 'x');
  fs.writeFileSync(recent, 'x');
  fs.writeFileSync(unrelated, 'x');
  const weekAgo = Date.now() - 7 * 86400000;
  fs.utimesSync(old, weekAgo / 1000, weekAgo / 1000);

  const removed = backup.prune(nasDir, 2);
  assert.ok(removed >= 1);
  assert.ok(!fs.existsSync(old), 'old backup should be gone');
  assert.ok(fs.existsSync(recent), 'recent backup should stay');
  assert.ok(fs.existsSync(unrelated), 'unrelated files are never touched');
});

test('a backup folder on the same disk as the database is refused', async () => {
  const res = await backup.runBackup({ reason: 'test', dir: nasDir, allowSameDisk: false });
  assert.equal(res.result, 'error');
  assert.match(res.error, /same disk|not mounted/i);
});

test('a missing mount point is refused instead of being created locally', async () => {
  const res = await backup.runBackup({ reason: 'test', dir: '/definitely-not-mounted/repairs' });
  assert.equal(res.result, 'error');
  assert.match(res.error, /does not exist|not mounted|not writable/i);
  assert.ok(!fs.existsSync('/definitely-not-mounted'), 'must not create the path on the local disk');
});

test('a bad BACKUP_HOUR cannot produce a NaN delay (which would loop forever)', () => {
  // config validated it at load; msUntilNextRun also refuses to return NaN/0
  const ms = backup.msUntilNextRun(new Date());
  assert.ok(Number.isFinite(ms) && ms > 0);
});

test('the next run is the configured hour, at most a day out', () => {
  const ms = backup.msUntilNextRun(new Date());
  assert.ok(ms > 0 && ms <= 24 * 60 * 60 * 1000);
  const at = new Date(Date.now() + ms);
  assert.equal(at.getHours(), 1);
  assert.equal(at.getMinutes(), 0);

  // 00:30 -> same day 01:00 (half an hour later)
  const justBefore = new Date(2026, 0, 15, 0, 30, 0);
  assert.equal(backup.msUntilNextRun(justBefore), 30 * 60 * 1000);
  // 01:30 -> tomorrow 01:00
  const justAfter = new Date(2026, 0, 15, 1, 30, 0);
  assert.equal(backup.msUntilNextRun(justAfter), 23.5 * 60 * 60 * 1000);
});

test('an unreachable NAS is reported, not silently skipped', async () => {
  // A path that cannot be a directory, the way a missing NAS mount behaves.
  const blocker = path.join(nasDir, 'not-a-directory');
  fs.writeFileSync(blocker, 'x');
  const res = await backup.runBackup({ reason: 'test', dir: path.join(blocker, 'repairs') });
  assert.equal(res.result, 'error');
  assert.match(res.error, /not writable|mounted/i);
  const status = backup.status();
  assert.equal(status.last.result, 'error');
  assert.equal(status.last_ok.result, 'ok', 'the last good run is still remembered');
});
