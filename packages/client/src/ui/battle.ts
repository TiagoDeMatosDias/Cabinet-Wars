import {
  BATTLE_CARDS, combatUnits, retreatPlan, typeBonus, TYPE_ADVANTAGE,
  type Army, type BattleRole, type CardPlacement, type GameView, type HistoryEntry, type Intent, type Unit, type UnitType,
} from '@krieg/engine';
import { add, h } from './dom';
import { cardBackEl, cardEl } from './cards';
import { emblemEl, type Emblem } from './emblem';
import { iconEl } from './icons';
import { cardName, nationColor, nationName, unitIcon, unitLabel, unitLabelEl, unitName } from './labels';
import { currentTheme } from '../theme/theme';
import { logText, t, tn } from '../i18n/i18n';
import type { UiKey } from '../i18n/en';

/** Choices the local player is making in the popup; kept across re-renders until the step changes. */
export interface BattleUi {
  key: string;
  /** Units picked (commit step, or panic losses). */
  picked: string[];
  /** Unit on each own die (plan step). */
  dieUnits: string[];
  /** Cards committed in the plan, with the die a roll card goes on. */
  cards: Map<string, { role?: BattleRole; die?: number }>;
  defAssign: number[];
  historyOpen: boolean;
}

/** Choices reset when the battle step changes or another player acts (hotseat shares one screen). */
export function battleKey(v: GameView, me: string | null): string {
  const b = v.battle;
  return b ? `${b.attackerArmy}:${b.defenderArmy}:${b.round}:${b.step}:${me}` : 'none';
}

export function freshBattleUi(key: string): BattleUi {
  return { key, picked: [], dieUnits: [], cards: new Map(), defAssign: [], historyOpen: false };
}

const STEPS = ['units', 'roll', 'plan', 'defenderAssign', 'reveal', 'result'] as const;
const STEP_INDEX: Record<string, number> = { units: 0, roll: 1, plan: 2, defenderAssign: 3, panic: 5, retreat: 5 };
const TYPE_BY_LETTER: Record<string, UnitType> = { c: 'cavalry', i: 'infantry', a: 'artillery', s: 'supply' };
const ROLL_CARDS = new Set(['roll+1', 'roll+2', 'roll-1']);

export interface BattleContext {
  view: GameView;
  me: string | null;
  emblems: Map<string, Emblem>;
  ui: BattleUi;
  /** History entries of this battle, oldest first. */
  history: HistoryEntry[];
  send(i: Intent): void;
  rerender(): void;
}

function unitToken(type: UnitType, color: string, cls = '', title = '') {
  return h('span', { class: `unit-token ${cls}`, style: `--c:${color}`, title: title || unitName(type) }, unitIcon(type, 18));
}

function battleIcon(size: number) {
  return iconEl(currentTheme().icons.battle, size);
}

const findUnit = (a: Army | undefined, id: string): Unit | undefined => a?.units.find((u) => u.id === id);
const typeOfId = (id: string): UnitType => TYPE_BY_LETTER[id.split('.').pop()!.charAt(0)] ?? 'infantry';

/** "Cavalry +1 vs artillery · …" */
function advantageLegend(): HTMLElement {
  return h('div', { class: 'advantage muted' }, (Object.entries(TYPE_ADVANTAGE) as [UnitType, UnitType][]).map(([u, beats], i) =>
    h('span', {}, i ? ' · ' : '', unitIcon(u, 14), ' ', t('battle.beats', { unit: unitName(u), other: unitName(beats) }))));
}

