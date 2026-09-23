export type UnitType = 'cavalry' | 'infantry' | 'artillery' | 'supply';
export const UNIT_TYPES: UnitType[] = ['cavalry', 'infantry', 'artillery', 'supply'];
export const UNIT_SPEED: Record<UnitType, number> = { cavalry: 4, infantry: 3, artillery: 2, supply: 1 };
/** Generals are non-combat units that ride with their army; alone they move like cavalry. */
export const GENERAL_SPEED = 4;

export type Side = 'attacker' | 'defender';
/**
 * Who a nation fights alongside: its side ('attacker' / 'defender') normally, or the nation's own id
 * in a free-for-all game, where every nation is at war with every other.
 */
export type Team = string;
export type GameMode = 'sides' | 'freeForAll';
export type RoadType = 'major' | 'minor';
export type NationId = string;
export type NodeId = string;

export interface Nation {
  id: NationId;
  name: string;
  color: string;
  side: Side;
  /** Knocked out when willingness % drops below this. */
  threshold: number;
  warExhaustion: number;
  knockedOut: boolean;
}

export interface MapNode {
  id: NodeId;
  name: string;
  color: string;
  x: number;
  y: number;
  owner: NationId;
  controller: NationId;
  vp: number;
}

export interface Edge {
  a: NodeId;
  b: NodeId;
  type: RoadType;
}

export interface Unit {
  id: string;
  type: UnitType;
}

export interface General {
  id: string;
  name: string;
  nation: NationId;
}

export interface MoveState {
  edges: number;
  allMajor: boolean;
  /** Bonus speed from +1 Moves cards this turn. */
  bonus: number;
  /** Movement ended (e.g. it triggered a battle). */
  stopped: boolean;
}

export interface Army {
  id: string;
  nation: NationId;
  node: NodeId;
  generals: string[];
  units: Unit[];
  moved: MoveState;
}

export type GeneralCardType = 'roll+1' | 'roll+2' | 'roll-1' | 'retreat' | 'blockRetreat' | 'moves+1';
export type EventCardType =
  | 'recruit1'
  | 'recruit2'
  | 'recruitGeneral'
  | 'endGame'
  | 'exhaustion1'
  | 'exhaustion2'
  | 'exhaustion5'
  | 'spies'
  | 'enemySpies'
  | 'sabotage'
  | 'sabotaged'
  | 'nothing';

export interface Card<T extends string = string> {
  id: string;
  type: T;
}

export interface Deck<T extends string> {
  draw: Card<T>[];
  discard: Card<T>[];
}

export type BattleRole = 'attacker' | 'defender';

export interface CardPlacement {
  cardId: string;
  /** Whose die a roll card is placed on (Retreat and Block Retreat need no die). */
  role?: BattleRole;
  die?: number;
}

/** A side's secret plan for a round, made after seeing its own roll. */
export interface BattlePlan {
  /** The committed unit fighting with each die (`units[i]` goes with die i). */
  units: string[];
  cards: CardPlacement[];
}

export interface DieResult {
  /** Index of the attacker die (a "comparison"). */
  die: number;
  attackerPoints: number;
  defenderPoints: number;
  /** Unit-type bonuses included in the points above. */
  attackerBonus: number;
  defenderBonus: number;
  winner: BattleRole;
  /** Units destroyed in this comparison: the losing side's units on it. */
  destroyed: string[];
}

/**
 * A battle round: 'units' (both commit units, face down) → 'roll' → 'plan' (each sees only its own
 * roll, puts a unit on each die and commits cards) → 'defenderAssign' (dice and units are shown; the
 * defender opposes attacker dice) → reveal and resolve → 'panic' / 'retreat' when an army flees.
 */
export type BattleStep = 'units' | 'roll' | 'plan' | 'defenderAssign' | 'panic' | 'retreat';

export interface Battle {
  attackerArmy: string;
  defenderArmy: string;
  step: BattleStep;
  round: number;
  /** Combat units each side sends into this round (one per die). */
  units: Record<BattleRole, string[] | null>;
  dice: Record<BattleRole, number[]> | null;
  plan: Record<BattleRole, BattlePlan | null>;
  /** Cards each side committed this round (from its plan). */
  committed: Record<BattleRole, Card<GeneralCardType>[] | null>;
  /** Per defender die: which attacker die it opposes. */
  defenderAssign: number[] | null;
  lastRound: {
    results: DieResult[];
    dice: Record<BattleRole, number[]>;
    plans: Record<BattleRole, BattlePlan>;
    defenderAssign: number[];
    placements: Record<BattleRole, (CardPlacement & { type: GeneralCardType })[]>;
  } | null;
  /** Remaining retreat work, processed front to back. A panicking army first loses units the enemy picks. */
  retreats: { role: BattleRole; panic: boolean }[];
  /** A side that panicked instead of fighting. */
  panic?: BattleRole | null;
}

