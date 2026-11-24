import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredPlacementIntent } from '../src/structured-construction.ts';
import { structuredComponent, withPieceProperty, componentFaceSnap } from '../src/structured-editing.ts';
import { componentPolygon } from '../src/assembly.ts';
import { localToWorld } from '../src/math.ts';
import { sensorChoices, mountChoices, pieceSettings } from '../src/piece-settings.ts';
import { chassisAxles, chassisTrack, gearProblem, straightChassis, withAxle, withTrackEnd } from '../src/chassis.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
// A gun's settings ask the core what it may be made into (weapons.ts `weaponOptions`).
await initNativeDynamics();

test('cursor placement uses one local pose for exposed and enclosed components', () => {
  for (const kind of ['engine', 'command', 'sensor', 'fuel', 'hopper', 'excavator', 'drill', 'builder', 'blade', 'paver']) {
    const part = structuredComponent(kind, { mirrored: false }), before = structuredClone(part);
    // On the cell nearest to the cursor, from the reference of the construction (grid.ts).
    assert.deepEqual(structuredPlacementIntent(part, { x: 10.73, y: .46 }), { x: -25, y: -17, angle: 0 }, kind);
    assert.deepEqual(part, before, 'a cursor never mutates the component');
  }
  assert.throws(() => structuredPlacementIntent(structuredComponent('engine'), { x: NaN, y: 1 }), /Posição inválida/);
});

test('cursor movement preserves authored rotation and reflection without selecting a support', () => {
  const part = structuredComponent('paver', { angle: .37, mirrored: true });
  assert.deepEqual(structuredPlacementIntent(part, { x: 13.2, y: -.5 }), { x: 24, y: -36, angle: .37, mirrored: true });
  assert.equal(Object.hasOwn(part, 'placement'), false);
});

test('nearby face assistance preserves an inclined component and the exact off-grid contact', () => {
  const plate = { x: 12, y: 1.3, angle: 0, length: 4, thicknessMm: 5 },
    part = { kind: 'fuel', x: 12, y: 2, width: .4, height: .3, angle: .37 },
    top = plate.y + plate.thicknessMm / 2000,
    height = part.y - Math.min(...componentPolygon(part).map(point => point.y));
  part.y = top + height + .035;
  const before = structuredClone({ part, plate }), position = componentFaceSnap(part, [plate], .08);
  assert.equal(position.x, part.x);
  assert(Math.abs(position.y - part.y + .035) < 1e-12);
  assert(Math.abs(Math.min(...componentPolygon({ ...part, ...position }).map(point => point.y)) - top) < 1e-12);
  assert.deepEqual({ part, plate }, before, 'assistance never mutates geometry or settings');
  assert.deepEqual(componentFaceSnap(part, [plate], .02), { x: part.x, y: part.y });
  assert.deepEqual(componentFaceSnap({ ...part, y: part.y + 2 }, [plate], .08), { x: part.x, y: part.y + 2 });
});

test('nearby face assistance follows remaining material on an inclined plate and ignores its missing material', () => {
  const plate = { x: 12, y: 1.3, angle: .31, length: 4, thicknessMm: 5,
    ballisticGrid: { version: 1, nx: 4, ny: 2,
      bounds: { minX: -2, maxX: 2, minY: -.0025, maxY: .0025 }, bits: 'bb' } },
    part = { kind: 'fuel', width: .2, height: .2, angle: plate.angle },
    proposed = { ...part, ...localToWorld(plate, -.5, .16) },
    expected = localToWorld(plate, -.5, .1025),
    position = componentFaceSnap(proposed, [plate], .08);
  assert(Math.abs(position.x - expected.x) < 1e-12 && Math.abs(position.y - expected.y) < 1e-12);
  const hole = { ...part, ...localToWorld(plate, .5, .16) };
  assert.deepEqual(componentFaceSnap(hole, [plate], .08), { x: hole.x, y: hole.y });
  const extension = { ...part, ...localToWorld(plate, 2.3, .16) };
  assert.deepEqual(componentFaceSnap(extension, [plate], .08), { x: extension.x, y: extension.y });
});

test('nearby face assistance leaves disabled input, weapons and running gear completely free', () => {
  const plate = { x: 12, y: 1.3, angle: 0, length: 4, thicknessMm: 5 },
    part = { kind: 'fuel', x: 12, y: 1.44, width: .2, height: .2, angle: 0 }, point = { x: part.x, y: part.y };
  for (const tolerance of [0, -1, undefined, NaN]) assert.deepEqual(componentFaceSnap(part, [plate], tolerance), point);
  for (const kind of ['weapon', 'wheel', 'track']) assert.deepEqual(componentFaceSnap({ ...part, kind }, [plate], .08), point);
});

test('new directional loads and road tools face left unless the author chooses otherwise', () => {
  for (const kind of ['hopper', 'cistern', 'supply', 'blade', 'paver']) {
    assert.equal(structuredComponent(kind).pose.mirrored, true, kind);
    assert.equal(Object.hasOwn(structuredComponent(kind, { mirrored: false }).pose, 'mirrored'), false, kind);
  }
});

