import {
  armySpeed, canMoveWithoutGeneral, GENERAL_SPEED, isFriendlyNode, MAJOR_ROAD_MULTIPLIER, isSupplied, UNIT_SPEED, UNIT_TYPES,
  type Army, type GameState, type GameView, type Unit, type UnitType,
} from '@cabinet-wars/engine';
import { add, clear, h } from './dom';
import { emblemEl, type Emblem } from './emblem';
import { nationColor, nationName, nodeName, unitIcon, unitName } from './labels';
import { currentTheme } from '../theme/theme';
import { iconEl } from './icons';
import { generalText, t } from '../i18n/i18n';

export interface ArmyCardActions {
  split(army: Army): void;
  reorganize(node: string): void;
  merge(ids: string[]): void;
  playMoves(army: Army): void;
  close(): void;
}

function movesLeft(a: Army): { any: number; major: number; speed: number } {
  const speed = armySpeed(a);
  if (a.moved.stopped) return { any: 0, major: 0, speed };
  const any = Math.max(0, speed - a.moved.edges);
  const major = a.moved.allMajor ? Math.max(0, speed * MAJOR_ROAD_MULTIPLIER - a.moved.edges) : any;
  return { any, major, speed };
}

/** The army card (bottom left): units with movement pips, movement summary and actions. */
export function armyCard(opts: {
  view: GameView;
  state: GameState;
  selected: string[];
  me: string | null;
  planning: boolean;
  planned: boolean;
  emblems: Map<string, Emblem>;
  /** Some of the highlighted destinations would leave the selected armies out of supply. */
  noSupplyDestinations?: boolean;
  actions: ArmyCardActions;
}): HTMLElement | null {
  const { state, view, selected, me, emblems, actions } = opts;
  const armies = selected.map((id) => state.armies[id]).filter(Boolean);
  if (!armies.length) return null;
  const a = armies[0];
  const mine = a.nation === me;
  const color = nationColor(view, a.nation);
  const card = h('section', { class: 'army-card', style: `--c:${color}`, 'aria-label': t('army.title', { army: a.id }) });
  const generals = a.generals.map((g) => generalText(g, state.generals[g]?.name));
  add(card,
    h('header', {},
      emblemEl(emblems.get(a.nation), 36, nationName(view, a.nation)),
      h('div', { class: 'army-title' },
        h('strong', {}, t('army.title', { army: a.id })),
        h('div', { class: 'muted' },
          generals.length ? h('span', {}, iconEl(currentTheme().icons.general, 14), ` ${generals.join(', ')}`) : t('army.noGeneral'),
          ` · ${t('army.at', { node: a.node })}`,
          mine && isSupplied(state, a.id) ? h('span', { class: 'ok', 'data-tip': t('tip.supply') }, ` · ${t('army.inSupply')}`) : null)),
      h('button', { class: 'icon-btn', title: t('common.close'), 'aria-label': t('common.close'), onclick: actions.close }, '×')));
  if (opts.planned && mine) add(card, h('div', { class: 'planned-note' }, t('army.planned')));
  // Supply, spelled out: the map marks the same with a "!" badge.
  const cutOff = mine ? armies.filter((x) => !isSupplied(state, x.id)) : [];
  if (cutOff.length) {
    add(card, h('div', { class: 'supply-alert', role: 'alert' },
      h('span', { class: 'supply-badge', 'aria-hidden': 'true' }, '!'),
      h('div', {}, h('strong', {}, t(armies.length > 1 ? 'army.outOfSupplySome' : 'army.outOfSupplyTitle', { count: cutOff.length })),
        h('div', { class: 'small' }, t('army.outOfSupplyBody')))));
  }
  if (mine && opts.planning && opts.noSupplyDestinations) {
    add(card, h('div', { class: 'supply-legend small' }, h('span', { class: 'supply-badge', 'aria-hidden': 'true' }, '!'), t('army.noSupplyLegend')));
  }

  // One row per unit type: icon, count and movement pips (● available, ○ used).
  const byType = new Map<UnitType, Unit[]>();
  for (const u of a.units) byType.set(u.type, [...(byType.get(u.type) ?? []), u]);
  const rows = h('div', { class: 'unit-rows' });
  for (const type of UNIT_TYPES) {
    const units = byType.get(type);
    if (!units) continue;
    const speed = UNIT_SPEED[type] + a.moved.bonus;
    const left = a.moved.stopped ? 0 : Math.max(0, speed - a.moved.edges);
    add(rows, h('div', { class: 'unit-line' },
      h('span', { class: 'unit-token', style: `--c:${color}` }, unitIcon(type, 18)),
      h('span', { class: 'unit-name', 'data-tip': t(`tip.unit.${type}` as Parameters<typeof t>[0]) }, unitName(type)),
      h('span', { class: 'unit-count' }, `×${units.length}`),
      mine ? h('span', { class: 'pips', title: t('army.pipsTitle', { left, speed }) }, Array.from({ length: speed }, (_, i) => h('span', { class: `pip ${i < left ? 'on' : ''}` }))) : null,
      mine ? h('span', { class: 'muted small' }, t('army.pips', { left, speed })) : null));
  }
  if (a.generals.length) {
    // Generals are non-combat members; they ride at cavalry speed.
    const speed = GENERAL_SPEED + a.moved.bonus;
    const left = a.moved.stopped ? 0 : Math.max(0, speed - a.moved.edges);
    add(rows, h('div', { class: 'unit-line' },
      h('span', { class: 'unit-token', style: `--c:${color}` }, iconEl(currentTheme().icons.general, 18)),
      h('span', { class: 'unit-name', 'data-tip': t('tip.unit.general') }, t('unit.general')),
      h('span', { class: 'unit-count' }, `×${a.generals.length}`),
      mine ? h('span', { class: 'pips', title: t('army.pipsTitle', { left, speed }) }, Array.from({ length: speed }, (_, i) => h('span', { class: `pip ${i < left ? 'on' : ''}` }))) : null,
      mine ? h('span', { class: 'muted small' }, t('army.pips', { left, speed })) : null));
  }
  add(card, rows);
  if (mine && !a.generals.length && !canMoveWithoutGeneral(a) && !isFriendlyNode(state, a)) add(card, h('div', { class: 'warn small' }, t('army.noGeneralEnemy')));

  if (mine) {
    const m = movesLeft(a);
    const slowest = a.units.length ? a.units.reduce((s, u) => (UNIT_SPEED[u.type] < UNIT_SPEED[s.type] ? u : s), a.units[0]) : null;
    const fasterIfSplit = slowest ? a.units.filter((u) => u.type !== slowest.type) : [];
    const gain = slowest && fasterIfSplit.length ? Math.min(...fasterIfSplit.map((u) => UNIT_SPEED[u.type]), a.generals.length ? GENERAL_SPEED : 99) - UNIT_SPEED[slowest.type] : 0;
    add(card, h('div', { class: 'move-summary', 'data-tip': t('tip.moves') },
      h('strong', {}, a.moved.stopped ? t('army.stopped') : t('army.moves', { n: m.any })),
      !a.moved.stopped && m.major !== m.any ? h('span', { class: 'muted' }, ` ${t('army.majorOnly', { n: m.major })}`) : null,
      h('span', { class: 'muted' }, ` · ${t('army.slowest', { unit: slowest ? unitName(slowest.type).toLowerCase() : t('unit.general').toLowerCase() })}`)),
    slowest && gain > 0 && !a.moved.stopped && opts.planning
      ? h('div', { class: 'hint' }, t('army.splitHint', { unit: unitName(slowest.type).toLowerCase(), n: gain }))
      : null);
  }

  if (armies.length > 1) {
    add(card, h('div', { class: 'also-selected' },
      h('div', { class: 'muted small' }, t('army.selected', { count: armies.length })),
      armies.slice(1).map((o) => h('div', { class: 'small' }, t('army.otherLine', { army: o.id, count: o.units.length, node: o.node })))));
  }

  if (mine && opts.planning) {
    const others = Object.values(state.armies).filter((o) => o.id !== a.id && o.node === a.node && o.nation === a.nation);
    const sameNode = armies.length > 1 && armies.every((o) => o.node === a.node && o.nation === a.nation);
    const cards = state.hands[me!]?.filter((c) => c.type === 'moves+1') ?? [];
    add(card, h('div', { class: 'card-actions' },
      h('button', { disabled: a.units.length + a.generals.length < 2, title: t('army.splitTitle'), onclick: () => actions.split(a) }, t('army.split')),
      h('button', { disabled: !others.length, title: others.length ? t('army.reorgTitle') : t('army.reorgNeeds'), onclick: () => actions.reorganize(a.node) }, t('army.reorganize')),
      sameNode ? h('button', { class: 'primary', onclick: () => actions.merge(armies.map((o) => o.id)) }, t('army.merge', { count: armies.length })) : null,
      cards.length && !a.moved.stopped ? h('button', { title: t('army.movesCardTitle'), onclick: () => actions.playMoves(a) }, t('army.movesCard', { count: cards.length })) : null));
  }
  return card;
}

