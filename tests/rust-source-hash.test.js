import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { rustSourceHash } from '../scripts/rust-source-hash.ts';

test('a native build fingerprint survives Git line-ending conversion and still detects code changes', t => {
  const root = mkdtempSync(join(tmpdir(), 'impacto-source-hash-'));
  t.after(() => {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  mkdirSync(join(root, 'src'));
  const files = { 'Cargo.toml': '[package]\nname = "fixture"\n', 'Cargo.lock': '# Lock\n',
    'build.rs': 'fn main() {}\n', 'src/lib.rs': 'pub const VALUE: u32 = 1;\n' };
  const write = ending => {
    for (const [file, source] of Object.entries(files)) writeFileSync(join(root, file), source.replace(/\n/g, ending));
  };
  write('\n'); const before = rustSourceHash(root);
  write('\r\n'); assert.equal(rustSourceHash(root), before);
  writeFileSync(join(root, 'src/lib.rs'), 'pub const VALUE: u32 = 2;\r\n');
  assert.notEqual(rustSourceHash(root), before);
  write('\n'); writeFileSync(join(root, 'src/other.rs'), 'pub fn another() {}\n');
  assert.notEqual(rustSourceHash(root), before, 'adding a module changes the fingerprint');
});