/** The battle popup (a modal), or null when there is no battle to show. */
export function battlePopup(ctx: BattleContext): HTMLElement | null {
  const { view: v, me, emblems, ui } = ctx;
  const b = v.battle;
  const prompt = v.pending.find((p) => p.nation === me);

  if (!b && prompt?.kind === 'chooseBattle') {
    return h('div', { class: 'modal-backdrop' }, h('div', { class: 'modal battle-modal small' },
      h('h2', {}, battleIcon(26), t('battle.severalTitle')),
      h('p', {}, t('battle.severalBody')),
      h('div', { class: 'choice-list' }, prompt.options.map((id) => {
        const a = v.armies[id];
        return h('button', { class: 'choice', onclick: () => ctx.send({ type: 'chooseBattle', defender: id }) },
          emblemEl(emblems.get(a?.nation ?? ''), 22), t('battle.armyOption', { nation: a?.nation ?? '', army: id, node: a?.node ?? '' }));
      }))));
  }
  if (!b) return null;
  const att = v.armies[b.attackerArmy];
  const def = v.armies[b.defenderArmy];
  const myRole: BattleRole | null = att?.nation === me ? 'attacker' : def?.nation === me ? 'defender' : null;
  const battleNode = def?.node ?? att?.node ?? '';

  // Retreats shrink the popup to a banner so the map can be clicked.
  if (b.step === 'retreat') return retreatBanner(ctx, att, def);

  const stepIdx = STEP_INDEX[b.step] ?? 0;
  const actors = [...new Set(v.pending.filter((p) => ['battleUnits', 'battlePlan', 'defenderAssign', 'panicTargets'].includes(p.kind)).map((p) => p.nation))];
  const whoPerStep = (i: number): string[] => {
    const an = att?.nation ?? '';
    const dn = def?.nation ?? '';
    if (i === 0 || i === 2) return i === stepIdx ? actors : [an, dn];
    if (i === 3) return [dn];
    return [];
  };

  const stepper = h('ol', { class: 'stepper' }, STEPS.map((step, i) => {
    const state = i < stepIdx ? 'done' : i === stepIdx ? 'active' : 'todo';
    const actColor = i === stepIdx && actors.length === 1 ? nationColor(v, actors[0]) : undefined;
    return h('li', { class: `step ${state}`, style: actColor ? `--act:${actColor}` : '' },
      h('span', { class: 'step-dot' }, state === 'done' ? '' : String(i + 1)),
      h('span', { class: 'step-name' }, t(`battle.step.${step}`)),
      h('span', { class: 'step-who' }, whoPerStep(i).filter(Boolean).map((n) => emblemEl(emblems.get(n), 18, nationName(v, n)))));
  }));

  const iAct = me !== null && actors.includes(me);
  /** What is happening, addressed to the player when they are the one acting. */
  const actorText = (): string => {
    const alone = iAct && actors.length === 1;
    const others = actors.filter((n) => n !== me).map((n) => nationName(v, n)).join(', ');
    const names = actors.map((n) => nationName(v, n)).join(', ');
    const both = (you: UiKey, youToo: UiKey, many: UiKey) => (alone ? t(you) : iAct ? t(youToo, { names: others }) : t(many, { names }));
    switch (b.step) {
      case 'units': return both('battle.act.unitsYou', 'battle.act.unitsYouToo', 'battle.act.units');
      case 'roll': return t('battle.act.roll');
      case 'plan': return both('battle.act.planYou', 'battle.act.planYouToo', 'battle.act.plan');
      case 'panic': {
        const pp = v.pending.find((x) => x.kind === 'panicTargets');
        const fleeing = b.retreats[0]?.role === 'attacker' ? att?.nation : def?.nation;
        if (!pp || pp.kind !== 'panicTargets') return t('battle.act.panicFlee', { nation: fleeing ?? '' });
        return alone ? t('battle.act.panicPickYou', { nation: fleeing ?? '', count: pp.count }) : t('battle.act.panicPick', { nation: pp.nation, panicNation: fleeing ?? '', count: pp.count });
      }
      case 'defenderAssign': return alone ? t('battle.act.defendYou') : t('battle.act.defend', { nation: actors[0] ?? '' });
      default: return '';
    }
  };
  const waiting = [att?.nation, def?.nation].filter((n): n is string => !!n && !actors.includes(n));
  const bannerColors = actors.map((n) => nationColor(v, n));
  const banner = h('div', {
    class: 'actor-banner',
    style: bannerColors.length > 1 ? `background:linear-gradient(90deg, ${bannerColors[0]} 50%, ${bannerColors[1]} 50%)` : `background:${bannerColors[0] ?? 'var(--k-color-text-primary)'}`,
  },
  h('span', { class: 'actor-emblems' }, actors.map((n) => emblemEl(emblems.get(n), 28))),
  h('span', { class: 'actor-text' }, actorText()),
  h('span', { class: 'actor-others' }, waiting.map((n) => t('battle.waiting', { nation: n })).join(' · ')));

  const lostLast = new Set(b.lastRound?.results.flatMap((r) => r.destroyed) ?? []);
  const side = (role: BattleRole, a: Army | undefined) => {
    if (!a) return h('section', { class: 'battle-side gone' }, t('battle.destroyed'));
    const color = nationColor(v, a.nation);
    const active = actors.includes(a.nation);
    const lost = [...lostLast].filter((id) => id.startsWith(`${a.id}.`));
    const dice = b.dice?.[role] ?? [];
    const committedUnits = b.units[role];
    const committedSet = new Set(committedUnits ?? []);
    const hiddenUnits = committedUnits?.some((id) => id === '?') ?? false;
    const plan = b.plan[role];
    const cards = b.committed[role];
    const mine = a.nation === me;
    const dieLabel = (i: number): (HTMLElement | string)[] => {
      const out: (HTMLElement | string)[] = [];
      const u = plan?.units[i];
      if (u) out.push(unitIcon(typeOfId(u), 12));
      if (role === 'defender' && b.defenderAssign) out.push(` → #${b.defenderAssign[i] + 1}`);
      return out;
    };
    return h('section', { class: `battle-side ${active ? 'active' : ''}`, style: `--c:${color}` },
      h('header', {},
        emblemEl(emblems.get(a.nation), 34),
        h('div', {}, h('strong', {}, nationName(v, a.nation)),
          h('div', { class: 'side-sub' }, t(role === 'attacker' ? 'battle.sideAttacker' : 'battle.sideDefender', { army: a.id, node: a.node })))),
      h('div', { class: 'side-label' }, t('battle.combatUnits')),
      h('div', { class: 'unit-row' },
        combatUnits(a).map((u) => unitToken(u.type, color, committedSet.has(u.id) ? 'committed' : '', unitLabel(u) + (committedSet.has(u.id) ? ` · ${t('battle.inRound')}` : ''))),
        lost.map((id) => unitToken(typeOfId(id), color, 'lost', t('battle.lostLast')))),
      h('div', { class: 'side-label' }, t('battle.unitsInRound')),
      h('div', { class: 'muted' }, committedUnits
        ? (hiddenUnits ? tn('battle.unitsHidden', committedUnits.length) : tn('battle.unitsCommitted', committedUnits.length))
        : t('battle.notYet')),
      h('div', { class: 'side-label' }, t('battle.dice')),
      h('div', { class: 'dice-row' }, dice.length
        ? dice.map((d, i) => h('span', { class: `die big ${d ? '' : 'secret'}`, style: `--ring:${color}`, title: d ? t('battle.dieN', { n: i + 1 }) : t('battle.dieHidden') },
          h('span', { class: 'die-value' }, d ? String(d) : '?'), h('span', { class: 'die-label' }, `#${i + 1} `, ...dieLabel(i))))
        : h('span', { class: 'muted' }, t('battle.rolledAfter'))),
      h('div', { class: 'side-label' }, t('battle.committed')),
      h('div', { class: 'card-row' },
        mine && cards
          ? cards.map((c) => cardEl(c, { color, playable: true, hint: '', small: true }))
          : Array.from({ length: cards?.length || v.counts.committed[role] || 0 }, () => cardBackEl(color, emblems.get(a.nation))),
        (cards?.length ?? v.counts.committed[role]) ? null : h('span', { class: 'muted' }, cards ? t('common.none') : t('battle.notYet'))),
    );
  };

  const actions = h('div', { class: 'battle-actions' });
  if (prompt && myRole) add(actions, actionArea(ctx, myRole, att, def));

  const historyKeys = new Set(['log.round', 'log.destroyed', 'log.retreats', 'log.retreatBlocked']);
  const historyLines = ctx.history.filter((e) => e.msg && historyKeys.has(e.msg.key));
  const hist = h('div', { class: 'round-history' },
    b.lastRound ? lastRoundEl(v, b.lastRound, att, def, b.round - 1) : null,
    historyLines.length ? h('button', { class: 'link', onclick: () => { ui.historyOpen = !ui.historyOpen; ctx.rerender(); } },
      ui.historyOpen ? t('battle.historyHide') : t('battle.historyShow', { count: historyLines.length })) : null,
    ui.historyOpen ? h('ul', {}, historyLines.map((e) => h('li', {}, logText(e)))) : null);

  return h('div', { class: 'modal-backdrop battle-backdrop' }, h('div', { class: 'modal battle-modal', role: 'dialog', 'aria-label': t('battle.title', { node: battleNode }) },
    h('header', { class: 'battle-title' },
      h('h2', {}, battleIcon(26), t('battle.title', { node: battleNode })),
      h('div', { class: 'muted' }, t('battle.subtitle', { round: b.round, nation: att?.nation ?? '', fromNode: att?.node ?? '', defNation: def?.nation ?? '', node: battleNode }))),
    stepper,
    banner,
    h('div', { class: 'battle-sides' }, side('attacker', att), h('div', { class: 'versus' }, t('battle.vs')), side('defender', def)),
    actions,
    hist));
}

