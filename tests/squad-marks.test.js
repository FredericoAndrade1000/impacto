import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera } from '../src/camera.ts';
import { SquadMarks, squadTagBox, updateSquadTag, selectedRadar, MARK_MARGIN } from '../src/squad-marks.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { initSquadUX } from '../src/squad-ux.ts';

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.attributes = {}; this.writes = 0; this.textWrites = 0; this._hidden = false; this._text = '';
    const record = () => new Proxy({}, {
      get: (kept, key) => key === 'transform' && typeof kept[key] === 'string' ? kept[key].replace(/,\s*/g, ', ') : kept[key],
      set: (kept, key, value) => { kept[key] = value; this.writes++; return true; },
    });
    this.style = record(); this.dataset = record();
  }
  get firstChild() { return this.children[0]; }
  get hidden() { return this._hidden; }
  set hidden(value) { this._hidden = value; this.writes++; }
  get textContent() { return this._text; }
  set textContent(value) { this._text = String(value); this.writes++; this.textWrites++; }
  append(...children) { for (const child of children) { child.parent = this; this.children.push(child); } this.writes++; }
  setAttribute(key, value) { this.attributes[key] = String(value); this.writes++; }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent.writes++; this.parent = null; }
  addEventListener() {}
  querySelector() { return null; }
  set innerHTML(value) { throw new Error('Moving squad marks must retain their DOM nodes'); }
}

function dom(t) {
  const before = globalThis.document, made = [];
  globalThis.document = { createElement: tag => create(tag), createElementNS: (_, tag) => create(tag), addEventListener() {} };
  function create(tag) { const element = new Element(tag); made.push(element); return element; }
  t.after(() => { globalThis.document = before; });
  return { made, create };
}
const camera = () => ({ width: 1000, height: 600 });
const byTag = (root, tag) => root.children.find(child => child.tagName === tag);

function radarScene() {
  const actor = { id: 'own', ownerId: 'player' }, command = { id: 'own:command', type: 'module', data: { kind: 'command', health: 100 } },
    radar = { id: 'own:radar', type: 'module', data: { kind: 'sensor', sensorMode: 'radar', health: 100, attached: true, x: 1, y: 2 } },
    state = { shared: true, localPlayerId: 'player', squad: { out: [], manual: null, units: [] } },
    scene = { frame: { actors: new Map([[actor.id, actor]]), actorParts: new Map([[actor.id, [command, radar]]]) },
      pose: () => ({ x: 123, y: 15 }) };
  return { actor, command, radar, state, scene, selected: new Set([actor.id]) };
}

test('the selected radar limit uses its displayed module pose and canonical nominal range, never terrain visibility', () => {
  const { state, scene, radar, selected } = radarScene();
  assert.deepEqual(selectedRadar(state, scene, selected), { id: radar.id, x: 123, y: 15, range: SENSOR_MODES.radar.range });
  radar.data.range = 500;
  assert.equal(selectedRadar(state, scene, selected).range, 500, 'an explicitly published instrument limit is respected');
  radar.data.range = SENSOR_MODES.radar.range * 2;
  assert.equal(selectedRadar(state, scene, selected).range, SENSOR_MODES.radar.range);
  scene.frame.actorParts.get('own').push({ ...radar, id: 'own:spare', data: { ...radar.data, range: 500 } });
  assert.equal(selectedRadar(state, scene, selected).id, radar.id, 'overlapping radars use one maximum nominal limit');
});

