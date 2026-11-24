import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Texture, TextureSource } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { weaponContains } from '../src/weapon-art.ts';
import { WeaponSprites } from '../src/weapon-sprites.ts';
import { mountedWeaponPolygons, weaponBarrelPolygon } from '../src/weapon-geometry.ts';
import { presentedMountSector, presentedPivotVelocity, servoGuide, servoStatus, AimPresentation } from '../src/weapon-presentation.ts';
import { Camera } from '../src/camera.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { FramePresentation } from '../src/presentation.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';

await initNativeDynamics();
const nativeGun = compileBlueprint(createConstruction('heavy')).modules.find(module => module.kind === 'weapon'),
  nativePost = planStructuredComponent(createStructuredConstruction({ length: 8, height: 3 }), {
    id: 'post', kind: 'weapon', weaponPreset: 'm2hb',
    pose: { x: 0, y: 80, angle: Math.PI / 2 }, mount: { preset: 'pintle' }, // cells: 4 m
  }).compiled.modules.find(module => module.id === 'post');
assertMountProjection(nativeGun); assertMountProjection(nativePost);
const gun = () => ({ ...structuredClone(nativeGun), id: 'gun',
  actorId: 'local', x: 2, y: 1, angle: Math.PI, barrelAngle: Math.PI + .12,
  targetBarrelAngle: Math.PI + .2 });
const postGun = () => ({ ...structuredClone(nativePost), actorId: 'local', x: 2, y: 1,
  angle: Math.PI / 2, barrelAngle: Math.PI, targetBarrelAngle: Math.PI + .2 });

test('camera culling keeps weapon sprites and their exact cached textures until the gun leaves the state', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  const renderer = new Renderer({}, { mode: 'test' }), layer = new Container(), drawn = new Graphics(),
    module = gun(), state = { shared: true, time: 0, actors: [], plates: [], modules: [module] },
    art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 };
  let painted = 0, requested = 0;
  Object.defineProperty(renderer, 'weapon', { value: { platform: 'vehicle' } });
  renderer.gun = new Graphics(); renderer.actorLayers.set('local', { gunArt: layer, gun: drawn });
  renderer.weaponArt = new WeaponSprites((key, create, place) => {
    requested++;
    const entry = renderer.texture(key, () => { painted++; return new Texture({ source: new TextureSource({ width: 100, height: 40 }) }); }, false, place);
    entry.art = art; return entry;
  }, entry => renderer.usedTextures.add(entry.key));
  const frame = next => {
    renderer.scene = sampleScene(next); renderer.usedTextures.clear(); renderer.drawGun(next); renderer.releaseTextures();
  };
  t.after(() => {
    renderer.weaponArt.clear(); renderer.releaseTextures(true); layer.destroy({ children: true }); drawn.destroy(); renderer.gun.destroy();
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  });
  frame(state);
  const sprites = [...layer.children], entries = [...renderer.textures.values()], textures = entries.map(entry => entry.texture), made = painted, asks = requested;
  assert.equal(made, 3, 'receiver, moving gun and fixed shield each retain their texture');
  renderer.unseen.add('local');
  for (let i = 0; i < 60; i++) frame(state);
  assert.equal(painted, made); assert.equal(requested, asks, 'hidden guns do not request painters or advance deferred mount artwork');
  assert.deepEqual([...renderer.textures.values()], entries);
  assert(sprites.every(sprite => !sprite.destroyed) && textures.every(texture => !texture.destroyed));
  renderer.unseen.clear(); frame({ ...state, modules: [{ ...module, barrelAngle: module.barrelAngle + .4 }] });
  assert.deepEqual(layer.children, sprites); assert.equal(painted, made, 'returning to view reuses the original artwork');
  frame({ ...state, modules: [] });
  assert.equal(renderer.weaponArt.items.size, 0); assert.equal(renderer.textures.size, 0);
  assert(sprites.every(sprite => sprite.destroyed) && textures.every(texture => texture.destroyed));
});

