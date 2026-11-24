import test from 'node:test';
import assert from 'node:assert/strict';
import { hullLayout, boxWithin, within, CLEAR, BEVEL, FENDER_SLOPE, WHEEL_RISE, fenderAcross, fenderGroups, fenderHeight, fenderLine, fenderOver, outlineEdges, outerFace } from '../src/hull-details.ts';
import { CHASSIS_MODELS } from '../src/chassis.ts';
import { FITTING_KINDS, fittingImpacts, mitredBand } from '../src/hull-art.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { designFrame } from '../src/scene-frame.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';

// The heavy's hull and turret, with what it carries: a gun out of the front of the turret, a sensor on its roof.
const hull = [{ x: 8.6, y: .7 }, { x: 15.4, y: .7 }, { x: 15.28, y: 2.15 }, { x: 13.66, y: 2.15 }, { x: 10.87, y: 2.15 }, { x: 9.25, y: 2.15 }, { x: 8.6, y: 1.6 }],
  turret = [{ x: 10.87, y: 2.15 }, { x: 13.66, y: 2.15 }, { x: 13.46, y: 3.27 }, { x: 10.87, y: 3.27 }],
  pieces = [{ kind: 'engine', x: 14.4, y: 1.33, w: 1.57, h: .96 }, { kind: 'fuel', x: 12.5, y: 1.23, w: .8, h: .72 },
    { kind: 'command', x: 11.05, y: 1.78, w: .44, h: .28 }, { kind: 'weapon', x: 11.14, y: 2.71, w: 1.1, h: .42, angle: Math.PI },
    { kind: 'ammo', x: 10.8, y: 1.18, w: .78, h: .65 }, { kind: 'track', x: 12, y: .38, w: 5.04, h: .74 },
    { kind: 'sensor', x: 11.38, y: 3.42, w: .32, h: .24 }];
// The same turned to face right, as a vehicle that faces right is laid out in its own frame.
const turn = points => points.map(p => ({ ...p, x: 24 - p.x })),
  turnPieces = list => list.map(p => ({ ...p, x: 24 - p.x, angle: p.angle === undefined ? undefined : Math.PI - p.angle }));
const scene = (front, more = {}) => front < 0 ? { front, pieces, seed: 'a', ...more } : { front, pieces: turnPieces(pieces), seed: 'a', ...more };
const rooms = front => front < 0 ? [hull, turret] : [turn(hull), turn(turret)];
const layouts = (front, side = 'outside', more = {}) => {
  const [h, t] = rooms(front);
  return [hullLayout(h, { ...scene(front, more), rooms: [t], side }), hullLayout(t, { ...scene(front, more), rooms: [h], side })];
};
const of = (layout, kind) => layout.fittings.filter(f => f.kind === kind);
const middle = points => (Math.min(...points.map(p => p.x)) + Math.max(...points.map(p => p.x))) / 2;

test('a headlight is at the front of a hull and the tail light at its back, whichever way it faces', () => {
  for (const front of [-1, 1]) {
    const [onHull, onTurret] = layouts(front), [h] = rooms(front), mid = middle(h);
    const [headlight] = of(onHull, 'headlight'), [taillight] = of(onHull, 'taillight');
    assert(headlight && taillight);
    assert(front * (headlight.x - mid) > 2.5, 'the headlight far to the front');
    assert(front * (taillight.x - mid) < -2.5, 'the tail light far to the back');
    // Each is drawn facing the way the hull does; the turret, not at the front of the hull, has none.
    assert.equal(headlight.flip, front > 0); assert.equal(taillight.flip, front > 0);
    assert.equal(of(onTurret, 'headlight').length + of(onTurret, 'taillight').length, 0);
    // The bin is at the back of the turret; a decorative vent stands at the back of the hull.
    const [bin] = of(onTurret, 'bin'), [grille] = of(onHull, 'engine');
    assert(front * (bin.x - middle(rooms(front)[1])) < 0);
    assert(grille && front * (grille.x - mid) < -1.5);
  }
});

