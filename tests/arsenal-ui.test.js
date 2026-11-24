import test from 'node:test';
import assert from 'node:assert/strict';
import { constructionUI, descendants } from './helpers/dom.js';
import { WEAPON_FAMILIES, WEAPON_PRESETS } from '../src/weapons.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';

function fixture(t, options = {}) {
  const notices = [], { ui, nodes } = constructionUI(t, { stopControls() {}, toast: (...args) => notices.push(args), ...options });
  return { ui, nodes, notices, dialog: nodes.get('#arsenal-dialog'), purpose: () => nodes.get('#arsenal-purpose').textContent,
    card: id => nodes.get('#arsenal-grid').children.find(card => card.attributes['data-preset'] === id),
    action(id, kind) { return ui.arsenalActions.find(([, action, preset]) => action === kind && preset === id)?.[0]; } };
}

test('the workshop arsenal only installs: one button a card, named by the action that opened it', async t => {
  const installed = [], f = fixture(t, { onInstall: id => installed.push(id), onTrialWeapon() { assert.fail('the workshop arsenal never tests'); } });
  f.ui.openArsenal();
  for (const card of f.nodes.get('#arsenal-grid').children) assert.equal(descendants(card).filter(node => node.tagName === 'button').length, 1);
  assert(f.ui.arsenalActions.every(([, kind]) => kind === 'install'));
  assert.equal(f.action('fnmag', 'test'), undefined);
  assert.equal(f.action('fnmag', 'install').textContent, 'Instalar');
  assert.equal(f.purpose(), ''); assert.equal(f.nodes.get('#arsenal-purpose').hidden, true);
  f.dialog.dataset.swap = 'true'; f.dialog.dataset.currentPreset = 'fnmag'; f.ui.refreshArsenal();
  assert.equal(f.action('fnmag', 'install').textContent, 'Já instalada'); assert(f.action('fnmag', 'install').disabled);
  assert.equal(f.action('minimi', 'install').textContent, 'Trocar por esta');
  await f.action('minimi', 'install').onclick();
  assert.deepEqual(installed, ['minimi']); assert.equal(f.dialog.returnValue, 'install'); assert.equal(f.dialog.open, false);
  delete f.dialog.dataset.swap; delete f.dialog.dataset.currentPreset; f.dialog.dataset.mount = 'true'; f.ui.openArsenal();
  assert.equal(f.dialog.returnValue, '', 'a later Escape cannot reuse the preceding installation');
  assert.equal(f.action('fnmag', 'install').textContent, 'Instalar nesta chapa');
  assert(!descendants(f.nodes.get('#arsenal-grid')).some(node => node.textContent === 'Testar blindagem'));
});

test('a refused weapon stays in the same modal context and another candidate can be applied', async t => {
  const attempts = [], f = fixture(t, { onInstall(id) { attempts.push(id); if (id === 'm2hb') throw new Error('Não cabe nesta montagem.'); } });
  f.dialog.dataset.swap = 'true'; f.ui.openArsenal();
  await f.action('m2hb', 'install').onclick();
  assert.equal(f.dialog.open, true); assert.equal(f.dialog.dataset.swap, 'true');
  assert.deepEqual(f.notices, [['Não cabe nesta montagem.', true]]);
  assert.equal(f.purpose(), 'Não cabe nesta montagem.'); assert.equal(f.nodes.get('#arsenal-purpose').attributes.role, 'alert');
  assert.equal(f.nodes.get('#arsenal-purpose').hidden, false);
  assert.equal(f.ui.pendingAction, ''); assert.equal(f.action('minimi', 'install').disabled, false);
  await f.action('minimi', 'install').onclick();
  assert.deepEqual(attempts, ['m2hb', 'minimi']); assert.equal(f.dialog.open, false);
});

test('back from the test of armour, the workshop arsenal opens on the family last seen, with nothing marked', async t => {
  let trial = 'fnmag';
  const f = fixture(t, { getTrialWeapon: () => trial, onTrialWeapon(id) { trial = id; } });
  f.ui.openArsenal(); f.ui.showFamily('cannon');
  await f.action('rh120', 'test').onclick();
  trial = null; f.ui.openArsenal();
  assert.equal(f.ui.family, 'cannon'); assert.equal(f.card('rh120').attributes['aria-current'], undefined);
  assert(!descendants(f.card('rh120')).some(node => node.className === 'card-category'));
  assert.equal(f.action('rh120', 'install').textContent, 'Instalar');
});

test('a pending installation admits one action and cannot close and later restore a cancelled intention', async t => {
  let release, calls = 0;
  const f = fixture(t, { onInstall() { calls++; return new Promise(resolve => { release = resolve; }); } });
  f.ui.openArsenal();
  const first = f.action('fnmag', 'install').onclick();
  await f.action('minimi', 'install').onclick();
  assert.equal(calls, 1); assert.equal(f.dialog.open, true); assert.match(f.purpose(), /Aplicando/);
  assert(f.ui.arsenalActions.every(([button]) => button.disabled));
  const cancel = { preventDefault() { this.prevented = true; } }; f.dialog.emit('cancel', cancel);
  assert.equal(cancel.prevented, true); f.nodes.get('#close-arsenal').onclick(); assert.equal(f.dialog.open, true);
  release(); await first;
  assert.equal(f.dialog.returnValue, 'install'); assert.equal(f.ui.pendingAction, '');
  assert.equal(f.nodes.get('#close-arsenal').disabled, false);
});

