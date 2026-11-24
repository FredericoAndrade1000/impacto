import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Container } from 'pixi.js';
import { CHASSIS_MODELS, chassisFront, chassisName, chassisRear, chassisSpec, chassisTrack, chassisVertices, suspensionHeight } from '../src/chassis.ts';
import { chassisArtwork, chassisImpactLayout, chassisLayout, chassisLocal, chassisPlacement, chassisPoint, chassisSeats, paintChassisCanvas, paintGuardCanvas, deckGlint, skirtCover,
  suspensionRig, chassisFrame, mudguardsOver, seatShadeGeometry, chassisOutlineAt, floorSegment } from '../src/chassis-art.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { designFrame } from '../src/scene-frame.ts';
import { WHEEL_RISE, fenderAcross, fenderGroups, fenderLine, fenderOver, hullLayout, within } from '../src/hull-details.ts';
import { constructionBounds, constructionSVG, constructionSilhouette } from '../src/construction-preview.ts';
import { upwardRuns } from '../src/silhouette.ts';
import { trackWheels } from '../src/running-gear.ts';
import { partName } from '../src/part-view.ts';
import { withChassisArmour, withChassisAxle, withChassisGearScale, withChassisSuspension, withChassisThickness, withChassisTrackEnd } from '../src/chassis-editing.ts';
import { Renderer } from '../src/render.ts';
import { Editor } from '../src/editor.ts';
import { plateCorners } from '../src/math.ts';
import { heapOver } from '../src/cargo-art.ts';
import { holdsCargo } from '../src/component-volume.ts';
import { groundSurfaces } from './helpers/ground-art.js';
import { paintTextureCanvas, texturePreviewShape } from '../src/texture-paint.ts';
import { cellOf, metresOf } from '../src/grid.ts';
import { VEHICLE_ORIGIN } from '../src/vehicle.ts';

// A canvas that paints nothing, for the renderer to make its pictures on.
const anything = () => new Proxy(function () {}, { get: (_, key) => key === Symbol.toPrimitive ? () => 0 : anything(), apply: () => anything(), set: () => true });
class Canvas {
  width = 1; height = 1;
  getContext(type) {
    if (type !== '2d') return null;
    return this.context ??= new Proxy({ canvas: this }, { set: (kept, key, value) => { kept[key] = value; return true; },
      get: (kept, key) => key in kept ? kept[key] : key === 'measureText' ? () => ({ width: 10 }) :
        key === 'getImageData' || key === 'createImageData' ? (...size) => ({ data: new Uint8ClampedArray(4 * (size.at(-2) || 1) * (size.at(-1) || 1)) }) :
        key === 'fillRect' ? (...box) => { (kept.rectangles ??= []).push(box); } :
        key === 'roundRect' ? (...box) => { (kept.roundedRects ??= []).push(box); } :
        key === 'beginPath' ? () => { kept.path = []; } :
        key === 'moveTo' || key === 'lineTo' ? (x, y) => { (kept.path ??= []).push([x, y]); } :
        key === 'fill' ? () => { if (kept.path?.length) (kept.polygons ??= []).push(kept.path.slice()); } : () => anything() });
  }
}
Object.assign(globalThis, { HTMLCanvasElement: Canvas, document: { createElement: () => new Canvas() }, devicePixelRatio: 1 });
await initNativeDynamics();

const near = (a, b, within = 1e-3) => Math.abs(a - b) < within, mm = v => Math.round(v * 1e3) / 1e3;
// The outlines of a chassis along its points (`profile`, {x, y, gap?} from its front end) as the core gives them: one for
// each part between gaps, along its top from the front back, then under each point its partner, `depth` down square to
// the straights either side of it, from the rear forward; the first of a tub sloped back from its front end as deep.
const outlinesOf = (model, profile, depth) => {
  const parts = [[]];
  for (const p of profile) { parts.at(-1).push(p); if (p.gap) parts.push([]); }
  // `down` is square to a straight, down from it; at a knee the partner is on the line the two meet on.
  const down = (a, b) => { const l = Math.hypot(b.x - a.x, b.y - a.y); return { x: (b.y - a.y) / l, y: -(b.x - a.x) / l }; },
    off = (p, v, by) => ({ x: p.x + v.x * by, y: p.y + v.y * by });
  return parts.map((points, k) => [...points.map(p => ({ x: p.x, y: p.y })), ...points.map((p, j) => {
    const before = j > 0 && down(points[j - 1], p), after = j < points.length - 1 && down(p, points[j + 1]);
    if (!before) return chassisSpec(model).kind === 'tracked' && k === 0 ? off(p, { x: after.x - after.y, y: after.y + after.x }, depth) : off(p, after, depth);
    if (!after) return off(p, before, depth);
    const m = { x: before.x + after.x, y: before.y + after.y };
    return off(p, m, depth / (m.x * before.x + m.y * before.y));
  }).reverse()]);
};
// A chassis of a model laid out (`chassisLayout`) `length` long, straight unless its points are given (`profile`).
const laid = (model, length, { profile = [{ x: 0, y: 0 }, { x: length, y: 0 }], ...options } = {}) => {
  const spec = chassisSpec(model), depth = options.depth ?? spec.depth ?? spec.deck - spec.clearance;
  return chassisLayout(model, { length, profile, outlines: outlinesOf(model, profile, depth), ...options });
};
// A track as long as the chassis lets it be, from its front, as tall as its model has it (its points in cells, grid.ts).
const trackOf = (model, length) => { const { front, rear, y } = chassisTrack({ model, points: [{ x: 0, y: 0 }, { x: cellOf(length), y: 0 }] });
  return { width: rear - front, height: chassisSpec(model).track, y: y + VEHICLE_ORIGIN.y - chassisSpec(model).deck }; };
// Each model at its shortest, its longest and between; a tracked one with its track either way round, and without it.
const layouts = () => Object.entries(CHASSIS_MODELS).flatMap(([model, spec]) => [spec.length[0], (spec.length[0] + spec.length[1]) / 2, spec.length[1]]
  .flatMap(length => spec.kind !== 'tracked' ? [laid(model, length)]
    : [laid(model, length), ...[true, false].map(sprocketFront => laid(model, length, { track: trackOf(model, length), sprocketFront }))]));
// The pose of a plate of a compiled construction, as the scene tells it.
const poseOf = plate => ({ x: plate.x, y: plate.y, angle: plate.angle, definition: plate });
// A model as it is built, with armour over its running gear (the skirt of a track is its armour).
const armoured = (id, armorMm = 10) => withChassisArmour(createConstruction(id), armorMm);
const plates = blueprint => ({ frame: blueprint.plates.find(p => p.id === 'chassis:frame-0'), rail: blueprint.plates.find(p => p.chassis?.part === 'rail') });
// The picture of the chassis of a compiled construction as the renderer lays it out (render.ts drawChassis): by its
// points, its track, the middle of it from the front end, the armour it is of and whether it holds it, and by where its
// axles are.
const laidOut = blueprint => {
  const { frame } = plates(blueprint), chassis = frame.chassis, track = blueprint.modules.find(m => m.kind === 'track');
  return { place: chassisPlacement(poseOf(frame), chassis), track, layout: chassisLayout(chassis.model, {
    length: chassis.length, profile: chassis.profile, outlines: chassis.outlines,
    deck: chassis.deck, depth: chassis.depth, wheelDiameter: chassis.wheelDiameter, thicknessMm: frame.thicknessMm, metal: frame.material,
    track: track && { width: track.width, height: track.height, middle: chassis.track && (chassis.track.front + chassis.track.rear) / 2, y: chassis.track.y, armorMm: track.armorMm,
      held: track.attached !== false },
    axles: chassis.axles }) };
};
// A design drawn on the bench as the page draws it, seen from outside or cut open; as it is compiled, or as `compiled`
// makes that.
function bench(design, exterior, marked = () => {}, compiled = blueprint => blueprint) {
  const blueprint = compiled(compileBlueprint(design)), view = { mode: 'edit', exterior, weapon: { platform: 'vehicle' }, buildTool: 'select' },
    renderer = new Renderer({ clientWidth: 1280, clientHeight: 720 }, view);
  renderer.app = { stage: new Container(), renderer: { render() {}, resize() {}, backBuffer: { useBackBuffer: false } } };
  renderer.buildScene(groundSurfaces()); renderer.design(blueprint); view.editor = { blueprint, revision: 1, selectionIds: [] };
  marked(renderer.designState);
  Object.assign(renderer.camera, { x: 12, y: 1.5, zoom: 40 }); renderer.draw({ now: 0 });
  return { blueprint, renderer, layers: renderer.board.actorLayers.get('local') };
}

test('large equipment caches keep metre-scale grain when resizing at the same aspect ratio and reuse it after movement', () => {
  const renderer = new Renderer({ clientWidth: 1280, clientHeight: 720 }, { mode: 'edit' });
  renderer.frameSurface = new Float32Array(512 * 512).fill(1);
  try {
    for (const kind of ['builder', 'excavator', 'drill']) {
      const module = { id: kind, kind, width: 1.8, height: 1.2, metal: 'steel' }, small = renderer.moduleTexture(module),
        large = renderer.moduleTexture({ ...module, width: 3.6, height: 2.4 });
      assert.notEqual(small, large, kind + ': equal proportions do not mean equal physical grain scale');
      assert.equal(renderer.moduleTexture({ ...module, id: kind + '-moved', x: 123456, y: 200, angle: .5 }), small,
        kind + ': placement and identity do not repaint the material');
    }
  } finally { for (const entry of renderer.textures.values()) entry.texture.destroy(true); }
});

