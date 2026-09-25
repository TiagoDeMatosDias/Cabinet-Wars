import {
  advanceCopy, aiFallback, aiIntent, aiRole, apply, filterForSeats, initialState, newAiMemory, randomOracle, replay,
  type AiMemory, type GameState, type GameView, type Intent, type LogEntry, type MapConfig, type NationId,
} from '@cabinet-wars/engine';
import {
  CHAT_MAX_LENGTH, COLOR_CHOICES, DEFAULT_SETTINGS, AFK_CHOICES,
  type ChatMsg, type LobbyInfo, type PlayerInfo, type SeatInfo, type TableSettings,
} from './protocol';

/** Holder of a seat played by the computer. */
export const AI = 'ai';
/** The host's player id. */
export const HOST = 'host';
/** Pause between computer moves, so people can follow them. */
const AI_DELAY_MS = 350;
/** Chat lines kept (and sent to players who join). */
const CHAT_KEEP = 300;

export function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / max) * max;
  do crypto.getRandomValues(buf); while (buf[0] >= limit);
  return buf[0] % max;
}

interface Player {
  id: string;
  /** Secret: proves who a reconnecting player is. Never sent to other players. */
  token: string;
  name: string;
  online: boolean;
}

/** What it takes to carry on a table later (after a reload, or a server restart). */
export interface TableSnapshot {
  log: LogEntry[];
  holders: Record<NationId, string | null>;
  players: { id: string; token: string; name: string }[];
  kicked: string[];
  chat: ChatMsg[];
  started: boolean;
  settings: TableSettings;
  colors: Record<NationId, string>;
}

/** A refused action, carrying its English template so each browser can translate it. */
export class TableError extends Error {
  constructor(readonly template: string, readonly params: Record<string, string | number> = {}) { super(template); }
}

/**
 * A game and the people at it: the authoritative rules state and its log, all randomness, the
 * computer players, who holds which nation, the chat, and the idle clock. The server runs one
 * per online game; the browser runs one for games played on this device (`local`).
 *
 * Players are identified by id; the host is `HOST`. The owner tells the table who is online and
 * relays what it announces through `onChange`, `onChat` and `onDismiss`.
 */
export class Table {
  private state: GameState;
  private log: LogEntry[];
  private initial: GameState;
  /** The map's config with the players' colors. */
  config: MapConfig;
  /** nation → player id | AI | null (open) */
  private holders: Record<NationId, string | null>;
  private players = new Map<string, Player>();
  private kicked = new Set<string>();
  private chatLog: ChatMsg[] = [];
  private isStarted = false;
  settings: TableSettings = { ...DEFAULT_SETTINGS };
  private colors: Record<NationId, string> = {};
  private aiMemory = new Map<NationId, AiMemory>();
  private aiTimer: ReturnType<typeof setTimeout> | null = null;
  /** Refused computer moves in a row: stops a confused AI from looping forever. */
  private aiFailures = 0;
  /** Human nations with a prompt to answer, and since when they have been idle. */
  private idleSince = new Map<NationId, number>();
  private idleTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;
  private readonly local: boolean;

  /** Something every player should see changed (seats, players, the game). */
  onChange: (() => void) | null = null;
  onChat: ((line: ChatMsg) => void) | null = null;
  /** A player must be sent away (kicked). */
  onDismiss: ((playerId: string, reason: 'kicked') => void) | null = null;

  constructor(
    private readonly baseConfig: MapConfig,
    opts: {
      hostName: string;
      log?: LogEntry[];
      aiSeats?: NationId[];
      settings?: Partial<TableSettings>;
      snapshot?: TableSnapshot;
      /** A game on this device: no idle clock, no chat notices. */
      local?: boolean;
    },
  ) {
    this.local = Boolean(opts.local);
    const snap = opts.snapshot;
    this.holders = Object.fromEntries(baseConfig.nations.map((n) => [n.id, opts.aiSeats?.includes(n.id) ? AI : this.local ? HOST : null]));
    this.players.set(HOST, { id: HOST, token: crypto.randomUUID(), name: opts.hostName, online: true });
    if (opts.settings) this.settings = sanitizeSettings({ ...this.settings, ...opts.settings });
    if (snap) {
      this.holders = { ...this.holders, ...snap.holders };
      this.players = new Map(snap.players.map((p) => [p.id, { ...p, online: false }]));
      this.kicked = new Set(snap.kicked);
      this.chatLog = snap.chat;
      this.isStarted = snap.started;
      this.settings = sanitizeSettings({ ...DEFAULT_SETTINGS, ...snap.settings });
      this.colors = snap.colors ?? {};
    }
    this.log = [...(snap?.log ?? opts.log ?? [])];
    this.config = this.colored();
    this.initial = initialState(this.config);
    this.state = this.log.length ? replay(this.initial, this.log) : advanceCopy(this.initial);
    this.runOracle();
  }

