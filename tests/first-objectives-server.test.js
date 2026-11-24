import { nativePhotoOnly } from './helpers/runtime.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SharedRoom, rehearsal, asked } from '../server/room.ts';
import { FieldHost, replayField } from '../server/field-host.ts';
import { writeField, readField } from '../server/field-snapshot.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { depositsNear } from '../src/deposits.ts';
import { BASE_RADIUS, LOAD_REACH, STOCK_IDS, SUPPLIED, bill, billSum, load, carriedBy, supplied, stow, designBill } from '../src/economy.ts';
import { onField } from './helpers/field.js';
import { constructionSite, constructionSpan, structureBill } from '../server/field-construction.ts';
import { MODULES } from '../src/materials.ts';
import { cellOf } from '../src/grid.ts';

const CORE_KEYS = ['selectMiner', 'collectOre', 'deliverOre', 'directControl', 'fabricateVehicle'], KEYS = [...CORE_KEYS, 'buildDefense'],
  flags = (...done) => Object.fromEntries(KEYS.map(id => [id, done.includes(id)])),
  written = room => JSON.parse(JSON.stringify(room.keep())),
  completed = (room, player) => room.factionView(player.playerId).objectives.completed;

function setup(t, { material = 'ferro', build = true, starter = true } = {}) {
  let base;
  const room = new SharedRoom({ build, starter, fog: false, stock: bill(1e7, 1e7, 1e7, 1e7), base: i => base + i * 10000 }),
    f = onField(t, room), site = room.deposits.filter(site => site.material === material &&
      depositsNear(room.deposits, site.x, 2 * LOAD_REACH).length === 1 &&
      depositsNear(room.deposits, site.x + 250, BASE_RADIUS + LOAD_REACH).length === 0)
      .sort((a, b) => Math.abs(a.x) - Math.abs(b.x))[0];
  assert(site); base = site.x + 250;
  const player = room.join('Aprendiz'), miner = player.actors[0]?.id, scout = player.actors[1]?.id;
  return { ...f, site, player, miner, scout, base,
    progress: (who = player) => completed(room, who),
    select: (id, who = player) => f.send(who, 'objectives', { action: 'select', ids: [id] }),
    cargo: id => carriedBy(room.pieces(id)).carried[material],
    collect: (id = miner, who = player) => f.order(who, 'haul', { ids: [id], depositId: site.id }) };
}

for (const outOfOrder of [false, true])
  test(`the five objectives follow actual individual results ${outOfOrder ? 'outside the suggested order' : 'in the suggested order'}`, { timeout: 60000 }, t => {
    const f = setup(t), { room, player, miner, scout } = f;
    assert.equal(player.selected, null, 'entering leaves selection to the player');
    assert.deepEqual(f.progress(), flags(), 'starter vehicles count for nothing');
    const fabricate = () => {
      const result = f.send(player, 'spawn', { blueprint: createStructuredTemplate('scout') });
      assert.equal(f.progress().fabricateVehicle, false, 'requesting and paying is not completion');
      assert(f.until(() => !room.record(room.world.actor(result.actor.id)).service, result.seconds + 2));
      assert.equal(f.progress().fabricateVehicle, true);
    };
    const control = () => {
      f.order(player, 'control', { id: scout });
      assert.equal(f.progress().directControl, false, 'taking over is only half of the exercise');
      f.order(player, 'control', { id: null });
      assert.equal(f.progress().directControl, true);
    };
    if (outOfOrder) { fabricate(); control(); }
    else { f.select(miner); assert.equal(f.progress().selectMiner, true); }
    f.collect();
    assert.equal(f.progress().collectOre, false, 'an accepted transport order moves no material by itself');
    assert(f.until(() => f.progress().collectOre, 90), 'the real starter drives to the site and loads ore');
    assert(f.cargo(miner) > 0); assert.equal(f.progress().deliverOre, false);
    const faction = room.faction(room.players.get(player.playerId)), before = faction.stock.ferro + faction.yard.ferro;
    assert(f.until(() => f.progress().deliverOre, 420), 'the same automatic order brings actual cargo home');
    assert.equal(f.cargo(miner), 0); assert(faction.stock.ferro + faction.yard.ferro > before);
    f.order(player, 'stop', { ids: [miner] });
    if (outOfOrder) { assert.equal(f.progress().selectMiner, false); f.select(miner); }
    else { control(); fabricate(); }
    assert.deepEqual(f.progress(), flags(...CORE_KEYS));
    for (const actor of room.owned(player.playerId)) room.discard(actor.id);
    assert.deepEqual(f.progress(), flags(...CORE_KEYS), 'losing every vehicle erases no conclusion');
    assert.equal(room.faults.size, 0);
  });

