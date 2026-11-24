import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { depositsNear } from '../src/deposits.ts';
import { LOAD_REACH, bill, billTotal, captureAt } from '../src/economy.ts';
import { POST_RADIUS } from '../src/territory.ts';
import { captureBar, dismantlePlan, publishQuote, unitServices } from '../src/faction-ui.ts';
import { onField } from './helpers/field.js';
import { gunship } from './helpers/aircraft.js';

await initNativeDynamics();

// What the field gives only to what stands on the ground (server/room.ts): a base or a post is taken and held by what
// stands armed in it on the ground (`besiege`), sheltered with what stands there (`cover`), fabricated into wherever no
// construction stands on the ground (manufacturing.ts `baseVehiclePosition`); a wreck is taken (`reaching`), and a
// construction repaired (`station`), dismantled and replaced (`workshop`), standing still there on the ground (`still`).
// An aircraft hovering over any of these places, high up or a few metres over the ground, gets none of it; landed, it does.
// Real designs flown by their own pilots (tests/helpers/aircraft.js) on the real field.

const HIGH = 500, LOW = 8;
// A field of factions founded at `bases`, each with all it takes, and the players that came into it.
function field(t, bases, ...names) {
  const room = rehearsal(bases, bill(1e9, 1e9, 1e9, 1e9), { fog: false }), f = onField(t, room), players = names.map(name => room.join(name));
  return { ...f, players, faction: player => room.faction(room.players.get(player.playerId)), view: player => room.factionView(player.playerId),
    told: (player, id) => room.factionView(player.playerId).units.find(unit => unit.id === id) };
}
// An aircraft of a player's on the field: flown by its pilot to `height` metres over the ground at `x` and held there, or
// landed at `x`, with `each` asked at every step on the way down. Let its running gear settle before these long trips.
function flier(f, player, id) {
  const { room, world, ground } = f, actor = () => world.actor(id), vehicle = () => actor().vehicle,
    unit = () => room.players.get(player.playerId).squad.units.get(id);
  f.run(.5);
  return { actor,
    hover(x, height) {
      f.order(player, 'move', { ids: [id], x, y: ground.height(x) + height });
      assert(f.until(() => !unit().move && vehicle().flying && Math.hypot(vehicle().vx, vehicle().vy) < .3, 120), `it hovers ${height} m over ${x}`);
      assert(!room.still(actor()) && Math.abs(vehicle().x - x) < 3 && Math.abs(vehicle().y - ground.height(x) - height) < 3,
        `${vehicle().x.toFixed(1)}, ${(vehicle().y - ground.height(vehicle().x)).toFixed(1)} m up`);
    },
    land(x, each = () => {}) {
      f.order(player, 'move', { ids: [id], x });
      assert(f.until(() => { each(); return !unit().move && room.still(actor()); }, 90), 'it lands');
      assert(!vehicle().flying);
    } };
}
// Of a capture under way, whose it is and which way it goes.
const course = capture => capture && { by: capture.by, state: capture.state };

test('Native publishes actual ground support on admission and after a step, for wheels, tracks and skids', t => {
  const f = field(t, [0], 'Ana'), { world, players: [ana] } = f;
  for (const [source, x, initial] of [['scout', -60, true], ['heavy', 0, true], [gunship(), 60, false]]) {
    const id = f.publish(ana, source, { x, facing: 1 }), vehicle = () => world.actor(id).vehicle,
      raw = () => JSON.parse(world.dynamics.core.current_frame()).actors.find(a => a.id === id).vehicle;
    assert.equal(vehicle().grounded, initial, 'host admission uses Native support');
    assert.equal(raw().grounded, initial);
    world.step();
    assert.equal(vehicle().grounded, raw().grounded, 'live frames agree with the authoritative snapshot');
    for (let frame = 0; frame < 120 && !vehicle().grounded; frame++) world.step();
    assert.equal(vehicle().grounded, true, 'the admitted construction settles onto the ground');
  }
});

