import type {
  Army, BattleChoice, BattleRole, GameState, NationId, NodeId, PlacedCard, Prompt, Team, Unit, UnitType,
} from './types';
import { combatUnits, isCombat, nation, sideOf } from './graph';
import { reachable } from './movement';
import { suppliedNodes } from './supply';
import { willingness, PROTECTION_RANGE } from './control';
import { musterBlocked, musterNodes } from './decks';
import { battleArmy, other, roleOf, ROLL_CARDS, scoreDuels, TYPE_ADVANTAGE } from './battle';
import type { Intent } from './reducer';

/**
 * A simple computer player. It decides one intent at a time from a nation's own (fog-of-war
 * filtered) view, so it knows no more than a human in that seat would.
 *
 * - **Offensive** nations go after enemy victory points: they march on the nearest valuable enemy
 *   towns (most of all those of nations close to being knocked out), attack enemy armies they
 *   outnumber, and leave supply units behind as a chain.
 * - **Defensive** nations keep their armies within protection range of their own threatened
 *   victory points, free occupied towns, fight only when the odds are good and otherwise stand in
 *   the way to delay the enemy.
 */
export type AiRole = 'offensive' | 'defensive';

/** Defenders play defensively; attackers (and everyone in a free-for-all) play offensively. */
export function aiRole(state: GameState, nationId: NationId): AiRole {
  return state.rules.mode === 'sides' && nation(state, nationId).side === 'defender' ? 'defensive' : 'offensive';
}

/** What the AI remembers during one nation's turn, so each army gets one order. */
export interface AiMemory {
  turn: number;
  /** Armies that have had their order (or chose to stay) this turn. */
  handled: Set<string>;
  /** Co-located armies were merged at the start of the turn. */
  merged: boolean;
  /** How much strength has been sent to cover or attack each objective node this turn. */
  claims: Map<NodeId, number>;
}

export function newAiMemory(): AiMemory {
  return { turn: -1, handled: new Set(), merged: false, claims: new Map() };
}

interface Weights {
  /** Pull of enemy victory points. */
  attack: number;
  /** Pull of own threatened victory points. */
  defend: number;
  /** Strength ratio needed before starting a battle. */
  odds: number;
  /** Penalty for ending the turn out of supply. */
  unsupplied: number;
  /** Penalty per point of strength a nearby enemy army has over us. */
  danger: number;
}

const WEIGHTS: Record<AiRole, Weights> = {
  offensive: { attack: 1, defend: 0.35, odds: 1.2, unsupplied: 4, danger: 0.5 },
  defensive: { attack: 0.25, defend: 1, odds: 1.5, unsupplied: 6, danger: 0.2 },
};

/** Everything a decision needs, computed once per call. */
class Ctx {
  readonly team: Team;
  readonly role: AiRole;
  readonly w: Weights;
  readonly adj = new Map<NodeId, NodeId[]>();
  readonly own: Army[];
  readonly enemies: Army[];
  readonly supplied: Set<NodeId>;
  /** Victory points scaled so the largest is 10, whatever the map uses. */
  readonly vpScale: number;
  private bfsCache = new Map<NodeId, Map<NodeId, number>>();
  private attackCache: { node: NodeId; value: number }[] | null = null;
  private defendCache: { node: NodeId; value: number; threat: number; lost: boolean }[] | null = null;

  constructor(readonly s: GameState, readonly me: NationId, readonly mem: AiMemory) {
    this.team = sideOf(s, me);
    this.role = aiRole(s, me);
    this.w = WEIGHTS[this.role];
    for (const id of Object.keys(s.nodes)) this.adj.set(id, []);
    for (const e of s.edges) { this.adj.get(e.a)?.push(e.b); this.adj.get(e.b)?.push(e.a); }
    this.own = Object.values(s.armies).filter((a) => a.nation === me);
    this.enemies = Object.values(s.armies).filter((a) => sideOf(s, a.nation) !== this.team);
    this.supplied = suppliedNodes(s, this.team);
    this.vpScale = 10 / Math.max(1, ...Object.values(s.nodes).map((n) => n.vp));
  }

