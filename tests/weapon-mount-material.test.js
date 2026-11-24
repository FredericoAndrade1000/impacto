import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { mechanicalState, actorPhysics, partPhysics } from '../scripts/review-harness.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { flyRound } from './mechanical-queries.js';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';
import { MATERIALS } from '../src/materials.ts';
import { WEAPON_PRESETS, weaponCompartment } from '../src/weapons.ts';

const polygonArea = points => Math.abs(points.reduce((sum, p, i) => {
  const q = points[(i + 1) % points.length]; return sum + p.x * q.y - p.y * q.x;
}, 0)) / 2;

for (const preset of ['rh120', 'm242', 'm252', 'm119']) {
  for (const facing of [-1, 1]) test(`${preset}/${facing}: admitted installation and functional failure preserve material, mass and one carrier`, t => {
    const source = structuredTemplateSource('heavy', { preset }), original = structuredClone(source),
      world = new World(source); t.after(() => world.dispose());
    const actorId = facing === -1 ? 'local' : 'mirrored';
    if (facing === 1) world.addActor(source, { id: actorId, ownerId: 'enemy', x: 55, facing });
    const gun = world.modules.find(m => m.actorId === actorId && m.kind === 'weapon'),
      host = world.plates.find(p => p.id === gun.weaponMount.hostId),
      carrier = partPhysics(world, gun).body, installedMass = gun.physicalMass,
      grid = structuredClone(host.ballisticGrid), polygons = structuredClone(gun.materialPolygons);
    assert(host); assertMountProjection(gun); assert(installedMass > 0);
    const armourMass = polygons.slice(4).reduce((sum, polygon) => sum + polygonArea(polygon), 0) *
      gun.weaponMount.materialDepth * MATERIALS.steel.density;
    assert.equal(gun.weaponMount.materialDensity, MATERIALS.steel.density);
    assert(Math.abs(installedMass - WEAPON_PRESETS[preset].installedMassKg - armourMass) < 1e-7,
      'only the actual curved steel sheets add armour mass to the catalogued weapon');
    const state = world.game().call({ op: 'physics' }), owner = state.owners.find(p => p.owner === world.game().handle(gun)),
      body = state.bodyStates.find(p => p.handle === owner.body), bodyMass = body.mass, inertia = body.inertia;
    if (facing === -1) assert(Math.abs(mechanicalState(world).mass - blueprintMass(world.blueprint)) < .005);
    const config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }, actorId),
      // The receiver turns with the bore about the trunnion, as far as the servo lays it.
      toBore = p => ({ x: gun.x + Math.cos(gun.barrelAngle) * p.x - Math.sin(gun.barrelAngle) * p.y,
        y: gun.y + Math.sin(gun.barrelAngle) * p.x + Math.cos(gun.barrelAngle) * p.y }),
      // A point inside the receiver, a quarter of the way along it and off its axis, and a round put there
      // flying along that axis.
      inside = () => toBore({ x: -gun.width * .75, y: gun.height * .2 }),
      receiverRound = (power, seconds) => flyRound(world, { ...inside(), vx: Math.cos(gun.barrelAngle) * 600,
        vy: Math.sin(gun.barrelAngle) * 600, power, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, seconds);
    let loss;
    for (const offset of [gun.weaponMount.min, 0, gun.weaponMount.max]) {
      world.aimWeapon({ x: gun.x + Math.cos(gun.angle + offset) * 80,
        y: gun.y + Math.sin(gun.angle + offset) * 80 }, config, actorId);
      for (let i = 0; i < 90; i++) world.step();
      assert.equal(partPhysics(world, gun).body, carrier); assert.equal(gun.physicalMass, installedMass);
      assert(gun.aimOffset >= gun.weaponMount.min - 1e-9 && gun.aimOffset <= gun.weaponMount.max + 1e-9);
      const projected = mountedWeaponPolygons(gun);
      assert.equal(projected.length, polygons.length);
      for (const [i, polygon] of polygons.entries()) assert.deepEqual(projected[i], polygon.map(i === 2 || i === 3
        ? p => ({ x: gun.x + Math.cos(gun.angle) * p.x - Math.sin(gun.angle) * p.y,
          y: gun.y + Math.sin(gun.angle) * p.x + Math.cos(gun.angle) * p.y }) : toBore),
        'receiver, tube and each curved armour facet turn with the bore in both facings');
      const point = inside(),
        end = toBore({ x: -gun.width * .65, y: gun.height * .2 }),
        owner = world.game().handle(gun), ignoreOwners = [...world.plates, ...world.modules]
          .filter(p => p !== gun).map(p => world.game().handle(p)),
        hit = world.game().call({ op: 'raycast', start: point, end, ignoreOwners });
      assert.equal(hit.owner, owner, 'native material ray sees the receiver at every elevation');
      const material = world.game().call({ op: 'material', owner, point, end });
      assert(Math.abs(material.uv.x - .25) < 1e-10);
      assert(Math.abs(material.uv.y - .3) < 1e-10);
      assert(material.resistance > .5, 'the same receiver ray has nonzero ballistic resistance');
      const health = gun.health, barrelDamage = gun.barrelDamage;
      // The receiver stops a weak round where it is put: what that costs is the same at every elevation.
      assert.equal(receiverRound(5), null);
      loss ??= health - gun.health;
      assert(loss > 0 && Math.abs(health - gun.health - loss) < 1e-9);
      assert.equal(gun.barrelDamage, barrelDamage, 'a receiver hit does not count as a tube strike');
    }
    // A round from the same point that goes through the receiver wall and is spent inside takes all the health there is,
    // and the rounds ready in its compartment, if it has any, go off with it.
    const ready = weaponCompartment(preset) ? gun.loaded ?? 0 : 0;
    receiverRound(gun.maxHealth * 2, .0001);
    for (let i = 0; i < 12; i++) { world.step(); world.drainEvents(); }
    const finalBody = world.game().call({ op: 'physics' }).bodyStates.find(p => p.handle === carrier);
    assert.equal(gun.health, 0); assert.equal(gun.attached, true); assert.equal(gun.bodyId, undefined);
    assert.equal(gun.physicalMass, installedMass); assert.equal(finalBody.mass, bodyMass); assert.equal(finalBody.inertia, inertia);
    assert.equal(partPhysics(world, gun).body, carrier); assert.deepEqual(gun.materialPolygons, polygons);
    assert.deepEqual(host.ballisticGrid, grid); assert(!Object.hasOwn(world.snapshot(), 'fragments'));
    assert.equal(world.stats.explosions, ready > 0 ? 1 : 0);
    assert.equal(world.dynamics.recoveries || 0, 0); assert.deepEqual(source, original);
  });
}
