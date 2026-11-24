import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionCatalogue } from '../src/construction-admission.ts';
import { WEAPON_MOUNTS, weaponMountSpeed } from '../src/weapon-mounts.ts';
import { mountChoices } from '../src/piece-settings.ts';
import { angleDifference } from '../src/math.ts';
import { firingSolution } from '../src/ballistics.ts';
import { applyWorldInput } from '../src/episode-input.ts';
import { servoStatus } from '../src/weapon-presentation.ts';
import { materialState, setVehicle } from './mechanical-queries.js';
import { standing } from './helpers/designs.js';

const near = (a,b,tolerance=1e-8) => assert(Math.abs(a-b)<=tolerance,`${a} != ${b}`);
function sameState(actual,expected,path) {
  if(typeof expected==='number') near(actual,expected,path.endsWith('fuelLitres') ? .01 : 1e-8);
  else if(expected&&typeof expected==='object') {
    assert(actual&&typeof actual==='object',path);
    assert.deepEqual(Object.keys(actual),Object.keys(expected),path);
    for(const key of Object.keys(expected)) sameState(actual[key],expected[key],`${path}.${key}`);
  } else assert.deepEqual(actual,expected,path);
}
const artillery = [
  ['howitzer','m119',['heavy-trunnion','elevated-trunnion'],6],
  ['howitzer','m777',['heavy-trunnion','elevated-trunnion'],6],
  ['mortar','m224',['roof-mortar','light-trunnion'],10],
  ['mortar','m252',['roof-mortar','light-trunnion'],10],
];
for (const [model,preset,mounts,degrees] of artillery) test(`${preset}: every compatible mounting and its workshop choice show ${degrees}°/s`, t => {
  const source=structuredTemplateSource(model,{preset}), choices=mountChoices(preset), catalogue=constructionCatalogue();
  assert.equal(choices.length,mounts.length);
  for (const mountPreset of mounts) {
    const authored=structuredClone(source);authored.components.find(m=>m.kind==='weapon').mount.preset=mountPreset;
    const compiled=compileStructuredConstruction(authored), gun=compiled.modules.find(m=>m.kind==='weapon'), rate=degrees*Math.PI/180;
    near(gun.weaponMount.maxSpeed,rate);near(weaponMountSpeed(preset,WEAPON_MOUNTS[mountPreset]),rate);
    near(gun.weaponMount.fireTolerance,.1*Math.PI/180);
    const pose={...gun,barrelAngle:gun.angle};
    assert.equal(servoStatus(pose,gun.angle+.5*Math.PI/180).aligning,true);
    assert.equal(servoStatus(pose,gun.angle+.05*Math.PI/180).aligning,false);
    assert(choices.find(c=>c.id===mountPreset).detail.includes(`${degrees}°/s`));
    const part=authored.components.find(m=>m.kind==='weapon');
    assert(mountChoices(preset,authored,part).find(c=>c.id===mountPreset).detail.includes(`${degrees}°/s`));
    const world=new World(authored);t.after(()=>world.dispose());
    near(materialState(world,world.modules.find(m=>m.kind==='weapon')).servo.maxSpeed,rate);
    near(catalogue.weapons[preset].servoMaxSpeed,rate);
  }
});

test('ordinary weapon servo rates and slower mounting capacities are retained', () => {
  for (const [preset,mount,rate] of [['minimi','light-trunnion',60],['minimi','pintle',90],
    ['m242','medium-trunnion',45],['rh120','heavy-trunnion',30]]) {
    near(weaponMountSpeed(preset,WEAPON_MOUNTS[mount]),rate*Math.PI/180);
    assert(mountChoices(preset).find(c=>c.id===mount).detail.includes(`${rate}°/s`));
  }
  near(weaponMountSpeed('m119',{maxSpeed:Math.PI/90,ratedMass:WEAPON_MOUNTS['elevated-trunnion'].ratedMass}),Math.PI/90);
});