test('a tube hot enough to glow does so over its paint, dull red and brighter as it is hotter; one cooler does not', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  const renderer = new Renderer({}, { mode: 'test' }), layer = new Container(), drawn = new Graphics(), module = gun(),
    art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 };
  Object.defineProperty(renderer, 'weapon', { value: { platform: 'vehicle' } });
  renderer.gun = new Graphics(); renderer.actorLayers.set('local', { gunArt: layer, gun: drawn });
  renderer.weaponArt = new WeaponSprites((key, create, place) => {
    const entry = renderer.texture(key, () => new Texture({ source: new TextureSource({ width: 100, height: 40 }) }), false, place);
    entry.art = art; return entry;
  }, entry => renderer.usedTextures.add(entry.key));
  t.after(() => {
    renderer.weaponArt.clear(); renderer.releaseTextures(true); layer.destroy({ children: true }); drawn.destroy(); renderer.gun.destroy();
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  });
  const glow = barrelTemperature => {
    const state = { shared: true, time: 0, actors: [], plates: [], modules: [{ ...module, barrelTemperature }] };
    drawn.clear(); renderer.scene = sampleScene(state); renderer.usedTextures.clear(); renderer.drawGun(state); renderer.releaseTextures();
    return drawn.context.instructions.filter(instruction => instruction.action === 'fill').map(instruction => instruction.data.style.alpha);
  };
  assert.deepEqual(glow(300), []); assert.deepEqual(glow(524), []);
  const [dull] = glow(525), [full] = glow(1100), tube = mountedWeaponPolygons(module)[1], bounds = drawn.getLocalBounds(),
    xs = tube.map(p => p.x), ys = tube.map(p => p.y);
  assert(Math.abs(dull - .2) < 1e-9 && Math.abs(full - .8) < 1e-9, `${dull} ${full}`);
  for (const [found, wanted] of [[bounds.minX, Math.min(...xs)], [bounds.maxX, Math.max(...xs)], [bounds.minY, Math.min(...ys)], [bounds.maxY, Math.max(...ys)]])
    assert(Math.abs(found - wanted) < 1e-9, `the glow lies over the tube: ${found} vs ${wanted}`);
  // From 150 °C it tells the air over it where its tube lies, along its upper side, and how hot it is (heat-haze.ts).
  glow(149); assert.deepEqual(renderer.hotBarrels, []);
  glow(300); const [hot] = renderer.hotBarrels;
  assert.equal(renderer.hotBarrels.length, 1); assert.equal(hot.id, 'gun'); assert.equal(hot.temperature, 300);
  // Its ends are the corners of the side of the tube that is up, and the tube is as thick as the farthest corner from it.
  const ends = [{ x: hot.x0, y: hot.y0 }, { x: hot.x1, y: hot.y1 }], length = Math.hypot(hot.x1 - hot.x0, hot.y1 - hot.y0),
    across = Math.max(...tube.map(v => Math.abs((v.x - hot.x0) * (hot.y1 - hot.y0) - (v.y - hot.y0) * (hot.x1 - hot.x0)) / length));
  assert(ends.every(end => tube.some(v => Math.hypot(v.x - end.x, v.y - end.y) < 1e-9)) && length > .5, `the corners of the tube: ${JSON.stringify(ends)}`);
  assert((hot.y0 + hot.y1) / 2 > ys.reduce((sum, y) => sum + y) / ys.length, 'its upper side');
  assert(Math.abs(across - hot.diameter) < 1e-9, `${across} across the tube, told ${hot.diameter}`);
  assert(Math.abs(hot.air - (15 - .0065 * module.y)) < 1e-9 && hot.vx === 0 && hot.vy === 0, JSON.stringify(hot));
});

