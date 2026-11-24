import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { turnedGrid, turnPlate, turnModule } from '../src/turn-about.ts';
import { TURN_SECONDS } from '../src/economy.ts';
import { worldToLocal } from '../src/math.ts';
import { ORDERS, fieldNotices } from '../src/field-panel.ts';
import { unitServices } from '../src/faction-ui.ts';
import { World } from '../src/physics.ts';
import { MAIN_WORLD, REVERSE_SHARE } from '../src/battle-rules.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Squad } from '../src/squad.ts';
import { onField } from './helpers/field.js';

// A field with its players, and what a test does on it.
function field(t, ...names) {
  const f = onField(t, rehearsal([0, 3000, -3000])), room = f.room, world = room.world, players = names.map(name => room.join(name));
  return { ...f, players,
    turn: (player, ...ids) => f.order(player, 'turn', { ids }),
    unit: (player, id) => room.factionView(player.playerId).units.find(u => u.id === id),
    plates: id => world.plates.filter(p => p.actorId === id), modules: id => world.modules.filter(m => m.actorId === id) };
}
const close = (a, b, tolerance) => Math.abs(a - b) <= tolerance;
// Where a point of the frame of a plate is on the field.
const out = (plate, x, y) => ({ x: plate.frame.x + plate.frame.c * x - plate.frame.s * y, y: plate.frame.y + plate.frame.s * x + plate.frame.c * y });

test('turning preserves a scar on the same physical base foot and a second turn restores it', () => {
  const original = { weaponMount: {}, marks: [{ part: 2, u: .25, v: .375, radiusU: .02, kind: 'dent' },
    { u: .5, v: .25, radiusU: .01, kind: 'hole' }] }, turned = { weaponMount: {} }, restored = { weaponMount: {} };
  turnModule(turned, original);
  assert.deepEqual(turned.marks[0], { ...original.marks[0], part: 3, v: .625 });
  assert.equal(turned.marks[1].v, .75); assert.equal(turned.marks[1].part, undefined);
  turnModule(restored, turned); assert.deepEqual(restored.marks, original.marks);
});

test('integrated fixed-foot prefix stays canonical when a real actor is admitted at either facing', async t => {
  await initNativeDynamics();
  const blueprint = createStructuredTemplate('heavy'), world = new World(blueprint); t.after(() => world.dispose());
  for (const facing of [-1, 1]) {
    world.replaceActor(world.construction, { id: 'local', x: 12, facing });
    const gun = world.modules.find(module => module.kind === 'weapon');
    assert.equal(gun.weaponMount.exposed, false);
    assert(gun.materialPolygons[2].every(point => point.y > 0));
    assert(gun.materialPolygons[3].every(point => point.y < 0));
    const told = world.snapshot().modules.find(module => module.id === gun.id);
    assert(told.materialPolygons[2].every(point => point.y > 0));
    assert(told.materialPolygons[3].every(point => point.y < 0));
  }
});

test('the armour grid of a plate turned about has lost on one side of its thickness what it had lost on the other', () => {
  // Four columns of sixteen rows: a cell is a bit, the rows going across the thickness.
  const grid = (...lost) => {
    const cells = new Uint8Array(8).fill(255);
    for (const [x, y] of lost) cells[(y * 4 + x) >> 3] &= ~(1 << ((y * 4 + x) & 7));
    return { version: 1, nx: 4, ny: 16, bounds: { minX: -.04, maxX: .04, minY: -.01, maxY: .01 }, bits: Array.from(cells, byte => byte.toString(16).padStart(2, '0')).join('') };
  };
  const whole = grid();
  assert.deepEqual(turnedGrid(whole, grid([1, 0], [2, 3])), grid([1, 15], [2, 12]));
  // A plate that lost nothing has the grid of its design itself: nothing of it is made again.
  assert.equal(turnedGrid(whole, grid()), whole);
  // What the design cut out of a plate stays where the design has it, whichever way it faces: only what was lost since is turned over.
  const port = grid([0, 0], [0, 1], [3, 15]);
  assert.deepEqual(turnedGrid(port, grid([0, 0], [0, 1], [3, 15], [2, 0])), grid([0, 0], [0, 1], [3, 15], [2, 15]));
  assert.equal(turnedGrid(port, grid([0, 0], [0, 1], [3, 15])), port);
  assert.throws(() => turnedGrid(whole, { ...whole, nx: 5 }), /outro projeto/);
  // A plate that came into the field when the design made it of another length comes back as the design has it now.
  const fresh = { ballisticGrid: whole, marks: [] }, made = structuredClone(fresh);
  turnPlate(fresh, { ballisticGrid: { ...grid([1, 0]), nx: 5, bits: '00'.repeat(10) }, marks: [{ u: .5, v: .2, kind: 'hole' }], perforations: [], revision: 3 });
  assert.deepEqual(fresh, made);
});

