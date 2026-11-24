import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {paintSurface, paintTrackSurface} from '../src/textures.ts';

test('surface wear preserves transparent openings and antialiased edges while retaining material colors', () => {
  const pixels=new Uint8ClampedArray([83,91,79,0, 100,80,60,96, 40,60,80,255]),before=pixels.slice();
  const ctx={canvas:{width:3,height:1},getImageData:()=>({data:pixels}),putImageData(image){assert.equal(image.data,pixels);}};
  paintSurface(ctx,new Float32Array([1.3,.5,1.25]));
  assert.deepEqual(pixels.slice(0,4),before.slice(0,4),'No image detail can create a rim hole or change its transparency.');
  assert.deepEqual(pixels.slice(4,8),new Uint8ClampedArray([50,40,30,96]),'The edge keeps its exact alpha and material hue.');
  assert.deepEqual(pixels.slice(8),new Uint8ClampedArray([50,75,100,255]),'The grain varies brightness without replacing the material.');
});

test('one shared finish adapts to a different cached component canvas without changing alpha', () => {
  const pixels=new Uint8ClampedArray(4*2*4),shades=new Float32Array([.5,1.25]);
  for(let i=0;i<pixels.length;i+=4)pixels.set([80,100,120,i%3?255:96],i);
  const alpha=pixels.filter((_,i)=>i%4===3),ctx={canvas:{width:4,height:2},getImageData:()=>({data:pixels}),putImageData(){}};
  paintSurface(ctx,shades,2);
  for(const at of [0,4,16,20])assert.deepEqual(pixels.slice(at,at+3),new Uint8ClampedArray([40,50,60]));
  for(const at of [8,12,24,28])assert.deepEqual(pixels.slice(at,at+3),new Uint8ClampedArray([100,125,150]));
  assert.deepEqual(pixels.filter((_,i)=>i%4===3),alpha);
  assert.deepEqual(shades,new Float32Array([.5,1.25]));
});

test('track surface separates a road wheel rubber band from its rim and preserves alpha', () => {
  const pixels = new Uint8ClampedArray(4 * 4 * 4);
  for (let i = 0; i < pixels.length; i += 4) pixels.set([80, 100, 120, i === 0 ? 0 : 176], i);
  const before = pixels.slice(), ctx = { canvas: {width:4,height:4}, getImageData:()=>({data:pixels}), putImageData(){} };
  paintTrackSurface(ctx, {steel:new Float32Array([.5]),rubber:new Float32Array([1.25])}, 'road');
  assert.deepEqual(pixels.slice(0,4), before.slice(0,4));
  assert.deepEqual(pixels.slice(4*5,4*5+4), new Uint8ClampedArray([40,50,60,176]), 'inner dish uses steel');
  assert.deepEqual(pixels.slice(4*3,4*3+4), new Uint8ClampedArray([100,125,150,176]), 'outer band uses rubber');
  assert.deepEqual(pixels.filter((_,i)=>i%4===3), before.filter((_,i)=>i%4===3));
});

test('track finishes preserve their pixels across physical repeats and every material mask', () => {
  const surfaces = { steel: new Float32Array([.5, .73, 1.25, .81, 1.09, 1.4, .9, 1, 1.1]),
    rubber: new Float32Array([1.3, 1, .6, .71, .94, 1.1, 1.5, .55, .8]) }, original = structuredClone(surfaces);
  // Full RGBA results from the original painter. The shoe is steel throughout, as
  // the sprocket and the idler are, the road wheel rubber out from its dish, while
  // the physical track repeats the small maps many times.
  for (const [style, width, height, widthM, heightM, expected] of [
    ['track', 37, 23, 1.7, .41, '664a8367503649e4c82636be31733df358ecc2782d40e6787075abffca4c7ed8'],
    ['road', 37, 33, 1, 1, '4ca90e509bd16aaadd6100c8f476e458cd1d690624a3139591fa4911000205f8'],
    ['shoe', 20, 208, 1, 1, '779b118b35eecade07aae863c5ea045854c20c6c3fea11c59a72782b1f46453e'],
    ['sprocket', 17, 11, 1, 1, '5cea8ec6fbfec93e6861664ea53bb24e432bd946df5970b262cd27a424c95600'],
    ['idler', 17, 11, 1, 1, '5cea8ec6fbfec93e6861664ea53bb24e432bd946df5970b262cd27a424c95600'],
  ]) {
    const pixels = Uint8ClampedArray.from({ length: width * height * 4 }, (_, i) => (i * 37 + (i >> 4)) % 256),
      ctx = { canvas: { width, height }, getImageData: () => ({ data: pixels }), putImageData() {} };
    paintTrackSurface(ctx, surfaces, style, widthM, heightM);
    assert.equal(createHash('sha256').update(pixels).digest('hex'), expected, style);
  }
  assert.deepEqual(surfaces, original);
});
