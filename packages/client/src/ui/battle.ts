import {
  other, ROLL_CARDS, scoreDuels, TYPE_ADVANTAGE, retreatPlan, typeBonus,
  type Army, type Battle, type BattleChoice, type BattleReport, type BattleRole, type BattleRound, type GameView, type HistoryEntry, type Intent,
  type PlacedCard, type UnitType,
} from '@cabinet-wars/engine';
import { add, h } from './dom';
import { cardEl } from './cards';
import { emblemEl, type Emblem } from './emblem';
import { iconEl } from './icons';
import { cardName, nationColor, nationName, unitIcon, unitName } from './labels';
import { currentTheme } from '../theme/theme';
import { logText, t, tn } from '../i18n/i18n';

/** Choices the local player is making in the battle panel; kept across re-renders until the step changes. */
export interface BattleUi {
  key: string;
  /** Roll card picked in the hand, waiting for a die to go on. */
  card: string | null;
  /** Roll cards put on dice so far (not yet sent). */
  placed: Map<string, { role: BattleRole; die: number }>;
  historyOpen: boolean;
}

/** Choices reset when the battle step changes or another player acts (hotseat shares one screen). */
export function battleKey(v: GameView, me: string | null): string {
  const b = v.battle;
  return b ? `${b.attackerArmy}:${b.defenderArmy}:${b.round}:${b.step}:${me}` : 'none';
}

export function freshBattleUi(key: string): BattleUi {
  return { key, card: null, placed: new Map(), historyOpen: false };
}

const ROLES: BattleRole[] = ['attacker', 'defender'];
/** The panel's three steps: the drawn units, the retreat decision, the dice. */
const PHASES = ['units', 'choose', 'dice'] as const;
const TYPE_BY_LETTER: Record<string, UnitType> = { c: 'cavalry', i: 'infantry', a: 'artillery', s: 'supply' };
const ROLL_MOD: Record<string, number> = { 'roll+1': 1, 'roll+2': 2, 'roll-1': -1 };

export interface BattleContext {
  view: GameView;
  me: string | null;
  emblems: Map<string, Emblem>;
  ui: BattleUi;
  /** History entries of this battle, oldest first. */
  history: HistoryEntry[];
  /** The last round of this battle the player has dismissed: later results stay on screen until then. */
  roundSeen: number;
  onRoundSeen(round: number): void;
  send(i: Intent): void;
  rerender(): void;
}

function battleIcon(size: number) {
  return iconEl(currentTheme().icons.battle, size);
}

const typeOfId = (id: string): UnitType => TYPE_BY_LETTER[id.split('.').pop()!.charAt(0)] ?? 'infantry';

function unitToken(type: UnitType, color: string, cls = '', title = '') {
  return h('span', { class: `unit-token ${cls}`, style: `--c:${color}`, title: title || unitName(type) }, unitIcon(type, 18));
}

/** "Cavalry +1 vs artillery · …" */
function advantageLegend(): HTMLElement {
  return h('div', { class: 'advantage muted' }, (Object.entries(TYPE_ADVANTAGE) as [UnitType, UnitType][]).map(([u, beats], i) =>
    h('span', {}, i ? ' · ' : '', unitIcon(u, 14), ' ', t('battle.beats', { unit: unitName(u), other: unitName(beats) }))));
}

/** The battle panel (docked, so the map stays visible), a choice of enemy, or null when there is no battle. */
export function battlePopup(ctx: BattleContext): HTMLElement | null {
  const { view: v, me, emblems } = ctx;
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
  // Only the players fighting see the battle's details; onlookers get a banner.
  const fighting = me === b.start.attacker.nation || me === b.start.defender.nation;
  if (me !== null && !fighting) return watchBanner(ctx, b);
  // A resolved round stays on screen until the player moves on.
  if (b.lastRound && b.lastRound.round > ctx.roundSeen) {
    const lr = b.lastRound;
    const left = (r: BattleRole) => (r === 'attacker' ? att : def)?.units.filter((u) => u.type !== 'supply').length ?? 0;
    return panelFrame(v, emblems, {
      node: b.node, round: lr.round, nations: { attacker: b.start.attacker.nation, defender: b.start.defender.nation },
      unitsLeft: { attacker: left('attacker'), defender: left('defender') }, lost: b.lost, label: t('battle.roundResult'),
      body: [resultRows(v, lr, { attacker: b.start.attacker.nation, defender: b.start.defender.nation }, emblems),
        h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: () => ctx.onRoundSeen(lr.round) }, t('battle.nextRound')))],
    });
  }
  // Retreats shrink the panel to a banner so the map can be clicked.
  if (b.step === 'retreat') return retreatBanner(ctx, att, def);
  return battlePanel(ctx, b, att, def);
}

