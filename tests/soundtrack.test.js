import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { MOODS, MUSIC_FADE, MUSIC_LEVEL, TENSE_HOLD, tracksByMood, threatened, Mood, Soundtrack } from '../src/soundtrack.ts';
import { SoundSystem } from '../src/audio.ts';

// The audio of a page, as far as the music asks of it: gains that keep what they were told, and elements that play.
function stage() {
  const gains = [], elements = [], waits = [];
  const param = () => ({ value: 1, told: [], setTargetAtTime(value, time, constant) { this.told.push([value, time, constant]); this.value = value; }, setValueAtTime(value) { this.value = value; },
      cancelScheduledValues() {} }),
    node = () => ({ connected: [], connect(to) { this.connected.push(to); return to; }, disconnect() { this.connected = []; } }),
    context = { currentTime: 0, state: 'running', destination: { name: 'destination' }, sampleRate: 48000, resume: async () => {},
      createGain() { const gain = Object.assign(node(), { gain: param() }); gains.push(gain); return gain; },
      createMediaElementSource(element) { const source = node(); element.source = source; return source; },
      createDynamicsCompressor: () => Object.assign(node(), { threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
      createConvolver: () => node(),
      createBuffer: (channels, length) => ({ length, getChannelData: () => new Float32Array(length) }) },
    open = url => { const element = { url, src: url, paused: true, plays: 0, duration: 120, currentTime: 0, loaded: 0,
      play() { this.paused = false; this.plays++; return Promise.resolve(); }, pause() { this.paused = true; }, removeAttribute(name) { delete this[name]; }, load() { this.loaded++; } };
      elements.push(element); return element; };
  return { context, open, gains, elements, waits, later: (run, seconds) => waits.push({ run, seconds }) };
}
const TRACKS = { construction: ['b1', 'b2'], calm: ['c1', 'c2', 'c3'], tense: ['t1'] };
const made = (tracks = TRACKS, random = () => .999) => { const s = stage(), output = { name: 'music' };
  return { ...s, output, music: new Soundtrack({ tracks, context: s.context, output, open: s.open, later: s.later, random }) }; };

test('the music beside the game is of three moods, a file of the mood its name begins with, and every mood has its tracks', () => {
  assert.deepEqual(MOODS, ['construction', 'calm', 'tense']);
  assert.deepEqual(tracksByMood({ '../music/tense-2.mp3': '/t2', '../music/calm-1.mp3': '/c1', '../music/tense-1.mp3': '/t1', '../music/notes.mp3': '/x', '../music/construction-1.mp3': '/b1' }),
    { construction: ['/b1'], calm: ['/c1'], tense: ['/t1', '/t2'] });
  assert.deepEqual(tracksByMood({}), { construction: [], calm: [], tense: [] });
  const files = readdirSync(new URL('../music/', import.meta.url)), found = tracksByMood(Object.fromEntries(files.map(file => ['../music/' + file, file])));
  for (const mood of MOODS) assert(found[mood].length >= 2, `${mood}: ${found[mood].length}`);
  assert.equal(MOODS.reduce((sum, mood) => sum + found[mood].length, 0), files.length, 'no file of the folder is of no mood');
});

test('the field is dangerous while a construction of another faction is in sight or in the sensors of the player\'s, and nowhere else', () => {
  const faction = { id: 'mine' }, own = { id: 'a', ownerId: 'me', team: 'mine' }, ally = { id: 'b', ownerId: 'you', team: 'mine' }, foe = { id: 'c', ownerId: 'him', team: 'theirs' },
    field = (actors, contacts = []) => ({ shared: true, faction, localPlayerId: 'me', actors, contacts });
  assert.equal(threatened(field([own, ally])), false);
  assert.equal(threatened(field([own, foe])), true);
  assert.equal(threatened(field([own, { ...foe, ghost: { since: 3 } }])), false, 'a ghost is a memory');
  assert.equal(threatened(field([own, { ...foe, defeated: true }])), false, 'a wreck is nobody');
  for (const mark of [{ kind: 'radar' }, { kind: 'sound' }, { kind: 'battery' }]) assert.equal(threatened(field([own], [mark])), true, mark.kind);
  assert.equal(threatened({ ...field([own, foe]), shared: false }), false); assert.equal(threatened({ ...field([own, foe]), faction: null }), false);
  assert.equal(threatened(undefined), false); assert.equal(threatened({ shared: true, faction, localPlayerId: 'me', actors: [own] }), false);
});

test('the lab is a workshop; the field is calm, a workshop at its workshop, and tense from a sign of danger until half a minute after the last', () => {
  const mood = new Mood(), faction = { id: 'mine' }, quiet = { shared: true, faction, localPlayerId: 'me', actors: [], contacts: [] },
    danger = { ...quiet, actors: [{ id: 'c', ownerId: 'him', team: 'theirs' }] };
  assert.deepEqual([mood.of({ edit: true, state: { shared: false } }, 0), mood.of({ edit: false, state: { shared: false } }, 1), mood.of({ edit: false, state: undefined }, 2)], ['construction', 'construction', 'construction']);
  assert.deepEqual([mood.of({ edit: false, state: quiet }, 10), mood.of({ edit: true, state: quiet }, 11)], ['calm', 'construction']);
  assert.equal(mood.of({ edit: false, state: danger }, 20), 'tense'); assert.equal(mood.of({ edit: true, state: danger }, 21), 'tense', 'danger comes before the workshop');
  assert.equal(mood.of({ edit: false, state: quiet }, 21 + TENSE_HOLD - .1), 'tense'); assert.equal(mood.of({ edit: true, state: quiet }, 21 + TENSE_HOLD - .05), 'tense');
  assert.equal(mood.of({ edit: false, state: quiet }, 21 + TENSE_HOLD), 'calm');
  // Leaving the field leaves its danger there.
  mood.of({ edit: false, state: danger }, 100); assert.equal(mood.of({ edit: false, state: { shared: false } }, 101), 'construction'); assert.equal(mood.of({ edit: false, state: quiet }, 102), 'calm');
  assert.equal(TENSE_HOLD, 30);
});

test('a track of the mood asked for comes in, and gives way to one of another mood as that is asked for', () => {
  const { music, context, elements, gains, waits, output } = made();
  // Nothing plays until the music is to be heard; then it is the mood that was asked for meanwhile.
  music.setMood('calm'); assert.equal(elements.length, 0);
  music.setPlaying(true);
  assert.deepEqual([elements.length, elements[0].paused, elements[0].preload, TRACKS.calm.includes(elements[0].url)], [1, false, 'auto', true]);
  assert.deepEqual(gains[0].gain.told, [[1, 0, MUSIC_FADE / 4]], 'it comes in from silence'); assert.deepEqual([elements[0].source.connected, gains[0].connected], [[gains[0]], [output]]);
  music.setMood('calm'); assert.equal(elements.length, 1, 'the same mood again changes nothing');
  // Another mood: its track comes in as this one goes out, and this one is let go when it is out.
  context.currentTime = 50; music.setMood('tense');
  assert.deepEqual([elements.length, elements[1].url, elements[1].paused, elements[0].paused], [2, 't1', false, false]);
  assert.deepEqual([gains[0].gain.told.at(-1), gains[1].gain.told], [[0, 50, MUSIC_FADE / 4], [[1, 50, MUSIC_FADE / 4]]]);
  assert.deepEqual(waits.map(wait => wait.seconds), [MUSIC_FADE]); waits.shift().run();
  assert.deepEqual([elements[0].paused, elements[0].src, elements[0].loaded, gains[0].connected, elements[0].ontimeupdate], [true, undefined, 1, [], null]);
  assert.equal(music.current.element, elements[1]);
});

test('within a mood every track is heard before one comes again, never the same twice running, each giving way as it ends', () => {
  let draws = 0;
  const { music, elements, waits } = made(TRACKS, () => [.1, .7, .4, .9, .2][draws++ % 5]);
  music.setMood('calm'); music.setPlaying(true);
  const heard = [elements[0].url];
  for (let i = 0; i < 11; i++) {
    const playing = elements.at(-1);
    // Far from its end it plays on; within the fade of it the next comes in.
    playing.currentTime = 120 - MUSIC_FADE - 1; playing.ontimeupdate(); assert.equal(elements.at(-1), playing);
    playing.currentTime = 120 - MUSIC_FADE + .2; playing.ontimeupdate(); assert.notEqual(elements.at(-1), playing);
    assert.equal(playing.ontimeupdate, null, 'it asks for the next once'); heard.push(elements.at(-1).url);
  }
  for (let i = 0; i + 3 <= heard.length; i += 3) assert.deepEqual(heard.slice(i, i + 3).sort(), ['c1', 'c2', 'c3'], 'all three in every round');
  for (let i = 1; i < heard.length; i++) assert.notEqual(heard[i], heard[i - 1]);
  assert.equal(waits.length, 11);
  // A mood of one track plays it again; one that ends before it is asked gives way all the same.
  music.setMood('tense'); elements.at(-1).onended(); assert.deepEqual(elements.slice(-2).map(element => element.url), ['t1', 't1']);
});

test('silent, the music stops where it is and goes on from there, unless the mood is another by then; a track that cannot be read is left out', () => {
  const { music, elements } = made();
  music.setMood('tense'); music.setPlaying(true); music.setPlaying(false);
  assert.deepEqual([elements.length, elements[0].paused], [1, true]);
  music.setPlaying(true); assert.deepEqual([elements.length, elements[0].paused, elements[0].plays], [1, false, 2]);
  music.setPlaying(false); music.setMood('construction'); assert.equal(elements.length, 1, 'nothing starts in silence');
  music.setPlaying(true); assert.deepEqual([elements.length, TRACKS.construction.includes(elements[1].url)], [2, true]);
  // The one that fails gives way to the other of its mood, which is then the only one; with none left the mood is silent.
  const failed = elements[1].url, other = TRACKS.construction.find(url => url !== failed);
  elements[1].onerror(); assert.equal(elements[2].url, other);
  elements[2].onended(); assert.equal(elements[3].url, other);
  elements[3].onerror(); assert.deepEqual([elements.length, music.current], [4, null]);
  assert.deepEqual(TRACKS.construction, ['b1', 'b2'], 'the list it was given is as it was');
  // A mood nobody made music for is silence.
  const none = made({ calm: [] }); none.music.setMood('calm'); none.music.setPlaying(true); assert.deepEqual([none.elements.length, none.music.current], [0, null]);
});

test('the sound system plays the music by its switch and its volume, wherever the player is, and not on a page out of sight', async () => {
  const s = stage(), stored = new Map([['impacto.sound.v1', JSON.stringify({ enabled: true, volume: .4 })]]),
    storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) },
    sound = new SoundSystem({ storage, contextFactory: () => s.context, music: { tracks: TRACKS, open: s.open, later: s.later } });
  sound.setMood('construction'); assert.equal(sound.soundtrack, undefined, 'no audio before the player touches the page');
  await sound.unlock();
  const bus = sound.musicBus;
  assert.deepEqual([s.elements.length, TRACKS.construction.includes(s.elements[0].url), s.elements[0].paused], [1, true, false]);
  assert.deepEqual([bus.connected, bus.gain.told.at(-1)[0]], [[s.context.destination], .4 * MUSIC_LEVEL], 'beside the sounds of the world, not through them');
  // No world is shown at the bench and the sounds of the world are off: the music plays on.
  sound.setActive(false); assert.equal(s.elements[0].paused, false);
  const told = bus.gain.told.length; sound.setMood('construction'); sound.updateMusic(); assert.equal(bus.gain.told.length, told, 'told again, nothing is asked of the audio');
  sound.setVolume(.8); assert.equal(bus.gain.told.at(-1)[0], .8 * MUSIC_LEVEL);
  sound.setShown(false); assert.deepEqual([s.elements[0].paused, bus.gain.told.at(-1)[0]], [true, 0]);
  sound.setShown(true); assert.deepEqual([s.elements[0].paused, bus.gain.told.at(-1)[0]], [false, .8 * MUSIC_LEVEL]);
  sound.setEnabled(false); assert.deepEqual([s.elements[0].paused, bus.gain.told.at(-1)[0]], [true, 0]);
  sound.setMood('tense'); sound.setEnabled(true); assert.deepEqual([s.elements.length, s.elements[1].url, s.elements[1].paused], [2, 't1', false]);
  // The music alone off: the sounds of the world go on; the choice is kept for the next visit.
  sound.setActive(true); sound.setMusic(false);
  assert.deepEqual([s.elements[1].paused, bus.gain.told.at(-1)[0]], [true, 0]);
  assert(sound.masterTarget > 0, 'world loudness normalization stays independent of the muted music bus');
  assert.equal(JSON.parse(stored.get('impacto.sound.v1')).music, false);
  assert.equal(new SoundSystem({ storage, contextFactory: () => stage().context }).musicOn, false);
  sound.setMusic(true); assert.deepEqual([s.elements[1].paused, bus.gain.told.at(-1)[0]], [false, .8 * MUSIC_LEVEL]);
  // A sound system made without music has none.
  const plain = new SoundSystem({ storage, contextFactory: () => stage().context }); await plain.unlock(); plain.setMood('calm'); plain.setShown(false);
  assert.equal(plain.soundtrack, undefined);
});
