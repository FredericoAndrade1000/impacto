import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { asked, rehearsal } from '../server/room.ts';
import { flightTime } from '../src/workshop-context.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileDraftConstruction, compileManufacture, compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionEditMessage, structuredComponent } from '../src/structured-editing.ts';
import { workshopChecklist, workshopReviewPart } from '../src/workshop-checklist.ts';
import { kindChoices, pieceSettings } from '../src/piece-settings.ts';
import { withChassisSuspension, withConstructionKind } from '../src/chassis-editing.ts';
import { SKID_LEG, SKID_RISE, skidRange, suspensionHeight } from '../src/chassis.ts';
import { projectRefusalMessage } from '../src/project-refusal.ts';
import { turnMagnets, turnStep, turnedHeading, turnsFree } from '../src/turn-handle.ts';
import { designation } from '../src/designation.ts';
import { driveIntent, flies, trialHint } from '../src/ui-model.ts';
import { STICK_STILL, stickAt } from '../src/touch.ts';
import { CELL } from '../src/grid.ts';
import { componentDimensions } from '../src/component-size.ts';
import { onField } from './helpers/field.js';
import { thrustShare } from '../src/atmosphere.ts';
import { Squad, GAP, descentCost, flight } from '../src/squad.ts';
import { airBuilder } from './helpers/aircraft.js';
import { bill } from '../src/economy.ts';

await initNativeDynamics();

// A scout with thrusters, each `[x, y, angle, size]` in metres and radians of its design, over its hull, as the core's
// own tests fly it (game_hover_tests.rs): two upright on either side of the middle; on its wheels, as a field kept
// before there were aircraft holds one (`wheeled`), or built as an aircraft, on skids where its wheels were. It is a
// design the Oficina tells of, not one it builds: nothing holds the thrusters up there.
const PAIR = [[-1.6, 4.5, 0, 1.5], [1.6, 4.5, 0, 1.5]];
function wheeled(thrusters) {
  const source = createStructuredTemplate('scout');
  thrusters.forEach(([x, y, angle, size], i) => source.components.push({ id: `lift${i}`, kind: 'thruster', metal: 'titanium', sizeScale: size,
    pose: { x: x / CELL, y: y / CELL, angle } }));
  return source;
}
const flier = thrusters => withConstructionKind(wheeled(thrusters), 'aircraft');
// An aircraft that may be published: the chassis of the stock truck without its cab, as an aircraft, its tank at the
// front, its command post on the bed behind it and its engine, smaller, at the back — 0.512 of the room of the reference,
// 92 kW and 451 kg — and between them four thrusters of the reference size standing on the bed — two upright either side
// of its centre of mass and one leant 45° out beyond each, which push it along the field.
function built() {
  const stock = createStructuredTemplate('chassis');
  Object.assign(stock, { plates: [], nodes: [] });
  stock.components = stock.components.filter(m => m.kind !== 'sensor');
  const source = withConstructionKind(stock, 'aircraft'), bed = compileDraftConstruction(source).plates.find(plate => plate.id === 'chassis:top-0'),
    floor = bed.y - 1.3 + bed.thicknessMm / 2000, part = kind => source.components.find(m => m.kind === kind),
    standing = (piece, x) => { piece.pose = { x: x / CELL, y: (floor + componentDimensions(piece, piece.sizeScale ?? 1).height / 2) / CELL, angle: 0 }; },
    leant = (.64 + 1.31) / 2 * Math.SQRT1_2;
  part('engine').sizeScale = Math.sqrt(.512);
  standing(part('engine'), 2.9); standing(part('fuel'), -2.75); standing(part('command'), -2);
  [[-1.1, floor + leant, -Math.PI / 4], [-.05, floor + 1.31 / 2, 0], [.62, floor + 1.31 / 2, 0], [1.67, floor + leant, Math.PI / 4]]
    .forEach(([x, y, angle], i) => source.components.push({ id: `lift${i}`, kind: 'thruster', metal: 'titanium', pose: { x: x / CELL, y: y / CELL, angle } }));
  return source;
}
// That aircraft on skids raised as high as the Oficina raises them, a heavy machine gun hung under the middle of its hull,
// pointed 45° down and ahead — its front is at the smaller x of the design — and turning to straight down or level ahead,
// and a box of its rounds at the front of its bed.
function gunship() {
  const source = withChassisSuspension(built(), suspensionHeight(built().chassis) + SKID_RISE),
    bed = compileDraftConstruction(source).plates.find(plate => plate.id === 'chassis:top-0'), floor = bed.y - 1.3 + bed.thicknessMm / 2000,
    box = { id: 'rounds', kind: 'ammo', ammoPreset: 'm2hb', sizeScale: .6 };
  box.pose = { x: -3.5 / CELL, y: (floor + componentDimensions(box, .6).height / 2) / CELL, angle: 0 };
  source.components.push(box, { id: 'gun', kind: 'weapon', weaponPreset: 'm2hb', pose: { x: 0, y: source.chassis.points[0].y - 22, angle: -3 * Math.PI / 4 },
    mount: { preset: 'pintle', sector: { min: -Math.PI / 4, max: Math.PI / 4 } } });
  return source;
}
const flightRow = source => workshopChecklist(compileDraftConstruction(source)).find(item => item.id === 'flight');

test('the Oficina tells whether the thrusters of an aircraft lift it full with room to climb, and whether they hold it level', () => {
  assert.equal(flightRow(createStructuredTemplate('scout')), undefined, 'a vehicle with none is told nothing of flight');
  // Two of one and a half times the reference size push up with 105.1 kN, 1.5² times what two of it do: they carry
  // 8.57 t with a quarter to spare.
  const pair = compileDraftConstruction(flier(PAIR));
  assert(Math.abs(pair.chassis.limitKg - 2 * 23350 * 1.5 ** 2 / (9.81 * 1.25)) < 1, pair.chassis.limitKg);
  assert.deepEqual(flightRow(flier(PAIR)), { id: 'flight', label: 'Voo', state: 'ready', detail: 'Decola com até 8,6 t.', target: 'adjust' });
  assert.equal(flightRow(built()).state, 'ready');
  const weak = flightRow(flier([[-1.6, 4.5, 0, .5], [1.6, 4.5, 0, .5]]));
  assert.equal(weak.state, 'attention');
  assert.match(weak.detail, /^Não decola: [\d,]+ t com tudo cheio, e os propulsores erguem até [\d,]+ t com folga\./);
  // Both on the same side of its centre of mass, they turn it over as they lift it.
  assert.equal(flightRow(flier([[1.6, 4.5, 0, 1.5], [3.4, 4.5, 0, 1.5]])).detail,
    'Não se equilibra, nem inclinada: aproxime o centro de massa do meio dos propulsores.');
  // Turned down, they push nothing up.
  assert.match(flightRow(flier(PAIR.map(([x, y, , size]) => [x, y, Math.PI, size]))).detail, /^Não decola/);
  // What it is told of its flight it is not told again of its chassis.
  assert(!workshopChecklist(compileDraftConstruction(flier([]))).some(item => item.id === 'chassis'));
  // The suggestion opens a thruster.
  assert.equal(workshopReviewPart(compileDraftConstruction(flier(PAIR)), 'flight'), 'lift0');
});

