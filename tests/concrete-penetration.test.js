import test from 'node:test';
import assert from 'node:assert/strict';
import { World, FIXED_DT } from '../src/physics.ts';
import { MATERIALS } from '../src/materials.ts';
import { barrierSource as barrierMetres, firingLine, fireRh120, rh120 } from './concrete-penetration-fixtures.js';
import { pointCells } from '../src/grid.ts';
import { writtenParts } from './helpers/designs.js';

// The barrier is laid out in metres; a design writes its nodes and the poses of its parts on the nearest cells. Every
// node falls on one; the magazine and the computer stand 1.75 cm lower.
const barrierSource = options => {
  const source = barrierMetres(options);
  return { ...source, nodes: source.nodes.map(node => ({ ...node, ...pointCells(node) })), components: writtenParts(source.components) };
};

const name = part => part.id.split(':').at(-1),
  internalRays = events => events.filter(event => event.type === 'secondary-ray' && event.internal),
  primaryContacts = events => events.filter(event => !event.fragment && ['penetration', 'blocked', 'ricochet'].includes(event.type)),
  // JSON persistence has one representation of zero; compare marks and grids
  // as written rather than treating a visual UV of -0 as different material.
  plateState = world => JSON.parse(JSON.stringify(world.plates.map(plate => ({ id: name(plate), ballisticGrid: plate.ballisticGrid,
    revision: plate.revision, marks: plate.marks, dents: [...(plate.dents?.values() || [])], perforations: plate.perforations })))),
  damageState = world => ({ plates: plateState(world), modules: world.modules.map(module => ({ id: name(module),
    health: module.health, rounds: module.rounds, detonated: module.detonated })), stats: structuredClone(world.stats) });

function managed(t, source, qualified = false) {
  const world = new World(source);
  t.after(() => world.dispose());
  if (qualified) {
    world.removeActor('local');
    world.addActor(source, { id: 'local', ownerId: 'local', x: 12, facing: -1 });
  }
  return world;
}

for (const [material, thickness] of [['concrete', 1000], ['steel', 144]])
  test(`a real RH120 first shot is stopped by five occupied ${thickness} mm ${material} walls before the magazine`, t => {
    const world = managed(t, barrierSource({ material, thickness })), line = firingLine(world),
      walls = line.layers.filter(hit => /^block\d$/.test(name(hit.owner))),
      magazine = world.modules.find(module => module.kind === 'ammo'),
      before = { health: magazine.health, rounds: magazine.rounds };
    assert.equal(walls.length, 5);
    assert.equal(line.config.preset, 'rh120');
    assert.equal(line.config.ammo, 'apfsds');
    assert.equal(line.muzzle.x, 4.25);
    assert(line.layers[0].point.x > line.muzzle.x + 1, 'the actual muzzle is entirely before the first face');
    for (const wall of walls) {
      assert.equal(wall.owner.material.id, material);
      assert(Math.abs(wall.depth - thickness / 1000) < 1e-8, 'each wall pays its complete occupied chord');
    }
    const totalResistance = walls.reduce((sum, hit) => sum + hit.depth * 1000 * MATERIALS[material].resistance, 0);
    assert(totalResistance > line.config.power * 1.25, 'the target is several real walls, more than the round pierces, not a hollow silhouette');
    const { fired, events } = fireRh120(world);
    assert(fired);
    assert.equal(world.stats.shots, 1);
    assert(primaryContacts(events).some(event => event.type === 'blocked' && /^block\d$/.test(name(event))),
      'the primary must stop at the remaining concrete or steel');
    assert(!primaryContacts(events).some(event => name(event) === 'ammo'));
    assert.equal(magazine.health, before.health);
    assert.equal(magazine.rounds, before.rounds);
    assert.equal(magazine.detonated, false);
    assert.equal(world.stats.explosions, 0);
    assert(internalRays(events).length > 0, 'perforations still emit internal fragments');
    for (const ray of internalRays(events)) {
      assert(ray.energySpent >= 0 && ray.energySpent <= ray.energyBudget + 1e-7);
      assert(Number.isFinite(ray.endX) && Number.isFinite(ray.endY));
    }
  });

test('perforation spall preserves separate penetration and deposited-energy budgets through successive walls', t => {
  const world = managed(t, barrierSource({ ammo: false })), { config, events } = fireRh120(world),
    contacts = primaryContacts(events), rays = internalRays(events),
    initialEnergy = .5 * config.mass * config.speed ** 2;
  assert(contacts.some(event => event.type === 'blocked'));
  assert(rays.length >= 3);
  let exportedPower = 0, exportedEnergy = 0;
  for (const ray of rays) {
    assert(Number.isFinite(ray.powerBudget) && ray.powerBudget > 0);
    assert(Number.isFinite(ray.powerSpent) && ray.powerSpent >= 0 && ray.powerSpent <= ray.powerBudget + 1e-9);
    assert(ray.energySpent >= 0 && ray.energySpent <= ray.energyBudget + 1e-7);
    assert(Math.abs(ray.energySpent / ray.energyBudget - ray.powerSpent / ray.powerBudget) < 1e-8,
      'straight material contacts consume the inherited energy and penetration in the same proportion');
    exportedPower += ray.powerBudget;
    exportedEnergy += ray.energyBudget;
  }
  for (const contact of contacts) {
    assert(Number.isFinite(contact.energyDeposited) && contact.energyDeposited >= 0);
    assert(contact.powerSpent >= 0 && contact.powerSpent <= contact.power + 1e-8);
    const ownRays = rays.filter(ray => ray.source === contact.id),
      thrownEnergy = ownRays.reduce((sum, ray) => sum + ray.energyBudget, 0),
      thrownPower = ownRays.reduce((sum, ray) => sum + ray.powerBudget, 0),
      consumedEnergy = contact.energy * contact.powerSpent / contact.power;
    assert(thrownPower <= contact.powerSpent * .08 + 1e-8,
      'a source contact cannot turn its lost energy into additional armour penetration');
    assert(Math.abs(contact.energyDeposited + thrownEnergy - consumedEnergy) < 1e-6,
      'energy released as fragments is excluded from energy deposited in the source wall');
  }
  const spentPower = contacts.reduce((sum, contact) => sum + contact.powerSpent, 0),
    depositedEnergy = contacts.reduce((sum, contact) => sum + contact.energyDeposited, 0);
  assert(exportedPower <= spentPower * .08 + 1e-8);
  assert(depositedEnergy + exportedEnergy <= initialEnergy + 1e-6);
  assert(depositedEnergy + exportedEnergy > initialEnergy * .99,
    'the short flight loses a small amount to air; its energy is otherwise accounted for');
});