function battlePanel(ctx: BattleContext, b: Battle, att: Army | undefined, def: Army | undefined): HTMLElement {
  const { view: v, me, emblems, ui } = ctx;
  const armies: Record<BattleRole, Army | undefined> = { attacker: att, defender: def };
  const nationOf = (r: BattleRole) => armies[r]?.nation ?? '';
  const colorOf = (r: BattleRole) => nationColor(v, nationOf(r));
  const myRole = ROLES.find((r) => nationOf(r) === me) ?? null;
  const prompt = v.pending.find((p) => p.nation === me);
  const node = def?.node ?? att?.node ?? '';
  const typeOf = (r: BattleRole, id: string) => armies[r]?.units.find((u) => u.id === id)?.type ?? typeOfId(id);
  const types = { attacker: b.units.attacker.map((id) => typeOf('attacker', id)), defender: b.units.defender.map((id) => typeOf('defender', id)) };

  // Cards visible to this player: its own (placed in the panel, or already sent) and, after the reveal, none pending.
  const hand = me ? v.hands[me] ?? [] : [];
  const ownCards: PlacedCard[] = myRole && b.cards[myRole]
    ? b.cards[myRole]!
    : [...ui.placed].map(([cardId, p]) => ({ cardId, ...p, type: hand.find((c) => c.id === cardId)?.type ?? 'roll+1' }));
  const duels = b.dice ? scoreDuels(types, b.units, b.matchups, b.dice, ownCards) : null;
  const placingCards = prompt?.kind === 'battleCards';

  const phase = b.step === 'select' ? 0 : b.step === 'choose' ? 1 : 2;
  const strip = h('ol', { class: 'bp-phases' }, PHASES.map((ph, i) =>
    h('li', { class: i < phase ? 'done' : i === phase ? 'active' : '' }, h('span', { class: 'bp-phase-n' }, String(i + 1)), t(`battle.phase.${ph}`))));

  const dieEl = (r: BattleRole, i: number, unused = false) => {
    const value = b.dice?.[r][i];
    const mods = ownCards.filter((p) => p.role === r && p.die === i);
    const target = placingCards && ui.card !== null;
    const inner = [
      h('span', { class: 'die-value' }, value ? String(value) : ''),
      ...mods.map((p) => h('span', {
        class: `die-mod ${ROLL_MOD[p.type] > 0 ? 'plus' : 'minus'}`,
        title: placingCards ? t('battle.removeCard', { card: cardName(p.type) }) : cardName(p.type),
        onclick: placingCards ? (e: Event) => { e.stopPropagation(); ui.placed.delete(p.cardId); ctx.rerender(); } : undefined,
      }, ROLL_MOD[p.type] > 0 ? `+${ROLL_MOD[p.type]}` : String(ROLL_MOD[p.type]))),
    ];
    const attrs = {
      class: `die bp-die ${value ? '' : 'empty'} ${target ? 'target' : ''} ${unused ? 'unused' : ''}`,
      style: `--ring:${colorOf(r)}`,
      title: value ? t('battle.dieOf', { nation: nationName(v, nationOf(r)), value }) : t('battle.notRolled'),
    };
    return target
      ? h('button', { ...attrs, onclick: () => { ui.placed.set(ui.card!, { role: r, die: i }); ui.card = null; ctx.rerender(); } }, ...inner)
      : h('span', attrs, ...inner);
  };

  // One row per matchup; a group's units and dice sit side by side, and only its best die counts.
  const rows = h('div', { class: 'bp-duels' }, b.matchups.map((m, k) => {
    const d = duels?.[k];
    const counting = (r: BattleRole) => (r === 'attacker' ? d?.attacker : d?.defender);
    const units = (r: BattleRole) => h('span', { class: `bp-unit ${r}` }, m[r].flatMap((i) => {
      const ty = types[r][i];
      const foes = m[other(r)].map((j) => types[other(r)][j]);
      const has = d && counting(r) === i ? (r === 'attacker' ? d.attackerBonus : d.defenderBonus) : typeBonus(ty, foes);
      const chip = has ? h('span', { class: 'bp-bonus', title: t('battle.typeBonus') }, '+1') : null;
      const token = unitToken(ty, colorOf(r), '', unitName(ty));
      return r === 'attacker' ? [chip, token] : [token, chip];
    }));
    const dice = (r: BattleRole) => h('span', { class: 'bp-dice' }, m[r].map((i) => dieEl(r, i, Boolean(d) && m[r].length > 1 && counting(r) !== i)));
    const group = m.attacker.length > 1 || m.defender.length > 1;
    return h('div', { class: 'bp-duel', title: group ? t('battle.groupHint') : undefined },
      units('attacker'),
      dice('attacker'),
      h('span', { class: 'bp-vs' }, d ? h('span', { class: `bp-total ${d.winner}` }, `${d.attackerPoints} : ${d.defenderPoints}`) : t('battle.vs')),
      dice('defender'),
      units('defender'));
  }));

  const status = h('div', { class: 'bp-status' });
  if (b.step === 'choose') {
    for (const r of ROLES) {
      const c = b.choice[r];
      add(status, h('span', { class: 'bp-chip', style: `--c:${colorOf(r)}` }, emblemEl(emblems.get(nationOf(r)), 16),
        c === null ? t('battle.deciding') : c === 'hidden' ? t('battle.decided') : t(`battle.choice.${c}`)));
    }
  } else if (b.step === 'cards') {
    for (const r of ROLES) {
      const waiting = v.pending.some((p) => p.nation === nationOf(r));
      const n = v.counts.committed[r];
      add(status, h('span', { class: 'bp-chip', style: `--c:${colorOf(r)}` }, emblemEl(emblems.get(nationOf(r)), 16),
        waiting ? t('battle.placingCards') : tn('battle.cardsPlayed', b.cards[r]?.length ?? n)));
    }
  } else if (b.step === 'select' || b.step === 'roll') {
    add(status, h('span', { class: 'muted' }, t('battle.drawing')));
  }

  const actions = h('div', { class: 'bp-actions' });
  if (prompt?.kind === 'battleChoice' && myRole) add(actions, choiceBar(ctx, myRole));
  if (placingCards && myRole) add(actions, cardsBar(ctx, myRole));

  const historyKeys = new Set(['log.round', 'log.destroyed', 'log.retreats', 'log.retreatBlocked', 'log.panic', 'log.panicLosses']);
  const historyLines = ctx.history.filter((e) => e.msg && historyKeys.has(e.msg.key));
  const footer = h('div', { class: 'bp-footer' },
    historyLines.length ? h('button', { class: 'link small', onclick: () => { ui.historyOpen = !ui.historyOpen; ctx.rerender(); } },
      ui.historyOpen ? t('battle.historyHide') : t('battle.historyShow', { count: historyLines.length })) : null,
    ui.historyOpen ? h('ul', { class: 'bp-history' }, historyLines.map((e) => h('li', {}, logText(e)))) : null);

  const left = (r: BattleRole) => armies[r]?.units.filter((u) => u.type !== 'supply').length ?? 0;
  return panelFrame(v, emblems, {
    node: b.node, round: b.round, nations: { attacker: b.start.attacker.nation, defender: b.start.defender.nation },
    unitsLeft: { attacker: left('attacker'), defender: left('defender') }, lost: b.lost, label: strip,
    body: [rows, status, actions, footer],
  });
}

