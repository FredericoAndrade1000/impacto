import test from 'node:test';
import assert from 'node:assert/strict';
import { fieldPanel, fieldNotices, fieldOf, ORDERS } from '../src/field-panel.ts';
import { bill, load } from '../src/economy.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';

// The side panel is a function of the situation: every test here is one situation, told from the frame, the
// faction and the player's choice, and read as the player would read the panel.
const BASE = { x: 1000, y: 12, facing: 1, radius: 100 };
const piece = (actorId, kind, patch = {}) => ({ id: `${actorId}:${kind}`, actorId, kind, health: 100, maxHealth: 100, ...patch });
const gun = (actorId, patch) => piece(actorId, 'weapon', { weaponPreset: 'rh120', ...patch });
const rounds = (actorId, count = 28) => piece(actorId, 'ammo', { ammoPreset: 'rh120', rounds: count });
// A construction as the faction tells it: away from its base and from any supply vehicle unless told otherwise, and in its base served and mended by it.
const told = (id, patch = {}) => { const unit = { id, vehicle: true, value: bill(9000), built: bill(10000), repair: bill(), repairSeconds: 0, rearm: bill(), atBase: false, calm: true, still: true,
  service: null, cargo: load(), fill: { solid: 0, liquid: 0, supplies: 0 }, loading: null, supplies: null, serves: false, load: null, mend: null, ...patch };
  return { point: unit.atBase ? { supplier: null, stock: null, held: '', resupply: unit.rearm } : null, mender: unit.atBase ? { supplier: null, stock: null, held: '' } : null, ...unit }; };
const order = (id, patch = {}) => ({ id, role: 'armor', defeated: false, stance: 'return', move: null, attack: null, haul: null,
  alert: false, heard: null, activity: 'idle', reason: '', targetId: null, ...patch });
const ANA = { id: 'ana', name: 'Ana', color: '#9c6', connected: true, actors: [] };
// An ore truck loading at a deposit far from the base, and a tank that came back to the base hit.
const TRUCK = { id: 'truck', name: 'Caminhão', x: 5000, pieces: [piece('truck', 'hopper')], quote: { cargo: load(4250), fill: { solid: .38, liquid: 0 }, loading: 'ferro:1' } };
const TANK = { id: 'tank', name: 'Blindado', x: 1010, pieces: [gun('tank'), rounds('tank')], quote: { atBase: true, repair: bill(2013), repairSeconds: 9 } };
// The one job of whatever carries something away from its base: to tip part of it out, and weigh less.
const DUMP = { id: 'dump', text: 'Despejar ¼ da carga', disabled: false, title: 'Alivia o peso: o que sai fica no chão e se perde.' };
// The sites of the ground about them, as the page has them, and the veins the faction knows there: of the third site it was told nothing.
const GROUND = [{ id: 'ferro:1', x: 5200, material: 'ferro', feature: 'outcrop', reserve: 62000 }, { id: 'petroleo:4', x: 5400, material: 'petroleo', feature: 'lowland', reserve: 66000 },
  { id: 'ferro:2', x: 5700, material: 'ferro', feature: 'ruins', reserve: 62500 }];
const vein = (id, patch = {}) => ({ id, left: GROUND.find(site => site.id === id).reserve, at: null, seen: true, loading: false, active: true, ...patch }), VEINS = [vein('ferro:1'), vein('petroleo:4')];

// The shared field as the page has it: `vehicles` are the player's, `others` what else stands there.
function field({ vehicles = [], manual = null, others = [], faction: patch = {}, time = 100 } = {}) {
  const units = vehicles.map(v => told(v.id, v.quote)), faction = { id: 'green', ref: 'r-green', name: 'Ana', stock: bill(60000, 0, 0, 1500), yard: load(), base: BASE, members: [{ id: 'ana', name: 'Ana', connected: true }],
    known: [], strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], recovery: null, fell: null, recovered: null, count: units.length,
    counts: { vehicles: units.filter(unit => unit.vehicle).length, fixed: units.filter(unit => !unit.vehicle).length }, units, wrecks: [], deposits: VEINS, ...patch };
  const state = { shared: true, time, localPlayerId: 'ana', faction, players: [ANA], plates: [],
    squad: vehicles.length ? { manual, out: [], units: vehicles.map(v => order(v.id, v.order)) } : null,
    actors: [...vehicles.map(v => ({ id: v.id, ownerId: 'ana', team: 'green', name: v.name, x: v.x,
      vehicle: { x: v.x, y: 1, fuelLitres: v.fuel?.[0] ?? 180, fuelStarved: Boolean(v.fuelStarved), rangeKm: v.fuel?.[1] ?? 240, ...v.vehicle }, ...(v.eyes && { eyes: v.eyes }) })), ...others],
    modules: [...vehicles.flatMap(v => [piece(v.id, 'command', { health: 80 }), ...(v.pieces || [])]), ...others.filter(a => !a.ghost).map(a => piece(a.id, 'command'))] };
  return { state, faction };
}
const panel = (world, options = {}) => fieldPanel({ tab: 'test', shared: true, connected: true, state: world.state, faction: world.faction, playerId: 'ana', ...options });

test('airdrop UI waits for authoritative shared time and announces each phase once', () => {
  const memo = {}, drop = { id: 'airdrop:1', type: 'airdrop', feature: 'airdrop', x: 18000, material: 'ferro', reserve: 0, left: 0,
    stock: 4000, arrivesAt: 200, expiresAt: 500, active: false, guarded: true },
    phases = [
      { phase: 'announcement', time: 190, stock: 4000, text: /Airdrop.*chegada em 10 s/, label: 'Remessa 4 t' },
      { phase: 'collection', time: 220, stock: 2500, active: true, text: /Airdrop.*coleta por 280 s/, label: 'Pronto 2,5 t' },
      { phase: 'withdrawal', time: 400, stock: 0, retireAt: 415, text: /Airdrop encerrado.*15 s/, label: 'Pronto 0 kg' },
    ];
  for (const { time, text, label, ...phase } of phases) {
    const world = field({ time, faction: { deposits: [], activity: { ...drop, ...phase } } }),
      previous = memo.watch,
      waiting = [null, { ...world.state, shared: false }, { ...world.state, time: undefined },
        { ...world.state, time: NaN }, { ...world.state, time: Infinity }];
    for (const state of waiting) {
      const shown = panel(world, { state }), row = shown.veins[0];
      assert.equal(row.name, 'Airdrop · Ferro bruto'); assert.equal(row.share, null);
      assert.equal(row.lines[0], 'Aguardando tempo do campo'); assert.equal(row.lines[1], label);
      assert.equal(shown.watch.partial, true);
      assert.deepEqual(fieldNotices(memo, shown.watch, time), []);
      assert.equal(memo.watch, previous, 'a partial welcome never replaces the previous complete watch or announces removal');
    }
    const shown = panel(world);
    assert.equal(world.state.squad, null, 'a valid field clock needs no squad');
    assert.equal(shown.watch.partial, false); assert.match(shown.veins[0].lines[0], text);
    const said = fieldNotices(memo, shown.watch, time);
    assert.equal(said.length, 1); assert.match(said[0], text); assert.equal(memo.items[0].grave, false);
    assert.deepEqual(fieldNotices(memo, panel(world).watch, time + 1), [], 'the same frame/faction never repeats its phase notice');
  }
  const gone = panel(field({ time: 420, faction: { deposits: [], activity: null } }));
  assert.deepEqual(gone.veins, []);
  assert.deepEqual(fieldNotices(memo, gone.watch, 420), ['O airdrop saiu dos recursos conhecidos desta facção.']);
  assert.deepEqual(fieldNotices(memo, gone.watch, 421), []);
  const refinedMemo = {}, refined = { id: drop.id, type: 'airdrop', feature: 'airdrop', x: drop.x, supplies: bill(48000, 16000, 12000, 4000),
    refined: true, guarded: true, phase: 'announcement', arrivesAt: 3700, expiresAt: 32500 },
    show = (time, activity, faction = {}) => panel(field({ time, faction: { deposits: [], activity, ...faction } }));
  const announcing = show(100, refined);
  assert.equal(announcing.veins[0].name, 'Airdrop · Suprimentos');
  assert.equal(announcing.veins[0].lines[0], 'Airdrop · chegada em 1:00:00');
  assert.equal(announcing.veins[0].lines[1], 'Remessa · 42,2 m³ de suprimentos');
  assert.equal(fieldNotices(refinedMemo, announcing.watch, 100).length, 1);
  const partial = panel(field({ faction: { deposits: [], activity: refined } }), { state: null });
  assert.equal(partial.veins[0].lines[0], 'Aguardando tempo do campo');
  assert.deepEqual(fieldNotices(refinedMemo, partial.watch, 101), []);
  const ready = show(3700, { ...refined, phase: 'collection', active: true });
  assert.equal(ready.veins[0].lines[0], 'Airdrop · coleta por 8:00:00');
  assert.equal(fieldNotices(refinedMemo, ready.watch, 3700).length, 1);
  assert.deepEqual(fieldNotices(refinedMemo, ready.watch, 3701), []);
  const reduced = show(3701, { ...refined, supplies: bill(24000, 8000, 6000, 2000), phase: 'collection', active: true });
  assert.equal(reduced.veins[0].lines[1], 'Disponível · 21,1 m³ de suprimentos');
  assert.deepEqual(fieldNotices(refinedMemo, reduced.watch, 3701), [], 'a changed balance updates the card without repeating the same phase announcement');
  const otherFaction = show(3702, null, { id: 'unknown' });
  assert.deepEqual(otherFaction.veins, []);
  assert.deepEqual(fieldNotices(refinedMemo, otherFaction.watch, 3702), [], 'switching to an unnotified faction does not claim the global event ended or disclose its location');
});

test('airdrop UI offers Transportar only to compatible own mobile recipients while commanding', () => {
  const worker = (id, kind, patch = {}) => ({ ...TRUCK, id, name: id, quote: {}, pieces: [piece(id, kind)], ...patch }),
    world = field({ vehicles: [TRUCK, worker('tool', 'excavator'), worker('oil', 'cistern'), worker('fixed', 'hopper'),
      worker('held', 'hopper', { order: { by: 'friend' } }), worker('ruin', 'hopper', { order: { defeated: true } })],
    faction: { deposits: [], activity: { id: 'airdrop:1', type: 'airdrop', x: 18000, material: 'ferro', reserve: 0, left: 0,
      stock: 4000, phase: 'collection', arrivesAt: 80, expiresAt: 600, active: true } } }),
    picked = ['truck', 'tool', 'oil', 'fixed', 'held', 'ruin'];
  world.state.actors.find(actor => actor.id === 'fixed').vehicle = null;
  world.faction.units.find(unit => unit.id === 'fixed').vehicle = false;
  world.state.actors.find(actor => actor.id === 'held').ownerId = 'friend';
  const before = structuredClone(world), selection = [...picked];
  for (const touch of [false, true]) {
    const shown = panel(world, { picked, touch }), collect = shown.veins[0].collect;
    assert.deepEqual(collect.ids, ['truck']);
    assert.deepEqual([collect.name, collect.label], ['Transportar', 'Transportar']);
    assert.match(collect.title, /sem precisar extrair/);
    assert.equal(panel(world, { picked, touch, tab: 'edit', price: bill(1000) }).veins[0].collect, null);
    assert.equal(panel(world, { picked, touch, connected: false }).veins.length, 0);
    const direct = { ...world, state: { ...world.state, squad: { ...world.state.squad, manual: 'truck' } } };
    assert.equal(panel(direct, { picked, touch }).veins[0].collect, null);
  }
  assert.deepEqual(world, before, 'offering a public collection changes no cargo, unit or accepted order');
  assert.deepEqual(picked, selection);
  const activity = world.faction.activity, trip = { depositId: activity.id, material: 'ferro', phase: 'out' },
    miner = { ...TRUCK, pieces: [...TRUCK.pieces, piece('truck', 'excavator')] },
    going = panel(field({ vehicles: [{ ...miner, quote: {}, order: { haul: trip } }], faction: { deposits: [], activity } }), { picked: ['truck'], armed: 'haul' }),
    home = panel(field({ vehicles: [{ ...miner, quote: {}, order: { reason: 'vein-spent:ferro', haul: { ...trip, phase: 'home' } } }], faction: { deposits: [], activity: null } })),
    stopped = field({ vehicles: [{ ...TRUCK, quote: {}, order: { reason: 'vein-spent:ferro' } }], faction: { deposits: [], activity: null } });
  assert.equal(going.squad.units[0].status, 'transportando · indo à coleta · 0%');
  assert.match(going.armed, /local de coleta/); assert.doesNotMatch(going.armed, /jazida/);
  assert.equal(home.squad.units[0].status, 'transportando · voltando à base · 0% · coleta de Ferro encerrada');
  const another = panel(field({ vehicles: [{ ...miner, quote: {}, order: { haul: { ...trip, phase: 'home' } } }], faction: { deposits: [], activity: { ...activity, id: 'airdrop:2' } } })),
    natural = panel(field({ vehicles: [{ ...miner, quote: {}, order: { haul: { ...trip, depositId: 'ferro:1' } } }], faction: { activity: null } }));
  assert.equal(another.squad.units[0].status, 'transportando · voltando à base · 0%', 'a new public event cannot relabel the previous load as extraction');
  assert.equal(natural.squad.units[0].status, 'extração e transporte · indo à coleta · 0%', 'natural excavation keeps its specific activity label');
  assert.equal(panel(stopped).squad.units[0].status, 'parado · coleta de Ferro encerrada');
  assert.match(panel(stopped).watch.hauls[0].text, /coleta de Ferro encerrada.*Escolha outro local de coleta/);
  assert.equal(stopped.state.squad.units[0].reason, 'vein-spent:ferro', 'transport wording needs no new stored reason');

  const refinedTrip = { depositId: activity.id, refined: true, phase: 'out' },
    suppliedActivity = { id: activity.id, type: 'airdrop', x: activity.x, supplies: bill(48000, 16000, 12000, 4000),
      refined: true, phase: 'collection', arrivesAt: 80, expiresAt: 600, active: true },
    supplyWorld = field({ vehicles: [TRUCK, worker('supply', 'supply', { quote: { fill: { solid: 0, liquid: 0, supplies: .4 } },
      order: { haul: refinedTrip } }), worker('fixed', 'supply'), worker('held', 'supply', { order: { by: 'friend' } }),
      worker('broken', 'supply', { pieces: [piece('broken', 'supply', { health: 0 })] }),
      worker('detached', 'supply', { pieces: [piece('detached', 'supply', { attached: false })] })],
    faction: { deposits: [], activity: suppliedActivity } }),
    supplyPicked = ['truck', 'supply', 'fixed', 'held', 'broken', 'detached'];
  supplyWorld.state.actors.find(actor => actor.id === 'fixed').vehicle = null;
  supplyWorld.faction.units.find(unit => unit.id === 'fixed').vehicle = false;
  supplyWorld.state.actors.find(actor => actor.id === 'held').ownerId = 'friend';
  const untouched = structuredClone(supplyWorld);
  for (const touch of [false, true]) {
    const refined = panel(supplyWorld, { picked: supplyPicked, touch });
    assert.deepEqual(refined.veins[0].collect.ids, ['supply']);
    assert.deepEqual(refined.orders.find(o => o.id === 'haul').ids, ['supply']);
    assert.match(refined.veins[0].collect.title, /recursos refinados.*Suprimentos.*estoque/);
    assert.equal(refined.squad.units.find(unit => unit.id === 'supply').status, 'transportando · indo à coleta · 40%');
    const partialWorld = structuredClone(supplyWorld);
    partialWorld.faction.activity.supplies = bill(0, 0, 120, 40);
    const partialSupply = panel(partialWorld, { picked: supplyPicked, touch });
    assert.deepEqual(partialSupply.veins[0].collect.ids, ['supply'], 'a non-Ferro remainder keeps the same compatible supply recipient');
  }
  assert.deepEqual(supplyWorld, untouched);
  // Taken all, the cargo is collected no longer (world-activities.ts `collecting`): it is withdrawn, and there is nowhere to send the vehicle now.
  const spent = panel(field({ vehicles: [worker('supply', 'supply')],
    faction: { deposits: [], activity: { ...suppliedActivity, supplies: bill(), phase: 'withdrawal', retireAt: 115, active: false } } }), { picked: ['supply'] });
  assert.equal(spent.veins[0].collect, null); assert.match(spent.refused.haul, /Nenhum local de coleta compatível está disponível agora\. Confira o prazo/);
});
// A row of what is wrong with a vehicle, as the panel watches it: its words, and the sentence they are said in.
const trouble = (id, key, text) => ({ id, key, words: text.slice(text.indexOf(': ') + 2, -1), text });
const ids = list => list.map(item => item.id);
// The veins whose mark has the button that sends those picked there.
const collected = p => ids(p.veins.filter(row => row.collect));
// What is done to those picked, from Mais ações, and the dismantling of them.
const acts = p => ids(p.actions), dismantling = p => p.actions.find(action => action.id === 'dismantle');
// The gauges of the vehicle the panel speaks of, each by its words.
const gauges = p => p.stats && Object.fromEntries(Object.entries(p.stats).filter(([, gauge]) => gauge).map(([id, gauge]) => [id, gauge.text]));

const SUPPLIER = { id: 'supply', name: 'Suprimentos', x: 2000, pieces: [piece('supply', 'supply')],
  quote: { supplies: bill(100, 0, 0, 30), serves: true, fill: { solid: 0, liquid: 0, supplies: .2 },
    auto: false, job: { kind: null, phase: 'paused', targetId: null, reason: '' } } };

test('the automatic switch is an explicit choice of the one vehicle picked, distinct from local automatic service', () => {
  const world = field({ vehicles: [SUPPLIER, TANK] }), before = structuredClone(world),
    off = panel(world, { picked: ['supply'] });
  assert.equal(off.automatic.actorId, 'supply'); assert.equal(off.automatic.on, false);
  assert.match(off.automatic.title, /buscando na base só o necessário/);
  assert.match(off.automatic.title, /Uma ordem sua o pausa até ser cumprida; Parar o desliga/);
  for (const picked of [[], ['tank'], ['supply', 'tank']]) assert.equal(panel(world, { picked }).automatic, null);
  assert.equal(panel(world, { picked: ['supply'], connected: false }).automatic, null);
  assert.equal(panel(world, { picked: ['supply'], tab: 'edit', price: bill() }).automatic, null);
  assert.equal(panel(field({ vehicles: [{ ...SUPPLIER, quote: { ...SUPPLIER.quote, auto: undefined } }] }), { picked: ['supply'] }).automatic, null,
    'an older quote is not treated as authorization to start an automatic job');
  assert.deepEqual(world, before, 'presentation never turns the supplier on');
});

// An aircraft picked alone, or in hand, has the switch of its fuel return (squad.ts `homing`), as the faction tells it; a
// vehicle that does not fly, a group and a quote that does not tell it have none.
test('an aircraft picked alone has the switch of its fuel return, which says what it does on and off', () => {
  const AIR = { id: 'air', name: 'Aeronave', x: 1500, pieces: [piece('air', 'thruster'), piece('air', 'fuel', { fuelLitres: 180, capacityLitres: 200 })],
      vehicle: { thrustN: 90000, flying: true }, quote: { homing: true } },
    world = field({ vehicles: [AIR, TANK] }), on = panel(world, { picked: ['air'] });
  assert.deepEqual(Object.keys(on.homing), ['actorId', 'on', 'status', 'title']);
  assert.deepEqual([on.homing.actorId, on.homing.on], ['air', true]);
  assert.match(on.homing.status, /Volta sozinha para reabastecer e recusa ordens/);
  assert.match(on.homing.title, /guarda combustível para voltar à base.*Desligada, cumpre toda ordem, mesmo até ficar sem combustível/);
  const off = panel(field({ vehicles: [{ ...AIR, quote: { homing: false } }] }), { picked: ['air'] });
  assert.equal(off.homing.on, false); assert.match(off.homing.status, /Não volta sozinha para reabastecer: cumpre toda ordem/);
  assert.equal(panel(field({ vehicles: [AIR], manual: 'air' })).homing.actorId, 'air', 'in hand too');
  for (const picked of [[], ['tank'], ['air', 'tank']]) assert.equal(panel(world, { picked }).homing, null);
  assert.equal(panel(field({ vehicles: [{ ...AIR, quote: {} }] }), { picked: ['air'] }).homing, null);
  assert.equal(panel(world, { picked: ['air'], connected: false }).homing, null);
});

test('a raw transporter reuses the single automatic switch and names ready pickup rather than automatic mining', () => {
  const truck = { ...TRUCK, quote: { ...TRUCK.quote, auto: false, job: { kind: null, phase: 'paused', targetId: null, reason: '' } } },
    off = panel(field({ vehicles: [truck] }), { picked: ['truck'] });
  assert.equal(off.automatic.on, false); assert.match(off.automatic.title, /recolhe cargas prontas conhecidas.*sem escavar/);
  assert.match(off.automatic.title, /Uma ordem sua o pausa.*Parar o desliga/);
  for (const [phase, text] of [['out', 'indo recolher material pronto'], ['load', 'carregando material pronto'],
    ['home', 'levando a carga à base'], ['unload', 'descarregando na base']]) {
    const going = panel(field({ vehicles: [{ ...truck, quote: { ...truck.quote, auto: true, job: { kind: 'haul', phase, targetId: 'ferro:1', reason: '' } } }] }), { picked: ['truck'] });
    assert.equal(going.automatic.status, text);
  }
  const held = panel(field({ vehicles: [{ ...truck, quote: { ...truck.quote, auto: true,
    job: { kind: null, phase: 'idle', targetId: null, reason: 'no-loader' } } }] }), { picked: ['truck'] });
  assert.equal(held.automatic.status, 'o equipamento não alcança o local de coleta; reposicione-o na Oficina');
  // A pile it takes on by its way home with a load is told as such, and where it lies; on from there it takes the load home.
  const passing = (phase, deposits = GROUND) => panel(field({ vehicles: [{ ...truck, quote: { ...truck.quote, auto: true,
    job: { kind: 'haul', phase, targetId: 'ferro:1', reason: '', passing: 'ferro' } } }] }), { picked: ['truck'], deposits }).automatic.status;
  assert.equal(passing('out'), 'pegando Ferro no caminho · jazida a 4,2 km → da base');
  assert.equal(passing('load'), 'pegando Ferro no caminho · jazida a 4,2 km → da base');
  assert.equal(passing('out', []), 'pegando Ferro no caminho', 'a site the page does not know is not named');
  assert.equal(passing('home'), 'levando a carga à base');
});

