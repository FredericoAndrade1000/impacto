import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { constructionPlacement } from '../src/construction-placement.ts';
import { componentPolygon } from '../src/assembly.ts';
import { plateCorners } from '../src/math.ts';
import { fixedFooting, footingOutlines, lowerContour, footingBill, footingVolume, FOOTING_EMBED, FOOTING_FREE, FOOTING_REACH, FOOTING_SOLID } from '../src/fixed-footing.ts';
import { BODY_WIDTH } from '../src/component-size.ts';
import { MATERIALS } from '../src/materials.ts';
import { bill } from '../src/economy.ts';
import { GHOST_TINT } from '../src/faction-ui.ts';

const near = (actual, expected, slack = 1e-9) => assert(Math.abs(actual - expected) < slack, `${actual} != ${expected}`);
const box = (x0, x1, y0, y1) => [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }];
// A slope that bends under the construction, as the relief does between two of its points.
const bent = (at, low = .06, high = .02, base = 50) => ({ height: x => base + (x < at ? low : high) * (x - at) });

test('a fixed construction on a bent slope gets a footing from its level floor down into the ground under every point of it', () => {
  const blueprint = compileBlueprint(createStructuredTemplate('bunker'));
  for (const facing of [-1, 1]) {
    const x = 400.25, ground = bent(x + .7), { point } = constructionPlacement(blueprint, ground, { x, facing, clearance: .04, allowDownward: true }),
      outlines = [...blueprint.plates.map(plate => plateCorners(plate).map(point)), ...blueprint.modules.map(module => componentPolygon(module).map(point))],
      floor = blueprint.plates.find(plate => plate.id === 'hull:floor'), under = plateCorners(floor).map(point),
      bottom = Math.min(...under.map(p => p.y)), feet = outlines.flat().filter(p => p.y <= bottom + 1e-9),
      left = Math.min(...feet.map(p => p.x)), right = Math.max(...feet.map(p => p.x)),
      footings = fixedFooting(outlines, ground);
    assert.equal(footings.length, 1, 'one footing under the one base');
    const [{ top, ground: read, foot }] = footings;
    // Its top is the lower face of the floor and the feet of the walls, level, from one outer face to the other.
    assert.equal(top.length, 2); near(top[0].x, left); near(top[1].x, right);
    for (const p of top) near(p.y, bottom);
    // The ground is read at both ends and no more than a tenth of a metre apart between them, and the foot follows it.
    near(read[0].x, left); near(read.at(-1).x, right);
    for (let i = 1; i < read.length; i++) assert(read[i].x - read[i - 1].x <= .1 + 1e-9 && read[i].x > read[i - 1].x);
    assert.equal(foot.length, read.length);
    for (const [i, p] of read.entries()) { near(p.y, ground.height(p.x)); near(foot[i].x, p.x); near(foot[i].y, p.y - FOOTING_EMBED); }
    // It stands where the floor is highest over the ground: four centimetres there, and more down the slope.
    const gaps = read.map(p => bottom - p.y);
    near(Math.min(...gaps), .04, 1e-6); assert(Math.max(...gaps) > .25, 'the room under the low side is filled: ' + Math.max(...gaps));
  }
});

test('the base is what of the lower contour lies near its lowest point: no roof that reaches past it, no gun laid out of it', () => {
  const ground = { height: () => 0 }, floor = box(0, 4, .02, .14), roof = box(-1, 5, 2, 2.1), gun = box(4, 6.5, .02 + FOOTING_REACH + .2, .02 + FOOTING_REACH + .3),
    [footing, ...more] = fixedFooting([floor, roof, gun], ground);
  assert.equal(more.length, 0);
  assert.deepEqual(footing.top, [{ x: 0, y: .02 }, { x: 4, y: .02 }]);
  // Feet: the plan runs from the outer face of one to that of the other, and the footing steps up under the slab between
  // them: no sky under it.
  const legs = fixedFooting([box(0, .3, .03, 1), box(3.7, 4, .03, 1), box(0, 4, 1, 1.2)], ground);
  assert.deepEqual(legs.map(footing => footing.top),
    [[{ x: 0, y: .03 }, { x: .3, y: .03 }, { x: .3, y: 1 }, { x: 3.7, y: 1 }, { x: 3.7, y: .03 }, { x: 4, y: .03 }]]);
  // Walls that go lower than the floor between them: the footing steps up under the floor and down again.
  assert.deepEqual(lowerContour([box(.26, 3.74, .1, .2), box(0, .26, 0, 2), box(3.74, 4, 0, 2)]),
    [[{ x: 0, y: 0 }, { x: .26, y: 0 }, { x: .26, y: .1 }, { x: 3.74, y: .1 }, { x: 3.74, y: 0 }, { x: 4, y: 0 }]]);
  // A floor that slopes up out of the reach of the base is cut where it leaves it, and its footing ends there.
  const slanted = lowerContour([[{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 4, y: 1 }, { x: 0, y: 1 }]], FOOTING_REACH);
  assert.equal(slanted.length, 1); assert.deepEqual(slanted[0][0], { x: 0, y: 0 });
  near(slanted[0].at(-1).x, 2 + 2 * FOOTING_REACH); near(slanted[0].at(-1).y, FOOTING_REACH);
});

