import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { BASE_RADIUS, LOAD_REACH, bill } from '../src/economy.ts';
import { BASE_TERRITORY } from '../src/territory.ts';
import { HAUL_SCARE } from '../src/squad.ts';
import { AIRDROP } from '../server/world-activities.ts';
import { spawnGuardian } from '../server/airdrop-guardian.ts';
import { DANGER, DANGER_MEMORY, SENTINEL_REACH } from '../server/supply-dispatch.ts';
import { jobText } from '../src/faction-ui.ts';
import { ROAD_LANE } from '../server/road-works.ts';
import { stretches, length } from '../src/roads.ts';
import { onField } from './helpers/field.js';

// The automatic sends no vehicle where its faction holds dangerous (server/supply-dispatch.ts `perils`): an airdrop while its
// sentinel lives, the ground of another faction, the place of an armed enemy it saw lately. Real vehicles of the catalogue
// on the real field, driven by their own pilots; only the piles out of the ground, the event and where an enemy stands are
// set by hand.

const STOCK = bill(1e9, 1e9, 1e9, 1e9);

// A field whose bases stand where `bases` says, by the order of foundation, with a vein `vein` metres along it from the
// first (`at`, of solid material and no site by either base), the pile of which a test readies (`ready`).
function field(t, { fog = false, vein = 1500, bases = at => [at - vein, at + 40000] } = {}) {
  let placed = null;
  const room = new SharedRoom({ starter: false, build: false, fog, stock: STOCK, base: i => placed[i] }), world = room.world,
    clear = x => x > room.limits.minX + 1000 && x < room.limits.maxX - 1000 && !room.deposits.some(site => Math.abs(site.x - x) < BASE_RADIUS + 2 * LOAD_REACH);
  const site = room.deposits.filter(site => site.material !== 'petroleo').sort((a, b) => Math.abs(a.x - world.terrain.center) - Math.abs(b.x - world.terrain.center))
    .find(site => bases(site.x).every(clear));
  assert(site, 'the ground has such a vein');
  placed = bases(site.x);
  const f = onField(t, room), ana = room.join('Ana'), bia = room.join('Bia'), seat = joined => room.players.get(joined.playerId),
    dispatch = room.supplyDispatch;
  return { ...f, room, world, vein: site, ana, bia, dispatch, faction: room.faction(seat(ana)),
    ready: (stock = 3000) => { room.veins.set(site.id, 1000); room.extracted.set(site.id, stock); },
    view: id => dispatch.view(id), job: id => dispatch.jobs.get(id),
    said: id => jobText({ auto: true, job: dispatch.view(id) }),
    // An armed vehicle of Bia's, standing where it is put.
    enemy: x => { const id = f.publish(bia, 'scout'); if (x !== undefined) f.put(id, x); return id; } };
}

test('a vein in the territory of another faction is left alone by the automatic, and taken once that faction is an ally', { timeout: 60000 }, t => {
  // Ana's base 6 km short of the vein, out of her own territory, and Bia's 3 km past it, within hers.
  const f = field(t, { bases: at => [at - BASE_TERRITORY - 1000, at + 3000] }), { room, vein: site, dispatch } = f;
  f.ready();
  assert(dispatch.perilous(f.faction, site.x), 'the vein lies in Bia\'s ground');
  const truck = f.publish(f.ana, 'truck');
  assert(f.until(() => f.view(truck).reason === DANGER, 5), 'the truck says why it has nothing to do');
  f.run(5);
  assert.equal(f.job(truck), undefined, 'and is given no trip there');
  assert.equal(f.said(truck), 'destino perigoso');
  const proposed = f.send(f.ana, 'accord', { act: 'propose', ref: f.bia.faction.ref, kind: 'alliance' }).proposed;
  f.send(f.bia, 'accord', { act: 'accept', id: proposed, kind: 'alliance' });
  assert(f.until(() => f.job(truck)?.targetId === site.id, 5), 'an ally\'s ground is no danger: the truck goes for the pile');
  assert.deepEqual([...room.faults], []);
});

