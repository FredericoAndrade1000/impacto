import { DESIGN_VERSION } from '../src/design-contract.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { alongEdge, snapAlong } from '../src/edge-plates.ts';
import { nodeKey, stretchKey, vertexKey } from '../src/frame-points.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();
const near = (actual, expected, why = '') => assert(Math.abs(actual - expected) < 1e-6, `${actual} ≠ ${expected} ${why}`);

// A pickup (the one Frederico showed): the chassis arches over each wheel, and the floor of the hull follows it, with an
// end of plate at each point of the chassis. Written in cells of 5 cm (grid.ts): the chassis 25 cm under the reference,
// and 5 cm under it over the wheels; its engine and fuel tank clear of two rows of floor above it.
const LOW = -5, HIGH = -1;
const pickup = () => ({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Picape', nodes: [], plates: [],
  chassis: { model: 'wheeled', axles: [-44, 38], points: [[-66, LOW], [-62, LOW], [-56, HIGH], [-32, HIGH], [-26, LOW],
    [22, LOW], [28, HIGH], [48, HIGH], [54, LOW], [66, LOW]].map(([x, y]) => ({ x, y })) },
  components: [{ id: 'engine', kind: 'engine', sizeScale: .86, pose: { x: -8, y: 4, angle: 0 } },
    { id: 'fuel', kind: 'fuel', pose: { x: 12, y: 5, angle: 0 } }] });
const total = edge => edge.points.slice(1).reduce((sum, point, i) => sum + Math.hypot(point.x - edge.points[i].x, point.y - edge.points[i].y), 0);
const ends = (source, id) => { const plate = source.plates.find(plate => plate.id === id);
  return [plate.a, plate.b].map(end => source.nodes.find(node => node.id === end)); };
// Plates laid as a drag along `edge` lays them, from `from` to `to` metres along it, in one step of history.
function lay(editor, edge, from, to) {
  editor.begin(); const ids = editor.layPlates(edge, from, to); editor.commit(); return ids;
}

test('Shift dragged along the top of the chassis lays the floor at once: a plate per stretch, joined at every knee', () => {
  const editor = new Editor(pickup()); editor.snap = false; const grips = editor.chassisPoints(), edge = editor.pickEdge(grips[0], .05);
  assert.deepEqual(edge.armour, { material: 'steel', thicknessMm: 20 }, 'with no plate yet, steel of 20 mm');
  near(edge.at, 0, 'pressed on the first point, the row starts there');
  const ids = lay(editor, edge, 0, total(edge)), source = editor.source;
  assert.equal(ids.length, 9); assert.equal(source.plates.length, 9); assert.equal(editor.past.length, 1);
  // End to end: each plate starts where the one before it ends, on the same node.
  for (let i = 1; i < ids.length; i++) assert.equal(source.plates.find(p => p.id === ids[i]).a, source.plates.find(p => p.id === ids[i - 1]).b);
  assert.equal(source.nodes.length, 10);
  // Both ends of each free plate are half its thickness from the actual top face, including the mitred knees.
  const origin = editor.blueprint.frame.origin;
  ids.forEach((id, i) => {
    const plate = source.plates.find(plate => plate.id === id), a = edge.points[i], b = edge.points[i + 1],
      dx = b.x - a.x, dy = b.y - a.y, length = Math.hypot(dx, dy);
    for (const node of ends(source, id)) {
      const x = metresOf(node.x) + origin.x - a.x, y = metresOf(node.y) + origin.y - a.y;
      near((dx * y - dy * x) / length, plate.thicknessMm / 2000, `${id} rests against the chassis`);
    }
  });
  assert.equal(source.nodes[0].x, -66); assert.equal(source.nodes.at(-1).x, 66);
  assert.deepEqual(new Set(source.plates.map(p => `${p.material}:${p.thicknessMm}`)), new Set(['steel:20']));
  // Undone, nothing of it is left.
  assert(editor.undo()); assert.equal(editor.source.plates.length, 0); assert.equal(editor.source.nodes.length, 0);
  // With assistance enabled, the same gesture retains the first clear grid cell instead of placing a free offset.
  const assisted = new Editor(pickup()); assisted.snap = true;
  const assistedEdge = assisted.pickEdge(assisted.chassisPoints()[0], .05), assistedIds = lay(assisted, assistedEdge, 0, total(assistedEdge)),
    levels = assisted.source.chassis.points.map(point => point.y);
  assert.equal(assistedIds.length, 9);
  for (const node of assisted.source.nodes) assert(levels.some(y => node.y === y + 1), `assisted node at ${node.y} clears the chassis`);
});

