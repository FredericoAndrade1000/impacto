import { FULL_INDUSTRY } from '../src/industry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { createStructuredConstruction, planStructuredComponent, validateStructuredConstruction } from '../src/structured-construction.ts';
import { depositsNear, RECOVERY_SECONDS } from '../src/deposits.ts';
import { collectionWork, canCollect, loadingContainers, loadingZone } from '../src/loading-area.ts';
import { cargoSpace } from '../src/component-volume.ts';
import { BASE_RADIUS, LOAD_REACH, carriedBy, bill } from '../src/economy.ts';
import { MODULES } from '../src/materials.ts';
import { CELL, cellOf, unitsOf } from '../src/grid.ts';
import { withChassisSuspension, withChassisThickness } from '../src/chassis-editing.ts';
import { GAP, LOADING_APPROACH } from '../src/squad.ts';
import { onField } from './helpers/field.js';

// Where a hauler stops at a vein is where the field loads it: real vehicles of the workshop on the real field, driven by
// their own pilot under one Transportar order. Only the pile already out of the ground is set by hand.

const fitted = (design, parts) => parts.reduce((made, part) => planStructuredComponent(made, part).construction, design);
// How many cells of the grid (grid.ts) a piece `metres` high on what holds it stands over it: up to the cell clear of it.
const above = metres => Math.ceil(metres / CELL - 1e-9);
// The ore truck of the catalogue on its longest frame, with what is asked for on the frame behind its cab: each piece's
// kind, size and place along the frame from its rear end; all of it hung where its suspension reaches its wheels. Places
// in cells.
function longTruck(name, parts) {
  const source = createStructuredTemplate('truck'), { x: front, y: deck } = source.chassis.points[0], rear = cellOf(6);
  return validateStructuredConstruction(withChassisSuspension({ ...source, name,
    chassis: { ...source.chassis, points: [source.chassis.points[0], { x: rear, y: deck }],
      axles: [front + cellOf(1.1), front + cellOf(2.8), rear - cellOf(2.6), rear - cellOf(1)], thicknessMm: 30 },
    components: [...source.components.filter(piece => piece.kind !== 'hopper'),
      ...parts.map(([id, kind, sizeScale, t]) => ({ id, kind, sizeScale,
        // Points mark the frame face; its extra top plate stands wholly above it. Seat on that actual upper face.
        pose: { x: Math.round(Math.max(rear - (rear - front) * t, source.nodes.find(n=>n.id==='hull-1').x + MODULES[kind].width * sizeScale / 2 / CELL + 2)),
          y: deck + unitsOf((source.chassis.topPlate?.thicknessMm ?? 0) / 1000 + MODULES[kind].height * sizeScale / 2), angle: 0 } }))] }, 0));
}
// A fixed post of concrete with an excavator on its roof: the oil well of the catalogue, longer, digging ore instead.
function digPost() {
  const source = createStructuredTemplate('oil-well'), half = cellOf(3.2), tall = source.nodes.find(n=>n.id===source.plates.find(p=>p.id==='hull:roof').a).y - Math.min(...source.nodes.map(n=>n.y)),
    floor = Math.min(...source.nodes.map(node => node.y)), roofMm = source.plates.find(plate => plate.id === 'hull:roof').thicknessMm;
  return validateStructuredConstruction({ ...source, name: 'Posto de escavação',
    nodes: [[-half, floor], [half, floor], [half, floor + tall], [-half, floor + tall]].map(([x, y], i) => ({ id: 'hull-' + i, x, y })),
    components: source.components.map(piece => piece.kind === 'drill' ? { ...piece, id: 'excavator', kind: 'excavator',
      pose: { x: cellOf(1.28), y: floor + tall + above(roofMm / 2000 + MODULES.excavator.height * (piece.sizeScale ?? 1) / 2), angle: 0 } } : piece) });
}
// A tall lorry with two rows of hoppers, one over the other: the upper row stands well over two metres from the ground.
// Its frame made thicker hangs it where the suspension of that frame reaches its wheels; its parts stand over the deck.
// Places in cells.
function twoRows() {
  const half = cellOf(6), hull = createStructuredConstruction({ name: 'Duas fileiras de caçambas', length: 12, height: 3.8, frontInset: .4, rearInset: .1, thicknessMm: 10, chassis: 'wheeled' }),
    design = withChassisThickness({ ...hull, chassis: { ...hull.chassis, axles: [-half + 24, -half + 56, half - 56, half - 24] } }, 20),
    deck = design.chassis.points[0].y, roof = design.plates.find(plate => plate.id === 'hull:roof'),
    roofY = design.nodes.find(node => node.id === roof.a).y;
  return fitted(design, [
    { id: 'engine', kind: 'engine', sizeScale: 1, pose: { x: 105, y: deck + 8, angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: 1, pose: { x: 82, y: deck + 9, angle: 0 } },
    { id: 'command', kind: 'command', sizeScale: 1, pose: { x: 107, y: deck + 20, angle: 0 } },
    { id: 'camera', kind: 'sensor', sensorMode: 'visual',
      pose: { x: 3, y: roofY + unitsOf(roof.thicknessMm / 2000 + MODULES.sensor.height / 2), angle: 0 } },
    ...[-84, -24].flatMap((x, i) => [{ id: 'low-' + i, kind: 'hopper', sizeScale: 1, pose: { x, y: deck + 10, angle: 0 } },
      { id: 'high-' + i, kind: 'hopper', sizeScale: 1, pose: { x, y: deck + 40, angle: 0 } }])]);
}

// A digger: the ore lorry of the catalogue without its hopper, which only digs what it reaches into the pile of the vein.
function digger() {
  const source = createStructuredTemplate('mining-truck');
  return validateStructuredConstruction({ ...source, name: 'Escavadeira', components: source.components.filter(piece => piece.kind !== 'hopper') });
}
// A long lorry with two hoppers and no tool, which only carries off what is dug.
const lorry = () => longTruck('Caminhão longo', [['rear', 'hopper', 1.5, .15], ['front', 'hopper', 1.5, .42]]);

// A field by a lone vein of a material and feature, with the base of the player's faction `gap` metres from it.
function field(t, { material = 'ferro', feature = 'outcrop', gap = 250 } = {}) {
  let base;
  const room = new SharedRoom({ industry: FULL_INDUSTRY, starter: false, build: false, fog: false, stock: bill(1e9, 1e9, 1e9, 1e9), base: () => base });
  t.after(() => room.world.dispose());
  const world = room.world, site = room.deposits.filter(site => site.material === material && site.feature === feature &&
    depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 && depositsNear(room.deposits, site.x + gap, BASE_RADIUS + LOAD_REACH).length === 0)
    .sort((a, b) => Math.abs(a.x - world.terrain.center) - Math.abs(b.x - world.terrain.center))[0];
  assert(site); base = Math.round(site.x + gap);
  const owner = room.players.get(room.join('Coletor').playerId), faction = room.faction(owner),
    publish = (design, options) => { owner.builtAt = -Infinity; return room.publish(owner.id, design, options).actor.id; },
    haul = ids => { room.command(owner.id, { type: 'squad', order: 'control', id: null }); room.command(owner.id, { type: 'squad', order: 'haul', ids, depositId: site.id }); },
    bins = id => world.modules.filter(piece => piece.actorId === id && (piece.kind === 'hopper' || piece.kind === 'cistern')),
    cargo = id => carriedBy(bins(id)).carried[material], unit = id => owner.squad.units.get(id);
  return { room, world, site, owner, faction, publish, haul, bins, cargo, unit };
}
const over = (site, x) => x >= loadingZone(site).lo + 1 && x <= loadingZone(site).hi - 1;
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

test('two automatic lorries coordinate one finite ready pile and physically deliver it without mining or extra empty rounds', { timeout: 90000 }, t => {
  const f = field(t), { room, world, site, owner, faction, publish, cargo, bins } = f,
    ids = [publish(createStructuredTemplate('truck')), publish(createStructuredTemplate('truck'))],
    initial = bins(ids[0]).reduce((sum, piece) => sum + cargoSpace(piece, site.material), 0) + 1,
    before = faction.stock.ferro + faction.yard.ferro;
  room.extracted.set(site.id, initial);
  room.command(owner.id, { type: 'squad', order: 'control', id: null });
  let seen = false, overlap = false;
  for (let step = 0; step < 360 * 60; step++) {
    room.step();
    const jobs = [...room.supplyDispatch.jobs.values()].filter(job => job.kind === 'haul' && job.targetId === site.id);
    const outward = jobs.filter(job => job.haul?.phase !== 'home' && job.haul?.phase !== 'unload');
    assert(outward.length <= 1, 'a second lorry never goes to or loads the same pile concurrently');
    seen ||= jobs.length > 0; overlap ||= jobs.length > outward.length && outward.length > 0;
    assert.equal(room.left(site), site.reserve, 'automatic transport never consumes geological reserve');
    const all = (room.extracted.get(site.id) ?? 0) + ids.reduce((sum, id) => sum + cargo(id), 0) + faction.stock.ferro + faction.yard.ferro - before;
    assert(Math.abs(all - initial) < 1e-5, 'every unit remains in the pile, cargo, yard or refined stock');
    if (faction.stock.ferro + faction.yard.ferro - before >= initial - 1e-5) break;
  }
  assert(seen, 'the existing automatic switch dispatches a genuine transporter');
  assert(overlap, 'the remainder is dispatched while the first loaded lorry returns, without locking the pile for its whole round trip');
  assert(Math.abs(faction.stock.ferro + faction.yard.ferro - before - initial) < 1e-5, 'real vehicles returned and unloaded the whole finite pile');
  for (let step = 0; step < 4 * 60; step++) room.step();
  assert(ids.every(id => !owner.squad.units.get(id).haul && !room.supplyDispatch.jobs.get(id)?.targetId));
  assert.equal(room.extracted.get(site.id) ?? 0, 0); assert.equal(room.left(site), site.reserve);
  assert.equal(room.faults.size, 0); assert(ids.every(id => world.actor(id).vehicle.fuelLitres > 0));
});

test('automatic ready transport keeps manual priority, a real fuel admission and cold resume of its physical cargo', { timeout: 90000 }, t => {
  const f = field(t), { room, world, site, owner, faction, publish, cargo, unit } = f,
    id = publish(createStructuredTemplate('mining-truck')), helpers = onField(t, room),
    fuel = world.modules.find(piece => piece.actorId === id && piece.kind === 'fuel');
  room.extracted.set(site.id, 2000);
  room.command(owner.id, { type: 'squad', order: 'control', id: null });
  helpers.set(fuel, { fuelLitres: 0 }); faction.stock.combustivel = 0;
  helpers.run(2);
  assert.equal(unit(id).haul, null); assert.equal(room.supplyDispatch.view(id).reason, 'waiting-fuel');
  faction.stock.combustivel = 100;
  assert(helpers.until(() => cargo(id) > 0, 120), 'finite base fuel admits the real pickup route');
  assert.equal(room.left(site), site.reserve); assert.equal(room.record(world.actor(id)).extraction, null);
  const job = room.supplyDispatch.jobs.get(id), beforeSave = cargo(id), kept = JSON.parse(JSON.stringify(room.keep())),
    order = kept.players.find(player => player.id === owner.id).orders.find(([actorId]) => actorId === id)[1];
  assert(job?.haul && unit(id).haul === job.haul);
  assert.equal(order.haul, null); assert.equal(order.move, null);
  assert.equal(kept.records.find(([actorId]) => actorId === id)[1].auto, true);
  assert.equal(unit(id).haul, job.haul, 'saving never mutates a live trip');
  const restored = new SharedRoom({ industry: FULL_INDUSTRY, kept, starter: false, build: false, fog: false }), resumed = onField(t, restored),
    rejoined = restored.join('Coletor', owner.token), ours = restored.faction(restored.players.get(rejoined.playerId)),
    stocked = ours.stock.ferro + ours.yard.ferro,
    aboard = () => carriedBy(restored.pieces(id)).carried.ferro;
  assert(Math.abs(aboard() - beforeSave) < 1e-6); assert.equal(restored.supplyDispatch.jobs.size, 0);
  assert(resumed.until(() => ours.stock.ferro + ours.yard.ferro - stocked >= beforeSave - 1e-5, 120), 'cold resume delivers preserved cargo through the yard before another pickup');

  // Squad's actual terminal loading failure is retained just like a terminal physical stall, without a retry route.
  unit(id).move = null; unit(id).halt = unit(id).reason = 'no-loader';
  helpers.run(35);
  assert(!room.supplyDispatch.jobs.has(id)); assert.equal(unit(id).haul, null); assert.equal(unit(id).move, null);
  assert.equal(room.supplyDispatch.view(id).reason, 'no-loader');
  room.command(owner.id, { type: 'squad', order: 'move', ids: [id], x: site.x - 100 });
  const manual = unit(id).move;
  assert(manual); assert.equal(unit(id).haul, null); assert(!room.supplyDispatch.jobs.has(id));
  assert.equal(room.supplyDispatch.ordered(id), 'manual-order'); assert.equal(unit(id).move, manual);
  const manualSaved = room.keep().players.find(player => player.id === owner.id).orders.find(([actorId]) => actorId === id)[1];
  assert.deepEqual(manualSaved.move, manual, 'manual movement stays in the ordinary saved order');
  room.command(owner.id, { type: 'squad', order: 'stop', ids: [id] });
  assert.equal(room.record(world.actor(id)).auto, false); assert.equal(unit(id).move, null);
  unit(id).halt = unit(id).reason = 'no-loader';
  room.command(owner.id, { type: 'auto', actorId: id, on: true });
  assert.equal(unit(id).halt, '', 'an explicit reactivation releases the existing terminal wait');
  assert.equal(room.record(world.actor(id)).auto, true); assert.equal(unit(id).haul, null, 'turning it back on waits for a fresh dispatch look');
});

test('a fixed structure digging the vein holds no place: a long two-hopper lorry stops in it, loads the pile and takes it home', { timeout: 60000 }, t => {
  const { room, world, site, owner, faction, publish, haul, bins, cargo, unit } = field(t);
  world.addActor(digPost(), { id: 'post', ownerId: owner.id, team: faction.id, x: site.x, facing: 1 });
  // The vein dug out: the post digs only what comes back of it, and the lorry finds it empty once it took the pile.
  room.veins.set(site.id, 0); room.extracted.set(site.id, 13300);
  const regrown = regrowth(room), id = publish(lorry());
  haul([id]);
  let waited = false, loaded = 0;
  for (let step = 0; step < 120 * 60 && unit(id).haul?.phase !== 'home'; step++) {
    room.step();
    waited ||= unit(id).haul?.waiting === true; loaded = cargo(id);
  }
  const x = world.actor(id).vehicle.x;
  t.diagnostic(JSON.stringify({ elapsed: world.time, phase: unit(id).haul?.phase, loaded, standing: x - site.x, pile: room.extracted.get(site.id) ?? 0 }));
  assert.equal(waited, false, 'never “aguardando espaço na jazida” beside its own structure');
  assert.equal(unit(id).haul?.phase, 'home');
  assert(Math.abs(x - site.x) < 12, 'it stood in the post, by the pile');
  assert(loaded >= 13300 - 1e-6 && Math.abs(loaded + (room.extracted.get(site.id) ?? 0) + room.left(site) - 13300 - regrown(site)) < 1e-6,
    'it took the whole pile, and what the post dug of the vein as it came back');
  assert(regrown(site) <= site.reserve * world.time / RECOVERY_SECONDS + 1e-6, 'no more than comes back at the pace of the vein');
  assert.equal(unit(id).halt, 'vein-empty:ferro', 'it says why it goes home');
  assert(bins(id).every(piece => piece.cargo?.ferro > 0), 'more than one hopper holds: each took its share');
  assert.equal(room.faults.size, 0);
});

// Whether a construction digs a vein now, and how near two vehicles of the side stand: closer than their lengths and the
// gap of the squad between them, they stand side by side.
const digging = (room, id) => Boolean(room.record(room.world.actor(id)).extraction);
const beside = (f, a, b) => Math.abs(f.world.actor(a).vehicle.x - f.world.actor(b).vehicle.x) < (f.owner.squad.room(a) + f.owner.squad.room(b)) / 2 + GAP;

test('a long lorry sent to carry off what a digger digs stops beside it and loads; a second lorry keeps clear of the first', { timeout: 60000 }, t => {
  const f = field(t), { room, world, site, owner, publish, haul, cargo, unit } = f, dig = publish(digger());
  haul([dig]);
  for (let step = 0; step < 60 * 60 && !digging(room, dig); step++) room.step();
  assert(digging(room, dig), 'the digger works the vein');
  const first = publish(lorry()), second = publish(lorry());
  haul([first]); for (let step = 0; step < 2 * 60; step++) room.step(); haul([second]);
  let waited = false;
  for (let step = 0; step < 120 * 60 && !(cargo(first) > 3000); step++) { room.step(); waited ||= unit(first).haul?.waiting === true; }
  const x = id => world.actor(id).vehicle.x - site.x;
  t.diagnostic(JSON.stringify({ elapsed: world.time, first: x(first), second: x(second), digger: x(dig), cargo: cargo(first), pile: room.extracted.get(site.id) ?? 0 }));
  assert.equal(waited, false, 'never “aguardando espaço no local de coleta” beside a digger');
  assert(cargo(first) > 3000 && unit(first).haul?.phase === 'load', 'it loads what the digger digs');
  assert(beside(f, first, dig) && digging(room, dig), 'beside the digger, which goes on digging');
  // Two lorries do not stack: the second stands as far from the first as their lengths and the gap ask, but for the
  // fine stop of loading.
  assert(Math.abs(x(first) - x(second)) >= (owner.squad.room(first) + owner.squad.room(second)) / 2 + GAP - LOADING_APPROACH, 'the second keeps clear of the first');
  assert.equal(room.faults.size, 0);
});

test('a digger sent to a vein where an empty lorry waits for production digs beside it, and the lorry takes what it digs', { timeout: 60000 }, t => {
  const f = field(t), { room, world, site, publish, haul, cargo, unit } = f, id = publish(lorry()), reserve = room.left(site), regrown = regrowth(room);
  haul([id]);
  for (let step = 0; step < 60 * 60 && unit(id).haul?.phase !== 'load'; step++) room.step();
  assert.equal(unit(id).haul?.phase, 'load'); assert.equal(cargo(id), 0, 'an empty lorry waits there for production');
  const dig = publish(digger());
  haul([dig]);
  let waited = false;
  for (let step = 0; step < 90 * 60 && !(cargo(id) > 500); step++) { room.step(); waited ||= unit(dig).haul?.waiting === true; }
  t.diagnostic(JSON.stringify({ elapsed: world.time, lorry: world.actor(id).vehicle.x - site.x, digger: world.actor(dig).vehicle.x - site.x, cargo: cargo(id) }));
  assert.equal(waited, false, 'the lorry keeps the digger out of the material no longer');
  assert(digging(room, dig) && beside(f, id, dig), 'it digs beside the lorry');
  assert(cargo(id) > 500 && unit(id).haul?.phase === 'load', 'and the lorry loads what it digs');
  assert(Math.abs(reserve + regrown(site) - room.left(site) - cargo(id) - (room.extracted.get(site.id) ?? 0)) < 1e-6);
  assert.equal(room.faults.size, 0);
});

// A lorry in automatic sent by the player to carry what a digger digs (Frederico's case on the public field, 2026-10-30):
// one long hopper, which an excavator working just clear of it reached the material beside even before diggers and
// haulers stood side by side. The order of the player holds it, and the automatic waits (`paused`, `manual-order`).
test('a lorry in automatic loading by the bucket beside a digger takes no sliver home when the digger pauses, and its load once nothing more comes', { timeout: 60000 }, t => {
  const f = field(t), { room, world, owner, publish, haul, cargo, unit } = f, helpers = onField(t, room),
    id = publish(longTruck('Caminhão de uma caçamba', [['bin', 'hopper', 2, .2]])), held = () => room.supplyDispatch.view(id);
  room.command(owner.id, { type: 'auto', actorId: id, on: true });
  haul([id]);
  helpers.until(() => unit(id).haul?.phase === 'load', 60);
  const dig = publish(digger()), fuel = litres => helpers.set(helpers.parts(dig, 'fuel')[0], { fuelLitres: litres });
  haul([dig]);
  assert(helpers.until(() => cargo(id) > 0, 90), 'it starts taking what the digger digs');
  // The digger short of fuel for a few seconds — refuelled, parked anew —: the pile stands empty, and the lorry waits.
  const kept = helpers.parts(dig, 'fuel')[0].fuelLitres, sliver = cargo(id);
  fuel(0); helpers.run(4);
  assert(!digging(room, dig)); assert.equal(unit(id).haul?.phase, 'load', 'no sliver goes home');
  assert.deepEqual([held().phase, held().reason], ['paused', 'manual-order'], 'what holds it is the order of the player');
  assert(room.record(world.actor(id)).cargoWork?.waiting, 'it waits for what is dug');
  fuel(kept);
  assert(helpers.until(() => cargo(id) > sliver + 500, 30), 'and takes what the digger digs again');
  // The digger out of fuel for good: once the pile stayed empty for a while, the lorry takes what it has home.
  fuel(0);
  const stopped = world.time, partial = cargo(id);
  assert(helpers.until(() => unit(id).haul?.phase === 'home', 20));
  t.diagnostic(JSON.stringify({ sliver, partial, waited: world.time - stopped }));
  assert(world.time - stopped > 7, 'only after a while'); assert.equal(cargo(id), partial);
  assert.equal(held().reason, 'manual-order', 'still on the order of the player');
  assert.equal(room.faults.size, 0);
});

test('a lorry whose excavator works past its rear and whose hopper stands by its cab parks where it digs and loads at once', { timeout: 60000 }, t => {
  const { room, world, site, publish, haul, bins, cargo, unit } = field(t),
    id = publish(longTruck('Escavadeira atrás, caçamba junto da cabine', [['tool', 'excavator', 1, .08], ['bin', 'hopper', 1.5, .58]])),
    reserve = room.left(site), regrown = regrowth(room);
  haul([id]);
  let dug = false;
  for (let step = 0; step < 90 * 60 && !(cargo(id) > 1000); step++) {
    room.step();
    const work = collectionWork(world, id)[0];
    if (!dug && unit(id).haul?.phase === 'load' && canCollect(work, site, world.terrain)) {
      dug = true;
      assert(over(site, bins(id)[0].x), 'its hopper stands over the material where its arm digs');
    }
  }
  t.diagnostic(JSON.stringify({ elapsed: world.time, cargo: cargo(id), pile: room.extracted.get(site.id) ?? 0, dug: reserve + regrown(site) - room.left(site) }));
  assert(dug && cargo(id) > 1000, 'what it digs goes into its own hopper, not into a pile it never takes');
  assert(Math.abs(reserve + regrown(site) - room.left(site) - cargo(id) - (room.extracted.get(site.id) ?? 0)) < 1e-6);
  assert.equal(room.faults.size, 0);
});

test('every hopper of a lorry with two rows fills from the low row and comes home full', { timeout: 60000 }, t => {
  const { room, world, site, publish, haul, bins, cargo, unit } = field(t), id = publish(twoRows()), ground = x => world.terrain.height(x);
  room.extracted.set(site.id, 60000);
  haul([id]);
  for (let step = 0; step < 150 * 60 && unit(id).haul?.phase !== 'home'; step++) room.step();
  const floors = bins(id).map(piece => piece.y - piece.height / 2 - ground(piece.x));
  t.diagnostic(JSON.stringify({ elapsed: world.time, phase: unit(id).haul?.phase, cargo: cargo(id), floors,
    held: bins(id).map(piece => Math.round(piece.cargo?.ferro ?? 0)) }));
  assert(floors.filter(floor => floor > 2).length === 2 && floors.filter(floor => floor <= 2).length === 2, 'two hoppers stand too high to pick up by themselves');
  assert.equal(unit(id).haul?.phase, 'home');
  assert(bins(id).every(piece => cargoSpace(piece, 'ferro') < 1), 'all four came full, the high ones through the low ones');
  assert.equal(room.faults.size, 0);
});

test('a tanker sent out facing away from its vein turns about and works out its stop again: it drives there once, where it pumps and loads', { timeout: 60000 }, t => {
  const { room, world, site, publish, haul, cargo, unit } = field(t, { material: 'petroleo', feature: 'lowland' }),
    id = publish(createStructuredTemplate('tanker'), { facing: 1 }), facing = world.actor(id).facing;
  assert.equal(Math.sign(site.x - world.actor(id).vehicle.x), -facing, 'the vein lies behind it');
  haul([id]);
  // The places it is sent to at the vein once it faces the vein.
  const legs = new Set();
  let loading = null;
  for (let step = 0; step < 90 * 60 && !(cargo(id) > 50); step++) {
    room.step();
    if (world.actor(id).facing === -facing && unit(id).haul?.phase === 'out' && unit(id).move) legs.add(Math.round(unit(id).move.x * 10) / 10);
    if (!loading && unit(id).haul?.phase === 'load') loading = world.actor(id).vehicle.x;
  }
  t.diagnostic(JSON.stringify({ elapsed: world.time, facing: world.actor(id).facing, legs: [...legs].map(x => x - site.x), loading: loading - site.x, cargo: cargo(id) }));
  assert.equal(world.actor(id).facing, -facing, 'it turned about on the way');
  assert.equal(legs.size, 1, 'one leg to the vein, planned for the way it faces');
  assert(Math.abs([...legs][0] - loading) < 1, 'and it loads where that leg ends');
  assert(canCollect(collectionWork(world, id)[0], site, world.terrain) && loadingContainers(world, id, site, LOAD_REACH).length > 0, 'its drill and its cistern both work there');
  assert(cargo(id) > 50);
  assert.equal(room.faults.size, 0);
});