test('nothing is fitted over where a weapon goes out of the armour, nor under a sensor', () => {
  for (const front of [-1, 1]) for (const side of ['outside', 'inside']) {
    const [, onTurret] = layouts(front, side), [, t] = rooms(front),
      // The gun goes out of the front of the turret at its height; the sensor stands on its roof.
      port = { x: front < 0 ? 10.87 : 24 - 10.87, y: 2.71, w: .56, h: .56 }, sensor = { x: front < 0 ? 11.38 : 24 - 11.38, y: 3.27 - .1, w: .32, h: .2 };
    assert(onTurret.fittings.length > 1);
    for (const f of onTurret.fittings) {
      for (const box of [port, sensor]) assert(Math.abs(f.x - box.x) >= (f.w + box.w) / 2 || Math.abs(f.y - box.y) >= (f.h + box.h) / 2, `${f.kind} clear of the port and the sensor`);
      assert(within(f, t));
    }
  }
  // A gun that goes out through the roof keeps the hatches off its port.
  const box = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }],
    upward = hullLayout(box, { front: -1, rooms: [], pieces: [{ kind: 'weapon', x: 2, y: 1.6, w: 1.2, h: .3, angle: Math.PI / 2 }] });
  for (const f of upward.fittings) assert(Math.abs(f.x - 2) >= f.w / 2 + .28 || f.y < 2 - .28 - f.h / 2, `${f.kind} clear of the port in the roof`);
});

test('every fitting stands within its outline, clear of the rim, on every template from either side', () => {
  for (const id of ['recon', 'ifv', 'heavy', 'truck', 'tanker', 'supply', 'howitzer', 'mortar', 'scout', 'bunker', 'outpost']) {
    const surfaces = bodyPanelSurfaces(designFrame(compileBlueprint(createConstruction(id))));
    assert(surfaces.length, id);
    let fitted = 0;
    for (const surface of surfaces) for (const side of ['outside', 'inside']) {
      const layout = hullLayout(surface.artPolygon, { ...surface.fittings(), side });
      fitted += layout.fittings.length;
      for (const f of layout.fittings) {
        // Hatches and periscopes stand closest, under the edge of the roof.
        assert(boxWithin(f, surface.artPolygon, ['hatch', 'periscope'].includes(f.kind) ? .008 : ['eye'].includes(f.kind) ? .02 : CLEAR), `${id} ${side} ${f.kind} within`);
        assert(FITTING_KINDS.includes(f.kind), `${f.kind} is drawn`);
        assert(f.w > 0 && f.h > 0);
      }
      for (const [i, a] of layout.fittings.entries()) for (const b of layout.fittings.slice(i + 1))
        assert(Math.abs(a.x - b.x) >= (a.w + b.w) / 2 || Math.abs(a.y - b.y) >= (a.h + b.h) / 2, `${id} ${a.kind} and ${b.kind} apart`);
    }
    if (!surfaces.every(surface => surface.fittings().cast)) assert(fitted > 0, id);
  }
});

test('a structure has nothing a vehicle has, and concrete is cast and has no plates', () => {
  for (const id of ['bunker', 'outpost']) for (const surface of bodyPanelSurfaces(designFrame(compileBlueprint(createConstruction(id))))) {
    const told = surface.fittings(), layout = hullLayout(surface.artPolygon, { ...told, side: 'outside' });
    assert.equal(told.vehicle, false, id);
    for (const kind of ['headlight', 'taillight', 'shackle', 'cable', 'tools', 'cans', 'marker', 'number', 'hatch', 'extinguisher'])
      assert.equal(of(layout, kind).length, 0, `${id}: no ${kind}`);
    if (told.cast) assert.equal(layout.fittings.length, 0, `${id}: cast concrete carries nothing`);
  }
  const cast = hullLayout([{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 2.5 }, { x: 0, y: 2.5 }], { vehicle: false, cast: true });
  assert.equal(cast.fittings.length, 0); assert(cast.seams.length > 4, 'the joints of the formwork');
});

// A cab over the front wheels of a truck, and its wheels: two close together under it, one further back under its rear
// corner, and one under the bed.
const cab = [{ x: 0, y: .9 }, { x: 3.8, y: .9 }, { x: 3.8, y: 2.6 }, { x: 0, y: 2.6 }],
  wheels = [1, 2.6, 4.4, 6.2].map(x => ({ kind: 'wheel', x, y: .5, w: 1, h: 1 })), onCab = side => hullLayout(cab, { front: -1, rooms: [], pieces: wheels, side });

