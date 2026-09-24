import { GENERAL_SPEED, UNIT_SPEED, type Army, type GeneralCardType, type MapNode, type Nation, type UnitType } from '@krieg/engine';
import { MapView } from '../render/MapView';
import type { FigureKind } from '../render/formation';
import { ANIMS, armyModel, FIGURE_KINDS, instance, loadModel, studio, type AnimName, type ArmyModel } from '../render/miniatures';
import { applyTheme, CANONICAL_ID, listThemes, loadFonts, playerOverride, resolveTheme, type Theme } from '../theme/theme';
import { t, tn, useMapText } from '../i18n/i18n';
import { clear, h } from './dom';
import { buildEmblems, emblemEl } from './emblem';
import { iconEl } from './icons';

/**
 * The theme gallery: a theme's army miniatures (live 3D, with their animations), how armies of
 * different sizes look on the map, and the theme's nation colors, emblems, icons and type.
 */
export async function galleryScreen(root: HTMLElement, back: () => void): Promise<() => void> {
  useMapText(null);
  let theme: Theme;
  let color = '';
  let anim: AnimName = 'Idle';
  let viewers: Viewer[] = [];
  let map: MapView | null = null;
  let generation = 0;
  let raf = 0;

  const themeSelect = h('select', { onchange: () => void show(themeSelect.value) });
  const swatches = h('div', { class: 'row' });
  const animButtons = h('div', { class: 'row' });
  const body = h('div', {});
  clear(root, h('div', { class: 'menu gallery' },
    h('div', { class: 'row gallery-head' },
      h('button', { onclick: back }, `← ${t('gallery.back')}`),
      h('h1', {}, t('gallery.title'))),
    h('div', { class: 'row gallery-controls' },
      h('label', { class: 'row' }, `${t('gallery.theme')} `, themeSelect),
      h('span', { class: 'row' }, `${t('gallery.color')} `, swatches),
      h('span', { class: 'row' }, `${t('gallery.animation')} `, animButtons)),
    body));

  const list = await listThemes();
  const initial = playerOverride() ?? CANONICAL_ID;
  themeSelect.append(...list.map((th) => h('option', { value: th.id, selected: th.id === initial }, th.name)));

  const loop = () => {
    raf = requestAnimationFrame(loop);
    void drawViewers(viewers);
  };
  raf = requestAnimationFrame(loop);
  void show(themeSelect.value || CANONICAL_ID);

  function renderControls() {
    clear(swatches, [...theme.map.nationPalette, 'custom'].map((c) => (c === 'custom'
      ? h('input', { type: 'color', value: color, title: t('gallery.customColor'), oninput: (e: Event) => setColor((e.target as HTMLInputElement).value) })
      : h('button', { class: `swatch ${c === color ? 'active' : ''}`, style: `background:${c}`, title: c, 'aria-label': c, onclick: () => setColor(c) }))));
    clear(animButtons, ANIMS.map((a) => h('button', { class: a === anim ? 'active' : '', 'aria-pressed': a === anim, onclick: () => { anim = a; renderControls(); for (const v of viewers) v.play(anim); renderMap(); } }, t(`gallery.anim.${a}`))));
  }

  function setColor(c: string) {
    color = c;
    renderControls();
    for (const v of viewers) v.setColor(c);
    renderMap();
  }

  async function show(id: string) {
    const gen = ++generation;
    theme = await resolveTheme(id);
    if (gen !== generation) return;
    applyTheme(theme);
    await loadFonts(theme);
    color = theme.map.nationPalette[0] ?? '#a8362a';
    for (const v of viewers) v.dispose();
    viewers = [];
    map?.destroy();
    map = null;
    renderControls();
    const model = armyModel(theme);

    const unitsBox = h('div', { class: 'gallery-units' });
    const mapBox = h('div', { class: 'gallery-map' });
    clear(body,
      h('section', {},
        h('h2', {}, t('gallery.units')),
        h('p', { class: 'muted small' }, model ? t('gallery.unitsHint') : t('gallery.noModels')),
        unitsBox),
      h('section', {},
        h('h2', {}, t('gallery.armies')),
        h('p', { class: 'muted small' }, model
          ? t('gallery.armiesHint', { n: model.unitsPerFigure, max: model.maxFigures })
          : t('gallery.armiesBlocks', { n: theme.army.blockPerUnits, max: theme.army.maxBlocks })),
        mapBox),
      nationsSection(theme),
      iconsSection(theme),
      colorsSection(theme),
      typeSection(theme));

    for (const kind of FIGURE_KINDS) {
      const canvas = h('canvas', { width: 480, height: 480, class: 'gallery-viewer' });
      const status = h('div', { class: 'muted small' });
      const speed = kind === 'general' ? GENERAL_SPEED : UNIT_SPEED[kind];
      unitsBox.append(h('figure', { class: 'gallery-unit' },
        model?.units[kind] ? canvas : h('div', { class: 'gallery-viewer gallery-icon' }, iconEl(kind === 'general' ? theme.icons.general : theme.icons.unit[kind], 72)),
        status,
        h('figcaption', {},
          h('strong', {}, t(`gallery.kind.${kind}`)),
          h('div', { class: 'muted small' }, tn('gallery.speed', speed)))));
      if (!model?.units[kind]) continue;
      status.textContent = t('gallery.loading');
      Viewer.create(canvas, model, kind, color, anim).then((v) => {
        if (gen !== generation) { v.dispose(); return; }
        status.textContent = '';
        viewers.push(v);
      }, (err) => {
        console.warn(err);
        status.textContent = t('gallery.failed');
      });
    }

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
      moved: { edges: 0, allMajor: true, bonus: 0, stopped: false },
    } as unknown as Army));
    map.render({
      nodes, edges: nodes.slice(1).map((n, i) => ({ a: nodes[i].id, b: n.id, type: i % 2 ? 'minor' : 'major' })),
      nations: [nation], armies, emblems: buildEmblems([nation], null, theme), animation: anim,
    });
  }

  return () => {
    generation++;
    cancelAnimationFrame(raf);
    for (const v of viewers) v.dispose();
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

// ---- live 3D viewers ---------------------------------------------------------------------------

type Three = typeof import('three');

class Viewer {
  private yaw = 0.6;
  private spin = true;
  private drag: number | null = null;
  private clips = new Map<string, import('three').AnimationAction>();
  private clock = performance.now();
  private disposed = false;

  private constructor(
    private canvas: HTMLCanvasElement,
    private scene: import('three').Scene,
    private camera: import('three').PerspectiveCamera,
    private pivot: import('three').Group,
    private inst: Awaited<ReturnType<typeof instance>>,
  ) {
    canvas.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
  }

  static async create(canvas: HTMLCanvasElement, model: ArmyModel, kind: FigureKind, color: string, anim: AnimName): Promise<Viewer> {
    const [st, gltf] = await Promise.all([studio(), loadModel(model.units[kind]!)]);
    const THREE: Three = st.THREE;
    const inst = await instance(gltf, model.tint);
    inst.setColor(color);
    const scene = new THREE.Scene();
    st.light(scene);
    const pivot = new THREE.Group();
    pivot.add(inst.root);
    scene.add(pivot);
    const box = new THREE.Box3().setFromObject(inst.root);
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const ground = new THREE.Mesh(new THREE.CircleGeometry(Math.hypot(box.max.x - box.min.x, box.max.z - box.min.z) * 0.42, 48),
      new THREE.MeshStandardMaterial({ color: 0xd9ceb2, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.005;
    scene.add(ground);
    // Frame the model's bounding sphere, seen from a little above.
    const fov = 30;
    const camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
    const dist = sphere.radius / Math.sin((fov * Math.PI) / 360) * 0.92;
    const pitch = (22 * Math.PI) / 180;
    camera.position.set(0, sphere.center.y + dist * Math.sin(pitch), dist * Math.cos(pitch));
    camera.lookAt(0, sphere.center.y * 0.9, 0);
    const v = new Viewer(canvas, scene, camera, pivot, inst);
    for (const clip of gltf.animations) v.clips.set(clip.name, inst.mixer.clipAction(clip));
    v.play(anim);
    return v;
  }

  play(anim: AnimName) {
    for (const a of this.clips.values()) a.stop();
    this.clips.get(anim)?.reset().play();
  }

  setColor(color: string) {
    this.inst.setColor(color);
  }

  render(st: { THREE: Three; renderer: import('three').WebGLRenderer }) {
    if (this.disposed) return;
    const now = performance.now();
    const dt = (now - this.clock) / 1000;
    this.clock = now;
    if (this.spin && this.drag === null) this.yaw += dt * 0.35;
    this.pivot.rotation.y = this.yaw;
    this.inst.mixer.update(dt);
    const { width, height } = this.canvas;
    st.renderer.setPixelRatio(1);
    st.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    st.renderer.render(this.scene, this.camera);
    const ctx = this.canvas.getContext('2d')!;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(st.renderer.domElement, 0, 0);
  }

  private onDown = (e: PointerEvent) => { this.drag = e.clientX; this.spin = false; this.canvas.setPointerCapture?.(e.pointerId); };
  private onMove = (e: PointerEvent) => {
    if (this.drag === null) return;
    this.yaw += (e.clientX - this.drag) * 0.012;
    this.drag = e.clientX;
  };
  private onUp = () => { this.drag = null; };

  dispose() {
    this.disposed = true;
    this.canvas.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.inst.mixer.stopAllAction();
    this.inst.dispose();
  }
}

let drawing = false;

async function drawViewers(viewers: Viewer[]) {
  if (drawing || !viewers.length) return;
  drawing = true;
  try {
    const st = await studio();
    for (const v of viewers) v.render(st);
  } finally {
    drawing = false;
  }
}
