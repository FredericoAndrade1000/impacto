import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, soundCue, ALERTS, ALERT_GAP } from '../src/audio.ts';
import { SOUND_PROFILES } from '../src/sound-art.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

async function setup(t) {
  const ctx = fakeAudioContext(), sound = new SoundSystem({ contextFactory: () => ctx,
    storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true);
  t.after(() => sound.stop());
  return { ctx, sound };
}
const cues = ctx => ctx.nodes.filter(node => node.kind === 'buffer' && node.buffer?.url.startsWith('alert-'));

test('a grave alert interrupts the contact voice and its delayed end cannot clear the new alert', async t => {
  const { ctx, sound } = await setup(t);
  sound.alert('contact');
  const contact = sound.voices[0], source = contact.sources[0];
  ctx.advance(.1);
  sound.alert('grave');
  const grave = sound.voices[0];
  assert.equal(sound.voices.length, 1);
  assert.equal(grave.sources[0].buffer.url, 'alert-grave.mp3');
  assert.deepEqual(grave.sources[0].starts, [.1]);
  assert.equal(source.stops.at(-1), .1, 'contact stops when grave starts');
  assert(contact.nodes.every(node => node.disconnects === 1));
  assert.equal(contact.ended, true);
  source.onended();
  assert.equal(sound.alertVoice, grave);
  assert.deepEqual(sound.voices, [grave]);
  ctx.advance(.1 + SOUND_PROFILES[ALERTS.grave].duration);
  assert.equal(sound.alertVoice, null);
  assert.equal(sound.voices.length, 0);
});

test('contact cannot overlap grave, and a suppressed contact consumes no allocation or repeat window', async t => {
  const { ctx, sound } = await setup(t);
  sound.alert('grave');
  const grave = sound.voices[0], allocated = ctx.nodes.length;
  ctx.advance(.1);
  sound.alert('contact');
  assert.equal(ctx.nodes.length, allocated);
  assert.equal(cues(ctx).length, 1);
  assert.deepEqual(sound.voices, [grave]);
  assert.equal(sound.alerted.contact, undefined);
  ctx.advance(SOUND_PROFILES[ALERTS.grave].duration);
  sound.alert('contact');
  assert.deepEqual(cues(ctx).map(source => source.buffer.url), ['alert-grave.mp3', 'alert-contact.mp3']);
  assert.equal(sound.voices.length, 1);
  assert.equal(sound.voices[0].sources[0].starts[0], SOUND_PROFILES[ALERTS.grave].duration);
});

test('each alert keeps its existing repeat gap after the shared voice has finished', async t => {
  for (const kind of ['contact', 'grave']) {
    const { ctx, sound } = await setup(t), duration = SOUND_PROFILES[ALERTS[kind]].duration;
    sound.alert(kind);
    ctx.advance(duration + .01);
    sound.alert(kind);
    ctx.advance(ALERT_GAP - .01);
    sound.alert(kind);
    assert.equal(cues(ctx).length, 1, kind);
    ctx.advance(ALERT_GAP);
    sound.alert(kind);
    assert.equal(cues(ctx).length, 2, kind);
    assert.equal(sound.voices.length, 1);
  }
});

test('an expired alert releases its channel even before Web Audio delivers its end callback', async t => {
  const { ctx, sound } = await setup(t);
  sound.alert('grave');
  const old = sound.voices[0];
  // The clock advances, but the browser has not dispatched onended yet.
  ctx.currentTime = SOUND_PROFILES[ALERTS.grave].duration + .01;
  sound.alert('contact');
  const current = sound.voices[0];
  assert.equal(old.ended, true);
  assert.equal(sound.voices.length, 1);
  assert.equal(current.sources[0].buffer.url, 'alert-contact.mp3');
  old.sources[0].onended();
  assert.equal(sound.alertVoice, current);
});

test('alert priority leaves engine loops and field effects alone and pause or mute releases the channel', async t => {
  const { ctx, sound } = await setup(t), state = { time: 1, plates: [], modules: [], attachments: [],
    actors: [{ id: 'truck', vehicle: { engine: true, x: 12, y: 1, vx: 2, throttle: .3, traction: 1 } }] };
  sound.receive(state, []);
  const engine = sound.engines.get('truck');
  assert(engine);
  sound.play({ x: 12, y: 1, type: 'muzzle' }, soundCue({ type: 'muzzle', caliberMm: 25 }));
  const effect = sound.voices[0], masterConnections = [...sound.master.connections];
  sound.alert('contact'); ctx.advance(.1); sound.alert('grave');
  assert.equal(sound.engines.get('truck'), engine);
  assert(engine.sources.every(source => !source.ended && source.stops.length === 0));
  assert(sound.voices.includes(effect));
  assert.equal(effect.sources[0].stops.length, 1, 'the field effect keeps only its original scheduled stop');
  assert.deepEqual(sound.master.connections, masterConnections);
  sound.setActive(false);
  assert.equal(sound.alertVoice, null);
  assert.equal(sound.voices.length, 0);
  const count = cues(ctx).length;
  sound.alert('contact');
  assert.equal(cues(ctx).length, count);
  ctx.advance(ALERT_GAP + .2); sound.setActive(true); sound.alert('grave');
  assert(sound.alertVoice);
  sound.setEnabled(false);
  assert.equal(sound.alertVoice, null);
  sound.alert('contact');
  assert.equal(cues(ctx).length, count + 1);
});
