import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseConfig } from '@cabinet-wars/engine';
import {
  HOST, Table, TableError,
  type ClientMsg, type DismissReason, type GameListing, type MapRef, type ServerMsg, type TableSnapshot,
} from '@cabinet-wars/table';
import { WebSocket, type WebSocketServer } from 'ws';

/**
 * Online games, played on this server. Each game (a "room", named by a short code) is a Table:
 * the server keeps the authoritative state, rolls every die, runs the computer players and sends
 * each player only what their nations may see. Browsers talk to it over the /ws socket (see
 * ClientMsg / ServerMsg in @cabinet-wars/table). Games are saved to disk as they go, so they survive the
 * host closing their browser and the server restarting.
 */
interface Room {
  code: string;
  table: Table;
  map: MapRef;
  /** The map config as the host sent it (rules included), for players to build the same game. */
  config: Record<string, unknown>;
  created: string;
  sockets: Map<string, WebSocket>;
  saveTimer: ReturnType<typeof setTimeout> | null;
}

interface RoomFile {
  code: string;
  map: MapRef;
  config: Record<string, unknown>;
  created: string;
  updated: string;
  snapshot: TableSnapshot;
}

const PING_MS = 25_000;
const SAVE_DELAY_MS = 1000;
/** Games nobody has touched for this long are removed when the server starts. */
const KEEP_MS = 30 * 86_400_000;
const rooms = new Map<string, Room>();

