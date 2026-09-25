import { parseConfig } from '@krieg/engine';
import type { MapBundle } from '../maps';
import { idb } from '../storage/idb';
import { t } from '../i18n/i18n';
import { toast } from '../ui/dom';
import { HostSession, type HostSnapshot } from './host';
import type { MapRef } from './protocol';
import { hostRoom } from './rtc';

/**
 * An online game hosted in this tab survives a reload: its state is kept in IndexedDB and the
 * tab remembers (in sessionStorage, so each tab its own) which room it hosts. On reload the page
 * takes the room back from the server, and the players reconnect by themselves.
 */
const TAB_KEY = 'krieg:hosting';
const SAVE_DELAY_MS = 300;

interface HostedRecord extends HostSnapshot {
  id: string;
  secret: string;
  mapRef: MapRef;
  mapKey: string;
  hostName: string;
  date: string;
}

function tabRoom(): string | null {
  try { return sessionStorage.getItem(TAB_KEY); } catch { return null; }
}

function setTabRoom(room: string | null) {
  try { if (room) sessionStorage.setItem(TAB_KEY, room); else sessionStorage.removeItem(TAB_KEY); } catch { /* storage unavailable */ }
}

/** Keeps `session` saved while it is online, until it is left. */
function persist(session: HostSession) {
  const mapKey = `hash:${session.mapRef.hash}`;
  void idb.get<MapBundle>('maps', mapKey).then((m) => (m ? undefined : idb.put('maps', { ...session.map, id: mapKey }))).catch(() => {});
  let timer: ReturnType<typeof setTimeout> | null = null;
  const save = () => {
    timer = null;
    if (!session.room || !session.secret) return;
    const rec: HostedRecord = {
      id: session.room, secret: session.secret, mapRef: session.mapRef, mapKey, hostName: session.hostName,
      date: new Date().toISOString(), ...session.snapshot(),
    };
    void idb.put('hosted', rec).catch(() => {});
  };
  session.onPersist = () => { timer ??= setTimeout(save, SAVE_DELAY_MS); };
  session.onLeave = () => { if (timer) clearTimeout(timer); session.onPersist = null; forget(session.room); };
  setTabRoom(session.room);
  save();
}

function onEnded(session: HostSession) {
  return (why: 'expired' | 'replaced') => {
    forget(session.room);
    toast(t(why === 'replaced' ? 'net.hostReplaced' : 'net.roomExpired'), 'error');
    session.goOffline();
  };
}

/** Opens a new room for `session`. */
export async function hostOnline(session: HostSession) {
  const hosted = await hostRoom({ onChannel: (ch) => session.addChannel(ch), onEnded: onEnded(session) });
  session.goOnline(hosted);
  persist(session);
}

/** Stops keeping the game hosted in this tab. */
export function forget(room: string | null) {
  setTabRoom(null);
  if (room) void idb.delete('hosted', room).catch(() => {});
}

/** Rooms expire on the server soon after their host leaves: older records are of no use. */
const STALE_MS = 24 * 3600_000;

/** Takes back the room this tab hosted before it reloaded, if any. */
export async function resumeHosting(): Promise<HostSession | null> {
  void idb.all<HostedRecord>('hosted').then((all) => {
    for (const r of all) if (Date.now() - Date.parse(r.date) > STALE_MS) void idb.delete('hosted', r.id);
  }).catch(() => {});
  const room = tabRoom();
  if (!room) return null;
  try {
    const rec = await idb.get<HostedRecord>('hosted', room);
    const map = rec && await idb.get<MapBundle>('maps', rec.mapKey);
    if (!rec || !map) throw new Error(t('net.roomExpired'));
    const session = new HostSession(map, parseConfig(map.config), rec.mapRef, [], [], rec.hostName, rec);
    const hosted = await hostRoom({
      onChannel: (ch) => session.addChannel(ch),
      resume: { room: rec.id, secret: rec.secret },
      onEnded: onEnded(session),
    });
    session.goOnline(hosted);
    persist(session);
    return session;
  } catch (e) {
    forget(room);
    toast((e as { code?: string }).code === 'no-room' ? t('net.roomExpired') : (e as Error).message, 'error');
    return null;
  }
}
