export type UnitType = 'cavalry' | 'infantry' | 'artillery' | 'supply';
export const UNIT_TYPES: UnitType[] = ['cavalry', 'infantry', 'artillery', 'supply'];
export const UNIT_SPEED: Record<UnitType, number> = { cavalry: 4, infantry: 3, artillery: 2, supply: 2 };
/** Generals are non-combat units that ride with their army; alone they move like cavalry. */
export const GENERAL_SPEED = 4;
/** Rules version 3: movement points per turn (see ROAD_COST). */
export const MOVE_POINTS: Record<UnitType, number> = { cavalry: 8, infantry: 6, artillery: 4, supply: 4 };
export const GENERAL_POINTS = 8;
/** Rules version 3: what a road costs in movement points. */
export const ROAD_COST: Record<RoadType, number> = { major: 1, minor: 2 };
/** Rules version 3: a +1 Moves card adds this many points, one more road of any kind. */
export const MOVES_CARD_POINTS = 2;
/** A member of an army, as far as movement goes. */
export type Member = UnitType | 'general';

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
  /** Soft cap on the nation's units: half the victory points it started with. Musters stop there; events may go past it. */
  unitCap: number;
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
  /** Movement points spent (rules version 3). */
  points: number;
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
  /** Whose die a roll card is placed on. */
  role: BattleRole;
  /** Index of the die (the unit it was rolled for) on that side. */
  die: number;
}

/** A roll card on a die, with its type. */
export interface PlacedCard extends CardPlacement {
  type: GeneralCardType;
}

/**
 * What a side does before the dice are rolled: fight on, play Retreat or Block Retreat, or flee
 * in panic. 'hidden' only appears in views, for an enemy choice that is not revealed yet.
 */
export type BattleChoice = 'fight' | 'block' | 'retreat' | 'panic';

/**
 * Who faces whom in a battle round: indexes in `units.attacker` and `units.defender` (and in the
 * dice). One side has exactly one unit; the other has one or more, fighting it together.
 */
export interface Matchup {
  attacker: number[];
  defender: number[];
}

/** A matchup scored: a group's best total counts against the lone unit it faces. */
export interface Duel {
  matchup: Matchup;
  /** The attacking unit whose total counts (the best of a group), an index in `units.attacker`. */
  attacker: number;
  /** The defending unit whose total counts, an index in `units.defender`. */
  defender: number;
  attackerPoints: number;
  defenderPoints: number;
  /** Unit-type bonuses included in the points above. */
  attackerBonus: number;
  defenderBonus: number;
  winner: BattleRole;
  /** The losing unit, destroyed. */
  destroyed: string;
}

/** A finished round, kept for the battle popup. */
export interface BattleRound {
  round: number;
  units: Record<BattleRole, string[]>;
  types: Record<BattleRole, UnitType[]>;
  matchups: Matchup[];
  choices: Record<BattleRole, BattleChoice>;
  /** Null when the battle ended before the roll (a retreat or panic went through). */
  dice: Record<BattleRole, number[]> | null;
  cards: Record<BattleRole, PlacedCard[]>;
  duels: Duel[];
}

/**
 * A battle round: 'select' (the host picks the fighting units and who faces whom at random) →
 * 'choose' (each side secretly decides to fight, retreat, block or panic) → 'roll' → 'cards'
 * (both see every die and may put roll cards on them) → resolve → next round. 'retreat' while an
 * army falls back.
 */
export type BattleStep = 'select' | 'choose' | 'roll' | 'cards' | 'retreat';

/** One side of a battle report. */
export interface BattleSideReport {
  nation: NationId;
  army: string;
  /** Every unit the army had when the battle began. */
  units: UnitType[];
  generals: number;
  /** Units destroyed in the battle (all of them when the army was destroyed). */
  lost: UnitType[];
  /** How the side left the battle. */
  fate: 'held' | 'retreated' | 'destroyed';
}

