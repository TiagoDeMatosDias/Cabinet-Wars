/**
 * Peer connections for host-in-browser games. Each host↔peer link is a WebRTC DataChannel,
 * negotiated through the server's /ws signaling socket. If the DataChannel does not open in
 * time (strict NATs), messages go through the signaling socket instead ("relay").
 * Messages are JSON; large ones are split into frames.
 */

const ICE_SERVERS: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const RTC_TIMEOUT_MS = 8000;
const FRAME_SIZE = 60_000;
const HIGH_WATER = 1_000_000;

export interface Channel {
  send(msg: unknown): void;
  onmessage: ((msg: any) => void) | null;
  onclose: ((reason: CloseReason) => void) | null;
  readonly mode: 'connecting' | 'rtc' | 'relay';
  close(): void;
}

/** Why a channel closed: the host ended the room, or the link was lost (and may come back). */
export type CloseReason = 'ended' | 'lost';

/** A signaling error; `code` is 'no-room' (gone for good) or 'away' (host reconnecting). */
export class SignalError extends Error {
  constructor(message: string, readonly code: string) { super(message); }
}

type SignalMsg = { type: string; [k: string]: any };

const PING_MS = 25_000;

class Signaling {
  private handlers = new Map<string, ((m: SignalMsg) => void)[]>();
  onclose: (() => void) | null = null;
  private ping: ReturnType<typeof setInterval>;
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as SignalMsg;
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    };
    ws.onclose = () => { clearInterval(this.ping); this.onclose?.(); };
    // Proxies (such as the public tunnel) close sockets that stay silent.
    this.ping = setInterval(() => this.send({ type: 'ping' }), PING_MS);
  }

  static connect(): Promise<Signaling> {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Signaling(ws));
      ws.onerror = () => reject(new SignalError('Could not reach the Krieg server for matchmaking', 'offline'));
    });
  }

  get open() { return this.ws.readyState === WebSocket.OPEN; }

  send(msg: SignalMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(type: string, cb: (m: SignalMsg) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]);
  }

  once(type: string): Promise<SignalMsg> {
    return new Promise((resolve, reject) => {
      this.on(type, resolve);
      this.on('error', (m) => reject(new SignalError(m.message, m.code)));
      const prev = this.onclose;
      this.onclose = () => { prev?.(); reject(new SignalError('Lost the connection to the server', 'offline')); };
    });
  }

  close() { this.ws.close(); }
}

/** A channel that prefers the DataChannel and falls back to the signaling relay. */
class HybridChannel implements Channel {
  onmessage: ((msg: any) => void) | null = null;
  onclose: ((reason: CloseReason) => void) | null = null;
  mode: Channel['mode'] = 'connecting';
  private dc: RTCDataChannel | null = null;
  private queue: string[] = [];
  private frames = new Map<string, string[]>();
  private closed = false;

  /** `ownsSig`: the signaling socket serves only this channel (a peer's link to its host). */
  constructor(private sig: Signaling, private remote: string, readonly pc: RTCPeerConnection, private ownsSig = false) {
    setTimeout(() => { if (this.mode === 'connecting') { this.mode = 'relay'; this.flush(); } }, RTC_TIMEOUT_MS);
    pc.onconnectionstatechange = () => {
      if (pc.connectionState !== 'failed' || this.mode !== 'rtc') return;
      // Without the signaling socket there is nothing left to fall back on.
      if (this.sig.open) { this.mode = 'relay'; this.flush(); } else this.close('lost');
    };
  }
  attach(dc: RTCDataChannel) {
    this.dc = dc;
    dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
    dc.onopen = () => { if (this.mode !== 'relay') this.mode = 'rtc'; this.flush(); };
    dc.onmessage = (e) => this.receive(String(e.data));
    dc.onbufferedamountlow = () => this.flush();
  }

  receive(raw: string) {
    const msg = JSON.parse(raw);
    if (msg && typeof msg === 'object' && '__frame' in msg) {
      const parts = this.frames.get(msg.__frame) ?? [];
      parts[msg.i] = msg.d;
      this.frames.set(msg.__frame, parts);
      if (parts.filter((p) => p !== undefined).length === msg.n) {
        this.frames.delete(msg.__frame);
        this.onmessage?.(JSON.parse(parts.join('')));
      }
      return;
    }
    this.onmessage?.(msg);
  }

  send(msg: unknown) {
    const str = JSON.stringify(msg);
    if (str.length <= FRAME_SIZE) this.queue.push(str);
    else {
      const id = Math.random().toString(36).slice(2);
      const n = Math.ceil(str.length / FRAME_SIZE);
      for (let i = 0; i < n; i++) this.queue.push(JSON.stringify({ __frame: id, i, n, d: str.slice(i * FRAME_SIZE, (i + 1) * FRAME_SIZE) }));
    }
    this.flush();
  }

  private flush() {
    if (this.closed) return;
    while (this.queue.length) {
      if (this.mode === 'rtc' && this.dc?.readyState === 'open') {
        if (this.dc.bufferedAmount > HIGH_WATER) return; // resumes on bufferedamountlow
        this.dc.send(this.queue.shift()!);
      } else if (this.mode === 'relay') {
        this.sig.send({ type: 'relay', to: this.remote, data: this.queue.shift()! });
      } else return;
    }
  }

