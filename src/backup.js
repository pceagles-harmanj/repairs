'use strict';
/**
 * Nightly database backup.
 *
 * Uses SQLite's online backup API (via better-sqlite3's db.backup), which is the
 * only safe way to copy a live database - `cp` on a WAL database can produce a
 * torn file. The result is optionally gzipped, written to BACKUP_DIR (point that
 * at your NAS mount), and old files are pruned. Every run is recorded in the
 * `backups` table so Settings can show whether last night worked.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const config = require('./config');
const { getDb, getSetting, setSetting } = require('./db');

// Remembered from the last successful run, so a later failure can tell
// "the share dropped" apart from "the share was never mounted".
const LAST_GOOD_KEY = 'backup:last_good_target';

const pad = (n) => String(n).padStart(2, '0');

function stamp(d = new Date()) {
  // Seconds included so two runs in the same minute cannot collide on a filename.
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/**
 * Where does this path really live?
 *
 * In a container the naive checks lie: `/app/data` is itself a bind mount, so
 * comparing devices against the database tells you nothing about whether the
 * backup folder is the NAS or just a directory inside the container. The useful
 * questions are "is this a mount point at all" and "is it the same filesystem
 * as the container's own root".
 */
function describeTarget(dir = config.backup.dir) {
  const info = {
    dir: dir || null,
    exists: false,
    writable: false,
    is_mount: false,
    same_fs_as_root: null,
    same_fs_as_database: null,
    device: null,
    free_mb: null,
    files: null,
    newest: null,
    problem: null,   // fatal: cannot write here at all
    warning: null,   // writable, but not a real backup target
  };
  if (!dir) {
    info.problem = 'BACKUP_DIR is not set';
    return info;
  }
  try {
    const st = fs.statSync(dir);
    info.exists = true;
    info.device = String(st.dev);
    // A directory whose device differs from its parent's is a mount point.
    try {
      info.is_mount = fs.statSync(path.dirname(dir)).dev !== st.dev;
    } catch { /* parent unreadable: leave unknown */ }
    try { info.same_fs_as_root = fs.statSync('/').dev === st.dev; } catch { /* ignore */ }
    try { info.same_fs_as_database = fs.statSync(config.dbPath).dev === st.dev; } catch { /* ignore */ }
    try { fs.accessSync(dir, fs.constants.W_OK); info.writable = true; } catch { /* ignore */ }
    try {
      const stats = fs.statfsSync(dir);
      info.free_mb = Math.round((stats.bavail * stats.bsize) / 1048576);
    } catch { /* statfs is not everywhere */ }
    try {
      const names = fs.readdirSync(dir).filter((n) => /^repairs-.*\.db(\.gz)?$/.test(n)).sort();
      info.files = names.length;
      info.newest = names.length ? names[names.length - 1] : null;
    } catch { /* ignore */ }
    // A file that exists only on the share is the most reliable mount test
    // there is - no device numbers, no propagation rules, just "is it there".
    if (config.backup.marker) {
      info.marker = config.backup.marker;
      info.marker_present = fs.existsSync(path.join(dir, config.backup.marker));
    }
  } catch {
    info.problem = `${dir} does not exist from where the app is running`;
    return info;
  }

  // `problem` is fatal whatever the settings say; `warning` is the "this is not
  // really a backup" case that BACKUP_ALLOW_SAME_DISK deliberately overrides.
  // Reporting them separately keeps the description honest and the decision
  // where it belongs, in doBackup().
  // What did this look like the last time a backup actually landed?
  const lastGood = readLastGood();
  if (lastGood) {
    info.last_good_device = lastGood.device || null;
    info.last_good_at = lastGood.at || null;
    info.device_changed = Boolean(lastGood.device && info.device && lastGood.device !== info.device);
  }

  if (!info.writable) {
    info.problem = `${dir} is not writable by the app`;
  } else if (info.marker && info.marker_present === false) {
    info.warning = `${dir} exists but the marker file ${info.marker} is missing, so the share is not mounted`;
  } else if (info.marker && info.marker_present) {
    // The marker is the strongest evidence available: it lives on the share, so
    // if it is visible the share is mounted. Trust it over the device-number
    // heuristics below, which cannot see through every bind-mount arrangement.
    info.warning = null;
  } else if (info.same_fs_as_root) {
    info.warning = `${dir} is on the same filesystem as the app itself, so it is not a mounted share - `
      + 'anything written there stays inside the container and is lost with it';
  } else if (info.same_fs_as_database) {
    info.warning = `${dir} is on the same disk as the database, so a copy there is not a backup`;
  }
  return info;
}

function readLastGood() {
  try {
    const raw = getSetting(LAST_GOOD_KEY);
    return typeof raw === 'string' ? JSON.parse(raw) : null;
  } catch { return null; }
}

function rememberGoodTarget(target) {
  if (!target || !target.device) return;
  setSetting(LAST_GOOD_KEY, JSON.stringify({
    device: target.device, dir: target.dir, at: new Date().toISOString(),
  }));
}

