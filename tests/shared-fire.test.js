import test from 'node:test';
import assert from 'node:assert/strict';
import { damageConstruction, interior } from './damage-fixtures.js';
import { managedWorld, advance, flyRound, setPart } from './mechanical-queries.js';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { Publication } from '../server/publication.ts';
import { withConstructionKind } from '../src/chassis-editing.ts';

const design = () => damageConstruction({ length: 6, height: 4, components: [
  interior('fuel', { x: -1, y: .2175 }, 'tank'),
  interior('engine', { x: 1, y: .35 }, 'engine'),
  interior('command', { x: 1, y: 1.4 }, 'command'),
] });
const part = (world, kind, actorId = 'local') => world.modules.find(m => m.kind === kind && m.actorId === actorId);
function scene(t, blueprint = design()) {
  const world = managedWorld(t, damageConstruction());
  world.removeActor('local'); world.addActor(blueprint, { id: 'local', x: 0 });
  return world;
}
function ignite(world, kind = 'fuel') {
  const tank = part(world, kind);
  flyRound(world, { x: tank.x - tank.width / 2 - .02, y: tank.y, vx: 600, vy: 0,
    power: kind === 'fuel' ? 200 : 500, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002);
  assert(tank.burning); if (kind === 'fuel') assert(tank.detonated);
  world.drainEvents();
}

test('a burned mounted weapon keeps its consumed mass and current inertia through a cold save', t => {
  const blueprint = damageConstruction({ dynamic: true, length: 8, height: 4, frontThickness: 5, components: [
    interior('weapon', { x: -2, y: 1 }, 'gun', { weaponPreset: 'minimi',
      mount: { preset: 'light-trunnion', sector: { min: 0, max: 0 } } }),
    interior('engine', { x: -2, y: .35 }, 'engine'),
    interior('fuel', { x: 3, y: .2175 }, 'remote'),
  ] }), world = scene(t, blueprint), gun = part(world, 'weapon'), fuel = part(world, 'fuel'),
    original = { mass: gun.physicalMass, inertia: gun.physicalInertia };
  // An already damaged gun heats beside a real engine ignition. Native consumes
  // its material and weighs the body when the distant fuel changes its payload.
  setPart(world, gun, { health: gun.maxHealth * .4 }); ignite(world, 'engine');
  advance(world, 24 * 60, { drain: true });
  setPart(world, fuel, { fuelLitres: 0 }); advance(world, 60, { drain: true });
  assert(gun.burnAge > 0 && gun.physicalMass < original.mass);
  assert(gun.physicalInertia < original.inertia, 'the host publishes inertia together with the consumed mass');
  const kept = JSON.parse(JSON.stringify(world.keep())), restored = scene(t, blueprint);
  restored.removeActor('local'); restored.resume(kept);
  const resumed = part(restored, 'weapon');
  assert.equal(resumed.physicalMass, gun.physicalMass);
  assert(Math.abs(resumed.physicalInertia - gun.physicalInertia) < 1e-10);
  assert.equal(resumed.burnAge, gun.burnAge); assert.equal(resumed.health, gun.health);
  advance(world, 60, { drain: true }); advance(restored, 60, { drain: true });
  assert.equal(resumed.burnAge, gun.burnAge); assert.equal(resumed.health, gun.health);
});

test('a real hit starts one shared fire, damages its own parts and publishes the fire without exposing another actor', t => {
  const world = scene(t);
  world.addActor(design(), { id: 'other', x: 30, facing: 1 });
  ignite(world);
  const engine = part(world, 'engine'), health = engine.health,
    other = part(world, 'engine', 'other'), untouched = other.health, events = [];
  advance(world, 120, { events });
  assert(engine.health < health && engine.health > health * .9, 'internal heat is gradual');
  assert.equal(other.health, untouched); assert.equal(other.burning, false);
  const fires = events.filter(e => e.type === 'burn');
  assert.equal(fires.length, 20, 'the real 10 Hz damage clock refreshes one source per construction');
  assert(fires.every(e => e.actorId === 'local' && e.componentId === part(world, 'fuel').id));
  assert.equal(engine.burning, false); assert.equal(engine.burnAge, 0);
  const state = new FrameReader().decode(new FrameWriter().encode({ state: world.snapshot(), events: [] }, true)).state;
  assert.equal(state.actors.find(a => a.id === 'local').burning, true);
  assert.equal(state.actors.find(a => a.id === 'other').burning, false);
  assert.equal(world.stats.explosions, 0, 'a fuel tank never detonates');
});

test('a local exterior tank fire heats nearby equipment and leaves the distant protected interior intact', t => {
  const blueprint = damageConstruction({ length: 6, height: 4, components: [
    interior('engine', { x: 1, y: .35 }, 'in-engine'), interior('fuel', { x: 1, y: 1.4 }, 'in-tank'),
    interior('engine', { x: -4, y: .35 }, 'out-engine'), interior('fuel', { x: -4, y: 1.2 }, 'out-tank'),
  ] }), world = scene(t, blueprint), get = id => world.modules.find(m => m.id.endsWith(':' + id)), tank = get('out-tank');
  assert(tank.exposed && get('out-engine').exposed); assert(!get('in-engine').exposed);
  flyRound(world, { x: tank.x - tank.width / 2 - .02, y: tank.y, vx: 600, vy: 0,
    power: 500, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002);
  assert(tank.burning); world.drainEvents();
  const protectedState = () => ['in-engine', 'in-tank'].map(id => {
    const m = get(id); return { health: m.health, fuel: m.fuelLitres, burning: m.burning, consumed: m.burnAge };
  });
  const before = protectedState(), nearby = get('out-engine').health, litres = tank.fuelLitres, events = [];
  advance(world, 10 * 60, { events });
  assert.deepEqual(protectedState(), before);
  assert(tank.fuelLitres < litres); assert(get('out-engine').health < nearby, 'nearby exposed equipment can receive local heat');
  const fires = events.filter(e => e.type === 'burn');
  assert(fires.length && fires.every(e => e.exterior && e.componentId === tank.id && e.spread === 0));
  const packet = new FrameReader().decode(new FrameWriter().encode({ state: new Publication().state(world.snapshot()), events: [fires.at(-1)] }, true));
  assert.equal(packet.events[0].exterior, true);
  const kept = JSON.parse(JSON.stringify(world.keep())), restored = scene(t, blueprint);
  restored.removeActor('local'); restored.resume(kept);
  const r = restored.modules.find(m => m.id.endsWith(':out-tank'));
  assert(r.burning && r.exposed); assert.equal(r.fireAge, tank.fireAge);
  assert(restored.modules.filter(m => m.id.includes(':in-')).every(m => !m.burning));
});

test('heat crosses a real thin vehicle floor gradually and can ignite damaged tyres, while thick armour delays it', t => {
  const run = floor => {
    const world=scene(t,damageConstruction({length:6,height:3,chassis:'wheeled',thicknesses:{floor},components:[
      interior('fuel',{x:-1.4,y:.35},'tank',{metal:'steel',sizeScale:1.5}), interior('engine',{x:1,y:.35},'engine'),
    ]}));
    ignite(world);
    const tank=part(world,'fuel'), tyre=world.modules.filter(m=>m.kind==='wheel').sort((a,b)=>Math.abs(a.x-tank.x)-Math.abs(b.x-tank.x))[0];
    setPart(world,tyre,{health:tyre.health*.7});
    const initial={health:tyre.health,mass:tyre.physicalMass};
    advance(world,10*60);
    assert(tyre.health<initial.health && tyre.health>initial.health*.9);
    assert(!tyre.burning && tyre.burnAge===0 && tyre.physicalMass===initial.mass,'warming cannot consume an unlit tyre');
    const early=tyre.health/initial.health;
    advance(world,170*60);
    return {early,consumed:tyre.burnAge,health:tyre.health/initial.health,fuel:tank.fuelLitres};
  };
  const thin=run(5), thick=run(40);
  assert(thin.early<thick.early && thin.health<thick.health,'the actual plate thickness attenuates the same local fire');
  assert(thin.consumed>0,'a tyre can eventually ignite through a thin floor: '+JSON.stringify({thin,thick}));
});

test('parts keep a shared fire alive after liquid fuel ends; it fades and stops without a wreck timer', t => {
  const world = scene(t); ignite(world, 'engine'); ignite(world);
  const tank = part(world, 'fuel'), engine = part(world, 'engine'), events = [];
  setPart(world, tank, { fuelLitres: .1 });
  advance(world, 120, { events });
  assert.equal(tank.fuelLitres, 0); assert(engine.burning);
  let peak = 0, last = 0;
  for (let second = 0; second < 240 && world.modules.some(m => m.burning); second++) {
    events.length = 0; advance(world, 60, { events });
    for (const e of events) if (e.type === 'burn') { peak = Math.max(peak, e.strength); last = e.strength; }
  }
  assert(last < peak, 'the remaining burning material fades instead of keeping a constant timer-driven fire');
  assert(world.modules.every(m => !m.burning));
  assert.equal(world.snapshot().actors[0].burning, false);
  assert(engine.physicalMass > engine.dryMass * .9, 'the metal casing survives the combustible contents');
  events.length = 0; advance(world, 120, { events });
  assert(!events.some(e => e.type === 'burn'));
});

test('saving, changing the scene and turning preserve burnt material; repairing controls the shared fire', t => {
  const world = scene(t); ignite(world);
  advance(world, 10 * 60, { drain: true });
  const kept = JSON.parse(JSON.stringify(world.keep())), restored = managedWorld(t, design());
  restored.removeActor('local'); restored.resume(kept);
  const readings = w => w.modules.map(m => ({ id: m.id, health: m.health, burning: m.burning,
    age: m.burnAge, fireAge: m.fireAge, mass: m.physicalMass, fuel: m.fuelLitres }));
  assert.deepEqual(readings(restored), readings(world));
  advance(world, 60, { drain: true }); advance(restored, 60, { drain: true });
  assert.deepEqual(readings(restored), readings(world));
  const mass = part(restored, 'engine').physicalMass;
  restored.addActor(design(), { id: 'visitor', x: 60 }); restored.removeActor('visitor');
  assert.equal(part(restored, 'engine').physicalMass, mass, 'scene replacement does not consume material twice');
  const age = part(restored, 'engine').burnAge;
  restored.turnActor('local');
  const engine = part(restored, 'engine'), tank = part(restored, 'fuel'), fuel = tank.fuelLitres;
  assert.equal(engine.burnAge, age); assert.equal(engine.physicalMass, mass);
  setPart(restored, engine, { health: engine.maxHealth });
  assert(restored.modules.every(m => !m.burning));
  assert.equal(engine.burnAge, 0); assert.equal(tank.fuelLitres, fuel);
  const repaired = engine.health; advance(restored, 60, { drain: true });
  assert.equal(engine.health, repaired); assert.equal(restored.snapshot().actors[0].burning, false);
});

test('an engine ignition develops from a small fire and preserves its growth through save and network', t => {
  const world = scene(t), engine = part(world, 'engine'), tank = part(world, 'fuel'), events = [];
  flyRound(world, { x: engine.x - engine.width / 2 - .02, y: engine.y, vx: 600, vy: 0,
    power: 500, mass: .2, caliberMm: 25, radius: .0125, ammo: 'ap' }, .0002);
  assert(engine.burning); assert.equal(tank.health, tank.maxHealth);
  world.drainEvents(); advance(world, 6, { events });
  const first = events.find(e => e.type === 'burn');
  assert(first.strength < .12); assert.equal(first.spread, 0);
  advance(world, 5 * 60, { drain: true });
  const kept = JSON.parse(JSON.stringify(world.keep())), restored = scene(t);
  restored.removeActor('local'); restored.resume(kept);
  assert.equal(part(restored, 'engine').fireAge, engine.fireAge);
  const left = [], right = [];
  advance(world, 24 * 60, { events: left }); advance(restored, 24 * 60, { events: right });
  const full = left.filter(e => e.type === 'burn').at(-1), resumed = right.filter(e => e.type === 'burn').at(-1);
  assert(full.strength > first.strength * 5); assert(full.spread < 1);
  assert.equal(tank.fuelLitres, part(restored, 'fuel').fuelLitres);
  assert.equal(tank.burning, false, 'the reserve is still unlit after the engine develops');
  assert.deepEqual([resumed.strength, resumed.spread], [full.strength, full.spread]);
  const published = new Publication().state(world.snapshot());
  assert(published.modules.every(m => m.fireAge === undefined), 'internal clocks stay on the server instead of being repeated per part');
  const frame = new FrameReader().decode(new FrameWriter().encode({ state: published, events: [full] }, true));
  assert.equal(frame.events[0].spread, full.spread);
  assert.equal(frame.events[0].radius, full.radius);
  assert.equal(world.stats.explosions, 0);
});

test('a real local fire heats before spreading and leaves distant fuel in the same hull intact', t => {
  const blueprint = damageConstruction({ length: 12, height: 4, components: [
    interior('fuel', { x: -4, y: .2175 }, 'origin'), interior('engine', { x: -2, y: .35 }, 'near'),
    interior('fuel', { x: 4.5, y: .2175 }, 'remote'),
  ] }), world = scene(t, blueprint), remote = world.modules.find(m => m.id.endsWith(':remote')),
    near = part(world, 'engine'), reserve = remote.fuelLitres, health = remote.health;
  ignite(world); advance(world, 5 * 60, { drain: true });
  assert(near.health < near.maxHealth); assert.equal(near.burning, false); assert.equal(near.burnAge, 0);
  const events = []; advance(world, 90 * 60, { events });
  assert(near.burning && near.burnAge > 0, 'a heated neighbour can ignite later');
  assert.equal(remote.burning, false); assert.equal(remote.fuelLitres, reserve); assert.equal(remote.health, health);
  assert(events.filter(e => e.type === 'burn').every(e => e.radius < 5), 'the effect cannot claim the distant reserve');
});

test('a hit turbine burns locally, survives save and resume, and cannot consume a remote tank', t => {
  const blueprint = withConstructionKind(damageConstruction({ dynamic: true, chassis: 'tracked', length: 8, height: 2.5,
    frontThickness: 5, wallThickness: 5, components: [
    interior('thruster', { x: -2.5, y: .86 }, 'origin', { metal: 'titanium', sizeScale: 1.3 }),
    interior('thruster', { x: 2.5, y: .86 }, 'other', { metal: 'titanium', sizeScale: 1.3 }),
    interior('fuel', { x: 3.4, y: .2175 }, 'remote'),
  ] }), 'aircraft'), world = scene(t, blueprint), origin = part(world, 'thruster'), tank = part(world, 'fuel'),
    other = world.modules.find(m => m.id.endsWith(':other')), fuel = tank.fuelLitres, mass = origin.physicalMass, events = [];
  ignite(world, 'thruster'); advance(world, 6, { events });
  const first = events.find(e => e.type === 'burn');
  assert(first && first.strength > 0 && first.strength < .12, 'a turbine ignition begins weak');
  assert.equal(other.burning, false); assert.equal(other.burnAge, 0);
  advance(world, 5 * 60, { drain: true });
  const kept = JSON.parse(JSON.stringify(world.keep())), restored = scene(t, blueprint);
  restored.removeActor('local'); restored.resume(kept);
  const readings = w => w.modules.map(m => ({ id: m.id, health: m.health, burning: m.burning,
    age: m.burnAge, growth: m.fireAge, mass: m.physicalMass, fuel: m.fuelLitres }));
  assert.deepEqual(readings(restored), readings(world));
  for (let second = 0; second < 150; second++) {
    advance(world, 60, { drain: true }); advance(restored, 60, { drain: true });
  }
  assert.deepEqual(readings(restored), readings(world));
  assert.equal(origin.burning, false);
  assert(origin.burnAge > 0, 'the finite combustible contents have been consumed');
  // The body batches small mass changes; a single turbine loses less than that threshold.
  assert(origin.physicalMass <= mass && origin.physicalMass > mass * .9, 'the metal remains');
  assert.equal(tank.fuelLitres, fuel); assert.equal(tank.burning, false); assert.equal(tank.health, tank.maxHealth);
  assert.equal(world.stats.explosions, 0);
});
