import test from 'node:test';
import assert from 'node:assert/strict';

import { createArmourTrial } from '../src/armour-trial.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { pageWorld } from '../src/trial-targets.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { resolveArmament } from '../src/ui-model.ts';
import { snapshotCollisionIndex } from '../src/impact-preview.ts';
import { GRAVITY } from '../src/ballistics.ts';
import { MATERIALS, MODULES } from '../src/materials.ts';
import { Terrain } from '../src/terrain.ts';
import { plateCorners } from '../src/math.ts';

import { FramePresentation } from '../src/presentation.ts';
import { STRIKE_MARGIN, MUZZLE_CLEARANCE, STRIKE_WORDS, arrival, designBounds, designDistance, onDesign, strikeOrigin, strikeDirection, lineMeets,
  strikeAlong, levelStrike, strikeVerdict, strikeDetail } from '../src/armour-strike.ts';
import { SlowMotion, SLOW_PACE, FLIGHT_SECONDS, FLIGHT_PACE, SLOW_HOLD, SLOW_OUT, SLOW_CUT } from '../src/slow-motion.ts';

await initNativeDynamics();

const ground = new Terrain('flat');
const close = (actual, expected, tolerance = 1e-6, message = `${actual} != ${expected}`) => assert(Math.abs(actual - expected) <= tolerance, message);
const gun = (preset, ammo, more = {}) => resolveArmament({ preset, platform: 'ground', ammo, ...more }, []);
// The test of armour of the scout, as the simulation worker lays it out (`pageWorld`).
function trial(t) {
  const world = pageWorld(createStructuredTemplate('scout')); t.after(() => world.dispose());
  return { world, state: world.snapshot() };
}
// The test as a strike reads it (main.ts `strikeTest`).
const tested = (state, weapon, distance = 10) => ({ state, index: snapshotCollisionIndex(state), ground, hull: null, weapon, distance });
const centre = (state, id) => { const plate = state.plates.find(p => p.id === id).definition; return { x: plate.x, y: plate.y }; };
// A strike along the line drawn from `dx`, `dy` metres away from `point` toward it.
function drawn(state, point, [dx, dy], weapon, distance) {
  const from = { x: point.x + dx, y: point.y + dy }, strike = strikeAlong(tested(state, weapon, distance), from, strikeDirection(from, point));
  return { ...strike, ...strikeVerdict(strike.impact, strike), detail: strikeDetail(strike.impact, strike) };
}
// The round of a strike put in the air as the worker puts it (`strike`), flown for half a second.
function flown(world, round) {
  const game = world.game(), events = [];
  game.call({ op: 'projectile', projectile: game.projectile(round) });
  for (let step = 0; step < 30; step++) { const from = world.events.length; world.step(); events.push(...world.events.slice(from)); }
  return events;
}

test('a line drawn from anywhere goes on to the first thing it meets: the design, the ground, or the sky', t => {
  const { state } = trial(t), index = snapshotCollisionIndex(state), bounds = designBounds(state), front = centre(state, 'hull:front');
  const from = { x: front.x - 3, y: front.y + 1 }, toward = strikeDirection(from, front), met = lineMeets(index, ground, from, toward);
  assert.equal(met.ground, false); close(met.x, bounds.minX, .02); close(met.distance, Math.hypot(met.x - from.x, met.y - from.y), 1e-6);
  // Short of the design it meets the ground; up into the air, nothing.
  const high = { x: bounds.minX - 8, y: 3 }, soil = lineMeets(index, ground, high, strikeDirection(high, { x: bounds.minX - 5, y: 0 }));
  assert.equal(soil.ground, true); close(soil.x, bounds.minX - 5, 1e-6); close(soil.y, 0, 1e-9); close(soil.distance, 3 * Math.SQRT2, 1e-6);
  assert.equal(lineMeets(index, ground, high, strikeDirection(high, { x: bounds.minX - 9, y: 4 })), null);
  // Past the design on the far side the line still meets it first.
  assert.equal(lineMeets(index, ground, { x: bounds.maxX + 20, y: 1.5 }, { x: -1, y: 0 }).ground, false);
  // A line is drawn from no lower than a muzzle stands over the ground, and has no way while it has no length.
  assert.deepEqual(strikeOrigin({ x: 3, y: -2 }, ground), { x: 3, y: MUZZLE_CLEARANCE });
  assert.deepEqual(strikeOrigin({ x: 3, y: 5 }, ground), { x: 3, y: 5 });
  assert.equal(strikeDirection(front, front), null);
});

