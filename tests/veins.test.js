import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { Terrain } from '../src/terrain.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { depositsOf, depositsNear, recovered, RECOVERY_SECONDS, RESERVE_STEP } from '../src/deposits.ts';
import { load, carriedBy, BASE_RADIUS, LOAD_REACH, CAPTURE_SECONDS } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { workArea } from '../src/loading-area.ts';

// The ground of the field and its sites, read as the server reads them, to choose where a test puts its bases and its vehicles.
const ground = new Terrain(MAIN_WORLD.terrain, { seed: MAIN_WORLD.seed, length: MAIN_WORLD.mapLength, center: 12 }), SITES = depositsOf(ground),
  CLEAR = BASE_RADIUS + LOAD_REACH, RING = 1000, far = (site, x) => Math.abs(site.x - x), iron = site => site.material === 'ferro',
  lone = site => depositsNear(SITES, site.x, 2 * LOAD_REACH).length === 1,
  // The lone sites of a thing between so far and so far from a place, the nearest first.
  about = (x, from, to, material = 'ferro') => SITES.filter(d => d.material === material && lone(d) && far(d, x) >= from && far(d, x) <= to).sort((a, b) => far(a, x) - far(b, x)),
  // The sites of iron a base at a place would have in the ground it knows about itself, the nearest first.
  ring = x => SITES.filter(d => iron(d) && far(d, x) > CLEAR && far(d, x) <= RING).sort((a, b) => far(a, x) - far(b, x)),
  // Every site a base at a place knows from its founding: those of the ground it knows about itself, of any thing.
  around = x => SITES.filter(d => far(d, x) <= RING),
  free = x => !depositsNear(SITES, x, CLEAR).length;
// A base 300 m from a lone site of iron near the middle of the world, with another site of iron in its kilometre, and
// the lone sites of iron and the seep some kilometres from it. A place with no iron within a kilometre, far from there.
const NEAR = about(ground.center, 0, 30000).find(site => free(site.x + 300) && ring(site.x + 300).length >= 2), HOME = Math.round(NEAR.x + 300),
  [OUT, FARTHER] = about(HOME, 3000, 12000), SEEP = about(HOME, 1200, 30000, 'petroleo')[0],
  BARE = Array.from({ length: 2000 }, (_, i) => Math.round(HOME + 20000 + i * 50)).find(x => free(x) && !SITES.some(d => iron(d) && far(d, x) <= RING + 50));

// The shared field with its bases where a test wants them, and the players who come to it.
function field(t, { bases = [HOME, HOME + 30000, HOME - 30000], random, fog } = {}) {
  const f = onField(t, rehearsal(bases, undefined, { fog, random })), room = f.room, world = room.world;
  return { ...f,
    join: name => { const player = room.players.get(room.join(name).playerId); return { id: player.id, get faction() { return player.factionId; }, get base() { return room.factions.get(player.factionId).base.x; } }; },
    fielded: (side, design = 'scout', how) => { const id = f.publish(side, design, how); f.order(side, 'control', { id: null }); f.order(side, 'stop', { ids: [id] }); return id; },
    at: id => world.actor(id).vehicle.x, cargo: id => carriedBy(room.pieces(id)).carried,
    // What a player is told of the veins, and the sites of those.
    told: side => room.factionView(side.id).deposits, known: side => room.factionView(side.id).deposits.map(d => d.id),
    vein: (side, site) => room.factionView(side.id).deposits.find(d => d.id === site.id) ?? null,
    // The veins of the field below their reserve, by site.
    veins: () => [...room.veins.keys()].sort(),
    // What a hauler of a player says of its order now.
    reason: (side, id) => room.squadView(side.id).units.find(unit => unit.id === id).reason };
}
const whole = (site, more = {}) => ({ id: site.id, left: site.reserve, stock: 0, at: 0, seen: false, loading: false, extracting: false, active: true, ...more });
// What a faction is told of a vein with so much left in it: in steps, nothing below one, and all of it when whole.
const step = (site, left) => left >= site.reserve ? site.reserve : Math.floor(left / RESERVE_STEP) * RESERVE_STEP;
// What a base at a place is told from its founding, as the faction of Ana is, alone on the field: every site in its kilometre,
// those it stills among them, and the iron/petroleum sources identified for initial operation.
const founded = (x, start = ring(x)[0]) => [...new Set([...around(x), start,
  SITES.filter(site => site.material === 'petroleo' && far(site, x) > CLEAR).sort((a, b) => far(a, x) - far(b, x))[0]])]
  .sort((a, b) => a.x - b.x).map(site => whole(site, { active: far(site, x) > CLEAR }));