/** The outcome of a finished battle, for the Battle over popup. */
export interface BattleReport {
  id: string;
  node: NodeId;
  rounds: number;
  attacker: BattleSideReport;
  defender: BattleSideReport;
  /** Null when neither side kept the field (both retreated or both were destroyed). */
  winner: BattleRole | null;
  /** The last round fought, for the players who fought it (left out of everyone else's view). */
  finalRound?: BattleRound | null;
}

export interface Battle {
  /** Unique within the game: turn and armies. */
  id: string;
  /** Where the defender stood when the battle began. */
  node: NodeId;
  attackerArmy: string;
  defenderArmy: string;
  /** Each side as it entered the battle. */
  start: Record<BattleRole, { nation: NationId; units: UnitType[]; generals: number }>;
  /** Teams fighting in the battle. */
  involved: Team[];
  /** Teams that could see the battle's nodes when it began (the fighting teams included). Everyone else never learns of it. */
  witnesses: Team[];
  /** Sides that got away. */
  retreated: BattleRole[];
  step: BattleStep;
  round: number;
  /** The combat units fighting this round, picked at random. */
  units: Record<BattleRole, string[]>;
  /** Who faces whom this round. */
  matchups: Matchup[];
  choice: Record<BattleRole, BattleChoice | 'hidden' | null>;
  /** One die per fighting unit, in the order of `units`. */
  dice: Record<BattleRole, number[]> | null;
  /** Roll cards each side put on dice this round; null until it has decided (and, for the enemy, until the reveal). */
  cards: Record<BattleRole, PlacedCard[] | null>;
  lastRound: BattleRound | null;
  /** Sides still to fall back, processed front to back. */
  retreats: BattleRole[];
  /** Units each side has lost in this battle. */
  lost: Record<BattleRole, UnitType[]>;
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
  /** Before the roll: fight on, play Retreat or Block Retreat, or flee in panic. */
  | { nation: NationId; kind: 'battleChoice' }
  /** After the roll: put roll cards on dice (or none). */
  | { nation: NationId; kind: 'battleCards' }
  | { nation: NationId; kind: 'retreat'; army: string }
  | { nation: NationId; kind: 'attrition'; army: string }
  | { nation: NationId; kind: 'sabotage'; options: string[] }
  /** Recruit event: place `remaining` new units (or one general) on one of `options` (own nodes). */
  | { nation: NationId; kind: 'recruit'; what: 'unit' | 'general'; remaining: number; options: NodeId[] };

export type OracleRequest =
  | { kind: 'shuffle'; deck: 'general' | 'event'; n: number }
  | { kind: 'roll'; attacker: number; defender: number }
  /**
   * Pick `attackerPick` of the attacker's `attacker` combat units, `defenderPick` of the defender's,
   * and who faces whom (see randomTargets): with `groups` (rules version 3), every picked unit fights.
   */
  | { kind: 'select'; attacker: number; attackerPick: number; defender: number; defenderPick: number; groups?: boolean }
  /** Two enemy armies stand next to each other: pick which one attacks (index into `armies`). */
  | { kind: 'engage'; armies: [string, string] };

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
  /** The current nation has used its muster this turn (one unit in a town worth more than 5 VP). */
  mustered: boolean;
  /** Winning team: a side, or a nation id in a free-for-all game. */
  winner: Team | null;
  nextId: number;
  /** Human readable history for the UI log. `side` limits who may see an entry. */
  history: HistoryEntry[];
}

export type HistoryKind = 'turn' | 'order' | 'card' | 'battle' | 'event' | 'control' | 'attrition' | 'result';

export interface Rules {
  /**
   * Version of the rules the game is played by (see RULES_VERSION). Saves keep the version they
   * were started with, so they replay the same way after the rules change.
   */
  version: number;
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
  /** Only these teams may see the entry (battles are hidden from those who could not see them). */
  teams?: Team[];
  /** Only these nations may see the entry (how a battle is fought is for the two sides fighting it). */
  nations?: NationId[];
  /** A finished battle's outcome. */
  report?: BattleReport;
}
