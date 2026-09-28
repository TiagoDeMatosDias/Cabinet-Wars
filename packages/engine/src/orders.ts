import type { GameState, NationId, NodeId, UnitType } from './types';
import { fail, GameError, log, sideOf } from './graph';
import { mergeArmies, moveArmy, splitArmy, transferArmies } from './movement';
import type { Intent } from './reducer';

/**
 * Planned orders. A player queues orders during their turn and executes them one by one.
 * Orders may refer to armies that only exist after an earlier planned split or reorganize;
 * those are named by placeholders ("@1", "@2", …) until the order that creates them runs.
 */
export type ArmyRef = string;

export type OrderIntent =
  | { type: 'move'; army: ArmyRef; path: NodeId[] }
  | { type: 'split'; army: ArmyRef; units: string[]; generals: string[]; creates: ArmyRef }
  | { type: 'merge'; into: ArmyRef; from: ArmyRef[] }
  | { type: 'transfer'; groups: { army: ArmyRef | null; units: string[]; generals: string[]; creates?: ArmyRef }[] }
  | { type: 'playMoves'; army: ArmyRef; card: string };

export interface Order {
  id: string;
  intent: OrderIntent;
}

export interface OrderProjection {
  ok: boolean;
  error?: string;
  /** English error template and its parameters, for translation. */
  errorTemplate?: string;
  errorParams?: Record<string, string | number>;
  /** The move ends next to a known enemy army, so a battle will start there. */
  meetsEnemy?: boolean;
  /** When the move meets the enemy: the unit types of the moving army and of each enemy army it will fight. */
  battle?: { attacker: UnitType[]; defenders: UnitType[][] };
  /** Nodes the move passes through (for arrows), including the start. */
  path?: NodeId[];
}

export const isPlaceholder = (ref: ArmyRef) => ref.startsWith('@');

/** Army refs an order reads (not the ones it creates). */
export function orderRefs(o: OrderIntent): ArmyRef[] {
  switch (o.type) {
    case 'move': case 'split': case 'playMoves': return [o.army];
    case 'merge': return [o.into, ...o.from];
    case 'transfer': return o.groups.flatMap((g) => (g.army ? [g.army] : []));
  }
}

/** Placeholders an order creates. */
export function orderCreates(o: OrderIntent): ArmyRef[] {
  if (o.type === 'split') return [o.creates];
  if (o.type === 'transfer') return o.groups.flatMap((g) => (g.army === null && g.creates ? [g.creates] : []));
  return [];
}

/** Ids of the orders that `orders[index]` depends on through placeholders, transitively. */
export function dependenciesOf(orders: Order[], index: number): Set<string> {
  const out = new Set<string>();
  const need = new Set(orderRefs(orders[index].intent).filter(isPlaceholder));
  for (let i = index - 1; i >= 0 && need.size; i--) {
    const creates = orderCreates(orders[i].intent);
    if (creates.some((c) => need.has(c))) {
      out.add(orders[i].id);
      for (const r of orderRefs(orders[i].intent)) if (isPlaceholder(r)) need.add(r);
    }
  }
  return out;
}

/** Ids of orders that depend (transitively) on the given order. */
export function dependentsOf(orders: Order[], id: string): Set<string> {
  const out = new Set<string>();
  const created = new Set<ArmyRef>();
  const start = orders.findIndex((o) => o.id === id);
  if (start < 0) return out;
  for (const c of orderCreates(orders[start].intent)) created.add(c);
  for (let i = start + 1; i < orders.length; i++) {
    const o = orders[i].intent;
    if (orderRefs(o).some((r) => created.has(r))) {
      out.add(orders[i].id);
      for (const c of orderCreates(o)) created.add(c);
    }
  }
  return out;
}

function resolve(ref: ArmyRef, ids: Map<ArmyRef, string>): string {
  if (!isPlaceholder(ref)) return ref;
  return ids.get(ref) ?? fail('Refers to an army that has not been created');
}

