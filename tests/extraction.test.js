import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { SupplyDispatch } from '../server/supply-dispatch.ts';
import { MODULES } from '../src/materials.ts';
import { TRANSFER_RATE, carriedBy, extractRate, extracts, hauls, toolPace } from '../src/economy.ts';
import { RECOVERY_SECONDS } from '../src/deposits.ts';

// The room's actual extraction/pickup rules with a stationary projection instead
// of a native physics world. Geometry, compatibility and cargo capacity are real. What the engines give the tools is the
// core's (`power`, tested with the core in game_commands.rs): here they give `engines`, at full pace by default, and
// each call is kept. Each construction is of the reference size, or `size` times it. The one site holds a reserve of
// 1000 and begins with `reserve` of it left: a vein dug below its reserve is the only one the room names (`veins`).
function field(fittings, { reserve = 1000, stock = 0, material = 'ferro', engines = () => ({ share: 1, limit: null }), size = 1 } = {}) {
  const room = Object.create(SharedRoom.prototype),
    site = { id: 'site', x: 100, feature: material === 'petroleo' ? 'lowland' : 'outcrop', material, reserve: 1000 },
    actors = fittings.map((kinds, i) => ({ id: `c${i}`, ownerId: `j${i}`, vehicle: { config: { enabled: true }, x: 100, vx: 0, vy: 0, grounded: true } })),
    world = { time: 0, actors, actor: id => actors.find(actor => actor.id === id), terrain: { height: () => 0 },
      plates: actors.map(actor => ({ actorId: actor.id, x: 100, y: .6 * size, angle: 0, definition: { length: 6 * size, thicknessMm: 10 } })),
      modules: fittings.flatMap((kinds, i) => [...kinds.map((kind, n) => ({ id: `part${i}:${n}`, actorId: actors[i].id, kind,
        x: 100 - size, y: 1.3 * size, angle: 0, width: MODULES[kind].width * size, height: MODULES[kind].height * size, health: 100,
        attached: true, ...['hopper', 'cistern'].includes(kind) ? { capacityM3: 1, cargo: {} } : {} })),
      { id: `wheel${i}`, actorId: actors[i].id, kind: 'wheel', x: 100, y: .5, width: 1, height: 1, health: 100, groundContact: { x: 100, y: 0 } }]) };
  Object.defineProperties(room, { world: { value: world }, deposits: { value: [site] } });
  Object.assign(room, { field: world, records: new Map(), arrivals: 0, sites: new Map([[site.id, site]]), veins: new Map(reserve < site.reserve ? [[site.id, reserve]] : []),
    extracted: new Map(stock ? [[site.id, stock]] : []), players: new Map(), factions: new Map(), random: () => 0 });
  room.supplyDispatch = new SupplyDispatch(room);
  for (const [i, actor] of actors.entries()) {
    room.players.set(actor.ownerId, { id: actor.ownerId, factionId: `f${i}` });
    room.factions.set(`f${i}`, { id: `f${i}`, base: { x: 1000 + i * 1000 }, posts: [], veins: null });
  }
  room.faction = owner => room.factions.get(owner.factionId);
  room.atBase = () => false;
  room.carry = changed => { for (const [piece, cargo] of changed) piece.cargo = cargo; };
  const asked = [];
  room.power = (actor, tools, seconds) => { asked.push({ actor: actor.id, tools: tools.map(tool => tool.id), seconds }); return engines(actor, tools, seconds); };
  return { room, world, site, actors, asked, cargo: id => carriedBy(room.pieces(id)).carried,
    stock: () => room.extracted.get(site.id) ?? 0, left: () => room.left(site) };
}

test('tools extract and containers transport: neither capability grants the other', () => {
  for (const material of ['ferro', 'ligas', 'silica']) {
    assert(extracts({ kind: 'excavator' }, material)); assert(!extracts({ kind: 'drill' }, material));
    assert(hauls({ kind: 'hopper' }, material)); assert(!hauls({ kind: 'excavator' }, material));
  }
  assert(extracts({ kind: 'drill' }, 'petroleo')); assert(!extracts({ kind: 'excavator' }, 'petroleo'));
  assert(!extracts({ kind: 'hopper' }, 'ferro')); assert(!extracts({ kind: 'cistern' }, 'petroleo'));
  assert(!extracts({ kind: 'excavator' }, 'unknown')); assert(!hauls({ kind: 'supply' }, 'ferro'));
});