// ---- editors ------------------------------------------------------------------

function counts(units: Unit[]): Record<UnitType, Unit[]> {
  const out = { cavalry: [], infantry: [], artillery: [], supply: [] } as Record<UnitType, Unit[]>;
  for (const u of units) out[u.type].push(u);
  return out;
}

/** Split: move units and generals from "Stays" to "Leaves". */
export function splitEditor(opts: {
  view: GameView; army: Army; state: GameState; color: string;
  onConfirm(units: string[], generals: string[]): void; onCancel(): void;
}): HTMLElement {
  const { army, state } = opts;
  const pool = counts(army.units);
  const leave: Record<UnitType, number> = { cavalry: 0, infantry: 0, artillery: 0, supply: 0 };
  const leaveGenerals = new Set<string>();
  const body = h('div', { class: 'editor-body' });
  const error = h('div', { class: 'warn small' });
  const confirmBtn = h('button', { class: 'primary' }, t('split.confirm'));

  const validate = (): string | null => {
    // Generals are members like any other: an army may be units only, generals only, or both.
    const leaving = UNIT_TYPES.reduce((n, ty) => n + leave[ty], 0) + leaveGenerals.size;
    if (!leaving) return t('split.errNone');
    if (leaving === army.units.length + army.generals.length) return t('split.errAll');
    return null;
  };
  const draw = () => {
    clear(body, 
      h('div', { class: 'split-grid' },
        h('div', { class: 'split-head' }, ''), h('div', { class: 'split-head' }, t('split.stays')), h('div', { class: 'split-head' }, ''), h('div', { class: 'split-head' }, t('split.leaves')),
        UNIT_TYPES.filter((ty) => pool[ty].length).flatMap((ty) => [
          h('div', {}, h('span', { class: 'unit-token', style: `--c:${opts.color}` }, unitIcon(ty, 18)), ` ${unitName(ty)}`),
          h('div', { class: 'split-num' }, String(pool[ty].length - leave[ty])),
          h('div', { class: 'split-arrows' },
            h('button', { 'aria-label': t('split.keepOne', { unit: unitName(ty).toLowerCase() }), disabled: leave[ty] === 0, onclick: () => { leave[ty]--; draw(); } }, '◀'),
            h('button', { 'aria-label': t('split.sendOne', { unit: unitName(ty).toLowerCase() }), disabled: leave[ty] === pool[ty].length, onclick: () => { leave[ty]++; draw(); } }, '▶')),
          h('div', { class: 'split-num' }, String(leave[ty])),
        ])),
      army.generals.length ? h('div', { class: 'split-generals' }, h('div', { class: 'muted small' }, t('split.generals')),
        army.generals.map((g) => h('label', {}, h('input', {
          type: 'checkbox', checked: leaveGenerals.has(g),
          onchange: (e: Event) => { if ((e.target as HTMLInputElement).checked) leaveGenerals.add(g); else leaveGenerals.delete(g); draw(); },
        }), ` ${generalText(g, state.generals[g]?.name)}`))) : null,
      error);
    const problem = validate();
    error.textContent = problem ?? '';
    confirmBtn.disabled = Boolean(problem);
  };
  confirmBtn.addEventListener('click', () => {
    if (validate()) return;
    opts.onConfirm(UNIT_TYPES.flatMap((t) => pool[t].slice(0, leave[t]).map((u) => u.id)), [...leaveGenerals]);
  });
  draw();
  return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal editor', style: `--c:${opts.color}` },
    h('h3', {}, t('split.title', { army: army.id })),
    body,
    h('div', { class: 'row end' }, h('button', { onclick: opts.onCancel }, t('common.cancel')), confirmBtn)));
}

