import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { SupplyDispatch } from '../server/supply-dispatch.ts';
import { Squad, gunReach, HAUL_SCARE, MARK_SCARE, FREE_FIRE_RADIUS, FREE_FIRE_CLIMB, COUNTER_ERROR } from '../src/squad.ts';
import { STOCK_IDS } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { gunship } from './helpers/aircraft.js';

// How far an enemy is from what it threatens, for every rule that holds work up, answers fire or keeps clear of a blast:
// the straight line between them, along the field and up alike. An aircraft high over a place whose guns do not reach down
// so far threatens nothing there; come down within their reach, it does. Each rule in a case of each.

// A squad of the side with its vehicles where `places` puts them (each a vehicle's body: `x` along the field, `y` up), on
// level ground, and what its side holds of the enemies (`threats`) and of the guns its base places (`batteries`).
function squadOf({ places, threats = [], batteries = [], plates = [] }) {
  const world = { time: 10, terrain: { minX: -10000, maxX: 10000, height: () => 0 }, plates, modules: [],
      actor: id => places[id] ? { id, team: 'green', vehicle: places[id] } : null },
    side = { world, roster: Object.keys(places).map(id => ({ id, team: 'local' })), defeats: {}, batteries, threats: () => threats, foe: () => true };
  return { squad: new Squad(side), side, world };
}

test('an enemy high over a worker holds its work up only as far as the straight line to it is within the reach of its guns', () => {
  const foe = (x, y, reach) => ({ id: 'foe', x, y, reach }), held = (...threats) => {
    const { squad } = squadOf({ places: { truck: { x: 0, y: 0 } }, threats });
    return squad.endangered('truck', squad.units.get('truck'), true);
  };
  assert.deepEqual([HAUL_SCARE, MARK_SCARE], [1000, 300]);
  // A gunship 100 m along the field and 2 km up, whose guns reach 1.5 km, is 2 km off: past its reach and past what turns a
  // worker back. 300 m up, it is near.
  assert.deepEqual([held(foe(100, 2000, 1500)), held(foe(100, 300, 1500))], [false, true]);
  // Its guns reaching 250 m, it holds nothing 300 m over the worker, and it does 200 m over it.
  assert.deepEqual([held(foe(0, 300, 250)), held(foe(0, 200, 250))], [false, true]);
  // A mark, which says nothing of its guns: within `MARK_SCARE` by the straight line, a kilometre up or 200 m.
  assert.deepEqual([held(foe(50, 1000, null)), held(foe(50, 200, null))], [false, true]);
  // On the ground, as before: as far along as its guns reach.
  assert.deepEqual([held(foe(900, 0, 1500)), held(foe(1100, 0, 1500))], [true, false]);
});

test('a hit on a vehicle of the side has another answer only as far as its guns reach, up and down alike', () => {
  const answered = height => {
    const plates = [{ actorId: 'flier', revision: 0 }], { squad } = squadOf({ places: { gunner: { x: 0, y: 0 }, flier: { x: 100, y: height } }, plates });
    squad.reach = () => 800;
    squad.sample(1); plates[0].revision = 1; squad.sample(2);
    return [squad.units.get('flier').alertUntil > 10, squad.units.get('gunner').answerUntil > 10];
  };
  // The flier hit 2 km over the gunner is out of the reach of its guns: it answers, the gunner does not. 300 m up, both do.
  assert.deepEqual(answered(2000), [true, false]);
  assert.deepEqual(answered(300), [true, true]);
});

test('the guns of the side answer only the guns its base placed on the ground, not those that fired from the air', () => {
  const ground = { id: 'battery:1', kind: 'battery', x: 3000, error: COUNTER_ERROR - 5, at: 9, by: 'radar' },
    aloft = { id: 'battery:2', kind: 'battery', x: 3000, y: 2000, error: COUNTER_ERROR - 5, at: 9, by: 'radar' },
    loose = { id: 'battery:3', kind: 'battery', x: 3000, error: COUNTER_ERROR + 5, at: 9, by: 'sound' },
    { squad } = squadOf({ places: { gun: { x: 0, y: 0 } }, batteries: [ground, aloft, loose] });
  squad.sample(1);
  assert.deepEqual(squad.placed.map(mark => mark.id), ['battery:1']);
});

