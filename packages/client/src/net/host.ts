import {
  advanceCopy, aiFallback, aiIntent, aiRole, apply, filterForSeats, initialState, newAiMemory, replay,
  type AiMemory, type GameState, type GameView, type Intent, type LogEntry, type MapConfig, type NationId, type OracleEntry,
} from '@krieg/engine';
import type { MapBundle } from '../maps';
import { packBundle, type SaveMeta } from '../storage/bundle';
import type { ChatMsg, HostMsg, MapRef, PeerMsg, PlayerInfo, SeatInfo } from './protocol';
import { bytesToBase64, CHAT_MAX_LENGTH } from './protocol';
import type { Channel, HostedRoom } from './rtc';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Session } from './session';

const LOCAL = 'local';
/** Holder of a seat played by the computer. */
const AI = 'ai';
/** Pause between computer moves, so people can follow them. */
const AI_DELAY_MS = 350;
/** Chat lines kept (and sent to players who join). */
const CHAT_KEEP = 300;
/** A player who does nothing for this long in an online game is moved on (their turn ends). */
export const AFK_MS = 5 * 60_000;

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
  /** Secret: proves who a reconnecting player is. Never sent to other players. */
  token: string;
  /** Public: names the player to the others (e.g. for the host to kick). */
  id: string;
  name: string;
  channel: Channel | null;
}

/** What it takes to carry on hosting after this page reloads (see net/hosting.ts). */
export interface HostSnapshot {
  log: LogEntry[];
  holders: Record<NationId, string | null>;
  peers: { token: string; id?: string; name: string }[];
  /** Tokens of kicked players, who may not come back. */
  kicked?: string[];
  chat: ChatMsg[];
  started: boolean;
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
  /** nation → 'local' | 'ai' | peer token | null (free) */
  private holders: Record<NationId, string | null>;
  private aiMemory = new Map<NationId, AiMemory>();
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** Refused computer moves in a row: stops a confused AI from looping forever. */
  private aiFailures = 0;
  private peers = new Map<string, Peer>();
  private isStarted = false;
  private acting: NationId | null = null;
  private cachedView: GameView | null = null;
  private emitter = new Emitter();
  private chatLog: ChatMsg[] = [];
  private hosted: HostedRoom | null = null;
  private kicked = new Set<string>();
  /** Human nations with a prompt to answer, and since when they have been idle. */
  private idleSince = new Map<NationId, number>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  /** Called after every change, to keep the game resumable (see net/hosting.ts). */
  onPersist: (() => void) | null = null;
  onLeave: (() => void) | null = null;

  constructor(
    readonly map: MapBundle, readonly config: MapConfig, readonly mapRef: MapRef, log: LogEntry[] = [], aiSeats: NationId[] = [],
    /** The host's name, as other players see it. */
    public hostName = 'Host',
    restored?: HostSnapshot,
  ) {
    this.initial = initialState(config);
    if (restored) log = restored.log;
    this.log = [...log];
    this.state = log.length ? replay(this.initial, log) : advanceCopy(this.initial);
    this.holders = Object.fromEntries(config.nations.map((n) => [n.id, aiSeats.includes(n.id) ? AI : LOCAL]));
    if (restored) {
      this.holders = { ...this.holders, ...restored.holders };
      for (const p of restored.peers) this.peers.set(p.token, { id: crypto.randomUUID().slice(0, 8), ...p, channel: null });
      this.kicked = new Set(restored.kicked ?? []);
      this.chatLog = restored.chat;
      this.isStarted = restored.started;
    }
    this.runOracle();
  }

  /** Puts the game online in `hosted`'s room. */
  goOnline(hosted: HostedRoom) {
    this.hosted = hosted;
    this.room = hosted.room;
    this.changed();
  }

  get secret() { return this.hosted?.secret ?? null; }

  /** The game was online, but its room has closed. */
  get roomClosed() { return Boolean(this.room) && !this.hosted; }

  snapshot(): HostSnapshot {
    return {
      log: this.log,
      holders: this.holders,
      peers: [...this.peers.values()].map((p) => ({ token: p.token, id: p.id, name: p.name })),
      kicked: [...this.kicked],
      chat: this.chatLog,
      started: this.isStarted,
    };
  }

  /** Ends the online room for everyone. */
  leave() {
    this.stopIdleTimer();
    this.onLeave?.();
    this.hosted?.close();
    this.hosted = null;
  }

