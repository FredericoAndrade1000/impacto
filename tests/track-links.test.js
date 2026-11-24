import test from 'node:test';
import assert from 'node:assert/strict';
import { Texture } from 'pixi.js';
import { DIRT_TURN, TRACK_DIRT, TrackLinks, TrackShade, drawTrackFrame, trackDirt, trackDirtTexture, trackLinkTexture } from '../src/track-links.ts';
import { GROUND_SURFACES } from '../src/ground-impact.ts';
import { TRACK_GROUSER, TRACK_HORN, TRACK_PIN, TRACK_SHOE_HALF_THICKNESS, builtGear, linkStart, trackGear, trackLinks, trackWheels } from '../src/running-gear.ts';
import { TRACK_GROUSER_WIDTH, TRACK_HORN_WIDTH, TRACK_JOINT, idlerCrank } from '../src/track-shoe-art.ts';
import { paintGear } from '../src/gear-art.ts';
import { Terrain } from '../src/terrain.ts';
import { metalOf } from '../src/materials.ts';
import { GraphicsRecorder, countingCanvas } from './scenery-canvas.js';

const TAU = 2 * Math.PI;
// Gears of tracks of several sizes: as built, and where rough ground presses their road wheels up and lets them down,
// as the hull holds them pressed down and turned on their springs, and let up and turned the other way; and pressed so
// far up their springs that their road wheels stand level with the sprocket or over it (`pressedGears`); as the field
// draws them, their upper runs sagging as their belts are slack.
function gears() {
  const terrain = new Terrain('rough'), out = [];
  for (const [width, height] of [[3, 1], [5.04, .74], [8, 1.2], [2.2, .39], [12, 1.17]]) {
    out.push({ width, height, gear: builtGear(width, height) });
    for (const [x, hold] of [[23, null], [41, { x: .01 * height, y: -.1 * height, angle: .03 }], [77, { x: -.02 * height, y: .06 * height, angle: -.04 }]])
      out.push({ width, height, gear: trackGear({ x, y: terrain.height(x) + height / 2, angle: Math.atan(terrain.surface(x).slope), width, height }, terrain, hold, null, 0) });
  }
  return [...out, ...pressedGears()];
}
// Tracks a chassis hangs small (gearScale under 1), as the field had one 6.8 m long and 0.5 m high when its belt turned
// inside out: its hull holding it pressed up its springs past its stop and turned on them as it landed from a jump, and
// pressed up over rocks, one under the road wheel by its sprocket; and the smallest track there is, pressed up its whole
// stop over rocks under every other road wheel.
function pressedGears() {
  const rocks = (height, under) => ({ surface: x => ({ x, y: -height / 2 + (under(x) ? .1 : 0), nx: 0, ny: 1 }) }), out = [];
  for (const [width, height, hold, under] of [[6.8, .5, { x: .0026, y: -.1345, angle: .0195 }, () => false],
    [6.8, .5, { x: .0016, y: -.0838, angle: .0191 }, x => Math.abs(x + 3) < .15],
    [3, .39, { x: 0, y: -.133, angle: -.03 }, x => Math.sin(x * 9) > 0]])
    out.push({ width, height, gear: trackGear({ x: 0, y: 0, angle: 0, width, height }, rocks(height, under), hold, null, 0) });
  return out;
}
// The links round a gear, their sprocket turned `turn`, their horns and grousers drawn or not (`fine`).
function linksOn({ width, height, gear }, turn, texture = Texture.WHITE, fine = true) {
  const mesh = new TrackLinks(texture), { count, teeth } = trackLinks(width, height);
  mesh.configure(width, height); mesh.update(linkStart(gear, count, teeth, turn), gear.belt, fine);
  return mesh;
}
// The corners of the horn (0), the body (1) and the grouser (2) of link i, and of the joint over its pin (3), in order round each.
function face(mesh, part, i) {
  const { count } = mesh, positions = mesh.geometry.positions, first = part < 3 ? (part * count + i) * 4 : count * 12 + i * 6;
  return Array.from({ length: part < 3 ? 4 : 6 }, (_, k) => ({ x: positions[(first + k) * 2], y: positions[(first + k) * 2 + 1] }));
}
const near = (a, b, within = 1e-6) => Math.hypot(a.x - b.x, a.y - b.y) < within;
const pinOf = (mesh, i) => ({ x: mesh.places[i % mesh.count * 4], y: mesh.places[i % mesh.count * 4 + 1] });
// How far out of a convex polygon a point is, by the edge it is furthest beyond (less than nothing within it).
function beyond(p, polygon) {
  let area = 0, worst = -Infinity;
  for (let k = 0; k < polygon.length; k++) { const a = polygon[k], b = polygon[(k + 1) % polygon.length]; area += a.x * b.y - a.y * b.x; }
  for (let k = 0; k < polygon.length; k++) {
    const a = polygon[k], b = polygon[(k + 1) % polygon.length], length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > 1e-9) worst = Math.max(worst, -Math.sign(area) * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)) / length);
  }
  return worst;
}
// Whether a point is within a polygon (x and y one after another), or on its edge to `slack`.
function inside(p, flat, slack) {
  let odd = false;
  for (let i = 0, n = flat.length / 2; i < n; i++) {
    const a = { x: flat[i * 2], y: flat[i * 2 + 1] }, b = { x: flat[(i + 1) % n * 2], y: flat[(i + 1) % n * 2 + 1] };
    if (onSegment(p, a, b, slack)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) odd = !odd;
  }
  return odd;
}
function onSegment(p, a, b, slack) {
  const dx = b.x - a.x, dy = b.y - a.y, t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy) <= slack;
}

