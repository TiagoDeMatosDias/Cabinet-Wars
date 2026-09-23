import type { Card, GeneralCardType } from '@krieg/engine';
import { h } from './dom';
import { emblemEl, type Emblem } from './emblem';
import { iconEl, iconPath } from './icons';
import { cardEffect, cardHow, cardName, cardSymbolValue } from './labels';
import { t } from '../i18n/i18n';

export interface CardOptions {
  /** Owner's nation color: the card frame. */
  color: string;
  playable: boolean;
  /** Short hint under the name ("playable now", "battle card"). */
  hint: string;
  /** Replaces the "how to play" line when the card isn't playable now. */
  when?: string;
  selected?: boolean;
  small?: boolean;
  /** Position in a fanned hand. */
  index?: number;
  draggable?: boolean;
  onclick?: () => void;
}

/** A card from a hand: a frame in the owner's color, a big symbol, a corner index and a tooltip. */
export function cardEl(card: Card<GeneralCardType>, o: CardOptions): HTMLElement {
  const sym = cardSymbolValue(card.type);
  const isIcon = iconPath(sym) !== null;
  const name = cardName(card.type);
  const el = h('button', {
    class: `kcard ${o.playable ? '' : 'disabled'} ${o.selected ? 'selected' : ''} ${o.small ? 'small' : ''}`,
    style: `--frame:${o.color};--i:${o.index ?? 2}`,
    type: 'button',
    draggable: o.draggable ? 'true' : undefined,
    'aria-label': `${name}: ${cardEffect(card.type)}`,
    'data-card': card.id,
    'data-type': card.type,
    onclick: o.onclick,
  },
  h('span', { class: 'kcard-index' }, iconEl(sym, 14)),
  h('span', { class: `kcard-symbol ${isIcon ? 'is-icon' : ''} ${!isIcon && sym.length > 2 ? 'long' : ''}` }, iconEl(sym, o.small ? 30 : 48)),
  h('span', { class: 'kcard-name' }, name),
  o.small ? null : h('span', { class: 'kcard-hint' }, o.hint),
  h('span', { class: 'tooltip', role: 'tooltip' },
    h('strong', {}, name),
    h('span', {}, cardEffect(card.type)),
    h('span', { class: 'tooltip-how' }, o.playable ? cardHow(card.type) : (o.when ?? cardHow(card.type)))));
  if (o.draggable) {
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer?.setData('application/x-krieg-card', JSON.stringify({ id: card.id, type: card.type }));
      e.dataTransfer!.effectAllowed = 'move';
      el.classList.add('dragging');
    });
    el.addEventListener('dragend', () => el.classList.remove('dragging'));
  }
  return el;
}

/** A face-down card: the owner's color with the theme's card-back motif and their emblem. */
export function cardBackEl(color: string, emblem: Emblem | undefined, small = true): HTMLElement {
  return h('span', { class: `kcard back ${small ? 'small' : ''}`, style: `--frame:${color}`, title: t('card.faceDown') },
    h('span', { class: 'kcard-back-motif' }, emblemEl(emblem, small ? 22 : 34)));
}
