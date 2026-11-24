import test from 'node:test';
import assert from 'node:assert/strict';
import { ArmorArtCache, beveledPlateGeometry } from '../src/armor-art.ts';
import { designFrame, regionContains, regionGeometry, sceneFrame } from '../src/scene-frame.ts';

const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const plate = (id, a, b, thicknessMm, material, before = 0, after = 0) => {
  const reach = Math.hypot(b.x - a.x, b.y - a.y), length = reach + before + after, offset = (after - before) / 2;
  return { id, x: (a.x + b.x) / 2 + (b.x - a.x) / reach * offset, y: (a.y + b.y) / 2 + (b.y - a.y) / reach * offset,
    length, thicknessMm, angle: Math.atan2(b.y - a.y, b.x - a.x), material,
    anchors: [{ u: (-reach / 2 - offset) / length, v: 0 }, { u: (reach / 2 - offset) / length, v: 0 }] };
};
const tJoint = () => [plate('floor-left', { x: -2, y: 0 }, { x: 0, y: 0 }, 200, 'concrete'),
  plate('wall', { x: 0, y: 0 }, { x: 0, y: 2 }, 1000, 'fiberglass'),
  plate('floor-right', { x: 0, y: 0 }, { x: 2, y: 0 }, 200, 'concrete')];
const frame = definitions => designFrame({ plates: definitions, modules: [] });
const plan = (state, cache = new ArmorArtCache()) => cache.prepare(sceneFrame(state).surfaces);
const local = (p, pose) => { const dx = p.x - pose.x, dy = p.y - pose.y, c = Math.cos(pose.angle), s = Math.sin(pose.angle); return { x: dx * c + dy * s, y: -dx * s + dy * c }; };
const contains = (geometry, definition, point) => {
  const p = local(point, definition);
  return geometry.polygons.some(polygon => polygon.every((a, i) => cross(a, polygon[(i + 1) % polygon.length], p) >= -1e-7));
};
const owners = (state, prepared, point) => state.plates.filter(p => contains(prepared.get(p.id).geometry, p.definition, point)).map(p => p.id).sort();
function verifyMapping(state, prepared) {
  for (const source of state.plates) {
    const geometry = prepared.get(source.id).geometry, p = source.definition;
    for (let i = 0; i < geometry.positions.length; i += 2) {
      const x = geometry.positions[i], y = geometry.positions[i + 1];
      assert(Math.abs(x) <= p.length / 2 + 1e-6 && Math.abs(y) <= p.thicknessMm / 2000 + 1e-6);
      assert(Math.abs(geometry.uvs[i] - (x / p.length + .5)) < 1e-6);
      assert(Math.abs(geometry.uvs[i + 1] - (.5 - y * 1000 / p.thicknessMm)) < 1e-6);
    }
    for (let i = 0; i < geometry.indices.length; i += 3) {
      const triangle = [...geometry.indices.slice(i, i + 3)].map(n => ({ x: geometry.positions[n * 2], y: geometry.positions[n * 2 + 1] }));
      assert(cross(...triangle) > 1e-12, 'no degenerate or reversed face triangle');
    }
  }
}
const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
test('a continuous floor owns both halves of a mixed-material T regardless of order, endpoint direction or reflection', () => {
  for (const order of permutations) for (const reversed of [0, 1, 3, 7]) for (const mirror of [-1, 1]) {
    const definitions = tJoint().map((p, i) => ({ ...p, x: p.x * mirror, angle: mirror < 0 ? Math.PI - p.angle : p.angle }));
    definitions.forEach((p, i) => { if (reversed & 1 << i) { p.angle += Math.PI; p.anchors = p.anchors.map(a => ({ u: -a.u, v: -a.v })); } });
    const state = frame(order.map(i => definitions[i])), before = JSON.stringify(state), prepared = plan(state);
    for (const x of [-.3, -.12, .12, .3]) for (const y of [-.075, .075, .15, .3]) {
      const actual = owners(state, prepared, { x, y });
      assert.deepEqual(actual, [y < .1 ? (x * mirror < 0 ? 'floor-left' : 'floor-right') : 'wall']);
    }
    verifyMapping(state, prepared); assert.equal(JSON.stringify(state), before, 'the drawing does not change physical plates or material');
  }
});

