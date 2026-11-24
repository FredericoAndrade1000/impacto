import test from 'node:test';
import assert from 'node:assert/strict';
import { FIXED_DT } from '../src/physics.ts';
import {damageConstruction,face,interior} from './damage-fixtures.js';
import {reviewSecondary} from '../scripts/probes-secondary.ts';
import { groundResponse } from '../src/ground-impact.ts';
import { ownerState, physics, setVehicle, placeRound, flyRound, managedWorld, advance } from './mechanical-queries.js';
import { armorGrid } from './armor-grid-contract.js';
import { predictImpact } from '../src/impact-preview.ts';
import { referenceScenario, applyReferenceScene } from '../src/scenarios.ts';
import { FrameWriter, FrameReader, UNREAD_EVENT_FIELDS } from '../src/network-protocol.ts';
import { shotCount } from '../src/shots.ts';

const target=(thickness=80)=>damageConstruction({frontThickness:thickness,components:[interior('engine',{x:-.65,y:.2675})]});
// A real charge that loads one wall: it goes off five centimetres off the face and reaches a quarter of a
// metre, so that the wall takes the dose where it is nearest and nothing else is within the blast.
const STANDOFF=.05,REACH=.25,charge=dose=>dose/(1-STANDOFF/REACH)**1.5;
const blast=(w,point,normal,dose)=>w.explode(point.x+normal.x*STANDOFF,point.y+normal.y*STANDOFF,charge(dose),REACH);
function strike(w,dose=650){const p=face(w);blast(w,{x:p.definition.x-p.definition.thicknessMm/2000,y:p.definition.y},{x:-1,y:0},dose);}
const shot = (overrides = {}) => ({ id: 'round', x: 0, y: .1, vx: 120, vy: -12, mass: .1, caliberMm:20,
  ammo: 'ap', power: 100, radius: .01, age: 0, visited: new Set(), ...overrides });
const rays = events => events.filter(e => e.type === 'secondary-ray' && e.internal);
// A blast of that power gives the walls it flakes or opens a quarter of the tenth of its energy that does
// mechanical work, as one internal ray from each. Its other rays leave the charge itself.
const checkBurst = (events, power = charge(650)) => {
  const burst = rays(events);
  assert.equal(burst.length, 1, 'the one wall that responds throws one representative internal ray');
  const budget = burst.reduce((sum,r) => sum+r.energyBudget, 0);
  assert(Math.abs(budget-power*200*.1*.25) < 1e-8, 'the internal ray carries the whole share of the blast allotted to spall');
  assert(burst.every(r => r.energySpent >= 0 && r.energySpent <= r.energyBudget+1e-8));
  assert(events.filter(e=>e.type==='secondary-impact').every(e=>e.instantaneous && e.impulse===0));
  return burst;
};

test('a strong blast flakes the rear face locally without perforating or detaching the metal plate', t => {
  const w = managedWorld(t, target()), p = face(w), before = ownerState(w, p);
  strike(w);
  const burst = checkBurst(w.drainEvents());
  assert.equal(w.stats.spallBursts, 1);
  assert(burst.every(r=>r.x>10.535 && r.endX>r.x));
  assert.equal(w.projectiles.length,0);
  const grid=armorGrid(p),depth=Math.min(.08*.065,.012),radius=Math.sqrt(650)*.0075*.35;
  assert(p.integrity<1&&p.attached);
  assert(p.originalArea-p.remainingArea <= (2*radius+2*grid.dx)*(depth+grid.dy)+1e-12,
    'tangential flake width cannot deepen its shallow normal damage beyond one grid row');
  const retainedRows=grid.ny-Math.ceil(depth/grid.dy);
  for(let y=0;y<retainedRows;y++)for(let x=0;x<grid.nx;x++)
    assert(grid.occupied(y*grid.nx+x),'front and deep material must remain intact');
  assert.equal(p.perforations.length, 0, 'a shallow rear flake cannot vent the wall');
  const spans = p.solidSpans(); assert.equal(spans.length, 1);
  assert(Math.abs(spans[0].lo) < 1e-10 && Math.abs(spans[0].hi - 1) < 1e-10);
  assert(w.index.raycast({ x: 10.2, y: 1.7 }, { x: 10.8, y: 1.7 }), 'remaining material still blocks a shot');
  const after = ownerState(w, p);
  assert.equal(after.body, before.body); assert.equal(after.state.mass, before.state.mass);
  assert.equal(after.state.inertia, before.state.inertia);
});

