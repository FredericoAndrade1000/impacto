import test from 'node:test';
import assert from 'node:assert/strict';
import { createStructuredTemplate as createConstruction } from '../src/structured-templates.ts';
import { duel } from './helpers/duel.js';

// The contact margin used to start inside uneven ground. The solver then
// injected recovery energy during the quiet admission step, before any
// action, and froze the vehicles where they came in.
for (const [template, terrain] of [['ifv', 'rough'], ['heavy', 'rough'], ['heavy', 'sand']])
  test(`${template} settles on ${terrain} without contact-margin energy recovery`, t => {
    const world = duel(t, createConstruction(template), { terrain });
    const check = () => {
      const p = world.game().call({ op: 'physics' });
      assert.equal(p.recoveries, 0);
      assert.equal(p.energy.last.invalid, 0);
      assert(p.bodyStates.every(b => Number.isFinite(b.x + b.y + b.vx + b.vy + b.omega)));
      assert.equal(p.bodies, 2);
    };
    check();
    for (let frame = 0; frame < 60; frame++) world.step();
    check();
    assert.equal(world.stats.shots, 0);
    assert.equal(world.stats.explosions, 0);
  });
