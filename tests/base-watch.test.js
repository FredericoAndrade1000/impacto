import test from 'node:test';
import assert from 'node:assert/strict';
import { BaseWatch, TRACK_CALIBRE, RADAR_REACH, RADAR_MAST, RADAR_ERROR, RADAR_FLOOR, EAR_CALIBRE, EAR_REACH, EAR_ERROR, EAR_FLOOR, SOUND_SPEED, EAR_PAUSE, BEST_FIX, ALOFT } from '../server/base-watch.ts';
import { BATTERY_SECONDS, LOW_AIR } from '../src/battle-rules.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { packShots } from '../src/shots.ts';
import { chapters } from '../server/fog.ts';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { COUNTER_ERROR } from '../src/squad.ts';

// Two bases on level ground, Alice's at the middle and Bob's far to the right, and the guns of each by name.
const FLAT = { height: () => 0 }, BASES = [{ team: 'alice', x: 0, y: 0 }, { team: 'bob', x: 20000, y: 0 }],
  TEAMS = { 'bob-gun': 'bob', 'bob-mortar': 'bob', 'alice-gun': 'alice' };
// A watch and its looks: at each the rounds in the air, told as objects, at a time.
function watching({ terrain = FLAT, bases = BASES } = {}) {
  const watch = new BaseWatch();
  return { watch, look: (time, ...rounds) => watch.look({ shots: packShots(rounds), bases, terrain, time, teamOf: id => TEAMS[id] ?? null }),
    marks: (team, time) => watch.marks(team, time) };
}
// A round of a gun: where it is and how old, flying to the left at 300 m/s and climbing at 50; a howitzer's on the
// ground unless told otherwise — just fired, it is still low over the ground.
const round = (number, x, more = {}) => ({ number, actorId: 'bob-gun', weapon: 'cannon', preset: 'm119', x, y: 6.5, vx: -300, vy: 50, age: .1, ...more });

test('the calibres the watch goes by are those of the guns of the game: shells are followed, big guns heard, bullets neither', () => {
  const calibre = id => WEAPON_PRESETS[id].caliberMm, followed = Object.keys(WEAPON_PRESETS).filter(id => calibre(id) >= TRACK_CALIBRE).sort(),
    heard = Object.keys(WEAPON_PRESETS).filter(id => calibre(id) >= EAR_CALIBRE && calibre(id) < TRACK_CALIBRE);
  assert.deepEqual(followed, ['at4', 'carlgustaf', 'hydra70', 'm119', 'm224', 'm252', 'm777', 'rh120']); assert.deepEqual(heard, ['mk19']);
  assert(EAR_CALIBRE < TRACK_CALIBRE && RADAR_FLOOR > BEST_FIX && EAR_FLOOR > RADAR_FLOOR && EAR_ERROR > RADAR_ERROR);
});

test('the radar of a base follows a shell in the air about it and says where it was fired from, to within a share of the way there', () => {
  const { watch, look, marks } = watching(), gun = 6000, error = RADAR_ERROR * gun;
  // Just fired, 30 m from its gun already: the round says where it left it. Alice's base has it in the air within reach.
  look(10, round(1, gun - 30));
  const [mark] = marks('alice', 10);
  assert.deepEqual([mark.id, mark.kind, mark.by, mark.error, mark.at], ['battery:1', 'battery', 'radar', Math.round(error), 10]);
  assert(!JSON.stringify(mark).includes('bob'), 'a mark does not name the construction that fired');
  assert(Math.abs(mark.x - gun) <= error && mark.x !== gun, 'off by no more than that, and not the place itself');
  assert.equal(mark.y, undefined, 'a place on the ground, with no height of its own');
  // His own base is told nothing of his gun, and no third thing: a mark is all there is.
  assert.deepEqual(marks('bob', 10), []); assert.deepEqual(Object.keys(mark).sort(), ['at', 'by', 'error', 'id', 'kind', 'x']);
  // The same round, seen again and again as it flies, is one word of the gun: the mark stays as it was.
  look(10.1, round(1, gun - 60, { age: .2 })); look(10.2, round(1, gun - 90, { age: .3 }));
  assert.deepEqual(marks('alice', 10.2), [mark]);
  // A construction the faction is told as it is has no mark, and keeps the one it had for when it is lost again.
  assert.deepEqual(watch.marks('alice', 10.2, new Set(['bob-gun'])), []); assert.deepEqual(watch.marks('alice', 10.2, new Set(['bob-mortar'])), [mark]);
});

