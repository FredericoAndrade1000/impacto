import test from 'node:test';
import assert from 'node:assert/strict';
import { playContext } from './helpers/play-context.js';
import { Editor } from '../src/editor.ts';
import { Renderer } from '../src/render.ts';
import { FramedCamera } from '../src/camera.ts';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { armamentIntent } from '../src/ui-model.ts';
import { BOARD, boardSite, fieldX } from '../src/workshop-site.ts';
import { FOOTING_SEATED } from '../src/fixed-footing.ts';
import { groundView } from '../src/terrain-art.ts';
import { plateCorners } from '../src/math.ts';
import { MAIN_WORLD, TRIAL_WORLD } from '../src/battle-rules.ts';
import { initSquadUX } from '../src/squad-ux.ts';

function fixture(t, { width = 1600, height = 900, facing = 1, enabled = true, template = 'truck' } = {}) {
  const editor = new Editor(createStructuredTemplate(template)), draft = structuredClone(editor.source),
    world = new World({ ...editor.source, terrain: MAIN_WORLD.terrain },
      { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } }),
    x = -100519;
  t.after(() => world.dispose());
  world.replaceActor(editor.source, { id: 'local', ownerId: 'me', x, facing });
  world.addActor(createStructuredTemplate('recon'), { id: 'other', ownerId: 'me', x: x + 50, facing: -1 });
  const shared = { ...world.snapshot(), shared: true },
    view = { mode: 'test', trial: null, aim: { x: x + 12, y: 400 }, weapon: armamentIntent({ platform: 'vehicle' }) },
    renderer = new Renderer({}, view), base = { x, y: world.terrain.height(x), radius: 100, facing },
    network = { enabled, base, selected: 'local' }, session = { ready: true, paused: false, generation: 0, fitPending: null },
    cover = { left: width > 1000 ? 500 : 300, right: 0, top: 85, bottom: 0 }, notices = [], calls = [], commands = [],
    screen = { surface: 'project', closes: 0, close() { this.surface = null; this.closes++; } },
    fieldScreen = { surface: 'faction', closes: 0, close() { this.surface = null; this.closes++; } };
  Object.assign(renderer.camera, { width, height }); renderer.camera.cover = () => cover;
  // The GPU is outside this transition contract. Keep its real terrain limits and both real camera classes.
  renderer.terrain = {};
  renderer.drawTerrain = () => { renderer.camera.limits = groundView(renderer.ground); };
  renderer.clearScene = () => { renderer.playback.clear(); renderer.camera.follow(null); };
  renderer.stand = site => {
    renderer.site = site;
    if (site) renderer.fieldBoard ||= { camera: new FramedCamera(renderer.camera, () => renderer.site, BOARD.middle) };
  };
  renderer.canvas = { style: {} }; renderer.receive(shared, [], { now: 0 });
  const context = { screen, fieldScreen, entry() { calls.push('entry'); },
    squadUX: null, detailsUX: { close() {} },
    worker: { postMessage(message) { calls.push(structuredClone(message)); } },
    toast: (...notice) => notices.push(notice),
    async command(type, options) {
      if (context.refuseLoad) throw new Error('O teste não carregou.');
      assert.equal(type, 'clear', 'returning to the offline draft clears the worker instead of manufacturing it');
      commands.push({ type, options: structuredClone(options) });
      return { ok: true };
    },
  };
  const play = playContext({ editor, renderer, network, session, view, deployFacing: { value: facing } }, context);

  return { ...play, context, editor, draft, renderer, world, view, network, session, shared, calls, commands, cover, screen, fieldScreen };
}

function visibleDraft(f) {
  const camera = f.renderer.board.camera, cover = camera.cover(), points = [
    ...f.editor.blueprint.plates.flatMap(plateCorners), ...f.editor.blueprint.modules.map(part => ({ x: part.x, y: part.y })),
  ].map(point => camera.toScreen(point.x, point.y));
  assert(points.length > 0);
  for (const point of points) {
    assert(point.x >= cover.left - 1 && point.x <= camera.width - cover.right + 1, `draft x=${point.x}`);
    assert(point.y >= cover.top - 1 && point.y <= camera.height - cover.bottom + 1, `draft y=${point.y}`);
  }
}