test('nothing of a chassis stands out of its outline but what hangs down to an axle', () => {
  for (const layout of layouts()) {
    const [outline] = layout.outlines, xs = outline.map(p => p.x), ys = outline.map(p => p.y), [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    assert.equal(y1, 0, 'its deck at the top of its picture');
    for (const part of layout.parts) {
      const box = { left: part.x - part.w / 2, right: part.x + part.w / 2, bottom: part.y - part.h / 2, top: part.y + part.h / 2 }, what = `${layout.key}: ${part.kind}`;
      assert(box.left >= x0 - 1e-6 && box.right <= x1 + 1e-6 && box.top <= y1 + 1e-6, what);
      if (box.bottom >= y0 - 1e-6) continue;
      // Towards an axle of the chassis, from the chassis and no further down than its wheel is round.
      assert(part.hangs, what);
      const axle = layout.axles.find(a => near(a.x, part.hangs.x) && near(a.y, part.hangs.y));
      assert(axle, `${what}: to one of its axles`);
      assert(box.top >= y0 && box.bottom >= axle.y - axle.r, what);
    }
    assert(layout.bottom <= Math.min(y0, ...layout.parts.map(p => p.y - p.h / 2)), 'the picture holds it all');
  }
});

test('structural gauge changes the actual flanges inside the same outline and invalidates only their cached picture', () => {
  for (const model of ['wheeled', 'tracked']) {
    const keys = new Set(), thicknesses = [8, 80], depth = model === 'wheeled' ? .3 : .5;
    let outline;
    for (const thicknessMm of thicknesses) for (const metal of ['steel', 'aluminum']) {
      const layout = laid(model, 8, { depth, deck: 1, wheelDiameter: 1.1, thicknessMm, metal }),
        shape = chassisArtwork(layout, 0x68765a), picture = paintChassisCanvas(shape, 0x68765a),
        rectangles = picture.getContext('2d').rectangles,
        gauge = thicknessMm / 1000, bands = rectangles.filter(([, , width, height]) => near(width, layout.length, 1e-9) && near(height, gauge, 1e-9));
      assert(bands.length >= 2, `${model}: the actual gauge is painted in the upper and lower structural edges`);
      for (const [, y, , height] of bands) assert(y >= 0 && y + height <= depth + 1e-9, `${model}: no extra plate above the deck`);
      assert.equal(layout.top, 0);
      if (outline) assert.deepEqual(layout.outlines, outline); else outline = layout.outlines;
      keys.add(shape.key);
    }
    assert.equal(keys.size, thicknesses.length * 2, `${model}: a changed gauge or exposed metal never reuses the old picture`);
  }
});

test('solid chassis and guard previews follow the sloped nose and leave the wheel well open', () => {
  const layout = laid('tracked', 6), shape = chassisArtwork(layout, 0x68765a),
    preview = texturePreviewShape({ type: 'chassis', shape }), at = (outline, x, y) => ({ x: x - outline.left, y: y - outline.bottom });
  assert(within(at(preview, 3, -layout.depth / 2), preview.points));
  assert(!within(at(preview, .01, -layout.depth + .01), preview.points), 'the sloped nose is not a filled bounding box');
  for (const guard of laid('wheeled', 6, { axles: [1, 2.2, 4.4] }).guards) {
    const outline = texturePreviewShape({ type: 'guard', shape: guard });
    assert(!within(at(outline, guard.axle.x, guard.axle.y + guard.inner / 2), outline.points), 'air above the tyre stays transparent');
    assert(within(at(outline, guard.axle.x, guard.axle.y + (guard.inner + guard.outer) / 2), outline.points), 'the fender band is solid');
  }
});

// Reuse the compiled bench and real damage projection; only the worker's delivery is held.
function pendingChassisArt(t, damaged = true, design = armoured('tracked')) {
  const f = bench(design, false, state => {
    if (!damaged) return;
    const frame = state.plates.find(plate => plate.definition.id === 'chassis:frame-0');
    frame.marks = [{ u: .5, v: .5, kind: 'hole', strength: 1 }]; frame.markRevision = 1;
  }), { renderer } = f;
  t.after(() => { renderer.board.clearParts(); renderer.board.clearLayers(); renderer.releaseTextures(true); });
  renderer.releaseTextures(true);
  let resolve, result;
  const painter = renderer.texturePainter = {
    available: true, busy: false,
    paint(request) { this.request = request; this.busy = true; return result = new Promise(done => { resolve = done; }); },
    async complete() {
      const picture = Object.assign(paintTextureCanvas(this.request, renderer.paintingMaterials()), {
        closes: 0, close() { this.closes++; },
      });
      this.busy = false; resolve(picture); await result; return picture;
    },
  };
  const draw = () => {
    renderer.frameNow += 100; renderer.usedTextures.clear(); renderer.nextTexturePaint = null;
    renderer.board.drawChassisArt(renderer.designState); renderer.releaseTextures();
  };
  draw(); return { ...f, painter, draw };
}

test('a pending chassis or guard never exposes resized bitmap geometry before the next frame fits it', async t => {
  const { renderer, layers, painter, draw } = pendingChassisArt(t, false);
  for (const [type, sprite] of [['chassis', layers.chassisArt.children[0]], ['guard', layers.chassisGuards.children[0]]]) {
    const entry = renderer.nextTexturePaint, width = sprite.width, height = sprite.height, pixels = entry.texture.width;
    assert.equal(entry.paint.type, type);
    renderer.paintNextTexture(); await painter.complete();
    assert(entry.texture.width > pixels * 10, type + ': the full picture replaces the small preview');
    // Pixi resizes Texture.orig as the canvas grows, before another game frame can reset the sprite's scale. Any
    // visible bitmap must keep its physical dimensions even in that interval; a hidden one still has its solid rim.
    assert(!sprite.visible || near(sprite.width, width, 1e-9) && near(sprite.height, height, 1e-9),
      `${type}: ${sprite.width} × ${sprite.height} shown instead of ${width} × ${height}`);
    if (!sprite.visible) assert(sprite.rim.visible, type + ': the current solid outline remains visible');
    draw();
    assert(sprite.visible); assert(near(sprite.width, width, 1e-9) && near(sprite.height, height, 1e-9));
    assert(!sprite.rim?.visible, type + ': the finished bitmap replaces the preview');
  }
});

test('damaged chassis and skirt finish offscreen in place, refreshing the same damage sources on return', async t => {
  const { renderer, layers, painter, draw } = pendingChassisArt(t), before = structuredClone(renderer.designState),
    layout = layers.chassisShape.layout, seats = layers.chassisSeats;
  for (const [type, sprite] of [['chassis', layers.chassisArt.children[0]], ['guard', layers.chassisGuards.children[0]]]) {
    const entry = renderer.nextTexturePaint, base = entry.texture, baseSource = base.source, baseCanvas = baseSource.resource,
      damaged = sprite.texture, source = damaged.source, picture = source.resource,
      copy = [...renderer.textures.values()].find(entry => entry.texture === damaged), pose = [sprite.x, sprite.y, sprite.width, sprite.height];
    assert.equal(entry.paint.type, type); assert.notEqual(damaged, base); assert.match(copy.revision, /:preview$/);
    assert.equal(baseSource.autoGenerateMipmaps, true); assert.equal(baseSource.style.mipmapFilter, 'linear');
    let uploads = 0; source.on('update', () => uploads++);
    renderer.paintNextTexture(); renderer.board.unseen.add('local'); draw();
    const reply = await painter.complete();
    assert.equal(reply.closes, 1); assert.equal(entry.texture, base); assert.equal(base.source, baseSource); assert.equal(baseSource.resource, baseCanvas);
    assert.deepEqual([baseCanvas.width, baseCanvas.height], [reply.width, reply.height]);
    draw(); assert.equal(uploads, 0, 'hidden damage does not upload');
    renderer.board.unseen.delete('local'); draw();
    assert.equal(sprite.texture, damaged); assert.equal(damaged.source, source); assert.equal(source.resource, picture);
    assert.deepEqual([picture.width, picture.height], [reply.width, reply.height]); assert(!copy.revision.endsWith(':preview')); assert.equal(uploads, 1);
    assert.deepEqual([sprite.x, sprite.y], pose.slice(0, 2)); assert(near(sprite.width, pose[2], 1e-9) && near(sprite.height, pose[3], 1e-9));
    draw(); assert.equal(uploads, 1);
  }
  assert.equal(layers.chassisShape.layout, layout); assert.equal(layers.chassisSeats, seats); assert.deepEqual(renderer.designState, before);
});

test('evicted chassis and guard results cannot overwrite a recreated entry with the same key', async t => {
  for (const type of ['chassis', 'guard']) {
    const { renderer, painter, draw } = pendingChassisArt(t);
    if (type === 'guard') { renderer.paintNextTexture(); await painter.complete(); draw(); }
    const entry = renderer.nextTexturePaint, oldSource = entry.texture.source;
    assert.equal(entry.paint.type, type); renderer.paintNextTexture();
    renderer.usedTextures.clear(); renderer.releaseTextures(); draw();
    const restored = renderer.textures.get(entry.key), source = restored.texture.source, picture = source.resource, size = [picture.width, picture.height];
    assert(oldSource.destroyed); assert.notEqual(restored, entry);
    const reply = await painter.complete(); draw();
    assert.equal(reply.closes, 1); assert.equal(renderer.textures.get(entry.key), restored); assert.equal(restored.texture.source, source);
    assert.equal(source.resource, picture); assert.deepEqual([picture.width, picture.height], size); assert(restored.paint);
  }
});

test('the rendered rail follows the selected physical stock profile when its gauge changes', () => {
  const source = createConstruction('scout'), thin = compileBlueprint(source),
    thick = compileBlueprint({ ...source, chassis: { ...source.chassis, thicknessMm: 16 } }), keys = new Set();
  for (const blueprint of [thin, thick]) {
    const { layout, place } = laidOut(blueprint), bottom = Math.min(...layout.outlines[0].map(p => p.y));
    assert(near(-bottom, blueprint.chassis.depth, 1e-9));
    assert(near(chassisPoint(place, 0, 0).y, blueprint.chassis.deck, 1e-9));
    assert(near(chassisPoint(place, 0, bottom).y, blueprint.chassis.deck - blueprint.chassis.depth, 1e-9));
    keys.add(chassisArtwork(layout, 0x68765a).key);
  }
  assert(thick.chassis.depth > thin.chassis.depth);
  assert.equal(keys.size, 2, 'a new height must never reuse the old cached rail');
});

test('the axles of the picture are those the chassis is built with, and a hull over a wheel has its arch round the axle', () => {
  for (const id of ['scout', 'recon', 'mortar', 'chassis', 'truck', 'supply', 'tanker']) {
    const blueprint = compileBlueprint(createConstruction(id)), { place, layout } = laidOut(blueprint),
      wheels = blueprint.modules.filter(m => m.kind === 'wheel'), axles = layout.axles.map(a => ({ ...chassisPoint(place, a.x, a.y), r: a.r }));
    assert.equal(axles.length, wheels.length, id);
    for (const wheel of wheels) assert(axles.some(a => near(a.x, wheel.x) && near(a.y, wheel.y) && near(a.r, wheel.width / 2)), `${id}: ${wheel.id}`);
    const arches = bodyPanelSurfaces(designFrame(blueprint)).flatMap(surface => hullLayout(surface.artPolygon, { ...surface.fittings(), side: 'outside' }).arches);
    assert(arches.length >= 1, id);
    for (const arch of arches) for (const x of arch.axles)
      assert(wheels.some(w => near(x, w.x) && near(arch.y, w.y) && near(arch.r, w.width / 2)), `${id}: an arch round the axles of wheels`);
    // Where one hull stands over all its wheels, each is under an arch.
    if (['scout', 'recon', 'mortar'].includes(id)) assert.equal(arches.flatMap(arch => arch.axles).length, wheels.length, id);
  }
});

test('changing frame gauge keeps the wheels where they stand, raising what stands over them, and draws each physical hub in place', () => {
  const original = createConstruction('scout');
  let hubs;
  for (const thicknessMm of [8, 20, 80, 125]) {
    const blueprint = compileBlueprint(withChassisThickness(original, thicknessMm)),
      { layout, place } = laidOut(blueprint), rig = suspensionRig('wheeled', layout),
      wheels = blueprint.modules.filter(part => part.kind === 'wheel'),
      current = wheels.map(({ id, x, y, width }) => ({ id, x, y, width }));
    if (hubs) assert.deepEqual(current, hubs, 'a thicker beam does not relocate its wheels');
    else hubs = current;
    for (const axle of layout.axles) {
      const at = chassisPoint(place, axle.x, axle.y), wheel = wheels.find(part => near(part.x, at.x));
      assert(wheel && near(at.y, wheel.y), 'drawn and physical hubs coincide');
      assert([axle.x, axle.y, axle.r, rig.housing].every(Number.isFinite));
    }
    for (const part of layout.parts.filter(part => part.hangs))
      assert(part.y - part.h / 2 > rig.axle - rig.r, 'support brackets clear the tyre ground plane');
  }
});

test('an armoured track has the skirt of its chassis from the deck over the whole of its upper run, under a hull or not, wherever its ends are', () => {
  for (const id of ['heavy', 'ifv', 'howitzer', 'tracked']) {
    // Without armour it has none: its upper run and the rollers under it show.
    assert.deepEqual(laidOut(compileBlueprint(createConstruction(id))).layout.guards, [], id);
    // The open-bed tracked fixture can lose one front support with its full load; losing two exceeds its frame capacity.
    const source = armoured(id), front = chassisFront(source.chassis), rear = chassisRear(source.chassis), frontShift = id === 'tracked' ? .75 : 1.5,
      designs = [source, withChassisTrackEnd(source, 'rear', rear - 2), withChassisTrackEnd(source, 'front', front + frontShift)],
      [original, shorterRear, shorterFront] = designs.map(design => chassisTrack(design.chassis));
    assert(shorterRear.rear < original.rear && near(shorterRear.front, original.front), `${id}: the rear end actually moves`);
    // A track is written from its front: moved there, its rear stands where whole road wheels end from the cell of its
    // front, within half a cell of where it was.
    assert(shorterFront.front > original.front && near(shorterFront.rear, original.rear, .025 + 1e-9), `${id}: the front end actually moves`);
    for (const design of designs) {
      const blueprint = compileBlueprint(design), { place, track, layout } = laidOut(blueprint), what = `${id} ${JSON.stringify(blueprint.chassis.track)}`;
      assert.deepEqual(layout.guards.map(guard => guard.kind), ['skirt'], what);
      const [skirt] = layout.guards, top = track.y + track.height / 2,
        a = chassisPoint(place, skirt.x - skirt.w / 2, skirt.y + skirt.h / 2), b = chassisPoint(place, skirt.x + skirt.w / 2, skirt.y - skirt.h / 2);
      assert(near(a.x, track.x - track.width / 2) && near(b.x, track.x + track.width / 2), `${what}: from one end of the track to the other`);
      assert(near(a.y, blueprint.chassis.deck), `${what}: from the deck`);
      assert(near(b.y, top - skirtCover(10) * track.height) && b.y > track.y, `${what}: over the upper run and the tops of the wheels`);
    }
  }
  // The 'tracked' has an open deck behind its hull, over the rear of its track: the skirt runs on under it.
  const blueprint = compileBlueprint(armoured('tracked')), { track } = laidOut(blueprint),
    under = bodyPanelSurfaces(designFrame(blueprint)).flatMap(surface => hullLayout(surface.artPolygon, { ...surface.fittings(), side: 'outside' }).tracks);
  assert(Math.max(...under.map(stretch => stretch.x1)) < track.x + track.width / 2 - 2);
});

test('the mountings of the wheels of a track are painted where it is gone, not under a track the chassis holds as it rides on its springs', () => {
  // The hull pitches on its springs over a track that keeps to the ground (as far as 1.8° braking hard back and forth): the
  // housing of the final drive, painted on the hull as large as the sprocket, stood out from under the belt.
  const mountings = layout => layout.parts.filter(part => ['boss', 'drive', 'idler'].includes(part.kind));
  for (const [model, spec] of Object.entries(CHASSIS_MODELS).filter(([, spec]) => spec.kind === 'tracked')) for (const sprocketFront of [true, false]) {
    const length = spec.length[1], track = trackOf(model, length),
      [held, gone] = [{ ...track, held: true }, track].map(track => laid(model, length, { track, sprocketFront }));
    assert.equal(mountings(held).length, 0, model);
    assert.deepEqual(new Set(mountings(gone).map(part => part.kind)), new Set(['boss', 'drive', 'idler']), model);
    assert.notEqual(held.key, gone.key, 'each a picture of its own');
    assert.deepEqual([held.outlines, held.axles, held.guards], [gone.outlines, gone.axles, gone.guards], 'the same chassis over the same track');
  }
  // The renderer lays out the chassis of a track it holds without them, and with them once the track has come off it.
  assert.equal(mountings(bench(createConstruction('tracked'), true).layers.chassisShape.layout).length, 0);
  const off = bench(createConstruction('tracked'), true, state => { state.modules.find(part => part.kind === 'track').attached = false; });
  assert.deepEqual(new Set(mountings(off.layers.chassisShape.layout).map(part => part.kind)), new Set(['boss', 'drive', 'idler']));
});

test('the skirt of an armoured track hangs lower the thicker it is, and is ribbed when it is thick', () => {
  // More of the track the thicker it is, six tenths at most.
  let last = 0;
  for (const mm of [5, 20, 40, 80, 200]) { const cover = skirtCover(mm); assert(cover > last || cover === .6, mm + ' mm'); assert(cover <= .6); last = cover; }
  const model = 'tracked', length = 7, track = { ...trackOf(model, length), middle: 3.5 },
    run = track.height + .01 - chassisSpec(model).deck, skirt = armorMm => laid(model, length, { track: { ...track, armorMm } }).guards[0],
    foot = guard => guard.y - guard.h / 2, [bare, light, thin, thick] = [0, 5, 10, 30].map(skirt);
  // None without armour, for the upper run to show.
  assert.equal(bare, undefined);
  for (const guard of [light, thin, thick]) assert(near(guard.y + guard.h / 2, 0) && near(guard.x, 3.5) && near(guard.w, track.width));
  assert(near(foot(light), run - skirtCover(5) * track.height) && foot(light) < run - .3 * track.height, 'over more than the upper run');
  assert(near(foot(thick), run - skirtCover(30) * track.height) && foot(thick) < foot(thin) && foot(thin) < foot(light));
  assert.deepEqual([light, thin, thick].map(guard => guard.ribbed), [false, false, true]);
  assert.equal(new Set([light, thin, thick].map(guard => guard.key)).size, 3, 'each painted for its own');
  // In sections a metre and a quarter long or so, the same every time.
  assert.equal(thin.cuts.length + 1, Math.round(track.width / 1.25)); assert.deepEqual(skirt(10), thin);
});

test('the deck of a chassis is in the shade of what stands on it, and in the light only where nothing does', () => {
  const { place, layout } = laidOut(compileBlueprint(createConstruction('scout'))), at = (x, y) => chassisPoint(place, x, y),
    foot = (x0, x1, y = 0) => [at(x0, y), at(x1, y)], { length } = layout;
  // Two feet that touch are one stretch; one past the front end is cut at it; one a hand over the deck does not stand on it.
  const seats = chassisSeats(place, layout, [foot(.5, 2), foot(1.99, 3, .01), foot(3.5, 4, .2), foot(-1, .3)]);
  assert.deepEqual(seats, [[0, .3], [.5, 3]]);
  // What was told is kept while the feet stay within a centimetre of it, for nothing to be laid out anew for the jitter
  // of a frame; told anew when they move further.
  assert.equal(chassisSeats(place, layout, [foot(.505, 2), foot(1.99, 3.004, .01), foot(-1, .3)], seats), seats);
  assert.deepEqual(chassisSeats(place, layout, [foot(.55, 2), foot(1.99, 3, .01), foot(-1, .3)], seats), [[0, .3], [.55, 3]]);
  // The light along the deck: none over a seat, all of it between them and behind them.
  const { outlines: [points], others } = deckGlint(layout, seats), lit = upwardRuns(points, .005, others).map(run => [run[0].x, run.at(-1).x].sort((a, b) => a - b));
  assert.deepEqual(lit.map(span => span.map(x => Math.round(x * 1000) / 1000)), [[.3, .5], [3, length]]);
  // On the bench, the hull of the scout stands on the floor over its deck from end to end: dark under it, and its light
  // only by its ends.
  const { layers } = bench(createConstruction('scout'), true), [art] = [layers.chassisArt], [, ...shades] = art.children,
    floor = createConstruction('scout').chassis.topPlate.thicknessMm / 1000;
  assert.equal(layers.chassisSeats.length, 1);
  assert.equal(shades.length, 1);
  const [[x0, x1]] = layers.chassisSeats, [shade] = shades, xs = shade.geometry.positions.filter((_, i) => i % 2 === 0),
    ys = shade.geometry.positions.filter((_, i) => i % 2 === 1);
  assert(near(Math.min(...xs), x0) && near(Math.max(...xs), x1) && near(Math.max(...ys), floor) && near(Math.min(...ys), floor - layout.depth * .8),
    'down the floor and the web from the top of the floor');
});

// Whether a point is within a convex outline, given as points or as pairs, or on its edge.
const onto = (point, outline) => {
  const corners = outline.map(p => Array.isArray(p) ? { x: p[0], y: p[1] } : p),
    sides = corners.map((a, i) => { const b = corners[(i + 1) % corners.length]; return (b.x - a.x) * (point.y - a.y) - (b.y - a.y) * (point.x - a.x); });
  return sides.every(side => side >= -1e-6) || sides.every(side => side <= 1e-6);
};
// The corners of a mesh of the shade, and how much it covers.
const shadeOf = ({ positions, uvs, indices }) => {
  const at = i => ({ x: positions[2 * i], y: positions[2 * i + 1], v: uvs[2 * i + 1] }), corners = Array.from({ length: positions.length / 2 }, (_, i) => at(i));
  let area = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const [a, b, c] = [at(indices[i]), at(indices[i + 1]), at(indices[i + 2])];
    area += Math.abs((b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x)) / 2;
  }
  return { corners, area };
};

