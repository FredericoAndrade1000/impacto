import test from 'node:test';
import assert from 'node:assert/strict';
import { collectionWork, canCollect, workArea, loadingContainers, loadingZone } from '../src/loading-area.ts';
import { workFrame, workFigure, SCOOP_SECONDS } from '../src/work-arm.ts';
import { cargoRoom } from '../src/component-volume.ts';

function field({ x = 100, angle = 0, mirrored = false, kind = 'excavator', grade = 0 } = {}) {
  const actor = { id: 'truck', vehicle: { x } }, ground = { height: at => grade * (at - x) },
    modules = [{ id: 'bin', actorId: actor.id, kind, x: x + (mirrored ? 1 : -1), y: 1.7, angle, mirrored, width: 2.4, height: 1.35, health: 100 },
      { id: 'wheel', actorId: actor.id, kind: 'wheel', x, y: .5, width: 1, height: 1, health: 100, groundContact: { x, y: 0 } }],
    plates = [{ id: 'floor', actorId: actor.id, definition: { x, y: .6, length: 6.6, angle: 0, thicknessMm: 10 } }];
  // A compiled container supplies its capacity; these fixtures only vary collection geometry.
  if (kind === 'hopper' || kind === 'cistern') modules[0].capacityM3 = 1;
  return { actor: id => id === actor.id ? actor : null, time: 0, modules, plates, terrain: ground };
}

test('a tool can only collect compatible material from the visible surface band it actually reaches', () => {
  const world = field(), site = { x: 100, feature: 'dune', material: 'silica' }, work = collectionWork(world, 'truck')[0], zone = loadingZone(site);
  assert.equal(canCollect(work, site, world.terrain), true);
  assert(work.point > zone.lo && work.point < zone.hi);
  assert.equal(canCollect(work, { ...site, x: 125 }, world.terrain), false, 'a truck within the old 30 m radius cannot gather from empty ground');
  assert.equal(canCollect(work, { ...site, material: 'petroleo' }, world.terrain), false);
  assert.equal(canCollect(work, site, { height: () => 40 }), false, 'the actual arm must reach the ground too');
});

test('parking offsets put the scoop in the deposit for both vehicle facings and for oil rigs', () => {
  for (const mirrored of [false, true]) for (const kind of ['excavator', 'drill']) {
    const world = field({ mirrored, kind }), site = { x: 300, feature: kind === 'drill' ? 'lowland' : 'outcrop', material: kind === 'drill' ? 'petroleo' : 'ferro' },
      area = workArea(world, 'truck', site, 30), work = collectionWork(world, 'truck')[0], offset = work.point - 100;
    assert(Math.abs(area.goal + offset - site.x) < 1e-9);
    assert(area.goal >= area.lo && area.goal <= area.hi); assert.equal(area.ready, false);
  }
});

test('collection reuses geometry during a frame and discards it after movement or component loss', () => {
  const world = field(), before = collectionWork(world, 'truck');
  assert.equal(collectionWork(world, 'truck'), before);
  world.time = 1; world.modules = world.modules.map(piece => ({ ...piece, health: 0 }));
  assert.deepEqual(collectionWork(world, 'truck'), []);
  assert.equal(workArea(world, 'truck', { x: 100, material: 'ferro' }, 30), null);
});

test('a downhill place cannot stretch the real tool and a tool trapped beyond its reach is refused', () => {
  const level = field(), slope = field({ grade: .5 }), site = { x: 100, feature: 'outcrop', material: 'ferro' },
    flat = collectionWork(level, 'truck')[0], downhill = collectionWork(slope, 'truck')[0];
  assert.equal(downhill.layout.length, flat.layout.length);
  assert(downhill.layout.out < flat.layout.out, 'a lower surface uses a nearer reachable target, not a longer boom');
  assert.equal(canCollect(downhill, { ...site, x: downhill.point }, slope.terrain), true);
  level.plates = [{ actorId: 'truck', definition: { x: 100, y: .6, length: 25, angle: 0, thicknessMm: 10 } }];
  assert.equal(workArea(level, 'truck', site, 30), null);
});

test('collection checks the stroke beyond its centre instead of accepting suspended digging over a terrain step', () => {
  const world = field(), work = collectionWork(world, 'truck')[0], site = { x: work.point, feature: 'outcrop', material: 'ferro' },
    step = { height: x => Math.abs(x - work.point) < .05 ? 0 : -20 };
  assert.equal(canCollect(work, site, world.terrain), true);
  assert.equal(canCollect(work, site, step), false);
});

