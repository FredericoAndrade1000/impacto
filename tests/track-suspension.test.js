import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { componentPolygon } from '../src/assembly.ts';
import { Terrain } from '../src/terrain.ts';
import { terrainShadow, contactShadow, CONTACT_FADE, SPRING_REST, TRACK_SHOE_HALF_THICKNESS, builtGear, holdTrackShape, trackGear, trackOutline,
  trackWheels } from '../src/running-gear.ts';
import { mechanicalState } from '../scripts/probes-mobility.ts';
import { weaponSettings } from '../src/weapons.ts';
import { ownerState, physics, managedWorld, advance } from './mechanical-queries.js';
import { blueprintMass } from '../src/mass-properties.ts';
import { withChassisGearScale } from '../src/chassis-editing.ts';

const managed = (t, terrain = 'flat') => {
  const b = createConstruction('heavy'); b.terrain = terrain;
  return managedWorld(t, b);
};

test('a single carrier conserves construction mass and settles with bounded logical suspension', t => {
  const world = managed(t), track = world.modules.find(m => m.kind === 'track'), native = ownerState(world, track);
  assert(native.state.dynamic); assert.equal(physics(world).bodies, 1);
  assert(Math.abs(mechanicalState(world).mass - blueprintMass(world.blueprint)) < .01);
  advance(world, 120);
  assert(track.suspension.travel > 0);
  assert(track.suspension.compression >= 0 && track.suspension.compression <= track.suspension.travel);
  const y = world.vehicle.y, displacement = track.suspension.displacement;
  advance(world, 240);
  assert(Math.abs(world.vehicle.y - y) < .002, 'idle support does not ratchet the chassis');
  assert(Math.abs(track.suspension.displacement - displacement) < .002);
  assert.equal(world.dynamics.recoveries || 0, 0);
  assert(world.plates.every(p => p.integrity === 1 && p.attached !== false));
});

test('rough terrain preserves the admitted contact contours and bounded logical suspension', t => {
  const world = managed(t, 'rough'), track = world.modules.find(m => m.kind === 'track');
  world.game();
  const reference = structuredClone(world.actor().contactContours), original = JSON.stringify(world.blueprint);
  assert(reference.length > 0 && reference.every(contour => contour.length >= 3));
  advance(world, 60); world.controlVehicle(1);
  let worstPenetration = 0;
  for (let i = 0; i < 9 * 60; i++) {
    world.step(); world.drainEvents();
    const d = track.suspension.displacement, travel = track.suspension.travel;
    assert(d >= -travel * .45 - .003 && d <= travel + .003);
    const v = world.vehicle, c = Math.cos(v.angle), s = Math.sin(v.angle);
    for (const contour of reference) for (const p of contour) {
      const x = v.x + c * p.x - s * p.y, y = v.y + s * p.x + c * p.y;
      worstPenetration = Math.max(worstPenetration, world.terrain.height(x) - y);
    }
  }
  assert(world.vehicle.x > 43, 'the running gear actually traverses the terrain');
  assert(worstPenetration < .015, `body contact penetration ${worstPenetration}`);
  assert.deepEqual(world.actor().contactContours, reference);
  assert.equal(world.dynamics.recoveries || 0, 0);
  assert(world.plates.every(p => p.integrity === 1 && p.attached !== false));
  assert.equal(JSON.stringify(world.blueprint), original);
});

test('a local shot damages the installed bogie while preserving its rigid ground support', t => {
  const world = managed(t), track = world.modules.find(m => m.kind === 'track');
  advance(world, 60);
  const before = ownerState(world, track), contours = structuredClone(world.actor().contactContours);
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  // Into the front of the track, past under the sloped nose that closes the tub of the chassis ahead.
  world.fire({ x: 9.5, y: track.y - .1 }, weaponSettings('autocannon', { preset: 'm242', ammo: 'ap', spread: 0 }), true);
  advance(world, 120);
  assert(track.health < track.maxHealth && track.attached !== false);
  assert.equal(ownerState(world, track).body, before.body);
  assert.equal(ownerState(world, track).state.mass, before.state.mass);
  assert.deepEqual(world.actor().contactContours, contours);
  assert(world.vehicle.y < 1.6 && Math.hypot(world.vehicle.vx, world.vehicle.vy) < 1);
  assert(world.plates.every(p => p.integrity > .99 && p.attached !== false));
  assert.equal(world.stats.explosions, 0);
});

