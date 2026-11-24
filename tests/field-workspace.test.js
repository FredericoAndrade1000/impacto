import test from 'node:test';
import assert from 'node:assert/strict';
import { FieldScreen } from '../src/field-screen.ts';
import { initSquadUX } from '../src/squad-ux.ts';
import { Camera } from '../src/camera.ts';
import { MarkupElement, workspaceDOM } from './helpers/dom.js';

// Only the column of the field parses HTML; retained controls use the shared tree double.
class Element extends MarkupElement {
  constructor(tag) { super(tag); this.htmlWrites = 0; }
  set innerHTML(source) {
    this.htmlWrites++; super.innerHTML = source;
  }
}

function dom(t) {
  const before = { window: globalThis.window, localStorage: globalThis.localStorage },
    { body, create } = workspaceDOM(t, Element), storage = new Map(), documentEvents = new Map();
  document.addEventListener = (type, listener) => documentEvents.set(type, listener);
  globalThis.window = { addEventListener() {} };
  globalThis.localStorage = { getItem: name => storage.get(name) ?? null, setItem: (name, value) => storage.set(name, value) };
  t.after(() => Object.assign(globalThis, before));
  const viewport = create('div', 'viewport'), canvas = create('canvas', 'canvas', viewport), pawns = create('nav', 'field-pawns', viewport);
  canvas.hasPointerCapture = () => false;
  const sidebar = create('aside', 'sidebar'); sidebar.className = 'sidebar';
  const content = create('div', 'workspace-surface-content', sidebar), tools = create('div', 'field-tools'), dock = create('div', 'field-dock', viewport);
  const pages = create('div', 'field-pages', content); pages.hidden = true;
  const button = (id, parent, className = '') => {
    const control = create('button', id, parent); control.className = className;
    create('span', id + '-icon', control); create('span', id + '-label', control); return control;
  };
  // The faction has a button among the field's tools and a window of its own (faction-dialog.ts), not a page of the side panel.
  const vehicle = create('div', 'field-page-vehicle', pages); vehicle.hidden = true;
  const factionButton = button('faction-open', tools, 'field-tool'); factionButton.dataset.fieldTask = 'faction';
  // The infrastructure of the faction has a button beside it, and a page of the side panel.
  const infra = create('div', 'field-page-infra', pages); infra.hidden = true;
  const infraButton = button('infra-open', tools, 'field-tool'); infraButton.dataset.fieldTask = 'infra';
  for (const id of ['unit-panel', 'test-controls']) create('section', id, vehicle);
  const unit = body.querySelector('#unit-panel');
  create('details', 'unit-services', unit);
  create('div', 'field-vehicle-empty', vehicle);
  const heading = create('div', 'field-dock-heading', dock), name = create('span', 'field-dock-name', heading);
  create('span', 'field-mode', heading); create('strong', 'field-dock-title', name); create('output', 'field-dock-speed', name); create('small', 'field-dock-reverse', name);
  const actions = create('div', 'field-dock-actions', dock);
  for (const id of ['camera-lock', 'inspect', 'field-details', 'unit-control', 'field-release']) button(id, actions);
  const status = create('p', 'field-dock-status', dock); status.className = 'field-dock-status';
  const prompt = create('div', 'field-order-prompt', dock); create('span', 'field-order-prompt-text', prompt); button('field-order-cancel', prompt);
  const controls = create('section', 'field-controls', vehicle); button('field-turn', controls);
  create('p', 'field-turn-reason', controls); create('p', 'field-controls-hint', controls);
  const touch = create('div', 'touch-pad', viewport), drive = create('div', 'drive', touch); drive.className = 'touch-drive';
  create('div', 'touch-stick', touch);
  for (const id of ['ferro', 'ligas', 'silica', 'combustivel']) create('b', 'stock-' + id, create('span', 'stock-row-' + id));
  const click = (target, patch = {}) => target.dispatch('click', { detail: 1, ...patch });
  return { body, create, viewport, canvas, pawns, sidebar, content, tools, dock, storage, click, documentEvents,
    get: selector => body.querySelector(selector) };
}
const unit = (id, patch = {}) => ({ id, number: id === 'truck' ? 1 : 2, name: 'Construção ' + id, kind: 'hauler', group: 'logistics', selected: false, manual: false,
  defeated: false, alert: false, mark: '', until: null, status: 'Aguardando ordens', feedback: null, damage: {}, fuel: { share: 1, level: '' }, doing: '', ...patch });
const context = units => ({ edit: false, shared: true, manual: false, panel: { squad: { units }, orders: [], services: [], invites: [] } });

function screen(t) {
  const f = dom(t), calls = [], view = { mode: 'test', trial: null }, control = f.get('#unit-control');
  control.onclick = () => calls.push('control');
  const controller = new FieldScreen({ get: f.get }, { view, refresh: () => calls.push('refresh'),
    release: () => calls.push('release'), turn: () => calls.push('turn'), cancelOrder: () => calls.push('cancel'),
    stopControls: () => calls.push('stop-controls') });
  return { ...f, controller, calls, view, control };
}

