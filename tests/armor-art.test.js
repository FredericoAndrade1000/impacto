import test from 'node:test';
import assert from 'node:assert/strict';
import { ArmorArtCache, beveledPlateGeometry } from '../src/armor-art.ts';
import { designFrame, sceneFrame, regionGeometry, regionContains } from '../src/scene-frame.ts';

const plate = (id, x = 0, y = 0, angle = 0, length = 2, thicknessMm = 100, extra = {}) =>
  ({ id, x, y, angle, length, thicknessMm, material: 'steel', anchors: [], ...extra });
const frame = definitions => designFrame({ plates: definitions, modules: [] });
const surfaces = state => sceneFrame(state).surfaces;
const points = geometry => Array.from({ length: geometry.positions.length / 2 }, (_, i) =>
  ({ x: geometry.positions[i * 2], y: geometry.positions[i * 2 + 1] }));
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
const transform = (p, pose) => ({ x: pose.x + p.x * Math.cos(pose.angle) - p.y * Math.sin(pose.angle),
  y: pose.y + p.x * Math.sin(pose.angle) + p.y * Math.cos(pose.angle) });
const strictlyInside = (p, polygon) => polygon.every((a, i) => cross(a, polygon[(i + 1) % polygon.length], p) > 1e-7);

function validateMesh(geometry, definition) {
  const polygon = points(geometry), h = definition.thicknessMm / 2000, l = definition.length / 2;
  for (const [i, p] of polygon.entries()) {
    assert(Math.abs(p.x) <= l + 1e-6 && Math.abs(p.y) <= h + 1e-6, 'drawing corners must stay inside physical material');
    assert(Math.abs(geometry.uvs[i * 2] - (p.x / definition.length + .5)) < 1e-6);
    assert(Math.abs(geometry.uvs[i * 2 + 1] - (.5 - p.y / (h * 2))) < 1e-6, 'bevel vertices retain the original material mapping');
  }
  for (let i = 0; i < geometry.indices.length; i += 3) {
    const [a, b, c] = Array.from(geometry.indices.slice(i, i + 3), index => polygon[index]);
    assert(cross(a, b, c) > 1e-12, 'triangles must have positive, nonzero area');
  }
}

test('thin steel and thick concrete receive bounded drawing bevels without modifying physical coordinates or picking', () => {
  for (const [length, thickness] of [[2, 20], [4.8, 125], [5.4, 420], [.09, 350]]) {
    const state = frame([plate('a', 12, 3, .7, length, thickness)]), source = state.plates[0], before = JSON.stringify(state),
      geometry = beveledPlateGeometry(source), corner = { x: length / 2 - .00001, y: thickness / 2000 - .00001 };
    assert(geometry.artBevel > 0 && geometry.artBevel <= .055);
    validateMesh(geometry, source.definition);
    assert.equal(JSON.stringify(state), before, 'art cannot change nodes, UVs, regions, anchors or definitions');
    assert.equal(regionContains(source, transform(corner, source.definition)), true, 'inspection still sees the physical rectangular corner');
    assert.equal(points(geometry).every((a, i, polygon) => cross(a, polygon[(i + 1) % polygon.length], corner) >= -1e-8), false);
  }
});

test('L and T joints hide only outline intervals already covered by intact adjacent material', () => {
  for (const definitions of [[plate('a'), plate('b', 1, 1, Math.PI / 2)],
    [plate('a', 0, 1, 0, 4), plate('b', 0, 0, Math.PI / 2)]]) {
    const state = frame(definitions), cache = new ArmorArtCache(), result = cache.prepare(surfaces(state));
    assert(cache.stats.candidatePairs > 0);
    assert([...result.values()].some(part => part.edges.length < 8), 'a joined end should lose its internal outline');
    for (const definition of definitions) {
      const part = result.get(definition.id), other = definitions.find(p => p.id !== definition.id),
        otherPolygon = points(result.get(other.id).geometry).map(p => transform(p, other));
      validateMesh(part.geometry, definition);
      for (const edge of part.edges) {
        const midpoint = transform({ x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 }, definition);
        assert.equal(strictlyInside(midpoint, otherPolygon), false, 'no surviving line may run through neighboring material');
      }
    }
  }
});

test('coplanar end joints remain flat, and same-facing duplicate exteriors retain one outline', () => {
  const state = frame([plate('a'), plate('b', 2)]), result = new ArmorArtCache().prepare(surfaces(state));
  assert.deepEqual(result.get('a').geometry.artBevelEnds, [.021, 0]);
  assert.deepEqual(result.get('b').geometry.artBevelEnds, [0, .021]);
  assert.notEqual(result.get('a').shapeKey, new ArmorArtCache().prepare(surfaces(frame([plate('a')]))).get('a').shapeKey);
  for (const definition of state.plates.map(p => p.definition)) validateMesh(result.get(definition.id).geometry, definition);
  const duplicate = new ArmorArtCache().prepare(surfaces(frame([plate('a'), plate('b')])));
  assert.equal(duplicate.get('a').edges.length, 8);
  assert.equal(duplicate.get('b').edges.length, 0, 'coincident exterior strokes should be drawn once, not erased twice');
});

test('real gaps and other actors cannot become visual joins', () => {
  const cache = new ArmorArtCache(), state = frame([plate('a'), plate('b', 2.2)]), result = cache.prepare(surfaces(state));
  assert.equal(result.get('a').edges.length, 8); assert.equal(result.get('b').edges.length, 8);
  const joined = frame([plate('a'), plate('b', 1, 1, Math.PI / 2)]); joined.plates[1].actorId = 'other';
  const parts = new ArmorArtCache().prepare(surfaces(joined));
  assert.equal(parts.get('a').edges.length, 8); assert.equal(parts.get('b').edges.length, 8);
});