test('contact shadows follow slopes and fade independently beneath airborne track sections', () => {
  const terrain = new Terrain('rough'), track = { kind: 'track', width: 5.04, height: .74,
    x: 22, y: terrain.height(22) + .55, angle: .25 };
  const polygons = componentPolygon(track), grounded = terrainShadow(polygons, terrain),
    airborne = terrainShadow(polygons.map(p => ({ x: p.x, y: p.y + 3 })), terrain);
  assert(grounded.length > 10);
  assert(grounded.some(p => Math.abs(p.topLeft - p.topRight) > .002));
  for (const p of grounded) {
    assert.equal(p.topLeft, terrain.height(p.left) + .003);
    assert.equal(p.topRight, terrain.height(p.right) + .003);
  }
  assert.equal(airborne.length, 0, 'a floating track does not leave a dark detached ellipse');
});

test('a wheel and a track leave a short shadow where they bear on the ground, following it, and none where they are lifted', () => {
  const terrain = new Terrain('rough'), deep = .05, lift = .01, step = .1;
  const track = { kind: 'track', width: 5.04, height: .74, x: 22, y: terrain.height(22) + .37, angle: Math.atan(terrain.surface(22).slope) },
    shadow = contactShadow(componentPolygon(track), terrain, null, step, deep, lift);
  assert(shadow.length > 10, 'the run of a track on the ground is shaded along it');
  assert(shadow.some(p => Math.abs(p.topLeft - p.topRight) > .002), 'the shadow lies along the slope');
  for (const p of shadow) {
    // On the ground line, raised by no more than `lift` where it is deepest, and never deeper than that over it.
    for (const [x, top, depth] of [[p.left, p.topLeft, p.depthLeft], [p.right, p.topRight, p.depthRight]]) {
      const over = top - terrain.height(x);
      assert(over >= .003 - 1e-12 && over <= .003 + lift + 1e-12); assert(depth <= deep + over + 1e-12);
    }
  }
  // Cut at places of the ground itself: only its two ends move with the track.
  const inner = shadow.slice(1).map(p => p.left);
  for (const x of inner) assert(Math.abs(x / step - Math.round(x / step)) < 1e-6);
  const wheel = { kind: 'wheel', width: 1.1, height: 1.1, x: 40, y: terrain.height(40) + .55, angle: 0 },
    under = contactShadow(componentPolygon(wheel), terrain, null, .05, deep, lift),
    middle = (under[0].left + under.at(-1).right) / 2;
  assert(under.at(-1).right - under[0].left < wheel.width, 'under a tyre it is shorter than the tyre');
  assert(Math.abs(middle - wheel.x) < .2, 'and under where the tyre touches');
  const lifted = contactShadow(componentPolygon({ ...wheel, y: wheel.y + CONTACT_FADE * 4 }), terrain, null, .05, deep, lift);
  assert.equal(lifted.length, 0, 'a wheel off the ground casts none');
});

