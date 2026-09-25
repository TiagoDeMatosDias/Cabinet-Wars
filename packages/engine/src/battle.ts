import type {
  Army, Battle, BattleChoice, BattleReport, BattleRole, BattleRound, BattleSideReport, CardPlacement, Duel, GameState, GeneralCardType,
  NodeId, PlacedCard, Team, UnitType,
} from './types';
import { GENERAL_SPEED, UNIT_SPEED } from './types';
import {
  army, combatUnits, diceFor, distances, edgeType, enemyArmiesAdjacent, fail, fitsSpeed, log, neighbors, removeArmy, sideOf,
} from './graph';
import { canEnter } from './movement';
import { liberate } from './control';
import { visibleNodes } from './view';

export const BATTLE_CARDS: GeneralCardType[] = ['roll+1', 'roll+2', 'roll-1', 'retreat', 'blockRetreat'];
/** Cards put on dice after the roll. */
export const ROLL_CARDS: GeneralCardType[] = ['roll+1', 'roll+2', 'roll-1'];
export const ROLL_MOD: Partial<Record<GeneralCardType, number>> = { 'roll+1': 1, 'roll+2': 2, 'roll-1': -1 };
export const RETREAT_DISTANCE = 2;

export const other = (r: BattleRole): BattleRole => (r === 'attacker' ? 'defender' : 'attacker');
const ROLES: BattleRole[] = ['attacker', 'defender'];

export function battleArmy(state: GameState, b: Battle, role: BattleRole): Army {
  return army(state, role === 'attacker' ? b.attackerArmy : b.defenderArmy);
}

export function battleNation(state: GameState, b: Battle, role: BattleRole): string {
  return battleArmy(state, b, role).nation;
}

export function roleOf(state: GameState, nationId: string): BattleRole | null {
  const b = state.battle;
  if (!b) return null;
  if (battleNation(state, b, 'attacker') === nationId) return 'attacker';
  if (battleNation(state, b, 'defender') === nationId) return 'defender';
  return null;
}

/** Starts a battle; returns the teams that see it. */
export function startBattle(state: GameState, attackerArmy: string, defenderArmy: string): Team[] {
  const a = army(state, attackerArmy);
  const d = army(state, defenderArmy);
  const involved = [...new Set([sideOf(state, a.nation), sideOf(state, d.nation)])];
  // Teams that can see either army's node watch the battle; the rest never learn of it.
  const teams = new Set(state.nations.filter((n) => !n.knockedOut).map((n) => sideOf(state, n.id)));
  const witnesses = [...teams].filter((t) => {
    if (involved.includes(t)) return true;
    const seen = visibleNodes(state, t);
    return seen.has(a.node) || seen.has(d.node);
  });
  const side = (x: Army) => ({ nation: x.nation, units: x.units.map((u) => u.type), generals: x.generals.length });
  state.phase = 'battle';
  state.battle = {
    id: `${state.turn}:${attackerArmy}:${defenderArmy}`,
    node: d.node,
    attackerArmy,
    defenderArmy,
    start: { attacker: side(a), defender: side(d) },
    involved,
    witnesses,
    retreated: [],
    step: 'select',
    round: 0,
    units: { attacker: [], defender: [] },
    targets: [],
    choice: { attacker: null, defender: null },
    dice: null,
    cards: { attacker: null, defender: null },
    lastRound: null,
    retreats: [],
    lost: { attacker: [], defender: [] },
  };
  log(state, 'log.battle', { node: d.node, nation: a.nation, army: a.id, defNation: d.nation, defArmy: d.id }, { kind: 'battle', nation: a.nation, node: d.node });
  beginRound(state);
  return witnesses;
}

/** How many units a side fights with each round: set by its number of combat units (README table). */
export function diceCount(state: GameState, role: BattleRole): number {
  return diceFor(combatUnits(battleArmy(state, state.battle!, role)).length);
}

/** Destroys armies left without combat units. Returns true when the battle is over because of it. */
function removeBeaten(state: GameState): boolean {
  const b = state.battle!;
  const zero = ROLES.filter((r) => combatUnits(battleArmy(state, b, r)).length === 0);
  for (const r of zero) removeArmy(state, battleArmy(state, b, r).id, 'reason.noCombatUnits');
  return zero.length > 0;
}

