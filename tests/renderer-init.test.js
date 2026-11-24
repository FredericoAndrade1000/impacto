import test from 'node:test';
import assert from 'node:assert/strict';
import { Application } from 'pixi.js';
import { Renderer } from '../src/render.ts';

test('an unavailable WebGL renderer stops startup with an actionable error and its original cause', async t => {
  const previous = globalThis.devicePixelRatio, cause = new Error('No available renderer');
  globalThis.devicePixelRatio = 3;
  t.after(() => { if (previous === undefined) delete globalThis.devicePixelRatio; else globalThis.devicePixelRatio = previous; });
  t.mock.method(Application.prototype, 'init', async function (options) {
    assert.deepEqual(options.preference, ['webgl']); assert.equal(options.resolution, 2);
    throw cause;
  });
  const renderer = Object.create(Renderer.prototype);
  renderer.element = { clientWidth: 844, clientHeight: 390 };
  await assert.rejects(renderer.init(), error => error.code === 'WEBGL_UNAVAILABLE' && error.cause === cause && /WebGL.*aceleração gráfica/.test(error.message));
});

test('a missing graphics chunk or another startup failure is not reported as unavailable acceleration', async t => {
  const previous = globalThis.devicePixelRatio;
  globalThis.devicePixelRatio = 1;
  t.after(() => { if (previous === undefined) delete globalThis.devicePixelRatio; else globalThis.devicePixelRatio = previous; });
  let cause;
  t.mock.method(Application.prototype, 'init', async () => { throw cause; });
  for (const [failure, message] of [
    [new TypeError('Failed to fetch dynamically imported module: /node_modules/.vite/deps/browserAll.js'), /arquivos gráficos/],
    [new TypeError('Importing a module script failed.'), /arquivos gráficos/],
    [new Error('Unexpected startup failure'), /iniciar o desenho/],
  ]) {
    cause = failure;
    const renderer = Object.create(Renderer.prototype);
    renderer.element = { clientWidth: 844, clientHeight: 390 };
    await assert.rejects(renderer.init(), error => error.code === 'RENDERER_UNAVAILABLE' && error.cause === cause &&
      message.test(error.message) && !/aceleração/.test(error.message));
  }
});
