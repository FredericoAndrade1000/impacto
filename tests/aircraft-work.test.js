import { FULL_INDUSTRY } from '../src/industry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { SharedRoom, rehearsal } from '../server/room.ts';
import { worker, roadMachine } from '../server/supply-dispatch.ts';
import { constructionSpan } from '../server/field-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileDraftConstruction, compileStructuredConstruction } from '../src/structured-construction.ts';
import { withConstructionKind } from '../src/chassis-editing.ts';
import { workshopChecklist } from '../src/workshop-checklist.ts';
import { depositsNear } from '../src/deposits.ts';
import { loadingContainers } from '../src/loading-area.ts';
import { BASE_RADIUS, LOAD_REACH, SUPPLY_REACH, bill, billTotal, carriedBy, designBill } from '../src/economy.ts';
import { BUILD_REACH } from '../src/construction-site.ts';
import { haulText, jobAdvice, jobText } from '../src/faction-ui.ts';
import { HOLDING, Squad, flight, flightFuel, lifts, steady } from '../src/squad.ts';
import { onField } from './helpers/field.js';
import { airBuilder, airMiner, airSupply, gunship } from './helpers/aircraft.js';

await initNativeDynamics();

// Aircraft at work (squad.ts `haul`, server/supply-dispatch.ts): they fly to where they work and come down there to work on
// their skids — to dig and load at a vein, to unload at their base, to put a works up or take a structure down, to bring a
// works its material —, and fly home for their fuel and take their work up again. Real designs the Oficina passes
// (tests/helpers/aircraft.js) on the real field, flown by their own pilots.

// A field whose base stands `gap` metres off a vein of ore with no other by it, and a player's aircraft of `design` published
// at the base, out of automatic: what it carries, whether it is at home, and its order.
function vein(t, design, { gap = 150 } = {}) {
  let base;
  const room = new SharedRoom({ industry: FULL_INDUSTRY, starter: false, build: false, fog: false, stock: bill(1e9, 1e9, 1e9, 1e9), base: () => base }), world = room.world,
    site = room.deposits.filter(site => site.material === 'ferro' && depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 &&
      depositsNear(room.deposits, site.x + gap, BASE_RADIUS + LOAD_REACH).length === 0).sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
  assert(site); base = site.x + gap;
  const f = onField(t, room), player = room.join('Coletor'), squad = room.players.get(player.playerId).squad, id = f.publish(player, design);
  room.supplyDispatch.set(id, false);
  return { ...f, site, base, player, squad, id, vehicle: () => world.actor(id).vehicle, unit: () => squad.units.get(id),
    carried: () => carriedBy(room.pieces(id)).carried.ferro, home: () => Math.abs(world.actor(id).vehicle.x - base) <= BASE_RADIUS,
    tanks: () => f.parts(id, 'fuel'), topped: () => f.parts(id, 'fuel').every(tank => tank.fuelLitres >= tank.capacityLitres - .5),
    haul: () => f.order(player, 'haul', { ids: [id], depositId: site.id }) };
}
// The fuel of one of its tanks, with the others empty.
const drain = (f, litres) => f.tanks().forEach((tank, i) => f.set(tank, { fuelLitres: i ? 0 : litres }));

// Builders and supply vehicles at works (tests/builder-dispatch.test.js): a works stands the moment a builder is beside it with
// all its material there.
function works(t) {
  const room = rehearsal([-213, 30000], bill(1e9, 1e9, 1e9, 1e9), { fog: false }), f = onField(t, room), player = room.join('Construtora'), world = room.world,
    design = createStructuredTemplate('guard-post'), cost = designBill(compileStructuredConstruction(design)), squad = room.players.get(player.playerId).squad;
  return { ...f, player, squad, design, cost, x: id => room.position(world.actor(id)), errand: id => room.supplyDispatch.errand(id),
    // A works of the guard post opened where it may stand, `from` metres off the base or further, with its material there or not.
    opened: ({ from = 160, delivered = true } = {}) => {
      const id = f.open(player, design, { x: f.site(player, design, { from }) });
      if (delivered) room.works.pending.get(id).delivered = { ...cost };
      return id;
    },
    beside: (id, work) => room.works.gap(world.actor(id), constructionSpan(design, work.x, work.facing)) <= BUILD_REACH,
    landed: id => !world.actor(id).vehicle.flying && room.still(world.actor(id)) };
}

test('an aircraft comes down on the level ground nearest where it is sent to work, within the stretch it works from, clear of the side, or nowhere', () => {
  const others = [], world = { terrain: { minX: -1000, maxX: 1000, height: x => x > 20 && x < 60 ? (x - 20) * .5 : x >= 60 ? 20 : 0 },
      actor: id => ({ vehicle: { x: others.find(o => o.id === id)?.x ?? 0 } }) },
    squad = Object.assign(Object.create(Squad.prototype), { side: { world, roster: others, defeats: {} }, units: new Map() }), me = new Set(['a']);
  squad.room = () => 8; squad.position = id => others.find(o => o.id === id)?.x ?? 0;
  // Half a metre to the metre from 20 m to 60 m: from 10 m to 40 m, the nearest level place to 30 m is the foot of the slope.
  assert.equal(squad.landing('a', 30, me, { lo: 10, hi: 40, strict: true }), 20);
  // From 25 m to 55 m it all slopes: it comes down nowhere there — or there all the same, when told to come down anyway.
  assert.equal(squad.landing('a', 30, me, { lo: 25, hi: 55, strict: true }), null);
  assert.equal(squad.landing('a', 30, me, { lo: 25, hi: 55 }), 30);
  assert.deepEqual([squad.level('a', 25, 55), squad.level('a', 0, 30), squad.level('a', 50, 70)], [false, true, true]);
  // Another of the side standing at 5 m: it comes down clear of it, its length and the other's apart and the gap, within the stretch.
  others.push({ id: 'b', team: 'player', x: 5 });
  const at = squad.landing('a', 5, me, { lo: -20, hi: 20, strict: true });
  assert(Math.abs(at - 5) >= 11 - 1e-9 && at >= -20 && at <= 20, String(at));
  assert.equal(squad.landing('a', 5, me, { lo: 0, hi: 10, strict: true }), null, 'none clear there');
});

