import type {
  Army, Battle, BattleRole, CardPlacement, DieResult, GameState, GeneralCardType, NodeId, UnitType,
} from './types';
import { GENERAL_SPEED, UNIT_SPEED } from './types';
import {
  army, combatUnits, diceFor, distances, edgeType, enemyArmiesAdjacent, fail, fitsSpeed, log, neighbors, removeArmy, sideOf,
} from './graph';
import { canEnter } from './movement';
import { liberate } from './control';

export const BATTLE_CARDS: GeneralCardType[] = ['roll+1', 'roll+2', 'roll-1', 'retreat', 'blockRetreat'];
const ROLL_MOD: Partial<Record<GeneralCardType, number>> = { 'roll+1': 1, 'roll+2': 2, 'roll-1': -1 };
export const RETREAT_DISTANCE = 2;

export const other = (r: BattleRole): BattleRole => (r === 'attacker' ? 'defender' : 'attacker');

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

export function startBattle(state: GameState, attackerArmy: string, defenderArmy: string) {
  state.phase = 'battle';
  state.battle = {
    attackerArmy,
    defenderArmy,
    step: 'units',
    round: 0,
    units: { attacker: null, defender: null },
    dice: null,
    plan: { attacker: null, defender: null },
    committed: { attacker: null, defender: null },
    defenderAssign: null,
    lastRound: null,
    retreats: [],
  };
  const a = army(state, attackerArmy);
  const d = army(state, defenderArmy);
  log(state, 'log.battle', { node: d.node, nation: a.nation, army: a.id, defNation: d.nation, defArmy: d.id }, { kind: 'battle', nation: a.nation, node: d.node });
  beginRound(state);
}

/** Dice a side rolls this round: set by its number of combat units (README table). */
export function diceCount(state: GameState, role: BattleRole): number {
  return diceFor(combatUnits(battleArmy(state, state.battle!, role)).length);
}

/** Step 1–2: both sides commit one combat unit per die they will roll, face down. */
function beginRound(state: GameState) {
  const b = state.battle!;
  const zero = (['attacker', 'defender'] as const).filter((r) => combatUnits(battleArmy(state, b, r)).length === 0);
  if (zero.length) {
    for (const r of zero) removeArmy(state, battleArmy(state, b, r).id, 'reason.noCombatUnits');
    endBattle(state);
    return;
  }
  b.round += 1;
  b.step = 'units';
  b.units = { attacker: null, defender: null };
  b.dice = null;
  b.plan = { attacker: null, defender: null };
  b.committed = { attacker: null, defender: null };
  b.defenderAssign = null;
  state.pending = (['attacker', 'defender'] as const).map((r) => ({
    nation: battleNation(state, b, r), kind: 'battleUnits' as const, count: diceCount(state, r),
  }));
}

export function commitUnits(state: GameState, role: BattleRole, unitIds: string[]) {
  const b = state.battle!;
  if (b.step !== 'units' || b.units[role]) fail('Units already committed');
  const count = diceCount(state, role);
  const combat = new Set(combatUnits(battleArmy(state, b, role)).map((u) => u.id));
  if (unitIds.length !== count || new Set(unitIds).size !== count || !unitIds.every((u) => combat.has(u))) {
    fail('Commit {count} different combat units', { count });
  }
  b.units[role] = [...unitIds];
  const nat = battleNation(state, b, role);
  state.pending = state.pending.filter((p) => p.nation !== nat);
  if (b.units.attacker && b.units.defender) {
    b.step = 'roll';
    state.oracle = { kind: 'roll', attacker: diceCount(state, 'attacker'), defender: diceCount(state, 'defender') };
  }
}

/**
 * Panic retreat: instead of committing units, a side gives up the fight. The enemy picks as many
 * of its combat units as the enemy has dice; those are lost, and the army then retreats as usual.
 */
export function panic(state: GameState, role: BattleRole) {
  const b = state.battle!;
  if (b.step !== 'units' || b.units[role]) fail('You can only panic before committing units');
  b.panic = role;
  const a = battleArmy(state, b, role);
  log(state, 'log.panic', { nation: a.nation, army: a.id }, { kind: 'battle', nation: a.nation, node: a.node });
  b.units = { attacker: [], defender: [] };
  b.retreats = [{ role, panic: true }];
  nextRetreat(state);
}

export function panicTargets(state: GameState, unitIds: string[]) {
  const b = state.battle!;
  const p = state.pending.find((x) => x.kind === 'panicTargets');
  if (!p || p.kind !== 'panicTargets') fail('No panic to resolve');
  const a = army(state, p.army);
  const combat = new Set(combatUnits(a).map((u) => u.id));
  if (unitIds.length !== p.count || new Set(unitIds).size !== unitIds.length || !unitIds.every((u) => combat.has(u))) {
    fail('Choose {count} different combat units', { count: p.count });
  }
  a.units = a.units.filter((u) => !unitIds.includes(u.id));
  log(state, 'log.panicLosses', { army: a.id, count: unitIds.length }, { kind: 'battle', nation: a.nation, node: a.node });
  state.pending = [];
  b.retreats[0].panic = false;
  nextRetreat(state);
}

