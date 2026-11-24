import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal, Side } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { within } from '../src/ground-sight.ts';
import { CAPTURE_SECONDS } from '../src/economy.ts';
import { onField } from './helpers/field.js';

// The shared field with its bases far from one another, and the players who come to it: of each its faction, and
// what it is told of the ground. `fielded` puts a construction of a player's at the base, `put` stands it elsewhere.
function field(t, bases = [-213, 9000, 30000], options) {
  const f = onField(t, rehearsal(bases, undefined, options)), room = f.room, world = room.world;
  return { ...f,
    join: name => { const player = room.players.get(room.join(name).playerId); return { id: player.id, get faction() { return player.factionId; } }; },
    fielded: (side, design = 'scout', how) => f.publish(side, design, how),
    at: id => world.actor(id).vehicle.x,
    explored: side => room.factionView(side.id).explored };
}
const length = spans => spans.reduce((sum, [from, to]) => sum + to - from, 0);
// Takes the base of a player's faction with a construction of another's, stood in it: the capture as good as done.
function take(f, side, raider) {
  const faction = f.room.factions.get(side.faction);
  f.put(raider, faction.base.x); assert(f.until(() => faction.capture, 2), 'the capture begins');
  Object.assign(faction.capture, { progress: CAPTURE_SECONDS - .5, at: f.world.time }); assert(f.until(() => faction.fell, 3), 'the base is taken');
}
// A car with no sensor on it and its vision block of steel: all it looks with is the camera of its command post, shut in
// the steel of its hull.
const sealed = () => { const car = createStructuredTemplate('chassis'); car.components = car.components.filter(part => part.kind !== 'sensor');
  car.plates.find(plate => plate.id === 'hull:vision').material = 'steel'; return car; };

test('a faction is founded knowing a kilometre of ground to each side of its base, and seeing none of it', t => {
  const f = field(t), alice = f.join('Alice'), bob = f.join('Bob');
  // On the cells explored ground is kept by, eight metres each: the kilometre about -213 is from -1213 to 787.
  assert.deepEqual([f.explored(alice), f.explored(bob)], [[[-1216, 784]], [[8000, 10000]]]);
  // The two seams of what comes next. With nothing of its own on the field a faction sees no ground.
  assert.deepEqual(f.room.seen(alice.faction), []); assert.equal(f.room.sees(alice.faction, -213), false);
  assert.deepEqual([-1300, -1216, -213, 784, 800, 9000].map(x => f.room.explored(alice.faction, x)), [false, true, true, true, false, false]);
  assert.deepEqual([f.room.explored(bob.faction, 9000), f.room.explored(bob.faction, -213)], [true, false]);
  assert.deepEqual([f.room.seen('nobody'), f.room.sees('nobody', 0), f.room.explored('nobody', 0)], [[], false, false]);
  // A construction comes to the base with only its command camera, looking through a glazed hull: all of
  // its 650 m reach fits in the ground already known. Nothing new is explored, so the very list is kept.
  const source = sealed();
  for (const plate of source.plates) { plate.material = 'glass'; plate.thicknessMm = Math.max(40, plate.thicknessMm); }
  const before = f.explored(alice), scout = f.fielded(alice, source), seen = f.room.seen(alice.faction);
  assert(f.room.sees(alice.faction, f.at(scout)) && !f.room.sees(bob.faction, f.at(scout)));
  assert(seen.length && seen.every(([from, to]) => within(before, from, to)), JSON.stringify(seen));
  f.run(3); assert.equal(f.explored(alice), before);
  const still = f.room.seen(alice.faction); f.run(.5); assert.equal(f.room.seen(alice.faction), still, 'and what stands still sees the very spans it saw');
  // A base at the end of the world knows no ground beyond it.
  const edge = field(t, [f.ground.maxX - 300]), carol = edge.join('Carol');
  assert.deepEqual(edge.explored(carol), [[f.ground.maxX - 1304 + (8 - (f.ground.maxX - 1304) % 8) % 8, f.ground.maxX]]);
});

