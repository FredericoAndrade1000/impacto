// Node-only loader. The browser never imports or bundles the platform addon.
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { rustSourceHash } from './rust-source-hash.ts';
import type { DynamicsHost } from '../src/native-host-contract.ts';
export type { DynamicsHost } from '../src/native-host-contract.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
export type NativeRuntimeInfo = Record<string, unknown> & { runtime: 'native'; binary: string };

const name = `battle_dynamics-${process.platform}-${process.arch}`;
const metadata = new URL(`../native/artifacts/${name}.json`, import.meta.url);
export function nativeRuntimeInfo(mode = process.env.IMPACTO_DYNAMICS_RUNTIME || 'auto'): NativeRuntimeInfo | { runtime: 'wasm' } {
  if (!['auto', 'native', 'wasm'].includes(mode)) throw new Error('IMPACTO_DYNAMICS_RUNTIME deve ser auto, native ou wasm.');
  if (mode === 'wasm' || mode === 'auto' && !existsSync(metadata)) return { runtime: 'wasm' };
  if (!existsSync(metadata)) throw new Error('Compile o núcleo deste host com npm run build:native.');
  const info: unknown = JSON.parse(readFileSync(metadata, 'utf8'));
  if (!record(info)) throw new Error('Nome do núcleo nativo incompatível. Recompile com npm run build:native.');
  const suffix = info.profile === 'preview' ? '-preview' : '';
  if (typeof info.binaryFile !== 'string' || !new RegExp('^' + name + '-[a-f0-9]{16}-[a-f0-9]{12}' + suffix + '\\.node$').test(info.binaryFile))
    throw new Error('Nome do núcleo nativo incompatível. Recompile com npm run build:native.');
  const binary = new URL(`../native/artifacts/${info.binaryFile}`, import.meta.url);
  if (!existsSync(binary)) throw new Error('Compile o núcleo deste host com npm run build:native.');
  if (info.sourceSHA256 !== rustSourceHash(fileURLToPath(new URL('../native/dynamics', import.meta.url))) ||
      info.binarySHA256 !== createHash('sha256').update(readFileSync(binary)).digest('hex') ||
      info.platform !== process.platform || info.arch !== process.arch) {
    throw new Error('Núcleo nativo desatualizado ou incompatível. Recompile com npm run build:native.');
  }
  return { ...info, runtime: 'native', binary: fileURLToPath(binary) };
}

export function loadNativeHost(): NativeRuntimeInfo | { runtime: 'wasm' } {
  const info = nativeRuntimeInfo();
  if (info.runtime === 'wasm') return info;
  const addon: unknown = createRequire(import.meta.url)(info.binary);
  if (!record(addon)) throw new Error('Núcleo nativo inválido. Recompile com npm run build:native.');
  return { ...info, ...addon, runtime: 'native', binary: info.binary };
}

export async function loadDynamicsHost(): Promise<DynamicsHost> {
  const host = loadNativeHost();
  if (host.runtime === 'native') return host;
  const { loadDynamicsHost: loadWasmHost, wasmDynamicsUrl } = await import('../src/wasm-dynamics-host.ts');
  const loaded: unknown = await loadWasmHost(await readFile(wasmDynamicsUrl));
  if (!record(loaded) || loaded.runtime !== 'wasm') throw new Error('Núcleo Wasm inválido. Recompile com npm run build:wasm.');
  return { ...loaded, runtime: 'wasm' };
}
