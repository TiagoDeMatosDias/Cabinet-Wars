import { parseConfig, RULES_VERSION, type GameMode, type LogEntry } from '@cabinet-wars/engine';
import { AFK_CHOICES, COLOR_CHOICES, type GameListing, type SeatInfo } from '@cabinet-wars/table';
import {
  listBrowserMaps, listServerMaps, loadServerMap, saveBrowserMap, type MapBundle,
} from '../maps';
import { LocalSession } from '../net/local';
import { forgetGame, gameInfo, JoinError, listGames, myGames, OnlineSession } from '../net/online';
import { ReplaySession } from '../net/replay';
import type { Session } from '../net/session';
import { sound } from '../audio/sound';
import { alertsWanted, setAlertsWanted } from './alerts';
import { setWantsSummary, wantsSummary } from './summary';
import { BUNDLE_ACCEPT, BUNDLE_EXT, unpackBundle } from '../storage/bundle';
import { idb } from '../storage/idb';
import { chatBox, muteButton, onMuteChange } from './chat';
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
  /** Starts the guided first game. */
  tutorial(): void;
}

const NAME_KEY = 'krieg:name';
export function playerName(): string {
  try { return localStorage.getItem(NAME_KEY) ?? ''; } catch { return ''; }
}

/** The room this page joined, kept in the address so a reload rejoins it. */
export function setInviteHash(room: string | null) {
  history.replaceState(null, '', room ? `${location.pathname}${location.search}#join=${room}` : `${location.pathname}${location.search}`);
}

const MODE_KEY = 'krieg:mode';

/** The game mode chosen for new games: null keeps the map's own rule. */
function chosenMode(): GameMode | null {
  try { const m = localStorage.getItem(MODE_KEY); return m === 'freeForAll' || m === 'sides' ? m : null; } catch { return null; }
}

/**
 * Starts a game. A new game (no log) takes the mode chosen in the menu and the current rules
 * version; they are written into the map's rules, so saves and online players get the same rules.
 * A saved game keeps the rules it was started with.
 */
