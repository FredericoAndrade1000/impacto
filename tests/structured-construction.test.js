import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredConstruction, validateStructuredConstruction, compileStructuredConstruction,
  compileDraftConstruction, planStructuredComponent, structuredPlacementIntent, CONSTRUCTION_ORIGIN } from '../src/structured-construction.ts';
import { DESIGN_VERSION, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { componentVolume } from '../src/component-volume.ts';
import { BODY_WIDTH, componentSizeLimits } from '../src/component-size.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';
import { metresOf } from '../src/grid.ts';
import { joinContacts } from '../src/frame-editing.ts';
await initNativeDynamics();

const fixed = options => createStructuredConstruction({ preset: 'bunker', ...options });
// Poses and nodes are written in cells of 5 cm (grid.ts).
const part = (id, kind, x, y, options = {}) => ({ id, kind, ...options, pose: { x, y, angle: 0 } });
const plate = (id, a, b, thicknessMm = 40) => ({ id, a, b, material: 'steel', thicknessMm });
const towered = () => {
  const source = fixed(), y = source.nodes[2].y;
  source.nodes.push({ id: 'tower-0', x: -16, y }, { id: 'tower-1', x: 24, y },
    { id: 'tower-2', x: 22, y: y + 16 }, { id: 'tower-3', x: -12, y: y + 16 });
  source.plates.splice(2, 1, plate('hull:roof', 'hull-2', 'tower-1'), plate('tower:floor', 'tower-1', 'tower-0'), plate('hull:deck', 'tower-0', 'hull-3'));
  source.plates.push(plate('tower:rear', 'tower-1', 'tower-2', 30), plate('tower:roof', 'tower-2', 'tower-3', 25), plate('tower:front', 'tower-3', 'tower-0', 50));
  return source;
};

test('canonical saves contain only authored geometry, poses and stable identities', () => {
  const source = planStructuredComponent(fixed(), part('engine', 'engine', 0, 2, { sizeScale: 1.3 })).construction,
    before = structuredClone(source), compiled = compileStructuredConstruction(source);
  assert.deepEqual(source, before); assert.deepEqual(compileStructuredConstruction(source), compiled);
  assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source);
  assert.equal(compiled.derived, true); assert.equal(compiled.plates[0].id, 'hull:floor');
  assert.equal(compiled.modules[0].id, 'engine');
  for (const field of ['modules', 'rooms', 'frame', 'mountId', 'anchors', 'width', 'height', 'rideHeight']) assert.equal(Object.hasOwn(source, field), false, field);
  assert.equal(Object.hasOwn(source.components[0], 'placement'), false);
  assert.throws(() => serializeBlueprint(compiled), /não é um projeto desta versão/);
  assert.deepEqual(compiled.frame.origin, CONSTRUCTION_ORIGIN);
  assert.deepEqual(compiled.frame.nodes, source.nodes.map(node => ({ id: node.id, x: CONSTRUCTION_ORIGIN.x + metresOf(node.x), y: CONSTRUCTION_ORIGIN.y + metresOf(node.y) })));
  assert.equal(compiled.rooms.length, 1);
});

test('plate armour changes mass and thickness without moving unselected geometry', () => {
  const source = createStructuredConstruction({ thicknessMm: 8 }), before = compileDraftConstruction(source), changed = structuredClone(source);
  assert.deepEqual(source.chassis.topPlate, { material: 'steel', thicknessMm: 8 });
  assert(!source.plates.some(plate => plate.id === 'hull:floor'));
  assert(before.rooms.some(room => room.walls.some(wall => wall.id === 'chassis:top-0')));
  changed.plates.find(plate => plate.id === 'hull:front').thicknessMm = 40;
  const after = compileDraftConstruction(changed);
  assert.deepEqual(after.frame.origin, before.frame.origin); assert.deepEqual(after.frame.nodes, before.frame.nodes);
  assert.equal(after.plates.find(plate => plate.id === 'hull:roof').y, before.plates.find(plate => plate.id === 'hull:roof').y);
  assert(pieceMass(after.plates.find(plate => plate.id === 'hull:front')) > pieceMass(before.plates.find(plate => plate.id === 'hull:front')));
  assert.equal(after.plates[0].widthM, BODY_WIDTH);
});

