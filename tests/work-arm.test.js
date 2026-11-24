import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../src/materials.ts';
import { workFrame, workSide, workLayout, workStep, workFigure, workReachable, workDelivery, boxesOf, craneLayout, craneSide, craneRoute, craneFigure, craneParking,
  craneStep, craneStandby, CRANE_REACH, DEPLOY_SECONDS, STOW_SECONDS, SCOOP_SECONDS, SINK_SECONDS, LIFT_SECONDS, CASING } from '../src/work-arm.ts';
import { drawWorkArm } from '../src/work-arm-art.ts';
import { DEPOSIT_TONES } from '../src/deposit-art.ts';
import { GraphicsRecorder } from './scenery-canvas.js';

const piece = (kind, more = {}) => ({ kind, x: 100, y: 1.6, angle: 0, width: MODULES[kind].width, height: MODULES[kind].height, ...more }),
  frame = { left: -2.5, right: 2.3, bottom: -1.6 }, level = () => 0,
  distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y), near = (a, b, slack = 1e-9) => Math.abs(a - b) <= slack,
  advance = (arm, rig, active, seconds) => {
    let time = arm.time ?? 0; workStep(arm, rig, active, time);
    for (let i = 0; i < Math.round(seconds * 20); i++) workStep(arm, rig, active, time += .05);
    return arm;
  };

test('the complete tool works past the nearer end, retaining the previous side within a hand', () => {
  assert.equal(workSide(frame), 1);
  assert.equal(workSide({ left: -1.2, right: 4 }), -1);
  assert.equal(workSide({ left: -3.1, right: 3.3 }, 1), 1);
  assert.equal(workSide({ left: -2, right: 4 }, 1), -1);
  assert.equal(workSide({ left: -2, right: 2 }), 1);
  assert.equal(workSide({ left: -2, right: 2 }, 0, true), -1);
  assert.equal(workSide({ left: -2, right: 2 }, 1, true), 1, 'an already deployed arm keeps its side');
  const base = piece('excavator'), parts = [base, { definition: { x: 99, y: 1, angle: 0, length: 4, thicknessMm: 100 } },
    { x: 130, y: 1, width: 2, height: 1, attached: false }], bounds = workFrame(base, parts);
  assert.equal(bounds.left, -3); assert.equal(bounds.right, 1);
});

test('reservoirs have no arm and a tool cannot grow its reach to fit a longer vehicle or lower ground', () => {
  for (const kind of ['hopper', 'cistern', 'supply']) assert.throws(() => workLayout(piece(kind), frame, 1), /extração/);
  for (const kind of ['excavator', 'drill']) {
    const p = piece(kind), layout = workLayout(p, frame, 1), longer = workLayout(p, { ...frame, right: 20, bottom: -12 }, 1);
    assert.equal(longer.length, layout.length); assert(longer.out > longer.length);
    assert(near(layout.boom + layout.stick, layout.length)); assert.equal(layout.rig, kind === 'drill');
    const scaled = workLayout(piece(kind, { width: p.width * .5, height: p.height * .5 }), frame, 1);
    assert.equal(scaled.length, layout.length * .5);
  }
});

test('only explicit authoritative activity starts work, independently of cargo or previous loading', () => {
  const arm = workStep({}, false, false, 10);
  assert.equal(arm.working, false); assert.equal(arm.deployed, 0);
  workStep(arm, false, 5000, 10.1); assert.equal(arm.working, false, 'a cargo amount is not an activity signal');
  workStep(arm, false, true, 10.2); assert.equal(arm.working, true); assert(arm.deployed > 0);
  workStep(arm, false, false, 10.3); assert.equal(arm.working, false);
  assert.equal(advance(arm, false, false, STOW_SECONDS).deployed, 0);
  advance(arm, false, true, DEPLOY_SECONDS + 1); assert.equal(arm.deployed, 1);
  workStep(arm, false, false, 0);
  assert.equal(arm.deployed, 0); assert.equal(arm.cycle, 0); assert.equal(arm.sunk, 0);
});

test('the excavator unfolds, keeps scooping while active and folds promptly when extraction stops', () => {
  const arm = advance({}, false, true, DEPLOY_SECONDS / 2);
  assert(arm.deployed > .3 && arm.deployed < .7 && arm.cycle === 0);
  advance(arm, false, true, DEPLOY_SECONDS + 2 * SCOOP_SECONDS);
  assert.equal(arm.deployed, 1); assert(arm.cycle > SCOOP_SECONDS);
  advance(arm, false, false, STOW_SECONDS / 2); assert(arm.deployed > 0 && arm.deployed < 1);
  advance(arm, false, false, STOW_SECONDS);
  assert.equal(arm.deployed, 0); assert.equal(arm.cycle, 0);
});

test('a drill retracts its string before folding the complete rig', () => {
  const arm = advance({}, true, true, DEPLOY_SECONDS + SINK_SECONDS + .3);
  assert.equal(arm.deployed, 1); assert.equal(arm.sunk, 1);
  const cycle = arm.cycle;
  advance(arm, true, false, .5);
  assert(arm.sunk > 0 && arm.sunk < 1); assert.equal(arm.deployed, 1);
  assert.equal(arm.cycle, cycle, 'the string retracts without continuing the drilling cycle');
  advance(arm, true, false, SINK_SECONDS + STOW_SECONDS + .1);
  assert.equal(arm.sunk, 0); assert.equal(arm.deployed, 0);
});

