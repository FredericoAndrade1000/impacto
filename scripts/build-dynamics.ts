import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rustSourceHash } from './rust-source-hash.ts';
import { buildRecipe, reusableBuild, sha256 } from './build-artifacts.ts';
import { withBuildLock } from './build-lock.ts';
import type { BuildDescription } from './build-artifacts.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const version = '0.2.129', target = 'wasm32-unknown-unknown';
// Keep dependency optimization and skip the expensive final-crate LTO for a local preview.
const rustOptions = (source: string, recipe: string, quick: boolean): string[] => ['--cfg', `batalha_build_fingerprint="${source}"`, '--cfg', `batalha_build_recipe="${recipe}"`,
  ...(quick ? ['-C', 'opt-level=1', '-C', 'lto=off', '-C', 'codegen-units=16'] : [])];
const releases: Record<string, [string, string]> = {
  'win32-x64': ['x86_64-pc-windows-msvc', '79e348c169d0c10c0b287647f1e753d0985353ca96800bc29be8f4261baf13e6'],
  'linux-x64': ['x86_64-unknown-linux-musl', '82d12bb940e2d4e72e0d5605387fc1b8ca179044e012b620f0ce4e7440e8320e'],
  'linux-arm64': ['aarch64-unknown-linux-musl', '2ed4351c35dd9440308bbb02767d47ea278efe851a52465300f3c94f5b6c2a87'],
  'darwin-x64': ['x86_64-apple-darwin', '7e028879a68ec53dae14048b55cc5215f6df75b17a9c1426fac8fa086d3202fd'],
  'darwin-arm64': ['aarch64-apple-darwin', '81d4a23d56b3c3eb8187658329116d50e0b228a93b343825fb71f70179051cd1'],
};

