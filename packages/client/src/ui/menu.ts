import { parseConfig, type GameMode, type LogEntry } from '@krieg/engine';
import {
  listBrowserMaps, listServerMaps, loadServerMap, mapHash, saveBrowserMap, type MapBundle,
} from '../maps';
import { HostSession } from '../net/host';
import { ReplaySession } from '../net/replay';
import { PeerSession } from '../net/peer';
import type { MapRef, SeatInfo } from '../net/protocol';
import { hostRoom } from '../net/rtc';
import type { Session } from '../net/session';
import { unpackBundle } from '../storage/bundle';
import { idb } from '../storage/idb';
import { clear, download, h, pickFiles, toast } from './dom';
import { buildEmblems, emblemEl, emblemSvg } from './emblem';
import { iconEl } from './icons';
import {
  applyTheme, CANONICAL_ID, currentTheme, listThemes, onThemeChange, playerOverride, resolveTheme, setPlayerOverride, useThemeForMap,
} from '../theme/theme';
import type { SaveRecord } from './game';
import { errorText, languageName, mapNameText, nationText, preferredLanguage, setDefaultNames, setPreferredLanguage, t, useMapText } from '../i18n/i18n';

export interface MenuActions {
  play(session: Session): void;
  lobby(session: Session): void;
  edit(map: MapBundle | null): void;
  gallery(): void;
}

const NAME_KEY = 'krieg:name';
function playerName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}

async function mapRef(map: MapBundle): Promise<MapRef> {
  const hash = await mapHash(map);
  return map.source === 'server' ? { kind: 'server', id: map.id.replace(/^server:/, ''), hash } : { kind: 'bundle', hash, name: map.name };
}

const MODE_KEY = 'krieg:mode';

/** The game mode chosen for new games: null keeps the map's own rule. */
function chosenMode(): GameMode | null {
  try { const m = localStorage.getItem(MODE_KEY); return m === 'freeForAll' || m === 'sides' ? m : null; } catch { return null; }
}

/**
 * Starts a game. A new game (no log) takes the mode chosen in the menu; it is written into the
 * map's rules, so saves and online players get the same rules.
 */