test('an aircraft sent to haul flies to its vein, digs and loads there on its skids, unloads at its base on them, and goes again', { timeout: 120000 }, t => {
  const f = vein(t, airMiner()), seen = { deliveries: 0, aloft: [], reasons: new Set(), loading: [] };
  f.haul();
  let carried = 0;
  const done = f.until(() => {
    const unit = f.unit(), v = f.vehicle(), now = f.carried();
    // Nothing comes aboard, nor goes, in the air.
    if (Math.abs(now - carried) > 1e-6 && v.flying) seen.aloft.push({ time: f.world.time, carried, now });
    if (carried > 0 && now === 0 && f.home()) seen.deliveries++;
    if (unit.haul?.phase === 'load') seen.loading.push(v.flying);
    if (unit.reason) seen.reasons.add(unit.reason);
    carried = now;
    return seen.deliveries >= 2 && unit.haul?.phase === 'out' && Boolean(unit.move);
  }, 600);
  t.diagnostic(JSON.stringify({ time: f.world.time, deliveries: seen.deliveries, reasons: [...seen.reasons], order: f.unit().haul }));
  assert(done, 'two loads came home, and it goes for a third under the same order');
  assert.deepEqual(seen.aloft, [], 'it loads and unloads only on its skids');
  assert(seen.loading.length && seen.loading.every(flying => !flying), 'it loads landed');
  assert(!seen.reasons.has('no-loader'), 'its digger reaches the vein where it comes down');
  assert.equal(f.unit().move.land, 'work', 'it flies to come down where it works');
  assert.equal(f.room.faults.size, 0);
});

test('hovering still is not standing still: over its base an aircraft is not filled up, nor does a builder hovering by a works put it up; on its skids each is, and does', { timeout: 120000 }, t => {
  const f = works(t), { room, world, ground } = f, id = f.publish(f.player, airBuilder()), litres = () => f.parts(id, 'fuel').reduce((sum, tank) => sum + tank.fuelLitres, 0);
  room.supplyDispatch.set(id, false); f.run(1);
  const base = room.faction(room.players.get(f.player.playerId)).base.x, over = base + 20;
  f.order(f.player, 'move', { ids: [id], x: over, y: ground.height(over) + 8 });
  assert(f.until(() => !f.squad.units.get(id).move && world.actor(id).vehicle.flying, 60), 'it hovers over its base');
  // Its tank let down at once, with more than it keeps in reserve: its reading of what it burns starts over, or the litres
  // taken would read as burnt in a second and send it home for its fuel.
  f.set(f.parts(id, 'fuel')[0], { fuelLitres: 200 }); f.squad.units.get(id).burn = null; f.run(.2);
  const low = litres(); f.run(8);
  assert(litres() < low && !room.still(world.actor(id)), `hovering, it is not filled up: ${low.toFixed(1)} L, then ${litres().toFixed(1)} L`);
  f.order(f.player, 'move', { ids: [id], x: over });
  assert(f.until(() => f.landed(id), 60), 'it lands');
  assert(f.until(() => litres() > low + 50, 30), `on its skids it is filled up: ${litres().toFixed(1)} L`);
  // By a works with all its material there: hovering within reach of it, it puts nothing up; down there, it does.
  const work = f.opened(), pending = room.works.pending.get(work), span = constructionSpan(f.design, pending.x, pending.facing), by = span.maxX + 6;
  f.order(f.player, 'move', { ids: [id], x: by, y: ground.height(by) + 6 });
  assert(f.until(() => !f.squad.units.get(id).move && world.actor(id).vehicle.flying, 90), 'it hovers by the works');
  assert(room.works.gap(world.actor(id), span) <= BUILD_REACH, `within reach of it: ${room.works.gap(world.actor(id), span).toFixed(1)} m`);
  f.run(8);
  assert(!world.actor(work) && room.works.pending.has(work), 'hovering, it puts nothing up');
  f.order(f.player, 'move', { ids: [id], x: by });
  assert(f.until(() => world.actor(work), 60), 'down beside it, it puts it up');
});

test('an aircraft short of fuel on its way to its vein turns home, comes down there, fills up and goes back to the same vein under the same order', { timeout: 120000 }, t => {
  const f = vein(t, airMiner()), { room } = f;
  // It starts off away from home, where nobody fills it up, beyond it from its vein.
  f.put(f.id, f.base + BASE_RADIUS + 20);
  f.haul();
  assert(f.until(() => f.vehicle().flying && f.unit().haul?.phase === 'out', 10), 'it takes off for its vein');
  // Let down to its reserve (squad.ts `reserve`).
  f.run(2); drain(f, f.squad.reserve(f.id));
  assert(f.until(() => f.unit().move?.land === 'fuel', 5), 'short of fuel, it turns home for it');
  assert.deepEqual([f.unit().haul.phase, f.unit().haul.fuel, f.unit().haul.depositId], ['home', true, f.site.id], 'keeping its haul');
  assert.match(haulText(f.squad.view().units.find(u => u.id === f.id).haul), /pouco combustível · voltando para abastecer/);
  // What it was left with is given back: how long it swings about the place before it comes down there is its flight's.
  drain(f, 200);
  assert(f.until(() => !f.vehicle().flying && f.home(), 90), `it comes down at home, at ${f.vehicle().x.toFixed(1)}`);
  assert(f.until(() => f.unit().haul?.phase === 'unload', 2) && !f.topped(), 'there it waits');
  assert.match(haulText(f.unit().haul), /transportando · abastecendo/);
  assert(f.until(() => f.unit().haul?.phase === 'out' && f.unit().move, 60), 'it goes on');
  assert(f.topped(), 'filled up first');
  assert.equal(f.unit().haul.fuel, undefined);
  assert(f.until(() => f.unit().haul?.phase === 'load', 120), 'and loads at the same vein');
  assert.equal(f.unit().haul.depositId, f.site.id);
  assert.equal(room.faults.size, 0);
});

