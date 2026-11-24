import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { rough } from '../server/stock-wants.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { appraise, bill, billTotal, fieldParts, suppliesVolume, CALM_SECONDS, PAVING } from '../src/economy.ts';
import { cargoRoom, reserveState } from '../src/component-volume.ts';
import { componentReference } from '../src/component-size.ts';
import { unitsOf } from '../src/grid.ts';
import { onField } from './helpers/field.js';

// A field of one player whose stocks are what a test says, with the pieces of it a test looks at: what the faction is told of
// its stocks (`wants`), its vehicles out of the base where they stopped by an ordinary order, and their reserves and damage.
function field(t, stock = bill(1e7, 1e6, 1e6, 1e5)) {
  const room = rehearsal([12, 20000], stock), world = room.world, helpers = onField(t, room);
  const joined = room.join('Ana'), player = room.players.get(joined.playerId), faction = room.faction(player);
  const publish = source => helpers.publish(joined, typeof source === 'string' ? createStructuredTemplate(source) : source),
    part = (id, kind) => world.modules.find(piece => piece.actorId === id && piece.kind === kind),
    order = (o, data) => room.command(player.id, { type: 'squad', order: o, ...data }),
    deploy = (id, goal) => {
      order('move', { ids: [id], x: goal });
      assert(helpers.until(() => !player.squad.units.get(id).move && Math.abs(room.position(world.actor(id)) - goal) < 3 && room.still(world.actor(id)), 100),
        'the real vehicle drove out and stopped');
    },
    reserve = (id, kind, share) => {
      const key = kind === 'fuel' ? 'fuelLitres' : 'rounds', full = reserveState(world.actor(id).blueprint.modules.find(m => m.kind === kind))[key];
      helpers.set(part(id, kind), { [key]: Math.floor(full * share) });
    };
  return { ...helpers, room, world, player, faction, publish, part, deploy, reserve, order,
    wants: () => room.factionView(player.id).wants, quote: id => appraise(world.actor(id), fieldParts(world)),
    open: (model, how) => helpers.open(joined, model, how) };
}

test('three figures, never under what is missing', () => {
  assert.deepEqual([0, -3, .2, 1, 99.2, 102, 999.5, 1234, 45001, 999999].map(rough), [0, 0, 1, 1, 100, 102, 1000, 1240, 45100, 1000000]);
});

test('stocks that cover all there is to ask of them are told nothing', t => {
  const f = field(t), scout = f.publish('scout');
  f.deploy(scout, f.faction.base.x + 300);
  f.reserve(scout, 'ammo', .5); f.reserve(scout, 'fuel', .5);
  f.run(1);
  assert.deepEqual(f.wants(), {});
});

test('a works with nothing to put up stands still for a stock the free stocks have none of; one they still feed is only short of it', t => {
  const f = field(t), id = f.open('guard-post'), work = f.room.works.pending.get(id), cost = work.cost;
  assert(cost.ferro > 0, 'the post is paid in iron');
  f.faction.stock.ferro = 0; f.run(1);
  let wants = f.wants();
  assert.deepEqual(Object.keys(wants), ['ferro'], 'only the stock it lacks is told');
  assert.deepEqual(wants.ferro, { level: 'waiting', missing: rough(cost.ferro), for: [{ kind: 'work', n: 1, name: work.blueprint.name }] });
  f.faction.stock.ferro = Math.floor(cost.ferro / 2); f.run(1);
  wants = f.wants();
  assert.equal(wants.ferro.level, 'short', 'with some of it free the works is brought that, and stands still for nothing yet');
  assert.equal(wants.ferro.missing, rough(cost.ferro - Math.floor(cost.ferro / 2)));
  f.faction.stock.ferro = cost.ferro; f.run(1);
  assert.deepEqual(f.wants(), {}, 'with all of it free nothing is told');
});

test('a vehicle run low away from its base stands still for the rounds and the fuel the stocks pay none of', t => {
  const f = field(t), scout = f.publish('scout');
  f.deploy(scout, f.faction.base.x + 300);
  f.reserve(scout, 'ammo', 0); f.reserve(scout, 'fuel', .1);
  Object.assign(f.faction.stock, bill(0, 1e6, 1e6, 0)); f.run(CALM_SECONDS + 1);
  const quote = f.quote(scout), wants = f.wants();
  assert.deepEqual(wants.ferro, { level: 'waiting', missing: rough(quote.rearm.ferro), for: [{ kind: 'ammo', n: 1 }] });
  assert.deepEqual(wants.combustivel, { level: 'waiting', missing: rough(quote.rearm.combustivel), for: [{ kind: 'fuel', n: 1 }] });
  // A few litres free are brought to it: its tanks are then only short of what the stocks do not cover.
  f.faction.stock.combustivel = 5; f.run(1);
  assert.equal(f.wants().combustivel.level, 'short');
});

