import test from 'node:test';
import assert from 'node:assert/strict';
import { weaponOf } from '../src/weapons.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { World } from '../src/physics.ts';
import { standing } from './helpers/designs.js';

// The scout with its Minimi made over to a belt of twenty, fed from the box of the Minimi's rounds it has, made as a field
// that is kept is: an empty one, the construction brought into it.
function scout(t) {
  const preset = 'minimi|M20', source = standing(structuredTemplateSource('scout', { preset: 'minimi' }));
  source.components.find(part => part.kind === 'weapon').weaponPreset = preset;
  const world = new World(createConstruction('empty')); t.after(() => world.dispose()); world.removeActor('local');
  world.addActor(source, { id: 'c1', x: 12 }); world.game();
  return { world, preset };
}
const aboard = world => world.modules.filter(m => m.kind === 'ammo' && m.ammoPreset === 'minimi').reduce((sum, m) => sum + m.rounds, 0);

test('a belt fired out is changed before the gun fires again, and the frames tell it of the gun', t => {
  const { world, preset } = scout(t), feed = weaponOf(preset).feed, gun = world.modules.find(m => m.kind === 'weapon');
  assert.equal(feed.kind, 'belt');
  assert(aboard(world) > feed.rounds, `${aboard(world)} rounds aboard`);
  assert.equal(gun.loaded, feed.rounds, 'it comes in loaded');
  assert.equal(gun.feedReload, 0);
  const config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, preset, aimAngle: gun.barrelAngle }, 'c1'),
    aim = { x: gun.x + 30 * Math.cos(gun.barrelAngle), y: gun.y + 30 * Math.sin(gun.barrelAngle) };
  world.setTrigger(true, aim, config, 'c1');
  for (let i = 0; i < 600 && gun.loaded > 0; i++) world.step();
  assert.equal(world.stats.shots, feed.rounds, 'its belt, and not a round past it');
  assert(gun.feedReload > feed.reloadS - .1 && gun.feedReload <= feed.reloadS, `${gun.feedReload} s of ${feed.reloadS}`);
  for (let i = 0; i < 60; i++) world.step();
  assert.equal(world.stats.shots, feed.rounds, 'none while its belt is changed');
  assert(Math.abs(gun.feedReload - (feed.reloadS - 1)) < .1, `${gun.feedReload} s`);
  for (let i = 0; i < Math.ceil(feed.reloadS * 60); i++) world.step();
  assert(world.stats.shots > feed.rounds, 'its belt changed, it fires again');
  assert(gun.loaded < feed.rounds && gun.loaded <= aboard(world));
});

test('a field kept keeps nothing of how far a crew got loading a gun: resumed, its guns are loaded from their boxes', t => {
  const { world, preset } = scout(t), feed = weaponOf(preset).feed, gun = world.modules.find(m => m.kind === 'weapon');
  const config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, preset, aimAngle: gun.barrelAngle }, 'c1'),
    aim = { x: gun.x + 30 * Math.cos(gun.barrelAngle), y: gun.y + 30 * Math.sin(gun.barrelAngle) };
  world.setTrigger(true, aim, config, 'c1');
  for (let i = 0; i < 600 && gun.loaded > 0; i++) world.step();
  world.setTrigger(false, undefined, undefined, 'c1');
  assert(gun.loaded === 0 && gun.feedReload > 0);
  const kept = JSON.parse(JSON.stringify(world.keep())), saved = kept.modules.find(m => m.id === gun.id);
  assert(!('loaded' in saved) && !('feedReload' in saved), Object.keys(saved).join());
  const fresh = new World(createConstruction('empty')); t.after(() => fresh.dispose()); fresh.removeActor('local');
  fresh.resume(structuredClone(kept)); fresh.game();
  const again = fresh.modules.find(m => m.id === gun.id);
  assert.equal(aboard(fresh), aboard(world));
  assert.deepEqual([again.loaded, again.feedReload], [Math.min(feed.rounds, aboard(fresh)), 0]);
});
