import { afterEach, expect, it, vi } from 'vitest';
import { parseConfig, RULES_VERSION } from '@cabinet-wars/engine';
import { testConfig } from '../../engine/test/helpers';
import { AI, HOST, Table } from '../src';

const cfg = () => {
  const c = testConfig();
  return parseConfig({ ...c, rules: { ...(c.rules ?? {}), version: RULES_VERSION } });
};
const tables: Table[] = [];
const table = (opts: Partial<ConstructorParameters<typeof Table>[1]> = {}) => {
  const t = new Table(cfg(), { hostName: 'Hana', ...opts });
  tables.push(t);
  return t;
};
afterEach(() => { for (const t of tables.splice(0)) t.dispose(); vi.useRealTimers(); });

it('players join, take nations, and come back with their token', () => {
  const t = table();
  const bob = t.join(null, 'Bob');
  if ('refused' in bob) throw new Error('refused');
  t.setOnline(bob.player, true, true);
  t.claim(bob.player, 'red');
  expect(t.seatsOf(bob.player)).toEqual(['red']);
  // Someone else cannot take it; the host can't either (only open or computer seats).
  const cy = t.join(null, 'Cy');
  if ('refused' in cy) throw new Error('refused');
  t.claim(cy.player, 'red');
  expect(t.seatsOf(bob.player)).toEqual(['red']);
  // Same token: the same player, still holding red.
  const again = t.join(bob.token, 'Bob');
  expect(again).toEqual({ player: bob.player, token: bob.token });
  expect(t.chat().map((m) => m.key)).toContain('chat.joined');
});

it('names are made unique', () => {
  const t = table();
  const a = t.join(null, 'Hana');
  expect('refused' in a ? '' : t.playerName(a.player)).toBe('Hana (2)');
});

it('the host kicks a player: their nations open up and they cannot return', () => {
  const t = table();
  const dismissed: string[] = [];
  t.onDismiss = (id) => dismissed.push(id);
  const bob = t.join(null, 'Bob');
  if ('refused' in bob) throw new Error('refused');
  t.claim(bob.player, 'blue');
  expect(() => t.kick(bob.player, HOST)).toThrow();
  t.kick(HOST, bob.player);
  expect(dismissed).toEqual([bob.player]);
  expect(t.lobbyFor(HOST).seats.find((s) => s.nation === 'blue')?.holder).toBeNull();
  expect(t.join(bob.token, 'Bob')).toEqual({ refused: 'kicked' });
});

it('colors: own nations only, from the palette, never shared', () => {
  const t = table();
  const bob = t.join(null, 'Bob');
  if ('refused' in bob) throw new Error('refused');
  t.claim(bob.player, 'red');
  expect(() => t.setColor(bob.player, 'blue', '#0072b2')).toThrow();
  expect(() => t.setColor(bob.player, 'red', '#123456')).toThrow();
  t.setColor(bob.player, 'red', '#0072b2');
  expect(t.gameState().nations.find((n) => n.id === 'red')?.color).toBe('#0072b2');
  expect(() => t.setColor(HOST, 'blue', '#0072b2')).toThrow();
  t.setColor(HOST, 'red', null);
  expect(t.gameState().nations.find((n) => n.id === 'red')?.color).toBe('#f00');
});

it('spectators may be refused once the game has started', () => {
  const t = table({ settings: { allowSpectators: false } });
  t.setAi(HOST, 'blue');
  t.start(HOST);
  expect(t.join(null, 'Late')).toEqual({ refused: 'noSpectators' });
});

it('a player idle past the time limit is moved on', () => {
  vi.useFakeTimers();
  const t = table({ settings: { afkMinutes: 2 } });
  const bob = t.join(null, 'Bob');
  if ('refused' in bob) throw new Error('refused');
  t.claim(bob.player, 'red');
  t.setAi(HOST, 'blue');
  t.start(HOST);
  expect(t.gameState().current).toBe('red');
  expect(Object.keys(t.deadlines())).toEqual(['red']);
  const turn = t.gameState().turn;
  // Red's clock runs out (possibly more than once: an event may ask it something first).
  vi.advanceTimersByTime(5 * 60_000);
  expect(t.chat().some((m) => m.key === 'chat.afk')).toBe(true);
  expect(t.gameState().turn).toBeGreaterThan(turn);
});

it('local tables keep no clock and write no notices', () => {
  const t = table({ local: true, aiSeats: ['blue'] });
  expect(t.seatsOf(HOST)).toEqual(['red']);
  expect(t.seatsOf(AI)).toEqual(['blue']);
  t.start(HOST);
  expect(t.deadlines()).toEqual({});
  expect(t.chat()).toEqual([]);
});

it('a table restored from its snapshot is the same game', () => {
  const t = table({ aiSeats: ['blue'] });
  t.claim(HOST, 'red');
  t.start(HOST);
  const copy = new Table(cfg(), { hostName: '', snapshot: JSON.parse(JSON.stringify(t.snapshot())) });
  tables.push(copy);
  expect(copy.gameState()).toEqual(t.gameState());
  expect(copy.started()).toBe(true);
});
