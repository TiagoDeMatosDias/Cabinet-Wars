import type { BattleChoice, CardPlacement, GameState, NationId, NodeId, Prompt, UnitType } from './types';
import { fail, log, nation, removeArmy, sideOf } from './graph';
import { mergeArmies, moveArmy, resetMovement, splitArmy, transferArmies, type TransferGroup } from './movement';
import { applyRoll, applySelect, chooseBattle, chooseInBattle, queueBattles, retreat, roleOf, submitCards } from './battle';
import { unsuppliedArmies } from './supply';
import { checkVictory, finish, updateControl } from './control';
import { applyMuster, applyRecruit, applySabotage, applyShuffle, drawCard, resolveEvent } from './decks';
import { playMovesCard } from './orders';

export type Intent =
  | { type: 'move'; army: string; path: NodeId[] }
  | { type: 'split'; army: string; units: string[]; generals: string[] }
  | { type: 'merge'; into: string; from: string }
  | { type: 'transfer'; groups: TransferGroup[] }
  | { type: 'playMoves'; army: string; card: string }
  | { type: 'endTurn' }
  | { type: 'chooseBattle'; defender: string }
  /** Before the roll: fight on, play Retreat or Block Retreat, or flee in panic. */
  | { type: 'battleChoice'; choice: BattleChoice }
  /** After the roll: roll cards put on dice (possibly none). */
  | { type: 'battleCards'; cards: CardPlacement[] }
  /** Confirms a retreat; the destination is always chosen by the rules (see retreatPlan). */
  | { type: 'retreat' }
  | { type: 'attrition'; unit: string }
  | { type: 'sabotage'; army: string }
  | { type: 'recruit'; node: NodeId; unit?: UnitType }
  /** Once per turn, during movement: raise a unit in an own town worth more than 5 VP (below the unit cap). */
  | { type: 'muster'; node: NodeId; unit: UnitType };

export type OracleEntry =
  | { type: 'shuffle'; deck: 'general' | 'event'; order: number[] }
  | { type: 'roll'; attacker: number[]; defender: number[] }
  | { type: 'select'; attacker: number[]; defender: number[]; targets: number[] };

export type LogEntry =
  | { seq: number; by: NationId; intent: Intent }
  | { seq: number; by: 'host'; intent: OracleEntry };

const PROMPT_FOR: Record<Intent['type'], Prompt['kind'][]> = {
  move: ['movement'],
  split: ['movement'],
  merge: ['movement'],
  transfer: ['movement'],
  playMoves: ['movement', 'retreat'],
  endTurn: ['movement'],
  chooseBattle: ['chooseBattle'],
  battleChoice: ['battleChoice'],
  battleCards: ['battleCards'],
  retreat: ['retreat'],
  attrition: ['attrition'],
  sabotage: ['sabotage'],
  recruit: ['recruit'],
  muster: ['movement'],
};

/** Applies one log entry and runs the automatic steps that follow. Pure: returns a new state. */
export function apply(prev: GameState, entry: LogEntry): GameState {
  const state = structuredClone(prev);
  if (state.phase === 'gameOver') fail('The game is over');
  if (entry.by === 'host') applyOracle(state, entry.intent as OracleEntry);
  else applyIntent(state, entry.by, entry.intent as Intent);
  advance(state);
  return state;
}

export function replay(initial: GameState, entries: LogEntry[]): GameState {
  let s = advanceCopy(initial);
  for (const e of entries) s = apply(s, e);
  return s;
}

/** Runs the automatic steps of a fresh state (the first turn start). */
export function advanceCopy(prev: GameState): GameState {
  const state = structuredClone(prev);
  advance(state);
  return state;
}

function applyOracle(state: GameState, o: OracleEntry) {
  const req = state.oracle ?? fail('No random result expected');
  if (o.type === 'shuffle') {
    if (req.kind !== 'shuffle' || req.deck !== o.deck) fail('Unexpected shuffle');
    applyShuffle(o.deck === 'general' ? state.generalDeck : state.eventDeck, o.order);
    state.oracle = null;
  } else if (o.type === 'select') {
    applySelect(state, o.attacker, o.defender, o.targets);
  } else {
    applyRoll(state, o.attacker, o.defender);
  }
}

function applyIntent(state: GameState, by: NationId, intent: Intent) {
  if (state.oracle) fail('Waiting for the host');
  const prompt = state.pending.find((p) => p.nation === by && PROMPT_FOR[intent.type].includes(p.kind))
    ?? fail('It is not your move ({action})', { action: intent.type });
  switch (intent.type) {
    case 'move': {
      const enemies = moveArmy(state, intent.army, intent.path);
      if (enemies.length) { state.pending = []; queueBattles(state, intent.army, enemies); }
      return;
    }
    case 'split': splitArmy(state, intent.army, intent.units, intent.generals); return;
    case 'merge': mergeArmies(state, intent.into, intent.from); return;
    case 'transfer': transferArmies(state, intent.groups); return;
    case 'playMoves': {
      if (prompt.kind === 'retreat' && prompt.army !== intent.army) fail('Only the retreating army');
      playMovesCard(state, by, intent.army, intent.card);
      return;
    }
    case 'endTurn':
      state.pending = [];
      state.phase = 'turnEnd';
      state.turnEnd = { step: 'attrition', attrition: unsuppliedArmies(state, by) };
      return;
    case 'chooseBattle': state.pending = []; chooseBattle(state, intent.defender); return;
    case 'battleChoice': chooseInBattle(state, roleOf(state, by)!, intent.choice); return;
    case 'battleCards': submitCards(state, roleOf(state, by)!, intent.cards ?? []); return;
    case 'retreat': retreat(state); return;
    case 'attrition': {
      if (prompt.kind !== 'attrition') fail('No attrition pending');
      const a = state.armies[prompt.army];
      if (!a.units.some((u) => u.id === intent.unit)) fail('Unknown unit');
      loseUnit(state, a.id, intent.unit);
      state.turnEnd!.attrition.shift();
      state.pending = [];
      return;
    }
    case 'sabotage': applySabotage(state, intent.army); return;
    case 'recruit': applyRecruit(state, intent.node, intent.unit ?? null); return;
    case 'muster': applyMuster(state, by, intent.node, intent.unit); return;
  }
}

