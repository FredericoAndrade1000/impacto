import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePacket, pack, placeArrays } from '../src/network-codec.ts';
import type { BinaryWords } from '../src/network-codec.ts';

test('binary framing retains nested word kinds and full-width coordinates through a sliced transport buffer', () => {
  const original = { name: 'Ferro {0}', nested: [new Float32Array([.5, -2]), { ids: new Uint32Array([0, 0xffffffff]) }],
    rounds: new Float64Array([12345678.123456789, -0]), empty: new Float64Array() }, arrays: BinaryWords[] = [],
    bytes = new Uint8Array(pack(JSON.stringify(original, placeArrays(arrays)), arrays)), transport = new Uint8Array(bytes.length + 9);
  transport.set(bytes, 5);
  assert.deepEqual(decodePacket(transport.subarray(5, 5 + bytes.length)), original);
});

test('the existing framing marker, little-endian header length and four-byte padding stay byte-compatible', () => {
  const bytes = new Uint8Array(pack('{}', [new Float32Array([1])]));
  assert.deepEqual([...bytes], [0x49, 0x4d, 0x32, 0x01, 2, 0, 0, 0, 123, 125, 0, 0, 0, 0, 128, 63]);
});

test('malformed binary references cannot request unsupported, fractional or out-of-buffer words', () => {
  for (const reference of [{ $array: 'u8', length: 1 }, { $array: 'f64', length: -1 }, { $array: 'f32', length: 1.5 },
    { $array: 'u32', length: '2' }, { $array: 'f64', length: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => decodePacket(pack(JSON.stringify({ geometry: reference }), [])), /Geometria de rede inválida/);
  }
  assert.throws(() => decodePacket(pack('{"geometry":{"$array":"f64","length":2}}', [new Float64Array([1])])), /Geometria de rede inválida/);
});

test('an incomplete header or non-packet JSON is refused at the codec boundary', () => {
  assert.throws(() => decodePacket(new ArrayBuffer(7)), /Estado de rede incompleto/);
  const corrupt = pack('{}', []); new DataView(corrupt).setUint32(4, 8_000_001, true);
  assert.throws(() => decodePacket(corrupt), /Protocolo de rede inválido/);
  for (const json of ['null', '3', '[]']) assert.throws(() => decodePacket(pack(json, [])), /Protocolo de rede inválido/);
});
