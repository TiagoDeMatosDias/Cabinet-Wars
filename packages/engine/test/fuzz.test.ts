import { it, expect } from 'vitest';
import {
  advanceCopy, apply, parseConfig, initialState, reachable, replay, filterForSeats,
  ROLL_CARDS, type BattleChoice, type GameState, type Intent, type LogEntry,
} from '../src';
import { testConfig } from './helpers';

const cfg = parseConfig(testConfig({
  armies: [
    { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 4, artillery: 1, supply: 2 } },
    { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 1, infantry: 4, artillery: 1, supply: 1 } },
  ],
}));
let seed = 1;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
const fy = (n: number) => { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const pick = <T,>(xs: T[]) => xs[rnd(xs.length)];

function choose(s: GameState, nation: string): Intent {
  const p = s.pending.find((x) => x.nation === nation)!;
  const b = s.battle;
  switch (p.kind) {
    case 'movement': {
      const mine = Object.values(s.armies).filter((a) => a.nation === nation && !a.moved.stopped);
      if (mine.length && rnd(10) < 8) {
        const a = pick(mine);
        const opts = [...reachable(s, a).values()];
        if (opts.length) return { type: 'move', army: a.id, path: pick(opts) };
      }
      const moves = s.hands[nation].find((c) => c.type === 'moves+1');
      if (moves && mine.length && rnd(4) === 0) return { type: 'playMoves', army: mine[0].id, card: moves.id };
      // Occasionally reorganize: move a supply unit between two armies on the same node.
      const pair = mine.flatMap((a) => mine.filter((b) => b.id < a.id && b.node === a.node).map((b) => [a, b] as const))[0];
      if (pair && rnd(3) === 0) {
        const [a, b] = pair;
        const supply = a.units.find((u) => u.type === 'supply');
        if (supply && a.units.length > 1) {
          return { type: 'transfer', groups: [
            { army: a.id, units: a.units.filter((u) => u !== supply).map((u) => u.id), generals: a.generals },
            { army: b.id, units: [...b.units.map((u) => u.id), supply.id], generals: b.generals },
          ] };
        }
      }
      const splittable = mine.find((a) => a.units.some((u) => u.type === 'supply') && a.units.length > 2);
      if (splittable && rnd(5) === 0) return { type: 'split', army: splittable.id, units: [splittable.units.find((u) => u.type === 'supply')!.id], generals: [] };
      return { type: 'endTurn' };
    }
    case 'chooseBattle': return { type: 'chooseBattle', defender: pick(p.options) };
    case 'battleChoice': {
      const hand = s.hands[nation];
      const options: BattleChoice[] = ['fight', 'fight', 'fight', 'panic'];
      if (hand.some((c) => c.type === 'retreat')) options.push('retreat');
      if (hand.some((c) => c.type === 'blockRetreat')) options.push('block');
      return { type: 'battleChoice', choice: pick(options) };
    }
    case 'battleCards': {
      const cards = s.hands[nation].filter((c) => ROLL_CARDS.includes(c.type) && rnd(2) === 0).map((c) => {
        const r = pick(['attacker', 'defender'] as const);
        return { cardId: c.id, role: r, die: rnd(b!.dice![r].length) };
      });
      return { type: 'battleCards', cards };
    }
    case 'retreat': {
      const moves = s.hands[nation].find((c) => c.type === 'moves+1');
      if (moves && rnd(2) === 0) return { type: 'playMoves', army: p.army, card: moves.id };
      return { type: 'retreat' };
    }
    case 'attrition': return { type: 'attrition', unit: pick(s.armies[p.army].units).id };
    case 'sabotage': return { type: 'sabotage', army: pick(p.options) };
    case 'recruit': return { type: 'recruit', node: pick(p.options), unit: pick(['cavalry', 'infantry', 'artillery', 'supply'] as const) };
  }
}

/** `n` random distinct items. */
function fyPick<T>(items: T[], n: number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, n);
}

/** Plays random legal moves to catch crashes, stalls and replay drift. */
it('random games never crash or stall', () => {
  const stats = { games: 0, steps: 0, battles: 0, winners: {} as Record<string, number>, errors: 0 };
  for (let g = 0; g < 80; g++) {
    seed = g + 1;
    const init = initialState(g % 2 ? { ...cfg, rules: { ...cfg.rules, mode: 'freeForAll' } } : cfg);
    let s = advanceCopy(init);
    const log: LogEntry[] = [];
    const push = (e: LogEntry) => { s = apply(s, e); log.push(e); };
    const oracle = () => { while (s.oracle) { const o = s.oracle; push(o.kind === 'shuffle'
      ? { seq: log.length, by: 'host', intent: { type: 'shuffle', deck: o.deck, order: fy(o.n) } }
      : o.kind === 'select'
        ? { seq: log.length, by: 'host', intent: { type: 'select', attacker: fy(o.attacker).slice(0, o.attackerPick), defender: fy(o.defender).slice(0, o.defenderPick), targets: Array.from({ length: o.attackerPick }, () => rnd(o.defenderPick)) } }
        : { seq: log.length, by: 'host', intent: { type: 'roll', attacker: Array.from({ length: o.attacker }, () => rnd(6) + 1), defender: Array.from({ length: o.defender }, () => rnd(6) + 1) } }); } };
    oracle();
    let steps = 0;
    while (s.phase !== 'gameOver' && steps < 3000) {
      expect(s.pending.length, `stuck in ${s.phase}`).toBeGreaterThan(0);
      const p = s.pending[0];
      const intent = choose(s, p.nation);
      try { push({ seq: log.length, by: p.nation, intent }); } catch (e) {
        stats.errors++;
        if (p.kind === 'movement') push({ seq: log.length, by: p.nation, intent: { type: 'endTurn' } });
        else throw e;
      }
      if (s.battle && s.battle.round === 1 && s.battle.step === 'choose') stats.battles++;
      oracle();
      filterForSeats(s, [p.nation]);
      steps++;
    }
    stats.games++; stats.steps += steps;
    stats.winners[s.winner ?? 'none'] = (stats.winners[s.winner ?? 'none'] ?? 0) + 1;
    if (g % 20 === 0) expect(replay(init, JSON.parse(JSON.stringify(log)))).toEqual(s);
  }
  expect(stats.errors).toBe(0);
  expect(stats.battles).toBeGreaterThan(0);
}, 30_000);
