import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction, validateDraftConstruction } from '../src/structured-construction.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { DESIGN_VERSION, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { nodeKey } from '../src/frame-points.ts';
import { CELL } from '../src/grid.ts';
import { withChassisThickness } from '../src/chassis-editing.ts';

await initNativeDynamics();
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-7, `${actual} differs from ${expected}`);
const bare = () => createStructuredConstruction({ preset: 'bunker', length: 5, height: 2, frontInset: 0, rearInset: 0, thicknessMm: 20 });
const span = (editor, id) => editor.plateSpans().find(hit => hit.id === id);
const centre = hit => ({ x: (hit.a.x + hit.b.x) / 2, y: (hit.a.y + hit.b.y) / 2 });
const endpoints = (source, id) => { const plate = source.plates.find(plate => plate.id === id), at = key => source.nodes.find(node => node.id === key);
  return [at(plate.a), at(plate.b)].map(({ x, y }) => ({ x, y })); };
function canonical(editor) {
  assert.equal(editor.source.version, DESIGN_VERSION);
  assert.deepEqual(validateDraftConstruction(editor.source), editor.source);
  assert.deepEqual(parseBlueprint(serializeBlueprint(editor.source)), editor.source);
  for (const key of ['blockedEdit', 'polygons', 'points', 'modules', 'rooms', 'frame', 'derived']) assert.equal(key in editor.source, false, key);
}

test('authoring handles keep source endpoint identities and tolerance after derived topology', () => {
  const editor = new Editor(bare());
  for (const plate of editor.source.plates) {
    const hit = span(editor, plate.id);
    assert.equal(hit.aId, plate.a); assert.equal(hit.bId, plate.b);
    near(hit.length, Math.hypot(hit.b.x - hit.a.x, hit.b.y - hit.a.y));
    assert.equal(editor.pickPlate(centre(hit), .01).id, plate.id);
  }
  const roof = span(editor, 'hull:roof');
  assert.equal(editor.pickNode({ x: roof.a.x + .03, y: roof.a.y }, .05).id, roof.aId);
  assert.equal(editor.pickNode({ x: roof.a.x + .08, y: roof.a.y }, .05), null);
  // Within reach of both, the end selected is grabbed; a press that chooses takes the one it is nearest to.
  editor.select(nodeKey(roof.aId));
  assert.equal(editor.pickPoint(roof.b, 10).id, roof.aId);
  assert.equal(editor.pickPoint(roof.b, 10, { nearest: true }).id, roof.bId);
});

test('dragging a whole roof keeps both neighbour junctions and one gesture is one history entry', () => {
  const source = bare(); source.components = [{ id: 'camera', kind: 'sensor', sensorMode: 'visual', pose: { x: 0, y: 50, angle: 0 } }];
  const editor = new Editor(source), original = structuredClone(editor.source), hit = span(editor, 'hull:roof'), before = editor.blueprint, events = [];
  editor.onchange = event => events.push(event.kind);
  editor.begin(); assert(editor.movePlate(hit, .1, .2)); assert(editor.movePlate(hit, .2, .4)); assert(editor.commit());
  // .2 m along and .4 m up: 4 and 8 cells.
  for (const [i, point] of endpoints(editor.source, hit.id).entries()) {
    assert.equal(point.x, endpoints(original, hit.id)[i].x + 4); assert.equal(point.y, endpoints(original, hit.id)[i].y + 8);
  }
  const movedEnds = new Set([hit.aId, hit.bId]);
  for (const node of original.nodes) {
    const current = editor.source.nodes.find(other => other.id === node.id), moving = movedEnds.has(node.id);
    near(current.x, node.x + (moving ? 4 : 0)); near(current.y, node.y + (moving ? 8 : 0));
  }
  assert.deepEqual(editor.source.plates, original.plates, 'the neighbouring plates retain the same endpoint IDs');
  assert.equal(editor.source.nodes.length, original.nodes.length);
  near(span(editor, hit.id).length, hit.length);
  assert.deepEqual(editor.source.components, original.components);
  assert.deepEqual(editor.blueprint.frame.origin, before.frame.origin);
  assert.equal(editor.past.length, 1); assert.equal(events.filter(kind => kind === 'document').length, 1); canonical(editor);
  const moved = structuredClone(editor.source); assert(editor.undo()); assert.deepEqual(editor.source, original);
  assert(editor.redo()); assert.deepEqual(editor.source, moved);
});

