import test from 'node:test';
import assert from 'node:assert/strict';
import { scriptedDecision } from '../src/squad.ts';
import { weaponSettings } from '../src/weapons.ts';
import { Fog, chapters } from '../server/fog.ts';
import { Publication } from '../server/publication.ts';
import { perceptionScene, instrumentBlueprint, targetBlueprint, sensed, moveTarget, until, health } from './helpers/perception-scene.js';

test('native intelligence grants the same measured contact and revokes a same-tick relay without granting perfect allied state', async t => {
  const world = await perceptionScene(t, { mode: null, distance: 300 });
  world.addActor(instrumentBlueprint(), { id: 'relay', ownerId: 'amber', x: 100, facing: 1 });
  world.addActor(targetBlueprint(), { id: 'unseen-ally', ownerId: 'amber', x: 9000, facing: -1 });
  const game = world.game(); game.call({ op: 'alliances', pairs: [['blue', 'amber']], frame: false });
  const shared = sensed(world, 'own', 'enemy'); assert(shared?.detected && shared.visible);
  assert.deepEqual(shared, sensed(world, 'relay', 'enemy'));
  const rows = game.call({ op: 'teamSight', frame: false }).sight.blue;
  assert(rows.some(c => c.actorId === 'enemy' && c.channel === 'visual' && c.visible));
  assert(!rows.some(c => c.actorId === 'unseen-ally'));
  game.call({ op: 'alliances', pairs: [], frame: false }); moveTarget(world, { x: 500 });
  const memory = sensed(world, 'own', 'enemy'); assert(memory?.detected && !memory.visible);
  assert.equal(memory.x, shared.x); assert.equal(memory.y, shared.y); assert.equal(memory.source, 'memory');
  assert(!(game.call({ op: 'teamSight', frame: false }).sight.blue || []).some(c => c.actorId === 'enemy' && c.visible));
});

test('native pilots hold a direct allied target and the same explicit target becomes eligible on revocation', async t => {
  const world = await perceptionScene(t, { target: false, mode: 'visual' });
  world.addActor(instrumentBlueprint(), { id: 'partner', ownerId: 'amber', x: 100, facing: -1 });
  assert.equal(scriptedDecision(world, 'own', world.bounds).targetId, 'partner');
  world.game().call({ op: 'alliances', pairs: [['blue', 'amber']], frame: false });
  assert.equal(scriptedDecision(world, 'own', world.bounds).targetId, null);
  const held = scriptedDecision(world, 'own', world.bounds, 'partner');
  assert.equal(held.targetId, null); assert.equal(held.fire, false); assert.equal(held.diagnostics.reason, 'ally-target');
  assert.equal(world.actor('own').team, 'blue'); assert.equal(world.actor('partner').team, 'amber');
  world.game().call({ op: 'alliances', pairs: [], frame: false });
  assert.equal(scriptedDecision(world, 'own', world.bounds, 'partner').targetId, 'partner');
});