test('shadow clearance follows a sloping concave underside near the origin and 125 km away', () => {
  const deep = .06;
  for (const origin of [0, 125000.375]) {
    const terrain = { height: x => 48 + .25 * (x - origin) },
      polygon = [[0, .04], [1, .04], [1, .08], [2, .08], [2, .04], [3, .04], [3, .5], [0, .5]]
        .map(([x, gap]) => ({ x: origin + x, y: 48 + .25 * x + gap })),
      ground = terrainShadow(polygon, terrain, .28, null, .25),
      contact = contactShadow(polygon, terrain, null, .25, deep);
    assert(ground.length > 5 && contact.length > 5);
    for (const [patches, touching] of [[ground, false], [contact, true]]) for (const patch of patches) {
      for (const [x, top, depth] of [[patch.left, patch.topLeft, patch.depthLeft], [patch.right, patch.topRight, patch.depthRight]]) {
        const local = x - origin, gap = local > 1 && local < 2 ? .08 : .04,
          expected = touching ? deep * Math.exp(-gap / CONTACT_FADE) + .003 :
            (.034 + gap * .03) * Math.exp(-gap * 2.5) * Math.sin(Math.PI * local / 3) ** .4;
        assert(Math.abs(top - terrain.height(x) - .003) < 1e-10);
        assert(Math.abs(depth - expected) < 1e-10, 'the recessed middle uses its own lower face, not a convex envelope');
      }
    }
  }
});

test('separate shadow contours leave the empty interval unshaded and retain both boundary contacts', () => {
  const rings = [[0, 1, .02], [2, 3, .04]].map(([left, right, gap]) =>
    [{ x: left, y: gap }, { x: right, y: gap }, { x: right, y: .5 }, { x: left, y: .5 }]),
    polygon = rings.flat(), edges = rings.flatMap(ring => ring.map((p, i) => [p, ring[(i + 1) % ring.length]])),
    terrain = { height: () => 0 }, deep = .06,
    contact = contactShadow(polygon, terrain, edges, .25, deep), ground = terrainShadow(polygon, terrain, .28, edges, .25);
  for (const patches of [contact, ground]) {
    assert(patches.some(p => p.right === 1) && patches.some(p => p.left === 2));
    assert(!patches.some(p => p.left >= 1.25 && p.right <= 1.75), 'no edge bridges the two independent contours');
  }
  const left = contact.find(p => p.right === 1), right = contact.find(p => p.left === 2);
  assert(Math.abs(left.depthRight - (deep * Math.exp(-.02 / CONTACT_FADE) + .003)) < 1e-12);
  assert(Math.abs(right.depthLeft - (deep * Math.exp(-.04 / CONTACT_FADE) + .003)) < 1e-12);
});

test('vertical shadow edges keep their endpoint rule and inclusive tolerance at near and distant cuts', () => {
  const terrain = { height: () => 0 }, deep = .06;
  for (const origin of [0, 125000]) for (const offset of [-1e-8, 0, 1e-8, 3e-8])
    for (const dx of [0, 5e-9]) for (const reversed of [false, true]) {
      const polygon = [{ x: origin - .5, y: 0 }, { x: origin + .5, y: .5 }],
        edge = [{ x: origin + offset, y: .07 }, { x: origin + offset + dx, y: 0 }];
      if (reversed) edge.reverse();
      const ground = terrainShadow(polygon, terrain, .28, [edge], .25),
        contact = contactShadow(polygon, terrain, [edge], .25, deep);
      if (offset === 3e-8) {
        assert.deepEqual(ground, []); assert.deepEqual(contact, []);
        continue;
      }
      const groundAt = ground.find(p => p.right === origin), contactAt = contact.find(p => p.right === origin),
        gap = reversed ? 0 : .07, expected = (.034 + gap * .03) * Math.exp(-gap * 2.5);
      assert(groundAt && contactAt, 'a cut at the expanded edge boundary remains included');
      assert(Math.abs(groundAt.depthRight - expected) < 1e-12, 'terrain shadow uses the first vertical endpoint');
      assert.equal(contactAt.depthRight, deep + .003, 'contact shadow uses the lower vertical endpoint');
    }
});

