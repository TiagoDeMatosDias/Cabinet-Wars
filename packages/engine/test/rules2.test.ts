import { expect, it } from 'vitest';
import {
  DEFAULT_EVENT_DECK, DEFAULT_GENERAL_DECK, HAND_LIMIT, initialState, parseConfig, RULES_VERSION, scaleDeck, type MapConfigInput,
} from '../src';
import { TestGame, testConfig } from './helpers';

const v2 = (overrides: Partial<MapConfigInput> = {}): MapConfigInput => {
  const cfg = testConfig(overrides);
  return { ...cfg, rules: { ...(cfg.rules ?? {}), version: RULES_VERSION } };
};
const total = (spec: { count: number }[]) => spec.reduce((n, c) => n + c.count, 0);

it('decks grow with the number of nations, the End Game card stays single', () => {
  expect(total(scaleDeck(DEFAULT_GENERAL_DECK, 5))).toBe(total(DEFAULT_GENERAL_DECK));
  expect(total(scaleDeck(DEFAULT_GENERAL_DECK, 2))).toBe(24);
  expect(scaleDeck(DEFAULT_EVENT_DECK, 2).find((c) => c.card === 'endGame')!.count).toBe(1);
  expect(scaleDeck(DEFAULT_EVENT_DECK, 6).find((c) => c.card === 'endGame')!.count).toBe(1);
  // Every card of the classic deck is still in a small game.
  expect(scaleDeck(DEFAULT_EVENT_DECK, 2).every((c) => c.count >= 1)).toBe(true);
  const s = initialState(parseConfig(v2()));
  expect(s.generalDeck.discard.length).toBe(24);
  expect(s.eventDeck.discard.length).toBe(total(scaleDeck(DEFAULT_EVENT_DECK, 2)));
  // The original rules keep the classic decks.
  expect(initialState(parseConfig(testConfig())).generalDeck.discard.length).toBe(total(DEFAULT_GENERAL_DECK));
});

it('a nation with a full hand draws no General card', () => {
  const g = new TestGame(v2());
  const hand = g.state.hands.red.length;
  g.act('red', { type: 'endTurn' });
  g.act('blue', { type: 'endTurn' });
  expect(g.state.hands.red.length).toBe(hand + 1);
  // Fill red's hand to the limit through the state (as if it had kept every card).
  const s = structuredClone(g.state);
  while (s.hands.red.length < HAND_LIMIT) s.hands.red.push({ id: `extra${s.hands.red.length}`, type: 'roll+1' });
  g.state = s;
  const top = g.state.generalDeck.draw[0];
  g.act('red', { type: 'endTurn' });
  g.act('blue', { type: 'endTurn' });
  expect(g.state.hands.red.length).toBe(HAND_LIMIT);
  // The card red did not draw went to the next player instead.
  expect(g.state.hands.blue).toContainEqual(top);
  expect(g.state.history.some((h) => h.msg?.key === 'log.handFull')).toBe(true);
});

const standing = {
  armies: [
    { id: 'R', nation: 'red', node: 'a3', generals: ['gr'], units: { cavalry: 1, infantry: 2, artillery: 0, supply: 0 } },
    { id: 'B', nation: 'blue', node: 'n1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
  ],
};

it('armies standing next to each other fight, with the attacker picked at random', () => {
  const g = new TestGame(v2(standing));
  // The test host picks the first army of the pair (by id: B) to attack.
  expect(g.state.battle).not.toBeNull();
  expect(g.state.battle!.attackerArmy).toBe('B');
  expect(g.state.battle!.defenderArmy).toBe('R');
  expect(g.state.history.some((h) => h.msg?.key === 'log.standoff')).toBe(true);
  expect(g.log.some((e) => e.by === 'host' && e.intent.type === 'engage')).toBe(true);
});

it('under the original rules, standing armies do not fight', () => {
  const g = new TestGame(testConfig(standing));
  expect(g.state.battle).toBeNull();
  expect(g.prompt('red')?.kind).toBe('movement');
});

it('a unit mustered next to an enemy army fights it at once', () => {
  const g = new TestGame(v2({
    nodes: testConfig().nodes!.map((n) => (n.id === 'a3' ? { ...n, vp: 8 } : n)),
    armies: [
      { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 1, infantry: 2, artillery: 0, supply: 0 } },
      { id: 'B', nation: 'blue', node: 'n1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
    ],
  }));
  expect(g.state.battle).toBeNull();
  g.act('red', { type: 'muster', node: 'a3', unit: 'infantry' });
  expect(g.state.battle).not.toBeNull();
  expect(g.state.history.some((h) => h.msg?.key === 'log.standoff')).toBe(true);
});
