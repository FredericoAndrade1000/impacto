import test from 'node:test';
import assert from 'node:assert/strict';
import { Container, Texture } from 'pixi.js';
import { paintComponentDamage } from '../src/textures.ts';
import { Effects } from '../src/effects.ts';
import { Renderer } from '../src/render.ts';
import { Terrain } from '../src/terrain.ts';

function effects(t, frames = {}) {
  const parent = new Container(), atlas = { smoke: Array(8).fill(Texture.EMPTY), fire: Array(4).fill(Texture.EMPTY),
    spark: Texture.EMPTY, dust: Texture.EMPTY, muzzle: Texture.EMPTY, glow: Texture.EMPTY, shockwave: Texture.EMPTY, ...frames }, fx = new Effects(parent, atlas);
  t.after(() => { fx.clear(); parent.destroy({ children: true }); }); return fx;
}

test('explosion events alone create bounded fire, smoke, sparks and flashes', t => {
  const fx = effects(t), event = { type: 'explosion', x: 2, y: 1, power: 240, radius: 1, actorId: 'gun', targetActorId: 'tank' }, before = structuredClone(event);
  fx.setActors([{ id: 'tank', revision: 0 }]); fx.consume([event]); fx.sample(1);
  assert.deepEqual(event, before, 'rendering cannot alter native explosion evidence');
  assert.deepEqual(new Set(fx.particles.map(p => p.kind)), new Set(['flash', 'fire', 'smoke', 'spark']));
  assert.equal(fx.particles.filter(p => p.kind === 'flash').length, 3, 'one burst, one core and one afterglow per detonation');
  assert(fx.particles.length <= 201); assert.equal(fx.lights.length, 1);
  assert(fx.particles.every(p => p.effectActorId === 'tank'), 'a burst on a construction is drawn with it');
  assert(!fx.actorLayers.get('tank').group.mask);
  assert(!('regions' in fx)); assert(!('compartmentLayers' in fx));
});

test('blast smoke stays substantial after its short fire and repeated blasts fully retire within the quality budget', t => {
  const event = Object.freeze({ type: 'explosion', x: 2, y: 3, power: 600, radius: 4 });
  for (const quality of ['high', 'balanced', 'low']) {
    const fx = effects(t); fx.setQuality(quality); fx.consume([event]);
    for (let i = 0; i < 90; i++) fx.update(1 / 60);
    assert(!fx.particles.some(p => p.kind === 'fire' || p.kind === 'flash'), 'the detonation light and fire are brief');
    const cloud = fx.particles.filter(p => p.kind === 'smoke' && p.hotSmoke);
    assert(cloud.length > 0 && cloud.some(p => p.sprite.alpha > .18), quality + ': the cooling cloud remains visible');
    for (let i = 0; i < 180; i++) {
      if (i % 6 === 0) fx.consume([event]);
      fx.update(1 / 60);
      assert(fx.particles.length <= fx.limit && fx.particles.every(p => Number.isFinite(p.sprite.alpha)));
    }
    for (let i = 0; i < 420; i++) fx.update(1 / 60);
    assert.equal(fx.particles.length, 0, 'a barrage cannot accumulate permanent clouds');
    assert.equal(fx.cloudCount, 0); assert.equal(fx.fireCount, 0);
  }
});

test('a burst in the air and a round into the ground are drawn over the field, not with the far gun that sent them', t => {
  // The layers of a construction go with it out of view: a burst drawn with the gun would be gone with them.
  const fx = effects(t);
  fx.setActors([{ id: 'gun', revision: 0 }]);
  fx.consume([{ type: 'explosion', x: -60, y: 300, power: 600, radius: 5.2, actorId: 'gun' }, { type: 'ground', x: 400, y: 0, power: 300, actorId: 'gun' },
    { type: 'ricochet', ground: true, x: 420, y: 0, power: 300, actorId: 'gun' }]);
  fx.sample(1);
  assert(fx.particles.length > 50 && fx.particles.every(p => p.effectActorId === null));
  assert.equal(fx.lights[0].effectActorId, null); assert.equal(fx.blastWaves.waves[0].actorId, null);
  assert(!fx.actorLayers.has('gun'));
  // What the gun makes of itself is its own: the flash and the smoke at its muzzle.
  fx.consume([{ type: 'muzzle', x: 1, y: 3, angle: .2, weapon: 'cannon', caliberMm: 120, actorId: 'gun' }]);
  assert(fx.particles.some(p => p.effectActorId === 'gun'));
});

test('terrain contact events without ballistic power raise finite dust through repeated updates', t => {
  const fx = effects(t), event = { type: 'ground', actorId: 'starter', x: 2, y: .01,
    nx: 0, ny: 1, material: 'steel', otherMaterial: 'ground', impulse: 1200,
    normalSpeed: 1.2, closingSpeed: 1.2, impactEnergy: 720, contactPair: 'terrain:1:3' },
    before = structuredClone(event);
  fx.terrain = new Terrain('flat');
  fx.consume([event]);
  assert.equal(fx.particles.length, 20, 'contact dust and smoke use the existing bounded ground puff');
  for (let step = 0; step < 60; step++) {
    if (step && step % 6 === 0) fx.consume([event]);
    assert.doesNotThrow(() => { fx.update(1 / 60); fx.sample(.5); });
    assert(fx.particles.every(p => [p.x, p.y, p.vx, p.vy, p.size, p.floorHeight,
      p.sprite.x, p.sprite.y, p.sprite.scaleX, p.sprite.scaleY].every(Number.isFinite)));
  }
  assert.deepEqual(event, before, 'visuals do not invent projectile power or change native contact energy');
  assert(fx.particles.length <= fx.limit);
});

test('smoke rises and disperses in world space without a pressure field or enclosure transport', t => {
  const fx = effects(t), p = fx.add('smoke', { x: 2, y: 1, vx: 1, vy: .5, life: 10, size: .2 });
  fx.update(.25); fx.sample(.5);
  assert(p.x > 2 && p.y > 1); assert.equal(p.age, .25);
  assert.equal(p.sprite.x, (2 + p.x) / 2); assert.equal(p.sprite.y, (1 + p.y) / 2);
  assert(p.sprite.alpha > 0); assert(!('compartmentId' in p));
});

test('combustion uses dense dark frames while propellant and surface dust stay pale and light',t=>{
  const fx=effects(t,{denseSmoke:[Texture.WHITE]}),black=fx.add('smoke',{x:0,y:2,hotSmoke:5,life:4,opacity:.8}),
    white=fx.add('smoke',{x:1,y:2,hotSmoke:4,life:4,opacity:.8}),dust=fx.add('smoke',{x:2,y:2,tint:0xd0bc89,life:4});
  fx.update(.8);
  const brightness=tint=>((tint>>16&255)+(tint>>8&255)+(tint&255))/3;
  assert.equal(black.sprite.texture,Texture.WHITE);assert.equal(white.sprite.texture,Texture.EMPTY);assert.equal(dust.sprite.texture,Texture.EMPTY);
  assert(brightness(black.sprite.tint)<brightness(white.sprite.tint)*.55);
  assert(white.sprite.alpha>0&&black.sprite.alpha>0);assert.equal(dust.sprite.tint,0xd0bc89);
});

