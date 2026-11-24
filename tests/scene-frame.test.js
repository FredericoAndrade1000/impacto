import test from 'node:test';
import assert from 'node:assert/strict';
import { componentPolygon } from '../src/assembly.ts';
import { sceneFrame, sampleScene, designFrame, regionGeometry, regionContains } from '../src/scene-frame.ts';
import { localToWorld } from '../src/math.ts';

const module = (extra = {}) => ({ id: 'wheel', actorId: 'first', kind: 'wheel', width: .8, height: .8,
  x: 4, y: 2, angle: 0, health: 100, maxHealth: 100, ...extra });
const state = modules => ({ time: 1, actors: [], plates: [], modules });
const surface = component => sceneFrame(state([component])).surfaces[0];

test('fresh snapshots and actors share a local component contour, with independent records and poses', () => {
  const first = module(), second = module({ id: 'other', actorId: 'second', x: 120000, y: -20, angle: 1.7, wheelSpin: 8 }),
    before = JSON.stringify([first, second]), a = surface(first), b = surface(second);
  assert.equal(a.geometry, b.geometry);
  assert.equal(a.data, first); assert.equal(b.data, second);
  const previous = state([first]), current = state([module({ x: 14, wheelSpin: 2 })]), scene = sampleScene(current, previous, .5);
  assert.equal(scene.pose('wheel').x, 9); assert.equal(scene.pose('wheel').wheelSpin, 2);
  assert.equal(scene.pose('wheel'), scene.pose('wheel'), 'all readers of a frame share the same sampled pose');
  assert.equal(scene.pose('absent'), null);
  assert.equal(scene.frame.surfaces[0].geometry, a.geometry);
  assert.equal(JSON.stringify([first, second]), before);
});

test('reflected component poses share canonical geometry and UVs', () => {
  for (const kind of ['track', 'engine', 'paver']) {
    const first = module({ kind, width: 3, height: .8 }), other = { ...first, mirrored: true },
      before = surface(first), reflected = surface(other);
    assert.equal(before.geometry, reflected.geometry);
    assert.equal(reflected.data.mirrored, true);
    assert.equal(sampleScene(state([other])).pose(other.id).mirrored, true);
  }
});

test('actor samples retain identity without admitting absent records or blending a replaced chassis', () => {
  const previous = { ...state([]), actors: [{ id: 'first', vehicle: { x: 120000, y: 2, angle: .2, chassisId: 'root' } }] },
    current = { ...state([module({ id: 'actor:absent' })]),
      actors: [{ id: 'first', vehicle: { x: 120010, y: 4, angle: .6, chassisId: 'root' } }, { id: 'invalid', vehicle: {} }] },
    original = JSON.stringify([previous, current]), scene = sampleScene(current, previous, .25), actor = scene.actor('first');
  assert.equal(scene.actor('first'), actor); assert.equal(actor.x, 120002.5); assert.equal(actor.y, 2.5);
  assert(Math.abs(actor.angle - .3) < 1e-12); assert.notEqual(actor, current.actors[0].vehicle);
  assert.equal(scene.pose('actor:first'), null, 'a cached actor cannot stand in for a missing part');
  assert(scene.pose('actor:absent')); assert.equal(scene.actor('absent'), null, 'a cached part cannot stand in for a missing actor');
  assert.equal(scene.actor('invalid'), null);
  const replacement = { ...current, actors: [{ id: 'first', vehicle: { ...current.actors[0].vehicle, chassisId: 'replacement' } }] },
    changed = sampleScene(replacement, previous, .25), fresh = changed.actor('first');
  assert.equal(fresh.x, 120010); assert.equal(fresh.y, 4); assert.equal(fresh.angle, .6);
  assert.equal(changed.actor('first'), fresh);
  assert.equal(JSON.stringify([previous, current]), original, 'sampling leaves immutable records untouched');
});

