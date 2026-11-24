import { FULL_INDUSTRY } from '../src/industry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { createStructuredConstruction, planStructuredComponent, validateStructuredConstruction, compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionCost, pieceCostBreakdown, ammunitionCost } from '../src/construction-cost.ts';
import { cargoRoom, cargoUnitVolume, reserveState, CARGO, FUEL_SHARE } from '../src/component-volume.ts';
import { METALS, MODULES, takesMetal } from '../src/materials.ts';
import { blueprintMass } from '../src/mass-properties.ts';
import { chapters } from '../server/fog.ts';
import { FrameLedger, FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { workStep } from '../src/work-arm.ts';
import { workArea, collectionWork, canCollect } from '../src/loading-area.ts';
import { withChassisThickness } from '../src/chassis-editing.ts';
import { Squad, DEPOT_INSET, HAUL_SCARE, MARK_SCARE, SCARE_HOLD, SCARE_WINDOW } from '../src/squad.ts';
import { depositsNear, RECOVERY_SECONDS, RESERVE_STEP } from '../src/deposits.ts';
import { STARTING_STOCK, DAMAGED_SHARE, BASE_RADIUS, CALM_SECONDS, SALVAGE_REACH, LOAD_REACH, extractRate, TRANSFER_RATE, SUPPLY_REACH, REFINE_RATE, REFINED, YIELD, RAW_IDS,
  bill, billSum, billText, load, loadTotal, supplied, refined, shortText, designBill, designRoom, roomText, stockOf, appraise, fieldParts, carriedBy, dumpOf, refine, sharePile } from '../src/economy.ts';
import { unitServices, dismantleQuote } from '../src/faction-ui.ts';
import { CELL, cellOf } from '../src/grid.ts';
import { pilotDecision } from './helpers/pilot-fixture.ts';

// A plain truck: a box of thin steel with an engine, a tank, a command post and a camera on its roof, on an authored
// four-axle wheeled frame with a 20 mm section for the full hopper, and what it
// carries in. Ore goes in a hopper and petroleum in a cistern, and supplies in a supply piece: a box with none of them
// carries nothing. The box hangs where the suspension of that frame reaches its wheels, its parts written over its deck.
// Places in cells of the grid (grid.ts).
const fitted = (design, parts) => parts.reduce((made, part) => planStructuredComponent(made, part).construction, design);
const compiled = design => compileStructuredConstruction(typeof design === 'string' ? createStructuredTemplate(design) : design);
const hull = name => {
  const made = createStructuredConstruction({ name, length: 7, height: 2.2, frontInset: .4, rearInset: .1, thicknessMm: 10, chassis: 'wheeled' });
  return withChassisThickness({ ...made, chassis: { ...made.chassis, axles: [-48, -16, 16, 48] } }, 20);
};
const DECK = hull('').chassis.points[0].y;
const box = (name, sighted = true) => {
  const made = fitted(hull(name), [
    { id: 'engine', kind: 'engine', sizeScale: 1, pose: { x: 55, y: DECK + 8, angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: 1, pose: { x: 32, y: DECK + 9, angle: 0 } },
    { id: 'command', kind: 'command', sizeScale: 1, pose: { x: 57, y: DECK + 20, angle: 0 } },
    ...sighted ? [{ id: 'camera', kind: 'sensor', sensorMode: 'visual', pose: { x: 3, y: DECK + 47, angle: 0 } }] : []]);
  return sighted ? supportedOnRoof(made, 'camera') : made;
};
const inside = (kind, x, y, sizeScale) => ({ id: kind, kind, sizeScale, pose: { x, y: DECK + y, angle: 0 } });
// The big pieces have the room one of 150 % had when its size made it deeper across the body as well, 1.5³ that of one of
// 100 %: as long and tall as the square root of that, as deep as their kind (component-volume.ts `componentDepth`).
const GROWN = 1.5 ** 1.5;
const bare = box('Caixa'), truck = fitted(box('Caminhão'), [inside('hopper', -16, 19, GROWN)]), tanker = fitted(box('Cisterna'), [inside('cistern', -19, 19, GROWN)]),
  // The truck with no camera: its command post is shut in its hull, and it sees nothing.
  blind = fitted(box('Caminhão cego', false), [inside('hopper', -16, 19, GROWN)]),
  small = fitted(box('Caminhão pequeno'), [inside('hopper', -28, 8, .75)]),
  both = fitted(box('Misto'), [inside('hopper', -40, 10, 1), inside('cistern', -8, 10, 1)]),
  // Supply vehicles: one with a big supply piece, one with a small one, and a hauler that also takes supplies along.
  crates = fitted(box('Suprimentos'), [inside('supply', -17, 19, GROWN)]), kit = fitted(box('Suprimentos pequeno'), [inside('supply', -25, 10, 1)]),
  digger = fitted(box('Caçamba e suprimentos'), [inside('hopper', -40, 10, 1), inside('supply', -7, 10, 1)]),
  // The big one with a rack of rounds: a supply vehicle that has something of its own to be short of.
  racked = fitted(crates, [{ id: 'ammo', kind: 'ammo', sizeScale: .6, ammoPreset: 'mk44', pose: { x: 25, y: DECK + 21, angle: 0 } }]);
// The same truck under a roof of titanium and behind a front of ceramic, its camera stood again on the thicker roof:
// the stand of the thinner one would stand in it.
const plated = supportedOnRoof({ ...truck, name: 'Caminhão blindado', nodes: truck.nodes.filter(node => !node.id.startsWith('stand-camera-')),
  plates: truck.plates.filter(plate => plate.id !== 'stand:camera').map(plate =>
    plate.id === 'hull:roof' ? { ...plate, material: 'titanium', thicknessMm: 20 } : plate.id === 'hull:front' ? { ...plate, material: 'ceramic', thicknessMm: 30 } : plate) }, 'camera');
// Transport containers do not extract. Mining fixtures install a real, independently sized
// surface tool near the end of the roof, with enough fixed arm reach to clear this hull: on the cell clear of the roof.
const extracting = (design, kind = 'excavator') => supportedOnRoof(fitted(design, [{ id: kind, kind, sizeScale: 1.25,
  pose: { x: cellOf(-2.125), y: DECK + Math.ceil((2.21 + MODULES[kind].height * 1.25 / 2) / CELL - 1e-9), angle: 0 } }]), kind);
const miningTruck = extracting(truck), miningTanker = extracting(tanker, 'drill'), blindMiner = extracting(blind), miningDigger = extracting(digger);
// Internal equipment is fixed by the rooted closed hull. External roof equipment keeps its authored pose and
// receives real, priced steel stock; the same fixture is used for pricing, publication and pile sharing.
function supportedOnRoof(design, id) {
  const made = structuredClone(design), geometry = compiled(design), { origin } = geometry.frame,
    part = geometry.modules.find(piece => piece.id === id), roof = geometry.plates.find(piece => piece.id === 'hull:roof');
  assert(part && roof, `${id}: the unchanged equipment and its actual roof must exist`);
  const bottom = roof.y + roof.thicknessMm / 2000, top = part.y - part.height / 2,
    x = part.x, gap = top - bottom, stock = .08, thickness = .005;
  assert(gap >= thickness, `${id}: real stock must fit between the two unchanged faces`);
  let a = { x, y: bottom }, b = { x, y: top };
  if (gap < stock) {
    // Tilt the minimum 8 cm stock rather than thicken it into either body.
    const ratio = thickness / stock, dx = (gap * ratio + Math.sqrt((1 + ratio * ratio) * stock * stock - gap * gap)) / (1 + ratio * ratio),
      half = thickness * dx / stock / 2;
    a = { x: x - dx / 2, y: bottom + half }; b = { x: x + dx / 2, y: top - half };
  }
  made.nodes.push(...[a, b].map((point, i) => ({ id: `stand-${id}-${i}`, x: (point.x - origin.x) / CELL, y: (point.y - origin.y) / CELL })));
  made.plates.push({ id: `stand:${id}`, a: `stand-${id}-0`, b: `stand-${id}-1`, material: 'steel', thicknessMm: thickness * 1000 });
  return validateStructuredConstruction(made);
}
// What the hopper of the truck has room for, in cubic metres, and that much iron ore, in kilograms.
const ROOM = cargoRoom(compiled(truck).modules.find(m => m.kind === 'hopper')), FULL = ROOM * CARGO.ferro.density, RICH = bill(1e9, 1e9, 1e9, 1e9);
// What the tools of a design take out of the ground in a second: each its rate by its size, at the share of their pace its
// engines give them (the core's `work`). Its 180 kW engine gives a tool of 125 % less than the tool asks.
function paceOf(design) {
  const { modules } = compiled(design), tools = modules.filter(m => m.kind === 'excavator' || m.kind === 'drill'),
    asked = tools.reduce((sum, m) => sum + m.workKw, 0), given = modules.filter(m => m.kind === 'engine').reduce((sum, m) => sum + m.powerKw, 0);
  return tools.reduce((sum, m) => sum + extractRate(m), 0) * Math.min(1, given / asked);
}
const DIG = paceOf(miningTruck);
// What the veins of a room gain back by themselves from now on (room.ts `replenish`), counted site by site: a vein dug
// holds what it held less what was dug of it, plus that.
function regrowth(room) {
  const back = new Map(), replenish = room.replenish.bind(room);
  room.replenish = seconds => {
    const was = [...room.veins];
    replenish(seconds);
    for (const [id, left] of was) back.set(id, (back.get(id) ?? 0) + room.left(room.sites.get(id)) - left);
  };
  return site => back.get(site.id) ?? 0;
}

// A field by a deposit: the one of a material nearest the middle of the world that has a clear place
// for a base `gap` metres from it, where the first faction is founded. The others are founded at
// `others`, in metres from the deposit. Every site holds a vein, as on any field. What a test does there comes with it.
function site(t, { material = 'ferro', gap = 200, others = [], stock = RICH } = {}, ...names) {
  const bases = [], room = new SharedRoom({ industry: FULL_INDUSTRY, stock, starter: false, build: false, base: i => bases[Math.min(i, bases.length - 1)] }), world = room.world, ground = world.terrain;
  t.after(() => world.dispose());
  const alone = (x, reach, but) => depositsNear(room.deposits, x, reach).every(d => d === but),
    deposit = room.deposits.filter(d => d.material === material && alone(d.x, 2 * LOAD_REACH, d) && alone(d.x + gap, BASE_RADIUS + LOAD_REACH, d))
      .sort((a, b) => Math.abs(a.x - ground.center) - Math.abs(b.x - ground.center))[0];
  bases.push(Math.round(deposit.x + gap), ...others.map(offset => Math.round(deposit.x + offset)));
  const players = names.map(name => room.join(name)), run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); },
    // Steps the field until something is so, for so many seconds at most.
    until = (done, seconds) => { for (let i = 0; i < seconds * 60 && !done(); i++) room.step(); return done(); },
    part = (id, kind) => room.world.modules.find(m => m.actorId === id && m.kind === kind),
    set = (module, state) => world.game().call({ op: 'setPartState', owner: world.game().handle(module), state });
  return { room, world, ground, deposit, players, run, until, base: bases[0], part, set,
    // Supply vehicles standing still in their base, out of combat, as the field fills their supply pieces from the stocks by itself.
    filled: (...ids) => assert(until(() => ids.every(id => loadTotal(carriedBy(room.crates(id)).carried) > 0), 5), 'filled up in its base'),
    // A construction published for a player: a supply vehicle out of automatic, as the player takes it where it serves.
    publish: (player, design, options) => { room.players.get(player.playerId).builtAt = -Infinity;
      const id = room.publish(player.playerId, typeof design === 'string' ? createStructuredTemplate(design) : design, options).actor.id;
      if (room.records.get(id).auto) room.command(player.playerId, { type: 'auto', actorId: id, on: false });
      return id; },
    send: (player, type, data = {}) => room.command(player.playerId, { type, ...data }),
    order: (player, order, data = {}) => room.command(player.playerId, { type: 'squad', order, ...data }),
    view: player => room.factionView(player.playerId), unit: (player, id) => room.factionView(player.playerId).units.find(u => u.id === id),
    squad: (player, id) => room.squadView(player.playerId).units.find(u => u.id === id),
    faction: player => room.faction(room.players.get(player.playerId)), stock: player => room.faction(room.players.get(player.playerId)).stock,
    yard: player => room.faction(room.players.get(player.playerId)).yard, record: id => room.records.get(id),
    x: id => world.actor(id).vehicle.x, speed: id => Math.hypot(world.actor(id).vehicle.vx, world.actor(id).vehicle.vy),
    mass: id => room.world.actor(id).vehicle.mass,
    // What a construction carries, as its hoppers and its cisterns have it, what its supply pieces do — as a load and by
    // stock —, and a load put into one of them by hand.
    cargo: id => carriedBy(room.pieces(id)).carried, held: id => carriedBy(room.crates(id)).carried, aboard: id => supplied(carriedBy(room.crates(id)).carried),
    stowed: (id, kind, cargo) => set(part(id, kind), { cargo }),
    // Stands a construction somewhere else, at rest on its ground.
    put: (id, x) => { const v = world.actor(id).vehicle;
      world.command('setVehicleState', { actorId: id, state: { x, y: v.y - ground.height(v.x) + ground.height(x), vx: 0, vy: 0 } }); run(1.5); },
    // A place this far from the deposit, or the nearest beyond it, with no deposit to load from.
    clear: offset => { let x = deposit.x + offset; while (!alone(x, 2 * LOAD_REACH)) x += Math.sign(offset) * LOAD_REACH; return x; } };
}
const near = (a, b, slack = 1e-6) => RAW_IDS.every(id => Math.abs(a[id] - b[id]) <= slack);

test('a scarce public pile is shared equally by vehicles, with full containers releasing their unused share', () => {
  assert.deepEqual(sharePile(15, [25, 25]), [7.5, 7.5]);
  assert.deepEqual(sharePile(10, [1, 9, 9]), [1, 4.5, 4.5]);
  assert.deepEqual(sharePile(10, [9, 1, 9]), [4.5, 1, 4.5], 'actor order does not choose who gets a scarce pile');
  assert.deepEqual(sharePile(100, [2, 3, 4]), [2, 3, 4], 'nothing loads beyond its room or transfer rate');
  assert.deepEqual(sharePile(0, [2, 3]), [0, 0]);
  assert.deepEqual(sharePile(10, []), []);
});

test('a design carries what its hoppers, its cisterns and its supply pieces have room for, and nothing without them', () => {
  const room = design => designRoom(compiled(design)), hopper = compiled(truck).modules.find(m => m.kind === 'hopper'), cistern = compiled(tanker).modules.find(m => m.kind === 'cistern'),
    supply = compiled(crates).modules.find(m => m.kind === 'supply');
  assert.deepEqual(room(bare), { solid: 0, liquid: 0, supplies: 0 }, 'no piece of it is a hold: a box with an engine carries nothing');
  assert.equal(roomText(compiled(bare)), '');
  // A piece carries in a share of its volume: four fifths of a hopper, a little less of a cistern, seven tenths of a supply piece.
  assert(Math.abs(ROOM - 1.6 * .9 * 1.2 * 1.5 ** 3 * .8) < 1e-9); assert.equal(hopper.capacityM3, ROOM);
  assert.deepEqual(room(truck), { solid: ROOM, liquid: 0, supplies: 0 });
  assert(Math.abs(room(tanker).liquid - 1.4 * .9 * 1.1 * 1.5 ** 3 * .78 * 1000) < 1e-6); assert.equal(room(tanker).solid, 0);
  assert.equal(cargoRoom(cistern) * 1000, room(tanker).liquid);
  assert(Math.abs(room(crates).supplies - 1.5 * .9 * 1.1 * 1.5 ** 3 * .7) < 1e-9 && room(crates).solid === 0 && room(crates).liquid === 0); assert.equal(cargoRoom(supply), room(crates).supplies);
  const mixed = room(both); assert(Math.abs(mixed.solid - 1.6 * .9 * 1.2 * .8) < 1e-9 && Math.abs(mixed.liquid - 1.4 * .9 * 1.1 * .78 * 1000) < 1e-6);
  assert.equal(roomText(compiled(truck)), '4,7 m³ de minério'); assert.equal(roomText(compiled(tanker)), '3.648 L de petróleo');
  assert.equal(roomText(compiled(both)), '1,4 m³ de minério · 1.081 L de petróleo'); assert.equal(roomText(compiled(crates)), '3,5 m³ de suprimentos');
  assert.equal(roomText(compiled(digger)), '1,4 m³ de minério · 1 m³ de suprimentos');
  const made = compiled(truck); assert.equal(designRoom(made), designRoom(made), 'a design is measured once'); assert(Object.isFrozen(designRoom(made)));
  // The pieces weigh and cost by their volume, empty: what they carry is weighed on the field.
  assert(Math.abs(hopper.physicalMass - 380 * 1.5 ** 3) < 1e-6 && Math.abs(cistern.physicalMass - 260 * 1.5 ** 3) < 1e-6 && Math.abs(supply.physicalMass - 300 * 1.5 ** 3) < 1e-6);
  assert.equal(constructionCost(compiled(truck)).total - constructionCost(compiled(bare)).total, Math.ceil(900 * 1.5 ** 3 - 1e-9));
  assert.equal(constructionCost(compiled(tanker)).total - constructionCost(compiled(bare)).total, Math.ceil(1100 * 1.5 ** 3 - 1e-9));
  assert.equal(constructionCost(compiled(crates)).total - constructionCost(compiled(bare)).total, Math.ceil(1200 * 1.5 ** 3 - 1e-9));
  // Of the designs the workshop starts from, haulers carry cargo, and the supplier and the builder carry supplies: the paver
  // carries what it lays in the hopper of its paver alone.
  const rooms = Object.fromEntries(CONSTRUCTION_TEMPLATES.map(({ id }) => [id, room(id)]));
  for (const [id, { solid, liquid, supplies }] of Object.entries(rooms))
    assert.deepEqual([solid > 0, liquid > 0, supplies > 0], [['truck', 'mining-truck'].includes(id), id === 'tanker', ['supply', 'construction-truck', 'air-supply'].includes(id)], `${id} takes ${solid} m³, ${liquid} L and ${supplies} m³ of supplies`);
  assert(rooms.truck.solid > 4 && rooms.tanker.liquid > 4000 && rooms.supply.supplies > 4);
});