test('new weapons keep mount settings separate from their left-facing pose', () => {
  const part = structuredComponent('weapon', { weaponPreset: 'm2hb', mountPreset: 'pintle', sector: { min: -.2, max: .4 } });
  assert.deepEqual(part.pose, { x: 0, y: 0, angle: Math.PI });
  assert.deepEqual(part.mount, { preset: 'pintle', sector: { min: -.2, max: .4 } });
  assert.equal(Object.hasOwn(part.mount, 'hostId'), false);
});

test('switching to an exposed mount removes its inapplicable shield radius and keeps explicit pose and sector', () => {
  const part = { ...structuredComponent('weapon', { weaponPreset: 'm2hb', sector: { min: -.2, max: .3 } }),
    mount: { preset: 'light-trunnion', sector: { min: -.2, max: .3 }, radiusM: .23 } },
    source = { nodes: [], plates: [], components: [part] }, before = structuredClone(source),
    changed = withPieceProperty(source, part.id, 'mountPreset', 'pintle').components[0];
  assert.deepEqual(changed.mount, { preset: 'pintle', sector: part.mount.sector });
  assert.deepEqual(changed.pose, part.pose); assert.deepEqual(source, before);
  const sector = withPieceProperty(source, part.id, 'sectorMin', -.1).components[0];
  assert.deepEqual(sector.mount.sector, { min: -.1, max: .3 });
  assert.equal(sector.mount.radiusM, part.mount.radiusM);
});

test('component angle edits affect only the selected authored pose', () => {
  const first = structuredComponent('engine', {}, 'first'), second = structuredComponent('fuel', {}, 'second'),
    source = { nodes: [], plates: [], components: [first, second] }, before = structuredClone(source),
    changed = withPieceProperty(source, 'first', 'angle', -.4);
  assert.equal(changed.components[0].pose.angle, -.4);
  assert.deepEqual(changed.components[1], before.components[1]);
  assert.deepEqual(source, before);
});

test('inclining a plate detaches its endpoints from unselected neighbours', () => {
  const source = { nodes: [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 20, y: 0 }, { id: 'c', x: 20, y: 20 }],
    plates: [{ id: 'one', a: 'a', b: 'b', material: 'steel', thicknessMm: 8 },
      { id: 'two', a: 'b', b: 'c', material: 'steel', thicknessMm: 8 }], components: [] },
    before = structuredClone(source), changed = withPieceProperty(source, 'one', 'angle', Math.PI / 2);
  assert.deepEqual(changed.plates.find(plate => plate.id === 'two'), before.plates[1]);
  for (const id of ['b', 'c']) assert.deepEqual(changed.nodes.find(node => node.id === id), before.nodes.find(node => node.id === id));
  const own = changed.plates.find(plate => plate.id === 'one'), a = changed.nodes.find(node => node.id === own.a), b = changed.nodes.find(node => node.id === own.b);
  assert.deepEqual([a.x, a.y, b.x, b.y], [10, -10, 10, 10]);
  assert.deepEqual(source, before);
});

test('the angle inspector edits authored orientation even when a weapon is reflected', () => {
  const weapon = structuredComponent('weapon', { weaponPreset: 'm2hb', angle: .3, mirrored: true }),
    angle = pieceSettings({ kind: 'weapon', angle: .3 + Math.PI }, weapon).find(setting => setting.key === 'angle');
  assert(Math.abs(angle.value - .3 * 180 / Math.PI) < 1e-6);
  assert.deepEqual([angle.min, angle.max, angle.step, angle.fine], [-180, 180, 5, .01]);
});

test('sensor and compatible mount catalogues do not probe the current placement', () => {
  const unusable = new Proxy({}, { get() { throw new Error('unexpected support query'); } });
  assert(sensorChoices(unusable, unusable).length > 1);
  const mounts = mountChoices('m2hb', unusable, unusable);
  assert(mounts.some(choice => choice.id === 'pintle'));
  assert(mounts.some(choice => choice.id === 'light-trunnion'));
});

test('an axle crosses arches and gaps while preserving wheel extents and spacing', () => {
  const chassis = { ...straightChassis('wheeled', -60, 60),
    points: [{ x: -60, y: -8 }, { x: -20, y: 8, gap: true }, { x: 20, y: 8 }, { x: 60, y: -8 }], axles: [-44, 44] },
    moved = withAxle(chassis, 0, .5);
  assert.equal(chassisAxles(moved)[0], .5);
  assert.equal(gearProblem(moved), null);
  assert.deepEqual(moved.points, chassis.points);
  assert.equal(gearProblem({ ...moved, axles: [10, 20] }).code, 'AXLE_SPACING');
  assert.equal(gearProblem({ ...moved, axles: [-60, 44] }).code, 'AXLE_EXTENT');
});

test('a track may span a raised profile without acquiring another running level', () => {
  const chassis = { ...straightChassis('tracked', -80, 80),
    points: [{ x: -80, y: -9 }, { x: -20, y: 4 }, { x: 20, y: 4 }, { x: 80, y: -9 }] },
    changed = withTrackEnd(chassis, 'front', -1.5);
  assert.equal(gearProblem(chassis), null);
  assert.equal(gearProblem(changed), null);
  assert(chassisTrack(changed).front > chassisTrack(chassis).front);
  assert.deepEqual(changed.points, chassis.points);
});
