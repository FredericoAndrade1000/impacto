import test from 'node:test';
import assert from 'node:assert/strict';
import { effectTilePixels, MUZZLE_JET_ROOT, SHOCKWAVE_RING_RADIUS, FLAME_FRAMES, FLAME_VARIANTS, FLAME_ROOT, FLAME_FOOT_RADIUS, FLAME_FOOT_HEIGHT } from '../src/effect-art.ts';
import { createParticleAtlas } from '../src/textures.ts';

const SIZE = 128, alphaAt = (data, x, y) => data[(y * SIZE + x) * 4 + 3];

test('effect frames are deterministic, bounded, and retain transparent gutters for atlas sampling', () => {
  const random = Math.random;
  try {
    Math.random = () => { throw new Error('artwork must use its local seed'); };
    for (const [kind, count] of [['smoke', 8], ['dense-smoke', 4], ['fire', 4], ['flame', FLAME_FRAMES * FLAME_VARIANTS], ['shockwave', 1], ['muzzle', 3], ['flash', 1], ['dust', 1], ['plume', 3], ['jetcore', 1]]) {
      for (let variant = 0; variant < count; variant++) {
        const data = effectTilePixels(kind, variant);
        assert.equal(data.length, SIZE * SIZE * 4); assert(data instanceof Uint8ClampedArray);
        for (let edge = 0; edge < SIZE; edge++) {
          assert.equal(alphaAt(data, edge, 0), 0); assert.equal(alphaAt(data, edge, SIZE - 1), 0);
          assert.equal(alphaAt(data, 0, edge), 0); assert.equal(alphaAt(data, SIZE - 1, edge), 0);
        }
        if (variant === 0) assert.deepEqual(data, effectTilePixels(kind, variant));
        else assert.notDeepEqual(data, effectTilePixels(kind, 0));
      }
    }
  } finally { Math.random = random; }
});

test('smoke preserves gray modulation with translucent rolling folds and soft wisps', () => {
  const pixels = effectTilePixels('smoke', 0), shades = [], alpha = [];
  for (let i = 0; i < pixels.length; i += 4) {
    assert.equal(pixels[i], pixels[i + 1]); assert.equal(pixels[i + 1], pixels[i + 2]);
    if (pixels[i + 3] > 32) shades.push(pixels[i]);
    if (pixels[i + 3] > 1 && pixels[i + 3] < 160) alpha.push(pixels[i + 3]);
  }
  assert(shades.length > 3000); assert(alpha.length > 500, 'smoke needs a soft opacity transition');
  assert(Math.max(...shades) - Math.min(...shades) > 35, 'density folds must remain distinguishable');
  assert(Math.min(...shades) > 100, 'the base artwork must not darken an already dark runtime tint twice');
  assert(Math.max(...Array.from({ length: SIZE * SIZE }, (_, i) => pixels[i * 4 + 3])) < 225,
    'a rolling veil must not become a nearly opaque spherical puff');
});

test('blast fire retains bright folded patches inside an irregular orange body', () => {
  for (let variant = 0; variant < 4; variant++) {
    const pixels = effectTilePixels('fire', variant);
    let hot = 0, orange = 0, visible = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3] > 32) {
      visible++;
      if (pixels[i + 1] > 235 && pixels[i + 2] > 170) hot++;
      if (pixels[i] > 210 && pixels[i + 1] < 200 && pixels[i + 2] < 100) orange++;
    }
    assert(hot > 50 && hot < visible * .35, 'bright patches remain mixed with the coloured body');
    assert(orange > visible * .40, 'the blast needs native orange folds before white runtime modulation');
  }
});

test('dense smoke has a connected shaded core while keeping a soft transparent perimeter',()=>{
  for(let variant=0;variant<4;variant++){
    const pixels=effectTilePixels('dense-smoke',variant),light=effectTilePixels('smoke',variant);
    let dense=0,soft=0,shadeLow=255,shadeHigh=0;
    for(let i=0;i<pixels.length;i+=4){
      if(pixels[i+3]>220){dense++;shadeLow=Math.min(shadeLow,pixels[i]);shadeHigh=Math.max(shadeHigh,pixels[i]);}
      if(pixels[i+3]>4&&pixels[i+3]<150)soft++;
      assert(pixels[i+3]>=light[i+3],'core density preserves the existing wisps');
    }
    assert(dense>500&&soft>500,'substantial interior and feathered edges coexist');
    assert(shadeHigh-shadeLow>25,'dense smoke retains shaded folds');
    for(let y=52;y<76;y++)assert(alphaAt(pixels,64,y)>200,'the central cloud stays connected');
  }
});

