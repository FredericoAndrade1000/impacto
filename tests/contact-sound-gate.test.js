import test from 'node:test';
import assert from 'node:assert/strict';
import { SoundSystem, ALERTS, ALERT_GAP } from '../src/audio.ts';
import { everySound, fakeAudioContext } from './helpers/sounds.js';
import { SOUND_PROFILES } from '../src/sound-art.ts';
import { ContactSoundGate } from '../src/contact-sound-gate.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { World } from '../src/physics.ts';
import { FrameWriter, FrameReader, tellEvent } from '../src/network-protocol.ts';

const contact = (changes = {}) => ({ type: 'ground', id: 'piece', contactPair: 'terrain:1:3', material: 'steel', closingSpeed: 1, impactEnergy: 20, impulse: 120, x: 12, y: 1, time: 1, ...changes });
const state = (time = 1) => ({ time, plates: [], modules: [], actors: [], attachments: [] });
async function setup() {
  const ctx = fakeAudioContext({ hold: true }), sound = new SoundSystem({ contextFactory: () => ctx,
    storage: { getItem: () => '{}', setItem() {} }, sounds: everySound() });
  await sound.unlock(); sound.setActive(true); return { ctx, sound };
}

test('large supporting impulses with no closing energy are silent', async () => {
  const gate = new ContactSoundGate();
  for (let i = 0; i < 40; i++) assert.equal(gate.accepts(contact({ time: i * .18, closingSpeed: 0, impactEnergy: 0, impulse: 20000 }), i * .18), false);
  const { sound } = await setup(); sound.receive(state(1), [contact({ closingSpeed: 0, impactEnergy: 0, impulse: 20000 })]);
  assert.equal(sound.voices.length, 0);
});

test('persistent contacts remain quiet across snapshots but real bounces and new energetic strikes remain audible', async () => {
  const { ctx, sound } = await setup(), frame = time => state(time); sound.receive(frame(1), [contact()]);
  const sources = () => ctx.nodes.filter(node => node.kind === 'buffer').length, first = sources();
  for (let i = 1; i < 5; i++) { ctx.currentTime = i * .03; const time = 1 + i * .18; sound.receive(frame(time), [contact({ time })]); }
  assert.equal(sources(), first);
  ctx.currentTime = .15; sound.receive(frame(2.5), [contact({ time: 2.5, impactEnergy: 15 })]);
  assert.equal(sources(), first + 1, 'a separated collision after a real gap is audible');
  ctx.currentTime = .3; sound.receive(frame(2.7), [contact({ time: 2.7, closingSpeed: 3, impactEnergy: 300 })]);
  assert.equal(sources(), first + 2, 'a new large collision on an existing support remains audible');
});

test('silence at rest allows a new collision even when the manifold remains connected', () => {
  const gate = new ContactSoundGate(); assert(gate.accepts(contact(), 1));
  assert.equal(gate.accepts(contact({ time: 1.1, closingSpeed: 0, impactEnergy: 0 }), 1.1), false);
  assert(gate.accepts(contact({ time: 1.3 }), 1.3));
});

test('small numeric support oscillations after quiet contacts do not restart percussion', () => {
  const gate = new ContactSoundGate(); assert(gate.accepts(contact(), 1));
  for (let i = 0; i < 15; i++) {
    const time = 1.2 + i * .2;
    assert.equal(gate.accepts(contact({ closingSpeed: 0, impactEnergy: 0 }), time), false);
    assert.equal(gate.accepts(contact({ closingSpeed: .1, impactEnergy: 2, impulse: 500 }), time + .08), false);
  }
  assert(gate.accepts(contact({ closingSpeed: 1, impactEnergy: 20 }), 4.4));
});

test('real chip bursts coalesce without mechanical fields until a gap or another source', () => {
  const gate = new ContactSoundGate(), chips = { type: 'debris', id: 'piece', material: 'steel', x: 12, y: 1, vx: -1, vy: 1.2, count: 3 };
  assert(gate.accepts(chips, 1));
  for (let i = 1; i <= 20; i++) assert.equal(gate.accepts(chips, 1 + i * .18), false);
  assert(gate.accepts({ ...chips, id: 'other' }, 4.7)); assert(gate.accepts(chips, 5.4));
  assert(gate.accepts({ ...chips, id: undefined }, 5.4));
  assert.equal(gate.accepts({ ...chips, id: undefined }, 5.5), false, 'anonymous visible chips still coalesce by position');
});

test('constant contact energy does not become a periodic drum', () => {
  const gate = new ContactSoundGate(), event = contact(); assert(gate.accepts(event, 1));
  for (let i = 1; i <= 12; i++) assert.equal(gate.accepts(event, 1 + i * .18), false);
  assert(gate.accepts({ ...event, closingSpeed: 3, impactEnergy: 180 }, 3.4));
});

