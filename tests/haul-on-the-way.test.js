import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { BASE_RADIUS, LOAD_REACH, RAW, SUPPLIED, bill, billTotal, carriedBy, loadTotal, stow, supplied } from '../src/economy.ts';
import { cargoRoom, cargoUnitVolume } from '../src/component-volume.ts';
import { jobText } from '../src/faction-ui.ts';
import { onField } from './helpers/field.js';

// A vehicle in automatic on its way home with room to spare takes on what is ready by its way: real vehicles of the
// catalogue on the real field, driven by their own pilots. Only the piles out of the ground and the heaps are set by hand.

// A field with its base `gap` metres short of a site (`near`), with another a little past it (`next`) and a third far past
// that (`far`), and no site by the base. What reaches the base yard is counted, delivery by delivery.
function field(t, gap = 1500) {
  let base;
  const room = new SharedRoom({ starter: false, build: false, fog: false, stock: bill(1e9, 1e9, 1e9, 1e9), base: () => base }),
    world = room.world, solid = room.deposits.filter(site => site.material !== 'petroleo'), center = world.terrain.center;
  let sites = null;
  for (const near of solid.slice().sort((a, b) => Math.abs(a.x - center) - Math.abs(b.x - center))) {
    const next = solid.find(site => site.x - near.x >= 80 && site.x - near.x <= 300),
      far = next && solid.find(site => site.x - next.x >= 2500 && site.x - next.x <= 4000), x = Math.round(near.x - gap);
    if (!far || x < room.limits.minX + 1000 || room.deposits.some(site => Math.abs(site.x - x) < BASE_RADIUS + 2 * LOAD_REACH)) continue;
    sites = { near, next, far }; base = x; break;
  }
  assert(sites, 'the ground has such sites');
  const f = onField(t, room), owner = room.players.get(room.join('Coletor').playerId), faction = room.faction(owner),
    deliveries = [], deliver = room.deliverCargo.bind(room);
  room.deliverCargo = (into, actor) => { const moved = deliver(into, actor); if (loadTotal(moved) > 0) deliveries.push(loadTotal(moved)); return moved; };
  room.command(owner.id, { type: 'squad', order: 'control', id: null });
  return { ...f, room, world, owner, faction, sites, deliveries, base, pile: site => room.extracted.get(site.id) ?? 0,
    ready: (site, stock) => { room.veins.set(site.id, 1000); room.extracted.set(site.id, stock); },
    truck: () => f.publish(owner, 'truck') };
}

test('a truck that empties a pile with room to spare takes on the pile just past it by its way home, but not one far off it', { timeout: 90000 }, t => {
  const f = field(t), { room, sites: { near, next, far }, deliveries } = f;
  f.ready(near, 2000); f.ready(next, 4000); f.ready(far, 2000);
  const id = f.truck(), told = [];
  assert(f.until(() => {
    const view = room.supplyDispatch.view(id);
    if (view.passing && !told.some(seen => seen.targetId === view.targetId)) told.push(view);
    return deliveries.length > 0;
  }, 900), 'the truck brought a load home');
  assert(Math.abs(deliveries[0] - 6000) < 1, `both piles by its way came home in one trip (${deliveries[0]})`);
  assert.equal(f.pile(far), 2000, 'the pile far off its way was left for a trip of its own');
  assert.equal(told.length, 1);
  const [taken] = told, site = taken.targetId === next.id ? next : near;
  assert.equal(taken.passing, site.material);
  assert.equal(jobText({ auto: true, job: taken }), `pegando ${RAW[site.material]} no caminho`, 'it says what it takes on by the way');
  assert(f.until(() => deliveries.length > 1, 1200), 'and then it goes for the far one');
  assert(Math.abs(deliveries[1] - 2000) < 1 && f.pile(far) === 0);
  assert.equal(room.faults.size, 0);
});

test('a truck taking a load home with room to spare takes on a ready pile on its way', { timeout: 90000 }, t => {
  const f = field(t), { room, world, sites: { near }, deliveries } = f, id = f.truck();
  room.supplyDispatch.set(id, false);
  // Out past the pile with ore of its own aboard, it is put back in automatic.
  f.put(id, near.x + 600);
  const hoppers = room.pieces(id).filter(piece => piece.kind === 'hopper');
  room.carry(stow(hoppers, near.material, 1500).changed);
  f.ready(near, 2500);
  room.supplyDispatch.set(id, true);
  assert(f.until(() => deliveries.length > 0, 600), 'it went home');
  assert(Math.abs(deliveries[0] - 4000) < 1, `it brought the pile on its way with its own load (${deliveries[0]})`);
  assert.equal(f.pile(near), 0);
  assert(world.actor(id).vehicle.fuelLitres > 0);
});