interface FrameOptions {
  node: string;
  round: number;
  nations: Record<BattleRole, string>;
  /** Combat units each side has left, or null once the battle is over. */
  unitsLeft: Record<BattleRole, number> | null;
  lost: Record<BattleRole, UnitType[]>;
  /** Between the two sides: the phases, or what is being shown. */
  label: HTMLElement | string;
  body: (HTMLElement | null)[];
}

/** The docked battle panel: a wing of losses on each side, the title, both sides, and the content. */
function panelFrame(v: GameView, emblems: Map<string, Emblem>, o: FrameOptions): HTMLElement {
  const color = (r: BattleRole) => nationColor(v, o.nations[r]);
  const sideHead = (r: BattleRole) => h('div', { class: `bp-side ${r}`, style: `--c:${color(r)}` },
    emblemEl(emblems.get(o.nations[r]), 26),
    h('div', {}, h('strong', {}, nationName(v, o.nations[r])),
      h('div', { class: 'muted small' }, t(r === 'attacker' ? 'battle.attacks' : 'battle.defends'),
        o.unitsLeft ? ` · ${tn('battle.unitsLeft', o.unitsLeft[r])}` : '')));
  const wing = (r: BattleRole) => h('aside', { class: `bp-wing ${r}`, style: `--c:${color(r)}`, title: t('battle.lostTitle', { nation: nationName(v, o.nations[r]) }) },
    h('div', { class: 'bp-wing-head' }, t('battle.lost'), h('strong', {}, String(o.lost[r].length))),
    h('div', { class: 'bp-wing-units' }, o.lost[r].map((ty) => unitToken(ty, color(r), 'lost'))));
  return h('div', { class: 'battle-dock' }, h('div', { class: 'modal battle-panel', role: 'dialog', 'aria-label': t('battle.title', { node: o.node }) },
    wing('attacker'),
    h('div', { class: 'bp-main' },
      h('header', { class: 'bp-title' }, battleIcon(20), h('h2', {}, t('battle.title', { node: o.node })), h('span', { class: 'muted small' }, t('battle.roundN', { round: o.round }))),
      h('div', { class: 'bp-sides' }, sideHead('attacker'), typeof o.label === 'string' ? h('span', { class: 'bp-label' }, o.label) : o.label, sideHead('defender')),
      ...o.body),
    wing('defender')));
}