test('a hard Native wreck impact raises more surface dust within the same contact budget',t=>{
  const soft=effects(t),heavy=effects(t),hard=effects(t),event=Object.freeze({type:'ground',x:2,y:0,impactEnergy:60000,normalSpeed:8});
  soft.consume([{...event,impactEnergy:720,surface:'soil'}]);heavy.consume([{...event,surface:'soil'}]);hard.consume([{...event,surface:'concrete'}]);
  for(const fx of [soft,heavy,hard])assert.equal(fx.particles.length,20);
  const cloud=fx=>fx.particles.filter(p=>p.kind==='smoke'),mean=(fx,key)=>cloud(fx).reduce((sum,p)=>sum+p[key],0)/cloud(fx).length;
  assert(mean(heavy,'size')>mean(soft,'size')*2);assert(mean(heavy,'opacity')>mean(hard,'opacity'));
  assert(!('power' in event),'collision energy remains collision evidence');
});

test('a small wreck fire keeps one flame while leaving visible dark soot',t=>{
  const fx=effects(t,{denseSmoke:[Texture.WHITE]});
  fx.consume([{type:'burn',actorId:'wreck',componentId:'fuel',x:2,y:1,strength:.15}]);fx.update(.1);
  assert.equal(fx.particles.filter(p=>p.kind==='fire').length,1,'weak fires retain their small flame quota');
  const soot=fx.particles.find(p=>p.kind==='smoke');assert(soot&&soot.hotSmoke===5&&soot.opacity>.3);
  assert.equal(soot.sprite.texture,Texture.WHITE);assert(soot.sprite.alpha>.15);
});

test('cooled smoke keeps fading and a recycled ember still changes colour with its age', t => {
  const fx = effects(t), smoke = fx.add('smoke', { x: 2, y: 3, life: 4, opacity: .6, hotSmoke: 1 });
  fx.update(.7);
  const tint = smoke.sprite.tint, alpha = smoke.sprite.alpha, sprite = smoke.sprite;
  fx.update(.4);
  assert.equal(sprite.tint, tint, 'the smoke has reached its final palette entry');
  assert(sprite.alpha < alpha && sprite.alpha > 0, 'its transparency continues changing after its colour settles');
  assert.equal(sprite.color >>> 24, Math.floor(sprite.alpha * 255), 'the packed colour contains the latest alpha');
  fx.update(4);
  const ember = fx.add('spark', { x: 2, y: 3, life: 1, ember: true, opacity: .7, tint: 0x123456 });
  assert.equal(ember.sprite, sprite, 'the same pooled sprite starts a different effect');
  for (const [dt, expected] of [[.1, 0xffe9b1], [.3, 0xffb968], [.3, 0xe2753f]]) {
    fx.update(dt); assert.equal(sprite.tint, expected);
    assert.equal(sprite.color >>> 24, Math.floor(sprite.alpha * 255));
  }
});

test('a short flash and its light age from the event time without colliding with terrain', t => {
  const fx = effects(t), x = 125000.375, y = 500.125;
  fx.terrain = { height: () => 1000 }; fx.anchor(x, y); fx.ahead = .03;
  const flash = fx.flash({ x: x + .25, y: y + .5, vx: 4, vy: -2, drag: 0, life: .08, opacity: .8, fade: 1 });
  fx.light({ x: x + .25, y: y + .5, age: 0, life: .08, size: 1, strength: .5 }); fx.ahead = 0;
  fx.update(.05); fx.sample(.5);
  assert(Math.abs(flash.age - .02) < 1e-12 && Math.abs(fx.lights[0].age - .02) < 1e-12);
  assert(Math.abs(flash.sprite.x - .29) < 1e-9 && Math.abs(flash.sprite.y - .48) < 1e-9);
  assert(Math.abs(flash.sprite.alpha - .6) < 1e-12, 'the flash fades only for the time since its event');
  assert(fx.lightSprites[0].visible);
  const glow = fx.lightSprites[0];
  fx.update(.07); fx.sample(1);
  assert.equal(fx.particles.length, 0); assert.equal(fx.lights.length, 0); assert(!glow.visible);
  fx.light({ x, y, age: 0, life: 1, size: 1, strength: .5 }); fx.sample(1);
  assert.equal(fx.lightSprites[0], glow); assert(glow.visible, 'an expired glow can serve the next live light');
});

test('live halos keep their sprite and owner through expiry, refresh and actor reset', t => {
  const fx = effects(t), a = { effectActorId: 'a', x: 2, y: 1, age: 0, life: .04, size: 1, strength: .5 },
    b = { key: 'burn:b:fuel', effectActorId: 'b', x: 8, y: 1, age: 0, life: 1, size: 1, strength: .5 };
  fx.setActors([{ id: 'a', revision: 0 }, { id: 'b', revision: 0 }]); fx.light(a); fx.light(b); fx.sample(1);
  const expired = a.sprite, kept = b.sprite, parent = kept.parent, siblings = [...parent.children];
  assert.notEqual(expired, kept); assert.equal(parent, fx.actorLayers.get('b').glows);
  fx.update(.05); fx.sample(1);
  assert.equal(a.sprite, null); assert(!expired.visible);
  assert.equal(b.sprite, kept); assert.equal(kept.parent, parent); assert.deepEqual(parent.children, siblings);
  fx.light({ key: b.key, effectActorId: 'b', x: 9, y: 2, age: 0, life: 1, size: 2, strength: .8 }); fx.sample(1);
  assert.deepEqual(fx.lights, [b]); assert.equal(b.sprite, kept); assert.equal(kept.parent, parent);
  assert.deepEqual([kept.x, kept.y], [9, 2]); assert(kept.visible && kept.alpha > 0);
  a.age = 0; fx.light(a); fx.sample(1);
  assert.equal(a.sprite, expired, 'expired records can reuse a free sprite without borrowing a live halo');
  assert.notEqual(a.sprite, b.sprite);
  fx.setActors([{ id: 'a', revision: 0 }, { id: 'b', revision: 1 }]);
  assert.deepEqual(fx.lights, [a]); assert.equal(b.sprite, null); assert(!kept.visible);
  assert.equal(a.sprite, expired); assert(!expired.destroyed);
  fx.light(b); fx.sample(1);
  assert.equal(b.sprite, kept); assert.equal(kept.parent, fx.actorLayers.get('b').glows);
  assert.notEqual(kept.parent, parent); assert.notEqual(a.sprite, b.sprite); assert(!kept.destroyed);
  const oldPool = [...fx.lightSprites]; fx.clear();
  assert.equal(a.sprite, null); assert.equal(b.sprite, null); assert(oldPool.every(sprite => sprite.destroyed));
  fx.setActors([{ id: 'b', revision: 1 }]); fx.light(b); fx.sample(1);
  assert(b.sprite.visible && !b.sprite.destroyed && !oldPool.includes(b.sprite));
  assert.equal(b.sprite.parent, fx.actorLayers.get('b').glows);
  assert.equal(fx.lightSprites.filter(sprite => sprite.visible).length, 1);
});

