// A bounded JSON header followed by the typed words it names, in traversal order.
// This codec owns binary framing; packet meaning belongs to network-protocol.
export type BinaryWords = Float32Array | Uint32Array | Float64Array;
export type WordKind = 'f32' | 'u32' | 'f64';
export interface BinaryReference { $array: WordKind; length: number }
type WordConstructor = Float32ArrayConstructor | Uint32ArrayConstructor | Float64ArrayConstructor;
const MAGIC = 0x494d3201, MAX_HEADER = 8_000_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();

const isWords = (value: unknown): value is BinaryWords => value instanceof Float32Array || value instanceof Uint32Array || value instanceof Float64Array;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const list = (value: unknown): value is unknown[] => Array.isArray(value);
function wordType(kind: unknown): WordConstructor | null {
  switch (kind) {
    case 'f32': return Float32Array;
    case 'u32': return Uint32Array;
    case 'f64': return Float64Array;
    default: return null;
  }
}
export function placeWords(arrays: BinaryWords[], value: BinaryWords): BinaryReference {
  const kind = value instanceof Float32Array ? 'f32' : value instanceof Uint32Array ? 'u32' : value instanceof Float64Array ? 'f64' : null;
  if (!kind) throw new TypeError('Tipo de geometria de rede inválido.');
  arrays.push(value);
  return { $array: kind, length: value.length };
}
export const placeArrays = (arrays: BinaryWords[]) => (_key: string, value: unknown): unknown => isWords(value) ? placeWords(arrays, value) : value;

export function pack(json: string, arrays: readonly BinaryWords[]): ArrayBuffer {
  const header = encoder.encode(json), offset = 8 + Math.ceil(header.length / 4) * 4,
    result = new ArrayBuffer(offset + arrays.reduce((sum, words) => sum + words.byteLength, 0)), view = new DataView(result);
  view.setUint32(0, MAGIC);
  view.setUint32(4, header.length, true);
  new Uint8Array(result, 8, header.length).set(header);
  let at = offset;
  for (const words of arrays) {
    new Uint8Array(result, at, words.byteLength).set(new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
    at += words.byteLength;
  }
  return result;
}

export function decodePacket(input: ArrayBuffer | ArrayBufferView): Record<string, unknown> {
  const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (bytes.byteLength < 8) throw new Error('Estado de rede incompleto.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), length = view.getUint32(4, true);
  if (view.getUint32(0) !== MAGIC || length > bytes.length - 8 || length > MAX_HEADER) throw new Error('Protocolo de rede inválido.');
  const metadata: unknown = JSON.parse(decoder.decode(bytes.subarray(8, 8 + length)));
  let at = 8 + Math.ceil(length / 4) * 4;
  function restore(value: unknown): unknown {
    if (list(value)) {
      for (let index = 0; index < value.length; index++) value[index] = restore(value[index]);
    } else if (record(value)) {
      if ('$array' in value) {
        const kind = wordType(value.$array), count = value.length;
        if (!kind || typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count * kind.BYTES_PER_ELEMENT > bytes.length - at)
          throw new Error('Geometria de rede inválida.');
        const size = count * kind.BYTES_PER_ELEMENT, words = new kind(bytes.slice(at, at + size).buffer);
        at += size;
        return words;
      }
      for (const key of Object.keys(value)) value[key] = restore(value[key]);
    }
    return value;
  }
  const packet = restore(metadata);
  if (!record(packet)) throw new Error('Protocolo de rede inválido.');
  return packet;
}
