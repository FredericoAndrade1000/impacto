import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, validateBlueprint, serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { VEHICLE_DETAILS, DETAIL_LIMIT, editableDetailHosts, hostForDetail, detailPose, detailCorners, legacyDetails } from '../src/vehicle-details.ts';
import { within } from '../src/hull-details.ts';
import { metresOf } from '../src/grid.ts';
import { miningWorld } from './helpers/mining-mobility.js';
import { advance, setPart } from './mechanical-queries.js';
import { cargoSpace, mixSpace } from '../src/component-volume.ts';
import { paintDetailCanvas } from '../src/hull-art.ts';
import { headlessPixi } from './helpers/headless-pixi.js';

headlessPixi();
const WORK = ['tracked', 'mining-truck', 'construction-truck', 'paver'];
// The work vehicles whose engines are too big for the bonnet of a truck keep the cab-forward pod; the tracked base and the
// miner wear the trucks' bonnet and cab.
const INDUSTRIAL = ['construction-truck', 'paver'], BONNETED = ['tracked', 'mining-truck'];
const ARMOUR = ['heavy', 'ifv', 'scout', 'recon', 'mortar', 'howitzer'];

test('the revised families remain ordinary editable projects with their full load and cosmetic limits', () => {
  for (const id of [...WORK, ...ARMOUR, 'grader']) {
    const source = createConstruction(id), b = compileBlueprint(source);
    assert.equal(b.mechanicalAdmission, true, id);
    assert(b.chassis.loadedKg <= b.chassis.limitKg * .9, `${id}: full load has structural margin`);
    assert(source.appearance.details.length <= DETAIL_LIMIT);
    assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source);
    assert.deepEqual(validateBlueprint(structuredClone(source)), source);
    assert(!source.plates.some(p => p.id === 'hull:floor'), 'one chassis floor closes each body');
    const hosts = editableDetailHosts(b);
    for (const detail of source.appearance.details) {
      const host = hostForDetail(hosts, detail), pose = detailPose(host, detail);
      // A player may intentionally move a detail outside its mask. Factory finishes should already be useful.
      assert([pose, ...detailCorners(host, detail)].some(p => within(p, host.polygon)), `${id}/${detail.kind} is entirely outside its skin`);
    }
  }
});

test('crew access is chosen for each vehicle instead of giving a truck door to every armoured hull', () => {
  for (const id of ['heavy', 'ifv', 'recon', 'mortar', 'howitzer']) {
    const details = createConstruction(id).appearance.details;
    assert(!details.some(d => d.kind === 'cab-door' || d.kind === 'armour-door'), id);
    assert(details.some(d => d.kind === 'hatch'), `${id}: roof access`);
  }
  const artillery = createConstruction('howitzer').appearance.details;
  assert(artillery.some(d => d.kind === 'access-hatch' && d.host === 'turret:roof'), 'artillery service hatch belongs to its turret');
  assert(createConstruction('scout').appearance.details.some(d => d.kind === 'armour-door'));
  for (const id of INDUSTRIAL) assert(createConstruction(id).appearance.details.some(d => d.kind === 'industrial-door'), id);
  for (const id of BONNETED) assert(createConstruction(id).appearance.details.some(d => d.kind === 'armour-door'), id);
  assert(createConstruction('grader').appearance.details.some(d => d.kind === 'cab-door'));
});

test('factory numbers remain legible beside stowage and service covers, and new doors fit their actual skin', () => {
  for (const id of [...WORK, ...ARMOUR]) {
    const b = compileBlueprint(createConstruction(id)), hosts = editableDetailHosts(b), details = b.appearance.details;
    const bounds = d => { const points = detailCorners(hostForDetail(hosts, d), d); return {
      left: Math.min(...points.map(p => p.x)), right: Math.max(...points.map(p => p.x)),
      bottom: Math.min(...points.map(p => p.y)), top: Math.max(...points.map(p => p.y)) }; };
    for (const d of details.filter(d => ['armour-door', 'access-hatch', 'cab-door', 'industrial-door'].includes(d.kind))) {
      const host = hostForDetail(hosts, d);
      assert(detailCorners(host, d).every(p => within(p, host.polygon)), `${id}/${d.kind}: access is clipped by the hull`);
    }
    for (const number of details.filter(d => d.kind === 'number')) for (const cover of details.filter(d => d.host === number.host && ['bin', 'service-panel', 'access-hatch'].includes(d.kind))) {
      const a = bounds(number), z = bounds(cover);
      assert(Math.min(a.right, z.right) <= Math.max(a.left, z.left) || Math.min(a.top, z.top) <= Math.max(a.bottom, z.bottom), `${id}: number overlaps ${cover.kind}`);
    }
  }
});