export async function startGame(map: MapBundle, online: boolean, actions: MenuActions, log: LogEntry[] = [], aiSeats: string[] = []) {
  try {
    if (!log.length) {
      const mode = chosenMode();
      const rules = { ...(map.config.rules as object ?? {}), version: RULES_VERSION, ...(mode ? { mode } : {}) };
      map = { ...map, config: { ...map.config, rules } };
    }
    const name = playerName().trim() || t('lobby.host');
    const session: Session = online
      ? await OnlineSession.create({ map, log, aiSeats, name, onProgress: (m) => toast(m) })
      : new LocalSession(map, parseConfig(map.config), log, aiSeats, name);
    if (session.room) setInviteHash(session.room);
    // The lobby is where the host picks which nations the computer plays.
    actions.lobby(session);
  } catch (e) {
    toast(errorText(e), 'error');
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

type MenuView = 'title' | 'newGame' | 'howToPlay' | 'loadGame' | 'replays' | 'multiplayer' | 'editor' | 'settings' | 'credits';

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

const ENTRIES: { view: Exclude<MenuView, 'title' | 'credits'>; icon: string }[] = [
  { view: 'newGame', icon: 'icon:battle' },
  { view: 'howToPlay', icon: 'icon:book' },
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

/** The game's seal: "CW" in the theme's first emblem shape, in its seal colors. */
function titleSeal(): HTMLElement {
  const theme = currentTheme();
  const { fill, text } = theme.color.seal;
  // The emblem's ink is the theme's paper; on the seal it is the seal's own text color instead.
  const sealTheme = { ...theme, color: { ...theme.color, surface: { ...theme.color.surface, raised: text } } };
  const el = h('span', { class: 'emblem', style: 'width:76px;height:76px', 'aria-hidden': 'true' });
  el.innerHTML = emblemSvg({ nation: 'cabinet-wars', glyph: 'CW', shape: theme.emblem.shapes[0], style: 'field', color: fill }, sealTheme);
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

/** Chapters of How to play (text keys howto.<id>.title / .body). */
const HOWTO_CHAPTERS = [
  'goal', 'turn', 'map', 'armies', 'movement', 'supply', 'battles', 'cards', 'events', 'raising', 'fog', 'control', 'online', 'controls',
] as const;

/** Paragraphs separated by blank lines; lines starting with "- " make a list. */
function richText(text: string) {
  return text.split(/\n\n+/).map((para) => {
    const lines = para.split('\n');
    if (lines.every((l) => l.startsWith('- '))) return h('ul', {}, lines.map((l) => h('li', {}, l.slice(2))));
    return h('p', {}, para);
  });
}

/** Credits: [name, what it is, license]. */
const CREDITS: { id: string; items: [string, string, string][] }[] = [
  { id: 'art', items: [
    ['Maps, emblems and unit miniatures', 'made for this game with the help of AI image and model generation', ''],
    ['Sounds', 'synthesized in the browser as the game plays', ''],
  ] },
  { id: 'fonts', items: [
    ['LXGW WenKai', 'by LXGW, via lxgw-wenkai-webfont', 'SIL Open Font License 1.1'],
    ['Noto Serif SC', 'by Google and Adobe, via Fontsource', 'SIL Open Font License 1.1'],
  ] },
  { id: 'software', items: [
    ['PixiJS', 'the map', 'MIT'],
    ['pixi-viewport', 'panning and zooming', 'MIT'],
    ['three.js', 'the 3D army miniatures', 'MIT'],
    ['d3-delaunay', 'fog of war areas', 'ISC'],
    ['fflate', 'save files', 'MIT'],
    ['Zod', 'map validation', 'MIT'],
    ['ws', 'the game server connections', 'MIT'],
    ['selfsigned', 'the HTTPS certificate of the server', 'MIT'],
    ['cloudflared', 'public links from Cloudflare for online games (downloaded when first needed)', 'Apache 2.0'],
    ['Vite, TypeScript, tsx, Vitest', 'building and testing', 'MIT / Apache 2.0'],
  ] },
];

export async function menuScreen(root: HTMLElement, actions: MenuActions, start: MenuView = 'title') {
  // Outside a map, only the built-in English and the player's own choice apply.
  useMapText(null);
  const invite = new URLSearchParams(location.hash.slice(1)).get('join');
  let view: MenuView = invite ? 'multiplayer' : start;
  const page = h('div', { class: 'menu-page' });
  const screen = h('div', { class: 'menu-screen' }, compassRose(), page);
  clear(root, screen);

  let maps: MapEntry[] = [];
  /** A join is under way; the invitation was acted on. */
  let joining = false;
  let autoJoined = false;
  const joinStatus = h('span', { class: 'muted' });
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
        h('h1', {}, 'Cabinet Wars'),
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
      ...{ newGame, howToPlay, loadGame, replays, multiplayer, editor, settings, credits }[v](),
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

  /** Joins a game (by code, from the list, or back into one of this browser's games). */
  async function joinGame(room: string, name: string, token?: string) {
    if (joining) return;
    if (!name.trim()) { toast(t('menu.nameNeeded'), 'error'); return; }
    savePlayerName(name.trim());
    joining = true;
    try {
      const s = await OnlineSession.join(room, name.trim(), (m) => { joinStatus.textContent = m; }, token);
      setInviteHash(s.room);
      actions.lobby(s);
    } catch (e) {
      joinStatus.textContent = '';
      const reason = (e as JoinError).reason;
      toast(reason === 'noRoom' ? t('menu.noRoom', { room: room.trim().toUpperCase() }) : errorText(e), 'error');
      if (reason === 'noRoom' || reason === 'kicked') { setInviteHash(null); forgetGame(room.trim().toUpperCase()); }
    } finally {
      joining = false;
    }
  }

  /** The games on this server, and this browser's own games, refreshed while the page shows them. */
  const openGames = h('div', { class: 'list' });
  const ownGames = h('div', { class: 'list' });
  let listTimer = 0;
  async function refreshGames(nameInput: () => string) {
    clearTimeout(listTimer);
    if (!screen.isConnected || view !== 'multiplayer') return;
    const [open, mine] = await Promise.all([listGames(), Promise.all(myGames().map(async (g) => ({ g, info: await gameInfo(g.room) })))]);
    const status = (l: GameListing) => [
      l.mapName,
      t('menu.gameHost', { name: l.host }),
      t('menu.gamePlayers', { online: l.online, players: l.players }),
      l.started ? t('menu.gameRound', { round: l.round }) : t('menu.gameOpenSeats', { n: l.openSeats }),
    ].join(' · ');
    const mineRooms = new Set(mine.map((x) => x.g.room));
    clear(openGames, open.filter((l) => !mineRooms.has(l.room)).length
      ? open.filter((l) => !mineRooms.has(l.room)).map((l) => h('div', { class: 'item' },
        h('div', {}, h('strong', {}, `${l.room}`), h('div', { class: 'muted small' }, status(l))),
        h('div', { class: 'row' }, h('button', {
          class: 'primary',
          disabled: l.started && !l.spectators,
          title: l.started && !l.spectators ? t('menu.noSpectatorsTitle') : undefined,
          onclick: () => void joinGame(l.room, nameInput()),
        }, l.started ? t('menu.watchGame') : t('menu.joinButton')))))
      : h('p', { class: 'muted' }, t('menu.noOpenGames')));
    // Games gone from the server are forgotten.
    for (const { g, info } of mine) if (!info) forgetGame(g.room);
    const alive = mine.filter((x) => x.info);
    clear(ownGames, alive.length
      ? alive.map(({ g, info }) => h('div', { class: 'item' },
        h('div', {}, h('strong', {}, `${g.room}${g.host ? ` · ${t('lobby.hostTag')}` : ''}`), h('div', { class: 'muted small' }, status(info!))),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => void joinGame(g.room, nameInput(), g.token) }, t('menu.returnToGame')),
          h('button', { class: 'danger', title: t('menu.forgetGameTitle'), onclick: () => { forgetGame(g.room); void refreshGames(nameInput); } }, t('menu.forgetGame')))))
      : h('p', { class: 'muted' }, t('menu.noOwnGames')));
    listTimer = window.setTimeout(() => void refreshGames(nameInput), 8000);
  }

  function multiplayer() {
    const nameInput = h('input', { placeholder: t('menu.yourName'), value: playerName(), 'aria-label': t('menu.yourName'), onchange: () => savePlayerName(nameInput.value.trim()) });
    const roomInput = h('input', { placeholder: t('menu.roomCode'), maxlength: 6, style: 'text-transform:uppercase', value: invite ?? '', 'aria-label': t('menu.roomCode') });
    const join = () => {
      if (!nameInput.value.trim()) { nameInput.focus(); toast(t('menu.nameNeeded'), 'error'); return; }
      if (!roomInput.value.trim()) { roomInput.focus(); return; }
      void joinGame(roomInput.value, nameInput.value);
    };
    // An invitation joins straight away once the player has a name (once: the menu renders again).
    if (invite && !autoJoined) {
      autoJoined = true;
      if (playerName().trim()) queueMicrotask(join); else queueMicrotask(() => nameInput.focus());
    }
    void refreshGames(() => nameInput.value);
    return [
      panel(t('menu.join'),
        invite ? h('p', { class: 'muted small' }, t('menu.inviteReady')) : null,
        h('form', { class: 'row', onsubmit: (e: Event) => { e.preventDefault(); join(); } },
          nameInput, roomInput, h('button', { class: 'primary', type: 'submit' }, t('menu.joinButton')), joinStatus)),
      panel(t('menu.ownGames'), ownGames),
      panel(t('menu.openGames'), h('p', { class: 'muted small' }, t('menu.openGamesHint')), openGames),
      panel(t('menu.hostNew'),
        h('div', { class: 'row' }, modeSelect()),
        mapList((m) => [h('button', { class: 'primary', onclick: () => void playMap(m, true) }, t('menu.hostOnline'))])),
      panel(t('menu.hostSaved'), saveList((s) => [
        h('button', { onclick: () => void openSave(s, true) }, t('menu.hostOnline'))], t('menu.noSaves'))),
    ];
  }

  /** The rules in short, chapter by chapter, and the way into the tutorial. */
  function howToPlay() {
    return [
      panel(t('howto.learn'),
        h('p', {}, t('howto.learnText')),
        h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => actions.tutorial() }, t('howto.startTutorial')))),
      panel(t('howto.rules'), h('div', { class: 'rules' }, HOWTO_CHAPTERS.map((c, i) => h('details', { open: i === 0 },
        h('summary', {}, t(`howto.${c}.title` as Parameters<typeof t>[0])),
        richText(t(`howto.${c}.body` as Parameters<typeof t>[0])))))),
    ];
  }

  /** Who and what made the game. */
  function credits() {
    return CREDITS.map((section) => panel(t(`credits.${section.id}` as Parameters<typeof t>[0]),
      h('ul', { class: 'credits' }, section.items.map(([name, what, license]) => h('li', {},
        h('strong', {}, name), what ? ` — ${what}` : null, license ? h('span', { class: 'muted small' }, ` · ${license}`) : null)))));
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
      panel(t('menu.soundAndAlerts'),
        h('label', { class: 'row' }, `${t('menu.volume')} `, h('input', {
          type: 'range', min: 0, max: 100, step: 5, value: Math.round(sound.volume() * 100), 'aria-label': t('menu.volume'),
          oninput: (e: Event) => sound.setVolume(Number((e.target as HTMLInputElement).value) / 100),
          onchange: () => sound.play('yourTurn'),
        })),
        h('label', { class: 'row' }, h('input', {
          type: 'checkbox', checked: alertsWanted(),
          onchange: (e: Event) => void setAlertsWanted((e.target as HTMLInputElement).checked).then(() => render()),
        }), t('menu.turnAlerts')),
        h('p', { class: 'muted small' }, t('menu.turnAlertsHint')),
        h('label', { class: 'row' }, h('input', {
          type: 'checkbox', checked: wantsSummary(), onchange: (e: Event) => setWantsSummary((e.target as HTMLInputElement).checked),
        }), t('menu.turnSummary'))),
      panel(t('menu.about'), h('div', { class: 'row' }, h('button', { onclick: () => show('credits') }, t('menu.credits')))),
    ];
  }

  // ---- data ---------------------------------------------------------------------------

  async function importFile() {
    const [file] = await pickFiles(BUNDLE_ACCEPT);
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
        download: () => download(s.blob, `${s.title.replace(/\W+/g, '_')}${BUNDLE_EXT}`),
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
    case 'you': return session.online ? t('lobby.you') : t('lobby.playedHere');
    case 'host': return session.players().find((p) => p.host)?.name ?? t('lobby.host');
    case 'other': return `${s.label ?? t('lobby.anotherPlayer')}${s.offline ? ` (${t('lobby.offline')})` : ''}`;
    case 'ai': return t(s.aiRole === 'defensive' ? 'lobby.aiDefensive' : 'lobby.aiOffensive');
    default: return t('lobby.open');
  }
}

