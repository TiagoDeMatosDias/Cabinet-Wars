import type { AiRole, GameView, Intent, LogEntry, NationId, Side } from '@cabinet-wars/engine';

/**
 * What the lobby and the game screen know about a table, and the messages between a browser and
 * the server that hosts online games (over the /ws socket).
 */

/** How players get the map: from the server's Map folder, or as a bundle the host uploaded. */
export type MapRef = { kind: 'server'; id: string; hash: string } | { kind: 'upload'; hash: string; name: string };

export interface SeatInfo {
  nation: NationId;
  name: string;
  color: string;
  side: Side;
  /** Who plays it, from the receiver's point of view. */
  holder: 'you' | 'host' | 'other' | 'ai' | null;
  /** The player's name, when another player holds it. */
  label?: string;
  /** Its player is not connected right now. */
  offline?: boolean;
  /** How the computer would play this nation. */
  aiRole?: AiRole;
}

/** Someone at the table, from the receiver's point of view. */
export interface PlayerInfo {
  id: string;
  name: string;
  host: boolean;
  you: boolean;
  online: boolean;
  nations: NationId[];
}

/**
 * A chat line. Players' lines carry their text; the table's own notices (someone joined, took a
 * nation…) carry an i18n key and params instead, so each browser shows them in its language.
 */
export interface ChatMsg {
  id: number;
  at: number;
  /** The writer's player id (for muting), and name. */
  by?: string;
  from?: string;
  /** The writer's nations when they wrote, for their emblems. */
  nations?: NationId[];
  text?: string;
  key?: string;
  params?: Record<string, string>;
}

export const CHAT_MAX_LENGTH = 500;

/** Options the host sets in the lobby. */
export interface TableSettings {
  /** Minutes a player may take to act before their turn is ended for them; 0 = no limit. */
  afkMinutes: number;
  /** Players may join a game that has started, to watch it. */
  allowSpectators: boolean;
  /** The game shows in the server's list of open games. */
  listed: boolean;
}

export const DEFAULT_SETTINGS: TableSettings = { afkMinutes: 5, allowSpectators: true, listed: true };
export const AFK_CHOICES = [0, 2, 5, 10] as const;

/**
 * Nation colors players may pick in the lobby: the Okabe–Ito palette, which people with the
 * common color vision deficiencies can still tell apart, and a few further distinct colors.
 */
export const COLOR_CHOICES = [
  '#0072b2', '#d55e00', '#009e73', '#e69f00', '#56b4e9', '#cc79a7', '#f0e442', '#222222',
  '#882255', '#44aa99', '#999933', '#888888',
] as const;

export interface LobbyInfo {
  seats: SeatInfo[];
  players: PlayerInfo[];
  started: boolean;
  settings: TableSettings;
  /** Nation colors, with the players' choices applied. */
  colors: Record<NationId, string>;
  /** Milliseconds each nation has left to act before its turn is ended for it. */
  timers: Record<NationId, number>;
}

/** Why a browser was sent away from a table. */
export type DismissReason = 'kicked' | 'replaced' | 'ended' | 'noSpectators' | 'noRoom';

export type ClientMsg =
  | { t: 'create'; name: string; map: MapRef; config: Record<string, unknown>; log?: LogEntry[]; aiSeats?: NationId[]; settings?: Partial<TableSettings> }
  | { t: 'join'; room: string; token: string | null; name: string }
  | { t: 'claim'; nation: NationId }
  | { t: 'release'; nation: NationId }
  | { t: 'setAi'; nation: NationId }
  | { t: 'kick'; player: string }
  | { t: 'start' }
  | { t: 'settings'; settings: Partial<TableSettings> }
  | { t: 'color'; nation: NationId; color: string | null }
  | { t: 'chat'; text: string }
  | { t: 'intent'; id: number; seat: NationId; intent: Intent }
  /** The host ends the game for everyone. */
  | { t: 'end' }
  /** The whole log, for a replay: only once the game is over. */
  | { t: 'getLog' }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'welcome'; room: string; token: string; you: string; host: boolean; map: MapRef; config: Record<string, unknown> }
  | ({ t: 'lobby' } & LobbyInfo)
  | { t: 'view'; view: GameView; seats: NationId[] }
  | { t: 'chat'; msgs: ChatMsg[]; reset?: boolean }
  | { t: 'result'; id: number; error: string | null; template?: string; params?: Record<string, string | number> }
  | { t: 'dismissed'; reason: DismissReason }
  | { t: 'log'; log: LogEntry[] }
  | { t: 'error'; message: string }
  | { t: 'ping' };

/** A game as the server lists it for players looking for one. */
export interface GameListing {
  room: string;
  mapName: string;
  host: string;
  players: number;
  online: number;
  openSeats: number;
  started: boolean;
  round: number;
  spectators: boolean;
}
