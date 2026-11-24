import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { MODULE_STATE, PLATE_STATE } from '../src/rust-game.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { rehearsal } from '../server/room.ts';
import { Publication } from '../server/publication.ts';
import { writeField, readField } from '../server/field-snapshot.ts';
import { emptyBlueprint, sensed } from './helpers/perception-scene.js';
import { duel } from './helpers/duel.js';

function activeWorld(t) {
  const world = new World(createStructuredTemplate('heavy'));
  t.after(() => world.dispose());
  world.addActor(createStructuredTemplate('heavy'), { id: 'other', ownerId: 'other', x: 60 });
  world.game();
  return world;
}

function state(world) {
  const game = world.game();
  return {
    game, objects: [...game.objects], actors: world.actors, plates: world.plates, modules: world.modules,
    projectiles: world.projectiles, events: world.events,
    nativeActors: world.nativeActors,
    nextId: world.nextId, nextOwner: world.nextOwner, nextActor: world.nextActor,
    snapshot: world.snapshot(), physics: world.game().call({ op: 'physics' }),
  };
}

function unchanged(world, before) {
  for (const key of ['actors', 'plates', 'modules', 'projectiles', 'events',
    'nativeActors', 'nextId', 'nextOwner', 'nextActor'])
    assert.equal(world[key], before[key], key);
  assert.equal(world.game(), before.game);
  assert.deepEqual([...world.game().objects], before.objects);
  for (const [handle, part] of before.objects) {
    assert.equal(world.game().handle(part), handle);
    assert.equal(world.game().handle(part.id), handle);
  }
  assert.deepEqual(world.snapshot(), before.snapshot);
  assert.deepEqual(world.game().call({ op: 'physics' }), before.physics);
  assert(!Object.hasOwn(world.snapshot(), 'fragments'));
}

// A construction that comes to a scene the core has is told to it alone (`admit`): the core is made to refuse it.
const admission = call => JSON.parse(call.arguments[0]).op === 'admit';
function rejectNativeScene(t, world) {
  const core = world.dynamics.core, command = core.game_command;
  return t.mock.method(core, 'game_command', function (request) {
    const packet = JSON.parse(request);
    if (packet.op === 'admit') packet.plates[0].indices = [0, 1, 999999];
    return command.call(this, JSON.stringify(packet));
  });
}

test('cold scene composition remains lazy and does not require a native installation per actor', t => {
  const world = new World(emptyBlueprint());
  t.after(() => world.dispose());
  const actor = world.addActor(createStructuredTemplate('heavy'), { id: 'new', x: 60 });
  assert.equal(world.rustGame, null);
  actor.vehicle.vx = 3;
  const game = world.game();
  assert.equal(game.world, world);
  assert.equal(world.actor('new').vehicle.vx, 3);
});

test('invalid input and failed preparation preserve the admitted scene and its counters', t => {
  const world = activeWorld(t), before = state(world), design = createStructuredTemplate('heavy');
  assert.throws(() => world.addActor(design, { id: 'other' }), /já existe/);
  assert.throws(() => world.addActor(design, { id: 'bad', facing: 0 }), /Orientação/);
  assert.throws(() => world.addActor(design, { id: 'bad', x: NaN }), /Posição/);
  assert.throws(() => world.replaceActor({ version: 0 }, { id: 'other' }), /não é um projeto desta versão/);
  world.removeActor('missing');
  unchanged(world, before);
  const casing = t.mock.method(world, 'buildAssembly', () => { throw new Error('Assembly preparation failed'); });
  assert.throws(() => world.replaceActor(design, { id: 'other' }), /preparation failed/);
  casing.mock.restore();
  unchanged(world, before);
});

