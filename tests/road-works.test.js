import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { SharedRoom, rehearsal, asked } from '../server/room.ts';
import { ROAD_CHUNK, ROAD_LANE } from '../server/road-works.ts';
import { PRIORITY } from '../server/supply-dispatch.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { PAVING, bill, billSum, carriedBy, fieldParts, pavedBy, stow, supplied } from '../src/economy.ts';
import { MIX_VOLUME, cargoRoom, mixRoom } from '../src/component-volume.ts';
import { toolOffset } from '../src/road-tools.ts';
import { ARRIVAL, SETTLED } from '../src/squad.ts';
import { stretches, length } from '../src/roads.ts';
import { ROAD_LONGEST, ROAD_SHORTEST } from '../src/road-site.ts';
import { onField } from './helpers/field.js';
import { chapters } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { chassisRear } from '../src/chassis.ts';
import { MODULES } from '../src/materials.ts';
import { CELL } from '../src/grid.ts';
import { compileBlueprint } from '../src/persistence.ts';

await initNativeDynamics();
// Road machines on a rehearsed field (server/road-works.ts, server/supply-dispatch.ts): what takes time is the real way there
// and along the road, driven by the squad, and the tools at the pace of their engines. The base stands on its apron of
// asphalt, `BASE_RADIUS` either side of it: the roads asked for here begin past it.
const bases = [-213, 30000], plenty = bill(1e9, 1e9, 1e9, 1e9);
function setup(t, { stock = plenty, fog = false } = {}) {
  const room = rehearsal(bases, stock, { fog }), f = onField(t, room), player = room.join('Estradeira'), world = room.world,
    faction = room.faction(room.players.get(player.playerId)), base = faction.base.x;
  const dispatch = room.supplyDispatch, x = id => room.position(world.actor(id)), squad = () => room.players.get(player.playerId).squad;
  return { ...f, player, world, faction, base, dispatch, x, squad,
    // A road asked for, and the look of the field after it, where the plan of the faction gives it to its machines.
    road: data => { const answer = f.send(player, 'road', data); f.run(.1); return answer; }, unit: id => room.factionView(player.playerId).units.find(u => u.id === id),
    roads: () => room.factionView(player.playerId).roadworks, job: id => dispatch.jobs.get(id),
    // How many metres between two places are of a kind of road, or of none.
    made: (a, b, kind) => length(stretches(room.field.roads, a, b, kind)),
    crates: id => supplied(carriedBy(room.serving(id)).carried), hopper: id => supplied(carriedBy(room.pavers(id)).carried) };
}
// The lorry of the templates made a paver: the paver on its tail in place of its hopper, metres behind the middle of a long
// frame. A piece at `x` (in cells, grid.ts), touching its chosen real upper face; one on the tail, on the cell within it.
const onSurface = (design, kind, x, sizeScale = 1, surface = 'chassis:top-0') => {
  const compiled = compileBlueprint(design), floor = compiled.plates.find(plate => plate.id === surface);
  assert(floor && Math.abs(Math.sin(floor.angle)) < 1e-12, 'these deck fixtures have a real level floor');
  return { id: kind, kind, sizeScale, pose: { x,
    y: (floor.y - compiled.frame.origin.y + floor.thicknessMm / 2000 + MODULES[kind].height * sizeScale / 2) / CELL, angle: 0 } };
};
const onTail = (design, width) => Math.floor((chassisRear(design.chassis) - width / 2) / CELL + 1e-9);
const longPaver = () => {
  const design = createStructuredTemplate('truck');
  return { ...design, components: [...design.components.filter(part => part.kind !== 'hopper'), onSurface(design, 'paver', onTail(design, MODULES.paver.width))] };
};
// A small supply box rests on the paver's low service housing, rather than intersecting that real roof.
const crated = () => {
  const design = createStructuredTemplate('paver');
  return { ...design, components: [...design.components, onSurface(design, 'supply', 15, .8, 'conveyor:roof')] };
};
// The supply lorry of the templates with a paver of half its size on its tail: its supply piece, of 190 %, takes the mix
// of more asphalt than its hopper does.
const LADEN_SUPPLY = 1.9;
const laden = () => {
  const design = createStructuredTemplate('supply'), cargo = design.components.find(p => p.kind === 'supply'),
    width = MODULES.supply.width * LADEN_SUPPLY;
  // Its supply piece, a little shorter than the template's, stands on the floor 5 cm behind the actual cab, leaving the
  // tail for the extra screed.
  Object.assign(cargo, onSurface(design, 'supply', design.nodes.find(n => n.id === 'hull-1').x + (.05 + width / 2) / CELL, LADEN_SUPPLY), { id: cargo.id });
  return { ...design, components: [...design.components, onSurface(design, 'paver', onTail(design, MODULES.paver.width * .5), .5)] };
};
// Two half-sized blades meet side by side where the one blade was: each hangs from the frame by its own column.
const twoBlades = () => {
  const design = createStructuredTemplate('grader'), blade = design.components.find(part => part.kind === 'blade');
  return { ...design, components: [...design.components.filter(part => part.kind !== 'blade'),
    ...[-1, 1].map((side, i) => ({ id: 'blade' + i, kind: 'blade', sizeScale: .5,
      pose: { ...blade.pose, x: blade.pose.x + side * MODULES.blade.width / (4 * CELL),
        y: blade.pose.y + MODULES.blade.height / (4 * CELL) } }))] };
};

// This uses actual stock transfer before the one initial fixture placement; no free mixture is introduced.
function roadDepartureMix(f, id, metres) {
  const actor = f.world.actor(id);
  f.dispatch.stow(actor, f.faction, bill(0, 0, PAVING.silica * metres, PAVING.combustivel * metres), f.room.roadworks.mixers(actor));
}

test('joining another faction removes the dissolved faction roads and their aged demands from the field and its save', t => {
  const f = setup(t), other = f.room.join('Outra facção'),
    ours = f.road({ x0: f.base + 110, x1: f.base + 180, kind: 'graded' }).road.id,
    theirs = f.send(other, 'road', { x0: other.base.x + 110, x1: other.base.x + 180, kind: 'graded' }).road.id;
  const dispatch = f.room.supplyDispatch, parts = fieldParts(f.world);
  for (const faction of f.room.factions.values()) dispatch.demands(faction, parts);
  assert([...dispatch.since.values()].some(row => row.factionId === f.faction.id));
  assert([...dispatch.since.values()].some(row => row.factionId === other.faction.id));
  f.send(other, 'invite', { playerId: f.player.playerId });
  f.send(f.player, 'join-faction', { factionId: other.faction.id });
  assert(!f.room.factions.has(f.faction.id), 'the old faction has no remaining member');
  assert(!f.room.roadworks.pending.has(ours), 'its road cannot outlive it');
  assert(f.room.roadworks.pending.has(theirs), 'the destination faction keeps its road');
  assert.deepEqual(f.room.keep().roadworks.map(road => road.id), [theirs]);
  f.run(1);
  assert(![...dispatch.since.values()].some(row => row.factionId === f.faction.id), 'retired priorities are reclaimed even with no automatic crew');
  assert([...dispatch.since.values()].some(row => row.factionId === other.faction.id), 'a living faction keeps its waiting priority');
});

for (const side of [1, -1]) test(`road departure O1: an empty paver starts from the base-side end after collecting (${side})`, t => {
  const f = setup(t), id = f.publish(f.player, 'paver', { facing: side }), near = f.base + side * 110, far = f.base + side * 230;
  f.room.pave(Math.min(near, far), Math.max(near, far), 'graded'); f.run(1); f.put(id, far + side * 20);
  assert.equal(f.room.roadworks.aboard(f.world.actor(id)), 0, 'the first trip is explicitly empty');
  const silica = f.faction.stock.silica;
  f.road({ x0: near, x1: far, kind: 'asphalt' });
  assert.equal(f.job(id).phase, 'collect', 'it must collect before any of this new lane is worked');
  assert.equal(f.job(id).front, f.job(id).lane.from);
  assert(f.until(() => f.job(id)?.phase === 'go' && f.room.roadworks.aboard(f.world.actor(id)) > 0, 90), 'it collects and begins its outward trip');
  const job = f.job(id);
  assert(f.room.atBase(f.faction, f.world.actor(id)), 'inspect the actual departure, before it drives away');
  assert.deepEqual(job.lane, { from: near, to: near + side * ROAD_LANE, dir: side }, 'a virgin lane begins nearest the actual loaded departure');
  assert.equal(job.front, near); assert.equal(job.start, near);
  assert(f.faction.stock.silica < silica, 'the mixture came from the faction stocks');
});

