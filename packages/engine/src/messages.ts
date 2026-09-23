/**
 * English templates for everything the engine says: log entries and errors.
 * Log entries carry a message key and parameters, so the client can show them in the player's
 * language; errors use their English template as the key. `{name}` placeholders are filled in by
 * `formatMessage`; parameters named like nations or nodes are shown as those names.
 */
export const MESSAGES = {
  'log.roundBegins': 'Round {round} begins',
  'log.turnBegins': "{nation}'s turn begins",
  'log.moved': '{nation} army {army} moved {fromNode} → {toNode}',
  'log.engages': '{nation} army {army} engages the enemy from {node}',
  'log.split': '{nation} army {army} split off {newArmy}',
  'log.merged': '{nation} army {otherArmy} merged into {army}',
  'log.reorganized': '{nation} reorganizes its armies at {node}',
  'log.destroyed': '{nation} army {army} destroyed ({reason})',
  'log.takesControl': '{nation} takes control of {node}',
  'log.liberates': '{nation} frees {node} from occupation',
  'log.knockedOut': '{nation} is knocked out of the war',
  'log.winner': 'The {side} win the war',
  'log.winnerNation': '{nation} wins the war',
  'log.landPartitioned': '{nation} takes over {count} town(s) of the defeated {defeatedNation}',
  'log.battle': 'Battle at {node}: {nation} ({army}) attacks {defNation} ({defArmy})',
  'log.dice': 'Dice — attacker: {attackerDice}; defender: {defenderDice}',
  'log.round': 'Round {battleRound}: {results}',
  'log.roundResult': '{attackerPoints} vs {defenderPoints} → {role}',
  'log.retreats': '{nation} retreats',
  'log.retreatBlocked': "{nation}'s retreat is blocked: it flees in panic",
  'log.panic': '{nation} army {army} panics and flees instead of fighting',
  'log.panicLosses': '{army} loses {count} unit(s) in the rout',
  'log.retreatedTo': '{army} retreats to {node}',
  'log.retreatedToLost': '{army} retreats to {node}, leaving {lost} unit(s) behind',
  'log.playsMoves': '{nation} plays +1 Moves on {army}',
  'log.attrition': '{army} loses a unit to attrition (out of supply)',
  'log.event': '{nation} draws event: {event}',
  'log.sabotage': 'Sabotage destroys a supply unit of {army}',
  'log.recruitUnit': '{nation} recruits a unit of {unit} at {node}',
  'log.recruitGeneral': '{nation} appoints a new general at {node}',
  'log.recruitNowhere': '{nation} has no free town of its own to recruit in',
  'log.endGameDeferred': 'The war goes on: the End Game card goes to the bottom of the event deck (it can end the war from round {round})',
  'reason.noCombatUnits': 'no combat units left',
  'reason.noRoute': 'no route to retreat',
  'reason.destroyedRetreating': 'destroyed while retreating',
  'reason.couldNotRetreat': 'could not retreat',
  'reason.attrition': 'attrition',
  'reason.sabotaged': 'sabotaged',
  'unit.cavalry': 'cavalry',
  'unit.infantry': 'infantry',
  'unit.artillery': 'artillery',
  'unit.supply': 'supply',
  'side.attacker': 'attackers',
  'side.defender': 'defenders',
  'role.attacker': 'attacker',
  'role.defender': 'defender',
  'event.recruit1': 'Recruit 1 Unit',
  'event.recruit2': 'Recruit 2 Units',
  'event.recruitGeneral': 'Recruit General',
  'event.endGame': 'End Game',
  'event.exhaustion1': '+1 War Exhaustion',
  'event.exhaustion2': '+2 War Exhaustion',
  'event.exhaustion5': '+5 War Exhaustion',
  'event.spies': 'Spies Successful',
  'event.enemySpies': 'Enemy Spying Successful',
  'event.sabotage': 'Sabotage Successful',
  'event.sabotaged': 'Sabotaged',
  'event.nothing': 'Nothing',
} as const;

export type MessageKey = keyof typeof MESSAGES;
export type MessageParams = Record<string, string | number>;

/** How a parameter should be shown: as a nation name, a node name, or a translated key. */
export function paramKind(name: string): 'nation' | 'node' | 'key' | 'plain' {
  if (name === 'nation' || name.endsWith('Nation')) return 'nation';
  if (name === 'node' || name.endsWith('Node')) return 'node';
  if (name === 'reason' || name === 'event' || name === 'side' || name === 'role' || name === 'unit') return 'key';
  return 'plain';
}

/**
 * Fills a template. `name` resolves parameters by kind (the engine uses English names; the client
 * passes translated ones); `lookup` resolves nested message keys (reasons, events, sides).
 */
export function formatMessage(
  template: string,
  params: MessageParams,
  name: (kind: 'nation' | 'node', id: string) => string,
  lookup: (key: string) => string = (k) => (MESSAGES as Record<string, string>)[k] ?? k,
): string {
  return template.replace(/\{(\w+)\}/g, (whole, p: string) => {
    if (!(p in params)) return whole;
    const v = params[p];
    const kind = paramKind(p);
    if (kind === 'nation' || kind === 'node') return name(kind, String(v));
    if (kind === 'key') return lookup(String(v));
    if (p === 'results') {
      // "12:9:attacker|3:4:defender" → one "12 vs 9 → attacker" per comparison.
      return String(v).split('|').filter(Boolean).map((r) => {
        const [a, d, role] = r.split(':');
        return formatMessage(lookup('log.roundResult'), { attackerPoints: a, defenderPoints: d, role: `role.${role}` }, name, lookup);
      }).join('; ');
    }
    return String(v);
  });
}