// A car with no sensor on it and its vision block of steel: all it looks with is the camera of its command post, shut in
// the steel of its hull.
const sealed = () => { const car = createStructuredTemplate('chassis'); car.components = car.components.filter(part => part.kind !== 'sensor');
  car.plates.find(plate => plate.id === 'hull:vision').material = 'steel'; return car; };

test('every site of the ground holds a vein, whole when a field begins, and what is dug of one comes back by itself up to its reserve', t => {
  const seeded = new SharedRoom({ starter: false }); t.after(() => seeded.world.dispose());
  assert.equal(seeded.sites.size, SITES.length); assert.deepEqual(seeded.sites.get(NEAR.id), NEAR);
  assert.equal(seeded.veins.size, 0, 'no vein below its reserve');
  assert(SITES.every(site => seeded.left(seeded.sites.get(site.id)) === site.reserve), 'every one of them whole');
  const f = field(t), ana = f.join('Ana'), lorry = f.fielded(ana, 'mining-truck');
  // A real excavator consumes reserve; its hopper takes from the public pile. Reserve, pile and cargo hold every unit dug,
  // with what came back meanwhile: no more than the seconds it dug for give.
  const began = f.world.time; f.put(lorry, workArea(f.room.world, lorry, NEAR, LOAD_REACH).goal); f.run(4);
  const taken = f.cargo(lorry).ferro, left = f.room.left(NEAR), pile = f.room.extracted.get(NEAR.id) ?? 0, back = left + pile + taken - NEAR.reserve;
  assert(taken > 100 && back > 0 && back <= NEAR.reserve * (f.world.time - began) / RECOVERY_SECONDS + 1e-6, `${back} came back`);
  assert(f.world.actor(lorry).field.extraction, 'the installed excavator is actually working');
  assert.deepEqual(f.veins(), [NEAR.id], 'only the vein dug is below its reserve');
  // Left alone, it comes back at the pace of its reserve, a look at a time: half a minute gives a two-hundred-and-fortieth of it.
  f.put(lorry, HOME); f.room.veins.set(NEAR.id, NEAR.reserve / 2); const from = f.room.left(NEAR), at = f.room.hauledAt; f.run(30);
  assert(Math.abs(f.room.left(NEAR) - recovered(NEAR, from, f.room.hauledAt - at)) < 1e-6);
  assert(f.room.hauledAt - at > 29.8 && f.room.left(NEAR) - from > NEAR.reserve / 250); assert.equal(f.room.extracted.get(NEAR.id) ?? 0, pile, 'its pile is as it was');
  // Whole again, it is named no longer, and it gains nothing more however long it is left.
  f.room.veins.set(NEAR.id, NEAR.reserve - 5); f.run(1); assert.equal(f.room.left(NEAR), NEAR.reserve); assert.deepEqual(f.veins(), []);
  f.run(5); assert.equal(f.room.left(NEAR), NEAR.reserve);
  // From nothing, whole again in two hours, evenly.
  f.room.veins.set(NEAR.id, 0); f.room.replenish(RECOVERY_SECONDS / 4); assert.equal(f.room.left(NEAR), NEAR.reserve / 4);
  f.room.replenish(RECOVERY_SECONDS / 4); assert.equal(f.room.left(NEAR), NEAR.reserve / 2);
  f.room.replenish(RECOVERY_SECONDS); assert.equal(f.room.left(NEAR), NEAR.reserve); assert(!f.room.veins.has(NEAR.id));
});