test('a round comes from where its line was drawn, along it, as fast as a round of the gun arrives from the distance of the test', t => {
  const { state } = trial(t), weapon = gun('rh120', 'apfsds'), front = centre(state, 'hull:front'), bounds = designBounds(state);
  // A round arrives slower from farther, and a hop before it arrives a little faster; the gun stands 10 m away at least.
  const near = arrival(weapon, 10), far = arrival(weapon, 2000), hop = arrival(weapon, 2000, 50);
  assert(near.speed <= near.muzzle && near.speed > near.muzzle * .99); assert(far.speed < near.speed * .95);
  assert(hop.start > far.speed && hop.start < near.muzzle); assert.deepEqual(arrival(weapon, 0), arrival(weapon, 10));
  // A mortar lobs its round on its high arc: it falls about as fast as it left, whatever line it is drawn along.
  const mortar = arrival(gun('m252', 'he'), 1000);
  assert(mortar.speed > mortar.muzzle * .6 && mortar.speed < mortar.muzzle);
  // Drawn 3 m to the left and 1 m above the plate, it is put in the air there, with gravity taken back for what it flies.
  const strike = drawn(state, front, [-3, 1], weapon, 10), { start, round, direction } = strike, from = { x: front.x - 3, y: front.y + 1 };
  close(start.x, from.x, 1e-9); assert(start.y < from.y && start.y > from.y - 1e-4);
  const time = strike.hop / strike.arrival.start;
  close(start.x + round.vx * time, from.x + direction.x * strike.hop, 1e-9);
  close(start.y + round.vy * time - GRAVITY * time * time / 2, from.y + direction.y * strike.hop, 1e-9);
  close(round.vx, direction.x * strike.arrival.start, 1e-9); close(round.vy - GRAVITY * time, direction.y * strike.arrival.start, 1e-9);
  // A kinetic round pierces less as it slows, as in the air; a shaped charge keeps what it pierces.
  close(round.power, weapon.power * (Math.hypot(round.vx, round.vy) / strike.arrival.muzzle) ** 2, 1e-9);
  assert(strike.power < round.power && round.power < weapon.power, 'it strikes with what is left of it there');
  assert(drawn(state, front, [-3, 1], weapon, 2000).power < strike.power, 'from farther it strikes with less');
  assert.deepEqual([round.actorId, round.weapon, round.ammo, round.age], ['local', weapon.id, 'apfsds', 0]);
  const charge = gun('rh120', 'heat'); assert.equal(drawn(state, front, [-3, 1], charge).power, charge.power);
  // A shell set to burst in the air is fuzed for where a line was drawn to: told no such place, as a click is, it bursts
  // on what it meets.
  const shell = drawn(state, front, [-3, 1], gun('rh120', 'he', { detonation: 'airburst' }));
  assert.deepEqual([shell.round.fuzeTime, shell.solution.reachable, shell.airburst, shell.verdict], [undefined, false, null, 'burst']);
  // Drawn from on the design, the round comes from clear of what it spans, back along the line.
  const inside = strikeAlong(tested(state, weapon), front, { x: 1, y: 0 });
  assert(inside.start.x < bounds.minX - STRIKE_MARGIN + 1e-6 && inside.start.x > bounds.minX - STRIKE_MARGIN - .05);
  assert.equal(inside.impact.owner.id, 'hull:front');
  // A slow round drawn low over the ground from far away is put in the air nearer, where gravity keeps it over the ground.
  const low = strikeOrigin({ x: bounds.minX - 100, y: -3 }, ground), lobbed = strikeAlong(tested(state, gun('m224', 'he')), low, strikeDirection(low, front));
  assert(lobbed.hop < 100 && lobbed.start.y > 0); assert.equal(lobbed.impact.owner.id, 'hull:front');
});

test('what the line tells before letting go is what the core does to the round: where it strikes, and whether it gets through', t => {
  const cases = [
    ['rh120', 'apfsds', 'hull:front', [-3, 1], 'through', 'penetration'],
    ['minimi', 'ap', 'hull:front', [-3, .3], 'stopped', 'blocked'],
    ['minimi', 'ap', 'hull:front', [-.3, 3], 'ricochet', 'ricochet'],
    ['m2hb', 'ap', 'hull:vision', [-3, .5], 'through', 'penetration'],
    ['rh120', 'he', 'hull:front', [-3, 1], 'burst', 'primary-contact'],
    ['mk44', 'apfsds', 'hull:rear', [3, 1], 'through', 'penetration'],
  ];
  for (const [preset, ammo, id, side, verdict, outcome] of cases) {
    const { world, state } = trial(t), told = drawn(state, centre(state, id), side, gun(preset, ammo)),
      contact = flown(world, told.round).find(event => event.primaryContact);
    assert.equal(told.verdict, verdict, `${preset} at ${id}`); assert.equal(contact.type, outcome, `${preset} at ${id}`);
    assert.equal(contact.id, told.impact.owner.id); assert.equal(contact.targetActorId, 'local');
    close(contact.x, told.impact.x, .02); close(contact.y, told.impact.y, .02);
  }
});

test('a line into the ground before the design strikes the ground: a shell bursts there and its fragments strike the design', t => {
  const { state: seen } = trial(t), bounds = designBounds(seen), short = { x: bounds.minX - 5, y: 0 };
  // A kinetic round marks the ground where the line meets it, told by how far it is from the nearest part of the design,
  // which stands over the ground.
  const { world, state } = trial(t), shot = drawn(state, short, [-3, 3], gun('rh120', 'apfsds'));
  assert.deepEqual([shot.verdict, shot.ground, shot.detail, shot.blast], ['ground', true, 'a 5,1 m do projeto', 0]);
  close(shot.away, designDistance(state, shot.impact), 1e-12); assert(shot.away > 5);
  const mark = flown(world, shot.round).find(event => event.type === 'ground');
  close(mark.x, short.x, .02); close(mark.x, shot.impact.x, .02);
  // A shell of 155 mm bursts on the ground where the line meets it, and tells how far its burst reaches.
  const { world: field, state: other } = trial(t), shell = drawn(other, short, [-3, 3], gun('m777', 'he'));
  assert.deepEqual([shell.verdict, shell.detail], ['ground', 'a 5,1 m do projeto · raio de ' + String(shell.blast).replace('.', ',') + ' m']);
  const events = flown(field, shell.round), burst = events.find(event => event.type === 'explosion');
  assert.equal(burst.ground, true); close(burst.x, short.x, .02);
  assert(events.some(event => ['spall', 'destroyed'].includes(event.type) && event.actorId === 'local'), 'its fragments strike the design');
  // A line drawn into the sky fires nothing, unless a shell is set to burst in the air there.
  const sky = { x: bounds.minX - 8.6, y: 3.8 };
  assert.equal(strikeAlong(tested(state, gun('m777', 'he')), { x: bounds.minX - 8, y: 3 }, { x: -.6, y: .8 }, sky), null);
  assert.ok(strikeAlong(tested(state, gun('m777', 'he', { detonation: 'airburst' })), { x: bounds.minX - 8, y: 3 }, { x: -.6, y: .8 }, sky).airburst);
});