test('an aircraft whose tanks full do not take it to its vein and back gives its haul up at home, saying why', { timeout: 120000 }, t => {
  const f = vein(t, airMiner());
  f.run(1); assert(f.topped(), 'at home it stands full');
  f.haul();
  assert(f.until(() => f.vehicle().flying, 10)); f.run(2); drain(f, 55);
  assert(f.until(() => f.unit().move?.land === 'fuel', 5)); drain(f, 200);
  assert(f.until(() => !f.unit().haul, 90), 'it gives it up');
  assert.deepEqual([f.unit().reason, f.home(), f.vehicle().flying], ['out-of-range', true, false]);
});

test('an aircraft out of thrusters for its load stays on its skids at its vein and says it is too heavy; tipped out light enough, it takes off', { timeout: 120000 }, t => {
  const f = vein(t, airMiner({ tool: false })), { room } = f;
  room.extracted.set(f.site.id, 5000);
  f.haul();
  assert(f.until(() => f.unit().haul?.phase === 'load' && f.carried() > 0, 240), 'it loads');
  // Its rear thruster farther from the middle (tests/helpers/aircraft.js) is shot away as it loads: the one left there does
  // not hold up its load level, though all three lift more than it weighs.
  f.set(f.parts(f.id, 'thruster').find(m => m.id.endsWith(':lift0')), { health: 0 });
  assert(f.until(() => f.unit().haul?.phase === 'home', 60), 'full, it is to go home');
  assert(f.carried() > 3000 && !lifts(f.world, f.id), `${f.carried().toFixed(0)} kg aboard`);
  let rose = false;
  f.until(() => { rose ||= f.vehicle().flying; return false; }, 15);
  assert(!rose, 'it never takes off');
  assert.equal(f.unit().reason, 'too-heavy');
  assert.equal(f.unit().haul.phase, 'home', 'and keeps its haul');
  for (let i = 0; i < 4 && !lifts(f.world, f.id); i++) { f.send(f.player, 'dump-cargo', { actorId: f.id }); f.run(1); }
  assert(lifts(f.world, f.id), `lighter, its thrusters hold it up: ${f.carried().toFixed(0)} kg aboard`);
  assert(f.until(() => f.vehicle().flying, 10), 'and it takes off');
  assert(f.until(() => f.home() && !f.vehicle().flying, 120), 'home with what is left');
});

// A thruster of an aircraft by its name in the design (tests/helpers/aircraft.js).
const thruster = (f, id, name) => f.parts(id, 'thruster').find(m => m.id.endsWith(':' + name));

test('an aircraft that loses in flight a thruster the others do not make up for turns home, says so, comes down there, is mended and goes back to its vein under the same order', { timeout: 120000 }, t => {
  const f = vein(t, airMiner({ tool: false }), { gap: 400 }), { room, world } = f;
  room.extracted.set(f.site.id, 5000);
  f.haul();
  assert(f.until(() => f.vehicle().flying && f.unit().haul?.phase === 'out', 10), 'it takes off for its vein');
  f.run(2);
  // Its rear thruster farther from the middle is shot away: the three left hold it up level, but not by a quarter more than it weighs.
  f.set(thruster(f, f.id, 'lift0'), { health: 0 });
  assert(f.until(() => f.unit().move?.land === 'mend', 2), 'it turns home to be mended');
  assert(f.vehicle().flying && lifts(world, f.id) && !steady(world, f.id) && !lifts(world, f.id, HOLDING));
  assert.deepEqual([f.unit().haul.phase, f.unit().haul.mend, f.unit().haul.depositId], ['home', true, f.site.id], 'keeping its haul');
  assert.equal(haulText(f.squad.view().units.find(u => u.id === f.id).haul), 'transportando · propulsor perdido · voltando para reparo');
  assert(f.until(() => !f.vehicle().flying && f.home(), 90), `it comes down at home, at ${f.vehicle().x.toFixed(1)}`);
  assert(f.until(() => f.unit().haul?.phase === 'unload', 2));
  assert.equal(haulText(f.unit().haul), 'transportando · propulsor perdido · aguardando reparo');
  // The base mends it by itself, once it has stood out of combat for long enough, as it fills it up.
  assert(f.until(() => room.record(world.actor(f.id)).service?.kind === 'repair', 30), 'the base mends it');
  assert(f.until(() => f.unit().haul?.phase === 'out' && f.unit().move, 60), 'mended, it goes on');
  assert(steady(world, f.id) && f.parts(f.id, 'thruster').every(m => m.health > 0), 'on all of its thrusters');
  assert.deepEqual([f.unit().haul.mend, f.unit().mend], [undefined, undefined]);
  assert(f.until(() => f.unit().haul?.phase === 'load', 120), 'and loads at the same vein');
  assert.equal(f.unit().haul.depositId, f.site.id);
  assert.equal(room.faults.size, 0);
});

