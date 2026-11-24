import test from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { SharedRoom, rehearsal, ROOM_LIMITS } from '../server/room.ts';
import { FieldHost } from '../server/field-host.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { manufactureDesign } from '../server/field-construction.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionCost, pieceCost, ammunitionCost } from '../src/construction-cost.ts';
import { reserveState } from '../src/component-volume.ts';
import { HEARD_SECONDS } from '../src/squad.ts';
import { STARTING_STOCK, STOCK_IDS, BASE_RADIUS, CALM_SECONDS, WRECK_SECONDS, DAMAGED_SHARE, SALVAGE_REACH, LOAD_REACH, UNCOMMANDED, YIELD, bill, billSum, load, designBill, shortText, weight } from '../src/economy.ts';
import { depositsNear } from '../src/deposits.ts';
import { defaultFlag, validFlag } from '../src/flag.ts';
import { servoStatus } from '../src/weapon-presentation.ts';
import { onField } from './helpers/field.js';
import { FULL_INDUSTRY } from '../src/industry.ts';

const price = model => constructionCost(compileStructuredConstruction(createStructuredTemplate(model))).total;
// What a design is paid with: iron for all it is made of, and the fuel in its tank by the litre.
const cost = model => designBill(compileStructuredConstruction(createStructuredTemplate(model)));
// A field with its players, and what a test does on it.
function field(t, room, ...names) {
  const f = onField(t, room), world = room.world, players = names.map(name => room.join(name));
  return { room, world, players, ground: world.terrain, run: f.run, send: f.send, open: f.open, raise: f.raise,
    // What a player publishes here it then takes the controls of: publishing puts nobody at them.
    publish: (player, model, options) => { const id = f.publish(player, model, options); f.order(player, 'control', { id }); return id; },
    view: player => room.factionView(player.playerId), unit: (player, id) => room.factionView(player.playerId).units.find(u => u.id === id),
    x: id => world.actor(id).vehicle.x,
    part: (id, kind) => world.modules.find(m => m.actorId === id && m.kind === kind),
    piece: (id, kind) => world.actor(id).blueprint.modules.find(m => m.kind === kind),
    set: (module, state) => world.game().call({ op: 'setPartState', owner: world.game().handle(module), state }),
    stock: (player, ferro, ligas = 0, silica = 0, combustivel = 0) => { Object.assign(room.faction(room.players.get(player.playerId)).stock, bill(ferro, ligas, silica, combustivel)); } };
}

test('factions keep safe spacing and a newcomer can settle after a faction releases its land', t => {
  for (const seed of [7, 1234, 987654]) {
    // The draw, as this test has it: the same numbers every time.
    let state = seed;
    const room = new SharedRoom({ starter: false, build: false, random: () => (state = state * 16807 % 2147483647) / 2147483647 });
    t.after(() => room.world.dispose());
    for (let i = 0; i < 8; i++) room.join('Jogador ' + i);
    const bases = () => [...room.factions.values()].map(faction => faction.base.x).sort((a, b) => a - b),
      gaps = () => bases().slice(1).map((x, i) => x - bases()[i]);
    // Eight factions keep ten to thirty kilometres between neighbouring bases.
    assert(gaps().every(gap => gap >= 10000 && gap <= 30000), `seed ${seed}: ${gaps()}`);
    const span = bases().at(-1) - bases()[0];
    assert(span >= 7 * 10000 && span <= 7 * 30000, `they hold ${span} m of the world`);
    // One of those in the middle is left by its only member, for another faction: it is gone, and its ground lies open
    // between its neighbours.
    const gone = [...room.factions.values()].find(faction => faction.base.x === bases()[3]), [left, right] = [bases()[2], bases()[4]],
      host = [...room.factions.values()].find(faction => faction !== gone);
    room.command(host.leader, { type: 'invite', playerId: gone.leader }); room.command(gone.leader, { type: 'join-faction', factionId: host.id });
    assert.equal(room.factions.size, 7); assert(right - left >= 20000);
    // Resource access may favour an outer stretch over the vacated gap. Either remains a valid place,
    // a long march from every standing base and within reach of at least one of them.
    const others = bases(), next = room.join('Jogador novo').base.x;
    assert(others.every(x => Math.abs(x - next) >= 10000) && Math.min(...others.map(x => Math.abs(x - next))) <= 30000,
      `the newcomer is founded at ${next}, near ${others}`);
  }
});

test('a new production seat gets its faction, unchanged stocks and a ready miner, scout and constructor, and returning grants no duplicate', t => {
  const { room, world, ground, players } = field(t, new SharedRoom(), 'Alice', 'Bob', 'Carol', 'Dave'), bases = players.map(p => p.base);
  // The first base stands about the middle of the world; each one after it a long march from every other and
  // within reach of the nearest of those that stood when it was founded.
  assert(Math.abs(bases[0].x - ground.center) <= 5000, `the first base stands at ${bases[0].x}`);
  for (const [i, base] of bases.entries()) {
    assert(base.x >= ground.minX + 8000 && base.x <= ground.maxX - 8000, 'no base stands near the ends of the world');
    assert.deepEqual([base.y, base.facing, base.radius], [ground.height(base.x), base.x > ground.center ? -1 : 1, BASE_RADIUS]);
    for (const other of bases.slice(i + 1)) assert(Math.abs(other.x - base.x) >= 10000, 'at least the nominal ten kilometres from the others on this roomy field');
    if (i) assert(Math.min(...bases.slice(0, i).map(other => Math.abs(other.x - base.x))) <= 30000, 'and within reach of the nearest');
  }
  const [alice] = players, { faction } = alice;
  assert.deepEqual([faction.stock, faction.counts, faction.count, faction.name], [{ ferro: 90000, ligas: 10000, silica: 10000, combustivel: 1500 }, { vehicles: 3, fixed: 0 }, 3, 'Alice']);
  assert(!('limit' in faction)); assert(faction.units.every(unit => unit.vehicle));
  assert.deepEqual(faction.stock, { ...STARTING_STOCK }, 'iron to build with, fuel to move it, and a little of the materials that have to be fetched');
  assert.deepEqual(faction.yard, load(), 'nothing waits to be refined');
  assert.deepEqual(faction.members, [{ id: alice.playerId, name: 'Alice', connected: true, role: 'leader' }]);
  assert.deepEqual([faction.wrecks, faction.invites, faction.known, faction.strangers], [[], [], [], []]);
  assert.equal(faction.units.length, 3); assert.equal(alice.actors.length, 3); assert.equal(alice.selected, null);
  for (const player of players) {
    const [starter] = room.owned(player.playerId), kinds = starter.blueprint.modules.map(piece => piece.kind);
    assert(kinds.includes('excavator') && kinds.includes('hopper'), 'the grant extracts and carries with distinct installed pieces');
    assert.deepEqual(room.design(starter).blueprint, createStructuredTemplate('mining-truck'));
    assert.equal(room.record(starter).service, null, 'the granted truck is ready even when normal fabrication takes time');
    assert.equal(room.players.get(player.playerId).squad.manual, null, 'joining does not take manual controls');
    assert(Math.abs(starter.vehicle.x - player.base.x) <= BASE_RADIUS);
  }
  assert.equal(world.actors.length, players.length * 3);
  for (const base of bases) assert.deepEqual(depositsNear(room.deposits, base.x, BASE_RADIUS + LOAD_REACH), [], 'no base is drawn over a deposit');
  // Of the veins it is told those of the ground about its base, a kilometre to each side, and usable iron/petroleum to start on: whole
  // as they were when it was founded and none of them in sight. A whole vein is in no list of the field's (`veins` has those dug below their reserve).
  const home = room.factions.get(alice.faction.id).base, iron = room.endow(home, 'ferro'), petroleum = room.endow(home, 'petroleo');
  assert.deepEqual(faction.deposits.map(vein => vein.id), [...new Set([...depositsNear(room.deposits, bases[0].x, 1000), iron, petroleum])].sort((a, b) => a.x - b.x).map(site => site.id));
  for (const vein of faction.deposits) {
    const site = room.sites.get(vein.id);
    assert.deepEqual(vein, { id: site.id, left: site.reserve, stock: 0, at: 0, seen: false, loading: false, extracting: false, active: true });
    assert.deepEqual([room.left(site), room.veins.has(site.id)], [site.reserve, false]);
  }
  assert.equal(new Set(players.map(p => p.faction.id)).size, 4, 'each player founds one');
  // Of the others a faction is told who is on the field, by name. Who is of which faction is in no frame: that is told of those it has met.
  assert.deepEqual(room.factionView(alice.playerId).strangers, ['Bob', 'Carol', 'Dave'].map((name, i) => ({ id: players[i + 1].playerId, name, connected: true, invited: false })));
  assert.deepEqual(room.roster().map(p => Object.keys(p)), players.map(() => ['id', 'connected']));
  room.disconnect(alice.playerId);
  const back = room.join('Alice', alice.token);
  assert.deepEqual([back.faction.id, back.base], [faction.id, alice.base], 'a player who returns is of the same faction');
  assert.deepEqual(back.actors.map(actor => actor.id), alice.actors.map(actor => actor.id), 'returning retains the same granted vehicles');
  assert.equal(world.actors.length, players.length * 3); assert.deepEqual(back.faction.stock, { ...STARTING_STOCK });
});