test('parking in the planned place reaches the deposit and the actual digging stroke, in both directions', () => {
  for (const mirrored of [false, true]) for (const grade of [0, .2, -.2]) {
    const world = field({ mirrored, grade }), site = { x: 300, feature: 'outcrop', material: 'ferro' },
      area = workArea(world, 'truck', site, 30), dx = area.goal - 100, dy = grade * dx;
    // A unit geometry fixture, translated along the same slope to its proposed parking place.
    // Native driving to the site is covered by the logistics flow tests.
    const actor = world.actor('truck'); actor.vehicle.x += dx;
    world.modules = world.modules.map(part => ({ ...part, x: part.x + dx, y: part.y + dy }));
    world.plates = world.plates.map(part => ({ ...part, definition: { ...part.definition, x: part.definition.x + dx, y: part.definition.y + dy } }));
    world.time++;
    const work = collectionWork(world, 'truck')[0];
    assert.equal(workArea(world, 'truck', site, 30).ready, true);
    for (const share of [.11, .19, .27]) {
      const figure = workFigure(work.layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, x => world.terrain.height(x));
      assert(Math.abs(figure.tip.y - world.terrain.height(figure.tip.x)) < 1e-8);
      assert(figure.tip.x >= loadingZone(site).lo && figure.tip.x <= loadingZone(site).hi);
    }
  }
});

test('containers load a public pile only over its surface band and do not supply an extraction tool', () => {
  for (const [kind, material] of [['hopper', 'ferro'], ['cistern', 'petroleo']]) {
    const world = field({ kind }), site = { x: 100, feature: 'outcrop', material };
    assert.deepEqual(collectionWork(world, 'truck'), []);
    assert.deepEqual([workArea(world, 'truck', site, 30).digs, workArea(world, 'truck', site, 30).loads], [false, true]);
    assert.equal(workArea(world, 'truck', site, 30).ready, true);
    assert.equal(workArea(world, 'truck', { ...site, x: 125 }, 30).ready, false);
    assert.equal(workArea(world, 'truck', { ...site, material: material === 'ferro' ? 'petroleo' : 'ferro' }, 30), null);
    world.modules.find(piece => piece.kind === 'wheel').groundContact = null;
    assert.equal(workArea(world, 'truck', site, 30).ready, false, 'a vehicle at the apex of a jump cannot load the pile below');
  }
});

test('direct pickup has a fixed two-metre reach below the container floor, independent of capacity', () => {
  for (const [kind, material] of [['hopper', 'ferro'], ['cistern', 'petroleo']]) {
    const world = field({ kind }), piece = world.modules[0], site = { x: piece.x, feature: 'outcrop', material };
    piece.y = piece.height / 2 + 2;
    assert.deepEqual(loadingContainers(world, 'truck', site, 30), [piece]);
    piece.y += .01; world.time++;
    assert.deepEqual(loadingContainers(world, 'truck', site, 30), []);
    assert.equal(workArea(world, 'truck', site, 30), null, 'an unreachable mounting has no parking target');
    piece.width *= 2; piece.height *= 2; piece.capacityM3 *= 4; piece.y = piece.height / 2 + 2.01; world.time++;
    assert.equal(workArea(world, 'truck', site, 30), null, 'a larger reservoir cannot invent a longer loader');
    piece.y = piece.height / 2 - .2; world.time++;
    assert.deepEqual(loadingContainers(world, 'truck', site, 30), [], 'a buried container cannot collect through the soil');
  }
});

test('pickup measures the rotated floor over the actual terrain instead of the chassis centre or an axis-aligned corner', () => {
  for (const angle of [-.5, .5]) for (const mirrored of [false, true]) {
    const world = field({ kind: 'hopper', angle, mirrored }), piece = world.modules[0], site = { x: piece.x, material: 'ferro' };
    assert.equal(workArea(world, 'truck', site, 30)?.ready, true);
    world.terrain = { height: x => (x - piece.x) * Math.sign(angle) > .1 ? -5 : 0 }; world.time++;
    assert.deepEqual(loadingContainers(world, 'truck', site, 30), [], 'the tilted floor is over the lower side of the ledge');
    assert.equal(workArea(world, 'truck', site, 30), null);
  }
  for (const grade of [-.3, .3]) {
    const world = field({ kind: 'hopper', grade, angle: Math.atan(grade) }), piece = world.modules[0], site = { x: piece.x, material: 'ferro' };
    assert.equal(workArea(world, 'truck', site, 30)?.ready, true, 'ordinary loading remains available on either slope');
    world.terrain = { height: () => -5 }; world.time++;
    assert.equal(workArea(world, 'truck', site, 30), null, 'wheel contact elsewhere does not bridge a pit under the container');
  }
});