  friendly(n: NationId) { return sideOf(this.s, n) === this.team; }

  /** Distances from a node (cached: objectives are asked about many times). */
  dist(from: NodeId): Map<NodeId, number> {
    let d = this.bfsCache.get(from);
    if (d) return d;
    d = new Map([[from, 0]]);
    let frontier = [from];
    for (let k = 1; frontier.length; k++) {
      const next: NodeId[] = [];
      for (const n of frontier) for (const m of this.adj.get(n) ?? []) if (!d.has(m)) { d.set(m, k); next.push(m); }
      frontier = next;
    }
    this.bfsCache.set(from, d);
    return d;
  }

  d(a: NodeId, b: NodeId): number { return this.dist(a).get(b) ?? Infinity; }

  vp(node: NodeId) { return this.s.nodes[node].vp * this.vpScale; }

  /**
   * Enemy-held victory points worth taking, with how much each is worth. Towns of nations close
   * to their threshold count more: taking them may knock the nation out. Our own occupied towns
   * count as well (freeing them restores our willingness).
   */
  attackTargets(): { node: NodeId; value: number }[] {
    if (this.attackCache) return this.attackCache;
    const out: { node: NodeId; value: number }[] = [];
    for (const n of Object.values(this.s.nodes)) {
      if (!n.vp || this.friendly(n.controller)) continue;
      const owner = this.s.nations.find((x) => x.id === n.owner);
      let value = this.vp(n.id);
      if (owner && !this.friendly(owner.id)) {
        const margin = willingness(this.s, owner.id) - owner.threshold;
        value *= 1 + Math.max(0, 1 - margin / 30);
      } else {
        value *= 1.5;
      }
      out.push({ node: n.id, value });
    }
    return (this.attackCache = out);
  }

  /** Our side's victory points, with how threatened each is by visible enemy armies. */
  defendTargets(): { node: NodeId; value: number; threat: number; lost: boolean }[] {
    if (this.defendCache) return this.defendCache;
    const out: { node: NodeId; value: number; threat: number; lost: boolean }[] = [];
    for (const n of Object.values(this.s.nodes)) {
      if (!n.vp || !this.friendly(n.owner)) continue;
      // Allies' towns matter, but less than our own.
      const value = this.vp(n.id) * (n.owner === this.me ? 1 : 0.5);
      let threat = 0;
      for (const e of this.enemies) {
        const d = this.d(e.node, n.id);
        if (d <= 6) threat += strength(e) / (1 + d);
      }
      out.push({ node: n.id, value, threat, lost: !this.friendly(n.controller) });
    }
    return (this.defendCache = out);
  }

  claim(node: NodeId, amount: number) { this.mem.claims.set(node, (this.mem.claims.get(node) ?? 0) + amount); }
  claimed(node: NodeId) { return this.mem.claims.get(node) ?? 0; }

  enemiesNear(node: NodeId, maxDist: number): Army[] {
    return this.enemies.filter((e) => this.d(node, e.node) <= maxDist);
  }
}

function strength(a: Army): number {
  return combatUnits(a).length;
}

/** Decides the next intent for `nationId` from its own view. Never throws: falls back to a safe choice. */
export function aiIntent(view: GameState, nationId: NationId, mem: AiMemory): Intent {
  const prompt = view.pending.find((p) => p.nation === nationId);
  if (!prompt) throw new Error(`${nationId} has nothing to do`);
  try {
    return decide(new Ctx(view, nationId, mem), prompt);
  } catch {
    return aiFallback(view, nationId);
  }
}

