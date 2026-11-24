import test from 'node:test';
import assert from 'node:assert/strict';
import { workshopActions, suggestedAmmunition } from '../src/workshop-actions.ts';

const frame = {
  source: { plates: [{ id: 'roof' }, { id: 'floor' }, { id: 'isolated' }], components: [{ id: 'engine', kind: 'engine' }] },
  blueprint: { rooms: [{ id: 'hull' }] },
  spans: [
    { id: 'roof', a: { x: 0, y: 1 }, b: { x: 1, y: 1 }, normal: { x: 0, y: 1 } },
    { id: 'floor', a: { x: 0, y: 0 }, b: { x: 1, y: 0 }, normal: { x: 0, y: -1 } },
    { id: 'isolated', a: { x: 2, y: 0 }, b: { x: 2, y: 1 }, normal: null },
  ],
};
const actions = id => workshopActions(frame, [id]);

test('the last closed hull can open and can grow downwards without a compilation preflight', () => {
  const before = structuredClone(frame), roof = actions('roof'), floor = actions('floor');
  assert.equal(roof.remove.available, true);
  assert.equal(roof.removeRoom.available, true);
  assert.equal(roof.grow.available, true);
  assert.equal(roof.split.available, true);
  assert.equal(floor.title, 'Piso');
  assert.equal(floor.grow.available, true);
  assert.deepEqual(frame, before, 'presenting actions never edits the project');
});

test('an isolated plate offers split, removal and compartment growth without a room', () => {
  const open = workshopActions({ ...frame, blueprint: { rooms: [] } }, ['isolated']);
  assert.equal(open.title, 'Chapa');
  for (const action of ['grow', 'split', 'remove']) assert.equal(open[action].available, true, action);
  assert.equal(open.removeRoom.available, false);
});

test('component deletion and mixed selection remain available without plate-specific actions', () => {
  for (const ids of [['engine'], ['engine', 'roof']]) {
    const selected = workshopActions(frame, ids);
    assert.equal(selected.remove.available, true);
    for (const action of ['grow', 'split', 'removeRoom']) assert.equal(selected[action].available, false, action);
  }
});

test('ends of plates join two or more, or one with ends exactly where it is', () => {
  // Two plates meet at n2; a third starts at n3, in the same place but its own.
  const nodes = [[1, 0, 0], [2, 1, 0], [3, 1, 0], [4, 2, 0], [5, 1, 1]].map(([n, x, y]) => ({ id: 'n' + n, x, y })),
    source = { nodes, components: [], plates: [{ id: 'p1', a: 'n1', b: 'n2' }, { id: 'p2', a: 'n3', b: 'n4' }, { id: 'p3', a: 'n2', b: 'n5' }] },
    offered = ids => { const all = workshopActions({ source, blueprint: { rooms: [] }, spans: [] }, ids);
      return ['join', 'remove'].filter(action => all[action].available); };
  assert.deepEqual(offered(['node:n1', 'node:n4']), ['join', 'remove']);
  assert.deepEqual(offered(['node:n3']), ['join', 'remove'], 'its neighbour in the same place');
  assert.deepEqual(offered(['node:n2']), ['join', 'remove']);
  assert.deepEqual(offered(['node:n1']), ['remove'], 'an end alone, with nothing where it is');
  assert.deepEqual(offered(['stretch:1']), ['remove']); assert.deepEqual(offered(['vertex:2']), ['remove']);
});

test('a new ammunition box prioritizes an unfed weapon and preserves deliberate compatible choices', () => {
  const blueprint = { modules: [{ kind: 'weapon', weaponPreset: 'm2hb' }, { kind: 'weapon', weaponPreset: 'rh120' },
    { kind: 'ammo', ammoPreset: 'm2hb', rounds: 50 }] };
  assert.equal(suggestedAmmunition(blueprint, 'm2hb'), 'rh120');
  blueprint.modules.push({ kind: 'ammo', ammoPreset: 'rh120', rounds: 10 });
  assert.equal(suggestedAmmunition(blueprint, 'm2hb'), 'm2hb');
  assert.equal(suggestedAmmunition({ modules: [] }, 'rh120'), 'rh120');
});