test('a shell set to burst in the air bursts where the line was let go, if it meets nothing first, and never short of it', t => {
  const shell = gun('m777', 'he', { detonation: 'airburst' });
  // Let go at `aim` on the line drawn from `from`: the strike, what it tells, and what the core does with its round.
  const fuzed = (from, aim, weapon = shell) => {
    const { world, state } = trial(t), strike = strikeAlong(tested(state, weapon), from, strikeDirection(from, aim), aim),
      told = strike && { ...strike, ...strikeVerdict(strike.impact, strike), detail: strikeDetail(strike.impact, strike) },
      time = world.time, events = strike ? flown(world, strike.round) : [];
    return { state, told, time, events, burst: events.find(event => event.type === 'explosion') };
  };
  const { state } = trial(t), front = centre(state, 'hull:front'), bounds = designBounds(state), blast = 'raio de ' + String(shell.blastRadius).replace('.', ',') + ' m';
  // In the sky: it bursts there, as far from the design as it says, at the time it was fuzed for.
  const high = { x: bounds.minX - 8, y: 2 }, sky = { x: bounds.minX - 6, y: 3 }, up = fuzed(high, sky);
  assert.deepEqual([up.told.verdict, STRIKE_WORDS[up.told.verdict], up.told.impact], ['air', 'Explode no ar', null]);
  assert.equal(up.told.detail, 'a ' + String(Math.round(designDistance(up.state, sky) * 10) / 10).replace('.', ',') + ' m do projeto · ' + blast);
  close(up.told.airburst.x, sky.x, 1e-6); close(up.told.airburst.y, sky.y, 1e-6); close(up.told.solution.time, up.told.round.fuzeTime, 0);
  assert.equal(up.burst.detonation, 'airburst'); close(up.burst.x, sky.x, 1e-6); close(up.burst.y, sky.y, 1e-6);
  close(up.burst.time, up.time + up.told.round.fuzeTime, 1e-9);
  // Short of the design, its fragments strike it.
  const near = { x: front.x - 1, y: front.y }, beside = fuzed({ x: front.x - 4, y: front.y + 1 }, near);
  assert.equal(beside.told.verdict, 'air'); assert.match(beside.told.detail, /^a (0,9|1) m do projeto · raio de/);
  close(beside.burst.x, near.x, 1e-6); close(beside.burst.y, near.y, 1e-6);
  assert(beside.events.some(event => ['spall', 'destroyed'].includes(event.type) && event.actorId === 'local'), 'its fragments strike the design');
  // Let go past the plate, it strikes the plate first and bursts on it, as a fuze for farther would.
  const past = fuzed({ x: front.x - 3, y: front.y + 1 }, { x: front.x + 1, y: front.y });
  assert.deepEqual([past.told.verdict, past.told.impact.owner.id, past.told.airburst], ['burst', 'hull:front', null]);
  assert(past.told.round.fuzeTime > past.told.impact.time); assert.equal(past.burst.detonation, 'impact'); close(past.burst.x, past.told.impact.x, .02);
  // Let go three centimetres from where it was drawn from, it is put in the air there and bursts at the place let go:
  // not short of it, and not past it unburst.
  const from = { x: front.x - 3, y: front.y + 1 }, way = strikeDirection(from, front), by = { x: from.x + way.x * .03, y: from.y + way.y * .03 },
    soon = fuzed(from, by);
  assert.equal(soon.told.verdict, 'air'); assert(soon.told.round.fuzeTime > 0 && soon.told.round.fuzeTime < 1e-4);
  close(soon.told.round.x, from.x, 1e-6); close(soon.told.round.y, from.y, 1e-6);
  assert((soon.burst.x - from.x) * way.x + (soon.burst.y - from.y) * way.y >= .03 - 1e-9, 'never short of the place');
  close(soon.burst.x, by.x, 1e-6); close(soon.burst.y, by.y, 1e-6);
  // A mortar bomb lobbed from afar over several steps of the world bursts at the place as well, to the micrometre that
  // the air bends it off the line by.
  const lobbed = fuzed({ x: front.x - 6, y: front.y + 4 }, near, gun('m252', 'he', { detonation: 'airburst' }));
  assert(lobbed.told.round.fuzeTime > 3 / 60); close(lobbed.burst.x, near.x, 1e-5); close(lobbed.burst.y, near.y, 1e-5);
  // A shell set to burst on what it strikes is told no place in the air; nor is a kinetic round.
  assert.equal(fuzed(high, sky, gun('m777', 'he')).told, null);
  assert.equal(fuzed({ x: front.x - 3, y: front.y + 1 }, near, gun('rh120', 'apfsds')).told.round.fuzeTime, undefined);
  // How far a place is from the design: none on it, and from its nearest part off it.
  const corner = state.plates.flatMap(plate => plateCorners(plate.definition)).reduce((a, b) => b.x < a.x ? b : a);
  assert.equal(designDistance(state, front), 0); close(designDistance(state, { x: corner.x - 2, y: corner.y }), 2, 1e-9);
});

