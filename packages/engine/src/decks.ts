import type { Army, Card, Deck, EventCardType, GameState } from './types';
import { areFriends, fail, log, nation, newId, removeArmy, sideOf } from './graph';
import { UNIT_TYPES, type UnitType } from './types';
import { endGameWinner } from './control';

export type DrawResult<T extends string> = Card<T> | 'shuffle' | null;

/** Draws the top card. 'shuffle' means the host must first shuffle the discard pile into the deck. */
export function drawCard<T extends string>(deck: Deck<T>): DrawResult<T> {
  if (deck.draw.length) return deck.draw.shift()!;
  if (deck.discard.length) return 'shuffle';
  return null;
}

export function applyShuffle<T extends string>(deck: Deck<T>, order: number[]) {
  const n = deck.discard.length;
  if (order.length !== n || new Set(order).size !== n || order.some((i) => !Number.isInteger(i) || i < 0 || i >= n)) {
    fail('Shuffle order is not a permutation of the discard pile');
  }
  deck.draw = [...deck.draw, ...order.map((i) => deck.discard[i])];
  deck.discard = [];
}

export function sabotageTargets(state: GameState, drawer: string, type: 'sabotage' | 'sabotaged'): string[] {
  return Object.values(state.armies)
    .filter((a) => a.units.some((u) => u.type === 'supply'))
    .filter((a) => type === 'sabotaged'
      ? a.nation === drawer
      : !areFriends(state, a.nation, drawer) && areFriends(state, state.nodes[a.node].controller, drawer))
    .map((a) => a.id);
}

/**
 * Resolves an Event card. Returns true when done, false when it waits for a sabotage choice, and
 * 'deferred' when an early End Game card went back to the bottom of the deck (not discarded).
 * The End Game card sets the winner directly.
 */
export function resolveEvent(state: GameState, card: Card<EventCardType>): boolean | 'deferred' {
  const drawer = state.current;
  const nat = nation(state, drawer);
  log(state, 'log.event', { nation: drawer, event: `event.${card.type}` }, { kind: 'event', nation: drawer });
  switch (card.type) {
    case 'endGame': {
      if (state.round < state.rules.endGameFromRound) {
        // Too early: the card goes to the bottom of the event deck and the war goes on.
        state.eventDeck.draw.push(card);
        log(state, 'log.endGameDeferred', { round: state.rules.endGameFromRound }, { kind: 'event', nation: drawer });
        return 'deferred';
      }
      state.winner = endGameWinner(state);
      return true;
    }
    case 'exhaustion1': nat.warExhaustion += 1; return true;
    case 'exhaustion2': nat.warExhaustion += 2; return true;
    case 'exhaustion5': nat.warExhaustion += 5; return true;
    case 'spies': {
      const side = sideOf(state, drawer);
      state.reveals.push({ of: state.nations.filter((n) => n.side !== side).map((n) => n.id), to: side, untilTurn: state.turn + 1 });
      return true;
    }
    case 'enemySpies': {
      // Every other team sees the drawer's armies.
      const side = sideOf(state, drawer);
      const others = new Set(state.nations.filter((n) => !n.knockedOut).map((n) => sideOf(state, n.id)).filter((t) => t !== side));
      for (const to of others) state.reveals.push({ of: [drawer], to, untilTurn: state.turn + 1 });
      return true;
    }
    case 'recruit1':
    case 'recruit2':
    case 'recruitGeneral': {
      const options = recruitNodes(state, drawer);
      if (!options.length) {
        log(state, 'log.recruitNowhere', { nation: drawer }, { kind: 'event', nation: drawer });
        return true;
      }
      const general = card.type === 'recruitGeneral';
      state.pending = [{ nation: drawer, kind: 'recruit', what: general ? 'general' : 'unit', remaining: card.type === 'recruit2' ? 2 : 1, options }];
      return false;
    }
    case 'sabotage':
    case 'sabotaged': {
      const options = sabotageTargets(state, drawer, card.type);
      if (!options.length) return true;
      state.pending = [{ nation: drawer, kind: 'sabotage', options }];
      return false;
    }
    case 'nothing': return true;
  }
}

/** Nodes a nation can recruit in: owned and controlled by it, with no other nation's army there. */
export function recruitNodes(state: GameState, nationId: string): string[] {
  const blocked = new Set(Object.values(state.armies).filter((a) => a.nation !== nationId).map((a) => a.node));
  return Object.values(state.nodes)
    .filter((n) => n.owner === nationId && n.controller === nationId && !blocked.has(n.id))
    .map((n) => n.id);
}

