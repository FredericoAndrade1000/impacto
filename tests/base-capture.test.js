import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal, SharedRoom } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { pieceCost } from '../src/construction-cost.ts';
import { depositsNear } from '../src/deposits.ts';
import { onField } from './helpers/field.js';
import { STARTING_STOCK, STOCK_IDS, RAW_IDS, CAPTURE_SECONDS, CALM_SECONDS, SHELTER_AWAY, BASE_SHARE, LOOT_SHARE, BASE_RADIUS, LOAD_REACH, UNBASED, captureAt, bill, billSum, billText, load, loadText,
  appraise, fieldParts, carriedBy, supplied, refined, designBill, stow } from '../src/economy.ts';
import { captureBar, fellText, takenText, recoveryText, recoveredText, SIEGE_NEWS } from '../src/faction-ui.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';

// A field of factions founded where a rehearsal puts them — Ana's base at -100 and Bia's at 60, which overlap between
// -40 and 0, and Caio's, when he comes, at 160, which reaches Bia's between 60 and 160 —, each with stocks to fabricate
// from. A faction that establishes a base again does so at 5000. Every base may be taken from the day it is founded.
function field(t, ...names) {
  const bases = [[-100, 60, 160].slice(0, names.length), 5000].flat(), f = onField(t, rehearsal(bases, STARTING_STOCK)), room = f.room;
  const players = names.map(name => room.join(name)), faction = player => room.faction(room.players.get(player.playerId));
  for (const player of players) Object.assign(faction(player).stock, bill(1e7, 1e6, 1e6, 1e5));
  return { room, world: room.world, players, faction, send: f.send, run: f.run, put: f.put, parts: f.parts, set: f.set,
    publish: (player, model, x, facing = 1) => f.send(player, 'spawn', { blueprint: createStructuredTemplate(model), x, facing }).actor.id,
    view: player => room.factionView(player.playerId),
    // How far the capture of a faction's base has gone now, or nothing while none goes on.
    gone: player => { const capture = faction(player).capture; return capture && captureAt(capture, room.world.time); },
    // Takes a faction's base at the next look over it: its capture is as good as done.
    finish: player => { Object.assign(faction(player).capture, { progress: CAPTURE_SECONDS - .5, at: room.world.time }); } };
}
// What a player's page says as it comes about, from the faction the field tells it: a page with nothing of its own on the field.
function page(room, player) {
  const memo = {};
  return () => {
    const time = room.world.time, faction = room.factionView(player.playerId),
      state = { shared: true, time, localPlayerId: player.playerId, players: [], plates: [], modules: [], actors: [], squad: null },
      panel = fieldPanel({ tab: 'test', shared: true, connected: true, state, faction, playerId: player.playerId }),
      said = fieldNotices(memo, panel.watch, time);
    return { said, grave: memo.grave, panel };
  };
}
// What a faction has, stock by stock, as it stands: its stocks, what waits in its yard as the stock it is refined into, and
// of each construction of its members on the field what capture returns, what its pieces carry and what a
// repair under way was paid with.
function captureHoldings(room, f) {
  const parts = fieldParts(room.world), total = billSum(f.stock, supplied(f.yard));
  for (const actor of room.enlisted(f)) {
    const record = room.records.get(actor.id);
    for (const amounts of [appraise(actor, parts, { damagedShare: 1 }).salvage, supplied(carriedBy(room.holds(actor.id)).carried), record.service?.cost ?? bill()])
      for (const id of STOCK_IDS) total[id] += amounts[id];
  }
  return total;
}
const close = (a, b, what) => { for (const id of STOCK_IDS) assert(Math.abs(a[id] - b[id]) < 1e-6, `${what}: ${id} ${a[id]} ≠ ${b[id]}`); };
const lorryBill = () => designBill(compileStructuredConstruction(createStructuredTemplate('mining-truck')));

