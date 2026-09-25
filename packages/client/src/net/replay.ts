import {
  advanceCopy, apply, filterForSeats, initialState, type GameState, type GameView, type LogEntry, type MapConfig, type NationId,
} from '@krieg/engine';
import type { MapBundle } from '../maps';
import type { SeatInfo } from './protocol';
import { Emitter, type Session } from './session';
import { t } from '../i18n/i18n';

/** A state is kept every this many log entries, so jumping around replays only a few entries. */
const CHECKPOINT_EVERY = 25;

/** What the replay controls show about a position, without keeping its whole state. */
export interface ReplayMark {
  turn: number;
  round: number;
  current: NationId;
}

/**
 * Plays a saved game back. Positions count applied log entries (0 = the game as set up). A
 * "step" is one player action with the dice and card draws that follow it; a "turn" is one
 * nation's turn. The viewer watches everything, or one nation's view with its fog of war.
 */
export class ReplaySession implements Session {
  readonly isHost = false;
  room: string | null = null;
  private readonly checkpoints = new Map<number, GameState>();
  /** Turn, round and nation to play after each number of applied entries. */
  readonly marks: ReplayMark[] = [];
  /** Positions just before a player acts (all host results applied): where Step stops. */
  readonly steps: number[] = [];
  /** First position of each turn. */
  readonly turns: number[] = [];
  private pos = 0;
  private state: GameState;
  private cached: GameView | null = null;
  private emitter = new Emitter();
  /** The nation whose view is shown, or null to see everything. */
  perspective: NationId | null = null;

  constructor(readonly map: MapBundle, readonly config: MapConfig, readonly log: LogEntry[]) {
    let s = advanceCopy(initialState(config));
    const mark = (st: GameState) => this.marks.push({ turn: st.turn, round: st.round, current: st.current });
    this.checkpoints.set(0, s);
    mark(s);
    for (let i = 0; i < log.length; i++) {
      s = apply(s, log[i]);
      if ((i + 1) % CHECKPOINT_EVERY === 0) this.checkpoints.set(i + 1, s);
      mark(s);
    }
    for (let k = 0; k <= log.length; k++) {
      if (k === log.length || log[k].by !== 'host') this.steps.push(k);
      if (k === 0 || this.marks[k].turn !== this.marks[k - 1].turn) this.turns.push(k);
    }
    this.state = this.checkpoints.get(0)!;
    this.seek(0);
  }

  // ---- position -----------------------------------------------------------

  position() { return this.pos; }
  length() { return this.log.length; }

  seek(k: number) {
    k = Math.max(0, Math.min(this.log.length, Math.round(k)));
    let from: number;
    let s: GameState;
    if (k >= this.pos && this.pos > 0) { from = this.pos; s = this.state; } else {
      from = Math.floor(k / CHECKPOINT_EVERY) * CHECKPOINT_EVERY;
      s = this.checkpoints.get(from)!;
    }
    for (let i = from; i < k; i++) s = apply(s, this.log[i]);
    this.state = s;
    this.pos = k;
    this.refresh();
  }

  /** Next or previous step (a player action), or the start of the next or current/previous turn. */
  stepBy(dir: 1 | -1) { this.seek(this.neighbour(this.steps, dir)); }
  turnBy(dir: 1 | -1) { this.seek(this.neighbour(this.turns, dir)); }

  private neighbour(list: number[], dir: 1 | -1): number {
    if (dir > 0) return list.find((k) => k > this.pos) ?? this.log.length;
    return [...list].reverse().find((k) => k < this.pos) ?? 0;
  }

  setPerspective(n: NationId | null) { this.perspective = n; this.refresh(); }

  private refresh() {
    this.cached = filterForSeats(this.state, this.perspective ? [this.perspective] : this.config.nations.map((n) => n.id));
    this.emitter.emit();
  }

  // ---- Session ------------------------------------------------------------

  seats(): SeatInfo[] { return []; }
  started() { return true; }
  localSeats(): NationId[] { return []; }
  actingSeat() { return null; }
  view() { return this.cached; }
  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }
  async send(): Promise<void> { throw new Error(t('replay.readOnly')); }
  claim() { /* nothing to claim in a replay */ }
  release() { /* nothing to release in a replay */ }
  status() { return t('replay.status'); }
  players() { return []; }
  chat() { return []; }
  deadlines() { return {}; }
  sendChat() { /* no one to talk to in a replay */ }
  leave() { /* nothing to leave */ }
}