test('each link runs straight from the pin behind it to the one ahead, its horn in and its grouser out from its middle, the joint over the pin between them, all in the frame of the track', () => {
  for (const track of gears()) for (const turn of [0, .23, -7.9]) {
    const mesh = linksOn(track, turn), { width, height } = track, { count } = mesh, step = mesh.belt.length / count,
      half = TRACK_SHOE_HALF_THICKNESS * height, horn = TRACK_HORN * height, grouser = TRACK_GROUSER * height;
    try {
      for (let i = 0; i < count; i++) {
        const behind = pinOf(mesh, i + 1), ahead = pinOf(mesh, i), middle = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }),
          length = Math.hypot(ahead.x - behind.x, ahead.y - behind.y), inward = { x: -(ahead.y - behind.y) / length, y: (ahead.x - behind.x) / length },
          from = (out, p = middle(behind, ahead)) => ({ x: p.x + inward.x * out, y: p.y + inward.y * out }), wide = quad => Math.hypot(quad[3].x - quad[0].x, quad[3].y - quad[0].y);
        // The body as thick as the shoe from pin to pin.
        const body = face(mesh, 1, i);
        assert(near(middle(body[0], body[1]), behind) && near(middle(body[2], body[3]), ahead), `${width}x${height}: a link off its pins`);
        assert(Math.abs(Math.hypot(body[0].x - body[1].x, body[0].y - body[1].y) - 2 * half) < 1e-6);
        // The horn from the inside of the body in to its tip, the grouser from its outside out to its tip, each in the
        // middle of the link and as wide along it as it is told.
        const [h, g] = [face(mesh, 0, i), face(mesh, 2, i)];
        assert(near(middle(h[1], h[2]), from(half)) && near(middle(h[0], h[3]), from(half + horn)), `${width}x${height}: a horn off its link`);
        assert(near(middle(g[0], g[3]), from(-half)) && near(middle(g[1], g[2]), from(-half - grouser)), `${width}x${height}: a grouser off its link`);
        assert(Math.abs(wide(h) - TRACK_HORN_WIDTH * step) < 1e-6 && Math.abs(wide(g) - TRACK_GROUSER_WIDTH * step) < 1e-6);
        // The joint: its inner face `TRACK_JOINT` of a link long, as far in from the pin as the inside of the links.
        const joint = face(mesh, 3, i), inner = middle(joint[0], joint[1]);
        assert(Math.abs(Math.hypot(joint[1].x - joint[0].x, joint[1].y - joint[0].y) - TRACK_JOINT * step) < 1e-6);
        assert(Math.abs(Math.hypot(inner.x - ahead.x, inner.y - ahead.y) - half) < 1e-6, 'the joint off its pin');
        for (const p of [...body, ...joint, ...h, ...g]) assert(Math.abs(p.x) <= width / 2 + .1 && Math.abs(p.y) <= height);
      }
    } finally { mesh.destroy(); }
  }
  // Drawn small, omit invisible faces; the bodies and joints retain their exact material and geometry.
  for (const track of gears().slice(0, 4)) {
    const fine = linksOn(track, .23), coarse = linksOn(track, .23, Texture.WHITE, false);
    try {
      const n = coarse.count, compact = coarse.geometry.positions.slice(), uv = coarse.geometry.uvs.slice();
      assert.equal(compact.length, n * 20); assert.equal(coarse.geometry.indices.length, n * 18);
      assert.deepEqual(compact.subarray(0, n * 8), fine.geometry.positions.subarray(n * 8, n * 16), 'visible bodies stay exact');
      assert.deepEqual(compact.subarray(n * 8), fine.geometry.positions.subarray(n * 24), 'visible joints stay exact');
      assert.deepEqual(uv.subarray(0, n * 8), fine.geometry.uvs.subarray(n * 8, n * 16));
      assert.deepEqual(uv.subarray(n * 8), fine.geometry.uvs.subarray(n * 24));
      assert(coarse.geometry.indices.every(i => i < compact.length / 2));
      assert.deepEqual(coarse.tread, coarse.outline); assert.deepEqual(coarse.outline, fine.outline);
      // The same links, told again whether to draw them, move.
      assert.equal(coarse.update(coarse.start, coarse.belt, false), false); assert.equal(coarse.update(coarse.start, coarse.belt, true), true);
      assert.deepEqual(coarse.geometry.positions, fine.geometry.positions);
      assert.equal(coarse.update(coarse.start, coarse.belt, false), true);
      assert.deepEqual(coarse.geometry.positions, compact); assert.deepEqual(coarse.geometry.uvs, uv, 'zooming back restores the same compact topology');
    } finally { fine.destroy(); coarse.destroy(); }
  }
});

test('nothing shows between the links: where two open over a pin, round a wheel or under one, the joint between them covers it', () => {
  for (const track of gears()) {
    const mesh = linksOn(track, .37), { count } = mesh;
    try {
      for (let i = 0; i < count; i++) {
        // The corners of this link and of the one ahead at pin i, and so the opening between them, within the joint.
        const behind = face(mesh, 1, i), ahead = face(mesh, 1, (i + count - 1) % count), joint = face(mesh, 3, i);
        for (const p of [behind[2], behind[3], ahead[0], ahead[1], pinOf(mesh, i)])
          assert(beyond(p, joint) < 1e-6, `${track.width}x${track.height}: open over pin ${i}`);
      }
    } finally { mesh.destroy(); }
  }
});

