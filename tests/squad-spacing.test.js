import test from 'node:test';
import assert from 'node:assert/strict';
import { Squad, GAP, ROOM } from '../src/squad.ts';

// A field of vehicles standing where they are told, one vein and one base: what the squad reads of the field when it
// places its vehicles. A vehicle is the player's unless it says whose (`team`), as long as a common one unless it says
// how long it is (`length`, the one plate of its frame), and carries off what is dug at the vein unless it says it only
// digs it (`work`): then its place there is where its tool digs.
function field(vehicles) {
  const at = Object.fromEntries(Object.entries(vehicles).map(([id, v]) => [id, { vehicle: { x: v.x, vx: 0 },
    ...(v.length ? { blueprint: { plates: [{ x: 12, length: v.length, angle: 0 }] } } : {}) }]));
  return { world: { time: 0, actor: id => at[id], terrain: { minX: -2000, maxX: 2000 } }, roster: Object.entries(vehicles).map(([id, v]) => ({ id, team: v.team ?? 'local', role: 'armor' })),
    defeats: {}, input() {},
    deposit: (_id, actorId) => ({ x: 300, reach: 30, material: 'ferro', stilled: false,
      area: { lo: 271, hi: 329, goal: 285, ready: Math.abs((at[actorId]?.vehicle.x ?? 0) - 300) <= 30, digs: vehicles[actorId]?.work === 'digs' } }),
    veinAt: x => Math.abs(x - 300) <= 30 ? { x: 300, reach: 30 } : null,
    depot: () => ({ x: 0, radius: 100 }),
    role: id => vehicles[id]?.work ?? 'carries',
    load: () => ({ carried: 0, room: 1000 }), tipped: () => false };
}
const going = (squad, ...ids) => ids.map(id => squad.units.get(id).move?.x);
const APART = ROOM + GAP; // between the middles of two common vehicles, end to end with the gap between them

test('vehicles sent to one place, by one order or by several, each stop at a place of their own, nearest on the side each comes from', () => {
  const squad = new Squad(field({ a: { x: -100 }, b: { x: -90 }, c: { x: 200 } }));
  for (const id of ['a', 'b', 'c']) squad.command({ order: 'move', ids: [id], x: 50 });
  assert.deepEqual(going(squad, 'a', 'b', 'c'), [50, 50 - APART, 50 + APART]);
});

test('a place by one that stands there is the nearest just clear of it, on whichever side, as far as their lengths ask', () => {
  const squad = new Squad(field({ a: { x: 0 }, b: { x: -100 }, long: { x: 300, length: 11 } }));
  // Sent a little past the one that stands there, it stops just past it, not back on the side it comes from.
  squad.command({ order: 'move', ids: ['b'], x: 4 }); assert.deepEqual(going(squad, 'b'), [APART]);
  squad.command({ order: 'move', ids: ['b'], x: -4 }); assert.deepEqual(going(squad, 'b'), [-APART]);
  // A longer one keeps more room about it: half of each, and the gap.
  squad.command({ order: 'move', ids: ['b'], x: 296 }); assert.deepEqual(going(squad, 'b'), [300 - (11 + ROOM) / 2 - GAP]);
  assert.deepEqual([squad.room('long'), squad.room('a')], [11, ROOM]);
});

test('a place where a vehicle of the side stands is taken, whoever drives it; an enemy\'s is not the squad\'s to keep clear of', () => {
  const squad = new Squad(field({ a: { x: 0 }, b: { x: 100 }, ally: { x: 400, team: 'ally' }, foe: { x: -300, team: 'opponent' } }));
  squad.command({ order: 'move', ids: ['b'], x: 0 }); assert.deepEqual(going(squad, 'b'), [APART], 'a stands there');
  squad.command({ order: 'move', ids: ['b'], x: 400 }); assert.deepEqual(going(squad, 'b'), [400 - APART], 'so does a vehicle of an ally');
  squad.command({ order: 'move', ids: ['b'], x: -300 }); assert.deepEqual(going(squad, 'b'), [-300]);
  // The vehicle in the player's hands holds where it stands, and goes wherever it is driven: nobody places it.
  squad.command({ order: 'control', id: 'a' }); squad.command({ order: 'move', ids: ['b'], x: 3 }); assert.deepEqual(going(squad, 'b'), [APART]);
});