test('the fuel the fleet needs to fill its tanks, run low or not, is short of the stocks before anything stands still for it', t => {
  const f = field(t), scout = f.publish('scout');
  f.deploy(scout, f.faction.base.x + 300);
  f.reserve(scout, 'fuel', .6); f.faction.stock.combustivel = 10; f.run(1);
  const need = f.quote(scout).rearm.combustivel;
  assert(need > 10);
  assert.deepEqual(f.wants(), { combustivel: { level: 'short', missing: rough(need - 10), for: [{ kind: 'fuel', n: 1 }] } });
});

test('in its base a vehicle the stocks cannot fill up stands still for them', t => {
  const f = field(t), scout = f.publish('scout');
  f.faction.stock.combustivel = 0; f.reserve(scout, 'fuel', .9); f.run(CALM_SECONDS + 1);
  assert(f.room.atBase(f.faction, f.world.actor(scout)));
  assert.deepEqual(f.wants().combustivel, { level: 'waiting', missing: rough(f.quote(scout).rearm.combustivel), for: [{ kind: 'fuel', n: 1 }] },
    'not run low, but the base fills it up of itself, and has nothing to fill it with');
});

test('a road of asphalt with graded ground to pave and no mix for it, aboard or free, stands still for what the mix lacks', t => {
  const f = field(t, bill(1e9, 1e9, 1e9, 1e9)), paver = f.publish('paver'), a = f.faction.base.x + 110;
  f.room.pave(a, a + 30, 'graded'); f.faction.stock.silica = 0; f.run(1);
  f.send(f.player, 'road', { x0: a, x1: a + 30, kind: 'asphalt' });
  f.run(3);
  const wants = f.wants();
  assert.deepEqual(Object.keys(wants), ['silica'], 'Sílica alone is missing from the mix');
  assert.deepEqual(wants.silica, { level: 'waiting', missing: rough(PAVING.silica * 30), for: [{ kind: 'road', n: 1 }] });
});

// The supply pieces of a supply truck a quarter of their size, a sixty-fourth of their room: such a truck takes no more than a
// sliver of a repair, and the dispatch may say it waits for stock while the stocks have all of it.
function smallSupplier() {
  const model = createStructuredTemplate('supply');
  return { ...model, components: model.components.map(piece => piece.kind === 'supply' ? { ...piece, sizeScale: .25,
    pose: { ...piece.pose, y: piece.pose.y - unitsOf(componentReference(piece).height * ((piece.sizeScale ?? 1) - .25) / 2) } } : piece) };
}

test('a repair the free stocks pay whole stands still for nothing, however little the supply vehicle sent for it takes', t => {
  const f = field(t), truck = f.publish(smallSupplier()), scout = f.publish('scout');
  f.room.command(f.player.id, { type: 'auto', actorId: truck, on: true });
  f.deploy(scout, f.faction.base.x + 300);
  for (const kind of ['engine', 'command']) { const piece = f.part(scout, kind); f.set(piece, { health: piece.maxHealth * .1 }); }
  f.run(CALM_SECONDS + 1);
  const repair = f.quote(scout).repair, room = f.room.serving(truck).reduce((sum, piece) => sum + cargoRoom(piece), 0);
  assert(billTotal(repair) > 0 && suppliesVolume(repair) > room, 'the repair takes more room than the truck has');
  for (let i = 0; i < 20; i++) {
    f.run(1);
    assert.deepEqual(f.wants(), {}, 'the stocks have all the repair asks for: nothing stands still for them, nor is short');
  }
  // With no iron free, what it asks of iron stands still for it.
  f.faction.stock.ferro = 0; f.run(2);
  const wants = f.wants();
  assert.equal(wants.ferro?.level, 'waiting');
  assert.deepEqual(wants.ferro.for.map(item => item.kind), ['repair']);
});

test('each player is told the wants of its own faction alone', t => {
  const room = rehearsal([12, 20000], bill(0, 1e6, 1e6, 1e5)), helpers = onField(t, room);
  const ana = room.join('Ana'), bia = room.join('Bia');
  helpers.open(ana, 'guard-post'); helpers.run(1);
  assert.equal(room.factionView(ana.playerId).wants.ferro.level, 'waiting');
  assert.deepEqual(room.factionView(bia.playerId).wants, {}, 'the other faction lacks nothing, and is told nothing of Ana\'s');
});
