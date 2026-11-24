import { handlePoints, editWeaponSector } from '../src/workshop-ux.ts';
import test from 'node:test';
import assert from 'node:assert/strict';

import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { metresOf } from '../src/grid.ts';
import { angleDifference } from '../src/math.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { workshopCanvas } from './helpers/workshop-canvas.js';
await initNativeDynamics();
const near = (a,b) => assert(Math.abs(a-b)<1e-8, a+' differs from '+b);
const empty = () => { const s=createStructuredConstruction({preset:'bunker',length:6,height:3,thicknessMm:8}); return new Editor({...s,nodes:[],plates:[],components:[]}); };
const at = (e,id) => e.source.components.find(p=>p.id===id);
const span = (e,id) => e.plateSpans().find(p=>p.id===id);
function armedPlate() {
 const e=empty(), plate=e.addPlate({x:12,y:3},{x:12,y:5}), gun=e.addModule('weapon',{x:12,y:4},{weaponPreset:'m2hb',faceTolerance:.08,sectorMin:-.05,sectorMax:.05});
 assert.equal(gun.weaponMount.hostId,plate.id); return {e,plateId:plate.id,gunId:gun.id};
}
test('moving an armed plate carries its gun once, with its original configuration and undo',()=>{
 const {e,plateId,gunId}=armedPlate(), before=structuredClone(e.source), gun=structuredClone(at(e,gunId));
 e.snap=false; e.select(plateId); e.begin(); assert(e.movePlate(span(e,plateId),.137,.083)); assert(e.commit());
 const moved=at(e,gunId); near(metresOf(moved.pose.x-gun.pose.x),.137); near(metresOf(moved.pose.y-gun.pose.y),.083);
 assert.deepEqual(moved.mount,gun.mount); assert.equal(moved.id,gun.id); assert.equal(moved.weaponPreset,gun.weaponPreset);
 assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)),e.source); const after=structuredClone(e.source);
 e.undo(); assert.deepEqual(e.source,before); e.redo(); assert.deepEqual(e.source,after);
 e.select([plateId,gunId]); const original=e.captureSelection(), previous=structuredClone(at(e,gunId));
 e.begin(); assert(e.moveSelection(original,.1,.05)); e.commit();
 near(metresOf(at(e,gunId).pose.x-previous.pose.x),.1); near(metresOf(at(e,gunId).pose.y-previous.pose.y),.05);
});
test('numeric rotation and length preserve a mounted gun along its actual host',()=>{
 const {e,plateId,gunId}=armedPlate(), before=structuredClone(e.source), original=structuredClone(at(e,gunId));
 e.select(plateId); e.editProperty('angle',Math.PI/2+.12,true);
 near(angleDifference(at(e,gunId).pose.angle,original.pose.angle),.12);
 assert.equal(e.blueprint.modules.find(p=>p.id===gunId).weaponMount.hostId,plateId);
 e.editProperty('length',2.3,true); assert.equal(e.blueprint.modules.find(p=>p.id===gunId).weaponMount.hostId,plateId);
 assert.deepEqual(at(e,gunId).mount.sector,original.mount.sector); e.undo(); e.undo(); assert.deepEqual(e.source,before);
});

test('a refused armed-plate move leaves the whole design and undo history intact',()=>{
 const {e,plateId,gunId}=armedPlate(); e.snap=false;
 const blocker=e.addPlate({x:13.5,y:3},{x:13.5,y:5}); assert(blocker);
 const before=structuredClone(e.source); e.select(plateId); e.begin();
 assert.equal(e.movePlate(span(e,plateId),.9,0),false); assert.equal(e.commit(),false);
 assert.deepEqual(e.source,before); assert.equal(at(e,gunId).id,gunId);
 e.undo(); assert(!e.source.plates.some(p=>p.id===blocker.id));
 e.redo(); assert.deepEqual(e.source,before);
});
test('assisted endpoint movement lands exactly on a fractional sloping plate, which is divided at that very end',()=>{
 const e=empty(); e.snap=false;
 const host=e.addPlate({x:10.013,y:3.017},{x:14.013,y:3.317}), free=e.addPlate({x:12,y:4.5},{x:12.2,y:3.6}), hit=e.pickNode(span(e,free.id).b,.001), before=structuredClone(e.source);
 e.snap=true; const on={x:12.113,y:3.1745}; e.begin(); assert(e.moveNode(hit,{x:on.x+.004,y:on.y+.012},{faceTolerance:.06})); e.commit();
 const node=e.nodes().find(n=>n.id===hit.id), h=span(e,host.id);
 near((node.x-h.a.x)*(h.b.y-h.a.y)-(node.y-h.a.y)*(h.b.x-h.a.x),0);
 assert.equal(e.source.plates.length,3); assert.equal(e.source.plates.find(p=>p.id===host.id).b,hit.id, 'the host keeps its id up to the end');
 assert(e.source.plates.some(p=>p.id!==host.id&&p.a===hit.id&&p.id!==free.id), 'and goes on from it');
 e.undo(); assert.deepEqual(e.source,before);
});
test('drawing onto a fractional chassis floor keeps its exact join with grid assistance',async()=>{
 const f=workshopCanvas();
 const top=f.editor.plateSpans().find(p=>p.id==='chassis:top-0'); assert(top);
 const on={x:top.a.x+(top.b.x-top.a.x)*.715,y:top.a.y+(top.b.y-top.a.y)*.715};
 f.view.buildTool='plate'; f.view.repeatPlacement=true;
 // From inside the hood, under its roof, which a plate from it would divide, between the engine and the back of the hood.
 const from=f.renderer.board.camera.toScreen(on.x,on.y+.5), to=f.renderer.board.camera.toScreen(on.x,on.y+.004);
 const count=f.editor.source.plates.length; f.downAt(from.x,from.y); f.moveAt(to.x,to.y); f.upAt(to.x,to.y);
 assert.equal(f.editor.source.plates.length,count+1); const added=f.editor.source.plates.at(-1), node=f.editor.nodes().find(n=>n.id===added.b);
 near((node.x-top.a.x)*(top.b.y-top.a.y)-(node.y-top.a.y)*(top.b.x-top.a.x),0);
});

