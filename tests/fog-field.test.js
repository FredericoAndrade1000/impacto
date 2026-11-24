import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { rehearsal } from '../server/room.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { chapters, aloft, witnessed, GHOST_SECONDS } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { serveNetwork } from './helpers/network.js';
import { decodeFrame, FrameLedger, FrameWriter, FrameReader, tellEvent, packEvents, NETWORK_VERSION, UNREAD_EVENT_FIELDS } from '../src/network-protocol.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { STRESS_FIELD } from '../server/stress-field.ts';
import { shotCount, listShots, SHOT_WORDS, SHOT_NUMBER } from '../src/shots.ts';
import { CALM_SECONDS, CAPTURE_SECONDS } from '../src/economy.ts';
import { controlContext } from '../src/ui-model.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { Renderer } from '../src/render.ts';
import { onField } from './helpers/field.js';

// A construction as a state has it: plates with their design and material regions, a module, and a
// panel that is the same object state after state. `turn` moves it.
const fixed = new Map();
const built = (id, x, turn = 0) => {
  if (!fixed.has(id)) fixed.set(id, { bodyPanels: [{ id: id + ':panel', actorId: id, outline: [0, 0, 1, 0, 1, 1] }] });
  return { actor: { id, x: x + turn, vehicle: { x: x + turn, y: 1, vx: turn } },
    plates: [0, 1].map(k => ({ id: `${id}:plate${k}`, actorId: id, definition: { x: x + turn + k, y: 1, angle: turn / 10, length: 2, thicknessMm: 100, material: 'steel' },
      solidRegions: [{ minX: -1, maxX: 1, minY: -.05, maxY: .05 }], revision: 1 })),
    modules: [{ id: id + ':gun', actorId: id, x: x + turn, health: 10, aim: { x: turn, y: 2 } }], ...fixed.get(id) };
};
const state = (time, ...parts) => ({ time, shared: true, actors: parts.map(p => p.actor), plates: parts.flatMap(p => p.plates),
  modules: parts.flatMap(p => p.modules), bodyPanels: parts.flatMap(p => p.bodyPanels) });
// A state as any reader would have it from a whole frame.
const plain = sent => new FrameReader().decode(new FrameWriter().encode({ state: sent }, true)).state;
const header = buffer => JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, new DataView(buffer).getUint32(4, true))));

test('a list says which of its items stay and tells whole only those that came', () => {
  const writer = new FrameWriter(), reader = new FrameReader(), a = built('a', 0), b = built('b', 50), c = built('c', 90);
  const send = (sent, whole) => { const buffer = writer.encode({ type: 'frame', state: sent }, whole), packet = reader.decode(buffer);
    assert.deepEqual(packet.state, plain(sent)); return buffer; };
  send(state(0, a, b), true);
  // Nothing changed: a frame of the same objects is its clock alone.
  const still = send(state(1, a, b));
  assert.deepEqual(header(still).state, { time: 1 });
  // One comes into the state: it is told whole, and the frame says where the others stand.
  const entering = send(state(2, a, c, b)), told = header(entering).state;
  assert.deepEqual(told.actors, { $list: 3, from: [0, 1, -1, 1, 1, 1], at: [1], with: [JSON.parse(JSON.stringify(c.actor))] });
  assert.deepEqual([told.plates.from, told.plates.at], [[0, 2, -1, 2, 2, 2], [2, 3]]);
  const alone = new FrameWriter().encode({ type: 'frame', state: state(2, c) }, true);
  assert(entering.byteLength < alone.byteLength + 400, `what came costs what it is: ${entering.byteLength} against ${alone.byteLength} for itself alone`);
  // One leaves: the frame says which stay, and nothing of them.
  const leaving = send(state(3, c, b));
  assert.deepEqual(header(leaving).state.actors, { $list: 2, from: [1, 2], at: [], with: [] });
  assert(leaving.byteLength < still.byteLength + 300, `leaving costs ${leaving.byteLength - still.byteLength} bytes: some numbers for each list`);
  // They change places and one of them moves: the order is told, and of the items only what changed.
  const moved = built('b', 50, 3), turned = send(state(4, moved, c)), plates = header(turned).state.plates;
  assert.deepEqual(plates.from, [2, 2, 0, 2]); assert.deepEqual(plates.at, [0, 1]);
  assert.deepEqual(Object.keys(plates.with[0]), ['definition'], 'a plate that moved tells only its new pose');
  assert.deepEqual(Object.keys(plates.with[0].definition.$set).sort(), ['angle', 'x'], 'and of its design the fields that changed');
  assert.equal(new FrameReader().decode(turned), null, 'a reader that has not the frame before asks for a whole one');
  // A list that is gone from the state, and one that comes back.
  const bare = { time: 5, shared: true, actors: [], plates: [] };
  assert.deepEqual(reader.decode(writer.encode({ type: 'frame', state: bare })).state, plain(bare));
  send(state(6, a));
});

test('a frame that names items a reader never had is refused', () => {
  // A frame put together wrong is no state: the reader asks again rather than show it.
  const forged = from => {
    const writer = new FrameWriter(), good = new FrameReader();
    good.decode(writer.encode({ state: { actors: [{ id: 'a' }] } }, true));
    // Reserve header space, then corrupt only the list of an actual delta packet in place.
    const buffer = writer.encode({ state: { actors: [] }, padding: ' '.repeat(128) }), packet = header(buffer);
    delete packet.padding; packet.state.actors = { $list: 2, from, at: [], with: [] };
    const text = new TextEncoder().encode(JSON.stringify(packet)), bytes = new Uint8Array(buffer, 8, new DataView(buffer).getUint32(4, true));
    assert(text.length <= bytes.length); bytes.fill(32); bytes.set(text);
    return good.decode(buffer);
  };
  for (const from of [[0, 2], [1, 1, 0, 1], [0, 1, -1, 1], [0, 1.5], [0, -1], [-1, 2]]) assert.equal(forged(from), null, JSON.stringify(from));
  assert.deepEqual(forged([0, 1, 0, 1]).state.actors, [{ id: 'a' }, { id: 'a' }]);
});

test('the very object told before costs nothing, on a frame of changes or on a whole one', () => {
  const writer = new FrameWriter(), reader = new FrameReader(), ghost = built('b', 50);
  const send = (sent, whole) => { const buffer = writer.encode({ type: 'frame', state: sent }, whole); assert.deepEqual(reader.decode(buffer).state, plain(sent)); return buffer; };
  const lone = new FrameWriter(), only = turn => lone.encode({ type: 'frame', state: state(turn, built('a', 0, turn)) }, turn === 0);
  send(state(0, built('a', 0), ghost), true); only(0);
  for (let turn = 1; turn < 5; turn++) {
    const both = send(state(turn, built('a', 0, turn), ghost)), one = only(turn);
    assert(both.byteLength - one.byteLength <= 8, `a construction that stands as it was told adds ${both.byteLength - one.byteLength} bytes to a frame`);
  }
  // A whole state tells it as it stands in the objects kept, whatever became of the construction since.
  const whole = header(send(state(5, built('a', 0, 5), ghost), true)).state;
  assert.equal(whole.plates[2].definition.x, 50); assert.equal(whole.actors[1].x, 50);
});