test('a faction that stands armed alone in the base of another takes it a second a second, and whatever of the base stands armed there holds it, made before or since', t => {
  const { room, world, players: [ana, bia], faction, send, run, publish, view, gone } = field(t, 'Ana', 'Bia');
  // Bia's scout is turning about as Ana's comes into her base: held so, it holds nothing, and her lorry has no gun. The capture begins.
  const guard = publish(bia, 'scout', 20, -1);
  publish(bia, 'truck', 100, -1);
  send(bia, 'squad', { order: 'turn', ids: [guard] });
  const raider = publish(ana, 'scout', -30, 1), ears = page(room, bia);
  ears();
  run(2);
  const capture = faction(bia).capture;
  assert.deepEqual(capture, { by: faction(ana).id, progress: 0, at: capture.at, state: 'advancing' });
  assert(Math.abs(gone(bia) - 2) < .2, `${gone(bia)} s of it`);
  // Bia is told at once, by the alarm of bad news, what to do about it and what holds the base; and over her field, how
  // long is left and that it goes on.
  const told = ears();
  assert.deepEqual([told.said.at(-1), told.grave], [SIEGE_NEWS, true]);
  assert.match(SIEGE_NEWS, /Um veículo armado seu no chão da base segura a contagem\.$/);
  assert.match(captureBar(view(bia), world.time).text, /^Base sendo tomada · 4:5\d · avançando$/);
  assert.equal(captureBar(view(bia), world.time).hint, 'Destrua os veículos armados inimigos na base.');
  assert.match(captureBar(view(ana), world.time).text, /^Tomando a base da facção de Bia · 4:5\d · avançando$/);
  // Turned about, the scout holds the base. The capture stands still.
  run(6);
  const held = gone(bia);
  assert.equal(capture.state, 'contested'); assert(held > 4 && held < 8, `${held} s of it`);
  run(3);
  assert.equal(gone(bia), held, 'contested, it stands still');
  assert.deepEqual(view(bia).siege, { progress: held, at: capture.at, state: 'contested' });
  assert.deepEqual(view(ana).taking.map(({ id, name, state, sheltered }) => [id, name, state, sheltered]), [[faction(bia).id, 'Bia', 'contested', false]]);
  assert.match(captureBar(view(ana), world.time).text, /· disputada$/);
  assert.deepEqual(ears().said, [], 'a capture under way is told once');
  // The scout is lost, and the capture goes on.
  room.wreck(world.actor(guard));
  run(2);
  assert.equal(capture.state, 'advancing');
  // A scout fabricated in the base since the capture began holds it as well, once it is built: it stands there armed.
  const fresh = publish(bia, 'scout', 40, -1);
  run(2);
  assert.equal(capture.state, 'contested');
  const still = gone(bia);
  run(2);
  assert.equal(gone(bia), still);
  // Turning about it holds nothing while it turns, and holds the base again once it has turned.
  send(bia, 'squad', { order: 'turn', ids: [fresh] });
  run(2);
  assert.equal(capture.state, 'advancing');
  run(5);
  assert.equal(capture.state, 'contested');
  // Ana's scout is lost: the capture goes back, a second a second, down to nothing, and is over.
  const before = gone(bia);
  room.wreck(world.actor(raider));
  run(2);
  assert.equal(capture.state, 'receding'); assert(gone(bia) < before - 1);
  assert.match(captureBar(view(bia), world.time).text, /· recuando$/);
  Object.assign(capture, { progress: 1, at: world.time });
  run(2);
  assert.deepEqual([faction(bia).capture, view(bia).siege, view(ana).taking, captureBar(view(bia), world.time)], [null, null, [], null]);
});

