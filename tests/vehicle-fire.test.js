import test from 'node:test';
import assert from 'node:assert/strict';
import { runFireCase, fireTarget, plateShape, engineFloorPenetration, engineFloorOverlapArea } from '../scripts/probes-impact.ts';
import { World, FIXED_DT } from '../src/physics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution, flightState } from '../src/ballistics.ts';
import { damageConstruction, face, interior } from './damage-fixtures.js';
import { ownerState, physics, flyRound, placeRound } from './mechanical-queries.js';
import { vehicleRoof } from '../src/scenarios.ts';
import { angleDifference } from '../src/math.ts';
import { worldToLocal } from '../src/math.ts';

function assertStableCarrier(result) {
  assert.equal(result.thrown, null, `${result.scenario}: ${result.thrown}`);
  const types = result.targetType === 'module' ? ['module'] : ['blocked', 'ricochet', 'penetration'],
    hit = result.impacts.find(e => types.includes(e.type));
  assert(hit, 'the round must actually contact its intended material');
  assert.equal(hit.id, result.targetId);
  assert.equal(result.stats.explosions, 0);
  for (const plate of result.end.plates) {
    assert(plate.attached);
    assert(Math.abs(plate.relativeAngle) < .06 && plate.maxDisplacement < .08);
  }
  const gun = result.end.modules.find(m => m.kind === 'weapon');
  assert(gun.attached && gun.centerDisplacement < .025 && Math.abs(gun.relativeAngle) < .025);
  assert(result.partsPreserved);
  assert.equal(result.end.carrierMass, result.start.carrierMass, 'ballistic damage cannot remove structural mass');
  // Use actual admitted mass, keeping the same allowance of twice projectile
  // energy plus only five centimetres of gravitational settling.
  assert(result.start.carrierMass > 0);
  const budget = result.inputKineticJ * 2 + result.start.carrierMass * 9.81 * .05 + 2_000;
  assert(result.peaks.kineticJ <= budget, `${result.peaks.kineticJ} J > ${budget} J`);
  assert(result.peaks.carrierDisplacement < .15);
  const rise = .08 + result.inputKineticJ / (result.start.carrierMass * 9.81);
  assert(result.peaks.y <= result.start.vehicle.y + rise);
}

function assertStableArmour(result) {
  assertStableCarrier(result);
  assert.equal(result.stats.penetrations, 0, 'MG presets cannot penetrate thick armour or the heavy mantlet');
  for (const plate of result.end.plates) assert(plate.integrity >= .99);
  const gun = result.end.modules.find(m => m.kind === 'weapon');
  if (result.targetType === 'module') assert(gun.health < gun.maxHealth && gun.health > gun.maxHealth * .95,
    'a real mantlet contact makes bounded functional damage');
  else assert.equal(gun.health, gun.maxHealth, 'intact armour shields its internal mechanism');
}

function reinforcedRoofConstruction() {
  const construction = createConstruction('heavy');
  // The non-perforation experiment uses 40 mm roofs, the stretch under the
  // tower included. The independent one-roof laboratory below exercises the
  // full 25 mm penetrable chord.
  for(const plate of construction.plates)if(['hull:roof','turret:floor','hull:deck','turret:roof'].includes(plate.id))plate.thicknessMm=40;
  construction.components.filter(p => p.kind === 'sensor').forEach(p => { p.pose.y += .15; });
  return construction;
}

function roofDamageConstruction() {
  // A controlled, admitted material experiment: one 25 mm roof above the
  // receiver, command and engine, and the fuel low under the breech of the gun, which turns with it.
  // Stock turret vehicles have two roof layers.
  return damageConstruction({length:4.2,height:2.8,dynamic:true,chassis:'tracked',frontThickness:125,
    thicknesses:{floor:35,rear:40,roof:25},components:[
      {id:'weapon',kind:'weapon',weaponPreset:'rh120',pose:{x:-1.7425,y:.9775,angle:-Math.PI},
        mount:{preset:'heavy-trunnion',sector:{min:-.1,max:.1},radiusM:.385}},
      interior('engine',{x:1.2,y:.31},'engine',{sizeScale:Math.cbrt(600/180)}),
      interior('fuel',{x:0,y:.01}),interior('ammo',{x:-1.1,y:.16},'ammo',{ammoPreset:'rh120'}),interior('command',{x:-.55,y:1.66}),
      ...['visual','radar','sound'].map((sensorMode,index)=>({id:'sensor-'+index,kind:'sensor',sensorMode,
        pose:{x:index===1?2.635:2.295,y:-.1425+index*.644,angle:0}})),
    ]});
}

