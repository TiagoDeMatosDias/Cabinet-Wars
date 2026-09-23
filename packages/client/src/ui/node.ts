import { isProtected, neighbors, sideOf, suppliedNodes, type GameView } from '@krieg/engine';
import { add, h } from './dom';
import { emblemEl, type Emblem } from './emblem';
import { nationColor, nationName, nodeName, unitSummary } from './labels';
import { currentTheme } from '../theme/theme';
import { iconEl } from './icons';
import { t } from '../i18n/i18n';

/** The node card (bottom left): owner, controller, victory points, roads and armies at a node. */
export function nodeCard(opts: {
  view: GameView;
  node: string;
  me: string | null;
  emblems: Map<string, Emblem>;
  /** The node lies under fog of war for the viewer. */
  fogged?: boolean;
  onSelectArmy(id: string): void;
  onSelectNode(id: string): void;
  onClose(): void;
}): HTMLElement | null {
  const { view: v, emblems } = opts;
  const n = v.nodes[opts.node];
  if (!n) return null;
  const occupied = n.controller !== n.owner;
  const nation = (id: string) => h('span', { class: 'node-nation' }, emblemEl(emblems.get(id), 22), nationName(v, id));
  const armies = Object.values(v.armies).filter((a) => a.node === n.id);
  const roads = neighbors(v, n.id).sort((a, b) => (a.type === b.type ? 0 : a.type === 'major' ? -1 : 1));
  const protectedNow = isProtected(v, n.id);
  const mySide = opts.me ? sideOf(v, opts.me) : null;
  const inSupply = mySide ? suppliedNodes(v, mySide).has(n.id) : null;

  const card = h('section', { class: 'node-card', style: `--c:${nationColor(v, n.controller)}`, 'aria-label': nodeName(v, n.id) },
    h('header', {},
      h('span', { class: 'node-dot', style: `background:${nationColor(v, n.controller)};border-color:${nationColor(v, n.owner)}` }),
      h('div', { class: 'army-title' },
        h('strong', {}, nodeName(v, n.id)),
        h('div', { class: 'muted small' }, occupied ? t('node.occupied', { nation: n.owner }) : t('node.held'))),
      h('button', { class: 'icon-btn', title: t('common.close'), 'aria-label': t('common.close'), onclick: opts.onClose }, '×')),
    h('dl', { class: 'node-facts' },
      h('dt', {}, t('node.owner')), h('dd', {}, nation(n.owner)),
      h('dt', {}, t('node.control')), h('dd', {}, nation(n.controller), occupied ? h('span', { class: 'warn small' }, ` ${t('node.occupiedTag')}`) : null),
      h('dt', {}, t('node.vp')),
      h('dd', {}, n.vp
        ? h('span', {}, h('span', { class: 'vp-seal' }, iconEl(currentTheme().icons.vp, 16)), ` ${n.vp}`,
          h('span', { class: 'muted small' }, ` ${occupied ? t('node.vpLost', { nation: n.owner }) : t('node.vpCount', { nation: n.owner })}`))
        : h('span', { class: 'muted' }, t('common.none'))),
      h('dt', {}, t('node.protected')),
      h('dd', {}, protectedNow
        ? h('span', {}, t('common.yes'), h('span', { class: 'muted small' }, ` ${t('node.protectedYes', { nation: n.controller })}`))
        : h('span', {}, t('common.no'), h('span', { class: 'muted small' }, ` ${t('node.protectedNo')}`))),
      inSupply === null ? null : [h('dt', {}, t('node.supply')), h('dd', {}, inSupply ? h('span', { class: 'ok' }, t('node.inReach')) : h('span', { class: 'warn' }, t('node.outOfReach')))]));

  add(card, h('div', { class: 'side-label' }, t('node.roads', { count: roads.length })),
    h('div', { class: 'node-roads' }, roads.map((r) => h('button', {
      class: `road-chip ${r.type}`, title: t(r.type === 'major' ? 'node.majorRoadTo' : 'node.minorRoadTo', { node: r.node }),
      onclick: () => opts.onSelectNode(r.node),
    }, h('span', { class: 'road-line' }), nodeName(v, r.node)))));

  if (opts.fogged) add(card, h('div', { class: 'fog-note' }, t('node.fogged')));
  add(card, h('div', { class: 'side-label' }, armies.length ? t('node.armiesHere', { count: armies.length }) : t('node.noArmies')),
    armies.length ? h('div', { class: 'choice-list' }, armies.map((a) => h('button', { class: 'choice', onclick: () => opts.onSelectArmy(a.id) },
      emblemEl(emblems.get(a.nation), 20), t('node.armyOption', { nation: a.nation, army: a.id }), h('span', { class: 'muted small' }, ' · ', unitSummary(a.units))))) : null);
  return card;
}