test('a vein by an armed enemy the faction sees is left alone, and taken again once the enemy has been out of mind for the memory time', { timeout: 120000 }, t => {
  // A field with fog: Ana sees by her own vehicles, and keeps in mind what they saw.
  const f = field(t, { fog: true }), { room, world, vein: site, dispatch } = f;
  f.ready();
  // A scout of hers on the vein sees it, and an armed scout of Bia's by it, on a side its cameras look to.
  const watcher = f.publish(f.ana, 'scout'); f.put(watcher, site.x);
  const enemy = f.enemy(), seen = () => room.knows(f.faction.id, world.actor(enemy)) === 'seen',
    spot = [-300, -200, 200, 300].map(d => site.x + d).find(x => { f.put(enemy, x); return f.until(seen, 2); });
  assert(spot !== undefined && room.known(f.faction, site)?.stock > 0, 'Ana sees the pile and the armed scout by it');
  assert(Math.abs(spot - f.faction.base.x) > HAUL_SCARE, 'too far from the base to turn a truck there back by itself');
  const truck = f.publish(f.ana, 'truck');
  assert(f.until(() => f.view(truck).reason === DANGER, 5), 'the truck is not sent there, and says why');
  // The scout goes off, out of all sight; Ana's watcher comes home too.
  f.put(enemy, room.faction(room.players.get(f.bia.playerId)).base.x);
  f.put(watcher, f.faction.base.x + 60);
  const left = world.time;
  assert(f.until(() => room.knows(f.faction.id, world.actor(enemy)) === null, 40), 'the scout is out of Ana\'s sight, and its ghost gone');
  assert(dispatch.perilous(f.faction, site.x), 'Ana keeps in mind where it stood');
  assert(f.until(() => f.job(truck)?.targetId === site.id, DANGER_MEMORY + 10), 'the truck goes for the pile once that is out of mind');
  assert(world.time - left >= DANGER_MEMORY - 2, `not before the memory time (${(world.time - left).toFixed(1)} s)`);
  assert.deepEqual([...room.faults], []);
});

test('a truck on its way to a vein turns home once an armed enemy is seen by it, and says why', { timeout: 60000 }, t => {
  const f = field(t), { room, world, vein: site, dispatch } = f, truck = f.publish(f.ana, 'truck'), base = f.faction.base.x;
  f.ready();
  assert(f.until(() => f.job(truck)?.haul?.phase === 'out' && Math.abs(room.position(world.actor(truck)) - base) > 150, 60), 'the truck sets out for the pile');
  const enemy = f.enemy(site.x + 100);
  assert(Math.abs(room.position(world.actor(enemy)) - room.position(world.actor(truck))) > HAUL_SCARE, 'too far from the truck to turn it back by itself');
  assert(f.until(() => f.view(truck).phase === 'return', 2), 'it gives the trip up');
  assert.equal(f.view(truck).reason, DANGER);
  assert.equal(room.players.get(f.ana.playerId).squad.units.get(truck).haul, null, 'its haul is over');
  assert.equal(f.said(truck), 'voltando à base · destino perigoso');
  assert(f.until(() => room.atBase(f.faction, world.actor(truck)), 120), 'it comes home');
  f.run(5);
  assert.notEqual(f.job(truck)?.targetId, site.id, 'and is not sent there again while the enemy stands by it');
  assert(dispatch.perilous(f.faction, site.x));
  assert.deepEqual([...room.faults], []);
});

// An airdrop whose sentinel is born with it, `away` metres from the first base, on level ground.
function airdrop(t, away = 2500) {
  let x = 0;
  const f = onField(t, rehearsal(i => i ? x + 40000 : x - away, STOCK, { fog: false })), { room, world, ground } = f;
  x = Array.from({ length: 101 }, (_, i) => i * 20 - 1000).find(at => [-60, -40, 40, 60].every(dx => Math.abs(ground.height(at + dx) - ground.height(at)) < 4));
  assert(Number.isFinite(x), 'the fixture needs ordinary level ground');
  const ana = room.join('Ana'), faction = room.faction(room.players.get(ana.playerId)), drop = { id: 'airdrop:1', x, supplies: { ...AIRDROP.supplies },
    known: [faction.id], arrivesAt: world.time, expiresAt: world.time + AIRDROP.collect };
  room.activities = { nextId: 2, nextAt: world.time + AIRDROP.interval, drop };
  spawnGuardian(room);
  return { ...f, ana, faction, drop, sentinel: drop.guardianId, dispatch: room.supplyDispatch };
}

test('the automatic leaves an airdrop alone while its sentinel lives, and takes it once its faction sees it out of the fight', { timeout: 60000 }, t => {
  const f = airdrop(t), { room, world, drop, dispatch } = f, truck = f.publish(f.ana, 'supply');
  assert(world.actor(f.sentinel), 'the sentinel stands by the drop');
  f.run(1.5);
  assert(dispatch.guarded(f.faction), 'the event says there may be a sentinel, and Ana has not seen it out of the fight');
  assert(dispatch.perilous(f.faction, drop.x - SENTINEL_REACH + 1) && !dispatch.perilous(f.faction, drop.x - SENTINEL_REACH - HAUL_SCARE - 1));
  assert(f.until(() => dispatch.view(truck).reason === DANGER, 5), 'the supply truck says why it has nothing to do');
  f.run(5);
  assert.equal(dispatch.jobs.get(truck), undefined, 'and is given no trip there');
  // Its command post knocked out, the sentinel is out of the fight, and Ana sees it so.
  for (const piece of f.parts(f.sentinel, 'command')) f.set(piece, { health: 0 });
  assert(f.until(() => dispatch.jobs.get(truck)?.targetId === drop.id, 5), 'the truck goes for the drop');
  assert(!dispatch.guarded(f.faction) && !dispatch.perilous(f.faction, drop.x));
  assert.deepEqual([...room.faults], []);
});