test('an aircraft that loses in flight a thruster the others make up for goes on with its haul, flown on what they can do', { timeout: 120000 }, t => {
  const f = vein(t, airMiner({ tool: false }), { gap: 400 }), { room, world } = f, landings = new Set();
  room.extracted.set(f.site.id, 5000);
  f.haul();
  assert(f.until(() => f.vehicle().flying && f.unit().haul?.phase === 'out', 10), 'it takes off for its vein');
  f.run(2);
  const leg = f.unit().move, all = flight(world, f.id);
  assert(all.climbs > 0 && Math.min(...all.along) > 0, 'its pilot reckons what its thrusters can do with it');
  // A front one is shot away: the three left hold it up by more than a quarter over what it weighs, and its pilot flies
  // it on what they can do.
  f.set(thruster(f, f.id, 'lift6'), { health: 0 });
  const left = flight(world, f.id);
  assert(left.climbs < all.climbs && left.climbs > 0, `it climbs at ${left.climbs.toFixed(2)} m/s² on them, for ${all.climbs.toFixed(2)} on all`);
  assert(lifts(world, f.id, HOLDING) && steady(world, f.id));
  assert.equal(f.unit().move, leg, 'on the same way');
  assert(f.until(() => { if (f.unit().move?.land) landings.add(f.unit().move.land); return f.unit().haul?.phase === 'load'; }, 120), 'it loads at its vein');
  assert.deepEqual([...landings], ['work']);
  assert.deepEqual([f.unit().haul.mend, f.unit().mend, f.unit().haul.depositId], [undefined, undefined, f.site.id]);
  assert.equal(room.faults.size, 0);
});

test('an aircraft whose vein has no level ground about it to come down on stops its haul and says why', { timeout: 60000 }, t => {
  const f = vein(t, airMiner());
  f.squad.level = () => false;
  f.haul(); f.run(1);
  assert.deepEqual([f.unit().haul, f.unit().reason], [null, 'no-landing']);
  assert(!f.vehicle().flying);
});

test('a transporter aircraft in automatic carries a ready pile home: it is sent as a transporter is, with a trip it has the fuel for', { timeout: 120000 }, t => {
  const f = vein(t, airMiner({ tool: false })), { room } = f, actor = f.world.actor(f.id), dispatch = room.supplyDispatch;
  room.extracted.set(f.site.id, 2000);
  // What it is reckoned to burn on a way flown: more the longer it is, and loaded than empty — never more than any tank holds.
  const seconds = dispatch.travel(actor, f.base, f.site.x);
  assert(Math.abs(seconds - Math.abs(f.base - f.site.x) / 15) < 1e-9, `${seconds} s`);
  const [near, far] = [20, 60].map(s => dispatch.fuel(actor, s));
  assert(Number.isFinite(near) && near > 0 && far > near, `${near} L, ${far} L`);
  assert(flightFuel(actor.blueprint, 9000, 20) > flightFuel(actor.blueprint, 5000, 20));
  dispatch.set(f.id, true);
  let kinds = new Set(), delivered = false, carried = 0;
  f.until(() => {
    const job = dispatch.jobs.get(f.id), now = f.carried();
    if (job) kinds.add(job.kind + ':' + (job.reason || job.phase));
    if (carried > 0 && now === 0 && f.home()) delivered = true;
    carried = now;
    return delivered;
  }, 300);
  t.diagnostic(JSON.stringify([...kinds]));
  assert(delivered, 'the pile came home');
  assert([...kinds].some(kind => kind.startsWith('haul:')), 'as a haul of the dispatch');
  assert(![...kinds].some(kind => kind.endsWith('immobile') || kind.endsWith('waiting-fuel')), 'never held for its running gear nor its fuel');
  assert.equal(room.faults.size, 0);
});

test('a builder aircraft in automatic flies to a works, comes down within reach of it and puts it up, and takes a structure down so', { timeout: 120000 }, t => {
  const f = works(t), { room, world } = f, id = f.publish(f.player, airBuilder()), work = f.opened(), pending = room.works.pending.get(work);
  let flew = false, low = Infinity, back = 0;
  assert(f.until(() => {
    const vehicle = world.actor(id).vehicle, leg = f.squad.units.get(id)?.move, over = vehicle.y - f.ground.height(vehicle.x);
    flew ||= vehicle.flying;
    if (vehicle.flying && leg?.land && Math.abs(vehicle.x - leg.x) <= 10) { low = Math.min(low, over); back = Math.max(back, over - low); }
    return world.actor(work);
  }, 180), 'the works stands');
  assert(flew && f.beside(id, pending) && f.landed(id), `it flew there, and stands within reach of it on its skids, at ${f.x(id).toFixed(1)}`);
  // It came down by it once: slowed over its place before it came down, it did not drift past it and climb back for it.
  assert(back < .5, `it climbed back ${back.toFixed(2)} m as it came down`);
  // With nothing more to do, it does not wait out there for fuel: it flies home, and fills up there.
  const base = room.faction(room.players.get(f.player.playerId)).base.x;
  assert(f.until(() => Math.abs(f.x(id) - base) <= BASE_RADIUS && f.landed(id) && f.parts(id, 'fuel').every(tank => tank.fuelLitres >= tank.capacityLitres - 1), 90),
    `home and filled up, at ${f.x(id).toFixed(1)}`);
  // Another structure, off further, is to be taken down: it flies there, and does so on its skids.
  const other = f.raise(f.player, f.design, { x: f.site(f.player, f.design, { from: 230 }) }), span = room.world.actorBounds(other);
  f.send(f.player, 'remove', { actorId: other });
  assert(f.until(() => f.errand(id)?.kind === 'dismantle', 20), JSON.stringify(room.supplyDispatch.waits.get(id)));
  assert.equal(f.errand(id).targetId, other);
  let gap = Infinity;
  assert(f.until(() => { if (!world.actor(other)) return true; gap = room.works.gap(world.actor(id), span); return false; }, 120), 'it takes it down');
  assert(f.landed(id) && gap <= BUILD_REACH, `on its skids within reach of it: ${gap.toFixed(1)} m`);
  assert.equal(room.faults.size, 0);
});