test('an aircraft whose centre of mass is past its upright thrusters is still flown on them, a jet laid along its hull turning it back', () => {
  // A ton hovering level 100 m up: a large upright 10 cm behind its centre of mass and a small one 3 m behind turn it the
  // same way, as when the tanks ahead of them run dry; a jet laid along its hull 1.5 m over that centre, pushing it
  // towards less x, turns it back.
  const thruster = (x, y, angle, thrustN) => ({ actorId: 'a', kind: 'thruster', health: 1, x, y: 100 + y, angle, thrustN }),
    can = modules => flight({ modules, terrain: { height: () => 0 },
      actor: () => ({ facing: 1, contactContours: [], vehicle: { x: 0, y: 100, angle: 0, vx: 0, mass: 1000, drivetrain: {} } }) }, 'a'),
    share = thrustShare(100), uprights = [thruster(-.1, 0, 0, 20000), thruster(-3, 0, 0, 6000)], jet = thruster(0, 1.5, Math.PI / 2, 20000);
  assert.equal(can(uprights).climbs, -9.81, 'on its upright thrusters alone nothing holds it up level');
  // With the jet, all of the large one holds it up and some of the small one, leant 15° at the most for what the jet
  // pushes it along with, and its pilot reckons it is pushed along the field towards less x by the jet as well as by
  // leaning it, as its flight computer pushes it (game_hover.rs `side`).
  const jetted = can([...uprights, jet]);
  assert(jetted.climbs > 20000 * share / 1000 - 9.81 && jetted.climbs < 26000 * share / 1000 - 9.81, `climbs at ${jetted.climbs} m/s²`);
  assert(jetted.along[1] > 0 && Math.abs(jetted.along[0] - jetted.along[1] - 20000 * share / 1000) < 1e-6, `along ${jetted.along}`);
  // Hovering still on the large one, the jet pushes it towards less x by what turns it back from 10 cm off at 1.5 m: it
  // hovers leant to bear that, which its pilot does not read as a lean that speeds it up (`fly`).
  assert(Math.abs(jetted.poise + 9.81 * .1 / 1.5) < 1e-9, `poise ${jetted.poise}`);
  // Upright either side of that centre, they hold it up as they would without it.
  const level = [thruster(.5, 0, 0, 10000), thruster(-1, 0, 0, 10000)];
  assert(Math.abs(can(level).climbs - (15000 * share / 1000 - 9.81)) < 1e-9 && can([...level, jet]).climbs === can(level).climbs && can([...level, jet]).poise === 0);
});

test('an aircraft is a kind of construction of its own, on skids, and the thruster is built on it alone', () => {
  const scout = createStructuredTemplate('scout'), choice = kindChoices(scout).find(kind => kind.id === 'aircraft');
  assert.equal(choice.name, 'Aeronave');
  assert.match(choice.detail, /^Cheio: [\d,]+ t · limite: 0 kg · /, 'with no thruster it lifts nothing');
  // Made one, it takes no gear of its own, its skids as large as its wheels were and with no armour, and it stands over
  // them as high as their legs let it, or higher.
  const aircraft = withConstructionKind({ ...scout, chassis: { ...scout.chassis, gearScale: 1.1, armorMm: 10 } }, 'aircraft');
  assert.deepEqual(['axles', 'track', 'skids', 'armorMm'].filter(key => Object.hasOwn(aircraft.chassis, key)), []);
  assert.equal(aircraft.chassis.gearScale, 1.1);
  const compiled = compileDraftConstruction(aircraft), frame = compiled.plates.find(plate => plate.id === 'chassis:frame-0');
  assert.deepEqual(compiled.plates.filter(plate => /^chassis:(skid|leg)-/.test(plate.id)).map(plate => plate.id), ['chassis:skid-0', 'chassis:leg-0', 'chassis:leg-1']);
  assert.equal(compiled.modules.some(module => module.kind === 'wheel' || module.kind === 'track'), false);
  const settings = pieceSettings({ chassis: compiled.chassis }, aircraft.chassis);
  assert.deepEqual(settings.map(setting => setting.key), ['frameThicknessMm', 'gearScale', 'suspension', ...(aircraft.chassis.topPlate ? ['topPlateThicknessMm'] : [])]);
  const skids = settings.find(setting => setting.key === 'suspension'), range = skidRange(aircraft.chassis);
  // A metre and a half higher at the most, as the bar tells it in centimetres.
  assert.deepEqual([skids.label, skids.max, range.max], ['Altura dos esquis', 150, SKID_RISE]);
  assert(range.min < 0 && frame.chassis.skids.legs.every(leg => leg.top - leg.foot >= SKID_LEG - 1e-9), JSON.stringify(frame.chassis.skids));
  // A thruster on wheels lifts nothing: the Oficina says so, and it is not built.
  assert.equal(flightRow(wheeled(PAIR)).detail, 'Propulsor só numa aeronave: mude o tipo da construção para Aeronave.');
  assert.equal(compileManufacture(wheeled(PAIR), {}, true).compiled.admissionIssues.find(issue => issue.code === 'THRUSTER_CHASSIS')?.ids.join(), 'lift0,lift1');
  assert.equal(compileManufacture(flier(PAIR), {}, true).compiled.admissionIssues.some(issue => issue.code === 'THRUSTER_CHASSIS'), false);
  assert.match(projectRefusalMessage({ reason: 'THRUSTER_CHASSIS', ids: ['lift0'] }, wheeled(PAIR)), /só vai numa aeronave/);
  assert.match(constructionEditMessage({ code: 'AIRCRAFT_CLEARANCE', ids: ['gun'], gun: true }), /^A arma bateria nos esquis ao girar/);
  assert.match(constructionEditMessage({ code: 'AIRCRAFT_CLEARANCE', ids: ['hull:fin'], gun: false }), /^A peça destacada ficaria tão baixa quanto os esquis/);
});

