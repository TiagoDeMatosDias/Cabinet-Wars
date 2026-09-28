import { GENERAL_POINTS, MOVE_POINTS, type Army, type GeneralCardType, type MapNode, type Nation, type UnitType } from '@cabinet-wars/engine';
import { MapView } from '../render/MapView';
import { applyTheme, CANONICAL_ID, listThemes, loadFonts, playerOverride, resolveTheme, type Theme } from '../theme/theme';
import { t, tn, useMapText } from '../i18n/i18n';
import { clear, h } from './dom';
import { buildEmblems, emblemEl } from './emblem';
import { iconEl } from './icons';

/**
 * The theme gallery: the Kriegsspiel unit blocks and their symbols, how armies of different sizes
 * look on the map, and the theme's nation colors, emblems, icons and type.
 */
export async function galleryScreen(root: HTMLElement, back: () => void): Promise<() => void> {
  useMapText(null);
  let theme: Theme;
  let color = '';
  let map: MapView | null = null;
  let generation = 0;
  let unitsBox: HTMLElement | null = null;

  const themeSelect = h('select', { onchange: () => void show(themeSelect.value) });
  const swatches = h('div', { class: 'row' });
  const body = h('div', {});
  clear(root, h('div', { class: 'menu gallery' },
    h('div', { class: 'row gallery-head' },
      h('button', { onclick: back }, `← ${t('gallery.back')}`),
      h('h1', {}, t('gallery.title'))),
    h('div', { class: 'row gallery-controls' },
      h('label', { class: 'row' }, `${t('gallery.theme')} `, themeSelect),
      h('span', { class: 'row' }, `${t('gallery.color')} `, swatches)),
    body));

  const list = await listThemes();
  const initial = playerOverride() ?? CANONICAL_ID;
  themeSelect.append(...list.map((th) => h('option', { value: th.id, selected: th.id === initial }, th.name)));

  void show(themeSelect.value || CANONICAL_ID);

  function renderControls() {
    clear(swatches, [...theme.map.nationPalette, 'custom'].map((c) => (c === 'custom'
      ? h('input', { type: 'color', value: color, title: t('gallery.customColor'), oninput: (e: Event) => setColor((e.target as HTMLInputElement).value) })
      : h('button', { class: `swatch ${c === color ? 'active' : ''}`, style: `background:${c}`, title: c, 'aria-label': c, onclick: () => setColor(c) }))));
  }

  function setColor(c: string) {
    color = c;
    renderControls();
    renderUnits();
    renderMap();
  }

  /** One block per unit type, as the map draws it, with its name and speed. */
  function renderUnits() {
    if (!unitsBox) return;
    const kinds: (UnitType | 'general')[] = ['infantry', 'cavalry', 'artillery', 'supply', 'general'];
    clear(unitsBox, kinds.map((kind) => h('figure', { class: 'gallery-unit' },
      h('div', { class: 'gallery-viewer gallery-icon' }, kind === 'general' ? starSvg() : blockSvg(kind, color, theme)),
      h('figcaption', {},
        h('strong', {}, t(`gallery.kind.${kind}`)),
        h('div', { class: 'muted small' }, tn('gallery.speed', kind === 'general' ? GENERAL_POINTS : MOVE_POINTS[kind]))))));
  }

  async function show(id: string) {
    const gen = ++generation;
    theme = await resolveTheme(id);
    if (gen !== generation) return;
    applyTheme(theme);
    await loadFonts(theme);
    color = theme.map.nationPalette[0] ?? '#a8362a';
    map?.destroy();
    map = null;
    renderControls();

    unitsBox = h('div', { class: 'gallery-units' });
    const mapBox = h('div', { class: 'gallery-map' });
    clear(body,
      h('section', {},
        h('h2', {}, t('gallery.units')),
        h('p', { class: 'muted small' }, t('gallery.unitsHint')),
        unitsBox),
      h('section', {},
        h('h2', {}, t('gallery.armies')),
        h('p', { class: 'muted small' }, t('gallery.armiesHint')),
        mapBox),
      nationsSection(theme),
      iconsSection(theme),
      colorsSection(theme),
      typeSection(theme));

    renderUnits();

    map = await MapView.create(mapBox, null, { width: 1200, height: 430 });
    if (gen !== generation) { map.destroy(); return; }
    renderMap();
    map.fitTo(SAMPLE.map((s) => ({ x: s.x, y: s.y })), 110);
  }

  function renderMap() {
    if (!map) return;
    const nation = { id: 'n', name: t('gallery.title'), color, side: 'attacker', threshold: 0, warExhaustion: 0, knockedOut: false, unitCap: 0 } satisfies Nation;
    const nodes: MapNode[] = SAMPLE.map((s, i) => ({ id: `s${i}`, name: t(`gallery.army.${s.key}`), color: '#000000', x: s.x, y: s.y, owner: 'n', controller: 'n', vp: 0 }));
    const armies: Army[] = SAMPLE.map((s, i) => ({
      id: `a${i}`, nation: 'n', node: `s${i}`,
      generals: Array.from({ length: s.generals }, (_, g) => `g${i}.${g}`),
      units: (Object.entries(s.units) as [UnitType, number][]).flatMap(([type, n]) => Array.from({ length: n }, (_, u) => ({ id: `${type}${i}.${u}`, type }))),
      moved: { edges: 0, allMajor: true, points: 0, bonus: 0, stopped: false },
    } as unknown as Army));
    map.render({
      nodes, edges: nodes.slice(1).map((n, i) => ({ a: nodes[i].id, b: n.id, type: i % 2 ? 'minor' : 'major' })),
      nations: [nation], armies, emblems: buildEmblems([nation], null, theme),
    });
  }

  return () => {
    generation++;
    map?.destroy();
  };
}