test('an empty vein gives nothing until something comes back, and then no more than that: dug as fast as it comes back, it stays empty', t => {
  const f = field(t), ana = f.join('Ana'), lorry = f.fielded(ana, 'mining-truck'), faction = f.room.factions.get(ana.faction);
  f.run(.2); f.room.veins.set(NEAR.id, 0); f.put(lorry, workArea(f.room.world, lorry, NEAR, LOAD_REACH).goal);
  const began = f.room.hauledAt, before = f.cargo(lorry).ferro + (f.room.extracted.get(NEAR.id) ?? 0);
  f.run(20);
  const got = f.cargo(lorry).ferro + (f.room.extracted.get(NEAR.id) ?? 0) - before, came = NEAR.reserve * (f.room.hauledAt - began) / RECOVERY_SECONDS;
  // Twenty seconds of an excavator that digs 50 kg a second, and what it got is what came back: some 160 kg of a vein of 60 t.
  assert(Math.abs(got + f.room.left(NEAR) - came) < 1e-6 && got < 20 * 50 / 4, `${got} of ${came}`);
  assert.equal(f.room.left(NEAR), 0, 'what comes back at a look is dug at that look');
  assert.deepEqual([faction.veins.get(NEAR.id).left, f.vein(ana, NEAR).left], [0, 0], 'and the faction knows it empty');
  // Left alone for a minute it is still empty to a player who watches it — less than a step of it —; in two and a half, no longer.
  const scout = f.fielded(ana); f.put(scout, NEAR.x - 40); f.put(lorry, HOME); f.run(60); assert(f.room.left(NEAR) > 0 && f.room.left(NEAR) < RESERVE_STEP); assert.equal(f.vein(ana, NEAR).left, 0);
  f.run(90); assert(f.vein(ana, NEAR).left >= RESERVE_STEP && Math.abs(f.vein(ana, NEAR).left - f.room.left(NEAR)) < RESERVE_STEP);
});

test('no site wakes and none sleeps: a vein emptied changes no other, draws nothing, and tells nobody of any other', t => {
  const f = field(t, { bases: [HOME, HOME + 9000] }), ana = f.join('Ana'), beto = f.join('Beto'), lorry = f.fielded(ana, 'mining-truck'),
    knew = [f.known(ana), f.known(beto)], drawn = f.room.chance.state;
  f.run(.2); f.room.veins.set(NEAR.id, 120); const set = f.room.hauledAt; f.put(lorry, workArea(f.room.world, lorry, NEAR, LOAD_REACH).goal); f.run(4);
  const came = NEAR.reserve * (f.room.hauledAt - set) / RECOVERY_SECONDS;
  assert.equal(f.room.left(NEAR), 0);
  assert(Math.abs(f.cargo(lorry).ferro + (f.room.extracted.get(NEAR.id) ?? 0) - 120 - came) < 1e-6, 'all there was was dug, and the little that came back');
  assert.deepEqual(f.veins(), [NEAR.id], 'every other vein is as it was'); assert.equal(f.room.chance.state, drawn, 'the field drew nothing');
  assert(SITES.every(site => site.id === NEAR.id || f.room.left(f.room.sites.get(site.id)) === site.reserve));
  assert.deepEqual([f.known(ana), f.known(beto)], knew, 'nobody learnt of another vein');
  // Out of everybody's sight, it comes back all the same.
  f.put(lorry, HOME + 3000); const from = f.room.left(NEAR), at = f.room.hauledAt; f.run(10);
  assert(from > 0 && Math.abs(f.room.left(NEAR) - recovered(NEAR, from, f.room.hauledAt - at)) < 1e-6);
});