test('vertical fire keeps a connected hot root, folded body and cooling tapered tips', () => {
  for (let variant = 0; variant < FLAME_FRAMES * FLAME_VARIANTS; variant++) {
    const pixels = effectTilePixels('flame', variant);
    let hotY = 0, hot = 0, white = 0, visible = 0, first = SIZE, last = 0, left = SIZE, right = 0;
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) {
      const i = (y * SIZE + x) * 4;
      if (pixels[i + 3] > 32) { visible++; first = Math.min(first, y); last = Math.max(last, y); left = Math.min(left, x); right = Math.max(right, x); }
      if (pixels[i + 3] > 64 && pixels[i + 1] > 225 && pixels[i + 2] > 90) { hotY += y; hot++; }
      if (pixels[i + 3] > 64 && pixels[i + 1] > 240 && pixels[i + 2] > 200) white++;
    }
    assert(hot > 4); assert(hotY / hot < 75, 'heat is distributed through the folds below the cooling tips');
    assert(white < visible * .15, 'white patches must not dominate the burning surface');
    assert(right - left > (last - first) * .4 && last - first < 100, 'a flame remains a sheet rather than a needle');
    const rootWidth = Array.from({ length: SIZE }, (_, x) => alphaAt(pixels, x, 24)).filter(a => a > 32).length,
      bodyWidth = Array.from({ length: SIZE }, (_, x) => alphaAt(pixels, x, 60)).filter(a => a > 32).length;
    assert(rootWidth >= 6 && bodyWidth >= 8, 'the fuel bed and rising sheet remain connected and substantial');
    assert(Array.from({length:SIZE},(_,x)=>alphaAt(pixels,x,104)).filter(a=>a>32).length<bodyWidth*.5,'tips taper as they cool');
    for (let y = 24; y < 88; y++) assert(Array.from({ length: SIZE }, (_, x) => alphaAt(pixels, x, y)).some(a => a > 32),
      'a burning sprite must not split into a detached oval root and separate flame');
  }
});

test('the visible flame foot narrows around its contact instead of a flat cut across the sprite',()=>{
  for(let frame=0;frame<FLAME_FRAMES*FLAME_VARIANTS;frame++){
    const pixels=effectTilePixels('flame',frame);let visible=0;
    for(let y=0;y<SIZE;y++)if(Math.abs((y+.5)/SIZE-FLAME_ROOT)<=FLAME_FOOT_HEIGHT)
      for(let x=0;x<SIZE;x++)if(alphaAt(pixels,x,y)>32){
        visible++;assert(Math.abs((x+.5)/SIZE-.5)<=FLAME_FOOT_RADIUS);
      }
    assert(visible>0,'the foot must still meet the component');
  }
});

test('cached flame frames vary their folds and repeat around the same emitter', () => {
  const compare=(a,b)=>Buffer.compare(Buffer.from(effectTilePixels('flame',a)),Buffer.from(effectTilePixels('flame',b)));
  const count=FLAME_FRAMES*FLAME_VARIANTS;
  assert.equal(compare(count,0),0);assert.equal(compare(count+7,7),0);assert.notEqual(compare(4,0),0);
  for(let family=0;family<FLAME_VARIANTS;family++){
    const frames=Array.from({length:FLAME_FRAMES},(_,i)=>effectTilePixels('flame',family*FLAME_FRAMES+i)),
      difference=(a,b)=>a.reduce((sum,value,i)=>sum+(i%4===3?Math.abs(value-b[i]):0),0),
      adjacent=frames.map((pixels,i)=>difference(pixels,frames[(i+1)%frames.length])),
      apart=frames.map((pixels,i)=>difference(pixels,frames[(i+frames.length/2)%frames.length]));
    assert(adjacent.at(-1)<=Math.max(...adjacent.slice(0,-1))*1.15,'wrapping must not introduce an abrupt shape change');
    assert(adjacent.reduce((a,b)=>a+b)<apart.reduce((a,b)=>a+b),'nearby frames retain coherent shapes');
  }
});