test('the edge of the belt is the outside of the bodies of its links and their joints, round the wheels and under them, and the grousers stand out of it as far as its tread', () => {
  for (const track of gears()) {
    const mesh = linksOn(track, -1.3), { count, outline, tread } = mesh, faces = [], grousers = [], grouser = TRACK_GROUSER * track.height;
    try {
      for (let i = 0; i < count; i++) { faces.push(...[0, 1, 3].map(part => face(mesh, part, i))); grousers.push(face(mesh, 2, i)); }
      // Nothing of a link or a joint is out of it, and it stands off none of them: each of its places is on the edge of a
      // body or a joint.
      for (const polygon of faces) for (const p of polygon) assert(inside(p, outline, 1e-6), `${track.width}x${track.height}: a corner out of the edge`);
      for (let i = 0; i < outline.length; i += 2) {
        const p = { x: outline[i], y: outline[i + 1] };
        assert(faces.some(polygon => polygon.some((a, k) => onSegment(p, a, polygon[(k + 1) % polygon.length], 1e-6))), 'the edge stands off the links');
      }
      // The tread: each place of the edge pushed out as far as the grousers stand out of the faces of the links either
      // side of it, which stand out of the edge within it.
      for (let i = 0; i < outline.length; i += 2) {
        const out = Math.hypot(tread[i] - outline[i], tread[i + 1] - outline[i + 1]);
        assert(out >= grouser - 1e-9 && out < grouser * 1.25, `${track.width}x${track.height}: the tread ${out} m out of the edge`);
      }
      for (const [k, quad] of grousers.entries()) {
        assert(quad.every(p => inside(p, tread, 1e-6)), `${track.width}x${track.height}: grouser ${k} out of the tread`);
        assert(!inside({ x: (quad[1].x + quad[2].x) / 2, y: (quad[1].y + quad[2].y) / 2 }, outline, 0), 'a grouser within the edge');
      }
    } finally { mesh.destroy(); }
  }
});

test('where the belt bends, the links cut the corners off the picture of each joint as they cut its shape, without squeezing it', () => {
  for (const track of gears()) {
    const mesh = linksOn(track, 2.1), { count } = mesh, uvs = mesh.geometry.uvs, half = TRACK_SHOE_HALF_THICKNESS * track.height,
      length = TRACK_JOINT * mesh.belt.length / count / 2, top = (3 * 64 + 4.5) / 256, low = (3 * 64 + 59.5) / 256;
    let cut = 0;
    try {
      for (let i = 0; i < count; i++) {
        // The way along the joint, from its inner corners; where each of its corners is along it and out from it.
        const joint = face(mesh, 3, i), pin = pinOf(mesh, i), ax = (joint[1].x - joint[0].x) / (2 * length), ay = (joint[1].y - joint[0].y) / (2 * length);
        for (const [k, p] of joint.entries()) {
          const along = (p.x - pin.x) * ax + (p.y - pin.y) * ay, out = (p.x - pin.x) * ay - (p.y - pin.y) * ax, at = (count * 12 + i * 6 + k) * 2;
          assert(Math.abs(uvs[at] - (.5 + 119 / 256 * along / length)) < 1e-4 && Math.abs(uvs[at + 1] - (top + (low - top) * (out + half) / (2 * half))) < 1e-4);
          cut = Math.max(cut, half - out);
        }
      }
      assert(cut > half * .05, 'round the sprocket the links cut the joints');
    } finally { mesh.destroy(); }
  }
});

test('a stopped belt uploads nothing; a moving belt updates positions and material without rebuilding topology', () => {
  const mesh = new TrackLinks(Texture.WHITE);
  try {
    const gear = builtGear(5.04, .74), belt = gear.belt;
    mesh.configure(5.04, .74); assert(mesh.update(.1, belt));
    const geometry = mesh.geometry, positions = geometry.positions, indices = geometry.indices, uvs = geometry.uvs,
      buffers = [...geometry.buffers], before = positions.slice(), writes = [], outline = mesh.outline;
    buffers.forEach((buffer, index) => buffer.on('update', () => writes.push(index)));
    for (let i = 0; i < 120; i++) { mesh.configure(5.04, .74); assert.equal(mesh.update(.1, belt), false); }
    assert.equal(mesh.belt, belt); assert.equal(mesh.outline, outline); assert.deepEqual(writes, []);
    assert(mesh.update(.2, belt));
    assert.deepEqual(writes, [0, 1]); assert.notDeepEqual(positions, before); assert.notEqual(mesh.outline, outline);
    assert.equal(mesh.geometry, geometry); assert.equal(geometry.positions, positions); assert.equal(geometry.indices, indices); assert.equal(geometry.uvs, uvs);
    assert.equal(geometry.batchMode, 'no-batch'); assert.equal(mesh.batched, false);
    // A belt round wheels that have moved on their springs, from the same place: the links follow it.
    const moved = positions.slice();
    mesh.update(.2, trackGear({ x: 0, y: .05, angle: 0, width: 5.04, height: .74 }, { surface: x => ({ x, y: -.37, nx: 0, ny: 1 }) }).belt);
    assert.deepEqual(writes, [0, 1, 0, 1]); assert.notDeepEqual(positions, moved);
    mesh.configure(5.05, .74); mesh.update(.2, builtGear(5.05, .74).belt);
    assert.equal(geometry.positions, positions, 'small dimensional edits keep the allocated topology');
    mesh.configure(10, 1); mesh.update(.2, builtGear(10, 1).belt);
    assert.notEqual(geometry.positions, positions); assert(geometry.indices.every(index => index < geometry.positions.length / 2));
    mesh.destroy(); assert(buffers.every(buffer => buffer.destroyed)); mesh.destroy();
  } finally { mesh.destroy(); }
});

