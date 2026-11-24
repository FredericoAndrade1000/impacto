import test from 'node:test';
import assert from 'node:assert/strict';
import { componentPolygon } from '../src/assembly.ts';
import { trackGear } from '../src/running-gear.ts';
import { workFrame, workSide, workLayout, workFigure, workDelivery, craneLayout, craneFigure, craneRoute, SCOOP_SECONDS, LIFT_SECONDS } from '../src/work-arm.ts';
import { MODULES } from '../src/materials.ts';
import { collectionWork, loadingContainers, workArea } from '../src/loading-area.ts';

const reflected = piece => ({ ...piece, x: -piece.x, angle: -piece.angle, mirrored: !piece.mirrored }),
  near = (a, b) => assert(Math.abs(a - b) < 1e-10, `${a} against ${b}`),
  mirrorPoint = (a, b) => { near(a.x, -b.x); near(a.y, b.y); };

test('a component reflection reflects its actual contour and terrain samples without changing the track layout', () => {
  const terrain = { surface: x => ({ x, y: .014 * Math.sin(x * 1.7), nx: 0, ny: 1 }) },
    opposite = { surface: x => ({ ...terrain.surface(-x), x }) };
  for (const mirrored of [false, true]) for (const angle of [-.2, 0, .2]) {
    const part = { kind: 'track', width: 5.04, height: .74, x: 3, y: .37, angle, mirrored }, other = reflected(part),
      polygon = componentPolygon(part), mirror = componentPolygon(other), original = trackGear(part, terrain), result = trackGear(other, opposite);
    polygon.forEach((point, i) => mirrorPoint(mirror[i], point));
    original.road.forEach((wheel, i) => { near(wheel.x, result.road[i].x); near(wheel.y, result.road[i].y); });
    assert.deepEqual(original.drawn, result.drawn);
    near(original.belt.length, result.belt.length);
  }
});

test('reflection preserves the full excavator and drill cycles on reflected terrain', () => {
  const ground = x => .05 * x, oppositeGround = x => ground(-x);
  for (const kind of ['excavator', 'drill']) {
    const part = { kind, x: 0, y: 1.1, angle: .08, ...MODULES[kind] },
      hull = { kind: 'engine', x: -1.2, y: 1.1, width: 3.4, height: .8, angle: .08 }, other = reflected(part),
      frame = workFrame(part, [part, hull]), mirror = workFrame(other, [other, reflected(hull)]),
      plan = workLayout(part, frame, workSide(frame), ground), result = workLayout(other, mirror, workSide(mirror), oppositeGround);
    mirrorPoint(result.mount, plan.mount); mirrorPoint(result.base, plan.base);
    for (let step = 0; step < 100; step++) {
      const arm = { deployed: step < 20 ? step / 20 : 1, working: true, cycle: step / 100 * SCOOP_SECONDS, sunk: .5 },
        a = workFigure(plan, arm, ground), b = workFigure(result, arm, oppositeGround);
      for (const name of ['mount', 'base', 'elbow', 'wrist', 'tip']) mirrorPoint(b[name], a[name]);
      assert.equal(a.load, b.load); assert.equal(a.rig, b.rig);
    }
  }
});

test('isolated free tools reflect their default seat, complete cycle and collection approach', () => {
  const ground = x => .03 * x, oppositeGround = x => ground(-x);
  for (const kind of ['excavator', 'drill', 'builder']) for (const mirrored of [false, true]) for (const angle of [0, -.08, .08]) {
    const part = { id: 'tool', actorId: 'unit', kind, x: 0, y: 1.1, angle, mirrored, health: 1, ...MODULES[kind] }, other = reflected(part),
      frame = workFrame(part, [part]), mirror = workFrame(other, [other]),
      side = workSide(frame, 0, part.mirrored), oppositeSide = workSide(mirror, 0, other.mirrored), builder = kind === 'builder',
      a = builder ? craneLayout(part, frame, side) : workLayout(part, frame, side, ground),
      b = builder ? craneLayout(other, mirror, oppositeSide) : workLayout(other, mirror, oppositeSide, oppositeGround);
    assert.equal(side, -oppositeSide); mirrorPoint(b.mount, a.mount); mirrorPoint(b.base, a.base);
    const firstRoute = builder ? craneRoute(a, [part], ground) : null, oppositeRoute = builder ? craneRoute(b, [other], oppositeGround) : null;
    for (let step = 0; step < 100; step++) {
      const arm = { deployed: step < 20 ? step / 20 : 1, working: true, cycle: step / 100 * (builder ? LIFT_SECONDS : SCOOP_SECONDS), sunk: .5 },
        first = builder ? craneFigure(a, arm, firstRoute) : workFigure(a, arm, ground),
        mirror = builder ? craneFigure(b, arm, oppositeRoute) : workFigure(b, arm, oppositeGround);
      for (const name of builder ? ['mount', 'base', 'pivot', 'knuckle', 'sleeve', 'tip', 'hook'] : ['mount', 'base', 'elbow', 'wrist', 'tip'])
        mirrorPoint(mirror[name], first[name]);
    }
    if (builder) continue;
    const world = (piece, floor) => ({ time: 0, modules: [piece], plates: [], actor: () => ({ id: 'unit', x: 0 }), terrain: { height: floor } }),
      originalWorld = world(part, ground), mirroredWorld = world(other, oppositeGround),
      first = collectionWork(originalWorld, 'unit')[0], mirrorWork = collectionWork(mirroredWorld, 'unit')[0];
    mirrorPoint(mirrorWork.layout.mount, first.layout.mount); near(mirrorWork.point, -first.point);
    const site = { x: first.point, feature: kind === 'drill' ? 'lowland' : 'outcrop', material: kind === 'drill' ? 'petroleo' : 'ligas' }, oppositeSite = { ...site, x: -site.x },
      firstArea = workArea(originalWorld, 'unit', site, 30), mirrorArea = workArea(mirroredWorld, 'unit', oppositeSite, 30);
    assert(firstArea && mirrorArea); near(mirrorArea.lo, -firstArea.hi); near(mirrorArea.hi, -firstArea.lo); near(mirrorArea.goal, -firstArea.goal);
    assert.equal(mirrorArea.ready, firstArea.ready);
  }
});

