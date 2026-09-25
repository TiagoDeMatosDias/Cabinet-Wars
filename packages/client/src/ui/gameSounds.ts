import { sideOf, type GameView, type NationId } from '@cabinet-wars/engine';
import { sound, type SoundName } from '../audio/sound';

/** Log entries that make a sound when they happen. */
const ENTRY_SOUNDS: Record<string, SoundName> = {
  'log.moved': 'march',
  'log.recruitUnit': 'recruit',
  'log.muster': 'recruit',
  'log.recruitGeneral': 'recruit',
  'log.playsMoves': 'card',
  'log.event': 'card',
  'log.takesControl': 'march',
};

/**
 * Plays the sounds of what just happened in the game, comparing the view before and after an
 * update: a battle begins, dice are rolled, armies march, units are raised, the war ends.
 */
export function gameSounds(prev: GameView | null, next: GameView | null, mine: NationId[]) {
  if (!prev || !next) return;
  if (next.battle && next.battle.id !== prev.battle?.id) { sound.play('battle'); return; }
  const dice = (v: GameView) => (v.battle?.dice ? `${v.battle.id}:${v.battle.round}:${JSON.stringify(v.battle.dice)}` : '');
  if (dice(next) && dice(next) !== dice(prev)) sound.play('dice');
  if (next.phase === 'gameOver' && prev.phase !== 'gameOver') {
    const won = mine.length === 0 || mine.some((n) => sideOf(next, n) === next.winner);
    sound.play(won ? 'victory' : 'defeat');
    return;
  }
  for (const e of next.history.slice(prev.history.length)) {
    const s = e.msg && ENTRY_SOUNDS[e.msg.key];
    if (s) sound.play(s);
  }
}
