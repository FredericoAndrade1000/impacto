import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { damageConstruction, face, interior } from './damage-fixtures.js';
import { reserveState, componentVolume, ammunitionProfile } from '../src/component-volume.ts';
import { pieceMass, blueprintMass } from '../src/mass-properties.ts';
import { parseBlueprint, serializeBlueprint, validateBlueprint, compileBlueprint } from '../src/persistence.ts';
import { weaponSettings } from '../src/weapons.ts';
import { mechanicalState } from '../scripts/probes-mobility.ts';
import { rehearsal } from '../server/room.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { componentDepth } from '../src/component-volume.ts';
import { componentScale } from '../src/component-size.ts';
import { physics, ownerState, setPart, dent, flyRound, managedWorld, advance } from './mechanical-queries.js';


// Fresh typed module projections come from explicit component poses inside a laboratory hull.
// Native admission derives all dimensions, volume, reserves and installed mass.
const componentFixture = (kind, options = {}) => compileBlueprint(damageConstruction({
  length: 6, height: 4,
  components: [interior(kind, { x: 0, y: 1 }, kind, options)],
})).modules[0];

test('uniform authored engine size preserves proportions and scales power and mass by volume, which follows what the side view shows', () => {
  const m = componentFixture('engine');
  assert.equal(m.powerKw, 180); assert.equal(pieceMass(m), 880);
  for (const factor of [.5, 1.5, 2]) {
    const large = componentFixture('engine', { sizeScale: factor });
    // Longer and taller by its size, as deep across the body: s² of the volume, the power and the mass.
    assert(Math.abs(large.powerKw - 180 * factor ** 2) < 1e-8);
    assert(Math.abs(pieceMass(large) - 880 * factor ** 2) < 1e-8);
    assert.equal(large.width, m.width * factor); assert.equal(large.height, m.height * factor);
    assert.equal(componentDepth(large), componentDepth(m));
  }
});

test('fuel litres, filled weight and calibre-specific round counts follow authored volume, every reserve built full', () => {
  const tank = componentFixture('fuel'), box = componentFixture('ammo', { ammoPreset: 'm2hb' }),
    fuel = reserveState(tank), ammo = reserveState(box),
    large = componentFixture('fuel', { sizeScale: 2 });
  assert(Math.abs(fuel.capacityLitres - 202.176) < 1e-9);
  assert.deepEqual([tank.fuelLitres, fuel.fuelLitres], [tank.capacityLitres, fuel.capacityLitres]);
  assert.equal(reserveState(large).capacityLitres, fuel.capacityLitres * 4);
  // Its steel casing, 2 mm thick, and the fuel in it.
  const depth = componentDepth(tank), casing = 2 * (tank.width * tank.height + (tank.width + tank.height) * depth) * .002 * 7800;
  assert(Math.abs(pieceMass(tank) - casing - fuel.fuelLitres * .835) < 1e-9);
  assert.equal(ammo.rounds, Math.floor(componentVolume(box) * .55 * 1000 / ammunitionProfile(box).litres));
  assert.deepEqual([box.rounds, ammo.rounds], [box.capacityRounds, box.capacityRounds]);
  const spent = { ...box, rounds: 0 }, before = structuredClone(spent);
  assert.deepEqual(reserveState(spent), { capacityRounds: box.capacityRounds, rounds: 0 });
  assert.deepEqual(reserveState({ ...box, rounds: undefined }), { capacityRounds: box.capacityRounds, rounds: box.capacityRounds });
  assert.deepEqual(spent, before, 'reading the admitted capacity does not refill or rewrite a spent reserve');
  assert(reserveState(componentFixture('ammo', { ammoPreset: 'rh120' })).rounds < ammo.rounds / 100);
});

test('JSON stores dimensions and calibre; runtime expenditure never leaks into the blueprint', t => {
  const b = createConstruction('heavy'), box=b.components.find(m=>m.kind==='ammo');
  const w = managedWorld(t,b); setPart(w, w.modules.find(m=>m.kind==='ammo'), { rounds: 0 });
  setPart(w, w.modules.find(m=>m.kind==='fuel'), { fuelLitres: 0 });
  const restored=parseBlueprint(serializeBlueprint(w.construction));
  assert.deepEqual(restored, b);
  assert.equal(restored.components.find(m=>m.kind==='ammo').rounds,undefined);
  assert.equal(restored.components.find(m=>m.kind==='fuel').fuelLitres,undefined);
  const motor=restored.components.find(m=>m.kind==='engine');
  assert.equal(motor.sizeScale,b.components.find(m=>m.kind==='engine').sizeScale);
  assert.equal(motor.width,undefined); assert.equal(motor.depthM,undefined);
  const forged = structuredClone(b), forgedTank = forged.components.find(m => m.kind === 'fuel');
  forgedTank.depthM = 400; forgedTank.height = 4;
  assert.throws(() => validateBlueprint(forged), { reason: 'AUTHORING_FIELDS' });
  // A box is built full: how full it starts is not written.
  box.loadFraction=.5; assert.throws(()=>validateBlueprint(b), { reason: 'AUTHORING_FIELDS', ids: [box.id] });
});