test('a design is paid from the stock of what each piece is made of, its fuel from the fuel, and its bill is its price', t => {
  const design = compiled(plated), cost = designBill(design), worth = plate => Object.values(pieceCostBreakdown(plate)).reduce((sum, value) => sum + value, 0),
    plate = id => design.plates.find(p => p.id === id), tank = design.modules.find(m => m.kind === 'fuel'), fuel = pieceCostBreakdown(tank).supplies;
  for (const [material, stock] of Object.entries({ steel: 'ferro', hha: 'ferro', concrete: 'silica', aluminum: 'ligas', titanium: 'ligas',
    ceramic: 'silica', fiberglass: 'silica', glass: 'silica' })) assert.equal(stockOf({ material }), stock, material);
  for (const module of design.modules) assert.equal(stockOf(module), 'ferro', `a ${module.kind} is iron`);
  assert.deepEqual(['chassis:top-0', 'hull:rear', 'hull:roof', 'hull:front'].map(id => stockOf(plate(id))), ['ferro', 'ferro', 'ligas', 'silica']);
  assert.deepEqual([cost.ligas, cost.silica], [worth(plate('hull:roof')), worth(plate('hull:front'))]); assert(cost.ligas > 0 && cost.silica > 0 && cost.ferro > 0);
  // The fuel in its tank is paid by the litre, the part of a litre as one; the credits of the bill and the price of that fuel are the price of the design.
  assert.equal(cost.combustivel, Math.ceil(reserveState(tank).fuelLitres)); assert(fuel > 0);
  assert.equal(cost.ferro + cost.ligas + cost.silica + fuel, constructionCost(design).total, 'to the credit');
  assert.equal(designBill(design), cost); assert(Object.isFrozen(cost));
  assert.deepEqual(designBill(compiled(truck)), bill(constructionCost(compiled(truck)).total - fuel, 0, 0, cost.combustivel), 'a truck of steel is iron and fuel alone');
  // Every design the workshop starts from is iron, the silica of the glass of its vision block or of the concrete of
  // its walls, and fuel, except the fixed ones have no tank but the oil well, whose drill burns it. A new faction can
  // field any but the heavy tank: either hauler, and both together.
  const stocked = Object.fromEntries(CONSTRUCTION_TEMPLATES.map(({ id }) => [id, designBill(compiled(id))])),
    pays = price => ['ferro', 'ligas', 'silica', 'combustivel'].every(stock => price[stock] <= STARTING_STOCK[stock]);
  for (const [id, price] of Object.entries(stocked)) {
    if (compiled(id).chassis?.model === 'aircraft') assert(price.ligas > 0, id + ': turbines use alloys');
    else assert.equal(price.ligas, 0);
    if (CONSTRUCTION_TEMPLATES.find(template => template.id === id).type === 'structure' && !['oil-well', 'mining-site'].includes(id)) assert.equal(price.combustivel, 0, id);
    else assert(price.combustivel > 0 && price.combustivel <= STARTING_STOCK.combustivel, id);
  }
  // Concrete is paid in two stocks, what it is made of: 0.8 of Sílica a kilogram for its sand, gravel and cement, and
  // the rest of its price, 0.06, in Ferro for its bar.
  for (const id of ['guard-post', 'bunker', 'oil-well']) {
    const design = compiled(id), walls = design.plates.filter(piece => piece.material === 'concrete'),
      fuelCredits = design.modules.filter(piece => piece.kind === 'fuel').reduce((sum, piece) => sum + pieceCostBreakdown(piece).supplies, 0);
    assert(walls.length > 0 && design.plates.every(piece => piece.material !== 'glass'), `${id} is walled in concrete, with no glass`);
    assert.equal(stocked[id].silica, walls.reduce((sum, piece) => sum + Math.ceil(piece.physicalMass * .8 - 1e-9), 0), `${id}: its concrete in Sílica`);
    assert(walls.every(piece => Math.abs(worth(piece) - piece.physicalMass * .86) <= 1), 'a kilogram of concrete costs 0.86 cr in all');
    assert.equal(stocked[id].ferro + stocked[id].silica + fuelCredits, constructionCost(design).total, `${id}: the rest of its price in Ferro`);
  }
  assert.deepEqual(Object.keys(stocked).filter(id => !pays(stocked[id])), ['heavy', 'air-supply', 'bunker']);
  assert(pays(billSum(stocked.truck, stocked.tanker)));
  for (const id of ['truck', 'tanker']) {
    const design = compiled(id), glass = design.plates.filter(piece => piece.material === 'glass').reduce((sum, piece) => sum + worth(piece), 0),
      tanks = design.modules.filter(piece => piece.kind === 'fuel'), fuelCredits = tanks.reduce((sum, piece) => sum + pieceCostBreakdown(piece).supplies, 0),
      litres = tanks.reduce((sum, piece) => sum + reserveState(piece).fuelLitres, 0);
    assert(glass > 0 && fuelCredits > 0, `${id} has a vision block and a filled tank`);
    assert.deepEqual(stocked[id], bill(constructionCost(design).total - glass - fuelCredits, 0, glass, Math.ceil(litres)), `${id}: every compiled credit is paid once from the correct stock`);
  }

  // A faction with none of the two materials that have to be fetched.
  const bare = { ...STARTING_STOCK, ligas: 0, silica: 0 }, { room, players: [alice], publish, send, view, unit, stock } = site(t, { stock: bare }, 'Alice');
  assert.throws(() => publish(alice, plated), { message: shortText(bare, cost, 'fabricar') });
  assert.throws(() => publish(alice, plated), /Faltam Ligas e Sílica para fabricar: Ligas custa [\d.]+ e a facção tem 0; Sílica custa [\d.]+ e a facção tem 0\.$/);
  Object.assign(stock(alice), bill(1e6, cost.ligas, cost.silica - 1, 1e6));
  assert.throws(() => publish(alice, plated), /Falta Sílica para fabricar: custa [\d.]+ e a facção tem [\d.]+\.$/, 'no amount of iron buys ceramic');
  Object.assign(stock(alice), bill(1e6, 1e6, 1e6, cost.combustivel - 1));
  assert.throws(() => publish(alice, plated), /Falta Combustível para fabricar: custa 203 L e a facção tem 202 L\.$/, 'nor fuel');
  assert.equal(room.world.actors.length, 0);
  Object.assign(stock(alice), { ...cost });
  const id = publish(alice, plated);
  assert.deepEqual(view(alice).stock, bill()); assert.deepEqual([unit(alice, id).built, unit(alice, id).value], [{ ...cost }, { ...cost }]);
  // Half a roof of titanium is mended with alloys, and is worth alloys less.
  const actor = room.world.actor(id), parts = fieldParts(room.world), roof = `${id}:${actor.revision}:hull:roof`;
  assert(parts.has(roof)); parts.set(roof, { ...parts.get(roof), integrity: .5 });
  const hurt = appraise(actor, parts);
  assert.deepEqual(hurt.repair, bill(0, Math.ceil(cost.ligas / 2), 0));
  assert.deepEqual(hurt.salvage, bill(cost.ferro, cost.ligas - Math.ceil(cost.ligas * (1 - .5 * DAMAGED_SHARE)), cost.silica, cost.combustivel));
  assert.deepEqual(room.factionView(alice.playerId, parts).units[0].repair, hurt.repair, 'and the player is told so');
  // Dismantled whole, it gives every stock back what it took.
  assert.deepEqual(send(alice, 'remove', { actorId: id }).refund, { ...cost }); assert.deepEqual(view(alice).stock, { ...cost });
  // Replacing pays the new design less what the old one gives back, stock by stock: no iron given back buys alloys.
  const iron = designBill(compiled(truck)).ferro, swap = bill(cost.ferro - iron, cost.ligas, cost.silica);
  Object.assign(stock(alice), bill(iron, 0, 0, cost.combustivel)); const plain = publish(alice, truck);
  Object.assign(stock(alice), bill(0, cost.ligas - 1, cost.silica));
  room.players.get(alice.playerId).builtAt = -Infinity;
  assert.throws(() => send(alice, 'replace', { actorId: plain, blueprint: plated }), /Falta Ligas para substituir: custa /);
  stock(alice).ligas += 1;
  assert.deepEqual(send(alice, 'replace', { actorId: plain, blueprint: plated }).cost, swap, 'the fuel of the one pays the fuel of the other'); assert(swap.ferro < 0, 'the steel plates were dearer than what replaced them is in iron');
  assert.deepEqual(view(alice).stock, bill(-swap.ferro));
});

test('the pieces of a truck of aluminium, titanium or glass fibre weigh less, are paid from its stock, and the truck carries as much', () => {
  const made = (design, metal) => compiled({ ...design, components: design.components.map(part => takesMetal(part, metal) ? { ...part, metal } : part) }),
    mass = design => blueprintMass(design), priced = design => constructionCost(design).total,
    // What its own stock pays of a piece: neither what it holds nor what its material does not change (`kept`).
    worth = piece => { const groups = pieceCostBreakdown(piece); return Object.values(groups).reduce((sum, value) => sum + value, 0) - (groups.supplies || 0) - (groups.kept || 0); },
    // Of the camera and of the command post only the housing, half of what they weigh, is of the material.
    housing = { sensor: .5, command: .5 };
  for (const design of [truck, tanker, crates]) for (const [metal, massShare, stock] of [['aluminum', .65, 'ligas'], ['titanium', .6, 'ligas'], ['fiberglass', .5, 'silica']]) {
    const steel = compiled(design), of = made(design, metal), share = METALS[metal], cost = designBill(of), changed = [];
    for (const module of of.modules) {
      const was = steel.modules.find(m => m.id === module.id), own = module.metal === metal,
        held = module.kind === 'fuel' ? reserveState(module).fuelLitres * .835 : 0;
      if (own) changed.push(module.kind);
      assert.equal(stockOf(module), own ? stock : 'ferro', module.kind);
      // Each of those pieces weighs and stands its share of the steel one; the fuel in the tank is what it was.
      const housed = housing[module.kind] ?? 1;
      assert(Math.abs(module.physicalMass - held - (was.physicalMass - held) * (own ? 1 - housed + housed * massShare : 1)) < 1e-6, `${module.kind} of ${metal}`);
      assert(Math.abs(module.maxHealth - was.maxHealth * (own ? share.health : 1)) < 1e-9);
    }
    // Every piece but the camera takes a metal, and glass fibre only the tank, a cistern, crates and the camera. The wheels
    // come with the chassis, of steel.
    const cargo = design === truck ? 'hopper' : design === tanker ? 'cistern' : 'supply';
    assert.deepEqual(changed.sort(), (metal === 'fiberglass' ? ['fuel', 'sensor', ...cargo === 'hopper' ? [] : [cargo]]
      : ['command', 'engine', 'fuel', cargo]).sort(), `${design.name} of ${metal}`);
    assert.deepEqual(designRoom(of), designRoom(steel), 'it carries as much');
    // Lighter: those pieces are paid from the stock of what they are made of, the rest from iron, and the fuel from the
    // fuel. In steel the engine, the tank and the hopper of the truck weigh 2.2 t, of which aluminium takes 35 % off and
    // titanium 40 % (771 and 881 kg).
    assert(mass(of) < mass(steel) && priced(of) > priced(steel), `${mass(of)} kg against ${mass(steel)} kg`);
    if (design === truck && metal !== 'fiberglass') assert(mass(of) < mass(steel) - 700);
    assert.equal(cost[stock], of.modules.filter(module => module.metal === metal).reduce((sum, module) => sum + worth(module), 0));
    assert.equal(cost.combustivel, designBill(steel).combustivel);
    assert.equal(cost.ferro + cost.ligas + cost.silica + pieceCostBreakdown(of.modules.find(m => m.kind === 'fuel')).supplies, priced(of), 'to the credit');

    const mixed = compiled({ ...design,
      plates: design.plates.map(plate => ['hull:roof', 'hull:front'].includes(plate.id) ? { ...plate, material: metal } : plate),
      components: design.components.map(part => takesMetal(part, metal) ? { ...part, metal } : part) }),
      mixedCost = designBill(mixed), ownPlates = mixed.plates.filter(plate => stockOf(plate) === stock);
    assert(ownPlates.length > 1, 'several armour plates share the stock of the pieces of the same material');
    assert.equal(mixedCost[stock], [...ownPlates, ...mixed.modules.filter(module => stockOf(module) === stock)].reduce((sum, piece) => sum + worth(piece), 0));
    assert.equal(mixedCost.combustivel, cost.combustivel, 'the fuel stays separate from its container and the armour');
    assert.equal(mixedCost.ferro + mixedCost.ligas + mixedCost.silica + pieceCostBreakdown(mixed.modules.find(m => m.kind === 'fuel')).supplies, priced(mixed));
  }
  assert(priced(made(truck, 'titanium')) > priced(made(truck, 'aluminum')));
});

test('the pieces of a truck of plastic weigh and cost the least, are paid from the fuel, a litre for a credit, and the truck carries as much', t => {
  const moulding = design => ({ ...design, components: design.components.map(part => takesMetal(part, 'plastic') ? { ...part, metal: 'plastic' } : part) }),
    made = design => compiled(moulding(design)),
    priced = design => constructionCost(design).total, fuelOf = design => pieceCostBreakdown(design.modules.find(m => m.kind === 'fuel')).supplies,
    worth = piece => { const groups = pieceCostBreakdown(piece); return Object.values(groups).reduce((sum, value) => sum + value, 0) - (groups.supplies || 0) - (groups.kept || 0); };
  for (const design of [truck, tanker, crates]) {
    const steel = compiled(design), of = made(design), cost = designBill(of), was = designBill(steel), changed = [];
    for (const module of of.modules) {
      const before = steel.modules.find(m => m.id === module.id), own = module.metal === 'plastic',
        held = module.kind === 'fuel' ? reserveState(module).fuelLitres * .835 : 0, housed = module.kind === 'sensor' ? .5 : 1;
      if (own) changed.push(module.kind);
      assert.equal(stockOf(module), own ? 'combustivel' : 'ferro', module.kind);
      // Each of those pieces weighs and stands 0.35 of the steel one — of the camera, its case alone —; the fuel in the
      // tank is what it was.
      assert(Math.abs(module.physicalMass - held - (before.physicalMass - held) * (own ? 1 - housed + housed * .35 : 1)) < 1e-6, module.kind);
      assert(Math.abs(module.maxHealth - before.maxHealth * (own ? METALS.plastic.health : 1)) < 1e-9, module.kind);
      if (own) assert(worth(module) < worth(before), `${module.kind}: cheaper than steel`);
    }
    // The camera, the tank, and a cistern or crates; never the hopper, the engine or the command post.
    const cargo = design === truck ? 'hopper' : design === tanker ? 'cistern' : 'supply';
    assert.deepEqual(changed.sort(), ['fuel', 'sensor', ...cargo === 'hopper' ? [] : [cargo]].sort(), design.name);
    assert.deepEqual(designRoom(of), designRoom(steel), 'it carries as much');
    assert(blueprintMass(of) < blueprintMass(steel) && priced(of) < priced(steel), `${blueprintMass(of)} kg, ${priced(of)} cr`);
    // Fuel pays the litres of its tank as before and a litre for each credit of plastic; iron the rest, to the credit.
    const moulded = of.modules.filter(module => module.metal === 'plastic').reduce((sum, module) => sum + worth(module), 0);
    assert(moulded > 0 && cost.combustivel === was.combustivel + moulded, `${cost.combustivel} L for ${was.combustivel} L and ${moulded} cr`);
    assert.deepEqual([cost.ligas, cost.silica], [0, 0]);
    assert.equal(cost.ferro + moulded + fuelOf(of), priced(of), 'to the credit');
  }
  // A faction is refused it for want of fuel, and pays it, mends it and is given it back in fuel.
  const design = moulding(truck), cost = designBill(compiled(design)), { room, players: [alice], publish, send, view, stock } = site(t, { stock: { ...cost, combustivel: cost.combustivel - 1 } }, 'Alice');
  assert.throws(() => publish(alice, design), /Falta Combustível para fabricar: custa [\d.]+ L e a facção tem [\d.]+ L\.$/);
  stock(alice).combustivel += 1;
  const id = publish(alice, design), actor = room.world.actor(id), parts = fieldParts(room.world), tank = `${id}:${actor.revision}:fuel`;
  assert.deepEqual(view(alice).stock, bill());
  const whole = parts.get(tank); parts.set(tank, { ...whole, health: whole.maxHealth / 2 });
  const moulded = worth(compiled(design).modules.find(m => m.kind === 'fuel'));
  assert.deepEqual(appraise(actor, parts).repair, bill(0, 0, 0, Math.ceil(moulded / 2 - 1e-6)), 'half a tank of plastic is mended with fuel');
  assert.deepEqual(send(alice, 'remove', { actorId: id }).refund, { ...cost }); assert.deepEqual(view(alice).stock, { ...cost });
});

test('a real extractor fills its hopper from the public pile, conserves reserve plus pile plus cargo, and weighs only its cargo', t => {
  const { room, deposit, base, players: [alice], publish, put, run, view, unit, part, set, stowed, cargo, mass, order, x, speed, faction } = site(t, {}, 'Alice');
  // The vein of the deposit, as the faction is told of it: known since its base was founded beside it.
  const id = publish(alice, miningTruck), told = () => view(alice).deposits.find(d => d.id === deposit.id), carried = () => cargo(id).ferro,
    pile = () => room.extracted.get(deposit.id) ?? 0, regrown = regrowth(room),
    whole = { id: deposit.id, left: deposit.reserve, stock: 0, at: 0, seen: false, loading: false, extracting: false, active: true };
  assert.deepEqual([unit(alice, id).cargo, unit(alice, id).fill, unit(alice, id).loading, told()], [load(), { solid: 0, liquid: 0, supplies: 0 }, null, whole]);
  assert.equal(room.sites.get(deposit.id), deposit); assert(room.dug(deposit));
  assert.equal(room.left(deposit), deposit.reserve); assert(!room.veins.has(deposit.id), 'a whole vein is not named');
  // A little too far, nothing comes: standing there, the faction has the vein in sight.
  put(id, deposit.x + LOAD_REACH + 2); run(3);
  assert.deepEqual([cargo(id), unit(alice, id).loading, told()], [load(), null, { ...whole, at: null, seen: true }]);
  put(id, deposit.x + LOAD_REACH - 2); run(2);
  assert.deepEqual(cargo(id), load(), 'the old broad radius does not let the scoop mine empty ground beside the deposit');
  const empty = mass(id); put(id, workArea(room.world, id, deposit, LOAD_REACH).goal);
  const before = carried(), from = room.world.time; run(10);
  const loaded = carried() - before, seconds = room.world.time - from, left = room.left(deposit);
  assert(Math.abs(loaded - DIG * seconds) <= DIG * .3, `${loaded.toFixed(0)} units in ${seconds.toFixed(1)} s`);
  assert.deepEqual(cargo(id), load(carried()), 'iron from a deposit of iron'); assert.deepEqual(part(id, 'hopper').cargo, { ferro: carried(), ligas: 0, silica: 0 });
  // The vein comes back as it is dug, at the pace of its reserve: no more than that since the field began.
  assert(regrown(deposit) > 0 && regrown(deposit) <= deposit.reserve * room.world.time / RECOVERY_SECONDS);
  assert(left < deposit.reserve && Math.abs(left + pile() + carried() - deposit.reserve - regrown(deposit)) < 1e-6,
    'reserve, extracted pile and onboard ore conserve every unit, with what came back of the vein');
  // A unit of ore is a kilogram: the construction weighs what it took on, to the step it is weighed by and what came since.
  assert(Math.abs(mass(id) - empty - carried()) <= 20 + DIG / 10, `it weighs ${(mass(id) - empty).toFixed(0)} kg more for ${carried().toFixed(0)} kg of ore`);
  // The player is told in steps: a truck that loads does not change the telling many times a second.
  const shown = unit(alice, id);
  assert.equal(shown.loading, deposit.id); assert.equal(shown.cargo.ferro % 250, 0); assert(carried() - shown.cargo.ferro >= 0 && carried() - shown.cargo.ferro < 250);
  assert(Math.abs(shown.fill.solid - shown.cargo.ferro / FULL) < 1e-9 && shown.fill.liquid === 0);
  assert.deepEqual(told(), { ...whole, at: null, seen: true, loading: true, extracting: true,
    left: Math.floor(left / 1000) * 1000, stock: Math.ceil(pile() / 250) * 250 });
  // For as long as it takes to dig a tonne.
  const tellings = new Set(), amounts = new Set();
  for (let i = 0; i < Math.round(1000 / DIG * 60); i++) { room.step(); tellings.add(JSON.stringify([unit(alice, id).cargo, unit(alice, id).fill, unit(alice, id).loading, view(alice).deposits])); amounts.add(carried()); }
  assert(amounts.size > 100 && tellings.size <= 8, `${amounts.size} loads were told as ${tellings.size}`);
  // A hit puts it in combat: nothing is loaded until it is calm again.
  const held = carried(); set(part(id, 'engine'), { health: part(id, 'engine').maxHealth - 1 }); run(CALM_SECONDS - 1);
  assert.deepEqual([carried(), unit(alice, id).calm, unit(alice, id).loading, told().loading], [held, false, null, false]);
  run(3); assert(carried() > held, 'calm, it goes on');
  // It takes what its hopper has room for and no more, and a full one is told exactly.
  stowed(id, 'hopper', { ferro: FULL - 120 }); run(4);
  const spent = room.left(deposit), heaped = pile(), grown = regrown(deposit);
  assert(Math.abs(carried() - FULL) < 1e-6); assert.deepEqual([unit(alice, id).cargo, unit(alice, id).fill, unit(alice, id).loading], [load(Math.round(FULL)), { solid: 1, liquid: 0, supplies: 0 }, null]);
  assert(Math.abs(mass(id) - empty - FULL) <= 20, 'eleven tonnes of ore on a truck of six');
  assert.equal(unit(alice, id).extracting, deposit.id, 'a full hopper does not turn its independent extractor off');
  run(2);
  assert(Math.abs(spent + regrown(deposit) - grown - room.left(deposit) - (pile() - heaped)) < 1e-6 && pile() > heaped,
    'output that cannot fit stays at the site; it never returns to the vein');
  assert(Math.abs(carried() - FULL) < 1e-6, 'a pile on the ground adds no cargo to a full hopper');
  // A lighter ore beside the iron fills by volume: with half the room taken, the other half takes that much of it.
  stowed(id, 'hopper', { ferro: FULL / 2, ligas: 1e9 }); run(.1);
  assert(near(cargo(id), load(FULL / 2, ROOM / 2 * CARGO.ligas.density), 1e-6));
  // Driving past loads nothing.
  stowed(id, 'hopper', {}); put(id, deposit.x + LOAD_REACH + 70);
  const beforeDriving = room.left(deposit), grownBefore = regrown(deposit), waiting = pile();
  order(alice, 'control', { id: null }); order(alice, 'move', { ids: [id], x: deposit.x - LOAD_REACH - 70 });
  let through = false;
  for (let i = 0; i < 60 * 60 && room.squadView(alice.playerId).units[0].move; i++) {
    room.step(); if (Math.abs(x(id) - deposit.x) < LOAD_REACH - 5) { through = true; assert(speed(id) > 1, 'it did not stop there'); }
  }
  assert(through && x(id) < deposit.x - LOAD_REACH, 'it drove through the diggings'); run(1); assert.deepEqual(cargo(id), load());
  assert(Math.abs(mass(id) - empty) <= 20, 'and weighs what it did before it carried anything, but for the fuel it burnt');
  // What was taken is not put back: the vein only comes back by itself. Out of its sight — farther than its camera
  // reaches — the faction goes on knowing the vein as it last saw it, not as it comes back.
  put(id, deposit.x - 3000); run(1); const last = told(), saw = faction(alice).veins.get(deposit.id); run(6);
  assert(regrown(deposit) > grownBefore && Math.abs(room.left(deposit) - beforeDriving - (regrown(deposit) - grownBefore)) < 1e-6,
    'passing through extracts nothing');
  assert.equal(pile(), waiting, 'passing through extracts and collects nothing');
  assert(saw.left >= beforeDriving && room.left(deposit) > saw.left, 'what it saw last, less than the vein holds by now');
  assert.deepEqual([last.seen, last.left, last.active], [false, Math.floor(saw.left / 1000) * 1000, true]);
  assert.deepEqual(faction(alice).veins.get(deposit.id), saw);
  assert(last.at > 0 && last.at <= room.world.time - 6 && told().at === last.at, 'when it last saw it');
  assert(Math.abs(base - deposit.x) > BASE_RADIUS + LOAD_REACH);
});

// An ordinary admitted tall construction, not a part moved above its actor:
// its roof carries the container and its real wheels remain on the ground.
function highHopperDesign() {
  const tall = createStructuredConstruction({ name: 'Caçamba no teto alto', length: 6, height: 5,
    thicknessMm: 8, frontInset: 0, rearInset: 0 }),
    // The original 40 mm frame with 150 % wheels stood at this measured height (0.4502 m), on its cell here: one under
    // where the model hangs wheels of that size, as far as its suspension reaches. The fixture places it there
    // explicitly. Places in cells.
    deck = cellOf(.4501666666666669), floor = deck + cellOf(.004), rise = floor - tall.nodes[0].y;
  return supportedOnRoof(fitted({ ...tall, nodes: tall.nodes.map(node => ({ ...node, y: node.y + rise })),
    chassis: { ...tall.chassis, points: tall.chassis.points.map(point => ({ ...point, y: deck })),
      thicknessMm: 40, gearScale: 1.5, axles: [-42, 0, 42] } }, [
    { id: 'command', kind: 'command', pose: { x: 5, y: floor + cellOf(.169), angle: 0 } },
    // On the cell clear of the 8 mm roof.
    { id: 'hopper', kind: 'hopper', pose: { x: 12, y: floor + cellOf(5) + Math.ceil((.004 + MODULES.hopper.height / 2) / CELL), angle: 0 } },
  ]), 'hopper');
}

