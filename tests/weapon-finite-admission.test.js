import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { World } from '../src/physics.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { physics } from './mechanical-queries.js';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';

await initNativeDynamics();

const node = (id, x, y) => ({ id, x, y }), plate = (id, a, b) => ({ id, a, b, material: 'steel', thicknessMm: 20 });
// A box that stands fixed: what is tested is how its weapon stands among its plates, not how it drives. It is as high as
// the breech of its gun, turned with it through its sector, needs to clear its roof and its floor. Every position is
// written in cells of 5 cm: 116 by 42 is 5.8 m by 2.1 m, and the trunnion stands a quarter of a metre behind the front.
function cannon(length = 116, height = 42) {
  return { version: DESIGN_VERSION, preset: 'bunker', name: 'Finite plate admission fixture',
    nodes: [node('hull-0', -length / 2, 0), node('hull-1', length / 2, 0),
      node('hull-2', length / 2, height), node('hull-3', -length / 2, height)],
    plates: [plate('hull:floor', 'hull-0', 'hull-1'), plate('hull:rear', 'hull-1', 'hull-2'),
      plate('hull:roof', 'hull-2', 'hull-3'), plate('hull:front', 'hull-3', 'hull-0')],
    components: [
      { id: 'gun', kind: 'weapon', weaponPreset: 'rh120', pose: { x: -length / 2 + 6, y: height / 2, angle: Math.PI },
        mount: { radiusM: .28, preset: 'heavy-trunnion', sector: { min: -.5, max: .35 } } },
    ] };
}
// A room standing on the roof, centred at x: its feet divide the roof in three and the middle stretch is its floor.
function standTower(source, x, length, height, id = 'turret') {
  const roof = source.nodes[2].y, front = x - length / 2, rear = x + length / 2;
  source.nodes.push(node(id + '-0', front, roof), node(id + '-1', rear, roof),
    node(id + '-2', rear, roof + height), node(id + '-3', front, roof + height));
  source.plates.splice(2, 1, plate('hull:roof', 'hull-2', id + '-1'), plate(id + ':floor', id + '-1', id + '-0'),
    plate('hull:deck', id + '-0', 'hull-3'));
  source.plates.push(plate(id + ':rear', id + '-1', id + '-2'), plate(id + ':roof', id + '-2', id + '-3'),
    plate(id + ':front', id + '-3', id + '-0'));
  return source;
}
// A node set on a plate divides it: the two stretches take its place in the written order.
function divide(source, plateId, joint, id) {
  const index = source.plates.findIndex(whole => whole.id === plateId), whole = source.plates[index];
  source.nodes.push(joint); source.plates.splice(index, 1, { ...whole, b: joint.id }, { ...whole, id, a: joint.id });
  return source;
}
const distantTower = source => standTower(source, -29, 16, 16, 'distant-turret');
const near = (actual, expected, tolerance = 1e-8) =>
  assert(Math.abs(actual - expected) < tolerance, `${actual} != ${expected}`);
function canonicalPolygon(polygon) {
  const points = polygon.slice(), area = points.reduce((sum, p, i) => {
    const q = points[(i + 1) % points.length]; return sum + p.x * q.y - p.y * q.x;
  }, 0);
  if (area < 0) points.reverse();
  const first = points.reduce((best, p, i) => p.x < points[best].x ||
    p.x === points[best].x && p.y < points[best].y ? i : best, 0);
  return [...points.slice(first), ...points.slice(0, first)];
}

test('a high front cannon clears finite roof metal without shrinking sector or port', () => {
  const source = distantTower(cannon()), before = structuredClone(source), dto = compileStructuredConstruction(source),
    gun = dto.modules[0], mount = gun.weaponMount;
  const { barrel, receiver, recoil } = WEAPON_PRESETS.rh120;
  assert.deepEqual(source, before); assert.equal(mount.min, -.5); assert.equal(mount.max, .35);
  assert.equal(mount.recoil, recoil); assert(mount.walls.every(wall => wall.port.lo < wall.port.hi));
  assert(gun.y + barrel * Math.sin(.5) > dto.rooms[0].polygon[2].y, 'the admitted external tube may rise above the roof');
  // One box around the whole weapon would reach the tower: the recoil reserve ends behind its front wall.
  assert(gun.x + receiver.length + recoil > dto.rooms[1].polygon[0].x);
  assertMountProjection(gun);
  assert.deepEqual(gun.materialPolygons[0].map(p => p.x), [-receiver.length, 0, 0, -receiver.length],
    'the reserved recoil space remains empty behind the physical receiver');
  const canonical = validateStructuredConstruction(source);
  assert.deepEqual(compileStructuredConstruction(canonical), dto);
  for (const wall of mount.walls) assert(dto.plates.some(plate => plate.owner === wall.owner && plate.id === wall.wallId));
});

