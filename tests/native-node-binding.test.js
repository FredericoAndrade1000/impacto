import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { nativeRuntimeInfo } from '../scripts/native-dynamics-host.ts';
import { createRequire } from 'node:module';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { hostProbe } from '../scripts/review-native-host.ts';
import { compareDynamicsRows } from '../scripts/review-native-dynamics.ts';

const built = existsSync(new URL(`../native/artifacts/battle_dynamics-${process.platform}-${process.arch}.json`, import.meta.url)),
  options = { skip: built ? false : 'Compile with npm run build:native.' };
const binding = () => createRequire(import.meta.url)(nativeRuntimeInfo('native').binary).NativeWorld;
// Obtain the actual scene packet produced by the construction boundary instead
// of maintaining a second set of body/collider/joint descriptors in tests.
function admittedScene() {
  const world = new World(createConstruction('scout')), core = world.dynamics.core;
  let scene;
  world.dynamics.core = new Proxy(core, { get(target, key) {
    const value = Reflect.get(target, key);
    if (key === 'load_game') return request => { scene = request; return value.call(target, request); };
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  try { world.game(); return scene; } finally { world.dispose(); }
}
const query = (world, request = { op: 'physics' }) => JSON.parse(world.game_command(JSON.stringify(request))).result;

test('native binding borrows terrain subarray offsets and owns frame output across steps and disposal', options, () => {
  const Core = binding(), storage = new Float64Array([NaN, -10, 0, 10, 0, NaN]),
    first = new Core(storage.subarray(1, -1), 0, 0), second = new Core(new Float64Array([-10, 0, 10, 0]), 0, 0),
    scene = admittedScene();
  try {
    first.load_game(scene); second.load_game(scene);
    const initial = first.current_frame(), retained = JSON.parse(initial), x = retained.actors[0].vehicle.x;
    query(first, { op: 'setVehicleState', actorId: 'local', state: { vx: 2 } });
    // A live frame tells what moves in numbers, taken once beside its words.
    assert.equal(JSON.parse(first.game_step(1 / 60)).block, true);
    const numbers = first.frame_block();
    assert(numbers instanceof Float64Array && numbers.length > 3); assert.equal(first.frame_block().length, 0);
    assert(JSON.parse(first.current_frame()).actors[0].vehicle.x > x); assert.equal(JSON.parse(second.current_frame()).actors[0].vehicle.x, x);
    first.free(); first.free();
    assert.deepEqual(JSON.parse(initial), retained, 'returned packets remain owned after native calls and disposal');
    assert.throws(() => first.current_frame(), /freed/);
    assert(query(second).bodies > 0, 'episode worlds retain independent storage');
  } finally { first.free(); second.free(); }
});

test('canonical native ABI rejects malformed requests atomically without corrupting the admitted scene', options, () => {
  const Core = binding();
  assert.throws(() => new Core(new Float64Array([1]), 0, -9.81), /Invalid terrain/);
  assert.throws(() => new Core(new Float64Array([0, 0]), 0, -9.81), /Invalid terrain/);
  const world = new Core(new Float64Array(), 0, 0), scene = admittedScene();
  try {
    world.load_game(scene); const before = query(world);
    assert.throws(() => world.game_command('{'), /EOF|key/);
    assert.throws(() => world.load_game('{'), /EOF|key/);
    assert.throws(() => world.game_step(-1), /fixed step/);
    assert.throws(() => world.game_step(.1), /fixed step/);
    assert.throws(() => query(world, { op: '__unknown_operation__' }), /Unknown|Unsupported/);
    const malformed = JSON.parse(scene); malformed.plates[0].indices[0] = 999999;
    assert.throws(() => world.load_game(JSON.stringify(malformed)), /Invalid material/);
    assert.deepEqual(query(world), before);
    world.game_step(1 / 60); assert.equal(query(world).recoveries, 0);
  } finally { world.free(); }
});

test('native and Wasm hosts preserve contacts, propulsion, suspension, damage and blast outcomes', options, async () => {
  const wasm = await hostProbe('wasm', { kind: 'dynamics', steps: 240 }),
    native = await hostProbe('native', { kind: 'dynamics', steps: 240 });
  assert.equal(wasm.runtime, 'wasm'); assert.equal(native.runtime, 'native');
  for (let i = 0; i < wasm.rows.length; i++) {
    const comparison = compareDynamicsRows(wasm.rows[i], native.rows[i]);
    assert(comparison.pass, JSON.stringify({ name: wasm.rows[i].name, ...comparison }));
  }
});

test('Wasm remains selectable independently of a compiled native addon', () => {
  assert.deepEqual(nativeRuntimeInfo('wasm'), { runtime: 'wasm' });
  assert.throws(() => nativeRuntimeInfo('unknown'), /auto, native ou wasm/);
});