test('the mount armour probe crosses a curved sheet with room for dispersion and ordinary settling', t => {
  const world = new World(createConstruction('heavy')); t.after(() => world.dispose());
  const target = fireTarget(world, 'mount'), gun = world.modules.find(m => m.kind === 'weapon'),
    shield = gun.weaponMount.shield, pose = { x: gun.x, y: gun.y, angle: gun.barrelAngle },
    aim = worldToLocal(pose, target.aim), hit = world.index.raycast(target.launcher, target.aim,{projectile:true}),
    radius = Math.hypot(aim.u,aim.v),angle=Math.atan2(aim.v,aim.u);
  assert(radius>shield.radius&&radius<shield.radius+shield.thickness,'the aim is inside the actual curved sheet');
  assert(Math.abs(angle)>Math.asin(shield.opening/shield.radius)&&Math.abs(angle)<shield.halfAngle);
  assert.equal(hit.owner.id, gun.id);
  assert(Math.abs(hit.depth-shield.thickness)<.001,'a radial ray crosses the authored radial thickness');
  const contact = worldToLocal(pose, hit);
  assert(Math.abs(Math.hypot(contact.u,contact.v)-(shield.radius+shield.thickness))<.001);
  const distance=Math.hypot(target.launcher.x-target.aim.x,target.launcher.y-target.aim.y),
    tangent={x:-(target.launcher.y-target.aim.y)/distance,y:(target.launcher.x-target.aim.x)/distance};
  for(const offset of [-.04,.04]){
    const shift=p=>({x:p.x+tangent.x*offset,y:p.y+tangent.y*offset}),
      edge=world.index.raycast(shift(target.launcher),shift(target.aim),{projectile:true});
    assert.equal(edge?.owner.id,gun.id,'dispersion stays on shield material rather than the hull or opening');
  }
});

test('the M777 keeps the same physical shield as its sector widens and a direct 120 mm flecha crosses it',t=>{
  const samples=[];
  // The turret tilts by whole cells: its broadest stock sector is -0.591..0.597 rad, so the widest sample is 0.59.
  for(const half of [.1,.3,.59]){
    const source=createConstruction('howitzer');source.components.find(m=>m.kind==='weapon').mount.sector={min:-half,max:half};
    const world=new World(source);t.after(()=>world.dispose());world.game();
    const gun=world.modules.find(m=>m.kind==='weapon'),y=gun.y-.0925,
      start={x:gun.x-8,y},end={x:gun.x+3,y},hit=world.index.raycast(start,end,
        {projectile:true,ignoreIds:world.plates.map(p=>p.id)});
    assert.equal(hit?.owner.object,gun,'the reported horizontal ray first meets the actual shield');
    assert(hit.depth<.15,'the finite thin sheet cannot become a half-metre solid block');
    samples.push({world,gun,hit,start,mass:gun.physicalMass,shield:structuredClone(gun.weaponMount.shield)});
  }
  for(const sample of samples.slice(1)){
    assert.deepEqual(sample.shield,samples[0].shield);
    assert(Math.abs(sample.mass-samples[0].mass)<1e-8);
    assert(Math.abs(sample.hit.depth-samples[0].hit.depth)<1e-8);
  }
  const {world,gun,start}=samples.at(-1),config=weaponSettings('cannon',{preset:'rh120',ammo:'apfsds',spread:0});
  assert.equal(world.index.raycast(start,{x:gun.x+3,y:start.y},{projectile:true})?.owner.object,gun,
    'the original broad-sector horizontal shot first meets the shield in the complete hull');
  flyRound(world,{...config,id:'mantlet-flecha',weapon:'cannon',x:start.x,y:start.y,vx:config.speed,vy:0,age:0,blastRadius:0},.006);
  const contact=world.drainEvents().find(e=>e.primaryContact&&e.type==='module');
  assert.equal(contact?.id,gun.id);assert.equal(contact?.penetrated,true);
  assert(gun.mantletHoles.length>0,'the physical sheet retains a local aperture after the strike');
});