test('every tool that reaches the vein digs, and two public transporters conserve reserve, pile and cargo', () => {
  // Transporters enter first; extraction must still precede every pickup.
  const f = field([['hopper'], ['hopper'], ['excavator', 'excavator'], ['excavator']]);
  f.room.haul(2);
  assert.equal(f.left(), 1000 - 3 * 50 * 2, 'three tools, two of them on one vehicle');
  assert.deepEqual(f.asked, [{ actor: 'c2', tools: ['part2:0', 'part2:1'], seconds: 2 }, { actor: 'c3', tools: ['part3:0'], seconds: 2 }],
    'the engines of each construction are asked once for all of its tools that reach the vein');
  assert.equal(f.stock(), 0);
  assert.deepEqual(f.actors.map(actor => f.cargo(actor.id).ferro), [150, 150, 0, 0]);
  assert.equal(f.left() + f.stock() + f.actors.reduce((sum, actor) => sum + f.cargo(actor.id).ferro, 0), 1000);
  for (const actor of f.actors.slice(0, 2)) assert.deepEqual(actor.field, { wreck: null, service: null, cargoWork: { kind: 'load', limited: true } }, 'real transfers limited by extraction carry no completion deadline');
  assert.deepEqual(f.actors[2].field.extraction, [{ partId: 'part2:0', siteId: 'site' }, { partId: 'part2:1', siteId: 'site' }], 'both tools animate');
});

test('a transporter consumes only the ready pile and never the geological reserve', () => {
  const f = field([['hopper'], ['cistern'], ['supply']]);
  f.room.haul(3);
  assert.equal(f.left(), 1000); assert.equal(f.stock(), 0); assert.equal(f.cargo('c0').ferro, 0);
  assert.deepEqual(f.actors[0].field.cargoWork, { kind: 'load', waiting: true });
  const ready = 3 * TRANSFER_RATE;
  f.room.extracted.set('site', ready); f.room.haul(2);
  assert.equal(f.left(), 1000); assert.equal(f.stock(), ready - 2 * TRANSFER_RATE); assert.equal(f.cargo('c0').ferro, 2 * TRANSFER_RATE);
  assert.equal(f.stock() + f.cargo('c0').ferro, ready, 'every ready unit is either still in the pile or aboard');
  assert.equal(f.cargo('c1').petroleo, 0);
  assert.equal(f.room.records.get('c0').loading, 'site');
  assert.equal(f.room.records.get('c0').extraction, null);
});

test('automatic ready pickup uses its real weight allowance and never starts its installed extractor', () => {
  const f = field([['excavator', 'hopper']], { stock: 1000 }), actor = f.actors[0];
  actor.blueprint = { chassis: { limitKg: 1300 } }; actor.vehicle.mass = 1000;
  f.room.record(actor).auto = true;
  f.room.supplyDispatch.jobs.set(actor.id, { kind: 'haul', targetId: f.site.id, phase: 'fetch' });
  f.room.haul(2);
  assert.deepEqual(f.asked, [], 'pickup does not ask the engine to excavate');
  assert.equal(f.left(), 1000); assert.equal(f.stock(), 700); assert.equal(f.cargo(actor.id).ferro, 300);
  assert.equal(f.room.records.get(actor.id).extraction, null);
  actor.vehicle.mass = 1300; f.world.time++;
  f.room.haul(2);
  assert.equal(f.stock(), 700); assert.equal(f.cargo(actor.id).ferro, 300, 'the actual chassis limit ends pickup before volume is full');
  assert.equal(f.left() + f.stock() + f.cargo(actor.id).ferro, 2000, 'reserve, finite pile and physical cargo conserve the material');
});

