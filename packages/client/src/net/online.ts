import { parseConfig, type GameView, type Intent, type LogEntry, type MapConfig, type NationId } from '@cabinet-wars/engine';
import {
  DEFAULT_SETTINGS,
  type ChatMsg, type ClientMsg, type DismissReason, type GameListing, type MapRef, type PlayerInfo, type SeatInfo, type ServerMsg, type TableSettings,
} from '@cabinet-wars/table';
import { loadServerMap, mapHash, type MapBundle } from '../maps';
import { packBundle, unpackBundle } from '../storage/bundle';
import { idb } from '../storage/idb';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Link, type Session } from './session';

/** How long a player keeps trying to get back to the server after the connection dropped. */
const RECONNECT_FOR_MS = 5 * 60_000;
const RETRY_MS = 2500;
const PING_MS = 25_000;

type Welcome = Extract<ServerMsg, { t: 'welcome' }>;

// ---- the games this browser plays ------------------------------------------------------

/**
 * Each tab is its own player (sessionStorage), so a friend can join from another tab; a reload
 * stays the same player. The games are also listed in localStorage, so the menu can offer to go
 * back to them later.
 */
const tokenKey = (room: string) => `krieg:token:${room}`;
const GAMES_KEY = 'krieg:games';

export interface MyGame { room: string; token: string; host: boolean; mapName: string; date: string }

export function myGames(): MyGame[] {
  try { return JSON.parse(localStorage.getItem(GAMES_KEY) ?? '[]') as MyGame[]; } catch { return []; }
}

function rememberGame(g: MyGame) {
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify([g, ...myGames().filter((x) => x.room !== g.room)].slice(0, 20)));
    sessionStorage.setItem(tokenKey(g.room), g.token);
  } catch { /* storage unavailable */ }
}

export function forgetGame(room: string) {
  try {
    localStorage.setItem(GAMES_KEY, JSON.stringify(myGames().filter((x) => x.room !== room)));
    sessionStorage.removeItem(tokenKey(room));
  } catch { /* storage unavailable */ }
}

function tabToken(room: string): string | null {
  try { return sessionStorage.getItem(tokenKey(room)); } catch { return null; }
}

/** Games on this server that others may join. */
export async function listGames(): Promise<GameListing[]> {
  try { const r = await fetch('/api/games'); return r.ok ? await r.json() : []; } catch { return []; }
}

export async function gameInfo(room: string): Promise<GameListing | null> {
  try { const r = await fetch(`/api/games/${encodeURIComponent(room)}`); return r.ok ? await r.json() : null; } catch { return null; }
}

// ---- connection -------------------------------------------------------------------------

/** Why joining failed; `reason` says whether trying again can help. */
export class JoinError extends Error {
  constructor(readonly reason: DismissReason | 'offline' | 'invalid', message = t(`net.dismissed.${reason}`)) { super(message); }
}

/** A socket to the server, answering its pings and delivering messages in order. */
class Connection {
  onmessage: ((msg: ServerMsg) => void) | null = null;
  onclose: (() => void) | null = null;
  private ping: ReturnType<typeof setInterval>;

  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => this.onmessage?.(JSON.parse(String(e.data)) as ServerMsg);
    ws.onclose = () => { clearInterval(this.ping); this.onclose?.(); };
    // Proxies (such as the public tunnel) close sockets that stay silent.
    this.ping = setInterval(() => this.send({ t: 'ping' }), PING_MS);
  }

  static open(): Promise<Connection> {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Connection(ws));
      ws.onerror = () => reject(new JoinError('offline', t('net.offline')));
    });
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }
  send(msg: ClientMsg) { if (this.open) this.ws.send(JSON.stringify(msg)); }
  close() { this.onclose = null; this.ws.close(); }
}

/**
 * Sends `first` (create or join) and waits for the welcome. Messages that arrive before the
 * caller takes over go to `early`.
 */
