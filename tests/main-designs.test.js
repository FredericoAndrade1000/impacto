import test from 'node:test';
import assert from 'node:assert/strict';
import { createFieldDesigns } from '../src/field-designs.ts';

// The page's bookkeeping of the designs of the player's constructions, on frames of the field, with a field that answers
// what it is asked.
function page() {
  const asked = [], remembered = [], network = { playerId: 'me', designs: new Map([['c1', { id: 'c1', blueprint: { name: 'Caminhão' } }]]),
    command: (type, data) => { asked.push([type, data.actorId]); return Promise.resolve({ actor: { id: data.actorId, blueprint: { name: 'Posto' } } }); } };
  const rememberConstruction = result => { remembered.push(result.actor.id); network.designs.set(result.actor.id, result.actor); };
  const forgetLost = createFieldDesigns(network, rememberConstruction);
  return { network, asked, remembered, frame: forgetLost };
}

test('a construction of the player the page was never told of, as a defence a constructor raised, has its design asked of the field once', async () => {
  const p = page(), actors = [{ id: 'c1', ownerId: 'me' }, { id: 'c7', ownerId: 'me' }, { id: 'e3', ownerId: 'them' }, { id: 'c9', ownerId: 'me', defeated: true }];
  p.frame(actors); p.frame(actors);
  assert.deepEqual(p.asked, [['blueprint', 'c7']], 'only the unknown one of the player that stands, and only once while the answer is on its way');
  await Promise.resolve();
  assert.deepEqual(p.remembered, ['c7']); assert.equal(p.network.designs.get('c7').blueprint.name, 'Posto');
  p.frame(actors); assert.equal(p.asked.length, 1);
});

test('a field that refuses to tell a design is not asked again', async () => {
  const p = page(); p.network.command = (type, data) => { p.asked.push([type, data.actorId]); return Promise.reject(new Error('Essa construção já não está no campo.')); };
  const actors = [{ id: 'c7', ownerId: 'me' }];
  p.frame(actors); await Promise.resolve(); p.frame(actors);
  assert.deepEqual(p.asked, [['blueprint', 'c7']]); assert.deepEqual(p.remembered, []);
});

test('a construction that returns to our faction can have its forgotten design fetched again', async () => {
  const p = page(), ours = [{ id: 'c7', ownerId: 'me' }], theirs = [{ id: 'c7', ownerId: 'them' }];
  p.frame(ours); await Promise.resolve();
  p.frame(theirs); assert(!p.network.designs.has('c7'));
  p.frame(ours); await Promise.resolve();
  assert.deepEqual(p.asked, [['blueprint', 'c7'], ['blueprint', 'c7']]);
  assert(p.network.designs.has('c7'));
});

test('an obsolete design reply cannot restore a construction that left our faction or supersede its new reply', async () => {
  const p = page(), replies = [];
  p.network.command = () => new Promise(resolve => replies.push(resolve));
  const ours = [{ id: 'c7', ownerId: 'me' }], theirs = [{ id: 'c7', ownerId: 'them' }];
  p.frame(ours); p.frame(theirs);
  replies[0]({ actor: { id: 'c7', blueprint: { name: 'Obsoleto' } } }); await Promise.resolve();
  assert(!p.network.designs.has('c7'), 'a reply is no longer permission to retain the design');
  p.frame(ours); p.frame(theirs); p.frame(ours);
  replies[2]({ actor: { id: 'c7', blueprint: { name: 'Atual' } } }); await Promise.resolve();
  replies[1]({ actor: { id: 'c7', blueprint: { name: 'Antigo' } } }); await Promise.resolve();
  assert.equal(p.network.designs.get('c7').blueprint.name, 'Atual');
});