test('field surfaces start closed and real controls survive navigation and snapshot refreshes', t => {
  const f = screen(t), changes = []; f.controller.onVisibility(task => changes.push(task));
  assert.equal(f.controller.task, null); assert.equal(f.get('#field-tabs'), null); assert.equal(f.controller.pages.hidden, true);
  f.controller.render(context([unit('truck', { selected: true })]), null);
  assert.equal(f.controller.task, null); assert.equal(f.dock.hidden, false);
  assert.deepEqual([f.tools.hidden, f.controller.heading.hidden], [false, false], 'the field has its faction at the top, and its dock says who is picked');
  assert.equal(f.controller.control, f.control); f.click(f.control); assert.deepEqual(f.calls, ['control']);
  assert.equal(f.controller.openTask('fleet'), false, 'the constructions are in the column over the field, not on a page');
  assert.equal(f.controller.openTask('faction'), false, 'the faction opens its own window');
  assert.equal(f.get('#faction-open').onclick, undefined, 'its button is answered by the window');
  assert.equal(f.get('#faction-open').hidden, false, 'it is shown with the tools of the shared field');
  f.controller.openTask('vehicle'); f.controller.openTask('vehicle');
  const page = f.get('#field-page-vehicle'), controls = f.get('#test-controls');
  assert.equal(controls.parentNode, page); assert.equal(f.get('#unit-services').parentNode.id, 'unit-panel');
  const c = context([unit('post', { selected: true, manual: true, mobile: false })]); c.manual = true; c.panel.release = true; c.panel.weapon = true;
  f.controller.render(c, null); f.controller.render(c, null);
  assert.equal(f.controller.task, 'vehicle'); assert.equal(controls.parentNode, page);
  assert.equal(f.controller.controlLabel.textContent, 'Operar'); assert.equal(f.controller.mode.textContent, 'OPERANDO');
  assert.equal(f.get('#drive').hidden, true); assert.equal(f.controller.release.hidden, false);
  assert.deepEqual(changes, ['vehicle']); f.controller.close(); f.controller.close();
  assert.deepEqual(changes, ['vehicle', null]); assert.equal(f.sidebar.dataset.fieldTask, 'closed');
});

test('a pick in the column leaves the page open on the condition of who is picked', t => {
  const f = screen(t), pawn = f.create('button', 'pawn', f.pawns); pawn.dataset.act = 'unit';
  f.controller.openTask('vehicle'); f.click(pawn); f.click(pawn, { ctrlKey: true }); assert.equal(f.controller.task, 'vehicle');
});

test('losing the last construction closes only the empty field condition surface through normal navigation', t => {
  const f = screen(t), changes = [], faction = { name: 'QA', count: 1, stock: {} };
  f.controller.onVisibility(task => changes.push(task));
  f.controller.openTask('vehicle');
  const manual = context([unit('truck', { manual: true })]); manual.manual = true; manual.panel.release = true;
  f.controller.render(manual, faction);
  assert.equal(f.controller.task, 'vehicle'); assert.equal(f.controller.release.hidden, false);
  f.controller.render(context([unit('truck')]), faction);
  assert.equal(f.controller.task, 'vehicle', 'ordinary deselection leaves the condition surface available');
  const empty = context([]), zero = { ...faction, count: 0 }, before = structuredClone(empty);
  f.controller.render(empty, zero); f.controller.render(empty, zero);
  assert.equal(f.controller.task, null); assert.equal(f.controller.pages.hidden, true);
  assert.equal(f.get('#field-page-vehicle').hidden, true); assert.equal(f.sidebar.dataset.fieldTask, 'closed');
  assert.deepEqual(changes, ['vehicle', null], 'the existing close notification releases the workspace backdrop once');
  assert.deepEqual(empty, before); assert.deepEqual(f.calls, [], 'presentation issues no game commands');
  assert.equal(f.get('#faction-open').hidden, false, 'faction management remains reachable without constructions');
  f.controller.openTask('vehicle'); f.controller.render({ ...empty, shared: false }, null);
  assert.equal(f.controller.task, 'vehicle', 'private trial controls do not belong to the empty shared fleet');
});

test('condition opens on available services, beside real stock readings and cancellation', t => {
  const f = screen(t), c = context([unit('truck', { selected: true, feedback: { kind: 'waiting', text: 'Abastecer em 3 s' } })]);
  c.panel.services = [{ id: 'repair' }]; c.panel.armed = 'Mover · 1 veículo: clique no terreno';
  const faction = { name: 'QA', count: 1, counts: { vehicles: 1, fixed: 0 }, base: { x: 20 }, stock: { ferro: 60000, ligas: 10000, silica: 1500, combustivel: 1500 } };
  f.controller.render(c, faction); assert.equal(f.controller.prompt.hidden, false);
  f.click(f.controller.cancel); assert.deepEqual(f.calls, ['cancel']);
  assert.equal(f.controller.details.getAttribute('data-services'), 'true');
  f.click(f.controller.details); assert.equal(f.controller.task, 'vehicle'); assert.equal(f.get('#unit-services').open, true);
  for (const services of [[], [{ id: 'repair', disabled: true }]]) {
    f.controller.close(); f.get('#unit-services').open = false; c.panel.services = services;
    c.panel.held = services.length ? 'Falta Ferro para o reparo.' : ''; f.controller.render(c, faction);
    assert.equal(f.controller.details.getAttribute('data-services'), 'false');
    f.click(f.controller.details); assert.equal(f.controller.task, 'vehicle'); assert.equal(f.get('#unit-services').open, false);
  }
  assert.equal(f.get('#stock-row-ferro').title, 'Ferro: 60.000');
  f.controller.close(); assert.deepEqual(f.calls, ['cancel']);
  assert.equal(f.controller.task, null);
});

