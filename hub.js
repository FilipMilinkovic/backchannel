#!/usr/bin/env node
// Backchannel hub: team registry, @mention routing, threads, live feed. Zero dependencies.
//   node hub.js                  run the hub (configured by environment variables; see README "Configuration")
//   node hub.js setup-link       print the one-time owner link of a hub nobody has claimed yet
//   node hub.js backup <file>    write a consistent copy of the database (safe while the hub runs)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './server/config.js';
import { createLogger } from './server/log.js';
import { createReporter, installProcessHandlers } from './server/report.js';
import { openDb } from './server/db.js';
import { createRepo } from './server/repo.js';
import { createApp } from './server/app.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const [command = 'serve', ...args] = process.argv.slice(2);

let config;
try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(1); }
const localUrl = (port) => `http://${['0.0.0.0', '::'].includes(config.host) ? '127.0.0.1' : config.host}:${port}`;

if (command === 'setup-link' || command === 'backup') {
  const db = openDb(config.dataDir);
  if (command === 'setup-link') {
    const repo = createRepo(db);
    console.log(repo.countUsers() ? 'This hub already has an owner. Ask them for an invite.'
      : `${config.publicUrl || localUrl(config.port)}/#join/${repo.setupInvite().code}`);
  } else {
    const target = path.resolve(args[0] || `backchannel-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
    if (fs.existsSync(target)) { console.error(`${target} already exists`); process.exit(1); }
    db.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    console.log(`Backed up to ${target}. To restore, stop the hub and replace ${path.join(config.dataDir, 'backchannel.db')} with it.`);
  }
  db.close();
  process.exit(0);
}
if (command !== 'serve') { console.error(`unknown command "${command}". Commands: serve (default), setup-link, backup <file>`); process.exit(1); }

const log = createLogger({ level: config.logLevel, format: config.logFormat, base: config.logFormat === 'json' ? { service: 'backchannel-hub' } : {} });
const reporter = createReporter({ log, sentry: config.sentry, environment: config.environment, release: `backchannel@${version}` });

let db, app, stopping = false;
async function shutdown(signal, code = 0) {
  if (stopping) return; // a second signal while draining changes nothing
  stopping = true;
  log.info('shutting down', { signal });
  try { await app?.shutdown(); } catch (err) { reporter.error(err, { message: 'error during shutdown' }); }
  try { db?.close(); } catch {}
  await reporter.flush();
  process.exit(code);
}
installProcessHandlers(reporter, () => shutdown('uncaughtException', 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

try {
  db = openDb(config.dataDir, log);
} catch (err) {
  reporter.error(err, { message: `can't open the database in ${config.dataDir}: ${err.message}` });
  await reporter.flush();
  process.exit(1);
}
const repo = createRepo(db);
app = createApp({ config, repo, log, reporter, version, publicDir: path.join(ROOT, 'public') });

app.server.on('error', async (err) => {
  reporter.error(err, { message: err.code === 'EADDRINUSE' ? `port ${config.port} is already in use` : 'server error' });
  await reporter.flush();
  process.exit(1);
});
app.server.listen(config.port, config.host, () => {
  const { port } = app.server.address();
  if (!config.publicUrl) app.setPublicUrl(localUrl(port));
  log.info(`Backchannel hub on http://${config.host}:${port}`, { version, publicUrl: app.publicUrl, dataDir: config.dataDir, sentry: !!config.sentry });
  // First start: print the one-time owner invite (also available later with `node hub.js setup-link`).
  if (!repo.countUsers()) log.info(`Setup link: ${app.publicUrl}/#join/${repo.setupInvite().code}`, { hint: 'open it to become the owner' });
});
