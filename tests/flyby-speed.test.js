import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, flybyRate } from '../src/audio.ts';
import { SOUND_PROFILES } from '../src/sound-art.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

const frame = actors => ({ time: 10, actors, modules: [], plates: [] });
const view = x => ({ x, y: 0, zoom: 20, width: 800, height: 500 });
const flybys = ctx => ctx.nodes.filter(node => node.kind === 'buffer' && node.buffer?.url?.startsWith('flyby-'));
const near = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
async function setup() {
  const ctx = fakeAudioContext({ hold: true }), sound = new SoundSystem({ contextFactory: () => ctx,
    storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); return { ctx, sound };
}

// Public projectile velocity and physical crew motion describe one straight
// flight. The server snapshot time stays fixed while the displayed time moves.
async function passing({ speed = 600, listenerSpeed = 0, aboard = false, velocity = true,
  crewVelocity = true, preset, weapon = preset ? undefined : 'machinegun' } = {}) {
  const result = await setup(), { ctx, sound } = result, allocations = ctx.buffers.length;
  for (let i = 0; i < 4; i++) {
    const time = 1 + i * .05, earX = aboard ? listenerSpeed * (time - 1) : 0,
      body = { x: earX, y: 0, ...(crewVelocity ? { vx: listenerSpeed, vy: 0 } : {}) },
      shot = { number: 7, weapon, preset, x: earX + (speed - listenerSpeed) * (time - 1.075),
        y: 2, age: time, ...(velocity ? { vx: speed, vy: 0 } : {}) };
    ctx.advance(time - 1);
    sound.receive(frame(aboard ? [{ id: 'crew', vehicle: body }] : []), [],
      { listener: view(earX), hands: aboard ? 'crew' : null, time, shots: [shot] });
  }
  assert.equal(flybys(ctx).length, 1, 'one complete crossing, heard once');
  assert.equal(ctx.buffers.length, allocations, 'the existing recording is reused');
  return { ...result, source: flybys(ctx)[0] };
}

test('projectile speed changes the pitch and full recording duration without making new buffers', async () => {
  const rates = [], durations = [];
  for (const speed of [100, 600, 1800]) {
    const { ctx, sound, source } = await passing({ speed }), rate = source.playbackRate.value,
      duration = source.stops[0] - source.starts[0];
    assert.equal(source.buffer, sound.bank.get('flyby-bullet'));
    assert(rate >= .65 && rate <= 1.45);
    near(duration * rate, SOUND_PROFILES['flyby-bullet'].duration);
    assert(sound.voices[0].chain.gain.gain.calls.some(call => call[0] === 'ramp' && call[2] === source.stops[0]),
      'the gain envelope ends with the complete rate-adjusted recording');
    assert.equal(flybys(ctx).length, 1); rates.push(rate); durations.push(duration);
  }
  assert(rates[0] < rates[1] && rates[1] < rates[2]);
  assert(durations[0] > durations[1] && durations[1] > durations[2]);
  assert.equal(flybyRate(NaN), 1); assert.equal(flybyRate(Infinity), 1);
});

test('crew velocity is subtracted from projectile velocity in the same physical frame', async () => {
  const stationary = await passing({ speed: 600, aboard: true }),
    following = await passing({ speed: 900, listenerSpeed: 300, aboard: true }),
    approaching = await passing({ speed: 900, listenerSpeed: -300, aboard: true });
  near(following.source.playbackRate.value, stationary.source.playbackRate.value);
  assert(approaching.source.playbackRate.value > following.source.playbackRate.value);
});

test('missing velocities use displacement over presented time, even between the same server snapshot', async () => {
  const measured = await passing({ speed: 600, listenerSpeed: 60, aboard: true }),
    fallback = await passing({ speed: 600, listenerSpeed: 60, aboard: true, velocity: false, crewVelocity: false });
  near(fallback.source.playbackRate.value, measured.source.playbackRate.value);
});

test('a fast crossing between pictures is heard and an enemy preset selects the correct recording', async () => {
  const bullet = await passing({ speed: 1800, weapon: undefined, preset: 'm2hb' }),
    shell = await passing({ speed: 200, weapon: undefined, preset: 'm119' });
  assert.equal(bullet.source.buffer, bullet.sound.bank.get('flyby-bullet'));
  assert.equal(shell.source.buffer, shell.sound.bank.get('flyby-shell'));
});

test('changing listeners, panning, teleporting or discontinuous time cannot join a false crossing', async () => {
  for (const change of ['listener', 'pan', 'teleport', 'gap', 'rewind', 'repeat', 'pause']) {
    const { ctx, sound } = await setup(), sample = (time, x, { earX = 0, id = 'crew', active = true } = {}) => {
      const aboard = change !== 'pan', body = { x: earX, y: 0, vx: 0, vy: 0 };
      sound.receive(frame(aboard ? [{ id, vehicle: body }] : []), [], { listener: view(earX),
        hands: aboard ? id : null, active, time, shots: [{ number: 7, weapon: 'machinegun', x, y: 2, vx: 600, vy: 0, age: 1 }] });
    };
    sample(1, -20);
    if (change === 'pause') { sample(1.05, 0, { active: false }); sample(1.1, 20); }
    else if (change === 'teleport' || change === 'pan') sample(1.1, 1020, { earX: 1000 });
    else sample(change === 'gap' ? 2 : change === 'rewind' ? .9 : change === 'repeat' ? 1 : 1.1, 20,
      { id: change === 'listener' ? 'other' : 'crew' });
    assert.equal(flybys(ctx).length, 0, change);
  }
});

test('smooth free-camera panning and following a watched vehicle keep real flybys audible',async()=>{
 for(const watching of [false,true]) {
  const {ctx,sound}=await setup();
  for(let i=0;i<4;i++) {const time=1+i*.05, earX=i*.2, shot={number:42,preset:'m2hb',x:earX+600*(time-1.075),y:2,vx:604,vy:0,age:1};
   ctx.advance(time-1); sound.receive(frame(watching ? [{id:'watched',vehicle:{x:earX,y:0,vx:4,vy:0}}] : []),[],{listener:view(earX),following:watching?'watched':null,time,shots:[shot]});
  }
  assert.equal(flybys(ctx).length,1,'watching='+watching);
  if(watching)near(flybys(ctx)[0].playbackRate.value,1);
 }
});
test('a small camera pan over a stationary projectile does not create a flyby',async()=>{
 const {ctx,sound}=await setup();
 for(let i=0;i<4;i++) sound.receive(frame([]),[],{listener:view(-.6+i*.4),time:1+i*.05,shots:[{number:8,preset:'m2hb',x:0,y:2,vx:0,vy:0,age:1}]});
 assert.equal(flybys(ctx).length,0);
});
