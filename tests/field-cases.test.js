import { FULL_INDUSTRY } from '../src/industry.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SharedRoom } from '../server/room.ts';
import { chapters } from '../server/fog.ts';
import { FrameLedger, FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { fieldPanel, fieldNotices } from '../src/field-panel.ts';
import { cancelledText, dumpedText, farText, dugText } from '../src/faction-ui.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { depositsNear, depositsOf, RESERVE_STEP } from '../src/deposits.ts';
import { bill, billSum, billText, designBill, load, RAW, STARTING_STOCK, STOCK_IDS, LOAD_REACH, BASE_RADIUS, CALM_SECONDS, CAPTURE_SECONDS } from '../src/economy.ts';
import { cargoRoom, CARGO } from '../src/component-volume.ts';
import { onField } from './helpers/field.js';
import { workArea } from '../src/loading-area.ts';

// The cases a player meets on the shared field, played on the field of the server: a vehicle out of fuel, out of
// rounds, damaged, unable to move, lost, or hit as it loads, and what puts each right — its base, or a supply
// vehicle brought to it, by themselves or asked. In each the frames go through the fog and the wire as they do to a
// page, and the panel is read as the page reads it: what the row of the vehicle says without its being picked,
// what is offered and advised once it is, and what is said aloud when the thing comes about.
// `stock` is what a faction is founded with there, and `away` how far from the first base the ones founded after it are.
// Every site holds a vein. The first base stands `gap` metres from a lone site of iron, which its faction knows from its
// founding (`deposit`); `veins` names other sites the case is about, given that one and all those of the ground: `f.veins`
// has them all, that one first.
function field(t, { names = ['Ana'], gap = 400, stock = bill(1e9, 1e9, 1e9, 1e9), away = [], veins = () => [] } = {}) {
  const bases = [], beside = (sites, middle) => {
      const alone = (x, reach, but) => depositsNear(sites, x, reach).every(d => d === but);
      return sites.filter(d => d.material === 'ferro' && alone(d.x, 2 * LOAD_REACH, d) && alone(d.x + gap, BASE_RADIUS + LOAD_REACH, d))
        .sort((a, b) => Math.abs(a.x - middle) - Math.abs(b.x - middle))[0];
    },
    room = new SharedRoom({ industry: FULL_INDUSTRY, stock, build: false, starter: false, base: i => bases[Math.min(i, bases.length - 1)], random: () => .5 }),
    f = onField(t, room), world = room.world, ground = world.terrain, sites = depositsOf(ground), deposit = beside(sites, ground.center),
    held = [deposit, ...veins(deposit, sites)];
  bases.push(Math.round(deposit.x + gap)); bases.push(...away.map(far => bases[0] + far));
  const players = names.map(name => room.join(name)), ledger = new FrameLedger(),
    pages = new Map(players.map(p => [p.playerId, { writer: new FrameWriter(ledger), reader: new FrameReader(), whole: true }]));
  const api = { ...f, deposit, veins: held, players, base: bases[0],
    // A construction of a template, or of a design, put on the field with the player's hands off it: `how` it is published. A
    // supply vehicle has out of automatic, as the player takes it where it serves.
    fielded: (player, design, how) => {
      const id = f.publish(player, design, how); f.order(player, 'control', { id: null });
      if (room.records.get(id).auto) f.send(player, 'auto', { actorId: id, on: false });
      return id;
    },
    // The construction as its faction is told of it.
    told: (player, id) => room.factionView(player.playerId).units.find(unit => unit.id === id),
    // The panel of a player's page: the frame its faction is told, its squad and its faction, and what the panel makes of them.
    panel: (player, { picked = [], tab = 'test' } = {}) => {
      const state = world.snapshot(); state.shared = true; state.players = room.roster();
      const kept = pages.get(player.playerId); ledger.turn();
      const packet = kept.reader.decode(kept.writer.encode({ type: 'frame', ...room.audience(state, chapters(state), [], room.players.get(player.playerId).factionId) }, kept.whole));
      kept.whole = false;
      const squad = room.squadView(player.playerId), faction = room.factionView(player.playerId),
        shown = { ...packet.state, squad, faction, controlledActor: squad?.manual, localPlayerId: player.playerId };
      return fieldPanel({ tab, shared: true, connected: true, state: shown, faction, playerId: player.playerId, picked, price: bill(1000, 0, 0, 10),
        deposits: depositsOf(ground), pingMs: 20 });
    },
    // The same page looked at again and again: what each look says aloud is `said`.
    watch: player => { const memo = {}, page = { said: [], look(options) { const panel = api.panel(player, options); page.said = fieldNotices(memo, panel.watch, world.time); return panel; }, memo }; return page; } };
  return api;
}
const row = (panel, number = 1) => panel.squad.units[number - 1], offered = panel => panel.orders.filter(order => !order.disabled).map(order => order.id), jobs = panel => panel.services.map(job => job.id),
  // Whether Mais ações offers to abandon the construction picked, where it stands.
  abandons = panel => panel.actions.some(action => action.id === 'abandon');
// What is said aloud, without the name of the vehicle.
const plain = said => said.map(words => words.replace(/ · .+?:/, ':'));
// What is said aloud but the veins found: every site holds a vein, and a vehicle that goes out comes on some. A case that is
// not about the veins leaves them to the cases of the veins (below).
const news = said => said.filter(words => !/^(Jazida de \S+ encontrada|Jazidas encontradas:) /.test(words));
// A tank as it comes out of a fight: its racks empty and its engine hit.
const spent = (f, id) => { for (const rack of f.parts(id, 'ammo')) f.set(rack, { rounds: 0 }); const [engine] = f.parts(id, 'engine'); f.set(engine, { health: engine.maxHealth * .35 }); };
const rounds = (f, id) => f.parts(id, 'ammo').reduce((sum, rack) => sum + rack.rounds, 0);
const cost = source => designBill(compileStructuredConstruction(typeof source === 'string' ? createStructuredTemplate(source) : source));

test('a lorry whose fuel will not take it home is told so while it can turn back, and one that ran dry says that, not that it is on its way', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'truck'), [tank] = f.parts(id, 'fuel'), page = f.watch(ana);
  f.put(id, f.base + 2500);
  let panel = page.look({ picked: [id] });
  assert.deepEqual([row(panel).status, row(panel).trouble, panel.advice, page.said], ['parado', false, '', []]);
  assert.match(panel.stats.fuel.title, /^Combustível \d+ L de \d+ L · autonomia [\d.,]+ km$/); assert.equal(panel.stats.cargo.text, 'vazia');
  // Nearly empty, on its way back: the row says it first, the panel what to do, and it is said aloud once.
  f.set(tank, { fuelLitres: .9 }); f.order(ana, 'move', { ids: [id], x: f.base }); f.run(2);
  panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^combustível para [\d,]+ km · base a [\d.]+ m · em movimento · faltam [\d.]+ m$/); assert.equal(row(panel).trouble, true);
  assert.match(panel.advice, /^O combustível mal dá para a volta: a base está a [\d.]+ m ←\.$/);
  assert.equal(news(page.said).length, 1); assert.match(news(page.said)[0], /^Veículo 1 · .+: combustível só para [\d,]+ km; a base está a [\d.]+ m\.$/);
  page.look(); assert.deepEqual(news(page.said), [], 'what was said is not said again');
  // Dry on the way. It is not "on its way" any more, nor is its way "blocked" when the order gives up.
  assert(f.until(() => !(f.parts(id, 'fuel')[0].fuelLitres > 1e-6), 240), 'it runs dry before it is home'); f.run(2);
  panel = page.look();
  assert.equal(row(panel).status, 'sem combustível'); assert.equal(row(panel).trouble, true); assert.deepEqual(offered(panel), []);
  assert.equal(news(page.said).length, 1); assert.match(news(page.said)[0], /^Veículo 1 · .+: sem combustível a [\d.]+ m da base\.$/);
  f.run(12); panel = page.look({ picked: [id] });
  assert.equal(row(panel).status, 'sem combustível'); assert.deepEqual(news(page.said), []);
  assert.deepEqual([panel.stats.fuel.text, panel.stats.fuel.low, panel.stats.cargo.text], ['sem combustível', true, 'vazia']);
  assert.match(panel.advice, /^Sem combustível: leve até ele um veículo de suprimentos\. A base está a [\d.]+ m ←\.$/);
  assert.equal(abandons(panel), true); assert.deepEqual([jobs(panel), panel.held], [[], ''], 'nothing is serviced away from the base and from any supply vehicle');
  // In the player's hands it says the same.
  f.order(ana, 'control', { id }); f.run(.3); panel = page.look();
  assert.equal(panel.situation, 'direct'); assert.equal(row(panel).status, 'sem combustível'); assert.match(panel.advice, /^Sem combustível: leve até ele um veículo de suprimentos/);
  // Stood in the base, it is fuelled there without being asked: it is as it was, and nothing is said of it.
  f.order(ana, 'control', { id: null }); f.put(id, f.base); f.run(CALM_SECONDS + 1); panel = page.look({ picked: [id] });
  assert.deepEqual([row(panel).status, row(panel).trouble, panel.advice, panel.held, jobs(panel), abandons(panel), news(page.said)], ['parado', false, '', '', [], false, []]);
  assert.match(panel.stats.fuel.title, /^Combustível \d+ L de \d+ L · autonomia [\d.,]+ km$/); assert.equal(panel.stats.cargo.text, 'vazia');
});

