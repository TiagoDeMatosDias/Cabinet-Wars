import { Rectangle, Texture } from 'pixi.js';
import type { Theme } from '../theme/theme';
import { DEFAULT_RULES, type FigureKind, type FormationRules } from './formation';

/**
 * 3D army miniatures. A theme lists one glTF model per figure kind (`army.model`, see
 * themes/imperial-china/models/README.md); each model is pre-rendered with three.js into a sprite
 * sheet per nation color and animation, which the Pixi map then plays. The map keeps a single
 * renderer, and hit testing stays 2D (docs/game-screen.md §4.1).
 */

export type AnimName = 'Idle' | 'Walk' | 'Combat';
export const ANIMS: AnimName[] = ['Idle', 'Walk', 'Combat'];
export const FIGURE_KINDS: FigureKind[] = ['infantry', 'cavalry', 'artillery', 'supply', 'general'];

export interface ArmyModel extends FormationRules {
  /** Model file (URL) per figure kind. */
  units: Partial<Record<FigureKind, string>>;
  /** Name of the material recolored with the nation color. */
  tint: string;
  /** Height in map pixels (at zoom 1) of a 1.8 m figure. */
  figureHeight: number;
  /** Extra scale per figure kind (e.g. to shrink wagons). */
  scale: Partial<Record<FigureKind, number>>;
  /** Camera elevation, and how far the figures turn from facing the viewer towards the right (degrees). */
  view: { pitch: number; turn: number };
  /** Frames per second of the baked animations. */
  fps: number;
}

/** The theme's army models, or null when it has none (armies are then drawn as blocks). */
export function armyModel(theme: Theme): ArmyModel | null {
  const m = (theme.army as { model?: unknown }).model;
  if (!m || typeof m !== 'object') return null;
  const o = m as Partial<ArmyModel>;
  if (!o.units || !Object.values(o.units).some((u) => typeof u === 'string' && u)) return null;
  return {
    ...DEFAULT_RULES,
    tint: 'Nation',
    figureHeight: 30,
    fps: 12,
    ...o,
    units: o.units,
    scale: o.scale ?? {},
    view: { pitch: 30, turn: 60, ...o.view },
  };
}

// ---- three.js, loaded on demand ----------------------------------------------------------------

type ThreeModules = {
  THREE: typeof import('three');
  GLTFLoader: typeof import('three/examples/jsm/loaders/GLTFLoader.js').GLTFLoader;
  SkeletonUtils: typeof import('three/examples/jsm/utils/SkeletonUtils.js');
  RoomEnvironment: typeof import('three/examples/jsm/environments/RoomEnvironment.js').RoomEnvironment;
};
export type GLTF = import('three/examples/jsm/loaders/GLTFLoader.js').GLTF;

let modules: Promise<ThreeModules> | null = null;

export function three(): Promise<ThreeModules> {
  modules ??= Promise.all([
    import('three'),
    import('three/examples/jsm/loaders/GLTFLoader.js'),
    import('three/examples/jsm/utils/SkeletonUtils.js'),
    import('three/examples/jsm/environments/RoomEnvironment.js'),
  ]).then(([THREE, loader, SkeletonUtils, env]) => ({ THREE, GLTFLoader: loader.GLTFLoader, SkeletonUtils, RoomEnvironment: env.RoomEnvironment }));
  return modules;
}

const models = new Map<string, Promise<GLTF>>();

export function loadModel(url: string): Promise<GLTF> {
  let p = models.get(url);
  if (!p) {
    p = three().then(({ GLTFLoader }) => new GLTFLoader().loadAsync(url));
    p.catch(() => models.delete(url));
    models.set(url, p);
  }
  return p;
}

export interface Studio {
  THREE: ThreeModules['THREE'];
  renderer: import('three').WebGLRenderer;
  /** Adds the shared lighting (image-based plus a key light from the top left) to a scene. */
  light(scene: import('three').Scene): void;
}

let studioP: Promise<Studio> | null = null;

/** One offscreen WebGL renderer shared by the sprite baker and the theme gallery. */
export function studio(): Promise<Studio> {
  studioP ??= three().then(({ THREE, RoomEnvironment }) => {
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setClearColor(0x000000, 0);
    renderer.toneMapping = THREE.NeutralToneMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    return {
      THREE,
      renderer,
      light(scene) {
        scene.environment = env;
        scene.environmentIntensity = 0.55;
        scene.add(new THREE.HemisphereLight(0xfff4e0, 0x4a4035, 1.2));
        const key = new THREE.DirectionalLight(0xffffff, 2.4);
        key.position.set(-3, 5, 4);
        scene.add(key);
      },
    };
  });
  studioP.catch(() => { studioP = null; });
  return studioP;
}