test('editing the selected plate angle leaves shared neighbours and all component poses fixed', () => {
  const editor = new Editor(bare()), original = structuredClone(editor.source);
  editor.select('hull:roof'); editor.editProperty('angle', Math.PI / 6, true);
  // Each end goes to its nearest cell: the roof is at the angle asked to within a cell across its length.
  const roof = span(editor, 'hull:roof');
  assert(Math.abs(Math.atan2(roof.b.y - roof.a.y, roof.b.x - roof.a.x) - Math.PI / 6) <= Math.atan2(CELL, roof.length));
  for (const id of ['hull:floor', 'hull:front', 'hull:rear']) assert.deepEqual(endpoints(editor.source, id), endpoints(original, id));
  assert.equal(editor.past.length, 1); canonical(editor); assert(editor.undo()); assert.deepEqual(editor.source, original);
});

test('a shared corner stays one point through ordinary drag, commit and undo', () => {
  const editor = new Editor(bare()), original = structuredClone(editor.source), roof = span(editor, 'hull:roof'),
    corner = roof.aId, rear = original.plates.find(plate => plate.id === 'hull:rear'), at = id => editor.source.nodes.find(node => node.id === id),
    drag = (handle, dx, dy) => { editor.begin(); assert(editor.moveNode(handle, { x: handle.x + dx, y: handle.y + dy })); assert(editor.commit()); };
  assert.equal(rear.b, corner, 'the rear wall and the roof share the corner');
  drag(editor.pickNode(roof.a, .01), -.3, .4);
  // -.3 m and .4 m: -6 and 8 cells.
  assert.equal(at(corner).x, original.nodes.find(node => node.id === corner).x - 6); assert.equal(at(corner).y, original.nodes.find(node => node.id === corner).y + 8);
  assert.deepEqual(editor.source.plates, original.plates, 'both plates still end at the corner');
  assert.deepEqual(endpoints(editor.source, 'hull:front'), endpoints(original, 'hull:front'));
  assert.equal(editor.past.length, 1);
  canonical(editor);
  // A plate's own two ends do not join, and one end with nothing on it has nothing to join.
  editor.select([nodeKey(roof.aId), nodeKey(roof.bId)]); assert.throws(() => editor.joinPoints(), /mesma chapa/);
  editor.select(nodeKey(span(editor, 'hull:floor').aId)); assert.throws(() => editor.joinPoints(), /Nenhuma outra ponta/);
  for (let steps = editor.past.length; steps--;) assert(editor.undo());
  assert.deepEqual(editor.source, original);
});

test('a plate drawn from an existing exact endpoint already belongs to that junction', () => {
  const editor = new Editor(bare()), roof = span(editor, 'hull:roof');
  const plate = editor.addPlate(roof.a, { x: roof.a.x, y: roof.a.y + 1 }), spare = editor.source.plates.find(other => other.id === plate.id).a;
  assert.equal(spare, roof.aId, 'the creation gesture chose this existing point');
  assert.equal(editor.source.plates.find(other => other.id === plate.id).a, editor.source.plates.find(other => other.id === 'hull:roof').a);
  canonical(editor);
});