test('radar limits are restricted to a single own selection, never the vehicle in hand, with working command and equipment', () => {
  const fixture = radarScene(), { state, scene, selected, actor } = fixture;
  selected.add('other'); assert.equal(selectedRadar(state, scene, selected), null);
  selected.delete('other'); state.squad.manual = actor.id;
  assert.equal(selectedRadar(state, scene, selected), null, 'driven, the vehicle has no dotted limit across the view');
  state.squad.manual = null; assert.equal(selectedRadar(state, scene, selected).id, fixture.radar.id);
  state.squad.out = [actor.id]; assert.equal(selectedRadar(state, scene, selected), null);
  state.squad.out = []; actor.ownerId = 'enemy'; assert.equal(selectedRadar(state, scene, selected), null);
  // One of the faction in another member's squad has its limit while nobody holds it, and none while that member does.
  Object.assign(state, { faction: { id: 'ours' } }); Object.assign(actor, { ownerId: 'mate', team: 'ours' });
  assert.equal(selectedRadar(state, scene, selected).id, fixture.radar.id);
  state.squad = { ...state.squad, units: [{ id: actor.id, by: { id: 'mate', name: 'Bia' } }] }; assert.equal(selectedRadar(state, scene, selected), null);
  state.squad = { ...state.squad, units: [] }; delete state.faction;
  actor.ownerId = 'player'; actor.ghost = {}; assert.equal(selectedRadar(state, scene, selected), null);
  actor.ghost = null; actor.defeated = true; assert.equal(selectedRadar(state, scene, selected), null);
  actor.defeated = false; state.shared = false; assert.equal(selectedRadar(state, scene, selected), null);
  for (const [part, patch] of [['command', { health: 0 }], ['command', { attached: false }],
    ['radar', { health: 0 }], ['radar', { attached: false }], ['radar', { detonated: true }], ['radar', { sensorMode: 'visual' }]]) {
    const f = radarScene(); Object.assign(f[part].data, patch);
    assert.equal(selectedRadar(f.state, f.scene, f.selected), null, part + JSON.stringify(patch));
  }
  const absent = radarScene(); absent.scene.pose = () => null;
  assert.equal(selectedRadar(absent.state, absent.scene, absent.selected), null);
});

test('the radar ruler retains SVG while panning, clips its range and collapses distant limits without world lettering', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), reading = { id: 'radar', x: 0, y: 0, range: 8000 },
    view = { width: 1000, height: 600, x: 0, zoom: .05, toScreen(x, y) { return { x: 500 + (x - this.x) * this.zoom, y: 300 - y * this.zoom }; } },
    draw = () => { marks.begin(view); marks.radar(reading, view); marks.end(); };
  draw();
  const group = root.firstChild, paths = group.children.filter(child => child.tagName === 'path'), count = made.length;
  assert.equal(group.attributes['data-compact'], 'false');
  assert.equal(paths[0].attributes.d, 'M100.0 300.0L900.0 300.0');
  assert.equal(group.children.some(child => child.tagName === 'text'), false, 'the nominal legend belongs to the HUD, clear of deposit labels');
  for (let i = 1; i <= 20; i++) { view.x = i * 10; draw(); }
  assert.equal(root.firstChild, group); assert.equal(made.length, count);
  view.x = 0; view.zoom = 1; draw();
  assert.equal(group.attributes['data-compact'], 'true');
  assert.equal(paths[0].attributes.d, 'M482.0 300.0L518.0 300.0', 'unseen eight-kilometre ends never produce giant SVG geometry');
  assert.equal(paths[1].attributes.d, ''); assert.equal(made.length, count);
  view.zoom = .05; reading.x = 16000; draw();
  assert.equal(group.attributes['data-compact'], 'false');
  assert.equal(paths[0].attributes.d, 'M900.0 300.0L1000.0 300.0');
  assert.equal(byTag(group, 'circle').attributes.display, 'none', 'an off-screen emitter does not invent an origin inside the viewport');
  reading.x = 30000; draw(); assert.equal(root.children.length, 0);
  for (const range of [0, Infinity, NaN]) { reading.range = range; draw(); assert.equal(root.children.length, 0); }
});

