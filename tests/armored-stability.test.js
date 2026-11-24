import test from 'node:test';
import assert from 'node:assert/strict';
import { currentStabilityEncounter, assertCurrentStability } from './helpers/current-stability.js';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { releaseWorldInputs } from '../src/episode-input.ts';
import { duel } from './helpers/duel.js';
import { SHAPED_GEAR } from './helpers/shaped-gear.js';

const cases = [
  ['ifv-mud-200005-team', 'ifv', 12, 3],
  ['heavy-sand-11194', 'heavy', 15, 3],
  ...['heavy-mixed-930042', 'heavy-flat-930202', 'heavy-hills-930132', 'heavy-sand-930222']
    .map(name => [name, 'heavy', 20, 3]),
  ...['heavy-hills-930032', 'heavy-hills-930132-forward'].map(name => [name, 'heavy', 15, 2.5]),
];
for (const [name, template, speed, clearance] of cases)
  test(`${name}: current mounted impacts retain the mass of the structure and the physical stability limits`, t => {
    const row = currentStabilityEncounter(name, { template });
    t.diagnostic(JSON.stringify({ name, shots: row.stats.shots, impacts: row.stats.impacts, explosions: row.stats.explosions,
      functionalHealthLost: row.functionalHealthLost, materialDamage: row.materialDamage, peaks: row.peaks,
      damagedComponents: row.componentDamage.filter(part => part.loss > 0 || part.barrelDisabled) }));
    assertCurrentStability(row, { speed, clearance });
  });

// Two of those battles with the leaders on a track the player placed: cut to the four road wheels under its middle,
// the fewest that carry it, and of five to the rear. The same limits hold.
for (const [name, gear, speed, clearance] of [['heavy-sand-11194', 'heavy on the shortest track', 15, 3],
  ['heavy-hills-930132', 'heavy on a short track to the rear', 20, 3]])
  test(`${name}, ${gear}: mounted impacts retain the mass of the structure and the physical stability limits`, t => {
    const shape = SHAPED_GEAR.find(([named]) => named === gear)[2], row = currentStabilityEncounter(name, { template: 'heavy', shape });
    t.diagnostic(JSON.stringify({ name, gear, shots: row.stats.shots, impacts: row.stats.impacts, peaks: row.peaks }));
    assertCurrentStability(row, { speed, clearance });
  });

test('the stability damage gate accepts weapon health loss without a hull hole and rejects empty contacts', () => {
  const limits = { speed: 1, clearance: 1 }, row = {
    invalid: null, recoveries: 0, diagnostics: [], energyAudit: { invalid: 0 },
    stats: { shots: 1, impacts: 1 }, peaks: { speed: 0, clearance: 0 },
    functionalHealthLost: 1,
    materialDamage: { voidAreaM2: 0, regrowthAreaM2: 0,
      carriersBefore: [{ mass: 1000, inertia: 2000, reserves: 100, modules: 200 }], carriersAfter: [{ mass: 1000, inertia: 2000, reserves: 100, modules: 200 }] },
    componentDamage: [{ kind: 'weapon', initialHealth: 100, remainingHealth: 99, loss: 1,
      disabled: false, barrelDisabled: false }],
  };
  assert.doesNotThrow(() => assertCurrentStability(row, limits), 'receiver/mantlet damage does not require a plate hole');
  const barrel = structuredClone(row); barrel.componentDamage[0].barrelDisabled = true;
  assert.doesNotThrow(() => assertCurrentStability(barrel, limits), 'tube damage is real component damage');
  const hull = structuredClone(row); hull.materialDamage.voidAreaM2 = 0.001;
  hull.componentDamage[0].kind = 'engine';
  assert.doesNotThrow(() => assertCurrentStability(hull, limits), 'plate perforation retains its causal damage gate');
  const intact = structuredClone(barrel); intact.functionalHealthLost = 0;
  Object.assign(intact.componentDamage[0], { remainingHealth: 100, loss: 0 });
  assert.throws(() => assertCurrentStability(intact, limits), /real clamped component damage/,
    'impact counts and a disabled flag alone do not prove health loss');
  const unrelated = structuredClone(row); unrelated.componentDamage[0].kind = 'engine';
  assert.throws(() => assertCurrentStability(unrelated, limits), /remove plate material or reduce real weapon health/);
  const inconsistent = structuredClone(row); inconsistent.componentDamage[0].loss = 2;
  assert.throws(() => assertCurrentStability(inconsistent, limits), /Expected values to be strictly equal/);
  const falseTotal = structuredClone(row); falseTotal.functionalHealthLost = 2;
  assert.throws(() => assertCurrentStability(falseTotal, limits), /equals the measured clamped health losses/);
  const healed = structuredClone(row); healed.materialDamage.regrowthAreaM2 = 1e-5;
  assert.throws(() => assertCurrentStability(healed, limits), /ballistic holes never heal/);
  const changingMass = structuredClone(row); changingMass.materialDamage.carriersAfter[0].mass = 999;
  assert.throws(() => assertCurrentStability(changingMass, limits), /never changes the mass of the structure/);
  // A round fired is no longer carried: the body weighs that much less, by its reserves alone.
  const spent = structuredClone(row); Object.assign(spent.materialDamage.carriersAfter[0], { mass: 973, reserves: 73, modules: 173, inertia: 1990 });
  assert.doesNotThrow(() => assertCurrentStability(spent, limits));
  const burnt = structuredClone(row); Object.assign(burnt.materialDamage.carriersAfter[0], { mass: 995, modules: 195, inertia: 1990 });
  assert.doesNotThrow(() => assertCurrentStability(burnt, limits), 'measured combustible loss stays separate from permanent structure');
  const gained = structuredClone(row); Object.assign(gained.materialDamage.carriersAfter[0], { mass: 1010, reserves: 110, modules: 210 });
  assert.throws(() => assertCurrentStability(gained, limits), /never adds mass or inertia/);
});

test('an IFV that loses its command and is let go with its brakes on keeps its incoming momentum and brakes below 1 m/s after one second', t => {
  const world = duel(t, createStructuredTemplate('ifv'), { seed: 200005, terrain: 'mud', separation: 76, visualEvents: false }),
    game = world.game(), actor = world.actor('local'), command = world.modules.find(m => m.kind === 'command' && m.actorId === 'local');
  game.call({ op: 'setVehicleState', actorId: 'local', state: { vx: 3 } });
  const before = Math.hypot(actor.vehicle.vx, actor.vehicle.vy), initialMass = actor.vehicle.mass;
  game.call({ op: 'setPartState', owner: game.handle(command), state: { health: 0 } }); releaseWorldInputs(world, ['local'], 1);
  let peak = 0;
  for (let frame = 0; frame < 90; frame++) {
    world.step(); peak = Math.max(peak, Math.hypot(actor.vehicle.vx, actor.vehicle.vy));
    if (frame >= 59) assert(Math.hypot(actor.vehicle.vx, actor.vehicle.vy) < 1);
  }
  assert(peak <= before, JSON.stringify({ peak, before }));
  assert.equal(actor.vehicle.mass, initialMass);
  assert.equal(game.call({ op: 'physics' }).recoveries, 0);
});