test('a line sent to a place keeps its order and its spacing, clear of what stands there', () => {
  const squad = new Squad(field({ a: { x: -100 }, b: { x: -90 }, c: { x: 0 } }));
  squad.command({ order: 'move', ids: ['b', 'a'], x: 0 });
  assert.deepEqual(going(squad, 'a', 'b'), [-APART, APART]);
  // Sent again where they already go, they keep their places: the line holds nothing against itself.
  squad.command({ order: 'move', ids: ['a', 'b'], x: 0 }); assert.deepEqual(going(squad, 'a', 'b'), [-APART, APART]);
  // On open ground the line stands end to end about the place, the gap between each two.
  const open = new Squad(field({ a: { x: -100 }, b: { x: -90, length: 11 }, c: { x: -80 } }));
  open.command({ order: 'move', ids: ['a', 'b', 'c'], x: 500 });
  assert.deepEqual(going(open, 'a', 'b', 'c'), [500 - 11 / 2 - GAP - ROOM / 2, 500, 500 + 11 / 2 + GAP + ROOM / 2]);
});

test('haulers of one vein load at places of their own within its reach, and unload at places of their own inside the base', () => {
  const squad = new Squad(field({ a: { x: 0 }, b: { x: 0 }, c: { x: 0 } }));
  squad.command({ order: 'haul', ids: ['a', 'b', 'c'], depositId: 'v' });
  for (const id of ['a', 'b', 'c']) squad.haul(id, squad.units.get(id));
  const out = going(squad, 'a', 'b', 'c');
  assert.deepEqual(out, [328.55, 328.55 - APART, 328.55 - 2 * APART]);
  assert(out.every(x => Math.abs(x - 300) <= 30), 'all of them load there');
  assert(out.every((x, i) => out.every((y, j) => i === j || Math.abs(x - y) >= APART - 1e-6)), 'their frames keep the gap');
  // Loaded, they go home together.
  for (const id of ['a', 'b', 'c']) { Object.assign(squad.units.get(id), { move: null }).haul.phase = 'home'; squad.side.world.actor(id).vehicle.x = 300; }
  for (const id of ['a', 'b', 'c']) squad.haul(id, squad.units.get(id));
  const home = going(squad, 'a', 'b', 'c');
  assert.deepEqual(home, [75, 75 + APART, 75 - APART]); assert(home.every(x => Math.abs(x) <= 100), 'all of them unload there');
});

test('vehicles moved onto a vein stop within its reach, each at a place of its own, by one order or by several', () => {
  const within = xs => xs.every(x => Math.abs(x - 300) <= 25);
  // Sent together to the edge of the vein, the line keeps to its reach instead of running past it.
  const together = new Squad(field({ a: { x: 0 }, b: { x: 10 }, c: { x: 20 } }));
  together.command({ order: 'move', ids: ['a', 'b', 'c'], x: 328 });
  const line = going(together, 'a', 'b', 'c');
  assert(within(line), String(line)); assert(line.every((x, i) => line.every((y, j) => i === j || Math.abs(x - y) >= APART - 1e-6)), String(line));
  // One after the other to the same place by the edge: the second stops clear of the first, inside the reach, not past it.
  const apart = new Squad(field({ a: { x: 0 }, b: { x: 10 } }));
  apart.command({ order: 'move', ids: ['a'], x: 322 }); apart.command({ order: 'move', ids: ['b'], x: 322 });
  assert.deepEqual(going(apart, 'a', 'b'), [322, 322 - APART]);
  // Away from any vein a place is where it was.
  apart.command({ order: 'move', ids: ['a'], x: 360 }); assert.deepEqual(going(apart, 'a'), [360]);
});

test('a full loading area queues the next hauler outside the material and gives it a bay when one is free', () => {
  const side = field({ a: { x: 0 }, b: { x: -10 }, c: { x: -20 }, d: { x: -30 }, e: { x: -40 } }), deposit = side.deposit;
  side.deposit = (id, actorId) => ({ ...deposit(id, actorId), area: { lo: 270, hi: 310, goal: 290, ready: false } });
  const squad = new Squad(side);
  squad.command({ order: 'haul', ids: ['a', 'b', 'c', 'd', 'e'], depositId: 'v' });
  for (const id of ['a', 'b', 'c', 'd', 'e']) squad.haul(id, squad.units.get(id));
  const bays = going(squad, 'a', 'b', 'c', 'd'), queued = squad.units.get('e');
  assert(bays.every(x => x >= 270 && x <= 310), 'four ordinary frames really fit this pickup interval');
  assert(bays.every((x, i) => bays.every((y, j) => i === j || Math.abs(x - y) >= APART - 1e-6)), 'all frames keep their gap');
  assert.equal(queued.haul.waiting, true); assert(queued.move.x < 270);
  assert.equal(new Set(going(squad, 'a', 'b', 'c', 'd', 'e')).size, 5, 'the queue does not stack vehicles');
  side.world.actor('e').vehicle.x = queued.move.x; queued.move = null;
  squad.units.get('a').move = { x: 1000 };
  squad.haul('e', queued);
  assert.equal(queued.haul.waiting, undefined); assert.equal(queued.move.x, 309.55);
});

