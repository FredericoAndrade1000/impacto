import test from 'node:test';
import assert from 'node:assert/strict';
import { hullArtwork, hullImpactLayout, paintHullImpacts } from '../src/hull-art.ts';
import { localToWorld } from '../src/math.ts';

const shape = hullArtwork([{ x: -2, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 1 }, { x: -2, y: 1 }], 0x68765a);
const marksAt = pose => {
  const point = localToWorld(pose, -1.99, .5);
  return [{ ...point, angle: pose.angle + .3, radius: .065, strength: .7, kind: 'ricochet', u: .03, v: .5 }];
};

test('cached hull impact layout stays fixed during rigid translation and rotation', () => {
  const pose = { x: 0, y: 0, angle: 0 }, expected = hullImpactLayout(shape, pose, marksAt(pose));
  for (const angle of [-Math.PI, -.7, 0, .9, Math.PI]) {
    const moved = { x: 100, y: -15, angle }, marks = marksAt(moved), original = structuredClone(marks),
      actual = hullImpactLayout(shape, moved, marks);
    assert.equal(actual.revision, expected.revision);
    assert(Math.abs(actual.impacts[0].radius - .065) < 1e-12);
    assert.equal(actual.impacts[0].kind, 'ricochet'); assert.deepEqual(marks, original);
  }
  const larger = marksAt(pose); larger[0].radius *= 2;
  assert.notEqual(hullImpactLayout(shape, pose, larger).revision, expected.revision);
});

test('edge impacts composite only over the clipped hull without a frame-time mask', () => {
  const operations = [], stack = [], ctx = { canvas: { width: 800, height: 200 }, globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    save() { stack.push([this.globalAlpha, this.globalCompositeOperation]); },
    restore() { [this.globalAlpha, this.globalCompositeOperation] = stack.pop(); },
    scale(...args) { operations.push(['scale', ...args]); },
    translate(...args) { operations.push(['translate', ...args]); }, rotate() {},
    drawImage(source, ...args) { operations.push(['image', this.globalCompositeOperation, source, ...args]); },
  }, layout = hullImpactLayout(shape, { x: 0, y: 0, angle: 0 }, marksAt({ x: 0, y: 0, angle: 0 })), source = {};
  paintHullImpacts(ctx, shape, layout.impacts, () => source);
  const image = operations.find(op => op[0] === 'image');
  assert.equal(image[1], 'source-atop'); assert.equal(image[2], source);
  assert.equal(image[5], .065 / .16); assert.equal(image[6], .065 / .16);
  assert.deepEqual(operations[0], ['scale', 200, 200]);
  assert.equal(ctx.globalAlpha, 1); assert.equal(ctx.globalCompositeOperation, 'source-over');
});
