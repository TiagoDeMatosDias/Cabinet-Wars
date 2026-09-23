import { parseConfig, type GameMode, type LogEntry } from '@krieg/engine';
import {
  listBrowserMaps, listServerMaps, loadServerMap, mapHash, saveBrowserMap, type MapBundle,
} from '../maps';
import { HostSession } from '../net/host';
import { PeerSession } from '../net/peer';
import type { MapRef } from '../net/protocol';
import { hostRoom } from '../net/rtc';
import type { Session } from '../net/session';
import { unpackBundle } from '../storage/bundle';
import { idb } from '../storage/idb';
import { clear, download, h, pickFiles, toast } from './dom';
import { buildEmblems, emblemEl } from './emblem';
import { applyTheme, CANONICAL_ID, listThemes, playerOverride, resolveTheme, setPlayerOverride, useThemeForMap } from '../theme/theme';
import type { SaveRecord } from './game';
import { errorText, languageName, mapNameText, nationText, preferredLanguage, setDefaultNames, setPreferredLanguage, t, useMapText } from '../i18n/i18n';

export interface MenuActions {
  play(session: Session): void;
  lobby(session: Session): void;
  edit(map: MapBundle | null): void;
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
export async function startGame(map: MapBundle, online: boolean, actions: MenuActions, log: LogEntry[] = []) {
  try {
    const mode = log.length ? null : chosenMode();
    if (mode) map = { ...map, config: { ...map.config, rules: { ...(map.config.rules as object ?? {}), mode } } };
    const config = parseConfig(map.config);
    const session = new HostSession(map, config, await mapRef(map), log);
    if (online) {
      const room = await hostRoom((ch) => session.addChannel(ch));
      session.room = room.room;
      for (const s of session.seats()) session.release(s.nation);
      actions.lobby(session);
    } else {
      session.start();
      actions.play(session);
    }
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export async function menuScreen(root: HTMLElement, actions: MenuActions) {
  // Outside a map, only the built-in English and the player's own choice apply.
  useMapText(null);
  const mapsBox = h('div', { class: 'list' }, '…');
  const savesBox = h('div', { class: 'list' }, '…');
  const nameInput = h('input', { placeholder: t('menu.yourName'), value: playerName() });
  const roomInput = h('input', { placeholder: t('menu.roomCode'), maxlength: 6, style: 'text-transform:uppercase' });
  const joinStatus = h('span', { class: 'muted' });

  const join = async () => {
    try { localStorage.setItem(NAME_KEY, nameInput.value); } catch { /* ignore */ }
    try {
      const s = await PeerSession.join(roomInput.value, nameInput.value, (m) => { joinStatus.textContent = m; });
      actions.lobby(s);
    } catch (e) {
      joinStatus.textContent = '';
      toast(errorText(e), 'error');
    }
  };

  // The player's theme choice overrides each map's own theme (docs/design-system.md §2.2).
  const themeSelect = h('select', {
    onchange: async (e: Event) => {
      const id = (e.target as HTMLSelectElement).value || null;
      setPlayerOverride(id);
      applyTheme(await resolveTheme(id ?? CANONICAL_ID));
    },
  },
  h('option', { value: '', selected: !playerOverride() }, t('menu.themeMapDefault')),
  );
  // Themes are the folders in themes/, listed by the server.
  void listThemes().then((list) => themeSelect.append(...list.map((th) => h('option', { value: th.id, selected: playerOverride() === th.id }, th.name))));
  // Languages come from the maps' translation tables; the choice applies wherever a map offers it.
  const langSelect = h('select', { onchange: (e: Event) => { setPreferredLanguage((e.target as HTMLSelectElement).value); void menuScreen(root, actions); } });
  const invite = new URLSearchParams(location.hash.slice(1)).get('join');
  if (invite) roomInput.value = invite;

  clear(root, h('div', { class: 'menu' },
    h('h1', {}, 'Krieg'),
    h('p', { class: 'muted' }, t('menu.tagline')),
    h('section', {}, h('h2', {}, t('menu.newGame')),
      h('label', { class: 'row', title: t('menu.modeTitle') }, `${t('menu.mode')} `, h('select', {
        onchange: (e: Event) => {
          const v = (e.target as HTMLSelectElement).value;
          try { if (v) localStorage.setItem(MODE_KEY, v); else localStorage.removeItem(MODE_KEY); } catch { /* storage unavailable */ }
        },
      },
      h('option', { value: '', selected: !chosenMode() }, t('menu.modeMap')),
      h('option', { value: 'sides', selected: chosenMode() === 'sides' }, t('menu.modeSides')),
      h('option', { value: 'freeForAll', selected: chosenMode() === 'freeForAll' }, t('menu.modeFreeForAll')))),
      mapsBox),
    h('section', {},
      h('h2', {}, t('menu.join')),
      h('div', { class: 'row' }, nameInput, roomInput, h('button', { class: 'primary', onclick: join }, t('menu.joinButton')), joinStatus)),
    h('section', {},
      h('h2', {}, t('menu.saves')),
      savesBox,
      h('div', { class: 'row' }, h('button', { onclick: () => void importFile() }, t('menu.import')))),
    h('section', {},
      h('h2', {}, t('menu.maps')),
      h('div', { class: 'row' },
        h('button', { onclick: () => actions.edit(null) }, t('menu.newMap')))),
    h('section', {},
      h('h2', {}, t('menu.appearance')),
      h('label', { class: 'row' }, `${t('menu.theme')} `, themeSelect),
      h('label', { class: 'row' }, `${t('menu.language')} `, langSelect)),
  ));

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
      void refresh();
    } catch (e) {
      toast(errorText(e), 'error');
    }
  }

  async function refresh() {
    const server = await listServerMaps();
    const browser = await listBrowserMaps().catch(() => [] as MapBundle[]);
    const rows: HTMLElement[] = [];
    // Languages offered by any map, for the language setting.
    const languages = new Map<string, string>([['en', languageName('en', {})]]);
    const langBadge = (langs: { code: string; name: string }[]) => (langs.length > 1
      ? h('span', { class: 'muted small', title: t('menu.languagesTitle', { languages: langs.map((l) => l.name).join(', ') }) }, ` · ${langs.map((l) => l.code).join(' ')}`)
      : null);
    for (const m of server) {
      const langs = (m.languages ?? []).map((code) => ({ code, name: m.languageNames?.[code] ?? languageName(code, {}) }));
      for (const l of langs) languages.set(l.code, l.name);
      rows.push(h('div', { class: 'item' },
        h('div', {}, h('strong', {}, m.name), h('span', { class: 'muted' }, ` · ${t('menu.server')}${m.ready ? '' : ` · ${t('menu.needsSetup')}`}`), langBadge(langs)),
        h('div', { class: 'row' },
          m.ready ? h('button', { class: 'primary', onclick: async () => startGame(await loadServerMap(m.id), false, actions) }, t('menu.playHotseat')) : null,
          m.ready ? h('button', { onclick: async () => startGame(await loadServerMap(m.id), true, actions) }, t('menu.hostOnline')) : null,
          h('button', { onclick: async () => actions.edit(await loadServerMap(m.id)) }, t('menu.edit')))));
    }
    for (const m of browser.filter((b) => !b.id.startsWith('hash:'))) {
      const text = (m.config.text ?? {}) as Record<string, unknown>;
      const names = (m.config.languageNames ?? {}) as Record<string, string>;
      const langs = ['en', ...Object.keys(text).filter((c) => c !== 'en')].map((code) => ({ code, name: names[code] ?? languageName(code, {}) }));
      for (const l of langs) languages.set(l.code, l.name);
      rows.push(h('div', { class: 'item' },
        h('div', {}, h('strong', {}, m.name), h('span', { class: 'muted' }, ` · ${t('menu.thisBrowser')}`), langBadge(langs)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => startGame(m, false, actions) }, t('menu.playHotseat')),
          h('button', { onclick: () => startGame(m, true, actions) }, t('menu.hostOnline')),
          h('button', { onclick: () => actions.edit(m) }, t('menu.edit')),
          h('button', { class: 'danger', onclick: async () => { if (confirm(t('menu.confirmDeleteMap', { name: m.name }))) { await idb.delete('maps', m.id); void refresh(); } } }, t('menu.delete')))));
    }
    clear(mapsBox, rows.length ? rows : h('p', { class: 'muted' }, t('menu.noMaps')));
    clear(langSelect, [...languages].map(([code, name]) => h('option', { value: code, selected: code === preferredLanguage() }, name)));