test('an automatic pickup learns a stale empty pile only through its actual ready loading mouth', () => {
  // Whether the reserve is empty or whole, the mouth tells the pile and nothing of a reserve the trip does not dig.
  for (const reserve of [0, 1000]) {
    const f = field([['hopper']], { reserve }), actor = f.actors[0], faction = f.room.factions.get('f0');
    actor.blueprint = { chassis: { limitKg: 1300 } }; actor.vehicle.mass = 1000;
    faction.veins = new Map([[f.site.id, { left: 0, stock: 500, still: false, at: -100 }]]);
    f.room.record(actor).auto = true;
    f.room.supplyDispatch.jobs.set(actor.id, { kind: 'haul', targetId: f.site.id, phase: 'fetch' });
    f.room.haul(1);
    assert.deepEqual(faction.veins.get(f.site.id), { left: 0, stock: 0, still: false, at: -100 },
      `a physically reached empty pile is known empty, and the site stays known (reserve ${reserve})`);
    assert.equal(f.cargo(actor.id).ferro, 0); assert.equal(f.stock(), 0); assert.deepEqual(f.asked, []); assert.equal(f.left(), reserve);
  }
});

test('an extractor works without a container and a full combined vehicle keeps its output in the pile', () => {
  const f = field([['excavator'], ['excavator', 'hopper']]), hopper = f.world.modules.find(piece => piece.kind === 'hopper');
  hopper.cargo = { ferro: 2400 };
  f.room.haul(2);
  assert.equal(f.stock(), 200); assert.equal(f.left(), 800); assert.equal(f.cargo('c1').ferro, 2400);
  assert.equal(f.room.records.get('c1').loading, null); assert.deepEqual(f.room.records.get('c1').extraction, [{ partId: 'part1:0', siteId: 'site' }]);
});

test('depleting the reserve leaves a public pile collectible until the last unit is taken, and the vein known as it comes back', () => {
  const f = field([['excavator'], ['hopper']], { reserve: 20 }), hopper = f.world.modules.find(piece => piece.kind === 'hopper');
  hopper.health = 0; f.room.haul(1);
  assert.equal(f.left(), 0); assert.equal(f.stock(), 20);
  assert.equal(f.room.veins.get(f.site.id), 0, 'an emptied vein is named empty, not taken off the field');
  const faction = f.room.factions.get('f1');
  assert.equal(f.room.known(faction, f.site).left, 0);
  assert.deepEqual(f.room.prospected(faction), [f.site]);
  hopper.health = 100; f.world.time++; f.room.haul(1);
  assert.equal(f.cargo('c1').ferro, 20); assert.equal(f.stock(), 0);
  assert.deepEqual(f.room.known(faction, f.site), { left: 0, stock: 0, at: 1, still: false }, 'a vein with neither reserve nor pile is not forgotten');
  assert.deepEqual(f.room.prospected(faction), [f.site]);
  assert.equal(f.actors[0].field, null, 'the tool stops when it extracts nothing');
  // A quarter of the time it takes to come back whole gives back a quarter of the reserve, and the rest of it the whole.
  f.room.replenish(RECOVERY_SECONDS / 4);
  assert.equal(f.left(), 250); assert.equal(f.room.known(faction, f.site).left, 250);
  f.room.replenish(RECOVERY_SECONDS);
  assert.equal(f.left(), 1000); assert.equal(f.room.veins.has(f.site.id), false, 'a vein whole again is named no longer');
});

test('movement, combat, service and a destroyed tool all clear extraction activity without consuming reserve', () => {
  for (const hold of ['moving', 'combat', 'service', 'destroyed']) {
    const f = field([['excavator']]); f.room.haul(1); const before = f.left();
    if (hold === 'moving') f.actors[0].vehicle.vx = 1;
    if (hold === 'combat') f.room.records.get('c0').combatAt = f.world.time;
    if (hold === 'service') f.room.records.get('c0').service = { kind: 'repair', until: 5 };
    if (hold === 'destroyed') { f.world.modules[0].health = 0; f.world.time++; }
    f.room.haul(1); assert.equal(f.left(), before, hold); assert.equal(f.room.records.get('c0').extraction, null, hold);
    assert.equal(f.actors[0].field?.extraction, undefined, hold);
  }
});