/** Step 1: the host picks the fighting units, and whom each attacking unit faces, at random. */
function beginRound(state: GameState) {
  const b = state.battle!;
  if (removeBeaten(state)) { endBattle(state); return; }
  b.round += 1;
  b.step = 'select';
  b.units = { attacker: [], defender: [] };
  b.targets = [];
  b.choice = { attacker: null, defender: null };
  b.dice = null;
  b.cards = { attacker: null, defender: null };
  state.pending = [];
  const att = combatUnits(battleArmy(state, b, 'attacker')).length;
  const def = combatUnits(battleArmy(state, b, 'defender')).length;
  state.oracle = { kind: 'select', attacker: att, attackerPick: diceFor(att), defender: def, defenderPick: diceFor(def) };
}

/**
 * The host's random pick: `attacker` and `defender` index the sides' combat units, `targets[i]`
 * indexes `defender` for attacking unit i. Defending units nobody faces sit the round out.
 */
export function applySelect(state: GameState, attacker: number[], defender: number[], targets: number[]) {
  const b = state.battle;
  const req = state.oracle;
  if (!b || b.step !== 'select' || req?.kind !== 'select') fail('No unit selection expected');
  const distinct = (xs: number[], n: number, pool: number) =>
    xs.length === n && new Set(xs).size === n && xs.every((i) => Number.isInteger(i) && i >= 0 && i < pool);
  if (!distinct(attacker, req.attackerPick, req.attacker) || !distinct(defender, req.defenderPick, req.defender)) fail('Bad unit selection');
  if (targets.length !== attacker.length || !targets.every((t) => Number.isInteger(t) && t >= 0 && t < defender.length)) fail('Bad targets');
  state.oracle = null;
  const att = combatUnits(battleArmy(state, b, 'attacker'));
  const def = combatUnits(battleArmy(state, b, 'defender'));
  const facing = defender.filter((_, k) => targets.includes(k));
  b.units = { attacker: attacker.map((i) => att[i].id), defender: facing.map((i) => def[i].id) };
  b.targets = targets.map((k) => facing.indexOf(defender[k]));
  b.step = 'choose';
  state.pending = ROLES.map((r) => ({ nation: battleNation(state, b, r), kind: 'battleChoice' as const }));
}

const CARD_FOR: Partial<Record<BattleChoice, GeneralCardType>> = { retreat: 'retreat', block: 'blockRetreat' };

/** Step 2: a side decides, in secret, to fight on, play Retreat or Block Retreat, or panic. */
export function chooseInBattle(state: GameState, role: BattleRole, choice: BattleChoice) {
  const b = state.battle!;
  if (b.step !== 'choose' || b.choice[role]) fail('You have already decided');
  if (!['fight', 'block', 'retreat', 'panic'].includes(choice)) fail('Not a battle choice');
  const nat = battleNation(state, b, role);
  const card = CARD_FOR[choice];
  if (card && !state.hands[nat].some((c) => c.type === card)) fail('You have no {card} card', { card });
  b.choice[role] = choice;
  state.pending = state.pending.filter((p) => p.nation !== nat);
  if (b.choice.attacker && b.choice.defender) resolveChoices(state);
}

/**
 * Both choices are revealed. An unblocked Retreat card ends the battle and the army falls back; an
 * unblocked panic costs one of the fighting units first. Block Retreat stops the enemy's retreat or
 * panic from doing anything. Otherwise the dice are rolled.
 */
