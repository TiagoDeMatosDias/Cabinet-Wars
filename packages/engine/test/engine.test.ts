import { describe, expect, it } from 'vitest';
import {
  armySpeed, checkConfig, checkVictory, filterForSeats, fitsSpeed, sideOf, initialState, isProtected, MapConfigSchema, parseConfig, reachable, replay,
  retreatPlan, suppliedNodes, visibleNodes, willingness, type Card, type CardPlacement, type GeneralCardType,
} from '../src';
import { TestGame, testConfig } from './helpers';

const unitsOf = (g: TestGame, army: string, type?: string) =>
  g.state.armies[army].units.filter((u) => !type || u.type === type).map((u) => u.id);

function giveCards(g: TestGame, nation: string, types: GeneralCardType[]): string[] {
  const cards: Card<GeneralCardType>[] = types.map((type, i) => ({ id: `test${nation}${i}`, type }));
  g.state.hands[nation] = [...g.state.hands[nation], ...cards];
  return cards.map((c) => c.id);
}

describe('config', () => {
  it('parses the test map and builds unit ids', () => {
    const s = initialState(parseConfig(testConfig()));
    expect(s.armies.R.units.map((u) => u.type)).toEqual(['cavalry', 'infantry', 'infantry', 'supply']);
    expect(s.nodes.a1.controller).toBe('red');
    expect(s.generalDeck.discard).toHaveLength(60);
    expect(s.eventDeck.discard).toHaveLength(69);
  });

  it('reports broken references', () => {
    const cfg = MapConfigSchema.parse(testConfig({ edges: [{ a: 'a1', b: 'zz', type: 'minor' }] }));
    const problems = checkConfig(cfg);
    expect(problems.some((p) => p.includes('unknown node "zz"'))).toBe(true);
    expect(problems.some((p) => p.includes('has no connections'))).toBe(true);
  });
});

describe('turn flow', () => {
  it('starts with a shuffled general deck and a card drawn for the first player', () => {
    const g = new TestGame();
    expect(g.state.current).toBe('red');
    expect(g.state.phase).toBe('movement');
    expect(g.state.hands.red).toHaveLength(1);
    expect(g.state.generalDeck.draw).toHaveLength(59);
    expect(g.prompt('red')?.kind).toBe('movement');
  });

  it('draws a General card and an Event card when a turn starts', () => {
    const g = new TestGame();
    expect(g.state.hands.red).toHaveLength(1);
    expect(g.state.eventDeck.discard).toHaveLength(1);
    g.act('red', { type: 'endTurn' });
    expect(g.state.current).toBe('blue');
    expect(g.state.turn).toBe(2);
    expect(g.state.eventDeck.discard).toHaveLength(2);
    expect(g.state.hands.blue).toHaveLength(1);
    const keys = g.state.history.map((h) => h.msg?.key);
    expect(keys.lastIndexOf('log.event')).toBeGreaterThan(keys.lastIndexOf('log.turnBegins'));
  });

  it('rejects actions out of turn', () => {
    const g = new TestGame();
    expect(() => g.act('blue', { type: 'endTurn' })).toThrow(/not your move/);
  });
});