test('readmission changes the shared body and part boundary, while other actors keep moving smoothly', () => {
  const previous = { ...state([module({ wheelSpin: 12 }), module({ id: 'other-wheel', actorId: 'second', x: 20 })]),
    actors: [{ id: 'first', revision: 2, vehicle: { x: 4, y: 2, angle: Math.PI, chassisId: 'frame' } },
      { id: 'second', revision: 3, vehicle: { x: 20, y: 2, angle: 0, chassisId: 'other-frame' } }] },
    current = { ...state([module({ x: 14, wheelSpin: 0, mirrored: true }), module({ id: 'other-wheel', actorId: 'second', x: 24 })]),
      actors: [{ id: 'first', revision: 3, vehicle: { x: 14, y: 2, angle: 0, chassisId: 'frame' } },
        { id: 'second', revision: 3, vehicle: { x: 24, y: 2, angle: 0, chassisId: 'other-frame' } }] },
    before = JSON.stringify([previous, current]), scene = sampleScene(current, previous, .25);
  assert.equal(scene.actor('first').x, 14);
  assert.equal(scene.actor('first').angle, 0);
  assert.equal(scene.pose('wheel').x, 14);
  assert.equal(scene.pose('wheel').wheelSpin, 0);
  assert.equal(scene.pose('wheel').mirrored, true);
  assert.equal(scene.actor('second').x, 21);
  assert.equal(scene.pose('other-wheel').x, 21);
  const changed = { ...current, actors: current.actors.map(actor => actor.id === 'first'
    ? { ...actor, revision: 2, vehicle: { ...actor.vehicle, chassisId: 'replacement' } } : actor) };
  assert.equal(sampleScene(changed, previous, .25).pose('wheel').x, 14, 'another chassis also starts a fresh part pose');
  assert.equal(JSON.stringify([previous, current]), before);
});

// A turn readmits real Native parts with new IDs but retains the source design's chassisId.
// The renderer must use one admission for the body angle and all those fresh parts.
function checkTurn(before, after, actorId, chassisFrame, chassisPlacement) {
  const old = before.actors.find(actor => actor.id === actorId), now = after.actors.find(actor => actor.id === actorId),
    beforeIds = new Set(before.modules.filter(part => part.actorId === actorId).map(part => part.id));
  assert.notEqual(old.revision, now.revision);
  assert.equal(old.vehicle.chassisId, now.vehicle.chassisId);
  assert(after.modules.filter(part => part.actorId === actorId && part.kind === 'wheel').every(part => !beforeIds.has(part.id)));
  const fresh = sampleScene(after), frame = chassisFrame(fresh.frame.actorParts.get(actorId)),
    chassis = frame.data.definition.chassis, expected = chassisPlacement(fresh.pose(frame.id), chassis, now.vehicle.angle);
  for (const alpha of [0, .25, .5, .75, 1]) {
    const scene = sampleScene(after, before, alpha), body = scene.actor(actorId),
      placed = chassisPlacement(scene.pose(frame.id), chassis, body.angle);
    assert.deepEqual(body, fresh.actor(actorId), `alpha ${alpha}: do not turn the old body under the fresh parts`);
    assert(placed.up.x * expected.up.x + placed.up.y * expected.up.y > 1 - 1e-10, `alpha ${alpha}: chassis and suspension stay upright together`);
    for (const part of scene.frame.actorParts.get(actorId)) assert.deepEqual(scene.pose(part.id), fresh.pose(part.id));
  }
}

for (const model of ['truck', 'scout']) test(`${model}: a real Native turn samples its readmitted body and suspension together`, async t => {
  const [{ World }, { createConstruction }, { chassisFrame, chassisPlacement }] = await Promise.all([
    import('../src/physics.ts'), import('../src/construction-templates.ts'), import('../src/chassis-art.ts')]);
  const world = new World(createConstruction(model), { visualEvents: false }); t.after(() => world.dispose());
  for (let i = 0; i < 120; i++) world.step();
  world.controlVehicle(-1);
  for (let i = 0; i < 180; i++) world.step();
  world.controlVehicle(0, 1);
  for (let i = 0; i < 180; i++) world.step();
  const moving = structuredClone(world.snapshot());
  assert(moving.modules.some(part => part.kind === 'wheel' && Math.abs(part.wheelSpin) > 1), 'the fixture accumulated genuine wheel travel');
  world.command('setVehicleState', { actorId: 'local', state: { angle: Math.PI, y: world.vehicle.y + 3, vx: 0, vy: 0, omega: 0 } });
  const before = structuredClone(world.snapshot());
  world.turnActor('local');
  const after = structuredClone(world.snapshot());
  checkTurn(before, after, 'local', chassisFrame, chassisPlacement);
});

