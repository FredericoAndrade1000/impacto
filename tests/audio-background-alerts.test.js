import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, soundCue, ALERT_GAP } from '../src/audio.ts';
import { MUSIC_LEVEL } from '../src/soundtrack.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';

const cues = ctx => ctx.nodes.filter(node => node.kind === 'buffer' && node.buffer?.url.startsWith('alert-'));
async function setup(t, preferences = {}) {
  const ctx = fakeAudioContext(), stored = new Map([['impacto.sound.v1', JSON.stringify(preferences)]]), elements = [],
    storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    sound = new SoundSystem({ contextFactory: () => ctx, storage, sounds: everySound(),
      music: { tracks: { calm: ['calm.mp3'] }, open: url => {
        const element = { url, paused: true, play() { this.paused = false; return Promise.resolve(); },
          pause() { this.paused = true; }, removeAttribute() {}, load() {} };
        elements.push(element); return element;
      } } });
  sound.setMood('calm'); await sound.unlock(); sound.setActive(true);
  t.after(() => { sound.stop(); sound.setShown(false); });
  return { ctx, sound, stored, storage, elements };
}

test('background alerts default on, preserve a saved off choice and persist beside mute, music and volume', async t => {
  const { sound, stored, storage } = await setup(t);
  assert.equal(sound.backgroundAlerts, true);
  let changes = 0; sound.onChange = () => changes++;
  sound.setBackgroundAlerts(false); sound.setVolume(.6); sound.setMusic(false); sound.setEnabled(false);
  assert.equal(changes, 4);
  assert.deepEqual(JSON.parse(stored.get('impacto.sound.v1')), { enabled: false, music: false, volume: .6, backgroundAlerts: false });
  const reopened = new SoundSystem({ storage });
  assert.equal(reopened.backgroundAlerts, false); assert.equal(reopened.enabled, false);
  assert.equal(reopened.musicOn, false); assert.equal(reopened.volume, .6);
  sound.setBackgroundAlerts(true);
  assert.equal(new SoundSystem({ storage }).backgroundAlerts, true);
});

test('only the separate contact and grave channel remains audible while the tab is hidden', async t => {
  const { ctx, sound, elements } = await setup(t), state = { time: 1, actors: [{ id: 'truck',
      vehicle: { engine: true, x: 12, y: 1, vx: 2, throttle: .3, traction: 1 } }], plates: [], modules: [], attachments: [] };
  sound.receive(state, []); assert.equal(sound.engines.size, 1);
  const engineSources = [...sound.engines.values()].flatMap(loop => loop.sources);
  assert.equal(elements[0].paused, false); assert.equal(sound.musicBus.gain.value, sound.volume * MUSIC_LEVEL);
  assert(Math.abs(20 * Math.log10(sound.master.gain.value / sound.volume) - 3) < 1e-9, 'the modest field lift leaves saved volume and music independent');
  sound.setShown(false); sound.setActive(false);
  assert.equal(sound.master.gain.value, 0); assert.equal(sound.alertBus.gain.value, sound.volume);
  assert.equal(sound.musicBus.gain.value, 0); assert.equal(elements[0].paused, true);
  assert.equal(sound.engines.size, 0); assert(engineSources.every(source => source.stops.length));
  const nodes = ctx.nodes.length;
  sound.receive({ ...state, time: 2 }, [{ type: 'muzzle', time: 2, x: 12, y: 1 }]);
  sound.play({ type: 'muzzle', x: 12, y: 1 }, soundCue({ type: 'muzzle', caliberMm: 25 }));
  sound.cue('clunk'); sound.alert('gun-cannon');
  assert.equal(ctx.nodes.length, nodes, 'hidden world updates and UI cues allocate no sources');
  sound.alert('contact');
  const contact = sound.alertVoice;
  assert(contact); assert.deepEqual(contact.nodes.at(-1).connections, [sound.alertBus]);
  assert(Math.abs(20 * Math.log10(contact.nodes.at(-1).gain.value / 3.28) + 3) < 1e-9, 'alerts are softer without inheriting the field lift');
  assert.equal(sound.alertBus.connections[0], sound.master.connections[0], 'both channels retain the same compressor and limiter');
  sound.setActive(false);
  assert.equal(sound.alertVoice, contact, 'ordinary hidden UI refreshes cannot cut off a new alert');
  ctx.advance(.1); sound.alert('grave');
  const grave = sound.alertVoice; assert.equal(contact.ended, true); assert.equal(grave.alertKind, 'grave');
  const allocated = ctx.nodes.length; sound.alert('contact'); assert.equal(ctx.nodes.length, allocated);
  assert.equal(sound.voices.length, 1); assert.equal(sound.engines.size, 0);
  assert.equal(ctx.nodes.filter(node => node.kind === 'oscillator').length, 0);
  assert.equal(sound.master.gain.value, 0); assert.equal(sound.musicBus.gain.value, 0);
  assert.equal(elements[0].paused, true);
});