function loseUnit(state: GameState, armyId: string, unitId: string) {
  const a = state.armies[armyId];
  a.units = a.units.filter((u) => u.id !== unitId);
  log(state, 'log.attrition', { army: a.id }, { kind: 'attrition', nation: a.nation, node: a.node, side: sideOf(state, a.nation) });
  if (!a.units.length && !a.generals.length) removeArmy(state, a.id, 'reason.attrition');
}

function nextNation(state: GameState): NationId {
  const order = state.nations;
  const start = order.findIndex((n) => n.id === state.current);
  for (let i = 1; i <= order.length; i++) {
    const n = order[(start + i) % order.length];
    if (!n.knockedOut) return n.id;
  }
  return state.current;
}

/** Hands play to the next nation still in the war; wrapping around to the first starts a new round. */
function passTurn(state: GameState) {
  const order = state.nations.map((n) => n.id);
  const next = nextNation(state);
  if (order.indexOf(next) <= order.indexOf(state.current)) {
    state.round += 1;
    log(state, 'log.roundBegins', { round: state.round }, { kind: 'turn' });
  }
  state.current = next;
  state.turn += 1;
  state.phase = 'turnStart';
}

/** Performs automatic steps until a player prompt or a random result is needed. */
export function advance(state: GameState) {
  for (let guard = 0; guard < 1000; guard++) {
    if (state.phase === 'gameOver' || state.oracle || state.pending.length) return;
    switch (state.phase) {
      case 'turnStart': {
        if (!state.turnStart) {
          resetMovement(state, state.current);
          state.mustered = false;
          state.reveals = state.reveals.filter((r) => r.untilTurn >= state.turn);
          log(state, 'log.turnBegins', { nation: state.current }, { kind: 'turn', nation: state.current });
          state.turnStart = { step: 'general', event: null };
        }
        const ts = state.turnStart;
        if (ts.step === 'general') {
          const card = drawCard(state.generalDeck);
          if (card === 'shuffle') { state.oracle = { kind: 'shuffle', deck: 'general', n: state.generalDeck.discard.length }; return; }
          if (card) state.hands[state.current].push(card);
          ts.step = 'event';
          continue;
        }
        if (ts.step === 'event') {
          const card = drawCard(state.eventDeck);
          if (card === 'shuffle') { state.oracle = { kind: 'shuffle', deck: 'event', n: state.eventDeck.discard.length }; return; }
          ts.event = card;
          ts.step = 'eventResolve';
          if (card) {
            const r = resolveEvent(state, card);
            if (r === 'deferred') ts.event = null;
            else if (!r) return;
          }
          continue;
        }
        // eventResolve
        if (ts.event) state.eventDeck.discard.push(ts.event);
        state.turnStart = null;
        if (state.winner) { finish(state, state.winner); return; }
        checkVictory(state);
        if (state.winner) return;
        // The event may have knocked out the nation whose turn it is: play passes on.
        if (nation(state, state.current).knockedOut) { passTurn(state); continue; }
        state.phase = 'movement';
        state.pending = [{ nation: state.current, kind: 'movement' }];
        return;
      }
      case 'movement':
        state.pending = [{ nation: state.current, kind: 'movement' }];
        return;
      case 'battle':
        // Battles always leave a prompt or oracle behind; reaching here means it ended.
        state.phase = 'movement';
        continue;
      case 'turnEnd': {
        const te = state.turnEnd!;
        if (te.step === 'attrition') {
          const armyId = te.attrition[0];
          if (!armyId) { te.step = 'control'; continue; }
          const a = state.armies[armyId];
          if (!a) { te.attrition.shift(); continue; }
          if (!a.units.length) {
            // Only generals left: one of them is lost.
            const g = a.generals.shift()!;
            delete state.generals[g];
            log(state, 'log.attrition', { army: a.id }, { kind: 'attrition', nation: a.nation, node: a.node, side: sideOf(state, a.nation) });
            if (!a.generals.length) removeArmy(state, a.id, 'reason.attrition');
            te.attrition.shift();
            continue;
          }
          if (a.units.length === 1 || new Set(a.units.map((u) => u.type)).size === 1) {
            loseUnit(state, a.id, a.units[0].id);
            te.attrition.shift();
            continue;
          }
          state.pending = [{ nation: state.current, kind: 'attrition', army: a.id }];
          return;
        }
        if (te.step === 'control') {
          updateControl(state, state.current);
          checkVictory(state);
          if (state.winner) return;
          te.step = 'finish';
          continue;
        }
        // finish
        state.turnEnd = null;
        passTurn(state);
        continue;
      }
    }
  }
  fail('advance() did not settle');
}
