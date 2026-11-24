import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reviewCases, REVIEW_SUITES } from '../scripts/review-cases.ts';
import { reviewArguments, compactResult, reviewSummary, pairedInputs, runReview } from '../scripts/review.ts';
import { reviewFailures } from '../scripts/review-checks.ts';
import { WorkerPool } from '../scripts/worker-pool.ts';
import { WEAPON_PRESETS, allowedAmmo } from '../src/weapons.ts';
import { MATERIALS } from '../src/materials.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { Intercepts, Profiler, advance, fingerprint, permanentParts, partsPreserved } from '../scripts/review-harness.ts';

test('the catalogue retains physical controls and full weapon/material matrices', () => {
  assert.equal(new Set(REVIEW_SUITES).size, REVIEW_SUITES.length);
  const fire = reviewCases('fire'), edges = reviewCases('track-edge');
  assert(fire[0].params.control && edges[0].params.control);
  assert(fire.some(c => c.params.measureEngineFloor));
  assert(edges.some(c => c.params.prepareHole));
  assert(edges.some(c => c.params.burst));
  assert.equal(reviewCases('secondary').length, 62);
  const lab = reviewCases('lab'), joints = lab.filter(c => c.probe === 'probeJoint');
  assert.equal(lab.length, 6 + 2 * 9 + 2);
  assert.equal(joints.length, 18); assert(joints.every(c => c.params.gap === 0), 'all joint fixtures use the admitted closed hull');
  assert.deepEqual([...new Set(joints.map(c => c.params.thickness))], [100, 125]);
  const armor = reviewCases('arsenal');
  assert.equal(armor.length, Object.keys(WEAPON_PRESETS).reduce((n, p) => n + allowedAmmo(p).length * Object.keys(MATERIALS).length * 6, 16));
  assert.equal(reviewCases('explosives').length, armor.length + 48);
  assert.throws(() => reviewCases('fire', { mode: 'typo' }), /Modo/);
  assert.throws(() => reviewCases('unknown'), /Suite/);
  assert.throws(() => reviewCases('debris'), /Suite/, 'physical-chip budget review is retired');
});

test('review arguments are typed and reject unknown options and unbounded workers or frames', () => {
  assert.deepEqual(reviewArguments(['destruction', '--frames', '90', '--scene', 'concrete', '--workers', '4']),
    { suite: 'destruction', options: { frames: 90, scene: 'concrete', workers: 4 } });
  for (const args of [['--workers', '0'], ['--frames', 'NaN'], ['--frames', '72001'], ['--count'], ['--stage', 'combat'],
    ['--seconds', '12'], ['--unknown'], ['--sleep'], ['--panel-extra-iterations', '2'], ['--sample']])
    assert.throws(() => reviewArguments(['fire', ...args]));
});

test('compact rows keep outcomes, diagnostics and step counts while leaving traces in the full case file', () => {
  const original = { status: 'finished', elapsed: .05, physicsSteps: 3, trace: [1],
    stats: { shots: 0, impacts: 0, explosions: 0 }, diagnostics: { maxProjectileHeight: 2 } };
  const result = compactResult(original);
  assert.equal(result.trace, undefined); assert.equal(result.physicsSteps, 3);
  assert.deepEqual(result.diagnostics, original.diagnostics); assert.deepEqual(original.trace, [1]);
  const row = (id, failures) => ({ id, probe: 'runFireCase', failures, result, scenario: { preset: 'rh120' } }),
    report = reviewSummary([row('one', []), row('two', ['non-finite state or metrics']), null]);
  assert.deepEqual(report, { cases: 2, failed: 1, failures: [{ id: 'two', reasons: ['non-finite state or metrics'] }],
    groups: { 'preset:rh120': { cases: 2, failed: 1 } } });
});

test('paired profiles reuse frozen identities and reject changed parameters, references or physical values', () => {
  const before = reviewCases('destruction', { scene: 'concrete', frames: 1 }),
    generated = reviewCases('destruction', { scene: 'concrete', frames: 1 });
  assert.equal(before[0].params.scene.blueprint.version, DESIGN_VERSION);
  assert.deepEqual(before[0].params.scene.blueprint, generated[0].params.scene.blueprint, 'authored identities are deterministic');
  assert.equal(pairedInputs(generated, before), before);
  generated[0].params.scene.blueprint.plates[0].thicknessMm++;
  assert.throws(() => pairedInputs(generated, before), /parâmetros/);
  generated[0].params.scene.blueprint.plates[0].thicknessMm--;
  generated[0].params.frames = 2;
  assert.throws(() => pairedInputs(generated, before), /parâmetros/);
  const ids = ['12345678-1234-4123-8123-123456789abc', '12345678-1234-4123-8123-123456789def'],
    renamed = ['a2345678-1234-4123-8123-123456789abc', 'a2345678-1234-4123-8123-123456789def'],
    state = (names, owner = 0, x = 3) => ({ parts: [{ id: names[0], x }, { id: names[1], owner: names[owner] }] }),
    digest = value => fingerprint(value, { opaqueIdentities: true });
  assert.equal(digest(state(ids)), digest(state(renamed)));
  assert.notEqual(digest(state(ids)), digest(state(renamed, 1)));
  assert.notEqual(digest(state(ids)), digest(state(renamed, 0, 3.001)));
});