test('of the marks left on a part a frame tells those that came, and of a vehicle and a running gear the fields that changed', () => {
  const writer = new FrameWriter(), reader = new FrameReader(), mark = n => ({ u: n / 100, v: .5, kind: 'dent', strength: n }), first = [1, 2, 3, 4].map(mark);
  const part = (marks, more = {}) => ({ id: 'wheel', actorId: 'a', x: 1, marks, markRevision: marks.length, suspension: { enabled: true, travel: .2, displacement: .01, tilt: 0 },
    groundContact: { nx: 0, ny: 1, x: 3, y: 0, contacts: 2, materials: { gravel: 1 } }, ballisticScars: { '0:1': .5 }, ...more });
  const tank = (x, fuel) => ({ id: 'a', x, vehicle: { x, y: 1, angle: 0, massTonnes: 25, maxSpeed: 18, fuelLitres: fuel, engine: true, stuck: null } });
  const frame = (actor, module, whole = false) => { const sent = { time: 0, actors: [actor], plates: [], modules: [module], bodyPanels: [] },
    buffer = writer.encode({ type: 'frame', state: sent }, whole), told = reader.decode(buffer).state; assert.deepEqual(told, plain(sent)); return header(buffer).state; };
  frame(tank(0, 200), part(first), true);
  // Nothing came to the list: the very marks, in a list made anew as a snapshot makes it, say nothing.
  assert.equal(frame(tank(0, 200), part(first.slice())).modules, undefined);
  // Two more come: they alone are told. Then the list, full, loses its oldest for each that comes; then its last one is deepened.
  const grown = [...first, mark(5), mark(6)];
  assert.deepEqual(frame(tank(0, 200), part(grown)).modules.with, [{ marks: { $queue: [0, 4], more: [mark(5), mark(6)] }, markRevision: 6 }]);
  const turned = [...grown.slice(2), mark(7), mark(8)];
  assert.deepEqual(frame(tank(0, 200), part(turned, { markRevision: 8 })).modules.with, [{ marks: { $queue: [2, 4], more: [mark(7), mark(8)] }, markRevision: 8 }]);
  const deepened = [...turned.slice(0, 5), { ...mark(8), strength: 9 }];
  assert.deepEqual(frame(tank(0, 200), part(deepened, { markRevision: 9 })).modules.with, [{ marks: { $queue: [0, 5], more: [{ ...mark(8), strength: 9 }] }, markRevision: 9 }]);
  // A list that is another is told whole, and one that emptied too.
  assert.deepEqual(frame(tank(0, 200), part([mark(40), mark(41)], { markRevision: 10 })).modules.with[0].marks, { $queue: [0, 0], more: [mark(40), mark(41)] });
  assert.deepEqual(frame(tank(0, 200), part([], { markRevision: 11 })).modules.with[0].marks, { $queue: [0, 0], more: [] });
  // The vehicle moves and burns fuel, the gear sinks: of each, those fields and no other. The ground the gear
  // stands on, said anew on every snapshot, is told when it is another; of the scars of a piece, the cells that deepened.
  const moved = frame(tank(2, 199.5), part([], { markRevision: 11, suspension: { enabled: true, travel: .2, displacement: .02, tilt: 0 },
    groundContact: { nx: 0, ny: 1, x: 5, y: 0, contacts: 2, materials: { gravel: 1 } } }));
  assert.deepEqual(moved.actors.with, [{ x: 2, vehicle: { $set: { x: 2, fuelLitres: 199.5 } } }]);
  assert.deepEqual(moved.modules.with, [{ suspension: { $set: { displacement: .02 } }, groundContact: { $set: { x: 5 } } }]);
  const muddy = frame(tank(2, 199.5), part([], { markRevision: 11, suspension: { enabled: true, travel: .2, displacement: .02, tilt: 0 },
    groundContact: { nx: 0, ny: 1, x: 5, y: 0, contacts: 2, materials: { gravel: .5, mud: .5 } }, ballisticScars: { '0:1': .7, '0:2': .1 } }));
  assert.deepEqual(muddy.modules.with, [{ groundContact: { $set: { materials: { gravel: .5, mud: .5 } } }, ballisticScars: { $set: { '0:1': .7, '0:2': .1 } } }]);
  // A vehicle that is no more, and one that comes again, are told as what they are.
  assert.deepEqual(frame({ id: 'a', x: 2, vehicle: null }, part([], { markRevision: 11 })).actors.with, [{ vehicle: null }]);
  assert.deepEqual(frame(tank(2, 100), part([], { markRevision: 11 })).actors.with, [{ vehicle: tank(2, 100).vehicle }]);
});

test('of a state a frame tells a place to a tenth of a millimetre and an angle to ten microradians, the rest as it is', () => {
  const tank = (x, angle) => ({ time: 1.0000000000000002, actors: [{ id: 'a', x, vehicle: { x, y: 1.23456789, angle, vx: 1.23456, fuelLitres: 199.123456 } }],
    modules: [{ id: 'b:gun', actorId: 'b', x: x + 1, y: 2.000049, angle: -3.14159265, barrelAngle: .123456789, health: 12.3456789, wheelSpin: 7.77777 }] });
  const writer = new FrameWriter(), reader = new FrameReader(), first = writer.encode({ state: tank(100.123456789, .123456789) }, true), told = header(first).state;
  assert.deepEqual(told.actors[0], { id: 'a', x: 100.1235, vehicle: { x: 100.1235, y: 1.2346, angle: .12346, vx: 1.235, fuelLitres: 199.12 } });
  assert.deepEqual(told.modules[0], { id: 'b:gun', actorId: 'b', x: 101.1235, y: 2, angle: -3.14159, barrelAngle: .12346, health: 12.3456789, wheelSpin: 7.7778 });
  assert.equal(told.time, 1.0000000000000002, 'the clock as it is');
  // A frame of changes tells what changed as a whole frame would: the reader has the state to those places.
  assert.deepEqual(reader.decode(first).state, plain(tank(100.123456789, .123456789)));
  const moved = writer.encode({ state: tank(100.2, .2) });
  assert.deepEqual(header(moved).state.actors.with, [{ x: 100.2, vehicle: { $set: { x: 100.2, angle: .2 } } }]);
  assert.deepEqual(reader.decode(moved).state, plain(tank(100.2, .2)));
});

test('of what happened a frame carries what a page shows and sounds it by, a place to the millimetre', () => {
  const hit = { type: 'penetration', owner: 7, projectileId: 'shot-3', x: 1234.56789, y: -3.00049, nx: .123456789, ny: -.992345678, material: 'steel', power: 431.23456, remaining: .4,
    mass: 4.2, energy: 5.6e6, speed: 1651.23456, impulse: 6934.5678, normalSpeed: 900, time: 12.34567891, result: 'through', shooterActor: 1, targetActor: 2, emitterOwner: 3,
    primaryContact: true, actorId: 'b', id: 'b:0:hull', componentId: undefined, otherId: undefined, source: 'hull', shooterActorId: 'a', targetActorId: 'b', emitterId: 'a:0:gun' };
  assert.deepEqual(tellEvent(hit), { type: 'penetration', time: 12.345679, x: 1234.568, y: -3, nx: .12346, ny: -.99235, power: 431.23, speed: 1651.2, impulse: 6934.6,
    actorId: 'b', id: 'b:0:hull', source: 'hull', projectileId: 'shot-3', material: 'steel' });
  const path = { type: 'flight', id: 'shot-3', n: 3, actor: 1, ammo: 'ap', weapon: 'cannon', poweredTrail: false, radius: .06, terminal: true,
    time: 12.5, points: [{ time: 12.4833333, x: 10.00049, y: 2.5, vx: 1650.04, vy: -3.26 }, { time: 12.5, x: 37.5012, y: 2.4449, vx: 1649.96, vy: -3.42 }], actorId: 'a' };
  assert.deepEqual(tellEvent(path), { type: 'flight', time: 12.5, radius: .06, actorId: 'a', id: 'shot-3', weapon: 'cannon', n: 3, ammo: 'ap',
    poweredTrail: false, terminal: true, points: [{ time: 12.483333, x: 10, y: 2.5, vx: 1650, vy: -3.3 }, { time: 12.5, x: 37.501, y: 2.445, vx: 1650, vy: -3.4 }] });
});