const radarPart = (group, name) => group.children.find(child => child.attributes.class === name);
const radarPoints = path => [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(([, x, y]) => ({ x: Number(x), y: Number(y) }));

test('selected radar draws its whole circle and vertical reach at a distant world position without filling it', t => {
  const { create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = new Camera(1000, 600),
    reading = Object.freeze({ id: 'radar', x: 125000, y: 1200, range: 8000 });
  Object.assign(view, { x: reading.x, y: reading.y + 3000, zoom: .05 });
  marks.begin(view); marks.radar(reading, view); marks.end();
  const group = root.firstChild, arc = radarPart(group, 'arc').attributes.d, points = radarPoints(arc),
    origin = view.toScreen(reading.x, reading.y), radius = reading.range * view.zoom;
  assert.equal(group.attributes.fill, 'none'); assert(!arc.includes('Z'), 'only the outline is drawn, never an opaque detection area');
  // With no ground told, all of it: up from the foot of the circle, out of the view, and round under the instrument as over it.
  assert.equal(radarPart(group, 'rise').attributes.d, 'M500.0 600.0L500.0 50.0');
  assert.equal(Math.min(...points.map(p => p.x)), 100); assert.equal(Math.max(...points.map(p => p.x)), 900);
  assert.equal(Math.min(...points.map(p => p.y)), 50); assert(points.some(p => p.y > origin.y + 100), 'the circle goes on under the level');
  assert(points.length > 12 && points.length <= 105);
  for (const point of points) {
    assert(point.x >= 0 && point.x <= view.width && point.y >= 0 && point.y <= view.height);
    if (point.y >= view.height) continue;
    assert(Math.abs(Math.hypot(point.x - origin.x, point.y - origin.y) - radius) < .1,
      'the boundary must be the nominal eight kilometres rather than a viewport-sized decorative circle');
  }
  const limits = radarPoints(radarPart(group, 'limits').attributes.d);
  assert(limits.some(p => p.x === 100) && limits.some(p => p.x === 900));
  assert(limits.some(p => p.x === 495 && p.y === 50) && limits.some(p => p.x === 505 && p.y === 50), 'the upper limit has its own tick');
});

test('panning above the selected vehicle retains the visible radar arc while its off-screen origin stays hidden', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = new Camera(1000, 600),
    reading = { id: 'radar', x: 125000, y: 0, range: 8000 }, draw = () => { marks.begin(view); marks.radar(reading, view); marks.end(); };
  Object.assign(view, { x: reading.x, y: 10000, zoom: .05 }); draw();
  const group = root.firstChild, count = made.length;
  assert.equal(radarPart(group, 'origin').attributes.display, 'none'); assert.equal(radarPart(group, 'reach').attributes.d, '');
  assert.equal(radarPart(group, 'rise').attributes.d, 'M500.0 600.0L500.0 400.0');
  assert(radarPoints(radarPart(group, 'arc').attributes.d).some(point => point.x === 500 && point.y === 400));
  for (let i = 0; i < 20; i++) { view.x++; draw(); }
  assert.equal(root.firstChild, group); assert.equal(made.length, count, 'the upper arc reuses the same SVG nodes while the camera moves');
  view.y = 20000; draw(); assert.equal(root.children.length, 0, 'a radar with no visible guide or boundary spends no SVG work');
});

test('radar boundary geometry and SVG work remain bounded by the viewport through zoom and pan', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = new Camera(667, 375),
    reading = Object.freeze({ id: 'radar', x: -125000, y: 2000, range: 8000 }), draw = () => { marks.begin(view); marks.radar(reading, view); marks.end(); };
  for (const [width, height] of [[667, 375], [1600, 900]]) for (const zoom of [.025, .05, .1, 1, 12, 250]) {
    Object.assign(view, { width, height, zoom, x: reading.x, y: reading.y + reading.range - (height / 2 - 100) / zoom });
    draw();
    const group = root.firstChild, arc = radarPart(group, 'arc').attributes.d, points = radarPoints(arc);
    assert(points.length >= 2 && points.length <= 105, 'at most 96 chords plus viewport crossings, regardless of world range');
    assert(arc.length < 4000 && !/NaN|Infinity/.test(arc));
    for (const path of group.children.filter(child => child.tagName === 'path')) for (const point of radarPoints(path.attributes.d))
      assert(point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height, 'only screen-sized geometry reaches the SVG painter');
  }
  const count = made.length, writes = made.reduce((sum, node) => sum + node.writes, 0);
  for (let i = 0; i < 50; i++) draw();
  assert.equal(made.length, count); assert.equal(made.reduce((sum, node) => sum + node.writes, 0), writes, 'an unchanged radar writes no DOM attributes');
});

test('invalid projected radar geometry never reaches SVG attributes', t => {
  const { create } = dom(t), root = create('svg'), marks = new SquadMarks(root), reading = { id: 'radar', x: 0, y: 0, range: 8000 };
  for (const view of [{ width: Infinity, height: 600 }, { width: 1000, height: 600, toScreen: () => ({ x: NaN, y: 300 }) },
    { width: 1000, height: 600, toScreen: () => ({ x: 500, y: 300 }) }]) {
    marks.begin(view); marks.radar(reading, view); marks.end(); assert.equal(root.children.length, 0);
  }
});

