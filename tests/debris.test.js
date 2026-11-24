import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import {damageConstruction,face} from './damage-fixtures.js';
import { managedWorld, physics, ownerState, advance } from './mechanical-queries.js';
test('the fragments of a blast are rays: no round in the air and no solver body',t=>{
  const w=managedWorld(t,createConstruction('heavy')),before=physics(w);
  w.explode(11,2,300,3);advance(w,1);
  assert(w.stats.secondaryShots>0);assert.equal(w.projectiles.length,0);
  assert.equal(physics(w).bodies,before.bodies);
});
test('damage can remove all ballistic material without changing carrier mass, inertia or contacts',t=>{
  // The thick floor remains installed on its wheeled carrier throughout the damage assay.
  const w=managedWorld(t,damageConstruction({dynamic:true,chassis:'wheeled',length:2,height:2,thicknesses:{floor:100}})),p=face(w,'floor'),before=ownerState(w,p);
  w.cutBody(p,{x:p.definition.x,y:p.definition.y},{x:p.definition.x,y:p.definition.y},3);const after=ownerState(w,p);
  assert.equal(p.remainingArea,0);assert.equal(after.body,before.body);
  assert.equal(after.state.mass,before.state.mass);assert.equal(after.state.inertia,before.state.inertia);
  assert.equal(after.colliders,before.colliders);
});