test('a grounded vehicle cannot lift a ready pile into a high hopper while an ordinary transporter still loads at its normal rate', t => {
  const { room, world, ground, deposit, players: [alice], publish, put, run, cargo, part, speed, record } = site(t, {}, 'Alice'),
    tall = highHopperDesign();
  assert.equal(compiled(tall).mechanicalAdmission, true);
  const normal = publish(alice, truck), high = publish(alice, tall), ids = [normal, high];
  for (const [i, id] of ids.entries()) {
    const hopper = part(id, 'hopper'), offset = hopper.x - world.actor(id).vehicle.x;
    put(id, deposit.x + (i ? 5 : -5) - offset);
  }
  run(3);
  for (const id of ids) {
    assert(speed(id) < .5, 'the native construction has settled before pickup starts');
    assert(world.modules.some(piece => piece.actorId === id && piece.kind === 'wheel' && piece.groundContact),
      'contact with the ground alone is insufficient to reach a high container');
    assert.deepEqual(collectionWork(world, id), [], 'the test isolates transport, with no extractor bypass');
  }
  const highHopper = part(high, 'hopper'), highAboveGround = highHopper.y - ground.height(highHopper.x);
  assert(highAboveGround > 6, 'the roof-mounted hopper is physically high above the pile');
  assert.equal(workArea(world, normal, deposit, LOAD_REACH)?.ready, true);
  const reserve = room.left(deposit), stock = 3 * FULL, at = world.time;
  room.extracted.set(deposit.id, stock); run(2);
  const loaded = cargo(normal).ferro;
  assert(Math.abs(loaded - TRANSFER_RATE * (world.time - at)) < TRANSFER_RATE * .2,
    'normal transfer keeps its existing rate');
  assert.deepEqual(cargo(high), load(), 'a real grounded chassis cannot make the pile jump into its high hopper');
  assert.equal(record(high).loading, null); assert.equal(record(high).extraction, null);
  assert.equal(room.left(deposit), reserve, 'neither container extracts geological reserve');
  assert(Math.abs((room.extracted.get(deposit.id) ?? 0) + loaded - stock) < 1e-6, 'the ready pile and real cargo conserve every unit');
  t.diagnostic(JSON.stringify({ highHopperCentreAboveGroundM: highAboveGround, ordinaryCargoKg: loaded,
    highCargoKg: cargo(high).ferro, seconds: world.time - at }));
});

test('a full low hopper over the pile takes it in for a high hopper of the same real vehicle, at the one rate of the vehicle', t => {
  const { room, world, ground, deposit, players: [alice], publish, put, run, cargo, set, speed } = site(t, {}, 'Alice'),
    tall = highHopperDesign(), source = fitted(tall, [
      { id: 'lower-hopper', kind: 'hopper', pose: { x: -32, y: tall.nodes[0].y + Math.ceil(.469 / CELL), angle: 0 } },
    ]), id = publish(alice, source),
    [lower, high] = world.modules.filter(piece => piece.actorId === id && piece.kind === 'hopper').sort((a, b) => a.y - b.y);
  assert.equal(compiled(source).mechanicalAdmission, true);
  put(id, deposit.x - (lower.x - world.actor(id).vehicle.x)); run(3);
  const gap = hopper => hopper.y - Math.cos(hopper.angle) * hopper.height / 2 -
    ground.height(hopper.x + Math.sin(hopper.angle) * hopper.height / 2),
    full = cargoRoom(lower) / cargoUnitVolume('ferro');
  assert(gap(lower) < 2 && gap(high) > 6, `only the low container has physical ground-loading reach: low ${gap(lower)}, high ${gap(high)}`);
  set(lower, { cargo: { ferro: full } }); run(3);
  assert(speed(id) < .5 && world.modules.some(piece => piece.actorId === id && piece.kind === 'wheel' && piece.groundContact));
  assert.deepEqual(collectionWork(world, id), []);
  const reserve = room.left(deposit), pile = 1000, before = cargo(id).ferro, at = world.time;
  room.extracted.set(deposit.id, pile); run(2);
  const moved = cargo(id).ferro - before;
  assert(Math.abs((lower.cargo.ferro ?? 0) - full) < 1e-6, 'the low hopper remains full');
  assert(Math.abs((high.cargo.ferro ?? 0) - moved) < 1e-6, 'what the low mouth takes in goes on into the high hopper');
  assert(Math.abs(moved - TRANSFER_RATE * (world.time - at)) < TRANSFER_RATE * .2, `${moved} kg: the vehicle's one rate, not one per piece`);
  assert(Math.abs(room.extracted.get(deposit.id) + moved - pile) < 1e-6); assert.equal(room.left(deposit), reserve);
  t.diagnostic(JSON.stringify({ lowerBaseAboveGroundM: gap(lower), upperBaseAboveGroundM: gap(high),
    lowerCargoKg: lower.cargo.ferro, upperCargoKg: high.cargo.ferro ?? 0, pileKg: room.extracted.get(deposit.id) }));
});

test('two factions collect an existing pile in parallel at the transfer rate, with a stable deadline and no saved progress', t => {
  const f = site(t, { others: [1500] }, 'Alice', 'Bob'),
    { room, world, deposit, players: [alice, bob], publish, put, run, cargo, record, unit } = f,
    ids = [publish(alice, truck), publish(bob, truck)];
  for (const [i, id] of ids.entries()) put(id, workArea(world, id, deposit, LOAD_REACH).goal + (i ? 5 : -5));
  assert(ids.every(id => workArea(world, id, deposit, LOAD_REACH).ready), 'both real containers stand over the same pile');
  const reserve = room.left(deposit), stock = 3 * FULL;
  room.extracted.set(deposit.id, stock); run(.3);
  const before = ids.map(id => cargo(id).ferro), at = world.time, progress = ids.map(id => record(id).cargoWork);
  for (const [i, id] of ids.entries()) {
    assert.equal(progress[i].kind, 'load'); assert(Number.isFinite(progress[i].until));
    assert.equal(progress[i].until * 4 % 1, 0, 'deadlines are quantized to a quarter second');
    assert.equal(unit(i ? bob : alice, id).cargoWork, progress[i]);
    assert.equal(world.actor(id).field.cargoWork, progress[i]);
    assert.equal(record(id).service, null, 'loading feedback does not seize the vehicle as a service');
  }
  run(2);
  for (const [i, id] of ids.entries()) {
    const moved = cargo(id).ferro - before[i];
    assert(Math.abs(moved - TRANSFER_RATE * (world.time - at)) < TRANSFER_RATE * .2, `${moved} moved in parallel`);
    assert.equal(record(id).cargoWork, progress[i], 'a steady load reuses its deadline and metadata object');
  }
  assert.equal(room.left(deposit), reserve, 'moving stock faster does not increase extraction');
  assert(Math.abs(room.extracted.get(deposit.id) + ids.reduce((sum, id) => sum + cargo(id).ferro, 0) - stock) < 1e-6);
  const ledger = new FrameLedger(), writer = new FrameWriter(ledger), reader = new FrameReader(), state = world.snapshot();
  state.shared = true; state.players = room.roster(); ledger.turn();
  const frame = reader.decode(writer.encode({ type: 'frame', state, events: [] }, true));
  for (const [i, id] of ids.entries()) assert.deepEqual(frame.state.actors.find(actor => actor.id === id).field.cargoWork, progress[i], 'the normal frame codec retains the small progress object');
  assert.equal(JSON.stringify(room.keep()).includes('"cargoWork"'), false, 'presentation is not persisted with the field');
  put(ids[0], f.clear(4 * LOAD_REACH));
  assert.equal(unit(alice, ids[0]).cargoWork, undefined); assert.equal(world.actor(ids[0]).field?.cargoWork, undefined);
});

test('a scarce pile is split across factions without duplication and an empty pile waits without an invented deadline', t => {
  const { room, world, deposit, players: [alice, bob], publish, put, run, cargo, record, unit } = site(t, { others: [1500] }, 'Alice', 'Bob'),
    ids = [publish(alice, truck), publish(bob, truck)];
  for (const [i, id] of ids.entries()) put(id, workArea(world, id, deposit, LOAD_REACH).goal + (i ? 5 : -5));
  assert(ids.every(id => workArea(world, id, deposit, LOAD_REACH).ready));
  const reserve = room.left(deposit);
  room.extracted.set(deposit.id, 15); room.haul(.1);
  for (const [i, id] of ids.entries()) {
    assert.equal(cargo(id).ferro, 7.5); assert.equal(record(id).loading, deposit.id);
    assert.deepEqual(unit(i ? bob : alice, id).cargoWork, { kind: 'load', limited: true });
  }
  assert.equal(room.extracted.has(deposit.id), false);
  run(.3);
  for (const [i, id] of ids.entries()) {
    assert.equal(cargo(id).ferro, 7.5);
    assert.deepEqual(unit(i ? bob : alice, id).cargoWork, { kind: 'load', waiting: true });
    assert.equal(record(id).loading, null, 'waiting is distinct from a real material transfer');
  }
  assert.equal(room.left(deposit), reserve, 'two hoppers cannot manufacture geological material');
});

test('a nearly full truck releases its share to the other collector and a full hopper stops reporting work', t => {
  const { room, world, deposit, players: [alice], publish, put, cargo, stowed, unit } = site(t, {}, 'Alice'),
    ids = [publish(alice, truck), publish(alice, truck)];
  for (const [i, id] of ids.entries()) put(id, workArea(world, id, deposit, LOAD_REACH).goal + (i ? 5 : -5));
  assert(ids.every(id => workArea(world, id, deposit, LOAD_REACH).ready));
  stowed(ids[0], 'hopper', { ferro: FULL - 1 }); room.extracted.set(deposit.id, 20); room.haul(.1);
  assert(Math.abs(cargo(ids[0]).ferro - FULL) < 1e-6); assert(Math.abs(cargo(ids[1]).ferro - 19) < 1e-6);
  assert.equal(room.extracted.has(deposit.id), false); assert.equal(unit(alice, ids[0]).cargoWork, undefined);
  assert.deepEqual(unit(alice, ids[1]).cargoWork, { kind: 'load', limited: true });
});

test('collectors share new production while the extractor keeps its own rate and no collector promises a completion time', t => {
  const { room, world, deposit, players: [alice], publish, put, run, cargo, unit } = site(t, {}, 'Alice'),
    miner = publish(alice, miningTruck), collector = publish(alice, truck), ids = [miner, collector];
  put(miner, workArea(world, miner, deposit, LOAD_REACH).goal);
  put(collector, workArea(world, collector, deposit, LOAD_REACH).goal + 5);
  assert(collectionWork(world, miner).some(tool => canCollect(tool, deposit, world.terrain)));
  assert(workArea(world, collector, deposit, LOAD_REACH).ready);
  const reserve = room.left(deposit), before = ids.map(id => cargo(id).ferro), at = world.time, regrown = regrowth(room);
  run(2);
  // What was dug, from what the vein held, what came back of it since and what it holds now.
  const moved = ids.map((id, i) => cargo(id).ferro - before[i]), extracted = reserve + regrown(deposit) - room.left(deposit);
  assert(Math.abs(extracted - DIG * (world.time - at)) <= DIG * .2);
  assert(Math.abs(moved[0] - moved[1]) < 1e-6 && moved.every(amount => amount > 40), 'neither collector monopolizes a pile as it is produced');
  assert(Math.abs(moved[0] + moved[1] - extracted) < 1e-6 && !room.extracted.has(deposit.id));
  for (const id of ids) assert.deepEqual(unit(alice, id).cargoWork, { kind: 'load', limited: true });
});

test('ore goes in hoppers and petroleum in cisterns: a construction without the piece loads nothing, and is told so when sent', t => {
  const { room, deposit, players: [alice], publish, put, run, unit, cargo, order, squad, until, send } = site(t, {}, 'Alice');
  const ore = publish(alice, truck), oil = publish(alice, tanker), none = publish(alice, bare), mixed = publish(alice, both);
  const reserve = room.left(deposit); room.extracted.set(deposit.id, 6000);
  for (const id of [ore, oil, none, mixed]) put(id, workArea(room.world, id, deposit, LOAD_REACH)?.goal ?? deposit.x);
  run(6);
  assert(cargo(ore).ferro > 100 && cargo(mixed).ferro > 100, 'a hopper takes the iron');
  assert.deepEqual([cargo(oil), cargo(none)], [load(), load()], 'a cistern does not, and a box has nothing to take it in');
  assert.deepEqual([unit(alice, oil).loading, unit(alice, none).loading, unit(alice, ore).loading], [null, null, deposit.id]);
  assert.equal(room.left(deposit), reserve, 'transporters never consume geological reserve');
  assert(Math.abs((room.extracted.get(deposit.id) ?? 0) + cargo(ore).ferro + cargo(mixed).ferro - 6000) < 1e-6, 'pickup conserves the previously extracted pile');
  // At a seep of petroleum it is the other way round.
  const seep = room.deposits.filter(d => d.material === 'petroleo' && room.dug(d) && depositsNear(room.deposits, d.x, 2 * LOAD_REACH).length === 1)
    .sort((a, b) => Math.abs(a.x - deposit.x) - Math.abs(b.x - deposit.x))[0];
  const petroleum = room.left(seep); room.extracted.set(seep.id, 6000);
  for (const id of [ore, oil, none, mixed]) put(id, workArea(room.world, id, seep, LOAD_REACH)?.goal ?? seep.x);
  const iron = cargo(ore).ferro; run(6);
  assert(cargo(oil).petroleo > 100 && cargo(mixed).petroleo > 100, 'a cistern takes the petroleum, by the litre');
  assert.deepEqual([cargo(ore), cargo(none)], [load(iron), load()]); assert.equal(unit(alice, oil).loading, seep.id);
  assert(unit(alice, oil).fill.liquid > 0 && unit(alice, oil).fill.solid === 0);
  assert.equal(room.left(seep), petroleum, 'a cistern cannot drill petroleum');
  assert(Math.abs((room.extracted.get(seep.id) ?? 0) + cargo(oil).petroleo + cargo(mixed).petroleo - 6000) < 1e-6, 'litres in the pile and both cisterns are conserved');
  // An order to haul that none of the constructions sent has the piece for is refused in words; one of several is halted, and says why.
  order(alice, 'control', { id: null });
  assert.throws(() => order(alice, 'haul', { ids: [oil, none], depositId: deposit.id }), /^Error: Instale uma Escavadeira para extrair minério ou uma Caçamba para transportá-lo\.$/);
  assert.throws(() => order(alice, 'haul', { ids: [ore, none], depositId: seep.id }), /^Error: Instale uma Perfuratriz para extrair petróleo ou uma Cisterna para transportá-lo\.$/);
  assert.deepEqual([oil, none, ore].map(id => squad(alice, id).haul), [null, null, null], 'a haul refused is given to nobody');
  order(alice, 'haul', { ids: [oil, none, mixed], depositId: seep.id });
  assert(until(() => squad(alice, none).reason === 'no-room', 5), 'the box says it has nothing to carry in');
  assert.deepEqual([squad(alice, none).haul, squad(alice, oil).haul?.depositId, squad(alice, mixed).haul?.depositId], [null, seep.id, seep.id]);
  assert.deepEqual([...room.faults], []); assert.equal(send(alice, 'ping').error, undefined);
});

test('a vein beside a base is not dug: its faction is told so, and another once it sees it', t => {
  const { room, deposit, base, players: [alice, bob], publish, put, run, view, cargo, order, x } = site(t, { gap: BASE_RADIUS + LOAD_REACH - 10, others: [20000] }, 'Alice', 'Bob');
  const still = { id: deposit.id, left: deposit.reserve, stock: 0, at: 0, seen: false, loading: false, extracting: false, active: false }, told = player => view(player).deposits.filter(d => d.id === deposit.id);
  assert(!room.dug(deposit)); assert.deepEqual(told(alice), [still]);
  assert.deepEqual(told(bob), [], 'another faction knows no vein there');
  const id = publish(alice, miningTruck); put(id, workArea(room.world, id, deposit, LOAD_REACH).goal); run(5);
  assert(Math.abs(x(id) - base) > BASE_RADIUS && Math.abs(x(id) - deposit.x) < LOAD_REACH, 'out of the base, on the deposit');
  assert.deepEqual(cargo(id), load()); assert.deepEqual(told(alice), [{ ...still, at: null, seen: true }]); assert.equal(room.left(deposit), deposit.reserve);
  order(alice, 'control', { id: null });
  assert.throws(() => order(alice, 'haul', { ids: [id], depositId: deposit.id }), /Essa jazida fica perto demais de uma base: escolha outra\.$/);
  // A site that is none, and one whose vein the faction does not know, are refused in the same words.
  const unknown = room.deposits.find(d => d.material === 'ferro' && Math.abs(d.x - base) > 5000);
  for (const depositId of ['ferro:nowhere', unknown.id])
    assert.throws(() => order(alice, 'haul', { ids: [id], depositId }), /^Error: Jazida desconhecida: escolha uma que a facção já encontrou\. Explore o campo para achar outras\.$/);
  assert.equal(room.squadView(alice.playerId).units[0].haul, null);
  // A lorry of the other faction comes to the vein: it sees that a base stills it, and that it cannot be dug.
  const far = publish(bob, truck); put(far, deposit.x + 5); run(3);
  assert.deepEqual(told(bob), [{ ...still, at: null, seen: true }]); assert.deepEqual(cargo(far), load());
  order(bob, 'control', { id: null });
  assert.throws(() => order(bob, 'haul', { ids: [far], depositId: deposit.id }), /Essa jazida fica perto demais de uma base: escolha outra\.$/);
});

test('what a construction carries goes into the yard of its base when it stands still inside it, and the refinery makes stock of the yard', t => {
  const { room, base, players: [alice], publish, put, run, view, unit, send, stock, yard, cargo, stowed, clear } = site(t, { stock: bill(50000, 0, 1000, 800) }, 'Alice');
  const id = publish(alice, both), had = { ...stock(alice) }, brought = load(1200.5, 300, 40, 600);
  stowed(id, 'hopper', { ferro: 1200.5, ligas: 300, silica: 40 }); stowed(id, 'cistern', { petroleo: 600 }); put(id, clear(BASE_RADIUS + 200 + 25));
  assert.equal(unit(alice, id).atBase, false); assert.deepEqual(cargo(id), brought, 'outside the base it keeps its load');
  assert.deepEqual([unit(alice, id).cargo, view(alice).yard, view(alice).stock], [load(1201, 300, 40, 600), load(), had], 'a load at rest is told to the unit');
  put(id, base + BASE_RADIUS - 5);
  // The yard takes it at once, as it came; the stocks have none of it yet.
  assert.deepEqual(cargo(id), load()); assert(loadTotal(yard(alice)) > 0 && loadTotal(yard(alice)) <= loadTotal(brought));
  // What the refinery took of the yard, by what each stock made of it: a unit of ore a unit of its stock, a litre of
  // petroleum 0.8 L of fuel.
  const total = loadTotal(brought), waiting = () => loadTotal(yard(alice)), made = raw => (stock(alice)[REFINED[raw]] - had[REFINED[raw]]) / YIELD[raw],
    taken = () => RAW_IDS.reduce((sum, raw) => sum + made(raw), 0);
  assert(Math.abs(waiting() + taken() - total) < 1e-6, 'what is not in the yard was made into the stocks');
  // A thousand units a second in all, of each thing in the share it has of the yard: all four are done together.
  const from = taken(), at = room.world.time; run(1);
  assert(Math.abs(taken() - from - REFINE_RATE * (room.world.time - at)) <= REFINE_RATE * 1.01, `${(taken() - from).toFixed(0)} units in ${(room.world.time - at).toFixed(1)} s`);
  for (const raw of RAW_IDS) assert(Math.abs(made(raw) / taken() - brought[raw] / total) < 1e-9, `${raw} in its share`);
  assert.deepEqual(view(alice).yard, load(...RAW_IDS.map(raw => Math.round(yard(alice)[raw]))), 'the player is told what waits');
  run(total / REFINE_RATE);
  assert.deepEqual(yard(alice), load()); assert.deepEqual(view(alice).yard, load());
  assert(Math.abs(stock(alice).ferro - had.ferro - 1200.5) < 1e-6 && Math.abs(stock(alice).ligas - 300) < 1e-6 && Math.abs(stock(alice).silica - had.silica - 40) < 1e-6 &&
    Math.abs(stock(alice).combustivel - had.combustivel - 480) < 1e-6, '600 L of petroleum make 480 L of fuel');
  assert.deepEqual(view(alice).stock, bill(had.ferro + 1200, 300, had.silica + 40, had.combustivel + 480), 'the stocks are told in whole units');
  // Dismantled or replaced before the field emptied it, what it carried goes into the yard with the rest.
  const value = unit(alice, id).value, kept = { ...stock(alice) }; room.records.get(id).service = { kind: 'repair', until: Infinity, levels: {} };
  stowed(id, 'hopper', { ferro: 70, silica: 9 }); run(.5); room.records.get(id).service = null;
  assert.deepEqual(cargo(id), load(70, 0, 9), 'held for a repair it had not unloaded');
  const quote = dismantleQuote(unit(alice, id)), reply = send(alice, 'remove', { actorId: id });
  assert.deepEqual([reply.refund, reply.cargo, quote], [value, load(70, 0, 9), { refund: value, cargo: load(70, 0, 9) }], 'as it was quoted, the load with it');
  assert.deepEqual([stock(alice), yard(alice)], [billSum(kept, value), load(70, 0, 9)]);
  const next = publish(alice, both); room.records.get(next).service = { kind: 'repair', until: Infinity, levels: {} };
  stowed(next, 'cistern', { petroleo: 500 }); run(.5); room.records.get(next).service = null;
  const stocks = { ...stock(alice) }, waited = { ...yard(alice) };
  room.players.get(alice.playerId).builtAt = -Infinity;
  room.faction(room.players.get(alice.playerId)).stock.silica += 10000; Object.assign(stocks, stock(alice));
  const { cost } = send(alice, 'replace', { actorId: next, blueprint: createStructuredTemplate('chassis') });
  assert.deepEqual(stock(alice), billSum(stocks, cost, -1)); assert(near(yard(alice), { ...waited, petroleo: waited.petroleo + 500 }));
  assert.deepEqual(cargo(next), load());
  // The refinery itself, on round numbers: a litre of petroleum makes 0.8 L of fuel, and the last of a yard goes whole.
  const pile = load(300, 100, 0, 400), shelves = bill();
  assert.equal(refine(pile, shelves, .2), 200); assert.deepEqual([pile, shelves], [load(225, 75, 0, 300), bill(75, 25, 0, 80)]);
  assert.equal(refine(pile, shelves, 100), 600); assert.deepEqual([pile, shelves], [load(), bill(300, 100, 0, 320)]);
  assert.equal(refine(pile, shelves, 5), 0);
});

