import test from 'node:test';
import assert from 'node:assert/strict';
import { initSquadUX } from '../src/squad-ux.ts';
import { towReady } from '../src/tow-ui.ts';
import { Camera } from '../src/camera.ts';
import { workspaceDOM } from './helpers/dom.js';

// A vehicle as a frame of the shared field tells it: its body and the one beam of its chassis frame, `length` long
// about its middle, which a cable is fixed near either end of.
const vehicle = (id, x, { length = 4, vx = 0, omega = 0, team = 'f' } = {}) => ({
  actor: { id, ownerId: 'p', team, facing: 1, vehicle: { x, y: 1, vx, vy: 0, omega } },
  plate: { id: id + ':frame', actorId: id, attached: true, definition: { x, y: .8, angle: 0, length, chassis: { part: 'frame' } } },
});
const frame = vehicles => ({ actors: vehicles.map(v => v.actor), plates: vehicles.map(v => v.plate), tows: [] });

test('a vehicle can take another on its cable with their nearest chassis ends within 4 m and both standing still', () => {
  // Frames 4 m long: their ends are 1,92 m from their middles.
  const at = (x, patch) => towReady(frame([vehicle('tug', 0), vehicle('other', x, patch)]), 'tug', 'other');
  assert.equal(at(7.5), true, '3,66 m apart');
  assert.equal(at(8), false, '4,16 m apart');
  assert.equal(at(4), false, 'ends a few centimetres apart are no place for a cable');
  assert.equal(at(7.5, { vx: .6 }), false, 'the other one moving');
  assert.equal(at(7.5, { omega: .5 }), false, 'its end swinging about its middle');
  assert.equal(towReady(frame([vehicle('tug', 0), vehicle('other', 7.5)]), 'tug', 'ghost'), null, 'nothing to tell by: the field is asked');
});

// The squad of the field with three vehicles of the faction: one beside the tug and still, one too far, and one
// another member holds; the orders as `fieldPanel` paints them for one picked alone.
function field(t) {
  const before = { window: globalThis.window, localStorage: globalThis.localStorage }, { create } = workspaceDOM(t), keys = new Map();
  document.addEventListener = (type, listener) => keys.set(type, listener);
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  t.after(() => Object.assign(globalThis, before));
  const viewport = create('div', 'viewport'), canvas = create('canvas', 'battle-canvas', viewport), dock = create('div', 'field-dock', viewport);
  create('nav', 'field-pawns', viewport); create('p', 'field-dock-status', dock).className = 'field-dock-status';
  canvas.hasPointerCapture = () => false; canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  const vehicles = [vehicle('tug', 0), vehicle('near', -7.5), vehicle('far', 12), vehicle('held', 7.5)],
    state = { time: 2, shared: true, localPlayerId: 'p', faction: { id: 'f', deposits: [] }, modules: [], ...frame(vehicles),
      squad: { units: vehicles.map(v => ({ id: v.actor.id, ...(v.actor.id === 'held' && { by: { id: 'q', name: 'Beto' } }) })), out: [], manual: null } },
    renderer = { canvas, camera: Object.assign(new Camera(800, 400), { x: 0, y: 1, zoom: 20 }), scene: null, ground: { length: 20000, center: 0, features: [] }, markHeight: () => 0, state },
    commands = [], messages = [], replies = [],
    ux = initSquadUX({ renderer, view: { mode: 'test', cameraFree: true }, toast: message => messages.push(message), alert() {}, refresh() {}, stopControls() {}, sendAim() {},
      command: (...args) => { commands.push(args); return new Promise((resolve, reject) => replies.push({ resolve, reject })); } });
  const tow = () => state.tows.some(link => link.actorId === 'tug' || link.targetId === 'tug') ?
    { id: 'tow', name: 'Soltar o cabo', label: 'Soltar', key: 'R', hint: '', release: true, ids: ['tug'] } :
    { id: 'tow', name: 'Rebocar', key: 'R', hint: 'num veículo da facção parado ao lado', ids: ['tug'] };
  const paint = () => ux.render({ squad: { units: [] }, orders: ux.picked().length ? [tow()].map(order => ({ ...order, active: order.id === ux.choice().armed })) : [],
    actions: [], refused: {}, watch: null, stances: null, veins: [], wrecks: [], works: [], heaps: [], roads: [] });
  // A press of the mouse, or a tap of a finger, on a vehicle's body.
  const press = (id, pointerType = 'mouse') => {
    const body = state.actors.find(actor => actor.id === id).vehicle, at = renderer.camera.toScreen(body.x, body.y - .2),
      event = type => ({ type, target: canvas, clientX: at.x, clientY: at.y, button: 0, pointerType, pointerId: 1, preventDefault() {}, stopPropagation() {} });
    for (const listener of viewport.listeners.get('pointerdown')) listener(event('pointerdown'));
    for (const listener of viewport.listeners.get('pointerup')) listener(event('pointerup'));
  };
  const button = () => dock.querySelector('button[data-value="tow"]'), key = value => keys.get('keydown')({ key: value, target: canvas, preventDefault() {}, stopPropagation() {} });
  paint(); ux.select(['tug']); paint();
  return { ux, state, commands, messages, replies, paint, press, button, key };
}

