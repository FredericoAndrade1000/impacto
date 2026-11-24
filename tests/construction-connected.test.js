import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction,CONSTRUCTION_TEMPLATES} from '../src/construction-templates.ts';
import {compileBlueprint,validateBlueprint} from '../src/persistence.ts';
import {Editor} from '../src/editor.ts';
await initNativeDynamics();

for(const template of CONSTRUCTION_TEMPLATES) test(template.id+': compiled rigid geometry has one valid root',()=>{
 const source=createConstruction(template.id),dto=compileBlueprint(source),
  ids=new Set([...dto.plates,...dto.modules].map(p=>p.id));
 assert.equal(dto.mechanicalAdmission,true);assert(ids.has(dto.vehicle.chassisId));
 assert.equal(Object.hasOwn(dto,'attachments'),false);
 assert.deepEqual(source,validateBlueprint(source));
});
test('authored attachment metadata cannot replace compiled mechanical geometry',()=>{
 const source=createConstruction('heavy');
 for(const mutation of [s=>s.components[0].mountId='missing',s=>s.plates[0].anchors=[],s=>s.plates[1].mountId='hull:floor',
  s=>s.modules=[],s=>s.rooms=[]]){
  const broken=structuredClone(source);mutation(broken);assert.throws(()=>validateBlueprint(broken));
 }
});
test('opening a room removes only the chosen plate and retains its equipment for undo',()=>{
 const editor=new Editor(createConstruction('ifv')),before=structuredClone(editor.source);
 editor.select('hull:front');editor.remove();
 assert.deepEqual(editor.source.components,before.components);
 assert.equal(editor.source.plates.length,before.plates.length-1);
 assert.equal(editor.source.plates.some(plate=>plate.id==='hull:front'),false);
 assert.equal(editor.past.length,1);
 assert(editor.undo());assert.deepEqual(editor.source,before);
});

