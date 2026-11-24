import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileStructuredConstruction, planStructuredComponent, structuredPlacementIntent } from '../src/structured-construction.ts';
import { structuredComponent } from '../src/structured-editing.ts';
import { mountChoices } from '../src/piece-settings.ts';
import { WEAPON_MOUNTS, compatibleWeaponMounts, weaponMountCost, weaponMountSpeed } from '../src/weapon-mounts.ts';
import { constructionCost, pieceCost } from '../src/construction-cost.ts';
import { WEAPONS, WEAPON_PRESETS, weaponOf } from '../src/weapons.ts';
import { Editor } from '../src/editor.ts';
import { World } from '../src/physics.ts';
import { Fog, chapters } from '../server/fog.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';

await initNativeDynamics();

// Poses and nodes in cells: a 5.8 m by 2 m box.
const pose = (x, y, angle = 0) => ({ x, y, angle });
const box = (components = []) => ({ version: DESIGN_VERSION, preset: 'bunker', name: 'Exposição',
  nodes: [[-58, 0], [58, 0], [58, 40], [-58, 40]].map(([x, y], i) => ({ id: `n${i}`, x, y })),
  plates: ['floor', 'rear', 'roof', 'front'].map((side, i) => ({ id: `hull:${side}`, a: `n${i}`, b: `n${(i + 1) % 4}`,
    material: 'steel', thicknessMm: 20 })), components });
const mounted = (preset = 'm2hb') => ({ id: 'gun', kind: 'weapon', weaponPreset: preset,
  pose: pose(-36, 64, Math.PI / 2), mount: { preset: 'pintle' } });

test('a roof pintle keeps its fixed post and carried gun roles at either facing', t => {
  for (const facing of [-1, 1]) {
    const source = box([mounted()]), world = new World(source); t.after(() => world.dispose());
    world.replaceActor(source, { id: 'local', x: 12, facing });
    const gun = world.snapshot().modules.find(module => module.kind === 'weapon');
    assert.equal(gun.weaponMount.exposed, true); assert.equal(gun.materialPolygons.length, 4);
    assert(Math.abs(gun.angle - Math.PI / 2) < 1e-10);
    const before = mountedWeaponPolygons(gun), aimed = mountedWeaponPolygons({ ...gun, barrelAngle: gun.barrelAngle + .25 });
    assert.deepEqual(aimed[0], before[0], 'the real post remains on the roof axis');
    assert.notDeepEqual(aimed[2], before[2], 'the carried receiver still follows aim');
  }
});

test('an exposed gun has its chosen mounting and full sector without requiring a roof', () => {
  for (const preset of ['m2hb', 'mk19']) {
    const source = box([mounted(preset)]), before = structuredClone(source), gun = compileStructuredConstruction(source).modules[0];
    assert.equal(gun.weaponMount.preset, 'pintle'); assert.equal(gun.weaponMount.exposed, true);
    assert.deepEqual([gun.weaponMount.min, gun.weaponMount.max], [-1.75, 1.75]);
    assert.equal(gun.weaponMount.port, undefined); assert.equal(gun.weaponMount.shield, null);
    assert.deepEqual(source, before);
    // It stands on the roof 1.2 m under it, on a post drawn out to it and sturdier for it; with no roof, on the shortest.
    const loose = compileStructuredConstruction({ ...source, nodes: [], plates: [] }).modules[0];
    assert.equal(gun.weaponMount.hostId, 'hull:roof'); assert.equal(loose.weaponMount.hostId, null);
    assert.deepEqual([loose.x, loose.y, loose.angle], [gun.x, gun.y, gun.angle]);
    assert(loose.physicalMass < gun.physicalMass);
  }
  assert(mountChoices('m2hb').some(choice => choice.id === 'pintle'));
  assert(!mountChoices('rh120').some(choice => choice.id === 'pintle'));
});

test('an exposed gun is priced for its real post without adding armour', () => {
  const source = box([mounted()]), compiled = compileStructuredConstruction(source), gun = compiled.modules[0],
    post = gun.materialPolygons[0], area = Math.abs(post.reduce((sum, p, i) => {
      const q = post[(i + 1) % post.length]; return sum + p.x * q.y - p.y * q.x;
    }, 0)) / 2, mount = gun.weaponMount;
  assert.equal(pieceCost(gun), WEAPON_PRESETS.m2hb.costCredits + WEAPON_MOUNTS.pintle.cost +
    Math.ceil(area * mount.materialDepth * mount.materialDensity * 1.4));
  assert.equal(constructionCost(source).total, [...compiled.plates, ...compiled.modules].reduce((sum, part) => sum + pieceCost(part), 0));
});

