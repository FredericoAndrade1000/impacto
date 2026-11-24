import test from 'node:test';
import assert from 'node:assert/strict';
import { webglUploadBytes as bytes } from '../scripts/mobile-transfer-bytes.ts';

test('buffer uploads count the submitted range rather than the capacity or uninitialized allocation', () => {
  const buffer = new Float32Array(1000);
  assert.equal(bytes('bufferData',[34962,1000000,35048]),0);
  assert.equal(bytes('bufferSubData',[34962,0,buffer,20,30]),120);
  assert.equal(bytes('bufferData',[34962,buffer,35048,20,0]),980*4);
});

test('texture uploads use the actual rectangle, format and source range, without counting GPU allocations twice', () => {
  const source={width:20,height:10}, storage=new Uint8Array(10000);
  assert.equal(bytes('texImage2D',[3553,0,6408,6408,5121,source]),800);
  assert.equal(bytes('texSubImage2D',[3553,0,0,0,4,3,6408,5121,storage]),48);
  assert.equal(bytes('texImage2D',[3553,0,33319,4,3,0,33319,5131,storage]),48);
  assert.equal(bytes('texImage2D',[3553,0,6408,20,10,0,6408,5121,null]),0);
  assert.equal(bytes('compressedTexImage2D',[3553,0,33777,16,16,0,storage,100,256]),256);
  assert.throws(()=>bytes('texImage2D',[3553,0,6408,20,10,0,99999,5121,storage]),/Formato/);
});
