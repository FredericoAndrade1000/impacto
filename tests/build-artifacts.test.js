import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRecipe, reusableBuild, sha256 } from '../scripts/build-artifacts.ts';
import { rustSourceHash } from '../scripts/rust-source-hash.ts';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'impacto-core-build-'));
  const write = (file, content) => {
    mkdirSync(dirname(join(root, file)), { recursive: true }); writeFileSync(join(root, file), content);
  };
  t.after(() => {
    assert.equal(dirname(root), tmpdir());
    rmSync(root, { recursive: true, force: true });
  });
  for (const [key, value] of Object.entries({ RUSTC: join(root, 'no-rust-installed'), CARGO_HOME: join(root, 'cargo-home') })) {
    const previous = process.env[key]; process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
  write('package.json', '{"type":"module"}');
  for (const file of ['build-dynamics.ts', 'build-artifacts.ts', 'rust-source-hash.ts', 'build-lock.ts',
    'native-dynamics-host.ts', 'export-construction-catalogue.ts']) {
    write(`scripts/${file}`, '');
    copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), join(root, 'scripts', file));
  }
  for (const [file, content] of Object.entries({ 'Cargo.toml': '[package]\nname="fixture"\n', 'Cargo.lock': 'version = 4\n',
    'build.rs': 'fn main() {}\n', 'src/lib.rs': 'pub fn unchanged() {}\n' })) write(`native/dynamics/${file}`, content);
  const source = rustSourceHash(join(root, 'native/dynamics')),
    compiler = { version: 'rustc fixture-compiler', host: 'fixture-native-target' },
    options = { native: false, source, quick: false, compiler },
    wasmRecord = 'src/native/battle_dynamics.json',
    nativeRecord = `native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`;
  function publish({ native = false, profile = 'release' } = {}) {
    const description = { sourceSHA256: source, profile, target: native ? compiler.host : 'wasm32-unknown-unknown', rustc: compiler.version },
      bytes = Buffer.from(`${native ? 'native' : 'wasm'} fixture ${profile}`), binarySHA256 = sha256(bytes),
      info = { ...description, buildSHA256: buildRecipe(root, description), binarySHA256, bytes: bytes.length, builtAt: 'unchanged' };
    if (native) {
      Object.assign(info, { platform: process.platform, arch: process.arch,
        binaryFile: `battle_dynamics-${process.platform}-${process.arch}-${source.slice(0, 16)}-${binarySHA256.slice(0, 12)}${profile === 'preview' ? '-preview' : ''}.node` });
      write(`native/artifacts/${info.binaryFile}`, bytes);
    } else {
      write('src/native/battle_dynamics_bg.wasm', bytes); write('src/native/battle_dynamics.js', 'export const fixture = true;\n');
      info.javascriptSHA256 = sha256(readFileSync(join(root, 'src/native/battle_dynamics.js')));
    }
    write(native ? nativeRecord : wasmRecord, JSON.stringify(info));
    return info;
  }
  const cli = (args, script = 'build-dynamics.ts') => spawnSync(process.execPath, [join(root, 'scripts', script), ...args],
    { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '' }, windowsHide: true, timeout: 5000 });
  return { root, write, source, compiler, options, wasmRecord, nativeRecord, publish, cli };
}

test('verified outputs are reused without Cargo, Rust installation or any file writes', t => {
  const f = fixture(t); f.publish(); f.publish({ native: true });
  const files = [f.wasmRecord, f.nativeRecord, 'src/native/battle_dynamics_bg.wasm', 'src/native/battle_dynamics.js'],
    before = files.map(file => [readFileSync(join(f.root, file)), statSync(join(f.root, file)).mtimeMs]);
  const result = f.cli(['--prepare']);
  assert.equal(result.status, 0, result.stderr); assert.match(result.stdout, /Reusing Wasm release/); assert.match(result.stdout, /Reusing Native release/);
  assert.deepEqual(files.map(file => [readFileSync(join(f.root, file)), statSync(join(f.root, file)).mtimeMs]), before);
});

test('development accepts optimized outputs and previews; production rejects previews', t => {
  const f = fixture(t);
  for (const native of [false, true]) {
    f.publish({ native }); assert(reusableBuild(f.root, { ...f.options, native, quick: true }));
    f.publish({ native, profile: 'preview' });
    assert(reusableBuild(f.root, { ...f.options, native, quick: true }));
    assert.equal(reusableBuild(f.root, { ...f.options, native }), null);
  }
  assert.equal(f.cli(['--prepare', '--quick']).status, 0);
  const release = f.cli(['--prepare']); assert.notEqual(release.status, 0); assert.match(release.stderr, /Rust is required/);
});

test('prepare leaves Native optional, but does not silently accept a broken configured Native host', t => {
  const f = fixture(t); f.publish();
  const wasmOnly = f.cli(['--prepare', '--quick']); assert.equal(wasmOnly.status, 0, wasmOnly.stderr); assert.doesNotMatch(wasmOnly.stdout, /Native/);
  f.write(f.nativeRecord, 'null');
  const broken = f.cli(['--prepare', '--quick']); assert.notEqual(broken.status, 0); assert.match(broken.stderr, /Rust is required/);
});