test('selection validates the player, real equipment, availability and the requested action', t => {
  const f = setup(t), { room, player, miner, scout } = f, ally = room.join('Aliado'), otherMiner = ally.actors[0].id;
  f.select(scout); f.select(otherMiner); f.select('missing');
  assert.deepEqual(f.progress(), flags());
  assert.throws(() => f.send(player, 'objectives', { action: 'complete', ids: [miner], completed: flags(...KEYS) }), /Seleção/);
  const tool = f.parts(miner, 'excavator')[0]; f.set(tool, { health: 0 });
  f.select(miner); assert.equal(f.progress().selectMiner, false, 'a destroyed tool is no functioning miner');
  f.set(tool, { health: tool.maxHealth });
  room.record(room.world.actor(miner)).service = { kind: 'turn', until: 10 };
  f.select(miner); assert.equal(f.progress().selectMiner, false, 'a held vehicle is not available');
  room.record(room.world.actor(miner)).service = null;
  f.select(miner); assert.equal(f.progress().selectMiner, true);
  assert.deepEqual(f.progress(ally), flags(), 'one player selecting a vehicle does not credit its ally');
  assert.deepEqual(asked({ type: 'objectives', action: 'select', ids: [miner], completed: flags(...KEYS), token: 'private' }),
    { type: 'objectives', action: 'select', ids: [miner] });
});

test('a refused order, a bare deposit, petroleum and generic faction stock changes conclude no ore objective', { timeout: 60000 }, t => {
  const f = setup(t), { room, player, miner } = f;
  assert.throws(() => f.order(player, 'haul', { ids: [miner], depositId: 'missing' }));
  room.veins.set(f.site.id, 0); room.extracted.delete(f.site.id);
  f.put(miner, f.site.x); f.run(1);
  assert.equal(f.cargo(miner), 0); assert.deepEqual(f.progress(), flags());
  const faction = room.faction(room.players.get(player.playerId));
  faction.stock.ferro += 1000; faction.yard.ferro += 1000; f.run(.5);
  assert.deepEqual(f.progress(), flags(), 'shared stocks are not delivery evidence');
  const petroleum = setup(t, { material: 'petroleo', build: false }), source = createStructuredTemplate('mining-truck'),
    design = { ...source, components: source.components.map(piece => piece.kind === 'hopper' ? { ...piece, id: 'cistern', kind: 'cistern' }
      : piece.kind === 'excavator' ? { ...piece, id: 'drill', kind: 'drill',
        pose: { ...piece.pose, y: piece.pose.y + cellOf((MODULES.drill.height - MODULES.excavator.height) * piece.sizeScale / 2) } } : piece) };
  petroleum.send(petroleum.player, 'replace', { actorId: petroleum.miner, blueprint: design });
  petroleum.send(petroleum.player, 'auto', { actorId: petroleum.miner, on: false });
  petroleum.put(petroleum.miner, petroleum.site.x); petroleum.run(2);
  assert(petroleum.cargo(petroleum.miner) > 0);
  petroleum.put(petroleum.miner, petroleum.base); petroleum.run(1);
  assert.deepEqual(petroleum.progress(), flags(), 'petroleum is not solid ore; replacement is not a fabricated new vehicle');
});