test('an aircraft high up explores the ground within the circle of its optic, and what its side knows of the ground is that', t => {
  const f = field(t), alice = f.join('Alice'), scout = f.fielded(alice), actor = f.world.actor(scout), side = new Side(f.room, alice.id),
    x = 20000, ground = f.ground.height(x), look = up => { actor.eyes = [{ x, y: ground + up, left: 4000, right: 4000 }]; f.room.explore(); };
  assert(!side.knowsGround(x));
  // 5 km up with an optic of 4 km it sees no ground at all: nothing is explored there, and its pilot knows no more of it.
  look(5000);
  assert.deepEqual(f.room.seen(alice.faction).filter(([from, to]) => to > x - 4000 && from < x + 4000), []);
  assert(![x - 3000, x, x + 3000].some(at => side.knowsGround(at)));
  // 2 km up it sees, and explores, the stretch its circle holds: some 3.46 km to each side over level ground, here about it.
  look(2000);
  assert([x - 3300, x - 1000, x, x + 1000, x + 3300].every(at => f.room.sees(alice.faction, at) && side.knowsGround(at)));
  assert(![x - 3700, x + 3700].some(at => f.room.explored(alice.faction, at)), JSON.stringify(f.room.seen(alice.faction)));
});

test('the ground a construction sees as it goes is explored, and stays explored when the construction is gone', t => {
  const f = field(t), alice = f.join('Alice'), scout = f.fielded(alice), home = f.explored(alice);
  // Stood four kilometres away, where the faction knew nothing: what it sees there is added to what was known.
  f.put(scout, 4000);
  const there = f.explored(alice), seen = f.room.seen(alice.faction);
  assert.equal(there.length, 2); assert.deepEqual(there[0], home[0]);
  assert(there[1][0] <= 3960 && there[1][1] >= 4040, 'at the least the ground about it');
  assert(there.flat().every(x => x % 8 === 0), 'on the cells of the grid');
  // A cell is explored once its middle was seen: what is in sight is explored but for half a cell at its ends.
  const kept = (spans, explored) => spans.every(([from, to]) => to - from <= 8 || within(explored, from + 4, to - 4));
  assert(kept(seen, there), JSON.stringify([seen, there]));
  assert(f.room.sees(alice.faction, 4000) && f.room.explored(alice.faction, 4000) && !f.room.explored(alice.faction, 2500));
  // It drives on. What it has explored only grows, and holds what it sees wherever it is.
  f.send(alice, 'squad', { order: 'control', id: scout });
  let last = there;
  for (let leg = 0; leg < 4; leg++) {
    for (let i = 0; i < 120; i++) { f.send(alice, 'drive', { actorId: scout, throttle: 1 }); f.room.step(); }
    const now = f.explored(alice);
    assert(last.every(([from, to]) => within(now, from, to)), 'nothing explored is lost');
    assert(kept(f.room.seen(alice.faction), now) && f.room.sees(alice.faction, f.at(scout)));
    last = now;
  }
  assert(f.at(scout) > 4040 && length(last) > length(there), `${Math.round(f.at(scout))} m: ${JSON.stringify([there, last])}`);
  // It leaves the field. The faction sees no ground, and knows all it knew.
  f.room.discard(scout); f.run(.5);
  assert.deepEqual(f.room.seen(alice.faction), []); assert.equal(f.room.sees(alice.faction, 4000), false);
  assert.equal(f.explored(alice), last); assert.equal(f.room.explored(alice.faction, 4000), true);
  f.run(3); assert.equal(f.explored(alice), last);
});

test('a construction whose only optic is sealed in steel sees no ground and explores none, not even where it stands', t => {
  const f = field(t), ana = f.join('Ana'), car = f.fielded(ana, sealed(), { facing: 1 });
  f.run(.5); assert.deepEqual(f.world.actor(car).eyes, [], 'the car has no eye');
  // Nothing in sight where it stands, in its base or twelve kilometres from it: the faction knows the ground of its base and no more.
  const stands = () => { assert.deepEqual(f.room.seen(ana.faction), []); assert.equal(f.room.sees(ana.faction, f.at(car)), false); };
  stands(); f.put(car, 12000.5); stands();
  assert.deepEqual(f.explored(ana), [[-1216, 784]]);
  // The same car with its vision block, before its command post, a pane of glass sees ahead of it, and explores what it sees.
  const glazed = sealed(); glazed.plates.find(plate => plate.id === 'hull:vision').material = 'glass';
  const other = f.fielded(ana, glazed, { facing: 1 }); f.put(other, 20000.5);
  const [eye] = f.world.actor(other).eyes, there = f.explored(ana).filter(([from]) => from > 15000);
  assert.deepEqual([eye.left, eye.right], [0, 650]);
  assert(there[0][0] > 19990 && there[0][0] < 20010, 'nothing of the ground behind it: ' + there[0][0]);
  assert(there.at(-1)[1] > 20048 && there.at(-1)[1] <= 20656, JSON.stringify(there));
});

