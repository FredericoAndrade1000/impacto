import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import fs from 'node:fs';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { withBuildLock } from '../scripts/build-lock.ts';

const moduleURL = new URL('../scripts/build-lock.ts', import.meta.url).href;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'impacto-build-lock-')), children = [];
  t.after(async () => {
    for (const child of children) if (child.process.connected) child.process.send('stop');
    await Promise.all(children.map(child => child.done));
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    rmSync(root, { recursive: true, force: true });
  });
  const worker = ({ orphan = false } = {}) => {
    const script = `
      import { withBuildLock } from ${JSON.stringify(moduleURL)};
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      process.on('message', message => {
        if (message === 'release') release();
        if (message === 'stop') process.exit(0);
      });
      setTimeout(() => process.exit(2), 10000).unref();
      await withBuildLock(${JSON.stringify(root)}, async () => {
        process.send('entered');
        if (${orphan}) { process.send('orphan', () => process.exit(0)); await new Promise(() => {}); }
        await gate;
      }, { pollMs: 10, log: () => process.send('waiting') });
      process.disconnect();
    `;
    const process = spawn(globalThis.process.execPath, ['--input-type=module', '--eval', script], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true }),
      events = new EventEmitter(), messages = [];
    let stderr = '';
    process.stderr.on('data', bytes => { stderr += bytes; });
    process.on('message', event => { messages.push(event); events.emit(event); });
    const done = new Promise((accept, reject) => {
      process.once('error', reject);
      process.once('exit', code => { accept({ code, stderr }); });
    });
    const child = { process, messages, done, wait: async event => {
      if (messages.includes(event)) return;
      await Promise.race([once(events, event), done.then(result => { throw new Error(`Worker exited before ${event}: ${JSON.stringify(result)}`); })]);
    } };
    children.push(child);
    return child;
  };
  return { root, worker };
}

test('builds sharing a target directory wait and enter one at a time', { timeout: 15000 }, async t => {
  const { root, worker } = fixture(t), first = worker();
  await first.wait('entered');
  const second = worker();
  await second.wait('waiting');
  assert(!second.messages.includes('entered'));
  first.process.send('release');
  assert.equal((await first.done).code, 0);
  await second.wait('entered');
  second.process.send('release');
  assert.equal((await second.done).code, 0);
  assert.equal(second.messages.filter(event => event === 'waiting').length, 1);
  assert.equal(existsSync(join(root, '.dynamics-build.lock')), false);
});

test('a thrown build releases its lock and preserves the build error', async t => {
  const { root } = fixture(t), failure = new Error('build failed');
  await assert.rejects(withBuildLock(root, async () => { throw failure; }), error => error === failure);
  assert.equal(await withBuildLock(root, async () => 'next build'), 'next build');
  assert.equal(existsSync(join(root, '.dynamics-build.lock')), false);
});

test('the next build recovers a lock only after its owner process has exited', { timeout: 15000 }, async t => {
  const { root, worker } = fixture(t), owner = worker({ orphan: true });
  await owner.wait('orphan');
  assert.equal((await owner.done).code, 0);
  assert.equal(existsSync(join(root, '.dynamics-build.lock')), true);
  assert.equal(await withBuildLock(root, async () => 'recovered'), 'recovered');
  assert.equal(existsSync(join(root, '.dynamics-build.lock')), false);
});

test('an unknown or partially written owner is left untouched', async t => {
  const { root } = fixture(t), lock = join(root, '.dynamics-build.lock');
  mkdirSync(lock);
  await assert.rejects(withBuildLock(root, async () => assert.fail('unidentified owner'), { pollMs: 5 }), /Cannot identify the build lock owner/);
  assert.equal(existsSync(lock), true);
  const owner = join(lock, 'owner-12345678-1234-1234-1234-123456789abc.json');
  writeFileSync(owner, '{"pid":');
  let entered = false;
  await assert.rejects(withBuildLock(root, async () => { entered = true; }, { pollMs: 5 }), /Cannot identify the build lock owner/);
  assert.equal(entered, false);
  assert.equal(readFileSync(owner, 'utf8'), '{"pid":');
});

test('lock creation races retry briefly while a persistent permission error stops safely', async t => {
  const { root } = fixture(t), mkdir = fs.mkdirSync,
    denied = Object.assign(new Error('mkdir denied'), { code: 'EPERM' });
  for (const transient of [true, false]) {
    let attempts = 0;
    const mocked = t.mock.method(fs, 'mkdirSync', (...args) => {
      if (args[0] !== join(root, '.dynamics-build.lock') || ++attempts > 1 && transient) return mkdir(...args);
      throw denied;
    });
    syncBuiltinESMExports();
    try {
      const build = withBuildLock(root, async () => 'built', { pollMs: 5 });
      if (transient) assert.equal(await build, 'built');
      else await assert.rejects(build, error => error === denied);
      assert(attempts > 1 && attempts < 10, 'retry count is bounded');
    } finally {
      mocked.mock.restore();
      syncBuiltinESMExports();
    }
    assert.deepEqual(fs.readdirSync(root), [], 'no lock remains after either result');
  }
});

test('failed owner publication releases the directory claimed by this process', async t => {
  const { root } = fixture(t), write = fs.writeFileSync, lock = join(root, '.dynamics-build.lock'),
    denied = new Error('cannot publish owner');
  const mocked = t.mock.method(fs, 'writeFileSync', (...args) => {
    if (dirname(args[0]) === lock) throw denied;
    return write(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(withBuildLock(root, async () => assert.fail('owner was not published')), error => error === denied);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
  assert.equal(existsSync(lock), false);
});