for (const side of [1, -1]) test(`road departure E1: newly graded ground is considered once an untouched paver leaves collection (${side})`, t => {
  const f = setup(t), id = f.publish(f.player, 'paver', { facing: side }), near = f.base + side * 110, far = f.base + side * 230;
  // An isolated eligibility event models a grader exposing another piece while the paver is returning for mixture.
  f.room.pave(Math.min(far - side * 30, far), Math.max(far - side * 30, far), 'graded'); f.run(1); f.put(id, far + side * 20);
  assert.equal(f.room.roadworks.aboard(f.world.actor(id)), 0);
  f.road({ x0: near, x1: far, kind: 'asphalt' });
  assert.equal(f.job(id).phase, 'collect');
  assert([f.job(id).lane.from, f.job(id).lane.to].every(x => x >= Math.min(far - side * 30, far) && x <= Math.max(far - side * 30, far)),
    'only the remote span was initially eligible, whichever side collection approaches it from');
  f.room.pave(Math.min(near, near + side * 30), Math.max(near, near + side * 30), 'graded');
  assert(f.until(() => f.job(id)?.phase === 'go' && f.room.roadworks.aboard(f.world.actor(id)) > 0, 90));
  const job = f.job(id);
  assert(f.room.atBase(f.faction, f.world.actor(id)));
  assert.deepEqual(job.lane, { from: near, to: near + side * 30, dir: side }, 'refresh only the untouched lane from current eligibility and claims');
  assert.equal(job.front, near); assert.equal(job.start, near);
});

for (const side of [1, -1]) for (const design of ['paver', 'grader'])
  test(`road departure direct: a ready ${design} keeps the end nearest its current place (${side})`, t => {
    const f = setup(t), id = f.publish(f.player, design, { facing: side }), near = f.base + side * 110, far = f.base + side * 230;
    if (design === 'paver') f.room.pave(Math.min(near, far), Math.max(near, far), 'graded');
    f.run(1); if (design === 'paver') roadDepartureMix(f, id, 10); f.put(id, far + side * 20);
    f.road({ x0: near, x1: far, kind: design === 'paver' ? 'asphalt' : 'graded' });
    const job = f.job(id);
    assert.equal(job.phase, 'go', 'no collection detour is needed');
    assert.deepEqual(job.lane, { from: far, to: far - side * ROAD_LANE, dir: -side }, 'a base preference is not imposed on direct work');
  });

for (const side of [1, -1]) test(`road departure partial: a paver resumes its worked front after replenishing (${side})`, t => {
  const f = setup(t), id = f.publish(f.player, 'paver', { facing: side }), near = f.base + side * 110, far = f.base + side * 230;
  f.room.pave(Math.min(near, far), Math.max(near, far), 'graded'); f.run(1); roadDepartureMix(f, id, 10); f.put(id, far + side * 20);
  f.road({ x0: near, x1: far, kind: 'asphalt' });
  const originalJob = f.job(id), lane = { ...originalJob.lane };
  assert.equal(originalJob.phase, 'go'); assert.equal(lane.from, far);
  assert(f.until(() => f.job(id)?.phase === 'collect' && (f.job(id).front - lane.from) * lane.dir > 1, 160), 'some of its real lane is made before its small load runs short');
  const front = f.job(id).front;
  assert.equal(f.job(id).start, front, 'commit may make start equal front even though this lane was worked');
  assert.notEqual(front, lane.from, 'this is a partial lane, not a new one');
  assert(f.until(() => f.job(id)?.phase === 'go' && f.room.roadworks.aboard(f.world.actor(id)) > 1, 120), 'it replenishes at the base');
  const resumed = f.job(id);
  assert.strictEqual(resumed, originalJob); assert.deepEqual(resumed.lane, lane);
  assert.equal(resumed.front, front); assert.equal(resumed.start, front, 'a committed partial front is retained exactly');
});

for (const side of [1, -1]) test(`road departure quote: competing roads use the lane reached after collection (${side})`, t => {
  const f = setup(t), id = f.publish(f.player, 'paver', { facing: side }), actor = f.world.actor(id),
    near = f.base + side * 110, far = f.base + side * 230, otherNear = f.base + side * 300, otherFar = f.base + side * 320;
  f.run(1); f.put(id, f.base + side * 500);
  f.room.pave(Math.min(near, far), Math.max(near, far), 'graded');
  f.room.pave(Math.min(otherNear, otherFar), Math.max(otherNear, otherFar), 'graded');
  const road = f.room.roadworks.open(f.faction, { x0: near, x1: far, kind: 'asphalt' }),
    other = f.room.roadworks.open(f.faction, { x0: otherNear, x1: otherFar, kind: 'asphalt' });
  // Declared quotation-only timing: 5 m/s travel and 1 m/s work. No physical speed claim or extra world stepping.
  f.dispatch.travel = (vehicle, from, to) => Math.abs(to - from) / 5;
  f.dispatch.rate = (vehicle, part) => part === 'pave' ? 1 : 0;
  const man = f.dispatch.crewman(actor), first = f.dispatch.offer(man, { kind: 'pave', road }, f.faction, []),
    second = f.dispatch.offer(man, { kind: 'pave', road: other }, f.faction, []);
  assert.equal(first.phase, 'collect'); assert.equal(second.phase, 'collect');
  assert(first.seconds < second.seconds, `equal-priority roads are ranked by the actual next trip, not the obsolete remote span: ${JSON.stringify({ first, second })}`);
  assert.equal(first.lane.from, near); assert.equal(first.lane.dir, side);
  assert.equal(second.lane.from, otherNear); assert.equal(second.lane.dir, side);
});

test('a road is asked for by its faction over ground it saw, and refused in words otherwise, before anything is done', t => {
  const f = setup(t, { fog: true }), { room, base } = f, grader = f.publish(f.player, 'grader'), truck = f.publish(f.player, 'supply');
  f.run(1);
  const stock = { ...f.faction.stock }, at = base + 120;
  for (const [data, words] of [
    [{ x0: at, x1: at + 50, kind: 'gravel' }, 'Tipo de estrada inválido.'],
    [{ x0: at, x1: at + ROAD_SHORTEST - 1, kind: 'graded' }, `Trecho curto demais: no mínimo ${ROAD_SHORTEST} m.`],
    [{ x0: at, x1: at + ROAD_LONGEST + 1, kind: 'graded' }, 'Trecho longo demais: no máximo 10 km.'],
    [{ x0: base + 1500, x1: base + 1600, kind: 'graded' }, 'Terreno desconhecido: escolha chão já visto.'],
    [{ x0: room.limits.minX - 5, x1: room.limits.minX + 50, kind: 'graded' }, 'O trecho passa do limite do campo.'],
    [{ x0: base - 60, x1: base + 60, kind: 'asphalt' }, 'Esse trecho já é de asfalto.'],
    [{ x0: base - 60, x1: base + 60, kind: 'graded' }, 'Esse trecho já tem estrada.']])
    assert.throws(() => f.road(data), { message: words }, words);
  assert.deepEqual([f.roads(), room.roadworks.pending.size, f.faction.stock], [[], 0, stock], 'nothing was asked for nor paid');
  // Asked for where it may be, the reply names it; it costs nothing, and the road machine in automatic goes to it at once.
  const answer = f.road({ x0: at + 60, x1: at, kind: 'asphalt' });
  assert.deepEqual(answer, { road: { id: 'r1', x0: at, x1: at + 60, kind: 'asphalt' } }, 'its ends in order');
  assert.deepEqual(f.faction.stock, stock);
  assert.equal(room.record(f.world.actor(grader)).auto, true);
  assert.deepEqual(f.unit(grader).job, { kind: 'grade', phase: 'go', targetId: 'r1', reason: '' });
  assert.deepEqual(f.unit(grader).road, true); assert.equal(f.unit(truck).road, undefined);
  // Within it, of no more than what it makes, a road has nothing to make.
  for (const kind of ['graded', 'asphalt'])
    assert.throws(() => f.road({ x0: at + 10, x1: at + 50, kind }), { message: 'Já há uma estrada pedida nesse trecho.' });
  // Only its own faction is told of it.
  const other = room.join('Outra');
  assert.deepEqual(room.factionView(other.playerId).roadworks, []);
  assert.deepEqual(f.roads().map(road => [road.id, road.kind, road.graded, road.paved]), [['r1', 'asphalt', 0, 0]]);
  // What the field reads of the commands, and nothing else of them.
  assert.deepEqual(asked({ type: 'road', actorId: grader, x0: 1, x1: 20, kind: 'graded', paid: true }), { type: 'road', x0: 1, x1: 20, kind: 'graded' }, 'no machine is asked');
  assert.deepEqual(asked({ type: 'cancel-road', roadId: 'r1', refund: 1 }), { type: 'cancel-road', roadId: 'r1' });
  assert.equal(PRIORITY.grade, PRIORITY.build); assert.equal(PRIORITY.pave, PRIORITY.build);
});