test('a thruster is put in of titanium, pushes with its size and turns in steps of 45°', () => {
  assert.equal(structuredComponent('thruster').metal, 'titanium');
  assert.equal(Object.hasOwn(structuredComponent('engine'), 'metal'), false, 'a piece of steel says none');
  const compiled = compileStructuredConstruction(flier(PAIR)), piece = compiled.modules.find(m => m.id === 'lift0'),
    part = flier(PAIR).components.find(m => m.id === 'lift0');
  // The RB162 the thruster is drawn on pushes with 23.35 kN; one and a half times its size, as deep across the body, with
  // the square of that.
  assert(Math.abs(piece.thrustN - 23350 * 1.5 ** 2) < 1, piece.thrustN);
  const angle = pieceSettings(piece, part).find(setting => setting.key === 'angle');
  assert.deepEqual([angle.step, angle.fine], [45, 45]);
  assert.deepEqual([turnStep(piece), turnsFree(piece), turnMagnets(compiled.plates, piece)], [Math.PI / 4, false, []]);
  const pointed = degrees => turnedHeading({ x: 0, y: 0 }, 0, { x: Math.cos(degrees * Math.PI / 180), y: Math.sin(degrees * Math.PI / 180) }, [], false, turnStep(piece));
  assert.deepEqual([pointed(20), pointed(30), pointed(100)].map(heading => Math.round(heading * 180 / Math.PI)), [0, 45, 90]);
  // A design that flies with no gun nor tool is named for its thrusters, though it has no engine to drive with.
  assert.equal(designation({ preset: 'vehicle', modules: [{ kind: 'command' }, { kind: 'fuel' }, { kind: 'thruster' }] }), 'Aeronave');
  assert.equal(designation({ preset: 'vehicle', modules: [{ kind: 'command' }, { kind: 'fuel' }] }), 'Chassi');
});

test('W and S take a vehicle that flies up and down and A and D along the field; on a phone, its stick', () => {
  const keys = (...held) => ({ driveKeys: new Set(held) });
  // On the ground S brakes, as ever.
  assert.deepEqual(driveIntent(keys('s')), { left: false, right: false, brake: 1, throttle: 0 });
  assert.deepEqual(driveIntent(keys('a'), false), { left: true, right: false, brake: 0, throttle: -1 });
  assert.deepEqual(driveIntent(keys('w'), true), { left: false, right: false, brake: 0, throttle: 0, rise: 1 });
  assert.deepEqual(driveIntent(keys('s', 'd'), true), { left: false, right: true, brake: 0, throttle: 1, rise: -1 });
  assert.deepEqual(driveIntent(keys('w', 's', 'a', 'd'), true).rise, 0);
  assert.deepEqual(driveIntent(keys(), true), { left: false, right: false, brake: 0, throttle: 0, rise: 0 }, 'with nothing asked it hovers');
  assert.deepEqual(driveIntent({ driveKeys: new Set(['w']), stick: { x: .5, y: -.3 } }, true), { left: false, right: false, brake: 0, throttle: .5, rise: -.3 });
  assert.deepEqual([flies({ vehicle: { thrustN: 23350 } }), flies({ vehicle: { thrustN: 0 } }), flies(null)], [true, false, false]);
  assert.match(trialHint({ kind: 'drive', flies: true }), /W\/S sobem e descem e A\/D vão para os lados/);
  assert.match(trialHint({ kind: 'drive', flies: true, touch: true }), /o controle à esquerda pilota/);
  // The stick asks in tenths, nothing near its middle, and no more than its rim however far the finger goes.
  assert.deepEqual(stickAt(STICK_STILL / 2, -STICK_STILL / 2), { x: 0, y: 0, knob: { x: STICK_STILL / 2, y: -STICK_STILL / 2 } });
  assert.deepEqual([stickAt(.43, -.68).x, stickAt(.43, -.68).y], [.4, -.7]);
  const rim = stickAt(3, 4);
  assert.deepEqual([rim.x, rim.y], [.6, .8]); assert(Math.abs(Math.hypot(rim.knob.x, rim.knob.y) - 1) < 1e-12);
});

test('a vehicle that flies, sent to a point of the sky as high as it is, goes there at that height over the ground and hovers over it', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x);
  f.order(alice, 'control', { id }); run(.5);
  const landed = height();
  assert.equal(vehicle().flying, false, 'published, it stands on its skids');
  // Taken up by hand, then let be to hover.
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 1 }); run(2.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 }); run(4);
  const kept = height();
  assert(vehicle().flying && kept > landed + 10, `${landed} → ${kept}`);
  f.order(alice, 'control', { id: null });
  const from = vehicle().x, goal = from + 160 * Math.sign(400 - from);
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) + kept });
  let lowest = Infinity, highest = -Infinity;
  const arrived = until(() => { lowest = Math.min(lowest, height()); highest = Math.max(highest, height()); return !squad.units.get(id).move; }, 60);
  assert(arrived, `still ${Math.abs(vehicle().x - goal).toFixed(1)} m away`);
  assert(Math.abs(vehicle().x - goal) < 2, `${vehicle().x} for ${goal}`);
  // Leant hard one way to go and the other to stop, it is pushed up a few metres as it is turned over.
  assert(lowest > kept - 3 && highest < kept + 5, `between ${lowest.toFixed(1)} and ${highest.toFixed(1)} m for ${kept.toFixed(1)} m`);
  // There it hovers, its order done.
  run(3);
  assert(vehicle().flying && Math.abs(vehicle().vx) < .3 && Math.abs(height() - kept) < 3);
});