test('the shade under what stands on a deck lies on the chassis and on its skirt, never on the air off a sloped nose', () => {
  for (const layout of layouts()) {
    // A hull from one end of the deck to the other, as every model has it from the front end on.
    const depth = layout.kind === 'wheeled' ? layout.depth * .8 : Math.min(.2, layout.depth * .5),
      { corners, area } = shadeOf(seatShadeGeometry([[0, layout.length]], depth, layout.straights));
    assert(corners.every(p => onto(p, layout.outlines[0])), `${layout.key}: on the chassis`);
    // All of the deck it falls on, as deep as it is laid, darkest at the deck: under the rail of a wheeled one, and
    // back from the nose of a tracked one, which slopes away from the front of its deck as deep as it goes down.
    assert(near(area, layout.length * depth - (layout.kind === 'tracked' ? depth * depth / 2 : 0), 1e-6), `${layout.key}: all of the deck`);
    assert(corners.every(p => near(p.v, -p.y / depth, 1e-6)), `${layout.key}: down the picture of the shade`);
    const skirt = layout.guards.find(guard => guard.kind === 'skirt');
    if (!skirt) continue;
    const under = shadeOf(seatShadeGeometry([[0, layout.length]], Math.min(.22, skirt.h * .45), skirt.deck));
    assert(under.corners.length && under.corners.every(p => onto(p, skirt.points)), `${layout.key}: on the skirt`);
  }
  // On the bench, a tracked model whose hull stands on the deck from its front end: none of its shade off the nose.
  const { layers } = bench(armoured('heavy'), true), layout = layers.chassisShape.layout, skirt = layout.guards.find(guard => guard.kind === 'skirt');
  assert.equal(layers.chassisSeats[0][0], 0, 'from the front end of the deck');
  const [, shade] = layers.chassisArt.children, [under] = layers.chassisSkirtShade.children;
  for (const [mesh, outline] of [[shade, layout.decks[0]], [under, skirt.points]])
    assert(shadeOf(mesh.geometry).corners.every(p => onto(p, outline)));
});

test('the shade under what stands on a deck is one picture for every deck, and the skirt of a track has it too', () => {
  const tracked = bench(armoured('heavy'), true), wheeled = bench(createConstruction('scout'), true);
  for (const { renderer, layers } of [tracked, wheeled]) {
    assert.equal([...renderer.textures.keys()].filter(key => key === 'seat-shade').length, 1);
    assert(layers.chassisSeats.length >= 1);
  }
  const [shade] = tracked.layers.chassisArt.children.slice(1), [under] = tracked.layers.chassisSkirtShade.children;
  assert.equal(shade.texture, under.texture);
  assert.equal(tracked.layers.chassisSkirtShade.parent, tracked.layers.guards);
  const index = parent => tracked.layers.guards.getChildIndex(parent);
  assert(index(tracked.layers.chassisSkirtShade) > index(tracked.layers.chassisGuards), 'over the skirt');
  assert(!wheeled.layers.chassisSkirtShade?.visible, 'a wheeled chassis has no skirt');
});

test('the wheels of a chassis have mudguards bent square over them, one over each group close together, clear of the tyres at their stop, down to stays on its rail', () => {
  for (const id of ['scout', 'recon', 'mortar', 'chassis', 'truck', 'supply', 'tanker']) {
    const source = createConstruction(id);
    for (const design of [source, withChassisAxle(source, 0, chassisFront(source.chassis) + 1.6)]) {
      const blueprint = compileBlueprint(design), { place, layout } = laidOut(blueprint), wheels = blueprint.modules.filter(m => m.kind === 'wheel'),
        { depth, length } = layout, what = `${id} ${JSON.stringify(blueprint.chassis.axles)}`;
      // One over each group of wheels under one fender (hull-details.ts `fenderGroups`), every wheel under one.
      assert.deepEqual(layout.guards.map(guard => [guard.kind, guard.axles.map(mm)]), fenderGroups(layout.axles).map(group => ['mudguard', group.axles.map(a => mm(a.x))]), what);
      assert.equal(layout.guards.flatMap(guard => guard.axles).length, wheels.length, what);
      for (const guard of layout.guards) {
        const { inner, outer } = fenderOver(guard.r), ends = [guard.axles[0], guard.axles.at(-1)];
        for (const x of guard.axles) {
          const axle = chassisPoint(place, x, guard.axle.y);
          assert(wheels.some(w => near(w.x, axle.x) && near(w.y, axle.y) && near(guard.r, w.width / 2)), `${what}: over the axle of a wheel`);
        }
        assert(near(guard.inner, inner) && near(guard.outer, outer) && near(guard.x, (ends[0] + ends[1]) / 2) && near(guard.half, (ends[1] - ends[0]) / 2), what);
        // Its band, from one foot over the tops to the other, is clear of every tyre all the way as built, and the tyre
        // risen to its stop meets it at most; its picture holds it.
        const band = fenderLine(guard.inner, guard.feet, guard.round, guard.half), edge = fenderLine(guard.outer, guard.feet, guard.round + outer - inner, guard.half);
        for (const x of guard.axles) assert(band.every(([u, v]) => Math.hypot(u - (x - guard.x), v) >= guard.inner - 1e-9
          && Math.hypot(u - (x - guard.x), v - WHEEL_RISE) >= guard.r - 1e-9), `${what}: its band clear of the tyre all the way`);
        assert(edge.every(([u, v]) => Math.abs(u) <= guard.w / 2 && guard.axle.y + v <= guard.y + guard.h / 2), `${what}: its picture holds its band`);
        // Its feet at its stays, no lower than the axle and no higher than six tenths of the way to its inner edge; cut
        // higher only where it would stand out of an end of the chassis, and then half a centimetre within it.
        const foot = Math.min(Math.max(guard.stay - guard.axle.y, 0), .6 * guard.inner);
        for (const [i, way] of [-1, 1].entries()) {
          const reach = guard.x + way * (guard.half + fenderAcross(guard.outer, guard.feet[i]));
          assert(guard.feet[i] >= foot - 1e-9 && guard.feet[i] <= .6 * guard.inner + 1e-9, what);
          assert(reach >= .005 - 1e-9 && reach <= length - .005 + 1e-9, `${what}: within the ends of the chassis`);
          if (guard.feet[i] > foot + 1e-9) assert(near(way < 0 ? reach : length - reach, .005, 1e-6), `${what}: cut at the end`);
        }
        assert(guard.y - guard.h / 2 <= guard.axle.y + Math.min(...guard.feet), `${what}: down to its stays`);
        assert(near(guard.y + guard.h / 2, guard.axle.y + guard.outer + .01) && guard.stay < 0 && guard.stay > -depth, `${what}: from the web of the rail`);
        assert(guard.w >= 2 * (guard.half + guard.outer) && guard.y - guard.h / 2 < guard.stay, `${what}: its picture holds it and its stays`);
      }
      // No two meet, nor leave less than a band between them.
      for (const [i, guard] of layout.guards.entries()) for (const other of layout.guards.slice(i + 1))
        assert(Math.abs(other.x - guard.x) - guard.half - other.half - guard.outer - other.outer >= Math.max(guard.outer - guard.inner, other.outer - other.inner) - 1e-9, `${what}: apart`);
    }
  }
  // One picture for every mudguard of a shape, in a paint.
  assert.equal(new Set(laid('wheeled', 6, { axles: [1, 3, 5] }).guards.map(guard => guard.key)).size, 1);
  // The truck has a separate front axle and a rear tandem; the recon one group of three, the scout and mortar one per axle.
  const counts = Object.fromEntries(['scout', 'recon', 'mortar', 'truck'].map(id => [id, laidOut(compileBlueprint(createConstruction(id))).layout.guards.map(guard => guard.axles.length)]));
  assert.deepEqual(counts, { scout: [1, 1], recon: [3], mortar: [1, 2], truck: [1, 2] });
  // Two wheels as close as their axles may stand: one over the two; a wheel further on has its own.
  assert.deepEqual(laid('wheeled', 6, { axles: [1, 2.2, 4.4] }).guards.map(guard => guard.axles.map(mm)), [[1, 2.2], [4.4]]);
  // A wheel so near an end of the chassis that its fender would stand out of it: its foot cut higher at that end.
  const [nearEnd] = laid('wheeled', 6, { axles: [.6, 4.4] }).guards;
  assert(nearEnd.feet[0] > nearEnd.feet[1], 'cut at the front end');
});

