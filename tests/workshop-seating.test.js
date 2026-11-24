import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { compatibleWeaponMounts } from '../src/weapon-mounts.ts';
import { componentPolygon } from '../src/assembly.ts';
import { worldToLocal } from '../src/math.ts';
await initNativeDynamics();
const near = (a,b) => assert(Math.abs(a-b)<1e-8, `${a} != ${b}`);
const room = () => new Editor(createStructuredConstruction({preset:'bunker',length:6,height:2,frontInset:0,rearInset:0,thicknessMm:20}));
const bare = () => { const e=room(); return new Editor({...e.source,nodes:[],plates:[],components:[]}); };

for (const snap of [false,true]) test(`surface support seats a camera independently of grid=${snap}`,()=>{
  const e=room();e.snap=snap;
  const roof=e.blueprint.plates.find(p=>p.id==='hull:roof'), x=roof.x+.137,
    placed=e.addModule('sensor',{x,y:roof.y+roof.thicknessMm/2000+.12+.027},{sensorMode:'visual',faceTolerance:.08});
  near(placed.y-placed.height/2,roof.y+roof.thicknessMm/2000);
  if(!snap) near(placed.x,x);
  assert(!e.reviewManufacture().some(issue=>issue.ids?.includes(placed.id)), 'the actual foot is supported');
  e.select(placed.id);const original=e.captureSelection(),before=structuredClone(e.source);
  e.begin(); assert(e.moveSelection(original,.113,.023,{faceTolerance:.08})); e.commit();
  near(e.selected.y-e.selected.height/2,roof.y+roof.thicknessMm/2000);
  if(!snap) near(e.selected.x,placed.x+.113);
  e.undo();assert.deepEqual(e.source,before);
});

for(const mirrored of [false,true]) test(`grid-free weapon gestures seat a gun at wall and roof, keeping its angle and mounting, mirrored=${mirrored}`,()=>{
  const e=bare();e.snap=false;
  const wall=e.addPlate({x:12.137,y:3.017},{x:12.137,y:5.017}), roof=e.addPlate({x:12.137,y:5.017},{x:15.137,y:5.017}),
    gun=e.addModule('weapon',{x:12.15,y:4.128},{weaponPreset:'m2hb',mirrored,faceTolerance:.08});
  assert.equal(gun.weaponMount.hostId,wall.id);assert.equal(gun.weaponMount.max-gun.weaponMount.min,0);
  e.select(gun.id);const before=structuredClone(e.source),original=e.captureSelection(),part=before.components.find(p=>p.id===gun.id);e.begin();
  assert(e.moveSelection(original,13.489-gun.x,5.03-gun.y,{faceTolerance:.08}));assert(e.commit());
  // Over the roof it keeps its mounting and its level bore, and stands on its feet on the roof, firing through nothing.
  const moved=e.source.components.find(p=>p.id===gun.id);
  assert.deepEqual(moved.mount,part.mount);assert.equal(moved.pose.angle,part.pose.angle);
  assert.equal(e.selected.weaponMount.preset,'light-trunnion');assert.equal(e.selected.weaponMount.hostId,null);
  near(e.selected.x,13.489);near(Math.sin(e.selected.barrelAngle),0);
  // Of its support only: with no box of its calibre it is not fabricated either (`WEAPON_UNFED`).
  assert(!e.reviewManufacture().some(issue=>issue.code==='PHYSICAL_SUPPORT'&&issue.ids?.includes(gun.id)),'its feet stand on the roof');
  assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)),e.source);e.undo();assert.deepEqual(e.source,before);
});