function send(ws: WebSocket | undefined, msg: ServerMsg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomCode(): string {
  let code: string;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

export class Games {
  constructor(private readonly dir: string, private readonly onHosted: () => void) {}

  private file(code: string) { return join(this.dir, `${code}.json`); }

  /** Loads the games saved by an earlier run of the server. */
  async load() {
    await mkdir(this.dir, { recursive: true });
    for (const f of await readdir(this.dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const path = join(this.dir, f);
        if (Date.now() - (await stat(path)).mtimeMs > KEEP_MS) { await rm(path); continue; }
        const data = JSON.parse(await readFile(path, 'utf8')) as RoomFile;
        const table = new Table(parseConfig(data.config), { hostName: '', snapshot: data.snapshot });
        this.open(data.code, table, data.map, data.config, data.created);
      } catch (e) {
        console.warn(`Could not load saved game ${f}: ${(e as Error).message}`);
      }
    }
    if (rooms.size) console.log(`  ${rooms.size} saved online game(s) loaded`);
  }

  private open(code: string, table: Table, map: MapRef, config: Record<string, unknown>, created: string): Room {
    const room: Room = { code, table, map, config, created, sockets: new Map(), saveTimer: null };
    rooms.set(code, room);
    table.onChange = () => { this.broadcastState(room); this.scheduleSave(room); };
    table.onChat = (line) => { for (const ws of room.sockets.values()) send(ws, { t: 'chat', msgs: [line] }); this.scheduleSave(room); };
    table.onDismiss = (id, reason) => this.dismiss(room, id, reason);
    return room;
  }

  private scheduleSave(room: Room) {
    room.saveTimer ??= setTimeout(() => {
      room.saveTimer = null;
      if (rooms.get(room.code) !== room) return;
      const data: RoomFile = {
        code: room.code, map: room.map, config: room.config, created: room.created, updated: new Date().toISOString(), snapshot: room.table.snapshot(),
      };
      void writeFile(this.file(room.code), JSON.stringify(data)).catch((e) => console.warn(`Could not save game ${room.code}: ${e}`));
    }, SAVE_DELAY_MS);
  }

  private sendState(room: Room, id: string) {
    const ws = room.sockets.get(id);
    if (!ws) return;
    const t = room.table;
    send(ws, { t: 'lobby', ...t.lobbyFor(id) });
    // Players without a nation watch with no view beyond what everyone knows.
    if (t.started()) send(ws, { t: 'view', view: t.viewFor(id), seats: t.seatsOf(id) });
  }

  private broadcastState(room: Room) {
    for (const id of room.sockets.keys()) this.sendState(room, id);
  }

  private dismiss(room: Room, id: string, reason: DismissReason) {
    const ws = room.sockets.get(id);
    room.sockets.delete(id);
    send(ws, { t: 'dismissed', reason });
    setTimeout(() => ws?.close(), 200);
  }

  /** The host ends the game: everyone is sent away and it is deleted. */
  private end(room: Room) {
    for (const id of [...room.sockets.keys()]) this.dismiss(room, id, 'ended');
    room.table.dispose();
    rooms.delete(room.code);
    if (room.saveTimer) clearTimeout(room.saveTimer);
    void rm(this.file(room.code), { force: true });
  }

  /** Games others may join, for the menu's list: listed ones that someone is playing now. */
  list(): GameListing[] {
    return [...rooms.values()].filter((r) => r.table.settings.listed && r.sockets.size > 0).map((r) => this.listing(r));
  }

  /** One game, listed or not (for players returning to their own games). */
  get(code: string): GameListing | null {
    const r = rooms.get(code.toUpperCase());
    return r ? this.listing(r) : null;
  }

  private listing(r: Room): GameListing {
    const t = r.table;
    const lobby = t.lobbyFor('');
    return {
      room: r.code,
      mapName: t.config.name,
      host: t.playerName(HOST) ?? '',
      players: lobby.players.length,
      online: lobby.players.filter((p) => p.online).length,
      openSeats: lobby.seats.filter((s) => s.holder === null).length,
      started: t.started(),
      round: t.gameState().round,
      spectators: t.settings.allowSpectators,
    };
  }

  attach(wss: WebSocketServer) {
    // Proxies such as the public tunnel close sockets that stay silent for about 100 s.
    const ping = setInterval(() => { for (const ws of wss.clients) send(ws, { t: 'ping' }); }, PING_MS);
    wss.on('close', () => clearInterval(ping));
    wss.on('connection', (ws: WebSocket) => {
      let room: Room | null = null;
      let player: string | null = null;

      const enter = (r: Room, id: string, token: string, isNew: boolean) => {
        const old = r.sockets.get(id);
        // The same player connecting again (reload, other tab): the newest connection wins.
        if (old && old !== ws) this.dismiss(r, id, 'replaced');
        room = r;
        player = id;
        r.sockets.set(id, ws);
        send(ws, { t: 'welcome', room: r.code, token, you: id, host: id === HOST, map: r.map, config: r.config });
        send(ws, { t: 'chat', msgs: r.table.chat(), reset: true });
        if (r.table.isOnline(id)) this.sendState(r, id);
        else r.table.setOnline(id, true, isNew);
      };

      ws.on('message', (raw) => {
        let msg: ClientMsg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.t === 'ping') return;
        try {
          if (msg.t === 'create' && !room) {
            let config;
            try { config = parseConfig(msg.config); } catch (e) { send(ws, { t: 'error', message: (e as Error).message }); return; }
            const table = new Table(config, { hostName: String(msg.name ?? '').trim().slice(0, 40) || 'Host', log: msg.log, aiSeats: msg.aiSeats, settings: msg.settings });
            const r = this.open(roomCode(), table, msg.map, msg.config, new Date().toISOString());
            this.scheduleSave(r);
            enter(r, HOST, table.hostToken(), true);
            this.onHosted();
            return;
          }
          if (msg.t === 'join' && !room) {
            const r = rooms.get(String(msg.room ?? '').trim().toUpperCase());
            if (!r) { send(ws, { t: 'dismissed', reason: 'noRoom' }); return; }
            const res = r.table.join(msg.token ?? null, String(msg.name ?? ''));
            if ('refused' in res) { send(ws, { t: 'dismissed', reason: res.refused }); return; }
            // A token the table did not know made a new player.
            enter(r, res.player, res.token, res.token !== msg.token);
            return;
          }
          if (!room || !player) return;
          const t = room.table;
          switch (msg.t) {
            case 'claim': t.claim(player, msg.nation); break;
            case 'release': t.release(player, msg.nation); break;
            case 'setAi': t.setAi(player, msg.nation); break;
            case 'kick': t.kick(player, msg.player); break;
            case 'start': t.start(player); break;
            case 'settings': t.setSettings(player, msg.settings); break;
            case 'color': t.setColor(player, msg.nation, msg.color); break;
            case 'chat': t.say(player, msg.text); break;
            case 'end': if (player === HOST) this.end(room); break;
            case 'getLog':
              if (t.gameState().phase === 'gameOver') send(ws, { t: 'log', log: t.entries() });
              else send(ws, { t: 'error', message: 'The log is available once the game is over' });
              break;
            case 'intent': {
              let error: string | null = null;
              let template: string | undefined;
              let params: Record<string, string | number> | undefined;
              try { t.act(player, msg.seat, msg.intent); } catch (e) {
                // Engine errors carry their English template, so the browser can translate them.
                error = (e as Error).message;
                template = (e as { template?: string }).template ?? error;
                params = (e as { params?: Record<string, string | number> }).params;
              }
              send(ws, { t: 'result', id: msg.id, error, template, params });
              break;
            }
          }
        } catch (e) {
          send(ws, { t: 'error', message: e instanceof TableError ? e.template : (e as Error).message });
        }
      });

      ws.on('close', () => {
        if (!room || !player || room.sockets.get(player) !== ws) return;
        room.sockets.delete(player);
        room.table.setOnline(player, false);
      });
    });
  }
}
