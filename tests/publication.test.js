import test from 'node:test';
import assert from 'node:assert/strict';
import { Publication } from '../server/publication.ts';
import { localToWorld } from '../src/math.ts';
import { FrameWriter, FrameReader, SEATS, posed } from '../src/network-protocol.ts';
import { Fog, chapters } from '../server/fog.ts';
import { SoundSystem } from '../src/audio.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { miningWorld } from './helpers/mining-mobility.js';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

// A field of one vehicle as a snapshot has it: made anew every time, around a design and a suspension the field writes into.
const design = { id: 'a:hull', x: 100, y: 5, angle: 3, length: 4, thicknessMm: 30, anchors: [{ u: 0, v: 0 }] }, spring = { enabled: true, travel: .2, displacement: .01, tilt: 0, compression: .05 };
const snapshot = (time, { dx = 0, turn = 0, fuel = 200, health = 100, marks = [], revision = 1 } = {}) => {
  Object.assign(design, { x: 100 + dx, angle: 3 + turn }); spring.displacement = .01 + dx / 10;
  return { time, weather: 'clear',
    actors: [{ id: 'a', team: 'red', x: 100 + dx, cooldown: 0, aim: { x: 130 + dx, y: 6 }, stats: { shots: 0 }, contactContours: [[{ x: 0, y: 0 }, { x: 1, y: 1 }]], eyes: [{ x: 100.5 + dx, y: 7, left: 1000, right: 1000 }],
      vehicle: { x: 100 + dx, y: 5, angle: turn, vx: dx, vy: 0, massTonnes: 25, fuelLitres: fuel, engine: true, stuck: null } }],
    plates: [{ id: 'a:hull', actorId: 'a', material: 'steel', definition: design,
      solidRegions: [{ minX: -2, maxX: 2 - (revision - 1) * .5, minY: -.015, maxY: .015 }], integrity: 1, revision, marks: marks.slice(), markRevision: marks.length, attached: true }],
    modules: [{ id: 'a:wheel', actorId: 'a', kind: 'wheel', x: 99 + dx, y: 4.4, angle: turn, health, suspension: spring, marks: [], markRevision: 0,
      groundContact: { nx: 0, ny: 1, tx: 1, ty: 0, x: 99 + dx, y: 4, contacts: 3, materials: { gravel: 1 }, minX: 98 + dx, maxX: 100 + dx }, wheelSpin: dx, wheelAngularSpeed: 0 }],
    bodyPanels: [] };
};
// A snapshot as a page reads it: no aim nor tally of a construction, no weight of a vehicle, no nodes of a plate,
// and of a wheel how far its strut gives and where it touches the ground.
const read = state => ({ ...state,
  actors: state.actors.map(({ aim, stats, contactContours, ...actor }) => ({ ...actor, vehicle: actor.vehicle && (({ massTonnes, ...drive }) => drive)(actor.vehicle) })),
  modules: state.modules.map(({ wheelAngularSpeed, ...module }) => ({ ...module, suspension: { displacement: module.suspension.displacement }, groundContact: { x: module.groundContact.x } })) });

test('a part that only trembles is published as it was: the very object, frame after frame', () => {
  const publication = new Publication(), first = publication.state(snapshot(0)), items = state => [state.actors[0], state.plates[0], state.modules[0]];
  assert.deepEqual(first, read(snapshot(0)), 'what is first published is the field as a page reads it'); assert.equal(first.weather, 'clear');
  // Nothing of it is the field's to write into: its design and its suspension are its own.
  assert.notEqual(first.plates[0].definition, design); assert.notEqual(first.modules[0].suspension, spring);
  // A millimetre, a tenth of a milliradian, a drop of fuel: every part is the object it was, and its design says what it said.
  for (const turn of [1, 2, 3]) {
    const next = publication.state(snapshot(turn, { dx: .001 * (turn % 2), turn: 1e-4, fuel: 199.99 }));
    assert.deepEqual(items(next).map((item, index) => item === items(first)[index]), [true, true, true]); assert.equal(next.time, turn);
    assert.deepEqual(next.plates[0].definition, { ...design, x: 100, angle: 3 });
  }
  // On the wire such a frame says nothing of them.
  const writer = new FrameWriter(), reader = new FrameReader(), told = [first, publication.state(snapshot(4, { dx: .0015 }))].map((state, turn) => reader.decode(writer.encode({ type: 'frame', state }, !turn)).state);
  assert.equal(told[1].plates[0], told[0].plates[0]); assert.equal(told[1].modules[0], told[0].modules[0]); assert.equal(told[1].actors[0], told[0].actors[0]);
});