for (const [model,preset,,degrees] of artillery.filter((_,i)=>i%2===0)) test(`${preset}: each fixed tick respects ${degrees}°/s and a queued automatic shot fits its existing lifetime`, t => {
  const source=standing(structuredTemplateSource(model,{preset})), world=new World(source);t.after(()=>world.dispose());
  const gun=world.modules.find(m=>m.kind==='weapon'), config=world.playerWeapon({platform:'vehicle',componentId:gun.id}),
    rate=gun.weaponMount.maxSpeed, lower=gun.angle+gun.weaponMount.min, upper=gun.angle+gun.weaponMount.max,
    aim=bearing=>({x:gun.x+Math.cos(bearing)*500,y:gun.y+Math.sin(bearing)*500});
  // Direct bearing lays exactly at one end without needing a reachable ballistic arc to a synthetic point.
  const input=bearing=>applyWorldInput(world,'local',{type:'aim',phase:'before',platform:'vehicle',componentId:gun.id,
    aim:aim(bearing),aimAngle:bearing,charge:1});
  input(lower);let previous=gun.barrelAngle;
  for(let tick=0;tick<800;tick++) {
    world.step();assert(Math.abs(angleDifference(gun.barrelAngle,previous))<=rate/60+1e-8);previous=gun.barrelAngle;
  }
  near(angleDifference(gun.barrelAngle,lower),0,1e-7);
  const target={x:gun.x+(Math.cos(upper)<0?-500:500),y:gun.y+10},
    queued={...config,charge:1,trajectory:model==='mortar'?'high':'low'}, solution=firingSolution(gun,target,queued);
  assert(solution.reachable);
  if(model==='howitzer') assert(Math.abs(angleDifference(solution.angle,lower))>(upper-lower)*.9,'the slowest mechanism must cross almost its entire sector');
  assert.equal(applyWorldInput(world,'local',{...queued,type:'fire',phase:'before',aim:target,queue:true}).accepted,false);
  assert.equal(world.actor().pendingShot.expires,world.time+12);
  let elapsed=0,muzzle;
  for(;elapsed<720&&!world.stats.shots;elapsed++) {
    world.step();muzzle=world.drainEvents().find(event=>event.type==='muzzle')||muzzle;
  }
  assert.equal(world.stats.shots,1);assert(elapsed/60<12);assert.equal(world.actor().pendingShot,null);
  assert(muzzle);
  assert(Math.abs(angleDifference(muzzle.angle,firingSolution(gun,target,queued).angle))<=.1*Math.PI/180+1e-7);
  near(rate,degrees*Math.PI/180);
});

for(const [model,preset] of [['howitzer','m119'],['mortar','m252']])
test(`${preset}: a half-degree assisted artillery request waits, fires once, or cancels without a debit`,t=>{
  for(const cancel of [false,true]) {
    const world=new World(standing(structuredTemplateSource(model,{preset})));t.after(()=>world.dispose());
    const gun=world.modules.find(part=>part.kind==='weapon'),ammo=world.modules.find(part=>part.kind==='ammo'),
      config={...world.playerWeapon({platform:'vehicle',componentId:gun.id}),charge:1,trajectory:model==='mortar'?'high':'low'},
      upper=gun.angle+gun.weaponMount.max,target={x:gun.x+(Math.cos(upper)<0?-500:500),y:gun.y+10},
      solution=firingSolution(gun,target,config),window=.5*Math.PI/180;
    assert(solution.reachable);
    const relative=angleDifference(solution.angle,gun.angle),delta=relative+window<=gun.weaponMount.max?window:-window,
      bearing=solution.angle+delta;
    assert(relative+delta>=gun.weaponMount.min&&relative+delta<=gun.weaponMount.max);
    applyWorldInput(world,'local',{...config,type:'aim',phase:'before',aim:target,aimAngle:bearing});
    for(let tick=0;tick<800&&Math.abs(angleDifference(gun.barrelAngle,bearing))>1e-7;tick++)world.step();
    near(angleDifference(gun.barrelAngle,bearing),0,1e-7);
    const error=Math.abs(angleDifference(gun.barrelAngle,firingSolution(gun,target,config).angle))*180/Math.PI,
      rounds=ammo.rounds,shots=world.stats.shots;
    assert(error>.1&&error<1,`${preset}: measured boundary starts at ${error}degrees`);world.drainEvents();
    assert.equal(applyWorldInput(world,'local',{...config,type:'fire',phase:'before',aim:target,queue:true}).accepted,false);
    assert(world.actor().pendingShot,'launch and waits_for_servo must agree inside the half-degree boundary');
    assert.equal(world.actor().pendingShot.expires,world.time+12);assert.equal(ammo.rounds,rounds);assert.equal(gun.reload,0);
    if(cancel)applyWorldInput(world,'local',{...config,type:'trigger',phase:'before',aim:target,active:false,cancel:true});
    let muzzle;
    for(let tick=0;tick<60&&!muzzle;tick++) {
      world.step();muzzle=world.drainEvents().find(event=>event.type==='muzzle');
    }
    assert.equal(world.stats.shots,shots+Number(!cancel));assert.equal(ammo.rounds,rounds-Number(!cancel));
    assert.equal(world.actor().pendingShot,null);
    if(cancel)assert.equal(muzzle,undefined);
    else {
      assert(muzzle);
      assert(Math.abs(angleDifference(muzzle.angle,firingSolution(gun,target,config).angle))<=.1*Math.PI/180+1e-7);
    }
  }
});