test('the verdict of a strike follows the rule the core strikes by, and says it in a few words', () => {
  const steel = MATERIALS.steel, plate = (angleDegrees, traversedMm) => ({ owner: { type: 'plate', material: steel, object: { definition: { thicknessMm: 15 } } }, angleDegrees, traversedMm }),
    cost = 20 * steel.resistance, slant = Math.acos(steel.ricochet / 2) * 180 / Math.PI;
  assert.deepEqual(strikeVerdict(null, { ammo: 'ap', power: 10 }), { verdict: 'miss' });
  assert.deepEqual(strikeVerdict(null, { ammo: 'he', power: 10, airburst: { x: 1, y: 2 } }), { verdict: 'air' });
  assert.deepEqual(strikeVerdict({ owner: { type: 'ground' } }, { ammo: 'ap', power: 10 }), { verdict: 'ground' });
  assert.deepEqual(strikeVerdict({ owner: { type: 'ground' } }, { ammo: 'he', power: 10 }), { verdict: 'ground' });
  assert.deepEqual(strikeVerdict(plate(0, 20), { ammo: 'he', power: 1e6 }), { verdict: 'burst' });
  assert.deepEqual(strikeVerdict(plate(0, 20), { ammo: 'ap', power: cost }), { verdict: 'through', cost });
  assert.deepEqual(strikeVerdict(plate(0, 20), { ammo: 'ap', power: cost - .01 }), { verdict: 'stopped', cost });
  // At a slant a kinetic round glances off unless it pierces well over what the plate costs; a shaped charge does not.
  assert.equal(strikeVerdict(plate(slant, 20), { ammo: 'ap', power: cost * 1.2 }).verdict, 'ricochet');
  assert.equal(strikeVerdict(plate(slant, 20), { ammo: 'ap', power: cost * 1.3 }).verdict, 'through');
  assert.equal(strikeVerdict(plate(slant, 20), { ammo: 'heat', power: cost * 1.2 }).verdict, 'through');
  // A piece costs what the core says; until it says, nothing is told.
  const piece = { owner: { type: 'module', object: { kind: 'engine' } }, angleDegrees: 10 };
  assert.deepEqual(strikeVerdict(piece, { ammo: 'ap', power: 30 }), { verdict: 'pending' });
  assert.equal(strikeVerdict(piece, { ammo: 'ap', power: 30 }, 25).verdict, 'through');
  assert.equal(strikeVerdict(piece, { ammo: 'ap', power: 30 }, 40).verdict, 'stopped');
  assert.equal(strikeDetail(plate(62.4, 32.3)), 'Aço 15 mm · 62° · 32 mm efetivos');
  assert.equal(strikeDetail(piece), MODULES.engine.name + ' · 10°');
  // The ground, and a place in the air a shell bursts at, by how far it is from the design, and how far the burst reaches.
  const soil = (more = {}) => ({ owner: { type: 'ground' }, x: 4, y: 0, angleDegrees: 30, ...more }), air = { x: 4, y: 3 };
  assert.equal(strikeDetail(soil(), { away: 6, blast: 7.2 }), 'a 6 m do projeto · raio de 7,2 m');
  assert.equal(strikeDetail(soil({ bounce: {} }), { away: 2.5 }), 'a 2,5 m do projeto · ricochete');
  assert.equal(strikeDetail(soil(), { away: 0 }), 'junto ao projeto');
  assert.equal(strikeDetail(soil(), { away: 30.4 }), 'a 30 m do projeto');
  assert.equal(strikeDetail({ owner: { type: 'ground' }, surface: 'nothing', angleDegrees: 3, bounce: {} }), 'Solo · ricochete');
  assert.equal(strikeDetail(null, { airburst: air, away: 2.44, blast: 7.2 }), 'a 2,4 m do projeto · raio de 7,2 m');
  assert.equal(strikeDetail(null, { airburst: air, away: .02, blast: 1.75 }), 'junto ao projeto · raio de 1,8 m');
  assert.equal(strikeDetail(null), '');
  assert.deepEqual(Object.values(STRIKE_WORDS).slice(0, 7), ['Penetra', 'Não penetra', 'Ricochete', 'Explode', 'Chão', 'Não atinge', 'Explode no ar']);
});

test('catalogue penetration calibration stays near its declared rolled-steel targets at their ranges', () => {
  // These are game calibration targets; their source strength varies by preset.
  // This formula consistency check is not an independent firing experiment.
  const steel = MATERIALS.steel, targets = [
    ['minimi', 'ap', 12, 100], ['fnmag', 'ap', 18, 100], ['fnmag', 'ap', 7, 500], ['m2hb', 'ap', 25, 200], ['m2hb', 'ap', 19, 500],
    ['rh202', 'ap', 32, 1000], ['m242', 'ap', 50, 1300], ['mk44', 'apfsds', 100, 1000], ['mk35', 'apfsds', 120, 1000],
    ['rh120', 'apfsds', 480, 2000], ['rh120', 'heat', 480, 2000], ['rh120', 'heat', 480, 10], ['at4', 'heat', 420, 100], ['carlgustaf', 'heat', 400, 100]];
  for (const [preset, ammo, mm, range] of targets) {
    const weapon = gun(preset, ammo), arrived = arrival(weapon, range), power = ammo === 'heat' ? weapon.power : weapon.power * (arrived.speed / arrived.muzzle) ** 2;
    // The power of a round is rounded, and the flight of the game is not the flight of the real round: within a tenth.
    close(power / steel.resistance, mm, mm * .1, `${preset} ${ammo} at ${range} m: ${(power / steel.resistance).toFixed(1)} mm, target ${mm} mm`);
  }
  // The 120 mm rod gets through half a metre of steel square on at the range of the test, but not at two kilometres.
  const rod = gun('rh120', 'apfsds'), wall = { owner: { type: 'plate', material: steel, object: { definition: { thicknessMm: 500 } } }, angleDegrees: 1, traversedMm: 500 },
    at = range => { const arrived = arrival(rod, range); return rod.power * (arrived.speed / arrived.muzzle) ** 2; };
  assert.equal(strikeVerdict(wall, { ammo: 'apfsds', power: at(10) }).verdict, 'through');
  assert.equal(strikeVerdict(wall, { ammo: 'apfsds', power: at(2000) }).verdict, 'stopped');
  // A shell bursts as it did: its power is its own, not that of the rod of its gun.
  assert.equal(gun('rh120', 'he').power, 430);
});