// Exercise the existing owner of field selection. Only the DOM surface of its column is replaced.
function squadChoice(t, f) {
  class Element {
    constructor() { this.children = []; this.style = {}; this.dataset = {}; this.listeners = new Map(); }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(type, listener) { this.listeners.set(type, [...this.listeners.get(type) || [], listener]); }
    querySelector() { return null; }
  }
  const before = { document: globalThis.document, window: globalThis.window, ResizeObserver: globalThis.ResizeObserver },
    viewport = new Element(), panel = new Element(), sidebar = new Element();
  globalThis.document = { createElement: () => new Element(), createElementNS: () => new Element(),
    querySelector: selector => ({ '#viewport': viewport, '#field-pawns': panel, '.sidebar': sidebar })[selector],
    querySelectorAll: () => [], addEventListener() {} };
  globalThis.window = { addEventListener() {} }; globalThis.ResizeObserver = class { observe() {} };
  t.after(() => Object.assign(globalThis, before));
  f.renderer.canvas.focus = () => {};
  const state = { ...f.shared, localPlayerId: 'me',
    squad: { units: f.shared.actors.map(actor => ({ id: actor.id })), out: [], manual: null } };
  f.renderer.playback.state = state;
  const ux = initSquadUX({ renderer: f.renderer, view: f.view, refresh() {}, stopControls() {}, sendAim() {}, alert() {},
    command: (...args) => { f.calls.push(args); return Promise.resolve(); }, toast() {} });
  f.context.squadUX = ux;
  return { ux, state, row(id, additive = false) {
    const button = { dataset: { act: 'unit', id } };
    for (const listener of panel.listeners.get('click') || []) listener({
      target: { closest: selector => selector === 'button[data-act]' ? button : null }, detail: 1, ctrlKey: additive,
    });
  } };
}

test('a failed older trial load cannot undo a newer trial, including another load of the same kind', async t => {
  for (const kind of ['terrain', 'armour']) {
    const f = fixture(t, { enabled: false }), pending = [];
    f.context.command = (type, options) => new Promise((resolve, reject) => pending.push({ type, options, resolve, reject }));
    const first = f.startTrial('armour'); await Promise.resolve();
    const second = f.startTrial(kind); await Promise.resolve();
    assert.equal(pending.length, 2);
    pending[1].resolve({ ok: true }); await second;
    const generation = f.session.generation;
    pending[0].reject(new Error('Old world refused.'));
    await assert.rejects(first, /Old world refused/);
    assert.equal(f.view.mode, 'test'); assert.equal(f.view.trial, kind);
    assert.equal(f.session.generation, generation);
  }
});

test('an older offline return that fails cannot restore its trial over a newer trial', async t => {
  const f = fixture(t, { enabled: false }), pending = [];
  f.view.trial = 'armour';
  f.context.command = (type, options) => new Promise((resolve, reject) => pending.push({ type, options, resolve, reject }));
  const leaving = f.endTrial(), entering = f.startTrial('terrain'); await Promise.resolve();
  assert.deepEqual(pending.map(request => request.type), ['clear', 'load']);
  pending[1].resolve({ ok: true }); await entering;
  pending[0].reject(new Error('Old return refused.'));
  await assert.rejects(leaving, /Old return refused/);
  assert.equal(f.view.mode, 'test'); assert.equal(f.view.trial, 'terrain');
});

test('Home frames real field geometry without including the local bench or its zero-height floor', t => {
  const f = fixture(t), { renderer } = f;
  f.fitCurrent();
  assert(renderer.camera.x < -100400, 'the local bench at x=0 cannot pull the view away from the field');
  const parts = [...renderer.state.plates.map(part => part.definition), ...renderer.state.modules],
    low = Math.min(...parts.map(part => part.y)), high = Math.max(...parts.map(part => part.y));
  assert(renderer.camera.y >= low - 10 && renderer.camera.y <= high + 100, 'the camera stays beside the actual elevated construction');
});

test('Home without known actors frames the base, and a not-yet-received field defers to its first state', t => {
  const f = fixture(t);
  f.renderer.playback.state = { ...f.shared, actors: [], plates: [], modules: [] };
  f.fitCurrent();
  assert(Math.abs(f.renderer.camera.x - f.network.base.x) < 1);
  assert(f.renderer.camera.y > f.renderer.ground.height(f.network.base.x));
  f.renderer.playback.clear();
  const asked = { ...f.renderer.camera.asked };
  f.fitCurrent();
  assert.equal(f.session.fitPending, 'controlled'); assert.deepEqual(f.renderer.camera.asked, asked);
});

