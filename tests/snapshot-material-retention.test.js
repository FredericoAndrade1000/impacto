import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { Publication } from '../server/publication.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { managedWorld, advance, dent } from './mechanical-queries.js';

const materialWords = plate => JSON.stringify([plate.revision, plate.markRevision, plate.solidRegions, plate.marks]);
const out = (plate, x, y) => ({ x: plate.frame.x + plate.frame.c * x - plate.frame.s * y,
  y: plate.frame.y + plate.frame.s * x + plate.frame.c * y });

test('old snapshot material survives damage, movement, admission, resume and turning while full and delta frames agree', t => {
  const world = managedWorld(t, createConstruction('empty'));
  world.replaceActor(createConstruction('heavy'), { id: 'local' });
  world.game(); world.controlVehicle(0, 1);
  const platesOf = field => field.plates.filter(part => part.actorId === 'local'),
    mesh = platesOf(world).reduce((a, b) => b.definition.thicknessMm > a.definition.thicknessMm ||
      b.definition.thicknessMm === a.definition.thicknessMm && b.definition.length > a.definition.length ? b : a),
    ordinal = platesOf(world).indexOf(mesh), held = [], publication = new Publication(), writer = new FrameWriter(), reader = new FrameReader();
  const read = (field, label) => {
    const state = field.snapshot(), live = platesOf(field)[ordinal], plate = state.plates.find(part => part.id === live?.id);
    assert(plate, label + ': the same plate is present');
    const shown = publication.state(state), packet = { state: shown, events: [] },
      delta = reader.decode(writer.encode(packet, !held.length)),
      full = new FrameReader().decode(new FrameWriter().encode(packet, true));
    assert.deepEqual(delta.state, full.state, label + ': incremental and full frames bring the same state');
    for (const old of held) {
      assert.equal(materialWords(old.plate), old.material, label + ': raw material retained from ' + old.label);
      assert.equal(JSON.stringify(old.shown), old.published, label + ': publication retained from ' + old.label);
    }
    // Keep the original snapshots. Text records expected values; it does not replace either input with a copy.
    held.push({ state, plate, shown, label, material: materialWords(plate), published: JSON.stringify(shown) });
    return { state, plate, shown };
  };
  const first = read(world, 'initial'), thickness = mesh.definition.thicknessMm / 1000,
    face = out(mesh, 0, thickness / 2);
  // A real, asymmetric cut: turning must put what is missing on the other side of the plate.
  assert.equal(world.cutBody(mesh, face, face, thickness / 4).length, 1);
  const cut = read(world, 'cut');
  assert(cut.plate.integrity < first.plate.integrity);
  assert.notDeepEqual(cut.plate.solidRegions, first.plate.solidRegions);

  const mark = (field, plate) => {
    const before = plate.markRevision, point = out(plate, plate.definition.length / 3, 0);
    // The public Native damage command records an actual dent and its surface mark.
    dent(field, plate, point, .002, .01);
    assert(plate.markRevision > before, 'the Native dent added a mark');
    assert(plate.marks.some(item => item.depth > 0), 'the Native mark carries measured depth');
  };
  mark(world, mesh);
  const marked = read(world, 'marked');
  assert(marked.plate.marks.length > 0);
  assert(marked.plate.markRevision > cut.plate.markRevision);

  const start = world.actor('local').vehicle.x;
  world.controlVehicle(.7); advance(world, 12);
  assert(Math.abs(world.actor('local').vehicle.x - start) > 1e-4, 'the vehicle actually moved');
  const moved = read(world, 'moved');
  assert.deepEqual(moved.plate.solidRegions, marked.plate.solidRegions);
  assert.deepEqual(moved.plate.marks, marked.plate.marks);

  world.addActor(createConstruction('empty'), { id: 'visitor', ownerId: 'visitor', x: 100 });
  read(world, 'admitted');
  world.removeActor('visitor');
  read(world, 'removed');

  // This is the real persistence boundary, with no filesystem or saved public field involved.
  const written = JSON.parse(JSON.stringify(world.keep())),
    again = managedWorld(t, createConstruction('empty'));
  again.removeActor('local'); again.resume(written);
  const resumed = read(again, 'resumed');
  assert.deepEqual(resumed.plate.solidRegions, moved.plate.solidRegions);
  assert.deepEqual(resumed.plate.marks, moved.plate.marks);

  const facing = again.actor('local').facing, revision = again.actor('local').revision;
  again.turnActor('local');
  const turned = read(again, 'turned');
  assert.equal(again.actor('local').facing, -facing);
  assert.equal(again.actor('local').revision, revision + 1);
  assert.deepEqual(turned.plate.marks, resumed.plate.marks.map(mark => ({ ...mark, v: 1 - mark.v })));
  assert.notDeepEqual(turned.plate.solidRegions, resumed.plate.solidRegions, 'the asymmetric aperture was mirrored');

  const current = platesOf(again)[ordinal];
  mark(again, current);
  const hitAgain = read(again, 'marked after resume and turn');
  assert(hitAgain.plate.markRevision > turned.plate.markRevision);
  assert.equal(world.dynamics.recoveries, 0);
  assert.equal(again.dynamics.recoveries, 0);
});
