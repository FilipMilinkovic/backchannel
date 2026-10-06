#!/usr/bin/env node
// Backchannel hub: team registry, @mention routing, threads, live feed. Zero dependencies.
// Configuration is environment variables only; see README "Configuration".
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

let config;
try { config = loadConfig(); } catch (err) { console.error(err.message); process.exit(1); }
const log = createLogger({ level: config.logLevel, format: config.logFormat, base: config.logFormat === 'json' ? { service: 'backchannel-hub' } : {} });
const reporter = createReporter({ log, sentry: config.sentry, environment: config.environment, release: `backchannel@${version}` });

let db, app;
async function shutdown(signal, code = 0) {
  log.info('shutting down', { signal });
  try { await app?.shutdown(); } catch (err) { reporter.error(err, { message: 'error during shutdown' }); }
  try { db?.close(); } catch {}
  await reporter.flush();
  process.exit(code);
}
installProcessHandlers(reporter, () => shutdown('uncaughtException', 1));
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => shutdown(sig));

try {
  db = openDb(config.dataDir, log);
} catch (err) {
  reporter.error(err, { message: `can't open the database in ${config.dataDir}` });
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
  if (!config.publicUrl) app.setPublicUrl(`http://${config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host}:${port}`);
  log.info(`Backchannel hub on http://${config.host}:${port}`, { version, publicUrl: app.publicUrl, dataDir: config.dataDir, sentry: !!config.sentry });
  // First start: print the one-time owner invite. It's reused across restarts until someone claims it.
  if (!repo.countUsers()) log.info(`Setup link: ${app.publicUrl}/#join/${repo.setupInvite().code}`, { hint: 'open it to become the owner' });
});
