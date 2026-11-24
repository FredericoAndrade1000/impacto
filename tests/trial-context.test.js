import test from 'node:test';
import assert from 'node:assert/strict';
import { playContext } from './helpers/play-context.js';
import { Editor } from '../src/editor.ts';
import { Renderer } from '../src/render.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { armamentIntent } from '../src/ui-model.ts';

import { pageWorld } from '../src/trial-targets.ts';
import { BOARD, boardSite, fieldX } from '../src/workshop-site.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { createStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';

function bench(t, { x = -100519, facing = 1, design = createStructuredTemplate('truck') } = {}) {
  const editor = new Editor(design), source = structuredClone(editor.source),
    fieldWeapon = armamentIntent({ platform: 'vehicle' }),
    site = boardSite({ x, y: 275.656, facing, radius: 100 }, editor.blueprint),
    view = { mode: 'edit', trial: null, aim: { x: fieldX(site, 9.5), y: site.y + 2.5 }, weapon: fieldWeapon },
    session = { ready: true, paused: true, generation: 0, fitPending: null },
    network = { enabled: true }, renderer = new Renderer({}, view), loaded = [], commands = [], presented = [], workers = [];
  renderer.setTerrain(MAIN_WORLD.terrain, { seed: MAIN_WORLD.seed, length: MAIN_WORLD.mapLength, center: 12 });
  assert(renderer.ground.height(12) > 100, 'the starting terrain must exercise the real elevated-field regression');
  Object.assign(renderer.camera, { x, y: site.y + 3 });
  let world;
  t.after(() => world?.dispose());
  const context = { workshopUX: null, toast() {},
    async startWorker() {},
    sendAim() {},
    worker: { postMessage(message) { workers.push(structuredClone(message)); } },
    async command(type, options) {
      commands.push({ type, options: structuredClone(options) });
      if (type === 'clear') {
        world?.dispose(); world = undefined;
        return { ok: true };
      }
      assert(view.trial, 'the private context must be set before any load command can route to the shared field');
      assert.equal(type, 'load');
      loaded.push(options); world?.dispose();
      world = pageWorld(options.blueprint, { terrain: options.terrain });
      return { ok: true };
    } };
  renderer.canvas = { style: {} };
  renderer.clearScene = () => { renderer.playback.clear(); renderer.camera.follow(null); };
  context.presented = presented;
  const play = playContext({ editor, renderer, network, session, view }, context);

  return { context, editor, source, view, session, network, renderer, loaded, commands, presented, workers, site, fieldWeapon,
    ...play };
}

function overloadedDraft() {
  const hull = createStructuredConstruction({ length: 8, height: 1.4, thicknessMm: 8 }),
    draft = planStructuredComponent(hull, { id: 'command', kind: 'command', pose: { x: 5, y: hull.nodes[0].y + 6, angle: 0 } }).construction;
  draft.plates.find(plate => plate.id === 'hull:roof').thicknessMm = 150;
  return draft;
}

test('the offline workshop clears its worker and presents a pending draft without manufacturing it', async t => {
  const b = bench(t, { design: overloadedDraft() }); b.network.enabled = false;
  assert.equal(b.editor.blueprint.mechanicalAdmission, false);
  assert.throws(() => compileBlueprint(b.editor.source), error => error.code === 'CHASSIS_OVERLOAD');
  await b.loadWorld({ mode: 'edit', paused: true });
  assert.deepEqual(b.commands, [{ type: 'clear', options: { generation: 1 } }]);
  assert.deepEqual(b.loaded, []); assert.equal(b.session.paused, true);
  assert.equal(b.presented[0].mode, 'edit'); assert.equal(b.renderer.ground.id, 'flat');
  assert.deepEqual(b.editor.source, b.source); assert.equal(b.editor.past.length, 0);
  assert.equal(b.editor.blueprint.mechanicalAdmission, false);
});

for (const kind of ['armour', 'terrain']) test(`${kind} admission refuses the pending draft before changing its context or starting a worker`, async t => {
  for (const previous of [null, 'armour', 'terrain']) {
    const b = bench(t, { design: overloadedDraft() });
    b.view.trial = previous; b.view.mode = previous ? 'test' : 'edit';
    const view = structuredClone(b.view), session = structuredClone(b.session);
    let issue;
    assert.throws(() => compileBlueprint(b.editor.source), error => { issue = error; return error.code === 'CHASSIS_OVERLOAD'; });
    await assert.rejects(b.startTrial(kind), { message: constructionEditMessage(issue), code: issue.code,
      reason: issue.reason, loadedKg: issue.loadedKg, limitKg: issue.limitKg });
    assert.deepEqual(b.view, view); assert.deepEqual(b.session, session);
    assert.deepEqual(b.commands, []); assert.deepEqual(b.workers, []); assert.deepEqual(b.presented, []);
    assert.deepEqual(b.editor.source, b.source); assert.equal(b.editor.past.length, 0);
    assert.equal(b.editor.blueprint.mechanicalAdmission, false);
  }
});