test('a tank out of rounds keeps useful weapon orders, reports its empty magazines, and is armed again in its base', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'ifv'), page = f.watch(ana);
  f.put(id, f.base + 600);
  let panel = page.look({ picked: [id] });
  assert.equal(row(panel).trouble, false); assert(offered(panel).includes('attack') && offered(panel).includes('bombard') && panel.stances);
  assert.match(panel.stats.rounds.text, /^\d+$/);
  for (const rack of f.parts(id, 'ammo')) f.set(rack, { rounds: 0 }); f.run(1);
  panel = page.look();
  assert.match(row(panel).status, /^sem munição/); assert.equal(row(panel).trouble, true);
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+: sem munição\.$/);
  panel = page.look({ picked: [id] });
  assert.deepEqual(offered(panel), ['move', 'attack', 'bombard', 'turn', 'home', 'stop']);
  assert.deepEqual(panel.orders.find(order => order.id === 'attack').ids, [id]);
  assert.equal(panel.stances.some(stance => stance.id === 'return' && stance.active), true);
  assert.deepEqual([panel.stats.rounds.text, panel.stats.rounds.low], ['0', true]);
  assert.match(panel.advice, /^Sem munição: a base remunicia, a [\d.]+ m ←, ou um veículo de suprimentos\.$/); assert.equal(panel.refused.attack, undefined);
  f.order(ana, 'control', { id }); f.run(.3); panel = page.look();
  assert.equal(row(panel).status, 'sem munição');
  // Stood in the base it is armed again without being asked: it is as it was, there is nothing to press for it, and nothing more is said.
  f.order(ana, 'control', { id: null }); f.put(id, f.base); f.run(CALM_SECONDS + 1); panel = page.look({ picked: [id] });
  assert(rounds(f, id) > 0 && f.told(ana, id).rearm.ferro === 0, 'its racks are full again'); assert.match(panel.stats.rounds.text, /^[1-9]/);
  assert.equal(row(panel).trouble, false); assert.deepEqual([panel.advice, panel.held, jobs(panel)], ['', '', []]); assert(offered(panel).includes('attack')); assert.deepEqual(page.said, []);
});

test('a damaged vehicle says what it lost and where it is mended, and its repair is told when it is done', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'ifv'), page = f.watch(ana);
  f.put(id, f.base + 700); page.look();
  // Hurt but whole: no trouble in its row, and the panel says where it is mended.
  const [engine] = f.parts(id, 'engine'), [gun] = f.parts(id, 'weapon');
  f.set(engine, { health: engine.maxHealth * .35 }); f.run(1);
  let panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /avariado \d+%/); assert.equal(row(panel).trouble, false); assert.deepEqual(page.said, []);
  assert.match(panel.advice, /^Avariado \d+%: a base repara, a [\d.]+ m ←, ou um veículo de suprimentos\.$/);
  // Its gun shot away: that comes first, and is said.
  f.set(gun, { health: 0 }); f.run(1); panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^arma inutilizada · avariado \d+%/); assert.equal(row(panel).trouble, true);
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+: arma inutilizada\.$/);
  assert.match(panel.advice, /^Arma inutilizada: a base repara, a [\d.]+ m ←, ou um veículo de suprimentos\.$/); assert.deepEqual(offered(panel), ['move', 'attack', 'bombard', 'turn', 'home', 'stop']);
  for (const kind of ['attack', 'bombard']) {
    const action = panel.orders.find(order => order.id === kind);
    assert.deepEqual([action.disabled, action.ids, action.reason], [false, [id], ''], 'a repairable weapon retains accepted attack intentions');
    assert.equal(panel.refused[kind], undefined);
  }
  // In the base, still hot from the fight, the repair waits and one line says why: there is no button for what comes by itself.
  f.put(id, f.base); panel = page.look({ picked: [id] });
  assert.deepEqual([jobs(panel), panel.advice], [[], '']); assert.match(panel.held, /^Em combate: fique 10 s/);
  // Calm, it begins: the row says how long it takes, the vehicle is no trouble any more, and all there is to ask for is to cancel it.
  f.run(CALM_SECONDS + 1); panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^em reparo · \d+ s$/); assert.deepEqual([row(panel).trouble, panel.advice, panel.held, jobs(panel), page.said], [false, '', '', ['cancel'], []]);
  assert(f.until(() => !f.told(ana, id).service, 120), 'the repair ends'); f.run(1); panel = page.look({ picked: [id] });
  assert.equal(row(panel).trouble, false); assert.doesNotMatch(row(panel).status, /avariado|reparo/); assert(offered(panel).includes('attack'));
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+: reparo concluído\.$/);
});

test('a vehicle that cannot move says why and what mends it there, and a supply vehicle brought to it does', t => {
  const f = field(t), [ana] = f.players, wheeled = f.fielded(ana, 'scout'), driven = f.fielded(ana, 'scout'), supply = f.fielded(ana, 'supply'), page = f.watch(ana);
  f.put(wheeled, f.base + 900); f.put(driven, f.base + 1100); page.look();
  for (const gear of f.parts(wheeled, 'wheel', 'track')) f.set(gear, { health: 0 });
  f.set(f.parts(driven, 'engine')[0], { health: 0 }); f.run(1);
  f.order(ana, 'move', { ids: [wheeled, driven], x: f.base }); f.run(2);
  let panel = page.look();
  assert.match(row(panel, 1).status, /^sem mobilidade · rodagem destruída/); assert.match(row(panel, 2).status, /^sem mobilidade · motor destruído/);
  assert.deepEqual(plain(page.said).sort(), ['Veículo 1: não anda mais (rodagem destruída) a 900 m da base.', 'Veículo 2: não anda mais (motor destruído) a 1.100 m da base.']);
  // The order gives up after a while: the row still says what is wrong, not that the way is blocked.
  f.run(12); panel = page.look({ picked: [wheeled] });
  for (const n of [1, 2]) { assert.match(row(panel, n).status, /^sem mobilidade/); assert.doesNotMatch(row(panel, n).status, /em movimento|caminho bloqueado/); assert.equal(row(panel, n).trouble, true); }
  assert.equal(panel.advice, 'Não anda mais (rodagem destruída): leve até ele um veículo de suprimentos, que o repara ali. A base está a 900 m ←.');
  assert.equal(abandons(panel), true); assert.deepEqual(page.said, []);
  // It still fires in the player's hands.
  f.order(ana, 'control', { id: driven }); f.run(.3); panel = page.look();
  assert.equal(row(panel, 2).status, 'sem mobilidade · motor destruído'); assert.equal(row(panel, 2).manual, true);
  // The supply vehicle, filled up at the base by itself, is parked beside the first: its repair begins there, unasked, and it moves again.
  f.order(ana, 'control', { id: null }); assert(f.told(ana, supply).supplies.ferro > 0); f.put(supply, f.base + 890); panel = page.look({ picked: [wheeled] });
  assert.match(row(panel, 1).status, /^em reparo · \d+ s$/); assert.deepEqual([row(panel, 1).trouble, panel.advice, jobs(panel), page.said], [false, '', ['cancel'], []]);
  assert.match(row(panel, 2).status, /^sem mobilidade · motor destruído/, 'the other one is out of its reach');
  assert(f.until(() => !f.told(ana, wheeled).service, 120), 'the repair ends'); f.run(1); panel = page.look({ picked: [wheeled] });
  assert.deepEqual(plain(page.said), ['Veículo 1: reparo concluído.']); assert.doesNotMatch(row(panel, 1).status, /sem mobilidade|avariado/);
  const from = f.world.actor(wheeled).vehicle.x; f.order(ana, 'move', { ids: [wheeled], x: f.base + 700 }); f.run(6);
  assert(f.world.actor(wheeled).vehicle.x < from - 10, 'it drives off on its own wheels');
});

test('a vehicle lost is said once with what was left of it, the last one too, and one the player gave up is not', t => {
  const f = field(t), [ana] = f.players, lorry = f.fielded(ana, 'truck'), car = f.fielded(ana, 'scout'), last = f.fielded(ana, 'scout'), page = f.watch(ana);
  f.put(lorry, f.base + 800); f.put(car, f.base + 300); f.put(last, f.base + 500);
  let panel = page.look();
  assert.equal(panel.squad.units.length, 3); assert.deepEqual(page.said, []);
  for (const post of f.parts(lorry, 'command')) f.set(post, { health: 0 }); f.run(2);
  panel = page.look();
  assert.equal(panel.squad.units.length, 2, 'what is left of it is nobody\'s vehicle'); assert.equal(panel.wrecks.length, 1);
  // Numbered by its place in the column: after the two scouts, which carry guns and stand with those that fight.
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 3 · .+ foi destruído · destroços a 800 m → da base, somem em \d+:\d\d\.$/);
  page.look(); assert.deepEqual(page.said, []);
  // Given up by the player: the page expects it to go.
  page.memo.expected.add(car); f.send(ana, 'abandon', { actorId: car }); f.run(1); panel = page.look();
  assert.equal(panel.squad.units.length, 1); assert.equal(panel.wrecks.length, 2); assert.deepEqual(page.said, []);
  // The last one: nobody is left to command, and it is still told.
  for (const post of f.parts(last, 'command')) f.set(post, { health: 0 }); f.run(2);
  panel = page.look();
  assert.equal(panel.situation, 'empty'); assert.equal(panel.squad, null);
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+ foi destruído · destroços a 500 m → da base/);
  // From the workshop of the field the vehicles are watched too.
  const again = f.fielded(ana, 'scout'); f.put(again, f.base + 400); page.look({ tab: 'edit' });
  for (const post of f.parts(again, 'command')) f.set(post, { health: 0 }); f.run(2);
  panel = page.look({ tab: 'edit' });
  assert.equal(panel.situation, 'workshop'); assert.equal(page.said.length, 1); assert.match(page.said[0], /foi destruído/);
});

test('a hauler hit as it loads says its loading is held by the fight, and goes on when it is left alone', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'truck'), page = f.watch(ana);
  f.room.extracted.set(f.deposit.id, 5000); // this transporter loads an already extracted public pile
  f.order(ana, 'haul', { ids: [id], depositId: f.deposit.id });
  // Its long hopper may take a first shovel as it rolls in within reach, under walking pace: it loads where it stops.
  assert(f.until(() => f.room.records.get(id).loading && Math.abs(f.world.actor(id).vehicle.vx) < .05, 180), 'it gets to the deposit and loads'); f.run(2);
  let panel = page.look();
  assert.match(row(panel).status, /^transportando · carregando · \d+%$/);
  const [engine] = f.parts(id, 'engine'); f.set(engine, { health: engine.maxHealth - 1 }); f.run(1);
  panel = page.look();
  assert.match(row(panel).status, /^transportando · aguardando material extraído · \d+% · interrompido pelo combate/); assert.equal(row(panel).trouble, false);
  f.run(CALM_SECONDS + 1); panel = page.look();
  assert.match(row(panel).status, /^transportando · carregando · \d+%/); assert.deepEqual(page.said, []);
});

