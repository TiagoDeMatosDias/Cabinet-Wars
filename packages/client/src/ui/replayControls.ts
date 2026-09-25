import type { GameView } from '@krieg/engine';
import type { ReplaySession } from '../net/replay';
import { h } from './dom';
import { emblemEl, type Emblem } from './emblem';
import { nationName } from './labels';
import { t } from '../i18n/i18n';

/** Seconds between steps while playing. */
export const REPLAY_SPEEDS = [2, 1, 0.5, 0.25];

/**
 * The replay bar (a strip along the bottom, in place of the turn controls): jump to the start or end, go a
 * turn or a step back or forward, play and pause, drag through the game, and pick whose view to
 * watch.
 */
export function replayControls(opts: {
  view: GameView;
  replay: ReplaySession;
  emblems: Map<string, Emblem>;
  playing: boolean;
  speed: number;
  onPlay(): void;
  onSpeed(s: number): void;
}): HTMLElement {
  const { view: v, replay: r, emblems } = opts;
  const pos = r.position();
  const len = r.length();
  const mark = r.marks[pos];
  const stepIndex = r.steps.filter((k) => k <= pos).length;
  const turnIndex = r.turns.filter((k) => k <= pos).length;
  const atStart = pos === 0;
  const atEnd = pos === len;
  const btn = (label: string, title: string, onclick: () => void, disabled: boolean, cls = '') =>
    h('button', { class: `rp-btn ${cls}`, title, 'aria-label': title, disabled, onclick }, label);
  return h('section', { class: 'replay-bar', 'aria-label': t('replay.title') },
    h('div', { class: 'rp-head' },
      h('strong', {}, t('replay.title')),
      h('span', { class: 'rp-where' },
        emblemEl(emblems.get(mark.current), 18),
        t('replay.where', { round: mark.round, turn: mark.turn, nation: nationName(v, mark.current) })),
      h('span', { class: 'muted small' }, t('replay.stepOf', { step: stepIndex, steps: r.steps.length, turn: turnIndex, turns: r.turns.length }))),
    h('div', { class: 'rp-buttons' },
      btn('⏮', t('replay.start'), () => r.seek(0), atStart),
      btn('⏪', t('replay.prevTurn'), () => r.turnBy(-1), atStart),
      btn('‹', t('replay.prevStep'), () => r.stepBy(-1), atStart),
      btn(opts.playing ? '⏸' : '▶', opts.playing ? t('replay.pause') : t('replay.play'), opts.onPlay, atEnd && !opts.playing, 'primary'),
      btn('›', t('replay.nextStep'), () => r.stepBy(1), atEnd),
      btn('⏩', t('replay.nextTurn'), () => r.turnBy(1), atEnd),
      btn('⏭', t('replay.end'), () => r.seek(len), atEnd)),
    h('input', {
      class: 'rp-slider', type: 'range', min: 0, max: len, value: pos, 'aria-label': t('replay.slider'), title: t('replay.keys'),
      oninput: (e: Event) => r.seek(Number((e.target as HTMLInputElement).value)),
    }),
    h('div', { class: 'rp-options' },
      h('label', {}, `${t('replay.speed')} `, h('select', { onchange: (e: Event) => opts.onSpeed(Number((e.target as HTMLSelectElement).value)) },
        REPLAY_SPEEDS.map((s) => h('option', { value: s, selected: s === opts.speed }, t('replay.perStep', { s }))))),
      h('label', {}, `${t('replay.viewAs')} `, h('select', {
        onchange: (e: Event) => { const val = (e.target as HTMLSelectElement).value; r.setPerspective(val || null); },
      },
      h('option', { value: '', selected: r.perspective === null }, t('replay.everyone')),
      v.nations.map((n) => h('option', { value: n.id, selected: r.perspective === n.id }, nationName(v, n.id)))))));
}
