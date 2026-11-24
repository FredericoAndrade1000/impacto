import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.ts';
import { plateCorners } from '../src/math.ts';
import { componentPolygon } from '../src/assembly.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { initSquadUX } from '../src/squad-ux.ts';
import { depositsOf } from '../src/deposits.ts';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.listeners = new Map(); this.hidden = false; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } }
  setAttribute() {}
  addEventListener(type, listener) { if (!this.listeners.has(type)) this.listeners.set(type, []); this.listeners.get(type).push(listener); }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const fixed = id => ({ id, ownerId: 'p', team: 'f', facing: 1 });
const plate = (actorId, id, x, y, length, angle = 0, thicknessMm = 100) =>
  ({ id, actorId, definition: { id, x, y, length, angle, thicknessMm, material: 'steel' } });
const rectangle = points => {
  const xs = points.map(p => p.x), ys = points.map(p => p.y),
    minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, width: maxX - minX, height: maxY - minY };
};
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} differs from ${expected}`);

function fixture(t, actors, plates = [], modules = []) {
  const previous = { document: globalThis.document, window: globalThis.window, observer: globalThis.ResizeObserver },
    viewport = new Element('div'), panel = new Element('div'), sidebar = new Element('aside'), canvas = new Element('canvas'), captures = new Set(), documentEvents = new Map();
  globalThis.document = { createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag),
    querySelector: selector => ({ '#viewport': viewport, '#field-pawns': panel, '.sidebar': sidebar })[selector],
    querySelectorAll: () => [], addEventListener: (type, listener) => documentEvents.set(type, listener) };
  globalThis.window = { addEventListener() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.document = previous.document; globalThis.window = previous.window; globalThis.ResizeObserver = previous.observer; });
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0 }); canvas.focus = () => {};
  canvas.setPointerCapture = id => captures.add(id); canvas.hasPointerCapture = id => captures.has(id); canvas.releasePointerCapture = id => captures.delete(id);
  const state = { time: 2, shared: true, actors, plates, modules, localPlayerId: 'p', faction: { id: 'f', deposits: [] },
    squad: { units: actors.map(a => ({ id: a.id })), out: [], manual: null } },
    camera = new Camera(667, 375), view = { mode: 'test', cameraFree: true }, commands = [], fits = [], toasts = [], selections = [],
    renderer = { state, camera, canvas, scene: null, markHeight: () => 0, ground: { length: 20000, center: 0, features: [] } },
    ux = initSquadUX({ renderer, view, command: (...args) => { commands.push(args); return Promise.resolve({ seconds: 5 }); },
      toast: message => toasts.push(message), alert() {}, refresh() {}, stopControls() {}, sendAim() {}, selected: ids => selections.push([...ids]) });
  camera.x = camera.y = 0; camera.zoom = 20;
  const fit = camera.fit.bind(camera); camera.fit = (...args) => { fits.push(args); fit(...args); };
  const event = (type, x, y, patch = {}) => {
    const sent = { type, target: canvas, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      pointerType: 'mouse', pointerId: 1, stopPropagation() {}, preventDefault() {}, ...patch };
    for (const listener of viewport.listeners.get(type) || []) listener(sent);
  };
  const worldEvent = (type, x, y, patch) => { const p = camera.toScreen(x, y); event(type, p.x, p.y, patch); };
  const click = (dataset, detail = 1, patch = {}) => {
    const button = { dataset };
    for (const listener of panel.listeners.get('click') || []) listener({ target: { closest: selector => selector === 'button[data-act]' ? button : null }, detail, ...patch });
  };
  const row = (id, detail = 1, patch = {}) => click({ act: 'unit', id }, detail, patch);
  const key = key => documentEvents.get('keydown')({ key, target: {}, preventDefault() {}, stopPropagation() {} });
  return { state, renderer, view, ux, camera, commands, fits, captures, event, worldEvent, row, click, key, toasts, selections, panel };
}

// The column as the panel tells it: each construction with its place in it, which is its key, and its group.
const column = (f, units) => f.ux.render({ squad: { units: units.map(([id, group], i) => ({ id, group, number: i + 1 })) },
  watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [], refused: {} });

test('only explicit player selection reports objectives; joining and publication autopicks do not', t => {
  const f = fixture(t, [{ ...fixed('miner'), vehicle: { x: 0, y: 0 } }]);
  column(f, [['miner', 'logistics']]);
  f.ux.pick('miner'); assert.deepEqual(f.ux.choice().picked, ['miner']);
  assert.deepEqual(f.selections, []);
  f.key('1'); assert.deepEqual(f.selections, [['miner']]);
  f.row('miner'); assert.deepEqual(f.selections, [['miner'], ['miner']]);
  f.ux.pick('miner'); f.ux.choice(); assert.equal(f.selections.length, 2);
});

test('a key is the place of a construction in the column, not in the squad', t => {
  const f = fixture(t, [{ ...fixed('truck'), vehicle: { x: 0, y: 0 } }, { ...fixed('tank'), vehicle: { x: 20, y: 0 } }]);
  column(f, [['tank', 'attack'], ['truck', 'logistics']]);
  f.key('1'); assert.deepEqual(f.ux.picked(), ['tank']);
  f.key('2'); assert.deepEqual(f.ux.picked(), ['truck']);
  f.key('3'); assert.deepEqual(f.ux.picked(), ['truck'], 'a key past the column picks nothing');
  assert.deepEqual(f.commands, []);
});

test('a finger held on a construction of the column adds it to the selection, or takes it out, and its click does no more', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(t, [{ ...fixed('truck'), vehicle: { x: 0, y: 0 } }, { ...fixed('tank'), vehicle: { x: 20, y: 0 } }]);
  column(f, [['tank', 'attack'], ['truck', 'logistics']]);
  const pawn = { dataset: { act: 'unit', id: 'truck' }, disabled: false },
    finger = type => { for (const listener of f.panel.listeners.get(type) || []) listener({ pointerType: 'touch', target: { closest: () => pawn } }); };
  f.row('tank'); assert.deepEqual(f.ux.picked(), ['tank']);
  finger('pointerdown'); t.mock.timers.tick(449); assert.deepEqual(f.ux.picked(), ['tank']);
  t.mock.timers.tick(1); assert.deepEqual(f.ux.picked().sort(), ['tank', 'truck']);
  finger('pointerup'); f.row('truck'); assert.deepEqual(f.ux.picked().sort(), ['tank', 'truck'], 'the click a hold ends in was its pick');
  finger('pointerdown'); t.mock.timers.tick(450); finger('pointerup'); f.row('truck');
  assert.deepEqual(f.ux.picked(), ['tank'], 'held again, it leaves the selection');
  finger('pointerdown'); t.mock.timers.tick(100); finger('pointerup'); f.row('truck');
  assert.deepEqual(f.ux.picked(), ['truck'], 'a short tap picks it alone');
  assert.deepEqual(f.commands, []);
});

test('an additive box selection reports its actual chosen vehicles', t => {
  const f = fixture(t, [{ ...fixed('miner'), vehicle: { x: 0, y: 0 } }]);
  f.worldEvent('pointerdown', -8, 8, { ctrlKey: true });
  f.worldEvent('pointermove', 8, -8, { ctrlKey: true });
  f.worldEvent('pointerup', 8, -8, { ctrlKey: true });
  assert.deepEqual(f.selections.at(-1), ['miner']);
});

test('a fresh field clears local picks without claiming a user selection while explicit tutorial selection is a click in the column', t => {
  const f = fixture(t, [{ ...fixed('miner'), vehicle: { x: 0, y: 0 } }]);
  f.ux.pick('miner'); assert.deepEqual(f.ux.choice().picked, ['miner']);
  f.ux.clearSelection(); assert.deepEqual(f.ux.choice().picked, []); assert.equal(f.ux.focused(), null);
  assert.deepEqual(f.selections, []); assert.deepEqual(f.commands, []);
  f.ux.select(['missing', 'miner']); assert.deepEqual(f.ux.choice().picked, ['miner']);
  assert.deepEqual(f.selections, [['miner']]); assert.deepEqual(f.commands, []);
  f.ux.pick('miner'); f.ux.clearSelection(); assert.deepEqual(f.ux.choice().picked, []);
});

function hauler(t) {
  const f = fixture(t, [{ ...fixed('truck'), vehicle: { x: 0, y: 0 } }]);
  f.renderer.ground.features = [{ kind: 'outcrop', peak: 20 }];
  f.site = depositsOf(f.renderer.ground)[0];
  f.state.faction.deposits = [{ id: f.site.id, left: 0, stock: 5800, active: true, seen: true }];
  f.row('truck');
  // The vein as the panel tells it, with the button that sends the truck there.
  f.veins = [{ id: f.site.id, name: 'Ferro · afloramento', lines: [], collect: { ids: ['truck'], name: 'Transportar', label: 'Transportar', title: '', icon: 'i-haul' } }];
  f.ux.render({ squad: null, watch: null, veins: f.veins, wrecks: [], works: [], heaps: [], roads: [], orders: ['move', 'haul', 'bombard'].map(id => ({ id, ids: ['truck'] })), refused: {} });
  return f;
}

for (const button of [0, 2]) test(`Transportar selected in the panel stays a haul order on mouse button ${button} near the pile`, t => {
  const f = hauler(t);
  f.click({ act: 'order', value: 'haul' });
  assert.equal(f.ux.choice().armed, 'haul');
  // The visible pile lies on the ground; its small marker is 26 px higher.
  f.worldEvent('pointerdown', f.site.x + 4, 0, { button });
  f.worldEvent('pointerup', f.site.x + 4, 0, { button });
  assert.deepEqual(f.commands, [['squad', { order: 'haul', ids: ['truck'], depositId: f.site.id }]]);
  assert.equal(f.ux.choice().armed, null);
});

test('an explicit move onto a vein marker keeps its requested order while ordinary right clicks remain contextual', t => {
  const f = hauler(t), markerY = 26 / f.camera.zoom;
  f.worldEvent('pointerdown', f.site.x, markerY, { button: 2 });
  f.worldEvent('pointerup', f.site.x, markerY, { button: 2 });
  assert.equal(f.commands[0][1].order, 'haul');
  f.key('m');
  f.worldEvent('pointerdown', f.site.x, markerY, { button: 2 });
  f.worldEvent('pointerup', f.site.x, markerY, { button: 2 });
  assert.deepEqual(f.commands[1], ['squad', { order: 'move', ids: ['truck'], x: f.site.x }]);
  f.worldEvent('pointerdown', f.site.x + 4, 0, { button: 2 });
  f.worldEvent('pointerup', f.site.x + 4, 0, { button: 2 });
  assert.equal(f.commands[2][1].order, 'move');
});

test('an armed haul with no valid vein reports the missing target without issuing a move', t => {
  const f = hauler(t);
  f.key('j');
  f.worldEvent('pointerdown', 100, 0, { button: 2 });
  f.worldEvent('pointerup', 100, 0, { button: 2 });
  assert.deepEqual(f.commands, []);
  assert.match(f.toasts.at(-1), /jazida que a facção conhece/);
});

test('right-dragging the camera neither issues nor cancels a pending haul destination', t => {
  const f = hauler(t);
  f.key('j');
  f.worldEvent('pointerdown', f.site.x, 0, { button: 2 });
  f.worldEvent('pointermove', f.site.x + 2, 0, { button: 2 });
  f.worldEvent('pointerup', f.site.x + 2, 0, { button: 2 });
  assert.deepEqual(f.commands, []);
  assert.equal(f.ux.choice().armed, 'haul');
});

test('buttons, shortcuts and contextual targets refuse a visible disabled order using its model reason', t => {
  const f = hauler(t), reason = 'Nenhuma jazida compatível conhecida. Explore com um veículo de reconhecimento.';
  f.ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'haul', ids: [], disabled: true, reason }], refused: { haul: 'texto antigo' } });
  f.click({ act: 'order', value: 'haul' });
  f.key('j');
  f.worldEvent('pointerdown', f.site.x, 26 / f.camera.zoom, { button: 2 });
  f.worldEvent('pointerup', f.site.x, 26 / f.camera.zoom, { button: 2 });
  assert.deepEqual(f.commands, []);
  assert.deepEqual(f.toasts, [reason, reason, reason]);
  assert.equal(f.ux.choice().armed, null);
  f.ux.render({ squad: null, watch: null, veins: f.veins, wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'haul', ids: ['truck'], disabled: false, reason: '' }], refused: {} });
  f.key('j'); f.worldEvent('pointerdown', f.site.x, 0);
  assert.deepEqual(f.commands, [['squad', { order: 'haul', ids: ['truck'], depositId: f.site.id }]]);
});

for (const button of [0, 2]) test(`a haul becoming unavailable before mouse button ${button} cannot silently turn into a move`, t => {
  const f = hauler(t), reason = 'Aguarde a reconexão com o campo.';
  f.key('j'); assert.equal(f.ux.choice().armed, 'haul');
  f.ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'haul', disabled: true, reason, ids: [] }, { id: 'move', ids: ['truck'] }], refused: {} });
  f.worldEvent('pointerdown', f.site.x, 0, { button }); f.worldEvent('pointerup', f.site.x, 0, { button });
  assert.deepEqual(f.commands, []); assert.equal(f.toasts.at(-1), reason);
  assert.equal(f.ux.choice().armed, null);
});

test('the manual turn button and its shortcut share the model refusal and resume after service', async t => {
  const f = fixture(t, [{ ...fixed('truck'), vehicle: { x: 0, y: 0 } }]), reason = 'Aguarde o serviço terminar para virar.';
  f.state.squad.manual = 'truck';
  f.ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [], refused: {}, turn: true, turnDisabled: true, turnReason: reason });
  f.key('v'); await f.ux.turn();
  assert.deepEqual(f.commands, []); assert.deepEqual(f.toasts, [reason, reason]);
  f.ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [], refused: {}, turn: true, turnDisabled: false, turnReason: '' });
  await f.ux.turn();
  assert.deepEqual(f.commands, [['squad', { order: 'turn', ids: ['truck'] }]]);
});

test('a fixed construction uses its rotated plates and modules for a double click in the column and framing', t => {
  const wall = plate('post', 'wall', -56019, 493, 4, Math.PI / 3, 400),
    command = { id: 'command', actorId: 'post', kind: 'command', x: -56018, y: 494, width: 2, height: 1, angle: Math.PI / 4 },
    { ux, row, camera, view, commands, fits, state } = fixture(t, [fixed('post')], [wall], [command]),
    expected = rectangle([...plateCorners(wall.definition), ...componentPolygon(command)]), before = structuredClone(state);
  camera.cover = () => ({ left: 100, right: 0, top: 20, bottom: 40 });
  row('post'); assert.deepEqual(ux.picked(), ['post']);
  row('post', 2);
  assert.equal(ux.watched(), 'post'); assert.equal(view.cameraFree, false); assert.equal(camera.zoom, 20);
  near(camera.x, expected.x - 100 / 40); near(camera.y, expected.y - 20 / 40);
  assert.equal(ux.frame(), true); assert.deepEqual(fits[0], [{ plates: [], modules: [expected] }, true]);
  assert.deepEqual(commands, []); assert.deepEqual(state, before);
});

test('canvas clicks, double-click and box selection include fixed constructions alongside vehicles', t => {
  const { ux, worldEvent, commands, captures } = fixture(t,
    [fixed('post'), { ...fixed('truck'), vehicle: { x: 10, y: 0 } }], [plate('post', 'floor', -5, 1, 4)]);
  worldEvent('pointerdown', -5, 1); worldEvent('pointerup', -5, 1);
  assert.deepEqual(ux.picked(), ['post']);
  worldEvent('dblclick', -5, 1); assert.equal(ux.watched(), 'post'); ux.unwatch();
  worldEvent('pointerdown', -9, 5); worldEvent('pointermove', 15, -3); worldEvent('pointerup', 15, -3);
  assert.deepEqual(ux.picked(), ['post', 'truck']); assert.equal(captures.size, 0); assert.deepEqual(commands, []);
});

test('with a vehicle in hand a double click on the field is its aim and fire: the camera stays with it, and the column still takes it', t => {
  const { ux, worldEvent, row, state, view } = fixture(t, [fixed('post'), { ...fixed('truck'), vehicle: { x: 10, y: 0 } }], [plate('post', 'floor', -5, 1, 4)]);
  ux.watch('truck'); state.squad.manual = 'truck';
  worldEvent('dblclick', -5, 1); assert.equal(ux.watched(), 'truck', 'not on the construction under the pointer');
  worldEvent('dblclick', 40, 30); assert.equal(ux.watched(), 'truck', 'nor let go over open ground'); assert.equal(view.cameraFree, false);
  row('post', 2); assert.equal(ux.watched(), 'post', 'a double click in the column is a gesture of the camera alone');
  // Commanding again, the double click on the field is the camera's.
  state.squad.manual = null;
  worldEvent('dblclick', 10, 1); assert.equal(ux.watched(), 'truck');
  worldEvent('dblclick', 40, 30); assert.equal(ux.watched(), null); assert.equal(view.cameraFree, true);
});

test('module-only fixed constructions retain their real bounds and exclude detached pieces', t => {
  const module = { id: 'sensor', actorId: 'post', kind: 'sensor', x: 7, y: 3, width: 6, height: 2, angle: Math.PI / 2 },
    debris = { ...module, id: 'debris', x: 1000, attached: false },
    { ux, fits, worldEvent } = fixture(t, [fixed('post')], [{ ...plate('post', 'loose', -1000, 4, 12), attached: false }], [module, debris]);
  worldEvent('pointerdown', 7, 5); worldEvent('pointerup', 7, 5);
  assert.deepEqual(ux.picked(), ['post']); assert.equal(ux.frame(), true);
  assert.deepEqual(fits[0][0].modules, [rectangle(componentPolygon(module))]);
});

test('fixed bounds use the sampled piece pose rather than the newer snapshot position', t => {
  const wall = plate('post', 'wall', 42, 3, 4, 0, 200),
    { ux, renderer, state, fits, worldEvent, camera } = fixture(t, [fixed('post')], [wall]),
    previous = { ...state, time: 1, plates: [plate('post', 'wall', 38, 3, 4, 0, 200)] };
  renderer.scene = sampleScene(state, previous, .25); camera.x = 39;
  worldEvent('pointerdown', 39, 3); worldEvent('pointerup', 39, 3);
  assert.deepEqual(ux.picked(), ['post']); assert.equal(ux.frame(), true);
  near(fits[0][0].modules[0].x, 39); near(fits[0][0].modules[0].width, 4); near(fits[0][0].modules[0].height, .2);
  assert.equal(state.plates[0].definition.x, 42);
});

test('a click on a piece the frame draws picks its vehicle, though the piece stands out of the box of its plates', t => {
  const thruster = { id: 'lift', actorId: 'drone', kind: 'thruster', x: -3, y: 4, width: .64, height: 1.31, angle: 0 },
    { ux, renderer, state, worldEvent } = fixture(t, [{ ...fixed('drone'), vehicle: { x: 0, y: 0 } }], [plate('drone', 'floor', 0, 1, 8, 0, 8)], [thruster]);
  worldEvent('pointerdown', -3, 4.4); worldEvent('pointerup', -3, 4.4);
  assert.deepEqual(ux.picked(), [], 'out of the box of its plates');
  renderer.scene = sampleScene(state, state, 0);
  worldEvent('pointerdown', -3, 4.4); worldEvent('pointerup', -3, 4.4);
  assert.deepEqual(ux.picked(), ['drone']);
});

test('empty fixed actors get no phantom bounds and moving vehicles keep their displayed body and focus height', t => {
  const { ux, row, camera, renderer, fits } = fixture(t, [fixed('empty'), { ...fixed('truck'), vehicle: { x: 30, y: 5 } }]);
  row('empty', 2); assert.equal(ux.watched(), null); row('empty'); assert.equal(ux.frame(), false); assert.equal(fits.length, 0);
  renderer.scene = { actor: id => id === 'truck' ? { x: 28, y: 4 } : null };
  row('truck', 2); assert.equal(ux.watched(), 'truck'); near(camera.x, 28); near(camera.y, 5.2); assert.equal(camera.zoom, 20);
  row('truck'); assert.equal(ux.frame(), true);
  assert.deepEqual(fits[0][0].modules, [{ x: 28, y: 4.35, width: 8, height: 3.3 }]);
});

test('mixed orders address the model recipients without changing selection or controlling either construction', t => {
  const { ux, row, worldEvent, commands, state, key } = fixture(t,
    [fixed('post'), { ...fixed('truck'), vehicle: { x: 10, y: 0 } }], [plate('post', 'wall', -5, 1, 4)]);
  row('post'); row('truck', 1, { ctrlKey: true });
  ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'move', ids: ['truck'] }, { id: 'bombard', ids: ['post'] }, { id: 'stop', ids: ['post', 'truck'] }], refused: {} });
  worldEvent('pointerdown', 20, 0, { button: 2 }); worldEvent('pointerup', 20, 0, { button: 2 });
  assert.deepEqual(commands[0], ['squad', { order: 'move', ids: ['truck'], x: 20 }]);
  key('b'); worldEvent('pointerdown', 20, 2);
  assert.deepEqual(commands[1], ['squad', { order: 'bombard', ids: ['post'], point: { x: 20, y: 2 } }]);
  key('x'); assert.deepEqual(commands[2], ['squad', { order: 'stop', ids: ['post', 'truck'] }]);
  assert.deepEqual(ux.picked(), ['post', 'truck']); assert.equal(state.squad.manual, null);
});

test('changing selection cancels its pending destination and stale recipient IDs never command the old selection', t => {
  const { ux, row, key, worldEvent, commands } = fixture(t,
    [fixed('post'), { ...fixed('truck'), vehicle: { x: 10, y: 0 } }], [plate('post', 'wall', -5, 1, 4)]);
  row('truck'); ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'move', ids: ['truck'] }], refused: {} });
  key('m'); assert.equal(ux.choice().armed, 'move'); row('post'); assert.equal(ux.choice().armed, null);
  key('m'); assert.equal(ux.choice().armed, null, 'the old model cannot re-arm an order for another selection');
  worldEvent('pointerdown', 25, 0, { button: 2 }); worldEvent('pointerup', 25, 0, { button: 2 });
  assert.deepEqual(commands, []); assert.deepEqual(ux.picked(), ['post']);
});

test('there is no escort: its old key arms nothing and a click after it gives no order', t => {
  const { ux, row, key, worldEvent, commands } = fixture(t, [{ ...fixed('truck'), vehicle: { x: 10, y: 0 } }]);
  row('truck'); ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'move', ids: ['truck'] }], refused: {} });
  key('e'); assert.equal(ux.choice().armed, null); worldEvent('pointerdown', 10, 0);
  assert.deepEqual(commands, []);
});

test('the hold-fire shortcut toggles only armed recipients even with an unarmed selected vehicle', t => {
  const { ux, row, key, commands } = fixture(t, [fixed('post'), { ...fixed('truck'), vehicle: { x: 10, y: 0 } }]);
  row('post'); row('truck', 1, { ctrlKey: true });
  ux.render({ squad: null, watch: null, veins: [], wrecks: [], works: [], heaps: [], roads: [], orders: [{ id: 'attack', ids: ['post'] }], refused: {}, stances: [{ id: 'hold', active: true }] });
  key('g'); assert.deepEqual(commands, [['squad', { order: 'stance', ids: ['post'], stance: 'return' }]]);
  assert.deepEqual(ux.picked(), ['post', 'truck']);
});
