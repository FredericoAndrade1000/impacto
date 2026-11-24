import test from 'node:test';
import assert from 'node:assert/strict';
import { cross } from '../src/math.ts';
import { damageConstruction,face,interior } from './damage-fixtures.js';
import {reviewSecondary} from '../scripts/probes-secondary.ts';
import { solverMomentumRounding } from './solver-rounding.js';
import { ownerState, managedWorld, physics, impulse, flyRound, advance } from './mechanical-queries.js';

const near = (a, b, tolerance = 1e-7) => assert(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
// Rays allocate an energy budget at the primary impact and consume it on real
// material immediately. They never become a live cloud or a second body force.
const spallRays = events => events.filter(e => e.type === 'secondary-ray' && e.internal);
const sourceContact = (events, plate) => {
  const hits=events.filter(e=>e.type==='penetration'&&!e.fragment&&e.id===plate.id);
  assert.equal(hits.length,1,'one real primary contact owns the source budget');
  const contact=hits[0];assert(contact.energy>0&&contact.remaining>=0&&contact.remaining<contact.power);
  return contact;
};
const dissipatedAtContact = contact => contact.energy*(1-contact.remaining/contact.power);
const checkRays = (events, consumed) => {
  const rays = spallRays(events);
  assert.equal(rays.length, 3, 'one fresh perforation emits exactly three internal directions');
  const budget = rays.reduce((sum, r) => sum + r.energyBudget, 0);
  assert(budget > 0 && budget <= consumed * .08 + 1e-4);
  assert(rays.every(r => r.energySpent >= 0 && r.energySpent <= r.energyBudget + 1e-8));
  assert(events.filter(e => e.type === 'secondary-impact').every(e => e.instantaneous && e.impulse === 0));
  return rays;
};
const shot = (overrides = {}) => ({ x: 9.9, y: 1.7, vx: 1100, vy: 0, mass: 5, caliberMm:120,
  power: 900, radius: .06, ammo: 'ap', weapon: 'cannon', age: .1,
  life: 2, visited: new Set(), ...overrides });

test('three instantaneous spall rays spend at most 8% of dissipated energy without adding carrier impulse', t => {
  const b=damageConstruction({dynamic:true,height:1.6,frontThickness:120});
  // The heavy front wall needs support beyond the catalogue axle overhang: axles at ±1.2 m, in cells.
  b.chassis.axles=[-24,24];
  const w = managedWorld(t, b), plate = face(w), before = ownerState(w, plate), p = shot(),
    initialEnergy = .5 * p.mass * p.vx ** 2, initialMomentum = p.mass * p.vx;
  flyRound(w, p, .002);
  // The round ends its two milliseconds inside the hull: the last point of its path is how it flew on.
  const after = ownerState(w, plate), events = w.drainEvents(),contact=sourceContact(events,plate),
    consumed = dissipatedAtContact(contact), out = events.find(e => e.type === 'flight' && !e.fragment).points.at(-1);
  assert(out.x > contact.x && out.x < 13.4, 'the flight ends between the front and the rear wall');
  checkRays(events, consumed);
  assert.equal(w.stats.secondaryShots, 3, 'secondary impacts cannot recursively emit more rays');
  assert.equal(w.projectiles.length, 0);
  assert.equal(after.state.mass, before.state.mass); assert.equal(after.state.inertia, before.state.inertia);
  const carrierJ = after.state.mass * (after.state.vx - before.state.vx),
    body = { mass: after.state.mass, inertia: after.state.inertia, omega: after.state.omega,
      massCenter: after.state.center, velocityAt: () => ({ x: after.state.vx, y: after.state.vy }) };
  const residual=Math.sqrt(contact.remaining/contact.power),
    incomingX=contact.mass*contact.normalSpeed,
    outgoingX=incomingX*residual,
    rounding=1e-6+solverMomentumRounding(body).x;
  near(carrierJ+outgoingX,incomingX,rounding);
  near(carrierJ,contact.impulse*contact.normalSpeed/contact.speed,rounding);
  assert(carrierJ+p.mass*out.vx<=initialMomentum+rounding,
    'atmospheric drag dissipates momentum; it cannot supply a second carrier impulse');
  assert(.5*p.mass*(out.vx*out.vx+out.vy*out.vy)<=initialEnergy,
    'the outgoing flight has no source of new kinetic energy');
  assert.equal(physics(w).bodies, 1);
});
test('an impulse after an asymmetric cut acts once on the unchanged carrier mass and inertia',t=>{
  const b=damageConstruction({dynamic:true,chassis:'wheeled',length:4,height:4,frontThickness:120});
  const y = b.chassis.points[0].y;
  // A 5 m frame with its axles at ±1.9 m, in cells.
  b.chassis={model:'wheeled',points: [{ x: -50, y }, { x: 50, y }],axles:[-38,38]};
  const w=managedWorld(t,b),plate=face(w);
  w.cutBody(plate,{x:9.8,y:4.2},{x:10.2,y:4.2},.018);
  const before=ownerState(w,plate).state,at={x:10,y:4.4};impulse(w,plate,at,{x:500,y:-17});
  const after=ownerState(w,plate).state;
  assert.equal(after.mass,before.mass);assert.equal(after.inertia,before.inertia);
  near(after.mass*(after.vx-before.vx),500,.002);near(after.mass*(after.vy-before.vy),-17,.002);
  near(after.inertia*(after.omega-before.omega),cross(at.x-before.center.x,at.y-before.center.y,500,-17),.002);
});

test('a primary AP round opens a real aperture while the admitted mass and remaining metal persist', t => {
  const b=damageConstruction({frontThickness:50});
  const w = managedWorld(t, b), originalArea = face(w).remainingArea,
    before = ownerState(w, face(w)).state;
  flyRound(w, shot(), .002);
  const plate = face(w), events = w.drainEvents(), after = ownerState(w, plate).state;
  checkRays(events, dissipatedAtContact(sourceContact(events,plate)));
  assert(plate.remainingArea < originalArea && plate.remainingArea > originalArea * .85);
  assert(plate.attached);
  assert.equal(after.mass, before.mass); assert.equal(after.inertia, before.inertia);
  assert.equal(w.index.raycast({ x: 10.3, y: 1.7 }, { x: 10.7, y: 1.7 }), null);
  advance(w, 3);
  assert.equal(w.projectiles.length, 0, 'instantaneous rays never enter the persistent projectile list');
});

test('reset restores the hole-free project and reproduces the same instantaneous spall paths', t => {
  const b=damageConstruction({frontThickness:50});
  const w = managedWorld(t, b);
  const fire = () => {
    flyRound(w, shot(), .002);
    return spallRays(w.drainEvents()).map(r => [r.x, r.y, r.endX, r.endY, r.energyBudget, r.energySpent, r.time]);
  };
  const expected = fire(); assert.equal(expected.length, 3); w.load(b);
  assert.equal(w.projectiles.length, 0);
  near(face(w).remainingArea, face(w).definition.length * face(w).definition.thicknessMm / 1000);
  assert.deepEqual(fire(), expected);
});

test('instantaneous perforation rays damage internal mechanisms before a primary reaches them', t => {
  const b=damageConstruction({frontThickness:50,components:[interior('engine',{x:-.65,y:.2675})]});
  const w = managedWorld(t, b), engine = w.modules[0];
  // End the primary just beyond armour. The engine is outside its chord;
  // immediate damage must have an actual secondary material intersection.
  flyRound(w, shot(), .00058);
  const impacts = w.drainEvents();
  checkRays(impacts, dissipatedAtContact(sourceContact(impacts,face(w))));
  assert(impacts.some(e => e.type === 'secondary-impact' && e.spall && e.instantaneous &&
    e.id === engine.id && e.damage > 0), 'the rays must intersect the engine material');
  assert(!impacts.some(e => e.type === 'module'), 'the primary cannot contaminate the secondary proof');
  assert(engine.health < engine.maxHealth);
  assert.equal(w.projectiles.length, 0); assert.equal(w.stats.secondaryShots, 3);
  assert.equal(w.stats.explosions, 0);
  const afterImpact = engine.health, secondaryShots = w.stats.secondaryShots, later = [];
  advance(w, 165, { events: later });
  assert.equal(engine.health, afterImpact, 'no cloud remains to keep wearing out components');
  assert.equal(w.stats.secondaryShots, secondaryShots, 'secondary damage cannot generate another burst');
  assert(!later.some(e => e.type === 'secondary-impact'));
});

test('real shared roof armour intercepts instantaneous spall instead of radial damage through it',()=>{
  const row=reviewSecondary({shield:160});
  assert.equal(row.raysAtImpact.length,3);assert(row.raysAtImpact.every(r=>r.energyBudget/200<160*1.25));
  assert(row.collisions.includes(row.shieldId),'the compiled hull roof receives an actual secondary intersection');
  assert.equal(row.health,row.initialHealth);assert.equal(row.healthAfterImpact,row.initialHealth);
  assert.equal(row.activePackets,0);assert(row.massPreserved);
});

test('instantaneous spall has finite reach and cannot damage an aligned component beyond twelve meters', t => {
  const w=managedWorld(t,damageConstruction({frontThickness:50}));
  w.addActor(damageConstruction({components:[interior('engine',{x:.05,y:.2675})]}),{id:'distant',x:24});
  const engine=w.modules.find(m=>m.actorId==='distant');
  flyRound(w, shot(), .00058);
  const rays = spallRays(w.drainEvents()); assert.equal(rays.length, 3);
  assert(rays.every(r => Math.hypot(r.endX - r.x, r.endY - r.y) <= 12 + 1e-8));
  assert.equal(engine.health,engine.maxHealth);
  assert.equal(w.projectiles.length, 0);
});