test('a base two other factions stand armed in is contested, and a capture is of one faction: another waits for it to go back to nothing', t => {
  const { room, world, players: [ana, bia, caio], faction, run, publish, view, gone } = field(t, 'Ana', 'Bia', 'Caio');
  const theirs = publish(caio, 'scout', 110, -1), ours = publish(ana, 'scout', -30, 1);
  run(1.5);
  assert.equal(faction(bia).capture, null, 'contested, none begins');
  for (const player of [ana, caio]) assert.deepEqual(view(player).taking.map(({ state, progress, sheltered }) => [state, progress, sheltered]), [['contested', 0, false]]);
  room.wreck(world.actor(theirs));
  run(1.5);
  const capture = faction(bia).capture;
  assert.deepEqual([capture.by, capture.state], [faction(ana).id, 'advancing']);
  // Caio comes again: the capture stands still.
  publish(caio, 'scout', 120, -1);
  run(1.5);
  assert.equal(capture.state, 'contested');
  // Ana's scout is lost: her capture goes back, though Caio stands there alone, and his begins only once hers is over.
  room.wreck(world.actor(ours));
  run(1.5);
  assert.deepEqual([faction(bia).capture.by, capture.state, view(caio).taking[0].state, view(caio).taking[0].progress], [faction(ana).id, 'receding', 'contested', 0]);
  assert.deepEqual(view(ana).taking.map(({ state }) => state), ['receding'], 'Ana is told hers goes back');
  Object.assign(capture, { progress: .5, at: world.time });
  run(2.5);
  assert.deepEqual([faction(bia).capture.by, faction(bia).capture.state], [faction(caio).id, 'advancing']);
  assert(gone(bia) < 2.5);
});

test('a base is taken from the day it is founded; a sheltered one by nobody, and whoever stands armed in it is told why', t => {
  const { room, world, players: [ana, bia], faction, run, publish, view } = field(t, 'Ana', 'Bia');
  // Bia is away, and has been long enough, with no fighting: her base is sheltered at the next look.
  room.disconnect(bia.playerId); faction(bia).away = world.time - SHELTER_AWAY;
  run(.1);
  assert(faction(bia).shelter > world.time - .2, 'sheltered');
  publish(ana, 'scout', -30, 1);
  run(1.5);
  assert.equal(faction(bia).capture, null);
  assert.deepEqual(view(ana).taking.map(({ name, state, progress, sheltered }) => [name, state, progress, sheltered]), [['Bia', 'contested', 0, true]]);
  assert.deepEqual(captureBar(view(ana), world.time), { own: false, share: 0, text: 'Base da facção de Bia protegida: ninguém dela está no campo', hint: '' });
  // Bia comes back: her base is sheltered no longer, and it begins, two seconds after the field began.
  assert.equal(room.join('Bia', bia.token).faction.siege, null, 'Bia is told nothing: nothing was happening to her base');
  assert.equal(faction(bia).shelter, null);
  run(1.5);
  assert.equal(faction(bia).capture.state, 'advancing'); assert(world.time < 4, `${world.time} s after the base was founded`);
});

test('capture returns the remaining integrity of damaged pieces, while voluntary dismantling keeps its damaged-piece discount', t => {
  const { room, world, players: [ana, bia], faction, send, run, put, parts, set, publish, finish } = field(t, 'Ana', 'Bia');
  const voluntary = publish(bia, 'mining-truck', 80);
  send(bia, 'squad', { order: 'control', id: voluntary });
  run(1);
  const engineCost = pieceCost(world.actor(voluntary).blueprint.modules.find(m => m.kind === 'engine')),
    [engine] = parts(voluntary, 'engine');
  set(engine, { health: engine.maxHealth * .4 });
  run(CALM_SECONDS + 1);
  send(bia, 'cancel-repair', { actorId: voluntary });
  const refund = send(bia, 'remove', { actorId: voluntary }).refund;
  // The same damage on another miner, away from its base and any vein, survives until the base is taken.
  const captured = publish(bia, 'mining-truck', 100),
    bare = [1200, 1500, 1800, 2100, 2400, 2700].find(x => !depositsNear(room.deposits, x, 2 * LOAD_REACH).length);
  assert.notEqual(bare, undefined, 'clear ground for the captured miner');
  put(captured, bare);
  const [otherEngine] = parts(captured, 'engine');
  set(otherEngine, { health: otherEngine.maxHealth * .4 });
  const raider = publish(ana, 'scout', -30);
  send(ana, 'squad', { order: 'stance', ids: [raider], stance: 'hold' });
  run(1.5); finish(bia);
  for (let i = 0; i < 180 && !faction(bia).fell; i++) room.step();
  const fallen = faction(bia).fell;
  assert(fallen, 'the base was taken');
  assert.equal(fallen.dismantled, 1);
  // At 40% integrity, capture returns 40% of the engine; voluntary removal returns 20%.
  // Derive the difference from the installed piece price, independently of the appraisal under test.
  assert(Math.abs(fallen.returned.ferro - refund.ferro - engineCost * .2) <= 1,
    `capture ${fallen.returned.ferro}, voluntary ${refund.ferro}, engine ${engineCost}`);
});

