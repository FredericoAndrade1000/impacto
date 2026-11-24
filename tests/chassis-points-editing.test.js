import { DESIGN_VERSION } from '../src/design-contract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { chassisAxles } from '../src/chassis.ts';
import { stretchKey, vertexKey } from '../src/frame-points.ts';
import { CHASSIS_ID, FIXED, bedStretchAt, chassisPointRange, bedStretches, withChassisGap, withChassisPoint,
  withChassisPointAdded, withChassisPointRemoved, withConstructionKind } from '../src/chassis-editing.ts';
import { metresOf } from '../src/grid.ts';

// The editing of the points of a chassis is written in JSON and read from projections: neither asks the compiler, so
// these are made by hand, in the shapes the compiler gives (format 8): the design in cells of 5 cm (grid.ts), the
// projection in metres in the field.
const points = (...at) => at.map(([x, y = 0, gap]) => ({ x, y, ...(gap ? { gap: true } : {}) }));
const design = (chassis, components = []) => ({ version: DESIGN_VERSION, preset: 'vehicle', nodes: [], plates: [], components,
  chassis: { model: 'wheeled', ...chassis } });
const hopper = () => ({ id: 'hopper', kind: 'hopper', pose: { x: 30, y: 2, angle: 0 } });
const blade = () => ({ id: 'blade', kind: 'blade', pose: { x: 0, y: -12, angle: 0 } });
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-9, `${actual} ≠ ${expected}`);

test('reshaping only the chassis keeps equipment poses and running supports unchanged', () => {
  const source = design({ points: points([-60], [0], [60]) }, [hopper(), blade()]), axles = chassisAxles(source.chassis),
    snapshot = structuredClone(source), moved = withChassisPoint(source, 1, { x: 40, y: 6 });
  assert.equal(CHASSIS_ID, 'chassis:frame-0');
  assert.deepEqual(moved.chassis.points, points([-60], [40, 6], [60]));
  assert.deepEqual(moved.components, source.components);
  // Writing implicit gear makes it explicit without shifting its actual supports onto the optional grid.
  chassisAxles(moved.chassis).forEach((x, i) => near(x, axles[i]));
  const longer = withChassisPoint(source, 2, { x: 80, y: 0 });
  assert.deepEqual(longer.components, source.components);
  assert.equal(withChassisPoint(source, 1, { x: 0, y: 0 }), source);
  assert.equal(withChassisPoint(source, 5, { x: 20, y: 0 }), source);
  assert.deepEqual(source, snapshot);
});

test('explicit point insertion/removal and gaps never rewrite component authoring', () => {
  const source = design({ points: points([-60], [0, 8], [60]) }, [hopper()]), added = withChassisPointAdded(source, 30);
  assert.deepEqual(added.chassis.points.filter(point => point.x !== 30), source.chassis.points);
  assert.equal(added.chassis.points[2].x, 30); assert.equal(added.chassis.points[2].y, 4);
  assert.deepEqual(added.components, source.components);
  const removed = withChassisPointRemoved(added, 1);
  assert.deepEqual(removed.chassis.points, [source.chassis.points[0], added.chassis.points[2], source.chassis.points[2]]);
  assert.deepEqual(removed.components, source.components);
  assert.equal(withChassisPointRemoved(source, 0), source); assert.equal(withChassisPointRemoved(source, 2), source);
  const opening = design({ points: points([-60], [-20], [20], [60]) }, [hopper()]), gapped = withChassisGap(opening, 1, true);
  assert.deepEqual(gapped.chassis.points, points([-60], [-20, 0, true], [20], [60]));
  assert.deepEqual(gapped.components, opening.components);
  assert.equal(withChassisGap(gapped, 1, true), gapped);
  assert.deepEqual(withChassisGap(gapped, 1, false).chassis.points, opening.chassis.points);
  assert.deepEqual(withChassisPointRemoved(gapped, 2).chassis.points, points([-60], [-20, 0, true], [60]));
});