test('a straight floor over a hollow, between walls that go lower than it, stands on a footing under all of it', () => {
  // A wide concrete building as the field stands it in a shallow hollow: its walls come 0.4 m under its floor and rest
  // on the two rims, and the ground sags between them. Before, only the feet of the walls had a footing, two blocks at
  // the ends, and the floor stood over the hollow.
  const width = 10, hollow = { height: x => 20 + .006 * (x - width / 2) ** 2 }, rim = hollow.height(0) + .04,
    floor = box(.3, width - .3, rim + .4, rim + .6), walls = [box(0, .3, rim, rim + 3), box(width - .3, width, rim, rim + 3)],
    roof = box(-.5, width + .5, rim + 3, rim + 3.2), gun = box(width, width + 1.5, rim + .8, rim + .9);
  for (const order of [[floor, ...walls, roof, gun], [gun, roof, ...walls.toReversed(), floor]]) {
    const [footing, ...more] = fixedFooting(order, hollow);
    assert.equal(more.length, 0, 'one footing from wall to wall');
    assert.deepEqual(footing.top, [{ x: 0, y: rim }, { x: .3, y: rim }, { x: .3, y: rim + .4 }, { x: width - .3, y: rim + .4 },
      { x: width - .3, y: rim }, { x: width, y: rim }], 'up to the floor between the walls; not under the eaves nor the gun');
    near(footing.ground[0].x, 0); near(footing.ground.at(-1).x, width);
    for (const [i, p] of footing.ground.entries()) near(footing.foot[i].y, hollow.height(p.x) - FOOTING_EMBED);
  }
});

test('a construction that comes nowhere near the ground, as an authored scene stands, has no footing', () => {
  const ground = { height: () => 0 };
  assert.deepEqual(fixedFooting([box(0, 3, 1.5, 1.6)], ground), []);
  assert.equal(fixedFooting([box(0, 3, .04, .1)], ground).length, 1);
  assert.deepEqual(fixedFooting([], ground), []);
  // What came off a construction is no part of its base.
  const parts = [{ type: 'plate', data: { attached: false, definition: { x: 1, y: .1, angle: 0, length: 2, thicknessMm: 100 } } },
    { type: 'module', data: { kind: 'ammo', attached: false, x: 1, y: .5, width: .4, height: .4 } }];
  assert.deepEqual(footingOutlines(parts), []);
});