export async function startGame(map: MapBundle, online: boolean, actions: MenuActions, log: LogEntry[] = [], aiSeats: string[] = []) {
  try {
    const mode = log.length ? null : chosenMode();
    if (mode) map = { ...map, config: { ...map.config, rules: { ...(map.config.rules as object ?? {}), mode } } };
    const config = parseConfig(map.config);
    const session = new HostSession(map, config, await mapRef(map), log, aiSeats);
    if (online) {
      const room = await hostRoom((ch) => session.addChannel(ch));
      session.room = room.room;
      for (const s of session.seats()) if (s.holder !== 'ai') session.release(s.nation);
    }
    // The lobby is where the host picks which nations the computer plays.
    actions.lobby(session);
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Opens a saved game as a replay. */
export function watchReplay(map: MapBundle, log: LogEntry[], actions: MenuActions) {
  try {
    actions.play(new ReplaySession(map, parseConfig(map.config), log));
  } catch (e) {
    toast(errorText(e), 'error');
  }
}

type MenuView = 'title' | 'newGame' | 'loadGame' | 'replays' | 'multiplayer' | 'editor' | 'settings';

/** A map as listed in the menu, with the nations of its config for the emblem strip. */
interface MapEntry {
  name: string;
  source: 'server' | 'browser';
  ready: boolean;
  langs: { code: string; name: string }[];
  nations: { id: string; name: string; color: string; emblem?: { glyph?: string; shape?: string } }[];
  towns: number;
  load(): Promise<MapBundle>;
  remove?: () => Promise<void>;
}

/** A saved game as listed in the menu. */
interface SaveEntry {
  title: string;
  detail: string;
  open(): Promise<{ map: MapBundle; log: LogEntry[]; aiSeats: string[] }>;
  download?: () => void;
  remove?: () => Promise<void>;
}

const ENTRIES: { view: Exclude<MenuView, 'title'>; icon: string }[] = [
  { view: 'newGame', icon: 'icon:battle' },
  { view: 'loadGame', icon: 'icon:ledger' },
  { view: 'replays', icon: 'icon:replay' },
  { view: 'multiplayer', icon: 'icon:network' },
  { view: 'editor', icon: 'icon:map' },
  { view: 'settings', icon: 'icon:settings' },
];

/** The theme's ornament (e.g. "〜" or "❦"), used to set off titles. */
function ornament(): string {
  return (currentTheme() as { ornament?: { divider?: string } | null }).ornament?.divider ?? '✦';
}

function divider(): HTMLElement {
  return h('div', { class: 'ornament', 'aria-hidden': 'true' }, ornament());
}

/** The game's seal: a "K" in the theme's first emblem shape, in its seal colors. */
function titleSeal(): HTMLElement {
  const theme = currentTheme();
  const { fill, text } = theme.color.seal;
  // The emblem's ink is the theme's paper; on the seal it is the seal's own text color instead.
  const sealTheme = { ...theme, color: { ...theme.color, surface: { ...theme.color.surface, raised: text } } };
  const el = h('span', { class: 'emblem', style: 'width:76px;height:76px', 'aria-hidden': 'true' });
  el.innerHTML = emblemSvg({ nation: 'krieg', glyph: 'K', shape: theme.emblem.shapes[0], style: 'field', color: fill }, sealTheme);
  return el;
}

/** A faint compass rose drawn in the page's ink, behind the menu. */
function compassRose(): SVGSVGElement {
  const pts: string[] = [];
  for (let i = 0; i < 16; i++) {
    const a = (i * Math.PI) / 8;
    const rad = i % 4 === 0 ? 96 : i % 2 === 0 ? 62 : 26;
    pts.push(`${(100 + rad * Math.sin(a)).toFixed(1)},${(100 - rad * Math.cos(a)).toFixed(1)}`);
  }
  const ticks = Array.from({ length: 72 }, (_, i) => {
    const a = (i * Math.PI) / 36;
    const r0 = i % 9 === 0 ? 76 : 80;
    return `M${(100 + r0 * Math.sin(a)).toFixed(1)} ${(100 - r0 * Math.cos(a)).toFixed(1)}L${(100 + 84 * Math.sin(a)).toFixed(1)} ${(100 - 84 * Math.cos(a)).toFixed(1)}`;
  }).join('');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 200 200');
  svg.setAttribute('class', 'compass-rose');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = `<circle cx="100" cy="100" r="84" fill="none" stroke="currentColor" stroke-width="0.8"/>`
    + `<circle cx="100" cy="100" r="72" fill="none" stroke="currentColor" stroke-width="0.5"/>`
    + `<path d="${ticks}" stroke="currentColor" stroke-width="0.6"/>`
    + `<polygon points="${pts.join(' ')}" fill="currentColor" fill-opacity="0.35" stroke="currentColor" stroke-width="0.8"/>`
    + `<text x="100" y="9" text-anchor="middle" font-size="12" fill="currentColor">N</text>`;
  return svg;
}

export async function menuScreen(root: HTMLElement, actions: MenuActions, start: MenuView = 'title') {
  // Outside a map, only the built-in English and the player's own choice apply.
  useMapText(null);
  const invite = new URLSearchParams(location.hash.slice(1)).get('join');
  let view: MenuView = invite ? 'multiplayer' : start;
  const page = h('div', { class: 'menu-page' });
  const screen = h('div', { class: 'menu-screen' }, compassRose(), page);
  clear(root, screen);

  let maps: MapEntry[] = [];
  let saves: SaveEntry[] = [];
  let languages = new Map<string, string>([['en', languageName('en', {})]]);

  const show = (v: MenuView) => {
    view = v;
    render();
    page.querySelector<HTMLElement>(v === 'title' ? '.menu-entry' : '.back')?.focus({ preventScroll: true });
    screen.scrollTop = 0;
  };
  const back = () => { if (view !== 'title') show('title'); };
  const onKey = (e: KeyboardEvent) => {
    if (!screen.isConnected) { document.removeEventListener('keydown', onKey); return; }
    if (e.key === 'Escape' && !(e.target as HTMLElement).closest('input, select')) back();
  };
  document.addEventListener('keydown', onKey);
  // The title's emblem and ornament follow the theme chosen in the settings.
  const unsubTheme = onThemeChange(() => { if (!screen.isConnected) { unsubTheme(); return; } render(); });

  function render() {
    clear(page, view === 'title' ? titleView() : subView(view));
  }

  // ---- title --------------------------------------------------------------------------

  function titleView() {
    const latest = saves[0];
    return [
      h('header', { class: 'title-block' },
        titleSeal(),
        h('h1', {}, 'Krieg'),
        divider(),
        h('p', { class: 'tagline' }, t('menu.tagline'))),
      h('nav', { class: 'menu-entries', 'aria-label': t('menu.mainMenu') },
        latest ? entry('icon:move', t('menu.continue'), `${latest.title} · ${latest.detail}`, () => void openSave(latest, false), true) : null,
        ENTRIES.map((e) => entry(e.icon, t(`menu.${e.view}`), t(`menu.${e.view}Desc`), () => show(e.view)))),
    ];
  }

  function entry(icon: string, title: string, desc: string, onclick: () => void, featured = false) {
    return h('button', { class: `menu-entry${featured ? ' featured' : ''}`, onclick },
      h('span', { class: 'me-icon' }, iconEl(icon, 24)),
      h('span', { class: 'me-text' }, h('span', { class: 'me-title' }, title), h('span', { class: 'me-desc' }, desc)),
      h('span', { class: 'me-chevron', 'aria-hidden': 'true' }, '›'));
  }

  // ---- sub-menus ----------------------------------------------------------------------

  function subView(v: Exclude<MenuView, 'title'>) {
    return [
      h('header', { class: 'page-head' },
        h('button', { class: 'back', onclick: back, title: 'Esc' }, `← ${t('menu.back')}`),
        h('h1', {}, t(`menu.${v}`)),
        divider(),
        h('p', { class: 'tagline' }, t(`menu.${v}Desc`))),
      ...{ newGame, loadGame, replays, multiplayer, editor, settings }[v](),
    ];
  }

  const panel = (title: string | null, ...children: Parameters<typeof h>[2][]) =>
    h('section', { class: 'menu-panel' }, title ? h('h2', {}, title) : null, ...children);

  function modeSelect() {
    return h('label', { class: 'row', title: t('menu.modeTitle') }, `${t('menu.mode')} `, h('select', {
      onchange: (e: Event) => {
        const v = (e.target as HTMLSelectElement).value;
        try { if (v) localStorage.setItem(MODE_KEY, v); else localStorage.removeItem(MODE_KEY); } catch { /* storage unavailable */ }
      },
    },
    h('option', { value: '', selected: !chosenMode() }, t('menu.modeMap')),
    h('option', { value: 'sides', selected: chosenMode() === 'sides' }, t('menu.modeSides')),
    h('option', { value: 'freeForAll', selected: chosenMode() === 'freeForAll' }, t('menu.modeFreeForAll'))));
  }

  function mapCard(m: MapEntry, buttons: (HTMLElement | null)[]) {
    const emblems = buildEmblems(m.nations, null);
    const langs = m.langs.length > 1
      ? h('span', { title: t('menu.languagesTitle', { languages: m.langs.map((l) => l.name).join(', ') }) }, ` · ${m.langs.map((l) => l.code).join(' ')}`)
      : null;
    return h('div', { class: 'item map-card' },
      h('div', { class: 'map-card-info' },
        h('strong', {}, m.name),
        h('div', { class: 'muted small' },
          m.source === 'server' ? t('menu.server') : t('menu.thisBrowser'),
          m.ready ? ` · ${t('menu.mapSize', { nations: m.nations.length, towns: m.towns })}` : ` · ${t('menu.needsSetup')}`, langs),
        m.nations.length ? h('div', { class: 'emblem-strip' }, m.nations.map((n) => emblemEl(emblems.get(n.id), 26, n.name))) : null),
      h('div', { class: 'row' }, buttons));
  }

  const mapList = (make: (m: MapEntry) => (HTMLElement | null)[], only = (m: MapEntry) => m.ready) => {
    const rows = maps.filter(only).map((m) => mapCard(m, make(m)));
    return h('div', { class: 'list' }, rows.length ? rows : h('p', { class: 'muted' }, t('menu.noMaps')));
  };

  const saveList = (make: (s: SaveEntry) => (HTMLElement | null)[], empty: string) => h('div', { class: 'list' },
    saves.length
      ? saves.map((s) => h('div', { class: 'item' },
        h('div', {}, h('strong', {}, s.title), h('div', { class: 'muted small' }, s.detail)),
        h('div', { class: 'row' }, make(s))))
      : h('p', { class: 'muted' }, empty));

  const delButton = (label: string, confirmText: string, remove?: () => Promise<void>) => (remove
    ? h('button', { class: 'danger', onclick: async () => { if (confirm(confirmText)) { await remove(); await refresh(); } } }, label)
    : null);

  async function openSave(s: SaveEntry, online: boolean) {
    try {
      const { map, log, aiSeats } = await s.open();
      void startGame(map, online, actions, log, aiSeats);
    } catch (e) { toast(errorText(e), 'error'); }
  }

  async function playMap(m: MapEntry, online: boolean) {
    try { void startGame(await m.load(), online, actions); } catch (e) { toast(errorText(e), 'error'); }
  }

  function newGame() {
    return [
      panel(null, h('div', { class: 'row' }, modeSelect())),
      panel(t('menu.chooseMap'), mapList((m) => [
        h('button', { class: 'primary', onclick: () => void playMap(m, false) }, t('menu.playHotseat'))])),
    ];
  }

  function loadGame() {
    return [
      panel(t('menu.saves'), saveList((s) => [
        h('button', { class: 'primary', onclick: () => void openSave(s, false) }, t('menu.continueHotseat')),
        s.download ? h('button', { onclick: s.download }, t('menu.download')) : null,
        delButton(t('menu.delete'), t('menu.confirmDeleteSave', { name: s.title }), s.remove)], t('menu.noSaves')),
      h('div', { class: 'row' }, h('button', { onclick: () => void importFile() }, t('menu.importSave')))),
    ];
  }

  function replays() {
    return [
      panel(t('menu.saves'), saveList((s) => [
        h('button', {
          class: 'primary', title: t('menu.replayTitle'),
          onclick: async () => {
            try { const { map, log } = await s.open(); watchReplay(map, log, actions); } catch (e) { toast(errorText(e), 'error'); }
          },
        }, t('menu.watch'))], t('menu.noReplays'))),
    ];
  }

  function multiplayer() {
    const nameInput = h('input', { placeholder: t('menu.yourName'), value: playerName(), 'aria-label': t('menu.yourName') });
    const roomInput = h('input', { placeholder: t('menu.roomCode'), maxlength: 6, style: 'text-transform:uppercase', value: invite ?? '', 'aria-label': t('menu.roomCode') });
    const joinStatus = h('span', { class: 'muted' });
    const join = async () => {
      savePlayerName(nameInput.value);
      try {
        const s = await PeerSession.join(roomInput.value, nameInput.value, (m) => { joinStatus.textContent = m; });
        actions.lobby(s);
      } catch (e) {
        joinStatus.textContent = '';
        toast(errorText(e), 'error');
      }
    };
    return [
      panel(t('menu.join'),
        invite ? h('p', { class: 'muted small' }, t('menu.inviteReady')) : null,
        h('div', { class: 'row' }, nameInput, roomInput, h('button', { class: 'primary', onclick: join }, t('menu.joinButton')), joinStatus)),
      panel(t('menu.hostNew'),
        h('div', { class: 'row' }, modeSelect()),
        mapList((m) => [h('button', { class: 'primary', onclick: () => void playMap(m, true) }, t('menu.hostOnline'))])),
      panel(t('menu.hostSaved'), saveList((s) => [
        h('button', { onclick: () => void openSave(s, true) }, t('menu.hostOnline'))], t('menu.noSaves'))),
    ];
  }

  function editor() {
    return [
      panel(null, h('div', { class: 'row' },
        h('button', { class: 'primary', onclick: () => actions.edit(null) }, t('menu.newMap')),
        h('button', { onclick: () => void importFile() }, t('menu.importMap')))),
      panel(t('menu.maps'), mapList((m) => [
        h('button', { class: 'primary', onclick: async () => { try { actions.edit(await m.load()); } catch (e) { toast(errorText(e), 'error'); } } }, t('menu.edit')),
        delButton(t('menu.delete'), t('menu.confirmDeleteMap', { name: m.name }), m.remove)], () => true)),
    ];
  }

  function settings() {
    // The player's theme choice overrides each map's own theme (docs/design-system.md §2.2).
    const themeSelect = h('select', {
      onchange: async (e: Event) => {
        const id = (e.target as HTMLSelectElement).value || null;
        setPlayerOverride(id);
        applyTheme(await resolveTheme(id ?? CANONICAL_ID));
      },
    },
    h('option', { value: '', selected: !playerOverride() }, t('menu.themeMapDefault')));
    // Themes are the folders in themes/, listed by the server.
    void listThemes().then((list) => themeSelect.append(...list.map((th) => h('option', { value: th.id, selected: playerOverride() === th.id }, th.name))));
    // Languages come from the maps' translation tables; the choice applies wherever a map offers it.
    const langSelect = h('select', { onchange: (e: Event) => { setPreferredLanguage((e.target as HTMLSelectElement).value); void menuScreen(root, actions, 'settings'); } },
      [...languages].map(([code, name]) => h('option', { value: code, selected: code === preferredLanguage() }, name)));
    const nameInput = h('input', { value: playerName(), placeholder: t('menu.yourName'), onchange: (e: Event) => savePlayerName((e.target as HTMLInputElement).value) });
    return [
      panel(t('menu.appearance'),
        h('label', { class: 'row' }, `${t('menu.theme')} `, themeSelect),
        h('label', { class: 'row' }, `${t('menu.language')} `, langSelect),
        h('div', { class: 'row' }, h('button', { title: t('menu.galleryTitle'), onclick: () => actions.gallery() }, t('menu.gallery')))),
      panel(t('menu.player'),
        h('label', { class: 'row' }, `${t('menu.yourName')} `, nameInput),
        h('p', { class: 'muted small' }, t('menu.playerNameHint'))),
    ];
  }

  // ---- data ---------------------------------------------------------------------------

  async function importFile() {
    const [file] = await pickFiles('.krieg,.zip');
    if (!file) return;
    try {
      const bundle = await unpackBundle(file);
      if (bundle.log) {
        const rec: SaveRecord = {
          id: crypto.randomUUID(), title: bundle.meta?.title ?? file.name, date: bundle.meta?.date ?? new Date().toISOString(),
          mapName: bundle.map.name, turn: bundle.meta?.turn ?? 0, blob: file,
        };
        await idb.put('saves', rec);
        toast(t('menu.importedSave', { name: rec.title }));
      } else {
        await saveBrowserMap(bundle.map);
        toast(t('menu.importedMap', { name: bundle.map.name }));
      }
      await refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function refresh() {
    const [server, browser] = await Promise.all([listServerMaps(), listBrowserMaps().catch(() => [] as MapBundle[])]);
    // Only the configs of server maps, for their nations: the images load when a game starts.
    const configs = await Promise.all(server.map((m) => (m.ready
      ? fetch(`/api/maps/${encodeURIComponent(m.id)}/config.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({}))
      : Promise.resolve({}))));
    const langs = new Map<string, string>([['en', languageName('en', {})]]);
    const describe = (config: Record<string, unknown>) => ({
      nations: Array.isArray(config.nations) ? config.nations as MapEntry['nations'] : [],
      towns: Array.isArray(config.nodes) ? config.nodes.length : 0,
    });
    maps = [
      ...server.map((m, i): MapEntry => {
        const l = (m.languages ?? []).map((code) => ({ code, name: m.languageNames?.[code] ?? languageName(code, {}) }));
        for (const x of l) langs.set(x.code, x.name);
        return { name: m.name, source: 'server', ready: m.ready, langs: l, ...describe(configs[i]), load: () => loadServerMap(m.id) };
      }),
      ...browser.filter((b) => !b.id.startsWith('hash:')).map((m): MapEntry => {
        const text = (m.config.text ?? {}) as Record<string, unknown>;
        const names = (m.config.languageNames ?? {}) as Record<string, string>;
        const l = ['en', ...Object.keys(text).filter((c) => c !== 'en')].map((code) => ({ code, name: names[code] ?? languageName(code, {}) }));
        for (const x of l) langs.set(x.code, x.name);
        const d = describe(m.config);
        return { name: m.name, source: 'browser', ready: d.towns > 0, langs: l, ...d, load: async () => m, remove: () => idb.delete('maps', m.id) };
      }),
    ];
    languages = langs;

    const local = (await idb.all<SaveRecord>('saves').catch(() => [] as SaveRecord[])).sort((a, b) => b.date.localeCompare(a.date));
    const serverSaves: { file: string }[] = await fetch('/api/saves').then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const unpack = async (blob: Blob, key: string) => {
      const b = await unpackBundle(blob, key);
      return { map: b.map, log: b.log ?? [], aiSeats: savedAiSeats(b.meta?.seats) };
    };
    saves = [
      ...local.map((s): SaveEntry => ({
        title: s.title,
        // Save titles usually name the map already.
        detail: [s.title.includes(s.mapName) ? '' : s.mapName, s.turn ? t('menu.turnN', { n: s.turn }) : '', new Date(s.date).toLocaleString()]
          .filter(Boolean).join(' · '),
        open: () => unpack(s.blob, `save:${s.id}`),
        download: () => download(s.blob, `${s.title.replace(/\W+/g, '_')}.krieg`),
        remove: () => idb.delete('saves', s.id),
      })),
      ...serverSaves.map((s): SaveEntry => ({
        title: s.file,
        detail: t('menu.server'),
        open: async () => unpack(await fetch(`/api/saves/${encodeURIComponent(s.file)}`).then((r) => r.blob()), `save:${s.file}`),
      })),
    ];
    if (screen.isConnected) render();
  }

  render();
  await refresh();
}

function savePlayerName(name: string) {
  try { localStorage.setItem(NAME_KEY, name); } catch { /* storage unavailable */ }
}

/** Nations a save says the computer played. */
function savedAiSeats(seats: Record<string, string> | undefined): string[] {
  return Object.entries(seats ?? {}).filter(([, h]) => h === 'ai').map(([n]) => n);
}

function holderText(session: Session, s: SeatInfo): string {
  switch (s.holder) {
    case 'you': return session.isHost ? t('lobby.playedHere') : t('lobby.you');
    case 'host': return t('lobby.host');
    case 'other': return s.label ?? t('lobby.anotherPlayer');
    case 'ai': return t(s.aiRole === 'defensive' ? 'lobby.aiDefensive' : 'lobby.aiOffensive');
    default: return t('lobby.open');
  }
}

/** Seat selection before a game starts: who plays each nation, here, remotely or by computer. */
export function lobbyScreen(root: HTMLElement, session: Session, onStart: () => void, onExit: () => void) {
  void useThemeForMap(session.map.config);
  useMapText(session.map.config);
  setDefaultNames(session.map.config);
  const emblems = buildEmblems(session.config.nations, session.map);
  const host = session instanceof HostSession ? session : null;
  const render = () => {
    if (session.started()) { stop(); onStart(); return; }
    const link = `${location.origin}${location.pathname}#join=${session.room}`;
    clear(root, h('div', { class: 'menu-screen' }, compassRose(), h('div', { class: 'menu-page' },
      h('header', { class: 'page-head' },
        h('h1', {}, mapNameText(session.map.name)),
        divider(),
        h('p', { class: 'tagline' }, t('lobby.tagline'))),
      session.room ? h('div', { class: 'room menu-panel' },
        h('div', {}, t('lobby.roomCode')),
        h('div', { class: 'code' }, session.room),
        h('div', { class: 'row' }, h('input', { value: link, readonly: true, style: 'width:28em' }),
          h('button', { onclick: () => void navigator.clipboard?.writeText(link).then(() => toast(t('lobby.copied'))) }, t('lobby.copyInvite')))) : null,
      h('section', { class: 'menu-panel' },
        h('h2', {}, t('lobby.nations')),
        session.seats().map((s) => h('div', { class: 'item' },
          h('div', { class: 'row' }, emblemEl(emblems.get(s.nation), 30), h('strong', {}, nationText(s.nation)), h('span', { class: 'muted' }, ` · ${t(`role.${s.side}`)}`)),
          h('div', { class: 'row' },
            h('span', { title: s.holder === 'ai' ? t(s.aiRole === 'defensive' ? 'lobby.aiDefensiveTitle' : 'lobby.aiOffensiveTitle') : undefined }, holderText(session, s)),
            s.holder === null || (host && s.holder === 'ai') ? h('button', { onclick: () => session.claim(s.nation) }, session.isHost ? t('lobby.playHere') : t('lobby.take')) : null,
            s.holder === 'you' && (!host || session.room) ? h('button', { onclick: () => session.release(s.nation) }, session.isHost ? t('lobby.openRemote') : t('lobby.release')) : null,
            host && (s.holder === 'you' || s.holder === null) ? h('button', { title: t(s.aiRole === 'defensive' ? 'lobby.aiDefensiveTitle' : 'lobby.aiOffensiveTitle'), onclick: () => host.setAi(s.nation) }, t('lobby.playAi')) : null)))),
      h('p', { class: 'muted' }, session.status()),
      h('div', { class: 'row' },
        host ? h('button', { class: 'primary', onclick: () => host.start() }, t(session.room ? 'lobby.start' : 'lobby.startLocal')) : h('span', { class: 'waiting' }, t('lobby.waitingHost')),
        h('button', { onclick: () => { stop(); onExit(); } }, t('lobby.leave'))),
    )));
  };
  const unsub = session.subscribe(render);
  // The map's theme arrives after the first render; its ornament and colors follow.
  const unsubTheme = onThemeChange(render);
  const stop = () => { unsub(); unsubTheme(); };
  render();
}