test('a base is founded with iron to start on: the nearest site of it no base stills, and knows every site in its kilometre', t => {
  const [first, second] = ring(HOME); assert(far(first, HOME) < far(second, HOME) && far(second, HOME) <= RING);
  // The nearest site of iron the base does not still is the one to start on. The faction knows it from the start, with
  // every site of its kilometre, of every thing.
  const one = field(t), ana = one.join('Ana');
  assert.deepEqual(one.told(ana), founded(HOME, first));
  assert.deepEqual(one.veins(), [], 'and no vein is made for it');
  // One its own base stills is no iron to start on: it is told of that one, as one it stills, and given another.
  const under = SITES.find(site => iron(site) && ring(site.x + 60).length), stilled = field(t, { bases: [Math.round(under.x + 60)] }), caio = stilled.join('Caio');
  assert.deepEqual(stilled.told(caio), founded(caio.base)); assert.equal(stilled.vein(caio, under).active, false);
  // A base with no site of iron in its kilometre: the nearest beyond it, however far, and the faction is told of it all the same.
  const bare = field(t, { bases: [BARE] }), duda = bare.join('Duda'), nearest = SITES.filter(iron).sort((a, b) => far(a, BARE) - far(b, BARE))[0];
  assert(far(nearest, BARE) > RING, `${Math.round(far(nearest, BARE))} m`); assert.deepEqual(bare.told(duda), founded(BARE, nearest));
  assert(bare.told(duda).every(vein => vein.at === 0 && !vein.seen && vein.left === bare.room.sites.get(vein.id).reserve));
});

test('a vein is found by sight alone: by what a camera sees, and one with no eye finds none, even stood on it', t => {
  const f = field(t), ana = f.join('Ana'), car = f.fielded(ana, sealed(), { facing: 1 }), hers = ana.faction, start = f.known(ana);
  assert(start.includes(NEAR.id) && !start.includes(OUT.id)); f.run(.5); assert.deepEqual(f.world.actor(car).eyes, [], 'the car has no eye');
  // A car whose camera is shut in steel, half a kilometre from a vein, beside it and on it: nothing. It sees no ground.
  for (const gap of [500, 30, 0]) { f.put(car, OUT.x - gap); assert(!f.room.sees(hers, OUT.x)); assert.deepEqual(f.known(ana), start, `${gap} m from it`); }
  // A scout drives past the other without stopping: its camera has found the vein before it is on it.
  const scout = f.fielded(ana), from = FARTHER.x - 700; f.put(scout, from); assert.equal(f.vein(ana, FARTHER), null);
  f.order(ana, 'move', { ids: [scout], x: FARTHER.x + 400 });
  let found = null, slowest = Infinity;
  // Keep a finite horizon for the hilly crossing, at no more than the speeds planned for its soil, gravel and rock
  // (terrain-speed.ts), and require uninterrupted movement through the vein below.
  for (let i = 0; i < 150 * 60 && f.at(scout) < FARTHER.x + 300; i++) {
    f.room.step(); const x = f.at(scout), v = f.world.actor(scout).vehicle;
    if (found === null && f.room.factions.get(hers).veins.has(FARTHER.id)) found = FARTHER.x - x;
    if (Math.abs(x - FARTHER.x) <= 40) slowest = Math.min(slowest, Math.hypot(v.vx, v.vy));
  }
  assert(f.at(scout) >= FARTHER.x + 300, 'it drove past'); assert(slowest > 2, `through the site at ${slowest.toFixed(1)} m/s at the least`);
  assert(found > 40, `found from ${Math.round(found)} m`); assert(f.known(ana).includes(FARTHER.id));
  // Every site it saw on the way is a vein it knows, whole as it is.
  const passed = SITES.filter(site => site.x > from + 100 && site.x < FARTHER.x + 250);
  assert(passed.every(site => f.known(ana).includes(site.id)) && passed.every(site => f.vein(ana, site).left === site.reserve));
  // Stood on the one the car found nothing of, it has that vein too, with what it holds.
  f.order(ana, 'stop', { ids: [scout] }); f.put(scout, OUT.x);
  assert.deepEqual(f.told(ana).find(d => d.id === OUT.id), whole(OUT, { at: null, seen: true })); assert(f.known(ana).includes(OUT.id));
});