for (const preset of ['fnmag', 'm2hb']) {
  for (const target of ['upper-front', 'roof', 'front', 'mount', 'roof-front-edge', 'roof-rear-edge', 'front-lower-edge']) {
    const reinforced = preset === 'm2hb' && target.startsWith('roof');
    test(`${preset}: one round on ${reinforced ? '40 mm reinforced' : 'stock'} ${target} retains material and mounting orientation`, () => {
      assertStableArmour(runFireCase({ preset, target, blueprint: reinforced ? reinforcedRoofConstruction() : null }));
    });
  }
  for (const target of ['roof', 'front', 'mount']) {
    const reinforced = preset === 'm2hb' && target === 'roof';
    test(`${preset}: a two-second ${reinforced ? '40 mm reinforced' : 'stock'} ${target} burst is blocked without launching or disassembling the carrier`, () => {
      const result = runFireCase({ preset, target, burst: true, seconds: 2, spread: .15, follow: true,
        blueprint: reinforced ? reinforcedRoofConstruction() : null });
      assert(result.shots >= (preset === 'fnmag' ? 20 : 17)); assertStableArmour(result);
    });
  }
  test(`${preset}: a short burst marks exposed stock gear without breaking the hull`, () => {
    const result = runFireCase({ preset, target: 'track', burst: true, seconds: 2, spread: .15, follow: true });
    assert.equal(result.thrown, null);
    assert.equal(result.impacts.find(e => e.type === 'module')?.moduleKind, 'track');
    const gear = result.end.modules.find(m => m.kind === 'track');
    assert(gear.health > gear.maxHealth * .75 && gear.health < gear.maxHealth);
    assert(gear.attached && Math.abs(gear.relativeAngle) < .025 && gear.centerDisplacement < .015);
    assert.equal(result.stats.explosions, 0);
    for (const plate of result.end.plates) {
      const loss = result.start.plates.find(p=>p.id===plate.id).integrity - plate.integrity;
      const noseContact = plate.id === 'chassis:nose' && result.impacts.some(e=>e.id===plate.id);
      assert(plate.attached && loss <= (noseContact ? .06 : .01) && plate.maxDisplacement < .005);
    }
  });
}

function assertStockRoofDamage(result) {
  assertStableCarrier(result);
  const roof = result.end.plates.find(p => p.id === 'hull:roof'),
    before = result.start.plates.find(p => p.id === roof.id),
    penetration = result.impacts.find(e => e.type === 'penetration' && e.id === roof.id);
  assert(penetration && result.stats.penetrations > 0, 'the M2HB really crosses the authored light roof');
  assert(roof.integrity < before.integrity && roof.integrity >= .99, 'the ballistic opening stays local');
  assert(Math.abs(penetration.power - penetration.remaining - 25 * 1.25 * penetration.speed / penetration.normalSpeed) < 1e-6,
    'the primary contact pays for the complete 25 mm steel chord at its actual incidence');
  for (const plate of result.end.plates) if (plate.id !== roof.id)
    assert.equal(plate.integrity, result.start.plates.find(p => p.id === plate.id).integrity,
      'the roof contact does not perforate another wall');
  assert(result.end.modules.some(m => m.health < result.start.modules.find(old => old.id === m.id).health),
    'the perforation exposes a real module to functional damage');
  for (const module of result.end.modules) assert(module.health >= 0 && module.health <= module.maxHealth && module.attached);
}

for (const target of ['roof', 'roof-front-edge', 'roof-rear-edge'])
  test(`M2HB crosses the laboratory 25 mm ${target} and damages a real module without carrier instability`, () => {
    const blueprint = roofDamageConstruction();
    assert.equal(blueprint.plates.find(plate => plate.id === 'hull:roof').thicknessMm, 25);
    assertStockRoofDamage(runFireCase({ blueprint, preset: 'm2hb', target }));
  });