test('the pressure front is a faint subpixel-feathered irregular ring with a transparent centre', () => {
  const pixels = effectTilePixels('shockwave'), count = [], halo = [];
  assert.equal(alphaAt(pixels, 64, 64), 0);
  for (let i = 3; i < pixels.length; i += 4) {
    if (pixels[i] >= 24) count.push(pixels[i]);
    if (pixels[i] >= 8) halo.push(pixels[i]);
  }
  assert(count.length > 550 && count.length < 800);
  assert(halo.length < 1100, 'the feather must not spread into a broad enlarged halo');
  assert(Math.max(...count) < 128, 'the cached front must remain faint before runtime modulation');
  const sample = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    return (alphaAt(pixels, ix, iy) * (1 - fx) + alphaAt(pixels, ix + 1, iy) * fx) * (1 - fy) +
      (alphaAt(pixels, ix, iy + 1) * (1 - fx) + alphaAt(pixels, ix + 1, iy + 1) * fx) * fy;
  }, peaks = [], widths = [];
  for (let ray = 0; ray < 96; ray++) {
    const angle = ray * Math.PI * 2 / 96, profile = [];
    let peak = 0, peakRadius = 0;
    for (let radius = 46; radius <= 57; radius += .125) {
      const value = sample(63.5 + Math.cos(angle) * radius, 63.5 + Math.sin(angle) * radius);
      profile.push(value);
      if (value > peak) { peak = value; peakRadius = radius; }
    }
    assert(peak > 45, 'small corrugations must retain a coherent pressure front');
    peaks.push(peakRadius); widths.push(profile.filter(value => value >= peak * .5).length * .125);
  }
  const variation = Math.max(...peaks) - Math.min(...peaks), average = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  assert(variation > .8 && variation < 2.6, 'the border needs restrained irregularities instead of a perfect circle');
  assert(Math.abs(average - SHOCKWAVE_RING_RADIUS * SIZE / 2) < .5, 'optical geometry must use the actual artwork radius');
  assert(Math.max(...widths) < 2.4, 'even oblique sampling must retain a thin antialiased border');
});

test('the muzzle jet is born white at the bore and cools along one tapering tongue', () => {
  for (let variant = 0; variant < 3; variant++) {
    const pixels = effectTilePixels('muzzle', variant), root = Math.round(MUZZLE_JET_ROOT * SIZE),
      width = x => Array.from({ length: SIZE }, (_, y) => alphaAt(pixels, x, y)).filter(a => a > 32).length,
      warmth = x => { const i = (64 * SIZE + x) * 4; return pixels[i] - pixels[i + 2]; };
    for (let x = 0; x < root - 2; x++) assert.equal(width(x), 0, 'nothing is drawn behind the muzzle');
    assert(width(root + 6) > 0 && width(root + 6) < width(40), 'the flame opens up as it leaves the bore');
    assert(width(40) > width(100) && width(100) > 0, 'and narrows again towards its tip');
    for (let x = root + 6; x < 100; x++) assert(alphaAt(pixels, x, 64) > 150, 'the axis stays one connected, nearly opaque tongue');
    const hot = (64 * SIZE + root + 6) * 4;
    assert(pixels[hot] > 250 && pixels[hot + 1] > 235 && pixels[hot + 2] > 150, 'burning propellant is white where it is born');
    assert(warmth(100) > warmth(root + 6) + 60, 'and has cooled to orange by the tip');
    assert(Math.max(...Array.from({ length: SIZE }, (_, y) => alphaAt(pixels, 124, y))) === 0, 'the tip ends inside the frame');
  }
});

test('the detonation flash is a white burst with a saturated core and uneven spikes', () => {
  const pixels = effectTilePixels('flash'), reach = [];
  for (let i = 0; i < pixels.length; i += 4) if (pixels[i + 3]) assert(pixels[i] === 255 && pixels[i + 1] === 255 && pixels[i + 2] === 255, 'tinted only at run time');
  assert(alphaAt(pixels, 64, 64) > 250);
  for (let ray = 0; ray < 180; ray++) {
    const angle = ray * Math.PI / 90; let radius = 0;
    while (radius < 62 && alphaAt(pixels, Math.round(63.5 + Math.cos(angle) * radius), Math.round(63.5 + Math.sin(angle) * radius)) > 96) radius++;
    reach.push(radius);
  }
  assert(Math.min(...reach) > 8 && Math.min(...reach) < 22, 'between the spikes only the small core is bright');
  assert(Math.max(...reach) > 40, 'the longest spikes carry the light well beyond the core');
  const spikes = reach.filter((value, i) => value > 26 && value >= reach[(i + 179) % 180] && value > reach[(i + 1) % 180]).length;
  assert(spikes >= 3 && spikes <= 11, 'a few distinct spikes, not a disc or a regular star');
});