test('a construction is bought from the faction\'s stocks and comes into the field at the base', t => {
  const { room, world, players: [alice], publish, send, view, unit } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice'),
    heavy = cost('heavy'), refused = `Falta Ferro para fabricar: custa ${heavy.ferro.toLocaleString('pt-BR')} e a facção tem 90.000.`;
  assert(heavy.ferro > STARTING_STOCK.ferro && heavy.ferro < price('heavy'), 'its compiled iron bill exceeds the starting stocks, with glass and fuel paid separately');
  assert.throws(() => publish(alice, 'heavy'), { message: refused });
  assert.equal(shortText(STARTING_STOCK, heavy, 'fabricar'), refused);
  // A 15 cm vertical sight band follows the heavy's 65 by 40 cm glacis: 90 mm of glass across the 2.4 m body.
  // At 2500 kg/m3 and 9 credits/kg, its real length costs ceil(0.15 * hypot(0.65, 0.40) / 0.40 * 0.09 * 2.4 * 2500 * 9) = 1391.
  const glassPlates = compileStructuredConstruction(createStructuredTemplate('heavy')).plates.filter(plate => plate.material === 'glass');
  assert.equal(glassPlates.length, 1);
  assert.deepEqual([glassPlates[0].thicknessMm, glassPlates[0].widthM], [90, 2.4]);
  assert(Math.abs(glassPlates[0].length - .15 * Math.hypot(.65, .40) / .40) < 1e-9, 'the price oracle is for the authored front face and sight band');
  assert(Math.abs(glassPlates[0].physicalMass - .15 * Math.hypot(.65, .40) / .40 * .09 * 2.4 * 2500) < 1e-8);
  assert.deepEqual([heavy.ligas, heavy.silica, heavy.combustivel], [0, 1391, 203], 'the glass of its vision block is paid in silica, and the fuel in its tank in fuel, by the litre');
  assert.equal(world.actors.length, 0); assert.deepEqual(view(alice).stock, { ...STARTING_STOCK });
  const scout = publish(alice, 'scout');
  assert.deepEqual(view(alice).stock, billSum(STARTING_STOCK, cost('scout'), -1)); assert.deepEqual(unit(alice, scout).built, { ...cost('scout') });
  assert.deepEqual(unit(alice, scout).value, { ...cost('scout') }, 'untouched, it is worth exactly what was paid for it');
  assert(cost('scout').ferro < price('scout') && cost('scout').combustivel > 200, 'its price is the iron and what that fuel is worth');
  assert.deepEqual([world.actor(scout).team, world.snapshot().actors[0].team, view(alice).count], [alice.faction.id, alice.faction.id, 1]);
  for (const x of [1, -201]) assert.throws(() => publish(alice, 'scout', { x }), /^Error: Fabrique dentro da base\.$/);
  assert.deepEqual(view(alice).stock, billSum(STARTING_STOCK, cost('scout'), -1), 'a publication refused costs nothing');
  // Replacing a construction pays the new design less what the old one gives back: the fuel of the one is the fuel of the other.
  // Its glass is paid as its iron is: the silica of the one less that of the other, which may be given back.
  const worth = unit(alice, scout).value, iron = view(alice).stock.ferro, glass = view(alice).stock.silica, fuel = view(alice).stock.combustivel;
  const dearer = send(alice, 'replace', { actorId: scout, blueprint: createStructuredTemplate('recon') });
  assert.deepEqual(dearer.cost, bill(cost('recon').ferro - worth.ferro, 0, cost('recon').silica - worth.silica));
  assert.deepEqual(view(alice).stock, bill(iron - dearer.cost.ferro, STARTING_STOCK.ligas, glass - dearer.cost.silica, fuel));
  const cheaper = send(alice, 'replace', { actorId: scout, blueprint: createStructuredTemplate('chassis') });
  assert(cheaper.cost.ferro < 0, 'a cheaper design gives the difference back'); assert.equal(view(alice).stock.ferro, iron - dearer.cost.ferro - cheaper.cost.ferro);
});

test('a faction has twelve vehicle places independently of its fixed constructions, including a disabled vehicle', t => {
  const { room, world, players: [alice], publish, raise, view, unit } = field(t, rehearsal([-100]), 'Alice');
  const vehicles = Array.from({ length: ROOM_LIMITS.perFaction.vehicles }, () => publish(alice, 'chassis'));
  assert.deepEqual([view(alice).count, view(alice).counts], [12, { vehicles: 12, fixed: 0 }]);
  assert(!('limit' in view(alice)));
  assert.throws(() => publish(alice, 'chassis'), /Limite: 12 veículos por facção/);
  // Runtime mobility does not reclassify the authored chassis or free a vehicle place.
  const vehicle = world.actor(vehicles[0]).vehicle, enabled = vehicle.config.enabled;
  try {
    vehicle.config.enabled = false;
    assert.deepEqual(room.constructionCounts(room.faction(room.players.get(alice.playerId))), { vehicles: 12, fixed: 0 });
    assert.equal(unit(alice, vehicles[0]).vehicle, true);
    assert.throws(() => publish(alice, 'chassis'), /Limite: 12 veículos por facção/);
  } finally { vehicle.config.enabled = enabled; }
  const defence = raise(alice, 'guard-post');
  assert.deepEqual(view(alice).counts, { vehicles: 12, fixed: 1 }); assert.equal(unit(alice, defence).vehicle, false);
});

test('thirty-two structures, standing or still works, fill the fixed places and leave room for a vehicle; neither kind becomes the other', t => {
  const { players: [alice], publish, send, open, raise, view, unit } = field(t, rehearsal([-100]), 'Alice'),
    design = createStructuredTemplate('guard-post'), fixed = [raise(alice, design)], works = [];
  for (let i = 1; i < ROOM_LIMITS.perFaction.fixed; i++) works.push(open(alice, design));
  assert.deepEqual([view(alice).count, view(alice).counts, view(alice).works.length], [1, { vehicles: 0, fixed: 32 }, 31]);
  assert.throws(() => open(alice, design), /Limite: 32 estruturas por facção/);
  const vehicle = publish(alice, 'chassis', { x: alice.base.x + 85 });
  assert.deepEqual(view(alice).counts, { vehicles: 1, fixed: 32 });
  const stock = view(alice).stock;
  assert.throws(() => send(alice, 'replace', { actorId: fixed[0], blueprint: design }), /Estruturas não são substituídas/);
  assert.throws(() => send(alice, 'replace', { actorId: vehicle, blueprint: design }), /Uma estrutura não substitui um veículo/);
  assert.throws(() => send(alice, 'replace', { actorId: fixed[0], blueprint: createStructuredTemplate('chassis') }), /Estruturas não são substituídas/);
  assert.deepEqual(view(alice).stock, stock); assert.equal(unit(alice, vehicle).vehicle, true);
  // A works given up frees its place.
  send(alice, 'cancel-work', { workId: works[0] });
  assert.deepEqual(view(alice).counts, { vehicles: 1, fixed: 31 });
  open(alice, design);
  assert.deepEqual([view(alice).count, view(alice).counts], [2, { vehicles: 1, fixed: 32 }]);
});

test('a saved fleet above twelve vehicles survives and can be replaced in category, but gains a vehicle only below the allowance', t => {
  const old = rehearsal([-100]), alice = old.join('Alice'), seat = old.players.get(alice.playerId);
  t.after(() => old.world.dispose());
  // Model a fleet admitted before the lower vehicle quota, then use the ordinary save and restore path.
  for (let i = 0; i < ROOM_LIMITS.perFaction.vehicles + 1; i++) old.furnish(seat, manufactureDesign(createStructuredTemplate('chassis')));
  const kept = JSON.parse(JSON.stringify(old.keep())), restored = rehearsal([-100], undefined, { kept }),
    { publish, send } = onField(t, restored), back = restored.join('Alice', alice.token), view = () => restored.factionView(back.playerId),
    ids = view().units.map(unit => unit.id);
  assert.deepEqual([view().count, view().counts, ids], [13, { vehicles: 13, fixed: 0 }, old.world.actors.map(actor => actor.id)]);
  assert.throws(() => publish(back, 'chassis'), /Limite: 12 veículos por facção/);
  assert.equal(send(back, 'replace', { actorId: ids[0], blueprint: createStructuredTemplate('chassis') }).actor.id, ids[0]);
  assert.deepEqual(view().counts, { vehicles: 13, fixed: 0 });
  send(back, 'remove', { actorId: ids[0] });
  assert.deepEqual(view().counts, { vehicles: 12, fixed: 0 });
  assert.throws(() => publish(back, 'chassis'), /Limite: 12 veículos por facção/);
  send(back, 'remove', { actorId: ids[1] });
  assert.deepEqual(view().counts, { vehicles: 11, fixed: 0 });
  publish(back, 'chassis');
  assert.deepEqual(view().counts, { vehicles: 12, fixed: 0 });
});