test('UI/assets, target-cache location and line endings do not invalidate a matching core', t => {
  const f = fixture(t); f.publish();
  f.write('src/render.ts', 'changed interface'); f.write('public/test.png', 'changed image');
  const previous = process.env.CARGO_TARGET_DIR; process.env.CARGO_TARGET_DIR = join(f.root, 'new-cache-location');
  t.after(() => { if (previous === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = previous; });
  const script = 'scripts/build-dynamics.ts'; f.write(script, readFileSync(join(f.root, script), 'utf8').replace(/\r?\n/g, '\r\n'));
  assert(reusableBuild(f.root, f.options));
  f.write('native/dynamics/src/lib.rs', 'pub fn unchanged() {}\r\n');
  assert.equal(rustSourceHash(join(f.root, 'native/dynamics')), f.source);
});

test('Rust changes, recipe changes and compiler changes invalidate exported outputs', t => {
  const f = fixture(t); f.publish();
  f.write('native/dynamics/src/lib.rs', 'pub fn changed() {}\n');
  assert.equal(reusableBuild(f.root, { ...f.options, source: rustSourceHash(join(f.root, 'native/dynamics')) }), null);
  assert.equal(reusableBuild(f.root, { ...f.options, compiler: { ...f.compiler, version: 'rustc newer' } }), null);
  f.write('scripts/build-dynamics.ts', '// new recipe\n'); assert.equal(reusableBuild(f.root, f.options), null);
});

test('Cargo options and configuration participate in the recipe', t => {
  const f = fixture(t); f.publish();
  const previous = process.env.RUSTFLAGS; process.env.RUSTFLAGS = '-C target-cpu=native';
  t.after(() => { if (previous === undefined) delete process.env.RUSTFLAGS; else process.env.RUSTFLAGS = previous; });
  assert.equal(reusableBuild(f.root, f.options), null);
  f.publish(); assert(reusableBuild(f.root, f.options));
  f.write('.cargo/config.toml', '[build]\nrustflags = ["-C", "opt-level=2"]\n');
  assert.equal(reusableBuild(f.root, f.options), null);
});

test('Windows also fingerprints compiler options written with mixed case', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t); f.publish();
  const previous = process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL; process.env.Cargo_Profile_Release_Opt_Level = '2';
  t.after(() => {
    delete process.env.Cargo_Profile_Release_Opt_Level;
    if (previous !== undefined) process.env.CARGO_PROFILE_RELEASE_OPT_LEVEL = previous;
  });
  assert.equal(reusableBuild(f.root, f.options), null);
});

test('missing, malformed and incomplete metadata are cache misses', t => {
  const f = fixture(t); assert.equal(reusableBuild(f.root, f.options), null);
  for (const value of ['{', 'null', '[]', '42', '{}', '{"profile":"unknown"}']) {
    f.write(f.wasmRecord, value); assert.equal(reusableBuild(f.root, f.options), null, value);
  }
  const info = f.publish(); delete info.buildSHA256; f.write(f.wasmRecord, JSON.stringify(info));
  assert.equal(reusableBuild(f.root, f.options), null);
});

test('both the Wasm and its generated JavaScript must match their recorded digests', t => {
  const f = fixture(t); f.publish();
  f.write('src/native/battle_dynamics.js', 'export const wrong = true;'); assert.equal(reusableBuild(f.root, f.options), null);
  f.publish(); f.write('src/native/battle_dynamics_bg.wasm', 'corrupt'); assert.equal(reusableBuild(f.root, f.options), null);
  f.publish(); rmSync(join(f.root, 'src/native/battle_dynamics.js')); assert.equal(reusableBuild(f.root, f.options), null);
});

test('Native reuse requires the right host and a constrained, intact binary', t => {
  const f = fixture(t), options = { ...f.options, native: true };
  let info = f.publish({ native: true });
  assert.equal(reusableBuild(f.root, { ...options, compiler: { ...f.compiler, host: 'different-target' } }), null);
  info.platform = 'different-platform'; f.write(f.nativeRecord, JSON.stringify(info)); assert.equal(reusableBuild(f.root, options), null);
  info = f.publish({ native: true }); info.binaryFile = '../escape.node'; f.write(f.nativeRecord, JSON.stringify(info));
  assert.equal(reusableBuild(f.root, options), null);
  info = f.publish({ native: true }); f.write(`native/artifacts/${info.binaryFile}`, 'corrupt'); assert.equal(reusableBuild(f.root, options), null);
});