test('installed shots expend exactly one compatible round, and the box weighs that much less; blocked, empty and bench shots do not', t => {
  const b=createConstruction('heavy'), w=managedWorld(t,b), gun=w.modules.find(m=>m.kind==='weapon'), box=w.modules.find(m=>m.kind==='ammo'),
    config=weaponSettings('cannon',{preset:'rh120',platform:'vehicle',componentId:gun.id}), full=box.rounds;
  // It comes full; two rounds are left in it, and it is weighed so.
  assert.equal(full,box.capacityRounds); assert(full>2);
  setPart(w,box,{rounds:2}); advance(w,6,{ drain: true });
  const before=box.rounds; assert.equal(before,2);
  const aim={x:gun.x-30,y:gun.y};
  assert(w.fire(aim,config,true)); assert.equal(box.rounds,before-1);
  const mass=box.physicalMass, laden=w.vehicle.mass, round=ammunitionProfile(box).massKg;
  assert.equal(w.fire(aim,config),false,'cooldown consumes nothing'); assert.equal(box.rounds,before-1);
  assert(w.fire(aim,config,true)); assert.equal(box.rounds,0);
  assert.equal(box.physicalMass,mass,'a shot is weighed with the rest, when the construction is weighed again');
  assert.equal(w.fire(aim,config,true),false);
  // Two rounds of 120 mm are more than the step of load a construction is weighed again for.
  advance(w,12, { drain: true }); assert(Math.abs(mass-box.physicalMass-2*round)<1e-9); assert(Math.abs(laden-w.vehicle.mass-2*round)<1e-6,'and the vehicle with it');
  const bench=weaponSettings('cannon',{preset:'rh120'}); assert(w.fire({x:12,y:1},bench,true));
  assert.equal(box.rounds,0);
  w.reset(); assert.equal(w.modules.find(m=>m.kind==='ammo').rounds,full);
  const other=managedWorld(t,{...b,components:b.components.map(m=>m.kind==='ammo'?{...m,ammoPreset:'m242'}:m)});
  assert.equal(other.fire(aim,config,true),false,'another cartridge cannot feed this gun');
});

test('driving expends fuel, weighed off the construction a step of load at a time; an empty tank leaves coasting rather than inventing power', t => {
  const b=createConstruction('scout'), w=managedWorld(t,b); advance(w,120, { drain: true });
  const tank=w.modules.find(m=>m.kind==='fuel'), before=tank.fuelLitres, massBefore=w.vehicle.mass;
  w.controlVehicle(1); advance(w,180, { drain: true });
  assert(tank.fuelLitres < before && tank.fuelLitres > before-.1);
  assert.equal(w.vehicle.mass,massBefore,'a glass of fuel is not weighed');
  w.game().call({op:'setPartState',owner:w.game().handle(tank),state:{fuelLitres:0}}); advance(w,2, { drain: true });
  assert.equal(w.vehicle.availablePowerKw,0); assert.equal(w.vehicle.fuelStarved,true);
  assert(w.vehicle.vx>1,'fuel exhaustion preserves inertia');
  advance(w,6, { drain: true }); assert(Math.abs(massBefore-w.vehicle.mass-before*.835)<1e-6,'a tank of it is: the vehicle is lighter by the fuel it no longer carries');
  w.reset(); assert.equal(w.modules.find(m=>m.kind==='fuel').fuelLitres,before);
});