test('the shade lies within the edge of the belt, over each place of it once, as dark at each height as its picture is there', () => {
  const shade = new TrackShade();
  try {
    for (const track of gears()) {
      const mesh = linksOn(track, .8), { height } = track;
      try {
        shade.update(mesh.outline, height);
        const { positions, uvs, indices } = shade.geometry, outline = mesh.outline;
        assert.equal(positions.length, outline.length * 2);
        for (let i = 0; i < positions.length; i += 2) {
          if (i < outline.length) assert(Math.abs(positions[i] - outline[i]) < 1e-6 && Math.abs(positions[i + 1] - outline[i + 1]) < 1e-6);
          assert(Math.abs(uvs[i + 1] - (.5 - positions[i + 1] / height)) < 1e-6);
        }
        // Over each place within the belt one of its triangles, and none over a place out of it: none folds back over
        // another, nor reaches out of the belt.
        const triangles = [];
        for (let t = 0; t < indices.length; t += 3) triangles.push([0, 1, 2].flatMap(k => [positions[indices[t + k] * 2], positions[indices[t + k] * 2 + 1]]));
        const xs = outline.filter((_, i) => i % 2 === 0), ys = outline.filter((_, i) => i % 2), left = Math.min(...xs), right = Math.max(...xs),
          low = Math.min(...ys), high = Math.max(...ys);
        for (let u = .5; u < 60; u++) for (let v = .5; v < 20; v++) {
          const p = { x: left + (right - left) * u / 60, y: low + (high - low) * v / 20 };
          if (inside(p, outline, 2e-3) !== inside(p, outline, 0)) continue;
          const over = triangles.filter(points => inside(p, points, 0)).length;
          assert.equal(over, inside(p, outline, 0) ? 1 : 0, `${track.width}x${track.height}: the shade over ${p.x}, ${p.y} ${over} times`);
        }
      } finally { mesh.destroy(); }
    }
    // The same edge again changes nothing; the next one only moves it.
    const track = gears()[0], mesh = linksOn(track, 0), buffers = [...shade.geometry.buffers], writes = [];
    try {
      shade.update(mesh.outline, track.height);
      const positions = shade.geometry.positions;
      buffers.forEach((buffer, index) => buffer.on('update', () => writes.push(index)));
      shade.update(mesh.outline, track.height); assert.deepEqual(writes, []);
      mesh.update(.3, track.gear.belt); shade.update(mesh.outline, track.height);
      assert.equal(shade.geometry.positions, positions); assert.equal(writes.length, 2);
    } finally { mesh.destroy(); }
    shade.destroy(); assert(buffers.every(buffer => buffer.destroyed));
  } finally { shade.destroy(); }
});

test('textured shoes and joints sample separate guarded atlas faces and never repaint while the belt moves', t => {
  const { counters } = countingCanvas(t);
  for (const metal of [undefined, 'steel', 'aluminum', 'titanium']) {
    const look = metalOf({ metal }).look, texture = trackLinkTexture(look), made = { ...counters };
    try {
      assert.equal(texture.source.width, 128); assert.equal(texture.source.height, 256);
      assert.equal(texture.source.autoGenerateMipmaps, true); assert.equal(texture.source.style.mipmapFilter, 'linear');
      const mesh = linksOn({ width: 5.04, height: .74, gear: builtGear(5.04, .74) }, .5, texture), { count } = mesh, uvs = mesh.geometry.uvs;
      for (let vertex = 0; vertex < uvs.length / 2; vertex++) {
        const row = Math.min(3, Math.floor(vertex / (count * 4))), u = uvs[vertex * 2], v = uvs[vertex * 2 + 1];
        assert(u > 0 && u < 1); assert(v > row / 4 && v < (row + 1) / 4, 'no face samples a neighbour or a guard');
      }
      const belt = builtGear(5.04, .74).belt;
      for (let n = 0; n < 120; n++) mesh.update(n / 120, belt);
      assert.deepEqual(counters, made, 'moving links only update their corners');
      mesh.destroy(); assert.equal(texture.destroyed, false);
    } finally { texture.destroy(true); }
  }
});