test('a two-second M2HB burst traverses the laboratory 25 mm roof opening and disables the command module without launching the carrier', () => {
  const blueprint = roofDamageConstruction();
  assert.equal(blueprint.plates.find(plate => plate.id === 'hull:roof').thicknessMm, 25);
  const result = runFireCase({ blueprint, preset: 'm2hb', target: 'roof', burst: true, seconds: 2, spread: .15, follow: true });
  assert(result.shots >= 17); assertStockRoofDamage(result);
  const command = result.end.modules.find(m => m.kind === 'command');
  assert.equal(command.health, 0, 'repeated rounds through the opening cause a real functional failure');
});

test('an unfired stock carrier has no artificial material or carrier motion', () => {
  const control = runFireCase({ control: true, seconds: 3 });
  assert.equal(control.thrown, null);
  assert(control.peaks.carrierDisplacement < .001 && control.peaks.plateDisplacement < .001);
});

function chordWorld(t, thickness) {
  const world = new World(damageConstruction({ height: 3, frontThickness: thickness, components: [interior('command', {x:.35,y:-.0325})] }));
  t.after(() => world.dispose()); return world;
}
function partialRound(world, settings, phase) {
  const plate = face(world), h = FIXED_DT, surfaceX = plate.definition.x - plate.definition.thicknessMm / 2000,
    flight = firingSolution({ x: 0, y: 2.2 }, { x: 20, y: 2.2 }, settings),
    transit = flightState({ ...flight, x: 0, y: 2.2, vx: settings.speed, vy: 0 }, h);
  // A CCD phase is measured from the real drag-integrated endpoint, not a
  // vacuum speed*dt prediction that misses the sheet by five centimetres.
  return { plate, h, surfaceX, projectile: { ...settings, id: 'phase-round', weapon: settings.id,
    flight: flight.flight, x: surfaceX - transit.x + phase, y: 2.2,
    vx: settings.speed, vy: 0, age: 0, visited: new Set() } };
}
test('125 mm authored steel stops M2 at every CCD phase including a segment ending inside material', t => {
  const settings = weaponSettings('machinegun', { preset: 'm2hb', spread: 0 });
  for (const phase of [-.03, .015, .04, .08, .16]) {
    const world = chordWorld(t, 125), { plate, projectile } = partialRound(world, settings, phase);
    placeRound(world, projectile);
    for (let i = 0; i < 12 && world.projectiles.length; i++) world.step();
    const events = world.drainEvents();
    assert(events.some(e => e.type === 'blocked' && e.id === plate.id));
    assert.equal(world.stats.penetrations, 0, `phase ${phase} cannot shorten the full chord`);
    assert(plate.integrity > .99); assert.equal(world.modules[0].health, world.modules[0].maxHealth);
  }
});
test('a penetrable 60 mm chord spends material once and advances only within the remaining step', t => {
  const world = chordWorld(t, 60), settings = weaponSettings('autocannon', { preset: 'm242', spread: 0 }),
    { plate, h, surfaceX, projectile } = partialRound(world, settings, .015), maxX = projectile.x + projectile.vx * h,
    flown = flyRound(world, projectile);
  assert(flown);
  const hits = world.drainEvents().filter(e => e.type === 'penetration' && e.id === plate.id);
  assert.equal(hits.length, 1); assert.equal(world.stats.penetrations, 1);
  assert(Math.abs(hits[0].power - hits[0].remaining - 60 * 1.25) < 1e-6,
    'charge the complete steel chord once, separately from dissipative atmospheric transit');
  assert(flown.power > 0 && flown.power < 25 && flown.power <= hits[0].remaining);
  assert(flown.x <= maxX + .0001 && flown.x < surfaceX + .06);
});