test('what went farther is published as it is, and the rest of the part as it was', () => {
  const publication = new Publication(), first = publication.state(snapshot(0));
  // The vehicle goes three millimetres on, with a jitter in its angle: its place is told, its angle is not.
  const moved = publication.state(snapshot(1, { dx: .003, turn: 1e-4 })), [actor, plate, wheel] = [moved.actors[0], moved.plates[0], moved.modules[0]];
  assert.equal(actor.x, 100.003); assert.deepEqual([actor.vehicle.x, actor.vehicle.angle, actor.vehicle.vx], [100.003, 0, 0]); assert.equal(actor.eyes[0].x, 100.503);
  assert.equal('aim' in actor || 'stats' in actor || 'contactContours' in actor, false, 'no aim, tally or immutable contact geometry that no page reads');
  assert.deepEqual([plate.definition.x, plate.definition.angle], [100.003, 3]); assert.equal(plate.definition.anchors, first.plates[0].definition.anchors);
  // The shape and the marks, which their counts say are what they were, are the very ones: a page draws them where the design is.
  for (const key of ['solidRegions', 'marks']) assert.equal(plate[key], first.plates[0][key], key);
  assert.deepEqual([wheel.x, wheel.angle, wheel.groundContact], [99.003, 0, { x: 99.003 }]);
  assert.equal(wheel.suspension, first.modules[0].suspension, 'a suspension that sank a third of a millimetre');
  // Nothing drifts: it creeps on by nine tenths of a millimetre a frame, and is published every time it is more than two from where it was published.
  const creep = turn => .003 + .0009 * (turn - 1), places = [2, 3, 4, 5, 6, 7].map(turn => publication.state(snapshot(turn, { dx: creep(turn) })).actors[0].vehicle.x);
  assert.deepEqual(places, [1, 1, 4, 4, 4, 7].map(turn => 100 + creep(turn)));
  // What has no slack is told at once: a health, a mark. The part it is of stays where it was published.
  const hit = publication.state(snapshot(8, { dx: creep(7) + .001, health: 99.999, marks: [{ u: .5 }] }));
  assert.equal(hit.modules[0].health, 99.999); assert.equal(hit.modules[0].x, 99 + creep(7)); assert.deepEqual(hit.plates[0].marks, [{ u: .5 }]);
  assert.equal(hit.plates[0].definition.x, 100 + creep(7)); assert.equal(hit.plates[0].solidRegions, first.plates[0].solidRegions);
  // A shape that changed is told, wherever the plate is.
  const cut = publication.state(snapshot(9, { dx: creep(7) + .001, health: 99.999, marks: [{ u: .5 }], revision: 2 }));
  assert.notEqual(cut.plates[0].solidRegions, hit.plates[0].solidRegions);
  assert.equal(cut.plates[0].solidRegions[0].maxX, 1.5); assert.equal(cut.modules[0], hit.modules[0]);
});