test('a point goes along the design no nearer the points beside it than two cells, and an end as long as the model is made', () => {
  const source = design({ points: points([-54], [0, 6], [54]) });
  // Up and down, the construction box: from the floor to 8 m over it, in cells.
  const box = { minY: -26, maxY: 134 }, height = { minY: 'below', maxY: 'above' };
  assert.deepEqual(chassisPointRange(source, 1), { minX: -52, maxX: 52, ...box, held: { minX: 'order', maxX: 'order', ...height } });
  // The front end: the limit of construction ahead, the point after it behind.
  assert.deepEqual(chassisPointRange(source, 0), { minX: -120, maxX: -2, ...box, held: { minX: 'reach', maxX: 'order', ...height } });
  // On two points, the ends are held by the lengths the model is made in, 2.5 to 12 m.
  const straight = design({ points: points([-54], [54]) });
  assert.deepEqual(chassisPointRange(straight, 0), { minX: -120, maxX: 4, ...box, held: { minX: 'reach', maxX: 'length', ...height } });
  assert.deepEqual(chassisPointRange(straight, 1), { minX: -4, maxX: 120, ...box, held: { minX: 'length', maxX: 'reach', ...height } });
  const far = design({ points: points([-120], [100]) });
  assert.deepEqual(chassisPointRange(far, 1).maxX, 120);
  assert.deepEqual(chassisPointRange(design({ points: points([-120], [-20], [100]) }), 2), { minX: -18, maxX: 120, ...box,
    held: { minX: 'order', maxX: 'reach', ...height } });
});

test('a fixed construction put on a chassis gets a straight one, of two points', () => {
  const fixed = { version: DESIGN_VERSION, preset: 'bunker', components: [], plates: [],
    nodes: [{ id: 'a', x: -40, y: 0 }, { id: 'b', x: 40, y: 0 }, { id: 'c', x: 0, y: 20 }] };
  // Where its model hangs its gear: the first cell over its deck of 0.86 m.
  assert.deepEqual(withConstructionKind(fixed, 'tracked').chassis, { model: 'tracked', points: points([-40, -8], [40, -8]) });
  assert.equal(withConstructionKind(withConstructionKind(fixed, 'wheeled'), FIXED).chassis, undefined);
});

test('a chassis point stands in the same box as the plates, which neither the plates nor the other points move', () => {
  const source = design({ points: points([-60, -20], [0, 0], [60, 0]) }, [hopper()]);
  source.nodes = [{ id: 'a', x: -20, y: 134 }, { id: 'b', x: 20, y: 134 }];
  source.components[0].pose.y = 400;
  const snapshot = structuredClone(source), first = chassisPointRange(source, 0), middle = chassisPointRange(source, 1);
  assert.deepEqual([first.minY, first.maxY], [-26, 134]);
  assert.deepEqual([middle.minY, middle.maxY], [-26, 134]);
  assert.deepEqual(source, snapshot);
});

// A projection of a hull on a chassis of four points, as the compiler gives it: the deck at 1.05 m, a floor 12 mm
// thick on it (its nodes 6 mm higher), a frame 8 mm thick and 0.22 m deep. Its first stretch is level on the deck, the
// second rises, the third is level 0.4 m up.
function projection() {
  const origin = { x: 12, y: 1.3 }, deck = 1.05, bed = (id, x0, x1, rise, free) => ({ id, owner: 8,
    a: { x: x1, y: deck - .004 + rise }, b: { x: x0, y: deck - .004 + rise }, normal: { x: 0, y: 1 }, length: x1 - x0,
    material: 'steel', thicknessMm: 8, free });
  return { frame: { origin, nodes: [{ id: 'hull-0', x: 9.3, y: origin.y }, { id: 'hull-1', x: 11, y: origin.y }, { id: 'hull-2', x: 10, y: origin.y + 1 }],
    plates: [{ id: 'hull:floor', a: 'hull-0', b: 'hull-1' }, { id: 'hull:rear', a: 'hull-1', b: 'hull-2' }, { id: 'hull:front', a: 'hull-2', b: 'hull-0' }] },
    plates: [{ id: 'hull:floor', material: 'steel', thicknessMm: 12 }, { id: 'hull:rear', material: 'steel', thicknessMm: 15 },
      { id: 'hull:front', material: 'steel', thicknessMm: 15 }],
    chassis: { model: 'wheeled', kind: 'wheeled', front: 9.3, rear: 15.3, length: 6, deck, depth: .22 },
    beds: [bed('chassis:frame-0', 9.3, 12, 0, [[11, 12]]), { ...bed('chassis:frame-1', 12, 13, .2), a: { x: 13, y: deck - .004 + .4 } },
      bed('chassis:frame-2', 13, 15.3, .4, [[13, 15.3]])] };
}
const source = () => design({ points: points([-54, -5], [0, -5], [20, 3], [66, 3]) });