test('a point is on the design on its plates, its pieces and its skin, and not beside it', t => {
  const { state } = trial(t), bounds = designBounds(state), front = centre(state, 'hull:front'), engine = state.modules.find(m => m.kind === 'engine');
  assert(onDesign(state, null, front)); assert(onDesign(state, null, engine));
  assert(!onDesign(state, null, { x: front.x - .5, y: front.y }), 'half a metre in front of the hull is open air');
  assert(onDesign(state, null, { x: front.x - .05, y: front.y }, .1), 'a click within reach of it takes hold');
  assert(!onDesign(state, null, { x: bounds.maxX + 3, y: 6 }));
  for (const plate of state.plates) assert(plate.definition.x >= bounds.minX - 1e-9 && plate.definition.x <= bounds.maxX + 1e-9, plate.id);
});

test('a click on the design strikes it level at the place clicked, from the side its part there is seen from', t => {
  const { state } = trial(t), test = tested(state, gun('rh120', 'apfsds')), bounds = designBounds(state);
  const front = centre(state, 'hull:front'), struck = levelStrike(test, front, 'hull:front', 3);
  assert.deepEqual(struck.direction, { x: 1, y: 0 }); assert.deepEqual(struck.aim, front);
  assert.deepEqual(struck.from, { x: bounds.minX - STRIKE_MARGIN - 3, y: front.y }); assert.equal(struck.impact.owner.id, 'hull:front');
  const rear = centre(state, 'hull:rear'), back = levelStrike(test, rear, 'hull:rear', 3);
  assert.deepEqual(back.direction, { x: -1, y: 0 }); assert.equal(back.impact.owner.id, 'hull:rear');
  assert.deepEqual(back.from, { x: bounds.maxX + STRIKE_MARGIN + 3, y: rear.y });
  // A piece inside that neither line meets first is struck from the side whose line meets the design nearer it.
  const engine = state.modules.find(m => m.kind === 'engine'), inner = levelStrike(test, engine, engine.id, 3);
  assert.deepEqual(inner.direction, { x: -1, y: 0 }); assert(engine.x > (bounds.minX + bounds.maxX) / 2);
});

