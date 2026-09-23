import {
  advanceCopy, apply, filterForSeats, initialState, replay, type GameState, type GameView, type Intent, type LogEntry,
  type MapConfig, type NationId, type OracleEntry,
} from '@krieg/engine';
import type { MapBundle } from '../maps';
import { packBundle, type SaveMeta } from '../storage/bundle';
import type { HostMsg, MapRef, PeerMsg, SeatInfo } from './protocol';
import { bytesToBase64 } from './protocol';
import type { Channel } from './rtc';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Session } from './session';

const LOCAL = 'local';

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

function shuffleOrder(n: number): number[] {
  const order = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

interface Peer {
  token: string;
  name: string;
  channel: Channel | null;
}

/**
 * The authoritative game. Runs the engine, generates all randomness, keeps the full log and
 * sends each connected peer only its own filtered view.
 */
export class HostSession implements Session {
  readonly isHost = true;
  room: string | null = null;
  private state: GameState;
  private log: LogEntry[];
  private readonly initial: GameState;
  /** nation → 'local' | peer token | null (free) */
  private holders: Record<NationId, string | null>;
  private peers = new Map<string, Peer>();
  private isStarted = false;
  private acting: NationId | null = null;
  private cachedView: GameView | null = null;
  private emitter = new Emitter();

  constructor(readonly map: MapBundle, readonly config: MapConfig, private mapRef: MapRef, log: LogEntry[] = []) {
    this.initial = initialState(config);
    this.log = [...log];
    this.state = log.length ? replay(this.initial, log) : advanceCopy(this.initial);
    this.holders = Object.fromEntries(config.nations.map((n) => [n.id, LOCAL]));
    this.runOracle();
  }

  // ---- lobby -------------------------------------------------------------

  seats(): SeatInfo[] {
    return this.seatsFor(null);
  }

  private seatsFor(token: string | null): SeatInfo[] {
    return this.config.nations.map((n) => {
      const h = this.holders[n.id];
      const holder: SeatInfo['holder'] = h === null ? null : h === LOCAL ? (token ? 'host' : 'you') : h === token ? 'you' : 'other';
      const label = h && h !== LOCAL ? this.peers.get(h)?.name : undefined;
      return { nation: n.id, name: n.name, color: n.color, side: this.config.rules.mode === 'freeForAll' ? 'attacker' : n.side, holder, label };
    });
  }

  started() { return this.isStarted; }

  /** Host toggles a seat between local play and open for a remote player. */
  claim(nation: NationId) { this.holders[nation] = LOCAL; this.changed(); }
  release(nation: NationId) { if (this.holders[nation] === LOCAL) this.holders[nation] = null; this.changed(); }

  start() {
    for (const n of Object.keys(this.holders)) if (this.holders[n] === null) this.holders[n] = LOCAL;
    this.isStarted = true;
    this.changed();
  }

  // ---- peers -------------------------------------------------------------

  addChannel(channel: Channel) {
    let peer: Peer | null = null;
    channel.onmessage = (msg: PeerMsg) => {
      if (msg.t === 'hello') {
        const existing = msg.token ? this.peers.get(msg.token) : undefined;
        peer = existing ?? { token: crypto.randomUUID(), name: msg.name || 'Guest', channel };
        peer.channel = channel;
        peer.name = msg.name || peer.name;
        this.peers.set(peer.token, peer);
        this.sendTo(peer, { t: 'welcome', token: peer.token, map: this.mapRef });
        this.changed();
        return;
      }
      if (!peer) return;
      if (msg.t === 'getMap') {
        void packBundle({ map: this.map }).then(async (blob) => {
          this.sendTo(peer!, { t: 'map', data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
        });
      } else if (msg.t === 'claim') {
        if (this.holders[msg.nation] === null) { this.holders[msg.nation] = peer.token; this.changed(); }
      } else if (msg.t === 'release') {
        if (this.holders[msg.nation] === peer.token) { this.holders[msg.nation] = null; this.changed(); }
      } else if (msg.t === 'intent') {
        let error: string | null = null;
        let template: string | undefined;
        let params: Record<string, string | number> | undefined;
        if (this.holders[msg.seat] !== peer.token) error = template = 'That seat is not yours';
        else {
          try { this.act(msg.seat, msg.intent); } catch (e) {
            // Engine errors carry their English template, so the peer can translate them.
            error = (e as Error).message;
            template = (e as { template?: string }).template;
            params = (e as { params?: Record<string, string | number> }).params;
          }
        }
        this.sendTo(peer, { t: 'result', id: msg.id, error, template, params });
      }
    };
    channel.onclose = () => {
      if (peer) peer.channel = null;
      this.changed();
    };
  }

  private sendTo(peer: Peer, msg: HostMsg) {
    peer.channel?.send(msg);
  }

  // ---- game --------------------------------------------------------------

  localSeats(): NationId[] {
    return Object.keys(this.holders).filter((n) => this.holders[n] === LOCAL);
  }

  actingSeat() {
    return this.acting;
  }

  view() {
    return this.isStarted ? this.cachedView : null;
  }

  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }

  async send(intent: Intent) {
    const seat = this.acting;
    if (!seat) throw new Error('No seat to act for');
    this.act(seat, intent);
  }

  private act(seat: NationId, intent: Intent) {
    if (!this.isStarted) throw new Error('The game has not started');
    const entry: LogEntry = { seq: this.log.length, by: seat, intent };
    this.state = apply(this.state, entry); // throws on illegal moves; nothing is recorded then
    this.log.push(entry);
    this.runOracle();
    this.changed();
  }

  /** Answers every pending random request with fresh randomness and records it. */
  private runOracle() {
    while (this.state.oracle) {
      const o = this.state.oracle;
      const intent: OracleEntry = o.kind === 'shuffle'
        ? { type: 'shuffle', deck: o.deck, order: shuffleOrder(o.n) }
        : {
            type: 'roll',
            attacker: Array.from({ length: o.attacker }, () => randomInt(6) + 1),
            defender: Array.from({ length: o.defender }, () => randomInt(6) + 1),
          };
      const entry: LogEntry = { seq: this.log.length, by: 'host', intent };
      this.state = apply(this.state, entry);
      this.log.push(entry);
    }
  }

  private changed() {
    const local = this.localSeats();
    this.acting = pickActingSeat(this.state as GameView, local, this.acting);
    this.cachedView = filterForSeats(this.state, this.acting ? [this.acting] : local);
    for (const peer of this.peers.values()) {
      if (!peer.channel) continue;
      this.sendTo(peer, { t: 'lobby', seats: this.seatsFor(peer.token), started: this.isStarted });
      const seats = Object.keys(this.holders).filter((n) => this.holders[n] === peer.token);
      if (this.isStarted && seats.length) this.sendTo(peer, { t: 'view', view: filterForSeats(this.state, seats), seats });
    }
    this.emitter.emit();
  }

  status() {
    const online = [...this.peers.values()].filter((p) => p.channel);
    if (!this.room) return t('net.local');
    return t('net.room', { room: this.room, count: online.length, peers: online.map((p) => `${p.name} (${p.channel!.mode})`).join(', ') || t('common.none') });
  }

  // ---- saves -------------------------------------------------------------

  entries(): LogEntry[] {
    return this.log;
  }

  async save(title: string): Promise<{ blob: Blob; meta: SaveMeta }> {
    const meta: SaveMeta = {
      title,
      date: new Date().toISOString(),
      mapName: this.config.name,
      turn: this.state.turn,
      current: this.state.current,
      seats: Object.fromEntries(Object.entries(this.holders).map(([n, h]) => [n, h === LOCAL ? 'host' : this.peers.get(h ?? '')?.name ?? 'open'])),
    };
    return { blob: await packBundle({ map: this.map, log: this.log, meta }), meta };
  }
}