test('interleaved halos retain distinct owners within the 64-sprite budget and reuse evicted sprites', t => {
  const fx = effects(t); fx.setActors([{ id: 'a' }, { id: 'b' }]);
  for (let i = 0; i < 96; i++) {
    const retired = fx.lights.length === 64 ? fx.lights[0] : null, retiredSprite = retired?.sprite,
      survivor = fx.lights.at(-1), kept = survivor?.sprite,
      light = { effectActorId: i % 3 ? 'b' : 'a', x: i, y: 1, age: 0, life: 10, size: 1, strength: 1 };
    fx.light(light);
    if (retired) { assert.equal(retired.sprite, null); assert(!retiredSprite.visible); }
    fx.sample(1);
    assert.equal(fx.lights.length, Math.min(i + 1, 64)); assert(fx.lightSprites.length <= 64);
    if (survivor) assert.equal(survivor.sprite, kept, 'eviction cannot transfer a surviving halo to another sprite');
    if (retired) assert.equal(light.sprite, retiredSprite, 'the released slot serves the new halo');
    const live = new Set(fx.lights.map(item => item.sprite)), visible = fx.lightSprites.filter(sprite => sprite.visible);
    assert.equal(live.size, fx.lights.length); assert.equal(visible.length, live.size); assert(visible.every(sprite => live.has(sprite)));
    assert(fx.lights.every(item => item.sprite.visible && !item.sprite.destroyed && item.sprite.blendMode === 'add'
      && item.sprite.parent === fx.actorLayers.get(item.effectActorId).glows));
  }
  const pool = new Set(fx.lightSprites); fx.update(11); fx.sample(1);
  assert.equal(fx.lights.length, 0); assert(fx.lightSprites.every(sprite => !sprite.visible));
  const next = { effectActorId: 'b', x: 100, y: 1, age: 0, life: 1, size: 1, strength: 1 };
  fx.light(next); fx.sample(1);
  assert(pool.has(next.sprite)); assert.equal(next.sprite.parent, fx.actorLayers.get('b').glows);
  assert.equal(fx.lightSprites.filter(sprite => sprite.visible).length, 1);
});

test('late actor effects use the current far anchor and keep their world position when it moves', t => {
  const fx = effects(t), x = 125000.375, y = 500.125;
  fx.anchor(x, y);
  const ambient = fx.add('smoke', { x: x + 2, y: y + 1, life: 3 });
  fx.setActors([{ id: 'rear' }]); fx.anchor(x, y);
  const rear = fx.add('smoke', { actorId: 'rear', x: x - 3, y: y + 2, life: 3 });
  for (const anchor of [[x, y], [x + .25, y + .5]]) {
    fx.anchor(...anchor); fx.sample(.5);
    for (const p of [ambient, rear]) {
      assert.equal(p.layer.x, anchor[0]); assert.equal(p.layer.y, anchor[1]);
      assert.equal(p.layer.x + p.sprite.x, p.x); assert.equal(p.layer.y + p.sprite.y, p.y);
      assert(Math.abs(p.sprite.x) < 4 && Math.abs(p.sprite.y) < 3);
    }
  }
});

test('burn events remain visible and have finite lifetimes without any mechanical gas state', t => {
  const fx = effects(t); fx.consume([{ type: 'burn', actorId: 'tank', x: 2, y: 1 }]);
  assert.equal(fx.particles.filter(p => p.kind === 'fire').length, 2);
  assert.equal(fx.particles.filter(p => p.kind === 'smoke').length, 1);
  assert(fx.particles.every(p => p.life > 0 && p.life <= 5.5));
  fx.update(6); assert.equal(fx.particles.length, 0);
});

test('burn strength changes only flame presentation while their roots stay fixed as the tips taper and cool', t => {
  const mild = effects(t), strong = effects(t), event = { type: 'burn', actorId: 'tank', componentId: 'fuel', x: 2, y: 1, strength: .55 },
    before = structuredClone(event);
  mild.consume([event]); strong.consume([{ ...event, strength: 1.1 }]);
  assert.deepEqual(event, before);
  const flames = mild.particles.filter(p => p.kind === 'fire'), larger = strong.particles.filter(p => p.kind === 'fire');
  assert(flames.every((p, i) => larger[i].size > p.size));
  assert(flames.every(p => p.flame && p.sprite.anchorY < .25 && p.aspectY / Math.abs(p.aspectX) < 1.6), 'the artwork gives height without stretching it into needles');
  const p = flames[0], width = Math.abs(p.sprite.scaleX), tint = p.sprite.tint;
  mild.update(p.life * .65);
  assert.equal(p.y,event.y); assert(Math.abs(p.sprite.scaleX) < width); assert.notEqual(p.sprite.tint, tint);
  assert(p.sprite.alpha > 0 && p.sprite.alpha < 1);
  mild.update(6); assert.equal(mild.particles.length, 0); assert.equal(mild.lights.length, 0);
});

test('burning flames stay on a moving component while smoke detaches with part of its velocity',t=>{
  const fx=effects(t),pose={x:2,y:1,angle:0};fx.pose=id=>id==='fuel'?pose:null;fx.velocity=()=>({vx:20,vy:0});
  fx.consume([{type:'burn',actorId:'tank',componentId:'fuel',x:0,y:1,strength:.9}]);
  const flames=fx.particles.filter(p=>p.flame),smoke=fx.particles.find(p=>p.kind==='smoke'),starts=flames.map(p=>p.x);
  assert(flames.every(p=>p.carrier==='fuel'));assert.equal(smoke.carrier,undefined);assert(smoke.vx>2);
  assert(flames.every(p=>Math.abs(p.x-pose.x)<.2),'a delayed burn event follows the displayed component, not its old world point');
  pose.x+=8;fx.update(.1);fx.sample(1);
  assert(flames.every((p,i)=>Math.abs(p.x-starts[i]-8)<1e-7));assert(smoke.x<5);
  assert.equal(fx.lights[0].sprite.x,pose.x,'the keyed glow follows the same burning component');
  const age=flames[0].age;fx.update(0);fx.sample(1);assert.equal(flames[0].age,age);
});

test('one shared fire follows native events even when its emitting component changes', t => {
  const fx = effects(t), event = { type: 'burn', actorId: 'a', componentId: 'fuel', x: 2, y: 1, strength: .8 };
  fx.setActors([{ id: 'a', revision: 0 }, { id: 'b', revision: 0 }]);
  for (let i = 0; i < 20; i++) fx.consume([{ ...event, x: 2 + i * .01 }]);
  fx.consume([{ ...event, actorId: 'b', x: 8 }]);
  assert.equal(fx.lights.length, 2, 'each native burning module has one refreshed glow');
  assert.equal(fx.lights[0].x, 2.19, 'glow follows the latest native position');
  fx.consume([{ ...event, componentId: 'engine', x: 3 }]);
  assert.equal(fx.lights.length, 2, 'changing the source component does not duplicate the actor fire');
  assert.equal(fx.burningSources.size, 2);
  assert.equal(fx.burningSources.get('burn:a').componentId, 'engine');
  const ages = fx.particles.map(p => p.age);
  fx.update(0); fx.sample(.5); assert.deepEqual(fx.particles.map(p => p.age), ages);
  assert(fx.lights.every(light => light.age === 0));
  fx.setActors([{ id: 'a', revision: 1 }, { id: 'b', revision: 0 }]);
  assert.deepEqual(fx.lights.map(light => light.effectActorId), ['b']);
  fx.update(.2); assert.equal(fx.lights.length, 0, 'illumination ends when native burn events stop');
});

