import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { damageConstruction,face } from './damage-fixtures.js';
import { createConstruction } from '../src/construction-templates.ts';
import { referenceScenario } from '../src/scenarios.ts';
import { ownerState, physics, impulse, flyRound, advance } from './mechanical-queries.js';

function worldFor(t, blueprint) {
  const w = new World(blueprint);
  t.after(() => w.dispose());
  return w;
}
const mass=w=>physics(w).bodyStates.reduce((sum,b)=>sum+b.mass,0);
const metalBlueprint = (thickness=20) => damageConstruction({length:4,height:2,rideHeight:1,frontThickness:thickness});
const enclosure = () => damageConstruction({length:4,height:2,rideHeight:.65,frontThickness:80,wallThickness:80});

test('perforation opens local ballistic material while keeping stable external native contacts', t => {
  const world = worldFor(t, metalBlueprint(80)), plate = face(world), initial = mass(world),
    colliders = ownerState(world, plate).colliders, bodies = physics(world).bodies;
  // The round starts in front of the wall and is spent a few centimetres behind it, inside the hull.
  flyRound(world,{x:9.8,y:2,vx:1100,vy:0,mass:5,caliberMm:120,power:900,radius:.06,ammo:'ap',life:2,age:.1,visited:new Set()},.0003);
  const events=world.drainEvents(),rays=events.filter(e=>e.type==='secondary-ray'&&e.internal),
    penetration=events.find(e=>e.type==='penetration'&&e.id===plate.id);
  assert(penetration);
  const consumed=penetration.energy*(1-penetration.remaining/penetration.power);
  assert(plate.integrity > .9 && plate.integrity < 1);
  assert.equal(rays.length,3);
  assert(rays.reduce((sum,r)=>sum+r.energyBudget,0)<=consumed*.08+1e-4);
  assert(rays.every(r=>r.energySpent>=0&&r.energySpent<=r.energyBudget+1e-8));
  assert(events.filter(e=>e.type==='secondary-impact').every(e=>e.instantaneous&&e.impulse===0));
  assert.equal(world.projectiles.filter(p=>p.fragment).length,0);
  assert.equal(ownerState(world, plate).colliders, colliders);
  assert.equal(world.index.raycast({ x: 9, y: 2 }, { x: 11, y: 2 }), null);
  assert(world.index.raycast({ x: 9, y: 2.6 }, { x: 11, y: 2.6 }));
  assert(Math.abs(mass(world) - initial) < 1e-7);
  assert.equal(physics(world).bodies, bodies, 'secondary projectiles allocate no rigid bodies');
});

test('a confined explosion records local damage without creating mechanical pressure or loose bodies',t=>{
  const w=worldFor(t,enclosure()),initial=mass(w),
    before=w.plates.map(p=>p.nodes.map(n=>[n.x,n.y])),bodyCount=physics(w).bodies;
  w.explode(12,1.65,100,2.5);
  assert(w.drainEvents().some(e=>e.type==='explosion'));assert(w.plates.some(p=>p.marks.length>0));
  advance(w,120);assert.equal(mass(w),initial);assert.equal(physics(w).bodies,bodyCount);
  assert.deepEqual(w.plates.map(p=>p.nodes.map(n=>[n.x,n.y])),before);
  assert.equal(w.dynamics.recoveries||0,0);
});
test('render observations cannot change instantaneous blast damage or subsequent physics',t=>{
  const a=worldFor(t,enclosure()),b=worldFor(t,enclosure());
  for(const w of [a,b])w.explode(12,1.65,100,2.5);
  for(let i=0;i<40;i++){a.step();b.step();a.snapshot();a.snapshot();}
  assert.deepEqual(a.stats,b.stats);assert.deepEqual(a.plates.map(p=>p.snapshot()),b.plates.map(p=>p.snapshot()));
  assert.deepEqual(physics(a),physics(b));
});
test('a shallow crater keeps the rear wall ballistic resistance and does not become a through-hole',t=>{
  const w=worldFor(t,enclosure()),wall=face(w);
  const removed=w.cutBody(wall,{x:9.96,y:1.65},{x:9.979,y:1.65},.008);
  assert(removed.length);assert(wall.remainingArea<wall.originalArea);
  assert(w.index.raycast({x:9.9,y:1.65},{x:10.1,y:1.65}));
});
test('a small true projectile aperture is queryable even without a pressure or vent solver',t=>{
  const w=worldFor(t,enclosure()),wall=face(w),r=.00762/2;
  assert(w.cutBody(wall,{x:9.9,y:1.65},{x:10.1,y:1.65},r).length);
  assert.equal(w.index.raycast({x:9.9,y:1.65},{x:10.1,y:1.65}),null);
  assert(w.index.raycast({x:9.9,y:1.7},{x:10.1,y:1.7}));
});
test('distributed wall loads are aggregated without losing total impulse or moment', t => {
  const world = worldFor(t, createConstruction('heavy')), plate = face(world,'roof');
  const before = ownerState(world, plate).state, center = before.center,
    loads = [{ point: { x: 11, y: 2.9 }, x: 40, y: -25 }, { point: { x: 13, y: 2.9 }, x: -10, y: 31 }];
  for (const load of loads) impulse(world, plate, load.point, load);
  const after = ownerState(world, plate).state, moment = loads.reduce((sum, l) => sum +
    (l.point.x - center.x) * l.y - (l.point.y - center.y) * l.x, 0);
  assert(Math.abs(after.mass * (after.vx - before.vx) - 30) < .002);
  assert(Math.abs(after.mass * (after.vy - before.vy) - 6) < .002);
  assert(Math.abs(after.inertia * (after.omega - before.omega) - moment) < .002);
});