test('a stock that something stands still for, or that is short, is marked, says what to the pointer and to a touch, and only it takes one', t => {
  const f = dom(t), told = [], controller = new FieldScreen({ get: f.get }, { view: { mode: 'test', trial: null }, release() {}, turn() {}, cancelOrder() {},
    notify: text => told.push(text) }), c = context([unit('truck')]),
    faction = { name: 'QA', count: 1, counts: { vehicles: 1, fixed: 0 }, base: { x: 20 }, stock: { ferro: 60000, ligas: 0, silica: 1500, combustivel: 40 } };
  c.wants = { ligas: { level: 'waiting', text: 'Parado por falta: obra Casamata · faltam 1.200' }, combustivel: { level: 'short', text: 'Não cobre tudo: abastecimento de 2 veículos · faltam 300 L' } };
  controller.render(c, faction);
  const row = id => f.get('#stock-row-' + id);
  assert.deepEqual(['ferro', 'ligas', 'silica', 'combustivel'].map(id => row(id).dataset.want), ['', 'waiting', '', 'short']);
  assert.equal(row('ligas').title, 'Ligas: 0 · Parado por falta: obra Casamata · faltam 1.200');
  assert.equal(row('ferro').title, 'Ferro: 60.000', 'the others say what they hold, as before');
  assert.equal(row('ferro').onclick, null, 'a stock with nothing to say lets a click through to the field');
  f.click(row('combustivel'));
  assert.deepEqual(told, ['Combustível · Não cobre tudo: abastecimento de 2 veículos · faltam 300 L']);
  c.wants = {}; controller.render(c, faction);
  assert.deepEqual([row('ligas').dataset.want, row('ligas').onclick, row('ligas').title], ['', null, 'Ligas: 0'], 'with the stocks for it, the mark goes');
});

test('private armour and terrain trials keep their armament behind the dock alone and inspect from it, with no faction nor name', t => {
  const f = screen(t);
  for (const trial of ['armour', 'terrain']) {
    f.view.trial = trial; const c = context([]); c.shared = false; c.manual = true; c.driven = trial !== 'armour';
    f.controller.render(c, null);
    assert.equal(f.controller.task, null); assert.equal(f.tools.hidden, true, 'a test has no faction at the top');
    assert.equal(f.dock.hidden, false); assert.equal(f.controller.heading.hidden, true, 'the name of the test is told once, at the top');
    // The speed of the vehicle in hand is its heading, alone.
    f.controller.render({ ...c, dockSpeed: '12 km/h' }, null);
    assert.deepEqual([f.controller.heading.hidden, f.controller.mode.hidden, f.controller.title.hidden], [false, true, true]);
    f.controller.render(c, null);
    assert.equal(f.get('#field-trial-controls'), null, 'one button opens what adjusts the test');
    assert.equal(f.controller.details.getAttribute('title'), 'Ajustar teste', 'the button is told by its own words');
    f.click(f.controller.details); assert.equal(f.controller.task, 'vehicle'); assert.equal(f.controller.titleText, 'Ajustar teste');
    // Inspecting is a button of the dock, beside the one that adjusts the test: the panel has no block of it.
    assert.equal(f.get('#inspect').parentNode.id, 'field-dock-actions'); assert.equal(f.get('#inspection'), null);
    assert.equal(f.get('#test-controls').parentNode.id, 'field-page-vehicle'); assert.equal(f.controller.controls.hidden, false);
    // The design under a test of armour stands still and is struck by a line drawn, and a finger has no pedals.
    assert.equal(f.controller.controlsHint.textContent, trial === 'armour' ? 'Arraste para atirar' : 'A/D conduzem · S freia · F dispara');
    // A finger drives and fires with the buttons over the field: the keys are not told, and nothing is left of the block.
    f.controller.render({ ...c, touch: true }, null); assert.equal(f.controller.controls.hidden, true);
    assert.equal(f.get('#drive').hidden, trial === 'armour');
    assert.equal(f.get('#field-screen-controls'), null);
    assert.equal(f.view.screenControls, undefined); assert.equal(f.storage.has('impacto.screen-controls'), false);
    f.controller.close();
  }
  const edited = context([]); edited.edit = true; f.controller.openTask('vehicle'); f.controller.render(edited, null);
  assert.equal(f.controller.task, null); assert.equal(f.dock.hidden, true); assert.equal(f.tools.hidden, true);
});

function squad(t, { design, actions } = {}) {
  const f = dom(t), commands = [], messages = [], blocker = { active: false }, renderer = {
    canvas: f.canvas, camera: new Camera(667, 375), scene: null, ground: { length: 20000, center: 0, features: [] }, markHeight: () => 0,
    state: { time: 2, shared: true, localPlayerId: 'p', faction: { id: 'f', deposits: [] }, plates: [], modules: [],
      actors: [{ id: 'truck', ownerId: 'p', team: 'f', facing: 1, vehicle: { x: 0, y: 1 } }, { id: 'post', ownerId: 'p', team: 'f', facing: 1 }],
      squad: { units: [{ id: 'truck' }, { id: 'post' }], out: [], manual: null } },
  }, view = { mode: 'test', cameraFree: true }, ux = initSquadUX({ renderer, view, command: (...args) => { commands.push(args); return Promise.resolve({ seconds: 4 }); },
    toast: message => messages.push(message), alert() {}, refresh() {}, stopControls() {}, sendAim() {}, blocked: () => blocker.active, design, actions }),
    rows = [unit('truck'), unit('post', { mobile: false, kind: 'armor', group: 'fixed' })],
    orders = [{ id: 'move', name: 'Mover', key: 'M', hint: 'no terreno para onde ir', ids: ['truck'] },
      { id: 'attack', name: 'Atacar', key: 'T', hint: 'num inimigo', ids: ['post'] },
      { id: 'bombard', name: 'Bombardear', key: 'B', hint: 'no ponto a bombardear', ids: ['post'] },
      { id: 'turn', name: 'Virar', key: 'V', hint: '', ids: ['truck'] },
      { id: 'home', name: 'Voltar à base ou ao posto mais perto', key: 'P', hint: '', label: 'Base', ids: ['truck'] },
      { id: 'stop', name: 'Parar', key: 'X', hint: '', ids: ['truck', 'post'] }], deeds = [];
  const paint = () => ux.render({ squad: { title: 'ESQUADRÃO', units: rows.map(row => ({ ...row, selected: ux.picked().includes(row.id) })) },
    orders: ux.picked().length ? orders.map(order => ({ ...order, active: order.id === ux.choice().armed })) : [],
    actions: ux.picked().length ? deeds : [], refused: {}, watch: null, stances: ux.picked().length ? [{ id: 'return', name: 'Responder', help: 'Responde a ataques', active: true }] : null, veins: [], wrecks: [], works: [], heaps: [], roads: [] });
  const choose = (id, patch) => f.click(f.pawns.querySelector('button[data-id="' + id + '"]'), patch);
  paint(); return { ...f, ux, renderer, view, commands, messages, paint, choose, rows, deeds, blocker };
}

