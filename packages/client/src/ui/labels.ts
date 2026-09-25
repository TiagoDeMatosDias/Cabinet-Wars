import type { GameView, GeneralCardType, Unit, UnitType } from '@cabinet-wars/engine';
import { currentTheme } from '../theme/theme';
import { nationText, nodeText, t } from '../i18n/i18n';
import { h } from './dom';
import { iconEl } from './icons';

export function cardName(type: GeneralCardType): string {
  return t(`card.${type}`);
}

export function cardEffect(type: GeneralCardType): string {
  return t(`cardEffect.${type}`);
}

export function cardHow(type: GeneralCardType): string {
  return type === 'moves+1' ? t('cardHow.moves+1') : t('cardHow.battle');
}

export function unitName(type: UnitType): string {
  return t(`unit.${type}`);
}

/** The theme's icon value for a unit type ("icon:cavalry", a path, or text). */
export function unitIconValue(type: UnitType): string {
  return currentTheme().icons.unit[type];
}

export function unitIcon(type: UnitType, size = 18): HTMLElement {
  return iconEl(unitIconValue(type), size, unitName(type));
}

export function cardSymbolValue(type: GeneralCardType): string {
  return (currentTheme().icons.card as Record<string, string>)[type] ?? cardName(type);
}

export function themeIcon(value: string, size = 18, title?: string): HTMLElement {
  return iconEl(value, size, title);
}

/** "Cavalry 1": plain text, for select lists and titles. */
export function unitLabel(u: Unit): string {
  const n = Number(u.id.split('.').pop()!.replace(/\D/g, '')) + 1;
  return t('unit.label', { unit: unitName(u.type), n });
}

/** Unit name with its icon, for rich places. */
export function unitLabelEl(u: Unit): HTMLElement {
  return h('span', { class: 'unit-label' }, unitIcon(u.type, 16), unitLabel(u));
}

export function nationName(_view: GameView | null, id: string) {
  return nationText(id);
}

export function nationColor(view: GameView, id: string) {
  return view.nations.find((n) => n.id === id)?.color ?? '#888888';
}

export function nodeName(_view: GameView | null, id: string) {
  return nodeText(id);
}

/** "2 [cavalry] 4 [infantry]": counts with unit icons. */
export function unitSummary(units: Unit[]): HTMLElement {
  const counts = new Map<UnitType, number>();
  for (const u of units) counts.set(u.type, (counts.get(u.type) ?? 0) + 1);
  return h('span', { class: 'unit-summary' }, [...counts].map(([type, c]) => h('span', { class: 'unit-count-chip' }, String(c), unitIcon(type, 15))));
}
