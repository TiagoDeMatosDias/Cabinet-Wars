import { Application, BlurFilter, Container, Graphics, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import { Delaunay } from 'd3-delaunay';
import { Viewport } from 'pixi-viewport';
import type { Army, Edge, MapNode, Nation, UnitType } from '@cabinet-wars/engine';
import { alphaOf, currentTheme, hex, type Theme } from '../theme/theme';
import type { Emblem } from '../ui/emblem';
import { iconPath } from '../ui/icons';

export type HighlightKind = 'move' | 'retreat' | 'target';

export interface MapScene {
  nodes: MapNode[];
  edges: Edge[];
  nations: Nation[];
  armies: Army[];
  emblems?: Map<string, Emblem>;
  highlights?: Map<string, HighlightKind>;
  /** Nodes marked with the "here" ring (the selected armies' nodes). */
  here?: string[];
  selectedArmies?: Set<string>;
  selectedNode?: string | null;
  /** Show node ids/names (editor). */
  labels?: boolean;
  /** Partial edge being drawn in the editor. */
  pendingEdgeFrom?: string | null;
  /** Planned positions of armies, drawn translucent. */
  ghosts?: { army: Army; node: string }[];
  /** Planned moves: dotted arrows with the step number. */
  arrows?: { path: string[]; step: number }[];
  /** Fog of war: the nodes the viewer can see into; every other node's area is fogged. Omit for no fog. */
  visible?: Set<string>;
  /** Supply overlay: the nodes the viewer's side can supply. Every other node's area gets a warning wash. */
  supplied?: Set<string>;
  /** Armies out of supply: their piece gets a warning badge. */
  unsupplied?: Set<string>;
  /** The same for planned positions (ghosts). */
  ghostsUnsupplied?: Set<string>;
  /** Reachable nodes where the selected armies would end up out of supply. */
  noSupply?: Set<string>;
}

export interface MapClick {
  x: number;
  y: number;
  node: string | null;
  army: string | null;
  shift: boolean;
}

interface Hitbox { id: string; x: number; y: number; w: number; h: number }

/** An army walking from its previous node to its new one. */
interface Tween { fromX: number; fromY: number; toX: number; toY: number; start: number; duration: number }

/** Order of the unit blocks in a Kriegsspiel piece. */
const BLOCK_ORDER: UnitType[] = ['infantry', 'cavalry', 'artillery', 'supply'];
/** Kriegsspiel piece sizes, in map pixels: unit blocks, the gap between them, and the header with the combat total. */
const BLOCK = { w: 40, h: 18, gap: 2, header: 22 };
/** Generals' stars on a piece: gilt, which reads on every nation color and on the ink header. */
const STAR_GOLD = 0xe2bd52;
/** Walking speed of armies moving between nodes, in map pixels per second. */
const WALK_SPEED = 240;

/**
 * Pan/zoom map with roads, nodes, highlights and Kriegsspiel army pieces over the background.
 *
 * Node positions are stored in background-image pixels. The map scale spreads them (and the image)
 * out while nodes, pieces and labels keep their size, so one map can carry more nodes without
 * crowding. Everything the class takes or reports (clicks, focus points) is in image pixels.
 */
export class MapView {
  private app = new Application();
  private viewport!: Viewport;
  private edgeLayer = new Graphics();
  private fogLayer = new Container();
  private supplyLayer = new Container();
  /** Wilderness cells split off oversized node areas; always fogged. */
  private wildCells: number[][] = [];
  /** Voronoi cell (flat polygon) of every node, recomputed when nodes move. */
  private cells = new Map<string, number[]>();
  private cellsKey = '';
  private highlightLayer = new Graphics();
  private arrowLayer = new Container();
  private nodeLayer = new Container();
  private armyLayer = new Container();
  private boxLayer = new Graphics();
  private armyHitboxes: Hitbox[] = [];
  /** The scene as given (image pixels), and as drawn (world pixels). */
  private input: MapScene | null = null;
  private scene: MapScene | null = null;
  private hoveredArmy: string | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private suppressClick = false;
  private theme: Theme = currentTheme();
  /** Map scale: world pixels per background-image pixel. */
  private s = 1;
  private bg: Sprite | null = null;
  private blank: Graphics | null = null;
  /** Army containers by id, moved while their army walks. */
  private pieces = new Map<string, Container>();
  private tweens = new Map<string, Tween>();
  /** Where each army was last drawn, to walk it when it changes node. */
  private lastPlace = new Map<string, { node: string; x: number; y: number }>();
  onClick: ((c: MapClick) => void) | null = null;
  onHover: ((node: string | null) => void) | null = null;
  onBoxSelect: ((armies: string[]) => void) | null = null;
  /** Right click on the map (the browser menu is suppressed). */
  onRightClick: ((c: MapClick) => void) | null = null;
  private hovered: string | null = null;
  /** Size of the map in image pixels (the background image size). */
  worldSize = { width: 3840, height: 3024 };

  /** `mapScale` is the map's scale (config `mapScale`): how far apart its nodes are drawn. */
  static async create(host: HTMLElement, background: Blob | null, size?: { width: number; height: number }, mapScale = 1): Promise<MapView> {
    const view = new MapView();
    view.s = validScale(mapScale);
    await view.init(host, background, size);
    return view;
  }

  private async init(host: HTMLElement, background: Blob | null, size?: { width: number; height: number }) {
    const t = this.theme;
    await this.app.init({ resizeTo: host, background: hex(t.map.canvas.background), antialias: true, autoDensity: true, resolution: devicePixelRatio });
    host.append(this.app.canvas);
    let world = size ?? { width: 3840, height: 3024 };
    let bg: Sprite | null = null;
    if (background) {
      const bitmap = await createImageBitmap(background);
      bg = new Sprite(Texture.from(bitmap));
      world = { width: bitmap.width, height: bitmap.height };
    }
    const s = this.s;
    this.viewport = new Viewport({
      screenWidth: host.clientWidth,
      screenHeight: host.clientHeight,
      worldWidth: world.width * s,
      worldHeight: world.height * s,
      events: this.app.renderer.events,
    });
    this.worldSize = world;
    this.viewport.drag().pinch().wheel().decelerate().clampZoom({ minScale: 0.05, maxScale: 4 });
    this.app.stage.addChild(this.viewport);
    if (bg) { bg.scale.set(s); this.bg = bg; this.viewport.addChild(bg); }
    else {
      this.blank = new Graphics().rect(0, 0, world.width, world.height).fill(hex(t.map.canvas.blank)).stroke({ width: 4 / s, color: hex(t.map.canvas.blankBorder) });
      this.blank.scale.set(s);
      this.viewport.addChild(this.blank);
    }
    this.viewport.addChild(this.supplyLayer, this.edgeLayer, this.fogLayer, this.highlightLayer, this.arrowLayer, this.nodeLayer, this.armyLayer, this.boxLayer);
    this.viewport.fit(true, world.width * s, world.height * s);
    this.viewport.moveCenter((world.width * s) / 2, (world.height * s) / 2);
    this.app.renderer.on('resize', (w: number, h: number) => this.viewport.resize(w, h));
    this.app.ticker.add(() => this.animate());

    this.viewport.on('clicked', (e) => {
      // A shift+drag that drew a real box is a selection, not a click.
      if (this.suppressClick || (this.box && this.boxIsBig())) return;
      // Only the left button selects; the right button is handled by onRightClick.
      if ((e.event as FederatedPointerEvent).button !== 0) return;
      const { x, y } = e.world;
      const s = this.s;
      const shift = Boolean((e.event as FederatedPointerEvent).shiftKey || (e.event as FederatedPointerEvent).ctrlKey || (e.event as FederatedPointerEvent).metaKey);
      // Inside a town circle the node wins; the army piece stands above it.
      const onCircle = this.nodeAt(x, y, this.theme.map.node.radius);
      this.onClick?.({ x: x / s, y: y / s, node: onCircle ?? this.nodeAt(x, y), army: onCircle ? null : this.armyAt(x, y), shift });
    });
    this.viewport.on('pointermove', (e: FederatedPointerEvent) => {
      const p = this.viewport.toWorld(e.global);
      if (this.box) {
        this.box.x1 = p.x;
        this.box.y1 = p.y;
        this.drawBox();
        return;
      }
      const n = this.nodeAt(p.x, p.y);
      if (n !== this.hovered) { this.hovered = n; this.onHover?.(n); }
      const a = this.armyAt(p.x, p.y);
      if (a !== this.hoveredArmy) {
        this.hoveredArmy = a;
        this.app.canvas.style.cursor = a || n ? 'pointer' : '';
        if (this.scene) this.renderArmies(this.scene);
      }
    });
    // Shift + drag draws a selection box instead of panning.
    this.viewport.on('pointerdown', (e: FederatedPointerEvent) => {
      if (!e.shiftKey || !this.onBoxSelect) return;
      this.viewport.plugins.pause('drag');
      const p = this.viewport.toWorld(e.global);
      this.box = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
    });
    const endBox = () => {
      if (!this.box) return;
      const { x0, y0, x1, y1 } = this.box;
      const [l, r, t2, b] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
      const big = this.boxIsBig();
      const hits = this.armyHitboxes.filter((h) => h.x + h.w / 2 >= l && h.x + h.w / 2 <= r && h.y + h.h / 2 >= t2 && h.y + h.h / 2 <= b).map((h) => h.id);
      this.boxLayer.clear();
      this.viewport.plugins.resume('drag');
      this.box = null;
      if (big) {
        this.suppressClick = true;
        setTimeout(() => { this.suppressClick = false; }, 0);
      }
      if (big) this.onBoxSelect?.(hits.filter((id) => !id.startsWith('ghost:')));
    };
    // Right click is a game command, never the browser's context menu.
    this.app.canvas.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const rect = this.app.canvas.getBoundingClientRect();
      const p = this.viewport.toWorld(e.clientX - rect.left, e.clientY - rect.top);
      this.onRightClick?.({ x: p.x / this.s, y: p.y / this.s, node: this.nodeAt(p.x, p.y), army: this.armyAt(p.x, p.y), shift: e.shiftKey });
    });
    this.viewport.on('pointerup', endBox);
    this.viewport.on('pointerupoutside', endBox);
  }

  private boxIsBig(): boolean {
    const b = this.box;
    return Boolean(b && (Math.abs(b.x1 - b.x0) > 8 || Math.abs(b.y1 - b.y0) > 8));
  }

  private drawBox() {
    const b = this.box!;
    const t = this.theme;
    this.boxLayer.clear()
      .rect(Math.min(b.x0, b.x1), Math.min(b.y0, b.y1), Math.abs(b.x1 - b.x0), Math.abs(b.y1 - b.y0))
      .fill({ color: hex(t.color.focus), alpha: 0.12 })
      .stroke({ width: 3, color: hex(t.color.focus) });
  }

  setTheme(theme: Theme) {
    this.theme = theme;
    this.app.renderer.background.color = hex(theme.map.canvas.background);
    if (this.input) this.render(this.input);
  }

  /** Changes the map scale (the editor), keeping the same spot of the map in the middle of the screen. */
  setMapScale(mapScale: number) {
    const s = validScale(mapScale);
    if (s === this.s) return;
    const centre = this.viewport.center;
    const [cx, cy] = [centre.x / this.s, centre.y / this.s];
    this.s = s;
    this.bg?.scale.set(s);
    this.blank?.scale.set(s);
    this.viewport.worldWidth = this.worldSize.width * s;
    this.viewport.worldHeight = this.worldSize.height * s;
    this.viewport.moveCenter(cx * s, cy * s);
    this.cellsKey = '';
    this.lastPlace.clear();
    if (this.input) this.render(this.input);
  }

  /** Per frame: walking armies advance towards their new node. */
  private animate() {
    const now = performance.now();
    for (const [id, tw] of this.tweens) {
      const u = Math.min(1, (now - tw.start) / tw.duration);
      const piece = this.pieces.get(id);
      if (piece && !piece.destroyed) piece.position.set((tw.fromX - tw.toX) * (1 - u), (tw.fromY - tw.toY) * (1 - u));
      if (u >= 1) this.tweens.delete(id);
    }
  }

  /** Pans to a point; `screenDy` puts it that many screen pixels above the centre (to clear a docked panel). */
  focus(x: number, y: number, screenDy = 0) {
    this.viewport.animate({ position: { x: x * this.s, y: y * this.s + screenDy / this.viewport.scale.y }, time: this.theme.motion.map });
  }

  /** Zoom to the bounding box of the given points. */
  fitTo(points: { x: number; y: number }[], pad = 150) {
    if (!points.length) return;
    const xs = points.map((p) => p.x * this.s);
    const ys = points.map((p) => p.y * this.s);
    const [x0, x1, y0, y1] = [Math.min(...xs) - pad, Math.max(...xs) + pad, Math.min(...ys) - pad, Math.max(...ys) + pad];
    this.viewport.fit(true, x1 - x0, y1 - y0);
    this.viewport.moveCenter((x0 + x1) / 2, (y0 + y1) / 2);
  }

  /** What lies under a screen position (for drag-and-drop from the DOM). */
  pick(clientX: number, clientY: number): { node: string | null; army: string | null } {
    const rect = this.app.canvas.getBoundingClientRect();
    const p = this.viewport.toWorld(clientX - rect.left, clientY - rect.top);
    // Drops (cards onto armies) prefer the army, even over its town circle.
    return { node: this.nodeAt(p.x, p.y), army: this.armyAt(p.x, p.y) };
  }

  /** Screen (client) position of a world point. */
  worldToClient(x: number, y: number): { x: number; y: number } {
    const rect = this.app.canvas.getBoundingClientRect();
    const p = this.viewport.toScreen(x * this.s, y * this.s);
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  private nodeAt(x: number, y: number, within = this.theme.map.node.radius * 1.6): string | null {
    let best: string | null = null;
    let bestD = within ** 2;
    for (const n of this.scene?.nodes ?? []) {
      const d = (n.x - x) ** 2 + (n.y - y) ** 2;
      if (d < bestD) { bestD = d; best = n.id; }
    }
    return best;
  }

  private armyAt(x: number, y: number): string | null {
    for (const b of this.armyHitboxes) if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return b.id.replace(/^ghost:/, '');
    return null;
  }

  render(input: MapScene) {
    this.input = input;
    // Nodes are drawn at their scaled positions; the rest of the scene refers to them by id.
    const s = this.s;
    const scene: MapScene = s === 1 ? input : { ...input, nodes: input.nodes.map((n) => ({ ...n, x: n.x * s, y: n.y * s })) };
    this.scene = scene;
    const t = this.theme;
    const m = t.map;
    const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
    const nations = new Map(scene.nations.map((n) => [n.id, n]));
    const color = (id: string) => hex(nations.get(id)?.color ?? '#888888');
    const R = m.node.radius;

    // Roads: casing then fill for major, dashes for minor. Trimmed at the node circles.
    const g = this.edgeLayer.clear();
    for (const e of scene.edges) {
      const a = nodes.get(e.a);
      const b = nodes.get(e.b);
      if (!a || !b) continue;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 2 * R) continue;
      const [dx, dy] = [(b.x - a.x) / len, (b.y - a.y) / len];
      const [sx, sy, ex, ey] = [a.x + dx * R, a.y + dy * R, b.x - dx * R, b.y - dy * R];
      if (e.type === 'major') {
        g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: m.road.major.casingWidth, color: hex(m.road.major.casing), alpha: 0.9 });
        g.moveTo(sx, sy).lineTo(ex, ey).stroke({ width: m.road.major.width, color: hex(m.road.major.fill) });
      } else {
        const [on, off] = m.road.minor.dash;
        for (let s = 0; s < len - 2 * R; s += on + off) {
          const s1 = Math.min(len - 2 * R, s + on);
          g.moveTo(sx + dx * s, sy + dy * s).lineTo(sx + dx * s1, sy + dy * s1);
        }
        g.stroke({ width: m.road.minor.width, color: hex(m.road.minor.color) });
      }
    }

    // Highlights: a translucent fill always framed by an ink ring, so they read on any map.
    const hl = this.highlightLayer.clear();
    for (const [id, kind] of scene.highlights ?? []) {
      const n = nodes.get(id);
      if (!n) continue;
      hl.circle(n.x, n.y, R + 11).fill({ color: hex(m.highlight[kind]), alpha: m.highlight.alpha });
      hl.circle(n.x, n.y, R + 11).stroke({ width: 3, color: hex(m.highlight.casing) });
    }
    // Destinations that would cut the army off from supply: a warning ring and badge on top of the move highlight.
    const danger = hex(this.theme.color.state.danger);
    for (const id of scene.noSupply ?? []) {
      const n = nodes.get(id);
      if (!n) continue;
      hl.circle(n.x, n.y, R + 11).stroke({ width: 4, color: danger });
      hl.circle(n.x, n.y, R + 14).stroke({ width: 1.5, color: hex(m.highlight.casing) });
    }
    for (const id of scene.here ?? []) {
      const n = nodes.get(id);
      if (!n) continue;
      hl.circle(n.x, n.y, R + 8).stroke({ width: 6, color: hex(m.highlight.here) });
      hl.circle(n.x, n.y, R + 12).stroke({ width: 2, color: hex(m.highlight.casing) });
    }

    // Planned moves.
    this.arrowLayer.removeChildren().forEach((c) => c.destroy());
    for (const arrow of scene.arrows ?? []) this.drawArrow(arrow, nodes);

    this.drawSupply(scene);
    this.drawFog(scene);
    this.nodeLayer.removeChildren().forEach((c) => c.destroy());
    const fogged = (id: string) => Boolean(scene.visible && !scene.visible.has(id));
    for (const n of scene.nodes) {
      // Each node's pieces share one container, dimmed when the node lies in the fog.
      const group = new Container();
      group.alpha = fogged(n.id) ? m.fog.nodeAlpha : 1;
      this.nodeLayer.addChild(group);
      const c = new Graphics();
      if (scene.selectedNode === n.id || scene.pendingEdgeFrom === n.id) {
        c.circle(n.x, n.y, R + 8).stroke({ width: 4, color: hex(m.selection.color) });
      }
      c.circle(n.x, n.y, R).fill(color(n.controller)).stroke({ width: m.node.outlineWidth, color: hex(m.node.outline) });
      c.circle(n.x, n.y, R - m.node.ownerRingWidth / 2 - 1).stroke({ width: m.node.ownerRingWidth / 3, color: color(n.owner) === color(n.controller) ? hex(t.color.surface.raised) : color(n.owner) });
      if (n.controller !== n.owner) c.circle(n.x, n.y, R * m.node.occupiedDotScale).fill(color(n.owner)).stroke({ width: 1.5, color: hex(m.node.outline) });
      group.addChild(c);
      if (n.vp > 0) {
        const s = m.vp.size + 6;
        const y = n.y - R - s + 2;
        // Victory points: an icon seal plus the number (no text in any language).
        const num = new Text({ text: String(n.vp), style: { fontFamily: t.type.family.numeric, fontSize: m.vp.size - 4, fill: hex(m.vp.text), fontWeight: '700' } });
        const w = s + num.width + 6;
        // Upper left: the upper right is where the army pieces stand.
        const x = n.x - R + 4 - w;
        group.addChild(new Graphics().rect(x, y, w, s).fill(hex(m.vp.fill)).stroke({ width: 1.5, color: hex(m.node.outline) }));
        group.addChild(this.icon(t.icons.vp, s - 6, m.vp.text, x + 3, y + 3));
        num.anchor.set(0, 0.5);
        num.position.set(x + s, y + s / 2);
        group.addChild(num);
      }
      if (scene.labels || n.name) {
        const label = scene.labels ? `${n.name || n.id}` : n.name;
        const txt = new Text({
          text: label,
          style: { fontFamily: t.type.family.map, fontSize: m.label.size, fill: hex(m.label.fill), stroke: { color: hex(m.label.halo), width: m.label.haloWidth * 2, join: 'round' } },
        });
        txt.anchor.set(0.5, 0);
        txt.position.set(n.x, n.y + R + 3);
        group.addChild(txt);
      }
    }
    for (const id of scene.noSupply ?? []) {
      const n = nodes.get(id);
      if (n) this.supplyBadge(this.nodeLayer, n.x - R - 4, n.y + R - 2);
    }
    this.renderArmies(scene);
  }

  /** A theme icon ("icon:…", "path:…" or text) drawn at (x, y) with the given size. */
  private icon(value: string, size: number, color: string, x: number, y: number): Container {
    const d = iconPath(value);
    if (d) {
      const g = new Graphics().svg(`<svg viewBox="0 0 24 24"><path fill="${color.slice(0, 7)}" fill-rule="evenodd" d="${d.replace(/[^MmLlHhVvCcSsQqTtAaZz0-9.,\s-]/g, '')}"/></svg>`);
      g.scale.set(size / 24);
      g.position.set(x, y);
      return g;
    }
    const txt = new Text({ text: value, style: { fontFamily: this.theme.type.family.map, fontSize: size, fill: hex(color), fontWeight: '700' } });
    txt.position.set(x, y - size * 0.15);
    return txt;
  }

  /**
   * Fog of war: every node owns its Voronoi area of the map. Areas of nodes the viewer can't see
   * get a soft wash plus hatching; the map, roads and nodes stay visible underneath.
   */
  /** The Voronoi area of every node (world pixels), recomputed only when nodes move. */
  private ensureCells(scene: MapScene) {
    const [width, height] = [this.worldSize.width * this.s, this.worldSize.height * this.s];
    const key = `${width}x${height}|${scene.nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|')}`;
    if (key === this.cellsKey) return;
    const { cells, wild } = fogCells(scene.nodes, width, height);
    this.cells = cells;
    this.wildCells = wild;
    this.cellsKey = key;
  }

  /**
   * Supply overlay: the areas of nodes the viewer's side cannot supply get a wash in the danger
   * color with a dashed edge, so the reach of supply reads as a region on the map.
   */
  private drawSupply(scene: MapScene) {
    this.supplyLayer.removeChildren().forEach((c) => c.destroy());
    if (!scene.supplied || !scene.nodes.length) return;
    this.ensureCells(scene);
    const danger = hex(this.theme.color.state.danger);
    const wash = new Graphics();
    for (const n of scene.nodes) {
      if (scene.supplied.has(n.id)) continue;
      const poly = this.cells.get(n.id);
      if (poly && poly.length >= 6) wash.poly(poly).fill({ color: danger, alpha: 0.34 });
    }
    wash.filters = [new BlurFilter({ strength: 6, quality: 2 })];
    this.supplyLayer.addChild(wash);
  }

  private drawFog(scene: MapScene) {
    this.fogLayer.removeChildren().forEach((c) => c.destroy());
    if (!scene.visible || !scene.nodes.length) return;
    const [width, height] = [this.worldSize.width * this.s, this.worldSize.height * this.s];
    this.ensureCells(scene);
    const hidden = [...scene.nodes.filter((n) => !scene.visible!.has(n.id)).map((n) => this.cells.get(n.id)), ...this.wildCells]
      .filter((c): c is number[] => !!c && c.length >= 6);
    if (!hidden.length) return;
    const f = this.theme.map.fog;
    const wash = new Graphics();
    const mask = new Graphics();
    for (const poly of hidden) {
      wash.poly(poly).fill({ color: hex(f.color), alpha: f.alpha });
      mask.poly(poly).fill(0xffffff);
    }
    wash.filters = [new BlurFilter({ strength: f.blur, quality: 3 })];
    // Diagonal hatching, clipped to the fogged cells, marks the area clearly.
    const hatch = new Graphics();
    const step = f.hatchSpacing;
    for (let c = -height; c < width; c += step) hatch.moveTo(c, 0).lineTo(c + height, height);
    hatch.stroke({ width: 2, color: hex(f.hatch), alpha: f.hatchAlpha });
    hatch.mask = mask;
    this.fogLayer.addChild(wash, hatch, mask);
  }

  private drawArrow(arrow: { path: string[]; step: number }, nodes: Map<string, MapNode>) {
    const t = this.theme;
    const pts = arrow.path.map((id) => nodes.get(id)).filter(Boolean) as MapNode[];
    if (pts.length < 2) return;
    const g = new Graphics();
    const color = hex(t.map.order.arrow);
    const R = t.map.node.radius;
    for (let i = 0; i < pts.length - 1; i++) {
      const [a, b] = [pts[i], pts[i + 1]];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const [dx, dy] = [(b.x - a.x) / len, (b.y - a.y) / len];
      const end = i === pts.length - 2 ? len - R - 10 : len;
      for (let s = i === 0 ? R + 4 : 0; s < end; s += 16) {
        const s1 = Math.min(end, s + 9);
        g.moveTo(a.x + dx * s, a.y + dy * s).lineTo(a.x + dx * s1, a.y + dy * s1);
      }
    }
    g.stroke({ width: t.map.order.arrowWidth, color });
    const [a, b] = [pts[pts.length - 2], pts[pts.length - 1]];
    const ang = Math.atan2(b.y - a.y, b.x - a.x);
    const tip = { x: b.x - Math.cos(ang) * (R + 4), y: b.y - Math.sin(ang) * (R + 4) };
    g.poly([
      tip.x, tip.y,
      tip.x - Math.cos(ang - 0.45) * 18, tip.y - Math.sin(ang - 0.45) * 18,
      tip.x - Math.cos(ang + 0.45) * 18, tip.y - Math.sin(ang + 0.45) * 18,
    ]).fill(color);
    const mid = pts[Math.floor((pts.length - 1) / 2)];
    const nxt = pts[Math.floor((pts.length - 1) / 2) + 1];
    const [mx, my] = [(mid.x + nxt.x) / 2, (mid.y + nxt.y) / 2];
    g.circle(mx, my, 13).fill(hex(t.map.order.badge)).stroke({ width: 2, color });
    this.arrowLayer.addChild(g);
    const txt = new Text({ text: String(arrow.step), style: { fontFamily: t.type.family.numeric, fontSize: 15, fontWeight: '700', fill: color } });
    txt.anchor.set(0.5);
    txt.position.set(mx, my);
    this.arrowLayer.addChild(txt);
  }

  private renderArmies(scene: MapScene) {
    this.armyLayer.removeChildren().forEach((c) => c.destroy());
    this.armyHitboxes = [];
    this.pieces.clear();
    const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
    const R = this.theme.map.node.radius;
    const pieces: { army: Army; node: string; ghost: boolean }[] = [
      ...scene.armies.map((army) => ({ army, node: army.node, ghost: false })),
      ...(scene.ghosts ?? []).map((g) => ({ army: g.army, node: g.node, ghost: true })),
    ];
    const perNode = new Map<string, typeof pieces>();
    for (const p of pieces) perNode.set(p.node, [...(perNode.get(p.node) ?? []), p]);
    // Pieces stand at the node's upper right, side by side, clear of the town circle and its label.
    const placed: { p: (typeof pieces)[number]; x: number; y: number }[] = [];
    for (const [nodeId, list] of perNode) {
      const n = nodes.get(nodeId);
      if (!n) continue;
      let x = n.x + R * 0.75;
      for (const p of list) {
        placed.push({ p, x, y: n.y - R * 0.45 });
        x += pieceWidth(p.army) + 6;
      }
    }
    // An army that changed node walks there from where it was drawn last.
    const now = performance.now();
    for (const { p, x, y } of placed) {
      if (p.ghost) continue;
      const last = this.lastPlace.get(p.army.id);
      if (last && last.node !== p.node && (last.x !== x || last.y !== y)) {
        const dist = Math.hypot(x - last.x, y - last.y);
        const tw = this.tweens.get(p.army.id);
        const from = tw ? this.tweenPosition(tw, now) : last;
        this.tweens.set(p.army.id, { fromX: from.x, fromY: from.y, toX: x, toY: y, start: now, duration: Math.min(2200, Math.max(500, (dist / WALK_SPEED) * 1000)) });
      }
      this.lastPlace.set(p.army.id, { node: p.node, x, y });
    }
    for (const { p, x, y } of placed) {
      const piece = this.drawPiece(p.army, x, y, p.ghost, scene);
      if (!p.ghost) {
        this.pieces.set(p.army.id, piece);
        if (this.tweens.has(p.army.id)) this.animate();
      }
    }
    this.armyHitboxes.reverse(); // topmost first
  }

  private tweenPosition(tw: Tween, now: number) {
    const u = Math.min(1, (now - tw.start) / tw.duration);
    return { x: tw.fromX + (tw.toX - tw.fromX) * u, y: tw.fromY + (tw.toY - tw.fromY) * u };
  }

  /**
   * An army as a Kriegsspiel piece, standing on (x, y) with its lower left corner. A header shows
   * the nation's emblem glyph, the total of combat units in large figures and a star per general.
   * Below it, one block per unit type in the nation color, marked with its military map symbol
   * and count: infantry ☒, cavalry ◪, artillery ●, supply ▭.
   */
  private drawPiece(army: Army, x: number, y: number, ghost: boolean, scene: MapScene): Container {
    const t = this.theme;
    const nation = scene.nations.find((n) => n.id === army.nation);
    const base = hex(nation?.color ?? '#888888');
    const ink = hex(t.map.node.outline);
    const paper = hex(t.color.surface.raised);
    const selected = !ghost && scene.selectedArmies?.has(army.id);
    const hovered = !ghost && this.hoveredArmy === army.id;
    const lift = hovered ? 3 : 0;
    const counts = unitCounts(army);
    const types = BLOCK_ORDER.filter((ty) => counts[ty] > 0);
    const cols = types.length > 1 ? 2 : 1;
    const rows = Math.ceil(types.length / cols);
    const w = pieceWidth(army);
    // Blocks share the piece's width, so a lone block is as wide as the header.
    const bw = (w - (cols - 1) * BLOCK.gap) / cols;
    const h = BLOCK.header + rows * (BLOCK.h + BLOCK.gap);
    const [x0, y0] = [x, y - h - lift];

    const c = new Container();
    c.alpha = ghost ? t.army.ghostAlpha : 1;
    const g = new Graphics();
    // Ground shadow, then the selection frame.
    g.rect(x0 + 2, y0 + 3 + lift, w, h).fill({ color: hex(t.army.shadow.color), alpha: alphaOf(t.army.shadow.color) });
    if (selected) {
      const sel = hex(t.map.selection.color) === ink ? paper : hex(t.map.selection.color);
      g.roundRect(x0 - 5, y0 - 5, w + 10, h + 10, 4).stroke({ width: 4, color: sel });
      g.roundRect(x0 - 8, y0 - 8, w + 16, h + 16, 6).stroke({ width: 1.5, color: ink });
    }
    // Header: emblem square, then the combat total on ink.
    g.rect(x0, y0, w, BLOCK.header).fill(hovered ? shade(ink, 1.35) : ink);
    g.rect(x0 + 2, y0 + 2, BLOCK.header - 4, BLOCK.header - 4).fill(base);
    types.forEach((ty, i) => {
      const bx = x0 + (i % cols) * (bw + BLOCK.gap);
      const by = y0 + BLOCK.header + BLOCK.gap + Math.floor(i / cols) * (BLOCK.h + BLOCK.gap);
      g.rect(bx, by, bw, BLOCK.h).fill(hovered ? shade(base, 1.2) : base).stroke({ width: 1.2, color: ink });
      g.rect(bx + 0.6, by + BLOCK.h - 3, bw - 1.2, 2.4).fill({ color: 0x000000, alpha: 0.25 });
      unitMark(g, ty, bx + 3, by + 3.5, 13, 9, paper);
      const num = new Text({ text: String(counts[ty]), style: { fontFamily: t.type.family.numeric, fontSize: 13, fontWeight: '700', fill: paper } });
      num.anchor.set(1, 0.5);
      num.position.set(bx + bw - 3, by + BLOCK.h / 2 - 0.5);
      c.addChild(num);
    });
    g.rect(x0, y0, w, h).stroke({ width: 1.4, color: ink });
    c.addChildAt(g, 0);

    const glyph = scene.emblems?.get(army.nation)?.glyph ?? '';
    if (glyph) {
      const gl = new Text({ text: glyph, style: { fontFamily: t.type.family.display, fontWeight: '700', fontSize: glyph.length > 1 ? 8 : 12, fill: paper } });
      gl.anchor.set(0.5);
      gl.position.set(x0 + BLOCK.header / 2, y0 + BLOCK.header / 2);
      c.addChild(gl);
    }
    const combat = counts.infantry + counts.cavalry + counts.artillery;
    const total = new Text({ text: String(combat), style: { fontFamily: t.type.family.numeric, fontSize: 17, fontWeight: '700', fill: paper } });
    total.anchor.set(0, 0.5);
    total.position.set(x0 + BLOCK.header + 3, y0 + BLOCK.header / 2);
    c.addChild(total);
    // Generals: gold stars at the right of the header.
    for (let i = 0; i < Math.min(army.generals.length, 3); i++) {
      const star = new Graphics().star(x0 + w - 8 - i * 12, y0 + BLOCK.header / 2, 5, 5.5, 2.4).fill(STAR_GOLD).stroke({ width: 0.8, color: ink });
      c.addChild(star);
    }
    // Out of supply: it will lose a unit at the end of its turn.
    if ((ghost ? scene.ghostsUnsupplied : scene.unsupplied)?.has(army.id)) this.supplyBadge(c, x0 + w + 4, y0 + 2);
    this.armyLayer.addChild(c);
    this.armyHitboxes.push({ id: ghost ? `ghost:${army.id}` : army.id, x: x0 - 3, y: y0 - 3, w: w + 6, h: h + 6 + lift });
    return c;
  }

  /** The "out of supply" mark: a warning disc with an exclamation mark, on the danger color. */
  private supplyBadge(c: Container, x: number, y: number) {
    const t = this.theme;
    c.addChild(new Graphics().circle(x, y, 9).fill(hex(t.color.state.danger)).stroke({ width: 1.5, color: hex(t.map.node.outline) }));
    const mark = new Text({ text: '!', style: { fontFamily: t.type.family.numeric, fontWeight: '900', fontSize: 14, fill: hex(t.color.surface.raised) } });
    mark.anchor.set(0.5);
    mark.position.set(x, y);
    c.addChild(mark);
  }

  destroy() {
    this.app.destroy(true, { children: true, texture: true });
  }
}