for (const mode of ['visual', 'radar', 'sound']) test(`revoking ${mode} stops current native, automatic and audience data in the same tick`, async t => {
  const world = await perceptionScene(t, { mode: null, distance: 300, targetEngine: true });
  world.addActor(instrumentBlueprint({ mode }), { id: 'relay', ownerId: 'amber', x: 100, facing: 1 });
  const game = world.game(); game.call({ op: 'alliances', pairs: [['blue', 'amber']], frame: false });
  if (mode === 'sound') {
    game.call({ op: 'configureLauncher', actorId: 'enemy', point: { x: 300, y: 4 } });
    assert(world.fire({ x: 300, y: 40 }, weaponSettings('machinegun', { preset: 'fnmag', platform: 'ground', spread: 0 }), true, 'enemy'));
    until(world, .5);
  }
  const shared = sensed(world, 'own', 'enemy'); assert(shared.detected && shared.visible); assert.equal(shared.channel, mode);
  const fog = new Fog(), publication = new Publication(),
    refresh = (current = false) => fog.read(game.call({ op: 'teamSight', frame: false }), world.time, new Set(world.actors.map(a => a.id)), current,
      team => team === 'amber' ? { ref: 'r-amber', name: 'Bia', nation: 'Vale' } : null),
    shown = () => { const state = publication.state(world.snapshot()); return fog.tell(state, chapters(state), 'blue'); };
  refresh(true); const before = shown(), rememberedPart = before.modules.find(m => m.actorId === 'enemy'), tick = world.tick;
  if (mode === 'sound') {
    const report = before.contacts.find(c => c.kind === 'sound');
    assert.deepEqual(report, { kind: 'sound', shared: true, from: { ref: 'r-amber', name: 'Bia', nation: 'Vale' }, side: 1,
      at: Math.round((world.time - shared.age) * 1000) / 1000 });
    assert.equal(shared.sharedSound, true); assert.equal(sensed(world, 'relay', 'enemy').sharedSound, undefined);
    assert((game.call({ op: 'teamSight', frame: false }).sight.amber || []).every(row => !('report' in row)), 'own native audience shape is unchanged');
  } else if (mode === 'radar') assert(before.contacts.some(c => c.kind === 'radar' && c.x === shared.x));
  else assert(before.actors.some(a => a.id === 'enemy' && !a.ghost));
  assert.equal(scriptedDecision(world, 'own', world.bounds).targetId, 'enemy', 'unknown radar/sound condition stays neutral, and known optical condition is usable');
  game.call({ op: 'alliances', pairs: [], frame: false }); refresh(true);
  const automatic = scriptedDecision(world, 'own', world.bounds), frozen = shown();
  moveTarget(world, { x: 700, vx: 20 });
  health(world, world.modules.find(m => m.actorId === 'enemy' && m.kind === 'engine'), 0);
  refresh(true); const after = shown(), memory = sensed(world, 'own', 'enemy'), decision = scriptedDecision(world, 'own', world.bounds);
  assert.equal(world.tick, tick); assert(!memory.visible); assert.equal(memory.source, 'memory');
  assert.equal(memory.x, shared.x); assert.equal(memory.y, shared.y);
  assert.equal(decision.targetId, automatic.targetId); assert.deepEqual(decision.contact, automatic.contact);
  assert.deepEqual(after.contacts, frozen.contacts);
  if (mode === 'visual') {
    const ghost = after.actors.find(a => a.id === 'enemy'); assert(ghost.ghost);
    assert.equal(ghost.vehicle.x, before.actors.find(a => a.id === 'enemy').vehicle.x);
    if (rememberedPart) assert.deepEqual(after.modules.find(m => m.id === rememberedPart.id), rememberedPart);
  } else assert(!after.actors.some(a => a.id === 'enemy'));
});

test('an allied sound report keeps its original side and age with no receiver, while own sound keeps its original payload', () => {
  const fog = new Fog(), from = { ref: 'r-amber', name: 'Bia', nation: 'Vale' },
    actor = (id, team, x) => ({ actor: { id, team, x }, plates: [], modules: [], bodyPanels: [] }),
    parts = new Map([['own', actor('own', 'blue', 0)], ['ear', actor('ear', 'amber', 800)]]),
    read = (time, visible = true, x = 400) => fog.read({ sight: { blue: [{ actorId: 'hidden-target', channel: 'sound', visible,
      by: 'ear', x, y: 0, age: time - 8.5, report: { team: 'amber', side: -1 } }] } }, time, null, true, () => from),
    tell = time => fog.tell({ time }, parts, 'blue').contacts;
  read(8.5);
  const report = { kind: 'sound', shared: true, from, side: -1, at: 8.5 };
  assert.deepEqual(tell(8.5), [report], 'the target between receiver and allied ear is left of that ear');
  parts.get('own').actor.x = 900; parts.get('ear').actor.x = -900;
  read(8.75);
  assert.deepEqual(tell(8.75), [report], 'a reused reading never reanchors either reference');
  read(8.75, false, 1200);
  assert.deepEqual(tell(8.75), [report], 'revocation ignores hidden new state even in the same tick');
  parts.clear();
  assert.deepEqual(tell(9), [report], 'a received report needs no own construction or surviving ear');
  assert.deepEqual(tell(11.501), []);
  const own = new Fog(); parts.set('own', actor('own', 'blue', 0));
  own.read({ sight: { blue: [{ actorId: 'hidden-target', channel: 'sound', visible: true, by: 'own', x: 400, age: 0,
    report: { team: 'blue', side: 1 } }] } }, 8.5);
  assert.deepEqual(own.tell({ time: 8.5 }, parts, 'blue').contacts, [{ kind: 'sound', by: 'own', side: 1, at: 8.5 }]);
  parts.get('own').actor.x = 900;
  assert.deepEqual(own.tell({ time: 8.75 }, parts, 'blue').contacts, [{ kind: 'sound', by: 'own', side: -1, at: 8.5 }], 'own hearing presentation is unchanged');
});