test('retention follows mounted, recoiling and unmounted artwork without keeping inactive parts', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  const art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 }, entries = new Map(), retained = [],
    layer = new Container(), sprites = new WeaponSprites(key => {
      if (!entries.has(key)) entries.set(key, { key, texture: Texture.WHITE, art });
      return entries.get(key);
    }, entry => { assert(entry); retained.push(entry); }), mounted = gun(), exposed = postGun();
  t.after(() => {
    sprites.clear(); layer.destroy({ children: true });
    if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document;
  });
  for (const [module, count] of [[mounted, 3], [{ ...mounted, weaponMount: { ...mounted.weaponMount, recoil: 0 } }, 3],
    [exposed, 3], [{ ...exposed, weaponMount: { ...exposed.weaponMount, recoil: 0 } }, 2],
    [{ ...mounted, weaponMount: null, materialPolygons: null }, 1]]) {
    sprites.begin(); sprites.place(module.id, layer, module, module.barrelAngle, module.weaponPreset); sprites.end();
    // What moves over the gun (its ready rounds, its turning barrels) keeps its pictures with it.
    const item = sprites.items.get(module.id), moving = [item.feed, item.rotor].flatMap(overlay => Object.values(overlay?.entries || {})),
      active = [...item.textures, ...moving];
    retained.length = 0; sprites.begin(); sprites.retain(module.id); sprites.end();
    assert.equal(item.textures.length, count); assert.equal(retained.length, count + moving.length); assert.deepEqual(retained, active);
    assert.equal(item.sprites.filter(sprite => sprite.visible).length, count);
  }
  sprites.begin(); sprites.retain('unknown'); sprites.end();
  assert.equal(sprites.items.size, 0);
});

test('inherited motion is measured at the pivot relative to the admitted carrier COM', () => {
  const body = { x: 4, y: 2, angle: .4, vx: 3.2, vy: -.2, omega: .8,
    carrierCenter: { x: -.45, y: .7 } }, pivot = { x: 5, y: 3 }, before = structuredClone(body),
    c = Math.cos(body.angle), s = Math.sin(body.angle), center = {
      x: body.x + c * body.carrierCenter.x - s * body.carrierCenter.y,
      y: body.y + s * body.carrierCenter.x + c * body.carrierCenter.y },
    actual = presentedPivotVelocity(body, pivot);
  assert.deepEqual(actual, { x: body.vx - body.omega * (pivot.y - center.y),
    y: body.vy + body.omega * (pivot.x - center.x), omega: body.omega });
  assert.notEqual(actual.x, body.vx - body.omega * (pivot.y - body.y));
  assert.deepEqual(body, before);
  assert.equal(presentedPivotVelocity(null, pivot), undefined);
});

test('painted sprites recoil the receiver and tube while the shield stays at the pivot and an exposed post stays on its host axis', t => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'document');
  globalThis.document = {};
  t.after(() => { if (before) Object.defineProperty(globalThis, 'document', before); else delete globalThis.document; });
  const art = { canvas: { width: 100, height: 40 }, originX: 20, originY: 20, scale: 40 },
    sprites = new WeaponSprites(() => ({ texture: Texture.WHITE, art })), layer = new Container(), module = gun(), before2 = structuredClone(module),
    place = (weapon, recoil) => { sprites.begin(); sprites.place('gun', layer, weapon, weapon.barrelAngle, weapon.weaponPreset, { recoil }); sprites.end(); };
  t.after(() => { sprites.clear(); layer.destroy({ children: true }); });
  place(module, 0);
  const [receiver, moving, shield] = layer.children;
  // The receiver of this mount runs along its first edge: it lies along the bore, at the pivot.
  assert.equal(receiver.rotation, module.barrelAngle);
  assert.deepEqual([receiver.position.x, receiver.position.y], [module.x, module.y]);
  assert.equal(moving.rotation, module.barrelAngle);
  assert.equal(shield.rotation, module.barrelAngle);
  assert.deepEqual([shield.position.x, shield.position.y], [module.x, module.y]);
  // Laid elsewhere and fired, the receiver turns with the tube and recoils down the bore as far as it does.
  const aimed = { ...module, barrelAngle: module.angle - .3 };
  place(aimed, .04);
  for (const sprite of [receiver, moving]) {
    assert.equal(sprite.rotation, aimed.barrelAngle);
    assert.equal(sprite.position.x, aimed.x - Math.cos(aimed.barrelAngle) * .04);
    assert.equal(sprite.position.y, aimed.y - Math.sin(aimed.barrelAngle) * .04);
  }
  assert.equal(shield.rotation, aimed.barrelAngle);
  assert.deepEqual([shield.position.x, shield.position.y], [aimed.x, aimed.y], 'the curved mask rotates without following the recoil stroke');
  assert.deepEqual(module, before2);
  // The post an exposed mount carries its gun on, behind the trunnion with the gun's own receiver, stands still.
  const post = postGun();
  sprites.begin(); sprites.place('post', layer, post, post.barrelAngle, post.weaponPreset, { recoil: .04 }); sprites.end();
  const [stand, carried, cradle] = sprites.items.get('post').sprites;
  assert.equal(stand.rotation, post.angle); assert.deepEqual([stand.position.x, stand.position.y], [post.x, post.y]);
  assert.equal(carried.rotation, post.barrelAngle);
  assert.deepEqual([carried.position.x, carried.position.y], [post.x - Math.cos(post.barrelAngle) * .04, post.y - Math.sin(post.barrelAngle) * .04]);
  assert.equal(cradle.rotation, post.barrelAngle);
  assert.deepEqual([cradle.position.x, cradle.position.y], [post.x, post.y]);
});

