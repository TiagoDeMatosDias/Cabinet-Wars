import type { Session } from '../net/session';
import { nationText, t } from '../i18n/i18n';
import { h, toast } from './dom';
import { emblemEl, type Emblem } from './emblem';

/** From this much time left, the clock turns to a warning. */
const WARN_MS = 60_000;

function mmss(ms: number) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * The idle clock of an online game: how long the player (or whoever the game waits for) has
 * left to act before their turn is ended for them. Hidden when nobody's clock is running.
 */
export function turnClock(session: Session, emblems: () => Map<string, Emblem>) {
  const el = h('div', { class: 'turn-clock', role: 'timer', title: t('clock.title') });
  const warned = new Set<string>();
  const tick = () => {
    const deadlines = session.deadlines();
    const mine = session.localSeats();
    const entries = Object.entries(deadlines).sort(([a, x], [b, y]) => Number(mine.includes(b)) - Number(mine.includes(a)) || x - y);
    if (!entries.length) { el.replaceChildren(); el.className = 'turn-clock'; return; }
    const [nation, at] = entries[0];
    const left = at - Date.now();
    const own = mine.includes(nation);
    el.className = `turn-clock show ${left < WARN_MS ? 'warning' : ''}`;
    el.replaceChildren(emblemEl(emblems().get(nation), 20),
      h('span', {}, own ? t('clock.yours', { time: mmss(left) }) : t('clock.other', { nation, time: mmss(left) })));
    // One warning per prompt the player has to answer.
    const key = `${nation}:${at}`;
    if (own && left < WARN_MS && !warned.has(key)) { warned.add(key); toast(t('clock.warning'), 'error'); }
  };
  const timer = setInterval(tick, 500);
  const unsub = session.subscribe(tick);
  tick();
  return { el, destroy() { clearInterval(timer); unsub(); } };
}