test('a folded tool needs no terrain query and every articulated link keeps its installed length', () => {
  for (const kind of ['excavator', 'drill']) for (const side of [1, -1]) for (const angle of [0, .1, -.1]) {
    const p = piece(kind, { angle }), layout = workLayout(p, frame, side), folded = workFigure(layout, {}, () => { throw new Error('folded ground query'); });
    assert(near(distance(folded.mount, folded.elbow), layout.boom)); assert(near(distance(folded.elbow, folded.wrist), layout.stick));
    assert.equal(folded.rig ? folded.sunk : folded.load, 0);
    // The seat stands on the casing as it is painted, straight under the seat across the top of the piece.
    const up = { x: -Math.sin(angle), y: Math.cos(angle) };
    assert(near(distance(folded.base, folded.mount), CASING[kind] * p.height));
    assert(near((folded.mount.x - folded.base.x) * up.x + (folded.mount.y - folded.base.y) * up.y, CASING[kind] * p.height));
    const arm = {};
    for (let time = 0; time < 18; time += .05) {
      workStep(arm, layout.rig, time < 13, time);
      const figure = workFigure(layout, arm, level);
      assert(near(distance(figure.mount, figure.elbow), layout.boom)); assert(near(distance(figure.elbow, figure.wrist), layout.stick));
      assert(near(distance(figure.wrist, figure.tip), layout.rig ? layout.mast : layout.bucket));
      for (const point of [figure.mount, figure.elbow, figure.wrist, figure.tip]) assert(Number.isFinite(point.x) && Number.isFinite(point.y));
    }
    assert.equal(arm.deployed, 0);
  }
});

test('the bucket digs beyond the construction and tips onto the deposit without a hopper target', () => {
  for (const side of [1, -1]) {
    const p = piece('excavator'), layout = workLayout(p, frame, side), end = p.x + (side > 0 ? frame.right : frame.left),
      at = share => workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, level), tipped = at(.8);
    assert(side * (tipped.tip.x - end) > .3, 'the pile is outside the vehicle');
    assert(tipped.tip.y > 0 && tipped.spill > 0 && tipped.load < .2); assert.equal(tipped.floor, 0);
    assert(at(.4).load > .99); assert.equal(at(.9).load, 0); assert(at(.2).dig && near(at(.2).dig.y, 0));
    const stopped = workFigure(layout, { deployed: 1, working: false, cycle: .8 * SCOOP_SECONDS }, level);
    assert.equal(stopped.spill, null); assert.equal(stopped.load, 0); assert.equal(stopped.dust, null);
  }
});

test('a scaled excavator works extended and low, with its teeth following the ground through the digging stroke', () => {
  for (const size of [.5, 1, 2]) for (const side of [-1, 1]) for (const grade of [0, .2, -.2]) {
    const p = piece('excavator', { y: 1.07 * size, width: 1.2 * size, height: .6 * size }),
      bounds = { left: (side < 0 ? -.6 : -5) * size, right: (side > 0 ? .6 : 5) * size, bottom: -1.07 * size },
      ground = x => grade * (x - p.x), layout = workLayout(p, bounds, side, ground);
    assert(workReachable(layout, ground));
    assert(layout.out > layout.length * .6, 'the useful target extends well beyond the base');
    for (let share = 0; share < 1; share += .01) {
      const figure = workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, ground);
      assert(figure.elbow.y - ground(figure.elbow.x) < 2.9 * size, 'the working boom does not tower over the vehicle');
      if (share >= .11 && share <= .27) {
        assert(near(figure.tip.y, ground(figure.tip.x)), 'teeth follow the material, rather than an interpolated wrist arc');
        assert(figure.dig && near(figure.dig.x, figure.tip.x) && near(figure.dig.y, ground(figure.tip.x)));
      }
    }
  }
});

test('unreachable terrain produces no dust under a suspended bucket', () => {
  const layout = workLayout(piece('excavator'), frame, 1), ground = () => -20,
    figure = workFigure(layout, { deployed: 1, working: true, cycle: .2 * SCOOP_SECONDS }, ground);
  assert.equal(workReachable(layout, ground), false);
  assert(figure.tip.y > ground(figure.tip.x) + 10);
  assert.equal(figure.dig, null); assert.equal(figure.dust, null);
});

function hauler(size, side, angle, raised = 0) {
  const c = Math.cos(angle), s = Math.sin(angle), p = piece('excavator', { angle, y: 1.1 * size, width: 1.2 * size, height: .6 * size }),
    hopper = { id: 'bed', kind: 'hopper', x: p.x - side * c * 1.6 * size, y: p.y - side * s * 1.6 * size + raised * size,
      angle, width: 1.6 * size, height: .9 * size, capacityM3: 1 },
    bounds = { left: (side < 0 ? -.6 : -4) * size, right: (side > 0 ? .6 : 4) * size, bottom: -1.1 * size },
    ground = x => Math.tan(angle) * (x - p.x), layout = workLayout(p, bounds, side, ground),
    delivery = workDelivery(layout, [p, hopper], null, ground),
    at = share => workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, ground, delivery);
  return { c, s, hopper, layout, ground, delivery, at };
}

test('an excavator lifts its scoop to the hopper centre, opens there and returns empty above the body', () => {
  for (const size of [.5, 1, 2]) for (const side of [-1, 1]) for (const angle of [-.15, 0, .15]) for (const raised of [0, .6]) {
    const { c, s, hopper, layout, ground, delivery, at } = hauler(size, side, angle, raised);
    assert(delivery && delivery.partId === hopper.id);
    const centre = hopper.x - s * hopper.height / 2;
    if (!raised) assert(near(delivery.x, centre), 'the middle of the real opening is preferred');
    assert(Math.abs(delivery.x - centre) < c * hopper.width / 2, 'the chosen mouth stays in the real opening');
    for (const share of [.11, .2, .27]) assert.deepEqual(at(share),
      workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, ground), 'delivery never changes the admitted digging stroke');
    assert(near(at(.74).tip.x, delivery.x)); assert(near(at(.74).floor, delivery.floor));
    assert(at(.68).load > .99 && at(.79).load < .1); assert.equal(at(.9).spill, null); assert.equal(at(.9).load, 0);
    for (let share = .4; share < .98; share += .01) {
      const figure = at(share);
      assert(near(distance(figure.mount, figure.elbow), layout.boom)); assert(near(distance(figure.elbow, figure.wrist), layout.stick));
      for (const [a, b] of [[figure.elbow, figure.wrist], [figure.wrist, figure.tip]]) for (let i = 1; i < 20; i++) {
        const x = a.x + (b.x - a.x) * i / 20 - hopper.x, y = a.y + (b.y - a.y) * i / 20 - hopper.y,
          localX = c * x + s * y, localY = c * y - s * x;
        assert(!(Math.abs(localX) < hopper.width / 2 - .01 && Math.abs(localY) < hopper.height / 2 - .01), 'the bucket and stick stay outside the container');
      }
    }
  }
});

