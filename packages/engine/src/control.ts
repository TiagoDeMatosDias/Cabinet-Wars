import type { Army, GameState, NationId, NodeId, Team } from './types';
import { distances, log, nation, sideOf } from './graph';

export const PROTECTION_RANGE = 2;

/** A node is protected if an army of its current controller is within 2 nodes. */
export function isProtected(state: GameState, nodeId: string): boolean {
  const controller = state.nodes[nodeId].controller;
  const near = distances(state, [nodeId], PROTECTION_RANGE);
  return Object.values(state.armies).some((a) => a.nation === controller && near.has(a.node));
}

/**
 * An army entering a node its own nation owns ends any enemy occupation there at once, even if it
 * only passes through (only nodes without foreign armies can be entered).
 */
export function liberate(state: GameState, a: Army, nodeId: NodeId) {
  const node = state.nodes[nodeId];
  if (node.owner !== a.nation || node.controller === a.nation) return;
  node.controller = a.nation;
  log(state, 'log.liberates', { nation: a.nation, node: nodeId }, { kind: 'control', nation: a.nation, node: nodeId });
}

/** Control changes for nodes where the given nation's armies ended their turn. */
export function updateControl(state: GameState, nationId: NationId) {
  const side = sideOf(state, nationId);
  const changes: { node: string; to: NationId }[] = [];
  for (const a of Object.values(state.armies)) {
    if (a.nation !== nationId) continue;
    const node = state.nodes[a.node];
    // Allies of the owner hand the node back to its owner.
    const to = sideOf(state, node.owner) === side ? node.owner : nationId;
    if (node.controller === to) continue;
    // Already held by an ally on enemy-owned soil: leave it with them.
    if (to === nationId && sideOf(state, node.controller) === side) continue;
    if (sideOf(state, node.controller) !== side && isProtected(state, node.id)) continue;
    changes.push({ node: node.id, to });
  }
  for (const c of changes) {
    state.nodes[c.node].controller = c.to;
    log(state, 'log.takesControl', { nation: c.to, node: c.node }, { kind: 'control', nation: c.to, node: c.node });
  }
}

export function willingness(state: GameState, nationId: NationId): number {
  const nat = nation(state, nationId);
  let total = 0;
  let held = 0;
  for (const n of Object.values(state.nodes)) {
    if (n.owner !== nationId) continue;
    total += n.vp;
    if (n.controller === nationId) held += n.vp;
  }
  // War exhaustion takes percentage points off willingness.
  const base = total === 0 ? 100 : (100 * held) / total;
  return Math.max(0, base - nat.warExhaustion);
}

/** Knocks out nations below their threshold and sets the winner once a single team is left. */
export function checkVictory(state: GameState) {
  for (let changed = true; changed;) {
    changed = false;
    for (const nat of state.nations) {
      if (nat.knockedOut || willingness(state, nat.id) >= nat.threshold) continue;
      knockOut(state, nat.id);
      // Handing out its land changes other nations' willingness: check everyone again.
      changed = true;
    }
  }
  const teams = new Set(state.nations.filter((n) => !n.knockedOut).map((n) => sideOf(state, n.id)));
  if (teams.size === 1) finish(state, [...teams][0]);
  else if (teams.size === 0) finish(state, state.rules.mode === 'freeForAll' ? state.current : 'defender');
}

function knockOut(state: GameState, nationId: NationId) {
  const nat = nation(state, nationId);
  nat.knockedOut = true;
  for (const a of Object.values(state.armies)) if (a.nation === nat.id) delete state.armies[a.id];
  log(state, 'log.knockedOut', { nation: nat.id }, { kind: 'result', nation: nat.id });
  partitionLand(state, nat.id);
}

/**
 * A defeated nation's land is split up. Each node it owned goes to the nearest living nation
 * (measured from the nodes that nation controls, so an occupier keeps what it holds); ties go to
 * whoever controls most of the defeated nation's victory points. The new owner also controls the
 * node, and its victory points drop to 1 so the conqueror doesn't gain too much.
 * Nodes the defeated nation occupied go back to their owners.
 */
export function partitionLand(state: GameState, defeated: NationId) {
  const living = state.nations.filter((n) => !n.knockedOut).map((n) => n.id);
  for (const n of Object.values(state.nodes)) {
    if (n.controller === defeated && n.owner !== defeated) n.controller = n.owner;
  }
  if (!living.length) return;
  const heldVp = new Map(living.map((id) => [id, 0]));
  for (const n of Object.values(state.nodes)) {
    if (n.owner === defeated && heldVp.has(n.controller)) heldVp.set(n.controller, heldVp.get(n.controller)! + n.vp);
  }
  const order = [...living].sort((a, b) => heldVp.get(b)! - heldVp.get(a)! || living.indexOf(a) - living.indexOf(b));
  const reach = new Map(order.map((id) => [id, distances(state, Object.values(state.nodes).filter((n) => n.controller === id).map((n) => n.id))]));
  const gained = new Map<NationId, number>();
  for (const n of Object.values(state.nodes)) {
    if (n.owner !== defeated) continue;
    let best = order[0];
    let bestD = Infinity;
    for (const id of order) {
      const d = reach.get(id)!.get(n.id) ?? Infinity;
      if (d < bestD) { best = id; bestD = d; }
    }
    n.owner = best;
    n.controller = best;
    if (n.vp > 1) n.vp = 1;
    gained.set(best, (gained.get(best) ?? 0) + 1);
  }
  for (const [to, count] of gained) {
    log(state, 'log.landPartitioned', { nation: to, defeatedNation: defeated, count }, { kind: 'result', nation: to });
  }
}

/** Who the End Game card declares the winner. */
export function endGameWinner(state: GameState): Team {
  if (state.rules.mode === 'freeForAll') {
    // The most willing nation still in the war wins; ties go to the most victory points held.
    const alive = state.nations.filter((n) => !n.knockedOut);
    const vpHeld = (id: NationId) => Object.values(state.nodes).filter((n) => n.controller === id).reduce((s, n) => s + n.vp, 0);
    alive.sort((a, b) => willingness(state, b.id) - willingness(state, a.id) || vpHeld(b.id) - vpHeld(a.id));
    return alive[0]?.id ?? state.current;
  }
  return state.nations.some((n) => n.side === 'defender' && !n.knockedOut) ? 'defender' : 'attacker';
}

export function finish(state: GameState, winner: Team) {
  state.winner = winner;
  state.phase = 'gameOver';
  state.pending = [];
  state.oracle = null;
  if (state.rules.mode === 'freeForAll') log(state, 'log.winnerNation', { nation: winner }, { kind: 'result', nation: winner });
  else log(state, 'log.winner', { side: `side.${winner}` }, { kind: 'result' });
}