test('Rebocar waits for a vehicle of the faction, edges those it can take now and asks the field for the one clicked', async t => {
  const f = field(t);
  assert.equal(f.button().hidden, false); assert.match(f.button().title, /^Rebocar · R — clique num veículo da facção parado ao lado$/);
  assert(f.button().closest('.field-more-menu'), 'Rebocar is in Mais ações, by the same key');
  f.button().click(); f.paint();
  assert.equal(f.ux.choice().armed, 'tow'); assert.equal(f.button().getAttribute('aria-pressed'), 'true');
  assert.deepEqual(f.ux.marked(), new Map([['tug', 'selected'], ['near', 'towable']]), 'the one beside it, of those the player may take');
  // One too far: what to do, and nothing asked of the field.
  f.press('far');
  assert.deepEqual([f.messages.at(-1), f.commands, f.ux.choice().armed], ['Chegue mais perto (até 4 m) e pare os dois.', [], null]);
  assert.deepEqual(f.ux.marked(), new Map([['tug', 'selected']]), 'with nothing waiting, nothing is edged for a cable');
  // One another member holds is no vehicle to take.
  f.key('r'); f.press('held');
  assert.deepEqual([f.messages.at(-1), f.commands], ['Clique num veículo da sua facção para rebocar.', []]);
  // The one beside it: the field is asked, and says so once it is done.
  f.key('r'); f.press('near');
  assert.deepEqual(f.commands, [['tow', { act: 'attach', actorId: 'tug', targetId: 'near' }]]);
  f.key('r'); f.press('near'); assert.equal(f.commands.length, 1, 'one request at a time');
  f.replies[0].resolve({ towing: true }); await new Promise(setImmediate);
  assert.equal(f.messages.at(-1), 'Cabo engatado.');
});

test('on a cable the order is Soltar, given at once; a refusal is told as the field words it', async t => {
  const f = field(t);
  f.key('r'); f.press('near'); f.replies[0].reject(new Error('Pare os dois veículos antes de conectar o cabo.')); await new Promise(setImmediate);
  assert.equal(f.messages.at(-1), 'Pare os dois veículos antes de conectar o cabo.');
  f.state.tows = [{ actorId: 'tug', targetId: 'near', anchorA: { x: -1.9, y: .8 }, anchorB: { x: -5.6, y: .8 }, length: 3.7, tension: 0, limit: 1e4 }];
  f.paint();
  assert.deepEqual([f.button().textContent.startsWith('Soltar'), f.button().title], [true, 'Soltar o cabo · R']);
  f.button().click();
  assert.deepEqual(f.commands.at(-1), ['tow', { act: 'detach', actorId: 'tug' }]); assert.equal(f.ux.choice().armed, null);
  f.replies.at(-1).resolve({ towing: false }); await new Promise(setImmediate);
  assert.equal(f.messages.at(-1), 'Cabo solto.');
  // A cable the vehicle is put on while Rebocar waits leaves nothing waiting.
  f.state.tows = []; f.paint(); f.key('r'); assert.equal(f.ux.choice().armed, 'tow');
  f.state.tows = [{ actorId: 'near', targetId: 'tug' }]; f.paint(); assert.equal(f.ux.choice().armed, null);
});

test('a finger gives Rebocar where it is lifted, as it gives Atacar', t => {
  const f = field(t);
  f.button().click(); f.press('near', 'touch');
  assert.deepEqual(f.commands, [['tow', { act: 'attach', actorId: 'tug', targetId: 'near' }]]);
});