test('carrying across the pivot and returning have continuous joints, including an elevated hopper', () => {
  for (const side of [-1, 1]) for (const raised of [0, .85]) {
    const { at } = hauler(1, side, 0, raised);
    let previous = at(0);
    for (let i = 1; i <= 1000; i++) {
      const figure = at(i / 1000);
      for (const part of ['elbow', 'wrist', 'tip'])
        assert(distance(figure[part], previous[part]) < .3, `${part} cannot teleport between adjacent poses`);
      previous = figure;
    }
  }
});

test('the joint bend follows its hopper for the entire scoop even when the mouth crosses the pivot', () => {
  for (const side of [-1, 1]) {
    const p = piece('excavator', { y: 1.1 }), layout = workLayout(p, { left: side < 0 ? -.6 : -4, right: side > 0 ? .6 : 4, bottom: -1.1 }, side),
      hopper = { id: 'bed', kind: 'hopper', x: layout.mount.x - side * 1e-6, y: p.y + .85, width: 1.6, height: .9, capacityM3: 1 },
      arm = { deployed: 1, working: true, cycle: .74 * SCOOP_SECONDS },
      first = workDelivery(layout, [p, hopper], null, level, arm), before = workFigure(layout, arm, level, first);
    assert.equal(first.branch, -1);
    hopper.x += side * 2e-6;
    const next = workDelivery(layout, [p, hopper], null, level, arm), after = workFigure(layout, arm, level, next);
    assert.equal(next.branch, first.branch);
    assert(distance(before.elbow, after.elbow) < 1e-4);
    assert(near(after.tip.x - before.tip.x, side * 2e-6), 'the mouth still follows the real container');
    arm.cycle += SCOOP_SECONDS;
    assert.equal(workDelivery(layout, [p, hopper], null, level, arm).branch, 1, 'the next scoop may choose the other bend');
  }
});

test('a bare extractor delivers to the actual site centre and refuses unreachable or obstructed deliveries', () => {
  const p = piece('excavator'), layout = workLayout(p, { left: -4, right: .6, bottom: -1.6 }, 1),
    site = { x: layout.mount.x + layout.out + .1 }, parts = [p], delivery = workDelivery(layout, parts, site, level);
  assert(delivery && delivery.partId === null && near(delivery.x, site.x));
  const figure = workFigure(layout, { deployed: 1, working: true, cycle: .75 * SCOOP_SECONDS }, level, delivery);
  assert(near(figure.tip.x, site.x) && near(figure.floor, 0));
  assert.equal(workDelivery(layout, parts, { x: p.x }, level), null, 'a pile is not dropped through the tool base');
  assert.equal(workDelivery(layout, parts, { x: p.x + 20 }, level), null, 'a distant pile cannot stretch the arm');
  const broad = { id: 'edge', kind: 'hopper', x: 96.4, y: 1.6, width: 2.4, height: .9, capacityM3: 1 }, mouth = workDelivery(layout, [...parts, broad], null, level);
  assert(mouth?.partId === broad.id && mouth.x > broad.x && mouth.x < broad.x + broad.width / 2,
    'an inner point of the mouth is usable when its centre is beyond the installed reach');
  assert(near(workFigure(layout, { deployed: 1, working: true, cycle: .75 * SCOOP_SECONDS }, level, mouth).tip.x, mouth.x));
  const far = { id: 'far', kind: 'hopper', x: 80, y: 1, width: 1.6, height: .9, capacityM3: 1 };
  assert.equal(workDelivery(layout, [...parts, far], null, level), null);
  const detached = { ...far, x: 99, attached: false }, destroyed = { ...far, x: 99, health: 0 };
  assert.equal(workDelivery(layout, [...parts, detached, destroyed], site, level).partId, null);
  const full = { ...far, id: 'full', x: 99, capacityM3: 1, cargo: { ferro: 2400 } };
  assert.equal(workDelivery(layout, [...parts, full], site, level).partId, null, 'a full hopper leaves new material on the site');
  assert.equal(workDelivery(workLayout(piece('drill'), frame, 1), parts, site, () => { throw Error('rig delivery'); }), null);
});

test('pour particles stop at the hopper opening and none follow the empty bucket', () => {
  const p = piece('excavator'), hopper = { id: 'bed', kind: 'hopper', x: 98.4, y: 1.6, width: 1.6, height: .9, capacityM3: 1 },
    layout = workLayout(p, { left: -4, right: .6, bottom: -1.6 }, 1), delivery = workDelivery(layout, [p, hopper], null, level),
    at = share => workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, level, delivery),
    draw = figure => { const g = new GraphicsRecorder(); drawWorkArm(g, figure); return g.calls.filter(call => call[0] === 'circle'); },
    figure = at(.79), pins = draw({ ...figure, spill: null }), particles = draw(figure).filter(call => !pins.some(pin => JSON.stringify(pin) === JSON.stringify(call)));
  assert(particles.length > 0 && particles.every(([, , y]) => y > delivery.floor));
  assert.deepEqual(draw(at(.9)), draw({ ...at(.9), spill: null }));
});

