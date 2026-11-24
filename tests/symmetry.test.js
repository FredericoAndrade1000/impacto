import { DESIGN_VERSION } from '../src/design-contract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { nodeKey, stretchKey, vertexKey, samePlace } from '../src/frame-points.ts';
import { nodeAcross, plateAcross, vertexAcross, stretchAcross, untilAxis } from '../src/symmetry.ts';
import { metresOf, unitsOf } from '../src/grid.ts';

await initNativeDynamics();
const near = (actual, expected, why = '') => assert(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected} ${why}`);

// The pickup with the chassis arching over each wheel, made symmetric about the axis: written in cells of 5 cm
// (grid.ts), its chassis 25 cm under the reference and 5 cm under it over the wheels.
const LOW = -5, HIGH = -1, XS = [[66, LOW], [62, LOW], [56, HIGH], [32, HIGH], [26, LOW]];
const pickup = () => ({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Picape', nodes: [], plates: [],
  chassis: { model: 'wheeled', axles: [-44, 44], points: [...XS.map(([x, y]) => ({ x: -x, y })), ...XS.toReversed().map(([x, y]) => ({ x, y }))] },
  components: [{ id: 'engine', kind: 'engine', sizeScale: .86, pose: { x: -10, y: 2, angle: 0 } }] });
const symmetric = (source = pickup()) => { const editor = new Editor(source); editor.symmetric = true; return editor; };
// A point of the design, in metres from its reference, in the field; and the node written on a cell.
const field = (editor, point) => ({ x: point.x + editor.blueprint.frame.origin.x, y: point.y + editor.blueprint.frame.origin.y });
const nodeAt = (source, x, y) => source.nodes.find(node => node.x === x && node.y === y);
const nodeNear = (source, x, y) => source.nodes.find(node => Math.hypot(node.x - x, node.y - y) < 1e-10);
const total = edge => edge.points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - edge.points[i].x, point.y - edge.points[i].y), 0);

test('what stands across the axis is found by where it stands; what is on it is its own', () => {
  const editor = symmetric(), source = editor.source;
  assert.equal(vertexAcross(source, 0), 9); assert.equal(vertexAcross(source, 3), 6);
  assert.equal(stretchAcross(source, 1), 7); assert.equal(stretchAcross(source, 4), 4, 'the stretch over the axis is its own');
  editor.addPlate(field(editor, { x: -1, y: .5 }), field(editor, { x: 0, y: 1 }));
  const [left, right] = editor.source.plates, ridge = nodeAt(editor.source, 0, 20);
  assert.equal(plateAcross(editor.source, left.id), right.id); assert.equal(nodeAcross(editor.source, ridge.id), ridge.id);
  assert.equal(right.a === ridge.id || right.b === ridge.id, true, 'the plate made across meets this one on the axis');
  // A line from the left of the axis stops on it; one that does not reach it goes all the way.
  near(untilAxis([{ x: -2, y: 0 }, { x: 2, y: 0 }], 0, 4), 2); near(untilAxis([{ x: -2, y: 0 }, { x: 2, y: 0 }], 0, 1.5), 1.5);
});

test('a point of the chassis raised at the front raises the one at the rear too, in one step', () => {
  const editor = symmetric(), grip = editor.chassisPoints()[3];
  editor.begin(); assert(editor.moveChassisPoint(editor.pickChassisPoint(grip, .01), { x: grip.x, y: grip.y + .1 })); editor.commit();
  assert.equal(editor.source.chassis.points[3].y, HIGH + 2); assert.equal(editor.source.chassis.points[6].y, HIGH + 2);
  // Moved along, the one across goes the other way.
  const moved = editor.chassisPoints()[3];
  editor.begin(); assert(editor.moveChassisPoint(editor.pickChassisPoint(moved, .01), { x: moved.x - .1, y: moved.y })); editor.commit();
  assert.equal(editor.source.chassis.points[3].x, -34); assert.equal(editor.source.chassis.points[6].x, 34);
  assert.equal(editor.past.length, 2); assert(editor.undo()); assert(editor.undo());
  assert.deepEqual(editor.source.chassis.points, pickup().chassis.points);
  // Off, only the point taken moves.
  editor.symmetric = false; editor.begin(); editor.moveChassisPoint(editor.pickChassisPoint(grip, .01), { x: grip.x, y: grip.y + .1 }); editor.commit();
  assert.equal(editor.source.chassis.points[6].y, HIGH);
});

test('a point added to the chassis comes with one across, and goes with it', () => {
  const editor = symmetric(), grips = editor.chassisPoints();
  assert(editor.addChassisPoint({ x: field(editor, { x: -.7, y: 0 }).x, y: grips[4].y }));
  assert.deepEqual(editor.source.chassis.points.map(point => point.x).filter(x => Math.abs(x) < 20), [-14, 14]);
  assert.deepEqual([...editor.selectionIds], [vertexKey(5)], 'the point made is chosen, not the one across');
  assert(editor.removeChassisPoint(5)); assert.equal(editor.source.chassis.points.length, 10);
});

for (const snap of [false, true]) test(`the floor follows the chassis and joins its mirrored half on the axis with grid assistance ${snap ? 'on' : 'off'}`, () => {
  const editor = symmetric(); editor.snap = snap;
  const edge = editor.pickEdge(editor.chassisPoints()[0], .05);
  editor.begin(); const ids = editor.layPlates(edge, 0, total(edge)); editor.commit();
  const source = editor.source;
  assert.equal(ids.length, 5, 'the front half, up to the axis'); assert.equal(source.plates.length, 10);
  // Without assistance the plate's centre line follows the exact face; with it, the first clear grid row.
  const middle = nodeAt(source, 0, snap ? LOW + 1 : LOW + unitsOf(edge.offsets[4]));
  assert(middle);
  assert.equal(source.plates.filter(plate => plate.a === middle.id || plate.b === middle.id).length, 2, 'both halves end on one node on the axis');
  for (const id of ids) {
    const span = editor.plateSpans().find(span => span.id === id);
    assert(span.length >= .08 - 1e-12, 'following a bend never creates a plate below the physical minimum');
  }
  if (snap) assert(source.nodes.every(node => Number.isInteger(node.x) && Number.isInteger(node.y)));
  else {
    const first = source.nodes.find(node => node.id === source.plates[0].a), origin = editor.blueprint.frame.origin;
    near(origin.y + metresOf(first.y) - edge.points[0].y, edge.offsets[0], 'the floor is on the chassis face');
    assert(source.nodes.some(node => !Number.isInteger(node.x)), 'sloping bends keep their continuous intersections');
  }
  for (const plate of source.plates) assert.notEqual(plateAcross(source, plate.id), null);
  assert.equal(editor.past.length, 1);
});

test('a plate drawn, and a node made on it, are made across too; removed, both go', () => {
  const editor = symmetric();
  assert.equal(editor.snap, true);
  editor.addPlate(field(editor, { x: -2, y: .6 }), field(editor, { x: -1, y: 1.2 }));
  assert.equal(editor.source.plates.length, 2);
  const [left, right] = editor.source.plates, span = editor.plateSpans().find(span => span.id === left.id);
  assert(editor.splitPlate(span, { x: (span.a.x + span.b.x) / 2, y: (span.a.y + span.b.y) / 2 }));
  assert.equal(editor.source.plates.length, 4, 'the plate across is divided where this one is, mirrored');
  // The midpoint is 0.583095 m along this sloped plate. Default grid assistance
  // chooses 0.60 m along its face, preserving its line instead of bending it.
  const t = .6 / Math.hypot(1, .6), divided = nodeNear(editor.source, -40 + 20 * t, 12 + 12 * t);
  assert(divided, 'the new vertex lies 60 cm along the selected face');
  const across = editor.source.nodes.find(node => node.id === nodeAcross(editor.source, divided.id));
  assert(across); assert.equal(across.x, -divided.x); assert.equal(across.y, divided.y);
  for (const plate of editor.source.plates) assert.notEqual(plateAcross(editor.source, plate.id), null);
  editor.select(left.id); editor.remove();
  assert.equal(editor.source.plates.some(plate => plate.id === right.id), false); assert.equal(editor.source.plates.length, 2);
  assert.equal(editor.past.length, 3);
});

// Two plates that cross before the axis, made across it too: one rising, one falling, crossing on the cell (−30, 18).
const crossed = (snap = false) => {
  const editor = symmetric(); editor.snap = snap;
  editor.addPlate(field(editor, { x: -2, y: .6 }), field(editor, { x: -1, y: 1.2 }));
  editor.addPlate(field(editor, { x: -2, y: 1.2 }), field(editor, { x: -1, y: .6 }));
  const low = nodeAt(editor.source, -40, 12).id, rising = editor.source.plates.find(plate => [plate.a, plate.b].includes(low));
  return { editor, hit: () => editor.plateSpans().find(span => span.id === rising.id) };
};
const joints = (source, node) => node ? source.plates.filter(plate => plate.a === node.id || plate.b === node.id).length : 0;

for (const snap of [false, true]) test(`plates drawn across each other are divided where they really cross, and across the axis too, with grid assistance ${snap ? 'on' : 'off'}`, () => {
  const { editor, hit } = crossed(snap), source = editor.source, left = nodeAt(source, -30, 18), right = nodeAt(source, 30, 18);
  // The second, drawn over the first, divides both where they cross, in one node of four parts, on each side of the axis.
  assert.equal(source.plates.length, 8); assert.deepEqual([joints(source, left), joints(source, right)], [4, 4]);
  assert.equal(editor.past.length, 2, 'each plate drawn is one step to undo');
  for (const plate of source.plates) assert.notEqual(plateAcross(source, plate.id), null);
  // Without symmetry, only the crossing drawn.
  assert(editor.undo()); editor.symmetric = false;
  editor.addPlate(field(editor, { x: -2, y: 1.2 }), field(editor, { x: -1, y: .6 }));
  assert.equal(editor.source.plates.length, 5); assert.deepEqual([joints(editor.source, nodeAt(editor.source, -30, 18)), joints(editor.source, nodeAt(editor.source, 30, 18))], [4, 0]);
  // A double click away from the crossing divides the part clicked alone, where it is clicked; assistance steps along it.
  assert(editor.splitPlate(hit(), field(editor, { x: -1.8, y: .72 })));
  const length = Math.hypot(.5, .3), distance = Math.hypot(.2, .12), along = snap ? Math.round(distance / .05) * .05 : distance,
    t = along / length, split = nodeNear(editor.source, unitsOf(-2 + .5 * t), unitsOf(.6 + .3 * t));
  assert.equal(editor.source.plates.length, 6); assert(split); assert.equal(joints(editor.source, split), 2);
  near((split.y - 12) - .6 * (split.x + 40), 0, 'no bend is introduced');
  for (const plate of editor.source.plates.filter(plate => [plate.a, plate.b].includes(split.id))) {
    const [a, b] = [plate.a, plate.b].map(id => editor.source.nodes.find(node => node.id === id));
    assert(metresOf(Math.hypot(b.x - a.x, b.y - a.y)) >= .08 - 1e-12);
  }
});

test('a plate drawn across another that would leave a part shorter than the compiler admits is refused whole', () => {
  const editor = new Editor(pickup());
  editor.addPlate(field(editor, { x: -2, y: .6 }), field(editor, { x: -1, y: .6 }));
  const before = structuredClone(editor.source), count = editor.past.length;
  // It crosses 5 cm from the end of the level plate: that part would be under the 8 cm a plate is at least.
  assert.throws(() => editor.addPlate(field(editor, { x: -1.95, y: .4 }), field(editor, { x: -1.95, y: .8 })), /8 cm/);
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, count);
});

test('dragged, an end takes the one across the other way, and an end on the axis stays on it', () => {
  const editor = symmetric();
  editor.addPlate(field(editor, { x: -1, y: .5 }), field(editor, { x: 0, y: 1 }));
  const left = nodeAt(editor.source, -20, 10), right = nodeAt(editor.source, 20, 10), ridge = nodeAt(editor.source, 0, 20),
    grab = id => editor.pickNode(editor.nodes().find(node => node.id === id), .01);
  editor.begin(); assert(editor.moveNode(grab(left.id), field(editor, { x: -1.3, y: .7 }))); editor.commit();
  assert.deepEqual([nodeAt(editor.source, -26, 14)?.id, nodeAt(editor.source, 26, 14)?.id], [left.id, right.id]);
  editor.begin(); assert(editor.moveNode(grab(ridge.id), field(editor, { x: .3, y: 1.2 }))); editor.commit();
  assert.equal(nodeAt(editor.source, 0, 24)?.id, ridge.id, 'on the axis it only goes up');
  // The selection moved whole: the end and the point of the chassis chosen, and those across, the other way.
  editor.select([nodeKey(left.id), vertexKey(1)]);
  editor.begin(); assert(editor.moveSelection(editor.captureSelection(), -.1, 0)); editor.commit();
  assert.equal(editor.source.chassis.points[1].x, -64); assert.equal(editor.source.chassis.points[8].x, 64);
  assert.notEqual(nodeAt(editor.source, -28, 14), undefined); assert.notEqual(nodeAt(editor.source, 28, 14), undefined);
  // Equipment is no part of it: the engine alone moves.
  editor.select('engine'); editor.begin(); assert(editor.moveSelection(editor.captureSelection(), .1, 0)); editor.commit();
  assert.equal(editor.source.components[0].pose.x, -8);
});

test('a plate dragged takes the one across the other way; meeting on the axis, they stay joined there', () => {
  const editor = symmetric();
  editor.addPlate(field(editor, { x: -1, y: .5 }), field(editor, { x: 0, y: 1 }));
  const [left] = editor.source.plates, ridge = nodeAt(editor.source, 0, 20).id;
  editor.begin(); assert(editor.movePlate(editor.plateSpans().find(span => span.id === left.id), -.2, .2)); editor.commit();
  assert.deepEqual([[-24, 14], [24, 14], [0, 24]].map(([x, y]) => Boolean(nodeAt(editor.source, x, y))), [true, true, true]);
  assert.equal(editor.source.plates.filter(plate => plate.a === ridge || plate.b === ridge).length, 2);
});

test('ends joined and a gap made, each on both sides in one step', () => {
  const editor = symmetric();
  editor.addPlate(field(editor, { x: -2, y: .5 }), field(editor, { x: -1, y: .5 }));
  editor.addPlate(field(editor, { x: -1, y: .7 }), field(editor, { x: -1, y: 1.5 }));
  const ends = [[-20, 14], [-20, 10]].map(([x, y]) => nodeAt(editor.source, x, y).id);
  editor.select(ends.map(nodeKey)); assert(editor.joinPoints());
  const joined = editor.source.nodes.filter(node => node.y === 14);
  assert.equal(joined.length, 2, 'one end on each side, where the first chosen was');
  for (const node of joined) assert.equal(editor.source.plates.filter(plate => plate.a === node.id || plate.b === node.id).length, 2);
  editor.select(stretchKey(1)); editor.remove();
  assert.equal(editor.source.chassis.points[1].gap, true); assert.equal(editor.source.chassis.points[7].gap, true);
  assert.equal(editor.past.length, 4); assert(editor.undo()); assert.equal(editor.source.chassis.points[7].gap, undefined);
});

test('dragged past the side of the construction box, a point and the one across are both held at it', () => {
  const editor = symmetric();
  editor.addPlate(field(editor, { x: -5.5, y: .6 }), field(editor, { x: -4.5, y: .6 }));
  const [left] = editor.source.plates;
  editor.begin(); assert(editor.movePlate(editor.plateSpans().find(span => span.id === left.id), -1, 0)); editor.commit();
  assert.deepEqual([[-120, 12], [-100, 12], [100, 12], [120, 12]].map(([x, y]) => Boolean(nodeAt(editor.source, x, y))), [true, true, true, true]);
  const end = nodeAt(editor.source, -100, 12), grab = editor.pickNode(editor.nodes().find(node => node.id === end.id), .01);
  editor.begin(); assert(editor.moveNode(grab, field(editor, { x: -4, y: .9 }))); editor.commit();
  assert.notEqual(nodeAt(editor.source, -80, 18), undefined); assert.notEqual(nodeAt(editor.source, 80, 18), undefined);
  // The front of the chassis pulled out past the side: the front and the rear stop at either side.
  const front = editor.chassisPoints()[0];
  editor.begin(); editor.moveChassisPoint(editor.pickChassisPoint(front, .01), { x: front.x - 3.2, y: front.y }); editor.commit();
  assert.equal(editor.source.chassis.points[0].x, -120); assert.equal(editor.source.chassis.points.at(-1).x, 120);
});

test('one place is one exact authored coordinate, including fractional ends across the axis', () => {
  assert.equal(samePlace({ x: 20, y: 20 }, { x: 20, y: 20 }), true);
  assert.equal(samePlace({ x: 20, y: 20 }, { x: 21, y: 20 }), false, 'a cell apart is another place');
  const source = { ...pickup(), nodes: [[-40, 10], [-20, 10], [20, 10], [40, 10]].map(([x, y], i) => ({ id: `node-${i + 2}`, x, y })),
    plates: [['plate-2', 'node-2', 'node-3'], ['plate-3', 'node-4', 'node-5']].map(([id, a, b]) => ({ id, a, b, material: 'steel', thicknessMm: 20 })) };
  assert.equal(plateAcross(source, 'plate-2'), 'plate-3', 'the plate on the mirrored cells is the one across');
  assert.equal(nodeAcross(source, 'node-3'), 'node-4');
  // A cell off the mirror, nothing stands across.
  source.nodes[2].x = 21;
  assert.equal(plateAcross(source, 'plate-2'), null); assert.equal(nodeAcross(source, 'node-3'), null);
  source.nodes[1].x = -20.125; source.nodes[2].x = 20.125;
  assert.equal(plateAcross(source, 'plate-2'), 'plate-3'); assert.equal(nodeAcross(source, 'node-3'), 'node-4');
  source.nodes[2].x += 1e-9;
  assert.equal(plateAcross(source, 'plate-2'), null); assert.equal(nodeAcross(source, 'node-3'), null, 'free coordinates do not widen the exact topology relation');
});