test('a component turned about keeps what it holds and what became of it, its marks on the side they were on', () => {
  const marks = [{ u: .2, v: .9, kind: 'hole', strength: 1, radiusU: .01 }];
  // A gun is mounted like a plate: its length stays and its thickness turns over. So do the marks along its barrel.
  const gun = { weaponMount: {}, health: 400, physicalMass: 900 };
  turnModule(gun, { weaponMount: {}, health: 120, reload: 1.5, barrelTemperature: 410, barrelCooling: true, loaded: 7, feedReload: 3.25, barrelDamage: 30, barrelDisabled: true, beltCut: true, markRevision: 4, physicalMass: 700,
    marks, barrelMarks: [{ x: 1.2, y: .01, radius: .025 }], mantletHoles: [{ min: -.7, max: -.6 }, { min: .2, max: .4 }], elevationDamage: .8, elevationDisabled: true });
  assert.deepEqual(gun, { weaponMount: {}, health: 120, physicalMass: 900, reload: 1.5, barrelTemperature: 410, barrelCooling: true, loaded: 7, feedReload: 3.25, barrelDamage: 30, barrelDisabled: true, beltCut: true, markRevision: 4,
    marks: [{ ...marks[0], v: 1 - .9 }], barrelMarks: [{ x: 1.2, y: -.01, radius: .025 }], mantletHoles: [{ min: -.4, max: -.2 }, { min: .6, max: .7 }], elevationDamage: .8, elevationDisabled: true });
  // Any other component keeps its height and turns end for end, with the scars of what went through it.
  const cargo = { ferro: 300, ligas: 0, silica: 0 }, hopper = { health: 900, cargo: { ferro: 0, ligas: 0, silica: 0 } };
  turnModule(hopper, { health: 500, cargo, burning: true, burnAge: 2, detonated: false, marks, ballisticScars: { '3:7': 1.5, '31:0': .2 } });
  assert.deepEqual(hopper, { health: 500, cargo, burning: true, burnAge: 2, detonated: false, marks: [{ ...marks[0], u: 1 - .2 }], ballisticScars: { '28:7': 1.5, '0:0': .2 } });
  assert.notEqual(hopper.cargo, cargo);
  const tank = { fuelLitres: 400 }, magazine = { rounds: 30 };
  turnModule(tank, { fuelLitres: 12.5 }); turnModule(magazine, { rounds: 4 });
  // What it weighs is not carried: the core weighs the construction again by what it holds.
  assert.deepEqual([tank, magazine, gun.physicalMass], [{ fuelLitres: 12.5 }, { rounds: 4 }, 900]);
});