// A hauler alone on a field that does nothing: what its order makes of where it is and what it carries. Its
// faction knows the places of `state.veins`, all of iron: where each lies, what it knows is left in the vein there and
// in its pile (`left`, a thousand unless said, and `stock`, none), and whether a base stills it. A place that is gone —
// a load dropped on the field and taken — is one it no longer has. What its senses hold of an enemy is `state.contact`,
// as the core would tell its pilot, and what its side holds of the enemies `state.foes`.
function hauler({ x = 0, room = 1000, carried = 0 } = {}) {
  const state = { x, room, carried, time: 0, contact: null, foes: [], veins: { 'ferro:1': { x: 500, stilled: false } } }, member = { id: 'truck', team: 'local', role: 'support' },
    squad = new Squad({ roster: [member], defeats: {}, world: { get time() { return state.time; }, actor: () => ({ vehicle: { x: state.x, y: 0, config: { enabled: true } } }), plates: [], modules: [],
        game: () => ({ call: () => pilotDecision({ action: { throttle: 0, brake: 1, fire: false }, targetId: null,
          contact: state.contact ?? { detected: false }, diagnostics: { reason: 'search-contact',
            nearestFreshContactDistance: state.contact?.detected && state.contact.age < 1 ? Math.abs(state.contact.x - state.x) : null } }) }) },
      deposit: id => state.veins[id] ? { left: 1000, stock: 0, ...state.veins[id], reach: LOAD_REACH, material: 'ferro',
        area: { lo: state.veins[id].x - LOAD_REACH + 1, hi: state.veins[id].x + LOAD_REACH - 1,
          goal: state.veins[id].x - LOAD_REACH / 2, ready: Math.abs(state.x - state.veins[id].x) <= LOAD_REACH } } : null,
      depot: () => ({ x: 0, radius: BASE_RADIUS }), load: () => ({ carried: state.carried, room: state.room }), batteries: [], threats: () => state.foes }),
    unit = squad.units.get('truck');
  unit.haul = { depositId: 'ferro:1', material: 'ferro', phase: 'out' };
  // The drive of a leg, as the field would end it: the hauler is where it was sent. `tip` is what the field tells its squad when it tipped part of its load out.
  let round = 0;
  return { state, unit, turn: () => squad.haul('truck', unit), arrive: () => { state.x = unit.move.x; unit.move = null; }, tip: () => squad.lightened('truck'),
    // A turn of the squad for it, as the field asks one of every vehicle.
    decide: () => squad.decide(member, ++round) };
}
test('a haul is a round of four legs: out, loading, home and unloading', () => {
  const { state, unit, turn, arrive } = hauler({ x: 20 }), bay = 500 + LOAD_REACH - 1 - .45, depot = BASE_RADIUS - DEPOT_INSET;
  assert.equal(turn(), ''); assert.deepEqual([unit.haul.phase, unit.move.x, unit.move.best], ['out', bay, bay - 20], 'the first transporter fills the far bay inside the material');
  assert(bay > 500 && Math.abs(bay - 500) < LOAD_REACH - 1);
  turn(); assert.equal(unit.move.x, bay, 'a leg is driven to its end');
  arrive(); turn(); assert.deepEqual([unit.haul, unit.move], [{ depositId: 'ferro:1', material: 'ferro', phase: 'load' }, null]);
  state.carried = 400; turn(); assert.deepEqual([unit.haul.phase, unit.move], ['load', null], 'it waits while the field loads it');
  // Pushed out of reach, it drives back.
  state.x = 500 - LOAD_REACH - 6; turn(); assert.equal(unit.haul.phase, 'out'); turn(); assert.equal(unit.move.x, bay);
  arrive(); turn(); assert.equal(unit.haul.phase, 'load');
  state.carried = 999.6; assert.equal(turn(), ''); assert.deepEqual([unit.haul.phase, unit.move.x], ['home', depot], 'full, it goes home: just inside the base, on the side it comes from');
  arrive(); turn(); assert.deepEqual([unit.haul.phase, unit.move], ['unload', null]);
  turn(); assert.equal(unit.haul.phase, 'unload', 'it waits while the field empties it');
  state.carried = 0; assert.equal(turn(), ''); assert.deepEqual([unit.haul.phase, unit.move.x], ['out', bay], 'and goes again');
  // From the other side of both, each place is on that side.
  const far = hauler({ x: 900 }); far.turn(); assert.equal(far.unit.move.x, 500 - LOAD_REACH + 1 + .45, 'approached from the other side, the transporter leaves that entrance free');
  assert(far.unit.move.x < 500 && Math.abs(far.unit.move.x - 500) < LOAD_REACH - 1);
  far.state.x = -400; far.unit.haul.phase = 'home'; far.unit.move = null; far.state.carried = 10; far.turn(); assert.equal(far.unit.move.x, -depot);
  // Inside the base already, it unloads where it is.
  const home = hauler({ x: 60, carried: 10 }); home.unit.haul.phase = 'home'; home.turn(); assert.deepEqual([home.unit.haul.phase, home.unit.move], ['unload', null]);
});

test('a hauler that tipped part of its load out takes the rest home instead of filling up again, and from home its haul goes on', () => {
  const bay = 500 + LOAD_REACH - 1 - .45, depot = BASE_RADIUS - DEPOT_INSET;
  // As it loads, with room to spare once it is lighter: it does not wait to be filled again.
  const loading = hauler({ x: 20 }); loading.turn(); loading.arrive(); loading.turn(); loading.state.carried = 750; loading.turn();
  assert.deepEqual([loading.unit.haul.phase, loading.unit.move], ['load', null]);
  loading.state.carried = 500; assert.equal(loading.tip(), true); assert.deepEqual([loading.unit.haul, loading.unit.move], [{ depositId: 'ferro:1', material: 'ferro', phase: 'home' }, null]);
  assert.equal(loading.turn(), ''); assert.deepEqual([loading.unit.haul.phase, loading.unit.move.x], ['home', depot]);
  loading.turn(); assert.deepEqual([loading.unit.haul.phase, loading.unit.move.x], ['home', depot], 'half empty and beside its vein, it goes on home');
  loading.arrive(); loading.turn(); assert.equal(loading.unit.haul.phase, 'unload');
  loading.state.carried = 0; loading.turn(); assert.deepEqual([loading.unit.haul.phase, loading.unit.move.x], ['out', bay], 'unloaded, it goes out again as ever');
  // On its way out with something aboard: it turns for home.
  const out = hauler({ x: 20, carried: 600 }); out.turn(); out.state.x = 200; assert.equal(out.unit.move.x, bay);
  out.state.carried = 350; assert.equal(out.tip(), true); out.turn(); assert.deepEqual([out.unit.haul.phase, out.unit.move.x], ['home', depot]);
  // With all of it tipped out it goes home all the same, and out again from there.
  const emptied = hauler({ x: 20 }); emptied.turn(); emptied.arrive(); emptied.turn(); emptied.state.carried = 200; emptied.turn();
  emptied.state.carried = 0; assert.equal(emptied.tip(), true); emptied.turn(); assert.deepEqual([emptied.unit.haul.phase, emptied.unit.move.x], ['home', depot]);
  emptied.arrive(); emptied.turn(); assert.deepEqual([emptied.unit.haul.phase, emptied.unit.move.x], ['out', bay]);
  // On its way home already, or being unloaded, it goes on as it was; and one with no haul has none to turn.
  const back = hauler({ x: 300, carried: 1000 }); back.unit.haul.phase = 'home'; back.turn(); const leg = back.unit.move;
  back.state.carried = 750; assert.equal(back.tip(), false); assert.equal(back.unit.move, leg); back.turn(); assert.deepEqual([back.unit.haul.phase, back.unit.move], ['home', leg]);
  const there = hauler({ x: 60, carried: 10 }); there.unit.haul.phase = 'home'; there.turn(); assert.equal(there.tip(), false); assert.deepEqual([there.unit.haul.phase, there.unit.move], ['unload', null]);
  const idle = hauler(); idle.unit.haul = null; assert.equal(idle.tip(), false); assert.deepEqual([idle.unit.haul, idle.unit.move], [null, null]);
});

test('a drive that gets no nearer ends by saying what holds the vehicle, and tipping its load out gives it its time over again', () => {
  // A vehicle sent a hundred metres on that stands where it is: its core says what the ground does to it (`stuck`), or says nothing.
  const state = { time: 0, stuck: 'ground' },
    squad = new Squad({ roster: [{ id: 'truck', team: 'local' }], defeats: {},
      world: { get time() { return state.time; }, modules: [], actor: () => ({ vehicle: { x: 0, vx: 0, stuck: state.stuck, config: { enabled: true } } }) } }),
    unit = squad.units.get('truck'), drive = () => squad.drive('truck', unit), sent = () => { unit.move = squad.leg('truck', 100); unit.reason = unit.halt = ''; };
  sent(); assert.deepEqual(drive(), { throttle: 1, brake: 0 });
  state.time = 7; drive(); assert(unit.move, 'it is given eight seconds to get nearer');
  // Lighter, it may get there: it has its eight seconds again from when it tipped.
  assert.equal(squad.lightened('truck'), false); state.time = 14; drive(); assert(unit.move);
  state.time = 15.5; assert.deepEqual(drive(), { throttle: 0, brake: 1 }); assert.deepEqual([unit.move, unit.reason], [null, 'stuck-ground']);
  for (const [stuck, reason] of [['grip', 'stuck-grip'], ['slope', 'stuck-slope'], [null, 'blocked-way']]) {
    state.stuck = stuck; sent(); state.time += 9; drive(); assert.deepEqual([unit.move, unit.reason], [null, reason]);
  }
  // An order that ended because the ground held it says so no longer once it has tipped its load out; one that ended for another reason still does.
  unit.halt = unit.reason = 'stuck-ground'; squad.lightened('truck'); assert.deepEqual([unit.halt, unit.reason], ['', '']);
  unit.halt = unit.reason = 'blocked-way'; squad.lightened('truck'); assert.deepEqual([unit.halt, unit.reason], ['blocked-way', 'blocked-way']);
});

test('a hauler whose vein ran out takes no other, whatever its faction knows: it goes home with what it has, saying why, and stops there', () => {
  const depot = BASE_RADIUS - DEPOT_INSET, bay = 500 + LOAD_REACH - 1 - .45, order = (phase, more = {}) => ({ depositId: 'ferro:1', material: 'ferro', phase, ...more }),
    empty = 'vein-empty:ferro', spent = 'vein-spent:ferro', dug = h => Object.assign(h.state.veins['ferro:1'], { left: 0, stock: 0 });
  // It empties as the hauler loads, and the faction knows two more, one of them nearer than its base: it turns for home with what it loaded.
  const on = hauler({ x: 20 }); Object.assign(on.state.veins, { 'ferro:2': { x: 1400, stilled: false }, 'ferro:3': { x: 300, stilled: false } });
  on.turn(); on.arrive(); on.turn(); on.state.carried = 300; dug(on);
  assert.equal(on.turn(), ''); assert.deepEqual([on.unit.haul, on.unit.move.x, on.unit.halt], [order('home', { empty: true }), depot, empty], 'and says why from then on');
  on.arrive(); assert.equal(on.turn(), ''); assert.deepEqual(on.unit.haul, order('unload', { empty: true }));
  on.state.carried = 0; assert.equal(on.turn(), empty); assert.deepEqual([on.unit.haul, on.unit.move], [null, null], 'with that in the yard its haul is over');
  // Known empty on the way there, with nothing aboard: a vein comes back by itself, so it goes on to see, and finding it
  // empty there it goes home all the same, and ends there.
  const out = hauler({ x: 20 }); out.state.veins['ferro:2'] = { x: 1400, stilled: false }; out.turn(); out.state.x = 300; dug(out);
  assert.equal(out.turn(), ''); assert.deepEqual([out.unit.haul, out.unit.move.x, out.unit.halt], [order('out'), bay, '']);
  out.arrive(); out.turn(); assert.deepEqual(out.unit.haul, order('load'));
  assert.equal(out.turn(), ''); assert.deepEqual([out.unit.haul, out.unit.move.x, out.unit.halt], [order('home', { empty: true }), depot, empty]);
  out.arrive(); assert.equal(out.turn(), empty); assert.deepEqual([out.unit.haul, out.unit.move], [null, null]);
  // Full already when it empties: home, unloaded, and over.
  const full = hauler({ x: 20 }); full.state.veins['ferro:2'] = { x: 1400, stilled: false }; full.turn(); full.arrive(); full.turn(); full.state.carried = 1000; dug(full);
  assert.equal(full.turn(), ''); assert.deepEqual([full.unit.haul, full.unit.move.x], [order('home', { empty: true }), depot]);
  full.arrive(); full.turn(); assert.deepEqual(full.unit.haul, order('unload', { empty: true }));
  full.state.carried = 0; assert.equal(full.turn(), empty); assert.deepEqual([full.unit.haul, full.unit.move], [null, null]);
  // A vein found while it is on its way home changes nothing, nor its own coming back: it was sent to one, and found that one empty.
  const later = hauler({ x: 20 }); later.turn(); later.arrive(); later.turn(); later.state.carried = 300; dug(later); later.turn();
  later.state.veins['ferro:5'] = { x: 2600, stilled: false }; later.state.veins['ferro:1'].left = 400;
  assert.equal(later.turn(), ''); assert.deepEqual([later.unit.haul, later.unit.move.x], [order('home', { empty: true }), depot]);
  later.arrive(); later.turn(); later.state.carried = 0; assert.equal(later.turn(), empty); assert.deepEqual([later.unit.haul, later.unit.move], [null, null]);
  // Known empty while it stood unloaded in its base: it sets out all the same, to see.
  const home = hauler({ x: 60, carried: 10 }); home.unit.haul.phase = 'home'; home.turn(); dug(home); home.state.carried = 0;
  assert.equal(home.turn(), ''); assert.deepEqual([home.unit.haul, home.unit.move.x], [order('out'), bay]);
  // A place that is gone is made for no longer, wherever the hauler was in its trip: as it loads, home with what it has, and over.
  const gone = hauler({ x: 20 }); gone.turn(); gone.arrive(); gone.turn(); gone.state.carried = 300; delete gone.state.veins['ferro:1'];
  assert.equal(gone.turn(), ''); assert.deepEqual([gone.unit.haul, gone.unit.move.x, gone.unit.halt], [order('home'), depot, spent]);
  gone.arrive(); assert.equal(gone.turn(), ''); gone.state.carried = 0; assert.equal(gone.turn(), spent); assert.deepEqual([gone.unit.haul, gone.unit.move], [null, null]);
  // On the way there, with nothing aboard: it goes home all the same, and ends there.
  const lost = hauler({ x: 20 }); lost.turn(); lost.state.x = 300; delete lost.state.veins['ferro:1'];
  assert.equal(lost.turn(), ''); assert.deepEqual([lost.unit.haul, lost.unit.move.x, lost.unit.halt], [order('home'), depot, spent]);
  lost.arrive(); assert.equal(lost.turn(), spent); assert.deepEqual([lost.unit.haul, lost.unit.move], [null, null]);
  // Unloaded in its base: it ends there, without a drive.
  const left = hauler({ x: 60, carried: 10 }); left.unit.haul.phase = 'home'; left.turn(); delete left.state.veins['ferro:1']; left.state.carried = 0;
  assert.equal(left.turn(), spent); assert.equal(left.state.x, 60);
});

test('a hauler that fled an enemy has no vein to go to any more: it goes home with what it has, saying why, and stops there', () => {
  const depot = BASE_RADIUS - DEPOT_INSET, order = phase => ({ depositId: 'ferro:1', material: 'ferro', phase, fled: true }), near = 'enemy-near';
  // On its way out, with nothing aboard: it makes for the vein no longer, goes home and ends there, its vein as it was.
  const out = hauler({ x: 20 }); out.turn(); out.state.x = 300; out.unit.haul.fled = true;
  assert.equal(out.turn(), ''); assert.deepEqual([out.unit.haul, out.unit.move.x, out.unit.halt], [order('home'), depot, near]);
  out.arrive(); assert.equal(out.turn(), near); assert.deepEqual([out.unit.haul, out.unit.move], [null, null]);
  // As it loads: home with what it loaded, and over once that is in the yard.
  const on = hauler({ x: 20 }); on.turn(); on.arrive(); on.turn(); on.state.carried = 300; on.unit.haul.fled = true;
  assert.equal(on.turn(), ''); assert.deepEqual([on.unit.haul, on.unit.move.x, on.unit.halt], [order('home'), depot, near], 'and says why from then on');
  on.arrive(); assert.equal(on.turn(), ''); assert.deepEqual(on.unit.haul, order('unload'));
  on.state.carried = 0; assert.equal(on.turn(), near); assert.deepEqual([on.unit.haul, on.unit.move], [null, null]);
  // On its way home already: it goes on, and does not set out again.
  const back = hauler({ x: 300, carried: 1000 }); back.unit.haul.phase = 'home'; back.turn(); const leg = back.unit.move; back.unit.haul.fled = true;
  assert.equal(back.turn(), ''); assert.equal(back.unit.move, leg); back.arrive(); back.turn(); back.state.carried = 0; assert.equal(back.turn(), near);
  // Unloaded in its base: it ends there, without a drive.
  const home = hauler({ x: 60, carried: 10 }); home.unit.haul.phase = 'home'; home.turn(); home.unit.haul.fled = true; home.state.carried = 0;
  assert.equal(home.turn(), near); assert.equal(home.state.x, 60);
});

test('a hauler gives its trip up for an armed enemy whose guns reach it within a kilometre, or a mark close by: not for one unarmed, out of reach, or no longer sensed', () => {
  // At its vein, loading, with a reading of an enemy so far to one side, and what its side holds of it (`foe`): in sight with
  // guns that reach so far (none for no gun), or a mark only (`reach` null).
  const sensing = (away, foe = { reach: Infinity }, more = {}) => { const h = hauler({ x: 20 }); h.turn(); h.arrive(); h.turn();
    h.state.contact = { detected: true, age: 0, x: h.state.x + away, channel: 'visual', ...more };
    h.state.foes = foe ? [{ x: h.state.x + away, y: 0, ...foe }] : []; h.decide(); return h; };
  for (const h of [sensing(HAUL_SCARE + 50), sensing(-(HAUL_SCARE + 50)), sensing(300, undefined, { age: 2 }), sensing(300, undefined, { detected: false }),
    sensing(300, { reach: 0 }), sensing(-500, { reach: 400 }), sensing(MARK_SCARE + 50, { reach: null }), sensing(300, null)])
    assert.deepEqual([h.unit.haul, h.unit.halt], [{ depositId: 'ferro:1', material: 'ferro', phase: 'load' }, '']);
  for (const [away, foe] of [[HAUL_SCARE - 50, { reach: Infinity }], [-300, { reach: 400 }], [0, { reach: null }], [MARK_SCARE - 50, { reach: null }]]) {
    const h = sensing(away, foe, { channel: 'sound' }); assert.deepEqual([h.unit.haul.fled, h.unit.haul.phase], [true, 'home'], 'it turns home in the same decision');
    assert.equal(h.turn(), ''); assert.deepEqual([h.unit.haul.phase, h.unit.halt, h.unit.move.x], ['home', 'enemy-near', BASE_RADIUS - DEPOT_INSET]);
    // The enemy gone from its senses, it goes home all the same.
    h.state.contact = null; assert.equal(h.turn(), ''); assert.deepEqual([h.unit.haul.phase, h.unit.haul.fled], ['home', true]);
  }
  // A vehicle that is not hauling stays where it is, whatever it picks up.
  const idle = hauler({ x: 20 }); idle.unit.haul = null; idle.state.contact = { detected: true, age: 0, x: 120, channel: 'visual' }; idle.decide();
  assert.deepEqual([idle.unit.haul, idle.unit.move, idle.unit.halt], [null, null, '']);
});

test('an enemy that only shows itself holds a worker a minute at the most in any five, however often it comes back', () => {
  // A worker at rest, and an armed enemy whose guns reach it shown to it, or not, every half second for so many seconds.
  const worker = () => {
    const h = hauler({ x: 20 }); h.unit.haul = null;
    return (on, seconds) => Array.from({ length: seconds * 2 }, () => {
      h.state.time += .5;
      h.state.contact = on ? { detected: true, age: 0, x: 420, channel: 'visual' } : null; h.state.foes = on ? [{ x: 420, y: 0, reach: Infinity }] : [];
      h.decide(); return h.unit.threat;
    });
  };
  // In reach the whole time: held for its minute, then free for the rest of the window, and coming back holds nothing.
  const show = worker(), held = show(true, SCARE_HOLD + 30);
  assert(held.slice(0, SCARE_HOLD * 2 - 1).every(Boolean), 'held while the minute lasts');
  assert(held.slice(SCARE_HOLD * 2 + 1).every(on => !on), 'and no longer');
  for (let i = 0; i < 4; i++) { show(false, 20); assert(show(true, 10).every(on => !on), 'a return within the window holds nothing'); }
  // Once the window is over, a new one opens with the next reading that holds it.
  show(false, SCARE_WINDOW);
  assert(show(true, 5).every(Boolean), 'a new window holds it again');
  // Short visits add up: in a window they hold it for the minute and no more.
  const visits = worker(), total = Array.from({ length: Math.floor(SCARE_WINDOW / 20) },
    () => { const on = visits(true, 5).filter(Boolean).length / 2; visits(false, 15); return on; }).reduce((sum, on) => sum + on, 0);
  assert(total >= SCARE_HOLD - 1 && total <= SCARE_HOLD + 1, `held ${total} s in all`);
});