/** The simplest legal answer to a prompt, used when a smarter choice was refused. */
export function aiFallback(view: GameState, nationId: NationId): Intent {
  const p = view.pending.find((x) => x.nation === nationId)!;
  switch (p.kind) {
    case 'movement': return { type: 'endTurn' };
    case 'chooseBattle': return { type: 'chooseBattle', defender: p.options[0] };
    case 'battleChoice': return { type: 'battleChoice', choice: 'fight' };
    case 'battleCards': return { type: 'battleCards', cards: [] };
    case 'retreat': return { type: 'retreat' };
    case 'attrition': return { type: 'attrition', unit: view.armies[p.army].units[0].id };
    case 'sabotage': return { type: 'sabotage', army: p.options[0] };
    case 'recruit': return { type: 'recruit', node: p.options[0], unit: 'infantry' };
  }
}

function decide(c: Ctx, p: Prompt): Intent {
  switch (p.kind) {
    case 'movement': return movement(c);
    case 'chooseBattle': {
      // Fight the weakest neighbour first.
      const opts = [...p.options].sort((a, b) => strength(c.s.armies[a]) - strength(c.s.armies[b]));
      return { type: 'chooseBattle', defender: opts[0] };
    }
    case 'battleChoice': return battleChoice(c);
    case 'battleCards': return battleCards(c);
    case 'retreat': {
      const moves = c.s.hands[c.me]?.find((x) => x.type === 'moves+1');
      const a = c.s.armies[p.army];
      if (moves && a && a.moved.bonus < 2) return { type: 'playMoves', army: p.army, card: moves.id };
      return { type: 'retreat' };
    }
    case 'attrition': {
      // Lose a unit of the type we have most of.
      const units = c.s.armies[p.army].units;
      const count = (t: UnitType) => units.filter((u) => u.type === t).length;
      return { type: 'attrition', unit: [...units].sort((x, y) => count(y.type) - count(x.type))[0].id };
    }
    case 'sabotage': {
      // Our own armies (Sabotaged): lose supply where we have most. Enemy armies: cut their last supply.
      const supplies = (id: string) => c.s.armies[id]?.units.filter((u) => u.type === 'supply').length ?? 0;
      const ours = p.options.every((id) => c.s.armies[id]?.nation === c.me);
      const opts = [...p.options].sort((a, b) => (ours ? supplies(b) - supplies(a) : supplies(a) - supplies(b)));
      return { type: 'sabotage', army: opts[0] };
    }
    case 'recruit': return recruit(c, p);
  }
}

// ---- movement ------------------------------------------------------------

function movement(c: Ctx): Intent {
  const { s, mem } = c;
  if (mem.turn !== s.turn) {
    mem.turn = s.turn;
    mem.handled = new Set();
    mem.merged = false;
    mem.claims = new Map();
  }

  // Raise the turn's muster first, while there is room under the unit cap.
  if (!musterBlocked(s, c.me)) {
    const { node, unit } = recruitChoice(c, musterNodes(s, c.me));
    return { type: 'muster', node, unit: unit ?? 'infantry' };
  }

  // Start of the turn: armies standing together fight together.
  if (!mem.merged) {
    const fresh = c.own.filter((a) => !a.moved.edges && !a.moved.stopped);
    for (const a of fresh) {
      const b = fresh.find((x) => x !== a && x.node === a.node);
      if (!b) continue;
      const [into, from] = a.units.length >= b.units.length ? [a, b] : [b, a];
      return { type: 'merge', into: into.id, from: from.id };
    }
    mem.merged = true;
  }

  // A general that reached an army joins it.
  for (const g of c.own.filter((a) => !a.units.length && mem.handled.has(a.id))) {
    const host = c.own.find((a) => a !== g && a.node === g.node && (mem.handled.has(a.id) || !a.generals.length));
    if (host) return { type: 'merge', into: host.id, from: g.id };
  }

  const kind = (a: Army) => (strength(a) ? 0 : a.generals.length && !a.units.length ? 1 : 2);
  const todo = c.own
    .filter((a) => !mem.handled.has(a.id) && !a.moved.stopped)
    .sort((a, b) => kind(a) - kind(b) || strength(b) - strength(a) || a.id.localeCompare(b.id));
  for (const a of todo) {
    const intent = kind(a) === 0 ? combatMove(c, a) : kind(a) === 1 ? generalMove(c, a) : supplyMove(c, a);
    if (intent) return intent;
  }
  return { type: 'endTurn' };
}