test('a jump temporarily suspends pickup without deleting its parking area and landing restores it', () => {
  const world = field({ kind: 'hopper' }), [piece, wheel] = world.modules, site = { x: piece.x, material: 'ferro' }, y = piece.y;
  wheel.groundContact = null; piece.y += 5; world.time++;
  assert.equal(workArea(world, 'truck', site, 30)?.ready, false);
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), []);
  piece.y = y; wheel.groundContact = { x: wheel.x, y: 0 }; world.time++;
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [piece]);
});

test('a drop under the container en route does not cancel an otherwise reachable loading destination', () => {
  const world = field({ kind: 'hopper' }), piece = world.modules[0], site = { x: 200, material: 'ferro' };
  world.terrain = { height: x => x < 150 ? -10 : 0 };
  const area = workArea(world, 'truck', site, 30), dx = area.goal - world.actor('truck').vehicle.x;
  assert.equal(area.ready, false);
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), []);
  world.actor('truck').vehicle.x += dx;
  world.modules = world.modules.map(part => ({ ...part, x: part.x + dx })); world.time++;
  assert.equal(workArea(world, 'truck', site, 30)?.ready, true);
  assert.deepEqual(loadingContainers(world, 'truck', site, 30).map(part => part.id), [piece.id]);
});

test('a low mouth over the material fills every container of its vehicle, and a vehicle whose containers all stand high has none', () => {
  const world = field({ kind: 'hopper' }), lower = world.modules[0], site = { x: lower.x, material: 'ferro' },
    high = { ...lower, id: 'high', y: 8 }, far = { ...lower, id: 'far', x: lower.x + 20 };
  world.modules = [...world.modules, high, far];
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [lower, high, far], 'the mouth first, then the others it fills');
  lower.capacityM3 = 1; lower.cargo = { ferro: 2400 }; world.time++;
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [high, far], 'a full low container still takes the pile in for the others');
  assert.equal(workArea(world, 'truck', site, 30)?.ready, true);
  for (const piece of [high, far]) piece.cargo = { ferro: cargoRoom(piece) * 2400 };
  world.time++;
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), []);
  assert.equal(workArea(world, 'truck', site, 30), null, 'a full vehicle has nowhere to load');
  for (const piece of [high, far]) piece.cargo = {};
  lower.health = 0; far.health = 0; world.time++;
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [], 'a high container is no mouth');
  assert.equal(workArea(world, 'truck', site, 30), null, 'the pilot cannot aim for a high or destroyed container');
});

test('an extractor loads a higher hopper only when it can both scoop the ground and deliver to that actual mouth', () => {
  const world = field(), hopper = { id: 'high', actorId: 'truck', kind: 'hopper', x: 100, y: 3, width: 1.6, height: .9, capacityM3: 1, health: 100 };
  world.modules = [...world.modules, hopper];
  let work = collectionWork(world, 'truck')[0];
  const site = { x: work.point, material: 'ferro', feature: 'outcrop' };
  assert(hopper.y - hopper.height / 2 > 2);
  assert.equal(canCollect(work, site, world.terrain), true);
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [hopper], 'the real arm can deliver above the direct pickup limit');
  assert.equal(workArea(world, 'truck', site, 30)?.ready, true);
  world.modules.find(piece => piece.kind === 'wheel').groundContact = null; world.time++;
  assert.equal(workArea(world, 'truck', site, 30)?.ready, false);
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [], 'an arm does not bypass the suspension of loading during a jump');
  world.modules.find(piece => piece.kind === 'wheel').groundContact = { x: 100, y: 0 };
  hopper.y = 12; world.time++;
  work = collectionWork(world, 'truck')[0];
  assert.equal(canCollect(work, site, world.terrain), true, 'the tool still extracts into the public pile');
  assert.deepEqual(loadingContainers(world, 'truck', site, 30), [], 'reaching the ground alone cannot authorize an unreachable mouth');
  const area = workArea(world, 'truck', site, 30);
  assert(area.digs && !(area.loads && area.ready), 'a possible approach never grants pickup at the current position');
});