test('a part that came is published as it is, one that lost a field without it, and one that left is forgotten', () => {
  const publication = new Publication(), first = publication.state(snapshot(0)), other = snapshot(1);
  other.actors.push({ id: 'b', team: 'blue', x: 500, vehicle: null }); delete other.modules[0].groundContact;
  const next = publication.state(other);
  assert.equal(next.actors[0], first.actors[0]); assert.deepEqual(next.actors[1], { id: 'b', team: 'blue', x: 500, vehicle: null });
  assert.equal('groundContact' in next.modules[0], false); assert.equal(next.modules[0].suspension, first.modules[0].suspension);
  // Gone and back, it is published anew: nothing was kept of it, nor of where it sat on its vehicle.
  const gone = snapshot(2); gone.plates = []; publication.state(gone);
  const again = snapshot(3); again.plates[0].definition = { ...again.plates[0].definition, x: 100.001 };
  assert.equal(publication.state(again).plates[0].definition.x, 100.001);

  // The control keeps the original module transform, independent of its optional filtered reader.
  const originalMove = (module, body, to) => {
    if (!posed(module)) return module;
    const pose = to.pose(body, module), ground = module.groundContact;
    return { ...module, ...pose, ...(Number.isFinite(ground?.x) ? { groundContact: { ...ground, x: to.ground(ground.x, module, pose) } } : {}) };
  }, control = new Publication(), filtered = new Publication(), retained = [];
  for (let step = 0; step < 8; step++) {
    const input = snapshot(20 + step, { dx: step * .003, turn: step * .01, health: step === 1 ? NaN : step === 2 ? -0 : 100 }),
      module = input.modules[0];
    module.suspension = { ...module.suspension };
    if (step === 1) { module.reload = NaN; module.marks = [{ u: .3 }]; module.suspension.displacement += .003; }
    if (step === 2) { module.reload = -0; delete module.groundContact; }
    if (step === 3) {
      Object.defineProperty(module, 'x', { value: module.x, enumerable: false });
      module.marks = [{ u: .4 }]; module.markRevision = 1;
    }
    if (step === 4) {
      const x = module.x; delete module.x; Object.setPrototypeOf(module, { x, inheritedField: 'not published by a posed spread' });
    }
    if (step === 5) { module.reload = 0; module.marks = [{ u: .5 }]; module.markRevision = 2; }
    if (step === 6) { module.angle = NaN; module.groundContact.x = -0; }
    if (step === 7) { delete module.suspension; module.marks = [{ u: .6 }]; module.markRevision = 3; }
    Object.freeze(module.suspension); Object.freeze(module.groundContact); Object.freeze(module.marks); Object.freeze(module);
    const unchanged = JSON.stringify(input), move = SEATS.modules.move;
    let expected;
    SEATS.modules.move = (item, body, to, read) => {
      const moved = originalMove(item, body, to);
      return read ? read(moved) : moved;
    };
    try { expected = control.state(input); } finally { SEATS.modules.move = move; }
    const actual = filtered.state(input);
    assert.deepEqual(actual, expected, 'module transform/filter parity at ' + step);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), 'property insertion order at ' + step);
    assert.equal(JSON.stringify(input), unchanged, 'neither path writes into the source at ' + step);
    assert.notEqual(actual.modules[0], module, 'the retained module is still owned');
    if (step === 1) assert.deepEqual(actual.modules[0].marks, [], 'FOLLOWS keeps marks until markRevision changes');
    if (step === 3) assert.deepEqual(actual.modules[0].marks, [{ u: .4 }]);
    if (step === 4) assert.equal(Object.hasOwn(actual.modules[0], 'inheritedField'), false);
    for (const old of retained) assert.deepEqual(old.state, old.copy, 'later source/pose changes cannot mutate retained publication');
    retained.push({ state: actual, copy: structuredClone(actual) });
  }
});

