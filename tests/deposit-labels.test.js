import test from 'node:test';
import assert from 'node:assert/strict';
import { depositLabelLayout } from '../src/deposit-labels.ts';

const item = (id, x, y = 200, patch = {}) => {
  const deposit = { id, text: 'Sílica · reserva 62 t', detail: '0 kg prontos', shortText: 'Sílica · 62 t', shortDetail: '', priority: 0, ...patch };
  return { deposit, at: { x, y }, width: Math.max(deposit.text.length, deposit.detail.length) * 7,
    shortWidth: Math.max(deposit.shortText.length, deposit.shortDetail.length) * 7 };
};
const visible = layout => [...layout.values()].filter(label => label.mode !== 'hidden');
function readable(layout, width = 667, height = 375) {
  const labels = visible(layout);
  for (const label of labels) {
    assert(label.box.left >= 8 && label.box.right <= width - 8 && label.box.top >= 8 && label.box.bottom <= height - 8);
    assert(label.lane === 0 || label.lane === 1);
  }
  for (let i = 0; i < labels.length; i++) for (let j = i + 1; j < labels.length; j++) {
    const a = labels[i].box, b = labels[j].box;
    assert(a.right + 6 <= b.left || b.right + 6 <= a.left || a.bottom + 6 <= b.top || b.bottom + 6 <= a.top);
  }
}

test('spaced deposits retain full reserve and ready stock, while nearby labels use shorter words without the empty stock', () => {
  const wide = depositLabelLayout([item('a', 160), item('b', 500)], 667, 375);
  assert(visible(wide).every(label => label.mode === 'full' && label.detail === '0 kg prontos')); readable(wide);
  const close = depositLabelLayout([item('a', 285), item('b', 385)], 667, 375);
  assert(visible(close).every(label => label.mode === 'compact' && label.text === 'Sílica · 62 t' && !label.detail));
  assert.equal(visible(close).length, 2); readable(close);
});

test('dense labels use at most two rows, retain ready material and favour the deposit currently being worked', () => {
  const items = Array.from({ length: 30 }, (_, i) => item('site-' + String(i).padStart(2, '0'), 330 + i / 10)),
    worked = items.at(-1); Object.assign(worked.deposit, { priority: 2, shortDetail: '500 kg prontos' }); worked.shortWidth = 100;
  const layout = depositLabelLayout(items, 667, 375);
  assert.equal(layout.size, 30, 'every deposit keeps a placement entry even when its words cannot fit');
  assert(visible(layout).length < 30 && visible(layout).length >= 2); readable(layout);
  assert.equal(layout.get(worked.deposit.id).lane, 0); assert.equal(layout.get(worked.deposit.id).detail, '500 kg prontos');
  assert.equal(layout.get(worked.deposit.id).mode, 'compact');
});

test('hills, phone edges and source order cannot introduce label collisions or move the deposit itself', () => {
  const items = [item('a', -15, 130), item('b', 15, 160), item('c', 335, 115), item('d', 380, 145), item('e', 650, 350), item('f', 680, 330)],
    before = structuredClone(items), layout = depositLabelLayout(items, 667, 375), reversed = depositLabelLayout([...items].reverse(), 667, 375);
  readable(layout); assert.deepEqual(items, before);
  for (const entry of layout) assert.deepEqual(reversed.get(entry[0]), entry[1], 'ID priority remains stable as the camera changes relative x order');
  const top = depositLabelLayout([item('top', 100, 20)], 667, 375);
  assert.equal(top.get('top').mode, 'hidden', 'a marker near the top keeps its position without a clipped text');
});

test('connecting guides never cross another label or stretch across a phone edge', () => {
  const stacked = depositLabelLayout([item('a', 330), item('b', 331)], 667, 375);
  assert.equal(stacked.get('b').lane, 1); assert.equal(stacked.get('b').link, false, 'the upper guide would strike through the lower text');
  const aside = depositLabelLayout([item('a', 300), item('b', 385)], 667, 375);
  assert.equal(aside.get('b').lane, 1); assert.equal(aside.get('b').link, true, 'a short clear guide still associates a lifted label');
  const edge = depositLabelLayout([item('edge', -35)], 667, 375);
  assert.equal(edge.get('edge').mode, 'full'); assert.equal(edge.get('edge').link, false, 'a long horizontal leader would add clutter');
});

test('a deposit with a button over its words keeps the room of it, and the button goes with the words', () => {
  const action = { width: 160, height: 28 }, plain = depositLabelLayout([item('a', 300)], 667, 375).get('a'),
    worked = depositLabelLayout([{ ...item('a', 300), action }], 667, 375).get('a');
  assert.equal(plain.action, null);
  assert.deepEqual([worked.mode, worked.box.bottom, worked.box.top, worked.box.right - worked.box.left], ['full', plain.box.bottom, plain.box.top - 28 - 4, 160],
    'as wide as the button where the words are narrower, and as tall as both');
  assert.deepEqual(worked.action, { x: 0, y: plain.box.top - 4 - 200 }, 'the middle of its foot, from the deposit');
  // Two side by side keep apart with their buttons; with no room over the words for one, the words go and so does the button.
  readable(depositLabelLayout([{ ...item('a', 300), action }, { ...item('b', 400), action }], 667, 375));
  assert.deepEqual([depositLabelLayout([{ ...item('top', 300, 60), action }], 667, 375).get('top').mode, depositLabelLayout([item('top', 300, 60)], 667, 375).get('top').mode],
    ['hidden', 'full']);
});