test('the test of armour only changes its own gun and refuses a stale project installation without editing the design', async t => {
  const editor = new Editor(createStructuredTemplate('truck')), before = structuredClone(editor.source), history = editor.past.length,
    installed = [], tested = [];
  let trial = null;
  const f = fixture(t, { getTrialWeapon: () => trial, getBlueprint: () => editor.source,
    onInstall(id) { installed.push(id); editor.change(source => { source.name = 'Projeto alterado'; }); },
    onTrialWeapon(id) { tested.push(id); trial = id; } });
  f.dialog.dataset.swap = 'true'; f.dialog.dataset.currentPreset = 'fnmag'; f.ui.openArsenal();
  const stale = f.action('m2hb', 'install'); assert.equal(stale.disabled, false);
  trial = 'fnmag'; f.ui.describeArsenal();
  assert.equal(stale.hidden, true); assert.equal(stale.disabled, true);
  await stale.onclick();
  assert.deepEqual(installed, []); assert.deepEqual(tested, []); assert.equal(f.dialog.open, true);

  f.ui.family = 'cannon'; f.ui.openArsenal();
  assert.equal(f.ui.family, WEAPON_PRESETS.fnmag.family, 'opening derives the family of the gun of the test rather than a project choice');
  assert(f.ui.arsenalActions.every(([, kind]) => kind === 'test'));
  for (const card of f.nodes.get('#arsenal-grid').children) assert.equal(descendants(card).filter(node => node.tagName === 'button').length, 1);
  assert.equal(f.action('fnmag', 'install'), undefined);
  assert.equal(f.action('fnmag', 'test').textContent, 'Em uso no ensaio'); assert.equal(f.action('fnmag', 'test').disabled, true);
  assert.equal(f.card('fnmag').attributes['aria-current'], 'true');
  assert.equal(f.action('m2hb', 'test').textContent, 'Usar no ensaio'); assert.equal(f.purpose(), '');
  await f.action('fnmag', 'test').onclick(); assert.deepEqual(tested, [], 'the disabled current gun cannot restart the trial through a stale callback');
  await f.action('m2hb', 'test').onclick();
  assert.deepEqual(tested, ['m2hb']); assert.deepEqual(installed, []); assert.equal(f.dialog.returnValue, 'test');
  f.ui.openArsenal(); assert.equal(f.action('m2hb', 'test').textContent, 'Em uso no ensaio'); assert.equal(f.action('m2hb', 'test').disabled, true);
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history);

  trial = null; f.ui.openArsenal();
  assert.equal(f.action('m2hb', 'install').textContent, 'Trocar por esta'); assert.equal(f.action('m2hb', 'install').disabled, false);
  assert.equal(f.action('m2hb', 'test'), undefined);
});

test('changes of the gun of the test of armour keep the modal pending lock and allow retry after an error', async t => {
  let trial = 'fnmag', reject, calls = 0;
  const f = fixture(t, { getTrialWeapon: () => trial,
    onInstall() { assert.fail('the test of armour never installs into the project'); },
    onTrialWeapon() { calls++; return new Promise((_, refuse) => { reject = refuse; }); } });
  f.ui.openArsenal();
  const first = f.action('m2hb', 'test').onclick();
  await f.action('minimi', 'test').onclick();
  assert.equal(calls, 1); assert(f.ui.arsenalActions.every(([action]) => action.disabled));
  assert.match(f.purpose(), /Trocando a arma do ensaio/);
  const cancel = { preventDefault() { this.prevented = true; } }; f.dialog.emit('cancel', cancel);
  assert.equal(cancel.prevented, true); f.nodes.get('#close-arsenal').onclick(); assert.equal(f.dialog.open, true);
  reject(new Error('A troca do ensaio falhou.')); await first;
  assert.equal(f.ui.pendingAction, ''); assert.equal(f.dialog.open, true); assert.equal(f.purpose(), 'A troca do ensaio falhou.');
  assert.equal(f.nodes.get('#arsenal-purpose').attributes.role, 'alert'); assert.equal(f.action('m2hb', 'test').disabled, false);
  f.ui.options.onTrialWeapon = id => { trial = id; };
  await f.action('minimi', 'test').onclick(); assert.equal(f.dialog.open, false); assert.equal(f.dialog.returnValue, 'test');
});

test('family tabs use one tab stop, wrap with arrows and expose Home and End without moving the world', t => {
  const f = fixture(t); f.ui.openArsenal();
  const send = (index, key) => {
    const event = { key, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    f.ui.familyTabs[index][1].emit('keydown', event);
    assert.equal(event.prevented, true); assert.equal(event.stopped, true);
  };
  const selected = () => f.ui.familyTabs.filter(([, tab]) => tab.tabIndex === 0);
  assert.deepEqual(selected().map(([id]) => id), [WEAPON_FAMILIES[0][0]]);
  send(0, 'ArrowRight'); assert.equal(f.ui.family, WEAPON_FAMILIES[1][0]);
  assert.equal(document.activeElement, f.ui.familyTabs[1][1]); assert(f.ui.familyTabs[1][1].scrolled);
  send(1, 'End'); assert.equal(f.ui.family, WEAPON_FAMILIES.at(-1)[0]);
  send(WEAPON_FAMILIES.length - 1, 'ArrowRight'); assert.equal(f.ui.family, WEAPON_FAMILIES[0][0]);
  send(0, 'ArrowLeft'); assert.equal(f.ui.family, WEAPON_FAMILIES.at(-1)[0]);
  send(WEAPON_FAMILIES.length - 1, 'Home'); assert.equal(selected().length, 1);
  assert.equal(f.nodes.get('#arsenal-grid').attributes['aria-labelledby'], f.ui.familyTabs[0][1].id);
});