/** A map scale that makes sense: 1 when unset or invalid, else between 0.25 and 8. */
function validScale(x: number): number {
  return Number.isFinite(x) && x > 0 ? Math.min(8, Math.max(0.25, x)) : 1;
}

function unitCounts(army: Army): Record<UnitType, number> {
  const out: Record<UnitType, number> = { infantry: 0, cavalry: 0, artillery: 0, supply: 0 };
  for (const u of army.units) out[u.type]++;
  return out;
}

/** Width of an army's piece: one or two columns of unit blocks, never narrower than its header. */
function pieceWidth(army: Army): number {
  const types = new Set(army.units.map((u) => u.type)).size;
  const cols = types > 1 ? 2 : 1;
  const stars = Math.min(army.generals.length, 3);
  return Math.max(cols * BLOCK.w + (cols - 1) * BLOCK.gap, BLOCK.header + 28 + stars * 12);
}

/** Lightens (f > 1) or darkens (f < 1) a color. */
function shade(c: number, f: number): number {
  const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  const mix = (v: number) => Math.round(f < 1 ? v * f : v + (255 - v) * (f - 1));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

/**
 * A unit type's military map symbol in a frame (x, y, w, h): a cross for infantry, a diagonal for
 * cavalry, a dot for artillery and a bar low in the frame for supply.
 */
export function unitMark(g: Graphics, type: UnitType, x: number, y: number, w: number, h: number, color: number) {
  g.rect(x, y, w, h).stroke({ width: 1.2, color });
  if (type === 'infantry') g.moveTo(x, y).lineTo(x + w, y + h).moveTo(x + w, y).lineTo(x, y + h).stroke({ width: 1.2, color });
  else if (type === 'cavalry') g.moveTo(x, y + h).lineTo(x + w, y).stroke({ width: 1.2, color });
  else if (type === 'artillery') g.circle(x + w / 2, y + h / 2, h * 0.24).fill(color);
  else g.moveTo(x, y + h * 0.68).lineTo(x + w, y + h * 0.68).stroke({ width: 1.2, color });
}

/** An area bigger than this many times the mean is split, so empty map edges are not left clear. */
const FOG_SPLIT_FACTOR = 3;

function polygonArea(poly: number[]): number {
  let a = 0;
  for (let i = 0; i < poly.length; i += 2) {
    const j = (i + 2) % poly.length;
    a += poly[i] * poly[j + 1] - poly[j] * poly[i + 1];
  }
  return Math.abs(a) / 2;
}

/**
 * Voronoi areas for the fog of war. A node area larger than FOG_SPLIT_FACTOR × the mean is split
 * by adding a seed at its far corner: the node keeps the part nearest to it, and the far part
 * becomes wilderness that belongs to no node (and so is always fogged). Repeats until no node
 * area is oversized.
 */
function fogCells(nodes: { id: string; x: number; y: number }[], width: number, height: number): { cells: Map<string, number[]>; wild: number[][] } {
  const limit = (FOG_SPLIT_FACTOR * width * height) / nodes.length;
  const seeds = nodes.map((n) => [n.x, n.y] as [number, number]);
  let voronoi = Delaunay.from(seeds).voronoi([0, 0, width, height]);
  for (let pass = 0; pass < 12; pass++) {
    let added = false;
    nodes.forEach((n, i) => {
      const poly = (voronoi.cellPolygon(i) ?? []).flat();
      if (poly.length < 6 || polygonArea(poly) <= limit) return;
      // Seed the wilderness at the cell corner farthest from the node, nudged inside the map.
      let far = [poly[0], poly[1]];
      for (let k = 0; k < poly.length; k += 2) {
        if (Math.hypot(poly[k] - n.x, poly[k + 1] - n.y) > Math.hypot(far[0] - n.x, far[1] - n.y)) far = [poly[k], poly[k + 1]];
      }
      seeds.push([n.x + (far[0] - n.x) * 0.9, n.y + (far[1] - n.y) * 0.9]);
      added = true;
    });
    if (!added) break;
    voronoi = Delaunay.from(seeds).voronoi([0, 0, width, height]);
  }
  const cells = new Map(nodes.map((n, i) => [n.id, (voronoi.cellPolygon(i) ?? []).flat()]));
  const wild: number[][] = [];
  for (let i = nodes.length; i < seeds.length; i++) wild.push((voronoi.cellPolygon(i) ?? []).flat());
  return { cells, wild };
}