test('what a faction knows of a vein is what it last saw of it: told as it was until it is seen again, emptied or come back, and never forgotten', t => {
  const f = field(t), ana = f.join('Ana'), scout = f.fielded(ana);
  f.put(scout, OUT.x + 20); assert.deepEqual(f.vein(ana, OUT), whole(OUT, { at: null, seen: true }));
  // Out of its sight it is told as it was then, with when that was, whatever is dug of it since.
  f.put(scout, HOME); const seen = f.vein(ana, OUT).at; assert(seen > 0 && seen < f.world.time);
  f.room.veins.set(OUT.id, 40500); f.room.extracted.set(OUT.id, 20500); f.run(5);
  assert.deepEqual(f.vein(ana, OUT), whole(OUT, { at: seen })); assert(f.room.left(OUT) > 40500, 'though it comes back meanwhile');
  // Seen again, it is told as it is: in steps, and the pile in its own.
  const pileStep = stock => Math.ceil(stock / 250) * 250;
  f.put(scout, OUT.x + 20); assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 40000, stock: 20500, at: null, seen: true }));
  f.room.veins.set(OUT.id, 12345.6); f.room.extracted.set(OUT.id, 30000.4); f.run(.3);
  assert.equal(f.vein(ana, OUT).left, 12000); assert.equal(f.vein(ana, OUT).stock, pileStep(30000.4));
  // A vein with less than a step left is told as empty.
  f.room.veins.set(OUT.id, 3); f.run(.3); assert.equal(f.vein(ana, OUT).left, 0, 'a vein with less than a step left is empty');
  // Emptied out of her sight: she goes on being told of it as she saw it last, and may send a lorry there.
  f.room.veins.set(OUT.id, 30500); f.run(.3); f.put(scout, HOME); const last = f.vein(ana, OUT).at;
  f.room.veins.set(OUT.id, 0); f.run(3);
  assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 30000, stock: pileStep(30000.4), at: last }));
  const lorry = f.fielded(ana, 'truck'); f.order(ana, 'haul', { ids: [lorry], depositId: OUT.id }); f.order(ana, 'stop', { ids: [lorry] });
  // Seen again, it is empty, with its pile still there; and with the pile taken too, it is still a vein she knows, empty.
  f.put(scout, OUT.x + 20); assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 0, stock: pileStep(30000.4), at: null, seen: true }));
  f.room.extracted.delete(OUT.id); f.run(.3);
  assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 0, at: null, seen: true })); assert(f.known(ana).includes(OUT.id));
  f.order(ana, 'haul', { ids: [lorry], depositId: OUT.id }); f.order(ana, 'stop', { ids: [lorry] });
  // Out of sight for an hour it is still empty to her; seen again, half of it came back.
  f.put(scout, HOME); f.room.replenish(3600); f.run(.3); assert.equal(f.vein(ana, OUT).left, 0);
  f.put(scout, OUT.x + 20); assert(Math.abs(f.vein(ana, OUT).left - OUT.reserve / 2) <= RESERVE_STEP, `${f.vein(ana, OUT).left} of ${OUT.reserve}`);
});