test('the running gear tells the foot of the hull: the stretch of it over a track, and an arch round each axle over wheels', () => {
  const [onHull] = layouts(-1);
  assert.equal(onHull.tracks.length, 1); assert.equal(onHull.arches.length, 0);
  const [over] = onHull.tracks;
  assert(over.x0 < 12 - 2.5 && over.x1 > 12 + 2.5);
  // The skirt of the chassis hangs there: no lashing rings.
  assert.equal(of(onHull, 'ring').length, 0, 'no lashing rings over a skirt');
  // A hull over wheels has an arch round the axles of each group of wheels under one fender the well behind it reaches
  // its foot over: the two close together it stands over, as one, and the one it only overhangs by the corner, but not
  // the one behind it. Each tells the axles the foot stands over (`over`); a cab over the first of two wheels under one
  // fender stands over that one alone.
  const onTruck = onCab('outside');
  assert.deepEqual(onTruck.arches, [{ x: 1.8, y: .5, r: .5, half: .8, axles: [1, 2.6], over: [1, 2.6] }, { x: 4.4, y: .5, r: .5, half: 0, axles: [4.4], over: [] }]);
  assert.deepEqual(hullLayout(cab.map(p => ({ ...p, x: Math.min(p.x, 2) })), { front: -1, rooms: [], pieces: wheels.slice(0, 2), side: 'outside' }).arches.map(arch => arch.over), [[1]]);
  assert.deepEqual(onTruck.feet, [{ x0: 0, x1: 3.8, y: .9 }]);
  assert.equal(onTruck.tracks.length, 0);
  assert.equal(of(onTruck, 'marker').length, 2, 'a reflector near either end of a vehicle on wheels');
  // Nothing is fitted where a fender stands in front of the foot.
  for (const f of onTruck.fittings) for (const { x, r, half } of onTruck.arches)
    assert(Math.abs(f.x - x) >= f.w / 2 + half + fenderOver(r).outer || f.y - f.h / 2 >= .5 + fenderOver(r).outer, f.kind);
});

test('each skin only paints wells for wheels whose own envelopes reach its floor', () => {
  // E1's two 0.6 m cells share a divider at x=.25; only the central axle reaches either floor.
  const skin = (x0, x1, y = 1.056) => [{ x: x0, y }, { x: x1, y }, { x: x1, y: y + .6 }, { x: x0, y: y + .6 }];
  for (const reflection of [1, -1]) {
    const reflect = points => points.map(point => ({ ...point, x: point.x * reflection })),
      cells = [skin(-.9, .25), skin(.25, .9)].map(reflect),
      row = [-1.75, -.05, 1.7].map(x => ({ kind: 'wheel', x: x * reflection, y: .56, w: 1.1, h: 1.1 })),
      xs = row.map(wheel => wheel.x).sort((a, b) => a - b), axle = -.05 * reflection,
      full = reflect(skin(-2.6, 2.6)), gap = reflect(skin(.75, .9)), above = reflect(skin(-.9, .25, 1.4));
    for (const side of ['outside', 'inside']) {
      const scene = { front: -reflection, pieces: row, side },
        central = hullLayout(cells[0], { ...scene, rooms: [cells[1]] }),
        neighbour = hullLayout(cells[1], { ...scene, rooms: [cells[0]] }),
        entire = hullLayout(full, scene), between = hullLayout(gap, scene), high = hullLayout(above, scene);
      assert.deepEqual(central.arches, [{ x: axle, y: .56, r: .55, half: 0, axles: [axle], over: [axle] }],
        'the central cell no longer inherits either distant end axle');
      assert.deepEqual(neighbour.arches, [{ x: axle, y: .56, r: .55, half: 0, axles: [axle], over: [] }],
        'the adjacent cell keeps the legitimate partial corner, without pretending an axle is under it');
      assert.deepEqual(entire.arches, [{ x: -.025 * reflection, y: .56, r: .55, half: 1.725, axles: xs, over: xs }],
        'a floor actually over the whole row keeps the complete shared well');
      assert.equal(between.arches.length, 0, 'the gap between individual envelopes cannot borrow the whole group');
      assert.equal(high.arches.length, 0, 'a floor above the unchanged suspension envelope has no wheel well');
      if (side === 'outside') for (const layout of [central, neighbour, between])
        for (const fitting of layout.fittings)
          assert(fitting.y - fitting.h / 2 >= .56 + fenderOver(.55).outer,
            fitting.kind + ': the unchanged foreground chassis guard still blocks lower fittings');
    }
  }
});