test('a lorry out of fuel far from its base is fuelled where it stands by a supply vehicle parked beside it', t => {
  const f = field(t), [ana] = f.players, lorry = f.fielded(ana, 'truck'), supply = f.fielded(ana, 'supply'), page = f.watch(ana);
  // In its base a supply vehicle is filled up by itself from the stocks: its row and its gauge say what it has to give.
  f.run(1); let panel = page.look({ picked: [supply] });
  const carried = f.told(ana, supply).supplies; assert(carried.combustivel > 1000 && carried.ferro > 1000);
  assert.equal(row(panel, 2).status, 'parado · suprimentos cheios');
  assert.equal(panel.stats.supplies.share, 1); assert.equal(panel.stats.supplies.low, false);
  assert.match(panel.stats.supplies.text, /^Ferro [\d.]+ .*\+ Combustível [\d.]+ L$/);
  // No refined remittance is known here; supply pieces do not haul natural ore.
  assert.deepEqual(jobs(panel), []);
  assert.deepEqual(offered(panel), ['move', 'tow', 'turn', 'home', 'stop']); assert.equal(panel.refused.haul, 'Nenhum local de coleta compatível conhecido. Explore com um veículo de reconhecimento.');
  assert.throws(() => f.order(ana, 'haul', { ids: [supply], depositId: f.deposit.id }),
    /^Error: Instale uma Escavadeira para extrair minério ou uma Caçamba para transportá-lo\.$/);
  assert(offered(page.look({ picked: [lorry] })).includes('haul'), 'the lorry has the iron to go to');
  // The lorry dry two kilometres out: the panel says what has to be brought to it.
  f.put(lorry, f.base + 2000); f.set(f.parts(lorry, 'fuel')[0], { fuelLitres: 0 }); f.run(2); panel = page.look({ picked: [lorry] });
  const away = Math.round(Math.abs(f.world.actor(lorry).vehicle.x - f.base)).toLocaleString('pt-BR');
  assert.deepEqual([row(panel).status, panel.advice, plain(news(page.said))], ['sem combustível', `Sem combustível: leve até ele um veículo de suprimentos. A base está a ${away} m ←.`,
    [`Veículo 1: sem combustível a ${away} m da base.`]]);
  const owed = f.told(ana, lorry).rearm.combustivel; assert(owed > 100);
  // The supply vehicle on its last stretch, in reach and still rolling: the fuel waits for it to stop, and one line says so.
  f.put(supply, f.base + 1850); f.order(ana, 'move', { ids: [supply], x: f.base + 1991 });
  assert(f.until(() => f.told(ana, lorry).point, 60), 'the supply vehicle comes within reach'); panel = page.look({ picked: [lorry] });
  assert.deepEqual([jobs(panel), panel.held, panel.advice], [[], 'O veículo 2 está em movimento: os suprimentos esperam ele parar.', '']);
  // Parked: the lorry is fuelled out of its supplies, litre for litre, with nothing to press. It is as it was, and nothing is said.
  assert(f.until(() => !f.told(ana, lorry).rearm.combustivel, 60), 'it is fuelled when the supply vehicle stops'); f.run(1); panel = page.look({ picked: [lorry] });
  assert.deepEqual([row(panel).status, row(panel).trouble, panel.advice, jobs(panel), page.said], ['parado', false, '', [], []]);
  assert.match(panel.held, /^Recebeu [\d.,]+ L$/);
  assert.match(panel.stats.fuel.title, /^Combustível \d+ L de \d+ L · autonomia [\d.,]+ km$/); assert.equal(panel.stats.cargo.text, 'vazia');
  const remainingFuel = f.parts(supply, 'supply').reduce((sum, piece) => sum + (piece.cargo.petroleo ?? 0), 0);
  assert.deepEqual(f.told(ana, supply).supplies, { ...carried, combustivel: Math.floor(remainingFuel + 1e-6) }, 'the panel rounds cargo; the supplier also refuels its own travel consumption');
  assert.match(row(panel, 2).status, /^parado · suprimentos \d+%$/);
});

test('a tank out of rounds and damaged that drives into its base comes out of it served, without a click', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'ifv'), page = f.watch(ana), full = rounds(f, id);
  f.put(id, f.base + 600); page.look(); spent(f, id); f.run(1);
  let panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^sem munição · avariado \d+%$/);
  assert.equal(panel.advice, 'Sem munição: a base remunicia, a 600 m ←, ou um veículo de suprimentos.'); assert.deepEqual(plain(page.said), ['Veículo 1: sem munição.']);
  // Sent home. Inside the base and still rolling, service waits for it to stop and one line says so; there is nothing to press for it.
  f.order(ana, 'move', { ids: [id], x: f.base }); assert(f.until(() => f.told(ana, id).atBase, 180), 'it gets to its base'); panel = page.look({ picked: [id] });
  assert.deepEqual([jobs(panel), panel.held, panel.advice, rounds(f, id)], [[], 'Em movimento: o serviço começa quando a construção parar.', '', 0]);
  // Stopped: its racks are filled at once and its repair begins. Of the filling nothing is said.
  assert(f.until(() => f.told(ana, id).service, 60), 'its repair begins when it stops'); panel = page.look({ picked: [id] });
  assert.equal(rounds(f, id), full); assert.match(row(panel).status, /^em reparo · \d+ s$/); assert.deepEqual([row(panel).trouble, jobs(panel), page.said], [false, ['cancel'], []]);
  assert.match(panel.held, new RegExp(`^Recebeu [\\d.,]+ L · ${full} tiros$`));
  // Mended, that is said once; it is as it came to the field, and goes out again.
  assert(f.until(() => !f.told(ana, id).service, 120), 'the repair ends'); f.run(1); panel = page.look({ picked: [id] });
  assert.deepEqual([row(panel).status, row(panel).trouble, plain(page.said), jobs(panel)], ['revidar', false, ['Veículo 1: reparo concluído.'], []]); assert(offered(panel).includes('attack'));
  f.order(ana, 'move', { ids: [id], x: f.base + 300 }); f.run(8); panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^em movimento · faltam [\d.]+ m$/); assert.deepEqual(page.said, []);
});

test('the same tank at the front is served by a supply vehicle parked beside it, from what that one carries and as far as that goes', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'ifv'), supply = f.fielded(ana, 'supply'), page = f.watch(ana),
    full = rounds(f, id), [crates] = f.parts(supply, 'supply');
  // Filled up at the base by itself, the supply vehicle goes out after the tank.
  f.run(1); assert(f.told(ana, supply).supplies.ferro > 1000);
  f.put(id, f.base + 900); spent(f, id); f.run(CALM_SECONDS + 1); page.look();
  // Only fuel aboard: it pays for no rounds and no repair, and one line says what the supplies of which vehicle do not pay.
  f.set(crates, { cargo: { petroleo: 500 } }); f.put(supply, f.base + 910); let panel = page.look({ picked: [id] });
  assert.deepEqual(jobs(panel), []); assert.match(panel.held, /^Reposição até completar: Os suprimentos do veículo 2 não pagam a munição: Ferro 0 de [\d.]+\.$/); assert.equal(rounds(f, id), 0);
  assert.equal(abandons(panel), true);
  // Too little iron: it gives the rounds it pays for, whole, and the line says what is still missing. What is left pays for no piece of the repair.
  f.set(crates, { cargo: { ferro: 405 } }); f.put(supply, f.base + 890); panel = page.look({ picked: [id] });
  assert(rounds(f, id) > 0 && rounds(f, id) < full, 'some of its rounds'); assert(f.told(ana, supply).supplies.ferro < 405 && !f.told(ana, id).service);
  assert.match(row(panel).status, /^revidar · avariado \d+%$/); assert(offered(panel).includes('attack'));
  assert.match(panel.held, /^Reposição até completar: Os suprimentos do veículo 2 não pagam a munição: Ferro \d+ de [\d.]+\.$/); assert.match(row(panel, 2).status, /^parado · suprimentos \d+%$/);
  // With nothing left the supply vehicle says so, once: it has to go back for more.
  f.set(crates, { cargo: {} }); f.run(.5); panel = page.look({ picked: [supply] });
  assert.equal(row(panel, 2).status, 'parado · suprimentos vazios'); assert.deepEqual([panel.stats.supplies.text, panel.stats.supplies.title], ['vazios · Combustível 0 L', 'Suprimentos: vazios']); assert.deepEqual(plain(page.said), ['Veículo 2: suprimentos esgotados.']);
  assert.deepEqual([jobs(panel), abandons(panel), offered(panel)], [[], true, ['move', 'tow', 'turn', 'home', 'stop']]);
  // Full of iron: the racks are filled and the repair begins, both out of its supplies to the unit, with nothing to press.
  const { rearm, repair } = f.told(ana, id), iron = cargoRoom(crates) * CARGO.ferro.density, owedRounds = full - rounds(f, id);
  f.set(crates, { cargo: { ferro: iron } }); f.run(.5); panel = page.look({ picked: [id] });
  assert.equal(rounds(f, id), full); assert.match(row(panel).status, /^em reparo · \d+ s$/);
  assert.deepEqual([jobs(panel), panel.held, panel.advice], [['cancel'], `Recebeu ${owedRounds} tiros`, '']);
  assert.equal(f.told(ana, supply).supplies.ferro, Math.floor(iron - rearm.ferro - repair.ferro + 1e-6)); assert.equal(f.told(ana, id).service.partial, false);
  // The repair is done though the supply vehicle drives off, and is said when it is.
  f.put(supply, f.base + 1500); assert(f.until(() => !f.told(ana, id).service, 120), 'the repair ends'); f.run(1); panel = page.look({ picked: [id] });
  assert.deepEqual([row(panel).status, row(panel).trouble, plain(page.said)], ['revidar', false, ['Veículo 1: reparo concluído.']]);
});

