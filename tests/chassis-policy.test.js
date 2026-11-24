import test from 'node:test';
import assert from 'node:assert/strict';
import { CHASSIS_MODELS, chassisSpec, chassisLengthRange, chassisGearSize, chassisAxles, chassisFront, chassisRear, chassisTrack,
  frameThicknessMm, frameThicknessRange, gearProblem, roadWheelPitch, axleSpacing,
  straightChassis, suspensionHeight, withAxle, withFrameThickness, withGearScale, withGearWritten, withChassisMetal, writtenTrack } from '../src/chassis.ts';
import { withChassisPoint, withChassisModel, withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';
import { cellOf } from '../src/grid.ts';

// Chassis points and axles use 5 cm authoring units; physical track coordinates may use fractional units.
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} != ${b}`);
const chassis = (model, length = chassisSpec(model).length[1]) => straightChassis(model, cellOf(-length / 2), cellOf(length / 2));

test('only the three running kinds exist within the construction envelope', () => {
  assert.deepEqual(Object.keys(CHASSIS_MODELS), ['wheeled', 'tracked', 'aircraft']);
  for (const [model, spec] of Object.entries(CHASSIS_MODELS)) {
    assert.deepEqual(chassisLengthRange(model), [spec.length[0], 12]);
    assert.equal(spec.limitKg, undefined, 'capacity is a compiler result, not a type rating');
  }
  assert.equal(chassisSpec('wheeled-heavy'), undefined);
  assert.equal(chassisSpec('tracked-light'), undefined);
});

test('default gauge and scale stay omitted while a height edit captures the current track, including metal round trips', () => {
  for (const model of Object.keys(CHASSIS_MODELS)) {
    const original = chassis(model);
    assert.deepEqual(withGearScale(original, 1), model === 'tracked' ? withGearWritten(original) : original);
    assert.deepEqual(withFrameThickness(original, frameThicknessMm({ model })), original);
    for (const metal of ['aluminum', 'titanium']) {
      const changed = withChassisMetal(original, metal);
      assert.equal(frameThicknessMm(changed), frameThicknessMm({ model }), 'metal edits keep real millimetres');
      assert.deepEqual(withChassisMetal(changed, 'steel'), original);
    }
  }
  const thin = withFrameThickness(chassis('wheeled', 6), 5), alloy = withChassisMetal(thin, 'aluminum');
  assert.equal(alloy.thicknessMm, 5);
  assert.deepEqual(gearProblem(alloy), { code: 'FIELD', model: 'wheeled', field: 'thicknessMm' }, 'a material minimum is refused instead of silently thickening');
});

test('uniform tyres control size and spacing without accepting mixed running gear', () => {
  const ordinary = { ...chassis('wheeled'), axles: [-100, 100] }, larger = withGearScale(ordinary, 1.5), size = chassisGearSize(larger), axles = chassisAxles(larger);
  near(size, 1.65); near(axleSpacing(larger.model, larger), size + .1);
  assert.deepEqual(axles, chassisAxles(ordinary), 'a size edit keeps both axle centres');
  assert.equal(gearProblem(larger), null);
  for (const [i, x] of axles.entries()) {
    assert(x >= chassisFront(larger) + size / 2 && x <= chassisRear(larger) - size / 2);
    if (i) assert(x - axles[i - 1] >= size + .1);
  }
  assert.deepEqual(gearProblem({ ...larger, track: { front: -40, rear: 40 } }), { code: 'CHASSIS_GEAR_KIND', model: 'wheeled' });
  for (const invalid of [0, .49, 1.51, NaN, Infinity, null, [1, 1.2]]) assert.deepEqual(gearProblem({ ...ordinary, gearScale: invalid }), { code: 'FIELD', model: 'wheeled', field: 'gearScale' });
});

test('the shortest chassis of each kind fits its own running gear where the model puts it', () => {
  assert.deepEqual(chassisLengthRange('wheeled'), [2.5, 12]); assert.deepEqual(chassisLengthRange('tracked'), [3, 12]);
  for (const scale of [.5, 1, 1.5]) {
    const short = { ...chassis('wheeled', 2.5), gearScale: scale }, axles = chassisAxles(short), half = chassisGearSize(short) / 2;
    assert(axles[0] >= chassisFront(short) + half - 1e-9 && axles.at(-1) <= chassisRear(short) - half + 1e-9, 'each wheel whole under the frame');
    if (gearProblem(short)) assert(axles[1] - axles[0] < axleSpacing('wheeled', short), 'refused only where the wheels cannot stand apart');
    else assert(axles[1] - axles[0] >= axleSpacing('wheeled', short) - 1e-9);
  }
  const ordinary = chassis('wheeled', 2.5), axles = chassisAxles(ordinary);
  assert.equal(gearProblem(ordinary), null);
  assert(axles[0] - chassisFront(ordinary) < chassisSpec('wheeled').overhang[0], 'the axles move nearer the ends than on a longer frame');
  near(chassisAxles(chassis('wheeled', 6))[0] + 3, chassisSpec('wheeled').overhang[0]);
  for (const scale of [.5, 1]) {
    const track = { ...chassis('tracked', 3), gearScale: scale };
    assert.equal(gearProblem(track), null); assert(chassisTrack(track).wheels >= 3);
  }
});

test('larger tyres retain all eight authored axle centres even when they no longer fit', () => {
  const ordinary = { ...chassis('wheeled'), axles: Array.from({ length: 8 }, (_, i) => cellOf(-5.45 + i * 10.9 / 7)) },
    larger = withGearScale(ordinary, 1.25), impossible = withGearScale(ordinary, 1.5);
  assert.equal(chassisAxles(larger).length, 8); assert.deepEqual(gearProblem(larger), { code: 'AXLE_EXTENT', model: 'wheeled' });
  assert.deepEqual(larger.axles, ordinary.axles);
  assert.equal(chassisAxles(impossible).length, 8); assert(gearProblem(impossible));
  assert.deepEqual(impossible.axles, ordinary.axles);
  assert.equal(ordinary.gearScale, undefined);
});

test('changing track height keeps both physical ends and its belt on the floor', () => {
  const base = chassis('tracked'), ordinary = { ...base, track: writtenTrack(base, -1, 3) }, before = chassisTrack(ordinary);
  for (const scale of [.75, 1.25, 1.5]) {
    const larger = withGearScale(ordinary, scale), after = chassisTrack(larger);
    near(after.front, before.front); near(after.rear, before.rear); near(after.y - after.height / 2, before.y - before.height / 2);
    near(after.height, before.height * scale);
    near(roadWheelPitch(larger.model, larger), roadWheelPitch(larger.model) * scale);
    assert.deepEqual([larger.track.front, larger.track.rear], [ordinary.track.front, ordinary.track.rear]); assert.equal(gearProblem(larger), null);
    assert.deepEqual(gearProblem({ ...larger, axles: [-40, 40] }), { code: 'CHASSIS_GEAR_KIND', model: 'tracked' });
  }
  const noRoom = { ...ordinary, track: writtenTrack(ordinary, 3, 7) }, refused = withGearScale(noRoom, 1.5);
  assert.deepEqual([refused.track.front, refused.track.rear], [noRoom.track.front, noRoom.track.rear]); assert.equal(refused.track.front, 60);
  assert.deepEqual(gearProblem(refused), { code: 'TRACK_EXTENT', model: 'tracked' });
});

test('changing an end preserves authored and previously implicit supports', () => {
  const wheelSource = { chassis: chassis('wheeled', 6), components: [] },
    wheels = chassisAxles(wheelSource.chassis), extended = withChassisPoint(wheelSource, 1, { ...wheelSource.chassis.points[1], x: 120 });
  assert.deepEqual(chassisAxles(extended.chassis), wheels, 'extending the frame does not move existing axles');
  const shorter = withChassisPoint(wheelSource, 0, { ...wheelSource.chassis.points[0], x: -20 });
  assert.deepEqual(chassisAxles(shorter.chassis), wheels, 'shortening also preserves existing axles');
  assert.deepEqual(gearProblem(shorter.chassis), { code: 'AXLE_EXTENT', model: 'wheeled' });
  assert.equal(withChassisPoint(wheelSource, 0, wheelSource.chassis.points[0]), wheelSource, 'an unmoved grip does not materialize defaults');
  const trackSource = { chassis: chassis('tracked', 6), components: [] },
    track = chassisTrack(trackSource.chassis), longer = withChassisPoint(trackSource, 1, { ...trackSource.chassis.points[1], x: 120 });
  assert.deepEqual(chassisTrack(longer.chassis), track, 'extending the frame does not grow the existing track');
  const impossible = withChassisPoint(trackSource, 1, { ...trackSource.chassis.points[1], x: 32 });
  assert.deepEqual(chassisTrack(impossible.chassis), track);
  assert.deepEqual(gearProblem(impossible.chassis), { code: 'TRACK_EXTENT', model: 'tracked' });
});

test('changing kind preserves physical millimetres and dimensions without silent clamps', () => {
  const original = { name: 'Projeto', nodes: [], chassis: { ...chassis('tracked', 6), armorMm: 60 }, components: [] }, changed = withChassisModel(original, 'wheeled');
  assert.equal(withChassisModel(original, 'tracked'), original);
  assert.equal(changed.chassis.thicknessMm, 20, 'an omitted gauge does not become the thinner destination default');
  assert.equal(changed.chassis.armorMm, 60, 'the compiler decides whether armour is admitted');
  assert.equal(changed.chassis.points[0].x, original.chassis.points[0].x); assert.equal(changed.chassis.points.at(-1).x, original.chassis.points.at(-1).x);
  const short = { nodes: [], chassis: chassis('wheeled', 3.5), components: [] }, switched = withChassisModel(short, 'tracked');
  assert.equal(switched.chassis.points.at(-1).x - switched.chassis.points[0].x, 70); assert.equal(switched.chassis.thicknessMm, 8);
  const withAxles = { ...short, chassis: { ...short.chassis, axles: [-20, 20] } };
  assert.equal(withChassisModel(withAxles, 'tracked').chassis.axles, undefined);
  const withTrack = { ...original, chassis: { ...original.chassis, track: writtenTrack(original.chassis, -1, 3) } };
  assert.equal(withChassisModel(withTrack, 'wheeled').chassis.track, undefined);
});

test('gauge bounds describe the one real section for each running kind', () => {
  const ordinary = chassis('wheeled');
  assert.deepEqual(frameThicknessRange(ordinary), { min: 5, max: 125 });
  assert.deepEqual(frameThicknessRange(chassis('tracked')), { min: 5, max: 200 });
  for (const invalid of [0, 4.9, 125.1, NaN, Infinity, null]) assert.deepEqual(gearProblem({ ...ordinary, thicknessMm: invalid }), { code: 'FIELD', model: 'wheeled', field: 'thicknessMm' });
});

test('gear size edits on tracks and on wheels preserve suspension height, the gear on the floor and the hull lifted with it', () => {
  const source = { name: 'Projeto', nodes: [{ id: 'n', x: 0, y: 10 }], chassis: chassis('tracked'),
    components: [{ id: 'load', kind: 'hopper', pose: { x: 28, y: 20, angle: 0 } }] };
  const scaled = withChassisGearScale(source, 1.2), thick = withChassisThickness(source, 30);
  const before = chassisTrack(source.chassis), after = chassisTrack(scaled.chassis);
  near(after.front, before.front); near(after.rear, before.rear); near(after.y - after.height / 2, before.y - before.height / 2);
  near(after.height, before.height * 1.2);
  assert.equal(thick.components, source.components);
  assert.equal(scaled.chassis.gearScale, 1.2); assert.equal(thick.chassis.thicknessMm, 30);
  assert.equal(source.chassis.gearScale, undefined); assert.equal(source.chassis.thicknessMm, undefined);
  for (const [larger, from] of [[scaled, source], [withChassisGearScale({ ...source, chassis: chassis('wheeled') }, 1.2), { ...source, chassis: chassis('wheeled') }]]) {
    const lift = larger.chassis.points[0].y - from.chassis.points[0].y;
    assert(Number.isInteger(lift) && lift > 1, `${from.chassis.model}: ${lift}`);
    assert.equal(suspensionHeight(larger.chassis), suspensionHeight(from.chassis));
    assert.deepEqual(larger.components, [{ id: 'load', kind: 'hopper', pose: { x: 28, y: 20 + lift, angle: 0 } }]);
    assert.deepEqual(larger.nodes, [{ id: 'n', x: 0, y: 10 + lift }]);
  }
});

test('axles can move beneath arches and gaps while spacing and frame-end bounds still apply', () => {
  const source = { ...chassis('wheeled', 6), points: [
    { x: -60, y: -8 }, { x: -30, y: -8 }, { x: -10, y: 8, gap: true },
    { x: 10, y: 8 }, { x: 30, y: -8 }, { x: 60, y: -8 }], axles: [-40, 40] };
  const underArch = withAxle(source, 0, -.5);
  assert.deepEqual(underArch.axles, [-10, 40]);
  assert.equal(gearProblem(underArch), null, 'the profile above an axle does not choose its horizontal position');
  assert.equal(gearProblem({ ...source, axles: [-10, 10] }).code, 'AXLE_SPACING');
  assert.equal(gearProblem({ ...source, axles: [-60, 40] }).code, 'AXLE_EXTENT');
  const fractional = { ...source, axles: [-10.5, 40] };
  assert.equal(gearProblem(fractional), null, 'free authored positions do not impose the optional 5 cm grid');
  assert.deepEqual(chassisAxles(fractional), [-.525, 2]);
});
