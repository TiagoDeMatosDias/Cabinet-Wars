#!/usr/bin/env node
/**
 * Makes release packages: Cabinet Wars with everything it needs to run on a computer without
 * internet access and without anything installed.
 *
 *   npm run package                       for this computer's system
 *   npm run package -- win-x64 linux-x64  for these systems
 *   npm run package -- all                for every system below
 *
 * Each package, in release/, is a folder and an archive (.zip for Windows, .tar.gz otherwise):
 *   app/        the built game          server/   the server, bundled into one file, and its launcher
 *   runtime/    Node.js (pinned)        data/bin/ cloudflared (pinned), for the public link
 *   Map/, themes/, saves/, start.bat | start.sh + start.command, README.txt, licenses
 *
 * Making packages needs internet access once, to download Node.js and cloudflared; they are kept
 * in release/.cache, so later packages are made offline. Node.js is checked against its official
 * checksums.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import { build } from 'esbuild';
import { unzipSync, zipSync } from 'fflate';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'release');
const CACHE = join(OUT, '.cache');

/** Pinned: the Node.js the packages run on. */
const NODE_VERSION = '22.23.1';
/** Pinned in the server (packages/server/src/tunnel.ts); read from there so the two agree. */
const CLOUDFLARED_VERSION = readFileSync(join(ROOT, 'packages/server/src/tunnel.ts'), 'utf8').match(/CLOUDFLARED_VERSION = '([^']+)'/)[1];

/** The systems packages are made for: Node.js and cloudflared downloads for each. */
const TARGETS = {
  'win-x64': { node: 'win-x64.zip', cloudflared: 'cloudflared-windows-amd64.exe' },
  'linux-x64': { node: 'linux-x64.tar.gz', cloudflared: 'cloudflared-linux-amd64' },
  'linux-arm64': { node: 'linux-arm64.tar.gz', cloudflared: 'cloudflared-linux-arm64' },
  'darwin-x64': { node: 'darwin-x64.tar.gz', cloudflared: 'cloudflared-darwin-amd64.tgz' },
  'darwin-arm64': { node: 'darwin-arm64.tar.gz', cloudflared: 'cloudflared-darwin-arm64.tgz' },
};

const version = JSON.parse(readFileSync(join(ROOT, 'packages/client/package.json'), 'utf8')).version;

function step(msg) { console.log(`==> ${msg}`); }
function fail(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }

// ---- downloads ---------------------------------------------------------------------------