test('every round of a gun that is followed makes its place surer, down to a floor, and a mark is kept a minute after the last', () => {
  const { look, marks } = watching(), gun = 6000, one = RADAR_ERROR * gun;
  let off = Infinity;
  for (let n = 1; n <= 9; n++) {
    look(n, round(n, gun - 30));
    const [mark] = marks('alice', n);
    assert.equal(mark.error, Math.max(BEST_FIX, Math.round(one / Math.sqrt(n))), `${n} rounds`); assert(Math.abs(mark.x - gun) <= one);
    assert.equal(mark.at, n); off = Math.abs(mark.x - gun);
  }
  assert(off < one / 2, 'the place they agree on is nearer than one of them would have it');
  // However many more: no surer than the floor.
  for (let n = 10; n <= 400; n++) look(9 + n / 1000, round(n, gun - 30));
  assert.equal(marks('alice', 9.4)[0].error, BEST_FIX);
  // The gun falls silent: its mark stands for a while, as old as the last round — the reports that come after it add
  // nothing to what the radar holds — and then is gone.
  look(40); assert.equal(marks('alice', 9.4 + BATTERY_SECONDS - .1).length, 1); assert.deepEqual(marks('alice', 9.4 + BATTERY_SECONDS + .1), []);
  // Heard of again later, it is a gun found anew: one round's worth of sureness.
  look(200, round(500, gun - 30)); assert.deepEqual([marks('alice', 200)[0].error, marks('alice', 200)[0].id], [Math.round(one), 'battery:2']);
});

test('an unobserved watch releases expired gun histories without a client reading its marks', () => {
  const { watch, look, marks } = watching();
  look(1, round(1, 5970));
  assert.equal(watch.books.get('alice').size, 1);
  look(BATTERY_SECONDS + 2);
  assert.equal(watch.books.get('alice')?.size ?? 0, 0, 'expiration belongs to the running watch');
  look(200, round(2, 5970));
  assert.equal(marks('alice', 200)[0].id, 'battery:2', 'a new fix cannot reuse the expired public identity');
});

test('a shell is followed where the radar has it: within reach of the base, over the ground between, and only when it was seen to leave its gun', () => {
  // Fired far beyond reach, it is followed once it comes within it — and the place told is the gun's, however far.
  const far = watching(), gun = RADAR_REACH + 4000;
  far.look(1, round(1, gun - 30)); assert.deepEqual(far.marks('alice', 1), []);
  far.look(10, round(1, RADAR_REACH + 50, { age: 9.1 })); assert.deepEqual(far.marks('alice', 10), []);
  far.look(11, round(1, RADAR_REACH - 50, { age: 10.1 }));
  const [mark] = far.marks('alice', 11); assert.equal(mark.error, Math.round(RADAR_ERROR * gun)); assert(Math.abs(mark.x - gun) <= mark.error);
  // A ridge between the base and the shell hides it while it flies low: over the line from the mast, it is followed.
  const ridge = watching({ terrain: { height: x => Math.abs(x - 3000) < 200 ? 300 : 0 } });
  ridge.look(1, round(1, 5970)); ridge.look(2, round(1, 5700, { y: 400, age: 1.1 })); assert.deepEqual(ridge.marks('alice', 2), []);
  ridge.look(3, round(1, 5400, { y: 2 * (300 - RADAR_MAST) + RADAR_MAST + 100, age: 2.1 })); assert.equal(ridge.marks('alice', 3).length, 1);
  // A round first met long after it was fired does not say where from: it is never followed back.
  const late = watching(); late.look(1, round(1, 4000, { age: 3 })); late.look(2, round(1, 3700, { age: 4 })); assert.deepEqual(late.marks('alice', 2), []);
  // Nor is one of a construction that is gone, or a bullet.
  const none = watching();
  none.look(1, round(1, 5970, { actorId: 'gone' }), round(4, 5970, { weapon: 'autocannon', preset: 'rh202' }), round(5, 5970, { weapon: 'machinegun', preset: 'm2hb' }));
  assert.deepEqual(none.marks('alice', 1), []); assert.equal(none.watch.rounds.size, 1, 'only the shell of the one that is gone is kept at all');
  // What is followed is forgotten when it lands.
  none.look(2); assert.equal(none.watch.rounds.size, 0);
});