test('dismantling gives back what is physically left, at the base and out of combat only', t => {
  const { world, ground, players: [alice], publish, send, view, unit, run, part, piece, set } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice');
  const scout = publish(alice, 'scout'), engine = pieceCost(piece(scout, 'engine')); run(1);
  const whole = unit(alice, scout);
  assert.equal(whole.value.ferro, whole.built.ferro, 'whole, it gives back what it cost');
  assert(whole.built.combustivel - whole.value.combustivel <= 1, 'less the litre of fuel it may have begun to burn');
  assert.deepEqual([whole.repair, whole.repairSeconds, whole.atBase, whole.calm, whole.service], [bill(), 0, true, true, null]);
  set(part(scout, 'engine'), { health: part(scout, 'engine').maxHealth / 2 }); run(.2);
  const hurt = unit(alice, scout);
  assert(Math.abs(whole.value.ferro - hurt.value.ferro - engine * (1 - .5 * DAMAGED_SHARE)) <= 1, 'half an engine gives back a quarter of its price');
  assert.deepEqual(hurt.repair, bill(Math.ceil(engine / 2)), 'and repairing it costs the half destroyed');
  assert.equal(hurt.calm, false, 'the damage was a hit');
  assert.throws(() => send(alice, 'remove', { actorId: scout }), /Saia de combate para desmontar/);
  // Released manual controls permit an ordinary base repair. Cancel that actual service, with its full refund,
  // before testing dismantling; cancellation must neither mend the damage nor disable automatic service.
  const cancelAutomaticRepair = iron => {
    const waiting = unit(alice, scout), paid = { ...view(alice).stock };
    assert(waiting.atBase && waiting.calm);
    assert.deepEqual([waiting.service?.kind, waiting.service?.cost, waiting.service?.payer, waiting.service?.partial], ['repair', hurt.repair, null, false]);
    assert.equal(paid.ferro, iron - hurt.repair.ferro, 'automatic repair charged the destroyed half of the engine once');
    assert.deepEqual(send(alice, 'cancel-repair', { actorId: scout }), { refund: hurt.repair, lost: bill(), supplier: null, gone: false });
    assert.deepEqual(view(alice).stock, billSum(paid, hurt.repair), 'the whole invoice goes back to its payer');
    assert.deepEqual([unit(alice, scout).service, unit(alice, scout).repair, unit(alice, scout).declined], [null, hurt.repair, true]);
    assert.equal(part(scout, 'engine').health, part(scout, 'engine').maxHealth / 2, 'cancellation repairs nothing');
  };
  const ironBeforeAutomaticRepair = view(alice).stock.ferro;
  run(CALM_SECONDS); assert.equal(unit(alice, scout).calm, true);
  cancelAutomaticRepair(ironBeforeAutomaticRepair);
  // Away from the base it can only be left where it stands.
  const vehicle = world.actor(scout).vehicle, home = { x: vehicle.x, y: vehicle.y }, away = -100 + BASE_RADIUS + 20,
    put = at => { world.command('setVehicleState', { actorId: scout, state: { x: at.x, y: at.y, vx: 0, vy: 0 } }); run(.2); };
  put({ x: away, y: home.y - ground.height(home.x) + ground.height(away) + 1 });
  assert.equal(unit(alice, scout).atBase, false);
  assert.equal(unit(alice, scout).service, null, 'the away-base refusal is reached without an unrelated held service');
  for (const work of ['remove', 'repair']) assert.throws(() => send(alice, work, { actorId: scout }), /Leve a construção até a base/);
  const ironBeforeReturn = view(alice).stock.ferro;
  put({ x: home.x, y: home.y + 1 }); run(1);
  cancelAutomaticRepair(ironBeforeReturn);
  const had = view(alice).stock, value = unit(alice, scout).value, reply = send(alice, 'remove', { actorId: scout });
  assert.deepEqual(reply, { removed: scout, selected: null, refund: value, cargo: load() });
  assert.deepEqual(view(alice).stock, billSum(had, value)); assert.equal(world.actors.length, 0);
  assert(value.combustivel > 190 && value.combustivel < had.combustivel, 'the fuel left in its tank goes back to the fuel');
});

test('a repair asked for charges what was destroyed, holds the construction for a while and keeps its load', t => {
  const { world, players: [alice], publish, send, view, unit, run, part, piece, set, x } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice');
  const scout = publish(alice, 'scout'); run(1);
  assert.throws(() => send(alice, 'repair', { actorId: scout }), /não tem danos a reparar/);
  set(part(scout, 'engine'), { health: part(scout, 'engine').maxHealth / 2 });
  const damage = { ...unit(alice, scout).repair }, ironBeforeAutomaticRepair = view(alice).stock.ferro;
  run(CALM_SECONDS + 1);
  // The base repairs even a manually controlled vehicle whose controls are released. Cancel its actual invoice first;
  // the ordinary declined-at-this-place state leaves the same damaged vehicle available for the explicit request.
  const automatic = unit(alice, scout), paid = { ...view(alice).stock };
  assert(automatic.atBase && automatic.calm);
  assert.deepEqual([automatic.service?.kind, automatic.service?.cost, automatic.service?.payer, automatic.service?.partial], ['repair', damage, null, false]);
  assert.equal(paid.ferro, ironBeforeAutomaticRepair - damage.ferro, 'the automatic repair was paid once');
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: scout }), { refund: damage, lost: bill(), supplier: null, gone: false });
  assert.deepEqual(view(alice).stock, billSum(paid, damage), 'cancelling restores every stock in the actual invoice');
  assert.deepEqual([unit(alice, scout).repair, unit(alice, scout).declined], [damage, true]);
  assert.equal(part(scout, 'engine').health, part(scout, 'engine').maxHealth / 2, 'cancellation mends nothing');
  run(1);
  assert.equal(unit(alice, scout).service, null);
  set(part(scout, 'ammo'), { rounds: 3 });
  const quote = unit(alice, scout), iron = view(alice).stock.ferro, reply = send(alice, 'repair', { actorId: scout });
  assert(quote.repair.ferro > 0 && quote.repairSeconds >= 5 && quote.rearm.ferro > 0);
  assert.deepEqual([reply.cost, reply.seconds], [quote.repair, quote.repairSeconds]); assert.equal(view(alice).stock.ferro, iron - quote.repair.ferro);
  assert.deepEqual(world.snapshot().actors[0].field, { wreck: null, service: reply.service });
  assert.deepEqual(reply.service, { kind: 'repair', until: reply.service.until }, 'every screen is told that much of it');
  assert.deepEqual(unit(alice, scout).service, { ...reply.service, cost: quote.repair, payer: null, partial: false }, 'and its faction what it cost and that the stocks paid');
  assert(Math.abs(reply.service.until - world.time - reply.seconds) < 1e-9);
  // Held for the repair, it neither moves nor fires, and takes no other work.
  const held = x(scout);
  assert.deepEqual(send(alice, 'drive', { throttle: 0, brake: 0 }), {}, 'a neutral input leaves the repair in progress');
  assert.throws(() => send(alice, 'fire', { request: 1, aim: { x: 0, y: 160 }, weapon: { id: 'cannon' } }), /em reparo/);
  for (const work of ['repair', 'remove']) assert.throws(() => send(alice, work, { actorId: scout }), /em reparo/);
  run(reply.seconds - 1); assert(Math.abs(x(scout) - held) < .5); assert(unit(alice, scout).service);
  assert.equal(part(scout, 'ammo').rounds, 3, 'rounds are another bill');
  assert.equal(view(alice).stock.ferro, iron - quote.repair.ferro);
  run(2);
  const mended = unit(alice, scout);
  assert.deepEqual([mended.repair, mended.service], [bill(), null]); assert.equal(world.snapshot().actors[0].field, null);
  assert.equal(part(scout, 'engine').health, part(scout, 'engine').maxHealth);
  // Free again, it is filled up by itself where it stands, on that other bill.
  assert.equal(part(scout, 'ammo').rounds, reserveState(piece(scout, 'ammo')).rounds);
  assert.equal(view(alice).stock.ferro, iron - quote.repair.ferro - quote.rearm.ferro);
  send(alice, 'drive', { throttle: 1, brake: 0 }); run(3); assert(x(scout) - held > 1, 'and it answers the controls again');
});

