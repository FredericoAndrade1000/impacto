import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { boxBlueprint } from './helpers/perception-scene.js';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { localToWorld, plateCorners } from '../src/math.ts';
import { weaponAngle } from '../src/weapon-geometry.ts';
import { fixedWeapon } from '../src/weapons.ts';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';
import { prepareDynamics } from '../scripts/review-native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { duel } from './helpers/duel.js';
import { onField } from './helpers/field.js';

const near = (a, b, tolerance = 1e-6) => assert(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const angleNear = (a, b, tolerance = 1e-6) => near(Math.atan2(Math.sin(a - b), Math.cos(a - b)), 0, tolerance);
const options = () => ({ visualEvents: false, terrain: 'flat', separation: 36 });

  test(`Rust: explicit facing reflects the complete design, plate anchors and barrel; chassis stays upright`, async t => {
    await prepareDynamics();
    const design = createConstruction('recon'), compiled = compileBlueprint(design),
      plate = compiled.plates.find(p => p.id.endsWith('hull:front')),
      engine = compiled.modules.find(m => m.kind === 'engine'), gun = compiled.modules.find(m => m.kind === 'weapon');
    const world = new World(createConstruction('empty'), options()); t.after(() => world.dispose());
    for (const facing of [-1, 1]) {
      const x = facing * 20, actor = world.addActor(design, { id: String(facing), x, facing }),
        placed = world.plates.find(p => p.actorId === actor.id && p.id.endsWith(plate.id)).definition,
        lift = actor.vehicle.y - VEHICLE_ORIGIN.y;
      assert.equal(actor.facing, facing); assert.equal(actor.mirror, -facing);
      near(lift, .01); // Flat-map admission leaves 2 cm above the gear envelope.
      near(placed.x, x - facing * (plate.x - 12)); near(placed.y, plate.y + lift);
      const outline = plateCorners(placed);
      for (const point of plateCorners(plate)) {
        const expected = { x: x - facing * (point.x - 12), y: point.y + lift };
        assert(outline.some(p => Math.hypot(p.x - expected.x, p.y - expected.y) < 1e-6));
      }
      for (const [i, anchor] of plate.anchors.entries()) {
        const before = localToWorld(plate, anchor.u * plate.length, anchor.v * plate.thicknessMm / 1000),
          after = localToWorld(placed, placed.anchors[i].u * placed.length, placed.anchors[i].v * placed.thicknessMm / 1000);
        near(after.x, x - facing * (before.x - 12)); near(after.y, before.y + lift);
      }
      const installedEngine = world.modules.find(m => m.actorId === actor.id && m.kind === 'engine'),
        installedGun = world.modules.find(m => m.actorId === actor.id && m.kind === 'weapon');
      angleNear(installedEngine.angle, -facing * engine.angle);
      angleNear(weaponAngle(installedGun), facing === 1 ? Math.PI - weaponAngle(gun) : weaponAngle(gun));
      const gunHost = world.plates.find(p => p.actorId === actor.id && p.id.endsWith(gun.weaponMount.hostId)),
        originalHost = compiled.plates.find(p => p.id === gun.weaponMount.hostId);
      assert.equal(installedGun.weaponMount.hostId, gunHost.id);
      near(gunHost.definition.x, x - facing * (originalHost.x - 12));
      near(gunHost.definition.y, originalHost.y + lift);
      near(installedGun.weaponMount.min, facing === 1 ? -gun.weaponMount.max : gun.weaponMount.min);
      near(installedGun.weaponMount.max, facing === 1 ? -gun.weaponMount.min : gun.weaponMount.max);
      assert(Math.cos(installedEngine.angle) > 0, 'component lettering is upright, without a reflected texture');
      const launcher = world.launcher({ platform: 'bench' }, actor);
      near(launcher.x, x - facing * (compiled.launcher.x - 12));
      assert.equal(world.snapshot().actors.find(a => a.id === actor.id).mirror, -facing);
    }
    const defaultActor = world.addActor(design, { id: 'default', x: 40 });
    assert.equal(defaultActor.facing, -1); assert.equal(defaultActor.mirror, 1);
    near(world.plates.find(p => p.actorId === defaultActor.id && p.id.endsWith(plate.id)).definition.x, 40 + plate.x - 12);
    assert.throws(() => world.addActor(design, { id: 'invalid', facing: 0 }), /Orientação/);
    const unplaced = world.actor('local'); assert.equal(unplaced.facing, -1); assert.equal(unplaced.mirror, 1);
  });

  test(`Rust: duel fronts and guns face the enemy on either side; drive commands retain world direction`, async t => {
    await prepareDynamics();
    for (const swapSides of [false, true]) {
      const design = createConstruction('recon'), before = structuredClone(design), world = duel(t, design, { ...options(), swapSides }),
        ids = ['local', 'opponent'], starts = new Map();
      for (const id of ids) {
        const actor = world.actor(id), enemy = world.actor(ids.find(other => other !== id)),
          facing = Math.sign(enemy.vehicle.x - actor.vehicle.x),
          front = world.plates.find(p => p.actorId === id && p.id.endsWith('hull:front')),
          engine = world.modules.find(m => m.actorId === id && m.kind === 'engine'),
          gun = world.modules.find(m => m.actorId === id && m.kind === 'weapon');
        assert.equal(actor.facing, facing); assert.equal(actor.mirror, -facing);
        assert((front.definition.x - actor.vehicle.x) * facing > 1.5, 'front armour faces the opposing vehicle');
        assert((engine.x - actor.vehicle.x) * facing < -1, 'the engine remains at the rear');
        assert(Math.abs(actor.vehicle.angle) < .03, 'horizontal reflection leaves the chassis upright');
        assert(Math.cos(weaponAngle(gun)) * facing > .99, 'barrel agrees with the front armour');
        starts.set(id, actor.vehicle.x); world.controlVehicle(facing * .7, 0, id);
      }
      for (let i = 0; i < 120; i++) world.step();
      for (const id of ids) {
        const actor = world.actor(id), facing = actor.facing,
          gun = world.modules.find(m => m.actorId === id && m.kind === 'weapon');
        assert((actor.vehicle.x - starts.get(id)) * actor.facing > .3, 'right/left throttle drives in its original world direction');
        const settings = fixedWeapon({ platform: 'vehicle', componentId: gun.id, aimAngle: weaponAngle(gun), ammo: 'ap' }, world.modules),
          aim = { x: gun.x + facing * 40, y: gun.y };
        assert(world.fire(aim, settings, true, id), 'the real muzzle clears the correctly facing armour');
        const shot = world.projectiles.at(-1);
        assert(shot.vx * facing > 0); assert((shot.x - gun.x) * facing > .5);
      }
      assert.equal(world.dynamics.recoveries || 0, 0); assert.deepEqual(design, before);
      assert.equal(world.dynamics.backend, 'rust');
    }
  });

test('network facing labels and asymmetric placement bounds use the same horizontal reflection', t => {
  const room = rehearsal([0, 30000]), f = onField(t, room);
  const first = room.join('Direita'), design = boxBlueprint({ length: 2, height: 1, thicknessMm: 65 });
  // Deliberately offset the closed authored frame to the left of workshop X=12.
  for (const node of design.nodes) node.x -= 40; // cells: 2 m
  // No construction comes into the field without a command post: this one has its own inside the frame.
  design.components.push({ id: 'command', kind: 'command', pose: { x: -45, y: design.nodes[0].y + 5, angle: 0 } }); // cells: -2.25 m, 25 cm up
  const reflected = compileBlueprint(design).plates.flatMap(plateCorners).map(p => -(p.x - 12));
  const x = f.site(first, design), id = f.raise(first, design, { x, facing: 1 }), actor = room.world.actor(id),
    bounds = room.world.actorBounds(id);
  assert.equal(actor.facing, 1); assert.equal(actor.mirror, -1);
  near(bounds.minX - x, Math.min(...reflected)); near(bounds.maxX - x, Math.max(...reflected));
  // Only the faction's own constructions take a place: the second of the same player, turned the other way.
  assert.throws(() => f.open(first, design, { x: x + 4, facing: -1 }), /Não há espaço aí/,
    'the second closed frame occupies exactly the reflected first one');
});
