import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse } from 'node:path';
import { fieldServerConfig } from '../server/field-config.ts';
import { readWorkerOptions } from '../server/worker-contract.ts';
import { checkTestSave } from '../server/test-server.ts';
import { attachNetworkServer } from '../server/network-server.ts';
import { commanderPopulation, COMMANDER_FILL_INTERVAL } from '../server/commander-population.ts';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { STARTING_STOCK } from '../src/economy.ts';
import { FIXED_DT } from '../src/physics.ts';
import './helpers/runtime.js';

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-commander-population-'));
  t.after(() => { assert(dir.startsWith(join(tmpdir(), 'impacto-commander-population-'))); rmSync(dir, { recursive: true, force: true }); });
  return dir;
}

test('public population requires explicit persistent opt-in and rejects incompatible modes before filesystem effects', t => {
  const root = directory(t), dir = join(root, 'normal'), env = { IMPACTO_SAVE_DIR: dir }, server = createServer();
  assert.deepEqual(fieldServerConfig({}), { testTools: false, save: null });
  for (const value of ['0', '1', '32']) assert.deepEqual(fieldServerConfig({ ...env, IMPACTO_AI_MIN_PLAYERS: value }),
    { testTools: false, save: { dir }, commanderFill: Number(value) });
  for (const value of ['', '-1', '33', '1.5', ' 1', 'Infinity', 'many']) assert.throws(() =>
    fieldServerConfig({ ...env, IMPACTO_AI_MIN_PLAYERS: value }), /0 a 32/);
  for (const save of [undefined, null, { dir: '' }, { dir: 'relative-save' }, { dir: parse(root).root }])
    assert.throws(() => readWorkerOptions({ commanderFill: 0, save }), /save explícita, absoluta/);
  for (const extra of [{ testTools: true }, { commanders: 0 }, { rehearsal: { bases: [] } }, { stress: 1 }]) {
    assert.throws(() => attachNetworkServer(server, { commanderFill: 0, save: { dir }, ...extra }), /não pode ser combinada/);
    assert.equal(existsSync(dir), false, 'refusing a mode creates neither a marker nor a save directory');
  }
  for (const extra of [
    { IMPACTO_TEST_SERVER: '1', IMPACTO_TEST_SAVE_DIR: dir, IMPACTO_SAVE_DIR: undefined },
    { IMPACTO_REHEARSAL: '1' }, { IMPACTO_STRESS: '1' },
  ]) assert.throws(() => fieldServerConfig({ ...env, IMPACTO_AI_MIN_PLAYERS: '0', ...extra }), /não pode ser combinada/);
  assert.equal(existsSync(dir), false);
  const marked = join(root, 'test'); checkTestSave(true, { dir: marked });
  assert.throws(() => attachNetworkServer(server, { commanderFill: 1, save: { dir: marked } }), /não abra como campo normal/);
});

test('the public scheduler waits a minute, grants an ordinary kit once, and replays without the live scheduler', { timeout: 20000 }, async t => {
  const room = openRoom(null), host = new FieldHost(room), header = JSON.stringify({ diary: DIARY, network: NETWORK_VERSION,
    save: FIELD_SAVE, contract: CORE_CONTRACT, field: null, origin: null, fieldId: room.fieldId });
  t.after(() => room.world.dispose());
  const human = host.join('Comandante IA 1'), fill = commanderPopulation(host, 2);
  for (let i = 0; i < 3600; i++) { fill(); host.step(() => 1); }
  fill(); assert.equal(room.commanders.size, 0, 'the deadline is strictly after 60 world seconds');
  host.step(() => 1); fill();
  assert.equal(room.commanders.size, 1);
  const [id] = room.commanders.keys(), player = room.players.get(id), faction = room.faction(player);
  assert.equal(player.name, 'Comandante IA 2', 'a human keeps their chosen name and seat');
  assert.equal(room.players.get(human.playerId).connected, true);
  assert.equal(player.connected, false);
  assert.deepEqual(faction.stock, STARTING_STOCK);
  assert.equal(room.owned(id).length, 3);
  assert.equal(room.commanders.get(id).sequence, 0, 'creation is recorded before the first decision');
  // Finish at a recorded print tick: quiet steps after the last diary event
  // are intentionally not a replay endpoint.
  for (let i = 0; i < 59; i++) { fill(); host.step(() => 1); }
  assert.equal(room.commanders.size, 1, 'a host cannot fill every vacancy in one frame');
  assert(room.commanders.get(id).sequence > 0);
  assert.equal(host.lines.map(JSON.parse).filter(row => row[1] === 'commander').length, 1);
  assert(!host.lines.map(JSON.parse).some(row => row[1] === 'do'), 'strategic decisions are internal, not duplicate inputs');
  const replay = await replayField([header, ...host.lines]);
  t.after(() => replay.host.room.world.dispose());
  assert.equal(replay.how, 'end', replay.got);
  assert.equal(replay.host.room.digest(), room.digest(), 'the creation event suffices without live population scheduling');
});

test('population is a creation floor: humans retain priority, pauses and defeated identities consume the four-seat AI limit', () => {
  // Only operational time and presence are controlled here; normal admission,
  // stocks, physical stepping and replay are exercised in the integration above.
  const room = { world: { time: 100 }, players: new Map(), commanders: new Map(), nameFree() {} }, births = [],
    host = { room, addCommander(name) {
      const id = `bot${births.length + 1}`;
      births.push({ time: room.world.time, name });
      room.players.set(id, { id, connected: false }); room.commanders.set(id, { enabled: true });
      return { id, factionId: id, enabled: true };
    } }, human = { id: 'human', connected: true };
  room.players.set(human.id, human);
  const fill = commanderPopulation(host, 1), due = 100 + COMMANDER_FILL_INTERVAL + FIXED_DT;
  room.world.time = due; fill(); assert.equal(births.length, 0, 'a connected identity already fulfills the target');
  human.connected = false;
  room.world.time = due + FIXED_DT; fill(); assert.equal(births.length, 0, 'presence is evaluated at most once per minute');
  room.world.time = due + COMMANDER_FILL_INTERVAL; fill(); assert.equal(births.length, 1);
  human.connected = true;
  room.world.time += COMMANDER_FILL_INTERVAL; fill();
  assert.equal(room.commanders.get('bot1').enabled, true, 'arrival does not evict or pause an existing AI');
  room.commanders.get('bot1').enabled = false;
  const more = commanderPopulation(host, 20);
  for (let i = 0; i < 5; i++) { room.world.time += COMMANDER_FILL_INTERVAL + FIXED_DT; more(); more(); }
  assert.equal(room.commanders.size, 4, 'the cap includes paused and actorless/defeated identities');
  assert.equal(room.commanders.get('bot1').enabled, false, 'filling never resumes an explicit pause');
  assert(births.every((entry, index) => !index || entry.time - births[index - 1].time >= COMMANDER_FILL_INTERVAL));
  const restarted = commanderPopulation(host, 20), zero = commanderPopulation(host, 0);
  restarted(); zero(); assert.equal(births.length, 4);
});