test('the free stretches are those of the level beds, each at the height of the nodes resting on it', () => {
  assert.deepEqual(bedStretches(projection()).map(({ id, x0, x1, y }) => [id, x0, x1, Number(y.toFixed(4))]),
    [['chassis:frame-0', 9.3, 12, 1.05], ['chassis:frame-2', 13, 15.3, 1.45]]);
  // Out of the bed on the deck a room stands joined to the hull, and runs to the end of the bed.
  const low = bedStretchAt(projection(), { x: 11.5, y: 1.05 });
  assert.deepEqual([low.id, low.a, low.b, low.length, low.material, low.thicknessMm],
    ['chassis:frame-0', { x: 12, y: 1.056 }, { x: 9.3, y: 1.056 }, 2.7, 'steel', 12]);
  // The bed up there reaches no hull: no room is drawn out of it.
  assert(bedStretchAt(projection(), { x: 14, y: 1.45 }), 'a separate free bed is available without a hull connection');
  assert.equal(bedStretchAt(projection(), { x: 11.5, y: 1.4 }), null, 'over a bed is not on it');
});

test('level bed spans retain their fractional physical ends before the drawing gesture chooses snap', () => {
  const compiled = projection(), bed = compiled.beds[0];
  bed.b.x = 9.313; bed.a.x = 11.987; bed.length = bed.a.x - bed.b.x;
  const span = bedStretches(compiled).find(span => span.id === bed.id);
  assert.equal(span.x0, bed.b.x); assert.equal(span.x1, bed.a.x);
  assert.equal(span.y, 1.05);
});

// The outline of each part of the chassis of `source` between gaps, in the field from the origin of `compiled`, as the
// compiler gives it (game_chassis.rs `outlines`): its top, then back along its foot, `depth` under each point square to
// the stretch it ends, or on the line the two stretches either side of it meet on.
function outlined(source, compiled) {
  const { origin } = compiled.frame, depth = compiled.chassis.depth, parts = [[]];
  for (const p of source.chassis.points) { parts.at(-1).push({ x: origin.x + metresOf(p.x), y: origin.y + metresOf(p.y) }); if (p.gap) parts.push([]); }
  const down = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; };
  const outlines = parts.map(points => [...points, ...points.map((p, j) => {
    const a = j > 0 && down(points[j - 1], p), b = j < points.length - 1 && down(p, points[j + 1]),
      way = !a || !b ? a || b : { x: (a.x + b.x) / (1 + a.x * b.x + a.y * b.y), y: (a.y + b.y) / (1 + a.x * b.x + a.y * b.y) };
    return { x: p.x + way.x * depth, y: p.y + way.y * depth };
  }).reverse()]);
  return { ...compiled, chassis: { ...compiled.chassis, outlines } };
}
// An editor of `source` over a projection made by hand: the compiler is not asked.
function drawn(source, compiled) {
  const editor = Object.create(Editor.prototype);
  if (!compiled.chassis.outlines) compiled = outlined(source, compiled);
  editor.document = { key: 'document', projectId: 'design', blueprint: source };
  editor.compiled = { source, value: compiled };
  editor.snap = true;
  editor.selectionIds = new Set([CHASSIS_ID]);
  return editor;
}

test('the points are taken halfway down the frame under each, the nearest, and only an inner stretch may be a gap', () => {
  const editor = drawn(source(), projection()), grips = editor.chassisPoints(), drop = .22 / 2,
    // At each knee of the stretch that rises .4 over a metre, on the line the two stretches meet on.
    aside = drop * Math.tan(Math.atan(.4) / 2);
  assert.deepEqual(grips.map(({ index, end }) => [index, end]), [[0, 'front'], [1, null], [2, null], [3, 'rear']]);
  for (const [grip, x] of [[grips[0], 9.3], [grips[1], 12 + aside], [grips[2], 13 + aside], [grips[3], 15.3]]) near(grip.x, x);
  near(grips[0].y, 1.05 - drop); near(grips[2].y, 1.45 - drop);
  assert.equal(grips[2].top.x, 13); near(grips[2].top.y, 1.45);
  near(grips[2].foot.x, 13 + 2 * aside); near(grips[2].foot.y, 1.45 - 2 * drop);
  const taken = editor.pickChassisPoint({ x: grips[1].x + .03, y: grips[1].y + .02 }, .1);
  assert.deepEqual([taken.kind, taken.index, taken.key, taken.x, taken.y], ['vertex', 1, vertexKey(1), grips[1].x, grips[1].y]);
  assert.equal(editor.pickChassisPoint({ x: 12.5, y: grips[1].y }, .1), null, 'between two points, none');
  assert.equal(editor.pickPoint({ x: grips[1].x, y: grips[1].y }, .1).key, vertexKey(1), 'no node is nearer');
  // Only a stretch between two others may be a gap: the one that rises.
  assert.deepEqual(editor.chassisGaps().map(({ index, gap, a, b }) => [index, gap, a.x, b.x]), [[1, false, 12, 13]]);
  assert.equal(drawn(design({ points: points([-2.7], [2.7]) }), projection()).chassisGaps().length, 0, 'a straight chassis has none');
});

