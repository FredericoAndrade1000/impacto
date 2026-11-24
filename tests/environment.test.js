import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { GROUND_SURFACES } from '../src/ground-impact.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { boxBlueprint, emptyBlueprint } from './helpers/perception-scene.js';
import { predictImpact } from '../src/impact-preview.ts';
import { GRAVITY } from '../src/ballistics.ts';
import { environmentDrive } from '../scripts/probes-mobility.ts';
import { referenceScenario, applyReferenceScene } from '../src/scenarios.ts';
import { compileBlueprint, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { GroundTrails } from '../src/terrain-art.ts';
import { Container, Texture } from 'pixi.js';
import { Effects } from '../src/effects.ts';
import { advance, flyRound, managedWorld } from './mechanical-queries.js';
import { vehicleBox } from './helpers/designs.js';
import { withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';
import { chassisAxles } from '../src/chassis.ts';
import { cargoSpace, cargoUnitMass, mixSpace } from '../src/component-volume.ts';

// A box 6 m long on the chassis `model`, the running gear that comes with it on the ground.
function loadedGear(t, { model = 'wheeled', gearScale = 1, surface = 'mud', mass = 12000, boundary = false } = {}) {
  // Compare actual 12 t loads, or 15 t for the heavier case. A thin aluminium
  // hull leaves its floor to carry the adjustable ballast. The wheeled fixture
  // has three supports and a reinforced frame so capacity is not the variable.
  // Its frame and its gear made as they are in the Oficina, the whole box hung with its suspension.
  const box = vehicleBox({ length: 6, height: .4, thicknessMm: 8, material: 'aluminum', model }),
    source = withChassisGearScale(model === 'wheeled' ? withChassisThickness(box, 40) : box, gearScale),
    floor = source.plates.find(plate => plate.id === 'hull:floor');
  if (model === 'wheeled') source.chassis.axles = [-44, 0, 44];
  source.terrain = surface === 'concrete' ? 'flat' : surface === 'soil' ? 'hills' : surface;
  // Choose an authored floor for the desired load using the native cold
  // compiler's mass, then admit that author. No projected mass is injected.
  const thin = compileBlueprint(source).fixedAssembly.mass; floor.thicknessMm = 108;
  const perMm = (compileBlueprint(source).fixedAssembly.mass - thin) / 100;
  floor.thicknessMm = 8 + (mass - thin) / perMm;
  assert(floor.thicknessMm >= 8 && floor.thicknessMm <= 1000);
  const admitted = compileBlueprint(source);
  assert(Math.abs(admitted.fixedAssembly.mass - mass) < .001);
  const world = managedWorld(t, source);
  if (boundary) world.terrain.sectors = [{ start: -1600, end: 12, surface: 'soil' },
    { start: 12, end: 1600, surface: 'mud' }];
  for (let i = 0; i < 90; i++) world.step();
  return world;
}
// The flat test track bent, before the first step, into a ramp up towards −X of `degrees` on `surface`: level ground to
// x = 0, 8 m easing into the grade, 60 m at it and 8 m easing out onto a level top. Where that top begins.
function ramp(world, degrees, surface) {
  const k = Math.tan(degrees * Math.PI / 180), ease = 8, run = 60, top = 2 * ease + run, ground = world.terrain,
    rise = u => u <= 0 ? 0 : u < ease ? k * u * u / (2 * ease) : u < ease + run ? k * (u - ease / 2) :
      u < top ? k * (ease / 2 + run + (u - ease - run) - (u - ease - run) ** 2 / (2 * ease)) : k * (ease + run);
  for (const p of ground.points) p.y = Math.fround(rise(-p.x));
  Object.assign(ground, { sectors: [{ start: -1600, end: 1600, surface }], material: surface, rocks: [], profiles: [], minHeight: 0 });
  return -top;
}
const effects = t => {
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    dust: Texture.EMPTY, spark: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY }, fx = new Effects(parent, atlas);
  t.after(() => { fx.clear(); parent.destroy({ children: true }); }); return fx;
};

test('mixed map keeps the workshop flat and reports material at the actual ray hit', () => {
  const ground = new Terrain('mixed');
  for (let x = -3; x <= 16; x += .1) assert.equal(ground.height(x), 0);
  for (const p of ground.points) assert.equal(ground.height(p.x), p.y);
  for (const [x, surface] of [[12, 'concrete'], [22, 'soil'], [31, 'gravel'], [39, 'mud'], [55, 'sand'], [73, 'rock']]) {
    const hit = ground.raycast({ x, y: 5 }, { x, y: -2 });
    assert.equal(hit.surface, surface); assert(Math.abs(hit.y - ground.height(x)) < 1e-8);
  }
  assert(ground.height(39) < 0, 'mud is a real lowland below the old ground plane');
  for (const rock of ground.rocks) assert(ground.height(rock.peak) > ground.height(rock.start) + .1);
});

test('grazing bullets ricochet from rock but lose their energy in wet mud and sand', t => {
  for (const surface of ['rock', 'mud', 'sand']) {
    const world = managedWorld(t, emptyBlueprint());
    world.terrain.material = surface; world.terrain.sectors = [];
    // The bullet starts a centimetre above the ground and meets it early in its step; one that
    // skips off is still in the air when the step ends.
    const bullet = { id: 'grazing', x: 0, y: .01, vx: 400, vy: -15, power: 100, mass: .1, caliberMm: 10,
      radius: .005, ammo: 'ap', age: 0, life: 1 },
      flown = flyRound(world, bullet);
    assert.equal(flown !== null, surface === 'rock');
    assert(world.drainEvents().some(event => (event.type === 'ground' || event.type === 'ricochet' && event.ground) &&
      event.surface === surface));
    if (flown) {
      assert.equal(flown.groundBounces, 1);
      assert(flown.vy > 0 && flown.power < bullet.power);
    }
  }
});

test('soft ground losses follow load and footprint; tracks spread load and larger tires reduce pressure', t => {
  const wheels = loadedGear(t).vehicle, track = loadedGear(t, { model: 'tracked' }).vehicle,
    loaded = loadedGear(t, { mass: 15000 }).vehicle,
    enlarged = loadedGear(t, { gearScale: 1.25 / 1.1 }).vehicle,
    concrete = loadedGear(t, { surface: 'concrete' }).vehicle;
  // Three pairs of 1.1 m tyres carry the baseline; increasing their diameter
  // to 1.25 m leaves the same three axle positions and total load in place.
  // The track's belt bridges the troughs of the ruts of mud (game_terrain.rs `Bumps`) between its road wheels.
  assert(track.groundPressureKPa < wheels.groundPressureKPa / 7.5);
  assert(track.groundResistance < wheels.groundResistance && track.softGroundLoad < wheels.softGroundLoad);
  assert(loaded.groundPressureKPa > wheels.groundPressureKPa && loaded.groundResistance > wheels.groundResistance);
  assert(enlarged.groundPressureKPa < wheels.groundPressureKPa && enlarged.groundResistance < wheels.groundResistance);
  // A tyre rolls on concrete as on asphalt (game_terrain.rs `SurfaceKind::rolling`), with nothing of soft ground.
  assert(Math.abs(concrete.groundResistance - .012) < 1e-12, `${concrete.groundResistance}`); assert.equal(concrete.softGroundLoad, 0);
});

test('a contact bridging two materials mixes losses instead of changing chassis speed at a boundary', t => {
  // One track, its middle on the boundary.
  const mixed = loadedGear(t, { model: 'tracked', boundary: true }),
    soil = loadedGear(t, { model: 'tracked', surface: 'soil' }),
    mud = loadedGear(t, { model: 'tracked' });
  const contact = mixed.modules[0].groundContact;
  assert(contact.materials.soil > 0 && contact.materials.mud > 0,
    'the native contact samples both sides of the material boundary');
  assert(mixed.vehicle.groundResistance > soil.vehicle.groundResistance &&
    mixed.vehicle.groundResistance < mud.vehicle.groundResistance);
  mixed.command('setVehicleState', { state: { y: 10 } }); mixed.step();
  assert.equal(mixed.vehicle.traction, 0); assert.equal(mixed.vehicle.groundResistance, 0);
  assert.equal(mixed.vehicle.groundPressureKPa, 0); assert.equal(mixed.vehicle.groundSurface, null);
});

test('ballistic preview reaches the muddy depression below zero and agrees with projectile CCD', t => {
  const b = emptyBlueprint(); b.terrain = 'mixed';
  const w = managedWorld(t, b), solution = { flightLimit: 45, flight: { model: 'quadratic-drag-v2', mass: .1, caliberMm: 10, family: 'machinegun', dragCoefficient: .30, airDensity: 1.225, scaleHeight: 8500 }, reachable: true, x: 39, y: .1, vx: 0, vy: -1, time: 1 },
    predicted = predictImpact(w.snapshot(), solution, { ammo: 'ap', power: 20 });
  assert.equal(predicted.owner.type, 'ground'); assert.equal(predicted.surface, 'mud'); assert(predicted.y < -.2);
  const oldPlaneTime = (-1 + Math.sqrt(1 + 2 * GRAVITY * .1)) / GRAVITY;
  assert(predicted.time > oldPlaneTime);
  w.command('projectile', { projectile: { id: 'valley-shot', x: 39, y: .1, vx: 0, vy: -1, power: 20,
    mass: .1, caliberMm: 10, radius: .005, ammo: 'ap', age: 0 } });
  const events = [];
  for (let i = 0; i < 24; i++) { w.step(); events.push(...w.drainEvents()); }
  const hit = events.find(e => e.type === 'ground'); assert(hit); assert.equal(hit.surface, 'mud');
  assert(Math.abs(hit.y - predicted.y) < .001);
});

test('fixed rocky outcrops shield a target and a direct blast path', t => {
  const ground = new Terrain('mixed'), y = ground.height(68) + .16,
    b = emptyBlueprint(); b.terrain = 'mixed';
  const w = managedWorld(t, b), hit = ground.raycast({ x: 67.8, y }, { x: 71.5, y });
  assert(hit && hit.surface === 'rock');
  w.addActor(boxBlueprint({ length: .2, height: .4, rideHeight: .15, thicknessMm: 100 }),
    { id: 'shielded-target', ownerId: 'shielded-target', x: 71.5, facing: -1 });
  const prediction = predictImpact(w.snapshot(), { flightLimit: 45, flight: { model: 'quadratic-drag-v2', mass: .1, caliberMm: 10, family: 'machinegun', dragCoefficient: .30, airDensity: 1.225, scaleHeight: 8500 }, reachable: true, x: 67.8, y, vx: 1000, vy: 0, time: .01 });
  assert.equal(prediction.owner.type, 'ground'); assert.equal(prediction.surface, 'rock');
  // A charge at the foot of the outcrop leaves the target behind it as it was. The same charge
  // three metres higher sees the target over the crest, from a little farther, and marks it.
  const armour = w.plates.filter(plate => plate.actorId === 'shielded-target'),
    condition = () => structuredClone(armour.map(plate => ({ marks: plate.marks, dents: [...(plate.dents?.values() || [])],
      integrity: plate.integrity, area: plate.remainingArea, grid: plate.ballisticGrid }))), intact = condition();
  w.explode(67.8, y, 400, 8);
  assert.equal(w.stats.explosions, 1); assert.deepEqual(condition(), intact, 'rock in the blast path shields the target');
  w.explode(67.8, y + 3, 400, 8);
  assert(armour.some(plate => plate.marks.length > 0), 'the charge reaches that far along a clear path');
});

for (const template of ['scout', 'heavy']) test(`${template}: mixed-route mobility crosses real surfaces with intact, powered geometry`, () => {
  // A short rocky contact can fall entirely between half-second samples.
  // Check the material at every solve instead of prescribing a trajectory.
  // Each drives the route ahead: backing, it goes no faster than its reverse gear lets it.
  const row = environmentDrive({ template, terrain: 'mixed', facing: 1, seconds: 17, sampleEvery: 1 });
  if (template === 'heavy') assert(row.end.x > 84);
  else {
    // The scout must reach the rocky section. Momentum may carry the current
    // authored hull across a short grade; a transmission estimate cannot
    // prescribe where an intact, powered vehicle must stop.
    assert(row.end.x > 65);
    assert.equal(row.end.throttle, 1); assert.equal(row.end.brake, 0);
    assert.equal(row.end.engine, true); assert.equal(row.end.fuelStarved, false);
    assert(Math.abs(row.end.powerKw - row.samples[0].powerKw) < 1e-6,
      'traversal must not damage the engine or change its available power');
    const gears = row.samples.at(-1).gears;
    const axles = chassisAxles(createConstruction(template).chassis).length;
    assert.equal(gears.length, axles); assert.equal(row.end.gearCount, axles);
    assert(gears.every(gear => gear.health > .999 && gear.attached));
    assert(row.end.fuelLitres > 0);
  }
  assert(row.samples.every(sample => [sample.x, sample.y, sample.angle, sample.vx, sample.vy,
    sample.powerKw].every(Number.isFinite) && sample.engine && !sample.fuelStarved));
  assert(row.retained.every(n => n > .999)); assert.equal(row.recoveries, 0);
  assert(row.partsPreserved && row.originalUnchanged && row.restored);
  assert(Number.isFinite(row.peaks.speed) && row.peaks.speed < 50);
  assert(Number.isFinite(row.peaks.kineticJ) && row.peaks.kineticJ < 1e10,
    'preserve the reviewDrive energy cap rather than an obsolete stopping coordinate');
  // In a rut of mud the gear stands as deep as 6.5 cm under the line the ground is drawn by (game_terrain.rs `Bumps`).
  assert(row.peaks.groundPenetration < .03 + .065);
  for (const surface of ['concrete', 'soil', 'gravel', 'mud', 'sand', 'rock'])
    assert(Array.isArray(row.surfaces[surface]) && row.surfaces[surface].length > 0, surface);
});

test('mud slows the same vehicle, and engine loss/braking do not generate motion', () => {
  const flat = environmentDrive({ template: 'scout', terrain: 'flat', seconds: 8 }),
    mud = environmentDrive({ template: 'scout', terrain: 'mud', seconds: 8 }),
    brake = environmentDrive({ template: 'scout', terrain: 'mud', action: 'brake', seconds: 8 }),
    engine = environmentDrive({ template: 'scout', terrain: 'mud', action: 'engine', seconds: 8 });
  assert(mud.end.vx < flat.end.vx * .8); assert(mud.end.x > 14);
  assert(Math.abs(brake.end.vx) < .01);
  assert(!engine.end.engine && Math.abs(engine.end.vx) < engine.actionSpeed);
  assert.equal(engine.recoveries, 0);
});

test('full of iron, the base builder and the base supply truck climb 30° of soil and of rock to a works', t => {
  // Works stand on slopes of up to 30°, and the field's steepest are of soil, on the ridges of the highlands, and of rock,
  // on the scarps of the plateaus. The builder leaves its base with its supply piece full, and iron is the heaviest load.
  for (const template of ['construction-truck', 'supply']) for (const surface of ['soil', 'rock']) {
    const world = managedWorld(t, { ...createConstruction(template), terrain: 'flat' }), top = ramp(world, 30, surface),
      piece = world.modules.find(m => m.kind === 'supply'), iron = cargoSpace(piece, 'ferro');
    advance(world, 30); const empty = world.vehicle.mass;
    world.command('setPartState', { owner: world.game().handle(piece), state: { cargo: { ferro: iron } } });
    advance(world, 90);
    assert(Math.abs(world.vehicle.mass - empty - iron) < 25 && iron > 10000, `${template} weighs ${world.vehicle.mass} kg with ${iron} kg of iron`);
    world.controlVehicle(world.actor('local').facing);
    let seconds = 0;
    for (; seconds < 60 && world.vehicle.x > top; seconds++) {
      advance(world, 60);
      assert(!world.vehicle.stuck, `${template} stuck (${world.vehicle.stuck}) on ${surface} at ${world.vehicle.x.toFixed(1)} m`);
    }
    assert(world.vehicle.x <= top, `${template} climbed to ${world.vehicle.x.toFixed(1)} m of ${top} on ${surface}`);
  }
});

test('the motor grader, and the paver with the hopper of its paver full, climb the same 30° of soil and of rock', t => {
  // A road runs where the works are, up the slopes the builder climbs; a paver goes out with the mix of 45 m of asphalt.
  for (const template of ['grader', 'paver']) for (const surface of ['soil', 'rock']) {
    const world = managedWorld(t, { ...createConstruction(template), terrain: 'flat' }), top = ramp(world, 30, surface),
      piece = world.modules.find(m => m.kind === 'paver');
    advance(world, 30);
    if (piece) {
      const empty = world.vehicle.mass, mix = { silica: mixSpace(piece, 'silica'), petroleo: mixSpace(piece, 'petroleo') },
        weighs = mix.silica * cargoUnitMass('silica') + mix.petroleo * cargoUnitMass('petroleo');
      assert(!world.modules.some(m => m.kind === 'supply'), 'it carries no supply piece');
      world.command('setPartState', { owner: world.game().handle(piece), state: { cargo: mix } });
      advance(world, 90);
      assert(Math.abs(world.vehicle.mass - empty - weighs) < 25 && Math.abs(weighs - 13135.5) < 1e-6, `${template} weighs ${world.vehicle.mass} kg with ${weighs} kg of mix`);
    }
    world.controlVehicle(world.actor('local').facing);
    let seconds = 0;
    for (; seconds < 60 && world.vehicle.x > top; seconds++) {
      advance(world, 60);
      assert(!world.vehicle.stuck, `${template} stuck (${world.vehicle.stuck}) on ${surface} at ${world.vehicle.x.toFixed(1)} m`);
    }
    assert(world.vehicle.x <= top, `${template} climbed to ${world.vehicle.x.toFixed(1)} m of ${top} on ${surface}`);
  }
});

test('mixed driving scenes are available through worker references and JSON storage', t => {
  for (const id of ['drive-mixed-wheels', 'drive-mixed-tracks']) {
    const scene = referenceScenario(id); assert.equal(parseBlueprint(serializeBlueprint(scene.blueprint)).terrain, 'mixed');
    const w = managedWorld(t, scene.blueprint); applyReferenceScene(w, scene); w.step();
    assert.equal(scene.drive, .65, 'the reference recipe uses partial throttle');
    assert.equal(w.vehicle.throttle, scene.drive); assert.equal(w.stats.shots, 0);
  }
});

test('cosmetic ruts freeze while paused, stay capped, and ignore restoration/teleports', t => {
  const graphics = new Container(), camera = { x: 0, y: 0, zoom: 10, width: 900, height: 550 },
    emissions = [], trails = new GroundTrails(graphics, { surfaceTrail(e) { emissions.push(e); } }),
    terrain = new Terrain('mud'), state = { actors: [{ id: 'truck', vehicle: { vx: 6, slip: 0 } }],
      modules: [{ id: 'wheel', actorId: 'truck', kind: 'wheel', attached: true, groundContact: { x: 0 } }] };
  t.after(() => { trails.clear(); graphics.destroy({ children: true }); });
  trails.update(state, terrain, 0, camera);
  for (let i = 1; i < 800; i++) { state.modules[0].groundContact.x = i * .2; trails.update(state, terrain, i / 30, camera); }
  assert(trails.marks.length <= 600 && emissions.length > 100);
  const size = trails.marks.length, emitted = emissions.length;
  state.modules[0].groundContact.x += 100; trails.update(state, terrain, 799 / 30, camera);
  assert.equal(trails.marks.length, size); assert.equal(emissions.length, emitted);
  trails.update(state, terrain, 801 / 30, camera); assert.equal(trails.marks.length, size, 'teleport does not paint a long rut');
  trails.update(state, terrain, 0, camera); assert.equal(trails.marks.length, 0);
});

test('distant ruts retain contacts, dust and capped history, then reveal cached drawings while paused', t => {
  const graphics = new Container(), camera = { x: 0, y: 0, zoom: 2.99, width: 900, height: 550 },
    dust = [], spray = [], trails = new GroundTrails(graphics, { surfaceTrail: event => dust.push(event), surfaceSpray: event => spray.push(event) }),
    terrain = new Terrain('mud'), wheel = { id: 'track', actorId: 'truck', kind: 'track', attached: true, groundContact: { x: 0 } },
    state = { actors: [{ id: 'truck', vehicle: { vx: 6, slip: 2 } }], modules: [wheel] };
  t.after(() => { trails.clear(); graphics.destroy({ children: true }); });
  trails.update(state, terrain, 0, camera);
  for (let i = 1; i <= 400; i++) { wheel.groundContact.x = i * .2; trails.update(state, terrain, i / 30, camera); }
  assert.equal(graphics.visible, false); assert.equal(graphics.children.length, 0);
  assert.equal(trails.marks.length, 600); assert(dust.length > 100 && spray.length > 100, 'rolling dust and slipping still follow contacts');
  const kept = trails.marks.slice(), emitted = [dust.length, spray.length], time = 400 / 30;
  Object.assign(camera, { x: 40, y: 2, zoom: 3 }); trails.update(state, terrain, time, camera);
  assert.equal(graphics.visible, true); assert(graphics.children.length > 0);
  assert(graphics.children.every(drawing => drawing.visible && drawing.context.instructions.length > 0));
  assert.deepEqual(trails.marks, kept); assert.deepEqual([dust.length, spray.length], emitted, 'approaching while paused emits nothing');
  const pictures = graphics.children.map(drawing => [drawing, drawing.context.instructions[0]]),
    cached = () => { for (const [drawing, picture] of pictures) assert.equal(drawing.context.instructions[0], picture, 'camera movement retains the painted geometry'); };
  trails.update(state, terrain, time, camera);
  cached();
  Object.assign(camera, { x: 2000, y: 600, zoom: 1 }); trails.update(state, terrain, time, camera);
  assert.equal(graphics.visible, false); cached();
  camera.zoom = 3; trails.update(state, terrain, time, camera);
  assert.equal(graphics.visible, true); assert(graphics.children.every(drawing => !drawing.visible)); cached();
  Object.assign(camera, { x: 40, y: 2 }); trails.update(state, terrain, time, camera);
  assert(graphics.children.every(drawing => drawing.visible)); cached();
  assert.deepEqual(trails.marks, kept); assert.deepEqual([dust.length, spray.length], emitted);
});

test('a gear that slips throws loose ground out behind it and digs in where it stands', t => {
  const graphics = new Container(), camera = { x: 0, y: 0, zoom: 10, width: 900, height: 550 }, fx = effects(t), terrain = new Terrain('sand'), trails = new GroundTrails(graphics, fx),
    wheel = { id: 'wheel', actorId: 'truck', kind: 'wheel', attached: true, groundContact: { x: 3 } }, truck = { id: 'truck', vehicle: { slip: 2.5 } },
    state = { actors: [truck, { id: 'post', vehicle: null }], modules: [wheel] };
  t.after(() => { trails.clear(); graphics.destroy({ children: true }); });
  let time = 0;
  const second = () => { const before = fx.particles.length; for (let i = 0; i < 60; i++) trails.update(state, terrain, time += 1 / 60, camera); return fx.particles.slice(before); };
  fx.terrain = terrain; trails.update(state, terrain, time, camera);
  // Driven forward and held by the sand, it throws the sand back; it stood still, so it left one mark, under itself.
  const thrown = second(), clods = thrown.filter(p => p.kind === 'dust');
  assert(clods.length > 15 && thrown.every(p => p.vx < 0 && p.vy > 0), String(clods.length));
  assert(clods.every(p => [GROUND_SURFACES.sand.color, GROUND_SURFACES.sand.top].includes(p.tint)) && thrown.some(p => p.kind === 'smoke' && p.tint === GROUND_SURFACES.sand.dust));
  assert.deepEqual(trails.marks.map(mark => [mark.a, mark.b]), [[3 - .18, 3 + .18]]);
  // Driven the other way it throws it the other way, and the faster it slips the more of it.
  truck.vehicle.slip = -2.5; assert(second().every(p => p.vx > 0));
  truck.vehicle.slip = 12; assert(second().length > thrown.length * 1.5);
  assert.equal(trails.marks.length, 1);
  // A gear the ground holds throws nothing, and neither does one that slips on rock, or one off the ground.
  truck.vehicle.slip = .2; assert.equal(second().length, 0);
  truck.vehicle.slip = 2.5; wheel.groundContact = null; assert.equal(second().length, 0);
  const rock = new Terrain('rough'); wheel.groundContact = { x: 3 };
  const before = fx.particles.length; for (let i = 0; i < 60; i++) trails.update(state, rock, time += 1 / 60, camera);
  assert.equal(fx.particles.length, before);
  // Mud comes off in clods, with no dust.
  const mud = new Terrain('mud'), wet = fx.particles.length; for (let i = 0; i < 60; i++) trails.update(state, mud, time += 1 / 60, camera);
  assert(fx.particles.length > wet && fx.particles.slice(wet).every(p => p.kind === 'dust'));
  // A wrecked gear turns no more: where the others slip it throws nothing and digs nothing, and it still marks
  // the ground it is dragged over.
  const wreck = { id: 'wreck', actorId: 'truck', kind: 'wheel', attached: true, health: 0, groundContact: { x: 9 } };
  state.modules = [wreck]; trails.update(state, terrain, time += 1 / 60, camera);
  const marks = trails.marks.length; assert.equal(second().length, 0); assert.equal(trails.marks.length, marks);
  for (const x of [9.4, 9.8]) { wreck.groundContact = { x }; trails.update(state, terrain, time += 1 / 60, camera); }
  assert(trails.marks.length > marks);
  wreck.health = 40; assert(second().length > 15);
});

test('mud impacts throw short wet clumps, while sand throws pale dust; driving effects respect quality budgets', t => {
  const wet = effects(t), dry = effects(t); wet.terrain = dry.terrain = new Terrain('mixed');
  wet.ground({ x: 39, y: -.22, power: 100 }); dry.ground({ x: 55, y: .1, power: 100 });
  assert(wet.particles.length && wet.particles.every(p => p.kind === 'dust' && p.tint === GROUND_SURFACES.mud.dust && p.life <= .6));
  assert(dry.particles.some(p => p.kind === 'smoke' && p.tint === GROUND_SURFACES.sand.dust));
  wet.setQuality('low');
  for (let i = 0; i < 1000; i++) wet.surfaceTrail({ x: 39, y: -.22, surface: 'mud', speed: 8, direction: 1, seconds: .1 });
  assert(wet.particles.length <= 800); assert(wet.particles.every(p => !p.compartmentId));
});

test('explosions in an empty lowland emit smoke at its real level without persistent secondary projectiles', t => {
  const b = emptyBlueprint(); b.terrain = 'mixed';
  const w = managedWorld(t, b), fx = effects(t); fx.terrain = w.terrain;
  const y = w.terrain.height(39) + .08; w.explode(39, y, 80, 1, 'validation');
  fx.explosion({ x: 39, y, power: 80, radius: 1 });
  assert.equal(w.projectiles.length, 0, 'secondary damage has no persistent projectile population');
  const explosion = w.drainEvents().find(e => e.type === 'explosion');
  assert(explosion && explosion.y < 0 && Math.abs(explosion.y - y) < 1e-8,
    'the native explosion preserves the negative world height rather than clamping it to the old flat ground');
  assert(fx.particles.filter(p => p.kind === 'smoke').every(p => p.y < 0 && p.y >= w.terrain.height(p.x)));
});