test('new workshop guns start level with a compact sector, and dragged keep their mounting and are seated between roof and wall',()=>{
 const e=empty(), wall=e.addPlate({x:12,y:3},{x:12,y:5}), roof=e.addPlate({x:12,y:5},{x:15,y:5});
 const gun=e.addModule('weapon',{x:12,y:4},{weaponPreset:'m2hb',faceTolerance:.08});
 near(gun.weaponMount.max-gun.weaponMount.min,0); near(Math.sin(gun.barrelAngle),0); assert.equal(gun.weaponMount.hostId,wall.id);
 const identity=gun.id; e.select(identity); const original=e.captureSelection(); e.begin();
 assert(e.moveSelection(original,13.5-gun.x,5-gun.y,{faceTolerance:.08})); assert(e.commit());
 // On the roof, on its feet, its bore along it: it fires through nothing.
 let moved=e.blueprint.modules.find(p=>p.id===identity); assert.equal(moved.weaponMount.preset,'light-trunnion'); assert.equal(moved.weaponMount.hostId,null);
 assert(moved.y>roof.y); near(moved.angle,gun.angle);
 near(moved.weaponMount.max-moved.weaponMount.min,0); near(Math.sin(moved.barrelAngle),0);
 e.select(identity); const returned=e.captureSelection(); e.begin();
 assert(e.moveSelection(returned,12-moved.x,4-moved.y,{faceTolerance:.08})); assert(e.commit());
 moved=e.blueprint.modules.find(p=>p.id===identity); assert.equal(moved.weaponMount.preset,'light-trunnion'); assert.equal(moved.weaponMount.hostId,wall.id);
 near(moved.weaponMount.max-moved.weaponMount.min,0); near(Math.sin(moved.barrelAngle),0);
});
test('an exposed gun drawn off its roof stands on its post drawn out to it, up to 1.5 m, and on nothing further off',()=>{
 const e=empty(), roof=e.addPlate({x:12,y:5},{x:15,y:5}), gun=e.addModule('weapon',{x:13.5,y:5},{weaponPreset:'m2hb',faceTolerance:.08}),
  post=module=>{const xs=module.materialPolygons[0].map(p=>p.x);return Math.max(...xs)-Math.min(...xs);}, shortest=post(gun);
 assert.equal(gun.weaponMount.hostId,roof.id); assert(shortest<1);
 for (const [dy,held] of [[.5,true],[.65,true],[1,false]]) {
  e.select(gun.id); const original=e.captureSelection(); e.begin();
  assert(e.moveSelection(original,0,dy,{faceTolerance:.08})); assert(e.commit());
  const moved=e.blueprint.modules.find(p=>p.id===gun.id);
  near(moved.y-gun.y,dy); near(moved.x,gun.x); near(moved.angle,gun.angle);
  if (held) { assert.equal(moved.weaponMount.hostId,roof.id); near(post(moved),shortest+dy); assert(post(moved)<=1.5); }
  else { assert.equal(moved.weaponMount.hostId,null); near(post(moved),shortest); }
  e.undo();
 }
});
test('explicit installation sectors stay authored while fresh heavy guns no longer reserve the full catalogue sweep',()=>{
 const e=empty(), gun=e.addModule('weapon',{x:14,y:4},{weaponPreset:'rh120'});
 assert.equal(gun.weaponMount.min,0); assert.equal(gun.weaponMount.max,0);
 const h=empty(), explicit=h.addModule('weapon',{x:14,y:4},{weaponPreset:'rh120',sectorMin:-.17,sectorMax:.25});
 assert.equal(explicit.weaponMount.min,-.17); assert.equal(explicit.weaponMount.max,.25);
});