async function handshake(first: ClientMsg, early: (msg: ServerMsg) => void): Promise<{ conn: Connection; welcome: Welcome }> {
  const conn = await Connection.open();
  const welcome = await new Promise<Welcome>((resolve, reject) => {
    conn.onmessage = (msg) => {
      if (msg.t === 'welcome') resolve(msg);
      else if (msg.t === 'dismissed') reject(new JoinError(msg.reason));
      else if (msg.t === 'error') reject(new JoinError('invalid', msg.message));
      else early(msg);
    };
    conn.onclose = () => reject(new JoinError('offline', t('net.offline')));
    conn.send(first);
  });
  return { conn, welcome };
}

// ---- maps -------------------------------------------------------------------------------

async function mapRefFor(map: MapBundle, onProgress: (msg: string) => void): Promise<MapRef> {
  const hash = await mapHash(map);
  if (map.source === 'server' && map.id.startsWith('server:')) return { kind: 'server', id: map.id.slice('server:'.length), hash };
  // A map from this browser: the server keeps a copy for the other players.
  onProgress(t('host.uploading'));
  const res = await fetch(`/api/uploads/${hash}`, { method: 'PUT', body: await packBundle({ map }) });
  if (!res.ok) throw new Error(t('host.uploadFailed', { status: res.status }));
  return { kind: 'upload', hash, name: map.name };
}

/** Downloads a file, reporting the share received so far. */
async function fetchWithProgress(url: string, onShare: (share: number) => void): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(t('join.mapMissing'));
  const total = Number(res.headers.get('content-length') ?? 0);
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (total) onShare(got / total);
  }
  return new Blob(chunks);
}

/**
 * The game's map: kept from an earlier game by its hash, or downloaded from the server. The hash
 * covers the game's config (with the host's rules), so a server map is checked with that config.
 */
async function loadMap(ref: MapRef, config: Record<string, unknown>, onProgress: (msg: string) => void): Promise<MapBundle> {
  const key = `hash:${ref.hash}`;
  const kept = await idb.get<MapBundle>('maps', key).catch(() => undefined);
  if (kept) return kept;
  const share = (s: number) => onProgress(t('join.loadingMapShare', { pct: Math.round(s * 100) }));
  onProgress(t('join.loadingMap'));
  let map: MapBundle | undefined;
  if (ref.kind === 'server') {
    map = await loadServerMap(ref.id, share).catch(() => undefined);
    if (map && (await mapHash({ ...map, config })) !== ref.hash) map = undefined; // the server's copy was changed since
  }
  if (!map) map = (await unpackBundle(await fetchWithProgress(`/api/uploads/${ref.hash}`, share), key)).map;
  map = { ...map, id: key };
  await idb.put('maps', map).catch(() => {});
  return map;
}

// ---- the session --------------------------------------------------------------------------