test('a vehicle that flies sent from the ground to a place of the ground takes off, flies no lower than its floor over the ground and comes down there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x);
  f.order(alice, 'control', { id: null }); run(.5);
  const goal = vehicle().x + 80 * Math.sign(400 - vehicle().x);
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) });
  const place = squad.units.get(id).move.x;
  assert.deepEqual(squad.view().units.find(u => u.id === id).move, { x: place, land: 'order' }, 'it is sent to land, the page is told');
  run(4);
  assert(vehicle().flying, 'it took off');
  // Up at its floor, it holds it all the way, and comes down only over the place.
  let up = false, lowest = Infinity;
  assert(until(() => {
    if (height() > 5.5) up = true;
    if (up && Math.abs(vehicle().x - place) > 6) lowest = Math.min(lowest, height());
    return !squad.units.get(id).move;
  }, 60), `still ${Math.abs(vehicle().x - place).toFixed(1)} m away`);
  assert(up && lowest > 5, `no lower than ${lowest.toFixed(1)} m over the ground on its way`);
  assert(!vehicle().flying && Math.abs(vehicle().x - place) < 2, `down at ${vehicle().x.toFixed(1)} for ${place.toFixed(1)}`);
});

test('an aircraft sent to land some way off is slowed over the place before it falls there, and comes down on it', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle;
  f.order(alice, 'control', { id: null }); run(1);
  f.order(alice, 'move', { ids: [id], x: vehicle().x, y: ground.height(vehicle().x) + 120 });
  assert(until(() => !squad.units.get(id).move, 90), 'it hovers 120 m up');
  const goal = vehicle().x + 40 * Math.sign(400 - vehicle().x);
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) });
  const place = squad.units.get(id).move.x;
  // Steered over it as it starts down, it falls with its thrusters idling only once it is all but still there, leant
  // as it hovers, and drifts by next to nothing on its way down: it is set down on the place, not past it.
  let falling = null, drift = 0;
  assert(until(() => {
    const leg = squad.units.get(id).move;
    if (leg?.straight && falling === null) falling = { vx: vehicle().vx, x: vehicle().x, lean: vehicle().angle };
    if (falling) drift = Math.max(drift, Math.abs(vehicle().vx));
    return !vehicle().flying;
  }, 60), 'it is down');
  assert(falling && Math.abs(falling.vx) <= .25 && Math.abs(falling.lean) < .1, `it fell going ${falling?.vx.toFixed(2)} m/s, leant ${falling?.lean.toFixed(3)} rad`);
  assert(drift < .3, `drifting at ${drift.toFixed(2)} m/s at the most on its way down`);
  assert(Math.abs(vehicle().x - place) < .6, `down ${Math.abs(vehicle().x - place).toFixed(2)} m from the place`);
});

// What a thruster burns, in kilograms for each newton it pushes with for an hour, and at the least as it idles, as a share of
// its thrust (game_hover.rs `SPECIFIC_FUEL`, `IDLE_SHARE`); and what a litre of the fuel weighs (game_motion.rs).
const SPECIFIC_FUEL = .108, IDLE_SHARE = .05, FUEL_KG_PER_LITRE = .835;
test('flown along the field flat out by its player, with no climb asked, an aircraft keeps its height and goes faster and faster', { timeout: 120000 }, t => {
  // Either way: leant only as far as its thrusters, each as it points leant so, still hold it up — of the two leant out
  // 45°, leant towards one it points nearly up, and the other nearly along the field —, and pushed along by the rest of
  // what they push it with. Its height is where it is in the field: the ground under it rises and falls as it goes.
  for (const ahead of [false, true]) {
    const f = onField(t, rehearsal([-100, 400])), { room, world, run } = f, alice = room.join('Alice'), id = f.publish(alice, built()),
      vehicle = () => world.actor(id).vehicle, height = () => vehicle().center.y;
    f.order(alice, 'control', { id }); run(.5);
    f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 1 }); run(2.5);
    f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 }); run(4);
    const way = (ahead ? 1 : -1) * world.actor(id).facing, from = height(), speeds = [];
    f.send(alice, 'drive', { throttle: way, brake: 0, rise: 0 });
    let lowest = from;
    for (let i = 1; i <= 4 * 60; i++) {
      room.step();
      lowest = Math.min(lowest, height());
      if (i % 60 === 0) speeds.push(vehicle().vx * way);
    }
    assert(from - lowest < .3, `${ahead ? 'front' : 'tail'} first, ${from.toFixed(2)} m up, ${lowest.toFixed(2)} m at the lowest`);
    assert(speeds.every((speed, i) => speed > (i ? speeds[i - 1] : 0) + 1), `${ahead ? 'front' : 'tail'} first, ${speeds.map(v => v.toFixed(1)).join(', ')} m/s`);
  }
});

test('the engine of an aircraft, there for its tools, turns nothing in the air and burns nothing there: its keys ask its flight computer', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    litres = () => f.parts(id, 'fuel').reduce((sum, tank) => sum + tank.fuelLitres, 0);
  f.order(alice, 'control', { id: null }); run(.5);
  assert(vehicle().drivetrain.powerKw > 90, 'it has its engine');
  const goal = vehicle().x + 160 * Math.sign(400 - vehicle().x);
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) + 20 });
  let flown = 0, along = 0;
  for (let step = 0; step < 60 * 60 && squad.units.get(id).move; step++) {
    const before = litres(), v = vehicle(), local = v.localCenter ?? { x: 0, y: 0 },
      breathes = thrustShare(v.y + Math.sin(v.angle || 0) * local.x + Math.cos(v.angle || 0) * local.y);
    room.step();
    if (!vehicle().flying) continue;
    // All it burnt in the step its thrusters burnt, each at the share of its thrust it pushed with, or idling, of all they
    // push with in the air they breathe where its centre of mass was (atmosphere.ts).
    const jets = f.parts(id, 'thruster').reduce((sum, m) => sum + SPECIFIC_FUEL * Math.max(m.thrust, IDLE_SHARE) * m.thrustN * breathes / FUEL_KG_PER_LITRE, 0) / 3600 / 60;
    assert(Math.abs(before - litres() - jets) < 1e-9 + 1e-6 * jets, `${before - litres()} L for ${jets} L of its thrusters`);
    assert(vehicle().driveSpeed === 0, 'its drivetrain is asked for no speed');
    flown++; if (vehicle().throttle) along++;
  }
  assert(!squad.units.get(id).move && flown > 5 * 60 && along > 3 * 60, `${flown / 60} s in the air, ${along / 60} s asked along the field`);
});