test('a road asked for from one road to another, over both, is the ground between them, and the blade joins them', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 160, b = base + 260;
  f.run(1);
  // The apron of the base is asphalt; past it, a stretch of graded earth a hundred metres on.
  f.room.pave(b, b + 40, 'graded');
  const apron = stretches(room.field.roads, base, a, 'asphalt')[0][1];
  assert.deepEqual(f.road({ x0: b + 20, x1: apron - 30, kind: 'graded' }), { road: { id: 'r1', x0: apron, x1: b, kind: 'graded' } },
    'from the end of the asphalt to the start of the earth');
  assert.deepEqual(f.roads().map(road => [road.x0, road.x1, road.graded]), [[apron, b, 0]]);
  assert(f.until(() => !room.roadworks.pending.size, 200), 'it is made');
  assert.deepEqual([stretches(room.field.roads, apron - 30, b + 40, null), stretches(room.field.roads, apron, b + 40, 'graded')], [[], [[apron, b + 40]]],
    'and the two are one road, nothing left between');
  // Over them both, and nothing between, there is nothing to make.
  assert.throws(() => f.road({ x0: apron - 30, x1: b + 20, kind: 'graded' }), { message: 'Esse trecho já tem estrada.' });
  // Of asphalt, over the asphalt and the earth: the earth.
  assert.deepEqual(f.road({ x0: apron - 30, x1: b + 20, kind: 'asphalt' }).road, { id: 'r2', x0: apron, x1: b + 20, kind: 'asphalt' });
});

test('a road asked for over another asked for already makes what that one does not, and the stretch of both is made once, for the first', t => {
  const f = setup(t), { room, base, faction } = f, works = room.roadworks, a = base + 200;
  f.run(1);
  const open = (x0, x1, kind) => works.open(faction, { x0, x1, kind }), ends = road => [road.x0, road.x1, road.kind];
  const earth = open(a, a + 60, 'graded');
  // Of asphalt over it and on: all of it, the earth it grades paved by this one.
  const asphalt = open(a + 30, a + 120, 'asphalt');
  assert.deepEqual(ends(asphalt), [a + 30, a + 120, 'asphalt']);
  assert.deepEqual([works.left(asphalt, 'grade'), works.left(asphalt, 'pave')], [[[a + 60, a + 120]], []], 'the earth grades its own stretch, and nothing is graded yet');
  // Of graded earth over both and on: what neither makes. Within what they make, nothing.
  assert.deepEqual(ends(open(a + 40, a + 150, 'graded')), [a + 120, a + 150, 'graded']);
  assert.throws(() => open(a + 10, a + 140, 'graded'), { message: 'Já há uma estrada pedida nesse trecho.' });
  assert.throws(() => open(a + 40, a + 110, 'asphalt'), { message: 'Já há uma estrada pedida nesse trecho.' });
  // Of asphalt from before the earth to past the asphalt: the earth, and past the asphalt, though between them it makes nothing.
  const over = open(a - 20, a + 150, 'asphalt');
  assert.deepEqual([ends(over), works.left(over, 'grade'), works.left(over, 'pave')], [[a - 20, a + 150, 'asphalt'], [[a - 20, a]], []]);
  // The earth graded, the asphalt over it paves it; the earth asked for is made, and over that the last one paves too.
  room.pave(a, a + 60, 'graded');
  assert.deepEqual([works.done(earth), works.left(asphalt, 'pave'), works.left(over, 'pave')], [true, [[a + 30, a + 60]], [[a, a + 30]]]);
  // Given up, what a road was to make is the next one's: the last one grades the stretch of the first asphalt.
  works.cancel(asphalt);
  assert.deepEqual(works.left(over, 'grade'), [[a - 20, a], [a + 60, a + 120]]);
  // Told to the faction, each road says how much of all of its stretch is made, whoever made it.
  assert.deepEqual(f.roads().map(road => [road.x0, road.x1, road.graded]), [[a, a + 60, 1], [a + 120, a + 150, 0], [a - 20, a + 150, Math.floor(60 / 170 * 1000) / 1000]]);
});

test('roads asked for over one another are all made by the machines that come to them, none of them left waiting', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 160;
  f.run(1);
  f.road({ x0: a, x1: a + 60, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work', 60));
  // While it grades the first, a second is asked for from within it on: the blade goes to it, and comes back to the first.
  assert.deepEqual(f.road({ x0: a + 30, x1: a + 110, kind: 'graded' }).road, { id: 'r2', x0: a + 60, x1: a + 110, kind: 'graded' });
  assert(f.until(() => !room.roadworks.pending.size, 300), 'both are made');
  assert.deepEqual(stretches(room.field.roads, a - 10, a + 110, 'graded'), [[a, a + 110]]);
});

test('a fold of the ground no eye caught, between ground the faction explored, is known to it for a road: one wider is not', t => {
  const f = setup(t, { fog: true }), { faction, base } = f, grader = f.publish(f.player, 'grader');
  f.run(1);
  // Past what the base knows, a stretch the faction saw, with folds of 40 m and of 48 m in it.
  const at = base + 5000, seen = [[at, at + 100], [at + 140, at + 300], [at + 348, at + 500]];
  faction.explored = [...faction.explored.filter(([, to]) => to < at), ...seen];
  assert.deepEqual(f.road({ x0: at + 20, x1: at + 200, kind: 'graded' }).road, { id: 'r1', x0: at + 20, x1: at + 200, kind: 'graded' });
  assert.throws(() => f.road({ x0: at + 250, x1: at + 400, kind: 'graded' }), { message: 'Terreno desconhecido: escolha chão já visto.' });
});

test('a blade grades natural ground along its lane at its rate, driven no faster than it works, laid a chunk at a time', t => {
  const f = setup(t), { room, base, world } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 60;
  f.run(1);
  const asked = [], power = room.power.bind(room);
  room.power = (actor, tools, seconds) => { if (actor.id === grader) asked.push({ kinds: tools.map(piece => piece.kind), seconds }); return power(actor, tools, seconds); };
  const fuel = () => world.actor(grader).vehicle.fuelLitres;
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work', 60), 'it gets to its lane');
  assert.deepEqual(f.job(grader).lane, { from: a, to: a + ROAD_LANE, dir: 1 }, 'the first lane, from the end it comes from');
  const laid = [], start = world.time, before = fuel();
  let roads = room.field.roads, seen = 0;
  const watch = () => {
    if (room.field.roads !== roads) { roads = room.field.roads; const now = f.made(a, b, 'graded'); laid.push(now - seen); seen = now; }
    return !room.roadworks.pending.size;
  };
  // Twenty seconds into its work it has graded twenty metres, give or take what a chunk not yet laid holds.
  f.until(() => { watch(); return world.time - start >= 20; }, 30);
  const front = (f.job(grader).front - a);
  assert(Math.abs(front - 20) < 1.5, `${front} m in 20 s`);
  assert(f.x(grader) - a < front + 3 + 1.5, 'it is held no further ahead of what it graded than its tools reach');
  assert.deepEqual(f.unit(grader).tools, { pace: 1 }, 'its faction is told its blade works at all of its pace');
  assert(f.until(watch, 120), 'all of it is graded');
  assert.deepEqual(stretches(room.field.roads, a, b, 'graded'), [[a, b]]);
  assert(laid.length >= 6 && laid.every(metres => metres <= ROAD_CHUNK + 1e-6 && metres > 0), `laid in chunks: ${laid}`);
  // Its engines were asked for its blade at every look while it worked, and burnt fuel for it.
  assert(asked.length > 500 && asked.every(call => call.kinds.join() === 'blade'));
  assert(Math.abs(asked.reduce((sum, call) => sum + call.seconds, 0) - 60) < 8, 'about as long as it worked');
  assert(fuel() < before);
  f.run(3);
  assert.deepEqual([room.roadworks.pending.size, f.unit(grader).job.phase], [0, 'idle'], 'done with, the machine has nothing more to do');
  const stood = f.x(grader); f.run(5);
  assert(Math.abs(f.x(grader) - stood) < .5 && Math.abs(stood - b) < 5, 'and stays where it finished');
});

test('a blade a hair short of the end of its lane is at its end: it lays all of it and goes on with the next', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 2 * ROAD_LANE;
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work' && (f.job(grader).lane.to - f.job(grader).front) * f.job(grader).lane.dir < .5, 120));
  // Twenty kilometres along the field, the steps of a blade over its lane sum up to as much short of where it ends.
  const job = f.job(grader); job.front = job.lane.to - job.lane.dir * 1e-8;
  assert(f.until(() => f.job(grader)?.lane.from === a + ROAD_LANE, 5), `it goes on with the next lane: ${JSON.stringify(f.job(grader)?.lane)}`);
  assert.deepEqual(stretches(room.field.roads, a, a + ROAD_LANE, 'graded'), [[a, a + ROAD_LANE]]);
  assert(f.until(() => !room.roadworks.pending.size, 90), 'and makes the road');
});