test('where a running gear touches the ground goes with the gear, to a centimetre, and the eyes of a construction with its vehicle', () => {
  const publication = new Publication(), contact = state => state.modules[0].groundContact.x - state.modules[0].x;
  publication.state(snapshot(0));
  // Half a metre on, its contact rolled eight millimetres along the gear: it touches the ground where it did, from the gear.
  const rolled = snapshot(1, { dx: .5 }); rolled.modules[0].groundContact = { ...rolled.modules[0].groundContact, x: 99.508 };
  const moved = publication.state(rolled);
  assert.equal(moved.modules[0].x, 99.5); assert.equal(contact(moved), 0);
  // Rolled farther than a centimetre along it, it is published where it is.
  const farther = snapshot(2, { dx: .5 }); farther.modules[0].groundContact = { ...farther.modules[0].groundContact, x: 99.512 };
  assert(Math.abs(contact(publication.state(farther)) - .012) < 1e-9);
  // The eye looks from where it sits on the vehicle, wherever the vehicle is published to be.
  for (const dx of [1, 1.001, 3]) {
    const { vehicle, eyes: [eye] } = publication.state(snapshot(3 + dx, { dx })).actors[0];
    assert.deepEqual([eye.x - vehicle.x, eye.y - vehicle.y, eye.left], [.5, 2, 1000], String(dx));
  }
  // Several eyes keep their order and published positions when only the middle one moves beyond slack.
  const initial = snapshot(10);
  initial.actors[0].eyes.push({ x: 101.5, y: 7, left: 900, right: 900 }, { x: 102.5, y: 7, left: 800, right: 800 });
  const first = publication.state(initial), history = JSON.stringify(first), eyes = first.actors[0].eyes,
    tremble = snapshot(11);
  tremble.actors[0].eyes = initial.actors[0].eyes.map(eye => ({ ...eye, x: eye.x + .001 }));
  const unchanged = publication.state(tremble);
  assert.equal(unchanged.actors[0].eyes, eyes, 'all three remain the retained list within slack');
  const middle = snapshot(12);
  middle.actors[0].eyes = tremble.actors[0].eyes.map(eye => ({ ...eye }));
  middle.actors[0].eyes[1].x = 101.51;
  const changed = publication.state(middle);
  assert.notEqual(changed.actors[0].eyes, eyes);
  assert.deepEqual(changed.actors[0].eyes.map(eye => eye.x), [100.5, 101.51, 102.5], 'the prefix and suffix keep their published positions');
  assert.equal(JSON.stringify(first), history, 'later readings do not write into the retained frame');
  const writer = new FrameWriter(), reader = new FrameReader();
  for (const [index, state] of [first, unchanged, changed].entries()) {
    const delta = reader.decode(writer.encode({ state }, index === 0)), full = new FrameReader().decode(new FrameWriter().encode({ state }, true));
    assert.deepEqual(delta.state, full.state, 'several eyes agree on full and incremental frames');
  }
});

test('a plate or a piece that sits on a vehicle goes where the vehicle is published to be, rigidly', () => {
  const publication = new Publication(), first = publication.state(snapshot(0)), seat = state => state.plates[0].definition.x - state.actors[0].vehicle.x;
  // The vehicle goes on by a millimetre a frame, the hull with it, and the wheel sinks on its strut: the hull is published
  // where the vehicle is published to be, the very object until the vehicle is told elsewhere.
  const states = [1, 2, 3, 4].map(turn => publication.state(snapshot(turn, { dx: .001 * turn })));
  assert.deepEqual(states.map(state => state.plates[0] === first.plates[0]), [true, true, false, false]);
  for (const state of states) assert.equal(seat(state), 0, 'it sits where it sat');
  assert.equal(states[2].plates[0].definition.x, states[2].actors[0].vehicle.x);
  // A part that moved on its vehicle farther than a page shows is published where it is.
  const shifted = snapshot(5, { dx: .004 }); shifted.plates[0].definition = { ...shifted.plates[0].definition, x: 100.0065 };
  const moved = publication.state(shifted); assert(Math.abs(seat(moved) - .0025) < 1e-12, String(seat(moved)));
  // Turned, it is where the turn takes it, with its angle on the vehicle as it was.
  const turning = snapshot(6, { dx: .004, turn: .01 });
  turning.plates[0].definition = { ...turning.plates[0].definition, x: 100.004 + .0025 * Math.cos(.01), y: 5 + .0025 * Math.sin(.01) };
  const turned = publication.state(turning), { x, y } = turned.actors[0].vehicle;
  assert(Math.abs(turned.plates[0].definition.angle - turned.actors[0].vehicle.angle - 3) < 1e-12);
  assert(Math.hypot(turned.plates[0].definition.x - x - .0025 * Math.cos(.01), turned.plates[0].definition.y - y - .0025 * Math.sin(.01)) < 1e-12);
});

