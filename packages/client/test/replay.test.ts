import { describe, expect, it } from 'vitest';
import {
  advanceCopy, aiIntent, apply, filterForSeats, initialState, newAiMemory, parseConfig, replay,
  type AiMemory, type GameState, type LogEntry,
} from '@cabinet-wars/engine';
import { ReplaySession } from '../src/net/replay';
import { testConfig } from '../../engine/test/helpers';

/** A few turns of a computer-only game on the test map, with its log. */
function playedGame(maxSteps = 400) {
  const cfg = parseConfig(testConfig({ armies: [
    { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 2, infantry: 4, artillery: 1, supply: 2 } },
    { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 1, infantry: 4, artillery: 1, supply: 1 } },
  ] }));
  let seed = 5;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const perm = (n: number) => { const a = [...Array(n).keys()]; for (let i = n - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  let s: GameState = advanceCopy(initialState(cfg));
  const log: LogEntry[] = [];
  const push = (e: LogEntry) => { s = apply(s, e); log.push(e); };
  const oracle = () => { while (s.oracle) { const o = s.oracle; push(o.kind === 'shuffle'
    ? { seq: log.length, by: 'host', intent: { type: 'shuffle', deck: o.deck, order: perm(o.n) } }
    : o.kind === 'select'
      ? { seq: log.length, by: 'host', intent: { type: 'select', attacker: perm(o.attacker).slice(0, o.attackerPick), defender: perm(o.defender).slice(0, o.defenderPick), targets: Array.from({ length: o.attackerPick }, () => rnd(o.defenderPick)) } }
      : { seq: log.length, by: 'host', intent: { type: 'roll', attacker: Array.from({ length: o.attacker }, () => rnd(6) + 1), defender: Array.from({ length: o.defender }, () => rnd(6) + 1) } }); } };
  oracle();
  const mem = new Map<string, AiMemory>();
  for (let i = 0; i < maxSteps && s.phase !== 'gameOver'; i++) {
    const nat = s.pending[0].nation;
    if (!mem.has(nat)) mem.set(nat, newAiMemory());
    try { push({ seq: log.length, by: nat, intent: aiIntent(filterForSeats(s, [nat]), nat, mem.get(nat)!) }); } catch { push({ seq: log.length, by: nat, intent: { type: 'endTurn' } }); }
    oracle();
  }
  return { cfg, log, final: s };
}

describe('replay', () => {
  const { cfg, log, final } = playedGame();
  const map = { id: 'test', name: 'Test', config: {}, files: {}, source: 'browser' as const };
  const session = () => new ReplaySession(map, cfg, log);

  it('seeks to any position, forwards and backwards, matching a fresh replay', () => {
    const r = session();
    for (const k of [log.length, 3, Math.floor(log.length / 2), 0, 57, 56, log.length - 1]) {
      r.seek(k);
      const expected = filterForSeats(replay(initialState(cfg), log.slice(0, k)), cfg.nations.map((n) => n.id));
      expect(r.view()).toEqual(expected);
    }
    r.seek(log.length);
    expect(r.view()!.turn).toBe(final.turn);
  });

  it('steps stop before each player action, turns at the start of each turn', () => {
    const r = session();
    r.stepBy(1);
    const first = r.position();
    expect(log[first]?.by ?? 'end').not.toBe('host');
    for (let i = 0; i < 5; i++) r.stepBy(1);
    r.stepBy(-1);
    expect(r.steps).toContain(r.position());
    r.seek(0);
    r.turnBy(1);
    expect(r.marks[r.position()].turn).toBe(2);
    r.turnBy(1);
    expect(r.marks[r.position()].turn).toBe(3);
    r.turnBy(-1);
    expect(r.marks[r.position()].turn).toBe(2);
  });

  it('shows one nation’s view with its fog of war', () => {
    const r = session();
    r.seek(log.length);
    r.setPerspective('red');
    expect(r.view()!.hands.blue).toEqual([]);
    r.setPerspective(null);
    expect(r.view()!.hands.blue).toEqual(final.hands.blue);
  });

  it('cannot change the game', async () => {
    await expect(session().send()).rejects.toThrow();
  });
});