/** Where a combat army goes. Returns null when it stays put. */
function combatMove(c: Ctx, a: Army): Intent | null {
  const supply = a.units.filter((u) => u.type === 'supply');
  // Supply units crawl: the army plans as if it left them behind as a link in the supply chain.
  const light: Army = supply.length ? { ...a, units: a.units.filter((u) => u.type !== 'supply') } : a;
  const options: [NodeId, NodeId[]][] = [[a.node, []], ...reachable(c.s, light)];
  let best = { node: a.node, path: [] as NodeId[], score: -Infinity, focus: null as NodeId | null };
  for (const [node, path] of options) {
    const { score, focus } = scoreCombat(c, a, node, path.length > 0);
    const total = score - 0.01 * path.length;
    if (total > best.score) best = { node, path, score: total, focus };
  }
  if (best.focus) c.claim(best.focus, strength(a));
  if (!best.path.length) { c.mem.handled.add(a.id); return null; }
  if (supply.length) {
    // The split-off supply army stays where it is this turn.
    c.mem.handled.add(`${a.nation}-a${c.s.nextId}`);
    return { type: 'split', army: a.id, units: supply.map((u) => u.id), generals: [] };
  }
  c.mem.handled.add(a.id);
  return { type: 'move', army: a.id, path: best.path };
}

function scoreCombat(c: Ctx, a: Army, node: NodeId, moved: boolean): { score: number; focus: NodeId | null } {
  const { w, s } = c;
  const mine = strength(a);
  let score = 0;
  let focus: NodeId | null = null;

  // Attack: the best enemy-held victory point within reach, discounted by distance.
  let bestAttack = 0;
  for (const t of c.attackTargets()) {
    const d = c.d(node, t.node);
    if (d === Infinity) continue;
    const crowd = 1 / (1 + c.claimed(t.node) / Math.max(1, mine));
    let v = (t.value * crowd) / (1 + d);
    // Standing on it takes it at the end of the turn, unless an enemy army protects it.
    if (d === 0 && !c.enemiesNear(node, PROTECTION_RANGE).some((e) => e.nation === s.nodes[node].controller)) v += t.value;
    if (v > bestAttack) { bestAttack = v; if (w.attack >= w.defend) focus = t.node; }
  }
  score += w.attack * bestAttack;

  // Defend: be within protection range of threatened towns; free lost ones.
  let bestDefend = 0;
  for (const t of c.defendTargets()) {
    const d = c.d(node, t.node);
    if (d === Infinity) continue;
    let v: number;
    if (t.lost) {
      v = (2 * t.value) / (1 + d) + (d === 0 ? 2 * t.value : 0);
    } else {
      const covered = c.claimed(t.node) >= t.threat;
      const need = (t.threat > 0 ? 1 + t.threat : 0.2) * (covered ? 0.3 : 1);
      v = d <= PROTECTION_RANGE ? t.value * need : (t.value * need) / (1 + d - PROTECTION_RANGE);
    }
    if (v > bestDefend) { bestDefend = v; if (w.defend > w.attack) focus = t.node; }
  }
  score += w.defend * bestDefend;

  // Moving next to an enemy army starts a battle there.
  const adjacent = moved ? c.enemies.filter((e) => c.d(node, e.node) === 1) : [];
  if (adjacent.length) {
    const theirs = adjacent.reduce((sum, e) => sum + strength(e), 0);
    const onOurTown = adjacent.some((e) => s.nodes[e.node].vp && c.friendly(s.nodes[e.node].owner));
    const odds = onOurTown ? Math.min(w.odds, 1) : w.odds;
    if (mine >= odds * theirs) score += 1.5 * theirs + adjacent.reduce((sum, e) => sum + c.vp(e.node), 0) * 0.5;
    else score -= 5 + 3 * (theirs - mine);
  }

  // Stronger enemies within striking distance.
  for (const e of c.enemiesNear(node, 2)) {
    if (adjacent.includes(e)) continue;
    const over = strength(e) - mine;
    if (over > 0) score -= w.danger * over;
  }

  if (!c.supplied.has(node) && !c.friendly(s.nodes[node].controller)) score -= w.unsupplied;
  // Without a general, an army cannot leave enemy territory again.
  if (!a.generals.length && !c.friendly(s.nodes[node].controller)) score -= 3;
  return { score, focus };
}

