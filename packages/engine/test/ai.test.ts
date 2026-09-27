import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import {
  advanceCopy, aiFallback, enemyArmiesAdjacent, aiIntent, aiRole, apply, filterForSeats, initialState, newAiMemory, parseConfig, randomOracle,
  type AiMemory, type GameState, type LogEntry, type MapConfig,
} from '../src';
import { TestGame, testConfig } from './helpers';

let seed = 1;
const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };

/** Plays a whole game with every nation run by the AI, like the host does. */
function aiGame(cfg: MapConfig, maxSteps = 20_000) {
  let s: GameState = advanceCopy(initialState(cfg));
  const log: LogEntry[] = [];
  const push = (e: LogEntry) => { s = apply(s, e); log.push(e); };
  const oracle = () => { while (s.oracle) push({ seq: log.length, by: 'host', intent: randomOracle(s.oracle, rnd) }); };
  oracle();
  const memory = new Map<string, AiMemory>();
  const stats = { steps: 0, refused: 0, battles: 0, moves: 0, captures: 0 };
  while (s.phase !== 'gameOver' && stats.steps < maxSteps) {
    const nat = s.pending[0].nation;
    if (!memory.has(nat)) memory.set(nat, newAiMemory());
    const view = filterForSeats(s, [nat]);
    const intent = aiIntent(view, nat, memory.get(nat)!);
    try {
      push({ seq: log.length, by: nat, intent });
    } catch {
      // Hidden armies can make a move fail; the AI already moved on from that army.
      stats.refused++;
      if (s.pending[0]?.kind !== 'movement') push({ seq: log.length, by: nat, intent: aiFallback(view, nat) });
    }
    if (intent.type === 'move') stats.moves++;
    if (s.battle && s.battle.round === 1 && s.battle.step === 'choose') stats.battles++;
    oracle();
    stats.steps++;
  }
  stats.captures = s.history.filter((h) => h.msg?.key === 'log.takesControl').length;
  return { state: s, stats };
}

it('assigns roles by side', () => {
  const s = initialState(parseConfig(testConfig()));
  expect(aiRole(s, 'red')).toBe('offensive');
  expect(aiRole(s, 'blue')).toBe('defensive');
  expect(aiRole({ ...s, rules: { ...s.rules, mode: 'freeForAll' } }, 'blue')).toBe('offensive');
});

it('the attacker drops its supply and marches on enemy victory points', () => {
  const g = new TestGame(testConfig({ armies: [
    { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 4, artillery: 1, supply: 1 } },
    { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 1, infantry: 3, artillery: 0, supply: 0 } },
  ] }));
  const mem = newAiMemory();
  const first = aiIntent(filterForSeats(g.state, ['red']), 'red', mem);
  // It leaves its slow supply unit behind before marching.
  expect(first).toMatchObject({ type: 'split', army: 'R' });
  g.act('red', first);
  const second = aiIntent(filterForSeats(g.state, ['red']), 'red', mem);
  expect(second).toMatchObject({ type: 'move', army: 'R' });
  const path = (second as { path: string[] }).path;
  expect(path[path.length - 1]).not.toBe('a1');
});

it('AI-only games on the test map finish without stalling', () => {
  const cfg = parseConfig(testConfig({ armies: [
    { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 4, artillery: 1, supply: 2 } },
    { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 1, infantry: 4, artillery: 1, supply: 1 } },
  ] }));
  for (let g = 0; g < 20; g++) {
    seed = g + 1;
    const { state, stats } = aiGame(g % 2 ? { ...cfg, rules: { ...cfg.rules, mode: 'freeForAll' } } : cfg);
    expect(state.phase).toBe('gameOver');
    expect(stats.moves).toBeGreaterThan(0);
  }
}, 60_000);

it('AI-only games on the China map finish and see fighting', () => {
  const cfg = parseConfig(JSON.parse(readFileSync(new URL('../../../Map/China/config.json', import.meta.url), 'utf8')));
  const winners: Record<string, number> = {};
  let battles = 0;
  let captures = 0;
  for (let g = 0; g < 4; g++) {
    seed = 100 + g;
    const { state, stats } = aiGame(cfg);
    expect(state.phase).toBe('gameOver');
    winners[state.winner ?? 'none'] = (winners[state.winner ?? 'none'] ?? 0) + 1;
    battles += stats.battles;
    captures += stats.captures;
    // eslint-disable-next-line no-console
    console.log(`game ${g}: winner ${state.winner} round ${state.round}`, stats,
      state.nations.map((n) => `${n.id}${n.knockedOut ? '✗' : ''}`).join(' '));
  }
  expect(battles).toBeGreaterThan(0);
  expect(captures).toBeGreaterThan(0);
}, 240_000);

it('the Iberia map starts without enemy armies side by side (no battles before the first move)', () => {
  const cfg = parseConfig(JSON.parse(readFileSync(new URL('../../../Map/Iberia/config.json', import.meta.url), 'utf8')));
  const s = initialState(cfg);
  expect(Object.values(s.armies).flatMap((a) => enemyArmiesAdjacent(s, a).map((e) => `${a.id}–${e.id}`))).toEqual([]);
  expect(advanceCopy(s).oracle?.kind).not.toBe('engage');
});

it('AI-only games on the Iberia map finish and see fighting', () => {
  const cfg = parseConfig(JSON.parse(readFileSync(new URL('../../../Map/Iberia/config.json', import.meta.url), 'utf8')));
  let battles = 0;
  let captures = 0;
  for (let g = 0; g < 6; g++) {
    seed = 1801 + g;
    const { state, stats } = aiGame(cfg);
    expect(state.phase).toBe('gameOver');
    battles += stats.battles;
    captures += stats.captures;
    // eslint-disable-next-line no-console
    console.log(`game ${g}: winner ${state.winner} round ${state.round}`, stats,
      state.nations.map((n) => `${n.id}${n.knockedOut ? '✗' : ''}`).join(' '));
  }
  expect(battles).toBeGreaterThan(0);
  expect(captures).toBeGreaterThan(0);
}, 240_000);
