/**
 * Settings from the environment: CABINET_WARS_<NAME>, or KRIEG_<NAME> as the game was called
 * while it was being made.
 */
export function env(name: string): string | undefined {
  return process.env[`CABINET_WARS_${name}`] ?? process.env[`KRIEG_${name}`];
}