test('a base taken is lost: all its faction had on the field is dismantled wherever it stood, and a quarter of what it has above a new faction, and of its yard, goes to the one that took it', t => {
  const { room, world, players: [ana, bia], faction, send, run, put, parts, set, publish, view, finish } = field(t, 'Ana', 'Bia');
  const raider = publish(ana, 'scout', -30, 1), lorry = publish(bia, 'truck', 100, -1), miner = publish(bia, 'mining-truck', 140, -1),
    supply = publish(bia, 'supply', 120, -1), tank = publish(bia, 'heavy', 80, -1), ears = { ana: page(room, ana), bia: page(room, bia) };
  // Bia's lorry is mended at her base; her miner waits far from any vein with ore in its hopper, her supply truck with
  // supplies aboard, and her tank, hit, far out where it holds nothing of the base.
  const bare = x => !depositsNear(room.deposits, x, 2 * LOAD_REACH).length, far = [1200, 1500, 1800, 2100, 2400, 2700].filter(bare);
  put(miner, far[0]); put(supply, far[1]); put(tank, far[2]);
  room.carry(stow(room.pieces(miner), 'ferro', 2000).changed); room.carry(stow(room.pieces(miner), 'silica', 300).changed);
  room.carry(stow(room.crates(supply), 'ferro', 1500).changed); room.carry(stow(room.crates(supply), 'petroleo', 120).changed);
  const [engine] = parts(tank, 'engine'), [cab] = parts(lorry, 'command');
  set(engine, { health: engine.maxHealth * .4 }); set(cab, { health: cab.maxHealth * .5 });
  // Ana's scout holds its fire: what it fired would be paid back to it from her stocks.
  send(ana, 'squad', { order: 'stance', ids: [raider], stance: 'hold' });
  run(12);
  assert.equal(room.records.get(lorry).service?.kind, 'repair', 'the lorry is under repair, paid for at its base');
  ears.ana(); ears.bia();
  // What Bia has in her stocks: more iron, silica and fuel than a faction is founded with, less of the alloys; and ore and petroleum in her yard.
  Object.assign(faction(bia).stock, bill(120000, 4000, 25000, 2500)); Object.assign(faction(bia).yard, load(5000, 0, 800, 600));
  const ids = [lorry, miner, supply, tank], base = faction(bia).base.x;
  finish(bia);
  let had;
  while (!faction(bia).fell) { had = { ana: billSum(faction(ana).stock, supplied(faction(ana).yard)), bia: captureHoldings(room, faction(bia)) }; room.step(); }
  const { fell } = faction(bia), taken = faction(ana).taken;
  // All four are off the field, dismantled — none is left a wreck —, and the base is gone: Bia has none, and nothing is taking it.
  assert(ids.every(id => !world.actor(id) && !room.records.has(id)));
  assert.deepEqual([faction(bia).base, faction(bia).capture, room.base(room.players.get(bia.playerId)), room.owned(bia.playerId)], [null, null, null, []]);
  assert(world.actor(raider), 'and Ana stays where she is, with no second base');
  // The looting took a quarter of what the stocks held above a new faction's, stock by stock — none of the alloys, below
  // it —, and a quarter of what waited in the yard, in whole units: of what was there once all four were dismantled.
  for (const id of STOCK_IDS)
    assert.equal(fell.stock[id], Math.floor(LOOT_SHARE * Math.max(0, faction(bia).stock[id] + fell.stock[id] - STARTING_STOCK[id])), id);
  for (const id of RAW_IDS) assert.equal(fell.yard[id], Math.floor(LOOT_SHARE * (faction(bia).yard[id] + fell.yard[id])), id);
  assert.equal(fell.stock.ligas, 0); assert(fell.stock.ferro > 7500 && fell.yard.ferro > 1500, 'the iron of the stocks and of the ore aboard');
  assert.deepEqual(taken, { at: fell.at, of: faction(bia).id, dismantled: 4, stock: fell.stock, yard: fell.yard });
  // Nothing is made and nothing lost: what Bia had — her stocks, her yard and what capture returns of all she had on the
  // field, with the repair she paid for and never had — she has, but for what Ana took, which Ana has more.
  const now = { ana: billSum(faction(ana).stock, supplied(faction(ana).yard)), bia: billSum(faction(bia).stock, supplied(faction(bia).yard)) },
    loot = billSum(fell.stock, supplied(fell.yard));
  close(now.ana, billSum(had.ana, loot), 'Ana');
  close(now.bia, billSum(had.bia, loot, -1), 'Bia');
  // The ore aboard the miner is in the yard, still to be refined, less the quarter taken; it waits for a base to refine it.
  assert.deepEqual([fell.dismantled, fell.from, fell.by, fell.cargo], [4, base, faction(ana).id, load(2000, 0, 300, 0)]);
  const yard = { ...faction(bia).yard };
  run(3);
  assert.deepEqual(faction(bia).yard, yard, 'no base, no refinery');
  // Bia is told, as bad news, by whom, what dismantling gave back and what the looting took, and what to do; Ana, whose base
  // she took and what came of it.
  const fellWords = fellText(view(bia)), pit = loadText(fell.yard);
  assert.equal(fellWords, `Sua base foi tomada pela facção de Ana. 4 construções desmontadas: ${billText(fell.returned)} de volta aos estoques e Ferro 2.000 + Sílica 300 ao pátio. ` +
    `Saque: ${billText(fell.stock)} e ${pit} do pátio. Estabeleça outra base no painel do campo.`);
  assert.match(billText(fell.stock), /^Ferro [\d.]+ \+ Sílica [\d.]+ \+ Combustível [\d.]+ L$/);
  const heard = { bia: ears.bia(), ana: ears.ana() };
  assert.deepEqual([heard.bia.said, heard.bia.grave], [[fellWords], true]);
  assert.equal(takenText(view(ana)), `Base da facção de Bia tomada · 4 construções desmontadas · saque: ${billText(fell.stock)} para os estoques e ${pit} para o pátio.`);
  assert.deepEqual([heard.ana.said.at(-1), heard.ana.grave], [takenText(view(ana)), false]);
  assert(!heard.ana.said.some(words => words.includes('perdeu a base')), 'the base taken says it all: that Bia lost it is not said twice');
  assert.deepEqual([view(ana).taking, view(bia).siege], [[], null]);
  // To Ana, who had met her, Bia lost her base then, and is nowhere she knows of; nor is her base.
  assert.equal(view(ana).known.find(f => f.id === faction(bia).id).defeated, fell.at);
  assert.deepEqual(view(ana).bases.filter(b => b.id === faction(bia).id), []);
  // Bia's panel says she has no base, and offers to establish one, at a quarter of each stock a faction is founded with;
  // with no base nothing is fabricated.
  const panel = heard.bia.panel;
  assert.deepEqual([panel.empty, panel.emptyText, panel.recover], [true, 'Sua facção está sem base: tomada pela facção de Ana.', 'Estabelecer base']);
  assert.equal(panel.recovery, 'Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L.');
  assert.deepEqual(view(bia).recovery, { base: bill(...STOCK_IDS.map(id => STARTING_STOCK[id] * BASE_SHARE)), lorry: null, reserve: 0, aid: bill(), offered: true });
  assert.throws(() => send(bia, 'spawn', { blueprint: createStructuredTemplate('scout'), x: 60 }), new RegExp(`^Error: ${UNBASED}$`));
});