test('panning keeps deposit lettering and SVG nodes, changing only their placement', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = camera(),
    deposit = { id: 'silica:1', material: 'silica', active: true, text: 'Sílica · reserva 60 t', detail: '0 kg prontos' };
  const draw = x => { marks.begin(view); marks.deposit(deposit, { x, y: 200 }); marks.end(); };
  draw(300);
  const group = root.firstChild, label = byTag(group, 'text'), detail = group.children.find(child => child !== label && child.tagName === 'text'),
    body = byTag(group, 'path'), letters = label.writes, detailWrites = detail.writes, outline = body.writes, count = made.length;
  assert.equal(label.attributes.y, '-30'); assert.equal(detail.attributes.y, '-14'); assert.equal(detail.textContent, '0 kg prontos');
  for (let i = 0; i < 100; i++) draw(300 + i);
  assert.equal(made.length, count); assert.equal(root.firstChild, group); assert.equal(byTag(group, 'text'), label);
  assert.equal(label.writes, letters); assert.equal(detail.writes, detailWrites); assert.equal(body.writes, outline);
  assert.equal(label.textContent, 'Sílica · reserva 60 t');
  deposit.text = 'Sílica · reserva 59,5 t'; deposit.detail = '500 kg prontos'; draw(400);
  assert.equal(root.firstChild, group); assert.equal(made.length, count); assert.equal(detail.textContent, '500 kg prontos');
  deposit.text = '<silica>'; deposit.detail = ''; deposit.active = false; draw(400);
  assert.equal(label.textContent, '<silica>'); assert.equal(group.attributes['data-active'], 'false');
  assert.equal(label.attributes.y, '-14'); assert.equal(detail.attributes.display, 'none');
  draw(-100); assert.equal(root.children.length, 0, 'off-screen deposits release their nodes');
});

test('dense deposit markers survive above fourteen, with bounded text caches, retained nodes and no repeated measurements during pan', t => {
  const { made, create } = dom(t), root = create('svg'); let measurements = 0;
  const marks = new SquadMarks(root, text => { measurements++; return text.length * 7; }), view = camera(),
    deposits = Array.from({ length: 20 }, (_, i) => ({ id: 'site-' + i, x: 400 + i, material: 'silica', active: true,
      text: 'Sílica · reserva 60 t', detail: '0 kg prontos', shortText: 'Sílica · 60 t', shortDetail: '', priority: 0 }));
  let shift = 0;
  const draw = () => { marks.begin(view); marks.deposits(deposits, deposit => ({ x: deposit.x + shift, y: 200 })); marks.end(); };
  draw(); const count = made.length, calls = measurements, groups = [...root.children];
  assert.equal(groups.length, 20); assert(groups.every(group => byTag(group, 'path')));
  assert(groups.some(group => group.attributes['data-label'] === 'hidden'));
  for (let i = 0; i < 40; i++) { shift++; draw(); }
  assert.equal(made.length, count); assert.equal(measurements, calls); assert.deepEqual(root.children, groups);
  const writes = made.reduce((sum, node) => sum + node.writes, 0);
  for (let i = 0; i < 20; i++) draw();
  assert.equal(made.reduce((sum, node) => sum + node.writes, 0), writes, 'stationary markers perform no DOM writes');
  deposits[0].text = 'Sílica · reserva 59 t'; draw(); assert.equal(measurements, calls + 1);
  for (const mark of marks.marks.values()) assert.equal(Object.keys(mark.widths).length, 4);
  marks.begin(view); marks.end(); assert.equal(marks.marks.size, 0); assert.equal(root.children.length, 0);
});

test('off-screen orders retain only clipped visible lines and reuse their destination icon on return', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = camera();
  const draw = to => { marks.begin(view); marks.line('move', 'truck', { x: 100, y: 100 }, to, .45, 'flag'); marks.end(); };
  draw({ x: 500, y: 100 });
  const group = root.firstChild, line = byTag(group, 'path'), target = byTag(group, 'g'), count = made.length;
  draw({ x: 1e9, y: 100 });
  const numbers = line.attributes.d.match(/-?\d+(?:\.\d+)?/g).map(Number);
  assert(numbers.every(value => Number.isFinite(value) && value >= -MARK_MARGIN && value <= view.width + MARK_MARGIN));
  assert.equal(target.attributes.display, 'none');
  const hiddenWrites = target.writes;
  for (let i = 0; i < 100; i++) draw({ x: 1e9 + i, y: 100 });
  assert.equal(target.writes, hiddenWrites, 'a hidden destination is not moved or rewritten');
  draw({ x: 400, y: 200 }); assert.equal(target.attributes.display, 'inline'); assert.equal(made.length, count);
  marks.begin(view); marks.end(); assert.equal(root.children.length, 0, 'a cancelled order leaves no stale mark');
});