test('the chassis hangs a mudguard in front of every wheel, but where a hull seen cut open stands over its axle', () => {
  // Outside, the fender stands out in front of the hull or the body over the wheels, whose foot has the well behind it.
  // Cut open, a hull shows no fender over a wheel it stands over, and the wall behind is drawn whole; the wheels under
  // the same fender it does not stand over, a cab over only the top of a wheel, and a body out in the open keep one, of
  // their own. The axles of the truck and of the recon moved too: the first under the cab or the hull still.
  for (const id of ['truck', 'supply', 'tanker', 'recon', 'chassis']) {
    const source = createConstruction(id), designs = ['truck', 'recon'].includes(id) ? [source, withChassisAxle(source, 0, chassisFront(source.chassis) + 1.6)] : [source];
    for (const design of designs) for (const exterior of [true, false]) {
      const { blueprint, layers } = bench(design, exterior), { place, layout } = laidOut(blueprint), guards = layers.chassisGuards,
        stood = bodyPanelSurfaces(designFrame(blueprint)).flatMap(surface => hullLayout(surface.artPolygon, { ...surface.fittings(), side: 'inside' }).arches).flatMap(arch => arch.over),
        bare = layout.axles.map(axle => !exterior && stood.some(x => near(x, chassisPoint(place, axle.x, axle.y).x))),
        hung = bare.some(Boolean) ? mudguardsOver(layout, layout.axles.filter((_, i) => !bare[i])) : layout.guards;
      assert(guards.parent === (exterior ? layers.guards : layers.chassis), 'wheel fenders use the current cutaway layer'); assert.deepEqual([guards.x, guards.y, guards.rotation], [layers.chassisArt.x, layers.chassisArt.y, layers.chassisArt.rotation]);
      assert.equal(guards.children.length, hung.length, `${id} ${exterior}`);
      for (const [i, child] of guards.children.entries()) {
        const guard = hung[i], expected = [guard.x - guard.w / 2, guard.y + guard.h / 2, guard.w, guard.h];
        assert(child.visible, `${id}: guard ${i}`);
        for (const [at, value] of [child.x, child.y, child.width, child.height].entries())
          assert(near(value, expected[at], 1e-9), `${id}: guard ${i}, box coordinate ${at}`);
      }
      // Every wheel but those the hull stands over is under one.
      assert.deepEqual(hung.flatMap(guard => guard.axles).map(mm), layout.axles.filter((_, i) => !bare[i]).map(axle => mm(axle.x)), `${id} ${exterior}`);
      // Cut open: a cab stands over the front axle, and over only the top of the wheel behind it; a hull over all the wheels.
      if (exterior) continue;
      if (id === 'recon') assert(bare.every(Boolean), 'a hull over all its wheels');
      else if (design === source) assert.deepEqual(bare, layout.axles.map((_, i) => i < (id === 'tanker' ? 2 : 1)), `${id}: a cab over its front axles`);
    }
  }
});

test('a body out in the open is painted in the paint of its construction as it is seen, its rear at the rear, and a full hopper is heaped over its rim, over its arm', () => {
  for (const id of ['truck', 'tanker', 'supply']) for (const exterior of [true, false]) for (const within of [false, true]) {
    // Full, and in another paint than the template's; a piece within a compartment is told by its `exposed`.
    const design = { ...createConstruction(id), appearance: { ...createConstruction(id).appearance, paint: '#5a6876' } },
      { blueprint, renderer, layers } = bench(design, exterior, state => { for (const module of state.modules) if (holdsCargo(module)) {
        module.cargo = id === 'tanker' ? { petroleo: 1e6 } : id === 'supply' ? { ferro: 1e5, petroleo: 1e6 } : { ferro: 1e5 };
        if (within) module.exposed = false;
      } }),
      piece = blueprint.modules.find(holdsCargo), item = renderer.board.drawables.get(piece.id), what = `${id} ${exterior ? 'outside' : 'cut open'}${within ? ' within' : ''}`;
    assert.deepEqual([item.body.paint, item.body.side], [within ? undefined : 0x5a6876, exterior ? 'outside' : 'inside'], what);
    assert.equal(item.group.scale.x, piece.mirrored ? -1 : 1, `${what}: authored parity reflects the canonical cargo picture`);
    assert.equal(item.body.arches.length, within ? 0 : 1, `${what}: the wheels behind the cab, under one fender with the one under it`);
    assert(item.textureKeys.some(key => key.startsWith(`component:${piece.kind}:`) && key.endsWith(`:${within ? '' : 0x5a6876}/${item.body.side}/${item.body.mirror * renderer.board.camera.turn}` +
      item.body.arches.map(arch => `/${arch.x},${arch.y},${arch.r},${arch.half}`).join(''))), `${what}: painted so`);
    if (id !== 'truck') { assert(!item.heap?.visible, what); continue; }
    // Laid on the piece as its group lies, in the layer over the arm folded on it, seen from outside or cut open.
    const over = heapOver(piece.width, piece.height, 4), heap = item.heap, [picture] = heap.children, container = layers.body;
    assert(heap.visible && heap.parent === layers.heaps && container.getChildIndex(layers.heaps) > container.getChildIndex(layers.gun), what);
    assert(item.textureKeys.includes(`heap:${piece.width.toFixed(3)}:${piece.height.toFixed(3)}:4:ferro`), what);
    assert(near(heap.x, item.group.x) && near(heap.y, item.group.y) && heap.rotation === item.group.rotation && heap.scale.x === item.group.scale.x, what);
    assert(near(picture.x, over.x0 - piece.width / 2) && near(picture.y, piece.height / 2 + over.height) && near(picture.width, over.x1 - over.x0) && near(picture.height, over.height), what);
  }
});

test('a chassis has one picture in either view, with damage and authored floors but no duplicate frame strips', () => {
  for (const id of ['truck', 'tracked', 'heavy']) {
    const ids = blueprint => blueprint.plates.filter(plate => plate.chassis).map(plate => plate.id),
      // A hole in the middle of the frame plate, over the running gear.
      marked = state => { const frame = state.plates.find(plate => plate.definition.id === 'chassis:frame-0'); frame.marks = [{ u: .5, v: .5, kind: 'hole', strength: 1 }]; frame.markRevision = 1; };
    for (const exterior of [true, false]) {
      const { blueprint, renderer, layers } = bench(id === 'truck' ? createConstruction(id) : armoured(id), exterior, marked);
      assert(ids(blueprint).length >= 2, id);
      assert.deepEqual(ids(blueprint).map(plate => renderer.board.drawables.has(plate)), ids(blueprint).map(() => false), `${id}: no generic frame plate over the chassis picture`);
      assert.deepEqual(renderer.designState.plates.map(plate => plate.definition), blueprint.plates, 'the physical plate definitions stay intact');
      if (!exterior) assert(blueprint.plates.some(plate => !plate.chassis && renderer.board.drawables.has(plate.id)), `${id}: authored hull plates stay visible`);
      assert(layers.chassisKeys.some(key => key.startsWith('chassis-damage:local:')), `${id}: the hole on the picture of the chassis`);
      if (id !== 'truck') assert(layers.chassisKeys.some(key => key.startsWith('chassis-guard-damage:local:0:')), `${id}: and on its skirt`);
    }
  }
});

test('a missing or detached frame keeps physical plate pieces instead of an intact chassis picture', () => {
  for (const flag of ['detached', 'fragment', 'attached']) {
    const { renderer, layers } = bench(createConstruction('chassis'), false, state => {
      state.plates.find(plate => plate.definition.id === 'chassis:frame-0')[flag] = flag === 'attached' ? false : true;
    });
    assert.equal(chassisFrame(renderer.board.scene.frame.actorParts.get('local')), undefined, flag);
    assert(!layers.chassisArt?.visible && !layers.chassisGuards?.visible, flag);
    assert(renderer.board.drawables.has('chassis:frame-0') && renderer.board.drawables.has('chassis:rail-0'), `${flag}: real plate pieces remain`);
  }
});

test('selection outlines the frame of the chassis as it is drawn and compiled, mitred at its knees, without restoring its generic material mesh', () => {
  // What is stroked about the chassis selected: each outline, its points where the world has them.
  const stroked = renderer => renderer.board.overlay.context.instructions.filter(item => item.action === 'stroke' && item.data.style.color === 0xffcd8d)
    .map(item => item.data.path.instructions.find(step => step.action === 'poly')?.data[0]);
  const same = (drawn, blueprint, what) => {
    assert.equal(drawn.length, blueprint.chassis.outlines.length, `${what}: one outline for each part of it`);
    for (const [k, outline] of blueprint.chassis.outlines.entries()) {
      assert.equal(drawn[k]?.length, 2 * outline.length, what);
      for (const [i, p] of outline.entries()) assert(near(drawn[k][2 * i], p.x, 1e-9) && near(drawn[k][2 * i + 1], p.y, 1e-9), `${what}: point ${i} of outline ${k}`);
    }
  };
  const { renderer, blueprint } = bench(createConstruction('chassis'), false);
  renderer.view.editor.selectionIds = ['chassis:frame-0']; renderer.draw({ now: 20 });
  assert(!renderer.board.drawables.has('chassis:frame-0'));
  same(stroked(renderer), blueprint, 'straight');
  // A chassis in stretches is one piece: the plate of one selected, the whole frame is outlined, along its knees.
  const source = JSON.parse(readFileSync(new URL('./fixtures/editor-chassis.json', import.meta.url), 'utf8')), { x: x0, y: y0 } = source.chassis.points[0],
    points = [{ x: 0, y: 0 }, { x: 61, y: 0 }, { x: 67, y: 5 }, { x: 74, y: 5 }, { x: 80, y: 0 }, { x: 108, y: 0 }].map(p => ({ x: x0 + p.x, y: y0 + p.y })),
    stretched = bench({ ...source, chassis: { ...source.chassis, points } }, false), frames = stretched.blueprint.plates.filter(plate => plate.chassis?.part === 'frame');
  assert.equal(frames.length, points.length - 1);
  for (const id of ['chassis:frame-0', 'chassis:frame-3']) {
    stretched.renderer.view.editor.selectionIds = [id]; stretched.renderer.draw({ now: 20 });
    same(stroked(stretched.renderer), stretched.blueprint, id);
  }
});

test('actual compiled wheel diameter and deck drive guards, axle positions and art cache keys', () => {
  for (const [model, spec] of Object.entries(CHASSIS_MODELS).filter(([, spec]) => spec.kind === 'wheeled')) {
    const keys = [];
    for (const scale of [.75, 1, 1.5]) {
      const wheelDiameter = spec.wheel * scale, deck = spec.deck + (wheelDiameter - spec.wheel) / 2,
        dimensions = { wheelDiameter, deck, depth: spec.depth }, length = spec.length[1],
        layout = laid(model, length, { ...dimensions, axles: [1.6, length - 1.6] }), rig = suspensionRig(model, dimensions);
      assert(near(rig.r, wheelDiameter / 2) && near(rig.axle + deck, wheelDiameter / 2 + .01), model);
      for (const axle of layout.axles) assert(near(axle.r, wheelDiameter / 2) && near(axle.y + deck, wheelDiameter / 2 + .01), model);
      for (const guard of layout.guards) assert(near(guard.r, wheelDiameter / 2) && guard.inner > wheelDiameter / 2, `${model}: guard clears actual tyre`);
      assert.equal(new Set(layout.guards.map(guard => guard.key)).size, 1, `${model}: one guard texture for a uniform wheel size`);
      keys.push(layout.key);
    }
    assert.equal(new Set(keys).size, 3, `${model}: changed dimensions cannot reuse an old chassis picture`);
  }
});

test('scaled track guards follow the actual deck while the tub retains its real depth', () => {
  for (const [model, spec] of Object.entries(CHASSIS_MODELS).filter(([, spec]) => spec.kind === 'tracked')) for (const scale of [.75, 1, 1.5]) {
    const height = spec.track * scale, deck = spec.deck + height - spec.track, depth = spec.deck - spec.clearance,
      track = { width: spec.length[0] * .8, height, y: height / 2 + .01 - deck, armorMm: 10 }, layout = laid(model, spec.length[0], { track, deck, depth }), [skirt] = layout.guards;
    assert(near(-layout.outlines[0][2].y, depth), model);
    assert(near(skirt.y + skirt.h / 2, 0), `${model}: top stays on the real deck`);
    assert(near(deck + skirt.y - skirt.h / 2, height + .01 - skirtCover(10) * height), `${model}: skirt covers the actual upper run`);
  }
});