test('a construction rebuilt keeps its place in the lists; a late input to one that was lost is dropped', t => {
  const { room, world, players: [alice, bob], publish, send, run, part, set } = field(t, rehearsal([-100, 400]), 'Alice', 'Bob');
  const first = publish(alice, 'scout', { x: -120 }), second = publish(alice, 'scout', { x: -80 }), other = publish(bob, 'scout'); run(1);
  const squad = () => room.squadView(alice.playerId).units.map(u => u.id), aim = { aim: { x: 0, y: 160 }, weapon: { id: 'cannon' } };
  assert.deepEqual(squad(), [first, second]);
  // Held: a construction that was hit would answer, and be in action still when its repair would begin.
  send(alice, 'squad', { order: 'stance', ids: [first, second], stance: 'hold' });
  // Out of the player's hands and out of combat, it is mended by itself in its base.
  set(part(first, 'engine'), { health: 1 }); run(CALM_SECONDS + 1);
  const repair = room.record(world.actor(first)).service;
  assert.equal(repair?.kind, 'repair'); run(repair.until - world.time + 1);
  assert.equal(part(first, 'engine').health, part(first, 'engine').maxHealth);
  assert.equal(world.actors.at(-1).id, first, 'the scene has the rebuilt construction last');
  assert.deepEqual(squad(), [first, second], 'the squad has it where it was');
  assert.deepEqual(room.factionView(alice.playerId).units.map(u => u.id), [first, second]);
  assert.deepEqual(room.owned(alice.playerId).map(a => a.id), [first, second]);
  // The construction in hand goes out of action while its inputs are still on their way.
  assert.equal(room.players.get(alice.playerId).squad.manual, second);
  for (const post of world.modules.filter(m => m.actorId === second && m.kind === 'command')) set(post, { health: 0 });
  run(.2); assert.equal(world.actor(second).ownerId, null);
  for (const late of [{ type: 'aim', ...aim }, { type: 'trigger', active: true, ...aim }, { type: 'drive', throttle: 1, brake: 0 }, { type: 'fire', ...aim }])
    assert.deepEqual(room.command(alice.playerId, { ...late, actorId: second }), {}, `a late ${late.type} is dropped`);
  assert.throws(() => send(alice, 'fire', { request: 1, actorId: second, ...aim }), /fora de combate/);
  assert.throws(() => send(alice, 'repair', { actorId: second }), /fora de combate/);
  assert.throws(() => send(alice, 'repair', { actorId: other }), /de outra facção/);
  room.discard(second);
  assert.deepEqual(send(alice, 'drive', { actorId: second, throttle: 1, brake: 0 }), {});
  assert.throws(() => send(alice, 'blueprint', { actorId: second }), /já não está no campo/);
});

test('service fills magazines and tanks by itself to the load of the design, each round at its price, or as far as the stocks pay', t => {
  const { players: [alice], publish, view, unit, run, part, piece, set, stock } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice');
  const scout = publish(alice, 'scout'), box = piece(scout, 'ammo'), rounds = reserveState(box).rounds, litres = reserveState(piece(scout, 'fuel')).fuelLitres; run(1);
  // Stocks that pay for not one round nor one litre: what it spends is not given back. No other stock pays for iron, nor iron for fuel.
  const each = ammunitionCost(box.ammoPreset), poor = bill(Math.ceil(each) - 1, 9e6, 9e6, 0);
  stock(alice, poor.ferro, poor.ligas, poor.silica, poor.combustivel);
  set(part(scout, 'ammo'), { rounds: 3 }); set(part(scout, 'fuel'), { fuelLitres: litres / 2 }); run(CALM_SECONDS + 1);
  const due = unit(alice, scout).rearm, iron = (rounds - 3) * each;
  assert.deepEqual(due, bill(Math.round(iron), 0, 0, litres / 2), 'rounds are paid in iron, each at its price, and fuel in fuel, by the litre');
  assert(due.ferro > 0 && due.combustivel > 90);
  assert.equal(part(scout, 'ammo').rounds, 3); assert(Math.abs(part(scout, 'fuel').fuelLitres - litres / 2) < .01);
  assert.deepEqual(view(alice).stock, poor);
  // Stocks that pay for some of it give that: whole rounds as far as the iron goes, and fuel as far as the fuel goes.
  const purse = 2 * Math.ceil(each) + 1, bought = Math.floor(purse / each);
  stock(alice, purse, 0, 0, 40); run(.5);
  assert.equal(part(scout, 'ammo').rounds, 3 + bought); assert(Math.abs(part(scout, 'fuel').fuelLitres - litres / 2 - 40) < .01);
  assert.deepEqual(view(alice).stock, bill(purse - Math.round(bought * each)));
  // Iron alone fills the magazines and leaves the tank as it is.
  const left = unit(alice, scout).rearm; assert.deepEqual(left, bill(Math.round((rounds - 3 - bought) * each), 0, 0, litres / 2 - 40));
  stock(alice, left.ferro, 0, 0, 0); run(.5);
  assert.equal(part(scout, 'ammo').rounds, rounds); assert(Math.abs(part(scout, 'fuel').fuelLitres - litres / 2 - 40) < .01);
  assert.deepEqual([view(alice).stock, unit(alice, scout).rearm], [bill(), bill(0, 0, 0, left.combustivel)]);
  stock(alice, 10, 0, 0, left.combustivel + 4); run(.5);
  assert.deepEqual(view(alice).stock, bill(10, 0, 0, 4));
  assert.equal(part(scout, 'ammo').rounds, rounds); assert(Math.abs(part(scout, 'fuel').fuelLitres - litres) < .01);
  run(1); assert.deepEqual(view(alice).stock, bill(10, 0, 0, 4), 'a bill is paid once');
});

test('a construction out of action is a wreck: nobody\'s, in nobody\'s way, for anybody to dismantle', t => {
  const { room, world, players: [alice, bob], publish, send, view, run, set, x } = field(t, rehearsal([0]), 'Alice', 'Bob');
  const spare = publish(alice, 'scout', { x: -60, facing: 1 }), mine = publish(alice, 'scout', { x: -30, facing: 1 }),
    theirs = publish(bob, 'scout', { x: 0, facing: -1 }); run(1);
  for (const post of world.modules.filter(m => m.actorId === theirs && m.kind === 'command')) set(post, { health: 0 });
  run(.2);
  const wreck = world.actor(theirs), shown = world.snapshot().actors.find(a => a.id === theirs);
  assert.deepEqual([wreck.defeated, wreck.ownerId, shown.defeated, shown.ownerId], [true, null, true, null]);
  assert(Math.abs(shown.field.wreck.until - world.time - WRECK_SECONDS) < .3, 'every screen is told when it goes');
  assert.equal(shown.burning, false, 'destroying only the command does not fabricate a fire');
  assert.deepEqual(room.squadView(bob.playerId).units, []); assert.equal(room.players.get(bob.playerId).selected, null);
  assert.equal(view(bob).count, 0, 'it no longer counts against the faction');
  assert(room.squadView(alice.playerId).out.includes(theirs));
  assert.throws(() => send(alice, 'squad', { order: 'attack', ids: [spare], targetId: theirs }), /Alvo inválido/, 'a wreck is nobody\'s target');
  // The construction of another faction drives through it, where a live one would have stopped it.
  send(alice, 'drive', { throttle: 1, brake: 0 });
  for (let second = 0; second < 30 && x(mine) < x(theirs) + 7; second++) run(1);
  send(alice, 'drive', { throttle: 0, brake: 1 }); run(2);
  assert(x(mine) > x(theirs) + 6, `it stopped ${(x(mine) - x(theirs)).toFixed(1)} m past the wreck`);
  // Whoever has a construction beside it, out of combat, takes what is left of it. One beside it still in combat is
  // told how long until it may.
  assert(Math.abs(x(mine) - x(theirs)) < SALVAGE_REACH); room.record(world.actor(mine)).combatAt = world.time;
  const waiting = view(alice).wrecks[0];
  assert.deepEqual([waiting.inReach, waiting.calmIn, view(bob).wrecks[0].calmIn], [false, CALM_SECONDS, null]);
  assert.throws(() => send(alice, 'salvage', { wreckId: theirs }), new RegExp(`ainda está em combate: desmonte em ${CALM_SECONDS} s`));
  run(CALM_SECONDS / 2); assert.equal(view(alice).wrecks[0].calmIn, CALM_SECONDS / 2);
  run(CALM_SECONDS / 2); assert.equal(view(alice).wrecks[0].calmIn, null);
  const [offer] = view(alice).wrecks, had = view(alice).stock;
  assert.deepEqual([offer.id, offer.inReach, view(bob).wrecks[0].inReach], [theirs, true, false]);
  assert(offer.value.ferro < price('scout') && offer.value.ferro > price('scout') * .8, 'all of it but the command post');
  assert(offer.value.combustivel > 190, 'and the fuel in its tank');
  assert.deepEqual(offer.cargo, load(), 'it carried nothing');
  assert.throws(() => send(bob, 'salvage', { wreckId: theirs }), /Leve uma construção sua/);
  assert.deepEqual(send(alice, 'salvage', { wreckId: theirs }), { salvaged: theirs, value: offer.value, cargo: load(), left: load() });
  assert.deepEqual(view(alice).stock, billSum(had, offer.value)); assert(!world.actor(theirs));
  assert.throws(() => send(alice, 'salvage', { wreckId: theirs }), /já não estão no campo/);
});