/**
 * The evidence, in the order a person would check it. The point is that the
 * message names what to do next rather than restating that it failed.
 */
function mountAdvice(target) {
  const lines = [];
  if (target.device_changed) {
    lines.push(
      `This worked on ${new Date(target.last_good_at).toLocaleString()} when ${target.dir} was a different `
      + 'filesystem, so the share has since been unmounted - a NAS reboot or a dropped SMB session will do that. '
      + 'Re-mount it on the Proxmox host, then RESTART the container: a mount made on the host after the '
      + 'container started is invisible inside it, which is why the app still sees a plain local folder.'
    );
  } else {
    lines.push(
      'Mount the share on the Proxmox host and restart the container (a mount made on the host after the '
      + 'container started is not visible inside it).'
    );
  }
  lines.push(
    `To check from the host: \`findmnt ${target.dir}\` and \`pct exec <CTID> -- findmnt ${target.dir}\` - `
    + 'if the host shows a mount and the container does not, restarting the container is the whole fix.'
  );
  lines.push('Or set BACKUP_ALLOW_SAME_DISK=true if a local copy really is what you want.');
  return lines.join(' ');
}

function record(entry) {
  getDb()
    .prepare(
      `INSERT INTO backups (path, bytes, result, error, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(entry.path || null, entry.bytes || null, entry.result, entry.error || null, entry.duration_ms || null, new Date().toISOString());
}

async function gzipFile(src, dest) {
  await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), fs.createWriteStream(dest));
  fs.unlinkSync(src);
}

/** Delete backups older than BACKUP_KEEP_DAYS. Returns how many were removed. */
function prune(dir, keepDays) {
  if (!keepDays || keepDays <= 0) return 0;
  const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const name of fs.readdirSync(dir)) {
    if (!/^repairs-.*\.db(\.gz)?$/.test(name)) continue;
    const full = path.join(dir, name);
    try {
      if (fs.statSync(full).mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch { /* someone else's file, or already gone */ }
  }
  return removed;
}

let inFlight = null;

async function runBackup(opts = {}) {
  // One at a time: overlapping runs would fight over files and disk.
  if (inFlight) return inFlight;
  inFlight = doBackup(opts).finally(() => { inFlight = null; });
  return inFlight;
}

async function doBackup({ reason = 'manual', dir = config.backup.dir, allowSameDisk = config.backup.allowSameDisk } = {}) {
  const started = Date.now();
  if (!dir) {
    const error = 'BACKUP_DIR is not set - nowhere to write the backup';
    record({ result: 'error', error });
    return { result: 'error', error };
  }

  // Create at most the final folder: if the parent is missing, the share is not
  // mounted and `mkdir -p` would happily build the whole path on the local disk.
  try {
    if (!fs.existsSync(dir)) {
      const parent = path.dirname(dir);
      if (!fs.existsSync(parent)) {
        const error = `Backup folder ${dir} does not exist and neither does ${parent}. If this is a NAS share, it is not mounted.`;
        record({ result: 'error', error });
        return { result: 'error', error };
      }
      fs.mkdirSync(dir);
    }
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    const error = `Backup folder is not writable (${dir}): ${err.message}. If this is a NAS share, check that it is mounted.`;
    record({ result: 'error', error });
    return { result: 'error', error };
  }

  // Is this really the share, or just a directory that happens to exist?
  const target = describeTarget(dir);
  if (target.problem) {
    record({ result: 'error', error: target.problem });
    return { result: 'error', error: target.problem, target };
  }
  if (target.warning && !allowSameDisk) {
    const error = `${target.warning}. ${mountAdvice(target)}`;
    record({ result: 'error', error });
    return { result: 'error', error, target };
  }

  // ---------------------------------------------------------------------
  // Stage locally, then copy.
  //
  // SQLite's backup API writes a real database file: it creates, locks, and
  // fsyncs. Network shares (CIFS/SMB, NFS) do not reliably support that, and the
  // failure is rarely a clean error - you get ENOENT, a zero-byte file, or a
  // "successful" write with nothing on the far end. So SQLite only ever writes
  // to a local disk, and the finished, compressed file is copied to the share as
  // plain bytes, which SMB does perfectly well.
  // ---------------------------------------------------------------------
  const name = `repairs-${stamp()}.db`;
  const staging = stagingDir();
  const localDb = path.join(staging, name);
  let localFinal = localDb;
  const cleanup = () => {
    for (const leftover of [localDb, localDb + '.gz']) {
      try { if (fs.existsSync(leftover)) fs.unlinkSync(leftover); } catch { /* ignore */ }
    }
  };

  let step = 'preparing';
  try {
    step = `staging the database copy in ${staging}`;
    fs.mkdirSync(staging, { recursive: true });
    await getDb().backup(localDb);
    if (!fs.existsSync(localDb) || fs.statSync(localDb).size === 0) {
      throw new Error(`SQLite reported success but ${localDb} is missing or empty`);
    }

    if (config.backup.gzip) {
      step = 'compressing';
      localFinal = localDb + '.gz';
      await gzipFile(localDb, localFinal);
    }

    step = `copying to ${dir}`;
    const destination = path.join(dir, path.basename(localFinal));
    fs.copyFileSync(localFinal, destination);

    // Verify from the destination's point of view: size matches, and the file is
    // actually listed in the directory (a bind mount shadowed by a later host
    // mount would silently swallow it otherwise).
    step = 'verifying the copy';
    const localSize = fs.statSync(localFinal).size;
    const remote = fs.statSync(destination);
    const listed = fs.readdirSync(dir).includes(path.basename(destination));
    if (!listed || remote.size !== localSize) {
      throw new Error(
        `copied ${localSize} bytes to ${destination} but it reads back as `
        + `${listed ? `${remote.size} bytes` : 'missing'} - the share may have been mounted after the `
        + 'container started, or dropped mid-write'
      );
    }

    cleanup();
    // Remember what a working target looked like, so if this folder is ever a
    // plain local directory again we can say the share dropped rather than
    // guessing it was never set up.
    rememberGoodTarget(target);
    const removed = prune(dir, config.backup.keepDays);
    const duration = Date.now() - started;
    record({ path: destination, bytes: remote.size, result: 'ok', duration_ms: duration });
    console.log(`[backup] ${reason}: wrote ${destination} (${(remote.size / 1048576).toFixed(2)} MB) in ${duration}ms, pruned ${removed}`);
    return { result: 'ok', path: destination, bytes: remote.size, pruned: removed, duration_ms: duration, target: describeTarget(dir) };
  } catch (err) {
    const kept = fs.existsSync(localFinal) ? localFinal : null;
    cleanupUnless(kept, cleanup);
    const error = `${step} failed: ${err.message || err}`
      + (kept ? ` (the staged copy is still at ${kept})` : '');
    record({ result: 'error', error, duration_ms: Date.now() - started });
    console.error('[backup]', error);
    return { result: 'error', error, step, target: describeTarget(dir) };
  }
}

/**
 * Somewhere local and writable to build the backup before copying it. Next to
 * the database by default: same volume, so it is guaranteed to be a real disk.
 */
function stagingDir() {
  return config.backup.stagingDir || path.join(path.dirname(config.dbPath), '.backup-staging');
}

/** Keep a staged file when the copy step failed, so the work is not lost. */
function cleanupUnless(kept, cleanup) {
  if (kept) return;
  cleanup();
}

function msUntilNextRun(now = new Date()) {
  const hour = Number.isInteger(config.backup.hour) ? config.backup.hour : 1;
  const minute = Number.isInteger(config.backup.minute) ? config.backup.minute : 0;
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const ms = next - now;
  // Belt and braces: never return something setTimeout would treat as "now".
  return Number.isFinite(ms) && ms > 0 ? ms : 24 * 60 * 60 * 1000;
}

let timer = null;

/** Arm the nightly run. Re-computes the delay each time, so DST and sleep are fine. */
function startScheduler() {
  if (!config.backup.enabled) return { scheduled: false, reason: 'disabled' };
  if (!config.backup.dir) {
    console.log('! BACKUP_DIR is not set - nightly backups are off');
    return { scheduled: false, reason: 'no_dir' };
  }
  const arm = () => {
    const delay = msUntilNextRun();
    timer = setTimeout(async () => {
      await runBackup({ reason: 'nightly' });
      arm();
    }, delay);
    timer.unref?.();
    const at = new Date(Date.now() + delay);
    console.log(`[backup] next run ${at.toLocaleString()} -> ${config.backup.dir}`);
  };
  arm();
  return { scheduled: true };
}

function stopScheduler() {
  if (timer) clearTimeout(timer);
  timer = null;
}

function history(limit = 20) {
  return getDb().prepare('SELECT * FROM backups ORDER BY id DESC LIMIT ?').all(limit);
}

function status() {
  const last = getDb().prepare('SELECT * FROM backups ORDER BY id DESC LIMIT 1').get() || null;
  const lastOk = getDb().prepare("SELECT * FROM backups WHERE result = 'ok' ORDER BY id DESC LIMIT 1").get() || null;
  return {
    enabled: config.backup.enabled && Boolean(config.backup.dir),
    dir: config.backup.dir,
    target: describeTarget(),
    at: `${pad(config.backup.hour)}:${pad(config.backup.minute)}`,
    keep_days: config.backup.keepDays,
    gzip: config.backup.gzip,
    next_run: config.backup.enabled && config.backup.dir ? new Date(Date.now() + msUntilNextRun()).toISOString() : null,
    last,
    last_ok: lastOk,
  };
}

module.exports = {
  runBackup, startScheduler, stopScheduler, msUntilNextRun, history, status, prune, stamp, describeTarget,
  mountAdvice, rememberGoodTarget, LAST_GOOD_KEY,
};
