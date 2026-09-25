/**
 * Sound effects, made on the fly with the Web Audio API (no audio files): drums, a horn, dice,
 * paper and bells, in keeping with the period. Browsers only allow sound after the player has
 * clicked or pressed a key, so sounds asked for before that are skipped.
 *
 * The volume (0 = off) is kept in localStorage and set under Settings.
 */
export type SoundName =
  | 'selectArmy' | 'selectNode' | 'order' | 'march' | 'dice' | 'battle' | 'card' | 'yourTurn' | 'chat'
  | 'recruit' | 'victory' | 'defeat' | 'warning' | 'error' | 'click';

const VOLUME_KEY = 'krieg:volume';

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let volume = readVolume();

function readVolume(): number {
  try {
    const v = Number(localStorage.getItem(VOLUME_KEY));
    return localStorage.getItem(VOLUME_KEY) === null || Number.isNaN(v) ? 0.6 : Math.min(1, Math.max(0, v));
  } catch { return 0.6; }
}

/** Creates the audio context on the first gesture (earlier, browsers keep it silent). */
function unlock() {
  if (ctx) { if (ctx.state === 'suspended') void ctx.resume(); return; }
  try {
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
  } catch { ctx = null; }
}
for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, unlock, { capture: true, passive: true });

// ---- building blocks ------------------------------------------------------------------------