test('the ears of a base hear a gun as far off as its calibre carries, as late as its sound takes, and less surely than the radar follows a shell', () => {
  // A grenade launcher is no shell for the radar: it is heard, 2 km off, when its sound has come.
  const { look, marks } = watching(), gun = 2000, late = gun / SOUND_SPEED, grenade = (number, more) => round(number, gun - 30, { weapon: 'grenade', preset: 'mk19', ...more });
  assert(gun < EAR_REACH * WEAPON_PRESETS.mk19.caliberMm);
  look(10, grenade(1)); assert.deepEqual(marks('alice', 10), []);
  look(10 + late - .05); assert.deepEqual(marks('alice', 10 + late - .05), []);
  look(10 + late + .05);
  const [mark] = marks('alice', 10 + late + .05), error = Math.max(EAR_FLOOR, EAR_ERROR * gun);
  assert.deepEqual([mark.id, mark.kind, mark.by, mark.error, mark.at], ['battery:1', 'battery', 'sound', Math.round(error), Math.round((10 + late) * 1000) / 1000], 'as old as its coming');
  assert(Math.abs(mark.x - gun) <= error);
  // A burst is one report a second, not one a round.
  const burst = watching();
  for (let n = 0; n < 20; n++) burst.look(n * EAR_PAUSE / 10, grenade(n + 1));
  assert.equal(burst.watch.reports.length, 2);
  // Beyond what its calibre carries it is not heard at all; a howitzer is, three times as far.
  const quiet = watching(), out = EAR_REACH * WEAPON_PRESETS.mk19.caliberMm + 100;
  quiet.look(1, round(1, out - 30, { weapon: 'grenade', preset: 'mk19' })); assert.equal(quiet.watch.reports.length, 0);
  quiet.look(2, round(2, RADAR_REACH + 3000, { y: 5 }), round(3, out - 30, { actorId: 'bob-mortar', weapon: 'cannon', preset: 'm119', y: -500 }));
  assert.deepEqual(quiet.watch.reports.map(report => report.actorId), ['bob-mortar'], 'the nearer one, in earshot; the farther beyond a howitzer\'s too');
  // A shell the radar follows and the ears hear is one gun, and the radar's word of it stands alone: the report,
  // of where the gun stood a while before, adds nothing to it.
  const both = watching(); both.look(1, round(1, 5970)); const [first] = both.marks('alice', 1);
  both.look(1 + 6000 / SOUND_SPEED + .1); assert.equal(both.watch.reports.length, 0); assert.deepEqual(both.marks('alice', 30), [first]); assert.equal(first.by, 'radar');
  // Heard first and followed after, the gun is where the radar has it: what the ears said of it is dropped. A knoll just
  // before the mortar hides its rounds from the mast while they fly low.
  const after = watching({ terrain: { height: x => Math.abs(x - 3920) < 20 ? 50 : 0 } }), mortar = (number, x, more) => round(number, x, { preset: 'm252', ...more });
  after.look(1, mortar(1, 3970)); after.look(1 + 4000 / SOUND_SPEED + .1);
  assert.deepEqual([after.marks('alice', 14)[0].by, after.marks('alice', 14)[0].error], ['sound', Math.round(EAR_ERROR * 4000)]);
  after.look(15, mortar(2, 3970)); assert.equal(after.marks('alice', 15)[0].by, 'sound');
  after.look(16, mortar(2, 3700, { y: 56.5, age: 1.1 })); assert.deepEqual([after.marks('alice', 16)[0].by, after.marks('alice', 16)[0].error], ['radar', Math.round(RADAR_ERROR * 4000)]);
  assert.deepEqual([after.marks('alice', 16).length, after.marks('alice', 16)[0].id], [1, 'battery:1'], 'the same mark, better placed');
});