  /** Stops the table's timers: it is being put away. */
  dispose() {
    this.disposed = true;
    if (this.aiTimer) clearTimeout(this.aiTimer);
    this.stopIdleTimer();
  }

  snapshot(): TableSnapshot {
    return {
      log: this.log,
      holders: this.holders,
      players: [...this.players.values()].map(({ id, token, name }) => ({ id, token, name })),
      kicked: [...this.kicked],
      chat: this.chatLog,
      started: this.isStarted,
      settings: this.settings,
      colors: this.colors,
    };
  }

  // ---- reading -----------------------------------------------------------------

  started() { return this.isStarted; }
  entries(): LogEntry[] { return this.log; }
  gameState(): GameState { return this.state; }
  chat(): ChatMsg[] { return this.chatLog; }
  hostToken() { return this.players.get(HOST)!.token; }
  playerName(id: string) { return this.players.get(id)?.name; }
  isOnline(id: string) { return Boolean(this.players.get(id)?.online); }
  playerIds() { return [...this.players.keys()]; }

  seatsOf(holder: string): NationId[] {
    return Object.keys(this.holders).filter((n) => this.holders[n] === holder);
  }

  aiSeats(): NationId[] { return this.seatsOf(AI); }

  /** Who played each nation, for a save's notes. */
  seatNames(): Record<NationId, string> {
    return Object.fromEntries(Object.entries(this.holders).map(([n, h]) => [n, h === AI ? 'ai' : h ? this.players.get(h)?.name ?? 'open' : 'open']));
  }

  /** The game as one player may see it: their own nations' view. */
  viewFor(id: string, seats = this.seatsOf(id)): GameView {
    return filterForSeats(this.state, seats);
  }

  lobbyFor(id: string): LobbyInfo {
    const now = Date.now();
    return {
      seats: this.seatsFor(id),
      players: this.playersFor(id),
      started: this.isStarted,
      settings: this.settings,
      colors: Object.fromEntries(this.config.nations.map((n) => [n.id, n.color])),
      // Time left rather than a clock time: the players' clocks may not agree with this one.
      timers: Object.fromEntries(Object.entries(this.deadlines()).map(([n, at]) => [n, at - now])),
    };
  }

  private seatsFor(id: string): SeatInfo[] {
    return this.config.nations.map((n) => {
      const h = this.holders[n.id];
      const player = h && h !== AI ? this.players.get(h) : undefined;
      const holder: SeatInfo['holder'] = h === null ? null : h === AI ? 'ai' : h === id ? 'you' : h === HOST ? 'host' : 'other';
      return {
        nation: n.id, name: n.name, color: n.color, side: this.config.rules.mode === 'freeForAll' ? 'attacker' : n.side, holder,
        label: player?.name, offline: player ? !player.online : undefined, aiRole: aiRole(this.state, n.id),
      };
    });
  }

  private playersFor(id: string): PlayerInfo[] {
    return [...this.players.values()].map((p) => ({
      id: p.id, name: p.name, host: p.id === HOST, you: p.id === id, online: p.online, nations: this.seatsOf(p.id),
    }));
  }

  // ---- players ------------------------------------------------------------------

  /**
   * Someone arrives: the player whose `token` it is, or a new player. Returns null when they may
   * not sit at this table (kicked, or a started game that allows no spectators).
   */
  join(token: string | null, name: string): { player: string; token: string } | { refused: 'kicked' | 'noSpectators' } {
    if (token && this.kicked.has(token)) return { refused: 'kicked' };
    let p = token ? [...this.players.values()].find((x) => x.token === token) : undefined;
    if (!p) {
      if (this.isStarted && !this.settings.allowSpectators) return { refused: 'noSpectators' };
      p = { id: crypto.randomUUID().slice(0, 8), token: crypto.randomUUID(), name: '', online: false };
      this.players.set(p.id, p);
    }
    const cleaned = name.trim().slice(0, 40);
    if (cleaned || !p.name) p.name = this.uniqueName(cleaned || 'Guest', p.id);
    return { player: p.id, token: p.token };
  }