test('a repair under way can be cancelled: its bill goes back to what paid it, and the tank is as it was until it is asked for again or has moved', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'ifv'), supply = f.fielded(ana, 'supply'), page = f.watch(ana), amount = value => value.toLocaleString('pt-BR'),
    aboard = () => f.told(ana, supply).supplies.ferro;
  // Filled up by itself in its base, the supply vehicle goes to the front beside the tank.
  f.run(1); f.put(id, f.base + 900); f.put(supply, f.base + 890);
  const carried = aboard(), [engine] = f.parts(id, 'engine'); page.look(); assert(carried > 1000, 'it carries iron');
  // Hit at the front and calm again beside the supply vehicle: its repair begins by itself, paid out of its supplies, and all there is to ask for is to cancel it.
  f.set(engine, { health: engine.maxHealth * .35 }); f.run(CALM_SECONDS + 1);
  let panel = page.look({ picked: [id] }); const { repair } = f.told(ana, id);
  assert.match(row(panel).status, /^em reparo · \d+ s$/); assert.deepEqual(panel.services.map(job => [job.id, job.text, job.disabled]), [['cancel', 'Cancelar reparo', false]]);
  assert.equal(panel.services[0].title, `Encerra o reparo sem consertar nada e devolve Ferro ${amount(repair.ferro)} ao veículo de suprimentos que pagou, enquanto ele estiver no campo e tiver espaço: o que não couber se perde.`);
  assert.deepEqual([panel.held, panel.advice, aboard()], ['', '', carried - repair.ferro]);
  // Cancelled: the reply says where the bill went; the tank is free and as damaged as it was, and nothing says its repair is done.
  assert.equal(cancelledText(f.send(ana, 'cancel-repair', { actorId: id })), `Reparo cancelado · Ferro ${amount(repair.ferro)} de volta ao veículo de suprimentos que pagou.`);
  panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^revidar · avariado \d+%$/); assert(offered(panel).includes('move') && offered(panel).includes('attack'));
  assert.deepEqual([aboard(), f.told(ana, id).repair, page.said], [carried, repair, []]);
  // Where it stands the repair does not begin again by itself: it is a job to ask for.
  f.run(CALM_SECONDS + 2); panel = page.look({ picked: [id] });
  assert.match(row(panel).status, /^revidar · avariado \d+%$/); assert.deepEqual([panel.services.map(job => [job.id, job.disabled]), panel.held], [[['repair', false]], '']);
  assert.match(panel.services[0].text, /^Reparar · Ferro [\d.]+ · \d+ s · suprimentos do veículo 2$/);
  // Driven a little way and stopped, still within reach of the supply vehicle, it is mended by itself as before.
  f.order(ana, 'move', { ids: [id], x: f.base + 880 }); assert(f.until(() => f.told(ana, id).service, 30), 'its repair begins where it stops');
  panel = page.look({ picked: [id] }); assert.deepEqual([jobs(panel), aboard()], [['cancel'], carried - repair.ferro]);
  // The supply vehicle that paid is destroyed meanwhile: cancelled now, the bill goes back to nobody, and the reply says so.
  for (const post of f.parts(supply, 'command')) f.set(post, { health: 0 }); f.run(1); page.look();
  assert.equal(cancelledText(f.send(ana, 'cancel-repair', { actorId: id })),
    `Reparo cancelado · perdido: Ferro ${amount(repair.ferro)}, porque o veículo de suprimentos que pagou já não está no campo.`);
  panel = page.look({ picked: [id] });
  assert.deepEqual([jobs(panel), page.said], [[], []]); assert.match(panel.held, /^(Recebeu [\d.,]+ L)?$/, 'a recent fractional refill receipt does not offer a repair without a supplier');
  assert.match(panel.advice, /^Avariado \d+%: a base repara, a [\d.]+ m ←, ou um veículo de suprimentos\.$/);
  // In its base the stocks pay, and it is to the stocks that a repair cancelled there gives its bill back.
  f.put(id, f.base); assert(f.until(() => f.told(ana, id).service, CALM_SECONDS + 3), 'the base mends it'); panel = page.look({ picked: [id] });
  assert.equal(panel.services[0].title, `Encerra o reparo sem consertar nada e devolve Ferro ${amount(repair.ferro)} aos estoques da facção.`);
  const stock = f.room.factionView(ana.playerId).stock.ferro;
  assert.equal(cancelledText(f.send(ana, 'cancel-repair', { actorId: id })), `Reparo cancelado · Ferro ${amount(repair.ferro)} de volta aos estoques da facção.`);
  panel = page.look({ picked: [id] });
  assert.deepEqual([f.room.factionView(ana.playerId).stock.ferro, jobs(panel), page.said], [stock + repair.ferro, ['repair'], []]);
  assert.match(panel.held, /^(Recebeu [\d.,]+ L)?$/, 'a recent refill receipt can remain after cancelling the independent repair');
});

test('a faction that lost everything and cannot pay for an ore lorry is offered the aid: one at its base, with its tank full and fuel for one more, of which it is given what it lacks', t => {
  const f = field(t, { stock: STARTING_STOCK }), [ana] = f.players, page = f.watch(ana), view = () => f.room.factionView(ana.playerId),
    lose = id => { for (const post of f.parts(id, 'command')) f.set(post, { health: 0 }); f.run(1); };
  // Come into the field: nothing there yet, stocks for more than a lorry, and the panel only points to the workshop.
  let panel = page.look();
  assert.deepEqual([panel.situation, panel.empty, panel.recover], ['empty', true, '']);
  // A reinforced recon vehicle and a transporter leave less than the mining truck of the aid costs. (Its armour three
  // times over left more iron than that once the templates stood on the cells of the grid, and the track of the mining
  // truck, fitted to its deck, came 3 cm smaller and cheaper.)
  const reconDesign = createStructuredTemplate('recon', { armourScale: 3.3 }), needed = cost('mining-truck'),
    left = billSum(billSum(STARTING_STOCK, cost(reconDesign), -1), cost('truck'), -1),
    recon = f.fielded(ana, reconDesign), lorry = f.fielded(ana, 'truck'); f.run(1); panel = page.look();
  assert(left.ferro < needed.ferro && left.ferro > 0, 'the two purchases leave less than the mining truck costs');
  assert.deepEqual([panel.situation, panel.empty, panel.recover, view().stock, view().recovery.offered], ['command', false, '', left, false]);
  // The recon vehicle is lost: the lorry still stands, and so does the faction.
  lose(recon); panel = page.look();
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+ foi destruído · destroços/); assert.equal(page.memo.grave, true);
  assert.deepEqual([panel.situation, panel.recover], ['command', '']);
  // The lorry too. Nothing of the faction stands and its stocks do not pay for a mining truck with fuel for one more tank:
  // the panel says what the aid gives, which is what the stocks lack of that, and offers it.
  lose(lorry); panel = page.look();
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo \d · .+ foi destruído · destroços/);
  assert.deepEqual([panel.situation, panel.empty, panel.squad, panel.services, panel.advice, panel.recover], ['empty', true, null, [], '', 'Pedir auxílio']);
  const want = billSum(needed, bill(0, 0, 0, 2 * needed.combustivel)), aid = bill(...STOCK_IDS.map(id => Math.max(0, Math.ceil(want[id] - left[id] - 1e-6))));
  assert.deepEqual(view().recovery, { base: null, lorry: needed, reserve: 2 * needed.combustivel, aid, offered: true });
  assert.equal(panel.recovery, `Nada no campo e sem estoque para um caminhão de minério (${billText(needed)}) com Combustível ${2 * needed.combustivel} L de reserva. ` +
    `O auxílio cobre o que falta: ${billText(aid)}.`);
  // Asked for, the truck is there at once, in the base the faction has, picked for the player; the stocks paid what they could of it.
  const reply = f.send(ana, 'recover'), truck = reply.selected; panel = page.look({ picked: [truck] });
  assert.deepEqual([reply.base.x, view().base, view().stock], [f.base, reply.base, billSum(billSum(left, aid), needed, -1)]);
  assert(Math.abs(f.world.actor(truck).vehicle.x - f.base) <= BASE_RADIUS);
  assert.deepEqual([page.said, page.memo.grave], [[`Caminhão de minério na base · o auxílio cobriu ${billText(aid)}.`], false]);
  assert.deepEqual([panel.situation, panel.empty, panel.recover, row(panel).status, panel.advice], ['command', false, '', 'aguardando trabalho', '']);
  assert.throws(() => f.send(ana, 'recover'), /^Error: A facção ainda tem construções no campo/);
  // The wrecks it left are still told, for as long as wrecks last.
  assert.equal(panel.wrecks.length, 2);
  page.look(); assert.deepEqual(page.said, []);
});

test('the last lorry of a faction that cannot pay for another, dry far from its base, is told the truth: given up, the faction may ask for the aid', t => {
  const needed = cost('mining-truck'), initial = billSum(needed, bill(94)), reserve = bill(0, 0, 0, 2 * needed.combustivel),
    f = field(t, { stock: initial }), [ana] = f.players, id = f.fielded(ana, 'mining-truck'), [tank] = f.parts(id, 'fuel'), page = f.watch(ana),
    stock = f.room.faction(f.room.players.get(ana.playerId)).stock;
  assert.deepEqual(stock, bill(94), 'the field charges the actual compiled bill and leaves the intended shortfall');
  f.put(id, f.base + 2500); page.look(); f.set(tank, { fuelLitres: 0 }); f.run(2);
  let panel = page.look({ picked: [id] });
  assert.deepEqual([row(panel).status, row(panel).trouble, jobs(panel), panel.held, abandons(panel)], ['sem combustível', true, [], '', true]);
  assert.equal(page.said.length, 1); assert.match(page.said[0], /^Veículo 1 · .+: sem combustível a 2\.\d{3} m da base\.$/);
  // Nobody can bring it fuel: there is no other construction, and nothing to build one with.
  assert.equal(panel.advice, 'Sem combustível, e a facção não tem outra construção nem estoque para um caminhão de minério. Abandone esta: sem nada no campo, a facção pode pedir auxílio.');
  assert.equal(panel.recover, '', 'while it stands there is no aid');
  assert.throws(() => f.send(ana, 'recover'), /^Error: A facção ainda tem construções no campo/);
  // A faction that could pay for a lorry, and fuel for one more tank, is told to bring one, as ever.
  Object.assign(stock, billSum(needed, reserve));
  assert.match(page.look({ picked: [id] }).advice, /^Sem combustível: leve até ele um veículo de suprimentos/);
  Object.assign(stock, bill(94));
  // Given up, it is a wreck and nobody's: nothing of the faction stands, and the panel offers the aid.
  page.memo.expected.add(id); f.send(ana, 'abandon', { actorId: id }); f.run(.5); panel = page.look();
  assert.deepEqual([panel.situation, panel.empty, page.said, panel.recover], ['empty', true, [], 'Pedir auxílio']);
  const aid = billSum(billSum(needed, reserve), bill(94), -1);
  assert.equal(panel.recovery, `Nada no campo e sem estoque para um caminhão de minério (${billText(needed)}) com Combustível ${reserve.combustivel} L de reserva. ` +
    `O auxílio cobre o que falta: ${billText(aid)}.`);
  const reply = f.send(ana, 'recover'); panel = page.look();
  assert.deepEqual([reply.base.x, panel.recover, page.said, f.room.factionView(ana.playerId).stock], [f.base, '', [`Caminhão de minério na base · o auxílio cobriu ${billText(aid)}.`], reserve]);
});