test('a faction with no base establishes another, paid with its stocks: drawn far from every base and from the one it lost, with iron and petroleum about it, and taken like any other', t => {
  // Ana's base, Bia's beside it, and the rest drawn as for any faction that comes.
  const bases = [-100, 60], f = onField(t, new SharedRoom({ stock: STARTING_STOCK, build: false, starter: false, base: i => bases[i] ?? null })),
    { room } = f, [ana, bia] = ['Ana', 'Bia'].map(name => room.join(name)), faction = player => room.faction(room.players.get(player.playerId)),
    ears = page(room, bia);
  Object.assign(faction(ana).stock, bill(1e7, 1e6, 1e6, 1e5));
  const raider = f.publish(ana, 'scout', { x: -30, facing: 1 });
  f.run(1.5);
  Object.assign(faction(bia).capture, { progress: CAPTURE_SECONDS - .5, at: room.world.time });
  f.until(() => faction(bia).fell, 3);
  ears();
  // An older subsidized event must not prevent paying for a base, nor lose its real aid date when the paid event is kept.
  const aidAt = room.world.time - 1;
  faction(bia).recovered = { at: aidAt, base: null, from: null, lorry: true, aid: bill(1) }; ears();
  assert.equal(room.recovery(faction(bia)).offered, true); assert.deepEqual(room.recovery(faction(bia)).aid, bill());
  const kept = { stock: { ...faction(bia).stock }, yard: { ...faction(bia).yard } }, cost = room.baseCost(), lost = faction(bia).fell.from;
  assert.deepEqual(cost, bill(22500, 2500, 2500, 375));
  // What is left of a new faction's stocks once the base is paid for still fabricates the ore lorry and the tanker of the catalogue.
  const tanker = designBill(compileStructuredConstruction(createStructuredTemplate('tanker'))), left = billSum(STARTING_STOCK, cost, -1);
  assert(STOCK_IDS.every(id => left[id] >= lorryBill()[id] + tanker[id]), 'a quarter leaves the operation of a new faction');
  // Asked for, it is there at once: paid from the stocks to the unit, the yard untouched, and nothing given.
  const reply = f.send(bia, 'recover'), base = faction(bia).base;
  assert.deepEqual(reply, { base: room.base(room.players.get(bia.playerId)), selected: null });
  assert.deepEqual([faction(bia).stock, faction(bia).yard], [billSum(kept.stock, cost, -1), kept.yard]);
  assert.deepEqual(faction(bia).recovered, { at: room.world.time, base: base.x, from: lost, lorry: false, aid: bill(), aidAt });
  // A long march from every base and from the place of the one it lost, with a vein of iron and one of petroleum it knows of,
  // that no base stills and that holds something.
  for (const other of [faction(ana).base.x, lost]) assert(Math.abs(base.x - other) >= 15000, `${base.x} from ${other}`);
  for (const material of ['ferro', 'petroleo'])
    assert([...faction(bia).veins.keys()].map(id => room.sites.get(id)).some(site => site.material === material && room.dug(site) && room.left(site) > 0), material);
  // Bia is told once where it stands from the one she lost; the panel offers nothing more, and the workshop is hers again.
  const heard = ears(), words = recoveredText(room.factionView(bia.playerId));
  assert.match(words, /^Base estabelecida a \d+,\d km [←→] da que foi tomada\.$/);
  assert.deepEqual([heard.said, heard.grave, heard.panel.recover, heard.panel.emptyText], [[words], false, '', 'Você não tem construções no campo: monte uma em Construir e fabrique-a.']);
  assert.throws(() => f.send(bia, 'recover'), /^Error: Os estoques e o pátio da facção pagam um caminhão de minério/);
  const scout = f.publish(bia, 'scout', { x: base.x, facing: base.facing });
  assert(Math.abs(room.world.actor(scout).vehicle.x - base.x) <= BASE_RADIUS);
  // The refinery of the new base takes up what waited in the yard.
  Object.assign(faction(bia).yard, load(400));
  f.run(2);
  assert(faction(bia).yard.ferro < 400);
  // It is taken from the day it is established, as any other: no grace.
  room.wreck(room.world.actor(scout)); f.put(raider, base.x);
  assert.deepEqual([faction(bia).capture?.by, faction(bia).capture?.state], [faction(ana).id, 'advancing']);
});

