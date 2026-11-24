import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PLACEMENT_FIELDS, TEST_FIELDS, fieldHTML } from '../src/ui-fields.ts';
const read = file => readFileSync(new URL(file, import.meta.url), 'utf8');
import { Editor } from '../src/editor.ts';
import { addRoom } from './fixtures/rooms.js';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CONSTRUCTION_TEMPLATES, FIXTURE_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { isWorkshopDesign, workshopDraft } from '../src/persistence.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { World } from '../src/physics.ts';
import { screenModel } from '../src/ui-model.ts';
import { installedPower } from '../src/mass-properties.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { setPart } from './mechanical-queries.js';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { power } from '../src/format.ts';
import { RANGE_NOTE } from '../src/workshop-context.ts';

await initNativeDynamics();

const editor = () => new Editor(createStructuredConstruction());
const model = (e, view = {}) => {
  const blueprint = e.blueprint;
  return screenModel({ editor: e, view: { mode: 'edit', buildTool: 'select', testTool: 'fire', follow: 'none', weapon: { preset: 'rh120', platform: 'ground' },
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' }, ...view },
    state: null, network: { enabled: false, connected: false, designs: new Map() },
    session: { paused: true, speed: 1, testDistance: 0, physicsMs: 0 }, terrainId: MAIN_WORLD.terrain, sound: { enabled: false, volume: .4 } });
};
test('the side panel offers the components to install, project controls and paint choices', () => {
  const html = read('../index.html') + [...PLACEMENT_FIELDS, ...TEST_FIELDS].map(fieldHTML).join('');
  // Adicionar holds what is installed: selecting is the workbench's own, and the chassis is in the list of pieces (or R).
  assert(!html.includes('id="chassis-tool"')); assert(!html.includes('data-tool=')); assert(!html.includes('id="room-hint"'));
  // What stays is chosen: the project — its models and its copies are in the garage —, the paint; its cost is among the figures.
  // Every hull has its skin: there is nothing to turn it off.
  for (const id of ['garage', 'body-paint', 'workshop-part-list'])
    assert(html.includes(`id="${id}"`), id);
  // The paint is any colour, with those of the workshop offered first.
  assert.match(html, /<input id="body-paint" type="color" list="body-paints"/); assert.equal(html.match(/<datalist id="body-paints">(<option value="#[0-9a-f]{6}" label="[^"]+"><\/option>){4}<\/datalist>/)?.length, 2);
});

test('the project figures tell weight, installed power, range and top speed without changing the design', () => {
  const e = new Editor(createStructuredTemplate('heavy')), before = structuredClone(e.source), c = model(e);
  assert.deepEqual(c.figures.map(figure => figure.label), ['PESO', 'POTÊNCIA', 'AUTONOMIA', 'MÁXIMA ESTIMADA']);
  assert.match(c.figures[0].value, / t$/); assert.equal(c.figures[1].value, power(installedPower(e.blueprint)));
  assert.match(c.figures[1].title, /^Todos os motores · [\d,]+ hp\/t$/);
  assert.match(c.figures[2].value, / km$/); assert.equal(c.figures[2].title, RANGE_NOTE); assert.match(c.figures[3].value, / km\/h$/);
  // The top speed is an estimate on firm, level ground, whatever holds it: no word of what does.
  for (const id of ['heavy', 'tracked', 'scout']) {
    const { value, ...top } = model(new Editor(createStructuredTemplate(id))).figures[3];
    assert.match(value, / km\/h$/); assert.deepEqual(top, { label: 'MÁXIMA ESTIMADA', title: 'Em piso firme e plano.' }, id);
  }
  assert(!c.figures.some(figure => ['CUSTO', 'AERODINÂMICA'].includes(figure.label)));
  assert.equal(c.figures[0].over, e.blueprint.chassis.loadedKg > e.blueprint.chassis.limitKg,
    'the weight figure reports the actual full-load admission of its chassis');
  assert(c.figures.slice(1).every(figure => !Object.hasOwn(figure, 'over')), 'weight warnings do not decorate unrelated readings');
  assert.deepEqual(model(e, { mode: 'test' }).figures, [], 'the chips are of the bench');
  assert.deepEqual(e.source, before);
});

test('the room button is the editor command, and the room goes again through any plate that closes it outside', () => {
  const e = editor(), bare = structuredClone(e.source);
  e.commit(); addRoom(e);
  const room = e.blueprint.rooms[1], stood = structuredClone(e.source), walls = room.walls.filter(wall => wall.exterior).map(wall => wall.id);
  assert.equal(walls.length, 3);
  // Explicit room removal leaves the other authored spans, including existing divisions, untouched.
  for (const id of walls) {
    assert.equal(e.removeRoom(id), 1); assert.equal(e.blueprint.rooms.length, 1);
    assert.deepEqual(e.source.plates, stood.plates.filter(plate => !walls.includes(plate.id)));
    assert.deepEqual(e.source.components, bare.components); assert.equal(e.past.length, 2);
    assert(e.undo()); assert.deepEqual(e.source, stood);
  }
});

test('the workshop opens vehicles and fixed defences', () => {
  for (const { id } of CONSTRUCTION_TEMPLATES) {
    const source = createStructuredTemplate(id);
    assert(isWorkshopDesign(source), id); assert.equal(workshopDraft(source), source);
    assert.deepEqual(new Editor(source).source, source);
  }
  assert.throws(() => workshopDraft({ preset: 'unknown' }), { code: 'NOT_A_CONSTRUCTION' });
});

test('the workshop preserves an imported source while Native supplies omitted component and detail angles', () => {
  const raw = createStructuredTemplate('scout'), component = raw.components.find(part => part.kind === 'engine'),
    detail = raw.appearance.details.find(part => part.angle === 0);
  delete component.pose.angle; delete detail.angle;
  const before = structuredClone(raw), source = workshopDraft(raw);
  assert.equal(source, raw, 'opening a draft does not normalize or replace the imported source');
  const document = new Editor(source).source;
  assert.equal(document.components.find(part => part.id === component.id).pose.angle, 0);
  assert.equal(document.appearance.details.find(part => part.id === detail.id).angle, 0);
  assert.deepEqual(raw, before, 'Native defaults belong to the editor document, leaving the imported source untouched');
});

test('the test on the terrain is on one ground, the one a fresh install has, the test of armour on flat ground', () => {
  assert.deepEqual([MAIN_WORLD.terrain, MAIN_WORLD.seed, MAIN_WORLD.mapLength], ['world', 6173, 512000]);
  // The model is told the ground; it has no control to change it with.
  const e = editor(), c = model(e, { mode: 'test' });
  assert.equal(c.terrain, 'world'); assert.equal(Object.keys(c.bindings).some(id => id.startsWith('terrain')), false);
  // The test of armour is told its flat ground.
  const blueprint = e.blueprint,
    armour = screenModel({ editor: e, terrainId: 'flat', view: { mode: 'test', trial: 'armour', buildTool: 'select', testTool: 'fire', follow: 'none',
      weapon: { preset: 'rh120', platform: 'ground' }, placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } },
      state: null, network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0, physicsMs: 0 },
      sound: { enabled: false, volume: .4 } });
  assert.equal(armour.terrain, 'flat');
});

test('the lab fixtures keep editable frames with plate thickness and undo', () => {
 for (const id of ['plate', 'bunker', 'empty']) {
  const e = new Editor({ ...createStructuredTemplate(id), components: [] }), before = structuredClone(e.source);
  e.select(e.blueprint.plates.find(p => p.id === 'hull:roof').id);
  e.editProperty('length', 1, true); assert(Math.abs(e.selected.length - 1) < 1e-9);
  assert(e.undo()); assert.deepEqual(e.source, before);
  e.select(e.blueprint.plates[0].id);
  e.editProperty('thicknessMm', 110, true); assert.equal(e.selected.thicknessMm, 110);
  assert(e.undo()); assert.deepEqual(e.source, before);
 }
});

test('the inspection of a test tells the damage of the piece picked on the line under the field, read-only, and the workshop tells none', t => {
 const e = new Editor(createStructuredTemplate('scout')), world = new World(e.source); t.after(() => world.dispose());
 const engine = world.modules.find(part => part.kind === 'engine'); setPart(world, engine, { health: 0 });
 const plate = world.plates.find(part => part.definition.material === 'steel');
 e.select(engine.id);
 const state = world.snapshot(), before = structuredClone(state), source = structuredClone(e.source);
 const inspected = (view, touch = false, seen = state) => {
   const blueprint = e.blueprint;
   return screenModel({ editor: e, touch, state: seen, network: { enabled: false, connected: false, designs: new Map() },
     view: { mode: 'test', trial: 'armour', buildTool: 'select', testTool: 'inspect', follow: 'none', weapon: { preset: 'rh120', platform: 'ground' },
       placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' }, ...view },
     session: { paused: false, speed: 1, testDistance: 0, physicsMs: 0 }, terrainId: 'flat', sound: { enabled: false, volume: .4 } });
 };
 const c = inspected();
 assert.equal(c.inspection.title, 'Motor'); assert.equal(c.inspection.detail, '0% · Inutilizado'); assert.ok(c.inspection.color);
 assert.equal(c.gunTold, false, 'the line tells the piece in place of the gun');
 assert.equal(c.bindings.inspect.hidden, false); assert.equal(c.bindings.inspect.attr['aria-pressed'], true);
 assert.deepEqual(state, before); assert.deepEqual(e.source, source);
 // A plate is told with its thickness.
 e.select(plate.id);
 assert.match(inspected().inspection.title, new RegExp(` · ${plate.definition.thicknessMm} mm$`));
 // With nothing picked, the line says how to pick a piece: by the mouse or by a finger.
 e.select([]);
 assert.deepEqual(inspected().inspection, { title: 'Clique numa peça para ver os danos', detail: '', color: '' });
 assert.equal(inspected({}, true).inspection.title, 'Toque numa peça para ver os danos');
 // Firing, the line is the gun's; in the workshop there is no inspection.
 const firing = inspected({ testTool: 'fire' });
 assert.equal(firing.inspection, null); assert.equal(firing.bindings.inspect.attr['aria-pressed'], false);
 assert.equal(inspected({ mode: 'edit' }, false, null).inspection, null);
});

test('a design that does not see out ahead is told so where its problems are told, and one that does is told nothing', () => {
  const none = 'Sem visão à frente: ponha uma câmera por fora ou um vidro blindado.', behind = 'Sem visão à frente: só vê para trás.',
    e = editor(), range = SENSOR_MODES.visual.range, told = view => model(e, view).bindings['construction-feedback'].text, wall = (id, material) => { e.select(id); e.editProperty('material', material, true); };
  // A frame with no command post is no construction yet: nothing is said of what it sees.
  assert.equal(told(), '');
  // Its command post shut in steel, and a camera in the room with it: neither sees out.
  e.addModule('command', { x: 12, y: 1.4 }); assert.equal(told(), none);
  const camera = e.addModule('sensor', { x: 10.5, y: 1.6 }, { sensorMode: 'visual' });
  assert(e.source.components.at(-1).pose); assert.deepEqual(e.blueprint.eyes, []); assert.equal(told(), none);
  // The wall before them of glass, both see ahead: the line goes. The one behind them alone, they see behind.
  wall('hull:front', 'glass'); assert.deepEqual(e.blueprint.eyes.map(eye => [eye.left, eye.right]), [[650, 0], [range, 0]]); assert.equal(told(), '');
  wall('hull:rear', 'glass'); assert.deepEqual(e.blueprint.eyes.map(eye => [eye.left, eye.right]), [[650, 650], [range, range]]); assert.equal(told(), '');
  wall('hull:front', 'steel'); assert.deepEqual(e.blueprint.eyes.map(eye => [eye.left, eye.right]), [[0, 650], [0, range]]); assert.equal(told(), behind);
  wall('hull:rear', 'steel'); assert.equal(told(), none);
  // On the test nothing is said of the design.
  assert.equal(told({ mode: 'test' }), '');
  // Copies retain their explicit pose; changing sensing mode does not relocate them.
  e.select(camera.id); const intent = e.duplicate(), copy = e.addModule(intent.kind, { x: 13.5, y: 1.6 }, intent);
  assert(e.source.components.find(part => part.id === copy.id).pose);
  const pose = structuredClone(e.source.components.find(part => part.id === copy.id).pose);
  e.editProperty('sensorMode', 'radar', true);
  assert.deepEqual(e.source.components.find(part => part.id === copy.id).pose, pose);
  assert.equal(told(), none);
  e.remove();
  // Radar stays at the requested pose. Only an unobstructed visual camera supplies optical sight.
  e.addModule('sensor', { x: 13, y: 1.6 }, { sensorMode: 'radar' });
  assert.deepEqual(e.source.components.at(-1).pose, { x: 20, y: 6, angle: 0 }); assert.equal(told(), none); // 1 m, .3 m, in cells
  const roof = e.plateSpans().find(plate => plate.id === 'hull:roof');
  e.addModule('sensor', { x: 11.6, y: Math.max(roof.a.y, roof.b.y) + .2 }, { sensorMode: 'visual' });
  assert.deepEqual([e.blueprint.eyes.map(eye => [eye.left, eye.right]), told()], [[[range, range]], '']);
  // None of the models the garage offers, nor of the structures of the lab, is told it is blind.
  for (const { id } of [...CONSTRUCTION_TEMPLATES, ...FIXTURE_TEMPLATES])
    assert.equal(model(new Editor(createStructuredTemplate(id))).bindings['construction-feedback'].text, '', id);
});
