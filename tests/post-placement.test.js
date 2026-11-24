import test from 'node:test';
import assert from 'node:assert/strict';
import { PostPlacement } from '../src/post-placement.ts';
import { Camera } from '../src/camera.ts';
import { postQuote } from '../src/faction-ui.ts';
import { bill, buildSeconds, LOAD_REACH, UNBASED } from '../src/economy.ts';
import { depositsOf } from '../src/deposits.ts';
import { POST_BILL, POST_RADIUS } from '../src/territory.ts';
import { Terrain } from '../src/terrain.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  set innerHTML(value) { this.markup = value; }
  get innerHTML() { return this.markup; }
  getBoundingClientRect() { throw new Error('Placement must not read DOM layout.'); }
}
// Level ground from 0 to 250 km, as one real polyline.
const terrain = () => {
  const spacing = 50, points = [];
  for (let x = -spacing; x <= 250000 + spacing; x += spacing) points.push({ x, y: 100 });
  return Terrain.fromSnapshot({ id: 'flat', seed: 0, length: 250000, center: 125000, spacing, minX: 0, maxX: 250000, material: 'concrete', points,
    sectors: [{ start: -spacing, end: 250000 + spacing, surface: 'concrete' }] });
};
// A base at 125 km, a faction that sees the whole field, a structure of its own 600 m off the base, a truck of its own
// beside it and a construction of another faction farther on; and the place of a post being chosen there.
function fixture(t, { stock = bill(1e6, 1e6, 1e6, 1e6), instant = false } = {}) {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const host = new Element('div'), camera = new Camera(667, 375),
    faction = { id: 'f1', base: { x: 125000, y: 100, facing: 1, radius: 100 }, bases: [], stock, works: [], posts: [] },
    state = { shared: true, faction, actors: [{ id: 'guard', team: 'f1', x: 125600, vehicle: null }, { id: 'truck', team: 'f1', vehicle: { x: 125650 } }],
      plates: [], modules: [{ actorId: 'guard', kind: 'command', x: 125600, y: 101, width: 4, height: 1, angle: 0 },
        { actorId: 'truck', kind: 'engine', x: 125650, y: 101, width: 4, height: 1, angle: 0 }] },
    renderer = { camera, state, ground: terrain(), previewPost(post) { this.post = post; } },
    calls = { confirm: [], cancel: 0 },
    placement = new PostPlacement({ host, renderer, compile: compileStructuredConstruction,
      getQuote: () => postQuote({ faction, connected: true, instant }), onConfirm: intent => calls.confirm.push(intent), onCancel: () => calls.cancel++ });
  return { placement, renderer, faction, calls };
}
const line = p => [p.status.textContent, p.status.dataset.problem === 'true'];
const refusing = p => x => { p.setX(x); p.render(); const [words, problem] = line(p); return problem ? words : ''; };