test('road-wheel details articulate inside the real casing while the sprocket and the idler stay raised where the hull holds them', () => {
  const terrain = new Terrain('rough'), track = { kind: 'track', width: 5.04, height: .74,
    x: 23, y: terrain.height(23) + .37, angle: Math.atan(terrain.surface(23).slope) };
  const gear = trackGear(track, terrain), { end, low } = trackWheels(track.width, track.height), road = gear.road;
  assert.deepEqual([...new Set(gear.drawn.map(w => w.role))], ['roller', 'sprocket', 'idler', 'road']);
  // The two at the ends one road wheel further on, over the middle of the track: the belt runs up to them.
  assert.deepEqual([gear.sprocket.x, gear.sprocket.y, gear.idler.x, gear.idler.y], [-end.x, end.y, end.x, end.y]);
  assert(end.y > 0 && Math.abs(end.x - road.at(-1).x - (road[1].x - road[0].x)) < 1e-9);
  assert(road.some(w => Math.abs(w.y - low) > .005));
  for (const w of gear.drawn) assert(Math.abs(w.y) + w.radius < track.height / 2);
  assert(road.some(w => Math.abs(w.y - road[0].y) > .004));
  // Lifted clear of flat ground, its road wheels drop towards it, and no further than keeps them inside the casing.
  const lifted = trackGear({ ...track, x: 0, y: .57, angle: 0 }, { surface: x => ({ x, y: 0, nx: 0, ny: 1 }) });
  assert(lifted.road.every(w => w.y < low));
  for (const w of lifted.drawn) assert(Math.abs(w.y) + w.radius < track.height / 2);
});

test('the belt goes round every wheel where it is drawn: under each road wheel as its arm has it, never through one', () => {
  const terrain = new Terrain('rough');
  for (const [width, height] of [[5.04, .74], [2.28, .78], [9.4, 1.17]]) for (let x = 20; x < 120; x += 7.3) {
    const gear = trackGear({ width, height, x, y: terrain.height(x) + height / 2, angle: Math.atan(terrain.surface(x).slope) }, terrain),
      belt = gear.belt, samples = belt.sample(4000, 0, belt.length / 4000, new Float64Array(16000)), what = `${width}x${height} at ${x}`;
    // Pressed up over a bump or let down into a hollow: somewhere.
    if (x === 20) assert(gear.road.some(w => Math.abs(w.y - gear.road[0].y) > .01), what);
    for (const wheel of [...gear.road, gear.sprocket, gear.idler]) {
      let nearest = Infinity, under = null;
      for (let i = 0; i < samples.length; i += 4) {
        const d = Math.hypot(samples[i] - wheel.x, samples[i + 1] - wheel.y);
        if (d < nearest) { nearest = d; under = samples[i + 1]; }
      }
      // Round each, the line of the pins of the links as far out as the belt has it, and no further but by the
      // corner it turns under a road wheel pressed up over its neighbours.
      assert(nearest > gear.pin - 1e-6 && nearest < gear.pin + 2e-3, `${what}: the belt on the wheel at ${wheel.x}`);
      if (gear.road.includes(wheel)) assert(under < wheel.y, `${what}: under it`);
    }
  }
});

