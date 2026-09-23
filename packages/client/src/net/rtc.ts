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
  onclose: (() => void) | null;
  readonly mode: 'connecting' | 'rtc' | 'relay';
  close(): void;
}

type SignalMsg = { type: string; [k: string]: any };

class Signaling {
  private handlers = new Map<string, ((m: SignalMsg) => void)[]>();
  onclose: (() => void) | null = null;
  private constructor(private ws: WebSocket) {
    ws.onmessage = (e) => {
      const msg = JSON.parse(String(e.data)) as SignalMsg;
      for (const h of this.handlers.get(msg.type) ?? []) h(msg);
    };
    ws.onclose = () => this.onclose?.();
  }

  static connect(): Promise<Signaling> {
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Signaling(ws));
      ws.onerror = () => reject(new Error('Could not reach the Krieg server for matchmaking'));
    });
  }

  send(msg: SignalMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  on(type: string, cb: (m: SignalMsg) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]);
  }

  once(type: string): Promise<SignalMsg> {
    return new Promise((resolve, reject) => {
      this.on(type, resolve);
      this.on('error', (m) => reject(new Error(m.message)));
    });
  }

  close() { this.ws.close(); }
}

/** A channel that prefers the DataChannel and falls back to the signaling relay. */
class HybridChannel implements Channel {
  onmessage: ((msg: any) => void) | null = null;
  onclose: (() => void) | null = null;
  mode: Channel['mode'] = 'connecting';
  private dc: RTCDataChannel | null = null;
  private queue: string[] = [];
  private frames = new Map<string, string[]>();
  private closed = false;

  constructor(private sig: Signaling, private remote: string, readonly pc: RTCPeerConnection) {
    setTimeout(() => { if (this.mode === 'connecting') { this.mode = 'relay'; this.flush(); } }, RTC_TIMEOUT_MS);
    pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' && this.mode === 'rtc') { this.mode = 'relay'; this.flush(); } };
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

  close() {
    if (this.closed) return;
    this.closed = true;
    this.dc?.close();
    this.pc.close();
    this.onclose?.();
  }
}

export interface HostedRoom {
  room: string;
  close(): void;
}

/** Opens a room; `onChannel` fires for every peer that joins. */
export async function hostRoom(onChannel: (ch: Channel) => void): Promise<HostedRoom> {
  const sig = await Signaling.connect();
  const channels = new Map<string, HybridChannel>();
  sig.on('peer-joined', async ({ id }) => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const ch = new HybridChannel(sig, id, pc);
    channels.set(id, ch);
    ch.attach(pc.createDataChannel('krieg', { ordered: true }));
    pc.onicecandidate = (e) => { if (e.candidate) sig.send({ type: 'signal', to: id, data: { candidate: e.candidate.toJSON() } }); };
    await pc.setLocalDescription(await pc.createOffer());
    sig.send({ type: 'signal', to: id, data: { sdp: pc.localDescription!.toJSON() } });
    onChannel(ch);
  });
  sig.on('signal', async ({ from, data }) => {
    const ch = channels.get(from);
    if (!ch) return;
    if (data.sdp) await ch.pc.setRemoteDescription(data.sdp);
    else if (data.candidate) await ch.pc.addIceCandidate(data.candidate).catch(() => {});
  });
  sig.on('relay', ({ from, data }) => channels.get(from)?.receive(data));
  sig.on('peer-left', ({ id }) => { channels.get(id)?.close(); channels.delete(id); });
  sig.send({ type: 'create' });
  const { room } = await sig.once('created');
  return { room, close: () => { for (const c of channels.values()) c.close(); sig.close(); } };
}

/** Joins a room and resolves with the channel to the host. */
export async function joinRoom(room: string): Promise<Channel> {
  const sig = await Signaling.connect();
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const ch = new HybridChannel(sig, 'host', pc);
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
  sig.on('host-left', () => ch.close());
  sig.onclose = () => { if (ch.mode !== 'rtc') ch.close(); };
  sig.send({ type: 'join', room: room.toUpperCase() });
  await sig.once('joined');
  return ch;
}
