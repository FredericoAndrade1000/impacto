import test from 'node:test';
import assert from 'node:assert/strict';
import { paintComponent } from '../src/component-art.ts';
import { MACHINE_KINDS, machineCanvas, radarAerial } from '../src/machine-art.ts';
import { componentReference } from '../src/component-size.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';

// A context that keeps, in pixels of its canvas, the outline of everything filled with an opaque paint — through the
// transforms and the clips it was filled under —, the circles drawn (and how far the transform they were drawn under
// squashes them), and the lettering. An ellipse is a circle seen aslant, which no piece shows: it is refused.
function recorder(width, height) {
  let m = [1, 0, 0, 1, 0, 0], clips = [], subpaths = [], current = null, at = [0, 0];
  const saved = [], fills = [], circles = [], texts = [];
  const apply = (x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const multiply = (a, b, c, d, e, f) => {
    m = [m[0] * a + m[2] * b, m[1] * a + m[3] * b, m[0] * c + m[2] * d, m[1] * c + m[3] * d, m[0] * e + m[2] * f + m[4], m[1] * e + m[3] * f + m[5]];
  };
  const point = (x, y) => { if (!current) subpaths.push(current = []); current.push(apply(x, y)); at = [x, y]; };
  const curve = (controls, x, y) => {
    const [x0, y0] = at;
    for (let i = 1; i <= 8; i++) {
      const t = i / 8, points = [[x0, y0], ...controls, [x, y]];
      while (points.length > 1) points.splice(0, points.length, ...points.slice(1).map((p, k) => [points[k][0] + (p[0] - points[k][0]) * t, points[k][1] + (p[1] - points[k][1]) * t]));
      point(...points[0]);
    }
  };
  const arc = (x, y, r, start, end, ccw = false) => {
    let sweep = end - start;
    if (!ccw && sweep < 0) sweep += Math.PI * 2; if (ccw && sweep > 0) sweep -= Math.PI * 2;
    if (Math.abs(end - start) >= Math.PI * 2) sweep = ccw ? -Math.PI * 2 : Math.PI * 2;
    for (let i = 0; i <= 24; i++) { const a = start + sweep * i / 24; point(x + Math.cos(a) * r, y + Math.sin(a) * r); }
  };
  const gradient = () => { const stops = []; return { stops, addColorStop: (at, color) => stops.push(color) }; };
  const alpha = color => typeof color === 'string' ? (color.length === 9 ? parseInt(color.slice(7), 16) / 255 : 1) : Math.min(...color.stops.map(alpha));
  const ctx = {
    canvas: { width, height }, fillStyle: '#000000',
    save() { saved.push({ m, clips }); }, restore() { ({ m, clips } = saved.pop()); },
    translate(x, y) { multiply(1, 0, 0, 1, x, y); }, scale(x, y) { multiply(x, 0, 0, y, 0, 0); },
    rotate(a) { multiply(Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0); },
    beginPath() { subpaths = []; current = null; }, closePath() { current = null; },
    moveTo(x, y) { current = null; point(x, y); }, lineTo: point,
    quadraticCurveTo(cx, cy, x, y) { curve([[cx, cy]], x, y); }, bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { curve([[c1x, c1y], [c2x, c2y]], x, y); },
    rect(x, y, w, h) { ctx.roundRect(x, y, w, h, 0); },
    roundRect(x, y, w, h, r = 0) {
      current = null;
      for (const [cx, cy, a] of [[x + w - r, y + r, -Math.PI / 2], [x + w - r, y + h - r, 0], [x + r, y + h - r, Math.PI / 2], [x + r, y + r, Math.PI]])
        for (let i = 0; i <= 4; i++) point(cx + Math.cos(a + i * Math.PI / 8) * r, cy + Math.sin(a + i * Math.PI / 8) * r);
      current = null;
    },
    arc(x, y, r, start, end, ccw) {
      arc(x, y, r, start, end, ccw);
      if (end - start >= Math.PI * 2 - 1e-9) {
        const [cx, cy] = apply(x, y);
        circles.push({ r: r * Math.hypot(m[0], m[1]), x: cx, y: cy, squash: Math.hypot(m[2], m[3]) / Math.hypot(m[0], m[1]) });
      }
    },
    ellipse() { throw new Error('an ellipse is a circle seen aslant'); },
    fill() { if (alpha(ctx.fillStyle) >= .5) fills.push({ polygons: subpaths.map(p => p.slice()), clips, style: ctx.fillStyle }); },
    fillRect(x, y, w, h) { ctx.beginPath(); ctx.rect(x, y, w, h); ctx.fill(); },
    clip() { clips = [...clips, subpaths.map(p => p.slice())]; },
    stroke() {}, createLinearGradient: gradient, createRadialGradient: gradient,
    measureText: text => ({ width: text.length * 7 }), fillText(text) { texts.push(text); },
  };
  return { ctx, fills, circles, texts };
}
const inside = ([x, y], polygon) => {
  let hit = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const [xi, yi] = polygon[i], [xj, yj] = polygon[j];
    if (yi > y !== yj > y && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const within = (p, polygons) => polygons.some(polygon => inside(p, polygon));

// A piece painted as the game paints it: on a canvas of its own shape, at its size — or, given it, at `size`.
const reference = (kind, options) => componentReference({ kind, sensorMode: options.sensorMode });
function painted(kind, scale, options = {}, size = reference(kind, options)) {
  const widthM = size.width * scale, heightM = size.height * scale, [width, height] = machineCanvas(widthM, heightM),
    record = recorder(width, height), before = { ...options };
  paintComponent(record.ctx, kind, widthM, heightM, options);
  assert.deepEqual(options, before, 'the art does not touch what it is given');
  return { ...record, width, height, perMetre: width / widthM };
}
// What fills its box; a sensor stands in it by its outline.
const SOLIDS = [['engine', [.25, .5, 1, 2, 3.65], {}],
    ...['rh120', 'm2hb', 'fnmag', 'minimi', 'm242', 'mk44', 'mk19', 'm777', 'm119', 'm252', 'm224', 'carlgustaf', 'at4', 'hydra70', undefined]
      .map(ammoPreset => ['ammo', [.25, .5, 1, 2, 5.1], { ammoPreset }]),
    ['command', [1], {}]],
  PIECES = [...SOLIDS, ...['visual', 'radar', 'sound', undefined].map(sensorMode => ['sensor', [1], { sensorMode }]),
    ...['builder', 'excavator', 'drill'].map(kind => [kind, [.25, 1, 3], {}])];

test('the engine, the ammunition, the command and the sensors are painted on a canvas of their own shape', () => {
  assert.deepEqual([...MACHINE_KINDS].sort(), ['ammo', 'blade', 'command', 'engine', 'paver', 'sensor', 'thruster']);
  for (const [kind, scales, options] of PIECES) for (const scale of scales) {
    const widthM = reference(kind, options).width * scale, heightM = reference(kind, options).height * scale, [width, height] = machineCanvas(widthM, heightM);
    assert(Math.abs(width / height - widthM / heightM) < 2 / height, `${kind} ×${scale}: ${width}×${height}`);
    assert(Math.max(width, height) >= 256 && Math.max(width, height) <= 1024, `${kind} ×${scale}: ${width}×${height}`);
  }
});

// The dark ground a piece with recesses is laid on (machine-art.ts `underlay`).
const RECESS = '#141f1a';
// The faces of the aerial of a radar, each painted on its own at its size (machine-art.ts `radarAerial`).
const radar = reference('sensor', { sensorMode: 'radar' }), aerial = radarAerial(radar.width, radar.height), AERIAL = ['face', 'back', 'edge']
  .map(style => ['sensor', [1], { sensorMode: 'radar', style }, { width: style === 'edge' ? aerial.depth : aerial.width, height: aerial.height }]);
test('the art covers the whole box of its piece at every size, up to its small rounded corners, and its parts nearly all of it', () => {
  for (const [kind, scales, options, size] of [...SOLIDS, ...AERIAL]) for (const scale of scales) {
    const { fills, width, height, perMetre } = painted(kind, scale, options, size), corner = .016 * perMetre, holes = [],
      parts = fills.filter(fill => fill.style !== RECESS), name = `${kind} ×${scale} ${JSON.stringify(options)}`;
    let samples = 0, recessed = 0;
    for (let j = 0; j < 40; j++) for (let i = 0; i < 60; i++) {
      const p = [(i + .5) * width / 60, (j + .5) * height / 40], dx = Math.min(p[0], width - p[0]), dy = Math.min(p[1], height - p[1]),
        covers = ({ polygons, clips }) => within(p, polygons) && clips.every(clip => within(p, clip));
      if (dx < corner && dy < corner) continue;
      samples++;
      if (!fills.some(covers)) holes.push(p.map(Math.round)); else if (!parts.some(covers)) recessed++;
    }
    assert.deepEqual(holes, [], name);
    assert(recessed / samples < .1, `${name}: ${Math.round(recessed / samples * 100)} % is only recess`);
  }
});

// How far what is painted stays from the edges of its canvas, in metres: left, right, top, foot.
const margins = ({ fills, width, height, perMetre }) => {
  const points = fills.flatMap(({ polygons }) => polygons.flat()), xs = points.map(p => p[0]), ys = points.map(p => p[1]);
  return [Math.min(...xs), width - Math.max(...xs), Math.min(...ys), height - Math.max(...ys)].map(gap => gap / perMetre);
};
test('sensors fill their admitted outline and the mobile radar uses a compact panel on its pan unit', () => {
  // The camera and the microphones reach from side to side and from their foot to their top.
  for (const sensorMode of ['visual', 'sound', undefined]) for (const gap of margins(painted('sensor', 1, { sensorMode })))
    assert(Math.abs(gap) < .004, `${sensorMode}: ${gap}`);
  assert.deepEqual([radar.width, radar.height, radar.depthM], [.65, .546, .13]);
  assert.deepEqual(Object.values(aerial).map(v => +v.toFixed(6)), [.65, .41496, .13, .06552]);
  const [left, right, top, foot] = margins(painted('sensor', 1, { sensorMode: 'radar' }));
  assert(Math.abs(foot) < .004 && Math.abs(top - aerial.height) < .004 && left > radar.width * .2 && right > radar.width * .2, `${[left, right, top, foot]}`);
  // Its face and its back are other pictures. Each fills its corners: they are the sides of one slab, and two the eye
  // sees meet without a notch between them.
  const look = style => painted('sensor', 1, { sensorMode: 'radar', style }, aerial).fills.map(f => f.style).join();
  assert.notEqual(look('face'), look('back'));
  for (const style of ['face', 'back', 'edge']) {
    const { fills, width, height } = painted('sensor', 1, { sensorMode: 'radar', style }, style === 'edge' ? { width: aerial.depth, height: aerial.height } : aerial);
    for (const p of [[.5, .5], [width - .5, .5], [width - .5, height - .5], [.5, height - .5]])
      assert(fills.some(({ polygons, clips }) => within(p, polygons) && clips.every(clip => within(p, clip))), `${style}: the corner at ${p}`);
  }
});

test('what has a size of its own keeps it on a bigger piece: there are more of them, not bigger ones', () => {
  const bolts = scale => painted('engine', scale).fills.flatMap(({ polygons }) => polygons).filter(polygon => polygon.length === 6),
    radius = (polygon, perMetre) => Math.hypot(polygon[0][0] - polygon[3][0], polygon[0][1] - polygon[3][1]) / 2 / perMetre;
  const one = painted('engine', 1), two = painted('engine', 2), [small, big] = [bolts(1), bolts(2)];
  assert(big.length > small.length * 1.5, `${small.length} bolts, then ${big.length}`);
  assert.equal(Math.max(...big.map(b => radius(b, two.perMetre))).toFixed(4), Math.max(...small.map(b => radius(b, one.perMetre))).toFixed(4));
  // A cannon's rounds are as wide as its calibre has them, and a box twice the size holds about four times as many.
  const bases = (scale, preset) => { const art = painted('ammo', scale, { ammoPreset: preset }); return art.circles.filter(c => Math.abs(c.r / art.perMetre - .075) < 1e-6).length; };
  assert(bases(1, 'rh120') >= 9 && bases(2, 'rh120') >= bases(1, 'rh120') * 3.2, `${bases(1, 'rh120')} rounds, then ${bases(2, 'rh120')}`);
  assert.equal(bases(.25, 'rh120'), 0, 'a box too small for one round at its size shows a smaller one');
});

test('the ammunition shows the rounds of the gun it is for', () => {
  const art = preset => painted('ammo', 1, { ammoPreset: preset }),
    ends = (preset, ratio) => {
      const { circles, perMetre } = art(preset), r = WEAPON_PRESETS[preset].caliberMm / 1000 * ratio / 2;
      return circles.filter(c => Math.abs(c.r / perMetre - r) < 1e-6).length;
    },
    look = preset => { const { fills, circles, texts } = art(preset); return [fills.length, circles.length, texts.join()].join(':'); };
  // A cannon's stub bases and the launch tubes end-on, as wide as their rounds; the belts of the automatic guns in cans
  // stencilled with their calibre; a howitzer's shells and a mortar's bombs, each of a look of its own.
  assert(ends('rh120', 1.25) > 0 && ends('carlgustaf', 1.22) > 0 && ends('hydra70', 1.22) > 0);
  for (const preset of ['minimi', 'm2hb', 'm242', 'mk44', 'mk19'])
    assert(art(preset).texts.includes(`${String(WEAPON_PRESETS[preset].caliberMm).replace('.', ',')} mm`), preset);
  const looks = ['rh120', 'carlgustaf', 'm2hb', 'm777', 'm252'].map(look);
  assert.equal(new Set(looks).size, looks.length);
  assert.equal(look(undefined), look('rh120'), 'a box that does not say keeps the cannon rounds');
});

// The one rule of the art (machine-art.ts): every piece is a side elevation, seen square on. Only what turns across the
// vehicle shows round, and a round thing is never squashed into an ellipse, as a disc seen aslant would be.
const FITTING = .02;
test('every piece is drawn square on from the side: only what crosses the vehicle is round, and no circle is seen aslant', () => {
  for (const [kind, scales, options] of PIECES) for (const scale of scales) {
    const { circles } = painted(kind, scale, options), name = `${kind} ×${scale} ${JSON.stringify(options)}`;
    for (const { squash } of circles) assert(Math.abs(squash - 1) < .02, `${name}: a circle squashed ${squash.toFixed(3)}`);
  }
  // The engine lies lengthwise and drives a cross-drive gearbox: of all it shows, only the output to the sprocket, low in
  // the gearbox at its end, is a round thing bigger than a fitting — no flywheel, pulley, radiator or turbocharger face on.
  for (const scale of [.25, .5, 1, 2, 3.65]) {
    const { circles, perMetre, width, height } = painted('engine', scale), big = circles.filter(c => c.r / perMetre > FITTING),
      centres = new Set(big.map(c => `${Math.round(c.x)},${Math.round(c.y)}`));
    assert(big.length >= 1 && centres.size === 1, `engine ×${scale}: ${[...centres]}`);
    assert(big[0].x < width * .3 && big[0].y > height * .5, `engine ×${scale}: the output at ${big[0].x}, ${big[0].y}`);
  }
  // A howitzer's projectiles stand and a mortar's bombs and the cans of the automatic guns lie along the vehicle: their
  // racks have nothing round in them but bolts, rivets and a hinge's knuckle.
  for (const ammoPreset of ['m777', 'm119', 'm252', 'm224', 'm2hb', 'minimi', 'fnmag', 'mk35', 'mk44', 'mk19'])
    for (const scale of [.5, 1, 2]) {
      const { circles, perMetre } = painted('ammo', scale, { ammoPreset });
      assert(circles.every(c => c.r / perMetre < .01), `${ammoPreset} ×${scale}: ${Math.max(...circles.map(c => c.r / perMetre))} m`);
    }
  // A rack is seen square on, not looked into: what it holds stands before a plate in the light, with no dark hollow
  // behind it as a cabinet seen into has.
  const lightness = hex => { const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)); return (Math.max(...c) + Math.min(...c)) / 510; };
  for (const ammoPreset of Object.keys(WEAPON_PRESETS)) {
    const { fills, width, height } = painted('ammo', 1, { ammoPreset });
    for (const { polygons, style } of fills) {
      const xs = polygons.flat().map(p => p[0]), ys = polygons.flat().map(p => p[1]), tones = typeof style === 'string' ? [style] : style.stops;
      if ((Math.max(...xs) - Math.min(...xs)) * (Math.max(...ys) - Math.min(...ys)) > width * height / 4)
        assert(tones.reduce((sum, tone) => sum + lightness(tone), 0) / tones.length > .18, `${ammoPreset}: a dark hollow in ${tones}`);
    }
  }
  // The microphones of a listening array are all of one size, the far ones as large as the near: seen square on there is
  // nothing nearer or farther.
  const { fills } = painted('sensor', 1, { sensorMode: 'sound' }),
    screens = fills.filter(f => f.style.stops?.includes('#3f4843')).map(f => { const xs = f.polygons.flat().map(p => p[0]); return Math.max(...xs) - Math.min(...xs); });
  assert(screens.length >= 5 && screens.every(w => Math.abs(w - screens[0]) < 1e-6), `${screens}`);
});

test('every word painted on these pieces is Portuguese', () => {
  assert.deepEqual(painted('command', 1).texts, [], 'the command reference has no lettering or simulated status');
  const words = new Set(['FILTRO DE AR', 'MUNIÇÃO', 'ESCUTA', 'CARTUCHOS']), lettering = new Set();
  for (const [kind, scales, options] of PIECES) for (const text of painted(kind, Math.max(...scales.filter(s => s <= 2)), options).texts) lettering.add(text);
  for (const text of lettering) assert(words.has(text) || /^\d+(,\d+)? mm$/.test(text), text);
  for (const word of words) assert(lettering.has(word), `${word} is painted somewhere`);
  assert(lettering.has('12,7 mm') && lettering.has('5,56 mm'), 'the calibres are written the Portuguese way');
});