test('weak loads, thick armour and neighbouring visual dents do not emit rear spall', t => {
  for (const [thickness, dose] of [[80, 100], [180, 650]]) {
    const w = managedWorld(t, target(thickness));
    strike(w, dose);
    assert.equal(w.stats.spallBursts, 0); assert.equal(w.projectiles.length, 0);
    assert.equal(rays(w.drainEvents()).length,0);
  }
  // A wide charge loads the wall where it is nearest and, with 0.65 of the blast there, at a point to either
  // side. Each side takes a dose that flakes this wall at the nearest point of a blast; as a neighbour it only dents.
  const w = managedWorld(t, target()), p = face(w), power = 690, reach = 10, off = .1;
  w.explode(p.definition.x - p.definition.thicknessMm / 2000 - off, p.definition.y, power, reach);
  const events = w.drainEvents(), dents = [...p.dents.values()].sort((a, b) => a.u - b.u), flakes = events.filter(e => e.type === 'spall');
  assert.equal(dents.length, 3, 'the nearest point and its two neighbours are dented');
  for (const dent of [dents[0], dents[2]]) {
    const along = Math.abs(dent.u - .5) * p.definition.length, alone = managedWorld(t, target());
    assert(along > .2, 'a neighbour is a separate point of the wall');
    strike(alone, power * (1 - Math.hypot(off, along) / reach) ** 1.5 * .65);
    assert.equal(alone.stats.spallBursts, 1, 'the dose of a neighbour flakes the wall on its own');
  }
  assert.equal(w.stats.spallBursts, 1); assert.equal(w.projectiles.length, 0);
  assert.equal(flakes.length, 1); assert(Math.abs(flakes[0].y - p.definition.y) < 1e-9, 'the one flake is behind the nearest point');
  assert.equal(rays(events).length, 1);
});

for (const angle of [0, .6, -1.1]) test(`instantaneous rear-face directions follow the rigid plate at ${angle} rad`, t => {
  const b=damageConstruction({dynamic:true,frontThickness:80});const w=managedWorld(t,b);
  setVehicle(w,{y:20,angle});const p=face(w),normal={x:-Math.cos(angle),y:-Math.sin(angle)},
    point={x:p.definition.x+normal.x*.04,y:p.definition.y+normal.y*.04};
  blast(w, point, normal, 650);
  assert.equal(w.stats.spallBursts, 1);
  const burst=checkBurst(w.drainEvents());
  assert(burst.every(r=>(r.endX-r.x)*-normal.x+(r.endY-r.y)*-normal.y>0));
  assert.equal(w.projectiles.length,0);
  for(const r of burst) assert.equal(w.index.raycast({x:r.x,y:r.y},
    {x:r.x-normal.x*.03,y:r.y-normal.y*.03}),null,
    'each ray originates beyond the surviving rear material, not inside its source');
});

test('rear spall intersects an exposed mechanism and real shared armour intercepts it',()=>{
  const bare=reviewSecondary({blast:true,thickness:80}),covered=reviewSecondary({blast:true,thickness:80,shield:40});
  checkBurst(bare.raysAtImpact,bare.blastPower);checkBurst(covered.raysAtImpact,covered.blastPower);
  assert(bare.hitsAtImpact.some(e=>e.damage>0));assert(bare.health<bare.maxHealth);
  assert.equal(covered.health,covered.maxHealth);assert.equal(bare.health,bare.healthAfterImpact);
  // Besides the ray of the flaked roof, the three that the charge throws outwards end on that roof.
  assert.equal(bare.raysAtImpact.filter(r=>!r.internal).length,3);
  assert.equal(bare.collisions.filter(id=>id===bare.sourceId).length,3);
  assert.equal(bare.emittedAtImpact,4);assert.equal(bare.secondaryShots,4);assert.equal(bare.activePackets,0);
});

test('an existing hole does not emit rear spall across empty space', t => {
  const w = managedWorld(t, target()), p = face(w);
  w.cutBody(p, { x: 10.2, y: 1.7 }, { x: 10.8, y: 1.7 }, .12);
  // The charge that flakes the whole wall faces the opening: the rim, farther from it, takes too little
  // to flake, and what crosses the opening is thrown by the charge, not by the wall.
  strike(w);assert.equal(w.stats.spallBursts, 0);
  const thrown=w.drainEvents().filter(e=>e.type==='secondary-ray');
  assert.equal(rays(thrown).length,0);assert(thrown.length>0&&thrown.every(r=>r.endX>p.definition.x+.04));
});