test('a supply truck taking stocks home takes on a heap of its faction by its way, and says so; one off its way it goes on to as to any heap', { timeout: 90000 }, t => {
  const f = field(t), { room, faction, base, owner } = f, id = f.publish(owner, 'supply'),
    carried = () => supplied(carriedBy(room.serving(id)).carried);
  room.supplyDispatch.set(id, false);
  f.put(id, base + 1800);
  const crates = room.serving(id), units = crates.reduce((sum, piece) => sum + cargoRoom(piece), 0) / cargoUnitVolume(SUPPLIED.ferro);
  for (const piece of crates) f.set(piece, { cargo: {} });
  room.carry(stow(crates, SUPPLIED.ferro, Math.floor(units / 5)).changed);
  const aboard = billTotal(carried()), heap = Math.floor(units / 5);
  assert(room.works.heap('near', faction.id, base + 900, bill(heap)) && room.works.heap('far', faction.id, base + 3000, bill(heap)) && aboard > 0);
  const before = faction.stock.ferro, told = new Map();
  room.supplyDispatch.set(id, true);
  let home = false;
  assert(f.until(() => {
    const view = room.supplyDispatch.view(id), truck = room.world.actor(id);
    if (view.kind === 'heap' && !told.has(view.targetId)) told.set(view.targetId, view);
    home ||= room.atBase(faction, truck) && room.works.heaps.size > 0;
    return !room.works.heaps.size && room.atBase(faction, truck) && room.still(truck) && !billTotal(carried());
  }, 900), 'it took both heaps home');
  assert(Math.abs(faction.stock.ferro - before - aboard - 2 * heap) < 1, 'with what it carried');
  assert.equal(told.get('near')?.passing, 'supplies', 'the heap by its way is taken on by the way');
  assert.equal(jobText({ auto: true, job: told.get('near') }), 'pegando o material de um monte no caminho');
  assert(told.has('far') && !told.get('far').passing && !home, 'the one off its way it went on to from there, as to any heap');
  assert.equal(jobText({ auto: true, job: told.get('far') }), 'buscando o material de um monte');
});

// What the player asks of a vehicle in automatic comes first: a haul to a pile it was told goes on as told, a pile it was
// left by is its own to take on, and a trickle taken on there is no load to take home by the way.

test('a truck in automatic the player sent to a pile loads there even once the field was kept and taken up again on its way', { timeout: 90000 }, t => {
  const f = field(t), { room, owner, sites: { near, far } } = f, id = f.truck();
  f.ready(near, 30000); f.ready(far, 20000);
  room.command(owner.id, { type: 'squad', order: 'haul', ids: [id], depositId: near.id });
  f.run(20);
  assert.equal(owner.squad.units.get(id).haul?.phase, 'out', 'on its way there');
  const kept = JSON.parse(JSON.stringify(room.keep())), again = new SharedRoom({ kept, starter: false, build: false, fog: false });
  onField(t, again);
  const player = again.players.get(again.join('Coletor', owner.token).playerId), cargo = () => loadTotal(carriedBy(again.pieces(id)).carried);
  assert.equal(again.record(again.world.actor(id)).auto, true);
  let held = true;
  for (let i = 0; i < 300 * 60 && !(cargo() > 1000); i++) { again.step(); held &&= again.supplyDispatch.view(id).phase === 'paused'; }
  assert(cargo() > 1000, `it loads the pile it was sent to (${cargo().toFixed(0)})`);
  assert(held && !again.supplyDispatch.jobs.has(id), 'held by the order all along');
  assert.equal(player.squad.units.get(id).haul?.depositId, near.id);
  assert.equal(again.extracted.get(far.id), 20000);
});

test('a truck in automatic the player left by a pile takes on that pile, not one far past it', { timeout: 90000 }, t => {
  const f = field(t), { room, owner, sites: { near, far } } = f, id = f.truck();
  f.ready(near, 30000); f.ready(far, 20000);
  room.command(owner.id, { type: 'squad', order: 'move', ids: [id], x: near.x });
  let job = null;
  assert(f.until(() => (job = room.supplyDispatch.jobs.get(id)) !== undefined, 300), 'its order carried out, it is given a job');
  assert.equal(job.kind, 'haul'); assert.equal(job.targetId, near.id, 'the pile it stands by');
  assert.equal(room.supplyDispatch.view(id).passing, undefined);
  assert(f.until(() => f.deliveries.length > 0, 600), 'and it takes a load of it home');
  assert.equal(f.pile(far), 20000);
});

test('a trickle aboard is no load to take home: such a truck goes for a pile as an empty one, and a haul home only from a spent pile is free for one by the way', { timeout: 90000 }, t => {
  const f = field(t), { room, sites: { near, far } } = f, id = f.truck(), dispatch = room.supplyDispatch,
    hoppers = room.pieces(id).filter(piece => piece.kind === 'hopper');
  dispatch.set(id, false);
  f.put(id, near.x + 200);
  // A hundredth of what it takes, as a moment of loading leaves.
  room.carry(stow(hoppers, near.material, dispatch.emptySpace(room.world.actor(id), near) / 100).changed);
  f.ready(far, 20000);
  dispatch.set(id, true);
  assert(f.until(() => dispatch.jobs.has(id), 10));
  const view = dispatch.view(id);
  assert.equal(view.targetId, far.id);
  assert.equal(view.passing, undefined, 'not "by the way": it goes for it as an empty truck does');
  assert.equal(jobText({ auto: true, job: view }), 'indo recolher material pronto');
  // Sent home from a pile left with room to spare — out of its reach, say —, its haul is free for nothing else.
  dispatch.cancel(id); f.ready(near, 30000); room.supplyDispatch.set(id, false); f.put(id, near.x + 40); room.supplyDispatch.set(id, true);
  const demand = { kind: 'haul', id: near.id, x: near.x, key: 'haul:' + near.id, weight: 1, site: { ...near, stock: 30000 } },
    man = dispatch.crewman(room.world.actor(id));
  dispatch.start(man, demand, dispatch.offer(man, demand, f.faction), f.faction);
  const haul = dispatch.jobs.get(id).haul;
  haul.phase = 'home';
  assert.equal(dispatch.homing(id), false, 'its pile is still there');
  f.ready(near, 0);
  assert.equal(dispatch.homing(id), true, 'its pile ran out');
});