test('released grains keep falling while the empty bucket lifts over an attached component', () => {
  for (const side of [1, -1]) {
    const { layout, hopper, ground } = hauler(1, side, 0), p = piece('excavator', { y: 1.1, width: 1.2, height: .6 }),
      obstacle = piece('command', { x: p.x - side * .5, y: 2.2 }), delivery = workDelivery(layout, [p, hopper, obstacle], null, ground),
      at = share => workFigure(layout, { deployed: 1, working: true, cycle: share * SCOOP_SECONDS }, ground, delivery),
      grain = figure => { const g = new GraphicsRecorder(); drawWorkArm(g, figure); return g.calls.find(call => call[0] === 'circle' && near(call[3], .069)); },
      before = at(.8), after = at(.82), first = grain(before), second = grain(after),
      start = (.8 - .69) * SCOOP_SECONDS - 5 * .07, end = (.82 - .69) * SCOOP_SECONDS - 5 * .07;
    assert(delivery && delivery.lift > delivery.y && workReachable(layout, ground));
    assert(near(before.load, 0) && near(after.load, 0) && after.tip.y > before.tip.y + .1);
    assert(first && second && near(first[2] - second[2], 4.9 * (end * end - start * start)),
      'the same released grain falls under gravity independently of the rising empty bucket');
  }
});

test('a scoop keeps its chosen mouth while that hopper fills, follows its pose and retains it through stow', () => {
  for (const share of [.5, .74]) {
    const p = piece('excavator'), bounds = { left: -4, right: .6, bottom: -1.6 }, layout = workLayout(p, bounds, 1),
      first = { id: 'first', kind: 'hopper', x: 99, y: 1.6, width: 1.6, height: .9, capacityM3: 1, cargo: { ferro: 2390 } },
      next = { ...first, id: 'next', x: 98, cargo: {} }, arm = { deployed: 1, working: true, cycle: share * SCOOP_SECONDS, time: 10 },
      chosen = workDelivery(layout, [p, first, next], null, level, arm);
    assert.equal(chosen.partId, first.id);
    first.cargo.ferro = 2400;
    const shift = part => ({ ...part, x: part.x + 1.25, y: part.y + .3 }), shifted = [p, first, next].map(shift), moved = workLayout(shift(p), bounds, 1),
      followed = workDelivery(moved, shifted, null, level, arm);
    assert.equal(followed.partId, first.id); assert(near(followed.x - chosen.x, 1.25)); assert(near(followed.y - chosen.y, .3));
    workStep(arm, false, false, 10.1);
    const stowing = workDelivery(moved, shifted, null, level, arm);
    assert.equal(stowing.partId, first.id); assert(near(stowing.x, followed.x) && near(stowing.y, followed.y));
    advance(arm, false, false, STOW_SECONDS); assert.equal(arm.deployed, 0); assert.equal(arm.delivery, undefined);
    workStep(arm, false, true, arm.time + .05);
    assert.equal(workDelivery(moved, shifted, null, level, arm).partId, next.id, 'the next scoop chooses a container with room');
    workStep(arm, false, false, 0); assert.equal(arm.delivery, undefined, 'a rewound world clock drops the presentation memory');
  }
});

test('a pure extractor keeps its real site destination when authoritative extraction ends and it folds', () => {
  const p = piece('excavator'), layout = workLayout(p, { left: -4, right: .6, bottom: -1.6 }, 1),
    site = { id: 'vein', x: layout.mount.x + layout.out + .1, material: 'ferro' },
    arm = { deployed: 1, working: true, cycle: .74 * SCOOP_SECONDS, time: 10 }, delivery = workDelivery(layout, [p], site, level, arm);
  workStep(arm, false, false, 10.1);
  const stowing = workDelivery(layout, [p], undefined, level, arm);
  assert.deepEqual(stowing, delivery); assert.equal(arm.delivery.site.id, site.id);
  const figure = workFigure(layout, arm, level, stowing);
  assert.equal(figure.load, 0); assert.equal(figure.spill, null);
  advance(arm, false, false, STOW_SECONDS); assert.equal(arm.delivery, undefined);
});

test('the drill stands over real ground and shows flow only during authoritative extraction', () => {
  for (const side of [1, -1]) {
    const layout = workLayout(piece('drill'), frame, side),
      up = workFigure(layout, { deployed: 1, sunk: 0, cycle: 1, working: true }, level),
      down = workFigure(layout, { deployed: 1, sunk: 1, cycle: 4, working: true }, level);
    assert(near(up.wrist.x, up.tip.x)); assert(up.wrist.y > up.tip.y);
    assert.equal(up.collar, null); assert.equal(up.flow, null);
    assert(near(down.bit.y, 0)); assert(down.collar && near(down.collar.y, 0)); assert.notEqual(down.flow, null);
    assert.equal(workFigure(layout, { deployed: 1, sunk: 1, cycle: 4, working: false }, level).flow, null);
  }
});

test('extractor artwork is deterministic, finite and cheaper from afar', () => {
  for (const kind of ['excavator', 'drill']) {
    const layout = workLayout(piece(kind), frame, 1), reach = layout.length + (layout.rig ? layout.mast : layout.bucket) + 1.5,
      figures = [workFigure(layout), ...[.05, .2, .6, .75, .8].map(share =>
        workFigure(layout, { deployed: 1, sunk: 1, working: true, cycle: share * SCOOP_SECONDS }, level))];
    for (const figure of figures) {
      const draw = pixel => { const g = new GraphicsRecorder(); drawWorkArm(g, figure, { pixel, material: 'silica' }); return g.calls; },
        close = draw(.01), far = draw(.2);
      assert.deepEqual(close, draw(.01)); assert(far.length < close.length && far.length > 4);
      for (const call of close) for (const value of call.slice(1).flat()) if (typeof value === 'number') assert(Number.isFinite(value));
      const places = close.flatMap(c => c[0] === 'poly' ? c[1].flatMap((v, i) => i % 2 ? [] : [[v, c[1][i + 1]]]) :
        ['moveTo', 'lineTo', 'circle', 'ellipse'].includes(c[0]) ? [[c[1], c[2]]] : []);
      for (const [x, y] of places) assert(Math.hypot(x - figure.mount.x, y - figure.mount.y) < reach);
    }
  }
});