test('the hull holds the sprocket, the idler, the rollers and the upper run over them as the track rides up and down under it', () => {
  const width = 5.04, height = .74, flat = { surface: x => ({ x, y: -height / 2, nx: 0, ny: 1 }) }, track = { x: 0, y: 0, angle: 0, width, height },
    built = builtGear(width, height), { end, low, radius } = trackWheels(width, height), shoe = TRACK_SHOE_HALF_THICKNESS * height;
  // Each roller under the upper run, the inside of its links on it, over the gap between two road wheels.
  assert(built.rollers.length >= 2);
  for (const roller of built.rollers) {
    assert(Math.abs(roller.y + roller.radius - (end.y + built.pin - shoe)) < 1e-12);
    assert(built.road.some((wheel, i) => i + 1 < built.road.length && wheel.x < roller.x && roller.x < built.road[i + 1].x));
  }
  // Pressed 0.12 m up its springs under the hull and turned on them, as the core carries it: what the hull holds stays
  // where it was built, the road wheels stand where the ground has them.
  const hold = { x: .002, y: -.12, angle: .017 }, c = Math.cos(hold.angle), s = Math.sin(hold.angle),
    held = p => ({ x: hold.x + c * p.x - s * p.y, y: hold.y + s * p.x + c * p.y }), pressed = trackGear(track, flat, hold),
    close = (a, b) => Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12;
  for (const role of ['sprocket', 'idler']) assert(close(pressed[role], held(built[role])), role);
  pressed.rollers.forEach((roller, i) => assert(close(roller, held(built.rollers[i]))));
  assert.deepEqual(pressed.road.map(w => [w.x, w.y]), built.road.map(w => [w.x, w.y]));
  // The outline of the track the same: its lower run where the track is, its upper run where the hull holds it.
  const outline = trackOutline(width, height).flatMap(p => [p.x, p.y]), shape = holdTrackShape(outline, new Float64Array(outline.length), width, height, hold);
  for (let i = 0; i < outline.length; i += 2) {
    const p = { x: outline[i], y: outline[i + 1] }, at = { x: shape[i], y: shape[i + 1] };
    if (p.y < low - radius / 2) assert(close(at, p), 'the lower run');
    if (p.y > end.y + radius / 2) assert(close(at, held(p)), 'the upper run');
  }
  assert(holdTrackShape(outline, new Float64Array(outline.length), width, height, null).every((v, i) => v === outline[i]));
});

test('a rock presses a road wheel up no further than the stop of its spring over where the hull holds the track as built', () => {
  const width = 5.04, height = .74, { low, road, end } = trackWheels(width, height), travel = end.y - low, stop = travel * (1 - SPRING_REST),
    stroke = .06, rock = { surface: x => ({ x, y: -height / 2 + (Math.abs(x - road[0]) < .2 ? .2 : 0), nx: 0, ny: 1 }) },
    track = { x: 0, y: 0, angle: 0, width, height, suspension: { travel } },
    // How high a wheel stands in the frame the track was built in, as the hull holds that (running-gear.ts `held`).
    built = (hold, w) => -Math.sin(hold.angle) * (w.x - hold.x) + Math.cos(hold.angle) * (w.y - hold.y);
  // Pressed up its springs and turned on them, short of its stop: the wheel over the rock at the stop.
  for (const hold of [{ x: 0, y: -.1, angle: 0 }, { x: .003, y: -.09, angle: .02 }]) {
    const wheel = trackGear(track, rock, hold).road[0];
    assert(Math.abs(built(hold, wheel) - (low + stop)) < 1e-9 && wheel.y > low && wheel.y < low + stroke);
  }
  // With room to spare on its spring, or with no hull to hold the track or no springs, as far as its stroke.
  for (const [piece, hold] of [[track, { x: 0, y: -.02, angle: .005 }], [track, null], [{ ...track, suspension: undefined }, { x: 0, y: -.1, angle: 0 }]])
    assert.equal(trackGear(piece, rock, hold).road[0].y, low + stroke);
  // At its stop or past it already, where the core has the track: no higher than the track stands, and no lower.
  assert.equal(trackGear(track, rock, { x: 0, y: -.15, angle: 0 }).road[0].y, low);
});

