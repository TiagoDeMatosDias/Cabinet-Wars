import type { Army, GameState, HistoryEntry, NationId, NodeId, RoadType, Team, Unit } from './types';
import { formatMessage, MESSAGES, type MessageKey, type MessageParams } from './messages';
import { GENERAL_SPEED, UNIT_SPEED } from './types';

/** A rejected action. `template` is the English message with {placeholders}; clients translate it. */
export class GameError extends Error {
  constructor(readonly template: string, readonly params: Record<string, string | number> = {}) {
    super(template.replace(/\{(\w+)\}/g, (w, p: string) => (p in params ? String(params[p]) : w)));
  }
}

export function fail(template: string, params: Record<string, string | number> = {}): never {
  throw new GameError(template, params);
}

export function neighbors(state: GameState, node: NodeId): { node: NodeId; type: RoadType }[] {
  const out: { node: NodeId; type: RoadType }[] = [];
  for (const e of state.edges) {
    if (e.a === node) out.push({ node: e.b, type: e.type });
    else if (e.b === node) out.push({ node: e.a, type: e.type });
  }
  return out;
}

export function edgeType(state: GameState, a: NodeId, b: NodeId): RoadType | null {
  for (const e of state.edges) if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) return e.type;
  return null;
}

/** Multi-source BFS: distance (in edges) from any source node, up to maxDist. */
export function distances(state: GameState, sources: Iterable<NodeId>, maxDist = Infinity): Map<NodeId, number> {
  const dist = new Map<NodeId, number>();
  let frontier: NodeId[] = [];
  for (const s of sources) if (!dist.has(s)) { dist.set(s, 0); frontier.push(s); }
  for (let d = 1; d <= maxDist && frontier.length; d++) {
    const next: NodeId[] = [];
    for (const n of frontier) for (const nb of neighbors(state, n)) {
      if (!dist.has(nb.node)) { dist.set(nb.node, d); next.push(nb.node); }
    }
    frontier = next;
  }
  return dist;
}

export function nation(state: GameState, id: NationId) {
  return state.nations.find((n) => n.id === id) ?? fail('Unknown nation {id}', { id });
}

/** The team a nation fights for: its side, or itself in a free-for-all game. */
export function sideOf(state: GameState, id: NationId): Team {
  return state.rules.mode === 'freeForAll' ? id : nation(state, id).side;
}

export function areFriends(state: GameState, a: NationId, b: NationId): boolean {
  return sideOf(state, a) === sideOf(state, b);
}

export function army(state: GameState, id: string): Army {
  return state.armies[id] ?? fail('Unknown army {id}', { id });
}

export function armiesAt(state: GameState, node: NodeId): Army[] {
  return Object.values(state.armies).filter((a) => a.node === node);
}

export function enemyArmiesAdjacent(state: GameState, a: Army, node = a.node): Army[] {
  const side = sideOf(state, a.nation);
  const adj = new Set(neighbors(state, node).map((n) => n.node));
  return Object.values(state.armies).filter((o) => adj.has(o.node) && sideOf(state, o.nation) !== side);
}

export const isCombat = (u: Unit) => u.type !== 'supply';

export function combatUnits(a: Army): Unit[] {
  return a.units.filter(isCombat);
}

export function diceFor(combatCount: number): number {
  if (combatCount <= 0) return 0;
  if (combatCount <= 3) return 1;
  if (combatCount <= 6) return 2;
  if (combatCount <= 9) return 3;
  return 4;
}

/** An army moves at the pace of its slowest member; generals count, at cavalry speed. */
export function baseSpeed(units: Unit[], generals = 0): number {
  const speeds = [...units.map((u) => UNIT_SPEED[u.type]), ...(generals > 0 ? [GENERAL_SPEED] : [])];
  return speeds.length ? Math.min(...speeds) : 0;
}

/** An army that moves only along major roads goes this many times as far. */
export const MAJOR_ROAD_MULTIPLIER = 3;

/** Whether a path of `edges` edges (all major or not) fits within `speed`. */
export function fitsSpeed(edges: number, allMajor: boolean, speed: number): boolean {
  return edges <= speed || (allMajor && edges <= speed * MAJOR_ROAD_MULTIPLIER);
}

export function newId(state: GameState, prefix: string): string {
  return `${prefix}${state.nextId++}`;
}

/** Log entries about how a battle is fought, as opposed to what everyone watching sees happen. */
const BATTLE_DETAILS = new Set<MessageKey>(['log.dice', 'log.round', 'log.retreatBlocked']);

/** Records a log entry from a message key; the English text is kept alongside for tools and tests. */
export function log(
  state: GameState,
  key: MessageKey,
  params: MessageParams = {},
  meta: Omit<HistoryEntry, 'turn' | 'text' | 'msg' | 'round'> = {},
) {
  const text = formatMessage(MESSAGES[key], params, (kind, id) => (kind === 'nation' ? state.nations.find((n) => n.id === id)?.name ?? id : nodeName(state, id)));
  const entry: HistoryEntry = { turn: state.turn, round: state.round, text, msg: { key, params } };
  for (const [k, v] of Object.entries(meta)) if (v !== undefined) (entry as unknown as Record<string, unknown>)[k] = v;
  // Battle entries are seen only by those who could see the battle; its dice and choices only by those fighting it.
  if (meta.kind === 'battle' && state.battle && !entry.teams && !entry.side) {
    entry.teams = [...state.battle.witnesses];
    if (BATTLE_DETAILS.has(key)) entry.nations = [state.battle.start.attacker.nation, state.battle.start.defender.nation];
  }
  state.history.push(entry);
}

export function nodeName(state: GameState, id: NodeId): string {
  return state.nodes[id]?.name || id;
}

export function removeArmy(state: GameState, id: string, reason: MessageKey) {
  const a = state.armies[id];
  if (!a) return;
  for (const g of a.generals) delete state.generals[g];
  delete state.armies[id];
  log(state, 'log.destroyed', { nation: a.nation, army: id, reason }, { kind: 'battle', nation: a.nation, node: a.node });
}