  /** The room is gone (expired, or taken over by another tab): the game carries on here only. */
  goOffline() {
    this.stopIdleTimer();
    this.onPersist = null;
    this.hosted = null;
    for (const p of this.peers.values()) p.channel = null;
    this.changed();
  }

  // ---- players & chat ------------------------------------------------------

  private seatsOf(holder: string): NationId[] {
    return Object.keys(this.holders).filter((n) => this.holders[n] === holder);
  }

  players(): PlayerInfo[] {
    return this.playersFor(null);
  }

  private playersFor(token: string | null): PlayerInfo[] {
    return [
      { id: 'host', name: this.hostName, host: true, you: token === null, online: true, nations: this.seatsOf(LOCAL) },
      ...[...this.peers.values()].map((p) => ({ id: p.id, name: p.name, host: false, you: p.token === token, online: Boolean(p.channel), nations: this.seatsOf(p.token) })),
    ];
  }

  chat() { return this.chatLog; }

  sendChat(text: string) {
    this.say({ from: this.hostName, nations: this.seatsOf(LOCAL), text });
  }

  private say(msg: Omit<ChatMsg, 'id' | 'at'>) {
    if (msg.text !== undefined) {
      msg.text = msg.text.trim().slice(0, CHAT_MAX_LENGTH);
      if (!msg.text) return;
    }
    // Notices only matter when others are here to read them.
    if (msg.key && !this.room) return;
    const line: ChatMsg = { id: (this.chatLog.at(-1)?.id ?? 0) + 1, at: Date.now(), ...msg };
    this.chatLog = [...this.chatLog, line].slice(-CHAT_KEEP);
    for (const peer of this.peers.values()) this.sendTo(peer, { t: 'chat', msgs: [line] });
    this.onPersist?.();
    this.emitter.emit();
  }

  /** A notice about a seat changing hands. */
  private seatNotice(nation: NationId, holder: string | null) {
    const name = holder === LOCAL ? this.hostName : holder && holder !== AI ? this.peers.get(holder)?.name : undefined;
    if (holder === AI) this.say({ key: 'chat.aiTook', params: { nation } });
    else if (name) this.say({ key: 'chat.took', params: { name, nation } });
    else this.say({ key: 'chat.opened', params: { nation } });
  }

  /** Removes a player from the lobby; their nations open up and they cannot rejoin. */
  kick(id: string) {
    const peer = [...this.peers.values()].find((p) => p.id === id);
    if (!peer || this.isStarted) return;
    for (const n of this.seatsOf(peer.token)) this.holders[n] = null;
    this.kicked.add(peer.token);
    this.peers.delete(peer.token);
    this.dismiss(peer.channel, { t: 'kicked' });
    peer.channel = null;
    this.say({ key: 'chat.kicked', params: { name: peer.name } });
    this.changed();
  }

  /** Tells a channel why it is being closed, then closes it once the message is out. */
  private dismiss(channel: Channel | null, msg: HostMsg) {
    if (!channel) return;
    channel.send(msg);
    setTimeout(() => channel.close(), 500);
  }

  /** A name nobody else in the room uses. */
  private uniqueName(name: string, token: string): string {
    const taken = new Set([this.hostName, ...[...this.peers.values()].filter((p) => p.token !== token).map((p) => p.name)]);
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
  }

  // ---- lobby -------------------------------------------------------------

  seats(): SeatInfo[] {
    return this.seatsFor(null);
  }

  private seatsFor(token: string | null): SeatInfo[] {
    return this.config.nations.map((n) => {
      const h = this.holders[n.id];
      const holder: SeatInfo['holder'] = h === null ? null : h === AI ? 'ai' : h === LOCAL ? (token ? 'host' : 'you') : h === token ? 'you' : 'other';
      const peer = h && h !== LOCAL && h !== AI ? this.peers.get(h) : undefined;
      return {
        nation: n.id, name: n.name, color: n.color, side: this.config.rules.mode === 'freeForAll' ? 'attacker' : n.side, holder,
        label: peer?.name, offline: peer ? !peer.channel : undefined,
        aiRole: aiRole(this.state, n.id),
      };
    });
  }

  started() { return this.isStarted; }

