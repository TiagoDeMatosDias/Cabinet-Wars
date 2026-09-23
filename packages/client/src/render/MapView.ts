import { Application, BlurFilter, Container, Graphics, Sprite, Text, Texture, type FederatedPointerEvent } from 'pixi.js';
import { Delaunay } from 'd3-delaunay';
import { Viewport } from 'pixi-viewport';
import type { Army, Edge, MapNode, Nation } from '@krieg/engine';
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
}

export interface MapClick {
  x: number;
  y: number;
  node: string | null;
  army: string | null;
  shift: boolean;
}

interface Hitbox { id: string; x: number; y: number; w: number; h: number }

/** Pan/zoom map with roads, nodes, highlights and 3D-looking army miniatures over the background. */
export class MapView {
  private app = new Application();
  private viewport!: Viewport;
  private edgeLayer = new Graphics();
  private fogLayer = new Container();
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
  private scene: MapScene | null = null;
  private hoveredArmy: string | null = null;
  private box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  private suppressClick = false;
  private theme: Theme = currentTheme();
  onClick: ((c: MapClick) => void) | null = null;
  onHover: ((node: string | null) => void) | null = null;
  onBoxSelect: ((armies: string[]) => void) | null = null;
  /** Right click on the map (the browser menu is suppressed). */
  onRightClick: ((c: MapClick) => void) | null = null;
  private hovered: string | null = null;
  /** Size of the map in world pixels (the background image size). */
  worldSize = { width: 3840, height: 3024 };

