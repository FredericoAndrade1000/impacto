import test from 'node:test';
import assert from 'node:assert/strict';
import { VegetationMotion, VEGETATION_WAVES } from '../src/vegetation-motion.ts';
import { floraGeometry } from '../src/flora-art.ts';

const uniforms=()=>({uPlantMotion:new Float32Array(4),uPlantGusts:new Float32Array(VEGETATION_WAVES*4),uPlantForces:new Float32Array(VEGETATION_WAVES*4)});
const burst=(x=10,radius=7.2)=>({type:'explosion',x,y:2,radius,power:1200});

test('vegetation impulses obey quality budgets, preserve strong blasts and expire without simulation effects',()=>{
  const motion=new VegetationMotion();motion.setQuality('low');
  motion.emit(burst());motion.emit(burst(12));
  const strong=[...motion.waves];
  for(let i=0;i<100;i++)motion.emit({type:'muzzle',weapon:'cannon',caliberMm:120,x:i,y:1});
  assert.equal(motion.waves.length,2);assert.deepEqual(motion.waves,strong);
  motion.emit({type:'muzzle',weapon:'machinegun',x:2,y:1});motion.emit(burst(NaN));assert.equal(motion.waves.length,2);
  motion.update(2);assert.equal(motion.waves.length,0);
  motion.setQuality('high');for(let i=0;i<30;i++)motion.emit(burst(i));assert.equal(motion.waves.length,VEGETATION_WAVES);
  motion.clear();assert.equal(motion.waves.length,0);
});

test('gusts use presentation time, respect delayed events and retain screen precision far from the world origin',()=>{
  const motion=new VegetationMotion(),values=uniforms(),camera={x:256010,y:10002,zoom:65,width:844,height:390},
    origin={x:422-camera.x*65,y:195+camera.y*65},event={...burst(256010),y:10002},before=structuredClone(event);
  motion.emit(event,.04);motion.update(.02);assert.equal(motion.waves[0].age,0);
  motion.update(.03);assert(Math.abs(motion.waves[0].age-.01)<1e-10);
  motion.write(values,camera,origin,12,.5);
  assert.equal(values.uPlantGusts[0],422);assert.equal(values.uPlantGusts[1],195);
  assert(Math.abs(values.uPlantGusts[2]-.005)<1e-7);assert.equal(values.uPlantMotion[3],1);
  const held=structuredClone(values);motion.update(0);motion.write(values,camera,origin,12,.5);assert.deepEqual(values,held);
  assert.deepEqual(event,before);
  motion.write(values,{...camera,zoom:1},origin,13);assert([...Object.values(values)].every(a=>a.every(v=>v===0)));
});

test('vegetation vertices keep anchored feet, exclude stones and give trees less flexibility than grass',()=>{
  const plants=[{x:256004,y:101,height:.4,kind:'grass',back:false},{x:256006,y:101,height:.1,kind:'greyPebbles',back:false},
    {x:256008,y:101,height:6,kind:'oak',back:true}],before=structuredClone(plants),quads=floraGeometry(plants,{x:256000,y:100},6173);
  assert(quads.roots.every(Number.isFinite));assert.equal(quads.roots.length,plants.length*16);
  for(let i=0;i<plants.length;i++)for(let corner=0;corner<4;corner++){
    assert.equal(quads.roots[i*16+corner*4],plants[i].x-256000);
    assert.equal(quads.roots[i*16+corner*4+1],quads.positions[i*8+1]);
    if(corner<2||i===1)assert.equal(quads.roots[i*16+corner*4+2],0);
  }
  assert(quads.roots[2*16+10]/6<quads.roots[10]/.4);assert.deepEqual(plants,before);
});