test('L and crossed joints partition only their existing overlap and preserve the visible union', () => {
  const cases = [
    [plate('a', { x: -2, y: 0 }, { x: 0, y: 0 }, 200, 'steel', 0, .2), plate('b', { x: 0, y: 0 }, { x: 0, y: 2 }, 400, 'concrete', .1)],
    [plate('a', { x: -2, y: -.5 }, { x: 0, y: 0 }, 600, 'concrete', 0, .25), plate('b', { x: 0, y: 0 }, { x: .7, y: 2 }, 100, 'steel', .3)],
    [...tJoint(), plate('down', { x: 0, y: 0 }, { x: 0, y: -2 }, 1000, 'steel')],
  ];
  for (const definitions of cases) for (const reverse of [false, true]) {
    const state = frame(reverse ? [...definitions].reverse() : definitions), prepared = plan(state), original = state.plates.map(source => ({ source, geometry: beveledPlateGeometry(source) }));
    for (let x = -.393; x < .4; x += .023) for (let y = -.293; y < .4; y += .023) {
      const point = { x, y }, expected = original.some(({ source, geometry }) => contains(geometry, source.definition, point)), actual = owners(state, prepared, point);
      assert.equal(actual.length > 0, expected, 'partition cannot add or remove material from the union');
      assert(actual.length <= 1, 'material overlaps have one visible owner');
    }
    verifyMapping(state, prepared);
  }
});

test('a face cut into pieces at a joint is edged only where it ends, not where its pieces meet', () => {
  const cases = [tJoint(), [...tJoint(), plate('down', { x: 0, y: 0 }, { x: 0, y: -2 }, 1000, 'steel')],
    [plate('a', { x: -2, y: -.5 }, { x: 0, y: 0 }, 600, 'concrete', 0, .25), plate('b', { x: 0, y: 0 }, { x: .7, y: 2 }, 100, 'steel', .3)]];
  let pieces = 0;
  for (const definitions of cases) {
    const state = frame(definitions), prepared = plan(state);
    for (const source of state.plates) {
      const geometry = prepared.get(source.id).geometry, ends = new Map();
      if (!geometry.artJoint) continue;
      pieces = Math.max(pieces, geometry.polygons.length);
      const at = i => ({ x: geometry.positions[i * 2], y: geometry.positions[i * 2 + 1] }), key = p => [p.x, p.y].map(n => Math.round(n * 1e4)).join(','),
        inside = p => geometry.polygons.some(polygon => polygon.every((a, i) => cross(a, polygon[(i + 1) % polygon.length], p) >= -1e-7));
      for (const edge of geometry.edges) {
        const a = at(edge.a), b = at(edge.b), length = Math.hypot(b.x - a.x, b.y - a.y),
          middle = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, out = { x: (b.y - a.y) / length * 1e-4, y: (a.x - b.x) / length * 1e-4 };
        assert(inside({ x: middle.x - out.x, y: middle.y - out.y }) && !inside({ x: middle.x + out.x, y: middle.y + out.y }),
          `${source.id}: an edge has the face on one side of it only`);
        ends.set(key(a), (ends.get(key(a)) ?? 0) + 1); ends.set(key(b), (ends.get(key(b)) ?? 0) - 1);
      }
      assert([...ends.values()].every(count => count === 0), `${source.id}: the edges close about the face`);
    }
  }
  assert(pieces > 1, 'some face is cut into more than one piece');
});

test('damage away from a joint keeps its ownership, while holes at the joint reveal only actual remaining material', () => {
  const state = frame(tJoint()), cache = new ArmorArtCache(), initial = plan(state, cache), damaged = frame(tJoint()), left = damaged.plates[0];
  left.solidRegions = [{ minX: -1, maxX: -.2, minY: -.1, maxY: .1 }, { minX: .2, maxX: 1, minY: -.1, maxY: .1 }];
  left.regionRevision = 1; left.integrity = .8;
  const after = plan(damaged, cache);
  for (const x of [-.3, -.12, .12, .3]) assert.deepEqual(owners(damaged, after, { x, y: .075 }), owners(state, initial, { x, y: .075 }));
  const right = damaged.plates[2]; right.solidRegions = [{ minX: -.7, maxX: 1, minY: -.1, maxY: .1 }]; right.regionRevision = 2; right.integrity = .8;
  const jointHole = plan(damaged, cache);
  assert.deepEqual(owners(damaged, jointHole, { x: .15, y: .075 }), ['wall'], 'existing branch is visible through the missing floor');
  assert.deepEqual(owners(damaged, jointHole, { x: .15, y: -.075 }), [], 'neither the joint nor its mask can fill a real hole');
  assert.equal(regionContains(right, { x: .15, y: .075 }), false, 'picking uses the unchanged physical hole');
  assert.equal(regionContains(damaged.plates[1], { x: .15, y: .075 }), true);
  verifyMapping(damaged, jointHole);
});

