import test from 'node:test';
import assert from 'node:assert/strict';
import { platesAlong } from '../src/frame-editing.ts';
import { metresOf, cellClear } from '../src/grid.ts';

const source = () => ({ nodes: [], plates: [], components: [] });
const near = (actual, expected) => assert(Math.abs(actual - expected) < 1e-12, `${actual} ≈ ${expected}`);
const world = node => ({ x: metresOf(node.x), y: metresOf(node.y) });

test('plates laid freely on a sloped face keep the requested offset and exact drawn interval', () => {
  const path = { points: [{ x: -.123456789, y: .234567891 }, { x: 1.876543211, y: 2.234567891 }], offsets: [.037654321] },
    low = .137123456, high = 1.937654321, made = platesAlong(source(), path, low, high),
    direction = { x: Math.SQRT1_2, y: Math.SQRT1_2 }, length = high - low;
  for (const [i, node] of made.source.nodes.entries()) {
    const point = world(node), u = [low, high][i], base = path.points[0];
    near(point.x, base.x + direction.x * u - direction.y * path.offsets[0]);
    near(point.y, base.y + direction.y * u + direction.x * path.offsets[0]);
    assert(!Number.isInteger(node.x) || !Number.isInteger(node.y));
  }
  const [a, b] = made.source.nodes.map(world);
  near(Math.hypot(b.x - a.x, b.y - a.y), length);
});

test('optional snap chooses whole cells outside the face without sinking the new plate', () => {
  const path = { points: [{ x: -.123456789, y: .234567891 }, { x: 1.876543211, y: 2.234567891 }], offsets: [.037654321] },
    made = platesAlong(source(), path, .137123456, 1.937654321, { snap: true });
  for (const node of made.source.nodes) {
    assert(Number.isInteger(node.x) && Number.isInteger(node.y));
    const point = world(node), base = path.points[0], distance = ((point.y - base.y) - (point.x - base.x)) * Math.SQRT1_2;
    assert(distance >= path.offsets[0] - 1e-12);
  }
});

test('free offsets reuse a deliberately named existing endpoint and preserve unrelated geometry', () => {
  const before = source(), y = .737123456;
  before.nodes = [{ id: 'a', x: -20, y: y / .05 }, { id: 'b', x: -40, y: y / .05 }];
  before.plates = [{ id: 'existing', a: 'a', b: 'b', material: 'steel', thicknessMm: 20 }];
  before.components = [{ id: 'sensor', pose: { x: 0, y: 0 } }];
  const snapshot = structuredClone(before), made = platesAlong(before,
    { points: [{ x: -1, y: .7 }, { x: 1, y: .7 }], offsets: [y - .7] }, 0, 1);
  assert.equal(made.source.plates.at(-1).a, 'a');
  assert.equal(made.source.nodes.length, 3);
  assert.deepEqual(made.source.plates[0], before.plates[0]);
  assert.deepEqual(made.source.components, before.components);
  assert.deepEqual(before, snapshot);
});

test('plates following a bend share one exact free corner on both offset faces', () => {
  const path = { points: [{ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 1 }], offsets: [.03, .03] },
    made = platesAlong(source(), path, 0, 1 + Math.SQRT2), [first, last] = made.source.plates,
    corner = world(made.source.nodes.find(node => node.id === first.b));
  assert.equal(made.source.nodes.length, 3); assert.equal(made.plateIds.length, 2);
  assert.equal(first.b, last.a);
  near(corner.y, .03);
  near((corner.y - corner.x) * Math.SQRT1_2, .03);
  assert(!Number.isInteger(corner.x / .05));
});

test('free plates keep the physical 8 cm minimum rather than rounding short spans into admissibility', () => {
  const path = { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }], offsets: [.031234567] };
  assert.throws(() => platesAlong(source(), path, 0, .079999), { code: 'FRAME_EDIT' });
  const made = platesAlong(source(), path, 0, .08), [a, b] = made.source.nodes.map(world);
  near(Math.hypot(b.x - a.x, b.y - a.y), .08);
});

test('snapped at a bend, the corner stands clear of both faces, and the plates on to it keep straight', () => {
  // Down a wall and on along the floor, standing 1 cm right of the wall and 3.5 cm over the floor: the corner is at
  // (0.2, 0.7) cells. The nearest cell clear of the two faces together, (0, 1), would sink 1 cm into the wall.
  const path = { points: [{ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 }], offsets: [.01, .035] },
    made = platesAlong(source(), path, 0, 1.5, { snap: true }), node = id => made.source.nodes.find(other => other.id === id),
    [down, along] = made.source.plates.map(plate => [node(plate.a), node(plate.b)]);
  assert.deepEqual(down.map(({ x, y }) => ({ x, y })), [{ x: 1, y: 20 }, { x: 1, y: 1 }], 'up the wall, upright');
  assert.deepEqual(along.map(({ x, y }) => ({ x, y })), [{ x: 1, y: 1 }, { x: 10, y: 1 }], 'along the floor, level');
});

test('the cell clear of faces: of one, the nearest on its side; of two, on the side of both, a ring further if need be', () => {
  assert.deepEqual(cellClear({ x: -8.2, y: 19.3 }, [{ x: -1, y: 0 }]), { x: -9, y: 19 });
  assert.deepEqual(cellClear({ x: -8.2, y: 19.3 }, [{ x: -1, y: 0 }, { x: 0, y: 1 }]), { x: -9, y: 20 });
  assert.deepEqual(cellClear({ x: 3, y: -2 }, [{ x: 0, y: 1 }]), { x: 3, y: -2 }, 'a whole cell is clear of itself');
  // So sharp a bend that none of the four cells about the point is clear of both.
  assert.deepEqual(cellClear({ x: .5, y: .5 }, [{ x: -1, y: 0 }, { x: .9, y: .436 }]), { x: 0, y: 2 });
});