test('another faction is known from the first sight of it: what the page of the faction says before and after, and what is said', t => {
  const f = field(t, { away: [6000, 30000] }), [ana] = f.players, page = f.watch(ana), mine = f.fielded(ana, 'truck');
  // Of the other nation, its row of the ranking — its name, flag, where it stands and the place it was last seen —, and Beto as whoever may be invited.
  const nation = panel => panel.faction.ranking.find(row => !row.own), seen = row => [row.name, row.flag, row.detail, row.x],
    person = panel => panel.faction.invitable.map(row => [row.id, row.act, row.detail]);
  // Alone on the field there is nobody to invite, and the ranking is the player's nation alone.
  let panel = page.look();
  assert.deepEqual([panel.faction.invitable, panel.faction.ranking.length], [[], 1]);
  // Beto comes into the field with a scout, six kilometres away. All she is told of him is that he is there, and what his nation is worth: he can be invited, and no more.
  const beto = f.room.join('Beto'), theirs = f.fielded(beto, 'scout'), his = f.room.players.get(beto.playerId); f.run(1); panel = page.look();
  const drawn = f.room.faction(his).flag;
  assert.deepEqual([seen(nation(panel)), person(panel), page.said], [['Facção de Beto', drawn, '', null], [[beto.playerId, 'invite', 'ainda não encontrado']], []]);
  // His scout comes into sight of her lorry: first contact, said once. His nation's row says it is in sight, and he is invited as one of it.
  f.put(theirs, f.base + 300); panel = page.look();
  assert.deepEqual([seen(nation(panel)), person(panel), page.said, page.memo.grave], [['Facção de Beto', drawn, 'à vista agora', null], [[beto.playerId, 'invite', 'Facção de Beto']],
    ['Veículo 1: avistou um inimigo à direita →.', 'Nova facção encontrada: Facção de Beto.'], false]);
  page.look(); assert.deepEqual(page.said, []);
  // She drives off. The row says how long ago his nation was seen and how far that was from her base, and has the place to take the camera to.
  f.put(mine, f.base - 3000); f.run(60); panel = page.look();
  const place = nation(panel).x;
  assert(Math.abs(place - (f.base + 300)) <= 2, 'where his scout stood'); assert.deepEqual([seen(nation(panel)), news(page.said)], [['Facção de Beto', drawn, 'vista há 1 min · a 300 m →', place], []]);
  // He leaves the page for a while: his row says so.
  f.room.disconnect(beto.playerId); assert.deepEqual(person(page.look()), [[beto.playerId, 'invite', 'Facção de Beto · desconectado']]); f.room.join('Beto', beto.token);
  // Invited by her, he has the invitation to withdraw beside his name; his faction inviting her, the answer is at the top of the page.
  f.send(ana, 'invite', { playerId: beto.playerId }); f.send(beto, 'invite', { playerId: ana.playerId }); panel = page.look();
  assert.deepEqual([person(panel), panel.faction.invites], [[[beto.playerId, 'cancel', 'Facção de Beto']], [{ factionId: his.factionId, name: 'Facção de Beto', flag: drawn, text: '1 membro' }]]);
  // He names his nation and makes its flag: her ranking and his invitation go by both from then on.
  const flag = { field: 'saltire', colours: [7, 0, 4], emblem: 'none' };
  f.send(beto, 'identity', { nation: 'Betânia', flag }); panel = page.look();
  assert.deepEqual([seen(nation(panel)), panel.faction.invites, page.said], [['Betânia', flag, 'vista há 1 min · a 300 m →', place], [{ factionId: his.factionId, name: 'Betânia', flag, text: '1 membro' }], []]);
  f.send(beto, 'identity', { nation: '', flag: drawn });
  f.send(ana, 'invite', { playerId: beto.playerId, cancel: true }); f.send(ana, 'decline', { factionId: his.factionId });
  // His scout is lost, and Caio, whom she never met, takes his base: to her his faction lost its base then, and where it stood is forgotten.
  for (const post of f.parts(theirs, 'command')) f.set(post, { health: 0 }); f.run(1);
  const caio = f.room.join('Caio'), raider = f.fielded(caio, 'scout'), beaten = f.room.faction(his), betos = panel => panel.faction.ranking.find(row => row.name === 'Facção de Beto');
  f.put(raider, beaten.base.x); assert(f.until(() => beaten.capture, 2), 'Caio stands armed in his base');
  Object.assign(beaten.capture, { progress: CAPTURE_SECONDS - .5, at: f.world.time }); assert(f.until(() => beaten.fell, 2)); panel = page.look();
  assert.deepEqual([seen(betos(panel)), panel.faction.invites, page.said, page.memo.grave],
    [['Facção de Beto', drawn, 'derrotada há 0 s', null], [], ['Facção de Beto perdeu a base.'], false]);
  f.run(125); panel = page.look(); assert.deepEqual([betos(panel).detail, page.said], ['derrotada há 2 min', []]);
});

test('a camera shut in the steel of its own hull does not meet another faction, and behind a pane of glass it does', t => {
  const f = field(t, { names: ['Ana', 'Beto'], away: [6000] }), [ana, beto] = f.players, page = f.watch(ana), other = f.watch(beto),
    hers = f.room.players.get(ana.playerId), his = f.room.players.get(beto.playerId),
    // A car with no sensor on it and its vision block of steel: all it looks with is the camera of its command post, inside the hull.
    shut = createStructuredTemplate('chassis');
  shut.components = shut.components.filter(part => part.kind !== 'sensor');
  // The same car with its vision block the pane of glass it comes with, before its command post.
  const glazed = structuredClone(shut); shut.plates.find(plate => plate.id === 'hull:vision').material = 'steel';
  const car = f.fielded(ana, shut, { facing: 1 }), scout = f.fielded(beto, 'scout'), told = () => f.room.told(hers.factionId, f.world.actor(scout));
  f.run(1); page.look(); other.look();
  // His scout stands 300 m before her car, in the open. She is told nothing of it: he is a stranger still, and nothing is said.
  f.put(scout, f.base + 300); let panel = page.look();
  assert.deepEqual(f.world.actor(car).eyes, [], 'the car has no eye');
  assert.equal(told(), null);
  assert.deepEqual([panel.faction.invitable.map(row => [row.id, row.detail]), page.said], [[[beto.playerId, 'ainda não encontrado']], []]);
  // His scout, its camera on its roof, has met her meanwhile.
  assert.deepEqual([other.look().faction.invitable.map(row => row.detail), news(other.said)], [['Facção de Ana'], ['Veículo 1: avistou um inimigo a 300 m ←.', 'Nova facção encontrada: Facção de Ana.']]);
  // Rebuilt at her base with the pane, the car sees ahead as far as the camera of a command post does, and not behind: first contact.
  assert.equal(f.fielded(ana, glazed, { actorId: car, facing: 1 }), car); f.run(1.5); panel = page.look();
  const [eye] = f.world.actor(car).eyes;
  assert.deepEqual([f.world.actor(car).eyes.length, eye.left, eye.right], [1, 0, 650]);
  assert.equal(told()?.id, scout);
  const row = panel.faction.ranking.find(row => !row.own);
  assert.deepEqual([row.id, row.name, row.flag, row.detail, row.x, page.said], [his.factionId, 'Facção de Beto', f.room.faction(his).flag, 'à vista agora', null,
    ['Veículo 1: avistou um inimigo a 300 m →.', 'Nova facção encontrada: Facção de Beto.']]);
});

// The site of iron nearest a place and at least so far from it, other than those given, with nothing else to load from about it.
const iron = (sites, x, least, ...but) => sites.filter(d => d.material === 'ferro' && !but.includes(d) && Math.abs(d.x - x) >= least && depositsNear(sites, d.x, 2 * LOAD_REACH).length === 1)
  .sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
// The ground a base knows the veins of from its founding, a kilometre to each side of it (server/room.ts).
const BASE_SIGHT = 1000;
// What a page says of veins found in one look, each where it lies from the base.
const foundText = (sites, base) => sites.length > 1 ? `Jazidas encontradas: ${sites.map(d => `${RAW[d.material]} a ${farText(d.x, base)}`).join(', ')}.` :
  `Jazida de ${RAW[sites[0].material]} encontrada a ${farText(sites[0].x, base)}.`;
const hauling = (f, player, id) => f.room.squadView(player.playerId).units.find(u => u.id === id).haul, at = (f, id) => f.world.actor(id).vehicle.x;