test('paired review outputs refuse to overwrite existing controls before starting workers', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'review-preserve-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const entries = reviewCases('fire').slice(0, 1), before = join(folder, 'before'), after = join(folder, 'after');
  mkdirSync(before); mkdirSync(after);
  writeFileSync(join(before, 'inputs.json'), JSON.stringify(entries));
  writeFileSync(join(before, 'report.json'), JSON.stringify({ suite: 'fire', complete: true, rows: [] }));
  writeFileSync(join(after, 'report.json'), 'preserved after result');
  const files = [join(before, 'inputs.json'), join(before, 'report.json'), join(after, 'report.json')], bytes = files.map(file => readFileSync(file));
  for (const label of ['before', 'after'])
    await assert.rejects(runReview('fire', { output: folder, label, limit: 1 }), /já contém arquivos.*--output/);
  assert.deepEqual(files.map(file => readFileSync(file)), bytes);
});

test('the before/after runner compares a bounded physical case with identical inputs and disposes both workers', async t => {
  const folder = mkdtempSync(join(tmpdir(), 'review-pair-')); t.after(() => rmSync(folder, { recursive: true, force: true }));
  const options = { scene: 'concrete', frames: 1, workers: 1, output: folder },
    before = await runReview('destruction', { ...options, label: 'before' }),
    after = await runReview('destruction', { ...options, label: 'after' });
  assert.equal(before.complete, true); assert.equal(after.complete, true);
  assert.equal(before.summary.failed, 0); assert.equal(after.summary.failed, 0);
  assert.equal(after.comparison[0].identicalState, true);
  assert.equal(readFileSync(join(folder, 'before', 'inputs.json'), 'utf8'), readFileSync(join(folder, 'after', 'inputs.json'), 'utf8'));
  await assert.rejects(runReview('destruction', { ...options, frames: 2, label: 'after' }), /parâmetros/);
});

test('central checks retain negative controls for energy, damage and invalid states', () => {
  assert(reviewFailures({ checks: 'physical' }, { finite: true, peaks: { dentLimitRatio: 1.1 } }).includes('indentation exceeds material limit'));
  assert(reviewFailures({ checks: 'physical' }, { velocity: NaN }).includes('non-finite state or metrics'));
  assert(reviewFailures({ checks: 'physical' }, { recoveries: 1 }).includes('solver recovery'));
  const isolated = { activePackets: 0, peakPackets: 0, partsPreserved: true, massPreserved: true,
    explosions: 0, health: 100, healthAfterImpact: 100, initialHealth: 100, shield: 5, hits: [], hitsAtImpact: [],
    rays: [.25, .5, .25].map(energyBudget => ({ energyBudget, energySpent: 0 })),
    energyBudget: 1, energySpent: 0, consumedPrimaryEnergy: 100,
    energyBudgetAtImpact: 1, energySpentAtImpact: 0,
    emittedAtImpact: 3, secondaryShots: 3, secondaryDamage: 0, secondaryDamageAtImpact: 0 };
  isolated.raysAtImpact = isolated.rays.map(ray => ({ ...ray }));
  const failures = patch => reviewFailures({ checks: 'secondary' }, { ...isolated, ...patch });
  assert.deepEqual(failures({}), []);
  assert(failures({ health: 90, healthAfterImpact: 90, secondaryDamage: 10, secondaryDamageAtImpact: 10 }).includes('shield did not intercept chips'));
  assert(failures({ hits: [{ secondary: true, instantaneous: true, impulse: 0,
    damage: 1, energy: 1, power: 100 }] }).includes('damage exceeds secondary kinetic energy'));
  assert(failures({ partsPreserved: false }).includes('secondary damage changed construction parts'));
  assert(failures({ massPreserved: false }).includes('secondary damage changed admitted mass'));
  assert(failures({ raysAtImpact: [...isolated.raysAtImpact, isolated.raysAtImpact[0]] }).includes('ray budget exceeded'));
  assert(failures({ consumedPrimaryEnergy: 1 }).includes('secondary ray energy exceeds source budget'));
  assert(failures({ rays: isolated.rays.map(ray => ({ ...ray, energySpent: 2 })) }).includes('invalid secondary ray energy'));
  assert(failures({ secondaryShots: 6 }).includes('secondary ray accounting mismatch'));
  assert(failures({ secondaryDamage: 1 }).includes('excess or unaccounted secondary health damage'));
  assert(failures({ hits: [{ secondary: true, instantaneous: false, impulse: 0,
    damage: 0, energy: 1, power: 0 }] }).includes('primary or persistent damage contaminated instantaneous rays'));
  const later = { secondary: true, instantaneous: true, impulse: 0, damage: 1, energy: 200, power: 1 };
  assert.deepEqual(failures({ explosions: 1, health: 99, secondaryDamage: 1, hits: [later],
    rays: [...isolated.rays, ...isolated.rays.map(ray => ({ ...ray, energyBudget: 100 }))],
    energyBudget: 301, secondaryShots: 6 }), [],
  'later explosions retain their own energy instead of contaminating the initial impact budget');

});