test('joint geometry is cached under rigid movement and rebuilt when a neighbor changes material regions', () => {
  const cache = new ArmorArtCache(), initial = frame(tJoint()), first = plan(initial, cache), changed = frame(tJoint());
  for (const p of changed.plates) { p.definition.x += 5000; p.definition.y += 123; }
  const translated = plan(changed, cache); for (const id of ['wall', 'floor-left', 'floor-right']) assert.strictEqual(translated.get(id), first.get(id));
  const damaged = frame(tJoint()); damaged.plates[2].solidRegions = [{ minX: -.7, maxX: 1, minY: -.1, maxY: .1 }]; damaged.plates[2].regionRevision = 1;
  const cut = plan(damaged, cache);
  assert.notEqual(cut.get('wall').shapeKey, first.get('wall').shapeKey, 'a newly exposed face must upload the new mesh');
  assert.notStrictEqual(cut.get('wall').geometry, first.get('wall').geometry);
});

test('changing only mounting anchors invalidates a joint plan while reusing the physical base shapes', () => {
  const cache = new ArmorArtCache(); plan(frame(tJoint()), cache); const builds = cache.stats.shapeBuilds, changed = frame(tJoint());
  changed.plates[1].definition.anchors[0].u += .05;
  const warm = plan(changed, cache), cold = plan(changed);
  for (const point of [{ x: .1, y: .075 }, { x: -.1, y: .075 }, { x: .2, y: .05 }]) assert.deepEqual(owners(changed, warm, point), owners(changed, cold, point));
  assert.equal(cache.stats.shapeBuilds, builds); assert.equal(cache.stats.planBuilds, 2);
});

test('different thick joints cannot remove each other in a cycle and leave a void in a closed corner', () => {
  // Projected rectangle/anchor coordinates of a closed .6 x .7 m triangle;
  // the three different material widths all overlap near its first corner.
  const definitions = [
    ['p0', .43758222260935264, 0, .8751644452187053, 800, 0, -.5, .18558543857441423],
    ['p1', .4774835554781295, .24503288904374104, 1.0173373876248843, 850, 2.0344439357957027, -.2692863760291662, .5],
    ['p2', .14093739260171365, .3946246992847982, 1.6054207725550147, 230, -1.9138202672156002, -.20198221513782896, .261013810622423],
  ].map(([id, x, y, length, thicknessMm, angle, a, b]) => ({ id, x, y, length, thicknessMm, angle, material: 'concrete', anchors: [{ u: a, v: 0 }, { u: b, v: 0 }] }));
  for (const order of permutations) for (const mirror of [-1, 1]) {
    const state = frame(order.map(i => ({ ...definitions[i], x: mirror * definitions[i].x, angle: mirror < 0 ? Math.PI - definitions[i].angle : definitions[i].angle }))), prepared = plan(state),
      original = state.plates.map(source => ({ source, geometry: beveledPlateGeometry(source) }));
    assert.equal(owners(state, prepared, { x: .01 * mirror, y: .23 }).length, 1, 'the overlapping corner remains filled');
    for (let x = -.197; x < .9; x += .037) for (let y = -.193; y < 1; y += .037) {
      const point = { x: x * mirror, y }, expected = original.some(({ source, geometry }) => contains(geometry, source.definition, point)), actual = owners(state, prepared, point);
      assert.equal(actual.length > 0, expected, 'no material may be lost from the original union');
      assert(actual.length <= 1, 'a cycle is resolved to one stable visible face');
    }
    verifyMapping(state, prepared);
  }
});