test('a guard is painted once for its shape and its paint, however many hang and however often they are drawn', () => {
  // The mortar carrier: a mudguard over each of its three wheels, far enough apart to have one each.
  const { renderer, layers } = bench(createConstruction('scout'), true), [first, second] = layers.chassisGuards.children, texture = first.texture;
  assert(first.visible && second.visible);
  assert.equal(second.texture, texture);
  renderer.draw({ now: 20 });
  assert.equal(layers.chassisGuards.children[1].texture, texture);
  assert.equal([...renderer.textures.keys()].filter(key => key.startsWith('chassis-mudguard:')).length, 1);
  const other = bench({ ...createConstruction('scout'), appearance: { paint: '#5a6876' } }, true).renderer;
  assert.notDeepEqual([...other.textures.keys()].filter(key => key.startsWith('chassis-mudguard:')), [...renderer.textures.keys()].filter(key => key.startsWith('chassis-mudguard:')));
});


test('cutaway wheel fenders and their solid previews stay behind plate sections across view changes', t => {
  const f = pendingChassisArt(t, false, createConstruction('chassis')), { renderer, layers, blueprint } = f,
    shape = layers.chassisShape, geometry = JSON.stringify({ chassis: blueprint.chassis, plates: blueprint.plates }),
    tool = layers.guards.addChild(new Container()), order = layer => layers.body.getChildIndex(layer);
  assert.equal(shape.layout.kind, 'wheeled');
  for (const [i, outside] of [false, true, false].entries()) {
    renderer.view.exterior = outside; renderer.draw({ now: (i + 1) * 20 });
    const guards = layers.chassisGuards, preview = layers.chassisGuardPreviews, parent = guards.parent;
    assert.equal(renderer.board.closed.has('local'), outside, 'use the same view as the real surfaces');
    assert(guards.children.length > 0 && preview.children.length > 0, 'retain both the fender and its pending solid outline');
    assert(parent === (outside ? layers.guards : layers.chassis), 'wheel fenders sit behind plate sections only in cutaway');
    assert(preview.parent === parent, 'pending art cannot return to the foreground on its own');
    assert(parent.getChildIndex(preview) > parent.getChildIndex(guards), 'the solid outline replaces its own fender');
    assert.equal(order(parent) > order(layers.plateLayer), outside, 'only the exterior fender covers real plate sections');
    if (outside) assert(parent.getChildIndex(tool) > parent.getChildIndex(preview), 'return below existing tool guards');
    else assert(parent.getChildIndex(guards) > parent.getChildIndex(layers.chassisArt), 'above the chassis base and deck shade');
    for (const drawn of [guards, preview]) assert.deepEqual([drawn.x, drawn.y, drawn.rotation, drawn.scale.y],
      [layers.chassisArt.x, layers.chassisArt.y, layers.chassisArt.rotation, layers.chassisArt.scale.y]);
    assert(tool.parent === layers.guards, 'tool guards keep their own layer');
    assert(layers.chassisShape === shape, 'view changes retain the chassis artwork cache');
    assert.equal(JSON.stringify({ chassis: blueprint.chassis, plates: blueprint.plates }), geometry, 'physical geometry is unchanged');
  }
  const tracked = pendingChassisArt(t, false), skirt = tracked.layers.chassisShape;
  assert(skirt.layout.guards.some(guard => guard.kind === 'skirt'), 'the control has a paid track skirt');
  for (const [i, outside] of [false, true, false].entries()) {
    tracked.renderer.view.exterior = outside; tracked.renderer.draw({ now: (i + 1) * 20 });
    assert(tracked.layers.chassisGuards.parent === tracked.layers.guards, 'paid track skirt retains its foreground');
    assert(tracked.layers.chassisGuardPreviews.parent === tracked.layers.guards, 'paid track skirt preview retains its foreground');
    assert(tracked.layers.chassisShape === skirt, 'track artwork is retained across view changes');
  }
});

test('the renderer reads structural gauge and exposed metal from the compiled frame and retains their picture between draws', () => {
  const source = createConstruction('chassis'), original = bench(source, false),
    changed = bench({ ...source, chassis: { ...source.chassis, thicknessMm: 16, metal: 'aluminum' } }, false),
    frame = changed.blueprint.plates.find(part => part.id === 'chassis:frame-0'), shape = changed.layers.chassisShape;
  assert.equal(shape.layout.thicknessMm, frame.thicknessMm);
  assert.equal(shape.layout.metal, frame.material);
  assert.notEqual(shape.key, original.layers.chassisShape.key);
  assert.equal(changed.blueprint.plates.filter(part => part.chassis).length, original.blueprint.plates.filter(part => part.chassis).length,
    'changing artwork does not introduce an extra physical deck or frame piece');
  const texture = changed.layers.chassisArt.children[0].texture;
  changed.renderer.draw({ now: 20 });
  assert.equal(changed.layers.chassisShape, shape); assert.equal(changed.layers.chassisArt.children[0].texture, texture);
});

test('the picture of a chassis is the same every time, and tells apart what it was laid out for', () => {
  const keys = new Set();
  for (const layout of layouts()) {
    assert.deepEqual(laid(layout.model, layout.length, layout.kind === 'tracked' && layout.parts.some(p => p.kind === 'drive')
      ? { track: trackOf(layout.model, layout.length), sprocketFront: layout.key.split(':').includes('ahead') } : {}), layout);
    keys.add(layout.key);
  }
  assert.equal(keys.size, layouts().length);
  const layout = laid('wheeled', 5.2);
  assert.notEqual(chassisArtwork(layout, 0x68765a).key, chassisArtwork(layout, 0x5a6876).key, 'painted for its paint');
});

test('the picture lies on the frame of its chassis, the right way round whichever way the vehicle faces, tilted with it', () => {
  const blueprint = compileBlueprint(createConstruction('recon')), { frame } = plates(blueprint), { front, deck } = blueprint.chassis;
  // Facing left, as a design is: from its front end at the top of its deck, towards its rear.
  const left = chassisPlacement(poseOf(frame), frame.chassis);
  assert(near(left.origin.x, front) && near(left.origin.y, deck));
  assert(near(left.along.x, 1) && near(left.up.y, 1) && !left.mirrored);
  // Facing right, as the world lays it out: the mirror of it, its front end at the right.
  const mirror = plate => ({ ...poseOf(plate), x: 24 - plate.x, angle: Math.PI - plate.angle }), right = chassisPlacement(mirror(frame), frame.chassis);
  assert(near(right.origin.x, 24 - left.origin.x) && near(right.origin.y, deck) && near(right.along.x, -1) && right.mirrored);
  for (const [x, y] of [[0, 0], [2, -.2], [5.2, -.25]]) {
    const a = chassisPoint(left, x, y), b = chassisPoint(right, x, y);
    assert(near(b.x, 24 - a.x) && near(b.y, a.y));
  }
  // Tilted with its hull about a point, it is tilted about that point.
  for (const ANGLE of [.3, Math.PI / 2 - .001, Math.PI / 2, Math.PI / 2 + .001, Math.PI - .001, Math.PI, Math.PI + .001, Math.PI * 2]) {
    const c = Math.cos(ANGLE), s = Math.sin(ANGLE), turn = p => ({ x: 12 + (p.x - 12) * c - (p.y - 1) * s, y: 1 + (p.x - 12) * s + (p.y - 1) * c }),
      tilted = chassisPlacement({ ...poseOf(frame), ...turn(frame), angle: frame.angle + ANGLE }, frame.chassis, ANGLE);
    assert.equal(tilted.mirrored, left.mirrored);
    for (const [x, y] of [[0, 0], [2, -.2], [5.2, -.25]]) {
      const a = turn(chassisPoint(left, x, y)), b = chassisPoint(tilted, x, y), back = chassisLocal(tilted, b);
      assert(near(a.x, b.x) && near(a.y, b.y) && near(back.x, x) && near(back.y, y));
    }
  }
});

test('a mark on a plate of the chassis lands on its picture where it struck, whichever way the vehicle faces', () => {
  const blueprint = compileBlueprint(createConstruction('recon')), { frame } = plates(blueprint), { model, length } = blueprint.chassis,
    shape = chassisArtwork(laid(model, length), 0x68765a), mirror = { ...poseOf(frame), x: 24 - frame.x, angle: Math.PI - frame.angle };
  for (const place of [chassisPlacement(poseOf(frame), frame.chassis), chassisPlacement(mirror, frame.chassis)]) {
    const mark = { ...chassisPoint(place, 1.5, -.12), radius: .02, angle: 0, kind: 'hole', u: .3, v: .5 }, [impact] = chassisImpactLayout(place, shape, [mark]).impacts;
    assert(Math.hypot(impact.x - (1.5 - shape.left), impact.y - .12) <= mark.radius * .66, 'a little within, where it struck');
    assert.equal(impact.kind, 'hole');
  }
});

test('the preview of a construction shows its chassis, and a plate of the chassis is told as the chassis', () => {
  const blueprint = compileBlueprint(createConstruction('recon')), [outline] = blueprint.chassis.outlines;
  const svg = constructionSVG(blueprint), box = svg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);
  assert(svg.includes(`points="${outline.map(p => `${p.x},${-p.y}`).join(' ')}" fill="#3b463c"`));
  assert.deepEqual(constructionBounds(blueprint), { x: box[0], y: box[1], width: box[2], height: box[3] });
  const { frame, rail } = plates(blueprint);
  assert.deepEqual([partName(frame), partName(rail)], Array(2).fill(chassisName(blueprint.chassis.model)));
});