test('a frame tells what a page draws a strike by: the burst of a shaped charge, what a fragment ray was given, whether a round went through a piece', () => {
  // Of a piece struck within, whether the round went on through it — and on the wire too, without what a page draws nothing by.
  // Rounds that go off through blow-out panels burst out of the roof of their compartment: the page is told which way.
  assert.deepEqual(tellEvent({ type: 'explosion', time: 3, x: 1, y: 2, power: 300, radius: 2, vented: true, nx: 0, ny: 1, sourceOwner: 7, actor: 2 }),
    { type: 'explosion', time: 3, x: 1, y: 2, power: 300, radius: 2, vented: true, nx: 0, ny: 1 });
  const within = tellEvent({ type: 'module', owner: 7, x: 1, y: 2, kind: 'engine', power: 120, penetrated: true, actorId: 'b', id: 'b:0:engine', componentId: 'b:0:engine', time: 3 });
  assert.equal(within.penetrated, true);
  assert.deepEqual(new FrameReader().decode(new FrameWriter().encode({ type: 'frame', state: { time: 3, actors: [] }, events: [within] }, true)).events,
    [{ type: 'module', time: 3, x: 1, y: 2, power: 120, actorId: 'b', id: 'b:0:engine', penetrated: true }]);
  assert.deepEqual(tellEvent({ type: 'explosion', time: 3, x: 1, y: 2, power: 90.04, radius: .8, shaped: true, detonation: 'impact', preset: 'rh120', projectileId: 'shot-3',
    shooterActor: 1, targetActor: 2 }), { type: 'explosion', time: 3, x: 1, y: 2, power: 90.04, radius: .8, preset: 'rh120', projectileId: 'shot-3', shaped: true });
  assert.deepEqual(tellEvent({ type: 'secondary-ray', time: 3, x: 1, y: 2, endX: 2.5, endY: 2, internal: true, projectileId: 'ejecta-4', sourceOwner: 9,
    energyBudget: 5100, energySpent: 4000, powerBudget: 3.123456, powerSpent: 3 }), { type: 'secondary-ray', time: 3, x: 1, y: 2, endX: 2.5, endY: 2,
    projectileId: 'ejecta-4', internal: true, powerBudget: 3.1235 });
});

test('a frame tells what happened as rows: the fields of each kind named once, a text once, a path as its numbers', () => {
  const hit = (n, more = {}) => ({ type: 'penetration', time: 12 + n / 1000, x: 100 + n, y: 3, power: 40, actorId: 'tank-b', id: 'tank-b:0:hull', projectileId: 'shot-' + n, material: 'steel', fragment: false, ...more }),
    path = { type: 'flight', time: 12.5, actorId: 'tank-a', id: 'shot-1', terminal: true, points: [{ time: 12.48, x: 10, y: 2.5, vx: 1650, vy: -3.3 }, { time: 12.5, x: 37.5, y: 2.4, vx: 1650, vy: -3.4 }] },
    events = [hit(1), hit(2), path, hit(3, { internal: true }), { type: 'odd', points: [{ x: 1 }], pair: ['a', 'b'], nothing: null }];
  const writer = new FrameWriter(), reader = new FrameReader(), buffer = writer.encode({ type: 'frame', state: { time: 0, actors: [] }, events }, true), told = header(buffer).events;
  // Four kinds of row for five events, and each handle told once. Of a round at a face, whether it was a fragment is not
  // told: a page knows it by the path of the round.
  assert.deepEqual(told.kinds, [['$type', 'time', 'x', 'y', 'power', '$actorId', '$id', '$projectileId', '$material'], ['$type', 'time', '$actorId', '$id', 'terminal', '*points'],
    ['$type', 'time', 'x', 'y', 'power', '$actorId', '$id', '$projectileId', '$material', 'internal'], ['$type', 'points', 'pair', 'nothing']]);
  assert.deepEqual(told.texts, ['penetration', 'tank-b', 'tank-b:0:hull', 'shot-1', 'steel', 'shot-2', 'flight', 'tank-a', 'shot-3', 'odd']);
  assert.deepEqual(told.$rows[1], [0, 0, 12.002, 102, 3, 40, 1, 2, 5, 4]);
  assert.deepEqual(told.$rows[2], [1, 6, 12.5, 7, 3, true, [12.48, 10, 2.5, 1650, -3.3, 12.5, 37.5, 2.4, 1650, -3.4]]);
  // A reader hands them over as they were said, and a frame on which nothing happened says nothing of it.
  assert.deepEqual(reader.decode(buffer).events, events.map(event => { if (event.type !== 'penetration') return event; const { fragment, ...said } = event; return said; }));
  const quiet = writer.encode({ type: 'frame', state: { time: 1, actors: [] }, events: [] });
  assert.equal(header(quiet).events, undefined); assert.deepEqual(reader.decode(quiet).events, []);
  // A battle's worth of them takes a third of the words.
  const many = Array.from({ length: 100 }, (_, n) => hit(n));
  assert.ok(JSON.stringify(packEvents(many)).length < JSON.stringify(many).length / 3);
});

test('a ghost that is seen again loses its mark, whoever else is told of the construction on the same frames', () => {
  // Two factions of one field. The owner of a construction is told it as it is on every frame; the other sees it, loses
  // it — and is told the construction it was last told, with the mark of a ghost — and sees it again. What is kept of the
  // construction follows the frames of the owner: the other is told all of it, and what it had and this has not.
  for (const first of [0, 1]) {
    const ledger = new FrameLedger(), [owner, other] = [0, 1].map(() => ({ writer: new FrameWriter(ledger), reader: new FrameReader() }));
    let last = null, ghost = null;
    for (let turn = 0; turn < 12; turn++) {
      const now = built('b', 50, turn), seen = turn < 3 || turn >= 6 && turn < 9;
      if (seen) { last = now; ghost = null; }
      else ghost ||= { ...last, actor: { ...last.actor, ghost: { since: turn - 1 }, vehicle: { ...last.actor.vehicle, vx: 0, engine: false } } };
      ledger.turn();
      const frames = [[owner, now], [other, seen ? now : ghost]];
      for (const [side, part] of first ? frames.reverse() : frames) {
        const sent = state(turn, part), packet = side.reader.decode(side.writer.encode({ type: 'frame', state: sent }, turn === 0));
        assert.deepEqual(packet.state, plain(sent), `turn ${turn}, ${side === owner ? 'its owner' : 'the other'} told ${first ? 'last' : 'first'}`);
        if (side === other) assert.deepEqual([Boolean(packet.state.actors[0].ghost), 'engine' in packet.state.actors[0].vehicle], [!seen, !seen]);
      }
    }
  }
});

test('the writers of one field tell each its own state, and what they say alike is put into words once', () => {
  // Six constructions that move or stand; three factions, each told some of them, some as they are and
  // some as they were when it last saw them, in an order of its own. Every reader ends with what its writer was given.
  let seed = 7; const random = () => (seed = seed * 1103515245 + 12345 >>> 0) / 2 ** 32;
  const ledger = new FrameLedger(), ids = ['a', 'b', 'c', 'd', 'e', 'f'], field = new Map(ids.map((id, i) => [id, built(id, i * 40)])),
    sides = [0, 1, 2].map(() => ({ writer: new FrameWriter(ledger), reader: new FrameReader(), kept: new Map(), frames: 0 }));
  let shared = 0, wholes = 0;
  for (let turn = 1; turn <= 160; turn++) {
    for (const [i, id] of ids.entries()) if (random() < .6) field.set(id, built(id, i * 40, turn));
    ledger.turn();
    const said = new Map();
    for (const side of sides) {
      // What it sees is told as it is; what it saw and sees no longer stands as it was; the rest is not told.
      const told = [];
      for (const id of ids) {
        const how = random();
        if (how < .5) { side.kept.set(id, field.get(id)); told.push(field.get(id)); }
        else if (how < .8 && side.kept.has(id)) told.push(side.kept.get(id));
        else side.kept.delete(id);
      }
      if (random() < .2) told.reverse();
      const sent = state(turn, ...told), events = [{ type: 'fixture-turn', time: turn }], whole = side.frames++ === 0 || random() < .08, buffer = side.writer.encode({ type: 'frame', state: sent, events }, whole),
        packet = side.reader.decode(buffer);
      assert(packet, `turn ${turn}`); assert.deepEqual(packet.state, plain(sent), `turn ${turn}`); assert.deepEqual(packet.events, events);
      if (whole) wholes++;
      else for (const [k, index] of (header(buffer).state.plates?.at ?? []).entries()) {
        const text = JSON.stringify(header(buffer).state.plates.with[k]), id = sent.plates[index].id;
        if (said.get(id) === text) shared++; else said.set(id, text);
      }
    }
  }
  assert(shared > 100 && wholes > 10, `${shared} items were told to two factions in the same words, over ${wholes} whole frames`);
  // A writer that tells no more gives back what the ledger kept for it; the last one leaves it empty.
  sides[0].writer.close();
  assert([...ledger.lists.values()].some(entries => entries.size > 0));
  for (const side of sides) side.writer.close();
  assert([...ledger.lists.values()].every(entries => entries.size === 0));
});

