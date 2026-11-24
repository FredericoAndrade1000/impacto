import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {validateBlueprint,compileBlueprint} from '../src/persistence.ts';
import {Editor} from '../src/editor.ts';
import {standing} from './helpers/designs.js';
await initNativeDynamics();

test('a design drives exactly when it has a chassis and stands without one, keeping its components',()=>{
 const source=createConstruction('heavy'),editor=new Editor(source),components=structuredClone(source.components);
 assert.equal(compileBlueprint(source).vehicle.enabled,true);
 editor.change(s=>{const fixed=standing(s);for(const key of Object.keys(s))delete s[key];Object.assign(s,fixed);});
 assert.deepEqual(editor.source.components,components);
 assert.equal(compileBlueprint(editor.source).vehicle.enabled,false);
 assert(editor.undo());assert.deepEqual(editor.source,source);
});
test('an authored vehicle switch or independent chassis is refused without repairing the source',()=>{
 for(const vehicle of [{enabled:false},{chassisId:'hull:roof'}]){
  const source={...createConstruction('scout'),vehicle},before=structuredClone(source);
  assert.throws(()=>validateBlueprint(source),{ reason: 'AUTHORING_FIELDS' });assert.deepEqual(source,before);
 }
});
