import test from 'node:test';
import assert from 'node:assert/strict';
import { paintComponentDamage } from '../src/textures.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { designFrame } from '../src/scene-frame.ts';

function recordingContext() {
  const paths = [], gradients = [], transforms = [], rectangles = [], stack = [];
  let path = [];
  const ctx = { canvas: { width: 512, height: 128 }, globalAlpha: .7, globalCompositeOperation: 'source-atop',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
    translate: (...args) => transforms.push(['translate', ...args]),
    scale: (...args) => transforms.push(['scale', ...args]), rotate: angle => transforms.push(['rotate', angle]),
    createRadialGradient(...args) { const record = { type: 'radial', args, stops: [] }; gradients.push(record); return { addColorStop: (...stop) => record.stops.push(stop) }; },
    createLinearGradient(...args) { const record = { type: 'linear', args, stops: [] }; gradients.push(record); return { addColorStop: (...stop) => record.stops.push(stop) }; },
    beginPath() { path = []; }, moveTo: (x, y) => path.push([x, y]), lineTo: (x, y) => path.push([x, y]),
    closePath() {}, fill() { paths.push({ type: 'fill', points: path, composite: this.globalCompositeOperation }); },
    stroke() { paths.push({ type: 'stroke', points: path, width: this.lineWidth, composite: this.globalCompositeOperation }); },
    arc() { throw new Error('Surface damage cannot use a circular raised rim.'); },
    fillRect(...args) { rectangles.push({ args, composite: this.globalCompositeOperation }); } };
  return { ctx, paths, gradients, transforms, rectangles };
}

const impact = { u: .5, v: .5, radius: .05, strength: .8, kind: 'dent' };

test('surface damage keeps the measured footprint and does not erase underlying material', () => {
  for (const kind of ['dent', 'hole', 'ricochet', 'burn']) {
    const record = recordingContext(), mark = { ...impact, kind }, before = structuredClone(mark), radiusPx = mark.radius / 2 * 512;
    paintComponentDamage(record.ctx, [mark], 2, .5);
    assert.deepEqual(mark, before);
    assert.deepEqual(record.transforms[0], ['translate', 256, 64]);
    assert.equal(record.ctx.globalAlpha, .7); assert.equal(record.ctx.globalCompositeOperation, 'source-atop');
    assert(record.paths.every(path => path.composite === 'source-atop'));
    assert(record.rectangles.every(rect => rect.composite === 'source-atop'));
    const depression = record.paths.find(path => path.type === 'fill');
    assert(depression.points.every(([x, y]) => Math.hypot(x, y) <= radiusPx));
    assert(record.gradients[0].args.at(-1) <= radiusPx * 1.5, 'feathering must not manufacture a large second footprint');
  }
});

test('the abraded edge is smooth, asymmetric and stable between revisions', () => {
  const draw = mark => { const record = recordingContext(); paintComponentDamage(record.ctx, [mark], 2, .5); return record.paths.find(path => path.type === 'fill').points; },
    a = draw(impact), b = draw(impact), c = draw({ ...impact, u: .57 });
  assert.deepEqual(a, b); assert.notDeepEqual(a, c);
  const radii = a.map(([x, y]) => Math.hypot(x, y));
  assert(Math.max(...radii) - Math.min(...radii) > .7, 'the exposed face is not a perfect disk');
  let sharpest = 0;
  for (let i = 0; i < a.length; i++) {
    const prev = a[(i + a.length - 1) % a.length], here = a[i], next = a[(i + 1) % a.length],
      before = [here[0] - prev[0], here[1] - prev[1]], after = [next[0] - here[0], next[1] - here[1]],
      cosine = (before[0] * after[0] + before[1] * after[1]) / (Math.hypot(...before) * Math.hypot(...after));
    sharpest = Math.max(sharpest, Math.acos(Math.max(-1, Math.min(1, cosine))));
  }
  assert(sharpest < .65, 'random polygon corners should not survive as large facets');
});

test('ricochet paint is a directional scrape inside the contact radius', () => {
  const record = recordingContext();
  paintComponentDamage(record.ctx, [{ ...impact, kind: 'ricochet', dx: 0, dy: -1 }], 2, .5);
  assert.equal(record.transforms.find(op => op[0] === 'rotate')[1], Math.PI / 2);
  const points = record.paths.find(path => path.type === 'fill').points,
    width = Math.max(...points.map(p => p[0])) - Math.min(...points.map(p => p[0])),
    height = Math.max(...points.map(p => p[1])) - Math.min(...points.map(p => p[1]));
  assert(width > height * 2.3); assert(width <= impact.radius / 2 * 512 * 2);
});

test('soot has no shiny mechanical rim and preserves the incoming opacity', () => {
  const record = recordingContext(); paintComponentDamage(record.ctx, [{ ...impact, kind: 'burn' }], 2, .5);
  assert.equal(record.paths.filter(path => path.type === 'stroke').length, 0);
  assert.equal(record.ctx.globalAlpha, .7);
});

test('backing decals remain near the measured border and collapse coincident repetitions', () => {
  const definition = { id: 'plate', material: 'steel', x: 0, y: .5, angle: 0, length: 4, thicknessMm: 100, anchors: [] },
    state = designFrame({ preset: 'vehicle', plates: [definition], modules: [], appearance: { paint: '#68765a' } });
  state.bodyPanels = [{ id: 'hull', actorId: 'local', poly: [{ x: -2, y: .5 }, { x: 2, y: .5 }, { x: 2, y: 1.5 }, { x: -2, y: 1.5 }] }];
  const original = [{ u: .5, v: .5, kind: 'dent', radius: .06 },
    { u: .5, v: .5, kind: 'dent', radius: .07 }, { u: .5, v: .5, kind: 'dent', radius: .05 }];
  state.plates[0].marks = structuredClone(original);
  const marks = bodyPanelSurfaces(state)[0].marks;
  assert.equal(marks.length, 1); assert.equal(marks[0].radius, .07); assert.equal(marks[0].angle, 0);
  assert(Math.hypot(marks[0].x, marks[0].y - .5) <= marks[0].radius * .8);
  assert.deepEqual(state.plates[0].marks, original, 'paint deduplication must retain all mechanical evidence');
});

test('backing retains distinct impacts and different damage types at the same material coordinate', () => {
  const definition = { id: 'plate', material: 'steel', x: 0, y: .5, angle: 0, length: 4, thicknessMm: 100, anchors: [] },
    state = designFrame({ preset: 'vehicle', plates: [definition], modules: [], appearance: { paint: '#68765a' } });
  state.bodyPanels = [{ id: 'hull', actorId: 'local', poly: [{ x: -2, y: .5 }, { x: 2, y: .5 }, { x: 2, y: 1.5 }, { x: -2, y: 1.5 }] }];
  state.plates[0].marks = [{ u: .5, v: .5, kind: 'dent', radius: .03 },
    { u: .5, v: .5, kind: 'burn', radius: .03 }, { u: .55, v: .5, kind: 'dent', radius: .03 }];
  assert.equal(bodyPanelSurfaces(state)[0].marks.length, 3);
});