// The shared field with a heavy vehicle of Alice's and one of Bob's, each at its base, within sight of the other.
function duel(t, bases = [-213, 237]) {
  const f = onField(t, rehearsal(bases)), room = f.room;
  const [alice, bob] = ['Alice', 'Bob'].map(name => { const joined = room.join(name), player = room.players.get(joined.playerId);
    // Each takes its construction in hand: publishing puts nobody at the controls.
    const actor = room.publish(player.id, createStructuredTemplate('heavy')).actor; f.order(player, 'control', { id: actor.id });
    return { id: player.id, faction: player.factionId, actor: actor.id, home: room.world.actor(actor.id).vehicle.x }; });
  // What a faction is told now, as its frame would have it.
  const publication = new Publication(), shown = side => { const state = publication.state(room.world.snapshot()); state.shared = true; state.players = room.roster(); return room.audience(state, chapters(state), [], side.faction).state; };
  return { room, world: room.world, alice, bob, run: f.run, put: f.put, shown, send: f.send };
}

test('a faction is told of the field what its sensors see, and keeps a ghost of what they lose', t => {
  const { room, world, alice, bob, run, put, shown, send } = duel(t), ids = told => told.actors.map(a => a.id), far = 10000;
  run(.5);
  // In sight of each other, each is told both, as they are.
  for (const side of [alice, bob]) { const told = shown(side); assert.deepEqual(ids(told), [alice.actor, bob.actor]); assert(told.actors.every(a => !a.ghost)); assert.deepEqual(told.contacts, []); }
  assert.equal(room.knows(alice.faction, world.actor(bob.actor)), 'seen'); assert.equal(room.knows(alice.faction, world.actor(alice.actor)), 'own');
  assert.throws(() => send(alice, 'blueprint', { actorId: bob.actor }), /de outra facção/);
  send(alice, 'squad', { order: 'control', id: null });
  assert.deepEqual(send(alice, 'squad', { order: 'attack', ids: [alice.actor], targetId: bob.actor }), {}); send(alice, 'squad', { order: 'stop', ids: [alice.actor] });
  // Alice's vehicle goes where it sees nothing of Bob's. She keeps what she last saw of it, where it was.
  const before = shown(alice), place = before.actors[1].vehicle.x; put(alice.actor, alice.home - far);
  const lost = shown(alice), ghost = lost.actors[1];
  assert.deepEqual(ids(lost), [alice.actor, bob.actor]); assert(ghost.ghost.since > .4 && ghost.ghost.since < world.time);
  assert.equal(ghost.vehicle.x, place); assert.deepEqual([ghost.vehicle.vx, ghost.vehicle.engine], [0, false]);
  assert.equal(room.knows(alice.faction, world.actor(bob.actor)), 'ghost');
  assert.deepEqual(lost.players.map(p => p.id), [alice.id, bob.id], 'a ghost is a construction she is told of');
  // Bob saw her leave and her place empty: he is told of no ghost, and of no construction of hers.
  const other = shown(bob);
  assert.deepEqual(ids(other), [bob.actor]); assert.deepEqual(other.players.map(p => p.id), [bob.id], 'nor of her');
  assert.equal(Object.hasOwn(other, 'stats'), false, 'no global tally reveals a construction the faction is told nothing of');
  assert.equal(room.knows(bob.faction, world.actor(alice.actor)), null);
  // Of what he was told nothing, Bob is answered as of what is not there; a ghost is no target either.
  assert.throws(() => send(bob, 'blueprint', { actorId: alice.actor }), /já não está no campo/);
  assert.throws(() => send(bob, 'drive', { actorId: alice.actor, throttle: 1, request: 1 }), /já não está no campo/);
  assert.deepEqual(send(bob, 'drive', { actorId: alice.actor, throttle: 1 }), {});
  send(bob, 'squad', { order: 'control', id: null });
  assert.throws(() => send(bob, 'squad', { order: 'attack', ids: [bob.actor], targetId: alice.actor }), /Alvo inválido/);
  assert.throws(() => send(alice, 'squad', { order: 'attack', ids: [alice.actor], targetId: bob.actor }), /Alvo inválido/);
  assert.throws(() => send(alice, 'blueprint', { actorId: bob.actor }), /de outra facção/, 'a ghost is refused as what it was');
  {
    // Taken off the field while she holds its ghost, it is answered as the ghost still: the answer says no more than her screens.
    const other = duel(t);
    other.run(.5); other.shown(other.alice); other.put(other.alice.actor, other.alice.home - far); other.run(1);
    assert(other.shown(other.alice).actors[1].ghost, 'she holds the ghost');
    other.room.discard(other.bob.actor); other.run(.5);
    assert(other.shown(other.alice).actors[1].ghost, 'and holds it still');
    assert.throws(() => other.send(other.alice, 'blueprint', { actorId: other.bob.actor }), /de outra facção/);
    assert.throws(() => other.send(other.alice, 'drive', { actorId: other.bob.actor, throttle: 1, request: 1 }), /de outra facção/);
  }
  // Bob's vehicle moves on, unseen. The ghost stands where it stood, in a frame of changes and in a whole one,
  // and a frame says nothing more of it.
  const writer = new FrameWriter(), reader = new FrameReader(), frame = whole => writer.encode({ type: 'frame', state: shown(alice) }, whole);
  reader.decode(frame(true)); put(bob.actor, bob.home + 60);
  const quiet = decodeFrame(frame()).state, parts = shown(alice).plates.map((p, index) => p.actorId === bob.actor ? index : -1).filter(index => index >= 0);
  assert(parts.length > 5 && !quiet.plates?.at?.some(index => parts.includes(index)) && !quiet.actors?.at?.includes(1) && !quiet.plates?.from, 'nothing of the ghost is in the frame');
  const again = new FrameReader().decode(frame(true)).state, hull = again.plates.filter(p => p.actorId === bob.actor);
  assert(Math.abs(again.actors[1].vehicle.x - place) <= 5e-5, 'to the tenth of a millimetre a frame tells a place by');
  assert(hull.every(p => Math.abs(p.definition.x - place) < 8), 'the parts of a ghost are where they were, not where the construction went');
  assert(Math.abs(world.actor(bob.actor).vehicle.x - place) > 50);
  // She comes back: the place is in plain view and empty, and the ghost goes. Bob's vehicle is seen where it is now.
  put(alice.actor, alice.home);
  const back = shown(alice);
  assert.deepEqual(ids(back), [alice.actor, bob.actor]); assert.equal(back.actors[1].ghost, undefined);
  assert(Math.abs(back.actors[1].vehicle.x - world.actor(bob.actor).vehicle.x) < 1e-9);
  // Away again, with Bob's gone far as well while nobody of hers looks: the ghost stands for its time and no longer.
  put(alice.actor, alice.home - far); put(bob.actor, bob.home + far);
  const since = shown(alice).actors[1].ghost.since;
  run(GHOST_SECONDS - (world.time - since) - 1); assert.equal(shown(alice).actors[1]?.ghost?.since, since);
  run(2); assert.deepEqual(ids(shown(alice)), [alice.actor]);
  assert.throws(() => send(alice, 'blueprint', { actorId: bob.actor }), /já não está no campo/);
  // Back home with Bob's gone: nothing is there, and nothing is told.
  put(alice.actor, alice.home); assert.deepEqual(ids(shown(alice)), [alice.actor]);
});