test('a shell does not keep from a point a vehicle of its own high over it, and does one beside it or low over it', () => {
  const harms = (x, y) => { const { squad } = squadOf({ places: { flier: { x, y } } }); return squad.harms('flier', { weaponPreset: 'm119', weaponAmmo: 'he' }, { x: 0, y: 0 }); };
  // 3 m beside it on the ground, or 6 m over it: in the reach of the burst. 40 m over it, or 2 km: out of it, however near along.
  assert.deepEqual([harms(3, 0), harms(0, 6), harms(0, 40), harms(0, 2000)], [true, true, false, false]);
  assert.equal(harms(40, 0), false);
});

test('an aircraft free to fire goes for an enemy only within its stretch of the field, and climbs for it no higher than a little over where it was', () => {
  const vehicle = { x: 1000, y: 60, angle: 0, flying: true }, { squad, side } = squadOf({ places: { ship: vehicle } }), unit = squad.units.get('ship');
  side.freeFireRegion = (id, anchor) => ({ anchor, radius: FREE_FIRE_RADIUS });
  Object.assign(unit, { stance: 'fire', fireAt: 1000 });
  const seen = (x, y) => ({ targetId: 'foe', contact: { detected: true, visible: true, age: 0, channel: 'visual', x, y } });
  assert.equal(FREE_FIRE_CLIMB, FREE_FIRE_RADIUS);
  // An enemy 300 m off the place it was given leave at is no business of its own, as it is none of a vehicle on the ground.
  assert.equal(squad.strikeTarget('ship', unit, seen(1300, 1)), null);
  // One 50 m off is: with the stretch it keeps over, and as high as it may climb for it over where it first looked.
  const near = squad.strikeTarget('ship', unit, seen(1050, 1));
  assert.deepEqual(near, { x: 1050, y: 1, guns: [], region: { anchor: 1000, radius: FREE_FIRE_RADIUS, top: 60 + FREE_FIRE_CLIMB } });
  // However it climbs on its way, that height stays as it was; given leave elsewhere, it is taken anew where it is then.
  vehicle.y = 150; assert.equal(squad.strikeTarget('ship', unit, seen(1050, 1)).region.top, 60 + FREE_FIRE_CLIMB);
  unit.fireAt = 2000; assert.equal(squad.strikeTarget('ship', unit, seen(2050, 1)).region.top, 150 + FREE_FIRE_CLIMB);
  // The place it fires from is under that height: with no height to keep under, its machine gun would have it 380 m up.
  vehicle.y = 60;
  const gun = { x: 1000, y: 59, angle: -3 * Math.PI / 4, weaponPreset: 'm2hb', weaponMount: { min: -Math.PI / 4, max: Math.PI / 4 } },
    target = { x: 1000, y: 1, guns: [], region: { anchor: 1000, radius: FREE_FIRE_RADIUS } },
    free = squad.standoff('ship', gun, target, vehicle), kept = squad.standoff('ship', gun, { ...target, region: { ...target.region, top: 180 } }, vehicle);
  assert(free.height > 300 && free.top === Infinity, JSON.stringify(free));
  assert(kept.height <= 180 + 1e-9 && kept.height >= 10 && kept.top === 180 && Math.abs(kept.x - 1000) <= FREE_FIRE_RADIUS + 1e-6, JSON.stringify(kept));
});

test('a vehicle waiting at a works has a builder step out for it only while another stays building there on the ground, not one in the air over it', () => {
  const material = STOCK_IDS[0], asideOf = still => {
    const actors = ['lorry', 'b1', 'b2'].map(id => ({ id, team: 'red', ownerId: 'p' })), work = { id: 'w' }, left = [],
      dispatch = { room: { works: { pending: new Map([['w', work]]), need: () => ({ [material]: 10 }), span: () => ({ minX: 0, maxX: 20 }), beside: () => true },
        world: { actors, actor: id => actors.find(a => a.id === id) }, players: new Map([['p', { squad: { units: new Map([['lorry', { move: null }]]) } }]]),
        still: actor => still.includes(actor.id), record: () => ({ service: null }) },
      jobs: new Map([['lorry', { queued: true, kind: 'work', targetId: 'w', ownerId: 'p' }]]),
      stock: id => id === 'lorry' ? { [material]: 50 } : {}, arm: id => id !== 'lorry', manages: () => true, paused: new Set(), ordered: () => null,
      aside: actor => left.push(actor.id) };
    SupplyDispatch.prototype.makeRoom.call(dispatch);
    return left;
  };
  // The lorry brings what the works lacks; the first builder stands by it on the ground, the second hovers over it. The one on
  // the ground is the only builder there: it stays.
  assert.deepEqual(asideOf(['b1']), []);
  // The second come down beside it, there are two: one steps out.
  assert.deepEqual(asideOf(['b1', 'b2']), ['b1']);
});

