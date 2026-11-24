import assert from 'node:assert/strict';
import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { validateStructuredConstruction } from '../../src/structured-construction.ts';
import { firingSolution } from '../../src/ballistics.ts';
import { applyWorldInput, releaseWorldInputs } from '../../src/episode-input.ts';
import { NativeAudit, physicsState, actorPhysics, reservesMass, installedModuleMass, plateMaterialState } from '../../scripts/review-harness.ts';
import { duel } from './duel.js';

// The encounters of the stability tests, each named after the archived battle it keeps: its seed, its ground, whether
// 'local' stands on the right, the gun of the construction that leads each side and, for one, the two that follow
// each leader (a template and its gun) and the gap between them. The leaders stand 36 m apart.
const ENCOUNTERS = {
  'ifv-mud-200005-team': { seed: 200005, terrain: 'mud', swapSides: true, preset: 'mk19', formationGap: 10.127311691525392,
    allies: [['scout', 'm119'], ['ifv', 'm2hb']], enemies: [['scout', 'm119'], ['ifv', 'm2hb']] },
  'heavy-sand-11194': { seed: 11194, terrain: 'sand', swapSides: false, preset: 'm242' },
  'heavy-mixed-930042': { seed: 930042, terrain: 'mixed', swapSides: true, preset: 'rh120' },
  'heavy-flat-930202': { seed: 930202, terrain: 'flat', swapSides: false, preset: 'rh120' },
  'heavy-hills-930132': { seed: 930132, terrain: 'hills', swapSides: true, preset: 'rh120' },
  'heavy-hills-930132-forward': { seed: 930132, terrain: 'hills', swapSides: false, preset: 'rh120' },
  'heavy-sand-930222': { seed: 930222, terrain: 'sand', swapSides: true, preset: 'rh120' },
  'heavy-hills-930032': { seed: 930032, terrain: 'hills', swapSides: false, preset: 'rh120' },
  'ifv-rough-900015': { seed: 900015, terrain: 'rough', swapSides: true, preset: 'rh202' },
  'balanced-mud-900003': { seed: 900003, terrain: 'mud', swapSides: false, preset: 'rh202' },
};

// A side's others stand behind its leader, one after another, `gap` metres from the rear of the one before to their
// front: each is first put well behind to be measured, then where it belongs.
function lineUp(world, leaderId, members = [], gap = 7) {
  const facing = world.actor(leaderId).facing, ids = [leaderId];
  for (const [i, [template, preset]] of members.entries()) {
    const id = `${leaderId}-${i + 1}`, design = createStructuredTemplate(template, { preset }),
      ahead = world.actorBounds(ids.at(-1)), rear = facing > 0 ? ahead.minX : ahead.maxX, x = rear - facing * 60;
    world.addActor(design, { id, ownerId: leaderId, x, facing });
    const box = world.actorBounds(id), front = facing > 0 ? box.maxX : box.minX;
    world.removeActor(id);
    world.addActor(design, { id, ownerId: leaderId, x: x + rear - facing * gap - front, facing });
    ids.push(id);
  }
  return ids;
}

// A construction is out of action once its command is lost, or every gun it could fire.
const outOfAction = (world, id) => {
  const parts = world.modules.filter(m => m.actorId === id);
  return !parts.some(m => m.kind === 'command' && m.health > 0) ||
    !parts.some(m => m.kind === 'weapon' && m.health > 0 && m.attached !== false && !m.barrelDisabled);
};

// What the encounter has a construction do, ten times a second: lay its first working gun on the gun of the first
// enemy still in action, braked where it stands, and fire high explosive once the servo has laid it. This is the
// fixture's control only, never a rule of a pilot: a ten-second reload fired at the spawn bearing would test a miss.
function laying(world, id, enemy, fire) {
  const gun = world.modules.find(m => m.actorId === id && m.kind === 'weapon' && m.health > 0),
    target = world.modules.find(m => m.actorId === enemy && m.kind === 'weapon');
  if (!gun || !target) return null;
  const aim = { x: target.x, y: target.y },
    settings = world.playerWeapon({ platform: 'vehicle', componentId: gun.id, ammo: 'he', trajectory: 'low', charge: 1, spread: 0 }, id),
    solution = firingSolution(gun, aim, settings),
    angleError = Math.atan2(Math.sin(solution.angle - gun.barrelAngle), Math.cos(solution.angle - gun.barrelAngle)),
    laid = fire && Math.abs(angleError) <= Math.atan2(settings.radius, Math.hypot(aim.x - gun.x, aim.y - gun.y)) / 2;
  return { type: 'controls', componentId: gun.id, throttle: 0, brake: 1, aim, aimAngle: solution.angle,
    ammo: settings.ammo, trajectory: settings.trajectory, charge: 1, detonation: 'impact', fire: laid, shot: laid, queue: laid };
}