test('a fender stands as far clear of its wheel as the wheel rises to its stop, its band in proportion to it', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9;
  // A wheel rises to its stop the two thirds of the travel of the wheeled chassis its springs leave above it as built.
  assert(near(WHEEL_RISE, CHASSIS_MODELS.wheeled.travel * 2 / 3));
  let last = null;
  for (const r of [.3, .45, .6, .9]) {
    const { gap, band, inner, outer, round } = fenderOver(r);
    assert(near(gap, WHEEL_RISE) && near(band, .26 * r) && near(inner, r + gap) && near(outer, inner + band) && near(round, .3 * band), `${r}`);
    // The tyre risen to its stop meets its inner edge over the axle, and nowhere sooner.
    assert(near(inner - WHEEL_RISE, r), `${r}: met at the stop`);
    if (last) assert(band > last.band, 'the bigger the wheel, the wider its band');
    last = { band };
  }
  // Over the wheel of the wheeled chassis the tyre stands about a third of its radius under the fender.
  const wheel = CHASSIS_MODELS.wheeled.wheel / 2, deep = fenderOver(wheel).gap / wheel;
  assert(deep > .25 && deep < .35, `${deep}`);
});

test('wheels of a row so close that their fenders would meet, or leave less than a band between them, have one fender over them all', () => {
  const { outer, band } = fenderOver(.5), apart = 2 * outer + band, row = xs => xs.map(x => ({ x, y: .5, r: .5 }));
  // Two wheels: one fender a little closer than the fenders and a band, two a little further.
  assert.deepEqual(fenderGroups(row([0, apart - .001])).map(g => g.axles.length), [2]);
  assert.deepEqual(fenderGroups(row([0, apart + .001])).map(g => g.axles.length), [1, 1]);
  // Three in a row, each close to the next, under one, by the middle of the end axles and half the way between them;
  // a fourth further on has its own.
  const [three, alone] = fenderGroups(row([3.2, 0, 1.6, 5.2]));
  assert.deepEqual([three.x, three.half, three.axles.map(a => a.x), alone.x, alone.half], [1.6, 1.6, [0, 1.6, 3.2], 5.2, 0]);
  // A wheel of another row is not counted, and a group is as high and as large as the highest and largest of its wheels.
  const groups = fenderGroups([{ x: 0, y: .5, r: .5 }, { x: 1.6, y: .55, r: .55 }, { x: 3.6, y: .5, r: .5 }, { x: 2, y: -1, r: .3 }]);
  assert.deepEqual(groups.map(({ x, half, y, r, axles }) => [x, half, y, r, axles.length]), [[.8, .8, .55, .55, 2], [2, 0, -1, .3, 1], [3.6, 0, .5, .5, 1]]);
});