// A field of Ana's and Bia's with no fog, where a faction has every enemy in sight: Ana's base at the middle and Bia's 12 km
// off. A place 2.5 km from Ana's base is neither's ground.
function open(t) {
  const f = onField(t, rehearsal([0, 12000], undefined, { fog: false })), { room } = f, ana = room.join('Ana'), bia = room.join('Bia');
  return { ...f, ana, bia, faction: room.faction(room.players.get(ana.playerId)), dispatch: room.supplyDispatch, x: 2500 };
}

test('the automatic holds no ground dangerous under an enemy aircraft whose guns do not reach down to it, and holds dangerous what they reach', { timeout: 60000 }, t => {
  const f = open(t), { world, ground, dispatch, faction, bia, x } = f, ship = f.publish(bia, gunship()), reach = Math.min(HAUL_SCARE, gunReach(world, ship));
  assert(reach > 300 && reach < 2000, `its guns reach ${reach} m`);
  // Bia holds it in hand over the place, `height` over the ground, its flight computer keeping it there; Ana takes in what she holds.
  const hover = height => {
    const place = () => world.command('setVehicleState', { actorId: ship, state: { x, y: ground.height(x) + height, vx: 0, vy: 0, angle: 0, omega: 0 } });
    place(); f.order(bia, 'control', { id: ship }); f.send(bia, 'drive', { throttle: 0, brake: 0, rise: 1 }); f.run(.2);
    f.send(bia, 'drive', { throttle: 0, brake: 0, rise: 0 }); place(); f.run(.5); dispatch.watch(faction);
    const v = world.actor(ship).vehicle;
    assert(v.flying && Math.abs(v.y - ground.height(v.x) - height) < 20, `${v.y - ground.height(v.x)} m up`);
    return v;
  };
  const along = [-700, -500, -250, 0, 250, 500, 700], perilous = dx => dispatch.perilous(faction, x + dx);
  // Two kilometres up, it endangers no ground under it: before, all within its reach along the field was held dangerous.
  hover(2000);
  assert.deepEqual(along.map(perilous), along.map(() => false));
  // 300 m up, it endangers the ground within its reach of it: under it, and less far along than its guns reach.
  const v = hover(300), apart = dx => Math.hypot(x + dx - v.x, ground.height(x + dx) - v.y);
  for (const dx of along) if (Math.abs(apart(dx) - reach) > 5) assert.equal(perilous(dx), apart(dx) <= reach, `${dx} m along, ${apart(dx)} m off`);
  assert(perilous(0) && !perilous(Math.sqrt(reach ** 2 - 250 ** 2) + 50), 'under it, and not as far along as its guns reach');
});

test('the automatic holds dangerous the ground about a gun its base placed on the ground, and none under one it placed in the air', { timeout: 60000 }, t => {
  const f = open(t), { room, world, ground, dispatch, faction, x } = f, marks = [];
  t.mock.method(room, 'batteryMarks', () => marks);
  f.run(.1);
  // A gun placed 2 km up over the place, as surely as the radar places one: out of reach of the ground by far.
  marks.push({ id: 'battery:1', kind: 'battery', x, y: ground.height(x) + 2000, error: 40, at: world.time, by: 'radar' });
  dispatch.watch(faction);
  assert.deepEqual([-300, 0, 300].map(dx => dispatch.perilous(faction, x + dx)), [false, false, false]);
  // One placed on the ground 1.5 km on: about it as far as a mark holds a worker and as far again as the place may be off by.
  f.run(.1);
  marks.push({ id: 'battery:2', kind: 'battery', x: x + 1500, error: 40, at: world.time, by: 'radar' });
  dispatch.watch(faction);
  assert.deepEqual([0, 300, 380].map(dx => dispatch.perilous(faction, x + 1500 + dx)), [true, true, false]);
  assert.equal(MARK_SCARE + 40, 340);
});
