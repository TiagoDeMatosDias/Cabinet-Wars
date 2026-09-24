import type { GameState, NationId, NodeId, Team } from './types';
import { distances, sideOf } from './graph';

export interface GameView extends GameState {
  /** Sides whose private information this view contains. */
  viewer: Team[];
  counts: {
    generalDraw: number;
    eventDraw: number;
    hands: Record<NationId, number>;
    /** Roll cards each side has put on dice this round (face down until the reveal). */
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
  // The two armies of a battle this side watches stay in view while it lasts.
  const watched = state.battle && state.battle.witnesses.includes(side);
  const inBattle = new Set(watched ? [state.battle!.attackerArmy, state.battle!.defenderArmy] : []);
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
      attacker: state.battle?.cards.attacker?.length ?? 0,
      defender: state.battle?.cards.defender?.length ?? 0,
    },
  };
  view.generalDeck.draw = [];
  view.eventDeck.draw = [];
  const all = sides.length > 1;
  for (const nat of Object.keys(view.hands)) if (!all && !seats.includes(nat)) view.hands[nat] = [];

  if (view.battle && !all) {
    const b = view.battle;
    const side = sides[0];
    const fighting = seats.some((n) => n === b.start.attacker.nation || n === b.start.defender.nation);
    if (!b.witnesses.includes(side)) {
      // A battle in the fog: this side knows nothing of it.
      view.battle = null;
      view.battleQueue = null;
    } else if (!fighting) {
      // Onlookers see that there is a battle, and its losses, but not how it is fought.
      b.units = { attacker: [], defender: [] };
      b.targets = [];
      b.choice = { attacker: null, defender: null };
      b.dice = null;
      b.cards = { attacker: null, defender: null };
      b.lastRound = null;
      view.battleQueue = null;
      view.counts.committed = { attacker: 0, defender: 0 };
    }
  }
  if (view.battle && !all) {
    const b = view.battle;
    // A side's choice and its roll cards stay secret until both sides have made theirs.
    for (const role of ['attacker', 'defender'] as const) {
      const armyId = role === 'attacker' ? b.attackerArmy : b.defenderArmy;
      const owner = state.armies[armyId]?.nation;
      if (!owner || seats.includes(owner)) continue;
      if (b.step === 'choose' && b.choice[role]) b.choice[role] = 'hidden';
      if (b.step === 'cards') b.cards[role] = null;
    }
  }

  if (!all) {
    const side = sides[0];
    const visible = visibleArmies(state, side);
    for (const id of Object.keys(view.armies)) if (!visible.has(id)) delete view.armies[id];
    view.history = view.history.filter((h) => (!h.side || h.side === side) && (!h.teams || h.teams.includes(side))
      && (!h.nations || seats.some((n) => h.nations!.includes(n))));
    // How a battle was fought stays with those who fought it.
    for (const e of view.history) {
      if (e.report && !seats.some((n) => n === e.report!.attacker.nation || n === e.report!.defender.nation)) delete e.report.finalRound;
    }
    if (view.turnEnd && sideOf(state, state.current) !== side) view.turnEnd.attrition = [];
  }
  return view;
}