test('a machine gun hung under an aircraft fires from the air at the ground under it, between its skids', { timeout: 120000 }, t => {
  const made = compileManufacture(gunship(), {}, true).compiled;
  assert.deepEqual(made.admissionIssues, [], 'it is built');
  assert.equal(made.modules.find(m => m.id === 'gun').weaponMount.hostId, 'chassis:rail-0', 'hung from the rail over it');
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run } = f, alice = room.join('Alice'),
    id = f.publish(alice, gunship()), vehicle = () => world.actor(id).vehicle, gun = f.parts(id, 'weapon')[0];
  f.order(alice, 'control', { id }); run(.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 1 }); run(1.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 }); run(4);
  assert(vehicle().flying && vehicle().y - ground.height(vehicle().x) > 10, 'it hovers');
  // A point of the ground ahead of it and under it, the way it faces.
  const x = vehicle().x + 14 * world.actor(id).facing, aim = { x, y: ground.height(x) }, weapon = { id: 'machinegun', componentId: gun.id };
  f.send(alice, 'aim', { aim, weapon }); run(1.5);
  f.send(alice, 'trigger', { active: true, aim, weapon });
  const told = [];
  for (let i = 0; i < 90; i++) { const from = world.events.length; room.step(); told.push(...world.events.slice(from)); }
  f.send(alice, 'trigger', { active: false });
  // Every round it fired came down on the ground at the point, none on its skids.
  const fired = told.filter(e => e.type === 'muzzle').length, struck = told.filter(e => e.type === 'ground');
  assert(fired > 5 && struck.length === fired, `${fired} fired, ${struck.length} on the ground`);
  assert(struck.every(e => Math.abs(e.x - x) < 2), `struck at ${struck.map(e => e.x.toFixed(1))} for ${x.toFixed(1)}`);
  // Nothing of its own was struck: no plate of it holed or marked, its skids whole.
  const own = world.snapshot().plates.filter(plate => plate.actorId === id);
  assert(own.length && own.every(plate => !plate.perforations?.length && !plate.marks?.length), 'its own plates are untouched');
});

test('the Oficina tells an aircraft how long its tank keeps it hovering full', () => {
  const made = compileDraftConstruction(built()), tank = made.modules.find(m => m.kind === 'fuel').capacityLitres, burns = made.flight.hoverLitres;
  assert(burns > 0 && tank / burns > 60 && tank / burns < 300, `${tank} L at ${burns} L/s`);
  assert.deepEqual([flightTime(95.4), flightTime(42), flightTime(120)], ['1 min 35 s', '42 s', '2 min 00 s']);
});

test('an aircraft sent to a point of the sky flies there at that height over the ground; one clicked under the ground comes down there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x), toward = Math.sign(400 - vehicle().x);
  f.order(alice, 'control', { id: null }); run(.5);
  const goal = vehicle().x + 120 * toward;
  // The field reads the point a page sends (`asked`).
  assert.deepEqual(asked({ type: 'squad', order: 'move', ids: [id], x: goal, y: 40, pad: 1 }), { type: 'squad', order: 'move', ids: [id], x: goal, y: 40 });
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) + 40 });
  assert.equal(squad.view().units.find(u => u.id === id).move.height, 40, 'the page is told the height');
  assert(until(() => !squad.units.get(id).move, 60), `still ${Math.abs(vehicle().x - goal).toFixed(1)} m away`);
  assert(Math.abs(vehicle().x - goal) < 2 && Math.abs(height() - 40) < 2, `${vehicle().x.toFixed(1)} for ${goal}, ${height().toFixed(1)} m over the ground`);
  // Under the ground, or no higher over it than it is flown at the least, a point is the ground there: it comes down there.
  const next = goal + 60 * toward;
  f.order(alice, 'move', { ids: [id], x: next, y: ground.height(next) - 5 });
  const place = squad.units.get(id).move.x;
  assert.deepEqual(squad.view().units.find(u => u.id === id).move, { x: place, land: 'order' });
  assert(until(() => !squad.units.get(id).move, 60));
  assert(!vehicle().flying && Math.abs(vehicle().x - place) < 2, `down at ${vehicle().x.toFixed(1)} for ${place.toFixed(1)}`);
  assert.throws(() => f.order(alice, 'move', { ids: [id], x: next, y: 1e6 }), /fora do campo/);
});

test('an aircraft sent to a point of the sky right over it, or all but, climbs or comes down to it before its order ends', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x);
  f.order(alice, 'control', { id: null }); run(1);
  // From its skids straight up 300 m, then a metre aside — within the reach of the place it takes as there — down to 120 m.
  for (const [aside, up] of [[0, 300], [1, 120]]) {
    const x = vehicle().x + aside;
    f.order(alice, 'move', { ids: [id], x, y: ground.height(x) + up });
    assert(squad.units.get(id).move, 'it is on its way');
    assert(until(() => !squad.units.get(id).move, 90), `still ${height().toFixed(0)} m over the ground for ${up} m`);
    assert(vehicle().flying && Math.abs(height() - up) < 2 && Math.abs(vehicle().x - x) < 2, `${height().toFixed(1)} m over the ground for ${up} m`);
  }
});

test('an aircraft on its skids sent to a point of the sky high up and far off climbs and goes along at once, leant towards it, and gets there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x);
  f.send(alice, 'homing', { actorId: id, on: false });
  f.order(alice, 'control', { id: null }); run(1);
  // 1.2 km off and 1 km up: once over its floor, it goes along as it climbs — some of the way along by halfway up, where
  // straight up it would be where it took off —, never held up for getting no nearer along the field as it climbs.
  const from = vehicle().x, goal = from - 1200;
  f.order(alice, 'move', { ids: [id], x: goal, y: ground.height(goal) + 1000 });
  let seconds = 0, halfway = null;
  while (squad.units.get(id).move && seconds < 120) {
    room.step(); seconds += 1 / 60;
    if (halfway === null && height() > 500) halfway = (from - vehicle().x) / 1200;
  }
  assert.notEqual(squad.units.get(id).reason, 'blocked-way', 'its way is not taken for shut');
  assert(!squad.units.get(id).move && vehicle().flying && Math.abs(vehicle().x - goal) < 2 && Math.abs(height() - 1000) < 2,
    `in ${seconds.toFixed(0)} s at ${(from - vehicle().x).toFixed(0)} m along, ${height().toFixed(0)} m up`);
  assert(halfway > .05 && seconds < 60, `${(100 * halfway).toFixed(0)} % of the way along halfway up, there in ${seconds.toFixed(0)} s`);
});