test('on the field a hauler that picks up an enemy close by goes home and stays there until it is sent again, and an order to move it obeys', t => {
  const { room, world, deposit, base, players: [alice, bob], publish, order, run, until, squad, put, x } = site(t, { others: [9000] }, 'Alice', 'Bob');
  const lorry = publish(alice, 'truck'), foe = publish(bob, 'scout'), hers = room.players.get(alice.playerId).factionId, away = () => Math.abs(x(foe) - x(lorry));
  order(alice, 'control', { id: null }); order(bob, 'control', { id: null }); order(alice, 'haul', { ids: [lorry], depositId: deposit.id });
  assert(until(() => squad(alice, lorry).haul?.phase === 'load', 60), 'it loads at its vein');
  // An enemy comes to ground the lorry sees from there, some hundreds of metres off on the side away from its base:
  // it turns for home, saying why, and its haul ends there.
  const side = Math.sign(deposit.x - base), close = Array.from({ length: 30 }, (_, i) => x(lorry) + side * (250 + i * 20)).find(at => room.sees(hers, at));
  assert(close !== undefined, 'the lorry sees ground some hundreds of metres off'); assert.equal(squad(alice, lorry).haul.fled, undefined);
  put(foe, close); assert(away() < HAUL_SCARE); assert.equal(room.knows(hers, world.actor(foe)), 'seen');
  assert(until(() => squad(alice, lorry).haul?.fled, 10), 'it gives its trip up');
  assert(until(() => squad(alice, lorry).haul?.phase === 'home' && squad(alice, lorry).move, 5)); assert.equal(squad(alice, lorry).reason, 'enemy-near');
  assert(until(() => !squad(alice, lorry).haul, 120), 'home, its haul is over'); assert(Math.abs(x(lorry) - base) <= BASE_RADIUS);
  run(3); assert.deepEqual([squad(alice, lorry).reason, squad(alice, lorry).move], ['enemy-near', null]);
  // An order to move is the player's to give: with the enemy still there, it goes.
  order(alice, 'move', { ids: [lorry], x: deposit.x }); run(4);
  assert(squad(alice, lorry).move && Math.abs(x(lorry) - base) > 5, 'it drives where it was told'); assert.notEqual(squad(alice, lorry).reason, 'enemy-near');
});

test('a hauler with no eye that digs its vein out knows it ran out: it brings home what it took and its haul ends there, and its faction learns no more', t => {
  const { room, world, deposit, base, players: [alice], publish, order, until, view, squad, cargo, x } = site(t, {}, 'Alice');
  const id = publish(alice, blindMiner), faction = room.players.get(alice.playerId).factionId, known = () => view(alice).deposits.map(vein => vein.id),
    told = () => view(alice).deposits.find(vein => vein.id === deposit.id), pile = () => room.extracted.get(deposit.id) ?? 0;
  order(alice, 'control', { id: null });
  const before = known(); assert(before.includes(deposit.id), 'the vein by its base is known from its founding');
  // What is left of the vein is a little, which the faction does not know: it last saw it whole. Digging tells it.
  room.veins.set(deposit.id, 1600);
  const regrown = regrowth(room);
  order(alice, 'haul', { ids: [id], depositId: deposit.id });
  assert(until(() => squad(alice, id).haul?.phase === 'load', 60), 'it loads at its vein');
  assert.deepEqual([world.actor(id).eyes, room.sees(faction, deposit.x)], [[], false], 'seeing nothing there');
  assert(until(() => squad(alice, id).haul?.empty, 30), 'it digs the vein empty'); assert(room.left(deposit) < RESERVE_STEP, 'less than a step left');
  assert(Math.abs(cargo(id).ferro + pile() + room.left(deposit) - 1600 - regrown(deposit)) < 1e-6, 'what it dug of what was left, and of what came back of it as it dug');
  // It took what there was: it turns for home with that, and the haul ends there once it is unloaded, saying why.
  assert(until(() => !squad(alice, id).haul, 120), 'home, its haul is over'); assert(Math.abs(x(id) - base) <= BASE_RADIUS);
  assert.deepEqual([squad(alice, id).reason, cargo(id)], ['vein-empty:ferro', load()]);
  // The faction knows that vein is empty, and nothing else of the field: not that it has come back since.
  assert.deepEqual(known(), before, 'a vein known is never forgotten');
  assert(room.left(deposit) > 0); assert.deepEqual([told().left, told().seen], [0, false]);
});

test('a hauler with no eye finds out at its vein, by what comes out, that somebody else dug it out or that a base stills it: it brings home what it has, and its faction learns no more', t => {
  const loading = (f, id) => { f.order(f.players[0], 'control', { id: null }); f.order(f.players[0], 'haul', { ids: [id], depositId: f.deposit.id });
    assert(f.until(() => f.squad(f.players[0], id).haul?.phase === 'load' && f.cargo(id).ferro > 200, 60), 'it loads at its vein'); };
  // Somebody else takes the last of the vein where nobody of Alice's faction sees it.
  const spent = site(t, {}, 'Alice'), [alice] = spent.players, lorry = spent.publish(alice, blindMiner), known = () => spent.view(alice).deposits.map(vein => vein.id), before = known();
  loading(spent, lorry); spent.room.veins.set(spent.deposit.id, 0); spent.room.extracted.delete(spent.deposit.id);
  assert(spent.until(() => !spent.squad(alice, lorry).haul, 120), 'home, its haul is over'); assert(Math.abs(spent.x(lorry) - spent.base) <= BASE_RADIUS);
  assert.deepEqual([spent.squad(alice, lorry).reason, spent.cargo(lorry)], ['vein-empty:ferro', load()]);
  assert.deepEqual(known(), before, 'that vein is still known, and nothing else of the field');
  assert.equal(spent.view(alice).deposits.find(vein => vein.id === spent.deposit.id).left, 0, 'as empty');
  // Somebody founds a base beside the vein, out of the sight of Alice's faction.
  const stilled = site(t, { others: [-(BASE_RADIUS + LOAD_REACH - 15)] }, 'Alice'), [ana] = stilled.players, truck = stilled.publish(ana, blindMiner),
    told = () => stilled.view(ana).deposits.find(vein => vein.id === stilled.deposit.id);
  loading(stilled, truck); stilled.room.join('Bob'); assert(!stilled.room.dug(stilled.deposit));
  assert(stilled.until(() => !stilled.squad(ana, truck).haul, 120), 'home, its haul is over'); assert(Math.abs(stilled.x(truck) - stilled.base) <= BASE_RADIUS);
  assert.deepEqual([stilled.squad(ana, truck).reason, stilled.cargo(truck), told().active, told().seen], ['no-deposit', load(), false, false]);
});

test('a haul ends where it cannot go on: a vein a base stills ends the order, and so does a design with nothing to carry in', () => {
  // A base was founded beside the vein while the hauler loaded: it brings home what it has, and the order ends. It looks for no other vein.
  const stilled = hauler({ x: 20 }); stilled.state.veins['ferro:2'] = { x: 1400, stilled: false };
  stilled.turn(); stilled.arrive(); stilled.turn(); stilled.state.carried = 300; stilled.state.veins['ferro:1'].stilled = true;
  assert.equal(stilled.turn(), ''); assert.equal(stilled.unit.haul.phase, 'home');
  stilled.arrive(); stilled.turn(); assert.equal(stilled.unit.haul.phase, 'unload');
  stilled.state.carried = 0; assert.equal(stilled.turn(), 'no-deposit'); assert.deepEqual([stilled.unit.haul, stilled.unit.move], [null, null]);
  // On its way out with nothing, it ends where the leg does.
  const empty = hauler({ x: 20 }); empty.turn(); empty.state.veins['ferro:1'].stilled = true; assert.equal(empty.turn(), ''); empty.arrive();
  assert.equal(empty.turn(), 'no-deposit'); assert.equal(empty.unit.haul, null);
  const laden = hauler({ x: 300, carried: 50 }); laden.state.veins['ferro:1'].stilled = true; assert.equal(laden.turn(), ''); assert.equal(laden.unit.haul.phase, 'home');
  // Nothing to carry in.
  const solid = hauler({ room: 0 }); assert.equal(solid.turn(), 'no-room'); assert.deepEqual([solid.unit.haul, solid.unit.move], [null, null]);
});

// Rounds of decisions are dealt over two steps: the first vehicle of the field in one, the others in the next.
for (const [place, designs, hauler, kind, material] of [['first', [miningTruck, 'chassis'], miningTruck, 'hopper', 'ferro'], ['second', ['chassis', miningTanker], miningTanker, 'cistern', 'petroleo']])
  test(`a hauler ${place} in the round goes to a deposit of ${material}, loads, comes home, unloads and goes again, and with nobody of its faction on the field comes home to stay`, t => {
    const { room, deposit, base, players: [alice], publish, order, run, until, view, squad, stock, yard, cargo, stowed, part, x, speed } = site(t, { material, stock: STARTING_STOCK }, 'Alice');
    // The fuel a hauler is given at each visit comes out of the stock a load of petroleum goes into: what the stocks pay
    // for the service of the base is counted (`bought`).
    let bought = 0;
    const refill = room.refill.bind(room);
    room.refill = (actor, quote, point) => { const given = refill(actor, quote, point); if (given && !point.supplier) bought += given.cost[REFINED[material]]; return given; };
    const ids = designs.map(design => publish(alice, design)), id = ids[designs.indexOf(hauler)], other = ids.find(i => i !== id),
      phase = () => squad(alice, id).haul?.phase, carried = () => cargo(id)[material], full = cargoRoom(part(id, kind)) / cargoUnitVolume(material),
      // What the faction has of it, refined or still in the yard, and what it gave its vehicles of it, as what was brought:
      // a litre of fuel was made of 1.25 L of petroleum.
      brought = () => (stock(alice)[REFINED[material]] + bought) / YIELD[material] + yard(alice)[material],
      // What its tool takes out of the ground in a second.
      pace = paceOf(hauler);
    assert.deepEqual(room.world.actors.map(a => a.id), ids);
    order(alice, 'control', { id: null }); order(alice, 'haul', { ids: [id], depositId: deposit.id });
    assert.deepEqual(squad(alice, id).haul, { depositId: deposit.id, material, phase: 'out' });
    assert(until(() => phase() === 'load', 60), 'it reached the deposit');
    assert(collectionWork(room.world, id).some(work => canCollect(work, deposit, room.world.terrain)), 'the scoop or drill is in the actual material');
    assert(until(() => carried() > 2 * pace, 10), 'and loads there'); assert(speed(id) < .5);
    assert.deepEqual([squad(alice, id).activity, squad(alice, id).move, view(alice).units.find(u => u.id === id).loading], ['hauling', null, deposit.id]);
    // The rest of the load, in the time a test has.
    stowed(id, kind, { [material]: full - 3 * pace });
    assert(until(() => phase() === 'home', 15), 'full, it turned for home'); assert(Math.abs(carried() - full) < 1e-6);
    const had = brought();
    assert(until(() => carried() === 0, 90), 'it came home and was unloaded');
    assert(Math.abs(brought() - had - full) < 1e-6, 'a full load for the faction');
    assert(Math.abs(x(id) - base) <= BASE_RADIUS && Math.abs(x(id) - base) > BASE_RADIUS - DEPOT_INSET - 15, `it unloaded ${Math.abs(x(id) - base).toFixed(1)} m from the middle of its base`);
    assert(until(() => phase() === 'out' && squad(alice, id).move, 5), 'and goes again');
    assert.deepEqual([squad(alice, other).haul, squad(alice, other).move], [null, null]); assert(Math.abs(x(other) - base) <= BASE_RADIUS, 'the other vehicle of the squad was sent nowhere');
    // The player leaves while it loads: with nobody of the faction on the field it gives its rounds up and comes home
    // (`recall`) with what it took on, which is unloaded there; it goes out no more.
    assert(until(() => phase() === 'load', 60)); assert(until(() => carried() > 100, 10)); room.disconnect(alice.playerId);
    assert.equal(squad(alice, id).haul, null, 'its rounds are over');
    assert(until(() => carried() === 0, 120), 'home and unloaded'); assert(brought() - had - full > 100, 'what it took on for the faction');
    const waiting = yard(alice)[material], refined = stock(alice)[REFINED[material]];
    run(10); assert.deepEqual([squad(alice, id).haul, squad(alice, id).move], [null, null]);
    assert(Math.abs(x(id) - base) <= BASE_RADIUS, 'and it stays there');
    // The yard is refined whether anybody is there or not.
    assert(waiting > 0 && yard(alice)[material] < waiting && stock(alice)[REFINED[material]] > refined, 'refined with nobody there');
    assert.deepEqual([...room.faults], []);
  });

test('a hauler that cannot get there gives the haul up, and one whose deposit a new base stills brings its load home', t => {
  const { room, world, deposit, base, players: [alice], publish, order, run, until, squad, stock, yard, cargo, set, x } = site(t, { others: [-(BASE_RADIUS + LOAD_REACH - 15)] }, 'Alice');
  const stuck = publish(alice, miningTruck), id = publish(alice, miningTruck), brought = () => stock(alice).ferro + yard(alice).ferro;
  order(alice, 'control', { id: null }); order(alice, 'haul', { ids: [stuck, id], depositId: deposit.id });
  // One loses its wheels on the way: after a while without getting nearer, its order is over, and it says why until it is given another.
  run(2); for (const wheel of world.modules.filter(m => m.actorId === stuck && m.kind === 'wheel')) set(wheel, { health: 0 });
  assert(until(() => !squad(alice, stuck).haul, 40), 'it gave up');
  assert.deepEqual([squad(alice, stuck).move, squad(alice, stuck).reason], [null, 'blocked-way']); assert(Math.abs(x(stuck) - deposit.x) > LOAD_REACH);
  run(3); assert.equal(squad(alice, stuck).reason, 'blocked-way');
  assert(until(() => squad(alice, id).haul?.phase === 'load' && cargo(id).ferro > 200, 60), 'the other one loads');
  // Somebody founds a base beside the deposit.
  const bob = room.join('Bob'), had = brought();
  assert(Math.abs(bob.base.x - deposit.x) <= BASE_RADIUS + LOAD_REACH); assert(!room.dug(deposit));
  // Alice is told that a base stills it because her lorry stands there and sees it: of a vein out of her sight she would go on knowing what she did.
  const told = () => room.factionView(alice.playerId).deposits.find(d => d.id === deposit.id);
  run(.3); assert.deepEqual([told().active, told().seen], [false, true]);
  const loaded = cargo(id).ferro;
  assert(until(() => !squad(alice, id).haul, 90), 'its order ended');
  assert.equal(squad(alice, id).reason, 'no-deposit'); assert(Math.abs(x(id) - base) <= BASE_RADIUS);
  run(3); assert.equal(squad(alice, id).reason, 'no-deposit'); order(alice, 'stop', { ids: [id, stuck] }); run(1);
  assert(![squad(alice, id).reason, squad(alice, stuck).reason].some(reason => ['no-deposit', 'blocked-way'].includes(reason)), 'another order, and that is forgotten');
  assert(Math.abs(loaded - (brought() - had)) <= DIG * .5, 'with what it had loaded brought home'); assert.deepEqual(cargo(id), load());
});

test('a hauler destroyed is a wreck that keeps its load: whoever dismantles it takes the load into the hoppers and the cisterns that reached it, each kind into its own', t => {
  const { room, world, players: [alice, bob], publish, put, run, send, view, unit, stock, yard, set, part, stowed, cargo, mass, clear } = site(t, { others: [900], stock: bill(200000, 0, 2000, 2000) }, 'Alice', 'Bob');
  const hauler = publish(alice, both), scout = publish(bob, 'scout'), little = publish(bob, small), oil = publish(bob, tanker), ore = publish(bob, truck), place = clear(450),
    carried = load(1200, 600, 400, 800), fits = cargoRoom(part(little, 'hopper')), alloys = (fits - 1200 / CARGO.ferro.density) * CARGO.ligas.density;
  assert(alloys > 100 && alloys < 600, 'the little hopper takes all the iron and some of the alloys');
  put(hauler, place); stowed(hauler, 'hopper', { ferro: 1200, ligas: 600, silica: 400 }); stowed(hauler, 'cistern', { petroleo: 800 });
  for (const post of world.modules.filter(m => m.actorId === hauler && m.kind === 'command')) set(post, { health: 0 });
  run(.5);
  assert.deepEqual([world.actor(hauler).defeated, view(alice).units, cargo(hauler)], [true, [], carried], 'nobody\'s, with all it carried');
  // A faction sees what a wreck carries once it knows of the wreck: its own, and any that comes into the
  // sight of a construction of its. Nobody sees the yard or the stocks of another faction.
  assert.deepEqual(view(alice).wrecks.map(w => [w.id, w.cargo, w.inReach]), [[hauler, carried, false]]);
  assert.deepEqual(view(bob).wrecks, [], 'out of the sight of all he has on the field, it is no wreck to him');
  assert.throws(() => send(bob, 'salvage', { wreckId: hauler }), /já não estão no campo/);
  assert.deepEqual(view(alice).units, []); assert.deepEqual(view(bob).units.map(u => u.id), [scout, little, oil, ore]);
  // A short id could turn up inside some other text; it is looked for as a whole value.
  assert(!JSON.stringify(view(alice)).includes(JSON.stringify(scout)) && !/stock|yard/.test(JSON.stringify(room.roster())));
  put(scout, place + 10);
  assert.deepEqual(view(bob).wrecks.map(w => [w.id, w.cargo]), [[hauler, carried]], 'his scout beside it, he is told of it');
  run(CALM_SECONDS);
  // What the wreck is worth goes to the faction at once, the fuel left in its tank with it; its load has to be fetched in something.
  const [offer] = view(bob).wrecks, had = { ...stock(bob) };
  assert.equal(offer.inReach, true); assert(offer.value.ferro > 0 && offer.value.combustivel > 0);
  assert.deepEqual(send(bob, 'salvage', { wreckId: hauler }), { salvaged: hauler, value: offer.value, cargo: load(), left: carried }, 'a scout has nothing to take it in');
  assert.deepEqual(stock(bob), billSum(had, offer.value));
  // The wreck is now nothing but its load.
  assert(world.actor(hauler)); assert.deepEqual(view(bob).wrecks.map(w => [w.value, w.cargo, w.inReach]), [[bill(), carried, true]]);
  assert.throws(() => send(bob, 'salvage', { wreckId: hauler }), /^Error: Nenhuma construção sua junto dos destroços tem caçamba ou cisterna com espaço para a carga\.$/);
  assert.throws(() => send(alice, 'salvage', { wreckId: hauler }), /Leve uma construção sua/);
  // A little hopper comes: it takes the solids in the order they are listed, as far as it has room.
  put(little, place - SALVAGE_REACH + 4); run(1);
  const empty = mass(little);
  assert.deepEqual(send(bob, 'salvage', { wreckId: hauler }), { salvaged: hauler, value: bill(), cargo: load(1200, Math.round(alloys)), left: load(0, Math.round(600 - alloys), 400, 800) });
  assert(near(cargo(little), load(1200, alloys))); assert(near(cargo(hauler), load(0, 600 - alloys, 400, 800)));
  assert.deepEqual([unit(bob, little).cargo, unit(bob, little).fill], [load(1200, Math.round(alloys)), { solid: 1, liquid: 0, supplies: 0 }]);
  run(.5); assert(Math.abs(mass(little) - empty - 1200 - alloys) <= 20, 'and weighs it');
  assert.throws(() => send(bob, 'salvage', { wreckId: hauler }), /caçamba ou cisterna com espaço/, 'full, it takes no more');
  // A cistern takes the petroleum and leaves the ore; a hopper takes the ore, and the wreck goes with the last of its load.
  put(oil, place + 20); run(1);
  assert.deepEqual(send(bob, 'salvage', { wreckId: hauler }), { salvaged: hauler, value: bill(), cargo: load(0, 0, 0, 800), left: load(0, Math.round(600 - alloys), 400) });
  assert.deepEqual(cargo(oil), load(0, 0, 0, 800)); assert(world.actor(hauler));
  put(ore, place - 14); run(1);
  assert.deepEqual(send(bob, 'salvage', { wreckId: hauler }), { salvaged: hauler, value: bill(), cargo: load(0, Math.round(600 - alloys), 400), left: load() });
  assert(!world.actor(hauler)); assert.deepEqual(view(bob).wrecks, []);
  assert(near(cargo(ore), load(0, 600 - alloys, 400)));
  assert.deepEqual([stock(bob), yard(bob)], [billSum(had, offer.value), load()], 'and nothing of it is the faction\'s until it is home');
  // Home, it is all in the yard, and the refinery makes of it what the stocks are short of.
  for (const [i, id] of [little, oil, ore].entries()) put(id, bob.base.x + 15 * (i - 1));
  assert(near(RAW_IDS.reduce((sum, raw) => ({ ...sum, [raw]: yard(bob)[raw] + (stock(bob)[REFINED[raw]] - had[REFINED[raw]] - offer.value[REFINED[raw]]) / YIELD[raw] }), {}), carried));
  run(loadTotal(carried) / REFINE_RATE + 2);
  assert.deepEqual(yard(bob), load());
  for (const raw of RAW_IDS) assert(Math.abs(stock(bob)[REFINED[raw]] - had[REFINED[raw]] - offer.value[REFINED[raw]] - carried[raw] * YIELD[raw]) < 1e-6, raw);
});

test('the field has no escort order: it is refused as unknown and nothing comes to follow another vehicle', t => {
  const { room, base, players: [alice], publish, order, run, squad } = site(t, {}, 'Alice');
  const leader = publish(alice, 'scout', { x: base - 30 }), other = publish(alice, 'scout', { x: base + 30 });
  order(alice, 'control', { id: null });
  assert.throws(() => order(alice, 'escort', { ids: [other], targetId: leader }), /^Error: Ordem desconhecida\.$/);
  run(1); assert.deepEqual([squad(alice, other).move, 'escort' in squad(alice, other)], [null, false]);
  assert.deepEqual([...room.faults], []);
});

