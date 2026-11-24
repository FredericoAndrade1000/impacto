import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {compileBlueprint,parseBlueprint,serializeBlueprint,validateBlueprint} from '../src/persistence.ts';
import {World} from '../src/physics.ts';
import {fixedWeapon,WEAPON_PRESETS} from '../src/weapons.ts';
import {soundCue,SoundSystem,MAX_SOUND_VOICES} from '../src/audio.ts';
import { SOUND_PROFILES } from '../src/sound-art.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';
import {managedWorld,physics,ownerState,flyRound} from './mechanical-queries.js';
import {damageConstruction,face} from './damage-fixtures.js';
import {FrameWriter,FrameReader,tellEvent} from '../src/network-protocol.ts';
await initNativeDynamics();

test('canonical vehicle persists its installed models, gear and physical weapon mount',()=>{
 const source=createConstruction('heavy'),saved=parseBlueprint(serializeBlueprint(source)),dto=compileBlueprint(saved);
 assert.deepEqual(saved,source);assert.equal(dto.mechanicalAdmission,true);
 assert(dto.modules.some(m=>m.kind==='track'));assert(dto.modules.find(m=>m.kind==='weapon').weaponMount);
});
test('supplied authorship is preserved without inserting components or repairing explicit invalid input',()=>{
 const source=createConstruction('scout'),before=structuredClone(source);assert.deepEqual(validateBlueprint(source),source);
 for(const version of [1,2,3])assert.throws(()=>validateBlueprint({...source,version}),/não é um projeto desta versão/);
 const broken=structuredClone(source);broken.components.find(m=>m.kind==='weapon').pose.x=NaN;
 assert.throws(()=>validateBlueprint(broken));
 assert.deepEqual(source,before);
});
test('functional damage cannot detach an installed mechanism or alter carrier mass',t=>{
 const world=managedWorld(t,createConstruction('heavy')),engine=world.modules.find(m=>m.kind==='engine'),
  body=physics(world).bodyStates[0],binding=ownerState(world,engine).body;
 // A round put two centimetres short of the engine, inside the hull, that goes into it and is spent there.
 flyRound(world,{x:engine.x-engine.width/2-.02,y:engine.y,vx:600,vy:0,power:engine.maxHealth*2,mass:.2,caliberMm:25,radius:.0125,ammo:'ap'},.0002);
 assert.equal(engine.health,0);assert.equal(engine.attached,true);
 assert.equal(ownerState(world,engine).body,binding);assert.equal(physics(world).bodyStates[0].mass,body.mass);
 assert.equal(physics(world).bodyStates[0].inertia,body.inertia);
});
test('public presets override weapon parameters and preserve selected mounted calibre after damage',()=>{
 for(const [preset,model]of Object.entries(WEAPON_PRESETS)){
  const weapon=fixedWeapon({preset,power:999,speed:1,mass:15,radius:1});
  assert.equal(weapon.power,model.power);assert.equal(weapon.speed,model.speed);
  assert.equal(weapon.caliberMm,model.caliberMm);assert.equal(weapon.radius*2000,model.caliberMm);
 }
 const modules=compileBlueprint(createConstruction('scout')).modules,gun=modules.find(m=>m.kind==='weapon');
 gun.health=Math.max(1,gun.maxHealth-1);
 const weapon=fixedWeapon({platform:'vehicle',componentId:gun.id,preset:'rh120',power:999},modules);
 assert.equal(weapon.preset,gun.weaponPreset);assert.equal(weapon.componentId,gun.id);
});
test('audio distinguishes calibers, materials and ricochets and attenuates remote events', () => {
  assert(soundCue({ type: 'muzzle', caliberMm: 120 }).duration > soundCue({ type: 'muzzle', caliberMm: 7.62 }).duration);
  assert.equal(soundCue({ type: 'blocked', material: 'steel' }).profile, 'metal-hit'); assert.equal(soundCue({ type: 'blocked', material: 'concrete' }).profile, 'hard-hit');
  assert.equal(soundCue({ type: 'ricochet' }).profile, 'ricochet'); assert.equal(soundCue({ type: 'ricochet', ground: true, surface: 'soil' }).profile, 'ground-hit');
  assert.equal(soundCue({ type: 'burn' }), null);
  for (const type of ['hinge', 'detached', 'break']) assert.equal(soundCue({ type }), null);
});

test('real fast and slow armour contacts carry the projectile calibre through the public codec to the chosen sound', t => {
  for (const caliberMm of [20, 25, 120]) for (const power of [1, 900]) for (const speed of [12, 1100]) {
    const world = managedWorld(t, damageConstruction({ height: 1.6, rideHeight: .9, frontThickness: 100 })), plate = face(world);
    flyRound(world, { x: plate.definition.x - .07, y: plate.definition.y, vx: speed, vy: 0, mass: 5, caliberMm, power, radius: caliberMm / 2000,
      ammo: 'ap', weapon: 'cannon', age: .1, life: 2 }, .002);
    const contact = world.drainEvents().find(event => ['blocked', 'penetration'].includes(event.type) && event.id === plate.id && !event.fragment);
    assert(contact, `${caliberMm} mm / ${power}: an armour contact occurred`);
    assert.equal(contact.caliberMm, caliberMm);
    assert.equal(soundCue(contact).profile, caliberMm >= 25 ? 'metal-hit-heavy' : 'metal-hit');
    const remote = new FrameReader().decode(new FrameWriter().encode({
      state: { time: world.time, actors: [], plates: [], modules: [] }, events: [tellEvent(contact)],
    })).events[0];
    assert.equal(remote.caliberMm, caliberMm);
    assert.deepEqual(soundCue(remote), soundCue(contact));
  }
});

test('audio bounds concurrent voices and stops loops when paused or muted, without repeating snapshots', async t => {
  const ctx = fakeAudioContext(), storage = { getItem: () => '{}', setItem() {} }, sound = new SoundSystem({ contextFactory: () => ctx, storage, sounds: everySound() });
  await sound.unlock(); sound.setActive(true);
  // Every one-shot of the field, again and again in different places: no more voices than the bound.
  const shots = Object.entries(SOUND_PROFILES).filter(([name, p]) => !p.loop && !name.startsWith('alert-'));
  for (let i = 0; i < 100; i++) { const [profile, p] = shots[i % shots.length]; sound.play({ x: 12 + i % 8 * 6, y: 1 }, { profile, duration: p.duration, filter: 12000, volume: .5, priority: 3 }); }
  assert.equal(sound.voices.length, MAX_SOUND_VOICES);
  const state = managedWorld(t, createConstruction('heavy')).snapshot(); sound.receive(state, [], { active: true });
  assert.equal(sound.engines.size, 1); const count = sound.voices.length; sound.receive(state, [], { active: true }); assert.equal(sound.voices.length, count);
  const crowd = { ...state, actors: Array.from({ length: 12 }, (_, i) => ({ ...state.actors[0], id: 'motor-' + i, vehicle: { ...state.actors[0].vehicle, x: 12 + i } })) };
  sound.receive(crowd, [], { active: true }); assert.equal(sound.engines.size, 8);
  sound.setActive(false); assert.equal(sound.voices.length, 0); assert.equal(sound.engines.size, 0);
  sound.setEnabled(false); sound.receive(state, [{ type: 'explosion', x: 12, y: 1 }]); assert.equal(sound.voices.length, 0);
});

