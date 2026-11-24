import test from 'node:test';
import assert from 'node:assert/strict';
import { damageWorld,face,interior } from './damage-fixtures.js';
import { dent,ownerState,setPart,materialState } from './mechanical-queries.js';
test('ballistic material bindings survive dents and disappear only at a real local perforation',t=>{
  const w=damageWorld(t,{length:1,height:2,rideHeight:2,thicknesses:{floor:600}}),p=face(w,'floor'),uv={u:.75,v:.5},
    original=p.materialPosition(uv),before=ownerState(w,p);
  dent(w,p,original,.006,.02);assert.deepEqual(p.materialPosition(uv),original);
  const revision=p.revision;w.cutBody(p,{x:original.x-.1,y:original.y-.4},{x:original.x+.1,y:original.y+.4},.06);
  assert(p.revision>revision);assert.equal(p.materialPosition(uv),null);assert.equal(p.materialPosition(uv),null);
  assert.equal(ownerState(w,p).state.mass,before.state.mass);
  w.reset();assert.deepEqual(face(w,'floor').materialPosition(uv),original);
});
test('failed components remain rigid material at the same local UV instead of becoming a casing body',t=>{
  const w=damageWorld(t,{components:[interior('engine',{x:-.65,y:.2675})]}),m=w.modules[0],point={x:m.x+m.width/4,y:m.y},uv=materialState(w,m,point).uv,
    pose={x:m.x,y:m.y,angle:m.angle},before=ownerState(w,m);
  assert(Math.abs(uv.x-.75)<1e-9&&Math.abs(uv.y-.5)<1e-9);
  setPart(w,m,{health:0});assert.equal(m.health,0);
  assert.deepEqual(materialState(w,m,point).uv,uv);assert.deepEqual({x:m.x,y:m.y,angle:m.angle},pose);
  assert.equal(ownerState(w,m).body,before.body);
});