test('choosing a fractional existing endpoint preserves its source bits even with grid assistance enabled', () => {
  const editor = new Editor(bare()); editor.snap = false;
  const first = editor.addPlate({ x: 11.123456789, y: 5.987654321 }, { x: 12.123456789, y: 5.987654321 }),
    joint = editor.source.nodes.find(node => node.id === editor.source.plates.find(plate => plate.id === first.id).b),
    original = structuredClone(joint), rendered = editor.nodes().find(node => node.id === joint.id);
  editor.snap = true;
  const second = editor.addPlate({ x: rendered.x, y: rendered.y, nodeId: joint.id }, { x: rendered.x, y: rendered.y + 1 });
  assert.equal(editor.source.plates.find(plate => plate.id === second.id).a, joint.id);
  assert.deepEqual(editor.source.nodes.find(node => node.id === joint.id), original);
  canonical(editor);
});

test('independent endpoint IDs at the same exact place drag as one vertex without welding nearby ends', () => {
  const source = bare(), corner = source.nodes.find(node => node.id === source.plates.find(plate => plate.id === 'hull:roof').a);
  source.nodes.push({ id: 'independent', x: corner.x, y: corner.y }, { id: 'branch-end', x: corner.x, y: corner.y + 20 });
  source.plates.push({ id: 'branch', a: 'independent', b: 'branch-end', material: 'steel', thicknessMm: 5 });
  const editor = new Editor(source), original = structuredClone(editor.source), handle = editor.pickNode(editor.nodes().find(node => node.id === corner.id), .01);
  editor.snap = false; editor.begin(); assert(editor.moveNode(handle, { x: handle.x + .013, y: handle.y + .017 }));
  assert.equal(editor.joinDroppedNode(handle, .08), false, 'moving an existing vertex does not merge its old IDs');
  assert(editor.commit());
  for (const id of [corner.id, 'independent']) {
    const moved = editor.source.nodes.find(node => node.id === id);
    near(moved.x, corner.x + .26); near(moved.y, corner.y + .34);
  }
  assert.deepEqual(editor.source.plates, original.plates);
  assert.equal(editor.past.length, 1); editor.undo(); assert.deepEqual(editor.source, original);
});

test('a moved endpoint dropped near another joins even when it already started within reach', () => {
  const editor = new Editor(bare()); editor.snap = false;
  const first = editor.addPlate({ x: 9, y: 5 }, { x: 10, y: 5 }), target = editor.addPlate({ x: 10.03, y: 5 }, { x: 10.03, y: 6 }),
    handle = editor.pickNode({ x: 10, y: 5 }, .001), history = editor.past.length, before = structuredClone(editor.source);
  assert.equal(editor.joinDroppedNode(handle, .08), false, 'a click without movement does not join');
  editor.begin(); assert(editor.moveNode(handle, { x: 10.01, y: 5 }));
  assert(editor.joinDroppedNode(handle, .08)); editor.commit();
  near(span(editor, first.id).b.x, 10.03);
  assert.equal(editor.source.plates.find(plate => plate.id === first.id).b, editor.source.plates.find(plate => plate.id === target.id).a);
  assert.equal(editor.past.length, history + 1); canonical(editor);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  editor.begin(); assert(editor.moveNode(handle, { x: 10.01, y: 5 })); assert(editor.moveNode(handle, { x: 10, y: 5 }));
  assert.equal(editor.joinDroppedNode(handle, .08), false, 'returning to the original pose does not join');
  assert.equal(editor.commit(), false); assert.deepEqual(editor.source, before);
});

test('a nearby deliberate drop carries every edge of the existing vertex into the new junction', () => {
  const source = bare();
  source.nodes.push({ id: 'branch-a', x: -60, y: 74 }, { id: 'branch-joint', x: -40, y: 74 },
    { id: 'independent-joint', x: -40, y: 74 }, { id: 'branch-b', x: -40, y: 94 },
    { id: 'target-joint', x: -20, y: 74 }, { id: 'target-b', x: -20, y: 94 });
  for (const [id, a, b] of [['branch-first', 'branch-a', 'branch-joint'],
    ['branch-second', 'independent-joint', 'branch-b'], ['target', 'target-joint', 'target-b']])
    source.plates.push({ id, a, b, material: 'steel', thicknessMm: 5 });
  const editor = new Editor(source), original = structuredClone(editor.source), history = editor.past.length,
    handle = editor.pickNode({ x: 10, y: 5 }, .001);
  editor.snap = false; editor.begin(); assert(editor.moveNode(handle, { x: 10.97, y: 5 }));
  assert(editor.joinDroppedNode(handle, .08)); editor.commit();
  const plates = editor.source.plates, joint = plates.find(plate => plate.id === 'target').a;
  assert.equal(plates.find(plate => plate.id === 'branch-first').b, joint);
  assert.equal(plates.find(plate => plate.id === 'branch-second').a, joint);
  assert.equal(editor.past.length, history + 1); canonical(editor);
  assert(editor.undo()); assert.deepEqual(editor.source, original);
});