test('a native rejection leaves add and replace uncommitted and the old solver usable', t => {
  const world = activeWorld(t), before = state(world), load = rejectNativeScene(t, world);
  for (const change of [
    () => world.addActor(createStructuredTemplate('heavy'), { id: 'new', x: 120 }),
    () => world.replaceActor(createStructuredTemplate('heavy'), { id: 'other' }),
  ]) {
    assert.throws(change, /indices|index|outside|material/i);
    unchanged(world, before);
  }
  assert.equal(load.mock.calls.filter(admission).length, 2);
  load.mock.restore();
  world.controlVehicle(.5, 0, 'other');
  world.step();
  assert.equal(world.tick, before.snapshot.tick + 1);
  assert.equal(world.actor('other').vehicle.throttle, .5);
});

test('a projection preparation failure releases pending handles before the native admission', t => {
  const world = activeWorld(t), before = state(world), game = world.game(), told = game.told,
    prepare = t.mock.method(game, 'told', function (...args) {
      told.apply(this, args);
      throw new Error('Projection preparation failed');
    });
  for (const change of [
    () => world.addActor(createStructuredTemplate('heavy'), { id: 'new', x: 120 }),
    () => world.replaceActor(createStructuredTemplate('heavy'), { id: 'other' }),
  ]) {
    assert.throws(change, /Projection preparation failed/);
    unchanged(world, before);
  }
  prepare.mock.restore();
  const fresh = world.addActor(createStructuredTemplate('heavy'), { id: 'new', x: 120 });
  assert.equal(fresh.id, 'new');
  assert.equal(world.game().objects.get(before.nextOwner), world.plates.find(part => part.actorId === fresh.id));
});

test('a construction that comes to a live scene, or leaves it, is told to the core alone: the others stand as they stood', t => {
  const world = activeWorld(t), game = world.game(), load = t.mock.method(world.dynamics.core, 'load_game');
  for (let i = 0; i < 40; i++) world.step();
  world.sync();
  const stands = id => { const v = world.actor(id).vehicle; return [v.x, v.y, v.angle, v.vx, v.vy, v.omega]; },
    parts = id => world.plates.filter(p => p.actorId === id).map(p => [p.definition.x, p.definition.y, p.definition.angle]),
    before = [stands('local'), stands('other'), parts('other')], time = world.time;
  const came = world.addActor(createStructuredTemplate('heavy'), { id: 'new', ownerId: 'new', x: 120 });
  assert.equal(load.mock.calls.length, 0); assert.equal(world.game(), game); assert.equal(world.time, time);
  assert.deepEqual([stands('local'), stands('other'), parts('other')], before);
  // It is there all that a scene loaded whole says of it: what its parts weigh, how its gun is shaped, what its eyes see.
  const whole = new World(createStructuredTemplate('heavy'));
  t.after(() => whole.dispose());
  whole.addActor(createStructuredTemplate('heavy'), { id: 'other', ownerId: 'other', x: 60 });
  whole.addActor(createStructuredTemplate('heavy'), { id: 'new', ownerId: 'new', x: 120 });
  // (Each is read once more, as a frame tells it; the handles the core knows the parts by are each world's own.)
  whole.command('sync'); world.command('sync');
  const said = scene => JSON.parse(JSON.stringify({
    modules: scene.modules.filter(m => m.actorId === 'new').map(m => ({ id: m.id, x: m.x, y: m.y, angle: m.angle, ...Object.fromEntries(MODULE_STATE.map(key => [key, m[key]])), suspension: m.suspension })),
    plates: scene.plates.filter(p => p.actorId === 'new').map(p => ({ id: p.id, definition: p.definition, grid: p.ballisticGrid, ...Object.fromEntries(PLATE_STATE.map(key => [key, p[key]])) })),
    actor: (({ vehicle, eyes, aim, contactContours }) => ({ eyes, aim, contactContours, mass: vehicle.mass, carrierMass: vehicle.carrierMass, x: vehicle.x, y: vehicle.y }))(scene.actor('new')) },
    (key, value) => key === 'owner' || key === 'hostOwner' ? undefined : value));
  assert.deepEqual(said(world), said(whole));
  assert(came.contactContours.length > 0 && came.contactContours.every(contour => contour.length >= 3));
  assert(came.eyes.length > 0 && world.modules.some(m => m.actorId === 'new' && m.materialPolygons));
  // It drives and fires as any other, and the one that takes its place or leaves does so alone too.
  world.controlVehicle(1, 0, 'new');
  for (let i = 0; i < 60; i++) world.step();
  world.sync();
  assert(Math.abs(world.actor('new').vehicle.vx) > .1);
  world.replaceActor(createStructuredTemplate('heavy'), { id: 'other' });
  world.removeActor('new');
  for (let i = 0; i < 20; i++) world.step();
  assert.equal(load.mock.calls.length, 0); assert.equal(world.game(), game);
  assert.deepEqual(world.snapshot().actors.map(a => a.id), ['local', 'other']);
  assert.equal(world.game().call({ op: 'physics' }).bodies, 2);
  assert.deepEqual([...world.nativeActors.keys()], ['local', 'other'], 'the identity registry keeps only constructions still in the scene');
  assert.deepEqual([...game.actorHandles.keys()], ['local', 'other']);
});