test('the place of a post follows the pointer as a post not begun, says what it costs and how long it takes, and is asked of the field as it stands and faces', t => {
  const f = fixture(t), p = f.placement;
  assert.equal(p.begin({ x: 127000 }), true); assert.equal(p.begin({ x: 1 }), false, 'one at a time');
  assert.deepEqual(line(p), [`Clique no chão para escolher o local · montagem ${buildSeconds(POST_BILL)} s`, false]);
  assert.deepEqual(f.renderer.post, { x: 127000, facing: 1, refused: false }, 'drawn where the pointer is');
  assert.deepEqual(p.chips.filter(chip => !chip.chip.hidden).map(chip => [chip.id, chip.figure.textContent]), [['ferro', '22.500'], ['ligas', '2.500'], ['silica', '2.500']]);
  assert.equal(p.confirm.disabled, true, 'no place chosen yet');
  p.point(127100); assert.equal(f.renderer.post.x, 127100);
  p.setX(127000.04); p.turn(); p.nudge(1);
  assert.deepEqual([p.intent, line(p)], [{ x: 127001, facing: -1 }, ['a 2.001 m → da base · montagem 60 s', false]]);
  p.point(130000); assert.equal(f.renderer.post.x, 127001, 'chosen, it stays where it was put');
  assert.equal(p.submit(), true); assert.deepEqual(f.calls.confirm, [{ x: 127001, facing: -1 }]);
  assert.equal(p.pending, true); assert.equal(p.cancel(), false, 'nor called off while the field is asked');
  p.reject('Sua facção já tem 4 postos.'); assert.deepEqual(line(p), ['Sua facção já tem 4 postos.', true]);
  assert.equal(p.cancel(), true); assert.equal(f.calls.cancel, 1);
  assert.deepEqual([p.active, f.renderer.post], [false, null]);
  // Short of what it costs, only a post raised at once is refused for it; with no base, none is.
  const short = fixture(t, { stock: bill(100, 10, 10, 10), instant: true }).placement;
  short.begin({ x: 127000 }); short.setX(127000);
  assert.match(line(short)[0], /^Faltam Ferro e Ligas e Sílica para erguer o posto/); assert.equal(short.confirm.disabled, true);
  assert.equal(postQuote({ faction: { stock: bill(), base: null }, connected: true }).refused, UNBASED, 'the Infraestrutura page does not begin it');
  assert.equal(postQuote({ faction: null, connected: true }).refused, 'Aguarde a conexão com o campo.');
});

test('a post is placed by the rules of a post as the page knows them: 4 at most, 1.5 km off the base and its other posts, its ground in the territory and clear of what keeps ground', t => {
  const f = fixture(t), p = f.placement, refusal = refusing(p);
  p.begin({ x: 125300 });
  assert.equal(refusal(126000), 'Perto demais da base ou de outro posto: no mínimo 1,5 km.');
  assert.equal(refusal(127000), '');
  assert.equal(refusal(129990), 'Fora do território da sua facção.', 'its whole ground in the territory');
  f.faction.posts = [{ id: 'p1', x: 128400 }];
  assert.equal(refusal(127000), 'Perto demais da base ou de outro posto: no mínimo 1,5 km.');
  assert.equal(refusal(129950), '', 'at the edge of the territory the post widens');
  // The works of a post count as one, and a faction has 4 at most: the place does not matter then.
  f.faction.posts.push({ id: 'p2', x: 122000 }, { id: 'p3', x: 120400 });
  f.faction.works = [{ id: 'c9', post: true, x: 131900, facing: 1 }];
  assert.equal(refusal(127001), 'Sua facção já tem 4 postos.');
  // One being taken down is a post no longer: out of the count and of the spacing, though its ground is kept.
  f.faction.posts[0].takedown = { progress: .2, seconds: 60 };
  assert.equal(refusal(127001), '');
  assert.equal(refusal(128420), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  f.faction.posts = []; f.faction.works = [];
  // A structure of the faction keeps its ground; its vehicles do not.
  assert.equal(refusal(125640), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  f.renderer.state.actors = f.renderer.state.actors.filter(actor => actor.id !== 'guard');
  assert.equal(refusal(125640), 'Perto demais da base ou de outro posto: no mínimo 1,5 km.');
  f.faction.territory = [{ kind: 'other', color: '#fff', spans: [[126900, 127500]] }];
  assert.equal(refusal(127100), 'No território de outra facção.');
});

test('a post keeps off every site of the ground, known to the faction or not: each holds a vein', t => {
  const f = fixture(t), p = f.placement, refusal = refusing(p),
    ground = Object.assign(f.renderer.ground, { features: [{ kind: 'outcrop', peak: 128000 }] }),
    site = depositsOf(ground)[0], x = site.x + POST_RADIUS + LOAD_REACH - 10;
  assert.equal(site.x, 128000);
  p.begin({ x });
  assert.equal(refusal(x), 'Perto demais de uma jazida: o posto descarregaria onde os caminhões carregam.', 'the page finds the site as the field does');
  assert.equal(refusal(x + 20), '');
});