test('the contextual command dock retains buttons, filters mixed recipients and cancels intention without issuing stop', t => {
  const f = squad(t);
  assert.deepEqual([...f.ux.opened()], []);
  f.choose('truck'); assert.deepEqual([...f.ux.opened()], ['truck']);
  f.choose('post', { ctrlKey: true });
  assert.deepEqual([...f.ux.opened()], [], 'a mixed group stays outside');
  assert.deepEqual(f.ux.marked(), new Map([['truck', 'selected'], ['post', 'selected']]), 'both constructions retain their selection edges');
  f.choose('post'); assert.deepEqual([...f.ux.opened()], ['post'], 'a fixed construction picked alone opens too');
  f.choose('truck', { ctrlKey: true }); f.paint();
  assert.equal(f.dock.children.indexOf(f.dock.querySelector('.field-command-options')), f.dock.children.indexOf(f.get('#field-dock-status')) - 1);
  const move = f.dock.querySelector('button[data-value="move"]'), stop = f.dock.querySelector('button[data-value="stop"]'),
    list = f.pawns, writes = list.htmlWrites;
  assert.match(move.getAttribute('aria-label'), /1 de 2 selecionados/); assert.match(move.textContent, /1\/2/);
  f.click(move); assert.equal(f.ux.choice().armed, 'move'); f.paint();
  assert.equal(f.dock.querySelector('button[data-value="move"]'), move); assert.equal(list.htmlWrites, writes);
  assert.equal(move.getAttribute('aria-pressed'), 'true'); assert.deepEqual(f.commands, []);
  f.ux.cancelOrder(); f.paint(); assert.equal(f.ux.choice().armed, null); assert.deepEqual(f.commands, []);
  f.click(stop); assert.deepEqual(f.commands, [['squad', { order: 'stop', ids: ['truck', 'post'] }]]);
  assert.deepEqual(f.ux.picked(), ['truck', 'post']); assert.equal(f.renderer.state.squad.manual, null);
  // Base goes at once, as Parar does, to those of the selection that move; its button says Base, and its title what it does.
  const home = f.dock.querySelector('button[data-value="home"]');
  assert.deepEqual([home.textContent, home.title, home.getAttribute('aria-label'), home.querySelector('.field-button-icon').dataset.icon],
    ['Base1/2P', 'Voltar à base ou ao posto mais perto · 1 de 2 selecionados · P', 'Base: voltar à base ou ao posto mais perto · 1 de 2 selecionados', 'i-garage']);
  f.click(home); assert.deepEqual([f.commands.at(-1), f.ux.choice().armed], [['squad', { order: 'home', ids: ['truck'] }], null]);
  f.documentEvents.get('keydown')({ key: 'p', target: f.canvas, preventDefault() {}, stopPropagation() {} });
  assert.deepEqual([f.commands.length, f.commands.at(-1), f.ux.choice().armed], [3, ['squad', { order: 'home', ids: ['truck'] }], null], 'and so does its key');
});

test('secondary orders and stance use the same real command owner and close their menu', t => {
  const f = squad(t); f.choose('truck'); f.choose('post', { ctrlKey: true }); f.paint();
  const more = f.dock.querySelector('.field-more-actions'), bombard = f.dock.querySelector('button[data-value="bombard"]');
  more.open = true; f.click(bombard); assert.equal(more.open, false); assert.equal(f.ux.choice().armed, 'bombard');
  const point = f.renderer.camera.toScreen(10, 4), event = { target: f.canvas, clientX: point.x, clientY: point.y,
    button: 0, pointerType: 'mouse', preventDefault() {}, stopPropagation() {} };
  f.canvas.getBoundingClientRect = () => ({ left: 0, top: 0 });
  for (const action of f.viewport.listeners.get('pointerdown')) action(event);
  assert.deepEqual(f.commands, [['squad', { order: 'bombard', ids: ['post'], point: { x: 10, y: 4 } }]]);
  f.click(f.dock.querySelector('button[data-act="stance"]'));
  assert.deepEqual(f.commands.at(-1), ['squad', { order: 'stance', ids: ['post'], stance: 'return' }]);
});