test('a footing is paid for past the first 0.7 m of room under the base, as hollow concrete as deep as a construction, in Sílica', () => {
  assert.deepEqual([FOOTING_FREE, FOOTING_SOLID, BODY_WIDTH], [.7, .2, 2.4]);
  const blueprint = compileBlueprint(createStructuredTemplate('bunker')), x = 400.25,
    slope = (degrees, sign = 1) => ({ height: u => 50 + sign * Math.tan(degrees * Math.PI / 180) * (u - x) }),
    // The footing under its actual authored lower contour on each slope.
    footings = ground => {
      const { point } = constructionPlacement(blueprint, ground, { x, facing: 1, clearance: .04, allowDownward: true });
      return fixedFooting([...blueprint.plates.map(plate => plateCorners(plate).map(point)), ...blueprint.modules.map(module => componentPolygon(module).map(point))], ground);
    },
    [{ top }] = footings(slope(0)), length = top.at(-1).x - top[0].x;
  assert(length > 0);
  // Level, or so gentle that no more than 0.7 m is left under its base, it costs what its design does.
  for (const degrees of [0, 5, 6.5]) assert.deepEqual(footingBill(blueprint, slope(degrees), { x, facing: 1 }), bill());
  // Over a slope it rests by the high end of its base; down from there the room under it grows as the slope rises, and
  // what lies past the free 0.7 m is paid for.
  for (const degrees of [10, 20, 30]) {
    const rise = Math.tan(degrees * Math.PI / 180), past = length - FOOTING_FREE / rise,
      volume = rise / 2 * past ** 2 * BODY_WIDTH * FOOTING_SOLID, silica = Math.ceil(volume * MATERIALS.concrete.density * .8 - 1e-9);
    for (const facing of [-1, 1]) for (const sign of [-1, 1]) {
      near(footingVolume(blueprint, slope(degrees, sign), { x, facing }), volume, 1e-9);
      assert.deepEqual(footingBill(blueprint, slope(degrees, sign), { x, facing }), bill(0, 0, silica));
    }
  }
  // What is drawn of it on the steepest slope a structure stands on fills the room under its base, down into the ground.
  const [footing, ...more] = footings(slope(30));
  assert.equal(more.length, 0);
  for (const [i, p] of footing.ground.entries()) { near(footing.foot[i].y, p.y - FOOTING_EMBED); assert(footing.top[0].y > footing.foot[i].y); }
  near(footing.ground[0].x, footing.top[0].x); near(footing.ground.at(-1).x, footing.top.at(-1).x);
});

// A renderer with what the constructions of a frame are drawn into, and a ground of its own.
function presenter(t, ground) {
  const renderer = new Renderer({}, { mode: 'test' }), stage = new Container({ isRenderGroup: true });
  renderer.app = { stage }; renderer.world = stage.addChild(new Container());
  renderer.actorLayerRoot = renderer.world.addChild(new Container()); renderer.actorLayerRoot.sortableChildren = true;
  renderer.fxLayer = renderer.world.addChild(new Container()); renderer.labels = renderer.world.addChild(new Container());
  renderer.shadows = renderer.world.addChild(new Graphics());
  renderer.ground = ground; renderer.flagTexture = () => null; renderer.labelWidth = text => text.length * 6;
  t.after(() => { renderer.effectSurfaceClip.destroy(); stage.destroy({ children: true, context: true }); renderer.labelIcons.clear(); });
  return renderer;
}
// A casemate standing at `x`, 125 km out, four centimetres over the highest of the ground under it: a concrete floor
// between two walls under a roof, a camera on the roof, as the field tells one that does not drive (`vehicle: null`).
function casemate(x, ground, edits = {}) {
  const floor = Math.max(ground.height(x - 1.5), ground.height(x + 1.5)) + .04, y = floor + .46,
    plate = (id, definition) => ({ id, actorId: 'c', attached: true, definition: { material: 'concrete', thicknessMm: 200, ...definition } });
  return { time: 1, actors: [{ id: 'c', preset: 'bunker', x, y, facing: 1, mirror: -1, vehicle: null, ...edits.actor }],
    plates: [plate('floor', { x, y: floor + .1, angle: 0, length: 3 }), plate('front', { x: x - 1.4, y: floor + 1, angle: Math.PI / 2, length: 2 }),
      plate('rear', { x: x + 1.4, y: floor + 1, angle: Math.PI / 2, length: 2 }), plate('roof', { x, y: floor + 2.1, angle: 0, length: 3 })],
    modules: [{ id: 'camera', actorId: 'c', kind: 'sensor', sensorMode: 'visual', width: .4, height: .2, attached: true, x: x + .3, y: floor + 2.2 + .015 + .1, angle: 0 }],
  };
}
const frame = (renderer, state) => {
  renderer.scene = sampleScene(state); renderer.syncActorLayers(state); renderer.cullActors(state); renderer.drawStructure(state);
};
// What a drawing hands Pixi as its own numbers, as pairs, and where they are in the world.
function numbers(g) { const gpu = new GpuGraphicsContext(); buildContextBatches(g.context, gpu); return gpu.geometryData.vertices; }
const placed = g => { const at = numbers(g), out = []; for (let i = 0; i < at.length; i += 2) out.push({ x: at[i] + g.x, y: at[i + 1] + g.y }); return out; };