test('an aircraft high up sent down to land falls with its thrusters idling, is slowed at the last to touch at a walk, as its pilot reckons it', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x), litres = () => f.parts(id, 'fuel').reduce((sum, tank) => sum + tank.fuelLitres, 0);
  f.order(alice, 'control', { id: null }); run(1);
  const rest = height();
  f.order(alice, 'move', { ids: [id], x: vehicle().x, y: ground.height(vehicle().x) + 300 });
  assert(until(() => !squad.units.get(id).move, 90), 'it hovers 300 m up');
  run(2);
  f.parts(id, 'fuel').forEach(tank => f.set(tank, { fuelLitres: tank.capacityLitres }));
  const from = height() - rest, before = litres(), reckoned = descentCost(world.actor(id).blueprint, vehicle().mass, from, ground.height(vehicle().x));
  f.order(alice, 'move', { ids: [id], x: vehicle().x });
  let seconds = 0, idling = 0, climbed = -Infinity, touched = null, falling = 0;
  while (vehicle().flying && seconds < 60) {
    room.step(); seconds += 1 / 60;
    if (f.parts(id, 'thruster').every(m => m.thrust <= .05)) idling += 1 / 60;
    climbed = Math.max(climbed, vehicle().vy);
    if (touched === null && height() - rest < .01) touched = falling;
    falling = vehicle().vy;
  }
  const burnt = before - litres();
  assert(!vehicle().flying && until(() => !squad.units.get(id).move, 1), 'it stands on its skids, its order done');
  assert(idling > seconds / 3 && climbed < .05, `${idling.toFixed(1)} s of ${seconds.toFixed(1)} s idling, climbing back at ${climbed.toFixed(2)} m/s at the most`);
  assert(touched > -1, `it touched at ${touched?.toFixed(2)} m/s`);
  // Down 300 m in some fifteen seconds, on a few tens of litres: hovering down at 3 m/s would take a hundred and burn more
  // than three times as much. Its pilot reckons it so, to the side of more.
  assert(seconds < 25, `${seconds.toFixed(1)} s`);
  assert(reckoned.seconds > seconds && reckoned.seconds < 1.4 * seconds && reckoned.litres > burnt && reckoned.litres < 1.4 * burnt,
    `${seconds.toFixed(1)} s and ${burnt.toFixed(1)} L, reckoned ${reckoned.seconds.toFixed(1)} s and ${reckoned.litres.toFixed(1)} L`);
});

test('sent home, or short of fuel, an aircraft comes down at its base on its skids and is filled up there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    base = (faction => room.depot(faction, faction.base.x))(room.faction(room.players.get(alice.playerId))), toward = Math.sign(400 - vehicle().x),
    tank = f.parts(id, 'fuel')[0], full = tank.fuelLitres, litres = () => f.parts(id, 'fuel')[0].fuelLitres, home = () => Math.abs(vehicle().x - base.x) < base.radius;
  f.order(alice, 'control', { id: null }); run(.5);
  const away = base.x + toward * (base.radius + 150);
  f.order(alice, 'move', { ids: [id], x: away, y: ground.height(away) + 30 });
  assert(until(() => !squad.units.get(id).move, 60) && vehicle().flying && !home());
  // Base: it flies home and comes down there; standing on its skids, it is filled up.
  f.order(alice, 'home', { ids: [id] });
  assert.equal(squad.view().units.find(u => u.id === id).move.land, 'order');
  assert(until(() => !vehicle().flying, 60), 'it landed');
  const burnt = litres();
  assert(home(), `at ${vehicle().x.toFixed(1)}, the base at ${base.x} ± ${base.radius}`);
  assert(until(() => !squad.units.get(id).move, 1), 'its order is done');
  assert(burnt < full - 5 && until(() => litres() > burnt + 5, 30), `${burnt.toFixed(1)} L of ${full.toFixed(1)} L, filled up to ${litres().toFixed(1)} L`);
  // Off again, with a litre less fuel than takes it home with its reserve to spare (squad.ts `homeFuel`, `reserve`), it turns
  // back to land by itself, and comes down there with that reserve.
  until(() => litres() >= full - .1 && !room.record(world.actor(id)).service, 120);
  f.order(alice, 'move', { ids: [id], x: away, y: ground.height(away) + 30 });
  assert(until(() => !squad.units.get(id).move, 60) && vehicle().flying);
  f.set(f.parts(id, 'fuel')[0], { fuelLitres: squad.homeFuel(id, squad.units.get(id).burn) + squad.reserve(id) - 1 });
  assert(until(() => squad.units.get(id).move?.land === 'fuel', 5), 'it turns back for its fuel');
  assert(until(() => !vehicle().flying, 60) && home(), `down at ${vehicle().x.toFixed(1)} with ${litres().toFixed(1)} L`);
  assert(litres() >= squad.reserve(id) - 1, `with ${litres().toFixed(1)} L, its reserve ${squad.reserve(id).toFixed(1)} L`);
});

