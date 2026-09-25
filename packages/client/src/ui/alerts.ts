import type { Session } from '../net/session';
import { sound } from '../audio/sound';
import { t } from '../i18n/i18n';

/**
 * Tells the player when the game waits for them: a bell, and while the tab is in the background
 * a blinking tab title and (if they allow it) a browser notification.
 */
const WANT_KEY = 'krieg:alerts';
const BLINK_MS = 1000;

export function alertsWanted(): boolean {
  try { return localStorage.getItem(WANT_KEY) !== 'off'; } catch { return true; }
}

/** Turns notifications on or off; turning them on asks the browser's permission. */
export async function setAlertsWanted(on: boolean) {
  try { localStorage.setItem(WANT_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
  if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
}

export function turnAlerts(session: Session) {
  const title = document.title;
  let blink = 0;
  let waitingFor = new Set<string>();
  let note: Notification | null = null;

  const stopBlink = () => {
    clearInterval(blink);
    blink = 0;
    document.title = title;
    note?.close();
    note = null;
  };

  const check = () => {
    const v = session.view();
    const mine = session.localSeats();
    const now = new Set(v && v.phase !== 'gameOver' ? v.pending.filter((p) => mine.includes(p.nation)).map((p) => `${p.nation}:${p.kind}:${v.turn}`) : []);
    const fresh = [...now].filter((k) => !waitingFor.has(k));
    waitingFor = now;
    if (!now.size) { stopBlink(); return; }
    if (!fresh.length) return;
    const nation = fresh[0].split(':')[0];
    const yourTurn = fresh.some((k) => k.includes(':movement:'));
    sound.play(yourTurn ? 'yourTurn' : 'click');
    if (!document.hidden || !alertsWanted()) return;
    const text = yourTurn ? t('alert.yourTurn', { nation }) : t('alert.decide', { nation });
    if (!blink) {
      let on = false;
      blink = window.setInterval(() => { on = !on; document.title = on ? `⚔ ${text}` : title; }, BLINK_MS);
    }
    if ('Notification' in window && Notification.permission === 'granted') {
      note?.close();
      note = new Notification(title, { body: text, tag: 'cabinet-wars-turn' });
      note.onclick = () => { window.focus(); note?.close(); };
    }
  };

  const onVisible = () => { if (!document.hidden) stopBlink(); };
  document.addEventListener('visibilitychange', onVisible);
  const unsub = session.subscribe(check);
  check();
  return () => { unsub(); stopBlink(); document.removeEventListener('visibilitychange', onVisible); };
}
