import test from 'node:test';
import assert from 'node:assert/strict';
import { CollisionIndex } from '../src/collision.ts';
import { facetBoundary } from '../src/facet-boundary.ts';

const point = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) }), step = .75 / 8;
function shell() {
  return Array.from({ length: 8 }, (_, i) => {
    const lo = .15 + i * step, hi = lo + step;
    return [point(.9, lo), point(.95, lo), point(.95, hi), point(.9, hi)];
  });
}
function admitted(polygons) {
  const index = new CollisionIndex(), owner = { id: 'gun', type: 'module', object: { kind: 'weapon', weaponMount: { exposed: false } } };
  const material = [[{ x: -.5, y: -.2 }, { x: 0, y: -.2 }, { x: 0, y: .2 }, { x: -.5, y: .2 }], ...Array.from({length: 2}, () => [{x:-3,y:0},{x:-2,y:0},{x:-2,y:1},{x:-3,y:1}]), ...polygons];
  return { index, owner, material, group: index.include(owner, material) };
}

test('a ray at a shared outer vertex uses exposed steel rather than a radial seam', () => {
  const geometry = shell(), vertex = point(.95, .15 + 4 * step), expected = Math.cos(.15 + 3.5 * step), results = [];
  for (const polygons of [geometry, geometry.toReversed(), geometry.map(poly => poly.toReversed())]) {
    const { index } = admitted(polygons);
    for (const dy of [0, -1e-7, 1e-7]) {
      const hit = index.raycast({ x: 2, y: vertex.y + dy }, { x: .2, y: vertex.y + dy });
      assert(hit); assert(hit.depth > .01); assert(hit.nx > .8, 'the circular outer skin supplies the normal');
      if (dy === 0) { assert(Math.abs(hit.nx - expected) < 1e-9); results.push(hit); }
    }
  }
  for (const hit of results.slice(1)) for (const key of ['enter', 'exit', 'nx', 'ny', 'depth'])
    assert(Math.abs(hit[key] - results[0][key]) < 1e-10, `${key} is independent of facet order and winding`);
});

test('a perforation exposes a real radial cut face, and moving the owner retains its cached boundary', () => {
  const geometry = shell().filter((_, i) => i !== 4), { index, owner, group, material } = admitted(geometry), edges = group.normalEdges,
    from = point(.925, .57), to = point(.925, .48), angle = .15 + 4 * step,
    hit = index.raycast(from, to);
  assert(hit); assert(Math.abs(hit.nx + Math.sin(angle)) < 1e-9); assert(Math.abs(hit.ny - Math.cos(angle)) < 1e-9);
  for (const poly of material) for (const p of poly) { p.x += 12; p.y += 3; }
  assert.equal(index.include(owner, material, group), group); assert.equal(group.normalEdges, edges);
  const moved = index.raycast({ x: from.x + 12, y: from.y + 3 }, { x: to.x + 12, y: to.y + 3 });
  assert(Math.abs(moved.nx - hit.nx) < 1e-10); assert(Math.abs(moved.ny - hit.ny) < 1e-10);
});

test('a faceted boundary cancels only joined edges and retains the steel opening', () => {
  assert.equal(facetBoundary(shell()).length, 18);
  assert.equal(facetBoundary(shell().filter((_, i) => i !== 4)).length, 18, 'removing one facet exposes two cut ends');
});

test('the exact native grazing vertex retains its outer normal across ray direction, rotation and index order', () => {
  // Identical to game_projectiles.rs::an_exact_shield_vertex_uses_the_outer_skin_normal_instead_of_a_facet_seam.
  // Keep the ray exactly on the shared vertex; nudging it would hide the bug.
  const radius = .275, thickness = .065, opening = .135, outer = radius + thickness, half = Math.PI / 3,
    gap = Math.atan2(opening, Math.sqrt(radius * radius - opening * opening)), theta = (gap + half) / 2,
    b = outer * Math.cos((half - gap) / 2 * .8), normal = point(1, theta), tangent = point(1, theta + Math.PI / 2),
    localFrom = { x: normal.x * b + tangent.x * .7, y: normal.y * b + tangent.y * .7 },
    localTo = { x: normal.x * b - tangent.x * .7, y: normal.y * b - tangent.y * .7 },
    facets = [];
  for (const [a, z] of [[-half, -gap], [gap, half]]) {
    const count = Math.ceil((z - a) * outer / .02);
    for (let i = 0; i < count; i++) {
      const lo = a + (z - a) * i / count, hi = a + (z - a) * (i + 1) / count;
      facets.push([point(radius, lo), point(outer, lo), point(outer, hi), point(radius, hi)]);
    }
  }
  const shuffled = facets.filter((_, i) => i % 2).concat(facets.filter((_, i) => !(i % 2)).toReversed()),
    orders = [facets, facets.toReversed(), shuffled, shuffled.map(poly => poly.toReversed())];
  for (const angle of [0, 2.54159265927, -2.54159265927]) for (const reverse of [false, true]) {
    const transform = p => ({ x: 2 + p.x * Math.cos(angle) - p.y * Math.sin(angle),
      y: 3 + p.x * Math.sin(angle) + p.y * Math.cos(angle) }),
      from = transform(reverse ? localTo : localFrom), to = transform(reverse ? localFrom : localTo), results = [];
    for (const [order, polygons] of orders.entries()) {
      const index = new CollisionIndex(), owner = { id: 'gun', type: 'module', object: { kind: 'weapon', weaponMount: { exposed: false } } },
        other = { id: 'far-away', type: 'plate' }, far = [[{ x: 80, y: 80 }, { x: 81, y: 80 }, { x: 81, y: 81 }, { x: 80, y: 81 }]],
        receiver = [{ x: -.25, y: -.225 }, { x: .25, y: -.225 }, { x: .25, y: .225 }, { x: -.25, y: .225 }];
      if (order % 2) index.include(other, far);
      index.include(owner, [receiver, ...Array.from({length: 2}, () => [{x:-3,y:0},{x:-2,y:0},{x:-2,y:1},{x:-3,y:1}]), ...polygons].map(poly => poly.map(transform)));
      if (!(order % 2)) index.include(other, far);
      const hit = index.raycast(from, to, { completeExit: true });
      assert.equal(hit?.owner.id, 'gun');
      assert(Math.abs(hit.depth - .14416320627658) < 1e-8, 'the exact native chord is preserved');
      const rx = hit.x - 2, ry = hit.y - 3,
        radialDot = (rx * hit.nx + ry * hit.ny) / Math.hypot(rx, ry),
        cosine = Math.abs(((to.x - from.x) * hit.nx + (to.y - from.y) * hit.ny) / Math.hypot(to.x - from.x, to.y - from.y));
      assert(radialDot > .999, `a facet seam is not an exposed surface: angle=${angle}, reverse=${reverse}`);
      assert(Math.abs(cosine - Math.sin((half - gap) * .45)) < 1e-10,
        'the most opposing exposed face gives a grazing impact, as in the native query');
      results.push(hit);
    }
    for (const hit of results.slice(1)) for (const key of ['enter', 'exit', 'nx', 'ny', 'depth'])
      assert(Math.abs(hit[key] - results[0][key]) < 1e-10, `${key} is independent of index and facet order`);
  }
});
