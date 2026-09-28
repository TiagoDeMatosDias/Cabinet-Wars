import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  armySpeed, checkConfig, checkVictory, filterForSeats, fitsSpeed, sideOf, initialState, isProtected, MapConfigSchema, parseConfig, reachable, replay,
  retreatPlan, suppliedAt, suppliedNodes, musterBlocked, musterNodes, unitCount, warStatus, visibleNodes, willingness, type BattleChoice, type Card, type CardPlacement, type GeneralCardType,
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
    g.state.armies[inf].moved = { edges: 0, allMajor: true, points: 0, bonus: 0, stopped: false };
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
    expect(g.state.pending.map((p) => p.kind)).toEqual(['battleChoice', 'battleChoice']);
  });
});

function battleGame(red = { cavalry: 3, infantry: 0, artillery: 0, supply: 0 }, blue = { cavalry: 0, infantry: 3, artillery: 0, supply: 0 }, keepHands = false) {
  const g = new TestGame(testConfig({
    armies: [
      { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: red },
      { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: blue },
    ],
  }));
  g.act('red', { type: 'move', army: 'R', path: ['n1'] });
  // No cards unless a test hands them out.
  if (!keepHands) g.state.hands = { red: [], blue: [] };
  return g;
}

/** Plays one battle round: both sides choose (fight by default), then play any roll cards. */
function fight(g: TestGame, o: { red?: BattleChoice; blue?: BattleChoice; redCards?: CardPlacement[]; blueCards?: CardPlacement[] } = {}) {
  const units = structuredClone(g.state.battle!.units);
  g.act('red', { type: 'battleChoice', choice: o.red ?? 'fight' });
  g.act('blue', { type: 'battleChoice', choice: o.blue ?? 'fight' });
  if (g.prompt('red')?.kind === 'battleCards') g.act('red', { type: 'battleCards', cards: o.redCards ?? [] });
  if (g.prompt('blue')?.kind === 'battleCards') g.act('blue', { type: 'battleCards', cards: o.blueCards ?? [] });
  return { ru: units.attacker, bu: units.defender };
}

const ART3 = { cavalry: 0, infantry: 0, artillery: 3, supply: 0 };
const duels = (g: TestGame) => g.state.battle!.lastRound!.duels;