test('on the wire a construction of another faction is its outside: no piece under its hull, none of its figures, and still told by what changed', t => {
  const { room, world, alice, bob, run, put } = duel(t), all = world.snapshot(), kinds = (told, id) => told.modules.filter(m => m.actorId === id).map(m => m.kind).sort(),
    INSIDE = ['engine', 'fuel', 'ammo', 'command'], OWN = ['eyes', 'cooldown'], DRIVE = ['fuelLitres', 'rangeKm', 'fuelStarved', 'maxSpeed', 'powerKw', 'brake', 'driveSpeed', 'fuelRate'], PEDALS = ['throttle', 'gearCount', 'stuck'],
    // What no page reads, of its own constructions or of any other.
    UNREAD = ['aim', 'weapon', 'stats', 'contactContours'], FIGURES = ['massTonnes', 'powerPerTonne', 'groundPressureKPa', 'softGroundLoad', 'enabled'],
    WORKS = ['reload', 'loaded', 'feedReload', 'barrelCooling', 'targetBarrelAngle', 'targetAimOffset', 'aimOffset', 'servoVelocity', 'rounds', 'capacityRounds', 'fuelLitres', 'physicalMass', 'owner'];
  run(.5);
  assert(INSIDE.every(kind => kinds(all, bob.actor).includes(kind)), 'the heavy has all of them in its hull');
  // Both far from where they were made, in sight of each other: a hull is where its vehicle is.
  put(alice.actor, 3000); put(bob.actor, 3040);
  // Each is told on the wire, by a writer of its own on the ledger of the field, the field as it is published, as the server tells them.
  const publication = new Publication(), ledger = new FrameLedger(), ends = [alice, bob].map(side => ({ side, other: side === alice ? bob : alice, writer: new FrameWriter(ledger), reader: new FrameReader() }));
  room.command(alice.id, { type: 'squad', order: 'control', id: alice.actor });
  for (let turn = 0; turn < 8; turn++) {
    room.command(alice.id, { type: 'drive', actorId: alice.actor, throttle: turn < 4 ? 1 : 0 }); run(.1);
    const state = publication.state(world.snapshot()); state.shared = true; state.players = room.roster();
    const parts = chapters(state); ledger.turn();
    for (const { side, other, writer, reader } of ends) {
      const sent = room.audience(state, parts, [], side.faction).state, buffer = writer.encode({ type: 'frame', state: sent }, turn === 0), told = reader.decode(buffer).state;
      assert.deepEqual(told, plain(sent), `turn ${turn}`);
      const [mine, foe] = [side, other].map(who => told.actors.find(a => a.id === who.actor)), text = new TextDecoder().decode(new Uint8Array(buffer));
      // Its own: every piece, and every figure a page reads of it.
      assert.deepEqual(kinds(told, side.actor), kinds(state, side.actor)); for (const key of OWN) assert(key in mine, key); for (const key of DRIVE) assert(key in mine.vehicle, key);
      for (const actor of [mine, foe]) { for (const key of UNREAD) assert(!(key in actor), key); for (const key of FIGURES) assert(!(key in actor.vehicle), key); }
      // The other's: its guns, its running gear and what sits on its armour. Nothing its hull covers.
      const shows = kinds(told, other.actor);
      assert(shows.includes('weapon') && shows.includes('track') && shows.length < kinds(state, other.actor).length, shows.join());
      for (const kind of INSIDE) assert(!shows.includes(kind), kind);
      assert.equal(Object.hasOwn(told, 'attachments'), false, 'documentary support links are not part of a field frame');
      for (const module of state.modules) if (module.actorId === other.actor && INSIDE.includes(module.kind)) assert(!text.includes(module.id), 'the name of a covered piece is nowhere in the frame');
      for (const key of OWN) assert(!(key in foe), key); for (const key of [...DRIVE, ...PEDALS]) assert(!(key in foe.vehicle), key);
      for (const key of ['x', 'y', 'angle', 'vx', 'vy', 'omega', 'engine']) assert(key in foe.vehicle, key);
      // Of the pieces that show, what a page draws them by: where a barrel lies, not its reload or its heat, where it is being laid, its servo or its rounds.
      const guns = told.modules.filter(m => m.actorId === other.actor && m.kind === 'weapon');
      assert(guns.length && guns.every(gun => Number.isFinite(gun.barrelAngle) && gun.weaponPreset), 'its guns are drawn');
      for (const module of told.modules) if (module.actorId === other.actor) for (const key of WORKS) assert(!(key in module), module.kind + ': ' + key);
      // How hot its barrels are it is told only as the air over them shimmers: they are cool, yet.
      assert(guns.every(gun => gun.barrelTemperature === 0), 'a cool barrel shows nothing of its heat');
      for (const module of told.modules) if (module.actorId === side.actor && module.kind === 'weapon') assert('reload' in module && 'barrelTemperature' in module && 'loaded' in module && 'feedReload' in module && 'servoVelocity' in module, 'its own it is told whole');
      // A frame of changes tells of a construction what changed of it, to its owner and to the other alike: neither is told it whole again.
      if (turn) for (const words of header(buffer).state.actors?.with ?? []) assert(!('id' in words) && !('name' in words), `turn ${turn}: ${Object.keys(words)}`);
      if (turn && turn < 4) assert(header(buffer).state.actors.at.includes(told.actors.indexOf(told.actors.find(a => a.id === alice.actor))), 'the one that drives is told to both');
    }
  }
});

test('on the wire a faction is told the rounds and the happenings it witnesses, its own shells wherever they fly, what the radar of its base follows, and nothing of the rest', t => {
  const { room, world, alice, bob, run, put } = duel(t), ground = world.terrain;
  // Bob's vehicle goes twelve kilometres off; his base stays where it is, with nothing of his at it.
  run(.5); put(bob.actor, bob.home + 12000);
  // Alice fires over it toward the sky eight kilometres away: beyond her eye's reach and above the terrain.
  const gun = world.modules.find(m => m.actorId === alice.actor && m.kind === 'weapon'), config = world.playerWeapon({ platform: 'vehicle', componentId: gun.id }, alice.actor),
    weapon = { id: config.id, preset: config.preset, componentId: gun.id }, aim = { x: alice.home + 8000, y: gun.y + 1000 };
  room.command(alice.id, { type: 'squad', order: 'control', id: alice.actor }); room.command(alice.id, { type: 'aim', aim, weapon }); run(3); world.drainEvents();
  assert.equal(room.command(alice.id, { type: 'fire', aim, weapon }).accepted, true);
  // Each is told on the wire, by a writer of its own on the ledger of the field, as the server tells them.
  const ledger = new FrameLedger(), [hers, his] = [alice, bob].map(side => ({ side, writer: new FrameWriter(ledger), reader: new FrameReader(), told: [], heard: [] }));
  let beyond = 0, followed = 0;
  for (let turn = 0; turn < 80; turn++) {
    run(.05);
    const state = world.snapshot(), events = world.drainEvents(); state.shots = { ...state.shots, drag: world.shotDrags }; state.shared = true; state.players = room.roster();
    assert(state.stats.shots > 0, 'the source has a global firing tally that must stay off the fogged wire');
    const parts = chapters(state), all = listShots(state.shots), shell = all[0]; ledger.turn();
    assert(all.length === 1 && shell.actorId === alice.actor, `turn ${turn}: her shell flies on, alone`);
    for (const end of [hers, his]) {
      const sight = room.witness(state, end.side.faction), sees = witnessed(sight, shell.x, shell.y), up = aloft(sight, shell.x, shell.y),
        { state: sent, events: heard } = room.audience(state, parts, events, end.side.faction),
        buffer = end.writer.encode({ type: 'frame', state: sent, events: heard }, turn === 0), packet = end.reader.decode(buffer),
        rounds = listShots(packet.state.shots), text = new TextDecoder().decode(new Uint8Array(buffer));
      // Hers she is told where she witnesses it and in the sky over the rest; he, while it flies over his base and for as long as
      // the radar of his base follows it. A page has it where the field does, by the flight it follows.
      const radar = room.watch.follows(end.side.faction)(shell.number);
      if (end === hers) assert.equal(radar, false, 'no radar follows a round of its own side');
      else if (radar && !sees) followed++;
      assert.equal(rounds.length, (end === hers ? sees || up : sees || radar) ? 1 : 0, `turn ${turn}, at ${Math.round(shell.x)}, ${Math.round(shell.y - ground.height(shell.x))} m up`);
      // His is nobody's to him, and as old as he has been told it: when it left her gun nothing says.
      for (const round of rounds) assert(round.number === shell.number && round.actorId === (end === hers ? alice.actor : undefined) && Math.hypot(round.x - shell.x, round.y - shell.y) < .05, `turn ${turn}`);
      if (end === his && rounds.length && !end.told.includes(1)) assert(rounds[0].age === 0 && shell.age > .04, `turn ${turn}: ${rounds[0].age} of ${shell.age}`);
      if (end === hers && !sees) beyond++;
      end.told.push(rounds.length); end.heard.push(...packet.events);
      // What it hears it is told, but what a page reads nothing by (UNREAD_EVENT_FIELDS).
      const told = heard.map(event => Object.fromEntries(Object.entries(event).filter(([key]) => !UNREAD_EVENT_FIELDS.get(event.type)?.has(key))));
      assert.deepEqual(packet.events, JSON.parse(JSON.stringify(told)));
      // Nothing in his frames names her construction: not a kind of the legend, not an event. Until he is told the round, no kind at all.
      if (end === his) assert(!text.includes(alice.actor), `turn ${turn}`);
      if (end === his && !end.told.includes(1)) assert.deepEqual(packet.state.shots.kinds, []);
      // Of the field as of one workshop's, nothing: not the vehicle of its first construction, nor the tally of what was fired and struck.
      assert.equal(Object.hasOwn(packet.state, 'vehicle'), false); assert.equal(Object.hasOwn(packet.state, 'cooldown'), false);
      assert.equal(Object.hasOwn(packet.state, 'stats'), false);
    }
  }
  assert(beyond > 5, 'her shell went on past what her eye reaches');
  // The radar of his base picks the shell up soon after it leaves her gun and holds it from then on, over ground nothing of his sees.
  assert(/^0+1+$/.test(his.told.join('')) && followed > 20, `he was told the round from when his radar had it: ${his.told.join('')}, ${followed} turns by the radar alone`);
  assert.deepEqual(his.reader.state.shots.kinds.map(kind => [kind.actorId, kind.weapon, kind.name, kind.ammo]), [[undefined, undefined, undefined, hers.reader.state.shots.kinds[0].ammo]]);
  // She heard her gun and saw the round go; he heard nothing of it. Where it ended she is told only where she witnesses it.
  const types = new Set(hers.heard.map(event => event.type));
  assert(types.has('muzzle') && types.has('flight')); assert.deepEqual(his.heard, []);
  for (const path of hers.heard) if (path.type === 'flight' && path.terminal) { const end = path.points.at(-1); assert(witnessed(room.witness(world.snapshot(), alice.faction), end.x, end.y)); }
});

