// `backchannel connect --service`: runs a connector in the background as a per-user launchd agent (macOS) or systemd
// user unit (Linux). It starts at login, restarts if it crashes, and stays stopped when it exits cleanly (disconnected
// from the hub, or signed out). One service per agent handle.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Tests pick the platform and write the files without touching launchd or systemd.
const platform = () => process.env.BACKCHANNEL_SERVICE_PLATFORM || process.platform;
const dryRun = () => process.env.BACKCHANNEL_SERVICE_DRY_RUN === '1';
const BIN = fileURLToPath(new URL('./bin/backchannel.js', import.meta.url));
// What the connector needs from this shell: PATH finds claude and codex; the rest are optional settings. Never tokens.
const CARRY = ['PATH', 'CLAUDE_BIN', 'CODEX_BIN', 'CODER_TIMEOUT_MIN'];

export const supported = () => platform() === 'darwin' || platform() === 'linux';
export const logFile = (id) => path.join(os.homedir(), '.backchannel', 'logs', `connect-${id}.log`);
const label = (id) => `com.backchannel.connect.${id}`;
const unit = (id) => `backchannel-connect-${id}.service`;
const dir = () => (platform() === 'darwin' ? path.join(os.homedir(), 'Library', 'LaunchAgents')
  : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user'));
export const serviceFile = (id) => path.join(dir(), platform() === 'darwin' ? `${label(id)}.plist` : unit(id));
const domain = () => `gui/${process.getuid?.() ?? 0}`;

function sh(cmd, args) {
  if (dryRun()) return { status: 0, stdout: '', stderr: '' };
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  return r.error ? { status: 1, stdout: '', stderr: r.error.message } : r;
}
function must(cmd, args) {
  const r = sh(cmd, args);
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
  return r;
}

const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const loaded = (id) => sh('launchctl', ['print', `${domain()}/${label(id)}`]).status === 0;
// `launchctl bootout` returns before the job is gone: a running connector takes a few seconds to close its session.
// Bootstrapping before then fails with "5: Input/output error", so wait for it, and retry a few times all the same.
function unload(id) {
  if (dryRun() || !loaded(id)) return;
  sh('launchctl', ['bootout', `${domain()}/${label(id)}`]);
  for (let i = 0; i < 50 && loaded(id); i++) sleep(200);
}
function load(id, file) {
  for (let i = 0; ; i++) {
    const r = sh('launchctl', ['bootstrap', domain(), file]);
    if (r.status === 0) return;
    if (i >= 4) throw new Error(`launchctl bootstrap ${domain()} ${file} failed: ${(r.stderr || r.stdout).trim() || `exit ${r.status}`}`);
    unload(id);
    sleep(1000);
  }
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function plist({ id, argv, cwd, env, log }) {
  const str = (s) => `<string>${xml(s)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${str(label(id))}
  <key>ProgramArguments</key>
  <array>
${argv.map((a) => `    ${str(a)}`).join('\n')}
  </array>
  <key>WorkingDirectory</key>${str(cwd)}
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(env).map(([k, v]) => `    <key>${xml(k)}</key>${str(v)}`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key>${str(log)}
  <key>StandardErrorPath</key>${str(log)}
</dict>
</plist>
`;
}

// systemd unescapes backslashes and quotes, expands % specifiers and $ variables.
const sq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, '$$$$')}"`;
// WorkingDirectory= and append: paths are taken as written (no quotes, which would make the path relative and the unit
// fail to load); only % specifiers are expanded there.
const pct = (s) => String(s).replace(/%/g, '%%');
function systemdUnit({ id, argv, cwd, env, log }) {
  if ([cwd, log].some((p) => /[\n\r]/.test(p))) throw new Error('a background connector can\'t run in a folder whose path has a line break');
  return `[Unit]
Description=Backchannel connector @${id}
After=network-online.target

[Service]
ExecStart=${argv.map(sq).join(' ')}
WorkingDirectory=${pct(cwd)}
${Object.entries(env).map(([k, v]) => `Environment=${sq(`${k}=${v}`)}`).join('\n')}
Restart=on-failure
RestartSec=30
StandardOutput=append:${pct(log)}
StandardError=append:${pct(log)}

[Install]
WantedBy=default.target
`;
}