  static async create(host: HTMLElement, background: Blob | null, size?: { width: number; height: number }): Promise<MapView> {
    const view = new MapView();
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
    this.viewport = new Viewport({
      screenWidth: host.clientWidth,
      screenHeight: host.clientHeight,
      worldWidth: world.width,
      worldHeight: world.height,
      events: this.app.renderer.events,
    });
    this.worldSize = world;
    this.viewport.drag().pinch().wheel().decelerate().clampZoom({ minScale: 0.1, maxScale: 4 });
    this.app.stage.addChild(this.viewport);
    if (bg) this.viewport.addChild(bg);
    else this.viewport.addChild(new Graphics().rect(0, 0, world.width, world.height).fill(hex(t.map.canvas.blank)).stroke({ width: 4, color: hex(t.map.canvas.blankBorder) }));
    this.viewport.addChild(this.edgeLayer, this.fogLayer, this.highlightLayer, this.arrowLayer, this.nodeLayer, this.armyLayer, this.boxLayer);
    this.viewport.fit(true, world.width, world.height);
    this.viewport.moveCenter(world.width / 2, world.height / 2);
    this.app.renderer.on('resize', (w: number, h: number) => this.viewport.resize(w, h));

    this.viewport.on('clicked', (e) => {
      // A shift+drag that drew a real box is a selection, not a click.
      if (this.suppressClick || (this.box && this.boxIsBig())) return;
      // Only the left button selects; the right button is handled by onRightClick.
      if ((e.event as FederatedPointerEvent).button !== 0) return;
      const { x, y } = e.world;
      const shift = Boolean((e.event as FederatedPointerEvent).shiftKey || (e.event as FederatedPointerEvent).ctrlKey || (e.event as FederatedPointerEvent).metaKey);
      // Inside a town circle the node wins; the army piece stands above it.
      const onCircle = this.nodeAt(x, y, this.theme.map.node.radius);
      this.onClick?.({ x, y, node: onCircle ?? this.nodeAt(x, y), army: onCircle ? null : this.armyAt(x, y), shift });
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
      this.onRightClick?.({ x: p.x, y: p.y, node: this.nodeAt(p.x, p.y), army: this.armyAt(p.x, p.y), shift: e.shiftKey });
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
    if (this.scene) this.render(this.scene);
  }

  focus(x: number, y: number) {
    this.viewport.animate({ position: { x, y }, time: this.theme.motion.map });
  }

  /** Zoom to the bounding box of the given points. */
  fitTo(points: { x: number; y: number }[], pad = 150) {
    if (!points.length) return;
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
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
    const p = this.viewport.toScreen(x, y);
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

  render(scene: MapScene) {
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
    for (const id of scene.here ?? []) {
      const n = nodes.get(id);
      if (!n) continue;
      hl.circle(n.x, n.y, R + 8).stroke({ width: 6, color: hex(m.highlight.here) });
      hl.circle(n.x, n.y, R + 12).stroke({ width: 2, color: hex(m.highlight.casing) });
    }

    // Planned moves.
    this.arrowLayer.removeChildren().forEach((c) => c.destroy());
    for (const arrow of scene.arrows ?? []) this.drawArrow(arrow, nodes);

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
        const x = n.x + R - 4;
        const y = n.y - R - s + 2;
        // Victory points: an icon seal plus the number (no text in any language).
        const num = new Text({ text: String(n.vp), style: { fontFamily: t.type.family.numeric, fontSize: m.vp.size - 4, fill: hex(m.vp.text), fontWeight: '700' } });
        const w = s + num.width + 6;
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
  private drawFog(scene: MapScene) {
    this.fogLayer.removeChildren().forEach((c) => c.destroy());
    if (!scene.visible || !scene.nodes.length) return;
    const { width, height } = this.worldSize;
    const key = `${width}x${height}|${scene.nodes.map((n) => `${n.id}:${n.x},${n.y}`).join('|')}`;
    if (key !== this.cellsKey) {
      const { cells, wild } = fogCells(scene.nodes, width, height);
      this.cells = cells;
      this.wildCells = wild;
      this.cellsKey = key;
    }
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
    const nodes = new Map(scene.nodes.map((n) => [n.id, n]));
    const pieces: { army: Army; node: string; ghost: boolean }[] = [
      ...scene.armies.map((army) => ({ army, node: army.node, ghost: false })),
      ...(scene.ghosts ?? []).map((g) => ({ army: g.army, node: g.node, ghost: true })),
    ];
    const perNode = new Map<string, typeof pieces>();
    for (const p of pieces) perNode.set(p.node, [...(perNode.get(p.node) ?? []), p]);
    // Draw back to front so lower pieces overlap higher ones.
    const placed: { p: (typeof pieces)[number]; x: number; y: number }[] = [];
    for (const [nodeId, list] of perNode) {
      const n = nodes.get(nodeId);
      if (!n) continue;
      const count = list.length;
      list.forEach((p, i) => {
        let [ox, oy] = [0, 0];
        if (count > 1 && count <= 3) ox = (i - (count - 1) / 2) * 50;
        else if (count > 3) {
          const ang = (i / count) * Math.PI * 2 - Math.PI / 2;
          [ox, oy] = [Math.cos(ang) * 46, Math.sin(ang) * 30];
        }
        placed.push({ p, x: n.x + ox, y: n.y - this.theme.map.node.radius * 0.5 + oy });
      });
    }
    placed.sort((a, b) => a.y - b.y);
    for (const { p, x, y } of placed) this.drawArmy(p.army, x, y, p.ghost, scene);
    this.armyHitboxes.reverse(); // topmost first
  }

  /** A miniature: ground shadow, a stack of lit blocks in the nation color, and a banner with the emblem glyph. */
  private drawArmy(army: Army, x: number, y: number, ghost: boolean, scene: MapScene) {
    const t = this.theme;
    const nation = scene.nations.find((n) => n.id === army.nation);
    const base = hex(nation?.color ?? '#888888');
    const shade = (c: number, f: number) => {
      const [r, g, b] = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
      const mix = (v: number) => (f < 1 ? v * f : v + (255 - v) * (f - 1));
      return (Math.round(mix(r)) << 16) | (Math.round(mix(g)) << 8) | Math.round(mix(b));
    };
    const outline = hex(t.map.node.outline);
    const selected = !ghost && scene.selectedArmies?.has(army.id);
    const hovered = !ghost && this.hoveredArmy === army.id;
    const lift = hovered ? 4 : selected ? 2 : 0;
    const combat = army.units.filter((u) => u.type !== 'supply').length;
    const supply = army.units.length - combat;
    const blocks = Math.max(1, Math.min(t.army.maxBlocks, Math.ceil(combat / t.army.blockPerUnits)));
    const c = new Container();
    c.alpha = ghost ? t.army.ghostAlpha : 1;
    const g = new Graphics();
    const w = 34;
    const dp = 12;
    const bh = 8;
    const by = y - lift;
    g.ellipse(x + 4, y + 4, w * 0.85, 9).fill({ color: hex(t.army.shadow.color), alpha: alphaOf(t.army.shadow.color) });
    if (selected) {
      g.ellipse(x + 4, y + 4, w + 6, 14).stroke({ width: 4, color: hex(t.map.selection.color) === outline ? hex(t.color.surface.raised) : hex(t.map.selection.color) });
      g.ellipse(x + 4, y + 4, w + 9, 17).stroke({ width: 2, color: outline });
    }
    const x0 = x - w / 2;
    for (let i = 0; i < blocks; i++) {
      const yb = by - i * bh;
      g.poly([x0, yb, x0 + w, yb, x0 + w, yb - bh, x0, yb - bh]).fill(shade(base, 0.85)).stroke({ width: 1.2, color: outline });
      g.poly([x0 + w, yb, x0 + w + dp, yb - dp / 2, x0 + w + dp, yb - dp / 2 - bh, x0 + w, yb - bh]).fill(shade(base, 0.62)).stroke({ width: 1.2, color: outline });
    }
    const yt = by - blocks * bh;
    g.poly([x0, yt, x0 + w, yt, x0 + w + dp, yt - dp / 2, x0 + dp, yt - dp / 2]).fill(shade(base, hovered ? 1.45 : 1.28)).stroke({ width: 1.2, color: outline });
    if (supply) {
      // A supply crate on the plinth.
      const cx = x0 + 4;
      g.rect(cx, yt - 12, 11, 9).fill(hex(t.color.card.face)).stroke({ width: 1.2, color: outline });
      g.moveTo(cx, yt - 12).lineTo(cx + 11, yt - 3).stroke({ width: 1, color: outline });
    }
    let bannerTop = yt;
    if (army.generals.length) {
      const px = x + 6;
      const pole = 44 + (army.generals.length > 1 ? 6 : 0);
      g.moveTo(px, yt - 3).lineTo(px, yt - pole).stroke({ width: 2.5, color: outline });
      g.circle(px, yt - pole - 2, 3).fill(hex(t.color.state.warning)).stroke({ width: 1, color: outline });
      const fy = yt - pole + 2;
      g.poly([px, fy, px + 30, fy, px + 26, fy + 12, px + 30, fy + 24, px, fy + 24]).fill(base).stroke({ width: 1.5, color: outline });
      bannerTop = fy;
    }
    c.addChild(g);
    if (army.generals.length) {
      const glyph = scene.emblems?.get(army.nation)?.glyph ?? '';
      const txt = new Text({ text: glyph, style: { fontFamily: t.type.family.display, fontWeight: '700', fontSize: glyph.length > 1 ? 11 : 17, fill: hex(t.color.surface.raised) } });
      txt.anchor.set(0.5);
      txt.position.set(x + 20, bannerTop + 12);
      c.addChild(txt);
    }
    // Count pill under the piece.
    const label = `${combat}${supply ? `+${supply}` : ''}`;
    const pill = new Text({ text: label, style: { fontFamily: t.type.family.numeric, fontSize: 14, fontWeight: '700', fill: hex(t.color.text.primary) } });
    pill.anchor.set(0.5);
    pill.position.set(x + 4, y + 20);
    const pw = pill.width + 12;
    const bg = new Graphics().roundRect(x + 4 - pw / 2, y + 11, pw, 18, 3).fill(hex(t.color.surface.raised)).stroke({ width: 1.2, color: outline });
    c.addChild(bg, pill);
    this.armyLayer.addChild(c);
    const top = Math.min(bannerTop - 6, yt - dp);
    this.armyHitboxes.push({ id: ghost ? `ghost:${army.id}` : army.id, x: x0 - 4, y: top, w: w + dp + 22, h: y + 30 - top });
  }

  destroy() {
    this.app.destroy(true, { children: true, texture: true });
  }
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
