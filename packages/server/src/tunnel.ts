import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { env } from './env';

/**
 * A public HTTPS address for this server, so players on other networks can join: a Cloudflare
 * quick tunnel (https://<random>.trycloudflare.com, no account needed). The `cloudflared` program
 * is used from the PATH, or downloaded once into `binDir`. Set CABINET_WARS_TUNNEL=off to never open one.
 */
export interface TunnelStatus {
  state: 'off' | 'starting' | 'ready' | 'failed';
  url?: string;
  error?: string;
}

const RELEASES = 'https://github.com/cloudflare/cloudflared/releases/latest/download/';
const RESTART_MS = 5000;

function asset(): string | null {
  const arch = ({ x64: 'amd64', arm64: 'arm64', arm: 'arm', ia32: '386' } as Record<string, string>)[process.arch];
  if (!arch) return null;
  if (process.platform === 'linux') return `cloudflared-linux-${arch}`;
  if (process.platform === 'darwin') return `cloudflared-darwin-${arch}.tgz`;
  if (process.platform === 'win32') return `cloudflared-windows-${arch}.exe`;
  return null;
}

async function exists(path: string) {
  return (await stat(path).catch(() => null))?.isFile() ?? false;
}

async function findCloudflared(binDir: string): Promise<string> {
  const onPath = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  if (onPath.status === 0) return 'cloudflared';
  const exe = join(binDir, process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');
  if (await exists(exe)) return exe;

  const name = asset();
  if (!name) throw new Error(`no cloudflared download for ${process.platform}/${process.arch}`);
  console.log(`Downloading cloudflared (${name}) for the public game link…`);
  const res = await fetch(RELEASES + name);
  if (!res.ok) throw new Error(`cloudflared download failed: HTTP ${res.status}`);
  await mkdir(binDir, { recursive: true });
  const tmp = join(binDir, `${name}.part`);
  await writeFile(tmp, new Uint8Array(await res.arrayBuffer()));
  if (name.endsWith('.tgz')) {
    const tar = spawnSync('tar', ['-xzf', tmp, '-C', binDir]);
    await rm(tmp);
    if (tar.status !== 0) throw new Error('could not unpack cloudflared');
  } else await rename(tmp, exe);
  await chmod(exe, 0o755);
  return exe;
}

export class Tunnel {
  private status: TunnelStatus = { state: 'off' };
  private child: ChildProcess | null = null;
  private waiters: (() => void)[] = [];
  private stopped = false;

  constructor(private readonly originPort: number, private readonly binDir: string) {
    process.on('exit', () => this.child?.kill());
  }

  get enabled() { return !/^(0|off|false|no)$/i.test(env('TUNNEL') ?? ''); }

  current(): TunnelStatus { return this.status; }

  /** Opens the tunnel if it is not open or opening yet. */
  start() {
    if (!this.enabled || this.status.state === 'starting' || this.status.state === 'ready') return;
    this.stopped = false;
    this.set({ state: 'starting' });
    void this.run().catch((e) => this.set({ state: 'failed', error: String((e as Error).message ?? e) }));
  }

  /** Resolves once the tunnel is ready or has failed, or after `ms`. */
  wait(ms: number): Promise<TunnelStatus> {
    if (this.status.state !== 'starting') return Promise.resolve(this.status);
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); resolve(this.status); };
      const timer = setTimeout(() => { this.waiters = this.waiters.filter((w) => w !== done); resolve(this.status); }, ms);
      this.waiters.push(done);
    });
  }

  private set(s: TunnelStatus) {
    this.status = s;
    if (s.state === 'ready') console.log(`Public game link: ${s.url}`);
    if (s.state === 'failed') console.warn(`No public game link: ${s.error}`);
    if (s.state !== 'starting') { for (const w of this.waiters.splice(0)) w(); }
  }

  private async run() {
    const exe = await findCloudflared(this.binDir);
    const child = spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.originPort}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    let url: string | undefined;
    let log = '';
    const onOutput = (chunk: Buffer) => {
      const text = String(chunk);
      log = (log + text).slice(-2000);
      url ??= text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
      if (url && this.status.state === 'starting' && /Registered tunnel connection/.test(text)) void this.verify(url);
    };
    child.stdout!.on('data', onOutput);
    child.stderr!.on('data', onOutput);
    child.on('error', (e) => this.set({ state: 'failed', error: e.message }));
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.stopped) return;
      // A tunnel that worked and then dropped is opened again (with a new address).
      const wasReady = this.status.state === 'ready';
      this.set({ state: 'failed', error: `cloudflared exited (${code}): ${log.trim().split('\n').pop() ?? ''}` });
      if (wasReady) setTimeout(() => this.start(), RESTART_MS);
    });
  }

  /**
   * The address is announced before its DNS name exists. Asking the local resolver too early
   * gets a "no such name" answer that routers keep for minutes, so ask Cloudflare's resolver
   * directly until the name is there.
   */
  private async verify(url: string) {
    const resolver = new Resolver({ timeout: 3000, tries: 1 });
    resolver.setServers(['1.1.1.1', '1.0.0.1']);
    const host = new URL(url).hostname;
    for (let i = 0; i < 30 && this.status.state === 'starting'; i++) {
      if ((await resolver.resolve4(host).catch(() => [])).length) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    await new Promise((r) => setTimeout(r, 1000));
    if (this.status.state === 'starting') this.set({ state: 'ready', url });
  }

  stop() {
    this.stopped = true;
    this.child?.kill();
    this.child = null;
    this.set({ state: 'off' });
  }
}
