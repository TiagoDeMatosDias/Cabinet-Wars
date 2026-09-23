import { parseConfig, type GameView, type Intent, type MapConfig, type NationId } from '@krieg/engine';
import { idb } from '../storage/idb';
import { unpackBundle } from '../storage/bundle';
import { loadServerMap, mapHash, type MapBundle } from '../maps';
import type { HostMsg, PeerMsg, SeatInfo } from './protocol';
import { base64ToBytes } from './protocol';
import { joinRoom, type Channel } from './rtc';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Session } from './session';

const tokenKey = (room: string) => `krieg:token:${room}`;

/** A browser that joined someone else's game. It only ever sees its filtered view. */
export class PeerSession implements Session {
  readonly isHost = false;
  private lobbySeats: SeatInfo[] = [];
  private isStarted = false;
  private currentView: GameView | null = null;
  private mySeats: NationId[] = [];
  private acting: NationId | null = null;
  private nextId = 1;
  private waiting = new Map<number, { resolve: () => void; reject: (e: Error) => void }>();
  private emitter = new Emitter();
  private closed = false;

  private constructor(public room: string | null, private channel: Channel, readonly map: MapBundle, readonly config: MapConfig) {}

  static async join(room: string, name: string, onProgress: (msg: string) => void): Promise<PeerSession> {
    room = room.trim().toUpperCase();
    onProgress(t('join.connecting'));
    const channel = await joinRoom(room);
    const early: HostMsg[] = [];
    let session: PeerSession | null = null;
    const welcome = await new Promise<Extract<HostMsg, { t: 'welcome' }>>((resolve, reject) => {
      channel.onmessage = (msg: HostMsg) => {
        if (session) session.handle(msg);
        else if (msg.t === 'welcome') resolve(msg);
        else early.push(msg);
      };
      channel.onclose = () => reject(new Error('The host closed the connection'));
      let token: string | null = null;
      try { token = localStorage.getItem(tokenKey(room)); } catch { /* storage unavailable */ }
      channel.send({ t: 'hello', token, name } satisfies PeerMsg);
    });
    try { localStorage.setItem(tokenKey(room), welcome.token); } catch { /* storage unavailable */ }

    onProgress(t('join.loadingMap'));
    let map: MapBundle | undefined;
    if (welcome.map.kind === 'server') {
      map = await loadServerMap(welcome.map.id);
      if ((await mapHash(map)) !== welcome.map.hash) map = undefined; // server copy differs from the host's
    }
    map ??= await idb.get<MapBundle>('maps', `hash:${welcome.map.hash}`);
    if (!map) {
      onProgress(t('join.downloading'));
      const data = await new Promise<string>((resolve) => {
        const prev = channel.onmessage;
        channel.onmessage = (msg: HostMsg) => { if (msg.t === 'map') resolve(msg.data); else prev?.(msg); };
        channel.send({ t: 'getMap' } satisfies PeerMsg);
      });
      const bundle = await unpackBundle(new Blob([base64ToBytes(data)]), `hash:${welcome.map.hash}`);
      map = bundle.map;
      await idb.put('maps', map).catch(() => {});
    }
    session = new PeerSession(room, channel, map, parseConfig(map.config));
    channel.onmessage = (msg: HostMsg) => session!.handle(msg);
    channel.onclose = () => { session!.closed = true; session!.emitter.emit(); };
    for (const m of early) session.handle(m);
    return session;
  }

  private handle(msg: HostMsg) {
    if (msg.t === 'lobby') {
      this.lobbySeats = msg.seats;
      this.isStarted = msg.started;
      this.mySeats = msg.seats.filter((s) => s.holder === 'you').map((s) => s.nation);
    } else if (msg.t === 'view') {
      this.currentView = msg.view;
      this.mySeats = msg.seats;
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
  started() { return this.isStarted; }
  localSeats() { return this.mySeats; }
  actingSeat() { return this.acting; }
  view() { return this.isStarted ? this.currentView : null; }
  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }
  claim(nation: NationId) { this.channel.send({ t: 'claim', nation } satisfies PeerMsg); }
  release(nation: NationId) { this.channel.send({ t: 'release', nation } satisfies PeerMsg); }

  send(intent: Intent): Promise<void> {
    const seat = this.acting;
    if (!seat) return Promise.reject(new Error('No seat to act for'));
    const id = this.nextId++;
    this.channel.send({ t: 'intent', id, seat, intent } satisfies PeerMsg);
    return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
  }

  status() {
    return this.closed ? t('net.disconnected') : t('net.roomPeer', { room: this.room ?? '', mode: this.channel.mode });
  }
}
