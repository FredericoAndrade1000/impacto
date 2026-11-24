import test from 'node:test';
import assert from 'node:assert/strict';
import { closestSegment } from '../src/math.ts';
import { weaponRecoilGuide, drawWeaponRecoilGuide } from '../src/weapon-art.ts';

const rect = (x0, y0, x1, y1) => [
  { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
];
const weapon = (min = -.6, max = .6) => ({
  x: 125000, y: 12, angle: .4, barrelAngle: .7, weaponPreset: 'm777',
  weaponMount: { recoil: 1.4, min, max },
  materialPolygons: [rect(-.5, -.225, 0, .225), rect(0, -.12, 6.8, .12),
    rect(.1, -.32, .4, -.12), rect(.1, .12, .4, .32)],
});
const turn = (x, y, angle) => ({ x: x * Math.cos(angle) - y * Math.sin(angle),
  y: x * Math.sin(angle) + y * Math.cos(angle) });
function contains(points, p) {
  let inside = false;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], q = closestSegment(p, a, b);
    if (Math.hypot(q.x - p.x, q.y - p.y) < 1e-9) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

test('the complete configured sector contains the recoil box at intermediate elevations and both limits', () => {
  for (const [min, max] of [[-.6, .6], [.19, .21], [-1.75, 1.75]]) {
    const module = weapon(min, max), before = structuredClone(module), guide = weaponRecoilGuide(module);
    assert(guide.sweep.length < 290, 'the editor draws a bounded contour');
    for (let step = 0; step <= 320; step++) {
      const angle = min + (max - min) * step / 320;
      for (const x of [guide.minX, (guide.minX + guide.maxX) / 2, guide.maxX])
        for (const y of [guide.minY, 0, guide.maxY])
          assert(contains(guide.sweep, turn(x, y, angle)), `reservation at ${angle}: (${x}, ${y})`);
    }
    assert(!contains(guide.sweep, { x: 0, y: 0 }), 'the empty space at the pivot stays empty');
    assert.deepEqual(module, before, 'drawing never changes admitted geometry or limits');
  }
});

test('changing the configured limits narrows the reservation and zero-width sectors retain only the current box', () => {
  const module = weapon(-.6, .6), full = weaponRecoilGuide(module), point = turn(-1.8, 0, -.4);
  assert(contains(full.sweep, point));
  module.weaponMount.min = .1; module.weaponMount.max = .2;
  const narrowed = weaponRecoilGuide(module);
  assert(!contains(narrowed.sweep, point));
  assert.notEqual(narrowed.sweep, full.sweep);
  module.weaponMount.min = module.weaponMount.max;
  assert.equal(weaponRecoilGuide(module).sweep, undefined);
  module.weaponMount.recoil = 0;
  assert.equal(weaponRecoilGuide(module), null);
});

test('exposed and mirrored mounts reserve the moving receiver instead of sweeping the post', () => {
  const module = weapon(-1.75, 1.75);
  module.weaponMount.recoil = .03;
  module.weaponMount.exposed = true;
  module.materialPolygons = [rect(-.1, -.5, .1, 0), rect(0, -.03, .88, .03),
    rect(-.77, -.1, 0, .1), rect(.1, -.06, .2, .06)];
  const guide = weaponRecoilGuide(module);
  assert.equal(guide.maxX, -.77);
  for (const angle of [-1.75, -.8, 0, .8, 1.75])
    assert(contains(guide.sweep, turn(-.785, 0, angle)));
  assert(!contains(guide.sweep, { x: 0, y: -.4 }), 'the fixed post is outside the reserve');
});

test('a howitzer raised high is reserved, drawn and labelled the shorter stroke it recoils there', () => {
  // A mount whose axis rises 0.6 rad over its hull: the M777 laid there recoils its whole 1.4 m; at the top of its
  // sector, 69 degrees up, 0.84 m. Each step of the sector is swept as far as it recoils there, not farther.
  const module = weapon(-.6, .6);
  module.angle = .6; module.weaponMount.hullAxis = .6;
  const laid = angle => weaponRecoilGuide({ ...module, barrelAngle: module.angle + angle }), sweep = laid(0).sweep;
  assert.equal(laid(0).stroke, 1.4); assert.equal(laid(.6).stroke, .84);
  assert(Math.abs(laid(.6).maxX - laid(.6).minX - .84) < 1e-12);
  assert(sweep.length < 1200, 'the editor draws a bounded contour');
  for (let step = 0; step <= 320; step++) {
    const angle = -.6 + 1.2 * step / 320, guide = laid(angle);
    for (const x of [guide.minX, guide.maxX]) for (const y of [guide.minY, guide.maxY])
      assert(contains(sweep, turn(x, y, angle)), `reservation at ${angle}: (${x}, ${y})`);
  }
  assert(!contains(sweep, turn(laid(.6).maxX - 1.4, 0, .6)), 'the whole stroke is not reserved raised high');
  assert.equal(laid(.3).sweep, sweep, 'aiming reuses the contour');
});

test('aiming and changing the world pose reuse the contour; only sector, geometry or recoil edits rebuild it', () => {
  const module = weapon(), original = weaponRecoilGuide(module).sweep;
  for (let frame = 0; frame < 120; frame++) {
    module.barrelAngle = frame / 100; module.angle = frame / 100; module.x += 1;
    assert.equal(weaponRecoilGuide(module).sweep, original);
  }
  module.weaponMount.recoil += .1;
  const restroked = weaponRecoilGuide(module).sweep;
  assert.notEqual(restroked, original);
  module.materialPolygons = structuredClone(module.materialPolygons);
  assert.notEqual(weaponRecoilGuide(module).sweep, restroked);
});

test('the swept area follows the host axis across the angle wrap, with the current box highlighted separately', () => {
  const module = weapon(), before = structuredClone(module), fills = [], points = [];
  module.angle = Math.PI - .05; module.barrelAngle = -Math.PI + .1;
  const guide = weaponRecoilGuide(module), g = {
    moveTo(x, y) { points.push({ x, y }); return this; },
    lineTo(x, y) { points.push({ x, y }); return this; },
    closePath() { return this; }, fill(style) { fills.push(style); return this; }, stroke() { return this; },
  };
  drawWeaponRecoilGuide(g, guide, .01);
  assert.equal(fills.length, 2); assert(fills[0].alpha < fills[1].alpha);
  for (let i = 0; i < guide.sweep.length; i++) {
    const expected = turn(guide.sweep[i].x, guide.sweep[i].y, module.angle);
    assert(Math.abs(points[i].x - module.x - expected.x) < 1e-9);
    assert(Math.abs(points[i].y - module.y - expected.y) < 1e-9);
  }
  assert.deepEqual(module.materialPolygons, before.materialPolygons);
});