test('allies quoted together keep their own wreck reach and calm, and the next quote reads changed salvage', t => {
  const { room, world, players: [alice, bob], publish, send, run, set } = field(t, rehearsal([0]), 'Alice', 'Bob');
  send(alice, 'invite', { playerId: bob.playerId });
  send(bob, 'join-faction', { factionId: room.players.get(alice.playerId).factionId });
  const near = publish(alice, 'scout', { x: 0 }), far = publish(bob, 'scout', { x: 100 }),
    wreck = publish(bob, 'scout', { x: 10 });
  for (const post of world.modules.filter(m => m.actorId === wreck && m.kind === 'command')) set(post, { health: 0 });
  // The scouts settle on their wheels first: a wreck is taken by what stands still by it.
  run(1);
  send(alice, 'squad', { order: 'control', id: near }); send(bob, 'squad', { order: 'control', id: far });
  room.record(world.actor(near)).combatAt = world.time;
  const host = new FieldHost(room), ids = [alice.playerId, bob.playerId], quote = quoted => host.tell(ids, quoted).players,
    row = (players, id) => players.get(id).faction.wrecks.find(item => item.id === wreck);
  const together = quote(true);
  assert.deepEqual([row(together, alice.playerId).inReach, row(together, alice.playerId).calmIn,
    row(together, bob.playerId).inReach, row(together, bob.playerId).calmIn], [false, CALM_SECONDS, false, null]);
  for (const id of ids) assert.deepEqual(together.get(id).faction, room.factionView(id), 'a grouped quote says what an individual query says');
  room.record(world.actor(near)).combatAt = world.time - CALM_SECONDS;
  const reply = quote([alice.playerId]);
  assert.equal(reply.get(bob.playerId).faction, null, 'only the replied-to player is quoted');
  assert.equal(row(reply, alice.playerId).inReach, true);
  room.records.get(wreck).wreck.stripped = true;
  const changed = quote(true);
  for (const id of ids) assert.deepEqual(row(changed, id).value, bill(), 'another publication reads the stripped wreck');
  room.discard(wreck); room.sight();
  const removed = quote(true);
  for (const id of ids) assert.equal(removed.get(id).faction.wrecks.some(item => item.id === wreck), false,
    'a later publication forgets a wreck removed from known ground');
});

test('a construction needs a command post: a design with none is not published, and one that stands with none is a wreck', t => {
  const { room, world, players: [alice, bob], publish, send, view, run } = field(t, rehearsal([0]), 'Alice', 'Bob');
  const headless = model => { const design = createStructuredTemplate(model); design.components = design.components.filter(part => part.kind !== 'command'); return design; };
  room.players.get(alice.playerId).builtAt = -Infinity;
  const had = view(alice).stock;
  assert.throws(() => room.publish(alice.playerId, headless('scout')), { message: UNCOMMANDED });
  assert.deepEqual([view(alice).stock, view(alice).count, world.actors.length], [had, 0, 0], 'nothing was paid and nothing stands');
  // Nor does such a design take the place of a construction that stands.
  const mine = publish(alice, 'scout', { x: -30, facing: 1 }), theirs = publish(bob, 'scout', { x: 0, facing: -1 }); run(1);
  room.players.get(alice.playerId).builtAt = -Infinity;
  assert.throws(() => room.publish(alice.playerId, headless('heavy'), { actorId: mine }), { message: UNCOMMANDED });
  assert.equal(world.actor(mine).ownerId, alice.playerId);
  // One that stands on the field with none — kept so by a field of before the rule — is out of action at the
  // first look: every part of it shot away would never have made a wreck of it, and it stood in everybody's way.
  const kept = JSON.parse(JSON.stringify(room.keep())), stood = kept.scene.actors.find(actor => actor.id === theirs),
    posts = stood.construction.components.filter(part => part.kind === 'command').map(part => part.id);
  assert(posts.length > 0);
  stood.construction.components = stood.construction.components.filter(part => part.kind !== 'command');
  kept.scene.modules = kept.scene.modules.filter(module => !(module.id.startsWith(theirs + ':') && posts.includes(module.id.split(':').slice(2).join(':'))));
  const again = rehearsal([0], undefined, { kept }); t.after(() => again.world.dispose());
  assert(!again.world.modules.some(module => module.actorId === theirs && module.kind === 'command'));
  for (let step = 0; step < 12; step++) again.step();
  const wreck = again.world.actor(theirs);
  assert.deepEqual([wreck.defeated, wreck.ownerId, Boolean(again.records.get(theirs).wreck)], [true, null, true]);
  assert.deepEqual([again.world.actor(mine).defeated, again.world.actor(mine).ownerId], [false, alice.playerId], 'the one with its post stands as it stood');
  assert(again.squadView(alice.playerId).out.includes(theirs));
});

test('a construction left where it stands is a wreck worth less, and a wreck has its time on the field', t => {
  const { room, world, players: [alice], publish, send, view, unit, run } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice');
  const scout = publish(alice, 'scout'), spare = publish(alice, 'chassis'); run(1);
  const whole = unit(alice, scout).value.ferro, topology = room.topology;
  assert.deepEqual(send(alice, 'abandon', { actorId: scout }), { removed: scout, selected: spare });
  const [wreck] = view(alice).wrecks;
  assert.deepEqual([wreck.id, view(alice).count, view(alice).units.map(u => u.id)], [scout, 1, [spare]]);
  assert.equal(world.snapshot().actors.find(a => a.id === scout).burning, false, 'a healthy abandoned vehicle does not ignite');
  assert(wreck.value.ferro > whole * .45 && wreck.value.ferro < whole * .62, 'nothing of it counts as whole: ' + wreck.value.ferro + ' of ' + whole);
  run(WRECK_SECONDS - 2); assert(world.actor(scout), 'still there');
  run(3); assert(!world.actor(scout)); assert.equal(view(alice).wrecks.length, 0); assert(room.topology > topology);
});

test('on Revidar a vehicle answers for an ally hit within its reach, and not for a stranger', t => {
  const { room, world, players: [alice, bob, carol], publish, send, run, set, part } =
    field(t, new SharedRoom({ starter: false, build: false, stock: bill(1e6, 1e6, 1e6, 1e6), base: i => [-100, 400, 900][i] }), 'Alice', 'Bob', 'Carol');
  send(alice, 'invite', { playerId: bob.playerId }); send(bob, 'join-faction', { factionId: alice.faction.id });
  const mortar = publish(alice, 'mortar', { x: -120, facing: 1 }), ally = publish(bob, 'scout', { x: -60, facing: 1 }), stranger = publish(carol, 'scout', { x: 880, facing: -1 });
  for (const side of [alice, bob, carol]) send(side, 'squad', { order: 'control', id: null });
  run(1);
  const answering = () => room.players.get(alice.playerId).squad.units.get(mortar).answerUntil > world.time,
    hit = id => { const fuel = part(id, 'fuel'); set(fuel, { health: fuel.health - 1 }); run(.5); };
  hit(stranger); assert.equal(answering(), false, 'a construction of another faction is none of its business');
  hit(ally); assert.equal(answering(), true, 'one of its faction is');
});

test('joining a faction by invitation leaves stocks and constructions behind; allies share base, stocks and passage', t => {
  const { room, world, ground, players: [alice, bob], publish, send, view, run, part, x, stock } =
    field(t, new SharedRoom({ starter: false, build: false, stock: bill(1e6, 1e6, 1e6, 1e6), base: i => [-100, 400][i] }), 'Alice', 'Bob');
  const theirs = publish(bob, 'scout');
  assert.throws(() => send(bob, 'join-faction', { factionId: alice.faction.id }), /convite já não vale/);
  assert.throws(() => send(alice, 'invite', { playerId: alice.playerId }), /Jogador não encontrado/);
  send(alice, 'invite', { playerId: bob.playerId });
  assert.deepEqual(view(bob).invites, [{ factionId: alice.faction.id, ref: view(alice).ref, name: 'Alice', nation: null, flag: view(alice).flag, members: 1 }]);
  assert.deepEqual(view(alice).strangers, [{ id: bob.playerId, name: 'Bob', connected: true, invited: true }]);
  send(alice, 'invite', { playerId: bob.playerId, cancel: true }); assert.deepEqual(view(bob).invites, []);
  send(alice, 'invite', { playerId: bob.playerId }); send(bob, 'decline', { factionId: alice.faction.id }); assert.deepEqual(view(alice).strangers.map(p => p.invited), [false]);
  send(alice, 'invite', { playerId: bob.playerId }); stock(alice, 5000, 40, 7, 90);
  assert.deepEqual(send(bob, 'join-faction', { factionId: alice.faction.id }), { removed: [theirs], selected: null, base: alice.base });
  assert(!world.actor(theirs), 'the constructions of the newcomer leave the field'); assert.equal(room.factions.size, 1);
  assert.deepEqual([view(bob).id, view(bob).stock, view(bob).members.map(m => m.name), view(bob).invites, view(alice).strangers, view(alice).known],
    [alice.faction.id, bill(5000, 40, 7, 90), ['Alice', 'Bob'], [], [], []], 'and the stocks it had are gone with its faction');
  assert.throws(() => send(alice, 'invite', { playerId: bob.playerId }), /já é da sua facção/);
  // Both build at the one base, on the one account.
  stock(alice, 1e6, 0, 1e4, 1e3);
  const a1 = publish(alice, 'scout', { x: -100, facing: 1 }), b1 = publish(bob, 'scout', { x: -80, facing: -1 });
  assert.deepEqual(view(bob).stock, bill(1e6 - 2 * cost('scout').ferro, 0, 1e4 - 2 * cost('scout').silica, 1e3 - 2 * cost('scout').combustivel)); assert.deepEqual([view(alice).count, view(bob).count], [2, 2]);
  assert.equal(world.actor(b1).team, world.actor(a1).team);
  // An ally is no target, and what the other holds — what that one built, until letting it go — is not under one's orders.
  assert.throws(() => send(alice, 'squad', { order: 'attack', ids: [a1], targetId: b1 }), /Alvo inválido/);
  send(bob, 'squad', { order: 'control', id: null });
  assert.throws(() => send(alice, 'squad', { order: 'move', ids: [b1], x: 0 }), /Este veículo está com Bob até ser liberado\./);
  assert.equal(room.squadView(bob.playerId).units.find(unit => unit.id === b1).move, null);
  // Allies drive through each other, and fire from inside one another: the round passes through the ally.
  run(2); send(alice, 'drive', { throttle: 1, brake: 0 });
  for (let step = 0; step < 60 * 30 && Math.abs(x(a1) - x(b1)) > 1.5; step++) room.step();
  assert(Math.abs(x(a1) - x(b1)) <= 1.5, 'one is inside the other');
  const gun = part(a1, 'weapon'), at = gun.x + 300, aim = { x: at, y: ground.height(at) + 2 }, weapon = { id: 'cannon', componentId: gun.id };
  send(alice, 'aim', { aim, weapon }); run(.1);
  assert.equal(servoStatus(part(a1, 'weapon')).aligning, false, 'the gun has reached its aim');
  assert(Math.abs(x(a1) - x(b1)) <= 1.5, 'it still fires from inside its ally');
  const shots = world.stats.shots,
    wear = id => [...world.modules.filter(m => m.actorId === id).map(m => m.health), ...world.plates.filter(p => p.actorId === id).map(p => p.integrity)], worn = wear(b1);
  world.drainEvents();
  assert.equal(send(alice, 'fire', { request: 1, aim, weapon }).accepted, true);
  run(.1); assert.equal(world.stats.shots, shots + 1); assert(!world.drainEvents().some(e => e.type === 'weapon-blocked'));
  assert.deepEqual(wear(b1), worn, 'the ally is untouched');
  for (let step = 0; step < 60 * 30 && x(a1) - x(b1) < 12; step++) room.step();
  send(alice, 'drive', { throttle: 0, brake: 1 }); run(2);
  assert(x(a1) > x(b1) + 10, 'it came out on the other side');
});