test('Mais ações has the other orders, then what is done to those picked, then the stance; Esc puts it away and gives the keyboard to the field', t => {
  const done = [], f = squad(t, { actions: { copy: action => done.push(['copy', action.id]), dismantle: action => done.push(['dismantle', action.ids]) } });
  f.deeds.push({ id: 'copy', name: 'Editar cópia', icon: 'i-copy', title: 'Abre na Oficina uma cópia do projeto desta construção.', disabled: false, reason: '' },
    { id: 'dismantle', name: 'Desmontar', label: 'Desmontar (2)', icon: 'i-build', title: 'Desmonta.', disabled: false, reason: '', ids: ['truck', 'post'] });
  f.choose('truck'); f.choose('post', { ctrlKey: true }); f.paint();
  const options = f.dock.querySelector('.field-command-options'), [primary, more] = options.children, menu = more.querySelector('.field-more-menu');
  assert.equal(more.querySelector('summary').textContent, 'Mais ações');
  assert.deepEqual(primary.children.filter(button => !button.hidden).map(button => button.dataset.value), ['move', 'attack', 'turn', 'home', 'stop'], 'Virar and Base are in the row');
  assert.deepEqual(menu.children.filter(group => !group.hidden).map(group => group.children[0]?.className),
    ['squad-orders', 'squad-orders field-unit-actions', 'eyebrow'], 'the orders, what is done to those picked, the stance');
  const [orders, deeds] = menu.querySelectorAll('.squad-orders');
  assert.deepEqual(orders.children.filter(button => !button.hidden).map(button => button.dataset.value), ['bombard']);
  assert.deepEqual(deeds.children.filter(button => !button.hidden).map(button => [button.dataset.value, button.textContent, button.title]),
    [['copy', 'Editar cópia', 'Abre na Oficina uma cópia do projeto desta construção.'], ['dismantle', 'Desmontar (2)', 'Desmonta.']]);
  more.open = true; f.click(deeds.querySelector('button[data-value="dismantle"]'));
  assert.deepEqual([done, more.open, f.commands], [[['dismantle', ['truck', 'post']]], false, []], 'an action is given what the panel told of it, and asks nothing itself');
  // With none that may be dismantled, its button is off and says why under it.
  f.deeds[1] = { ...f.deeds[1], label: 'Desmontar (0)', disabled: true, reason: 'Nenhuma pode ser desmontada agora: 2 fora da base.', ids: [] }; f.paint();
  const off = deeds.querySelector('button[data-value="dismantle"]'), why = menu.querySelector('#field-action-reason-dismantle');
  assert.deepEqual([off.disabled, off.title, why.hidden, why.textContent, off.getAttribute('aria-describedby')],
    [true, 'Nenhuma pode ser desmontada agora: 2 fora da base.', false, 'Desmontar: Nenhuma pode ser desmontada agora: 2 fora da base.', 'field-action-reason-dismantle']);
  f.click(off); assert.equal(done.length, 1);
  // Esc puts the menu away, and the keyboard is the field's again.
  more.open = true; f.documentEvents.get('keydown')({ key: 'Escape', target: more.querySelector('summary'), preventDefault() {}, stopPropagation() {} });
  assert.deepEqual([more.open, document.activeElement], [false, f.canvas]);
  // With nothing to do to those picked, only the orders and the stance are in the menu.
  f.deeds.length = 0; f.paint();
  assert.deepEqual(menu.children.filter(group => !group.hidden).map(group => group.children[0]?.className), ['squad-orders', 'eyebrow']);
});

test('a structure with no order has Mais ações all the same, with Mudar de lugar for it picked alone', t => {
  const done = [], f = squad(t, { actions: { relocate: action => done.push(action.id) } }), relocate = { id: 'relocate', name: 'Mudar de lugar', icon: 'i-relocate',
    title: 'Escolha outro local: ela é desmontada aqui e montada lá, levando o material.', disabled: false, reason: '' };
  f.choose('post');
  // An oil well picked alone: no gun, nothing to send it to, nothing to stop.
  const paint = deeds => f.ux.render({ squad: { title: 'ESQUADRÃO', units: f.rows.map(row => ({ ...row, selected: row.id === 'post' })) }, orders: [], actions: deeds,
    refused: {}, watch: null, stances: null, veins: [], wrecks: [], works: [], heaps: [], roads: [] });
  paint([relocate]);
  const options = f.dock.querySelector('.field-command-options'), [primary, more] = options.children, menu = more.querySelector('.field-more-menu');
  assert.deepEqual([options.hidden, more.hidden, primary.children.filter(button => !button.hidden).length], [false, false, 0], 'no order in the row, and the menu beside it');
  assert.deepEqual(menu.children.filter(group => !group.hidden).map(group => group.children[0]?.className), ['squad-orders field-unit-actions']);
  more.open = true; f.click(menu.querySelector('button[data-value="relocate"]'));
  assert.deepEqual([done, more.open, f.commands], [['relocate'], false, []], 'its place is chosen on the field first');
  // Held by another service, it is off and says why under it.
  paint([{ ...relocate, disabled: true, reason: 'Aguarde o fim do serviço.' }]);
  const off = menu.querySelector('button[data-value="relocate"]');
  assert.deepEqual([off.disabled, off.title, menu.querySelector('#field-action-reason-relocate').textContent], [true, 'Aguarde o fim do serviço.', 'Mudar de lugar: Aguarde o fim do serviço.']);
  f.click(off); assert.equal(done.length, 1);
});

test('modal surfaces suspend field hotkeys and a group cannot be controlled by arbitrarily choosing its first unit', t => {
  const f = squad(t); f.choose('truck'); f.choose('post', { ctrlKey: true }); f.paint();
  const key = value => f.documentEvents.get('keydown')({ key: value, target: f.canvas, preventDefault() {}, stopPropagation() {} });
  key('c'); assert.deepEqual(f.commands, []); assert.match(f.messages.at(-1), /única construção/);
  f.viewport.inert = true; key('x'); key('1'); assert.deepEqual(f.commands, []); assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  f.viewport.inert = false; key('x'); assert.deepEqual(f.commands, [['squad', { order: 'stop', ids: ['truck', 'post'] }]]);
});

