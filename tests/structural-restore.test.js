import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { advance, dent, setPart } from './mechanical-queries.js';
import { chassisSpec } from '../src/chassis.ts';
import { CELL, cellOf } from '../src/grid.ts';
import { withChassisSuspension } from '../src/chassis-editing.ts';

const near = (a, b, label) => assert(Math.abs(a - b) < 1e-6, `${label}: ${a} != ${b}`);
const written = world => JSON.parse(JSON.stringify(world.keep()));
// Written in cells (grid.ts): the deck on the cell nearest that of its model, the floor on it, and each piece on the
// cell over where it stood in metres, clear of the plate under it; all of it then hung where the suspension of its frame
// reaches its wheels.
const design = (model, metal) => {
  const deck = cellOf(chassisSpec(model).deck - 1.3), floor = deck + cellOf(.004), up = metres => floor + Math.ceil(metres / CELL - 1e-9);
  return withChassisSuspension({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Retomada do chassi', terrain: 'flat', seed: 6173,
  chassis: { model, metal, points: [{ x: -60, y: deck }, { x: 60, y: deck }], thicknessMm: 20, ...(model === 'wheeled' ? { axles: [-40, 0, 40] } : {}) },
  nodes: [[-56, floor], [56, floor], [56, floor + 32], [-56, floor + 32]].map(([x, y], i) => ({ id: `n${i}`, x, y })),
  plates: ['floor', 'rear', 'roof', 'front'].map((side, i) => ({ id: `hull:${side}`, a: `n${i}`, b: `n${(i + 1) % 4}`,
    material: 'steel', thicknessMm: 8 })),
  components: [
    { id: 'engine', kind: 'engine', sizeScale: .5, pose: { x: -48, y: up(.224), angle: 0 } },
    { id: 'fuel', kind: 'fuel', sizeScale: .6, pose: { x: -25, y: up(.274), angle: 0 } },
    { id: 'ammo', kind: 'ammo', ammoPreset: 'm2hb', sizeScale: .6, pose: { x: 29, y: up(.224), angle: 0 } },
    { id: 'command', kind: 'command', pose: { x: 5, y: up(.874), angle: 0 } },
    { id: 'hopper', kind: 'hopper', sizeScale: .6, pose: { x: 22, y: up(1.874), angle: 0 } },
  ] }, 0);
};
function emptyWorld(t, source) {
  const world = new World(source); t.after(() => world.dispose());
  world.removeActor('local'); return world;
}
function operational(t, model, metal, fraction) {
  const source = design(model, metal), world = emptyWorld(t, source);
  world.addActor(source, { id: 'c1', ownerId: 'qa', x: 12 }); world.game();
  const part = kind => world.modules.find(m => m.kind === kind);
  setPart(world, part('fuel'), { fuelLitres: 1.234 }); setPart(world, part('ammo'), { rounds: 7 });
  setPart(world, part('hopper'), { cargo: { ferro: 80 } });
  setPart(world, part('engine'), { health: part('engine').maxHealth * .5 });
  for (const gear of world.modules.filter(m => ['wheel', 'track'].includes(m.kind)))
    setPart(world, gear, { health: gear.maxHealth * fraction });
  advance(world, 6);
  const wall = world.plates.find(p => p.id.endsWith(':hull:front'));
  dent(world, wall, { x: wall.definition.x, y: wall.definition.y }, .002, .04);
  const kept = written(world);
  assert(kept.plates.find(p => p.id === wall.id).dents.length, 'the saved hull has a real Native dent');
  assert.equal(Object.hasOwn(kept.actors[0].vehicle, 'drivetrain'), false, 'the save holds the parts, not their derived powertrain');
  return { source, kept, drivetrain: structuredClone(world.actor('c1').vehicle.drivetrain) };
}

for (const [model, metal, fraction] of [['wheeled', 'steel', 0], ['tracked', 'titanium', .4]])
  test(`${model}: current state keeps physical damage, ${fraction * 100}% gear health and reserves`, t => {
    const { kept, source } = operational(t, model, metal, fraction),
      wall = kept.plates.find(p => p.id.endsWith(':hull:rear')), removed = wall.physicalMass * .2;
    wall.physicalMass -= removed; wall.physicalInertia *= .8;
    kept.actors[0].vehicle.mass -= removed; kept.actors[0].vehicle.carrierMass -= removed;
    const input = structuredClone(kept), again = emptyWorld(t, source); again.resume(kept);
    assert.deepEqual(kept, input, 'resume does not rewrite its input');
    const restored = written(again);
    near(restored.actors[0].vehicle.mass, kept.actors[0].vehicle.mass, 'kept carrier mass');
    assert.deepEqual([restored.tick, restored.time], [kept.tick, kept.time]);
    for (const before of kept.plates) {
      const after = restored.plates.find(p => p.id === before.id);
      for (const key of ['massScale', 'physicalMass', 'physicalInertia', 'physicalCenterLocal', 'ballisticGrid', 'marks', 'dents'])
        assert.deepEqual(after[key], before[key], before.id + '.' + key);
    }
    for (const before of kept.modules) {
      const after = restored.modules.find(m => m.id === before.id);
      for (const key of ['maxHealth', 'health', 'physicalMass', 'physicalInertia', 'fuelLitres', 'rounds', 'cargo'])
        assert.deepEqual(after[key], before[key], before.id + '.' + key);
    }
  });

test('resume derives the same powertrain from damaged running gear, an engine and partly spent reserves', t => {
  const { kept, source, drivetrain } = operational(t, 'tracked', 'titanium', .4), again = emptyWorld(t, source);
  const before = structuredClone(kept); again.resume(kept);
  assert.deepEqual(kept, before, 'resume does not add a derived powertrain to its input');
  // The resumed hull is read back level from its plates as they stood tilted (game.rs), which agrees with the hull the
  // vehicle was admitted with to the rounding of that turn.
  const { drag, ...derived } = again.actor('c1').vehicle.drivetrain, { drag: admitted, ...expected } = drivetrain;
  assert.deepEqual(derived, expected); near(drag, admitted, 'drag');
  for (const key of ['groundGrip', 'groundLoad'])
    near(again.actor('c1').vehicle[key], kept.actors[0].vehicle[key], key);
});

test('resume refuses an incompatible saved plate grid instead of projecting its damage onto a new shape', t => {
  const { kept, source } = operational(t, 'wheeled', 'steel', .4), again = emptyWorld(t, source);
  kept.plates[0].ballisticGrid.nx++;
  assert.throws(() => again.resume(kept), /Construção salva de chapas que o projeto já não faz/);
});