test('every screen that sees an extractor animates its installed tool from authoritative extraction activity, not hidden hopper cargo', t => {
  const { room, deposit, players: [alice, bob], publish, put, run, clear } = site(t, { others: [6000] }, 'Alice', 'Bob');
  const id = publish(alice, miningTruck), watcher = publish(bob, 'tanker'), by = workArea(room.world, id, deposit, LOAD_REACH).goal;
  // The frames of a turn, written for each faction and read as its pages read them (physics-worker.ts, network-client.ts).
  const ledger = new FrameLedger(), sides = [alice, bob].map(player => ({ faction: room.players.get(player.playerId).factionId, writer: new FrameWriter(ledger), reader: new FrameReader(), arm: {}, seen: 0 }));
  let whole = true;
  const turn = () => {
    const state = room.world.snapshot(); state.shared = true; state.players = room.roster();
    const parts = chapters(state); ledger.turn();
    for (const side of sides) {
      const packet = side.reader.decode(side.writer.encode({ type: 'frame', ...room.audience(state, parts, [], side.faction) }, whole)),
        tool = packet.state.modules.find(m => m.actorId === id && m.kind === 'excavator'),
        actor = packet.state.actors.find(actor => actor.id === id);
      // Exposed machinery is shown to both factions. Reservoir internals are not needed to animate it.
      if (tool) { side.seen++; workStep(side.arm, false, Boolean(actor?.field?.extraction?.some(entry => entry.partId === tool.id)), packet.state.time); }
    }
    whole = false;
  }, watch = seconds => { for (let i = 0; i < seconds * 20; i++) { run(.05); turn(); } };
  // Standing clear of every deposit, with the other faction's lorry beside it: both see it, and its arm is folded.
  put(id, clear(4 * LOAD_REACH)); put(watcher, clear(4 * LOAD_REACH) + 25); watch(2);
  for (const side of sides) { assert(side.seen > 30, 'the lorry is on the screen'); assert.equal(side.arm.working, false); assert.equal(side.arm.deployed, 0); }
  // By the deposit it loads: on both screens the arm comes out and goes on scooping.
  put(id, by); put(watcher, by + 25); watch(5);
  assert.equal(room.records.get(id).extraction?.[0].siteId, deposit.id, 'it is extracting with the installed tool');
  for (const side of sides) { assert.equal(side.arm.working, true, 'the extraction activity is visible'); assert.equal(side.arm.deployed, 1); assert(side.arm.cycle > 2); }
  // Taken away from it, the load stops growing and the arm folds.
  put(id, clear(4 * LOAD_REACH)); put(watcher, clear(4 * LOAD_REACH) + 25); watch(4);
  for (const side of sides) { assert.equal(side.arm.working, false); assert.equal(side.arm.deployed, 0); }
});

// Service and supplies. A construction that fought is short of rounds and of fuel, and something of it is damaged: the
// last is a hit, which puts it in combat for a while.
const spent = ({ part, set }, id, { rounds = 3, litres = 50, piece = 'engine', left = .8 } = {}) => {
  if (rounds != null && part(id, 'ammo')) set(part(id, 'ammo'), { rounds });
  if (litres != null) set(part(id, 'fuel'), { fuelLitres: litres });
  if (piece) set(part(id, piece), { health: part(id, piece).maxHealth * left });
};
const designed = (f, id, kind) => reserveState(f.world.actor(id).blueprint.modules.find(m => m.kind === kind));
const BASE_POINT = resupply => ({ supplier: null, stock: null, held: '', resupply });

test('service comes by itself to a construction that stands still in its base, out of combat: it is filled up and then mended, from the stocks', t => {
  const f = site(t, {}, 'Alice'), { room, players: [alice], publish, order, run, unit, part, stock, record, x } = f;
  const tank = publish(alice, 'scout'), driven = publish(alice, 'scout'), rounds = designed(f, tank, 'ammo').rounds;
  order(alice, 'control', { id: driven }); assert.equal(room.players.get(alice.playerId).squad.manual, driven); run(1);
  assert.deepEqual([unit(alice, tank).point, unit(alice, tank).still, unit(alice, tank).supplies, unit(alice, tank).load], [BASE_POINT(bill()), true, null, null]);
  // Hit a moment ago, it is in combat: nothing comes yet, and the faction is told what the base would do.
  spent(f, tank, { left: .5 }); run(1);
  const due = unit(alice, tank), had = { ...stock(alice) };
  assert(due.rearm.ferro > 0 && due.rearm.combustivel > 100 && due.repair.ferro > 0 && due.repairSeconds >= 5);
  assert.deepEqual([due.calm, due.still, due.service, due.point], [false, true, null, BASE_POINT(due.rearm)]);
  run(CALM_SECONDS - 3); assert.deepEqual([stock(alice), part(tank, 'ammo').rounds], [had, 3], 'in combat it waits');
  // Calm, it is filled up first and the repair begins: both bills, each from its stock, and no more.
  run(3);
  const held = unit(alice, tank), stood = x(tank);
  assert.deepEqual([held.rearm, part(tank, 'ammo').rounds], [bill(), rounds]); assert(Math.abs(part(tank, 'fuel').fuelLitres - designed(f, tank, 'fuel').fuelLitres) < .01);
  assert(held.service?.kind === 'repair' && held.service.until - room.world.time <= due.repairSeconds && held.service.until - room.world.time > due.repairSeconds - 3);
  assert.deepEqual(stock(alice), billSum(billSum(had, due.rearm, -1), due.repair, -1));
  run(due.repairSeconds + 1);
  assert.deepEqual([unit(alice, tank).repair, unit(alice, tank).rearm, unit(alice, tank).service], [bill(), bill(), null]);
  assert.equal(part(tank, 'engine').health, part(tank, 'engine').maxHealth); assert.equal(part(tank, 'ammo').rounds, rounds, 'with the load it was given');
  assert(Math.abs(x(tank) - stood) < .5); assert.deepEqual(stock(alice), billSum(billSum(had, due.rearm, -1), due.repair, -1), 'paid once');
  // A parked construction in the player's hands is serviced by the base too; taking control does not veto a repair.
  spent(f, driven, { left: .5 }); run(CALM_SECONDS + 1);
  const mine = unit(alice, driven);
  assert.deepEqual([mine.rearm, mine.service?.kind, part(driven, 'ammo').rounds], [bill(), 'repair', rounds]); assert.deepEqual(mine.repair, due.repair);
  assert.equal(room.players.get(alice.playerId).squad.manual, driven, 'the player keeps control during the repair');
  run(due.repairSeconds + 1); assert.deepEqual([record(driven).service, unit(alice, driven).repair], [null, bill()]);
  // It comes whether the player is there or not.
  spent(f, tank, { left: .5 }); room.disconnect(alice.playerId); run(CALM_SECONDS - 3); assert.equal(part(tank, 'ammo').rounds, 3, 'in combat it waits');
  run(4); assert.deepEqual([unit(alice, tank).rearm, part(tank, 'ammo').rounds, record(tank).service?.kind], [bill(), rounds, 'repair']);
  assert.deepEqual([...room.faults], []);
});

test('manual base repair waits for released pedals and lets the driver cancel and leave without spending the repair bill', t => {
  const f = site(t, {}, 'Alice'), { room, players: [alice], publish, send, order, run, until, unit, part, set, stock, record, x } = f,
    id = publish(alice, 'scout'), pilot = room.players.get(alice.playerId).squad;
  order(alice, 'control', { id }); run(1);
  const engine = () => part(id, 'engine');
  set(engine(), { health: engine().maxHealth * .5 });
  // Holding throttle against the brake is an intention to drive, although the vehicle remains still.
  send(alice, 'drive', { actorId: id, throttle: 1, brake: 1 }); run(CALM_SECONDS + 1);
  assert(unit(alice, id).still, 'the brake holds the vehicle'); assert.equal(record(id).service, null);
  const due = unit(alice, id).repair, had = { ...stock(alice) };
  assert(due.ferro > 0);
  send(alice, 'drive', { actorId: id, throttle: 0, brake: 1 });
  assert(until(() => record(id).service?.kind === 'repair', 3), 'releasing the pedal starts the actual base repair');
  assert.deepEqual(stock(alice), billSum(had, due, -1)); assert.equal(pilot.manual, id);
  // Neutral pedal updates do not cancel it. A malformed driving input must not refund or free the vehicle.
  send(alice, 'drive', { actorId: id, throttle: 0, brake: 1 }); run(.1);
  assert.equal(record(id).service?.kind, 'repair');
  assert.throws(() => send(alice, 'drive', { actorId: id, throttle: 1, brake: 'invalid', request: 1 }));
  assert.equal(record(id).service?.kind, 'repair'); assert.deepEqual(stock(alice), billSum(had, due, -1));
  const stood = x(id);
  send(alice, 'drive', { actorId: id, throttle: 1, brake: 0 });
  assert.deepEqual([record(id).service, unit(alice, id).declined, stock(alice)], [null, true, had]);
  assert.equal(engine().health, engine().maxHealth * .5, 'cancelled repair mends nothing');
  assert(until(() => Math.abs(x(id) - stood) > 2, 5), 'the same manual control drives away');
  assert.equal(record(id).service, null); assert.deepEqual([...room.faults], []);
});

test('a hauler mended by itself in its base goes on with its round, and a vehicle on its way is filled up without being held', t => {
  const f = site(t, { gap: 400 }, 'Alice'), { room, deposit, base, players: [alice], publish, order, run, until, unit, squad, part, set, stowed, cargo, record, x } = f;
  const id = publish(alice, miningTruck), tank = publish(alice, 'scout', { x: base + 20 }), phase = () => squad(alice, id).haul?.phase;
  order(alice, 'control', { id: null }); order(alice, 'haul', { ids: [id], depositId: deposit.id });
  assert(until(() => phase() === 'load' && cargo(id).ferro > 100, 120), 'it loads'); stowed(id, 'hopper', { ferro: FULL - 150 });
  assert(until(() => phase() === 'home', 15), 'full, it turns for home');
  // Hit as it turns, and with a third of its fuel.
  spent(f, id, { litres: 60, piece: 'command', left: .6 });
  assert(until(() => record(id).service?.kind === 'repair', 180), 'in its base it is held for the repair, unasked');
  assert(Math.abs(x(id) - base) <= BASE_RADIUS); assert.deepEqual(cargo(id), load(), 'unloaded first');
  assert.deepEqual(unit(alice, id).rearm, bill(), 'and fuelled'); assert.deepEqual(squad(alice, id).haul, { depositId: deposit.id, material: 'ferro', phase: 'unload' }, 'its order stands');
  const stood = x(id); run(2); assert(Math.abs(x(id) - stood) < .5, 'held where it stands'); assert.equal(phase(), 'unload');
  assert(until(() => !record(id).service, 200), 'the repair ends'); assert.deepEqual(unit(alice, id).repair, bill());
  assert(until(() => phase() === 'out' && squad(alice, id).move, 5), 'and it goes out again');
  assert(until(() => phase() === 'load' && cargo(id).ferro > 100, 120), 'to the deposit, where it loads');
  // A vehicle told to go somewhere as it comes out of combat is filled up where it stands, and not held for a repair until it is there.
  spent(f, tank, { piece: 'command', left: .6 }); run(CALM_SECONDS - 1); assert.deepEqual([unit(alice, tank).calm, record(tank).service], [false, null]);
  order(alice, 'move', { ids: [tank], x: base + 80 }); record(tank).combatAt = room.world.time - CALM_SECONDS; room.survey();
  assert.deepEqual([unit(alice, tank).rearm, record(tank).service], [bill(), null], 'armed and fuelled at once, and free to go');
  assert(squad(alice, tank).move, 'its order stands'); assert(unit(alice, tank).repair.ferro > 0);
  assert(until(() => !squad(alice, tank).move, 60), 'it arrives'); assert(Math.abs(x(tank) - (base + 80)) < 6);
  assert(until(() => record(tank).service, 5), 'and there, still in its base, it is mended');
  assert.deepEqual([...room.faults], []);
});

test('at its base a supply piece takes supplies on by itself: fuel in a quarter of its room and the stock of the faction in the rest, in the shares its army is built of, which it carries and weighs', t => {
  const f = site(t, { stock: bill(300000, 30000, 30000, 9000) }, 'Alice'),
    { room, players: [alice], publish, send, order, run, unit, stock, yard, cargo, held, aboard, mass, part, stowed, filled } = f;
  const supply = publish(alice, crates), armour = publish(alice, plated), box = publish(alice, bare), solids = ['ferro', 'ligas', 'silica'];
  order(alice, 'control', { id: null });
  // The army is the supply vehicle, a truck under titanium and behind ceramic, and a box: three quarters of the supply piece
  // are filled with iron, alloys and silica in the shares they are built of, and a quarter with fuel.
  const built = billSum(billSum(designBill(compiled(crates)), designBill(compiled(plated))), designBill(compiled(bare))), space = cargoRoom(part(supply, 'supply')),
    each = space * (1 - FUEL_SHARE) / solids.reduce((sum, id) => sum + built[id] * cargoUnitVolume(id), 0),
    full = bill(...solids.map(id => Math.floor(built[id] * each + 1e-6)), Math.floor(space * FUEL_SHARE * 1000 + 1e-6)), as = amounts => load(amounts.ferro, amounts.ligas, amounts.silica, amounts.combustivel);
  assert(full.ferro > full.ligas && full.ligas > 0 && full.silica > 0 && full.combustivel === 877);
  assert(Math.abs(full.ligas / full.ferro - built.ligas / built.ferro) < .01 && Math.abs(full.silica / full.ferro - built.silica / built.ferro) < .01);
  assert.deepEqual([unit(alice, supply).supplies, unit(alice, supply).load, unit(alice, armour).supplies, unit(alice, armour).load, unit(alice, box).load], [bill(), full, null, null, null],
    'what it would take is told before the field looks; one with no supply piece takes none');
  const had = { ...stock(alice) }, empty = mass(supply);
  // Standing still in its base, out of combat, it takes them on when the field looks.
  filled(supply);
  assert.deepEqual(stock(alice), billSum(had, full, -1), 'out of the stocks, unit for unit');
  assert.deepEqual([held(supply), cargo(supply)], [as(full), load()], 'each stock as the thing of its name, fuel as petroleum, all in the supply piece');
  assert.deepEqual([unit(alice, supply).supplies, unit(alice, supply).cargo, unit(alice, supply).load], [full, load(), bill()]); assert(unit(alice, supply).fill.supplies > .998);
  run(1); assert(Math.abs(mass(supply) - empty - full.ferro - full.ligas - full.silica - full.combustivel * .85) <= 20, 'and it weighs them');
  assert.deepEqual([held(supply), yard(alice), stock(alice)], [as(full), load(), billSum(had, full, -1)], 'standing in its base it tips nothing into the yard, and full it takes nothing more');
  // No more of anything than the stock holds.
  stowed(supply, 'supply', {}); Object.assign(stock(alice), bill(1e6, 100.7, 0, 50));
  assert.deepEqual(unit(alice, supply).load, bill(full.ferro, 100, 0, 50));
  run(.5); assert.deepEqual(held(supply), load(full.ferro, 100, 0, 50)); assert(Math.abs(stock(alice).ligas - .7) < 1e-9 && stock(alice).combustivel === 0);
  // What was short is taken on when there is some.
  run(1); assert.deepEqual(held(supply), load(full.ferro, 100, 0, 50), 'with nothing more in the stocks');
  Object.assign(stock(alice), bill(1e6, 5000, 5000, 5000)); run(.5);
  assert.deepEqual(held(supply), as(full), 'topped up where it stands'); assert.deepEqual(stock(alice), bill(1e6, 5000 - full.ligas + 100, 5000 - full.silica, 5000 - full.combustivel + 50));
  // Short of fuel alone, it is told it takes that on, and does.
  stowed(supply, 'supply', { ...as(full), petroleo: 81 });
  assert.deepEqual([held(supply).petroleo, unit(alice, supply).load], [81, bill(0, 0, 0, full.combustivel - 81)]);
  run(.5); assert.deepEqual(held(supply), as(full));
  // Replaced by another design, its supplies go back to the stocks, not to the yard.
  const shelved = { ...stock(alice) }, waiting = { ...yard(alice) }, carried = aboard(supply); room.players.get(alice.playerId).builtAt = -Infinity;
  const { cost } = send(alice, 'replace', { actorId: supply, blueprint: createStructuredTemplate('chassis') });
  assert.deepEqual([stock(alice), yard(alice)], [billSum(billSum(shelved, carried), cost, -1), waiting]);
  // Dismantled, the same.
  const spare = publish(alice, kit); order(alice, 'control', { id: null }); filled(spare); const taken = aboard(spare);
  const worth = unit(alice, spare).value, kept = { ...stock(alice) }, quote = dismantleQuote(unit(alice, spare)), reply = send(alice, 'remove', { actorId: spare });
  assert.deepEqual([reply.refund, reply.cargo, quote], [billSum(worth, taken), load(), { refund: billSum(worth, taken), cargo: load() }], 'its supplies with it, as it was quoted');
  assert.deepEqual([stock(alice), yard(alice)], [billSum(billSum(kept, worth), taken), waiting]);
});

test('far from its base a supply vehicle fuels a dry lorry and arms and mends a tank beside it, out of what it carries, to the unit', t => {
  const f = site(t, {}, 'Alice'), { room, base, players: [alice], publish, order, run, unit, stock, cargo, put, part, set, record, clear } = f;
  const supply = publish(alice, crates), lorry = publish(alice, truck), tank = publish(alice, 'scout'), place = clear(2400), aboard = () => f.aboard(supply);
  order(alice, 'control', { id: null }); f.filled(supply);
  const carried = aboard(), had = { ...stock(alice) };
  assert(Math.abs(place - base) > 2000 && carried.ferro > 3000 && carried.combustivel > 800);
  // Settle the real carrier on this slope, with both recipients safely inside the service radius after settling too.
  put(supply, place); assert(f.until(() => f.speed(supply) < .01, 5), 'the supplier is parked before servicing');
  put(lorry, place + SUPPLY_REACH * .75); put(tank, place - SUPPLY_REACH * .75);
  assert(f.until(() => [supply, lorry, tank].every(id => unit(alice, id).calm && f.speed(id) < .01), CALM_SECONDS + 5),
    'the carriers finish settling and leave contact cooldown before the service assay');
  // The lorry ran dry out here. Nothing hit it: it is fuelled the next time the field looks.
  set(part(lorry, 'fuel'), { fuelLitres: 0 });
  const dry = unit(alice, lorry);
  assert.deepEqual(dry.rearm, bill(0, 0, 0, designed(f, lorry, 'fuel').fuelLitres)); assert.deepEqual(dry.point, { supplier: supply, stock: carried, held: '', resupply: dry.rearm });
  run(.5);
  assert(Math.abs(part(lorry, 'fuel').fuelLitres - designed(f, lorry, 'fuel').fuelLitres) < .01); assert.deepEqual(aboard(), billSum(carried, dry.rearm, -1), 'to the litre');
  assert.deepEqual([unit(alice, lorry).rearm, cargo(lorry)], [bill(), load()], 'and the lorry was given fuel for its tank, not a load');
  // The tank fought: out of combat it is armed, and then held for a repair the supply vehicle pays whole.
  spent(f, tank, { litres: null }); run(1);
  const due = unit(alice, tank), before = aboard();
  assert(due.rearm.ferro > 1000 && due.repair.ferro > 0 && !due.calm);
  assert.deepEqual(due.point, { supplier: supply, stock: { ...before, combustivel: Math.floor(before.combustivel + 1e-6) }, held: '', resupply: due.rearm });
  run(CALM_SECONDS - 3); assert.deepEqual([aboard(), part(tank, 'ammo').rounds], [before, 3], 'in combat it waits');
  run(4);
  assert.equal(part(tank, 'ammo').rounds, designed(f, tank, 'ammo').rounds); assert.equal(record(tank).service?.kind, 'repair');
  assert.deepEqual(aboard(), billSum(billSum(before, due.rearm, -1), due.repair, -1), 'its load is less by the two bills');
  // The supply vehicle drives off: the repair it paid for is done all the same.
  put(supply, place + 300); assert(f.until(() => f.speed(supply) < .01, 5), 'the supplier parks away from the repair');
  assert.equal(unit(alice, tank).point, null); run(due.repairSeconds + 1);
  assert.deepEqual([unit(alice, tank).repair, unit(alice, tank).rearm, unit(alice, tank).service], [bill(), bill(), null]);
  assert.equal(part(tank, 'engine').health, part(tank, 'engine').maxHealth);
  assert.deepEqual(stock(alice), had, 'none of it came out of the stocks');
  // The supply vehicle itself, nearly dry out here: it is the point of its own fuel, and fills its tank out of what it carries (the next test).
  const ownFuel = designed(f, supply, 'fuel').fuelLitres - 5, leftFuel = carried.combustivel - dry.rearm.combustivel;
  set(part(supply, 'fuel'), { fuelLitres: 5 });
  assert.deepEqual([unit(alice, supply).rearm, unit(alice, supply).point], [bill(0, 0, 0, ownFuel), { supplier: supply, stock: bill(0, 0, 0, Math.floor(leftFuel + 1e-6)), held: '', resupply: bill(0, 0, 0, ownFuel) }]);
  run(1); assert.deepEqual([unit(alice, supply).rearm, aboard().combustivel], [bill(), leftFuel - ownFuel]);
  // In the base the base serves: the tank beside the supply vehicle is paid for by the stocks, and so is the supply vehicle.
  put(supply, base + 10); assert(f.until(() => f.speed(supply) < .01, 5), 'the supplier parks at its base');
  put(tank, base + 30); set(part(tank, 'ammo'), { rounds: 3 });
  assert.deepEqual(unit(alice, tank).point, BASE_POINT(due.rearm));
  run(.5);
  // Cargo loading retains its whole-unit batches; the fractional remainder stays aboard, never lost or charged twice.
  const usedFuel = dry.rearm.combustivel + ownFuel, restockedFuel = Math.floor(usedFuel + 1e-6),
    reloaded = { ...carried, combustivel: carried.combustivel - usedFuel + restockedFuel };
  assert.deepEqual([{ ...aboard(), combustivel: reloaded.combustivel }, unit(alice, tank).rearm, unit(alice, supply).rearm], [reloaded, bill(), bill()], 'it reloads whole supply units and gives nothing at the base');
  assert(Math.abs(aboard().combustivel - reloaded.combustivel) < 1e-8, 'the continuous fuel balance is conserved');
  assert.deepEqual(stock(alice), billSum(billSum(billSum(had, due.rearm, -1), due.rearm, -1), bill(due.repair.ferro, 0, 0, restockedFuel), -1), 'the stocks paid the tank and only the fuel actually loaded into supply cargo');
  assert.deepEqual([...room.faults], []);
});

