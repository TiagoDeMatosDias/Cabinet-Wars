import {
  dependentsOf, orderToIntents, reachable, retreatPlan, sideOf, visibleNodes,
  type Army, type GameState, type GameView, type HistoryEntry, type Intent, type OrderIntent, type UnitType,
} from '@krieg/engine';
import { MapView, type HighlightKind, type MapScene } from '../render/MapView';
import { backgroundName } from '../maps';
import type { Session } from '../net/session';
import { HostSession } from '../net/host';
import { idb } from '../storage/idb';
import { describe, Plan, type Projection } from '../orders/plan';
import { onThemeChange, useThemeForMap } from '../theme/theme';
import { errorText, logText, mapNameText, nodeText, onLanguageChange, t, tn, useMapText, setDefaultNames } from '../i18n/i18n';
import { armyCard, reorganizeEditor, splitEditor } from './army';
import { nodeCard } from './node';
import { battleKey, battlePopup, battleRecap, freshBattleUi } from './battle';
import { clear, download, h, toast } from './dom';
import { buildEmblems } from './emblem';
import { nationColor, nationName } from './labels';
import {
  gameOverDialog, handoffDialog, handPanel, logDrawer, ordersPanel, promptDialog, recruitBanner, topBar, turnControls, type LogFilter,
} from './panels';

export interface SaveRecord {
  id: string;
  title: string;
  date: string;
  mapName: string;
  turn: number;
  blob: Blob;
}