test('replacement keeps other identities, live projectiles and rigid visual panels', t => {
  const world = activeWorld(t);
  world.explode(12, 1.3, .01, .02);
  world.step();
  assert(world.fire({ x: -300, y: 4 }, weaponSettings('cannon', { preset: 'rh120', spread: 0 }), true));
  const kept = world.actor('local'), plate = world.plates.find(part => part.actorId === 'local'),
    owner = world.game().handle(plate), beforeProjectiles = structuredClone(world.projectiles),
    panels = structuredClone(world.snapshot().bodyPanels.filter(panel => panel.actorId === 'local')),
    beforeTime = world.time, beforeTick = world.tick, old = world.actor('other');
  assert(beforeProjectiles.length > 0);
  assert(panels.length > 0);
  const replacement = world.replaceActor(createStructuredTemplate('heavy'), { id: 'other', revision: 99 });
  assert.equal(replacement.id, old.id);
  assert.equal(replacement.revision, old.revision + 1);
  assert.equal(replacement.ownerId, old.ownerId);
  assert.notEqual(replacement, old);
  assert.equal(world.actor(old.id), replacement);
  assert.equal(world.actor('local'), kept);
  assert.equal(world.game().handle(plate), owner);
  assert.equal(world.time, beforeTime); assert.equal(world.tick, beforeTick);
  assert.deepEqual(world.projectiles, beforeProjectiles);
  assert.deepEqual(world.snapshot().bodyPanels.filter(panel => panel.actorId === 'local'), panels);
  assert.equal(world.game().world, world);
  world.step();
  assert.equal(world.tick, beforeTick + 1);
});

test('removing or replacing a shooter invalidates cached rounds before the next physics step', t => {
  for (const replace of [false, true]) {
    const world = activeWorld(t);
    for (const actorId of ['local', 'other']) {
      const gun = world.modules.find(part => part.actorId === actorId && part.kind === 'weapon'),
        aim = { x: gun.x + Math.cos(gun.barrelAngle) * 100, y: gun.y + Math.sin(gun.barrelAngle) * 100 };
      assert(world.fire(aim, world.playerWeapon({ platform: 'vehicle', componentId: gun.id }, actorId), true, actorId));
    }
    const retained = structuredClone(world.projectiles.filter(round => round.actorId === 'local'));
    assert.equal(retained.length, 1); assert.equal(world.projectiles.length, 2); assert.equal(world.shots.data.length, 16);
    const tick = world.tick;
    if (replace) world.replaceActor(createStructuredTemplate('heavy'), { id: 'other' });
    else world.removeActor('other');
    assert.deepEqual(world.projectiles, retained, 'only the departed shooter loses its rounds');
    assert.equal(world.shots.data.length, 8, 'the binary publication agrees immediately');
    assert.equal(world.tick, tick, 'no extra simulation step is needed to observe removal');
  }
});