/** Sample armies shown on the gallery's map, from a lone company to a grand army. */
const SAMPLE: { key: 'company' | 'horse' | 'field' | 'grand' | 'siege' | 'column'; x: number; y: number; units: Partial<Record<UnitType, number>>; generals: number }[] = [
  { key: 'company', x: 100, y: 230, units: { infantry: 2 }, generals: 0 },
  { key: 'horse', x: 290, y: 150, units: { cavalry: 4 }, generals: 1 },
  { key: 'field', x: 500, y: 250, units: { infantry: 5, cavalry: 2, artillery: 1, supply: 1 }, generals: 1 },
  { key: 'grand', x: 740, y: 160, units: { infantry: 10, cavalry: 4, artillery: 3, supply: 3 }, generals: 2 },
  { key: 'siege', x: 950, y: 260, units: { artillery: 3, supply: 2 }, generals: 0 },
  { key: 'column', x: 1120, y: 170, units: { supply: 3 }, generals: 0 },
];

function nationsSection(theme: Theme) {
  const names = ['Qin', 'Chu', 'Qi', 'Yan', 'Zhao', 'Wei', 'Han', 'Shu'];
  const nations = theme.map.nationPalette.map((c, i) => ({ id: `n${i}`, name: names[i % names.length], color: c }));
  const emblems = buildEmblems(nations, null, theme);
  return h('section', {},
    h('h2', {}, t('gallery.nations')),
    h('div', { class: 'gallery-grid' }, nations.map((n) => h('div', { class: 'gallery-chip' },
      emblemEl(emblems.get(n.id), 40),
      h('span', { class: 'gallery-swatch', style: `background:${n.color}` }),
      h('code', {}, n.color)))),
    h('div', { class: 'row' }, theme.emblem.shapes.flatMap((shape) => (theme.emblem.styles as ('field' | 'outline')[]).map((style) => emblemEl({
      nation: shape, glyph: '令', shape, style, color: theme.map.nationPalette[0] ?? '#a8362a',
    }, 36, `${shape} · ${style}`)))));
}

function iconsSection(theme: Theme) {
  const icons: [string, string][] = [
    ...(Object.entries(theme.icons.unit) as [UnitType, string][]).map(([k, v]) => [t(`gallery.kind.${k}`), v] as [string, string]),
    [t('gallery.kind.general'), theme.icons.general], [t('gallery.icon.vp'), theme.icons.vp], [t('gallery.icon.battle'), theme.icons.battle],
    [t('gallery.icon.victory'), theme.icons.victory],
    [t('gallery.icon.deck.general'), theme.icons.deck.general], [t('gallery.icon.deck.event'), theme.icons.deck.event],
    ...(Object.entries(theme.icons.card) as [GeneralCardType, string][]).map(([k, v]) => [t(`card.${k}`), v] as [string, string]),
    [t('order.move'), theme.icons.order.move], [t('order.split'), theme.icons.order.split], [t('order.merge'), theme.icons.order.merge],
    [t('order.transfer'), theme.icons.order.reorganize], [t('order.playMoves'), theme.icons.order.card],
  ];
  return h('section', {},
    h('h2', {}, t('gallery.icons')),
    h('div', { class: 'gallery-grid' }, icons.map(([label, value]) => h('div', { class: 'gallery-chip' }, iconEl(value, 26, label), h('span', { class: 'small' }, label)))));
}

