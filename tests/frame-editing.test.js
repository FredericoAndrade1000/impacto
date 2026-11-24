import test from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_HEIGHT, FRAME_REACH, MAX_NODES, MAX_PLATES, REACH_CELLS, addPlate, assemblySelection, carriesRoom, drawRoom,
  moveFrameSelection, moveNodes, platesAcross, removeNode, removePlates, removeRoom, roomSpan, splitPlate, joinContacts } from '../src/frame-editing.ts';

// The box, written as a project writes it: positions in units of 5 cm, from the reference (grid.ts). A box 4 m
// long and 2 m high, its sensor a metre behind the middle, a metre over the roof.
const box = () => ({ version: 8, preset: 'bunker', name: 'Box',
  nodes: [{ id: 'a', x: -40, y: 0 }, { id: 'b', x: 40, y: 0 }, { id: 'c', x: 40, y: 40 }, { id: 'd', x: -40, y: 40 }],
  plates: [['floor', 'a', 'b'], ['rear', 'b', 'c'], ['roof', 'c', 'd'], ['front', 'd', 'a']]
    .map(([id, a, b]) => ({ id, a, b, material: 'steel', thicknessMm: 20 })),
  components: [{ id: 'sensor', kind: 'sensor', sensorMode: 'visual', pose: { x: 20, y: 60, angle: 0 } }],
});
const at = (source, id) => source.nodes.find(node => node.id === id);
const endpoints = (source, id) => { const plate = source.plates.find(plate => plate.id === id); return [at(source, plate.a), at(source, plate.b)].map(({ x, y }) => ({ x, y })); };
// The compiled frame the room tools read faces from: they are told in metres in the field.
const compiled = { frame: { origin: { x: 0, y: 0 } } };
const wall = (normal = { x: 0, y: 1 }) => ({ id: 'roof', aId: 'c', bId: 'd', a: { x: 2, y: 2 }, b: { x: -2, y: 2 },
  normal, length: 4, material: 'steel', thicknessMm: 20 });

test('moving one plate keeps both junctions while the far neighbour ends and equipment stay fixed', () => {
  const source = box(), snapshot = structuredClone(source), next = moveFrameSelection(source, ['roof'], 8, 20);
  assert.deepEqual(source, snapshot);
  assert.deepEqual(endpoints(next, 'roof'), [{ x: 48, y: 60 }, { x: -32, y: 60 }]);
  assert.deepEqual(endpoints(next, 'floor'), endpoints(source, 'floor'));
  assert.deepEqual(endpoints(next, 'rear'), [{ x: 40, y: 0 }, { x: 48, y: 60 }]);
  assert.deepEqual(endpoints(next, 'front'), [{ x: -32, y: 60 }, { x: -40, y: 0 }]);
  assert.deepEqual(next.plates, source.plates, 'dragging preserves the existing joint IDs');
  assert.equal(next.nodes.length, source.nodes.length);
  assert.deepEqual(next.components, source.components);
  assert.equal(next.plates.length, source.plates.length);
});

test('a mixed selection carries its plate junctions and only the selected equipment', () => {
  const source = box(), ids = ['roof', 'sensor'];
  assert.deepEqual(assemblySelection(source, ids), ids);
  const moved = moveFrameSelection(source, ids, -20, -10);
  assert.deepEqual(moved.components[0].pose, { x: 0, y: 50, angle: 0 });
  assert.deepEqual(endpoints(moved, 'roof'), [{ x: 20, y: 30 }, { x: -60, y: 30 }]);
  assert.deepEqual(endpoints(moved, 'rear'), [{ x: 40, y: 0 }, { x: 20, y: 30 }]);
  assert.deepEqual(endpoints(moved, 'front'), [{ x: -60, y: 30 }, { x: -40, y: 0 }]);
  assert.deepEqual(endpoints(moved, 'floor'), endpoints(source, 'floor'));
});

test('horizontal node and group edits leave untouched heights as they are', () => {
  const source = box(), y = -3;
  source.nodes.forEach(node => { node.y += y; }); source.components[0].pose.y = y;
  const roof = source.plates.find(plate => plate.id === 'roof'), a = at(source, roof.a), b = at(source, roof.b),
    same = new Map([[a.id, { x: a.x, y: a.y }], [b.id, { x: b.x, y: b.y }]]);
  assert.equal(moveNodes(source, same, { plateIds: ['roof'] }), source);
  const group = moveFrameSelection(source, ['roof', 'sensor'], 4, 0),
    single = moveNodes(source, new Map([[a.id, { x: a.x + 4, y: a.y }]]), { plateIds: ['roof'] });
  assert.equal(endpoints(group, 'roof')[0].y, a.y); assert.equal(group.components[0].pose.y, y);
  assert.equal(endpoints(single, 'roof')[0].y, a.y);
});