/** A private copy of a model whose tint material can be recolored. */
export async function instance(gltf: GLTF, tint: string) {
  const { THREE, SkeletonUtils } = await three();
  const root = SkeletonUtils.clone(gltf.scene);
  const tinted: import('three').MeshStandardMaterial[] = [];
  root.traverse((o) => {
    const mesh = o as import('three').Mesh;
    if (!mesh.isMesh) return;
    mesh.frustumCulled = false;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const own = mats.map((m) => {
      if (m.name !== tint && (m.userData as { krieg_tint?: string }).krieg_tint !== 'nation') return m;
      const c = (m as import('three').MeshStandardMaterial).clone();
      tinted.push(c);
      return c;
    });
    mesh.material = Array.isArray(mesh.material) ? own : own[0];
  });
  return {
    root,
    mixer: new THREE.AnimationMixer(root),
    setColor(color: string) { for (const m of tinted) m.color.set(color); },
    dispose() { for (const m of tinted) m.dispose(); },
  };
}

// ---- sprite sheets -----------------------------------------------------------------------------

export interface Sheet {
  frames: Record<AnimName, Texture[]>;
  /** Where the model's origin (its feet) lies in a frame, as fractions of the frame. */
  anchor: { x: number; y: number };
  /** Frame size in map pixels at zoom 1. */
  width: number;
  height: number;
  /** Texture pixels per map pixel. */
  resolution: number;
  fps: number;
}

const RESOLUTION = 2;
const MAX_ATLAS = 4096;
const nextFrame = () => new Promise((r) => setTimeout(r, 0));

async function bake(model: ArmyModel, kind: FigureKind, color: string): Promise<Sheet> {
  const url = model.units[kind]!;
  const [st, gltf] = await Promise.all([studio(), loadModel(url)]);
  const { THREE, renderer } = st;
  const inst = await instance(gltf, model.tint);
  inst.setColor(color);
  const scene = new THREE.Scene();
  st.light(scene);
  const pivot = new THREE.Group();
  pivot.rotation.y = (model.view.turn * Math.PI) / 180;
  pivot.add(inst.root);
  scene.add(pivot);

  const pitch = (model.view.pitch * Math.PI) / 180;
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, Math.sin(pitch) * 30, Math.cos(pitch) * 30);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();

  // The clips, and the moments sampled from each.
  const clips = ANIMS.map((name) => {
    const clip = gltf.animations.find((a) => a.name === name) ?? gltf.animations[0] ?? null;
    const n = clip ? Math.max(1, Math.round(clip.duration * model.fps)) : 1;
    return { name, clip, times: Array.from({ length: n }, (_, i) => (clip ? (i / n) * clip.duration : 0)) };
  });
  const pose = (clip: import('three').AnimationClip | null, time: number) => {
    inst.mixer.stopAllAction();
    if (clip) {
      const action = inst.mixer.clipAction(clip);
      action.reset().play();
      action.time = time;
    }
    inst.mixer.update(0);
    pivot.updateMatrixWorld(true);
  };

  // Bounds in camera space over every sampled pose, so nothing is cut off mid-animation.
  const bounds = { l: Infinity, r: -Infinity, b: Infinity, t: -Infinity };
  const box = new THREE.Box3();
  const corner = new THREE.Vector3();
  for (const { clip, times } of clips) {
    for (const time of times) {
      pose(clip, time);
      inst.root.traverse((o) => {
        const mesh = o as import('three').SkinnedMesh;
        if (!mesh.isMesh) return;
        if (mesh.isSkinnedMesh) mesh.computeBoundingBox();
        else mesh.geometry.computeBoundingBox();
        box.copy((mesh.isSkinnedMesh ? mesh.boundingBox : mesh.geometry.boundingBox)!).applyMatrix4(mesh.matrixWorld);
        for (let i = 0; i < 8; i++) {
          corner.set(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z).applyMatrix4(camera.matrixWorldInverse);
          bounds.l = Math.min(bounds.l, corner.x);
          bounds.r = Math.max(bounds.r, corner.x);
          bounds.b = Math.min(bounds.b, corner.y);
          bounds.t = Math.max(bounds.t, corner.y);
        }
      });
    }
  }
  const pad = 0.05;
  Object.assign(camera, { left: bounds.l - pad, right: bounds.r + pad, bottom: bounds.b - pad, top: bounds.t + pad });
  camera.updateProjectionMatrix();

  const ppm = (model.figureHeight / 1.8) * (model.scale[kind] ?? 1);
  const width = (camera.right - camera.left) * ppm;
  const height = (camera.top - camera.bottom) * ppm;
  const fw = Math.max(1, Math.ceil(width * RESOLUTION));
  const fh = Math.max(1, Math.ceil(height * RESOLUTION));
  const total = clips.reduce((s, c) => s + c.times.length, 0);
  const cols = Math.max(1, Math.min(total, Math.floor(MAX_ATLAS / fw)));
  const atlas = document.createElement('canvas');
  atlas.width = cols * fw;
  atlas.height = Math.ceil(total / cols) * fh;
  const ctx = atlas.getContext('2d')!;
  const cells: Record<AnimName, { x: number; y: number }[]> = { Idle: [], Walk: [], Combat: [] };
  let k = 0;
  for (const { name, clip, times } of clips) {
    for (const time of times) {
      pose(clip, time);
      // The renderer is shared (theme gallery), so size it for every frame.
      renderer.setPixelRatio(1);
      renderer.setSize(fw, fh, false);
      renderer.render(scene, camera);
      const x = (k % cols) * fw;
      const y = Math.floor(k / cols) * fh;
      ctx.drawImage(renderer.domElement, x, y);
      cells[name].push({ x, y });
      if (++k % 12 === 0) await nextFrame();
    }
  }
  inst.dispose();

  const base = Texture.from(atlas);
  const frames = Object.fromEntries(ANIMS.map((a) => [a, cells[a].map(({ x, y }) => new Texture({ source: base.source, frame: new Rectangle(x, y, fw, fh) }))])) as Record<AnimName, Texture[]>;
  const origin = new THREE.Vector3(0, 0, 0).applyMatrix4(camera.matrixWorldInverse);
  return {
    frames,
    anchor: { x: (origin.x - camera.left) / (camera.right - camera.left), y: (camera.top - origin.y) / (camera.top - camera.bottom) },
    width: fw / RESOLUTION,
    height: fh / RESOLUTION,
    resolution: RESOLUTION,
    fps: model.fps,
  };
}

