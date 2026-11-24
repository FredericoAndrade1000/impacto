import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeaponChoice } from '../src/workshop-ux.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();
function fixture({ gun = true } = {}) {
  const editor = new Editor(createStructuredTemplate('truck')), view = { mode: 'edit', buildTool: 'select' }, notices = [], listeners = new Map(),
    buttons = Array.from({ length: 2 }, () => ({ listeners: [], addEventListener(_, listener) { this.listeners.push(listener); }, click() { for (const listener of this.listeners) listener(); this.onclick?.(); } })),
    dialog = { dataset: {}, returnValue: '', addEventListener(type, listener) { listeners.set(type, listener); } };
  let opened = 0;
  buttons[0].onclick = () => { opened++; dialog.open = true; delete dialog.dataset.family; };
  const weapon = gun ? editor.addModule('weapon', { x: 12, y: 4.5 }, { weaponPreset: 'fnmag' }) : null;
  const context = { editor, view, renderer: { modulePreview: null }, openTask() {}, arsenal: buttons[0], arsenalDialog: dialog,
    refresh() {}, toast: (...args) => notices.push(args) };
  const ux = createWeaponChoice({ ...context, testArsenal: buttons[1] });

  const close = value => { dialog.open = false; dialog.returnValue = value; listeners.get('close')(); };
  return { editor, view, dialog, notices, weapon, ...context, ux, choose: ux.beginWeaponChoice, close, opened: () => opened, open: () => buttons[0].click() };
}

test('an open replacement choice replaces once and undoes once', () => {
  const f = fixture(), before = structuredClone(f.editor.source), count = f.editor.source.components.length, history = f.editor.past.length;
  f.choose('replace', f.weapon.id); assert.equal(f.dialog.dataset.currentPreset, 'fnmag');
  assert.equal(f.ux.replaceWeapon('minimi'), true);
  assert.equal(f.editor.source.components.length, count);
  assert.equal(f.editor.source.components.find(part => part.id === f.weapon.id).weaponPreset, 'minimi');
  assert.equal(f.editor.past.length, history + 1); assert.equal(f.dialog.dataset.swap, undefined);
  f.editor.undo(); assert.deepEqual(f.editor.source, before);
  assert.equal(f.ux.replaceWeapon('m2hb'), false);
});

test('entering a trial cancels replacement and mounting intent without reopening the arsenal', () => {
  for (const kind of ['replace', 'mount']) {
    const f = fixture(), before = structuredClone(f.editor.source), history = f.editor.past.length;
    f.choose(kind, kind === 'replace' ? f.weapon.id : 'hull:roof');
    f.ux.clearWeaponChoice(); f.view.mode = 'test'; f.close('test');
    f.open(); f.close(''); f.view.mode = 'edit';
    assert.equal(f.ux.replaceWeapon('minimi'), false); assert.equal(f.dialog.open, false);
    assert.equal(f.dialog.dataset.swap, undefined); assert.equal(f.dialog.dataset.mount, undefined);
    assert.deepEqual(f.editor.source, before); assert.equal(f.editor.past.length, history);
    assert.equal(f.opened(), 2, 'only the explicit visits open the catalogue');
  }
});

test('closing the catalogue cancels its edit intention without changing the project', () => {
  const f = fixture(), before = structuredClone(f.editor.source), history = f.editor.past.length;
  f.choose('replace', f.weapon.id); f.close('');
  assert.equal(f.ux.replaceWeapon('minimi'), false);
  assert.equal(f.dialog.dataset.swap, undefined); assert.equal(f.dialog.dataset.currentPreset, undefined);
  assert.deepEqual(f.editor.source, before); assert.equal(f.editor.past.length, history);
});

test('a refused replacement retains its target inside the open dialogue for another model', () => {
  const f = fixture(), before = structuredClone(f.editor.source), history = f.editor.past.length;
  f.editor.addModule('fuel', {x: 11, y: 4.5}, {sizeScale:.5});
  const blocked = structuredClone(f.editor.source), count = f.editor.past.length;
  f.choose('replace', f.weapon.id);
  assert.throws(() => f.ux.replaceWeapon('rh120'), /culatra|montagem|chapa|suporte|arma|peso|mesmo espaço/i);
  assert.deepEqual(f.editor.source, blocked); assert.equal(f.editor.past.length, count); assert.equal(f.dialog.dataset.swap, 'true');
  assert.equal(f.ux.replaceWeapon('minimi'), true);
  assert.equal(f.editor.source.components.filter(part => part.kind === 'weapon').length, 1);
});

test('a new document with the same component IDs cannot receive a stale replacement', () => {
  const f = fixture(); f.choose('replace', f.weapon.id);
  f.editor.replace({ ...structuredClone(f.editor.source), name: 'Outro projeto' });
  const before = structuredClone(f.editor.source), history = f.editor.past.length;
  assert.throws(() => f.ux.replaceWeapon('minimi'), /não está mais neste projeto/);
  assert.deepEqual(f.editor.source, before); assert.equal(f.editor.past.length, history); assert.equal(f.dialog.dataset.swap, undefined);
});

test('opening the arsenal after changing documents clears old intent before presenting the actions', () => {
  const f = fixture(); f.choose('replace', f.weapon.id);
  f.editor.replace({ ...structuredClone(f.editor.source), name: 'Outro projeto' }); f.open();
  assert.equal(f.dialog.dataset.swap, undefined); assert.equal(f.ux.replaceWeapon('minimi'), false);
});

test('choosing a weapon from a plate starts explicit cursor placement without changing the project', () => {
  const f = fixture({ gun: false }), before = structuredClone(f.editor.source), history = f.editor.past.length;
  f.choose('mount', 'hull:roof');
  assert.equal(f.ux.replaceWeapon('minimi'), true);
  assert.deepEqual(f.editor.source, before); assert.equal(f.editor.past.length, history);
  assert.equal(f.view.buildTool, 'module'); assert.equal(f.view.placement.kind, 'weapon');
  assert.equal(f.view.placement.weaponPreset, 'minimi'); assert.equal(f.dialog.dataset.mount, undefined);
  // The weapon starts out square to the plate; which plate it fires through or stands on is the core's to find.
  assert.equal(Object.hasOwn(f.view.placement, 'hostId'), false); assert(Math.abs(f.view.placement.angle - Math.PI / 2) < 1e-10);
});
