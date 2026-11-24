import test from 'node:test';
import assert from 'node:assert/strict';
import { damageConstruction,damageWorld,face,interior } from './damage-fixtures.js';
import { managedWorld, ownerState, physics, advance } from './mechanical-queries.js';

const box = t => damageWorld(t,{length:2,height:4,rideHeight:2,wallThickness:120,frontThickness:120});

test('a repeated aperture changes ballistic material once while carrier mass and collider stay fixed',t=>{
  const w=box(t),p=face(w,'roof'),before=ownerState(w,p),mass=before.state.mass;
  w.cutBody(p,{x:12,y:5.8},{x:12,y:6.2},.025);
  const area=p.remainingArea;assert(area<p.originalArea);
  w.cutBody(p,{x:12,y:5.8},{x:12,y:6.2},.025);
  assert.equal(p.remainingArea,area);
  const after=ownerState(w,p);assert.equal(after.state.mass,mass);
  assert.equal(after.body,before.body);assert.equal(after.colliders,before.colliders);
  assert.equal(w.index.raycast({x:12,y:5.8},{x:12,y:6.2}),null);
});
test('a closed internal explosion applies damage and one visual event without a retained gas solver',t=>{
  const w=box(t),before=physics(w),positions=w.plates.map(p=>p.nodes.map(n=>[n.x,n.y]));
  w.explode(12,4,100,3);
  assert.equal(w.stats.explosions,1);
  assert.equal(w.drainEvents().filter(e=>e.type==='explosion').length,1);
  assert(w.plates.some(p=>p.marks.length>0));
  advance(w,120);
  assert.equal(physics(w).bodies,before.bodies);
  assert.deepEqual(w.plates.map(p=>p.nodes.map(n=>[n.x,n.y])),positions);
  assert.equal(w.dynamics.recoveries,0);
});
test('native blast sampling damages the real material left between cut apertures',t=>{
  const w=damageWorld(t,{length:2,height:4,rideHeight:2,frontThickness:80}),p=face(w);
  for(const y of [3,3.3,3.6,4.7,5])w.cutBody(p,{x:10.8,y},{x:11.2,y},.025);
  const before=p.remainingArea;
  w.explode(10.8,4,410,5.2);advance(w,12);
  assert(p.marks.length>0);assert(p.remainingArea<=before);assert.equal(w.dynamics.recoveries,0);
});
test('cover at the closest point still allows damage through an exposed component edge',t=>{
  const source={frontThickness:180,components:[interior('engine',{x:-.65,y:.2675})]},origin={x:10.1,y:1.7},
    whole=damageWorld(t,source),w=damageWorld(t,source),engine=w.modules[0],p=face(w);
  // Behind the whole wall the blast reaches the engine with under a hundredth of its power.
  whole.explode(origin.x,origin.y,410,4);
  assert(engine.maxHealth-whole.modules[0].health<410*.01);
  // An aperture below the straight line to the engine leaves its nearest point behind that wall.
  w.cutBody(p,{x:10.3,y:1.42},{x:10.7,y:1.42},.17);
  assert.equal(w.index.raycast(origin,{x:engine.x-engine.width/2,y:origin.y},{ignoreIds:new Set([engine.id])})?.owner.id,p.id);
  w.explode(origin.x,origin.y,410,4);assert(engine.maxHealth-engine.health>410*.01);
});

test('an internal explosion damages a centred component without inventing radial thrust',t=>{
  for(const quarterTurns of [0,1]) {
    const part=interior('engine',{x:-.05,y:.5756666666666667,angle:quarterTurns*Math.PI/2});
    const w=damageWorld(t,{dynamic:true,chassis:'wheeled',length:4,height:3,components:[part]}),engine=w.modules[0],before=ownerState(w,engine).state;
    w.explode(engine.x,engine.y,50,4);
    const after=ownerState(w,engine).state;
    assert(engine.health<engine.maxHealth);assert.equal(after.vx,before.vx);assert.equal(after.vy,before.vy);
    assert.equal(after.omega,before.omega);assert.equal(after.mass,before.mass);
  }
});
