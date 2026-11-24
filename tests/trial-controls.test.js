import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPlayerControls } from '../src/player-controls.ts';
import { installPageKeys } from '../src/workshop-keys.ts';
import { playContext } from './helpers/play-context.js';
import { Editor } from '../src/editor.ts';
import { Renderer } from '../src/render.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import './helpers/runtime.js';
import { armamentIntent, resolveArmament, linkedArmament, loadout } from '../src/ui-model.ts';
import { WEAPON_PRESETS, weaponSettings } from '../src/weapons.ts';
import { TEST_FIELDS } from '../src/ui-fields.ts';

test('every gun of the test of armour resolves a low arc without rewriting old intents, while the engine still accepts its other trajectories', () => {
  for (const [preset, model] of Object.entries(WEAPON_PRESETS)) for (const trajectory of [undefined, 'direct', 'auto', 'high']) {
    const old = { preset, trajectory, platform: 'ground', detonation: 'airburst', charge: 'auto' }, before = structuredClone(old),
      intent = armamentIntent(old), weapon = resolveArmament(old, []);
    assert.equal(intent.trajectory, 'low', preset); assert.equal(weapon.trajectory, 'low', preset);
    assert.equal(intent.detonation, old.detonation); assert.equal(intent.charge, old.charge);
    assert.deepEqual(old, before);
    if (model.family === 'howitzer') assert.equal(weaponSettings(model.family, { preset, trajectory: 'high' }).trajectory, 'high');
  }
  assert.equal(weaponSettings('cannon', { preset: 'rh120', trajectory: 'direct' }).trajectory, 'direct');
});

test('mounted weapons derive their automatic or low arc from the real component, not old intent or a stale preset', () => {
  for (const [preset, model] of Object.entries(WEAPON_PRESETS)) {
    const expected = ['mortar', 'howitzer', 'grenade'].includes(model.family) ? 'auto' : 'low',
      gun = { id: 'installed', kind: 'weapon', weaponPreset: preset, health: 100 },
      old = { platform: 'ground', preset: 'rh120', componentId: gun.id, trajectory: 'high' }, before = structuredClone(old),
      resolved = resolveArmament(old, [gun], true);
    assert.equal(resolved.preset, preset); assert.equal(resolved.trajectory, expected, preset);
    assert.equal(resolved.charge, resolved.variableCharge ? 'auto' : 1, preset);
    assert.equal(loadout(resolved).charge, resolved.charge, preset);
    assert.equal(armamentIntent({ platform: 'vehicle', preset, trajectory: 'direct' }).trajectory, expected);
    assert.equal(loadout(resolved).trajectory, expected); assert.deepEqual(old, before);
  }
});

test('old mounted and linked loadouts retain automatic mount fallback without hidden direct or high choices', () => {
  const modules = [{ id: 'a', kind: 'weapon', weaponPreset: 'm119', health: 100 },
    { id: 'b', kind: 'weapon', weaponPreset: 'm252', health: 100 }],
    view = { linked: new Set(['b']), loadouts: { b: { trajectory: 'high', detonation: 'airburst', charge: .4 } } },
    before = structuredClone(view.loadouts), weapon = resolveArmament({ platform: 'vehicle', componentId: 'a', trajectory: 'direct' }, modules, true),
    linked = linkedArmament(view, modules, weapon);
  assert.equal(weapon.trajectory, 'auto'); assert.equal(linked[0].trajectory, 'auto');
  assert.equal(linked[0].detonation, 'airburst'); assert.equal(linked[0].charge, .4);
  assert.equal(loadout({ trajectory: 'high', detonation: 'impact', charge: 1 }).trajectory, 'low');
  assert.equal(loadout({ preset: 'm252', platform: 'vehicle', trajectory: 'high', detonation: 'impact', charge: 1 }).trajectory, 'auto');
  const twin = { ...modules[1], weaponPreset: modules[0].weaponPreset };
  assert.equal(linkedArmament(view, [modules[0], twin], weapon)[0].trajectory, 'auto', 'same-model linked guns retain the resolved mounted mode');
  const manual = armamentIntent(JSON.parse(JSON.stringify({ platform: 'vehicle', componentId: 'a', charge: .4 }))),
    restored = resolveArmament(manual, modules, true);
  assert.equal(restored.charge, .4); assert.equal(loadout(restored).charge, .4);
  assert.deepEqual(view.loadouts, before);
});