test('free plate nodes keep fractions through creation, movement, division and JSON roundtrip', () => {
  const source = box(), point = { x: .123456789123, y: 40.987654321987 },
    created = addPlate(source, point, { x: 20.123456789123, y: 40.987654321987 }),
    moved = moveNodes(created.source, new Map([[created.source.plates.at(-1).a, { x: .246813579, y: 41.369258147 }]])),
    split = splitPlate(moved, created.plateId, { x: 10.123456789123, y: 41.178456234987 }).source;
  assert.deepEqual(endpoints(created.source, created.plateId)[0], point);
  assert.deepEqual(endpoints(moved, created.plateId)[0], { x: .246813579, y: 41.369258147 });
  assert.deepEqual(split.nodes.at(-1), { id: split.nodes.at(-1).id, x: 10.123456789123, y: 41.178456234987 });
  assert.deepEqual(JSON.parse(JSON.stringify(split)), split);
  assert.deepEqual(endpoints(source, 'roof'), [{ x: 40, y: 40 }, { x: -40, y: 40 }]);
});

test('free plate and mixed component transforms preserve the same fractional rigid translation', () => {
  const source = box(), moved = moveFrameSelection(source, ['roof'], .375, -.625);
  assert.deepEqual(endpoints(moved, 'roof'), [{ x: 40.375, y: 39.375 }, { x: -39.625, y: 39.375 }]);
  assert.deepEqual(moved.components, source.components);
  assert.deepEqual(endpoints(moved, 'floor'), endpoints(source, 'floor'));
  assert.deepEqual(endpoints(moved, 'rear')[1], endpoints(moved, 'roof')[0]);
  assert.deepEqual(endpoints(moved, 'front')[0], endpoints(moved, 'roof')[1]);
  assert.deepEqual(moved.plates, source.plates);
  const free = moveFrameSelection(source, ['roof', 'sensor'], .375, -.625);
  assert.deepEqual(endpoints(free, 'roof'), endpoints(moved, 'roof'));
  assert.deepEqual(free.components[0].pose, { x: 20.375, y: 59.375, angle: 0 });
  const mixed = moveFrameSelection(moved, ['roof', 'sensor'], 2, -3);
  assert.deepEqual(endpoints(mixed, 'roof'), [{ x: 42.375, y: 36.375 }, { x: -37.625, y: 36.375 }]);
  assert.deepEqual(mixed.components[0].pose, { x: 22, y: 57, angle: 0 });
});

test('a selected vertex or whole plate carries exactly coincident ends without recursing or changing identities', () => {
  const source = box();
  source.nodes.push({ id: 'independent', x: 40, y: 40 }, { id: 'nearby', x: 40.01, y: 40 }, { id: 'free-end', x: 60, y: 60 });
  source.plates.push({ id: 'branch', a: 'independent', b: 'free-end', material: 'steel', thicknessMm: 5 },
    { id: 'near-branch', a: 'nearby', b: 'free-end', material: 'steel', thicknessMm: 5 });
  const before = structuredClone(source), moved = moveFrameSelection(source, [], .25, -.125, ['c']);
  assert.deepEqual(at(moved, 'c'), { id: 'c', x: 40.25, y: 39.875 });
  assert.deepEqual(at(moved, 'independent'), { id: 'independent', x: 40.25, y: 39.875 });
  assert.deepEqual(at(moved, 'nearby'), at(source, 'nearby'), 'nearby is not an implicit constraint');
  assert.deepEqual(moved.plates, source.plates, 'ordinary vertex motion never welds or splits IDs');
  const plateMoved = moveFrameSelection(source, ['roof'], .25, -.125);
  for (const id of ['c', 'independent']) assert.deepEqual(at(plateMoved, id), at(moved, id));
  for (const id of ['a', 'b', 'nearby', 'free-end']) assert.deepEqual(at(plateMoved, id), at(source, id));
  assert.deepEqual(plateMoved.plates, source.plates, 'whole-plate motion uses the same exact junctions');
  assert.deepEqual(plateMoved.components, source.components);
  assert.deepEqual(source, before);
});