  /** The owner reports a player connecting or disconnecting. */
  setOnline(id: string, online: boolean, isNew = false) {
    const p = this.players.get(id);
    if (!p || p.online === online) return;
    p.online = online;
    this.notice(online ? (isNew ? 'chat.joined' : 'chat.rejoined') : 'chat.left', { name: p.name });
    this.changed();
  }

  /** A name nobody else at the table uses. */
  private uniqueName(name: string, id: string): string {
    const taken = new Set([...this.players.values()].filter((p) => p.id !== id).map((p) => p.name));
    if (!taken.has(name)) return name;
    let i = 2;
    while (taken.has(`${name} (${i})`)) i++;
    return `${name} (${i})`;
  }

  private requireHost(by: string) {
    if (by !== HOST) throw new TableError('Only the host can do that');
  }

  private requireLobby() {
    if (this.isStarted) throw new TableError('The game has already started');
  }

  /** Removes a player before the game starts; their nations open up and they cannot come back. */
  kick(by: string, id: string) {
    this.requireHost(by);
    this.requireLobby();
    const p = this.players.get(id);
    if (!p || id === HOST) return;
    for (const n of this.seatsOf(id)) this.holders[n] = null;
    this.kicked.add(p.token);
    this.players.delete(id);
    this.notice('chat.kicked', { name: p.name });
    this.onDismiss?.(id, 'kicked');
    this.changed();
  }

  // ---- seats & settings -----------------------------------------------------------

  /** A player takes an open nation (the host may also take one from the computer). */
  claim(by: string, nation: NationId) {
    this.requireLobby();
    const h = this.holders[nation];
    if (h === undefined) throw new TableError('Unknown nation');
    if (h === null || (h === AI && by === HOST)) this.setHolder(nation, by);
  }

  /**
   * A player gives up their nation. The host may also open one the computer plays, or one whose
   * player is offline.
   */
  release(by: string, nation: NationId) {
    this.requireLobby();
    const h = this.holders[nation];
    const offline = h && h !== AI && !this.players.get(h)?.online;
    if (h === by || (by === HOST && (h === AI || offline))) this.setHolder(nation, null);
  }

  /** The host hands an open nation, or one of their own, to the computer. */
  setAi(by: string, nation: NationId) {
    this.requireHost(by);
    this.requireLobby();
    const h = this.holders[nation];
    if (h === HOST || h === null) this.setHolder(nation, AI);
  }

  private setHolder(nation: NationId, holder: string | null) {
    if (this.holders[nation] === holder) return;
    this.holders[nation] = holder;
    const name = holder && holder !== AI ? this.players.get(holder)?.name : undefined;
    if (holder === AI) this.notice('chat.aiTook', { nation });
    else if (name) this.notice('chat.took', { name, nation });
    else this.notice('chat.opened', { nation });
    this.changed();
  }

  setSettings(by: string, settings: Partial<TableSettings>) {
    this.requireHost(by);
    this.settings = sanitizeSettings({ ...this.settings, ...settings });
    this.changed();
  }

  /**
   * Changes a nation's color (null: back to the map's). A player may color their own nations,
   * the host any. Two nations cannot share a color.
   */
  setColor(by: string, nation: NationId, color: string | null) {
    this.requireLobby();
    if (by !== HOST && this.holders[nation] !== by) throw new TableError('That nation is not yours');
    if (color !== null) {
      color = color.toLowerCase();
      if (!(COLOR_CHOICES as readonly string[]).includes(color)) throw new TableError('Not one of the colors to choose from');
      if (this.config.nations.some((n) => n.id !== nation && n.color.toLowerCase() === color)) throw new TableError('Another nation already has that color');
      this.colors[nation] = color;
    } else delete this.colors[nation];
    // Colors are part of the game's state: build it again (the log replays the same).
    this.config = this.colored();
    this.initial = initialState(this.config);
    this.state = replay(this.initial, this.log);
    this.changed();
  }

  private colored(): MapConfig {
    return { ...this.baseConfig, nations: this.baseConfig.nations.map((n) => ({ ...n, color: this.colors[n.id] ?? n.color })) };
  }