describe('movement', () => {
  it('moves at the speed of the slowest unit, tripled on major roads', () => {
    expect(fitsSpeed(3, true, 1)).toBe(true);
    expect(fitsSpeed(4, true, 1)).toBe(false);
    expect(fitsSpeed(2, false, 1)).toBe(false);
    const g = new TestGame();
    // Supply unit: speed 1, so 3 on major roads (the minor road to n1 breaks the all-major path).
    expect(() => g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1'] })).toThrow(/Not enough movement/);
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3'] });
    expect(g.state.armies.R.node).toBe('a3');
    expect(() => g.act('red', { type: 'move', army: 'R', path: ['n1'] })).toThrow(/Not enough movement/);
  });

  it('counts a minor road against the base speed', () => {
    const g = new TestGame();
    g.act('red', { type: 'split', army: 'R', units: unitsOf(g, 'R', 'supply'), generals: [] });
    // Now cavalry + infantry: speed 3. a1-a2-a3 major then minor to n1 = 3 edges, fine.
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1'] });
    expect(g.state.armies.R.node).toBe('n1');
    expect(() => g.act('red', { type: 'move', army: 'R', path: ['x1'] })).toThrow(/Not enough movement/);
  });

  it('+1 Moves raises speed', () => {
    const g = new TestGame();
    g.act('red', { type: 'split', army: 'R', units: unitsOf(g, 'R', 'supply'), generals: [] });
    const [card] = giveCards(g, 'red', ['moves+1']);
    g.act('red', { type: 'playMoves', army: 'R', card });
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1', 'x1'] }); // speed 3 + 1, minor roads
    expect(g.state.armies.R.node).toBe('x1');
    expect(g.state.generalDeck.discard.map((c) => c.id)).toContain(card);
  });

  it('armies without a general move in friendly territory but not in enemy territory', () => {
    const g = new TestGame(testConfig({
      nodes: testConfig().nodes!.map((n) => (n.id === 'n1' ? { ...n, controller: 'blue' } : n)),
    }));
    g.act('red', { type: 'split', army: 'R', units: unitsOf(g, 'R', 'infantry'), generals: [] });
    const inf = Object.keys(g.state.armies).find((id) => id.startsWith('red-a'))!;
    expect(g.state.armies[inf].generals).toEqual([]);
    g.act('red', { type: 'move', army: inf, path: ['a2', 'a3', 'n1'] }); // infantry: 3 moves, starts on friendly soil
    expect(g.state.armies[inf].node).toBe('n1');
    // Standing on enemy-controlled soil without a general (n1 is still blue until the turn ends): stuck.
    g.state.armies[inf].moved = { edges: 0, allMajor: true, bonus: 0, stopped: false };
    expect(() => g.act('red', { type: 'move', army: inf, path: ['a3'] })).toThrow(/without a general/);
  });

  it('a general can be detached on its own and rides at cavalry speed', () => {
    const g = new TestGame();
    g.act('red', { type: 'split', army: 'R', units: [], generals: ['gr'] });
    const gen = Object.values(g.state.armies).find((a) => a.id !== 'R' && a.nation === 'red')!;
    expect(gen.units).toEqual([]);
    expect(gen.generals).toEqual(['gr']);
    g.act('red', { type: 'move', army: gen.id, path: ['a2', 'a3', 'n1', 'x1'] }); // 4 moves
    expect(g.state.armies[gen.id].node).toBe('x1');
  });

  it('generals count towards speed: an army moves at its slowest member', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    expect(armySpeed(g.state.armies.R)).toBe(4);
  });

  it('merges armies on the same node', () => {
    const g = new TestGame();
    g.act('red', { type: 'split', army: 'R', units: unitsOf(g, 'R', 'supply'), generals: [] });
    const newId = Object.keys(g.state.armies).find((id) => id !== 'R' && id !== 'B')!;
    g.act('red', { type: 'merge', into: 'R', from: newId });
    expect(g.state.armies.R.units).toHaveLength(4);
    expect(g.state.armies[newId]).toBeUndefined();
  });

  it('lists reachable nodes', () => {
    const g = new TestGame();
    const r = reachable(g.state, g.state.armies.R);
    expect([...r.keys()].sort()).toEqual(['a2', 'a3']);
  });

  it('stops when next to an enemy and starts a battle', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'x1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    // Cavalry speed 4: plans to go through n1 to d3, but n1 touches x1.
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1', 'd3'] });
    expect(g.state.armies.R.node).toBe('n1');
    expect(g.state.phase).toBe('battle');
    expect(g.state.pending.map((p) => p.kind)).toEqual(['battleUnits', 'battleUnits']);
  });
});

function battleGame(red = { cavalry: 3, infantry: 0, artillery: 0, supply: 0 }, blue = { cavalry: 0, infantry: 3, artillery: 0, supply: 0 }) {
  const g = new TestGame(testConfig({
    armies: [
      { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: red },
      { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: blue },
    ],
  }));
  g.act('red', { type: 'move', army: 'R', path: ['n1'] });
  return g;
}

/**
 * Plays one battle round: both sides commit their first units, plan (units in die order, plus
 * cards), and blue opposes attacker dice as given.
 */
function fight(g: TestGame, o: { assign: number[]; redCards?: CardPlacement[]; blueCards?: CardPlacement[] }) {
  const commit = (nat: 'red' | 'blue', army: string) => {
    const p = g.prompt(nat);
    if (p?.kind !== 'battleUnits') throw new Error(`${nat} is not committing units`);
    const units = unitsOf(g, army).filter((id) => !id.includes('.s')).slice(0, p.count);
    g.act(nat, { type: 'battleUnits', units });
    return units;
  };
  const ru = commit('red', 'R');
  const bu = commit('blue', 'B');
  g.act('red', { type: 'battlePlan', units: ru, cards: o.redCards ?? [] });
  g.act('blue', { type: 'battlePlan', units: bu, cards: o.blueCards ?? [] });
  g.act('blue', { type: 'defenderAssign', assign: o.assign });
  return { ru, bu };
}

const ART3 = { cavalry: 0, infantry: 0, artillery: 3, supply: 0 };

