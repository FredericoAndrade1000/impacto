import test from 'node:test';
import assert from 'node:assert/strict';
import { Terrain } from '../src/terrain.ts';
import { Graphics } from 'pixi.js';
import { drawScorches, scorchBand, scorchOutlines, ScorchMarks } from '../src/ground-scorch.ts';
import { Effects } from '../src/effects.ts';

const pairs = flat => Array.from({ length: flat.length / 2 }, (_, i) => ({ x: flat[i * 2], y: flat[i * 2 + 1] }));
// The outline runs left to right along the surface, then right to left beneath it.
const edges = flat => { const points = pairs(flat), half = points.length / 2; return { top: points.slice(0, half), bottom: points.slice(half).reverse() }; };

test('a burn mark lies along a slope instead of crossing it as a level ellipse', () => {
  for (const [id, x] of [['hills', 37], ['wet-valley', -121], ['rural-ridges', 12], ['flat', 10]]) {
    const terrain = new Terrain(id), scorch = { x, width: 2.8, depth: .12, strength: .5 }, { top, bottom } = edges(scorchBand(terrain, scorch));
    assert.equal(top.length, bottom.length); assert(top.length >= 21);
    assert(Math.abs(top[0].x - (x - 2.8)) < 1e-9 && Math.abs(top.at(-1).x - (x + 2.8)) < 1e-9);
    for (const [i, point] of top.entries()) {
      const ground = terrain.height(point.x), below = bottom[i];
      assert(point.y >= ground - 1e-9 && point.y <= ground + .0141, id + ': the upper edge stays on the surface');
      assert.equal(below.x, point.x); assert(below.y <= ground + 1e-9 && below.y >= ground - .1201, id + ': the burnt layer stays just beneath it');
      if (i) assert(point.x > top[i - 1].x);
    }
    assert(top[0].y - bottom[0].y < 1e-9 && top.at(-1).y - bottom.at(-1).y < 1e-9, 'both ends taper to nothing');
    const middle = Math.floor(top.length / 2);
    assert(top[middle].y - bottom[middle].y > .08, 'the mark is thickest under the burst');
    if (id === 'hills') assert(Math.abs(top[0].y - top.at(-1).y) > .05, 'the test ground really slopes across the mark');
  }
});

test('the mark bends over every vertex of the contour, including a narrow ridge', () => {
  const points = [{ x: -10, y: 0 }, { x: -1, y: 0 }, { x: -.05, y: 1.5 }, { x: 0, y: 2 }, { x: .05, y: 1.5 }, { x: 1, y: 0 }, { x: 10, y: 0 }],
    terrain = { points, height(x) {
      const i = Math.max(1, points.findIndex(p => p.x >= x)), a = points[i - 1], b = points[i];
      return a.y + (x - a.x) * (b.y - a.y) / (b.x - a.x);
    } }, { top } = edges(scorchBand(terrain, { x: .3, width: 2, depth: .1 }));
  for (const x of [-1, -.05, 0, .05, 1]) assert(top.some(p => p.x === x), 'vertex ' + x + ' belongs to the outline');
  assert(top.find(p => p.x === 0).y >= 2, 'a chord between two samples cannot cut through the ridge');
});

test('outlines are traced once per terrain and drawn as soot with a darker core', () => {
  const terrain = new Terrain('hills'), scorch = { x: 37, width: 2, depth: .1, strength: .5 }, first = scorchOutlines(terrain, scorch);
  assert.equal(scorchOutlines(terrain, scorch), first, 'a resting mark is not traced again every frame');
  const core = edges(first.core), soot = edges(first.soot);
  assert(core.top[0].x > soot.top[0].x && core.top.at(-1).x < soot.top.at(-1).x);
  const other = new Terrain('rural-ridges'); assert.notEqual(scorchOutlines(other, scorch), first, 'a new map lays the mark on its own ground');
  const calls = [], graphics = { poly(points) { calls.push({ points }); return this; }, fill(style) { calls.at(-1).style = style; return this; } };
  drawScorches(graphics, terrain, [scorch, { x: 40, width: 0, strength: .5 }]);
  assert.equal(calls.length, 2, 'a mark without width draws nothing');
  assert(calls[0].style.alpha < calls[1].style.alpha && calls[1].style.alpha <= .5);
  drawScorches(graphics, null, [scorch]); assert.equal(calls.length, 2);
});

// A long battle: round after round, bursts all over forty kilometres of a field, and now and then one on the stretch the
// view holds. The field keeps the last forty marks wherever they are (effects.ts `scorch`); the drawing of them holds only
// those the view shows, and is drawn again only on a frame when one comes into the view or leaves it. Held still, a frame
// costs nothing of them, the last round as the first.
test('the marks of a long battle cost a frame only what the view shows of them, and only when that changes', () => {
  const ground = { points: [{ x: -1e5, y: 0 }, { x: 1e5, y: 0 }], height: () => 0 }, field = { scorches: [], terrain: ground },
    burn = x => Effects.prototype.scorch.call(field, { type: 'explosion', x, y: .2, power: 600, radius: 4.5 }),
    marks = new ScorchMarks(new Graphics()), left = 900, right = 1100, inView = scorch => scorch.x + scorch.width >= left && scorch.x - scorch.width <= right;
  const drawn = [];
  for (let round = 0; round < 30; round++) {
    for (let k = 0; k < 8; k++) burn(5000 + (round * 8 + k) * 997 % 40000);
    if (round % 3 === 0) burn(960 + round * 2);
    const before = marks.drawings;
    for (let frame = 0; frame < 60; frame++) marks.update(ground, field.scorches, left, right, 1000, 5);
    drawn.push(marks.drawings - before);
    const shown = field.scorches.filter(inView);
    assert.deepEqual(marks.shown, shown, 'the drawing holds the marks the view shows, and no other');
    assert.equal(marks.graphics.context.instructions.length, 2 * shown.length, 'soot and core of each mark in view, of none out of it');
  }
  assert.equal(field.scorches.length, 40);
  assert(drawn.every(count => count <= 1), 'a round of bursts out of the view draws nothing; one in it, or one lost from it, draws once: ' + drawn);
  assert(drawn.slice(10).some(count => count === 0) && drawn.slice(10).some(count => count === 1));
  // Another ground under the same marks (the bumps of a closer view) draws them again, once.
  const rough = { points: ground.points, height: () => .01 }, again = marks.drawings;
  for (let frame = 0; frame < 10; frame++) marks.update(rough, field.scorches, left, right, 1000, 5);
  assert.equal(marks.drawings, again + 1);
  // A view that holds none of them empties the drawing.
  marks.update(rough, field.scorches, -5000, -4800, -4900, 5);
  assert.equal(marks.graphics.context.instructions.length, 0);
});
