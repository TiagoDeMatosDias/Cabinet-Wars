import { describe, expect, it } from 'vitest';
import { dependentsOf, orderToIntents, projectOrders, type Order } from '../src';
import { TestGame, testConfig } from './helpers';

const unitsOf = (g: TestGame, army: string, type?: string) =>
  g.state.armies[army].units.filter((u) => !type || u.type === type).map((u) => u.id);

describe('transfer', () => {
  it('redistributes units and generals between armies on one node', () => {
    const g = new TestGame(testConfig({
      generals: [{ id: 'gr', name: 'A', nation: 'red' }, { id: 'gr2', name: 'B', nation: 'red' }, { id: 'gb', name: 'C', nation: 'blue' }],
      armies: [
        { id: 'R', nation: 'red', node: 'a1', generals: ['gr', 'gr2'], units: { cavalry: 2, infantry: 2, artillery: 0, supply: 1 } },
        { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    const [c0, c1] = unitsOf(g, 'R', 'cavalry');
    const rest = g.state.armies.R.units.filter((u) => u.id !== c0 && u.id !== c1).map((u) => u.id);
    g.act('red', { type: 'transfer', groups: [{ army: 'R', units: rest, generals: ['gr'] }, { army: null, units: [c0, c1], generals: ['gr2'] }] });
    const armies = Object.values(g.state.armies).filter((a) => a.nation === 'red');
    expect(armies).toHaveLength(2);
    expect(armies.find((a) => a.id !== 'R')!.units.map((u) => u.type)).toEqual(['cavalry', 'cavalry']);
  });

  it('rejects groups that lose units, and allows armies without a general', () => {
    const g = new TestGame();
    const all = unitsOf(g, 'R');
    expect(() => g.act('red', { type: 'transfer', groups: [{ army: 'R', units: all.slice(1), generals: ['gr'] }] })).toThrow(/every unit/);
    g.act('red', { type: 'transfer', groups: [{ army: 'R', units: [all[3]], generals: ['gr'] }, { army: null, units: all.slice(0, 3), generals: [] }] });
    expect(Object.values(g.state.armies).filter((a) => a.nation === 'red')).toHaveLength(2);
  });
});

describe('order projection', () => {
  it('projects a split, then a move of the new army via its placeholder', () => {
    const g = new TestGame();
    const orders: Order[] = [
      { id: 'o1', intent: { type: 'split', army: 'R', units: unitsOf(g, 'R').filter((u) => !u.includes('.s')), generals: ['gr'], creates: '@1' } },
      { id: 'o2', intent: { type: 'move', army: '@1', path: ['a2', 'a3', 'n1'] } },
    ];
    const p = projectOrders(g.state, 'red', orders);
    expect(p.results.map((r) => r.ok)).toEqual([true, true]);
    expect(p.state.armies[p.ids.get('@1')!].node).toBe('n1');
    expect(p.state.armies.R.node).toBe('a1');
    expect([...dependentsOf(orders, 'o1')]).toEqual(['o2']);
  });

  it('reports an invalid order and its dependents without stopping the rest', () => {
    const g = new TestGame();
    const orders: Order[] = [
      { id: 'o1', intent: { type: 'move', army: 'R', path: ['a2', 'a3', 'n1'] } }, // too far with supply
      { id: 'o2', intent: { type: 'move', army: 'R', path: ['a2'] } },
    ];
    const p = projectOrders(g.state, 'red', orders);
    expect(p.results[0]).toMatchObject({ ok: false });
    expect(p.results[1]).toMatchObject({ ok: true, path: ['a1', 'a2'] });
  });

  it('flags moves that end next to a known enemy', () => {
    const g = new TestGame(testConfig({
      armies: [
        { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 1, infantry: 0, artillery: 0, supply: 0 } },
        { id: 'B', nation: 'blue', node: 'd3', generals: ['gb'], units: { cavalry: 0, infantry: 1, artillery: 0, supply: 0 } },
      ],
    }));
    const p = projectOrders(g.state, 'red', [{ id: 'o1', intent: { type: 'move', army: 'R', path: ['n1'] } }]);
    expect(p.results[0].meetsEnemy).toBe(true);
  });

  it('predicts the ids that executing an order creates', () => {
    const g = new TestGame();
    const intent = { type: 'split' as const, army: 'R', units: unitsOf(g, 'R', 'supply'), generals: [], creates: '@9' };
    const { intents, created } = orderToIntents(intent, new Map(), 'red', g.state.nextId);
    g.act('red', intents[0]);
    expect(g.state.armies[created.get('@9')!]).toBeDefined();
  });
});