describe('battle', () => {
  it('both sides commit one combat unit per die before rolling', () => {
    const g = battleGame({ cavalry: 4, infantry: 0, artillery: 0, supply: 0 });
    expect(g.prompt('red')).toMatchObject({ kind: 'battleUnits', count: 2 });
    expect(g.prompt('blue')).toMatchObject({ kind: 'battleUnits', count: 1 });
    expect(() => g.act('red', { type: 'battleUnits', units: [unitsOf(g, 'R')[0]] })).toThrow(/Commit 2/);
    g.act('red', { type: 'battleUnits', units: unitsOf(g, 'R').slice(0, 2) });
    expect(g.state.oracle).toBeNull();
    g.act('blue', { type: 'battleUnits', units: unitsOf(g, 'B').slice(0, 1) });
    expect(g.state.battle!.step).toBe('plan');
  });

  it('each side sees only its own roll and plan until the dice are shown', () => {
    const g = battleGame(ART3, ART3);
    g.dice = [5, 2];
    g.act('red', { type: 'battleUnits', units: unitsOf(g, 'R').slice(0, 1) });
    g.act('blue', { type: 'battleUnits', units: unitsOf(g, 'B').slice(0, 1) });
    let red = filterForSeats(g.state, ['red']).battle!;
    expect(red.dice).toEqual({ attacker: [5], defender: [0] });
    expect(red.units.defender).toEqual(['?']);
    const [plus] = giveCards(g, 'blue', ['roll+1']);
    g.act('red', { type: 'battlePlan', units: unitsOf(g, 'R').slice(0, 1), cards: [] });
    g.act('blue', { type: 'battlePlan', units: unitsOf(g, 'B').slice(0, 1), cards: [{ cardId: plus, role: 'defender', die: 0 }] });
    red = filterForSeats(g.state, ['red']).battle!;
    expect(red.step).toBe('defenderAssign');
    expect(red.dice).toEqual({ attacker: [5], defender: [2] });
    expect(red.plan.defender!.units).toEqual(unitsOf(g, 'B').slice(0, 1));
    expect(red.plan.defender!.cards).toEqual([{ cardId: '?' }]);
  });

  it('winning units remain and losing units are destroyed', () => {
    const g = battleGame(ART3, ART3);
    g.dice = [6, 3];
    const { ru, bu } = fight(g, { assign: [0] });
    expect(unitsOf(g, 'B')).not.toContain(bu[0]);
    expect(unitsOf(g, 'R')).toContain(ru[0]);
    expect(g.state.battle!.round).toBe(2);
    expect(g.state.battle!.step).toBe('units');
  });

  it('ties go to the defender; an unopposed attacker die destroys nothing', () => {
    const g = battleGame({ cavalry: 0, infantry: 0, artillery: 4, supply: 0 }, ART3); // 2 dice vs 1
    g.dice = [5, 2, 2];
    const { ru } = fight(g, { assign: [1] });
    expect(g.state.battle!.lastRound!.results.map((r) => r.winner)).toEqual(['attacker', 'defender']);
    expect(g.state.battle!.lastRound!.results[0].destroyed).toEqual([]);
    expect(unitsOf(g, 'B')).toHaveLength(3);
    expect(unitsOf(g, 'R')).not.toContain(ru[1]);
  });

  it('unit types matter: cavalry beats artillery, infantry beats cavalry, artillery beats infantry', () => {
    const g = battleGame({ cavalry: 3, infantry: 0, artillery: 0, supply: 0 }, ART3);
    g.dice = [3, 3];
    fight(g, { assign: [0] });
    expect(g.state.battle!.lastRound!.results[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 3, attackerBonus: 1, winner: 'attacker' });

    const h = battleGame(); // red cavalry vs blue infantry
    h.dice = [4, 3];
    fight(h, { assign: [0] });
    expect(h.state.battle!.lastRound!.results[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 4, defenderBonus: 1, winner: 'defender' });

    const k = battleGame(ART3, { cavalry: 0, infantry: 3, artillery: 0, supply: 0 });
    k.dice = [3, 3];
    fight(k, { assign: [0] });
    expect(k.state.battle!.lastRound!.results[0]).toMatchObject({ attackerBonus: 1, winner: 'attacker' });
  });

  it('applies roll cards to the die they are placed on', () => {
    const g = battleGame(ART3, ART3);
    const [plus2] = giveCards(g, 'blue', ['roll+2']);
    g.dice = [4, 3];
    fight(g, { assign: [0], blueCards: [{ cardId: plus2, role: 'defender', die: 0 }] });
    expect(g.state.battle!.lastRound!.results[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 5, winner: 'defender' });
    expect(g.state.armies.R.units).toHaveLength(2);
    expect(g.state.hands.blue.map((c) => c.id)).not.toContain(plus2);
  });

  it('destroys an army that runs out of combat units', () => {
    const g = battleGame(
      { cavalry: 1, infantry: 0, artillery: 0, supply: 0 },
      { cavalry: 0, infantry: 1, artillery: 0, supply: 0 },
    );
    g.dice = [6, 1];
    fight(g, { assign: [0] });
    expect(g.state.armies.B).toBeUndefined();
    expect(g.state.generals.gb).toBeUndefined();
    expect(g.state.battle).toBeNull();
    expect(g.state.phase).toBe('movement');
  });

  it('a Retreat card takes the army away after the round', () => {
    const g = battleGame(ART3, ART3);
    const [ret] = giveCards(g, 'blue', ['retreat']);
    g.dice = [6, 1];
    fight(g, { assign: [0], blueCards: [{ cardId: ret }] });
    // Blue lost the die (1 unit gone), then retreats 2 nodes, as far from the enemy (on n1) as possible.
    expect(g.state.armies.B.units).toHaveLength(2);
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
    expect(g.prompt('red')?.kind).toBe('movement');
  });

  it('Block Retreat turns an enemy retreat into a panic retreat', () => {
    const g = battleGame(ART3, ART3);
    const [ret] = giveCards(g, 'blue', ['retreat']);
    const [block] = giveCards(g, 'red', ['blockRetreat']);
    g.dice = [1, 6];
    fight(g, { assign: [0], redCards: [{ cardId: block }], blueCards: [{ cardId: ret }] });
    expect(g.state.history.some((h) => h.msg?.key === 'log.retreatBlocked')).toBe(true);
    // Red lost its die; blue flees in panic: red picks as many blue units as it has dice (1).
    expect(g.prompt('red')).toMatchObject({ kind: 'panicTargets', army: 'B', count: 1 });
    g.act('red', { type: 'panicTargets', units: [unitsOf(g, 'B')[0]] });
    expect(g.state.armies.B.units).toHaveLength(2);
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
  });

  it('both sides can retreat', () => {
    const g = battleGame();
    const [rr] = giveCards(g, 'red', ['retreat']);
    const [br] = giveCards(g, 'blue', ['retreat']);
    fight(g, { assign: [0], redCards: [{ cardId: rr }], blueCards: [{ cardId: br }] });
    // Red: a2 and x2 are both 3 from blue; red controls a2, so it goes there. Then blue goes to d1.
    expect(g.state.armies.R.node).toBe('a2');
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
  });

  it('slow units that cannot keep up with a retreat are lost', () => {
    const g = battleGame(
      { cavalry: 3, infantry: 0, artillery: 0, supply: 0 },
      { cavalry: 0, infantry: 2, artillery: 0, supply: 1 },
    );
    const [ret] = giveCards(g, 'blue', ['retreat']);
    g.dice = [1, 6];
    fight(g, { assign: [0], blueCards: [{ cardId: ret }] });
    // d3 → d2 → d1 is all major road: supply (speed 1) manages 2 nodes.
    expect(g.state.armies.B.node).toBe('d1');
    expect(unitsOf(g, 'B', 'supply')).toHaveLength(1);
  });
});

