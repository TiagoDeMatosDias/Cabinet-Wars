import type { Army, UnitType } from '@cabinet-wars/engine';

/** What a miniature figure depicts: a unit type or a general. */
export type FigureKind = UnitType | 'general';

export interface FormationRules {
  /** Combat units per figure: an army of 5 combat units with 2 per figure shows 3 figures. */
  unitsPerFigure: number;
  /** Most combat figures shown for one army. */
  maxFigures: number;
  /** Most supply wagons shown (one per `unitsPerFigure` supply units). */
  maxWagons: number;
  /** Most general figures shown. */
  maxGenerals: number;
}

export const DEFAULT_RULES: FormationRules = { unitsPerFigure: 2, maxFigures: 5, maxWagons: 2, maxGenerals: 2 };

const COMBAT: UnitType[] = ['infantry', 'cavalry', 'artillery'];
/** Back to front: wagons at the rear, the general in front. */
const DEPTH: FigureKind[] = ['supply', 'artillery', 'cavalry', 'infantry', 'general'];

/**
 * The figures that stand for an army, back to front.
 *
 * The number of combat figures grows with the army's combat units (one per `unitsPerFigure`, at
 * least one, at most `maxFigures`) and is shared between the unit types in proportion to their
 * numbers (D'Hondt): every type present gets a figure while there are enough figures, so a lone
 * cannon in a big army still shows. Supply adds wagons and generals add general figures.
 */
export function formation(army: Pick<Army, 'units' | 'generals'>, rules: FormationRules = DEFAULT_RULES): FigureKind[] {
  const count = (t: UnitType) => army.units.filter((u) => u.type === t).length;
  const present = COMBAT.map((type) => ({ type, n: count(type), shown: 0 })).filter((c) => c.n > 0)
    // Most numerous first; ties keep the COMBAT order.
    .sort((a, b) => b.n - a.n);
  const total = present.reduce((s, c) => s + c.n, 0);
  const out: FigureKind[] = [];
  if (total > 0) {
    let slots = Math.max(1, Math.min(rules.maxFigures, Math.ceil(total / Math.max(1, rules.unitsPerFigure))));
    for (const c of present) if (slots > 0) { c.shown = 1; slots--; }
    while (slots > 0) {
      const next = present.reduce((best, c) => (c.n / (c.shown + 1) > best.n / (best.shown + 1) ? c : best));
      next.shown++;
      slots--;
    }
    for (const c of present) for (let i = 0; i < c.shown; i++) out.push(c.type);
  }
  const supply = count('supply');
  for (let i = 0; i < Math.min(rules.maxWagons, Math.ceil(supply / Math.max(1, rules.unitsPerFigure))); i++) out.push('supply');
  for (let i = 0; i < Math.min(rules.maxGenerals, army.generals.length); i++) out.push('general');
  return out.sort((a, b) => DEPTH.indexOf(a) - DEPTH.indexOf(b));
}