/** A file from the cache, downloaded first if needed. */
async function cached(url, name) {
  const path = join(CACHE, name);
  if (existsSync(path)) return readFileSync(path);
  step(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) fail(`Download failed (HTTP ${res.status}): ${url}`);
  const data = Buffer.from(await res.arrayBuffer());
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(path, data);
  return data;
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex');

// ---- tar -------------------------------------------------------------------------------------

/** The files of a tar archive: name → { data, mode }. */
function untar(buf) {
  const files = new Map();
  let longName = null;
  for (let off = 0; off + 512 <= buf.length;) {
    const header = buf.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const str = (a, b) => header.subarray(a, b).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(str(124, 136).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = str(345, 500);
    let name = longName ?? (prefix ? `${prefix}/${str(0, 100)}` : str(0, 100));
    longName = null;
    const data = buf.subarray(off + 512, off + 512 + size);
    if (type === 'L') longName = data.toString('utf8').replace(/\0.*$/s, '');
    else if (type === 'x') {
      const path = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      if (path) longName = path[1];
    } else if (type === '0' || type === '7') files.set(name, { data, mode: parseInt(str(100, 108).trim() || '644', 8) });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}

/** A tar archive of the given files ([path, data, mode]), in the ustar format. */
function tar(entries) {
  const blocks = [];
  for (const [path, data, mode] of entries) {
    const header = Buffer.alloc(512);
    // Long paths are split into ustar's prefix (155) and name (100) fields at a slash.
    let name = path;
    let prefix = '';
    if (Buffer.byteLength(path) > 100) {
      const at = [...path.matchAll(/\//g)].map((m) => m.index).find((i) => i <= 155 && Buffer.byteLength(path.slice(i + 1)) <= 100);
      if (at === undefined) fail(`Path too long for the archive: ${path}`);
      prefix = path.slice(0, at);
      name = path.slice(at + 1);
    }
    header.write(name, 0, 100, 'utf8');
    header.write(`${mode.toString(8).padStart(7, '0')}\0`, 100);
    header.write('0000000\0', 108);
    header.write('0000000\0', 116);
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write(`${Math.floor(Date.now() / 1000).toString(8).padStart(11, '0')}\0`, 136);
    header.write('        ', 148);
    header.write('0', 156);
    header.write('ustar\0', 257);
    header.write('00', 263);
    header.write(prefix, 345, 155, 'utf8');
    let sum = 0;
    for (const b of header) sum += b;
    header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
    blocks.push(header, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ---- the parts ----------------------------------------------------------------------------

/** Node.js for a target, checked against the official checksums. */
async function nodeRuntime(target) {
  const file = `node-v${NODE_VERSION}-${TARGETS[target].node}`;
  const base = `https://nodejs.org/dist/v${NODE_VERSION}/`;
  const sums = (await cached(`${base}SHASUMS256.txt`, `node-v${NODE_VERSION}-SHASUMS256.txt`)).toString();
  const archive = await cached(base + file, file);
  const expected = sums.split('\n').find((l) => l.endsWith(`  ${file}`))?.split(' ')[0];
  if (!expected || sha256(archive) !== expected) fail(`Checksum mismatch for ${file}: delete release/.cache and try again.`);
  const dir = file.replace(/\.(zip|tar\.gz)$/, '');
  if (file.endsWith('.zip')) {
    const files = unzipSync(archive, { filter: (f) => f.name === `${dir}/node.exe` || f.name === `${dir}/LICENSE` });
    return { exe: Buffer.from(files[`${dir}/node.exe`]), license: Buffer.from(files[`${dir}/LICENSE`]), name: 'node.exe' };
  }
  const files = untar(gunzipSync(archive));
  return { exe: files.get(`${dir}/bin/node`).data, license: files.get(`${dir}/LICENSE`).data, name: 'node' };
}

/** cloudflared for a target (from the pinned release). */
async function cloudflared(target) {
  const asset = TARGETS[target].cloudflared;
  const data = await cached(`https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`, `cloudflared-${CLOUDFLARED_VERSION}-${asset}`);
  const license = await cached(`https://raw.githubusercontent.com/cloudflare/cloudflared/${CLOUDFLARED_VERSION}/LICENSE`, `cloudflared-${CLOUDFLARED_VERSION}-LICENSE`);
  if (asset.endsWith('.tgz')) {
    const exe = [...untar(gunzipSync(data)).entries()].find(([n]) => n.split('/').pop() === 'cloudflared');
    if (!exe) fail(`No cloudflared in ${asset}`);
    return { exe: exe[1].data, license, name: 'cloudflared' };
  }
  return { exe: data, license, name: asset.endsWith('.exe') ? 'cloudflared.exe' : 'cloudflared' };
}

/** The licenses of every npm package the game ships (in the game or the bundled server). */
function thirdPartyLicenses() {
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8')).packages;
  const out = [];
  for (const [path, info] of Object.entries(lock)) {
    if (!path.startsWith('node_modules/') || info.dev || info.optional || info.link) continue;
    const dir = join(ROOT, path);
    const file = existsSync(dir) && readdirSync(dir).find((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));
    const name = path.slice(path.lastIndexOf('node_modules/') + 13);
    out.push(`${'='.repeat(78)}\n${name} ${info.version} (${info.license ?? 'see package'})\n${'='.repeat(78)}\n\n${file ? readFileSync(join(dir, file), 'utf8').trim() : `License: ${info.license ?? 'unknown'}`}\n`);
  }
  return `Cabinet Wars includes the following open source software.\n\n${out.join('\n')}`;
}

// ---- packaging ------------------------------------------------------------------------------

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

async function main() {
  const asked = process.argv.slice(2).filter((a) => !a.startsWith('-'));
  const here = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
  const targets = asked.includes('all') ? Object.keys(TARGETS) : asked.length ? asked : [here];
  for (const t of targets) if (!TARGETS[t]) fail(`Unknown system "${t}". Choose from: ${Object.keys(TARGETS).join(', ')}, all`);

  step('Building the game…');
  const r = spawnSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.status !== 0) fail('The build failed.');

  step('Bundling the server…');
  const staging = join(OUT, '.staging');
  rmSync(staging, { recursive: true, force: true });
  await build({
    entryPoints: [join(ROOT, 'packages/server/src/index.ts')],
    outfile: join(staging, 'index.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    // ws loads these optional speed-ups if present; it works without them.
    external: ['bufferutil', 'utf-8-validate'],
    // Bundled CommonJS packages call require(): give ES modules one.
    banner: { js: "import { createRequire as __cwRequire } from 'node:module'; const require = __cwRequire(import.meta.url);" },
    legalComments: 'none',
    logLevel: 'warning',
  });
  const licenses = thirdPartyLicenses();

  for (const target of targets) {
    const name = `cabinet-wars-${version}-${target}`;
    step(`Packaging ${name}…`);
    const dir = join(OUT, name);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const windows = target.startsWith('win');
    const execs = new Set();
    const put = (rel, data, exec = false) => {
      mkdirSync(dirname(join(dir, rel)), { recursive: true });
      writeFileSync(join(dir, rel), data);
      if (exec) { execs.add(rel); chmodSync(join(dir, rel), 0o755); }
    };

    cpSync(join(ROOT, 'packages/client/dist'), join(dir, 'app'), { recursive: true });
    cpSync(join(staging, 'index.mjs'), join(dir, 'server/index.mjs'));
    cpSync(join(ROOT, 'scripts/release/start.mjs'), join(dir, 'server/start.mjs'));
    for (const folder of ['Map', 'themes', 'saves']) {
      if (existsSync(join(ROOT, folder))) cpSync(join(ROOT, folder), join(dir, folder), { recursive: true, filter: (p) => !p.endsWith('~') });
      else mkdirSync(join(dir, folder), { recursive: true });
    }
    const node = await nodeRuntime(target);
    put(`runtime/${node.name}`, node.exe, true);
    put('runtime/LICENSE', node.license);
    const cf = await cloudflared(target);
    put(`data/bin/${cf.name}`, cf.exe, true);
    put('data/bin/LICENSE-cloudflared.txt', cf.license);
    if (windows) put('start.bat', readFileSync(join(ROOT, 'scripts/release/start.bat')));
    else {
      put('start.sh', readFileSync(join(ROOT, 'scripts/release/start.sh')), true);
      if (target.startsWith('darwin')) put('start.command', readFileSync(join(ROOT, 'scripts/release/start.command')), true);
    }
    const readme = readFileSync(join(ROOT, 'scripts/release/README.txt'), 'utf8');
    put('README.txt', windows ? readme.replace(/\r?\n/g, '\r\n') : readme);
    put('THIRD_PARTY_LICENSES.txt', licenses);
    put('VERSIONS.txt', `Cabinet Wars ${version}\nNode.js ${NODE_VERSION}\ncloudflared ${CLOUDFLARED_VERSION}\nBuilt ${new Date().toISOString()}\n`);

    // The archive: executables keep their permission bits (the tar's modes; zip for Windows needs none).
    const files = walk(dir).map((abs) => relative(OUT, abs).split(sep).join('/'));
    if (windows) {
      const zip = {};
      // Already-compressed files are stored as they are; the rest compressed.
      for (const f of files) zip[f] = [readFileSync(join(OUT, f)), { level: /\.(png|jpe?g|webp|woff2?|glb|zip|gz|krieg|cabinetwars)$/i.test(f) ? 0 : 6 }];
      writeFileSync(join(OUT, `${name}.zip`), zipSync(zip));
    } else {
      const entries = files.map((f) => [f, readFileSync(join(OUT, f)), execs.has(f.slice(name.length + 1)) ? 0o755 : 0o644]);
      writeFileSync(join(OUT, `${name}.tar.gz`), gzipSync(tar(entries), { level: 6 }));
    }
    const archive = join(OUT, `${name}${windows ? '.zip' : '.tar.gz'}`);
    step(`  ${relative(ROOT, archive)} (${(statSync(archive).size / 1048576).toFixed(0)} MB)`);
  }
  rmSync(staging, { recursive: true, force: true });
}

await main();
