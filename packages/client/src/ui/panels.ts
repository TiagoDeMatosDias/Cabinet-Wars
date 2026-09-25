import { sideOf, UNIT_TYPES, warStatus, type GameView, type WarStatus, type HistoryEntry, type Intent, type UnitType } from '@cabinet-wars/engine';
import { add, h } from './dom';
import { cardEl } from './cards';
import { emblemEl, type Emblem } from './emblem';
import { iconEl } from './icons';
import { nationColor, nationName, nodeName, unitIcon, unitLabel, unitName } from './labels';
import { describe, type ListedOrder, type Plan, type Projection } from '../orders/plan';
import { currentTheme } from '../theme/theme';
import { availableLanguages, language, logText, setPreferredLanguage, t, tn } from '../i18n/i18n';

// ---- top bar -------------------------------------------------------------------

/** How close to collapse: 'danger' within 10 points of the threshold, 'warn' within 25. */
export function collapseLevel(w: WarStatus): 'ko' | 'danger' | 'warn' | 'safe' {
  return w.margin < 0 ? 'ko' : w.margin < 10 ? 'danger' : w.margin < 25 ? 'warn' : 'safe';
}

/** Willingness bar: the part below the knock-out threshold is shaded, with a tick at the threshold. */
function willBar(w: WarStatus, color: string, wide = false): HTMLElement {
  return h('span', { class: `bar ${wide ? 'wide' : ''}` },
    h('span', { class: 'zone', style: `width:${w.threshold}%` }),
    h('span', { class: 'fill', style: `width:${Math.min(100, w.willingness)}%;background:${color}` }),
    h('span', { class: 'mark', style: `left:${w.threshold}%` }));
}

const pct = (x: number) => Math.round(x);

export function topBar(opts: {
  view: GameView; me: string | null; emblems: Map<string, Emblem>; mapName: string; status: string;
  statusLine: string; onSave?: () => void; onLeave: () => void;
  /** The war status panel is open. */
  warOpen: boolean;
  onToggleWar(): void;
}): HTMLElement {
  const { view: v, me, emblems } = opts;
  const ic = currentTheme().icons;
  const acting = me ?? v.current;
  const langs = availableLanguages();
  const own = v.nations.find((n) => n.id === acting);
  const ownStatus = own && !own.knockedOut ? warStatus(v, own.id) : null;
  return h('header', { class: 'topbar' },
    h('div', { class: 'tb-player', style: `--c:${nationColor(v, acting)}` },
      emblemEl(emblems.get(acting), 40, nationName(v, acting)),
      h('div', {}, h('div', { class: 'tb-name' }, nationName(v, acting)), h('div', { class: 'tb-status' }, opts.statusLine),
        // The player's own nation: how far it is from collapse, in plain words.
        ownStatus ? h('button', { class: `tb-own ${collapseLevel(ownStatus)}`, onclick: opts.onToggleWar, 'data-tip': t('tip.willingness') },
          t('top.ownWill', { w: pct(ownStatus.willingness), threshold: ownStatus.threshold }),
          ' · ', h('strong', {}, tn('top.ownMargin', Math.max(0, Math.floor(ownStatus.margin))))) : null)),
    h('div', { class: 'tb-turn' }, h('span', { class: 'muted small' }, opts.mapName), h('strong', {}, t('top.round', { round: v.round })),
      h('span', { class: 'muted small' }, t('top.turnOf', { turn: v.turn }))),
    h('button', { class: `tb-nations ${opts.warOpen ? 'open' : ''}`, onclick: opts.onToggleWar, title: t('war.open'), 'aria-expanded': String(opts.warOpen) }, v.nations.map((n) => {
      const w = warStatus(v, n.id);
      const level = n.knockedOut ? 'ko' : collapseLevel(w);
      return h('span', {
        class: `will ${n.knockedOut ? 'ko' : ''} ${n.id === v.current ? 'current' : ''}`,
        title: t('top.willTitle', {
          name: nationName(v, n.id), side: t(`role.${n.side}`), w: pct(w.willingness), threshold: n.threshold,
          held: w.vpHeld, owned: w.vpOwned, exhaustion: n.warExhaustion,
        }),
      },
      emblemEl(emblems.get(n.id), 24),
      h('span', { class: 'will-name' }, nationName(v, n.id)),
      willBar(w, n.color),
      h('span', { class: `margin-chip ${level}` }, n.knockedOut ? t('war.out') : `${pct(w.willingness)}%`));
    })),
    h('div', { class: 'tb-right' },
      h('span', { class: 'muted deck-counts', title: t('top.decksTitle') },
        iconEl(ic.deck.general, 16), ` ${v.counts.generalDraw}/${v.generalDeck.discard.length}  `,
        iconEl(ic.deck.event, 16), ` ${v.counts.eventDraw}/${v.eventDeck.discard.length}`),
      h('span', { class: 'muted small status', title: opts.status }, opts.status),
      langs.length > 1 ? h('select', {
        title: t('top.language'), 'aria-label': t('top.language'),
        onchange: (e: Event) => setPreferredLanguage((e.target as HTMLSelectElement).value),
      }, langs.map((l) => h('option', { value: l.code, selected: l.code === language() }, l.name))) : null,
      opts.onSave ? h('button', { onclick: opts.onSave }, t('top.save')) : null,
      h('button', { onclick: opts.onLeave }, t('top.leave'))));
}