test('creation reuses a deliberately chosen exact endpoint and leaves nearby endpoints independent', () => {
  const source = box(), made = addPlate(source, { x: 40, y: 40 }, { x: 60.125, y: 60.25 });
  assert.equal(made.source.plates.at(-1).a, 'c');
  assert.equal(made.source.nodes.length, source.nodes.length + 1);
  const free = addPlate(source, { x: 40.001, y: 40 }, { x: 60.125, y: 60.25 });
  assert.notEqual(free.source.plates.at(-1).a, 'c', 'proximity belongs to the intentional pointer gesture');
  assert.deepEqual(endpoints(free.source, free.plateId)[0], { x: 40.001, y: 40 });
});

test('node drags clamp to the construction limits while numeric proposals can keep their exact centre for admission', () => {
  const made = addPlate(box(), { x: 100.123456789, y: 100.987654321 }, { x: 110.123456789, y: 110.987654321 }),
    plate = made.source.plates.at(-1), before = endpoints(made.source, plate.id),
    positions = new Map([plate.a, plate.b].map((id, i) => [id, { x: before[i].x + 30, y: before[i].y + 30 }])),
    moved = moveNodes(made.source, positions, { plateIds: [plate.id] }), after = endpoints(moved, plate.id),
    proposed = moveNodes(made.source, positions, { plateIds: [plate.id], clampToReach: false });
  assert.deepEqual(after[1], { x: 120, y: 134 });
  assert(Math.abs((after[1].x - after[0].x) - (before[1].x - before[0].x)) < 1e-12);
  assert(Math.abs((after[1].y - after[0].y) - (before[1].y - before[0].y)) < 1e-12);
  for (const id of ['floor', 'rear', 'front', 'roof']) assert.deepEqual(endpoints(moved, id), endpoints(made.source, id));
  assert.deepEqual(moved.components, made.source.components);
  assert.deepEqual(endpoints(proposed, plate.id), [...positions.values()]);
  assert.deepEqual(endpoints(made.source, plate.id), before);
  assert.equal('clampToReach' in proposed, false);
});

test('symmetric copies preserve every fractional coordinate and leave the original plate untouched', () => {
  const created = addPlate(box(), { x: -40.123456789, y: 60.987654321 }, { x: -20.246813579, y: 80.369258147 }),
    copied = platesAcross(created.source, [created.plateId]), original = endpoints(created.source, created.plateId);
  assert.equal(copied.plateIds.length, 1);
  assert.deepEqual(endpoints(copied.source, copied.plateIds[0]), original.map(point => ({ x: -point.x, y: point.y })));
  assert.deepEqual(endpoints(copied.source, created.plateId), original);
  assert.deepEqual(copied.source.components, created.source.components);
});

test('nonfinite positions and displacements are refused without mutating the source', () => {
  const source = box(), snapshot = structuredClone(source);
  for (const value of [NaN, Infinity, -Infinity, '1', undefined]) {
    assert.throws(() => moveNodes(source, new Map([['c', { x: value, y: 40 }]])), { code: 'FRAME_EDIT' });
    assert.throws(() => moveFrameSelection(source, ['roof'], value, 0), { code: 'FRAME_EDIT' });
    assert.throws(() => addPlate(source, { x: 0, y: 40 }, { x: 20, y: value }), { code: 'FRAME_EDIT' });
    assert.throws(() => splitPlate(source, 'roof', { x: value, y: 40 }), { code: 'FRAME_EDIT' });
  }
  assert.deepEqual(source, snapshot);
});

test('an explicitly moved corner changes only its chosen plate, with no divider propagation', () => {
  const source = splitPlate(box(), 'roof', { x: 0, y: 40 }).source,
    changed = moveNodes(source, new Map([['c', { x: 40, y: 60 }]]), { plateIds: ['roof'] });
  assert.deepEqual(endpoints(changed, 'rear'), endpoints(source, 'rear'));
  const divider = source.nodes.find(node => node.id.startsWith('node'));
  assert.deepEqual(at(changed, divider.id), divider);
  assert.deepEqual(endpoints(changed, 'roof'), [{ x: 40, y: 60 }, { x: 0, y: 40 }]);
});