test('entering either trial ends cursor installation and weapon-choice intent', async t => {
  for (const kind of ['armour', 'terrain']) {
    const b = bench(t); let cancelled = 0;
    b.context.workshopUX = { cancelWeaponChoice() { cancelled++; } };
    b.view.buildTool = 'module'; b.view.placement = { kind: 'ammo', copies: [{ component: {} }] };
    b.renderer.modulePreview = { kind: 'ammo' };
    await b.startTrial(kind);
    assert.equal(cancelled, 1); assert.equal(b.view.buildTool, 'select');
    assert.equal(b.view.placement.copies, undefined); assert.equal(b.renderer.modulePreview, null);
    await b.endTrial(); assert.equal(cancelled, 1); assert.equal(b.view.buildTool, 'select');
  }
});

for (const enabled of [false, true]) test(`cancelling the first trial during worker startup preserves the ${enabled ? 'shared' : 'offline'} workshop`, async t => {
  const b = bench(t); b.network.enabled = enabled;
  let ready;
  b.context.startWorker = () => new Promise(resolve => { ready = resolve; });
  const entering = b.startTrial('armour');
  assert.equal(b.view.trial, 'armour'); assert.equal(b.loaded.length, 0);
  await b.endTrial();
  const commands = structuredClone(b.commands), presented = b.presented.length, generation = b.session.generation;
  ready(); await entering;
  assert.equal(b.view.trial, null); assert.equal(b.view.mode, 'edit');
  assert.equal(b.session.generation, generation); assert.equal(b.loaded.length, 0);
  assert.deepEqual(b.commands, commands, 'the cancelled request never sends a late load');
  assert.equal(b.presented.length, presented, 'the trial does not reopen after its worker becomes ready');
  assert.deepEqual(b.editor.source, b.source);
});

test('a private armour test stands the design in its own frame after entering from either orientation of a distant field workshop', async t => {
  for (const x of [-100519, 125000]) for (const facing of [-1, 1]) {
    const b = bench(t, { x, facing }), remoteAim = structuredClone(b.view.aim);
    assert(Math.abs(remoteAim.x) > 100000);
    await b.startTrial('armour', 'fnmag');
    assert.equal(b.view.trial, 'armour'); assert.equal(b.view.weapon.platform, 'ground'); assert.equal(b.view.weapon.preset, 'fnmag');
    assert.equal(b.presented[0].terrain, 'flat', 'the destination ground is established before framing');
    assert.equal(b.renderer.ground.height(12), 0); assert(b.renderer.camera.y < 20);
    assert(b.renderer.camera.x >= BOARD.minX && b.renderer.camera.x <= BOARD.maxX, 'the view is on the design, not 100 km away');
    // It is struck along lines drawn (armour-strike.ts): nothing is aimed, and no gun stands at a distance from it.
    assert.deepEqual(b.view.aim, remoteAim);
    assert.equal('testDistance' in b.loaded[0], false); assert.equal(b.loaded[0].slow, true);
    assert.deepEqual(b.editor.source, b.source, 'the shared workshop orientation cannot rewrite the design');
    await b.endTrial();
    assert.equal(b.view.trial, null); assert.equal(b.view.mode, 'edit');
    assert.deepEqual(b.view.weapon, b.fieldWeapon);
    assert.deepEqual(b.workers, [{ type: 'pause', value: true }], 'leaving rests the private worker');
    assert.deepEqual(b.editor.source, b.source);
  }
});

test('changing guns inside the same armour test takes the gun chosen, and the test keeps its gun across visits', async t => {
  const b = bench(t);
  await b.startTrial('armour', 'fnmag');
  await b.startTrial('armour', 'm2hb');
  assert.equal(b.view.weapon.preset, 'm2hb');
  await b.endTrial();
  assert.deepEqual(b.view.weapon, b.fieldWeapon, 'the workshop has the gun of the field back');
  await b.startTrial('armour');
  assert.equal(b.view.weapon.preset, 'm2hb', 'the test of armour retains its gun across visits'); assert.equal(b.view.weapon.platform, 'ground');
});

test('switching from the driving trial to the test of armour needs no installed gun', async t => {
  const b = bench(t);
  assert(!b.editor.blueprint.modules.some(part => part.kind === 'weapon'), 'the hauler has no installed armament');
  b.view.trial = 'terrain'; b.view.mode = 'test'; b.view.aim = { x: -1200, y: 180 };
  await b.startTrial('armour', 'fnmag');
  assert.equal(b.view.weapon.platform, 'ground'); assert.equal(b.view.weapon.preset, 'fnmag');
  assert.equal(b.loaded[0].paused, false); assert.equal(b.presented[0].tool, 'fire');
  assert.deepEqual(b.editor.source, b.source);
});
