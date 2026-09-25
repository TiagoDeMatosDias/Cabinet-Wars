import { parseConfig, type GameView, type Intent, type MapConfig, type NationId } from '@krieg/engine';
import { idb } from '../storage/idb';
import { unpackBundle } from '../storage/bundle';
import { loadServerMap, mapHash, type MapBundle } from '../maps';
import type { ChatMsg, HostMsg, PeerMsg, PlayerInfo, SeatInfo } from './protocol';
import { base64ToBytes } from './protocol';
import { joinRoom, type Channel, type SignalError } from './rtc';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Session } from './session';

// Per tab (sessionStorage): two tabs of one browser are two players; a reload stays the same one.
const tokenKey = (room: string) => `krieg:token:${room}`;
/** How long a peer keeps trying to get back to a host that went away. */
const RECONNECT_FOR_MS = 5 * 60_000;
const RETRY_MS = 2500;

type Welcome = Extract<HostMsg, { t: 'welcome' }>;

/** Connection state of a joined game. */
export type PeerLink = 'connected' | 'reconnecting' | 'ended' | 'replaced' | 'kicked' | 'lost' | 'left';

/** The host removed this player: rejoining is refused. */
class KickedError extends Error {
  readonly code = 'kicked';
  constructor() { super(t('net.link.kicked')); }
}

function storedToken(room: string): string | null {
  try { return sessionStorage.getItem(tokenKey(room)); } catch { return null; }
}

/**
 * Connects to `room` and says hello. Messages the host sends before the caller takes over the
 * channel are handed to `early`.
 */
async function handshake(room: string, name: string, early: (msg: HostMsg) => void): Promise<{ channel: Channel; welcome: Welcome }> {
  const channel = await joinRoom(room);
  const welcome = await new Promise<Welcome>((resolve, reject) => {
    channel.onmessage = (msg: HostMsg) => {
      if (msg.t === 'welcome') resolve(msg);
      else if (msg.t === 'kicked') reject(new KickedError());
      else early(msg);
    };
    channel.onclose = () => reject(new Error(t('net.hostClosed')));
    channel.send({ t: 'hello', token: storedToken(room), name } satisfies PeerMsg);
  });
  try { sessionStorage.setItem(tokenKey(room), welcome.token); } catch { /* storage unavailable */ }
  return { channel, welcome };
}

/** A browser that joined someone else's game. It only ever sees its filtered view. */
export class PeerSession implements Session {
  readonly isHost = false;
  private lobbySeats: SeatInfo[] = [];
  private lobbyPlayers: PlayerInfo[] = [];
  private chatLog: ChatMsg[] = [];
  private timers: Record<NationId, number> = {};
  private isStarted = false;
  private currentView: GameView | null = null;
  private mySeats: NationId[] = [];
  private acting: NationId | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private emitter = new Emitter();
  link: PeerLink = 'connected';

  private constructor(public room: string, private channel: Channel, readonly map: MapBundle, readonly config: MapConfig, private name: string) {}

  static async join(room: string, name: string, onProgress: (msg: string) => void): Promise<PeerSession> {
    room = room.trim().toUpperCase();
    onProgress(t('join.connecting'));
    const early: HostMsg[] = [];
    const { channel, welcome } = await handshake(room, name, (m) => early.push(m));

    onProgress(t('join.loadingMap'));
    // A map this browser played before is kept by its hash, so rejoining downloads nothing.
    const key = `hash:${welcome.map.hash}`;
    let map = await idb.get<MapBundle>('maps', key).catch(() => undefined);
    if (!map && welcome.map.kind === 'server') {
      map = await loadServerMap(welcome.map.id, (share) => onProgress(t('join.loadingMapShare', { pct: Math.round(share * 100) }))).catch(() => undefined);
      if (map && (await mapHash(map)) !== welcome.map.hash) map = undefined; // server copy differs from the host's
      if (map) await idb.put('maps', { ...map, id: key }).catch(() => {});
    }
    if (!map) {
      onProgress(t('join.downloading'));
      const data = await new Promise<string>((resolve, reject) => {
        channel.onmessage = (msg: HostMsg) => { if (msg.t === 'map') resolve(msg.data); else early.push(msg); };
        channel.onclose = () => reject(new Error(t('net.hostClosed')));
        channel.send({ t: 'getMap' } satisfies PeerMsg);
      });
      const bundle = await unpackBundle(new Blob([base64ToBytes(data)]), `hash:${welcome.map.hash}`);
      map = bundle.map;
      await idb.put('maps', map).catch(() => {});
    }
    const session = new PeerSession(room, channel, map, parseConfig(map.config), name);
    session.use(channel);
    for (const m of early) session.handle(m);
    return session;
  }