test('the runtime accepts current release/preview names and preserves explicit Wasm selection', async t => {
  const f = fixture(t), { nativeRuntimeInfo } = await import(pathToFileURL(join(f.root, 'scripts/native-dynamics-host.ts')));
  assert.deepEqual(nativeRuntimeInfo('auto'), { runtime: 'wasm' });
  assert.throws(() => nativeRuntimeInfo('native'), /build:native/);
  assert.throws(() => nativeRuntimeInfo('unknown'), /auto, native ou wasm/);
  for (const profile of ['release', 'preview']) {
    const info = f.publish({ native: true, profile });
    assert.equal(nativeRuntimeInfo('native').binary, join(f.root, 'native/artifacts', info.binaryFile));
    assert.equal(nativeRuntimeInfo('auto').profile, profile);
  }
  f.write(f.nativeRecord, '{');
  assert.deepEqual(nativeRuntimeInfo('wasm'), { runtime: 'wasm' }, 'explicit Wasm does not inspect a configured addon');
});

test('the runtime refuses legacy Native names without deleting them and still checks content, source and platform', async t => {
  const f = fixture(t), { nativeRuntimeInfo } = await import(pathToFileURL(join(f.root, 'scripts/native-dynamics-host.ts')));
  for (const profile of ['release', 'preview']) {
    const info = f.publish({ native: true, profile }), bytes = readFileSync(join(f.root, 'native/artifacts', info.binaryFile));
    info.binaryFile = info.binaryFile.replace(/-[a-f0-9]{12}(?=-preview\.node$|\.node$)/, '');
    f.write(`native/artifacts/${info.binaryFile}`, bytes); f.write(f.nativeRecord, JSON.stringify(info));
    for (const mode of ['auto', 'native']) assert.throws(() => nativeRuntimeInfo(mode), /Nome.*incompatível.*build:native/);
    assert.deepEqual(readFileSync(join(f.root, 'native/artifacts', info.binaryFile)), bytes);
  }
  let info = f.publish({ native: true }); f.write(`native/artifacts/${info.binaryFile}`, 'corrupt');
  assert.throws(() => nativeRuntimeInfo('native'), /desatualizado ou incompatível/);
  info = f.publish({ native: true }); info.platform = 'other-platform'; f.write(f.nativeRecord, JSON.stringify(info));
  assert.throws(() => nativeRuntimeInfo('native'), /desatualizado ou incompatível/);
  f.publish({ native: true }); f.write('native/dynamics/src/lib.rs', 'pub fn changed() {}\n');
  assert.throws(() => nativeRuntimeInfo('native'), /desatualizado ou incompatível/);
});

test('the Rust catalogue check is read-only, export is idempotent, and JS fixture changes do not invalidate production cores', t => {
  const f = fixture(t), file = 'native/construction-catalogue.json', exportCatalogue = args => f.cli(args, 'export-construction-catalogue.ts');
  f.write('src/construction-admission.ts', 'export const constructionCatalogue = () => ({ weapons: { cannon: 1 } });\n');
  f.write('src/construction-template-catalogue.ts', 'export const CONSTRUCTION_TEMPLATES = [{ id: "scout", name: "Scout" }], FIXTURE_TEMPLATES = [];\n');
  const missing = exportCatalogue(['--check']); assert.notEqual(missing.status, 0); assert.match(missing.stderr, /outdated.*before cargo test/);
  assert.equal(exportCatalogue([]).status, 0);
  f.write(file, readFileSync(join(f.root, file), 'utf8').replace(/\n/g, '\r\n'));
  const before = [readFileSync(join(f.root, file)), statSync(join(f.root, file)).mtimeMs];
  assert.equal(exportCatalogue(['--check']).status, 0); assert.equal(exportCatalogue([]).status, 0);
  assert.deepEqual([readFileSync(join(f.root, file)), statSync(join(f.root, file)).mtimeMs], before, 'a CRLF checkout is current and is not rewritten');
  f.publish();
  f.write('src/construction-admission.ts', 'export const constructionCatalogue = () => ({ weapons: { cannon: 2 } });\n');
  const outdated = exportCatalogue(['--check']); assert.notEqual(outdated.status, 0);
  assert.deepEqual([readFileSync(join(f.root, file)), statSync(join(f.root, file)).mtimeMs], before, 'a failed check preserves the fixture');
  assert.equal(exportCatalogue([]).status, 0);
  assert.equal(JSON.parse(readFileSync(join(f.root, file))).weapons.cannon, 2);
  assert.equal(exportCatalogue(['--check']).status, 0);
  assert(reusableBuild(f.root, f.options), 'cfg(test) data are outside the production core recipe');
  const reused = f.cli(['--prepare']); assert.equal(reused.status, 0, reused.stderr); assert.match(reused.stdout, /Reusing Wasm release/);
});

test('force bypasses a cache hit; failed rebuilds leave existing metadata untouched', t => {
  const f = fixture(t); f.publish(); const before = readFileSync(join(f.root, f.wasmRecord));
  const previous = process.env.CARGO_TARGET_DIR; process.env.CARGO_TARGET_DIR = join(f.root, 'native/artifacts');
  t.after(() => { if (previous === undefined) delete process.env.CARGO_TARGET_DIR; else process.env.CARGO_TARGET_DIR = previous; });
  const result = f.cli(['--force']); assert.notEqual(result.status, 0); assert.match(result.stderr, /Rust is required/);
  assert.deepEqual(readFileSync(join(f.root, f.wasmRecord)), before);
});
