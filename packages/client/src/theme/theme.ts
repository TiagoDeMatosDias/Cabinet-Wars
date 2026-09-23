// The canonical theme lives in themes/ like every other theme. This bundled copy of the same file
// gives the token types and a fallback for when the server can't be reached.
import imperialChina from '../../../../themes/imperial-china/theme.json';

/**
 * Themes restyle the whole interface without code changes (see docs/design-system.md).
 * Every theme, including the default ones, is a folder in themes/ served at /api/themes.
 * The canonical theme (Imperial China) defines every token; other themes are partial and
 * are deep-merged over it (or over the theme they `extends`).
 */
export type Theme = typeof imperialChina;
export type PartialTheme = DeepPartial<Theme> & { id?: string; name?: string; extends?: string | null };
type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]> | null) : T[K] | null };

export const CANONICAL_ID = 'imperial-china';

export interface ThemeInfo { id: string; name: string }

let known: ThemeInfo[] = [{ id: CANONICAL_ID, name: imperialChina.name }];

/** The themes found by the last listThemes() call (at least the canonical one). */
export function knownThemes(): ThemeInfo[] {
  return known;
}

/** The themes in themes/ (from the server). The canonical theme is always listed. */
export async function listThemes(): Promise<ThemeInfo[]> {
  let list: ThemeInfo[] = [];
  try {
    const res = await fetch('/api/themes');
    if (res.ok) list = (await res.json()) as ThemeInfo[];
  } catch { /* offline: only the bundled canonical theme */ }
  if (!list.some((t) => t.id === CANONICAL_ID)) list.unshift({ id: CANONICAL_ID, name: imperialChina.name });
  known = list.sort((a, b) => (a.id === CANONICAL_ID ? -1 : b.id === CANONICAL_ID ? 1 : a.name.localeCompare(b.name)));
  return known;
}

const fetched = new Map<string, PartialTheme>();

const OVERRIDE_KEY = 'krieg:theme';

export function playerOverride(): string | null {
  try { return localStorage.getItem(OVERRIDE_KEY); } catch { return null; }
}

