import type { UnitType } from './types';
import { diceFor } from './graph';
import { typeBonus } from './battle';

export interface BattleOdds {
  /** Share of simulated battles (0–1) the attacker won: every enemy army destroyed, the attacker still standing. */
  win: number;
  /** Average combat units the attacker lost. */
  attackerLosses: number;
  /** Average combat units the attacker lost in the battles it won (0 when it never wins). */
  lossesIfWin: number;
  /** Average combat units the enemy armies lost, all together. */
  defenderLosses: number;
}

const TRIALS = 1000;
const cache = new Map<string, BattleOdds>();

/** A small seeded generator, so the same matchup always shows the same odds. */
function mulberry32(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Picks `k` distinct indexes out of `n`. */
function pick(n: number, k: number, rnd: () => number): number[] {
  const xs = [...Array(n).keys()];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rnd() * (n - i));
    [xs[i], xs[j]] = [xs[j], xs[i]];
  }
  return xs.slice(0, k);
}

/**
 * Fights one battle to the end with the rules of battle.ts: each round both sides draw units by
 * their dice count, each attacking unit faces a random drawn defender, the higher die (plus the
 * unit-type bonus) wins, ties go to the defender, and the loser is destroyed. No cards, no retreats.
 * Mutates both unit lists; returns true when the attacker is left standing.
 */
function fight(att: UnitType[], def: UnitType[], rnd: () => number): boolean {
  const die = () => 1 + Math.floor(rnd() * 6);
  while (att.length && def.length) {
    const a = pick(att.length, diceFor(att.length), rnd);
    const d = pick(def.length, diceFor(def.length), rnd);
    const lostA = new Set<number>();
    const lostD = new Set<number>();
    for (const i of a) {
      const j = d[Math.floor(rnd() * d.length)];
      const ap = die() + typeBonus(att[i], [def[j]]);
      const dp = die() + typeBonus(def[j], [att[i]]);
      if (ap > dp) lostD.add(j); else lostA.add(i);
    }
    for (const i of [...lostA].sort((x, y) => y - x)) att.splice(i, 1);
    for (const j of [...lostD].sort((x, y) => y - x)) def.splice(j, 1);
  }
  return att.length > 0;
}

/**
 * The attacker's chances against the enemy armies it will meet, fought one after the other as the
 * game does. Only combat units fight; an army without any is destroyed at once. Roll cards,
 * retreats and panics are left out, so this is the chance of a straight fight.
 */
export function battleOdds(attacker: UnitType[], defenders: UnitType[][]): BattleOdds {
  const combat = (xs: UnitType[]) => xs.filter((u) => u !== 'supply').sort();
  const att0 = combat(attacker);
  const defs0 = defenders.map(combat);
  const key = `${att0.join()}|${defs0.map((d) => d.join()).join('/')}`;
  const hit = cache.get(key);
  if (hit) return hit;
  let seed = 0;
  for (let i = 0; i < key.length; i++) seed = Math.imul(seed ^ key.charCodeAt(i), 0x01000193);
  const rnd = mulberry32(seed);
  let wins = 0;
  let attLost = 0;
  let winLost = 0;
  let defLost = 0;
  const defTotal = defs0.reduce((s, d) => s + d.length, 0);
  for (let n = 0; n < TRIALS; n++) {
    const att = [...att0];
    let left = defTotal;
    let won = att.length > 0;
    for (const d0 of defs0) {
      if (!won) break;
      const def = [...d0];
      won = fight(att, def, rnd);
      left -= d0.length - def.length;
    }
    if (won) { wins++; winLost += att0.length - att.length; }
    attLost += att0.length - att.length;
    defLost += defTotal - left;
  }
  const odds = { win: wins / TRIALS, attackerLosses: attLost / TRIALS, lossesIfWin: wins ? winLost / wins : 0, defenderLosses: defLost / TRIALS };
  if (cache.size > 500) cache.clear();
  cache.set(key, odds);
  return odds;
}
