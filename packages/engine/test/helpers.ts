import {
  advanceCopy, apply, initialState, parseConfig, type GameState, type Intent, type LogEntry, type MapConfigInput,
} from '../src';

/**
 * Line map:  a1 = a2 = a3 - n1 - d3 = d2 = d1     (= major, - minor)
 *                            |
 *                            x1 - x2 - x3
 */
export function testConfig(overrides: Partial<MapConfigInput> = {}): MapConfigInput {
  const node = (id: string, owner: string, vp = 0, i = 0) => ({ id, name: id, color: `#0000${i.toString(16).padStart(2, '0')}`, x: i * 10, y: 0, owner, vp });
  return {
    name: 'Test',
    nations: [
      { id: 'red', name: 'Red', color: '#f00', side: 'attacker', threshold: 50 },
      { id: 'blue', name: 'Blue', color: '#00f', side: 'defender', threshold: 50 },
    ],
    nodes: [
      node('a1', 'red', 2, 1), node('a2', 'red', 0, 2), node('a3', 'red', 0, 3), node('n1', 'blue', 0, 4),
      node('d3', 'blue', 0, 5), node('d2', 'blue', 0, 6), node('d1', 'blue', 4, 7),
      node('x1', 'blue', 0, 8), node('x2', 'blue', 0, 9), node('x3', 'blue', 0, 10),
    ],
    edges: [
      { a: 'a1', b: 'a2', type: 'major' }, { a: 'a2', b: 'a3', type: 'major' }, { a: 'a3', b: 'n1', type: 'minor' },
      { a: 'n1', b: 'd3', type: 'minor' }, { a: 'd3', b: 'd2', type: 'major' }, { a: 'd2', b: 'd1', type: 'major' },
      { a: 'n1', b: 'x1', type: 'minor' }, { a: 'x1', b: 'x2', type: 'minor' }, { a: 'x2', b: 'x3', type: 'minor' },
    ],
    generals: [{ id: 'gr', name: 'Red General', nation: 'red' }, { id: 'gb', name: 'Blue General', nation: 'blue' }],
    armies: [
      { id: 'R', nation: 'red', node: 'a1', generals: ['gr'], units: { cavalry: 1, infantry: 2, artillery: 0, supply: 1 } },
      { id: 'B', nation: 'blue', node: 'd1', generals: ['gb'], units: { cavalry: 0, infantry: 3, artillery: 0, supply: 0 } },
    ],
    ...overrides,
  };
}

/**
 * A tiny host: records the log and answers oracle requests with scripted dice and unit picks, and
 * reversed shuffles (so the End Game event, built first, is drawn last).
 */
export class TestGame {
  state: GameState;
  log: LogEntry[] = [];
  dice: number[] = [];
  /** Scripted unit picks for the next battle rounds; by default the first units, each attacker facing defender i mod n. */
  picks: { attacker: number[]; defender: number[]; targets: number[] }[] = [];
  initial: GameState;

  constructor(cfg: MapConfigInput = testConfig()) {
    this.initial = initialState(parseConfig(cfg));
    this.state = advanceCopy(this.initial);
    this.settle();
  }

  private push(entry: LogEntry) {
    this.state = apply(this.state, entry);
    this.log.push(entry);
  }

  settle() {
    while (this.state.oracle) {
      const o = this.state.oracle;
      const seq = this.log.length;
      if (o.kind === 'shuffle') this.push({ seq, by: 'host', intent: { type: 'shuffle', deck: o.deck, order: [...Array(o.n).keys()].reverse() } });
      else if (o.kind === 'select') {
        const pick = this.picks.shift() ?? {
          attacker: [...Array(o.attackerPick).keys()],
          defender: [...Array(o.defenderPick).keys()],
          targets: [...Array(o.attackerPick).keys()].map((i) => i % o.defenderPick),
        };
        this.push({ seq, by: 'host', intent: { type: 'select', ...pick } });
      } else {
        const take = (n: number) => { const d = this.dice.splice(0, n); while (d.length < n) d.push(3); return d; };
        this.push({ seq, by: 'host', intent: { type: 'roll', attacker: take(o.attacker), defender: take(o.defender) } });
      }
    }
  }

  act(by: string, intent: Intent) {
    this.push({ seq: this.log.length, by, intent });
    this.settle();
    return this.state;
  }

  prompt(nation: string) {
    return this.state.pending.find((p) => p.nation === nation);
  }
}