test('a faction names its nation and makes its flag: any member, for all of them, and whoever it invites is told of both', t => {
  const { room, players: [alice, bob, carol], send, view } = field(t, new SharedRoom({ starter: false, build: false, base: i => [-100, 400, 900][i] }), 'Alice', 'Bob', 'Carol');
  // Until it makes its own a faction goes by its leader's name, under a flag that is made, drawn for it when it was
  // founded and kept: not the one its name on the field would make, which would tell that name to whoever sees the flag.
  const drawn = view(alice).flag;
  assert.deepEqual([view(alice).name, view(alice).nation, validFlag(drawn)], ['Alice', null, drawn]); assert.equal(drawn.country, undefined);
  assert.deepEqual(room.factionView(alice.playerId).flag, drawn);
  assert(!isDeepStrictEqual([alice, bob, carol].map(p => view(p).flag), [alice, bob, carol].map(p => defaultFlag(p.faction.id))));
  const flag = { field: 'cross', colours: [4, 0, 8], emblem: 'star' }, ringed = { ...flag, emblem: 'ring' };
  assert.deepEqual(send(alice, 'identity', { nation: '  República   de Farofa ', flag: { ...flag, picture: 'x' } }), {});
  assert.deepEqual([view(alice).name, view(alice).nation, view(alice).flag], ['Alice', 'República de Farofa', flag]);
  // What is not a name or a flag is refused, and the faction stays as it was.
  for (const [data, why] of [[{ nation: 'x', flag }, /de 2 a 24 caracteres/], [{ nation: 'Farofa', flag: { ...flag, field: 'skull' } }, /Bandeira inválida/],
    [{ nation: 'Farofa' }, /Bandeira inválida/], [{ nation: 7, flag }, /Nome de facção inválido/]]) assert.throws(() => send(alice, 'identity', data), why);
  assert.deepEqual([view(alice).nation, view(alice).flag], ['República de Farofa', flag]);
  // A name another faction goes by is taken, however it is written; its own a faction keeps while it changes its flag.
  assert.throws(() => send(bob, 'identity', { nation: 'república de FAROFA', flag }), /Já há uma facção com esse nome no campo/);
  assert.equal(view(bob).nation, null);
  send(alice, 'identity', { nation: 'República de Farofa', flag: ringed }); assert.deepEqual(view(alice).flag, ringed);
  // The flag of a country is flown as it is, by its two letters; one the game has no picture of is no flag.
  assert.throws(() => send(bob, 'identity', { nation: 'Brasil', flag: { country: 'xx' } }), /Bandeira inválida/);
  send(bob, 'identity', { nation: 'Brasil', flag: { country: 'br', emblem: 'star' } }); assert.deepEqual([view(bob).nation, view(bob).flag], ['Brasil', { country: 'br' }]);
  // Two factions may fly the same flag.
  send(bob, 'identity', { nation: 'Bobolândia', flag: ringed }); assert.deepEqual([view(bob).nation, view(bob).flag], ['Bobolândia', ringed]);
  // An invitation says the nation and shows its flag; whoever joins it may change both, for all of them.
  send(alice, 'invite', { playerId: carol.playerId });
  assert.deepEqual(view(carol).invites, [{ factionId: alice.faction.id, ref: view(alice).ref, name: 'Alice', nation: 'República de Farofa', flag: ringed, members: 1 }]);
  send(carol, 'join-faction', { factionId: alice.faction.id });
  assert.deepEqual([view(carol).nation, view(carol).flag], ['República de Farofa', ringed]);
  send(carol, 'identity', { nation: '', flag });
  assert.deepEqual([view(alice).nation, view(alice).flag, view(alice).name], [null, flag, 'Alice'], 'an empty name gives the faction back its leader\'s');
  // The name it gave up is free again.
  send(bob, 'identity', { nation: 'República de Farofa', flag: ringed }); assert.equal(view(bob).nation, 'República de Farofa');
  // Both are kept with the field; a faction kept before it had either goes by its leader's name under a flag drawn for it then.
  const kept = JSON.parse(JSON.stringify(room.keep())), of = id => kept.factions.find(f => f.id === id);
  assert.deepEqual([of(alice.faction.id).nation, of(alice.faction.id).flag, of(bob.faction.id).nation, of(bob.faction.id).flag], [null, flag, 'República de Farofa', ringed]);
  const again = new SharedRoom({ starter: false, build: false, kept }); t.after(() => again.world.dispose());
  assert.deepEqual([again.factionView(bob.playerId).nation, again.factionView(bob.playerId).flag], ['República de Farofa', ringed]);
});