describe('panic retreat', () => {
  it('the panicking side loses the units the enemy picks, then retreats', () => {
    const g = battleGame(
      { cavalry: 4, infantry: 0, artillery: 0, supply: 0 }, // 2 dice
      { cavalry: 0, infantry: 3, artillery: 0, supply: 0 },
    );
    g.act('red', { type: 'battleUnits', units: unitsOf(g, 'R').slice(0, 2) });
    g.act('blue', { type: 'panic' });
    expect(g.prompt('red')).toMatchObject({ kind: 'panicTargets', army: 'B', count: 2 });
    const [u0, u1] = unitsOf(g, 'B');
    expect(() => g.act('red', { type: 'panicTargets', units: [u0] })).toThrow(/Choose 2/);
    g.act('red', { type: 'panicTargets', units: [u0, u1] });
    expect(g.state.armies.B.units).toHaveLength(1);
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
  });

  it('cannot panic after committing units', () => {
    const g = battleGame();
    g.act('blue', { type: 'battleUnits', units: unitsOf(g, 'B').slice(0, 1) });
    expect(() => g.act('blue', { type: 'panic' })).toThrow(/not your move|before committing/i);
  });

  it('a +1 Moves card can save members that would be left behind', () => {
    const g = battleGame({ cavalry: 3, infantry: 0, artillery: 0, supply: 1 });
    const [moves] = giveCards(g, 'red', ['moves+1']);
    g.act('red', { type: 'panic' });
    g.act('blue', { type: 'panicTargets', units: [unitsOf(g, 'R', 'cavalry')[0]] });
    // n1 → a3 is a minor road, so the supply unit (speed 1) can't do 2 nodes: red is asked first.
    expect(g.prompt('red')).toMatchObject({ kind: 'retreat', army: 'R' });
    g.act('red', { type: 'playMoves', army: 'R', card: moves });
    g.act('red', { type: 'retreat' });
    expect(g.state.armies.R.node).toBe('a2');
    expect(unitsOf(g, 'R', 'supply')).toHaveLength(1);
  });

  it('without the card, slow members stay behind and the rest retreat at once', () => {
    const g = battleGame({ cavalry: 3, infantry: 0, artillery: 0, supply: 1 });
    g.state.hands.red = []; // no +1 Moves card to play
    g.act('red', { type: 'panic' });
    g.act('blue', { type: 'panicTargets', units: [unitsOf(g, 'R', 'cavalry')[0]] });
    expect(g.state.armies.R.node).toBe('a2');
    expect(unitsOf(g, 'R', 'supply')).toHaveLength(0);
    expect(unitsOf(g, 'R', 'cavalry')).toHaveLength(2);
  });
});

