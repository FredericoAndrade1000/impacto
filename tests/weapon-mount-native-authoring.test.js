import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate, structuredTemplateSource } from '../src/structured-templates.ts';
import { compileStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { DESIGN_VERSION, validateBlueprint } from '../src/persistence.ts';
import { World } from '../src/physics.ts';
import { Editor } from '../src/editor.ts';
import { installedWeaponShapes, weaponContains } from '../src/weapon-art.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { pieceCost } from '../src/construction-cost.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { ammunitionSupply } from '../src/component-volume.ts';
import { physics } from './mechanical-queries.js';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';

await initNativeDynamics();

for (const id of ['heavy', 'ifv', 'scout', 'recon', 'mortar', 'howitzer', 'chassis', 'bunker', 'outpost']) {
  test(`${id} is an authored node-and-plate construction whose complete mechanics comes from Rust`, () => {
    const source = createStructuredTemplate(id), before = structuredClone(source), dto = compileStructuredConstruction(source);
    assert.equal(source.version, DESIGN_VERSION); assert.equal(dto.canonicalVersion, DESIGN_VERSION); assert(dto.mechanicalAdmission);
    // The running gear comes with the chassis of a vehicle, after what was put in; what stands fixed has none.
    assert.deepEqual(source, before); assert.deepEqual(dto.modules.map(m => m.id), [...source.components.map(m => m.id), ...(dto.chassis?.gear ?? [])]);
    assert(dto.modules.every(m => m.physicalMass > 0 && m.maxHealth > 0));
    assert(blueprintMass(dto) > 0);
    for (const weapon of dto.modules.filter(m => m.kind === 'weapon')) {
      const mount = weapon.weaponMount, plate = dto.plates.find(p => p.id === mount.hostId);
      assert(plate?.ballisticGrid); assertMountProjection(weapon);
      assert(mount.walls.every(wall => wall.port.lo < wall.port.hi)); assert(mount.min <= weapon.aimOffset && weapon.aimOffset <= mount.max);
      assert.equal(weapon.barrelAngle, weapon.angle + weapon.aimOffset);
      assert.equal(ammunitionSupply(dto.modules, weapon.weaponPreset).length, 1);
      assert(pieceCost(weapon) > WEAPON_PRESETS[weapon.weaponPreset].costCredits);
    }
  });
}

for (const preset of Object.keys(WEAPON_PRESETS)) {
  for (const dual of [false, true]) test(`template authoring admits ${preset}, dual=${dual}, without placement repair`, t => {
    const proposal = structuredTemplateSource('heavy', { preset, dual }), before = structuredClone(proposal),
      source = validateStructuredConstruction(proposal), dto = compileStructuredConstruction(source);
    assert.deepEqual(proposal, before); assert.equal(dto.modules.filter(m => m.kind === 'weapon').length, dual ? 2 : 1);
    assert.deepEqual(source.components.map(p => p.id), proposal.components.map(p => p.id));
    for (const part of source.components.filter(p => p.kind === 'weapon')) {
      const expected = proposal.components.find(p => p.id === part.id).mount.sector,
        native = dto.modules.find(p => p.id === part.id).weaponMount;
      assert.deepEqual(part.mount.sector, expected);
      assert(part.mount.sector.max - part.mount.sector.min > 0,
        'compact authored bays retain a useful sector instead of a full mounting sweep');
      assert.equal(native.min, expected.min); assert.equal(native.max, expected.max);
    }
    const world = new World(source); t.after(() => world.dispose());
    world.game();
    for (const compiled of dto.modules.filter(part => part.kind === 'weapon')) {
      const installed = world.modules.find(part => part.id === compiled.id);
      assert(compiled.receiverMm > 0 && compiled.barrelMm > 0);
      assert.deepEqual([installed.health, installed.receiverMm, installed.barrelMm],
        [compiled.health, compiled.receiverMm, compiled.barrelMm]);
    }
  });
}

test('sector edits restrict authoring and reject unsupported expansion atomically', () => {
  const editor = new Editor(createStructuredTemplate('heavy')),
    originalSector = structuredClone(editor.source.components.find(p => p.kind === 'weapon').mount.sector);
  editor.select('weapon'); editor.editProperty('sectorMin', -.04, true); editor.editProperty('sectorMax', .04, true);
  assert.deepEqual(editor.source.components.find(p => p.id === 'weapon').mount.sector, { min: -.04, max: .04 });
  assert.equal(editor.selected.weaponMount.min, -.04); assert.equal(editor.selected.weaponMount.max, .04);
  const before = structuredClone(editor.source), history = editor.past.length;
  assert.throws(() => editor.editProperty('sectorMax', 2, true), { reason: 'FIELD', field: "max" });
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history);
  assert.throws(() => editor.editProperty('mountSpeed', 100, true), /arraste-a/);
  editor.undo(); editor.undo();
  assert.deepEqual(editor.source.components.find(p => p.id === 'weapon').mount.sector, originalSector);
});