function resolveChoices(state: GameState) {
  const b = state.battle!;
  const choices = { attacker: b.choice.attacker as BattleChoice, defender: b.choice.defender as BattleChoice };
  for (const r of ROLES) {
    const card = CARD_FOR[choices[r]];
    if (!card) continue;
    const nat = battleNation(state, b, r);
    const i = state.hands[nat].findIndex((c) => c.type === card);
    state.generalDeck.discard.push(...state.hands[nat].splice(i, 1));
  }
  const leaving: BattleRole[] = [];
  for (const r of ROLES) {
    if (choices[r] !== 'retreat' && choices[r] !== 'panic') continue;
    const a = battleArmy(state, b, r);
    if (choices[other(r)] === 'block') {
      log(state, 'log.retreatBlocked', { nation: a.nation }, { kind: 'battle', nation: a.nation, node: a.node });
      continue;
    }
    leaving.push(r);
  }
  const types = typesOf(state, b);
  for (const r of leaving) {
    const a = battleArmy(state, b, r);
    if (choices[r] === 'panic') {
      log(state, 'log.panic', { nation: a.nation, army: a.id }, { kind: 'battle', nation: a.nation, node: a.node });
      destroyUnits(state, r, [b.units[r][0]]);
      log(state, 'log.panicLosses', { army: a.id, count: 1 }, { kind: 'battle', nation: a.nation, node: a.node });
    } else {
      log(state, 'log.retreats', { nation: a.nation }, { kind: 'battle', nation: a.nation, node: a.node });
    }
  }
  if (!leaving.length) {
    b.step = 'roll';
    state.oracle = { kind: 'roll', attacker: b.units.attacker.length, defender: b.units.defender.length };
    return;
  }
  b.lastRound = { round: b.round, units: b.units, types, targets: b.targets, choices, dice: null, cards: { attacker: [], defender: [] }, duels: [] };
  state.pending = [];
  if (removeBeaten(state)) { endBattle(state); return; }
  b.retreats = leaving;
  nextRetreat(state);
}

function typesOf(state: GameState, b: Battle): Record<BattleRole, UnitType[]> {
  const typeIn = (r: BattleRole) => (id: string) => battleArmy(state, b, r).units.find((u) => u.id === id)!.type;
  return { attacker: b.units.attacker.map(typeIn('attacker')), defender: b.units.defender.map(typeIn('defender')) };
}

function destroyUnits(state: GameState, role: BattleRole, ids: string[]) {
  const b = state.battle!;
  const a = battleArmy(state, b, role);
  for (const u of a.units) if (ids.includes(u.id)) b.lost[role].push(u.type);
  a.units = a.units.filter((u) => !ids.includes(u.id));
}

/** Step 3: one die per fighting unit. Sides holding roll cards may then put them on dice. */
export function applyRoll(state: GameState, attacker: number[], defender: number[]) {
  const b = state.battle;
  const req = state.oracle;
  if (!b || b.step !== 'roll' || req?.kind !== 'roll') fail('No roll expected');
  if (attacker.length !== req.attacker || defender.length !== req.defender) fail('Wrong number of dice');
  for (const v of [...attacker, ...defender]) if (!Number.isInteger(v) || v < 1 || v > 6) fail('Bad die value');
  state.oracle = null;
  b.dice = { attacker, defender };
  b.step = 'cards';
  const node = battleArmy(state, b, 'defender').node;
  log(state, 'log.dice', { attackerDice: attacker.join(', '), defenderDice: defender.join(', ') }, { kind: 'battle', node });
  state.pending = [];
  for (const r of ROLES) {
    const nat = battleNation(state, b, r);
    if (state.hands[nat].some((c) => ROLL_CARDS.includes(c.type))) state.pending.push({ nation: nat, kind: 'battleCards' });
    else b.cards[r] = [];
  }
  if (!state.pending.length) resolveRound(state);
}

/** A side puts its roll cards on dice (its own or the enemy's), face down until both are done. */
export function submitCards(state: GameState, role: BattleRole, placements: CardPlacement[]) {
  const b = state.battle!;
  if (b.step !== 'cards' || b.cards[role]) fail('Cards already played');
  const nat = battleNation(state, b, role);
  const hand = state.hands[nat];
  const ids = placements.map((p) => p.cardId);
  if (new Set(ids).size !== ids.length) fail('Duplicate card');
  const placed: PlacedCard[] = placements.map((p) => {
    const card = hand.find((c) => c.id === p.cardId) ?? fail('Card {card} is not in your hand', { card: p.cardId });
    if (!ROLL_CARDS.includes(card.type)) fail('{card} cannot be put on a die', { card: card.type });
    if (p.role !== 'attacker' && p.role !== 'defender') fail('Bad die owner');
    if (!Number.isInteger(p.die) || p.die < 0 || p.die >= b.dice![p.role].length) fail('Bad die index');
    return { cardId: p.cardId, role: p.role, die: p.die, type: card.type };
  });
  state.hands[nat] = hand.filter((c) => !ids.includes(c.id));
  b.cards[role] = placed;
  state.pending = state.pending.filter((p) => p.nation !== nat);
  if (!state.pending.length) resolveRound(state);
}

