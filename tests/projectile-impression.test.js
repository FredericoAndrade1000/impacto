import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import {damageConstruction,face} from './damage-fixtures.js';
import {createConstruction} from '../src/construction-templates.ts';
import { localToWorld } from '../src/math.ts';
import { weaponSettings } from '../src/weapons.ts';
import { materialState, setVehicle, flyRound, advance } from './mechanical-queries.js';

const originalPoints = plate => {
  const definition = { ...plate.definition };
  return node => localToWorld(definition, (node.u - .5) * definition.length,
    (.5 - node.v) * definition.thicknessMm / 1000);
};

test('a blocked autocannon shot leaves a permanent local metal impression without losing material', t => {
  const blueprint=damageConstruction({height:3,rideHeight:.2,frontThickness:160});
  blueprint.launcher = { x: 1.65, y: 1.7 };
  const w = new World(blueprint);
  t.after(() => w.dispose());
  const plate = face(w), area = plate.remainingArea, original = originalPoints(plate);
  w.fire({ x: 10.5, y: 1.7 }, { id: 'autocannon', preset: 'm242', spread: 0 }, true);
  advance(w, 90);
  assert.equal(w.stats.penetrations, 0);
  assert(Math.abs(plate.remainingArea - area) < 1e-12, 'local refinement conserves material area');
  assert(plate.dents?.size>0);
  assert([...plate.dents.values()].some(d=>d.depth>.0001), 'plastic work records a measurable permanent visual impression');
  assert(plate.nodes.every(n=>Math.hypot(n.x-original(n).x,n.y-original(n).y)<1e-9),
    'local damage cannot shift the rigid movement envelope or generate deformation energy');
  assert.equal(materialState(w, plate, {x:10.42,y:1.7}).resistanceScale,1,
    'visual impressions do not double-count ballistic erosion');
  assert.equal(materialState(w, plate, {x:10.42,y:2.7}).resistanceScale,1,'undamaged material retains its resistance');
  
  const ray=w.index.raycast({x:10,y:1.7},{x:11,y:1.7});
  assert(ray&&Math.abs(ray.x-10.42)<1e-8,'surface impressions do not move the ballistic face');

});

for (const [family, preset, thickness] of [['machinegun', 'fnmag', 100], ['autocannon', 'm242', 160]])
test(`individually stopped ${preset} impacts keep thick metal intact under a long burst`, t => {
  const b=damageConstruction({height:3,rideHeight:.2,frontThickness:thickness});
  const w = new World(b); t.after(() => w.dispose());
  const plate = face(w), area = plate.remainingArea, original = originalPoints(plate);
  const rifle = weaponSettings(family, { preset, ammo: 'ap', spread: 0 });
  for (let i = 0; i < 500; i++) { w.fire({ x: 10.45, y: 1.7 }, rifle, true); w.step(); }
  assert.equal(w.stats.impacts, 500); assert.equal(w.stats.penetrations, 0);
  assert(Math.abs(plate.remainingArea - area) < 1e-12, 'local refinement conserves material area');
  assert(plate.nodes.every(n => Math.hypot(n.x - original(n).x, n.y - original(n).y) < 1e-9));
  assert(plate.dents.size > 0 && plate.dents.size <= 64);
  assert([...plate.dents.values()].every(d => d.depth <= thickness / 1000 * .26 + 1e-12));
  assert.equal(materialState(w, plate, { x: 10.45, y: 1.7 }).resistanceScale, 1);
  assert.equal(materialState(w, plate, { x: 10.45, y: 2.7 }).resistanceScale, 1);
});

test('grazing ricochet damage depends on incidence, not world position or orientation', t => {
  const depths = [];
  for (const [x, y, angle] of [[10, 2, 0], [21, 7, 0], [4, 9, .78]]) {
    // The floor impression changes material locally while the wheeled carrier remains the same.
    const blueprint=damageConstruction({dynamic:true,chassis:'wheeled',length:3,height:2,thicknesses:{floor:100}});
    const world = new World(blueprint); t.after(() => world.dispose());
    setVehicle(world,{x,y:y-.7,angle});
    const plate=face(world,'floor'),c=Math.cos(plate.definition.angle),s=Math.sin(plate.definition.angle),
      direction = { x: c * .98 + s * Math.sqrt(1 - .98 ** 2), y: s * .98 - c * Math.sqrt(1 - .98 ** 2) },
      point = localToWorld(plate.definition, 0, .05);
    // The round starts two centimetres short of the floor and is spent just past the graze.
    flyRound(world, { x: point.x - direction.x * .02, y: point.y - direction.y * .02, vx: direction.x * 500, vy: direction.y * 500,
      power: 100, radius: .012, caliberMm: 20, mass: .01, age: 0, visited: new Set() }, .0002);
    assert.deepEqual(world.drainEvents().filter(e => e.id === plate.id && !e.fragment && e.primaryContact).map(e => e.type), ['ricochet']);
    assert(plate.dents.size > 0, 'a graze deposits finite plastic work at its contact face');
    depths.push(Math.max(...[...plate.dents.values()].map(d => d.depth)));
    assert.equal(plate.integrity, 1);
  }
  assert(depths[0] > 0);
  // A flown round falls a little on its way in, by another angle to a tilted floor: the
  // impressions agree to that fall, a hundred thousand times smaller than they are.
  assert(depths.every(depth => Math.abs(depth - depths[0]) < 1e-9));
});

test('nearby cuts and surface dents cannot move permanent installation references', t => {
  const w=new World(createConstruction('heavy'));t.after(()=>w.dispose());
  // The material reference is local to the real floor. The engine shares its rigid carrier,
  // without an authored support graph tying its position to this damaged material cell.
  const engine=w.modules.find(m=>m.kind==='engine'),parent=face(w,'floor'),
    uv=parent.materialUV({x:engine.x,y:parent.definition.y}),point=parent.materialPosition(uv),installedEngine={x:engine.x,y:engine.y},
    count=parent.nodes.length;
  assert(point,'the test uses a real admitted material reference');
  // Local erosion clears whole ballistic cells. Keep one untouched cell
  // between the reference and the adjacent cut rather than assuming a
  // sixteen-millimetre world offset is finer than this plate's grid.
  const grid=parent.ballisticGrid,dx=(grid.bounds.maxX-grid.bounds.minX)/grid.nx,
    step=Math.max(.03,3*dx),angle=parent.definition.angle,
    cut={x:point.x+Math.cos(angle)*step,y:point.y+Math.sin(angle)*step};
  assert(step<parent.definition.length*.1,'the cut stays near the admitted reference');
  assert(w.cutBody(parent,{x:cut.x-Math.sin(angle)*.01,y:cut.y+Math.cos(angle)*.01},
    {x:cut.x+Math.sin(angle)*.01,y:cut.y-Math.cos(angle)*.01},.006).length>0);
  assert(parent.materialPosition(uv));
  w.command('dent',{owner:w.game().handle(parent),point,depth:.005,radius:.02});
  assert.equal(parent.nodes.length,count);
  assert.deepEqual({x:engine.x,y:engine.y},installedEngine);assert(engine.attached);
});
