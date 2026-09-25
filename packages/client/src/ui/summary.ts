import type { GameView, HistoryEntry, NationId } from '@cabinet-wars/engine';
import { logText, t } from '../i18n/i18n';
import { h } from './dom';
import { emblemEl, type Emblem } from './emblem';
import { nationColor, nationName } from './labels';

/**
 * "Since your last turn": when a player's turn begins, what they could see happen since their
 * previous one (the other nations' moves, battles, events), turn by turn. Entries naming a town
 * show it on the map when clicked. Players can turn it off under Settings.
 */
const WANT_KEY = 'krieg:summary';

export function wantsSummary(): boolean {
  try { return localStorage.getItem(WANT_KEY) !== 'off'; } catch { return true; }
}

export function setWantsSummary(on: boolean) {
  try { localStorage.setItem(WANT_KEY, on ? 'on' : 'off'); } catch { /* storage unavailable */ }
}

/** Remembers, per game and nation, the last turn a summary was shown for (so a reload doesn't repeat it). */
const shownKey = (game: string, seat: NationId) => `krieg:summary:${game}:${seat}`;

export const summaryShown = {
  get(game: string, seat: NationId): number {
    try { return Number(sessionStorage.getItem(shownKey(game, seat)) ?? 0); } catch { return 0; }
  },
  set(game: string, seat: NationId, turn: number) {
    try { sessionStorage.setItem(shownKey(game, seat), String(turn)); } catch { /* storage unavailable */ }
  },
};

/** Headers and the blow-by-blow of battles: the summary tells what happened, not every roll. */
const SKIP = new Set(['log.turnBegins', 'log.roundBegins', 'log.dice', 'log.round', 'log.roundResult']);

/** Not worth reporting: the skipped kinds above, and the player's own orders. */
function worthTelling(e: HistoryEntry, seat: NationId): boolean {
  if (e.msg && SKIP.has(e.msg.key)) return false;
  return !(e.nation === seat && (e.kind === 'order' || e.kind === 'card'));
}

/** What happened between the seat's previous turn and the current one. */
export function summaryEntries(v: GameView, seat: NationId): HistoryEntry[] {
  const starts = v.history.filter((e) => e.msg?.key === 'log.turnBegins' && e.msg.params.nation === seat && e.turn < v.turn);
  const since = starts.at(-1)?.turn ?? 0;
  return v.history.filter((e) => e.turn > since && e.turn < v.turn && worthTelling(e, seat));
}

export function turnSummary(v: GameView, entries: HistoryEntry[], emblems: Map<string, Emblem>, opts: { onFocus(node: string): void; onClose(): void }) {
  // One group per nation turn, in the order they were played.
  const turns = new Map<number, HistoryEntry[]>();
  for (const e of entries) turns.set(e.turn, [...(turns.get(e.turn) ?? []), e]);
  const whose = (turn: number) => v.history.find((e) => e.turn === turn && e.msg?.key === 'log.turnBegins')?.msg?.params.nation as string | undefined;
  return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal wide summary', role: 'dialog', 'aria-label': t('summary.title') },
    h('h2', {}, t('summary.title')),
    h('p', { class: 'muted small' }, t('summary.hint')),
    h('div', { class: 'summary-body' }, [...turns].map(([turn, list]) => {
      const n = whose(turn);
      return h('section', { class: 'summary-turn', style: n ? `--c:${nationColor(v, n)}` : '' },
        h('h3', {}, n ? emblemEl(emblems.get(n), 20) : null, n ? t('summary.turnOf', { nation: n }) : t('summary.turn', { turn })),
        h('ul', {}, list.map((e) => h('li', {
          class: `log-line ${e.kind ?? ''} ${e.node ? 'locatable' : ''}`,
          'data-tip': e.node ? t('logui.showOnMap', { node: e.node }) : undefined,
          onclick: e.node ? () => opts.onFocus(e.node!) : undefined,
        }, e.nation ? emblemEl(emblems.get(e.nation), 16, nationName(v, e.nation)) : null, h('span', {}, logText(e))))));
    })),
    h('div', { class: 'row center' }, h('button', { class: 'primary', onclick: opts.onClose, autofocus: true }, t('summary.close')))));
}