  private use(channel: Channel) {
    this.channel = channel;
    channel.onmessage = (msg: HostMsg) => this.handle(msg);
    channel.onclose = (reason) => {
      if (this.channel !== channel) return;
      this.dropWaiting();
      if (this.link === 'replaced' || this.link === 'kicked' || this.link === 'left') return;
      if (reason === 'ended') this.setLink('ended');
      else void this.reconnect();
    };
  }

  private dropWaiting() {
    for (const w of this.waiting.values()) w.reject(new Error(t('net.reconnecting')));
    this.waiting.clear();
  }

  private setLink(link: PeerLink) {
    this.link = link;
    this.emitter.emit();
  }

  /** Gets back into the room after the link dropped: the host may be reloading, or the network. */
  private async reconnect() {
    this.setLink('reconnecting');
    const until = Date.now() + RECONNECT_FOR_MS;
    let first = true;
    while (this.link === 'reconnecting' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, first ? 500 : RETRY_MS));
      first = false;
      if (this.link !== 'reconnecting') return;
      const early: HostMsg[] = [];
      try {
        const { channel } = await handshake(this.room, this.name, (m) => early.push(m));
        if (this.link !== 'reconnecting') { channel.close(); return; }
        this.use(channel);
        this.link = 'connected';
        for (const m of early) this.handle(m);
        this.emitter.emit();
        return;
      } catch (e) {
        const code = (e as SignalError).code;
        if (code === 'no-room') { this.setLink('ended'); return; }
        if (code === 'kicked') { this.setLink('kicked'); return; }
      }
    }
    if (this.link === 'reconnecting') this.setLink('lost');
  }

  private handle(msg: HostMsg) {
    if (msg.t === 'lobby') {
      this.lobbySeats = msg.seats;
      this.lobbyPlayers = msg.players;
      this.isStarted = msg.started;
      const now = Date.now();
      this.timers = Object.fromEntries(Object.entries(msg.timers ?? {}).map(([n, ms]) => [n, now + ms]));
      this.mySeats = msg.seats.filter((s) => s.holder === 'you').map((s) => s.nation);
    } else if (msg.t === 'view') {
      this.currentView = msg.view;
      this.mySeats = msg.seats;
    } else if (msg.t === 'chat') {
      this.chatLog = msg.reset ? msg.msgs : [...this.chatLog, ...msg.msgs];
    } else if (msg.t === 'replaced' || msg.t === 'kicked') {
      this.setLink(msg.t);
      this.channel.close();
      return;
    } else if (msg.t === 'result') {
      const w = this.waiting.get(msg.id);
      this.waiting.delete(msg.id);
      if (msg.error) w?.reject(Object.assign(new Error(msg.error), { template: msg.template, params: msg.params }));
      else w?.resolve();
      return;
    } else return;
    this.acting = pickActingSeat(this.currentView, this.mySeats, this.acting);
    this.emitter.emit();
  }

  seats() { return this.lobbySeats; }
  players() { return this.lobbyPlayers; }
  chat() { return this.chatLog; }
  deadlines() { return this.link === 'connected' ? this.timers : {}; }
  started() { return this.isStarted; }
  localSeats() { return this.mySeats; }
  actingSeat() { return this.acting; }
  view() { return this.isStarted ? this.currentView : null; }
  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }
  claim(nation: NationId) { this.channel.send({ t: 'claim', nation } satisfies PeerMsg); }
  release(nation: NationId) { this.channel.send({ t: 'release', nation } satisfies PeerMsg); }
  sendChat(text: string) { this.channel.send({ t: 'chat', text } satisfies PeerMsg); }

  leave() {
    this.link = 'left';
    this.channel.close();
    try { sessionStorage.removeItem(tokenKey(this.room)); } catch { /* storage unavailable */ }
  }

  send(intent: Intent): Promise<void> {
    const seat = this.acting;
    if (!seat) return Promise.reject(new Error('No seat to act for'));
    if (this.link !== 'connected') return Promise.reject(new Error(t('net.reconnecting')));
    const id = this.nextId++;
    this.channel.send({ t: 'intent', id, seat, intent } satisfies PeerMsg);
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  status() {
    if (this.link !== 'connected') return t(`net.link.${this.link}`);
    return t('net.roomPeer', { room: this.room, mode: this.channel.mode });
  }
}