test('a dropped endpoint joins its mirrored counterpart in the same undo step', () => {
  const editor=new Editor(bare()), first=editor.addPlate({x:9,y:5},{x:10,y:5}), target=editor.addPlate({x:11,y:5},{x:11,y:6}),
    mirrored=editor.addPlate({x:15,y:5},{x:14,y:5}), opposite=editor.addPlate({x:13,y:5},{x:13,y:6}),
    before=structuredClone(editor.source), history=editor.past.length, handle=editor.pickNode({x:10,y:5},.01),
    plate=id=>editor.source.plates.find(p=>p.id===id);
  editor.symmetric=true;editor.begin();assert(editor.moveNode(handle,{x:11,y:5}));
  assert(editor.joinDroppedNode(handle));editor.commit();
  assert.equal(plate(first.id).b,plate(target.id).a);assert.equal(plate(mirrored.id).b,plate(opposite.id).a);
  assert.equal(editor.past.length,history+1);editor.undo();assert.deepEqual(editor.source,before);
});

test('isolated plate installation, duplication and removal preserve independent parts', () => {
  const editor = new Editor(bare()), before = structuredClone(editor.source);
  const plate = editor.addPlate({ x: 11, y: 4 }, { x: 12, y: 4 }, { material: 'aluminum', thicknessMm: 12 });
  assert(plate); assert.equal(editor.past.length, 1); assert.equal(editor.blueprint.rooms.length, 1);
  const intent = editor.duplicate(); assert.equal(intent.plates.length, 1); assert.equal(intent.copies.length, 0);
  const copy = editor.addModule(intent.kind, { x: intent.anchor.x, y: intent.anchor.y + 1 }, intent);
  assert(copy); assert.equal(editor.source.plates.length, before.plates.length + 2); assert.equal(editor.past.length, 2);
  editor.remove(); assert.equal(editor.source.plates.length, before.plates.length + 1);
  assert(editor.undo()); assert.equal(editor.source.plates.length, before.plates.length + 2); canonical(editor);
});

test('plate creation and splitting share the native eight-centimetre physical minimum', () => {
  const editor = new Editor(bare()), plate = editor.addPlate({ x: 11, y: 4 }, { x: 11.3, y: 4 }),
    hit = span(editor, plate.id);
  // On the grid the shortest piece that stands is two cells, 10 cm; one cell, 5 cm, is under the minimum.
  assert(editor.splitPlate(hit, { x: 11.1, y: 4 }));
  const first = span(editor, plate.id); near(first.length, .1);
  const before = structuredClone(editor.source), count = editor.past.length;
  assert.equal(editor.splitPlate(first, { x: 11.05, y: 4 }), false);
  assert.match(editor.blockedEdit.message, /8 cm/);
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, count);
  canonical(editor);
});

test('splitting explicit physical ends preserves the complete plate mass and outer material', () => {
  const editor = new Editor(bare()), plate = editor.addPlate({ x: 11, y: 4 }, { x: 12, y: 4 });
  editor.change(source => { source.plates.find(part => part.id === plate.id).ends = { start: 1, end: 2 }; });
  const before = editor.blueprint, hit = span(editor, plate.id), original = structuredClone(editor.source);
  assert(editor.splitPlate(hit, { x: 11.4, y: 4 }));
  near(editor.blueprint.fixedAssembly.mass, before.fixedAssembly.mass);
  const first = editor.source.plates.find(part => part.id === plate.id), rest = editor.source.plates.find(part => part.id === editor.selection);
  assert.deepEqual(first.ends, { start: 1, end: 0 }); assert.deepEqual(rest.ends, { start: 0, end: 2 });
  assert(editor.undo()); assert.deepEqual(editor.source, original); canonical(editor);
});

