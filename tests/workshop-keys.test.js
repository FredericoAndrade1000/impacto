import test from 'node:test';
import assert from 'node:assert/strict';
import { installPageKeys, installSettingsKeys } from '../src/workshop-keys.ts';
import { cancels, removes, partKeys } from '../src/workshop-keys.ts';
import { PART_CATEGORIES } from '../src/workshop-context.ts';

const press = (key, extra = {}) => ({ key, target: { tagName: 'CANVAS', matches: () => false, closest: () => null }, ...extra });
const typed = { tagName: 'INPUT', matches: () => true, closest: () => null };

test('C cancels and X removes in the workshop beside Esc and Delete, never with a modifier or typed into a field', () => {
  for (const key of ['Escape', 'c', 'C']) assert.equal(cancels(press(key)), true, key);
  assert.equal(cancels(press('Escape'), false), true, 'Esc cancels anywhere');
  assert.equal(cancels(press('c'), false), false, 'on the field C is taking a vehicle in hand');
  for (const key of ['Delete', 'Backspace', 'x', 'X']) assert.equal(removes(press(key)), true, key);
  for (const extra of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { target: typed }]) {
    assert.equal(cancels(press('c', extra)), false); assert.equal(removes(press('x', extra)), false);
  }
  assert.equal(cancels(press('Escape', { target: typed })), true, 'Esc still leaves a field');
  assert.equal(cancels(press('x')), false); assert.equal(removes(press('c')), false);
});

test('each category numbers its own parts from one, in the order they are shown, the Arsenal among the combat parts', () => {
  const kinds = ['engine', 'fuel', 'ammo', 'command', 'sensor', 'excavator', 'drill', 'builder', 'hopper', 'cistern', 'supply', 'weapon'];
  assert.deepEqual(partKeys(kinds), [1, 2, 1, 3, 4, 1, 2, 3, 4, 5, 6, 2]);
  for (const category of PART_CATEGORIES) {
    const numbers = partKeys(kinds).filter((_, index) => category.kinds.includes(kinds[index]));
    assert.deepEqual(numbers, numbers.map((_, index) => index + 1), category.label + ' has no gaps');
    assert(numbers.length <= 9, category.label + ' fits the number keys');
  }
});

// The production handlers of main.ts, with only what they reach supplied.
function keyboard({ mode = 'edit', sidebar = true, trial = null, slowed = false } = {}) {
  const calls = [], listeners = new Map(),
    view = { mode, trial, buildTool: 'module' }, editor = { selection: 'gun' }, session = { slowed },
    context = { cancels, removes, view, editor, placing: () => null,
      quicken: () => { if (!session.slowed) return false; session.slowed = false; calls.push('quicken'); return true; },
      $: selector => { if (selector === '.sidebar') return { hidden: sidebar }; throw new Error('missing UI ' + selector); }, $$: () => [],
      workspace: { onClose: () => calls.push('close') }, workshopUX: { remove: () => calls.push('remove'), selectAll() {} },
      input: { gesture: null, driveKeys: new Set(), lookKeys: new Set(), lookReleased: new Set() },
      stopControls: () => calls.push('stop'), clearGesture: () => calls.push('gesture'), renderer: { modulePreview: {} },
      setTool: tool => calls.push('tool:' + tool), requestUI() {}, showHelp() {}, fitCurrent() {}, syncTrigger() {}, syncDrive() {}, explainSilence() {},
      document: { addEventListener: (type, listener) => listeners.set(type, listener) } };
  installPageKeys({ ...context, effects: { ...context, get: context.$, all: context.$$ } });
  const key = (value, extra) => { calls.length = 0; editor.selection = 'gun'; listeners.get('keydown')(press(value, { preventDefault() {}, ...extra })); return [...calls]; };
  return { key, editor, view, session };
}

test('in the workshop X removes the selection and C cancels as Esc does: the installation, the gesture and the selection', () => {
  const f = keyboard();
  for (const value of ['x', 'X', 'Delete']) assert.deepEqual(f.key(value), ['remove'], value);
  for (const value of ['c', 'Escape']) {
    assert.deepEqual(f.key(value), ['stop', 'gesture', 'tool:select'], value); assert.equal(f.editor.selection, null);
  }
  f.view.buildTool = 'select';
  for (const value of ['c', 'Escape']) {
    assert.deepEqual(f.key(value), ['stop', 'gesture'], 'with nothing being installed no tool is chosen, so no empty panel opens'); assert.equal(f.editor.selection, null);
  }
  assert.deepEqual(f.key('x', { ctrlKey: true }), [], 'Ctrl+X is not a removal');
  assert.deepEqual(f.key('c', { ctrlKey: true }), [], 'Ctrl+C is not a cancel');
  assert.deepEqual(f.key('x', { target: typed }), []); assert.deepEqual(f.key('c', { target: typed }), []);
});

test('with a workshop panel open C closes it as Esc does, and X does nothing behind it', () => {
  const f = keyboard({ sidebar: false });
  assert.deepEqual(f.key('c'), ['close']); assert.deepEqual(f.key('Escape'), ['close']); assert.deepEqual(f.key('x'), []);
  const field = keyboard({ mode: 'test', sidebar: false });
  assert.deepEqual(field.key('c'), [], 'a field panel closes by Esc alone'); assert.deepEqual(field.key('Escape'), ['close']);
});

test('on the field neither C nor X reach the workshop: they are the squad keys there', () => {
  const f = keyboard({ mode: 'test' });
  assert.deepEqual(f.key('x'), []); assert.deepEqual(f.key('Delete'), []);
  assert.deepEqual(f.key('c'), []); assert.equal(f.editor.selection, 'gun');
});

test('Esc gives a slowed test of armour its pace back, and A, D and S drive nothing there', () => {
  const f = keyboard({ mode: 'test', trial: 'armour', slowed: true });
  assert.deepEqual(f.key('Escape'), ['quicken', 'stop', 'gesture', 'tool:select']); assert.equal(f.session.slowed, false);
  assert.deepEqual(f.key('Escape'), ['stop', 'gesture', 'tool:select'], 'once the pace is back Esc only cancels');
  for (const value of ['a', 'd', 's']) assert.deepEqual(f.key(value), [], value);
});

test('in the workshop C puts the open settings away before anything else hears it, as Esc does', () => {
  let listener, closed = 0;
  const view = { mode: 'edit' }, context = { cancels, view, settingsPanel: () => closed++,
    $: selector => selector === '#settings-panel' ? { hidden: false } : { focus() {} },
    document: { addEventListener: (type, handler) => { if (type === 'keydown') listener = handler; } } };
  installSettingsKeys({ ...context, get: context.$ });
  const key = value => { let stopped = false; listener(press(value, { preventDefault() {}, stopPropagation() { stopped = true; } })); return stopped; };
  assert.equal(key('c'), true); assert.equal(key('Escape'), true); assert.equal(closed, 2);
  view.mode = 'test';
  assert.equal(key('c'), false); assert.equal(key('Escape'), true); assert.equal(closed, 3);
});