test('a blade at the end of its lane goes on with the next at that very look, by itself: its pace never falls to nothing between them', t => {
  const f = setup(t), { room, base, dispatch } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 2 * ROAD_LANE;
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work', 60));
  // The dispatch looks no more from here on: what is done at the end of the lane the machine's own look does (Roadworks.step).
  // A blade faster than the dispatch looks would otherwise run past what it did for as long as that takes.
  dispatch.nextAt = Infinity;
  const first = f.job(grader).lane, paces = [];
  assert(f.until(() => {
    const job = f.job(grader);
    assert(job.lane !== first || (job.lane.to - job.front) * job.lane.dir > 1e-9, 'come to the end of its lane, it is on the next');
    paces.push(job.leg.pace);
    return !room.roadworks.pending.size;
  }, 2 * ROAD_LANE * 1.5), 'it makes the road');
  assert.deepEqual(stretches(room.field.roads, a, b, 'graded'), [[a, b]]);
  assert(Math.min(...paces) > .5, `its pace at the least ${Math.min(...paces)} m/s`);
});

test('a machine at work goes on into the lane beyond its own though one far off is on its way to it: that one takes another', t => {
  const f = setup(t), { room, base } = f, near = f.publish(f.player, 'grader'), far = f.publish(f.player, 'grader'), a = base + 110, b = a + 3 * ROAD_LANE;
  f.run(1);
  f.send(f.player, 'auto', { actorId: far, on: false });
  f.put(far, base - 4000);
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(near), 5));
  f.send(f.player, 'auto', { actorId: far, on: true });
  assert(f.until(() => f.job(far), 5));
  const span = lane => [Math.min(lane.from, lane.to), Math.max(lane.from, lane.to)];
  assert.deepEqual([span(f.job(near).lane), span(f.job(far).lane)], [[a, a + ROAD_LANE], [a + ROAD_LANE, a + 2 * ROAD_LANE]], 'each the lane left nearest it');
  // Four kilometres off, it is still on its way when the one at work is done with its lane, which goes on into the next
  // and grades the road without a gap; the one coming takes what is left nearest it, as long as there is any.
  const lanes = [], taken = [];
  assert(f.until(() => {
    const mine = f.job(near)?.lane, theirs = f.job(far)?.lane;
    if (mine && lanes.at(-1) !== mine) lanes.push(mine);
    if (theirs && taken.at(-1) !== theirs) taken.push(theirs);
    if (lanes.length > 1) assert.deepEqual(stretches(room.field.roads, a, span(lanes.at(-1))[0], 'graded'), [[a, span(lanes.at(-1))[0]]], 'no gap behind it');
    return !room.roadworks.pending.size;
  }, 3 * ROAD_LANE * 1.5), 'the road is made');
  assert.deepEqual(lanes.map(span), [0, 1, 2].map(i => [a + i * ROAD_LANE, a + (i + 1) * ROAD_LANE]), 'one lane after the other');
  assert.deepEqual(taken.map(span), [1, 2].map(i => [a + i * ROAD_LANE, a + (i + 1) * ROAD_LANE]), 'the one coming, each lane left nearest it');
  assert.deepEqual(stretches(room.field.roads, a, b, 'graded'), [[a, b]]);
  assert(Math.abs(f.x(far) - base) > 1000, 'the one far off never came');
  f.run(2);
  assert.equal(f.job(far), undefined, 'nothing is left for it');
});

test('several blades add up: two on one vehicle grade twice as fast, and two vehicles on one road each take a lane of their own', t => {
  const f = setup(t), { room, base, world } = f, twin = f.publish(f.player, twoBlades());
  f.run(1);
  // Each half-sized blade grades at a quarter of the pace of the reference one, the square of its size.
  assert.equal(room.roadworks.rate(world.actor(twin), 'grade'), .5);
  const a = base + 110;
  f.road({ x0: a, x1: a + 20, kind: 'graded' });
  assert(f.until(() => f.job(twin)?.phase === 'work', 60));
  const start = world.time;
  assert(f.until(() => !room.roadworks.pending.size, 200));
  assert(Math.abs(world.time - start - 20 / .5) < 6, `20 m in ${world.time - start} s at 0.5 m/s`);
  // Two graders on a road twice the length of a lane: both work it at once, on lanes of their own.
  const one = f.publish(f.player, 'grader'), two = f.publish(f.player, 'grader'), from = base + 200, to = from + 2 * ROAD_LANE;
  f.run(1);
  f.road({ x0: from, x1: to, kind: 'graded' });
  assert(f.until(() => f.job(one)?.phase === 'work' && f.job(two)?.phase === 'work', 90), 'both go to work on it');
  const [first, second] = [one, two].map(id => f.job(id).lane), span = lane => [Math.min(lane.from, lane.to), Math.max(lane.from, lane.to)];
  assert.equal(first.dir, 1); assert.deepEqual([span(first), span(second)].sort((x, y) => x[0] - y[0]), [[from, from + ROAD_LANE], [from + ROAD_LANE, to]]);
  const working = world.time;
  assert(f.until(() => !room.roadworks.pending.size, 150));
  assert(world.time - working < 2 * ROAD_LANE * .7, `${world.time - working} s for ${2 * ROAD_LANE} m with two of them`);
  assert.deepEqual(stretches(room.field.roads, from, to, 'graded'), [[from, to]]);
});

test('asphalt over natural ground is graded first: the paver waits for the blade, and paves behind it only what is graded', t => {
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, 'paver'), grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 2 * ROAD_LANE;
  f.run(1);
  // Asked for from the paver, nothing is graded yet: it has nothing to do and says why, and the blade is given the grading.
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  assert.equal(f.job(paver), undefined);
  f.run(1.5);
  assert.deepEqual(f.unit(paver).job, { kind: null, phase: 'idle', targetId: null, reason: 'waiting-grade' });
  assert.equal(f.job(grader)?.kind, 'grade');
  let before = room.field.roads, paved = false;
  const behind = () => {
    if (room.field.roads !== before) {
      // Asphalt is laid only where the ground was graded already, never over natural ground.
      for (const [from, to] of stretches(room.field.roads, a, b, 'asphalt'))
        assert(!stretches(before, from, to, null).length, `asphalt over natural ground at [${from}, ${to}]`);
      before = room.field.roads;
    }
    paved ||= f.made(a, b, 'asphalt') > 0 && f.made(a, b, null) > 0;
    return !room.roadworks.pending.size;
  };
  assert(f.until(behind, 900), 'the road is made');
  assert(paved, 'the paver paved behind the blade while it was still grading');
  assert.deepEqual(stretches(room.field.roads, a, b, 'asphalt'), [[a, b]]);
  assert(world.actor(grader) && world.actor(paver));
});

