import type { GameView, Intent, LogEntry, MapConfig, NationId } from '@cabinet-wars/engine';
import type { ChatMsg, PlayerInfo, SeatInfo, TableSettings } from '@cabinet-wars/table';
import type { MapBundle } from '../maps';

/** Connection state of an online game (a local game is always 'connected'). */
export type Link = 'connected' | 'reconnecting' | 'ended' | 'replaced' | 'kicked' | 'noSpectators' | 'lost' | 'left';

/** What the lobby and the game screen need, whether the game runs in this browser or on the server. */
export interface Session {
  /** This browser runs the table: it starts the game, hands nations to the computer, kicks players. */
  readonly isHost: boolean;
  /** Played through the server with others (not only on this device). */
  readonly online: boolean;
  readonly map: MapBundle;
  /** The map's config, with the nation colors chosen in the lobby. */
  readonly config: MapConfig;
  /** Room code for inviting others, if the game is online. */
  room: string | null;
  link: Link;
  /** This browser's player id at the table. */
  you(): string;
  seats(): SeatInfo[];
  players(): PlayerInfo[];
  settings(): TableSettings;
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
  setAi(nation: NationId): void;
  kick(player: string): void;
  start(): void;
  setSettings(settings: Partial<TableSettings>): void;
  setColor(nation: NationId, color: string | null): void;
  status(): string;
  chat(): ChatMsg[];
  sendChat(text: string): void;
  /** When each nation's time to act runs out (this browser's clock); only in online games. */
  deadlines(): Record<NationId, number>;
  /** The whole log, when this browser may have it: a local game, or an online game that is over. */
  entries(): Promise<LogEntry[] | null>;
  /** Stops playing here. An online game carries on on the server; its players can come back. */
  leave(): void;
  /** The host ends an online game for everyone. */
  end(): void;
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