test('snapping endpoints does not weld, delete duplicates, split another span or carry a component', () => {
  const source = box(), changed = moveNodes(source, new Map([['d', { x: 0, y: 0 }]]), { plateIds: ['roof'] });
  assert.equal(changed.plates.length, source.plates.length);
  assert.deepEqual(endpoints(changed, 'floor'), endpoints(source, 'floor'));
  assert.deepEqual(changed.components, source.components);
  assert.equal(changed.nodes.filter(node => node.x === 0 && node.y === 0).length, 1);
});

test('split and merge are explicit operations and preserve unrelated equipment', () => {
  const source = box(), divided = splitPlate(source, 'roof', { x: 0, y: 40 }), merged = removeNode(divided.source, divided.nodeId);
  assert.deepEqual(endpoints(merged.source, 'roof'), endpoints(source, 'roof'));
  assert.deepEqual(merged.source.components, source.components);
  assert.equal(merged.source.plates.length, source.plates.length);
  assert.throws(() => splitPlate(source, 'roof', { x: 40, y: 40 }), { code: 'FRAME_EDIT' });
});

test('a split preserves the original physical outer ends and gives both new cut ends zero extension', () => {
  const source = box(); source.plates.find(plate => plate.id === 'roof').ends = { start: 2, end: 1 };
  const divided = splitPlate(source, 'roof', { x: 0, y: 40 }), first = divided.source.plates.find(plate => plate.id === 'roof'),
    rest = divided.source.plates.find(plate => plate.id === divided.plateId);
  assert.deepEqual(first.ends, { start: 2, end: 0 }); assert.deepEqual(rest.ends, { start: 0, end: 1 });
  const merged = removeNode(divided.source, divided.nodeId);
  assert.deepEqual(merged.source.plates.find(plate => plate.id === 'roof').ends, source.plates.find(plate => plate.id === 'roof').ends);
  assert.deepEqual(endpoints(merged.source, 'roof'), endpoints(source, 'roof'));
});

// The box braced corner to corner: two plates that cross in its middle, of other armours, one running past its ends.
const braced = () => {
  const source = box();
  source.plates.push({ id: 'up', a: 'a', b: 'c', material: 'aluminum', thicknessMm: 30, ends: { start: 2, end: 1 } },
    { id: 'down', a: 'b', b: 'd', material: 'steel', thicknessMm: 12 });
  return source;
};
const partsAt = (source, id) => source.plates.filter(plate => plate.a === id || plate.b === id).map(plate => plate.id).sort();

test('two plates that cross are divided there in one node the four parts share, each part of its plate', () => {
  const source = braced(), snapshot = structuredClone(source), joined = joinContacts(source), next = joined.source,
    [division] = joined.points, node = next.nodes.find(node => node.x === division.x && node.y === division.y),
    [upRest, downRest] = ['up', 'down'].map(id => next.plates.find(plate => plate.id === joined.parts.get(id)[1]));
  assert.deepEqual(source, snapshot);
  assert.deepEqual(joined.points, [{ x: 0, y: 20 }]);
  assert.deepEqual([next.nodes.length, next.plates.length], [source.nodes.length + 1, source.plates.length + 2]);
  assert.deepEqual(partsAt(next, node.id), ['down', 'up', upRest.id, downRest.id].sort(), 'one node, four parts');
  // Each runs from where its plate began to the node, and the rest from the node on; of the same armour.
  assert.deepEqual(endpoints(next, 'up'), [{ x: -40, y: 0 }, { x: 0, y: 20 }]); assert.deepEqual(endpoints(next, upRest.id), [{ x: 0, y: 20 }, { x: 40, y: 40 }]);
  assert.deepEqual(endpoints(next, 'down'), [{ x: 40, y: 0 }, { x: 0, y: 20 }]); assert.deepEqual(endpoints(next, downRest.id), [{ x: 0, y: 20 }, { x: -40, y: 40 }]);
  assert.deepEqual([upRest.material, upRest.thicknessMm, downRest.material, downRest.thicknessMm], ['aluminum', 30, 'steel', 12]);
  // What ran past the outer ends still does; nothing runs past the node.
  assert.deepEqual([next.plates.find(plate => plate.id === 'up').ends, upRest.ends], [{ start: 2, end: 0 }, { start: 0, end: 1 }]);
  assert.deepEqual([next.plates.find(plate => plate.id === 'down').ends, downRest.ends], [undefined, undefined]);
  assert.deepEqual(next.components, source.components);
  assert.equal(joinContacts(next).source, next, 'what is joined has nothing more to divide');
});