/** The previous round, comparison by comparison: dice, units, bonuses, winner and losses. */
function lastRoundEl(v: GameView, lr: NonNullable<NonNullable<GameView['battle']>['lastRound']>, att: Army | undefined, def: Army | undefined, round: number): HTMLElement {
  const mod = (role: BattleRole, die: number) => lr.placements.attacker.concat(lr.placements.defender)
    .filter((p) => p.role === role && p.die === die).map((p) => cardName(p.type));
  const side = (role: BattleRole, die: number, points: number, bonus: number) => {
    const u = lr.plans[role].units[die];
    const cards = mod(role, die);
    return h('span', { class: 'cmp-side' }, u ? unitIcon(typeOfId(u), 14) : null, ` ${lr.dice[role][die]}`,
      bonus ? h('span', { class: 'bonus' }, ` +${bonus}`) : null,
      cards.length ? h('span', { class: 'muted' }, ` (${cards.join(', ')})`) : null, ` = ${points}`);
  };
  return h('div', { class: 'last-round' },
    h('strong', {}, t('battle.lastRound', { round })),
    h('ul', {}, lr.results.map((r) => {
      const opp = lr.defenderAssign.map((target, j) => ({ target, j })).filter((x) => x.target === r.die);
      const winnerNation = r.winner === 'attacker' ? att?.nation : def?.nation;
      return h('li', {},
        `#${r.die + 1}: `, side('attacker', r.die, r.attackerPoints, r.attackerBonus), ` ${t('battle.vs')} `,
        opp.length ? opp.map((o, k) => h('span', {}, k ? ' + ' : '', side('defender', o.j, lr.dice.defender[o.j], 0))) : t('battle.unopposed'),
        opp.length > 1 ? ` = ${r.defenderPoints}` : '', r.defenderBonus && opp.length ? h('span', { class: 'bonus' }, ` (+${r.defenderBonus})`) : null,
        ' → ', h('strong', {}, winnerNation ? nationName(v, winnerNation) : t(`battle.role.${r.winner}`)),
        r.destroyed.length ? ` · ${tn('battle.lostUnits', r.destroyed.length, { units: r.destroyed.map((id) => unitName(typeOfId(id))).join(', ') })}` : '');
    })));
}