test('partial ore pickup and real unload persist per player and exclude dismantling, arbitrary cargo and allies', { timeout: 60000 }, t => {
  const f = setup(t, { build: false }), { room, player, miner } = f, ally = room.join('Aliado'),
    allyOwner = room.players.get(ally.playerId), owner = room.players.get(player.playerId);
  f.send(player, 'invite', { playerId: ally.playerId }); f.send(ally, 'join-faction', { factionId: owner.factionId });
  const other = f.publish(ally, 'truck');
  f.send(ally, 'auto', { actorId: other, on: false });
  f.send(player, 'auto', { actorId: miner, on: false });
  f.put(other, f.site.x); room.veins.set(f.site.id, 0); room.extracted.set(f.site.id, .125); f.run(.5);
  assert.equal(f.progress(ally).collectOre, true, 'a positive fraction counts without snapshot rounding');
  assert.deepEqual(f.progress(), flags(), 'an ally picking up ore contributes only to its own objectives');
  f.put(other, f.base); assert.equal(f.progress(ally).deliverOre, true); assert.deepEqual(f.progress(), flags());
  assert.equal(allyOwner.factionId, owner.factionId);

  // Cargo placed aboard by another cause is deliberately not evidence of deposit collection.
  f.set(f.parts(miner, 'hopper')[0], { cargo: { ferro: 20 } }); f.run(.5);
  assert.deepEqual(f.progress(), flags());
  f.put(miner, f.site.x); room.extracted.set(f.site.id, .25); f.run(.5);
  assert.equal(f.progress().collectOre, true); assert.equal(f.progress().deliverOre, false);
  const kept = written(room), resumed = new SharedRoom({ kept, build: false, fog: false }); onField(t, resumed);
  const back = resumed.join('Aprendiz', player.token);
  assert.equal(back.playerId, player.playerId); assert.equal(back.faction.objectives.fieldId, room.fieldId);
  assert.equal(back.faction.objectives.completed.collectOre, true); assert.equal(back.faction.objectives.completed.deliverOre, false);
  assert.equal(resumed.record(resumed.world.actor(miner)).gatheredOre, true, 'source vehicle evidence survived restart');
  // A dismantle may refund cargo but is not a real logistics arrival/unload.
  const v = resumed.world.actor(miner).vehicle, x = resumed.faction(resumed.players.get(back.playerId)).base.x;
  resumed.world.command('setVehicleState', { actorId: miner, state: { x, y: v.y - resumed.world.terrain.height(v.x) + resumed.world.terrain.height(x), vx: 0, vy: 0 } });
  resumed.command(back.playerId, { type: 'remove', actorId: miner });
  assert.equal(completed(resumed, back).collectOre, true); assert.equal(completed(resumed, back).deliverOre, false);
});

test('only completed new mobile fabrication and an explicit valid control return are credited', t => {
  const f = setup(t), { room, player, scout } = f;
  f.order(player, 'control', { id: null }); assert.equal(f.progress().directControl, false);
  f.order(player, 'control', { id: scout }); room.disconnect(player.playerId);
  room.join('Aprendiz', player.token); f.order(player, 'control', { id: null });
  assert.equal(f.progress().directControl, false, 'disconnect/rejoin does not complete a control exercise');
  const refused = { ...createStructuredTemplate('scout'), components: [] };
  assert.throws(() => f.send(player, 'spawn', { blueprint: refused })); assert.equal(f.progress().fabricateVehicle, false);
  const cancelled = f.send(player, 'spawn', { blueprint: createStructuredTemplate('scout') });
  f.send(player, 'abandon', { actorId: cancelled.actor.id }); f.run(cancelled.seconds + 1);
  assert.equal(f.progress().fabricateVehicle, false, 'abandoning a build before completion never credits it');
  const fixed = f.raise(player, 'guard-post'); f.run(1);
  f.order(player, 'control', { id: fixed }); f.order(player, 'control', { id: null });
  assert.deepEqual(f.progress(), flags('buildDefense'), 'a static defence is not the vehicle exercise or a fabricated vehicle');
});