// A builder at a scale, on a deck that runs the length of its construction, and the end of that construction on a side.
function crane(size = 1, side = 1, more = {}) {
  const p = piece('builder', { y: 1.6 * size, width: 1.2 * size, height: .6 * size, ...more }),
    bounds = { left: -2.5 * size, right: 2.3 * size, bottom: -1.6 * size },
    deck = { definition: { x: 100 - .1 * size, y: 1.25 * size, angle: 0, length: 4.8 * size, thicknessMm: 100 * size } };
  return { p, bounds, parts: [p, deck], layout: craneLayout(p, bounds, side), end: 100 + (side > 0 ? bounds.right : bounds.left) };
}
const lifting = (layout, share, route, working = true) => craneFigure(layout, { deployed: 1, working, cycle: share * LIFT_SECONDS }, route),
  links = (layout, figure) => near(distance(figure.pivot, figure.knuckle), layout.boom) && near(distance(figure.knuckle, figure.sleeve), layout.jib) &&
    near(distance(figure.sleeve, figure.tip), figure.run) && near(figure.hook.x, figure.tip.x) && figure.hook.y < figure.tip.y;

test('a folded crane lies low over its construction, carries nothing and keeps its links through unfolding, lifts and folding', () => {
  for (const side of [1, -1]) for (const angle of [0, .1, -.1]) for (const size of [.5, 1, 2]) {
    const { p, bounds, parts, layout } = crane(size, side, { angle }), folded = craneFigure(layout),
      works = { lo: 100 + side * 3.5 * size - 1.2 * size, hi: 100 + side * 3.5 * size + 1.2 * size };
    works.boxes = [{ lo: works.lo, hi: works.hi, top: .3 * size }];
    assert.equal(folded.load, null); assert.equal(folded.run, 0); assert(links(layout, folded));
    assert(near(distance(layout.mount, layout.pivot), .3 * size));
    for (const point of [folded.knuckle, folded.sleeve, folded.tip, folded.hook]) {
      assert(point.x > p.x + bounds.left && point.x < p.x + bounds.right, 'a folded crane stays over its construction');
      assert(Math.abs(point.y - layout.pivot.y) < .35 * size, 'and lies low on its column');
    }
    const arm = craneStep({}, 'fold', 0);
    let before = null;
    for (let time = .05; time < 26; time += .05) {
      craneStep(arm, time < 22 ? 'work' : 'fold', time);
      const figure = craneFigure(layout, arm, arm.working || arm.deployed ? craneRoute(layout, parts, level, works) : null);
      assert(links(layout, figure));
      for (const point of [figure.knuckle, figure.sleeve, figure.tip, figure.hook]) assert(Number.isFinite(point.x) && Number.isFinite(point.y));
      const { pivot, knuckle, tip } = figure;
      assert(side * ((tip.x - pivot.x) * (knuckle.y - pivot.y) - (tip.y - pivot.y) * (knuckle.x - pivot.x)) > 0, 'the knuckle stays over the line to the tip');
      // From level on its rest the main boom sweeps up to a quarter turn in the first part of its unfolding.
      if (before) assert(distance(before.tip, tip) < .5 * size && distance(before.knuckle, knuckle) < .22 * size, 'the booms move without a jump');
      before = figure;
    }
    assert.equal(arm.deployed, 0); assert.equal(arm.cycle, 0);
  }
});

test('a folded crane stands on the casing of its piece, its booms laid level on the boom rest and its hook made fast on the casing', () => {
  for (const side of [1, -1]) for (const angle of [0, .1, -.1]) for (const size of [.5, 1, 2]) {
    const { p, parts, layout } = crane(size, side, { angle }), folded = craneFigure(layout),
      along = { x: Math.cos(angle), y: Math.sin(angle) }, up = { x: -along.y, y: along.x },
      over = q => (q.x - p.x) * up.x + (q.y - p.y) * up.y, across = q => side * ((q.x - p.x) * along.x + (q.y - p.y) * along.y),
      casing = (.5 - CASING.builder) * p.height, label = `side ${side}, angle ${angle}, size ${size}`;
    // The slewing base stands on the casing as it is painted, under the column; the rest on it at the far end of the piece.
    assert(near(over(folded.base), casing) && near(across(folded.base), across(folded.mount)), label);
    assert(near(over(folded.rest.foot), casing) && across(folded.rest.foot) > 0 && across(folded.rest.foot) < p.width / 2, label);
    // Level with the piece, the main boom; the outer boom under it lies over the rest, and nothing of it under the casing.
    assert(near(over(folded.knuckle), over(folded.pivot)), label);
    const { knuckle, sleeve } = folded, head = folded.rest.head,
      cross = (head.x - knuckle.x) * (sleeve.y - knuckle.y) - (head.y - knuckle.y) * (sleeve.x - knuckle.x);
    assert(near(cross, 0, 1e-9 * size) && distance(head, knuckle) < layout.jib && distance(head, sleeve) < layout.jib, label);
    assert(over(head) - casing > .3 * size && over(sleeve) > over(folded.mount), label);
    // The hook hangs from the tip beside the column onto the casing.
    const point = { x: folded.hook.x, y: folded.hook.y - folded.block - folded.crook },
      floor = folded.base.y + (point.x - folded.base.x) * along.y / along.x;
    assert(near(point.y, floor, 1e-9 * size) && across(folded.hook) - across(folded.mount) > .25 * size, label);
    // Unfolding raises the main boom off its rest.
    assert(over(craneFigure(layout, { deployed: .3 }, craneRoute(layout, parts, level, null)).knuckle) > over(folded.pivot) + .5 * size, label);
  }
});

