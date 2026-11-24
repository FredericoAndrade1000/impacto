import test from 'node:test';
import assert from 'node:assert/strict';
import { PublicationPlacement } from '../src/publication-placement.ts';
import { constructionBounds, constructionSVG } from '../src/construction-preview.ts';
import { Camera } from '../src/camera.ts';
import { obraQuote } from '../src/faction-ui.ts';
import { bill, billSum, buildSeconds } from '../src/economy.ts';
import { constructionSpan } from '../src/construction-placement.ts';
import { footingBill } from '../src/fixed-footing.ts';
import { count } from '../src/format.ts';
import { Terrain } from '../src/terrain.ts';
import { createStructuredConstruction, compileStructuredConstruction, validateStructuredConstruction } from '../src/structured-construction.ts';
import { MODULES } from '../src/materials.ts';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';
import { unitsOf } from '../src/grid.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; this.svgWrites = 0; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  set innerHTML(value) { this.markup = value; if (value) this.svgWrites++; }
  get innerHTML() { return this.markup; }
  getBoundingClientRect() { throw new Error('Placement must not read DOM layout.'); }
}
const design = () => {
  const source = createStructuredConstruction({ name: 'Defesa <nova>', preset: 'bunker',
    length: 4, height: 2, frontInset: 0, rearInset: 0, thicknessMm: 10, rideHeight: 0 }),
    floor = compileStructuredConstruction(source).plates.find(plate => plate.id === 'hull:floor');
  return validateStructuredConstruction({ ...source, components: [{ id: 'command', kind: 'command', sizeScale: 1,
    pose: { x: unitsOf(13 - VEHICLE_ORIGIN.x),
      y: unitsOf(floor.y + floor.thicknessMm / 2000 + MODULES.command.height / 2 - VEHICLE_ORIGIN.y), angle: 0 } }] });
};
const blueprint = () => compileStructuredConstruction(design());
// The surface read for height, footing and Native site review is one real polyline.
const terrain = ({ minX = 0, maxX = 250000, height = () => 100 } = {}) => {
  const spacing = 50, points = [{ x: minX - spacing, y: Math.fround(height(minX - spacing)) }];
  for (let x = minX; x <= maxX; x += spacing) points.push({ x, y: Math.fround(height(x)) });
  points.push({ x: maxX + spacing, y: Math.fround(height(maxX + spacing)) });
  return Terrain.fromSnapshot({ id: 'flat', seed: 0, length: maxX - minX, center: (minX + maxX) / 2,
    spacing, minX, maxX, material: 'concrete', points,
    sectors: [{ start: minX - spacing, end: maxX + spacing, surface: 'concrete' }] });
};
// A base at 125 km, a faction that sees the whole field, a structure of its own 600 m off the base, a truck of its own
// beside it and a construction of another faction farther on. Each structure costs 80 iron and a little of the rest.
function fixture(t, { facing = 1, shared = true, stock = bill(100, 10, 10, 10), move = null } = {}) {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const host = new Element('div'), camera = new Camera(667, 375),
    faction = { id: 'f1', base: { x: 125000, y: 100, facing: 1, radius: 100 }, bases: [], stock, works: [], counts: { vehicles: 1, fixed: 0 } },
    state = { shared, faction, actors: [{ id: 'post', team: 'f1', x: 125600, vehicle: null }, { id: 'truck', team: 'f1', vehicle: { x: 125650 } },
      { id: 'foe', team: 'f2', x: 125700, vehicle: null }],
      plates: [], modules: [{ actorId: 'post', kind: 'command', x: 125600, y: 101, width: 4, height: 1, angle: 0 },
        { actorId: 'truck', kind: 'engine', x: 125650, y: 101, width: 4, height: 1, angle: 0 },
        { actorId: 'foe', kind: 'engine', x: 125700, y: 101, width: 4, height: 1, angle: 0 }] },
    renderer = { camera, state, ground: terrain(),
      previewConstruction(blueprint, site) { this.preview = blueprint ? { blueprint, site } : null; } },
    source = design(), geometry = compileStructuredConstruction(source),
    calls = { quote: 0, compile: 0, confirm: [], cancel: [], adjust: [], position: [] },
    getQuote = (intent, footing) => { calls.quote++; calls.footing = footing; return obraQuote({ price: bill(80, 2, 1, 2), footing, faction, moving: Boolean(intent.move), value: intent.move ? bill(80, 2, 1, 2) : null }); },
    compile = work => { calls.compile++; return compileStructuredConstruction(work); },
    placement = new PublicationPlacement({ host, renderer, compile, getQuote,
      onConfirm: intent => calls.confirm.push(intent), onPosition: place => calls.position.push(place),
      onCancel: intent => calls.cancel.push(intent), onAdjust: intent => calls.adjust.push(intent) });
  Object.assign(camera, { x: 125300, y: 102, zoom: 32 });
  return { placement, host, renderer, source, geometry, calls, faction, stock, state,
    begin: (x = 125300) => placement.begin({ source, blueprint: geometry, facing, x, move }) };
}
// The line under the orders: what it says, and whether it says what refuses the place or the works.
const line = p => [p.status.textContent, p.status.dataset.problem === 'true'];
const MONTAGE = `montagem ${buildSeconds(bill(80, 2, 1, 2))} s`;