test('burn emission follows presentation time rather than message frequency and stops on expiry or actor reset', t => {
  const slow = effects(t), fast = effects(t), event = { type: 'burn', actorId: 'a', componentId: 'fuel', x: 2, y: 1, strength: .8 };
  for (const fx of [slow, fast]) fx.setActors([{ id: 'a', revision: 0 }]);
  for (let frame = 0; frame < 240; frame++) {
    if (frame % 6 === 0) slow.consume([event]);
    fast.consume([event]);
    for (const fx of [slow, fast]) { fx.update(1 / 60); fx.sample(1); }
  }
  const counts = fx => ['fire', 'smoke'].map(kind => fx.particles.filter(p => p.kind === kind).length);
  assert.deepEqual(counts(slow), counts(fast), '10 Hz and 60 Hz messages keep the same emission cadence');
  assert(slow.fireCount > 0 && slow.fireCount < 10);
  assert.equal(slow.burningSources.size, 1);
  const count = fast.particles.length;
  for (let i = 0; i < 100; i++) fast.consume([event]);
  fast.update(0); assert.equal(fast.particles.length, count, 'paused messages refresh a source without making more particles');
  slow.update(.21); assert.equal(slow.burningSources.size, 0);
  slow.update(6); assert.equal(slow.particles.length, 0);
  fast.setActors([{ id: 'a', revision: 1 }]); assert.equal(fast.burningSources.size, 0); assert.equal(fast.particles.length, 0);
  fast.consume([event]); fast.clear(); assert.equal(fast.burningSources.size, 0);
});

test('continuous fire retains its contacts and sprites instead of replacing flames with unrelated puffs', t => {
  const fx=effects(t),pose={x:3,y:2,width:1.2,height:1,angle:0},event={type:'burn',actorId:'v',componentId:'engine',x:3,y:2,strength:1,exterior:true};
  fx.pose=()=>pose;
  const step=i=>{if(i%6===0)fx.consume([event]);fx.update(1/60);fx.sample(1);};
  for(let i=0;i<60;i++)step(i);
  const flames=fx.particles.filter(p=>p.flame),sprites=flames.map(p=>p.sprite),roots=flames.map(p=>[p.carryX,p.carryY]);
  assert.equal(flames.length,4);
  for(let i=60;i<420;i++){
    if(i===180){pose.x+=20;pose.angle=Math.PI/3;}
    step(i);
    assert(fx.particles.filter(p=>p.flame).every((p,j)=>p===flames[j]),'ongoing fire keeps its existing flame records through a turn');
    assert(flames.every((p,j)=>p.sprite===sprites[j]&&p.carryX===roots[j][0]&&p.carryY===roots[j][1]));
    assert(flames.every(p=>p.sprite.alpha>.5),'an ongoing source cannot fade its whole bed out between emissions');
  }
  const alpha=flames[0].sprite.alpha;
  fx.update(.21);fx.sample(1);
  assert.equal(fx.burningSources.size,0);assert(flames[0].sprite.alpha>0&&flames[0].sprite.alpha<alpha,'the last lease fades out');
  fx.update(.30);assert.equal(fx.particles.filter(p=>p.flame).length,0,'no permanent flame survives its source');
});

test('stable flames apply a bounded quality quota and can recover after budget eviction', t => {
  for(const [quality,count] of [['high',4],['balanced',3],['low',2]]){
    const fx=effects(t);fx.setQuality(quality);
    const event={type:'burn',actorId:'v',componentId:'engine',x:2,y:1,strength:1};
    const step=i=>{if(i%6===0)fx.consume([event]);fx.update(1/60);fx.sample(1);};
    for(let i=0;i<120;i++)step(i);
    assert.equal(fx.fireCount,count);
    const previous=new Set(fx.particles.filter(p=>p.flame));
    // Stress a budget containing only the current flames, so the short burst
    // must evict some of them instead of just replacing spare smoke.
    fx.particles=fx.particles.filter(p=>{if(!p.flame)fx.retire(p);return p.flame;});fx.settle();fx.limit=count;
    for(let i=0;i<count*8;i++)fx.add('fire',{priority:true,x:2,y:1,life:.01});
    fx.update(.02);
    for(let i=120;i<240;i++)step(i);
    assert(fx.fireCount>0&&fx.fireCount<=count);assert(fx.particles.length<=fx.limit);
    assert(fx.particles.filter(p=>p.flame).some(p=>!previous.has(p)),'evicted slots are made again, without retaining retired particles');
  }
});

test('a new burning part crossfades contacts and strength and travel changes do not restart the flame', t => {
  const fx=effects(t),poses={a:{x:2,y:1},b:{x:8,y:1}},event={type:'burn',actorId:'v',componentId:'a',x:2,y:1,strength:1};
  let vx=30;fx.pose=id=>poses[id];fx.velocity=()=>({vx,vy:0});
  for(let i=0;i<60;i++){if(i%6===0)fx.consume([event]);fx.update(1/60);fx.sample(1);}
  const first=fx.particles.find(p=>p.flame),sprite=first.sprite,size=first.size;
  vx=-30;event.strength=.55;
  for(let i=0;i<60;i++){if(i%6===0)fx.consume([event]);fx.update(1/60);fx.sample(1);}
  assert.equal(first.sprite,sprite);assert(first.rotation<0);assert(first.size<size);
  fx.consume([{...event,componentId:'b',x:8}]);
  for(let i=0;i<12;i++){if(i%6===0)fx.consume([{...event,componentId:'b',x:8}]);fx.update(1/60);fx.sample(1);}
  assert.equal(first.carrier,'a');assert.equal(first.x,2,'a retiring flame stays on the old part');
  assert(fx.particles.some(p=>p.flame&&p.carrier==='b'&&p.sprite.alpha>0));
  for(let i=0;i<90;i++){if(i%6===0)fx.consume([{...event,componentId:'b',x:8}]);fx.update(1/60);}
  assert(fx.particles.filter(p=>p.flame).every(p=>p.carrier==='b'));
});