test('a newly fabricated aircraft takes its first sky order at the requested altitude, before the first physics step', { timeout: 120000 }, t => {
  const f = field(t, [0], 'Ana'), { world, ground, players: [ana] } = f,
    id = f.publish(ana, gunship({ eye: true, tankScale: 1.25 })), vehicle = () => world.actor(id).vehicle,
    squad = f.room.players.get(ana.playerId).squad, unit = () => squad.units.get(id), x = vehicle().x + 500;
  assert.equal(world.tick, 0);
  assert(vehicle().thrustN > 0, 'Native publishes available thrust on admission');
  f.order(ana, 'move', { ids: [id], x, y: ground.height(x) + 30 });
  assert.deepEqual([unit().move.height, unit().move.sky], [30, true], 'the first order keeps its height');
  assert(f.until(() => !unit().move && vehicle().flying && Math.hypot(vehicle().vx, vehicle().vy) < .3, 90), 'it reaches and holds the sky destination');
  assert(Math.abs(vehicle().x - x) < 3 && Math.abs(vehicle().y - ground.height(x) - 30) < 3);
});

for (const target of ['base', 'post']) test(`a ballistic ground vehicle neither captures nor contests a ${target} at its unsupported apex; landed it counts again`, t => {
  const f = field(t, [0, 12000], 'Ana', 'Bia'), { room, world, ground, players: [ana, bia], faction } = f,
    holder = faction(bia);
  let hold = holder, x = holder.base.x;
  if (target === 'post') {
    for (let d = 2000; d <= 4000; d += 7) {
      if (depositsNear(room.deposits, holder.base.x + d, POST_RADIUS + 2 * LOAD_REACH).length) continue;
      const id = f.send(bia, 'post', { x: holder.base.x + d, facing: 1, instant: true }).post.id;
      hold = holder.posts.find(p => p.id === id); x = hold.x; break;
    }
    assert.notEqual(hold, holder, 'a valid post was found');
  }
  const raider = f.publish(ana, 'scout');
  f.order(ana, 'stance', { ids: [raider], stance: 'hold' }); f.put(raider, x - 25);
  f.run(4);
  assert.equal(hold.capture.state, 'advancing');
  const keeper = f.publish(bia, 'scout');
  f.order(bia, 'stance', { ids: [keeper], stance: 'hold' }); f.put(keeper, x + 25);
  room.besiege(world.time);
  assert.equal(hold.capture.state, 'contested');
  const launch = id => {
    const vehicle = () => world.actor(id).vehicle;
    assert.equal(vehicle().grounded, true);
    world.command('setVehicleState', { actorId: id, state: { vy: 5 } });
    for (let frame = 0; frame < 300; frame++) { world.step(); if (vehicle().vy <= 0) break; }
    assert(vehicle().y - ground.height(vehicle().x) > 2 && Math.abs(vehicle().vy) < .5, 'a natural ballistic apex');
    assert.equal(vehicle().flying, false, 'a ground chassis never enters flight mode');
    assert.equal(room.still(world.actor(id)), false, 'speed alone cannot authorize ground work');
    assert.equal(vehicle().grounded, false, 'Native support distinguishes the apex');
    room.besiege(world.time);
  };
  launch(keeper);
  assert.equal(hold.capture.state, 'advancing', 'an unsupported defender cannot contest');
  launch(raider);
  assert.equal(hold.capture.state, 'receding', 'an unsupported attacker cannot capture');
  const conflict = target === 'base' ? room.contested.get(holder.id) : room.disputed.get(hold.id);
  assert.deepEqual(conflict.foes, []);
  // Let physics land them without starting an automatic base repair in this capture-only fixture.
  const landed = () => [raider, keeper].every(id => world.actor(id).vehicle.grounded);
  for (let frame = 0; frame < 600 && !landed(); frame++) world.step();
  assert(landed(), 'both land naturally');
  room.besiege(world.time);
  assert.equal(hold.capture.state, 'contested', 'both count again on the ground');
});