test('pickup debits the pile only after the cargo update succeeds', () => {
  const f = field([['hopper']], { stock: 123 });
  f.room.carry = () => { throw new Error('cargo update failed'); };
  assert.throws(() => f.room.haul(1), /cargo update failed/);
  assert.equal(f.stock(), 123); assert.equal(f.cargo('c0').ferro, 0); assert.equal(f.left(), 1000);
});

test('a failed second cargo update keeps the first successful share debited from the public pile', () => {
  const f = field([['hopper'], ['hopper']], { stock: 123 }), carry = f.room.carry;
  let transfers = 0;
  f.room.carry = changed => { if (++transfers === 2) throw new Error('second cargo update failed'); carry(changed); };
  assert.throws(() => f.room.haul(1), /second cargo update failed/);
  assert.equal(f.stock(), 61.5); assert.equal(f.cargo('c0').ferro, 61.5); assert.equal(f.cargo('c1').ferro, 0);
  assert.equal(f.stock() + f.cargo('c0').ferro + f.cargo('c1').ferro, 123);
  assert.equal(f.left(), 1000, 'the failed transfer never consumes geological reserve');
});

test('a drill pumps 10 L of petroleum a second and an excavator digs 50 kg of ore, each at the pace its engines give it', () => {
  const well = field([['drill']], { material: 'petroleo' });
  well.room.haul(3);
  assert.equal(well.stock(), 30); assert.equal(well.left(), 970);
  assert.deepEqual(well.room.records.get('c0').extraction, [{ partId: 'part0:0', siteId: 'site' }]);
  assert.deepEqual(well.room.records.get('c0').tools, { pace: 1 }, 'at the full pace nothing holds the tools back, and the field says so');
  // Engines that give the tools half of what they ask have them dig at half their pace, and the field says so.
  const weak = field([['excavator', 'excavator']], { engines: () => ({ share: .5, limit: 'power' }) });
  weak.room.haul(2);
  assert.equal(weak.left(), 1000 - 2 * 2 * 50 * .5);
  assert.deepEqual(weak.room.records.get('c0').tools, { limit: 'power', pace: .5 });
});

test('a tool does as much more as it holds more: the square of its size, as it is as deep across the body at any size', () => {
  const sized = (kind, scale) => ({ kind, width: MODULES[kind].width * scale });
  for (const [scale, pace] of [[.25, 1 / 16], [.5, 1 / 4], [1, 1], [2, 4]]) {
    assert(Math.abs(toolPace(sized('builder', scale)) - pace) < 1e-12, `a builder of ${scale}`);
    assert(Math.abs(extractRate(sized('excavator', scale)) - 50 * pace) < 1e-9, `an excavator of ${scale}`);
    assert(Math.abs(extractRate(sized('drill', scale)) - 10 * pace) < 1e-9, `a drill of ${scale}`);
  }
  // On the field, an excavator of half the size digs a quarter of what one of the reference size does: four of them dig
  // as much as one of the reference size, as they show as much of themselves.
  const small = field([['excavator']], { size: .5 });
  small.room.haul(2);
  assert.equal(small.left(), 1000 - 50 / 4 * 2);
});

test('a tool with no fuel or no engine to turn it extracts nothing, and the field says which it lacks', () => {
  for (const limit of ['fuel', 'engine']) {
    const f = field([['excavator', 'hopper']], { engines: () => ({ share: 0, limit }) });
    f.room.haul(2);
    assert.equal(f.left(), 1000, limit); assert.equal(f.stock(), 0, limit);
    assert.equal(f.room.records.get('c0').extraction, null, limit); assert.equal(f.actors[0].field?.extraction, undefined, limit);
    assert.deepEqual(f.room.records.get('c0').tools, { limit }, limit);
  }
  // A tool that reaches no reserve asks its engines for nothing, and nothing is said of them.
  const spent = field([['excavator']], { reserve: 0 });
  spent.room.haul(2);
  assert.deepEqual(spent.asked, []); assert.equal(spent.room.records.get('c0').tools, null);
});