test('the crane takes each load from its construction, carries it clear over all between and sets it into the works', () => {
  for (const side of [1, -1]) for (const size of [.5, 1, 2]) {
    const { parts, layout, end } = crane(size, side), near0 = end + side * .8 * size, far0 = near0 + side * 2.5 * size,
      works = { lo: Math.min(near0, far0), hi: Math.max(near0, far0), down: false };
    works.boxes = [{ lo: works.lo, hi: works.hi, top: .4 * size }];
    assert.equal(craneSide(parts[0], works), side);
    const route = craneRoute(layout, parts, level, works), at = share => lifting(layout, share, route);
    assert(near(side * (route.from.x - layout.pivot.x), 1.9 * size), 'with no supply piece, from the deck past the column');
    assert(near(route.from.floor, 1.3 * size)); assert(near(route.to.x, near0 + side * .6 * size)); assert(near(route.to.floor, .4 * size));
    assert.deepEqual(at(.05).load, { x: route.from.x, y: route.from.floor, shown: .5, hung: false, width: size, height: .44 * size });
    assert(near(at(.15).tip.x, route.from.x) && near(at(.15).load.y, route.from.floor) && at(.15).load.hung);
    for (let share = .15; share < .71; share += .01) {
      const { load, hook } = at(share), under = [...boxesOf(parts), ...works.boxes].filter(box => box.lo < load.x + load.width / 2 && box.hi > load.x - load.width / 2);
      assert(load.hung && near(load.x, hook.x));
      assert(under.every(box => load.y > box.top - 1e-9) && load.y >= 0, 'a load hangs clear of the construction, the works and the ground');
    }
    const set = at(.7);
    assert(near(set.tip.x, route.to.x) && near(set.tip.y, route.lift) && near(set.load.y, route.to.floor));
    assert.deepEqual(at(.8).load, { x: route.to.x, y: route.to.floor, shown: 1, hung: false, width: size, height: .44 * size });
    assert(near(at(.93).load.shown, .5)); assert(at(.999).load.shown > 0);
    assert.equal(lifting(layout, .4, route, false).load, null, 'a crane told nothing to build carries nothing');
    assert.equal(craneFigure(layout, { deployed: .9, working: true, cycle: 0 }, route).load, null);
  }
});

test('a crane takes a structure down onto the ground before it, where its heap will lie', () => {
  for (const side of [1, -1]) for (const size of [.5, 1, 2]) {
    const { parts, layout, end } = crane(size, side), near0 = end + side * .8 * size, far0 = near0 + side * 2.5 * size,
      lo = Math.min(near0, far0), hi = Math.max(near0, far0), target = { lo, hi, down: true, boxes: [{ lo, hi, top: 2 * size }] },
      route = craneRoute(layout, parts, level, target), at = share => lifting(layout, share, route);
    assert(route.from.x >= lo && route.from.x <= hi && near(route.from.floor, 2 * size), 'a load is taken off the top of the structure');
    assert(side * (near0 - route.to.x) >= .7 * size - 1e-9 && side * (route.to.x - end) > 0 && route.to.floor === 0,
      'and set on the ground between the structure and the construction');
    assert(near(at(.05).load.x, route.from.x) && near(at(.05).load.y, route.from.floor));
    assert(near(at(.8).load.x, route.to.x) && at(.8).load.y === 0);
  }
});

test('crane parking uses its real end, leaves the body clear through arrival and never crosses a structure to dismantle it', () => {
  for (const mirror of [1, -1]) {
    const p = piece('builder', { x: 100 - mirror * 2, y: 1.4, health: 1 }),
      deck = { x: 100, y: 1.1, length: 7.4, thicknessMm: 100, angle: 0 },
      parts = [p, deck], ends = [100 + mirror * 10, 100 + mirror * 13].sort((a, b) => a - b),
      target = { lo: ends[0], hi: ends[1], down: false, boxes: [{ lo: ends[0], hi: ends[1], top: 2.4 }] },
      options = { x: 100, arrival: .45, clearance: .8 }, goal = craneParking(parts, target, level, options);
    assert.notEqual(goal, null);
    assert(mirror * (goal - (target.lo + target.hi) / 2) > 0, 'the rear tool works back towards the unfinished site');
    for (const delta of [-options.arrival, 0, options.arrival]) {
      const posed = parts.map(part => ({ ...part, x: part.x + goal + delta - options.x })),
        layout = craneLayout(posed[0], workFrame(posed[0], posed), craneSide(posed[0], target)),
        route = craneRoute(layout, posed, level, target), figure = lifting(layout, .7, route), boxes = boxesOf(posed);
      assert(figure.tip.x >= target.lo - 1e-9 && figure.tip.x <= target.hi + 1e-9, 'the actual drawn tip is over the work');
      assert(near(figure.tip.x, route.to.x) && near(figure.tip.y, route.lift), 'the installed links reach the chosen point');
      assert(Math.max(...boxes.map(box => box.hi)) <= target.lo - options.clearance + 1e-9 ||
        Math.min(...boxes.map(box => box.lo)) >= target.hi + options.clearance - 1e-9, 'the vehicle keeps its real clearance');
    }
    assert.equal(craneParking(parts, { ...target, down: true }, level, options), null,
      'the opposite end cannot be approached through an existing structure');
    const tall = { ...target, boxes: [{ ...target.boxes[0], top: 12 }] };
    assert.equal(craneParking(parts, tall, level, options), null, 'a high work never lengthens the boom');
    assert.equal(craneParking([{ ...p, health: 0 }, deck], target, level, options), null, 'a destroyed crane offers no stop');
    const parked = parts.map(part => ({ ...part, x: part.x + goal - options.x }));
    assert.equal(craneParking(parked, target, level, { ...options, x: goal }), goal, 'already well placed, it stays');
  }
});