test('a vein has to be found: a scout that comes on one says so once, the list has it with how long ago it was seen, and a lorry can be sent there', t => {
  const f = field(t, { veins: (site, sites) => [iron(sites, site.x + 400, 1500, site)] }), [ana] = f.players, [near, far] = f.veins,
    lorry = f.fielded(ana, 'truck'), scout = f.fielded(ana, 'scout'), page = f.watch(ana), told = () => f.room.factionView(ana.playerId).deposits,
    about = [...new Set([...depositsNear(f.room.deposits, f.base, BASE_SIGHT),
      f.room.endow({ x: f.base }, 'ferro'), f.room.endow({ x: f.base }, 'petroleo')])].sort((a, b) => a.x - b.x);
  // Foundation surveys the nearby ground and an iron/petroleum source. The second iron vein is still unknown.
  let panel = page.look({ picked: [lorry] });
  assert(about.includes(near) && !about.includes(far), 'the second lies beyond the ground the base knows');
  assert.deepEqual(told(), about.map(d => ({ id: d.id, left: d.reserve, stock: 0, at: 0, seen: false, loading: false, extracting: false, active: true })));
  const card = id => panel.veins.find(d => d.id === id);
  assert.deepEqual(panel.veins.map(d => [d.id, d.collect?.ids]), about.map(d => [d.id, d.material === 'petroleo' ? undefined : [lorry]]));
  assert.match(card(near.id).name, /^Ferro · (afloramento|ruínas)$/);
  assert.match(card(near.id).lines.join(' | '), /^Reserva ([\d.,]+ t) de \1 \| Pronto 0 kg \| A 4\d\d m ← da base · vista há \d+ s$/);
  assert.throws(() => f.order(ana, 'haul', { ids: [lorry], depositId: far.id }), /^Error: Jazida desconhecida: escolha uma que a facção já encontrou\./);
  // The scout comes on it: found, said once, with where it lies from the base, in one sentence with the others it sees there. It is
  // on the list, in sight, with all it holds.
  const knew = told().map(d => d.id); f.put(scout, far.x + 25); panel = page.look({ picked: [lorry] });
  const found = told().filter(d => !knew.includes(d.id)).map(d => f.room.sites.get(d.id));
  assert(found.includes(far), 'the second is found');
  assert.deepEqual([page.said, page.memo.grave], [[foundText(found, f.base)], false]);
  assert.deepEqual(panel.veins.map(d => d.id).sort(), [...knew, ...found.map(d => d.id)].sort(), 'all are known');
  assert.match(card(far.id).lines.join(' | '), /^Reserva ([\d.,]+ t) de \1 \| Pronto 0 kg \| A \d,\d km [←→] da base$/); assert.equal(panel.watch.veins.length, knew.length + found.length);
  page.look(); assert.deepEqual(page.said, [], 'what was said is not said again');
  // The scout goes home. The faction goes on knowing the vein as it last saw it, and the list says how long ago that was.
  f.put(scout, f.base); const seen = told().find(d => d.id === far.id).at; f.run(65); panel = page.look({ picked: [lorry] });
  assert.deepEqual(told().find(d => d.id === far.id), { id: far.id, left: far.reserve, stock: 0, at: seen, seen: false, loading: false, extracting: false, active: true }); assert(seen > 0);
  assert.match(card(far.id).lines.at(-1), /^A \d,\d km [←→] da base · vista há 1 min$/); assert.deepEqual(page.said, []);
  // Known, it is somewhere to send the lorry.
  f.order(ana, 'haul', { ids: [lorry], depositId: far.id }); assert.deepEqual(hauling(f, ana, lorry), { depositId: far.id, material: 'ferro', phase: 'out' });
});

test('the vein a hauler works is emptied: it takes no other, though its faction knows one; it says so once, brings home what it has and stops there', t => {
  const f = field(t, { veins: (site, sites) => [iron(sites, site.x + 400, 1200, site)] }), [ana] = f.players, [near, far] = f.veins,
    lorry = f.fielded(ana, 'mining-truck'), scout = f.fielded(ana, 'scout'), page = f.watch(ana), told = () => f.room.factionView(ana.playerId).deposits.map(d => d.id),
    // The lorry is second in the column, after the scout, which carries a gun and stands with those that fight.
    emptied = 'Veículo 2: jazida de Ferro vazia · recuperando — volta à base ou ao posto e fica lá. Mande-o de novo mais tarde ou a outro local de coleta.';
  // The scout has found the second vein and is back in the base. Little is left of the first: the lorry takes it down to
  // less than a step, which is empty. What it finds on the way is said too, and is no part of this case.
  f.put(scout, far.x); f.put(scout, f.base); page.look(); assert(told().includes(near.id) && told().includes(far.id), 'both are known');
  f.room.veins.set(near.id, 1700); f.order(ana, 'haul', { ids: [lorry], depositId: near.id });
  assert(f.until(() => hauling(f, ana, lorry)?.empty, 180), 'it emptied the vein'); assert(f.room.left(near) < RESERVE_STEP); f.run(1.5);
  // The lorry does not go on to the vein its faction knows of, where nobody sent it: there may be anybody there. It says
  // so once and turns for home with what it had loaded; the vein it emptied is on the list still, as the other is: it comes back.
  assert(f.until(() => !f.room.records.get(lorry).service, 10), 'turned about for home');
  const carried = f.told(ana, lorry).cargo.ferro; assert(carried > 600);
  let panel = page.look({ picked: [lorry] });
  assert.deepEqual([plain(news(page.said)), page.memo.grave], [[emptied], false]);
  assert.deepEqual(hauling(f, ana, lorry), { depositId: near.id, material: 'ferro', phase: 'home', empty: true });
  assert.match(row(panel, 2).status, /^extração e transporte · voltando à base · \d+% · jazida de Ferro vazia · recuperando$/);
  assert(panel.veins.some(d => d.id === near.id) && panel.veins.some(d => d.id === far.id), 'both are on the list');
  page.look(); assert.deepEqual(news(page.said), []);
  const had = f.room.factionView(ana.playerId), before = had.stock.ferro + had.yard.ferro;
  assert(f.until(() => !hauling(f, ana, lorry), 400), 'home and unloaded, its haul is over'); f.run(1); panel = page.look({ picked: [lorry] });
  assert(Math.abs(at(f, lorry) - f.base) <= BASE_RADIUS, 'it stands in its base'); assert.deepEqual(news(page.said), [], 'it said so once');
  const has = f.room.factionView(ana.playerId); assert(Math.abs(has.stock.ferro + has.yard.ferro - before - carried) <= 250, 'what it loaded is the faction\'s');
  assert.equal(row(panel, 2).status, 'parado · jazida de Ferro vazia · recuperando');
  assert(Math.abs(at(f, lorry) - far.x) > 300, 'and it went nowhere near the other vein');
  // The other vein is the player's to send it to: sent, it hauls from there and says no more of the one it emptied.
  assert(offered(panel).includes('haul')); f.order(ana, 'haul', { ids: [lorry], depositId: far.id }); f.run(1);
  assert(f.until(() => !f.room.records.get(lorry).service, 10), 'turned about for it'); panel = page.look({ picked: [lorry] });
  assert.deepEqual(hauling(f, ana, lorry), { depositId: far.id, material: 'ferro', phase: 'out' });
  assert.match(row(panel, 2).status, /^extração e transporte · indo à coleta · \d+%$/); assert.deepEqual(news(page.said), []);
  // That one is emptied under it too: it says so of this one, and goes home.
  assert(f.until(() => f.room.records.get(lorry).loading === far.id, 300), 'it loads there'); f.run(1);
  f.room.veins.set(far.id, 400); assert(f.until(() => hauling(f, ana, lorry)?.empty, 30), 'the second is emptied'); f.run(1.5); panel = page.look({ picked: [lorry] });
  assert.deepEqual([plain(news(page.said)), page.memo.grave], [[emptied], false]);
  assert.deepEqual(hauling(f, ana, lorry), { depositId: far.id, material: 'ferro', phase: 'home', empty: true });
  assert(f.until(() => !hauling(f, ana, lorry), 400), 'home again'); f.run(1); panel = page.look({ picked: [lorry] });
  assert.equal(row(panel, 2).status, 'parado · jazida de Ferro vazia · recuperando');
  // Home again, there is still somewhere to send it: the veins it emptied come back, a little at a time. Sent again to the first,
  // which has come back in part meanwhile, it goes there and digs what came back.
  const back = f.room.left(near); assert(back > 0 && back < near.reserve, 'the first came back in part');
  assert(offered(panel).includes('haul') && panel.veins.find(d => d.id === near.id).collect?.ids.includes(lorry), 'the order is offered at it');
  f.order(ana, 'haul', { ids: [lorry], depositId: near.id }); assert.deepEqual(hauling(f, ana, lorry), { depositId: near.id, material: 'ferro', phase: 'out' });
  assert(f.until(() => f.room.records.get(lorry).extraction?.some(tool => tool.siteId === near.id), 180), 'it digs there again'); panel = page.look({ picked: [lorry] });
  assert.deepEqual([news(page.said), hauling(f, ana, lorry).empty], [[], undefined]);
});