test('exact and retained vehicle angles keep off-centre parts, eyes and ground together', t => {
  const publication = new Publication(), writer = new FrameWriter(), reader = new FrameReader(), angle = .37,
    plateOffset = [2.125, .75], wheelOffset = [-1.375, -.625], eyeOffsets = [[.375, 2.25], [-.75, 1.875]], history = [];
  t.after(() => writer.close());
  const input = (time, dx, turn) => {
    const vehicle = { x: 100 + dx, y: 5 + dx, angle: angle + turn, vx: 0, vy: 0 },
      place = offset => localToWorld(vehicle, ...offset), wheel = place(wheelOffset);
    return { time, weather: 'clear',
      actors: [{ id: 'a', team: 'red', x: vehicle.x, vehicle,
        eyes: eyeOffsets.map((offset, index) => ({ ...place(offset), left: 900 - index * 100, right: 1000 })) }],
      plates: [{ id: 'a:hull', actorId: 'a', material: 'steel', attached: true,
        definition: { ...place(plateOffset), angle: vehicle.angle + .9, length: 4, thicknessMm: 30 } }],
      modules: [{ id: 'a:wheel', actorId: 'a', kind: 'wheel', ...wheel, angle: vehicle.angle - .25,
        health: 100, wheelSpin: -0, reload: .5, suspension: { displacement: .01 }, groundContact: { x: wheel.x + .125 } }],
      bodyPanels: [] };
  };
  for (const [step, [dx, turn, toldAngle]] of [[0, 0, angle], [.004, .0001, angle],
    [.0041, .00011, angle], [.01, .02, angle + .02]].entries()) {
    const raw = input(step, dx, turn), untouched = structuredClone(raw), shown = publication.state(raw),
      actor = shown.actors[0], body = actor.vehicle, plate = shown.plates[0].definition, wheel = shown.modules[0],
      at = offset => localToWorld(body, ...offset);
    assert.equal(body.angle, toldAngle, 'only an angle beyond slack is published');
    if (step === 1 || step === 2) assert.notEqual(body.angle, raw.actors[0].vehicle.angle, 'exact and published rotations really differ');
    for (const [index, offset] of eyeOffsets.entries()) {
      const point = at(offset);
      assert.deepEqual([actor.eyes[index].x, actor.eyes[index].y, actor.eyes[index].left], [point.x, point.y, 900 - index * 100]);
    }
    const plateAt = at(plateOffset), wheelAt = at(wheelOffset);
    assert.deepEqual([plate.x, plate.y, plate.angle], [plateAt.x, plateAt.y, body.angle + .9]);
    assert.deepEqual([wheel.x, wheel.y, wheel.angle, wheel.groundContact], [wheelAt.x, wheelAt.y, body.angle - .25, { x: wheelAt.x + .125 }]);
    assert(Object.is(wheel.wheelSpin, -0)); assert.equal(wheel.reload, .5);
    if (step === 1) assert.notEqual(shown.plates[0], history[0].state.plates[0], 'a vehicle that moved carries its plate');
    if (step === 2) for (const name of ['actors', 'plates', 'modules'])
      assert.equal(shown[name][0], history[1].state[name][0], name + ': tremble keeps the retained item');
    assert.deepEqual(raw, untouched, 'publication never writes a basis or a pose into the source');
    for (const old of history) assert.deepEqual(old.state, old.copy, 'later calls cannot change an earlier publication');
    const incremental = reader.decode(writer.encode({ state: shown }, step === 0)).state,
      full = new FrameReader().decode(new FrameWriter().encode({ state: shown }, true)).state;
    assert.deepEqual(incremental, full, 'off-centre geometry agrees on full and incremental frames');
    history.push({ state: shown, copy: structuredClone(shown) });
  }
});

