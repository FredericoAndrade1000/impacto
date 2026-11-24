// Read-only capture diagnostic on an in-memory field. No live server/save is
// opened. --expect-grounded verifies the published Native support and capture rule.
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { gunship } from '../tests/helpers/aircraft.js';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { decodePhysicsState } from './review-physics.ts';
import type { Post } from '../server/room-contract.ts';

const room = rehearsal([0, 12000], undefined, { fog: false });
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const stateOf = (id: string) => { const state = room.players.get(id); assert(state); return state; };
try {
  const attacker = room.join('Atacante'), owner = room.join('Dono');
  const holder = room.faction(stateOf(owner.playerId)); assert(holder.base);
  let post: Post | null | undefined = null;
  for (let distance = 2000; distance <= 4000 && !post; distance += 7) {
    try {
      stateOf(owner.playerId).builtAt = -Infinity;
      const answer: unknown = room.command(owner.playerId, { type: 'post', x: holder.base.x + distance, facing: 1, instant: true });
      const postId = recordValue(answer) && recordValue(answer.post) ? answer.post.id : undefined;
      post = holder.posts.find(p => p.id === postId);
    } catch (error) { if (distance + 7 > 4000) throw error; }
  }
  assert(post, 'Find a valid post through the real command');
  const capturePost = post, published = room.publish(attacker.playerId, gunship()); assert('actor' in published);
  const id = published.actor.id, world = room.world;
  const vehicle = () => { const value = world.actor(id)?.vehicle; assert(value); return value; };
  const place = () => world.command('setVehicleState', { actorId: id, state: { x: capturePost.x,
    y: world.terrain.height(capturePost.x) + 300, vx: 0, vy: 0, angle: 0, omega: 0 } });
  // Set only the initial test position/hover, then let the Native physics and
  // normal capture clock run with finite initial fuel and no further positioning.
  place(); world.command('control', { actorId: id, throttle: 0, brake: 0, rise: 1 });
  for (let i = 0; i < 12; i++) world.step();
  world.command('control', { actorId: id, throttle: 0, brake: 0, rise: 0 }); place();
  room.command(attacker.playerId, { type: 'squad', order: 'control', id });
  const start = world.time;
  let capturedAt: number | null = null, unsupportedCounted = false, lowestAltitude = Infinity;
  for (let i = 0; i < 125 * 60; i++) {
    if (i % 30 === 0) room.command(attacker.playerId, { type: 'drive', throttle: 0, brake: 0, rise: 0 });
    room.step({ pace: () => 1 });
    const v = vehicle();
    lowestAltitude = Math.min(lowestAltitude, v.y - world.terrain.height(v.x));
    if (capturePost.capture?.by === stateOf(attacker.playerId).factionId) unsupportedCounted = true;
    if (room.faction(stateOf(attacker.playerId)).posts.includes(capturePost)) { capturedAt = world.time - start; break; }
  }
  const v = vehicle(), core: unknown = world.dynamics?.core;
  assert(recordValue(core) && typeof core.current_frame === 'function', 'Native diagnostics require the actual current_frame binding');
  const encoded: unknown = core.current_frame(); assert(typeof encoded === 'string');
  const frame: unknown = JSON.parse(encoded); assert(recordValue(frame) && Array.isArray(frame.actors));
  const actors: readonly unknown[] = frame.actors, native = actors.find(a => recordValue(a) && a.id === id);
  assert(recordValue(native) && recordValue(native.vehicle), 'The Native frame must contain the audited actor vehicle');
  const handles = new Set([...world.plates, ...world.modules].filter(p => p.actorId === id).map(p => world.game().handle(p)));
  const physics = decodePhysicsState(world.game().call({ op: 'physics', contacts: true }));
  assert(physics.contactStates, 'The explicit contact query must publish its contact states');
  const contacts = physics.contactStates;
  const groundContacts = contacts.filter(c => handles.has(c.ownerA) && !c.ownerB || handles.has(c.ownerB) && !c.ownerA).length;
  const airborneCapture = capturedAt !== null && v.flying && v.y - world.terrain.height(v.x) > 290 && groundContacts === 0;
  const runtime = nativeRuntimeInfo('native');
  assert(runtime.runtime === 'native');
  console.log(JSON.stringify({ scope: 'In-memory real125s capture clock, one initial hover placement, no progress shortcut, refill or body freeze',
    runtime: { sourceSHA256: runtime.sourceSHA256, binarySHA256: runtime.binarySHA256 },
    capturedAt, airborneCapture, unsupportedCounted, lowestAltitude, altitude: v.y - world.terrain.height(v.x), flying: v.flying, groundContacts,
    groundedPublished: Object.hasOwn(native.vehicle, 'grounded'), fuelLitres: v.fuelLitres,
    faults: room.faults.size,
    rule: 'Native support applies equally to capture/contest; landed aircraft and moving grounded vehicles remain eligible.' }, null, 2));
  if (process.argv.includes('--expect-grounded')) {
    assert(Object.hasOwn(native.vehicle, 'grounded'), 'Native support must be published before asserting the rule');
    assert(lowestAltitude > 290 && groundContacts === 0, 'The negative control must stay unsupported');
    assert.equal(unsupportedCounted, false, 'Unsupported presence still counted for capture');
    assert.equal(airborneCapture, false, 'An unsupported aircraft still captured a post');
  }
} finally { room.field.dispose(); }