test('sixteen pawns stand group by group and keep their nodes through selection, status, marks and progress', t => {
  const f = squad(t);
  f.rows.splice(0, 0, ...Array.from({ length: 6 }, (_, i) => unit('tank-' + i, { kind: 'armor', group: 'attack' })));
  for (let i = 0; i < 8; i++) f.rows.splice(7 + i, 0, unit('lorry-' + i));
  f.rows.forEach((row, i) => { row.number = i + 1; });
  for (const { id } of f.rows) if (!f.renderer.state.squad.units.some(u => u.id === id)) {
    f.renderer.state.actors.push({ id, ownerId: 'p', team: 'f', facing: -1, vehicle: { x: f.renderer.state.actors.length * 10, y: 1 } });
    f.renderer.state.squad.units.push({ id });
  }
  f.paint(); const column = f.pawns, pawns = column.querySelectorAll('.pawn'), writes = column.htmlWrites;
  assert.equal(pawns.length, 16); assert.equal(column.hidden, false);
  // Those that fight, those that work, those that stay: each group named for a reader, a hairline between them.
  assert.deepEqual(column.querySelectorAll('.pawn-group').map(group => [group.dataset.group, group.getAttribute('aria-label'), group.children.length]),
    [['attack', 'Tropas de ataque', 6], ['logistics', 'Logística', 9], ['fixed', 'Estruturas', 1]]);
  assert.deepEqual(pawns.map(pawn => pawn.querySelector('kbd').textContent), f.rows.map(row => String(row.number)), 'its key is its place');
  // Its name and what it is doing are told to the pointer alone; a picture of what it is, with no design to draw it from.
  assert.equal(pawns[6].title, 'Construção truck · Aguardando ordens'); assert.equal(pawns[6].getAttribute('aria-label'), pawns[6].title);
  assert.equal(pawns[0].querySelector('.pawn-art use').getAttribute('href'), '#k-armor');
  assert.equal(pawns[0].querySelector('.pawn-art').dataset.flip, 'false', 'only a picture of the design faces as the construction does');
  // Ctrl+A picks them all, as a drag over all of them would.
  f.documentEvents.get('keydown')({ key: 'a', ctrlKey: true, target: f.canvas, preventDefault() {}, stopPropagation() {} }); f.paint();
  assert.equal(f.ux.picked().length, 16); assert.equal(column.htmlWrites, writes);
  assert.deepEqual([...f.ux.opened()], [], 'Ctrl+A keeps the group outside');
  assert.deepEqual(new Set(f.ux.marked().keys()), new Set(f.rows.map(row => row.id)), 'Ctrl+A retains every selection edge');
  assert(pawns.every(pawn => pawn.dataset.selected === 'true' && pawn.getAttribute('aria-pressed') === 'true'));
  assert.equal(column.querySelectorAll('.pawn')[15], pawns[15]);
  // What it is doing, the one mark worth one, how whole it is and how far along it is built: on the same nodes.
  const truck = f.rows[6], built = f.rows[7], hurt = f.rows[8];
  truck.status = 'Aguardando segurança'; truck.feedback = { kind: 'waiting', text: 'Abastecer em 3 s' };
  f.rows[0].mark = 'fire'; hurt.fuel = { share: .4, level: '' }; built.mark = 'build'; built.until = 12; f.paint();
  assert.equal(pawns[6].title, 'Construção truck · Aguardando segurança · Abastecer em 3 s');
  assert.deepEqual([pawns[0].dataset.mark, pawns[0].querySelector('.pawn-mark use').getAttribute('href')], ['fire', '#i-target']);
  assert.deepEqual([pawns[1].dataset.mark, pawns[1].querySelector('.pawn-mark use').getAttribute('href')], ['', '']);
  assert.deepEqual([pawns[8].dataset.gauge, pawns[8].querySelector('i').style['--fill']], ['fuel', '40%']);
  assert.deepEqual([pawns[7].dataset.gauge, pawns[7].querySelector('i').style['--fill']], ['progress', '0%']);
  f.renderer.state.time = 7; f.paint(); assert.equal(pawns[7].querySelector('i').style['--fill'], '50%', 'counted from when the page first saw it built');
  built.mark = ''; built.until = null; f.paint(); assert.deepEqual([pawns[7].dataset.gauge, pawns[7].querySelector('i').style['--fill']], ['fuel', '100%']);
  // In hand, and lost.
  f.rows[1].manual = true; f.rows[1].mark = 'manual'; f.rows[2].defeated = true; f.paint();
  assert.deepEqual([pawns[1].dataset.manual, pawns[1].querySelector('.pawn-mark use').getAttribute('href'), pawns[2].disabled], ['true', '#i-wheel', true]);
  assert.equal(column.htmlWrites, writes); assert.deepEqual(f.commands, []);
  // A construction that changes its group is moved by building the column again.
  f.rows[0].group = 'logistics'; f.paint(); assert.equal(column.htmlWrites, writes + 1);
});

// Where the canvas, the column and its buttons stand on the screen, a button under another from the top of the column,
// with the camera where the truck is out of view: what a box picks is what it touches of the column.
function laid(f) {
  f.renderer.camera.x = -20; f.paint();
  f.canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 667, bottom: 375 });
  f.pawns.getBoundingClientRect = () => ({ left: 14, right: 80, top: 54, bottom: 360 });
  f.pawns.querySelectorAll('.pawn').forEach((pawn, i) => { const top = 54 + i * 48; pawn.getBoundingClientRect = () => ({ left: 14, right: 80, top, bottom: top + 36 }); });
  const pawn = id => f.pawns.querySelector('button[data-id="' + id + '"]'),
    send = (target, type, x, y, patch = {}) => target.dispatch(type, { clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse',
      buttons: type === 'pointerup' ? 0 : 1, ...patch }),
    box = f.viewport.children.find(child => child.className === 'squad-box'), ruler = f.viewport.children.find(child => child.className === 'squad-ruler');
  return { pawn, send, box, ruler, shown: () => f.pawns.querySelectorAll('.pawn').map(p => p.dataset.selected) };
}

