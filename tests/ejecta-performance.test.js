import test from 'node:test';
import assert from 'node:assert/strict';
import {damageConstruction,face} from './damage-fixtures.js';
import { managedWorld, ownerState, physics, setVehicle } from './mechanical-queries.js';
import { armorGrid } from './armor-grid-contract.js';

for(const angle of [0,.73,Math.PI/2])
  test(`complete ballistic erosion retains the physical carrier without creating debris at ${angle}`,t=>{
    // Its thick floor and front remain mounted on the wheeled carrier.
    const w=managedWorld(t,damageConstruction({dynamic:true,chassis:'wheeled',length:1.6,height:2,thicknesses:{floor:120}}));
    setVehicle(w,{angle});const p=face(w,'floor'),before=ownerState(w,p),
      nodes=p.nodes.map(n=>({...n.local})),indices=[...p.activeIndices];
    w.cutBody(p,{x:p.definition.x,y:p.definition.y},{x:p.definition.x,y:p.definition.y},2);
    const after=ownerState(w,p),grid=armorGrid(p);
    assert.equal(grid.cells.length,0);assert.equal(w.projectiles.length,0);
    assert(!w.drainEvents().some(e=>e.type==='secondary-ray'), 'a lab cut never creates another damage source');
    assert.deepEqual(p.nodes.map(n=>n.local),nodes);assert.deepEqual([...p.activeIndices],indices);
    // The frame of the chassis lies under the floor, and its middle axle beside it: across the floor, the ray leaves
    // out what the chassis brings.
    const c=Math.cos(p.definition.angle),sn=Math.sin(p.definition.angle),mid=p.definition,
      chassis=new Set([...w.plates,...w.modules].map(part=>part.id).filter(id=>id.startsWith('chassis:')));
    assert.equal(w.index.raycast({x:mid.x-sn*.2,y:mid.y+c*.2},{x:mid.x+sn*.2,y:mid.y-c*.2},{ignoreIds:chassis}),null);
    assert.equal(after.body,before.body);assert.equal(after.state.mass,before.state.mass);
    assert.equal(after.state.inertia,before.state.inertia);assert.equal(p.remainingArea,0);
    assert.equal(physics(w).bodies,1);
  });

test('severing local material preserves the installed frame without extra contact bodies', t => {
  const w=managedWorld(t,damageConstruction({frontThickness:100})),p=face(w),
    before=physics(w),ownerBefore=ownerState(w,p),contours=structuredClone(w.actor().contactContours),
    a=w.cutBody(p,{x:10.2,y:1.1},{x:10.8,y:1.1},.07),z=w.cutBody(p,{x:10.2,y:2.2},{x:10.8,y:2.2},.07);
  assert(contours.length>0&&contours.every(contour=>contour.length>=3));
  assert(a.length||z.length);
  w.dirty = true; w.step();
  const after=physics(w),ownerAfter=ownerState(w,p);
  assert.equal(after.bodies,1);
  assert(before.colliders>0);assert.equal(after.colliders,before.colliders);
  assert.equal(ownerAfter.body,ownerBefore.body);assert.equal(ownerAfter.state.mass,ownerBefore.state.mass);
  assert.equal(ownerAfter.state.inertia,ownerBefore.state.inertia);
  assert.deepEqual(w.actor().contactContours,contours,'ballistic cells never rebuild the rigid contact contours');
});