test('a fender is bent square over its wheel: level over the top, sloped at either end and straight down to its foot', () => {
  const near = (a, b, e = 1e-9) => Math.abs(a - b) < e, half = Math.tan(FENDER_SLOPE / 2), low = R => R * Math.tan((Math.PI / 2 - FENDER_SLOPE) / 2);
  assert(near(FENDER_SLOPE, Math.PI / 3), 'down at sixty degrees from the level');
  for (const R of [.5, .8]) for (const foot of [0, .2 * R, .5 * R]) for (const round of [0, .05, .15]) {
    const line = fenderLine(R, foot, round), what = `${R} ${foot} ${round}`;
    // From one foot to the other, the one the other turned about, both cut level where the fender ends.
    assert(near(line[0][1], foot) && near(line.at(-1)[1], foot), what);
    for (const [i, [u, v]] of line.entries()) assert(near(u, -line.at(-1 - i)[0]) && near(v, line.at(-1 - i)[1]), `${what}: the same at either end`);
    for (let i = 1; i < line.length; i++) assert(line[i][0] >= line[i - 1][0] - 1e-9, `${what}: it runs one way along`);
    // Nowhere nearer the axle than its line, nor further along from it: clear of a tyre within it, however round its
    // corners.
    assert(line.every(([u, v]) => Math.hypot(u, v) >= R - 1e-9 && Math.abs(u) <= R + 1e-9 && v <= R + 1e-9), what);
    // Level over the top, as far as its rounded corners leave it.
    const level = line.filter(([, v]) => near(v, R));
    assert(near(Math.max(...level.map(([u]) => u)), (R - round) * half), `${what}: level over the top`);
    // Its slope at sixty degrees, as high as `fenderHeight` has it and as far along as `fenderAcross`.
    const slope = line.slice(1).map((q, i) => [line[i], q]).filter(([p, q]) => p[0] > 0 && q[1] < p[1] - 1e-9 && q[0] > p[0] + 1e-9)
      .sort(([p, q], [s, t]) => Math.hypot(t[0] - s[0], t[1] - s[1]) - Math.hypot(q[0] - p[0], q[1] - p[1]))[0];
    assert(near(Math.atan2(slope[0][1] - slope[1][1], slope[1][0] - slope[0][0]), FENDER_SLOPE), `${what}: sloped at either end`);
    for (const [u, v] of slope) assert(near(fenderHeight(R, u), v) && near(fenderAcross(R, v), u), what);
    // Straight down at its side to a foot below the slope, as far as the round of the corner over it leaves it; a foot
    // higher up is cut across the slope.
    const side = line.filter(([u]) => near(u, R)), corner = Math.min(round * Math.tan((Math.PI / 2 - FENDER_SLOPE) / 2), low(R) - foot);
    if (foot < low(R)) assert(near(line.at(-1)[0], R) && near(Math.max(...side.map(([, v]) => v)), low(R) - corner), `${what}: straight down`);
    else assert(near(line.at(-1)[0], fenderAcross(R, foot)) && line.at(-1)[0] < R, `${what}: cut across the slope`);
  }
  // Over a group of wheels it is level from over one end axle to over the other, `half` either way of their middle: the
  // line over one wheel, its two ends drawn apart.
  for (const half of [.6, 1.7]) {
    const one = fenderLine(.8, .2, .05), over = fenderLine(.8, .2, .05, half);
    assert.equal(over.length, one.length);
    for (const [i, [u, v]] of over.entries()) assert(near(u, one[i][0] + Math.sign(one[i][0]) * half) && near(v, one[i][1]), `${half}`);
  }
  // Its foot may be cut at a height of its own at either end, back along x, then ahead.
  const cut = fenderLine(.8, [.2, .45], .05);
  assert(near(cut[0][0], -.8) && near(cut[0][1], .2) && near(cut.at(-1)[0], fenderAcross(.8, .45)) && near(cut.at(-1)[1], .45));
  // The band of a fender is a line round another, rounded about the same centres: as wide all the way round.
  const { inner, outer, band, round } = fenderOver(.5), inside = fenderLine(inner, .1, round);
  for (const [u, v] of fenderLine(outer, .1, round + band).filter(([, v]) => v > .1 + band)) {
    const nearest = Math.min(...inside.slice(1).map((q, i) => { const p = inside[i], dx = q[0] - p[0], dy = q[1] - p[1],
      t = Math.max(0, Math.min(1, ((u - p[0]) * dx + (v - p[1]) * dy) / (dx * dx + dy * dy))); return Math.hypot(u - p[0] - dx * t, v - p[1] - dy * t); }));
    assert(near(nearest, band, .002), `${u} ${v}: ${nearest} for ${band}`);
  }
});