test('real descending tube, mantlet and fixed recoil remain blockers with identifiable owners', () => {
  const descending = standTower(cannon(), 0, 40, 44);
  descending.components[0].pose = { x: -14, y: 64, angle: Math.PI };
  descending.components[0].mount = { radiusM: .28,
    preset: 'heavy-trunnion', sector: { min: -.5, max: .5 } };
  assert.throws(() => compileStructuredConstruction(descending), error => error.reason === 'MOUNT_PORT' && ["gun","hull:deck"].every(id => error.ids?.includes(id)));
  descending.components[0].mount.sector.max = .1;
  assert(compileStructuredConstruction(descending).mechanicalAdmission);
  const low = cannon(116, 10);
  assert.throws(() => compileStructuredConstruction(low), error => ['BARREL_CROSSING', 'MOUNT_PORT'].includes(error.reason) && error.ids?.includes('gun'));
  const short = cannon(28);
  assert.throws(() => compileStructuredConstruction(short), error => error.reason === 'BREECH_PLATE' && ["gun","hull:rear"].every(id => error.ids?.includes(id)) && error.surface === "wall");
});

test('an empty weapon sweep envelope admits equipment while its real breech rejects overlap', () => {
  // Over the fan its breech sweeps, turned with the gun from 29 degrees up to 20 down, a command post fits; in the fan,
  // it is met, and said so with the bore where it meets it.
  // Half a cell off the grid before, the post above the fan now stands a little further clear of it, the one in it a
  // little nearer the level of the bore.
  const source = cannon(116, 44);
  source.components.push({ id: 'command', kind: 'command', pose: { x: -45, y: 36, angle: 0 } });
  assert(compileStructuredConstruction(source).mechanicalAdmission);
  source.components[1].pose.y = 25;
  assert.throws(() => compileStructuredConstruction(source), error => error.reason === 'BREECH_COMPONENT' && ["gun","command"].every(id => error.ids?.includes(id)) && error.angleDegrees === 0);
});

test('a free sensor keeps its pose across a plate split and a neighbouring corner edit', () => {
  const source = cannon(116, 40);
  source.components = [{ id: 'camera', kind: 'sensor', sensorMode: 'visual',
    pose: { x: 0, y: 45, angle: 0 } }];
  divide(source, 'hull:roof', node('ridge', 0, 40), 'hull:deck');
  const camera = compileStructuredConstruction(source).modules[0];
  assert.equal(camera.x, 12); assert.equal(camera.exposed, true);
  const corner = structuredClone(source); corner.nodes.find(joint => joint.id === 'ridge').y = 42;
  assert.deepEqual(corner.components, source.components);
  assert.equal(compileStructuredConstruction(corner).modules[0].y, camera.y);
  source.plates.find(stretch => stretch.id === 'hull:deck').thicknessMm = 30;
  assert.equal(compileStructuredConstruction(source).modules[0].y, camera.y);
});

function dividedBase() {
  // A tower 0.75 m high (0.74 m before, off the grid), its machine gun in the middle of its front.
  const source = divide(standTower(cannon(116, 40), 0, 40, 15), 'turret:floor', node('turret-mid', 5, 40), 'turret:floor-front');
  source.components[0] = { id: 'gun', kind: 'weapon', weaponPreset: 'minimi',
    pose: { x: -18, y: 47, angle: Math.PI },
    mount: { radiusM: .125, preset: 'light-trunnion', sector: { min: -.6, max: .6 } } };
  return source;
}