test('native driving reaches owner audio through snapshot, publication, fog and delta frames without revealing the pedals or engine figures to an observer', async t => {
  for (const mode of ['pedal', 'reverse']) {
    const world = miningWorld(createStructuredTemplate('scout'), { grade: -.1, cargo: null }),
      publication = new Publication(), fog = new Fog(), ends = [];
    t.after(() => world.dispose());
    assert.equal(world.vehicle.snapshot().driveSpeed, world.vehicle.driveSpeed, 'a cold snapshot projects the accepted native target too');
    for (let i = 0; i < 2; i++) {
      const ctx = fakeAudioContext(), sound = new SoundSystem({ contextFactory: () => ctx,
        storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() }), writer = new FrameWriter();
      await sound.unlock(); sound.setActive(true);
      ends.push({ ctx, sound, writer, reader: new FrameReader() });
      t.after(() => { sound.stop(); writer.close(); });
    }
    world.controlVehicle(1, 0);
    for (let tick = 0; tick < 180; tick++) { world.step(); world.drainEvents(); }
    assert(world.vehicle.vx > 2, 'native propulsion creates the incoming speed; no pose or velocity is injected');
    const tell = whole => {
      const snapshot = world.snapshot(), actor = snapshot.actors.find(a => a.id === 'local'), published = publication.state(snapshot), parts = chapters(published);
      fog.read({ sight: { observer: [{ actorId: actor.id, channel: 'visual', visible: true,
        x: actor.vehicle.x, y: actor.vehicle.y, error: .5, by: 'observer-eye' }] } }, snapshot.time);
      for (const [index, end] of ends.entries()) {
        const state = end.reader.decode(end.writer.encode({ state: fog.tell(published, parts, index ? 'observer' : actor.team) }, whole)).state,
          told = state.actors.find(a => a.id === actor.id).vehicle;
        for (const key of ['throttle', 'brake', 'driveSpeed', 'maxSpeed', 'powerKw']) {
          assert(Number.isFinite(actor.vehicle[key]), `Native supplies ${key}`);
          if (!index) assert.equal(told[key], actor.vehicle[key], `the owner receives the real ${key}`);
          else assert.equal(Object.hasOwn(told, key), false, `the observer is never told ${key}`);
        }
        end.ctx.advance(snapshot.time);
        end.sound.receive(state, [], { listener: { x: actor.vehicle.x, y: actor.vehicle.y, width: 16, height: 9, zoom: 1 } });
      }
      return actor.vehicle;
    };
    tell(true);
    world.controlVehicle(mode === 'pedal' ? 0 : -1, mode === 'pedal' ? 1 : 0); world.step(); world.drainEvents();
    const braking = tell(false);
    assert(braking.vx > .8 && braking.traction > 0); assert.equal(braking.driveSpeed, 0);
    assert.equal(braking.brake, mode === 'pedal' ? 1 : 0, 'reverse braking is the native target, not a synthesized pedal');
    for (const [index, { ctx }] of ends.entries()) {
      const heard = profile => ctx.nodes.filter(node => node.buffer?.url === `${profile}.mp3` && node.starts.length);
      assert.equal(heard('brake-air').length, 0, 'the retired pneumatic layer never plays');
      assert.equal(heard('brake-squeal').length, index ? 0 : 1, mode);
      if (!index) assert.equal(heard('brake-squeal')[0].loop, true, 'native braking drives the approved held metal loop');
      else assert.equal(heard('engine-turbo').length, 0, 'private drive telemetry is not inferred for an observer');
      assert(heard('diesel').length > 0, 'the observer still hears the ordinary visible engine');
    }
    tell(false);
    for (const [index, { ctx }] of ends.entries()) {
      const metal = ctx.nodes.filter(node => node.buffer?.url === 'brake-squeal.mp3' && node.starts.length);
      assert.equal(metal.length, index ? 0 : 1, 'a repeated native/delta state keeps one loop instead of making another onset');
      if (!index) assert.equal(metal[0].stops.length, 0);
    }
  }
});