test('the layout of a hull is the same every time, and so is its number, two figures of one to four', () => {
  assert.deepEqual(layouts(-1), layouts(-1));
  const texts = new Set();
  for (let i = 0; i < 64; i++) {
    const [, onTurret] = layouts(-1, 'outside', { seed: 'actor-' + i }), [number] = of(onTurret, 'number');
    assert.match(number.text, /^[1-4][1-4]$/); texts.add(number.text);
    assert.equal(number.flip, false);
  }
  assert(texts.size > 8, 'they differ from one vehicle to another');
  // The number keeps off the joints of the plates.
  for (const front of [-1, 1]) for (const layout of layouts(front)) for (const number of of(layout, 'number'))
    for (const { a, b } of layout.seams) {
      const box = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) };
      assert(Math.abs(number.x - box.x) >= (number.w + box.w) / 2 || Math.abs(number.y - box.y) >= (number.h + box.h) / 2);
    }
});

test('seen cut open, the far wall has its own fittings and none of the outside, and it stands over the same running gear', () => {
  const [onHull, onTurret] = layouts(-1, 'inside');
  assert.deepEqual(onHull.tracks, layouts(-1)[0].tracks);
  for (const layout of [onHull, onTurret]) {
    assert.equal(layout.seams.length, 0);
    for (const f of layout.fittings) assert(['lamp', 'conduit', 'junction', 'extinguisher'].includes(f.kind), f.kind);
  }
  assert.equal(of(onHull, 'extinguisher').length, 1); assert.equal(of(onTurret, 'extinguisher').length, 0);
  // The wheels a hull cut open stands over are told as from outside: the chassis hangs no mudguard over those whose axle
  // it stands over (`over`).
  assert.deepEqual(onCab('inside').arches, onCab('outside').arches);
});

test('the marks of a hull fall on the fittings they hit, in the frame of the fitting\'s picture, turned with it', () => {
  const mark = (x, y, angle = .3) => ({ x, y, angle, radius: .02, kind: 'dent' }),
    marks = [mark(2, .5), mark(2.15, .45), mark(2.21, .5), mark(3, .5)], at = { x: 2, y: .5, w: .4, h: .2 };
  const plain = fittingImpacts(marks, { ...at, flip: false }), turned = fittingImpacts(marks, { ...at, flip: true });
  assert.equal(plain.length, 3, 'the mark that is off it, but by its edge, is not on it');
  const near = (a, b) => Math.abs(a - b) < 1e-12;
  assert(near(plain[0].x, .2) && near(plain[0].y, .1));
  assert(near(plain[1].x, .35) && near(plain[1].y, .05) && near(plain[1].angle, .3));
  assert(near(turned[1].x, .05) && near(turned[1].y, .05) && near(turned[1].angle, Math.PI - .3));
  assert.equal(marks[1].x, 2.15, 'the marks of the hull are left as they are');
});

test('the bevel of a hull is mitred: the parts of two edges meet on the bisector of their corner, turning out or in', () => {
  const near = (a, b) => Math.abs(a - b) < 1e-9, dot = (p, q) => p.x * q.x + p.y * q.y,
    area = points => Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
  // A box with a sloped front, an L with a corner that turns in, and the same drawn the other way round.
  const box = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 1.2 }, { x: .6, y: 1.2 }, { x: 0, y: .7 }],
    ell = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3, y: 1 }, { x: 1.2, y: 1 }, { x: 1.2, y: 2 }, { x: 0, y: 2 }];
  for (const points of [box, ell, [...ell].reverse()]) {
    const edges = outlineEdges(points), band = mitredBand(edges, BEVEL);
    assert.equal(band.length, edges.length);
    for (const [i, [a, b, end, start]] of band.entries()) {
      const edge = edges[i], next = edges[(i + 1) % edges.length], before = edges[(i + edges.length - 1) % edges.length];
      assert(a === edge.a && b === edge.b);
      // Each part ends where the next begins: one fold line all round, with no gap and no overlap.
      assert.deepEqual(end, band[(i + 1) % band.length][3]);
      // Its inner corners lie BEVEL within its edge, and within the edges either side too: on the bisectors.
      for (const [corner, other] of [[start, before], [end, next]]) {
        assert(near(dot({ x: corner.x - edge.a.x, y: corner.y - edge.a.y }, edge.normal), -BEVEL), `${i}`);
        assert(near(dot({ x: corner.x - other.a.x, y: corner.y - other.a.y }, other.normal), -BEVEL), `${i}`);
      }
    }
    // The parts tile the band between the outline and the fold.
    const folds = band.map(quad => quad[3]);
    assert(near(band.reduce((sum, quad) => sum + area(quad), 0), area(points) - area(folds)));
  }
  // A corner sharper than the mitre allows is cut short, four depths from its point.
  const spike = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: .2 }], [first] = mitredBand(outlineEdges(spike), BEVEL);
  assert(near(Math.hypot(first[2].x - 3, first[2].y), 4 * BEVEL));
});

