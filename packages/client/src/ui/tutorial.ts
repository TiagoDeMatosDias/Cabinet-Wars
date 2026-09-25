import { t } from '../i18n/i18n';
import { sound } from '../audio/sound';
import { h } from './dom';

/**
 * The guided first game: a series of notes pointing at the parts of the game screen, while the
 * player plays a real game against the computer. Some notes wait for the player to do what they
 * describe (select an army, plan a move, end the turn); the others have a Next button. The
 * player can leave the tutorial at any time and play on.
 */
interface Step {
  /** Text key (tutorial.<id>) and, if any, the element pointed at. */
  id: string;
  target?: string;
  /** The step is done when this becomes true (checked a few times a second); otherwise Next. */
  done?: () => boolean;
}

const $ = (sel: string) => document.querySelector<HTMLElement>(sel);
const count = (sel: string) => document.querySelectorAll(sel).length;

/** Nothing covers the map: the recruit banner, popups and any battle get answered first. */
const clearOfPopups = () => !$('.slot-modal .modal-backdrop') && !$('.recruit-banner') && !$('.battle-dock') && !$('.popup-pill') && Boolean($('.end-turn'));

let turnAtStart = 0;
const turnNow = () => Number(($('.tb-turn .muted.small:last-child')?.textContent ?? '').replace(/\D/g, '')) || 0;

const STEPS: Step[] = [
  { id: 'welcome' },
  { id: 'popups', done: clearOfPopups },
  { id: 'nation', target: '.tb-player' },
  { id: 'willingness', target: '.tb-own' },
  { id: 'nations', target: '.tb-nations' },
  { id: 'map' },
  { id: 'selectArmy', done: () => Boolean($('.army-card')) },
  { id: 'armyCard', target: '.army-card' },
  { id: 'move', done: () => count('.orders-list li') > 0 },
  { id: 'orders', target: '.orders' },
  { id: 'hand', target: '.hand' },
  { id: 'supply' },
  { id: 'battles' },
  { id: 'endTurn', target: '.end-turn', done: () => turnNow() > turnAtStart },
  { id: 'log', target: '.log-tab' },
  { id: 'war', target: '.tb-nations' },
  { id: 'done' },
];

export function startTutorial() {
  let i = 0;
  let poll = 0;
  let ring: HTMLElement | null = null;
  const bubble = h('div', { class: 'coach', role: 'dialog', 'aria-live': 'polite' });
  document.body.append(bubble);

  const stop = () => { clearInterval(poll); ring?.remove(); bubble.remove(); };

  const show = () => {
    clearInterval(poll);
    const step = STEPS[i];
    if (!step) { stop(); return; }
    if (step.id === 'endTurn') turnAtStart = turnNow();
    const last = i === STEPS.length - 1;
    bubble.replaceChildren(
      h('div', { class: 'coach-step muted small' }, t('tutorial.step', { n: i + 1, total: STEPS.length })),
      h('p', {}, t(`tutorial.${step.id}` as Parameters<typeof t>[0])),
      h('div', { class: 'row' },
        step.done ? h('span', { class: 'waiting small' }, t('tutorial.waiting')) : h('button', { class: 'primary', onclick: next }, last ? t('tutorial.finish') : t('tutorial.next')),
        last ? null : h('button', { class: 'link', onclick: stop }, t('tutorial.skip'))));
    const place = () => {
      const target = step.target ? $(step.target) : null;
      ring?.remove();
      ring = null;
      bubble.classList.toggle('centered', !target);
      if (!target) { bubble.style.left = bubble.style.top = ''; return; }
      const r = target.getBoundingClientRect();
      ring = h('div', { class: 'coach-ring' });
      Object.assign(ring.style, { left: `${r.left - 6}px`, top: `${r.top - 6}px`, width: `${r.width + 12}px`, height: `${r.height + 12}px` });
      document.body.append(ring);
      // Beside the target: below it if there is room, otherwise above.
      const bw = bubble.offsetWidth;
      const bh = bubble.offsetHeight;
      const top = r.bottom + 14 + bh < window.innerHeight ? r.bottom + 14 : Math.max(8, r.top - bh - 14);
      bubble.style.left = `${Math.min(Math.max(8, r.left + r.width / 2 - bw / 2), window.innerWidth - bw - 8)}px`;
      bubble.style.top = `${top}px`;
    };
    place();
    // Targets appear and move as the game goes on: follow them, and check whether the step is done.
    poll = window.setInterval(() => {
      if (step.done?.()) { sound.play('click'); next(); return; }
      place();
    }, 300);
  };

  function next() {
    i += 1;
    show();
  }

  // The game screen builds itself asynchronously: start once it is there.
  const wait = window.setInterval(() => { if ($('.topbar')) { clearInterval(wait); show(); } }, 200);
  return stop;
}
