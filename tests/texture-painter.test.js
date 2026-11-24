import test from 'node:test';
import assert from 'node:assert/strict';
import { TexturePainter } from '../src/texture-painter.ts';
import { chassisArtwork, chassisLayout } from '../src/chassis-art.ts';

function browser(t, copy) {
  const workers = [], images = [], originals = Object.getOwnPropertyDescriptors(globalThis),
    names = ['Worker', 'OffscreenCanvas', 'createImageBitmap'];
  class Worker {
    constructor(url, options) { this.url = url; this.options = options; this.messages = []; this.terminated = false; workers.push(this); }
    postMessage(data, transfer = []) { this.messages.push({ data: structuredClone(data), transfer: [...transfer] }); }
    terminate() { this.terminated = true; }
    answer(data) { this.onmessage({ data }); }
  }
  class Bitmap {
    constructor(source) { this.source = source; this.closes = 0; }
    close() { this.closes++; }
  }
  const bitmap = source => { const image = new Bitmap(source); images.push(image); return image; };
  for (const [name, value] of Object.entries({ Worker, OffscreenCanvas: class {}, createImageBitmap: copy || (async source => bitmap(source)) }))
    Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  t.after(() => { for (const name of names) if (originals[name]) Object.defineProperty(globalThis, name, originals[name]); else delete globalThis[name]; });
  const materials = { frameSurface: new Float32Array([.25, .5]), hullSurfaces: { outside: new Float32Array([.75]), concrete: new Float32Array([1]) },
    wheelSurface: new Float32Array([.3125, .6875]),
    trackSurfaces: { steel: new Float32Array([.125, .875]), rubber: new Float32Array([.375, .625]) },
    radarSurface: new Float32Array([.1875, .8125]),
    weathering: Object.fromEntries(['scuffs', 'oxide', 'earth', 'oil'].map(name => [name, { name }])) };
  return { workers, images, materials, bitmap };
}

const request = () => ({ type: 'module', kind: 'hopper', width: 2.4, height: .7, options: {
  paint: 0x65735b, side: 'outside', cargoLevel: 2, cargoMaterial: 'ferro', metal: 'steel', seat: '',
  arches: [{ x: .2, y: -.1, r: .3, half: .2 }] } });

// Let the four asynchronous setup copies finish without a clock, worker or canvas.
async function initialized() { for (let i = 0; i < 6; i++) await Promise.resolve(); }

test('one worker paints one immutable description at a time and prepares its materials only once', async t => {
  const { workers, images, materials } = browser(t), painter = new TexturePainter(materials), original = request();
  t.after(() => painter.destroy());
  assert.equal(painter.available, true); assert.equal(painter.busy, false); assert.equal(workers.length, 0);
  Object.assign(original.options, { tint: '#71806b', overlay: false });
  const first = painter.paint(original);
  original.options.paint = 0; original.options.arches[0].x = 900;
  assert.equal(painter.busy, true); assert.equal(await painter.paint(request()), null, 'no queued second job');
  await initialized();
  const worker = workers[0], [setup, painting] = worker.messages;
  assert.deepEqual(worker.options, { type: 'module' }); assert.match(worker.url.pathname, /texture-painter-worker\.ts$/);
  assert.deepEqual(worker.messages.map(message => message.data.type), ['init', 'paint']);
  assert.equal(images.length, 4); assert.deepEqual(setup.transfer, images);
  assert.deepEqual(setup.data.frameSurface, materials.frameSurface); assert.equal(materials.frameSurface.length, 2, 'main grain remains usable');
  assert.deepEqual(setup.data.hullSurfaces, materials.hullSurfaces);
  assert.deepEqual(setup.data.wheelSurface, materials.wheelSurface);
  assert.notEqual(setup.data.wheelSurface.buffer, materials.wheelSurface.buffer, 'the worker owns a clone while the main fallback retains its tyre grain');
  assert.deepEqual([...materials.wheelSurface], [.3125, .6875]);
  assert.deepEqual(setup.data.trackSurfaces, materials.trackSurfaces);
  assert.notEqual(setup.data.trackSurfaces.steel.buffer, materials.trackSurfaces.steel.buffer, 'the worker owns a clone, not the main fallback grain');
  assert.deepEqual([...materials.trackSurfaces.steel, ...materials.trackSurfaces.rubber], [.125, .875, .375, .625]);
  assert.deepEqual(setup.data.radarSurface, materials.radarSurface);
  assert.notEqual(setup.data.radarSurface.buffer, materials.radarSurface.buffer, 'the worker owns a clone while the main fallback retains its radar grain');
  assert.deepEqual([...materials.radarSurface], [.1875, .8125]);
  assert.equal(painting.data.request.options.paint, 0x65735b); assert.equal(painting.data.request.options.arches[0].x, .2);
  assert.equal(painting.data.request.options.tint, '#71806b'); assert.equal(painting.data.request.options.overlay, false);
  const result = { close() { throw Error('the caller owns a successful bitmap'); } };
  worker.answer({ type: 'painted', bitmap: result }); assert.equal(await first, result); assert.equal(painter.busy, false);
  const next = request(), second = painter.paint(next);
  next.options.paint = 0; next.options.arches[0].x = 900;
  assert.equal(worker.messages.length, 3); assert.equal(images.length, 4);
  assert.equal(worker.messages[2].data.request.options.paint, 0x65735b);
  assert.equal(worker.messages[2].data.request.options.arches[0].x, .2);
  assert(!('radarSurface' in painting.data.request) && !('radarSurface' in worker.messages[2].data.request), 'the radar grain belongs to the one setup, not each paint request');
  assert(!('wheelSurface' in painting.data.request) && !('wheelSurface' in worker.messages[2].data.request), 'the tyre grain belongs to the one setup, not each paint request');
  worker.answer({ type: 'painted', bitmap: result }); assert.equal(await second, result);
  assert.equal(workers.length, 1); assert.equal(worker.messages.filter(message => message.data.type === 'init').length, 1);
});

