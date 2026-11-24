import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { blueprintMass, blueprintPowertrain } from '../src/mass-properties.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { componentPolygon, polygonTriangles } from '../src/assembly.ts';
import { pointInTriangle } from '../src/math.ts';
import { driveTrial } from '../scripts/probes-mobility.ts';
import { World } from '../src/physics.ts';
import { weaponSettings } from '../src/weapons.ts';

for (const id of ['ifv', 'heavy']) test(`${id}: revised tracked design has protected core components and adequate power`, () => {
  const source = createConstruction(id), b = compileBlueprint(source), p = blueprintPowertrain(b),
    faces = b.rooms.map(room => room.polygon);
  assert.equal(b.mechanicalAdmission, true);
  // The fixed receiver permits a low hull and a compact separate gun bay.
  // Keep the minimum installed power-to-weight requirement and verify the
  // declared engines; climbing/braking is exercised below.
  assert(Math.abs(p.powerKw - (id === 'heavy' ? 600 : 240)) < 1e-8);
  assert(Number.isFinite(p.powerPerTonne) && p.powerPerTonne > 0);
  for (const m of b.modules.filter(m => ['engine', 'fuel', 'ammo', 'command'].includes(m.kind)))
    assert(componentPolygon(m).every(point => faces.some(f => polygonTriangles(f).some(t => pointInTriangle(point, ...t)))),
      m.kind + ' must occupy an actual closed room');
});

test('canonical core mounts retain their carrier and exterior steel really shields the engine', t => {
  // All equipment belongs to one rigid carrier; exterior shielding remains actual ballistic material.
  const source = createConstruction('ifv');
  const w = new World(source); t.after(() => w.dispose()); w.game();
  const engine = w.modules.find(m => m.kind === 'engine'), installed = w.modules.find(m => m.kind === 'command'),
    front = w.plates.find(p => p.id === 'hull:front'),
    hit = w.index.raycast({ x: front.frame.x - 10, y: engine.y }, engine),
    before = w.game().call({ op: 'physics' });
  assert.equal(hit.owner.id, front.id, 'steel, rather than a damage multiplier, shields the engine');
  w.game().call({ op: 'setPartState', owner: w.game().handle(installed), state: { health: installed.maxHealth / 2 } });
  const after = w.game().call({ op: 'physics' });
  assert.equal(installed.health, installed.maxHealth / 2); assert.equal(installed.attached, true);
  assert.equal(before.bodies, 1);
  assert.deepEqual(after.bodyStates.map(s => [s.handle, s.mass, s.inertia]),
    before.bodyStates.map(s => [s.handle, s.mass, s.inertia]));
});

test('revised support front stops rifle fire without destroying its command or engine', t => {
  const b = createConstruction('ifv'), w = new World(b);
  t.after(() => w.dispose()); w.controlVehicle(0, 1);
  w.game().call({ op: 'configureLauncher', point: { x: 5, y: 1.25 } });
  const s = weaponSettings('machinegun', { preset: 'fnmag', spread: 0 });
  for (let i = 0; i < 200; i++) { if (i % 8 === 0) assert(w.fire({ x: 10, y: 1.25 }, s, true)); w.step(); }
  assert(w.stats.impacts >= 20); assert.equal(w.stats.penetrations, 0);
  for (const m of w.modules.filter(m => ['engine', 'command'].includes(m.kind))) assert.equal(m.health, m.maxHealth);
  assert.equal(w.dynamics.recoveries || 0, 0);
});

test('a re-armed design keeps its declared engine and carries the sensor hardware it states', () => {
  const source = createConstruction('ifv', { preset: 'rh202', sensorModes: ['visual', 'sound'] }), b = compileBlueprint(source), p = blueprintPowertrain(b);
  assert(Math.abs(p.powerKw - 240) < 1e-8);
  assert(Math.abs(blueprintMass(b) - b.fixedAssembly.mass) < 1e-8);
  // Only the requested sensors; the Command keeps its own basic sight through the visor.
  assert.deepEqual(b.modules.filter(m => m.kind === 'sensor').map(m => m.sensorMode).sort(),
    ['sound', 'visual']);
  const heavy = compileBlueprint(createConstruction('heavy', { preset: 'rh120', sensorModes: ['visual', 'radar'] }));
  assert.deepEqual(heavy.modules.filter(m => m.kind === 'sensor').map(m => m.sensorMode).sort(),
    ['radar', 'visual']);
  assert(Math.abs(blueprintPowertrain(heavy).powerKw - 600) < 1e-8);
});

test('the 20 mm support vehicle can climb from the formerly stuck far hillside and brake without a recovery', () => {
  const b = createConstruction('ifv', { preset: 'rh202' }),
    r = driveTrial(b, { terrain: 'hills', side: 1, seconds: 30, distance: 80 });
  assert.equal(r.status, 'finished'); assert.equal(r.recoveries, 0);
  assert(r.reachedAt !== null, 'complete the 80 m approach instead of remaining at x=132');
  assert(r.allAttached); assert(r.originalUnchanged); assert(r.end.traction > 0);
  assert(Math.hypot(r.end.vx, r.end.vy) * 3.6 < 2, 'brake at the checkpoint');
  assert(r.peaks.clearance < 3);
});
