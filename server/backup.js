// Consistent database copies (VACUUM INTO is safe while the hub runs). Used by `node hub.js backup` and the daily job.
import fs from 'node:fs';
import path from 'node:path';

export function backupTo(db, target) {
  if (fs.existsSync(target)) throw new Error(`${target} already exists`);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  fs.chmodSync(target, 0o600);
  return target;
}

// Backs up when the newest copy is older than `hours` (or there is none). Judged by the files, not a timer,
// so frequent restarts and deploys never postpone backups.
export function backupIfDue(db, dataDir, hours, keep) {
  const dir = path.join(dataDir, 'backups');
  let newest = 0;
  try { for (const f of fs.readdirSync(dir)) if (/^backchannel-.*\.db$/.test(f)) newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch {}
  return Date.now() - newest >= hours * 3_600_000 ? rotatingBackup(db, dataDir, keep) : null;
}

// Writes DATA_DIR/backups/backchannel-<time>.db and keeps the newest `keep` copies.
export function rotatingBackup(db, dataDir, keep) {
  const dir = path.join(dataDir, 'backups');
  const file = backupTo(db, path.join(dir, `backchannel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`));
  const old = fs.readdirSync(dir).filter((f) => /^backchannel-.*\.db$/.test(f)).sort().slice(0, -keep);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  return { file, removed: old.length };
}