test('a ballistic vehicle over its base receives no service or offline shelter at its apex; landing restores both', t => {
  const f = field(t, [0], 'Ana'), { room, world, ground, players: [ana], faction } = f,
    id = f.publish(ana, 'scout'), actor = () => world.actor(id), vehicle = () => actor().vehicle,
    tank = () => world.modules.find(part => part.actorId === id && part.kind === 'fuel');
  f.order(ana, 'stance', { ids: [id], stance: 'hold' }); f.run(1);
  world.command('setVehicleState', { actorId: id, state: { vy: 5 } });
  for (let frame = 0; frame < 300; frame++) { world.step(); if (vehicle().vy <= 0) break; }
  assert(vehicle().y - ground.height(vehicle().x) > 2 && Math.abs(vehicle().vy) < .5, 'a natural ballistic apex');
  assert.equal(vehicle().flying, false); assert.equal(vehicle().grounded, false);
  world.game().call({ op: 'setPartState', owner: world.game().handle(tank()), state: { fuelLitres: 10 } });
  const stock = { ...faction(ana).stock };
  room.serve();
  assert.equal(tank().fuelLitres, 10, 'a fuel hose cannot service a vehicle without ground support');
  assert.deepEqual(faction(ana).stock, stock, 'unsupported service spends nothing');
  assert.equal(room.still(actor()), false, 'stopped for service requires physical support');
  assert.throws(() => f.send(ana, 'remove', { actorId: id }), /Pare na base/, 'dismantling also waits for ground support');
  faction(ana).shelter = world.time; room.cover();
  assert.equal(room.sheltered.has(actor()), false, 'offline protection does not extend to a jumping vehicle');
  for (let frame = 0; frame < 600 && !room.still(actor()); frame++) world.step();
  assert(vehicle().grounded && room.still(actor()), 'the same physics lands and settles it without repositioning');
  room.serve(); room.cover();
  assert(tank().fuelLitres > 10, 'ordinary base service works again on the ground');
  assert(room.sheltered.has(actor()), 'the landed vehicle is sheltered again');
});

test('an armed aircraft hovering over the base of another, high or a few metres up, neither begins its capture nor is told it is taking it; landed there, it begins it', { timeout: 120000 }, t => {
  // Ana's base at -100 and Bia's at 60: they overlap between -40 and 0.
  const f = field(t, [-100, 60], 'Ana', 'Bia'), { room, world, players: [ana, bia], faction, view } = f,
    raider = f.publish(ana, gunship(), { x: -150, facing: 1 }), air = flier(f, ana, raider);
  for (const height of [HIGH, LOW]) {
    air.hover(-20, height); f.run(3);
    assert.equal(faction(bia).capture, null, `${height} m up it begins nothing`);
    assert.equal(room.contested.has(faction(bia).id), false, 'nor stands armed in it');
    assert.deepEqual([view(ana).taking, view(bia).siege, captureBar(view(ana), world.time), captureBar(view(bia), world.time)], [[], null, null, null],
      'and neither faction is told of a capture');
  }
  air.land(-20); f.run(2);
  assert.deepEqual(course(faction(bia).capture), { by: faction(ana).id, state: 'advancing' }, 'landed, it begins the capture');
  assert.match(captureBar(view(bia), world.time).text, /^Base sendo tomada · .* · avançando$/);
  assert.match(captureBar(view(ana), world.time).text, /^Tomando a base da facção de Bia · .* · avançando$/);
});

test('an armed aircraft of the base hovering over it, high or a few metres up, holds nothing against a tank of another on the ground there; landed, it holds the capture', { timeout: 120000 }, t => {
  const f = field(t, [-100, 60], 'Ana', 'Bia'), { room, world, players: [ana, bia], faction, view } = f,
    keeper = f.publish(bia, gunship(), { x: 100, facing: -1 }), air = flier(f, bia, keeper);
  air.hover(100, HIGH);
  // Ana's scout comes into Bia's base, on the ground: it begins the capture.
  f.publish(ana, 'scout', { x: -30, facing: 1 }); f.run(2);
  assert.deepEqual(course(faction(bia).capture), { by: faction(ana).id, state: 'advancing' }, 'a tank on the ground begins it');
  assert.deepEqual(room.contested.get(faction(bia).id), { foes: [faction(ana).id] });
  for (const height of [HIGH, LOW]) {
    if (height !== HIGH) air.hover(100, height);
    const before = captureAt(faction(bia).capture, world.time);
    f.run(3);
    assert.equal(faction(bia).capture.state, 'advancing', `${height} m up it does not hold the base`);
    assert(captureAt(faction(bia).capture, world.time) > before + 2.5, 'the capture goes on');
    assert.match(captureBar(view(bia), world.time).text, /· avançando$/);
  }
  air.land(100); f.run(2);
  assert.equal(faction(bia).capture.state, 'contested', 'landed, it holds the capture where it is');
  assert.match(captureBar(view(ana), world.time).text, /· disputada$/);
});