test('an end on a plate between its ends divides it there, at that very end, and one along its line does not', () => {
  const source = box();
  source.nodes.push({ id: 'low', x: 10.5, y: 0 }, { id: 'high', x: 10.5, y: 25 }, { id: 'along', x: 30, y: 40 });
  source.plates.push({ id: 'post', a: 'low', b: 'high', material: 'steel', thicknessMm: 20 },
    { id: 'lining', a: 'along', b: 'c', material: 'steel', thicknessMm: 20 });
  const joined = joinContacts(source), next = joined.source;
  assert.deepEqual(joined.points, [{ x: 10.5, y: 0 }], 'the post divides the floor; the lining runs along the roof');
  assert.deepEqual(joined.parts.get('floor'), ['floor', 'floor-2']);
  assert.deepEqual(endpoints(next, 'floor'), [{ x: -40, y: 0 }, { x: 10.5, y: 0 }]);
  assert.deepEqual(endpoints(next, 'floor-2'), [{ x: 10.5, y: 0 }, { x: 40, y: 0 }]);
  assert.deepEqual(partsAt(next, 'low'), ['floor', 'floor-2', 'post']);
  assert.equal(next.nodes.length, source.nodes.length, 'no node is made for a T');
  assert.deepEqual(next.plates.find(plate => plate.id === 'roof'), source.plates.find(plate => plate.id === 'roof'));
});

test('ends and crossings on one plate divide it in order, a crossing at an end of plates there shares it, and past the capacity none is', () => {
  const source = box();
  source.nodes.push({ id: 'p', x: -20, y: -20 }, { id: 'q', x: -20, y: 20 }, { id: 'r', x: 20, y: 0 }, { id: 's', x: 20, y: 20 },
    { id: 't', x: 0, y: -20 }, { id: 'u', x: 30, y: 10 });
  source.plates.push({ id: 'one', a: 'p', b: 'q', material: 'steel', thicknessMm: 8 }, { id: 'two', a: 'r', b: 's', material: 'steel', thicknessMm: 8 },
    { id: 'three', a: 't', b: 'u', material: 'steel', thicknessMm: 8 });
  const joined = joinContacts(source), next = joined.source;
  assert.deepEqual(joined.points, [{ x: 20, y: 0 }, { x: -20, y: 0 }], 'the end r, where three crosses the floor too, and where one crosses it');
  assert.deepEqual(joined.parts.get('floor').map(id => endpoints(next, id)[1]), [{ x: -20, y: 0 }, { x: 20, y: 0 }, { x: 40, y: 0 }]);
  assert.deepEqual(partsAt(next, 'r').length, 5, 'two parts of the floor, two of the brace and the post');
  const full = box(); full.plates.push(...Array.from({ length: MAX_PLATES - full.plates.length - 1 }, (_, i) => ({ id: 'more-' + i, a: 'a', b: 'c', material: 'steel', thicknessMm: 20 })));
  full.plates.push({ id: 'cross', a: 'b', b: 'd', material: 'steel', thicknessMm: 20 });
  assert.throws(() => joinContacts(full), { code: 'FRAME_EDIT' }, 'more plates do not fit');
});

test('crossing fractional plates share the exact point where they cross without quantizing their outer endpoints', () => {
  const source = braced(), offset = { x: .123456789, y: .987654321 };
  for (const node of source.nodes) { node.x += offset.x; node.y += offset.y; }
  const snapshot = structuredClone(source), joined = joinContacts(source), [point] = joined.points,
    node = joined.source.nodes.find(node => node.x === point.x && node.y === point.y);
  assert(Math.abs(point.x - offset.x) < 1e-9 && Math.abs(point.y - 20 - offset.y) < 1e-9);
  assert.equal(partsAt(joined.source, node.id).length, 4);
  for (const original of source.nodes) assert.deepEqual(at(joined.source, original.id), original);
  assert.deepEqual(source, snapshot);
});

test('merging reversed spans maps extensions by their physical outer endpoints', () => {
  const source = { ...box(), nodes: [{ id: 'a', x: -20, y: 0 }, { id: 'm', x: 0, y: 0 }, { id: 'b', x: 20, y: 0 }],
    plates: [{ id: 'first', a: 'm', b: 'a', material: 'steel', thicknessMm: 20, ends: { start: 1, end: 3 } },
      { id: 'second', a: 'b', b: 'm', material: 'steel', thicknessMm: 20, ends: { start: 4, end: 2 } }], components: [] },
    merged = removeNode(source, 'm').source.plates[0];
  assert.deepEqual([merged.a, merged.b], ['a', 'b']); assert.deepEqual(merged.ends, { start: 3, end: 4 });
});