test('a long aircraft sent home fast over ground that rises to its base is slowed in time, and comes down there without swinging past it', { timeout: 120000 }, t => {
  // The builder, 11 m long, out 300 m at 12 m over the ground and home over ground that rises some 4 m to its base: flown
  // high enough for it to be leant back as far as it slows down at over that ground, it is slowed to its base and down
  // there in some five seconds from when it is within 10 m of it — flown at its floor, its flight computer leant it little
  // there, and it swung 25 m past and took ten, climbing back.
  const f = onField(t, rehearsal([-213, 30000], bill(1e9, 1e9, 1e9, 1e9), { fog: false })), { room, world, ground, until } = f,
    alice = room.join('Alice'), id = f.publish(alice, airBuilder()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    height = () => vehicle().y - ground.height(vehicle().x);
  f.send(alice, 'homing', { actorId: id, on: false });
  room.supplyDispatch.set(id, false);
  const out = vehicle().x + 300;
  f.order(alice, 'move', { ids: [id], x: out, y: ground.height(out) + 12 });
  assert(until(() => !squad.units.get(id).move, 120), 'it hovers 300 m out');
  f.order(alice, 'home', { ids: [id] });
  const place = squad.units.get(id).move.x;
  let near = null, lowest = Infinity, back = 0, past = 0, seconds = 0;
  while ((vehicle().flying || seconds === 0) && seconds < 120) {
    room.step(); seconds += 1 / 60;
    past = Math.max(past, (vehicle().x - place) * Math.sign(place - out));
    if (near === null && Math.abs(vehicle().x - place) <= 10) near = seconds;
    if (near !== null) { lowest = Math.min(lowest, height()); back = Math.max(back, height() - lowest); }
  }
  assert(!vehicle().flying && near !== null, 'it came down at its base');
  assert(seconds - near < 7 && back < .05 && past < 10, `${(seconds - near).toFixed(1)} s from 10 m off, ${past.toFixed(1)} m past, climbing back ${back.toFixed(2)} m`);
});

test('sent by Mover to a place of the ground, aircraft come down about it side by side, and a vehicle sent with them drives there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    base = (faction => room.depot(faction, faction.base.x))(room.faction(room.players.get(alice.playerId))), toward = Math.sign(400 - base.x),
    fliers = [-12, 12].map(dx => f.publish(alice, built(), { x: base.x + dx })), truck = f.publish(alice, 'recon', { x: base.x - toward * 40 }),
    squad = room.players.get(alice.playerId).squad, vehicle = id => world.actor(id).vehicle, ids = [...fliers, truck];
  f.order(alice, 'control', { id: null }); run(.5);
  const there = base.x + toward * (base.radius + 120);
  f.order(alice, 'move', { ids, x: there, y: ground.height(there) });
  const told = new Map(squad.view().units.map(u => [u.id, u.move]));
  // The vehicle that drives goes to the place as ever; those that fly are sent to land, each clear of the others.
  assert.deepEqual(told.get(truck), { x: told.get(truck).x }); assert(Math.abs(told.get(truck).x - there) < 1e-9, `${told.get(truck).x} for ${there}`);
  assert(fliers.every(id => told.get(id).land === 'order'), JSON.stringify([...told]));
  const line = ids.map(id => ({ x: told.get(id).x, room: squad.room(id) })).sort((a, b) => a.x - b.x);
  assert(line.slice(1).every((b, i) => b.x - line[i].x >= (b.room + line[i].room) / 2 + GAP - 1e-6), `end to end: ${line.map(p => p.x.toFixed(1))}`);
  assert(fliers.every(id => Math.abs(told.get(id).x - there) < 40), 'beside the place');
  assert(until(() => ids.every(id => !squad.units.get(id).move), 60), 'all of them got there');
  for (const id of fliers) assert(!vehicle(id).flying && Math.abs(vehicle(id).x - told.get(id).x) < 2, `${id} down at ${vehicle(id).x.toFixed(1)} for ${told.get(id).x.toFixed(1)}`);
  assert(Math.abs(vehicle(truck).x - there) < 3, `the vehicle stopped at ${vehicle(truck).x.toFixed(1)} for ${there}`);
  assert(fliers.every(id => Math.abs(vehicle(id).x - base.x) > base.radius), 'not at the base');
  assert.throws(() => f.order(alice, 'land', { ids: fliers }), /Ordem desconhecida/);
});

// Where an aircraft sent to land at a place comes down: there on level ground, the nearest level place to it on a slope
// steeper than about 14° under its length, and beside another of the side that stands there. Read alone, on a field of none.
test('an aircraft lands on the level ground nearest the place clicked, clear of the side', () => {
  const others = [], world = { terrain: { minX: -1000, maxX: 1000, height: x => x > 20 && x < 60 ? (x - 20) * .5 : x >= 60 ? 20 : 0 },
      actor: id => ({ vehicle: { x: others.find(o => o.id === id)?.x ?? 0 } }) },
    squad = Object.assign(Object.create(Squad.prototype), { side: { world, roster: others, defeats: {} }, units: new Map() });
  squad.room = () => 8; squad.position = id => others.find(o => o.id === id)?.x ?? 0;
  assert.equal(squad.landing('a', 0, new Set(['a'])), 0);
  // Half a metre to the metre from 20 m to 60 m: it comes down at the foot of the slope or at its top, the nearer, where
  // the ground under its 8 m rises no more than 2 m.
  assert.equal(squad.landing('a', 30, new Set(['a'])), 20);
  assert.equal(squad.landing('a', 50, new Set(['a'])), 60);
  // A vehicle of the side at 0: beside it, its length and the other's apart, and the gap.
  others.push({ id: 'b', team: 'player', x: 0 });
  assert.equal(Math.abs(squad.landing('a', 0, new Set(['a']))), 11);
});

// A place of the sky is held by those flown at about its height, not by what stands on the ground under it: an aircraft
// sent over a vehicle of the side parked there goes right there, and keeps apart from another flown at its height.
test('an aircraft sent to a point of the sky keeps apart from those at its height, not from those on the ground under it', () => {
  const others = [], ground = () => 0, world = { terrain: { minX: -1000, maxX: 1000, height: ground },
      actor: id => { const o = others.find(o => o.id === id); return { vehicle: { x: o?.x ?? 0, y: o?.y ?? 0, flying: (o?.y ?? 0) > 0 } }; } },
    squad = Object.assign(Object.create(Squad.prototype), { side: { world, roster: others, defeats: {} }, units: new Map() });
  squad.room = () => 8; squad.position = id => others.find(o => o.id === id)?.x ?? 0;
  others.push({ id: 'parked', team: 'player', x: 0, y: 0 });
  assert.equal(squad.clear('a', 0, -500, 500, new Set(['a']), false, 40), 0, 'over the vehicle on the ground');
  assert.equal(Math.abs(squad.clear('a', 0, -500, 500, new Set(['a']))), 11, 'on the ground, beside it');
  // Another in the air at 38 m holds its place against one sent to 40 m; one at 60 m does not, nor against the ground.
  others.push({ id: 'high', team: 'player', x: 100, y: 60 }, { id: 'near', team: 'player', x: -100, y: 38 });
  assert.equal(squad.clear('a', 100, -500, 500, new Set(['a']), false, 40), 100);
  assert.equal(Math.abs(squad.clear('a', -100, -500, 500, new Set(['a']), false, 40) + 100), 11);
  assert.equal(squad.clear('a', 100, -500, 500, new Set(['a'])), 100);
  // Sent to land, an aircraft holds its place on the ground on its way down.
  squad.units.set('high', { move: { x: 100, land: 'order' } });
  assert.equal(Math.abs(squad.clear('a', 100, -500, 500, new Set(['a'])) - 100), 11);
});