function actionArea(ctx: BattleContext, role: BattleRole, att: Army, def: Army): HTMLElement | null {
  const { view: v, me, ui } = ctx;
  const b = v.battle!;
  const prompt = v.pending.find((p) => p.nation === me)!;
  const color = nationColor(v, me!);
  const own = role === 'attacker' ? att : def;
  const enemy = role === 'attacker' ? def : att;
  const box = h('div', { class: `action-box ${role}`, style: `--c:${color}` });
  const pickUnits = (units: Unit[], count: number) => h('div', { class: 'unit-row' }, units.map((u) => h('button', {
    class: `unit-pick ${ui.picked.includes(u.id) ? 'selected' : ''}`,
    'aria-pressed': String(ui.picked.includes(u.id)),
    onclick: () => {
      if (ui.picked.includes(u.id)) ui.picked = ui.picked.filter((x) => x !== u.id);
      else if (ui.picked.length < count) ui.picked = [...ui.picked, u.id];
      ctx.rerender();
    },
  }, unitLabelEl(u))));
  switch (prompt.kind) {
    case 'battleUnits': {
      const units = combatUnits(own);
      if (!ui.picked.length && units.length === prompt.count) ui.picked = units.map((u) => u.id);
      add(box,
        h('div', { class: 'action-title' }, tn('battle.unitsTitle', prompt.count)),
        pickUnits(units, prompt.count),
        advantageLegend(),
        h('div', { class: 'row end' },
          h('button', {
            class: 'danger', title: t('battle.panicTitle'),
            onclick: () => { if (confirm(t('battle.panicConfirm'))) ctx.send({ type: 'panic' }); },
          }, t('battle.panic')),
          h('button', {
            class: 'primary', disabled: ui.picked.length !== prompt.count,
            onclick: () => ctx.send({ type: 'battleUnits', units: ui.picked }),
          }, tn('battle.unitsConfirm', prompt.count))));
      return box;
    }
    case 'panicTargets': {
      // The enemy fled: pick which of its combat units are lost in the rout.
      const fleeing = v.armies[prompt.army];
      add(box,
        h('div', { class: 'action-title' }, t('battle.panicPickTitle', { count: prompt.count })),
        pickUnits(fleeing ? combatUnits(fleeing) : [], prompt.count),
        h('button', {
          class: 'primary', disabled: ui.picked.length !== prompt.count,
          onclick: () => ctx.send({ type: 'panicTargets', units: ui.picked }),
        }, t('battle.panicConfirmPick')));
      return box;
    }
    case 'battlePlan': {
      const dice = b.dice![role];
      const committed = b.units[role] ?? [];
      if (ui.dieUnits.length !== dice.length) ui.dieUnits = [...committed];
      const unitOptions = committed.map((id): [string, string] => {
        const u = findUnit(own, id);
        return [id, u ? unitLabel(u) : id];
      });
      const duplicate = new Set(ui.dieUnits).size !== ui.dieUnits.length;
      const hand = v.hands[me!].filter((c) => BATTLE_CARDS.includes(c.type));
      const dieOptions = (['attacker', 'defender'] as const).flatMap((r) => b.dice![r].map((d, i): [string, string] => [
        `${r}:${i}`, r === role ? t('battle.yourDie', { n: i + 1, value: d }) : t('battle.enemyDieHidden', { n: i + 1 }),
      ]));
      add(box,
        h('div', { class: 'action-title' }, t('battle.planTitle')),
        dice.map((d, i) => h('div', { class: 'assign-row' },
          h('span', { class: 'die', style: `--ring:${color}` }, String(d)),
          h('label', {}, `${t('battle.fightsWith')} `, select(unitOptions, ui.dieUnits[i], (val) => { ui.dieUnits[i] = val; ctx.rerender(); })))),
        duplicate ? h('div', { class: 'warn' }, t('battle.unitTwice')) : null,
        advantageLegend(),
        h('div', { class: 'action-title' }, t('battle.cardsTitle')),
        hand.length ? h('div', { class: 'card-row' }, hand.map((c) => cardEl(c, {
          color, playable: true, small: true, selected: ui.cards.has(c.id),
          hint: ui.cards.has(c.id) ? t('battle.committedHint') : t('battle.clickToCommit'),
          onclick: () => {
            if (ui.cards.has(c.id)) ui.cards.delete(c.id);
            else ui.cards.set(c.id, ROLL_CARDS.has(c.type) ? { role: c.type === 'roll-1' ? (role === 'attacker' ? 'defender' : 'attacker') : role, die: 0 } : {});
            ctx.rerender();
          },
        }))) : h('p', { class: 'muted' }, t('battle.noCards')),
        hand.filter((c) => ui.cards.has(c.id)).map((c) => {
          const p = ui.cards.get(c.id)!;
          return h('div', { class: 'assign-row' }, h('strong', {}, cardName(c.type)), ROLL_CARDS.has(c.type)
            ? h('label', {}, `${t('battle.cardOnDie')} `, select(dieOptions, `${p.role}:${p.die}`, (val) => {
              const [r, d] = val.split(':');
              ui.cards.set(c.id, { role: r as BattleRole, die: Number(d) });
            }))
            : h('span', { class: 'muted' }, t(c.type === 'retreat' ? 'battle.retreatCardNote' : 'battle.blockCardNote')));
        }),
        h('button', {
          class: 'primary', disabled: duplicate,
          onclick: () => ctx.send({
            type: 'battlePlan',
            units: ui.dieUnits,
            cards: [...ui.cards].map(([cardId, p]): CardPlacement => ({ cardId, ...p })),
          }),
        }, ui.cards.size ? tn('battle.planConfirm', ui.cards.size) : t('battle.planConfirmNone')));
      return box;
    }
    case 'defenderAssign': {
      const dice = b.dice!.defender;
      const attPlan = b.plan.attacker?.units ?? [];
      const defPlan = b.plan.defender?.units ?? [];
      const typeAt = (a: Army, id: string | undefined) => (id ? findUnit(a, id)?.type ?? typeOfId(id) : undefined);
      if (ui.defAssign.length !== dice.length) ui.defAssign = dice.map((_, j) => j % b.dice!.attacker.length);
      add(box,
        h('div', { class: 'action-title' }, t('battle.defendTitle')),
        dice.map((d, j) => {
          const mine = typeAt(own, defPlan[j]);
          const targets = b.dice!.attacker.map((ad, i): [string, string] => {
            const theirs = typeAt(enemy, attPlan[i]);
            const bonus = typeBonus(mine, [theirs]);
            const against = typeBonus(theirs, [mine]);
            return [String(i), t('battle.attackerDie', { n: i + 1, value: ad, unit: theirs ? unitName(theirs) : '' })
              + (bonus ? ` · ${t('battle.bonusYou')}` : '') + (against ? ` · ${t('battle.bonusThem')}` : '')];
          });
          return h('div', { class: 'assign-row' },
            h('span', { class: 'die', style: `--ring:${color}` }, String(d)),
            mine ? unitIcon(mine, 16) : null,
            h('label', {}, `${t('battle.opposes')} `, select(targets, String(ui.defAssign[j]), (val) => { ui.defAssign[j] = Number(val); })));
        }),
        advantageLegend(),
        h('button', { class: 'primary', onclick: () => ctx.send({ type: 'defenderAssign', assign: ui.defAssign }) }, t('battle.confirmDice')));
      return box;
    }
    default:
      return null;
  }
}