function carrierProperties(world) {
  const state = physicsState(world);
  return world.actors.map(actor => {
    const body = actorPhysics(world, actor.id, state);
    return { actorId: actor.id, body: body?.handle, mass: body?.mass, inertia: body?.inertia,
      reserves: reservesMass(world, actor.id), modules: installedModuleMass(world, actor.id) };
  });
}

// Plays an encounter for `frames` steps under the core's energy audit, once the constructions have come to rest, and
// measures what the stability gate reads: the peaks of motion and of plate deformation, those after the first shot or
// blast, the energy the solver could not explain, its recoveries, and the material and health the hits took. A
// construction out of action is let go with its brakes on, and so is everyone once a side is; the steps go on to the
// end. `fire` false lays the same guns and never fires them. `shape`, when given, puts the running gear of the leaders
// where it says (a chassis to the chassis it is shaped into).
export function currentStabilityEncounter(name, { template = 'heavy', frames = 180, fire = true, shape = null } = {}) {
  const { seed, terrain, swapSides, preset, formationGap, allies, enemies } = ENCOUNTERS[name],
    made = createStructuredTemplate(template, { preset }),
    design = shape ? validateStructuredConstruction({ ...made, chassis: shape(made.chassis) }) : made,
    world = duel(null, design, { opponent: structuredClone(design), terrain, seed, swapSides, visualEvents: false });
  const diagnostics = [], peaks = { speed: 0, clearance: 0, localDentMeters: 0, dentLimitRatio: 0 },
    loadedPeaks = { speed: 0, clearance: 0 }, energyAudit = { solves: 0, invalid: 0, maxGrowthJ: 0, maxGravityWorkJ: 0,
      maxConstraintEnergyJ: 0, maxUnexplainedGrowthJ: 0 };
  let audit, invalid = null, firstLoad = null, firedCommands = 0;
  try {
    const sides = [lineUp(world, 'local', allies, formationGap), lineUp(world, 'opponent', enemies, formationGap)], ids = sides.flat();
    // The constructions come to rest for a second before anything is measured, as the archived battles did.
    for (let i = 0; i < 60; i++) world.step();
    const initialHealth = new Map(world.modules.map(m => [m.id, Math.max(0, m.health)])), carriersBefore = carrierProperties(world),
      out = new Set();
    audit = new NativeAudit(world, {
      onStep({ nativeEnergy }) {
        const sample = nativeEnergy.maxGrowth;
        energyAudit.solves += nativeEnergy.solves; energyAudit.invalid += sample.invalid;
        energyAudit.maxGrowthJ = Math.max(energyAudit.maxGrowthJ, sample.growth);
        energyAudit.maxGravityWorkJ = Math.max(energyAudit.maxGravityWorkJ, sample.gravityWork);
        energyAudit.maxConstraintEnergyJ = Math.max(energyAudit.maxConstraintEnergyJ, sample.constraintEnergy);
        energyAudit.maxUnexplainedGrowthJ = Math.max(energyAudit.maxUnexplainedGrowthJ,
          sample.growth - Math.max(0, sample.gravityWork) - Math.max(0, sample.constraintEnergy));
      },
      onRecover({ state, reason, afterEnergy }) {
        diagnostics.push({ time: world.time, reason, energyBefore: state.energy.last.before, energyAfter: afterEnergy,
          vehicles: ids.map(id => ({ id, ...actorPhysics(world, id) })) });
      },
    });
    for (let step = 0; step < frames; step++) {
      const fought = sides.every(side => side.some(id => !out.has(id)));
      for (const id of ids) if (!out.has(id) && outOfAction(world, id)) { out.add(id); releaseWorldInputs(world, [id], 1); }
      if (fought && !sides.every(side => side.some(id => !out.has(id)))) releaseWorldInputs(world, ids, 1);
      else if (fought && step % 6 === 0) for (const [i, side] of sides.entries()) for (const id of side) {
        const enemy = sides[1 - i].find(other => !out.has(other)), action = !out.has(id) && laying(world, id, enemy, fire);
        if (!action) continue;
        applyWorldInput(world, id, { ...action, phase: 'decision' }, { platform: 'vehicle' }); firedCommands += action.fire;
      }
      const speeds = ids.map(id => Math.hypot(world.actor(id).vehicle.vx, world.actor(id).vehicle.vy)),
        { shots, explosions } = world.stats;
      world.step();
      if (!firstLoad && (world.stats.shots > shots || world.stats.explosions > explosions))
        firstLoad = { step: step + 1, time: world.time, incomingSpeed: Math.max(...speeds) };
      for (const id of ids) {
        const v = world.actor(id).vehicle, speed = Math.hypot(v.vx, v.vy), clearance = v.y - world.terrain.height(v.x);
        peaks.speed = Math.max(peaks.speed, speed); peaks.clearance = Math.max(peaks.clearance, clearance);
        // Settling under gravity before the first muzzle or blast is apart from what the hits do.
        if (firstLoad) { loadedPeaks.speed = Math.max(loadedPeaks.speed, speed); loadedPeaks.clearance = Math.max(loadedPeaks.clearance, clearance); }
      }
      for (const plate of world.plates) {
        const material = plateMaterialState(plate);
        for (const key of ['localDentMeters', 'dentLimitRatio']) peaks[key] = Math.max(peaks[key], material[key]);
        if (!material.finite || material.dentLimitRatio > 1 + 1e-6 || !Number.isFinite(plate.frame.x + plate.frame.y))
          invalid ??= `Contorno ou deformação local inválida em ${plate.id}`;
      }
    }
    const materialDamage = world.plates.reduce((damage, plate) => {
      damage.voidAreaM2 += Math.max(0, plate.originalArea - plate.remainingArea);
      damage.regrowthAreaM2 = Math.max(damage.regrowthAreaM2, plate.remainingArea - plate.originalArea);
      return damage;
    }, { voidAreaM2: 0, regrowthAreaM2: 0, carriersBefore, carriersAfter: carrierProperties(world) });
    const componentDamage = world.modules.map(m => ({ id: m.id, actorId: m.actorId, kind: m.kind,
      initialHealth: initialHealth.get(m.id), remainingHealth: m.health,
      loss: Math.max(0, Math.min(initialHealth.get(m.id), initialHealth.get(m.id) - m.health)),
      disabled: m.health <= 0, barrelDisabled: Boolean(m.barrelDisabled) }));
    return { name, invalid, steps: frames, recoveries: world.dynamics.recoveries || 0, diagnostics, energyAudit, stats: { ...world.stats },
      firedCommands, peaks, loadedPeaks, firstLoad, materialDamage, componentDamage,
      functionalHealthLost: componentDamage.reduce((sum, m) => sum + m.loss, 0) };
  } finally { audit?.close(); world.dispose(); }
}