/** A resolved round: both choices, then each duel with its dice, cards, totals, and the unit that fell. */
function resultRows(v: GameView, lr: BattleRound, nations: Record<BattleRole, string>, emblems: Map<string, Emblem>): HTMLElement {
  const color = (r: BattleRole) => nationColor(v, nations[r]);
  const badges = (r: BattleRole, die: number) => [...lr.cards.attacker, ...lr.cards.defender]
    .filter((p) => p.role === r && p.die === die)
    .map((p) => h('span', { class: `die-mod ${ROLL_MOD[p.type] > 0 ? 'plus' : 'minus'}`, title: cardName(p.type) }, ROLL_MOD[p.type] > 0 ? `+${ROLL_MOD[p.type]}` : String(ROLL_MOD[p.type])));
  const die = (r: BattleRole, i: number, unused: boolean) => h('span', { class: `die bp-die ${unused ? 'unused' : ''}`, style: `--ring:${color(r)}` },
    h('span', { class: 'die-value' }, String(lr.dice![r][i])), ...badges(r, i));
  const choices = h('div', { class: 'bp-status' }, ROLES.map((r) => h('span', { class: 'bp-chip', style: `--c:${color(r)}` },
    emblemEl(emblems.get(nations[r]), 16), t(`battle.choice.${lr.choices[r]}`))));
  if (!lr.dice) {
    // Someone got away before the dice were rolled.
    return h('div', { class: 'bp-result' }, choices);
  }
  return h('div', { class: 'bp-result' },
    choices,
    h('div', { class: 'bp-duels' }, lr.duels.map((d) => {
      const winner = nations[d.winner];
      const counting = (r: BattleRole) => (r === 'attacker' ? d.attacker : d.defender);
      const units = (r: BattleRole, ...extra: HTMLElement[]) => h('span', { class: `bp-unit ${r}` }, d.matchup[r].flatMap((i) => {
        const ty = lr.types[r][i];
        const bonus = counting(r) === i && (r === 'attacker' ? d.attackerBonus : d.defenderBonus);
        const chip = bonus ? h('span', { class: 'bp-bonus', title: t('battle.typeBonus') }, '+1') : null;
        const fell = counting(r) === i && d.winner !== r;
        const token = unitToken(ty, color(r), fell ? 'lost' : '', unitName(ty));
        return r === 'attacker' ? [chip, token] : [token, chip];
      }), extra);
      const dice = (r: BattleRole) => h('span', { class: 'bp-dice' }, d.matchup[r].map((i) => die(r, i, d.matchup[r].length > 1 && counting(r) !== i)));
      return h('div', { class: `bp-duel done ${d.winner}` },
        units('attacker'),
        dice('attacker'),
        h('span', { class: 'bp-vs' }, h('span', { class: 'bp-total' }, `${d.attackerPoints} : ${d.defenderPoints}`)),
        dice('defender'),
        units('defender', h('span', { class: 'bp-winner', title: t('battle.duelWon', { nation: nationName(v, winner) }) }, emblemEl(emblems.get(winner), 16))));
    })));
}