test('out of reach a crane works towards what it is at, and with nothing known a little past its construction', () => {
  for (const side of [1, -1]) for (const size of [.5, 1, 2]) {
    const { p, bounds, parts, layout, end } = crane(size, side), lo = end + side * 20, hi = lo + side * 3,
      target = { lo: Math.min(lo, hi), hi: Math.max(lo, hi), down: false, boxes: [] },
      route = craneRoute(layout, parts, level, target), out = side * (route.to.x - layout.pivot.x);
    assert(out < .96 * (layout.boom + layout.jib + layout.telescope) && out > 2.5 * size && route.to.floor === 0);
    assert(near(lifting(layout, .7, route).tip.x, route.to.x), 'its tip reaches as far as the route goes');
    const unknown = craneRoute(layout, parts, level, null);
    assert(near(unknown.to.x, end + side * 1.2 * size)); assert.equal(unknown.to.floor, 0);
    // A supply piece far enough from the column is where loads are taken from; one too near, or destroyed, is not.
    const supply = { kind: 'supply', id: 'stores', x: layout.pivot.x + side * 2.4 * size, y: 1.8 * size, angle: 0, width: 1.4 * size, height: size };
    const supplied = craneRoute(layout, [...parts, supply], level, null);
    assert(near(supplied.from.x, supply.x) && near(supplied.from.floor, 2.3 * size));
    for (const other of [{ ...supply, x: layout.pivot.x + side * size }, { ...supply, health: 0 }, { ...supply, attached: false }])
      assert(near(craneRoute(layout, [...parts, other], level, null).from.x, layout.pivot.x + side * 1.9 * size));
  }
});

test('a crane that falls short of a works over its own construction only reaches out to it, its hook up there', () => {
  const p = piece('builder', { width: 1.2, height: .6 }), deck = length => ({ definition: { x: 100.6 - length / 2, y: 1.25, angle: 0, length, thicknessMm: 100 } }),
    works = (lo, hi) => ({ lo, hi, down: false, boxes: [{ lo, hi, top: .4 }] }),
    layout = (parts, target) => craneLayout(p, workFrame(p, parts), craneSide(p, target)),
    route = (parts, target) => craneRoute(layout(parts, target), parts, level, target);
  const long = [p, deck(10)], far = works(88, 90), across = route(long, far);
  assert(across.short && across.to.x > 90.6 && across.to.x < 100 && across.from === across.to, 'over its own deck, short of the works');
  const rest = craneFigure(layout(long, far), { deployed: 1, cycle: 0 }, across);
  assert(near(rest.tip.x, across.to.x) && near(rest.tip.y - rest.hook.y, .25) && rest.load === null, 'out over it, its hook up');
  const staged = route([p, deck(2)], far);
  assert(!staged.short && staged.to.x < 98.6 && staged.to.floor === 0 && staged.from.x > staged.to.x, 'short of it over the ground it sets its loads there');
  const reached = route([p, deck(2)], works(96, 98));
  assert(!reached.short && reached.to.x >= 96 && reached.to.x <= 98);
});

test('a crane follows its installed scale', () => {
  const unit = crane(1, 1);
  for (const size of [.5, 2]) {
    const scaled = crane(size, 1);
    for (const key of ['boom', 'jib', 'telescope']) assert(near(scaled.layout[key], unit.layout[key] * size));
    assert(near(scaled.layout.pivot.y - scaled.p.y, (unit.layout.pivot.y - unit.p.y) * size));
    const route = craneRoute(scaled.layout, scaled.parts, level, null), figure = lifting(scaled.layout, .4, route);
    assert.equal(figure.size, size); assert(near(figure.load.width, size)); assert(near(figure.block, .2 * size));
  }
});

test('a builder lifts at the pace its engines give it and unfolds at its own', () => {
  const full = craneStep({}, 'fold', 0), half = craneStep({}, 'fold', 0);
  for (let time = .05; time <= 6; time += .05) { craneStep(full, 'work', time); craneStep(half, 'work', time, .5); }
  assert.equal(full.deployed, 1); assert.equal(half.deployed, 1);
  assert(full.cycle > 4 && near(half.cycle, full.cycle / 2, 1e-9));
});

test('a crane at rest sets down the load it lifts and waits out with its hook up where it takes its loads from', () => {
  const { parts, layout, end } = crane(1, 1), works = { lo: end + .8, hi: end + 3.3, down: false, boxes: [{ lo: end + .8, hi: end + 3.3, top: .4 }] },
    route = craneRoute(layout, parts, level, works), arm = craneStep({}, 'fold', 0), figure = () => craneFigure(layout, arm, route);
  let time = 0;
  const run = (duty, seconds) => { for (let i = 0; i < Math.round(seconds * 20); i++) craneStep(arm, duty, time += .05); };
  run('work', DEPLOY_SECONDS + .4 * LIFT_SECONDS);
  assert(arm.deployed === 1 && figure().load?.hung, 'out and lifting');
  run('rest', .5);
  assert(!arm.working && arm.finishing && figure().load?.hung, 'the load on its hook goes on to where it is set down');
  run('rest', LIFT_SECONDS);
  assert(near(arm.cycle, LIFT_SECONDS) && !arm.finishing && arm.deployed === 1, 'and no further: it rests out');
  const resting = figure();
  assert.equal(resting.load, null);
  assert(near(resting.tip.x, route.from.x) && near(resting.tip.y - resting.hook.y, .25), 'its hook up over where it takes its loads from');
  run('work', .05);
  assert(distance(figure().tip, resting.tip) < .02 && figure().load, 'at work again it takes the next load up from there');
  // Folding drops the load: out again before it lay down, it sets nothing down.
  run('work', 2); run('fold', .1);
  assert.equal(figure().load, null); assert(arm.deployed < 1);
  run('rest', 3);
  assert(arm.deployed === 1 && !arm.finishing && figure().load === null);
});

test('a crane seen for the first time at work or at rest is out already', () => {
  for (const duty of ['work', 'rest']) assert.equal(craneStep({}, duty, 5).deployed, 1, duty);
  assert.equal(craneStep({}, 'fold', 5).deployed, 0);
  const arm = craneStep({}, 'fold', 5); craneStep(arm, 'work', 5.05);
  assert(arm.deployed > 0 && arm.deployed < 1, 'one seen folded unfolds');
});

