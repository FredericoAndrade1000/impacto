import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Graphics, Texture } from 'pixi.js';
import { Terrain } from '../src/terrain.ts';
import { TerrainScene } from '../src/terrain-scene.ts';
import { plantFlora, coarseFloraIndices } from '../src/flora-art.ts';
import { depositsOf, depositsNear } from '../src/deposits.ts';
import { Renderer } from '../src/render.ts';
import { strataPlan } from '../src/strata-art.ts';
import { headlessPixi } from './helpers/headless-pixi.js';
headlessPixi();

test('distant flora retains each local skyline and depth row in original order without moving plants', () => {
  const ground=new Terrain('wet-valley',{seed:6173,length:4000}), plants=plantFlora(ground,-2000,2000), before=structuredClone(plants),
    indices=coarseFloraIndices(plants), kept=Array.from({length:indices.length/6},(_,i)=>indices[i*6]/4);
  assert(kept.length < plants.length);
  assert(kept.every((index,i)=>Number.isInteger(index)&&index>=0&&index<plants.length&&(!i||index>kept[i-1])));
  for(const plant of plants)assert(kept.some(i=>plants[i].back===plant.back&&Math.abs(plants[i].x-plant.x)<8&&plants[i].y+plants[i].height>=plant.y+plant.height));
  assert.deepEqual(plants,before); assert.deepEqual(coarseFloraIndices(plants),indices);
});

test('cold woods prepare one chunk per frame, retain the old forest through handover and restore full cached indices nearby', t => {
  const ground=new Terrain('world',{seed:6173,length:128000}), region=ground.biomes.filter(r=>r.id==='wet-valley').sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0],
    roots=[new Container(),new Container()], art=new TerrainScene(...roots,{flora:Texture.WHITE}), camera={x:(region.start+region.end)/2,width:844,zoom:.2};
  art.rebuild(ground); t.after(()=>{art.clear();for(const root of roots)root.destroy({children:true});});
  let builds=0,now=0;const plant=art.plant.bind(art);art.plant=chunk=>{builds++;return plant(chunk);};
  const update=()=>{const before=builds;art.update(camera,now+=16);assert(builds-before<=1,'one new wood per frame, including handover');};
  update(); assert.equal(builds,1);
  for(let n=0;art.activeChunks.some(c=>c.earth?.visible&&!c.plants);n++){assert(n<80);update();}
  const chunk=art.activeChunks.filter(c=>c.flora?.visible&&c.floraIndices.flora.coarse.length<c.floraIndices.flora.full.length)
    .sort((a,b)=>Math.abs((a.left+a.right)/2-camera.x)-Math.abs((b.left+b.right)/2-camera.x))[0];
  assert(chunk,'the view includes neighbouring crowns to simplify');
  const mesh=chunk.flora, geometry=mesh.geometry, positions=geometry.positions, coarse=chunk.floraIndices.flora.coarse, full=chunk.floraIndices.flora.full;
  assert.equal(geometry.indices,coarse);
  for(const zoom of [.239,.241,.239,.25]){camera.zoom=zoom;update();assert.equal(geometry.indices,coarse);}
  camera.zoom=.3;update();assert.equal(geometry.indices,full);
  camera.zoom=.25;update();assert.equal(geometry.indices,full,'hysteresis prevents switching back at the same boundary');
  camera.zoom=.23;update();assert.equal(geometry.indices,coarse);assert.equal(mesh.geometry,geometry);assert.equal(geometry.positions,positions);
  const wide=art.activeChunks;camera.zoom=.6;
  for(let n=0;art.activeChunks===wide;n++){
    assert(n<80);update();
    if(art.activeChunks===wide){assert(wide.some(c=>c.flora?.visible));assert(art.chunks.every(c=>!c.flora?.visible),'replacement trees stay hidden until ready');}
  }
  assert(art.activeChunks.filter(c=>c.earth?.visible).every(c=>c.plants));
  assert(art.activeChunks.filter(c=>c.flora?.visible).every(c=>c.flora.geometry.indices===c.floraIndices.flora.full));
});

test('survey posts reuse unchanged visual inputs across stock updates and pan, but discovery and depletion redraw them', t => {
  const ground=new Terrain('world',{seed:6173,length:128000}), world=new Container(), terrain=world.addChild(new Container()),
    soil=terrain.addChild(new Container()), works=terrain.addChild(new Container()), shadows=world.addChild(new Graphics()),
    r={ground,terrain,world,shadows,camera:{x:6832,width:844,height:390,zoom:.1},terrainScene:{layers:{soil,works},plan:strataPlan(ground)}},
    around=depositsNear(depositsOf(ground),6832,6000), initial=around.filter((_,i)=>i%2).map(p=>({...p,left:p.reserve,stock:0}));
  t.after(()=>world.destroy({children:true,context:true}));
  const draw=veins=>Renderer.prototype.drawDeposits.call(r,veins,100);
  draw(initial);const first=r.depositPosts.context.instructions[0],left=r.depositsLaid.left,right=r.depositsLaid.right;
  assert(first);r.camera.x+=100;
  for(let n=1;n<=20;n++)draw(initial.map(v=>({...v,stock:n,left:v.reserve-n})));
  assert.equal(r.depositPosts.context.instructions[0],first);assert.equal(r.depositsLaid.left,left);assert.equal(r.depositsLaid.right,right);
  const found=around.find(v=>!initial.some(p=>p.id===v.id));
  draw([...initial,{...found,left:found.reserve,stock:0}].sort((a,b)=>a.x-b.x));
  const discovered=r.depositPosts.context.instructions[0];assert.notEqual(discovered,first);
  draw(initial);assert.notEqual(r.depositPosts.context.instructions[0],discovered);
});
