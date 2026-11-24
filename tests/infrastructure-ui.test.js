import test from 'node:test';
import assert from 'node:assert/strict';
import { infrastructureOffer, initInfrastructureUX } from '../src/infrastructure-ux.ts';
import { FIELD_TASKS } from '../src/field-navigation.ts';
import { rehearsal, asked } from '../server/room.ts';
import { bill, UNBASED } from '../src/economy.ts';
import { POST_FULL } from '../src/territory.ts';
import { onField } from './helpers/field.js';

// The buttons of the page as index.html has them, counted as they are pressed and switched.
function page(t) {
  const before = globalThis.document, element = id => ({ id, disabled: false, textContent: '', dataset: {} }),
    elements = new Map(['infra-post', 'infra-post-held', 'infra-road-held'].map(id => [id, element(id)])),
    roads = ['graded', 'asphalt'].map(kind => ({ ...element('road-' + kind), dataset: { road: kind } }));
  globalThis.document = { getElementById: id => elements.get(id) ?? null, querySelectorAll: selector => selector === '#field-page-infra [data-road]' ? roads : [] };
  t.after(() => { globalThis.document = before; });
  const begun = [], toasts = [], refuse = { post: '', road: '' },
    ux = initInfrastructureUX({ toast: (...said) => toasts.push(said),
      post: () => { if (refuse.post) throw new Error(refuse.post); begun.push(['post']); },
      road: kind => { if (refuse.road) throw new Error(refuse.road); begun.push(['road', kind]); } });
  return { ux, begun, toasts, refuse, roads, post: elements.get('infra-post'), postHeld: elements.get('infra-post-held'), roadHeld: elements.get('infra-road-held') };
}

test('the Infraestrutura page offers a post and the roads, and says why not without a base or with all the posts a faction may have', () => {
  assert(FIELD_TASKS.some(task => task.id === 'infra'), 'a page of the field of its own, beside the faction');
  const base = { x: 0, radius: 100 }, posts = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, x: 2000 * (i + 1) }));
  assert.deepEqual(infrastructureOffer({ base, posts: [], works: [] }), { post: '', road: '' });
  assert.deepEqual(infrastructureOffer({ base, posts: posts(3), works: [] }), { post: '', road: '' });
  assert.deepEqual(infrastructureOffer({ base, posts: posts(3), works: [{ id: 'w1', post: true }, { id: 'w2' }] }), { post: POST_FULL, road: '' }, 'a works of a post counts');
  assert.deepEqual(infrastructureOffer({ base, posts: posts(4), works: [] }), { post: POST_FULL, road: '' });
  assert.equal(POST_FULL, 'Sua facção já tem 4 postos.');
  assert.deepEqual(infrastructureOffer({ base: null, posts: [], works: [] }), { post: UNBASED, road: UNBASED });
});

test('a button of the page begins choosing a post or a road on the field, and one switched off says why and begins nothing', t => {
  const f = page(t);
  f.ux.render({ post: '', road: '' });
  assert.deepEqual([f.post.disabled, f.postHeld.textContent, f.roads.map(button => button.disabled), f.roadHeld.textContent], [false, '', [false, false], '']);
  f.post.onclick(); f.roads[1].onclick(); f.roads[0].onclick();
  assert.deepEqual(f.begun, [['post'], ['road', 'asphalt'], ['road', 'graded']]);
  f.ux.render({ post: POST_FULL, road: '' });
  assert.deepEqual([f.post.disabled, f.postHeld.textContent], [true, POST_FULL]);
  f.post.onclick(); assert.equal(f.begun.length, 3, 'switched off, it begins nothing');
  f.ux.render(null);
  assert.deepEqual([f.post.disabled, f.roads.every(button => button.disabled), f.roadHeld.textContent], [true, true, 'Aguarde uma atualização do campo.']);
  // What refuses it once begun is told.
  f.ux.render({ post: '', road: '' }); f.refuse.road = 'Aguarde a resposta do campo.';
  f.roads[0].onclick(); assert.deepEqual(f.toasts, [['Aguarde a resposta do campo.', true]]);
});

test('a road is asked for by the faction with no machine named: its road machines in automatic go to it at the next look', t => {
  const room = rehearsal([-213, 30000], bill(1e9, 1e9, 1e9, 1e9), { fog: false }), f = onField(t, room), player = room.join('Estradeira'),
    grader = f.publish(player, 'grader'), base = room.faction(room.players.get(player.playerId)).base.x;
  f.run(1);
  assert.equal(room.records.get(grader).auto, true, 'a road machine comes on the field in automatic');
  const answer = f.send(player, 'road', { x0: base + 160, x1: base + 230, kind: 'graded' });
  assert.deepEqual(answer, { road: { id: answer.road.id, x0: base + 160, x1: base + 230, kind: 'graded' } });
  f.run(.1);
  assert.deepEqual(room.supplyDispatch.view(grader), { kind: 'grade', phase: 'go', targetId: answer.road.id, reason: '' });
  assert.deepEqual(asked({ type: 'road', actorId: grader, x0: 1, x1: 20, kind: 'graded' }), { type: 'road', x0: 1, x1: 20, kind: 'graded' });
  // A machine out of automatic is sent nowhere by a road asked for.
  f.send(player, 'auto', { actorId: grader, on: false });
  const other = f.send(player, 'road', { x0: base - 400, x1: base - 330, kind: 'graded' });
  f.run(.5);
  assert.notEqual(room.supplyDispatch.jobs.get(grader)?.targetId, other.road.id);
});
