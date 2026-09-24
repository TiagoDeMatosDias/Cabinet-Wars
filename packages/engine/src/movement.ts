import type { Army, GameState, NodeId } from './types';
import {
  areFriends, army, armiesAt, baseSpeed, edgeType, enemyArmiesAdjacent, fail, fitsSpeed, log, newId, sideOf,
} from './graph';
import { liberate } from './control';

export function isFriendlyNode(state: GameState, a: Army, node: NodeId = a.node): boolean {
  return areFriends(state, state.nodes[node].controller, a.nation);
}

/**
 * In enemy territory an army needs a general to move, unless it is made of supply wagons only:
 * they find their own way.
 */
export function canMoveWithoutGeneral(a: Army): boolean {
  return a.units.length > 0 && a.units.every((u) => u.type === 'supply');
}

function stuckInEnemyLand(state: GameState, a: Army): boolean {
  return a.generals.length === 0 && !canMoveWithoutGeneral(a) && !isFriendlyNode(state, a);
}

export function armySpeed(a: Army): number {
  return baseSpeed(a.units, a.generals.length) + a.moved.bonus;
}

export function canEnter(state: GameState, a: Army, node: NodeId): boolean {
  return armiesAt(state, node).every((o) => o.nation === a.nation);
}

/**
 * Moves an army along `path` (nodes after the current one). The move stops early at the
 * first node next to an enemy army, which may be hidden from the mover.
 * Returns the adjacent enemy army ids when a battle is triggered.
 */
export function moveArmy(state: GameState, armyId: string, path: NodeId[]): string[] {
  const a = army(state, armyId);
  if (a.nation !== state.current) fail('Not your army');
  if (!path.length) fail('Empty path');
  if (a.moved.stopped) fail('This army cannot move further this turn');
  if (stuckInEnemyLand(state, a)) fail('An army without a general cannot leave enemy territory');

  let edges = a.moved.edges;
  let allMajor = a.moved.allMajor;
  let prev = a.node;
  for (const node of path) {
    const type = edgeType(state, prev, node) ?? fail('{from} is not connected to {to}', { from: prev, to: node });
    if (!state.nodes[node]) fail('Unknown node {node}', { node });
    edges += 1;
    allMajor = allMajor && type === 'major';
    if (!fitsSpeed(edges, allMajor, armySpeed(a))) fail('Not enough movement for that path');
    prev = node;
  }

  const start = a.node;
  let travelled = 0;
  prev = a.node;
  for (const node of path) {
    if (!canEnter(state, a, node)) break; // hidden foreign army blocks the road
    const type = edgeType(state, prev, node)!;
    a.moved.edges += 1;
    a.moved.allMajor = a.moved.allMajor && type === 'major';
    a.node = node;
    liberate(state, a, node);
    prev = node;
    travelled++;
    const enemies = enemyArmiesAdjacent(state, a);
    if (enemies.length) {
      a.moved.stopped = true;
      // Only the mover's side: whoever can see the battle learns of it when it starts.
      log(state, 'log.engages', { nation: a.nation, army: a.id, node }, { kind: 'battle', nation: a.nation, node, side: sideOf(state, a.nation) });
      return enemies.map((e) => e.id);
    }
  }
  if (!travelled) fail('The road is blocked');
  log(state, 'log.moved', { nation: a.nation, army: a.id, fromNode: start, toNode: a.node }, { kind: 'order', nation: a.nation, node: a.node, side: sideOf(state, a.nation) });
  return [];
}

export function splitArmy(state: GameState, armyId: string, unitIds: string[], generalIds: string[]): string {
  const a = army(state, armyId);
  if (a.nation !== state.current) fail('Not your army');
  const units = a.units.filter((u) => unitIds.includes(u.id));
  if (units.length !== unitIds.length) fail('Unknown unit');
  if (!generalIds.every((g) => a.generals.includes(g))) fail('Unknown general');
  if (!units.length && !generalIds.length) fail('A new army needs at least one unit or general');
  const remaining = a.units.filter((u) => !unitIds.includes(u.id));
  const remainingGenerals = a.generals.filter((g) => !generalIds.includes(g));
  if (!remaining.length && !remainingGenerals.length) fail('Leave at least one unit or general behind');
  const id = newId(state, `${a.nation}-a`);
  state.armies[id] = { id, nation: a.nation, node: a.node, generals: [...generalIds], units, moved: { ...a.moved } };
  a.units = remaining;
  a.generals = remainingGenerals;
  log(state, 'log.split', { nation: a.nation, army: a.id, newArmy: id }, { kind: 'order', nation: a.nation, node: a.node, side: sideOf(state, a.nation) });
  return id;
}

