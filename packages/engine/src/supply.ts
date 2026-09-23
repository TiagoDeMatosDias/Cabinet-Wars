import type { GameState, NodeId, Team } from './types';
import { distances, sideOf } from './graph';

export const SUPPLY_RANGE = 2;

/** Nodes in supply for a side: within 2 of a friendly-controlled node or of a supplied supply unit. */
export function suppliedNodes(state: GameState, side: Team): Set<NodeId> {
  const sources = Object.values(state.nodes)
    .filter((n) => sideOf(state, n.controller) === side)
    .map((n) => n.id);
  let supplied = new Set(distances(state, sources, SUPPLY_RANGE).keys());
  const supplyArmies = Object.values(state.armies).filter(
    (a) => sideOf(state, a.nation) === side && a.units.some((u) => u.type === 'supply'),
  );
  const used = new Set<string>();
  for (let changed = true; changed;) {
    changed = false;
    for (const a of supplyArmies) {
      if (used.has(a.id) || !supplied.has(a.node)) continue;
      used.add(a.id);
      for (const n of distances(state, [a.node], SUPPLY_RANGE).keys()) supplied.add(n);
      changed = true;
    }
  }
  return supplied;
}

export function isSupplied(state: GameState, armyId: string): boolean {
  const a = state.armies[armyId];
  return suppliedNodes(state, sideOf(state, a.nation)).has(a.node);
}

export function unsuppliedArmies(state: GameState, nationId: string): string[] {
  const supplied = suppliedNodes(state, sideOf(state, nationId));
  return Object.values(state.armies)
    .filter((a) => a.nation === nationId && !supplied.has(a.node))
    .map((a) => a.id);
}
