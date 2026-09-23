import type { Theme } from './theme';

/** WCAG 2 relative luminance and contrast ratio. */
function luminance(hex: string): number {
  const s = hex.replace('#', '').slice(0, 6);
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (l1 + 0.05) / (l2 + 0.05);
}

/** CIE Lab and ΔE2000, for checking that highlights don't look like nation colors. */
function lab(hex: string): [number, number, number] {
  const s = hex.replace('#', '').slice(0, 6);
  const rgb = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) / 255).map((c) => (c > 0.04045 ? ((c + 0.055) / 1.055) ** 2.4 : c / 12.92));
  const x = (rgb[0] * 0.4124 + rgb[1] * 0.3576 + rgb[2] * 0.1805) / 0.95047;
  const y = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  const z = (rgb[0] * 0.0193 + rgb[1] * 0.1192 + rgb[2] * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

export function deltaE00(c1: string, c2: string): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1 = ((Math.atan2(b1, a1p) / rad) + 360) % 360;
  const h2 = ((Math.atan2(b2, a2p) / rad) + 360) % 360;
  const dL = L2 - L1;
  const dC = C2p - C1p;
  let dh = h2 - h1;
  if (C1p * C2p === 0) dh = 0;
  else if (dh > 180) dh -= 360;
  else if (dh < -180) dh += 360;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  const hb = Math.abs(h1 - h2) > 180 ? (h1 + h2 + 360) / 2 : (h1 + h2) / 2;
  const T = 1 - 0.17 * Math.cos((hb - 30) * rad) + 0.24 * Math.cos(2 * hb * rad) + 0.32 * Math.cos((3 * hb + 6) * rad) - 0.2 * Math.cos((4 * hb - 63) * rad);
  const SL = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)) * Math.sin(60 * Math.exp(-(((hb - 275) / 25) ** 2)) * rad);
  return Math.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH));
}

/** The contrast rules of docs/design-system.md §6.3, plus highlight-vs-nation checks. */
export function themeWarnings(t: Theme, nationColors: string[] = []): string[] {
  const c = t.color;
  const out: string[] = [];
  const need = (label: string, fg: string, bg: string, min: number) => {
    const r = contrast(fg, bg);
    if (r < min) out.push(`Theme contrast: ${label} is ${r.toFixed(1)}:1 (needs ${min}:1)`);
  };
  for (const [k, bg] of Object.entries(c.surface)) if (k !== 'scrim') need(`text on ${k}`, c.text.primary, bg, 4.5);
  need('muted text on panel', c.text.muted, c.surface.panel, 4.5);
  need('muted text on raised', c.text.muted, c.surface.raised, 4.5);
  need('primary button text', c.action.onPrimary, c.action.primary, 4.5);
  need('secondary button text', c.action.onSecondary, c.action.secondary, 4.5);
  for (const [k, v] of Object.entries(c.state)) need(`${k} text on panel`, v, c.surface.panel, 4.5);
  need('seal text', c.seal.text, c.seal.fill, 4.5);
  need('card text', c.card.ink, c.card.face, 4.5);
  need('die pips', c.die.pip, c.die.face, 4.5);
  need('control borders', c.border.control, c.surface.panel, 3);
  need('focus ring', c.focus, c.surface.panel, 3);
  need('map labels', t.map.label.fill, t.map.label.halo, 7);
  for (const [k, v] of Object.entries(t.map.highlight)) {
    if (typeof v !== 'string' || k === 'casing' || k === 'here') continue;
    for (const n of nationColors) {
      const d = deltaE00(v, n);
      if (d < 20) out.push(`Highlight "${k}" (${v}) looks too much like nation color ${n} (ΔE ${d.toFixed(0)}, needs 20)`);
    }
  }
  return out;
}