test('pressed up its springs till its road wheels stand level with its sprocket or over it, the belt still goes round its ends outside', () => {
  // Signed twice the area within an outline (x and y one after another), and whether two of its sides cross.
  const area = o => { let a = 0; for (let i = 0; i < o.length; i += 2) { const j = (i + 2) % o.length; a += o[i] * o[j + 1] - o[j] * o[i + 1]; } return a; },
    side = (o, i) => { const n = o.length / 2, j = (i + 1) % n; return [o[i * 2], o[i * 2 + 1], o[j * 2], o[j * 2 + 1]]; },
    cross = ([ax, ay, bx, by], [cx, cy, dx, dy]) => {
      const turn = (px, py, qx, qy, rx, ry) => Math.sign((qx - px) * (ry - py) - (qy - py) * (rx - px));
      return turn(ax, ay, bx, by, cx, cy) * turn(ax, ay, bx, by, dx, dy) < 0 && turn(cx, cy, dx, dy, ax, ay) * turn(cx, cy, dx, dy, bx, by) < 0;
    };
  // As the field had a track of 0.5 m when it landed from a jump, its sprocket under its road wheels, and the smallest
  // track pressed up its whole stop and turned on its springs over rocks under every other road wheel.
  for (const [width, height, hold, rocks] of [[6.8, .5, { x: .0026, y: -.1345, angle: .0195 }, false], [3, .39, { x: 0, y: -.133, angle: -.03 }, true]]) {
    const ground = { surface: x => ({ x, y: -height / 2 + (rocks && Math.sin(x * 9) > 0 ? .1 : 0), nx: 0, ny: 1 }) },
      gear = trackGear({ x: 0, y: 0, angle: 0, width, height }, ground, hold), what = `${width}x${height}`;
    assert(gear.road.some(w => w.y > gear.sprocket.y), `${what}: a road wheel over the sprocket`);
    const outline = gear.belt.outline(), n = outline.length / 2, length = gear.belt.length / builtGear(width, height).belt.length;
    assert(area(outline) > 0, `${what}: the belt inside out`);
    assert(Math.abs(length - 1) < .02, `${what}: the belt ${length} of its length as built`);
    for (let i = 0; i < n; i++) for (let j = i + 2; j < n; j++)
      if ((j + 1) % n !== i) assert(!cross(side(outline, i), side(outline, j)), `${what}: the belt crosses itself`);
  }
});

test('a small track and the largest, driven over rocks, travel on their springs as far as their road wheels stand under their ends and stand no higher than the stop at the outermost of them, their belts round them as built', t => {
  // The ore truck on a track of 0.47 m, and the stock tracked chassis on the largest, of 1.17 m.
  for (const source of [withChassisGearScale(createConstruction('mining-truck'), .6), withChassisGearScale(createConstruction('tracked'), 1.5)]) {
    source.terrain = 'rough';
    const world = managedWorld(t, source, { visualEvents: false }), track = world.modules.find(m => m.kind === 'track'),
      { width, height } = track, { low, end, road } = trackWheels(width, height), last = road.at(-1), what = `${height.toFixed(2)} m`,
      travel = track.suspension.travel, stop = travel * (1 - SPRING_REST), built = builtGear(width, height).belt.length;
    assert(Math.abs(travel - (end.y - low)) < 1e-12, `${what}: travel ${travel}`);
    advance(world, 60); world.controlVehicle(-1);
    let highest = -Infinity;
    for (let i = 0; i < 1200; i++) {
      advance(world, 1, { drain: true });
      const { displacement: d, tilt } = track.suspension, mirror = track.mirrored ? -1 : 1,
        ends = Math.max(d + last * tilt, d - last * tilt);
      assert(ends <= stop + 1e-9, `${what}: ${ends} over the stop ${stop}`);
      highest = Math.max(highest, ends);
      // As a page draws it, the hull holding the track where it was built (chassis-art.ts `heldTrack`): its road wheels
      // under its idler and its sprocket, its belt as long as built.
      const gear = trackGear(track, world.terrain, { x: -mirror * d * Math.sin(tilt), y: -d * Math.cos(tilt), angle: -mirror * tilt }),
        ratio = gear.belt.length / built;
      assert(gear.road.every(w => w.y < Math.min(gear.sprocket.y, gear.idler.y)), `${what}: a road wheel up level with an end`);
      assert(Math.abs(ratio - 1) < .01, `${what}: the belt ${ratio} of its length as built`);
    }
    // The rocks press it to its stop, which the core has where a page has it (`SPRING_REST`).
    assert(Math.abs(highest - stop) < 1e-9, `${what}: pressed to ${highest} of its stop ${stop}`);
  }
});