// ---- war status -----------------------------------------------------------------

/** Every nation's standing: victory points held, war exhaustion, willingness and how far from collapse. */
export function warPanel(v: GameView, me: string | null, emblems: Map<string, Emblem>, onClose: () => void): HTMLElement {
  const mySide = me ? sideOf(v, me) : null;
  const rows = v.nations.map((n) => {
    const w = warStatus(v, n.id);
    const level = n.knockedOut ? 'ko' : collapseLevel(w);
    const lostVp = w.vpOwned - w.vpHeld;
    return h('tr', { class: `${n.id === me ? 'mine' : ''} ${n.knockedOut ? 'ko' : ''}` },
      h('th', { scope: 'row' }, h('span', { class: 'war-nation' }, emblemEl(emblems.get(n.id), 22), nationName(v, n.id),
        n.id === me ? h('span', { class: 'you-tag' }, t('war.you')) : mySide && sideOf(v, n.id) === mySide ? h('span', { class: 'muted small' }, ` ${t('war.ally')}`) : null)),
      h('td', { 'data-label': t('war.vpHeld') }, h('span', {}, h('strong', {}, `${w.vpHeld}`), h('span', { class: 'muted' }, ` / ${w.vpOwned}`),
        lostVp ? h('div', { class: 'small warn' }, t('war.occupied', { vp: lostVp })) : null)),
      h('td', { class: 'num', 'data-label': t('war.exhaustion') }, n.warExhaustion ? h('span', { class: 'warn' }, `−${n.warExhaustion}`) : h('span', { class: 'muted' }, '0')),
      h('td', { 'data-label': t('war.willingness') }, h('div', { class: 'war-will' }, willBar(w, n.color, true), h('strong', {}, `${pct(w.willingness)}%`))),
      h('td', { class: 'num', 'data-label': t('war.collapse') }, `${n.threshold}%`),
      h('td', { 'data-label': t('war.distance') }, h('span', { class: `margin-chip ${level}` },
        n.knockedOut ? t('war.knockedOut') : tn('war.margin', Math.max(0, Math.floor(w.margin))))));
  });
  return h('div', { class: 'war-panel', role: 'dialog', 'aria-label': t('war.title') },
    h('div', { class: 'war-head' }, h('strong', {}, t('war.title')),
      h('button', { class: 'icon-btn', title: t('common.close'), 'aria-label': t('common.close'), onclick: onClose }, '×')),
    h('div', { class: 'war-scroll' }, h('table', { class: 'war-table' },
      h('thead', {}, h('tr', {},
        h('th', {}, t('war.nation')), h('th', {}, t('war.vpHeld')), h('th', {}, t('war.exhaustion')),
        h('th', {}, t('war.willingness')), h('th', {}, t('war.collapse')), h('th', {}, t('war.distance')))),
      h('tbody', {}, rows))),
    h('p', { class: 'muted small war-help' }, t('war.help')));
}