test('re-entering the test of armour normalizes its old cached intent before handing it to the private world', async () => {
  const legacy = { preset: 'm119', platform: 'ground', trajectory: 'direct', ammo: 'he', charge: 'auto', detonation: 'airburst' },
    before = structuredClone(legacy), loaded = [], editor = new Editor(createStructuredTemplate('truck')),
    view = { mode: 'test', trial: 'armour', weapon: legacy }, renderer = new Renderer({}, view),
    session = { ready: true, generation: 0, paused: false };
  renderer.canvas = { style: {} }; renderer.clearScene = () => renderer.playback.clear();
  const play = playContext({ editor, renderer, view, session, network: { enabled: false } },
    { command: async (type, options) => { loaded.push(options); return { ok: true }; } });
  await play.startTrial('armour');
  assert.equal(view.weapon.trajectory, 'low'); assert.equal(view.weapon.preset, legacy.preset);
  assert.equal(view.weapon.detonation, legacy.detonation); assert.deepEqual(legacy, before);
  assert.equal(loaded[0].slow, true);
});

test('the trial panel keeps ammunition choices and direct distance while projectile camera controls and panel firing are absent', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8'),
    ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
  for (const id of ['touch-fire', 'camera-lock', 'test-distance-field', 'propellant-charge-field', 'detonation-field']) assert(ids.has(id), id);
  assert.deepEqual(TEST_FIELDS.map(field => field.id), ['mounted-weapon', 'propellant-charge', 'detonation', 'test-distance']);
  assert(html.indexOf('id="propellant-charge-field"') < html.indexOf('id="mounted-weapon-field"'), 'ammunition options stay beside ammunition');
  assert(html.indexOf('id="detonation-field"') < html.indexOf('id="mounted-weapon-field"'));
  // The gun of the test of armour is named in the panel, over the button that changes it, with no figures of it; the
  // panel has no button to inspect.
  assert(!ids.has('weapon-specs')); assert(!ids.has('inspection'));
  assert(html.indexOf('id="weapon-description"') < html.indexOf('id="catalog-test"'), 'its name, then Trocar arma');
  assert(html.indexOf('id="inspect"') > html.indexOf('id="field-dock-actions"'), 'Inspecionar is on the line under the field');
  // One button over the field opens the panel, and its words are few.
  assert(!ids.has('field-trial-controls'), 'the dock alone opens what adjusts the test');
  assert.match(html, /id="catalog-test">Trocar arma</); assert.doesNotMatch(html, /Escolher outra|Arma de teste/);
  assert.equal(TEST_FIELDS.find(field => field.id === 'test-distance').label, 'Distância');
});

test('the gun in hand reads where its round first lands in a few words, and an aim out of reach in the words over the field', () => {
  const texts = {}, aim = { x: 40, y: 3 }, renderer = { aim, weapon: { variableCharge: false },
      solution: { reachable: true, distance: 10.3, time: .0037 }, impact: null, aimingSolution() { return this.solution; },
      weaponObstruction: () => null, impactPrediction() { return this.impact; } },
    context = {
      $: selector => ({ set textContent(value) { texts[selector] = value; } }), toast: message => { texts.toast = message; } };
  const hud = createPlayerControls({ renderer, effects: { ...context, get: context.$ } });
  Object.assign(context, { hud: hud.updateBallisticHUD, silence: hud.explainSilence });
  context.hud();
  assert.deepEqual([texts['#ballistic-info'], texts['#impact-info']], ['10,3 m · voo 3,7 ms', 'Sem impacto até a mira']);
  renderer.impact = { x: 40, y: 3, owner: { type: 'plate', material: { id: 'steel' } }, angleDegrees: 58.46, traversedMm: 38.3, bounce: { vx: 1, vy: 1 } };
  context.hud(); assert.equal(texts['#impact-info'], 'Aço · 58,5° · 38,3 mm · ricochete');
  renderer.impact = { x: 40, y: 3, owner: { type: 'module', object: { kind: 'fuel' } }, angleDegrees: 0, traversedMm: 0 };
  context.hud(); assert.equal(texts['#impact-info'], 'Combustível · 0°');
  renderer.solution = { reachable: false, limit: 'range', miss: 12 }; renderer.impact = null;
  context.hud(); assert.equal(texts['#ballistic-info'], 'Fora do alcance · a 12 m da mira');
  context.silence(); assert.equal(texts.toast, 'Fora do alcance: a arma não dispara.');
  // A high arc whose mount rises to no steeper one than comes down beyond the aim says it is too near.
  renderer.solution = { reachable: false, limit: 'near', miss: 140 };
  context.hud(); assert.equal(texts['#ballistic-info'], 'Perto demais para o arco · a 140 m da mira');
  context.silence(); assert.equal(texts.toast, 'Perto demais para o arco: a arma não dispara.');
  renderer.solution = { reachable: false, limit: 'sector', miss: 3 };
  renderer.impactPrediction = () => { throw new Error('a refused sector must not forecast an impact'); };
  context.hud();
  assert.equal(texts['#ballistic-info'], 'Fora do setor da montagem'); assert.equal(texts['#impact-info'], '');
  context.silence(); assert.equal(texts.toast, 'Fora do setor da montagem: a arma não dispara.');
});

