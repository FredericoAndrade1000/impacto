import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {Editor} from '../src/editor.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {createStructuredConstruction,planStructuredComponent} from '../src/structured-construction.ts';
import {DESIGN_VERSION,compileBlueprint,serializeBlueprint,parseBlueprint,validateBlueprint} from '../src/persistence.ts';
import {componentPolygons} from '../src/assembly.ts';
import {World} from '../src/physics.ts';
import {physics,ownerState,setPart} from './mechanical-queries.js';
import {assertMountProjection} from './helpers/weapon-mount-shape.js';
await initNativeDynamics();

test('selection toggles membership and preserves document history while native geometry remains read-only',()=>{
 const editor=new Editor(createConstruction('heavy')),ids=editor.blueprint.modules.slice(0,2).map(m=>m.id),
  before=structuredClone(editor.source);
 editor.select(ids);assert.equal(editor.selectionIds.size,2);editor.select(ids[0],{toggle:true});
 assert.equal(editor.past.length,0);assert.deepEqual(editor.source,before);
 assert.throws(()=>{editor.blueprint.modules[0].x+=1;},TypeError);
});
test('opening the hull removes only the selected plate and preserves all equipment poses',()=>{
 const editor=new Editor(createConstruction('heavy')),source=structuredClone(editor.source);
 editor.select('hull:front');editor.remove();
 assert.equal(editor.source.plates.length,source.plates.length-1);
 assert(!editor.source.plates.some(p=>p.id==='hull:front'));
 assert.deepEqual(editor.source.components,source.components);
 assert(editor.undo());assert.deepEqual(editor.source,source);
});
test('free components duplicate at the cursor, undo once and keep the hull canonical',()=>{
 let source=createStructuredConstruction({length:8,height:3});
 // At (0.2 m, 0.5 m), in cells.
 source=planStructuredComponent(source,{id:'fuel',kind:'fuel',sizeScale:.5,
  pose:{x:4,y:10,angle:0}}).construction;
 const editor=new Editor(source);editor.select('fuel');const frame=structuredClone([source.nodes,source.plates]);
 const intent=editor.duplicate();editor.addModule(intent.kind,{x:14,y:editor.selected.y},intent);assert.equal(editor.source.components.length,2);
 assert.deepEqual([editor.source.nodes,editor.source.plates],frame);assert.equal(editor.blueprint.mechanicalAdmission,true);
 assert.notDeepEqual(editor.source.components[0].pose,editor.source.components[1].pose);
 assert(editor.undo());assert.deepEqual(editor.source,source);assert(editor.redo());
 const saved=parseBlueprint(serializeBlueprint(editor.source));assert.equal(saved.version,DESIGN_VERSION);
 assert.equal(saved.components.length,2);assert(!Object.hasOwn(saved,'modules'));
});
test('an invalid weapon mounting or swept-sector request is refused before a world or resources are created',()=>{
 const source=createConstruction('heavy'),before=structuredClone(source),gun=source.components.find(m=>m.kind==='weapon');
 for(const mount of [{...gun.mount,preset:'absent'}, {...gun.mount,sector:{min:-Math.PI,max:Math.PI}}]){
  const broken=structuredClone(source);broken.components.find(m=>m.id===gun.id).mount=mount;
  assert.throws(()=>validateBlueprint(broken));
 }
 assert.deepEqual(source,before);
});
test('the native weapon supplies a receiver, tube and finite curved shield on one carrier',t=>{
 const source=createConstruction('heavy'),dto=compileBlueprint(source),gun=dto.modules.find(m=>m.kind==='weapon'),
  world=new World(source);t.after(()=>world.dispose());
 assertMountProjection(gun);
 const posed=componentPolygons(gun),c=Math.cos(gun.barrelAngle),s=Math.sin(gun.barrelAngle);
 assert.equal(posed.length,gun.materialPolygons.length);
 for(const [role,polygon] of gun.materialPolygons.entries())for(const [index,point] of polygon.entries()){
  assert(Math.abs(posed[role][index].x-(gun.x+c*point.x-s*point.y))<1e-10);
  assert(Math.abs(posed[role][index].y-(gun.y+s*point.x+c*point.y))<1e-10);
 }
 const state=physics(world);assert.equal(state.bodyStates.length,1);
 const installed=world.modules.find(m=>m.kind==='weapon'),carrier=ownerState(world,installed);
 assertMountProjection(installed);assert.deepEqual(installed.materialPolygons,gun.materialPolygons);
 assert.deepEqual(installed.weaponMount.shield,gun.weaponMount.shield);
 assert.equal(carrier.body,state.bodyStates[0].handle);
 for(const part of [...world.plates,...world.modules])assert.equal(ownerState(world,part).body,carrier.body);
});
test('functional failure retains real barrel geometry, installation, carrier mass and inertia',t=>{
 const world=new World(createConstruction('heavy'));t.after(()=>world.dispose());
 const gun=world.modules.find(m=>m.kind==='weapon'),before=physics(world).bodyStates[0],polygons=componentPolygons(gun),
  attachment=gun.mountId;
 assertMountProjection(gun);
 setPart(world,gun,{health:0});
 const after=physics(world).bodyStates[0];assert.equal(gun.health,0);assert.equal(gun.attached,true);
 assert.equal(gun.mountId,attachment);assert.equal(after.mass,before.mass);assert.equal(after.inertia,before.inertia);
 assertMountProjection(gun);
 assert.deepEqual(componentPolygons(gun),polygons);
});
test('authorship cannot restore health or inject servo state, port geometry, mass or arbitrary barrel positions',()=>{
 const source=createConstruction('scout'),id=source.components.find(m=>m.kind==='weapon').id;
 for(const field of ['health','barrelAngle','targetBarrelAngle','weaponMount','physicalMass','materialPolygons']){
  const broken=structuredClone(source);broken.components.find(m=>m.id===id)[field]=0;
  assert.throws(()=>validateBlueprint(broken),field);
 }
});