function select(options: [string, string][], value: string, onchange: (v: string) => void) {
  return h('select', { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) },
    options.map(([val, label]) => h('option', { value: val, selected: val === value }, label)));
}

function retreatBanner(ctx: BattleContext, att: Army | undefined, def: Army | undefined): HTMLElement {
  const { view: v, me, emblems } = ctx;
  const b = v.battle!;
  const prompt = v.pending.find((p) => p.nation === me);
  const r = b.retreats[0];
  const retreating = r ? (r.role === 'attacker' ? att : def) : undefined;
  const nat = retreating?.nation ?? '';
  const box = h('div', { class: 'retreat-banner', style: `--c:${nationColor(v, nat)}` },
    emblemEl(emblems.get(nat), 30),
    h('strong', {}, t('retreat.title', { nation: nat })));
  if (prompt?.kind === 'retreat') {
    // The rules choose where the army goes; the player may first play +1 Moves to save slow members.
    const a = v.armies[prompt.army];
    const plan = a ? retreatPlan(v, a) : null;
    const cards = v.hands[me!].filter((c) => c.type === 'moves+1');
    add(box,
      h('span', {}, plan
        ? t(plan.survivors < plan.total ? 'retreat.plan' : 'retreat.planAll', { node: plan.path[plan.path.length - 1], survivors: plan.survivors, total: plan.total })
        : t('retreat.noRoute')),
      cards.length ? h('button', { onclick: () => ctx.send({ type: 'playMoves', army: prompt.army, card: cards[0].id }) }, t('retreat.playMoves', { count: cards.length })) : null,
      h('button', { class: 'primary', onclick: () => ctx.send({ type: 'retreat' }) }, t('retreat.go')));
  } else {
    add(box, h('span', { class: 'waiting' }, t('retreat.waiting', { names: v.pending.map((p) => nationName(v, p.nation)).join(', ') })));
  }
  return box;
}

