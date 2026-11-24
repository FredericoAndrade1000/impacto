import { clamp, segmentInBox } from './math.ts';
import type { Point } from './math.ts';
import type { Deposit } from './deposits.ts';

export type DepositLabelData = Pick<Deposit, 'id'> & {
  text: string; detail?: string | null | undefined; shortText?: string | null | undefined;
  shortDetail?: string | null | undefined; priority?: number | undefined;
};
export interface DepositLabelItem {
  deposit: DepositLabelData; at: Point; width: number; shortWidth: number;
  action?: { width: number; height: number } | null | undefined;
}
interface LabelBox { left: number; right: number; top: number; bottom: number }
type LabelLane = 0 | 1;
interface VisibleDepositLabel {
  mode: 'full' | 'compact'; lane: LabelLane; x: number; lift: number; text: string; detail: string | null | undefined;
  action: Point | null; box: LabelBox; link?: boolean;
}
interface HiddenDepositLabel {
  mode: 'hidden'; lane: 0; x: 0; lift: 0; text: ''; detail: ''; action: null; box?: never; link?: never;
}
export type DepositLabelPlacement = VisibleDepositLabel | HiddenDepositLabel;

// Screen-space bounds include the 3px text outline. Only two nearby rows are used;
// a crowded label may disappear, but its deposit marker stays at the real position.
// A deposit with a button over its words (`item.action`, its width and height) has the room of it
// too: the button stands `RAISE` pixels over the words and goes with them, or is not shown.
const GAP = 6, EDGE = 8, ROW = 40, RAISE = 4;
const overlaps = (a: LabelBox, b: LabelBox): boolean => a.left < b.right + GAP && a.right + GAP > b.left && a.top < b.bottom + GAP && a.bottom + GAP > b.top;

export function depositLabelLayout(items: readonly DepositLabelItem[], width: number, height: number): Map<string, DepositLabelPlacement> {
  const candidate = (item: DepositLabelItem, compact: boolean, lane: LabelLane): VisibleDepositLabel | null => {
    const text = compact ? item.deposit.shortText ?? item.deposit.text : item.deposit.text,
      detail = compact ? item.deposit.shortDetail ?? item.deposit.detail : item.deposit.detail,
      action = item.action, wide = Math.max((compact ? item.shortWidth : item.width) + 8, action?.width ?? 0), lift = lane * ROW,
      x = clamp(item.at.x, EDGE + wide / 2, width - EDGE - wide / 2),
      words = item.at.y - (detail ? 44 : 28) - lift, top = words - (action ? action.height + RAISE : 0), bottom = item.at.y - 10 - lift;
    if (wide > width - 2 * EDGE || top < EDGE || bottom > height - EDGE) return null;
    // The button's place is the middle of its foot, from the deposit.
    return { mode: compact ? 'compact' : 'full', lane, x: x - item.at.x, lift, text, detail,
      action: action ? { x: x - item.at.x, y: words - RAISE - item.at.y } : null, box: { left: x - wide / 2, right: x + wide / 2, top, bottom } };
  };
  const full = items.map(item => candidate(item, false, 0)), crowded = new Set<DepositLabelItem>(), placed: LabelBox[] = [], result = new Map<string, DepositLabelPlacement>();
  for (let i = 0; i < items.length; i++) for (let j = i + 1; j < items.length; j++) {
    const first = full[i], second = full[j];
    if (first && second && overlaps(first.box, second.box)) {
      const a = items[i], b = items[j];
      if (!a || !b) throw new TypeError('Deposit label input has a missing item.');
      crowded.add(a); crowded.add(b);
    }
  }
  // Priority never depends on a changing screen coordinate, so a pan cannot swap two labels.
  for (const item of [...items].sort((a, b) => (b.deposit.priority ?? 0) - (a.deposit.priority ?? 0) || a.deposit.id.localeCompare(b.deposit.id))) {
    let chosen: VisibleDepositLabel | null = null;
    for (const compact of crowded.has(item) ? [true] : [false, true]) {
      for (const lane of [0, 1] satisfies LabelLane[]) {
        const next = candidate(item, compact, lane);
        if (next && !placed.some(box => overlaps(next.box, box))) { chosen = next; break; }
      }
      if (chosen) break;
    }
    if (chosen) placed.push(chosen.box);
    result.set(item.deposit.id, chosen ?? { mode: 'hidden', lane: 0, x: 0, lift: 0, text: '', detail: '', action: null });
  }
  // A guide must stay short and never strike through another label.
  for (const item of items) {
    const label = result.get(item.deposit.id);
    if (!label) throw new Error('Missing deposit label placement.');
    if (label.mode === 'hidden') continue;
    const from = { x: item.at.x, y: item.at.y - 9 }, to = { x: item.at.x + label.x, y: item.at.y - 10 - label.lift };
    label.link = Boolean(label.lift || Math.abs(label.x) > 1) && Math.hypot(label.x, label.lift + 1) <= 72 &&
      !placed.some(box => box !== label.box && segmentInBox(
        { x: from.x - box.left, y: from.y - box.top }, { x: to.x - box.left, y: to.y - box.top }, box.right - box.left, box.bottom - box.top));
  }
  return result;
}