for (const facing of [-1, 1]) test(`divided hull and turret floors keep real wall owners on cold readmission at facing ${facing}`, t => {
  const source = dividedBase(), first = compileStructuredConstruction(source);
  divide(source, 'hull:floor', node('keel', 0, 0), 'hull:keel');
  divide(source, 'turret:floor-front', node('turret-base', 0, 40), 'turret:floor-nose');
  const dto = compileStructuredConstruction(source), floor = dto.rooms[1].walls.filter(wall => !wall.exterior);
  // Every stretch of the shared floor is one real plate of both rooms; dividing it adds plates but no metal.
  assert.deepEqual(floor.map(wall => wall.id).sort(), ['turret:floor', 'turret:floor-front', 'turret:floor-nose']);
  assert.equal(new Set(floor.map(wall => wall.owner)).size, 3);
  assert.equal(dto.rooms[1].polygon.length, 6); assert.equal(dto.plates.length, first.plates.length + 2);
  near(dto.fixedAssembly.mass, first.fixedAssembly.mass, 1e-7);
  for (const wall of floor) {
    assert.equal(dto.plates.filter(plate => plate.id === wall.id && plate.owner === wall.owner).length, 1);
    assert(dto.rooms[0].walls.some(under => under.id === wall.id && under.owner === wall.owner && !under.exterior));
  }
  const world = new World(source); t.after(() => world.dispose());
  world.addActor(source, { id: 'copy', ownerId: 'other', x: 55, facing }); world.step();
  const gun = world.modules.find(module => module.actorId === 'copy' && module.kind === 'weapon');
  assert.equal(gun.weaponMount.walls.length, 1, 'the mount retains only the plate it fires through');
  for (const wall of gun.weaponMount.walls) assert(world.plates.some(plate => plate.id === wall.wallId));
  assert.equal(physics(world).bodies, 2);
  assert.equal(world.dynamics.recoveries || 0, 0);
});

for (const facing of [-1, 1]) test(`finite-plate high cannon aims and fires from its real muzzle at facing ${facing}`, t => {
  const source = distantTower(cannon());
  // On the floor: 0.375 m before, half a cell off the grid, and raised to the cell above.
  source.components.push({ id: 'ammo', kind: 'ammo', ammoPreset: 'rh120', pose: { x: 8, y: 8, angle: 0 } });
  const world = new World(source); t.after(() => world.dispose());
  const actorId = facing === -1 ? 'local' : 'copy';
  if (facing === 1) world.addActor(source, { id: actorId, ownerId: 'other', x: 55, facing });
  const gun = world.modules.find(module => module.actorId === actorId && module.kind === 'weapon'),
    ammo = world.modules.find(module => module.actorId === actorId && module.kind === 'ammo'),
    offset = facing === -1 ? -.5 : .5, config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }, actorId),
    aim = { x: gun.x + Math.cos(gun.angle + offset) * 80, y: gun.y + Math.sin(gun.angle + offset) * 80 },
    receiver = structuredClone(mountedWeaponPolygons(gun)[0]), laid = gun.barrelAngle, rounds = ammo.rounds;
  world.aimWeapon(aim, config, actorId);
  for (let i = 0; i < 90; i++) world.step();
  near(gun.aimOffset, offset);
  // The receiver turns with the bore about the trunnion, as far as the servo laid it; reflection/readmission may
  // reverse its winding.
  const turn = gun.barrelAngle - laid, c = Math.cos(turn), s = Math.sin(turn),
    turned = receiver.map(p => ({ x: gun.x + c * (p.x - gun.x) - s * (p.y - gun.y), y: gun.y + s * (p.x - gun.x) + c * (p.y - gun.y) }));
  for (const [i, point] of canonicalPolygon(mountedWeaponPolygons(gun)[0]).entries()) {
    near(point.x, canonicalPolygon(turned)[i].x, 1e-9); near(point.y, canonicalPolygon(turned)[i].y, 1e-9);
  }
  assert(world.fire(aim, config, true, actorId)); assert.equal(ammo.rounds, rounds - 1);
  const shot = world.projectiles.at(-1); assert(shot); assert(shot.vx * facing > 0); assert(shot.vy > 0);
  assert(Math.hypot(shot.x - gun.x, shot.y - gun.y) > 1.7);
  assert.equal(world.actor(actorId).stats.shots, 1);
  assert.equal(world.dynamics.recoveries || 0, 0);
});