test('the gesture of the test of armour draws, tells and fires a strike from anywhere, and a click strikes the design level', async t => {
  const { state } = trial(t);
  const sent = [], renderer = { tool: 'fire', presentedState: null, state, weapon: gun('rh120', 'apfsds'), ground, camera: { zoom: 80 },
      strike: null, sceneFor: () => ({ actor: () => null }), predictionScene: snapshotCollisionIndex },
    context = { view: { trial: 'armour' }, renderer, input: { gesture: null }, session: { slowed: false, ready: true, testDistance: 10 },
      reach: pixels => pixels, performance, toast: message => sent.push(['toast', message]),
      command: (type, data) => { sent.push([type, data]); return Promise.resolve(type === 'resistance' ? { resistance: 12 } : { accepted: true }); } };
  Object.assign(context, createArmourTrial(context));
  assert.equal(context.strikes(), true);
  context.view.trial = 'terrain'; assert.equal(context.strikes(), false, 'only the test of armour is struck');
  context.view.trial = 'armour'; renderer.tool = 'inspect'; assert.equal(context.strikes(), false, 'nor while it is inspected');
  renderer.tool = 'fire';
  const plain = value => JSON.parse(JSON.stringify(value)), front = centre(state, 'hull:front'), bounds = designBounds(state);
  // Pressed in the air 3 m in front of the plate and 1 m up: within a few pixels of there, a release fires nothing.
  const from = { x: front.x - 3, y: front.y + 1 }, gesture = { type: 'strike', pressed: from, from, sx: 400, sy: 300 };
  context.aimStrike(gesture, { x: from.x + .01, y: from.y, sx: 403, sy: 301 });
  assert.deepEqual(plain(renderer.strike), { from, back: true });
  // Dragged toward the plate, short of it: the line goes on to it, and the round gets through.
  context.aimStrike(gesture, { x: from.x + 1.5, y: from.y - .5, sx: 520, sy: 340 });
  const strike = renderer.strike;
  assert.equal(strike.verdict, 'through'); assert.equal(strike.impact.owner.id, 'hull:front'); assert.match(strike.detail, /^Aço 15 mm · \d+° · \d+ mm efetivos$/);
  assert.deepEqual(strike.from, from); close(strike.direction.x, 3 / Math.sqrt(10)); close(strike.direction.y, -1 / Math.sqrt(10));
  context.launchStrike(strike);
  assert.deepEqual(plain(sent.at(-1)), plain(['strike', { round: strike.round, flight: strike.impact.time }])); assert.ok(renderer.strike.fired);
  // Into the sky it tells it meets nothing, and has no round to fire.
  context.aimStrike(gesture, { x: from.x - 1, y: from.y + 1, sx: 300, sy: 200 });
  assert.equal(renderer.strike.verdict, 'miss'); assert.equal(renderer.strike.round, undefined); assert.deepEqual(plain(renderer.strike.toward), { x: from.x - 1, y: from.y + 1 });
  // A shell set to burst in the air bursts where the line is let go, in the sky as well, and is seen flying until then.
  renderer.weapon = gun('m777', 'he', { detonation: 'airburst' });
  context.aimStrike(gesture, { x: from.x - 1, y: from.y + 1, sx: 300, sy: 200 });
  assert.equal(renderer.strike.verdict, 'air'); assert.match(renderer.strike.detail, /^a [\d,]+ m do projeto · raio de 7,2 m$/);
  close(renderer.strike.airburst.x, from.x - 1); close(renderer.strike.airburst.y, from.y + 1);
  context.launchStrike(renderer.strike);
  assert.deepEqual(plain(sent.at(-1)), plain(['strike', { round: renderer.strike.round, flight: renderer.strike.round.fuzeTime }]));
  renderer.weapon = gun('rh120', 'apfsds');
  // Into the ground short of the design: how far from it.
  const high = { x: bounds.minX - 8, y: 3 };
  context.aimStrike({ ...gesture, pressed: high, from: high }, { x: bounds.minX - 6.5, y: 1.5, sx: 450, sy: 350 });
  assert.deepEqual([renderer.strike.verdict, renderer.strike.detail], ['ground', 'a 5,1 m do projeto']); assert.ok(renderer.strike.round);
  // A piece is told once the core says what it costs: the strike is told again with the answer.
  const turret = centre(state, 'turret:front'), aside = { x: turret.x - 3, y: turret.y };
  context.input.gesture = { ...gesture, pressed: aside, from: aside };
  context.aimStrike(context.input.gesture, { x: turret.x - 2, y: turret.y, sx: 500, sy: 300 });
  assert.equal(renderer.strike.impact.owner.type, 'module'); assert.equal(renderer.strike.verdict, 'pending'); assert.equal(sent.at(-1)[0], 'resistance');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(renderer.strike.verdict, 'through', 'a piece that costs 12 does not stop the round');
  // Fired before the answer, it is told once the answer comes.
  context.input.gesture = null; context.clearCosts();
  context.aimStrike({ ...gesture, pressed: aside, from: aside }, { x: turret.x - 2, y: turret.y, sx: 500, sy: 300 }); context.launchStrike(renderer.strike);
  assert.equal(renderer.strike.verdict, 'pending'); await new Promise(resolve => setImmediate(resolve)); assert.equal(renderer.strike.verdict, 'through');
  // A click on the design strikes it level where it was clicked; one beside it does nothing.
  sent.length = 0; context.clickStrike(front);
  assert.equal(sent.at(-1)[0], 'strike'); assert.deepEqual(renderer.strike.direction, { x: 1, y: 0 }); assert.equal(renderer.strike.impact.owner.id, 'hull:front');
  sent.length = 0; renderer.strike = null; context.clickStrike({ x: front.x - 1, y: front.y });
  assert.deepEqual([sent.length, renderer.strike], [0, null]);
  // A slowed test gets its pace back with a click, once.
  assert.equal(context.quicken(), false);
  context.session.slowed = true; assert.equal(context.quicken(), true); assert.deepEqual(sent.at(-1), ['quicken', undefined]);
  assert.equal(context.session.slowed, false); assert.equal(context.quicken(), false);
});

test('the flight of a round struck at the design is seen as long whatever its speed, and the world is slow as it strikes', () => {
  const slow = new SlowMotion(), run = (seconds, step = 1 / 120) => { let world = 0; for (let i = Math.round(seconds / step); i > 0; i--) world += slow.advance(step); return world; };
  assert.equal(slow.advance(1), 1); assert.equal(slow.slowed, false);
  // A round of 120 mm that flies 2 ms is seen flying for FLIGHT_SECONDS; then the world is slow, and eases back by itself.
  slow.strike(5, .002); assert.equal(slow.slowed, true); close(slow.flight.pace, .002 / FLIGHT_SECONDS, 1e-12);
  assert.deepEqual([slow.flight.from, slow.flight.until], [5, 5.002]); assert.deepEqual(slow.struck, { from: 5, until: 5.002, pace: slow.flight.pace });
  close(run(FLIGHT_SECONDS / 2), .001, 1e-12); assert.ok(slow.flight);
  close(run(FLIGHT_SECONDS / 2), .001, 1e-12); assert.equal(slow.flight, null); assert.equal(slow.struck.until, 5.002, 'the page is still told of it');
  close(run(2), 2 * SLOW_PACE, 1e-9); assert.equal(slow.pace, SLOW_PACE); assert.equal(slow.slowed, true);
  const paces = []; for (let i = Math.round((SLOW_HOLD - 2 + SLOW_OUT) * 120) + 2; i > 0; i--) { slow.advance(1 / 120); paces.push(slow.pace); }
  assert.equal(slow.slowed, false); assert(paces.every((pace, i) => pace >= (paces[i - 1] ?? SLOW_PACE))); assert.equal(paces.at(-1), 1);
  assert.equal(slow.phase, null);
  // A slow flight is seen as it goes, and a flight of no time as briefly as the slowest pace lets it.
  slow.strike(0, 2); assert.equal(slow.flight.pace, 1); close(run(1), 1, 1e-12);
  slow.strike(0, 1e-7); assert.equal(slow.flight.pace, FLIGHT_PACE);
  // A tick across the end of the flight takes the rest of it, and the rest of the tick goes slowly.
  slow.strike(0, .004); close(slow.advance(1), .004 + (1 - FLIGHT_SECONDS) * SLOW_PACE, 1e-12);
  // A click gives the pace back at once, quicker, in the flight or after it.
  slow.strike(0, .004); slow.advance(.1); assert.equal(slow.end(), true); assert.deepEqual([slow.flight, slow.struck, slow.slowed], [null, null, false]);
  assert.equal(slow.end(), false);
  run(SLOW_CUT / 2); assert(slow.pace > SLOW_PACE && slow.pace < 1); run(SLOW_CUT / 2 + .01); assert.equal(slow.pace, 1);
  slow.strike(0, .004); run(FLIGHT_SECONDS + .5); assert.equal(slow.end(), true); run(SLOW_CUT + .01); assert.equal(slow.pace, 1);
  slow.strike(0, .004); slow.clear(); assert.deepEqual([slow.pace, slow.slowed, slow.flight, slow.struck, slow.phase], [1, false, null, null, null]);
});