test('open and isolated plates derive topology without rewriting source, and braces only once divided where they meet', () => {
  const source = fixed(), opened = { ...source, plates: source.plates.slice(0, -1) };
  assert.equal(compileStructuredConstruction(opened).rooms.length, 0);
  const loose = { ...source, nodes: [...source.nodes, { id: 'loose-a', x: 70, y: -8 }, { id: 'loose-b', x: 90, y: -8 }],
    plates: [...source.plates, plate('loose', 'loose-a', 'loose-b')] }, before = structuredClone(loose);
  assert.equal(compileStructuredConstruction(loose).rooms.length, 1); assert.deepEqual(validateStructuredConstruction(loose), before);
  // Braces from the middle of each wall to the middle of the one across, ends on the walls and crossing each other.
  const braced = { ...source, nodes: [...source.nodes, { id: 'low', x: 0, y: -12 }, { id: 'high', x: 4, y: 20 }, { id: 'back', x: 53, y: 4 }, { id: 'fore', x: -49, y: 4 }],
    plates: [...source.plates, plate('brace-a', 'low', 'high'), plate('brace-b', 'back', 'fore')] };
  assert.throws(() => compileStructuredConstruction(braced), { reason: 'PLATE_JUNCTION', ids: ['hull:floor'], nodeIds: ['low'] });
  // The walls divided where the braces stand on them, the braces still crossing.
  const divided = (plates, id, at) => plates.flatMap(one => one.id === id ? [{ ...one, b: at }, { ...one, id: id + '-2', a: at }] : [one]),
    walls = [['hull:floor', 'low'], ['hull:rear', 'back'], ['hull:roof', 'high'], ['hull:front', 'fore']].reduce((plates, [id, at]) => divided(plates, id, at), braced.plates);
  assert.throws(() => compileStructuredConstruction({ ...braced, plates: walls }), { reason: 'PLATE_CROSSING' });
  const joined = joinContacts(braced).source, raw = structuredClone(joined), compiled = compileStructuredConstruction(joined);
  assert.equal(compiled.rooms.length, 4); assert.deepEqual(validateStructuredConstruction(joined), raw);
  assert.equal(compiled.frame.nodes.length, joined.nodes.length, 'the compiler adds no node of its own');
  assert.equal(joined.plates.length, source.plates.length * 2 + 4);
});

test('invalid identities, dimensions and derived authoring remain explicit errors', () => {
  const source = fixed();
  for (const [mutate, reason] of [
    [s => s.plates.push(plate('again', 'hull-1', 'hull-0')), { reason: 'PLATE_REPEATED' }],
    [s => { s.plates[1].b = 'nowhere'; }, { reason: 'PLATE_NODE' }],
    [s => { s.nodes[2].x = 400; }, { reason: 'FIELD', field: 'x' }],
    [s => { s.nodes[1].y = -28; }, { reason: 'AUTHORING_EXTENT', side: 'below', nodeIds: [source.nodes[1].id] }],
    [s => { s.nodes[1].y = 136; }, { reason: 'AUTHORING_EXTENT', side: 'above', nodeIds: [source.nodes[1].id] }],
    [s => { s.plates[0].thicknessMm = 1001; }, { reason: 'FIELD', field: 'thicknessMm' }],
    [s => { s.nodes[1].id = s.nodes[0].id; }, { reason: 'NODE_IDENTITY' }],
    [s => s.nodes.push({ id: 'hull:floor', x: 0, y: 60 }), { reason: 'PLATE_IDENTITY' }],
    [s => { for (let i = 0; i < 61; i++) s.nodes.push({ id: 'spare-' + i, x: 0, y: 20 }); }, { reason: 'AUTHORING_LIMIT' }],
    [s => { s.rooms = []; }, { reason: 'AUTHORING_FIELDS' }],
    [s => { s.nodes[0].owner = 1; }, { reason: 'AUTHORING_FIELDS' }],
    [s => { s.plates[1].mountId = 'hull:floor'; }, { reason: 'AUTHORING_FIELDS' }],
  ]) { const broken = structuredClone(source); mutate(broken); assert.throws(() => validateStructuredConstruction(broken), reason); }
});