test('a job status follows published phases, target and remaining cargo without fake movements', () => {
  const supplier = patch => ({ ...SUPPLIER, quote: { ...SUPPLIER.quote, auto: true, ...patch } }),
    show = (phase, reason = '', patch = {}) => panel(field({ vehicles: [TANK, supplier({ job: { kind: ['idle', 'return', 'paused'].includes(phase) ? null : 'rearm',
      phase, targetId: 'tank', reason }, ...patch })] }), { picked: ['supply'] });
  assert.equal(show('collect').automatic.status, 'buscando suprimentos na base');
  assert.equal(show('deliver').automatic.status, 'levando suprimentos ao veículo 1');
  assert.match(show('deliver').squad.units[1].status, /^levando suprimentos ao veículo 1/);
  assert.equal(show('return').automatic.status, 'voltando à base com a carga restante');
  assert.equal(show('return', '', { supplies: bill() }).automatic.status, 'voltando à base');
  assert.equal(show('return', '', { atBase: true }).automatic.status, 'devolvendo suprimentos na base');
  // Given nothing, it says why, and of what job.
  assert.equal(show('idle', 'waiting-stock').automatic.status, 'aguardando estoque na base · veículo 1');
  assert.equal(show('idle', 'waiting-fuel').automatic.status, 'aguardando combustível para a viagem · veículo 1');
  assert.equal(show('idle').automatic.status, 'aguardando trabalho');
  assert.equal(show('deliver', 'target-moving').automatic.status, 'aguardando o veículo 1 parar');
  // A portable save keeps the squad's move but not the transient dispatch job. The two authorities remain separate.
  const resumedSource = field({ vehicles: [{ ...supplier({ supplies: bill(), still: false,
    job: { kind: null, phase: 'idle', targetId: null, reason: '' } }), order: { move: { x: 3000 } } }] });
  resumedSource.state.actors[0].vehicle.vx = 52 / 3.6;
  const beforeResumeView = structuredClone(resumedSource), resumed = panel(resumedSource, { picked: ['supply'] });
  assert.match(resumed.squad.units[0].status, /^em movimento · faltam /);
  assert(!resumed.squad.units[0].status.includes('aguardando trabalho'));
  assert.equal(resumed.squad.units[0].doing, 'move');
  assert.equal(resumed.automatic.status, 'seguindo trajeto');
  assert.deepEqual(resumedSource, beforeResumeView, 'presentation preserves the published route and its idle job');
  const paused = show('paused');
  assert.equal(paused.automatic.on, true); assert.equal(paused.automatic.status, '');
});

test('waiting advice names an available remedy without changing orders or inventing a countdown', () => {
  const waiting = (reason, patch = {}, options = {}) => {
    const world = field({ vehicles: [{ ...SUPPLIER, quote: { ...SUPPLIER.quote, supplies: bill(), auto: true,
      job: { kind: null, phase: 'idle', targetId: null, reason }, ...patch } }] }), before = structuredClone(world),
      shown = panel(world, { picked: ['supply'], ...options });
    assert.deepEqual(world, before, 'explaining a wait does not alter the published state'); return shown;
  };
  assert.match(waiting('waiting-stock').advice, /materiais.*base.*[Ee]ntregue/);
  assert.match(waiting('waiting-fuel').advice, /tanque do motor.*base/);
  const threat = waiting('threat');
  assert.match(threat.advice, /[Cc]ombate|ameaça/); assert.match(threat.advice, /afaste|segur/); assert.doesNotMatch(threat.advice, /\d+ s/);
  assert.equal(waiting('unknown-future-reason').advice, '', 'unknown reasons do not acquire a guessed fix');
  assert.equal(waiting('threat', {}, { connected: false }).advice, '', 'old quotes cannot advise an offline field');
  assert.equal(waiting('waiting-stock', { service: { kind: 'repair', until: 140, cost: bill(20) } }).advice, '', 'the active service takes precedence');
  assert.match(waiting('manual-order', { auto: false, job: { kind: null, phase: 'paused', targetId: null, reason: 'manual-order' } }).advice,
    /Ligue.*Automático/);
  const work = { id: 'well', name: 'Poço', x: 5010, cost: bill(1000, 0, 0, 20), delivered: bill(1000), share: 0, progress: 0, waiting: true, lack: bill() },
    world = field({ vehicles: [{ ...SUPPLIER, quote: { ...SUPPLIER.quote, auto: true,
      job: { kind: 'build', phase: 'work', targetId: work.id, reason: '' } } }], faction: { works: [work] } });
  assert.match(panel(world, { picked: ['supply'] }).advice, /Falta entregar à obra: Combustível 20 L.*veículo de suprimentos/);
  world.faction.works = [{ ...work, id: 'another-work' }];
  assert.equal(panel(world, { picked: ['supply'] }).advice, '', 'the nearby work is not silently substituted for the published target');
});

test('engine fuel, ready petroleum cargo and construction supplies remain separate visible reserves', () => {
  const supplier = { ...SUPPLIER, fuel: [199, 219.3], pieces: [...SUPPLIER.pieces, piece('supply', 'cistern')],
      quote: { ...SUPPLIER.quote, cargo: load(0, 0, 0, 6750), supplies: bill(1000), fill: { solid: 0, liquid: .5, supplies: .1 } } },
    shown = panel(field({ vehicles: [supplier] }), { picked: ['supply'] });
  assert.match(shown.stats.fuel.text, /^199 L/);
  assert.match(shown.stats.cargo.title, /Petróleo 6.750 L/);
  assert.match(shown.stats.supplies.text, /Ferro 1.000/);
  assert.match(shown.stats.supplies.text, /Combustível 0 L/, 'a running engine or raw petroleum does not pay a works fuel bill');
  const paver = panel(field({ vehicles: [{ ...supplier, pieces: SUPPLIER.pieces,
    quote: { ...supplier.quote, cargo: load(), mix: { held: bill(0, 0, 100, 5), fill: .25 } } }] }), { picked: ['supply'] });
  assert.equal(paver.stats.cargo.label, 'Mistura de asfalto');
  assert.match(paver.stats.cargo.title, /Combustível 5 L/); assert.match(paver.stats.supplies.text, /Combustível 0 L/);
});

test('a supplier an order of the player\'s holds says so with its switch on, Stop says it put it out, and in hand the switch works either way', () => {
  const quote = (auto, reason) => ({ ...SUPPLIER.quote, auto, job: { kind: null, phase: 'paused', targetId: null, reason } }),
    supplier = { ...SUPPLIER, order: { move: { x: 3000 } }, quote: quote(true, 'manual-order') },
    commanded = panel(field({ vehicles: [supplier] }), { picked: ['supply'] }),
    stopped = panel(field({ vehicles: [{ ...SUPPLIER, quote: quote(false, 'manual-order') }] }), { picked: ['supply'] }),
    manual = panel(field({ vehicles: [{ ...supplier, quote: quote(true, 'manual-control') }], manual: 'supply' })),
    off = panel(field({ vehicles: [{ ...supplier, quote: quote(false, 'manual-control') }], manual: 'supply' }));
  assert.match(commanded.squad.units[0].status, /^em movimento/);
  assert.deepEqual([commanded.automatic.on, commanded.automatic.status], [true, 'pausado · cumprindo sua ordem']);
  assert.deepEqual([stopped.automatic.on, stopped.automatic.status], [false, 'desligado pela ordem Parar']);
  assert.deepEqual([manual.automatic.on, manual.automatic.status, off.automatic.on, off.automatic.status], [true, 'pausado · sob seu controle', false, 'sob seu controle']);
  assert.deepEqual(Object.keys(manual.automatic), ['actorId', 'on', 'status', 'title'], 'nothing keeps the switch from the vehicle in hand');
  assert.match(manual.automatic.title, /Uma ordem sua o pausa até ser cumprida; Parar o desliga/);
  assert.equal(manual.squad.units[0].doing, 'manual');
});

test('an empty vehicle in automatic does not raise the manual supplier exhaustion notice while it fetches or returns', () => {
  const supplier = { ...SUPPLIER, quote: { ...SUPPLIER.quote, supplies: bill(), auto: true,
    job: { kind: 'rearm', phase: 'collect', targetId: 'tank', reason: '' } } },
    active = panel(field({ vehicles: [supplier, TANK] }));
  assert.equal(active.watch.ills.some(ill => ill.key === 'spent'), false);
  const manual = panel(field({ vehicles: [{ ...supplier, quote: { ...supplier.quote, auto: false } }] }));
  assert.equal(manual.watch.ills.some(ill => ill.key === 'spent'), true, 'an ordinary empty supplier still keeps its resource notice');
});

test('resource exhaustion and ordinary haul interruptions are informative and never request an alert sound', () => {
  const haul = { depositId: 'ferro:1', material: 'ferro', phase: 'home' },
    extractor = { ...TRUCK, pieces: [piece('truck', 'excavator')], quote: {} },
    cases = [
      [TRUCK, { ...TRUCK, order: { reason: 'vein-empty:ferro', haul } }, /jazida de Ferro vazia · recuperando — volta à base/],
      [TRUCK, { ...TRUCK, order: { reason: 'vein-empty:ferro' } }, /jazida de Ferro vazia · recuperando/],
      [extractor, { ...extractor, order: { reason: 'vein-empty:ferro' } }, /jazida de Ferro vazia · recuperando — extração encerrada/],
      // A cargo dropped on the field and taken all: the place is gone.
      [TRUCK, { ...TRUCK, order: { reason: 'vein-spent:ferro', haul: { ...haul, depositId: 'airdrop:1' } } }, /coleta de Ferro encerrada/],
      [TRUCK, { ...TRUCK, order: { reason: 'haul-interrupted', haul: { ...haul, interrupted: true } } }, /trajeto de coleta interrompido/],
      [SUPPLIER, { ...SUPPLIER, order: { reason: 'supplies-spent', haul: { depositId: 'airdrop:1', refined: true, phase: 'home' } } }, /coleta de suprimentos encerrada.*volta à base/],
      [SUPPLIER, { ...SUPPLIER, quote: { ...SUPPLIER.quote, supplies: bill() } }, /suprimentos esgotados/],
    ];
  for (const [before, after, message] of cases) {
    const memo = {}, watch = panel(field({ vehicles: [after] })).watch;
    fieldNotices(memo, panel(field({ vehicles: [before] })).watch, 0);
    assert.equal(fieldNotices(memo, watch, 1).length, 1);
    const received = memo.items[0];
    assert.match(received.text, message); assert.equal(received.grave, false);
    assert.equal(memo.grave, false); assert.equal(memo.spotted, false, 'neither grave nor contact audio is requested');
    assert.deepEqual(fieldNotices(memo, watch, 2), []);
    if (after.order?.reason === 'supplies-spent') {
      assert.doesNotMatch(received.text, /Ferro|extração/);
      const stopped = panel(field({ vehicles: [{ ...after, order: { reason: 'supplies-spent' } }] })).watch;
      assert.deepEqual(fieldNotices(memo, stopped, 3), [], 'arrival clears the haul field without repeating this shipment completion notice');
    }
  }
});

test('low fuel reserve is informative but losing the range to reach the base escalates immediately', () => {
  const watch = range => panel(field({ vehicles: [{ ...TRUCK, fuel: [9, range], quote: {} }] })).watch, memo = {};
  fieldNotices(memo, watch(240), 0);
  assert.equal(fieldNotices(memo, watch(6), 1).length, 1, 'six kilometres still covers the four kilometres home');
  assert.equal(memo.items[0].grave, false); assert.equal(memo.grave, false); assert.equal(memo.spotted, false);
  assert.equal(fieldNotices(memo, watch(3.9), 2).length, 1, 'a new critical shortage is not hidden by the previous reserve notice');
  assert.equal(memo.items[0].grave, true); assert.equal(memo.grave, true);
  assert.deepEqual(fieldNotices(memo, watch(3.8), 3), [], 'the same critical condition does not repeat');
});

test('critical fuel, weapon and mobility failures still demand immediate attention', () => {
  for (const [healthy, failed, message] of [
    [TRUCK, { ...TRUCK, fuelStarved: true, fuel: [0, 0] }, /sem combustível/],
    [TANK, { ...TANK, pieces: [gun('tank', { health: 0 }), rounds('tank')] }, /arma inutilizada/],
    [TANK, { ...TANK, pieces: [gun('tank'), rounds('tank', 0)] }, /sem munição/],
    [TRUCK, { ...TRUCK, order: { haul: { depositId: 'ferro:1', material: 'ferro', phase: 'home', blocked: 'blocked-way' } } }, /caminho de volta bloqueado/],
  ]) {
    const memo = {}; fieldNotices(memo, panel(field({ vehicles: [healthy] })).watch, 0);
    fieldNotices(memo, panel(field({ vehicles: [failed] })).watch, 1);
    assert(memo.items.some(item => message.test(item.text) && item.grave)); assert.equal(memo.grave, true);
  }
});

test('new threats and encounters are announced even while the same worker already has a routine interruption', () => {
  const quiet = panel(field({ vehicles: [TRUCK] })).watch,
    routine = { id: 'truck', key: 'vein-empty:ferro:1', text: 'Jazida vazia.' },
    blocked = { ...routine, key: 'haul-interrupted', text: 'Trajeto interrompido.' },
    threat = { id: 'truck', key: 'enemy-near', event: 'encounter1', text: 'Inimigo perto.', x: 5000 }, memo = {};
  fieldNotices(memo, quiet, 0);
  assert.deepEqual(fieldNotices(memo, { ...quiet, hauls: [routine] }, 1), [routine.text]);
  assert.equal(memo.grave, false);
  assert.deepEqual(fieldNotices(memo, { ...quiet, hauls: [blocked] }, 2), [blocked.text]);
  assert.equal(memo.grave, false);
  assert.equal(fieldNotices(memo, { ...quiet, hauls: [threat] }, 3).length, 1); assert.equal(memo.grave, true);
  assert.deepEqual(memo.items[0].encounter, { id: 'contact:encounter1', x: 5000, approximate: true });
  assert.deepEqual(fieldNotices(memo, { ...quiet, hauls: [threat] }, 4), []);
  assert.equal(fieldNotices(memo, { ...quiet, hauls: [{ ...threat, event: 'encounter2' }] }, 5).length, 1);
  assert.equal(memo.grave, true); assert.equal(memo.items[0].encounter.id, 'contact:encounter2');
});

test('loss, hostile base capture and interrupted turning remain grave while routine completions stay informative', () => {
  const quiet = panel(field({ vehicles: [TANK] })).watch;
  for (const [before, after, expected] of [
    [quiet, { ...quiet, units: [], gone: { tank: '' } }, true],
    [quiet, { ...quiet, siege: true }, true],
    [quiet, { ...quiet, fell: { at: 1, text: 'Sua base foi tomada.' } }, true],
    [quiet, { ...quiet, recovered: { at: 1, base: true, text: 'Base estabelecida.' } }, false],
    [{ ...quiet, turns: ['tank'], facing: { tank: 1 } }, { ...quiet, facing: { tank: 1 } }, true],
    [{ ...quiet, repairs: ['tank'] }, quiet, false],
    [{ ...quiet, builds: ['tank'] }, quiet, false],
    [quiet, { ...quiet, taken: { at: 1, text: 'Base inimiga capturada.' } }, false],
  ]) {
    const memo = {}; fieldNotices(memo, before, 0);
    assert.equal(fieldNotices(memo, after, 1).length, 1);
    assert.equal(memo.grave, expected); assert.equal(memo.items[0].grave, expected);
  }
});

test('a pilot-confirmed physical stall remains a deduplicated alert and a report after reconnecting', () => {
  for (const reason of ['stuck-ground', 'stuck-grip', 'stuck-slope']) {
    const watch = (reason = '') => panel(field({ vehicles: [{ ...TRUCK, quote: {}, order: { reason } }] })).watch,
      memo = {}, first = watch(reason);
    assert.deepEqual(fieldNotices(memo, watch(), 100), []);
    assert.equal(fieldNotices(memo, first, 101).length, 1); assert.equal(memo.grave, true);
    assert.match(memo.items[0].text, /atolou|patina|sem força para a subida/);
    assert.deepEqual(fieldNotices(memo, first, 102), []);
    assert.deepEqual(fieldNotices(memo, first, 200), [], 'a standing failure is not repeated after the notice cooldown');
    const reconnected = {};
    assert.deepEqual(fieldNotices(reconnected, first, 201), []);
    assert.deepEqual(reconnected.entry.vehicles[0].problems, [first.ills[0].words]);
  }
});

test('a builder says what it works on beside it, which the field does by itself, and never offers cancel-repair for it', () => {
  const builder = (patch = {}, quote = {}) => ({ ...TRUCK, quote: { builder: { reach: 30, ready: true, reason: '', working: null, ...patch }, ...quote } }),
    work = { id: 'c9', name: 'Posto de defesa leve', x: 5020, facing: 1, cost: bill(4216), delivered: bill(4216), progress: .4, share: 1, seconds: 13,
      building: true, waiting: false, supplying: false, blocked: '', from: null, lack: bill() },
    show = (vehicle, patch = {}, options = { picked: ['truck'] }) => panel(field({ vehicles: [vehicle], faction: { works: [], ...patch } }), options);
  assert.deepEqual(show(builder()).builder, { status: '' });
  assert.equal(panel(field({ vehicles: [builder()] })).builder, null, 'nothing picked, no builder spoken of');
  assert.equal(show(builder({ ready: false, reason: 'Pare o construtor para montar ou desmontar.' })).builder.status, 'Pare o construtor para montar ou desmontar.');
  assert.equal(show(builder({ working: 'c9' }), { works: [work] }).builder.status, 'Montando Posto de defesa leve · 40%');
  assert.equal(show(builder(), { works: [{ ...work, building: false, waiting: true }] }).builder.status, 'Esperando material para Posto de defesa leve');
  assert.equal(show(builder(), { works: [{ ...work, x: 5200, building: false, waiting: true }] }).builder.status, '', 'a works waiting far from it is not its own');
  // In automatic, on a job: the line of its switch says what it does, on its way before why it works on nothing there yet, and
  // so does its row; its own block says nothing of it then.
  const sent = (reason = '') => builder({ ready: false, reason: 'Pare o construtor para montar ou desmontar.' }, { auto: true, job: { kind: 'build', targetId: 'c9', phase: 'go', reason } }),
    on = reason => show(sent(reason), { works: [{ ...work, x: 5300, building: false }] });
  assert.deepEqual(['', 'waiting-fuel', 'blocked-way'].map(reason => on(reason).automatic.status),
    ['indo à obra Posto de defesa leve', 'aguardando combustível para a viagem · Posto de defesa leve', 'caminho bloqueado · Posto de defesa leve']);
  assert.equal(on('').builder.status, '');
  assert.match(on('').automatic.title, /monta as obras e desmonta as estruturas/);
  const going = panel(field({ vehicles: [{ ...sent(), order: { move: { x: 5280 } } }], faction: { works: [{ ...work, x: 5300, building: false }] } }));
  assert.match(going.squad.units[0].status, /^indo à obra Posto de defesa leve · faltam 280 m/);
  // At work, the line of its switch says what it puts up.
  assert.equal(show(builder({ working: 'c9' }, { auto: true, job: { kind: 'build', targetId: 'c9', phase: 'work', reason: '' } }), { works: [work] }).automatic.status,
    'montando Posto de defesa leve · 40%');
  assert.match(panel(field({ vehicles: [builder({ working: 'c9' })], faction: { works: [work] } })).squad.units[0].status, /^montando Posto de defesa leve · 40%/);
  // In the player's hands it is spoken of too: it works where it stands still.
  assert.deepEqual(panel(field({ vehicles: [builder()], faction: { works: [] }, manual: 'truck' })).builder, { status: '' });
  const active = panel(field({ vehicles: [builder({ working: 'c9' })], faction: { works: [work] } }), { picked: ['truck'] });
  assert.deepEqual(active.services, []); assert.doesNotMatch(active.held, /reparo/);
});

test('an automatic wait with no job kind can coexist with a retained squad route', () => {
  const world = field({ vehicles: [{ ...TRUCK, order: { move: { x: 5280 } }, quote: {
    auto: true, job: { kind: null, phase: 'idle', targetId: null, reason: 'threat' },
  } }] });
  const shown = panel(world, { picked: ['truck'] });
  assert.match(shown.squad.units[0].status, /aguardando segurança/);
  assert.doesNotMatch(shown.squad.units[0].status, /faltam/, 'a retained route does not turn an idle wait into a construction trip');
});

test('a road machine picked alone says by its switch that it makes the roads, the roads asked for are told by their cards, and roads are asked for from the Infraestrutura page', () => {
  const grader = (quote = {}) => ({ id: 'grader', name: 'Motoniveladora', x: 5000, pieces: [piece('grader', 'blade')], quote: { road: true, auto: true, job: { kind: null, phase: 'idle', targetId: null, reason: '' }, ...quote } }),
    road = { id: 'r1', x0: 5100, x1: 5300, kind: 'asphalt', graded: .5, paved: .25, working: ['grade'], coming: false },
    show = (vehicle, options = { picked: ['grader'] }) => panel(field({ vehicles: [vehicle, TANK], faction: { roadworks: [road] } }), options);
  assert(!('road' in show(grader())), 'no machine opens a road of its own');
  assert.deepEqual(show(grader()).infrastructure, { post: '', road: '' }, 'the page of the faction does');
  assert.equal(panel(field({ vehicles: [grader()] }), { connected: false }).infrastructure, null, 'out of the field, nothing');
  assert.match(show(grader()).automatic.title, /^Faz sozinho o trabalho mais urgente e mais perto: faz as estradas pedidas pela facção. /);
  assert.doesNotMatch(show(grader({ supplies: bill() })).automatic.title, /rearma a frota/, 'nor do the supply pieces of one rearm the fleet');
  // At a road, the line of its switch and its row say what it does there.
  const at = show(grader({ job: { kind: 'grade', phase: 'work', targetId: 'r1', reason: '' } }));
  assert.equal(at.automatic.status, 'nivelando a estrada'); assert.match(at.squad.units.find(u => u.id === 'grader').status, /^nivelando a estrada/);
  assert.equal(show(grader({ job: { kind: null, phase: 'idle', targetId: null, reason: 'waiting-grade' } })).automatic.status, 'aguardando o nivelamento');
  assert.deepEqual(show(grader()).roads.map(row => [row.id, row.name, row.lines[0]]), [['r1', 'Estrada · Asfalto', '200 m · nivelada 50% · asfaltada 25%']]);
  assert.deepEqual(panel(field({ vehicles: [grader()], faction: { roadworks: [road] } }), { connected: false }).roads, [], 'out of the field, none');
});