test('a faction that leaves the field calls its aircraft down at its base', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    id = f.publish(alice, built()), squad = room.players.get(alice.playerId).squad, vehicle = () => world.actor(id).vehicle,
    base = (faction => room.depot(faction, faction.base.x))(room.faction(room.players.get(alice.playerId))), away = base.x + Math.sign(400 - base.x) * (base.radius + 100);
  f.order(alice, 'control', { id: null }); run(.5);
  f.order(alice, 'move', { ids: [id], x: away, y: ground.height(away) + 30 });
  assert(until(() => !squad.units.get(id).move, 60) && vehicle().flying);
  room.disconnect(alice.playerId);
  assert.equal(squad.units.get(id).move?.land, 'order');
  assert(until(() => !vehicle().flying, 60) && Math.abs(vehicle().x - base.x) < base.radius, `down at ${vehicle().x.toFixed(1)}`);
});

test('a field kept while a vehicle hovers resumes with it hovering where it was', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, run } = f, alice = room.join('Alice'), id = f.publish(alice, built());
  f.order(alice, 'control', { id }); run(.5);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 1 }); run(2);
  f.send(alice, 'drive', { throttle: 0, brake: 0, rise: 0 }); run(4);
  const { x, y } = world.actor(id).vehicle, kept = JSON.parse(JSON.stringify(room.keep()));
  const again = onField(t, rehearsal([-100, 400], undefined, { kept })), vehicle = () => again.world.actor(id).vehicle;
  assert(vehicle().flying, 'it flies as it was kept');
  again.run(3);
  assert(vehicle().flying && Math.hypot(vehicle().x - x, vehicle().y - y) < .5, `${vehicle().x}, ${vehicle().y} for ${x}, ${y}`);
});

// The field keeps the way home of each as it keeps any other: an aircraft on its way down at its base, sent there or for its
// fuel, and a vehicle that drives there go on with it when the field is taken up again.
test('a field kept while an aircraft and a vehicle go home resumes with both on their way there', { timeout: 120000 }, t => {
  const f = onField(t, rehearsal([-100, 400])), { room, world, ground, run, until } = f, alice = room.join('Alice'),
    base = (faction => room.depot(faction, faction.base.x))(room.faction(room.players.get(alice.playerId))), toward = Math.sign(400 - base.x),
    id = f.publish(alice, built()), spare = f.publish(alice, built(), { x: base.x + 20 }), truck = f.publish(alice, 'recon'), squad = room.players.get(alice.playerId).squad;
  f.order(alice, 'control', { id: null }); run(.5);
  const away = base.x + toward * (base.radius + 150);
  f.order(alice, 'move', { ids: [id, spare], x: away, y: ground.height(away) + 30 });
  assert(until(() => !squad.units.get(id).move && !squad.units.get(spare).move, 60));
  f.put(truck, away);
  f.order(alice, 'home', { ids: [id, truck] });
  f.set(f.parts(spare, 'fuel')[0], { fuelLitres: 40 });
  assert(until(() => squad.units.get(spare).move?.land === 'fuel', 5), 'it turns back for its fuel');
  run(1);
  const kept = JSON.parse(JSON.stringify(room.keep())), again = onField(t, rehearsal([-100, 400], undefined, { kept })),
    resumed = again.room.players.get(alice.playerId).squad, home = x => Math.abs(x - base.x) <= base.radius;
  assert.deepEqual([id, spare, truck].map(one => resumed.view().units.find(u => u.id === one).move),
    [squad.view().units.find(u => u.id === id).move, squad.view().units.find(u => u.id === spare).move, squad.view().units.find(u => u.id === truck).move]);
  assert.deepEqual([resumed.units.get(id).move.land, resumed.units.get(spare).move.land, resumed.units.get(truck).move.purpose], ['order', 'fuel', 'home']);
  assert(again.until(() => [id, spare, truck].every(one => !resumed.units.get(one).move), 60), 'all three got home');
  for (const one of [id, spare]) assert(!again.world.actor(one).vehicle.flying && home(again.world.actor(one).vehicle.x), `${one} down at ${again.world.actor(one).vehicle.x.toFixed(1)}`);
  assert(home(again.world.actor(truck).vehicle.x), `the vehicle stopped at ${again.world.actor(truck).vehicle.x.toFixed(1)}`);
});

test('a free teammate aircraft keeps its fuel refusal before an order changes its keeper', t => {
  const f = onField(t, rehearsal([0, 20000])), { room, world, ground } = f,
    alice = room.join('Alice'), bob = room.join('Bob'), owner = room.players.get(alice.playerId), next = room.players.get(bob.playerId);
  f.send(alice, 'invite', { playerId: bob.playerId });
  f.send(bob, 'join-faction', { factionId: room.faction(owner).id });
  const id = f.publish(alice, built()), actor = world.actor(id), x = actor.vehicle.x + 5000,
    order = { ids: [id], x, y: ground.height(x) + 30 };
  assert.equal(world.tick, 0, 'the first order is checked before the first physics step');
  assert(actor.vehicle.thrustN > 0, 'Native admission already identifies the aircraft');
  assert(owner.squad.units.has(id), 'publishing prepares the original keeper squad');
  assert.throws(() => f.order(alice, 'move', order), /Sem combustível para ir e voltar à base/);
  f.order(alice, 'free', { ids: [id] });
  assert.equal(room.holding(actor), null);
  assert.equal(next.squad.units.has(id), false, 'an ally aircraft is outside the requesting squad');
  const previousOwnerOrders = room.orders(owner), previousNextOrders = room.orders(next);
  assert.throws(() => f.order(bob, 'move', order), /Sem combustível para ir e voltar à base/,
    'taking an aircraft from another member cannot bypass its fuel check');
  assert.equal(actor.ownerId, owner.id, 'a refused order transfers no ownership');
  assert.equal(room.holding(actor), null, 'a refused order claims nothing');
  assert.equal(room.orders(owner), previousOwnerOrders);
  assert.equal(room.orders(next), previousNextOrders);
  const near = actor.vehicle.x + 50;
  f.order(bob, 'move', { ids: [id], x: near, y: ground.height(near) + 30 });
  assert.equal(actor.ownerId, next.id, 'an affordable order still transfers the free aircraft');
  assert.deepEqual([next.squad.units.get(id).move.height, next.squad.units.get(id).move.sky], [30, true]);
});
