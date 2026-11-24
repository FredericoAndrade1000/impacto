import test from 'node:test';
import assert from 'node:assert/strict';
import { paved, normalRoads, roadAt, unlike, laidOver, NO_ROADS } from '../src/roads.ts';
import { Terrain } from '../src/terrain.ts';
import { rehearsal } from '../server/room.ts';
import { chapters } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { BASE_RADIUS } from '../src/economy.ts';
import { decodeFrame, FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { freewheel } from './mechanical-queries.js';

const road = (x0, x1, kind) => ({ x0, x1, kind });

test('a list of roads is kept in order, none over another, and those of one kind that touch are one road', () => {
  let roads = paved(paved(NO_ROADS, 10, 20, 'graded'), 30, 40, 'asphalt');
  // Laid over the end of one and the start of the other, a road takes what it covers and is one with its kind.
  roads = paved(roads, 15, 35, 'asphalt');
  assert.deepEqual(roads, [road(10, 15, 'graded'), road(15, 40, 'asphalt')]);
  assert(Object.isFrozen(roads) && roads.every(Object.isFrozen), 'nobody writes into a list of roads');
  // Laid inside another, it leaves the other on both sides of it.
  const split = paved(roads, 12, 13, 'asphalt');
  assert.deepEqual(split, [road(10, 12, 'graded'), road(12, 13, 'asphalt'), road(13, 15, 'graded'), road(15, 40, 'asphalt')]);
  assert.deepEqual(paved(split, 40, 50, 'asphalt').at(-1), road(15, 50, 'asphalt'), 'an end it shares with its kind joins them');
  assert.equal(paved(split, 12, 15, 'graded').length, 2, 'graded again, the stretch is one graded road');
  // Said in any order, a later one over an earlier where they meet; ends to the centimetre.
  assert.deepEqual(normalRoads([road(30, 40, 'asphalt'), road(0, 35.004, 'graded')]), [road(0, 35, 'graded'), road(35, 40, 'asphalt')]);
  assert.equal(normalRoads([]), NO_ROADS);
  for (const bad of [[road(1, 1, 'asphalt')], [road(0, 5, 'concrete')], [road(NaN, 5, 'graded')], [road(5, 0, 'graded')], [null], 'roads', undefined])
    assert.throws(() => normalRoads(bad), /inválid/);
  // Where a road is: from its start, up to its end.
  assert.deepEqual([9.99, 10, 12.5, 13, 49.99, 50].map(x => roadAt(paved(split, 40, 50, 'asphalt'), x)), [null, 'graded', 'asphalt', 'graded', 'asphalt', null]);
  assert.deepEqual([[0, 10], [5, 10.01], [40, 41], [12, 12.5]].map(([a, b]) => laidOver(split, a, b)), [false, true, false, true]);
  // Where two lists differ, ground for ground.
  assert.deepEqual(unlike(roads, split), [[12, 13]]);
  assert.deepEqual(unlike(NO_ROADS, roads), [[10, 40]]);
  assert.deepEqual(unlike(roads, normalRoads(JSON.parse(JSON.stringify(roads)))), []);
});

test('on a road the ground is the road, and its relief is the ground it was laid on', () => {
  const plain = new Terrain('hills'), laid = new Terrain('hills');
  laid.roads = paved(NO_ROADS, -40, 40, 'graded');
  assert.equal(plain.groundAt(20), 'soil'); assert.equal(laid.groundAt(20), 'graded'); assert.equal(laid.materialAt(20), 'soil', 'the ground under it is as it was');
  assert.equal(laid.groundAt(60), plain.groundAt(60), 'past its end the ground is its own');
  for (const x of [-30, 0, 22.5, 39]) {
    assert.equal(laid.height(x), plain.height(x));
    assert.deepEqual({ ...laid.surface(x), surface: 0 }, { ...plain.surface(x), surface: 0 });
    assert.equal(laid.surface(x).surface, 'graded');
    const hit = laid.raycast({ x, y: 30 }, { x, y: -30 });
    assert.equal(hit.surface, 'graded'); assert.equal(hit.y, plain.raycast({ x, y: 30 }, { x, y: -30 }).y);
  }
});

// How much of 25 m/s a vehicle loses in half a second rolling with nothing driving it, its brakes off: on asphalt little
// more than its tyres and the air take; on graded earth more, which rolls harder and has bumps of a centimetre for its
// springs to take, as the core has the ground there.
function coasting(world, id) {
  const vehicle = world.actor(id).vehicle;
  world.command('setVehicleState', { actorId: id, state: { x: vehicle.x, y: vehicle.y, vx: 25, vy: 0, omega: 0 } });
  for (let i = 0; i < 30; i++) world.step();
  return 25 - vehicle.vx;
}

test('every base is founded on an apron of asphalt, and a road the field lays reaches its core, its save and every faction', t => {
  const room = rehearsal(); t.after(() => room.world.dispose());
  const [ana, bia] = ['Ana', 'Bia'].map(name => room.players.get(room.join(name).playerId)), bases = [ana, bia].map(p => room.faction(p).base.x);
  const aprons = bases.reduce((roads, x) => paved(roads, x - BASE_RADIUS, x + BASE_RADIUS, 'asphalt'), NO_ROADS);
  assert.deepEqual(room.field.roads, aprons); assert.equal(room.field.terrain.roads, room.field.roads);
  for (const x of bases) assert.deepEqual([x - BASE_RADIUS + .5, x, x + BASE_RADIUS - .5].map(at => room.field.terrain.groundAt(at)), ['asphalt', 'asphalt', 'asphalt']);
  // What each faction is told of the field has the roads, its fog notwithstanding: they show as the relief does.
  const publication = new Publication(), told = player => {
    const state = publication.state(room.world.snapshot()); state.shared = true; state.players = room.roster();
    return room.audience(state, chapters(state), [], player.factionId).state;
  };
  for (const player of [ana, bia]) assert.deepEqual(told(player).roads, aprons);
  // A lorry of Ana's, rolling on her apron, loses little; graded over, it loses more.
  const lorry = room.publish(ana.id, createStructuredTemplate('truck')).actor.id;
  for (let i = 0; i < 120; i++) room.step();
  freewheel(room.world, lorry);
  const asphalt = coasting(room.world, lorry);
  const roads = room.pave(bases[0] - 150, bases[0] + 300, 'graded');
  assert.deepEqual(roads, room.field.roads);
  assert.deepEqual(roads.filter(r => r.kind === 'graded'), [road(bases[0] - 150, bases[0] + 300, 'graded')]);
  const graded = coasting(room.world, lorry);
  assert(asphalt < .25 && graded > 2 * asphalt, `asphalt ${asphalt.toFixed(3)} m/s, graded ${graded.toFixed(3)} m/s`);
  // Kept and taken back, the field has its roads, on the ground of its pages and of its core.
  const kept = JSON.parse(JSON.stringify(room.keep())), again = rehearsal(undefined, undefined, { kept }); t.after(() => again.world.dispose());
  assert.deepEqual(kept.scene.roads, roads); assert.deepEqual(again.field.roads, roads); assert.equal(again.field.terrain.roads, again.field.roads);
  freewheel(again.world, lorry);
  assert(Math.abs(coasting(again.world, lorry) - graded) < .3, 'the core of the field taken back has the graded road');
});

test('a frame tells the roads when they change and not again until they do', () => {
  const writer = new FrameWriter(), reader = new FrameReader(), first = paved(NO_ROADS, -100, 100, 'asphalt'), second = paved(first, 100, 400, 'graded');
  const frames = [[1, first, true], [2, first], [3, second], [4, second]].map(([time, roads, whole]) => writer.encode({ type: 'frame', state: { time, roads } }, whole));
  assert.deepEqual(frames.map(frame => 'roads' in decodeFrame(frame).state), [true, false, true, false]);
  const read = frames.map(frame => reader.decode(frame).state.roads);
  assert.deepEqual(read, [first, first, second, second]);
});