  /** The host starts the game; nations nobody took are played by the host. */
  start(by: string) {
    this.requireHost(by);
    if (this.isStarted) return;
    for (const n of Object.keys(this.holders)) if (this.holders[n] === null) this.holders[n] = HOST;
    this.isStarted = true;
    this.notice('chat.started');
    this.changed();
  }

  // ---- chat -------------------------------------------------------------------------

  say(by: string, text: string) {
    const p = this.players.get(by);
    text = String(text ?? '').trim().slice(0, CHAT_MAX_LENGTH);
    if (!p || !text) return;
    this.addLine({ by, from: p.name, nations: this.seatsOf(by), text });
  }

  private notice(key: string, params: Record<string, string> = {}) {
    if (!this.local) this.addLine({ key, params });
  }

  private addLine(msg: Omit<ChatMsg, 'id' | 'at'>) {
    const line: ChatMsg = { id: (this.chatLog.at(-1)?.id ?? 0) + 1, at: Date.now(), ...msg };
    this.chatLog = [...this.chatLog, line].slice(-CHAT_KEEP);
    this.onChat?.(line);
  }

  // ---- game ---------------------------------------------------------------------------

  /** A player acts for one of their nations. Throws (with the engine's message) on anything illegal. */
  act(by: string, seat: NationId, intent: Intent) {
    if (this.holders[seat] !== by) throw new TableError('That seat is not yours');
    this.apply(seat, intent);
  }

  private apply(seat: NationId, intent: Intent) {
    if (!this.isStarted) throw new TableError('The game has not started');
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
      const entry: LogEntry = { seq: this.log.length, by: 'host', intent: randomOracle(this.state.oracle, randomInt) };
      this.state = apply(this.state, entry);
      this.log.push(entry);
    }
  }

  private changed() {
    if (this.disposed) return;
    this.updateIdle();
    this.onChange?.();
    this.scheduleAi();
  }

  // ---- computer players --------------------------------------------------------------

  /** The first computer seat with something to do, if any. */
  private aiPending(): NationId | null {
    if (!this.isStarted || this.state.phase === 'gameOver' || this.state.oracle) return null;
    return this.state.pending.find((p) => this.holders[p.nation] === AI)?.nation ?? null;
  }

  private scheduleAi() {
    if (this.aiTimer || !this.aiPending() || this.disposed) return;
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
      this.apply(nation, intent);
      this.aiFailures = 0;
    } catch (e) {
      // A hidden army can block a planned move; the AI has already moved on from that army.
      console.warn(`AI ${nation}: ${(e as Error).message}`, intent);
      if (++this.aiFailures > 20) { console.error(`AI ${nation} is stuck`); return; }
      if (intent.type !== 'move' && intent.type !== 'split' && intent.type !== 'merge') {
        try { this.apply(nation, aiFallback(view, nation)); } catch (e2) { console.error(`AI ${nation}: ${(e2 as Error).message}`); }
      }
      this.scheduleAi();
    }
  }

  // ---- idle players --------------------------------------------------------------------

  /** When each idle clock runs out, as this machine's time. */
  deadlines(): Record<NationId, number> {
    const limit = this.settings.afkMinutes * 60_000;
    return Object.fromEntries([...this.idleSince].map(([n, since]) => [n, since + limit]));
  }

  /** Starts a clock for each human nation that now has to answer, and drops the others. */
  private updateIdle() {
    const now = Date.now();
    const live = !this.local && this.settings.afkMinutes > 0 && this.isStarted && this.state.phase !== 'gameOver' && !this.state.oracle;
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
    const limit = this.settings.afkMinutes * 60_000;
    for (const [nation, since] of this.idleSince) {
      if (now - since < limit) continue;
      this.notice('chat.afk', { nation, minutes: String(this.settings.afkMinutes) });
      try {
        this.apply(nation, aiFallback(this.state, nation));
      } catch (e) {
        console.warn(`AFK ${nation}: ${(e as Error).message}`);
        this.idleSince.set(nation, now);
      }
      return; // one at a time: the state has changed
    }
  }
}

function sanitizeSettings(s: TableSettings): TableSettings {
  return {
    afkMinutes: (AFK_CHOICES as readonly number[]).includes(Number(s.afkMinutes)) ? Number(s.afkMinutes) : DEFAULT_SETTINGS.afkMinutes,
    allowSpectators: Boolean(s.allowSpectators),
    listed: Boolean(s.listed),
  };
}
