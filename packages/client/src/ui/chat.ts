import { CHAT_MAX_LENGTH, type ChatMsg } from '@cabinet-wars/table';
import type { Session } from '../net/session';
import { sound } from '../audio/sound';
import { nationText, t } from '../i18n/i18n';
import { clear, h } from './dom';
import { emblemEl, type Emblem } from './emblem';

/** How long a new message shows on the closed chat button. */
const PEEK_MS = 6000;

// ---- muting --------------------------------------------------------------------------------

/**
 * Muting is this browser's own business: the muted player is not told, and everyone else still
 * sees their lines. Kept per game, by player id.
 */
const muteKey = (room: string) => `krieg:muted:${room}`;
const muteListeners = new Set<() => void>();

export function mutedIn(room: string | null): Set<string> {
  if (!room) return new Set();
  try { return new Set(JSON.parse(localStorage.getItem(muteKey(room)) ?? '[]') as string[]); } catch { return new Set(); }
}

export function setMuted(room: string | null, player: string, muted: boolean) {
  if (!room) return;
  const set = mutedIn(room);
  if (muted) set.add(player); else set.delete(player);
  try { localStorage.setItem(muteKey(room), JSON.stringify([...set])); } catch { /* storage unavailable */ }
  for (const l of muteListeners) l();
}

export function onMuteChange(cb: () => void) {
  muteListeners.add(cb);
  return () => { muteListeners.delete(cb); };
}

/** A Mute / Unmute button for another player. */
export function muteButton(session: Session, player: string, name: string) {
  const muted = mutedIn(session.room).has(player);
  return h('button', {
    class: `small-button ${muted ? 'active' : ''}`,
    title: t(muted ? 'chat.unmuteTitle' : 'chat.muteTitle', { name }),
    'aria-pressed': String(muted),
    onclick: () => setMuted(session.room, player, !muted),
  }, t(muted ? 'chat.unmute' : 'chat.mute'));
}

function timeText(at: number) {
  return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * The room's chat: messages and a line to write in. The element stays mounted across the
 * screen's re-renders, so what the player is typing survives them. Call `destroy` when leaving.
 */
export function chatBox(session: Session, emblems: () => Map<string, Emblem>) {
  const list = h('ol', { class: 'chat-lines', 'aria-live': 'polite' });
  const input = h('input', { class: 'chat-input', maxlength: CHAT_MAX_LENGTH, placeholder: t('chat.placeholder'), 'aria-label': t('chat.placeholder') });
  const button = h('button', { type: 'submit', class: 'primary' }, t('chat.send'));
  const form = h('form', {
    class: 'chat-form',
    onsubmit: (e: Event) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text || !connected()) return;
      session.sendChat(text);
      input.value = '';
    },
  }, input, button);
  const el = h('div', { class: 'chat' }, list, form);
  // Keys typed in the chat are not game shortcuts.
  input.addEventListener('keydown', (e) => { if (e.key !== 'Escape') e.stopPropagation(); });

  const connected = () => session.link === 'connected';
  let shown: ChatMsg[] = [];
  let muted = mutedIn(session.room);
  /** The lines to show: everything but what muted players wrote. */
  const visible = () => session.chat().filter((m) => !m.by || !muted.has(m.by));

  const line = (m: ChatMsg) => {
    if (m.key) return h('li', { class: 'chat-line notice', title: timeText(m.at) }, t(m.key as Parameters<typeof t>[0], m.params ?? {}));
    const nations = m.nations ?? [];
    return h('li', { class: 'chat-line', title: timeText(m.at) },
      nations.length ? h('span', { class: 'chat-emblems' }, nations.map((n) => emblemEl(emblems().get(n), 16, nationText(n)))) : null,
      h('strong', { class: 'chat-from' }, `${m.from ?? '?'}: `),
      h('span', { class: 'chat-text' }, m.text ?? ''));
  };

  const update = () => {
    const msgs = visible();
    const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
    // Append what is new; rebuild when the history was replaced (after reconnecting).
    const same = shown.length <= msgs.length && shown.every((m, i) => msgs[i]?.id === m.id);
    const fresh = same ? msgs.slice(shown.length) : msgs;
    // An empty history shows a placeholder line instead.
    if (!same || !shown.length) list.replaceChildren();
    if (msgs.length) list.append(...fresh.map(line));
    else list.append(h('li', { class: 'chat-line notice' }, t('chat.empty')));
    const lastId = shown.at(-1)?.id ?? 0;
    shown = msgs;
    if (atBottom || !same) list.scrollTop = list.scrollHeight;
    const ok = connected();
    input.disabled = button.disabled = !ok;
    input.placeholder = ok ? t('chat.placeholder') : t('chat.offline');
    // Only lines not seen before count as new (a replaced history repeats the old ones).
    return fresh.filter((m) => m.id > lastId);
  };

  const listeners = new Set<(fresh: ChatMsg[]) => void>();
  const unsub = session.subscribe(() => {
    const fresh = update();
    if (fresh.some((m) => m.text !== undefined && m.by !== session.you())) sound.play('chat');
    for (const l of listeners) l(fresh);
  });
  const unsubMute = onMuteChange(() => { muted = mutedIn(session.room); shown = []; update(); });
  update();
  return {
    el,
    input,
    /** Scrolls to the newest line (after the box becomes visible). */
    reveal() { list.scrollTop = list.scrollHeight; },
    onNew(cb: (fresh: ChatMsg[]) => void) { listeners.add(cb); },
    destroy() { unsub(); unsubMute(); },
  };
}