test('a local world is shown as slowly as it goes, the flight of a round struck at the design at its own pace', () => {
  const presentation = new FramePresentation(), state = (time, extra = {}) => ({ time, actors: [], plates: [], modules: [], shots: null, ...extra });
  presentation.receive(state(1), [], { now: 0 });
  presentation.receive(state(1 + 1 / 60), [], { now: 100, pace: SLOW_PACE });
  close(presentation.sample(100 + 1000 / 60 / SLOW_PACE / 2).time, 1 + 1 / 120, 1e-9, 'half the step, half way through ten times its time');
  // News of an aim keeps showing the step under way.
  presentation.receive(state(1 + 1 / 60, { news: true }), [], { now: 150, pace: SLOW_PACE });
  close(presentation.sample(100 + 1000 / 60 / SLOW_PACE * .75).time, 1 + .75 / 60, 1e-9);
  assert.equal(presentation.state.news, true);
  presentation.receive(state(1 + 2 / 60), [], { now: 300 });
  close(presentation.sample(300 + 1000 / 60).time, 1 + 2 / 60, 1e-9, 'at its pace again, a step takes its own time');
  // A step in which a round flies 4 ms: its flight over FLIGHT_SECONDS, and the rest of the step slowly.
  const start = 1 + 2 / 60, flight = { from: start, until: start + .004, pace: .004 / FLIGHT_SECONDS }, rest = (1 / 60 - .004) / SLOW_PACE * 1000;
  presentation.receive(state(start + 1 / 60), [], { now: 1000, pace: SLOW_PACE, flight });
  close(presentation.sample(1000 + FLIGHT_SECONDS * 500).time, start + .002, 1e-9, 'half its flight half way through it');
  close(presentation.sample(1000 + FLIGHT_SECONDS * 1000).time, start + .004, 1e-9);
  close(presentation.sample(1000 + FLIGHT_SECONDS * 1000 + rest / 2).time, start + .004 + (1 / 60 - .004) / 2, 1e-9);
  close(presentation.sample(1000 + FLIGHT_SECONDS * 1000 + rest).time, start + 1 / 60, 1e-9);
  // A flight over before the step began is no longer shown at its pace.
  presentation.receive(state(start + 2 / 60), [], { now: 3000, pace: SLOW_PACE, flight });
  close(presentation.sample(3000 + 1000 / 60 / SLOW_PACE / 2).time, start + 1.5 / 60, 1e-9);
  // A round struck a step after the state shown last: that step goes by at the pace it went, then the round flies.
  const later = new FramePresentation(), struck = { from: 2 + 1 / 60, until: 2 + 1 / 60 + .004, pace: .004 / FLIGHT_SECONDS };
  later.receive(state(2), [], { now: 0 }); later.receive(state(2 + 2 / 60), [], { now: 100, pace: SLOW_PACE, flight: struck });
  close(later.sample(100 + 1000 / 60 / 2).time, 2 + .5 / 60, 1e-9, 'the step before the round, at the pace of the world then');
  close(later.sample(100 + 1000 / 60 + FLIGHT_SECONDS * 500).time, struck.from + .002, 1e-9, 'and then the flight, over FLIGHT_SECONDS');
  close(later.sample(100 + 1000 / 60 + FLIGHT_SECONDS * 1000 + rest).time, 2 + 2 / 60, 1e-9);
});

test('nothing a round struck at the design does is shown before it strikes, though the core tells it at the start of the step', t => {
  const { world, state: before } = trial(t), front = centre(before, 'hull:front'), strike = drawn(before, front, [-3, 3], gun('m777', 'he')),
    game = world.game(), presentation = new FramePresentation(), slow = new SlowMotion(), consumed = [];
  presentation.receive(before, [], { now: 0 });
  game.call({ op: 'projectile', projectile: game.projectile(strike.round) }); slow.strike(world.time, strike.impact.time);
  const from = world.events.length; world.step();
  const events = world.events.slice(from), until = before.time + strike.impact.time, struck = world.snapshot(), told = structuredClone(events);
  assert(events.some(event => event.type !== 'flight' && event.time < until - 1e-6), 'the core tells some of it at the start of the step');
  presentation.receive(struck, events, { now: 1000, pace: slow.pace, flight: { from: slow.flight.from, until: slow.flight.until, pace: slow.flight.pace } });
  const at = ms => { const sample = presentation.sample(1000 + ms); presentation.present(sample, { consume: event => consumed.push([sample.time, event]) }); return sample; };
  // Through its flight the round flies, nothing bursts and the design is shown whole.
  for (const ms of [100, 400, 790]) {
    const sample = at(ms);
    assert.equal(consumed.length, 0, ms + ' ms'); assert.equal(sample.state, before, ms + ' ms'); assert.equal(presentation.shotsAt(sample.time).length, 1);
  }
  // As it strikes, all of it is shown, the design as the step left it.
  const after = at(FLIGHT_SECONDS * 1000 + 20);
  assert(consumed.length >= events.filter(event => event.type !== 'flight').length && consumed.every(([time]) => time >= until - 1e-9));
  assert.equal(after.state, struck); assert.deepEqual(events, told, 'the events of the core are left as they came');
});