test('deleting plates leaves exposed components and disconnected geometry', () => {
  const source = addPlate(box(), { x: -20, y: -20 }, { x: 20, y: -20 }).source,
    next = removePlates(source, ['floor', 'front', 'rear', 'roof']);
  assert.equal(next.plates.length, 1); assert.equal(next.nodes.length, 2);
  assert.deepEqual(next.components, source.components);
});

test('removing a room has no support cascade and keeps shared dividers and contents', () => {
  const source = box(), rooms = [
    { walls: [{ id: 'roof', exterior: true }, { id: 'rear', exterior: false }] },
    { walls: [{ id: 'rear', exterior: false }, { id: 'front', exterior: true }] },
  ], next = removeRoom(source, { rooms }, 'roof');
  assert.deepEqual(next.plates.map(plate => plate.id), ['floor', 'rear', 'front']);
  assert.deepEqual(next.components, source.components);
  assert.equal(removeRoom(source, { rooms: [{ walls: source.plates.map(plate => ({ id: plate.id, exterior: true })) }] }, 'roof').plates.length, 0);
});

test('an isolated plate has independent endpoints and respects authoring quotas', () => {
  const source = box(), added = addPlate(source, { x: 0, y: -40 }, { x: 20, y: -40 }, { material: 'aluminum', thicknessMm: 12 });
  assert.deepEqual(endpoints(added.source, added.plateId), [{ x: 0, y: -40 }, { x: 20, y: -40 }]);
  assert.equal(added.source.plates.at(-1).material, 'aluminum');
  assert.equal(source.plates.length, 4);
  assert.throws(() => addPlate(source, { x: 0, y: 0 }, { x: 0, y: 0 }), { code: 'FRAME_EDIT' });
  assert.throws(() => addPlate({ ...source, nodes: Array.from({ length: MAX_NODES }, (_, i) => ({ id: 'n' + i })) }, { x: 0, y: 0 }, { x: 20, y: 0 }), { code: 'FRAME_EDIT' });
  assert.throws(() => addPlate({ ...source, plates: Array.from({ length: MAX_PLATES }, (_, i) => ({ id: 'p' + i })) }, { x: 0, y: 0 }, { x: 20, y: 0 }), { code: 'FRAME_EDIT' });
});

test('downward faces can grow rooms using negative local height', () => {
  const source = box(), floor = { ...wall({ x: 0, y: -1 }), id: 'floor', aId: 'a', bId: 'b', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } };
  assert(carriesRoom(floor)); assert.equal(carriesRoom(null), false);
  const drawn = drawRoom(source, compiled, floor, { x: 0, y: 0 }, { x: 0, y: -.9 });
  assert.equal(drawn.depth, .9);
  assert.deepEqual(drawn.polygon.map(point => point.y), [0, -.9, -.9, 0]);
  assert.deepEqual(source.nodes.map(node => node.y), [0, 0, 40, 40]);
  assert.deepEqual(drawn.source.nodes.slice(-2).map(node => node.y), [-18, -18]);
});