test('a paver pays for every metre it paves out of the hopper of its paver, filled at the base, and goes back for more when it runs out', t => {
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, 'paver'), a = base + 110, b = a + 120;
  room.pave(a, b, 'graded'); f.run(1);
  assert.deepEqual([room.serving(paver), room.pavers(paver).length], [[], 1], 'the Pavimentadora carries no supply piece');
  assert(Math.abs(mixRoom(room.pavers(paver)[0]) - 45) < 1e-9, 'its hopper takes the mix of 45 m of asphalt');
  const taken = [], loads = [], commit = room.roadworks.commit.bind(room.roadworks), fill = f.dispatch.stow.bind(f.dispatch);
  room.roadworks.commit = (job, actor, to) => {
    const held = f.hopper(actor.id), laid = commit(job, actor, to), now = f.hopper(actor.id);
    if (laid > 0) taken.push({ laid, silica: held.silica - now.silica, combustivel: held.combustivel - now.combustivel });
    return laid;
  };
  // What it takes on at the base, each time: the mix for what is left to pave, a twentieth and a metre more, as far as its
  // hopper takes it.
  f.dispatch.stow = (actor, faction, wanted, pieces) => {
    if (actor.id === paver) loads.push({ left: f.dispatch.unpaved(room.roadworks.pending.get('r1')), before: pavedBy(f.hopper(paver)) });
    fill(actor, faction, wanted, pieces);
    if (actor.id === paver) loads.at(-1).after = pavedBy(f.hopper(paver));
  };
  const silica = f.faction.stock.silica, phases = [];
  assert.equal(pavedBy(f.hopper(paver)), 0, 'it comes on the field with its hopper empty');
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  // Standing in the base, it fills its hopper there at once: as far as it takes, for a road longer than that.
  assert(Math.abs(pavedBy(f.hopper(paver)) - 45) < 1e-6, `${pavedBy(f.hopper(paver))} m of asphalt aboard`);
  assert.deepEqual(f.hopper(paver), bill(0, 0, PAVING.silica * 45, PAVING.combustivel * 45));
  assert.equal(f.job(paver).phase, 'go');
  f.run(1);
  const full = world.actor(paver).vehicle.mass;
  assert(f.until(() => {
    const job = f.job(paver), phase = job ? job.phase + (job.phase === 'collect' && room.atBase(f.faction, world.actor(paver)) ? '@base' : '') : 'none';
    if (phases.at(-1) !== phase) phases.push(phase);
    return !room.roadworks.pending.size;
  }, 1800), 'the road is paved');
  assert.deepEqual(stretches(room.field.roads, a, b, 'asphalt'), [[a, b]]);
  // Each metre took 280 Sílica and 14 L out of its hopper, as it was laid.
  const metres = taken.reduce((sum, chunk) => sum + chunk.laid, 0);
  assert(Math.abs(metres - 120) < .01, `${metres} m laid: ${JSON.stringify(taken.map(chunk => chunk.laid))}`);
  for (const chunk of taken) {
    assert(Math.abs(chunk.silica - PAVING.silica * chunk.laid) < 1e-6, JSON.stringify(chunk));
    assert(Math.abs(chunk.combustivel - PAVING.combustivel * chunk.laid) < 1e-6, JSON.stringify(chunk));
  }
  // A hopper does not pave 120 m: it went back for more, and took the work up where it had left it.
  const trips = phases.filter(phase => phase === 'collect@base').length;
  assert(trips >= 2, `it loaded ${trips} times: ${phases.join(' → ')}`);
  assert(phases.indexOf('work') < phases.lastIndexOf('collect@base'), phases.join(' → '));
  assert.equal(loads.length, 3, JSON.stringify(loads));
  for (const { left, before, after } of loads) {
    assert.equal(before, 0, 'what was left in it went back to the stocks first');
    assert(Math.abs(after - Math.min(45, left * 1.05 + 1)) < .01, `${after} m loaded for ${left} m left`);
  }
  assert(loads.at(-1).after < 45, 'the last load is the mix for what was left to pave');
  // What it paved came out of the stocks of the faction, through what it loaded at the base; the rest went back to them.
  assert(Math.abs(silica - f.faction.stock.silica - PAVING.silica * metres - f.hopper(paver).silica) < 1e-6);
  f.run(.5);
  assert(world.actor(paver).vehicle.mass < full - 10000, `it weighed ${full} kg with its hopper full, ${world.actor(paver).vehicle.mass} kg with ${pavedBy(f.hopper(paver))} m of mix left`);
});

test('a paver with supply pieces loads them too with the mix at the base, feeds its hopper out of them as it lays, and goes back only when both are spent', t => {
  // A road of 80 m: the mix of 31 m it takes at a time is loaded thrice.
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, laden()), a = base + 110, b = a + 80;
  room.pave(a, b, 'graded'); f.run(1);
  const hopper = mixRoom(room.pavers(paver)[0]), crates = room.serving(paver).reduce((sum, piece) => sum + cargoRoom(piece), 0) / MIX_VOLUME;
  assert(Math.abs(hopper - 45 * .5 ** 2) < 1e-9 && crates > hopper, `its hopper takes the mix of ${hopper} m, its supply piece of ${crates} m`);
  const loads = [], fed = [], trips = [], fill = f.dispatch.stow.bind(f.dispatch), commit = room.roadworks.commit.bind(room.roadworks);
  f.dispatch.stow = (actor, faction, wanted, pieces) => {
    fill(actor, faction, wanted, pieces);
    if (actor.id === paver) loads.push({ hopper: pavedBy(f.hopper(paver)), crates: pavedBy(f.crates(paver)), mix: { ...f.crates(paver) } });
  };
  room.roadworks.commit = (job, actor, to) => {
    const laid = commit(job, actor, to);
    if (laid > 0) fed.push({ hopper: pavedBy(f.hopper(paver)), crates: pavedBy(f.crates(paver)) });
    return laid;
  };
  const silica = f.faction.stock.silica;
  let was = null;
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  assert(f.until(() => {
    const phase = f.job(paver)?.phase ?? 'none';
    // Each time it leaves its work for the base: how much it paved since it last loaded, and the mix it had left.
    if (was === 'work' && phase === 'collect') trips.push({ paved: f.made(a, b, 'asphalt') - trips.reduce((sum, trip) => sum + trip.paved, 0),
      left: pavedBy(f.hopper(paver)) + pavedBy(f.crates(paver)), crates: f.crates(paver) });
    was = phase;
    return !room.roadworks.pending.size;
  }, 1800), 'the road is paved');
  assert.deepEqual(stretches(room.field.roads, a, b, 'asphalt'), [[a, b]]);
  // At the base it fills its hopper, and its supply piece with the mix of as much more as it takes, in the share a metre of
  // road takes of each — as far as what is left to pave, a twentieth and a metre more, asks.
  assert.equal(loads.length, 3, JSON.stringify(loads));
  for (const load of loads.slice(0, 2)) {
    assert(Math.abs(load.hopper - hopper) < 1e-6 && Math.abs(load.crates - crates) < .05, JSON.stringify(load));
    assert(Math.abs(load.mix.combustivel / load.mix.silica - PAVING.combustivel / PAVING.silica) < 1e-3, JSON.stringify(load.mix));
  }
  // It paved more than its hopper takes before it went back, and went back only with neither holding the mix of a metre:
  // nothing of what its supply piece carried was left over in it.
  assert.equal(trips.length, 2, JSON.stringify(trips));
  for (const trip of trips) assert(trip.paved > hopper + crates - 1 - 1e-6 && trip.left < 1 && trip.crates.silica + trip.crates.combustivel < 1e-6, JSON.stringify(trips));
  // As it laid, its hopper was kept full out of its supply piece, as long as that had the mix for it.
  assert(fed.length >= 10);
  for (const now of fed) assert(now.crates < 1e-6 || Math.abs(now.hopper - hopper) < 1e-6, JSON.stringify(now));
  // What it paved came out of the stocks of the faction; what is left aboard is the rest of what it loaded.
  assert(Math.abs(silica - f.faction.stock.silica - PAVING.silica * 80 - f.hopper(paver).silica - f.crates(paver).silica) < 1e-6);
});

test('a paver at the road with the mix in its supply pieces paves out of them through its hopper, without going by the base, and fuels nobody else out of them', t => {
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, crated()), tank = f.publish(f.player, 'heavy'), a = base + 130, b = a + 10;
  room.pave(a, b, 'graded'); room.pave(a, b - 1.5, 'asphalt'); f.run(1);
  const crates = room.serving(paver);
  assert.equal(crates.length, 1);
  // Its supply piece carries the mix of what is left to pave and a metre more, its hopper nothing, and it stands at the road
  // waiting for a road of asphalt further on to be graded, a tank out of fuel beside it.
  f.road({ x0: base + 300, x1: base + 340, kind: 'asphalt' });
  for (const [material, units] of [['silica', PAVING.silica * 2.5], ['petroleo', PAVING.combustivel * 2.5]]) room.carry(stow(crates, material, units).changed);
  world.command('sync');
  f.put(paver, a - 5); f.put(tank, a - 15);
  for (const piece of f.parts(tank, 'fuel')) f.set(piece, { fuelLitres: 0 });
  f.run(3);
  const aboard = { ...f.crates(paver) }, stock = { ...f.faction.stock };
  assert.deepEqual([f.unit(paver).job.reason, room.still(world.actor(paver))], ['waiting-grade', true]);
  assert(Math.abs(pavedBy(aboard) - 2.5) < 1e-9 && pavedBy(f.hopper(paver)) === 0);
  assert(world.actor(tank).vehicle.fuelLitres < 1, 'the tank is not fuelled out of the mix a road machine in automatic carries');
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  // It goes to the road with what it carries.
  assert.equal(f.job(paver).phase, 'go');
  assert(f.until(() => room.roadworks.done(room.roadworks.pending.get('r2') ?? { x0: a, x1: b, kind: 'asphalt' }), 300), 'the road is paved');
  assert.deepEqual(stretches(room.field.roads, a, b, 'asphalt'), [[a, b]]);
  // Its supply piece paid for the 1.5 m, and what was left of it is in its hopper; the stocks paid nothing.
  assert.deepEqual(f.faction.stock, stock);
  const left = billSum(f.crates(paver), f.hopper(paver));
  assert(Math.abs(aboard.silica - left.silica - PAVING.silica * 1.5) < 1e-6 && Math.abs(aboard.combustivel - left.combustivel - PAVING.combustivel * 1.5) < 1e-6,
    JSON.stringify({ aboard, crates: f.crates(paver), hopper: f.hopper(paver) }));
  assert(Math.abs(pavedBy(f.hopper(paver)) - 1) < 1e-6 && pavedBy(f.crates(paver)) < 1e-6, 'the rest went into its hopper');
});