test('the servo turns receiver, tube and curved shield facets while integrated feet and exposed posts stay with their host', () => {
  for (const angle of [.31, Math.PI + .4, -2 * Math.PI + .71]) {
    const module = { ...gun(), angle, barrelAngle: angle + .12 }, before = structuredClone(module),
      laid = mountedWeaponPolygons(module), aimed = mountedWeaponPolygons({ ...module, barrelAngle: angle - .3 });
    assert.equal(laid.length, module.materialPolygons.length); assert.equal(aimed.length, laid.length);
    for (const [material] of module.materialPolygons.entries()) {
      if (material === 2 || material === 3) assert.deepEqual(aimed[material], laid[material], 'integrated feet keep the host frame');
      else assert.notDeepEqual(aimed[material], laid[material], 'receiver, tube and curved shield follow the servo');
    }
    assert.deepEqual(weaponBarrelPolygon(module), laid[1]);
    const turned = { ...module, angle: angle + .5, barrelAngle: module.barrelAngle + .5 },
      polygons = mountedWeaponPolygons(turned);
    assert.equal(polygons.length, turned.materialPolygons.length);
    for (const [material, polygon] of turned.materialPolygons.entries()) for (const [i, p] of polygon.entries()) {
      const axis = material === 2 || material === 3 ? turned.angle : turned.barrelAngle;
      assert.equal(polygons[material][i].x, turned.x + Math.cos(axis) * p.x - Math.sin(axis) * p.y);
      assert.equal(polygons[material][i].y, turned.y + Math.sin(axis) * p.x + Math.cos(axis) * p.y);
    }
    assert.deepEqual(module, before, 'presentation does not mutate native local geometry or actuator state');
    // A gun carried whole: its receiver reaches back behind the trunnion among the solids that turn, and the post it
    // turns on follows its host only.
    const post = { ...postGun(), angle, barrelAngle: angle + .12 },
      standing = mountedWeaponPolygons(post);
    const raised = mountedWeaponPolygons({ ...post, barrelAngle: angle - .3 });
    assert.equal(raised.length, post.materialPolygons.length); assert.deepEqual(raised[0], standing[0]);
    for (let role = 1; role < standing.length; role++) assert.notDeepEqual(raised[role], standing[role]);
    assert.notDeepEqual(mountedWeaponPolygons({ ...post, angle: angle + .5 })[0], standing[0]);
  }
});

test('mounted picking follows every native curved facet and leaves the clear tube opening empty', () => {
  const module = { ...gun(), angle: .4, barrelAngle: 1.1 }, polygons = mountedWeaponPolygons(module),
    world = (x, y, angle) => ({ x: module.x + x * Math.cos(angle) - y * Math.sin(angle),
      y: module.y + x * Math.sin(angle) + y * Math.cos(angle) });
  for (const poly of polygons) {
    const center = { x: poly.reduce((sum, p) => sum + p.x, 0) / poly.length,
      y: poly.reduce((sum, p) => sum + p.y, 0) / poly.length };
    assert(weaponContains(module, center, 0, -123), 'native module pose is the picking authority');
  }
  assert(weaponContains(module, world(-module.width * .9, 0, module.barrelAngle)));
  assert(!weaponContains(module, world(-module.width * .9, 0, module.angle), .01),
    'where the host axis would have left the receiver is not selectable');
  const outsideReceiver = world(-module.width - .015, 0, module.barrelAngle);
  assert(!weaponContains(module, outsideReceiver, .01));
  assert(weaponContains(module, outsideReceiver, .02), 'picking tolerance remains a world-space distance');
  const shield = module.weaponMount.shield, openingY = (WEAPON_PRESETS[module.weaponPreset].barrelRadius + shield.opening) / 2,
    openingX = Math.sqrt((shield.radius + shield.thickness / 2) ** 2 - openingY ** 2);
  assert(!weaponContains(module, world(openingX, openingY, module.barrelAngle)), 'the radial opening beside the physical tube contains no shield material');
});