test('the footing of a casemate on the field is drawn once under all of it, at its place, and again only for other parts or ground', t => {
  const x = 125000.375, slope = { height: u => 300 + .08 * (u - x) }, renderer = presenter(t, slope);
  Object.assign(renderer.camera, { x, y: slope.height(x) + 1, zoom: 40, width: 900, height: 550 });
  let state = casemate(x, slope); frame(renderer, state);
  const layers = renderer.actorLayers.get('c'), g = layers.footing, order = kind => layers.container.getChildIndex(layers[kind]);
  assert(order('footing') < order('shade') && order('shade') < order('outline') && order('outline') < order('body'), 'under all material, its contact shadow over it');
  assert.deepEqual([g.x, g.y], [x, state.actors[0].y], 'counted from where the casemate stands');
  assert(Math.max(...numbers(g).map(Math.abs)) < 3, 'and holding only what is left of each place');
  // From the lower face of the floor, wall to wall, down to five centimetres into the ground, along the slope.
  const drawn = placed(g), bottom = state.plates[0].definition.y - .1, xs = drawn.map(p => p.x), ys = drawn.map(p => p.y);
  near(Math.min(...xs), x - 1.5, .007); near(Math.max(...xs), x + 1.5, .007);
  near(Math.max(...ys), bottom, 1e-4); near(Math.min(...ys), slope.height(x - 1.5) - FOOTING_EMBED, 1e-4);
  for (const u of [-1.5, -.7, 0, .7, 1.5])
    near(Math.min(...drawn.filter(p => Math.abs(p.x - (x + u)) < .051).map(p => p.y)), slope.height(x + u) - FOOTING_EMBED, 1e-3);
  const contact = layers.shade.children.find(child => child.context.instructions.length);
  assert(contact, 'its foot is darkened where it goes into the ground');
  // A frame of the same casemate draws nothing of it again, whether the field hands over the same records or new ones
  // with the same places in them.
  const instructions = g.context.instructions.slice(), shaded = contact.context.instructions.slice(), same = () => {
    assert.equal(g.context.instructions.length, instructions.length);
    instructions.forEach((instruction, i) => assert.equal(g.context.instructions[i], instruction));
    shaded.forEach((instruction, i) => assert.equal(contact.context.instructions[i], instruction));
  };
  for (let i = 0; i < 3; i++) { frame(renderer, { ...state, time: 2 + i }); same(); }
  frame(renderer, structuredClone(state)); same();
  renderer.camera.x += 5; frame(renderer, state); same();
  // A construction that changes, or a ground that does, has it drawn anew.
  state = casemate(x + 2, slope); frame(renderer, state);
  assert.notEqual(g.context.instructions[0], instructions[0]); assert.deepEqual([g.x, g.y], [x + 2, state.actors[0].y]);
  const level = { height: () => slope.height(x + 2) + .1 }, again = g.context.instructions[0];
  renderer.ground = level; frame(renderer, state);
  assert.notEqual(g.context.instructions[0], again);
  near(Math.min(...placed(g).map(p => p.y)), level.height() - FOOTING_EMBED, 1e-4);
  // A ghost of it stands pale, its footing too.
  frame(renderer, casemate(x + 2, slope, { actor: { ghost: { time: 0 } } }));
  assert.equal(g.tint, GHOST_TINT);
});

test('only what stands fixed and on the ground has a footing, and a vehicle drawn under its name after it takes it away', t => {
  const x = 125000.375, ground = { height: () => 300 }, renderer = presenter(t, ground);
  Object.assign(renderer.camera, { x, y: 301, zoom: 40, width: 900, height: 550 });
  frame(renderer, casemate(x, ground));
  const layers = renderer.actorLayers.get('c'), g = layers.footing, contact = layers.footingMade.cast.shade;
  assert(g.context.instructions.length > 0 && contact.parent === layers.shade);
  const vehicle = casemate(x, ground, { actor: { preset: 'vehicle', vehicle: { x, y: 300.5, angle: 0, chassisId: 'floor' } } });
  frame(renderer, vehicle);
  assert.equal(g.context.instructions.length, 0); assert(contact.destroyed, 'its shadow goes with it');
  // An authored scene of the laboratory stands where it was put, over nothing.
  const raised = casemate(x, { height: () => 301.5 });
  frame(renderer, raised);
  assert.equal(g.context.instructions.length, 0);
});
