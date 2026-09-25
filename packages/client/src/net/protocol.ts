import type { AiRole, GameView, Intent, NationId, Side } from '@krieg/engine';

/** How a peer obtains the map: from the server by folder id, or as a bundle sent by the host. */
export type MapRef = { kind: 'server'; id: string; hash: string } | { kind: 'bundle'; hash: string; name: string };

export interface SeatInfo {
  nation: NationId;
  name: string;
  color: string;
  side: Side;
  /** Who plays it, from the receiver's point of view. */
  holder: 'you' | 'host' | 'other' | 'ai' | null;
  label?: string;
  /** Its player is not connected right now. */
  offline?: boolean;
  /** How the computer would play this nation. */
  aiRole?: AiRole;
}

/** Someone in the room, from the receiver's point of view. */
export interface PlayerInfo {
  /** 'host' for the host. */
  id: string;
  name: string;
  host: boolean;
  you: boolean;
  online: boolean;
  nations: NationId[];
}

/**
 * A chat line. Players' lines carry their text; the room's own notices (someone joined, took a
 * nation…) carry an i18n key and params instead, so each browser shows them in its language.
 */
export interface ChatMsg {
  id: number;
  at: number;
  from?: string;
  /** The sender's nations when they wrote, for their emblems. */
  nations?: NationId[];
  text?: string;
  key?: string;
  params?: Record<string, string>;
}

export const CHAT_MAX_LENGTH = 500;

export type PeerMsg =
  | { t: 'hello'; token: string | null; name: string }
  | { t: 'chat'; text: string }
  | { t: 'claim'; nation: NationId }
  | { t: 'release'; nation: NationId }
  | { t: 'intent'; id: number; seat: NationId; intent: Intent }
  | { t: 'getMap' };

export type HostMsg =
  | { t: 'welcome'; token: string; map: MapRef }
  /** `timers`: milliseconds each nation has left to act before its turn is ended for it. */
  | { t: 'lobby'; seats: SeatInfo[]; players: PlayerInfo[]; started: boolean; timers?: Record<NationId, number> }
  /** New chat lines; `reset` replaces the whole history (sent on (re)connecting). */
  | { t: 'chat'; msgs: ChatMsg[]; reset?: boolean }
  /** This browser's place was taken by the same player connecting from another tab. */
  | { t: 'replaced' }
  /** The host removed this player from the game. */
  | { t: 'kicked' }
  | { t: 'map'; data: string }
  | { t: 'view'; view: GameView; seats: NationId[] }
  | { t: 'result'; id: number; error: string | null; template?: string; params?: Record<string, string | number> };

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