test('a vein another faction dug out stays on the list as it was last seen: seen again, it shows what came back of it, and a lorry sent to one finds only that', t => {
  const f = field(t, { names: ['Ana', 'Beto'], away: [20000], veins: (site, sites) => [iron(sites, site.x + 400, 1200, site)] }), [ana, beto] = f.players, [near, far] = f.veins,
    lorry = f.fielded(ana, 'truck'), scout = f.fielded(ana, 'scout'), digger = f.fielded(beto, 'mining-truck'), page = f.watch(ana), hers = f.room.players.get(ana.playerId).factionId,
    told = () => f.room.factionView(ana.playerId).deposits, knows = vein => told().find(d => d.id === vein.id), away = f.base + 9000,
    full = vein => `Reserva ${dugText('ferro', vein.reserve)} de ${dugText('ferro', vein.reserve)}`;
  // She knows both veins, and has nothing of hers within sight of either while his lorry takes the last of each.
  f.put(scout, far.x); f.put(scout, away); f.put(lorry, away + 30); page.look(); assert(knows(near) && knows(far), 'she knows both');
  for (const vein of [near, far]) {
    f.room.veins.set(vein.id, 300); f.put(digger, workArea(f.room.world, digger, vein, LOAD_REACH).goal); assert(!f.room.sees(hers, vein.x));
    assert(f.until(() => f.room.veins.get(vein.id) === 0, 20), 'he dug it out');
  }
  // Ten minutes go by out of her sight, and they come back a little.
  f.put(digger, f.base + 20000); f.run(1); f.room.replenish(600);
  // To her they are as she last saw them: on the list, with all they held, and somewhere to send a lorry.
  let panel = page.look({ picked: [lorry] });
  const card = vein => panel.veins.find(d => d.id === vein.id);
  assert.deepEqual([knows(near).left, knows(far).left, page.said], [near.reserve, far.reserve, []]);
  assert([near, far].every(vein => card(vein).lines[0] === full(vein) && card(vein).lines[1] === 'Pronto 0 kg' && / · vista há \d+ s$/.test(card(vein).lines[2]) &&
    card(vein).collect?.ids[0] === lorry));
  // Her scout comes to the first. It is on the list still, with what has come back of it since he dug it out: a little, out of
  // all it holds. Nothing is said of it, but of the veins it finds there anew, and it is somewhere to send a lorry as before.
  f.put(scout, near.x + 20); panel = page.look({ picked: [lorry] });
  const back = knows(near).left;
  assert(back >= RESERVE_STEP && back < near.reserve / 10, `${back} came back`); assert.deepEqual([news(page.said), page.memo.grave], [[], false]);
  assert.deepEqual([card(near).lines[0], card(near).collect?.ids], [`Reserva ${dugText('ferro', back)} de ${dugText('ferro', near.reserve)}`, [lorry]]);
  assert.equal(knows(far).left, far.reserve, 'of the other she still knows what she last saw');
  // Her lorry is sent to the second, which she still believes full. It finds there what came back of it and nothing ready to
  // take: the list says so, and it waits there for what is extracted, with nothing aboard and nothing said.
  f.put(lorry, far.x + Math.sign(f.base - far.x) * 300); f.order(ana, 'haul', { ids: [lorry], depositId: far.id });
  assert(f.until(() => hauling(f, ana, lorry)?.phase === 'load', 120), 'it gets there'); f.run(1.5); panel = page.look({ picked: [lorry] });
  assert(knows(far).left > 0 && knows(far).left < far.reserve / 10, 'she knows what is left of it');
  assert.deepEqual([news(page.said), page.memo.grave, hauling(f, ana, lorry)], [[], false, { depositId: far.id, material: 'ferro', phase: 'load' }]);
  assert.match(row(panel, 2).status, /^transportando · aguardando material · 0%$/);
  assert.deepEqual(f.told(ana, lorry).cargo, { ferro: 0, ligas: 0, silica: 0, petroleo: 0 }, 'it loaded nothing there');
});

test('a lorry too heavy for the ground it is on tips a quarter of its hopper out at a time: it weighs that much less, the panel says what is left, and one sent to haul takes the rest home', t => {
  const f = field(t, { names: ['Ana', 'Beto'], away: [6000] }), [ana, beto] = f.players, id = f.fielded(ana, 'truck'), page = f.watch(ana), [hopper] = f.parts(id, 'hopper'),
    mass = () => f.world.actor(id).vehicle.mass, carried = () => f.parts(id, 'hopper')[0].cargo, tip = (player = ana) => f.send(player, 'dump-cargo', { actorId: id }),
    amount = value => Math.round(value).toLocaleString('pt-BR'), view = () => f.room.factionView(ana.playerId), brought = () => view().stock.ferro + view().yard.ferro,
    DUMP = { id: 'dump', text: 'Despejar ¼ da carga', disabled: false, title: 'Alivia o peso: o que sai fica no chão e se perde.' };
  // Empty, a kilometre and a half from its base: there is nothing to tip out, and nothing is offered.
  f.put(id, f.base + 1500); let panel = page.look({ picked: [id] });
  assert.deepEqual([jobs(panel), panel.held], [[], '']); assert.equal(panel.stats.cargo.text, 'vazia');
  assert.throws(() => tip(), /^Error: Essa construção não leva carga para despejar\.$/);
  // Full of silica there, with no vein about and nothing that serves it: the one thing to do for it is to tip some out.
  const empty = mass(); f.set(hopper, { cargo: { silica: 1e9 } }); f.run(1);
  const full = carried().silica, had = view(), vein = f.room.veins.get(f.deposit.id);
  assert(full > 7000 && Math.abs(mass() - empty - full) <= 20, 'seven tonnes and a half on a lorry of six');
  panel = page.look({ picked: [id] });
  assert.deepEqual([panel.stats.cargo.text, panel.stats.cargo.title], ['cheia', `Carga: Sílica ${amount(full)} · cheia`]); assert.deepEqual([panel.services, panel.held, abandons(panel)], [[DUMP], '', true]);
  // In the player's hands it is the same job, under the line of its load.
  f.order(ana, 'control', { id }); f.run(.3); panel = page.look();
  assert.deepEqual([panel.situation, panel.stats.cargo.title, panel.services], ['direct', `Carga: Sílica ${amount(full)} · cheia`, [DUMP]]);
  // The load of somebody else is not one's own to tip out: neither that of a construction the faction has not in sight, nor
  // that of one of the faction another member holds.
  assert.throws(() => tip(beto), /^Error: Essa construção já não está no campo\.$/);
  f.send(ana, 'invite', { playerId: beto.playerId }); f.send(beto, 'join-faction', { factionId: had.id });
  assert.throws(() => tip(beto), /^Error: Este veículo está com Ana até ser liberado\.$/); assert.equal(carried().silica, full);
  // Asked for, a quarter of what the hopper holds comes out and is lost: the reply says how much, the core weighs what is left, and the panel says that.
  const reply = tip();
  assert.deepEqual(reply, { dumped: load(0, 0, Math.round(full / 4)) }); assert.equal(dumpedText(reply), `Carga despejada · Sílica ${amount(full / 4)}.`);
  f.run(.5); panel = page.look();
  assert(Math.abs(carried().silica - full * .75) < 1e-6 && Math.abs(mass() - empty - full * .75) <= 20, `it weighs ${(mass() - empty).toFixed(0)} kg more than empty`);
  assert.deepEqual([panel.stats.cargo.text, panel.stats.cargo.title, panel.services, page.said], ['75%', `Carga: Sílica ${amount(full * .75)} · 75%`, [DUMP], []]);
  assert.deepEqual([view().yard, view().stock, f.room.veins.get(f.deposit.id)], [had.yard, had.stock, vein], 'in no yard, no stock and no vein');
  // Three more empty it. Then there is nothing left to tip out, and the job is gone.
  for (const left of [.5, .25, 0]) { tip(); assert(Math.abs(carried().silica - full * left) < 1e-6); }
  f.run(.5); panel = page.look();
  assert(Math.abs(mass() - empty) <= 20, 'it weighs what it did empty'); assert.deepEqual([panel.stats.cargo.text, panel.services, f.told(ana, id).cargo], ['vazia', [], load()]);
  assert.throws(() => tip(), /^Error: Essa construção não leva carga para despejar\.$/);
  // Sent to haul and loading at its vein, with more aboard than it will get home with: lighter by a quarter of its hopper, it does not
  // stay to be filled up again. It takes what is left home, and from there its haul goes on.
  f.room.extracted.set(f.deposit.id, 20000);
  f.order(ana, 'control', { id: null }); f.put(id, f.deposit.x + 60); f.order(ana, 'haul', { ids: [id], depositId: f.deposit.id });
  assert(f.until(() => f.room.records.get(id).loading, 60), 'it loads at its vein'); f.set(hopper, { cargo: { ferro: 6000 } }); f.run(1);
  panel = page.look({ picked: [id] });
  const loading = f.told(ana, id).cargoWork, seconds = Math.ceil(loading?.until - f.world.time);
  assert.equal(loading?.kind, 'load'); assert(Number.isFinite(loading.until) && seconds > 0, 'the available pile supports a positive authoritative loading deadline');
  assert.match(row(panel).status, /^transportando · carregando · [1-9]\d* s · \d+%$/);
  assert.equal(row(panel).status, `transportando · carregando · ${seconds} s · ${panel.stats.cargo.text}`); assert.deepEqual(panel.services, [DUMP]);
  const aboard = carried().ferro, before = brought(), out = tip().dumped.ferro;
  assert.equal(out, Math.round(full / 1600 * 2400 / 4), 'a quarter of what its hopper holds of iron');
  assert.deepEqual(hauling(f, ana, id), { depositId: f.deposit.id, material: 'ferro', phase: 'home' });
  f.run(3); assert(f.until(() => !f.room.records.get(id).service, 10), 'turned about for home');
  const left = carried().ferro; panel = page.look({ picked: [id] });
  assert(Math.abs(left - (aboard - out)) <= 100, 'what it took on before it drove off is little'); assert.match(row(panel).status, /^transportando · voltando à base · \d+%$/);
  const phases = new Set();
  assert(f.until(() => { phases.add(hauling(f, ana, id)?.phase); return !carried().ferro; }, 240), 'it gets home and is unloaded');
  assert.deepEqual([...phases], ['home', 'unload'], 'it did not turn back for more'); assert(Math.abs(brought() - before - left) <= 2, 'what was left is the faction\'s');
  assert(f.until(() => hauling(f, ana, id)?.phase === 'out', 10), 'and it goes out to its vein again');
});