/** Cavalry beats artillery, infantry beats cavalry, artillery beats infantry. */
export const TYPE_ADVANTAGE: Partial<Record<UnitType, UnitType>> = { cavalry: 'artillery', infantry: 'cavalry', artillery: 'infantry' };
export const TYPE_BONUS = 1;

/** +1 when a unit fights a unit type it has the advantage over. */
export function typeBonus(unit: UnitType | undefined, opponents: (UnitType | undefined)[]): number {
  const beats = unit && TYPE_ADVANTAGE[unit];
  return beats && opponents.includes(beats) ? TYPE_BONUS : 0;
}

/**
 * Scores every duel: each attacking unit's die against the die of the unit it faces, plus roll
 * cards and type bonuses. The higher total wins; ties go to the defender. The loser is destroyed.
 */
export function scoreDuels(
  types: Record<BattleRole, (UnitType | undefined)[]>,
  units: Record<BattleRole, string[]>,
  targets: number[],
  dice: Record<BattleRole, number[]>,
  cards: PlacedCard[],
): Duel[] {
  const mod = (role: BattleRole, die: number) => cards.filter((p) => p.role === role && p.die === die).reduce((s, p) => s + (ROLL_MOD[p.type] ?? 0), 0);
  return targets.map((j, i) => {
    const attackerBonus = typeBonus(types.attacker[i], [types.defender[j]]);
    const defenderBonus = typeBonus(types.defender[j], [types.attacker[i]]);
    const attackerPoints = dice.attacker[i] + mod('attacker', i) + attackerBonus;
    const defenderPoints = dice.defender[j] + mod('defender', j) + defenderBonus;
    const winner: BattleRole = attackerPoints > defenderPoints ? 'attacker' : 'defender';
    return {
      attacker: i, defender: j, attackerPoints, defenderPoints, attackerBonus, defenderBonus, winner,
      destroyed: winner === 'attacker' ? units.defender[j] : units.attacker[i],
    };
  });
}

/** Step 4: cards revealed, duels scored, losers destroyed; then the next round. */
function resolveRound(state: GameState) {
  const b = state.battle!;
  const cards = { attacker: b.cards.attacker ?? [], defender: b.cards.defender ?? [] };
  const types = typesOf(state, b);
  const duels = scoreDuels(types, b.units, b.targets, b.dice!, [...cards.attacker, ...cards.defender]);
  for (const r of ROLES) destroyUnits(state, r, duels.filter((d) => d.winner !== r).map((d) => d.destroyed));
  for (const r of ROLES) for (const p of cards[r]) state.generalDeck.discard.push({ id: p.cardId, type: p.type });
  b.lastRound = {
    round: b.round, units: b.units, types, targets: b.targets,
    choices: { attacker: b.choice.attacker as BattleChoice, defender: b.choice.defender as BattleChoice },
    dice: b.dice, cards, duels,
  };
  const node = battleArmy(state, b, 'defender').node;
  log(state, 'log.round', { battleRound: b.round, results: duels.map((d) => `${d.attackerPoints}:${d.defenderPoints}:${d.winner}`).join('|') }, { kind: 'battle', node });
  state.pending = [];
  beginRound(state);
}

/** Where the enemy army of the current battle stands (retreats must get away from it). */
function enemyNodeOf(state: GameState, a: Army): NodeId | null {
  const b = state.battle;
  if (!b) return null;
  const otherId = b.attackerArmy === a.id ? b.defenderArmy : b.defenderArmy === a.id ? b.attackerArmy : null;
  return (otherId && state.armies[otherId]?.node) || null;
}

function allMajorPath(state: GameState, from: NodeId, path: NodeId[]): boolean {
  let prev = from;
  for (const n of path) { if (edgeType(state, prev, n) !== 'major') return false; prev = n; }
  return true;
}

/** Units of an army fast enough to follow a retreat path. */
export function retreatSurvivors(state: GameState, a: Army, path: NodeId[]) {
  const allMajor = allMajorPath(state, a.node, path);
  return a.units.filter((u) => fitsSpeed(path.length, allMajor, UNIT_SPEED[u.type] + a.moved.bonus));
}

/** Whether the army's generals can keep up with a retreat path (they ride at cavalry speed). */
export function generalsSurvive(state: GameState, a: Army, path: NodeId[]): boolean {
  return a.generals.length > 0 && fitsSpeed(path.length, allMajorPath(state, a.node, path), GENERAL_SPEED + a.moved.bonus);
}