function firing() {
  const listeners = new Map(), commands = [], input = { pointerFire: false, keyFire: false, driveKeys: new Set(), lookKeys: new Set(), lookReleased: new Set() },
    trigger = { listeners: new Map(), addEventListener(type, listener) { this.listeners.set(type, listener); }, setPointerCapture() {} },
    context = { input, view: { mode: 'test' }, placing: () => null,
      renderer: { aim: { x: 40, y: 3 }, aimingSolution: () => ({ reachable: true }), weaponObstruction: () => null },
      manualControl: () => true, armament: () => ({ preset: 'rh120', trajectory: 'low' }),
      command: async (type, data) => { commands.push({ type, data: structuredClone(data) }); return { accepted: true }; },
      toast: message => { throw new Error(message); }, explainSilence() {},
      $: selector => { if (selector === '#touch-fire') return trigger; if (selector === '.sidebar') return { hidden: true }; throw new Error('missing UI ' + selector); },
      $$: () => [], document: { addEventListener: (type, listener) => listeners.set(type, listener) },
    };
  const controls = createPlayerControls({ renderer: context.renderer, view: context.view, input, effects: { ...context, get: context.$,
    manualControl: () => context.manualControl(), armament: () => context.armament() } });
  Object.assign(context, controls, { fireOnce: controls.fire });
  controls.installTrigger(trigger);
  installPageKeys({ ...context, effects: { ...context, get: context.$, all: context.$$ } });
  const key = value => ({ key: value, preventDefault() {}, target: { tagName: 'CANVAS', matches: () => false, closest: () => null } });
  return { commands, context, listeners, trigger, key };
}

test('F still holds and releases the real trigger without a side-panel fire button', () => {
  const f = firing(); f.listeners.get('keydown')(f.key('f'));
  assert.equal(f.commands[0].type, 'trigger'); assert.equal(f.commands[0].data.active, true); assert.equal(f.commands[0].data.queue, true);
  f.listeners.get('keyup')(f.key('f')); assert.equal(f.commands.at(-1).data.active, false);
  assert.equal(f.commands[0].data.weapon.trajectory, 'low');
});

test('the floating touch trigger still fires by hold or accessible activation, and respects manual control', async () => {
  const f = firing();
  f.trigger.listeners.get('pointerdown')({ button: 0, pointerId: 1 });
  assert.equal(f.commands[0].data.active, true);
  f.trigger.listeners.get('pointerup')(); assert.equal(f.commands.at(-1).data.active, false);
  f.trigger.onclick({ detail: 0 }); await Promise.resolve();
  assert.equal(f.commands.at(-1).type, 'fire'); assert.equal(f.commands.at(-1).data.queue, true);
  f.context.manualControl = () => false; const count = f.commands.length; await f.context.fireOnce(); assert.equal(f.commands.length, count);
});