test('whole-vehicle fire distributes the same particle budget and follows the chassis without an interior component', t => {
  const full = effects(t), local = effects(t), pose = { x: 256000, y: 1, angle: 0 }, roots = [];
  full.pose = id => id === 'vehicle' ? pose : null;
  full.fireSurface = () => ({ width: 8, pose, carrier: 'vehicle', points: Array.from({ length: 8 }, (_, i) => ({ x: -3.5 + i, y: 2 })) });
  const add = full.add.bind(full);
  full.add = (kind, options, ...rest) => { if (options.flame) roots.push(options.x); return add(kind, options, ...rest); };
  for (let i = 0; i < 120; i++) {
    if (i % 6 === 0) for (const [fx, spread] of [[full, 1], [local, 0]])
      fx.consume([{ type: 'burn', actorId: 'vehicle', x: pose.x, y: 1, strength: 1.15, spread }]);
    full.update(1 / 60); local.update(1 / 60);
  }
  assert(Math.max(...roots) - Math.min(...roots) > 6, 'flames reach both ends of the visible hull');
  for (const kind of ['fire', 'smoke']) assert.equal(full.particles.filter(p => p.kind === kind).length, local.particles.filter(p => p.kind === kind).length);
  assert.equal(full.burningSources.size, 1); assert.equal(full.lights.length, 1);
  full.sample(1);
  const flames = full.particles.filter(p => p.flame), positions = flames.map(p => p.x);
  assert(flames.every(p => p.carrier === 'vehicle'));
  assert(full.particles.filter(p => p.kind === 'smoke').every(p => p.carrier === undefined));
  pose.x += 10; full.update(.001); full.sample(1);
  assert(flames.every((p, i) => Math.abs(p.x - positions[i] - 10) < .001));
});

test('isolated exterior fires stay on their own equipment and never project onto the whole hull', t => {
  const fx = effects(t), poses = { a: { x: 2, y: 1, height: .8, angle: 0 }, b: { x: 8, y: 1, height: .8, angle: 0 } };
  fx.pose = id => poses[id];
  fx.fireSurface = () => { throw new Error('Exterior fire must not use the interior hull surface'); };
  fx.consume(Object.entries(poses).map(([componentId, p]) => ({ type: 'burn', actorId: 'v', componentId,
    x: p.x, y: p.y, strength: 1, spread: 1, exterior: true })));
  assert.equal(fx.burningSources.size, 2, 'separate external ignitions do not overwrite one another');
  assert([...fx.burningSources.values()].every(s => s.spread === 0));
  const flames = fx.particles.filter(p => p.flame);
  assert(flames.every(p => Math.abs(p.x - poses[p.carrier].x) < .2));
  assert(flames.every(p => p.y < 1.4));
});

test('animated flames elongate while their root stays on the turning component', t => {
  const fx=effects(t), pose={x:3,y:2,width:1,height:1,angle:0};
  fx.pose=()=>pose;
  fx.consume([{type:'burn',actorId:'v',componentId:'engine',x:pose.x,y:pose.y,strength:1,exterior:true}]);
  const flame=fx.particles.find(p=>p.flame);fx.sample(1);
  const initial=flame.sprite.y,height=flame.sprite.scaleY;
  fx.update(.12);fx.sample(1);
  assert.equal(flame.sprite.y,initial,'the fuel bed cannot float off its burning surface');
  assert(flame.sprite.scaleY>height,'tips elongate above the fixed root');
  Object.assign(pose,{x:8,y:5,angle:Math.PI/2});fx.sample(1);
  const root=pose.y+Math.sin(pose.angle)*flame.carryX+Math.cos(pose.angle)*flame.carryY;
  assert(Math.abs(flame.sprite.y-(root-fx.origin.y))<1e-9,'only the root follows component rotation');
  const paused=flame.sprite.y;fx.update(0);fx.sample(1);assert.equal(flame.sprite.y,paused);
});

test('free flames cover visible burning fuel, rise beyond its contour and keep their aspect through rotation',t=>{
  const fx=effects(t),parts=[{id:'wide',kind:'fuel',width:4,height:.7,x:2,y:3,angle:0},
    {id:'turned',kind:'thruster',width:.6,height:1.4,x:8,y:3,angle:Math.PI/2},
    {id:'inverted',kind:'fuel',width:1,height:.8,x:12,y:3,angle:Math.PI}],poses=new Map(parts.map(p=>[p.id,p]));
  fx.pose=id=>poses.get(id);fx.fireSurface=()=>({opened:true,burning:parts,scene:{pose:fx.pose}});
  for(let i=0;i<120;i++){if(i%6===0)fx.consume([{type:'burn',actorId:'v',componentId:'wide',x:2,y:3,strength:1.15}]);fx.update(1/60);fx.sample(1);}
  const flames=fx.particles.filter(p=>p.flame);assert.equal(flames.length,5);assert.equal(new Set(flames.map(p=>p.carrier)).size,3);
  for(const part of parts){
    const on=flames.filter(p=>p.carrier===part.id),top=part.y+(Math.abs(Math.sin(part.angle))*part.width+Math.abs(Math.cos(part.angle))*part.height)/2;
    assert(on.some(p=>p.y+(1-p.sprite.anchorY)*p.sprite.scaleY*128>top),'the plume can rise beyond its fuel');
    assert(on.every(p=>Math.abs(p.sprite.rotation)<.15&&p.sprite.scaleY/Math.abs(p.sprite.scaleX)>.5),'the tongue keeps its upward direction and proportions');
  }
});

test('many visible burning parts share a finite flame quota without multiplying their smoke sources',t=>{
  for(const [quality,most] of [['high',16],['balanced',10],['low',4]]){
    const fx=effects(t);fx.setQuality(quality);const parts=Array.from({length:24},(_,i)=>({id:'fuel'+i,kind:'fuel',width:1,height:1,x:i,y:3}));
    fx.pose=id=>parts.find(p=>p.id===id);fx.fireSurface=()=>({opened:true,burning:parts,scene:{pose:fx.pose}});
    for(let i=0;i<240;i++){if(i%6===0)fx.consume([{type:'burn',actorId:'v',componentId:parts[0].id,x:0,y:3,strength:1.15}]);fx.update(1/60);fx.sample(1);}
    assert.equal(fx.particles.filter(p=>p.flame).length,most);assert.equal(fx.burningSources.size,1);assert(fx.particles.length<=fx.limit);
  }
});

test('identical fuel tanks get stable main flames and scattered smaller offshoots instead of repeated pairs',t=>{
  const fx=effects(t),parts=Array.from({length:4},(_,i)=>({id:'tank'+i,kind:'fuel',width:1.5,height:1.8,x:i*2,y:3}));
  fx.pose=id=>parts.find(p=>p.id===id);fx.fireSurface=()=>({opened:true,burning:parts,scene:{pose:fx.pose}});
  const step=i=>{if(i%6===0)fx.consume([{type:'burn',actorId:'v',componentId:'tank0',x:0,y:3,strength:1.15}]);fx.update(1/60);fx.sample(1);};
  for(let i=0;i<180;i++)step(i);
  const flames=fx.particles.filter(p=>p.flame),counts=parts.map(part=>flames.filter(p=>p.carrier===part.id).length);
  assert.equal(flames.length,6);assert(counts.every(count=>count>0));assert(new Set(counts).size>1);
  const main=flames.filter(p=>p.burnSlot<4),extra=flames.filter(p=>p.burnSlot>=4);
  assert.equal(new Set(main.map(p=>p.carrier)).size,4);
  assert(extra.every(p=>p.burnSize<main.find(q=>q.carrier===p.carrier).burnSize),'secondary tongues are smaller than their local main flame');
  const roots=flames.map(p=>[p.carryX,p.carryY]);
  for(let i=180;i<240;i++)step(i);
  assert(fx.particles.filter(p=>p.flame).every((p,i)=>p===flames[i]&&p.carryX===roots[i][0]&&p.carryY===roots[i][1]));
});