test('blast perforation opens the ballistic grid without ejecting mass or retaining chips', t => {
  const w = managedWorld(t, target(30)), p = face(w), original = p.remainingArea, before = ownerState(w, p);
  strike(w, 650);checkBurst(w.drainEvents());
  assert.equal(w.projectiles.length,0);advance(w,90, { drain: true });
  assert.equal(w.projectiles.length,0);
  assert(p.remainingArea < original, 'the real aperture persists after its visual traces expire');
  assert.equal(w.index.raycast({x:10.2,y:1.7},{x:10.6,y:1.7}),null);
  assert.equal(ownerState(w, p).state.mass, before.state.mass);
  assert.equal(ownerState(w, p).state.inertia, before.state.inertia);
});

test('a perforating blast exits the source and respects real spaced roof armour',()=>{
  const open=reviewSecondary({blast:true,thickness:30}),covered=reviewSecondary({blast:true,thickness:30,shield:40});
  checkBurst(open.raysAtImpact,open.blastPower);checkBurst(covered.raysAtImpact,covered.blastPower);
  assert(open.raysAtImpact.every(r=>r.endY<r.y));assert(open.health<open.maxHealth);
  assert.equal(covered.health,covered.maxHealth);assert.equal(open.health,open.healthAfterImpact);
  assert.equal(open.activePackets,0);assert.equal(covered.activePackets,0);
});

test('reset reproduces instantaneous bursts', t => {
  const w = managedWorld(t,target());
  // The burst of a blast is the ray of the flaked wall and the three that the charge throws outwards.
  const thrown=events=>events.filter(e=>e.type==='secondary-ray');
  w.reset();strike(w);const first=w.drainEvents(),sample=thrown(first);assert.equal(sample.length,4);assert.equal(rays(first).length,1);
  w.reset();w.game().call({op:'physics'});assert.equal(w.stats.spallBursts,0);
  strike(w);const events=w.drainEvents();assert.deepEqual(thrown(events),sample);
  const decoded=new FrameReader().decode(new FrameWriter().encode({state:w.snapshot(),events,profile:{}},true));
  // Undefined optional IDs are omitted from the event rows, and so is what a page reads nothing by (UNREAD_EVENT_FIELDS).
  const wireEvent = event => Object.fromEntries(Object.entries(event).filter(([key, value]) => value !== undefined && !UNREAD_EVENT_FIELDS.get(event.type)?.has(key)));
  assert.deepEqual(decoded.events.filter(e=>e.type==='secondary-ray').map(wireEvent),sample.map(wireEvent));
  assert.equal(shotCount(decoded.state.shots),0);
});

test('rear-spall rays spend bounded energy into the interior without applying another carrier impulse', t => {
  const world=managedWorld(t,target()),plate=face(world),before=ownerState(world,plate).state;
  strike(world);const burst=checkBurst(world.drainEvents()),after=ownerState(world,plate).state;
  const direction=burst.reduce((sum,r)=>{const length=Math.hypot(r.endX-r.x,r.endY-r.y);return {
    x:sum.x+(r.endX-r.x)/length*r.energyBudget,y:sum.y+(r.endY-r.y)/length*r.energyBudget};},{x:0,y:0});
  assert(direction.x>0&&Math.abs(direction.y)<direction.x*.5);
  assert(burst.every(r=>r.x>plate.definition.x));assert.equal(world.projectiles.length,0);
  assert.equal(after.vx,before.vx);assert.equal(after.vy,before.vy);assert.equal(after.omega,before.omega);
  assert.equal(after.mass,before.mass);assert.equal(after.inertia,before.inertia);
});

test('an authored closed hull stays installed and visual rays never replace its carrier', t => {
  const b=damageConstruction({frontThickness:80});
  const w=managedWorld(t,b),plate=face(w),before=ownerState(w,plate),bodies=physics(w).bodies;
  w.explode(plate.definition.x-.3,plate.definition.y,100,1);advance(w,10, { drain: true });
  assert(plate.attached);assert.equal(ownerState(w,plate).body,before.body);
  assert.equal(ownerState(w,plate).state.mass,before.state.mass);
  assert.equal(physics(w).bodies,bodies);
});

test('ground ricochets depend on grazing angle and surface and always lose energy', () => {
  const p = shot(), normal = { nx: 0, ny: 1 }, hard = groundResponse(p, normal, 'concrete');
  assert(hard && hard.vy > 0 && hard.vx > 0 && hard.retained < 1);
  assert.equal(groundResponse(p, normal, 'soil'), null);
  assert(groundResponse(p, normal, 'rock'));
  assert.equal(groundResponse({ ...p, vy: -100 }, normal, 'concrete'), null);
  assert.equal(groundResponse({ ...p, ammo: 'he' }, normal, 'concrete'), null);
  assert.equal(groundResponse({ ...p, groundBounces: 2 }, normal, 'concrete'), null);
  assert.equal(groundResponse({ ...p, power: .6 }, normal, 'concrete'), null);
});