test('both facing directions reflect all enclosed and exposed material regions and picking together', () => {
 for (const fixture of [gun(), postGun()]) {
  const module = { ...fixture, angle: .55, barrelAngle: .92 }, before = structuredClone(module), mirrored = {
    ...module, x: -module.x, angle: Math.PI - module.angle, barrelAngle: Math.PI - module.barrelAngle,
    materialPolygons: module.materialPolygons.map(poly => poly.map(p => ({ x: p.x, y: -p.y }))),
  }, left = mountedWeaponPolygons(module), right = mountedWeaponPolygons(mirrored);
  assert.equal(right.length, left.length); assert.equal(left.length, module.materialPolygons.length);
  for (const [role, polygon] of module.materialPolygons.entries()) for (const [point] of polygon.entries()) {
    assert(Math.abs(right[role][point].x + left[role][point].x) < 1e-12);
    assert(Math.abs(right[role][point].y - left[role][point].y) < 1e-12);
  }
  for (const polygons of [left, right]) for (const poly of polygons) {
    const center = { x: poly.reduce((sum, p) => sum + p.x, 0) / poly.length,
      y: poly.reduce((sum, p) => sum + p.y, 0) / poly.length };
    assert(weaponContains(polygons === left ? module : mirrored, center));
  }
  assert.deepEqual(module, before);
 }
});

test('sector display uses native world axis and reflects without changing actuator state', () => {
  const module = gun(), before = structuredClone(module);
  assert.deepEqual(presentedMountSector(module), { min: module.angle + module.weaponMount.min,
    max: module.angle + module.weaponMount.max, current: module.barrelAngle, maxSpeed: module.weaponMount.maxSpeed });
  const reflected = { ...module, angle: 0, barrelAngle: -.12,
    weaponMount: { ...module.weaponMount, min: -module.weaponMount.max, max: -module.weaponMount.min } };
  assert.equal(presentedMountSector(reflected).min, -module.weaponMount.max);
  assert.equal(presentedMountSector(reflected).max, -module.weaponMount.min);
  assert.equal(presentedMountSector(reflected).current, -.12);
  assert.deepEqual(module, before);
});

test('paused sampled servo remains at its delivered physical angle while target differs', () => {
  const module = gun(), state = { time: 2, modules: [module], plates: [], actors: [],
    stats: {}, launcher: null }, before = structuredClone(state), presentation = new FramePresentation();
  presentation.receive(state, [], { now: 100, paused: true });
  for (const now of [100, 1000, 10000]) {
    const sample = presentation.sample(now), pose = sampleScene(sample.state).pose(module.id);
    assert.equal(pose.barrelAngle, module.barrelAngle);
    assert(servoStatus(pose).aligning);
    assert.equal(sample.time, state.time);
  }
  assert.deepEqual(state, before);
});

test('the guide of a swinging gun runs past the muzzle of a gun of any length, its arc kept by the pivot', () => {
  for (const barrel of [.2, .55, 1.8, 4.25, 6.05]) {
    const { extent, radius } = servoGuide(barrel);
    assert(extent > barrel, `${barrel} m: the dashed aim line reaches past the muzzle`);
    assert(radius >= .25 && radius <= .65);
  }
});

