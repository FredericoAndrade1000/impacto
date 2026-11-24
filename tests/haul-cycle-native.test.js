import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { createStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { depositsNear } from '../src/deposits.ts';
import { collectionWork, canCollect } from '../src/loading-area.ts';
import { BASE_RADIUS, LOAD_REACH, REFINED, YIELD, extractRate, carriedBy, bill } from '../src/economy.ts';
import { nativeFuelFlow } from '../src/native-dynamics.ts';
import { MODULES } from '../src/materials.ts';
import { CELL, cellOf } from '../src/grid.ts';

// The petroleum case exchanges the ore lorry's independent hopper/tool for the
// ordinary cistern/drill. Native admission retains the same real chassis,
// engine, fuel and mounting locations; nothing supplies cargo or motion by hand.
const petroleumSource = () => {
  const source = createStructuredTemplate('mining-truck');
  return validateStructuredConstruction({ ...source, name: 'Extração e transporte de petróleo',
    components: source.components.map(piece => piece.kind === 'hopper' ? { ...piece, id: 'cistern', kind: 'cistern' }
      : piece.kind === 'excavator' ? { ...piece, id: 'drill', kind: 'drill',
        pose: { ...piece.pose, y: piece.pose.y + cellOf((MODULES.drill.height - MODULES.excavator.height) * piece.sizeScale / 2) } } : piece) });
};
// The tanker pumps with a drill of its own; without it, it carries only what is already out of the ground.
const transporter = id => {
  const source = createStructuredTemplate(id);
  return validateStructuredConstruction({ ...source, components: source.components.filter(piece => piece.kind !== 'drill') });
};

// What the service of the base charged for filling up the tanks of the vehicle `id` from now on, when that is the stock
// counted (`stock`): it comes out of the stocks a delivery of petroleum adds to.
const fuelBought = (room, id, stock) => {
  const tally = { bought: 0 }, refill = room.refill.bind(room);
  room.refill = (actor, ...rest) => {
    const given = refill(actor, ...rest);
    if (given && actor.id === id && stock === 'combustivel') tally.bought += given.cost.combustivel;
    return given;
  };
  return tally;
};

for (const material of ['ferro', 'petroleo'])
  test(`one ${material} collection order fills naturally, delivers to base and repeats a second complete trip`, { timeout: 60000 }, t => {
    let base;
    // The lorry alone: the service of the base fills it up with nothing but its fuel, which is counted (`bought`).
    const room = new SharedRoom({ starter: false, build: false, base: () => base });
    t.after(() => room.world.dispose());
    const world = room.world, site = room.deposits.filter(site => site.material === material &&
      depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 &&
      depositsNear(room.deposits, site.x + 250, BASE_RADIUS + LOAD_REACH).length === 0)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    assert(site); base = site.x + 250;
    const joined = room.join('Coletor'), owner = room.players.get(joined.playerId),
      id = room.publish(owner.id, material === 'ferro' ? createStructuredTemplate('mining-truck') : petroleumSource()).actor.id,
      faction = room.faction(owner), stock = REFINED[material], carried = () => carriedBy(room.pieces(id)).carried[material],
      // What was brought, as the raw material it was: a litre of fuel was made of 1.25 L of petroleum.
      brought = () => faction.stock[stock] / YIELD[material] + faction.yard[material], before = brought(), phases = [], fuel = fuelBought(room, id, stock);
    room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
    let deliveries = 0, previousCargo = 0, loaded = 0, departedAgain = false, previousPhase;
    for (let step = 0; step < 420 * 60; step++) {
      room.step();
      const unit = owner.squad.units.get(id), cargo = carried(), phase = unit.haul?.phase;
      if (phase !== previousPhase) { phases.push({ time: world.time, phase, cargo }); previousPhase = phase; }
      loaded = Math.max(loaded, cargo);
      if (previousCargo > 0 && cargo === 0 && Math.abs(world.actor(id).vehicle.x - base) <= BASE_RADIUS) deliveries++;
      previousCargo = cargo;
      if (deliveries >= 2 && phase === 'out' && unit.move) { departedAgain = true; break; }
    }
    t.diagnostic(JSON.stringify({ material, deliveries, loaded, elapsed: world.time, phases,
      x: world.actor(id).vehicle.x, order: owner.squad.units.get(id).haul, gained: brought() - before, bought: fuel.bought }));
    assert.equal(deliveries, 2, 'two real loads reach the base without refilling cargo or reissuing the order');
    assert(departedAgain, 'the same order starts another collection leg after the second unload');
    assert(loaded > 1000, 'a real full container was filled at the native per-vehicle rate');
    assert(Math.abs(brought() + fuel.bought / YIELD[material] - before - loaded * 2) < 1e-5, 'all delivered material is refined stock, still in the base yard, or the fuel the lorry was filled up with');
    assert(!['build', 'repair'].includes(room.record(world.actor(id)).service?.kind));
    assert.equal(room.faults.size, 0);
  });

for (const material of ['ferro', 'petroleo'])
  test(`a workshop transporter delivers a partial ${material} pile, waits empty for production and carries the next pile under the same order`, { timeout: 60000 }, t => {
    let base;
    const room = new SharedRoom({ starter: false, build: false, base: () => base });
    t.after(() => room.world.dispose());
    const world = room.world, site = room.deposits.filter(site => site.material === material &&
      depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 &&
      depositsNear(room.deposits, site.x + 250, BASE_RADIUS + LOAD_REACH).length === 0)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
    assert(site); base = site.x + 250;
    const joined = room.join('Transportador'), owner = room.players.get(joined.playerId),
      id = room.publish(owner.id, material === 'ferro' ? createStructuredTemplate('truck') : transporter('tanker')).actor.id,
      faction = room.faction(owner), stock = REFINED[material], carried = () => carriedBy(room.pieces(id)).carried[material],
      brought = () => faction.stock[stock] / YIELD[material] + faction.yard[material], before = brought(), reserve = room.left(site), phases = [], fuel = fuelBought(room, id, stock);
    // Material already extracted into the public pile is the only fixture
    // input. Containers, native mass, loading rates and driving stay real.
    room.extracted.set(site.id, 500);
    room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
    let deliveries = 0, previousCargo = 0, waited = 0, secondPile = false, previousPhase;
    for (let step = 0; step < 300 * 60; step++) {
      room.step();
      const unit = owner.squad.units.get(id), cargo = carried(), phase = unit.haul?.phase;
      if (phase !== previousPhase) { phases.push({ time: world.time, phase, cargo }); previousPhase = phase; }
      if (previousCargo > 0 && cargo === 0 && Math.abs(world.actor(id).vehicle.x - base) <= BASE_RADIUS) deliveries++;
      previousCargo = cargo;
      if (deliveries === 1 && phase === 'load' && cargo === 0 && room.record(world.actor(id)).cargoWork?.waiting) {
        waited++;
        assert.equal(unit.move, null, 'an empty vehicle waits here rather than making empty round trips');
        if (waited === 4 * 60) { room.extracted.set(site.id, 375); secondPile = true; }
      }
      if (deliveries >= 2 && phase === 'out' && unit.move) break;
    }
    t.diagnostic(JSON.stringify({ material, deliveries, waited, elapsed: world.time, phases,
      x: world.actor(id).vehicle.x, order: owner.squad.units.get(id).haul, gained: brought() - before, bought: fuel.bought }));
    assert.equal(deliveries, 2, 'available partial loads are delivered without requiring a full container');
    assert(secondPile && waited >= 4 * 60, 'new production resumes the same waiting order');
    assert(Math.abs(brought() + fuel.bought / YIELD[material] - before - 875) < 1e-5, 'only the two actual public piles reach the base, less the fuel the vehicle was filled up with');
    assert.equal(room.left(site), reserve, 'a transporter never extracts from the geological reserve');
    assert.equal(room.faults.size, 0);
  });

test('an oil well pumps on its own engine, burns its fuel for it and stops dry, saying so, until a supply truck fills it', { timeout: 60000 }, t => {
  let base;
  const room = new SharedRoom({ starter: false, build: false, base: () => base });
  t.after(() => room.world.dispose());
  const world = room.world, game = world.game(), site = room.deposits.filter(site => site.material === 'petroleo' &&
    depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1).sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
  assert(site); base = site.x + 600;
  const joined = room.join('Poço'), owner = room.players.get(joined.playerId), faction = room.faction(owner);
  world.addActor(createStructuredTemplate('oil-well'), { id: 'well', ownerId: owner.id, team: faction.id, x: site.x, facing: 1 });
  const tanks = () => world.modules.filter(m => m.actorId === 'well' && m.kind === 'fuel'), fuel = () => tanks().reduce((sum, m) => sum + m.fuelLitres, 0),
    pumped = () => room.extracted.get(site.id) ?? 0, run = seconds => { for (let i = 0; i < seconds * 60; i++) room.step(); };
  run(2);
  // Standing on the vein it pumps with no order, 10 L a second, and its 180 kW engine burns for the 150 its drill takes.
  const [had, out, at] = [fuel(), pumped(), world.time], rate = extractRate(world.modules.find(m => m.actorId === 'well' && m.kind === 'drill')); run(10);
  assert.equal(rate, 10);
  assert(Math.abs(pumped() - out - rate * (world.time - at)) <= rate / 10, `${(pumped() - out).toFixed(1)} L`);
  assert(Math.abs(had - fuel() - nativeFuelFlow(150, 180) * (world.time - at) / 3600) < 1e-3, `${(had - fuel()).toFixed(4)} L burned`);
  assert.equal(room.factionView(owner.id).units.find(unit => unit.id === 'well').extracting, site.id);
  // Dry, it stops, and the faction is told why.
  for (const tank of tanks()) game.call({ op: 'setPartState', owner: game.handle(tank), state: { fuelLitres: 0 }, frame: false });
  run(1);
  const stopped = pumped(); run(2);
  assert.equal(pumped(), stopped);
  assert.deepEqual(room.factionView(owner.id).units.find(unit => unit.id === 'well').tools, { limit: 'fuel' });
  // A supply truck, which comes in automatic, brings it fuel and fills its tank where it stands, and it pumps again.
  const truck = room.publish(owner.id, createStructuredTemplate('supply')).actor.id;
  assert.equal(room.record(world.actor(truck)).auto, true);
  for (let i = 0; i < 240 * 60 && !(fuel() > 100); i++) room.step();
  assert(fuel() > 100, `${fuel().toFixed(1)} L in its tank`);
  const again = pumped(); run(2); assert(pumped() > again);
  assert.equal(room.faults.size, 0);
});

// A valid workshop design whose normal-size arm sits too high for its complete
// digging stroke. Its independent low hopper can still collect a public pile.
function highToolSource(hopper = true) {
  const source = createStructuredConstruction({ name: 'Escavadeira alta de oficina', length: 7, height: 2.2,
    frontInset: .4, rearInset: .1, thicknessMm: 10 }),
    // This reinforced fixture has 1.21 m tyres and a 44 cm frame. Its
    // authored deck clears both, where its model hangs gear of that size.
    // In cells of the grid: its chassis on the first cell at or over that deck, all of it lifted with it, each part
    // on the first cell at or over where it stood above the floor.
    deck = 1.330566666666667, lift = Math.ceil((deck - 1.3) / CELL - 1e-9) - source.chassis.points[0].y,
    floor = Math.min(...source.nodes.map(node => node.y)) + lift, above = metres => floor + Math.ceil(metres / CELL - 1e-9);
  return validateStructuredConstruction({ ...source,
    nodes: source.nodes.map(node => ({ ...node, y: node.y + lift })),
    chassis: { ...source.chassis, points: source.chassis.points.map(point => ({ ...point, y: point.y + lift })),
      thicknessMm: 25, gearScale: 1.1, axles: [-48, -16, 16, 48] },
    components: [
      { id: 'engine', kind: 'engine', pose: { x: 55, y: above(.37), angle: 0 } },
      { id: 'fuel', kind: 'fuel', pose: { x: 32, y: above(.42), angle: 0 } },
      { id: 'command', kind: 'command', pose: { x: 57, y: above(.97), angle: 0 } },
      ...(hopper ? [{ id: 'load', kind: 'hopper', sizeScale: 1.5, pose: { x: -16, y: above(.72), angle: 0 } }] : []),
      { id: 'tool', kind: 'excavator', sizeScale: 1, pose: { x: -43, y: floor + (2.2 + .005 + MODULES.excavator.height / 2) / CELL, angle: 0 } },
    ] });
}

function highToolField(t, hopper) {
  let base;
  const room = new SharedRoom({ starter: false, build: false, fog: false, stock: bill(1e9, 1e9, 1e9, 1e9), base: () => base });
  t.after(() => room.world.dispose());
  const world = room.world, site = room.deposits.filter(site => site.material === 'ferro' &&
    depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 &&
    depositsNear(room.deposits, site.x + 250, BASE_RADIUS + LOAD_REACH).length === 0 &&
    Math.abs(world.terrain.height(site.x + 5) - world.terrain.height(site.x - 5)) < .05)
    .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
  assert(site); base = site.x + 250;
  const joined = room.join('Oficina'), owner = room.players.get(joined.playerId), id = room.publish(owner.id, highToolSource(hopper), { facing: 1 }).actor.id,
    faction = room.faction(owner), brought = () => faction.stock[REFINED.ferro] + faction.yard.ferro;
  assert.equal(world.actor(id).blueprint.mechanicalAdmission, true);
  return { room, world, site, owner, id, base, brought, reserve: room.left(site) };
}

test('a workshop truck with an unreachable roof tool still picks up and delivers a real 500 kg pile through its low hopper', { timeout: 60000 }, t => {
  const f = highToolField(t, true), { room, world, site, owner, id, brought, reserve } = f, before = brought();
  room.extracted.set(site.id, 500); // only initial pile fixture; all cargo changes and movement below are native
  room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
  let carried = 0, maximum = 0, collectedWithoutExtraction = false, delivered = false;
  for (let step = 0; step < 240 * 60; step++) {
    room.step();
    const cargo = carriedBy(room.pieces(id)).carried.ferro;
    maximum = Math.max(maximum, cargo);
    if (cargo > 0 && !collectedWithoutExtraction) {
      const work = collectionWork(world, id)[0];
      collectedWithoutExtraction = !canCollect(work, site, world.terrain) && work.layout.length === 4.2;
    }
    if (carried > 0 && cargo === 0 && Math.abs(world.actor(id).vehicle.x - f.base) <= BASE_RADIUS) { delivered = true; break; }
    carried = cargo;
  }
  t.diagnostic(JSON.stringify({ elapsed: world.time, maximum, gained: brought() - before,
    phase: owner.squad.units.get(id).haul?.phase, reserve: room.left(site) }));
  assert(delivered && collectedWithoutExtraction, 'a real round trip uses the independently reachable hopper');
  assert(Math.abs(maximum - 500) < 1e-5); assert(Math.abs(brought() - before - 500) < 1e-5);
  assert.equal(room.left(site), reserve, 'a tool that cannot reach never mines the geological reserve');
  assert.equal(room.extracted.get(site.id) ?? 0, 0); assert.equal(room.faults.size, 0);
});

test('a workshop extractor drives to its real work point and reports an unreachable stroke after eight seconds instead of remaining idle outbound', { timeout: 60000 }, t => {
  const { room, world, site, owner, id, reserve } = highToolField(t, false);
  room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: site.id });
  let approached = false, parkedAt = null;
  for (let step = 0; step < 120 * 60 && owner.squad.units.get(id).haul; step++) {
    room.step();
    const unit = owner.squad.units.get(id), vehicle = world.actor(id).vehicle;
    approached ||= Boolean(unit.move && unit.haul?.phase === 'out');
    // Parked at the vein: a turn about on the way stops it too, and has it work out its place there again.
    if (parkedAt === null && unit.haul?.phase === 'out' && !unit.move && !unit.haul.waiting && Math.abs(vehicle.vx) < 1 &&
      Math.abs(vehicle.x - site.x) < LOAD_REACH) parkedAt = world.time;
  }
  const unit = owner.squad.units.get(id), work = collectionWork(world, id)[0];
  t.diagnostic(JSON.stringify({ elapsed: world.time, parkedAt, waited: world.time - parkedAt, reason: unit.reason,
    distance: Math.abs(world.actor(id).vehicle.x - site.x), armLength: work.layout.length }));
  assert(approached && parkedAt !== null, 'the native vehicle really arrives without relocating or resizing it');
  assert.equal(unit.haul, null); assert.equal(unit.reason, 'no-loader');
  assert(world.time - parkedAt >= 7.5 && world.time - parkedAt <= 10, 'the idle wait is bounded by eight seconds plus the decision cadence');
  assert.equal(work.layout.length, 4.2); assert.equal(canCollect(work, site, world.terrain), false);
  assert.equal(room.left(site), reserve); assert.equal(room.extracted.get(site.id) ?? 0, 0);
  assert.equal(room.faults.size, 0);
});
