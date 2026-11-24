import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, DOMAdapter } from 'pixi.js';
import { SurfaceLight } from '../src/surface-light.ts';

const camera = { x: 10, y: 2, width: 1280, height: 720, zoom: 100 },
  source = (x = 10) => ({ x, y: 1, size: 3, strength: .3, age: .02, life: .16, key: 'burn:' + x }),
  actor = () => ({ container: new Container(), body: new Container(), extent: { length: 3 } });
function setup(t, ground = false) {
  const previous = DOMAdapter.get(), light = new SurfaceLight(), parent = new Container();
  DOMAdapter.set({ ...previous, createCanvas: () => ({ getContext: () => null }) });
  if (ground) light.init(parent);
  t.after(() => { light.destroy(); parent.destroy(); DOMAdapter.set(previous); });
  return light;
}

test('only visible valid lights spend the bounded quality budget, without editing their presentation', t => {
  const light = setup(t), lights = Array.from({ length: 30 }, (_,i) => source(9+i*.05));
  lights.push(source(900), { ...source(), age: 1 }, { ...source(), x: NaN });
  const before = structuredClone(lights);
  for (const [quality, most] of [['high',8],['balanced',6],['low',3]]) {
    assert.equal(light.collect({ lights, quality },camera).length,most);
    assert(light.sources.every(s => s.x < 12 && Number.isFinite(s.strength)));
  }
  assert.deepEqual(lights,before);
  assert.equal(light.collect({ lights },{ ...camera, zoom: 0 }).length,0);
  light.enabled = false; assert.equal(light.collect({ lights },camera).length,0);
});

test('reflected light follows material bodies, survives reordering and releases its capture when the fire ends', t => {
  const light = setup(t), a = actor(), b = actor(), layers = new Map([['a',a],['b',b]]), scene = { actor: () => ({ x:10,y:1 }) };
  t.after(() => { a.body.destroy(); b.body.destroy(); a.container.destroy(); b.container.destroy(); });
  light.sample({ lights: [source()] },camera,layers,scene);
  assert.equal(light.count,2); assert(a.body.filters?.length && b.body.filters?.length);
  const filters = light.entries.map(e => e.filter);
  light.sample({ lights: [source()] },camera,new Map([['b',b],['a',a]]),scene);
  assert(a.body.filters?.length && b.body.filters?.length,'reassigning an old slot cannot detach another slot’s new body');
  assert.deepEqual(light.entries.map(e => e.filter),filters);
  light.sample({ lights: [] },camera,layers,scene);
  assert.equal(light.count,0); assert.equal(a.body.filters,null); assert.equal(b.body.filters,null);
  light.sample({ lights: [source()] },camera,layers,scene);
  assert.deepEqual(light.entries.map(e => e.filter),filters,'the next fire reuses its small filters');
  b.container.visible = false; light.sample({ lights: [source()] },camera,layers,scene); assert.equal(b.body.filters,null);
  a.ghost = true; light.sample({ lights: [source()] },camera,layers,scene); assert.equal(a.body.filters,null,'a remembered ghost is not a physical light receiver');
});

test('ground reflection lies in a thin strip below the actual slope and keeps precision far from the origin', t => {
  const light = setup(t,true), x = 125000.375, view = { ...camera,x,y:1 }, ground = { height: at => .2+(at-x)*.15 };
  light.sample({ lights: [{ ...source(x),y:.4 }] },view,new Map(),null,ground);
  assert(light.ground.visible && light.geometry.indexCount > 0);
  const vertices = light.geometry.indexCount/6+1;
  for (let i = 0; i < vertices; i++) {
    const at = i*4, wx = light.positions[at]+x, y = light.positions[at+1]+view.y;
    assert(Math.abs(y-ground.height(wx))<1e-6);
    assert(light.positions[at+3]<light.positions[at+1]);
    assert.equal(light.tints[at*2+7],0,'reflection fades before the lower edge of the terrain cutaway');
  }
  light.sample({ lights: [] },view,new Map(),null,ground); assert.equal(light.ground.visible,false);
});

test('receiver selection uses the rotated body bounds instead of capturing an unlit nearby vehicle', t => {
  const light = setup(t), a = actor(), layers = new Map([['a',a]]), scene = { actor:()=>({x:10,y:0,angle:Math.PI/2}) };
  a.extent = {left:-2,right:2,bottom:-.5,top:.5,angle:0,length:4};
  t.after(() => { a.body.destroy();a.container.destroy(); });
  light.sample({lights:[{...source(10),y:2.5,size:.2}]},camera,layers,scene);
  assert.equal(light.count,1,'the top of the rotated body receives the nearby source');
  light.sample({lights:[{...source(13),y:0,size:.2}]},camera,layers,scene);
  assert.equal(light.count,0);assert.equal(a.body.filters,null,'the empty space beside it spends no capture');
});

test('young combustion smoke receives local warmth and returns to its original tint when illumination is disabled', t => {
  const light = setup(t), smoke = { kind:'smoke', hotSmoke:5, smokeTint:0x555555, x:10,y:1.1, age:.2, sprite:{ tint:0x555555,alpha:.4 } },
    powder = { ...smoke,hotSmoke:4,sprite:{ tint:0x999999,alpha:.3 } }, effects = { lights:[source()],particles:[smoke,powder] };
  light.sample(effects,camera,new Map(),null);
  assert((smoke.sprite.tint>>16&255)>(smoke.sprite.tint&255)); assert.equal(smoke.sprite.alpha,.4);
  assert.equal(powder.sprite.tint,0x999999);
  light.enabled = false; light.sample(effects,camera,new Map(),null);
  assert.equal(smoke.sprite.tint,smoke.smokeTint); assert.equal(smoke.sprite.alpha,.4);
});