test('a drag from the column draws a box that picks the constructions whose buttons it touches, as it is drawn and as it is let go', t => {
  const f = squad(t), { pawn, send, box, ruler, shown } = laid(f);
  // A press that hardly moves is still a click on its button.
  send(pawn('truck'), 'pointerdown', 40, 70); send(f.canvas, 'pointermove', 42, 72);
  assert.equal(box.hidden, true); assert.deepEqual(f.ux.picked(), []);
  // Dragged on, it is a box over the column, with no measure of the field, and it picks those it touches as it goes.
  send(f.canvas, 'pointermove', 60, 120);
  assert.deepEqual([box.hidden, ruler.hidden], [false, true]); assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  assert.deepEqual([...f.ux.opened()], []); assert.deepEqual([...f.ux.marked().keys()], ['truck', 'post']);
  f.paint(); assert.deepEqual(shown(), ['true', 'true']);
  send(f.canvas, 'pointermove', 60, 80); assert.deepEqual(f.ux.picked(), ['truck'], 'drawn back, it lets go of what it no longer touches');
  assert.deepEqual([...f.ux.opened()], ['truck'], 'shrinking the box to one construction opens it');
  send(f.canvas, 'pointermove', 60, 120); send(f.canvas, 'pointerup', 60, 120);
  assert.equal(box.hidden, true); assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  // The click the button hears as the box is let go over it is the box's.
  f.click(pawn('post')); assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  // A click picks one alone, as before.
  send(pawn('post'), 'pointerdown', 40, 120); send(pawn('post'), 'pointerup', 40, 120); f.click(pawn('post'));
  assert.deepEqual(f.ux.picked(), ['post']);
  assert.deepEqual([...f.ux.opened()], ['post']);
  // With Shift, the box adds to those picked; one that is called off leaves them as they were.
  send(pawn('post'), 'pointerdown', 40, 120, { shiftKey: true }); send(f.canvas, 'pointermove', 40, 80, { shiftKey: true });
  assert.deepEqual(f.ux.picked(), ['truck', 'post'], 'straight up the column too'); send(f.canvas, 'pointerup', 40, 80); f.click(pawn('truck'));
  assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  send(pawn('post'), 'pointerdown', 40, 120); send(f.canvas, 'pointermove', 60, 130); assert.deepEqual(f.ux.picked(), ['post']);
  send(f.canvas, 'pointercancel', 60, 130, { button: -1 }); assert.deepEqual(f.ux.picked(), ['truck', 'post']);
  assert.deepEqual(f.commands, []);
  // A finger on the column draws no box: it scrolls the column, and held, puts a construction in the selection or out of it.
  f.ux.select([]); send(pawn('truck'), 'pointerdown', 40, 70, { pointerType: 'touch' }); send(f.canvas, 'pointermove', 60, 130, { pointerType: 'touch' });
  send(pawn('truck'), 'pointerup', 60, 130, { pointerType: 'touch' });
  assert.equal(box.hidden, true); assert.deepEqual(f.ux.picked(), []);
});

test('a box drawn over the field into the column picks the constructions whose buttons it covers, with those it covers on the field', t => {
  const f = squad(t), { send, box, ruler } = laid(f);
  send(f.canvas, 'pointerdown', 300, 125); send(f.canvas, 'pointermove', 30, 130);
  assert.deepEqual([box.hidden, ruler.hidden], [false, false], 'begun on the field, it measures it');
  assert.deepEqual(f.ux.picked(), ['post']); send(f.canvas, 'pointerup', 30, 130); assert.deepEqual(f.ux.picked(), ['post']);
  // The truck is picked by its button, and by itself on the field when the box takes it in there.
  f.renderer.camera.x = -3;
  const truck = f.renderer.camera.toScreen(0, 1.5);
  send(f.canvas, 'pointerdown', 640, 20, { ctrlKey: true }); send(f.canvas, 'pointermove', truck.x, truck.y, { ctrlKey: true });
  assert.deepEqual(f.ux.picked(), ['truck', 'post'], 'with Ctrl, over those picked'); send(f.canvas, 'pointerup', truck.x, truck.y);
  send(f.canvas, 'pointerdown', 640, 20); send(f.canvas, 'pointermove', 30, 70);
  assert.deepEqual(f.ux.picked(), ['truck']); send(f.canvas, 'pointerup', 30, 70);
  assert.deepEqual(f.ux.picked(), ['truck']); assert.deepEqual(f.commands, []);
});

test('a design is drawn in the column as its mark, through a mask as sharp as the screen, facing as it does on the field', async t => {
  const { createConstruction } = await import('../src/construction-templates.ts'), { compileBlueprint } = await import('../src/persistence.ts'),
    { constructionSilhouette } = await import('../src/construction-preview.ts'), source = createConstruction('supply'),
    f = squad(t, { design: id => id === 'truck' ? source : null }), art = id => f.pawns.querySelector('button[data-id="' + id + '"] .pawn-art');
  const truck = art('truck'), mark = constructionSilhouette(compileBlueprint(source), { width: 54, height: 25 }).whole;
  assert.equal(truck.className, 'pawn-art design'); assert.deepEqual(truck.children.map(layer => layer.dataset.layer), ['whole']);
  assert.equal(truck.children[0].style['--art'], `url("data:image/svg+xml,${encodeURIComponent(mark)}")`);
  assert.equal(truck.dataset.flip, 'true', 'it faces right on the field');
  // With no design to draw it from, the icon of what it is.
  assert.deepEqual([art('post').className, art('post').querySelector('use').getAttribute('href')], ['pawn-art', '#k-armor']);
  f.renderer.state.actors[0].facing = -1; f.paint(); assert.equal(truck.dataset.flip, 'false');
});

