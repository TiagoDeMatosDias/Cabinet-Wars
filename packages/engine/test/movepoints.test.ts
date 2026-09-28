import { describe, expect, it } from 'vitest';
import { reachable, RULES_VERSION, type MapConfigInput } from '../src';
import { TestGame, testConfig } from './helpers';

const v3 = (overrides: Partial<MapConfigInput> = {}): MapConfigInput => {
  const cfg = testConfig(overrides);
  return { ...cfg, rules: { ...(cfg.rules ?? {}), version: RULES_VERSION } };
};
const only = (units: Partial<Record<'cavalry' | 'infantry' | 'artillery' | 'supply', number>>, generals = ['gr']) => v3({
  armies: [
    { id: 'R', nation: 'red', node: 'a1', generals, units: { cavalry: 0, infantry: 0, artillery: 0, supply: 0, ...units } },
    { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
  ],
});

// Test map:  a1 = a2 = a3 - n1 - d3 = d2 = d1, and n1 - x1 - x2 - x3   (= major: 1 point, - minor: 2 points)
describe('movement points (rules version 3)', () => {
  it('major roads cost 1 point and minor roads 2, mixed freely', () => {
    // Supply wagons: 4 points. a1→a2→a3 (1 + 1) then the minor road to n1 (2) = 4.
    const g = new TestGame(only({ supply: 1 }, []));
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1'] });
    expect(g.state.armies.R.node).toBe('n1');
    expect(g.state.armies.R.moved.points).toBe(4);
    expect(() => g.act('red', { type: 'move', army: 'R', path: ['x1'] })).toThrow(/Not enough movement/);
  });

  it('points left over carry on to the next move this turn', () => {
    // Infantry: 6 points. 2 on major roads, then 2 + 2 on minor roads.
    const g = new TestGame(only({ infantry: 1 }));
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3'] });
    g.act('red', { type: 'move', army: 'R', path: ['n1', 'x1'] });
    expect(g.state.armies.R.node).toBe('x1');
    expect(() => g.act('red', { type: 'move', army: 'R', path: ['x2'] })).toThrow(/Not enough movement/);
  });

  it('an army moves as far as the member with the fewest points', () => {
    const g = new TestGame(only({ cavalry: 2, artillery: 1 }));
    // Artillery (4 points) holds back the cavalry (8).
    expect([...reachable(g.state, g.state.armies.R).keys()].sort()).toEqual(['a2', 'a3', 'n1']);
    g.act('red', { type: 'split', army: 'R', units: g.state.armies.R.units.filter((u) => u.type === 'artillery').map((u) => u.id), generals: [] });
    // Cavalry and general: 8 points = 1 + 1 + 2 + 2 + 2, to x2.
    expect(reachable(g.state, g.state.armies.R).has('x2')).toBe(true);
    expect(reachable(g.state, g.state.armies.R).has('x3')).toBe(false);
  });

  it('+1 Moves adds one road of any kind (2 points)', () => {
    const g = new TestGame(only({ supply: 1 }, []));
    const card = 'extra-moves';
    g.state.hands.red.push({ id: card, type: 'moves+1' });
    g.act('red', { type: 'playMoves', army: 'R', card });
    g.act('red', { type: 'move', army: 'R', path: ['a2', 'a3', 'n1', 'x1'] });
    expect(g.state.armies.R.node).toBe('x1');
  });
});

describe('reachable (rules version 3)', () => {
  it('takes the cheapest path, not the one through the fewest nodes', () => {
    // a1 - x1 - n1 on minor roads (4 points) or a1 = a2 = a3 = n1 on major roads (3 points).
    const base = only({ infantry: 1 });
    const g = new TestGame({
      ...base,
      edges: [
        { a: 'a1', b: 'a2', type: 'major' }, { a: 'a2', b: 'a3', type: 'major' }, { a: 'a3', b: 'n1', type: 'major' },
        { a: 'a1', b: 'x1', type: 'minor' }, { a: 'x1', b: 'n1', type: 'minor' },
        { a: 'n1', b: 'd3', type: 'minor' }, { a: 'd3', b: 'd2', type: 'major' }, { a: 'd2', b: 'd1', type: 'major' },
        { a: 'x2', b: 'x3', type: 'minor' }, { a: 'x3', b: 'd1', type: 'minor' },
      ],
    });
    const path = reachable(g.state, g.state.armies.R).get('n1');
    expect(path).toEqual(['a2', 'a3', 'n1']);
    g.act('red', { type: 'move', army: 'R', path: path! });
    expect(g.state.armies.R.moved.points).toBe(3);
  });
});