for (const [template, options] of [['chassis', {}], ['heavy', { preset: 'rh120', dual: true,
  stretch: .94, armourScale: 1.35, engineScale: 1.02 }],
['scout', { preset: 'm119', dual: true, stretch: .94, armourScale: .55 }],
['scout', { preset: 'm777', dual: true, stretch: .94, armourScale: .55 }]]) {
  test(`authored physical clearance preserves every requested sector for ${template}/${options.preset || 'unarmed'}`, () => {
    const proposal = structuredTemplateSource(template, options), before = structuredClone(proposal),
      dto = compileStructuredConstruction(proposal);
    assert.deepEqual(proposal, before);
    for (const part of proposal.components.filter(component => component.kind === 'weapon')) {
      const mount = dto.modules.find(module => module.id === part.id).weaponMount;
      assert.equal(mount.min, part.mount.sector.min);
      assert.equal(mount.max, part.mount.sector.max);
    }
    assert.equal(dto.modules.length, proposal.components.length + dto.chassis.gear.length);
  });
}

test('native curved material facets alone supply mounted drawing and picking geometry', () => {
  const admitted = compileStructuredConstruction(createStructuredTemplate('heavy')).modules.find(m => m.kind === 'weapon'),
    weapon = { ...admitted, barrelAngle: admitted.angle + .2 },
    native = weapon.materialPolygons, shapes = installedWeaponShapes(weapon), posed = mountedWeaponPolygons(weapon);
  assertMountProjection(admitted); assert.equal(shapes.length, native.length); assert.equal(posed.length, native.length);
  assert.deepEqual(shapes.map(shape => shape.points), native.map(poly => poly.flatMap(p => [p.x, p.y])));
  // The two fixed feet stay with the mount; receiver, tube and shield follow the bore.
  for (const [index, poly] of posed.entries()) {
    const angle = index === 2 || index === 3 ? weapon.angle : weapon.barrelAngle,
      c = Math.cos(angle), s = Math.sin(angle);
    for (const [i, point] of poly.entries()) {
      const local = native[index][i];
      assert(Math.abs(point.x - (weapon.x + c * local.x - s * local.y)) < 1e-10);
      assert(Math.abs(point.y - (weapon.y + s * local.x + c * local.y)) < 1e-10);
    }
    const center = poly.reduce((p, q) => ({ x: p.x + q.x / poly.length, y: p.y + q.y / poly.length }), { x: 0, y: 0 });
    assert(weaponContains(weapon, center, 0, weapon.barrelAngle));
  }
  assert.throws(() => installedWeaponShapes({ ...weapon, materialPolygons: undefined }), /nativa/);
});

for (const facing of [-1, 1]) test(`cold scene readmission preserves port, owners, mass and mounting at facing ${facing}`, t => {
  const source = createStructuredTemplate('heavy'), world = new World(source);
  t.after(() => world.dispose());
  const localGrid = structuredClone(world.plates.find(p => p.id === 'hull:front').ballisticGrid),
    localMass = world.modules.find(m => m.id === 'weapon').physicalMass;
  world.game();
  world.addActor(source, { id: 'other', ownerId: 'other', x: 45, facing });
  const snapshot = world.snapshot(), weapon = snapshot.modules.find(m => m.actorId === 'other' && m.kind === 'weapon'),
    host = snapshot.plates.find(p => p.id === weapon.weaponMount.hostId), state = physics(world);
  assert(host); assert.equal(weapon.physicalMass, localMass);
  assert.deepEqual(snapshot.plates.find(p => p.id === 'hull:front').ballisticGrid, localGrid);
  assert.equal(state.bodies, 2);
  const ownHandles = new Set([...world.plates, ...world.modules].filter(p => p.actorId === 'other').map(p => world.game().handle(p))),
    owners = state.owners.filter(owner => ownHandles.has(owner.owner));
  assert.equal(owners.length, ownHandles.size); assert.equal(new Set(owners.map(owner => owner.body)).size, 1);
  assert(weapon.weaponMount.walls.every(wall => snapshot.plates.some(p => p.id === wall.wallId)));
  assertMountProjection(weapon);
  const values = bodies => bodies.map(body => [body.actor, body.mass, body.inertia, body.centerX, body.centerY]).sort((a, b) => a[0] - b[0]),
    before = values(state.bodyStates);
  world.addActor(source, { id: 'third', ownerId: 'third', x: 75 });
  assert.deepEqual(values(physics(world).bodyStates.filter(body => body.actor !== world.game().actorHandles.get('third'))), before);
});

test('invalid free weapon poses are rejected without changing the authored document', () => {
  for (const change of [{ x: 'left' }, { y: null }, { angle: Infinity }]) {
    const source = structuredTemplateSource('heavy'), weapon = source.components.find(p => p.kind === 'weapon');
    Object.assign(weapon.pose, change);
    const before = structuredClone(source);
    assert.throws(() => validateBlueprint(source));
    assert.deepEqual(source, before);
  }
});