for (const id of INDUSTRIAL) test(`${id}: the industrial cab has real frontal glass, a lower engine hood and a separate load deck`, () => {
  const source = createConstruction(id), b = compileBlueprint(source), parts = b.modules,
    engine = parts.find(p => p.kind === 'engine'), command = parts.find(p => p.kind === 'command'), fuel = parts.find(p => p.kind === 'fuel'),
    point = name => { const n = source.nodes.find(n => n.id === name); return { x: 12 + metresOf(n.x), y: 1.3 + metresOf(n.y) }; },
    hood = point('hood-front'), roof = point('hull-3'), visor = source.plates.find(p => p.id === 'hull:vision');
  assert(roof.y - hood.y >= .5, 'the driving cab is distinctly taller than the engine enclosure');
  assert(point('cab-rear').x - roof.x >= 1.15, 'the cab has room across its roof instead of a narrow upright box');
  assert(point('hood-foot').x - point('cab-foot').x >= .12, 'a visible service gap separates the cab pod from the engine bay');
  assert(b.rooms.length >= 2, 'the cab and engine each have a real enclosed skin on the common floor');
  assert(point(visor.a).x > point(visor.b).x, 'the real windshield follows the swept front pillar');
  assert(engine.x - engine.width / 2 > hood.x && engine.y + engine.height / 2 < hood.y, 'the real engine fits under its lower hood');
  assert(fuel.x < hood.x && command.x < hood.x && command.y > fuel.y + fuel.height / 2, 'driver and tank occupy the front compartment');
  assert.equal(visor.material, 'glass'); assert.equal(visor.thicknessMm, 40);
  assert(point(visor.a).y - point(visor.b).y >= .59);
  assert(b.eyes.some(eye => eye.left === 650 && eye.right === 0), 'the actual command visor remains usable without a second camera');
  assert.deepEqual(source.components.filter(p => p.kind === 'sensor').map(p => p.sensorMode), ['visual']);
  assert(b.chassis.rear - point('hull-1').x >= 3, 'useful separate rear deck');
  if (id === 'paver') assert(b.rooms.length >= 2 && source.plates.some(p => p.id === 'conveyor:roof'), 'the low service housing is real geometry');
});

for (const id of BONNETED) test(`${id}: the truck's cab on tracks, a low bonnet over its engine and the deck free behind`, () => {
  const source = createConstruction(id), b = compileBlueprint(source), part = kind => b.modules.find(p => p.kind === kind),
    engine = part('engine'), fuel = part('fuel'), command = part('command'),
    point = name => { const n = source.nodes.find(n => n.id === name); return { x: 12 + metresOf(n.x), y: 1.3 + metresOf(n.y) }; },
    hood = point('hood-back'), roof = point('hull-3'), visor = source.plates.find(p => p.id === 'hull:vision');
  assert.equal(b.mechanicalAdmission, true);
  assert(roof.y - hood.y > .8, 'a low bonnet ahead of a distinctly taller cab');
  assert(engine.x - engine.width / 2 < hood.x && engine.y + engine.height / 2 < point('hood-front').y, 'the real engine under its bonnet');
  assert(fuel.x > hood.x && command.x > hood.x && command.y > fuel.y, 'the command and its fuel protected in the cab');
  assert.equal(visor.material, 'glass'); assert.equal(visor.thicknessMm, 40);
  assert(b.eyes.some(eye => eye.left === 650 && eye.right === 0), 'the actual command visor remains usable without a second camera');
  assert(b.chassis.rear - point('hull-1').x >= 3, 'useful separate rear deck');
});

test('industrial doors integrate the side window and latch without overlapping external handles or lights', () => {
  for (const id of WORK) {
    const b = compileBlueprint(createConstruction(id)), hosts = editableDetailHosts(b), details = b.appearance.details,
      door = details.find(d => d.kind === 'industrial-door' || d.kind === 'armour-door'), pose = detailPose(hostForDetail(hosts, door), door),
      overlaps = d => {
        const p = detailPose(hostForDetail(hosts, d), d);
        return Math.abs(p.x - pose.x) < (d.width + door.width) / 2 && Math.abs(p.y - pose.y) < (d.height + door.height) / 2;
      };
    assert(details.filter(d => ['handle', 'headlight', 'cab-step', 'filler'].includes(d.kind)).every(d => !overlaps(d)), id);
  }
});

test('regenerating industrial finish keeps the cab and hood free of tank roof hatches and military stowage',()=>{
  for(const id of WORK) {
    const source=createConstruction(id), b=compileBlueprint(source),
      extra=legacyDetails(b,{existing:source.appearance.details,automatic:true});
    assert(!extra.some(d=>['cab-door','hatch','periscope','cable','tools','cans','bin'].includes(d.kind)),id);
  }
});

test('the mortar carrier has a lower faceted hull and rear tandem, keeping its real mortar port and crew sight', () => {
  const source = createConstruction('mortar'), b = compileBlueprint(source),
    point = name => source.nodes.find(n => n.id === name), height = n => metresOf(n.y),
    front = point('hull-0'), upper = point('hull-3'), rear = point('hull-2'), axles = b.chassis.axles,
    mortar = b.modules.find(p => p.id === 'weapon');
  assert(height(upper) - height(front) < 1.4, 'lower silhouette over the same 1.1 m wheels');
  assert(metresOf(upper.x - front.x) >= 1.1, 'long inclined glacis');
  assert(metresOf(point('hull-1').x - rear.x) >= .29, 'rear armour slopes into its roof');
  assert(axles[2] - axles[1] < .55 * (axles[1] - axles[0]), 'the load-bearing rear axles form a tandem');
  assert.equal(mortar.weaponPreset, 'm252');
  assert.equal(mortar.weaponMount.min, -.6, 'the lower hull preserves the full firing sector');
  assert.equal(mortar.weaponMount.max, .6, 'the lower hull preserves the full firing sector');
  assert(b.eyes.some(eye => eye.left === 650 && eye.right === 0), 'basic command sight remains clear');
  assert(source.appearance.details.some(d => d.kind === 'service-panel'));
});

