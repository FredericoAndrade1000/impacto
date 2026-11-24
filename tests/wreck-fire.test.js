import test from 'node:test';
import assert from 'node:assert/strict';
import { FramePresentation } from '../src/presentation.ts';

const state=time=>({time,actors:[{id:'w',burning:true,defeated:true,vehicle:{x:40,y:1},field:{wreck:{until:200}}}],modules:[],plates:[]});

test('a wreck draws only the shared fire events actually delivered by the core',()=>{
  const playback=new FramePresentation(),consumed=[],event={type:'burn',actorId:'w',componentId:'w:engine',x:40,y:1,strength:.8,time:10.1};
  playback.receive(state(10));playback.receive(state(10.2),[event]);
  const shown=playback.present({time:10.2,state:state(10.2)},{consume:e=>consumed.push(e)});
  assert.deepEqual(shown.events,[event]);assert.deepEqual(consumed,[event]);
  assert.deepEqual(playback.present({time:10.4,state:state(10.4)}).events,[]);
});
test('a legacy wreck timer cannot manufacture fire after combustible material has run out',()=>{
  const playback=new FramePresentation(),before=state(10),after=state(11);
  for(const frame of[before,after]){frame.actors[0].burning=false;frame.actors[0].field.wreck.burns=100;}
  playback.receive(before);playback.receive(after);
  assert.deepEqual(playback.present({time:11,state:after}).events,[]);
});