test('deleting all room walls leaves the explicitly unselected exposed equipment', () => {
  const source = bare(); source.components = [{ id: 'camera', kind: 'sensor', sensorMode: 'visual', pose: { x: 0, y: 50, angle: 0 } }];
  const editor = new Editor(source); editor.select(source.plates.map(plate => plate.id)); editor.remove();
  assert.equal(editor.source.plates.length, 0); assert.equal(editor.source.components.length, 1); assert.equal(editor.blueprint.rooms.length, 0);
  canonical(editor);
});

test('two successive room gestures retain distinct identities and native closed rooms', () => {
  const editor = new Editor(bare()), grow = (id, dy) => {
    const edge = span(editor, id), from = centre(edge);
    editor.begin(); const drawn = editor.drawRoom({ ...edge, source: editor.source }, from, { x: from.x, y: from.y + dy });
    assert(drawn); assert(editor.commit()); return drawn;
  };
  const first = grow('hull:roof', .6), second = grow(first.plates[1], .6),
    ids = [...editor.source.nodes, ...editor.source.plates, ...editor.source.components].map(part => part.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.notEqual(first.plates[0], second.plates[0]); assert.equal(editor.blueprint.rooms.length, 3); canonical(editor);
});

test('independently drawn plates can close a triangular compartment', () => {
  const editor = new Editor(bare()), ids = [
    editor.addPlate({ x: 10, y: 4 }, { x: 12, y: 4 }).id,
    editor.addPlate({ x: 12, y: 4 }, { x: 11, y: 5.5 }).id,
    editor.addPlate({ x: 11, y: 5.5 }, { x: 10, y: 4 }).id,
  ];
  const triangle = editor.blueprint.rooms.find(room => room.walls.every(wall => ids.includes(wall.id)));
  assert(triangle); assert.equal(triangle.walls.length, 3); assert.equal(editor.blueprint.rooms.length, 2);
  canonical(editor);
});

test('a refused tiny split does not change authoring, redo history or saved content', () => {
  const editor = new Editor(bare()); editor.change(source => { source.name = 'Other'; }); assert(editor.undo());
  const original = structuredClone(editor.document), future = structuredClone(editor.future), saved = serializeBlueprint(editor.source), hit = span(editor, 'hull:roof'),
    point = { x: hit.a.x + (hit.b.x - hit.a.x) * .001, y: hit.a.y + (hit.b.y - hit.a.y) * .001 };
  assert.equal(editor.splitPlate(hit, point), false); assert.deepEqual(editor.document, original); assert.deepEqual(editor.future, future);
  assert.equal(serializeBlueprint(editor.source), saved); assert(editor.blockedEdit.points.length); assert(editor.blockedEdit.until > Date.now());
  assert.equal('blockedEdit' in editor.source, false); canonical(editor);
});

test('a horizontal chassis edit or point insertion does not round its resting equipment into the frame', () => {
  const source = withChassisThickness(createStructuredTemplate('tanker'), 100);
  const editor = new Editor(source), original = structuredClone(editor.source), handle = editor.pickChassisPoint(editor.chassisPoints()[1], 1e-6),
    y = editor.source.chassis.points[1].y;
  editor.begin(); assert(editor.moveChassisPoint(handle, { x: handle.x + .2, y: handle.y })); assert(editor.commit());
  assert.equal(editor.source.chassis.points[1].y, y);
  assert.deepEqual(editor.source.components, original.components); assert(editor.undo());
  assert(editor.addChassisPoint({ x: 12 }));
  assert(editor.source.chassis.points.every(point => point.y === y));
  assert.deepEqual(editor.source.components, original.components); canonical(editor);
});