test('an armed aircraft hovering over the post of another, high or a few metres up, begins no capture of it; landed there, it does', { timeout: 120000 }, t => {
  const f = field(t, [-213, 40000], 'Ana', 'Bia'), { room, players: [ana, bia], faction, view } = f, home = faction(bia).base.x,
    clear = x => !depositsNear(room.deposits, x, POST_RADIUS + 2 * LOAD_REACH).length;
  let at = null;
  for (let d = 4000; d >= 3500 && at === null; d -= 7) if (clear(home - d)) at = home - d;
  assert(at !== null, 'the fixture needs a place clear of sites');
  const post = f.send(bia, 'post', { x: at, facing: 1, instant: true }).post.id, mine = () => faction(bia).posts.find(each => each.id === post),
    raider = f.publish(ana, gunship(), { facing: 1 });
  // Fabricated at Ana's base, it is stood on the ground 150 m short of the post, out of it, and let take its orders there
  // whatever fuel it keeps to fly home, 36 km away.
  f.put(raider, mine().x - POST_RADIUS - 100);
  f.send(ana, 'homing', { actorId: raider, on: false });
  const air = flier(f, ana, raider);
  for (const height of [HIGH, LOW]) {
    air.hover(mine().x + 10, height); f.run(3);
    assert.equal(mine().capture, null, `${height} m up it begins nothing`);
    assert.deepEqual([room.disputed.has(post), view(ana).taking, view(bia).posts.find(each => each.id === post).siege], [false, [], null]);
  }
  air.land(mine().x + 10); f.run(2);
  assert.deepEqual(course(mine().capture), { by: faction(ana).id, state: 'advancing' }, 'landed, it begins the capture');
});

test('an aircraft hovering over its sheltered base, high or a few metres up, is not sheltered and takes no place a vehicle is fabricated into; landed, it is sheltered and takes its place', { timeout: 120000 }, t => {
  const f = field(t, [0, 12000], 'Ana'), { room, world, players: [ana], faction } = f, base = faction(ana).base.x, spot = base - 40,
    craft = f.publish(ana, gunship(), { x: spot, facing: 1 }), lorry = f.publish(ana, 'truck', { x: base + 40, facing: 1 }), air = flier(f, ana, craft),
    sheltered = id => room.sheltered.has(world.actor(id));
  // The base is sheltered as that of a faction away for long enough.
  faction(ana).shelter = world.time;
  f.run(.5);
  assert(sheltered(craft) && sheltered(lorry), 'on the ground both are sheltered');
  for (const height of [HIGH, LOW]) {
    air.hover(spot, height); f.run(.5);
    assert(!sheltered(craft), `${height} m up it is not`);
    assert(sheltered(lorry));
  }
  // A few metres over its place, a scout is fabricated right under it; landed there, nothing is.
  const under = f.publish(ana, 'scout', { x: spot, facing: 1 });
  assert(Math.abs(world.actor(under).vehicle.x - spot) < 1, 'nothing on the ground stands there');
  f.run(1); f.send(ana, 'remove', { actorId: under });
  air.land(spot); f.run(.5);
  assert(sheltered(craft), 'landed, it is sheltered again');
  assert.throws(() => f.publish(ana, 'scout', { x: world.actor(craft).vehicle.x, facing: 1 }), /Não há espaço aí/);
});

test('an aircraft hovering by a wreck, high or a few metres up, takes nothing of it, and is told to land; landed by it, it takes it', { timeout: 120000 }, t => {
  const f = field(t, [0], 'Ana'), { room, world, players: [ana] } = f, row = id => f.view(ana).wrecks.find(wreck => wreck.id === id),
    lost = f.publish(ana, 'scout', { x: 60, facing: 1 }), craft = f.publish(ana, gunship(), { x: -60, facing: 1 }), air = flier(f, ana, craft);
  for (const post of f.parts(lost, 'command')) f.set(post, { health: 0 });
  f.run(.5);
  assert(room.records.get(lost).wreck, 'out of command, it is a wreck');
  const x = world.actor(lost).vehicle.x;
  // A scout that rolls by it is told to stop first.
  const passing = f.publish(ana, 'scout', { x: x - 15, facing: 1 });
  f.run(1);
  world.command('setVehicleState', { actorId: passing, state: { vx: 4 } }); world.sync();
  assert.throws(() => f.send(ana, 'salvage', { wreckId: lost }), { message: 'Pare perto dos destroços para recolhê-los.' });
  f.put(passing, -150);
  for (const height of [HIGH, LOW]) {
    air.hover(x + 15, height);
    assert.deepEqual([row(lost).inReach, row(lost).calmIn], [false, null], `${height} m up it has it in no reach`);
    assert.throws(() => f.send(ana, 'salvage', { wreckId: lost }), { message: 'Pouse perto dos destroços para recolhê-los.' });
  }
  air.land(x + 15);
  assert.equal(row(lost).inReach, true, 'landed by it, it has it in reach');
  assert.equal(f.send(ana, 'salvage', { wreckId: lost }).salvaged, lost);
  assert(!world.actor(lost));
});

