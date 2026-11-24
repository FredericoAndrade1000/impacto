import { createHash } from 'node:crypto';
import type { BinaryLike } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export const sha256 = (bytes: BinaryLike): string => createHash('sha256').update(bytes).digest('hex');
const normalized = (file: string): string => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');

export interface BuildDescription {
  sourceSHA256: string;
  profile: 'release' | 'preview';
  target: string;
  rustc: string;
}
export interface BuildMetadata extends BuildDescription, Record<string, unknown> {
  buildSHA256: string;
  binarySHA256: string;
  bytes: number;
}
function buildMetadata(value: unknown): value is BuildMetadata {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    'sourceSHA256' in value && typeof value.sourceSHA256 === 'string' &&
    'profile' in value && (value.profile === 'release' || value.profile === 'preview') &&
    'target' in value && typeof value.target === 'string' &&
    'rustc' in value && typeof value.rustc === 'string' && Boolean(value.rustc) &&
    'buildSHA256' in value && typeof value.buildSHA256 === 'string' &&
    'binarySHA256' in value && typeof value.binarySHA256 === 'string' &&
    'bytes' in value && typeof value.bytes === 'number';
}

// Published outputs remain useful even when Cargo's target/ cache is absent.
// Source, recipe and compiler inputs all participate; UI/assets do not.
export function buildRecipe(root: string, description: BuildDescription): string {
  const hash = createHash('sha256').update(JSON.stringify(description));
  for (const file of ['scripts/build-dynamics.ts', 'scripts/build-artifacts.ts', 'scripts/rust-source-hash.ts'])
    hash.update(file).update('\0').update(normalized(join(root, file))).update('\0');
  const configs = new Set<string>();
  for (let folder = root; ; folder = dirname(folder)) {
    for (const file of ['config', 'config.toml']) configs.add(join(folder, '.cargo', file));
    if (dirname(folder) === folder) break;
  }
  for (const file of ['config', 'config.toml']) configs.add(join(process.env.CARGO_HOME || join(homedir(), '.cargo'), file));
  for (const file of ['rust-toolchain', 'rust-toolchain.toml']) configs.add(join(root, file));
  for (const file of configs) if (existsSync(file))
    hash.update(relative(root, file).replaceAll('\\', '/')).update('\0').update(normalized(file)).update('\0');
  const environment = Object.entries(process.env).map(([key, value]): [string, string | undefined] => [process.platform === 'win32' ? key.toUpperCase() : key, value])
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  for (const [key, value] of environment) if (
    /^(RUSTFLAGS|CARGO_ENCODED_RUSTFLAGS|RUSTC|RUSTC_WRAPPER|RUSTC_WORKSPACE_WRAPPER|RUSTUP_TOOLCHAIN|CARGO_PROFILE_.+|CARGO_TARGET_.+|CARGO_BUILD_RUST.+)$/.test(key)
    && key !== 'CARGO_TARGET_DIR' && value !== undefined) hash.update(key).update('\0').update(value).update('\0');
  return hash.digest('hex');
}

export function reusableBuild(root: string, { native, source, quick, compiler }: {
  native: boolean; source: string; quick: boolean; compiler?: { version: string; host?: string } | null;
}): BuildMetadata | null {
  const name = `battle_dynamics-${process.platform}-${process.arch}`,
    directory = join(root, native ? 'native/artifacts' : 'src/native'),
    file = join(directory, native ? name + '.json' : 'battle_dynamics.json');
  try {
    const info: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!buildMetadata(info)) return null;
    if (info.sourceSHA256 !== source || !['release', 'preview'].includes(info.profile) ||
        !quick && info.profile !== 'release' || !info.rustc ||
        compiler && info.rustc !== compiler.version) return null;
    if (native && (info.platform !== process.platform || info.arch !== process.arch ||
        !info.target || compiler && info.target !== compiler.host)) return null;
    if (!native && info.target !== 'wasm32-unknown-unknown') return null;
    const description = { sourceSHA256: source, profile: info.profile, target: info.target, rustc: info.rustc };
    if (info.buildSHA256 !== buildRecipe(root, description)) return null;
    const suffix = info.profile === 'preview' ? '-preview' : '';
    let binaryFile = 'battle_dynamics_bg.wasm';
    if (native) {
      if (typeof info.binaryFile !== 'string' ||
          !new RegExp('^' + name + '-' + source.slice(0, 16) + '-[a-f0-9]{12}' + suffix + '\\.node$').test(info.binaryFile)) return null;
      binaryFile = info.binaryFile;
    }
    const bytes = readFileSync(join(directory, binaryFile));
    if (bytes.length !== info.bytes || sha256(bytes) !== info.binarySHA256) return null;
    if (!native && sha256(readFileSync(join(directory, 'battle_dynamics.js'))) !== info.javascriptSHA256) return null;
    return info;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error &&
        (error.code === 'ENOENT' || error.code === 'ENOTDIR' || error.code === 'EISDIR') || error instanceof SyntaxError) return null;
    throw error;
  }
}
