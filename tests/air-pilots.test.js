import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { gunship } from './helpers/aircraft.js';
import { defence, strike } from './helpers/air-trials.js';

await initNativeDynamics();

// The pilots by rules against aircraft and of aircraft, on the field of the game with its fog, as scripts/probes-air.ts
// measures them (tests/helpers/air-trials.js): each trial is the field stepped as it is, the same every time.

test('a camera hung under an aircraft sees out between its skids, as its rounds fly between them', () => {
  const eye = compileStructuredConstruction(gunship({ eye: true })).sights.find(sight => sight.id === 'eye');
  assert(eye.range > 0 && eye.left > 0 && eye.right > 0, `it sees out to ${eye.left} and ${eye.right} m`);
  // Only its own hull over it hides anything from it: the ground under it is in sight.
  assert(eye.hidden.every(([from, to]) => from >= 0 && to <= Math.PI + 1e-9), JSON.stringify(eye.hidden));
});

test('a machine gun on a post over a roof brings down a drone that crosses it at 60 m/s 100 m up', { timeout: 120000 }, () => {
  const run = defence({ shooter: 'skywatch', height: 100, speed: 60 });
  assert(run.hits >= 20 && run.hits / run.shots > .25, `${run.hits} of ${run.shots} struck`);
  assert(run.killed !== null, `still flying after ${run.time} s: ${JSON.stringify(run.reasons)}`);
});

test('the gun of a tank does not rise to a drone 300 m up 250 m off, and says so', { timeout: 120000 }, () => {
  const run = defence({ shooter: 'heavy', height: 300, seconds: 10 });
  assert.equal(run.shots, 0);
  assert(run.reasons['no-ballistic-solution'] > 80, JSON.stringify(run.reasons));
});

test('high explosive set to burst by a crossing drone brings it down within seconds', { timeout: 120000 }, () => {
  const run = defence({ shooter: 'bunker-he', height: 100, speed: 60, seconds: 20 });
  assert(run.killed !== null && run.killed < 8, `brought down at ${run.killed} s, ${run.hits} of ${run.shots}`);
});

test('a gunship sent to attack a lorry it has a shot at stays where it is and fires', { timeout: 180000 }, () => {
  const run = strike({ target: 'truck', seconds: 30 });
  assert(run.first !== null && run.first < 5 && run.defeated !== null, `${run.hits} of ${run.shots}, the first at ${run.first} s, out at ${run.defeated} s`);
  // The lorry shows no gun: it never leaves the place it was sent to attack from.
  assert(!Object.keys(run.activity).some(what => what.startsWith('moving')), JSON.stringify(run.activity));
  assert(Math.abs(run.ahead - 600) < 2 && Math.abs(run.height - 60) < 2, `${run.ahead} m before it, ${run.height} m up`);
});

test('a gunship in the sector of the gun of a tank climbs out of it above the 20° it rises to, firing on the way, unless it puts the tank out of the fight first', { timeout: 180000 }, () => {
  const steps = [], run = strike({ target: 'heavy', seconds: 60, trace: step => steps.push(step) });
  assert(run.first !== null && run.first < 5 && run.hits > 30, `${run.hits} of ${run.shots}, the first at ${run.first} s`);
  assert.equal(run.killed, null, `brought down at ${run.killed} s`);
  assert(steps.some(step => step.leg?.purpose === 'strike'), 'it goes for a place to fire from');
  assert(steps.some(step => step.height > 200), JSON.stringify(steps.at(-1)));
  assert(run.defeated !== null || steps.some(step => Math.atan2(step.height, step.ahead) > 28 * Math.PI / 180), JSON.stringify(steps.at(-1)));
  assert(run.lowest >= 6, `${run.lowest} m over the ground`);
});

test('a gunship with its target behind it turns about in the air to have it under its gun, and puts it out of the fight from where it was', { timeout: 180000 }, () => {
  const steps = [], run = strike({ target: 'guard-post', distance: -600, seconds: 90, trace: step => steps.push(step) });
  assert(run.first !== null && run.first < 6 && run.ahead > 0, `the first at ${run.first} s, ${run.ahead} m before it`);
  assert(run.defeated !== null, `${run.hits} of ${run.shots}`);
  // It faced the other way within seconds, and never flew over to the other side of the target for it.
  assert(steps[0].facing === steps[0].side && steps.some(step => step.t < 5 && step.facing === -steps[0].facing), JSON.stringify(steps.slice(0, 6)));
  assert(steps.every(step => step.side === steps[0].side), JSON.stringify(steps.find(step => step.side !== steps[0].side)));
});

test('a gunship that fired all its rounds goes to land where it is filled up', { timeout: 180000 }, () => {
  const run = strike({ target: 'heavy', seconds: 30, rounds: 30 });
  assert.equal(run.rounds, 0);
  assert.equal(run.landing, 'ammo', JSON.stringify(run.activity));
});