test('a horizontal chassis drag keeps the authored height of the point', () => {
  const editor = drawn(source(), projection()), handle = editor.pickChassisPoint(editor.chassisPoints()[1], 1e-6);
  editor.reach = (before, from, to, propose) => ({ next: propose(to) });
  assert(editor.moveChassisPoint(handle, { x: handle.x + .2, y: handle.y }));
  assert.equal(editor.source.chassis.points[1].x, 4);
  assert.equal(editor.source.chassis.points[1].y, -5);
});

test('horizontal point edits retain the exact untouched coordinate at a resting metal boundary', () => {
  const y = -3, before = design({ points: points([-60, y], [0, y], [60, y]) }),
    moved = withChassisPoint(before, 1, { x: 4, y });
  assert.equal(moved.chassis.points[1].y, y);
  assert(withChassisPointAdded(before, 30).chassis.points.every(point => point.y === y));
  const editor = drawn(before, projection()), handle = editor.pickChassisPoint(editor.chassisPoints()[1], 1e-6);
  editor.reach = (source, from, to, propose) => ({ next: propose(to) });
  assert(editor.moveChassisPoint(handle, { x: handle.x + .2, y: handle.y }));
  assert.equal(editor.source.chassis.points[1].y, y);
});

test('a vertical axle drag preserves its horizontal position', () => {
  const before = design({ points: points([-67, -8], [67, -8]), axles: [-51, 51] }),
    compiled = projection(), editor = drawn(before, compiled), handle = { grip: 'axle', index: 0, x: 9.45, y: .56, source: before };
  editor.root = { source: before, value: compiled };
  editor.reach = (source, from, to, propose) => ({ next: propose(to) });
  assert(editor.moveGear(handle, { x: handle.x, y: handle.y + .4 }));
  assert.deepEqual(chassisAxles(editor.source.chassis), chassisAxles(before.chassis));
});

test('a double click is on the frame from the top of the chassis to the foot of the frame, and never on a gap', () => {
  const editor = drawn(source(), projection());
  assert(editor.onChassisFrame({ x: 10, y: 1.0 }));
  assert(editor.onChassisFrame({ x: 12.5, y: 1.2 }), 'on the stretch that rises, halfway up it');
  assert(!editor.onChassisFrame({ x: 12.5, y: 1.0 }), 'under it');
  assert(editor.onChassisFrame({ x: 12.5, y: 1.0 }, .1), 'within the tolerance of its foot');
  assert(!editor.onChassisFrame({ x: 10, y: .7 }), 'below the frame, on the wheels');
  const gapped = drawn(design({ points: points([-54, -5], [0, -5, true], [20, 3], [66, 3]) }), projection());
  assert(gapped.onChassisFrame({ x: 10, y: 1.0 }));
  assert(!gapped.onChassisFrame({ x: 12.5, y: 1.2 }), 'the stretch that rises is a gap');
  assert.deepEqual(gapped.chassisStretch(1).map(({ x, y }) => [x, Number(y.toFixed(4))]), [[12, 1.05], [13, 1.45], [13, 1.23], [12, .83]]);
  // The first click of the two picks the stretch there, between the plates its frame is made of, as it is drawn; a gap
  // is picked where its frame would be.
  const bare = drawn(source(), { ...projection(), plates: [], modules: [] });
  assert.equal(bare.pick({ x: 10, y: 1.0 }), stretchKey(0));
  assert.equal(bare.pick({ x: 12.5, y: 1.2 }), stretchKey(1));
  assert.equal(bare.pick({ x: 12.5, y: .9 }), null, 'under the stretch that rises');
  assert.equal(drawn(gapped.source, { ...projection(), plates: [], modules: [] }).pick({ x: 12.5, y: 1.2 }), stretchKey(1), 'the gap');
});