test('a structure picked alone is moved or taken down from Mais ações, and while it is taken down says how far that has gone', () => {
  const post = (service = null) => ({ id: 'post', name: 'Posto', x: 1300, pieces: [gun('post'), rounds('post')], quote: { vehicle: false, service } }),
    world = service => { const w = field({ vehicles: [post(service), TANK] }); delete w.state.actors[0].vehicle; return w; },
    show = (service, options = { picked: ['post'] }) => panel(world(service), options),
    relocation = p => p.actions.find(action => action.id === 'relocate');
  // Standing, it has no block in the panel: Mudar de lugar is in Mais ações, beside Desmontar, for it picked alone.
  const standing = show();
  assert.deepEqual([standing.dismantling, acts(standing)], [null, ['copy', 'relocate', 'dismantle', 'abandon']]);
  assert.deepEqual(relocation(standing), { id: 'relocate', name: 'Mudar de lugar', icon: 'i-relocate',
    title: 'Escolha outro local: ela é desmontada aqui e montada lá, levando o material.', disabled: false, reason: '' });
  assert.deepEqual(acts(show(null, { picked: ['tank'] })), ['copy', 'dismantle'], 'a vehicle is given Mover, not this');
  assert.deepEqual(acts(show(null, { picked: ['post', 'tank'] })), ['dismantle'], 'only one picked alone');
  assert.deepEqual(show(null, { picked: ['post'], connected: false }).actions, [], 'nor with no connection');
  // Held by another service, it is not moved, and says why.
  const busy = show({ kind: 'repair', until: 140, cost: bill(10) });
  assert.deepEqual([busy.dismantling, relocation(busy).disabled, relocation(busy).reason], [null, true, 'Aguarde o fim do serviço.']);
  // Taken down, it is moved no more: the panel says how far that has gone, beside what cancels it.
  const down = show({ kind: 'dismantle', progress: .35, seconds: 13, to: null, building: false });
  assert.deepEqual(down.dismantling, { actorId: 'post', moving: false, progress: .35, text: 'Desmontando · 35% · aguardando um braço construtor trabalhar a até 7 m' });
  assert.deepEqual([acts(down), dismantling(down).reason], [['copy', 'dismantle', 'abandon'], 'Já está sendo desmontada.']);
  assert.equal(show({ kind: 'dismantle', progress: .35, seconds: 13, to: null, building: false, sent: { phase: 'go', reason: '' } }).dismantling.text,
    'Desmontando · 35% · construtor a caminho', 'the builder the dispatch sent to it');
  assert.deepEqual([down.squad.units[1].mark, down.squad.units[1].progress, down.squad.units[1].status, down.services], ['dismantle', .35, 'desmontando · 35%', []]);
  assert.equal(show({ kind: 'dismantle', progress: .5, seconds: 13, to: 'c7', building: true }).dismantling.text,
    'Desmontando para a mudança · 50% · braço construtor trabalhando');
  assert.equal(show({ kind: 'dismantle', progress: .5, seconds: 13, to: null, building: true }, { picked: ['tank'] }).dismantling, null, 'of the one picked alone');
  // No order turns it: a structure stays as it was put up.
  assert.equal(standing.orders.some(order => order.id === 'turn'), false);
});

test('the works and the heaps of the faction are the cards of their marks, and nothing of them off the field', () => {
  const works = [{ id: 'c9', name: 'Posto de defesa leve', x: 1300, facing: 1, cost: bill(4216), delivered: bill(1000), progress: .1, share: .23, seconds: 13,
      building: false, waiting: false, supplying: true, blocked: '', from: null, lack: bill(2000) }], heaps = [{ id: 'c2', x: 1500, stock: bill(800) }],
    world = field({ vehicles: [TANK], faction: { works, heaps } }), p = panel(world);
  assert.deepEqual(p.works.map(row => [row.id, row.name, row.share, row.lines]), [['c9', 'Obra · Posto de defesa leve', .1,
    ['Montada 10%', 'Chegou 23% do material', 'Falta no estoque da base: Ferro 2.000', 'Aguardando um braço construtor trabalhar a até 7 m', 'Suprimentos descarregando', 'Falta entregar à obra: Ferro 3.216', 'A 300 m → da base']]]);
  assert.deepEqual(p.heaps.map(row => [row.id, row.name, row.lines[0]]), [['c2', 'Material', 'Ferro 800']]);
  assert.deepEqual([panel(world, { connected: false }).works, panel(world, { connected: false }).heaps], [[], []]);
});

test('a structure on the bench is a works opened on the field: no stock refuses it, and it replaces nothing', () => {
  const world = field({ vehicles: [TANK], faction: { stock: bill(100) } }), before = structuredClone(world),
    show = (patch = {}) => panel(world, { tab: 'edit', price: bill(4216), drives: false, focus: 'tank', ...patch }).publish;
  const quote = show();
  assert.deepEqual([quote.spawn.text, quote.spawn.disabled, quote.text, quote.replace, quote.costs[0].short], ['Escolher local no campo', false, '', null, true]);
  assert.equal(show({ commanded: false }).spawn.disabled, true);
  assert.match(show({ connected: false }).text, /Aguarde a conexão/);
  world.faction.counts.fixed = CONSTRUCTION_LIMITS.fixed;
  assert.deepEqual([show().spawn.disabled, show().text], [true, 'Limite: 32 estruturas por facção.'], 'the works open count against the limit');
  world.faction.counts.fixed = before.faction.counts.fixed;
  assert.deepEqual(world, before, 'reading a quote changes nothing');
});

test('a mechanical draft refusal blocks both workshop publication paths independently of funds', () => {
  const admissionReason = 'Ajuste o chassi: o peso fica fora dos apoios.', stock = bill(1000000, 1000000, 1000000, 1000000),
    world = field({ vehicles: [{ ...TRUCK, quote: { atBase: true } }], faction: { stock } }), options = { tab: 'edit', price: bill(80), focus: 'truck', admissionReason },
    base = panel(world, options), fixed = panel(world, { ...options, drives: false });
  assert.deepEqual([base.publish.spawn.disabled, base.publish.spawn.title, base.publish.replace.disabled, base.publish.replace.title],
    [true, admissionReason, true, admissionReason]);
  assert.equal(base.publish.unpaid, false);
  assert.deepEqual([fixed.publish.spawn.disabled, fixed.publish.text], [true, admissionReason]);
  assert.equal(fixed.publish.unpaid, false); assert.equal(fixed.publish.availableStock, stock);
  assert.equal(panel(world, { ...options, admissionReason: '' }).publish.spawn.disabled, false);
});

test('one deposit order follows actual extraction and transport equipment without requiring a reservoir on an extractor', () => {
  const job = kinds => panel(field({ vehicles: [{ ...TRUCK, pieces: kinds.map(kind => piece('truck', kind)), quote: {} }] }), { picked: ['truck'], deposits: GROUND }),
    order = p => p.orders.find(order => order.id === 'haul');
  const excavator = job(['excavator']);
  assert.equal(order(excavator).name, 'Extrair'); assert.equal(order(excavator).icon, 'i-extract');
  assert.equal(excavator.squad.units[0].kind, 'extractor'); assert.equal(excavator.stats.cargo, null);
  assert.deepEqual(excavator.veins.map(row => [row.material, Boolean(row.collect)]), [['ferro', true], ['petroleo', false]]);
  const drill = job(['drill']);
  assert.equal(order(drill).name, 'Extrair'); assert.deepEqual(drill.veins.map(row => [row.material, Boolean(row.collect)]), [['ferro', false], ['petroleo', true]]);
  assert.equal(order(job(['hopper'])).name, 'Transportar');
  const combined = job(['excavator', 'hopper']);
  assert.deepEqual([order(combined).name, order(combined).label], ['Extrair e transportar', 'Coletar']);
  assert.deepEqual([combined.veins[0].collect.label, combined.veins[0].collect.title], ['Coletar', 'Extrai, leva o material à base ou ao posto mais perto e repete.'],
    'the compact button over the vein retains the full job in its title');
  const mixed = job(['drill', 'hopper']);
  assert.deepEqual(mixed.veins.map(row => [row.material, row.collect.name]), [['ferro', 'Transportar'], ['petroleo', 'Extrair']]);
});

test('the roster reports real extraction and waits for extracted stock instead of claiming to dig with a hopper', () => {
  const extracting = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'excavator')],
    quote: { extracting: 'ferro:1' }, order: { haul: { depositId: 'ferro:1', phase: 'load' } } }] }), { picked: ['truck'], deposits: GROUND });
  assert.equal(extracting.squad.units[0].doing, 'extract'); assert.equal(extracting.squad.units[0].status, 'extração · extraindo');
  const waiting = panel(field({ vehicles: [{ ...TRUCK, quote: {}, order: { haul: { depositId: 'ferro:1', phase: 'load' } } }] }), { picked: ['truck'], deposits: GROUND });
  assert.equal(waiting.squad.units[0].status, 'transportando · aguardando material extraído · 0%');
  // A vein the faction last knew empty is still somewhere to extract: it comes back.
  const depleted = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'excavator')], quote: {} }],
    faction: { deposits: [vein('ferro:1', { left: 0, stock: 5000 })] } }), { picked: ['truck'], deposits: GROUND });
  assert.deepEqual([depleted.veins[0].collect?.name, depleted.veins[0].collect?.ids], ['Extrair', ['truck']]);
  assert.equal(depleted.orders.find(order => order.id === 'haul').disabled, false); assert.equal(depleted.refused.haul, undefined);
  for (const patch of [{ health: 0 }, { attached: false }]) {
    const broken = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'excavator', patch)] }] }), { picked: ['truck'], deposits: GROUND });
    assert.equal(broken.orders.find(order => order.id === 'haul').disabled, true);
    assert.match(broken.refused.haul, /inutilizado.*reparo completo/);
  }
});

test('loading feedback in the roster uses the published world deadline and never estimates through an empty pile', () => {
  const described = cargoWork => panel(field({ vehicles: [{ ...TRUCK, quote: { ...TRUCK.quote, cargoWork },
    order: { haul: { depositId: 'ferro:1', phase: 'load' } } }] })).squad.units[0].status,
    now = field().state.time;
  assert.equal(described({ kind: 'load', until: now + 5.1 }), 'transportando · carregando · 6 s · 38%');
  assert.equal(described({ kind: 'load', waiting: true, until: now + 5.1 }), 'transportando · aguardando material · 38%');
  assert.equal(described({ kind: 'load', limited: true, until: now + 5.1 }), 'transportando · carregando · depende da extração · 38%');
  const working = { ...TRUCK, quote: { ...TRUCK.quote, cargoWork: { kind: 'load', until: now + 5.1 } } };
  assert.match(panel(field({ vehicles: [working] })).squad.units[0].status, /^carregando · 6 s/);
  assert.equal(panel(field({ vehicles: [working], manual: 'truck' })).squad.units[0].status, 'carregando · 6 s');
});

test('with nothing of the player on the field the panel says so and points to the workshop', () => {
  const p = panel(field());
  assert.deepEqual([p.situation, p.empty], ['empty', true]);
  assert.deepEqual([p.squad, p.orders, p.stances, p.control, p.release, p.weapon], [null, [], null, false, false, false]);
  assert.deepEqual([p.stats, p.services, p.held, p.actions, p.publish, p.project], [null, [], '', [], null, false]);
  assert.deepEqual([p.connection, p.faction.invites, p.faction.invitable, p.veins, p.wrecks], ['', [], [], [], []], 'and nothing else has anything to show');
  // With nothing of the faction there either and less in its stocks than an ore lorry costs, the panel says what the aid
  // would give, and offers it; a faction with no base is told so, and offered to establish one.
  const lorry = bill(28022, 0, 995, 203), short = { base: null, lorry, reserve: 203, aid: bill(16022, 0, 995, 366), offered: true };
  assert.deepEqual([p.emptyText, p.recovery, p.recover], ['Você não tem construções no campo: monte uma em Construir e fabrique-a.', '', ''], 'a faction that pays for a lorry is offered nothing');
  const helped = panel(field({ faction: { recovery: short } }));
  assert.deepEqual([helped.emptyText, helped.recovery, helped.recover], ['Sua facção está sem construções no campo. Peça auxílio para receber um caminhão de minério.',
    'Nada no campo e sem estoque para um caminhão de minério (Ferro 28.022 + Sílica 995 + Combustível 203 L) com Combustível 203 L de reserva. ' +
    'O auxílio cobre o que falta: Ferro 16.022 + Sílica 995 + Combustível 366 L.', 'Pedir auxílio']);
  const standing = panel(field({ faction: { recovery: { ...short, offered: false } } }));
  assert.deepEqual([standing.recovery, standing.recover], ['', ''], 'somebody of the faction still has a construction there');
  assert.equal(panel(field({ faction: { recovery: short } }), { tab: 'edit', price: bill(100) }).recover, '', 'and it is asked on the field, not at the workshop');
  const fell = { at: 80, from: 1000, by: { id: 'red', name: 'Caio', nation: null }, dismantled: 0, returned: bill(), cargo: load(), stock: bill(), yard: load() },
    lost = panel(field({ faction: { base: null, fell, recovery: { base: bill(22500, 2500, 2500, 375), lorry: null, reserve: 0, aid: bill(), offered: true } } }));
  assert.deepEqual([lost.emptyText, lost.recovery, lost.recover, lost.veins, lost.watch.veins],
    ['Sua facção está sem base: tomada pela facção de Caio.', 'Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L.', 'Estabelecer base', [], null]);
  // The base lost is bad news, told once to whoever was in the faction; a base established is good news, told once as well,
  // and the veins about it come with it, no finding. Not at the first look, nor to one who came into the faction since.
  const memo = {}, moved = field({ faction: { base: { ...BASE, x: 39400 }, fell, recovered: { at: 90, base: 39400, from: 1000, lorry: false, aid: bill() } } });
  assert.deepEqual([p.watch.faction, p.watch.fell, p.watch.recovered, panel(moved).watch.recovered], ['green', null, null, { at: 90, base: true, text: 'Base estabelecida a 38,4 km → da que foi tomada.' }]);
  assert.deepEqual(fieldNotices(memo, p.watch, 0), []);
  assert.deepEqual([fieldNotices(memo, lost.watch, 1), memo.grave], [['Sua base foi tomada pela facção de Caio. Saque: nada. Estabeleça outra base no painel do campo.'], true]);
  assert.deepEqual([fieldNotices(memo, panel(moved).watch, 2), memo.grave], [['Base estabelecida a 38,4 km → da que foi tomada.'], false]);
  assert.deepEqual(fieldNotices(memo, panel(moved).watch, 40), []);
  assert.deepEqual(fieldNotices(memo, panel(field({ faction: { id: 'red', fell: { ...fell, at: 95 } } })).watch, 96), [], 'another faction, joined since');
  assert.deepEqual(fieldNotices({}, panel(moved).watch, 0), []);
  // Until the field tells the faction there is nothing to say of it but that it is awaited.
  const waiting = fieldPanel({ tab: 'test', shared: true, connected: true, state: null, faction: null, playerId: 'ana' });
  assert.deepEqual([waiting.situation, waiting.empty], ['offline', false]);
});

test('every vein the faction knows of has its card, and the button over its mark only for what those picked can work there', () => {
  const tank = panel(field({ vehicles: [TANK] }), { picked: ['tank'], deposits: GROUND });
  assert.deepEqual(tank.veins.map(row => [row.id, row.collect]), [['ferro:1', null], ['petroleo:4', null]]);
  const truck = panel(field({ vehicles: [TRUCK] }), { picked: ['truck'], deposits: GROUND });
  assert.deepEqual(collected(truck), ['ferro:1']);
  // The card: the material and its ground, what is left of it, with a bar, what is ready there and where it is from the base.
  assert.deepEqual(truck.veins[0], { id: 'ferro:1', x: 5200, material: 'ferro', name: 'Ferro · afloramento', share: 1,
    lines: ['Reserva 62 t de 62 t', 'Pronto 0 kg', 'A 4,2 km → da base'],
    collect: { ids: ['truck'], name: 'Transportar', label: 'Transportar', title: 'Leva a carga à base ou ao posto mais perto e repete; sem carga, aguarda material no local.', icon: 'i-haul' } });
  const tanker = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'cistern')] }] }), { picked: ['truck'], deposits: GROUND });
  assert.deepEqual(collected(tanker), ['petroleo:4']);
  const none = panel(field({ vehicles: [TRUCK] }), { deposits: GROUND });
  assert.deepEqual(collected(none), []); assert.equal(none.veins.some(row => row.id === 'ferro:2'), false, 'an unknown vein stays unknown');
  // Of a vein a base stills the card says only that, and where it is.
  const stilled = panel(field({ vehicles: [TRUCK], faction: { deposits: [...VEINS, vein('ferro:2', { active: false })] } }), { picked: ['truck'], deposits: GROUND })
    .veins.find(row => row.id === 'ferro:2');
  assert.deepEqual([stilled.share, stilled.lines, stilled.collect], [null, ['Junto de uma base: ali não se extrai nada.', 'A 4,7 km → da base'], null]);
});

test('an aircraft says how high it was sent and why it comes down, lands where Mover sends it on the ground and turns about in the air as on the ground', () => {
  const aircraft = (vehicle, move) => ({ id: 'heli', name: 'Aeronave', x: 1500, fuel: [180, 0], pieces: [piece('heli', 'thruster')], vehicle: { thrustN: 90000, gearCount: 0, engine: true, ...vehicle }, order: { move } }),
    world = field({ vehicles: [aircraft({ flying: true }, { x: 1800, height: 40 }), TANK] }), status = p => p.squad.units.find(u => u.id === 'heli').status;
  // Base is for whatever moves, the aircraft with the rest; and the old order to land is no more.
  const both = panel(world, { picked: ['heli', 'tank'] }), home = both.orders.find(o => o.id === 'home');
  assert.deepEqual([home.ids, home.disabled, home.label, home.name, home.key, home.hint], [['heli', 'tank'], false, 'Base', 'Voltar à base ou ao posto mais perto', 'P', '']);
  assert.equal(both.orders.some(o => o.id === 'land'), false);
  // Mover says where its click goes: on the ground the aircraft comes down, in the sky it hovers.
  assert.equal(panel(world, { picked: ['heli'], armed: 'move' }).armed, 'Mover · 1 veículo: clique no chão para pousar ou no céu para pairar · Esc cancela');
  assert.equal(panel(world, { picked: ['heli', 'tank'], armed: 'move' }).armed, 'Mover · 2 veículos: clique no destino; aeronaves pousam no chão ou pairam no céu · Esc cancela');
  assert.equal(panel(world, { picked: ['tank'], armed: 'move' }).armed, 'Mover · 1 veículo: clique no terreno para onde ir · Esc cancela');
  const alone = panel(world, { picked: ['heli'] }), turn = alone.orders.find(o => o.id === 'turn');
  assert.deepEqual([turn.disabled, turn.ids, turn.quiet], [false, ['heli'], undefined], 'in the air it turns about');
  assert.equal(status(alone), 'em movimento · faltam 300 m · a 40 m do chão', 'its range on the ground is no warning to it');
  assert.equal(alone.stats.fuel.text, '180 L', 'nor is it told of its fuel');
  const landing = field({ vehicles: [aircraft({ flying: true }, { x: 1000, land: 'fuel' })] });
  assert.equal(status(panel(landing, { picked: ['heli'] })), 'pouco combustível · voltando para pousar · faltam 500 m');
  const spent = field({ vehicles: [aircraft({ flying: true }, { x: 1000, land: 'ammo' })] });
  assert.equal(status(panel(spent, { picked: ['heli'] })), 'sem munição · voltando para pousar · faltam 500 m');
  const down = field({ vehicles: [aircraft({ flying: false }, { x: 1501, land: 'order' })] }), still = panel(down, { picked: ['heli'] });
  assert.equal(status(still), 'indo pousar');
  assert.equal(still.orders.find(o => o.id === 'turn').disabled, false, 'on its skids it turns about');
  // A vehicle sent home says so, and of the post it goes to that it is one.
  const driving = move => field({ vehicles: [{ ...TANK, x: 1600, quote: {}, order: { move } }], faction: { posts: [{ x: 3000 }] } }), row = p => p.squad.units[0].status;
  assert.equal(row(panel(driving({ x: 1075, home: true }), { picked: ['tank'] })), 'voltando à base · faltam 525 m');
  assert.equal(row(panel(driving({ x: 2975, home: true }), { picked: ['tank'] })), 'voltando ao posto · faltam 1.375 m');
  // With no wheels, nor its engine, it still flies; with its thrusters gone, it does not.
  assert.equal(status(panel(field({ vehicles: [aircraft({ engine: false }, null)] }), { picked: ['heli'] })), 'parado');
  assert.equal(status(panel(field({ vehicles: [aircraft({ thrustN: 0 }, null)] }), { picked: ['heli'] })), 'sem mobilidade · propulsores destruídos');
});

test('an aircraft that lost a thruster says it goes home to be mended, comes down where it is or waits to be mended', () => {
  const aircraft = (vehicle, order) => ({ id: 'heli', name: 'Aeronave', x: 1500, fuel: [180, 0], vehicle: { thrustN: 70000, gearCount: 0, engine: true, ...vehicle }, order,
      pieces: [piece('heli', 'thruster'), piece('heli', 'thruster', { id: 'heli:lift1', health: 0 })] }),
    status = (vehicle, order) => panel(field({ vehicles: [aircraft(vehicle, order)] }), { picked: ['heli'] }).squad.units.find(u => u.id === 'heli').status;
  assert.equal(status({ flying: true }, { move: { x: 1000, land: 'mend' } }), 'propulsor perdido · voltando para reparo · faltam 500 m');
  assert.equal(status({ flying: true }, { move: { x: 1500, land: 'forced' } }), 'propulsor perdido · pousando onde está');
  assert.equal(status({ flying: false }, { reason: 'mending' }), 'parado · propulsor perdido · aguardando reparo');
});