test('25 mm AP makes a local roof aperture and visual dent with a fixed carrier outline', () => {
  let retainedDent = 0, farDisplacement = 0, holeIntegrity = 1;
  const result = runFireCase({ preset: 'm242', weapon: 'autocannon', target: 'roof', seconds: 1.5,
    observe(world, state, step) {
      const roof = vehicleRoof(world); holeIntegrity = Math.min(holeIntegrity, roof.integrity);
      if (step < 60) return;
      for (const dent of roof.dents?.values() || []) if (Math.abs((dent.u - .65) * roof.definition.length) < .22)
        retainedDent = Math.max(retainedDent, dent.depth);
      for (const n of roof.nodes) {
        const rest = { x: (n.u - .5) * roof.definition.length, y: (.5 - n.v) * roof.definition.thicknessMm / 1000 };
        if (Math.abs(rest.x) > .6) farDisplacement = Math.max(farDisplacement, Math.hypot(n.local.x - rest.x, n.local.y - rest.y));
      }
    } });
  assert.equal(result.thrown, null); assert(result.impacts.some(e => e.type === 'penetration' && e.id === result.targetId));
  const roof = result.end.plates.find(p => p.id === result.targetId);
  assert(holeIntegrity < 1 && holeIntegrity > .95 && roof.attached && roof.integrity > .95);
  assert(retainedDent > .0003 && retainedDent < .08 && farDisplacement < .02);
  assert.equal(result.stats.explosions, 0);
});
test('a stopped 25 mm round dents thick front armour without inventing a hinge', () => {
  let dent = 0;
  const result = runFireCase({ preset: 'm242', weapon: 'autocannon', target: 'upper-front', seconds: 1.5,
    observe(world, state, step) { if (step > 60) dent = Math.max(dent, plateShape(face(world,'glacis'), world.vehicle).maxLocalDent); } });
  assert.equal(result.thrown, null); assert.equal(result.stats.penetrations, 0);
  assert(result.impacts.some(e => e.type === 'blocked' && e.id === result.targetId));
  assert(dent > .0003 && dent < .04);
  assert(Math.abs(result.end.plates.find(p => p.id === result.targetId).relativeAngle) < .06);
  assert(result.end.modules.find(m => m.kind === 'weapon').attached);
});

test('later MG rounds traverse an existing roof opening and damage the actual internal receiver', t => {
  const gunSource = { id: 'weapon', kind: 'weapon', weaponPreset: 'rh120', pose: { x: -1.715, y: .8, angle: -Math.PI },
    mount: { preset: 'heavy-trunnion', sector: { min: -.1, max: .1 }, radiusM: .34 } },
    world = new World(damageConstruction({ length: 4, height: 2.8, thicknesses: { roof: 40 }, components: [gunSource] }));
  t.after(() => world.dispose());
  const roof = face(world, 'roof'), gun = world.modules.find(m => m.kind === 'weapon'), x = gun.x + gun.width / 2,
    aim = { x, y: roof.definition.y }, rigidRoof = roof.nodes.map(n => ({ x: n.x, y: n.y }));
  assert.equal(world.vehicle, null, 'this receiver exposure is a static closed laboratory hull');
  world.command('configureLauncher', { point: { x, y: aim.y + 3 } });
  world.fire(aim, weaponSettings('autocannon', { preset: 'm242', spread: 0 }), true);
  for (let i = 0; i < 90; i++) world.step();
  const afterAP = gun.health, area = roof.integrity;
  assert(roof.attached && area > .95 && area < 1); assert(afterAP < gun.maxHealth && afterAP > 0);
  assert.equal(world.projectiles.filter(p => p.fragment).length, 0);
  for (let i = 0; i < 13 * 60; i++) { world.step(); world.drainEvents(); }
  const clear = [];
  for (let dx = -.012; dx <= .012; dx += .0005) {
    const px = x + dx, hit = world.index.raycast({ x: px, y: aim.y + 1 }, { x: px, y: gun.y });
    if (hit?.owner.id === gun.id) clear.push(px);
  }
  assert(clear.length, 'the persistent ballistic aperture really admits a ray to the receiver');
  const aimX = clear[Math.floor(clear.length / 2)]; world.drainEvents();
  world.command('configureLauncher', { point: { x: aimX, y: aim.y + 3 } });
  world.setTrigger(true, { x: aimX, y: aim.y }, weaponSettings('machinegun', { preset: 'fnmag', spread: 0 }));
  const impacts = []; for (let i = 0; i < 150; i++) { world.step(); impacts.push(...world.drainEvents()); } world.setTrigger(false);
  assert(world.stats.shots >= 26); assert(impacts.some(e => e.type === 'module' && e.id === gun.id));
  assert(gun.health < afterAP && gun.health > afterAP * .9 && gun.marks?.length > 0 && gun.attached);
  assert(roof.attached && roof.integrity >= area - .01);
  assert.deepEqual(roof.nodes.map(n => ({ x: n.x, y: n.y })), rigidRoof,
    'the static carrier outline cannot move when ballistic material is removed');
  assert(gun.physicalMass > 0 && ownerState(world, gun).body === ownerState(world, roof).body);
  assert.equal(physics(world).bodies, 1); assert.equal(world.stats.explosions, 0);
});