test('a changed hull roof renews its fire contacts',t=>{
  const fx=effects(t),pose={x:0,y:1,angle:0};let roof=2;
  fx.pose=()=>pose;fx.fireSurface=()=>({pose,carrier:'v',width:4,points:[{x:-1,y:roof},{x:1,y:roof}]});
  const step=i=>{if(i%6===0)fx.consume([{type:'burn',actorId:'v',x:0,y:1,strength:1.15,spread:1}]);fx.update(1/60);fx.sample(1);};
  for(let i=0;i<120;i++)step(i);
  assert(fx.particles.filter(p=>p.flame).every(p=>p.carryY===2));
  roof=.8;for(let i=120;i<240;i++)step(i);
  assert(fx.particles.filter(p=>p.flame).every(p=>p.carryY===.8),'old contacts do not remain floating above removed hull material');
});

test('flame tips lean against travel in either direction while smoke leaves the moving source',t=>{
  for(const vx of [-40,40]){
    const fx=effects(t),pose={x:2,y:1,angle:0};fx.pose=()=>pose;fx.velocity=()=>({vx,vy:0});
    fx.consume([{type:'burn',actorId:'v',componentId:'engine',x:pose.x,y:pose.y,strength:1}]);
    fx.update(.1);fx.sample(1);
    const flames=fx.particles.filter(p=>p.flame),smoke=fx.particles.find(p=>p.kind==='smoke');
    assert(flames.every(p=>p.sprite.rotation*vx>0),'a rising tongue tilts behind the vehicle');
    assert.equal(smoke.carrier,undefined);assert(smoke.vx*vx>0&&Math.abs(smoke.vx)<Math.abs(vx));
    assert(flames.every(p=>Math.abs(p.sprite.y-1)<1e-9));
  }
});

test('existing combustion smoke crosses the flames without extra particles and clears with its layers',t=>{
  const fx=effects(t),event={type:'burn',actorId:'v',componentId:'engine',x:2,y:1,strength:1};
  for(let i=0;i<60;i++){if(i%6===0)fx.consume([event]);fx.update(1/60);fx.sample(1);}
  const layers=fx.actorLayers.get('v'),clouds=fx.particles.filter(p=>p.kind==='smoke'),front=clouds.filter(p=>p.layer===layers.veil);
  assert(front.length>0&&front.length<clouds.length,'only some smoke obscures the flames');
  assert(front.every(p=>p.hotSmoke===5&&p.carrier===undefined));
  assert(layers.group.getChildIndex(layers.smoke)<layers.group.getChildIndex(layers.fire));
  assert(layers.group.getChildIndex(layers.veil)>layers.group.getChildIndex(layers.fire));
  fx.anchor(2000,1000);fx.sample(1);
  assert.equal(layers.veil.x,2000);assert.equal(layers.veil.y,1000);
  assert(front.every(p=>Math.abs(p.sprite.x-(p.x-2000))<1e-9));
  fx.clear();assert.equal(fx.actorLayers.size,0);assert.equal(fx.particles.length,0);assert.equal(fx.veil.particleChildren.length,0);
});

test('slow frames do not accumulate smoke to emit in a burst when drawing recovers', t => {
  const steady = effects(t), delayed = effects(t), event = { type: 'burn', actorId: 'a', componentId: 'fuel', x: 2, y: 1, strength: 1 };
  for (const fx of [steady, delayed]) fx.velocity = () => ({ vx: 30, vy: 0 });
  const step = (fx, dt) => {
    const previous = new Set(fx.particles); fx.consume([event]); fx.update(dt); fx.sample(1);
    return fx.particles.filter(p => p.kind === 'smoke' && !previous.has(p)).length;
  };
  for (let frame = 0; frame < 180; frame++) step(steady, 1 / 60);
  for (let frame = 0; frame < 30; frame++) step(delayed, .1);
  let steadyBirths = 0, delayedBirths = 0;
  for (let frame = 0; frame < 12; frame++) { steadyBirths += step(steady, 1 / 60); delayedBirths += step(delayed, 1 / 60); }
  assert(Math.abs(delayedBirths - steadyBirths) <= 2, JSON.stringify({ steadyBirths, delayedBirths }));
});

test('flames present the intermediate source frames at roughly 32 fps without recreating their sprites',t=>{
  const frames=Array.from({length:64},()=>new Texture({source:Texture.EMPTY.source})),fx=effects(t,{flame:frames});
  t.after(()=>frames.forEach(texture=>texture.destroy()));
  const p=fx.add('fire',{x:0,y:3,life:4,size:1,flame:true}),sprite=p.sprite,seen=new Set();
  for(let i=0;i<120;i++){fx.update(1/120);fx.sample(1);seen.add(p.sprite.texture);assert.equal(p.sprite,sprite);}
  assert(seen.size>=32&&seen.size<=37,'one second exposes consecutive intermediate frames instead of sixteen jumps');
  const paused=p.sprite.texture;fx.update(0);fx.sample(1);assert.equal(p.sprite.texture,paused);
});

test('flame animation reuses atlas frames and freezes with simulation time', t => {
  const frames = Array.from({ length: 4 }, () => new Texture({ source: Texture.EMPTY.source })), fx = effects(t, { flame: frames, fire: frames });
  t.after(() => frames.forEach(texture => texture.destroy()));
  const p = fx.add('fire', { x: 2, y: 1, life: 1, size: .5, flame: true }), initial = p.sprite.texture, sprite = p.sprite;
  fx.update(.11); fx.sample(1);
  assert.notEqual(p.sprite.texture, initial, 'the flame changes shape, not only tint or scale');
  assert(frames.includes(p.sprite.texture)); assert.equal(p.sprite, sprite);
  const paused = { texture: p.sprite.texture, tint: p.sprite.tint, alpha: p.sprite.alpha, rotation: p.sprite.rotation };
  fx.update(0); fx.sample(1);
  assert.deepEqual({ texture: p.sprite.texture, tint: p.sprite.tint, alpha: p.sprite.alpha, rotation: p.sprite.rotation }, paused);
});

test('explosion smoke cools from warm fumes to soot and persists after the fire fades', t => {
  const fx = effects(t), event = { type: 'explosion', x: 2, y: 1, power: 600, radius: 4.5 }, before = structuredClone(event);
  fx.consume([event]); fx.update(.02);
  const smoke = fx.particles.find(p => p.kind === 'smoke'), warm = smoke.sprite.tint;
  fx.update(.7);
  const soot = smoke.sprite.tint, warmth = color => (color >>> 16 & 255) - (color & 255);
  assert(warmth(soot) < warmth(warm));
  assert(smoke.sprite.alpha > 0 && smoke.y > event.y);
  assert(fx.particles.some(p => p.kind === 'smoke'));
  assert(!fx.particles.some(p => p.kind === 'fire'));
  assert.deepEqual(event, before, 'cooling remains a visual property of the native event');
});

