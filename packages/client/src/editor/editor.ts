import {
  checkConfig, configWarnings, DEFAULT_EVENT_DECK, DEFAULT_GENERAL_DECK, DEFAULT_RULES, MapConfigSchema, type RoadType, type Side,
} from '@krieg/engine';
import { MapView } from '../render/MapView';
import { saveBrowserMap, type MapBundle } from '../maps';
import { packBundle, unpackBundle } from '../storage/bundle';
import { clear, download, h, pickFiles, toast } from '../ui/dom';
import { buildEmblems, emblemEl } from '../ui/emblem';
import { applyTheme, currentTheme, knownThemes, loadFonts, resolveTheme } from '../theme/theme';
import { themeWarnings } from '../theme/contrast';
import { EN } from '../i18n/en';
import { translatableKeys } from '../i18n/i18n';
import { detectNodes } from './detect';
import { renderNodesImage, unusedColor } from './nodesImage';

interface ENation { id: string; name: string; color: string; side: Side; threshold: number; emblem?: { glyph?: string; shape?: string; image?: string } }
interface ENode { id: string; name: string; color: string; x: number; y: number; owner: string; controller?: string; vp: number }
interface EEdge { a: string; b: string; type: RoadType }
interface EGeneral { id: string; name: string; nation: string }
interface EArmy { id: string; nation: string; node: string; generals: string[]; units: { cavalry: number; infantry: number; artillery: number; supply: number } }
interface EConfig {
  name: string; version: number; background: string; nodesImage: string;
  theme?: string | Record<string, unknown>;
  rules?: { endGameFromRound?: number; mode?: 'sides' | 'freeForAll' };
  text?: Record<string, Record<string, string>>;
  languageNames?: Record<string, string>;
  decks?: { general: { card: string; count: number }[]; event: { card: string; count: number }[] };
  nations: ENation[]; nodes: ENode[]; edges: EEdge[]; generals: EGeneral[]; armies: EArmy[];
}

type Mode = 'select' | 'node' | 'major' | 'minor' | 'owner' | 'army';

const MODE_HINT: Record<Mode, string> = {
  select: 'Click a node to edit it.',
  node: 'Click an empty spot to add a node. Shift+click moves the selected node there.',
  major: 'Click node A, then node B to connect them with a major road. Clicking an existing major road removes it.',
  minor: 'Click node A, then node B to connect them with a minor road. Clicking an existing minor road removes it.',
  owner: 'Click nodes to give them to the chosen nation.',
  army: 'Click a node to place an army of its owner there.',
};
const IMAGE_EXT = /\.(png|webp|jpe?g)$/i;

function normalize(raw: Record<string, unknown>, name: string): EConfig {
  const c = raw as Partial<EConfig>;
  return {
    name: c.name ?? name,
    version: c.version ?? 1,
    background: c.background ?? 'map.png',
    nodesImage: c.nodesImage ?? 'nodes.png',
    nations: c.nations ?? [
      { id: 'attacker', name: 'Attacker', color: '#c0392b', side: 'attacker', threshold: 50 },
      { id: 'defender', name: 'Defender', color: '#2e86de', side: 'defender', threshold: 50 },
    ],
    nodes: c.nodes ?? [],
    edges: c.edges ?? [],
    generals: c.generals ?? [],
    armies: c.armies ?? [],
    ...(c.decks ? { decks: c.decks } : {}),
    ...(c.theme ? { theme: c.theme } : {}),
    ...(c.rules ? { rules: c.rules } : {}),
    ...(c.text ? { text: c.text } : {}),
    ...(c.languageNames ? { languageNames: c.languageNames } : {}),
  };
}

export interface EditorActions {
  back(): void;
  play(map: MapBundle): void;
}