test('a gun that fires from the air is placed in the air, as high as it was, by the straight line from the base to it', () => {
  assert.equal(ALOFT, LOW_AIR);
  // An aircraft 3 km along the field from Alice's base and 2 km up looses a rocket: its radar has it, 3.6 km off, and
  // places it as high as it was — as unsurely up as along, and never lower than where the air begins.
  const rocket = (number, x, y, more) => round(number, x, { weapon: 'rocket', preset: 'hydra70', y, ...more }), high = (number, y) => rocket(number, 2970, y + 5);
  const { look, marks } = watching(), far = Math.hypot(3000, 2000 - RADAR_MAST);
  look(1, high(1, 2000));
  const [mark] = marks('alice', 1), error = RADAR_ERROR * far;
  assert.deepEqual([mark.by, mark.error], ['radar', Math.round(error)]);
  assert(Math.abs(mark.x - 3000) <= error && Math.abs(mark.y - 2000) <= error && mark.y >= ALOFT, `${mark.x}, ${mark.y}`);
  assert.deepEqual(Object.keys(mark).sort(), ['at', 'by', 'error', 'id', 'kind', 'x', 'y']);
  // Fired from 7.6 km up over the same place, it is past the reach of the radar — 3 km along the field but 8.1 km off —,
  // and of its ears: nothing places it, however long its sound takes.
  const above = watching();
  above.look(1, high(1, 7600)); above.look(2, rocket(1, 2400, 7700, { age: 2.1 })); above.look(30);
  assert(Math.hypot(3000, 7600 - RADAR_MAST) > RADAR_REACH && Math.hypot(3000, 7600) > EAR_REACH * 70);
  assert.deepEqual([above.marks('alice', 30), above.watch.reports.length], [[], 0]);
  // Lower, a kilometre up, its ears hear it too, by the straight line: as late as its sound takes to come down. The report
  // adds nothing to what the radar holds.
  const lower = watching(), down = Math.hypot(3000, 1000);
  lower.look(1, high(1, 1000)); assert.equal(lower.watch.reports.length, 1);
  assert.equal(lower.watch.reports[0].at, 1 + down / SOUND_SPEED); assert.equal(lower.watch.reports[0].error, Math.max(EAR_FLOOR, EAR_ERROR * down));
  lower.look(1 + down / SOUND_SPEED + .1); assert.deepEqual(lower.marks('alice', 20).map(mark => mark.by), ['radar']);
  // Heard alone, it is placed in the air as well.
  const heard = watching({ terrain: { height: x => Math.abs(x - 1000) < 30 ? 2000 : 0 } });
  heard.look(1, high(1, 1000)); heard.look(1 + down / SOUND_SPEED + .1);
  const [sound] = heard.marks('alice', 20);
  assert(sound.by === 'sound' && Math.abs(sound.y - 1000) <= sound.error && Math.abs(sound.x - 3000) <= sound.error);
  // A gun on the ground that takes to the air is a gun found elsewhere: a mark of its own, in the air; one that fires just
  // over the ground, lower than the air begins, is on the ground.
  const rising = watching();
  rising.look(1, rocket(1, 2970, 5 + 6.5)); rising.look(2, high(2, 1500));
  assert.deepEqual(rising.marks('alice', 2).map(mark => [mark.id, mark.y === undefined]), [['battery:2', false]]);
  rising.look(3, rocket(3, 2970, 5 + ALOFT - 1)); assert.deepEqual(rising.marks('alice', 3).map(mark => [mark.id, mark.y]), [['battery:3', undefined]]);
});