test('a wreck is told to the factions that know of it, and what became of a ghost is told to nobody', t => {
  const wreck = (world, id) => { for (const post of world.modules.filter(m => m.actorId === id && m.kind === 'command'))
    world.game().call({ op: 'setPartState', owner: world.game().handle(post), state: { health: 0 } }); };
  {
    // Bob's vehicle goes out of action where Alice sees it: a wreck to both, in her list and off her targets.
    const { room, world, alice, bob, run, put, shown, send } = duel(t),
      wrecks = side => room.factionView(side.id).wrecks.map(w => w.id), out = side => room.squadView(side.id).out;
    run(.5); wreck(world, bob.actor); run(.5);
    assert.deepEqual([wrecks(alice), out(alice), wrecks(bob)], [[bob.actor], [bob.actor], [bob.actor]]);
    const row = room.factionView(alice.id).wrecks[0];
    // She leaves. The ghost of the wreck stays in her list as she was last told of it, whatever becomes of the wreck.
    shown(alice); put(alice.actor, alice.home - 10000);
    assert.equal(shown(alice).actors[1].ghost && shown(alice).actors[1].defeated, true);
    const remembered = shown(alice).actors[1];
    assert.deepEqual([room.factionView(alice.id).wrecks, out(alice)], [[row], [bob.actor]]);
    assert.throws(() => send(alice, 'salvage', { wreckId: bob.actor }), /Leve uma construção sua/);
    const place = world.actor(bob.actor).vehicle.x;
    room.discard(bob.actor); run(.5);
    assert.deepEqual([room.factionView(alice.id).wrecks, out(alice)], [[row], [bob.actor]], 'taken from the field unseen, it is still what she has on her screens');
    assert.throws(() => send(alice, 'salvage', { wreckId: bob.actor }), /Leve uma construção sua/, 'and is answered as it was before it went');
    // She comes to where it stood with her cameras shot out, and past it, so that the vision block of her hull looks
    // away from it: within reach of it as she knows it, she finds it gone there.
    for (const eye of world.modules.filter(m => m.actorId === alice.actor && m.kind === 'sensor'))
      world.game().call({ op: 'setPartState', owner: world.game().handle(eye), state: { health: 0 } });
    put(alice.actor, place + 10); run(CALM_SECONDS); assert(shown(alice).actors[1]?.ghost, 'blind, she holds it as a ghost');
    assert.deepEqual([room.factionView(alice.id).wrecks, out(alice)], [[{ ...row, inReach: true }], [bob.actor]]);
    assert.throws(() => send(alice, 'salvage', { wreckId: bob.actor }), /já não estão aqui/);
    run(GHOST_SECONDS);
    const held = shown(alice);
    assert.deepEqual([wrecks(alice), out(alice)], [[bob.actor], [bob.actor]], 'a wreck actually seen stays known beyond live contact memory');
    assert.deepEqual(held.actors.find(actor => actor.id === bob.actor), remembered, 'only the last exterior and pose are kept');
    assert.deepEqual(held.contacts, [], 'a known wreck is no radar or sound threat');
    // The command visor now faces its last place. An actual view of empty ground clears it.
    put(alice.actor, place - 10); run(.5);
    assert.deepEqual([wrecks(alice), out(alice), shown(alice).actors.length], [[], [], 1]);
  }
  {
    // It goes out of action while she holds only a ghost of it: to her it is what it was when she last saw it.
    const { room, world, alice, bob, run, put, shown, send } = duel(t);
    run(.5); shown(alice); put(alice.actor, alice.home - 10000); wreck(world, bob.actor); run(.5);
    assert.equal(world.actor(bob.actor).defeated, true); assert.equal(shown(alice).actors[1].defeated, false);
    assert.deepEqual([room.factionView(alice.id).wrecks, room.squadView(alice.id).out], [[], []]);
    assert.throws(() => send(alice, 'salvage', { wreckId: bob.actor }), /já não estão no campo/);
    assert.throws(() => send(alice, 'blueprint', { actorId: bob.actor }), /de outra facção/);
    assert.deepEqual(room.factionView(bob.id).wrecks.map(w => w.id), [bob.actor], 'a faction always knows the wrecks of its own');
  }
  {
    // She dismantles it beside it, past it, with her cameras shot out: it was a ghost to her, and what she took away she
    // knows is gone.
    const { room, world, alice, bob, run, put, shown, send } = duel(t);
    run(.5); wreck(world, bob.actor); run(.5);
    put(alice.actor, world.actor(bob.actor).vehicle.x + 10); shown(alice);
    for (const eye of world.modules.filter(m => m.actorId === alice.actor && m.kind === 'sensor'))
      world.game().call({ op: 'setPartState', owner: world.game().handle(eye), state: { health: 0 } });
    run(CALM_SECONDS); assert(shown(alice).actors[1].ghost, 'blind, she holds it as a ghost');
    assert.deepEqual(send(alice, 'salvage', { wreckId: bob.actor }).salvaged, bob.actor); run(.5);
    assert.deepEqual([shown(alice).actors.length, room.factionView(alice.id).wrecks, room.squadView(alice.id).out], [1, [], []]);
  }
});

test('a construction of the player\'s own put out of action burns on the player\'s screen as one of another does, in hand or not, where no eye of the faction is', t => {
  const f = onField(t, rehearsal([0, 30000])), room = f.room, world = room.world, [alice, bob] = ['Alice', 'Bob'].map(name => room.join(name)),
    [inHand, aside, watcher] = [0, 1, 2].map(() => f.publish(alice, 'scout')), foe = f.publish(bob, 'scout'), x = id => world.actor(id).vehicle.x;
  f.order(alice, 'control', { id: inHand });
  // Two of hers stand alone, kilometres from her base and from each other, one in her hands; the third has a foe in sight.
  f.put(inHand, 4000); f.put(aside, -4000); f.put(watcher, 9000); f.put(foe, 9020);
  for (const id of [inHand, aside, foe]) {
    const tank=f.parts(id,'fuel')[0];world.explode(tank.x,tank.y,1000,2);
  }
  for (const id of [inHand, aside, foe]) for (const post of f.parts(id, 'command')) f.set(post, { health: 0 });
  f.run(.5);
  // The field let go of the one in her hands, and both left her squad: a wreck is nobody's.
  const squad = room.squadView(alice.playerId), seat = room.players.get(alice.playerId);
  assert.equal(squad.manual, null); assert(!squad.units.some(unit => unit.id === inHand || unit.id === aside));
  // Her own wrecks and the foe in sight expose the core's shared fire, without a visual lifetime of their own.
  const publication = new Publication(), state = publication.state(world.snapshot()); state.shared = true; state.players = room.roster();
  const told = room.audience(state, chapters(state), [], seat.factionId).state;
  for (const id of [inHand, aside, foe]) {
    const wreck = told.actors.find(actor => actor.id === id);
    assert(wreck?.defeated && wreck.burning === true, id);
  }
  // On her page (main.ts) the frame is hers, of her faction, with nothing in her hands.
  const page = { ...told, squad, faction: room.factionView(alice.playerId), controlledActor: squad.manual, localPlayerId: alice.playerId },
    network = { enabled: true, connected: true, selected: seat.selected, designs: new Map() };
  assert.equal(controlContext({ mode: 'test' }, page, network).manual, false);
  // Each of the three burns there: every flame of it is made, over ground the faction sees (render.ts `consumeEffect`). No
  // eye of hers is on her two: it is their fire that is seen, about them and over them, as the foe's is.
  const r = new Renderer({}); r.view.mode = 'test'; r.ground = world.terrain;
  const sees = page => { r.fog = r.groundFog({ state: page, scene: sampleScene(page) }); return place => r.sees(place); },
    seen = sees(page);
  for (const id of [inHand, aside, foe]) assert(seen(x(id)), JSON.stringify(r.fog.seen));
  // Its fire out, a wreck of hers stands where nothing of hers sees, as one with no eye does.
  const out = sees({ ...page, actors: page.actors.map(actor => ({ ...actor, burning: false })) });
  assert(!out(x(inHand)) && !out(x(aside)) && out(x(foe)));
});