test('contacts and attack targets retain their meaning and change their existing glyph when needed', t => {
  const { create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = camera();
  const draw = (placed, target) => {
    marks.begin(view); marks.heard('scout', { x: 500, y: 200 }, placed);
    marks.line('attack', 'scout', { x: 100, y: 300 }, { x: 500, y: 200 }, 1, target); marks.end();
  };
  draw(false, 'point');
  const contact = root.children.find(child => child.attributes.class === 'heard'), stem = byTag(contact, 'path'),
    attack = root.children.find(child => child.attributes.opacity === '1'), spot = byTag(attack, 'g'), ring = byTag(spot, 'circle');
  assert.equal(stem.attributes.display, 'none'); assert.equal(ring.attributes.r, '9');
  draw(true, 'vehicle'); assert.equal(stem.attributes.display, 'inline'); assert.equal(ring.attributes.r, '16');
  assert.equal(root.children.length, 2); assert.equal(byTag(attack, 'g'), spot);
});

test('encounter bands clip at the viewport, keep their SVG nodes and only update opacity while fading', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = new Camera(1000, 600),
    band = { id: 'contact:one', x: 0, approximate: false, alpha: 1 },
    draw = () => { marks.begin(view); marks.encounter(band, view); marks.end(); };
  view.x = view.y = 0; view.zoom = 10; draw();
  const group = root.firstChild, rectangle = byTag(group, 'rect'), label = byTag(group, 'text'), count = made.length,
    groupWrites = group.writes, rectWrites = rectangle.writes, labelWrites = label.writes;
  assert.equal(label.textContent, 'Encontro'); assert.equal(group.attributes['data-encounter'], band.id);
  for (let i = 0; i < 100; i++) draw();
  assert.equal(made.length, count); assert.equal(group.writes, groupWrites);
  assert.equal(rectangle.writes, rectWrites); assert.equal(label.writes, labelWrites);
  band.alpha = .5; draw();
  assert.equal(group.attributes.opacity, '0.50'); assert.equal(group.writes, groupWrites + 1);
  assert.equal(rectangle.writes, rectWrites); assert.equal(label.writes, labelWrites);
  band.x = -50; draw();
  assert.equal(rectangle.attributes.x, '0.0'); assert.equal(rectangle.attributes.width, '22.0');
  assert(Number(label.attributes.x) >= 8);
  band.x = 50; band.approximate = true; draw();
  assert.equal(Number(rectangle.attributes.x) + Number(rectangle.attributes.width), 1000);
  assert.equal(rectangle.attributes.width, '38.0'); assert.equal(label.textContent, 'Encontro · proximidades');
  assert(Number(label.attributes.x) + 150 <= view.width);
  assert.equal(group.attributes['data-approximate'], 'true'); assert.equal(made.length, count);
  band.x = 50.1; draw(); assert.equal(root.children.length, 0, 'no off-screen arrow or oversized SVG geometry');
  const outsideCount = made.length;
  for (let i = 0; i < 20; i++) draw();
  assert.equal(made.length, outsideCount);
});

test('a negative world position can be in view and expired or invalid bands leave no SVG work', t => {
  const { made, create } = dom(t), root = create('svg'), marks = new SquadMarks(root), view = new Camera(667, 375);
  view.x = -200; view.y = 100; view.zoom = 2;
  const band = { id: 'west', x: -200, approximate: true, alpha: .7 };
  marks.begin(view); marks.encounter(band, view); marks.end();
  assert.equal(root.children.length, 1); assert.equal(byTag(root.firstChild, 'rect').attributes.x, '295.5');
  marks.begin(view); marks.end(); assert.equal(root.children.length, 0);
  const count = made.length;
  for (const one of [{ ...band, alpha: 0 }, { ...band, x: NaN }]) {
    marks.begin(view); marks.encounter(one, view); marks.end();
  }
  marks.begin(view); marks.end(); assert.equal(made.length, count);
});