test('a shell set to burst in the air is seen flying to the place it was fuzed for, and bursting there as it gets there', t => {
  const { world, state: before } = trial(t), front = centre(before, 'hull:front'), from = { x: front.x - 4, y: front.y + 1 },
    near = { x: front.x - 1, y: front.y }, strike = strikeAlong(tested(before, gun('m777', 'he', { detonation: 'airburst' })), from, strikeDirection(from, near), near),
    game = world.game(), presentation = new FramePresentation(), slow = new SlowMotion(), consumed = [];
  presentation.receive(before, [], { now: 0 });
  game.call({ op: 'projectile', projectile: game.projectile(strike.round) }); slow.strike(world.time, strike.solution.time);
  const start = world.events.length; world.step();
  const events = world.events.slice(start), burst = events.find(event => event.type === 'explosion');
  presentation.receive(world.snapshot(), events, { now: 1000, pace: slow.pace, flight: slow.struck });
  const at = ms => { const sample = presentation.sample(1000 + ms); presentation.present(sample, { consume: event => consumed.push([sample.time, event]) }); return sample; };
  for (const ms of [100, 400, 790]) {
    const sample = at(ms);
    assert.equal(consumed.length, 0, ms + ' ms'); assert.equal(presentation.shotsAt(sample.time).length, 1, 'the shell is seen flying at ' + ms + ' ms');
  }
  at(FLIGHT_SECONDS * 1000 + 20);
  const [shown, told] = consumed.find(([, event]) => event.type === 'explosion');
  assert.equal(told, burst); assert(shown >= slow.struck.until - 1e-9); close(told.x, near.x, 1e-6); close(told.y, near.y, 1e-6);
});

test('the simulation worker puts a strike in the air, shows its flight slowly in the test of armour, and tells what a piece costs', async t => {
  const told = [], ticks = [], before = { self: globalThis.self, setInterval: globalThis.setInterval };
  globalThis.self = { postMessage: message => told.push(message) }; globalThis.setInterval = tick => { ticks.push(tick); return 0; };
  t.after(() => Object.assign(globalThis, before));
  await import('../src/simulation-worker.ts');
  globalThis.setInterval = before.setInterval;
  const send = data => { told.length = 0; globalThis.self.onmessage({ data }); return told; },
    frame = () => told.find(message => message.type === 'frame'), reply = () => told.find(message => message.type === 'reply');
  for (const slow of [true, false]) {
    send({ type: 'load', request: 1, generation: 1, blueprint: createStructuredTemplate('scout'), terrain: 'flat', slow, paused: false });
    assert.equal(reply().error, undefined);
    const time = frame().state.time;
    send({ type: 'ack', serial: frame().serial });
    const { state: seen } = trial(t), front = centre(seen, 'hull:front'), strike = drawn(seen, front, [-3, 1], gun('rh120', 'apfsds'));
    send({ type: 'strike', request: 2, round: strike.round, flight: strike.impact.time });
    assert.equal(reply().accepted, true);
    if (!slow) {
      // Elsewhere the round waits in the air for the next tick, and the world keeps its pace.
      assert.deepEqual([frame().pace, frame().flight, frame().slowed], [1, null, false]);
      assert.equal(frame().state.time, time); assert(frame().state.shots.data.length > 0, 'the round is in the air');
      continue;
    }
    // In the test of armour its first step is taken at once, and its flight is told for the page to show it slowly.
    assert.deepEqual([frame().pace, frame().slowed], [SLOW_PACE, true]);
    assert.equal(frame().flight.from, time); close(frame().flight.until, time + strike.impact.time, 1e-12);
    close(frame().flight.pace, strike.impact.time / FLIGHT_SECONDS, 1e-12);
    assert(frame().state.time > time); assert(frame().events.some(event => event.primaryContact && event.id === 'hull:front'));
    send({ type: 'ack', serial: frame().serial }); send({ type: 'quicken', request: 3 });
    assert.equal(reply().ok, true);
    send({ type: 'aim', request: 4, aim: { x: 20, y: 2 }, weapon: gun('rh120', 'apfsds') });
    assert.equal(frame().slowed, false, 'a click gave the pace back'); assert.equal(frame().flight, null);
    const engine = seen.modules.find(m => m.kind === 'engine');
    send({ type: 'resistance', request: 5, id: engine.id, point: { x: engine.x - .3, y: engine.y }, end: { x: engine.x + .3, y: engine.y }, depth: 600, cosine: 1 });
    assert(reply().resistance > 0 && Number.isFinite(reply().resistance));
    send({ type: 'resistance', request: 6, id: 'nothing', point: { x: 0, y: 0 }, end: { x: 1, y: 0 }, depth: 1, cosine: 1 });
    assert.equal(reply().error, 'Peça não encontrada.');
  }
  send({ type: 'clear', request: 7, generation: 2 });
  assert.equal(ticks.length, 1);
});