// ---- hand ------------------------------------------------------------------------

export function handPanel(opts: {
  view: GameView; me: string | null; planning: boolean; retreating: boolean; selectedCard: string | null;
  onSelect(cardId: string | null): void;
}): HTMLElement | null {
  const { view: v, me } = opts;
  if (!me) return null;
  const hand = v.hands[me] ?? [];
  const color = nationColor(v, me);
  const inBattle = Boolean(v.battle);
  return h('section', { class: 'hand', 'aria-label': t('hand.aria') },
    h('div', { class: 'hand-cards', style: `--n:${hand.length}` }, hand.map((c, index) => {
      const moves = c.type === 'moves+1';
      const playable = moves ? opts.planning || opts.retreating : inBattle && v.pending.some((p) => p.nation === me && (p.kind === 'battleCards' || p.kind === 'battleChoice'));
      return cardEl(c, {
        color,
        playable,
        hint: moves ? (playable ? t('hand.playableNow') : t('hand.movementCard')) : t('hand.battleCard'),
        when: moves ? t('hand.whenMoves') : t('hand.whenBattle'),
        selected: opts.selectedCard === c.id,
        index: index - (hand.length - 1) / 2 + 2,
        draggable: moves && playable,
        onclick: () => opts.onSelect(opts.selectedCard === c.id || !playable ? null : c.id),
      });
    })),
    h('div', { class: 'hand-label' }, hand.length ? tn('hand.label', hand.length) : t('hand.empty')));
}

// ---- orders ------------------------------------------------------------------------

function kindName(type: string): string {
  return t(`order.${type as 'move' | 'split' | 'merge' | 'transfer' | 'playMoves'}`);
}

function kindIcon(type: string): HTMLElement {
  const icons = currentTheme().icons.order as Record<string, string>;
  return iconEl(icons[type === 'playMoves' ? 'card' : type === 'transfer' ? 'reorganize' : type] ?? 'icon:move', 15);
}