test('PvP supplies belong to each construction and replicate spent quantities and dimensions', t => {
  const room = rehearsal([0]); t.after(() => room.world.dispose());
  const alice = room.join('Reservas A'), bob = room.join('Reservas B');
  const a = room.publish(alice.playerId, createConstruction('heavy'), {x:-20, facing:1}).actor,
    b = room.publish(bob.playerId, createConstruction('heavy'), {x:20, facing:1}).actor;
  // The first has spent all it had.
  for (const module of room.world.modules.filter(m => m.actorId === a.id && ['fuel', 'ammo'].includes(m.kind)))
    setPart(room.world, module, module.kind === 'fuel' ? { fuelLitres: 0 } : { rounds: 0 });
  // Each takes its construction in hand: publishing puts nobody at the controls.
  for (const [player, actor] of [[alice, a], [bob, b]]) room.command(player.playerId, { type: 'squad', order: 'control', id: actor.id });
  const modules = id => room.world.modules.filter(m => m.actorId === id),
    first = modules(a.id), second = modules(b.id),
    gunA = first.find(m=>m.kind==='weapon'), gunB = second.find(m=>m.kind==='weapon'),
    boxA = first.find(m=>m.kind==='ammo'), boxB = second.find(m=>m.kind==='ammo'),
    tankB = second.find(m=>m.kind==='fuel'), rounds = boxB.rounds, litres = tankB.fuelLitres;
  const fire = (player, gun) => room.command(player.playerId, {type:'fire', aim:{x:80,y:gun.y}, weapon:{id:'cannon',componentId:gun.id}});
  assert.equal(fire(alice,gunA).accepted,false,'another actor cannot feed the empty gun');
  assert.equal(boxA.rounds,0); assert.equal(boxB.rounds,rounds);
  // An input leaves the scene to the step that follows it.
  assert(fire(bob,gunB).accepted); room.world.step(); assert.equal(boxB.rounds,rounds-1);
  room.world.controlVehicle(1,0,a.id); room.world.controlVehicle(1,0,b.id); advance(room.world,30, { drain: true });
  assert.equal(room.world.actor(a.id).vehicle.availablePowerKw,0,'another actor cannot fuel the empty engine');
  assert(tankB.fuelLitres<litres);
  const state=new FrameReader().decode(new FrameWriter().encode({state:room.world.snapshot(),events:[]},true)).state,
    replica=state.modules.find(m=>m.id===boxB.id);
  assert.equal(replica.rounds,boxB.rounds); assert.equal(replica.physicalMass,boxB.physicalMass);
  assert.equal(componentScale(replica),componentScale(boxB)); assert.equal(replica.depthM,undefined); assert.equal(replica.ammoPreset,'rh120');
  // Back at the base, stopped and out of combat, the magazine and the tank are filled again without being asked, at a price.
  room.world.controlVehicle(0,1,a.id); room.world.controlVehicle(0,1,b.id);
  const iron=room.factionView(bob.playerId).stock.ferro, bill=room.factionView(bob.playerId).units[0].rearm;
  for(let i=0;i<11*60;i++) room.step();
  assert(bill.ferro>0); assert.equal(room.factionView(bob.playerId).stock.ferro,iron-bill.ferro);
  assert.equal(boxB.rounds,rounds); assert(Math.abs(tankB.fuelLitres-litres)<.01);
});

