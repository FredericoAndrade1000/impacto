import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { rehearsal } from '../server/room.ts';
import { bill } from '../src/economy.ts';
import { onField } from './helpers/field.js';

await initNativeDynamics();
// Road machines at work on the slopes of the field's own ground (server/supply-dispatch.ts, src/squad.ts `paced`): about a
// base at 29000, 29150–29210 is soil falling 10 to 12 % to the east; about one at −9300, −8955…−8885 is rock and then soil
// falling 8 to 37 % to the west.
const plenty = bill(1e9, 1e9, 1e9, 1e9), mean = list => list.length ? list.reduce((sum, x) => sum + x, 0) / list.length : 0,
  rms = list => Math.sqrt(mean(list.map(x => x * x)));

// A machine of a template sent to make a road from where it is put (`from`), and how it went along the road at every step it
// worked it at the pace of its tools: how often the share of its brakes jumped by a quarter of them or more in a step, how
// often it stood still half a second with a pace to go at and its lane not done, how hard it was shaken along its way (its
// acceleration, as a root mean square), how far off its pace it rolled from three seconds after it took it up, and how
// fast its wheels slipped.
function along(t, { base, x0, x1, design, kind, from, graded = false }) {
  const room = rehearsal([base, base > 0 ? -30000 : 30000], plenty, { fog: false }), f = onField(t, room), world = room.world,
    player = room.join('Estradeira'), id = f.publish(player, design), squad = room.players.get(player.playerId).squad;
  f.run(1);
  if (graded) room.pave(x0, x1, 'graded');
  f.put(id, from);
  f.send(player, 'road', { x0, x1, kind });
  const shaken = [], off = [];
  let work = 0, jumps = 0, stops = 0, still = 0, slip = 0, was = null, share = null, leg = null, since = 0;
  const done = f.until(() => {
    const v = world.actor(id).vehicle, job = room.supplyDispatch.jobs.get(id), move = squad.units.get(id)?.move,
      accel = was === null ? 0 : (v.vx - was) * 60;
    was = v.vx;
    if (job?.phase !== 'work' || !move || move !== job.leg) { share = null; still = 0; return !room.roadworks.pending.size; }
    work += 1 / 60; shaken.push(accel); slip = Math.max(slip, Math.abs(v.slip || 0));
    // Nothing asked of its brakes, a vehicle with its throttle let go stands on all of them (game_motion.rs).
    const braked = v.brake > 0 ? v.brake : v.throttle === 0 ? 1 : 0, left = (job.lane.to - job.front) * job.lane.dir, pace = move.pace;
    if (share !== null && Math.abs(braked - share) > .25) jumps++;
    share = braked;
    if (Math.abs(v.vx) < .05 && left >= .6) { still += 1 / 60; if (pace > 0 && still >= .5 && still - 1 / 60 < .5) stops++; } else still = 0;
    if (move !== leg || !(pace > 0)) { leg = move; since = world.time; }
    if (pace > 0 && left > 1.6 && world.time - since > 3) off.push(v.vx * job.lane.dir - pace);
    return !room.roadworks.pending.size;
  }, 400);
  return { done, work, jumps: jumps / work, stops, shaken: rms(shaken), off: rms(off), slip };
}

for (const [name, kase] of [
  ['a grader down the slope', { base: 29000, x0: 29150, x1: 29210, design: 'grader', kind: 'graded', from: 29130 }],
  ['a grader up it', { base: 29000, x0: 29150, x1: 29210, design: 'grader', kind: 'graded', from: 29235 }],
  ['a paver down it', { base: 29000, x0: 29150, x1: 29210, design: 'paver', kind: 'asphalt', from: 29130, graded: true }],
  ['a paver up it', { base: 29000, x0: 29150, x1: 29210, design: 'paver', kind: 'asphalt', from: 29235, graded: true }],
  ['a grader down the steep one', { base: -9300, x0: -8955, x1: -8885, design: 'grader', kind: 'graded', from: -8975 }],
]) test(`${name} goes at the pace of its tools on as much of its brakes as the slope asks: no jumping on them and off, no stop, no slip`, t => {
  const went = along(t, kase), said = JSON.stringify(went);
  assert(went.done && went.work > 30, `the road is made: ${said}`);
  assert(went.jumps < .2, `its brakes jumped ${went.jumps.toFixed(2)} times a second: ${said}`);
  assert.equal(went.stops, 0, `it stood with its pace to go at: ${said}`);
  assert(went.shaken < .3, `shaken at ${went.shaken.toFixed(2)} m/s²: ${said}`);
  assert(went.off < .06, `${went.off.toFixed(3)} m/s off its pace: ${said}`);
  assert(went.slip < .05, `its wheels slipped at ${went.slip.toFixed(2)} m/s: ${said}`);
});