test('a row laid from an end of plate is born joined to it, and straight stretches make one plate', () => {
  const editor = new Editor(pickup()), edge = editor.pickEdge(editor.chassisPoints()[0], .05), lengths = edge.points.slice(1)
    .map((point, i) => Math.hypot(point.x - edge.points[i].x, point.y - edge.points[i].y)), knee = lengths.slice(0, 4).reduce((a, b) => a + b);
  const first = lay(editor, edge, 0, knee), second = lay(editor, editor.pickEdge(editor.chassisPoints()[4], .05), knee, total(edge));
  const source = editor.source;
  assert.equal(first.length, 4); assert.equal(second.length, 5);
  assert.equal(source.plates.find(p => p.id === second[0]).a, source.plates.find(p => p.id === first.at(-1)).b, 'one node where the rows meet');
  // On a chassis drawn straight through a point, one plate covers both stretches.
  const straight = pickup(); straight.chassis.points = [[-66, LOW], [0, LOW], [66, LOW]].map(([x, y]) => ({ x, y }));
  const flat = new Editor(straight), along = flat.pickEdge(flat.chassisPoints()[0], .05);
  assert.equal(lay(flat, along, 0, total(along)).length, 1);
});

test('dragged along a plate, the row goes on over the plates that continue it, on the side pressed, in its armour', () => {
  const editor = new Editor(pickup()); editor.snap = false; const chassis = editor.pickEdge(editor.chassisPoints()[0], .05), floor = lay(editor, chassis, 0, total(chassis));
  // The armour of the plate pressed, not that of the plates it goes on over.
  editor.change(source => { source.plates.find(plate => plate.id === floor[4]).material = 'aluminum'; });
  const [a, b] = ends(editor.source, floor[4]), origin = editor.blueprint.frame.origin,
    press = { x: metresOf(a.x + b.x) / 2 + origin.x, y: metresOf(a.y + b.y) / 2 + origin.y + .03 }, edge = editor.pickEdge(press, .05);
  assert.deepEqual(edge.armour, { material: 'aluminum', thicknessMm: 20 });
  // From the middle of the level floor over the knee, up the slope, to the top of the arch.
  const from = snapAlong(edge, edge.at), to = snapAlong(edge, alongEdge(edge, { x: 1.9 + origin.x, y: metresOf(HIGH) + origin.y + .05 }));
  const ids = lay(editor, edge, from, to), next = editor.source;
  assert.equal(ids.length, 3, 'level, slope and arch top');
  for (let i = 1; i < ids.length; i++) assert.equal(next.plates.find(p => p.id === ids[i]).a, next.plates.find(p => p.id === ids[i - 1]).b);
  assert(ids.every(id => next.plates.find(plate => plate.id === id).material === 'aluminum'));
  // The new centre lies exactly one half-thickness from each adjoining face, without an artificial grid gap.
  const [start] = ends(next, ids[0]), support = next.plates.find(plate => plate.id === floor[4]),
    added = next.plates.find(plate => plate.id === ids[0]), dx = b.x - a.x, dy = b.y - a.y,
    separation = metresOf((dx * (start.y - a.y) - dy * (start.x - a.x)) / Math.hypot(dx, dy));
  near(separation, (support.thicknessMm + added.thicknessMm) / 2000);
  // Pressed under it, the row goes under it.
  const below = editor.pickEdge({ ...press, y: press.y - .06 }, .05);
  assert(below.offsets[0] < 0);
});

test('a pull shorter than a plate lays nothing and leaves the design as it was', () => {
  const editor = new Editor(pickup()), edge = editor.pickEdge(editor.chassisPoints()[0], .05), before = structuredClone(editor.source);
  editor.begin(); assert.equal(editor.layPlates(edge, 0, .05), null); editor.commit();
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, 0);
});

test('points of the chassis and ends of plates chosen together move together, and a stretch removed opens a gap', () => {
  const editor = new Editor(pickup()), chassis = editor.pickEdge(editor.chassisPoints()[0], .05); lay(editor, chassis, 0, total(chassis));
  const knee = editor.source.plates[1].a, before = editor.source.nodes.find(node => node.id === knee);
  // The point of the chassis at x −3.1 and the end of the floor resting on it.
  editor.select([vertexKey(1), nodeKey(knee)]);
  editor.begin(); assert(editor.moveSelection(editor.captureSelection(), 0, .1)); editor.commit();
  assert.equal(editor.source.chassis.points[1].y, LOW + 2); assert.equal(editor.source.nodes.find(node => node.id === knee).y, before.y + 2);
  assert(editor.undo()); assert.equal(editor.source.chassis.points[1].y, LOW);
  // A stretch chosen alone and removed is a gap; removed again, the chassis is back.
  editor.select(stretchKey(4)); editor.remove();
  assert.equal(editor.source.chassis.points[4].gap, true); assert.deepEqual([...editor.selectionIds], [stretchKey(4)]);
  editor.remove(); assert.equal(editor.source.chassis.points[4].gap, undefined);
  editor.select(stretchKey(0)); assert.throws(() => editor.remove(), /nunca numa ponta/);
  assert.equal(editor.source.chassis.points[0].gap, undefined);
});