test('a construction turns about where it stands in five seconds, and is what it was: its damage on the side it was on, its load and its counts', t => {
  const { room, world, players: [ana], publish, send, turn, unit, run, plates, modules, set } = field(t, 'Ana');
  assert.equal(TURN_SECONDS, 5);
  const tank = publish(ana, 'heavy'), lorry = publish(ana, 'supply'); send(ana, 'auto', { actorId: lorry, on: false }); run(2);
  // The lorry carries supplies: out of automatic, its base filled it. The tank was hit from one side, has fired and holds less than it was built with.
  const carried = unit(ana, lorry).supplies;
  const body = world.actor(tank).vehicle; world.explode(body.x - 2.5, body.y + 1, 60, 6);
  // And its thickest plate is eaten into on one face, a quarter of the way through.
  const thick = plates(tank).reduce((most, p) => p.definition.thicknessMm > most.definition.thicknessMm ? p : most), across = thick.definition.thicknessMm / 1000,
    face = out(thick, 0, across / 2);
  assert.equal(world.cutBody(thick, face, face, across / 4).length, 1);
  const magazine = modules(tank).find(m => m.kind === 'ammo'), fuel = modules(tank).find(m => m.kind === 'fuel');
  set(magazine, { rounds: 4 }); set(fuel, { fuelLitres: 37 });
  send(ana, 'squad', { order: 'control', id: tank });
  send(ana, 'fire', { actorId: tank, aim: { x: body.x + 400, y: body.y + 30 }, weapon: { id: 'cannon' }, queue: true });
  // It turns soon after it fired: in combat still when the turn is over, it has not been filled up again by then.
  for (let i = 0; i < 80 && !world.actor(tank).stats.shots; i++) run(.1);
  send(ana, 'squad', { order: 'control', id: null }); run(1);
  // What stands of a construction, in the frame of its own hull: where each mark of each plate is, what is left of each plate, and what each component is and holds.
  const where = (plate, mark, pose) => {
    const f = plate.materialFrame;
    return worldToLocal(pose, out(plate, f.x + f.u.x * mark.u + f.v.x * mark.v, f.y + f.u.y * mark.u + f.v.y * mark.v));
  };
  const picture = id => {
    world.sync();
    const actor = world.actor(id), pose = actor.vehicle.pose(), bounds = world.actorBounds(id);
    return { facing: actor.facing, revision: actor.revision, stats: { ...actor.stats }, bounds,
      plates: plates(id).map(p => ({ integrity: p.integrity, marks: p.marks.map(mark => ({ ...mark })), dents: [...(p.dents?.values() || [])].map(dent => ({ ...dent })),
        perforations: p.perforations.map(hole => ({ ...hole })),
        regions: p.solidRegions.map(r => [r.minX, r.maxX, r.minY, r.maxY]), places: p.marks.map(mark => where(p, mark, pose)) })),
      modules: modules(id).map(m => ({ kind: m.kind, health: m.health, fuelLitres: m.fuelLitres, rounds: m.rounds, cargo: m.cargo && { ...m.cargo },
        detonated: m.detonated, burning: m.burning, marks: (m.marks || []).map(mark => ({ ...mark })), gun: Boolean(m.weaponMount) })) };
  };
  const before = picture(tank), loaded = picture(lorry);
  assert(before.stats.shots > 0, 'the tank fired'); assert.equal(modules(tank).find(m => m.kind === 'ammo').rounds, 4 - before.stats.shots);
  assert(before.plates.some(p => p.marks.length) && before.plates.some(p => p.dents.length), 'and is marked and dented');
  assert(before.plates.some(p => p.perforations.length), 'and holed');
  assert(carried.ferro > 0, 'the lorry carries supplies');

  // Both are asked to turn at once. Each is held as by a repair: every screen is told so, and its faction too.
  assert.deepEqual(turn(ana, tank, lorry), { turning: [tank, lorry], seconds: TURN_SECONDS });
  const until = world.time + TURN_SECONDS;
  for (const id of [tank, lorry]) {
    assert.deepEqual(world.snapshot().actors.find(a => a.id === id).field, { wreck: null, service: { kind: 'turn', until } });
    assert.deepEqual([unit(ana, id).service.kind, unit(ana, id).service.until], ['turn', until]);
  }
  // Held, it neither moves nor fires, and takes no other work: nor is it asked to turn again.
  send(ana, 'squad', { order: 'control', id: tank });
  const stood = world.actor(tank).vehicle.x;
  assert.deepEqual(send(ana, 'drive', { throttle: 1, brake: 0 }), {}, 'an input on its way is dropped');
  assert.throws(() => send(ana, 'fire', { request: 1, aim: { x: 400, y: 760 }, weapon: { id: 'cannon' } }), /está virando/);
  for (const work of ['repair', 'remove', 'dump-cargo']) assert.throws(() => send(ana, work, { actorId: tank }), /está virando/);
  assert.throws(() => turn(ana, tank, lorry), /está virando/);
  assert.throws(() => send(ana, 'cancel-repair', { actorId: tank }), /não está em reparo/);
  run(TURN_SECONDS - .3);
  assert.deepEqual([world.actor(tank).facing, world.actor(lorry).facing, world.actor(tank).revision], [before.facing, loaded.facing, before.revision], 'not before its time');
  assert(Math.abs(world.actor(tank).vehicle.x - stood) < .5 && world.actor(tank).stats.shots === before.stats.shots);
  run(.5);

  // Turned: each faces the other way, free, a construction admitted anew under the name it had.
  const after = picture(tank), unloaded = picture(lorry);
  assert.deepEqual([after.facing, unloaded.facing, after.revision, unloaded.revision], [-before.facing, -loaded.facing, before.revision + 1, loaded.revision + 1]);
  for (const id of [tank, lorry]) { assert.equal(world.snapshot().actors.find(a => a.id === id).field, null); assert.equal(unit(ana, id).service, null); }
  assert.equal(room.players.get(ana.playerId).squad.manual, tank, 'the one in hand is still in hand');
  // In the stretch of ground it took up: a hull is seldom laid about the middle of its design.
  for (const [was, is] of [[before, after], [loaded, unloaded]])
    assert(close(is.bounds.minX, was.bounds.minX, .15) && close(is.bounds.maxX, was.bounds.maxX, .15), `from ${[was.bounds.minX, was.bounds.maxX]} to ${[is.bounds.minX, is.bounds.maxX]}`);
  // What it counted is counted still.
  assert.deepEqual(after.stats, before.stats);
  // Every plate is as whole as it was, with each mark and dent on the face it was on: the other side of its frame.
  const turnedOver = list => list.map(mark => ({ ...mark, v: 1 - mark.v }));
  for (const [i, was] of before.plates.entries()) {
    const is = after.plates[i];
    // As whole to the last digits that adding its pieces up in another order changes.
    assert(close(is.integrity, was.integrity, 1e-12), `${is.integrity} against ${was.integrity}`); assert.deepEqual(is.marks, turnedOver(was.marks)); assert.deepEqual(is.dents, turnedOver(was.dents));
    assert.deepEqual(is.perforations, was.perforations);
    const mirrored = was.regions.map(([minX, maxX, minY, maxY]) => [minX, maxX, -maxY, -minY]), order = (a, b) => a[0] - b[0] || a[2] - b[2] || a[1] - b[1] || a[3] - b[3];
    assert.deepEqual(is.regions.map(r => r.map(n => +n.toFixed(9))).sort(order), mirrored.map(r => r.map(n => +n.toFixed(9))).sort(order), 'what is left of it is its mirror image');
    // And where it was on the hull: as far to the other side of it, as high.
    for (const [k, place] of was.places.entries()) assert(close(is.places[k].u, -place.u, 1e-6) && close(is.places[k].v, place.v, 1e-6), `a mark at ${[place.u, place.v]} is at ${[is.places[k].u, is.places[k].v]}`);
  }
  assert(before.plates.some((was, i) => JSON.stringify(after.plates[i].regions) !== JSON.stringify(was.regions)), 'a plate eaten into on one face is eaten into on the other');
  // Every component is what it was and holds what it held: the rounds left, the fuel, the load.
  assert.deepEqual(after.modules.map(({ marks, ...kept }) => kept), before.modules.map(({ marks, ...kept }) => kept));
  for (const [i, was] of before.modules.entries()) assert.deepEqual(after.modules[i].marks, was.marks.map(mark => was.gun ? { ...mark, v: 1 - mark.v } : { ...mark, u: 1 - mark.u }));
  assert.deepEqual(unloaded.modules.map(({ marks, ...kept }) => kept), loaded.modules.map(({ marks, ...kept }) => kept));
  assert.equal(modules(tank).find(m => m.kind === 'ammo').rounds, 4 - before.stats.shots);
  assert.deepEqual(unit(ana, lorry).supplies, carried, 'a supply vehicle is one still, with what it carried');
  // It is driven and fired again at once, and fires the way it faces now.
  const gun = world.actor(tank).vehicle;
  send(ana, 'fire', { actorId: tank, aim: { x: gun.x + after.facing * 400, y: gun.y + 30 }, weapon: { id: 'cannon' }, queue: true });
  run(8); assert.equal(world.actor(tank).stats.shots, before.stats.shots + 1);
  // And turned about once more it is as it was at first, mark for mark.
  turn(ana, tank); run(TURN_SECONDS + .2);
  const back = picture(tank);
  assert.equal(back.facing, before.facing);
  const same = (is, was) => is.u === was.u && close(is.v, was.v, 1e-9) && is.depth === was.depth && is.radius === was.radius;
  for (const [i, was] of before.plates.entries()) {
    assert(was.marks.every((mark, k) => same(back.plates[i].marks[k], mark) && back.plates[i].marks[k].kind === mark.kind));
    assert(back.plates[i].dents.length === was.dents.length && was.dents.every((dent, k) => same(back.plates[i].dents[k], dent)));
  }
});

