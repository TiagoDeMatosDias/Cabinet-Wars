import { formatMessage, MESSAGES, type HistoryEntry, type MessageKey, type MessageParams } from '@cabinet-wars/engine';
import { EN, type UiKey } from './en';

/**
 * Interface language. English is built in; a map adds languages in `config.json`:
 *
 *   "languageNames": { "zh": "中文" },
 *   "text": { "zh": { "controls.end": "结束回合", "nation.qin": "秦", "node.n1": "咸阳" } }
 *
 * Keys are the English dictionary's keys (src/i18n/en.ts), the engine's message keys
 * (log.*, event.*, reason.*, …), error templates as "error:<English template>", and map content:
 * "map.name", "nation.<id>", "node.<id>", "general.<id>". Missing keys fall back to English.
 */
type Dict = Record<string, string>;

const PREF_KEY = 'krieg:lang';
let mapText: Record<string, Dict> = {};
let mapLanguageNames: Record<string, string> = {};
let current = 'en';
const listeners = new Set<() => void>();

export function preferredLanguage(): string {
  try { return localStorage.getItem(PREF_KEY) ?? 'en'; } catch { return 'en'; }
}

export function setPreferredLanguage(lang: string) {
  try { localStorage.setItem(PREF_KEY, lang); } catch { /* storage unavailable */ }
  choose();
}

/** Uses a map's translations; the player's preferred language applies if the map offers it. */
export function useMapText(config: Record<string, unknown> | null) {
  mapText = (config?.text as Record<string, Dict>) ?? {};
  mapLanguageNames = (config?.languageNames as Record<string, string>) ?? {};
  choose();
}

function choose() {
  const pref = preferredLanguage();
  current = pref === 'en' || mapText[pref] ? pref : 'en';
  document.documentElement.lang = current;
  for (const l of listeners) l();
}

export function language(): string {
  return current;
}

/** Languages the current map offers (English always). */
export function availableLanguages(): { code: string; name: string }[] {
  return ['en', ...Object.keys(mapText).filter((l) => l !== 'en')].map((code) => ({ code, name: languageName(code) }));
}

export function languageName(code: string, names: Record<string, string> = mapLanguageNames): string {
  if (code === 'en') return mapText.en?.['lang.en'] ?? EN['lang.en'];
  return names[code] ?? code;
}

export function onLanguageChange(cb: () => void) {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Raw lookup: current language, then the map's English overrides, then built-in English. */
function lookup(key: string): string | undefined {
  return mapText[current]?.[key] ?? mapText.en?.[key] ?? (EN as Dict)[key] ?? (MESSAGES as Dict)[key];
}

/** Translates an interface key and fills `{placeholders}`. Nation and node parameters show as names. */
export function t(key: UiKey | MessageKey, params: MessageParams = {}): string {
  return formatMessage(lookup(key) ?? key, params, nameOf, (k) => lookup(k) ?? k);
}

/** Plural helper: picks `<base>One` or `<base>Many`. */
export function tn(base: string, count: number, params: MessageParams = {}): string {
  return t(`${base}${count === 1 ? 'One' : 'Many'}` as UiKey, { count, ...params });
}

// ---- names ----------------------------------------------------------------------

let fallbackNames: { nations: Record<string, string>; nodes: Record<string, string>; generals: Record<string, string>; map: string } = {
  nations: {}, nodes: {}, generals: {}, map: '',
};

/** Default (English) names from the map, used when a language has no translation. */
export function setDefaultNames(config: Record<string, unknown>) {
  const list = (k: string) => (Array.isArray(config[k]) ? (config[k] as { id: string; name?: string }[]) : []);
  fallbackNames = {
    nations: Object.fromEntries(list('nations').map((n) => [n.id, n.name ?? n.id])),
    nodes: Object.fromEntries(list('nodes').map((n) => [n.id, n.name || n.id])),
    generals: Object.fromEntries(list('generals').map((n) => [n.id, n.name ?? n.id])),
    map: String(config.name ?? ''),
  };
}

function nameOf(kind: 'nation' | 'node', id: string): string {
  return kind === 'nation' ? nationText(id) : nodeText(id);
}

export function nationText(id: string): string {
  return lookup(`nation.${id}`) ?? fallbackNames.nations[id] ?? id;
}

export function nodeText(id: string): string {
  return lookup(`node.${id}`) ?? fallbackNames.nodes[id] ?? id;
}

export function generalText(id: string, fallback?: string): string {
  const named = lookup(`general.${id}`) ?? fallbackNames.generals[id] ?? fallback;
  // Generals appointed by a Recruit General event have no name: "General 12".
  return named || t('army.appointedGeneral', { n: id.replace(/\D/g, '') || id });
}

export function mapNameText(fallback: string): string {
  return lookup('map.name') ?? (fallbackNames.map || fallback);
}

/** A log entry in the current language (entries without a message key keep their English text). */
export function logText(e: HistoryEntry): string {
  return e.msg ? t(e.msg.key as MessageKey, e.msg.params) : e.text;
}

/** An engine error in the current language. Errors carry their English template and parameters. */
export function errorText(e: unknown): string {
  const err = e as { template?: string; params?: MessageParams; message?: string };
  if (err?.template) {
    const tr = lookup(`error:${err.template}`) ?? err.template;
    return formatMessage(tr, err.params ?? {}, nameOf, (k) => lookup(k) ?? k);
  }
  return err?.message ?? String(e);
}

/** Every key a map may translate, with its English text (for the map editor). */
export function translatableKeys(): Record<string, string> {
  return { ...(MESSAGES as Dict), ...(EN as Dict) };
}