test('a supply piece shot to pieces serves nobody with what it still holds: not a lorry beside it, nor the vehicle it is on', t => {
  const f = site(t, {}, 'Alice'), { players: [alice], publish, send, order, run, unit, put, part, set, clear } = f;
  const supply = publish(alice, crates), lorry = publish(alice, truck), place = clear(2400), aboard = () => f.aboard(supply);
  order(alice, 'control', { id: null }); f.filled(supply);
  const carried = aboard();
  put(supply, place); put(lorry, place + 20); assert.equal(unit(alice, supply).serves, true);
  set(part(supply, 'supply'), { health: 0 }); set(part(lorry, 'fuel'), { fuelLitres: 0 }); set(part(supply, 'fuel'), { fuelLitres: 5 });
  // Out of combat again, both still and side by side, and nothing is given: what it holds stays aboard, a wreck's load to be.
  run(CALM_SECONDS + 2);
  assert.deepEqual(aboard(), carried); assert(part(lorry, 'fuel').fuelLitres < .01 && part(supply, 'fuel').fuelLitres < 5.01, 'neither tank was filled');
  assert.deepEqual([unit(alice, lorry).point, unit(alice, supply).point], [null, null], 'and no page is told of a point there');
  assert.equal(unit(alice, supply).serves, false, 'nor that it is a supply vehicle');
  for (const id of [lorry, supply])
    assert.throws(() => send(alice, 'repair', { actorId: id }), /^Error: Leve a construção até a base, ou um veículo de suprimentos até ela, para reparar\.$/);
});

test('a supply vehicle gives what it has: what is short goes as far as it goes, a repair it does not pay the whole of mends the pieces it pays for, and ore serves nobody', t => {
  const f = site(t, {}, 'Alice'), { room, world, players: [alice], publish, send, order, run, unit, stock, cargo, held, put, part, set, stowed, record, clear } = f;
  const supply = publish(alice, crates), ore = publish(alice, truck), tank = publish(alice, 'ifv'), place = clear(2400),
    each = ammunitionCost(room.world.actor(tank).blueprint.modules.find(m => m.kind === 'ammo').ammoPreset), rounds = designed(f, tank, 'ammo').rounds,
    litres = designed(f, tank, 'fuel').fuelLitres, low = () => { set(part(tank, 'ammo'), { rounds: 9 }); set(part(tank, 'fuel'), { fuelLitres: 40 }); };
  order(alice, 'control', { id: null }); f.filled(supply);
  const had = { ...stock(alice) }, { ferro: iron, petroleo: fuel } = held(supply); assert(each >= 2);
  // A hauler full of ore beside it is no supply vehicle: what it carries is to be refined.
  put(supply, place + 400); put(ore, place); stowed(ore, 'hopper', { ferro: 5000 }); put(tank, place + 10); low(); run(2);
  const need = unit(alice, tank);
  assert.deepEqual([need.point, cargo(ore)], [null, load(5000)]); assert.deepEqual(need.rearm, bill(Math.round((rounds - 9) * each), 0, 0, litres - 40));
  assert.throws(() => send(alice, 'repair', { actorId: tank }), /^Error: Leve a construção até a base, ou um veículo de suprimentos até ela, para reparar\.$/);
  // Supplies of iron alone arm it, and have no fuel to give.
  stowed(supply, 'supply', { ferro: iron }); put(supply, place + 20); run(.5);
  assert.deepEqual([part(tank, 'ammo').rounds, held(supply)], [rounds, load(iron - need.rearm.ferro)]); assert(Math.abs(part(tank, 'fuel').fuelLitres - 40) < .01);
  assert.deepEqual([unit(alice, tank).rearm, unit(alice, tank).point], [bill(0, 0, 0, need.rearm.combustivel), { supplier: supply, stock: bill(iron - need.rearm.ferro), held: '', resupply: bill() }]);
  // Fuel alone fuels it.
  set(part(tank, 'ammo'), { rounds: 9 }); stowed(supply, 'supply', { petroleo: fuel }); run(.5);
  assert(Math.abs(part(tank, 'fuel').fuelLitres - litres) < .01); assert.deepEqual([part(tank, 'ammo').rounds, held(supply)], [9, load(0, 0, 0, fuel - need.rearm.combustivel)]);
  // Iron for two rounds and a half, and thirty litres: two rounds and thirty litres, and what is left over stays aboard.
  stowed(supply, 'supply', { ferro: 2.5 * each, petroleo: 30 }); low(); run(.5);
  assert.equal(part(tank, 'ammo').rounds, 11); assert(Math.abs(part(tank, 'fuel').fuelLitres - 70) < .01);
  assert.deepEqual(held(supply), load(.5 * each));
  assert.deepEqual(unit(alice, tank).rearm, bill(Math.round((rounds - 11) * each), 0, 0, litres - 70));
  // Hit in its engine and its camera, with supplies for all of it but a unit: the engine is mended first, whole, and the
  // camera as far as the rest goes.
  set(part(tank, 'ammo'), { rounds }); set(part(tank, 'fuel'), { fuelLitres: litres }); stowed(supply, 'supply', {});
  const engine = () => part(tank, 'engine'), camera = () => part(tank, 'sensor');
  set(engine(), { health: engine().maxHealth * .5 }); set(camera(), { health: camera().maxHealth * .4 }); run(1);
  const { mendable } = appraise(world.actor(tank), fieldParts(world)), [first, second] = mendable;
  assert.deepEqual(mendable.map(piece => [piece.id, piece.stock]), [[engine().id.split(':').pop(), 'ferro'], [camera().id.split(':').pop(), 'ferro']], 'the engine before the camera');
  assert(first.cost > 50 && second.cost > 50);
  stowed(supply, 'supply', { ferro: first.cost + second.cost - 1 }); run(CALM_SECONDS + 2);
  const service = record(tank).service, share = (second.cost - 1) / second.cost;
  assert.deepEqual([service?.kind, service?.pieces, service?.cost, held(supply)],
    ['repair', [{ id: first.id, share: 1 }, { id: second.id, share }], bill(first.cost + second.cost - 1), load()]);
  assert.deepEqual(unit(alice, tank).service.partial, true); assert.equal(unit(alice, tank).mend, null, 'under repair there is nothing more to mend now');
  const hurt = camera().health; run(service.until - world.time + 1);
  assert.deepEqual([record(tank).service, engine().health], [null, engine().maxHealth], 'the engine is whole again');
  assert(Math.abs(camera().health - (hurt + (camera().maxHealth - hurt) * share)) < 1e-6 && camera().health < camera().maxHealth, 'the camera all but whole');
  const rest = unit(alice, tank).repair.ferro; assert(rest >= 1 && rest <= 2, `${rest} left to mend`);
  // With nothing aboard nothing is begun, and the reason is said.
  run(CALM_SECONDS + 2); assert.deepEqual([record(tank).service, unit(alice, tank).mend], [null, null]);
  assert.throws(() => send(alice, 'repair', { actorId: tank }), new RegExp(`^Error: Os suprimentos ao alcance não pagam o reparo: Ferro 0 de ${rest}\\.$`));
  // Hit in its engine again, with supplies for less than a tenth of that: not worth holding it for, and nothing is begun.
  // With a third of it, a third of what the engine lacked is mended.
  set(engine(), { health: engine().maxHealth * .4 }); run(CALM_SECONDS + 2);
  const lacked = appraise(world.actor(tank), fieldParts(world)).mendable[0], before = engine().health, third = Math.floor(lacked.cost / 3);
  assert.equal(lacked.id, first.id); stowed(supply, 'supply', { ferro: Math.floor(lacked.cost / 12) }); run(CALM_SECONDS + 2);
  assert.deepEqual([record(tank).service, unit(alice, tank).mend, held(supply)], [null, null, load(Math.floor(lacked.cost / 12))]);
  stowed(supply, 'supply', { ferro: third }); run(.5);
  assert.deepEqual([record(tank).service?.pieces, held(supply)], [[{ id: first.id, share: third / lacked.cost }], load()]);
  run(record(tank).service.until - world.time + 1);
  assert(Math.abs(engine().health - (before + (engine().maxHealth - before) * third / lacked.cost)) < 1e-6, 'a third of the way back');
  // Enough for all of it: the whole repair, as at the base.
  stowed(supply, 'supply', { ferro: unit(alice, tank).repair.ferro }); run(.5);
  assert.deepEqual([record(tank).service?.kind, record(tank).service?.pieces, held(supply)], ['repair', null, load()]);
  assert.deepEqual(stock(alice), had, 'and the stocks paid for none of it'); assert.deepEqual([...room.faults], []);
});

test('a supply piece digs nothing and hauls nothing: a hauler with one hauls with its hopper and serves out of it; a supply vehicle serves only while it stands still, out of combat', t => {
  const f = site(t, {}, 'Alice'), { room, deposit, base, players: [alice], publish, order, run, until, unit, squad, cargo, held, aboard, put, part, set, stowed, clear } = f;
  const supply = publish(alice, crates), both = publish(alice, miningDigger), tank = publish(alice, 'scout'), rounds = designed(f, tank, 'ammo').rounds;
  order(alice, 'control', { id: null }); f.filled(supply, both);
  // By a deposit, with room in its supply piece, it loads no ore: the hopper beside it does, and the supply piece of that one takes none either.
  stowed(supply, 'supply', { ferro: 100 }); const kept = held(both); put(supply, deposit.x + 5); put(both, workArea(room.world, both, deposit, LOAD_REACH).goal); run(4);
  assert.deepEqual([held(supply), cargo(supply)], [load(100), load()]); assert(cargo(both).ferro > 100);
  const now = held(both);
  assert.deepEqual({ ...now, petroleo: kept.petroleo }, kept, 'mining adds no ore to the supply crate');
  assert(now.petroleo <= kept.petroleo, 'fuel in its supplies can pay its own working tank');
  assert.deepEqual([unit(alice, supply).loading, unit(alice, both).loading], [null, deposit.id]);
  // Sent to haul alone it is refused in words: it has no hopper.
  assert.throws(() => order(alice, 'haul', { ids: [supply], depositId: deposit.id }), /^Error: Instale uma Escavadeira para extrair minério ou uma Caçamba para transportá-lo\.$/);
  // The hauler brings its ore home under its haul, and its supply piece, emptied meanwhile, is filled up there.
  put(supply, deposit.x + 40); // leave the actual loading bay clear for the return trip
  order(alice, 'haul', { ids: [both], depositId: deposit.id }); stowed(both, 'supply', {}); stowed(both, 'hopper', { ferro: 1e9 });
  assert(until(() => squad(alice, both).haul?.phase === 'load' && cargo(both).ferro < 100, 240), 'it tips its ore at the base and goes back');
  assert(aboard(both).ferro > 0 && aboard(both).combustivel > 0, 'filled up as it stood in its base');
  // Out of its supply piece a tank beside it is armed.
  order(alice, 'stop', { ids: [both] });
  const place = clear(2400); put(both, place); put(tank, place + 10); put(supply, place + 800); set(part(tank, 'ammo'), { rounds: 3 }); run(1);
  assert.deepEqual([unit(alice, tank).point.supplier, part(tank, 'ammo').rounds], [both, rounds]);
  // Hit, a supply vehicle serves nobody until it is calm: the tank beside it, out of combat itself, waits.
  put(both, place + 1600); stowed(supply, 'supply', { ferro: 3000 }); put(supply, place);
  assert(until(() => f.speed(supply) < .01, 5), 'the supplier stops before it is hit');
  set(part(tank, 'ammo'), { rounds: 3 }); set(part(supply, 'command'), { health: part(supply, 'command').maxHealth - 1 }); run(1);
  assert.deepEqual([unit(alice, tank).point.held, unit(alice, tank).calm, part(tank, 'ammo').rounds], ['combat', true, 3]);
  run(CALM_SECONDS); assert.deepEqual([unit(alice, tank).point.held, part(tank, 'ammo').rounds], ['', rounds]);
  // On its way to the tank it serves nobody either: it does when it stops beside it.
  put(tank, base - 320); put(supply, base - 170); set(part(tank, 'ammo'), { rounds: 3 }); run(1); assert.equal(unit(alice, tank).point, null);
  order(alice, 'move', { ids: [supply], x: base - 311 });
  let passing = false;
  assert(until(() => { if (unit(alice, tank).point?.held === 'moving') { passing = true; assert.equal(part(tank, 'ammo').rounds, 3); } return !squad(alice, supply).move; }, 60), 'it arrives');
  assert(passing, 'it came into reach before it stopped'); run(2); assert.equal(part(tank, 'ammo').rounds, rounds);
  assert.deepEqual([...room.faults], []);
});

test('a supply vehicle destroyed is a wreck with a load like any other: a hauler takes it, a supply piece does not, and home it is refined', t => {
  const f = site(t, { stock: bill(200000, 0, 0, 6000) }, 'Alice'), { room, world, base, players: [alice], publish, send, order, run, view, unit, stock, yard, cargo, held, put, set, stowed, clear } = f;
  const supply = publish(alice, kit), other = publish(alice, kit), hauler = publish(alice, both), place = clear(700);
  order(alice, 'control', { id: null }); f.filled(supply, other);
  const aboard = held(supply); assert(aboard.ferro > 1000 && aboard.petroleo > 200);
  put(supply, place); put(other, place + 10); stowed(other, 'supply', { ferro: 50, petroleo: 50 });
  for (const post of world.modules.filter(m => m.actorId === supply && m.kind === 'command')) set(post, { health: 0 });
  run(.5);
  assert.deepEqual([world.actor(supply).defeated, held(supply)], [true, aboard], 'nobody\'s, with all it carried');
  assert.deepEqual(view(alice).wrecks.map(w => [w.id, w.cargo]), [[supply, aboard]]); run(CALM_SECONDS);
  // The supply vehicle beside it has room, and takes none of the load: what the wreck is worth goes to the stocks, and its load waits.
  const worth = view(alice).wrecks[0].value, had = { ...stock(alice) };
  assert.deepEqual(send(alice, 'salvage', { wreckId: supply }), { salvaged: supply, value: worth, cargo: load(), left: aboard });
  assert.deepEqual([stock(alice), held(other)], [billSum(had, worth), load(50, 0, 0, 50)]);
  assert.throws(() => send(alice, 'salvage', { wreckId: supply }), /^Error: Nenhuma construção sua junto dos destroços tem caçamba ou cisterna com espaço para a carga\.$/);
  // A hauler takes it as a load like any other, ore into its hopper and petroleum into its cistern, and serves nobody with it.
  put(hauler, place - 10); run(CALM_SECONDS);
  assert.deepEqual(send(alice, 'salvage', { wreckId: supply }), { salvaged: supply, value: bill(), cargo: aboard, left: load() });
  assert.deepEqual([cargo(hauler), unit(alice, hauler).supplies, held(other)], [aboard, null, load(50, 0, 0, 50)]); assert(!world.actor(supply), 'and nothing is left of the wreck');
  // The supply vehicle short of fuel beside it gives itself the fifty litres it carries, and of the hauler's load it gets none.
  set(world.modules.find(m => m.actorId === other && m.kind === 'fuel'), { fuelLitres: 5 }); run(1);
  assert.deepEqual([unit(alice, other).point, unit(alice, other).rearm, held(other)], [null, bill(0, 0, 0, designed(f, other, 'fuel').fuelLitres - 55), load(50)], 'a hauler with a load beside it is no supply vehicle');
  // Home, it is tipped into the yard and refined into the stocks it came from.
  const before = { ...stock(alice) }; put(hauler, base + 40);
  assert.deepEqual(cargo(hauler), load()); run(loadTotal(aboard) / REFINE_RATE + 2);
  assert.deepEqual(yard(alice), load()); assert(Math.abs(stock(alice).ferro - before.ferro - aboard.ferro) < 1e-6 && Math.abs(stock(alice).combustivel - before.combustivel - aboard.petroleo * YIELD.petroleo) < 1e-6,
    'its cans of fuel come back as petroleum, refined as any other');
});

test('a supply vehicle away from the base serves what stands beside it, and another beside that one serves it, not what stands past it', t => {
  const f = site(t, {}, 'Alice'), { room, players: [alice], publish, order, run, unit, part, set, stowed, put, clear } = f;
  const tank = publish(alice, 'scout'), kits = [publish(alice, kit), publish(alice, kit)], place = clear(2400),
    apart = (a, b) => room.works.gap(room.world.actor(a), room.works.hull(room.world.actor(b))), rounds = () => part(tank, 'ammo').rounds;
  order(alice, 'control', { id: null }); f.filled(...kits);
  const carried = f.held(kits[0]);
  // The tank away from home, one supply vehicle 3 m off it end to end, and the other 3 m past that one: further from the
  // tank than a supply vehicle hands over (SUPPLY_REACH), by the length of the one between them.
  put(tank, place); put(kits[0], place + 9); put(kits[1], place + 19);
  assert(apart(kits[0], tank) <= SUPPLY_REACH && apart(kits[1], kits[0]) <= SUPPLY_REACH, 'each beside the next');
  assert(apart(kits[1], tank) > SUPPLY_REACH, `the second ${apart(kits[1], tank).toFixed(1)} m off the tank`);
  // With nothing aboard the one beside it, the tank short of rounds gets none from the one past it.
  stowed(kits[0], 'supply', {}); set(part(tank, 'ammo'), { rounds: 3 }); run(.5);
  assert.equal(rounds(), 3); assert.notEqual(unit(alice, tank).point?.supplier, kits[1], 'the one past it is no point of the tank');
  // Given its supplies back, the one beside it arms it from where it stands.
  stowed(kits[0], 'supply', carried); run(.5);
  assert.equal(unit(alice, tank).point?.supplier, kits[0]); assert.equal(rounds(), designed(f, tank, 'ammo').rounds);
  // And the one past it, beside that one, fuels it.
  stowed(kits[0], 'supply', {}); set(part(kits[0], 'fuel'), { fuelLitres: 5 }); run(.5);
  assert(Math.abs(part(kits[0], 'fuel').fuelLitres - designed(f, kits[0], 'fuel').fuelLitres) < .01); assert.deepEqual([...room.faults], []);
});

test('with two supply vehicles in reach the panel offers a repair as the field does it: from the one that pays for it, however near the other is', t => {
  const f = site(t, {}, 'Alice'), { room, players: [alice], publish, send, order, run, view, unit, put, part, stowed, record, clear } = f;
  const tank = publish(alice, 'scout'), near = publish(alice, crates), far = publish(alice, crates), place = clear(2400), aboard = id => f.aboard(id),
    named = id => id === near ? 'veículo 2' : id === far ? 'veículo 3' : 'veículo 1',
    // The repair of the construction in the player's hands is a job of its panel: it waits to be asked for.
    job = (id, work) => unitServices(unit(alice, id), view(alice), { named, hand: room.players.get(alice.playerId).squad.manual === id }).jobs.find(each => each.id === work),
    full = id => Math.abs(part(id, 'fuel').fuelLitres - designed(f, id, 'fuel').fuelLitres) < .01;
  order(alice, 'control', { id: tank });
  // The nearer carries fuel and no iron; the farther, still in reach, iron and no fuel. Out of the base, they take on nothing more.
  // Constructions pass through one another: the two stand into each other, each beside the tank (SUPPLY_REACH).
  put(tank, place); put(near, place + 9); put(far, place + 12);
  stowed(near, 'supply', { petroleo: 800 }); stowed(far, 'supply', { ferro: 8000 });
  // A tank short of fuel and hit in its engine: out of combat the nearer fuels it by itself, and the farther is the one that pays its repair.
  spent(f, tank, { rounds: null, left: .5 }); run(1); assert(unit(alice, tank).rearm.combustivel > 0 && !full(tank));
  run(CALM_SECONDS);
  const due = unit(alice, tank); assert(due.calm && due.repair.ferro > 0 && due.repair.ferro < 4000);
  assert.deepEqual([due.rearm, due.service, aboard(far)], [bill(), null, bill(8000)]); assert(full(tank) && aboard(near).combustivel < 800, 'fuelled by the nearer');
  assert.deepEqual([job(tank, 'repair').text, job(tank, 'repair').disabled], [`Reparar · ${billText(due.repair)} · ${due.repairSeconds} s · suprimentos do veículo 3`, false]);
  const carried = aboard(far); send(alice, 'repair', { actorId: tank });
  assert.deepEqual([record(tank).service.payer, aboard(far)], [far, billSum(carried, due.repair, -1)]);
  // The nearer itself, dry and hit, in the player's hands: it fuels itself out of what it carries, and the farther pays its repair, as the field has it.
  order(alice, 'control', { id: near });
  const fuel = aboard(near).combustivel; spent(f, near, { rounds: null, litres: 5, left: .5 }); run(CALM_SECONDS + 1);
  const own = unit(alice, near), left = aboard(far); assert(own.calm && own.repair.ferro > 0);
  assert.deepEqual([own.rearm, own.service], [bill(), null]); assert(full(near) && aboard(near).combustivel < fuel, 'out of its own fuel');
  assert.deepEqual([job(near, 'repair').text, job(near, 'repair').disabled], [`Reparar · ${billText(own.repair)} · ${own.repairSeconds} s · suprimentos do veículo 3`, false]);
  send(alice, 'repair', { actorId: near });
  assert.deepEqual([record(near).service.payer, aboard(far)], [far, billSum(left, own.repair, -1)]); assert.deepEqual([...room.faults], []);
});