test('on a slope a construction turns about lying along the ground, where it lay, and does not fall onto it', async t => {
  await initNativeDynamics();
  const blueprint = createStructuredTemplate('truck'); blueprint.terrain = MAIN_WORLD.terrain;
  const world = new World(blueprint, { scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } }); t.after(() => world.dispose());
  const height = x => world.terrain.height(x), run = seconds => { for (let i = 0; i < seconds * 60; i++) world.step(1 / 60); },
    lying = () => { world.sync(); const { x, y, angle, vy } = world.actor('local').vehicle; return { x, y, angle, vy }; };
  // A stretch of the field that climbs a sixth as steadily over twelve metres as over six.
  let site = 2000;
  while (!(Math.abs(Math.abs((height(site + 6) - height(site - 6)) / 12) - .18) < .04 && Math.abs((height(site + 6) - height(site - 6)) / 12 - (height(site + 3) - height(site - 3)) / 6) < .01)) site += 7;
  const slope = Math.atan((height(site + 6) - height(site - 6)) / 12);
  world.replaceActor(world.construction, { id: 'local', ownerId: 'me', x: site, facing: -1 }); run(4);
  const stood = lying();
  assert(Math.abs(stood.angle - slope) < .02 && Math.abs(stood.vy) < .05, 'it came to rest along the slope');
  world.turnActor('local');
  const turned = lying();
  assert.equal(world.actor('local').facing, 1);
  // As it lay: as steep, as high, not a hand above where it stood.
  assert(Math.abs(turned.angle - stood.angle) < .02, `at ${turned.angle}, not ${stood.angle}`);
  assert(Math.abs(turned.y - stood.y) < .1, `at ${turned.y}, not ${stood.y}`);
  // And it stays there: it does not fall.
  run(.5); const settled = lying();
  assert(Math.abs(settled.y - stood.y) < .1 && Math.abs(settled.angle - stood.angle) < .02 && Math.abs(settled.vy) < .3);
});