test('vehicle tags stop writing outside the viewport and regain their current state on return', t => {
  const { create } = dom(t), view = new Camera(1000, 600), tag = create('div'); view.x = view.y = 0; view.zoom = 10;
  tag.append(create('b'), create('span'));
  const bounds = { minX: -4, maxX: 4, minY: -1, maxY: 2 }, flags = { selected: false, manual: false, alert: false, heard: false };
  updateSquadTag(tag, squadTagBox(view, bounds), flags); assert.equal(tag.hidden, false);
  const writes = tag.writes;
  updateSquadTag(tag, squadTagBox(view, bounds), flags); assert.equal(tag.writes, writes);
  view.x = 10000; updateSquadTag(tag, squadTagBox(view, bounds), flags); assert.equal(tag.hidden, true);
  const hiddenWrites = tag.writes;
  view.zoom = 1;
  for (let i = 0; i < 100; i++) { view.x++; updateSquadTag(tag, squadTagBox(view, bounds), { ...flags, selected: true }); }
  assert.equal(tag.writes, hiddenWrites);
  view.x = 0; updateSquadTag(tag, squadTagBox(view, bounds), { ...flags, selected: true, alert: true });
  assert.equal(tag.hidden, false); assert.deepEqual([tag.dataset.selected, tag.dataset.alert], ['true', 'true']);
  assert.equal(tag.firstChild.textContent, '', 'a vehicle carries no number');
});