  /** Host toggles a seat between local play and open for a remote player. */
  claim(nation: NationId) { this.setHolder(nation, LOCAL); }
  /** Opens a seat played here or by the computer, or one whose remote player is offline. */
  release(nation: NationId) {
    const h = this.holders[nation];
    if (h === LOCAL || h === AI || (h && !this.peers.get(h)?.channel)) this.setHolder(nation, null);
  }
  /** Host hands a seat that is played here or still open to the computer. */
  setAi(nation: NationId) {
    const h = this.holders[nation];
    if (h === LOCAL || h === null) this.setHolder(nation, AI);
  }

  private setHolder(nation: NationId, holder: string | null) {
    if (this.holders[nation] === holder) return;
    this.holders[nation] = holder;
    this.seatNotice(nation, holder);
    this.changed();
  }

  start() {
    for (const n of Object.keys(this.holders)) if (this.holders[n] === null) this.holders[n] = LOCAL;
    this.isStarted = true;
    this.say({ key: 'chat.started' });
    this.changed();
  }

  // ---- peers -------------------------------------------------------------

  addChannel(channel: Channel) {
    let peer: Peer | null = null;
    channel.onmessage = (msg: PeerMsg) => {
      if (msg.t === 'hello') {
        if (msg.token && this.kicked.has(msg.token)) { this.dismiss(channel, { t: 'kicked' }); return; }
        const existing = msg.token ? this.peers.get(msg.token) : undefined;
        // The same player connecting again (reload, other tab): the newest connection wins.
        if (existing?.channel && existing.channel !== channel) {
          const old = existing.channel;
          existing.channel = null;
          this.dismiss(old, { t: 'replaced' });
        }
        const wasOnline = Boolean(existing?.channel);
        peer = existing ?? { token: crypto.randomUUID(), id: crypto.randomUUID().slice(0, 8), name: '', channel };
        peer.channel = channel;
        peer.name = this.uniqueName(String(msg.name ?? '').trim().slice(0, 40) || peer.name || t('lobby.guest'), peer.token);
        this.peers.set(peer.token, peer);
        this.sendTo(peer, { t: 'welcome', token: peer.token, map: this.mapRef });
        this.sendTo(peer, { t: 'chat', msgs: this.chatLog, reset: true });
        if (!wasOnline) this.say({ key: existing ? 'chat.rejoined' : 'chat.joined', params: { name: peer.name } });
        this.changed();
        return;
      }
      if (!peer) return;
      if (msg.t === 'getMap') {
        void packBundle({ map: this.map }).then(async (blob) => {
          this.sendTo(peer!, { t: 'map', data: bytesToBase64(new Uint8Array(await blob.arrayBuffer())) });
        });
      } else if (msg.t === 'claim') {
        if (this.holders[msg.nation] === null && !this.isStarted) this.setHolder(msg.nation, peer.token);
      } else if (msg.t === 'release') {
        if (this.holders[msg.nation] === peer.token && !this.isStarted) this.setHolder(msg.nation, null);
      } else if (msg.t === 'chat') {
        if (typeof msg.text === 'string') this.say({ from: peer.name, nations: this.seatsOf(peer.token), text: msg.text });
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
      if (!peer || peer.channel !== channel) return;
      peer.channel = null;
      this.say({ key: 'chat.left', params: { name: peer.name } });
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

  aiSeats(): NationId[] {
    return Object.keys(this.holders).filter((n) => this.holders[n] === AI);
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
    // Any action counts as being at the table.
    this.idleSince.set(seat, Date.now());
    this.runOracle();
    this.changed();
  }

  /** Answers every pending random request with fresh randomness and records it. */
  private runOracle() {
    while (this.state.oracle) {
      const o = this.state.oracle;
      const intent: OracleEntry = o.kind === 'shuffle'
        ? { type: 'shuffle', deck: o.deck, order: shuffleOrder(o.n) }
        : o.kind === 'select'
          ? {
              // The fighting units, and a random enemy unit for each attacking one to face.
              type: 'select',
              attacker: shuffleOrder(o.attacker).slice(0, o.attackerPick),
              defender: shuffleOrder(o.defender).slice(0, o.defenderPick),
              targets: Array.from({ length: o.attackerPick }, () => randomInt(o.defenderPick)),
            }
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

  // ---- computer players ----------------------------------------------------

  /** The first computer seat with something to do, if any. */
  private aiPending(): NationId | null {
    if (!this.isStarted || this.state.phase === 'gameOver' || this.state.oracle) return null;
    return this.state.pending.find((p) => this.holders[p.nation] === AI)?.nation ?? null;
  }

  private scheduleAi() {
    if (this.aiTimer || !this.aiPending()) return;
    this.aiTimer = setTimeout(() => { this.aiTimer = null; this.aiStep(); }, AI_DELAY_MS);
  }

  /** One computer move, decided from that nation's own view (it sees no more than a player would). */
  private aiStep() {
    const nation = this.aiPending();
    if (!nation) return;
    let memory = this.aiMemory.get(nation);
    if (!memory) this.aiMemory.set(nation, memory = newAiMemory());
    const view = filterForSeats(this.state, [nation]);
    const intent = aiIntent(view, nation, memory);
    try {
      this.act(nation, intent);
      this.aiFailures = 0;
    } catch (e) {
      // A hidden army can block a planned move; the AI has already moved on from that army.
      console.warn(`AI ${nation}: ${(e as Error).message}`, intent);
      if (++this.aiFailures > 20) { console.error(`AI ${nation} is stuck`); return; }
      if (intent.type !== 'move' && intent.type !== 'split' && intent.type !== 'merge') {
        try { this.act(nation, aiFallback(view, nation)); } catch (e2) { console.error(`AI ${nation}: ${(e2 as Error).message}`); }
      }
      this.scheduleAi();
    }
  }

  // ---- idle players ---------------------------------------------------------

  /** When each idle clock runs out, as this browser's time. */
  deadlines(): Record<NationId, number> {
    return Object.fromEntries([...this.idleSince].map(([n, since]) => [n, since + AFK_MS]));
  }

  /** Starts a clock for each human nation that now has to answer, and drops the others. */
  private updateIdle() {
    const now = Date.now();
    const live = this.isStarted && this.hosted && this.state.phase !== 'gameOver' && !this.state.oracle;
    const waiting = new Set(live ? this.state.pending.filter((p) => this.holders[p.nation] !== AI).map((p) => p.nation) : []);
    for (const n of [...this.idleSince.keys()]) if (!waiting.has(n)) this.idleSince.delete(n);
    for (const n of waiting) if (!this.idleSince.has(n)) this.idleSince.set(n, now);
    if (waiting.size && !this.idleTimer) this.idleTimer = setInterval(() => this.checkIdle(), 1000);
    else if (!waiting.size) this.stopIdleTimer();
  }

  private stopIdleTimer() {
    if (this.idleTimer) clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  /** Answers for a player whose clock ran out: the same default the computer falls back on. */
  private checkIdle() {
    const now = Date.now();
    for (const [nation, since] of this.idleSince) {
      if (now - since < AFK_MS) continue;
      this.say({ key: 'chat.afk', params: { nation } });
      try {
        this.act(nation, aiFallback(this.state, nation));
      } catch (e) {
        console.warn(`AFK ${nation}: ${(e as Error).message}`);
        this.idleSince.set(nation, now);
      }
      return; // one at a time: the state has changed
    }
  }

  private changed() {
    this.updateIdle();
    const local = this.localSeats();
    this.acting = pickActingSeat(this.state as GameView, local, this.acting);
    // Nobody plays here (only computers): watch the whole game.
    const watching = local.length ? (this.acting ? [this.acting] : local) : Object.keys(this.holders);
    this.cachedView = filterForSeats(this.state, watching);
    // Time left rather than a clock time: the players' clocks may not agree with this one.
    const now = Date.now();
    const timers = Object.fromEntries(Object.entries(this.deadlines()).map(([n, at]) => [n, at - now]));
    for (const peer of this.peers.values()) {
      if (!peer.channel) continue;
      this.sendTo(peer, { t: 'lobby', seats: this.seatsFor(peer.token), players: this.playersFor(peer.token), started: this.isStarted, timers });
      // Players without a nation watch with no view beyond what everyone knows.
      const seats = this.seatsOf(peer.token);
      if (this.isStarted) this.sendTo(peer, { t: 'view', view: filterForSeats(this.state, seats), seats });
    }
    this.onPersist?.();
    this.emitter.emit();
    this.scheduleAi();
  }

  status() {
    const online = [...this.peers.values()].filter((p) => p.channel);
    if (!this.room) return t('net.local');
    if (this.roomClosed) return t('net.roomEnded');
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
      seats: Object.fromEntries(Object.entries(this.holders).map(([n, h]) => [n, h === LOCAL ? 'host' : h === AI ? 'ai' : this.peers.get(h ?? '')?.name ?? 'open'])),
    };
    return { blob: await packBundle({ map: this.map, log: this.log, meta }), meta };
  }
}