    const saves = (await idb.all<SaveRecord>('saves').catch(() => [] as SaveRecord[])).sort((a, b) => b.date.localeCompare(a.date));
    const serverSaves: { file: string }[] = await fetch('/api/saves').then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const saveRows = saves.map((s) => {
      const open = async (online: boolean) => {
        const b = await unpackBundle(s.blob, `save:${s.id}`);
        void startGame(b.map, online, actions, b.log ?? []);
      };
      return h('div', { class: 'item' },
        h('div', {}, h('strong', {}, s.title), h('span', { class: 'muted' }, ` · ${new Date(s.date).toLocaleString()}`)),
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => open(false) }, t('menu.continueHotseat')),
          h('button', { onclick: () => open(true) }, t('menu.hostOnline')),
          h('button', { onclick: () => download(s.blob, `${s.title.replace(/\W+/g, '_')}.krieg`) }, t('menu.download')),
          h('button', { class: 'danger', onclick: async () => { if (confirm(t('menu.confirmDeleteSave', { name: s.title }))) { await idb.delete('saves', s.id); void refresh(); } } }, t('menu.delete'))));
    });
    for (const s of serverSaves) {
      saveRows.push(h('div', { class: 'item' },
        h('div', {}, h('strong', {}, s.file), h('span', { class: 'muted' }, ` · ${t('menu.server')}`)),
        h('div', { class: 'row' },
          h('button', {
            onclick: async () => {
              const blob = await fetch(`/api/saves/${encodeURIComponent(s.file)}`).then((r) => r.blob());
              const b = await unpackBundle(blob, `save:${s.file}`);
              void startGame(b.map, false, actions, b.log ?? []);
            },
          }, t('menu.continueHotseat')))));
    }
    clear(savesBox, saveRows.length ? saveRows : h('p', { class: 'muted' }, t('menu.noSaves')));
  }
  await refresh();
}