test('all effect frames share one bounded source and retain the original utility frame locations', t => {
  const painted = [], imported = [], picture = { width:512,height:1024 }, oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document'),
    oldCanvas = Object.getOwnPropertyDescriptor(globalThis, 'HTMLCanvasElement');
  let canvases = 0;
  class Canvas {
    width = 1; height = 1;
    getContext() {
      if (this.context) return this.context;
      const gradient = () => ({ addColorStop() {} }), ctx = { createRadialGradient: gradient, createLinearGradient: gradient,
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
        putImageData(image, x, y) { painted.push({ x, y, data: image.data }); },
        drawImage(...args) { imported.push(args); } };
      for (const method of ['save', 'restore', 'translate', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'closePath', 'fill']) ctx[method] = () => {};
      return this.context = ctx;
    }
  }
  Object.defineProperty(globalThis, 'HTMLCanvasElement', { configurable: true, writable: true, value: Canvas });
  Object.defineProperty(globalThis, 'document', { configurable: true, writable: true, value: {
    createElement(kind) { assert.equal(kind, 'canvas'); canvases++; return new Canvas(); },
  } });
  let textures = [], source;
  t.after(() => {
    for (const texture of textures) texture.destroy(); source?.destroy();
    if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else delete globalThis.document;
    if (oldCanvas) Object.defineProperty(globalThis, 'HTMLCanvasElement', oldCanvas); else delete globalThis.HTMLCanvasElement;
  });
  const atlas = createParticleAtlas(picture);
  textures = [...atlas.smoke, ...atlas.denseSmoke, ...atlas.fire, ...atlas.flame, atlas.shockwave, atlas.glow, atlas.spark, atlas.dust, ...atlas.jet, atlas.flash,
    ...atlas.plume, atlas.jetcore];
  source = atlas.glow.source;
  assert.equal(canvases, 1); assert.equal(source.pixelWidth, 512); assert(source.pixelWidth*source.pixelHeight*4<=4*1024*1024,'the complete uncompressed effect atlas stays below 4 MiB');
  assert.equal(textures.length, 92); assert.equal(atlas.smoke.length, 8); assert.equal(atlas.denseSmoke.length,4); assert.equal(atlas.fire.length, 4); assert.equal(atlas.flame.length, 64);
  assert.equal(atlas.jet.length, 3); assert.equal(atlas.jet[0], atlas.muzzle, 'the first jet keeps the old muzzle frame');
  assert.equal(atlas.plume.length, 3);
  assert(textures.every(texture => texture.source === source && texture.height === SIZE));
  assert(atlas.flame.every(texture=>texture.width===SIZE/2));
  for (const texture of [...atlas.smoke, ...atlas.denseSmoke]) {
    const trim = texture.trim;
    assert(trim && trim.width * trim.height < SIZE * SIZE * .81, 'smoke geometry omits its transparent margins');
    assert.deepEqual([texture.orig.width, texture.orig.height], [SIZE, SIZE], 'world size and centred anchors stay unchanged');
    const x = Math.floor(texture.frame.x / SIZE) * SIZE, y = Math.floor(texture.frame.y / SIZE) * SIZE,
      image = painted.find(image => image.x === x && image.y === y);
    assert(image);
    assert.deepEqual([texture.frame.x - x, texture.frame.y - y, texture.frame.width, texture.frame.height],
      [trim.x, trim.y, trim.width, trim.height]);
    for (let row = 0; row < SIZE; row++) for (let col = 0; col < SIZE; col++) if (alphaAt(image.data, col, row))
      assert(col > trim.x && col < trim.right - 1 && row > trim.y && row < trim.bottom - 1,
        'every visible texel and a transparent sampling gutter survive trimming');
  }
  assert.equal(new Set(textures.map(texture => `${texture.frame.x}:${texture.frame.y}`)).size, textures.length);
  assert.deepEqual([atlas.glow, atlas.spark, atlas.dust, atlas.muzzle].map(texture => [texture.frame.x, texture.frame.y]),
    [[0, 384], [128, 384], [256, 384], [384, 384]]);
  assert.equal(atlas.shockwave.frame.y, 640); assert.equal(painted.length, textures.length-2-64);
  assert.equal(imported.length,64);assert(imported.every(args=>args[0]===picture));
  assert.equal(new Set(imported.map(args=>args[1]+':'+args[2])).size,64,'every original frame is packed once into the shared atlas');
  assert.deepEqual(imported.map(args=>args.slice(5,7)),atlas.flame.map(texture=>[texture.frame.x,texture.frame.y]));
  assert.deepEqual([atlas.flash, ...atlas.jet.slice(1)].map(texture => [texture.frame.x, texture.frame.y]), [[128, 640], [256, 640], [384, 640]]);
  for (let frame = 0; frame < 1000; frame++) assert.equal(atlas.flame[frame % atlas.flame.length].source, source);
  assert.equal(canvases, 1); assert.equal(painted.length, textures.length-2-64);assert.equal(imported.length,64);
});