test('every faction is told how wealthy each faction of the field is, its own with them; of one it never met, by name and flag alone', t => {
  // Four factions, founded in an order their names are not in; Carol's base is far from all the others.
  const { room, world, players: [zeca, mara, carol, duda], send, open, view, run, stock, part, set } =
    field(t, new SharedRoom({ starter: false, build: false, base: i => [-100, 15000, 61237, -30000][i] }), 'Zeca', 'Mara', 'Carol', 'Duda');
  const of = player => room.factions.get(player.faction.id),
    // A faction as a player is told it: its own and one it met by its name on the field and its leader's name; any other
    // by the name it goes by and its flag, and no more; each with what a request to join it names it by.
    told = (player, wealth, known = false) => ({ id: known ? of(player).id : null, name: known || !of(player).nation ? room.players.get(of(player).leader).name : null,
      nation: of(player).nation ?? null, flag: of(player).flag, ref: of(player).ref, wealth }),
    names = player => view(player).ranking.map(row => row.nation ?? row.name),
    mine = player => view(player).ranking.find(row => row.id === player.faction.id).wealth,
    // What a faction founded with the stocks of the field is worth: a point for each kilogram of a material, and 0.84 for each litre of fuel.
    founded = 90000 + 10000 + 10000 + .84 * 1500;
  assert.deepEqual(STARTING_STOCK, bill(90000, 10000, 10000, 1500)); assert.equal(founded, 111260);
  // Zeca has met Mara, and nobody else has met anybody.
  of(zeca).met.set(mara.faction.id, { since: 0, at: 0, x: 15000, defeatedAt: null });
  // Each is told all of them, its own among them; as wealthy as one another, they come in the order of their names and not of their coming.
  assert.deepEqual(view(zeca).ranking, [told(carol, founded), told(duda, founded), told(mara, founded, true), told(zeca, founded, true)]);
  assert.deepEqual([names(mara), names(carol), names(duda)], Array(3).fill(['Carol', 'Duda', 'Mara', 'Zeca']));
  for (const player of [zeca, mara, carol, duda]) for (const row of view(player).ranking) assert.deepEqual(Object.keys(row), ['id', 'name', 'nation', 'flag', 'ref', 'wealth']);
  // Mara's stocks and yard are others now. The field reckons what each faction is worth once a second at most: until then everybody is told what it was.
  stock(mara, 1000, 200, 300, 500); Object.assign(of(mara).yard, load(100, 0, 0, 50));
  assert.equal(view(zeca).ranking.find(row => row.id === mara.faction.id).wealth, founded);
  run(1);
  // A thousand kilograms of iron, 200 of alloys, 300 of silica and 500 L of fuel; 100 kg of iron ore and 50 L of petroleum
  // in her yard, worth what the refinery makes of them: 40 L of fuel to be.
  assert.deepEqual(view(zeca).ranking.map(row => [row.nation ?? row.name, row.wealth]),
    [['Carol', founded], ['Duda', founded], ['Zeca', founded], ['Mara', Math.round(1000 + 200 + 300 + 500 * .84 + 100 + 50 * YIELD.petroleo * .84)]]);
  assert.equal(Math.round(1000 + 200 + 300 + 500 * .84 + 100 + 50 * YIELD.petroleo * .84), 2054);
  // What a faction builds is worth to it what it paid, while nothing of it is lost; damaged, what dismantling it would give back.
  // A works opened is worth nothing yet; what of its material came to it, as much as it was worth in the stocks.
  const post = open(duda, 'guard-post'), works = room.works.pending.get(post); run(1);
  assert.deepEqual(view(duda).stock, STARTING_STOCK); assert.equal(mine(duda), founded);
  for (const id of STOCK_IDS) { of(duda).stock[id] -= works.cost[id]; works.delivered[id] = works.cost[id]; }
  run(1); assert(view(duda).stock.ferro < STARTING_STOCK.ferro); assert.equal(mine(duda), founded);
  works.progress = 1; room.works.complete(works); run(1);
  assert.equal(world.actor(post).team, duda.faction.id); assert.equal(mine(duda), founded);
  const command = part(post, 'command'); set(command, { health: command.health / 2 }); run(1);
  const { built, value } = view(duda).units.find(unit => unit.id === post);
  assert(weight(value) < weight(built)); assert.equal(mine(duda), Math.round(founded - weight(built) + weight(value)));
  // What a construction carries is worth what it weighs: ore by the kilogram.
  const lorry = room.publish(carol.playerId, createStructuredTemplate('mining-truck')).actor.id; run(1);
  const empty = mine(carol); set(part(lorry, 'hopper'), { cargo: { ferro: 1000 } }); run(1);
  assert(Math.abs(mine(carol) - empty - 1000) <= 1, `${mine(carol) - empty} points for a tonne of ore`);
  // Carol names her nation and makes its flag: everybody is told both, and of the leader of a nation it never met, nothing.
  const flag = { field: 'vertical3', colours: [11, 0, 4], emblem: 'disc' };
  send(carol, 'identity', { nation: 'Atlântida', flag });
  for (const player of [zeca, mara, duda]) assert.deepEqual(view(player).ranking[0], { id: null, name: null, nation: 'Atlântida', flag, ref: of(carol).ref, wealth: mine(carol) });
  // The name is the field's to give once, as before: whoever never met her is refused it in the same words as whoever did.
  of(mara).met.set(carol.faction.id, { since: 0, at: 0, x: 61237, defeatedAt: null });
  assert.deepEqual(view(mara).ranking[0], { ...told(carol, mine(carol), true), nation: 'Atlântida' });
  for (const player of [zeca, mara]) {
    assert.throws(() => send(player, 'identity', { nation: 'ATLÂNTIDA', flag }), /^Error: Já há uma facção com esse nome no campo\.$/);
    assert.equal(of(player).nation, null);
  }
  // Of a faction it has not met a player is sent nothing but that: not the faction's name on the field, nor its base,
  // nor who is of it — the name of a player on the field is told alone (`strangers`), and her frames name nobody else.
  const sent = player => JSON.stringify([room.factionView(player.playerId), room.squadView(player.playerId), room.roster()]);
  assert(!sent(zeca).includes(`"${carol.faction.id}"`), 'her faction by its name on the field');
  assert(!sent(zeca).includes('61237'), 'where her base is');
  assert(sent(zeca).includes(`"${mara.faction.id}"`), 'a faction met is told by it');
  // A faction founded is told to everybody; one gone is gone for everybody, whoever had met it.
  const bruno = room.join('Bruno');
  for (const player of [zeca, mara, carol, duda, bruno]) assert(names(player).includes('Bruno'));
  send(zeca, 'invite', { playerId: mara.playerId }); send(mara, 'join-faction', { factionId: zeca.faction.id });
  for (const player of [zeca, mara, carol, duda, bruno]) assert.deepEqual(names(player), ['Atlântida', 'Bruno', 'Zeca', 'Duda']);
  assert.equal(world.actors.length, 2);
});

test('no construction of the field stands in the way of another, whoever\'s it is, and an enemy inside a vehicle does not silence it', t => {
  // Two factions with their bases side by side: his scout stands twenty metres ahead of hers, each facing the other.
  const { room, world, ground, players: [alice, bob], publish, send, run, part, x } =
    field(t, new SharedRoom({ starter: false, build: false, stock: bill(1e6, 1e6, 1e6, 1e6), base: i => [-100, -80][i] }), 'Alice', 'Bob');
  const hers = publish(alice, 'scout', { x: -100, facing: 1 }), his = publish(bob, 'scout', { x: -80, facing: -1 });
  assert.notEqual(world.actor(his).team, world.actor(hers).team); run(2);
  const there = x(his);
  // She drives at him and into him: nothing of his holds her, and nothing of hers moves him.
  send(alice, 'drive', { throttle: 1, brake: 0 });
  for (let step = 0; step < 60 * 30 && Math.abs(x(hers) - x(his)) > 1.5; step++) room.step();
  assert(Math.abs(x(hers) - x(his)) <= 1.5, 'one is inside the other'); assert(Math.abs(x(his) - there) < .5, `he was pushed ${(x(his) - there).toFixed(2)} m`);
  const contacts = world.game().call({ op: 'physics', contacts: true }).contactStates;
  assert(!contacts.some(contact => contact.ownerA != null && contact.ownerB != null && contact.impulse > 0), 'they exert no impulse on each other');
  // Inside an enemy she fires, into him: a gun is not silenced by parking on it.
  const gun = part(hers, 'weapon'), at = gun.x + 300, aim = { x: at, y: ground.height(at) + 2 }, weapon = { id: 'cannon', componentId: gun.id };
  send(alice, 'aim', { aim, weapon }); run(.1);
  assert.equal(servoStatus(part(hers, 'weapon')).aligning, false, 'the gun has reached its aim');
  assert(Math.abs(x(hers) - x(his)) <= 1.5, 'it still fires from inside its enemy');
  world.drainEvents(); const shots = world.stats.shots;
  assert.equal(send(alice, 'fire', { request: 1, aim, weapon }).accepted, true); run(.1); assert.equal(world.stats.shots, shots + 1);
  assert(!world.drainEvents().some(e => e.type === 'weapon-blocked'));
  for (let step = 0; step < 60 * 30 && x(hers) - there < 12; step++) room.step();
  assert(x(hers) > there + 10, 'she came out on the other side');
});

test('inputs of one tick know of each other though the scene is read back only with the step', t => {
  const { room, world, ground, players: [alice], publish, send, part, x } = field(t, new SharedRoom({ starter: false, build: false, base: () => -100, industry: FULL_INDUSTRY }), 'Alice');
  const scout = publish(alice, 'scout'); for (let i = 0; i < 120; i++) room.step();
  const gun = part(scout, 'weapon'), at = gun.x + 300, aim = { x: at, y: ground.height(at) + 2 }, weapon = { id: 'cannon', componentId: gun.id },
    shots = () => { room.step(); return world.stats.shots; };
  // Two pulls of the trigger in one tick are one pull: one round leaves at once, not two.
  send(alice, 'trigger', { active: true, aim, weapon }); send(alice, 'trigger', { active: true, aim, weapon });
  assert.equal(shots(), 1); send(alice, 'trigger', { active: false });
  // A player gone quiet lets go once.
  let released = 0; const game = world.game(), call = game.call.bind(game);
  t.mock.method(game, 'call', request => {
    if (request.op === 'input' && request.input?.type === 'release') released++;
    return call(request);
  });
  const later = room.steps + 120; room.checkLeases(later); room.checkLeases(later + 1); room.checkLeases(later + 2);
  assert.equal(released, 1); room.step(); assert.equal(world.actor(scout).vehicle.throttle, 0);
});

test('the ground ends with the world: a vehicle is held short of it and drives back', t => {
  const room = new SharedRoom({ starter: false, build: false, stock: bill(1e6, 0, 1e6, 1e3), base: () => edge - 60 }), edge = room.world.terrain.maxX;
  const { world, players: [alice], publish, send, run, x } = field(t, room, 'Alice');
  const scout = publish(alice, 'scout', { x: edge - 45, facing: 1 });
  send(alice, 'drive', { throttle: 1, brake: 0 }); run(25);
  assert(x(scout) > edge - 14 && x(scout) < edge - 9.5, `it stands ${(edge - x(scout)).toFixed(1)} m from the end`);
  assert(Math.abs(world.actor(scout).vehicle.vx) < .2);
  send(alice, 'drive', { throttle: -1, brake: 0 }); run(6);
  assert(x(scout) < edge - 16, 'held, not stuck: it drives back');
});

test('a fresh contact is told before the first hit, once while it lasts', t => {
  const { room, players: [alice, bob], publish, send, run, x } = field(t, rehearsal([-100, 100]), 'Alice', 'Bob');
  const scout = publish(alice, 'scout'), theirs = publish(bob, 'heavy');
  send(alice, 'squad', { order: 'control', id: null }); run(.5);
  const unit = () => room.squadView(alice.playerId).units[0];
  assert.equal(unit().id, scout); assert.equal(unit().heard.channel, 'visual'); assert.equal(unit().alert, false);
  assert(Math.abs(unit().heard.x - x(theirs)) < 15, 'where that sense puts it');
  run(HEARD_SECONDS + 1); assert.equal(unit().heard, null);
});

