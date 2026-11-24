import test from 'node:test';
import assert from 'node:assert/strict';
import { effectsFixture } from '../scripts/mobile-effects-fixture.ts';

test('the fire presentation fixture marks only emitting fuel parts without changing Native records',()=>{
  for(const [effect,count] of [['burn',1],['burnGroup',2]])for(const parts of [false,true]){
    const modules=['a','b'].flatMap(actorId=>[{id:actorId+':fuel',actorId,kind:'fuel',x:3,y:2,health:80,fuelLitres:120,burning:false},
      {id:actorId+':engine',actorId,kind:'engine',health:90,burning:false}]),
      state={actors:[{id:'a'},{id:'b'}],modules},before=structuredClone(state),packets=[{state}];
    effectsFixture(packets,{effect,parts},null,null,{});
    assert.deepEqual(state,before);assert.equal(packets[0].events.length,count);
    assert.equal(packets[0].state.modules.filter(part=>part.burning).length,count*(parts?2:1));
    assert(packets[0].state.modules.every((part,i)=>part.health===modules[i].health&&part.fuelLitres===modules[i].fuelLitres));
  }
});

test('an isolated blast has one fixed event while a barrage repeats on the same recorded poses',()=>{
  const state={actors:[{id:'a',vehicle:{x:4,y:2}}],modules:[]}, before=structuredClone(state);
  for(const [effect,expected] of [['blastOnce',[60]],['blast',[0,30,60,90,120]]]){
    const packets=Array.from({length:121},()=>({state}));
    effectsFixture(packets,{effect},null,{height:()=>1},{});
    assert.deepEqual(packets.flatMap((p,i)=>p.events.length?[i]:[]),expected);
    assert(packets.every(p=>p.events.every(e=>e.type==='explosion'&&e.x===12&&e.y===1.02)));
  }
  const packets=Array.from({length:4},()=>({state}));
  effectsFixture(packets,{effect:'drive'},null,null,{});
  assert(packets.every(p=>p.events.length===0),'group dust uses recorded wheel contacts without synthetic emitters');
  assert.deepEqual(state,before);
});