test('what a faction has explored is its members\': whoever joins it takes on its ground, and what they explore from then on is the faction\'s', t => {
  const f = field(t), alice = f.join('Alice'), bob = f.join('Bob'), old = bob.faction, mine = f.fielded(bob);
  f.put(mine, 12000);
  assert.deepEqual(f.explored(bob)[0], [8000, 10000]); assert(f.room.explored(old, 12000) && !f.room.explored(alice.faction, 12000));
  f.send(alice, 'invite', { playerId: bob.id }); f.send(bob, 'join-faction', { factionId: alice.faction });
  // His faction is gone with what it knew; he is told the ground of hers, the very list she is.
  assert.equal(bob.faction, alice.faction); assert.equal(f.explored(bob), f.explored(alice)); assert.deepEqual(f.explored(bob), [[-1216, 784]]);
  assert.deepEqual([f.room.explored(old, 12000), f.room.explored(old, 9000), f.room.seen(old)], [false, false, []]);
  // A construction of his explores for both.
  const scout = f.fielded(bob); f.put(scout, 4000);
  assert.equal(f.explored(alice), f.explored(bob)); assert.deepEqual(f.explored(alice)[0], [-1216, 784]);
  assert(f.room.explored(alice.faction, 4000) && f.room.sees(alice.faction, 4000));
  // And one of hers with it: the faction sees what either sees.
  const hers = f.fielded(alice); f.run(.5);
  assert(f.room.sees(alice.faction, f.at(hers)) && f.room.sees(alice.faction, f.at(scout)) && f.room.seen(alice.faction).length >= 2);
});

test('a faction that establishes another base keeps the ground it explored and knows the kilometre about the new one', t => {
  const f = field(t), alice = f.join('Alice'), bob = f.join('Bob'), scout = f.fielded(alice);
  f.put(scout, 4000);
  const before = f.explored(alice);
  take(f, alice, f.fielded(bob));
  assert.deepEqual(f.explored(alice), before, 'what it explored is kept with no base');
  assert.equal(f.send(alice, 'recover').base.x, 30000);
  assert.deepEqual(f.explored(alice), [...before, [29000, 31000]]); assert.deepEqual(before[0], [-1216, 784]);
  assert(f.room.explored(alice.faction, -213) && f.room.explored(alice.faction, 4000) && f.room.explored(alice.faction, 30900));
  // A new base within the ground it knew adds what of its kilometre was not known.
  const near = field(t, [-213, 9000, 1500]), carol = near.join('Carol'), dave = near.join('Dave');
  take(near, carol, near.fielded(dave)); near.send(carol, 'recover');
  assert.deepEqual(near.explored(carol), [[-1216, 2504]]);
});

test('on a field without fog no ground is kept: a faction is told of none, and all of it is in sight of everybody', t => {
  const f = field(t, [-9000, 9000, 20000], { fog: false }), alice = f.join('Alice'), faction = f.room.factions.get(alice.faction), scout = f.fielded(alice);
  f.run(1); f.put(scout, -5000);
  assert.equal(f.explored(alice), null); assert.deepEqual([faction.explored, faction.eyes, faction.seen], [null, null, []]);
  assert.deepEqual(f.room.seen(alice.faction), [[f.ground.minX, f.ground.maxX]]);
  assert.deepEqual([f.room.sees(alice.faction, 70000), f.room.explored(alice.faction, 70000)], [true, true]);
  // Another base established there keeps none either.
  take(f, alice, f.fielded(f.join('Bob'))); f.send(alice, 'recover');
  assert.equal(f.explored(alice), null);
});