/**
 * Shown after a battle until the player continues. During End Turn it offers a choice: carry on
 * to the end of the turn, or stop to give new orders or go step by step.
 */
export function battleRecap(v: GameView, entries: HistoryEntry[], emblems: Map<string, Emblem>, opts: {
  running: boolean; remaining: number; onContinue(): void; onStop(): void;
}): HTMLElement {
  const nats = [...new Set(entries.map((e) => e.nation).filter(Boolean) as string[])];
  return h('div', { class: 'modal-backdrop battle-backdrop' }, h('div', { class: 'modal battle-modal small' },
    h('h2', {}, battleIcon(26), t('recap.title')),
    h('div', { class: 'row' }, nats.map((n) => h('span', { class: 'chip' }, emblemEl(emblems.get(n), 20), nationName(v, n)))),
    h('ul', { class: 'recap' }, entries.map((e) => h('li', {}, logText(e)))),
    h('p', { class: 'muted' }, t('recap.note')),
    opts.running
      ? h('div', { class: 'row end' },
        h('button', { onclick: opts.onStop, title: t('recap.stopTitle') }, t('recap.stop')),
        h('button', { class: 'primary', onclick: opts.onContinue }, opts.remaining ? tn('recap.continueRun', opts.remaining) : t('recap.continueEnd')))
      : h('button', { class: 'primary', onclick: opts.onContinue }, t('common.continue'))));
}