/** The chat during a game: a button in a corner of the map that opens it, and shows new lines. */
export function chatDock(session: Session, emblems: () => Map<string, Emblem>) {
  const box = chatBox(session, emblems);
  let open = false;
  let unread = 0;
  let peekTimer = 0;
  const badge = h('span', { class: 'chat-unread' });
  const peek = h('div', { class: 'chat-peek', onclick: () => setOpen(true) });
  const toggle = h('button', { class: 'chat-toggle', onclick: () => setOpen(!open), 'aria-expanded': 'false' },
    h('span', {}, t('chat.title')), badge);
  // Who is here, with a Mute button for each (shown on demand, above the lines).
  let peopleOpen = false;
  const people = h('ul', { class: 'chat-people' });
  const paintPeople = () => {
    people.hidden = !peopleOpen;
    if (!peopleOpen) return;
    const others = session.players().filter((p) => !p.you);
    clear(people, others.length
      ? others.map((p) => h('li', { class: p.online ? '' : 'offline' },
        h('span', { class: `presence ${p.online ? 'on' : ''}`, 'aria-hidden': 'true' }), h('span', {}, p.name), muteButton(session, p.id, p.name)))
      : h('li', { class: 'muted small' }, t('chat.nobodyElse')));
  };
  const peopleButton = h('button', { class: 'small-button', 'aria-expanded': 'false', title: t('chat.peopleTitle'), onclick: () => {
    peopleOpen = !peopleOpen;
    peopleButton.setAttribute('aria-expanded', String(peopleOpen));
    paintPeople();
  } }, t('chat.people'));
  const unsubPeople = session.subscribe(paintPeople);
  const unsubMutePeople = onMuteChange(paintPeople);
  paintPeople();
  const panel = h('div', { class: 'chat-panel' },
    h('header', {}, h('strong', {}, t('chat.title')),
      h('span', { class: 'row' }, peopleButton, h('button', { class: 'link', onclick: () => setOpen(false), title: t('chat.close') }, '×'))),
    people, box.el);
  const el = h('div', { class: 'chat-dock' }, toggle, peek, panel);

  const paint = () => {
    el.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.title = open ? t('chat.close') : t('chat.open');
    badge.textContent = unread ? String(unread) : '';
  };
  function setOpen(v: boolean) {
    open = v;
    if (open) {
      unread = 0;
      peek.classList.remove('show');
      box.reveal();
      box.input.focus();
    }
    paint();
  }
  box.onNew((fresh) => {
    if (open || !fresh.length) return;
    unread += fresh.filter((m) => m.text !== undefined).length;
    const last = fresh.at(-1)!;
    peek.textContent = last.key ? t(last.key as Parameters<typeof t>[0], last.params ?? {}) : `${last.from}: ${last.text}`;
    peek.classList.add('show');
    clearTimeout(peekTimer);
    peekTimer = window.setTimeout(() => peek.classList.remove('show'), PEEK_MS);
    paint();
  });
  // Enter opens the chat, Escape (in it) closes it.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !open && !(e.target as HTMLElement).closest?.('input, textarea, select, button')) { setOpen(true); e.preventDefault(); }
    else if (e.key === 'Escape' && open && e.target === box.input) { setOpen(false); box.input.blur(); e.stopPropagation(); }
  };
  window.addEventListener('keydown', onKey, true);
  paint();
  return {
    el,
    destroy() { box.destroy(); unsubPeople(); unsubMutePeople(); clearTimeout(peekTimer); window.removeEventListener('keydown', onKey, true); },
  };
}

/**
 * A strip across the top of the page while a joined game is not connected: reconnecting, or
 * over for good (with a way back to the menu).
 */
export function connectionBanner(session: Session, onMenu: () => void) {
  const el = h('div', { class: 'net-banner', role: 'status' });
  const paint = () => {
    const link = session.link;
    if (link === 'connected' || link === 'left') { el.replaceChildren(); el.classList.remove('show'); return; }
    el.className = `net-banner show ${link === 'reconnecting' ? '' : 'final'}`;
    clear(el, h('span', {}, session.status()), link !== 'reconnecting' && h('button', { onclick: onMenu }, t('menu.back')));
  };
  const unsub = session.subscribe(paint);
  paint();
  document.body.append(el);
  return () => { unsub(); el.remove(); };
}
