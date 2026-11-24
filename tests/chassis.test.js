import test from 'node:test';
import assert from 'node:assert/strict';
import { CHASSIS_MODELS, chassisLabel, chassisName, chassisSpec } from '../src/chassis.ts';
import { constructionCatalogue } from '../src/construction-admission.ts';
import { compileNativeConstruction, initNativeDynamics } from '../src/native-dynamics.ts';
import { DESIGN_VERSION, compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { blueprintPowertrain } from '../src/mass-properties.ts';
import { RECOVERABLE, compileStructuredConstruction, createStructuredConstruction, planStructuredComponent,
  validateStructuredConstruction } from '../src/structured-construction.ts';
import { constructionEditMessage, structuredComponent } from '../src/structured-editing.ts';
import { withChassisThickness } from '../src/chassis-editing.ts';
import { CARGO } from '../src/component-volume.ts';
import { managedWorld } from './mechanical-queries.js';
import { cellOf } from '../src/grid.ts';
await initNativeDynamics();

const KINDS = { wheeled: ['travel', 'axles', 'wheel', 'overhang', 'depth'], tracked: ['track', 'noseMm', 'clearance'],
  aircraft: ['skid', 'overhang', 'depth'] };

test('the three chassis choices describe geometry and structure without a class load rating', () => {
  assert.deepEqual(Object.keys(CHASSIS_MODELS), ['wheeled', 'tracked', 'aircraft']);
  for (const [kind, fields] of Object.entries(KINDS)) {
    const model = CHASSIS_MODELS[kind];
    assert.equal(model.kind, kind);
    for (const field of ['length', 'deck', 'frameMm', 'armourMm', 'structure', ...fields])
      assert.ok(model[field] !== undefined, `${kind}: ${field}`);
    assert.ok(model.length[0] < model.length[1]);
    for (const field of ['size', 'limitKg', 'frameKg', 'credits']) assert.equal(Object.hasOwn(model, field), false, `${kind}: ${field}`);
  }
  // A track travels on its springs as far as it is large (game_chassis.rs), with no travel of its model.
  assert.equal(Object.hasOwn(CHASSIS_MODELS.tracked, 'travel'), false);
  assert.deepEqual(constructionCatalogue().chassis, CHASSIS_MODELS);
});

test('chassis names show the running gear', () => {
  assert.equal(chassisName('wheeled'), 'Chassi de rodas');
  assert.equal(chassisName('tracked'), 'Chassi de esteiras');
  assert.equal(chassisLabel('wheeled'), 'Rodas');
  assert.equal(chassisLabel('tracked'), 'Esteiras');
  assert.equal(chassisName('aircraft'), 'Chassi de aeronave');
  assert.equal(chassisLabel('aircraft'), 'Aeronave');
});

// A box as long as the chassis it is written on, with a command post in it, its plates this thick: in cells of 5 cm
// (grid.ts), its floor on the cell nearest to half its thickness over the deck.
const boxed = (model, length, thicknessMm) => {
  const corner = i => `hull-${i}`, [x, y] = [cellOf(length / 2), 32], deck = cellOf((chassisSpec(model)?.deck ?? .9) - 1.3),
    floor = deck + cellOf(thicknessMm / 2000);
  return { version: DESIGN_VERSION, preset: 'vehicle', chassis: { model, points: [{ x: -x, y: deck }, { x, y: deck }] },
    nodes: [[-x, 0], [x, 0], [x, y], [-x, y]].map(([nx, ny], i) => ({ id: corner(i), x: nx, y: ny + floor })),
    plates: ['floor', 'rear', 'roof', 'front'].map((side, i) =>
      ({ id: `hull:${side}`, a: corner(i), b: corner((i + 1) % 4), material: 'steel', thicknessMm })),
    components: [{ id: 'command', kind: 'command', pose: { x: 0, y: floor + 8, angle: 0 } }] };
};

test('the compiler rejects unknown and removed chassis IDs instead of reinterpreting them', () => {
  for (const model of ['wheeled-heavy', 'tracked-light']) {
    assert.equal(chassisSpec(model), undefined);
    assert.throws(() => compileNativeConstruction(boxed(model, 6, 8), constructionCatalogue()),
      error => error.reason === 'CHASSIS_MODEL');
  }
});

test('the core tells the page the chassis a design stands on, and a design too heavy for it apart', () => {
  const { construction, compiled } = compileNativeConstruction(boxed('wheeled', 6, 10), constructionCatalogue());
  assert.equal(construction.version, DESIGN_VERSION);
  assert.deepEqual(construction.chassis, boxed('wheeled', 6, 10).chassis);
  const { chassis } = compiled;
  assert.equal(chassis.model, 'wheeled');
  assert.deepEqual(chassis.plates, ['chassis:frame-0', 'chassis:rail-0']);
  assert.deepEqual(chassis.gear, ['chassis:wheel-0', 'chassis:wheel-1']);
  assert.deepEqual(compiled.beds, chassis.beds);
  assert.equal(chassis.beds.length, 1);
  assert.ok(chassis.emptyKg > 0 && chassis.loadedKg >= chassis.emptyKg && chassis.loadedKg <= chassis.limitKg);
  assert.equal(compiled.vehicle.chassisId, 'chassis:frame-0');
  // Heavy armour needs more structure than the default thin frame provides.
  assert.throws(() => compileNativeConstruction(boxed('wheeled', 4.5, 100), constructionCatalogue()),
    error => error.code === 'CHASSIS_OVERLOAD' && error.loadedKg > error.limitKg);
  assert.throws(() => compileNativeConstruction({ ...boxed('wheeled', 4.5, 10), chassis: undefined }, constructionCatalogue()),
    error => error.code === 'STRUCTURED_CONSTRUCTION' && error.reason === 'CHASSIS_REQUIRED');
});

test('chassis do not introduce a class speed ceiling', () => {
  assert.deepEqual(Object.entries(CHASSIS_MODELS).map(([id, model]) => [id, model.topKmh]), [['wheeled', undefined], ['tracked', undefined], ['aircraft', undefined]]);
  for (const model of ['wheeled', 'tracked']) {
    const { compiled } = compileNativeConstruction(boxed(model, 6, 10), constructionCatalogue());
    for (const frame of compiled.plates.filter(plate => plate.chassis)) assert.equal(frame.chassis.topSpeed, undefined);
  }
});

test('flat-road speeds follow physical equilibrium and the track speed limit', t => {
  for (const [id, model, made = createConstruction] of [['truck', 'wheeled'], ['chassis', 'wheeled'], ['scout', 'wheeled'],
    ['heavy', 'tracked']]) {
    const source = made(id), drive = blueprintPowertrain(compileBlueprint(source)), top = drive.maxSpeed,
      tracked = chassisSpec(source.chassis.model).kind === 'tracked';
    source.terrain = 'flat';
    assert.equal(source.chassis.model, model, 'factory presets author one current running kind');
    assert(Number.isFinite(top) && top > 0);
    if (!tracked) assert.equal(drive.gearedSpeed, null);
    // Flat out, designs face left.
    const world = managedWorld(t, source);
    world.controlVehicle(-1);
    let fastest = 0;
    // A wheel approaches its resistance equilibrium gradually, instead of
    // reaching a hard governor after the old one-minute measurement.
    for (let step = 0; step < 120 * 60; step++) { world.step(); fastest = Math.max(fastest, -world.vehicle.vx); }
    if (tracked) {
      assert.ok(fastest <= drive.gearedSpeed * 1.005, `${id}: ${fastest * 3.6} km/h exceeds the track speed limit`);
      assert.ok(Math.abs(fastest - top) < top * .03, `${id}: ${fastest * 3.6} km/h, estimated ${top * 3.6}`);
    }
    else {
      assert.ok(Math.abs(fastest - top) < top * .03, `${id}: ${fastest * 3.6} km/h, estimated ${top * 3.6}`);
      const p = world.vehicle.powertrain,
        resistance = (world.vehicle.mass * 9.81 * world.vehicle.groundResistance + p.drag * fastest ** 2) * fastest;
      assert(Math.abs(resistance - p.powerKw * 1000 * p.efficiency) < p.powerKw * 1000 * p.efficiency * .03,
        'the wheels settle where the available power holds rolling resistance and drag');
      assert.equal(world.dynamics.recoveries || 0, 0);
    }
  }
});

test('generated frame and running gear retain real geometry without an authoring support graph', () => {
  const compiled = compileStructuredConstruction(boxed('wheeled', 6, 10));
  for (const id of compiled.chassis.plates) {
    const plate = compiled.plates.find(part => part.id === id);
    assert(plate && plate.physicalMass > 0 && plate.length > 0 && plate.thicknessMm > 0);
  }
  for (const id of compiled.chassis.gear) {
    const gear = compiled.modules.find(part => part.id === id);
    assert(gear && gear.physicalMass > 0 && gear.width > 0 && gear.height > 0);
  }
  assert.equal(compiled.attachments, undefined);
});

test('no wheel or track is placed by hand: they come with the chassis', () => {
  const source = createStructuredConstruction();
  for (const kind of ['wheel', 'track']) {
    assert.throws(() => structuredComponent(kind), /Rodas e esteiras vêm com o chassi/);
    assert.throws(() => planStructuredComponent(source, { id: kind, kind, pose: { x: 0, y: 0, angle: 0 } }),
      error => constructionEditMessage(error) === 'Rodas e esteiras vêm com o chassi.');
  }
});

test('the workshop tells what a chassis refuses in its own words', () => {
  const told = constructionEditMessage;
  assert.match(told({ code: 'CHASSIS_OVERLOAD', loadedKg: 41200, limitKg: 38000 }),
    /^Passaria do peso que o chassi aguenta: 41,2 \/ 38 t com tudo cheio\./);
  assert.equal(told({ code: 'CHASSIS_LENGTH', model: 'wheeled' }), 'O chassi de rodas vai de 2,5 a 12 m de comprimento.');
  assert.equal(told({ code: 'FIELD', model: 'tracked', field: 'armorMm' }), 'A blindagem da rodagem deste chassi vai até 80 mm.');
  const heavy = boxed('wheeled', 4.5, 100);
  assert.throws(() => validateStructuredConstruction(heavy), error => RECOVERABLE.includes(error.code) &&
    /^Passaria do peso que o chassi aguenta: \d+(,\d)? \/ \d+(,\d)? t com tudo cheio\./.test(constructionEditMessage(error)));
});

test('admission counts fuel and ammunition, built full, and the heaviest ore full though the hopper starts empty', () => {
  const source = withChassisThickness(boxed('wheeled', 6, 10), 20);
  const floor = source.nodes[0].y;
  source.components.push(
    { id: 'fuel', kind: 'fuel', pose: { x: -40, y: floor + 8, angle: 0 } },
    { id: 'ammo', kind: 'ammo', ammoPreset: 'rh120', pose: { x: 16, y: floor + 8, angle: 0 } },
    { id: 'hopper', kind: 'hopper', sizeScale: 1.6, pose: { x: 0, y: floor + cellOf(1.6 + .72 + .02), angle: 0 } });
  const compiled = compileNativeConstruction(source, constructionCatalogue()).compiled,
    { chassis } = compiled, fuel = compiled.modules.find(part => part.id === 'fuel'),
    ammo = compiled.modules.find(part => part.id === 'ammo'), hopper = compiled.modules.find(part => part.id === 'hopper'),
    held = fuel.capacityLitres * .835 + ammo.capacityRounds * ammo.roundMass,
    reserves = held + hopper.capacityM3 * CARGO.ferro.density;
  assert.ok(held > 0 && reserves > held);
  assert.deepEqual([fuel.fuelLitres, ammo.rounds], [fuel.capacityLitres, ammo.capacityRounds], 'the tank and the box are built full');
  assert.ok(Math.abs(chassis.loadedKg - chassis.emptyKg - reserves) < 1e-6);
  assert.ok(Math.abs(compiled.fixedAssembly.mass - chassis.emptyKg - held) < 1e-6, 'built, it carries its fuel and its rounds, and no ore');

  // The same empty equipment can stand on the thinner frame, but its full
  // reserves cannot. Refusing it prevents an empty-load admission loophole.
  const weak = withChassisThickness(source, 7),
    structure = compileNativeConstruction(withChassisThickness(boxed('wheeled', 6, 10), 7), constructionCatalogue()).compiled.chassis,
    dryKg = chassis.emptyKg - chassis.frameKg + structure.frameKg;
  assert.ok(dryKg < structure.limitKg && dryKg + reserves > structure.limitKg);
  assert.throws(() => compileNativeConstruction(weak, constructionCatalogue()),
    error => error.code === 'CHASSIS_OVERLOAD' && error.loadedKg > error.limitKg);
});