/** After a battle, those who fought it see its last round until they close the panel. */
export function battleOverPanel(v: GameView, r: BattleReport, emblems: Map<string, Emblem>, onClose: () => void): HTMLElement {
  const nations = { attacker: r.attacker.nation, defender: r.defender.nation };
  return panelFrame(v, emblems, {
    node: r.node, round: r.rounds, nations, unitsLeft: null, lost: { attacker: r.attacker.lost, defender: r.defender.lost },
    label: t('battle.over'),
    body: [r.finalRound ? resultRows(v, r.finalRound, nations, emblems) : null,
      h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: onClose }, t('battle.close')))],
  });
}

const CHOICES: { choice: BattleChoice; card?: string }[] = [
  { choice: 'fight' }, { choice: 'block', card: 'blockRetreat' }, { choice: 'retreat', card: 'retreat' }, { choice: 'panic' },
];

/** Step 2: fight on, play Retreat or Block Retreat (if held), or flee in panic. */
function choiceBar(ctx: BattleContext, role: BattleRole): HTMLElement {
  const { view: v, me } = ctx;
  const hand = v.hands[me!] ?? [];
  return h('div', { class: 'bp-choice', style: `--c:${nationColor(v, me!)}` },
    h('div', { class: 'action-title' }, t(role === 'attacker' ? 'battle.chooseAttacker' : 'battle.chooseDefender')),
    h('div', { class: 'row' }, CHOICES.map(({ choice, card }) => {
      const count = card ? hand.filter((c) => c.type === card).length : 1;
      return h('button', {
        class: choice === 'fight' ? 'primary' : choice === 'panic' ? 'danger' : '',
        disabled: count === 0,
        title: t(`battle.choiceHint.${choice}`) + (count ? '' : ` ${t('battle.noCard')}`),
        onclick: () => ctx.send({ type: 'battleChoice', choice }),
      }, t(`battle.choice.${choice}`), card ? h('span', { class: 'muted small' }, ` (${count})`) : null);
    })),
    h('div', { class: 'muted small' }, t('battle.choiceHelp')));
}

/** Step 3: the dice are shown; put roll cards on any die (click a card, then a die). */
function cardsBar(ctx: BattleContext, role: BattleRole): HTMLElement {
  const { view: v, me, ui } = ctx;
  const color = nationColor(v, me!);
  const cards = (v.hands[me!] ?? []).filter((c) => ROLL_CARDS.includes(c.type));
  return h('div', { class: 'bp-cards', style: `--c:${color}` },
    h('div', { class: 'action-title' }, ui.card ? t('battle.pickDie') : t('battle.cardsTitle')),
    h('div', { class: 'row' },
      h('div', { class: 'card-row' }, cards.map((c) => {
        const placed = ui.placed.get(c.id);
        return cardEl(c, {
          color, small: true, playable: !placed, selected: ui.card === c.id,
          hint: placed ? t('battle.onDie', { role: t(`battle.role.${placed.role === role ? 'you' : 'enemy'}`), n: placed.die + 1 }) : t('battle.clickCard'),
          onclick: () => {
            if (placed) ui.placed.delete(c.id);
            else ui.card = ui.card === c.id ? null : c.id;
            ctx.rerender();
          },
        });
      })),
      h('button', {
        class: 'primary',
        onclick: () => ctx.send({ type: 'battleCards', cards: [...ui.placed].map(([cardId, p]) => ({ cardId, ...p })) }),
      }, ui.placed.size ? tn('battle.playCards', ui.placed.size) : t('battle.noCardsGo'))),
    advantageLegend());
}