test('a hit undoes a turning about: the construction stays as it faced, free at once', t => {
  const { room, world, players: [ana, bia], publish, send, turn, unit, run, modules, set } = field(t, 'Ana', 'Bia');
  const tank = publish(ana, 'heavy'), scout = publish(ana, 'scout'), other = publish(bia, 'scout'); run(2);
  const facing = world.actor(tank).facing;
  turn(ana, tank, scout); run(2);
  const body = world.actor(tank).vehicle; world.explode(body.x + 2.5, body.y + 1, 30, 6); run(.3);
  assert.deepEqual([world.actor(tank).facing, world.actor(tank).revision, world.snapshot().actors.find(a => a.id === tank).field, unit(ana, tank).service], [facing, 0, null, null]);
  // The one beside it was not hit, and turns.
  run(TURN_SECONDS); assert.deepEqual([world.actor(tank).facing, world.actor(scout).facing], [facing, -facing]);
  // Asked again once the fire is over, it turns: being out of combat is not asked of it.
  assert(!unit(ana, tank).calm); turn(ana, tank); run(TURN_SECONDS + .2); assert.equal(world.actor(tank).facing, -facing);

  // Nobody turns what is not theirs, nor a wreck, nor a construction under repair; of those asked, the ones that are held go on as they were.
  assert.throws(() => turn(ana, other), /Selecione a construção/); assert.throws(() => turn(ana), /Selecione a construção/);
  const engine = modules(tank).find(m => m.kind === 'engine');
  // Out of combat in its base, it is mended by itself.
  set(engine, { health: engine.maxHealth / 2 }); for (let i = 0; i < 110 && !unit(ana, tank).service; i++) run(.1);
  const mending = unit(ana, tank).service; assert.equal(mending?.kind, 'repair');
  assert.throws(() => turn(ana, tank), /em reparo/);
  assert.deepEqual(turn(ana, tank, scout).turning, [scout]);
  run(TURN_SECONDS + .2); assert.equal(world.actor(scout).facing, facing);
  for (let i = 0; i < 600 && unit(ana, tank).service; i++) run(.1);
  assert.equal(unit(ana, tank).service, null); assert(world.time > mending.until);
  room.wreck(world.actor(scout)); assert.throws(() => turn(ana, scout), /Selecione a construção/);
  // On its way somewhere ahead of it, it stops to turn: the way it was on ends there.
  send(ana, 'squad', { order: 'move', ids: [tank], x: world.actor(tank).vehicle.x + world.actor(tank).facing * 300 }); run(4);
  assert(Math.abs(world.actor(tank).vehicle.vx) > 1, 'the tank is on its way');
  turn(ana, tank); run(TURN_SECONDS + .5);
  assert(Math.abs(world.actor(tank).vehicle.vx) < .5 && room.players.get(ana.playerId).squad.units.get(tank).move === null);
});