test('background alerts obey the saved switch, global mute and volume without reactivating the world', async t => {
  const { ctx, sound } = await setup(t, { backgroundAlerts: false, volume: .4 });
  sound.setShown(false); sound.setActive(false);
  sound.alert('contact'); assert.equal(cues(ctx).length, 0); assert.equal(sound.alertBus.gain.value, 0);
  sound.setBackgroundAlerts(true); sound.alert('contact'); assert.equal(cues(ctx).length, 1);
  sound.setVolume(.75); assert.equal(sound.alertBus.gain.value, .75); assert.equal(sound.master.gain.value, 0);
  sound.setVolume(0); assert.equal(sound.alertBus.gain.value, 0); assert.equal(sound.alertVoice, null);
  const muted = ctx.nodes.length; sound.alert('grave'); assert.equal(ctx.nodes.length, muted);
  sound.setVolume(.3); sound.setEnabled(false); sound.alert('grave');
  assert.equal(ctx.nodes.length, muted); assert.equal(sound.alertBus.gain.value, 0);
  sound.setEnabled(true); sound.alert('grave'); assert.equal(sound.alertVoice.alertKind, 'grave');
  sound.setBackgroundAlerts(false); assert.equal(sound.alertVoice, null); assert.equal(sound.alertBus.gain.value, 0);
  ctx.advance(ALERT_GAP + .1); sound.alert('contact'); assert.equal(cues(ctx).length, 2);
  sound.setActive(true); sound.setShown(true); sound.alert('contact');
  assert.equal(cues(ctx).length, 3, 'turning background alerts off leaves foreground alerts available');
  assert(Math.abs(sound.master.gain.value - .3 * 10 ** (3 / 20)) < 1e-12);
  sound.setActive(false); assert.equal(sound.alertVoice, null);
});

test('hidden alerts never create or resume an audio context that the browser has suspended', async t => {
  let created = 0;
  const unopened = new SoundSystem({ storage: { getItem: () => '{}', setItem() {} }, contextFactory: () => { created++; return fakeAudioContext(); } });
  unopened.setShown(false); unopened.alert('grave'); unopened.setBackgroundAlerts(true);
  assert.equal(created, 0); assert.equal(unopened.context, null);
  const { ctx, sound } = await setup(t); let resumed = 0; ctx.resume = async () => resumed++;
  sound.setShown(false); sound.setActive(false); const allocated = ctx.nodes.length;
  for (const state of ['suspended', 'interrupted', 'closed']) {
    ctx.state = state; sound.alert('grave'); sound.setBackgroundAlerts(false); sound.setBackgroundAlerts(true);
    assert.equal(ctx.nodes.length, allocated); assert.equal(resumed, 0);
  }
});

test('repeated input leaves ready audio alone, while a suspended context is still resumed', async t => {
  const { ctx, sound } = await setup(t), nodes = ctx.nodes.length, buffers = ctx.buffers.length;
  let changes = 0, resumes = 0;
  sound.onChange = () => changes++;
  ctx.resume = async () => { resumes++; ctx.state = 'running'; };
  await sound.unlock(); await sound.unlock();
  assert.equal(changes, 0); assert.equal(resumes, 0);
  assert.deepEqual([ctx.nodes.length, ctx.buffers.length], [nodes, buffers]);
  ctx.state = 'suspended'; await sound.unlock();
  assert.equal(resumes, 1); assert.equal(changes, 1); assert.equal(sound.unavailable, false);
  ctx.state = 'suspended'; ctx.resume = async () => { throw Error('Audio denied'); };
  await sound.unlock();
  assert.equal(sound.unavailable, true); assert.equal(changes, 2);
  await sound.unlock(); assert.equal(changes, 2, 'an unavailable context is not reported ready');
});

test('a running context still waits for its first sound bank instead of treating it as ready', async () => {
  const ctx = fakeAudioContext(); let finish, changes = 0;
  const sound = new SoundSystem({ contextFactory: () => ctx, storage: { getItem: () => '{}', setItem() {} },
    sounds: { files: new Map([['clunk', 'clunk.mp3']]), load: () => new Promise(resolve => { finish = resolve; }) } });
  sound.onChange = () => changes++;
  const first = sound.unlock(), second = sound.unlock();
  assert.equal(sound.bank.ready, false); assert.equal(changes, 0);
  finish('clunk.mp3'); await Promise.all([first, second]);
  assert.equal(sound.bank.ready, true); assert.equal(sound.bank.get('clunk').url, 'clunk.mp3');
  assert.equal(changes, 2); await sound.unlock(); assert.equal(changes, 2);
});