test('damage openings retain their physical holes and detached or fragment records use the original region geometry', () => {
  for (const kind of ['hole', 'detached', 'fragment', 'integrity']) {
    const state = frame([plate('a'), plate('b', 1, 1, Math.PI / 2)]), source = state.plates[1];
    if (kind === 'hole') {
      source.solidRegions = [{ minX: -1, maxX: -.15, minY: -.05, maxY: .05 },
        { minX: .15, maxX: 1, minY: -.05, maxY: .05 }]; source.revision++;
    } else if (kind === 'detached') source.attached = false;
    else if (kind === 'fragment') source.fragment = true;
    else source.integrity = .9;
    const base = regionGeometry(source), before = JSON.stringify(state), result = new ArmorArtCache().prepare(surfaces(state));
    if (kind === 'detached' || kind === 'fragment') {
      assert.strictEqual(result.get('b').geometry, base);
      assert.deepEqual(result.get('b').edges, base.edges.map(edge => ({ a: points(base)[edge.a], b: points(base)[edge.b] })));
      assert.equal(result.get('a').edges.length, 8, 'a detached neighbor cannot conceal a border');
    } else {
      const geometry = result.get('b').geometry;
      assert.equal(geometry.artBevel, undefined, 'damaged regions are never rounded over');
      validateMesh(geometry, source.definition);
      for (const polygon of geometry.polygons) {
        const middle = polygon.reduce((sum, p) => ({ x: sum.x + p.x / polygon.length, y: sum.y + p.y / polygon.length }), { x: 0, y: 0 });
        assert.equal(regionContains(source, transform(middle, source.definition)), true, 'a face cut can only retain real material');
      }
    }
    assert.equal(JSON.stringify(state), before);
    if (kind === 'hole') assert.equal(regionContains(source, transform({ x: 0, y: 0 }, source.definition)), false);
  }
});

test('new immutable snapshots under rigid translation and rotation reuse meshes and local joint plans', () => {
  const definitions = [plate('a'), plate('b', 1, 1, Math.PI / 2)], cache = new ArmorArtCache(), first = cache.prepare(surfaces(frame(definitions))),
    shapeBuilds = cache.stats.shapeBuilds, planBuilds = cache.stats.planBuilds, candidatePairs = cache.stats.candidatePairs;
  for (let i = 0; i < 90; i++) {
    const rotation = i * .19, moved = definitions.map(p => ({ ...p, ...transform(p, { x: i * 27, y: -i * 11, angle: rotation }), angle: p.angle + rotation })),
      result = cache.prepare(surfaces(frame(moved)));
    for (const id of ['a', 'b']) assert.strictEqual(result.get(id), first.get(id), 'rigid pose alone must not reclip or retessellate');
  }
  assert.equal(cache.stats.shapeBuilds, shapeBuilds); assert.equal(cache.stats.planBuilds, planBuilds);
  assert.equal(cache.stats.candidatePairs, candidatePairs);
});

test('a relative move, damage revision or local topology change invalidates only the affected actor plan', () => {
  const cache = new ArmorArtCache(), state = frame([plate('a'), plate('b', 1, 1, Math.PI / 2), plate('c', 20)]);
  state.plates[2].actorId = 'other'; const initial = cache.prepare(surfaces(state));
  const moved = frame([plate('a'), plate('b', 1.2, 1, Math.PI / 2), plate('c', 20)]); moved.plates[2].actorId = 'other';
  const separated = cache.prepare(surfaces(moved)); assert.equal(separated.get('a').edges.length, 8);
  assert.strictEqual(separated.get('a').geometry, cache.shapes.get('a').geometry, 'separating a joint restores its cached uncut face');
  assert.notStrictEqual(separated.get('a').geometry, initial.get('a').geometry);
  assert.strictEqual(separated.get('c'), initial.get('c'));
  moved.plates[1].revision++; moved.plates[1].integrity = .8;
  const damaged = cache.prepare(surfaces(moved)); assert.equal(damaged.get('b').geometry.artBevel, undefined);
  const remaining = cache.prepare(surfaces(moved).filter(s => s.id !== 'b'));
  assert.equal(remaining.has('b'), false); assert.equal(cache.shapes.has('b'), false);
  assert.strictEqual(remaining.get('c'), initial.get('c')); assert.equal(cache.plans.size, 2);
});

test('sparse and dense assemblies bound neighbor work instead of comparing every pair each frame', () => {
  for (const dense of [false, true]) {
    const count = 256, state = frame(Array.from({ length: count }, (_, i) => plate('p-' + i, dense ? 0 : i * 8))),
      cache = new ArmorArtCache(), first = cache.prepare(surfaces(state)), comparisons = cache.stats.candidatePairs;
    assert.equal(first.size, count); assert(comparisons <= count * 64, 'spatial buckets must cap candidate growth');
    if (!dense) assert.equal(comparisons, 0);
    const second = cache.prepare(surfaces(state)); assert.equal(cache.stats.candidatePairs, comparisons);
    assert.strictEqual(second.get('p-0'), first.get('p-0'));
    cache.clear(); assert.equal(cache.shapes.size, 0); assert.equal(cache.plans.size, 0);
  }
});
