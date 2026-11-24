import test from 'node:test';
import assert from 'node:assert/strict';
import { weaponContains, installedWeaponShapes, weaponRecoilGuide } from '../src/weapon-art.ts';
import { mountedWeaponPolygons } from '../src/weapon-geometry.ts';
import { weaponLayout, weaponPartBounds, paintWeapon } from '../src/weapon-paint.ts';
import { servoStatus } from '../src/weapon-presentation.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { Container, Texture } from 'pixi.js';

const rect = (x0, y0, x1, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
const polar = (r, a) => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
// A shield divided into convex facets, like the native projection. The barrel
// gap and the empty interior remain outside each facet's physical material.
function fixture() {
  const facets = [];
  for (const [lo, hi] of [[-.9, -.15], [.15, .9]]) for (let i = 0; i < 8; i++) {
    const a = lo + (hi - lo) * i / 8, b = lo + (hi - lo) * (i + 1) / 8;
    facets.push([polar(.9, a), polar(.95, a), polar(.95, b), polar(.9, b)]);
  }
  return { kind: 'weapon', weaponPreset: 'm777', x: 3, y: 2, angle: 0, barrelAngle: 0,
    weaponMount: { version: 3, exposed: false, recoil: 1.4, min: -.6, max: .6, fireTolerance: .1 * Math.PI / 180 },
    materialPolygons: [rect(-.5, -.2, 0, .2), rect(0, -.12, 6.8, .12), rect(-.4,-.4,.1,-.3), rect(-.4,.3,.1,.4), ...facets] };
}
const at = (gun, point) => ({ x: gun.x + point.x * Math.cos(gun.barrelAngle) - point.y * Math.sin(gun.barrelAngle),
  y: gun.y + point.x * Math.sin(gun.barrelAngle) + point.y * Math.cos(gun.barrelAngle) });

test('the admitted curved facets supply selection at every elevation without filling the empty interior', () => {
  for (const angle of [0, -.6, .6, Math.PI - .2]) {
    const gun = fixture(); gun.barrelAngle = angle;
    assert(weaponContains(gun, at(gun, polar(.925, .55))), 'the actual curved steel can be selected');
    assert(!weaponContains(gun, at(gun, polar(.75, .55))), 'air behind the thin shield is not a solid block');
    assert(!weaponContains(gun, at(gun, polar(1.1, .55))), 'air in front stays empty');
    const missing = 12, removed = gun.materialPolygons[missing + 4], midpoint = removed.reduce((p, q) => ({ x: p.x + q.x / 4, y: p.y + q.y / 4 }), { x: 0, y: 0 });
    gun.materialPolygons = gun.materialPolygons.filter((_, i) => i !== missing + 4);
    assert(!weaponContains(gun, at(gun, midpoint)), 'a perforated facet is absent from selection');
  }
});

test('all native shield facets project and draw with their own contours and valid colours', () => {
  const gun = fixture(), before = structuredClone(gun.materialPolygons), posed = mountedWeaponPolygons(gun), shapes = installedWeaponShapes(gun);
  assert.equal(posed.length, 20); assert.equal(shapes.length, 20);
  for (const [i, poly] of gun.materialPolygons.entries()) {
    assert.deepEqual(shapes[i].points, poly.flatMap(p => [p.x, p.y]));
    assert.match(shapes[i].color, /^#[0-9a-f]{6}$/);
    assert.deepEqual(posed[i], poly.map(p => at(gun, p)));
  }
  const layout = weaponLayout(gun.weaponPreset, gun.materialPolygons, -1, 1.4, false);
  assert.equal(layout.shieldEdges.length, 36, 'shared radial edges are not painted as seams');
  const clips = []; let path = [];
  const gradient = { addColorStop() {} }, ctx = new Proxy({}, {
    get: (_, name) => (...values) => {
      if (name === 'createLinearGradient' || name === 'createRadialGradient') return gradient;
      if (name === 'beginPath') path = [];
      if (name === 'moveTo' || name === 'lineTo') path.push(values);
      if (name === 'closePath') path.push(null);
      if (name === 'clip') clips.push(path.slice());
      for (const value of values) if (typeof value === 'number') assert(Number.isFinite(value));
    },
    set: () => true,
  });
  paintWeapon(ctx, layout, 'cradle', 400);
  assert.deepEqual(clips, [layout.contours.mantlets.flatMap(poly => [...poly.map(p => [p.x, -p.y]), null])]);
  assert.deepEqual(gun.materialPolygons, before, 'painting never edits physical material');
});

test('mount roles are explicit; exposed post stays fixed and the receiver follows the tube', () => {
  const gun = fixture(); gun.weaponMount.exposed = true; gun.barrelAngle = .4;
  gun.materialPolygons = [rect(-.8, -.03, 0, .03), rect(0, -.03, .9, .03), rect(-.5, -.12, 0, .12), rect(0, -.06, .1, .06)];
  const posed = mountedWeaponPolygons(gun), guide = weaponRecoilGuide(gun);
  assert.deepEqual(posed[0], gun.materialPolygons[0].map(p => ({ x: gun.x + p.x, y: gun.y + p.y })));
  assert.deepEqual(posed[2], gun.materialPolygons[2].map(p => at(gun, p)));
  assert.equal(guide.maxX, -.5);
  const layout = weaponLayout(gun.weaponPreset, gun.materialPolygons, 1, 0, true);
  assert.equal(layout.body.x0, -.5); assert.equal(layout.support.x0, 0);
});

test('a jammed elevation mechanism never presents an endless aligning state', () => {
  const gun = { ...fixture(), targetBarrelAngle: .5 };
  assert.equal(servoStatus(gun).aligning, true);
  const jammed = servoStatus({ ...gun, elevationDisabled: true });
  assert.equal(jammed.disabled, true); assert.equal(jammed.aligning, false);
  assert(jammed.errorDegrees > 20, 'the actual angular error remains available for inspection');
});

test('curved shield snapshots reuse sprites and painters until actual local material changes', t => {
  const previous = globalThis.document; globalThis.document = {};
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const gun = { ...fixture(), id: 'gun' }, layer = new Container(), painters = new Map(),
    art = { canvas: { width: 800, height: 300 }, originX: 200, originY: 150, scale: 100 },
    pictures = new WeaponSprites((key, create) => {
      if (painters.has(key)) assert.equal(create, painters.get(key), 'aiming and snapshot replacement retain the painter closure');
      else painters.set(key, create);
      return { texture: Texture.WHITE, art };
    });
  t.after(() => { pictures.clear(); layer.destroy({ children: true }); });
  const place = (frame, polygons) => {
    pictures.begin(); pictures.place(gun.id, layer, { ...gun, materialPolygons: structuredClone(polygons) }, frame / 100, gun.weaponPreset, { recoil: frame % 12 / 20 }); pictures.end();
  };
  place(0, gun.materialPolygons); const sprites = layer.children.slice();
  for (let frame = 1; frame <= 240; frame++) place(frame, gun.materialPolygons);
  assert.equal(painters.size, 3); assert.deepEqual(layer.children, sprites);
  place(241, gun.materialPolygons.filter((_, i) => i !== 12));
  assert.equal(painters.size, 6, 'a changed shield projection invalidates the cached artwork once');
  assert.deepEqual(layer.children, sprites, 'material loss does not allocate another set of scene sprites');
});

test('the slide behind a howitzer raised high is as long as it recoils there, and only it is painted anew', t => {
  const previous = globalThis.document; globalThis.document = {};
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  // Its mount level over its hull: laid level the M777 recoils 1.4 m, raised 63 degrees 0.84 m.
  const gun = { ...fixture(), id: 'gun' }; gun.weaponMount.hullAxis = 0; gun.weaponMount.max = 1.2;
  const layer = new Container(), art = { canvas: { width: 800, height: 300 }, originX: 200, originY: 150, scale: 100 }, asked = new Set(),
    pictures = new WeaponSprites(key => { asked.add(key); return { texture: Texture.WHITE, art }; });
  t.after(() => { pictures.clear(); layer.destroy({ children: true }); });
  const place = angle => { asked.clear(); pictures.begin(); pictures.place(gun.id, layer, gun, angle, gun.weaponPreset); pictures.end();
    return Object.fromEntries([...asked].map(key => { const [, , name, , , reserve] = key.split(':'); return [name, reserve]; })); };
  const level = place(0), sprites = layer.children.slice(), raised = place(1.1);
  assert.deepEqual(level, { receiver: '0', moving: '0', cradle: '1.4' });
  assert.deepEqual(raised, { receiver: '0', moving: '0', cradle: '0.84' });
  assert.deepEqual(layer.children, sprites, 'the same sprites, the receiver and the tube with their pictures');
  assert.equal(sprites[0].scale.y, layer.children[0].scale.y, 'the lit side stays');
});

test('the closed mask stays on the trunnion through visual recoil without a physical recoil reserve', t => {
  const previous = globalThis.document; globalThis.document = {};
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const gun = { ...fixture(), id: 'gun' }; gun.weaponMount.recoil = 0;
  const layer = new Container(), art = { canvas: { width: 800, height: 300 }, originX: 200, originY: 150, scale: 100 },
    pictures = new WeaponSprites(() => ({ texture: Texture.WHITE, art }));
  t.after(() => { pictures.clear(); layer.destroy({ children: true }); });
  pictures.begin(); pictures.place(gun.id, layer, gun, .7, gun.weaponPreset, { recoil: .02 }); pictures.end();
  const [receiver, tube, mask] = layer.children;
  assert.equal(mask.x, gun.x); assert.equal(mask.y, gun.y); assert.equal(mask.rotation, .7);
  assert.equal(receiver.x, gun.x - Math.cos(.7) * .02); assert.equal(tube.x, receiver.x);
  const layout = weaponLayout(gun.weaponPreset, gun.materialPolygons);
  assert.deepEqual(weaponPartBounds(layout, 'moving'), layout.tube, 'the recoiling picture contains no shield');
  pictures.begin(); pictures.place(gun.id, layer, { ...gun, materialPolygons: gun.materialPolygons.slice(0, 2) }, .7, gun.weaponPreset); pictures.end();
  assert.equal(mask.visible, false, 'a fully perforated mask needs no empty bitmap');
});
