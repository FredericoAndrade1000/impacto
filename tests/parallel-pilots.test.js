import test from 'node:test';
import assert from 'node:assert/strict';
import { FieldHost, openRoom, replayField, DIARY } from '../server/field-host.ts';
import { FIELD_SAVE } from '../server/field-save.ts';
import { NETWORK_VERSION } from '../src/network-protocol.ts';
import { CORE_CONTRACT } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';

test('a field with independent pilots replays its decisions and their application in order', async t => {
  const field = { bases: [-900, -500, -100, 300, 700, 1100] };
  const host = new FieldHost(openRoom(field), { field }), room = host.room;
  t.after(() => room.world.dispose());
  const ids = [];
  for (const [index, x] of field.bases.entries()) {
    const player = host.join(`Pilot ${index + 1}`);
    const id = host.command(player.playerId, { type: 'spawn', blueprint: createStructuredTemplate('scout'), x, facing: index % 2 ? -1 : 1 }).actor.id;
    host.command(player.playerId, { type: 'squad', order: 'stance', ids: [id], stance: 'fire' });
    ids.push(id);
  }
  const game = room.world.game(), call = game.call.bind(game), batches = [];
  Object.defineProperty(game, 'call', { configurable: true, value(request) {
    if (request.op === 'scriptedDecisions') batches.push(request.requests.map(row => row.actorId));
    return call(request);
  } });
  for (let step = 0; step < 180; step++) {
    if (step % 3 === 0) host.tell([...room.players.keys()], step % 15 === 0);
    host.step(() => 1);
  }
  assert(batches.some(batch => batch.length >= 4), 'ordinary scheduling must batch at least four independent pilots');
  assert(batches.every(batch => new Set(batch).size === batch.length && batch.every(id => ids.includes(id))));
  assert.deepEqual([...room.faults], []);
  const lines = [JSON.stringify({ diary: DIARY, save: FIELD_SAVE, network: NETWORK_VERSION, contract: CORE_CONTRACT, field, origin: null }), ...host.lines];
  const replay = await replayField(lines);
  t.after(() => replay.host.room.world.dispose());
  assert.equal(replay.how, 'end', replay.got);
  assert.equal(replay.step, 180);
  assert.equal(replay.prints, 3);
  assert.equal(replay.host.room.digest(), room.digest());
});