export function ordersPanel(opts: {
  view: GameView; plan: Plan; projection: Projection; planning: boolean; running: boolean; canAdd: boolean;
  onRemove(id: string): void; onDismiss(id: string): void; onMove(from: number, to: number): void; onFocus(node: string): void;
}): HTMLElement {
  const { view: v, plan, projection } = opts;
  const list = h('ol', { class: 'orders-list' });
  const entry = (l: ListedOrder) => h('li', { class: `order ${l.status}` },
    h('span', { class: 'order-disc' }, l.status === 'done' ? '✓' : '✕'),
    h('div', { class: 'order-body' },
      h('div', { class: 'order-kind' }, kindIcon(l.order.intent.type), ` ${kindName(l.order.intent.type)}`),
      h('div', { class: 'order-text' }, l.text),
      l.reason ? h('div', { class: 'order-detail reason' }, l.reason) : l.detail ? h('div', { class: 'order-detail' }, l.detail) : null),
    // Orders that were never executed can always be cleared from the list.
    l.status === 'removed' ? h('button', {
      class: 'icon-btn', title: t('orders.dismiss'), 'aria-label': t('orders.dismiss'),
      onclick: (e: Event) => { e.stopPropagation(); opts.onDismiss(l.order.id); },
    }, '×') : null);
  for (const l of plan.history) add(list, entry(l));
  plan.orders.forEach((o, i) => {
    const r = projection.results[i];
    const d = describe(o, v, projection, i);
    const next = i === 0;
    const li = h('li', {
      class: `order planned ${next ? 'next' : ''} ${r && !r.ok ? 'invalid' : ''} ${opts.running && next ? 'running' : ''}`,
      draggable: opts.running ? undefined : 'true',
      'data-index': String(i),
      onclick: () => { const end = r?.path?.[r.path.length - 1]; if (end) opts.onFocus(end); },
    },
    h('span', { class: 'order-disc' }, next ? (opts.running ? '…' : '▶') : String(i + 1)),
    h('div', { class: 'order-body' },
      h('div', { class: 'order-kind' }, kindIcon(o.intent.type), ` ${kindName(o.intent.type)}`),
      h('div', { class: 'order-text' }, d.text),
      r && !r.ok ? h('div', { class: 'order-detail reason' }, r.error ?? t('orders.notPossible')) : d.detail ? h('div', { class: 'order-detail' }, d.detail) : null),
    opts.running && next ? null : h('button', {
      class: 'icon-btn', title: t('orders.remove'), 'aria-label': t('orders.remove'),
      onclick: (e: Event) => { e.stopPropagation(); opts.onRemove(o.id); },
    }, '×'),
    opts.running ? null : h('span', { class: 'drag-handle', title: t('orders.dragTitle'), 'aria-hidden': 'true' }, '≡'));
    li.addEventListener('dragstart', (e) => { e.dataTransfer?.setData('text/x-order', String(i)); li.classList.add('dragging'); });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('text/x-order')) { e.preventDefault(); li.classList.add('drop-target'); } });
    li.addEventListener('dragleave', () => li.classList.remove('drop-target'));
    li.addEventListener('drop', (e) => {
      e.preventDefault();
      li.classList.remove('drop-target');
      const from = Number(e.dataTransfer?.getData('text/x-order'));
      if (!Number.isNaN(from) && from !== i) opts.onMove(from, i);
    });
    add(list, li);
  });
  const empty = !plan.orders.length && !plan.history.length;
  return h('section', { class: 'orders', 'aria-label': t('orders.title') },
    h('header', {}, h('strong', {}, t('orders.title')), h('span', { class: 'muted small' }, t('orders.subtitle'))),
    empty ? h('p', { class: 'muted small pad' }, opts.planning ? t('orders.emptyPlanning') : t('orders.emptyWaiting')) : list,
    opts.planning && !opts.canAdd && plan.orders.length === 0 && !empty ? h('p', { class: 'muted small pad' }, t('orders.noMore')) : null,
    plan.orders.length > 1 && !opts.running ? h('p', { class: 'muted small pad' }, t('orders.dragHint')) : null);
}

// ---- turn controls --------------------------------------------------------------------

export function turnControls(opts: {
  myTurn: boolean; canStep: boolean; canEnd: boolean; remaining: number; progress: string | null;
  onNext(): void; onEnd(): void;
}): HTMLElement | null {
  if (!opts.myTurn) return null;
  return h('div', { class: 'turn-controls' },
    h('button', { class: 'next-step', disabled: !opts.canStep, onclick: opts.onNext, title: t('controls.nextTitle') }, `${t('controls.next')} ▶`),
    h('button', { class: 'end-turn', disabled: !opts.canEnd, onclick: opts.onEnd, title: t('controls.endTitle') },
      h('span', {}, opts.progress ? t('controls.ending') : t('controls.end')),
      h('small', {}, opts.progress ?? (opts.remaining ? tn('controls.remaining', opts.remaining) : t('controls.noneLeft')))));
}

// ---- log drawer ---------------------------------------------------------------------------

export type LogFilter = 'all' | 'mine' | 'battle' | 'event';