test('the pins of the links stand in the gaps between the teeth of the sprocket wherever the belt comes round it, at every turn, on any ground and however the hull holds it', () => {
  for (const { width, height, gear } of gears()) {
    // One tooth to a link round the line of their pins, each link about as long as one of them is apart: the pins round
    // the sprocket each in a gap between two teeth, by as much as the two differ over half of it, each tooth half a gap
    // on from it, in the middle of a link (gear-art.ts).
    const { count, teeth, pitch } = trackLinks(width, height), pin = TRACK_PIN * height,
      belt = gear.belt, step = belt.length / count, pins = new Float64Array(count * 4), { sprocket } = gear,
      off = Math.abs(1 - step / pitch) * belt.arc(belt.sprocket).turn / 2 / (TAU / teeth) + .002;
    assert(Math.abs(pitch * teeth - TAU * pin) < 1e-12 && Math.abs(step - pitch) < pitch * .03 && off < .06);
    for (const turn of [0, .1, -.25, 3.3, -123.4]) {
      belt.sample(count, linkStart(gear, count, teeth, turn), step, pins);
      let engaged = 0;
      for (let i = 0; i < count; i++) {
        const dx = pins[4 * i] - sprocket.x, dy = pins[4 * i + 1] - sprocket.y;
        if (Math.abs(Math.hypot(dx, dy) - gear.pin) > 1e-9) continue;
        const on = (Math.atan2(dy, dx) - turn) / (TAU / teeth);
        assert(Math.abs(on - Math.round(on)) < off, `${width}x${height}, turned ${turn}: a pin off its tooth`);
        engaged++;
      }
      assert(engaged >= 2, 'the belt comes round the sprocket over more than one tooth');
    }
  }
});

test('pressed up its springs till its road wheels stand level with its sprocket or over it, the belt keeps its length and its links theirs', () => {
  for (const { width, height, gear } of pressedGears()) {
    const what = `${width}x${height}`, { pitch } = trackLinks(width, height), built = builtGear(width, height).belt, belt = gear.belt;
    // Round the sprocket and the idler outside, as built, never inside out.
    for (const end of [1, belt.sprocket]) assert(belt.arc(end).turn > Math.PI / 2, `${what}: the belt bends in round an end wheel`);
    assert(Math.abs(belt.length / built.length - 1) < .02, `${what}: the belt is ${belt.length} m long, built ${built.length} m`);
    const mesh = linksOn({ width, height, gear }, .4), { count } = mesh, step = belt.length / count;
    try {
      assert(Math.abs(step / pitch - 1) < .03, `${what}: links ${step} m apart, ${pitch} m long`);
      // Each link from the pin behind it to the one ahead, as far as along the belt but where it cuts across a bend.
      for (let i = 0; i < count; i++) {
        const a = pinOf(mesh, i), b = pinOf(mesh, i + 1), chord = Math.hypot(a.x - b.x, a.y - b.y);
        assert(chord <= step + 1e-9 && chord > step * .95, `${what}: link ${i} is ${chord} m long, ${step} m along the belt`);
      }
    } finally { mesh.destroy(); }
  }
});

// The line of the pins of the upper run of a belt, as high as it is over `x` (the highest place of the belt there), to
// a millimetre along it.
function upperAt(belt, x) {
  const n = Math.ceil(belt.length / .001), places = belt.sample(n, 0, belt.length / n, new Float64Array(n * 4));
  let best = -Infinity;
  for (let i = 0; i < n; i++) if (Math.abs(places[i * 4] - x) < .0006) best = Math.max(best, places[i * 4 + 1]);
  return best;
}
test('the upper run rests on the rollers and sags between them the more as the belt is slack, within its range', () => {
  for (const [width, height] of [[6.8, 1.02], [6, .67], [2.2, .39], [12, 1.17]]) {
    const built = builtGear(width, height), belt = built.belt, half = TRACK_SHOE_HALF_THICKNESS * height, { end } = trackWheels(width, height),
      what = `${width}x${height}`, top = end.y + TRACK_PIN * height,
      // Where it rests, from the idler back to the sprocket, and how far it sags halfway between each two.
      supports = [end.x, ...built.rollers.map(r => r.x).reverse(), -end.x], dips = belt => supports.slice(1).map((x, i) => top - upperAt(belt, (x + supports[i]) / 2));
    assert(built.rollers.length >= 2);
    // On each roller the inside of the bodies of its shoes, and between each two, sagging the more the longer the span,
    // a centimetre or two on a track a metre high, never more than four hundredths of its height.
    for (const roller of built.rollers) assert(Math.abs(upperAt(belt, roller.x) - (roller.y + roller.radius + half)) < 2e-4, `${what}: off the roller at ${roller.x}`);
    const rest = dips(belt);
    for (const [i, dip] of rest.entries()) {
      const span = Math.abs(supports[i + 1] - supports[i]);
      assert(dip > .005 * height && dip <= .04 * height + 1e-6, `${what}: sagging ${dip} m over ${span} m`);
      assert(Math.abs(dip / (span * span) - rest[0] / (supports[1] - supports[0]) ** 2) < 1e-3 / height, `${what}: as taut in every span`);
    }
    // Held a little lower on its springs, the hull lets the belt round the road wheels go slack: the upper run sags
    // further, taking up some of what the belt is the longer for it and never more; held much lower, no further than
    // six tenths more than as built, nor than four hundredths of the height of the track. Held higher, the belt is the
    // tighter: the upper run sags less, never less than four tenths of as built, and the belt is the longer for less
    // than it would be. In the workshop, with no time, it sags as built however the hull holds it.
    const flat = { surface: x => ({ x, y: -height / 2, nx: 0, ny: 1 }) }, track = { x: 0, y: 0, angle: 0, width, height },
      held = (y, now = 0) => { const gear = trackGear(track, flat, { x: 0, y: y * height, angle: 0 }, null, now); return { gear, dips: dips(gear.belt).map(dip => dip + y * height) }; },
      share = run => run.dips.map((dip, i) => dip / rest[i]);
    for (const y of [-.01, -.03, -.12]) {
      const slack = held(y), still = held(y, null), shares = share(slack);
      assert(slack.gear.sag > built.sag && slack.gear.sag <= 1.6 * built.sag + 1e-12, `${what}: sagging ${slack.gear.sag}, ${built.sag} as built`);
      assert(shares.every(r => Math.abs(r - shares[0]) < .02) && Math.max(...slack.dips) <= .04 * height + 1e-4, `${what}: sagging ${slack.dips} held ${y} down`);
      assert(still.gear.belt.length < slack.gear.belt.length && slack.gear.belt.length < belt.length, `${what}: the belt ${slack.gear.belt.length} m long held ${y} down, ${belt.length} m as built`);
      assert.equal(still.gear.sag, built.sag);
    }
    for (const y of [.01, .03, .12]) {
      const taut = held(y), still = held(y, null);
      assert(taut.gear.sag < built.sag && taut.gear.sag >= .4 * built.sag - 1e-12 && taut.dips.every(dip => dip > .3 * Math.min(...rest)), `${what}: sagging ${taut.dips} held ${y} up`);
      assert(belt.length < taut.gear.belt.length && taut.gear.belt.length < still.gear.belt.length, `${what}: the belt ${taut.gear.belt.length} m long held ${y} up, ${belt.length} m as built`);
      assert.equal(still.gear.sag, built.sag);
    }
    // As built, it sags as built, at a time or not.
    assert(Math.abs(trackGear(track, flat, null, null, 0).sag - built.sag) < 1e-12 * built.sag);
  }
});

