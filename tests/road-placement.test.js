import test from 'node:test';
import assert from 'node:assert/strict';
import { RoadPlacement } from '../src/road-placement.ts';
import { normalRoads } from '../src/roads.ts';
import { ROAD_FOLD, roadKnown } from '../src/road-site.ts';
import { bridged } from '../src/ground-sight.ts';
import { MIST_EDGE, mistBands, rampLevel } from '../src/ground-mist.ts';

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.attributes = {}; this.hidden = false; this.textContent = ''; }
  append(...children) { this.children.push(...children); }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  set innerHTML(value) { this.markup = value; }
  get innerHTML() { return this.markup; }
  getBoundingClientRect() { throw new Error('Placement must not read DOM layout.'); }
}
// A base at 125 km on a field 250 km long, a faction that has seen from 124 km to 126 km, with a road of its own asked for
// from 125 200 m to 125 300 m, a stretch of asphalt laid by the base, and one of graded earth on ground it never saw. A view
// two pixels to the metre, or none.
function fixture(t, { shared = true, explored = [[124000, 126000]], zoom = null } = {}) {
  const previous = globalThis.document; globalThis.document = { createElement: tag => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const host = new Element('div'),
    faction = { id: 'f1', base: { x: 125000 }, explored, roadworks: [{ id: 'r1', x0: 125200, x1: 125300, kind: 'graded', graded: 0, paved: 0, working: [], coming: false }] },
    renderer = { state: { shared, faction }, ...(zoom ? { camera: { zoom } } : {}),
      ground: { height: () => 100, minX: 0, maxX: 250000, roads: normalRoads([{ x0: 124900, x1: 125100, kind: 'asphalt' }, { x0: 126050, x1: 126080, kind: 'graded' }]) },
      previewRoad(stretch) { this.preview = stretch; } },
    calls = { confirm: [], cancel: [] },
    placement = new RoadPlacement({ host, renderer, onConfirm: intent => calls.confirm.push(intent), onCancel: current => calls.cancel.push(current) });
  return { placement, renderer, faction, calls };
}
// The line under the orders: what it says, and whether it says what refuses the stretch.
const line = p => [p.status.textContent, p.status.dataset.problem === 'true'];

test('a road is asked for over the stretch between two clicks, the second end following the pointer, and a third click moves the end nearer it', t => {
  const f = fixture(t), p = f.placement;
  assert.equal(p.begin({ kind: 'asphalt' }), true);
  assert.equal(p.begin({ kind: 'graded' }), false, 'one at a time');
  assert.deepEqual([p.mode.textContent, p.name.textContent, p.confirm.disabled], ['NOVA ESTRADA', 'Asfalto', true]);
  assert.deepEqual(line(p), ['Clique no início do trecho', false]); assert.equal(f.renderer.preview, null, 'nothing is drawn before the pointer is over the field');
  assert.equal(p.point(125400), true);
  assert.deepEqual(f.renderer.preview, { x0: 125400, x1: 125400, refused: false, spans: [], over: [[125400, 125400]], unknown: [] },
    'the stake of the first end goes with the pointer');
  assert.equal(p.setX(125400.04), true); assert.equal(p.chosen, false);
  assert.deepEqual(line(p), ['Clique no fim do trecho', false]);
  // Short while the other end is still to come, the stretch is not refused for it.
  p.point(125405); assert.deepEqual(line(p), ['Clique no fim do trecho · 5 m', false]); assert.equal(f.renderer.preview.refused, false);
  p.point(125350); assert.deepEqual(f.renderer.preview, { x0: 125350, x1: 125400, refused: false, spans: [[125350, 125400]], over: [], unknown: [] });
  assert.equal(p.setX(125350), true); assert.equal(p.chosen, true); assert.equal(p.confirm.disabled, false);
  assert.deepEqual(line(p), ['50 m · a 375 m → da base', false]);
  assert.equal(p.point(125500), false, 'a stretch chosen stays as it was chosen');
  // A click after both moves the end nearer it.
  p.setX(125420); assert.deepEqual(p.intent, { kind: 'asphalt', x0: 125350, x1: 125420 });
  p.setX(125330.06); assert.deepEqual(p.intent, { kind: 'asphalt', x0: 125330.1, x1: 125420 });
  assert.deepEqual(line(p), ['89,9 m · a 375 m → da base', false], 'the placement label retains the same tenth of a metre as the submitted span');
  assert.equal(p.submit(), true); assert.equal(p.confirmLabel.textContent, 'Aguardando o campo…'); assert.equal(p.confirm.disabled, true);
  assert.deepEqual(f.calls.confirm, [{ kind: 'asphalt', x0: 125330.1, x1: 125420 }]);
  assert.equal(p.submit(), false, 'asked once, until the field answers'); assert.equal(p.cancel(), false);
  // Refused by the field, it says why, and the stretch may be asked again.
  assert.equal(p.reject(new Error('Esta máquina está fora de combate.')), true);
  assert.deepEqual(line(p), ['Esta máquina está fora de combate.', true]); assert.equal(p.confirm.disabled, false);
  p.finish(); assert.deepEqual([p.active, p.element.hidden, f.renderer.preview], [false, true, null]);
});

test('the stretch is refused as the field would refuse it, and drawn over the ground the faction never saw apart', t => {
  const f = fixture(t), p = f.placement, choose = (a, b) => { p.finish(); p.begin({ kind: 'graded' }); p.setX(a); p.setX(b); };
  choose(125400, 125405); assert.deepEqual(line(p), ['Trecho curto demais: no mínimo 10 m.', true]); assert.equal(p.confirm.disabled, true);
  assert.equal(f.renderer.preview.refused, true);
  choose(125400, 135500); assert.deepEqual(line(p), ['Trecho longo demais: no máximo 10 km.', true]);
  choose(125900, 126100); assert.deepEqual(line(p), ['Terreno desconhecido: escolha chão já visto.', true]);
  // What the road would make is read of the ground the faction saw alone; the rest is drawn as unseen, and only that it is.
  assert.deepEqual([f.renderer.preview.spans, f.renderer.preview.over, f.renderer.preview.unknown], [[[125900, 126000]], [], [[126000, 126100]]],
    'unseen ground is drawn apart, the road it lies under not read: its relief would be told');
  choose(125220, 125280); assert.deepEqual(line(p), ['Já há uma estrada pedida nesse trecho.', true]);
  assert.deepEqual([f.renderer.preview.spans, f.renderer.preview.over], [[], [[125220, 125280]]]);
  choose(124950, 125050); assert.deepEqual(line(p), ['Esse trecho já tem estrada.', true]);
  choose(10, 30); assert.deepEqual(line(p), ['O trecho passa do limite do campo.', true]);
  // An end chosen on ground never seen is refused for it as soon as the stretch is long enough to be one.
  p.finish(); p.begin({ kind: 'graded' }); p.setX(126100); p.point(126105);
  assert.deepEqual([line(p), f.renderer.preview.spans], [['Clique no fim do trecho · 5 m', false], []]);
  p.point(126150); assert.deepEqual(line(p), ['Terreno desconhecido: escolha chão já visto.', true]);
  // Called off, the placement goes and says what it was.
  assert.equal(p.cancel(), true); assert.deepEqual(f.calls.cancel, [{ kind: 'graded', x0: 126100, x1: null }]);
  assert.equal(f.renderer.preview, null);
});

test('a stretch from one road to another, over both, is the ground between them: it says how much of it is made, and draws that apart', t => {
  const f = fixture(t), p = f.placement;
  // From the asphalt by the base to the road asked for after it: the hundred metres between them are graded.
  p.begin({ kind: 'graded' }); p.setX(125050); p.setX(125250);
  assert.deepEqual(line(p), ['200 m · 100 m a fazer · a 150 m → da base', false]); assert.equal(p.confirm.disabled, false);
  assert.deepEqual(f.renderer.preview, { x0: 125050, x1: 125250, refused: false, spans: [[125100, 125200]], over: [[125050, 125100], [125200, 125250]], unknown: [] });
  // The field is asked for the stretch as chosen: it takes of it what is made.
  p.submit(); assert.deepEqual(f.calls.confirm, [{ kind: 'graded', x0: 125050, x1: 125250 }]);
  // Of asphalt, over the road asked for as graded earth: that one grades it, and this one paves it.
  p.finish(); p.begin({ kind: 'asphalt' }); p.setX(125250); p.setX(125350);
  assert.deepEqual([line(p), f.renderer.preview.spans], [['100 m · a 300 m → da base', false], [[125250, 125350]]]);
  // Of asphalt, over the asphalt by the base and on: what the asphalt is not.
  p.finish(); p.begin({ kind: 'asphalt' }); p.setX(125000); p.setX(125150);
  assert.deepEqual([line(p), f.renderer.preview.spans, f.renderer.preview.over], [['150 m · 50 m a fazer · a 75 m → da base', false], [[125100, 125150]], [[125000, 125100]]]);
});

test('an end chosen by the end of a road, made or asked for, is chosen at that end, on the road; one on ground never seen is not', t => {
  // Two pixels to the metre: an end within six metres of the end of a road is at that end.
  const f = fixture(t, { zoom: 2 }), p = f.placement;
  p.begin({ kind: 'graded' });
  assert.equal(p.point(125104), true); assert.deepEqual([f.renderer.preview.x0, f.renderer.preview.x1], [125100, 125100], 'the pointer goes to the end of the asphalt');
  assert.equal(p.point(125105), false, 'and stays there while it is by it');
  p.setX(125104); p.point(125195); p.setX(125195);
  assert.deepEqual(p.intent, { kind: 'graded', x0: 125100, x1: 125200 }, 'from the end of the asphalt to the start of the road asked for');
  assert.deepEqual([line(p), f.renderer.preview.spans, f.renderer.preview.over], [['100 m · a 150 m → da base', false], [[125100, 125200]], []]);
  // Further than that, or by the end of a road on ground the faction never saw, an end is where it is chosen.
  p.setX(125310); assert.equal(p.intent.x1, 125310);
  p.finish(); p.begin({ kind: 'graded' }); p.point(126052); assert.equal(f.renderer.preview.x0, 126052);
  // An end of a road a hair off the tenth of a metre the field asks for is chosen on the road, that nothing is left between.
  f.renderer.ground.roads = normalRoads([{ x0: 124900, x1: 125100.04, kind: 'asphalt' }, { x0: 125599.96, x1: 125700, kind: 'graded' }]);
  p.finish(); p.begin({ kind: 'graded' }); p.setX(125102); p.setX(125597);
  assert.deepEqual([p.intent.x0, p.intent.x1], [125100, 125600]);
  assert.deepEqual(f.renderer.preview.spans, [[125100.04, 125200], [125300, 125599.96]]);
});

test('the ground a faction knows for a road is what it explored with the folds between closed, as narrow as the mist hardly shows over', () => {
  const spans = [[0, 100], [140, 300], [341, 500]], before = JSON.stringify(spans);
  assert.deepEqual(bridged(spans, 40), [[0, 300], [341, 500]]); assert.equal(JSON.stringify(spans), before, 'a new list');
  assert.deepEqual(roadKnown(spans), bridged(spans, ROAD_FOLD));
  // Over a fold that wide the bank of mist comes to a third of its ramp at the most, and shows at about a quarter of its strength.
  const bands = mistBands({ left: 0, right: 500 }, [[-1000, 200], [200 + ROAD_FOLD, 1000]], MIST_EDGE), top = Math.max(...bands.map(band => Math.max(band.a, band.b)));
  assert(Math.abs(top - ROAD_FOLD / 2 / MIST_EDGE) < 1e-9 && rampLevel(top) < .26, `${top} → ${rampLevel(top)}`);
});

test('a fold of ground no eye caught between ground the faction explored is known for a road, as narrow as the mist shows no bank over', t => {
  const f = fixture(t), p = f.placement, fold = width => {
    f.faction.explored = [[124000, 125500], [125500 + width, 126000]];
    p.finish(); p.begin({ kind: 'graded' }); p.setX(125480); p.setX(125580);
  };
  // Forty metres: the mist over it is a quarter of its strength at most, and the road goes over it.
  fold(40); assert.deepEqual([line(p), f.renderer.preview.spans, f.renderer.preview.unknown], [['100 m · a 530 m → da base', false], [[125480, 125580]], []]);
  // Sixty: the bank stands over it, and the road is refused there, the stretch it would not know drawn apart.
  fold(60); assert.deepEqual([line(p), f.renderer.preview.spans, f.renderer.preview.unknown],
    [['Terreno desconhecido: escolha chão já visto.', true], [[125480, 125500], [125560, 125580]], [[125500, 125560]]]);
});

test('a field without fog is known whole, and one not yet told keeps the stretch from being chosen', t => {
  const f = fixture(t, { explored: null }), p = f.placement;
  p.begin({ kind: 'asphalt' }); p.setX(130000); p.setX(130200);
  assert.deepEqual([line(p), f.renderer.preview.spans], [['200 m · a 5,1 km → da base', false], [[130000, 130200]]]);
  f.renderer.state.shared = false; p.render();
  assert.deepEqual(line(p), ['Aguarde uma atualização do campo.', true]); assert.equal(p.confirm.disabled, true);
  assert.equal(p.setX(130300), false);
});
