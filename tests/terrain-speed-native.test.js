import test from 'node:test';
import assert from 'node:assert/strict';
import { rehearsal } from '../server/room.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { travelSeconds } from '../src/terrain-speed.ts';

// Native world/6173/512 km. Normal publication and move orders; no pose, force,
// terrain or cargo injection. Off the asphalt of its base the ground is soil, gravel
// and rock: the truck goes over it as fast as it goes, and over the crests of the
// 1.3 km route as fast as they leave its weight on its wheels. Held to the speeds
// once planned for each ground, it took 106 s over either route; now it is there in
// no more than three fifths more time than the way is reckoned to take at the speed
// reckoned for its ground, the fastest any vehicle holds there. Its springs may let go
// of all its wheels for a moment over a crest or the stones of the rock, but nothing
// of it breaks, and it stays on its wheels.
const ROUTES = {
  crest: [-14552, -13252],
  straight: [-129552, -128856],
};
for (const [name, ends] of Object.entries(ROUTES)) for (const heading of [1, -1])
  test(`the native truck anticipates ${name} terrain in direction ${heading}, keeping its tyres and its useful speed`, { timeout: 60000 }, t => {
    const from = heading > 0 ? ends[0] : ends[1], goal = heading > 0 ? ends[1] : ends[0],
      room = rehearsal([from]), world = room.world; t.after(() => world.dispose());
    const player = room.join('Rota nativa'), id = room.publish(player.playerId, createStructuredTemplate('truck'), { x: from, facing: heading }).actor.id,
      owner = room.players.get(player.playerId), vehicle = world.actor(id).vehicle;
    for (let step = 0; step < 180; step++) room.step();
    const unit = owner.squad.units.get(id), planned = travelSeconds(world.terrain, from, goal, { top: vehicle.drivetrain.maxSpeed }),
      health = () => world.modules.filter(part => part.actorId === id).reduce((sum, part) => sum + (part.health || 0), 0), whole = health();
    room.command(player.playerId, { type: 'squad', order: 'move', ids: [id], x: goal });
    let steps = 0, airborne = 0, longest = 0, air = 0, fastest = 0;
    for (; steps < planned * 1.6 * 60 && unit.move; steps++) {
      if (steps % 60 === 0) room.command(player.playerId, { type: 'ping' });
      room.step();
      const contact = world.modules.some(part => part.actorId === id && ['wheel', 'track'].includes(part.kind) && part.groundContact);
      if (contact) air = 0; else { airborne++; longest = Math.max(longest, ++air); }
      fastest = Math.max(fastest, Math.abs(vehicle.vx));
      assert(Math.cos(vehicle.angle) > 0, 'the unmodified native truck remains upright');
    }
    assert.equal(unit.halt, ''); assert.equal(unit.move, null, 'the original move order reaches its place');
    assert(Math.abs(vehicle.x - goal) < 3 && Math.abs(vehicle.vx) < 1);
    assert(whole - health() < 1e-9, 'nothing of it breaks');
    assert(steps / 60 < planned * 1.6 && fastest > 85 / 3.6, `there in ${(steps / 60).toFixed(1)} s, reckoned at ${planned.toFixed(1)}`);
    if (name === 'crest') assert(airborne / 60 < 2 && longest / 60 < .6, 'a crest it is braked for lifts it off for a moment at the most');
    // Its hopper of the room of before, as deep across the body as its kind, stands 1.65 m tall instead of 1.35 m: over
    // the stones its weight, a little higher, lets its springs go of all its wheels for up to a third of a second.
    else assert(airborne / 60 < 3 && longest / 60 < .35, 'over the stones of the rock its springs let go of all its wheels for a moment at the most');
  });
