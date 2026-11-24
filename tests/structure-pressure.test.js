import test from 'node:test';
import assert from 'node:assert/strict';
import { damageConstruction,face } from './damage-fixtures.js';
import { createConstruction } from '../src/construction-templates.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { parseBlueprint, serializeBlueprint, validateBlueprint, compileBlueprint } from '../src/persistence.ts';
import { BODY_WIDTH } from '../src/component-size.ts';
import { regionGeometry,regionContains } from '../src/scene-frame.ts';
import { polygonProperties } from '../src/damage-regions.ts';
import { physics, ownerState, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { armorGrid } from './armor-grid-contract.js';

const mass = w => physics(w).bodyStates.reduce((sum,b)=>sum+b.mass,0);
const boxBlueprint = () => damageConstruction({length:4,height:2,rideHeight:.6,frontThickness:120,wallThickness:120});

test('cell-quantized cutting retains material outside its bounded footprint and preserves mass', (t) => {
  const b=damageConstruction({length:2,height:2,rideHeight:2,thicknesses:{floor:120}});
  const w = managedWorld(t, b),
    p = face(w,'floor'),
    original = mass(w),
    before = p.remainingArea;
  const removed = w.cutBody(p, { x: 12, y: 1.8 }, { x: 12, y: 2.2 }, 0.008);
  assert(removed.length);

  const grid=armorGrid(p),radius=.008;
  assert(before-p.remainingArea <= (2*radius+2*grid.dx)*.12+1e-12);
  for(const sign of [-1,1]){
    const x=12+sign*(radius+grid.dx+.001);
    assert(w.index.raycast({x,y:1.8},{x,y:2.2}), 'cells outside the quantization footprint remain intact');
  }
  assert(Math.abs(mass(w) - original) < 1e-7);
  assert.equal(w.index.raycast({ x: 12, y: 1.8 }, { x: 12, y: 2.2 }), null);
});



test('material refinement cannot disconnect untouched neighbouring cells or erase remote supports', t => {
  const b=damageConstruction({length:2,height:2,rideHeight:2,thicknesses:{floor:140}});
  const w = managedWorld(t, b), p = face(w,'floor');
  const removed = w.cutBody(p, { x: 11.65, y: 2.06 }, { x: 11.7, y: 2.08 }, 0.014);
  assert(removed.length);
  assert(p.attached);
  for (let i = 0; i < p.activeIndices.length; i += 3)
    assert(polygonProperties(Array.from(p.activeIndices.subarray(i, i+3), id => p.nodes[id].local)).area > 0);
});







test('local damage and explosions never separate the assembly or change its physical mass',t=>{
  const w=managedWorld(t,boxBlueprint()),p=face(w,'rear'),before=physics(w),initial=mass(w);
  w.cutBody(p,{x:13.8,y:1.6},{x:14.2,y:1.6},.025);
  assert.equal(w.index.raycast({x:13.8,y:1.6},{x:14.2,y:1.6}),null);
  w.explode(12,1.6,100,2.5);advance(w,120);
  assert.equal(mass(w),initial);assert.equal(physics(w).bodies,before.bodies);
  assert(w.plates.some(p=>p.marks.length>0));assert.equal(w.dynamics.recoveries,0);
});
test('reset removes local damage and old explosion events without keeping pressure cells',t=>{
  const w=managedWorld(t,boxBlueprint()),p=face(w,'roof');
  w.cutBody(p,{x:12,y:2.4},{x:12,y:2.8},.2);w.explode(12,1.6,100,2.5);
  assert(w.plates.some(p=>p.integrity<1));assert(w.drainEvents().some(e=>e.type==='explosion'));
  w.reset();assert(w.plates.every(p=>p.integrity===1));
  assert.deepEqual(w.drainEvents(),[]);
});
test('destroying running gear preserves its carrier and the material shielding behind it',t=>{
  const w=managedWorld(t,createConstruction('heavy')),m=w.modules.find(m=>m.kind==='track'),before=ownerState(w,m);
  // A round put two centimetres short of the end of the track that goes into it and is spent there.
  flyRound(w,{x:m.x-m.width/2-.02,y:m.y,vx:600,vy:0,power:m.maxHealth*2,mass:.2,caliberMm:25,radius:.0125,ammo:'ap'},.0002);
  assert.equal(m.health,0);assert(m.attached);
  const after=ownerState(w,m);assert.equal(after.body,before.body);assert.equal(after.state.mass,before.state.mass);
  assert(w.index.raycast({x:m.x-m.width,y:m.y},{x:m.x+m.width,y:m.y}));
});
test('every construction is as wide as the next: none authors its width, and one that does is rejected',()=>{
  const b=damageConstruction();
  assert.equal(Object.hasOwn(parseBlueprint(serializeBlueprint(b)),'widthM'),false);
  const compiled=compileBlueprint(b);assert.equal(compiled.frame.widthM,BODY_WIDTH);
  for(const plate of compiled.plates)assert.equal(plate.widthM,BODY_WIDTH);
  for(const width of [BODY_WIDTH,3.2,-1])assert.throws(()=>validateBlueprint({...b,widthM:width}),{ reason: 'AUTHORING_FIELDS' });
  assert.throws(()=>parseBlueprint(JSON.stringify({...b,widthM:BODY_WIDTH})),{ reason: 'AUTHORING_FIELDS' });
  b.plates[0].widthM=BODY_WIDTH;assert.throws(()=>validateBlueprint(b),{ reason: 'AUTHORING_FIELDS' });
});

test('a real material cut reaches the next network frame with the same damage and derived geometry', (t) => {
  const w = managedWorld(t, boxBlueprint()),
    state = w.snapshot(),
    writer = new FrameWriter(),
    reader = new FrameReader();
  assert(reader.decode(writer.encode({ state, events: [] }, true)));
  const p = face(w), before = state.plates.find(plate => plate.id === p.id), point = { x: 10, y: 1.6 },
    start = { x: 9.8, y: 1.6 }, end = { x: 10.2, y: 1.6 };
  assert(regionContains(before, point)); assert(w.index.raycast(start, end));
  assert(w.cutBody(p, start, end, 0.015).length > 0);
  const next = w.snapshot(),
    packet = reader.decode(writer.encode({ state: next, events: [] }));
  assert(packet);
  const decoded = packet.state.plates.find(plate => plate.id === p.id), current = next.plates.find(plate => plate.id === p.id);
  assert.equal(w.index.raycast(start, end), null); assert.equal(regionContains(current, point), false);
  assert.equal(regionContains(decoded, point), false); assert.notEqual(decoded.revision, before.revision);
  assert.equal(decoded.revision, current.revision); assert.deepEqual(decoded.solidRegions, current.solidRegions);
  assert.deepEqual(regionGeometry(decoded), regionGeometry(current));
});

test('derived drawing retains multiple apertures and exactly the mechanical material area', t => {
  const b=damageConstruction({length:2,height:2,rideHeight:2,thicknesses:{floor:600}});
  const w = managedWorld(t, b), plate = face(w,'floor');
  for(const x of [11.7,12.3])w.cutBody(plate,{x,y:1.9},{x,y:2.1},.09);
  const snapshot=plate.snapshot(),geometry=regionGeometry(snapshot),
    area=geometry.polygons.reduce((sum,p)=>sum+polygonProperties(p).area,0);
  assert(Math.abs(area-plate.remainingArea)<1e-8);
  for(const x of [11.7,12.3])assert.equal(regionContains(snapshot,{x,y:2}),false);
  assert(regionContains(snapshot,{x:12,y:2}));
  assert.equal(plate.nodes.length,4);assert.equal(plate.activeIndices.length,6);
});