/** A game played through the server, by this browser's player (the host or anyone else). */
export class OnlineSession implements Session {
  readonly online = true;
  link: Link = 'connected';
  isHost: boolean;
  readonly config: MapConfig;
  private token: string;
  private me: string;
  private lobbySeats: SeatInfo[] = [];
  private lobbyPlayers: PlayerInfo[] = [];
  private tableSettings: TableSettings = { ...DEFAULT_SETTINGS };
  private chatLog: ChatMsg[] = [];
  private timers: Record<NationId, number> = {};
  private isStarted = false;
  private currentView: GameView | null = null;
  private mySeats: NationId[] = [];
  private acting: NationId | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: (v?: unknown) => void; reject: (e: Error) => void }>();
  private logWaiters: ((log: LogEntry[] | null) => void)[] = [];
  private emitter = new Emitter();

  private constructor(public room: string, private conn: Connection, welcome: Welcome, readonly map: MapBundle, private name: string) {
    this.token = welcome.token;
    this.me = welcome.you;
    this.isHost = welcome.host;
    this.config = parseConfig(welcome.config);
  }

  /** Hosts a new online game (or a saved one) on the server. */
  static async create(opts: {
    map: MapBundle; log?: LogEntry[]; aiSeats?: NationId[]; settings?: Partial<TableSettings>; name: string; onProgress: (msg: string) => void;
  }): Promise<OnlineSession> {
    const ref = await mapRefFor(opts.map, opts.onProgress);
    opts.onProgress(t('host.creating'));
    const early: ServerMsg[] = [];
    const { conn, welcome } = await handshake({
      t: 'create', name: opts.name, map: ref, config: opts.map.config, log: opts.log, aiSeats: opts.aiSeats, settings: opts.settings,
    }, (m) => early.push(m));
    // The host's own copy of the map, kept by hash like everyone else's.
    const map = { ...opts.map, id: `hash:${ref.hash}`, config: welcome.config };
    await idb.put('maps', map).catch(() => {});
    return OnlineSession.begin(conn, welcome, map, opts.name, early);
  }

  /** Joins a game; `token` returns as a player this browser was before. */
  static async join(room: string, name: string, onProgress: (msg: string) => void, token = tabToken(room.trim().toUpperCase())): Promise<OnlineSession> {
    room = room.trim().toUpperCase();
    onProgress(t('join.connecting'));
    const early: ServerMsg[] = [];
    const { conn, welcome } = await handshake({ t: 'join', room, token, name }, (m) => early.push(m));
    // Kept at once: if loading the map fails, trying again is the same player.
    try { sessionStorage.setItem(tokenKey(welcome.room), welcome.token); } catch { /* storage unavailable */ }
    // Hold the game's messages while the map loads.
    conn.onmessage = (m) => early.push(m);
    let map: MapBundle;
    try { map = { ...(await loadMap(welcome.map, welcome.config, onProgress)), config: welcome.config }; } catch (e) { conn.close(); throw e; }
    return OnlineSession.begin(conn, welcome, map, name, early);
  }

  private static begin(conn: Connection, welcome: Welcome, map: MapBundle, name: string, early: ServerMsg[]) {
    const s = new OnlineSession(welcome.room, conn, welcome, map, name);
    rememberGame({ room: welcome.room, token: welcome.token, host: welcome.host, mapName: map.name, date: new Date().toISOString() });
    s.use(conn);
    for (const m of early) s.handle(m);
    return s;
  }

  private use(conn: Connection) {
    this.conn = conn;
    conn.onmessage = (msg) => this.handle(msg);
    conn.onclose = () => {
      if (this.conn !== conn) return;
      this.dropWaiting();
      if (this.link === 'connected') void this.reconnect();
    };
  }

  private dropWaiting() {
    for (const w of this.waiting.values()) w.reject(new Error(t('net.reconnecting')));
    this.waiting.clear();
  }

  private setLink(link: Link) {
    this.link = link;
    if (link !== 'connected' && link !== 'reconnecting' && link !== 'lost') forgetGame(this.room);
    this.emitter.emit();
  }

  /** Gets back to the table after the connection dropped (network trouble, server restart). */
  private async reconnect() {
    this.setLink('reconnecting');
    const until = Date.now() + RECONNECT_FOR_MS;
    let first = true;
    while (this.link === 'reconnecting' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, first ? 500 : RETRY_MS));
      first = false;
      const early: ServerMsg[] = [];
      try {
        const { conn } = await handshake({ t: 'join', room: this.room, token: this.token, name: this.name }, (m) => early.push(m));
        if (this.link !== 'reconnecting') { conn.close(); return; }
        this.use(conn);
        this.link = 'connected';
        for (const m of early) this.handle(m);
        this.emitter.emit();
        return;
      } catch (e) {
        const reason = (e as JoinError).reason;
        if (reason && reason !== 'offline') { this.setLink(reason === 'noRoom' ? 'ended' : reason === 'invalid' ? 'lost' : reason); return; }
      }
    }
    if (this.link === 'reconnecting') this.setLink('lost');
  }

  private handle(msg: ServerMsg) {
    switch (msg.t) {
      case 'lobby': {
        this.lobbySeats = msg.seats;
        this.lobbyPlayers = msg.players;
        this.isStarted = msg.started;
        this.tableSettings = msg.settings;
        const now = Date.now();
        this.timers = Object.fromEntries(Object.entries(msg.timers).map(([n, ms]) => [n, now + ms]));
        for (const n of this.config.nations) if (msg.colors[n.id]) n.color = msg.colors[n.id];
        this.mySeats = msg.seats.filter((s) => s.holder === 'you').map((s) => s.nation);
        break;
      }
      case 'view':
        this.currentView = msg.view;
        this.mySeats = msg.seats;
        break;
      case 'chat':
        this.chatLog = msg.reset ? msg.msgs : [...this.chatLog, ...msg.msgs];
        break;
      case 'log':
        for (const w of this.logWaiters.splice(0)) w(msg.log);
        return;
      case 'dismissed':
        this.setLink(msg.reason === 'noRoom' ? 'ended' : msg.reason);
        this.conn.close();
        return;
      case 'error':
        this.emitter.emit();
        window.dispatchEvent(new CustomEvent('cabinet-wars:error', { detail: msg.message }));
        return;
      case 'result': {
        const w = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        if (msg.error) w?.reject(Object.assign(new Error(msg.error), { template: msg.template, params: msg.params }));
        else w?.resolve();
        return;
      }
      default: return;
    }
    this.acting = pickActingSeat(this.currentView, this.mySeats, this.acting);
    this.emitter.emit();
  }

  you() { return this.me; }
  seats() { return this.lobbySeats; }
  players() { return this.lobbyPlayers; }
  settings() { return this.tableSettings; }
  chat() { return this.chatLog; }
  deadlines() { return this.link === 'connected' ? this.timers : {}; }
  started() { return this.isStarted; }
  localSeats() { return this.mySeats; }
  actingSeat() { return this.acting; }
  view() { return this.isStarted ? this.currentView : null; }
  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }
  claim(nation: NationId) { this.conn.send({ t: 'claim', nation }); }
  release(nation: NationId) { this.conn.send({ t: 'release', nation }); }
  setAi(nation: NationId) { this.conn.send({ t: 'setAi', nation }); }
  kick(player: string) { this.conn.send({ t: 'kick', player }); }
  start() { this.conn.send({ t: 'start' }); }
  setSettings(settings: Partial<TableSettings>) { this.conn.send({ t: 'settings', settings }); }
  setColor(nation: NationId, color: string | null) { this.conn.send({ t: 'color', nation, color }); }
  sendChat(text: string) { this.conn.send({ t: 'chat', text }); }

  /** The log is everyone's once the game is over (before, it would show what the fog hides). */
  entries(): Promise<LogEntry[] | null> {
    if (this.link !== 'connected' || this.currentView?.phase !== 'gameOver') return Promise.resolve(null);
    return new Promise((resolve) => {
      this.logWaiters.push(resolve);
      this.conn.send({ t: 'getLog' });
      setTimeout(() => resolve(null), 10_000);
    });
  }

  leave() {
    this.link = 'left';
    this.conn.close();
  }

  end() {
    this.conn.send({ t: 'end' });
    forgetGame(this.room);
    this.leave();
  }

  send(intent: Intent): Promise<void> {
    const seat = this.acting;
    if (!seat) return Promise.reject(new Error('No seat to act for'));
    if (this.link !== 'connected') return Promise.reject(new Error(t('net.reconnecting')));
    const id = this.nextId++;
    this.conn.send({ t: 'intent', id, seat, intent });
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve: () => resolve(), reject }));
  }

  status() {
    if (this.link !== 'connected') return t(`net.link.${this.link}`);
    return t('net.roomOnline', { room: this.room, count: this.lobbyPlayers.filter((p) => p.online).length });
  }
}
