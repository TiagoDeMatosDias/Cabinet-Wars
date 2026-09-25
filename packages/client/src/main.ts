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
import { lobbyScreen, menuScreen, setInviteHash, startGame, type MenuActions } from './ui/menu';
import { connectionBanner } from './ui/chat';
import { resumeHosting } from './net/hosting';

const root = document.getElementById('app')!;
let cleanup: (() => void) | null = null;
/** The connection banner of the online game being shown. */
let banner: { session: Session; remove: () => void } | null = null;

function reset() {
  cleanup?.();
  cleanup = null;
}

/** Leaves an online game (a host ends its room) and starts over at the menu. */
function leave(session: Session) {
  session.leave();
  setInviteHash(null);
  location.reload();
}

function showBanner(session: Session) {
  if (banner?.session === session) return;
  banner?.remove();
  banner = session.room ? { session, remove: connectionBanner(session, () => leave(session)) } : null;
}

const actions: MenuActions = {
  play(session: Session) {
    reset();
    showBanner(session);
    void gameScreen(root, session, () => { if (confirm(t('game.leaveConfirm'))) leave(session); }, (replay) => actions.play(replay))
      .then((c) => { cleanup = c; });
  },
  lobby(session: Session) {
    reset();
    showBanner(session);
    lobbyScreen(root, session, () => actions.play(session), () => leave(session));
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

// A tab that hosted an online game takes it back after a reload.
void resumeHosting().then((session) => {
  if (!session) menu();
  else if (session.started()) actions.play(session);
  else actions.lobby(session);
});