  close(reason: CloseReason = 'lost') {
    if (this.closed) return;
    this.closed = true;
    this.dc?.close();
    this.pc.close();
    if (this.ownsSig) this.sig.close();
    this.onclose?.(reason);
  }
}

export interface HostedRoom {
  room: string;
  /** Proves this browser hosts the room, to take it back after a reload. */
  secret: string;
  /** Ends the room for everyone. */
  close(): void;
}

const RECONNECT_MS = 2000;

/**
 * Opens a room, or takes back one this browser hosted (`resume`); `onChannel` fires for every
 * peer that joins. If the server connection drops, the room is taken back automatically: the
 * peers are told the host is away and rejoin when it is back. `onEnded` fires if that fails for
 * good, or another tab took the room over.
 */
export async function hostRoom(opts: {
  onChannel: (ch: Channel) => void;
  resume?: { room: string; secret: string };
  onEnded?: (why: 'expired' | 'replaced') => void;
}): Promise<HostedRoom> {
  const channels = new Map<string, HybridChannel>();
  let info = opts.resume ?? null;
  let sig: Signaling | null = null;
  let ended = false;

  const listen = (s: Signaling) => {
    s.on('peer-joined', async ({ id }) => {
      const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
      const ch = new HybridChannel(s, id, pc);
      channels.set(id, ch);
      ch.attach(pc.createDataChannel('krieg', { ordered: true }));
      pc.onicecandidate = (e) => { if (e.candidate) s.send({ type: 'signal', to: id, data: { candidate: e.candidate.toJSON() } }); };
      await pc.setLocalDescription(await pc.createOffer());
      s.send({ type: 'signal', to: id, data: { sdp: pc.localDescription!.toJSON() } });
      opts.onChannel(ch);
    });
    s.on('signal', async ({ from, data }) => {
      const ch = channels.get(from);
      if (!ch) return;
      if (data.sdp) await ch.pc.setRemoteDescription(data.sdp);
      else if (data.candidate) await ch.pc.addIceCandidate(data.candidate).catch(() => {});
    });
    s.on('relay', ({ from, data }) => channels.get(from)?.receive(data));
    s.on('peer-left', ({ id }) => { channels.get(id)?.close(); channels.delete(id); });
    s.on('host-left', () => end('replaced'));
  };

  const closeChannels = () => { for (const c of channels.values()) c.close(); channels.clear(); };
  const end = (why: 'expired' | 'replaced') => {
    if (ended) return;
    ended = true;
    closeChannels();
    sig?.close();
    opts.onEnded?.(why);
  };

  const connect = async () => {
    const s = await Signaling.connect();
    listen(s);
    if (info) {
      s.send({ type: 'resume', ...info });
      await s.once('resumed');
    } else {
      s.send({ type: 'create' });
      const m = await s.once('created');
      info = { room: m.room, secret: m.secret };
    }
    sig = s;
    s.onclose = () => {
      if (ended || sig !== s) return;
      closeChannels();
      void reconnect();
    };
  };

  const reconnect = async () => {
    while (!ended) {
      await new Promise((r) => setTimeout(r, RECONNECT_MS));
      try { await connect(); return; } catch (e) {
        if ((e as SignalError).code === 'no-room') { end('expired'); return; }
      }
    }
  };

  await connect();
  return {
    room: info!.room,
    secret: info!.secret,
    close: () => { if (ended) return; ended = true; sig?.send({ type: 'close' }); closeChannels(); setTimeout(() => sig?.close(), 100); },
  };
}

/**
 * Joins a room and resolves with the channel to the host. Rejects with a SignalError: code
 * 'no-room' if the room does not exist, 'away' while its host is reconnecting.
 */
export async function joinRoom(room: string): Promise<Channel> {
  const sig = await Signaling.connect();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ch = new HybridChannel(sig, 'host', pc, true);
  pc.ondatachannel = (e) => ch.attach(e.channel);
  pc.onicecandidate = (e) => { if (e.candidate) sig.send({ type: 'signal', to: 'host', data: { candidate: e.candidate.toJSON() } }); };
  sig.on('signal', async ({ data }) => {
    if (data.sdp) {
      await pc.setRemoteDescription(data.sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      sig.send({ type: 'signal', to: 'host', data: { sdp: pc.localDescription!.toJSON() } });
    } else if (data.candidate) {
      await pc.addIceCandidate(data.candidate).catch(() => {});
    }
  });
  sig.on('relay', ({ data }) => ch.receive(data));
  sig.on('host-left', () => ch.close('ended'));
  sig.on('host-away', () => ch.close('lost'));
  sig.send({ type: 'join', room: room.toUpperCase() });
  try {
    await sig.once('joined');
  } catch (e) {
    sig.close();
    pc.close();
    throw e;
  }
  sig.onclose = () => { if (ch.mode !== 'rtc') ch.close('lost'); };
  return ch;
}
