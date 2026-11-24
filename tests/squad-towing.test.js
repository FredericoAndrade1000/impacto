import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { ARRIVAL } from '../src/squad.ts';
import { onField } from './helpers/field.js';

// Cold fixture placement only. All movement after coupling belongs to the
// ordinary Move command, native drivetrain and rated cable.
for (const heading of [-1, 1]) for (const gap of [-2, 2])
  test(`Move tows a disabled tracked chassis ${heading < 0 ? 'left' : 'right'} with ${gap < 0 ? 'crossed' : 'separated'} anchors and finishes`, { timeout: 60000 }, t => {
    const f = onField(t, rehearsal([0])), { room, world } = f, alice = room.join('Alice'),
      tug = f.publish(alice, 'truck', { facing: heading }), target = f.publish(alice, 'tracked', { facing: heading }),
      squad = room.players.get(alice.playerId).squad,
      span = id => world.plates.filter(p => p.actorId === id && p.definition.chassis?.part === 'frame')
        .reduce((a, p) => ({ lo: Math.min(a.lo, p.bounds.minX), hi: Math.max(a.hi, p.bounds.maxX) }), { lo: Infinity, hi: -Infinity });
    f.send(alice, 'auto', { actorId: tug, on: false });
    f.order(alice, 'control', { id: null });
    f.put(tug, heading * 250);
    const a = span(tug), b = span(target), offset = heading < 0 ? a.hi + gap - b.lo : a.lo - gap - b.hi;
    f.put(target, world.actor(target).vehicle.x + offset);
    const track = f.parts(target, 'track')[0];
    f.set(track, { health: 0 }); f.run(.2);
    assert(!room.outOfAction()[target], 'a disabled chassis remains repairable');
    f.send(alice, 'tow', { act: 'attach', actorId: tug, targetId: target });
    const cable = structuredClone(world.tows[0]), start = world.actor(target).vehicle.x,
      goal = world.actor(tug).vehicle.x + heading * 60, stock = structuredClone(room.faction(room.players.get(alice.playerId)).stock);
    assert.equal(Math.sign((cable.anchorA.x - cable.anchorB.x) * heading), Math.sign(gap), 'fixture exercises the intended initial anchor order');
    f.order(alice, 'move', { ids: [tug], x: goal });
    let peak = 0;
    for (let i = 0; i < 100 * 60 && squad.units.get(tug).move; i++) {
      room.step();
      assert.equal(world.tows.length, 1, `ordinary Move must keep its cable at step ${i}`);
      peak = Math.max(peak, world.tows[0].tension);
      assert.equal(world.actor(target).vehicle.throttle, 0);
      assert.equal(world.actor(target).vehicle.brake, 0);
    }
    assert.equal(squad.units.get(tug).move, null, 'a tow is an ordinary finite Move, not a road-machine work leg');
    assert(Math.abs(world.actor(tug).vehicle.x - goal) <= ARRIVAL,
      `the tug arrived: ${JSON.stringify({ goal, x: world.actor(tug).vehicle.x, targetX: world.actor(target).vehicle.x, unit: squad.view().units.find(u => u.id === tug), peak })}`);
    assert((world.actor(target).vehicle.x - start) * heading > 30, 'the disabled vehicle actually travelled behind it');
    assert.equal(track.health, 0, 'towing never repairs the damaged running gear');
    assert.deepEqual(room.faction(room.players.get(alice.playerId)).stock, stock, 'the cable does not pay or grant resources');
    assert.equal(world.dynamics.recoveries, 0); assert.deepEqual([...room.faults], []);
    t.diagnostic(JSON.stringify({ heading, gap, peakTensionN: peak, limitN: cable.limit }));
  });