const sets = new Map<string, Miniatures>();
let queue: Promise<unknown> = Promise.resolve();

/** The baked miniatures of one theme's model set, shared by every view that shows them. */
export class Miniatures {
  private sheets = new Map<string, Sheet | 'pending' | 'failed'>();
  private listeners = new Set<() => void>();
  private notifyQueued = false;

  private constructor(readonly model: ArmyModel) {}

  static for(model: ArmyModel): Miniatures {
    const key = JSON.stringify(model);
    let set = sets.get(key);
    if (!set) { set = new Miniatures(model); sets.set(key, set); }
    return set;
  }

  /**
   * The sprite sheet of a figure kind in a nation color: null while it is being baked (baking
   * starts on the first request), undefined when the theme has no working model for it.
   */
  sheet(kind: FigureKind, color: string): Sheet | null | undefined {
    if (!this.model.units[kind]) return undefined;
    const key = `${kind}|${color.toLowerCase()}`;
    const s = this.sheets.get(key);
    if (s === 'failed') return undefined;
    if (s === 'pending') return null;
    if (s) return s;
    this.sheets.set(key, 'pending');
    queue = queue.then(() => bake(this.model, kind, color)).then(
      (sheet) => { this.sheets.set(key, sheet); this.notify(); },
      (err) => { console.warn(`Army model for ${kind} failed:`, err); this.sheets.set(key, 'failed'); this.notify(); },
    );
    return null;
  }

  /** Waits for a sheet (undefined when there is no working model). */
  async whenReady(kind: FigureKind, color: string): Promise<Sheet | undefined> {
    for (;;) {
      const s = this.sheet(kind, color);
      if (s !== null) return s;
      await new Promise<void>((resolve) => { const off = this.onChange(() => { off(); resolve(); }); });
    }
  }

  /** Called (at most once per frame) when sheets finish baking. */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => { this.listeners.delete(cb); };
  }

  private notify() {
    if (this.notifyQueued) return;
    this.notifyQueued = true;
    requestAnimationFrame(() => {
      this.notifyQueued = false;
      for (const l of [...this.listeners]) l();
    });
  }
}