test('the construction box stands on the workshop floor, eight metres up and six to either side, whatever the design', () => {
  const source = box();
  assert.deepEqual(FRAME_REACH, { minX: -6, maxX: 6, minY: -1.3, maxY: 6.7 });
  assert.deepEqual(REACH_CELLS, { minX: -120, maxX: 120, minY: -26, maxY: 134 });
  assert.equal(FRAME_HEIGHT, 8);
  // A room grows down to the floor and up to the top, and no further: the box does not follow the design.
  const floor = { ...wall({ x: 0, y: -1 }), id: 'floor', aId: 'a', bId: 'b', a: { x: -2, y: 0 }, b: { x: 2, y: 0 } },
    down = drawRoom(source, compiled, floor, { x: 0, y: 0 }, { x: 0, y: -20 }), up = drawRoom(down.source, compiled, wall(), { x: 0, y: 2 }, { x: 0, y: 20 });
  assert.equal(down.depth, 1.3); assert.equal(up.depth, 4.7);
  assert.deepEqual([Math.min(...up.source.nodes.map(node => node.y)), Math.max(...up.source.nodes.map(node => node.y))], [-26, 134]);
  const grounded = box(); for (const node of grounded.nodes) node.y -= 26;
  assert.deepEqual(drawRoom(grounded, compiled, { ...floor, a: { x: -2, y: -1.3 }, b: { x: 2, y: -1.3 } }, { x: 0, y: -1.3 }, { x: 0, y: -3 }),
    { refusal: 'A estrutura já chegou ao chão.' });
  // Dragged past it, nodes stop at its edge: on the floor, at its top, at a side; more than it holds is refused.
  assert.deepEqual(at(moveNodes(source, new Map([['a', { x: -40, y: -100 }]])), 'a'), { id: 'a', x: -40, y: -26 });
  assert.deepEqual(endpoints(moveNodes(source, new Map([['c', { x: 40, y: 400 }], ['d', { x: -40, y: 400 }]]), { plateIds: ['roof'] }), 'roof'),
    [{ x: 40, y: 134 }, { x: -40, y: 134 }]);
  assert.equal(at(moveNodes(source, new Map([['b', { x: 180, y: 0 }]])), 'b').x, 120);
  assert.throws(() => moveNodes(source, new Map([['a', { x: -40, y: -26 }], ['c', { x: 40, y: 136 }]])), { code: 'FRAME_EDIT', message: 'A construção pode ocupar no máximo 12 × 8 m.' });
});

test('plate controls stand in the same box as the chassis profile, which does not move it', () => {
  const source = box();
  source.chassis = { model: 'wheeled', points: [{ x: -60, y: 0 }, { x: 60, y: 0 }] };
  source.components[0].pose.y = 400;
  const snapshot = structuredClone(source), changed = moveNodes(source,
    new Map([['c', { x: 40, y: 180 }], ['d', { x: -40, y: 180 }]]), { plateIds: ['roof'] }),
    drawn = drawRoom(source, compiled, wall(), { x: 0, y: 2 }, { x: 0, y: 20 });
  assert.deepEqual(endpoints(changed, 'roof'), [{ x: 40, y: 134 }, { x: -40, y: 134 }]);
  assert.equal(drawn.depth, 4.7);
  assert.deepEqual(changed.chassis, source.chassis); assert.deepEqual(changed.components, source.components);
  assert.deepEqual(source, snapshot);
});

test('an isolated span can close a room on either side without changing its support', () => {
  const source = { ...box(), nodes: [{ id: 'a', x: -20, y: 0 }, { id: 'b', x: 20, y: 0 }],
    plates: [{ id: 'floor', a: 'a', b: 'b', material: 'steel', thicknessMm: 20 }], components: [] },
    open = { id: 'floor', aId: 'a', bId: 'b', a: { x: -1, y: 0 }, b: { x: 1, y: 0 },
      normal: null, length: 2, material: 'steel', thicknessMm: 20 };
  for (const y of [-1, 1]) {
    const drawn = drawRoom(source, compiled, open, { x: 0, y: 0 }, { x: 0, y });
    assert.equal(drawn.depth, 1); assert.equal(drawn.polygon[1].y, y);
    assert.deepEqual(drawn.source.plates[0], source.plates[0]);
  }
});

test('a partial room writes only its own walls and endpoints', () => {
  const source = box(), span = roomSpan(wall(), { x: 0, y: 2 }), drawn = drawRoom(source, compiled, span, { x: 0, y: 2 });
  assert(Math.abs(span.length - 1.8) < 1e-12);
  assert.equal(drawn.source.plates.length, 7);
  assert.deepEqual(drawn.source.plates.slice(0, 4), source.plates);
  assert.deepEqual(drawn.source.components, source.components);
  drawn.polygon.forEach((point, i) => assert(Math.abs(point.x - [.9, .9, -.9, -.9][i]) < 1e-12));
});

test('repeated room additions reserve distinct node and plate identities', () => {
  const source = box(), first = drawRoom(source, compiled, wall(), { x: 0, y: 2 }),
    second = drawRoom(first.source, compiled, { ...wall({ x: 0, y: -1 }), id: 'floor', aId: 'a', bId: 'b',
      a: { x: -2, y: 0 }, b: { x: 2, y: 0 } }, { x: 0, y: 0 }),
    ids = [...second.source.nodes, ...second.source.plates, ...second.source.components].map(piece => piece.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(first.plates[0], second.plates[0]);
});
