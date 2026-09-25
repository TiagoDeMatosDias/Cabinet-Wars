/**
 * Tooltips: any element with a `data-tip` (or `title`) attribute explains itself when the pointer rests on it
 * (or it has keyboard focus). Richer than the browser's `title`: styled like the game, shown
 * quickly, and kept inside the window. A tip may use line breaks ("\n").
 */
const SHOW_DELAY_MS = 350;
const GAP = 8;

let tipEl: HTMLDivElement | null = null;
let target: HTMLElement | null = null;
let timer = 0;

function el(): HTMLDivElement {
  if (!tipEl) {
    tipEl = document.createElement('div');
    tipEl.className = 'tooltip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.id = 'cw-tooltip';
    document.body.append(tipEl);
  }
  return tipEl;
}

function place(anchor: HTMLElement) {
  const tip = el();
  const r = anchor.getBoundingClientRect();
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  // Below the element, or above it when there is no room; always inside the window.
  let top = r.bottom + GAP;
  if (top + hgt > window.innerHeight - 4) top = Math.max(4, r.top - hgt - GAP);
  const left = Math.min(Math.max(4, r.left + r.width / 2 - w / 2), window.innerWidth - w - 4);
  tip.style.left = `${left}px`;
  tip.style.top = `${top}px`;
}

function show(anchor: HTMLElement) {
  const text = anchor.dataset.tip;
  if (!text) return;
  const tip = el();
  tip.textContent = text;
  tip.classList.add('show');
  anchor.setAttribute('aria-describedby', tip.id);
  place(anchor);
}

function hide() {
  clearTimeout(timer);
  target?.removeAttribute('aria-describedby');
  target = null;
  tipEl?.classList.remove('show');
}

function enter(e: Event) {
  const anchor = (e.target as Element | null)?.closest?.<HTMLElement>('[data-tip], [title]');
  // Plain titles become tips too (and the browser's own tooltip is not shown on top).
  if (anchor?.title && !(anchor instanceof SVGElement)) { anchor.dataset.tip = anchor.title; anchor.removeAttribute('title'); }
  if (anchor === target) return;
  hide();
  if (!anchor) return;
  target = anchor;
  timer = window.setTimeout(() => { if (target === anchor && anchor.isConnected) show(anchor); }, e.type === 'focusin' ? 0 : SHOW_DELAY_MS);
}

export function installTooltips() {
  document.addEventListener('mouseover', enter);
  document.addEventListener('focusin', enter);
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
}