test('chassis and mudguard descriptions share the painter materials and snapshot their real nested geometry', async t => {
  const { workers, materials } = browser(t), painter = new TexturePainter(materials),
    // A chassis with a knee, along its points and their outline.
    profile = [{ x: 0, y: 0 }, { x: 3, y: 0 }, { x: 3.4, y: .2 }, { x: 6, y: .2 }],
    outlines = [[...profile, { x: 6, y: -.1 }, { x: 3.4708, y: -.1 }, { x: 3.0708, y: -.3 }, { x: 0, y: -.3 }]],
    layout = chassisLayout('wheeled', { length: 6, profile, outlines, depth: .3, axles: [1, 2.2], metal: 'aluminum' }),
    descriptions = [{ type: 'chassis', shape: chassisArtwork(layout, 0x65735b), options: { paint: 0x65735b } },
      { type: 'guard', shape: layout.guards[0], options: { paint: 0x65735b, metal: layout.metal } }];
  t.after(() => painter.destroy());
  for (const original of descriptions) {
    const expected = structuredClone(original), result = painter.paint(original);
    original.options.paint = 0;
    if (original.type === 'chassis') original.shape.layout.outlines[0][0].x = 900;
    else original.shape.feet[0] = 900;
    await initialized();
    const worker = workers[0]; assert.deepEqual(worker.messages.at(-1).data.request, expected);
    const picture = { close() { throw Error('the caller owns the bitmap'); } };
    worker.answer({ type: 'painted', bitmap: picture }); assert.equal(await result, picture);
  }
  assert.equal(workers.length, 1); assert.deepEqual(workers[0].messages[0].data.frameSurface, materials.frameSurface);
});

test('destroy settles a painting, terminates its worker and closes a late transferred result', async t => {
  const { workers, materials, bitmap } = browser(t), painter = new TexturePainter(materials), pending = painter.paint(request());
  await initialized(); const worker = workers[0];
  painter.destroy(); assert.equal(await pending, null); assert.equal(painter.available, false); assert.equal(painter.busy, false);
  assert.equal(worker.terminated, true);
  const late = bitmap('late result'); worker.answer({ type: 'painted', bitmap: late }); assert.equal(late.closes, 1);
  assert.equal(await painter.paint(request()), null); assert.equal(workers.length, 1);
});

test('destroy during setup closes owned copies and a copy that arrives later', async t => {
  let finishCopy;
  const { workers, images, materials, bitmap } = browser(t, async source => source.name === 'oxide'
    ? new Promise(resolve => { finishCopy = resolve; }) : bitmap(source));
  const painter = new TexturePainter(materials), pending = painter.paint(request());
  await initialized(); assert.equal(images.length, 1);
  painter.destroy(); assert.equal(await pending, null); assert.equal(images[0].closes, 1);
  const late = bitmap('oxide'); finishCopy(late); await initialized();
  assert.equal(late.closes, 1); assert.equal(workers[0].messages.length, 0, 'no init or paint is sent after destruction');
});

test('setup and worker errors disable painting without retaining requests or bitmaps', async t => {
  const { workers, images, materials } = browser(t), painter = new TexturePainter(materials);
  t.after(() => painter.destroy());
  const pending = painter.paint(request()); await initialized();
  workers[0].answer({ type: 'error', message: 'painting failed' });
  assert.equal(await pending, null); assert.equal(painter.available, false); assert.equal(workers[0].terminated, true);
  assert.equal(await painter.paint(request()), null); assert.equal(images.length, 4);
});

test('a failed setup copy closes earlier copies and an unsupported host never starts a worker', async t => {
  let copies = 0;
  const { workers, images, materials, bitmap } = browser(t, async source => {
    if (++copies === 2) throw Error('cannot copy');
    return bitmap(source);
  });
  const painter = new TexturePainter(materials); assert.equal(await painter.paint(request()), null);
  assert.equal(images[0].closes, 1); assert.equal(painter.available, false); assert.equal(workers[0].terminated, true);
  globalThis.OffscreenCanvas = undefined;
  const unsupported = new TexturePainter(materials);
  assert.equal(unsupported.available, false); assert.equal(await unsupported.paint(request()), null); assert.equal(workers.length, 1);
});

test('a failed initialization transfer closes all four copies and settles the only request', async t => {
  const { workers, images, materials } = browser(t), painter = new TexturePainter(materials), pending = painter.paint(request());
  t.mock.method(workers[0], 'postMessage', () => { throw Error('cannot transfer'); });
  assert.equal(await pending, null); assert.equal(painter.available, false); assert.equal(painter.busy, false);
  assert.equal(images.length, 4); assert(images.every(image => image.closes === 1)); assert.equal(workers[0].terminated, true);
});
