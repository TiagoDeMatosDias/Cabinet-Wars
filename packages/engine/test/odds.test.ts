import { expect, it } from 'vitest';
import { battleOdds, type UnitType } from '../src';

const army = (n: Partial<Record<UnitType, number>>): UnitType[] => Object.entries(n).flatMap(([t, k]) => Array<UnitType>(k!).fill(t as UnitType));

it('a much bigger army almost always wins, a much smaller one almost never', () => {
  expect(battleOdds(army({ infantry: 12 }), [army({ infantry: 2 })]).win).toBeGreaterThan(0.95);
  expect(battleOdds(army({ infantry: 2 }), [army({ infantry: 12 })]).win).toBeLessThan(0.05);
});

it('ties go to the defender, so an even fight favours it', () => {
  expect(battleOdds(army({ infantry: 6 }), [army({ infantry: 6 })]).win).toBeLessThan(0.5);
});

it('unit-type advantage counts: infantry beats cavalry', () => {
  const inf = battleOdds(army({ infantry: 5 }), [army({ cavalry: 5 })]).win;
  const art = battleOdds(army({ artillery: 5 }), [army({ cavalry: 5 })]).win;
  expect(inf).toBeGreaterThan(art);
});

it('supply units do not fight, and an army without combat units cannot win', () => {
  expect(battleOdds(army({ supply: 3 }), [army({ infantry: 1 })]).win).toBe(0);
  expect(battleOdds(army({ infantry: 3 }), [army({ supply: 2 })]).win).toBe(1);
});

it('several enemy armies are fought one after the other', () => {
  const one = battleOdds(army({ infantry: 8 }), [army({ infantry: 3 })]).win;
  const two = battleOdds(army({ infantry: 8 }), [army({ infantry: 3 }), army({ infantry: 3 })]).win;
  expect(two).toBeLessThan(one);
});

it('the same matchup always gives the same odds', () => {
  const a = battleOdds(army({ infantry: 4, cavalry: 2 }), [army({ artillery: 3 })]);
  const b = battleOdds(army({ cavalry: 2, infantry: 4 }), [army({ artillery: 3 })]);
  expect(a).toEqual(b);
  expect(a.lossesIfWin).toBeLessThanOrEqual(6);
});