test('the mark of a design in the column is a mask of what is seen of it from outside, each part apart, filling the box of its button', () => {
  const box = { width: 54, height: 25 }, mark = design => constructionSilhouette(design, box).whole, blueprint = compileBlueprint(createConstruction('recon')), svg = mark(blueprint);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="54" height="25" viewBox="0 0 54 25">/);
  // White where the design is, through a mask: a gap round each part is a gap, in no colour but the one it masks.
  assert.match(svg, /<mask id="m"[^>]*><g fill="#fff" stroke="#000" stroke-width="1\.2" stroke-linejoin="round" paint-order="stroke">/);
  assert.match(svg, /<rect width="54" height="25" fill="#fff" mask="url\(#m\)"\/><\/svg>$/);
  assert.deepEqual([...new Set(svg.match(/#[0-9a-f]{3,6}\b/gi))].sort(), ['#000', '#666', '#fff'], 'white, the gaps, and the paler tone of the running gear');
  // Places to the hundredth of a pixel, all within the box, and as far out as the shape lets it at one side or the other.
  const numbers = [...svg.matchAll(/(?:[MLZ ]|cx="|cy=")(-?\d+(?:\.\d+)?)/g)].map(m => m[1]);
  assert(numbers.every(n => !/\.\d{3}/.test(n)), 'to the hundredth');
  const corners = [...svg.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map(m => [Number(m[1]), Number(m[2])]),
    discs = [...svg.matchAll(/cx="([\d.]+)" cy="([\d.]+)" r="([\d.]+)"/g)].map(m => m.slice(1).map(Number)),
    points = [...corners, ...discs.flatMap(([x, y, r]) => [[x - r, y - r], [x + r, y + r]])], span = i => Math.max(...points.map(p => p[i])) - Math.min(...points.map(p => p[i]));
  assert(points.every(([x, y]) => x >= .58 && x <= 53.42 && y >= .58 && y <= 24.42), 'within the box, clear of the edge by a gap');
  assert(span(0) > 52.7 || span(1) > 23.7, 'as large as the box lets it');
  // Each wheel a tyre in the paler tone round a hub in the full one; along a track, its road wheels, its sprocket and its idler.
  assert.equal(svg.match(/<circle [^>]*fill="#666"\/>/g).length, 3); assert.equal(svg.match(/<circle /g).length, 6);
  const tracked = compileBlueprint(createConstruction('construction-truck')), track = tracked.modules.find(m => m.kind === 'track'), crawler = mark(tracked);
  assert.equal(crawler.match(/<circle /g).length, trackWheels(track.width, track.height).road.length + 2);
  assert.equal(crawler.match(/<path [^>]*fill="#666"\/>/g).length, 1, 'the belt of the track round them');
  // What is within the hull is not seen; what stands out in the open is.
  assert.equal(mark({ ...blueprint, modules: blueprint.modules.filter(m => m.kind !== 'engine') }), svg);
  assert.notEqual(mark({ ...tracked, modules: tracked.modules.filter(m => m.kind !== 'supply') }), crawler);
  // A gun is never thinner than a pixel, cut clear of what is behind it, and goes into the hull it stands in.
  assert.match(svg, /<path d="[^"]+" fill="#000" stroke-width="2"\/><path d="[^"]+" stroke="#fff" stroke-width="0\.8"\/>/);
  assert.equal(mark(compileBlueprint(createConstruction('recon'))), svg, 'the same design is drawn the same');
  assert.notEqual(mark(compileBlueprint(createConstruction('bunker'))), mark(compileBlueprint(createConstruction('outpost'))), 'two defences are told apart');
  assert.equal(constructionSilhouette({ ...blueprint, plates: [], modules: [], chassis: null, bodyPanels: [] }, box), null, 'nothing in it, no mark');
  assert.deepEqual([constructionSilhouette(blueprint, box).hurt, constructionSilhouette(blueprint, box).lost], ['', ''], 'nothing damaged, no layer of damage');
});

// The mark of a construction in the column, as damaged as it is (squad-ux.ts): a layer of each colour, each over the same box.
test('the mark of a damaged design has a layer for each colour of its damage, each part in that of its worst piece, and pieces within the hull over it', () => {
  const box = { width: 54, height: 25 }, blueprint = compileBlueprint(createConstruction('recon')), plain = constructionSilhouette(blueprint, box),
    marked = damage => constructionSilhouette(blueprint, { ...box, damage }),
    // What a layer draws, in order: what shows in it in white or in the paler tone, and in black what is drawn in another.
    shapes = svg => [...svg.matchAll(/<(?:path|circle) ([^>]*)\/>/g)].map(([, attrs]) => ({ attrs,
      lit: !attrs.includes('fill="#000"') && !(attrs.includes('fill="none"') && !attrs.includes('stroke="#fff"')) })),
    lit = svg => shapes(svg).filter(shape => shape.lit).map(shape => shape.attrs);
  assert.deepEqual(marked({}), plain, 'nothing damaged');
  // A wheel shot off: its tyre and its hub in the layer of what is lost, where they were, and out of the others.
  const wheel = marked({ 'chassis:wheel-0': 'lost' }), circles = lit(plain.whole).filter(attrs => attrs.startsWith('cx='));
  assert.deepEqual(lit(wheel.lost), circles.slice(0, 2)); assert.equal(wheel.hurt, '');
  assert.deepEqual(lit(wheel.whole), lit(plain.whole).filter(attrs => !circles.slice(0, 2).includes(attrs)), 'the rest as it was, in the same box');
  // An engine damaged within the hull is drawn over the hull, with a gap round it; whole, it is not seen.
  const engine = marked({ engine: 'hurt' });
  assert.equal(lit(engine.hurt).length, 1); assert.equal(engine.lost, '');
  assert.deepEqual([shapes(engine.whole).length, lit(engine.whole)], [shapes(plain.whole).length + 1, lit(plain.whole)]);
  // A plate of the hull as a line along it over the hull, never thinner than a pixel and a fifth; a gun with its own edge.
  const roof = marked({ 'hull:roof': 'lost', weapon: 'hurt' });
  assert.deepEqual(lit(roof.lost).map(attrs => attrs.match(/fill="none" stroke="#fff" stroke-width="1.2"$/) !== null), [true]);
  assert.deepEqual(lit(roof.hurt).map(attrs => / stroke="#fff" stroke-width="0.8"$/.test(attrs)), [true]);
  assert(!roof.whole.includes('stroke="#fff"'), 'the gun is not in the layer of what is whole');
  // The chassis is in the layer of the worst of its plates.
  const chassis = marked({ 'chassis:frame-0': 'hurt', 'chassis:rail-0': 'lost' });
  assert.deepEqual([chassis.hurt, lit(chassis.lost)], ['', [lit(plain.whole)[0]]]);
});

// A chassis along its points (plano.md): the motor grader's with a gap from behind its front axle to its tandem, the
// chassis of the catalogue raised over a hump between its last two axles, and a tub with a gap before its rear end.
const GAP = [{ x: 0, y: 0 }, { x: .9, y: 0, gap: true }, { x: 5.3, y: 0 }, { x: 8.2, y: 0 }],
  HUMP = [{ x: 0, y: 0 }, { x: 3.05, y: 0 }, { x: 3.35, y: .25 }, { x: 3.7, y: .25 }, { x: 4, y: 0 }, { x: 5.4, y: 0 }];

test('a chassis with a gap has a rail for each part of it, square at the gap, and what holds its springs and fenders there is held to the end of the rail', () => {
  const layout = laid('wheeled', 8.2, { axles: [.75, 5.8, 7.3], profile: GAP }), ends = [.9, 5.3];
  assert.equal(layout.outlines.length, 2);
  assert.deepEqual(layout.straights.map(line => [line.a.x, line.b.x, line.angle, line.part]), [[0, .9, 0, 0], [5.3, 8.2, 0, 1]]);
  assert.deepEqual(layout.runs, [{ from: 0, to: .9, inner: [false, true] }, { from: 5.3, to: 8.2, inner: [true, false] }]);
  // Nothing in the gap but the brackets of the springs that fall in it, from the end of the rail out to their pins.
  for (const part of layout.parts) {
    const left = part.x - part.w / 2, right = part.x + part.w / 2;
    if (right <= ends[0] + 1e-9 || left >= ends[1] - 1e-9) continue;
    assert(['hanger', 'shackle', 'bracket'].includes(part.kind) && ends.includes(part.end), `${part.kind} at ${part.x}`);
    assert(left <= Math.min(part.end, part.pinX) + 1e-9 && right >= Math.max(part.end, part.pinX) - 1e-9, `${part.kind}: from the end of the rail to its pin`);
  }
  assert(layout.parts.some(part => part.kind === 'shackle' && part.end === .9), 'the shackle of the front axle, behind it over the gap');
  // The rail square at either side of the gap, a plate of a cross member at its end.
  for (const [end, way] of [[.9, -1], [5.3, 1]])
    assert(layout.parts.some(part => part.kind === 'gusset' && way * (part.x - end) - part.w / 2 > 0 && way * (part.x - end) - part.w / 2 < .05), `a gusset by ${end}`);
  // A fender over the wheels of each part, never over the gap to the other; the stay of one whose wheel stands out over
  // the gap is bolted to the end of the rail.
  assert.deepEqual(layout.guards.map(guard => guard.axles), [[.75], [5.8, 7.3]]);
  const [front] = layout.guards;
  assert(front.feet[1] > front.feet[0], 'its foot cut higher over the gap');
  assert.deepEqual(front.held.map(end => end === null ? null : mm(end)), [null, .15]);
  // The light along the deck of each part.
  const lit = deckGlint(layout, []).outlines.flatMap(points => upwardRuns(points, .005, []).map(run => [run[0].x, run.at(-1).x].sort((a, b) => a - b)));
  assert.deepEqual(lit.map(span => span.map(mm)), [[0, .9], [5.3, 8.2]]);
  // A tub with a gap: its nose on the first part, its rear plate on the last, each square at the gap.
  const tub = laid('tracked', 7.4, { profile: [{ x: 0, y: 0 }, { x: 6.9, y: 0, gap: true }, { x: 7.1, y: 0 }, { x: 7.4, y: 0 }] }), D = tub.depth;
  assert.deepEqual(tub.outlines.map(outline => outline.map(p => [mm(p.x), mm(p.y)])),
    [[[0, 0], [6.9, 0], [6.9, -D], [D, -D]], [[7.1, 0], [7.4, 0], [7.4, -D], [7.1, -D]]].map(outline => outline.map(p => p.map(mm))));
  assert.deepEqual(tub.parts.filter(part => part.kind === 'lug').map(part => part.straight), [0, 1]);
  for (const each of [layout, tub]) {
    const shape = chassisArtwork(each, 0x68765a);
    paintChassisCanvas(shape, 0x68765a);
    assert(each.outlines.flat().every(p => p.x >= shape.left && p.x <= shape.left + shape.width), 'its picture holds every part of it');
  }
});

test('lifted rail-end fender stays remain in the rear canvas with padded bounds, while the front band and ordinary mounts remain', () => {
  // Reuse the gap/raised-foot layout above: its first stay actually rises above
  // the old chassis top, so putting it in the old canvas would cut it off.
  const layout = laid('wheeled', 8.2, { axles: [.75, 5.8, 7.3], profile: GAP }), before = structuredClone(layout),
    shape = chassisArtwork(layout, 0x68765a), [guard] = layout.guards, [stay] = shape.rearStays,
    rearPicture = paintChassisCanvas(shape, 0x68765a), rear = rearPicture.getContext('2d'),
    front = paintGuardCanvas(guard, 0x68765a).getContext('2d'), left = guard.x - guard.w / 2, top = guard.y + guard.h / 2,
    has = (polygons, expected) => (polygons || []).some(points => points.length === expected.length && points.every((p, i) => p.every((v, j) => near(v, expected[i][j], 1e-9)))),
    box = (mount, x0, y1) => [mount.x - mount.w / 2 - x0, y1 - mount.y - mount.h / 2, mount.w, mount.h],
    hasBox = (ctx, expected) => (ctx.roundedRects || []).some(actual => expected.every((v, i) => near(v, actual[i], 1e-9)));
  assert(stay && stay.tip.y > layout.top && shape.top > layout.top, 'the fixture must exercise the lifted support, not only a lower hanger');
  for (const support of shape.rearStays) {
    const m = support.mount, ink = [...support.points, [m.x - m.w / 2, m.y - m.h / 2], [m.x + m.w / 2, m.y + m.h / 2]];
    for (const [x, y] of ink) {
      const px = (x - shape.left) * rearPicture.width / shape.width, py = (shape.top - y) * rearPicture.height / shape.height;
      assert(px >= 1.9 && py >= 1.9 && px <= rearPicture.width - 1.9 && py <= rearPicture.height - 1.9, 'bar and mount ink need two-pixel raster padding');
    }
    assert(has(rear.polygons, support.points.map(([x, y]) => [x - shape.left, shape.top - y])), 'the rear bar must be painted, not deleted');
    assert(hasBox(rear, box(m, shape.left, shape.top)), 'its rail mount remains behind the wheel too');
  }
  assert(!has(front.polygons, stay.points.map(([x, y]) => [x - left, top - y])), 'the end stay cannot remain in the foreground fender');
  assert(!hasBox(front, box(stay.mount, left, top)), 'neither may its rail mounting plate cross the tyre');
  const normal = { ...stay.mount, x: guard.axle.x - (guard.half + fenderAcross((guard.inner + guard.outer) / 2, guard.feet[0])) };
  assert.equal(guard.held[0], null); assert(hasBox(front, box(normal, left, top)), 'ordinary front foot hardware is retained');
  const bandPoint = { x: guard.axle.x - left, y: top - guard.axle.y - (guard.inner + guard.outer) / 2 };
  assert(front.polygons.some(points => within(bandPoint, points.map(([x, y]) => ({ x, y })))), 'the front band still covers its own face');
  assert.equal(chassisArtwork(layout, 0x68765a).key, shape.key); assert.match(shape.key, /:rear-stays-v1$/);
  assert.deepEqual(layout, before, 'paint partition and bounds must not alter the authored chassis or running gear');
});

test('a chassis raised over a hump has a plate over each knee, its holes and rivets along each straight, and its axles on its level runs', () => {
  const layout = laid('wheeled', 5.4, { axles: [.95, 2.67, 4.4], profile: HUMP }), rise = Math.atan2(.25, .3),
    straight = laid('wheeled', 5.4, { axles: [.95, 2.67, 4.4] });
  assert.equal(layout.outlines.length, 1);
  assert.equal(layout.outlines[0].length, 2 * HUMP.length);
  assert.deepEqual(layout.straights.map(line => mm(line.angle)), [0, rise, 0, -rise, 0].map(mm));
  // Its level runs are those at the height of its deck: the top of the hump is level, but over it.
  assert.deepEqual(layout.runs, [{ from: 0, to: 3.05, inner: [false, true] }, { from: 4, to: 5.4, inner: [true, false] }]);
  assert.equal(layout.top, .25);
  // A plate over each knee, square to both straights, bolted to each.
  const knees = layout.parts.filter(part => part.kind === 'knee');
  assert.equal(knees.length, 4);
  for (const [i, knee] of knees.entries()) {
    const at = HUMP[i + 1].x, xs = knee.points.map(p => p.x);
    assert(knee.points.length === 6 && Math.min(...xs) < at && Math.max(...xs) > at, `the knee at ${at}`);
    assert(knee.bolts.length >= 4 && knee.bolts.length % 2 === 0);
  }
  // The holes in a row along the middle of each straight, and nothing of the axles off the level runs.
  const holes = layout.parts.filter(part => part.kind === 'hole');
  assert.equal(new Set(holes.map(part => mm(part.y - layout.straights[part.straight].a.y))).size, 1);
  assert(new Set(holes.map(part => part.straight)).size >= 2);
  for (const part of layout.parts.filter(part => ['gusset', 'hanger', 'shackle', 'bracket'].includes(part.kind) && part.end === undefined))
    assert.equal(layout.straights[part.straight].angle, 0, part.kind);
  // What stands on it seats on the straight it stands on, and on nothing a hand over it.
  const flat = { origin: { x: 0, y: 0 }, along: { x: 1, y: 0 }, up: { x: 0, y: 1 } }, foot = (x0, x1, y) => [{ x: x0, y }, { x: x1, y }];
  assert.deepEqual(chassisSeats(flat, layout, [foot(1, 2, 0), foot(3.4, 3.65, .25)]), [[1, 2], [3.4, 3.65]]);
  assert.deepEqual(chassisSeats(flat, layout, [foot(1, 2, .25)]), []);
  // Its own picture, the same every time; the shade of what stands on it over the straight it stands on.
  assert.notEqual(layout.key, straight.key);
  assert.deepEqual(laid('wheeled', 5.4, { axles: [.95, 2.67, 4.4], profile: HUMP }), layout);
  const { corners } = shadeOf(seatShadeGeometry([[3.4, 3.65]], .1, layout.straights));
  assert(corners.length && corners.every(p => p.x >= 3.4 - 1e-6 && p.x <= 3.65 + 1e-6 && p.y <= .25 + 1e-6 && p.y >= .15 - 1e-6));
  paintChassisCanvas(chassisArtwork(layout, 0x68765a), 0x68765a);
});

// Each vertex of a chassis is one sum (game_chassis.rs `under_point`): its top, its foot on the line the stretches either
// side of it meet on, and where all else stands there — the plates of its frame and rail, the ends of the stretches
// drawn and the plate over the knee, the outline drawn when it is selected, the grip of the point and where a click
// is on the frame — at knees of every angle, both ways, thin and thick.
test('everything of a chassis at a knee stands on the one vertex the core outlines there', () => {
  const source = createConstruction('scout'), Y = source.chassis.points[0].y, x0 = source.chassis.points[0].x, x1 = source.chassis.points.at(-1).x,
    gap = (p, a, b) => { const d = { x: b.x - a.x, y: b.y - a.y }; return Math.abs((p.x - a.x) * d.y - (p.y - a.y) * d.x) / Math.hypot(d.x, d.y); },
    ends = plate => [-1, 1].map(k => ({ x: plate.x + Math.cos(plate.angle) * plate.length / 2 * k, y: plate.y + Math.sin(plate.angle) * plate.length / 2 * k }));
  for (const deg of [10, 20, 35, 45]) for (const way of [-1, 1]) for (const thicknessMm of [undefined, 40]) {
    // In cells (grid.ts): a rise of 10 or 20 cm over the whole cells nearest to the run that slopes it so.
    const rise = deg < 15 ? 2 : 4, run = Math.round(rise / Math.tan(deg * Math.PI / 180)), base = way < 0 ? 0 : -rise, low = way < 0 ? -rise : 0,
      points = [[x0, base], [x0 + 28, base], [x0 + 28 + run, low], [x1 - 28 - run, low], [x1 - 28, base], [x1, base]].map(([x, y]) => ({ x, y: Y + y })),
      // All of it hung where the model hangs a frame of that gauge, its suspension reaching its wheels.
      authored = withChassisSuspension({ ...source, chassis: { ...source.chassis, points, axles: [x0 + 14, x1 - 14], ...(thicknessMm && { thicknessMm }) } }, 0),
      blueprint = compileBlueprint(authored), what = `${deg}° ${way < 0 ? 'hump' : 'dip'} ${thicknessMm ?? 8} mm`,
      vertices = chassisVertices(blueprint.chassis), [outline] = blueprint.chassis.outlines;
    assert.equal(vertices.length, points.length, what);
    // The plates of the frame and the rail: a face of each along the outline of its stretch, its ends on the vertices.
    for (const [i, vertex] of vertices.slice(0, -1).entries()) {
      const after = vertices[i + 1];
      for (const [part, line] of [['frame', [vertex.top, after.top]], ['rail', [vertex.foot, after.foot]]]) {
        const plate = blueprint.plates.find(p => p.id === `chassis:${part}-${i}`), c = plateCorners(plate);
        assert([[c[0], c[1]], [c[3], c[2]]].some(face => face.every(p => gap(p, ...line) < 1e-9)), `${what}: a face of ${plate.id} on the outline`);
        for (const end of ends(plate)) assert([vertex, after].some(v => gap(end, v.top, v.foot) < 1e-9), `${what}: ${plate.id} ends on the line of a vertex`);
      }
    }
    // The grip of each point halfway down that line, and a click on the frame down to its foot along a sloping stretch.
    const editor = new Editor(authored), grips = editor.chassisPoints();
    for (const [k, v] of vertices.entries()) {
      assert(near(grips[k].x, v.middle.x, 1e-12) && near(grips[k].y, v.middle.y, 1e-12), `${what}: grip ${k}`);
      if (!k || k === vertices.length - 1) continue;
      const inside = { x: v.foot.x + (v.top.x - v.foot.x) * .02, y: v.foot.y + (v.top.y - v.foot.y) * .02 }, under = { x: v.foot.x - (v.top.x - v.foot.x) * .05, y: v.foot.y - (v.top.y - v.foot.y) * .05 };
      assert(editor.onChassisFrame(inside) && !editor.onChassisFrame(under), `${what}: the frame at ${k} down to its foot`);
    }
    // The picture: each stretch cut on that line, the plate over each knee on it, and the outline selected is the outline.
    const { place, layout } = laidOut(blueprint);
    for (const [k, drawn] of chassisOutlineAt(place, plates(blueprint).frame.chassis).entries())
      for (const [i, p] of drawn.entries()) assert(near(p.x, blueprint.chassis.outlines[k][i].x, 1e-9) && near(p.y, blueprint.chassis.outlines[k][i].y, 1e-9), `${what}: outline point ${i}`);
    const knees = layout.parts.filter(part => part.kind === 'knee');
    assert.equal(knees.length, 4, what);
    for (const [j, knee] of knees.entries()) {
      const v = vertices[j + 1];
      for (const p of [knee.points[1], knee.points[4]]) assert(gap(chassisPoint(place, p.x, p.y), v.top, v.foot) < 1e-9, `${what}: knee plate ${j + 1}`);
    }
    for (const [i, line] of layout.straights.entries()) for (const [knee, p] of [[line.ahead, line.a], [line.behind, line.b]]) if (knee) {
      const v = vertices.find(v => near(v.top.x, chassisPoint(place, p.x, p.y).x, 1e-9)), n = knee.normal, cut = chassisPoint(place, knee.point.x - n.y, knee.point.y + n.x);
      assert(v && gap(cut, v.top, v.foot) < 1e-9, `${what}: straight ${i} cut on the line of its knee`);
    }
    assert.equal(outline.length, 2 * points.length);
  }
});

// A pickup's chassis, arched over both its axles: raised over each, sloping down to a low middle that falls a little.
const PICKUP = [[0, .05], [.3, .35], [1.6, .35], [1.9, .05], [3.5, 0], [3.85, .35], [5, .35], [5.3, .05], [5.4, .05]].map(([x, y]) => ({ x, y }));
// Whether `p` is within the outline of a straight of a chassis (`piece`: its top from `a` to `b`, then its foot back).
const onWeb = (line, p) => line.piece.every((a, k) => {
  const b = line.piece[(k + 1) % 4];
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x) <= 1e-9;
});

test('an axle under a stretch raised or sloping over it, or a gap, rides on the springs of a level one, each fitting dropped to its pin from the rail over it', () => {
  const cases = [['leaf', HUMP, [.5, 3.2, 3.5, 4.9], {}], ['leaf', PICKUP, [.95, 4.42], {}], ['coil', PICKUP, [.95, 4.42], { wheelDiameter: .9, depth: .2 }],
    ['leaf', GAP, [.5, 3, 7.7], {}]];
  for (const [kind, profile, axles, dimensions] of cases) {
    const length = profile.at(-1).x, layout = laid('wheeled', length, { axles, profile, ...dimensions }), rig = suspensionRig('wheeled', layout);
    assert.equal(rig.kind, kind);
    // Every axle at the height of the level runs, on the same springs (render.ts draws them by `suspensionShapes`).
    assert(layout.axles.every(axle => near(axle.y, rig.axle)));
    for (const axle of layout.axles.filter(axle => !layout.runs.some(run => run.from - 1e-6 <= axle.x && axle.x <= run.to + 1e-6))) {
      const what = `${kind} axle at ${axle.x} of ${profile === GAP ? 'the gap' : profile === HUMP ? 'the hump' : 'the pickup'}`,
        fittings = layout.parts.filter(part => part.upright && part.hangs?.x === axle.x),
        wanted = kind === 'coil' ? [['tower', axle.x, rig.top]]
          : [['hanger', axle.x - rig.span, rig.eye], ['shackle', axle.x + rig.span, rig.eye + rig.shackle], ['bracket', axle.x - .3, -layout.depth * .8]];
      assert.deepEqual(fittings.map(part => [part.kind, part.pinX, part.pin]), wanted, `${what}: its pins where a level axle has them`);
      for (const part of fittings) {
        const lowest = Math.min(...part.low.map(p => p[1]));
        if (part.straight === undefined) {
          // Under the gap: at the line of the deck, where what spans it stands.
          assert.equal(profile, GAP, `${what}: ${part.kind} over no rail`);
          assert(part.top.every(p => p[1] === 0), `${what}: ${part.kind} at the deck`);
          continue;
        }
        // Its plate on the web of the rail over it, along the rail as it slopes; its pin on it or under it, its leg down.
        const line = layout.straights[part.straight];
        for (const [x, y] of [...part.top, ...part.low]) assert(onWeb(line, { x, y }) || layout.straights.some(other => onWeb(other, { x, y })), `${what}: ${part.kind} at ${x}, ${y} on the web`);
        assert(part.pin <= Math.max(...part.top.map(p => p[1])) + 1e-9, `${what}: ${part.kind} pin under its top`);
        assert(Math.min(part.pin - (part.kind === 'bracket' ? .014 : .026), lowest) >= part.y - part.h / 2 - 1e-9, `${what}: ${part.kind} box holds its leg`);
        if (Math.abs(part.x - part.pinX) > 1e-9) assert(part.top.every(p => Math.abs(p[0] - part.pinX) > 1e-9), `${what}: ${part.kind} held off its pin`);
      }
      // Over it, a cross member's plate on the rail, where there is one.
      if (profile !== GAP) assert(layout.parts.some(part => part.kind === 'gusset' && !part.upright && Math.abs(layout.straights[part.straight].a.y) + Math.abs(layout.straights[part.straight].angle) > 0), what);
    }
    assert(layout.parts.every(part => [part.x, part.y, part.w, part.h].every(Number.isFinite)));
    // The picture holds them all, and paints them.
    const shape = chassisArtwork(layout, 0x68765a);
    for (const part of layout.parts.filter(part => part.upright))
      assert(part.x - part.w / 2 >= shape.left && part.x + part.w / 2 <= shape.left + shape.width && part.y - part.h / 2 >= layout.bottom, `${part.kind} in the picture`);
    paintChassisCanvas(shape, 0x68765a);
  }
});

test('springs, hangers and dampers reach each axle where it stands, twenty centimetres under or over the model, never under its hub, and the mudguards follow the wheels', () => {
  // The recon on wheels half their size hangs on coils, and on its own on leaves, as the mortar on wheels half as large
  // again and the truck do.
  // Heights in cells (grid.ts).
  for (const [id, scale] of [['recon', .5], ['recon', 1], ['mortar', 1.5], ['truck', 1]]) for (const height of [-4, 0, 4]) {
    const source = createConstruction(id);
    if (id === 'mortar') source.chassis.axles = [-40, 0, 40];
    const design = withChassisSuspension(withChassisGearScale(source, scale * (source.chassis.gearScale ?? 1)), height),
      blueprint = compileBlueprint(design), { layout, place } = laidOut(blueprint), rig = suspensionRig('wheeled', layout),
      wheels = blueprint.modules.filter(part => part.kind === 'wheel'), what = `${id} ${scale} ${height}: ${rig.kind}`;
    assert(near(blueprint.chassis.suspension, metresOf(height), 1e-9), what);
    for (const axle of layout.axles) {
      const hub = chassisPoint(place, axle.x, axle.y);
      assert(wheels.some(wheel => near(wheel.x, hub.x) && near(wheel.y, hub.y)), `${what}: drawn on the hub of its wheel`);
    }
    // Every pin the rig hangs on is over the hub, under the rail; the spring between them no longer than a coil is.
    for (const part of layout.parts.filter(part => part.pin !== undefined))
      assert(part.pin > rig.axle && part.pin < 0, `${what}: ${part.kind} pin ${part.pin} over the hub ${rig.axle}`);
    if (rig.kind === 'coil') assert(rig.top - .02 - (rig.axle + rig.housing + .012) <= .34 + 1e-9, what);
    else {
      assert(rig.eye >= rig.axle + .012 - 1e-9 && rig.block <= .15 + 1e-9 && rig.damper > rig.axle, what);
      for (const part of layout.parts.filter(part => part.hangs)) assert(part.y - part.h / 2 > rig.axle - rig.r, `${what}: ${part.kind} clear of the ground`);
    }
    // The mudguards stand over the tyres where they are: as far over each as at the height the model hangs it.
    assert(layout.guards.length > 0, what);
    for (const guard of layout.guards) for (const x of guard.axles) {
      const axle = chassisPoint(place, x, guard.axle.y);
      assert(wheels.some(wheel => near(wheel.x, axle.x) && near(wheel.y, axle.y) && near(guard.r, wheel.width / 2)), `${what}: over the axle of a wheel`);
      assert(near(guard.inner, fenderOver(guard.r).inner), what);
    }
  }
});

test('the suspension of a track raises the hull over it, and its drawn wheels stay on the floor with the physical gear', () => {
  const original = createConstruction('heavy');
  let wheels, key;
  for (const height of [-4, 0, 4]) {
    const changed = withChassisSuspension(original, height), blueprint = compileBlueprint(changed), { layout, place, track } = laidOut(blueprint),
      { chassis } = plates(blueprint).frame, at = layout.axles.map(axle => { const p = chassisPoint(place, axle.x, axle.y); return [mm(p.x), mm(p.y), axle.r]; }),
      lift = height - suspensionHeight(original.chassis);
    assert.deepEqual(changed.chassis.track, original.chassis.track);
    assert.deepEqual(changed.nodes, original.nodes.map(node => ({ ...node, y: node.y + lift })));
    assert.deepEqual(changed.chassis.points, original.chassis.points.map(point => ({ ...point, y: point.y + lift })));
    assert(near(blueprint.chassis.suspension, metresOf(height), 1e-9));
    for (const axle of layout.axles) assert(near(chassisPoint(place, axle.x, axle.y).y - track.y, axle.y - chassis.track.y), 'physical centre and artwork share the same authored height');
    if (wheels) {
      assert.notEqual(layout.key, key, 'raising the hull over its track invalidates the chassis picture');
      for (const [i, wheel] of at.entries()) {
        assert(near(wheel[0], wheels[i][0]));
        assert(near(wheel[1], wheels[i][1]), 'the drawn wheels stay where the track stands, on the floor');
        assert.equal(wheel[2], wheels[i][2]);
      }
    }
    wheels = at; key = layout.key;
    // Its track gone, what its wheels hung by shows: the boss of each arm within the side of the tub, over its belly.
    const bare = chassisLayout(chassis.model, { length: chassis.length, profile: chassis.profile, outlines: chassis.outlines, deck: chassis.deck,
        depth: chassis.depth, track: { width: track.width, height: track.height, middle: chassis.track && (chassis.track.front + chassis.track.rear) / 2, y: chassis.track.y, held: false } }),
      bosses = bare.parts.filter(part => part.kind === 'boss');
    assert(bosses.length > 0);
    for (const boss of bosses) assert(boss.y - boss.h / 2 >= .01 - chassis.depth - 1e-9 && boss.y + boss.h / 2 < 0, `${height}: boss at ${boss.y}`);
  }
});

test('the floor plate of a truck is in the picture of its chassis, and what stands on it stands on it with no pale line between', () => {
  for (const id of ['chassis', 'truck', 'supply', 'tanker']) {
    const design = createConstruction(id), { blueprint, renderer, layers } = bench(design, true), shape = layers.chassisShape, layout = shape.layout,
      t = design.chassis.topPlate.thicknessMm / 1000, floors = blueprint.plates.filter(plate => floorSegment(plate) !== null), { frame } = plates(blueprint);
    // Painted with the frame, never again as a plate of bare metal over the deck.
    assert(floors.length && floors.every(plate => !renderer.board.drawables.has(plate.id)), `${id}: no bare plate over the deck`);
    assert.deepEqual(layout.floor.bands.map(band => band.segment), floors.map(floorSegment), id);
    for (const { points: [front, rear, high, low] } of layout.floor.bands)
      assert([front, rear].every(p => near(p.y, 0)) && [high, low].every(p => near(p.y, t)) && near(front.x, low.x) && near(rear.x, high.x),
        `${id}: from the deck up as thick as it is`);
    assert(shape.top >= t - 1e-9, `${id}: the picture reaches the top of the floor`);
    const painted = paintChassisCanvas(shape, 0x68765a).getContext('2d').polygons ?? [], at = p => [p.x - shape.left, shape.top - p.y];
    for (const { points } of layout.floor.bands) assert(painted.some(polygon => polygon.length === 4
      && polygon.every((q, i) => near(q[0], at(points[i])[0], 1e-6) && near(q[1], at(points[i])[1], 1e-6))), `${id}: painted`);
    // The foot of each body out in the open on the top of the floor, over the floor from one end to the other.
    const place = chassisPlacement(poseOf(frame), frame.chassis), bodies = blueprint.modules.filter(holdsCargo);
    assert.equal(bodies.length, id === 'chassis' ? 0 : 1, id);
    for (const piece of bodies) {
      const c = Math.cos(piece.angle || 0), s = Math.sin(piece.angle || 0), ends = [-1, 1].map(side => chassisLocal(place,
          { x: piece.x + c * side * piece.width / 2 + s * piece.height / 2, y: piece.y + s * side * piece.width / 2 - c * piece.height / 2 })),
        [x0, x1] = ends.map(p => p.x).sort((p, q) => p - q);
      assert(ends.every(p => near(p.y, t)), `${id}: its foot on the floor`);
      assert(layout.floor.bands.some(({ points: [front, rear] }) => front.x <= x0 + 1e-6 && rear.x >= x1 - 1e-6), `${id}: over the floor`);
      assert(layers.chassisSeats.some(([from, to]) => from <= x0 + .01 && to >= x1 - .01), `${id}: seated on it`);
    }
    // In the shade of what stands on it from the top of the floor down, over the floor as over the frame; the light along
    // the top of the floor, and only where nothing stands on it.
    const [, mesh] = layers.chassisArt.children, ys = mesh.geometry.positions.filter((_, i) => i % 2 === 1);
    assert(near(Math.max(...ys), t), `${id}: the shade from the top of the floor`);
    const { outlines, others } = deckGlint(layout, layers.chassisSeats), lit = outlines.flatMap(points => upwardRuns(points, .001, others));
    assert(lit.length && lit.every(run => run.every(p => near(p.y, t - .001, 1e-6))), `${id}: the light along the top of the floor`);
    for (const run of lit) {
      const xs = run.map(p => p.x), [from, to] = [Math.min(...xs), Math.max(...xs)];
      assert(layers.chassisSeats.every(([x0, x1]) => to <= x0 + 1e-6 || from >= x1 - 1e-6), `${id}: none over a seat`);
    }
  }
  // Over a hump the pieces of floor meet mitred at each knee, square to their straights and as thick as the plate, as the core
  // lays them. Where a piece is off, the edge of the chassis steps down to the deck and back, and the shade falls from the deck
  // there; from the floor where it is.
  const t = .02, layout = laid('wheeled', 5.4, { axles: [.95, 2.67, 4.4], profile: HUMP, floor: { thicknessMm: 20, metal: 'steel', segments: [4, 0, 1, 3] } }),
    { bands } = layout.floor, top = k => bands.find(band => band.segment === k);
  assert.deepEqual(bands.map(band => band.segment), [0, 1, 3, 4]);
  assert.deepEqual(top(0).points[2], top(1).points[3], 'mitred at the knee');
  assert.deepEqual(top(3).points[2], top(4).points[3], 'mitred at the knee');
  for (const { points: [front, rear, high, low] } of bands) {
    const dx = rear.x - front.x, dy = rear.y - front.y, l = Math.hypot(dx, dy), off = p => ((p.y - rear.y) * dx - (p.x - rear.x) * dy) / l;
    assert(near(off(high), t, 1e-4) && near(off(low), t, 1e-4), 'as thick as the plate, square to its straight');
  }
  const deck = layout.decks[0];
  for (const k of [2, 3]) assert(deck.some(p => near(p.x, HUMP[k].x, 1e-9) && near(p.y, HUMP[k].y, 1e-9)), `down to the deck at ${k}`);
  assert(deck.includes(top(1).points[2]) && deck.includes(top(3).points[3]), 'and up round the floor either side');
  assert.equal(layout.top, Math.round(Math.max(...bands.flatMap(band => band.points.map(p => p.y))) * 1e4) / 1e4);
  assert.equal(layout.shades[2], layout.straights[2], 'from the deck where the floor is off');
  for (const i of [0, 1, 3, 4]) assert.deepEqual([layout.shades[i].a, layout.shades[i].b], [top(i).points[3], top(i).points[2]], `from the floor over ${i}`);
  assert.notEqual(layout.key, laid('wheeled', 5.4, { axles: [.95, 2.67, 4.4], profile: HUMP }).key, 'its own picture');
  paintChassisCanvas(chassisArtwork(layout, 0x68765a), 0x68765a);
});

// The skids of an aircraft as its frame plate tells them (game_chassis.rs `describe`), under a chassis `depth` deep: its
// runner from `front` to `rear` as thick as `tube`, its legs at `legs` from the foot of the keel down to it.
const skidsUnder = (depth, front, rear, legs, tube = .08) => ({ front, rear, y: -depth - .5, tube,
  legs: legs.map(x => ({ x, top: -depth, foot: -depth - .5 + tube / 2 })) });
test('an aircraft stands on a keel, not on the rail of a truck: faired at the ends of each part, lightened in a truss between stiffeners, a doubler over each leg', () => {
  const depth = .2;
  for (const [profile, legs] of [[[{ x: 0, y: 0 }, { x: 6, y: 0 }], [1.2, 4.6]], [HUMP, [.9, 4.7]], [GAP, [.5, 6]]]) {
    const length = profile.at(-1).x, layout = laid('aircraft', length, { profile, depth, skids: skidsUnder(depth, .3, length - .1, legs) }),
      kinds = new Set(layout.parts.map(part => part.kind)), what = `${length} m, ${layout.outlines.length} part(s)`;
    assert(!kinds.has('hole') && !kinds.has('gusset'), `${what}: none of the holes and cross members of a truck's rail`);
    for (const kind of ['fairing', 'bay', 'stiffener', 'saddle', 'rivet', 'leg', 'skid']) assert(kinds.has(kind), `${what}: ${kind}`);
    // A fairing over each end of each part, and over nothing else.
    const ends = layout.straights.flatMap((line, i) => [!line.ahead && [i, 'front'], !line.behind && [i, 'rear']].filter(Boolean));
    assert.deepEqual(layout.parts.filter(part => part.kind === 'fairing').map(part => [part.straight, part.end]), ends, what);
    // A doubler on the web over each leg.
    for (const x of legs) assert(layout.parts.some(part => part.kind === 'saddle' && near(turnedX(layout, part), x, 1e-6)), `${what}: a doubler over the leg at ${x}`);
    // The cut-outs within the web between the caps, apart from one another and from what is fitted on it.
    for (const bay of layout.parts.filter(part => part.kind === 'bay')) {
      const line = layout.straights[bay.straight], others = layout.parts.filter(part => part.straight === bay.straight && part !== bay
        && ['bay', 'stiffener', 'saddle', 'fairing'].includes(part.kind));
      assert(bay.y + bay.h / 2 < line.a.y - .01 && bay.y - bay.h / 2 > line.a.y - depth + .01, `${what}: between the caps`);
      assert(others.every(part => part.kind === 'bay' ? Math.abs(part.x - bay.x) >= bay.w / 2 - 1e-9
        : Math.abs(part.x - bay.x) >= (part.w + bay.w) / 2 - 1e-9), `${what}: a cut-out clear of the rest`);
    }
    // Its outline round under each fairing, its deck as it was, and nothing of it out of the box of its outline; the
    // pieces the shade of what stands on it falls on round there too, and still convex.
    for (const [part, deck] of layout.decks.entries()) {
      const square = layout.outlines[part], xs = square.map(p => p.x), ys = square.map(p => p.y);
      assert(deck.length > square.length, `${what}: round at its ends`);
      assert(deck.every(p => p.x >= Math.min(...xs) - 1e-6 && p.x <= Math.max(...xs) + 1e-6 && p.y >= Math.min(...ys) - 1e-6 && p.y <= Math.max(...ys) + 1e-6), what);
      for (const corner of [square[square.length / 2], square.at(-1)]) assert(!deck.some(p => near(p.x, corner.x, 1e-6) && near(p.y, corner.y, 1e-6)), `${what}: no square corner under a fairing`);
      for (const p of square.slice(0, square.length / 2)) assert(deck.some(q => near(q.x, p.x, 1e-9) && near(q.y, p.y, 1e-9)), `${what}: its deck`);
    }
    for (const { piece } of layout.shades) {
      const turns = piece.map((p, i) => { const q = piece[(i + 1) % piece.length], r = piece[(i + 2) % piece.length]; return (q.x - p.x) * (r.y - q.y) - (q.y - p.y) * (r.x - q.x); });
      assert(turns.every(t => t <= 1e-12) || turns.every(t => t >= -1e-12), `${what}: a convex piece`);
    }
    assert.equal(layout.key, laid('aircraft', length, { profile, depth, skids: skidsUnder(depth, .3, length - .1, legs) }).key, what);
    paintChassisCanvas(chassisArtwork(layout, 0x68765a), 0x68765a);
  }
});
// Where a part on a straight of a chassis, laid along it as it would lie level from its first point, is along the chassis.
const turnedX = (layout, part) => { const line = layout.straights[part.straight]; return line.a.x + (part.x - line.a.x) * Math.cos(line.angle); };