test('the mix in its hopper is for the asphalt: a paver out of fuel with its hopper full waits for fuel, and its hopper keeps all of it', t => {
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, 'paver'), a = base + 130, b = a + 20;
  room.pave(a, b, 'graded'); f.run(1);
  const pavers = room.pavers(paver);
  for (const [material, units] of [['silica', PAVING.silica * 30], ['petroleo', PAVING.combustivel * 30]]) room.carry(stow(pavers, material, units).changed);
  world.command('sync');
  f.put(paver, a - 5);
  for (const tank of f.parts(paver, 'fuel')) f.set(tank, { fuelLitres: 0 });
  f.run(1);
  const held = { ...f.hopper(paver) };
  assert(pavedBy(held) >= 30 - 1e-9 && world.actor(paver).vehicle.fuelLitres < 1);
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  f.run(20);
  assert.deepEqual(f.hopper(paver), held, 'none of its Combustível went to its engine');
  assert(world.actor(paver).vehicle.fuelLitres < 1, 'its tank is as empty as it was');
  assert.equal(f.made(a, b, 'asphalt'), 0);
});

test('a small paver goes out with what its hopper takes, though that is the mix for under 3 m, and goes back for more', t => {
  const design = createStructuredTemplate('paver'), small = { ...design, components: design.components.map(part => part.kind === 'paver' ? { ...part, sizeScale: .25,
    pose: { ...part.pose, y: onSurface(design, 'paver', part.pose.x, .25).pose.y } } : part) };
  const f = setup(t), { room, base } = f, paver = f.publish(f.player, small), a = base + 110, b = a + 10;
  // The last 5 m of the road are left to pave: more than its hopper takes the mix of, and more than one load lays.
  room.pave(a, b, 'graded'); room.pave(a, b - 5, 'asphalt'); f.run(1);
  const holds = mixRoom(room.pavers(paver)[0]), loads = [], fill = f.dispatch.stow.bind(f.dispatch);
  assert(Math.abs(holds - 45 * .25 ** 2) < 1e-9 && holds < 3, `its hopper takes the mix of ${holds} m`);
  f.dispatch.stow = (actor, faction, wanted, pieces) => { fill(actor, faction, wanted, pieces); if (actor.id === paver) loads.push(pavedBy(f.hopper(paver))); };
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  // It does not wait for stocks it has: it goes with its hopper full, and back for the rest.
  assert.equal(f.job(paver).phase, 'go');
  assert(f.until(() => !room.roadworks.pending.size, 900), `the road is paved: ${JSON.stringify(f.unit(paver).job)}`);
  assert.equal(loads.length, 2, JSON.stringify(loads));
  assert(Math.abs(loads[0] - holds) < 1e-6 && Math.abs(loads[1] - holds) < 1e-6, JSON.stringify(loads));
  assert(Math.abs(f.made(a, b, 'asphalt') - 10) < 1e-6);
});

test('the road is made where the tools are: a paver lays its asphalt behind its screed, at the rear of its vehicle, and a blade grades under it', t => {
  const f = setup(t), { room, base, world } = f, paver = f.publish(f.player, 'paver'), grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 30;
  room.pave(a, b, 'graded'); f.run(1);
  // Where each tool meets the ground along its vehicle, the way it faces: under the trailing edge of the screed, at the hind
  // end of the paver, and under the middle of the cutting edge of the blade (road-tools.ts).
  const lead = (id, kind) => { const piece = f.parts(id, kind)[0], facing = world.actor(id).facing; return (piece.x + toolOffset(kind, piece) - f.x(id)) * facing; };
  assert(lead(paver, 'paver') < -3, `the screed ${lead(paver, 'paver')} m from the middle of the Pavimentadora`);
  for (const [id, kind, x0, x1] of [[paver, 'paver', a, b], [grader, 'blade', b + 20, b + 50]]) {
    f.road({ x0, x1, kind: kind === 'paver' ? 'asphalt' : 'graded' });
    let looked = 0;
    assert(f.until(() => {
      const job = f.job(id);
      if (job?.phase === 'work' && (job.front - job.start) * job.lane.dir > 1) {
        // What it did ends where its tool stands, as it goes: no more than a hand ahead of it, nor further behind than it lags.
        const tool = f.x(id) + job.lane.dir * lead(id, kind), behind = (tool - job.front) * job.lane.dir;
        looked++;
        assert(behind > -.5 - 1e-6 && behind < 3 + .1, `${kind}: its tool ${behind} m ahead of what it did`);
      }
      return !room.roadworks.pending.size;
    }, 300), `${kind}: the road is made`);
    assert(looked > 60 * 10, `${kind}: looked at ${looked} times`);
    // It stood at the end with its tool there, its middle as far past it as its tool stands from it.
    f.run(1);
    const end = Math.abs(f.x(id) + Math.sign(x1 - x0) * lead(id, kind) - x1);
    assert(end < 2.5, `${kind}: its tool ${end} m from the end of the road`);
  }
});

test('a machine facing away from the way its lane goes does none of it: hit as it turns about, it works only once it has, where every screen shows its tool', t => {
  const f = setup(t), { room, base, world } = f, a = base + 110, b = a + 30;
  room.pave(a, b, 'graded'); f.run(1);
  // Each stands a few metres past the far end of its road facing away from it: it backs there, and its lane runs the other
  // way from where it faces. A hit as it turns about to go on it undoes that: out of combat again, it is still answering
  // the hit (`alertUntil`), and goes on facing away till it no longer is and turns about (Squad.turnsAbout).
  for (const [design, kind, part, x0, x1] of [['paver', 'paver', 'pave', a, b], ['grader', 'blade', 'grade', b + 40, b + 70]]) {
    const id = f.publish(f.player, design, { facing: 1 });
    // Start ready to work: actual paid mixture avoids a collection trip changing the side this turn test approaches.
    if (part === 'pave') {
      const silica = f.faction.stock.silica;
      roadDepartureMix(f, id, mixRoom(room.pavers(id)[0]));
      assert(f.faction.stock.silica < silica && room.roadworks.aboard(world.actor(id)) >= x1 - x0, 'the turn begins with paid mixture for its full lane');
    }
    f.put(id, x1 + 10);
    f.road({ x0, x1, kind: part === 'pave' ? 'asphalt' : 'graded' });
    assert(f.until(() => room.record(world.actor(id)).service?.kind === 'turn', 120), `${kind}: it turns about to go on its lane`);
    const [engine] = f.parts(id, 'engine');
    f.set(engine, { health: engine.health * .9 });
    let against = 0, moved = 0, was = null;
    assert(f.until(() => {
      const job = f.job(id), actor = world.actor(id), lane = job?.phase === 'work' ? job.lane : null;
      if (lane && actor.facing !== lane.dir && !room.record(actor).service) against++;
      if (lane && was?.job === job && job.front !== was.front) {
        // Where the screen has the hindmost of its tools meet the ground along the lane, and where the field works.
        const tools = f.parts(id, kind).map(piece => piece.x + toolOffset(kind, piece)),
          screen = lane.dir > 0 ? Math.min(...tools) : Math.max(...tools), field = room.roadworks.at(actor, part, lane.dir);
        moved++;
        assert(actor.facing === lane.dir && Math.abs(field - screen) < 1e-6,
          `${kind}: its lane done on to ${job.front} facing ${actor.facing} along a lane going ${lane.dir}, worked at ${field} with its tool at ${screen}`);
      }
      was = job && { job, front: job.front };
      return !room.roadworks.pending.size;
    }, 300), `${kind}: the road is made`);
    assert(against > 60 * 20 && moved > 100, `${kind}: faced away from its lane at ${against} looks, worked at ${moved}`);
    assert.deepEqual(stretches(room.field.roads, x0, x1, part === 'pave' ? 'asphalt' : 'graded'), [[x0, x1]]);
  }
});

test('a machine that comes to its lane facing away from it at no pace turns about all the same, and works it once it has', t => {
  const f = setup(t), { room, base, world } = f, a = base + 110, b = a + 30, grader = f.publish(f.player, 'grader', { facing: 1 });
  f.put(grader, b + 10);
  f.road({ x0: a, x1: b, kind: 'graded' });
  // Its engines gave its blade nothing the last time it worked: it is sent along its lane at no pace, and its tools, facing
  // away from it, work none of it to be given any.
  assert(f.until(() => f.job(grader)?.phase === 'go', 5));
  f.job(grader).share = 0;
  assert(f.until(() => world.actor(grader).facing === -1, 60), `it turns about: ${JSON.stringify(f.job(grader))}`);
  assert(f.until(() => !room.roadworks.pending.size, 120), 'and grades the road');
  assert.deepEqual(stretches(room.field.roads, a, b, 'graded'), [[a, b]]);
});