test('changing mounting reuses the actual plate and station rather than retaining the old inset, and a post never stands on a wall',()=>{
  const e=bare();e.snap=false;
  const wall=e.addPlate({x:12,y:3},{x:12,y:5}), gun=e.addModule('weapon',{x:12,y:4.137},{weaponPreset:'m2hb',faceTolerance:.08}),
    before=structuredClone(e.source), history=e.past.length;
  assert.equal(gun.weaponMount.hostId,wall.id);
  // A post stands straight down to a face it can stand on: not on a wall, which keeps its gun as it was.
  e.select(gun.id);assert.throws(()=>e.editProperty('mountPreset','pintle',true));
  assert.deepEqual(e.source,before);assert.equal(e.past.length,history);
  const f=bare();f.snap=false;
  const roof=f.addPlate({x:11,y:5},{x:15,y:5}), under=f.addModule('weapon',{x:13,y:4.98},{weaponPreset:'m2hb',angle:Math.PI/2,faceTolerance:.08}),
    kept=structuredClone(f.source), past=f.past.length;
  assert.equal(under.weaponMount.hostId,roof.id);assert.equal(under.weaponMount.exposed,false);
  f.select(under.id);f.editProperty('mountPreset','pintle',true);
  assert.equal(f.selected.id,under.id);assert.equal(f.selected.weaponMount.hostId,roof.id);
  assert.equal(f.selected.weaponMount.preset,'pintle');near(f.selected.x,under.x);
  assert(f.selected.y>roof.y,'the new support has its own physical stand-off, over the roof');
  assert.equal(f.past.length,past+1);f.undo();assert.deepEqual(f.source,kept);
  f.redo();f.select(under.id);f.editProperty('mountPreset','light-trunnion',true);
  assert.equal(f.selected.weaponMount.hostId,roof.id);near(f.selected.x,under.x);near(f.selected.y,under.y);
});

test('grid-free assistance reaches a sloping material face without changing the authored angle',()=>{
  const e=bare();e.snap=false;
  const floor=e.addPlate({x:10.137,y:4.017},{x:14.137,y:4.317}),
    camera=e.addModule('sensor',{x:12.237,y:4.32},{sensorMode:'visual',faceTolerance:.08}),
    contact=Math.min(...componentPolygon(camera).map(p=>worldToLocal(floor,p).v));
  near(contact,floor.thicknessMm/2000);near(camera.angle,0);
  assert(!e.reviewManufacture().some(issue=>issue.ids?.includes(camera.id)));
});

for(const mirrored of [false,true]) test(`changing a roof support preserves the bore and real foot contact, mirrored=${mirrored}`,()=>{
  const e=bare();e.snap=false;
  const roof=e.addPlate({x:11,y:4},{x:15,y:4}),
    gun=e.addModule('weapon',{x:13.137,y:4},{weaponPreset:'m2hb',mirrored,faceTolerance:.08});
  e.select(gun.id);const bore=gun.barrelAngle;
  e.editProperty('mountPreset','light-trunnion',true);
  assert.equal(e.selected.weaponMount.hostId,null,'the ordinary platform has no armour port');
  near(Math.sin(e.selected.barrelAngle-bore),0);near(Math.cos(e.selected.barrelAngle-bore),1);
  e.editProperty('mountPreset','pintle',true);
  assert.equal(e.selected.weaponMount.hostId,roof.id);near(e.selected.x,gun.x);near(e.selected.y,gun.y);
  near(Math.sin(e.selected.barrelAngle-bore),0);near(Math.cos(e.selected.barrelAngle-bore),1);
});

test('every weapon can be placed at a wall, repositioned and changed between the compatible supports that fire through it without deleting it',()=>{
  for(const preset of Object.keys(WEAPON_PRESETS)) {
    const e=bare();e.snap=false;
    const wall=e.addPlate({x:12,y:3},{x:12,y:7});
    let gun;
    try { gun=e.addModule('weapon',{x:12,y:5},{weaponPreset:preset,faceTolerance:.08}); }
    catch(error) { assert.fail(preset+': '+JSON.stringify(error)); }
    assert.equal(gun.weaponMount.hostId,wall.id,preset);e.select(gun.id);
    const original=e.captureSelection();e.begin();
    assert(e.moveSelection(original,0,.137,{faceTolerance:.08}),preset);assert(e.commit(),preset);
    const y=e.selected.y;
    for(const [mount,profile] of compatibleWeaponMounts(preset)) {
      // A post stands on no wall.
      if (profile.exposed) { const kept=structuredClone(e.source); assert.throws(()=>e.editProperty('mountPreset',mount,true),undefined,preset+'/'+mount);
        assert.deepEqual(e.source,kept,preset+'/'+mount); continue; }
      e.editProperty('mountPreset',mount,true);
      assert.equal(e.selected.id,gun.id,preset+'/'+mount);
      assert.equal(e.selected.weaponMount.hostId,wall.id,preset+'/'+mount);
      assert.equal(e.selected.weaponMount.preset,mount,preset+'/'+mount);near(e.selected.y,y);
    }
    assert.deepEqual(parseBlueprint(serializeBlueprint(e.source)),e.source,preset);
  }
});