test('seen from outside, the skin of a room reaches the outer faces of its plates, but where another room stands against it', () => {
  const near = (points, expected) => points.length === expected.length && points.every((p, i) => Math.abs(p.x - expected[i][0]) < 1e-9 && Math.abs(p.y - expected[i][1]) < 1e-9),
    box = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], plate = (ax, ay, bx, by, mm) => ({ a: { x: ax, y: ay }, b: { x: bx, y: by }, half: mm / 2000 }),
    // A floor of 10 mm, a rear of 40, a roof of 20 and a front of 30, the floor a millimetre off where the world has it now.
    plates = [plate(0, .001, 4, .001, 10), plate(4, 0, 4, 2, 40), plate(4, 2, 0, 2, 20), plate(0, 2, 0, 0, 30)];
  assert(near(outerFace(box, plates), [[-.015, -.005], [4.02, -.005], [4.02, 2.01], [-.015, 2.01]]));
  // A turret on its roof: the roof stays at the middle of its plate, where the skin of the turret meets it.
  assert(near(outerFace(box, plates, [[{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 3 }, { x: 1, y: 3 }]]), [[-.015, -.005], [4.02, -.005], [4.02, 2], [-.015, 2]]));
  // No plate along the front, and none at all.
  assert(near(outerFace(box, plates.slice(0, 3)), [[0, -.005], [4.02, -.005], [4.02, 2.01], [0, 2.01]]));
  assert.equal(outerFace(box, []), box);
  // A sloped front is moved out square to itself; a sharp corner is cut short.
  const wedge = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 0, y: .3 }], [corner, sharp] = outerFace(wedge, [plate(0, 0, 3, 0, 20), plate(3, 0, 0, .3, 20), plate(0, .3, 0, 0, 20)]);
  assert(Math.abs(corner.x + .01) < 1e-9 && Math.abs(corner.y + .01) < 1e-9);
  assert(Math.hypot(sharp.x - 3, sharp.y) <= 4 * .01 + 1e-9);
});

// How far a point is out of an outline: none within it.
const outOf = (point, polygon) => within(point, polygon) ? 0 : Math.min(...polygon.map((a, i) => {
  const b = polygon[(i + 1) % polygon.length], dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(a.x + dx * t - point.x, a.y + dy * t - point.y);
}));
// The outline as the field has it, to a tenth of a millimetre: its plates in one line are then nearly so.
const rounded = polygon => polygon.map(p => ({ x: Math.round(p.x * 1e4) / 1e4, y: Math.round(p.y * 1e4) / 1e4 }));