export interface RetreatPlan {
  path: NodeId[];
  /** Graph distance from the enemy army after retreating. */
  distance: number;
  /** Members (units and generals) fast enough to make it. */
  survivors: number;
  /** All members of the army. */
  total: number;
}

/**
 * The retreat an army makes: exactly 2 nodes, through nodes it may enter, to the node farthest
 * from the enemy army. Ties go to the route that saves the most members, then to a node its side
 * controls, then to the lowest node id. Null when no route saves anyone: the army is destroyed.
 */
export function retreatPlan(state: GameState, a: Army): RetreatPlan | null {
  const enemy = enemyNodeOf(state, a);
  const dist = enemy ? distances(state, [enemy]) : new Map<NodeId, number>();
  const friendly = (n: NodeId) => sideOf(state, state.nodes[n].controller) === sideOf(state, a.nation);
  const total = a.units.length + a.generals.length;
  let best: RetreatPlan | null = null;
  const better = (x: RetreatPlan, y: RetreatPlan | null) => {
    if (!y) return true;
    if (x.distance !== y.distance) return x.distance > y.distance;
    if (x.survivors !== y.survivors) return x.survivors > y.survivors;
    const fx = friendly(x.path[1]);
    const fy = friendly(y.path[1]);
    if (fx !== fy) return fx;
    return x.path.join() < y.path.join();
  };
  for (const n1 of neighbors(state, a.node)) {
    if (!canEnter(state, a, n1.node)) continue;
    for (const n2 of neighbors(state, n1.node)) {
      if (n2.node === a.node || !canEnter(state, a, n2.node)) continue;
      const path = [n1.node, n2.node];
      const survivors = retreatSurvivors(state, a, path).length + (generalsSurvive(state, a, path) ? a.generals.length : 0);
      if (!survivors) continue;
      const plan = { path, distance: dist.get(n2.node) ?? Infinity, survivors, total };
      if (better(plan, best)) best = plan;
    }
  }
  return best;
}

function nextRetreat(state: GameState) {
  const b = state.battle!;
  const role = b.retreats[0];
  if (!role) { endBattle(state); return; }
  const a = battleArmy(state, b, role);
  b.step = 'retreat';
  const plan = retreatPlan(state, a);
  if (!plan) {
    b.retreats.shift();
    removeArmy(state, a.id, 'reason.noRoute');
    // The other side's retreat is moot once its opponent is gone.
    endBattle(state);
    return;
  }
  // Members would be left behind and a +1 Moves card could save them: let the player decide first.
  const canHelp = plan.survivors < plan.total && state.hands[a.nation]?.some((c) => c.type === 'moves+1');
  if (canHelp) {
    state.pending = [{ nation: a.nation, kind: 'retreat', army: a.id }];
    return;
  }
  performRetreat(state, a, plan.path);
}

function performRetreat(state: GameState, a: Army, path: NodeId[]) {
  const b = state.battle!;
  const survivors = retreatSurvivors(state, a, path);
  const keepGenerals = generalsSurvive(state, a, path);
  const lost = a.units.length - survivors.length;
  const role = b.retreats[0];
  for (const u of a.units) if (!survivors.includes(u)) b.lost[role].push(u.type);
  a.units = survivors;
  if (!keepGenerals) for (const g of a.generals.splice(0)) delete state.generals[g];
  for (const n of path) liberate(state, a, n);
  a.node = path[path.length - 1];
  a.moved.stopped = true;
  b.retreated.push(role);
  log(state, lost ? 'log.retreatedToLost' : 'log.retreatedTo', { army: a.id, node: a.node, lost }, { kind: 'battle', nation: a.nation, node: a.node });
  b.retreats.shift();
  nextRetreat(state);
}

/** The player confirms the retreat (after possibly playing +1 Moves): it goes to the planned node. */
export function retreat(state: GameState) {
  const b = state.battle!;
  const a = battleArmy(state, b, b.retreats[0]);
  const plan = retreatPlan(state, a);
  if (!plan) {
    b.retreats.shift();
    removeArmy(state, a.id, 'reason.noRoute');
    endBattle(state);
    return;
  }
  performRetreat(state, a, plan.path);
}

