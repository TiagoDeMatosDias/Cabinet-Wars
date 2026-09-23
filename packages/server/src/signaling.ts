import { randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';

/**
 * Signaling for host-in-browser games. The host creates a room; peers join it. The server only
 * relays WebRTC offers/answers/ICE candidates, and game messages when a direct connection fails.
 *
 * Client → server:
 *   {type:'create'}                    host opens a room
 *   {type:'join', room}                peer joins a room
 *   {type:'signal'|'relay', to, data}  forwarded to peer `to` (the host is peer "host")
 * Server → client:
 *   {type:'created', room, id:'host'} | {type:'joined', room, id}
 *   {type:'peer-joined', id} | {type:'peer-left', id} | {type:'host-left'}
 *   {type:'signal'|'relay', from, data} | {type:'error', message}
 */
interface Room {
  host: WebSocket;
  peers: Map<string, WebSocket>;
}

const rooms = new Map<string, Room>();

function send(ws: WebSocket, msg: unknown) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function roomCode(): string {
  let code: string;
  do code = randomBytes(3).toString('hex').toUpperCase(); while (rooms.has(code));
  return code;
}

export function attachSignaling(wss: WebSocketServer) {
  wss.on('connection', (ws: WebSocket, _req: IncomingMessage) => {
    let room: string | null = null;
    let id: string | null = null;

    ws.on('message', (raw) => {
      let msg: { type?: string; room?: string; to?: string; data?: unknown };
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.type === 'create' && !room) {
        room = roomCode();
        id = 'host';
        rooms.set(room, { host: ws, peers: new Map() });
        send(ws, { type: 'created', room, id });
      } else if (msg.type === 'join' && !room) {
        const code = String(msg.room ?? '').toUpperCase();
        const r = rooms.get(code);
        if (!r) { send(ws, { type: 'error', message: `No room ${code}` }); return; }
        room = code;
        id = `p${randomBytes(4).toString('hex')}`;
        r.peers.set(id, ws);
        send(ws, { type: 'joined', room, id });
        send(r.host, { type: 'peer-joined', id });
      } else if ((msg.type === 'signal' || msg.type === 'relay') && room && id) {
        const r = rooms.get(room);
        if (!r) return;
        const target = msg.to === 'host' ? r.host : r.peers.get(String(msg.to));
        if (target) send(target, { type: msg.type, from: id, data: msg.data });
      }
    });

    ws.on('close', () => {
      if (!room || !id) return;
      const r = rooms.get(room);
      if (!r) return;
      if (id === 'host') {
        for (const p of r.peers.values()) send(p, { type: 'host-left' });
        rooms.delete(room);
      } else {
        r.peers.delete(id);
        send(r.host, { type: 'peer-left', id });
      }
    });
  });
}
