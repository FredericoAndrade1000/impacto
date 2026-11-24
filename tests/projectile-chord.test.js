import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { damageConstruction } from './damage-fixtures.js';
import { flightState } from '../src/ballistics.ts';
import { flyRound, placeRound } from './mechanical-queries.js';

function fixture(t, x, grazing) {
  // The chord assay has one long closed laboratory hull and one receiver.
  // A stock turret's rear wall is a third real chord, so it cannot isolate
  // exactly the two disjoint gun solids or a gun-only partial transit.
  const source = damageConstruction({length:4,height:2.8,dynamic:true,components:[
    {id:'weapon',kind:'weapon',weaponPreset:'m2hb',pose:{x:-1.7985,y:1.0025,angle:-Math.PI},
      mount:{preset:'light-trunnion',sector:{min:-.35,max:.35},radiusM:.2065}},
  ]});
  // The 80 mm front wall puts the centre of mass ahead of the default axle.
  // Support that same hull with three legal axles; no gun material is changed.
  source.chassis.axles = [-28, 0, 28]; // cells: -1.4, 0 and 1.4 m
  const world = new World(source); t.after(() => world.dispose());
  const gun = world.modules.find(module => module.kind === 'weapon');
  world.command('setVehicleState', { state: { x: world.vehicle.x + x - gun.x, y: world.vehicle.y + 10 - gun.y } });
  // The high ray crosses a thin shield and then the receiver. The low ray
  // starts inside the unarmoured tube and reaches the receiver through its opening.
  const round = { id: 'chord-probe', x: gun.x - (grazing ? .35 : .7), y: gun.y + (grazing ? .055 : .01),
    vx: 850, vy: 0, power: 400, mass: 5, caliberMm: 120, radius: .00635, age: 0, life: 1,
    weapon: 'cannon', ammo: 'ap', visited: new Set(world.plates.map(p => p.id)) };
  return { world, gun, round };
}

test('a completed mantlet chord admits a separate receiver chord from the same owner', t => {
  for (const x of [0, 23.6023817405, -23.6023817405, 800]) {
    const { world, gun, round } = fixture(t, x, true);
    // The round is spent in the hull behind the gun, short of the rear wall.
    flyRound(world, round, 1/240);
    const events = world.drainEvents(), hits = events.filter(e => e.type==='module' && e.id===gun.id),
      left = events.filter(e => e.type==='penetration' && e.id===gun.id).at(-1)?.remaining,
      path = events.find(e => e.type==='flight' && e.id===round.id).points;
    assert.equal(hits.length, 2, `mantlet and receiver at ${x} have separate material chords`);
    assert(hits.every(e => e.penetrated));
    assert.equal(world.stats.impacts, 1, 'the owner is still counted once in impact statistics');
    assert.equal(world.stats.penetrations, 2, 'both physical chords spend projectile power');
    assert(path.at(-1).x > gun.x + gun.width, 'the round flies on behind the receiver');
    assert(left < 400 && left > 0); assert(gun.health < 200);
  }
});

test('ignored tube transit reaches the receiver, whose connected chord is charged once across many steps', t => {
  const { world, gun, round } = fixture(t, 23.6023817405, false);
  // A step takes the slow probe thirty centimetres. It spends two steps in
  // the ignored tube, then enters the 77 cm receiver behind the trunnion.
  placeRound(world, { ...round, vx: 18 });
  const flown = () => world.projectiles.find(p => p.id === round.id),
    advance = steps => { for (let i=0; i<steps; i++) { world.step(); assert(flown()); } return flown(); };
  let p = advance(2);
  assert.equal(world.stats.impacts,0);assert.equal(world.stats.penetrations,0);
  assert.equal(gun.health,gun.maxHealth,'the exposed tube takes no ballistic damage');
  p=advance(2);
  assert(world.index.raycastLayers(p, { x:p.x+.001, y:p.y },{projectile:true}).some(hit => hit.owner.object===gun),
    'the projectile remains within the charged receiver chord');
  const health = gun.health, power = p.power, vx = p.vx, vy = p.vy;
  const predicted = flightState({ ...p, time: .1, flightLimit: 45, flight: { model: 'quadratic-drag-v2',
    mass: 5, caliberMm: 120, family: 'cannon', dragCoefficient: .2, airDensity: 1.225, scaleHeight: 8500 } }, .1);
  p = advance(6);
  const hits = world.drainEvents().filter(e => e.type==='module' && e.id===gun.id);
  assert.equal(hits.length, 1); assert.equal(world.stats.penetrations, 1);
  assert.equal(gun.health, health);
  const kineticRatio = (predicted.vx ** 2 + predicted.vy ** 2) / (vx ** 2 + vy ** 2);
  assert(Math.abs(p.power / power - kineticRatio) < .00001, 'only flight changes the power after the one material charge');
  assert.equal(world.index.raycastLayers(p, { x:p.x+.001, y:p.y },{projectile:true}).length, 0,
    'the projectile has left the resolved gun chord');
});

for(const ammo of ['ap','apfsds','heat','he'])test(`${ammo}: exposed tube transit matches free flight without contacts or energy loss`,t=>{
  const actual=fixture(t,23.6023817405,false),control=fixture(t,23.6023817405,false),
    world=actual.world,gun=actual.gun,probe={...actual.round,vx:18,ammo,blastRadius:2.5,visited:new Set()},
    start={x:probe.x,y:probe.y},end={x:probe.x+.001,y:probe.y};
  assert(world.index.raycastLayers(start,end).some(h=>h.owner.object===gun),
    'structural and picking queries still contain the physical tube');
  assert.equal(world.index.raycastLayers(start,end,{projectile:true}).length,0,
    'the projectile geometry omits only the exposed tube');
  control.world.removeActor('local');
  for(const w of [world,control.world])placeRound(w,probe);
  for(let i=0;i<2;i++){world.step();control.world.step();}
  const select=w=>{
    const p=w.projectiles.find(p=>p.id===probe.id);assert(p);
    return Object.fromEntries(['x','y','vx','vy','power','age'].map(key=>[key,p[key]]));
  };
  assert.deepEqual(select(world),select(control.world),'the round pays only its ordinary flight drag');
  assert.equal(world.stats.impacts,0);assert.equal(world.stats.penetrations,0);assert.equal(world.stats.explosions,0);
  assert.equal(gun.health,gun.maxHealth);assert.equal(gun.barrelDamage||0,0);assert.equal(gun.elevationDamage||0,0);
  assert(!world.drainEvents().some(e=>['module','blocked','penetration','ricochet','primary-contact','secondary-impact'].includes(e.type)));
});