test('an order of the player\'s to haul from a guarded airdrop goes as told, the automatic holding back meanwhile', { timeout: 60000 }, t => {
  const f = airdrop(t), { room, world, drop, dispatch } = f, truck = f.publish(f.ana, 'supply'), unit = room.players.get(f.ana.playerId).squad.units.get(truck),
    from = room.position(world.actor(truck));
  assert(f.until(() => dispatch.view(truck).reason === DANGER, 5));
  f.order(f.ana, 'haul', { ids: [truck], depositId: drop.id });
  f.run(10);
  assert.deepEqual([unit.haul?.depositId, unit.haul?.phase], [drop.id, 'out'], 'the haul he ordered goes on');
  assert.equal(dispatch.view(truck).phase, 'paused', 'the automatic waits for it to be done');
  assert.equal(dispatch.jobs.get(truck), undefined);
  assert(Math.abs(room.position(world.actor(truck)) - drop.x) < Math.abs(from - drop.x) - 50, 'the truck drives towards the drop');
  assert.deepEqual([...room.faults], []);
});

test('a builder is not sent to a works by an armed enemy, goes once it is gone, and gives the works up on its way once it is back', { timeout: 60000 }, t => {
  // The works 700 m out, and the enemy 600 m past it: by it, and too far from the builder in the base to turn it back by itself.
  const f = field(t), { room, world, dispatch } = f, design = 'guard-post', site = f.site(f.ana, design, { from: 700 }), work = f.open(f.ana, design, { x: site }),
    beyond = site + Math.sign(site - f.faction.base.x) * 600, enemy = f.enemy(beyond), builder = f.publish(f.ana, 'construction-truck');
  assert(Math.abs(beyond - f.faction.base.x) > HAUL_SCARE);
  assert(f.until(() => dispatch.view(builder).reason === DANGER, 5), 'the builder says why it is not sent');
  f.run(3);
  assert.equal(dispatch.errand(builder), null);
  f.put(enemy, room.faction(room.players.get(f.bia.playerId)).base.x);
  assert(f.until(() => dispatch.errand(builder)?.targetId === work, 5), 'with the enemy gone off, the builder is sent');
  assert(f.until(() => Math.abs(room.position(world.actor(builder)) - f.faction.base.x) > 30, 30), 'and sets out');
  f.put(enemy, beyond);
  assert(f.until(() => dispatch.view(builder).phase === 'return', 2), 'the enemy back by the works, the builder gives it up');
  assert.equal(dispatch.view(builder).reason, DANGER);
  assert.equal(dispatch.errand(builder), null);
  assert.deepEqual([...room.faults], []);
});

test('a road machine grades no lane where an armed enemy stands, and leaves the one it grades once one shows up by it', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-213, 30000], STOCK, { fog: false })), { room, world } = f, player = room.join('Estradeira'), bia = room.join('Bia'),
    faction = room.faction(room.players.get(player.playerId)), dispatch = room.supplyDispatch, base = faction.base.x,
    a = base + 110, b = a + 400, grader = f.publish(player, 'grader'), graded = (from, to) => length(stretches(room.field.roads, from, to, 'graded'));
  // An armed scout of Bia's whose guns hold all but the first 100 m of the road, too far from the base to turn the grader back.
  const enemy = f.publish(bia, 'scout'); f.put(enemy, a + 100 + HAUL_SCARE);
  f.send(player, 'road', { x0: a, x1: b, kind: 'graded' });
  assert(f.until(() => dispatch.jobs.get(grader)?.phase === 'work', 60), 'it grades the near end');
  assert(f.until(() => !dispatch.jobs.get(grader)?.kind && dispatch.view(grader).reason === DANGER, 240), 'and stops where the danger begins, saying why');
  assert(graded(a, a + 100) > 99 && graded(a + 100 + ROAD_LANE / 10, b) === 0, `it graded the safe stretch, and none past it (${graded(a, b).toFixed(1)} m)`);
  // The scout gone off, it goes on; back by its lane, the grader gives the lane up and goes home.
  f.put(enemy, room.faction(room.players.get(bia.playerId)).base.x);
  assert(f.until(() => dispatch.jobs.get(grader)?.phase === 'work', 60), 'it goes on with the road');
  f.put(enemy, room.position(world.actor(grader)) + 600);
  assert(f.until(() => dispatch.view(grader).phase === 'return', 2), 'it gives its lane up');
  assert.equal(dispatch.view(grader).reason, DANGER);
  assert.deepEqual([...room.faults], []);
});
