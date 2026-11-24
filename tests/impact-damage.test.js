import test from 'node:test';
import assert from 'node:assert/strict';
import { referenceScenario } from '../src/scenarios.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { damageConstruction,face } from './damage-fixtures.js';
import { managedWorld,ownerState,dent,flyRound } from './mechanical-queries.js';
test('an explosive surface hit damages brittle material locally without losing carrier mass',t=>{
  const w=managedWorld(t,damageConstruction({material:'concrete',frontThickness:300,height:3,rideHeight:.2})),p=face(w),before=ownerState(w,p);
  w.fire({x:10.5,y:1.7},{id:'autocannon',preset:'m242',ammo:'he',spread:0},true);for(let i=0;i<60;i++)w.step();
  assert.equal(w.stats.explosions,1);assert(p.integrity>.9&&p.integrity<1);
  assert(p.attached && p.remainingArea > 0);
  assert.equal(ownerState(w,p).state.mass,before.state.mass);
  assert(w.index.raycast({x:10,y:2.6},{x:11,y:2.6}),'untouched material still resists ballistics');
});
test('destroying rigid running gear preserves its carrier, mass and ballistic obstacle',t=>{
  const w=managedWorld(t,createConstruction('heavy')),m=w.modules.find(m=>m.kind==='track'),before=ownerState(w,m);
  // A round far beyond what a track stands, flown level into its leading end from two centimetres off it and spent inside.
  flyRound(w,{x:m.x-m.width/2-.02,y:m.y,vx:600,vy:0,power:10000,radius:.05,mass:.2,caliberMm:100,ammo:'ap'},.0001);
  assert.equal(w.stats.penetrations,1);assert.equal(m.health,0);assert(m.attached);
  const after=ownerState(w,m);assert.equal(after.body,before.body);assert.equal(after.state.mass,before.state.mass);
  assert.equal(after.state.inertia,before.state.inertia);
  assert(w.index.raycast({x:m.x-m.width,y:m.y},{x:m.x+m.width,y:m.y}));
});
test('asymmetric ballistic erosion and visual dents never recenter the physical carrier',t=>{
  const w=managedWorld(t,createConstruction('heavy')),p=w.plates[0],before=ownerState(w,p),
    at=p.materialPosition({u:.75,v:.5}),remote=p.materialPosition({u:.25,v:.5});
  w.cutBody(p,{x:at.x,y:at.y-.3},{x:at.x,y:at.y+.3},.04);dent(w,p,remote,.005);
  const after=ownerState(w,p);assert.equal(after.body,before.body);
  assert.equal(after.state.mass,before.state.mass);assert.equal(after.state.inertia,before.state.inertia);
  assert.deepEqual(after.state.center,before.state.center);
  assert.deepEqual(p.materialPosition({u:.25,v:.5}),remote);
  assert.equal(p.materialPosition({u:.75,v:.5}),null);
});