test('a damaged construction is drawn in the column with what is damaged and lost in their colours, worked out again only when that changes', async t => {
  const { createConstruction } = await import('../src/construction-templates.ts'), { compileBlueprint } = await import('../src/persistence.ts'),
    { constructionSilhouette } = await import('../src/construction-preview.ts'), source = createConstruction('supply'),
    f = squad(t, { design: id => id === 'truck' ? source : null }), art = f.pawns.querySelector('button[data-id="truck"] .pawn-art'),
    url = mark => `url("data:image/svg+xml,${encodeURIComponent(mark)}")`;
  const damage = { engine: 'hurt', 'chassis:wheel-0': 'lost' }, marks = constructionSilhouette(compileBlueprint(source), { width: 54, height: 25, damage });
  f.rows[0].damage = { ...damage }; f.paint();
  const layers = [...art.children];
  assert.deepEqual(layers.map(layer => [layer.dataset.layer, layer.style['--art']]), [['whole', url(marks.whole)], ['hurt', url(marks.hurt)], ['lost', url(marks.lost)]]);
  // The same damage told again in a new row is not drawn again; once mended, the picture is whole again.
  f.rows[0].damage = { ...damage }; f.paint(); assert.equal(art.children[0], layers[0]);
  f.rows[0].damage = {}; f.paint(); assert.deepEqual(art.children.map(layer => layer.dataset.layer), ['whole']);
  // Its hairline is how full its tanks are: low, dry, or none with no tank; while it is mended, how far along that is.
  const pawn = f.pawns.querySelector('button[data-id="truck"]'), bar = () => [pawn.dataset.gauge, pawn.querySelector('i').style['--fill']];
  f.rows[0].fuel = { share: .3, level: 'low' }; f.paint(); assert.deepEqual(bar(), ['low', '30%']);
  f.rows[0].fuel = { share: 0, level: 'empty' }; f.paint(); assert.deepEqual(bar(), ['empty', '0%']);
  f.rows[0].fuel = null; f.paint(); assert.deepEqual(bar(), ['', '0%']);
  Object.assign(f.rows[0], { mark: 'repair', until: 12 }); f.paint(); assert.deepEqual(bar(), ['progress', '0%']);
});

test('a placement intention blocks field gestures and keys while retaining selection, pending order and watched camera target', t => {
  const f = squad(t); f.choose('truck'); f.choose('post', { ctrlKey: true }); f.paint();
  f.ux.watch('truck'); f.click(f.dock.querySelector('button[data-value="move"]'));
  const choice = f.ux.choice(), camera = { x: f.renderer.camera.x, y: f.renderer.camera.y, zoom: f.renderer.camera.zoom };
  f.blocker.active = true;
  const event = { target: f.canvas, button: 0, buttons: 1, pointerType: 'mouse', pointerId: 1,
    clientX: 80, clientY: 80, preventDefault() { throw new Error('the field stole the placement event'); },
    stopPropagation() { throw new Error('the field stole the placement event'); } };
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'dblclick']) for (const action of f.viewport.listeners.get(type) || []) action({ ...event, type });
  for (const key of ['1', 'x', 'c', 'Escape']) f.documentEvents.get('keydown')({ ...event, key });
  f.click(f.pawns.querySelector('button[data-id="truck"]'));
  assert.deepEqual(f.ux.choice(), choice); assert.equal(f.ux.watched(), 'truck');
  assert.deepEqual({ x: f.renderer.camera.x, y: f.renderer.camera.y, zoom: f.renderer.camera.zoom }, camera);
  assert.deepEqual(f.commands, []); assert.equal(f.renderer.state.squad.manual, null);
  f.blocker.active = false; f.click(f.dock.querySelector('button[data-value="stop"]'));
  assert.deepEqual(f.commands, [['squad', { order: 'stop', ids: ['truck', 'post'] }]]);
});

test('a double click on a construction of the column, or two taps of a finger the browser does not count, has the camera follow it, marked there', async t => {
  const f = squad(t), { initTouch } = await import('../src/touch.ts'), pawn = id => f.pawns.querySelector('button[data-id="' + id + '"]'),
    watched = () => f.pawns.querySelectorAll('.pawn').filter(p => p.dataset.watched === 'true').map(p => p.dataset.id);
  document.documentElement = { dataset: {} };
  initTouch({ canvas: f.canvas, zoom() {}, pan() {} });
  const point = pointerType => f.documentEvents.get('pointermove')({ pointerType, pointerId: 1, clientX: 0, clientY: 0 });
  t.after(() => point('mouse'));
  // The mouse: two clicks the browser counts as one are two picks; the second of a double click follows.
  point('mouse'); f.click(pawn('truck'), { timeStamp: 100 }); f.click(pawn('truck'), { timeStamp: 200 }); f.paint();
  assert.deepEqual([f.ux.watched(), watched()], [null, []]);
  f.click(pawn('truck'), { detail: 2, timeStamp: 300 }); f.paint();
  assert.deepEqual([f.ux.watched(), watched(), f.ux.picked()], ['truck', ['truck'], ['truck']]);
  assert.equal(pawn('truck').title, 'Construção truck · Aguardando ordens · câmera fixa');
  assert.equal(pawn('truck').querySelector('.pawn-watch use').getAttribute('href'), '#i-camera');
  f.ux.unwatch(); f.paint(); assert.deepEqual(watched(), []); assert.equal(pawn('truck').title, 'Construção truck · Aguardando ordens');
  // A finger: two taps on the same button soon one after the other, each a click of one, follow it.
  f.documentEvents.get('pointerdown')({ pointerType: 'touch', pointerId: 2, target: pawn('post') });
  f.click(pawn('post'), { timeStamp: 1000 }); f.click(pawn('post'), { timeStamp: 1600 }); f.paint();
  assert.equal(f.ux.watched(), null, 'too far apart to be one double click');
  f.click(pawn('truck'), { timeStamp: 1700 }); f.paint(); assert.equal(f.ux.watched(), null, 'a tap on another button starts again');
  f.click(pawn('truck'), { timeStamp: 1900 }); f.paint();
  assert.deepEqual([f.ux.watched(), watched(), f.ux.picked()], ['truck', ['truck'], ['truck']]);
  f.click(pawn('truck'), { timeStamp: 2000 }); f.paint(); assert.equal(f.ux.watched(), 'truck', 'a third tap is a pick again, and keeps the camera');
  assert.deepEqual(f.commands, []);
});