test('as its road wheels go up and down a few millimetres from frame to frame, the upper run never goes taut nor jumps, and goes the same way each time', () => {
  // A belt rocked on its springs by a millimetre or two and its road wheels pressed up and let down by up to four over
  // ground that changes under them from frame to frame, at sixty frames a second: its upper run sags all the while, by
  // no more from one frame to the next than a twentieth of as built; as built when it stands still on level ground;
  // and frame for frame the same, given the same frames.
  const ride = (width, height) => {
    const built = builtGear(width, height), track = { x: 0, y: 0, angle: 0, width, height }, sags = [];
    let gear = null;
    for (let frame = 0; frame < 600; frame++) {
      const bump = x => .004 * Math.sin(x * 12.9898 + frame * 78.233 + Math.sin(frame * .37) * 3),
        ground = { surface: x => ({ x, y: -height / 2 + bump(x), nx: 0, ny: 1 }) },
        hold = { x: 0, y: .002 * Math.sin(frame * .21) - .001 * Math.cos(frame * 1.3), angle: .0004 * Math.sin(frame * .17) };
      gear = trackGear(track, ground, hold, gear, frame / 60);
      sags.push(gear.sag);
    }
    const flat = { surface: x => ({ x, y: -height / 2, nx: 0, ny: 1 }) }, still = [];
    for (let frame = 600; frame < 720; frame++) still.push((gear = trackGear(track, flat, null, gear, frame / 60)).sag);
    return { built, sags, still };
  };
  for (const [width, height] of [[6.8, 1.02], [6, .67], [2.2, .39], [12, 1.17]]) {
    const { built, sags, still } = ride(width, height), what = `${width}x${height}`, rest = built.sag;
    assert(sags.every(sag => sag >= .4 * rest - 1e-12 && sag <= 1.6 * rest + 1e-12), `${what}: sagging from ${Math.min(...sags) / rest} to ${Math.max(...sags) / rest} of as built`);
    const jump = Math.max(...sags.slice(1).map((sag, i) => Math.abs(sag - sags[i])));
    assert(jump <= rest / 20, `${what}: a jump of ${jump / rest} of as built from one frame to the next`);
    assert(Math.max(...sags) - Math.min(...sags) > .01 * rest, `${what}: the upper run never moved`);
    assert(Math.abs(still.at(-1) - rest) < 1e-12 * rest, `${what}: standing still on level ground, sagging ${still.at(-1) / rest} of as built`);
    assert.deepEqual(ride(width, height).sags, sags);
  }
});

test('the idler turns on a crank from the side of the hull, held taut by a screw, all where the hull holds them', () => {
  for (const [width, height] of [[6.8, 1.02], [6, .67], [2.2, .39], [12, 1.17], [3, 1]]) {
    const built = builtGear(width, height), { idler, crank, road, drawn } = built, what = `${width}x${height}`,
      parts = idlerCrank(crank, idler, height), size = drawn.find(w => w.role === 'idler').radius;
    // The arm from its pivot, clear of the idler and of every road wheel, to the hub of the idler; the screw from its
    // bracket to the arm.
    assert(Math.hypot(crank.pivot.x - idler.x, crank.pivot.y - idler.y) > size + parts.boss.r, `${what}: the pivot behind the idler`);
    for (const wheel of road) assert(Math.hypot(crank.pivot.x - wheel.x, crank.pivot.y - wheel.y) > drawn.find(w => w.role === 'road').radius, `${what}: the pivot behind a road wheel`);
    assert(near({ x: (parts.arm[2].x + parts.arm[3].x) / 2, y: (parts.arm[2].y + parts.arm[3].y) / 2 }, idler, 1e-9));
    assert(near({ x: (parts.rod[2].x + parts.rod[3].x) / 2, y: (parts.rod[2].y + parts.rod[3].y) / 2 }, parts.eye, 1e-9) && beyond(parts.eye, parts.arm) < 0);
    // Close up, drawn behind the wheels with the arms and the brackets; where the hull holds the idler, there too.
    const frame = new GraphicsRecorder();
    drawTrackFrame(frame, built, metalOf({}).look, height, false);
    assert(frame.fills().some(({ points }) => points.length === 8 && near({ x: points[0], y: points[1] }, parts.arm[0], 1e-9)), `${what}: the crank not drawn`);
    const hold = { x: .01, y: -.1 * height, angle: .03 }, c = Math.cos(hold.angle), s = Math.sin(hold.angle),
      held = trackGear({ x: 0, y: 0, angle: 0, width, height }, { surface: x => ({ x, y: -height / 2, nx: 0, ny: 1 }) }, hold);
    for (const key of ['pivot', 'anchor']) {
      const p = crank[key];
      assert(near(held.crank[key], { x: hold.x + c * p.x - s * p.y, y: hold.y + s * p.x + c * p.y }, 1e-12), key);
    }
  }
});