test('a moving forecast shares one bounded display arc, contact, clock and marks without moving a world contact with its gun', () => {
  const display = new AimPresentation(), first = { time: 0 }, next = { time: .05 },
    before = { key: 'gun:ground', flight: 10, path: [{ time: 0, x: 0, y: 2 }, { time: 2, x: 4, y: 3 }, { x: 20, y: 0 }],
      impact: { x: 20, y: 0, nx: 0, ny: 1, angleDegrees: 10, time: 10, bounce: null } },
    current = { key: before.key, flight: 12, path: [{ time: 0, x: 1, y: 2 }, { time: 6, x: 11, y: 3 }, { x: 20.2, y: 0 }],
      impact: { x: 20.2, y: 0, nx: 0, ny: 1, angleDegrees: 14, time: 12, bounce: null } },
    original = structuredClone([before, current]);
  assert.equal(display.sample(before, { state: first, previous: null, alpha: 1, now: 0, zoom: 20 }), before);
  const shown = display.sample(current, { state: next, previous: first, alpha: .5, now: 50, zoom: 20 });
  assert.deepEqual(shown.path.map(({ x, y }) => [x, y]), [[.5, 2], [10.5, 2.4375], [20.1, 0]]);
  assert.equal(shown.flight, 11); assert.equal(shown.impact.time, shown.flight);
  assert.deepEqual([shown.impact.x, shown.impact.y], [20.1, 0]);
  assert.deepEqual([shown.impact.nx, shown.impact.ny, shown.impact.angleDegrees], [0, 1, 12]);
  const marks = display.marks(shown);
  assert.equal(marks.length, 2); assert(Math.abs(marks[0].x - (0.5 + 100 / 11)) < 1e-10);
  assert(Math.abs(marks[0].y - (2 + .4375 * 10 / 11)) < 1e-10);
  assert.deepEqual([before, current], original, 'display sampling cannot edit either physical forecast');
  assert.equal(display.sample(current, { state: next, previous: first, alpha: 1, now: 66, zoom: 20 }), current);
});

test('forecast display bounds contact error and drops interpolation on a refused, changed, stale or discontinuous pair', () => {
  const first = { time: 0 }, next = { time: .05 },
    before = { key: 'gun:ground', flight: 1, path: [{ time: 0, x: 0, y: 2 }, { x: 20, y: 0 }], impact: null },
    current = { ...before, path: [{ time: 0, x: 1, y: 2 }, { x: 21, y: 0 }] },
    context = { state: next, previous: first, alpha: 0, now: 50, zoom: 20 },
    start = () => { const display = new AimPresentation(); display.sample(before, { state: first, previous: null, alpha: 1, now: 0, zoom: 20 }); return display; };
  for (const zoom of [20, 80]) {
    const shown = start().sample(current, { ...context, zoom }), error = current.path.at(-1).x - shown.path.at(-1).x;
    assert(error > 0); assert(error <= .5 + 1e-10); assert(error * zoom <= 16 + 1e-10);
  }
  for (const [raw, changed] of [[current, { reset: true }], [{ ...current, key: 'another-owner-or-loadout' }, {}],
    [current, { previous: { time: 0 } }], [current, { now: 76 }], [current, { now: -1 }],
    [{ ...current, path: [{ time: 0, x: 5, y: 2 }, { x: 25, y: 0 }] }, {}]])
    assert.equal(start().sample(raw, { ...context, ...changed }), raw);
  const display = start(); display.sample(current, context);
  assert.equal(display.sample(current, { ...context, now: 126 }), current, 'a stopped stream never swims after 75 ms');
  assert.equal(display.sample(current, { ...context, reset: true, alpha: .3 }), current, 'pause/rest shows exactly the delivered forecast');
});