test('a repair cancelled mends nothing and gives its bill back to what paid it: the stocks, the supply vehicle as far as it has room, and nobody when that one is gone', t => {
  const f = site(t, {}, 'Alice'), { room, base, players: [alice], publish, send, order, run, until, unit, squad, stock, cargo, put, part, set, stowed, record, clear, x } = f;
  const tank = publish(alice, 'scout'), supply = publish(alice, crates), place = clear(2400), aboard = () => f.aboard(supply), engine = () => part(tank, 'engine');
  order(alice, 'control', { id: null }); f.filled(supply); put(supply, place);
  // In its base, mended unasked and paid by the stocks. Cancelled, the whole bill is in the stocks again, nothing is mended and the construction is free.
  const had = { ...stock(alice) }; set(engine(), { health: engine().maxHealth * .5 }); run(CALM_SECONDS + 1);
  const due = unit(alice, tank).repair, held = unit(alice, tank).service;
  assert(due.ferro > 200 && unit(alice, tank).repairSeconds > 6); assert.deepEqual([held.cost, held.payer, stock(alice)], [due, null, billSum(had, due, -1)]);
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: tank }), { refund: due, lost: bill(), supplier: null, gone: false });
  assert.deepEqual([stock(alice), record(tank).service, room.world.snapshot().actors.find(a => a.id === tank).field, unit(alice, tank).repair, unit(alice, tank).declined], [had, null, null, due, true]);
  assert.equal(engine().health, engine().maxHealth * .5);
  assert.throws(() => send(alice, 'cancel-repair', { actorId: tank }), /^Error: Essa construção não está em reparo\.$/);
  // Where it stands no repair begins by itself again, however long it waits. It answers its orders at once; moved away and stopped, it is mended again.
  run(CALM_SECONDS + 3); assert.deepEqual([record(tank).service, stock(alice), unit(alice, tank).declined], [null, had, true]);
  order(alice, 'move', { ids: [tank], x: x(tank) + 30 }); run(1); assert(squad(alice, tank).move && Math.abs(room.world.actor(tank).vehicle.vx) > .5, 'it drives off');
  assert(until(() => record(tank).service, 30), 'stopped somewhere else in its base, it is mended by itself'); assert.equal(unit(alice, tank).declined, false);
  // Cancelled once more, the player asks for it where it stands, and that is done.
  send(alice, 'cancel-repair', { actorId: tank }); run(2); assert.equal(record(tank).service, null);
  const afterDrive = { ...stock(alice) };
  assert.deepEqual({ ...afterDrive, combustivel: had.combustivel }, had, 'the drive changes fuel, not the repair refund');
  assert(afterDrive.combustivel <= had.combustivel, 'returning is paid with actual fuel');
  assert.deepEqual(send(alice, 'repair', { actorId: tank }).cost, due); assert.deepEqual([unit(alice, tank).declined, record(tank).service.payer], [false, null]);
  send(alice, 'cancel-repair', { actorId: tank }); assert.deepEqual(stock(alice), afterDrive);
  // At the front the supply vehicle beside it pays. Cancelled, the bill is in its supply piece again, to the unit. In the
  // player's hands there, it waits for its repair to be asked for.
  order(alice, 'control', { id: tank }); put(tank, place + 10);
  const carried = aboard(); send(alice, 'repair', { actorId: tank });
  assert.deepEqual([unit(alice, tank).service.payer, aboard()], [supply, billSum(carried, due, -1)]);
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: tank }), { refund: due, lost: bill(), supplier: supply, gone: false });
  assert.deepEqual([aboard(), stock(alice), record(tank).service], [carried, afterDrive, null]);
  // With room for a part of it only, that part goes back and the rest is lost.
  send(alice, 'repair', { actorId: tank });
  const fits = cargoRoom(part(supply, 'supply')) * CARGO.ferro.density; stowed(supply, 'supply', { ferro: fits - 100 });
  const some = send(alice, 'cancel-repair', { actorId: tank });
  assert(Math.abs(some.refund.ferro - 100) < 1e-6 && Math.abs(some.lost.ferro - (due.ferro - 100)) < 1e-6, `${some.refund.ferro} back, ${some.lost.ferro} lost`);
  assert.deepEqual([some.supplier, some.gone], [supply, false]); assert(Math.abs(aboard().ferro - fits) < 1e-6);
  // The supply vehicle that paid was destroyed meanwhile: what it carried is a wreck's load, nothing is put into it, and the bill is lost.
  stowed(supply, 'supply', { ferro: 3000 }); send(alice, 'repair', { actorId: tank });
  for (const post of room.world.modules.filter(m => m.actorId === supply && m.kind === 'command')) set(post, { health: 0 });
  run(.5); const wrecked = f.held(supply), shelved = { ...stock(alice) }; assert(room.world.actor(supply).defeated);
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: tank }), { refund: bill(), lost: due, supplier: supply, gone: true });
  assert.deepEqual([f.held(supply), stock(alice), record(tank).service], [wrecked, shelved, null]);
  assert.equal(engine().health, engine().maxHealth * .5); assert.deepEqual([...room.faults], []);
});

test('a repair cancelled gives its bill back into no supply piece that no longer serves: in its base the stocks take it, and anywhere else it is lost', t => {
  const f = site(t, {}, 'Alice'), { base, players: [alice], publish, send, order, put, run, unit, stock, part, set, record, clear } = f;
  const tank = publish(alice, 'scout'), first = publish(alice, crates), second = publish(alice, crates), place = clear(2400), engine = part(tank, 'engine'),
    paid = supplier => { send(alice, 'repair', { actorId: tank }); assert.equal(record(tank).service.payer, supplier); },
    broken = supplier => { set(part(supplier, 'supply'), { health: 0 }); run(.5); };
  // The tank is in the player's hands: its repairs wait to be asked for.
  order(alice, 'control', { id: tank });
  f.filled(first, second);
  put(first, place); put(tank, place + 10); set(engine, { health: engine.maxHealth * .5 }); run(CALM_SECONDS + 1);
  const due = unit(alice, tank).repair;
  // The supply vehicle that paid is back in its base when its supply piece is shot to pieces: the bill goes to the stocks.
  paid(first); put(first, base); broken(first);
  const had = { ...stock(alice) };
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: tank }), { refund: due, lost: bill(), supplier: null, gone: false });
  assert.deepEqual(stock(alice), billSum(had, due));
  // Beside the construction it paid for, it puts nothing back into a piece that serves nobody: the bill is lost, and what that piece holds stays as it was.
  put(second, place + 20); assert(f.until(() => f.speed(second) < .01, 5), 'the second supplier stops before paying');
  paid(second); broken(second);
  const aboard = f.aboard(second);
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: tank }), { refund: bill(), lost: due, supplier: second, gone: false });
  assert.deepEqual(f.aboard(second), aboard);
});

test('a construction made another where its repair was cancelled is a new one: nothing waits to be asked for, and it is mended by itself there', t => {
  const f = site(t, {}, 'Alice'), { players: [alice], publish, send, order, run, unit, part, set, record } = f;
  const tank = publish(alice, 'scout'), engine = () => part(tank, 'engine');
  order(alice, 'control', { id: null }); run(1);
  set(engine(), { health: engine().maxHealth * .5 }); run(CALM_SECONDS + 1);
  assert.equal(record(tank).service?.kind, 'repair'); send(alice, 'cancel-repair', { actorId: tank });
  assert.equal(unit(alice, tank).declined, true);
  publish(alice, 'scout', { actorId: tank });
  assert.deepEqual([unit(alice, tank).declined, record(tank).declined], [false, null]);
  // Hit where it stands, it is mended there by itself once out of combat, as any other.
  run(1); set(engine(), { health: engine().maxHealth * .5 }); run(CALM_SECONDS + 1);
  assert.equal(record(tank).service?.kind, 'repair');
});

test('a hauler whose repair is cancelled by its deposit goes on with its haul, is not mended again where it stands, and is once it has driven home and stopped', t => {
  const f = site(t, {}, 'Alice'), { room, deposit, base, players: [alice], publish, send, order, run, until, unit, squad, cargo, put, stowed, record, x } = f;
  const id = publish(alice, miningTruck), supply = publish(alice, crates), phase = () => squad(alice, id).haul?.phase, iron = () => f.held(supply).ferro;
  order(alice, 'control', { id: null }); f.filled(supply); put(supply, deposit.x + 40);
  order(alice, 'haul', { ids: [id], depositId: deposit.id });
  assert(until(() => phase() === 'load' && cargo(id).ferro > 100, 120), 'it loads');
  // The supply vehicle comes beside it where it loads, 3 m off it end to end, on the side away from the deposit.
  put(supply, x(id) + Math.sign(x(id) - deposit.x || 1) * 10);
  // Hit by the deposit: calm again, the supply vehicle beside it mends it unasked, and it loads nothing meanwhile.
  const aboard = iron(); spent(f, id, { rounds: null, litres: null, piece: 'command', left: .6 });
  assert(until(() => record(id).service, CALM_SECONDS + 3), 'it is held for the repair');
  const due = record(id).service.cost, loaded = cargo(id).ferro; run(1);
  assert.deepEqual([record(id).service.payer, iron(), cargo(id).ferro, phase()], [supply, aboard - due.ferro, loaded, 'load']);
  // Cancelled: the bill is back aboard the supply vehicle, and the hauler loads again under the order it had.
  assert.deepEqual(send(alice, 'cancel-repair', { actorId: id }), { refund: due, lost: bill(), supplier: supply, gone: false });
  assert.deepEqual([iron(), squad(alice, id).haul], [aboard, { depositId: deposit.id, material: 'ferro', phase: 'load' }]);
  assert(until(() => cargo(id).ferro > loaded + 100, 10), 'free at once, it loads on');
  run(CALM_SECONDS + 2); assert.deepEqual([record(id).service, unit(alice, id).declined, iron()], [null, true, aboard], 'and beside the supply vehicle no repair begins by itself');
  // Full, it drives home under the same haul: there, having moved and stopped, it is mended by the base unasked.
  stowed(id, 'hopper', { ferro: FULL - 150 });
  assert(until(() => phase() === 'home', 15), 'full, it turns for home');
  assert(until(() => record(id).service, 180), 'in its base it is held for the repair');
  assert.deepEqual([record(id).service.payer, unit(alice, id).declined, squad(alice, id).haul.phase], [null, false, 'unload']); assert(Math.abs(x(id) - base) <= BASE_RADIUS);
  assert.deepEqual([...room.faults], []);
});

for (const partial of [false, true]) test(`a blocked homeward haul resumes after a real ${partial ? 'partial' : 'full'} repair completes`, t => {
  const f = site(t, {}, 'Alice'), { room, world, deposit, base, players: [alice], publish, order, run, until, part, set, put, unit, record, stowed, x } = f,
    id = publish(alice, miningTruck), supply = publish(alice, crates), pilot = room.players.get(alice.playerId).squad, work = () => pilot.units.get(id);
  order(alice, 'control', { id: null }); f.filled(supply);
  put(id, deposit.x); put(supply, deposit.x + 10);
  set(part(id, 'engine'), { health: 0 }); run(.5);
  // The supply vehicle beside it pays for all of the repair, or for half of it.
  const due = unit(alice, id).repair;
  if (partial) stowed(supply, 'supply', { ferro: Math.floor(due.ferro / 2) });
  order(alice, 'haul', { ids: [id], depositId: deposit.id }); work().haul.fled = true;
  assert(until(() => Boolean(work().haul?.blocked), 30), 'the destroyed engine blocks the actual drive home');
  assert.equal(work().move, null); assert.equal(work().haul.phase, 'home');
  // Stopped where it is and out of combat, it is mended there by itself.
  assert(until(() => record(id).service, CALM_SECONDS + 2), 'the repair begins');
  assert.equal(record(id).service.kind, 'repair');
  assert.equal(Boolean(record(id).service.pieces), partial, 'exercises Room.fix for partial and Room.restore for full repairs');
  assert(until(() => !record(id).service, 60), 'the real repair service completes');
  assert(part(id, 'engine').health > 0);
  assert.equal(work().haul?.blocked, undefined, 'renewal releases the old mobility failure');
  const stoppedAt = x(id);
  assert(until(() => Math.abs(x(id) - stoppedAt) > 2, 10), 'the repaired hauler physically drives again');
  assert(until(() => !work().haul, 90), 'the preserved order takes it home');
  assert(Math.abs(x(id) - base) <= BASE_RADIUS); assert.equal(work().reason, 'enemy-near');
  assert.deepEqual([...room.faults], []);
});

test('a supply vehicle short of fuel away from its base fills its own tank out of the fuel it carries, and gives itself neither rounds nor a repair', t => {
  const f = site(t, {}, 'Alice'), { room, players: [alice], publish, send, order, run, unit, cargo, put, part, set, stowed, record, clear } = f;
  const supply = publish(alice, racked), place = clear(2400), aboard = () => f.aboard(supply), litres = designed(f, supply, 'fuel').fuelLitres, fuel = () => part(supply, 'fuel').fuelLitres;
  order(alice, 'control', { id: null }); f.filled(supply); put(supply, place);
  assert(f.until(() => f.speed(supply) < .01, 5), 'the supplier stops before its fuel and damage are changed');
  const carried = aboard(); assert(carried.ferro > 1000 && carried.combustivel > 800);
  // Dry at the front, short of rounds and hit, with iron and fuel aboard: it is the point of its own fuel, and of nothing else.
  spent(f, supply, { rounds: 3, litres: 0, piece: 'engine', left: .5 }); run(1);
  const due = unit(alice, supply);
  assert(due.rearm.ferro > 0 && due.rearm.combustivel === litres && due.repair.ferro > 0);
  assert.deepEqual(due.point, { supplier: supply, stock: bill(0, 0, 0, carried.combustivel), held: 'combat',
    calmUntil: record(supply).combatAt + CALM_SECONDS, resupply: bill(0, 0, 0, due.rearm.combustivel) });
  run(CALM_SECONDS - 4); assert.deepEqual([fuel(), aboard()], [0, carried], 'in combat it waits, as any service does');
  // Calm and stopped, its tank is filled out of its supply piece, litre for litre. Its rack and its damage are as they were, and its iron is untouched.
  run(5);
  assert(Math.abs(fuel() - litres) < .01); assert.deepEqual(aboard(), billSum(carried, bill(0, 0, 0, due.rearm.combustivel), -1));
  assert.deepEqual([part(supply, 'ammo').rounds, record(supply).service, unit(alice, supply).repair, unit(alice, supply).rearm], [3, null, due.repair, bill(due.rearm.ferro)]);
  run(3); assert.deepEqual([record(supply).service, aboard().ferro], [null, carried.ferro]);
  // Its own repair, asked for, is refused as where nothing serves.
  assert.throws(() => send(alice, 'repair', { actorId: supply }), /^Error: Leve a construção até a base, ou um veículo de suprimentos até ela, para reparar\.$/);
  // With no fuel aboard it has no point at all: the iron it carries fuels nothing.
  stowed(supply, 'supply', { ferro: carried.ferro }); set(part(supply, 'fuel'), { fuelLitres: 5 }); run(1);
  assert.deepEqual([unit(alice, supply).point, Math.round(fuel()), aboard().ferro], [null, 5, carried.ferro]); assert.deepEqual([...room.faults], []);
});

test('anywhere on the field a construction tips out a quarter of what its hoppers and its cisterns hold when full, each thing in its share, and what comes out is lost', t => {
  // The shares, on round numbers: two cubic metres of hopper and a thousand litres of cistern.
  const round = { solid: 2, liquid: 1 };
  assert(near(dumpOf(load(2400, 0, 1600, 500), round), load(600, 0, 400, 250), 1e-9), 'of a full hopper a quarter of each ore, and of a cistern half full half of what it holds');
  assert.deepEqual(dumpOf(load(480, 0, 0, 100), round), load(480, 0, 0, 100), 'all there is, when that is less than a quarter of the room');
  assert.deepEqual([dumpOf(load(1200), round), dumpOf(load(), round)], [load(1200), load()], 'the last quarter goes whole, and nothing comes out of nothing');

  const f = site(t, { stock: bill(300000, 30000, 30000, 9000) }, 'Alice'),
    { room, base, players: [alice], publish, send, order, run, put, clear, unit, stock, yard, cargo, mass, part, set, stowed, record } = f;
  const lorry = publish(alice, both), away = clear(1500), tip = () => send(alice, 'dump-cargo', { actorId: lorry }), space = () => carriedBy(room.pieces(lorry)).room,
    less = (amounts, out) => load(...RAW_IDS.map(id => amounts[id] - out[id])), whole = amounts => load(...RAW_IDS.map(id => Math.round(amounts[id])));
  order(alice, 'control', { id: null }); put(lorry, away);
  assert.throws(tip, /^Error: Essa construção não leva carga para despejar\.$/);
  // Its hopper full of iron and its cistern of petroleum, far from its base and from any vein: a quarter of each comes out, and it weighs that much less.
  stowed(lorry, 'hopper', { ferro: 1e9 }); stowed(lorry, 'cistern', { petroleo: 1e9 }); run(.5);
  const full = cargo(lorry), had = { ...stock(alice) }, heaped = { ...yard(alice) }, heavy = mass(lorry);
  assert(full.ferro > 3000 && full.petroleo > 1000);
  assert.deepEqual(tip(), { dumped: load(Math.round(full.ferro / 4), 0, 0, Math.round(full.petroleo / 4)) });
  assert(near(cargo(lorry), load(full.ferro * .75, 0, 0, full.petroleo * .75)));
  assert.deepEqual([stock(alice), yard(alice)], [had, heaped], 'it went into no stock and no yard');
  run(.5); assert(Math.abs(heavy - mass(lorry) - full.ferro / 4 - full.petroleo / 4 * CARGO.petroleo.density / 1000) <= 20, 'a tonne lighter');
  // Three ores, each three tenths of the hopper: a quarter of its room is the same share of each. The cistern, at three quarters, loses a third.
  const tenths = cargoRoom(part(lorry, 'hopper')) * .3; stowed(lorry, 'hopper', { ferro: tenths * CARGO.ferro.density, ligas: tenths * CARGO.ligas.density, silica: tenths * CARGO.silica.density }); run(.5);
  const mixed = cargo(lorry), kept = 1 - .25 / .9; tip();
  assert(near(cargo(lorry), load(mixed.ferro * kept, mixed.ligas * kept, mixed.silica * kept, mixed.petroleo * 2 / 3)), 'each thing in the share it is of what they carry');
  // With less than a quarter of its room in the hopper all of that goes; the cistern, at a half, is left with a quarter, and that goes next.
  stowed(lorry, 'hopper', { silica: 300 }); run(.5);
  assert.deepEqual(tip(), { dumped: load(0, 0, 300, Math.round(full.petroleo / 4)) }); assert(near(cargo(lorry), load(0, 0, 0, full.petroleo / 4)));
  assert.deepEqual(tip(), { dumped: load(0, 0, 0, Math.round(full.petroleo / 4)) }); assert.deepEqual(cargo(lorry), load(), 'four times empty it, to the last unit');
  assert.throws(tip, /^Error: Essa construção não leva carga para despejar\.$/);
  // A supply piece tips nothing out: supplies go back to the stocks at the base, not onto the ground.
  const supply = publish(alice, crates); order(alice, 'control', { id: null }); f.filled(supply); put(supply, away + 20);
  const carried = f.held(supply), paid = { ...stock(alice) }; assert(carried.ferro > 0);
  assert.throws(() => send(alice, 'dump-cargo', { actorId: supply }), /^Error: Essa construção não leva carga para despejar\.$/);
  assert.deepEqual([f.held(supply), stock(alice)], [carried, paid]);
  // Under repair it tips nothing: it comes out of its repair with the load it went in with.
  put(lorry, base); set(part(lorry, 'engine'), { health: part(lorry, 'engine').maxHealth * .5 }); run(CALM_SECONDS + 1);
  assert.equal(record(lorry).service?.kind, 'repair', 'in its base it is mended by itself'); stowed(lorry, 'hopper', { ferro: 500 });
  assert.throws(tip, /^Error: Essa construção está em reparo\.$/); assert.equal(cargo(lorry).ferro, 500);
  assert.deepEqual([...room.faults], []);
});

test('transport-only trucks moved to an extracted pile collect there without consuming geological reserve', t => {
  const { room, world, deposit, base, players: [alice], publish, order, until, squad, x } = site(t, {}, 'Alice');
  const ids = [publish(alice, 'truck'), publish(alice, 'truck')], edge = deposit.x + Math.sign(base - deposit.x) * 28;
  const reserve = room.left(deposit); room.extracted.set(deposit.id, 6000);
  order(alice, 'control', { id: null }); order(alice, 'move', { ids, x: edge });
  assert(until(() => ids.every(id => !squad(alice, id).move), 120), 'they get there');
  for (const id of ids) assert(Math.abs(x(id) - deposit.x) <= LOAD_REACH, `${id} stands ${x(id) - deposit.x} m from the vein`);
  assert(until(() => ids.every(id => room.record(world.actor(id)).loading === deposit.id), 30), 'both are loaded');
  assert.equal(room.left(deposit), reserve, 'containers do not extract the reserve they park beside');
  assert(ids.every(id => collectionWork(world, id).length === 0 && workArea(world, id, deposit, LOAD_REACH).ready));
  assert(Math.abs((room.extracted.get(deposit.id) ?? 0) + ids.reduce((sum, id) => sum + carriedBy(room.pieces(id)).carried.ferro, 0) - 6000) < 1e-6);
});

test('several haulers share an actual deposit without stacking and a queued truck loads when the bay clears', t => {
  const { room, world, deposit, players: [alice], publish, order, until, squad, cargo, stowed, part } = site(t, {}, 'Alice'),
    ids = Array.from({ length: 4 }, () => publish(alice, 'truck'));
  const reserve = room.left(deposit); room.extracted.set(deposit.id, 40000);
  order(alice, 'control', { id: null }); order(alice, 'haul', { ids, depositId: deposit.id });
  assert(until(() => ids.some(id => cargo(id).ferro > 100) && ids.some(id => squad(alice, id).haul?.waiting), 120));
  const loading = ids.find(id => cargo(id).ferro > 100), queued = ids.find(id => squad(alice, id).haul?.waiting),
    destinations = ids.map(id => squad(alice, id).move?.x ?? world.actor(id).vehicle.x);
  assert.equal(new Set(destinations.map(x => Math.round(x * 10))).size, ids.length);
  assert.equal(collectionWork(world, loading).length, 0); assert(workArea(world, loading, deposit, LOAD_REACH).ready);
  assert.equal(room.record(world.actor(queued)).loading, null, 'waiting outside the material gathers nothing');
  stowed(loading, 'hopper', { ferro: cargoRoom(part(loading, 'hopper')) / cargoUnitVolume('ferro') - 100 });
  assert(until(() => cargo(queued).ferro > 100, 180), 'the queued truck automatically takes the released loading place');
  assert.equal(collectionWork(world, queued).length, 0); assert(workArea(world, queued, deposit, LOAD_REACH).ready);
  assert.equal(room.left(deposit), reserve, 'a queue of transporters cannot mine new material');
  assert.deepEqual([...room.faults], []);
});