test('old saves migrate without resetting the field, and a faction with nothing left and nobody on the field keeps its player and the conclusions', t => {
  const f = setup(t), { room, player, miner } = f;
  const legacy = written(room); delete legacy.fieldId; for (const seat of legacy.players) delete seat.objectives;
  const migrated = new SharedRoom({ kept: legacy, fog: false }); onField(t, migrated);
  assert.equal(migrated.world.actors.length, room.world.actors.length); assert.deepEqual(completed(migrated, player), flags());
  const again = new SharedRoom({ kept: written(migrated), fog: false }); onField(t, again);
  assert.equal(again.fieldId, migrated.fieldId); assert.notEqual(again.fieldId, room.fieldId, 'a fresh field or legacy first migration gets its own identity');
  f.select(miner);
  for (const actor of room.owned(player.playerId)) f.send(player, 'remove', { actorId: actor.id });
  const faction = room.players.get(player.playerId).factionId;
  room.disconnect(player.playerId); room.checkLeases(room.steps + 30 * 24 * 216_000);
  assert.equal(room.factions.size, 1); assert.equal(room.players.get(player.playerId).factionId, faction);
  f.run(.5);
  const restored = new SharedRoom({ kept: written(room), fog: false }); onField(t, restored);
  const back = restored.join('De volta', player.token);
  assert.equal(back.playerId, player.playerId); assert.equal(back.token, player.token); assert.equal(back.faction.id, faction);
  assert.deepEqual(back.faction.objectives.completed, flags('selectMiner'));
  assert.equal(back.actors.length, 0, 'coming back to the faction grants nothing');
  const stranger = restored.join('Outro jogador'); assert.deepEqual(stranger.faction.objectives.completed, flags());
});