test('an aircraft hovering over its base, high or a few metres up, is neither repaired nor offered the repair; landed, it is', { timeout: 120000 }, t => {
  const f = field(t, [0, 12000], 'Ana'), { room, world, players: [ana] } = f, spot = f.faction(ana).base.x - 40,
    craft = f.publish(ana, gunship(), { x: spot, facing: 1 }), air = flier(f, ana, craft), record = () => room.record(air.actor()),
    // A repair cancelled where it stands is asked for (`declined`): the base does not begin it by itself.
    asked = () => { record().declined = room.position(air.actor()); },
    repairJob = () => unitServices(f.told(ana, craft), f.view(ana)).jobs.find(job => job.id === 'repair');
  // Its engine damaged on the ground: by the time it hovers, that is no fight it is in any longer.
  const engine = f.parts(craft, 'engine')[0];
  asked(); f.set(engine, { health: engine.maxHealth / 2 }); f.run(.2);
  assert(billTotal(f.told(ana, craft).repair) > 0, 'it has damage to mend');
  for (const height of [HIGH, LOW]) {
    air.hover(spot, height); asked(); f.run(.2);
    assert(room.calm(air.actor()), 'out of combat');
    assert.equal(record().service, null, `${height} m up its base does not mend it`);
    assert.throws(() => f.send(ana, 'repair', { actorId: craft }), { message: 'Pouse para reparar.' });
    assert.deepEqual([f.told(ana, craft).aloft, repairJob().disabled, repairJob().title], [true, true, 'Pouse para reparar.'], 'its button says so');
  }
  air.land(spot, asked); asked();
  assert.equal(f.told(ana, craft).aloft, undefined);
  assert.equal(repairJob().disabled, false, 'landed, the repair is offered');
  f.send(ana, 'repair', { actorId: craft });
  assert.equal(record().service?.kind, 'repair');
});

test('an aircraft hovering over its base, high or a few metres up, is neither dismantled nor replaced, nor offered either; landed, it is', { timeout: 120000 }, t => {
  const f = field(t, [0, 12000], 'Ana'), { world, players: [ana] } = f, base = f.faction(ana).base.x, spot = base - 40,
    craft = f.publish(ana, gunship(), { x: spot, facing: 1 }), scout = f.publish(ana, 'scout', { x: base + 40, facing: 1 }), air = flier(f, ana, craft),
    plan = () => dismantlePlan([f.told(ana, craft)]), offer = () => publishQuote({ price: bill(100), faction: f.view(ana), unit: f.told(ana, craft), name: 'a aeronave' }).replace;
  for (const height of [HIGH, LOW]) {
    air.hover(spot, height);
    assert.throws(() => f.send(ana, 'remove', { actorId: craft }), { message: 'Pouse na base para desmontar.' });
    assert.throws(() => f.send(ana, 'replace', { actorId: craft, blueprint: gunship() }), { message: 'Pouse na base para substituir.' });
    assert.deepEqual([plan().ids, plan().reason, plan().out], [[], 'Pouse na base para desmontar.', '1 no ar'], `${height} m up it is not offered either`);
    assert.deepEqual([offer().disabled, offer().title], [true, 'Pouse na base para substituir.']);
  }
  air.land(spot); f.run(.5);
  assert.deepEqual([plan().ids, offer().disabled], [[craft], false], 'landed, both are offered');
  assert.equal(f.send(ana, 'replace', { actorId: craft, blueprint: gunship() }).selected, craft, 'and it is replaced');
  f.run(1);
  assert.equal(f.send(ana, 'remove', { actorId: craft }).removed, craft, 'and dismantled');
  // On the ground, one that rolls through the base is told to stop first.
  f.run(1);
  world.command('setVehicleState', { actorId: scout, state: { vx: 4 } }); world.sync();
  assert.throws(() => f.send(ana, 'remove', { actorId: scout }), { message: 'Pare na base para desmontar.' });
  assert.deepEqual([dismantlePlan([f.told(ana, scout)]).reason], ['Pare na base para desmontar.']);
});
