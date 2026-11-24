import test from 'node:test';
import assert from 'node:assert/strict';
import { RustGame } from '../src/rust-game.ts';
import { PlateMesh } from '../src/mesh.ts';

const construction = (id, label = id) => ({ id, label, vehicle: { label, config: { enabled: true } } });
function projection(actors, ownerId) {
  const world = { actors, actor(id) {
    return this.actors.find(actor => actor.id === (id || 'local')) || (!id && this.actors[0]);
  } }, plate = new PlateMesh({ id: 'plate', actorId: ownerId, x: 0, y: 0, angle: 0,
    length: 2, thicknessMm: 20, material: 'steel' });
  plate.attached = true;
  plate.boundsUpdates = 0;
  const updateBounds = plate.updateBounds.bind(plate);
  plate.updateBounds = () => { plate.boundsUpdates++; updateBounds(); };
  // A projection with nothing but its scene and its pieces; what it reads with is RustGame's own.
  return { world, plate, game: Object.assign(Object.create(RustGame.prototype), { world, objects: new Map([[7, plate]]) }) };
}
// ActorFrame publishes a complete record; only its empty `also` list is omitted.
const read = (scene, id, cooldown = .5) => RustGame.prototype.parts.call(scene.game,
  { actors: [{ id, cooldown, aim: { x: 20, y: 1.5 }, weapon: null, lastWeapon: '', trigger: null,
    pendingShot: null, stats: { shots: 0 }, eyes: [], vehicle: null }],
  plates: [{ owner: 7, pose: { x: 12, y: 3, angle: .25 }, damage: null }], modules: [] }, false);

test('a native frame updates the first actor with an id and keeps its plate on that vehicle', () => {
  const first = construction('tank', 'first'), duplicate = construction('tank', 'second'),
    scene = projection([first, duplicate], 'tank');
  read(scene, 'tank');
  assert.equal(first.cooldown, .5); assert.equal(duplicate.cooldown, undefined);
  assert.equal(scene.plate.carrier, first.vehicle);
  const { x, y, angle } = scene.plate.definition;
  assert.deepEqual({ x, y, angle }, { x: 12, y: 3, angle: .25 });
  assert.equal(scene.plate.boundsUpdates, 1);
});

test('unnamed actor frames and carriers prefer local, or the first construction when local is absent', () => {
  for (const id of [undefined, null, '']) {
    const first = construction('other'), local = construction('local'),
      withLocal = projection([first, local], id);
    read(withLocal, id);
    assert.equal(local.cooldown, .5); assert.equal(first.cooldown, undefined);
    assert.equal(withLocal.plate.carrier, local.vehicle);

    const fallback = construction('other'), withoutLocal = projection([fallback, construction('last')], id);
    read(withoutLocal, id);
    assert.equal(fallback.cooldown, .5);
    assert.equal(withoutLocal.plate.carrier, fallback.vehicle);
  }
});

test('a replaced scene supplies the current carrier, and a departed owner leaves no stale vehicle link', () => {
  const original = construction('tank', 'original'), scene = projection([original], 'tank');
  read(scene, 'tank'); assert.equal(scene.plate.carrier, original.vehicle);

  const replacement = construction('tank', 'replacement'); scene.world.actors = [replacement];
  read(scene, 'tank', .75);
  assert.equal(scene.plate.carrier, replacement.vehicle); assert.equal(replacement.cooldown, .75);
  assert.equal(original.cooldown, .5);

  scene.world.actors = []; scene.plate.attached = false;
  read(scene, 'tank');
  assert.equal(scene.plate.carrier, null); assert.equal(scene.plate.attached, false);
  assert.equal(original.cooldown, .5); assert.equal(replacement.cooldown, .75);
});