test('a supply aircraft in automatic brings a works the material it lacks, coming down beside it to hand it over', { timeout: 120000 }, t => {
  const f = works(t), { room, world } = f, work = f.opened({ delivered: false }), pending = room.works.pending.get(work),
    span = constructionSpan(f.design, pending.x, pending.facing), id = f.publish(f.player, airSupply()), jobs = new Set();
  let before = billTotal(pending.delivered), handed = null, flew = false;
  f.until(() => {
    const job = room.supplyDispatch.jobs.get(id), now = billTotal(pending.delivered);
    if (job) jobs.add(`${job.kind}:${job.phase}:${job.reason}`);
    flew ||= world.actor(id).vehicle.flying;
    if (now > before) handed = { by: room.works.gap(world.actor(id), span), landed: f.landed(id), given: now - before };
    before = now;
    return handed;
  }, 300);
  t.diagnostic(JSON.stringify({ jobs: [...jobs], handed }));
  assert(handed && flew, 'it flew material to the works');
  assert([...jobs].some(job => job.startsWith('work:')), 'on the job of bringing a works its material');
  assert(handed.by <= BUILD_REACH + 1e-6 && handed.landed, `beside it on its skids: ${handed.by.toFixed(1)} m`);
  assert.equal(room.faults.size, 0);
});

// Where an aircraft comes down while a test steps the field and looks (`look`): each time it stands on its skids again, how
// far it stands then from a stretch of the field, end to end (`at`).
function touchdowns(room, id, span) {
  const world = room.world, at = [];
  let flying = world.actor(id).vehicle.flying;
  return { at, look: () => {
    const vehicle = world.actor(id).vehicle;
    if (flying && !vehicle.flying) at.push(room.works.gap(world.actor(id), span));
    flying = vehicle.flying;
  } };
}

test('an aircraft in automatic on its way home with nothing to do takes a job that comes up meanwhile, and flies straight to it without coming down first', { timeout: 120000 }, t => {
  const f = works(t), { room, world } = f, id = f.publish(f.player, airBuilder()), base = room.faction(room.players.get(f.player.playerId)).base.x,
    way = Math.sign(f.site(f.player, f.design) - base), job = () => room.supplyDispatch.jobs.get(id);
  // Set down off from home, past where the works will be, with nothing to do: it flies home. Let down on its way short of
  // what its pilot reckons takes it home with its reserve (Squad.homeward), it is not sent home for its fuel, going home
  // already — a job would then wait for it to fill up there —; its tanks are given back after.
  f.put(id, base + way * 700);
  assert(f.until(() => job()?.phase === 'return' && world.actor(id).vehicle.flying && Math.abs(f.x(id) - base) < 500, 60), 'it flies home');
  const tanks = f.parts(id, 'fuel'), had = tanks.map(tank => tank.fuelLitres);
  tanks.forEach((tank, i) => f.set(tank, { fuelLitres: i ? 0 : f.squad.homeFuel(id) + f.squad.reserve(id) - 1 }));
  f.run(.5);
  assert.equal(f.squad.units.get(id).move?.land, 'work', 'home from its work, not for its fuel');
  tanks.forEach((tank, i) => f.set(tank, { fuelLitres: had[i] }));
  // A works comes up ahead of it, on its way home, with all its material there.
  const work = f.opened(), pending = room.works.pending.get(work), span = constructionSpan(f.design, pending.x, pending.facing),
    opened = world.time, landed = touchdowns(room, id, span);
  assert.equal(Math.sign(pending.x - base), way);
  let took = null;
  assert(f.until(() => {
    landed.look();
    if (!took && f.errand(id)?.kind === 'build') took = { flying: world.actor(id).vehicle.flying, after: world.time - opened };
    return world.actor(work);
  }, 120), 'the works stands');
  t.diagnostic(JSON.stringify({ took, landed: landed.at }));
  assert(took?.flying && took.after <= 2, `it takes the job in the air at once: ${JSON.stringify(took)}`);
  assert(landed.at.length && landed.at.every(gap => gap <= BUILD_REACH), `it came down only beside the works: ${JSON.stringify(landed.at)}`);
  assert.equal(room.faults.size, 0);
});