test('synchronous publication snapshots own their modules and match copied snapshots through motion, braking and turning', t => {
  const world = miningWorld(createStructuredTemplate('scout'), { grade: -.1, cargo: null }), held = [],
    paths = [0, 1].map(() => ({ publication: new Publication(), fog: new Fog(),
      viewers: [0, 1].map(() => ({ writer: new FrameWriter(), reader: new FrameReader(), full: new FrameWriter() })) }));
  t.after(() => { for (const path of paths) for (const viewer of path.viewers) { viewer.writer.close(); viewer.full.close(); } world.dispose(); });
  const outer = state => state.modules.map(module => [module.id, module.x, module.y, module.angle, module.health, module.wheelSpin]),
    capture = label => {
      world.game().sync();
      const wheel = world.modules.find(module => module.kind === 'wheel');
      assert(wheel, 'the real vehicle has a wheel');
      // This unread projection field exercises signed zero without injecting mechanical motion.
      wheel.wheelAngularSpeed = -0;
      const raw = world.snapshot(), rawWheel = raw.modules.find(module => module.id === wheel.id);
      assert.notEqual(raw.modules, world.modules, label + ': generic snapshots keep their list');
      for (const module of raw.modules) assert.notEqual(module, world.modules.find(live => live.id === module.id));
      assert.equal(Object.is(wheel.wheelAngularSpeed, -0), true, 'the generic snapshot did not normalize the live module');
      assert.equal(Object.is(rawWheel.wheelAngularSpeed, -0), false); assert.equal(rawWheel.wheelAngularSpeed, 0);
      const copied = paths[0].publication.state(raw), borrowed = world.snapshot(state => paths[1].publication.state(state)),
        states = [copied, borrowed], actor = raw.actors.find(item => item.id === 'local');
      assert.deepEqual(borrowed, copied, label + ': complete publication agrees');
      for (const state of states) {
        assert.notEqual(state.modules, world.modules);
        for (const module of state.modules) {
          assert.notEqual(module, world.modules.find(live => live.id === module.id), label + ': retained outer module is owned');
          assert.equal(Object.hasOwn(module, 'wheelAngularSpeed'), false, 'the unread field stays private');
        }
      }
      const decoded = paths.map((path, index) => {
        path.fog.read({ sight: { observer: [{ actorId: actor.id, channel: 'visual', visible: true,
          x: actor.vehicle.x, y: actor.vehicle.y, error: .5, by: 'observer-eye' }] } }, raw.time);
        const parts = chapters(states[index]);
        return path.viewers.map((viewer, observer) => {
          const state = path.fog.tell(states[index], parts, observer ? 'observer' : actor.team), packet = { state },
            delta = viewer.reader.decode(viewer.writer.encode(packet, !held.length)).state,
            full = new FrameReader().decode(viewer.full.encode(packet, true)).state,
            vehicle = delta.actors.find(item => item.id === actor.id).vehicle;
          assert.deepEqual(delta, full, label + ': full and delta agree');
          for (const key of ['throttle', 'brake', 'driveSpeed', 'maxSpeed', 'powerKw']) {
            if (observer) assert.equal(Object.hasOwn(vehicle, key), false, label + ': observer is not told ' + key);
            else assert.equal(vehicle[key], actor.vehicle[key], label + ': owner keeps ' + key);
          }
          return delta;
        });
      });
      assert.deepEqual(decoded[1], decoded[0], label + ': both perspectives agree after fog and decoding');
      for (const old of held) {
        assert.deepEqual(outer(old.raw), old.outer, label + ': generic module copies retained from ' + old.label);
        assert.deepEqual(old.states.map(state => JSON.stringify(state)), old.words, label + ': publications retained from ' + old.label);
      }
      held.push({ raw, outer: outer(raw), states, words: states.map(state => JSON.stringify(state)), label });
      return raw;
    };
  const first = capture('initial'), start = world.vehicle.x;
  world.controlVehicle(1, 0);
  for (let tick = 0; tick < 60; tick++) { world.step(); world.drainEvents(); }
  const moved = capture('moved');
  assert(Math.abs(world.vehicle.x - start) > 1e-4, 'Native propulsion actually moved the vehicle');
  assert.notDeepEqual(outer(moved), outer(first), 'module poses or running gear actually changed');
  world.controlVehicle(0, 1); world.step(); world.drainEvents();
  assert.equal(capture('braked').actors.find(actor => actor.id === 'local').vehicle.brake, 1);
  const wheel = world.modules.find(module => module.kind === 'wheel'), health = wheel.health - .1;
  world.command('setPartState', { owner: world.game().handle(wheel), state: { health } });
  assert.equal(capture('module changed').modules.find(module => module.id === wheel.id).health, health);
  const facing = world.actor('local').facing;
  world.turnActor('local'); capture('turned');
  assert.equal(world.actor('local').facing, -facing, 'a real readmission mirrored the construction');
  assert.equal(world.dynamics.recoveries, 0);
});