// A vehicle to move about a site: what it carries (`parts`, each at its place along it) on one floor plate under them.
function vehicle(parts, x = 100) {
  const actor = { id: 'truck', vehicle: { x } }, ends = parts.flatMap(part => [part.x - part.width / 2, part.x + part.width / 2]),
    lo = Math.min(x - 3, ...ends), hi = Math.max(x + 3, ...ends),
    world = { actor: id => id === actor.id ? actor : null, time: 0, terrain: { height: () => 0 },
      modules: [...parts.map(part => ({ actorId: actor.id, y: 1.7, angle: 0, health: 100, ...part })),
        { id: 'wheel', actorId: actor.id, kind: 'wheel', x, y: .5, width: 1, height: 1, health: 100, groundContact: { x, y: 0 } }],
      plates: [{ id: 'floor', actorId: actor.id, definition: { x: (lo + hi) / 2, y: .6, length: hi - lo, angle: 0, thicknessMm: 10 } }] };
  world.moveTo = to => {
    const dx = to - actor.vehicle.x; actor.vehicle.x = to; world.time++;
    world.modules = world.modules.map(part => ({ ...part, x: part.x + dx, ...(part.groundContact ? { groundContact: { x: part.x + dx, y: 0 } } : {}) }));
    world.plates = world.plates.map(part => ({ ...part, definition: { ...part.definition, x: part.definition.x + dx } }));
  };
  return world;
}
const EXCAVATOR = { id: 'tool', kind: 'excavator', x: 99, width: 1.2, height: .6 }, HOPPER = { id: 'bin', kind: 'hopper', width: 2.4, height: 1.35, capacityM3: 1 };

test('one rule says where a vehicle works a deposit of any kind: standing anywhere, it is ready exactly where the field digs and loads', () => {
  const kinds = { hauler: [{ ...HOPPER, x: 100 }], tanker: [{ ...HOPPER, kind: 'cistern', x: 100 }], digger: [EXCAVATOR],
    miner: [EXCAVATOR, { ...HOPPER, x: 103 }], longMiner: [EXCAVATOR, { ...HOPPER, x: 106 }] };
  for (const feature of ['outcrop', 'ruins', 'talus', 'dune', 'lowland']) for (const [name, parts] of Object.entries(kinds)) {
    const material = name === 'tanker' ? 'petroleo' : 'ferro', site = { x: 300, feature, material }, world = vehicle(parts);
    for (let x = site.x - 30; x <= site.x + 30; x += .5) {
      world.moveTo(x);
      const area = workArea(world, 'truck', site, 30), digs = collectionWork(world, 'truck').some(work => canCollect(work, site, world.terrain)),
        loads = loadingContainers(world, 'truck', site, 30).length > 0;
      assert.equal(area.ready, (!area.digs || digs) && (!area.loads || loads), `${name} at ${x - site.x} m of ${feature}`);
    }
    // Sent to the place it would rather stand at, it works there.
    world.moveTo(site.x - 40); const goal = workArea(world, 'truck', site, 30).goal;
    world.moveTo(goal);
    const area = workArea(world, 'truck', site, 30);
    assert.equal(area.ready, true, `${name} at its goal on ${feature}`);
    if (area.digs) assert(collectionWork(world, 'truck').some(work => canCollect(work, site, world.terrain)));
    if (area.loads) assert(loadingContainers(world, 'truck', site, 30).length > 0);
    assert.equal(area.digs, name !== 'hauler' && name !== 'tanker'); assert.equal(area.loads, name !== 'digger');
  }
});

test('a vehicle whose tool and hopper stand too far apart to work at one place digs until the pile fills it, then takes the pile in', () => {
  const world = vehicle([EXCAVATOR, { ...HOPPER, x: 110 }]), site = { x: 300, feature: 'outcrop', material: 'ferro' },
    room = cargoRoom(world.modules.find(part => part.id === 'bin')) * 2400, dig = workArea(world, 'truck', site, 30);
  assert.deepEqual([dig.digs, dig.loads], [true, false], 'with no pile it goes to dig');
  assert.deepEqual([workArea(world, 'truck', site, 30, { stock: room / 2 }).digs], [true], 'and goes on digging while the pile is short of its room');
  const load = workArea(world, 'truck', site, 30, { stock: room });
  assert.deepEqual([load.digs, load.loads], [false, true], 'a pile that fills it, it takes in');
  assert(load.hi < dig.lo || dig.hi < load.lo, 'at a place of its own');
  world.moveTo(load.goal);
  assert.equal(workArea(world, 'truck', site, 30, { stock: room / 10 }).ready, true, 'standing where it loads, it takes in what is left');
  assert(loadingContainers(world, 'truck', site, 30).length > 0);
  assert.deepEqual([workArea(world, 'truck', site, 30).digs, workArea(world, 'truck', site, 30).ready], [true, false], 'and with the pile gone it goes back to dig');
});

test('hull clearance uses interpolated plate positions while keeping their physical dimensions', () => {
  const piece = { x: 100, y: 2, angle: 0 }, shape = { x: 80, y: 1, angle: 0, length: 6, thicknessMm: 10 },
    frame = workFrame(piece, [{ definition: shape, x: 100, y: 1, angle: 0 }]);
  assert.deepEqual(frame, { left: -3, right: 3, bottom: -1.005 });
});
