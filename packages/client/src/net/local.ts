import { filterForSeats, type GameView, type Intent, type LogEntry, type MapConfig, type NationId } from '@cabinet-wars/engine';
import { HOST, Table, type TableSettings } from '@cabinet-wars/table';
import type { MapBundle } from '../maps';
import { packBundle, type SaveMeta } from '../storage/bundle';
import { idb } from '../storage/idb';
import type { SaveRecord } from '../ui/game';
import { t } from '../i18n/i18n';
import { Emitter, pickActingSeat, type Link, type Session } from './session';

/**
 * A game played on this device only: hotseat, or against the computer. The table runs in the
 * browser. The game saves itself at the start of every turn (the menu's Continue picks it up).
 */
export class LocalSession implements Session {
  readonly isHost = true;
  readonly online = false;
  room: string | null = null;
  link: Link = 'connected';
  readonly table: Table;
  private acting: NationId | null = null;
  private cachedView: GameView | null = null;
  private emitter = new Emitter();
  /** The autosave record this game writes over. */
  private readonly autosaveId = `auto:${crypto.randomUUID()}`;
  private savedTurn = 0;

  constructor(readonly map: MapBundle, config: MapConfig, log: LogEntry[] = [], aiSeats: NationId[] = [], name = 'Host') {
    this.table = new Table(config, { hostName: name, log, aiSeats, local: true });
    this.table.onChange = () => this.changed();
    this.savedTurn = this.table.gameState().turn;
    this.changed();
  }

  get config() { return this.table.config; }

  you() { return HOST; }
  seats() { return this.table.lobbyFor(HOST).seats; }
  players() { return []; }
  settings(): TableSettings { return this.table.settings; }
  started() { return this.table.started(); }
  localSeats() { return this.table.seatsOf(HOST); }
  actingSeat() { return this.acting; }
  view() { return this.table.started() ? this.cachedView : null; }
  subscribe(cb: () => void) { return this.emitter.subscribe(cb); }
  claim(nation: NationId) { this.table.claim(HOST, nation); }
  release(nation: NationId) { this.table.release(HOST, nation); }
  setAi(nation: NationId) { this.table.setAi(HOST, nation); }
  kick() { /* nobody else is here */ }
  start() { this.table.start(HOST); }
  setSettings(s: Partial<TableSettings>) { this.table.setSettings(HOST, s); }
  setColor(nation: NationId, color: string | null) { this.table.setColor(HOST, nation, color); }
  status() { return t('net.local'); }
  chat() { return []; }
  sendChat() { /* no chat on one device */ }
  deadlines() { return {}; }
  async entries() { return this.table.entries(); }
  leave() { this.table.dispose(); }
  end() { this.leave(); }

  async send(intent: Intent) {
    const seat = this.acting;
    if (!seat) throw new Error('No seat to act for');
    this.table.act(HOST, seat, intent);
  }

  private changed() {
    const state = this.table.gameState();
    const local = this.localSeats();
    this.acting = pickActingSeat(state as GameView, local, this.acting);
    // Nobody plays here (only computers): watch the whole game. Hotseat: the nation acting now.
    const watching = local.length ? (this.acting ? [this.acting] : local) : this.config.nations.map((n) => n.id);
    this.cachedView = filterForSeats(state, watching);
    if (this.table.started() && state.turn !== this.savedTurn) {
      this.savedTurn = state.turn;
      void this.autosave();
    }
    this.emitter.emit();
  }

  async save(title: string): Promise<{ blob: Blob; meta: SaveMeta }> {
    const state = this.table.gameState();
    const meta: SaveMeta = {
      title,
      date: new Date().toISOString(),
      mapName: this.config.name,
      turn: state.turn,
      current: state.current,
      seats: this.table.seatNames(),
    };
    return { blob: await packBundle({ map: { ...this.map, config: { ...this.map.config, ...colorsOf(this.config) } }, log: this.table.entries(), meta }), meta };
  }

  /** Keeps one save of this game up to date, for the menu's Continue. */
  private async autosave() {
    if (this.table.gameState().phase === 'gameOver') { await idb.delete('saves', this.autosaveId).catch(() => {}); return; }
    try {
      const title = t('game.autosaveTitle', { map: this.config.name });
      const { blob, meta } = await this.save(title);
      const rec: SaveRecord = { id: this.autosaveId, title, date: meta.date, mapName: meta.mapName, turn: meta.turn, blob, auto: true };
      await idb.put('saves', rec);
    } catch (e) {
      console.warn('Autosave failed', e);
    }
  }
}

/** The config's nations with their chosen colors, for a save to keep them. */
function colorsOf(config: MapConfig): { nations: unknown[] } {
  return { nations: config.nations };
}