test('a heavy platform follows only its unique real fixed-foot host without a new saved attachment',()=>{
 const e=empty(), host=e.addPlate({x:11,y:3},{x:15,y:3}), gun=e.addModule('weapon',{x:13,y:3},{weaponPreset:'rh120',faceTolerance:.08});
 assert.equal(gun.weaponMount.hostId,null); const before=structuredClone(e.source), previous=structuredClone(at(e,gun.id));
 e.snap=false; e.select(host.id); e.begin(); assert(e.movePlate(span(e,host.id),.13,.11)); assert(e.commit());
 near(metresOf(at(e,gun.id).pose.x-previous.pose.x),.13); near(metresOf(at(e,gun.id).pose.y-previous.pose.y),.11);
 assert.equal(at(e,gun.id).mount.hostId,undefined); e.undo(); assert.deepEqual(e.source,before);
});
for (const mirrored of [false,true]) test('automatic roof mounting preserves a level compact bore, mirrored='+mirrored,()=>{
 const e=empty(), roof=e.addPlate({x:11,y:4},{x:15,y:4}), gun=e.addModule('weapon',{x:13,y:4},{weaponPreset:'m2hb',faceTolerance:.08,mirrored});
 assert.equal(gun.weaponMount.hostId,roof.id); assert.equal(gun.weaponMount.exposed,true); near(Math.sin(gun.barrelAngle),0);
 assert.equal(Math.sign(Math.cos(gun.barrelAngle)),mirrored ? 1 : -1); near(gun.weaponMount.max-gun.weaponMount.min,0);
});

test('a T join divides the host at its end, which a later drag of the part of the host takes along, the far ends staying',()=>{
 const e=empty(); e.snap=false; const host=e.addPlate({x:10.013,y:3.017},{x:14.013,y:3.317}), branch=e.addPlate({x:12,y:4.5},{x:12,y:3.6});
 const hit=e.pickNode(span(e,branch.id).b,.001); e.snap=true; e.begin(); assert(e.moveNode(hit,{x:12,y:3.17},{faceTolerance:.08})); e.commit();
 assert.equal(e.source.plates.length,3); assert.equal(e.source.plates.find(p=>p.id===host.id).b,hit.id);
 const rest=e.source.plates.find(p=>p.a===hit.id&&p.id!==branch.id), before=structuredClone(e.source), joint=e.nodes().find(n=>n.id===hit.id),
   ends=[e.source.plates.find(p=>p.id===branch.id).a,rest.b].map(id=>structuredClone(e.source.nodes.find(n=>n.id===id)));
 e.snap=false; e.begin(); assert(e.movePlate(span(e,host.id),.14,.11)); e.commit();
 const moved=e.nodes().find(n=>n.id===hit.id); near(moved.x-joint.x,.14); near(moved.y-joint.y,.11);
 for (const end of ends) assert.deepEqual(e.source.nodes.find(n=>n.id===end.id),end);
 assert.equal(e.source.plates.length,3); assert.equal(e.source.plates.find(p=>p.id===branch.id).b,hit.id,'the branch stays joined at the end it was divided at');
 e.undo(); assert.deepEqual(e.source,before);
});
test('dragging an enclosed howitzer preserves an explicitly chosen compatible mounting',()=>{
 const e=empty(), wall=e.addPlate({x:12,y:3},{x:12,y:6}), gun=e.addModule('weapon',{x:12,y:4.5},{weaponPreset:'m119',mountPreset:'heavy-trunnion',faceTolerance:.08});
 const configuration=structuredClone(at(e,gun.id).mount); e.select(gun.id); const original=e.captureSelection(); e.begin();
 assert(e.moveSelection(original,0,.1,{faceTolerance:.08})); e.commit(); assert.deepEqual(at(e,gun.id).mount,configuration);
 assert.equal(e.blueprint.modules.find(p=>p.id===gun.id).weaponMount.hostId,wall.id);
});

test('both compact sector grips remain distinct and edit the correct native limit when mirrored',async()=>{
 for (const mirrored of [false,true]) for (const grip of ['min','max']) {
   const e=empty(); e.addPlate({x:11,y:4},{x:15,y:4}); const gun=e.addModule('weapon',{x:13,y:4},{weaponPreset:'m2hb',faceTolerance:.08,mirrored}); e.select(gun.id);
   const before=structuredClone(e.source), old=e.selected.weaponMount, target=old[grip]+(grip==='min' ? -.06 : .06), angle=gun.angle+target;
   const handles=handlePoints(gun);
   assert(Math.hypot(handles.min.x-handles.max.x,handles.min.y-handles.max.y)>.1);
   e.begin(); editWeaponSector({editor:e,weapon:e.selected,grip,point:{x:gun.x+Math.cos(angle),y:gun.y+Math.sin(angle)},readout:{},refresh(){}}); assert(e.commit());
   const changed=e.selected.weaponMount; near(changed[grip],Math.round(target/(Math.PI/180))*Math.PI/180); near(changed[grip==='min' ? 'max' : 'min'],old[grip==='min' ? 'max' : 'min']);
   e.undo(); assert.deepEqual(e.source,before);
 }
});