test('field tags carry no number: picking through the column marks them, alerts stay on them and a still tag writes nothing', t => {
  const { create } = dom(t), viewport = create('div'), sidebar = create('aside'), panel = create('div'), canvas = create('canvas'), clicks = [],
    before = { window: globalThis.window, observer: globalThis.ResizeObserver, frame: globalThis.requestAnimationFrame };
  document.querySelector = selector => ({ '#viewport': viewport, '.sidebar': sidebar, '#field-pawns': panel })[selector];
  panel.addEventListener = (type, listener) => { if (type === 'click') clicks.push(listener); }; canvas.focus = () => {};
  globalThis.window = { addEventListener() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => { throw new Error('Tags must follow the main loop without another frame'); };
  t.after(() => { globalThis.window = before.window; globalThis.ResizeObserver = before.observer; globalThis.requestAnimationFrame = before.frame; });
  const view = new Camera(667, 375); view.x = view.y = 0; view.zoom = 5;
  const actors = [0, 8].map((x, i) => ({ id: 'v' + i, ownerId: 'p', team: 'f', vehicle: { x, y: 0 } })),
    squad = { units: actors.map(actor => ({ id: actor.id, alert: true })), out: [], manual: null },
    state = { shared: true, actors, squad, localPlayerId: 'p', faction: { id: 'f', deposits: [] }, modules: [], plates: [] }, beforeState = structuredClone(state),
    renderer = { state, canvas, camera: view, scene: null, markHeight: () => 0, ground: { length: 20000, center: 0, features: [] } },
    ux = initSquadUX({ renderer, view: { mode: 'test' }, command: () => { throw new Error('Marking tags must not send orders'); },
      refresh() {}, toast() {}, alert() {}, stopControls() {}, sendAim() {} }),
    click = (dataset, keys = {}) => { const button = { dataset, disabled: false }, event = { ...keys, target: { closest: selector => selector === 'button[data-act]' ? button : null } };
      for (const listener of clicks) listener(event); ux.follow(); };
  ux.follow();
  const overlay = viewport.children.find(child => child.className === 'squad-overlay'), tags = overlay.children.filter(child => child.className === 'squad-tag');
  assert.deepEqual(tags.map(tag => tag.firstChild.textContent), ['', '']);
  assert.deepEqual(tags.map(tag => tag.dataset.alert), ['true', 'true']);
  const writes = tags.map(tag => tag.writes);
  for (let i = 0; i < 20; i++) ux.follow();
  assert.deepEqual(tags.map(tag => tag.writes), writes, 'a stationary tag performs no DOM rewrites');
  assert.deepEqual([...ux.marked()], [], 'nothing picked is edged in the dark of every vehicle');
  click({ act: 'unit', id: 'v0' }); click({ act: 'unit', id: 'v1' }, { shiftKey: true });
  assert.deepEqual(ux.picked(), ['v0', 'v1']);
  assert.deepEqual([...ux.marked()], [['v0', 'selected'], ['v1', 'selected']]);
  assert.deepEqual(tags.map(tag => tag.dataset.selected), ['true', 'true']);
  click({ act: 'unit', id: 'v0' });
  assert.deepEqual(tags.map(tag => tag.dataset.selected), ['true', 'false']);
  assert.deepEqual([...ux.opened()], ['v0'], 'the vehicle picked is seen from inside');
  squad.manual = 'v1'; ux.follow(); assert.equal(tags[1].dataset.manual, 'true');
  assert.deepEqual([[...ux.opened()], [...ux.marked()]], [[], []], 'the vehicle in hand is seen from outside, with the dark edge of every vehicle');
  squad.manual = null;
  assert.deepEqual(state, beforeState);
});

test('the squad creates tags only for vehicles entering the viewport and preserves its command state', t => {
  const { create } = dom(t), viewport = create('div'), sidebar = create('aside'), panel = create('div'), canvas = create('canvas'),
    before = { window: globalThis.window, observer: globalThis.ResizeObserver, frame: globalThis.requestAnimationFrame };
  document.querySelector = selector => ({ '#viewport': viewport, '.sidebar': sidebar, '#field-pawns': panel })[selector];
  globalThis.window = { addEventListener() {} }; globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.requestAnimationFrame = () => { throw new Error('Visual marks must follow the main loop without scheduling another frame'); };
  t.after(() => { globalThis.window = before.window; globalThis.ResizeObserver = before.observer; globalThis.requestAnimationFrame = before.frame; });
  const view = new Camera(1000, 600); view.x = view.y = 0; view.zoom = 10;
  const actors = [0, 10000].map((x, i) => ({ id: 'v' + i, ownerId: 'p', team: 'f', vehicle: { x, y: 0 } })),
    squad = { units: actors.map(actor => ({ id: actor.id })), out: [], manual: null },
    state = { shared: true, actors, squad, localPlayerId: 'p', faction: { id: 'f', deposits: [] }, modules: [], plates: [] }, beforeState = structuredClone(state),
    renderer = { state, canvas, camera: view, scene: null, markHeight: () => 0, ground: { length: 20000, center: 0, features: [] } };
  const mode = { mode: 'test' }, ux = initSquadUX({ renderer, view: mode, command: () => { throw new Error('Drawing must not send commands'); }, refresh() {}, toast() {}, alert() {}, stopControls() {}, sendAim() {} });
  ux.follow();
  const overlay = viewport.children.find(child => child.className === 'squad-overlay'), tags = () => overlay.children.filter(child => child.className === 'squad-tag');
  assert.equal(tags().length, 1);
  view.x = 10000; ux.follow(); assert.equal(tags().length, 2); assert.equal(tags()[0].hidden, true); assert.equal(tags()[1].hidden, false);
  const first = tags()[0], writes = first.writes, feedback = first.children[1], feedbackWrites = feedback.writes;
  for (let i = 0; i < 20; i++) { view.x++; ux.follow(); }
  assert.equal(first.writes, writes); assert.equal(feedback.writes, feedbackWrites, 'off-screen feedback performs no DOM writes');
  assert.deepEqual(state, beforeState);
  // The main loop has sampled the displayed poses before asking the markers to follow.
  view.x = 0; renderer.scene = { actor: id => ({ x: id === 'v0' ? 10000 : 0, y: 0 }) }; ux.follow();
  assert.equal(tags()[0].hidden, true); assert.equal(tags()[1].hidden, false);
  mode.mode = 'edit'; ux.follow(); assert.equal(overlay.hidden, true); assert.equal(tags().length, 0);
  mode.mode = 'test'; ux.follow(); assert.equal(overlay.hidden, false); assert.equal(tags().length, 1);
  assert.equal(tags()[0].hidden, false); assert.deepEqual(state, beforeState);
  const encounter = { id: 'nearby', x: 0, approximate: true, alpha: 1 }, svg = byTag(overlay, 'svg');
  ux.follow([encounter]); assert.equal(svg.children.filter(child => child.attributes.class === 'encounter-band').length, 1);
  squad.units = []; ux.follow([encounter]);
  assert.equal(overlay.hidden, false, 'a recent encounter remains visible even when the last vehicle was lost');
  ux.follow(); assert.equal(overlay.hidden, true); assert.equal(svg.children.length, 0);
  mode.mode = 'edit'; ux.follow([encounter]); assert.equal(overlay.hidden, true); assert.equal(svg.children.length, 0);
});