test('the panel offers turning about, says who is turning and tells of a turn a hit undid', () => {
  const order = ORDERS.find(order => order.id === 'turn');
  assert.deepEqual(order, { id: 'turn', name: 'Virar', key: 'V', hint: '' });
  assert.equal(new Set(ORDERS.map(order => order.key)).size, ORDERS.length, 'no two orders by one key');
  // A construction turning about has nothing to ask for, and the line says why.
  const services = unitServices({ id: 'a', service: { kind: 'turn', until: 9 }, atBase: true, cargo: {}, point: { supplier: null } }, { stock: {} });
  assert.deepEqual(services.jobs, []); assert.match(services.held, /^Virando: /);
  // From one look to the next: a turn that is over with the vehicle facing as it did was undone by a hit; one that turned it says nothing.
  const watch = (turns, facing) => ({ faction: null, fell: null, recovered: null, met: [], veins: null, hauls: [], batteries: [], repairs: [], partly: [], builds: [], cancelled: [], ills: [], gone: {},
    units: [{ id: 'a', label: 'Veículo 1 · Ana' }, { id: 'b', label: 'Veículo 2 · Ana' }], turns, facing });
  const memo = {};
  assert.deepEqual(fieldNotices(memo, watch(['a', 'b'], { a: 1, b: 1 }), 10), []);
  assert.deepEqual(fieldNotices(memo, watch(['b'], { a: 1, b: 1 }), 11), ['Veículo 1 · Ana: atingido enquanto virava — ficou como estava.']);
  assert.equal(memo.grave, true);
  assert.deepEqual(fieldNotices(memo, watch([], { a: 1, b: -1 }), 12), []);
});

// One vehicle of the squad, facing -X at the middle of a field that turns it about when the squad asks (`turned`),
// with `top` for its top speed and a gun when `armed`.
function lone({ top = 15, armed = false, vx = 0 } = {}) {
  const turned = [], actor = { facing: -1, vehicle: { x: 0, vx, groundSlope: 0, config: { enabled: true }, drivetrain: { maxSpeed: top } } };
  const squad = new Squad({ world: { time: 0, actor: () => actor, modules: armed ? [{ actorId: 'a', kind: 'weapon', health: 1 }] : [], terrain: { minX: -5000, maxX: 5000 } },
    roster: [{ id: 'a', team: 'local', role: 'armor' }], defeats: {}, input() {}, veinAt: () => null,
    turnAbout: id => (turned.push(id), true) });
  squad.command({ order: 'control', id: null });
  const sent = (x, contact = null) => { squad.command({ order: 'move', ids: ['a'], x }); return squad.drive('a', squad.units.get('a'), contact); };
  return { squad, actor, turned, sent };
}

test('sent far enough behind it that backing all the way is slower than turning about and driving, a vehicle turns about first', () => {
  assert.equal(REVERSE_SHARE, .4);
  // At 15 m/s, backing takes 1.5 times as long as driving: a turn of five seconds pays from 80 m on, with three to spare.
  let { turned, sent } = lone();
  assert.deepEqual(sent(-500), { throttle: -1, brake: 0 }, 'ahead it just drives'); assert.deepEqual(turned, []);
  assert(sent(60).throttle > 0, 'a little way behind it backs'); assert.deepEqual(turned, []);
  assert.deepEqual(sent(500), { throttle: 0, brake: 1 }); assert.deepEqual(turned, ['a']);
  // A slower one turns for less of a way, a faster one for more.
  ({ turned, sent } = lone({ top: 5 })); sent(60); assert.deepEqual(turned, ['a']);
  ({ turned, sent } = lone({ top: 40 })); sent(150); assert.deepEqual(turned, []);
  // Rolling, it stops before it turns.
  ({ turned, sent } = lone({ vx: -6 })); assert.deepEqual(sent(500), { throttle: 0, brake: 1 }); assert.deepEqual(turned, []);
});