for (const selected of [[], ['other'], ['local', 'other'], ['fixed']]) {
  test(`Shift+Home frames the local squad choice ${selected.join('+') || '(none)'} without controlling it`, t => {
    const f = fixture(t), camera = f.renderer.camera;
    // Fixed geometry is deliberately away from both vehicles: no body/actor origin can stand in for it.
    f.shared.actors = [...f.shared.actors, { id: 'fixed', ownerId: 'me', facing: 1 }];
    f.shared.plates = [...f.shared.plates, { id: 'fixed-wall', actorId: 'fixed',
      definition: { id: 'fixed-wall', x: -100600, y: 550, length: 3, angle: .6, thicknessMm: 100, material: 'steel' } }];
    const { ux, row, state } = squadChoice(t, f), before = structuredClone(state), fits = [], fit = camera.fit.bind(camera);
    camera.fit = (...args) => { fits.push(args); return fit(...args); };
    selected.forEach((id, i) => row(id, i > 0)); f.fitCurrent(true);
    assert.equal(fits.length, 1); assert.deepEqual(ux.picked(), selected);
    if (selected.length) {
      assert.equal(fits[0][0].plates.length, 0); assert.equal(fits[0][0].modules.length, selected.length);
      if (selected.length === 1) assert(Math.abs(fits[0][0].modules[0].x - (selected[0] === 'fixed' ? -100600 : f.world.actor('other').vehicle.x)) < 1);
      assert.equal(f.view.cameraFree, true);
    } else assert.equal(fits[0][0].plates.length, f.shared.plates.length, 'no choice falls back to the whole field rather than stale network.selected');
    f.fitCurrent();
    assert.equal(fits.at(-1)[0].plates.length, f.shared.plates.length, 'Home still frames the whole field');
    assert.deepEqual(state, before); assert.deepEqual(f.calls, []);
  });
}

for (const trial of ['armour', 'terrain']) for (const width of [1600, 667]) for (const facing of [-1, 1]) {
  test(`return from the private ${trial} test keeps the draft framed at width ${width}, facing ${facing}, through the first shared state`, async t => {
    const f = fixture(t, { width, height: width === 667 ? 375 : 900, facing });
    f.editor.select([f.editor.blueprint.plates[0].id, f.editor.blueprint.modules.find(part => part.kind === 'engine').id]);
    const selection = [...f.editor.selectionIds], primary = f.editor.selection;
    f.view.trial = trial; f.renderer.setTerrain(trial === 'terrain' ? TRIAL_WORLD.terrain : 'flat', trial === 'terrain' ? { seed: TRIAL_WORLD.seed, length: TRIAL_WORLD.mapLength, center: TRIAL_WORLD.center } : {});
    f.renderer.playback.state = { time: 0, launcher: f.editor.blueprint.launcher, actors: [], plates: [], modules: [] };
    await f.endTrial();
    assert.equal(f.view.mode, 'edit'); assert.equal(f.view.trial, null);
    assert.deepEqual([...f.editor.selectionIds], selection); assert.equal(f.editor.selection, primary, 'returning keeps the actual project selection and its primary piece');
    for (const controller of [f.screen, f.fieldScreen]) {
      assert.equal(controller.surface, null); assert.equal(controller.closes, 1, 'workspace surfaces close once at the mode transition');
    }
    const asked = { ...f.renderer.camera.asked };
    f.holdBoard();
    assert.deepEqual(f.renderer.camera.asked, asked, 'old private camera limits cannot rewrite the new draft framing');
    f.renderer.receive(f.shared, [], { now: 100 }); f.holdBoard();
    visibleDraft(f);
    const stable = { ...f.renderer.camera.asked };
    f.holdBoard(); assert.deepEqual(f.renderer.camera.asked, stable, 'settled board does not refit or move the view repeatedly');
    assert.deepEqual(f.editor.source, f.draft); assert.equal(f.calls.filter(call => call === 'resume').length, 0);
  });
}