test('the aid gives only the shortage for a base, a filled ore lorry and two spare tanks in stocks, with a separate repeat interval', t => {
  const { room, world, players: [ana, bia], faction, send, run, publish, view, finish } = field(t, 'Ana', 'Bia');
  publish(ana, 'scout', -30, 1);
  run(1.5); finish(bia);
  while (!faction(bia).fell) room.step();
  // Bia had little: with what she has, stocks and yard, she pays for part of the base and none of a lorry. The yard is
  // worth what the refinery makes of it: its 50 L of petroleum, 40 L of fuel.
  Object.assign(faction(bia).stock, bill(10000, 0, 3000, 100)); Object.assign(faction(bia).yard, load(2000, 0, 0, 50));
  const lorry = lorryBill(), reserve = 2 * lorry.combustivel, means = billSum(bill(10000, 0, 3000, 100), refined(load(2000, 0, 0, 50))),
    needed = billSum(billSum(room.baseCost(), lorry), bill(0, 0, 0, reserve)),
    aid = bill(...STOCK_IDS.map(id => Math.max(0, needed[id] - means[id])));
  assert.deepEqual(view(bia).recovery, { base: room.baseCost(), lorry, reserve, aid, offered: true });
  assert(STOCK_IDS.every(id => aid[id] > 0), 'short of every stock');
  assert.equal(recoveryText(view(bia).recovery), `Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L. Sem estoque para um caminhão de minério, ele vem junto, com Combustível ${reserve} L de reserva. ` +
    `O auxílio cobre o que falta: ${billText(aid)}.`);
  // Asked for: the base, at 5000, and the lorry there, under her command, built full; her stocks and yard paid what they had,
  // and what is left in stocks is the fuel kept for two more tanks, including what the yard paid from petroleum.
  const reply = send(bia, 'recover'), truck = world.actor(reply.selected);
  assert.deepEqual([faction(bia).base.x, truck.ownerId, truck.team, reply.actor.id], [5000, bia.playerId, faction(bia).id, truck.id]);
  assert(Math.abs(truck.vehicle.x - 5000) <= BASE_RADIUS);
  assert.deepEqual(appraise(truck, fieldParts(world)).salvage, lorry, 'the lorry is worth what it costs: its tank full');
  assert.deepEqual(means, bill(12000, 0, 3000, 140));
  assert.deepEqual([faction(bia).stock, faction(bia).yard], [bill(0, 0, 0, reserve), load()]);
  assert.deepEqual(billSum(billSum(faction(bia).stock, refined(faction(bia).yard)), billSum(room.baseCost(), lorry)), billSum(means, aid),
    'stocks plus refined yard and actual costs balance with the initial means plus only the quoted aid');
  assert.deepEqual(faction(bia).recovered, { at: world.time, base: 5000, from: 60, lorry: true, aid, aidAt: world.time });
  assert.match(recoveredText(view(bia)), /^Base estabelecida a 4,9 km → da que foi tomada, com um caminhão de minério · o auxílio cobriu Ferro [\d.]+ \+ Ligas 2\.500 \+ Sílica [\d.]+ \+ Combustível \d+ L\.$/);
  // While the lorry stands, nothing more is given, however little she has.
  Object.assign(faction(bia).stock, bill()); Object.assign(faction(bia).yard, load());
  assert.equal(view(bia).recovery.offered, false);
  assert.equal('wait' in view(bia).recovery, false, 'a standing construction has its own refusal, not a waiting countdown');
  assert.throws(() => send(bia, 'recover'), /^Error: A facção ainda tem construções no campo: o auxílio é para quem não tem nenhuma\.$/);
  // Lost too: the same faction waits for its next subsidy, and is told why rather than being directed to fabricate.
  room.wreck(truck);
  run(.5);
  const panel = page(room, bia)().panel;
  assert.deepEqual([panel.empty, panel.recover, panel.recovery], [true, '', '']);
  assert.match(panel.emptyText, /^Sua facção está sem construções no campo\. Novo auxílio em \d+:\d{2} de jogo\.$/);
  const waiting = view(bia).recovery.wait;
  assert(waiting > 1799 && waiting < 1800);
  assert.throws(() => send(bia, 'recover'), /Novo auxílio subsidiado em \d+ s de jogo/);
  // Ordinary keep/resume preserves the remaining simulation time, also for an older positive record without aidAt.
  const kept = JSON.parse(JSON.stringify(room.keep()));
  for (const legacy of [false, true]) {
    const snapshot = JSON.parse(JSON.stringify(kept)), saved = snapshot.factions.find(f => f.id === faction(bia).id);
    if (legacy) delete saved.recovered.aidAt;
    const again = rehearsal([-100, 60, 5000], STARTING_STOCK, { kept: snapshot }); t.after(() => again.world.dispose());
    const back = again.join('Bia', bia.token), recovered = again.faction(again.players.get(back.playerId)).recovered,
      quote = again.factionView(back.playerId).recovery;
    assert.deepEqual(recovered, saved.recovered, 'reading a recovery offer does not rewrite the saved history');
    assert.equal(quote.offered, false); assert(Math.abs(quote.wait - waiting) < 1e-9, 'restart neither resets nor consumes the simulation wait');
    assert.throws(() => again.command(back.playerId, { type: 'recover' }), /Novo auxílio subsidiado/);
  }
  // A faction whose stocks pay for the lorry and the fuel is offered nothing: it fabricates what it wants.
  Object.assign(faction(bia).stock, billSum(lorry, bill(0, 0, 0, reserve)));
  assert.equal(view(bia).recovery, null);
  assert.throws(() => send(bia, 'recover'), /^Error: Os estoques e o pátio da facção pagam um caminhão de minério: fabrique-o na Oficina\.$/);
});

