import type { Nation } from '@krieg/engine';
import type { MapBundle } from '../maps';
import { currentTheme, fontStack, type Theme } from '../theme/theme';

/**
 * Nation emblems: a small unique badge shown wherever a nation is named.
 * Maps may provide one per nation (`emblem: { glyph, shape }` or `{ image }`); otherwise it is
 * generated deterministically from the nations' names and ids (docs/game-screen.md §2).
 */
export interface Emblem {
  nation: string;
  glyph: string;
  shape: string;
  style: 'field' | 'outline';
  color: string;
  /** Object URL of an image emblem supplied by the map. */
  image?: string;
}

type NationLike = Pick<Nation, 'id' | 'name' | 'color'> & { emblem?: { glyph?: string; shape?: string; image?: string } };

const CJK = /[㐀-鿿豈-﫿]/;

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function letters(name: string): string {
  return name.replace(/[^\p{L}\p{N}]/gu, '');
}

/** Glyphs: the first CJK character, else the shortest prefix (≤ 3) that differs from every other name. */
function glyphs(nations: NationLike[]): string[] {
  const names = nations.map((n) => letters(n.name) || n.id);
  const out = nations.map((n, i) => {
    if (n.emblem?.glyph) return n.emblem.glyph;
    const cjk = n.name.match(CJK);
    if (cjk) return cjk[0];
    const name = names[i];
    for (let len = 1; len <= 3; len++) {
      const prefix = name.slice(0, len).toLowerCase();
      const clash = names.some((o, j) => j !== i && o.slice(0, len).toLowerCase() === prefix);
      if (!clash || len >= name.length) return name.slice(0, len);
    }
    return name.slice(0, 3);
  }).map((g) => (CJK.test(g) ? g : g.charAt(0).toUpperCase() + g.slice(1).toLowerCase()));
  // Still identical after 3 letters: first letter plus a number, in config order.
  const counts = new Map<string, number>();
  for (const g of out) counts.set(g, (counts.get(g) ?? 0) + 1);
  const seen = new Map<string, number>();
  return out.map((g) => {
    if ((counts.get(g) ?? 0) < 2) return g;
    const k = (seen.get(g) ?? 0) + 1;
    seen.set(g, k);
    return `${g.charAt(0)}${k}`;
  });
}

export function buildEmblems(nations: NationLike[], map: MapBundle | null, theme: Theme = currentTheme()): Map<string, Emblem> {
  const shapes = theme.emblem.shapes;
  const styles = theme.emblem.styles as Emblem['style'][];
  const gl = glyphs(nations);
  const out = new Map<string, Emblem>();
  const used = new Set<string>();
  nations.forEach((n, i) => {
    const h = fnv1a(n.id);
    let shapeIdx = n.emblem?.shape && shapes.includes(n.emblem.shape) ? shapes.indexOf(n.emblem.shape) : h % shapes.length;
    let styleIdx = (h >>> 8) % styles.length;
    const key = () => `${gl[i]}|${shapes[shapeIdx]}|${styles[styleIdx]}`;
    for (let tries = 0; used.has(key()) && tries < shapes.length * styles.length; tries++) {
      shapeIdx = (shapeIdx + 1) % shapes.length;
      if (shapeIdx === h % shapes.length) styleIdx = (styleIdx + 1) % styles.length;
    }
    used.add(key());
    const imageBlob = n.emblem?.image ? map?.files[n.emblem.image] : undefined;
    out.set(n.id, {
      nation: n.id,
      glyph: gl[i],
      shape: shapes[shapeIdx],
      style: styles[styleIdx],
      color: n.color,
      image: imageBlob ? URL.createObjectURL(imageBlob) : undefined,
    });
  });
  return out;
}

const SHAPES: Record<string, string> = {
  square: '<rect x="4" y="4" width="92" height="92" rx="3"/>',
  round: '<circle cx="50" cy="50" r="46"/>',
  gourd: '<path d="M50 4 C66 4 70 18 66 30 C84 36 94 50 94 64 C94 84 74 96 50 96 C26 96 6 84 6 64 C6 50 16 36 34 30 C30 18 34 4 50 4 Z"/>',
  tablet: '<path d="M8 96 V34 C8 14 26 4 50 4 C74 4 92 14 92 34 V96 Z"/>',
  'heater-shield': '<path d="M8 6 H92 V46 C92 74 72 88 50 96 C28 88 8 74 8 46 Z"/>',
  roundel: '<circle cx="50" cy="50" r="46"/>',
  banner: '<path d="M12 4 H88 V94 L50 76 L12 94 Z"/>',
  lozenge: '<path d="M50 3 L97 50 L50 97 L3 50 Z"/>',
};

function esc(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** SVG markup for an emblem, 100×100 view box. */
export function emblemSvg(e: Emblem, theme: Theme = currentTheme()): string {
  if (e.image) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><image href="${esc(e.image)}" width="100" height="100"/></svg>`;
  const paper = theme.color.surface.raised;
  const shape = SHAPES[e.shape] ?? SHAPES.square;
  const field = e.style === 'field';
  const fill = field ? e.color : paper;
  const ink = field ? paper : e.color;
  const size = e.glyph.length === 1 ? 60 : e.glyph.length === 2 ? 44 : 32;
  const inset = `<g transform="translate(50 50) scale(0.84) translate(-50 -50)" fill="none" stroke="${ink}" stroke-width="${field ? 3 : 4}">${shape}</g>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">`
    + `<g fill="${fill}" stroke="${field ? theme.color.text.primary : e.color}" stroke-width="${field ? 2 : 6}">${shape}</g>${inset}`
    + `<text x="50" y="${e.shape === 'gourd' ? 70 : 52}" text-anchor="middle" dominant-baseline="central" font-family='${esc(fontStack(theme.type.family.display))}' font-weight="700" font-size="${size}" fill="${ink}">${esc(e.glyph)}</text>`
    + `</svg>`;
}

/** An inline element for the DOM interface. */
export function emblemEl(e: Emblem | undefined, size = 24, title?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'emblem';
  span.style.width = span.style.height = `${size}px`;
  if (title) span.title = title;
  if (e) span.innerHTML = emblemSvg(e);
  return span;
}
