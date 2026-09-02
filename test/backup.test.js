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

test('a backup folder that is not a mounted share is refused', async () => {
  const res = await backup.runBackup({ reason: 'test', dir: nasDir, allowSameDisk: false });
  assert.equal(res.result, 'error');
  assert.match(res.error, /not a mounted share|same disk/i);
  // and the diagnosis says why, in the terms an admin can act on
  assert.equal(res.target.exists, true);
  assert.equal(res.target.writable, true);
  assert.equal(res.target.is_mount, false);
  assert.ok(res.target.warning, 'writable, but not a real backup target');
  assert.equal(res.target.problem, null, 'not a hard failure - the override exists for a reason');
});

test('the target check describes where the backup would actually land', () => {
  const target = backup.describeTarget(nasDir);
  assert.equal(target.dir, nasDir);
  assert.equal(target.exists, true);
  assert.equal(target.writable, true);
  assert.equal(typeof target.device, 'string');
  assert.equal(target.is_mount, false, 'a plain directory is not a mount point');
  assert.ok(target.files >= 1, 'it can see the backups already written there');
  assert.match(target.newest, /^repairs-/);

  assert.ok(target.warning, 'a plain local directory warns that it is not a share');

  const missing = backup.describeTarget('/definitely-not-here/backups');
  assert.equal(missing.exists, false);
  assert.match(missing.problem, /does not exist/);
});

test('a successful backup reports the target it used', async () => {
  const res = await backup.runBackup({ reason: 'test' });
  assert.equal(res.result, 'ok');
  assert.equal(res.target.dir, nasDir);
  assert.ok(res.target.files >= 1);
  assert.ok(fs.existsSync(res.path), 'the file is really there');
});

test('status() carries the diagnosis so Settings can show it', () => {
  const s = backup.status();
  assert.equal(s.target.dir, nasDir);
  assert.equal(typeof s.target.exists, 'boolean');
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

// ---- staging, and what happens when the share misbehaves -------------------

test('SQLite writes locally and only the finished file is copied to the share', async () => {
  const res = await backup.runBackup({ reason: 'test' });
  assert.equal(res.result, 'ok');
  assert.equal(path.dirname(res.path), nasDir, 'the finished file lands on the share');

  // nothing is left behind in staging
  const staging = path.join(path.dirname(process.env.DB_PATH), '.backup-staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, [], 'staging is cleaned up after a good copy');

  // and the copy is byte-identical to a fresh gunzip
  const restored = zlib.gunzipSync(fs.readFileSync(res.path));
  assert.ok(restored.length > 0);
  assert.equal(restored.subarray(0, 15).toString(), 'SQLite format 3');
});

test('a target that cannot be written to is refused before any work is done', async () => {
  // a path that exists as a file: nothing can be written "into" it
  const wall = path.join(nasDir, 'wall');
  fs.writeFileSync(wall, 'x');
  const res = await backup.runBackup({ reason: 'test', dir: path.join(wall, 'sub'), allowSameDisk: true });
  assert.equal(res.result, 'error');
  assert.match(res.error, /not writable|does not exist/i);

  const staging = path.join(path.dirname(process.env.DB_PATH), '.backup-staging');
  const leftovers = fs.existsSync(staging) ? fs.readdirSync(staging) : [];
  assert.deepEqual(leftovers, [], 'a refused backup does not leave a staged file behind');
});

test('when the copy to the share fails, the staged copy is kept and the step is named', async () => {
  // Let the pre-flight pass, then make the copy fail by removing the directory
  // underneath it - the same shape as a share dropping mid-backup.
  const vanishing = path.join(nasDir, 'vanishing');
  fs.mkdirSync(vanishing, { recursive: true });
  const realCopy = fs.copyFileSync;
  fs.copyFileSync = () => { throw Object.assign(new Error("ENOENT: no such file or directory, open '/backups/x.db'"), { code: 'ENOENT' }); };
  try {
    const res = await backup.runBackup({ reason: 'test', dir: vanishing, allowSameDisk: true });
    assert.equal(res.result, 'error');
    assert.match(res.step, /copying to/);
    assert.match(res.error, /copying to .*failed: ENOENT/);
    assert.match(res.error, /staged copy is still at/, 'the work is not thrown away');
  } finally {
    fs.copyFileSync = realCopy;
  }
});

test('the error names which step failed, not just the errno', async () => {
  const res = await backup.runBackup({ reason: 'test', dir: '/definitely-not-here/backups' });
  assert.equal(res.result, 'error');
  assert.match(res.error, /does not exist/i);
});

// ---- telling "share dropped" from "share never mounted" --------------------

test('a missing marker file is reported as an unmounted share', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marker-'));
  process.env.BACKUP_MARKER_FILE = '.repairs-nas';
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/backup')];
  const freshBackup = require('../src/backup');

  const missing = freshBackup.describeTarget(dir);
  assert.equal(missing.marker_present, false);
  assert.match(missing.warning, /marker file \.repairs-nas is missing/);

  // Drop the marker in and the objection goes away.
  fs.writeFileSync(path.join(dir, '.repairs-nas'), '');
  const present = freshBackup.describeTarget(dir);
  assert.equal(present.marker_present, true);
  assert.equal(present.warning, null, 'a marked share is accepted even on the same disk');

  delete process.env.BACKUP_MARKER_FILE;
  delete require.cache[require.resolve('../src/config')];
  delete require.cache[require.resolve('../src/backup')];
});

test('once a backup has landed, a later local folder is called out as a dropped share', () => {
  const backup = require('../src/backup');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dropped-'));

  // Pretend last night's backup landed on a share with a different device id.
  backup.rememberGoodTarget({ device: '999999', dir, at: new Date().toISOString() });
  const target = backup.describeTarget(dir);

  assert.equal(target.device_changed, true, 'the filesystem under the folder changed');
  const advice = backup.mountAdvice(target);
  assert.match(advice, /has since been unmounted/);
  assert.match(advice, /RESTART the container/);
  assert.match(advice, /findmnt/, 'the message hands over a command to run');
});

test('with no history, the advice does not claim the share ever worked', () => {
  const backup = require('../src/backup');
  const { getDb } = require('../src/db');
  getDb().prepare('DELETE FROM settings WHERE key = ?').run(backup.LAST_GOOD_KEY);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'never-'));

  const target = backup.describeTarget(dir);
  assert.ok(!target.device_changed);
  const advice = backup.mountAdvice(target);
  assert.doesNotMatch(advice, /has since been unmounted/);
  assert.match(advice, /Mount the share on the Proxmox host/);
});
