import test from 'node:test';
import assert from 'node:assert/strict';
import { radarAerial, aerialView, aerialSight } from '../src/machine-art.ts';

const near = (a, b, name) => assert(Math.abs(a - b) < 1e-10, `${name}: ${a} / ${b}`);
const bounds = view => {
  const xs = view.faces.slice(0, view.count).flatMap(face => [face.corners[0], face.corners[2]]);
  return [Math.min(...xs), Math.max(...xs)];
};

test('vehicle and base radars keep their height, pivot and orthographic silhouette through a complete turn', () => {
  for (const [width, height] of [[1, .84], [2.5, 2.1], [.4, .336]]) {
    const shape = radarAerial(width, height), view = aerialSight(), faces = view.faces.slice(), corners = faces.map(f => f.corners);
    for (let step = 0; step <= 3600; step++) {
      const turn = step * Math.PI / 1800;
      assert.equal(aerialView(shape, turn, view), view);
      assert(view.count >= 1 && view.count <= 2);
      assert(shape.y - shape.height / 2 >= -height / 2 && shape.y + shape.height / 2 <= height / 2, 'the aerial fits over its turntable');
      const [left, right] = bounds(view);
      near(left + right, 0, 'pivot');
      near(right - left, shape.width * Math.abs(Math.cos(turn)) + shape.depth * Math.abs(Math.sin(turn)), 'projected width');
      let area = 0;
      for (let i = 0; i < view.count; i++) {
        const face = view.faces[i], c = face.corners;
        assert.equal(face, faces[i]); assert.equal(c, corners[i]);
        assert(c.every(Number.isFinite));
        assert.deepEqual([c[1], c[3], c[5], c[7]], [shape.height / 2, shape.height / 2, -shape.height / 2, -shape.height / 2]);
        area += Math.abs(c[2] - c[0]) * shape.height;
        assert(face.light >= .8 && face.light <= 1);
      }
      near(area, (right - left) * shape.height, 'faces cover silhouette once');
      if (view.count === 2) {
        const [a, b] = view.faces.map(f => f.corners);
        assert([a[0], a[2]].some(x => [b[0], b[2]].some(y => Math.abs(x - y) < 1e-12)));
      }
    }
  }
});

test('face changes at every quarter-turn are continuous, with no projection reset or scale jump', () => {
  const shape = radarAerial(1, .84), epsilon = 1e-8;
  for (let quarter = -8; quarter <= 8; quarter++) {
    const turn = quarter * Math.PI / 2, at = aerialView(shape, turn), expected = quarter % 2 ? 'edge' : quarter % 4 ? 'back' : 'face';
    assert.equal(at.count, 1); assert.equal(at.faces[0].style, expected);
    const before = bounds(aerialView(shape, turn - epsilon)), after = bounds(aerialView(shape, turn + epsilon));
    for (let i = 0; i < 2; i++) assert(Math.abs(before[i] - after[i]) < epsilon);
  }
});