export function applyRoll(state: GameState, attacker: number[], defender: number[]) {
  const b = state.battle;
  const req = state.oracle;
  if (!b || b.step !== 'roll' || req?.kind !== 'roll') fail('No roll expected');
  if (attacker.length !== req.attacker || defender.length !== req.defender) fail('Wrong number of dice');
  for (const v of [...attacker, ...defender]) if (!Number.isInteger(v) || v < 1 || v > 6) fail('Bad die value');
  state.oracle = null;
  b.dice = { attacker, defender };
  b.step = 'plan';
  // Each side sees only its own roll until both have made their plan.
  state.pending = (['attacker', 'defender'] as const).map((r) => ({ nation: battleNation(state, b, r), kind: 'battlePlan' as const }));
}

/** Step 4: after seeing its own roll, a side puts one committed unit on each die and commits cards. */
export function submitPlan(state: GameState, role: BattleRole, unitIds: string[], placements: CardPlacement[]) {
  const b = state.battle!;
  if (b.step !== 'plan' || b.plan[role]) fail('Plan already made');
  const committedUnits = b.units[role]!;
  if (unitIds.length !== b.dice![role].length || [...unitIds].sort().join() !== [...committedUnits].sort().join()) {
    fail('Put each committed unit on one die');
  }
  const nat = battleNation(state, b, role);
  const hand = state.hands[nat];
  const ids = placements.map((p) => p.cardId);
  if (new Set(ids).size !== ids.length) fail('Duplicate card');
  const cards = ids.map((id) => hand.find((c) => c.id === id) ?? fail('Card {card} is not in your hand', { card: id }));
  const clean: CardPlacement[] = [];
  placements.forEach((p, i) => {
    const type = cards[i].type;
    if (!BATTLE_CARDS.includes(type)) fail('{card} cannot be played in battle', { card: type });
    if (ROLL_MOD[type] === undefined) { clean.push({ cardId: p.cardId }); return; }
    if (p.role !== 'attacker' && p.role !== 'defender') fail('Bad die owner');
    if (!Number.isInteger(p.die) || p.die! < 0 || p.die! >= b.dice![p.role].length) fail('Bad die index');
    clean.push({ cardId: p.cardId, role: p.role, die: p.die });
  });
  state.hands[nat] = hand.filter((c) => !ids.includes(c.id));
  b.committed[role] = cards;
  b.plan[role] = { units: [...unitIds], cards: clean };
  state.pending = state.pending.filter((p) => p.nation !== nat);
  if (b.plan.attacker && b.plan.defender) {
    b.step = 'defenderAssign';
    const node = battleArmy(state, b, 'defender').node;
    log(state, 'log.dice', { attackerDice: b.dice!.attacker.join(', '), defenderDice: b.dice!.defender.join(', ') }, { kind: 'battle', node });
    state.pending = [{ nation: battleNation(state, b, 'defender'), kind: 'defenderAssign' }];
  }
}

/** Step 5: with both rolls shown, each defender die opposes one attacker die. */
export function assignDefender(state: GameState, assign: number[]) {
  const b = state.battle!;
  if (assign.length !== b.dice!.defender.length) fail('Assign every defender die');
  for (const i of assign) if (!Number.isInteger(i) || i < 0 || i >= b.dice!.attacker.length) fail('Bad attacker die index');
  b.defenderAssign = assign;
  resolveRound(state);
}

/** Cavalry beats artillery, infantry beats cavalry, artillery beats infantry. */
export const TYPE_ADVANTAGE: Partial<Record<UnitType, UnitType>> = { cavalry: 'artillery', infantry: 'cavalry', artillery: 'infantry' };
export const TYPE_BONUS = 1;

/** +1 when a unit fights a unit type it has the advantage over. */
export function typeBonus(unit: UnitType | undefined, opponents: (UnitType | undefined)[]): number {
  const beats = unit && TYPE_ADVANTAGE[unit];
  return beats && opponents.includes(beats) ? TYPE_BONUS : 0;
}

