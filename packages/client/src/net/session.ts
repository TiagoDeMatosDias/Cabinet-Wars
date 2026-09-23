import type { GameView, Intent, MapConfig, NationId } from '@krieg/engine';
import type { MapBundle } from '../maps';
import type { SeatInfo } from './protocol';

/** What the game screen needs, whether this browser hosts the game or joined it. */
export interface Session {
  readonly isHost: boolean;
  readonly map: MapBundle;
  readonly config: MapConfig;
  /** Room code for inviting others, if the game is online. */
  room: string | null;
  seats(): SeatInfo[];
  started(): boolean;
  /** Seats played from this browser. */
  localSeats(): NationId[];
  /** Seat the UI currently acts as (the local seat with a pending prompt). */
  actingSeat(): NationId | null;
  view(): GameView | null;
  subscribe(cb: () => void): () => void;
  send(intent: Intent): Promise<void>;
  claim(nation: NationId): void;
  release(nation: NationId): void;
  status(): string;
}

export class Emitter {
  private subs = new Set<() => void>();
  subscribe(cb: () => void) {
    this.subs.add(cb);
    return () => { this.subs.delete(cb); };
  }
  emit() {
    for (const s of this.subs) s();
  }
}

/** Picks the local seat that should act now, preferring the previous one. */
export function pickActingSeat(view: GameView | null, local: NationId[], previous: NationId | null): NationId | null {
  if (!local.length) return null;
  const pending = view ? view.pending.map((p) => p.nation).filter((n) => local.includes(n)) : [];
  if (previous && pending.includes(previous)) return previous;
  if (pending.length) return pending[0];
  if (previous && local.includes(previous)) return previous;
  return local[0];
}