export function logDrawer(opts: {
  view: GameView; me: string | null; emblems: Map<string, Emblem>; open: boolean; filter: LogFilter; unread: number;
  onToggle(): void; onFilter(f: LogFilter): void; onFocus(node: string): void;
}): HTMLElement {
  const { view: v, emblems } = opts;
  if (!opts.open) {
    return h('button', { class: 'log-tab', onclick: opts.onToggle, title: t('logui.open'), 'aria-label': t('logui.open') },
      h('span', {}, t('logui.tab', { count: v.history.length })), opts.unread ? h('span', { class: 'unread-dot' }) : null);
  }
  const keep = (e: HistoryEntry) => opts.filter === 'all'
    || (opts.filter === 'mine' && e.nation === opts.me)
    || (opts.filter === 'battle' && e.kind === 'battle')
    || (opts.filter === 'event' && e.kind === 'event');
  const isBattleStart = (e: HistoryEntry) => e.msg?.key === 'log.battle';
  const line = (e: HistoryEntry) => h('li', {
    class: `log-line ${e.kind ?? ''} ${e.node ? 'locatable' : ''}`,
    title: e.node ? t('logui.showOnMap', { node: e.node }) : undefined,
    onclick: e.node ? () => opts.onFocus(e.node!) : undefined,
  }, e.nation ? emblemEl(emblems.get(e.nation), 16) : null, h('span', {}, logText(e)));
  // Rounds, newest first; within a round, one group per nation turn.
  const rounds = new Map<number, Map<number, HistoryEntry[]>>();
  for (const e of v.history) {
    if (!keep(e) || e.msg?.key === 'log.roundBegins') continue;
    const r = e.round ?? 1;
    if (!rounds.has(r)) rounds.set(r, new Map());
    const turns = rounds.get(r)!;
    turns.set(e.turn, [...(turns.get(e.turn) ?? []), e]);
  }
  const body = [...rounds.keys()].sort((a, b) => b - a).map((round) => h('section', { class: 'log-round' },
    h('h4', { class: 'log-round-title' }, t('logui.roundHeader', { round })),
    [...rounds.get(round)!.entries()].sort(([a], [b]) => b - a).map(([, entries]) => {
      const who = v.history.find((e) => e.turn === entries[0].turn && e.kind === 'turn' && e.nation)?.nation;
      const items: HTMLElement[] = [];
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        if (isBattleStart(e)) {
          const group = [e];
          while (i + 1 < entries.length && entries[i + 1].kind === 'battle' && !isBattleStart(entries[i + 1])) group.push(entries[++i]);
          items.push(h('li', {}, h('details', { class: 'log-battle' }, h('summary', {}, line(e)), h('ul', {}, group.slice(1).map(line)))));
        } else items.push(line(e));
      }
      return h('div', { class: 'log-turn' },
        who ? h('h5', {}, emblemEl(emblems.get(who), 16), t('logui.turnHeader', { nation: who })) : null,
        h('ul', {}, items));
    })));
  return h('aside', { class: 'log-drawer', 'aria-label': t('logui.title') },
    h('header', {}, h('strong', {}, t('logui.title')), h('button', { class: 'icon-btn', onclick: opts.onToggle, title: t('logui.close'), 'aria-label': t('logui.close') }, '×')),
    h('div', { class: 'log-filters' }, (['all', 'mine', 'battle', 'event'] as LogFilter[]).map((f) =>
      h('button', { class: opts.filter === f ? 'active' : '', onclick: () => opts.onFilter(f) },
        t(({ all: 'logui.all', mine: 'logui.mine', battle: 'logui.battles', event: 'logui.events' } as const)[f])))),
    h('div', { class: 'log-body' }, body.length ? body : h('p', { class: 'muted pad' }, t('logui.empty'))));
}

// ---- dialogs for prompts outside battles ----------------------------------------------------