// A containing re-open can leave just 20 cm beyond the graded span, sending the grader the other way while its paced
// destination is already inside ARRIVAL. Arrival must hold the leg only after the real timed turn has faced its tools.
for (const dir of [-1, 1]) for (const pace of [0, 1])
  test('a paced grader turns inside arrival and finishes a 20 cm remainder (' + dir + ', pace ' + pace + ')', t => {
    const f = setup(t), { room, world } = f, id = f.publish(f.player, 'grader', { facing: -dir }),
      from = f.base + dir * 150, to = from + dir * .2, start = from - dir * 20.2,
      x0 = Math.min(start, to), x1 = Math.max(start, to);
    room.pave(Math.min(start, from), Math.max(start, from), 'graded'); f.run(1);
    const actor = world.actor(id), goal = room.roadworks.stand(actor, 'grade', dir, to) + dir * ARRIVAL;
    // The observed field defect held at 1.330827 m, below the ordinary 1.5 m margin. Placement is cold fixture setup only.
    f.put(id, goal - dir * 1.330827);
    f.road({ x0, x1, kind: 'graded' });
    const job = f.job(id), squad = f.squad(), unit = squad.units.get(id), leg = unit.move;
    assert.equal(job.phase, 'work'); assert.equal(job.lane.dir, dir);
    assert(Math.abs(job.lane.to - job.lane.from - dir * .2) < 1e-8);
    assert(leg && Math.abs(leg.x - f.x(id)) < ARRIVAL, 'the real work leg is already inside arrival');
    leg.pace = pace;
    const action = squad.drive(id, unit);
    assert.deepEqual(action, { throttle: 0, brake: 1 });
    assert.equal(room.record(world.actor(id)).service?.kind, 'turn', 'a normal timed turn starts instead of waiting for tools facing away');
    assert.strictEqual(unit.move, leg, 'arrival and turning retain the dispatch work leg');
    assert(f.until(() => !room.roadworks.pending.size, 30), 'the remaining real ground is graded');
    assert.equal(world.actor(id).facing, dir);
    assert.deepEqual(stretches(room.field.roads, x0, x1, 'graded'), [[x0, x1]]);
  });

for (const state of ['ordinary Move', 'zero heading', 'turn refused', 'fuel starved', 'still rolling'])
  test('a near paced arrival keeps its braking and turn guards: ' + state, t => {
    const f = setup(t), { room, world } = f, id = f.publish(f.player, 'grader', { facing: -1 });
    f.run(1);
    const squad = f.squad(), unit = squad.units.get(id);
    if (state === 'fuel starved') {
      for (const tank of f.parts(id, 'fuel')) f.set(tank, { fuelLitres: 0 });
      world.step(1 / 60);
      assert.equal(world.actor(id).vehicle.fuelStarved, true, 'use the actual empty-tank reading');
    }
    squad.command({ order: 'move', ids: [id], x: f.x(id) + (state === 'zero heading' ? 0 : 1.330827) });
    const leg = unit.move;
    if (state !== 'ordinary Move') leg.pace = 1;
    if (state === 'turn refused') room.turn(room.players.get(f.player.playerId), world.actor(id), true);
    const service = room.record(world.actor(id)).service;
    if (state === 'still rolling') world.command('setVehicleState', { actorId: id, state: { vx: SETTLED + 1, vy: 0 } });
    const action = squad.drive(id, unit);
    assert(Number.isFinite(action.throttle) && Number.isFinite(action.brake), 'a refused turn still halts before any sqrt(distance-arrival)');
    assert.equal(action.throttle, 0); assert(action.brake > 0);
    assert.strictEqual(room.record(world.actor(id)).service, service, 'no premature, forbidden or repeated turn');
    if (state === 'ordinary Move') assert.equal(unit.move, null, 'ordinary Move still finishes inside its existing margin');
    else assert.strictEqual(unit.move, leg, 'paced arrival is held, not discarded');
    if (state === 'still rolling') {
      world.command('setVehicleState', { actorId: id, state: { vx: 0, vy: 0 } });
      assert.deepEqual(squad.drive(id, unit), { throttle: 0, brake: 1 });
      assert.equal(room.record(world.actor(id)).service?.kind, 'turn', 'it turns only after it has stopped');
    }
  });

test('a long lorry with its paver on its tail paves lane after lane, sent along each once, on wheels that do not spin', t => {
  const f = setup(t), { room, base, world, squad } = f, lorry = f.publish(f.player, longPaver()), a = base + 110, b = a + ROAD_LANE + 20;
  room.pave(a, b, 'graded'); f.run(1);
  const tail = f.parts(lorry, 'paver')[0], actor = world.actor(lorry);
  assert(actor.facing * (tail.x - f.x(lorry)) < -2, `its paver stands ${actor.facing * (tail.x - f.x(lorry))} m from its middle`);
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  // Watched at every step of its work: each time it comes to work a lane, the ways it is sent along it, and its wheels.
  let visits = 0, legs = 0, was = null, leg = null, spun = 0, working = 0;
  assert(f.until(() => {
    const job = f.job(lorry), move = squad().units.get(lorry)?.move ?? null, at = job?.phase === 'work' ? job : null;
    if (at && (at !== was?.job || at.lane.from !== was.from)) visits++;
    if (at && move && move !== leg) legs++;
    if (at) { working++; spun = Math.max(spun, Math.abs(actor.vehicle.slip || 0)); }
    was = at && { job: at, from: at.lane.from }; leg = move;
    return !room.roadworks.pending.size;
  }, 600), 'the road is paved');
  assert.deepEqual(stretches(room.field.roads, a, b, 'asphalt'), [[a, b]]);
  // Come to the end of a lane, it stood there on its brakes while its paver finished it: it was not sent there over and over.
  assert(visits >= 2 && legs <= visits, `sent ${legs} times along lanes it came to work ${visits} times`);
  assert(working > 60 * 60, 'it worked for more than a minute');
  assert(spun < .05, `its wheels slipped at ${spun} m/s as it paved`);
});

test('a paver with no Sílica in the stocks waits for some, and says so', t => {
  const f = setup(t), { room, base } = f, paver = f.publish(f.player, 'paver'), a = base + 110;
  room.pave(a, a + 30, 'graded'); f.faction.stock.silica = 0; f.run(1);
  f.road({ x0: a, x1: a + 30, kind: 'asphalt' });
  f.run(3);
  assert.deepEqual(f.unit(paver).job, { kind: null, phase: 'idle', targetId: 'r1', reason: 'waiting-stock' }, 'for that road');
  assert.equal(f.made(a, a + 30, 'asphalt'), 0);
  f.faction.stock.silica = PAVING.silica * 40;
  assert(f.until(() => !room.roadworks.pending.size, 300), 'with Sílica in the stocks it paves');
  assert.equal(pavedBy(f.hopper(paver)) < 40, true);
});

test('an order of the player\'s to a machine at work lays at once what it did, and giving the road up leaves what was made', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 200;
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work' && f.job(grader).front - a > ROAD_CHUNK + 4, 120));
  const front = f.job(grader).front;
  f.order(f.player, 'move', { ids: [grader], x: base });
  assert.equal(f.job(grader), undefined);
  assert.deepEqual([room.record(f.world.actor(grader)).auto, f.unit(grader).job.phase], [true, 'paused'], 'its automatic waits for the order');
  assert(Math.abs(f.made(a, b, 'graded') - (front - a)) < .02, 'all it did is graded, to the centimetre');
  // Once it stopped where it was sent, it takes the road up by itself where it was left.
  assert(f.until(() => f.job(grader)?.phase === 'work', 120));
  assert(Math.abs(f.job(grader).lane.from - (front)) < .02, 'from where it was left');
  f.run(8);
  const made = f.made(a, b, 'graded');
  assert.deepEqual(f.send(f.player, 'cancel-road', { roadId: 'r1' }), { cancelled: 'r1' });
  assert.deepEqual([f.roads(), f.job(grader)], [[], undefined]);
  assert(f.made(a, b, 'graded') >= made, 'what was made stays');
  assert.throws(() => f.send(f.player, 'cancel-road', { roadId: 'r1' }), { message: 'Essa estrada já não está no campo.' });
  f.run(3);
  assert.equal(f.unit(grader).job.phase, 'idle');
});