/** A tone with a quick attack and exponential decay. */
function tone(freq: number, at: number, dur: number, opts: { type?: OscillatorType; gain?: number; to?: number; filter?: number } = {}) {
  const c = ctx!;
  const osc = c.createOscillator();
  osc.type = opts.type ?? 'sine';
  osc.frequency.setValueAtTime(freq, at);
  if (opts.to) osc.frequency.exponentialRampToValueAtTime(opts.to, at + dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(opts.gain ?? 0.3, at + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  let node: AudioNode = osc;
  if (opts.filter) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = opts.filter;
    osc.connect(f);
    node = f;
  }
  node.connect(g).connect(master!);
  osc.start(at);
  osc.stop(at + dur + 0.02);
}

let noiseBuffer: AudioBuffer | null = null;

/** A burst of filtered noise: drum skins, dice, paper, footsteps. */
function noise(at: number, dur: number, opts: { freq?: number; q?: number; gain?: number; type?: BiquadFilterType } = {}) {
  const c = ctx!;
  if (!noiseBuffer) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = noiseBuffer.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuffer;
  const f = c.createBiquadFilter();
  f.type = opts.type ?? 'bandpass';
  f.frequency.value = opts.freq ?? 1000;
  f.Q.value = opts.q ?? 1;
  const g = c.createGain();
  g.gain.setValueAtTime(opts.gain ?? 0.4, at);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  src.connect(f).connect(g).connect(master!);
  src.start(at, Math.random() * 0.5);
  src.stop(at + dur + 0.02);
}

/** A drum hit: a falling low tone under a noise slap. */
function drum(at: number, gain = 0.5) {
  tone(140, at, 0.25, { gain, to: 55 });
  noise(at, 0.12, { freq: 900, q: 0.8, gain: gain * 0.5 });
}

/** A bell: a few inharmonic partials. */
function bell(freq: number, at: number, gain = 0.18) {
  tone(freq, at, 1.2, { gain });
  tone(freq * 2.76, at, 0.6, { gain: gain * 0.35 });
  tone(freq * 5.4, at, 0.3, { gain: gain * 0.15 });
}

/** A brass-like horn note. */
function horn(freq: number, at: number, dur: number, gain = 0.16) {
  tone(freq, at, dur, { type: 'sawtooth', gain, filter: 1400 });
  tone(freq / 2, at, dur, { type: 'triangle', gain: gain * 0.6 });
}

// ---- the sounds ------------------------------------------------------------------------

const SOUNDS: Record<SoundName, (t: number) => void> = {
  // A wooden tap, like setting down a miniature.
  selectArmy: (t) => { noise(t, 0.06, { freq: 2200, q: 4, gain: 0.5 }); tone(420, t, 0.08, { type: 'triangle', gain: 0.15 }); },
  // A lighter tick on the map.
  selectNode: (t) => { noise(t, 0.04, { freq: 3500, q: 6, gain: 0.3 }); },
  // A quill scratch: an order is written into the plan.
  order: (t) => { noise(t, 0.18, { freq: 5000, q: 2, gain: 0.18, type: 'highpass' }); },
  // A few marching steps.
  march: (t) => { for (let i = 0; i < 4; i++) noise(t + i * 0.13, 0.07, { freq: 260, q: 1.5, gain: 0.45 }); },
  // Dice rattling in a cup, then landing.
  dice: (t) => {
    for (let i = 0; i < 9; i++) noise(t + i * 0.035 + Math.random() * 0.015, 0.03, { freq: 2600 + Math.random() * 1500, q: 8, gain: 0.35 });
    noise(t + 0.38, 0.05, { freq: 1800, q: 5, gain: 0.5 });
    noise(t + 0.46, 0.04, { freq: 2100, q: 5, gain: 0.35 });
  },
  // Drums and a horn call.
  battle: (t) => {
    drum(t); drum(t + 0.18, 0.4); drum(t + 0.36, 0.6);
    horn(196, t + 0.5, 0.35); horn(261.6, t + 0.85, 0.55);
  },
  // Paper: a card is played or drawn.
  card: (t) => { noise(t, 0.16, { freq: 3000, q: 0.7, gain: 0.22 }); noise(t + 0.05, 0.1, { freq: 6000, q: 1, gain: 0.1 }); },
  // Two bells: it is your move.
  yourTurn: (t) => { bell(659.3, t); bell(880, t + 0.22); },
  chat: (t) => { tone(880, t, 0.12, { gain: 0.08 }); tone(1320, t + 0.06, 0.12, { gain: 0.06 }); },
  // A drum roll.
  recruit: (t) => { for (let i = 0; i < 8; i++) noise(t + i * 0.05, 0.06, { freq: 700, q: 1, gain: 0.2 + i * 0.03 }); drum(t + 0.42, 0.5); },
  victory: (t) => { horn(261.6, t, 0.25); horn(329.6, t + 0.25, 0.25); horn(392, t + 0.5, 0.25); horn(523.3, t + 0.75, 0.9, 0.2); drum(t + 0.75, 0.6); },
  defeat: (t) => { horn(220, t, 0.6, 0.12); horn(207.7, t + 0.6, 0.6, 0.12); horn(146.8, t + 1.2, 1.2, 0.12); },
  // A clock ticking: time is running out.
  warning: (t) => { noise(t, 0.03, { freq: 3000, q: 10, gain: 0.4 }); noise(t + 0.5, 0.03, { freq: 2200, q: 10, gain: 0.4 }); },
  error: (t) => { tone(150, t, 0.18, { type: 'square', gain: 0.08, filter: 600 }); },
  click: (t) => { noise(t, 0.03, { freq: 1500, q: 3, gain: 0.25 }); },
};

/** Sounds that played a moment ago are not repeated (many updates may ask for the same one). */
const lastPlayed = new Map<SoundName, number>();
const MIN_GAP_MS = 120;

export const sound = {
  play(name: SoundName) {
    if (!ctx || !master || volume <= 0 || ctx.state !== 'running') return;
    const now = performance.now();
    if (now - (lastPlayed.get(name) ?? 0) < MIN_GAP_MS) return;
    lastPlayed.set(name, now);
    try { SOUNDS[name](ctx.currentTime + 0.01); } catch { /* audio not available */ }
  },
  volume() { return volume; },
  setVolume(v: number) {
    volume = Math.min(1, Math.max(0, v));
    try { localStorage.setItem(VOLUME_KEY, String(volume)); } catch { /* storage unavailable */ }
    if (master && ctx) master.gain.setValueAtTime(volume, ctx.currentTime);
  },
};