export function promptDialog(v: GameView, me: string | null, emblems: Map<string, Emblem>, send: (i: Intent) => void): HTMLElement | null {
  const p = v.pending.find((x) => x.nation === me);
  if (!p) return null;
  if (p.kind === 'attrition') {
    const a = v.armies[p.army];
    return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal small', style: `--c:${nationColor(v, me!)}` },
      h('h3', {}, emblemEl(emblems.get(me!), 24), ` ${t('attrition.title', { army: p.army })}`),
      h('p', {}, t('attrition.body', { node: a?.node ?? '' })),
      h('div', { class: 'choice-list' }, a?.units.map((u) => h('button', { class: 'choice', onclick: () => send({ type: 'attrition', unit: u.id }) }, unitLabel(u))))));
  }
  if (p.kind === 'sabotage') {
    return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal small' },
      h('h3', {}, t('sabotage.title')),
      h('div', { class: 'choice-list' }, p.options.map((id) => {
        const a = v.armies[id];
        return h('button', { class: 'choice', onclick: () => send({ type: 'sabotage', army: id }) },
          emblemEl(emblems.get(a?.nation ?? ''), 20), ` ${t('sabotage.option', { nation: a?.nation ?? '', army: id, node: a?.node ?? '' })}`);
      }))));
  }
  return null;
}

/** Recruit event: choose a unit type (for units), then a town — on the map or from the list. */
export function recruitBanner(
  v: GameView, me: string | null, emblems: Map<string, Emblem>, unitType: UnitType,
  onType: (t: UnitType) => void, send: (i: Intent) => void,
): HTMLElement | null {
  const p = v.pending.find((x) => x.nation === me && x.kind === 'recruit');
  if (!p || p.kind !== 'recruit') return null;
  const color = nationColor(v, me!);
  const townSelect = h('select', {}, p.options.map((n) => h('option', { value: n }, nodeName(v, n))));
  const recruit = (node: string) => send(p.what === 'general' ? { type: 'recruit', node } : { type: 'recruit', node, unit: unitType });
  return h('div', { class: 'retreat-banner recruit-banner', style: `--c:${color}` },
    emblemEl(emblems.get(me!), 30),
    h('strong', {}, p.what === 'general' ? t('recruit.titleGeneral') : t('recruit.titleUnit', { count: p.remaining })),
    p.what === 'unit' ? h('span', { class: 'row', role: 'radiogroup', 'aria-label': t('recruit.chooseType') },
      UNIT_TYPES.map((ty) => h('button', {
        class: ty === unitType ? 'active' : '', role: 'radio', 'aria-checked': String(ty === unitType),
        onclick: () => onType(ty),
      }, unitIcon(ty, 18), ` ${unitName(ty)}`))) : null,
    h('span', { class: 'muted small' }, t('recruit.clickTown')),
    h('span', { class: 'row' }, `${t('recruit.town')} `, townSelect,
      h('button', { class: 'primary', onclick: () => recruit(townSelect.value) }, t('recruit.place'))));
}

export function gameOverDialog(v: GameView, emblems: Map<string, Emblem>, onMenu: () => void, onReplay?: () => void): HTMLElement | null {
  if (v.phase !== 'gameOver') return null;
  const ffa = v.rules.mode === 'freeForAll';
  const winners = v.nations.filter((n) => sideOf(v, n.id) === v.winner);
  return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal small center' },
    h('div', { class: 'big-icon' }, iconEl(currentTheme().icons.victory, 64)),
    h('h2', {}, ffa ? t('log.winnerNation', { nation: v.winner ?? '' }) : t('log.winner', { side: `side.${v.winner}` })),
    h('div', { class: 'row center' }, winners.map((n) => h('span', { class: 'chip' }, emblemEl(emblems.get(n.id), 22), nationName(v, n.id)))),
    h('div', { class: 'row center' },
      onReplay ? h('button', { onclick: onReplay }, t('gameover.replay')) : null,
      h('button', { class: 'primary', onclick: onMenu }, t('gameover.menu')))));
}

export function handoffDialog(v: GameView, seat: string, emblems: Map<string, Emblem>, onContinue: () => void): HTMLElement {
  const n = v.nations.find((x) => x.id === seat)!;
  return h('div', { class: 'handoff-screen' }, h('div', { class: 'handoff', style: `--c:${n.color}` },
    emblemEl(emblems.get(seat), 72),
    h('h2', {}, t('handoff.title', { nation: seat })),
    h('p', {}, t('handoff.body')),
    h('button', { class: 'primary', onclick: onContinue }, t('common.continue'))));
}

export { nodeName };