test('a gun heavier than its pintle is rated for stands on a post grown to it, slower to lay and costlier, as the core reckons', () => {
  // Three barrels of the M2 weigh more than a pintle is rated for: it takes them, as any gun of a kind it is made for.
  const id = 'm2hb|L91|N3', gun = weaponOf(id), pintle = WEAPON_MOUNTS.pintle;
  assert(gun.installedMassKg > pintle.ratedMass, `${gun.installedMassKg} kg`);
  assert(compatibleWeaponMounts(id).some(([mount]) => mount === 'pintle'));
  const compiled = compileStructuredConstruction(box([mounted(id)])).modules[0], mount = compiled.weaponMount,
    full = Math.min(pintle.maxSpeed, WEAPONS[gun.family].servoMaxSpeed ?? pintle.maxSpeed);
  const near = (a, b) => assert(Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)), `${a} != ${b}`);
  near(weaponMountSpeed(id, pintle), mount.maxSpeed);
  near(mount.maxSpeed, full * Math.sqrt(pintle.ratedMass / gun.installedMassKg));
  near(weaponMountCost(id, pintle), pintle.cost * gun.installedMassKg / pintle.ratedMass);
  // Light enough, the mount is as the catalogue has it.
  assert.equal(weaponMountCost('m2hb', pintle), pintle.cost); assert.equal(weaponMountSpeed('m2hb', pintle), pintle.maxSpeed);
  const post = compiled.materialPolygons[0], area = Math.abs(post.reduce((sum, p, i) => {
    const q = post[(i + 1) % post.length]; return sum + p.x * q.y - p.y * q.x;
  }, 0)) / 2;
  near(pieceCost(compiled), gun.costCredits + weaponMountCost(id, pintle) + Math.ceil(area * mount.materialDepth * mount.materialDensity * 1.4));
});

test('a mount change keeps narrower authored limits with undo, and is refused where the new travel buries the barrel', () => {
  const editor = new Editor(box([mounted()])), current = () => editor.source.components[0].mount,
    before = structuredClone(editor.source), history = editor.past.length;
  editor.select('gun');
  // On its feet on the roof, level, the light trunnion's whole travel would take its barrel down into the roof, too
  // nearly along it for a port: refused, and nothing changes.
  assert.throws(() => editor.editProperty('mountPreset', 'light-trunnion', true), error => error.reason === 'MOUNT_PORT');
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history); editor.select('gun');
  const chosen = { min: -.04, max: .04 };
  editor.editProperty('sectorMin', chosen.min, true); editor.editProperty('sectorMax', chosen.max, true);
  editor.editProperty('mountPreset', 'light-trunnion', true);
  assert.deepEqual(current().sector, chosen); assert.equal(current().preset, 'light-trunnion');
  editor.editProperty('mountPreset', 'pintle', true);
  assert.deepEqual(current().sector, chosen); assert.equal(current().preset, 'pintle');
});

test('free equipment uses the cursor pose and exposure derives from enclosure', () => {
  const source = box(), engine = structuredComponent('engine'), point = { x: 15.8, y: 2.3 },
    chosen = structuredPlacementIntent(engine, point), outside = planStructuredComponent(source, { ...engine, pose: chosen });
  assert.deepEqual(chosen, pose(76, 20));
  assert.equal(outside.compiled.modules[0].exposed, true);
  const fuel = { ...structuredComponent('fuel'), pose: pose(0, 20) }, enclosed = planStructuredComponent(source, fuel);
  assert.equal(enclosed.compiled.modules[0].exposed, undefined);
  const editor = new Editor(outside.construction); editor.select(engine.id);
  const copy = editor.duplicate(); editor.addModule(copy.kind, { x: 15.8, y: 4 }, copy);
  assert.equal(editor.source.components.length, 2);
  assert(editor.blueprint.modules.every(part => part.exposed));
  assert.deepEqual(editor.source.plates, source.plates);
});

test('exposed equipment is visible through faction fog while enclosed equipment stays private', t => {
  const pieces = [
    { id: 'command', kind: 'command', pose: pose(-36, 10) },
    { id: 'engine', kind: 'engine', pose: pose(-10, 10) },
    { id: 'ammo', kind: 'ammo', ammoPreset: 'm2hb', pose: pose(14, 10) },
    { id: 'inner', kind: 'fuel', pose: pose(38, 10) },
    mounted(),
    { id: 'tank', kind: 'fuel', pose: pose(70, 20) },
    { id: 'hopper', kind: 'hopper', pose: pose(30, 64) },
  ];
  const world = new World(box(pieces)); t.after(() => world.dispose());
  const whole = world.snapshot(), actor = whole.actors[0], fog = new Fog();
  fog.read({ sight: { watcher: [{ actorId: actor.id, channel: 'visual', visible: true, x: actor.x, y: 2, error: .5, by: 'w1' }] } }, whole.time);
  const name = module => pieces.find(piece => module.id === piece.id || module.id.endsWith(':' + piece.id))?.id,
    seen = fog.tell(whole, chapters(whole), 'watcher').modules.filter(module => module.actorId === actor.id);
  assert.deepEqual(seen.map(name).sort(), ['gun', 'hopper', 'tank']);
  assert.equal(seen.find(module => name(module) === 'tank').exposed, true);
});
