import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {componentDepth,componentVolume} from '../src/component-volume.ts';
import {createStructuredConstruction,planStructuredComponent} from '../src/structured-construction.ts';
import {validateBlueprint,compileBlueprint,serializeBlueprint,parseBlueprint} from '../src/persistence.ts';
import {structuredTemplateSource} from '../src/structured-templates.ts';
import {WEAPON_PRESETS,weaponMountSize} from '../src/weapons.ts';
import {Editor} from '../src/editor.ts';
import {MODULES} from '../src/materials.ts';
await initNativeDynamics();
const near=(a,b)=>assert(Math.abs(a-b)<1e-8);
test('source persists only uniform size; independent height and depth are refused rather than normalized',()=>{
 const source=structuredTemplateSource('heavy');
 for(const field of ['width','height','depthM']){
  const broken=structuredClone(source);broken.components.find(m=>m.kind==='engine')[field]=4;
  assert.throws(()=>validateBlueprint(broken));
 }
 assert(!serializeBlueprint(source).includes('depthM'));assert.deepEqual(parseBlueprint(serializeBlueprint(source)),validateBlueprint(source));
});
for(const preset of Object.keys(WEAPON_PRESETS))test(preset+': catalogue fixes weapon dimensions and prevents direct resizing',()=>{
 const source=structuredTemplateSource('scout',{preset}),gun=compileBlueprint(source).modules.find(m=>m.kind==='weapon'),
  dimensions=weaponMountSize(preset);
 assert.equal(gun.width,dimensions.width);assert.equal(gun.height,dimensions.height);
 const broken=structuredClone(source);broken.components.find(m=>m.kind==='weapon').width=4;
 assert.throws(()=>validateBlueprint(broken));
});
test('resizing an explicitly positioned engine is one undoable edit and preserves its stable identity and pose',()=>{
 let source=createStructuredConstruction({length:8,height:3});
 source=planStructuredComponent(source,{id:'engine',kind:'engine',sizeScale:1,
  pose:{x:11,y:source.nodes[0].y+12,angle:0}}).construction;
 const editor=new Editor(source);editor.select('engine');const before=structuredClone(editor.selected);
 editor.editProperty('sizeScale',1.25,true);const enlarged=structuredClone(editor.selected);
 near(enlarged.width/before.width,1.25);near(enlarged.height/before.height,1.25);
 // As deep across the body: its volume follows what the side view shows of it.
 near(componentDepth(enlarged)/componentDepth(before),1);
 near(componentVolume(enlarged)/componentVolume(before),1.25**2);
 assert.equal(enlarged.x,before.x);assert.equal(enlarged.y,before.y);assert.equal(enlarged.id,before.id);assert.equal(editor.past.length,1);
 assert(editor.undo());assert.deepEqual(editor.selected||editor.blueprint.modules.find(m=>m.id==='engine'),before);
 assert(editor.redo());editor.select('engine');assert.deepEqual(editor.selected,enlarged);
 const history=editor.past.length;assert.throws(()=>editor.editProperty('sizeScale',100,true));
 assert.equal(editor.past.length,history);assert.equal(editor.before,null);assert.deepEqual(editor.selected,enlarged);
});
test('a hopper, a cistern and a supply piece grow to three times their size, in length and height only',()=>{
 for(const kind of ['hopper','cistern','supply']){
  const base=createStructuredConstruction({length:10,height:4}),
   source=planStructuredComponent(base,{id:'load',kind,sizeScale:1,pose:{x:-44,y:base.nodes[0].y+30,angle:0}}).construction;
  const editor=new Editor(source);editor.select('load');const before=structuredClone(editor.selected);
  editor.editProperty('sizeScale',3,true);const largest=structuredClone(editor.selected);
  near(largest.width/before.width,3);near(largest.height/before.height,3);
  // The core and the page measure the one depth: that of its kind, at any size.
  const depth=MODULES[kind].depthM;
  assert.equal(largest.mechanicalDepth,depth);assert.equal(componentDepth(largest),depth);
  near(componentVolume(largest),largest.width*largest.height*depth);near(componentVolume(largest)/componentVolume(before),9);
  const history=editor.past.length;assert.throws(()=>editor.editProperty('sizeScale',3.05,true));assert.equal(editor.past.length,history);
 }
});