/** Seat selection before an online game starts. */
export function lobbyScreen(root: HTMLElement, session: Session, onStart: () => void, onExit: () => void) {
  void useThemeForMap(session.map.config);
  useMapText(session.map.config);
  setDefaultNames(session.map.config);
  const emblems = buildEmblems(session.config.nations, session.map);
  const render = () => {
    if (session.started()) { unsub(); onStart(); return; }
    const link = `${location.origin}${location.pathname}#join=${session.room}`;
    clear(root, h('div', { class: 'menu' },
      h('h1', {}, mapNameText(session.map.name)),
      session.room ? h('div', { class: 'room' },
        h('div', {}, t('lobby.roomCode')),
        h('div', { class: 'code' }, session.room),
        h('div', { class: 'row' }, h('input', { value: link, readonly: true, style: 'width:28em' }),
          h('button', { onclick: () => void navigator.clipboard?.writeText(link).then(() => toast(t('lobby.copied'))) }, t('lobby.copyInvite')))) : null,
      h('section', {},
        h('h2', {}, t('lobby.nations')),
        session.seats().map((s) => h('div', { class: 'item' },
          h('div', { class: 'row' }, emblemEl(emblems.get(s.nation), 30), h('strong', {}, nationText(s.nation)), h('span', { class: 'muted' }, ` · ${t(`role.${s.side}`)}`)),
          h('div', { class: 'row' },
            h('span', {}, s.holder === 'you' ? (session.isHost ? t('lobby.playedHere') : t('lobby.you')) : s.holder === 'host' ? t('lobby.host') : s.holder === 'other' ? (s.label ?? t('lobby.anotherPlayer')) : t('lobby.open')),
            s.holder === null ? h('button', { onclick: () => session.claim(s.nation) }, session.isHost ? t('lobby.playHere') : t('lobby.take')) : null,
            s.holder === 'you' ? h('button', { onclick: () => session.release(s.nation) }, session.isHost ? t('lobby.openRemote') : t('lobby.release')) : null)))),
      h('p', { class: 'muted' }, session.status()),
      h('div', { class: 'row' },
        session.isHost ? h('button', { class: 'primary', onclick: () => (session as HostSession).start() }, t('lobby.start')) : h('span', { class: 'waiting' }, t('lobby.waitingHost')),
        h('button', { onclick: () => { unsub(); onExit(); } }, t('lobby.leave'))),
    ));
  };
  const unsub = session.subscribe(render);
  render();
}