export async function editorScreen(root: HTMLElement, source: MapBundle | null, actions: EditorActions) {
  const map: MapBundle = source
    ? { ...source, files: { ...source.files }, config: structuredClone(source.config) }
    : { id: `browser:${crypto.randomUUID()}`, name: 'New map', config: {}, files: {}, source: 'browser' };
  // Edits always go to a browser copy; server maps stay untouched.
  if (map.source === 'server') { map.id = `browser:${map.id.replace(/^server:/, '')}`; map.source = 'browser'; }
  let cfg = normalize(map.config, map.name);
  let mode: Mode = 'select';
  let selected: string | null = null;
  let edgeFrom: string | null = null;
  let paintNation = cfg.nations[0]?.id ?? '';
  let view: MapView | null = null;
  /** Nodes were added, moved or recolored by hand, so the nodes image must be redrawn on export. */
  let nodesDirty = false;

  const mapEl = h('div', { class: 'map' });
  const toolbar = h('header', { class: 'hud editor-toolbar' });
  const panel = h('aside', { class: 'panel' });
  clear(root, h('div', { class: 'game' }, toolbar, h('div', { class: 'game-body' }, mapEl, panel)));

  /** Previews the map's theme in the editor (the player's own override is ignored here). */
  async function previewTheme() {
    const t = await resolveTheme(cfg.theme ?? 'imperial-china');
    applyTheme(t);
    await loadFonts(t);
    view?.setTheme(t);
    redraw();
  }

  async function mountMap() {
    view?.destroy();
    mapEl.replaceChildren();
    view = await MapView.create(mapEl, map.files[cfg.background] ?? null);
    view.onClick = ({ node, x, y, shift }) => onMapClick(node, x, y, shift);
    if (cfg.nodes.length) view.fitTo(cfg.nodes);
    redraw();
  }

  function onMapClick(node: string | null, x: number, y: number, shift: boolean) {
    const { width, height } = view!.worldSize;
    const inside = x >= 0 && y >= 0 && x < width && y < height;
    if (mode === 'select') selected = node;
    else if (mode === 'node') {
      const sel = cfg.nodes.find((n) => n.id === selected);
      if (shift && sel && inside) { sel.x = Math.round(x); sel.y = Math.round(y); nodesDirty = true; }
      else if (node) selected = node;
      else if (inside) selected = addNode(x, y);
    }
    else if ((mode === 'major' || mode === 'minor') && node) {
      if (!edgeFrom) edgeFrom = node;
      else if (edgeFrom === node) edgeFrom = null;
      else { toggleEdge(edgeFrom, node, mode); edgeFrom = node; }
    } else if (mode === 'owner' && node) {
      const n = cfg.nodes.find((x) => x.id === node)!;
      n.owner = paintNation;
      delete n.controller;
    } else if (mode === 'army' && node) {
      const n = cfg.nodes.find((x) => x.id === node)!;
      addArmy(n.owner, node);
      mode = 'select';
      selected = node;
    }
    redraw();
  }

  function toggleEdge(a: string, b: string, type: RoadType) {
    const i = cfg.edges.findIndex((e) => (e.a === a && e.b === b) || (e.a === b && e.b === a));
    if (i < 0) cfg.edges.push({ a, b, type });
    else if (cfg.edges[i].type !== type) cfg.edges[i].type = type;
    else cfg.edges.splice(i, 1);
  }

  function uniqueId(prefix: string, taken: Set<string>) {
    let i = 1;
    while (taken.has(`${prefix}${i}`)) i++;
    return `${prefix}${i}`;
  }

  function addNode(x: number, y: number): string {
    const id = uniqueId('n', new Set(cfg.nodes.map((n) => n.id)));
    cfg.nodes.push({ id, name: '', color: unusedColor(cfg.nodes.map((n) => n.color)), x: Math.round(x), y: Math.round(y), owner: cfg.nations[0]?.id ?? '', vp: 0 });
    nodesDirty = true;
    return id;
  }

  function addArmy(nation: string, node: string) {
    const gid = uniqueId(`${nation}-g`, new Set(cfg.generals.map((g) => g.id)));
    cfg.generals.push({ id: gid, name: `General ${gid}`, nation });
    const id = uniqueId(`${nation}-army`, new Set(cfg.armies.map((a) => a.id)));
    cfg.armies.push({ id, nation, node, generals: [gid], units: { cavalry: 1, infantry: 3, artillery: 1, supply: 1 } });
  }

  /** Replaces the nodes with the dots found in the node map. Returns false if cancelled. */
  async function runDetection(): Promise<boolean> {
    const img = map.files[cfg.nodesImage];
    if (!img) { toast('Upload a node map first', 'error'); return false; }
    const { nodes } = await detectNodes(img);
    const taken = new Set(cfg.nodes.map((n) => n.id));
    const unmatched = [...cfg.nodes];
    const next: ENode[] = [];
    let added = 0;
    for (const d of nodes) {
      // Reuse the closest existing node of the same color, so re-running keeps the authored data.
      let bi = -1;
      let bd = Infinity;
      unmatched.forEach((n, i) => {
        const dist = Math.hypot(n.x - d.x, n.y - d.y);
        if (n.color.toLowerCase() === d.color && dist < bd && dist < 80) { bd = dist; bi = i; }
      });
      if (bi >= 0) next.push({ ...unmatched.splice(bi, 1)[0], x: d.x, y: d.y });
      else {
        const id = uniqueId('n', taken);
        taken.add(id);
        next.push({ id, name: '', color: d.color, x: d.x, y: d.y, owner: cfg.nations[0]?.id ?? '', vp: 0 });
        added++;
      }
    }
    const removed = new Set(unmatched.map((n) => n.id));
    if (removed.size && !confirm(`${removed.size} existing node(s) are not in the node map and will be removed, with their roads and armies. Continue?`)) return false;
    cfg.nodes = next;
    nodesDirty = false;
    cfg.edges = cfg.edges.filter((e) => !removed.has(e.a) && !removed.has(e.b));
    cfg.armies = cfg.armies.filter((a) => !removed.has(a.node));
    toast(`Detected ${nodes.length} nodes (${added} new, ${removed.size} removed)`);
    redraw();
    return true;
  }

  async function uploadBaseMap() {
    const [f] = await pickFiles('.png,.webp,.jpg,.jpeg');
    if (!f) return;
    if (!IMAGE_EXT.test(f.name)) { toast('The base map must be a PNG, WebP or JPEG image', 'error'); return; }
    if (map.files[cfg.background] && cfg.background !== cfg.nodesImage) delete map.files[cfg.background];
    cfg.background = `map.${f.name.split('.').pop()!.toLowerCase()}`;
    map.files[cfg.background] = f;
    await mountMap();
    const nodes = map.files[cfg.nodesImage];
    const mismatch = nodes ? await sizeMismatch(f, nodes) : null;
    toast(mismatch ? `${mismatch} Upload a matching node map or re-place the nodes.` : 'Base map loaded', mismatch ? 'error' : 'info');
  }

  async function uploadNodeMap() {
    const [f] = await pickFiles('.png,.webp');
    if (!f) return;
    if (!/\.(png|webp)$/i.test(f.name)) { toast('The node map must be a PNG or WebP (JPEG changes the dot colors)', 'error'); return; }
    const bg = map.files[cfg.background];
    const mismatch = bg ? await sizeMismatch(bg, f) : null;
    if (mismatch && !confirm(`${mismatch} The dots will not line up with the map. Use it anyway?`)) return;
    const previous = map.files[cfg.nodesImage];
    cfg.nodesImage = 'nodes.png';
    map.files[cfg.nodesImage] = f.type === 'image/png' ? f : await toPng(f);
    if (!(await runDetection())) {
      if (previous) map.files[cfg.nodesImage] = previous; else delete map.files[cfg.nodesImage];
      redraw();
    }
  }

  async function toPng(img: Blob): Promise<Blob> {
    const bitmap = await createImageBitmap(img);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
    return canvas.convertToBlob({ type: 'image/png' });
  }

  /** Describes a size difference between the base map and a node map, or null when they match. */
  async function sizeMismatch(base: Blob, nodes: Blob): Promise<string | null> {
    const [a, b] = await Promise.all([createImageBitmap(base), createImageBitmap(nodes)]);
    return a.width === b.width && a.height === b.height
      ? null
      : `The node map is ${b.width}×${b.height} but the base map is ${a.width}×${a.height}.`;
  }

  /** Opens a .krieg map/save bundle or a config.json, replacing what is being edited. */
  async function openMap() {
    const [f] = await pickFiles('.krieg,.zip,.json');
    if (!f) return;
    if (cfg.nodes.length && !confirm('Replace the map you are editing?')) return;
    try {
      if (f.name.endsWith('.json')) {
        cfg = normalize(JSON.parse(await f.text()), cfg.name);
      } else {
        const b = await unpackBundle(f, map.id);
        map.files = b.map.files;
        cfg = normalize(b.map.config, b.map.name);
      }
      selected = null;
      nodesDirty = false;
      paintNation = cfg.nations[0]?.id ?? '';
      await mountMap();
      toast(`Opened "${cfg.name}"`);
    } catch (e) {
      toast(`${f.name}: ${(e as Error).message}`, 'error');
    }
  }

  function exportConfig(): Record<string, unknown> {
    return JSON.parse(JSON.stringify(cfg));
  }

  function problems() {
    const parsed = MapConfigSchema.safeParse(exportConfig());
    if (!parsed.success) return { errors: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`), warnings: [] as string[] };
    return { errors: checkConfig(parsed.data), warnings: [...configWarnings(parsed.data), ...themeWarnings(currentTheme(), cfg.nations.map((n) => n.color))] };
  }

  /** The map as files: config plus images. Redraws the nodes image when nodes were edited by hand. */
  async function bundle(): Promise<MapBundle> {
    if (cfg.nodes.length && (nodesDirty || !map.files[cfg.nodesImage])) {
      const { width, height } = view!.worldSize;
      cfg.nodesImage = 'nodes.png';
      map.files[cfg.nodesImage] = await renderNodesImage(cfg.nodes, width, height);
      nodesDirty = false;
    }
    map.config = exportConfig();
    map.name = cfg.name;
    return map;
  }

  // ---- panel -------------------------------------------------------------

  const input = (value: string | number, onchange: (v: string) => void, attrs: Record<string, unknown> = {}) =>
    h('input', { value: String(value), onchange: (e: Event) => { onchange((e.target as HTMLInputElement).value); redraw(); }, ...attrs });
  const nationSelect = (value: string, onchange: (v: string) => void) =>
    h('select', { onchange: (e: Event) => { onchange((e.target as HTMLSelectElement).value); redraw(); } },
      cfg.nations.map((n) => h('option', { value: n.id, selected: n.id === value }, n.name)));

  let emblems = buildEmblems(cfg.nations, map);

  function nationsSection() {
    return h('details', { class: 'section', open: true },
      h('summary', {}, `Nations (${cfg.nations.length})`),
      h('table', { class: 'grid' },
        h('tr', {}, h('th', {}, ''), h('th', {}, 'id'), h('th', {}, 'name'), h('th', {}, 'color'), h('th', {}, 'side'), h('th', { title: 'Knocked out below this willingness %' }, 'KO %'), h('th', { title: 'Emblem: 1–3 characters and a shape. Leave empty to generate one.' }, 'emblem'), h('th', {})),
        cfg.nations.map((n, i) => h('tr', {},
          h('td', {}, emblemEl(emblems.get(n.id), 26)),
          h('td', {}, input(n.id, (v) => renameNation(n.id, v), { size: 8 })),
          h('td', {}, input(n.name, (v) => { n.name = v; }, { size: 10 })),
          h('td', {}, input(n.color, (v) => { n.color = v; }, { type: 'color' })),
          h('td', {}, h('select', { onchange: (e: Event) => { n.side = (e.target as HTMLSelectElement).value as Side; redraw(); } },
            (['attacker', 'defender'] as const).map((s) => h('option', { value: s, selected: n.side === s }, s)))),
          h('td', {}, input(n.threshold, (v) => { n.threshold = Number(v); }, { type: 'number', min: 0, max: 100, style: 'width:4em' })),
          h('td', {},
            input(n.emblem?.glyph ?? '', (v) => { n.emblem = { ...n.emblem, glyph: v.trim().slice(0, 3) || undefined }; }, { size: 3, placeholder: 'auto', title: 'Emblem glyph (1–3 characters)' }),
            h('select', { title: 'Emblem shape', onchange: (e: Event) => { n.emblem = { ...n.emblem, shape: (e.target as HTMLSelectElement).value || undefined }; redraw(); } },
              h('option', { value: '' }, 'auto'),
              currentTheme().emblem.shapes.map((sh) => h('option', { value: sh, selected: n.emblem?.shape === sh }, sh)))),
          h('td', {}, h('button', { class: 'danger', onclick: () => { if (cfg.nations.length > 2) { cfg.nations.splice(i, 1); redraw(); } } }, '✕'))))),
      h('button', {
        onclick: () => {
          const id = uniqueId('nation', new Set(cfg.nations.map((n) => n.id)));
          cfg.nations.push({ id, name: id, color: `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`, side: 'attacker', threshold: 50 });
          redraw();
        },
      }, '+ Nation'));
  }

  function renameNation(from: string, to: string) {
    if (!to || cfg.nations.some((n) => n.id === to)) { toast('Nation ids must be unique', 'error'); return; }
    for (const n of cfg.nations) if (n.id === from) n.id = to;
    for (const n of cfg.nodes) { if (n.owner === from) n.owner = to; if (n.controller === from) n.controller = to; }
    for (const g of cfg.generals) if (g.nation === from) g.nation = to;
    for (const a of cfg.armies) if (a.nation === from) a.nation = to;
    if (paintNation === from) paintNation = to;
  }

  function renameNode(from: string, to: string) {
    if (!to || cfg.nodes.some((n) => n.id === to)) { toast('Node ids must be unique', 'error'); return; }
    for (const n of cfg.nodes) if (n.id === from) n.id = to;
    for (const e of cfg.edges) { if (e.a === from) e.a = to; if (e.b === from) e.b = to; }
    for (const a of cfg.armies) if (a.node === from) a.node = to;
    selected = to;
  }

  function nodeSection() {
    const n = cfg.nodes.find((x) => x.id === selected);
    if (!n) return h('div', { class: 'section muted' }, 'Select a node on the map to edit it.');
    const edges = cfg.edges.filter((e) => e.a === n.id || e.b === n.id);
    const armies = cfg.armies.filter((a) => a.node === n.id);
    return h('div', { class: 'section' },
      h('h3', {}, h('span', { class: 'nation-dot', style: `background:${n.color}` }), `Node ${n.id}`),
      h('div', { class: 'form' },
        h('label', {}, 'id ', input(n.id, (v) => renameNode(n.id, v))),
        h('label', {}, 'name ', input(n.name, (v) => { n.name = v; })),
        h('label', {}, 'owner ', nationSelect(n.owner, (v) => { n.owner = v; })),
        h('label', {}, 'controller ', h('select', { onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) n.controller = v; else delete n.controller; redraw(); } },
          h('option', { value: '' }, '(owner)'), cfg.nations.map((x) => h('option', { value: x.id, selected: n.controller === x.id }, x.name)))),
        h('label', {}, 'victory points ', input(n.vp, (v) => { n.vp = Number(v) || 0; }, { type: 'number', min: 0, style: 'width:4em' })),
      ),
      h('div', { class: 'row' },
        'x ', input(n.x, (v) => { n.x = Math.round(Number(v) || 0); nodesDirty = true; }, { type: 'number', style: 'width:5.5em' }),
        'y ', input(n.y, (v) => { n.y = Math.round(Number(v) || 0); nodesDirty = true; }, { type: 'number', style: 'width:5.5em' }),
        'dot ', input(n.color, (v) => { n.color = v; nodesDirty = true; }, { type: 'color', title: 'Color of this node in the node map' })),
      h('h4', {}, `Roads (${edges.length})`),
      edges.map((e) => h('div', { class: 'row' },
        `→ ${e.a === n.id ? e.b : e.a}`,
        h('button', { onclick: () => { e.type = e.type === 'major' ? 'minor' : 'major'; redraw(); } }, e.type),
        h('button', { class: 'danger', onclick: () => { cfg.edges.splice(cfg.edges.indexOf(e), 1); redraw(); } }, '✕'))),
      h('h4', {}, `Armies (${armies.length})`),
      armies.map((a) => armyEditor(a)),
      h('button', { onclick: () => { addArmy(n.owner, n.id); redraw(); } }, '+ Army here'),
      h('button', { class: 'danger', onclick: () => {
        cfg.nodes = cfg.nodes.filter((x) => x !== n);
        nodesDirty = true;
        cfg.edges = cfg.edges.filter((e) => e.a !== n.id && e.b !== n.id);
        cfg.armies = cfg.armies.filter((a) => a.node !== n.id);
        selected = null;
        redraw();
      } }, 'Delete node'));
  }

  function armyEditor(a: EArmy) {
    const gens = cfg.generals.filter((g) => a.generals.includes(g.id));
    return h('div', { class: 'army-edit' },
      h('div', { class: 'row' }, h('strong', {}, a.id), nationSelect(a.nation, (v) => {
        a.nation = v;
        for (const g of gens) g.nation = v;
      }),
      h('button', { class: 'danger', onclick: () => {
        cfg.armies.splice(cfg.armies.indexOf(a), 1);
        cfg.generals = cfg.generals.filter((g) => !a.generals.includes(g.id));
        redraw();
      } }, '✕')),
      h('div', { class: 'row' }, (['cavalry', 'infantry', 'artillery', 'supply'] as const).map((t) =>
        h('label', {}, `${t} `, input(a.units[t], (v) => { a.units[t] = Math.max(0, Number(v) || 0); }, { type: 'number', min: 0, style: 'width:3.5em' })))),
      h('div', { class: 'row' }, 'Generals: ', gens.map((g) => h('span', {}, input(g.name, (v) => { g.name = v; }, { size: 12 }),
        h('button', { onclick: () => { a.generals = a.generals.filter((x) => x !== g.id); cfg.generals = cfg.generals.filter((x) => x !== g); redraw(); } }, '✕'))),
      h('button', { onclick: () => {
        const id = uniqueId(`${a.nation}-g`, new Set(cfg.generals.map((g) => g.id)));
        cfg.generals.push({ id, name: `General ${id}`, nation: a.nation });
        a.generals.push(id);
        redraw();
      } }, '+ General')));
  }

  // ---- rules & decks ----

  function rulesSection() {
    const rules = cfg.rules ?? {};
    const decks = cfg.decks ?? { general: DEFAULT_GENERAL_DECK.map((d) => ({ ...d })), event: DEFAULT_EVENT_DECK.map((d) => ({ ...d })) };
    const deckTable = (kind: 'general' | 'event') => {
      const total = decks[kind].reduce((n, d) => n + d.count, 0);
      return h('table', { class: 'grid' },
        decks[kind].map((d) => h('tr', {},
          h('td', {}, kind === 'general' ? (EN as Record<string, string>)[`card.${d.card}`] ?? d.card : (translatableKeys()[`event.${d.card}`] ?? d.card)),
          h('td', {}, input(d.count, (v) => {
            d.count = Math.max(0, Math.floor(Number(v) || 0));
            cfg.decks = decks;
          }, { type: 'number', min: 0, style: 'width:5em' })))),
        h('tr', {}, h('td', { class: 'muted' }, 'Total'), h('td', { class: 'muted' }, String(total))));
    };
    const events = decks.event.reduce((n, d) => n + d.count, 0);
    const endCards = decks.event.find((d) => d.card === 'endGame')?.count ?? 0;
    return h('details', { class: 'section' },
      h('summary', {}, 'Rules & decks'),
      h('div', { class: 'form' },
        h('label', { title: 'Free for all: every nation is an attacker, at war with every other; the last nation standing wins. Players can also pick this when starting a game.' },
          'Game mode ',
          h('select', { onchange: (e: Event) => { cfg.rules = { ...cfg.rules, mode: (e.target as HTMLSelectElement).value as 'sides' | 'freeForAll' }; redraw(); } },
            h('option', { value: 'sides', selected: (rules.mode ?? 'sides') === 'sides' }, 'Attackers against defenders'),
            h('option', { value: 'freeForAll', selected: rules.mode === 'freeForAll' }, 'Free for all'))),
        h('label', { title: 'Before this round, a drawn End Game card goes to the bottom of the event deck and the war goes on.' },
          'End Game possible from round ',
          input(rules.endGameFromRound ?? DEFAULT_RULES.endGameFromRound, (v) => {
            cfg.rules = { ...cfg.rules, endGameFromRound: Math.max(1, Math.floor(Number(v) || 1)) };
          }, { type: 'number', min: 1, style: 'width:5em' }))),
      h('p', { class: 'muted small' }, `Event deck: ${endCards} End Game card${endCards === 1 ? '' : 's'} among ${events} cards. Each nation draws one event per turn, so a full deck lasts about ${Math.round(events / Math.max(1, cfg.nations.length))} rounds.`),
      h('h4', {}, 'Event deck'), deckTable('event'),
      h('h4', {}, 'General deck'), deckTable('general'),
      cfg.decks ? h('button', { onclick: () => { delete cfg.decks; redraw(); } }, 'Reset decks to the standard counts') : null);
  }

  // ---- languages & translations ----

  let editLang: string | null = null;
  let keyFilter = '';

  function translationsSection() {
    cfg.text ??= {};
    cfg.languageNames ??= {};
    const langs = Object.keys(cfg.text);
    if (editLang && !langs.includes(editLang)) editLang = null;
    editLang ??= langs[0] ?? null;
    const codeInput = h('input', { placeholder: 'code, e.g. zh', size: 6 });
    const nameInput = h('input', { placeholder: 'name, e.g. 中文', size: 10 });
    const contentKeys: [string, string][] = [
      ['map.name', cfg.name],
      ...cfg.nations.map((n): [string, string] => [`nation.${n.id}`, n.name]),
      ...cfg.nodes.map((n): [string, string] => [`node.${n.id}`, n.name || n.id]),
      ...cfg.generals.map((g): [string, string] => [`general.${g.id}`, g.name]),
    ];
    const row = (key: string, english: string) => h('tr', {},
      h('td', { class: 'muted small', title: key }, english),
      h('td', {}, input(cfg.text![editLang!]?.[key] ?? '', (v) => {
        const dict = (cfg.text![editLang!] ??= {});
        if (v.trim()) dict[key] = v; else delete dict[key];
      }, { size: 18, placeholder: '(English)' })));
    const uiKeys = Object.entries(translatableKeys())
      .filter(([k, v]) => !keyFilter || k.toLowerCase().includes(keyFilter) || v.toLowerCase().includes(keyFilter));
    return h('details', { class: 'section', open: langs.length > 0 },
      h('summary', {}, `Languages & translations (${['English', ...langs.map((l) => cfg.languageNames![l] ?? l)].join(', ')})`),
      h('p', { class: 'muted small' }, 'Names and text above are the English defaults. Add a language, then translate the map\'s names and, if you like, any interface text. Anything left empty shows in English.'),
      h('div', { class: 'row' }, codeInput, nameInput, h('button', {
        onclick: () => {
          const code = codeInput.value.trim().toLowerCase();
          if (!/^[a-z]{2,3}(-[a-z0-9]{2,8})?$/.test(code) || code === 'en') { toast('Use a language code such as "zh", "de" or "pt-br" (English is built in)', 'error'); return; }
          cfg.text![code] ??= {};
          if (nameInput.value.trim()) cfg.languageNames![code] = nameInput.value.trim();
          editLang = code;
          redraw();
        },
      }, '+ Language')),
      langs.length ? h('div', { class: 'row' },
        'Translating: ',
        h('select', { onchange: (e: Event) => { editLang = (e.target as HTMLSelectElement).value; redraw(); } },
          langs.map((l) => h('option', { value: l, selected: l === editLang }, `${cfg.languageNames![l] ?? l} (${l})`))),
        input(cfg.languageNames![editLang!] ?? '', (v) => { if (v.trim()) cfg.languageNames![editLang!] = v.trim(); else delete cfg.languageNames![editLang!]; }, { size: 10, placeholder: 'display name', title: 'Name shown in the language menu' }),
        h('button', { class: 'danger', onclick: () => { if (confirm(`Remove the language "${editLang}" and its translations?`)) { delete cfg.text![editLang!]; delete cfg.languageNames![editLang!]; editLang = null; redraw(); } } }, 'Remove')) : null,
      editLang ? [
        h('h4', {}, 'Map names'),
        h('table', { class: 'grid' }, contentKeys.map(([k, en]) => row(k, en))),
        h('details', {},
          h('summary', {}, `Interface and log text (${Object.keys(cfg.text![editLang] ?? {}).filter((k) => !contentKeys.some(([c]) => c === k)).length} translated)`),
          h('div', { class: 'row' }, 'Filter ', h('input', {
            value: keyFilter, placeholder: 'search…',
            onchange: (e: Event) => { keyFilter = (e.target as HTMLInputElement).value.trim().toLowerCase(); redraw(); },
          })),
          h('p', { class: 'muted small' }, 'Keep {placeholders} as they are; they are filled in by the game.'),
          h('table', { class: 'grid' }, uiKeys.slice(0, 400).map(([k, en]) => row(k, en)))),
      ] : null);
  }

  function problemsSection() {
    const { errors, warnings } = problems();
    return h('details', { class: 'section', open: errors.length > 0 },
      h('summary', {}, errors.length ? `⚠ ${errors.length} problem(s)` : '✓ Map is playable', warnings.length ? ` · ${warnings.length} warning(s)` : ''),
      h('ul', {}, errors.slice(0, 40).map((p) => h('li', { class: 'warn' }, p)), warnings.slice(0, 20).map((p) => h('li', { class: 'muted' }, p))));
  }

  function renderToolbar() {
    const modeBtn = (m: Mode, label: string, title: string) =>
      h('button', { class: mode === m ? 'active' : '', title, onclick: () => { mode = m; edgeFrom = null; redraw(); } }, label);
    clear(toolbar,
      h('div', { class: 'hud-left' },
        h('button', { onclick: actions.back }, '← Menu'),
        input(cfg.name, (v) => { cfg.name = v; }, { size: 14, title: 'Map name' })),
      h('div', { class: 'row' },
        modeBtn('select', 'Select', MODE_HINT.select),
        modeBtn('node', 'Place node', MODE_HINT.node),
        modeBtn('major', 'Major road', 'Click node A then node B. Clicking an existing road of this type removes it'),
        modeBtn('minor', 'Minor road', 'Click node A then node B. Clicking an existing road of this type removes it'),
        modeBtn('owner', 'Paint owner', 'Click nodes to set their owner'),
        mode === 'owner' ? nationSelect(paintNation, (v) => { paintNation = v; }) : null,
        modeBtn('army', 'Place army', 'Click a node to place an army of its owner'),
        h('select', {
          title: 'The interface theme players see with this map',
          onchange: (e: Event) => { const v = (e.target as HTMLSelectElement).value; if (v) cfg.theme = v; else delete cfg.theme; void previewTheme(); },
        },
        h('option', { value: '', selected: !cfg.theme }, 'Theme: default'),
        knownThemes().map((th) => h('option', { value: th.id, selected: cfg.theme === th.id }, `Theme: ${th.name}`)))),
      h('div', { class: 'hud-right' },
        h('button', { onclick: () => void uploadBaseMap(), title: 'The background image players see (PNG, WebP or JPEG)' }, 'Base map…'),
        h('button', { onclick: () => void uploadNodeMap(), title: 'Optional: an image with one colored dot per node, the same size as the base map. Nodes are created from the dots.' }, 'Node map…'),
        map.files[cfg.nodesImage] ? h('button', { onclick: () => void runDetection(), title: 'Re-read the dots from the node map' }, 'Detect nodes') : null,
        h('button', { onclick: () => void openMap(), title: 'Open a .krieg map or a config.json' }, 'Open…'),
        h('button', { onclick: async () => { await saveBrowserMap(await bundle()); toast('Saved in this browser'); } }, 'Save'),
        h('button', {
          title: 'Download the map as a .krieg file (a zip with config.json, the base map and the node map)',
          onclick: async () => download(await packBundle({ map: await bundle() }), `${cfg.name.replace(/\W+/g, '_')}.krieg`),
        }, 'Download'),
        h('button', { title: 'Download only config.json', onclick: () => download(new Blob([JSON.stringify(exportConfig(), null, 2)], { type: 'application/json' }), 'config.json') }, 'config.json'),
        h('button', { class: 'primary', onclick: async () => { const { errors } = problems(); if (errors.length) toast(errors[0], 'error'); else actions.play(await bundle()); } }, 'Play')));
  }

  function redraw() {
    renderToolbar();
    clear(panel,
      h('div', { class: 'section prompt' }, MODE_HINT[mode]),
      !map.files[cfg.background] ? h('div', { class: 'section warn' }, 'No base map yet. Use "Base map…" to upload the background image, then either "Node map…" or "Place node" to add nodes.') : null,
      problemsSection(),
      nodeSection(),
      nationsSection(),
      rulesSection(),
      translationsSection(),
      h('div', { class: 'section muted' }, `${cfg.nodes.length} nodes · ${cfg.edges.length} roads · ${cfg.armies.length} armies`));
    emblems = buildEmblems(cfg.nations, map);
    view?.render({
      emblems,
      nodes: cfg.nodes.map((n) => ({ ...n, controller: n.controller ?? n.owner })),
      edges: cfg.edges,
      nations: cfg.nations.map(({ emblem: _e, ...n }) => ({ ...n, warExhaustion: 0, knockedOut: false })),
      armies: cfg.armies.map((a) => ({
        id: a.id, nation: a.nation, node: a.node, generals: a.generals,
        units: (['cavalry', 'infantry', 'artillery', 'supply'] as const).flatMap((t) => Array.from({ length: a.units[t] }, (_, i) => ({ id: `${a.id}.${t}${i}`, type: t }))),
        moved: { edges: 0, allMajor: true, bonus: 0, stopped: false },
      })),
      selectedNode: selected,
      pendingEdgeFrom: edgeFrom,
      labels: true,
    });
  }

  await previewTheme();
  await mountMap();
  if (map.files[cfg.nodesImage] && !cfg.nodes.length) await runDetection();
  return () => view?.destroy();
}