test('free poses preserve physical dimensions, reserve, mass and real overlap checks', () => {
  const source = planStructuredComponent(fixed(), part('tank', 'fuel', -18, 2, { sizeScale: 1.15 })).construction,
    module = compileStructuredConstruction(source).modules[0];
  assert.equal(module.width, .8 * 1.15); assert.equal(module.height, .72 * 1.15); assert.equal(module.fuelLitres, module.capacityLitres);
  assert.equal(componentVolume(module), componentVolume({ ...module, x: 0, y: 0 }));
  // To the cell nearest the .135 m it once went to, turned.
  const moved = planStructuredComponent(source, { ...source.components[0], pose: { x: 3, y: 2, angle: .2 } });
  assert.equal(pieceMass(moved.compiled.modules[0]), pieceMass(module)); assert.equal(moved.component.pose.x, 3);
  assert.throws(() => planStructuredComponent(source, part('duplicate', 'fuel', -18, 2)), { reason: 'CONSTRUCTION_OVERLAP' });
  assert.throws(() => planStructuredComponent(source, part('outside', 'engine', 242, 0)), { reason: 'FIELD' });
});

test('the side view holds a component to 4 m, as deep across the body as its kind at any size', () => {
  const source = fixed({ length: 8, height: 4, thicknessMm: 20 }), largest = componentSizeLimits({ kind: 'engine' }).max,
    engine = scale => part('engine', 'engine', 0, 30, { sizeScale: scale });
  assert.equal(largest, 3.8);
  const fitted = planStructuredComponent(source, engine(largest)).compiled.modules[0];
  // Its size makes it longer and taller alone: 3.99 m long at the most, 0.65 m deep as at 100 %.
  assert(fitted.mechanicalDepth === .65 && fitted.mechanicalDepth < BODY_WIDTH && fitted.width < 4 && fitted.width > 4 - .05 * 1.05 && fitted.height < 4);
  assert.throws(() => planStructuredComponent(source, engine(largest + .05)), { reason: 'FIELD', field: 'sizeScale' });
});

test('one real divider separates two derived rooms while loose parts remain independent', () => {
  const source = towered(), roof = source.nodes[2].y; source.components.push(part('command', 'command', 4, roof + 8));
  const compiled = compileStructuredConstruction(source), shared = compiled.rooms.flatMap(room => room.walls).filter(wall => wall.id === 'tower:floor');
  assert.equal(compiled.rooms.length, 2); assert.equal(shared.length, 2); assert(shared.every(wall => wall.exterior === false));
  assert.equal(new Set(shared.map(wall => wall.owner)).size, 1); assert.equal(compiled.plates.filter(plate => plate.id === 'tower:floor').length, 1);
  assert(Math.abs(compiled.modules[0].y - (CONSTRUCTION_ORIGIN.y + metresOf(roof + 8))) < 1e-9);
  const opened = { ...source, plates: source.plates.filter(plate => plate.id !== 'tower:roof') };
  assert.equal(compileStructuredConstruction(opened).rooms.length, 1);
  assert.deepEqual(validateStructuredConstruction(opened).components, validateStructuredConstruction(source).components);
});