test('a builder stands by what its job sends it to, or with none the nearest of what is beside it', () => {
  const boxes = [{ lo: 0, hi: 7.4, top: 3 }], works = (id, lo, hi) => ({ id, lo, hi, down: false, boxes: [] }),
    ahead = works('ahead', -9, -5.8), behind = works('behind', 9, 12.2), far = works('far', 20, 23);
  for (const job of [null, { kind: null, phase: 'idle', targetId: null }, { kind: null, phase: 'paused', targetId: null }])
    assert.equal(craneStandby(boxes, [far, ahead, behind], job, 7)?.id, 'behind', JSON.stringify(job));
  assert.equal(craneStandby(boxes, [ahead, behind], { kind: 'build', phase: 'work', targetId: 'ahead' }, 7)?.id, 'ahead');
  assert.equal(craneStandby(boxes, [ahead, behind], { kind: 'work', phase: 'deliver', targetId: 'ahead' }, 7)?.id, 'ahead');
  assert.equal(craneStandby(boxes, [ahead, behind], { kind: 'dismantle', phase: 'work', targetId: 'behind' }, 7)?.id, 'behind');
  // On its way, by its base or at another job it stands by nothing; nor by what is out of reach.
  for (const job of [{ kind: 'build', phase: 'go', targetId: 'ahead' }, { kind: 'build', phase: 'collect', targetId: 'ahead' },
    { kind: 'work', phase: 'collect', targetId: 'ahead' }, { kind: 'rearm', phase: 'deliver', targetId: 'other' }])
    assert.equal(craneStandby(boxes, [ahead, behind], job, 7), null, JSON.stringify(job));
  assert.equal(craneStandby(boxes, [far], null, 7), null);
  assert.equal(craneStandby(boxes, [far], { kind: 'build', phase: 'work', targetId: 'far' }, 7), null);
  assert.equal(craneStandby([], [behind], null, 7), null);
  assert.equal(craneStandby(boxes, [works('edge', 7.4 + CRANE_REACH, 9 + CRANE_REACH)])?.id, 'edge', 'by default as far as a crane reaches');
  // Heaps: only the one a job loads, never one it stands by.
  const heap = (id, lo, hi) => ({ ...works(id, lo, hi), gather: true }), pile = heap('pile', 8, 9), other = heap('other', -1, -.5);
  assert.equal(craneStandby(boxes, [pile, other, behind], null, 7)?.id, 'behind');
  assert.equal(craneStandby(boxes, [pile, other], { kind: 'dismantle', phase: 'load', targetId: 'pile' }, 7)?.id, 'pile');
  assert.equal(craneStandby(boxes, [pile, other], { kind: 'heap', phase: 'fetch', targetId: 'pile' }, 7)?.id, 'pile');
  assert.equal(craneStandby(boxes, [pile, other, behind], { kind: 'work', phase: 'fetch', targetId: 'behind' }, 7)?.id, 'other', 'the nearest heap');
  assert.equal(craneStandby(boxes, [pile], { kind: 'build', phase: 'work', targetId: 'pile' }, 7), null);
  assert.equal(craneStandby(boxes, [heap('far', 30, 31)], { kind: 'heap', phase: 'fetch', targetId: 'far' }, 7), null);
});

test('a crane loads a heap it reaches onto its construction, and only reaches out to one it falls short of', () => {
  for (const side of [1, -1]) {
    const { parts, layout, end } = crane(1, side), lo = Math.min(end + side * 2, end + side * 3), hi = lo + 1,
      heap = { lo, hi, down: false, gather: true, boxes: [{ lo, hi, top: .8 }] }, route = craneRoute(layout, parts, level, heap);
    assert(!route.short && route.from.x >= lo && route.from.x <= hi && near(route.from.floor, .8), 'taken off the top of the pile');
    assert(near(side * (route.to.x - layout.pivot.x), 1.9) && side * (route.from.x - route.to.x) > 0, 'set on its own side of it');
    const away = { ...heap, lo: lo + side * 20, hi: hi + side * 20, boxes: [] }, short = craneRoute(layout, parts, level, away);
    assert(short.short && short.from === short.to && side * (short.to.x - layout.pivot.x) < CRANE_REACH);
  }
});

test('crane artwork is deterministic, finite and cheaper from afar, with a load of its material only at work', () => {
  for (const side of [1, -1]) {
    const { parts, layout } = crane(1, side), route = craneRoute(layout, parts, level, null),
      reach = layout.boom + layout.jib + layout.telescope + 1.5, heap = DEPOSIT_TONES.silica.heap,
      figures = [craneFigure(layout), ...[.05, .3, .7, .8, .95].map(share => lifting(layout, share, route))],
      draw = (figure, pixel) => { const g = new GraphicsRecorder(); drawWorkArm(g, figure, { pixel, material: 'silica' }); return g.calls; },
      loaded = calls => calls.some(call => call[0] === 'fill' && call[1]?.color === heap);
    for (const figure of figures) {
      const close = draw(figure, .01), far = draw(figure, .2);
      assert.deepEqual(close, draw(figure, .01)); assert(far.length < close.length && far.length > 4);
      for (const call of close) for (const value of call.slice(1).flat()) if (typeof value === 'number') assert(Number.isFinite(value));
      const places = close.flatMap(c => c[0] === 'poly' ? c[1].flatMap((v, i) => i % 2 ? [] : [[v, c[1][i + 1]]]) :
        ['moveTo', 'lineTo', 'circle', 'rect'].includes(c[0]) ? [[c[1], c[2]]] : []);
      for (const [x, y] of places) assert(Math.hypot(x - layout.pivot.x, y - layout.pivot.y) < reach);
      assert.equal(loaded(close), Boolean(figure.load)); assert.equal(loaded(far), Boolean(figure.load));
    }
    assert.equal(figures[0].load, null); assert(figures.slice(1).every(figure => figure.load));
  }
});