export function setPlayerOverride(id: string | null) {
  try { if (id) localStorage.setItem(OVERRIDE_KEY, id); else localStorage.removeItem(OVERRIDE_KEY); } catch { /* storage unavailable */ }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge: objects merge key by key, arrays and scalars replace. A `null` group resets to the base. */
function merge(base: unknown, over: unknown): unknown {
  if (over === undefined || over === null) return base;
  if (!isObject(base) || !isObject(over)) return over;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v === null ? base[k] : merge(base[k], v);
  return out;
}

async function fetchTheme(id: string): Promise<PartialTheme | null> {
  const cached = fetched.get(id);
  if (cached) return cached;
  const fallback = id === CANONICAL_ID ? (imperialChina as PartialTheme) : null;
  try {
    const base = `/api/themes/${encodeURIComponent(id)}/`;
    const res = await fetch(`${base}theme.json`);
    if (!res.ok) return fallback;
    const theme = (await res.json()) as PartialTheme;
    // Register the theme's bundled fonts, served from its folder.
    const assets = (theme.assets ?? {}) as Record<string, string>;
    const fonts = (theme.fonts ?? {}) as Record<string, { asset: string; weight?: number; style?: string }[]>;
    for (const [family, faces] of Object.entries(fonts)) {
      for (const f of faces) {
        const path = assets[f.asset];
        if (!path || /[()'"\\]/.test(path)) continue;
        const face = new FontFace(family, `url(${base}${path})`, { weight: String(f.weight ?? 400), style: f.style ?? 'normal' });
        document.fonts.add(face);
        void face.load().catch(() => {});
      }
    }
    fetched.set(id, theme);
    return theme;
  } catch {
    return fallback;
  }
}

/** Resolves a theme reference (id or inline object) into a complete theme, following `extends`. */
export async function resolveTheme(ref: unknown, depth = 0): Promise<Theme> {
  const canonical = imperialChina as Theme;
  let partial: PartialTheme | null = null;
  if (typeof ref === 'string') partial = await fetchTheme(ref);
  else if (isObject(ref)) partial = ref as PartialTheme;
  if (!partial || depth > 4) return canonical;
  const parentId = partial.extends ?? (partial.id === CANONICAL_ID ? null : CANONICAL_ID);
  const base = parentId && parentId !== partial.id ? await resolveTheme(parentId, depth + 1) : canonical;
  return merge(base, partial) as Theme;
}

/** The theme for a map: the player's override wins, then the map's own theme, then the canonical one. */
export function themeForMap(config: Record<string, unknown> | null): Promise<Theme> {
  return resolveTheme(playerOverride() ?? config?.theme ?? CANONICAL_ID);
}

// ---- applying -------------------------------------------------------------

let current: Theme = imperialChina as Theme;
const listeners = new Set<(t: Theme) => void>();

export function currentTheme(): Theme {
  return current;
}

export function onThemeChange(cb: (t: Theme) => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

const PX_GROUPS = ['type.size', 'shape.radius', 'shape.border', 'space', 'cards', 'drawer.width'];

function cssValue(path: string, v: unknown): string | null {
  if (typeof v === 'number') {
    if (PX_GROUPS.some((g) => path.startsWith(g)) && !path.endsWith('fan')) return `${v}px`;
    if (path.startsWith('motion.') || path.endsWith('.delay')) return `${v}ms`;
    return String(v);
  }
  if (typeof v === 'string') return v;
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return path.startsWith('type.family') ? v.map((f) => (/^[\w-]+$/.test(f) ? f : `"${f}"`)).join(', ') : null;
  }
  if (isObject(v) && 'x' in v && 'blur' in v) return `${v.x}px ${v.y}px ${v.blur}px ${v.color}`;
  return null;
}

/** Writes every token as a CSS custom property, e.g. color.surface.panel → --k-color-surface-panel. */
export function applyTheme(theme: Theme) {
  current = theme;
  const root = document.documentElement;
  const walk = (obj: unknown, path: string) => {
    if (isObject(obj) && !('x' in obj && 'blur' in obj)) {
      for (const [k, v] of Object.entries(obj)) walk(v, path ? `${path}.${k}` : k);
      return;
    }
    const value = cssValue(path, obj);
    if (value !== null && !/[;{}<>]/.test(value)) root.style.setProperty(`--k-${path.replace(/[.+]/g, '-')}`, value);
  };
  for (const group of ['color', 'map', 'type', 'shape', 'space', 'motion', 'cards', 'tooltip', 'orders', 'controls', 'battle', 'drawer']) {
    walk((theme as Record<string, unknown>)[group], group);
  }
  root.style.colorScheme = theme.scheme;
  root.dataset.theme = theme.id;
  for (const l of listeners) l(theme);
}

/** Resolves and applies a map's theme, then waits for its fonts so canvas text renders in them. */
export async function useThemeForMap(config: Record<string, unknown> | null): Promise<Theme> {
  const theme = await themeForMap(config);
  applyTheme(theme);
  await loadFonts(theme);
  return theme;
}

export async function loadFonts(theme: Theme) {
  const families = [...theme.type.family.display, ...theme.type.family.body, ...theme.type.family.map].filter((f) => !/serif|sans|monospace/.test(f));
  await Promise.all([...new Set(families)].map((f) => document.fonts.load(`16px "${f}"`, '秦Aa1').catch(() => [])));
}

export function fontStack(families: string[]): string {
  return families.map((f) => (/^[\w-]+$/.test(f) ? f : `"${f}"`)).join(', ');
}

/** Pixi wants colors as numbers. */
export function hex(c: string): number {
  return parseInt(c.replace('#', '').slice(0, 6), 16) || 0;
}

/** Alpha of an 8-digit hex color (1 when absent). */
export function alphaOf(c: string): number {
  const s = c.replace('#', '');
  return s.length === 8 ? parseInt(s.slice(6), 16) / 255 : 1;
}