test('where a lorry tipped part of its load out it is not filled up again: by its vein it stays lighter, a haul ordered there begins by going home, and gone on from there it loads as ever', t => {
  const f = field(t), [ana] = f.players, id = f.fielded(ana, 'truck'), [hopper] = f.parts(id, 'hopper'), carried = () => f.parts(id, 'hopper')[0].cargo.ferro || 0,
    tip = () => f.send(ana, 'dump-cargo', { actorId: id }).dumped.ferro, loading = () => f.room.records.get(id).loading;
  // Standing over a public pile with no order, it loads what is already extracted.
  f.room.extracted.set(f.deposit.id, 20000);
  const dock = workArea(f.room.world, id, f.deposit, LOAD_REACH).goal;
  f.put(id, dock); assert(f.until(() => loading(), 30), 'it loads where it stands');
  f.set(hopper, { cargo: { ferro: 6000 } }); f.run(1);
  // Too heavy to drive off, it tips a quarter out: the vein beside it gives it nothing back while it stands there, however long.
  const aboard = carried(); assert(tip() > 1000);
  const left = carried(); assert(left < aboard - 1000);
  f.run(10); assert.deepEqual([carried(), loading()], [left, null], 'nothing is taken on where it tipped');
  // A haul ordered there takes what it has left home first, and goes on from home.
  f.order(ana, 'haul', { ids: [id], depositId: f.deposit.id });
  assert.equal(hauling(f, ana, id).phase, 'home'); f.run(.5); assert.equal(carried(), left);
  f.order(ana, 'stop', { ids: [id] });
  // Driven on from there, it is a lorry like any other: back by the vein it loads, and a haul ordered begins at the vein.
  f.run(6); // finish the turn for home before positioning its container over the pile again
  f.put(id, dock + LOAD_REACH + 5); f.run(.5); f.put(id, workArea(f.room.world, id, f.deposit, LOAD_REACH).goal);
  assert(f.until(() => loading() && carried() > left, 30), 'it loads again: ' + JSON.stringify({
    loading: loading(), carried: carried(), left, area: workArea(f.room.world, id, f.deposit, LOAD_REACH), tipped: f.room.records.get(id).tipped }));
  f.order(ana, 'haul', { ids: [id], depositId: f.deposit.id }); assert.equal(hauling(f, ana, id).phase, 'out');
});

test('veins found are said once, several in one sentence, and none is said lost; the vein a hauler of the player found empty is told by the hauler', () => {
  const vein = (id, name, where) => ({ id, name, where }), a = vein('ferro:1', 'Ferro', 'a 400 m ←'), b = vein('ferro:7', 'Ferro', 'a 1,8 km →'), c = vein('ligas:2', 'Ligas', 'a 2,3 km ←'),
    d = vein('silica:5', 'Sílica', 'a 3,0 km →'), watch = (veins, more = {}) => ({ faction: 'green', fell: null, recovered: null, met: [], units: [{ id: 'a', label: 'Veículo 1 · Caminhão' }],
      repairs: [], partly: [], cancelled: [], turns: [], builds: [], facing: {}, gone: {}, ills: [], hauls: [], batteries: [], veins, ...more }), memo = {};
  assert.deepEqual(fieldNotices(memo, watch([a]), 0), [], 'those it knew when the player first looked are on the list');
  assert.deepEqual([fieldNotices(memo, watch([a, b]), 1), memo.grave], [['Jazida de Ferro encontrada a 1,8 km →.'], false]);
  assert.deepEqual(fieldNotices(memo, watch([a, b]), 2), []);
  assert.deepEqual(fieldNotices(memo, watch([a, b, c, d]), 3), ['Jazidas encontradas: Ligas a 2,3 km ←, Sílica a 3,0 km →.']);
  // A vein known is never lost: emptied, it comes back. One the list goes without is not said to have run out; back on it, it
  // is said found as any other.
  assert.deepEqual(fieldNotices(memo, watch([b, c, d]), 4), []); assert.deepEqual(fieldNotices(memo, watch([d]), 5), []);
  assert.deepEqual(fieldNotices(memo, watch([c]), 40), ['Jazida de Ligas encontrada a 2,3 km ←.']);
  // A page that has not the ground of the field at hand — in the workshop, before the first frame — cannot tell the veins: it says nothing, and goes on from those it last could.
  assert.deepEqual(fieldNotices(memo, watch(null), 41), []); assert.deepEqual(fieldNotices(memo, watch(null), 42), []);
  assert.deepEqual(fieldNotices(memo, watch([c, a]), 80), ['Jazida de Ferro encontrada a 400 m ←.']);
  // The vein a hauler of the player works is found empty: the hauler says so, and that the vein comes back; the vein stays on the list.
  const home = { id: 'a', key: 'vein-empty:ferro:1', text: 'Veículo 1 · Caminhão: jazida de Ferro vazia · recuperando — volta à base ou ao posto e fica lá. Mande-o de novo mais tarde ou a outro local de coleta.' },
    stopped = { ...home, key: 'vein-empty:' };
  assert.deepEqual(fieldNotices(memo, watch([c, a, b]), 120), ['Jazida de Ferro encontrada a 1,8 km →.']);
  assert.deepEqual(fieldNotices(memo, watch([c, a, b]), 121), []);
  assert.deepEqual([fieldNotices(memo, watch([c, a, b], { hauls: [home] }), 122), memo.grave], [[home.text], false]);
  assert.deepEqual(fieldNotices(memo, watch([c, a, b], { hauls: [home] }), 123), [], 'for as long as it is on its way home, once');
  assert.deepEqual(fieldNotices(memo, watch([c, a, b], { hauls: [stopped] }), 124), [], 'home and stopped, it does not say so again');
  // Sent to another vein, it has nothing to say; that one found empty under it is said, soon as it comes after the first.
  assert.deepEqual(fieldNotices(memo, watch([c, a, b]), 125), []);
  assert.deepEqual([fieldNotices(memo, watch([c, a, b], { hauls: [{ ...home, key: 'vein-empty:ferro:7' }] }), 126), memo.grave], [[home.text], false]);
  // A faction that lost its base knows no way to its veins; one that establishes another is not said to have found the veins
  // about it, and whoever comes into another faction is told nothing of what that one knew.
  const fell = { at: 129, text: 'Sua base foi tomada.' }, again = { fell, recovered: { at: 130, base: true, text: 'Base estabelecida a 37,4 km → da que foi tomada.' } };
  assert.deepEqual(fieldNotices(memo, watch(null, { fell }), 129), [fell.text]);
  assert.deepEqual(fieldNotices(memo, watch([c, d], again), 130), [again.recovered.text]);
  assert.deepEqual(fieldNotices(memo, watch([c, d, a], again), 180), ['Jazida de Ferro encontrada a 400 m ←.'], 'what it finds from there is said as ever');
  assert.deepEqual(fieldNotices(memo, watch([b], { faction: 'blue' }), 181), []); assert.deepEqual(fieldNotices(memo, watch([b, c], { faction: 'blue' }), 220), ['Jazida de Ligas encontrada a 2,3 km ←.']);
});

test('what is said aloud is said once: nothing at the first look, nothing twice within half a minute', () => {
  const watch = (ills = [], units = [{ id: 'a', label: 'Veículo 1 · Caminhão' }]) => ({ faction: 'green', fell: null, recovered: null, met: [], units, repairs: [], partly: [], cancelled: [], turns: [], builds: [], facing: {}, gone: {}, hauls: [], batteries: [], veins: null,
    ills: ills.map(key => ({ id: 'a', key, text: `Veículo 1 · Caminhão: ${key}.` })) }), memo = {};
  assert.deepEqual(fieldNotices(memo, watch(['dry']), 0), [], 'what was so before the player looked is in the rows');
  assert.deepEqual(fieldNotices(memo, watch(['dry', 'gun']), 1), ['Veículo 1 · Caminhão: gun.']);
  assert.deepEqual(fieldNotices(memo, watch(['dry']), 2), []); assert.deepEqual(fieldNotices(memo, watch(['dry', 'gun']), 20), [], 'the same trouble back within half a minute');
  assert.deepEqual(fieldNotices(memo, watch(['dry']), 21), []); assert.deepEqual(fieldNotices(memo, watch(['dry', 'gun']), 40), ['Veículo 1 · Caminhão: gun.']);
  // A page with no field to watch forgets what it watched, and starts again in silence.
  assert.deepEqual(fieldNotices(memo, null, 41), []); assert.deepEqual(fieldNotices(memo, watch(['low']), 42), []);
  // A vehicle that is gone with nothing left of it — taken apart at the base, replaced — is no loss to tell.
  assert.deepEqual(fieldNotices(memo, watch([], []), 43), []);
});

test('a gun the base placed by its fire is said once while it is held, several in one sentence, and is heard as a contact is', () => {
  const gun = (id, text, by = 'radar', x = 6100) => ({ id, by, x, text }), a = gun('a', 'a 6,1 km → da base (±92 m)'), b = gun('b', 'a 3,4 km ← da base (±204 m)', 'sound', -3400), memo = {},
    watch = (batteries, more = {}) => ({ faction: 'green', fell: null, recovered: null, met: [], units: [], repairs: [], partly: [], cancelled: [], turns: [], builds: [], facing: {}, gone: {}, ills: [], hauls: [], veins: null, batteries, ...more });
  assert.deepEqual([fieldNotices(memo, watch([a]), 0), memo.spotted, memo.place], [[], false, null], 'what was held before the player looked is on the field');
  assert.deepEqual([fieldNotices(memo, watch([a, b]), 1), memo.spotted, memo.grave, memo.place], [['Fogo inimigo localizado a 3,4 km ← da base (±204 m), pelo som.'], true, false, -3400], 'with the place to go and look at');
  assert.deepEqual([fieldNotices(memo, watch([a, b]), 2), memo.spotted, memo.place], [[], false, null], 'held on, it says nothing more');
  assert.deepEqual(fieldNotices(memo, watch([a, { ...b, by: 'radar', text: 'a 3,4 km ← da base (±51 m)' }]), 3), [], 'nor when the radar comes to follow what the ears had');
  // Let go and placed again, it is said again: both in one sentence, and not twice within half a minute.
  assert.deepEqual(fieldNotices(memo, watch([]), 4), []);
  assert.deepEqual([fieldNotices(memo, watch([a, b]), 70), memo.spotted, memo.place], [['Fogo inimigo localizado: a 6,1 km → da base (±92 m), a 3,4 km ← da base (±204 m).'], true, 6100], 'of several, the first');
  assert.deepEqual(fieldNotices(memo, watch([]), 71), []); assert.deepEqual([fieldNotices(memo, watch([a, b]), 80), memo.spotted], [[], false]);
  assert.deepEqual(fieldNotices(memo, watch([a]), 81), []); assert.deepEqual(fieldNotices(memo, watch([a, gun('c', 'a 900 m → da base (±20 m)')]), 82), ['Fogo inimigo localizado a 900 m → da base (±20 m), pelo radar da base.']);
  // Whoever comes into another faction is told nothing of what its base held.
  assert.deepEqual([fieldNotices(memo, watch([b], { faction: 'blue' }), 200), memo.spotted], [[], false]);
});
