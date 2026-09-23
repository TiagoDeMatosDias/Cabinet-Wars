import type { GameState, NationId, NodeId, Team } from './types';
import { distances, sideOf } from './graph';

export interface GameView extends GameState {
  /** Sides whose private information this view contains. */
  viewer: Team[];
  counts: {
    generalDraw: number;
    eventDraw: number;
    hands: Record<NationId, number>;
    committed: Record<'attacker' | 'defender', number>;
  };
}

/**
 * Nodes a side can see into: every node its nations (or allies) own or control, the nodes where
 * its armies stand, and every node next to any of those. Everything else is under fog of war.
 */
export function visibleNodes(state: GameState, side: Team): Set<NodeId> {
  const sources = [
    ...Object.values(state.nodes).filter((n) => sideOf(state, n.controller) === side || sideOf(state, n.owner) === side).map((n) => n.id),
    ...Object.values(state.armies).filter((a) => sideOf(state, a.nation) === side).map((a) => a.node),
  ];
  return new Set(distances(state, sources, 1).keys());
}

/** Armies of other sides that a side can currently see. */
export function visibleArmies(state: GameState, side: Team): Set<string> {
  const seen = visibleNodes(state, side);
  const revealed = new Set(state.reveals.filter((r) => r.to === side).flatMap((r) => r.of));
  const inBattle = new Set(state.battle ? [state.battle.attackerArmy, state.battle.defenderArmy] : []);
  const out = new Set<string>();
  for (const a of Object.values(state.armies)) {
    if (sideOf(state, a.nation) === side || seen.has(a.node) || revealed.has(a.nation) || inBattle.has(a.id)) out.add(a.id);
  }
  return out;
}

/**
 * Strips what the given seats must not know: deck order, other hands, face-down battle cards
 * and enemy armies hidden by fog of war. Seats spanning both sides (hotseat) see everything
 * except the deck order.
 */
export function filterForSeats(state: GameState, seats: NationId[]): GameView {
  const view = structuredClone(state) as GameView;
  const sides = [...new Set(seats.map((s) => sideOf(state, s)))];
  view.viewer = sides;
  view.counts = {
    generalDraw: state.generalDeck.draw.length,
    eventDraw: state.eventDeck.draw.length,
    hands: Object.fromEntries(Object.entries(state.hands).map(([k, v]) => [k, v.length])),
    committed: {
      attacker: state.battle?.committed.attacker?.length ?? 0,
      defender: state.battle?.committed.defender?.length ?? 0,
    },
  };
  view.generalDeck.draw = [];
  view.eventDeck.draw = [];
  const all = sides.length > 1;
  for (const nat of Object.keys(view.hands)) if (!all && !seats.includes(nat)) view.hands[nat] = [];

  if (view.battle && !all) {
    const b = view.battle;
    // Committed units, rolls and die plans stay secret until both sides planned; cards until the reveal.
    const planHidden = b.step === 'units' || b.step === 'roll' || b.step === 'plan';
    for (const role of ['attacker', 'defender'] as const) {
      const armyId = role === 'attacker' ? b.attackerArmy : b.defenderArmy;
      const owner = state.armies[armyId]?.nation;
      if (!owner || seats.includes(owner)) continue;
      if (planHidden && b.units[role]) b.units[role] = b.units[role]!.map(() => '?');
      if (planHidden) {
        if (b.dice) b.dice[role] = b.dice[role].map(() => 0);
        if (b.plan[role]) b.plan[role] = { units: [], cards: [] };
      } else if (b.plan[role]) {
        b.plan[role] = { ...b.plan[role]!, cards: b.plan[role]!.cards.map(() => ({ cardId: '?' })) };
      }
      if (b.committed[role]) b.committed[role] = b.committed[role]!.map(() => ({ id: '?', type: 'retreat' as const }));
    }
  }

  if (!all) {
    const side = sides[0];
    const visible = visibleArmies(state, side);
    for (const id of Object.keys(view.armies)) if (!visible.has(id)) delete view.armies[id];
    view.history = view.history.filter((h) => !h.side || h.side === side);
    if (view.turnEnd && sideOf(state, state.current) !== side) view.turnEnd.attrition = [];
  }
  return view;
}