test('cold actor admission neither refreshes, erases nor extends the aged sensor memory of an observer', t => {
  const w = duel(t, createStructuredTemplate('recon'), { separation: 60, visualEvents: false }), game = w.game();
  assert(sensed(w, 'local', 'opponent').detected);
  for (const part of w.modules.filter(m => m.actorId === 'local' && ['command', 'sensor'].includes(m.kind)))
    game.call({ op: 'setPartState', owner: game.handle(part), state: { health: 0 } });
  for (let step = 0; step < 6; step++) w.step();
  const aged = sensed(w, 'local', 'opponent');
  assert(aged.detected); assert.equal(aged.source, 'memory'); assert(aged.age > 0);
  w.addActor(createStructuredTemplate('recon'), { id: 'extra', ownerId: 'opponent', x: 350, facing: 1 });
  assert.deepEqual(sensed(w, 'local', 'opponent'), aged, 'cold admission cannot refresh or erase what the observer remembers');
  w.removeActor('extra');
  assert.deepEqual(sensed(w, 'local', 'opponent'), aged);
  for (let step = 0; step < 126; step++) w.step();
  assert.equal(sensed(w, 'local', 'opponent').detected, false, 'cold admission cannot extend contact lifetime');
});

test('a rejected network replacement preserves ownership, selection, cooldown and the old construction', t => {
  const room = rehearsal(), player = room.join('Alice');
  t.after(() => room.world.dispose());
  const published = room.publish(player.playerId, createStructuredTemplate('heavy')).actor,
    old = room.world.actor(published.id), record = room.players.get(player.playerId);
  record.builtAt = -Infinity;
  const before = state(room.world), load = rejectNativeScene(t, room.world);
  assert.throws(() => room.command(player.playerId, { type: 'replace', actorId: old.id,
    blueprint: createStructuredTemplate('heavy') }), /indices|index|outside|material/i);
  unchanged(room.world, before);
  assert.equal(room.world.actor(old.id), old);
  assert.equal(record.selected, old.id); assert.equal(record.builtAt, -Infinity);
  assert.equal(room.owned(player.playerId).length, 1);
  load.mock.restore();
  room.command(player.playerId, { type: 'drive', actorId: old.id, throttle: 1 });
  room.world.step();
  const result = room.command(player.playerId, { type: 'replace', actorId: old.id,
    blueprint: createStructuredTemplate('heavy') });
  assert.equal(result.actor.id, old.id);
  assert.equal(room.world.actor(old.id).revision, old.revision + 1);
});

test('field snapshots rebuild owner lookups and preserve subsequent native admissions', nativePhotoOnly, t => {
  const room = rehearsal(), copy = rehearsal(), publication = new Publication();
  t.after(() => room.world.dispose()); t.after(() => copy.world.dispose());
  room.world.addActor(createStructuredTemplate('heavy'), { id: 'kept', x: 60 });
  for (let i = 0; i < 5; i++) room.world.step();
  publication.state(room.world.snapshot());
  const snapshot = writeField(room, publication);
  readField(copy, snapshot);
  const game = copy.world.game();
  for (const part of [...copy.world.plates, ...copy.world.modules]) {
    const handle = game.handle(part);
    assert.equal(handle, room.world.game().handle(part.id));
    assert.equal(game.handle(part.id), handle);
    assert.equal(game.objects.get(handle), part);
  }
  for (const field of [room.world, copy.world]) {
    field.replaceActor(createStructuredTemplate('heavy'), { id: 'kept' });
    field.addActor(createStructuredTemplate('heavy'), { id: 'new', x: 120 });
    field.step();
  }
  assert.equal(copy.digest(), room.digest(), 'restored allocation counters and lookups admit the same native scene');
  const part = copy.world.plates[0], handle = game.handle(part);
  game.objectHandles.delete(part);
  assert.throws(() => writeField(copy, publication), /não é a que o núcleo tem por ela/);
  game.objectHandles.set(part, handle);
});