test('a faction knows another once it has seen something of it standing: by sight alone, each for itself, with when and where it last did', t => {
  const { room, world, alice, bob, run, put, shown, send } = duel(t, [-213, 5237, 12000, 9000]),
    view = side => room.factionView(side.id), known = side => view(side).known, strangers = side => view(side).strangers,
    person = (side, name, invited = false) => ({ id: side.id, name, connected: true, invited }),
    // The other factions of the field each is told of, by the names they go by and whether it met each: told by its name on the field.
    others = side => view(side).ranking.filter(row => row.id !== side.faction),
    nations = side => others(side).map(row => [row.nation ?? row.name, row.id !== null]).sort(([a], [b]) => a.localeCompare(b)), flag = side => room.factions.get(side.faction).flag,
    // What the core would say of a sensor of Alice's that holds a construction of another, wherever that one is.
    sense = (channel, actorId = bob.actor) => {
      room.fog.read({ sight: { [alice.faction]: [{ actorId, channel, visible: true, x: 0, y: 0, error: 9, age: 0, by: alice.actor }] } }, world.time); room.acquaint(world.time); };
  run(.5);
  // Five kilometres apart neither has seen the other: each is told who else is on the field, by name, and no more. Its frames name nobody else.
  assert.deepEqual([known(alice), strangers(alice), known(bob), strangers(bob)], [[], [person(bob, 'Bob')], [], [person(alice, 'Alice')]]);
  assert.deepEqual(shown(alice).players, [{ id: alice.id, connected: true }]);
  // Each is told the other all the same, by its name and flag alone, what a request to join it names it by, and how wealthy it is.
  const unmet = side => others(side).map(({ wealth, ...row }) => (assert(Number.isInteger(wealth) && wealth > 0), row)), ref = side => room.factions.get(side.faction).ref;
  assert.deepEqual([unmet(alice), unmet(bob)], [[{ id: null, name: 'Bob', nation: null, flag: flag(bob), ref: ref(bob) }], [{ id: null, name: 'Alice', nation: null, flag: flag(alice), ref: ref(alice) }]]);
  // A radar mark and a sound do not say whose they are.
  sense('radar'); assert.equal(room.knows(alice.faction, world.actor(bob.actor)), 'radar'); sense('sound');
  assert.deepEqual([known(alice), strangers(alice)], [[], [person(bob, 'Bob')]]);
  // A sight does. Knowing is one-sided: Bob, who saw nothing, knows nobody.
  sense('visual');
  const met = world.time, there = Math.round(world.actor(bob.actor).vehicle.x), color = room.players.get(bob.id).color,
    row = patch => ({ id: bob.faction, name: 'Bob', nation: null, flag: flag(bob), color, members: [person(bob, 'Bob')], seen: false, at: null, x: null, defeated: null, ...patch });
  assert.deepEqual([known(alice), strangers(alice), known(bob), strangers(bob)], [[row({ seen: true })], [], [], [person(alice, 'Alice')]]);
  assert.deepEqual([nations(alice), nations(bob)], [[['Bob', true]], [['Alice', false]]]);
  // Out of sight again, the faction keeps when and where it last saw it.
  run(1);
  const [once] = known(alice);
  assert.deepEqual({ ...once, at: null }, row({ x: there })); assert(once.at >= met && once.at <= met + .4, 'when the sight lapsed');
  // In plain sight of each other each knows the other. The owner of what a faction sees is named in its frames, and not his faction.
  put(bob.actor, alice.home + 450);
  assert.deepEqual([known(alice), known(bob).map(f => [f.id, f.name, f.seen, f.x])], [[row({ seen: true })], [[alice.faction, 'Alice', true, null]]]);
  assert.deepEqual(shown(alice).players, [{ id: alice.id, connected: true }, { id: bob.id, connected: true }]);
  const left = world.time; put(alice.actor, alice.home - 5000);
  const [lost] = known(alice);
  assert.deepEqual([lost.seen, lost.defeated], [false, null]); assert(lost.at >= left && lost.at <= left + .5, 'when she left');
  assert(Math.abs(lost.x - world.actor(bob.actor).vehicle.x) < 2, 'where it stood');
  assert.deepEqual(shown(alice).players.map(p => p.id), [alice.id, bob.id], 'a ghost is still his');
  // Whether a member of a faction it knows was invited is told with the member.
  send(alice, 'invite', { playerId: bob.id }); assert.deepEqual(known(alice)[0].members, [person(bob, 'Bob', true)]);
  // Carol comes with a scout, and Alice sees it: she knows two factions.
  const carol = (() => { const joined = room.join('Carol'), player = room.players.get(joined.playerId);
    return { id: player.id, faction: player.factionId, actor: room.publish(player.id, createStructuredTemplate('scout')).actor.id }; })();
  assert.deepEqual([strangers(alice), nations(alice), nations(bob)], [[person(carol, 'Carol')], [['Bob', true], ['Carol', false]], [['Alice', true], ['Carol', false]]]);
  sense('visual', carol.actor);
  assert.deepEqual([known(alice).map(f => [f.name, f.seen]), strangers(alice), nations(alice)], [[['Bob', false], ['Carol', true]], [], [['Bob', true], ['Carol', true]]]);
  // Carol's scout takes Bob's base. To Alice, who knew his faction, it was defeated then and is nowhere she knows of.
  // What Bob's faction knew of the field it knows still, and the invitation it had stands.
  const book = room.fog.books.get(bob.faction), his = room.factions.get(bob.faction);
  put(carol.actor, his.base.x); Object.assign(his.capture, { progress: CAPTURE_SECONDS - .5, at: world.time }); run(2);
  const beaten = row({ members: [person(bob, 'Bob', true)], defeated: his.fell.at });
  assert.deepEqual(known(alice).find(f => f.id === bob.faction), beaten);
  assert(book && room.fog.books.get(bob.faction) === book);
  assert.deepEqual([known(bob).map(f => f.id), view(bob).invites.map(i => i.factionId)], [[alice.faction], [alice.faction]]);
  // It establishes another base, and is still nowhere Alice knows of.
  assert.equal(send(bob, 'recover').base.x, 9000);
  run(1); assert.deepEqual(known(alice).find(f => f.id === bob.faction), beaten, 'until it is seen again');
  // Seen again where it is now, it is a faction like any other: the mark goes.
  room.players.get(bob.id).builtAt = -Infinity; sense('visual', room.publish(bob.id, createStructuredTemplate('scout')).actor.id);
  assert.deepEqual(known(alice).find(f => f.id === bob.faction), { ...beaten, seen: true, defeated: null });
  // Bob joins Alice's faction. His own is gone, and nobody knows it any longer; he knows what hers does.
  send(bob, 'join-faction', { factionId: alice.faction });
  assert.deepEqual([known(alice).map(f => f.name), known(bob).map(f => f.name), view(bob).members.map(m => m.name)], [['Carol'], ['Carol'], ['Alice', 'Bob']]);
  // Nor is it a nation of the field to anybody, Carol who never met it with the rest.
  assert.deepEqual([nations(alice), nations(carol)], [[['Carol', true]], [['Alice', false]]]);
  // Carol joins it too: her faction is dropped in the same way, and she is no stranger to Alice any longer.
  send(alice, 'invite', { playerId: carol.id }); send(carol, 'join-faction', { factionId: alice.faction });
  assert.deepEqual([known(alice), strangers(alice), nations(alice), room.factions.size], [[], [], [], 1]);
});

