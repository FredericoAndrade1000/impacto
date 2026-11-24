import test from 'node:test';
import assert from 'node:assert/strict';
import {damageConstruction,face,interior} from './damage-fixtures.js';
import { createConstruction } from '../src/construction-templates.ts';
import { managedWorld, setVehicle } from './mechanical-queries.js';

test('native layered blast exposure respects coincident cover, cover out of the path, source exclusion and holes', t => {
  // The detector is an engine in a hull whose front wall is cut away: what a blast takes
  // from its health tells how much of it arrived.
  const scene=()=>{
    const w=managedWorld(t,damageConstruction({length:1.6,height:1.6,rideHeight:1.2,frontThickness:5,components:[interior('engine',{x:-.05,y:.5675})]})),front=face(w);
    w.cutBody(front,front.definition,front.definition,front.definition.length); return w;
  };
  const w=scene(),bare=scene(),narrow=damageConstruction({length:.12,height:1.6,rideHeight:1.2,frontThickness:5});
  // Seven complete narrow bunkers provide fourteen genuine material layers.
  // Their roof/floor chords stay outside the lines from the charge to the engine.
  for(let i=0;i<7;i++)w.addActor(narrow,{id:`layer-${i}`,x:4.06+i*.6});
  // The pressure of one charge on the detector: the health it loses, less what the fragments of the blast take.
  const pressure=(world,at,source)=>{
    const engine=world.modules[0],health=engine.health; world.drainEvents();
    world.explode(at.x,at.y,25,20,source);
    return health-engine.health-world.drainEvents().filter(e=>e.type==='secondary-impact'&&e.id===engine.id).reduce((sum,e)=>sum+e.damage,0);
  };
  const same=(one,other)=>Math.abs(one-other)<1e-9,y=w.modules[0].y,a={x:3,y},above={x:3,y:6},among={x:6.25,y};
  const open=pressure(bare,a),covered=pressure(w,a);
  assert(open>5&&covered>0&&covered<open*.1);
  assert(same(pressure(w,above),pressure(bare,above)),'layers under the line from the charge cover nothing');
  assert(pressure(w,among)/pressure(bare,among)>covered/open,'layers behind the charge cannot be included');
  for (const plate of w.plates.filter(p=>p.actorId!=='local')) w.cutBody(plate, { x: plate.definition.x - .1, y },
    { x: plate.definition.x + .1, y }, .03);
  assert(same(pressure(w,a),open),'aligned apertures remove attenuation without restoring material');
  w.addActor(narrow,{id:'cover',x:4.06});
  const rear=face(w,'rear','cover');
  w.cutBody(rear,{x:3.9,y},{x:4.3,y},.03);
  const behind=pressure(w,a);
  assert(behind>0&&behind<open&&!same(behind,open),'new cover is admitted immediately');
  assert(same(pressure(w,a,w.modules[0]),open),'the part a blast comes from takes it uncovered');
  w.removeActor('cover'); assert(same(pressure(w,a),open));
});

test('successive native shockwaves use current poses without crossing the JavaScript geometry boundary', t => {
  const w = managedWorld(t, createConstruction('scout'));
  w.game();
  w.index.raycast = () => { throw new Error('a native wave called the JS material adapter'); };
  const engine = w.modules.find(m => m.kind === 'engine'), initial = engine.health;
  w.explode(engine.x, engine.y, 50, 2); for (let i = 0; i < 12; i++) w.step();
  assert(engine.health < initial); const previous = engine.health;
  setVehicle(w, { x: w.vehicle.x + 10, y: w.vehicle.y });
  w.explode(engine.x, engine.y, 50, 2); for (let i = 0; i < 12; i++) w.step();
  assert(engine.health < previous || previous === 0);
  assert.equal(w.stats.explosions, 2); assert.equal(w.dynamics.recoveries, 0);
});