/** Three nations: red owns a1–a3, blue n1 and d1–d3, green x1–x3. */
function threeNations(mode: 'sides' | 'freeForAll', nodes = testConfig().nodes!) {
  return new TestGame(testConfig({
    rules: { mode },
    nations: [
      { id: 'red', name: 'Red', color: '#f00', side: 'attacker', threshold: 50 },
      { id: 'blue', name: 'Blue', color: '#00f', side: 'defender', threshold: 50 },
      { id: 'green', name: 'Green', color: '#0f0', side: 'attacker', threshold: 50 },
    ],
    nodes: nodes.map((n) => (n.id.startsWith('x') ? { ...n, owner: 'green', vp: n.id === 'x3' ? 2 : 0 } : n)),
    generals: [{ id: 'gr', name: 'R', nation: 'red' }, { id: 'gb', name: 'B', nation: 'blue' }, { id: 'gg', name: 'G', nation: 'green' }],
    armies: [
      { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
      { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      { id: 'G', nation: 'green', node: 'x1', generals: ['gg'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
    ],
  }));
}

describe('free for all', () => {
  it('makes every nation an attacker and an enemy of every other', () => {
    const sides = threeNations('sides');
    expect(sideOf(sides.state, 'red')).toBe(sideOf(sides.state, 'green'));
    const ffa = threeNations('freeForAll');
    expect(ffa.state.nations.every((n) => n.side === 'attacker')).toBe(true);
    expect(sideOf(ffa.state, 'red')).not.toBe(sideOf(ffa.state, 'green'));
    // Red moving next to green's army starts a battle, which allies never fight.
    ffa.act('red', { type: 'move', army: 'R', path: ['n1'] });
    expect(ffa.state.battle).toMatchObject({ attackerArmy: 'R', defenderArmy: 'G' });
  });

  it('is won by the last nation standing', () => {
    const g = threeNations('freeForAll');
    g.state.nations.find((n) => n.id === 'blue')!.warExhaustion = 100;
    checkVictory(g.state);
    expect(g.state.winner).toBeNull();
    g.state.nations.find((n) => n.id === 'green')!.warExhaustion = 100;
    checkVictory(g.state);
    expect(g.state.winner).toBe('red');
    expect(g.state.history.at(-1)!.msg).toMatchObject({ key: 'log.winnerNation', params: { nation: 'red' } });
  });

  it('checks that a free-for-all map has at least two nations', () => {
    const cfg = MapConfigSchema.parse(testConfig({ rules: { mode: 'freeForAll' } }));
    expect(checkConfig(cfg)).toEqual([]);
    expect(checkConfig({ ...cfg, nations: cfg.nations.slice(0, 1) })).toContain('A free-for-all game needs at least 2 nations');
  });
});

describe('defeated nations', () => {
  it('have their land split between the occupiers and the nearest nations, each town worth 1 VP', () => {
    // Blue holds none of its VP (n1: red, d1: green), so it is knocked out as soon as the game starts.
    const g = threeNations('freeForAll', testConfig().nodes!.map((n) =>
      n.id === 'n1' ? { ...n, controller: 'red', vp: 3 } : n.id === 'd1' ? { ...n, controller: 'green' }
        : n.id === 'a2' ? { ...n, controller: 'blue' } : n)); // blue occupies a red town
    expect(g.state.nations.find((n) => n.id === 'blue')!.knockedOut).toBe(true);
    // Occupiers keep what they hold; free towns go to the nearest nation.
    expect(g.state.nodes.n1).toMatchObject({ owner: 'red', controller: 'red', vp: 1 });
    expect(g.state.nodes.d1).toMatchObject({ owner: 'green', controller: 'green', vp: 1 });
    expect(g.state.nodes.d2).toMatchObject({ owner: 'green', controller: 'green' }); // 1 from green's d1, 2 from red's n1
    expect(g.state.nodes.d3).toMatchObject({ owner: 'red', controller: 'red' }); // 1 from red's n1, 2 from green's d1
    expect(g.state.nodes.a2.controller).toBe('red'); // blue's occupation ends
    expect(g.state.armies.B).toBeUndefined();
    expect(g.state.history.filter((h) => h.msg?.key === 'log.landPartitioned').map((h) => h.msg!.params.nation).sort()).toEqual(['green', 'red']);
  });

  it('ties go to whoever holds most of the defeated nation\'s victory points', () => {
    // Red holds n1 (3 VP); green holds nothing of blue's. x1 (green) and a3 (red) are both 2 from d3.
    const g = threeNations('freeForAll', testConfig().nodes!.map((n) => (n.id === 'n1' ? { ...n, vp: 3 } : n)));
    g.state.nodes.n1.controller = 'red';
    g.state.nodes.d3.controller = 'green';
    g.state.nations.find((n) => n.id === 'blue')!.warExhaustion = 100;
    checkVictory(g.state);
    // d2 is 1 from green's d3 and 3 from red's n1: green. d1 likewise.
    expect(g.state.nodes.d2.owner).toBe('green');
    expect(g.state.nodes.n1.owner).toBe('red');
  });
});

describe('liberation', () => {
  it('an army passing through its own occupied nodes frees them at once', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    g.state.nodes.a2.controller = 'blue';
    g.state.nodes.a3.controller = 'blue';
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3'] });
    expect(g.state.nodes.a2.controller).toBe('red');
    expect(g.state.nodes.a3.controller).toBe('red');
    // Enemy-owned nodes still change hands only at the end of the turn.
    g.act('red', { type: 'move', army: 'R', path: ['n1'] });
    expect(g.state.nodes.n1.controller).toBe('blue');
    expect(g.state.history.some((h) => h.msg?.key === 'log.liberates')).toBe(true);
  });
});

describe('retreat', () => {
  it('goes exactly 2 nodes, to the node farthest from the enemy', () => {
    // Blue on x1 fights red on n1. From n1, red can reach a2 (3 from x1), d2 (3), or x3 via x1 (blocked).
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'x2', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    const plan = retreatPlan(g.state, g.state.armies.B);
    // Without a battle there is no enemy to flee from; with one, see below.
    expect(plan?.path).toHaveLength(2);
    g.act('red', { type: 'move', army: 'R', path: ['n1', 'x1'] });
    g.act('red', { type: 'panic' });
    g.act('blue', { type: 'panicTargets', units: [unitsOf(g, 'R')[0]] });
    // Red on x1, blue on x2. Red's 2-node options: n1→a3 (dist 3 from x2), n1→d3 (3). Tie → red controls a3.
    expect(g.state.armies.R.node).toBe('a3');
  });

  it('an army with no route of 2 free nodes is destroyed', () => {
    const g = new TestGame(testConfig({
      generals: [{ id: 'gr', name: 'A', nation: 'red' }, { id: 'gr2', name: 'B', nation: 'red' }, { id: 'gb', name: 'C', nation: 'blue' }],
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'R2', nation: 'red', node: 'd2', generals: ['gr2'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    g.act('red', { type: 'move', army: 'R', path: ['n1'] });
    g.act('red', { type: 'battleUnits', units: unitsOf(g, 'R').slice(0, 1) });
    g.act('blue', { type: 'panic' });
    g.act('red', { type: 'panicTargets', units: [unitsOf(g, 'B')[0]] });
    // Blue on d3 is boxed in: n1 (red R) and d2 (red R2) are both occupied.
    expect(g.state.armies.B).toBeUndefined();
    expect(g.state.history.some((h) => h.msg?.key === 'log.destroyed' && h.msg.params.reason === 'reason.noRoute')).toBe(true);
  });
});

describe('fog of war', () => {
  it('shows owned and controlled nodes, their neighbours and the nodes around own armies', () => {
    const g = new TestGame();
    const red = visibleNodes(g.state, 'attacker');
    expect([...red].sort()).toEqual(['a1', 'a2', 'a3', 'n1']);
    const blue = visibleNodes(g.state, 'defender');
    expect(blue.has('a3')).toBe(true); // next to blue's n1
    expect(blue.has('a1')).toBe(false);
  });
});

describe('supply', () => {
  it('reaches 2 nodes past friendly territory and chains through supply units', () => {
    const g = new TestGame(testConfig({
      nodes: testConfig().nodes!.map((n) => (n.id === 'n1' ? { ...n, controller: 'blue' } : n)),
    }));
    const red = suppliedNodes(g.state, 'attacker');
    expect(red.has('d3')).toBe(true); // a3 → n1 → d3
    expect(red.has('d2')).toBe(false);
    g.state.armies.S = { id: 'S', nation: 'red', node: 'd3', generals: [], units: [{ id: 's', type: 'supply' }], moved: g.state.armies.R.moved };
    const chained = suppliedNodes(g.state, 'attacker');
    expect(chained.has('d1')).toBe(true);
  });

  it('attrition removes a unit at the end of the turn', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'x3', generals: ['gr'], units: { cavalry: 1, infantry: 2, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    g.act('red', { type: 'endTurn' });
    expect(g.prompt('red')).toMatchObject({ kind: 'attrition', army: 'R' });
    g.act('red', { type: 'attrition', unit: unitsOf(g, 'R', 'cavalry')[0] });
    expect(g.state.armies.R.units).toHaveLength(2);
    expect(g.state.current).toBe('blue');
  });
});

describe('control and victory', () => {
  it('occupies undefended nodes at the end of the turn', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    g.act('red', { type: 'move', army: 'R', path: ['n1', 'x1'] });
    g.act('red', { type: 'endTurn' });
    expect(g.state.nodes.x1.controller).toBe('red');
  });

  it('a node is protected when the controller has an army within 2', () => {
    const g = new TestGame();
    g.state.armies.B.node = 'd2';
    expect(isProtected(g.state, 'n1')).toBe(true);
    g.state.armies.B.node = 'd1';
    expect(isProtected(g.state, 'n1')).toBe(false);
  });

  it('knocks out a nation below its threshold and ends the game', () => {
    const g = new TestGame(testConfig({
      // Red holds d3, so an army at d1 stays in supply.
      nodes: testConfig().nodes!.map((n) => (n.id === 'd3' ? { ...n, controller: 'red' } : n)),
      armies: [
        { id: 'R', nation: 'red', node: 'd2', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    g.act('red', { type: 'move', army: 'R', path: ['d1'] });
    g.act('red', { type: 'endTurn' });
    expect(g.state.nations.find((n) => n.id === 'blue')!.knockedOut).toBe(true);
    // Blue's land is handed out: red holds d1, so it now owns it, worth 1 VP.
    expect(g.state.nodes.d1).toMatchObject({ owner: 'red', controller: 'red', vp: 1 });
    expect(g.state.winner).toBe('attacker');
    expect(g.state.phase).toBe('gameOver');
  });

  it('war exhaustion takes percentage points off willingness', () => {
    const g = new TestGame();
    g.state.nations[1].warExhaustion = 5;
    expect(willingness(g.state, 'blue')).toBe(95);
    g.state.nodes.d1.controller = 'red'; // blue loses its only VP node
    expect(willingness(g.state, 'blue')).toBe(0);
  });

  it('counts rounds: a round ends when every nation has had its turn', () => {
    const g = new TestGame();
    expect(g.state.round).toBe(1);
    g.act('red', { type: 'endTurn' });
    expect(g.state.round).toBe(1);
    g.act('blue', { type: 'endTurn' });
    expect(g.state.round).toBe(2);
    expect(g.state.turn).toBe(3);
    expect(g.state.history.some((h) => h.msg?.key === 'log.roundBegins' && h.msg.params.round === 2)).toBe(true);
  });

  it('an early End Game card goes to the bottom of the event deck', () => {
    const g = new TestGame(testConfig({
      rules: { endGameFromRound: 3 },
      decks: { general: [{ card: 'roll+1', count: 2 }], event: [{ card: 'endGame', count: 1 }, { card: 'nothing', count: 1 }] },
    }));
    // Reversed shuffle: red draws "nothing" at the start of its first turn.
    g.act('red', { type: 'endTurn' }); // blue draws End Game in round 1: deferred
    expect(g.state.phase).not.toBe('gameOver');
    expect(g.state.history.some((h) => h.msg?.key === 'log.endGameDeferred')).toBe(true);
    expect(g.state.eventDeck.draw.map((c) => c.type)).toEqual(['endGame']);
    g.act('blue', { type: 'endTurn' }); // red, round 2: deferred again
    expect(g.state.phase).not.toBe('gameOver');
    g.act('red', { type: 'endTurn' });
    g.act('blue', { type: 'endTurn' }); // red, round 3: the war ends
    expect(g.state.phase).toBe('gameOver');
    expect(g.state.winner).toBe('defender');
  });

  it('log entries carry a message key with parameters, and English text', () => {
    const g = new TestGame();
    const e = g.state.history.find((h) => h.msg?.key === 'log.turnBegins')!;
    expect(e.msg!.params).toEqual({ nation: 'red' });
    expect(e.text).toBe("Red's turn begins");
  });
});

describe('recruit events', () => {
  const recruitGame = (card: 'recruit1' | 'recruit2' | 'recruitGeneral') => new TestGame(testConfig({
    decks: { general: [{ card: 'roll+1', count: 2 }], event: [{ card: card, count: 1 }] },
  }));

  it('Recruit 1 Unit adds a unit of the chosen type to the army in an own town', () => {
    const g = recruitGame('recruit1');
    const p = g.prompt('red');
    expect(p).toMatchObject({ kind: 'recruit', what: 'unit', remaining: 1 });
    expect(p!.kind === 'recruit' && p!.options.sort()).toEqual(['a1', 'a2', 'a3']);
    expect(() => g.act('red', { type: 'recruit', node: 'd1', unit: 'cavalry' })).toThrow(/own towns/);
    g.act('red', { type: 'recruit', node: 'a1', unit: 'artillery' });
    expect(unitsOf(g, 'R', 'artillery')).toHaveLength(1);
    expect(g.state.pending).toEqual([{ nation: 'red', kind: 'movement' }]);
  });

  it('Recruit 2 Units asks twice and forms a new army where there is none', () => {
    const g = recruitGame('recruit2');
    g.act('red', { type: 'recruit', node: 'a3', unit: 'infantry' });
    expect(g.prompt('red')).toMatchObject({ kind: 'recruit', remaining: 1 });
    g.act('red', { type: 'recruit', node: 'a3', unit: 'cavalry' });
    const a = Object.values(g.state.armies).find((x) => x.node === 'a3')!;
    expect(a.units.map((u) => u.type)).toEqual(['infantry', 'cavalry']);
    expect(a.generals).toEqual([]);
    expect(g.state.pending).toEqual([{ nation: 'red', kind: 'movement' }]);
  });

  it('Recruit General adds a general', () => {
    const g = recruitGame('recruitGeneral');
    g.act('red', { type: 'recruit', node: 'a1' });
    expect(g.state.armies.R.generals).toHaveLength(2);
  });

  it('has no effect when no own town is free', () => {
    const g = new TestGame(testConfig({
      nations: testConfig().nations!.map((n) => ({ ...n, threshold: 0 })),
      nodes: testConfig().nodes!.map((n) => (n.owner === 'red' ? { ...n, controller: 'blue' } : n)),
      armies: [
        { id: 'R', nation: 'red', node: 'x3', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
      decks: { general: [{ card: 'roll+1', count: 2 }], event: [{ card: 'recruit1', count: 1 }] },
    }));
    g.act('red', { type: 'endTurn' });
    expect(g.state.history.some((h) => h.msg?.key === 'log.recruitNowhere')).toBe(true);
  });
});

describe('decks', () => {
  it('reshuffles the discard pile when the deck runs out, and skips when both are empty', () => {
    const g = new TestGame(testConfig({ decks: { general: [{ card: 'roll+1', count: 1 }], event: [{ card: 'nothing', count: 1 }] } }));
    expect(g.state.hands.red).toHaveLength(1);
    g.act('red', { type: 'endTurn' });
    // Blue draws from an empty deck and empty discard: skipped.
    expect(g.state.hands.blue).toHaveLength(0);
    expect(g.state.eventDeck.discard).toHaveLength(1);
    g.act('blue', { type: 'endTurn' });
    // The single event card was reshuffled and drawn again.
    expect(g.state.eventDeck.discard).toHaveLength(1);
    expect(g.state.current).toBe('red');
  });
});

describe('log and views', () => {
  it('replaying the log reproduces the live state', () => {
    const g = battleGame();
    g.dice = [6, 1, 2, 5];
    fight(g, { assign: [0] });
    const replayed = replay(g.initial, JSON.parse(JSON.stringify(g.log)));
    expect(replayed).toEqual(g.state);
  });

  it('hides enemy hands, deck order and armies in fog', () => {
    const g = new TestGame();
    const view = filterForSeats(g.state, ['blue']);
    expect(view.hands.red).toEqual([]);
    expect(view.counts.hands.red).toBe(1);
    expect(view.generalDeck.draw).toEqual([]);
    expect(view.armies.R).toBeUndefined();
    expect(view.armies.B).toBeDefined();
    const hotseat = filterForSeats(g.state, ['red', 'blue']);
    expect(hotseat.armies.R).toBeDefined();
    expect(hotseat.hands.red).toHaveLength(1);
  });
});