function colorsSection(theme: Theme) {
  const flat: [string, string][] = [];
  const walk = (o: unknown, path: string) => {
    if (typeof o === 'string' && /^#[0-9a-f]{6,8}$/i.test(o)) flat.push([path, o]);
    else if (o && typeof o === 'object' && !Array.isArray(o)) for (const [k, v] of Object.entries(o)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(theme.color, 'color');
  return h('section', {},
    h('h2', {}, t('gallery.colors')),
    h('div', { class: 'gallery-grid' }, flat.map(([path, c]) => h('div', { class: 'gallery-chip', title: path },
      h('span', { class: 'gallery-swatch', style: `background:${c}` }),
      h('span', { class: 'small' }, path.replace(/^color\./, '')),
      h('code', { class: 'small muted' }, c)))));
}

function typeSection(theme: Theme) {
  const fam = theme.type.family;
  return h('section', {},
    h('h2', {}, t('gallery.type')),
    h('p', { class: 'gallery-display' }, `${theme.name} · 天下大勢`),
    h('p', {}, t('menu.tagline')),
    h('p', { class: 'muted small' }, `${fam.display[0]} · ${fam.body[0]}`));
}

// ---- unit blocks ------------------------------------------------------------------------------

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A unit block as the map draws it: nation color, the type's military map symbol, a count. */
function blockSvg(type: UnitType, color: string, theme: Theme): SVGElement {
  const ink = theme.map.node.outline;
  const paper = theme.color.surface.raised;
  const svg = svgEl('svg', { viewBox: '-2 -2 44 22', width: 176, height: 88, role: 'img', 'aria-label': type });
  svg.append(svgEl('rect', { x: 0, y: 0, width: 40, height: 18, fill: color, stroke: ink, 'stroke-width': 1.2 }));
  svg.append(svgEl('rect', { x: 0.6, y: 15, width: 38.8, height: 2.4, fill: '#000', opacity: 0.25 }));
  const [x, y, w, hh] = [3, 3.5, 13, 9];
  svg.append(svgEl('rect', { x, y, width: w, height: hh, fill: 'none', stroke: paper, 'stroke-width': 1.2 }));
  if (type === 'infantry') svg.append(svgEl('path', { d: `M${x} ${y}L${x + w} ${y + hh}M${x + w} ${y}L${x} ${y + hh}`, stroke: paper, 'stroke-width': 1.2 }));
  else if (type === 'cavalry') svg.append(svgEl('path', { d: `M${x} ${y + hh}L${x + w} ${y}`, stroke: paper, 'stroke-width': 1.2 }));
  else if (type === 'artillery') svg.append(svgEl('circle', { cx: x + w / 2, cy: y + hh / 2, r: hh * 0.24, fill: paper }));
  else svg.append(svgEl('path', { d: `M${x} ${y + hh * 0.68}H${x + w}`, stroke: paper, 'stroke-width': 1.2 }));
  const num = svgEl('text', { x: 37, y: 13.5, 'text-anchor': 'end', 'font-size': 12, 'font-weight': 700, fill: paper, 'font-family': theme.type.family.numeric.join(', ') });
  num.textContent = '12';
  svg.append(num);
  return svg;
}

/** A general: the gilt star that pieces show in their header. */
function starSvg(): SVGElement {
  const svg = svgEl('svg', { viewBox: '-10 -10 20 20', width: 88, height: 88, role: 'img', 'aria-label': 'general' });
  const pts = Array.from({ length: 10 }, (_, i) => {
    const r = i % 2 ? 3.4 : 8;
    const a = (i * Math.PI) / 5 - Math.PI / 2;
    return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`;
  }).join(' ');
  svg.append(svgEl('polygon', { points: pts, fill: '#e2bd52', stroke: '#1f2633', 'stroke-width': 0.8 }));
  return svg;
}