/** Step 6: cards are revealed, points compared, losers destroyed, then any retreats. */
function resolveRound(state: GameState) {
  const b = state.battle!;
  const dice = b.dice!;
  const plans = { attacker: b.plan.attacker!, defender: b.plan.defender! };
  const typed: Record<BattleRole, (CardPlacement & { type: GeneralCardType })[]> = { attacker: [], defender: [] };
  for (const r of ['attacker', 'defender'] as const) {
    for (const p of plans[r].cards) typed[r].push({ ...p, type: b.committed[r]!.find((c) => c.id === p.cardId)!.type });
  }
  const all = [...typed.attacker, ...typed.defender];
  const mod = (role: BattleRole, die: number) =>
    all.filter((p) => p.role === role && p.die === die).reduce((s, p) => s + (ROLL_MOD[p.type] ?? 0), 0);

  const att = battleArmy(state, b, 'attacker');
  const def = battleArmy(state, b, 'defender');
  const typeOf = (a: Army, id: string) => a.units.find((u) => u.id === id)?.type;
  const results: DieResult[] = dice.attacker.map((v, i) => {
    const attUnit = plans.attacker.units[i];
    const opposing = b.defenderAssign!.map((target, j) => ({ target, j })).filter((x) => x.target === i);
    const defUnits = opposing.map((x) => plans.defender.units[x.j]);
    const attackerBonus = typeBonus(typeOf(att, attUnit), defUnits.map((u) => typeOf(def, u)));
    let defenderPoints = 0;
    let defenderBonus = 0;
    for (const { j } of opposing) {
      const bonus = typeBonus(typeOf(def, plans.defender.units[j]), [typeOf(att, attUnit)]);
      defenderBonus += bonus;
      defenderPoints += dice.defender[j] + mod('defender', j) + bonus;
    }
    const attackerPoints = v + mod('attacker', i) + attackerBonus;
    const winner: BattleRole = attackerPoints > defenderPoints ? 'attacker' : 'defender';
    // Winning units remain; the losing side's units in this comparison are destroyed.
    const destroyed = winner === 'attacker' ? defUnits : [attUnit];
    return { die: i, attackerPoints, defenderPoints, attackerBonus, defenderBonus, winner, destroyed };
  });
  for (const r of results) {
    const victim = r.winner === 'attacker' ? def : att;
    r.destroyed = r.destroyed.filter((id) => victim.units.some((u) => u.id === id));
    victim.units = victim.units.filter((u) => !r.destroyed.includes(u.id));
  }
  b.lastRound = { results, dice, plans, defenderAssign: [...b.defenderAssign!], placements: typed };
  log(state, 'log.round', { battleRound: b.round, results: results.map((r) => `${r.attackerPoints}:${r.defenderPoints}:${r.winner}`).join('|') }, { kind: 'battle', node: def.node });

  // A Retreat card takes the army away after the round. An enemy Block Retreat turns it into a panic retreat.
  const retreating: { role: BattleRole; panic: boolean }[] = [];
  for (const r of ['attacker', 'defender'] as const) {
    if (!typed[r].some((p) => p.type === 'retreat')) continue;
    const blocked = typed[other(r)].some((p) => p.type === 'blockRetreat');
    if (blocked) log(state, 'log.retreatBlocked', { nation: battleNation(state, b, r) }, { kind: 'battle', nation: battleNation(state, b, r) });
    retreating.push({ role: r, panic: blocked });
  }
  for (const r of ['attacker', 'defender'] as const) for (const c of b.committed[r]!) state.generalDeck.discard.push(c);
  state.pending = [];
  b.retreats = retreating;

  // Armies without combat units are destroyed even if they wanted to retreat.
  const zero = (['attacker', 'defender'] as const).filter((r) => combatUnits(battleArmy(state, b, r)).length === 0);
  if (zero.length) {
    for (const r of zero) removeArmy(state, battleArmy(state, b, r).id, 'reason.noCombatUnits');
    endBattle(state);
    return;
  }
  if (b.retreats.length) {
    for (const r of b.retreats) log(state, 'log.retreats', { nation: battleNation(state, b, r.role) }, { kind: 'battle', nation: battleNation(state, b, r.role) });
    nextRetreat(state);
  } else {
    beginRound(state);
  }
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
  const r = b.retreats[0];
  if (!r) { endBattle(state); return; }
  const a = battleArmy(state, b, r.role);
  if (r.panic) {
    // A panicking army first loses as many combat units as the enemy has dice, picked by the enemy.
    const enemy = state.armies[r.role === 'attacker' ? b.defenderArmy : b.attackerArmy];
    const count = enemy ? Math.min(diceFor(combatUnits(enemy).length), combatUnits(a).length) : 0;
    if (count > 0) {
      b.step = 'panic';
      state.pending = [{ nation: enemy!.nation, kind: 'panicTargets', army: a.id, count }];
      return;
    }
    r.panic = false;
  }
  b.step = 'retreat';
  if (!a.units.length && !a.generals.length) {
    b.retreats.shift();
    removeArmy(state, a.id, 'reason.destroyedRetreating');
    endBattle(state);
    return;
  }
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
  a.units = survivors;
  if (!keepGenerals) for (const g of a.generals.splice(0)) delete state.generals[g];
  for (const n of path) liberate(state, a, n);
  a.node = path[path.length - 1];
  a.moved.stopped = true;
  log(state, lost ? 'log.retreatedToLost' : 'log.retreatedTo', { army: a.id, node: a.node, lost }, { kind: 'battle', nation: a.nation, node: a.node });
  b.retreats.shift();
  nextRetreat(state);
}

/** The player confirms the retreat (after possibly playing +1 Moves): it goes to the planned node. */
export function retreat(state: GameState) {
  const b = state.battle!;
  const a = battleArmy(state, b, b.retreats[0].role);
  const plan = retreatPlan(state, a);
  if (!plan) {
    b.retreats.shift();
    removeArmy(state, a.id, 'reason.noRoute');
    endBattle(state);
    return;
  }
  performRetreat(state, a, plan.path);
}

export function endBattle(state: GameState) {
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