test('seen from outside, the skin steps square where plates of unlike thickness end in one line, and covers a vision block', () => {
  const plate = (a, b, mm) => ({ a, b, half: mm / 2000 });
  for (const front of [-1, 1]) {
    // Armoured glass 230 mm thick ending the 60 mm steel of a sloped front in one line, down to a floor of 20 mm.
    const flip = p => front < 0 ? p : { x: 24 - p.x, y: p.y },
      [floorFront, floorRear, rearTop, frontTop, glassTop] = [{ x: 10, y: 0 }, { x: 15.2, y: 0 }, { x: 15.18, y: .9 }, { x: 10.6, y: .9 }, { x: 10.16173467, y: .242602005 }].map(flip),
      hull = front < 0 ? [floorFront, floorRear, rearTop, frontTop, glassTop] : [glassTop, frontTop, rearTop, floorRear, floorFront],
      plates = [plate(floorFront, floorRear, 20), plate(floorRear, rearTop, 25), plate(rearTop, frontTop, 18), plate(frontTop, glassTop, 60), plate(glassTop, floorFront, 230)],
      length = Math.hypot(glassTop.x - frontTop.x, glassTop.y - frontTop.y),
      out = { x: (glassTop.y - frontTop.y) / length * -front, y: -(glassTop.x - frontTop.x) / length * -front };
    assert(out.x * front > 0 && out.y > 0, 'out of the front');
    for (const outline of [hull, rounded(hull)]) {
      const face = outerFace(outline, plates), what = `facing ${front}, ${outline === hull ? 'as built' : 'as the field has it'}`;
      // Where the steel ends, its face steps out to that of the glass, square to them.
      for (const half of [.03, .115]) assert(face.some(p => Math.hypot(p.x - glassTop.x - out.x * half, p.y - glassTop.y - out.y * half) < 2e-4), `${what}: ${half}`);
      // All of the glass is under the skin, and nothing of the skin hangs under the floor.
      for (const end of [glassTop, floorFront]) assert(outOf({ x: end.x + out.x * .115, y: end.y + out.y * .115 }, face) < 1e-4, what);
      assert(Math.min(...face.map(p => p.y)) > -.01 - 1e-9, `${what}: under the floor`);
    }
  }
  // Cover all four corners of every model's vision block. The glass may end between steel plates or meet the roof;
  // the number of protruding corners depends on that geometry, not on the model's name.
  for (const { id } of CONSTRUCTION_TEMPLATES) {
    const blueprint = compileBlueprint(createConstruction(id)), glass = blueprint.plates.find(p => p.id === 'hull:vision');
    if (!glass) continue;
    const outlines = bodyPanelSurfaces(designFrame(blueprint)).map(surface => surface.artPolygon),
      hull = outlines.find(points => outOf(glass, points) < 1e-4), rooms = outlines.filter(points => points !== hull),
      plates = blueprint.plates.filter(p => !p.chassis).map(({ x, y, angle, length, thicknessMm }) => {
        const c = Math.cos(angle), s = Math.sin(angle);
        return { a: { x: x - c * length / 2, y: y - s * length / 2 }, b: { x: x + c * length / 2, y: y + s * length / 2 }, half: thicknessMm / 2000 };
      }),
      c = Math.cos(glass.angle), s = Math.sin(glass.angle), half = glass.thicknessMm / 2000,
      faces = [-1, 1].flatMap(end => [-1, 1].map(side => ({ x: glass.x + c * glass.length / 2 * end - s * half * side, y: glass.y + s * glass.length / 2 * end + c * half * side })));
    assert(hull, `${id}: a real skin borders the vision block`);
    for (const outline of [hull, rounded(hull)]) {
      const face = outerFace(outline, plates, rooms);
      for (const corner of faces) assert(outOf(corner, face) < 1e-4, `${id}: the glass under the skin`);
    }
  }
});

test('a door, a hatch or a cover is cut into the skin: no weld of its plates runs across it', () => {
  const cut = new Set(['cab-door', 'armour-door', 'industrial-door', 'access-hatch', 'service-panel', 'hatch']);
  for (const id of ['truck', 'tracked', 'scout', 'construction-truck', 'howitzer']) {
    const b = compileBlueprint(createConstruction(id));
    let doors = 0, welds = 0;
    for (const skin of bodyPanelSurfaces(designFrame(b), b.bodyPanels)) {
      const layout = hullLayout(skin.artPolygon, { ...skin.fittings(), side: 'outside' }),
        boxes = [...layout.details.map(d => { const c = Math.abs(Math.cos(d.angle || 0)), s = Math.abs(Math.sin(d.angle || 0));
          return { kind: d.kind, x: d.x, y: d.y, w: c * d.width + s * d.height, h: s * d.width + c * d.height }; }), ...layout.fittings].filter(box => cut.has(box.kind));
      doors += boxes.length; welds += layout.seams.length;
      for (const box of boxes) for (const { a, b: z } of layout.seams) for (let i = 0; i <= 40; i++) {
        const x = a.x + (z.x - a.x) * i / 40, y = a.y + (z.y - a.y) * i / 40;
        assert(Math.abs(x - box.x) >= box.w / 2 - 1e-3 || Math.abs(y - box.y) >= box.h / 2 - 1e-3, `${id}: a weld across its ${box.kind}`);
      }
    }
    assert(doors > 0 && welds > 0, id);
  }
});