test('CCD ricochets at the ground then hits a plate within the remaining substep', t => {
  // The round grazes at one in six and at 600 m/s, fast enough for the bounce and the wall to fall within one step.
  const b=damageConstruction({length:12,height:.2,rideHeight:.15,frontThickness:100}),w=managedWorld(t,b),p=shot({y:.4,vx:600,vy:-100}),
    initialEnergy=.5*p.mass*(p.vx*p.vx+p.vy*p.vy);
  assert.equal(flyRound(w,p),null,'the wall stops the round within the step');
  const events = w.drainEvents(); assert(events.some(e => e.type === 'ricochet' && e.ground));
  assert(events.some(e => e.type === 'blocked' && e.id === face(w).id));
  assert.equal(events.filter(e => e.type === 'ricochet').length, 1); assert.equal(w.stats.ricochets, 1);
  const bounce=events.find(e=>e.type==='ricochet'&&e.ground),hit=events.find(e=>e.type==='blocked'&&e.id===face(w).id);
  assert(bounce.time<hit.time&&hit.time<=FIXED_DT,'both real contacts fit in the one step of the scene');
  assert(hit.y>=.15&&hit.y<=.35,'the reflected chord enters the intended vertical front, not the thin floor');
  assert(hit.energy<initialEnergy,'reflection and atmospheric drag cannot create energy');
});

test('inclined terrain uses its real normal for reflection; explosive fuze still detonates on contact', t => {
  const b=damageConstruction({terrain:'rough'}); const w = managedWorld(t, b), surface = w.terrain.surface(24),
    p = shot({ x: 24 + surface.nx * .1, y: surface.y + surface.ny * .1,
      vx: surface.tx * 120 - surface.nx * 12, vy: surface.ty * 120 - surface.ny * 12 });
  const flown = flyRound(w, p);
  assert(flown, 'the round flies on after its bounce'); assert.equal(flown.groundBounces, 1);
  assert(flown.vx * surface.nx + flown.vy * surface.ny > 0);
  const flat = managedWorld(t, damageConstruction()), he = shot({ ammo: 'he', blastRadius: 1 });
  assert.equal(flyRound(flat, he), null);
  const explosions = flat.drainEvents().filter(e => e.type === 'explosion');
  assert.equal(explosions.length, 1); assert.equal(explosions[0].source, 'ground');
  assert.equal(explosions[0].detonation, 'impact');
  flat.step(); assert.equal(flat.stats.explosions, 1);
  assert.equal(flat.stats.ricochets, 0);
});

test('the static preview shows the same first ground ricochet and hides it for HE', t => {
  const w = managedWorld(t, damageConstruction()),p=shot({caliberMm:10,weapon:'machinegun'}), solution = {
    x:p.x,y:p.y,vx:p.vx,vy:p.vy,time:.1,flightLimit:45,reachable:true,
    flight:{model:'quadratic-drag-v2',mass:p.mass,caliberMm:p.caliberMm,
      family:'machinegun',dragCoefficient:.30,airDensity:1.225,scaleHeight:8500},
  };
  const preview = predictImpact(w.snapshot(), solution, { ammo: 'ap', power: 100 });
  assert.equal(preview.surface, 'concrete'); assert(preview.bounce);
  assert.equal(predictImpact(w.snapshot(), solution, { ammo: 'he', power: 100 }).bounce, null);
  // The round strikes where the chord of its simulation step does, and the preview traces the same chord.
  placeRound(w, p); for (let i = 0; i < 2; i++) w.step();
  const events = w.drainEvents();
  const event = events.find(e => e.type === 'ricochet');
  assert(Math.hypot(event.x - preview.x, event.y - preview.y) < 1e-9);
});

for (const id of ['blast-spall', 'ground-ricochet']) test(`${id}: reproducible reference scene runs without invalid geometry`, t => {
  const scene = referenceScenario(id), w = managedWorld(t, scene.blueprint); applyReferenceScene(w, scene); advance(w, 120, { drain: true });
  assert(w.plates.every(p => p.nodes.every(n => Number.isFinite(n.x + n.y))));
  if (id === 'blast-spall') { assert(w.stats.spallBursts > 0); assert(w.modules[0].health < w.modules[0].maxHealth); }
  else assert(w.stats.ricochets > 0);
});