// Writes the service for `id` (replacing one that's there) and starts it. `args` are the connector's own flags.
export function install({ id, args, cwd }) {
  if (!supported()) throw new Error(`background connectors run on macOS and Linux; on ${platform()}, keep \`backchannel connect\` open in a terminal`);
  const log = logFile(id);
  fs.mkdirSync(path.dirname(log), { recursive: true, mode: 0o700 });
  const env = { BACKCHANNEL_SERVICE: '1' };
  for (const k of CARRY) if (process.env[k]) env[k] = process.env[k];
  const spec = { id, argv: [process.execPath, BIN, 'connect', ...args], cwd, env, log };
  const file = serviceFile(id);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (platform() === 'darwin') {
    unload(id); // an older copy, if it's loaded
    fs.writeFileSync(file, plist(spec));
    load(id, file);
  } else {
    fs.writeFileSync(file, systemdUnit(spec));
    must('systemctl', ['--user', 'daemon-reload']);
    must('systemctl', ['--user', 'enable', unit(id)]);
    must('systemctl', ['--user', 'restart', unit(id)]);
  }
  return { file, log };
}

// Stops the service and removes it. Returns false when there was none.
export function uninstall(id) {
  const file = serviceFile(id);
  if (!fs.existsSync(file)) return false;
  if (platform() === 'darwin') unload(id);
  else sh('systemctl', ['--user', 'disable', '--now', unit(id)]);
  fs.rmSync(file, { force: true });
  if (platform() !== 'darwin') sh('systemctl', ['--user', 'daemon-reload']);
  return true;
}

// Called by the service itself when it stops for good (disconnected from the hub): removes the file so it doesn't
// come back at the next login. It's exiting cleanly, so launchd and systemd don't restart it now either.
export function removeOwnFile(id) {
  try { fs.rmSync(serviceFile(id), { force: true }); return true; } catch { return false; }
}

// WorkingDirectory= of a unit: as written now, or quoted, as earlier versions wrote it.
function unitDir(text) {
  const v = /^WorkingDirectory=(.*)$/m.exec(text)?.[1];
  if (!v) return null;
  const quoted = /^"((?:[^"\\]|\\.)*)"$/.exec(v);
  return quoted ? quoted[1].replace(/\\(.)/g, '$1').replace(/%%/g, '%').replace(/\$\$/g, '$') : v.replace(/%%/g, '%');
}

// The connector services installed on this computer: [{ id, file, cwd, log, running, pid }]. `running` is null when
// it can't be told (dry run).
export function installed() {
  if (!supported()) return [];
  const pattern = platform() === 'darwin' ? /^com\.backchannel\.connect\.(.+)\.plist$/ : /^backchannel-connect-(.+)\.service$/;
  let names = [];
  try { names = fs.readdirSync(dir()); } catch {}
  return names.map((n) => pattern.exec(n)?.[1]).filter(Boolean).sort().map((id) => {
    const file = serviceFile(id);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch {} // a dangling link or unreadable file: still listed, so --stop can remove it
    const cwd = platform() === 'darwin'
      ? /<key>WorkingDirectory<\/key><string>([^<]*)<\/string>/.exec(text)?.[1]?.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      : unitDir(text);
    let running = null, pid = null;
    if (!dryRun()) {
      if (platform() === 'darwin') {
        const r = sh('launchctl', ['print', `${domain()}/${label(id)}`]);
        running = r.status === 0 && /\bstate = running\b/.test(r.stdout);
        pid = Number(/\bpid = (\d+)/.exec(r.stdout)?.[1]) || null;
      } else {
        running = sh('systemctl', ['--user', 'is-active', unit(id)]).stdout.trim() === 'active';
        pid = Number(sh('systemctl', ['--user', 'show', '-p', 'MainPID', '--value', unit(id)]).stdout.trim()) || null;
      }
    }
    return { id, file, cwd: cwd || null, log: logFile(id), running, pid };
  });
}