test('reflection keeps a remembered canonical hopper mouth and a complete builder lift', () => {
  const piece = { id: 'tool', kind: 'excavator', x: 0, y: 1.1, angle: .08, ...MODULES.excavator },
    hopper = { id: 'bed', kind: 'hopper', x: -1.6, y: 1.1, angle: .08, ...MODULES.hopper, capacityM3: 1 },
    ground = x => .05 * x, oppositeGround = x => ground(-x),
    layout = tool => workLayout(tool, workFrame(tool, [tool]), 1, ground),
    a = layout(piece), other = reflected(piece), b = workLayout(other, workFrame(other, [other]), -1, oppositeGround),
    arm = { cycle: .7 * SCOOP_SECONDS, delivery: { cycle: 0, partId: 'bed', mouth: .2, branch: -1 } },
    first = workDelivery(a, [piece, hopper], null, ground, structuredClone(arm)),
    mirror = workDelivery(b, [other, reflected(hopper)], null, oppositeGround, structuredClone(arm));
  assert(first && mirror); mirrorPoint(mirror, first);

  const builder = { kind: 'builder', x: 0, y: 1.1, angle: .08, ...MODULES.builder },
    sourceParts = [builder, hopper], mirroredParts = sourceParts.map(reflected),
    plan = craneLayout(builder, workFrame(builder, sourceParts), -1),
    result = craneLayout(mirroredParts[0], workFrame(mirroredParts[0], mirroredParts), 1),
    route = craneRoute(plan, sourceParts, ground), oppositeRoute = craneRoute(result, mirroredParts, oppositeGround);
  for (let step = 0; step < 100; step++) {
    const arm = { deployed: step < 20 ? step / 20 : 1, working: true, cycle: step / 100 * LIFT_SECONDS },
      a = craneFigure(plan, arm, route), b = craneFigure(result, arm, oppositeRoute);
    for (const name of ['mount', 'base', 'pivot', 'knuckle', 'sleeve', 'tip', 'hook']) mirrorPoint(b[name], a[name]);
  }
});

test('pickup uses the authored container floor rather than treating a half turn as reflection', () => {
  const piece = { id: 'bin', actorId: 'unit', kind: 'hopper', x: 0, y: 2.3, angle: 0, width: 1, height: .8, capacityM3: .5, health: 1 },
    site = { x: 0, feature: 'outcrop', material: 'ligas' }, world = part => ({
      time: 0, actor: () => ({ id: 'unit', x: 0 }), modules: [part], plates: [], terrain: { height: () => 0 },
    });
  assert.deepEqual(loadingContainers(world(piece), 'unit', site, 30).map(part => part.id), ['bin']);
  assert.deepEqual(loadingContainers(world({ ...piece, mirrored: true }), 'unit', site, 30).map(part => part.id), ['bin']);
  assert.deepEqual(loadingContainers(world({ ...piece, angle: Math.PI }), 'unit', site, 30), []);
});

test('a folded crane on a piece turned on end hangs its hook a cable no longer than the piece', () => {
  for (const angle of [Math.PI / 2, -Math.PI / 2, Math.PI / 2 - 1e-9, 1.4]) for (const mirrored of [false, true]) {
    const part = { id: 'tool', actorId: 'unit', kind: 'builder', x: 0, y: 1.1, angle, mirrored, health: 1, ...MODULES.builder },
      frame = workFrame(part, [part]), figure = craneFigure(craneLayout(part, frame, workSide(frame, 0, mirrored)), { deployed: 0 }),
      cable = Math.hypot(figure.hook.x - figure.tip.x, figure.hook.y - figure.tip.y);
    assert(Number.isFinite(cable) && cable <= Math.hypot(part.width, part.height), `${angle}: ${cable} m`);
  }
});
