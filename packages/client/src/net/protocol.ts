import type { GameView, Intent, NationId, Side } from '@krieg/engine';

/** How a peer obtains the map: from the server by folder id, or as a bundle sent by the host. */
export type MapRef = { kind: 'server'; id: string; hash: string } | { kind: 'bundle'; hash: string; name: string };

export interface SeatInfo {
  nation: NationId;
  name: string;
  color: string;
  side: Side;
  /** Who plays it, from the receiver's point of view. */
  holder: 'you' | 'host' | 'other' | null;
  label?: string;
}

export type PeerMsg =
  | { t: 'hello'; token: string | null; name: string }
  | { t: 'claim'; nation: NationId }
  | { t: 'release'; nation: NationId }
  | { t: 'intent'; id: number; seat: NationId; intent: Intent }
  | { t: 'getMap' };

export type HostMsg =
  | { t: 'welcome'; token: string; map: MapRef }
  | { t: 'lobby'; seats: SeatInfo[]; started: boolean }
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