test('an aircraft in automatic that a Move left hovering in the sky hovers on there with nothing to do, and flies straight from there to a job that comes up', { timeout: 120000 }, t => {
  const f = works(t), { room, world, ground } = f, id = f.publish(f.player, airBuilder()), base = room.faction(room.players.get(f.player.playerId)).base.x,
    over = base + Math.sign(f.site(f.player, f.design) - base) * 260, unit = () => f.squad.units.get(id);
  f.run(1);
  f.order(f.player, 'move', { ids: [id], x: over, y: ground.height(over) + 12 });
  assert(f.until(() => !unit().move && world.actor(id).vehicle.flying, 60), 'it hovers at the point of the sky');
  // Its order carried out and nothing to do, it neither comes down nor goes home: a Move to the sky ends hovering there.
  f.run(5);
  assert.deepEqual([world.actor(id).vehicle.flying, room.supplyDispatch.jobs.has(id), room.supplyDispatch.view(id).phase], [true, false, 'idle']);
  assert(Math.abs(f.x(id) - over) < 5, `where it was left: ${f.x(id).toFixed(1)}`);
  // A works comes up: it is given it from the air and comes down only beside it.
  const work = f.opened(), pending = room.works.pending.get(work), landed = touchdowns(room, id, constructionSpan(f.design, pending.x, pending.facing));
  assert(f.until(() => { landed.look(); return world.actor(work); }, 120), 'the works stands');
  assert(landed.at.length && landed.at.every(gap => gap <= BUILD_REACH), `it came down only beside the works: ${JSON.stringify(landed.at)}`);
  // Over its base too, a Move to the sky ends hovering there: nothing brings it down.
  assert(f.until(() => f.landed(id) && Math.abs(f.x(id) - base) <= BASE_RADIUS && f.parts(id, 'fuel').every(tank => tank.fuelLitres >= tank.capacityLitres - 1), 90),
    'with nothing more to do, it flies home, comes down there and fills up');
  f.order(f.player, 'move', { ids: [id], x: base + 20, y: ground.height(base + 20) + 10 });
  assert(f.until(() => !unit().move && world.actor(id).vehicle.flying, 60), 'it hovers over its base');
  f.run(5);
  assert.deepEqual([world.actor(id).vehicle.flying, unit().move], [true, null], 'it still hovers there');
  assert.equal(room.faults.size, 0);
});

test('a supply aircraft in automatic comes down beside a vehicle that runs low, a few metres off it, and hands it its supplies only there', { timeout: 120000 }, t => {
  const f = works(t), { room, world } = f, id = f.publish(f.player, airSupply()), scout = f.publish(f.player, 'scout'),
    base = room.faction(room.players.get(f.player.playerId)).base.x;
  // The scout stopped off from home, out of rounds and with its tank all but dry: the supply aircraft goes to it.
  f.put(scout, base + 260);
  for (const piece of f.parts(scout, 'ammo')) f.set(piece, { rounds: 0 });
  for (const piece of f.parts(scout, 'fuel')) f.set(piece, { fuelLitres: 1 });
  const rounds = () => f.parts(scout, 'ammo').reduce((sum, piece) => sum + piece.rounds, 0), apart = () => room.works.gap(world.actor(id), room.works.hull(world.actor(scout)));
  let handed = null, flew = false, early = null;
  assert(f.until(() => {
    flew ||= world.actor(id).vehicle.flying;
    if (rounds() > 0) handed = { gap: apart(), landed: f.landed(id), job: room.supplyDispatch.jobs.get(id)?.kind ?? null };
    else if (f.landed(id) && Math.abs(f.x(id) - base) > BASE_RADIUS) early = { gap: apart() };
    return handed;
  }, 120), 'the scout is rearmed');
  t.diagnostic(JSON.stringify({ handed, early }));
  assert(flew, 'it flew there');
  assert(handed.landed && handed.gap <= SUPPLY_REACH && handed.gap >= 1, `on its skids beside it, end to end: ${handed.gap.toFixed(2)} m`);
  assert(!early || early.gap <= SUPPLY_REACH, `it came down beside it, nowhere further: ${JSON.stringify(early)}`);
  assert.equal(room.faults.size, 0);
});

test('an aircraft sent home for its fuel on a job of its faction keeps the job, fills up and takes it up again', { timeout: 120000 }, t => {
  const f = works(t), { room, world } = f, id = f.publish(f.player, airBuilder()), base = room.faction(room.players.get(f.player.playerId)).base.x;
  room.supplyDispatch.set(id, false);
  // Off away from home, where nobody fills it up, toward a works off further, it is put in automatic.
  const work = f.opened({ from: 200 }), way = Math.sign(room.works.pending.get(work).x - base);
  f.put(id, base + way * (BASE_RADIUS + 30));
  room.supplyDispatch.set(id, true);
  assert(f.until(() => f.errand(id)?.kind === 'build' && world.actor(id).vehicle.flying, 20), 'it takes off for the works');
  const fill = litres => f.parts(id, 'fuel').forEach((tank, i) => f.set(tank, { fuelLitres: i ? 0 : litres }));
  f.run(2); fill(95);
  assert(f.until(() => f.squad.units.get(id).move?.land === 'fuel', 5), 'short of fuel, it turns home for it');
  // What it was left with is given back: how long it swings about the place before it comes down there is its flight's.
  fill(260); f.run(1);
  const job = f.errand(id), told = room.factionView(f.player.playerId).units.find(u => u.id === id);
  assert.deepEqual([job?.kind, job?.targetId, job?.reason], ['build', work, 'refuelling'], 'its job waits for it, no order of the player');
  assert.equal(jobText(told), 'pouco combustível · abastecendo na base');
  assert(f.until(() => !f.squad.units.get(id).move && f.landed(id) && Math.abs(f.x(id) - base) <= BASE_RADIUS, 90), 'it comes down at home');
  assert(f.until(() => f.squad.units.get(id).move?.land === 'work', 60), 'and goes again');
  assert(f.parts(id, 'fuel').every(tank => tank.fuelLitres >= tank.capacityLitres - 1), 'filled up');
  assert.equal(f.errand(id)?.reason, '');
  assert(f.until(() => world.actor(work), 180), 'and puts the works up');
  assert.equal(room.faults.size, 0);
});