test('a field without fog tells every faction the whole of it', t => {
  const room = rehearsal([-9000, 9000], undefined, { fog: false }); t.after(() => room.world.dispose());
  const [a, b] = ['Alice', 'Bob'].map(name => room.join(name)), mine = room.publish(a.playerId, createStructuredTemplate('scout')).actor,
    theirs = room.publish(b.playerId, createStructuredTemplate('scout')).actor;
  for (let i = 0; i < 12; i++) room.step();
  const state = room.world.snapshot(); state.players = room.roster();
  const events = [], audience = room.audience(state, null, events, room.players.get(a.playerId).factionId);
  assert.deepEqual(audience.state, { ...state, tows: [] }); assert.equal(audience.events, events);
  assert.equal(room.knows(room.players.get(a.playerId).factionId, room.world.actor(theirs.id)), 'seen');
  assert.throws(() => room.command(a.playerId, { type: 'blueprint', actorId: theirs.id }), /de outra facção/);
  assert.equal(room.fog, null); assert(room.world.actor(mine.id));
});

test('the stress field is the field of the game: whoever comes is seated in a faction of it and told what that faction is', { timeout: 60000 }, async t => {
  // Two of its factions: half a battle, each shelling the base of the other.
  const { socket } = await serveNetwork(t, { stress: 2 }),
    ws = socket(), messages = [], frames = [], reader = new FrameReader(), witnessed = new Set(); let asked = 0;
  const until = async (fn, timeout = 40000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  ws.on('message', (raw, binary) => { if (!binary) return messages.push(JSON.parse(raw));
    const packet = reader.decode(raw);
    if (packet) {
      frames.push(packet);
      for (let i = 0; i < packet.state.shots.data.length; i += SHOT_WORDS) witnessed.add(packet.state.shots.data[i + SHOT_NUMBER]);
    } else { asked++; ws.send(JSON.stringify({ type: 'resync' })); } });
  await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name: 'Watcher' }));
  await until(() => messages.some(m => m.type === 'welcome'));
  // It is of the first faction: its base is that one's, and it is told where to look, over it.
  const welcome = messages.find(m => m.type === 'welcome');
  assert.ok(Math.abs(welcome.base.x - STRESS_FIELD.battles[0]) <= STRESS_FIELD.search + STRESS_FIELD.perBattle * STRESS_FIELD.baseSpacing); assert.deepEqual(welcome.watch, { x: welcome.base.x, y: welcome.base.y + STRESS_FIELD.watch.rise, zoom: STRESS_FIELD.watch.zoom });
  const vehicles = CONSTRUCTION_LIMITS.vehicles;
  assert.equal(welcome.faction.count, vehicles); assert.deepEqual(welcome.faction.counts, { vehicles, fixed: 0 });
  assert(!('limit' in welcome.faction));
  // Told as that faction: its twelve whole, those of the other it sees as they show from outside, and the rounds it witnesses.
  // Allied armour now limits simultaneous fire. Still exercise the creation and removal of more than twenty
  // distinct rounds over the wire, without requiring them all to survive in the air at the same instant.
  await until(() => frames.at(-1)?.state.actors.length === vehicles * 2 && witnessed.size > 20 && shotCount(frames.at(-1).state.shots) > 0);
  const last = frames.at(-1).state, mine = last.actors.filter(a => a.team === welcome.faction.id), theirs = last.actors.filter(a => a.team !== welcome.faction.id);
  assert.deepEqual([mine.length, theirs.length], [vehicles, vehicles]); assert.deepEqual(last.contacts, [], 'a state the fog told');
  assert(mine.every(a => a.eyes) && theirs.every(a => !('eyes' in a)));
  assert.equal(asked, 0); assert(frames.filter(frame => frame.base === null).length <= 2, 'a whole state when it came, and differences from there on');
});

test('over the wire each faction gets a frame of its own, and a player who changes faction a whole state of the new one', { timeout: 40000 }, async t => {
  const { socket } = await serveNetwork(t, { rehearsal: { bases: [-9000, 9000, 0] } });
  const until = async (fn, timeout = 8000) => { const start = Date.now(); while (!fn()) { if (Date.now() - start > timeout) throw new Error('Network timeout'); await new Promise(resolve => setTimeout(resolve, 15)); } };
  const connect = async name => {
    const ws = socket(), client = { ws, messages: [], frames: [], asked: 0, requests: 0 }, reader = new FrameReader();
    ws.on('message', (raw, binary) => { if (!binary) return client.messages.push(JSON.parse(raw));
      const packet = reader.decode(raw); if (packet) client.frames.push(packet); else { client.asked++; ws.send(JSON.stringify({ type: 'resync' })); } });
    await once(ws, 'open'); ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name }));
    await until(() => client.messages.some(m => m.type === 'welcome')); client.welcome = client.messages.find(m => m.type === 'welcome');
    client.ask = async (type, data = {}) => { const request = ++client.requests; ws.send(JSON.stringify({ type, request, ...data }));
      await until(() => client.messages.some(m => m.request === request)); return client.messages.find(m => m.request === request); };
    client.actors = () => client.frames.at(-1)?.state.actors.map(a => a.id) || [];
    return client;
  };
  const alice = await connect('Alice'), bob = await connect('Bob');
  const mine = (await alice.ask('spawn', { blueprint: createStructuredTemplate('scout') })).actor.id,
    theirs = (await bob.ask('spawn', { blueprint: createStructuredTemplate('scout') })).actor.id;
  // Eighteen kilometres apart, each is told its own construction and nothing of the other's.
  await until(() => alice.actors().includes(mine) && bob.actors().includes(theirs));
  await until(() => alice.frames.length > 12 && bob.frames.length > 12);
  assert.deepEqual([alice.actors(), bob.actors()], [[mine], [theirs]]);
  for (const client of [alice, bob]) assert(client.frames.every(frame => frame.state.actors.length <= 1), 'not for one frame');
  assert.deepEqual([alice, bob].map(client => client.frames.filter(frame => frame.base === null).length), [1, 1],
    'a whole state when each came; a construction that comes into the field is told as what came');
  assert.deepEqual(alice.frames.at(-1).state.players.map(p => p.id), [alice.welcome.playerId], 'nor of whose it is');
  assert.match((await alice.ask('blueprint', { actorId: theirs })).error, /já não está no campo/);
  assert.match((await alice.ask('squad', { order: 'attack', ids: [mine], targetId: theirs })).error, /Alvo inválido/);
  assert.equal(alice.asked + bob.asked, 0, 'no frame of one faction was put on a state of another');
  // Carol comes with nothing and is told nothing of either. Invited by Bob, she joins his faction: the
  // very next state she is given is a whole one of that faction, with his construction in it.
  const carol = await connect('Carol');
  await until(() => carol.frames.length > 3); assert.deepEqual(carol.actors(), []);
  assert.equal((await bob.ask('invite', { playerId: carol.welcome.playerId })).error, undefined);
  const count = carol.frames.length;
  assert.equal((await carol.ask('join-faction', { factionId: bob.welcome.faction.id })).error, undefined);
  await until(() => carol.actors().includes(theirs));
  assert.equal(carol.frames.slice(count).find(frame => frame.state.actors.length)?.base, null, 'a whole state');
  assert.equal(carol.asked, 0, 'which she did not have to ask for'); assert.deepEqual(alice.actors(), [mine]);
  // A page that lost a frame asks, and is given a whole state of its own faction.
  const had = alice.frames.length; alice.ws.send(JSON.stringify({ type: 'resync' }));
  await until(() => alice.frames.slice(had).some(frame => frame.base === null));
  assert.deepEqual(alice.frames.slice(had).find(frame => frame.base === null).state.actors.map(a => a.id), [mine]);
});