/** What happened in the battle, logged for everyone who watched it. */
function report(state: GameState, b: Battle): BattleReport {
  const side = (r: BattleRole): BattleSideReport => {
    const start = b.start[r];
    const alive = Boolean(state.armies[r === 'attacker' ? b.attackerArmy : b.defenderArmy]);
    const fate = !alive ? 'destroyed' : b.retreated.includes(r) ? 'retreated' : 'held';
    return {
      nation: start.nation, army: r === 'attacker' ? b.attackerArmy : b.defenderArmy, units: start.units, generals: start.generals,
      lost: fate === 'destroyed' ? [...start.units] : [...b.lost[r]], fate,
    };
  };
  const attacker = side('attacker');
  const defender = side('defender');
  const winner = attacker.fate === 'held' && defender.fate !== 'held' ? 'attacker'
    : defender.fate === 'held' && attacker.fate !== 'held' ? 'defender' : null;
  return { id: b.id, node: b.node, rounds: b.round, attacker, defender, winner, finalRound: b.lastRound };
}

export function endBattle(state: GameState) {
  const b = state.battle;
  if (b) {
    const r = report(state, b);
    const params: Record<string, string> = { node: r.node };
    if (r.winner) params.nation = r[r.winner].nation;
    log(state, r.winner ? 'log.battleWon' : 'log.battleDrawn', params, { kind: 'battle', node: r.node, nation: r.winner ? r[r.winner].nation : undefined, report: r });
  }
  state.battle = null;
  state.pending = [];
  const q = state.battleQueue;
  if (q && state.armies[q.attacker]) {
    const adjacent = new Set(enemyArmiesAdjacent(state, state.armies[q.attacker]).map((a) => a.id));
    q.defenders = q.defenders.filter((d) => adjacent.has(d));
    if (q.defenders.length === 1) {
      const [d] = q.defenders;
      state.battleQueue = null;
      startBattle(state, q.attacker, d);
      return;
    }
    if (q.defenders.length > 1) {
      state.phase = 'battle';
      state.pending = [{ nation: state.armies[q.attacker].nation, kind: 'chooseBattle', options: [...q.defenders] }];
      return;
    }
  }
  state.battleQueue = null;
  state.phase = 'movement';
}

/**
 * Version 2: finds two enemy armies standing next to each other (after a recruit, a retreat, or
 * from the map's set-up) and asks the host which of them attacks. Returns true if it did.
 */
export function standingBattle(state: GameState): boolean {
  const armies = Object.values(state.armies).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  for (const a of armies) {
    const enemy = enemyArmiesAdjacent(state, a).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))[0];
    if (!enemy) continue;
    state.oracle = { kind: 'engage', armies: [a.id, enemy.id] };
    return true;
  }
  return false;
}

/** The host's pick: `attacker` (0 or 1) indexes the two armies of the engage request. */
export function applyEngage(state: GameState, attacker: number) {
  const req = state.oracle;
  if (req?.kind !== 'engage') fail('No engagement expected');
  if (attacker !== 0 && attacker !== 1) fail('Bad engagement pick');
  state.oracle = null;
  const att = army(state, req.armies[attacker]);
  const def = army(state, req.armies[1 - attacker]);
  const at = state.history.length;
  const witnesses = startBattle(state, att.id, def.id);
  // Logged after the battle has its witnesses (who alone may see it), then put before the battle's entries.
  log(state, 'log.standoff', { nation: att.nation, army: att.id, defNation: def.nation, defArmy: def.id, node: def.node }, { kind: 'battle', nation: att.nation, node: def.node, teams: witnesses });
  state.history.splice(at, 0, state.history.pop()!);
}

export function queueBattles(state: GameState, attacker: string, defenders: string[]) {
  state.battleQueue = { attacker, defenders };
  if (defenders.length === 1) {
    state.battleQueue = null;
    startBattle(state, attacker, defenders[0]);
  } else {
    state.phase = 'battle';
    state.pending = [{ nation: state.armies[attacker].nation, kind: 'chooseBattle', options: [...defenders] }];
  }
}

export function chooseBattle(state: GameState, defender: string) {
  const q = state.battleQueue ?? fail('No battle to choose');
  if (!q.defenders.includes(defender)) fail('Not an adjacent enemy');
  q.defenders = q.defenders.filter((d) => d !== defender);
  startBattle(state, q.attacker, defender);
}
