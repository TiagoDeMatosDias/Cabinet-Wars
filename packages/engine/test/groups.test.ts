import { describe, expect, it } from 'vitest';
import { battleOdds, matchupsFrom, randomTargets, RULES_VERSION, scoreDuels, type UnitType } from '../src';
import { TestGame, testConfig } from './helpers';

const units = (n: number) => ({ cavalry: 0, infantry: n, artillery: 0, supply: 0 });

/** Rules version 3: red (attacking) and blue armies about to fight. */
function groupBattle(red: number, blue: number) {
  const cfg = testConfig({
    armies: [
      { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: units(red) },
      { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: units(blue) },
    ],
  });
  const g = new TestGame({ ...cfg, rules: { ...(cfg.rules ?? {}), version: RULES_VERSION } });
  g.act('red', { type: 'move', army: 'R', path: ['n1'] });
  g.state.hands = { red: [], blue: [] };
  return g;
}

function fightRound(g: TestGame) {
  g.act('red', { type: 'battleChoice', choice: 'fight' });
  g.act('blue', { type: 'battleChoice', choice: 'fight' });
}

describe('group battles (rules version 3)', () => {
  it('several units fight a lone unit together; only their best die counts', () => {
    const g = groupBattle(4, 1); // 2 dice against 1
    expect(g.state.battle!.matchups).toEqual([{ attacker: [0, 1], defender: [0] }]);
    g.dice = [2, 5, 4];
    fightRound(g);
    // 5 beats 4: the lone defender falls and the battle is over.
    expect(g.state.armies.B).toBeUndefined();
    expect(g.state.armies.R.units.length).toBe(4);
  });

  it('a lone unit that beats the group destroys only one unit: the best one', () => {
    const g = groupBattle(4, 1);
    const [, second] = g.state.battle!.units.attacker;
    g.dice = [2, 3, 6];
    fightRound(g);
    expect(g.state.armies.R.units.length).toBe(3);
    expect(g.state.armies.R.units.some((u) => u.id === second)).toBe(false);
    expect(g.state.battle!.lastRound!.duels).toMatchObject([{ attacker: 1, defender: 0, attackerPoints: 3, defenderPoints: 6, winner: 'defender' }]);
  });

  it('works the other way round: a larger defender gangs up on the attacker', () => {
    const g = groupBattle(1, 4);
    expect(g.state.battle!.matchups).toEqual([{ attacker: [0], defender: [0, 1] }]);
    g.dice = [4, 1, 4];
    fightRound(g);
    // The defender's best, 4, ties the attacker's 4: ties go to the defender.
    expect(g.state.armies.R).toBeUndefined();
    expect(g.state.armies.B.units.length).toBe(4);
  });

  it('every drawn unit fights, and each unit of the smaller side faces at least one', () => {
    let seed = 7;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let n = 0; n < 200; n++) {
      const a = 1 + rnd(4);
      const d = 1 + rnd(4);
      const ms = matchupsFrom(a, d, randomTargets(a, d, true, rnd), true);
      expect(ms.length).toBe(Math.min(a, d));
      expect(ms.flatMap((m) => m.attacker).sort()).toEqual([...Array(a).keys()]);
      expect(ms.flatMap((m) => m.defender).sort()).toEqual([...Array(d).keys()]);
      expect(ms.every((m) => m.attacker.length === 1 || m.defender.length === 1)).toBe(true);
    }
  });

  it('the lone unit gets its type bonus against the unit whose die counts', () => {
    const types: Record<'attacker' | 'defender', UnitType[]> = { attacker: ['infantry', 'artillery'], defender: ['cavalry'] };
    // Infantry beats cavalry (+1): 4+1 = 5 against the cavalry's 4. Artillery rolled 3.
    const [d] = scoreDuels(types, { attacker: ['i', 'a'], defender: ['c'] }, [{ attacker: [0, 1], defender: [0] }], { attacker: [4, 3], defender: [4] }, []);
    expect(d).toMatchObject({ attacker: 0, attackerPoints: 5, attackerBonus: 1, defenderPoints: 4, defenderBonus: 0, winner: 'attacker', destroyed: 'c' });
  });

  it('the odds follow the group rule', () => {
    // A lone unit can take at most one attacker with it per round, so a big army loses little.
    const o = battleOdds(Array<UnitType>(10).fill('infantry'), [['infantry']]);
    expect(o.win).toBeGreaterThan(0.8);
    expect(o.lossesIfWin).toBeLessThan(1);
  });
});