export interface Reveal {
  /** Nations whose armies are revealed. */
  of: NationId[];
  /** Team that gets to see them. */
  to: Team;
  /** Turn number after which the reveal expires. */
  untilTurn: number;
}

export type Prompt =
  | { nation: NationId; kind: 'movement' }
  | { nation: NationId; kind: 'chooseBattle'; options: string[] }
  /** Commit combat units to the round (or panic). */
  | { nation: NationId; kind: 'battleUnits'; count: number }
  /** After seeing its own roll: a unit on each die, and any cards. */
  | { nation: NationId; kind: 'battlePlan' }
  | { nation: NationId; kind: 'defenderAssign' }
  | { nation: NationId; kind: 'retreat'; army: string }
  /** The enemy panicked (or its retreat was blocked): pick `count` of its combat units to destroy. */
  | { nation: NationId; kind: 'panicTargets'; army: string; count: number }
  | { nation: NationId; kind: 'attrition'; army: string }
  | { nation: NationId; kind: 'sabotage'; options: string[] }
  /** Recruit event: place `remaining` new units (or one general) on one of `options` (own nodes). */
  | { nation: NationId; kind: 'recruit'; what: 'unit' | 'general'; remaining: number; options: NodeId[] };

export type OracleRequest =
  | { kind: 'shuffle'; deck: 'general' | 'event'; n: number }
  | { kind: 'roll'; attacker: number; defender: number };

export type Phase = 'turnStart' | 'movement' | 'battle' | 'turnEnd' | 'gameOver';
export type TurnStartStep = 'general' | 'event' | 'eventResolve';
export type TurnEndStep = 'attrition' | 'control' | 'finish';

export interface GameState {
  mapName: string;
  nations: Nation[];
  nodes: Record<NodeId, MapNode>;
  edges: Edge[];
  generals: Record<string, General>;
  armies: Record<string, Army>;
  generalDeck: Deck<GeneralCardType>;
  eventDeck: Deck<EventCardType>;
  hands: Record<NationId, Card<GeneralCardType>[]>;
  current: NationId;
  /** Nation turns played so far, counting from 1. */
  turn: number;
  /** Rounds: a new round starts when play returns to the first living nation. */
  round: number;
  rules: Rules;
  phase: Phase;
  /** Draws at the start of the current nation's turn: a General card, then an Event card. */
  turnStart: { step: TurnStartStep; event: Card<EventCardType> | null } | null;
  turnEnd: { step: TurnEndStep; attrition: string[] } | null;
  battle: Battle | null;
  /** Enemy armies still to fight after the current battle. */
  battleQueue: { attacker: string; defenders: string[] } | null;
  pending: Prompt[];
  oracle: OracleRequest | null;
  reveals: Reveal[];
  /** Winning team: a side, or a nation id in a free-for-all game. */
  winner: Team | null;
  nextId: number;
  /** Human readable history for the UI log. `side` limits who may see an entry. */
  history: HistoryEntry[];
}

export type HistoryKind = 'turn' | 'order' | 'card' | 'battle' | 'event' | 'control' | 'attrition' | 'result';

export interface Rules {
  /** Before this round, a drawn End Game card goes to the bottom of the event deck instead. */
  endGameFromRound: number;
  /** 'sides': attackers against defenders. 'freeForAll': every nation is an attacker, at war with all others. */
  mode: GameMode;
}

export interface HistoryEntry {
  turn: number;
  /** Round (every living nation has one turn per round). */
  round?: number;
  /** English text; `msg` lets clients render it in another language. */
  text: string;
  msg?: { key: string; params: Record<string, string | number> };
  /** Only this side may see the entry. */
  side?: Team;
  kind?: HistoryKind;
  /** Nation the entry is about (for emblems and filters). */
  nation?: NationId;
  /** Node the entry concerns (click-to-locate). */
  node?: NodeId;
}