test('commanding, an unarmed hauler picked alone is offered only what it can do', () => {
  const world = field({ vehicles: [TRUCK] }), p = panel(world, { picked: ['truck'], deposits: GROUND });
  assert.equal(p.situation, 'command');
  assert.deepEqual(ids(p.orders), ['move', 'haul', 'turn', 'home', 'stop'], 'no gun actions without a gun');
  assert.deepEqual(p.refused, { attack: 'Nenhuma das construções selecionadas tem arma instalada.', bombard: 'Nenhuma das construções selecionadas tem arma instalada.' });
  assert.deepEqual([p.stances, p.control, p.release, p.weapon], [null, true, false, false], 'a stance is for whoever has something to fire');
  assert.deepEqual([p.squad.title, p.squad.tag], ['ESQUADRÃO', '1 selecionado']);
  assert.deepEqual(p.squad.units.map(u => [u.number, u.name, u.selected, u.manual, u.status]), [[1, 'Caminhão', true, false, 'parado · carga Ferro 4.250 (38%)']]);
  assert.deepEqual(gauges(p), { fuel: '180 L · 240 km', cargo: '38%', whole: '100%' }, 'fuel, load and how whole: no rounds for one without a gun');
  assert.deepEqual([p.stats.cargo.title, p.stats.cargo.share, p.stats.fuel.title], ['Carga: Ferro 4.250 · 38% · carregando', .38, 'Combustível 180 L · autonomia 240 km']);
  // Away from the base the base does nothing, and nothing is said of the base. What it carries it may tip out, a quarter of its hopper at a time.
  // From Mais ações it may be copied and abandoned there; dismantled only in its base.
  assert.deepEqual([p.services, p.held, acts(p)], [[DUMP], '', ['copy', 'dismantle', 'abandon']]);
  assert.deepEqual([dismantling(p).label, dismantling(p).disabled, dismantling(p).reason], ['Desmontar', true, 'Leve o veículo até a base para desmontá-lo.']);
  assert.deepEqual(p.actions.map(action => [action.name, action.icon]), [['Editar cópia', 'i-copy'], ['Desmontar', 'i-build'], ['Abandonar', 'i-abandon']]);
  // The veins are those the faction knows of that it can carry from: a hopper takes no petroleum, and the site of iron beside it that the faction was told nothing of is no vein to it.
  assert.deepEqual(collected(p), ['ferro:1']); assert.deepEqual([p.veins[0].lines, p.veins[0].share], [['Reserva 62 t de 62 t', 'Pronto 0 kg', 'A 4,2 km → da base'], 1]);
  const tanker = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'cistern')] }] }), { picked: ['truck'], deposits: GROUND });
  assert.deepEqual(collected(tanker), ['petroleo:4']);
  // A hopper shot away keeps its repairable role visible, with no executable recipients.
  const broken = panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', 'hopper', { health: 0 })] }] }), { picked: ['truck'], deposits: GROUND });
  assert.deepEqual([ids(broken.orders), collected(broken), broken.orders.find(order => order.id === 'haul').ids], [['move', 'haul', 'turn', 'home', 'stop'], [], []]);
  assert.match(broken.refused.haul, /inutilizado.*reparo completo.*base.*suprimentos/);
  // An empty one that carries says so; under way, its row says where it is in the trip.
  const empty = panel(field({ vehicles: [{ ...TRUCK, quote: {}, order: { haul: { depositId: 'ferro:1', material: 'ferro', phase: 'out' } } }] }), { picked: ['truck'] });
  assert.equal(empty.stats.cargo.text, 'vazia'); assert.equal(empty.squad.units[0].status, 'transportando · indo à coleta · 0%');
  const dried = panel(field({ vehicles: [{ ...TRUCK, fuelStarved: true, fuel: [.2, 0] }] }), { picked: ['truck'] }).stats.fuel; assert.deepEqual([dried.text, dried.low], ['sem combustível', true]);
  // The fuel is told of what the tanks it draws from take: a tank shot away, loose or burst takes nothing, and neither does a cistern.
  const tank = (id, patch) => piece('truck', 'fuel', { id: 'truck:fuel:' + id, capacityLitres: 140, fuelLitres: 90, ...patch }),
    fuelled = pieces => panel(field({ vehicles: [{ ...TRUCK, quote: {}, pieces }] }), { picked: ['truck'] }).stats.fuel.title;
  assert.equal(fuelled([tank(1), tank(2)]), 'Combustível 180 L de 280 L · autonomia 240 km');
  assert.equal(fuelled([tank(1), tank(2, { health: 0 }), tank(3, { attached: false }), tank(4, { detonated: true }), piece('truck', 'cistern', { capacityLitres: 900 })]),
    'Combustível 180 L de 140 L · autonomia 240 km');
  // In the player's hands its gauge says the same, and its row only what is wrong with it.
  const held = panel(field({ vehicles: [{ ...TRUCK, quote: {}, pieces: [tank(1), tank(2)] }], manual: 'truck' }));
  assert.deepEqual([held.squad.units[0].status, held.stats.fuel.title], ['sob seu controle', 'Combustível 180 L de 280 L · autonomia 240 km']);
});

test('a hauler with no known compatible vein keeps its disabled action and explains discovery, while a spent route keeps its own status', () => {
  const UNFOUND = 'Nenhum local de coleta compatível conhecido. Explore com um veículo de reconhecimento.',
    knowing = (deposits, truck = TRUCK) => panel(field({ vehicles: [truck], faction: { deposits } }), { picked: ['truck'], deposits: GROUND });
  // Known terrain alone cannot grant a vein: the action stays visible and explains exploration.
  for (const known of [[], [vein('petroleo:4')]]) {
    const p = knowing(known);
    assert.deepEqual([ids(p.orders), collected(p), p.refused.haul], [['move', 'haul', 'turn', 'home', 'stop'], [], UNFOUND]);
    assert.deepEqual([p.orders.find(order => order.id === 'haul').disabled, p.orders.find(order => order.id === 'haul').ids], [true, []]);
  }
  // One it found and no longer sees is listed as it was then, with how long ago that was: it may have been dug out since.
  const more = knowing([...VEINS, vein('ferro:2', { left: 30000, at: 40, seen: false })]);
  assert.deepEqual(more.veins.filter(d => d.collect).map(d => [d.id, d.name, d.lines]), [['ferro:1', 'Ferro · afloramento', ['Reserva 62 t de 62 t', 'Pronto 0 kg', 'A 4,2 km → da base']],
    ['ferro:2', 'Ferro · ruínas', ['Reserva 30 t de 62,5 t', 'Pronto 0 kg', 'A 4,7 km → da base · vista há 1 min']]]);
  assert(ids(more.orders).includes('haul'));
  // What is watched of them: each vein by its material and where it lies from the base, while the page has the ground of the field at hand.
  assert.deepEqual(more.watch.veins, [{ id: 'ferro:1', name: 'Ferro', where: 'a 4,2 km →' }, { id: 'petroleo:4', name: 'Petróleo', where: 'a 4,4 km →' }, { id: 'ferro:2', name: 'Ferro', where: 'a 4,7 km →' }]);
  assert.deepEqual(more.watch.hauls, []);
  assert.equal(panel(field({ vehicles: [TRUCK] }), { picked: ['truck'] }).watch.veins, null, 'without it, it cannot tell them');
  // It found its vein empty, and the faction knows another: it takes none in its place. It brings its load home, saying why
  // and that the vein comes back; both are on the list for the player to send it to, the empty one too. Stopped there, its
  // row says why.
  const haul = (depositId, phase, reason = '') => ({ ...TRUCK, order: { reason, haul: { depositId, material: 'ferro', phase } } }),
    words = 'Veículo 1 · Caminhão: jazida de Ferro vazia · recuperando — volta à base ou ao posto e fica lá. Mande-o de novo mais tarde ou a outro local de coleta.',
    emptied = [vein('ferro:1', { left: 0 }), vein('ferro:2'), vein('petroleo:4')], home = knowing(emptied, haul('ferro:1', 'home', 'vein-empty:ferro'));
  assert.deepEqual(home.watch.hauls, [trouble('truck', 'vein-empty:ferro:1', words)]);
  assert.equal(home.squad.units[0].status, 'transportando · voltando à base · 38% · jazida de Ferro vazia · recuperando');
  assert.deepEqual(collected(home), ['ferro:1', 'ferro:2']); assert(ids(home.orders).includes('haul'));
  const stopped = knowing(emptied, { ...TRUCK, quote: {}, order: { reason: 'vein-empty:ferro' } });
  assert.deepEqual(stopped.watch.hauls, [trouble('truck', 'vein-empty:', words)]);
  assert.equal(stopped.squad.units[0].status, 'parado · jazida de Ferro vazia · recuperando');
  assert.deepEqual([collected(stopped), stopped.refused.haul], [['ferro:1', 'ferro:2'], undefined]);
  // Said once, as it comes about: the hauler's own word for the vein it worked, and nothing more of that vein.
  const memo = {}, before = knowing([...VEINS, vein('ferro:2')], haul('ferro:1', 'load'));
  assert.deepEqual(fieldNotices(memo, before.watch, 0), []); assert.deepEqual(before.watch.hauls, []);
  assert.deepEqual([fieldNotices(memo, home.watch, 1), memo.grave], [[words], false]);
  assert.deepEqual(fieldNotices(memo, home.watch, 2), []);
  assert.deepEqual(fieldNotices(memo, stopped.watch, 3), [], 'home and stopped, it does not say it again');
  // An enemy close by: it gives its trip up and says so the same way, on its way home and stopped there — its vein still on the list.
  const scare = 'Veículo 1 · Caminhão: inimigo por perto — interrompe o transporte, volta à base ou ao posto e fica lá. Mande-o de novo quando o caminho estiver livre.',
    known = [...VEINS, vein('ferro:2')], fleeing = knowing(known, { ...TRUCK, order: { reason: 'enemy-near', haul: { depositId: 'ferro:1', material: 'ferro', phase: 'home', fled: true } } }),
    kept = knowing(known, { ...TRUCK, quote: {}, order: { reason: 'enemy-near' } });
  const retreat = { ...trouble('truck', 'enemy-near', scare), x: TRUCK.x, approximate: true };
  assert.deepEqual([fleeing.watch.hauls, kept.watch.hauls], [[retreat], [retreat]]);
  assert.equal(fleeing.squad.units[0].status, 'recuando · voltando à base · 38% · inimigo por perto: transporte interrompido');
  assert.equal(kept.squad.units[0].status, 'parado · inimigo por perto: transporte interrompido'); assert(collected(kept).includes('ferro:1'));
  // Its guns may have something else to say meanwhile: the trip it gave up is told all the same.
  assert.deepEqual(knowing(VEINS, { ...TRUCK, order: { reason: 'holding', haul: { depositId: 'ferro:1', material: 'ferro', phase: 'home', fled: true } } }).watch.hauls.map(haul => haul.key), ['enemy-near']);
  const alarm = {}; fieldNotices(alarm, before.watch, 0);
  assert.deepEqual([fieldNotices(alarm, fleeing.watch, 1), alarm.grave], [[scare], true]); assert.deepEqual(fieldNotices(alarm, kept.watch, 2), []);
});