// A supply aircraft in automatic, on larger thrusters than the one above, on its way to a works off from home with the
// material it lacks: its job, what the faction is told of it and its pilot's.
function supplying(t) {
  const f = works(t), { room, world } = f, work = f.opened({ from: 300, delivered: false }), id = f.publish(f.player, airSupply({ size: 1.2 })),
    base = room.faction(room.players.get(f.player.playerId)).base.x, job = () => room.supplyDispatch.jobs.get(id);
  assert(f.until(() => job()?.kind === 'work' && job().phase === 'deliver' && world.actor(id).vehicle.flying, 60), 'it takes off with the material');
  assert(f.until(() => Math.abs(f.x(id) - base) > BASE_RADIUS + 50, 30), 'and is on its way, off from home');
  return { ...f, work, id, base, job, told: () => room.factionView(f.player.playerId).units.find(u => u.id === id), unit: () => f.squad.units.get(id) };
}

test('a supply aircraft in automatic that loses in flight a thruster the others do not make up for keeps its job, goes home to be mended and takes the job up again', { timeout: 180000 }, t => {
  const f = supplying(t), { room, world, id, work } = f, pending = room.works.pending.get(work);
  // A front one: the three left hold it up loaded, but not by a quarter more than it weighs.
  f.set(thruster(f, id, 'lift6'), { health: 0 });
  assert(f.until(() => f.unit().move?.land === 'mend', 2), 'it turns home to be mended');
  assert(lifts(world, id) && !steady(world, id));
  // The dispatch looks once a second.
  assert(f.until(() => f.job()?.reason === 'thruster-lost', 2), JSON.stringify(f.job()));
  const kept = f.job();
  assert.deepEqual([kept.kind, kept.targetId], ['work', work], 'its job waits for it, no order of the player');
  assert.equal(jobText(f.told()), 'propulsor perdido · voltando para reparo');
  assert.match(jobAdvice(f.told()), /volta à base ou ao posto mais perto, é reparada lá/);
  assert(f.until(() => f.landed(id) && Math.abs(f.x(id) - f.base) <= BASE_RADIUS, 90), `it comes down at home, at ${f.x(id).toFixed(1)}`);
  // Out of combat by the time it is down, it is mended there at once: its row says so while it is (field-panel.ts).
  assert(f.until(() => room.record(world.actor(id)).service?.kind === 'repair', 30), 'the base mends it');
  assert.equal(f.told().service?.kind, 'repair');
  // Mended, it waits out the fight it was hit in (`threat`) — as if hit a while later, for it is over by then —, and goes
  // again on the same job.
  f.unit().alertUntil = world.time + 20;
  const reasons = new Set();
  assert(f.until(() => { reasons.add(f.job()?.reason); return f.unit().move?.land === 'work'; }, 60), 'mended, it goes again');
  assert.equal(f.job(), kept, JSON.stringify([...reasons]));
  assert(reasons.has('threat') && world.time >= f.unit().alertUntil, JSON.stringify([...reasons]));
  assert.equal(kept.reason, '');
  const before = billTotal(pending.delivered);
  assert(f.until(() => billTotal(pending.delivered) > before, 120), 'and brings the works its material');
  assert.equal(room.faults.size, 0);
});

test('an aircraft that loses in flight a thruster without which it does not hold itself up comes down where it is, gives its job up and waits there to be mended', { timeout: 120000 }, t => {
  const f = supplying(t), { room, world, id } = f;
  // A rear one, the farther from the middle: those left do not hold it up level.
  f.set(thruster(f, id, 'lift0'), { health: 0 });
  assert(f.until(() => f.unit().move?.land === 'forced', 2), 'it comes down where it is');
  assert(!lifts(world, id));
  assert(f.until(() => !f.job(), 2), 'its job is given up');
  assert.equal(jobText(f.told()), 'propulsor perdido · pousando onde está');
  // Low and fast as it flew, it comes down on its way and slides on: its thrusters hold it up no more than they slow it.
  assert(f.until(() => !world.actor(id).vehicle.flying && room.still(world.actor(id)), 40), 'it comes down');
  assert(Math.abs(f.x(id) - f.base) > BASE_RADIUS + 50 && !room.outOfAction()[id], `off from home, and in the fight: ${f.x(id).toFixed(1)}`);
  assert(f.until(() => jobText(f.told()) === 'propulsor perdido · aguardando reparo', 5), jobText(f.told()));
  assert.equal(f.squad.view().units.find(u => u.id === id).reason, 'mending');
  // Its faction gives it nothing meanwhile: it stays where it is.
  f.run(5);
  assert.deepEqual([f.job()?.kind ?? null, world.actor(id).vehicle.flying, f.unit().move], [null, false, null]);
  assert.equal(room.faults.size, 0);
});

test('an aircraft sent to bombard that loses in flight a thruster the others do not make up for gives the order up and goes home to be mended', { timeout: 120000 }, t => {
  const f = vein(t, gunship(), { gap: 400 }), at = f.base - 900;
  f.order(f.player, 'bombard', { ids: [f.id], point: { x: at, y: f.ground.height(at) } });
  assert(f.until(() => f.vehicle().flying && f.unit().move?.purpose === 'strike', 20), 'it flies off to fire on the place');
  f.run(2);
  f.set(thruster(f, f.id, 'lift0'), { health: 0 });
  assert(f.until(() => f.unit().move?.land === 'mend', 2), 'it turns home to be mended');
  assert.deepEqual([f.unit().attack, f.unit().mend], [null, true], 'its order to fire is over');
  assert(f.until(() => !f.vehicle().flying && f.home(), 90), `it comes down at home, at ${f.vehicle().x.toFixed(1)}`);
  assert(f.until(() => !f.unit().mend, 40), 'and is mended there');
  f.run(3);
  assert.deepEqual([f.unit().attack, f.vehicle().flying], [null, false], 'it does not go back to it');
});

