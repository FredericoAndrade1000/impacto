import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { pageWorld } from '../src/trial-targets.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { plateCorners } from '../src/math.ts';
import { componentPolygon } from '../src/assembly.ts';
import { MAIN_WORLD } from '../src/battle-rules.ts';
import { cellOf } from '../src/grid.ts';

const close = (actual, expected) => assert(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const parts = world => [...world.plates.map(p => p.definition), ...world.modules];
const poses = world => parts(world).map(p => ({ x: p.x, y: p.y, angle: p.angle || 0 }));
const bottom = world => Math.min(...world.plates.flatMap(p => plateCorners(p.definition)).map(p => p.y),
  ...world.modules.flatMap(componentPolygon).map(p => p.y));

for (const template of ['bunker', 'outpost', 'guard-post', 'mining-site', 'oil-well']) for (const terrain of ['flat'])
  test(`${template}: the normal ${terrain} trial seats every fixed part together, in either direction`, t => {
    const source = createStructuredTemplate(template), before = structuredClone(source), blueprint = compileBlueprint(source),
      world = pageWorld(source, { terrain });
    t.after(() => world.dispose());
    if (template === 'bunker') assert.equal(blueprint.plates.find(p => p.id === 'hull:floor').thicknessMm, 100);
    for (const facing of [-1, 1]) {
      if (facing === 1) world.replaceActor(source, { id: 'local', x: 12, facing });
      assert.equal(world.actor('local').vehicle, null);
      close(bottom(world), .02);
      const delta = world.plates[0].definition.y - blueprint.plates[0].y;
      assert(delta < 0, 'the authored clearance must be removed before the first step');
      for (const [i, part] of [...blueprint.plates, ...blueprint.modules].entries()) {
        close(parts(world)[i].x, 12 - facing * (part.x - 12));
        close(parts(world)[i].y, part.y + delta);
      }
      world.game();
      const stood = poses(world), health = world.modules.map(m => m.health), y = world.actor('local').y;
      for (let i = 0; i < 120; i++) world.step();
      assert.deepEqual(poses(world), stood, 'a fixed structure stays at its admitted pose');
      assert.deepEqual(world.modules.map(m => m.health), health);
      assert.equal(world.actor('local').y, y);
      assert.equal(world.dynamics.recoveries, 0);
    }
    world.reset();
    close(bottom(world), .02);
    assert.deepEqual(source, before, 'placement must never rewrite the authored design');
  });

test('fixed actors admitted on a non-landscape can descend below the design altitude', t => {
  const source = createStructuredTemplate('bunker'), world = new World({ ...source, terrain: 'flat' }, { settle: true });
  t.after(() => world.dispose());
  world.removeActor('local');
  for (const facing of [-1, 1]) {
    const actor = world.addActor(source, { id: 'fixed', x: 12, facing });
    assert.equal(actor.vehicle, null); close(bottom(world), .02);
    world.removeActor('fixed');
  }
});

test('an authored ballistic scene keeps its explicit fixed altitude', t => {
  // Its floor lifted, in cells of the grid, to 1.6 m up the field.
  const base = createStructuredTemplate('bunker'), rise = cellOf(1.6 - 1.3) - base.nodes.find(node => node.id === 'hull-0').y,
    source = { ...base, terrain: 'flat', nodes: base.nodes.map(node => ({ ...node, y: node.y + rise })),
      components: base.components.map(part => ({ ...part, pose: { ...part.pose, y: part.pose.y + rise } })) },
    blueprint = compileBlueprint(source), world = new World(source),
    expectedBottom = 1.6 - base.plates.find(p => p.id === 'hull:floor').thicknessMm / 2000;
  t.after(() => world.dispose());
  close(bottom(world), expectedBottom);
  assert.deepEqual(poses(world), [...blueprint.plates, ...blueprint.modules].map(p => ({ x: p.x, y: p.y, angle: p.angle || 0 })));
  const stood = poses(world);
  for (let i = 0; i < 120; i++) world.step();
  assert.deepEqual(poses(world), stood);
  world.reset(); close(bottom(world), expectedBottom);
  world.removeActor('local');
  world.addActor(source, { id: 'authored', x: 12 });
  close(bottom(world), expectedBottom);
});

test('normal trials preserve vehicle admission and initial suspension poses', t => {
  const source = { ...createStructuredTemplate('truck'), terrain: 'flat' },
    trial = pageWorld(source), scene = new World(source);
  t.after(() => { trial.dispose(); scene.dispose(); });
  assert.deepEqual(poses(trial), poses(scene));
  assert.deepEqual(trial.vehicle.snapshot(), scene.vehicle.snapshot());
});

test('fixed structures retain their existing support on high world terrain', t => {
  const source = createStructuredTemplate('bunker'), world = new World({ ...source, terrain: MAIN_WORLD.terrain },
    { visualEvents: false, scene: { seed: MAIN_WORLD.seed, mapLength: MAIN_WORLD.mapLength, center: 12 } });
  t.after(() => world.dispose());
  const x = -1188, ground = world.terrain.height(x);
  assert(ground > 100);
  for (const facing of [-1, 1]) {
    world.replaceActor(source, { id: 'local', x, facing });
    const floor = world.plates.find(p => p.definition.id.endsWith('hull:floor')).definition,
      corners = plateCorners(floor), minX = Math.min(...corners.map(p => p.x)), maxX = Math.max(...corners.map(p => p.x)),
      under = [world.terrain.height(minX), world.terrain.height(maxX),
        ...world.terrain.points.filter(p => p.x > minX && p.x < maxX).map(p => p.y)],
      gap = bottom(world) - Math.max(...under);
    assert(gap >= .03 && gap <= .05, `world contact clearance ${gap}`);
    world.game(); const stood = poses(world);
    for (let i = 0; i < 60; i++) world.step();
    assert.deepEqual(poses(world), stood); assert.equal(world.dynamics.recoveries, 0);
  }
});