test('a damaged construction in the base is mended automatically even in manual control, with explicit cancellation available', () => {
  const world = field({ vehicles: [TANK] }), p = panel(world, { picked: ['tank'], deposits: GROUND });
  assert.deepEqual(ids(p.orders), ['move', 'attack', 'bombard', 'turn', 'home', 'stop']); assert.deepEqual(Object.keys(p.refused), ['haul']);
  assert.deepEqual(p.stances.map(s => [s.id, s.name, s.active]), [['hold', 'Segurar fogo', false], ['return', 'Revidar', true], ['fire', 'Fogo livre', false]]);
  assert.equal(p.squad.units[0].status, 'revidar · avariado 20%'); assert.deepEqual(gauges(p), { fuel: '180 L · 240 km', rounds: '28', whole: '80%' });
  // The repair is about to begin and nothing asks for it. Dismantling is asked from Mais ações, with what it gives back.
  assert.deepEqual([p.services, p.held, acts(p), p.control], [[], '', ['copy', 'dismantle'], true], 'in the base it is dismantled, not abandoned');
  assert.deepEqual([dismantling(p).disabled, dismantling(p).ids, dismantling(p).vehicles, dismantling(p).back.refund], [false, ['tank'], 1, bill(9000)]);
  assert.match(panel(field({ vehicles: [{ ...TANK, quote: { ...TANK.quote, calm: false } }] }), { picked: ['tank'] }).actions[1].reason, /^Em combate: fique 10 s/,
    'in combat it waits, and says why');
  assert.deepEqual(collected(p), [], 'veins are worked by whoever carries');
  // Where it does not come, one line says why: the stocks do not pay the repair, the construction still moves, or it is in combat.
  const waiting = patch => panel(field({ vehicles: [{ ...TANK, quote: { ...TANK.quote, ...patch.quote } }], faction: patch.faction }), { picked: ['tank'] });
  assert.deepEqual([ids(waiting({ faction: { stock: bill(1500) } }).services), waiting({ faction: { stock: bill(1500) } }).held], [[], 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.']);
  assert.equal(waiting({ quote: { still: false } }).held, 'Em movimento: o serviço começa quando a construção parar.');
  assert.match(waiting({ quote: { calm: false } }).held, /^Em combate: fique 10 s/);
  // Taking control does not add a redundant repair order at the base.
  const manual = panel(field({ vehicles: [TANK], manual: 'tank' }));
  assert.deepEqual([manual.services, manual.held, manual.actions], [[], '', []], 'and in hand there is no Mais ações');
  // Rounds and fuel missing: the base fills it up by itself, and there is nothing to ask for.
  const spent = panel(field({ vehicles: [{ ...TANK, quote: { atBase: true, rearm: bill(1253, 0, 0, 60) } }] }), { picked: ['tank'] });
  assert.deepEqual([spent.services, spent.held], [[], '']);
  // Missing stocks explain why the automatic service waits in manual control too.
  const poor = panel(field({ vehicles: [TANK], manual: 'tank', faction: { stock: bill(1500) } }));
  assert.deepEqual([ids(poor.services), poor.held], [[], 'Falta Ferro para o reparo: custa 2.013 e a facção tem 1.500.']);
  // While it is mended the row says how long it takes, and the one thing to ask for is to cancel it.
  const held = { atBase: true, repair: bill(2013), repairSeconds: 9, service: { kind: 'repair', until: 106.2, cost: bill(2013), payer: null } },
    mending = panel(field({ vehicles: [{ ...TANK, quote: held }] }), { picked: ['tank'] });
  assert.deepEqual([mending.services.map(job => [job.id, job.text, job.disabled]), mending.held, mending.squad.units[0].status, mending.advice],
    [[['cancel', 'Cancelar reparo', false]], '', 'em reparo · 7 s', '']);
  const manualRepair = panel(field({ vehicles: [{ ...TANK, quote: held }], manual: 'tank' }));
  assert.deepEqual(ids(manualRepair.services), ['cancel'], 'in the player\'s hands too');
  assert.equal(manualRepair.held, 'Em reparo na base: acelere para cancelar.');
  // Cancelled, it is not begun again by itself where the construction stands: the repair is a job again, and its end is not told as a repair done.
  const cancelled = panel(field({ vehicles: [{ ...TANK, quote: { ...held, service: null, declined: true } }] }), { picked: ['tank'] });
  assert.deepEqual([cancelled.services.map(job => [job.id, job.text]), cancelled.held, cancelled.squad.units[0].status],
    [[['repair', 'Reparar · Ferro 2.013 · 9 s']], '', 'revidar · avariado 20%']);
  const memo = {}; fieldNotices(memo, mending.watch, 100);
  assert.deepEqual([mending.watch.repairs, cancelled.watch.repairs, cancelled.watch.cancelled, fieldNotices(memo, cancelled.watch, 101)], [['tank'], [], ['tank'], []]);
  fieldNotices(memo, mending.watch, 102);
  assert.deepEqual(fieldNotices(memo, panel(field({ vehicles: [{ ...TANK, quote: { atBase: true } }] })).watch, 103), ['Veículo 1 · Blindado: reparo concluído.']);
  // The same construction away from the base and from any supply vehicle: no service, no line about one, and it may be abandoned.
  const away = panel(field({ vehicles: [{ ...TANK, quote: { repair: bill(2013), repairSeconds: 9 } }] }), { picked: ['tank'] });
  assert.deepEqual([away.services, away.held, acts(away)], [[], '', ['copy', 'dismantle', 'abandon']]);
  // Empty ammunition is temporary: a useful order survives service. A disabled barrel cannot fire.
  const dry = panel(field({ vehicles: [{ ...TANK, pieces: [gun('tank'), rounds('tank', 0)] }] }), { picked: ['tank'] });
  assert.deepEqual([ids(dry.orders), Boolean(dry.stances), dry.stats.rounds.text, dry.stats.rounds.low], [['move', 'attack', 'bombard', 'turn', 'home', 'stop'], true, '0', true]);
  const gunless = panel(field({ vehicles: [{ ...TANK, pieces: [gun('tank', { barrelDisabled: true }), rounds('tank')] }] }), { picked: ['tank'] });
  assert.deepEqual([ids(gunless.orders), gauges(gunless).rounds], [['move', 'attack', 'bombard', 'turn', 'home', 'stop'], 'arma inutilizada']);
  assert.equal(gunless.orders.find(order => order.id === 'attack').disabled, false, 'the accepted order can resume after a repair');
  // Two kinds of gun, each with its own rounds.
  const twin = panel(field({ vehicles: [{ ...TANK, pieces: [gun('tank'), rounds('tank'), piece('tank', 'weapon', { id: 'tank:mg', weaponPreset: 'm2' }), piece('tank', 'ammo', { id: 'tank:belt', ammoPreset: 'm2', rounds: 1200 })] }] }), { picked: ['tank'] });
  assert.equal(gauges(twin).rounds, '28 + 1.200');
});

test('on a field with fog a vehicle none of whose eyes sees out is told to see nothing: in its row, in its hands, and once as it comes about', () => {
  const eye = (left, right) => ({ x: 5000, y: 2, left, right }), FOG = { explored: [[0, 2000]] },
    world = (eyes, faction = FOG, manual = null) => field({ vehicles: [{ ...TANK, x: 5000, quote: {}, eyes }], faction, manual }),
    seeing = panel(world([eye(1000, 1000)]), { picked: ['tank'] }), blind = panel(world([]), { picked: ['tank'] });
  assert.deepEqual([seeing.squad.units[0].status.includes('sem visão'), seeing.squad.units[0].trouble, seeing.watch.ills, seeing.advice], [false, false, [], '']);
  assert.match(blind.squad.units[0].status, /^sem visão/); assert.equal(blind.squad.units[0].trouble, true);
  assert.equal(blind.advice, 'Sem visão: nenhuma câmera dele vê para fora. Não vê o chão nem quem está ao lado.');
  assert.deepEqual(blind.watch.ills, [trouble('tank', 'blind', 'Veículo 1 · Blindado: sem visão — nenhuma câmera dele vê para fora.')]);
  // An eye that sees to one side sees; one whose own armour hides both sides does not.
  assert.deepEqual([[eye(0, 650)], [eye(0, 0)], [eye(0, 0), eye(300, 0)]].map(eyes => panel(world(eyes)).watch.ills.length), [0, 1, 0]);
  // In the player's hands the row says it before the fuel.
  assert.equal(panel(world([], FOG, 'tank')).squad.units[0].status, 'sem visão');
  // It is said once, as its last camera goes; and on a field without fog nobody is blind.
  const memo = {};
  assert.deepEqual(fieldNotices(memo, seeing.watch, 0), []);
  assert.deepEqual(fieldNotices(memo, blind.watch, 1), ['Veículo 1 · Blindado: sem visão — nenhuma câmera dele vê para fora.']); assert.equal(memo.grave, true);
  assert.deepEqual(fieldNotices(memo, blind.watch, 2), []);
  assert.deepEqual(panel(world([], {})).watch.ills, []);
  // Coming into the field with it so, the player is told in a report to read, once, and not in a notice. A look of a
  // page that does not know the faction yet is no look: it neither says nor measures anything.
  const coming = {}, partial = panel(world([]), { faction: null }).watch;
  assert.equal(partial.partial, true); assert.equal(blind.watch.partial, false);
  assert.deepEqual([fieldNotices(coming, partial, 0), coming.entry, coming.watch], [[], null, undefined]);
  assert.deepEqual([fieldNotices(coming, blind.watch, 1), coming.entry], [[], { title: 'Um veículo seu precisa de atenção', text: 'Situação de agora. “Ver” leva a câmera até o veículo.',
    vehicles: [{ id: 'tank', label: 'Veículo 1 · Blindado', problems: ['sem visão — nenhuma câmera dele vê para fora'] }] }]);
  assert.deepEqual([fieldNotices(coming, blind.watch, 2), coming.entry], [[], null]);
  assert.deepEqual([fieldNotices(coming, partial, 3), fieldNotices(coming, seeing.watch, 4), coming.entry], [[], [], null], 'and not again, whatever comes');
});

test('the orders offered are those somebody of the selection can take, and the column is the selector', () => {
  const world = field({ vehicles: [TRUCK, TANK] }), none = panel(world, { deposits: GROUND }), both = panel(world, { picked: ['truck', 'tank'], armed: 'attack', deposits: GROUND });
  // Nobody picked: the column alone, those that fight first, each numbered by its place in it.
  assert.deepEqual([none.orders, none.stances, none.control, none.stats, none.actions, collected(none)], [[], null, false, null, [], []]);
  assert.equal(none.squad.tag, '');
  assert.deepEqual(none.squad.units.map(u => [u.number, u.name, u.selected, u.group]), [[1, 'Blindado', false, 'attack'], [2, 'Caminhão', false, 'logistics']]);
  // Both picked: every order one of them can take; what is of one construction alone is not there.
  assert.deepEqual(ids(both.orders), ['move', 'attack', 'bombard', 'haul', 'tow', 'turn', 'home', 'stop']);
  // A cable is for one picked alone: the button says why, and nothing under the row does.
  const tow = both.orders.find(o => o.id === 'tow');
  assert.deepEqual([tow.disabled, tow.quiet, tow.reason], [true, true, 'Selecione um único veículo para rebocar.']);
  assert.deepEqual(both.refused, { tow: tow.reason });
  assert.deepEqual([both.squad.tag, both.control, both.stats, both.services], ['2 selecionados', false, null, []]);
  // Of several picked, Mais ações dismantles those that may be — the tank in its base, not the lorry away from it — and says how many.
  assert.deepEqual(both.actions.map(action => [action.id, action.label, action.disabled, action.ids, action.out]), [['dismantle', 'Desmontar (1)', false, ['tank'], '1 fora da base']]);
  assert.deepEqual(both.orders.filter(o => o.active).map(o => o.id), ['attack']); assert.equal(both.armed, 'Atacar · 1 de 2 selecionados: clique num veículo inimigo · Esc cancela');
  assert.deepEqual(both.veins.filter(row => row.collect).map(row => [row.id, row.collect.ids]), [['ferro:1', ['truck']]], 'the veins are those the hauler of the two can carry from');
  // An order that waits for its click is said only while it is offered.
  assert.equal(panel(world, { picked: ['truck'], armed: 'attack' }).armed, '');
  // To a finger the panel speaks of the finger: a tap; an order waiting is not cancelled by a key it has not.
  const touched = panel(world, { picked: ['truck', 'tank'], armed: 'attack', deposits: GROUND, touch: true });
  assert.equal(touched.armed, 'Atacar · 1 de 2 selecionados: toque num veículo inimigo');
  assert.equal(panel(world, { picked: ['truck'], armed: 'move' }).armed, 'Mover · 1 veículo: clique no terreno para onde ir · Esc cancela');
  // Every order has a name and a key of its own.
  assert.deepEqual(ORDERS.map(o => [o.id, o.name, o.key]),
    [['move', 'Mover', 'M'], ['attack', 'Atacar', 'T'], ['bombard', 'Bombardear', 'B'], ['haul', 'Transportar', 'J'], ['tow', 'Rebocar', 'R'], ['turn', 'Virar', 'V'],
      ['home', 'Voltar à base ou ao posto mais perto', 'P'], ['stop', 'Parar', 'X'], ['free', 'Liberar', 'L']]);
  // The stance shown as the selection's is the one all of it has.
  const mixed = field({ vehicles: [TANK, { ...TANK, id: 'second', pieces: [gun('second'), rounds('second')], order: { stance: 'fire' } }] });
  assert.deepEqual(panel(mixed, { picked: ['tank', 'second'] }).stances.filter(s => s.active), []);
  assert.deepEqual(panel(mixed, { picked: ['second'] }).stances.filter(s => s.active).map(s => s.id), ['fire']);
});

test('Rebocar is for one vehicle picked alone with another of the faction on the field, and Soltar takes its place on a cable', () => {
  const world = field({ vehicles: [TRUCK, TANK] }), tow = p => p.orders.find(order => order.id === 'tow');
  // Picked alone, it pulls: the order waits for the vehicle to take, as Atacar waits for an enemy.
  const one = panel(world, { picked: ['tank'], armed: 'tow' });
  assert.deepEqual([tow(one).ids, tow(one).disabled, tow(one).active, 'quiet' in tow(one)], [['tank'], false, true, false]);
  assert.equal(one.armed, 'Rebocar · 1 veículo: clique num veículo da facção parado ao lado · Esc cancela');
  // Alone in the faction there is nothing to tow: neither offered nor refused. A structure has nothing to pull with.
  const alone = panel(field({ vehicles: [TANK] }), { picked: ['tank'] });
  assert.deepEqual([Boolean(tow(alone)), 'tow' in alone.refused], [false, false]);
  const fixed = field({ vehicles: [TANK, TRUCK, { id: 'post', name: 'Posto', x: 1020, pieces: [] }] }); delete fixed.state.actors[2].vehicle;
  const post = panel(fixed, { picked: ['post'] });
  assert.deepEqual([Boolean(tow(post)), post.refused.tow], [false, 'Selecione um veículo móvel: estruturas permanecem no local.']);
  // Either end of a cable, picked alone, lets go of it at once: no place to point at, and nothing waits for a click.
  world.state.tows = [{ actorId: 'tank', targetId: 'truck', anchorA: { x: 1, y: 1 }, anchorB: { x: 4, y: 1 }, length: 3, tension: 0, limit: 1e4 }];
  for (const id of ['tank', 'truck']) {
    const p = panel(world, { picked: [id], armed: 'tow' });
    assert.deepEqual([tow(p).label, tow(p).name, tow(p).hint, tow(p).release, tow(p).ids], ['Soltar', 'Soltar o cabo', '', true, [id]]);
    assert.equal(p.armed, '');
  }
});

test('a structure that extracts does so by itself where it stands: no order of a vein, no button over one, and Parar only with a gun', () => {
  const fixed = 'Selecione um veículo móvel: estruturas permanecem no local.',
    stand = (...pieces) => { const world = field({ vehicles: [TRUCK, { id: 'well', name: 'Poço', x: 5400, pieces, quote: { extracting: 'petroleo:4' } }] });
      delete world.state.actors.find(actor => actor.id === 'well').vehicle; return world; },
    well = stand(piece('well', 'drill')), p = panel(well, { picked: ['well'], deposits: GROUND });
  assert.deepEqual([p.orders, collected(p), p.squad.units.find(u => u.id === 'well').status], [[], [], 'extraindo na jazida']);
  assert.deepEqual([p.refused.haul, p.refused.stop, p.refused.move], [fixed, fixed, fixed], 'a key of an order says why there is none');
  assert.deepEqual(acts(p), ['copy', 'dismantle', 'abandon'], 'Mais ações stays, with what is done to it');
  // With a gun it has an order to stop.
  assert.deepEqual(ids(panel(stand(piece('well', 'drill'), gun('well'), rounds('well')), { picked: ['well'], deposits: GROUND }).orders), ['attack', 'bombard', 'stop']);
  // Picked with a lorry, the lorry is the one sent to a vein.
  const both = panel(well, { picked: ['truck', 'well'], deposits: GROUND });
  assert.deepEqual([both.orders.find(order => order.id === 'haul').ids, both.veins.filter(row => row.collect).map(row => [row.id, row.collect.ids])],
    [['truck'], [['ferro:1', ['truck']]]]);
  assert.deepEqual(both.orders.find(order => order.id === 'stop').ids, ['truck']);
});

test('the column has those that fight, then those that work for the faction, then those that stay, each with the one mark worth one', () => {
  const builder = { id: 'builder', name: 'Construtor', x: 1000, pieces: [gun('builder'), rounds('builder')], quote: { builder: true } },
    dry = { id: 'dry', name: 'Seco', x: 3000, pieces: [gun('dry'), rounds('dry')], fuelStarved: true, fuel: [0, 0], quote: {} },
    lame = { id: 'lame', name: 'Parado', x: 3000, pieces: [gun('lame'), rounds('lame')], quote: {} },
    firing = { id: 'firing', name: 'Atirando', x: 3000, pieces: [gun('firing'), rounds('firing')], order: { attack: { targetId: 'foe' } }, quote: {} },
    fresh = { id: 'fresh', name: 'Novo', x: 1000, pieces: [gun('fresh'), rounds('fresh')], quote: { atBase: true, service: { kind: 'build', until: 130 } } },
    post = { id: 'post', name: 'Posto', x: 1100, pieces: [gun('post'), rounds('post')], quote: {} },
    world = field({ vehicles: [TRUCK, post, SUPPLIER, TANK, builder, dry, lame, firing, fresh], manual: 'tank' });
  delete world.state.actors.find(actor => actor.id === 'post').vehicle;
  world.state.actors.find(actor => actor.id === 'lame').vehicle.gearCount = 0;
  const before = structuredClone(world), p = panel(world);
  assert.deepEqual(p.squad.units.map(u => [u.id, u.group, u.number, u.mark, u.until]), [
    ['tank', 'attack', 1, 'manual', null], ['dry', 'attack', 2, 'dry', null], ['lame', 'attack', 3, 'stuck', null], ['firing', 'attack', 4, 'fire', null],
    ['fresh', 'attack', 5, 'build', 130],
    ['truck', 'logistics', 6, '', null], ['supply', 'logistics', 7, '', null], ['builder', 'logistics', 8, '', null],
    ['post', 'fixed', 9, '', null]]);
  assert.deepEqual(world, before);
  // A lost construction bears no mark.
  firing.order.defeated = true;
  assert.equal(panel(field({ vehicles: [firing] })).squad.units[0].mark, '');
});

test('fixed defenses offer weapon orders and operation, without promising movement or a turn', () => {
  const world = field({ vehicles: [TANK, TRUCK] }); delete world.state.actors[0].vehicle;
  const before = structuredClone(world), p = panel(world, { picked: ['tank'] });
  assert.deepEqual(ids(p.orders), ['attack', 'bombard', 'stop']);
  assert.deepEqual(p.orders.map(o => o.ids), [['tank'], ['tank'], ['tank']]);
  assert.match(p.squad.note, /Estrutura/);
  assert.deepEqual(p.squad.units.map(u => [u.id, u.group, u.number]), [['truck', 'logistics', 1], ['tank', 'fixed', 2]], 'the fixed stand last in the column');
  assert.equal(p.control, true); assert.match(p.controlTitle, /sem deslocá-la/);
  assert.match(p.refused.move, /estruturas/); assert.match(p.refused.turn, /estruturas/);
  world.state.squad.manual = 'tank'; const direct = panel(world);
  assert.equal(direct.turn, false); assert.equal(direct.weapon, true);
  world.state.squad.manual = null; assert.deepEqual(world, before);
});

test('disconnecting during direct control keeps turn visible with a reconnect explanation without allowing manual input', () => {
  const world = field({ vehicles: [TRUCK], manual: 'truck' }), before = structuredClone(world), lost = panel(world, { connected: false });
  assert.equal(lost.situation, 'offline');
  assert.deepEqual([lost.turn, lost.turnDisabled], [true, true]);
  assert.match(lost.turnReason, /conexão.*Aguarde.*reconexão/);
  assert.equal(lost.turnReason, lost.refused.turn);
  assert.equal(lost.control, false); assert.equal(lost.release, false);
  assert.deepEqual(world, before);
});

test('mixed selection preserves everyone and counts only relevant recipients of each command', () => {
  const world = field({ vehicles: [TANK, TRUCK] }); delete world.state.actors[0].vehicle;
  const before = structuredClone(world), p = panel(world, { picked: ['tank', 'truck'], armed: 'move', deposits: GROUND }),
    recipients = Object.fromEntries(p.orders.map(o => [o.id, o.ids]));
  assert.deepEqual(recipients, { move: ['truck'], attack: ['tank'], bombard: ['tank'], haul: ['truck'], turn: ['truck'], home: ['truck'], stop: ['tank', 'truck'] });
  assert.deepEqual(p.squad.units.filter(u => u.selected).map(u => u.id), ['truck', 'tank']);
  assert.match(p.armed, /^Mover · 1 de 2 selecionados:/); assert.equal(p.squad.note, '1 móvel · 1 estrutura');
  assert.deepEqual(p.veins.find(d => d.id === 'ferro:1').collect.ids, ['truck']);
  assert.equal(p.veins.find(d => d.id === 'petroleo:4').collect, null); assert.deepEqual(world, before);
});

test('empty fuel or ammunition does not hide a useful order, while a service holds only the turn', () => {
  const world = field({ vehicles: [{ ...TANK, fuelStarved: true, fuel: [0, 0], pieces: [gun('tank'), rounds('tank', 0)], quote: { service: { kind: 'repair', until: 110, cost: bill(10) } } }] }),
    p = panel(world, { picked: ['tank'] });
  assert.deepEqual(ids(p.orders), ['move', 'attack', 'bombard', 'turn', 'home', 'stop']);
  assert.equal(p.orders.find(order => order.id === 'turn').disabled, true);
  assert.match(p.refused.turn, /serviço/); assert.equal(p.stats.rounds.text, '0'); assert.equal(p.stats.fuel.low, true);
  const disabled = field({ vehicles: [TRUCK] }); disabled.state.actors[0].vehicle.enabled = false;
  assert.deepEqual(ids(panel(disabled, { picked: ['truck'] }).orders), ['haul', 'stop']);
  assert.deepEqual(panel(disabled, { picked: ['truck'] }).squad.units.map(u => [u.id, u.group, u.mobile]),
    [['truck', 'logistics', false]], 'a disabled carrier remains a vehicle while movement orders stay unavailable');
});

test('material-specific deposit recipients separate ore containers from oil containers in the same selection', () => {
  const tanker = { ...TRUCK, id: 'tanker', pieces: [piece('tanker', 'cistern')] }, world = field({ vehicles: [TRUCK, tanker, TANK] }),
    p = panel(world, { picked: ['truck', 'tanker', 'tank'], deposits: GROUND, armed: 'haul' });
  assert.deepEqual(p.veins.filter(d => d.collect).map(d => [d.id, d.collect.ids]), [['ferro:1', ['truck']], ['petroleo:4', ['tanker']]]);
  assert.deepEqual(p.orders.find(o => o.id === 'haul').ids, ['truck', 'tanker']);
  assert.match(p.armed, /^Transportar · 2 de 3 selecionados:/);
});

test('collection distinguishes unknown veins, veins beside bases and a dropped cargo with no reserve to extract without hiding the installed role', () => {
  const show = (known, kind = 'hopper', activity = null) => panel(field({ vehicles: [{ ...TRUCK, pieces: [piece('truck', kind)], quote: {} }],
    faction: { deposits: known, activity } }), { picked: ['truck'], deposits: GROUND }),
    // A cargo dropped on the field, as the faction is told of it: a pile and no reserve.
    drop = { id: 'airdrop:1', type: 'airdrop', feature: 'airdrop', x: 5100, material: 'ferro', reserve: 0, left: 0, stock: 4000,
      phase: 'collection', arrivesAt: 80, expiresAt: 600, active: true, guarded: true, seen: true },
    cases = [
      [[[]], /Nenhum local de coleta.*conhecido.*Explore.*reconhecimento/],
      [[[vein('petroleo:4')]], /Nenhum local de coleta.*conhecido.*Explore.*reconhecimento/],
      [[[vein('ferro:1', { active: false })]], /Nenhum local de coleta.*disponível.*prazo.*bases/],
      [[[], 'excavator', drop], /^O local de coleta conhecido só tem carga pronta, sem reserva para extrair\. Leve um veículo com caçamba\.$/],
    ];
  for (const [situation, reason] of cases) {
    const p = show(...situation), haul = p.orders.find(order => order.id === 'haul');
    assert(haul && haul.disabled); assert.deepEqual(haul.ids, []); assert.match(haul.reason, reason);
    assert.equal(p.refused.haul, haul.reason);
  }
  assert.equal(show([], 'hopper', drop).orders.find(order => order.id === 'haul').disabled, false, 'that pile is for a container to take');
  // A vein of the ground the faction last knew empty, with nothing ready there, is worked all the same: it comes back.
  for (const kind of ['hopper', 'excavator']) {
    const emptied = show([vein('ferro:1', { left: 0, stock: 0 })], kind).orders.find(order => order.id === 'haul');
    assert.deepEqual([emptied.disabled, emptied.ids, emptied.reason], [false, ['truck'], '']);
  }
  const pile = [vein('ferro:1', { left: 0, stock: 500 })];
  assert.equal(show(pile).orders.find(order => order.id === 'haul').disabled, false, 'a ready pile remains real transport work');
  const extractor = show(pile, 'excavator').orders.find(order => order.id === 'haul');
  assert.deepEqual([extractor.name, extractor.disabled, extractor.ids], ['Extrair', false, ['truck']]);
  assert.equal(show([vein('ferro:1', { stock: 0 })]).orders.find(order => order.id === 'haul').disabled, false,
    'a transporter may wait for production at a live reserve');
});

test('missing collection equipment hides its action while destroyed or detached equipment keeps a complete-repair explanation', () => {
  const show = pieces => panel(field({ vehicles: [{ ...TRUCK, pieces, quote: {} }] }), { picked: ['truck'], deposits: GROUND });
  assert.equal(show([]).orders.some(order => order.id === 'haul'), false);
  for (const kind of ['hopper', 'cistern', 'excavator', 'drill']) for (const damage of [{ health: 0 }, { attached: false }]) {
    const p = show([piece('truck', kind, damage)]), haul = p.orders.find(order => order.id === 'haul');
    assert(haul && haul.disabled); assert.deepEqual(haul.ids, []);
    assert.match(haul.reason, /inutilizado.*reparo completo.*base.*suprimentos/);
    assert.equal(haul.reason, p.refused.haul);
  }
});

test('mixed collection keeps only accepted recipients without changing selection, fullness, cargo or current orders', () => {
  const broken = { ...TRUCK, id: 'broken', pieces: [piece('broken', 'hopper', { health: 0 })] },
    oil = { ...TRUCK, id: 'oil', pieces: [piece('oil', 'cistern')] },
    loaded = { ...TRUCK, quote: { ...TRUCK.quote, fill: { solid: 1, liquid: 0 }, cargo: load(10000) }, fuelStarved: true, fuel: [0, 0],
      order: { haul: { depositId: 'ferro:1', material: 'ferro', phase: 'home' } } },
    world = field({ vehicles: [loaded, broken, oil, TANK], faction: { deposits: [vein('ferro:1')] } }), before = structuredClone(world),
    p = panel(world, { picked: ['truck', 'broken', 'oil', 'tank'], deposits: GROUND, armed: 'haul' }), haul = p.orders.find(order => order.id === 'haul');
  assert.deepEqual([haul.disabled, haul.ids, haul.reason], [false, ['truck'], '']);
  assert.deepEqual(p.veins[0].collect.ids, ['truck']);
  assert.match(p.armed, /1 de 4 selecionados/);
  assert.deepEqual(p.squad.units.filter(u => u.selected).map(u => u.id), ['tank', 'truck', 'broken', 'oil']);
  assert.deepEqual(world, before, 'presenting an unavailable intention never cancels an accepted world order or edits cargo');
});

test('damaged guns, empty fuel, empty ammunition and blocked vision preserve accepted attack intentions', () => {
  for (const damage of [{ health: 0 }, { attached: false }, { barrelDisabled: true }]) {
    const world = field({ vehicles: [{ ...TANK, pieces: [gun('tank', damage), rounds('tank', 0)], fuelStarved: true, fuel: [0, 0], eyes: [],
      quote: { service: { kind: 'repair', until: 110, cost: bill() } } }], faction: { explored: [[0, 2000]] } }), before = structuredClone(world),
      p = panel(world, { picked: ['tank'], armed: 'attack' });
    for (const kind of ['move', 'attack', 'bombard']) {
      const action = p.orders.find(order => order.id === kind);
      assert.deepEqual([action.disabled, action.ids, action.reason], [false, ['tank'], '']);
      assert.equal(p.refused[kind], undefined);
    }
    assert.match(p.armed, /^Atacar · 1 veículo:/); assert(p.stances);
    assert.deepEqual(world, before);
  }
});

test('turning remains visible during service in both command modes and a mixed order addresses only free mobile vehicles', () => {
  for (const kind of ['build', 'repair', 'turn']) {
    const world = field({ vehicles: [{ ...TRUCK, quote: { service: { kind, until: 110, cost: bill() } } }] }),
      p = panel(world, { picked: ['truck'] }), turn = p.orders.find(order => order.id === 'turn');
    assert(turn && turn.disabled); assert.deepEqual(turn.ids, []); assert.match(turn.reason, /durante o serviço.*Aguarde/);
    assert.equal(turn.reason, p.refused.turn);
    world.state.squad.manual = 'truck'; const direct = panel(world);
    assert.deepEqual([direct.turn, direct.turnDisabled, direct.turnReason], [true, true, turn.reason]);
  }
  const world = field({ vehicles: [{ ...TRUCK, quote: { service: { kind: 'repair', until: 110, cost: bill() } } }, TANK] }),
    p = panel(world, { picked: ['truck', 'tank'] }), turn = p.orders.find(order => order.id === 'turn');
  assert.deepEqual([turn.disabled, turn.ids, turn.reason], [false, ['tank'], '']);
  world.state.squad.manual = 'tank'; const direct = panel(world);
  assert.deepEqual([direct.turn, direct.turnDisabled, direct.turnReason], [true, false, '']);
});

test('an armed job that becomes temporarily unavailable keeps its identity and explains the cause without asking for a target', () => {
  const accepted = { depositId: 'ferro:1', material: 'ferro', phase: 'home' },
    world = field({ vehicles: [{ ...TRUCK, order: { haul: accepted } }] }), options = { picked: ['truck'], deposits: GROUND, armed: 'haul' };
  assert.match(panel(world, options).armed, /^Transportar · 1 veículo:/);
  world.faction.deposits = [];
  const before = structuredClone(world), p = panel(world, options), haul = p.orders.find(order => order.id === 'haul');
  assert.equal(haul.disabled, true); assert.equal(haul.active, false);
  assert.equal(p.armed, 'Transportar indisponível · ' + haul.reason);
  assert.doesNotMatch(p.armed, /clique|toque|no terreno|num local de coleta/);
  assert.deepEqual(world, before, 'an already accepted return is untouched by client action availability');
});

test('connection loss preserves compatible selected actions as disabled and reconnecting restores their real recipient subsets', () => {
  const world = field({ vehicles: [TRUCK, TANK] }), before = structuredClone(world), options = { picked: ['truck', 'tank'], deposits: GROUND, armed: 'haul' },
    connected = panel(world, options), lost = panel(world, { ...options, connected: false });
  assert.deepEqual(ids(lost.orders), ids(connected.orders));
  for (const action of lost.orders) {
    assert.equal(action.disabled, true); assert.equal(action.active, false); assert.deepEqual(action.ids, []);
    assert.match(action.reason, /conexão.*Aguarde.*reconexão/); assert.equal(lost.refused[action.id], action.reason);
  }
  assert.match(lost.armed, /^Transportar indisponível/); assert.doesNotMatch(lost.armed, /clique|toque/);
  const restored = panel(world, options);
  assert.deepEqual(restored.orders, connected.orders); assert.deepEqual(world, before);
});

test('each row of the squad says in one line what the vehicle is doing', () => {
  const foe = { id: 'foe', ownerId: 'caio', team: 'red', name: 'Tigre', playerName: 'Caio', x: 2400 },
    status = (vehicle, others = [foe]) => panel(field({ vehicles: [vehicle, { ...TRUCK, id: 'second', pieces: [] }], others })).squad.units[0].status,
    whole = { ...TANK, quote: { atBase: true } };
  assert.equal(status({ ...whole, order: { move: { x: 2210 } } }), 'em movimento · faltam 1.200 m');
  assert.equal(status({ ...whole, order: { attack: { targetId: 'foe' }, reason: 'reloading' } }), 'atacando o veículo de Caio · recarregando');
  assert.equal(status({ ...whole, order: { attack: { targetId: 'foe' }, reason: 'search-contact' } }), 'atacando o veículo de Caio · nenhum inimigo detectado');
  assert.equal(status({ ...whole, order: { attack: { point: { x: 3010, y: 4 } }, reason: 'bombarding' } }), 'bombardeio a 2.000 m · bombardeando o ponto');
  // With no order it says its stance; nothing of having no enemy in sight, which is how a quiet field is.
  assert.deepEqual(['hold', 'return', 'fire'].map(stance => status({ ...whole, order: { stance, reason: 'search-contact' } })), ['segurando fogo', 'revidar', 'fogo livre']);
  const covered = panel(field({ vehicles: [{ ...whole, order: { stance: 'fire', reason: 'terrain-cover', activity: 'watching' } }], others: [foe] })).squad.units[0];
  assert.deepEqual([covered.status, covered.doing], ['fogo livre · alvo encoberto pelo terreno', '']);
  const moving = panel(field({ vehicles: [{ ...whole, order: { stance: 'fire', move: { x: 2210 }, reason: 'terrain-cover', activity: 'moving' } }], others: [foe] })).squad.units[0];
  assert.deepEqual([moving.status, moving.doing], ['em movimento · faltam 1.200 m · alvo encoberto pelo terreno', 'move']);
  // A fresh contact says more than the gun's silence.
  assert.equal(status({ ...whole, order: { reason: 'reloading', heard: { x: 1330, channel: 'sound' } } }), 'revidar · ouviu um inimigo a 320 m →');
  // A vehicle with no gun says nothing of guns: only what stops it on its way.
  assert.equal(status({ ...TRUCK, quote: {}, order: { reason: 'no-armed-feed' } }), 'parado');
  assert.equal(status({ ...TRUCK, quote: {}, order: { move: { x: 5100 }, reason: 'blocked-way' } }), 'em movimento · faltam 100 m · caminho bloqueado');
  // A machine whose job says its way was shut, as its squad does, says it once.
  assert.equal(status({ ...TRUCK, quote: { auto: true, job: { kind: 'grade', phase: 'go', targetId: 'r1', reason: 'blocked-way' } }, order: { reason: 'blocked-way' } }),
    'caminho bloqueado');
  assert.equal(status({ ...TRUCK, order: { haul: { depositId: 'ferro:1', phase: 'load' } } }), 'transportando · carregando · 38%');
  assert.equal(status({ ...TRUCK, order: { defeated: true, alert: true } }), 'fora de combate');
  const rows = panel(field({ vehicles: [{ ...whole, order: { alert: true, heard: { x: 1330, channel: 'radar' } } }, { ...TRUCK, order: { defeated: true, alert: true } }] })).squad.units;
  assert.deepEqual(rows.map(u => [u.alert, u.heard, u.defeated]), [[true, true, false], [false, false, true]]);
});

// The column draws each construction by its design (squad-ux.ts): of each piece of it that is damaged, how much, by its id in
// the design — the field names its parts after the construction and its revision —, and under it how full its tanks are.
test('each row of the squad tells the column what of the construction is damaged, by the pieces of its design, and how full its tanks are', () => {
  const tank = (id, patch) => piece(id, 'fuel', { id: id + ':3:fuel', capacityLitres: 200, ...patch }),
    plate = (id, piece, patch) => ({ id: `${id}:3:${piece}`, actorId: id, definition: {}, integrity: 1, attached: true, ...patch }),
    world = (vehicle, plates = [], patch = {}) => {
      const w = field({ vehicles: [{ ...TRUCK, quote: {}, fuel: [100, 50], ...vehicle }] });
      w.state.actors[0].revision = 3; w.state.plates.push(...plates); Object.assign(w.faction.units[0], patch);
      Object.assign(w.state.modules.find(m => m.kind === 'command'), { id: w.state.actors[0].id + ':3:command', health: 100 }); return w;
    },
    row = (...args) => panel(world(...args)).squad.units[0];
  // A few holes in a plate are nothing; a good share of it shot through is damage, and a piece torn off or shot away is lost.
  const hit = row({ pieces: [tank('truck'), piece('truck', 'engine', { id: 'truck:3:engine', health: 50 }), piece('truck', 'hopper', { id: 'truck:3:hopper', attached: false })] },
    [plate('truck', 'hull:roof', { integrity: .5 }), plate('truck', 'hull:side', { integrity: .9 }), plate('truck', 'hull:nose', { attached: false })]);
  assert.deepEqual(hit.damage, { 'hull:roof': 'hurt', 'hull:nose': 'lost', engine: 'hurt', hopper: 'lost' });
  assert.deepEqual(row({ pieces: [tank('truck')] }).damage, {}, 'whole');
  // Its tanks: how full, low as the field sends a supply vehicle for, or dry; of those it still draws from.
  assert.deepEqual(row({ pieces: [tank('truck')] }).fuel, { share: .5, level: '' });
  assert.deepEqual(row({ pieces: [tank('truck')] }, [], { fuelLow: true }).fuel, { share: .5, level: 'low' });
  assert.deepEqual(row({ pieces: [tank('truck')], fuelStarved: true, fuel: [0, 0] }, [], { fuelLow: true }).fuel, { share: 0, level: 'empty' });
  assert.deepEqual(row({ pieces: [tank('truck'), tank('truck', { id: 'truck:3:fuel-2', health: 0 })] }).fuel, { share: .5, level: '' }, 'a tank shot away takes nothing');
  assert.deepEqual(row({ pieces: [tank('truck', { detonated: true })], fuel: [0, 0] }).fuel, { share: 0, level: 'empty' }, 'nothing to draw from');
  assert.equal(row({ pieces: [piece('truck', 'hopper')] }).fuel, null, 'no tank, no hairline');
  const lost = panel(world({ pieces: [tank('truck', { health: 0 })], order: { defeated: true } })).squad.units[0];
  assert.deepEqual([lost.damage, lost.fuel], [{}, null], 'one lost is drawn as it was');
  // A structure's tanks hold what they take less what filling them costs.
  const post = (rearm, patch) => { const w = world({ id: 'post', pieces: [tank('post')] }, [], { rearm: bill(0, 0, 0, rearm), ...patch }); delete w.state.actors[0].vehicle; return panel(w).squad.units[0].fuel; };
  assert.deepEqual([post(50), post(150, { fuelLow: true }), post(200)], [{ share: .75, level: '' }, { share: .25, level: 'low' }, { share: 0, level: 'empty' }]);
});

test('an unarmed hauler under direct control away from the base has no weapon block, its load in a line, and no job but to tip some of that out', () => {
  const world = field({ vehicles: [TRUCK, TANK], manual: 'truck' }), p = panel(world, { picked: ['truck'], deposits: GROUND });
  assert.equal(p.situation, 'direct');
  assert.deepEqual([p.weapon, p.services, p.held], [false, [DUMP], '']);
  assert.deepEqual([gauges(p), p.stats.cargo.title], [{ fuel: '180 L · 240 km', cargo: '38%', whole: '100%' }, 'Carga: Ferro 4.250 · 38% · carregando']);
  // Its gauges remain its own; the column still has the other vehicles so control can switch directly.
  assert.deepEqual([p.squad.title, p.squad.tag, p.release], ['CONTROLE DIRETO', '', true]);
  assert.deepEqual(p.squad.units.filter(u => u.manual).map(u => [u.number, u.name, u.manual, u.selected, u.status, u.mark]),
    [[2, 'Caminhão', true, false, 'sob seu controle', 'manual']]);
  assert.deepEqual(ids(p.squad.units), ['tank', 'truck']);
  assert.deepEqual([p.orders, p.stances, p.control, p.actions, p.armed], [[], null, false, [], '']);
  // It is driven to a vein: the button over one is an order to the squad.
  assert.deepEqual(collected(p), []);
  // One that carries nothing yet says so, and has nothing to tip out.
  const bare = panel(field({ vehicles: [{ ...TRUCK, quote: {} }], manual: 'truck' }));
  assert.deepEqual([bare.stats.cargo.text, bare.services], ['vazia', []]);
  // Full, its load is tipped out wherever it stands but in its base: there it is put down whole, and the job is not offered.
  const full = { cargo: load(0, 0, 17695), fill: { solid: 1, liquid: 0 } }, stuck = panel(field({ vehicles: [{ ...TRUCK, quote: full }], manual: 'truck' }));
  assert.deepEqual([stuck.stats.cargo.text, stuck.stats.cargo.title, stuck.services], ['cheia', 'Carga: Sílica 17.695 · cheia', [DUMP]]);
  assert.deepEqual(panel(field({ vehicles: [{ ...TRUCK, quote: full }] }), { picked: ['truck'] }).services, [DUMP], 'picked alone, the same');
  assert.deepEqual(panel(field({ vehicles: [{ ...TRUCK, x: 1010, quote: { ...full, atBase: true } }], manual: 'truck' })).services, []);
  // Under repair there is the repair to cancel, and no more; and with more than one picked there is no job of one.
  const mending = { ...full, service: { kind: 'repair', until: 106.2, cost: bill(2013), payer: 'tank' } };
  assert.deepEqual(ids(panel(field({ vehicles: [{ ...TRUCK, quote: mending }] }), { picked: ['truck'] }).services), ['cancel']);
  assert.deepEqual(panel(field({ vehicles: [{ ...TRUCK, quote: full }, TANK] }), { picked: ['truck', 'tank'] }).services, []);
});

test('an armed construction under direct control has its weapon block, and in the base what the base can do', () => {
  const p = panel(field({ vehicles: [TRUCK, TANK], manual: 'tank' }));
  assert.deepEqual([p.situation, p.weapon, p.stats.cargo, p.release], ['direct', true, null, true]);
  assert.deepEqual(p.squad.units.filter(u => u.manual).map(u => [u.number, u.name, u.status, u.mark]), [[1, 'Blindado', 'sob seu controle', 'manual']]);
  assert.deepEqual(ids(p.squad.units), ['tank', 'truck']);
  assert.equal(p.squad.units[1].mark, ''); assert.equal(gauges(p).whole, '80%');
  // The base repairs the parked vehicle in hand too; the driver can accelerate to cancel when it starts.
  assert.deepEqual([p.services, p.orders, p.stances, p.actions], [[], [], null, []]);
  // Its gun shot away: the block stays to say so.
  const silenced = panel(field({ vehicles: [{ ...TANK, pieces: [gun('tank', { health: 0 }), rounds('tank')] }], manual: 'tank' }));
  assert.equal(silenced.weapon, true);
  // A vehicle destroyed under the player's hands is in nobody's: the squad is commanded again.
  assert.equal(panel(field({ vehicles: [{ ...TANK, order: { defeated: true } }, TRUCK], manual: 'tank' })).situation, 'command');
});

test('the workshop of the field has the design and its publishing, with replacing only when there is something to replace', () => {
  const world = field({ vehicles: [TRUCK, TANK] }), price = bill(21148, 0, 0, 203),
    bare = panel(world, { tab: 'edit', price, picked: ['tank'], deposits: GROUND }), focused = panel(world, { tab: 'edit', price, focus: 'tank' });
  assert.deepEqual([bare.situation, bare.project], ['workshop', true]);
  assert.deepEqual([bare.publish.spawn.text, bare.publish.spawn.disabled, bare.publish.text], ['Fabricar novo veículo', false, '']);
  assert.deepEqual([bare.publish.costs.map(c => c.text), bare.publish.seconds], [['21.148', '203 L'], 47]);
  assert.equal(bare.publish.replace, null);
  // Nothing of the field's own tab is here.
  assert.deepEqual([bare.squad, bare.orders, bare.stances, bare.control, bare.stats, bare.services, bare.actions, collected(bare), bare.weapon, bare.empty],
    [null, [], null, false, null, [], [], [], false, false]);
  // The construction last in the player's hands is named, with what replacing it comes to.
  assert.deepEqual([focused.publish.replace.text, focused.publish.replace.disabled], ['Substituir 1. Blindado · Ferro 12.148 + Combustível 203 L · 29 s', false]);
  const far = panel(world, { tab: 'edit', price, focus: 'truck' }).publish.replace;
  assert.deepEqual([far.text, far.disabled, far.title], ['Substituir 2. Caminhão · Ferro 12.148 + Combustível 203 L · 29 s', true, 'Fora da base: leve a construção até a base.']);
  // One that left the field is nothing to replace.
  assert.equal(panel(world, { tab: 'edit', price, focus: 'gone' }).publish.replace, null);
  assert.equal(panel(field(), { tab: 'edit', price }).publish.replace, null);
  // The line under the button is why it cannot be published, when it cannot.
  const dear = panel(field({ faction: { stock: bill(100) } }), { tab: 'edit', price }).publish;
  assert.equal(dear.spawn.disabled, true); assert.match(dear.text, /^Faltam Ferro e Combustível/);
  // None of it on the field's own tab.
  assert.equal(panel(world, { price, focus: 'tank' }).publish, null);
});

test('a player another member took out of the faction is told so once, by the faction that came instead', () => {
  const memo = {}, look = (id, removed = null) => panel(field({ vehicles: [TANK], faction: { id, removed } })).watch,
    removed = { at: 50, from: { name: 'Caio', nation: 'Império do Sul' } };
  assert.deepEqual(fieldNotices(memo, look('green'), 0), []);
  assert.deepEqual([fieldNotices(memo, look('blue', removed), 1), memo.grave], [['A facção Império do Sul tirou você dela. Você começou uma facção nova, com base própria.'], true]);
  assert.deepEqual(fieldNotices(memo, look('blue', removed), 2), []);
  // Coming into another faction of one's own asking says nothing of the kind.
  assert.deepEqual(fieldNotices(memo, look('red'), 3), []);
});

test('the page of the faction has the nations by their wealth, its members and whoever may be invited, and the connection is worth a line only when slow or lost', () => {
  const alone = panel(field({ vehicles: [TANK] }));
  assert.deepEqual([alone.faction.invitable, alone.faction.invites, alone.faction.leave, alone.connection], [[], [], false, '']);
  // Edu is of the faction. Caio's is in sight, and invited the player; Fabi's was last seen four minutes ago, 12,3 km to the right of the base;
  // Gil's was defeated six minutes ago and not seen since. Beto and Hugo are on the field in factions not met.
  const person = (id, name, patch = {}) => ({ id, name, connected: true, invited: false, ...patch }),
    FLAG = { field: 'cross', colours: [4, 0, 8], emblem: 'star' },
    known = [{ id: 'grey', name: 'Gil', nation: null, flag: FLAG, color: '#999', members: [person('gil', 'Gil')], seen: false, at: null, x: null, defeated: 620 },
      { id: 'blue', name: 'Fabi', nation: 'Império do Sul', flag: FLAG, color: '#69c', members: [person('fabi', 'Fabi', { invited: true })], seen: false, at: 745, x: 13300, defeated: null },
      { id: 'red', name: 'Caio', nation: null, flag: FLAG, color: '#c66', members: [person('caio', 'Caio'), person('duda', 'Duda', { connected: false })], seen: true, at: null, x: null, defeated: null }],
    strangers = [person('beto', 'Beto', { invited: true }), person('hugo', 'Hugo', { connected: false })],
    ranking = [{ id: 'blue', ref: 'r-blue', name: 'Fabi', nation: 'Império do Sul', flag: FLAG, wealth: 2_480_000 }, { id: 'green', ref: 'r-green', name: 'Ana', nation: null, flag: FLAG, wealth: 412_300 },
      { id: 'red', ref: 'r-red', name: 'Caio', nation: null, flag: FLAG, wealth: 9_800 }, { id: 'grey', ref: 'r-grey', name: 'Gil', nation: null, flag: FLAG, wealth: 0 }],
    world = field({ vehicles: [TANK], time: 1000, faction: { members: [{ id: 'ana', name: 'Ana', connected: true, role: 'leader' }, { id: 'edu', name: 'Edu', connected: true, role: 'member' }],
      known, strangers, ranking, invites: [{ factionId: 'red', ref: 'r-red', name: 'Caio', nation: null, flag: FLAG, members: 2 }] } });
  for (const p of [panel(world), panel(world, { tab: 'edit', price: bill(100) })]) {
    assert.deepEqual(p.faction.standing, { place: 2, of: 4, points: '412,3 mil pontos', title: '412.300 pontos de riqueza' });
    assert.deepEqual(p.faction.ranking.map(r => [r.place, r.name, r.wealth, r.detail, r.x, r.act]), [
      [1, 'Império do Sul', '2,5 milhões', 'vista há 4 min · a 12,3 km →', 13300, 'apply'], [2, 'Facção de Ana', '412,3 mil', 'sua nação', null, null],
      [3, 'Facção de Caio', '9.800', 'à vista agora', null, null], [4, 'Facção de Gil', '0', 'derrotada há 6 min', null, 'apply']]);
    assert.deepEqual(p.faction.members.map(m => [m.id, m.detail, m.actions]), [['ana', 'líder · você', []], ['edu', 'membro', ['remove', 'admin', 'leader']]]);
    assert.deepEqual(p.faction.invitable.map(r => [r.id, r.act, r.detail]), [
      ['gil', 'invite', 'Facção de Gil'], ['fabi', 'cancel', 'Império do Sul'], ['caio', 'invite', 'Facção de Caio'], ['duda', 'invite', 'Facção de Caio · desconectado'],
      ['beto', 'cancel', 'ainda não encontrado'], ['hugo', 'invite', 'ainda não encontrado · desconectado']]);
    assert.deepEqual(p.faction.invites, [{ factionId: 'red', name: 'Facção de Caio', flag: FLAG, text: '2 membros' }], 'an invitation is answered from either tab');
    assert.equal(p.faction.leave, true, 'another member keeps the faction');
  }
  // First contact is said once, as it comes about, and so is the defeat of a faction that was met: neither is bad news of a vehicle.
  const memo = {}, met = (list, id = 'green') => panel(field({ vehicles: [TANK], faction: { id, known: list } })).watch, [gil, fabi, caio] = known, beaten = { ...caio, seen: false, defeated: 900 };
  assert.deepEqual(met([caio, gil]).met, [{ id: 'red', name: 'Facção de Caio', defeated: null }, { id: 'grey', name: 'Facção de Gil', defeated: 620 }]);
  assert.deepEqual(fieldNotices(memo, met([]), 0), []);
  assert.deepEqual([fieldNotices(memo, met([caio]), 1), memo.grave], [['Nova facção encontrada: Facção de Caio.'], false]);
  assert.deepEqual(fieldNotices(memo, met([caio, fabi]), 2), ['Nova facção encontrada: Império do Sul.']); assert.deepEqual(fieldNotices(memo, met([caio, fabi]), 3), []);
  assert.deepEqual([fieldNotices(memo, met([beaten, fabi]), 4), memo.grave], [['Facção de Caio perdeu a base.'], false]);
  assert.deepEqual(fieldNotices(memo, met([beaten, fabi]), 5), []);
  // Seen again it is a faction like any other, and nothing is said of that; defeated again, it is said again.
  assert.deepEqual(fieldNotices(memo, met([caio, fabi]), 6), []);
  assert.deepEqual(fieldNotices(memo, met([{ ...beaten, defeated: 950 }, fabi]), 7), ['Facção de Caio perdeu a base.']);
  // A faction that is gone is dropped without a word; what a faction the player came into already knew is no news; nor is what was so at the first look.
  assert.deepEqual(fieldNotices(memo, met([fabi]), 8), []); assert.deepEqual(fieldNotices(memo, met(known, 'red'), 9), []); assert.deepEqual(fieldNotices({}, met(known), 0), []);
  // The connection: nothing while it answers, one line when it is slow, another when it is lost.
  assert.equal(panel(world, { pingMs: 180 }).connection, ''); assert.equal(panel(world, { pingMs: 412.4 }).connection, 'Conexão lenta · 412 ms');
  const lost = panel(world, { connected: false, picked: ['tank'] });
  assert.deepEqual([lost.situation, lost.connection], ['offline', 'Sem conexão com o campo: reconectando…']);
  // What the last frame showed stays on the list; nothing can be asked of it until the field answers.
  assert.deepEqual([lost.squad.units.length, lost.control, lost.services, lost.actions, lost.faction, lost.wrecks], [1, false, [], [], null, []]);
  assert(lost.orders.length > 0 && lost.orders.every(order => order.disabled && order.ids.length === 0));
  assert(lost.orders.every(order => /conexão.*Aguarde/.test(order.reason)));
});

test('every wreck has its card, and the button over its mark for a vehicle picked beside it that can work on it', () => {
  const wrecks = [{ id: 'w', name: 'Morteiro', x: 5030, until: 221.5, value: bill(5300), cargo: load(), inReach: true, calmIn: null }];
  assert.deepEqual(panel(field({ vehicles: [TRUCK] })).wrecks, []);
  // Nobody picked: what there is there, where from the base, and how to come to work on it.
  const world = field({ vehicles: [TRUCK, TANK], faction: { wrecks } }), seen = panel(world).wrecks[0];
  assert.deepEqual(seen, { id: 'w', x: 5030, name: 'Destroços · Morteiro', salvage: null,
    lines: ['Vale Ferro 5.300', 'A 4.030 m → da base · somem em 2:02', 'Selecione sua construção ao lado deles para desmontá-los.'] });
  // The truck, 30 m from it, picked or in the player's hands: the button. The tank by the base has none.
  const near = panel(world, { picked: ['truck'] }).wrecks[0];
  assert.deepEqual([near.salvage, near.lines], [{ text: 'Desmontar', icon: 'i-repair', title: 'O que resta dos destroços vai para os estoques da facção.', disabled: false },
    ['Vale Ferro 5.300', 'A 4.030 m → da base · somem em 2:02']]);
  assert.equal(panel(field({ vehicles: [TRUCK, TANK], manual: 'truck', faction: { wrecks } })).wrecks[0].salvage.text, 'Desmontar');
  assert.equal(panel(world, { picked: ['tank'] }).wrecks[0].salvage, null);
  // Out of reach for the field there is no button to press, and the card says how to come to it; in combat beside it the
  // button waits, and says for how long.
  const told = patch => panel(field({ vehicles: [TRUCK], faction: { wrecks: [{ ...wrecks[0], ...patch }] } }), { picked: ['truck'] }).wrecks[0];
  assert.deepEqual([told({ inReach: false }).salvage, told({ inReach: false }).lines.at(-1)], [null, 'Para desmontá-los, leve uma construção sua, fora de combate, a menos de 30 m.']);
  // Beside it in the air, or rolling by, it is told to land or to stop: the field gives a wreck to none that does not stand still on the ground.
  const unsettled = quote => panel(field({ vehicles: [{ ...TRUCK, quote: { ...TRUCK.quote, still: false, ...quote } }], faction: { wrecks: [{ ...wrecks[0], inReach: false }] } }),
    { picked: ['truck'] }).wrecks[0];
  assert.deepEqual([unsettled({ aloft: true }).salvage, unsettled({ aloft: true }).lines.at(-1), unsettled({}).lines.at(-1)],
    [null, 'Pouse perto dos destroços para recolhê-los.', 'Pare perto dos destroços para recolhê-los.']);
  assert.deepEqual([told({ inReach: false, calmIn: 7 }).salvage, told({ inReach: false, calmIn: 7 }).lines.at(-1)],
    [{ text: 'Desmontar', icon: 'i-repair', title: 'Em combate: desmonte em 7 s.', disabled: true }, 'Em combate: desmonte em 7 s.']);
  // One already dismantled is only its load: taken up by a vehicle with room for it of its kind — a hopper takes no petroleum.
  const husk = { value: bill(), cargo: load(0, 0, 0, 800) }, tanker = { ...TRUCK, pieces: [piece('truck', 'cistern')] },
    taken = panel(field({ vehicles: [tanker], faction: { wrecks: [{ ...wrecks[0], ...husk }] } }), { picked: ['truck'] }).wrecks[0];
  assert.equal(told(husk).salvage, null);
  assert.deepEqual([taken.salvage.text, taken.lines], ['Recolher a carga', ['Carga Petróleo 800 L', 'A 4.030 m → da base · somem em 2:02']]);
  assert.equal(panel(world, { tab: 'edit', price: bill(100) }).wrecks.length, 1, 'and from the workshop too');
});

test('a finished duel keeps site information but removes collection, salvage and cancellation actions', () => {
  const world = field({ vehicles: [TRUCK], faction: {
    duel: { phase: 'playing', since: 0 },
    wrecks: [{ id: 'w', name: 'Morteiro', x: 5030, until: 221.5, value: bill(5300), cargo: load(), inReach: true, calmIn: null }],
    works: [{ id: 'work', name: 'Posto', x: 5020, cost: bill(4000), delivered: bill(4000), progress: .4, share: 1,
      building: true, waiting: false, supplying: false, blocked: '', from: null, lack: bill() }],
    roadworks: [{ id: 'road', kind: 'asphalt', x0: 5000, x1: 5100, graded: 1, paved: .5, working: [] }],
    posts: [{ id: 'post', x: 5100, takedown: null, siege: null }],
  } }), options = { picked: ['truck'], deposits: GROUND, armed: 'move' }, active = panel(world, options);
  assert(active.veins.some(row => row.collect)); assert(active.wrecks[0].salvage);
  for (const kind of ['works', 'roads', 'posts']) assert(active[kind][0].cancel);
  for (const phase of ['won', 'lost', 'draw']) {
    world.faction.duel = { phase, since: 0, at: 100 };
    const ended = panel(world, options);
    assert.equal(ended.armed, '');
    assert(ended.veins.every(row => !row.collect));
    assert(ended.wrecks.every(row => !row.salvage));
    for (const kind of ['works', 'roads', 'posts']) {
      assert.equal(ended[kind][0].name, active[kind][0].name);
      assert.deepEqual(ended[kind][0].lines, active[kind][0].lines);
      assert.equal(ended[kind][0].cancel, undefined);
    }
  }
});

test('the column is the faction\'s: one another member holds stands in it with their name and is never picked, and the player lets go of what they hold where another member could take it', () => {
  const beto = { id: 'beto', name: 'Beto' }, members = [{ id: 'ana', name: 'Ana', connected: true, role: 'leader' }, { id: 'beto', name: 'Beto', connected: true, role: 'member' }],
    vehicles = [{ ...TANK, order: { reserved: true } }, { ...TRUCK, order: { by: beto } }, { ...TANK, id: 'free', pieces: [gun('free'), rounds('free')] }],
    world = field({ vehicles, faction: { members } }), p = panel(world, { picked: ['tank', 'truck', 'free'] });
  assert.deepEqual(p.squad.units.map(u => [u.id, u.number, u.held, u.selected]), [['tank', 1, '', true], ['free', 2, '', true], ['truck', 3, 'Beto', false]]);
  assert.equal(p.squad.tag, '2 selecionados');
  // Letting go is for what the player holds, and only that.
  const free = p.orders.find(order => order.id === 'free');
  assert.deepEqual([free.ids, free.disabled, Object.keys(p.refused)], [['tank'], false, ['haul', 'tow']]);
  assert.deepEqual(Object.keys(panel(world, { picked: ['free'] }).refused), ['haul', 'free']);
  assert(!panel(world, { picked: ['free'] }).orders.some(order => order.id === 'free'));
  // Alone in the faction there is nobody to let go to: neither offered nor refused.
  const alone = panel(field({ vehicles }), { picked: ['tank'] });
  assert.deepEqual([alone.orders.some(order => order.id === 'free'), 'free' in alone.refused], [false, false]);
  // What another member holds is theirs to hear of.
  assert.deepEqual(p.watch.units.map(u => u.id), ['tank', 'free']);
});

test('a ghost is nobody on the field: not an enemy to attack', () => {
  const others = [{ id: 'foe', ownerId: 'caio', team: 'red', name: 'Tigre', playerName: 'Caio', x: 2400 },
    { id: 'ally', ownerId: 'beto', team: 'green', name: 'Lince', playerName: 'Beto', x: 900 },
    { id: 'seen', ownerId: 'caio', team: 'red', name: 'Urso', playerName: 'Caio', x: 3100, ghost: { since: 40 } },
    { id: 'husk', ownerId: null, team: 'red', name: 'Carcaça', x: 1500, defeated: true }];
  const world = field({ vehicles: [TRUCK], others }), members = fieldOf(world.state).members;
  // One of the faction goes by its own name, whoever's squad it is in; one of another faction by its player's.
  assert.deepEqual(members.map(m => [m.id, m.name, m.foe]), [['truck', 'Caminhão', false], ['foe', 'Caio', true], ['ally', 'Lince', false], ['husk', 'Carcaça', false]]);
  assert.equal(fieldOf(world.state), fieldOf(world.state), 'told once for each frame');
  assert.equal(fieldOf(null), null); assert.equal(fieldOf({ shared: true, squad: null, actors: [], modules: [] }), null, 'nobody is commanded where the player has nothing');
});

test('away from the field there is no situation of it, and a test has no block of the project', () => {
  const trial = fieldPanel({ tab: 'test', state: { actors: [], modules: [], plates: [] } }), bench = fieldPanel({ tab: 'edit' });
  assert.deepEqual([trial.situation, trial.project, trial.squad, trial.weapon], [null, false, null, false]);
  assert.deepEqual([bench.situation, bench.project, bench.publish], [null, true, null]);
  // A frame of the field still on the screen is commanded by nobody once the page has left the field.
  const left = fieldPanel({ tab: 'test', state: field({ vehicles: [TANK] }).state, picked: ['tank'] });
  assert.deepEqual([left.situation, left.squad, left.orders, left.project, left.watch], [null, null, [], false, null]);
});

test('a supply vehicle reports its cargo and requires a known compatible collection site while serving nearby constructions', () => {
  const SUPPLY = { id: 'supply', name: 'Suprimentos', x: 5010, pieces: [piece('supply', 'supply')],
      quote: { supplies: bill(3000, 0, 0, 800), serves: true, fill: { solid: 0, liquid: 0, supplies: .9 } } },
    FAR = { ...TANK, x: 5000, quote: { repair: bill(2013), repairSeconds: 9, rearm: bill(1253, 0, 0, 60) } },
    beside = (point, patch) => {
      const { resupply, ...supply } = { supplier: 'supply', stock: bill(3000, 0, 0, 800), held: '', resupply: bill(1253, 0, 0, 60), ...point };
      return { ...FAR, quote: { ...FAR.quote, ...patch, point: { ...supply, resupply }, mender: supply } };
    };
  // Its gauge names the stocks it carries. Collection stays visible but needs a known compatible supply site; ordinary ore is not one.
  const p = panel(field({ vehicles: [FAR, SUPPLY] }), { picked: ['supply'], deposits: GROUND });
  assert.deepEqual([p.squad.units[1].kind, p.squad.units[1].status], ['supply', 'parado · suprimentos 90%']);
  assert.equal(p.stats.cargo, null); assert.deepEqual([p.stats.supplies.text, p.stats.supplies.title], ['Ferro 3.000 + Combustível 800 L', 'Suprimentos: Ferro 3.000 + Combustível 800 L']);
  // Its supply piece shot to pieces, it serves nobody, as the faction is told: it is no supply vehicle any more.
  const broken = { ...SUPPLY, pieces: [piece('supply', 'supply', { health: 0 })], quote: { ...SUPPLY.quote, serves: false } };
  assert.equal(panel(field({ vehicles: [FAR, broken] })).squad.units[1].kind, 'scout');
  assert.deepEqual([ids(p.orders), collected(p), p.refused.haul], [['move', 'haul', 'tow', 'turn', 'home', 'stop'], [],
    'Nenhum local de coleta compatível conhecido. Explore com um veículo de reconhecimento.']);
  const route = p.orders.find(order => order.id === 'haul');
  assert.deepEqual([route.disabled, route.ids, route.reason], [true, [], p.refused.haul]);
  // Away from its base its supplies are not tipped out: there is nothing to do for it there.
  assert.deepEqual(p.services, []);
  // With a hauler picked beside it the haul is the hauler's, and the veins to send it to are those it carries from.
  const mixed = panel(field({ vehicles: [TRUCK, SUPPLY] }), { picked: ['truck', 'supply'], deposits: GROUND });
  assert.deepEqual([ids(mixed.orders).includes('haul'), mixed.veins.filter(row => row.collect).map(row => [row.id, row.collect.ids])], [true, [['ferro:1', ['truck']]]]);
  // Empty away from its base, it says so in its row, and that is said aloud once; in its base it is being filled.
  const empty = panel(field({ vehicles: [FAR, { ...SUPPLY, quote: { supplies: bill() } }] }), { picked: ['supply'] });
  assert.equal(empty.squad.units[1].status, 'parado · suprimentos vazios'); assert.deepEqual([empty.stats.supplies.text, empty.stats.supplies.title], ['vazios · Combustível 0 L', 'Suprimentos: vazios']); assert.deepEqual(empty.services, []);
  assert.deepEqual(empty.watch.ills.filter(ill => ill.key === 'spent'), [{ ...trouble('supply', 'spent', 'Veículo 2 · Suprimentos: suprimentos esgotados.'), grave: false }]);
  assert.deepEqual(p.watch.ills.filter(ill => ill.key === 'spent'), []);
  assert.deepEqual(panel(field({ vehicles: [{ ...SUPPLY, x: 1010, quote: { supplies: bill(), atBase: true } }] })).watch.ills, []);
  // In its base it is filled up without asking. Dismantled, its supplies go back with it.
  const home = { ...SUPPLY, x: 1010, quote: { ...SUPPLY.quote, atBase: true, load: bill(5000, 0, 0, 2848) } }, there = panel(field({ vehicles: [home] }), { picked: ['supply'] });
  assert.deepEqual([there.services, dismantling(there).back.refund], [[], bill(12000, 0, 0, 800)]);
  // A hauler in its base has no supplies to take on: it has no supply piece.
  const hauler = panel(field({ vehicles: [{ ...TRUCK, x: 1010, quote: { atBase: true } }] }), { picked: ['truck'] });
  assert.deepEqual([hauler.services, dismantling(hauler).back.refund], [[], bill(9000)]);

  // The tank beside the supply vehicle: nothing to press, and nothing to say while it is about to be served.
  const served = panel(field({ vehicles: [beside(), SUPPLY] }), { picked: ['tank'] });
  assert.deepEqual([served.services, served.held, served.advice, acts(served)], [[], '', '', ['copy', 'dismantle', 'abandon']]);
  // Too little aboard for the repair, or no fuel aboard: one line says what the supplies of which vehicle do not pay.
  assert.equal(panel(field({ vehicles: [beside({ stock: bill(1500, 0, 0, 800) }), SUPPLY] }), { picked: ['tank'] }).held, 'Os suprimentos do veículo 2 não pagam o reparo: Ferro 1.500 de 2.013.');
  assert.equal(panel(field({ vehicles: [beside({ stock: bill(3000), resupply: bill() }, { repair: bill(), rearm: bill(0, 0, 0, 60) }), SUPPLY] }), { picked: ['tank'] }).held,
    'Reposição até completar: Os suprimentos do veículo 2 não pagam o combustível: Combustível 0 de 60 L.');
  assert.equal(panel(field({ vehicles: [beside({ held: 'combat' }), SUPPLY] }), { picked: ['tank'] }).held, 'O veículo 2 está em combate: os suprimentos esperam 10 s sem tiros.');
  // What pays for part of the repair mends that part: nothing waits for it, and in the player's hands it is the job.
  const some = (manual = null) => panel(field({ vehicles: [beside({ stock: bill(1500, 0, 0, 800) }, { mend: { cost: bill(1500), seconds: 8 } }), SUPPLY], manual }), { picked: ['tank'] });
  assert.equal(some().held, '');
  assert.deepEqual(some('tank').services.map(job => [job.id, job.text, job.disabled])[0], ['repair', 'Reparar em parte · Ferro 1.500 · 8 s · suprimentos do veículo 2', false]);
  // A supply vehicle another member holds is named by its place in the column, as any of the faction.
  assert.equal(panel(field({ vehicles: [beside({ stock: bill(1500, 0, 0, 800) }), { ...SUPPLY, order: { by: { id: 'beto', name: 'Beto' } } }] }), { picked: ['tank'] }).held,
    'Os suprimentos do veículo 2 não pagam o reparo: Ferro 1.500 de 2.013.');
  // In the player's hands its repair is a job, paid by those supplies; filling it up comes by itself, and nothing of the base's is offered.
  const hand = panel(field({ vehicles: [beside(), SUPPLY], manual: 'tank' }));
  assert.deepEqual(hand.services.map(job => [job.id, job.text, job.disabled]), [['repair', 'Reparar · Ferro 2.013 · 9 s · suprimentos do veículo 2', false]]);
});

test('what is wrong with a vehicle is advised by where it can be put right: here when it is to be asked for, and otherwise how to bring it', () => {
  const advice = (vehicle, options = {}) => panel(field({ vehicles: [vehicle, { ...TRUCK, id: 'second', pieces: [] }], manual: options.manual, faction: options.faction }), { picked: [vehicle.id] }).advice,
    far = { ...TANK, x: 3500, quote: {} }, dry = { fuelStarved: true, fuel: [.2, 0] }, lame = { vehicle: { gearCount: 0 } },
    mender = { supplier: 'second', stock: bill(3000, 0, 0, 800), held: '' }, point = { ...mender, resupply: bill() };
  // Away from every point: the base is so far, and a supply vehicle brings it.
  assert.equal(advice({ ...far, ...dry }), 'Sem combustível: leve até ele um veículo de suprimentos. A base está a 2.500 m ←.');
  assert.equal(advice({ ...far, pieces: [gun('tank'), rounds('tank', 0)] }), 'Sem munição: a base remunicia, a 2.500 m ←, ou um veículo de suprimentos.');
  assert.equal(advice({ ...far, pieces: [gun('tank', { health: 0 }), rounds('tank')] }), 'Arma inutilizada: a base repara, a 2.500 m ←, ou um veículo de suprimentos.');
  assert.equal(advice({ ...far, quote: { repair: bill(2013) } }), 'Avariado 20%: a base repara, a 2.500 m ←, ou um veículo de suprimentos.');
  assert.equal(advice({ ...far, fuel: [9, 3.1] }), 'O combustível mal dá para a volta: a base está a 2.500 m ←.');
  assert.equal(advice(far), '', 'nothing wrong, nothing to say');
  // In the base nothing needs asking: the base puts it right by itself.
  const home = { ...TANK, quote: { atBase: true } };
  assert.equal(advice({ ...home, ...dry }), ''); assert.equal(advice({ ...home, pieces: [gun('tank'), rounds('tank', 0)] }), '');
  assert.equal(advice({ ...home, pieces: [gun('tank', { health: 0 }), rounds('tank')] }), '');
  // The repair of the vehicle in hand is asked for.
  assert.equal(advice({ ...home, pieces: [gun('tank', { health: 0 }), rounds('tank')] }, { manual: 'tank' }), '');
  // Beside a supply vehicle it is put right there, from its supplies.
  const beside = { ...far, quote: { point, mender } };
  assert.equal(advice({ ...beside, ...dry }), '');
  assert.equal(advice({ ...beside, pieces: [gun('tank', { health: 0 }), rounds('tank')] }, { manual: 'tank' }), 'Arma inutilizada: repare aqui, com os suprimentos do veículo 2.');
  // A supply vehicle that carries fuel is its own point for that: dry, it fuels itself and nothing has to be brought. For the rest, and with
  // no fuel aboard, it is as far from service as any other, and what is brought to it is another supply vehicle.
  const tanker = { ...far, quote: { supplies: bill(0, 0, 0, 800), point: { supplier: 'tank', stock: bill(0, 0, 0, 800), held: '', resupply: bill(0, 0, 0, 197) } } };
  assert.equal(advice({ ...tanker, ...dry }), '');
  assert.equal(advice({ ...far, ...dry, quote: { supplies: bill() } }), 'Sem combustível: leve até ele outro veículo de suprimentos. A base está a 2.500 m ←.');
  assert.equal(advice({ ...tanker, quote: { ...tanker.quote, repair: bill(2013) } }), 'Avariado 20%: a base repara, a 2.500 m ←, ou outro veículo de suprimentos.');
  assert.equal(advice({ ...tanker, quote: { ...tanker.quote, repair: bill(2013) } }, { manual: 'tank' }), 'Avariado 20%: a base repara, a 2.500 m ←, ou outro veículo de suprimentos.',
    'its own fuel mends nothing: there is no repair to ask for here');
  assert.equal(advice({ ...tanker, quote: { ...tanker.quote, mender }, pieces: [gun('tank', { health: 0 }), rounds('tank')] }, { manual: 'tank' }),
    'Arma inutilizada: repare aqui, com os suprimentos do veículo 2.', 'another supply vehicle beside it mends it');
  // The last construction of a faction that cannot pay for an ore lorry has nobody to bring it anything: stopped for good away from its base, it is told so.
  const recovery = { base: null, lorry: bill(28022, 0, 995, 203), reserve: 203, aid: bill(22812, 0, 995, 406), offered: false },
    lone = (vehicle, faction = {}, change = () => {}) => { const world = field({ vehicles: [vehicle], faction: { recovery, ...faction } }); change(world.state.actors[0].vehicle); return panel(world, { picked: [vehicle.id] }).advice; },
    truth = ' e a facção não tem outra construção nem estoque para um caminhão de minério. Abandone esta: sem nada no campo, a facção pode pedir auxílio.';
  assert.equal(lone({ ...far, ...dry }), 'Sem combustível,' + truth);
  assert.equal(lone(far, {}, vehicle => { vehicle.gearCount = 0; }), 'Não anda mais (rodagem destruída),' + truth);
  assert.equal(lone(far, {}, vehicle => { vehicle.engine = false; }), 'Não anda mais (motor destruído),' + truth);
  // With another construction of the faction on the field, or stock for a lorry, something can be brought.
  assert.equal(lone({ ...far, ...dry }, { count: 2 }), 'Sem combustível: leve até ele um veículo de suprimentos. A base está a 2.500 m ←.');
  assert.equal(lone({ ...far, ...dry }, { recovery: null }), 'Sem combustível: leve até ele um veículo de suprimentos. A base está a 2.500 m ←.');
  // In its base the base serves it, and what can still take it home is not lost.
  assert.equal(lone({ ...home, ...dry }), '');
  assert.equal(lone({ ...far, fuel: [9, 3.1] }), 'O combustível mal dá para a volta: a base está a 2.500 m ←.');
  assert.equal(lone({ ...tanker, ...dry }), '');
});

test('a gun whose boxes are of another calibre, or that has none, says so, and that only a new project puts it right', () => {
  // The casamata of the field: a 12,7 mm gun over a full box of 5,56 mm, which the field keeps full and no gun fires.
  const casamata = (pieces, { structure = true, home = false } = {}) => {
      const world = field({ vehicles: [{ ...TANK, x: home ? 1010 : 3500, quote: { atBase: home }, pieces }] });
      if (structure) { world.state.actors[0].vehicle = null; world.faction.units[0].vehicle = false; }
      return panel(world, { picked: ['tank'] });
    },
    m2 = gun('tank', { weaponPreset: 'm2hb' }), belt = (preset, count) => piece('tank', 'ammo', { id: 'tank:' + preset, ammoPreset: preset, rounds: count }),
    misfed = casamata([m2, belt('minimi', 1270)]), status = shown => shown.squad.units[0].status;
  assert.match(status(misfed), /^munição de outro calibre/);
  assert.equal(misfed.advice, 'Munição de outro calibre: nenhuma arma usa a das caixas. Em Editar cópia, troque o calibre da caixa, desmonte esta e abra a obra nova.');
  assert.deepEqual([misfed.stats.rounds.text, misfed.stats.rounds.low], ['outro calibre', true]);
  assert.match(misfed.stats.rounds.title, /outro calibre/);
  // Not even at its base is it rearmed with what it fires; a vehicle is replaced by the copy put right.
  assert.equal(casamata([m2, belt('minimi', 1270)], { home: true }).advice, misfed.advice);
  assert.equal(casamata([m2, belt('minimi', 1270)], { structure: false }).advice,
    'Munição de outro calibre: nenhuma arma usa a das caixas. Em Editar cópia, troque o calibre da caixa e substitua o veículo.');
  const boxless = casamata([m2]);
  assert.match(status(boxless), /^sem caixa de munição/);
  assert.equal(boxless.advice, 'Sem caixa de munição: em Editar cópia, ponha uma do calibre da arma, desmonte esta e abra a obra nova.');
  assert.equal(boxless.stats.rounds.text, '0');
  // A box of its calibre run dry is rearmed, as ever, beside one of another calibre; and a gun with rounds says nothing.
  const dry = casamata([m2, belt('m2hb', 0), belt('minimi', 1270)]);
  assert.match(status(dry), /^sem munição/); assert.match(dry.advice, /^Sem munição: a base remunicia/);
  assert.equal(casamata([m2, belt('m2hb', 400), belt('minimi', 1270)]).advice, '');
  assert.equal(casamata([m2, belt('m2hb', 400), belt('minimi', 1270)]).stats.rounds.text, '400');
});

test('a vehicle the ground holds says so in its row, is told of once, and is advised to weigh less or to go another way', () => {
  // Its core keeps reporting a stall with no progress; once its driver gave up, the order that ended for it does.
  const world = (vehicle, stuck, manual = null) => { const made = field({ vehicles: [vehicle, { ...TRUCK, id: 'second', pieces: [] }], manual });
      Object.assign(made.state.actors[0].vehicle, { stuck, throttle: 1, brake: 0 }); return made; },
    look = (vehicle, stuck, manual) => { const mobility = {}, made = world(vehicle, stuck, manual); let p;
      for (let time = 100; time <= 102; time += .5) { made.state.time = time; p = panel(made, { picked: [vehicle.id], mobility }); } return p; }, row = p => p.squad.units[0],
    full = { ...TRUCK, quote: { cargo: load(0, 0, 17695), fill: { solid: 1, liquid: 0 } }, order: { move: { x: 5100 } } }, bare = { ...TRUCK, quote: {}, order: { move: { x: 5100 } } };
  // Too heavy for soft ground: it is not on its way anywhere, its row is marked, and what it carries is what to be rid of.
  const bogged = look(full, 'ground');
  assert.match(row(bogged).status, /^atolado · /); assert.doesNotMatch(row(bogged).status, /em movimento/); assert.equal(row(bogged).trouble, true);
  assert.equal(bogged.advice, 'Atolado: pesado demais para este chão. Despeje parte da carga para sair.');
  assert(bogged.services.some(job => job.id === DUMP.id), 'and the job that does it is there');
  assert.equal(look(bare, 'ground').advice, 'Atolado: pesado demais para este chão. Tente sair no outro sentido.');
  // On ground that gives no grip, and on a climb beyond its pull.
  assert.deepEqual([row(look(bare, 'grip')).status, look(bare, 'grip').advice], ['patinando', 'Patinando: este chão não dá aderência para ele seguir. Recue e tente outro caminho.']);
  assert.deepEqual([row(look(bare, 'slope')).status, look(bare, 'slope').advice], ['sem força para a subida', 'Sem força para esta subida: recue e contorne.']);
  assert.equal(look(full, 'slope').advice, 'Sem força para esta subida com a carga que leva: despeje parte dela ou contorne.');
  // In the player's hands the row says it too.
  assert.equal(row(look(bare, 'ground', 'truck')).status, 'atolado');
  // Held by nothing, it says nothing of it; with no fuel or no running gear, that is what is wrong with it.
  assert.deepEqual([row(look(bare)).status, look(bare).advice, row(look(bare)).trouble], ['em movimento · faltam 100 m', '', false]);
  assert.doesNotMatch(row(look({ ...bare, fuelStarved: true, fuel: [.2, 0] }, 'ground')).status, /atolado/);
  // The driver that gave up says why until another order is given: the core says nothing of a vehicle that no longer pushes.
  const gaveUp = look({ ...full, order: { reason: 'stuck-ground' } });
  assert.match(row(gaveUp).status, /^atolado · /); assert.equal(gaveUp.advice, 'Atolado: pesado demais para este chão. Despeje parte da carga para sair.');
  assert.equal(row(look({ ...bare, order: { reason: 'stuck-slope' } })).status, 'sem força para a subida');
  // It is said once as it comes about, and again only when it is another thing that holds it.
  const memo = {}, mobility = {}, said = (stuck, time) => { const made = world(bare, stuck); made.state.time = time;
    return fieldNotices(memo, panel(made, { mobility }).watch, time); };
  assert.deepEqual(said(null, 0), []); assert.deepEqual(said('ground', 1), []); assert.deepEqual(said('ground', 2), []);
  assert.deepEqual(said('ground', 3), ['Veículo 1 · Caminhão: atolou — pesado demais para este chão.']); assert.equal(memo.grave, true);
  assert.deepEqual(said('ground', 4), []); assert.deepEqual(said(null, 5), []);
  for (const time of [6, 7, 8]) assert.deepEqual(said('ground', time), [], 'the same trouble is not said over and over');
  assert.deepEqual(said('grip', 9), []); assert.deepEqual(said('grip', 10), []);
  assert.deepEqual(said('grip', 11), ['Veículo 1 · Caminhão: patina — o chão não dá aderência para ele seguir.']);
});

test('brief native launch stalls and slipping with real progress do not claim the vehicle cannot proceed', () => {
  for (const manual of [null, 'truck']) {
    const mobility = {}, notices = {}, look = (time, stuck, x = 5000) => {
      const made = field({ vehicles: [{ ...TRUCK, x, quote: {}, order: { move: { x: 5100 } } }], manual, time });
      Object.assign(made.state.actors[0].vehicle, { stuck, slip: 100, throttle: 1, brake: 0 });
      const p = panel(made, { mobility, picked: ['truck'] });
      assert.deepEqual(fieldNotices(notices, p.watch, time), []);
      assert.equal(p.squad.units[0].trouble, false); assert.equal(p.advice, '');
      assert.doesNotMatch(p.squad.units[0].status, /patinando|atolado|sem força/); return p;
    };
    look(0, null); look(.1, 'grip'); look(.2, null); look(.3, 'ground'); look(.4, null);
    // Even a continuing native reason is not immobilization while it advances in either direction.
    for (const direction of [1, -1]) for (let tick = 1; tick <= 10; tick++) look(.4 + (direction === 1 ? 0 : 5) + tick / 2, 'grip', 5000 + direction * tick);
  }
});

test('stall confirmation forgets released controls, progress, missing vehicles and gaps in observed frame time', () => {
  const mobility = {}, look = (time, { x = 5000, throttle = 1, brake = 0, factionId = 'green', revision = 0, vehicles = true, connected = true } = {}) => {
    const made = field({ vehicles: vehicles ? [{ ...TRUCK, x, quote: {} }] : [], time, faction: { id: factionId } });
    if (vehicles) { made.state.actors[0].revision = revision; Object.assign(made.state.actors[0].vehicle, { stuck: 'ground', throttle, brake }); }
    return panel(made, { mobility, connected }).squad?.units[0].trouble;
  }, confirm = start => { look(start, { throttle: 0 }); assert.equal(look(start), false); assert.equal(look(start + 1), false); assert.equal(look(start + 2), true); };
  confirm(0);
  assert.equal(look(2.1, { x: 5001 }), false, 'half a metre of movement clears the old conclusion');
  assert.equal(look(2.2, { throttle: 0 }), false); assert.equal(mobility.pending.size, 0);
  confirm(3); assert.equal(look(5.1, { brake: 1 }), false); assert.equal(mobility.pending.size, 0);
  confirm(6); assert.equal(look(10), false, 'an unobserved gap is not two seconds of measured standstill');
  confirm(11); assert.equal(look(1), false, 'a restarted simulation cannot keep an old timer');
  confirm(2); assert.equal(look(4.1, { factionId: 'new' }), false);
  confirm(5); look(7.1, { vehicles: false }); assert.equal(mobility.pending.size, 0);
  confirm(8); look(10.1, { connected: false }); assert.equal(mobility.pending.size, 0);
  confirm(11); assert.equal(look(13.1, { revision: 1 }), false, 'a replacement with the same actor ID has its own launch');
});

test('a tool at work says the share of its pace it works at, or why it stops: no engine, or no fuel', () => {
  const row = (quote, patch = {}) => panel(field({ vehicles: [{ ...TRUCK, ...patch, quote: { ...TRUCK.quote, ...quote } }] })).squad.units[0],
    at = (quote, patch) => row(quote, patch).status;
  assert.doesNotMatch(at({}), /ferramenta|capacidade/, 'a tool that does nothing says nothing');
  assert.match(at({ tools: { limit: 'engine' } }), /ferramenta sem motor/);
  assert.match(at({ tools: { limit: 'fuel' } }), /ferramenta sem combustível/);
  // At work it says so after what it does, and that is no trouble of the vehicle's: all of its pace, or what its engine gives.
  const digging = { extracting: 'ferro:1', loading: null, cargo: load(), fill: { solid: 0, liquid: 0 } };
  assert.equal(at({ ...digging, tools: { pace: 1 } }), 'extraindo na jazida · 100 % da capacidade');
  assert.equal(at({ ...digging, tools: { limit: 'power', pace: .5 } }), 'extraindo na jazida · 50 % da capacidade, limitado pelo motor');
  assert.equal(at({ ...digging, tools: { limit: 'power', pace: 1 } }), 'extraindo na jazida · 99 % da capacidade, limitado pelo motor',
    'held under its pace, it never says all of it');
  assert.equal(row({ ...digging, tools: { limit: 'power', pace: .5 } }).trouble, false);
  assert.equal(row({ ...digging, tools: { limit: 'engine' } }).trouble, true);
  assert.match(at({ tools: { limit: 'power', pace: .75 } }), /75 % da capacidade, limitado pelo motor/);
  // In the player's hands it says it too.
  const held = panel(field({ vehicles: [{ ...TRUCK, quote: { ...TRUCK.quote, ...digging, tools: { limit: 'power', pace: .5 } } }], manual: 'truck' })).squad.units[0];
  assert.equal(held.status, 'sob seu controle · 50 % da capacidade, limitado pelo motor');
  // A vehicle out of fuel says so once: its tool adds nothing to it.
  const dry = at({ tools: { limit: 'fuel' } }, { fuelStarved: true, fuel: [.2, 0] });
  assert.match(dry, /sem combustível/); assert.doesNotMatch(dry, /ferramenta/);
  // A structure tells what its tank holds, and no range: it goes nowhere. Dry, its drill stops, and it says so. The page
  // is told what the tank takes and what it lacks to fill it, not what each tank holds.
  const well = litres => {
    const made = field({ vehicles: [{ id: 'well', name: 'Poço', x: 5000, pieces: [piece('well', 'drill'), piece('well', 'fuel', { capacityLitres: 200 })],
      quote: { vehicle: false, rearm: { ferro: 0, ligas: 0, silica: 0, combustivel: 200 - litres },
        extracting: litres > 0 ? 'petroleo:4' : null, tools: litres > 0 ? null : { limit: 'fuel' } } }] });
    delete made.state.actors[0].vehicle;
    return panel(made, { picked: ['well'] });
  };
  assert.deepEqual(well(50).stats.fuel, { share: .25, low: false, text: '50 L', title: 'Combustível 50 L de 200 L' });
  assert.deepEqual(well(0).stats.fuel, { share: 0, low: true, text: 'sem combustível', title: 'Combustível 0 L de 200 L' });
  assert.match(well(0).squad.units[0].status, /ferramenta sem combustível/);
});

test('a road machine whose blade or screed does not reach the ground says so, stands where it is, and its player is told', () => {
  for (const [tool, words] of [['blade', 'a lâmina não alcança o chão'], ['paver', 'a mesa não alcança o chão']]) {
    const made = panel(field({ vehicles: [{ ...TRUCK, quote: { ...TRUCK.quote, tools: { limit: 'ground', tool } } }] })), unit = made.squad.units[0];
    assert.match(unit.status, new RegExp('^' + words)); assert.equal(unit.trouble, true, `${tool}: it needs the player`);
    const ill = made.watch.ills.find(ill => ill.key === 'reachless');
    assert.equal(ill?.words, words); assert.match(ill.text, new RegExp(`: ${words}\\.$`));
  }
});

test('fuel and destroyed mobility remain immediate, and a pilot-confirmed stall needs no new observation delay', () => {
  for (const [vehicle, expected] of [[{ fuelStarved: true }, /sem combustível/], [{ engine: false }, /motor destruído/], [{ gearCount: 0 }, /rodagem destruída/]]) {
    const made = field({ vehicles: [{ ...TRUCK, quote: {} }], time: 0 });
    Object.assign(made.state.actors[0].vehicle, { stuck: 'grip', throttle: 1, ...vehicle });
    const p = panel(made, { mobility: {}, picked: ['truck'] });
    assert.match(p.squad.units[0].status, expected); assert.equal(p.squad.units[0].trouble, true);
    assert.doesNotMatch(p.squad.units[0].status, /patinando/);
  }
  const made = field({ vehicles: [{ ...TRUCK, order: { reason: 'stuck-slope' } }], time: 0 });
  assert.match(panel(made, { mobility: {} }).squad.units[0].status, /sem força para a subida/);
});

test('the guns the base placed by their fire are watched: where each is from the base, how far off that may be and which sense has it', () => {
  const world = field({ vehicles: [TANK] }), quiet = panel(field({ vehicles: [TANK] })).watch;
  world.state.contacts = [{ id: 'foe', kind: 'battery', x: 7100, error: 92, at: 99, by: 'radar' }, { id: 'blip', kind: 'radar', x: 1500, y: 3, error: 4, at: 99 },
    { id: 'ears', kind: 'battery', x: 420, error: 60, at: 98, by: 'sound' }];
  assert.deepEqual(quiet.batteries, []);
  assert.deepEqual(panel(world).watch.batteries, [{ id: 'foe', by: 'radar', x: 7100, approximate: true, text: 'a 6,1 km → da base (±92 m)' },
    { id: 'ears', by: 'sound', x: 420, approximate: true, text: 'a 580 m ← da base (±60 m)' }]);
  const memo = {}; assert.deepEqual(fieldNotices(memo, quiet, 0), []);
  assert.deepEqual([fieldNotices(memo, panel(world).watch, 1), memo.spotted, memo.grave],
    [['Fogo inimigo localizado: a 6,1 km → da base (±92 m), a 580 m ← da base (±60 m).'], true, false]);
  assert.equal(memo.place, 7100, 'where the notice takes whoever presses it');
  // A vehicle that answers that fire on its own says so in its row, with where it fires.
  const answering = field({ vehicles: [{ ...TANK, order: { stance: 'fire', counter: { x: 7100 }, reason: 'bombarding', activity: 'firing' } }] });
  const row = panel(answering).squad.units[0].status.split(' · ');
  assert.equal(row[0], 'contrafogo a 6,1 km →'); assert(row.includes('bombardeando o ponto'), row.join(' · '));
  assert(!panel(field({ vehicles: [TANK] })).squad.units[0].status.includes('contrafogo'));
});

test('a mixed frame keeps the severity and location of each history item separate', () => {
  const mending = { ...TANK, quote: { atBase: true, service: { kind: 'repair', until: 100 } } },
    before = panel(field({ vehicles: [TRUCK, mending] })).watch, memo = {};
  assert.deepEqual(fieldNotices(memo, before, 0), []); assert.deepEqual(memo.items, []);
  const world = field({ vehicles: [{ ...TRUCK, fuelStarved: true, fuel: [0, 0] }, { ...TANK, quote: { atBase: true } }] });
  world.state.contacts = [{ id: 'battery', kind: 'battery', x: 7100, error: 92, at: 100, by: 'radar' }];
  const watch = panel(world).watch, said = fieldNotices(memo, watch, 1);
  assert.deepEqual(memo.items, [
    { text: 'Veículo 2 · Caminhão: sem combustível a 4.000 m da base.', grave: true, place: null },
    { text: 'Veículo 1 · Blindado: reparo concluído.', grave: false, place: null },
    { text: 'Fogo inimigo localizado a 6,1 km → da base (±92 m), pelo radar da base.', grave: false, place: 7100,
      encounter: { id: 'contact:battery:battery', x: 7100, approximate: true } },
  ]);
  assert.deepEqual(said, memo.items.map(item => item.text), 'the existing string-array contract stays compatible');
  assert.equal(memo.grave, true); assert.equal(memo.place, 7100); assert.equal(memo.spotted, true);
  assert.deepEqual(fieldNotices(memo, watch, 2), []); assert.deepEqual(memo.items, [], 'quiet frames never replay stale history entries');
  fieldNotices(memo, { ...watch, partial: true }, 3); assert.deepEqual(memo.items, []);
});

test('notice suppression releases expired encounter keys instead of keeping session-long history', () => {
  const quiet = panel(field({ vehicles: [TANK] })).watch, memo = {};
  fieldNotices(memo, quiet, 0);
  for (let i = 1; i <= 200; i++) {
    const watch = { ...quiet, contacts: [{ id: 'tank', event: 'encounter-' + i, text: 'Contato ' + i }] };
    assert.deepEqual(fieldNotices(memo, watch, i), ['Contato ' + i]);
    assert(memo.told.size <= 30, 'only entries inside the existing suppression window remain');
  }
  assert(memo.told.size > 0);
  assert.deepEqual(fieldNotices(memo, quiet, 1000), []); assert.equal(memo.told.size, 0);
  const contact = { ...quiet, contacts: [{ id: 'tank', event: 'later', text: 'Novo contato' }] };
  assert.deepEqual(fieldNotices(memo, contact, 1001), ['Novo contato']);
  fieldNotices(memo, quiet, 1002);
  assert.deepEqual(fieldNotices(memo, contact, 1003), [], 'suppression still works within the existing window');
});

test('sound encounters point near the listener, including zero, without locating an unseen enemy', () => {
  const listener = { ...TRUCK, x: 0, quote: {} }, memo = {};
  fieldNotices(memo, panel(field({ vehicles: [listener] })).watch, 0);
  const world = field({ vehicles: [{ ...listener, order: { heard: { event: 'own-listener:10', channel: 'sound', side: 1 } } }],
    others: [{ id: 'hidden-enemy', ghost: true, team: 'other', x: 900000 }] }), watch = panel(world).watch;
  fieldNotices(memo, watch, 1);
  assert.deepEqual(memo.items[0].encounter, { id: 'contact:own-listener:10', x: 0, approximate: true });
  assert.equal(memo.items[0].place, 0);
  assert.equal(JSON.stringify(memo.items).includes('900000'), false);
  assert.equal(JSON.stringify(memo.items).includes('hidden-enemy'), false);
  assert.equal(watch.contacts[0].x, 0);
});

test('a placed contact at zero stays exact and actionable', () => {
  const memo = {}, quiet = panel(field({ vehicles: [TRUCK] })).watch;
  fieldNotices(memo, quiet, 0);
  const watch = panel(field({ vehicles: [{ ...TRUCK, order: { heard: { event: 'radar:1', channel: 'radar', x: 0 } } }] })).watch;
  assert.equal(fieldNotices(memo, watch, 1).length, 1);
  assert.deepEqual(memo.items[0].encounter, { id: 'contact:radar:1', x: 0, approximate: false });
  assert.equal(memo.items[0].place, 0); assert.equal(memo.items[0].grave, false);
});

test('a contact and a grouped retreat share one encounter location; an unplaced retreat uses its worker', () => {
  for (const heard of [{ event: 'worker:10', channel: 'visual', x: 6400 }, { event: 'worker:10', channel: 'sound', side: -1 }, null]) {
    const first = { ...TRUCK, id: 'first', x: 5000 }, second = { ...TRUCK, id: 'second', x: 5100 }, memo = {};
    fieldNotices(memo, panel(field({ vehicles: [first, second] })).watch, 0);
    const fleeing = vehicle => ({ ...vehicle, order: { haul: { depositId: 'ferro:1', phase: 'home', fled: true, threat: 'worker:10' },
      ...(vehicle.id === 'first' && heard ? { heard } : {}) } }),
      watch = panel(field({ vehicles: [fleeing(first), fleeing(second)] })).watch;
    assert.equal(fieldNotices(memo, watch, 1).length, 1, 'contact and both retreating workers produce one marker');
    const x = heard?.channel === 'visual' ? 6400 : 5000;
    assert.deepEqual(memo.items[0].encounter, { id: 'contact:worker:10', x, approximate: heard?.channel !== 'visual' });
    assert.equal(memo.items[0].place, x); assert.equal(memo.items[0].grave, true);
    assert.deepEqual(fieldNotices(memo, watch, 2), []);
  }
});

test('located batteries expose their published location and uncertainty, including an exact zero', () => {
  for (const [x, error] of [[0, 0], [7100, 92]]) {
    const memo = {}, world = field({ vehicles: [TANK] });
    fieldNotices(memo, panel(field({ vehicles: [TANK] })).watch, 0);
    world.state.contacts = [{ id: 'opaque-battery', kind: 'battery', x, error, by: 'radar' }];
    assert.equal(fieldNotices(memo, panel(world).watch, 1).length, 1);
    assert.deepEqual(memo.items[0].encounter, { id: 'contact:battery:opaque-battery', x, approximate: error > 0 });
    assert.equal(memo.items[0].place, x); assert.equal(memo.items[0].grave, false);
  }
});

test('missing and invalid encounter coordinates never produce a marker or an invalid place', () => {
  for (const x of [undefined, null, NaN, Infinity, -Infinity]) {
    const memo = {}, quiet = panel(field({ vehicles: [TRUCK] })).watch;
    fieldNotices(memo, quiet, 0);
    const watch = panel(field({ vehicles: [{ ...TRUCK, x, quote: {}, order: { heard: { event: 'unplaced', channel: 'sound', side: 1 } } }] })).watch;
    assert.equal(fieldNotices(memo, watch, 1).length, 1, 'the encounter is still announced without inventing a location');
    assert.equal(memo.items[0].place, null); assert.equal('encounter' in memo.items[0], false);
    const next = { ...watch, contacts: [], batteries: [{ id: 'invalid-battery', by: 'radar', x, text: 'posição indisponível' }] };
    fieldNotices(memo, next, 2);
    assert.equal(memo.items[0].place, null); assert.equal('encounter' in memo.items[0], false);
    assert.equal(memo.place, null);
  }
});