test('a capture under way is kept with the field and goes on from where it was when the field is resumed', t => {
  const { room, world, players: [ana, bia], faction, run, publish } = field(t, 'Ana', 'Bia');
  publish(ana, 'scout', -30, 1);
  run(3.5);
  const kept = JSON.parse(JSON.stringify(room.keep())), capture = faction(bia).capture, at = captureAt(capture, world.time);
  const resume = state => { const again = rehearsal([-100, 60, 5000], STARTING_STOCK, { kept: state }); t.after(() => again.world.dispose()); return again; };
  const again = resume(kept), resumed = again.factions.get(faction(bia).id);
  assert.deepEqual([resumed.capture, resumed.base], [capture, faction(bia).base]);
  assert.equal(captureAt(resumed.capture, again.world.time), at);
  for (let i = 0; i < 120; i++) again.step();
  assert.equal(resumed.capture.state, 'advancing'); assert(Math.abs(captureAt(resumed.capture, again.world.time) - at - 2) < .2);
});

test('a faction with no base is kept with the field as it is: no base, what it lost and its yard waiting', t => {
  const { room, players: [ana, bia], faction, run, publish, finish } = field(t, 'Ana', 'Bia');
  publish(ana, 'scout', -30, 1);
  run(1.5); finish(bia);
  while (!faction(bia).fell) room.step();
  const kept = JSON.parse(JSON.stringify(room.keep())), again = rehearsal([-100, 60, 5000], STARTING_STOCK, { kept });
  t.after(() => again.world.dispose());
  const resumed = again.factions.get(faction(bia).id);
  assert.deepEqual([resumed.base, resumed.fell, resumed.recovered], [null, faction(bia).fell, null]);
  assert.equal(again.join('Bia', bia.token).base, null);
  assert.equal(again.command(bia.playerId, { type: 'recover' }).base.x, 5000);
});
