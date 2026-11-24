import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { damageConstruction, face, interior } from './damage-fixtures.js';
import { setVehicle, setPart, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { weaponSettings } from '../src/weapons.ts';
import { referenceScenario } from '../src/scenarios.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { Worker } from 'node:worker_threads';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { shotCount } from '../src/shots.ts';
import { mechanicalState, physicsState, partPhysics } from '../scripts/review-harness.ts';
import { componentReference } from '../src/component-size.ts';
import { cellOf } from '../src/grid.ts';

function exposedWorld(t, kind, elevated = false) {
  const source = createConstruction(kind === 'wheel' ? 'scout' : 'heavy');
  source.components = source.components.filter(part => part.kind === kind).slice(0, 1);
  source.name = `Avaria de componente exposto · ${kind}`;
  const world = managedWorld(t, source), front = face(world, 'front');
  // The authored carrier stays closed and massive. A real ballistic aperture,
  // not deleting a wall/connection, exposes the selected installed component.
  world.cutBody(front, front.definition, front.definition, front.definition.length);
  if (elevated) setVehicle(world, { x: 12, y: 20, angle: 0, vx: 0, vy: 0, omega: 0 });
  return world;
}
function fireAtComponent(world, component) {
  world.game().call({ op: 'configureLauncher', point: { x: component.x - component.width - 1, y: component.y } });
  assert(world.fire({ x: component.x + 2, y: component.y },
    weaponSettings('machinegun', { preset: 'fnmag', spread: 0 }), true));
  advance(world);
}
// One contact of a stated power: an armour-piercing round set two centimetres off the left
// end of a component and flown level into it, spent a few centimetres inside.
const strike = (world, component, power, radius) => flyRound(world, { x: component.x - component.width / 2 - .02, y: component.y,
  vx: 600, vy: 0, power, radius, mass: .2, caliberMm: radius * 2000, ammo: 'ap' }, .0001);
function appliedComponentPulse(world) {
  const module = world.modules[0], momentum = () => {
    const state = mechanicalState(world); return { x: state.px, y: state.py, mass: state.mass };
  }, initial = momentum(), begin = world.time, events = [];
  // The installed floor extends beyond the module: its convex footprint is
  // part of the carrier. Keep this test's explosion strictly outside that hull.
  const x = Math.min(module.x - module.width / 2, ...world.plates.flatMap(plate => plate.nodes.map(node => node.x))) - 1;
  world.explode(x, module.y, 50, Math.max(2, module.x - x + module.width), null);
  for (let i = 0; i < 4; i++) { world.step(); events.push(...world.drainEvents()); }
  assert.equal(events.filter(e => e.type === 'explosion').length, 1, 'the pulse comes from the native explosion');
  const end = momentum();
  assert.equal(end.mass, initial.mass, 'the pulse leaves the complete resistant installation mass');
  // These fixtures are elevated above terrain. There are no internal joint reactions;
  // gravity is their only other external load.
  return { x: end.x - initial.x, y: end.y - initial.y + initial.mass * Math.fround(9.81) * (world.time - begin) };
}


for (const kind of ['engine', 'weapon', 'wheel', 'track']) {
  test(`one blocked FN MAG hit damages the exposed ${kind} without severing its casing or mount`, (t) => {
    const world = exposedWorld(t, kind), component = world.modules[0];
    assert.equal(component.attached, true, 'the test starts with a real chassis connection');
    const initialMass = component.physicalMass;
    fireAtComponent(world, component);
    assert(component.health < component.maxHealth && component.health > 0);
    assert.equal(component.attached, true, 'a stopped bullet does not sever a remote connection');
    assert.equal(world.stats.explosions, 0);
    assert.equal(component.physicalMass, initialMass, 'the intact installation keeps its admitted mass');
    if (kind === 'weapon') {
      const hit = world.index.raycast({x: component.x-component.width, y: component.y},
        {x: component.x+component.width, y: component.y});
      assert.equal(hit?.owner.id, component.id, 'the installed receiver remains real ballistic cover');
      assert.equal(partPhysics(world, component).body, partPhysics(world, world.plates[0]).body);
    }
  });
}

for (const kind of ['engine', 'track']) {
  test(`later casing contacts continue to reduce ${kind} functionality without artificial disassembly`, (t) => {
    const world = exposedWorld(t, kind), component = world.modules[0];
    fireAtComponent(world, component);
    const afterFirst = component.health;
    for (let shot = 1; shot < 24; shot++) {
      advance(world, 5);
      fireAtComponent(world, component);
    }
    assert(component.health < afterFirst, 'repeated material contacts keep damaging the mechanism');
    if (kind === 'track') assert(component.health > component.maxHealth * 0.8, 'a short rifle-calibre burst damages but does not disable a complete track');
    else assert.equal(component.health, 0, 'repeated exposed engine damage can disable functionality');
    assert.equal(component.attached, true, 'functional failure preserves resistant mounts');
    assert.equal(world.stats.explosions, 0);
    assert.equal(partPhysics(world, component).body, partPhysics(world, face(world, 'floor')).body);
  });
}

test('component impact position controls functional damage and keeps the marks on its material UVs', (t) => {
  const middle = exposedWorld(t, 'engine'),
    edge = exposedWorld(t, 'engine'),
    centreModule = middle.modules[0], edgeModule = edge.modules[0];
  fireAtComponent(middle, centreModule);
  const y = edgeModule.y + edgeModule.height * 0.45;
  edge.command('configureLauncher', { point: { x: edgeModule.x - edgeModule.width - 1, y } });
  assert(edge.fire({ x: edgeModule.x + 2, y },
    weaponSettings('machinegun', { preset: 'fnmag', spread: 0 }), true));
  advance(edge);
  assert(centreModule.health < edgeModule.health, 'a mechanism hit differs from a casing edge graze');
  assert.equal(centreModule.attached, true);
  assert.equal(edgeModule.attached, true);
  assert(centreModule.marks.some((m) => Math.abs(m.v - 0.5) < 0.02));
  assert(edgeModule.marks.some((m) => m.v < 0.1));
  for (const module of [centreModule, edgeModule]) {
    assert(module.markRevision > 0);
    assert(module.marks.every((m) => m.u >= 0 && m.u <= 1 && m.v >= 0 && m.v <= 1));
  }
});

test('individually insufficient concrete bursts leave marks without eroding material or remeshing', (t) => {
  for (const preset of ['fnmag', 'm2hb']) {
    const blueprint = damageConstruction({ frontThickness: 480, material: 'concrete' }),
      world = managedWorld(t, blueprint), plate = face(world, 'front'),
      originalCells = plate.activeIndices.length / 3, originalNodes = plate.nodes.length;
    world.command('configureLauncher', { point: { x: plate.definition.x - 4, y: plate.definition.y } });
    const intactGrid = structuredClone(plate.ballisticGrid), revision = plate.revision;
    world.setTrigger(true, plate.definition, weaponSettings('machinegun', { preset }));
    advance(world, 240);
    assert(world.stats.shots >= 30, 'the test exercises a sustained burst, not one isolated dent');
    assert.equal(world.stats.explosions, 0);
    assert(plate.marks.length > 0);
    assert(Math.abs(plate.remainingArea - plate.originalArea) < 1e-12 * Math.max(1, plate.originalArea),
      'the material area remains whole within polygon-sum rounding');
    assert.deepEqual(plate.ballisticGrid, intactGrid, 'stopped rounds do not accumulate energy into a later cut');
    assert.equal(plate.revision, revision, 'no material-cut revision is produced');
    assert.equal(world.stats.penetrations, 0);
    // The former dense baseline began with hundreds of cells. Sparse geometry
    // must stay below that old absolute budget even after contact refinement.
    assert(originalCells < 50 && originalNodes < 50);
    assert.equal(plate.activeIndices.length / 3, originalCells, 'surface impacts never add contact triangles');
    assert.equal(plate.nodes.length, originalNodes, 'surface impacts never add contour vertices');
    assert(plate.ballisticGrid.nx * plate.ballisticGrid.ny <= 4096);
    assert(physicsState(world).colliders < 150);
  }
});

test('one strong blocked concrete impact immediately chips its face while the rear wall remains', t => {
  const world = managedWorld(t, damageConstruction({ frontThickness: 1000, material: 'concrete' })),
    plate = face(world, 'front'), originalCells = plate.activeIndices.length / 3, originalNodes = plate.nodes.length,
    x = Math.min(...plate.nodes.map(node => node.x)) - .02, y = plate.definition.y;
  flyRound(world, { x, y, vx: 600, vy: 0, power: 155, radius: .0125, mass: .2, caliberMm: 25, ammo: 'ap' }, .0001);
  assert.equal(world.stats.impacts, 1); assert.equal(world.stats.penetrations, 0);
  assert(plate.remainingArea < plate.originalArea, 'the current impact alone creates the crater');
  assert(world.index.raycast({ x, y }, { x: plate.definition.x + 1, y }), 'the rear material still stops a ray');
  assert(plate.marks.some(mark => mark.kind === 'crack'));
  assert.equal(plate.activeIndices.length / 3, originalCells); assert.equal(plate.nodes.length, originalNodes);
  assert(plate.ballisticGrid.nx * plate.ballisticGrid.ny <= 4096);
  assert.equal(world.stats.explosions, 0);
});

test('a component disabled during a blast keeps receiving the remaining physical impulse', (t) => {
  const healthy = exposedWorld(t, 'engine', true),
    failed = exposedWorld(t, 'engine', true);
  const game = failed.game();
  game.call({ op: 'setPartState', owner: game.handle(failed.modules[0]), state: { health: 1 } });
  const beforeFailure = appliedComponentPulse(healthy), throughFailure = appliedComponentPulse(failed);
  assert(healthy.modules[0].health > 0);
  assert.equal(failed.modules[0].health, 0);
  assert.equal(failed.modules[0].physicalMass, healthy.modules[0].physicalMass);
  assert(beforeFailure.x > 0);
  assert(Math.abs(throughFailure.x - beforeFailure.x) < 1e-5,
    `functional failure lost blast impulse: ${throughFailure.x} versus ${beforeFailure.x}`);
  assert(Math.abs(throughFailure.y - beforeFailure.y) < 1e-5);
});

test('rigid running gear receives blast impulse once regardless of its functional health', (t) => {
  const healthy = exposedWorld(t, 'track', true),
    failed = exposedWorld(t, 'track', true);
  setPart(failed, failed.modules[0], { health: 0 });
  const livePulse = appliedComponentPulse(healthy), deadPulse = appliedComponentPulse(failed);
  assert(healthy.modules[0].health > 0);
  assert.equal(failed.modules[0].health, 0);
  assert(livePulse.x > 0);
  assert(Math.abs(livePulse.x - deadPulse.x) < 1e-5,
    'the same installed gear must not receive two blast impulse budgets');
  assert(Math.abs(livePulse.y - deadPulse.y) < 1e-5);
});

test('a penetrating gear hit preserves the carrier and the installed ballistic hitbox',t=>{
  const world=exposedWorld(t, 'track'),component=world.modules[0],mass=component.physicalMass;
  strike(world,component,300,.008);
  assert.equal(world.stats.penetrations,1);assert(component.health<component.maxHealth);assert(component.attached);
  assert.equal(component.physicalMass,mass);
  assert(world.index.raycast({x:component.x-component.width,y:component.y},{x:component.x+component.width,y:component.y}));
});



test('a rocket detonating against an inner wall causes real damage and one explosion', (t) => {
  const blueprint = referenceScenario('enclosure').blueprint;
  blueprint.launcher = { x: 12, y: 1.65 };
  const world = managedWorld(t, blueprint);
  assert(world.fire({ x: 14, y: 1.65 }, weaponSettings('rocket', { preset: 'at4', spread: 0 }), true));
  advance(world, 4);
  assert.equal(world.stats.explosions, 1);
  assert(world.plates.some(p=>p.marks.length>0));
  assert(world.events.some((e) => e.type === 'explosion'));
});

test('runtime damage stays out of the original exported project and disappears on restore', (t) => {
  const blueprint = referenceScenario('enclosure').blueprint,
    world = managedWorld(t, blueprint), original = serializeBlueprint(world.construction);
  world.explode(11.5, 1.65, 140, 1.1);
  advance(world, 10);
  assert(world.events.some(e=>e.type==='explosion'));
  assert.equal(serializeBlueprint(world.construction), original);
  assert.deepEqual(parseBlueprint(original), world.construction);
  world.reset();
  assert.equal(world.tick, 0);
  assert.equal(world.projectiles.length, 0);
  assert(world.plates.every((p) => p.integrity === 1));
});

test('compact PvP frames preserve component failure while removing only the departed actor', (t) => {
  const world = managedWorld(t, damageConstruction()),
    blueprint = referenceScenario('enclosure').blueprint;
  const floor = Math.min(...blueprint.nodes.map(node => node.y));
  blueprint.components = [interior('engine', { x: 0, y: floor + cellOf(.5 + componentReference({ kind: 'engine' }).height / 2) })];
  world.removeActor('local');
  world.addActor(blueprint, { id: 'alice', ownerId: 'a', x: 2 });
  world.addActor(blueprint, { id: 'bob', ownerId: 'b', x: 18 });
  // A round through the engine from inside the enclosure puts it out of action.
  strike(world, world.modules.find((m) => m.actorId === 'alice'), 160, .01);
  world.explode(1.5, 1.65, 140, 1.1);
  advance(world, 2);
  const first = world.snapshot(), writer = new FrameWriter(), reader = new FrameReader();
  const initialPacket = reader.decode(writer.encode({ state: first, events: world.drainEvents() }, true));
  assert(initialPacket);
  assert.equal(initialPacket.state.modules.find((m) => m.actorId === 'alice').health, 0);
  assert.equal(initialPacket.state.modules.find((m) => m.actorId === 'bob').health,
    initialPacket.state.modules.find((m) => m.actorId === 'bob').maxHealth);
  world.removeActor('alice');
  const next = world.snapshot(), packet = reader.decode(writer.encode({ state: next, events: [] }));
  assert(packet); assert.deepEqual(packet.state, new FrameReader().decode(new FrameWriter().encode({ state: next, events: [] }, true)).state, 'a construction gone from the list takes its parts with it');
  assert.deepEqual(packet.state.actors.map((a) => a.id), ['bob']);
});

test('worker pause and restore freeze or clear explosion effects and damage at the correct tick',
  { timeout: 10000 }, async (t) => {
    const worker = new Worker(new URL('../scripts/worker-review-harness.ts', import.meta.url));
    t.after(() => worker.terminate());
    const messages = [], waiters = new Set();
    worker.on('message', (packet) => {
      messages.push(packet);
      if (packet.type === 'frame') worker.postMessage({ type: 'ack', serial: packet.serial });
      for (const waiter of waiters) if (waiter.predicate(packet)) {
        clearTimeout(waiter.timeout); waiters.delete(waiter); waiter.resolve(packet);
      }
    });
    const waitFor = (predicate) => {
      const prior = messages.find(predicate);
      if (prior) return Promise.resolve(prior);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timeout: setTimeout(() => {
          waiters.delete(waiter); reject(new Error('Worker did not deliver the expected frame: ' +
            JSON.stringify(messages.map((p) => ({ type: p.type, request: p.request, error: p.error,
              serial: p.serial, tick: p.state?.tick, events: p.events?.map((e) => e.type) })))));
        }, 6000) };
        waiters.add(waiter);
      });
    };
    await waitFor((p) => p.type === 'ready');
    // A rocket of the bench strikes the box, as in a test of armour; the test rests, and is begun again.
    const scene = referenceScenario('rocketbox');
    worker.postMessage({ type: 'load', request: 'load', generation: 7, blueprint: scene.blueprint, paused: true });
    const loaded = await waitFor((p) => p.type === 'frame' && p.generation === 7 && p.state.tick === 0);
    assert.equal(loaded.state.time, 0);
    worker.postMessage({ type: 'fire', request: 'fire', aim: scene.aim, weapon: scene.weapon, force: true });
    const queued = await waitFor((p) => p.type === 'frame' && p.serial > loaded.serial && p.events.some((e) => e.type === 'muzzle'));
    assert.equal(queued.state.tick, 0, 'a paused command queues its effects without integrating physics');
    worker.postMessage({ type: 'pause', request: 'run', value: false });
    const struck = await waitFor((p) => p.type === 'frame' && p.serial > queued.serial && p.events.some((e) => e.type === 'explosion'));
    assert(struck.state.tick > 0);
    worker.postMessage({ type: 'pause', request: 'paused-again', value: true });
    const still = await waitFor((p) => p.type === 'frame' && p.serial > struck.serial && p.paused);
    worker.postMessage({ type: 'reset', request: 'reset' });
    const restored = await waitFor((p) => p.type === 'frame' && p.serial > still.serial && p.state.tick === 0);
    assert(restored.paused);
    assert.equal(shotCount(restored.state.shots), 0);
    assert.deepEqual(restored.state.plates.map(p => [p.definition, p.solidRegions]), loaded.state.plates.map(p => [p.definition, p.solidRegions]));
    assert.equal(restored.events.length, 0, 'reset must not replay an old explosion');
  });