test('at 72 km/h the bounded impact does not pull the arc muzzle ahead of the interpolated vehicle', () => {
  const display = new AimPresentation(), first = { time: 0 }, next = { time: .05 },
    before = { key: 'gun:ground', flight: 1, path: [{ time: 0, x: 0, y: 2 }, { time: .5, x: 10, y: 2 }, { x: 20, y: 0 }], impact: null },
    // 20 m/s at 20 Hz: both raw muzzle and raw contact advance one metre.
    current = { ...before, path: before.path.map(point => ({ ...point, x: point.x + 1 })) },
    original = structuredClone([before, current]), context = { state: next, previous: first, alpha: .1, now: 50, zoom: 80 };
  display.sample(before, { state: first, previous: null, alpha: 1, now: 0, zoom: 80 });
  const shown = display.sample(current, context);
  assert.equal(shown.path[0].x, .1, 'the origin follows scene alpha, not the impact-error clamp');
  assert.equal(shown.path[0].y, 2);
  const error = current.path.at(-1).x - shown.path.at(-1).x;
  assert(error >= 0 && error <= .2 + 1e-10); assert(error * context.zoom <= 16 + 1e-9);
  assert.deepEqual([before, current], original, 'the approximation cannot warp a physical forecast');
  const loose = display.sample(current, { ...context, alpha: .9, now: 58 });
  for (let i = 0; i < loose.path.length; i++) assert(Math.abs(loose.path[i].x - before.path[i].x - .9) < 1e-10);
  assert.equal(display.sample(current, { ...context, alpha: 1, now: 66 }), current, 'a fully presented snapshot needs no warp');
});

test('at 120 km/h a zoomed forecast still interpolates while a screen cursor jump stays immediate', () => {
  const display = new AimPresentation(), first = { time: 0 }, next = { time: .05 }, distance = 120 / 3.6 / 20,
    before = { key: 'gun:ground', flight: 1, path: [{ time: 0, x: 0, y: 2 }, { time: .5, x: 10, y: 2 }, { x: 20, y: 0 }],
      impact: { x: 20, y: 0, nx: 0, ny: 1, angleDegrees: 30, time: 1, bounce: null } },
    current = { ...before, path: before.path.map(point => ({ ...point, x: point.x + distance })),
      impact: { ...before.impact, x: before.impact.x + distance } }, original = structuredClone([before, current]),
    context = { state: next, previous: first, alpha: .1, now: 50, zoom: 80 };
  display.sample(before, { state: first, previous: null, alpha: 1, now: 0, zoom: 80 });
  const shown = display.sample(current, context);
  assert.notEqual(shown, current, 'normal motion cannot disable the arc filter just because zoom is high');
  assert(Math.abs(shown.path[0].x - distance * .1) < 1e-10);
  assert(Math.abs(current.impact.x - shown.impact.x) <= .2 + 1e-10);
  assert.equal(shown.impact.x, shown.path.at(-1).x); assert.deepEqual([shown.impact.nx, shown.impact.ny], [0, 1]);
  assert.deepEqual([before, current], original);
  const jump = { ...current, path: current.path.map(point => ({ ...point, x: point.x + 5 })),
    impact: { ...current.impact, x: current.impact.x + 5 } };
  assert.equal(display.sample(jump, { ...context, now: 58 }), jump, 'a jump beyond four metres is still immediate');
  const camera = new Camera(800, 600); camera.zoom = 80;
  display.point({ x: 0, y: 0 }, camera, 0, 'gun');
  const pointer = { x: distance, y: 0 };
  assert.equal(display.point(pointer, camera, 50, 'gun'), pointer, 'the cursor keeps its separate 96px cut');
});

test('the local cursor advances during continuous movement, settles in 35 ms and leaves its world command untouched', () => {
  const display = new AimPresentation(), camera = new Camera(800, 600); camera.zoom = 80;
  const aim = { x: .2, y: 0 }, original = { ...aim };
  display.point({ x: 0, y: 0 }, camera, 0, 'gun');
  display.point({ x: .1, y: 0 }, camera, 8, 'gun');
  const moving = display.point(aim, camera, 16, 'gun');
  assert(moving.x > 0 && moving.x < aim.x, 'new pointer samples cannot hold the drawing motionless');
  assert((aim.x - moving.x) * camera.zoom <= 16 + 1e-9);
  assert.deepEqual(display.point(aim, camera, 51, 'gun'), aim);
  camera.x += .05;
  const followed = display.point(aim, camera, 59, 'gun');
  assert(Math.abs(followed.x - aim.x) <= .2 + 1e-10);
  assert.deepEqual(display.point(aim, camera, 94, 'gun'), aim);
  assert.deepEqual(aim, original, 'camera following never rewrites or sends the aim command');
  assert.equal(display.point(aim, camera, 95, 'gun', true), aim);
  const jump = { x: 20, y: 0 };
  assert.equal(display.point(jump, camera, 96, 'gun'), jump, 'a large aim jump is immediate');
});
