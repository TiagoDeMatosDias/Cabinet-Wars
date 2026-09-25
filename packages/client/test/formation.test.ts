import { describe, expect, it } from 'vitest';
import type { UnitType } from '@cabinet-wars/engine';
import { formation } from '../src/render/formation';

const army = (units: Partial<Record<UnitType, number>>, generals = 0) => ({
  units: Object.entries(units).flatMap(([type, n]) => Array.from({ length: n ?? 0 }, (_, i) => ({ id: `${type}${i}`, type: type as UnitType }))),
  generals: Array.from({ length: generals }, (_, i) => `g${i}`),
});

const tally = (f: string[]) => f.reduce<Record<string, number>>((o, k) => ({ ...o, [k]: (o[k] ?? 0) + 1 }), {});

describe('formation', () => {
  it('shows one figure per two combat units', () => {
    expect(formation(army({ infantry: 1 }))).toEqual(['infantry']);
    expect(formation(army({ infantry: 4 }))).toEqual(['infantry', 'infantry']);
    expect(formation(army({ infantry: 5 }))).toEqual(['infantry', 'infantry', 'infantry']);
  });

  it('caps the combat figures', () => {
    expect(formation(army({ infantry: 30 }))).toHaveLength(5);
  });

  it('shares figures by composition and keeps every type visible', () => {
    // 10 combat units → 5 figures: 6 infantry, 3 cavalry, 1 artillery.
    expect(tally(formation(army({ infantry: 6, cavalry: 3, artillery: 1 })))).toEqual({ infantry: 3, cavalry: 1, artillery: 1 });
    expect(tally(formation(army({ infantry: 2, cavalry: 8 })))).toEqual({ cavalry: 4, infantry: 1 });
  });

  it('shows the most numerous types when figures are short', () => {
    // 3 combat units → 2 figures for 3 types.
    expect(tally(formation(army({ infantry: 1, cavalry: 1, artillery: 1 })))).toEqual({ infantry: 1, cavalry: 1 });
  });

  it('adds wagons and generals, ordered back to front', () => {
    expect(formation(army({ infantry: 2, supply: 3 }, 1))).toEqual(['supply', 'supply', 'infantry', 'general']);
    expect(formation(army({ supply: 9 }, 5))).toEqual(['supply', 'supply', 'general', 'general']);
    expect(formation(army({}, 1))).toEqual(['general']);
  });

  it('follows the theme rules', () => {
    expect(formation(army({ infantry: 9 }), { unitsPerFigure: 3, maxFigures: 8, maxWagons: 1, maxGenerals: 1 })).toHaveLength(3);
  });
});