describe('battle', () => {
  it('picks the fighting units at random, one per die, and whom each attacking unit faces', () => {
    const g = battleGame({ cavalry: 4, infantry: 0, artillery: 0, supply: 0 });
    expect(g.log.at(-1)?.intent).toMatchObject({ type: 'select', attacker: [0, 1], defender: [0], targets: [0, 0] });
    const b = g.state.battle!;
    expect(b.units.attacker).toEqual(unitsOf(g, 'R').slice(0, 2));
    expect(b.units.defender).toEqual(unitsOf(g, 'B').slice(0, 1));
    expect(b.step).toBe('choose');
    expect(g.state.pending.map((p) => p.kind)).toEqual(['battleChoice', 'battleChoice']);
  });

  it('defending units that no attacking unit faces sit the round out', () => {
    const g = battleGame({ cavalry: 1, infantry: 0, artillery: 0, supply: 0 }, { cavalry: 0, infantry: 5, artillery: 0, supply: 0 });
    g.picks = [{ attacker: [0], defender: [2, 3], targets: [1] }];
    g.dice = [6, 1];
    fight(g); // round 1 with the default picks: blue is down to 4 units, so 2 of them are picked
    expect(g.state.battle!.units.defender).toEqual([unitsOf(g, 'B')[3]]);
    expect(g.state.battle!.matchups).toEqual([{ attacker: [0], defender: [0] }]);
  });

  it('keeps each choice secret until both sides have chosen', () => {
    const g = battleGame(ART3, ART3);
    g.act('red', { type: 'battleChoice', choice: 'fight' });
    expect(filterForSeats(g.state, ['blue']).battle!.choice.attacker).toBe('hidden');
    expect(filterForSeats(g.state, ['red']).battle!.choice.attacker).toBe('fight');
  });

  it('the higher total wins each duel, ties go to the defender, and the loser is destroyed', () => {
    const g = battleGame(ART3, ART3);
    g.dice = [6, 3];
    const { ru, bu } = fight(g);
    expect(unitsOf(g, 'B')).not.toContain(bu[0]);
    expect(unitsOf(g, 'R')).toContain(ru[0]);
    expect(g.state.battle!.lost).toEqual({ attacker: [], defender: ['artillery'] });
    expect(g.state.battle!.round).toBe(2);
    expect(g.state.battle!.step).toBe('choose');
    g.dice = [4, 4];
    const second = fight(g);
    expect(duels(g)[0].winner).toBe('defender');
    expect(unitsOf(g, 'R')).not.toContain(second.ru[0]);
  });

  it('several attacking units can face the same unit', () => {
    const g = battleGame({ cavalry: 0, infantry: 0, artillery: 4, supply: 0 }, ART3); // 2 units vs 1
    g.dice = [5, 2, 3];
    const { ru, bu } = fight(g);
    expect(duels(g).map((d) => d.winner)).toEqual(['attacker', 'defender']);
    expect(unitsOf(g, 'B')).not.toContain(bu[0]);
    expect(unitsOf(g, 'R')).not.toContain(ru[1]);
    expect(unitsOf(g, 'R')).toContain(ru[0]);
  });

  it('unit types matter: cavalry beats artillery, infantry beats cavalry, artillery beats infantry', () => {
    const g = battleGame({ cavalry: 3, infantry: 0, artillery: 0, supply: 0 }, ART3);
    g.dice = [3, 3];
    fight(g);
    expect(duels(g)[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 3, attackerBonus: 1, winner: 'attacker' });

    const h = battleGame(); // red cavalry vs blue infantry
    h.dice = [4, 3];
    fight(h);
    expect(duels(h)[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 4, defenderBonus: 1, winner: 'defender' });

    const k = battleGame(ART3, { cavalry: 0, infantry: 3, artillery: 0, supply: 0 });
    k.dice = [3, 3];
    fight(k);
    expect(duels(k)[0]).toMatchObject({ attackerBonus: 1, winner: 'attacker' });
  });

  it('after the roll, roll cards go on a chosen die and stay face down until both sides are done', () => {
    const g = battleGame(ART3, ART3);
    const [plus2] = giveCards(g, 'blue', ['roll+2']);
    const [minus] = giveCards(g, 'red', ['roll-1']);
    g.dice = [4, 3];
    g.act('red', { type: 'battleChoice', choice: 'fight' });
    g.act('blue', { type: 'battleChoice', choice: 'fight' });
    expect(g.state.battle!.dice).toEqual({ attacker: [4], defender: [3] });
    g.act('blue', { type: 'battleCards', cards: [{ cardId: plus2, role: 'defender', die: 0 }] });
    expect(filterForSeats(g.state, ['red']).battle!.cards.defender).toBeNull();
    expect(filterForSeats(g.state, ['red']).counts.committed.defender).toBe(1);
    g.act('red', { type: 'battleCards', cards: [{ cardId: minus, role: 'defender', die: 0 }] });
    expect(duels(g)[0]).toMatchObject({ attackerPoints: 4, defenderPoints: 4, winner: 'defender' });
    expect(g.state.armies.R.units).toHaveLength(2);
    expect(g.state.hands.blue).toEqual([]);
    expect(g.state.generalDeck.discard.map((c) => c.id)).toEqual(expect.arrayContaining([plus2, minus]));
  });

  it('only sides holding roll cards are asked to play them', () => {
    const g = battleGame(ART3, ART3);
    giveCards(g, 'red', ['roll+1', 'retreat']);
    g.act('red', { type: 'battleChoice', choice: 'fight' });
    g.act('blue', { type: 'battleChoice', choice: 'fight' });
    expect(g.state.pending).toEqual([{ nation: 'red', kind: 'battleCards' }]);
    expect(() => g.act('red', { type: 'battleCards', cards: [{ cardId: g.state.hands.red[1].id, role: 'attacker', die: 0 }] })).toThrow(/cannot be put on a die/);
  });

  it('destroys an army that runs out of combat units', () => {
    const g = battleGame(
      { cavalry: 1, infantry: 0, artillery: 0, supply: 0 },
      { cavalry: 0, infantry: 1, artillery: 0, supply: 0 },
    );
    g.dice = [6, 1];
    fight(g);
    expect(g.state.armies.B).toBeUndefined();
    expect(g.state.generals.gb).toBeUndefined();
    expect(g.state.battle).toBeNull();
    expect(g.state.phase).toBe('movement');
  });

  it('a Retreat card ends the battle before the roll and the army falls back', () => {
    const g = battleGame(ART3, ART3);
    const [ret] = giveCards(g, 'blue', ['retreat']);
    fight(g, { blue: 'retreat' });
    expect(g.state.armies.B.units).toHaveLength(3);
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
    expect(g.state.generalDeck.discard.map((c) => c.id)).toContain(ret);
    expect(g.log.some((e) => e.intent.type === 'roll')).toBe(false);
    expect(g.prompt('red')?.kind).toBe('movement');
  });

  it('needs the card to retreat or block', () => {
    const g = battleGame(ART3, ART3);
    expect(() => g.act('blue', { type: 'battleChoice', choice: 'retreat' })).toThrow(/no retreat card/);
    expect(() => g.act('red', { type: 'battleChoice', choice: 'block' })).toThrow(/no blockRetreat card/);
  });

  it('panic costs one of the fighting units, then the army falls back', () => {
    const g = battleGame(ART3, ART3);
    const { bu } = fight(g, { blue: 'panic' });
    expect(unitsOf(g, 'B')).toHaveLength(2);
    expect(unitsOf(g, 'B')).not.toContain(bu[0]);
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
  });

  it('Block Retreat stops a retreat or a panic from doing anything: the fight goes on', () => {
    const g = battleGame(ART3, ART3);
    const [ret] = giveCards(g, 'blue', ['retreat']);
    const [block, block2] = giveCards(g, 'red', ['blockRetreat', 'blockRetreat']);
    g.dice = [1, 6];
    fight(g, { red: 'block', blue: 'retreat' });
    expect(g.state.history.some((h) => h.msg?.key === 'log.retreatBlocked')).toBe(true);
    expect(duels(g)[0].winner).toBe('defender');
    expect(g.state.armies.B.node).toBe('d3');
    expect(g.state.generalDeck.discard.map((c) => c.id)).toEqual(expect.arrayContaining([ret, block]));

    fight(g, { red: 'block', blue: 'panic' });
    expect(unitsOf(g, 'B')).toHaveLength(3);
    expect(g.state.generalDeck.discard.map((c) => c.id)).toContain(block2);
    expect(g.state.battle!.round).toBe(3);
  });

  it('both sides can retreat', () => {
    const g = battleGame();
    giveCards(g, 'red', ['retreat']);
    giveCards(g, 'blue', ['retreat']);
    fight(g, { red: 'retreat', blue: 'retreat' });
    // Red: a2 and x2 are both 3 from blue; red controls a2, so it goes there. Then blue goes to d1.
    expect(g.state.armies.R.node).toBe('a2');
    expect(g.state.armies.B.node).toBe('d1');
    expect(g.state.battle).toBeNull();
  });

  it('the whole army falls back, supply wagons included', () => {
    const g = battleGame(
      { cavalry: 3, infantry: 0, artillery: 0, supply: 0 },
      { cavalry: 0, infantry: 2, artillery: 0, supply: 1 },
    );
    giveCards(g, 'blue', ['retreat']);
    fight(g, { blue: 'retreat' });
    // d3 → d2 → d1: every unit, wagons included (speed 2), manages 2 nodes.
    expect(g.state.armies.B.node).toBe('d1');
    expect(unitsOf(g, 'B', 'supply')).toHaveLength(1);
  });

  it('supply wagons, at artillery speed, keep up with a 2-node retreat', () => {
    const g = battleGame({ cavalry: 3, infantry: 0, artillery: 0, supply: 1 });
    fight(g, { red: 'panic' });
    // n1 → a3 is a minor road: 2 nodes is within a wagon's speed of 2.
    expect(g.state.armies.R.node).toBe('a2');
    expect(unitsOf(g, 'R', 'supply')).toHaveLength(1);
    expect(unitsOf(g, 'R', 'cavalry')).toHaveLength(2);
  });
});