test('cursor intent snaps directly without requiring a room or a face', () => {
  // To the nearest cell of 5 cm: 1.25 m, -.85 m.
  for (const kind of ['engine', 'sensor', 'blade', 'paver'])
    assert.deepEqual(structuredPlacementIntent({ id: kind, kind }, { x: 13.23, y: .46 }), { x: 25, y: -17, angle: 0 });
});

test('an enclosed camera retains physical visibility through glass', () => {
  const source = fixed(), camera = part('camera', 'sensor', -30, 6, { sensorMode: 'visual' }),
    inside = planStructuredComponent(source, camera).construction, compiled = compileStructuredConstruction(inside),
    visible = wall => compileStructuredConstruction({ ...inside, plates: inside.plates.map(plate => plate.id === wall ? { ...plate, material: 'glass' } : plate) }).eyes,
    position = { x: 10.5, y: 1.6 }, range = SENSOR_MODES.visual.range;
  assert.deepEqual(compiled.eyes, []);
  assert.deepEqual(visible('hull:front'), [{ ...position, left: range, right: 0 }]);
  assert.deepEqual(visible('hull:rear'), [{ ...position, left: 0, right: range }]);
  assert.deepEqual([visible('hull:roof'), visible('hull:floor')], [[], []]);
});

test('rotation keeps component ordering, dimensions and mass', () => {
  let source = planStructuredComponent(fixed(), part('engine', 'engine', 16, 2)).construction;
  source = planStructuredComponent(source, part('command', 'command', -26, 2)).construction;
  const moved = planStructuredComponent(source, { ...source.components[0], pose: { ...source.components[0].pose, angle: Math.PI / 2 } }).construction,
    before = compileStructuredConstruction(source).modules[0], after = compileStructuredConstruction(moved).modules[0];
  assert.deepEqual(moved.components.map(part => part.id), ['engine', 'command']);
  assert.equal(after.angle, Math.PI / 2); assert.equal(after.width, before.width); assert.equal(after.height, before.height); assert.equal(pieceMass(after), pieceMass(before));
  assert.throws(() => validateStructuredConstruction({ ...source, components: [...source.components, source.components[0]] }), { reason: 'COMPONENT_IDENTITY' });
});

for (const template of ['heavy', 'scout', 'recon', 'mortar', 'howitzer', 'ifv', 'chassis']) test(`new ${template} template has one native construction source`, () => {
  const source = createStructuredTemplate(template), before = structuredClone(source), compiled = compileStructuredConstruction(source);
  assert.equal(source.version, DESIGN_VERSION); assert.deepEqual(source, before);
  assert.deepEqual(compiled.modules.map(part => part.id), [...source.components.map(part => part.id), ...compiled.chassis.gear]);
  assert(compiled.modules.every(part => part.physicalMass > 0));
  for (const gun of compiled.modules.filter(part => part.kind === 'weapon')) { assertMountProjection(gun); assert.equal(gun.barrelAngle, gun.angle + gun.aimOffset); }
});
test('unsupported authoring versions are refused without changing their source', () => {
  for (const version of [DESIGN_VERSION - 1, DESIGN_VERSION + 1]) {
    const source = { ...fixed(), version }, before = structuredClone(source);
    assert.throws(() => validateStructuredConstruction(source), { reason: 'CONSTRUCTION_VERSION' });
    assert.throws(() => parseBlueprint(JSON.stringify(source)), { code: 'DESIGN_VERSION' });
    assert.deepEqual(source, before);
  }
});
test('terrain survives canonical validation and compilation as one source field', () => {
  const source = { ...fixed(), terrain: 'wet-valley' }, canonical = validateStructuredConstruction(source), compiled = compileStructuredConstruction(canonical);
  assert.equal(canonical.terrain, 'wet-valley'); assert.equal(compiled.terrain, canonical.terrain);
  assert.equal(validateStructuredConstruction({ ...source, terrain: 'future-map' }).terrain, 'future-map');
  assert.throws(() => validateStructuredConstruction({ ...source, terrain: '' }), { reason: 'TERRAIN' });
});