export function assertCurrentStability(row, { speed, clearance }) {
  assert.equal(row.invalid, null);
  assert.equal(row.recoveries, 0); assert.equal(row.diagnostics.length, 0);
  assert.equal(row.energyAudit.invalid, 0);
  assert(row.stats.shots > 0 && row.stats.impacts > 0,
    'current mounted guns really fire and strike material: ' + JSON.stringify({ shots: row.stats.shots,
      impacts: row.stats.impacts, explosions: row.stats.explosions, firedCommands: row.firedCommands }));
  assert(row.functionalHealthLost > 0, 'the mounted impacts cause real clamped component damage');
  assert(row.peaks.speed < speed && row.peaks.clearance < clearance,
    JSON.stringify(row.peaks));
  const material = row.materialDamage;
  assert(Number.isFinite(material.voidAreaM2) && material.voidAreaM2 >= 0,
    'missing plate material is a finite nonnegative area');
  // The encounter aims at the installed weapon. A receiver, tube or mantlet
  // impact can damage that module without removing any hull plate cells;
  // materialDamage measures plates only, not the weapon's ballistic hitbox.
  assert(material.voidAreaM2 > 0 || row.componentDamage.some(part => part.kind === 'weapon' && part.loss > 0),
    'actual hits remove plate material or reduce real weapon health');
  assert(material.regrowthAreaM2 <= 1e-10, 'ballistic holes never heal');
  // The permanent hull/chassis stays installed. Changes in actual component masses account for
  // expended reserves and burnt interiors; a hit cannot delete unrelated structure or add inertia.
  assert.deepEqual(material.carriersAfter.map(c => [c.actorId, c.body]), material.carriersBefore.map(c => [c.actorId, c.body]));
  for (const [i, before] of material.carriersBefore.entries()) {
    const after = material.carriersAfter[i];
    assert(Math.abs(after.mass - after.modules - (before.mass - before.modules)) < 1e-6, 'hit damage never changes the mass of the structure');
    assert(after.mass <= before.mass + 1e-9 && after.inertia <= before.inertia + 1e-6, 'a hit never adds mass or inertia to a carrier');
  }
  assert(!Object.hasOwn(row.stats, 'ejectedMass'));
  for (const part of row.componentDamage) {
    assert(part.remainingHealth >= 0 && part.remainingHealth <= part.initialHealth);
    assert.equal(part.loss, part.initialHealth - part.remainingHealth);
  }
  assert.equal(row.functionalHealthLost, row.componentDamage.reduce((sum, part) => sum + part.loss, 0),
    'reported functional damage equals the measured clamped health losses');
}
