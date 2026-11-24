import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CONSTRUCTION_TEMPLATES, FIXTURE_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { emptyBlueprint, health, frames } from './helpers/perception-scene.js';

// A camera does not see through the armour of its own construction. On the core itself, every model the garage
// offers and every structure of the lab sees a copy of itself standing on its own ground, before it and behind it:
// near, far, and at the edge of what a camera reaches. Its camera on the roof gone, a vehicle only sees nearby ahead
// with its Command through a real glass visor, and nothing behind. The guard post, bunker and fortified outpost
// also admit that shorter-range Command sight through the real clearance around their gun mounts.
const DISTANCES = [50, 300, 3990], GUN_PORT_SIGHT = new Set(['guard-post', 'bunker', 'outpost']);
const groundTemplates = CONSTRUCTION_TEMPLATES.filter(template => createStructuredTemplate(template.id).chassis?.model !== 'aircraft');
const aircraftTemplates = CONSTRUCTION_TEMPLATES.filter(template => createStructuredTemplate(template.id).chassis?.model === 'aircraft');
function meeting(t, design, distance) {
  const world = new World(emptyBlueprint(), { visualEvents: false }); t.after(() => world.dispose());
  world.removeActor('local');
  world.addActor(design, { id: 'own', ownerId: 'blue', x: 0, facing: 1 });
  world.addActor(design, { id: 'ahead', ownerId: 'red', x: distance, facing: -1 });
  world.addActor(design, { id: 'behind', ownerId: 'red', x: -distance, facing: 1 });
  world.game(); frames(world, 30);
  return world;
}
// Whom the cameras of the blue team hold in view now.
const seen = world => world.game().call({ op: 'teamSight', ghosts: [] }).sight.blue?.filter(held => held.channel === 'visual' && held.visible)
    .map(held => held.actorId).sort() ?? [],
  cameras = world => world.modules.filter(m => m.actorId === 'own' && m.kind === 'sensor' && m.sensorMode === 'visual'),
  eyes = world => world.snapshot().actors.find(a => a.id === 'own').eyes,
  // The eye an optic is, where it stands, by how far it reaches to the left and to the right.
  eyeOf = (world, optic) => eyes(world).filter(eye => Math.hypot(eye.x - optic.x, eye.y - optic.y) < 1e-6).map(eye => [eye.left, eye.right]),
  // A command post only looks ahead at its own 650 m range through its real visor or an open gun port.
  postOnly = (world, optics) => eyes(world).filter(eye => !optics.some(optic => Math.hypot(eye.x - optic.x, eye.y - optic.y) < 1e-6))
    .every(eye => eye.left === 0 && eye.right === 650);

for (const { id, name, type } of [...groundTemplates, ...FIXTURE_TEMPLATES].filter(template => template.id !== 'empty'))
  test(`${id} (${name}) sees both sides with its roof camera, then only nearby ahead through a real Command opening`, t => {
    const design = createStructuredTemplate(id), commandSight = type === 'vehicle' || GUN_PORT_SIGHT.has(id);
    for (const distance of DISTANCES) {
      const world = meeting(t, design, distance), optics = cameras(world), roof = optics[0],
        post = world.modules.find(module => module.actorId === 'own' && module.kind === 'command');
      assert.deepEqual(seen(world), ['ahead', 'behind'], `at ${distance} m`);
      assert.equal(optics.length, 1, 'only one roof optic; no duplicate internal 4 km camera');
      assert.deepEqual(eyeOf(world, roof), [[4000, 4000]]);
      assert(postOnly(world, optics), 'a command post only looks ahead through its vision block or gun port');
      // Fixed gun-port sight keeps its original near-field assay; the dedicated cases below check its real openings.
      if (type !== 'vehicle' && distance !== 50) continue;
      health(world, roof, 0); frames(world, 1);
      assert.deepEqual(seen(world), commandSight && distance < 650 ? ['ahead'] : [], `at ${distance} m with no roof camera`);
      if (commandSight) {
        assert.deepEqual(eyeOf(world, post), [[0, 650]], 'only the basic Command sight remains ahead');
        health(world, post, 0); frames(world, 1);
        assert.deepEqual(seen(world), [], 'with both the roof camera and command post gone');
      }
      assert.deepEqual(eyes(world), []);
    }
  });

test('aircraft see both horizons with the camera below the deck and lose distant contacts when it is destroyed', t => {
  for (const { id } of aircraftTemplates) {
    const world = meeting(t, createStructuredTemplate(id), 1000), [optic] = cameras(world);
    assert.deepEqual(seen(world), ['ahead', 'behind'], id);
    assert.equal(cameras(world).length, 1, id);
    assert(optic.y < world.actor('own').vehicle.y, id + ': the optical head is below the deck');
    health(world, optic, 0); frames(world, 1);
    assert.deepEqual(seen(world), [], id + ': Command has no duplicate long-range optic');
  }
});

test('a structure without its roof camera only sees through its gun port within the command camera range', t => {
  for (const id of GUN_PORT_SIGHT) for (const distance of id === 'guard-post' ? [50, 300, 700] : [50, 700]) {
    const world = meeting(t, createStructuredTemplate(id), distance), roof = cameras(world)[0];
    health(world, roof, 0); frames(world, 1);
    assert.deepEqual(seen(world), distance < 650 ? ['ahead'] : [], `${id} at ${distance} m without the roof camera`);
    const post = world.modules.find(module => module.actorId === 'own' && module.kind === 'command');
    assert.deepEqual(eyeOf(world, post), [[0, 650]]);
  }
});

test('the burst of a 40 mm grenade that puts out the roof camera leaves the protected Command sight ahead', t => {
  const { power, blastRadius } = WEAPON_PRESETS.mk19;
  // The howitzer's comes with its tower.
  for (const { id } of groundTemplates.filter(template => template.type === 'vehicle' && template.id !== 'howitzer')) {
    const world = meeting(t, createStructuredTemplate(id), 300), roof = cameras(world)[0],
      post = world.modules.find(m => m.actorId === 'own' && m.kind === 'command');
    assert(post, id);
    world.explode(roof.x, roof.y + roof.height / 2 + .02, power, blastRadius); frames(world, 10);
    const left = optic => world.modules.find(m => m.id === optic.id).health;
    assert.deepEqual([left(roof), left(post) > 0], [0, true], id);
    assert.deepEqual(seen(world), ['ahead'], id);
    assert.deepEqual(eyeOf(world, post), [[0, 650]], id);
  }
});