test('a track takes the tone of the dust of the ground it runs on, less off hard ground, and goes over to that of the next one slowly, never at once', () => {
  const tone = colour => [colour >> 16 & 255, colour >> 8 & 255, colour & 255], dust = surface => tone(GROUND_SURFACES[surface].dust);
  // At first as dirty as the ground under it has it; on ground of no known kind, of earth.
  let soil = trackDirt(null, 'sand', 10);
  assert.deepEqual(tone(soil.tone), dust('sand')); assert.equal(soil.amount, TRACK_DIRT);
  assert.deepEqual(tone(trackDirt(null, undefined, 0).tone), dust('soil'));
  assert.equal(trackDirt(null, 'asphalt', 0).amount, TRACK_DIRT / 2); assert.equal(trackDirt(null, 'concrete', 0).amount, TRACK_DIRT / 2);
  // Onto asphalt, frame by frame: each frame a little nearer, never past it, most of the way in three turns.
  const from = dust('sand'), to = dust('asphalt'), way = from.map((v, i) => to[i] - v);
  let last = 0, time = 10;
  for (let frame = 1; frame <= 60 * 3 * DIRT_TURN; frame++) {
    time += 1 / 60; soil = trackDirt(soil, 'asphalt', time);
    const gone = tone(soil.tone).reduce((sum, v, i) => sum + (v - from[i]) * way[i], 0) / way.reduce((sum, v) => sum + v * v, 0);
    assert(gone >= last - .01 && gone <= 1.01, `frame ${frame}: ${gone} of the way`);
    if (frame === 1) assert(gone < .03, 'at once');
    last = gone;
  }
  assert(last > .9 && Math.abs(soil.amount - TRACK_DIRT / 2) < .1 * TRACK_DIRT, `three turns on: ${last} of the way`);
  // A pause of the page does not jump it: no more than a quarter of a second counts.
  const held = { ...soil }, after = trackDirt({ ...soil }, 'mud', time + 60);
  assert(Math.abs(after.r - held.r) <= Math.abs(dust('mud')[0] - held.r) * (1 - Math.exp(-.25 / DIRT_TURN)) + 1e-9);
});

test('the dirt lies on the lower run and the lower half of the wheels, thickest along the ground, none from their middles up', t => {
  // The stops of the fall of its alpha down the picture, as it is painted.
  countingCanvas(t);
  const stops = [], make = document.createElement;
  document.createElement = type => {
    const made = make(type), ctx = made.getContext('2d');
    ctx.createLinearGradient = (x0, y0, x1, y1) => {
      assert.deepEqual([x0, x1], [0, 0]);
      return { addColorStop: (at, colour) => stops.push([at * (y1 - y0) / 64, Number(/,([\d.]+)\)$/.exec(colour)[1])]) };
    };
    return made;
  };
  const texture = trackDirtTexture();
  try {
    assert.equal(texture.source.height, 64);
    // Down the picture, as the shade has it over the middle of the track (`TrackShade`): none down to the middles of the
    // road wheels, then ever more down to all of it along the ground.
    const { low } = trackWheels(5.04, .74), middle = .5 - low / .74, alpha = v => {
      const k = stops.findIndex(([at]) => at >= v); if (k <= 0) return stops.at(k)[1];
      const [a, x] = stops[k - 1], [b, y] = stops[k]; return x + (y - x) * (v - a) / (b - a);
    };
    assert.deepEqual(stops.at(-1), [1, 1]);
    assert(alpha(middle) < 1e-6, 'no dirt over the middles of the road wheels');
    for (let v = middle; v < 1; v += .01) assert(alpha(v + .01) > alpha(v), `more dirt under ${v}`);
  } finally { texture.destroy(true); }
});