/** The in-game screen (docs/game-screen.md). */
export async function gameScreen(root: HTMLElement, session: Session, onExit: () => void) {
  await useThemeForMap(session.map.config);
  useMapText(session.map.config);
  setDefaultNames(session.map.config);
  const nations = () => session.map.config.nations as Parameters<typeof buildEmblems>[0];
  let emblems = buildEmblems(nations(), session.map);

  const slots = {
    top: h('div', { class: 'slot-top' }),
    army: h('div', { class: 'slot-army' }),
    hand: h('div', { class: 'slot-hand' }),
    controls: h('div', { class: 'slot-controls' }),
    orders: h('div', { class: 'slot-orders' }),
    log: h('div', { class: 'slot-log' }),
    banner: h('div', { class: 'slot-banner' }),
    modal: h('div', { class: 'slot-modal' }),
    editor: h('div', { class: 'slot-editor' }),
    handoff: h('div', { class: 'slot-handoff' }),
  };
  const mapEl = h('div', { class: 'map' });
  clear(root, h('div', { class: 'game' }, slots.top,
    h('div', { class: 'stage' }, mapEl, slots.army, slots.hand, slots.controls, slots.orders, slots.log, slots.banner, slots.modal, slots.editor),
    slots.handoff));

  const map = await MapView.create(mapEl, session.map.files[backgroundName(session.map)] ?? null);
  const unsubTheme = onThemeChange((t) => { emblems = buildEmblems(nations(), session.map, t); map.setTheme(t); render(); });

  // ---- local UI state ----
  let selected: string[] = [];
  /** Node whose details card is open (only when no army is selected). */
  let selectedNode: string | null = null;
  let selectedCard: string | null = null;
  let logOpen = false;
  let logFilter: LogFilter = 'all';
  let logSeen = 0;
  let plan: Plan | null = null;
  let running = false;
  let progress: string | null = null;
  let stopRequested = false;
  let battleUi = freshBattleUi('none');
  /** The current popup is collapsed to a pill so the map can be explored. */
  let popupMinimized = false;
  let battleStart: number | null = null;
  let recap: HistoryEntry[] | null = null;
  /** Counts recaps shown, to tell whether an order's battle was already shown. */
  let recapCount = 0;
  let editorOpen = false;
  let recruitType: UnitType = 'infantry';
  let shownSeat: string | null = null;
  const hotseat = session.isHost && session.localSeats().length > 1;

  const view = () => session.view();
  const me = () => session.actingSeat();

  const send = async (intent: Intent) => {
    try { await session.send(intent); } catch (e) { toast(errorText(e), 'error'); }
  };

  /** The plan belongs to the nation whose turn it is, and only exists in the browser that plays it. */
  function ensurePlan(v: GameView) {
    if (!session.localSeats().includes(v.current) || v.phase === 'gameOver') return;
    const key = `krieg:plan:${session.map.id}:${session.room ?? 'local'}:${v.turn}:${v.current}`;
    if (plan?.key === key) return;
    plan?.clearStorage();
    plan = new Plan(key);
    selected = [];
    selectedCard = null;
  }

  const myTurn = (v: GameView) => me() !== null && v.current === me() && v.phase !== 'gameOver';
  const canPlan = (v: GameView) => myTurn(v) && !running && !progress && v.phase === 'movement' && v.pending.some((p) => p.nation === me() && p.kind === 'movement');
  const projection = (v: GameView): Projection | null => (plan && myTurn(v) ? plan.project(v, v.current) : null);

  function addOrder(intent: OrderIntent) {
    const v = view();
    if (!v || !plan) return;
    try {
      plan.add(v, v.current, intent);
    } catch (e) {
      toast(errorText(e), 'error');
    }
    render();
  }

  // ---- execution ----

  /** Resolves once the game is back to plain movement (any battle and its recap finished). */
  function settled(): Promise<void> {
    const check = () => {
      const v = view();
      if (!v) return false;
      if (v.phase === 'gameOver') return true;
      return v.phase === 'movement' && !v.battle && v.pending.some((p) => p.kind === 'movement') && !recap;
    };
    return new Promise((resolve) => {
      if (check()) { resolve(); return; }
      const done = () => { clearInterval(poll); unsub(); resolve(); };
      const unsub = session.subscribe(() => { if (check()) done(); });
      // The recap is closed locally, without a session update.
      const poll = setInterval(() => { if (check()) done(); }, 250);
    });
  }

  /** Why a planned order became impossible, in the player's language. */
  function friendlyReason(err: { error?: string; errorTemplate?: string; errorParams?: Record<string, string | number> } | string | undefined): string {
    const template = typeof err === 'string' ? err : err?.errorTemplate ?? err?.error;
    if (!template) return t('reason.noLonger');
    if (/Unknown army|no longer exists|has not been created/.test(template)) return t('reason.armyGone');
    if (/cannot move further/.test(template)) return t('reason.stopped');
    if (/Not enough movement/.test(template)) return t('reason.noMovement');
    return typeof err === 'string' ? err : errorText({ template: err?.errorTemplate, params: err?.errorParams, message: err?.error });
  }

  /** Drops planned orders that became impossible, with the reason, together with their dependents. */
  function revalidate() {
    const v = view();
    if (!v || !plan) return;
    const p = plan.project(v, v.current);
    const drop = new Map<string, string>();
    p.results.forEach((r, i) => {
      if (r.ok) return;
      const id = plan!.orders[i].id;
      drop.set(id, friendlyReason(r));
      for (const dep of dependentsOf(plan!.orders, id)) if (!drop.has(dep)) drop.set(dep, t('reason.dependsRemoved'));
    });
    if (!drop.size) return;
    plan.orders.forEach((o, i) => {
      const reason = drop.get(o.id);
      if (reason) plan!.history.push({ order: o, status: 'removed', ...describe(o, v, p, i), reason });
    });
    plan.orders = plan.orders.filter((o) => !drop.has(o.id));
    plan.save();
    toast(tn('game.ordersRemoved', drop.size, { reason: [...drop.values()][0] }), 'error');
  }

  /** Executes the next order. Returns 'battle' when it led to a battle (which has then been shown). */
  async function runNext(): Promise<false | 'ok' | 'battle'> {
    const v = view();
    if (!v || !plan || !plan.orders.length || running) return false;
    const historyStart = v.history.length;
    const recapsBefore = recapCount;
    running = true;
    render();
    try {
      const nation = v.current;
      const o = plan.orders[0];
      let d = { text: '', detail: '' };
      let error: string | null = null;
      let created = new Map<string, string>();
      try {
        d = describe(o, v, plan.project(v, nation), 0);
        // Throws when the order refers to an army that no longer exists.
        const conv = orderToIntents(o.intent, plan.ids, nation, v.nextId);
        created = conv.created;
        for (const intent of conv.intents) {
          try { await session.send(intent); } catch (e) { error = errorText(e); break; }
        }
      } catch (e) {
        error = errorText(e);
      }
      plan.orders = plan.orders.filter((x) => x.id !== o.id);
      if (error) plan.history.push({ order: o, status: 'removed', ...d, reason: error });
      else {
        for (const [ph, id] of created) plan.ids.set(ph, id);
        plan.history.push({ order: o, status: 'done', ...d });
      }
      plan.save();
      await settled();
      // A battle that ended at once (e.g. against an army without combat units) never showed a popup:
      // show what happened before carrying on.
      const since = view()?.history.slice(historyStart) ?? [];
      const battle = since.some((e) => e.msg?.key === 'log.battle');
      if (battle && recapCount === recapsBefore) {
        recap = since.filter((e) => e.kind === 'battle');
        recapCount++;
        render();
        await settled();
      }
      revalidate();
      return battle ? 'battle' : 'ok';
    } finally {
      // Never leave the list locked, whatever went wrong.
      running = false;
      render();
    }
  }

  async function endTurn() {
    const v = view();
    if (!v || running || progress || !plan) return;
    stopRequested = false;
    const total = plan.orders.length;
    let n = 0;
    while (plan.orders.length && !stopRequested) {
      progress = t('status.running', { n: ++n, total });
      render();
      // After a battle the recap asks whether to carry on or stop (stopRequested).
      await runNext();
      if (view()?.phase === 'gameOver') break;
    }
    const stopped = stopRequested;
    progress = null;
    if (stopped) toast(t('game.runStopped'));
    if (stopped || view()?.phase === 'gameOver') { render(); return; }
    await settled();
    selected = [];
    await send({ type: 'endTurn' });
    render();
  }

  // ---- map interaction ----

  const displayState = (v: GameView, proj: Projection | null): GameState => proj?.state ?? v;

  /** Nodes every selected army of the player can still reach (in the projected state). */
  function moveHighlights(state: GameState): Map<string, HighlightKind> {
    const out = new Map<string, HighlightKind>();
    const mine = selected.map((id) => state.armies[id]).filter((a): a is Army => !!a && a.nation === me());
    if (!mine.length) return out;
    const sets = mine.map((a) => new Set(reachable(state, a).keys()));
    for (const n of sets[0]) if (sets.every((s) => s.has(n))) out.set(n, 'move');
    return out;
  }

  map.onClick = ({ node, army, shift }) => {
    const v = view();
    if (!v) return;
    const p = v.pending.find((x) => x.nation === me());
    const proj = projection(v);
    const state = displayState(v, proj);
    if (p?.kind === 'recruit' && node && p.options.includes(node)) {
      void send(p.what === 'general' ? { type: 'recruit', node } : { type: 'recruit', node, unit: recruitType });
      return;
    }
    if (selectedCard && army && canPlan(v) && plan && proj && state.armies[army]?.nation === me()) {
      addOrder({ type: 'playMoves', army: plan.refFor(army, proj), card: selectedCard });
      selectedCard = null;
      render();
      return;
    }
    const clickedOwnSelected = army && selected.includes(army);
    if (node && !clickedOwnSelected && moveSelectedTo(node)) return;
    if (army) {
      if (shift) selected = selected.includes(army) ? selected.filter((x) => x !== army) : [...selected, army];
      else selected = [army];
      selectedNode = null;
    } else if (node) {
      // Clicking a node shows its details; its armies are listed there.
      selected = [];
      selectedNode = node;
    } else {
      selected = [];
      selectedNode = null;
    }
    render();
  };
  /** Plans a move of every selected army to a highlighted node. Returns false if that isn't possible. */
  function moveSelectedTo(node: string): boolean {
    const v = view();
    if (!v || !plan || !canPlan(v) || !selected.length) return false;
    const proj = projection(v);
    if (!moveHighlights(displayState(v, proj)).has(node)) return false;
    for (const id of selected) {
      const current = plan.project(v, v.current);
      const a = current.state.armies[id];
      if (!a || a.nation !== me()) continue;
      const path = reachable(current.state, a).get(node);
      if (path) addOrder({ type: 'move', army: plan.refFor(id, current), path });
    }
    render();
    return true;
  }

  // Right click: move the selected armies there.
  map.onRightClick = ({ node }) => {
    const v = view();
    if (!v || !node) return;
    if (!selected.length) return;
    if (!moveSelectedTo(node)) toast(canPlan(v) ? t('game.outOfReach') : t('game.notYourTurn'), 'error');
  };

  map.onBoxSelect = (ids) => {
    selected = ids;
    selectedNode = null;
    render();
  };

  // Cards dragged from the hand onto an army on the map.
  map.canvas.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('application/x-krieg-card')) e.preventDefault(); });
  map.canvas.addEventListener('drop', (e) => {
    const raw = e.dataTransfer?.getData('application/x-krieg-card');
    if (!raw) return;
    e.preventDefault();
    const { id } = JSON.parse(raw) as { id: string };
    const { army } = map.pick(e.clientX, e.clientY);
    const v = view();
    if (!v || !army) { toast(t('game.dropOnArmy'), 'error'); return; }
    const p = v.pending.find((x) => x.nation === me());
    if (p?.kind === 'retreat') { void send({ type: 'playMoves', army: p.army, card: id }); return; }
    const proj = projection(v);
    if (canPlan(v) && plan && proj) addOrder({ type: 'playMoves', army: plan.refFor(army, proj), card: id });
  });

  function focusNode(id: string) {
    const n = view()?.nodes[id];
    if (n) map.focus(n.x, n.y);
  }

  /** Pans to a node and opens its card (log entries, roads in the node card). */
  function showNode(id: string) {
    selected = [];
    selectedNode = id;
    focusNode(id);
    render();
  }

  // ---- editors ----

  function openEditor(el: HTMLElement) {
    editorOpen = true;
    slots.editor.replaceChildren(el);
  }
  function closeEditor() {
    editorOpen = false;
    slots.editor.replaceChildren();
  }

  // ---- rendering ----

  function render() {
    const v = view();
    if (!v) return;
    ensurePlan(v);
    const seat = me();
    const proj = projection(v);
    const state = displayState(v, proj);
    const planning = canPlan(v);
    selected = selected.filter((id) => state.armies[id] || v.armies[id]);
    // Fog of war for the player at the screen (none once the game is over).
    const visible = seat && v.phase !== 'gameOver' ? visibleNodes(v, sideOf(v, seat)) : undefined;

    // Battle bookkeeping: remember where it started in the log; show a recap when it ends.
    if (v.battle && battleStart === null) {
      const idx = [...v.history].reverse().findIndex((e) => e.text.startsWith('Battle at'));
      battleStart = idx < 0 ? v.history.length : v.history.length - 1 - idx;
    }
    if (!v.battle && battleStart !== null && !v.pending.some((p) => p.kind === 'chooseBattle')) {
      recap = v.history.slice(battleStart).filter((e) => e.kind === 'battle');
      recapCount++;
      battleStart = null;
    }
    const bk = battleKey(v, seat);
    if (bk !== battleUi.key) battleUi = { ...freshBattleUi(bk), historyOpen: battleUi.historyOpen };

    // Hotseat: hide everything behind a handoff screen when the device passes to another player.
    const handoff = hotseat && seat !== null && seat !== shownSeat && v.phase !== 'gameOver';
    slots.handoff.replaceChildren(handoff ? handoffDialog(v, seat!, emblems, () => { shownSeat = seat; render(); }) : '');

    const statusLine = v.phase === 'gameOver' ? t('status.gameOver')
      : v.battle ? t('status.battle')
        : myTurn(v) ? (progress ?? (running ? t('status.executing') : t('status.yourTurn')))
          : t('status.waitingFor', { names: [...new Set(v.pending.map((p) => nationName(v, p.nation)))].join(', ') || nationName(v, v.current) });
    slots.top.replaceChildren(topBar({
      view: v, me: seat, emblems, mapName: mapNameText(session.map.name), status: session.status(), statusLine,
      onSave: session instanceof HostSession ? () => void saveGame(session) : undefined,
      onLeave: onExit,
    }));

    const cardState = selected.every((id) => state.armies[id]) ? state : v;
    const planned = Boolean(proj && selected.some((id) => {
      const a = proj.state.armies[id];
      const r = v.armies[id];
      return !r || !a || a.node !== r.node || a.units.length !== r.units.length;
    }));
    // The army card belongs to the planning player; it stays hidden while a battle is open.
    const card = handoff || v.battle ? null : armyCard({
      view: v, state: cardState, selected, me: seat, planning, planned, emblems,
      actions: {
        close: () => { selected = []; render(); },
        split: (a) => {
          if (!plan || !proj) return;
          openEditor(splitEditor({
            view: v, army: a, state: cardState, color: nationColor(v, a.nation),
            onCancel: closeEditor,
            onConfirm: (units, generals) => {
              closeEditor();
              addOrder({ type: 'split', army: plan!.refFor(a.id, proj), units, generals, creates: plan!.newPlaceholder() });
            },
          }));
        },
        reorganize: (node) => {
          if (!plan || !proj) return;
          const armies = Object.values(cardState.armies).filter((x) => x.node === node && x.nation === seat);
          openEditor(reorganizeEditor({
            view: v, armies, state: cardState, color: nationColor(v, seat!),
            onCancel: closeEditor,
            onConfirm: (groups) => {
              closeEditor();
              addOrder({
                type: 'transfer',
                groups: groups.map((g) => (g.army === null
                  ? { army: null, units: g.units, generals: g.generals, creates: plan!.newPlaceholder() }
                  : { army: plan!.refFor(g.army, proj), units: g.units, generals: g.generals })),
              });
            },
          }));
        },
        merge: (ids) => {
          if (!plan || !proj) return;
          addOrder({ type: 'merge', into: plan.refFor(ids[0], proj), from: ids.slice(1).map((id) => plan!.refFor(id, proj)) });
          selected = [ids[0]];
          render();
        },
        playMoves: (a) => {
          const moves = cardState.hands[seat!]?.find((c) => c.type === 'moves+1');
          if (moves && plan && proj) addOrder({ type: 'playMoves', army: plan.refFor(a.id, proj), card: moves.id });
        },
      },
    });
    if (selectedNode && !v.nodes[selectedNode]) selectedNode = null;
    slots.army.replaceChildren(card
      ?? (selectedNode && !handoff && !v.battle ? nodeCard({
        view: v, node: selectedNode, me: seat, emblems, fogged: Boolean(visible && !visible.has(selectedNode)),
        onSelectArmy: (id) => { selected = [id]; selectedNode = null; render(); },
        onSelectNode: showNode,
        onClose: () => { selectedNode = null; render(); },
      }) : null)
      ?? '');

    const retreating = v.pending.some((p) => p.nation === seat && p.kind === 'retreat');
    // Cards already used by planned orders leave the hand.
    const plannedCards = new Set(plan && myTurn(v) ? plan.orders.flatMap((o) => (o.intent.type === 'playMoves' ? [o.intent.card] : [])) : []);
    const handView = plannedCards.size && seat
      ? { ...v, hands: { ...v.hands, [seat]: (v.hands[seat] ?? []).filter((c) => !plannedCards.has(c.id)) } }
      : v;
    slots.hand.replaceChildren(handoff ? '' : handPanel({
      view: handView, me: seat, planning, retreating, selectedCard,
      onSelect: (id) => { selectedCard = id; if (id) toast(t('game.clickArmyForCard')); render(); },
    }) ?? '');

    const showOrders = Boolean(plan && proj && myTurn(v));
    slots.orders.replaceChildren(showOrders && !handoff ? ordersPanel({
      view: v, plan: plan!, projection: proj!, planning, running: running || Boolean(progress),
      canAdd: Object.values(state.armies).some((a) => a.nation === seat && (!a.moved.stopped || a.units.length > 1)),
      onRemove: (id) => {
        const deps = plan!.dependents(id);
        if (deps.length && !confirm(`${tn('orders.confirmRemove', deps.length)}\n${deps.map((o) => `• ${describe(o, v, proj!).text}`).join('\n')}`)) return;
        plan!.remove(id);
        revalidate();
        render();
      },
      onDismiss: (id) => { plan!.dismiss(id); render(); },
      onMove: (from, to) => {
        const problem = plan!.canMove(v, v.current, from, to);
        if (problem) { toast(problem, 'error'); return; }
        plan!.move(from, to);
        render();
      },
      onFocus: focusNode,
    }) : '');

    slots.controls.replaceChildren(handoff ? '' : turnControls({
      myTurn: myTurn(v) && !v.battle,
      canStep: planning && Boolean(plan?.orders.length),
      canEnd: planning,
      remaining: plan?.orders.length ?? 0,
      progress,
      onNext: () => void runNext(),
      onEnd: () => void endTurn(),
    }) ?? '');

    if (logOpen) logSeen = v.history.length;
    slots.log.replaceChildren(logDrawer({
      view: v, me: seat, emblems, open: logOpen, filter: logFilter, unread: logOpen ? 0 : v.history.length - logSeen,
      onToggle: () => { logOpen = !logOpen; if (logOpen) logSeen = v.history.length; render(); },
      onFilter: (f) => { logFilter = f; render(); },
      onFocus: showNode,
    }));

    // Modal layer: battle (or its retreat banner), battle recap, end-of-turn prompts, game over.
    const battleEntries = battleStart !== null ? v.history.slice(battleStart).filter((e) => e.kind === 'battle') : [];
    const popup = handoff ? null : battlePopup({ view: v, me: seat, emblems, ui: battleUi, history: battleEntries, send: (i) => void send(i), rerender: render });
    const isBanner = Boolean(popup?.classList.contains('retreat-banner'));
    const recruit = handoff ? null : recruitBanner(v, seat, emblems, recruitType, (ty) => { recruitType = ty; render(); }, (i) => void send(i));
    slots.banner.replaceChildren((isBanner && popup) || recruit || '');
    const modalEl = (!isBanner && popup)
      || (recap && !handoff ? battleRecap(v, recap, emblems, {
        // While End Turn is running, the player decides whether to carry on to the end of the turn.
        running: Boolean(progress) && myTurn(v),
        remaining: plan?.orders.length ?? 0,
        onContinue: () => { recap = null; render(); },
        onStop: () => { stopRequested = true; recap = null; render(); },
      }) : null)
      || (handoff ? null : promptDialog(v, seat, emblems, (i) => void send(i)))
      || gameOverDialog(v, emblems, onExit)
      || null;
    // Any popup can be minimized to a pill, so the player can look around the map first.
    if (!modalEl) popupMinimized = false;
    const popupTitle = modalEl?.querySelector('h2, h3')?.textContent?.trim() || t('popup.untitled');
    const yourMove = v.pending.some((x) => x.nation === seat);
    if (modalEl && popupMinimized) {
      slots.modal.replaceChildren(h('button', {
        class: `popup-pill ${yourMove ? 'your-move' : ''}`, title: t('popup.restoreTitle'),
        onclick: () => { popupMinimized = false; render(); },
      }, h('span', { class: 'pill-arrow' }, '▾'), h('span', {}, popupTitle), yourMove ? h('span', { class: 'pill-note' }, t('popup.yourMove')) : null));
    } else if (modalEl) {
      const box = modalEl.querySelector('.modal');
      box?.prepend(h('button', {
        class: 'icon-btn popup-min', title: t('popup.minimizeTitle'), 'aria-label': t('popup.minimize'),
        onclick: () => { popupMinimized = true; render(); },
      }, '–'));
      slots.modal.replaceChildren(modalEl);
    } else slots.modal.replaceChildren('');

    // Map.
    const highlights = new Map<string, HighlightKind>();
    const p = v.pending.find((x) => x.nation === seat);
    if (p?.kind === 'retreat' && v.armies[p.army]) {
      // The rules pick the destination; show it.
      const plan = retreatPlan(v, v.armies[p.army]);
      if (plan) highlights.set(plan.path[plan.path.length - 1], 'retreat');
    }
    else if (p?.kind === 'sabotage' || p?.kind === 'chooseBattle') for (const id of p.options) { if (v.armies[id]) highlights.set(v.armies[id].node, 'target'); }
    else if (p?.kind === 'recruit') for (const n of p.options) highlights.set(n, 'move');
    else if (planning) for (const [n, k] of moveHighlights(state)) highlights.set(n, k);
    const ghosts: NonNullable<MapScene['ghosts']> = [];
    const arrows: NonNullable<MapScene['arrows']> = [];
    if (proj) {
      for (const a of Object.values(proj.state.armies)) {
        if (a.nation !== seat) continue;
        const real = v.armies[a.id];
        if (!real || real.node !== a.node) ghosts.push({ army: a, node: a.node });
      }
      proj.results.forEach((r, i) => { if (r.ok && r.path && r.path.length > 1) arrows.push({ path: r.path, step: i + 1 }); });
    }
    map.render({
      nodes: Object.values(v.nodes).map((n) => ({ ...n, name: nodeText(n.id) })),
      edges: v.edges,
      nations: v.nations,
      armies: handoff ? [] : Object.values(v.armies),
      emblems,
      highlights: handoff ? new Map() : highlights,
      here: handoff ? [] : [...new Set(selected.map((id) => state.armies[id]?.node ?? v.armies[id]?.node).filter(Boolean) as string[])],
      selectedArmies: new Set(selected),
      selectedNode: selected.length ? null : selectedNode,
      visible: handoff ? undefined : visible,
      ghosts: handoff ? [] : ghosts,
      arrows: handoff ? [] : arrows,
    });
  }

  async function saveGame(host: HostSession) {
    const title = t('game.saveTitle', { map: mapNameText(session.map.name), round: view()?.round ?? 1 });
    const { blob, meta } = await host.save(title);
    const rec: SaveRecord = { id: crypto.randomUUID(), title, date: meta.date, mapName: meta.mapName, turn: meta.turn, blob };
    await idb.put('saves', rec);
    download(blob, `${session.map.name.replace(/\W+/g, '_')}_turn${meta.turn}.krieg`);
    toast(t('game.saved'));
  }

  // Keyboard: N = next step, L = log, M = minimize / restore the popup, Esc = close / deselect / stop running.
  const onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) return;
    if (e.key === 'Escape') {
      if (editorOpen) closeEditor();
      else if (progress) { stopRequested = true; toast(t('game.stopping')); }
      else if (selectedCard) selectedCard = null;
      else { selected = []; selectedNode = null; }
      render();
    } else if (e.key === 'n' || e.key === 'N') {
      const v = view();
      if (v && canPlan(v)) void runNext();
    } else if (e.key === 'm' || e.key === 'M') {
      popupMinimized = !popupMinimized;
      render();
    } else if (e.key === 'l' || e.key === 'L') {
      logOpen = !logOpen;
      render();
    }
  };
  window.addEventListener('keydown', onKey);

  // Announce events drawn since the last update.
  let seenHistory = view()?.history.length ?? 0;
  const unsub = session.subscribe(() => {
    const v = view();
    if (v) {
      for (const e of v.history.slice(seenHistory)) if (e.kind === 'event') toast(logText(e));
      seenHistory = v.history.length;
    }
    render();
  });
  const v0 = view();
  if (v0) {
    const own = Object.values(v0.armies).filter((a) => session.localSeats().includes(a.nation));
    map.fitTo((own.length ? own.map((a) => v0.nodes[a.node]) : Object.values(v0.nodes)).filter(Boolean));
  }
  const unsubLang = onLanguageChange(() => render());
  render();
  // Test hook: ?debug exposes the map and session to automated browser tests.
  if (new URLSearchParams(location.search).has('debug')) (window as unknown as Record<string, unknown>).__krieg = { map, session, plan: () => plan };
  return () => { unsub(); unsubTheme(); unsubLang(); window.removeEventListener('keydown', onKey); map.destroy(); };
}
