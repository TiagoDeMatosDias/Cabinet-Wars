import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer, type Socket } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachSignaling } from './signaling';
import { lanAddresses, loadTls } from './tls';
import { Tunnel } from './tunnel';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const MAPS_DIR = process.env.KRIEG_MAPS ?? join(ROOT, 'Map');
const SAVES_DIR = process.env.KRIEG_SAVES ?? join(ROOT, 'saves');
const THEMES_DIR = process.env.KRIEG_THEMES ?? join(ROOT, 'themes');
const CLIENT_DIR = join(ROOT, 'packages/client/dist');
const DATA_DIR = process.env.KRIEG_DATA ?? join(ROOT, '.krieg');
const PORT = Number(process.env.PORT ?? 8787);
const tunnel = new Tunnel(PORT, join(DATA_DIR, 'bin'));

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.krieg': 'application/zip',
  '.woff2': 'font/woff2',
  '.glb': 'model/gltf-binary',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

/** Resolves `rel` inside `base`, refusing anything that escapes it. */
function safeJoin(base: string, rel: string): string | null {
  const full = normalize(join(base, decodeURIComponent(rel)));
  return full === base || full.startsWith(base + sep) ? full : null;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Sends a file. Browsers revalidate it each time (maps are edited in place) and get a 304 when
 * it has not changed, so players on slow links download big map images once.
 */
async function sendFile(req: IncomingMessage, res: ServerResponse, path: string | null) {
  let info;
  try {
    if (!path || !(info = await stat(path)).isFile()) throw new Error('not a file');
  } catch {
    json(res, 404, { error: 'Not found' });
    return;
  }
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const headers = { etag, 'cache-control': 'no-cache' };
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
  res.writeHead(200, { ...headers, 'content-type': TYPES[extname(path!).toLowerCase()] ?? 'application/octet-stream', 'content-length': info.size });
  createReadStream(path!).pipe(res);
}

async function listMaps() {
  const out: { id: string; name: string; files: string[]; ready: boolean; languages: string[]; languageNames: Record<string, string> }[] = [];
  let dirs: string[] = [];
  try { dirs = await readdir(MAPS_DIR); } catch { return out; }
  for (const id of dirs) {
    const dir = join(MAPS_DIR, id);
    if (!(await stat(dir)).isDirectory()) continue;
    const files = (await readdir(dir)).filter((f) => /\.(json|png|webp|jpg)$/i.test(f));
    let name = id;
    let ready = false;
    let languages = ['en'];
    let languageNames: Record<string, string> = {};
    try {
      const cfg = JSON.parse(await readFile(join(dir, 'config.json'), 'utf8'));
      name = cfg.name ?? id;
      ready = Array.isArray(cfg.nodes) && cfg.nodes.length > 0;
      languages = ['en', ...Object.keys(cfg.text ?? {}).filter((l) => l !== 'en')];
      languageNames = cfg.languageNames ?? {};
    } catch { /* empty or missing config: the editor can still open the images */ }
    out.push({ id, name, files, ready, languages, languageNames });
  }
  return out;
}

/** Themes shared by the server: folders in themes/ containing a theme.json. */
async function listThemes() {
  const out: { id: string; name: string }[] = [];
  let dirs: string[] = [];
  try { dirs = await readdir(THEMES_DIR); } catch { return out; }
  for (const id of dirs) {
    try {
      const t = JSON.parse(await readFile(join(THEMES_DIR, id, 'theme.json'), 'utf8'));
      out.push({ id, name: String(t.name ?? id) });
    } catch { /* not a theme folder */ }
  }
  return out;
}

async function listSaves() {
  try {
    const files = (await readdir(SAVES_DIR)).filter((f) => f.endsWith('.krieg'));
    return Promise.all(files.map(async (f) => ({ file: f, size: (await stat(join(SAVES_DIR, f))).size })));
  } catch {
    return [];
  }
}

/** Addresses others can open the game at: the public tunnel, and this machine on its local networks. */
async function network(wait: boolean) {
  if (wait) tunnel.start();
  const pub = wait ? await tunnel.wait(45_000) : tunnel.current();
  return { public: pub, lan: lanAddresses().map((ip) => `https://${ip}:${PORT}`) };
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') {
      if (parts[1] === 'health') return json(res, 200, { ok: true });
      if (parts[1] === 'network') return json(res, 200, await network(url.searchParams.has('wait')));
      if (parts[1] === 'maps' && parts.length === 2) return json(res, 200, await listMaps());
      if (parts[1] === 'maps' && parts.length >= 4) return sendFile(req, res, safeJoin(MAPS_DIR, parts.slice(2).join('/')));
      if (parts[1] === 'themes' && parts.length === 2) return json(res, 200, await listThemes());
      if (parts[1] === 'themes' && parts.length >= 4) return sendFile(req, res, safeJoin(THEMES_DIR, parts.slice(2).join('/')));
      if (parts[1] === 'saves' && parts.length === 2) return json(res, 200, await listSaves());
      if (parts[1] === 'saves' && parts.length === 3) return sendFile(req, res, safeJoin(SAVES_DIR, parts[2]));
      return json(res, 404, { error: 'Not found' });
    }
    const file = safeJoin(CLIENT_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (file && (await stat(file).catch(() => null))?.isFile()) return sendFile(req, res, file);
    return sendFile(req, res, join(CLIENT_DIR, 'index.html'));
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
}

const isLoopback = (addr = '') => addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.');

/**
 * Plain HTTP is only served to this machine (the browser at http://localhost and the public
 * tunnel, which brings its own HTTPS); anyone else is sent to HTTPS, which browsers require for
 * the game's cryptography and clipboard.
 */
const http = createServer((req, res) => {
  if (isLoopback(req.socket.remoteAddress)) { void handle(req, res); return; }
  const host = (req.headers.host ?? `localhost:${PORT}`).replace(/:\d+$/, '');
  res.writeHead(301, { location: `https://${host}:${PORT}${req.url ?? '/'}` });
  res.end();
});

const tls = await loadTls(join(DATA_DIR, 'tls'));
const https = createHttpsServer({ key: tls.key, cert: tls.cert }, (req, res) => void handle(req, res));

const wss = new WebSocketServer({ noServer: true });
for (const server of [http, https]) {
  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://localhost').pathname !== '/ws') { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
}
attachSignaling(wss, () => tunnel.start());

// One port for both: a TLS handshake starts with byte 0x16, anything else is plain HTTP.
const listener = createNetServer((socket: Socket) => {
  socket.once('data', (first: Buffer) => {
    socket.pause();
    socket.unshift(first);
    (first[0] === 0x16 ? https : http).emit('connection', socket);
    process.nextTick(() => socket.resume());
  });
  socket.on('error', () => socket.destroy());
});

listener.listen(PORT, () => {
  console.log(`Krieg server on http://localhost:${PORT} (maps: ${MAPS_DIR})`);
  for (const ip of lanAddresses()) console.log(`  on your network: https://${ip}:${PORT}${tls.selfSigned ? ' (self-signed certificate: browsers ask to confirm once)' : ''}`);
  if (tunnel.enabled) console.log('  a public https link is opened when someone hosts an online game (KRIEG_TUNNEL=off to disable)');
});
