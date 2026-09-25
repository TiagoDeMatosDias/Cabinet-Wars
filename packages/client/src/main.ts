import 'lxgw-wenkai-webfont/lxgwwenkai-regular.css';
import 'lxgw-wenkai-webfont/lxgwwenkai-bold.css';
import '@fontsource/noto-serif-sc/400.css';
import '@fontsource/noto-serif-sc/700.css';
import type { MapBundle } from './maps';
import { applyTheme, CANONICAL_ID, listThemes, playerOverride, resolveTheme } from './theme/theme';
import { t } from './i18n/i18n';
import type { Session } from './net/session';
import { editorScreen } from './editor/editor';
import { galleryScreen } from './ui/gallery';
import { gameScreen } from './ui/game';
import { lobbyScreen, menuScreen, startGame, type MenuActions } from './ui/menu';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;

function reset() {
  cleanup?.();
  cleanup = null;
}

const actions: MenuActions = {
  play(session: Session) {
    reset();
    void gameScreen(root, session, () => { if (confirm(t('game.leaveConfirm'))) location.reload(); }, (replay) => actions.play(replay))
      .then((c) => { cleanup = c; });
  },
  lobby(session: Session) {
    reset();
    lobbyScreen(root, session, () => actions.play(session), () => location.reload());
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
};

function menu(view?: Parameters<typeof menuScreen>[2]) {
  reset();
  // Outside a game: the player's chosen theme, or the canonical one.
  void resolveTheme(playerOverride() ?? CANONICAL_ID).then(applyTheme);
  void listThemes();
  void menuScreen(root, actions, view);
}

menu();