test('a faction with nothing on the field is given only what it lacks of an ore lorry and two spare tanks, at its base, and is the same faction', t => {
  const { room, players: [alice, bob, carol], publish, send, view, stock } = field(t, new SharedRoom({ starter: false, build: false }), 'Alice', 'Bob', 'Carol'),
    lorry = cost('mining-truck'), reserve = 2 * lorry.combustivel, kit = billSum(lorry, bill(0, 0, 0, reserve)), own = () => room.faction(room.players.get(alice.playerId)),
    short = (has, offered) => ({ base: null, lorry, reserve, aid: bill(...STOCK_IDS.map(id => Math.max(0, kit[id] - has[id]))), offered });
  assert(kit.ferro > 0 && kit.ferro < STARTING_STOCK.ferro, 'the mining truck has a real iron bill the starting stocks can pay');
  // Cab shape and glass geometry are covered by the template and material tests; aid uses its current bill.
  const recovery = compileStructuredConstruction(createStructuredTemplate('mining-truck'));
  assert(['excavator', 'hopper'].every(kind => recovery.modules.some(piece => piece.kind === kind)), 'the mining truck can extract and carry with separate installed pieces');
  // Bob is of Alice's faction, and Carol was invited into it.
  send(alice, 'invite', { playerId: bob.playerId }); send(bob, 'join-faction', { factionId: alice.faction.id }); send(alice, 'invite', { playerId: carol.playerId });
  // A faction that pays for the lorry and its fuel is told nothing of the aid, and is refused it.
  assert.deepEqual([view(alice).recovery, view(alice).recovered], [null, null]);
  assert.throws(() => send(alice, 'recover'), /^Error: Os estoques e o pátio da facção pagam um caminhão de minério: fabrique-o na Oficina\.$/);
  // With a construction standing it is not offered, whoever of the faction that is of and however little there is left.
  const id = publish(bob, 'truck'); stock(alice, 100);
  assert.deepEqual([view(alice).recovery, view(bob).recovery], [short(bill(100), false), short(bill(100), false)]);
  assert.throws(() => send(alice, 'recover'), /^Error: A facção ainda tem construções no campo: o auxílio é para quem não tem nenhuma\.$/);
  // Left as a wreck it is nobody's: nothing of the faction stands, and it is offered.
  send(bob, 'abandon', { actorId: id });
  assert.deepEqual(view(alice).recovery, short(bill(100), true));
  // Not with stock for both, to the litre and to the silica of its glass; nor with what waits in the yard to make it up.
  stock(alice, kit.ferro, 0, kit.silica, kit.combustivel); assert.equal(view(alice).recovery, null);
  stock(alice, kit.ferro, 0, kit.silica - 1, kit.combustivel); assert.deepEqual(view(alice).recovery, short(bill(kit.ferro, 0, kit.silica - 1, kit.combustivel), true));
  stock(alice, kit.ferro, 0, kit.silica, kit.combustivel - 1); assert.deepEqual(view(alice).recovery, short(bill(kit.ferro, 0, kit.silica, kit.combustivel - 1), true));
  own().yard.petroleo = 1; assert.deepEqual(view(alice).recovery.aid, bill(0, 0, 0, 1), 'a litre of petroleum in the yard makes 0.8 L of fuel');
  own().yard.petroleo = 1 / YIELD.petroleo; assert.equal(view(alice).recovery, null, 'and 1.25 L of it the litre');
  stock(alice, kit.ferro - 19000, 0, kit.silica, kit.combustivel); Object.assign(own().yard, load(18999, 40));
  assert.deepEqual(view(alice).recovery, short(bill(kit.ferro - 1, 40, kit.silica, kit.combustivel), true), 'what it has is its stocks with its yard refined');
  own().yard.ferro = 19000; assert.equal(view(alice).recovery, null); assert.throws(() => send(bob, 'recover'), /pagam um caminhão de minério/);
  own().yard.ferro = 18999;
  // Any member may ask. The lorry is that member's, at the base the faction has, picked; the stocks pay for it first, the yard
  // what they lack, and the aid what is short, to the unit; what is left in stocks is the fuel of two more tanks.
  const before = view(alice), reply = send(bob, 'recover'), after = view(alice), truck = room.world.actor(reply.selected);
  assert.deepEqual([reply.base, reply.actor.id, truck.ownerId, truck.team, after.base], [before.base, truck.id, bob.playerId, before.id, before.base]);
  assert(Math.abs(truck.vehicle.x - before.base.x) <= BASE_RADIUS);
  assert.deepEqual([after.stock, after.yard, after.recovery.offered, after.recovered], [bill(0, 0, 0, reserve), load(0, 40), false,
    { at: room.world.time, base: null, from: null, lorry: true, aid: bill(1), aidAt: room.world.time }]);
  assert.deepEqual([after.id, after.name, after.members.map(m => m.name)], [before.id, 'Alice', ['Alice', 'Bob']], 'the same faction, with the members it had');
  assert.deepEqual(view(carol).invites.map(i => i.factionId), [before.id], 'and the invitations it made');
  assert(room.records.get(id).wreck && room.world.actor(id), 'its wreck stays where it is, nobody\'s');
  // With something on the field there is nothing more to give.
  assert.throws(() => send(alice, 'recover'), /ainda tem construções/);
});

test('subsidized recovery is shared by the faction, survives restart and opens exactly after 1800 simulation seconds', t => {
  const { room, players: [alice, bob, carol], send, view, stock } = field(t, new SharedRoom({ starter: false, build: false }), 'Alice', 'Bob', 'Carol'),
    own = () => room.faction(room.players.get(alice.playerId));
  send(alice, 'invite', { playerId: bob.playerId }); send(bob, 'join-faction', { factionId: alice.faction.id });
  stock(alice, 0); stock(carol, 0);
  const first = send(alice, 'recover');
  assert.deepEqual([room.world.time, own().recovered.at, own().recovered.aidAt], [0, 0, 0], 'the first grant has no wait, including at time zero');
  assert.equal('wait' in view(alice).recovery, false, 'a standing construction is not described as an interval');
  send(alice, 'abandon', { actorId: first.selected });
  assert.deepEqual([view(alice).count, view(alice).recovery.offered, view(alice).recovery.wait], [0, false, 1800]);
  const before = JSON.parse(JSON.stringify(room.keep()));
  for (const player of [alice, bob]) assert.throws(() => send(player, 'recover'), /^Error: Novo auxílio subsidiado em 1800 s de jogo\.$/);
  assert.deepEqual(JSON.parse(JSON.stringify(room.keep())), before, 'refusals change no stocks, yard, actors, selection, serials or recovery record');
  assert.equal(view(carol).recovery.offered, true, 'another faction has its own first grant');
  assert(view(carol).ranking.every(row => !('aidAt' in row) && !('wait' in row)), 'private recovery timing is not added to public rankings');

  const record = own().recovered, digest = room.digest();
  own().recovered = { ...record, aidAt: 1 }; assert.notEqual(room.digest(), digest, 'the aid timestamp affects canonical gameplay state');
  own().recovered = { ...record, at: 42, aid: bill() }; assert.equal(room.digest(), digest, 'a paid event date does not renew the subsidy interval');
  own().recovered = { ...record }; delete own().recovered.aidAt;
  assert.equal(room.digest(), digest, 'an older positive grant has the same effective timestamp');
  own().recovered = record;

  // Saved timestamp fixtures exercise the policy boundary without simulating half an hour of physics.
  for (const elapsed of [0, 1799.75, 1800]) {
    const kept = JSON.parse(JSON.stringify(room.keep())); kept.scene.time = elapsed; kept.scene.tick = Math.round(elapsed * 60);
    const again = new SharedRoom({ starter: false, build: false, kept }); t.after(() => again.world.dispose());
    const back = again.join('Bob', bob.token), quote = again.factionView(back.playerId).recovery;
    assert.equal(again.field.time, elapsed); assert.equal(again.faction(again.players.get(back.playerId)).recovered.aidAt, 0);
    if (elapsed < 1800) {
      assert.deepEqual([quote.offered, quote.wait], [false, 1800 - elapsed]);
      assert.throws(() => again.command(back.playerId, { type: 'recover' }), new RegExp(`^Error: Novo auxílio subsidiado em ${Math.ceil(1800 - elapsed)} s de jogo\\.$`));
    } else {
      assert.equal(quote.offered, true); assert.equal('wait' in quote, false);
      again.command(back.playerId, { type: 'recover' });
      const faction = again.faction(again.players.get(back.playerId));
      assert.deepEqual([faction.recovered.at, faction.recovered.aidAt, faction.stock.combustivel], [1800, 1800, 2 * cost('mining-truck').combustivel]);
    }
  }

  // A paid legacy event contains no recoverable subsidy date; do not invent one.
  const other = room.faction(room.players.get(carol.playerId));
  other.recovered = { at: room.world.time, base: other.base.x, from: null, lorry: false, aid: bill() };
  assert.equal(view(carol).recovery.offered, true);
  send(carol, 'recover'); assert.equal(other.recovered.aidAt, room.world.time);
});
