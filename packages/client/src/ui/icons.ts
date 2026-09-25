/**
 * Language-neutral pictograms (24×24 SVG paths). Theme icon tokens reference them as "icon:<name>";
 * a theme may also give its own path ("path:M…") or a short literal such as "+1".
 */
export const ICONS: Record<string, string> = {
  cavalry: 'M6 21h13v-2.5H6z M7 18c0-3.4 1.6-5.8 4.2-7.3-1.6-.1-2.9-.9-3.3-1.8L5.6 10.5 4.2 8.3 8.4 4.6C9.6 3.5 11 3 12.6 3 16.4 3 19 6.2 19 10.3V18z M10.8 6.1a1 1 0 1 0 .01 0z',
  infantry: 'M11 2.5a2.2 2.2 0 1 1 0 4.4 2.2 2.2 0 0 1 0-4.4z M7.5 8.5h7l1.4 6.5h-2.3l-1 6.5h-3.2l-1-6.5H6.1z M18.2 1.5h1.4v20h-1.4z M17 1.5l1.9-1 1.9 1-1.9 3z',
  artillery: 'M2.5 10.8 17.6 5.3l1.3 3.6-15.1 5.5z M18.4 5.9l2.8-1 .9 2.5-2.8 1z M8.5 12.5a4.2 4.2 0 1 1 0 8.4 4.2 4.2 0 0 1 0-8.4z M8.5 15.1a1.6 1.6 0 1 0 0 3.2 1.6 1.6 0 0 0 0-3.2z M12.2 18h9v2.4h-9z',
  supply: 'M9 3h6l-1.3 3.2C17 7.4 19.5 10.6 19.5 14.6c0 4-3 6.4-7.5 6.4s-7.5-2.4-7.5-6.4c0-4 2.5-7.2 5.8-8.4z M8 12h8v1.6H8z',
  general: 'M12 2.2l2.9 6.2 6.8.8-5 4.6 1.3 6.7L12 17.2l-6 3.3 1.3-6.7-5-4.6 6.8-.8z',
  vp: 'M3 21V10h2.2V7H7.6v3h2.2V6.2h4.4V10h2.2V7h2.4v3H21v11h-6.5v-5.2h-5V21z',
  deckGeneral: 'M8.5 2.5h11v15h-11z M4.5 6.5h2v14h11v2h-13z',
  deckEvent: 'M5 2.5h2v19H5z M7.5 3.5H20l-3.2 4.2L20 12H7.5z',
  battle: 'M3.6 2.4 13 11.8l-1.4 1.4L2.2 3.8V2.4z M20.4 2.4H21.8v1.4L12.4 13.2 11 11.8z M5 15.2l3.8 3.8-1.6 1.6-1.3-1.3L3.4 21.8l-1.2-1.2 2.5-2.5-1.3-1.3z M19 15.2l1.6 1.6-1.3 1.3 2.5 2.5-1.2 1.2-2.5-2.5-1.3 1.3-1.6-1.6z',
  victory: 'M7 2.5h10v5.2a5 5 0 0 1-10 0z M4 3.5h2.2v4.8A3 3 0 0 1 4 5.6z M20 3.5h-2.2v4.8A3 3 0 0 0 20 5.6z M10.8 12.8h2.4v3.4H17v3.3H7v-3.3h3.8z',
  retreat: 'M10.5 4.5 2.8 11l7.7 6.5v-4.1c5.1 0 8.3 1.3 10.7 5.1-.7-6.2-4.1-10.3-10.7-10.9z',
  blockRetreat: 'M12 2 20.5 5.2v6.2c0 5.2-3.6 9.1-8.5 10.6-4.9-1.5-8.5-5.4-8.5-10.6V5.2z M6.4 7.8l1.4-1.4 9.8 9.8-1.4 1.4z',
  moves: 'M3.5 5.2 5.3 3.4 13.9 12l-8.6 8.6-1.8-1.8L10.3 12z M10.5 5.2l1.8-1.8L20.9 12l-8.6 8.6-1.8-1.8L17.3 12z',
  move: 'M2.5 10.7h13.2l-4.8-4.8L12.7 4l8 8-8 8-1.8-1.9 4.8-4.8H2.5z',
  split: 'M11 12.6V21.5h2v-8.9l5.1-5.1v3.2h2.2V3.5h-7.2v2.2h3.2L12 10 7.7 5.7h3.2V3.5H3.7v7.2h2.2V7.5z',
  merge: 'M11 11.4V2.5h2v8.9l5.1 5.1v-3.2h2.2v7.2h-7.2v-2.2h3.2L12 14l-4.3 4.3h3.2v2.2H3.7v-7.2h2.2v3.2z',
  reorganize: 'M7.2 3.2 2.6 7.8l4.6 4.6V9h14V6.6h-14z M16.8 11.6v3.4h-14v2.4h14v3.4l4.6-4.6z',
  // main menu
  ledger: 'M5 2.5h10l4 4v15H5z M8 10h8v1.6H8z M8 13.5h8v1.6H8z M8 17h5v1.6H8z',
  replay: 'M12 6a6 6 0 1 1-6 6H3.6A8.4 8.4 0 1 0 12 3.6z M12 .8v8L7 4.8z',
  network: 'M12 1.8a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z M5 15.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z M19 15.2a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4z M11 8.2h2v4l4.1 2.7-1.1 1.7-4-2.6-4 2.6-1.1-1.7 4.1-2.7z',
  map: 'M2.5 5 8.5 3l7 2 6-2v16l-6 2-7-2-6 2z M9.4 5.3v11.6l5.2 1.6V6.9z',
  settings: 'M3 6h8.2a2.5 2.5 0 0 1 4.6 0H21v2h-5.2a2.5 2.5 0 0 1-4.6 0H3z M3 16h3.2a2.5 2.5 0 0 1 4.6 0H21v2H10.8a2.5 2.5 0 0 1-4.6 0H3z',
  card: 'M6 2.5h12a1.5 1.5 0 0 1 1.5 1.5v16a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 20V4A1.5 1.5 0 0 1 6 2.5z M8 6v5h8V6z',
};

/** SVG path data for a theme icon value, or null when the value is literal text. */
export function iconPath(value: string): string | null {
  if (value.startsWith('icon:')) return ICONS[value.slice(5)] ?? null;
  if (value.startsWith('path:')) return value.slice(5);
  return null;
}

/** An inline icon for the DOM: an SVG for "icon:"/"path:" values, otherwise the text itself. */
export function iconEl(value: string, size = 18, title?: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'icon';
  if (title) { span.title = title; span.setAttribute('aria-label', title); }
  const d = iconPath(value);
  if (d) {
    span.style.width = span.style.height = `${size}px`;
    const safe = d.replace(/[^MmLlHhVvCcSsQqTtAaZz0-9.,\s-]/g, '');
    span.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" d="${safe}"/></svg>`;
  } else {
    span.textContent = value;
    span.classList.add('icon-text');
  }
  return span;
}