test('a moving artillery chassis carries the bore and its servo only counters it at the admitted rate', t => {
  const world=new World(structuredTemplateSource('howitzer',{preset:'m119'}));t.after(()=>world.dispose());
  const gun=world.modules.find(m=>m.kind==='weapon'), bearing=gun.barrelAngle,
    action={type:'controls',phase:'before',platform:'vehicle',componentId:gun.id,throttle:0,brake:0,fire:false,
      aim:{x:gun.x+Math.cos(bearing)*500,y:gun.y+Math.sin(bearing)*500},aimAngle:bearing,charge:1};
  applyWorldInput(world,'local',action);setVehicle(world,{omega:2,y:world.vehicle.y+10});
  let bore=gun.barrelAngle,chassis=world.vehicle.angle;
  for(let tick=0;tick<6;tick++) {
    world.step();const moved=angleDifference(gun.barrelAngle,bore)-angleDifference(world.vehicle.angle,chassis);
    assert(Math.abs(moved)<=gun.weaponMount.maxSpeed/60+1e-7);bore=gun.barrelAngle;chassis=world.vehicle.angle;
  }
  assert(Math.abs(angleDifference(gun.barrelAngle,bearing))>Math.PI/180,'a rapid chassis rotation exceeds the servo, instead of infinite stabilization');
  assert.equal(world.stats.shots,0);
});

test('current artillery keeps its servo state when the field resumes', t => {
  const world=new World(createConstruction('empty'));t.after(()=>world.dispose());world.removeActor('local');
  for(const [i,[model,preset]] of artillery.filter((_,i)=>i%2===0).entries())
    world.addActor(standing(structuredTemplateSource(model,{preset})),{id:`c${i+1}`,x:12+i*20});
  const original=JSON.parse(JSON.stringify(world.keep())), fresh=new World(createConstruction('empty'));
  t.after(()=>fresh.dispose());fresh.removeActor('local');fresh.resume(structuredClone(original));
  assert.equal(fresh.time,original.time);assert.equal(fresh.tick,original.tick);
  // Ground contacts are measured again after cold admission, as in field-save.test.js.
  const after=fresh.keep();
  for(const state of original.modules) {
    const found=after.modules.find(m=>m.id===state.id);assert(found);
    for(const [key,value] of Object.entries(state)) if(key!=='groundContact') {
      sameState(found[key],value,`${state.id}.${key}`);
    }
  }
  for(const gun of fresh.modules.filter(m=>m.kind==='weapon')) {
    const rate=(gun.weaponPreset==='m119'?6:10)*Math.PI/180;
    near(gun.weaponMount.maxSpeed,rate);near(materialState(fresh,gun).servo.maxSpeed,rate);near(gun.weaponMount.fireTolerance,.1*Math.PI/180);
  }
  assert(fresh.actors.every(a=>!a.trigger&&!a.pendingShot),'field persistence intentionally releases triggers');
});