test('owner and visible observer frames keep the turn boundary through actual network encoding', async t => {
  const [{ rehearsal }, { chapters }, { createConstruction }, { FrameWriter, FrameReader }, { chassisFrame, chassisPlacement }] = await Promise.all([
    import('../server/room.ts'), import('../server/fog.ts'), import('../src/construction-templates.ts'),
    import('../src/network-protocol.ts'), import('../src/chassis-art.ts')]);
  for (const model of ['truck', 'scout']) {
    const room = rehearsal([0, 80]), world = room.world; t.after(() => world.dispose());
    const owner = room.join('Owner fixture'), observer = room.join('Observer fixture'),
      id = room.publish(owner.playerId, createConstruction(model), { x: 0 }).actor.id,
      watching = room.publish(observer.playerId, createConstruction('recon'), { x: 20 }).actor.id;
    for (let i = 0; i < 120; i++) room.step();
    world.command('setVehicleState', { actorId: id, state: { angle: Math.PI, y: world.actor(id).vehicle.y + 3, vx: 0, vy: 0, omega: 0 } });
    const clients = [id, watching].map(actorId => ({ team: world.actor(actorId).team, writer: new FrameWriter(), reader: new FrameReader() })),
      take = () => {
        room.sight();
        const snapshot = world.snapshot(), parts = chapters(snapshot);
        return clients.map(client => structuredClone(client.reader.decode(client.writer.encode({
          state: room.audience(snapshot, parts, [], client.team).state, events: [] })).state));
      }, before = take();
    world.turnActor(id);
    const after = take();
    for (let i = 0; i < clients.length; i++) {
      assert(before[i].actors.some(actor => actor.id === id) && after[i].actors.some(actor => actor.id === id), 'the real sensors see the fixture');
      checkTurn(before[i], after[i], id, chassisFrame, chassisPlacement);
    }
  }
});

test('component dimensions and kind invalidate the contour while damage and attachment retain their own presentation data', () => {
  const first = surface(module()), changed = [module({ width: .800001 }), module({ height: 1.2 }), module({ kind: 'track' })];
  for (const component of changed) {
    const shape = surface(component).geometry, points = componentPolygon({ ...component, x: 0, y: 0, angle: 0 });
    assert.notEqual(shape, first.geometry);
    assert.deepEqual(shape.positions, new Float32Array(points.flatMap(p => [p.x, p.y])));
    assert.deepEqual(shape.uvs, new Float32Array(points.flatMap(p => [p.x / component.width + .5, .5 - p.y / component.height])));
  }
  const broken = module({ health: 0, attached: false, armorMm: 40, markRevision: 4, marks: [{ x: .2, y: .3 }] }), item = surface(broken);
  assert.equal(item.geometry, first.geometry);
  assert.equal(item.data, broken); assert.equal(item.component.health, 0); assert.equal(item.gear, false);
  assert.equal(item.layer, 'moduleLayer');
  assert.equal(sceneFrame(state([])).surfaces.length, 0, 'removed parts do not persist in a later scene');
});

test('custom component shapes cannot grow the contour cache without a bound', () => {
  const first = module({ kind: 'engine', width: 101.123456789, height: .73 }), geometry = surface(first).geometry;
  for (let i = 0; i < 512; i++) surface(module({ kind: 'engine', width: 200 + i / 512, height: .73 }));
  const rebuilt = surface(first).geometry;
  assert.notEqual(rebuilt, geometry, 'an unused old custom shape is eventually released');
  assert.deepEqual(rebuilt, geometry, 'eviction only changes ownership, not the generated contour');
});

test('weapons stay out of shared component surfaces, including configurable mounts', () => {
  assert.equal(sceneFrame(state([module({ kind: 'weapon', weaponMount: { arbitrary: true } })])).surfaces.length, 0);
});

test('plate views preserve UVs and picking through reflection, apertures and complete material removal', () => {
  for (const angle of [.61, Math.PI - .61]) {
    const definition = { id: 'hull', material: 'steel', x: 120000, y: 3, angle, length: 4, thicknessMm: 100 },
      whole = designFrame({ plates: [definition], modules: [] }).plates[0], geometry = regionGeometry(whole);
    for (let i = 0; i < geometry.positions.length; i += 2) {
      assert(Math.abs(geometry.uvs[i] - (geometry.positions[i] / 4 + .5)) < 1e-7);
      assert(Math.abs(geometry.uvs[i + 1] - (.5 - geometry.positions[i + 1] / .1)) < 1e-7);
    }
    assert(regionContains(whole, localToWorld(definition, 0, 0)));
    const cut = { ...whole, revision: 1, solidRegions: [{ minX: -2, maxX: -.2, minY: -.05, maxY: .05 },
      { minX: .2, maxX: 2, minY: -.05, maxY: .05 }] };
    assert.equal(regionContains(cut, localToWorld(definition, 0, 0)), false);
    assert(regionContains(cut, localToWorld(definition, -1, 0)));
    assert.deepEqual(cut.definition, whole.definition);
    const empty = { ...cut, revision: 2, solidRegions: [] };
    assert.equal(regionGeometry(empty).indices.length, 0);
    assert.equal(regionContains(empty, localToWorld(definition, -1, 0)), false);
  }
});
