import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { scriptedDecision } from '../src/squad.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { mechanicalState, physicsState, finiteWorld, permanentParts, partsPreserved, resetRestored } from '../scripts/review-harness.ts';
import { dynamicsCases, dynamicsState, runDynamicsCase, compareDynamicsRows } from '../scripts/review-native-dynamics.ts';
import { duel } from './helpers/duel.js';

for (const item of dynamicsCases(120).filter(c => ['1-drive', '6-drive', '1-ap', '1-internal-blast', 'scout-controls-rough'].includes(c.name)))
  test(`compiled scenes repeat physical outcomes in ${item.name}`, async () => {
    const first = await runDynamicsCase(item), second = await runDynamicsCase(item), comparison = compareDynamicsRows(first, second);
    assert(first.finite && first.partsPreserved && first.recoveries === 0);
    if (item.exercise === 'internal-blast') assert(first.stats.explosions > 0 && first.stats.secondaryShots > 0);
    if (item.exercise === 'ap') assert(first.stats.impacts > 0);
    if (item.exercise === 'drive' || item.exercise === 'controls') assert(first.peaks.speedMps > .1);
    assert(comparison.pass, JSON.stringify(comparison));
  });

test('off-centre loads on the one carrier conserve mass, linear momentum and angular momentum', t => {
  const world = new World(createConstruction('scout')); t.after(() => world.dispose());
  world.command('setVehicleState', { state: { vx: 2.5, vy: -.75, omega: 11 } });
  const before = mechanicalState(world), point = { x: 10.23, y: 2.01 }, owner = world.modules.find(m => m.kind === 'wheel');
  world.command('impulse', { owner: world.game().handle(owner), point, impulse: { x: 40, y: -11 } });
  const after = mechanicalState(world);
  assert(Math.abs(after.mass - before.mass) < .002);
  assert(Math.abs(after.px - before.px - 40) < .02);
  assert(Math.abs(after.py - before.py + 11) < .02);
  assert(Math.abs(after.angular - before.angular - (point.x * -11 - point.y * 40)) < .02);
  assert.equal(physicsState(world).bodies, 1);
});

test('reset, actor replacement and dispose release the opaque native scene and retain initial reserves', t => {
  const world = new World(createConstruction('heavy'), { visualEvents: false }); t.after(() => world.dispose());
  const initial = permanentParts(world), count = () => {
    const p = physicsState(world); return [p.bodies, p.colliders];
  }, baseline = count(), reserves = () => world.modules.map(m => [m.id, m.rounds, m.fuelLitres]), initialReserves = reserves();
  for (let cycle = 0; cycle < 2; cycle++) {
    world.addActor(createConstruction('scout'), { id: 'replacement', ownerId: 'ally', x: 32 });
    assert(count()[0] > baseline[0]);
    world.removeActor('replacement'); assert(!world.actor('replacement'));
    assert([...world.game().objects.values()].every(part => part.actorId !== 'replacement'));
    assert.deepEqual(count(), baseline);
    world.explode(world.vehicle.x, world.vehicle.y + .3, 260, 2.5); world.step(); assert(world.stats.explosions > 0);
    const retired = world.dynamics.core;
    assert(resetRestored(world, initial)); assert.notEqual(world.dynamics.core, retired);
    assert.throws(() => retired.current_frame(), /freed|null pointer passed to rust/);
    assert.equal(world.tick, 0); assert.equal(world.time, 0);
    assert.deepEqual(count(), baseline); assert.deepEqual(reserves(), initialReserves);
    world.step(); assert(finiteWorld(world)); assert.equal(world.dynamics.recoveries, 0);
  }
  const retired = world.dynamics.core; world.dispose(); world.dispose();
  assert.equal(world.dynamics, null); assert.throws(() => retired.current_frame(), /freed|null pointer passed to rust/);
});

test('two standing rule pilots face to face give the same commands, sensor contacts and damaging shots when rendering is enabled', t => {
  const design = createConstruction('recon'), ids = ['local', 'opponent'], runs = [];
  for (const visualEvents of [false, true]) {
    const world = duel(t, design, { separation: 24, visualEvents }), initial = permanentParts(world), frames = [], contacts = [], actions = [];
    // Three seconds of the pilots' decisions, ten a second, each applied as the field applies one.
    for (let step = 0; step < 180; step++) {
      if (step % 6 === 0) {
        const decisions = ids.map(id => scriptedDecision(world, id, world.bounds));
        contacts.push(decisions.map(decision => decision.contact));
        for (const [i, decision] of decisions.entries())
          actions.push(applyWorldInput(world, ids[i], { ...decision, phase: 'decision' }, { platform: 'vehicle' }).record);
      }
      world.step(); world.drainEvents();
      if ((step + 1) % 6 === 0) frames.push({ step: step + 1, state: dynamicsState(world) });
      assert(finiteWorld(world));
    }
    assert(ids.every(id => world.actor(id).stats.shots > 0));
    assert(contacts.some(frame => frame.every(c => c?.detected && c.source === 'team' && c.channel === 'visual')));
    assert(world.stats.impacts > 0 && world.modules.some(m => m.health < m.maxHealth));
    assert(world.modules.some(m => m.kind === 'ammo' && m.rounds < m.capacityRounds));
    runs.push({ actions, contacts, stats: world.stats, row: { name: 'stationary-duel', steps: 180, actors: 2, exercise: 'duel',
      terrain: 'flat', finite: finiteWorld(world), partsPreserved: partsPreserved(world, initial),
      recoveries: world.dynamics.recoveries || 0, stats: world.stats, frames } });
  }
  assert(compareDynamicsRows(runs[0].row, runs[1].row).pass);
  for (const key of ['actions', 'contacts', 'stats']) assert.deepEqual(runs[1][key], runs[0][key]);
});