/** A lone general rides to an army that has none, or to the biggest army. */
function generalMove(c: Ctx, g: Army): Intent | null {
  c.mem.handled.add(g.id);
  const hosts = c.own.filter((a) => a !== g && a.units.length);
  if (!hosts.length) return null;
  const wanted = hosts.filter((a) => !a.generals.length && strength(a));
  const goal = (wanted.length ? wanted : hosts)
    .sort((a, b) => c.d(g.node, a.node) - c.d(g.node, b.node) || strength(b) - strength(a))[0];
  if (goal.node === g.node) return { type: 'merge', into: goal.id, from: g.id };
  return safeStep(c, g, (n) => -c.d(n, goal.node));
}

/** Supply follows the armies fighting outside friendly land, one node behind, never into battle. */
function supplyMove(c: Ctx, a: Army): Intent | null {
  c.mem.handled.add(a.id);
  const front = c.own.filter((x) => strength(x) && !c.friendly(c.s.nodes[x.node].controller));
  if (!front.length) return null;
  const score = (n: NodeId) => {
    const d = Math.min(...front.map((f) => c.d(n, f.node)));
    return -Math.abs(d - 1) - (c.supplied.has(n) ? 0 : 10);
  };
  return safeStep(c, a, score);
}

/** Moves a non-combat army to the best-scoring node where no battle starts. */
function safeStep(c: Ctx, a: Army, score: (n: NodeId) => number): Intent | null {
  let best = { path: [] as NodeId[], score: score(a.node) };
  for (const [node, path] of reachable(c.s, a)) {
    if (c.enemies.some((e) => c.d(node, e.node) <= 1)) continue;
    const v = score(node) - 0.01 * path.length;
    if (v > best.score + 0.001) best = { path, score: v };
  }
  return best.path.length ? { type: 'move', army: a.id, path: best.path } : null;
}

// ---- recruiting ------------------------------------------------------------

function recruit(c: Ctx, p: Extract<Prompt, { kind: 'recruit' }>): Intent {
  if (p.what === 'general') {
    const wants = p.options.find((n) => c.own.some((a) => a.node === n && strength(a) && !a.generals.length));
    const biggest = [...p.options].sort((x, y) => ownStrengthAt(c, y) - ownStrengthAt(c, x))[0];
    return { type: 'recruit', node: wants ?? biggest };
  }
  return { type: 'recruit', ...recruitChoice(c, p.options) };
}

/** Where to raise a unit, and of what type. */
function recruitChoice(c: Ctx, options: NodeId[]): { node: NodeId; unit: UnitType } {
  let node: NodeId;
  const p = { options };
  if (c.role === 'defensive') {
    // Where the danger is greatest.
    const threats = c.defendTargets();
    const danger = (n: NodeId) => threats.reduce((sum, t) => sum + (t.threat * t.value) / (1 + c.d(n, t.node)), 0);
    node = [...p.options].sort((x, y) => danger(y) - danger(x) || x.localeCompare(y))[0];
  } else {
    // Closest to the enemy towns we are going after.
    const targets = c.attackTargets();
    const near = (n: NodeId) => Math.min(Infinity, ...targets.map((t) => c.d(n, t.node)));
    node = [...p.options].sort((x, y) => near(x) - near(y) || ownStrengthAt(c, y) - ownStrengthAt(c, x) || x.localeCompare(y))[0];
  }
  return { node, unit: recruitType(c) };
}