test('placement bounds keep the card view box, including its empty-design box', () => {
  for (const geometry of [blueprint(), { plates: [], modules: [] }]) {
    const box = constructionSVG(geometry).match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
    assert.deepEqual(constructionBounds(geometry), { x: box[0], y: box[1], width: box[2], height: box[3] });
  }
  assert.deepEqual(constructionBounds({ plates: [], modules: [] }), { x: 0, y: 0, width: 300, height: 120 });
});

test('zero is a chosen field coordinate through turning, confirmation and a fresh placement', t => {
  const f = fixture(t), p = f.placement;
  f.faction.base.x = -1000; f.renderer.ground = terrain({ minX: -5000, maxX: 5000 });
  f.begin(0); assert.equal(p.chosen, false);
  assert.equal(p.setX(.04), true); assert.equal(p.intent.x, 0); assert.equal(p.chosen, true);
  assert.equal(p.confirm.disabled, false); assert.equal(p.point(20), false);
  p.turn(); assert.equal(p.chosen, true); assert.equal(p.intent.x, 0);
  assert.equal(p.submit(), true); assert.equal(f.calls.confirm[0].x, 0);
  p.pending = false; p.finish(); assert.equal(p.chosen, false);
  f.begin(0); assert.equal(p.chosen, false); assert.equal(p.confirm.disabled, true);
});

test('the outline of a works follows the pointer, and only a place chosen on the field is confirmed, as it was chosen', t => {
  const f = fixture(t), before = structuredClone(f.source);
  assert.equal(f.placement.active, false); assert.equal(f.begin(), true);
  const p = f.placement;
  assert.equal(p.site.x + 12, 125300, 'it stands about the middle of the view until the player points');
  assert.equal(p.chosen, false); assert.equal(p.confirm.disabled, true); assert.equal(p.confirm.title, 'Escolha primeiro o ponto no campo.');
  assert.deepEqual(line(p), ['Clique no chão para escolher o local · ' + MONTAGE, false], 'before a place is chosen, how to choose one');
  p.confirm.onclick(); assert.equal(p.submit(), false); assert.equal(f.calls.confirm.length, 0, 'where it first stands is never confirmed for the player');
  assert.equal(p.point(125400), true); assert.equal(p.site.x + 12, 125400); assert.equal(p.point(125400.05), false, 'a pointer at rest asks nothing again');
  assert.equal(p.setX(125412.34), true); assert.equal(p.chosen, true); assert.equal(p.confirm.disabled, false);
  assert.deepEqual(f.calls.position.at(-1), { x: 125412.3, facing: 1 });
  assert.equal(p.point(125500), false, 'a place chosen stays where it was chosen'); assert.equal(p.site.x + 12, 125412.3);
  assert.equal(p.confirmLabel.textContent, 'Abrir obra'); assert.equal(p.confirm.title, 'Abrir obra · Enter');
  assert.deepEqual(line(p), ['a 412 m → da base · ' + MONTAGE, false], 'where it stands from the base, and how long it takes');
  p.right.onclick(); assert.equal(p.intent.x, 125413.3); p.left.onclick(); assert.equal(p.intent.x, 125412.3);
  assert.equal(p.submit(), true); assert.equal(p.confirmLabel.textContent, 'Aguardando o campo…');
  assert.deepEqual(f.calls.confirm.map(intent => [intent.x, intent.facing, intent.move, intent.source.name]), [[125412.3, 1, null, 'Defesa <nova>']]);
  assert.deepEqual(f.source, before);
  assert.deepEqual([p.mode.textContent, p.name.textContent], ['NOVA OBRA', 'Defesa <nova>'], 'project names stay literal text');
  // Opening a works costs nothing: each stock it asks of is told by its mark, and what the stocks lack is marked, with how
  // much, and refuses nothing.
  assert.deepEqual(p.chips.map(({ chip, figure }) => [chip.hidden, figure.textContent, chip.className, chip.title]),
    [[false, '80', 'cost-chip', 'Ferro'], [false, '2', 'cost-chip', 'Ligas'], [false, '1', 'cost-chip', 'Sílica'], [false, '2 L', 'cost-chip', 'Combustível']]);
  p.pending = false; f.stock.ferro = 10; p.render();
  assert.deepEqual([p.chips[0].chip.className, p.chips[0].chip.title], ['cost-chip short', 'Ferro: faltam 70 no estoque']);
  assert.equal(p.confirm.disabled, false); assert.deepEqual(line(p), ['a 412 m → da base · ' + MONTAGE, false]);
  assert.equal(p.setX(NaN), false);
});