test('a builder aircraft with no level ground to come down on by a works gives it up for a while, and says why', { timeout: 60000 }, t => {
  const f = works(t), { room } = f, id = f.publish(f.player, airBuilder()), squad = f.squad;
  squad.level = () => false;
  const work = f.opened();
  assert(f.until(() => room.supplyDispatch.targets.has(work), 10), 'the works is given up for a while');
  const told = room.factionView(f.player.playerId).units.find(u => u.id === id);
  assert.equal(jobText(told), 'sem chão plano para pousar no local');
  assert.match(jobAdvice(told), /^A aeronave só trabalha pousada/);
  assert(!room.world.actor(id).vehicle.flying);
});

// A fall is no attack (game_contact_damage.rs): an aircraft whose tanks ran dry ten metres over its base falls on its skids,
// which break where they hit, and nobody fired at it. It answers no enemy, it is not in combat, and its faction's automatic
// does not wait for safety before it sends it on.
test('an aircraft that falls out of fuel onto its base breaks its skids, and the fall is no attack: its automatic does not wait for safety', { timeout: 60000 }, t => {
  const room = rehearsal([-213, 30000], bill(1e9, 1e9, 1e9, 1e9), { fog: false }), f = onField(t, room), world = room.world,
    player = room.join('Construtora'), owner = room.players.get(player.playerId), id = f.publish(player, airBuilder());
  room.supplyDispatch.set(id, false);
  f.parts(id, 'fuel').forEach(tank => f.set(tank, { fuelLitres: 0 }));
  f.run(2);
  const actor = () => world.actor(id), skids = () => world.plates.filter(p => p.actorId === id && /:chassis:(skid|leg)-\d+$/.test(p.id)),
    told = kind => skids().reduce((sum, p) => sum + p[kind], 0), before = { revision: told('revision'), markRevision: told('markRevision') };
  world.command('setVehicleState', { actorId: id, state: { y: actor().vehicle.y + 10, vy: 0 } });
  assert(f.until(() => actor().vehicle.vy < -12, 5), 'it falls');
  assert(f.until(() => room.still(actor()), 10), 'and is down');
  assert(told('revision') > before.revision && told('markRevision') > before.markRevision, 'its skids are torn and dented where they hit');
  assert.equal(told('groundMarks'), told('revision') + told('markRevision') - before.revision - before.markRevision, 'and the ground did all of it');
  const unit = owner.squad.units.get(id);
  assert(!(unit.alertUntil > world.time) && !(unit.answerUntil > world.time), 'it answers no enemy');
  assert.equal(room.calm(actor()), true, 'it is not in combat');
  assert.equal(room.supplyDispatch.safe(actor(), owner), true);
  room.supplyDispatch.set(id, true); f.run(3);
  assert.notEqual(room.supplyDispatch.waits.get(id)?.reason, 'threat', 'its automatic does not wait for safety');
});

test('an aircraft makes no roads: its blade or screed is told so in the Oficina, and it works for its faction by its other pieces alone', () => {
  const grader = createStructuredTemplate('grader'), flying = withConstructionKind(grader, 'aircraft'),
    actor = source => ({ construction: source, blueprint: compileDraftConstruction(source) });
  assert.deepEqual([roadMachine(actor(grader)), roadMachine(actor(flying))], [true, false]);
  assert.deepEqual([worker(actor(grader)), worker(actor(flying))], [true, false], 'a blade alone is no work for it');
  const blueprint = compileDraftConstruction(flying), supplied = { construction: flying, blueprint: { ...blueprint, modules: [...blueprint.modules, { kind: 'supply' }] } };
  assert.equal(worker(supplied), true, 'a supply piece by it is');
  const row = workshopChecklist(compileDraftConstruction(flying)).find(item => item.id === 'road');
  assert.deepEqual([row.state, row.detail], ['info', 'Aeronave não faz estradas.']);
  assert.notEqual(workshopChecklist(compileDraftConstruction(grader)).find(item => item.id === 'road').detail, 'Aeronave não faz estradas.');
});

test('the faction is told what an aircraft at work does: home for its fuel and filling up, home to be mended and waiting for it, and why it waits or stays', () => {
  assert.equal(haulText({ phase: 'home', fuel: true }), 'transportando · pouco combustível · voltando para abastecer');
  assert.equal(haulText({ phase: 'unload', fuel: true }), 'transportando · abastecendo');
  assert.equal(haulText({ phase: 'home' }), 'transportando · voltando à base');
  const job = reason => ({ auto: true, job: { kind: 'build', phase: 'go', targetId: 'w', reason } });
  assert.equal(jobText(job('refuelling')), 'pouco combustível · abastecendo na base');
  assert.equal(jobText(job('no-landing')), 'sem chão plano para pousar no local');
  assert.equal(jobText(job('out-of-range')), 'longe demais para o combustível');
  assert.match(jobAdvice(job('out-of-range')), /tanque cheio a aeronave não chega lá e volta/);
  // One that lost a thruster the others do not make up for, home for its fuel as well: being mended is what it says.
  assert.equal(haulText({ phase: 'home', fuel: true, mend: true }), 'transportando · propulsor perdido · voltando para reparo');
  assert.equal(haulText({ phase: 'unload', mend: true }), 'transportando · propulsor perdido · aguardando reparo');
  assert.equal(jobText(job('thruster-lost')), 'propulsor perdido · voltando para reparo');
  assert.equal(jobText(job('mending')), 'propulsor perdido · aguardando reparo');
  assert.equal(jobText({ auto: true, job: { kind: null, phase: 'idle', targetId: null, reason: 'forced-landing' } }), 'propulsor perdido · pousando onde está');
  assert.match(jobAdvice(job('mending')), /não recebe tarefas até ser reparada/);
});