test('field identity, new selection commands, conclusions and pending builds survive native snapshots and journal replay', { ...nativePhotoOnly, timeout: 60000 }, async t => {
  const room = new SharedRoom(), f = onField(t, room), host = new FieldHost(room), dir = mkdtempSync(join(tmpdir(), 'impacto-objectives-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  host.record(dir);
  const player = host.join('Aprendiz'), miner = player.actors[0].id;
  host.command(player.playerId, { type: 'objectives', action: 'select', ids: [miner], forged: true });
  const result = host.command(player.playerId, { type: 'spawn', blueprint: createStructuredTemplate('scout'), ticket: 'first' });
  const snapshot = writeField(room, host.publication), copy = new SharedRoom(); onField(t, copy); readField(copy, snapshot);
  assert.equal(copy.fieldId, room.fieldId); assert.deepEqual(completed(copy, player), completed(room, player));
  assert.equal(copy.record(copy.world.actor(result.actor.id)).service.objective, true);
  for (let i = 0; i < (result.seconds + 1) * 60; i++) host.step();
  host.keep(); host.flush(); host.diary.close();
  const path = join(dir, readdirSync(dir)[0]), text = readFileSync(path, 'utf8'), replayed = await replayField(text.trim().split('\n'));
  onField(t, replayed.host.room);
  assert(!text.includes(player.token), 'the journal does not expose the identity token');
  assert.equal(replayed.how, 'end', replayed.got);
  assert.equal(replayed.host.room.fieldId, room.fieldId);
  assert.deepEqual(completed(replayed.host.room, player), completed(room, player));
});

// A player with the constructor every player is given, stood well off the base, on a field that takes its time to put works up.
function defenseSetup(t, { funded = false } = {}) {
  const room = new SharedRoom({ build: false, base: () => -213 }), f = onField(t, room), player = room.join('Construtor'),
    builder = room.owned(player.playerId).find(actor => actor.blueprint.modules.some(piece => piece.kind === 'builder')).id,
    faction = room.faction(room.players.get(player.playerId)), design = createStructuredTemplate('guard-post');
  f.run(2);
  // Refusal/cancellation cases keep their original partial fixture load. The completion case prepares its full admitted bill below.
  if (!funded) {
    room.carry(stow(room.crates(builder), 'ferro', 4000).changed); room.carry(stow(room.crates(builder), 'silica', 2000).changed);
  }
  f.put(builder, player.base.x + 300);
  room.building = true;
  const site = () => {
    for (const offset of [12, 18, 24, -12, -18, -24]) {
      const x = room.position(room.world.actor(builder)) + offset;
      try { constructionSite(room, faction, design, x, 1); return x; } catch { /* select clear, explored, level ground */ }
    }
    assert.fail('The real constructor needs a clear level site nearby.');
  };
  let chosen = null, fundedBill = null;
  if (funded) {
    // First the real constructor explores the site. Only admitted, known ground may supply a footing quote.
    chosen = site();
    assert.deepEqual(designBill(compileStructuredConstruction(design)), bill(5100, 0, 1815), 'the current guard-post design bill, without its site footing');
    fundedBill = structureBill(room, design, chosen, 1);
    assert.deepEqual([fundedBill.ferro, fundedBill.ligas, fundedBill.combustivel], [5100, 0, 0]);
    assert(fundedBill.silica >= 1815, 'any additional silica is the admitted site footing, not a guessed allowance');
    const workPosition = room.position(room.world.actor(builder));
    f.put(builder, player.base.x);
    const before = { ...faction.stock };
    assert.deepEqual(carriedBy(room.crates(builder)).carried, load(), 'this fixture loads an empty supply piece at its base');
    for (const material of STOCK_IDS) assert(before[material] >= fundedBill[material], 'the finite bank pays the complete admitted bill');
    for (const material of STOCK_IDS) if (fundedBill[material] > 0) {
      const transfer = stow(room.crates(builder), SUPPLIED[material], fundedBill[material]);
      assert(Math.abs(transfer.moved - fundedBill[material]) < 1e-6, `${material}: the existing supply capacity takes the whole bill`);
      room.carry(transfer.changed);
    }
    const loaded = supplied(carriedBy(room.crates(builder)).carried);
    for (const material of STOCK_IDS) assert(Math.abs(loaded[material] - fundedBill[material]) < 1e-6, `${material}: the actual cargo is the admitted bill`);
    Object.assign(faction.stock, billSum(before, fundedBill, -1));
    for (const material of STOCK_IDS) assert(Math.abs(faction.stock[material] + loaded[material] - before[material]) < 1e-6, `${material}: loading conserves bank plus cargo`);
    f.put(builder, workPosition);
    constructionSite(room, faction, design, chosen, 1);
    const back = supplied(carriedBy(room.crates(builder)).carried);
    for (const material of STOCK_IDS) assert(Math.abs(back[material] - fundedBill[material]) < 1e-6, `${material}: returning keeps the paid cargo`);
  }
  const selectedSite = () => chosen ?? site();
  return { ...f, player, builder, faction, design, fundedBill, site: selectedSite,
    progress: () => completed(room, player),
    start: (extra = {}) => f.send(player, 'spawn', { blueprint: design, x: selectedSite(), facing: 1, ...extra }) };
}

test('a defence put up off the base concludes only for whoever opened its works, once it stands, and survives reload', t => {
  const f = defenseSetup(t, { funded: true }), { room, player, builder, faction, fundedBill } = f, ally = room.join('Aliado');
  f.send(player, 'invite', { playerId: ally.playerId }); f.send(ally, 'join-faction', { factionId: faction.id });
  const sourceStock = { ...faction.stock }, count = room.world.actors.length, answer = f.start({ ticket: 'tutorial-defense' });
  assert.equal(f.progress().buildDefense, false, 'opening the works is not its result');
  assert.equal(room.world.actors.length, count);
  assert.deepEqual(faction.stock, sourceStock, 'opening the works costs nothing');
  const work = room.works.pending.get(answer.work.id);
  assert(work);
  assert.deepEqual([work.cost, work.delivered, work.progress], [fundedBill, bill(), 0], 'only the paid, fully loaded site bill is admitted; opening delivers and builds nothing');
  // The constructor beside it brings what it carries and puts it up meanwhile, in the time the base would have taken.
  f.run(answer.seconds / 2); assert.equal(f.progress().buildDefense, false);
  assert(room.factionView(player.playerId).works[0].progress > 0, 'the constructor works on it');
  assert.equal(room.works.pending.get(answer.work.id), work);
  const share = Math.min(...STOCK_IDS.filter(material => work.cost[material] > 0).map(material => work.delivered[material] / work.cost[material])),
    aboard = supplied(carriedBy(room.crates(builder)).carried);
  assert(share > 0 && share <= 1 && work.progress > 0 && work.progress < 1 && work.progress <= share + 1e-6, 'the checkpoint keeps genuine partial work capped by delivered material');
  for (const material of STOCK_IDS) assert(Math.abs(work.delivered[material] + aboard[material] - fundedBill[material]) < 1e-6, `${material}: the actual delivered and remaining paid material is conserved`);
  const kept = written(room), resumed = new SharedRoom({ kept }); onField(t, resumed);
  const back = resumed.join('Construtor', player.token), step = () => resumed.step();
  assert.equal(completed(resumed, back).buildDefense, false);
  for (let i = 0; i < 60 * 60 && !resumed.world.actor(answer.work.id); i++) step();
  assert.equal(resumed.world.actors.length, count + 1);
  assert.equal(completed(resumed, back).buildDefense, true, 'the final accepted static actor is the confirmation');
  assert.equal(completed(resumed, ally).buildDefense, false, 'a faction ally receives no conclusion');
  const defense = resumed.owned(back.playerId).find(actor => !actor.vehicle), span = constructionSpan(defense.construction, defense.x, defense.facing);
  assert(span.minX > faction.base.x + BASE_RADIUS || span.maxX < faction.base.x - BASE_RADIUS);
  resumed.discard(defense.id);
  assert.equal(completed(resumed, back).buildDefense, true, 'losing the completed defence cannot erase the objective');
  assert.equal(resumed.record(resumed.world.actor(builder)).auto, true, 'the constructor stays in automatic');
  assert.equal(completed(resumed, back).fabricateVehicle, false, 'granting the constructor and building a static defence are separate from fabrication');
});

test('a defence asked for at the base or nowhere opens no works, and one given up concludes nothing', t => {
  const f = defenseSetup(t), { room, player } = f, count = room.world.actors.length;
  assert.throws(() => f.start({ x: player.base.x + 20 }), { message: 'Perto demais da base: no mínimo 150 m.' });
  assert.throws(() => f.start({ x: null }), { message: 'Escolha o local da estrutura no campo.' });
  assert.equal(room.works.pending.size, 0);
  const answer = f.start(); f.run(1);
  f.send(player, 'cancel-work', { workId: answer.work.id });
  f.run(answer.seconds + .5);
  assert.equal(f.progress().buildDefense, false);
  assert.equal(room.world.actors.length, count);
});

test('unknown ground and a partially explored footprint are refused before reading hidden relief or opening a works', t => {
  const f = defenseSetup(t), { room, faction, design, player, builder } = f, x = f.site(),
    span = constructionSpan(design, x, 1), terrain = room.world.terrain, height = terrain.height,
    supplies = JSON.stringify(room.serving(builder).map(piece => piece.cargo));
  let heights = 0;
  terrain.height = at => { heights++; return height(at); };
  try {
    for (const explored of [[], [[span.minX, x]], [[x, span.maxX]]]) {
      faction.explored = explored;
      assert.throws(() => constructionSite(room, faction, design, x, 1), { message: 'Terreno desconhecido: escolha chão já visto.' });
      assert.equal(heights, 0, 'an unavailable site gives no height or slope evidence');
      assert.throws(() => f.send(player, 'spawn', { blueprint: design, x, facing: 1 }), { message: 'Terreno desconhecido: escolha chão já visto.' });
      assert.equal(heights, 0);
    }
  } finally { terrain.height = height; }
  assert.equal(JSON.stringify(room.serving(builder).map(piece => piece.cargo)), supplies);
  assert.equal(room.works.pending.size, 0); assert.equal(f.progress().buildDefense, false);
});