test('a place is refused by the rules of the field as the page knows them, in words and on the outline', t => {
  const f = fixture(t); f.begin();
  const p = f.placement, refusal = x => { p.setX(x); const [words, problem] = line(p); return problem ? words : ''; };
  assert.equal(refusal(125100), 'Perto demais da base: no mínimo 150 m.');
  assert.equal(p.element.dataset.refused, 'true'); assert.equal(p.confirm.disabled, true);
  assert.equal(p.confirm.title, 'Perto demais da base: no mínimo 150 m.', 'the refused button says why');
  const span = constructionSpan(f.geometry, { x: 125200, facing: 1 }), clear = 125000 + 150 + (125200 - span.minX);
  assert.equal(refusal(clear - .2), 'Perto demais da base: no mínimo 150 m.'); assert.equal(refusal(clear + .2), '');
  assert.equal(p.element.dataset.refused, 'false');
  // The structures of the faction are kept clear of; its vehicles, which move off, and what is of another are not.
  assert.equal(refusal(125601), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  assert.equal(refusal(125651), ''); assert.equal(refusal(125701), '');
  f.faction.works = [{ id: 'c9', blueprint: f.source, x: 125800, facing: 1 }];
  assert.equal(refusal(125801), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  p.render(); assert.equal(f.calls.compile, 1, 'a works is compiled once for its stretch');
  // And so is the ground of each post of the faction, and of the works of each, which is of no project.
  f.faction.works = [{ id: 'c8', post: true, x: 127200, facing: 1 }]; f.faction.posts = [{ id: 'p0', x: 128200 }];
  assert.equal(refusal(127245), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  assert.equal(refusal(128150), 'Não há espaço aí: afaste das estruturas e obras vizinhas.');
  assert.equal(refusal(127700), ''); f.faction.works = []; f.faction.posts = [];
  // Within the territory of the faction, and in no other it is told of (territory.ts).
  assert.equal(refusal(130001), 'Fora do território da sua facção.');
  f.faction.posts = [{ id: 'p1', x: 131500 }]; p.render();
  assert.equal(line(p)[1], false, 'a post of the faction widens it');
  f.faction.territory = [{ kind: 'other', color: '#fff', spans: [[125850, 126500]] }];
  assert.equal(refusal(125900), 'No território de outra facção.');
  f.faction.territory = []; f.faction.posts = []; p.render(); assert.deepEqual(line(p), ['a 900 m → da base · ' + MONTAGE, false]);
  f.renderer.ground = terrain({ height: x => x > 126000 ? 100 + (x - 126000) * Math.tan(31 * Math.PI / 180) : 100 });
  assert.equal(refusal(126005), 'Encosta íngreme demais: no máximo 30°.');
  assert.deepEqual(f.calls.footing, bill(), 'a place refused is quoted with no footing');
  assert.equal(refusal(249995), 'A estrutura passa do limite do campo.');
});

test('over a slope the works is quoted with the footing of where it stands, said by one word, and a structure moved there shows that alone', t => {
  const f = fixture(t), rise = Math.tan(20 * Math.PI / 180), hill = x => 100 + Math.max(0, x - 125350) * rise;
  f.renderer.ground = terrain({ height: hill }); f.begin();
  const p = f.placement, footing = footingBill(f.geometry, f.renderer.ground, { x: 125400, facing: 1 }), price = billSum(bill(80, 2, 1, 2), footing);
  assert(footing.silica > 0); assert.deepEqual([footing.ferro, footing.ligas, footing.combustivel], [0, 0, 0]);
  p.point(125400);
  assert.deepEqual(f.calls.footing, footing, 'the outline pointed at is quoted where it stands');
  assert.deepEqual(line(p), [`Clique no chão para escolher o local · fundação · montagem ${buildSeconds(price)} s`, false]);
  p.setX(125400);
  assert.deepEqual(line(p), [`a 400 m → da base · fundação · montagem ${buildSeconds(price)} s`, false]);
  assert.deepEqual(p.chips.map(({ figure }) => figure.textContent), ['80', '2', count(1 + footing.silica), '2 L']);
  // Short of the Sílica of the footing, the stock is marked as short of it, and nothing is refused.
  f.stock.silica = 1; p.render();
  assert.deepEqual([p.chips[2].chip.className, p.confirm.disabled], ['cost-chip short', false]);
  // On level ground there is no footing to pay for, nor a word of it.
  p.setX(125300); assert.deepEqual(f.calls.footing, bill()); assert.deepEqual(line(p), ['a 300 m → da base · ' + MONTAGE, false]);
  p.finish();
  // A structure moved over the slope is told the footing it pays for there, and no more.
  const moved = fixture(t, { move: 'tower' });
  moved.state.actors.push({ id: 'tower', team: 'f1', x: 125400 });
  moved.state.modules.push({ actorId: 'tower', kind: 'command', x: 125400, y: 101, width: 2, height: 2, angle: 0 });
  moved.renderer.ground = terrain({ height: hill }); moved.begin(125400);
  const q = moved.placement; q.setX(125400);
  assert.equal(q.costs.hidden, false);
  assert.deepEqual(q.chips.map(({ chip, figure }) => [chip.hidden, figure.textContent]), [[true, ''], [true, ''], [false, count(footing.silica)], [true, '']]);
  assert.deepEqual(line(q), ['a 400 m → da base · fundação', false]);
});

test('ground the faction never saw is refused without reading it, and the outline is not shown over it', t => {
  const f = fixture(t, { facing: -1 });
  f.faction.explored = [[125250, 125350]];
  let reads = 0;
  const height = f.renderer.ground.height.bind(f.renderer.ground);
  f.renderer.ground.height = x => { reads++; return height(x); };
  f.begin(125500);
  const p = f.placement;
  assert.equal(reads, 0, 'the relief of unknown ground is not told by the outline');
  assert.equal(p.site, null); assert.equal(p.ghost.hidden, true);
  assert.deepEqual(line(p), ['Terreno desconhecido: escolha chão já visto.', true], 'what refuses the place pointed at is told before it is chosen');
  p.setX(125500); assert.equal(p.confirm.disabled, true); assert.equal(reads, 0);
  p.setX(125300); assert(reads > 0); assert(p.site); assert.equal(p.ghost.hidden, false); assert.equal(p.confirm.disabled, false);
  assert.equal(f.calls.confirm.length, 0, 'a place seen constructs nothing by itself');
});

test('a structure turned faces the other way, and camera follow keeps its border at metre scale without quotes or layout reads', t => {
  const f = fixture(t); f.begin();
  const p = f.placement; p.setX(125400);
  const quotes = f.calls.quote, width = parseFloat(p.ghost.style.width);
  assert(Math.abs(width - p.box.width * f.renderer.camera.zoom) < 1e-6); assert.equal(p.ghost.dataset.mirror, 'true');
  for (let frame = 0; frame < 120; frame++) { f.renderer.camera.x += .01; p.follow(); }
  assert.equal(f.calls.quote, quotes); assert.equal(p.ghost.svgWrites, 0);
  f.renderer.camera.zoom *= 2; p.follow(); assert(Math.abs(parseFloat(p.ghost.style.width) - width * 2) < 1e-6);
  p.turnButton.onclick();
  assert.equal(p.intent.facing, -1); assert.equal(p.ghost.dataset.mirror, 'false'); assert.equal(p.ghost.svgWrites, 0);
  assert.equal(f.renderer.preview.blueprint, f.geometry); assert.equal(f.renderer.preview.site, p.site);
  assert.equal(f.renderer.preview.site.mirror, false);
  assert.deepEqual(f.calls.position.at(-1), { x: 125400, facing: -1 });
});

test('private or missing field state never supplies a placement ghost or an enabled confirmation', t => {
  const f = fixture(t, { shared: false }); f.begin();
  const p = f.placement;
  assert.equal(p.ghost.hidden, true); assert.equal(p.confirm.disabled, true); assert.equal(p.setX(125400), false);
  assert.deepEqual(line(p), ['Aguarde uma atualização do campo.', true]);
  f.renderer.state.shared = true; p.render(); p.follow(); assert.equal(p.ghost.hidden, false);
  assert.equal(p.setX(125400), true); assert.equal(p.confirm.disabled, false);
});

test('what refuses the works itself comes from the quote, and a structure moved keeps its count and shows no bill', t => {
  const f = fixture(t); f.faction.counts = { vehicles: 1, fixed: 32 }; f.begin();
  const p = f.placement; p.setX(125400);
  assert.equal(p.confirm.disabled, true); assert.deepEqual(line(p), ['Limite: 32 estruturas por facção.', true]);
  p.finish();
  const moved = fixture(t, { move: 'tower' }); moved.faction.counts = { vehicles: 1, fixed: 32 };
  moved.state.actors.push({ id: 'tower', team: 'f1', x: 125400 });
  moved.state.modules.push({ actorId: 'tower', kind: 'command', x: 125400, y: 101, width: 2, height: 2, angle: 0 });
  moved.begin(125400);
  const q = moved.placement; q.setX(125400);
  assert.equal(q.confirm.disabled, false, 'a structure moved is out of its own way and counts once');
  assert.equal(q.confirmLabel.textContent, 'Mudar para cá'); assert.deepEqual([q.mode.textContent, q.name.textContent], ['MUDAR DE LUGAR', 'Defesa <nova>']);
  assert.deepEqual([p.confirmMark.dataset.icon, q.confirmMark.dataset.icon], ['i-build', 'i-flag'], 'a structure moved is sent, as a vehicle is');
  assert.equal(q.costs.hidden, true); assert.equal(q.adjust.hidden, true);
  assert.deepEqual(line(q), ['a 400 m → da base', false], 'a structure moved is told where it goes, with no bill nor montage');
  q.confirm.onclick(); assert.equal(moved.calls.confirm[0].move, 'tower');
});

test('one pending confirmation freezes its exact intent and cannot duplicate, move or cancel it', t => {
  const f = fixture(t); f.begin();
  const p = f.placement; p.setX(125400); p.confirm.onclick(); p.confirm.onclick();
  assert.equal(f.calls.confirm.length, 1); assert.equal(p.pending, true); assert.equal(p.confirm.disabled, true);
  assert.equal(p.cancel(), false); assert.equal(p.setX(125415), false); assert.equal(f.begin(), false); assert.equal(p.turn(), false);
  assert.equal(p.adjust.disabled, true); assert.equal(p.back.disabled, true);
  p.pending = false; assert.equal(p.confirm.disabled, false);
  p.confirm.onclick(); assert.equal(f.calls.confirm.length, 2, 'the caller can explicitly retry the same unchanged works');
  assert.deepEqual(f.calls.confirm[0], f.calls.confirm[1]);
  p.finish(); assert.equal(p.active, false); assert.equal(p.intent, null); assert.equal(p.element.hidden, true); assert.equal(p.ghost.innerHTML, '');
  assert.equal(f.calls.cancel.length, 0);
});

test('cancel and adjust clear the preview and call only their own UI callback', t => {
  const f = fixture(t); f.begin(); const p = f.placement;
  f.source.name = 'Mudou depois de iniciar'; assert.equal(p.intent.source.name, 'Defesa <nova>');
  assert.equal(p.cancel(), true); assert.equal(f.calls.cancel.length, 1); assert.equal(f.calls.adjust.length, 0); assert.equal(p.active, false);
  assert.equal(f.renderer.preview, null);
  f.begin(); assert.equal(p.cancel({ adjust: true }), true); assert.equal(f.calls.adjust.length, 1); assert.equal(f.calls.cancel.length, 1);
  assert.equal(f.renderer.preview, null);
  assert.equal(f.calls.confirm.length, 0); assert.equal(p.cancel(), false);
});

test('a refusal of the field stays in view until another place is chosen or another preview begins', t => {
  const f = fixture(t); f.begin();
  const p = f.placement; p.setX(125400); p.confirm.onclick();
  assert.equal(p.reject('Encosta íngreme demais: no máximo 30°.'), true);
  assert.equal(p.pending, false); assert.equal(p.active, true); assert.deepEqual(line(p), ['Encosta íngreme demais: no máximo 30°.', true]);
  p.render(); p.follow(); assert.match(p.status.textContent, /íngreme/);
  assert.equal(p.confirm.disabled, false, 'the field can be asked again after it changes');
  p.setX(125400); assert.match(p.status.textContent, /íngreme/);
  p.setX(125401); assert.deepEqual(line(p), ['a 401 m → da base · ' + MONTAGE, false]);
  p.reject(new Error('Não há espaço aí.')); assert.deepEqual(line(p), ['Não há espaço aí.', true]);
  f.begin(); assert.equal(line(p)[1], false); p.finish(); assert.equal(p.reject('Antiga'), false);
});