test('a hauler sent to a vein it finds empty goes home, unloads and stops there, saying the vein is empty and coming back', t => {
  const f = field(t), ana = f.join('Ana'), lorry = f.fielded(ana, 'truck'), miner = f.fielded(ana, 'mining-truck'), base = BASE_RADIUS,
    home = id => Math.abs(f.at(id) - HOME) <= base;
  // A lorry with a hopper and no digger, sent to a vein with nothing in it nor in its pile: it goes, sees, and comes back empty.
  f.room.veins.set(NEAR.id, 0); f.room.extracted.delete(NEAR.id);
  f.order(ana, 'haul', { ids: [lorry], depositId: NEAR.id });
  assert(f.until(() => f.room.players.get(ana.id).squad.units.get(lorry).haul?.empty === true, 120), 'it went to see, and found it empty');
  assert(Math.abs(f.at(lorry) - NEAR.x) < 2 * LOAD_REACH);
  assert(f.until(() => !f.room.players.get(ana.id).squad.units.get(lorry).haul, 240), 'its haul ended');
  assert(home(lorry)); assert.equal(f.reason(ana, lorry), 'vein-empty:ferro'); assert.deepEqual(f.cargo(lorry), load());
  // A mining lorry digs what is there, a little more than a step of it, and takes it home: there it unloads and stops, saying so.
  f.put(lorry, HOME + 80); f.room.veins.set(NEAR.id, 1400);
  f.order(ana, 'haul', { ids: [miner], depositId: NEAR.id });
  assert(f.until(() => f.cargo(miner).ferro > 0, 120), 'it dug');
  assert(f.until(() => f.room.players.get(ana.id).squad.units.get(miner).haul?.phase === 'home', 120), 'and turned home once the vein was empty');
  assert(f.room.left(NEAR) < RESERVE_STEP + 50 && f.cargo(miner).ferro > 400, 'with what it dug, less than a step left there');
  f.run(1); assert.equal(f.reason(ana, miner), 'vein-empty:ferro', 'saying so on the way');
  assert(f.until(() => !f.room.players.get(ana.id).squad.units.get(miner).haul, 240), 'its haul ended');
  assert(home(miner)); assert.equal(f.reason(ana, miner), 'vein-empty:ferro'); assert.deepEqual(f.cargo(miner), load(), 'it unloaded');
  // It is a vein all the same: sent again once it came back, it digs there.
  f.room.replenish(1800); f.order(ana, 'haul', { ids: [miner], depositId: NEAR.id });
  assert(f.until(() => f.cargo(miner).ferro > 0, 120), 'it digs it again');
});

test('a field kept and taken up again keeps what is left in every vein and what each faction knows of it, and they go on coming back', t => {
  const f = field(t), ana = f.join('Ana'), scout = f.fielded(ana);
  f.room.veins.set(NEAR.id, 12000); f.room.veins.set(OUT.id, 0); f.room.extracted.set(OUT.id, 700); f.put(scout, OUT.x + 20); f.put(scout, HOME);
  const knew = [...f.room.factions.get(ana.faction).veins], left = f.veins().map(id => [id, f.room.veins.get(id)]),
    kept = JSON.parse(JSON.stringify(f.room.keep()));
  assert.deepEqual(kept.veins.sort(), left, 'only the veins below their reserve are written out');
  const resumed = extra => onField(t, rehearsal([HOME, HOME + 30000, HOME - 30000], undefined, { kept: { ...kept, veins: [...kept.veins, ...extra] } })),
    back = resumed([]), room = back.room;
  assert.deepEqual([...room.veins].sort(), left); assert.equal(room.extracted.get(OUT.id), 700);
  assert.deepEqual([...room.factions.get(ana.faction).veins], knew, 'what the faction knew, as it knew it');
  // From where they were, each at the pace of its own reserve: ten seconds of the field, but for the first look.
  back.run(10);
  for (const [id, was] of left) {
    const site = room.sites.get(id), grown = room.left(site) - was;
    assert(grown > site.reserve * 9.8 / RECOVERY_SECONDS && grown <= site.reserve * 10 / RECOVERY_SECONDS + 1e-6, `${id}: ${grown}`);
  }
  // A vein written out whole is as one not named: it is whole, and named no longer once the field looks.
  const again = resumed([[FARTHER.id, FARTHER.reserve]]);
  assert.equal(again.room.left(FARTHER), FARTHER.reserve); again.run(.2);
  assert(!again.room.veins.has(FARTHER.id) && again.room.veins.has(NEAR.id));
});