test('a vehicle with a gun backs off from an enemy ahead in its senses, its front to it, and none turns about in a fight; one without a gun turns to get away', () => {
  const ahead = { detected: true, age: 0, x: -600 }, behind = { ...ahead, x: 600 }, lost = { ...ahead, age: 3 };
  let { squad, turned, sent } = lone({ armed: true });
  sent(500, ahead); assert.deepEqual(turned, [], 'an enemy ahead');
  sent(500, lost); sent(500, behind); assert.deepEqual(turned, ['a', 'a'], 'one it lost, or one behind it');
  ({ turned, sent } = lone()); sent(500, ahead); assert.deepEqual(turned, ['a'], 'a lorry turns to flee');
  ({ squad, turned, sent } = lone()); squad.units.get('a').alertUntil = 10; sent(500); assert.deepEqual(turned, [], 'hit a moment ago');
  // One the field will not turn about, something holding it, backs the whole way.
  ({ squad, turned, sent } = lone()); squad.side.turnAbout = () => false; assert(sent(500).throttle > 0);
});

test('on the field a vehicle sent far behind it turns about by itself and drives there front first; sent a little way, it backs', t => {
  const { room, world, players: [ana], publish, run, unit } = field(t, 'Ana');
  const lorry = publish(ana, 'truck'); run(2);
  const facing = world.actor(lorry).facing, x = () => world.actor(lorry).vehicle.x, move = room.players.get(ana.playerId).squad.units.get(lorry),
    send = to => room.command(ana.playerId, { type: 'squad', order: 'move', ids: [lorry], x: to });
  room.command(ana.playerId, { type: 'squad', order: 'control', id: null });
  send(x() - facing * 20); run(1); assert.equal(unit(ana, lorry).service, null, 'a little way, it backs');
  for (let i = 0; i < 30 && move.move; i++) run(1);
  assert.deepEqual([move.move, world.actor(lorry).facing], [null, facing]);
  const far = x() - facing * 400; send(far); run(.5);
  assert.equal(unit(ana, lorry).service?.kind, 'turn');
  run(TURN_SECONDS + .5); assert.equal(world.actor(lorry).facing, -facing);
  // It went on there by itself, front first, and got there.
  let backed = false;
  for (let i = 0; i < 120 && move.move; i++) { run(.5); backed ||= world.actor(lorry).vehicle.vx * -facing < -1; }
  assert.equal(move.move, null); assert(!backed, 'it never backed'); assert(Math.abs(x() - far) < 5, `it stands ${x() - far} m from where it was sent`);
});

test('turned about by its player, a vehicle sent towards its new front drives there front first, at any distance', t => {
  const { room, world, players: [ana], publish, run, turn } = field(t, 'Ana');
  const lorry = publish(ana, 'truck'); run(2);
  const facing = world.actor(lorry).facing, x = () => world.actor(lorry).vehicle.x, move = room.players.get(ana.playerId).squad.units.get(lorry);
  room.command(ana.playerId, { type: 'squad', order: 'control', id: null });
  turn(ana, lorry); run(TURN_SECONDS + .5);
  assert.equal(world.actor(lorry).facing, -facing);
  for (const distance of [20, 200]) {
    const to = x() - facing * distance;
    room.command(ana.playerId, { type: 'squad', order: 'move', ids: [lorry], x: to });
    // Its trip there, and not the one home it is sent on in automatic, with nothing more to do, once it is there.
    const leg = move.move;
    let backed = false;
    for (let i = 0; i < 120 && move.move === leg; i++) { run(.5); backed ||= move.move === leg && world.actor(lorry).vehicle.vx * -facing < -.5; }
    assert.equal(world.actor(lorry).facing, -facing, `${distance} m: it did not turn about again`);
    assert(!backed, `${distance} m: it never backed`); assert(Math.abs(x() - to) < 5, `${distance} m: it stands ${x() - to} m from where it was sent`);
  }
});