test('the board of the field workshop is stood again for the ground that comes after it and for its design', t => {
  const f = fixture(t, { template: 'recon' }), stood = () => boardSite(f.network.base, f.editor.blueprint,
    { ground: f.renderer.ground, state: f.renderer.state, facing: 1 });
  // The workshop is on flat ground until its board stands: one stood then is stood on the field's when it comes, in its place.
  f.renderer.setTerrain('flat'); f.presentMode('edit', { sameWorld: true });
  const early = f.renderer.site;
  f.renderer.receive(f.shared, [], { now: 100 }); f.holdBoard();
  assert.deepEqual({ ...f.renderer.site }, stood()); assert.equal(f.renderer.site.x, early.x); assert.notEqual(f.renderer.site.y, early.y);
  visibleDraft(f);
  // Turned fixed, the design rests on the ground, as its footing has it.
  const seated = () => {
    const site = f.renderer.site;
    return Math.min(...f.editor.nodes().map(node => site.y + node.y - f.renderer.ground.height(fieldX(site, node.x)))) <= FOOTING_SEATED;
  };
  f.editor.setConstructionKind('fixed'); f.holdBoard();
  assert.deepEqual({ ...f.renderer.site }, stood()); assert(seated()); visibleDraft(f);
  // It rests so as it is made, once the edit is done: the board does not move under a gesture.
  const resting = f.renderer.site;
  f.editor.select([...f.editor.blueprint.plates.map(plate => plate.id), ...f.editor.blueprint.modules.map(part => part.id)]);
  const original = f.editor.captureSelection(); f.editor.begin(); f.editor.moveSelection(original, 0, .5); f.holdBoard();
  assert.equal(f.renderer.site, resting);
  f.editor.commit(); f.holdBoard();
  assert.deepEqual({ ...f.renderer.site }, stood()); assert(Math.abs(f.renderer.site.y - (resting.y - .5)) < 1e-9); assert(seated());
  const settled = f.renderer.site; f.holdBoard(); assert.equal(f.renderer.site, settled, 'a board that stands as it should is left as it is');
  f.editor.undo(); f.holdBoard();
  assert.deepEqual({ ...f.renderer.site }, { ...resting }, 'and so it does as the edit is undone');
  // On wheels again, its deck is level at the highest ground under the board.
  f.editor.setConstructionKind('wheeled'); f.holdBoard();
  assert.deepEqual({ ...f.renderer.site }, stood()); visibleDraft(f);
});

test('Home on the field workshop and on a private test retains each context own framing', t => {
  const f = fixture(t);
  f.presentMode('edit', { sameWorld: true }); f.fitCurrent(); visibleDraft(f);
  f.view.trial = 'armour'; f.renderer.setTerrain('flat');
  f.presentMode('test', { weapon: armamentIntent({ preset: 'fnmag', platform: 'ground' }) });
  f.renderer.playback.state = { time: 0, plates: f.editor.blueprint.plates.map(definition => ({ definition })), modules: f.editor.blueprint.modules };
  // Home frames the design and the ground under it: nothing stands beside it in the test of armour.
  f.fitCurrent(); visibleDraft(f);
  const floor = f.renderer.camera.toScreen(BOARD.middle, f.renderer.ground.height(BOARD.middle));
  assert(floor.y >= f.cover.top && floor.y <= f.renderer.camera.height, 'the ground under the design is in view');
  f.fitCurrent(true);
  assert(f.renderer.camera.zoom > 40, 'Shift+Home in the test of armour frames only the design');
});

test('leaving the armour trial for the field does not reopen the pending arsenal choice over the field', async t => {
  const f = fixture(t);
  f.editor.select(f.editor.blueprint.modules.find(part => part.kind === 'engine').id);
  const selected = f.editor.selection;
  f.view.trial = 'armour'; f.view.weapon = armamentIntent({ preset: 'm2hb', platform: 'ground' });
  f.renderer.setTerrain('flat');
  await f.toField();
  assert.equal(f.view.mode, 'test'); assert.equal(f.view.trial, null);
  assert.equal(f.renderer.site, null); assert.equal(f.session.fitPending, 'controlled');
  assert.equal(f.view.weapon.platform, 'vehicle');
  assert.deepEqual(f.calls, [{ type: 'pause', value: true }], 'the private worker rests without resuming the arsenal or entry dialog');
  assert.equal(f.screen.surface, null); assert.equal(f.fieldScreen.surface, null);
  assert.equal(f.editor.selection, selected); assert.deepEqual(f.editor.source, f.draft);
});

test('an offline return that fails keeps the private trial retryable without resuming a choice', async t => {
  const f = fixture(t, { enabled: false });
  f.view.trial = 'armour'; f.view.mode = 'test'; f.context.refuseLoad = true;
  await assert.rejects(f.endTrial(), /não carregou/);
  assert.equal(f.view.trial, 'armour'); assert.equal(f.view.mode, 'test'); assert.deepEqual(f.calls, []);
  assert.equal(f.session.generation, 0); assert.deepEqual(f.commands, []);
  f.context.refuseLoad = false;
  await f.endTrial();
  assert.equal(f.view.trial, null); assert.equal(f.view.mode, 'edit');
  assert.deepEqual(f.calls, []); assert.deepEqual(f.editor.source, f.draft);
  assert.deepEqual(f.commands, [{ type: 'clear', options: { generation: 1 } }]);
});