test('damage audits preserve installed identities and the single carrier under functional damage', () => {
  const plate = { id: 'plate', actorId: 'actor', attached: true }, module = { id: 'engine', actorId: 'actor', attached: true, health: 100 },
    carrier = { actor: 1, handle: 1 },
    world = { plates: [plate], modules: [module], actors: [{ id: 'actor' }],
      game: () => ({ call: () => ({ bodyStates: [carrier] }) }) },
    initial = permanentParts(world);
  module.health = 0; plate.remainingArea = 0;
  assert(partsPreserved(world, initial), 'health and remaining material do not define installed identity');
  carrier.handle = 2;
  assert.equal(partsPreserved(world, initial), false, 'damage cannot replace the carrier identity');
  carrier.handle = 1;
  module.attached = false;
  assert.equal(partsPreserved(world, initial), false, 'damage cannot disconnect an installed component');
  module.attached = true; world.modules = [];
  assert.equal(partsPreserved(world, initial), false, 'damage cannot remove an installed component');
});

test('one hook lifecycle preserves this/results/errors and restores methods even when a probe throws', () => {
  const object = { value: 3, method(n) { if (n < 0) throw new Error('probe'); return this.value + n; } }, original = object.method,
    hooks = new Intercepts(), profiler = new Profiler();
  hooks.replace(object, 'method', function(method, args) { return method.apply(this, args) * 2; });
  profiler.watch(object, ['method'], 'case.');
  try {
    assert.equal(object.method(2), 10); assert.throws(() => object.method(-1), /probe/);
    assert.equal(profiler.costs.get('case.method').calls, 2);
  } finally { profiler.close(); hooks.close(); }
  assert.equal(object.method, original);
  const events = [], world = { ticks: 0, step() { this.ticks++; }, drainEvents() { return [{ tick: this.ticks }]; } };
  advance(world, 100, { events, until: () => world.ticks === 3 });
  assert.equal(world.ticks, 3); assert.equal(events.length, 3);
});

test('the common worker accepts async probes, reports errors per case and can execute a second batch', async t => {
  const pool = new WorkerPool(new URL('../scripts/review-worker.ts', import.meta.url), 2); t.after(() => pool.dispose());
  const tasks = [1, 2].map(n => ({ probe: 'missing-' + n, params: {} }));
  const result = await pool.collect(tasks);
  assert.deepEqual(result.map(r => r.probe), ['missing-1', 'missing-2']);
  assert(result.every(r => r.status === 'invalid' && /Probe/.test(r.error)));
  assert.equal((await pool.collect(tasks.slice(1)))[0].probe, 'missing-2');
});

const poolFixture = body => new URL('data:text/javascript,' + encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  let options;
  parentPort.on('message', message => {
    if (message.configure !== undefined) { options = message.options; return; }
    ${body}
  });`));

test('the shared job pool preserves task order, changes batch configuration and rejects overlapping batches', async t => {
  const pool = new WorkerPool(poolFixture(`setTimeout(() => parentPort.postMessage({ batch: message.batch,
    index: message.index, result: { id: message.task.id, tag: options.tag } }), message.task.delay);`), 2);
  t.after(() => pool.dispose());
  assert.deepEqual(await pool.collect([], {}), []);
  const progress = [], batch = pool.collect([{ id: 1, delay: 30 }, { id: 2, delay: 1 }, { id: 3, delay: 5 }],
    { tag: 'first' }, { onProgress: value => progress.push(value.completed) });
  await assert.rejects(pool.collect([{}], {}), /já está/);
  assert.deepEqual(await batch, [1, 2, 3].map(id => ({ id, tag: 'first' })));
  assert.deepEqual(progress, [1, 2, 3]);
  assert.deepEqual(await pool.collect([{ id: 4 }], { tag: 'second' }), [{ id: 4, tag: 'second' }]);
});

test('cancelled, crashed and malformed job workers release their pool and reject the incomplete batch', async () => {
  for (const mode of ['cancel', 'crash', 'malformed']) {
    const body = mode === 'cancel' ? 'setTimeout(() => {}, 1000);' : mode === 'crash' ?
      'throw new Error("episode crash");' : 'parentPort.postMessage({ batch: message.batch, index: message.index });',
      pool = new WorkerPool(poolFixture(body), 1), controller = new AbortController();
    try {
      const pending = pool.collect([{}], {}, { signal: controller.signal });
      if (mode === 'cancel') controller.abort();
      await assert.rejects(pending, mode === 'cancel' ? /cancelado/ : mode === 'crash' ? /episode crash/ : /inválida/);
      assert(pool.closed); assert.equal(pool.pending, null);
      await assert.rejects(pool.collect([{}], {}));
    } finally { await pool.dispose(); }
  }
});