function ownStrengthAt(c: Ctx, n: NodeId) {
  return c.own.filter((a) => a.node === n).reduce((sum, a) => sum + a.units.length, 0);
}

function recruitType(c: Ctx): UnitType {
  const units = c.own.flatMap((a) => a.units);
  // Attackers need supply to keep a chain going.
  if (c.role === 'offensive' && units.filter((u) => u.type === 'supply').length < c.own.filter(strength).length) return 'supply';
  const enemy = c.enemies.flatMap((a) => a.units).filter(isCombat);
  if (!enemy.length) return 'infantry';
  const types: UnitType[] = ['infantry', 'cavalry', 'artillery'];
  return types.sort((x, y) => counterScore(y, enemy) - counterScore(x, enemy))[0];
}

/** How well a unit type does against a group: + for each unit it beats, − for each that beats it. */
function counterScore(type: UnitType, against: Unit[]): number {
  let v = 0;
  for (const u of against) {
    if (TYPE_ADVANTAGE[type] === u.type) v++;
    if (TYPE_ADVANTAGE[u.type] === type) v--;
  }
  return v;
}

// ---- battles ---------------------------------------------------------------

function battleSides(c: Ctx) {
  const b = c.s.battle!;
  const role = roleOf(c.s, c.me)!;
  const mine = battleArmy(c.s, b, role);
  const theirs = battleArmy(c.s, b, other(role));
  return { b, role, mine, theirs };
}

/**
 * Before the roll. Hopeless fights are left with a Retreat card, or in panic when the odds are
 * very bad (a defensive army guarding its land holds out longer). A much stronger army plays
 * Block Retreat so the enemy cannot slip away.
 */
function battleChoice(c: Ctx): Intent {
  const { role, mine, theirs } = battleSides(c);
  const hand = c.s.hands[c.me] ?? [];
  const has = (t: string) => hand.some((x) => x.type === t);
  const ours = strength(mine);
  const enemy = strength(theirs);
  const stubborn = c.role === 'defensive' && role === 'defender';
  let choice: BattleChoice = 'fight';
  if (ours * (stubborn ? 3 : 2) < enemy && has('retreat')) choice = 'retreat';
  else if (ours * (stubborn ? 5 : 3) < enemy && ours > 1) choice = 'panic';
  else if (ours >= 2 * enemy && has('blockRetreat')) choice = 'block';
  return { type: 'battleChoice', choice };
}

/**
 * After the roll every die is known, so each roll card goes where it turns a duel our way (or
 * nowhere, and is kept for later).
 */
function battleCards(c: Ctx): Intent {
  const { b, role, mine, theirs } = battleSides(c);
  const typeIn = (a: Army) => (id: string) => a.units.find((u) => u.id === id)?.type;
  const armies = role === 'attacker' ? { attacker: mine, defender: theirs } : { attacker: theirs, defender: mine };
  const types = { attacker: b.units.attacker.map(typeIn(armies.attacker)), defender: b.units.defender.map(typeIn(armies.defender)) };
  const value = (cards: PlacedCard[]) => scoreDuels(types, b.units, b.matchups, b.dice!, cards)
    .reduce((sum, d) => sum + (d.winner === role ? 1 : -1), 0);
  const placed: PlacedCard[] = [];
  for (const card of (c.s.hands[c.me] ?? []).filter((x) => ROLL_CARDS.includes(x.type))) {
    const on: BattleRole = card.type === 'roll-1' ? other(role) : role;
    let best = { value: value(placed), die: -1 };
    b.dice![on].forEach((_, die) => {
      const v = value([...placed, { cardId: card.id, role: on, die, type: card.type }]);
      if (v > best.value) best = { value: v, die };
    });
    if (best.die >= 0) placed.push({ cardId: card.id, role: on, die: best.die, type: card.type });
  }
  return { type: 'battleCards', cards: placed.map(({ cardId, role: r, die }) => ({ cardId, role: r, die })) };
}
