import {
  dependentsOf, isPlaceholder, orderCreates, orderRefs, projectOrders,
  type ArmyRef, type GameState, type GameView, type Order, type OrderIntent, type OrderProjection,
} from '@krieg/engine';
import { t, tn } from '../i18n/i18n';

/** An order as the list shows it: planned, executed this turn, or dropped because it became impossible. */
export interface ListedOrder {
  order: Order;
  status: 'planned' | 'done' | 'removed';
  text: string;
  detail: string;
  reason?: string;
}

export interface Projection {
  state: GameState;
  results: OrderProjection[];
  /** Placeholder → id of the army in the projected state. */
  ids: Map<ArmyRef, string>;
}

interface Saved {
  orders: Order[];
  done: ListedOrder[];
  ids: [ArmyRef, string][];
  seq: number;
}

/**
 * A player's orders for the current turn (docs/game-screen.md §6). Planned orders are private to
 * this browser until they are executed; the plan survives reloads through localStorage.
 */
export class Plan {
  orders: Order[] = [];
  /** Executed or removed orders, shown greyed out for the rest of the turn. */
  history: ListedOrder[] = [];
  /** Placeholders of executed orders → real army ids. */
  ids = new Map<ArmyRef, string>();
  private seq = 1;

  constructor(readonly key: string) {
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const s = JSON.parse(raw) as Saved;
        this.orders = s.orders;
        this.history = s.done;
        this.ids = new Map(s.ids);
        this.seq = s.seq;
      }
    } catch { /* storage unavailable or corrupt: start empty */ }
  }

  save() {
    try {
      const s: Saved = { orders: this.orders, done: this.history, ids: [...this.ids], seq: this.seq };
      localStorage.setItem(this.key, JSON.stringify(s));
    } catch { /* storage unavailable */ }
  }

  clearStorage() {
    try { localStorage.removeItem(this.key); } catch { /* storage unavailable */ }
  }

  newId(): string {
    return `o${this.seq++}`;
  }

  newPlaceholder(): ArmyRef {
    return `@${this.seq++}`;
  }

  project(view: GameView, nation: string, orders = this.orders): Projection {
    return projectOrders(view, nation, orders, this.ids);
  }

  /** The ref an order should use for an army of the projected state (a placeholder if it's planned). */
  refFor(projectedId: string, projection: Projection): ArmyRef {
    for (const [ph, id] of projection.ids) if (id === projectedId && !this.ids.has(ph)) return ph;
    return projectedId;
  }

  /** Adds an order if it is valid after all planned orders; throws with the reason otherwise. */
  add(view: GameView, nation: string, intent: OrderIntent): Order {
    const order: Order = { id: this.newId(), intent };
    const p = this.project(view, nation, [...this.orders, order]);
    const r = p.results[p.results.length - 1];
    if (!r.ok) throw Object.assign(new Error(r.error ?? t('orders.notPossible')), { template: r.errorTemplate, params: r.errorParams });
    this.orders.push(order);
    this.save();
    return order;
  }

  /** Removes an order and everything that depends on it. Returns the removed ids. */
  remove(id: string): string[] {
    const ids = [id, ...dependentsOf(this.orders, id)];
    this.orders = this.orders.filter((o) => !ids.includes(o.id));
    this.save();
    return ids;
  }

  /** Clears an order that was dropped (never executed) from the list. */
  dismiss(id: string) {
    this.history = this.history.filter((l) => !(l.order.id === id && l.status === 'removed'));
    this.save();
  }

  /** Orders that would also be removed with `id`. */
  dependents(id: string): Order[] {
    const deps = dependentsOf(this.orders, id);
    return this.orders.filter((o) => deps.has(o.id));
  }

  /** Moves an order to a new index if dependencies and every projection still hold. */
  canMove(view: GameView, nation: string, from: number, to: number): string | null {
    const next = [...this.orders];
    const [o] = next.splice(from, 1);
    next.splice(to, 0, o);
    for (let i = 0; i < next.length; i++) {
      const created = new Set(next.slice(0, i).flatMap((x) => orderCreates(x.intent)));
      const needs = orderRefs(next[i].intent).filter((r) => isPlaceholder(r) && !this.ids.has(r));
      if (needs.some((r) => !created.has(r))) return t('orders.errOrder');
    }
    const before = this.project(view, nation).results.map((r) => r.ok);
    const after = this.project(view, nation, next);
    const broken = next.findIndex((ord, i) => !after.results[i].ok && before[this.orders.indexOf(ord)]);
    if (broken >= 0) return t('orders.errBreaks', { order: describe(next[broken], view, after).text, reason: after.results[broken].error ?? '' });
    return null;
  }

  move(from: number, to: number) {
    const [o] = this.orders.splice(from, 1);
    this.orders.splice(to, 0, o);
    this.save();
  }
}

// ---- descriptions -----------------------------------------------------------

export function armyLabel(ref: ArmyRef, ids: Map<ArmyRef, string>): string {
  if (!isPlaceholder(ref)) return ref;
  const real = ids.get(ref);
  return real ? t('desc.newSuffix', { army: real }) : t('desc.newArmyUnnamed');
}

/** One-line text and a detail line for an order, using a projection for positions. */
export function describe(order: Order, view: GameView, projection: Projection, index?: number): { text: string; detail: string } {
  const o = order.intent;
  const ids = projection.ids;
  const r = index !== undefined ? projection.results[index] : undefined;
  switch (o.type) {
    case 'move': {
      const from = r?.path?.[0];
      const to = o.path[o.path.length - 1];
      const army = armyLabel(o.army, ids);
      // An army without combat units that runs into the enemy is destroyed at once.
      const moved = projection.state.armies[ids.get(o.army) ?? o.army];
      const helpless = moved && !moved.units.some((u) => u.type !== 'supply');
      return {
        text: from ? t('desc.move', { army, fromNode: from, toNode: to }) : t('desc.moveTo', { army, toNode: to }),
        detail: `${tn('desc.moves', o.path.length)}${r?.meetsEnemy ? ` · ${t(helpless ? 'desc.meetsEnemyNoCombat' : 'desc.meetsEnemy')}` : ''}`,
      };
    }
    case 'split':
      return { text: tn('desc.split', o.units.length + o.generals.length, { army: armyLabel(o.army, ids) }), detail: t('desc.newArmy', { army: armyLabel(o.creates, ids) }) };
    case 'merge':
      return { text: t('desc.merge', { others: o.from.map((f) => armyLabel(f, ids)).join(', '), army: armyLabel(o.into, ids) }), detail: '' };
    case 'transfer':
      return { text: t('desc.transfer', { count: o.groups.length }), detail: o.groups.map((g) => `${g.army ? armyLabel(g.army, ids) : t('desc.newArmyUnnamed')}: ${g.units.length}`).join(' · ') };
    case 'playMoves':
      return { text: t('desc.playMoves', { army: armyLabel(o.army, ids) }), detail: t('desc.card') };
  }
}