// The places of the picture of a track that are filled with something that hides what is behind it: each outline filled
// in one tone, or in tones of which one is solid, x and y one after another, in the pixels of a canvas `width` across.
function solidFills(widthM, heightM, width = 800) {
  const fills = [], stack = [],
    solid = colour => typeof colour === 'string' ? !colour.startsWith('rgba') && (colour.length !== 9 || colour.endsWith('ff')) : colour.stops.some(solid);
  let pose = { x: 0, y: 0, angle: 0 }, path = [];
  const at = (x, y) => [pose.x + Math.cos(pose.angle) * x - Math.sin(pose.angle) * y, pose.y + Math.sin(pose.angle) * x + Math.cos(pose.angle) * y],
    round = (x, y, rx, ry) => { for (let k = 0; k < 24; k++) path.push(...at(x + rx * Math.cos(k * TAU / 24), y + ry * Math.sin(k * TAU / 24))); },
    fill = (points, style) => { if (ctx.globalCompositeOperation === 'source-over' && solid(style)) fills.push(points); },
    gradient = () => ({ stops: [], addColorStop(at, colour) { this.stops.push(colour); } });
  const ctx = { canvas: { width, height: Math.round(width * heightM / widthM) }, globalCompositeOperation: 'source-over',
    save() { stack.push({ ...pose, composite: this.globalCompositeOperation }); },
    restore() { const { composite, ...held } = stack.pop(); pose = held; this.globalCompositeOperation = composite; },
    translate(x, y) { [pose.x, pose.y] = at(x, y); }, rotate(angle) { pose.angle += angle; },
    beginPath() { path = []; }, moveTo(x, y) { path.push(...at(x, y)); }, lineTo(x, y) { path.push(...at(x, y)); }, closePath() {},
    arc(x, y, r) { round(x, y, r, r); }, ellipse(x, y, rx, ry) { round(x, y, rx, ry); },
    fill() { fill(path, this.fillStyle); }, fillRect(x, y, w, h) { fill([...at(x, y), ...at(x + w, y), ...at(x + w, y + h), ...at(x, y + h)], this.fillStyle); },
    stroke() {}, clip() {}, createLinearGradient: gradient, createRadialGradient: gradient };
  paintGear(ctx, 'track', widthM, heightM);
  return { fills, pixels: (x, y) => ({ x: (x / widthM + .5) * width, y: ctx.canvas.height / 2 - y * ctx.canvas.height / heightM }) };
}

test('within the belt, between the road wheels and under the side of the hull, nothing is drawn: what is behind the track shows', () => {
  for (const [width, height] of [[5.04, .74], [8, 1.2], [12, 1.17], [2.2, .39]]) {
    // Halfway between two road wheels, as high as their middles, clear of every wheel.
    const { road, low } = trackWheels(width, height), what = `${width}x${height}`, { drawn } = builtGear(width, height),
      gaps = road.slice(1).map((x, i) => ({ x: (x + road[i]) / 2, y: low })).filter(p => drawn.every(w => Math.hypot(p.x - w.x, p.y - w.y) > w.radius));
    assert(gaps.length >= 2, what);
    // Close up: the arms, the brackets and the band of the belt from afar over the side of the hull.
    for (const casing of [false, true]) {
      const frame = new GraphicsRecorder();
      drawTrackFrame(frame, builtGear(width, height), metalOf({}).look, height, casing);
      for (const p of gaps) assert(frame.fills().every(({ points }) => !inside(p, points, 0)), `${what}: filled between the road wheels`);
    }
    // From afar, its picture.
    const { fills, pixels } = solidFills(width, height);
    for (const p of gaps.map(p => pixels(p.x, p.y))) assert(fills.every(points => !inside(p, points, 0)), `${what}: its picture filled between the road wheels`);
  }
});

test('the sprocket alone moves the links: still, it keeps them at its teeth as the hull and the ground shape the belt; turned, they go round with it', () => {
  const terrain = new Terrain('rough'), width = 5.04, height = .74, { count, teeth } = trackLinks(width, height), tooth = TAU / teeth,
    pins = new Float64Array(count * 4);
  // How far round from its tooth each pin on the sprocket is, by the tooth, the sprocket turned `turn`.
  const offTeeth = (gear, turn) => {
    const belt = gear.belt, off = new Map();
    belt.sample(count, linkStart(gear, count, teeth, turn), belt.length / count, pins);
    for (let i = 0; i < count; i++) {
      const dx = pins[4 * i] - gear.sprocket.x, dy = pins[4 * i + 1] - gear.sprocket.y;
      if (Math.abs(Math.hypot(dx, dy) - gear.pin) > 1e-9) continue;
      const on = (((Math.atan2(dy, dx) - turn) % TAU + TAU) % TAU) / tooth, at = Math.round(on);
      off.set(at % teeth, (on - at) * tooth);
    }
    return off;
  };
  const first = offTeeth(builtGear(width, height), .4);
  for (let k = 0; k < 12; k++) {
    const x = 20 + k * 3.7, hold = { x: .01 * Math.sin(k) * height, y: (-.1 + .015 * k) * height, angle: .04 * Math.cos(k) },
      gear = trackGear({ x, y: terrain.height(x) + height / 2, angle: Math.atan(terrain.surface(x).slope), width, height }, terrain, hold, null, 0),
      off = offTeeth(gear, .4);
    assert(off.size >= 2);
    for (const [at, angle] of off) if (first.has(at))
      assert(Math.abs(angle - first.get(at)) < .05 * tooth, 'a link on the still sprocket slips round it as the belt changes shape');
  }
  // Turned, the links go round the way the sprocket does: each the same way along the belt, by as far as its teeth go.
  const gear = builtGear(width, height), belt = gear.belt, step = belt.length / count;
  let last = linkStart(gear, count, teeth, 0);
  for (let turn = -.05; turn > -2; turn -= .05) {
    const start = linkStart(gear, count, teeth, turn), moved = ((start - last) % step + step * 1.5) % step - step / 2;
    assert(Math.abs(moved + .05 * gear.pin) < .05 * .05 * gear.pin, `turned to ${turn}: the links went ${moved}`);
    last = start;
  }
});
