import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameReader, NETWORK_VERSION, merged } from '../src/network-protocol.ts';
import { serveNetwork } from './helpers/network.js';

const EMPTY = { selectMiner: false, collectOre: false, deliverOre: false, directControl: false, fabricateVehicle: false, buildDefense: false },
  until = async (done, timeout = 10000) => {
    const start = Date.now();
    while (!done()) {
      if (Date.now() - start > timeout) throw new Error('O estado esperado não chegou pelo socket.');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };

async function serve(t, dir) {
  const { socket, close } = await serveNetwork(t, { save: { dir, seconds: 3600 } });
  const connect = async (name, token = '') => {
    const ws = socket(), reader = new FrameReader(),
      client = { ws, messages: [], frames: [], faction: null };
    ws.on('message', (raw, binary) => {
      if (binary) {
        const packet = reader.decode(raw);
        if (packet) client.frames.push(packet); else ws.send(JSON.stringify({ type: 'resync' }));
        return;
      }
      const message = JSON.parse(raw);
      if (message.type === 'welcome') { client.welcome = message; client.faction = message.faction; }
      if (message.type === 'faction') client.faction = merged(client.faction, message.changes);
      client.messages.push(message);
    });
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'hello', version: NETWORK_VERSION, name, token }));
    await until(() => client.welcome || client.messages.some(message => message.error));
    assert(client.welcome, client.messages.find(message => message.error)?.error);
    let request = 0;
    client.ask = async data => {
      const id = ++request;
      ws.send(JSON.stringify({ ...data, request: id }));
      await until(() => client.messages.some(message => message.request === id));
      return client.messages.find(message => message.request === id);
    };
    return client;
  };
  return { connect, close };
}

test('private objectives cross real sockets, survive reconnect and restart, and never follow an ally or an old token into another field', { timeout: 60000 }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'impacto-objectives-network-')), fields = [],
    start = async name => { const field = await serve(t, join(dir, name)); fields.push(field); return field; };
  t.after(async () => { for (const field of fields) await field.close(); rmSync(dir, { recursive: true, force: true }); });
  const first = await start('same-field'), alice = await first.connect('Alice'), bob = await first.connect('Bob'),
    identity = alice.welcome.playerId, token = alice.welcome.token, fieldId = alice.welcome.faction.objectives.fieldId,
    miner = alice.welcome.actors.find(actor => actor.blueprint.components.some(piece => piece.kind === 'excavator')).id;
  assert.deepEqual(alice.welcome.faction.objectives.completed, EMPTY);
  assert.equal(alice.welcome.selected, null, 'the real welcome starts with no miner preselected');
  assert.equal(alice.welcome.actors.length, 3, 'the starter includes a ready constructor');
  assert.deepEqual(bob.welcome.faction.objectives.completed, EMPTY);
  assert.equal(bob.welcome.faction.objectives.fieldId, fieldId);
  assert.equal((await alice.ask({ type: 'invite', playerId: bob.welcome.playerId })).error, undefined);
  assert.equal((await bob.ask({ type: 'join-faction', factionId: alice.welcome.faction.id })).error, undefined);
  await until(() => bob.faction.id === alice.faction.id);

  // The miner is the faction's: Alice takes it in hand, and while she holds it Bob picking it counts for nothing.
  assert.equal((await alice.ask({ type: 'select', actorId: miner })).error, undefined);
  const heldByAlly = await bob.ask({ type: 'objectives', action: 'select', ids: [miner] });
  assert.equal(heldByAlly.error, undefined);
  const selected = await alice.ask({ type: 'objectives', action: 'select', ids: [miner],
    completed: { fabricateVehicle: true, deliverOre: true } });
  assert.equal(selected.error, undefined);
  await until(() => alice.faction.objectives.completed.selectMiner && alice.frames.length && bob.frames.length);
  assert.deepEqual(alice.faction.objectives.completed, { ...EMPTY, selectMiner: true }, 'only the validated selection reached the authoritative result');
  assert.deepEqual(bob.faction.objectives.completed, EMPTY, 'members of the same faction receive their own objective progress');
  assert(alice.messages.some(message => message.type === 'faction' && message.changes.objectives), 'the conclusion arrived in a real private JSON update');
  assert([...alice.frames, ...bob.frames].every(packet => !('objectives' in packet.state)), 'shared binary frames carry no individual objective progress');

  assert.equal((await alice.ask({ type: 'select', actorId: miner })).error, undefined);
  const left = once(alice.ws, 'close'); alice.ws.close(); await left;
  const back = await first.connect('Alice', token);
  assert.equal(back.welcome.playerId, identity); assert.equal(back.welcome.faction.objectives.fieldId, fieldId);
  assert.equal(back.welcome.selected, miner, 'a returning player keeps their explicit focus');
  assert.deepEqual(back.welcome.faction.objectives.completed, { ...EMPTY, selectMiner: true });
  await first.close();
  const resumed = await start('same-field'), reloaded = await resumed.connect('Alice', token);
  assert.equal(reloaded.welcome.playerId, identity); assert.equal(reloaded.welcome.faction.objectives.fieldId, fieldId);
  assert.equal(reloaded.welcome.selected, miner);
  assert.deepEqual(reloaded.welcome.faction.objectives.completed, { ...EMPTY, selectMiner: true });

  const fresh = await start('another-field');
  await assert.rejects(fresh.connect('Alice', token), /Chave de acesso não encontrada/, 'another field knows no key of this one');
  const newcomer = await fresh.connect('Alice');
  assert.notEqual(newcomer.welcome.faction.objectives.fieldId, fieldId);
  assert.notEqual(newcomer.welcome.token, token);
  assert.deepEqual(newcomer.welcome.faction.objectives.completed, EMPTY, 'the browser identity cannot import progress from another field');
});