function retreatBanner(ctx: BattleContext, att: Army | undefined, def: Army | undefined): HTMLElement {
  const { view: v, me, emblems } = ctx;
  const b = v.battle!;
  const prompt = v.pending.find((p) => p.nation === me);
  const r = b.retreats[0];
  const retreating = r ? (r === 'attacker' ? att : def) : undefined;
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

/** A battle between others, seen from nearby: who fights whom, where, and the losses so far. */
function watchBanner(ctx: BattleContext, b: Battle): HTMLElement {
  const { view: v, emblems } = ctx;
  const att = b.start.attacker.nation;
  const def = b.start.defender.nation;
  const lost = (r: BattleRole) => (b.lost[r].length ? h('span', { class: 'muted small' }, ` (${tn('recap.lostCount', b.lost[r].length)})`) : null);
  return h('div', { class: 'retreat-banner battle-watch', style: `--c:${nationColor(v, att)}` },
    battleIcon(22),
    h('strong', {}, t('battle.title', { node: b.node })),
    h('span', { class: 'row' }, emblemEl(emblems.get(att), 20), nationName(v, att), lost('attacker'),
      h('span', { class: 'muted' }, ` ${t('battle.vs')} `), emblemEl(emblems.get(def), 20), nationName(v, def), lost('defender')));
}

/**
 * The Battle over popup: who attacked and who defended, who won, what each side brought and
 * lost, and whether the beaten army retreated or was destroyed. During End Turn it also asks
 * whether to carry on to the end of the turn.
 */
export function battleRecap(v: GameView, r: BattleReport, emblems: Map<string, Emblem>, opts: {
  running: boolean; remaining: number; more: number; onContinue(): void; onStop(): void;
}): HTMLElement {
  const color = (n: string) => nationColor(v, n);
  const counts = (units: UnitType[]) => {
    const order: UnitType[] = ['infantry', 'cavalry', 'artillery', 'supply'];
    const present = order.filter((ty) => units.includes(ty));
    return present.length
      ? h('span', { class: 'rc-units' }, present.map((ty) => h('span', { class: 'rc-count', title: unitName(ty) }, unitIcon(ty, 16), String(units.filter((u) => u === ty).length))))
      : h('span', { class: 'muted' }, t('recap.none'));
  };
  const side = (role: BattleRole) => {
    const s = r[role];
    const won = r.winner === role;
    const status = won ? 'won' : s.fate;
    return h('section', { class: `rc-side ${won ? 'winner' : r.winner ? 'loser' : ''}`, style: `--c:${color(s.nation)}` },
      h('header', {},
        emblemEl(emblems.get(s.nation), 30),
        h('div', {}, h('strong', {}, nationName(v, s.nation)), h('div', { class: 'small' }, t(`recap.role.${role}`)))),
      h('div', { class: `rc-status ${status}` }, t(`recap.status.${status}`)),
      h('dl', {},
        h('dt', {}, t('recap.troops')), h('dd', {}, counts(s.units)),
        h('dt', {}, t('recap.lost')), h('dd', { class: 'rc-lost' }, counts(s.lost))));
  };
  const loser = r.winner ? r[r.winner === 'attacker' ? 'defender' : 'attacker'] : null;
  const summary = r.winner && loser
    ? t(`recap.summary.${loser.fate === 'destroyed' ? 'destroyed' : 'retreated'}`, { winner: nationName(v, r[r.winner].nation), loser: nationName(v, loser.nation) })
    : t(r.attacker.fate === 'destroyed' && r.defender.fate === 'destroyed' ? 'recap.summary.bothDestroyed' : 'recap.summary.noWinner');
  const next = opts.more ? ` (${tn('recap.more', opts.more)})` : '';
  return h('div', { class: 'modal-backdrop battle-backdrop' }, h('div', { class: 'modal recap-modal', role: 'dialog' },
    h('h2', {}, battleIcon(24), t('recap.titleAt', { node: r.node })),
    h('p', { class: 'rc-summary' }, summary),
    h('div', { class: 'rc-sides' }, side('attacker'), h('span', { class: 'rc-vs' }, t('battle.vs')), side('defender')),
    opts.running
      ? h('div', { class: 'row end' },
        h('button', { onclick: opts.onStop, title: t('recap.stopTitle') }, t('recap.stop')),
        h('button', { class: 'primary', onclick: opts.onContinue }, opts.more ? t('common.continue') + next : opts.remaining ? tn('recap.continueRun', opts.remaining) : t('recap.continueEnd')))
      : h('div', { class: 'row end' }, h('button', { class: 'primary', onclick: opts.onContinue }, t('common.continue') + next))));
}