test('a machine whose way along its lane came no nearer lays what it did, says so once, and takes the road up again in a while', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 200;
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => f.job(grader)?.phase === 'work' && f.job(grader).front - a > 4, 120));
  // As its squad gives up a way that came no nearer for long enough (Squad.drive).
  const unit = f.squad().units.get(grader);
  unit.move = null; unit.halt = unit.reason = 'blocked-way';
  f.run(1.5);
  assert.equal(f.job(grader), undefined);
  assert.deepEqual([f.unit(grader).job.phase, f.unit(grader).job.reason], ['idle', 'blocked-way'], 'it says why it stopped');
  assert.equal(unit.halt, '', 'the squad says it no more: once is enough');
  const made = f.made(a, b, 'graded');
  assert(made > 4, 'what it did is laid');
  // The way is tried again after a while: before, the halt held it for good.
  assert(f.until(() => f.job(grader)?.phase === 'work', 60), 'it takes the road up again');
  assert(f.until(() => f.made(a, b, 'graded') > made + 2, 30), 'and goes on along it');
});

test('a grader takes no job of supplies, and a road machine in automatic stays where it is while its faction has roads to make', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), post = f.open(f.player, 'guard-post');
  f.run(1);
  assert.equal(room.record(f.world.actor(grader)).auto, true, 'it comes on the field in automatic');
  f.put(grader, base + 300);
  f.run(5);
  assert.equal(f.job(grader), undefined, 'a works that lacks its material is nothing for it');
  assert(room.works.pending.has(post));
  assert(Math.abs(f.x(grader) - (base + 300)) < 1, 'with nothing to do it stays where it is');
});

test('a constructor that grades too brings its works what it lacks itself, though its base is not on its way there', t => {
  // The constructor of the templates with a grader's blade: a road machine with a builder and supply pieces, alone on the field.
  const f = setup(t), { room, world, base } = f, design = createStructuredTemplate('construction-truck'),
    blade = createStructuredTemplate('grader').components.find(part => part.kind === 'blade'),
    machine = f.publish(f.player, { ...design, components: [...design.components, { ...blade, pose: { x: 94, y: -18, angle: 0, mirrored: true } }] }),
    x = f.site(f.player, 'guard-post', { from: 600 });
  // Out of its base, short of the works on the same side: its way there does not go by the base.
  f.put(machine, base + Math.sign(x - base) * 400);
  const post = f.open(f.player, 'guard-post', { x }), kinds = new Set();
  assert(f.until(() => { kinds.add(f.job(machine)?.kind ?? null); return world.actor(post); }, 300), 'the works stands');
  assert(kinds.has('work'), 'it went by the base for what the works lacked');
  assert(room.record(world.actor(machine)).auto);
});

test('the roads asked for are kept with the field, and machines take them up again where they were left', t => {
  const f = setup(t), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 80;
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'asphalt' });
  assert(f.until(() => f.made(a, b, 'graded') >= 2 * ROAD_CHUNK, 120));
  const kept = JSON.parse(JSON.stringify(room.keep()));
  assert.deepEqual(kept.roadworks, [{ id: 'r1', factionId: f.faction.id, x0: a, x1: b, kind: 'asphalt' }]);
  assert.equal(kept.serials.r, 1);
  assert.equal(kept.players[0].orders.find(([id]) => id === grader)[1].move, null, 'its way along its lane goes with its job, which is not kept');
  const again = rehearsal(bases, plenty, { fog: false, kept });
  t.after(() => again.world.dispose());
  assert.deepEqual([...again.roadworks.pending.values()], kept.roadworks);
  const graded = length(stretches(again.field.roads, a, b, 'graded'));
  assert(graded >= 2 * ROAD_CHUNK);
  const seat = again.join('Estradeira', room.players.get(f.player.playerId).token);
  assert.equal(seat.playerId, f.player.playerId);
  for (let i = 0; i < 60 * 30 && again.supplyDispatch.jobs.get(grader)?.phase !== 'work'; i++) again.step();
  assert.equal(again.supplyDispatch.jobs.get(grader)?.kind, 'grade', 'its machine takes it up again');
  assert(Math.abs(again.supplyDispatch.jobs.get(grader).lane.from - (a + graded)) < .02, 'where it was left');
});

test('a machine whose tool does not reach the ground under it makes none of its lane: it stands, says so, and goes on once it reaches it again', t => {
  for (const [design, kind] of [['grader', 'graded'], ['paver', 'asphalt']]) {
    const f = setup(t), { room, base } = f, id = f.publish(f.player, design), a = base + 110, b = a + 60, tool = design === 'grader' ? 'blade' : 'paver',
      road = () => f.world.actor(id).field?.road ?? null, [piece] = f.parts(id, tool), reach = piece.toolReach, short = () => room.roadworks.short([piece]);
    if (design === 'paver') f.room.pave(a, b, 'graded');
    f.run(1); if (design === 'paver') roadDepartureMix(f, id, 60);
    f.road({ x0: a, x1: b, kind });
    assert(f.until(() => road() && !road().idle, 90), `${design}: at work`);
    // The factory machine reaches the ground under it, with room to spare.
    assert(f.until(() => { assert(short() < -.05, `${design}: its ${tool} ${short()} m within its reach`); return (f.job(id).front - a) * f.job(id).lane.dir > 3; }, 30));
    // As if its tool reached a little less than it goes down there: it stops, and stands where it is.
    piece.toolReach = reach + short() - .02;
    f.run(.5);
    assert.deepEqual(road(), { tool, from: f.job(id).lane.from, to: f.job(id).lane.to, idle: true, short: true }, `${design}: told every screen`);
    assert.deepEqual(f.unit(id).tools, { limit: 'ground', tool }, `${design}: and its faction`);
    const front = f.job(id).front;
    f.run(2);
    const x = f.x(id);
    f.run(3);
    assert.equal(f.job(id).front, front, `${design}: none of its lane`); assert(Math.abs(f.x(id) - x) < .05, `${design}: it stands, ${f.x(id) - x} m on`);
    // Reaching the ground again by less than a bump, it stands still; by more, it goes on.
    piece.toolReach -= short() + .03;
    f.run(1);
    assert.equal(road()?.short, true, `${design}: no starting and stopping on bumps`);
    piece.toolReach = reach;
    assert(f.until(() => road() && !road().idle && !road().short, 5), `${design}: at work again`);
    assert(f.until(() => (f.job(id).front - front) * f.job(id).lane.dir > 1, 10), `${design}: on along its lane`);
    assert.deepEqual(f.unit(id).tools, { pace: 1 });
  }
});

test('every screen is told of a road machine at work, whole: its tool, the lane it makes, and when it does none of it', t => {
  const f = setup(t, { fog: true }), { room, base } = f, grader = f.publish(f.player, 'grader'), a = base + 110, b = a + 80, bia = room.join('Bia'),
    publication = new Publication(), road = () => f.world.actor(grader).field?.road ?? null,
    told = (who, id) => { const state = publication.state(room.world.snapshot()); state.shared = true; state.players = room.roster();
      return room.audience(state, chapters(state), [], room.players.get(who.playerId).factionId).state.actors.find(actor => actor.id === id); };
  f.run(1);
  f.road({ x0: a, x1: b, kind: 'graded' });
  f.run(1);
  assert.deepEqual([f.job(grader).phase, road()], ['go', null], 'on its way to the road, it makes none of it');
  assert(f.until(() => road() && !road().idle, 60), 'at work');
  assert.deepEqual(road(), { tool: 'blade', from: a, to: a + ROAD_LANE });
  // Bia's truck beside it is told the same as its own faction: one with no gun, as an armed enemy by its lane would send it off
  // that (supply-dispatch.ts `perils`).
  const truck = f.publish(bia, 'supply'); f.run(1); f.put(truck, f.x(grader) - 10);
  const now = road(), hers = told(bia, grader);
  assert(hers, 'her truck sees it');
  assert.deepEqual([hers.field.road, told(f.player, grader).field.road], [now, now]);
  // With no fuel it does none of its lane, and says so; filled again, it works on.
  const tanks = f.parts(grader, 'fuel'), full = tanks.map(tank => tank.fuelLitres);
  for (const tank of tanks) f.set(tank, { fuelLitres: 0 });
  assert(f.until(() => road()?.idle === true, 2), 'at rest on its lane');
  assert.deepEqual(told(bia, grader).field.road, road());
  tanks.forEach((tank, i) => f.set(tank, { fuelLitres: full[i] }));
  assert(f.until(() => road() && !road().idle, 2), 'at work again');
  // Taken off its road by an order, it is told nothing of one.
  f.order(f.player, 'move', { ids: [grader], x: base });
  f.run(.5);
  assert.equal(road(), null);
});