let inputCase = 0;
async function input(t, coarse, maxTouchPoints = 0, grabs = () => false) {
  const before = { document: globalThis.document, matchMedia: globalThis.matchMedia, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator') },
    root = { dataset: {} }, listeners = new Map(), canvas = {}, button = {}, changes = [], pans = [];
  globalThis.document = { documentElement: root, addEventListener: (type, listener) => listeners.set(type, [...listeners.get(type) || [], listener]) };
  globalThis.matchMedia = () => ({ matches: coarse });
  Object.defineProperty(globalThis, 'navigator', { value: { maxTouchPoints }, configurable: true });
  t.after(() => {
    globalThis.document = before.document; globalThis.matchMedia = before.matchMedia;
    if (before.navigator) Object.defineProperty(globalThis, 'navigator', before.navigator); else delete globalThis.navigator;
  });
  const module = await import('../src/touch.ts?input-review=' + (++inputCase));
  module.initTouch({ canvas, zoom() {}, pan: (x, y) => pans.push([x, y]), grabs, changed: () => changes.push(module.touching()) });
  const emit = (type, patch = {}) => {
    const event = { type, pointerType: 'mouse', pointerId: 1, target: button, clientX: 0, clientY: 0, timeStamp: 0,
      stopImmediatePropagation() { this.stopped = true; }, preventDefault() { this.defaultPrevented = true; }, ...patch };
    for (const listener of listeners.get(type) || []) listener(event);
    return event;
  };
  return { ...module, root, changes, emit, canvas, pans };
}

test('a mouse-first hybrid does not show touch controls because it merely has a touchscreen', async t => {
  const f = await input(t, false, 10);
  assert.equal(f.touching(), false); assert.equal(f.reach(12), 12);
  f.emit('pointerdown', { pointerType: 'touch', sourceCapabilities: { firesTouchEvents: true } });
  assert.equal(f.touching(), true); assert.equal(f.reach(12), 24);
  f.emit('pointermove', { sourceCapabilities: { firesTouchEvents: true } }); assert.equal(f.touching(), true, 'touch compatibility mouse events cannot hide controls');
  f.emit('pointermove'); assert.equal(f.touching(), false);
  assert.deepEqual(f.changes, [true, false]); assert.equal(f.root.dataset.input, 'mouse');
});

test('a coarse device starts with touch controls and actual mouse or finger input switches them automatically', async t => {
  const f = await input(t, true, 5);
  assert.equal(f.touching(), true); f.emit('pointermove'); assert.equal(f.touching(), false);
  f.emit('pointerdown', { pointerType: 'touch' }); assert.equal(f.touching(), true);
  assert.deepEqual(f.changes, [false, true]);
});

test('an active finger drag keeps its input until release, preserving pan when a mouse also moves', async t => {
  const f = await input(t, false, 10);
  f.emit('pointerdown', { target: f.canvas, pointerType: 'touch', pointerId: 2 });
  f.emit('pointermove', { target: f.canvas, pointerType: 'touch', pointerId: 2, clientX: 25, timeStamp: 20 });
  f.emit('pointermove'); assert.equal(f.touching(), true); assert.deepEqual(f.pans, [[25, 0]]);
  f.emit('pointerup', { target: f.canvas, pointerType: 'touch', pointerId: 2, clientX: 25, timeStamp: 30 });
  f.emit('pointermove'); assert.equal(f.touching(), false); assert.deepEqual(f.changes, [true, false]);
});

for (const release of ['pointerup', 'pointercancel']) test(`a canvas touch ${release} cannot click a button that appears under the finger`, async t => {
  const f = await input(t, true, 5, () => true);
  f.emit('pointerdown', { target: f.canvas, pointerType: 'touch', pointerId: 7 });
  f.emit(release, { target: f.canvas, pointerType: 'touch', pointerId: 7, timeStamp: 10 });
  const click = f.emit('click', { pointerType: 'touch', pointerId: 7, timeStamp: 12 });
  assert(click.defaultPrevented && click.stopped, 'the retargeted browser click is consumed in capture');
});

test('normal touch buttons, a mouse click and keyboard activation survive canvas touch suppression', async t => {
  const f = await input(t, true, 5, () => true);
  const canvasTap = () => {
    f.emit('pointerdown', { target: f.canvas, pointerType: 'touch', pointerId: 7 });
    f.emit('pointerup', { target: f.canvas, pointerType: 'touch', pointerId: 7, timeStamp: 10 });
  };
  canvasTap();
  assert(!f.emit('click', { pointerType: '', pointerId: -1, detail: 0 }).defaultPrevented, 'keyboard activation is preserved');
  assert(!f.emit('click', { pointerType: 'mouse', pointerId: 7 }).defaultPrevented, 'a mouse is not a compatibility touch click');
  f.emit('pointerdown', { pointerType: 'touch', pointerId: 7 });
  f.emit('pointerup', { pointerType: 'touch', pointerId: 7, timeStamp: 20 });
  assert(!f.emit('click', { pointerType: 'touch', pointerId: 7 }).defaultPrevented, 'a real button press clears the canvas token even when its pointer ID is reused');
});
