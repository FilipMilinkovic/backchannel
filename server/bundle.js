// Builds the client package (CLI, connector, MCP server) as an npm tarball, so anyone who can reach the hub can run
//   npm install -g https://<hub>/install/backchannel.tgz
// and get clients that match this hub's version. No repo access or registry needed. Plain ustar + gzip, no dependencies.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export const CLIENT_FILES = ['bin/backchannel.js', 'cli.js', 'client.js', 'agent.js', 'responder.js', 'session.js', 'service.js', 'tools.js', 'worktree.js', 'launch.js', 'backends.js', 'safety.js', 'mcp.js', 'setup.js', 'hooks/inbox-hook.js', 'AGENT_INSTRUCTIONS.md', 'LICENSE'];

function header(name, size, mtime) {
  const h = Buffer.alloc(512);
  const put = (value, offset, length) => h.write(value, offset, length, 'utf8');
  const octal = (n, length) => n.toString(8).padStart(length - 1, '0') + '\0';
  put(name, 0, 100);
  put(octal(name.endsWith('.js') ? 0o755 : 0o644, 8), 100, 8);
  put(octal(0, 8), 108, 8); put(octal(0, 8), 116, 8);
  put(octal(size, 12), 124, 12);
  put(octal(mtime, 12), 136, 12);
  put('        ', 148, 8); // checksum placeholder: spaces
  put('0', 156, 1);
  put('ustar\0', 257, 6); put('00', 263, 2);
  let sum = 0;
  for (const byte of h) sum += byte;
  put(octal(sum, 7) + ' ', 148, 8);
  return h;
}

export function buildClientTarball(root, version) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const manifest = {
    name: 'backchannel', version, description: pkg.description, type: 'module', license: pkg.license,
    engines: pkg.engines, bin: { backchannel: 'bin/backchannel.js' },
  };
  const entries = [['package.json', Buffer.from(JSON.stringify(manifest, null, 2) + '\n')]];
  for (const f of CLIENT_FILES) {
    const file = path.join(root, f);
    if (fs.existsSync(file)) entries.push([f, fs.readFileSync(file)]);
  }
  const mtime = Math.floor(Date.now() / 1000);
  const parts = [];
  for (const [name, data] of entries) {
    parts.push(header(`package/${name}`, data.length, mtime), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(parts), { level: 9 });
}
