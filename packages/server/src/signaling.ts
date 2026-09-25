import { randomBytes } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Signaling for host-in-browser games. The host creates a room; peers join it. The server only
 * relays WebRTC offers/answers/ICE candidates, and game messages when a direct connection fails.
 *
 * A host that drops (reload, network trouble) has HOST_GRACE_MS to come back with its secret;
 * meanwhile peers are told the host is away and rejoin once it is back.
 *
 * Client → server:
 *   {type:'create'}                    host opens a room
 *   {type:'resume', room, secret}      host takes its room back after a reload or disconnect
 *   {type:'close'}                     host ends the room for good
 *   {type:'join', room}                peer joins a room
 *   {type:'signal'|'relay', to, data}  forwarded to peer `to` (the host is peer "host")
 *   {type:'ping'}                      keeps proxies from closing an idle socket
 * Server → client:
 *   {type:'created', room, id:'host', secret} | {type:'resumed', room, id:'host'} | {type:'joined', room, id}
 *   {type:'peer-joined', id} | {type:'peer-left', id} | {type:'host-left'} | {type:'host-away'}
 *   {type:'signal'|'relay', from, data} | {type:'error', code, message} | {type:'ping'}
 * Error codes: 'no-room' (never existed or ended), 'away' (host is reconnecting: try again).
 */
interface Room {
  host: WebSocket | null;
  secret: string;
  peers: Map<string, WebSocket>;
  expiry: ReturnType<typeof setTimeout> | null;
}

const HOST_GRACE_MS = 3 * 60_000;
const PING_MS = 25_000;
const rooms = new Map<string, Room>();

function send(ws: WebSocket | null | undefined, msg: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomCode(): string {
  let code: string;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

export function attachSignaling(wss: WebSocketServer, onRoomCreated: () => void) {
  // Proxies such as the public tunnel close sockets that stay silent for about 100 s.
  const ping = setInterval(() => { for (const ws of wss.clients) send(ws, { type: 'ping' }); }, PING_MS);
  wss.on('close', () => clearInterval(ping));

  wss.on('connection', (ws: WebSocket) => {
    let room: string | null = null;
    let id: string | null = null;

    const becomeHost = (code: string, r: Room) => {
      room = code;
      id = 'host';
      r.host = ws;
      if (r.expiry) clearTimeout(r.expiry);
      r.expiry = null;
    };

    ws.on('message', (raw) => {
      let msg: { type?: string; room?: string; to?: string; data?: unknown; secret?: string };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'ping') return;
      if (msg.type === 'create' && !room) {
        const code = roomCode();
        const r: Room = { host: null, secret: randomBytes(16).toString('hex'), peers: new Map(), expiry: null };
        rooms.set(code, r);
        becomeHost(code, r);
        send(ws, { type: 'created', room: code, id, secret: r.secret });
        onRoomCreated();
      } else if (msg.type === 'resume' && !room) {
        const code = String(msg.room ?? '').toUpperCase();
        const r = rooms.get(code);
        if (!r || r.secret !== msg.secret) { send(ws, { type: 'error', code: 'no-room', message: `No room ${code}` }); return; }
        // A second tab resuming the same room replaces the first.
        if (r.host && r.host !== ws) { send(r.host, { type: 'host-left' }); r.host.close(); }
        becomeHost(code, r);
        send(ws, { type: 'resumed', room: code, id });
        onRoomCreated();
      } else if (msg.type === 'close' && id === 'host' && room) {
        const r = rooms.get(room);
        if (r) for (const p of r.peers.values()) send(p, { type: 'host-left' });
        rooms.delete(room);
        room = id = null;
      } else if (msg.type === 'join' && !room) {
        const code = String(msg.room ?? '').trim().toUpperCase();
        const r = rooms.get(code);
        if (!r) { send(ws, { type: 'error', code: 'no-room', message: `No room ${code}` }); return; }
        if (!r.host) { send(ws, { type: 'error', code: 'away', message: 'The host is reconnecting' }); return; }
        room = code;
        id = `p${randomBytes(4).toString('hex')}`;
        r.peers.set(id, ws);
        send(ws, { type: 'joined', room, id });
        send(r.host, { type: 'peer-joined', id });
      } else if ((msg.type === 'signal' || msg.type === 'relay') && room && id) {
        const r = rooms.get(room);
        if (!r) return;
        const target = msg.to === 'host' ? r.host : r.peers.get(String(msg.to));
        send(target, { type: msg.type, from: id, data: msg.data });
      }
    });

    ws.on('close', () => {
      if (!room || !id) return;
      const r = rooms.get(room);
      if (!r) return;
      if (id === 'host') {
        if (r.host !== ws) return; // already replaced by a resumed host
        r.host = null;
        // Peers drop their links and rejoin when the host is back.
        for (const p of r.peers.values()) send(p, { type: 'host-away' });
        r.peers.clear();
        const code = room;
        r.expiry = setTimeout(() => { if (rooms.get(code) === r && !r.host) rooms.delete(code); }, HOST_GRACE_MS);
      } else if (r.peers.get(id) === ws) {
        r.peers.delete(id);
        send(r.host, { type: 'peer-left', id });
      }
    });
  });
}
