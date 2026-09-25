#!/usr/bin/env node
/**
 * Starts Cabinet Wars on any system (Windows, macOS, Linux): installs the dependencies when
 * needed, builds the browser client, starts the server and opens the game in the browser.
 *
 *   node scripts/start.mjs              (or: npm start, start.bat, ./start.sh)
 *   node scripts/start.mjs --no-build   skip building the client (use the last build)
 *   node scripts/start.mjs --no-open    don't open the browser
 *
 * PORT (default 8787) and the CABINET_WARS_* settings in the README apply.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT ?? 8787);
const args = new Set(process.argv.slice(2));
const isWindows = process.platform === 'win32';

function fail(message) {
  console.error(`\nERROR: ${message}`);
  process.exit(1);
}

/** Runs an npm command in the project folder, showing its output. */
function npm(...npmArgs) {
  // npm is a script (npm.cmd) on Windows: it needs a shell to run.
  const r = spawnSync('npm', npmArgs, { cwd: ROOT, stdio: 'inherit', shell: isWindows });
  return r.status === 0;
}

function portInUse(port) {
  return new Promise((resolve) => {
    const s = connect(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
  });
}

function openBrowser(url) {
  const [cmd, cmdArgs] = isWindows ? ['cmd', ['/c', 'start', '', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true }).unref(); } catch { /* open it by hand */ }
}

const major = Number(process.versions.node.split('.')[0]);
if (major < 22) fail(`Node 22 or newer is required (found ${process.versions.node}). Get it from https://nodejs.org`);

// Install only when dependencies are missing or package-lock.json changed since the last install.
const installed = join(ROOT, 'node_modules', '.package-lock.json');
if (!existsSync(installed) || statSync(join(ROOT, 'package-lock.json')).mtimeMs > statSync(installed).mtimeMs) {
  // Exactly the versions in package-lock.json.
  console.log('==> Installing dependencies…');
  if (!npm('ci')) fail('Installing the dependencies failed (npm ci). Without internet access, use a release package instead: see the README.');
}

if (!args.has('--no-build') || !existsSync(join(ROOT, 'packages', 'client', 'dist', 'index.html'))) {
  console.log('==> Building the client…');
  if (!npm('run', 'build')) fail('The build failed.');
}

if (await portInUse(PORT)) {
  fail(`Port ${PORT} is already in use (is Cabinet Wars already running?). Close it, or pick another port: `
    + (isWindows ? 'run "set PORT=8788", then start.bat' : 'PORT=8788 ./start.sh'));
}

const url = `http://localhost:${PORT}`;
console.log(`==> Starting Cabinet Wars on ${url} (close this window or press Ctrl+C to stop)`);
console.log('    Host an online game from Multiplayer: the lobby shows links others can join from anywhere.');
const server = spawn('npm', ['run', 'server'], { cwd: ROOT, stdio: 'inherit', shell: isWindows, env: { ...process.env, PORT: String(PORT) } });
server.on('exit', (code) => process.exit(code ?? 0));
// Ctrl+C reaches the server directly (same console); just don't leave it behind otherwise.
process.on('SIGTERM', () => server.kill());

// Open the browser once the server answers.
if (!args.has('--no-open')) {
  for (let i = 0; i < 100; i++) {
    if (await portInUse(PORT)) { openBrowser(url); break; }
    await new Promise((r) => setTimeout(r, 200));
  }
}