test('powerful AP defeats the same stock front and reaches real ammunition for a secondary blast', () => {
  const result = runFireCase({ preset: 'rh120', weapon: 'cannon', target: 'front', seconds: 2 });
  assert.equal(result.thrown, null); assert(result.impacts.some(e => e.type === 'penetration' && e.id === result.targetId));
  assert(result.impacts.some(e => e.type === 'destroyed' && e.moduleKind === 'ammo'));
  assert(result.stats.explosions >= 1 && result.peaks.shapeResidual < .05);
});
for (const [preset, weapon] of [['m242', 'autocannon'], ['rh120', 'cannon'], ['at4', 'rocket']])
  test(`${preset}: HE opens local ballistic material while all structural mass stays mounted`, () => {
    const result = runFireCase({ preset, weapon, ammo: 'he', target: 'roof', seconds: 2 });
    assert.equal(result.thrown, null); assert(result.stats.explosions >= 1);
    assert(Number.isFinite(result.peaks.kineticJ) && result.peaks.shapeResidual < .05);
    assert(result.peaks.speed < 40 && result.partsPreserved);
  });
for (const preset of ['fnmag', 'm2hb']) test(`${preset}: MG hits preserve mounting and ordinary powered motion`, () => {
  const control = runFireCase({ control: true, throttle: 1, settle: 60, seconds: 2, follow: true }),
    result = runFireCase({ preset, target: 'front', burst: true, seconds: 2, throttle: 1, settle: 60, spread: .15, follow: true });
  assert.equal(result.thrown, null); assert(result.start.vehicle.speed > 1 && result.shots >= (preset === 'fnmag' ? 20 : 17));
  assert.equal(result.stats.penetrations, 0); assert.equal(result.stats.explosions, 0);
  assert(Math.abs(result.end.vehicle.x - control.end.vehicle.x) < .15 && Math.abs(result.end.vehicle.y - control.end.vehicle.y) < .03);
  assert(result.peaks.speed <= control.peaks.speed + .25);
  assert(result.peaks.kineticJ <= control.peaks.kineticJ + result.inputKineticJ * 2 + 20_000);
  for (const plate of result.end.plates) assert(plate.attached && plate.integrity > .99 && plate.maxDisplacement < .08);
  const gun = result.end.modules.find(m => m.kind === 'weapon'); assert(gun.attached && gun.health === gun.maxHealth && gun.centerDisplacement < .025);
});