/** Free for all: red attacks blue at d2 from d3; green watches from x1 (or from x3, out of sight of the battle). */
function watchedBattle(greenAt: 'x1' | 'x3') {
  const g = new TestGame(testConfig({
    rules: { mode: 'freeForAll' },
    nations: [
      { id: 'red', name: 'Red', color: '#f00', side: 'attacker', threshold: 50 },
      { id: 'blue', name: 'Blue', color: '#00f', side: 'defender', threshold: 50 },
      { id: 'green', name: 'Green', color: '#0f0', side: 'attacker', threshold: 50 },
    ],
    nodes: testConfig().nodes!.map((n) => (n.id.startsWith('x') ? { ...n, owner: 'green' } : n)),
    generals: [{ id: 'gr', name: 'R', nation: 'red' }, { id: 'gb', name: 'B', nation: 'blue' }, { id: 'gg', name: 'G', nation: 'green' }],
    armies: [
      { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
      { id: 'B', nation: 'blue', node: greenAt === 'x1' ? 'd3' : 'd2', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 1 } },
      { id: 'G', nation: 'green', node: greenAt, generals: ['gg'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
    ],
  }));
  g.act('red', { type: 'move', army: 'R', path: greenAt === 'x1' ? ['n1'] : ['n1', 'd3'] });
  // From n1 red also touches green on x1: it fights blue first.
  if (greenAt === 'x1') g.act('red', { type: 'chooseBattle', defender: 'B' });
  g.state.hands = { red: [], blue: [], green: [] };
  return g;
}

describe('who sees a battle', () => {
  it('a battle in the fog of war is hidden entirely, with its log and its outcome', () => {
    const g = watchedBattle('x3');
    expect(g.state.battle!.witnesses.sort()).toEqual(['blue', 'red']);
    const green = filterForSeats(g.state, ['green']);
    expect(green.battle).toBeNull();
    expect(green.armies.R).toBeUndefined();
    expect(green.armies.B).toBeUndefined();
    g.dice = [6, 1, 6, 1, 6, 1];
    while (g.state.battle) fight(g);
    const report = (seat: string) => filterForSeats(g.state, [seat]).history.filter((e) => e.report);
    expect(report('red')).toHaveLength(1);
    expect(report('blue')).toHaveLength(1);
    expect(report('green')).toHaveLength(0);
    expect(report('red')[0].report!.finalRound).toBeTruthy();
    expect(filterForSeats(g.state, ['green']).history.some((e) => e.kind === 'battle')).toBe(false);
  });

  it('onlookers see the battle and its losses, but not how it is fought', () => {
    const g = watchedBattle('x1');
    expect(g.state.battle!.witnesses.sort()).toEqual(['blue', 'green', 'red']);
    g.dice = [6, 1];
    g.act('red', { type: 'battleChoice', choice: 'fight' });
    const green = filterForSeats(g.state, ['green']);
    expect(green.battle!.units).toEqual({ attacker: [], defender: [] });
    expect(green.battle!.choice).toEqual({ attacker: null, defender: null });
    expect(green.armies.R).toBeDefined();
    g.act('blue', { type: 'battleChoice', choice: 'fight' });
    expect(filterForSeats(g.state, ['green']).battle!.lost.defender).toEqual(['infantry']);
    expect(filterForSeats(g.state, ['green']).battle!.lastRound).toBeNull();
    expect(filterForSeats(g.state, ['red']).battle!.lastRound).not.toBeNull();
    const keys = (seat: string) => filterForSeats(g.state, [seat]).history.map((e) => e.msg?.key);
    expect(keys('green')).toContain('log.battle');
    expect(keys('green')).not.toContain('log.dice');
    expect(keys('blue')).toContain('log.dice');
    g.dice = [6, 1, 6, 1];
    // Red then goes on to fight green, which it also touches.
    while (g.state.battle?.defenderArmy === 'B') fight(g);
    const seen = (seat: string) => filterForSeats(g.state, [seat]).history.find((e) => e.report)!.report!;
    expect(seen('green').finalRound).toBeUndefined();
    expect(seen('red').finalRound!.duels.length).toBeGreaterThan(0);
  });

  it('an ally that is not fighting is an onlooker too', () => {
    const g = new TestGame(testConfig({
      nations: [
        { id: 'red', name: 'Red', color: '#f00', side: 'attacker', threshold: 50 },
        { id: 'blue', name: 'Blue', color: '#00f', side: 'defender', threshold: 50 },
        { id: 'pink', name: 'Pink', color: '#f0f', side: 'attacker', threshold: 50 },
      ],
      nodes: testConfig().nodes!.map((n) => (n.id === 'a1' ? { ...n, owner: 'pink' } : n)),
      generals: [{ id: 'gr', name: 'R', nation: 'red' }, { id: 'gb', name: 'B', nation: 'blue' }],
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    g.act('red', { type: 'move', army: 'R', path: ['n1'] });
    g.state.hands = { red: [], blue: [], pink: [] };
    g.dice = [6, 1];
    fight(g);
    const pink = filterForSeats(g.state, ['pink']);
    expect(pink.battle!.units.attacker).toEqual([]);
    expect(pink.history.some((e) => e.msg?.key === 'log.dice')).toBe(false);
    expect(filterForSeats(g.state, ['red']).history.some((e) => e.msg?.key === 'log.dice')).toBe(true);
  });
});

describe('battle report', () => {
  it('records both sides, their losses, the winner and how the loser left', () => {
    const g = battleGame(ART3, { cavalry: 0, infantry: 2, artillery: 0, supply: 1 });
    giveCards(g, 'blue', ['retreat']);
    g.dice = [6, 1];
    fight(g);
    fight(g, { blue: 'retreat' });
    const entry = g.state.history.find((e) => e.report)!;
    expect(entry.msg).toMatchObject({ key: 'log.battleWon', params: { nation: 'red', node: 'd3' } });
    expect(entry.report).toMatchObject({
      winner: 'attacker', rounds: 2,
      attacker: { nation: 'red', units: ['artillery', 'artillery', 'artillery'], lost: [], fate: 'held', generals: 1 },
      defender: { nation: 'blue', units: ['infantry', 'infantry', 'supply'], lost: ['infantry'], fate: 'retreated' },
      finalRound: { round: 2, choices: { attacker: 'fight', defender: 'retreat' }, dice: null },
    });
  });

  it('a destroyed army loses everything it had', () => {
    const g = battleGame({ cavalry: 1, infantry: 0, artillery: 0, supply: 0 }, { cavalry: 0, infantry: 1, artillery: 0, supply: 1 });
    g.dice = [6, 1];
    fight(g);
    expect(g.state.history.find((e) => e.report)!.report).toMatchObject({
      winner: 'attacker', defender: { fate: 'destroyed', lost: ['infantry', 'supply'] },
    });
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
    g.act('red', { type: 'battleChoice', choice: 'panic' });
    g.act('blue', { type: 'battleChoice', choice: 'fight' });
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
    g.act('red', { type: 'battleChoice', choice: 'fight' });
    g.act('blue', { type: 'battleChoice', choice: 'panic' });
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
    expect(chained.has('d2')).toBe(true);
    expect(chained.has('d1')).toBe(false); // blue's army stands there
  });

  it('tells whether a move would leave an army out of supply', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 3, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'S', nation: 'red', node: 'a1', generals: [], units: { cavalry: 0, infantry: 0, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    // Red land reaches n1 and d3 (2 nodes); the wagon on a1 reaches 4 nodes, to d3 as well. d2 is out.
    expect(suppliedAt(g.state, ['R'], 'd3')).toBe(true);
    expect(suppliedAt(g.state, ['R'], 'd2')).toBe(false);
    // A wagon moving along helps only if it is supplied itself where it ends up.
    expect(suppliedAt(g.state, ['R', 'S'], 'd1')).toBe(false);
    g.state.armies.S.node = 'd3';
    expect(suppliedAt(g.state, ['R'], 'd1')).toBe(true);
  });

  it('does not pass through enemy armies', () => {
    // A → B → C → D → E is a3 → n1 → d3 → d2 → d1: red land (a3) supplies the wagon on d3, which
    // supplies the army on d1, unless an enemy army stands on the way.
    const withBlue = (node: string) => new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'd1', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'S', nation: 'red', node: 'd3', generals: [], units: { cavalry: 0, infantry: 0, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node, generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    expect(suppliedNodes(withBlue('x3').state, 'attacker').has('d1')).toBe(true);
    for (const node of ['a3', 'n1', 'd2']) {
      const supplied = suppliedNodes(withBlue(node).state, 'attacker');
      expect(supplied.has('d1'), `blue on ${node}`).toBe(false);
      expect(supplied.has(node), `blue on ${node}`).toBe(false);
    }
    // Blocked at n1, the wagon itself is cut off; blocked at d2, only what lies beyond it.
    expect(suppliedNodes(withBlue('n1').state, 'attacker').has('d3')).toBe(false);
    expect(suppliedNodes(withBlue('d2').state, 'attacker').has('d3')).toBe(true);
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

describe('supply wagons', () => {
  it('carry supply 4 nodes', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    const supplied = suppliedNodes(g.state, 'attacker');
    // From the wagon on a3: n1, d3, d2 and d1 (4 nodes); red land alone reaches d3. x3 holds a
    // blue army, so the supply stops at x2.
    expect(supplied.has('d1')).toBe(true);
    expect(supplied.has('x2')).toBe(true);
    expect(supplied.has('x3')).toBe(false);
  });

  it('move as fast as artillery', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: [], units: { cavalry: 0, infantry: 0, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    expect(armySpeed(g.state.armies.R)).toBe(2);
  });

  it('and they alone move through enemy territory without a general', () => {
    const g = new TestGame(testConfig({
      generals: [{ id: 'gb', name: 'B', nation: 'blue' }],
      armies: [
        { id: 'W', nation: 'red', node: 'd3', generals: [], units: { cavalry: 0, infantry: 0, artillery: 0, supply: 2 } },
        { id: 'C', nation: 'red', node: 'd2', generals: [], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node: 'x3', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
    expect(reachable(g.state, g.state.armies.W).size).toBeGreaterThan(0);
    expect(reachable(g.state, g.state.armies.C).size).toBe(0);
    g.act('red', { type: 'move', army: 'W', path: ['n1'] });
    expect(g.state.armies.W.node).toBe('n1');
    expect(() => g.act('red', { type: 'move', army: 'C', path: ['d1'] })).toThrow(/without a general/);
  });
});

describe('unit cap and muster', () => {
  /** Red owns a1 (8 VP, a muster town) and a2 (4 VP): a cap of 6 units. */
  function musterGame(redUnits = 4) {
    return new TestGame(testConfig({
      nodes: testConfig().nodes!.map((n) => (n.id === 'a1' ? { ...n, vp: 8 } : n.id === 'a2' ? { ...n, vp: 4 } : n)),
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: redUnits, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
      ],
    }));
  }

  it('caps units at half the starting victory points', () => {
    const g = musterGame();
    expect(g.state.nations.find((n) => n.id === 'red')!.unitCap).toBe(6);
    expect(g.state.nations.find((n) => n.id === 'blue')!.unitCap).toBe(2);
  });

  it('musters one unit per turn in a town worth more than 5 VP', () => {
    const g = musterGame();
    expect(musterNodes(g.state, 'red')).toEqual(['a1']);
    expect(() => g.act('red', { type: 'muster', node: 'a2', unit: 'infantry' })).toThrow(/worth more than 5 VP/);
    g.act('red', { type: 'muster', node: 'a1', unit: 'infantry' });
    const army = Object.values(g.state.armies).find((a) => a.nation === 'red' && a.node === 'a1')!;
    expect(army.units.map((u) => u.type)).toEqual(['infantry']);
    expect(unitCount(g.state, 'red')).toBe(5);
    expect(() => g.act('red', { type: 'muster', node: 'a1', unit: 'infantry' })).toThrow(/already mustered/);
    // Next turn it can muster again.
    g.act('red', { type: 'endTurn' });
    while (g.state.current !== 'red' || g.prompt('red')?.kind !== 'movement') {
      const p = g.state.pending[0];
      if (p.kind === 'movement') g.act(p.nation, { type: 'endTurn' });
      else if (p.kind === 'recruit') g.act(p.nation, { type: 'recruit', node: p.options[0], unit: 'infantry' });
      else if (p.kind === 'sabotage') g.act(p.nation, { type: 'sabotage', army: p.options[0] });
      else throw new Error(`unexpected ${p.kind}`);
    }
    expect(musterBlocked(g.state, 'red')).toBeNull();
  });

  it('without a town worth more than 5 VP, any own town with victory points will do', () => {
    const g = musterGame();
    // a1 occupied by blue: red falls back to a2 (4 VP); a3 (0 VP) never counts.
    g.state.nodes.a1.controller = 'blue';
    expect(musterNodes(g.state, 'red')).toEqual(['a2']);
    g.act('red', { type: 'muster', node: 'a2', unit: 'infantry' });
    expect(unitCount(g.state, 'red')).toBe(5);
  });

  it('gives every nation on the China map a place to muster', () => {
    const cfg = parseConfig(JSON.parse(readFileSync(new URL('../../../Map/China/config.json', import.meta.url), 'utf8')));
    const s = initialState(cfg);
    expect(musterNodes(s, 'Mongol')).toHaveLength(3);
    for (const n of s.nations) expect(musterNodes(s, n.id).length).toBeGreaterThan(0);
  });

  it('reports how close a nation is to collapse', () => {
    const g = musterGame();
    g.state.nodes.a1.controller = 'blue';
    g.state.nations[0].warExhaustion = 3;
    // Red owns 8 + 4 VP and holds 4: 33.3% held, minus 3 exhaustion, against a threshold of 50.
    expect(warStatus(g.state, 'red')).toMatchObject({ vpOwned: 12, vpHeld: 4, warExhaustion: 3, threshold: 50 });
    expect(warStatus(g.state, 'red').willingness).toBeCloseTo(30.33, 1);
    expect(warStatus(g.state, 'red').margin).toBeCloseTo(-19.67, 1);
  });

  it('a nation with no armies left stays in the war and can muster again', () => {
    const g = musterGame();
    delete g.state.armies.R;
    checkVictory(g.state);
    expect(g.state.nations.find((n) => n.id === 'red')!.knockedOut).toBe(false);
    expect(g.state.winner).toBeNull();
    g.act('red', { type: 'muster', node: 'a1', unit: 'cavalry' });
    expect(unitCount(g.state, 'red')).toBe(1);
  });

  it('stops at the cap, which events can go past', () => {
    const g = musterGame(6);
    expect(musterBlocked(g.state, 'red')).toBe('cap');
    expect(() => g.act('red', { type: 'muster', node: 'a1', unit: 'infantry' })).toThrow(/unit cap/);
    // A Recruit event still adds units beyond the cap.
    g.state.pending = [{ nation: 'red', kind: 'recruit', what: 'unit', remaining: 1, options: ['a1'] }];
    g.act('red', { type: 'recruit', node: 'a1', unit: 'cavalry' });
    expect(unitCount(g.state, 'red')).toBe(7);
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
    const g = battleGame(undefined, undefined, true);
    g.dice = [6, 1, 2, 5];
    fight(g);
    fight(g);
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