test('fuel feeds fire without a blast; only remaining ammunition scales a secondary detonation', t => {
  // A round put two centimetres short of a reservoir, on its axis, that goes into it and is spent there:
  // it takes more health than the reservoir has.
  const destroy = (world, part) => { flyRound(world, { x: part.x - part.width / 2 - .02, y: part.y, vx: 600, vy: 0,
    power: 200, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002); assert(part.detonated); };
  for(const [kind, pose] of [['fuel', { x: .4, y: .2175 }], ['ammo', { x: .4, y: .1675 }]]) {
    const fixture = () => managedWorld(t, damageConstruction({
      components: [interior(kind, pose, kind, kind === 'ammo' ? { ammoPreset: 'rh120' } : {})],
    }));
    const empty = fixture(), spent = empty.modules.find(m => m.kind === kind);
    setPart(empty, spent, kind === 'fuel' ? { fuelLitres: 0 } : { rounds: 0 }); destroy(empty, spent);
    assert.equal(empty.stats.explosions, 0); assert(!empty.drainEvents().some(e => e.type === 'explosion'));
    const full = fixture(), reduced = fixture(), reservoir = reduced.modules[0];
    setPart(reduced, reservoir, kind === 'fuel' ? { fuelLitres: reservoir.fuelLitres * .125 } : { rounds: 1 });
    destroy(full, full.modules[0]); destroy(reduced, reservoir);
    const fullEvents = full.drainEvents(), partialEvents = reduced.drainEvents();
    if (kind === 'fuel') {
      assert(!spent.burning, 'an empty tank starts no fire');
      assert.equal(full.stats.explosions, 0); assert.equal(reduced.stats.explosions, 0);
      assert(![...fullEvents, ...partialEvents].some(e => e.type === 'explosion'));
      const fire = fullEvents.find(e => e.type === 'burn'), smaller = partialEvents.find(e => e.type === 'burn');
      assert(fire && smaller && smaller.strength < fire.strength, 'the fuel left in the ruined tank feeds the fire');
      assert(full.modules[0].burning && full.modules[0].fuelLitres > 0);
      destroy(full, full.modules[0]); assert(!full.drainEvents().some(e => e.type === 'burn'), 'failure is applied once');
      continue;
    }
    const original = fullEvents.find(e => e.type === 'explosion'), partial = partialEvents.find(e => e.type === 'explosion');
    assert(original && partial, 'the comparison observes real compiled detonations');
    assert(partial.power < original.power && partial.radius < original.radius);
    const count = reduced.stats.explosions; destroy(reduced, reservoir);
    assert.equal(reduced.stats.explosions, count); assert(!reduced.drainEvents().some(e => e.type === 'explosion'));
  }
});

test('payload expenditure takes its weight off the one body, a step of load at a time, and leaves its velocity alone', t => {
  const w=managedWorld(t,createConstruction('scout')), tank=w.modules.find(m=>m.kind==='fuel');
  const mounted = ownerState(w, tank), before=mechanicalState(w), tankMass=tank.physicalMass,
    velocity={ vx: mounted.state.vx, vy: mounted.state.vy }, omega=mounted.state.omega;
  assert(Math.abs(before.mass-blueprintMass(w.blueprint))<.005,'carrier and gear count each installed mass once');
  // Less than a step of load is not weighed: nothing of the body changes, then or when it is next looked over.
  const litres=10; setPart(w, tank, { fuelLitres: tank.fuelLitres - litres });
  const after = ownerState(w, tank); assert.equal(after.body, mounted.body);
  assert.deepEqual({ vx: after.state.vx, vy: after.state.vy }, velocity); assert.equal(after.state.omega,omega);
  advance(w,12, { drain: true }); assert.equal(mechanicalState(w).mass,before.mass);
  assert.equal(tank.physicalMass,tankMass); assert.equal(ownerState(w, tank).state.inertia,mounted.state.inertia);
  assert.equal(ownerState(w, tank).colliders, mounted.colliders);
  // A step of it is: the same body with the same colliders, lighter by all that was spent and easier to turn, moving as it did.
  setPart(w, tank, { fuelLitres: tank.fuelLitres - 100 });
  const spent = ownerState(w, tank), moving = { vx: spent.state.vx, vy: spent.state.vy, omega: spent.state.omega }; advance(w,6, { drain: true });
  const lighter = ownerState(w, tank), gone = (litres + 100) * .835;
  assert(Math.abs(before.mass - mechanicalState(w).mass - gone) < 1e-6); assert(Math.abs(tankMass - tank.physicalMass - gone) < 1e-9);
  assert.equal(lighter.body, mounted.body); assert.equal(lighter.colliders, mounted.colliders); assert(lighter.state.inertia < mounted.state.inertia);
  assert(Math.hypot(lighter.state.vx - moving.vx, lighter.state.vy - moving.vy) < .05 && Math.abs(lighter.state.omega - moving.omega) < .05, 'no kick from the weighing');
});

test('a local armour dent does not change suspension ride height or inject motion', t => {
  const w=managedWorld(t,createConstruction('scout')); advance(w,240, { drain: true });
  const plate=face(w, 'roof'), y=w.vehicle.y, point=plate.materialPosition({u:.56,v:.5});
  const mounted = ownerState(w, plate); dent(w, plate, point, .001, .01);
  assert(plate.dents.size>0,'the exercise changes actual native material rather than the JS projection');
  let excursion=0, speed=0;
  for(let i=0;i<120;i++) { w.step(); w.drainEvents();
    excursion=Math.max(excursion,Math.abs(w.vehicle.y-y)); speed=Math.max(speed,Math.abs(w.vehicle.vy)); }
  assert(excursion<.003 && speed<.012,`unloaded height change ${excursion}, speed ${speed}`);
  assert.equal(ownerState(w, plate).body, mounted.body); assert.equal(physics(w).recoveries,0);
});

test('repeated MG roof contacts retain passive damping during and after impacts', t => {
  for(const template of ['scout','heavy']) {
    const w=managedWorld(t,createConstruction(template)); advance(w,240, { drain: true });
    const plate=face(w, 'roof'), target=plate.materialPosition({u:.5,v:.5}), y=w.vehicle.y;
    const launcher={x:target.x,y:target.y+2};
    w.command('configureLauncher', { point: launcher });
    const shot=weaponSettings('machinegun',{preset:'m2hb',spread:0}); let lateSpeed=0, excursion=0;
    for(let burst=0;burst<3;burst++) { w.fire(target,shot,true);
      for(let i=0;i<90;i++) { w.step(); w.drainEvents(); excursion=Math.max(excursion,Math.abs(w.vehicle.y-y));
        if(i>30) lateSpeed=Math.max(lateSpeed,Math.abs(w.vehicle.vy)); } }
    assert(excursion<.018 && lateSpeed<.06,`${template}: height ${excursion}, late speed ${lateSpeed}`);
    assert(w.plates.every(p=>p.attached)); assert.equal(physics(w).recoveries,0);
    assert(w.stats.impacts>=3,'real CCD rounds reached the vehicle');
  }
});