test('a gun that fired and moved leaves its mark behind: the next round puts it where it is now, as unsure as a first', () => {
  const { look, marks } = watching(), one = RADAR_ERROR * 6000;
  for (let n = 1; n <= 6; n++) look(n, round(n, 5970));
  assert(marks('alice', 6)[0].error < one / 2); assert.equal(marks('alice', 6)[0].id, 'battery:1');
  look(20, round(7, 6970));
  const [moved] = marks('alice', 20); assert.equal(moved.id, 'battery:2', 'nothing says it is the gun that was held elsewhere'); assert(Math.abs(moved.x - 7000) <= RADAR_ERROR * 7000); assert.equal(moved.error, Math.round(RADAR_ERROR * 7000));
  // The reports of the rounds it fired before it moved come later still: they do not pull the mark back.
  look(40); assert.deepEqual(marks('alice', 40), [moved]);
  // Each team holds its own: Bob's base, too far from Alice's gun to follow its shell before it lands near her, hears nothing of it either.
  look(21, round(8, 500, { actorId: 'alice-gun', vx: 300 })); assert.deepEqual(marks('bob', 21), []); assert.equal(marks('alice', 21).length, 1);
  // A faction that is gone takes what it held with it.
  const { watch } = watching(); watch.look({ shots: packShots([round(1, 5970)]), bases: BASES, terrain: FLAT, time: 1, teamOf: id => TEAMS[id] });
  watch.forget('alice'); assert.deepEqual(watch.marks('alice', 1), []); assert.deepEqual([watch.books.size, watch.named.size, watch.reports.length], [0, 0, 0]);
});

test('on the field a howitzer that shells a base out of its sight is placed by that base, and told as a mark until the faction sees the gun itself', t => {
  const room = rehearsal([0, 6000]), world = room.world, ground = world.terrain; t.after(() => world.dispose());
  const [alice, bob] = ['Alice', 'Bob'].map(name => { const player = room.players.get(room.join(name).playerId); return { id: player.id, faction: player.factionId }; });
  const scout = room.publish(alice.id, createStructuredTemplate('scout')).actor.id, gun = room.publish(bob.id, createStructuredTemplate('howitzer')).actor.id;
  const run = seconds => { for (let i = 0; i < Math.round(seconds * 60); i++) room.step(); }, until = (done, seconds) => { for (let i = 0; i < seconds * 60 && !done(); i++) room.step(); return done(); },
    told = side => { const state = world.snapshot(); state.shared = true; state.players = room.roster(); return room.audience(state, chapters(state), [], side.faction).state; },
    batteries = side => told(side).contacts.filter(contact => contact.kind === 'battery'), at = id => world.actor(id).vehicle.x, home = at(scout);
  room.command(alice.id, { type: 'squad', order: 'control', id: null }); room.command(bob.id, { type: 'squad', order: 'control', id: null });
  run(1); assert.deepEqual([batteries(alice), batteries(bob), room.knows(alice.faction, world.actor(gun))], [[], [], null]);
  // Bob shells her base from six kilometres: nothing of hers sees his gun.
  room.command(bob.id, { type: 'squad', order: 'bombard', ids: [gun], point: { x: home, y: ground.height(home) + 1.5 } });
  assert(until(() => batteries(alice).length, 60), 'her base placed the gun');
  const [mark] = batteries(alice);
  assert.equal(mark.kind, 'battery'); assert(!JSON.stringify(told(alice).contacts).includes(gun), 'a mark does not name the construction'); assert(Math.abs(mark.x - at(gun)) <= Math.max(EAR_ERROR * 6000, 3 * mark.error), `${mark.x} for a gun at ${at(gun)}`);
  assert.equal(room.knows(alice.faction, world.actor(gun)), null, 'a mark is not the construction: it stays unknown to her'); assert.deepEqual(batteries(bob), []);
  // More shells, and the radar has followed some: the place is surer than one report or one shell would have it.
  assert(until(() => batteries(alice)[0].by === 'radar' && batteries(alice)[0].error < RADAR_ERROR * 6000 * .8, 90), 'followed by the radar, round after round');
  assert(Math.abs(batteries(alice)[0].x - at(gun)) <= RADAR_ERROR * 6000);
  // Her scout comes to where it sees the gun: she is told the gun itself, and the mark no more.
  const v = world.actor(scout).vehicle, near = at(gun) - 150;
  world.command('setVehicleState', { actorId: scout, state: { x: near, y: v.y - ground.height(v.x) + ground.height(near) + 1, vx: 0, vy: 0 } });
  assert(until(() => room.knows(alice.faction, world.actor(gun)) === 'seen', 10), 'the scout sees it'); assert.deepEqual(batteries(alice), []);
  // Ordered to stop and out of her sight again, the gun is a mark for a minute after its last round, and then nothing.
  room.command(bob.id, { type: 'squad', order: 'stop', ids: [gun] });
  world.command('setVehicleState', { actorId: scout, state: { x: home, y: ground.height(home) + 3, vx: 0, vy: 0 } });
  run(BATTERY_SECONDS + 45); assert.deepEqual(batteries(alice), []);
});