/** The nation's army on a node (the first one, if there are several), or a new army there. */
function armyToJoin(state: GameState, nat: string, node: string): Army {
  const found = Object.values(state.armies).find((x) => x.nation === nat && x.node === node);
  if (found) return found;
  const id = newId(state, `${nat}-a`);
  return state.armies[id] = { id, nation: nat, node, generals: [], units: [], moved: { edges: 0, allMajor: true, bonus: 0, stopped: false } };
}

function addUnit(state: GameState, a: Army, type: UnitType) {
  // "r" keeps recruit ids apart from the map's starting units ("R.c1" vs "R.cr12").
  a.units.push({ id: `${a.id}.${type.charAt(0)}r${state.nextId++}`, type });
}

/** Units a nation has in the field (supply wagons included, generals not). */
export function unitCount(state: GameState, nationId: string): number {
  return Object.values(state.armies).filter((a) => a.nation === nationId).reduce((sum, a) => sum + a.units.length, 0);
}

/** A town must be worth more than this many victory points to muster in. */
export const MUSTER_MIN_VP = 5;

/**
 * Towns a nation can muster in: its own free towns worth more than 5 victory points. A nation with
 * none of those to use may muster in any of its free towns worth at least 1 victory point.
 */
export function musterNodes(state: GameState, nationId: string): string[] {
  const towns = recruitNodes(state, nationId).filter((id) => state.nodes[id].vp > 0);
  const major = towns.filter((id) => state.nodes[id].vp > MUSTER_MIN_VP);
  return major.length ? major : towns;
}

/** Why the nation cannot muster now, or null when it can. */
export function musterBlocked(state: GameState, nationId: string): 'used' | 'cap' | 'noTown' | null {
  if (state.mustered) return 'used';
  if (unitCount(state, nationId) >= nation(state, nationId).unitCap) return 'cap';
  if (!musterNodes(state, nationId).length) return 'noTown';
  return null;
}

/** Once per turn, below its unit cap, a nation raises one unit in a town worth more than 5 VP. */
export function applyMuster(state: GameState, nationId: string, node: string, type: UnitType) {
  if (state.current !== nationId) fail('Not your turn');
  const blocked = musterBlocked(state, nationId);
  if (blocked === 'used') fail('You have already mustered a unit this turn');
  if (blocked === 'cap') fail('Your nation has reached its unit cap');
  if (!musterNodes(state, nationId).includes(node)) fail('Muster only in your own free towns worth more than 5 VP (or, if you have none, worth at least 1 VP)');
  if (!UNIT_TYPES.includes(type)) fail('Choose a unit type');
  addUnit(state, armyToJoin(state, nationId, node), type);
  state.mustered = true;
  log(state, 'log.muster', { nation: nationId, unit: `unit.${type}`, node }, { kind: 'event', nation: nationId, node, side: sideOf(state, nationId) });
}

/**
 * Places one recruit. New units and generals join the nation's army on that node (the first one,
 * if there are several), or form a new army there.
 */
export function applyRecruit(state: GameState, node: string, unitType: UnitType | null) {
  const p = state.pending.find((x) => x.kind === 'recruit');
  if (!p || p.kind !== 'recruit') fail('No recruit pending');
  if (!p.options.includes(node)) fail('Recruit only in your own towns');
  if (p.what === 'unit' && (!unitType || !UNIT_TYPES.includes(unitType))) fail('Choose a unit type');
  const nat = p.nation;
  const a = armyToJoin(state, nat, node);
  if (p.what === 'general') {
    const gid = newId(state, `${nat}-g`);
    state.generals[gid] = { id: gid, name: '', nation: nat };
    a.generals.push(gid);
    log(state, 'log.recruitGeneral', { nation: nat, node }, { kind: 'event', nation: nat, node, side: sideOf(state, nat) });
  } else {
    addUnit(state, a, unitType!);
    log(state, 'log.recruitUnit', { nation: nat, unit: `unit.${unitType}`, node }, { kind: 'event', nation: nat, node, side: sideOf(state, nat) });
  }
  p.remaining -= 1;
  if (p.remaining <= 0) state.pending = [];
}

export function applySabotage(state: GameState, armyId: string) {
  const p = state.pending.find((x) => x.kind === 'sabotage');
  if (!p || p.kind !== 'sabotage' || !p.options.includes(armyId)) fail('Not a valid sabotage target');
  const a = state.armies[armyId];
  const idx = a.units.findIndex((u) => u.type === 'supply');
  a.units.splice(idx, 1);
  log(state, 'log.sabotage', { army: a.id }, { kind: 'event', nation: a.nation, node: a.node });
  if (!a.units.length && !a.generals.length) removeArmy(state, a.id, 'reason.sabotaged');
  state.pending = [];
}