test('what a faction knows of the veins is its members\': whoever joins it takes it on, and a faction that establishes another base keeps it', t => {
  // Three veins out of sight of one another: one for her scout to find, one for his, and one for later.
  const apart = (site, ...others) => others.every(other => far(site, other.x) > 3000), HIS = about(HOME + 9000, 1500, 6000).find(site => apart(site, OUT)),
    LATER = about(HOME, 3000, 20000).find(site => apart(site, OUT, HIS));
  const f = field(t, { bases: [HOME, HOME + 9000, HOME + 9000, HOME - 30000] }), ana = f.join('Ana'), beto = f.join('Beto'), old = beto.faction;
  const hers = f.fielded(ana), his = f.fielded(beto);
  f.put(hers, OUT.x + 20); f.put(his, HIS.x + 20);
  assert(f.known(ana).includes(OUT.id) && !f.known(ana).includes(HIS.id) && f.known(beto).includes(HIS.id) && !f.known(beto).includes(OUT.id));
  // He joins her faction: his own is gone with what it knew, and he is told the veins hers knows.
  const before = f.told(ana);
  f.send(ana, 'invite', { playerId: beto.id }); f.send(beto, 'join-faction', { factionId: ana.faction });
  assert.equal(beto.faction, ana.faction); assert.deepEqual(f.told(beto), f.told(ana)); assert(!f.known(beto).includes(HIS.id));
  assert.deepEqual(f.told(ana).filter(vein => before.some(was => was.id === vein.id)).map(vein => vein.id), before.map(vein => vein.id));
  assert.equal(f.room.factions.has(old), false);
  // What a construction of his finds from then on is found for both.
  const scout = f.fielded(beto); f.put(scout, LATER.x + 20);
  assert(f.known(ana).includes(LATER.id)); assert.deepEqual(f.told(ana), f.told(beto));
  assert.deepEqual(f.vein(ana, LATER), whole(LATER, { at: null, seen: true }));
  // Caio takes its base, and it establishes another thirty kilometres away. It keeps the veins it knew, as it last saw
  // them, and knows the iron and the petroleum its new base starts on, with every site in the kilometre of that base.
  for (const id of [hers, scout]) f.room.discard(id);
  const faction = f.room.factions.get(ana.faction), raider = f.fielded(f.join('Caio'));
  f.put(raider, HOME); Object.assign(faction.capture, { progress: CAPTURE_SECONDS - .5, at: f.world.time });
  assert(f.until(() => faction.fell, 3), 'the base is taken');
  const then = f.told(ana);
  assert.equal(f.send(ana, 'recover').base.x, HOME - 30000);
  const start = material => SITES.filter(d => d.material === material && far(d, HOME - 30000) > CLEAR).sort((a, b) => far(a, HOME - 30000) - far(b, HOME - 30000))[0],
    staked = new Set([start('ferro'), start('petroleo'), ...around(HOME - 30000)].map(site => site.id)), now = f.told(ana);
  assert.deepEqual(now.filter(vein => !staked.has(vein.id)), then.filter(vein => !staked.has(vein.id)));
  for (const id of staked) assert.equal(now.find(vein => vein.id === id).at, f.world.time, id);
  assert.deepEqual(f.told(beto), now);
});