test('short and long mortar variants keep the fuel clear of the magazine and preserve the full firing sector', () => {
  for (const preset of ['m224', 'm252']) for (const stretch of [.94, 1, 1.06])
    for (const sensorModes of [[], ['visual'], ['visual', 'radar', 'sound']]) {
      const b = compileBlueprint(createConstruction('mortar', { preset, stretch, sensorModes })),
        gun = b.modules.find(p => p.id === 'weapon'), fuel = b.modules.find(p => p.id === 'fuel'),
        ammo = b.modules.find(p => p.id === 'weapon-ammo');
      assert(fuel.x + fuel.width / 2 < ammo.x - ammo.width / 2, `${preset}/${stretch}: fuel is ahead of the magazine`);
      assert.equal(gun.weaponMount.min, -.6, `${preset}/${stretch}`);
      assert.equal(gun.weaponMount.max, .6, `${preset}/${stretch}`);
      assert(b.chassis.loadedKg <= b.chassis.limitKg * .9);
      assert.equal(b.modules.filter(p => p.kind === 'sensor').length, sensorModes.length);
    }
});

test('the longer factory bands follow the frame instead of ending at the last reference wheel', () => {
  for (const id of ['heavy', 'ifv', 'howitzer', ...WORK]) {
    const b = compileBlueprint(createConstruction(id)), track = b.modules.find(p => p.kind === 'track');
    assert(track.width > b.chassis.length * .93, id);
    assert(track.x - track.width / 2 > b.chassis.front && track.x + track.width / 2 < b.chassis.rear, 'short real hull overhang at each end');
  }
  assert(compileBlueprint(createConstruction('ifv')).modules.find(p => p.kind === 'track').height > .93, 'larger support-vehicle running gear');
});

test('new access and service details share the bounded cold painter', () => {
  for (const kind of ['industrial-door', 'armour-door', 'access-hatch', 'service-panel', 'periscope', 'exhaust']) {
    const spec = VEHICLE_DETAILS[kind], image = paintDetailCanvas({ kind, width: spec.width, height: spec.height });
    assert(image.width > 0 && image.height > 0 && image.width <= 1024 && image.height <= 1024, kind);
  }
});

for (const id of [...WORK, ...ARMOUR]) for (const direction of [-1, 1])
  test(`${id}: the revised vehicle moves and brakes on ordinary ground facing ${direction}`, t => {
    const world = miningWorld(createConstruction(id), { grade: .12, direction, cargo: id === 'mining-truck' ? 'ferro' : null });
    t.after(() => world.dispose());
    const supply = world.modules.find(p => p.kind === 'supply'), paver = world.modules.find(p => p.kind === 'paver');
    if (supply) setPart(world, supply, { cargo: { ferro: cargoSpace(supply, 'ferro') } });
    if (paver) setPart(world, paver, { cargo: { silica: mixSpace(paver, 'silica'), petroleo: mixSpace(paver, 'petroleo') } });
    advance(world, 60, { drain: true });
    const start = world.vehicle.x;
    world.controlVehicle(direction, 0); advance(world, 600, { drain: true });
    assert((world.vehicle.x - start) * direction > 15, 'ordinary engine and contacts move the revised geometry from rest');
    world.controlVehicle(0, 1); advance(world, 240, { drain: true });
    assert(Math.abs(world.vehicle.vx) < .3, 'the vehicle brakes to rest');
    assert(world.modules.every(p => p.health / p.maxHealth > .99), 'body and tools stay clear of the ground');
  });

for (const id of ['construction-truck', 'paver']) for (const direction of [-1, 1])
  test(`${id}: the complete working load still climbs 30 degrees facing ${direction}`, t => {
    const world = miningWorld(createConstruction(id), { grade: Math.tan(Math.PI / 6), direction, cargo: null });
    t.after(() => world.dispose());
    const load = world.modules.find(p => p.kind === 'supply' || p.kind === 'paver');
    setPart(world, load, { cargo: load.kind === 'supply' ? { ferro: cargoSpace(load, 'ferro') } :
      { silica: mixSpace(load, 'silica'), petroleo: mixSpace(load, 'petroleo') } });
    advance(world, 90, { drain: true }); const start = world.vehicle.x;
    world.controlVehicle(direction, 0); advance(world, 1440, { drain: true });
    assert((world.vehicle.x - start) * direction >= 30, 'the revised gear carries the full load up the field mountain grade from rest');
    assert(world.modules.every(p => p.health / p.maxHealth > .99));
  });