export function mergeArmies(state: GameState, intoId: string, fromId: string) {
  const into = army(state, intoId);
  const from = army(state, fromId);
  if (into.nation !== state.current || from.nation !== state.current) fail('Not your army');
  if (into === from) fail('Cannot merge an army with itself');
  if (into.node !== from.node) fail('Armies must be on the same node to merge');
  into.units.push(...from.units);
  into.generals.push(...from.generals);
  into.moved = {
    edges: Math.max(into.moved.edges, from.moved.edges),
    allMajor: into.moved.allMajor && from.moved.allMajor,
    bonus: Math.min(into.moved.bonus, from.moved.bonus),
    stopped: into.moved.stopped || from.moved.stopped,
  };
  delete state.armies[fromId];
  log(state, 'log.merged', { nation: into.nation, otherArmy: fromId, army: intoId }, { kind: 'order', nation: into.nation, node: into.node, side: sideOf(state, into.nation) });
}

export interface TransferGroup {
  /** Existing army id, or null for a new army. */
  army: string | null;
  units: string[];
  generals: string[];
}

/**
 * Redistributes units and generals between armies of the current nation on one node.
 * Every unit and general of the listed armies must be placed in exactly one group.
 * Groups left empty remove their army. Returns the ids of the resulting armies.
 */
export function transferArmies(state: GameState, groups: TransferGroup[]): string[] {
  const existing = groups.filter((g) => g.army !== null).map((g) => army(state, g.army!));
  if (!existing.length) fail('Name at least one existing army');
  if (new Set(existing.map((a) => a.id)).size !== existing.length) fail('An army is listed twice');
  const node = existing[0].node;
  for (const a of existing) {
    if (a.nation !== state.current) fail('Not your army');
    if (a.node !== node) fail('Armies must be on the same node to reorganize');
  }
  const units = new Map(existing.flatMap((a) => a.units.map((u) => [u.id, u] as const)));
  const generals = new Set(existing.flatMap((a) => a.generals));
  const placedUnits = groups.flatMap((g) => g.units);
  const placedGenerals = groups.flatMap((g) => g.generals);
  if (placedUnits.length !== units.size || new Set(placedUnits).size !== units.size || !placedUnits.every((u) => units.has(u))) {
    fail('Place every unit exactly once');
  }
  if (placedGenerals.length !== generals.size || new Set(placedGenerals).size !== generals.size || !placedGenerals.every((g) => generals.has(g))) {
    fail('Place every general exactly once');
  }
  // Units keep moving at the pace of the most restricted army they came from.
  const moved = {
    edges: Math.max(...existing.map((a) => a.moved.edges)),
    allMajor: existing.every((a) => a.moved.allMajor),
    bonus: Math.min(...existing.map((a) => a.moved.bonus)),
    stopped: existing.some((a) => a.moved.stopped),
  };
  const nat = existing[0].nation;
  const result: string[] = [];
  for (const g of groups) {
    if (!g.units.length && !g.generals.length) {
      if (g.army) delete state.armies[g.army];
      continue;
    }
    const id = g.army ?? newId(state, `${nat}-a`);
    state.armies[id] = { id, nation: nat, node, generals: [...g.generals], units: g.units.map((u) => units.get(u)!), moved: { ...moved } };
    result.push(id);
  }
  log(state, 'log.reorganized', { nation: nat, node }, { kind: 'order', nation: nat, node, side: sideOf(state, nat) });
  return result;
}

export function resetMovement(state: GameState, nationId: string) {
  for (const a of Object.values(state.armies)) {
    if (a.nation === nationId) a.moved = { edges: 0, allMajor: true, bonus: 0, stopped: false };
  }
}

/** Nodes an army can still reach this turn, keyed by node with the path to it. For UI previews. */
export function reachable(state: GameState, a: Army): Map<NodeId, NodeId[]> {
  const speed = armySpeed(a);
  const out = new Map<NodeId, NodeId[]>();
  if (a.moved.stopped) return out;
  if (stuckInEnemyLand(state, a)) return out;
  const stack: { node: NodeId; path: NodeId[]; edges: number; allMajor: boolean }[] = [
    { node: a.node, path: [], edges: a.moved.edges, allMajor: a.moved.allMajor },
  ];
  // Best seen (edges, allMajor) per node to prune. A shorter all-major path dominates.
  const best = new Map<string, number>();
  while (stack.length) {
    const cur = stack.pop()!;
    for (const e of state.edges) {
      const next = e.a === cur.node ? e.b : e.b === cur.node ? e.a : null;
      if (!next || next === a.node || cur.path.includes(next)) continue;
      const edges = cur.edges + 1;
      const allMajor = cur.allMajor && e.type === 'major';
      if (!fitsSpeed(edges, allMajor, speed)) continue;
      if (!canEnter(state, a, next)) continue;
      const key = `${next}|${allMajor}`;
      if ((best.get(key) ?? Infinity) <= edges) continue;
      best.set(key, edges);
      const path = [...cur.path, next];
      const prevPath = out.get(next);
      if (!prevPath || prevPath.length > path.length) out.set(next, path);
      const stopsHere = enemyArmiesAdjacent(state, a, next).length > 0;
      if (!stopsHere) stack.push({ node: next, path, edges, allMajor });
    }
  }
  return out;
}