test('on the field a howitzer left free to fire answers the gun its base placed, shell for shell, with nobody in sight of either', t => {
  const room = rehearsal([0, 6000]), world = room.world; t.after(() => world.dispose());
  const [alice, bob] = ['Alice', 'Bob'].map(name => { const player = room.players.get(room.join(name).playerId); return { id: player.id, faction: player.factionId }; });
  const hers = room.publish(alice.id, createStructuredTemplate('howitzer')).actor.id, his = room.publish(bob.id, createStructuredTemplate('howitzer')).actor.id;
  const until = (done, seconds) => { for (let i = 0; i < seconds * 60 && !done(); i++) room.step(); return done(); }, at = id => world.actor(id).vehicle.x, fired = id => world.actor(id).stats.shots,
    told = side => { const state = world.snapshot(); state.shared = true; state.players = room.roster(); return room.audience(state, chapters(state), [], side.faction).state; },
    batteries = side => told(side).contacts.filter(contact => contact.kind === 'battery'), unit = (side, id) => room.players.get(side.id).squad.view().units.find(u => u.id === id);
  for (const side of [alice, bob]) room.command(side.id, { type: 'squad', order: 'control', id: null });
  room.command(alice.id, { type: 'squad', order: 'stance', ids: [hers], stance: 'fire' });
  for (let i = 0; i < 120; i++) room.step();
  assert.deepEqual([fired(hers), fired(his), unit(alice, hers).counter], [0, 0, null], 'free to fire, with nothing to fire at');
  // Bob shells her base. Her base places his gun, and her howitzer answers it on its own.
  room.command(bob.id, { type: 'squad', order: 'bombard', ids: [his], point: { x: at(hers), y: world.terrain.height(at(hers)) + 1.5 } });
  assert(until(() => fired(hers) > 0, 120), 'her howitzer fired back');
  const answer = unit(alice, hers), [mark] = batteries(alice);
  assert(mark && mark.error <= COUNTER_ERROR && Math.abs(answer.counter.x - mark.x) <= mark.error / 2 + .1, 'laid on the place her base holds');
  assert(Math.abs(answer.counter.x - at(his)) <= COUNTER_ERROR); assert.deepEqual([answer.attack, answer.stance, answer.reason], [null, 'fire', 'bombarding']);
  assert.equal(room.knows(alice.faction, world.actor(his)), null, 'she never saw it');
  // Her shells in the air give her gun away in turn: his base places it too. He was told to bombard her base, not to answer.
  assert(until(() => batteries(bob).length > 0, 90), 'his base placed her gun'); assert.equal(unit(bob, his).counter, null);
  // The duel ends when he stops: a minute after his last round her base holds his gun no longer, and her howitzer falls silent.
  room.command(bob.id, { type: 'squad', order: 'stop', ids: [his] });
  assert(until(() => !batteries(alice).length && !unit(alice, hers).counter, BATTERY_SECONDS + 60), 'nothing left to answer');
  const spent = fired(hers); for (let i = 0; i < 600; i++) room.step(); assert.equal(fired(hers), spent);
});