for(const model of ['heavy','ifv','scout','recon','mortar','howitzer'])for(const facing of [-1,1])for(const end of ['min','max'])
  test(`${model} facing ${facing}: its admitted ${end} bearing fires one full-charge round without self contact`,t=>{
    const world=new World(createConstruction('empty'),{visualEvents:false});t.after(()=>world.dispose());
    world.removeActor('local');
    const actor=world.addActor(createConstruction(model),{id:'local',x:12,facing});world.vehicle=actor.vehicle;
    for(let i=0;i<60;i++)world.step();
    const gun=world.modules.find(m=>m.kind==='weapon'),bearing=gun.angle+gun.weaponMount[end],
      config=world.playerWeapon({platform:'vehicle',componentId:gun.id,aimAngle:bearing,charge:1}),
      aim=()=>({x:gun.x+Math.cos(bearing)*300,y:gun.y+Math.sin(bearing)*300});
    const aimingSteps=Math.ceil(Math.abs(angleDifference(bearing,gun.barrelAngle))/gun.weaponMount.maxSpeed*60)+2;
    world.aimWeapon(aim(),config);for(let i=0;i<aimingSteps;i++)world.step();
    assert(Math.abs(angleDifference(gun.barrelAngle,bearing))<1e-6,'the requested admitted bearing is actually reached');
    const ammo=world.modules.find(m=>m.kind==='ammo'),rounds=ammo.rounds,
      health=world.modules.map(m=>[m.id,m.health]),armour=world.plates.map(p=>[p.id,p.integrity]);
    assert.equal(world.fire(aim(),config,true),true,'AIM and FIRE retain the same explicit bearing and charge');
    for(let i=0;i<60;i++)world.step();
    assert.equal(world.stats.shots,1);assert.equal(rounds-ammo.rounds,1);
    assert.equal(world.stats.impacts,0,'no primary round may touch its own hull, receiver or sensor');
    assert.deepEqual(world.modules.map(m=>[m.id,m.health]),health);
    assert.deepEqual(world.plates.map(p=>[p.id,p.integrity]),armour);
    assert.equal(world.dynamics.recoveries||0,0);
  });
test('a moving vehicle keeps its local roof opening without artificial carrier energy', () => {
  const control = runFireCase({ control: true, throttle: 1, settle: 60, seconds: 2, follow: true }),
    result = runFireCase({ preset: 'm242', weapon: 'autocannon', target: 'roof', seconds: 2, throttle: 1, settle: 60, follow: true });
  assert.equal(result.thrown, null); assert(result.impacts.some(e => e.type === 'penetration' && e.id === result.targetId));
  const roof = result.end.plates.find(p => p.id === result.targetId); assert(roof.attached && roof.integrity > .95);
  assert(result.peaks.speed <= control.peaks.speed + .5 && result.peaks.y <= control.peaks.y + .08);
  assert(result.peaks.kineticJ <= control.peaks.kineticJ + result.inputKineticJ * 2 + 20_000);
});
test('a directly hit stock engine retains its authored placement above the floor and carrier mass', t => {
  const world = new World(createConstruction('heavy')); t.after(() => world.dispose());
  const engine = world.modules.find(m => m.kind === 'engine'), floor = face(world, 'floor'), mounted = ownerState(world, engine),
    before = physics(world).bodyStates.map(b => [b.handle, b.mass, b.inertia]), roof = face(world, 'roof');
  assert(engine.attached); assert(engineFloorPenetration(world) < .004 && engineFloorOverlapArea(world) < .0005);
  world.command('configureLauncher', { point: { x: engine.x, y: engine.y + weaponSettings('cannon', { preset: 'rh120' }).barrel + 3 } });
  world.fire({ x: engine.x, y: engine.y }, weaponSettings('cannon', { preset: 'rh120', spread: 0 }), true);
  const events = []; let penetration = 0, overlapArea = 0;
  for (let i = 0; i < 180; i++) {
    world.step(); events.push(...world.drainEvents());
    if (i > 119) { penetration = Math.max(penetration, engineFloorPenetration(world)); overlapArea = Math.max(overlapArea, engineFloorOverlapArea(world)); }
  }
  assert(events.some(e => e.type === 'module' && e.id === engine.id)); assert(engine.health < engine.maxHealth);
  assert(floor.integrity > .95 && engine.attached);
  assert.equal(ownerState(world, engine).body, mounted.body); assert.equal(ownerState(world, floor).body, mounted.body);
  assert.deepEqual(physics(world).bodyStates.map(b => [b.handle, b.mass, b.inertia]), before);
  assert.equal(physics(world).bodies, 1);
  assert(penetration < .004 && overlapArea < .0005); assert(Math.abs(world.vehicle.vy) < .1);
});