test('contact pairs coalesce both owners while distinct pairs and projectile ground impacts stay independent', () => {
  const gate = new ContactSoundGate(); assert(gate.accepts(contact(), 1));
  assert.equal(gate.accepts(contact({ id: 'support' }), 1), false);
  assert(gate.accepts(contact({ contactPair: 'piece|other' }), 1));
  assert(gate.accepts({ type: 'ground', power: 90, x: 12, y: 0 }, 1)); assert(gate.accepts({ type: 'ground', power: 90, x: 12, y: 0 }, 1.01));
  assert.equal(gate.accepts({ ...contact({ closingSpeed: .01, impactEnergy: .001 }), type: 'ground' }, 1.2), false);
});

test('native terrain contacts retain their speed and gate decisions through the production codec', t => {
  const world = new World(createConstruction('scout')); t.after(() => world.dispose());
  world.command('setVehicleState', { state: { y: world.vehicle.y + 3 } });
  const contacts = [];
  for (let step = 0; step < 180; step++) {
    world.step();
    contacts.push(...world.drainEvents().filter(event => event.type === 'ground' && event.contactPair)
      .map(event => ({ ...event, time: event.time ?? world.time })));
  }
  assert(contacts.length > 0, 'a real three metre drop produces mechanical impacts');
  const remote = new FrameReader().decode(new FrameWriter().encode({ state: state(world.time), events: contacts.map(tellEvent) })).events,
    localGate = new ContactSoundGate(), remoteGate = new ContactSoundGate();
  assert.equal(remote.length, contacts.length);
  for (let i = 0; i < contacts.length; i++) {
    assert(Number.isFinite(remote[i].closingSpeed) && remote[i].closingSpeed > 0);
    assert.equal(remote[i].contactPair, contacts[i].contactPair);
    assert(Math.abs(remote[i].closingSpeed - contacts[i].closingSpeed) < contacts[i].closingSpeed * .0001);
    assert.equal(remoteGate.accepts(remote[i]), localGate.accepts(contacts[i]));
  }
});

test('contact and duplicate caches remain bounded under crowded scenes', async () => {
  const gate = new ContactSoundGate(8);
  for (let i = 0; i < 100; i++) gate.accepts(contact({ contactPair: 'piece|' + i, closingSpeed: 0, impactEnergy: 0 }), i);
  assert.equal(gate.contacts.size, 8);
  const { sound } = await setup();
  for (let i = 0; i < 600; i++) sound.receive(state(i / 60), [{ type: 'ground', x: 5000, y: 0, power: 90, time: i / 60 }]);
  assert.equal(sound.recentEvents.size, 512); assert.equal(sound.voices.length, 0);
});

test('the cues of the interface are recordings over the sound of the game: of no place, one after the other, silent when the game is, and none over the last', async () => {
  const { ctx, sound } = await setup(), cues = () => ctx.nodes.filter(n => n.kind === 'buffer' && n.buffer?.url.startsWith('alert-')),
    heard = () => cues().map(n => n.buffer.url), contact = SOUND_PROFILES[ALERTS.contact], grave = SOUND_PROFILES[ALERTS.grave];
  sound.alert('contact');
  const [first] = cues();
  assert.deepEqual(heard(), ['alert-contact.mp3']);
  assert.equal(first.buffer, sound.bank.get(ALERTS.contact));
  assert.deepEqual([first.starts, first.stops], [[0], [contact.duration]], 'heard whole');
  // Through the master and nothing that gives a sound its place: as loud wherever the camera is.
  assert(first.connections.length === 1 && first.connections[0].kind === 'gain' && first.connections[0].connections[0] === sound.alertBus);
  assert.equal(sound.alertBus.connections[0], sound.master.connections[0], 'alerts retain the shared output limiter');
  assert.equal(first.connections[0].gain.value, contact.level);
  // No other of its kind until a while has passed; another cue uses its own recording.
  sound.alert('contact'); assert.equal(cues().length, 1);
  sound.alert('grave'); assert.deepEqual(heard(), ['alert-contact.mp3', 'alert-grave.mp3']);
  ctx.advance(Math.max(contact.duration, grave.duration, ALERT_GAP) + .01); assert.equal(sound.voices.length, 0, 'over, its voice is given back');
  sound.alert('contact'); assert.equal(heard().at(-1), 'alert-contact.mp3');
  assert.equal(cues().at(-1).buffer, first.buffer, 'a later alert reuses the same recording');
  // Silent with the sound of the game: nothing on the screen to hear, or switched off. A cue that is none is nothing.
  ctx.advance(grave.duration + 3 * ALERT_GAP); sound.setActive(false); sound.alert('contact'); sound.setActive(true); sound.setEnabled(false); sound.alert('grave');
  sound.setEnabled(true); sound.alert('unknown'); assert.equal(cues().length, 3);
  sound.alert('grave'); assert.deepEqual(heard().at(-1), 'alert-grave.mp3');
  assert(cues().every(source => source.playbackRate.value === 1), 'alerts keep their original speed');
});