test('on a field without fog every vein is known to everybody as it is', t => {
  const f = field(t, { fog: false }), ana = f.join('Ana'), beto = f.join('Beto'), lorry = f.fielded(ana, 'truck'),
    bases = [ana.base, beto.base], all = () => SITES.map(site => whole(site, { at: null, seen: true, active: bases.every(x => far(site, x) > CLEAR),
      left: step(site, f.room.left(site)), stock: Math.ceil((f.room.extracted.get(site.id) ?? 0) / 250) * 250 }));
  assert.equal(f.room.factions.get(ana.faction).veins, null, 'nothing is kept');
  for (const side of [ana, beto]) assert.deepEqual(f.told(side), all());
  // As it is now: dug, emptied with its pile there, and with its pile taken too, a vein all the same.
  f.room.veins.set(OUT.id, 30500); assert.equal(f.vein(beto, OUT).left, 30000);
  f.room.veins.set(OUT.id, 0); f.room.extracted.set(OUT.id, 300);
  assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 0, stock: 500, at: null, seen: true }));
  for (const side of [ana, beto]) assert.deepEqual(f.told(side), all());
  f.room.extracted.delete(OUT.id); assert.deepEqual(f.vein(ana, OUT), whole(OUT, { left: 0, at: null, seen: true }));
  f.order(ana, 'haul', { ids: [lorry], depositId: OUT.id }); f.order(ana, 'stop', { ids: [lorry] });
});

test('a player is told of the veins its faction knows and of nothing else: a site it never saw is in nothing it is sent', t => {
  const f = field(t), ana = f.join('Ana'), beto = f.join('Beto'), lorry = f.fielded(ana, 'mining-truck'), other = f.fielded(beto, 'mining-truck');
  assert.deepEqual(f.told(ana), founded(HOME)); assert.deepEqual(Object.keys(f.told(ana)[0]), ['id', 'left', 'stock', 'at', 'seen', 'loading', 'extracting', 'active']);
  // All it is sent of the field — its faction, its squad, the roster — names no other site.
  const sent = side => JSON.stringify([f.room.factionView(side.id), f.room.squadView(side.id), f.room.roster()]), knew = new Set(f.known(ana));
  for (const site of SITES) assert.equal(sent(ana).includes(`"${site.id}"`), knew.has(site.id), site.id);
  // Only a site it knows is somewhere to send a lorry: any other is refused in the same words, whatever it is.
  const unseen = about(HOME, 1200, 30000).find(site => !knew.has(site.id));
  const unseenPetroleum = about(HOME, 1200, 30000, 'petroleo').find(site => !knew.has(site.id));
  assert(unseenPetroleum, 'the initial petroleum source does not reveal every petroleum site');
  for (const depositId of [OUT.id, unseen.id, unseenPetroleum.id, 'ferro:nowhere', undefined])
    assert.throws(() => f.order(ana, 'haul', { ids: [lorry], depositId }), /^Error: Jazida desconhecida: escolha uma que a facção já encontrou\. Explore o campo para achar outras\.$/);
  // A lorry of hers loading there is told to her, and to nobody else; a lorry of another faction loading there is not hers.
  f.order(ana, 'haul', { ids: [lorry], depositId: NEAR.id });
  for (let i = 0; i < 60 * 60 && !f.room.records.get(lorry).loading; i++) f.room.step();
  f.run(.5); assert.deepEqual([f.vein(ana, NEAR).loading, f.vein(ana, NEAR).extracting, f.vein(ana, NEAR).seen, f.vein(ana, NEAR).at], [true, true, true, null]);
  assert.equal(f.vein(beto, NEAR), null); f.order(ana, 'stop', { ids: [lorry] }); f.put(lorry, HOME);
  f.put(other, workArea(f.room.world, other, NEAR, LOAD_REACH).goal); f.run(2); assert(f.cargo(other).ferro > 0);
  assert.deepEqual([f.vein(beto, NEAR).loading, f.vein(beto, NEAR).extracting, f.vein(ana, NEAR).loading, f.vein(ana, NEAR).extracting], [true, true, false, false]);
  assert.deepEqual(f.cargo(lorry), load(f.cargo(lorry).ferro));
});