/** Reorganize: redistribute units and generals between all your armies on a node (plus a new one). */
export function reorganizeEditor(opts: {
  view: GameView; armies: Army[]; state: GameState; color: string;
  onConfirm(groups: { army: string | null; units: string[]; generals: string[] }[]): void; onCancel(): void;
}): HTMLElement {
  const { armies, state } = opts;
  const cols = [...armies.map((a) => ({ id: a.id as string | null, label: a.id })), { id: null, label: t('reorg.newArmy') }];
  // Current placement: type counts per column, and a column per general.
  const pools = counts(armies.flatMap((a) => a.units));
  const typeOf = new Map(armies.flatMap((a) => a.units.map((u) => [u.id, u.type] as const)));
  const perCol = cols.map((c) => {
    const a = armies.find((x) => x.id === c.id);
    const cnt = { cavalry: 0, infantry: 0, artillery: 0, supply: 0 } as Record<UnitType, number>;
    for (const u of a?.units ?? []) cnt[u.type]++;
    return cnt;
  });
  const genCol = new Map<string, number>();
  armies.forEach((a, i) => a.generals.forEach((g) => genCol.set(g, i)));
  const body = h('div', { class: 'editor-body' });
  const error = h('div', { class: 'warn small' });
  const confirmBtn = h('button', { class: 'primary' }, t('reorg.confirm'));

  const groups = () => {
    const used = { cavalry: 0, infantry: 0, artillery: 0, supply: 0 } as Record<UnitType, number>;
    return cols.map((c, i) => ({
      army: c.id,
      units: UNIT_TYPES.flatMap((t) => { const ids = pools[t].slice(used[t], used[t] + perCol[i][t]).map((u) => u.id); used[t] += perCol[i][t]; return ids; }),
      generals: [...genCol].filter(([, col]) => col === i).map(([g]) => g),
    }));
  };
  const validate = (): string | null => {
    // Any mix is allowed; an army left with nothing is disbanded.
    void typeOf;
    return groups().some((g) => g.units.length || g.generals.length) ? null : t('split.errNone');
  };
  const shift = (t: UnitType, from: number, to: number) => {
    if (perCol[from][t] <= 0) return;
    perCol[from][t]--;
    perCol[to][t]++;
    draw();
  };
  const draw = () => {
    clear(body, 
      h('table', { class: 'reorg' },
        h('tr', {}, h('th', {}), cols.map((c) => h('th', {}, c.label))),
        UNIT_TYPES.filter((ty) => pools[ty].length).map((ty) => h('tr', {},
          h('td', {}, h('span', { class: 'unit-token', style: `--c:${opts.color}` }, unitIcon(ty, 18)), ` ${unitName(ty)}`),
          cols.map((_, i) => h('td', {},
            h('button', { 'aria-label': t('reorg.left'), disabled: i === 0 || !perCol[i][ty], onclick: () => shift(ty, i, i - 1) }, '◀'),
            h('span', { class: 'split-num' }, String(perCol[i][ty])),
            h('button', { 'aria-label': t('reorg.right'), disabled: i === cols.length - 1 || !perCol[i][ty], onclick: () => shift(ty, i, i + 1) }, '▶'))))),
        [...genCol].map(([g, col]) => h('tr', {},
          h('td', {}, generalText(g, state.generals[g]?.name)),
          cols.map((_, i) => h('td', {}, h('input', { type: 'radio', name: `gen-${g}`, checked: col === i, onchange: () => { genCol.set(g, i); draw(); } })))))),
      error);
    const problem = validate();
    error.textContent = problem ?? '';
    confirmBtn.disabled = Boolean(problem);
  };
  confirmBtn.addEventListener('click', () => { if (!validate()) opts.onConfirm(groups()); });
  draw();
  return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal editor wide', style: `--c:${opts.color}` },
    h('h3', {}, t('reorg.title', { node: armies[0].node })),
    h('p', { class: 'muted small' }, t('reorg.help')),
    body,
    h('div', { class: 'row end' }, h('button', { onclick: opts.onCancel }, t('common.cancel')), confirmBtn)));
}
