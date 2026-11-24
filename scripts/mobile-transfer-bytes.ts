// CPU -> WebGL boundary bytes only. Allocations, mipmaps and shader memory traffic are different costs.
import { record } from './operational-input.ts';
export function webglUploadBytes(name: string, args: readonly unknown[]): number {
  const viewBytes = (source: unknown, offset: unknown = 0, length: unknown = 0): number => {
    if (!record(source)) return 0;
    const unit = typeof source.BYTES_PER_ELEMENT === 'number' && source.BYTES_PER_ELEMENT || 1,
      available = (typeof source.byteLength === 'number' ? source.byteLength : 0) / unit - (typeof offset === 'number' ? offset : 0);
    return Math.max(0, Math.min(available, typeof length === 'number' && length || available)) * unit;
  };
  if (name === 'bufferData') return viewBytes(args[1], args[3], args[4]);
  if (name === 'bufferSubData') return viewBytes(args[2], args[3], args[4]);
  if (name.startsWith('compressedTex')) {
    const index = name === 'compressedTexImage2D' ? 6 : 7;
    return viewBytes(args[index], args[index + 1], args[index + 2]);
  }
  if (name !== 'texImage2D' && name !== 'texSubImage2D') throw Error('Transferência WebGL não reconhecida: ' + name);
  const image = name === 'texImage2D', short = args.length === (image ? 6 : 7), source = args[short ? (image ? 5 : 6) : 8];
  if (!record(source)) return 0;
  const width = short ? source.width : args[image ? 3 : 4], height = short ? source.height : args[image ? 4 : 5],
    format = args[short ? (image ? 3 : 4) : 6], type = args[short ? (image ? 4 : 5) : 7],
    channels: Record<number, number> = { 6408:4, 6407:3, 6403:1, 33319:2, 6409:1, 6410:2, 6406:1 },
    packed: Record<number, number> = { 32819:2, 32820:2, 33635:2, 34042:4, 33640:4 },
    units: Record<number, number> = { 5120:1, 5121:1, 5122:2, 5123:2, 5124:4, 5125:4, 5126:4, 5131:2, 36193:2 };
  if (typeof width !== 'number' || !Number.isFinite(width) || typeof height !== 'number' || !Number.isFinite(height) || typeof format !== 'number' || typeof type !== 'number')
    throw Error('Formato de textura não coberto pelo contador de transferências.');
  const packedBytes = packed[type], channelCount = channels[format], unit = units[type];
  if (packedBytes) return width * height * packedBytes;
  if (!channelCount || !unit) throw Error('Formato de textura não coberto pelo contador de transferências.');
  return width * height * channelCount * unit;
}