interface NetworkInfo {
  public: { state: 'off' | 'starting' | 'ready' | 'failed'; url?: string; error?: string };
  lan: string[];
}

/** Where others can reach this server; waits for the public link to open. */
async function networkInfo(): Promise<NetworkInfo | null> {
  try {
    const res = await fetch('/api/network?wait=1');
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Invitation links for the room: over the internet, on the local network, and on this computer. */
function invitePanel(room: string) {
  const links = h('div', { class: 'invite-links' });
  const link = (label: string, base: string, primary = false) => {
    const url = `${base.replace(/\/$/, '')}/#join=${room}`;
    const input = h('input', { value: url, readonly: true, onfocus: (e: Event) => (e.target as HTMLInputElement).select() });
    return h('div', { class: `invite-link ${primary ? 'primary' : ''}` },
      h('div', { class: 'small muted' }, label),
      h('div', { class: 'row' }, input,
        h('button', {
          class: primary ? 'primary' : '',
          onclick: () => {
            input.select();
            void (navigator.clipboard?.writeText(url) ?? Promise.reject()).then(() => toast(t('lobby.copied')), () => document.execCommand('copy'));
          },
        }, t('lobby.copy'))));
  };
  const here = location.origin;
  const onPublic = /trycloudflare\.com$/.test(location.hostname);
  const paint = (net: NetworkInfo | null) => {
    const pub = net?.public;
    const rows: (HTMLElement | null)[] = [];
    if (onPublic) rows.push(link(t('lobby.inviteInternet'), here, true));
    else if (pub?.state === 'ready' && pub.url) rows.push(link(t('lobby.inviteInternet'), pub.url, true));
    else if (!net || pub?.state === 'starting') rows.push(h('p', { class: 'waiting small' }, t('lobby.publicStarting')));
    else if (pub?.state === 'failed') rows.push(h('p', { class: 'warn small' }, t('lobby.publicFailed', { error: pub.error ?? '' })));
    for (const lan of net?.lan ?? []) if (!here.startsWith(lan)) rows.push(link(t('lobby.inviteLan'), lan));
    rows.push(link(t('lobby.inviteHere'), here));
    links.replaceChildren(...rows.filter((r): r is HTMLElement => r !== null));
  };
  paint(null);
  // The public link takes a few seconds to open; keep asking while it does.
  const poll = async () => {
    const net = await networkInfo();
    if (!links.isConnected && net) return;
    paint(net);
    if (!net || net.public.state === 'starting') setTimeout(() => void poll(), 3000);
  };
  void poll();
  return h('section', { class: 'room menu-panel' },
    h('h2', {}, t('lobby.invite')),
    h('div', { class: 'row' }, h('span', {}, t('lobby.roomCode')), h('span', { class: 'code' }, room)),
    links);
}

/** Color swatches for a nation: the palette, with the colors other nations use marked as taken. */
function colorPicker(session: Session, s: SeatInfo) {
  const taken = new Set(session.seats().filter((x) => x.nation !== s.nation).map((x) => x.color.toLowerCase()));
  const original = (session.map.config.nations as { id: string; color: string }[] | undefined)?.find((n) => n.id === s.nation)?.color;
  return h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': t('lobby.colorFor', { nation: s.nation }) },
    original ? h('button', {
      class: `swatch map ${s.color.toLowerCase() === original.toLowerCase() ? 'current' : ''}`, style: `--swatch:${original}`,
      title: t('lobby.colorMap'), 'aria-label': t('lobby.colorMap'), disabled: taken.has(original.toLowerCase()),
      onclick: () => session.setColor(s.nation, null),
    }) : null,
    COLOR_CHOICES.map((c) => h('button', {
      class: `swatch ${s.color.toLowerCase() === c ? 'current' : ''}`, style: `--swatch:${c}`, role: 'radio',
      'aria-checked': String(s.color.toLowerCase() === c), 'aria-label': c, title: taken.has(c) ? t('lobby.colorTaken') : c,
      disabled: taken.has(c), onclick: () => session.setColor(s.nation, c),
    })));
}

/** The host's options for an online game. */
function settingsPanel(session: Session) {
  const st = session.settings();
  const disabled = !session.isHost;
  return h('section', { class: 'menu-panel' },
    h('h2', {}, t('lobby.settings')),
    h('label', { class: 'row', 'data-tip': t('lobby.afkTip') }, `${t('lobby.afk')} `, h('select', {
      disabled, onchange: (e: Event) => session.setSettings({ afkMinutes: Number((e.target as HTMLSelectElement).value) }),
    }, AFK_CHOICES.map((m) => h('option', { value: m, selected: st.afkMinutes === m }, m ? t('lobby.afkMinutes', { n: m }) : t('lobby.afkOff'))))),
    h('label', { class: 'row', 'data-tip': t('lobby.spectatorsTip') }, h('input', {
      type: 'checkbox', checked: st.allowSpectators, disabled, onchange: (e: Event) => session.setSettings({ allowSpectators: (e.target as HTMLInputElement).checked }),
    }), t('lobby.spectators')),
    h('label', { class: 'row', 'data-tip': t('lobby.listedTip') }, h('input', {
      type: 'checkbox', checked: st.listed, disabled, onchange: (e: Event) => session.setSettings({ listed: (e.target as HTMLInputElement).checked }),
    }), t('lobby.listed')),
    disabled ? h('p', { class: 'muted small' }, t('lobby.settingsHostOnly')) : null);
}

/**
 * Before a game starts: who plays each nation (here, remotely or by computer), their colors, who
 * is at the table, the host's options and the table's chat. Players pick their own nations; the
 * host starts the game.
 */
export function lobbyScreen(root: HTMLElement, session: Session, onStart: () => void, onExit: () => void) {
  void useThemeForMap(session.map.config);
  useMapText(session.map.config);
  setDefaultNames(session.map.config);
  const emblemsNow = () => buildEmblems(session.config.nations, session.map);
  let emblems = emblemsNow();
  const host = session.isHost;
  const online = session.online;

  const head = h('div');
  const invite = host && session.room ? invitePanel(session.room) : null;
  const nations = h('section', { class: 'menu-panel' });
  const players = h('div');
  const settings = h('div');
  const chat = online ? chatBox(session, () => emblems) : null;
  const foot = h('div');
  const page = h('div', { class: `menu-page ${online ? 'lobby-online' : ''}` },
    head, invite,
    online
      ? h('div', { class: 'lobby-grid' }, h('div', {}, nations, settings),
        h('section', { class: 'menu-panel lobby-side' }, players, h('h2', {}, t('chat.title')), chat!.el))
      : nations,
    foot);
  clear(root, h('div', { class: 'menu-screen' }, compassRose(), page));

  const aiTitle = (s: SeatInfo) => t(s.aiRole === 'defensive' ? 'lobby.aiDefensiveTitle' : 'lobby.aiOffensiveTitle');
  const seatButtons = (s: SeatInfo) => [
    s.holder === null || (host && s.holder === 'ai')
      ? h('button', { class: s.holder === null && !host ? 'primary' : '', onclick: () => { sound.play('click'); session.claim(s.nation); } }, online ? t('lobby.take') : t('lobby.playHere'))
      : null,
    s.holder === 'you' && online ? h('button', { onclick: () => session.release(s.nation) }, t('lobby.release')) : null,
    host && (s.holder === 'you' || s.holder === null) ? h('button', { 'data-tip': aiTitle(s), onclick: () => session.setAi(s.nation) }, t('lobby.playAi')) : null,
    host && s.holder === 'other' && s.offline ? h('button', { 'data-tip': t('lobby.freeSeatTitle'), onclick: () => session.release(s.nation) }, t('lobby.freeSeat')) : null,
  ];
  /** Seats whose color this player may change. */
  const canColor = (s: SeatInfo) => host || s.holder === 'you';
  let colorOpen: string | null = null;

  const render = () => {
    if (session.started()) { stop(); onStart(); return; }
    if (session.link !== 'connected' && session.link !== 'reconnecting') return;
    emblems = emblemsNow();
    clear(head, h('header', { class: 'page-head' },
      h('h1', {}, mapNameText(session.map.name)),
      divider(),
      h('p', { class: 'tagline' }, t('lobby.tagline'))));
    clear(nations,
      h('h2', {}, t('lobby.nations')),
      session.seats().map((s) => h('div', { class: `item seat ${s.holder === 'you' ? 'mine' : ''}`, style: `--c:${s.color}` },
        h('div', { class: 'row' },
          canColor(s)
            ? h('button', {
              class: 'seat-emblem', 'data-tip': t('lobby.changeColor'), 'aria-expanded': String(colorOpen === s.nation),
              onclick: () => { colorOpen = colorOpen === s.nation ? null : s.nation; render(); },
            }, emblemEl(emblems.get(s.nation), 30))
            : emblemEl(emblems.get(s.nation), 30),
          h('strong', {}, nationText(s.nation)), h('span', { class: 'muted' }, ` · ${t(`role.${s.side}`)}`)),
        h('div', { class: 'row' },
          h('span', { 'data-tip': s.holder === 'ai' ? aiTitle(s) : undefined }, holderText(session, s)),
          seatButtons(s)),
        colorOpen === s.nation && canColor(s) ? colorPicker(session, s) : null)));
    if (online) {
      clear(settings, settingsPanel(session));
      clear(players,
        h('h2', {}, t('lobby.players')),
        h('ul', { class: 'players' }, session.players().map((p) => h('li', { class: p.online ? '' : 'offline' },
          h('span', { class: `presence ${p.online ? 'on' : ''}`, 'aria-hidden': 'true' }),
          h('strong', {}, p.name),
          p.host ? h('span', { class: 'muted small' }, ` · ${t('lobby.hostTag')}`) : null,
          p.you ? h('span', { class: 'muted small' }, ` · ${t('lobby.youTag')}`) : null,
          p.online ? null : h('span', { class: 'muted small' }, ` · ${t('lobby.offline')}`),
          p.you ? null : muteButton(session, p.id, p.name),
          host && !p.host ? h('button', {
            class: 'danger small-button', 'data-tip': t('lobby.kickTitle'),
            onclick: () => { if (confirm(t('lobby.kickConfirm', { name: p.name }))) session.kick(p.id); },
          }, t('lobby.kick')) : null,
          h('span', { class: 'player-nations' }, p.nations.length
            ? p.nations.map((n) => emblemEl(emblems.get(n), 18, nationText(n)))
            : h('span', { class: 'muted small' }, t('lobby.noNation')))))));
    }
    clear(foot,
      h('p', { class: 'muted' }, session.status()),
      h('div', { class: 'row' },
        host ? h('button', { class: 'primary', onclick: () => session.start() }, t(online ? 'lobby.start' : 'lobby.startLocal')) : h('span', { class: 'waiting' }, t('lobby.waitingHost')),
        h('button', { onclick: () => { stop(); onExit(); } }, t('lobby.leave'))));
  };
  const unsub = session.subscribe(render);
  const unsubMute = onMuteChange(render);
  // The map's theme arrives after the first render; its ornament and colors follow.
  const unsubTheme = onThemeChange(render);
  const stop = () => { unsub(); unsubMute(); unsubTheme(); chat?.destroy(); };
  render();
}