test('blast phases stay bounded across quality changes and replay resets', t => {
  const fx = effects(t), event = { type: 'explosion', targetActorId: 'a', x: 2, y: 1, power: 810, radius: 3.9 };
  fx.setActors([{ id: 'a', revision: 0 }, { id: 'b', revision: 0 }]);
  fx.consume([event, { ...event, targetActorId: 'b', x: 8 }]); fx.sample(1);
  assert.equal(fx.blastWaves.waves.length, 2);
  const fire = fx.particles.filter(p => p.kind === 'fire');
  assert(Math.min(...fire.map(p => p.life)) < .32 && Math.max(...fire.map(p => p.life)) > .5);
  fx.setActors([{ id: 'a', revision: 1 }, { id: 'b', revision: 0 }]);
  assert.equal(fx.blastWaves.waves.length, 1);
  fx.setQuality('low');
  for (let i = 0; i < 80; i++) fx.consume([{ ...event, targetActorId: 'b', x: i }]);
  assert(fx.blastWaves.waves.length <= 8 && fx.particles.length <= 800);
  fx.update(.5); fx.sample(1); assert.equal(fx.blastWaves.waves.length, 0);
  assert(fx.particles.some(p => p.kind === 'smoke'), 'smoke outlives the shockwave');
  fx.clear(); assert.equal(fx.blastWaves.waves.length, 0);
  assert(fx.blastWaves.sprites.every(sprite => !sprite.visible));
});

test('all new explosions and burning modules stay visible when smoke fills the particle budget', t => {
  const fx = effects(t);
  for (let i = 0; i < fx.limit; i++) fx.add('smoke', { x: 2, y: 3, life: 10, size: .3 });
  const oldSmoke = new Set(fx.particles.map(p => p.sprite));
  for (let i = 0; i < 6; i++) {
    fx.consume([{ type: 'explosion', targetActorId: `tank-${i}`, x: i * 10, y: 1, power: 600, radius: 4.5 },
      { type: 'burn', actorId: `tank-${i}`, componentId: 'fuel', x: i * 10 + 2, y: 1, strength: .8 }]);
  }
  assert.equal(fx.particles.length, fx.limit, 'fresh fire replaces smoke without increasing the budget');
  for (let i = 0; i < 6; i++) {
    const fire = fx.particles.filter(p => p.kind === 'fire' && p.effectActorId === `tank-${i}`);
    assert(fire.some(p => !p.flame), 'every simultaneous blast retains a visible hot core');
    assert(fire.some(p => p.flame), 'each burning module keeps its vertical flames');
    assert(fire.every(p => oldSmoke.has(p.sprite)), 'retired smoke sprites are reused');
  }
  assert.equal(fx.pool.length, 0); fx.update(.05); fx.sample(1);
  assert.equal([fx,...fx.actorLayers.values()].reduce((sum,layers)=>sum+['smoke','fire','veil','sparks'].reduce((n,key)=>n+layers[key].particleChildren.length,0),0),fx.particles.length);
});

// A burst of a big shell on the ground at `x`, and what a burst on its own makes of it, at the start of a field.
const blast = x => ({ type: 'explosion', x, y: .5, power: 600, radius: 4.5 }), flat = { height: () => 0 };
const made = (t, event) => { const fx = effects(t); fx.terrain = flat; fx.consume([event]); return fx.particles; };

test('a burst far from the screen only marks the ground: a burst on the screen after many of them has its fire, smoke and sparks', t => {
  const fx = effects(t), renderer = new Renderer({}); renderer.effects = fx; fx.terrain = flat;
  Object.assign(renderer.camera, { x: 0, y: 10, zoom: 4, width: 1280, height: 720 });
  // Twenty-nine bursts a kilometre and more away, more than the budget holds: none of them sparks or smokes, and every one leaves its mark.
  for (let i = 0; i < 29; i++) renderer.consumeEffect(blast(1000 + i * 40));
  assert.equal(fx.particles.length, 0, 'nothing that goes in a few seconds is made out there');
  assert.deepEqual(fx.scorches.map(scorch => scorch.x), Array.from({ length: 29 }, (_, i) => 1000 + i * 40));
  renderer.consumeEffect(blast(5));
  assert.deepEqual(['flash', 'fire', 'smoke', 'spark', 'dust'].map(kind => fx.particles.filter(p => p.kind === kind).length),
    ['flash', 'fire', 'smoke', 'spark', 'dust'].map(kind => made(t, blast(5)).filter(p => p.kind === kind).length), 'the burst on the screen is whole');
  assert.equal(fx.scorches.length, 30); assert.equal(fx.lights.length, 1);
});

test('with the budget full of what is off the screen, what is made on it takes their place, of whatever kind', t => {
  const fx = effects(t); fx.terrain = flat; fx.view = { left: -40, right: 40, bottom: -5, top: 40 };
  // Bursts beside the screen, where what they make is kept for a camera that turns to them, fill the budget: some
  // stepped since, and some just made.
  for (let i = 0; i < 15; i++) fx.consume([blast(60 + i * 10)]);
  fx.update(1 / 60);
  for (let i = 15; i < 29; i++) fx.consume([blast(60 + i * 10)]);
  assert.equal(fx.particles.length, fx.limit);
  const before = new Set(fx.particles); fx.consume([blast(5)]);
  const fresh = fx.particles.filter(p => !before.has(p)), alone = made(t, blast(5));
  assert.deepEqual(['flash', 'fire', 'smoke', 'spark', 'dust'].map(kind => fresh.filter(p => p.kind === kind).length),
    ['flash', 'fire', 'smoke', 'spark', 'dust'].map(kind => alone.filter(p => p.kind === kind).length), 'the burst on the screen is whole');
  assert.equal(fx.particles.length, fx.limit, 'and the budget holds');
  assert(fx.particles.filter(p => p.x > -40 && p.x < 40).every(p => !before.has(p)), 'what made room for it was off the screen');
});

test('restoring an actor clears only its particles and flash, retaining other actors and ambient effects', t => {
  const fx = effects(t), actors = [{ id: 'a', revision: 0 }, { id: 'b', revision: 0 }]; fx.setActors(actors);
  const a = fx.add('smoke', { actorId: 'a', x: 2, y: 1, life: 10 }),
    b = fx.add('smoke', { actorId: 'b', x: 8, y: 1, life: 10 }), ambient = fx.add('smoke', { x: 16, y: 1, life: 10 });
  fx.lights.push({ effectActorId: 'a', age: 0, life: 1, x: 2, y: 1, size: 1, strength: 1 },
    { effectActorId: 'b', age: 0, life: 1, x: 8, y: 1, size: 1, strength: 1 }); fx.sample(1);
  fx.setActors(actors.map(actor => ({ ...actor }))); fx.setActors([...actors].reverse());
  assert.deepEqual(fx.particles, [a, b, ambient], 'fresh snapshots and actor reordering do not reset their effects');
  actors[0].revision = 1; fx.setActors([...actors].reverse());
  assert.deepEqual(fx.particles, [b, ambient]); assert(fx.pool.includes(a.sprite));
  assert.deepEqual(fx.lights.map(light => light.effectActorId), ['b']);
  assert(!fx.actorLayers.has('a')); assert(fx.actorLayers.has('b'));
  assert(fx.lightSprites.every(sprite => !sprite.destroyed));
});