function run(command: string, args: readonly string[], { capture = false, env = process.env }: { capture?: boolean; env?: NodeJS.ProcessEnv } = {}): string {
  const result = spawnSync(command, args, { cwd: root, env, windowsHide: true, stdio: capture ? 'pipe' : 'inherit', encoding: 'utf8' });
  if (result.error) throw new Error(`Cannot run ${command}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${command} failed (${result.status}). ${result.stderr || ''}`);
  return (result.stdout || '').trim();
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Download failed (${response.status}): ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

async function bindgen() {
  const configured = process.env.WASM_BINDGEN;
  if (configured) {
    const binary = resolve(root, configured);
    if (run(binary, ['--version'], { capture: true }) !== `wasm-bindgen ${version}`)
      throw new Error(`WASM_BINDGEN must point to wasm-bindgen ${version}.`);
    return binary;
  }
  const release = releases[`${process.platform}-${process.arch}`];
  if (!release) throw new Error(`No pinned wasm-bindgen binary for ${process.platform}/${process.arch}.`);
  const [triple, digest] = release, base = `wasm-bindgen-${version}-${triple}`,
    tools = join(root, 'native', '.tools'), directory = join(tools, base),
    binaryName = process.platform === 'win32' ? 'wasm-bindgen.exe' : 'wasm-bindgen',
    binary = join(directory, binaryName), archive = join(tools, `${base}.tar.gz`);
  mkdirSync(directory, { recursive: true });
  if (!existsSync(archive) || sha256(readFileSync(archive)) !== digest) {
    console.log(`Downloading pinned wasm-bindgen ${version} (${triple})...`);
    const bytes = await download(`https://github.com/wasm-bindgen/wasm-bindgen/releases/download/${version}/${base}.tar.gz`);
    if (sha256(bytes) !== digest) throw new Error('wasm-bindgen archive SHA256 does not match the pinned release.');
    writeFileSync(archive, bytes);
  }
  // Extract only the verified CLI; no global tool install or PATH mutation.
  run('tar', ['-xzf', archive, '-C', directory, '--strip-components', '1', `${base}/${binaryName}`]);
  if (run(binary, ['--version'], { capture: true }) !== `wasm-bindgen ${version}`) {
    throw new Error(`The downloaded CLI does not report wasm-bindgen ${version}.`);
  }
  return binary;
}

function rustCompiler(): { version: string; host?: string } | null {
  const result = spawnSync(process.env.RUSTC || 'rustc', ['-vV'], { cwd: root, windowsHide: true, encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  const version = result.stdout.split(/\r?\n/)[0], host = result.stdout.match(/^host: (.+)$/m)?.[1];
  if (version === undefined) return null;
  return { version, ...(host === undefined ? {} : { host }) };
}

async function buildDynamics({ native = false, quick = false, force = false, compiler = rustCompiler() }: {
  native?: boolean; quick?: boolean; force?: boolean; compiler?: { version: string; host?: string } | null;
} = {}) {
  let source = rustSourceHash(join(root, 'native/dynamics'));
  const reuse = () => {
    const info = !force && reusableBuild(root, { native, source, quick, compiler });
    if (info) console.log(`Reusing ${native ? 'Native' : 'Wasm'} ${info.profile}: Rust and build inputs unchanged.`);
    return info;
  };
  const known = reuse();
  if (known) return known;
  const buildDirectory = process.env.CARGO_TARGET_DIR ? resolve(root, process.env.CARGO_TARGET_DIR) : join(root, 'native', 'dynamics', 'target');
  const compile = async () => {
    source = rustSourceHash(join(root, 'native/dynamics'));
    const known = reuse();
    if (known) return known;
    if (!compiler?.host) throw new Error('Rust is required to rebuild this core. Install the toolchain or restore matching build artifacts.');
    const profile = quick ? 'preview' : 'release', buildTarget = native ? compiler.host : target,
      description: BuildDescription = { sourceSHA256: source, profile, target: buildTarget, rustc: compiler.version },
      recipe = buildRecipe(root, description),
      manifest = join(root, 'native', 'dynamics', 'Cargo.toml'), env: NodeJS.ProcessEnv = { ...process.env, CARGO_TARGET_DIR: buildDirectory };
    if (native) {
      const host = compiler.host;
      // Fingerprints invalidate only the final crate; optimized dependencies remain reusable.
      run('cargo', ['rustc', '--lib', '--locked', '--release', '--features', 'node', '--target', host, '--manifest-path', manifest,
        '--', ...rustOptions(source, recipe, quick)], { env });
      const library = process.platform === 'win32' ? 'batalha_dynamics.dll' :
        process.platform === 'darwin' ? 'libbatalha_dynamics.dylib' : 'libbatalha_dynamics.so',
        directory = join(root, 'native', 'artifacts'), name = `battle_dynamics-${process.platform}-${process.arch}`;
      mkdirSync(directory, { recursive: true });
      const bytes = readFileSync(join(buildDirectory, host, 'release', library));
      // Loaded Windows addons stay locked; changed bytes get a different filename.
      const binaryFile = name + '-' + source.slice(0, 16) + '-' + sha256(bytes).slice(0, 12) + (quick ? '-preview' : '') + '.node';
      const binaryPath = join(directory, binaryFile);
      if (!existsSync(binaryPath) || sha256(readFileSync(binaryPath)) !== sha256(bytes)) writeFileSync(binaryPath, bytes);
      writeFileSync(join(directory, name + '.json'), JSON.stringify({ target: host, platform: process.platform, arch: process.arch,
        napi: 4, rustc: compiler.version, sourceSHA256: source, buildSHA256: recipe,
        binaryFile, binarySHA256: sha256(bytes), bytes: bytes.length, profile,
        builtAt: new Date().toISOString() }, null, 2) + '\n');
      console.log(`Built native/artifacts/${binaryFile} (${bytes.length} bytes, SHA256 ${sha256(bytes)}).`);
      return;
    }
    const installed = run('rustup', ['target', 'list', '--installed'], { capture: true }).split(/\r?\n/);
    if (!installed.includes(target)) throw new Error(`Rust target missing. Run: rustup target add ${target}`);
    // Rust embeds panic locations in the deployed Wasm, including the source paths of dependencies.
    // Apply the remaps to all target crates without discarding operator-provided compiler flags.
    const inherited = env.CARGO_ENCODED_RUSTFLAGS?.split('\u001f') ?? (env.RUSTFLAGS?.match(/\S+/g) ?? []);
    const remap = [
      [root, 'impacto'],
      [buildDirectory, 'build'],
      [resolve(root, env.CARGO_HOME || join(homedir(), '.cargo')), 'cargo'],
    ].map(([from, to]) => `--remap-path-prefix=${from}=${to}`);
    run('cargo', ['rustc', '--lib', '--locked', '--release', '--target', target, '--manifest-path', manifest,
      '--', ...rustOptions(source, recipe, quick)], { env: { ...env, CARGO_ENCODED_RUSTFLAGS: [...inherited, ...remap].join('\u001f') } });
    const binary = await bindgen();
    const output = join(buildDirectory, 'bindgen'), wasm = join(buildDirectory, target, 'release', 'batalha_dynamics.wasm');
    mkdirSync(output, { recursive: true });
    run(binary, [wasm, '--target', 'web', '--out-dir', output, '--out-name', 'battle_dynamics', '--no-typescript']);
    const destination = join(root, 'src', 'native');
    mkdirSync(destination, { recursive: true });
    for (const file of ['battle_dynamics.js', 'battle_dynamics_bg.wasm']) copyFileSync(join(output, file), join(destination, file));
    const bytes = readFileSync(join(destination, 'battle_dynamics_bg.wasm'));
    writeFileSync(join(destination, 'battle_dynamics.json'), JSON.stringify({ ...description, buildSHA256: recipe,
      binarySHA256: sha256(bytes), javascriptSHA256: sha256(readFileSync(join(destination, 'battle_dynamics.js'))),
      bytes: bytes.length, builtAt: new Date().toISOString() }, null, 2) + '\n');
    console.log(`Built src/native/battle_dynamics_bg.wasm (${bytes.length} bytes, SHA256 ${sha256(bytes)}).`);
  };
  // Serialize publication in this checkout and Cargo outputs shared by other checkouts.
  const publicationDirectory = join(root, 'native/artifacts'), key = (path: string): string => process.platform === 'win32' ? path.toLowerCase() : path;
  return withBuildLock(publicationDirectory, () => key(publicationDirectory) === key(buildDirectory) ? compile() : withBuildLock(buildDirectory, compile));
}

async function main() {
  const args = process.argv.slice(2), allowed = ['--native', '--tools-only', '--quick', '--prepare', '--force', '--help'];
  if (args.some(arg => !allowed.includes(arg))) throw new Error('Unknown build option. Use --help.');
  if (args.includes('--help')) {
    console.log('node scripts/build-dynamics.ts [--native | --tools-only | --prepare] [--quick] [--force]\nReuse verified outputs when Rust, recipe and compiler inputs match. --quick rebuilds a local preview only when needed; a valid release can be reused. --prepare checks Wasm and an already-configured Native host. --force rebuilds even matching outputs.');
    return;
  }
  if (['--native', '--tools-only', '--prepare'].filter(arg => args.includes(arg)).length > 1)
    throw new Error('Choose only one of --native, --tools-only or --prepare.');
  if (args.includes('--tools-only')) { await bindgen(); return; }
  const options = { native: args.includes('--native'), quick: args.includes('--quick'), force: args.includes('--force'), compiler: rustCompiler() };
  if (args.includes('--prepare')) {
    await buildDynamics({ ...options, native: false });
    if (existsSync(join(root, 'native/artifacts', `battle_dynamics-${process.platform}-${process.arch}.json`)))
      await buildDynamics({ ...options, native: true });
  } else await buildDynamics(options);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
