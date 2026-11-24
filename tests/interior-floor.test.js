import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { CONSTRUCTION_ORIGIN, compileDraftConstruction, createStructuredConstruction } from '../src/structured-construction.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();

test('floor thickness does not move unselected roof nodes or equipment', () => {
  const box = createStructuredConstruction({ length: 6, height: 3, thicknessMm: 8, frontInset: 0, rearInset: 0 }),
    source = { ...box, components: [{ id: 'fuel', kind: 'fuel', pose: { x: 0, y: 16, angle: 0 } }] },
    editor = new Editor(source), before = structuredClone(editor.source), original = editor.blueprint,
    fuel = original.modules.find(part => part.id === 'fuel'), roof = original.plates.find(part => part.id === 'hull:roof'),
    floor = original.plates.find(part => part.id === 'chassis:top-0');
  assert(floor, 'the chassis supplies the real floor');
  assert.equal(before.chassis.topPlate.thicknessMm, 8); assert.equal(floor.thicknessMm, 8);
  editor.select(floor.id); assert.equal(editor.selected?.id, floor.id);
  editor.editProperty('thicknessMm', 200, true);
  assert.equal(editor.source.chassis.topPlate.thicknessMm, 200);
  assert.equal(editor.blueprint.plates.find(part => part.id === floor.id).thicknessMm, 200);
  assert.deepEqual(editor.source.nodes, before.nodes);
  assert.deepEqual(editor.source.components, before.components);
  assert.deepEqual(editor.blueprint.frame.origin, CONSTRUCTION_ORIGIN);
  for (const [part, previous] of [[editor.blueprint.modules.find(part => part.id === 'fuel'), fuel],
    [editor.blueprint.plates.find(part => part.id === 'hull:roof'), roof]])
    for (const field of ['x', 'y', 'angle']) assert.equal(part[field], previous[field]);
  assert.equal(editor.past.length, 1);
  assert(editor.undo()); assert.deepEqual(editor.source, before);
  assert.equal(editor.blueprint.plates.find(part => part.id === floor.id).thicknessMm, 8);
});

test('a component uses its exact signed pose independently of room grid and closure', () => {
  const box = createStructuredConstruction({ length: 6, height: 3, thicknessMm: 8 }),
    // In cells (grid.ts): 3.65 m ahead, past the box, and 0.65 m under the reference.
    pose = { x: 73, y: -13, angle: .17 },
    open = { ...box, plates: box.plates.filter(plate => plate.id !== 'hull:roof'),
      components: [{ id: 'fuel', kind: 'fuel', pose }] },
    compiled = compileDraftConstruction(open), fuel = compiled.modules.find(part => part.id === 'fuel');
  assert.equal(compiled.rooms.length, 0);
  assert(Math.abs(fuel.x - (CONSTRUCTION_ORIGIN.x + metresOf(pose.x))) < 1e-9);
  assert(Math.abs(fuel.y - (CONSTRUCTION_ORIGIN.y + metresOf(pose.y))) < 1e-9);
  assert.equal(fuel.angle, pose.angle); assert.equal(fuel.exposed, true);
  assert.deepEqual(open.components[0].pose, pose);
});