test('a structure of the side holds no place: a hauler stops in it to take in what it digs, and only vehicles keep others clear', () => {
  const side = field({ a: { x: 0 }, b: { x: -10 } }), deposit = side.deposit, actor = side.world.actor;
  // A fixed post of the side on the vein, as long as a vehicle: it has no vehicle to drive.
  side.roster.push({ id: 'post', team: 'local', role: 'armor' });
  side.world.actor = id => id === 'post' ? { x: 300, blueprint: { plates: [{ x: 0, length: 6, angle: 0 }] } } : actor(id);
  side.deposit = (id, actorId) => ({ ...deposit(id, actorId), area: { lo: 295, hi: 305, goal: 300, ready: false, loads: true } });
  const squad = new Squad(side);
  squad.command({ order: 'haul', ids: ['a'], depositId: 'v' }); squad.haul('a', squad.units.get('a'));
  assert.equal(squad.units.get('a').haul.waiting, undefined, 'not “aguardando espaço na jazida” beside its own post');
  assert.deepEqual(going(squad, 'a'), [304.55]);
  squad.command({ order: 'move', ids: ['b'], x: 300 });
  assert.deepEqual(going(squad, 'b'), [304.55 - APART], 'the hauler bound there holds its place, the post none');
});

// A loading area of a vein as narrow as the one of a long lorry by a backhoe: the two of them end to end, and the gap,
// would not fit in it.
function narrow(vehicles) {
  const side = field(vehicles), deposit = side.deposit;
  side.deposit = (id, actorId) => { const site = deposit(id, actorId); return { ...site, area: { ...site.area, lo: 293, hi: 307, goal: 300, ready: false } }; };
  return side;
}
const haul = (squad, id) => { squad.command({ order: 'haul', ids: [id], depositId: 'v' }); squad.haul(id, squad.units.get(id)); return squad.units.get(id); };

test('a hauler sent to a vein a vehicle of the side only digs stops beside it, and a second hauler waits outside', () => {
  const squad = new Squad(narrow({ dig: { x: 300, work: 'digs' }, lorry: { x: 0, length: 10.6 }, other: { x: -20, length: 10.6 }, second: { x: -40, work: 'digs' } }));
  // Not “aguardando espaço no local de coleta”: it stops at the far end of its place, within what the digger would keep.
  assert.equal(haul(squad, 'lorry').haul.waiting, undefined);
  assert.deepEqual(going(squad, 'lorry'), [306.55]);
  assert(Math.abs(306.55 - 300) < (10.6 + ROOM) / 2 + GAP, 'beside the digger, across the field');
  // Two haulers keep apart: the second has no place left by the first, and waits outside the material, clear of both.
  const queued = haul(squad, 'other');
  assert.equal(queued.haul.waiting, true); assert(Math.abs(queued.move.x - (293 - 10.6 - GAP)) < 1e-9, String(queued.move.x));
  // So do two that only dig: the second keeps out of the place of the first, the haulers there leave it none.
  assert.equal(haul(squad, 'second').haul.waiting, true);
});

test('a vehicle that only digs, sent to a vein where an empty hauler waits for production, digs beside it', () => {
  const squad = new Squad(narrow({ lorry: { x: 300, length: 10.6 }, dig: { x: -40, work: 'digs' } }));
  Object.assign(squad.units.get('lorry'), { haul: { depositId: 'v', material: 'ferro', phase: 'load' } });
  assert.equal(haul(squad, 'dig').haul.waiting, undefined);
  assert.deepEqual(going(squad, 'dig'), [300], 'where its tool digs, under the lorry');
});

test('a hauler moved onto a vein stops where it is sent beside one that only digs there, and clear of another hauler', () => {
  const side = field({ dig: { x: 300, work: 'digs' }, lorry: { x: 0 }, other: { x: -10 } });
  side.veinAt = x => Math.abs(x - 300) <= 30 ? { id: 'v', x: 300, reach: 30 } : null;
  const squad = new Squad(side);
  squad.command({ order: 'move', ids: ['lorry'], x: 300 }); assert.deepEqual(going(squad, 'lorry'), [300]);
  squad.command({ order: 'move', ids: ['other'], x: 300 }); assert.deepEqual(going(squad, 'other'), [300 - APART]);
});

test('there is no escort order: the squad refuses it and keeps no such order', () => {
  const squad = new Squad(field({ lead: { x: 0 }, a: { x: -50 } }));
  assert.throws(() => squad.command({ order: 'escort', ids: ['a'], targetId: 'lead' }), /^Error: Ordem desconhecida\.$/);
  assert.equal('escort' in squad.units.get('a'), false); assert.equal('escort' in squad.view().units[0], false);
});
