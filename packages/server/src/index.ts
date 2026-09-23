import { createReadStream } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { createServer, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { attachSignaling } from './signaling';

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
const MAPS_DIR = process.env.KRIEG_MAPS ?? join(ROOT, 'Map');
const SAVES_DIR = process.env.KRIEG_SAVES ?? join(ROOT, 'saves');
const THEMES_DIR = process.env.KRIEG_THEMES ?? join(ROOT, 'themes');
const CLIENT_DIR = join(ROOT, 'packages/client/dist');
const PORT = Number(process.env.PORT ?? 8787);

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

async function sendFile(res: ServerResponse, path: string | null) {
  try {
    if (!path || !(await stat(path)).isFile()) throw new Error('not a file');
  } catch {
    json(res, 404, { error: 'Not found' });
    return;
  }
  res.writeHead(200, { 'content-type': TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream' });
  createReadStream(path).pipe(res);
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean);
  try {
    if (parts[0] === 'api') {
      if (parts[1] === 'maps' && parts.length === 2) return json(res, 200, await listMaps());
      if (parts[1] === 'maps' && parts.length >= 4) return sendFile(res, safeJoin(MAPS_DIR, parts.slice(2).join('/')));
      if (parts[1] === 'themes' && parts.length === 2) return json(res, 200, await listThemes());
      if (parts[1] === 'themes' && parts.length >= 4) return sendFile(res, safeJoin(THEMES_DIR, parts.slice(2).join('/')));
      if (parts[1] === 'saves' && parts.length === 2) return json(res, 200, await listSaves());
      if (parts[1] === 'saves' && parts.length === 3) return sendFile(res, safeJoin(SAVES_DIR, parts[2]));
      return json(res, 404, { error: 'Not found' });
    }
    const file = safeJoin(CLIENT_DIR, url.pathname === '/' ? 'index.html' : url.pathname.slice(1));
    if (file && (await stat(file).catch(() => null))?.isFile()) return sendFile(res, file);
    return sendFile(res, join(CLIENT_DIR, 'index.html'));
  } catch (err) {
    json(res, 500, { error: String(err) });
  }
});

attachSignaling(new WebSocketServer({ server, path: '/ws' }));
server.listen(PORT, () => console.log(`Krieg server on http://localhost:${PORT} (maps: ${MAPS_DIR})`));