/** Plays a +1 Moves card from a hand onto an army. Shared by the reducer and projections. */
export function playMovesCard(state: GameState, by: NationId, armyId: string, cardId: string) {
  const a = state.armies[armyId] ?? fail('Unknown army');
  if (a.nation !== by) fail('Not your army');
  const hand = state.hands[by];
  const card = hand.find((c) => c.id === cardId && c.type === 'moves+1') ?? fail('No such +1 Moves card');
  state.hands[by] = hand.filter((c) => c !== card);
  state.generalDeck.discard.push(card);
  a.moved.bonus += 1;
  log(state, 'log.playsMoves', { nation: by, army: a.id }, { kind: 'card', nation: by, node: a.node, side: sideOf(state, by) });
}

/**
 * Converts an order into engine intents, given the real ids of already created armies.
 * `nextId` is the state's next id, so the ids the order will create can be predicted.
 */
export function orderToIntents(o: OrderIntent, ids: Map<ArmyRef, string>, nationId: NationId, nextId: number): { intents: Intent[]; created: Map<ArmyRef, string> } {
  const r = (ref: ArmyRef) => resolve(ref, ids);
  const created = new Map<ArmyRef, string>();
  switch (o.type) {
    case 'move': return { intents: [{ type: 'move', army: r(o.army), path: o.path }], created };
    case 'playMoves': return { intents: [{ type: 'playMoves', army: r(o.army), card: o.card }], created };
    case 'split':
      created.set(o.creates, `${nationId}-a${nextId}`);
      return { intents: [{ type: 'split', army: r(o.army), units: o.units, generals: o.generals }], created };
    case 'merge':
      return { intents: o.from.map((f) => ({ type: 'merge' as const, into: r(o.into), from: r(f) })), created };
    case 'transfer': {
      let n = nextId;
      for (const g of o.groups) if (g.army === null && g.units.length && g.creates) created.set(g.creates, `${nationId}-a${n++}`);
      return {
        intents: [{ type: 'transfer', groups: o.groups.map((g) => ({ army: g.army === null ? null : r(g.army), units: g.units, generals: g.generals })) }],
        created,
      };
    }
  }
}

/** Applies one order to a state in place (projection only: battles are not resolved). */
function applyOrder(state: GameState, o: OrderIntent, ids: Map<ArmyRef, string>, nationId: NationId): OrderProjection {
  const { intents, created } = orderToIntents(o, ids, nationId, state.nextId);
  let meetsEnemy = false;
  let battle: OrderProjection['battle'];
  let path: NodeId[] | undefined;
  for (const i of intents) {
    switch (i.type) {
      case 'move': {
        const a = state.armies[i.army] ?? fail('The army no longer exists');
        const start = a.node;
        const enemies = moveArmy(state, i.army, i.path);
        meetsEnemy = enemies.length > 0;
        if (meetsEnemy) {
          const types = (id: string) => state.armies[id].units.map((u) => u.type);
          battle = { attacker: types(i.army), defenders: enemies.map(types) };
        }
        const end = state.armies[i.army].node;
        path = [start, ...i.path.slice(0, i.path.indexOf(end) + 1)];
        break;
      }
      case 'split': splitArmy(state, i.army, i.units, i.generals); break;
      case 'merge': mergeArmies(state, i.into, i.from); break;
      case 'transfer': transferArmies(state, i.groups); break;
      case 'playMoves': playMovesCard(state, nationId, i.army, i.card); break;
      default: fail('Not an order');
    }
  }
  for (const [k, v] of created) ids.set(k, v);
  return { ok: true, meetsEnemy, battle, path };
}

/**
 * Applies planned orders, in order, to a copy of a player's view. Invalid orders are reported
 * and skipped. `ids` maps placeholders of orders that were already executed to real ids.
 */
export function projectOrders(
  view: GameState,
  nationId: NationId,
  orders: Order[],
  ids: Map<ArmyRef, string> = new Map(),
): { state: GameState; results: OrderProjection[]; ids: Map<ArmyRef, string> } {
  let state = structuredClone(view);
  state.history = [];
  const known = new Map(ids);
  const results = orders.map((order) => {
    const before = structuredClone(state);
    try {
      return applyOrder(state, order.intent, known, nationId);
    } catch (e) {
      state = before;
      if (e instanceof GameError) return { ok: false, error: e.message, errorTemplate: e.template, errorParams: e.params };
      if (e instanceof Error) return { ok: false, error: e.message };
      throw e;
    }
  });
  return { state, results, ids: known };
}