test('removing an actor retires its effect containers without leaking lights or unrelated smoke', t => {
  const fx = effects(t); fx.setActors([{ id: 'a' }, { id: 'b' }]);
  fx.add('smoke', { actorId: 'a', x: 2, y: 1 }); const kept = fx.add('smoke', { actorId: 'b', x: 8, y: 1 });
  fx.setActors([{ id: 'b' }]); assert.deepEqual(fx.particles, [kept]); assert(!fx.actorLayers.has('a'));
});

test('quality limits bound repeated explosions and all visual state clears for replay reset', t => {
  const fx = effects(t); fx.setQuality('low');
  for (let i = 0; i < 40; i++) fx.consume([{ type: 'explosion', x: i, y: 1, power: 240, radius: 1, actorId: 'tank' }]);
  assert(fx.particles.length <= 800); assert(fx.scorches.length <= 40);
  fx.sample(1); fx.clear();
  assert.equal(fx.particles.length, 0); assert.equal(fx.lights.length, 0);
  assert.equal(fx.actorLayers.size, 0); assert.equal(fx.lightSprites.length, 0);
  assert.equal(fx.smoke.particleChildren.length, 0);
});

test('fragment rays are drawn with the construction they were thrown in, within the budget of any quality', t => {
  const fx = effects(t), ray = { type: 'secondary-ray', actorId: 'tank', x: 2, y: 1, endX: 3, endY: 1 };
  fx.setActors([{ id: 'tank', revision: 0 }]);
  const ambient = new Set(Array.from({ length: 700 }, () => fx.add('smoke', { x: 2, y: 1, life: 10 })));
  for (const quality of ['high', 'balanced', 'low']) {
    fx.setQuality(quality); fx.consume(Array(600).fill(ray));
    assert(fx.particles.length <= fx.limit);
    assert(fx.particles.some(p => p.kind === 'flash' && p.art === 'spark'), 'a ray shows as its streak');
    assert(fx.particles.every(p => ambient.has(p) || p.effectActorId === 'tank'));
    assert.equal(fx.particles.filter(p => ambient.has(p)).length, 700, 'and takes the room of no smoke');
  }
  fx.setActors([{ id: 'tank', revision: 1 }]);
  assert.deepEqual(new Set(fx.particles), ambient, 'ambient smoke survives a vehicle reset that takes its fragments');
  fx.clear(); fx.consume([{ ...ray, endX: NaN }, { ...ray, endX: 2 }]); assert.equal(fx.particles.length, 0, 'nor is a ray of no length drawn');
});

test('real secondary contacts retain bounded sparks, actor ownership and sprite reuse', t => {
  const fx = effects(t), contact = { type: 'secondary-impact', actorId: 'tank', x: 3, y: 1,
    nx: -1, ny: 0, material: 'steel', power: 2, fragment: true, instantaneous: true }, before = structuredClone(contact);
  fx.setActors([{ id: 'tank', revision: 0 }]); fx.consume([contact]);
  assert.equal(fx.particles.length, 2);
  assert(fx.particles.every(p => p.kind === 'spark' && p.effectActorId === 'tank' && p.x === contact.x && p.y === contact.y));
  const sprites = fx.particles.map(p => p.sprite);
  fx.update(.2); assert.equal(fx.particles.length, 0);
  fx.consume([contact]); assert(fx.particles.every(p => sprites.includes(p.sprite)));
  fx.setActors([{ id: 'tank', revision: 1 }]); assert.equal(fx.particles.length, 0);
  assert(sprites.every(sprite => fx.pool.includes(sprite))); assert.deepEqual(contact, before);
});

test('simultaneous explosion flashes use a bounded sprite pool', t => {
  const fx = effects(t); fx.setQuality('low');
  fx.consume(Array.from({ length: 150 }, (_, i) => ({ type: 'explosion', x: i, y: 1, power: 240, radius: 1 })));
  fx.sample(1);
  assert.equal(fx.lights.length, 64); assert.equal(fx.lightSprites.length, 64);
  assert.equal(fx.lights.at(-1).x, 149, 'the latest explosion still gets a flash');
  fx.update(.2); fx.sample(1);
  assert.equal(fx.lights.length, 0); assert(fx.lightSprites.every(sprite => !sprite.visible));
});

test('smoke reuses ground samples aloft and refreshes them near contact or after a map change', t => {
  const fx = effects(t); let queries = 0;
  fx.terrain = { height() { queries++; return 0; } };
  const p = fx.add('smoke', { x: 2, y: 2, vx: .1, vy: 0, life: 10, size: .2 });
  fx.update(.01); const initial = queries;
  for (let i = 0; i < 20; i++) fx.update(.01);
  assert.equal(queries, initial, 'slow smoke does not query the same contour every frame');
  p.y = .02; p.vy = -1; fx.update(.01); assert(queries > initial);
  fx.terrain = { height() { return 1; } }; fx.update(.01);
  assert.equal(p.y, 1.005, 'a new map invalidates the cached height immediately');
});

test('component dent textures keep UV position and projectile scale across component aspect ratios', () => {
  function draw(width, height, widthM, heightM, mark) {
    const ops = [], ctx = { canvas: { width, height }, save() {}, restore() {}, translate: (x, y) => ops.push(['translate', x, y]), scale: (x, y) => ops.push(['scale', x, y]), createRadialGradient: (...radii) => { ops.push(['gradient', ...radii]); return { addColorStop() {} }; }, fillRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, fill() {}, arc() {}, stroke() {} };
    paintComponentDamage(ctx, [mark], widthM, heightM); return ops;
  }
  const small = draw(800, 120, 5, 0.75, { u: 0.2, v: 0.8, radiusU: 0.01, kind: 'dent', strength: 0.4 });
  const large = draw(800, 120, 5, 0.75, { u: 0.2, v: 0.8, radiusU: 0.02, kind: 'dent', strength: 0.4 });
  assert.deepEqual(small[0], ['translate', 160, 96]); assert.deepEqual(small[1], ['scale', 1, 1]);
  assert.equal(large[2].at(-1), small[2].at(-1) * 2);
  const squareSkin = draw(400, 260, 2, 1, { u: 0.5, v: 0.5, radiusU: 0.03, kind: 'dent' });
  assert.deepEqual(squareSkin[1], ['scale', 1, 1.3]);
});
test('fire illumination keeps an offset root on a turning carrier instead of jumping to its centre', t => {
  const fx = effects(t), pose = { x:10,y:1,angle:0 };
  fx.pose = () => pose;
  fx.light({ key:'burn:a',carrier:'part',x:10.4,y:4,life:2,age:0,size:2,strength:.3 });
  pose.x = 12; pose.angle = Math.PI/2; fx.update(.1); fx.sample(1);
  const light = fx.lights[0];
  assert(Math.abs(light.displayX-9)<1e-9 && Math.abs(light.displayY-1.4)<1e-9);
  assert(light.displayStrength>.25 && light.displayStrength<=.3);
  assert.equal(light.sprite.x,light.displayX); assert.equal(light.sprite.y,light.displayY);
});
