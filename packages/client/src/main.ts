import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import { parseConfig, RULES_VERSION } from '@cabinet-wars/engine';
import { listServerMaps, loadServerMap, type MapBundle } from './maps';
import { LocalSession } from './net/local';
import { startTutorial } from './ui/tutorial';
import { applyTheme, CANONICAL_ID, listThemes, playerOverride, resolveTheme } from './theme/theme';
import { t } from './i18n/i18n';
import type { Session } from './net/session';
import { editorScreen } from './editor/editor';
import { galleryScreen } from './ui/gallery';
import { gameScreen } from './ui/game';
import { lobbyScreen, menuScreen, playerName, setInviteHash, startGame, type MenuActions } from './ui/menu';
import { connectionBanner } from './ui/chat';
import { toast } from './ui/dom';
import { installTooltips } from './ui/tooltip';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
/** The connection banner of the online game being shown. */
let banner: { session: Session; remove: () => void } | null = null;

function reset() {
  cleanup?.();
  cleanup = null;
}

/**
 * Leaves a game and starts over at the menu. An online game carries on on the server: players
 * can come back to it from the menu. Its host may instead end it for everyone.
 */
function leave(session: Session, ask = true) {
  if (session.online && session.isHost && session.link === 'connected') {
    if (confirm(t('game.endForAllConfirm'))) session.end(); else session.leave();
  } else {
    if (ask && !confirm(session.online ? t('game.leaveOnlineConfirm') : t('game.leaveConfirm'))) return;
    session.leave();
  }
  setInviteHash(null);
  location.reload();
}

function showBanner(session: Session) {
  if (banner?.session === session) return;
  banner?.remove();
  banner = session.room ? { session, remove: connectionBanner(session, () => leave(session, false)) } : null;
}

const actions: MenuActions = {
  play(session: Session) {
    reset();
    showBanner(session);
    void gameScreen(root, session, () => leave(session), (replay) => actions.play(replay))
      .then((c) => { cleanup = c; });
  },
  lobby(session: Session) {
    reset();
    showBanner(session);
    lobbyScreen(root, session, () => actions.play(session), () => leave(session, false));
  },
  edit(map: MapBundle | null) {
    reset();
    void editorScreen(root, map, {
      back: () => menu('editor'),
      play: (m) => void startGame(m, false, actions),
    }).then((c) => { cleanup = c; });
  },
  gallery() {
    reset();
    void galleryScreen(root, () => menu('settings')).then((c) => { cleanup = c; });
  },
  /**
   * The guided first game: the smallest map the server offers (Iberia, two nations), the player
   * as its first nation and the computer as the others, with the tutorial's notes on top.
   */
  async tutorial() {
    try {
      const maps = (await listServerMaps()).filter((m) => m.ready);
      const pick = maps.find((m) => /iberia/i.test(m.id)) ?? maps[0];
      if (!pick) { toast(t('tutorial.noMap'), 'error'); return; }
      toast(t('join.loadingMap'));
      let map = await loadServerMap(pick.id);
      map = { ...map, config: { ...map.config, rules: { ...(map.config.rules as object ?? {}), version: RULES_VERSION, mode: 'sides' } } };
      const config = parseConfig(map.config);
      const session = new LocalSession(map, config, [], config.nations.slice(1).map((n) => n.id), playerName().trim() || t('lobby.host'));
      session.start();
      actions.play(session);
      startTutorial();
    } catch (e) {
      toast(String((e as Error).message), 'error');
    }
  },
};

function menu(view?: Parameters<typeof menuScreen>[2]) {
  reset();
  // Outside a game: the player's chosen theme, or the canonical one.
  void resolveTheme(playerOverride() ?? CANONICAL_ID).then(applyTheme);
  void listThemes();
  void menuScreen(root, actions, view);
}

// Errors the server reports about the player's own actions (not about game moves).
window.addEventListener('cabinet-wars:error', (e) => toast(String((e as CustomEvent).detail), 'error'));
installTooltips();
// An online game in the address (#join=CODE, also after a reload) is joined from the menu.
menu();