test('a repeated attack preserves real holes through a cold resume and reset restores the original wall', t => {
  const source = barrierSource(), world = managed(t, source, true), first = fireRh120(world);
  assert(first.fired);
  const firstDamage = damageState(world), kept = JSON.parse(JSON.stringify(world.keep()));
  for (const plate of kept.plates) {
    plate.wear = { metal: [{ bin: 0, positive: true, hits: 479, stage: 3 }],
      brittle: [{ bin: 0, face: -1, energy: 159, cut: false }] };
    plate.wearCount = 2;
  }
  assert(world.plates.some(plate => plate.remainingArea < plate.originalArea));
  assert.equal(world.projectiles.length, 0);
  const restored = managed(t, source, true);
  restored.removeActor('local');
  restored.resume(structuredClone(kept));
  assert.deepEqual(damageState(restored), firstDamage, 'cold admission preserves existing material damage');
  assert(restored.keep().plates.every(plate => !Object.hasOwn(plate, 'wear') && !Object.hasOwn(plate, 'wearCount')),
    'current saves discard retired histories while retaining their real cuts');
  assert.equal(restored.cooldown, world.cooldown, 'the bench reload is retained');
  const beforeRejected = damageState(restored), line = firingLine(restored);
  assert.equal(restored.fire(line.aim, line.config, false), false, 'reloading does not allow another unforced shot');
  assert.deepEqual(damageState(restored), beforeRejected);
  for (let repeat = 0; repeat < 2; repeat++) {
    assert(fireRh120(world).fired);
    assert(fireRh120(restored).fired);
    assert.deepEqual(damageState(restored), damageState(world), `the same subsequent shot sees the same holes: ${repeat + 2}`);
  }
  world.reset();
  const fresh = managed(t, source);
  assert.deepEqual(damageState(world), damageState(fresh), 'reset restores intact material and full reserves');
  assert.equal(world.cooldown, 0);
  fireRh120(world);
  fireRh120(fresh);
  assert.deepEqual(damageState(world), damageState(fresh), 'the first shot after reset repeats the fresh result');
});

test('waiting for the real RH120 reload keeps existing damage and the next shot uses it', t => {
  const world = managed(t, barrierSource()), first = fireRh120(world, { force: false });
  assert(first.fired);
  const before = plateState(world), waiting = Math.ceil(world.cooldown / FIXED_DT) + 1;
  assert(waiting > 500, 'the catalogue reload, not a forced shot, is exercised');
  for (let i = 0; i < waiting; i++) world.step(FIXED_DT, { quiet: true });
  world.sync();
  world.drainEvents();
  assert.deepEqual(plateState(world), before, 'reload time neither heals nor further erodes the wall');
  assert(fireRh120(world, { force: false }).fired);
  assert.equal(world.stats.shots, 2);
});

test('thin-wall spall can injure an exposed off-axis mechanism while a real armour screen intercepts it', t => {
  const thin = { material: 'steel', thickness: 5 },
    uncovered = managed(t, barrierSource({ ammo: false, command: true, partitions: [thin] })),
    covered = managed(t, barrierSource({ ammo: false, command: true,
      partitions: [thin, { material: 'concrete', thickness: 1000 }] })),
    command = world => world.modules.find(module => module.kind === 'command');
  for (const world of [uncovered, covered]) {
    const target = command(world), line = firingLine(world);
    assert(line.muzzle.y < target.y - target.height / 2, 'the primary passes below the target');
  }
  const bare = fireRh120(uncovered), screened = fireRh120(covered),
    secondaryHit = events => events.find(event => event.type === 'secondary-impact' && name(event) === 'command' && event.damage > 0);
  assert(bare.fired && screened.fired);
  assert(secondaryHit(bare.events), 'a real secondary contact still damages the directly exposed mechanism');
  const contact = secondaryHit(bare.events);
  assert(contact.energyDeposited > 0 && contact.energyDeposited <= contact.energy + 1e-8,
    'the mechanism receives the energy actually deposited at its own contact');
  assert(contact.powerSpent >= 0 && contact.powerSpent <= contact.power + 1e-8);
  assert(command(uncovered).health < command(uncovered).maxHealth);
  assert.equal(command(covered).health, command(covered).maxHealth, 'the intervening screen retains protection');
  assert.equal(secondaryHit(screened.events), undefined);
  assert(internalRays(bare.events).length > 0 && internalRays(screened.events).length > 0);
  assert.equal(rh120().power, 689, 'the regression uses the unchanged catalogue round');
});
