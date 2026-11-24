import test from 'node:test';
import assert from 'node:assert/strict';
import { World, FIXED_DT } from '../src/physics.ts';
import {damageWorld,face} from './damage-fixtures.js';
import {createConstruction} from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import { firingSolution } from '../src/ballistics.ts';
import { predictImpact } from '../src/impact-preview.ts';
import { referenceScenario, applyReferenceScene } from '../src/scenarios.ts';
import { assessArtilleryVehicle } from '../scripts/probes-impact.ts';
import { localToWorld } from '../src/math.ts';
import { dent, materialState } from './mechanical-queries.js';
import { vehicleRoof } from '../src/scenarios.ts';

for (const distance of [120, 250]) test(`105 mm grazing roof contact at ${distance} m predicts the actual panel and point`, t => {
  const w = new World(createConstruction('heavy')); t.after(() => w.dispose());
  // The hull comes to rest on its springs first: a forecast is of a target that stands still.
  for (let i = 0; i < 60; i++) w.step(); w.drainEvents(); w.setTestDistance(distance);
  // On its full charge the round flies flat this close and still rises where the roof is, 3.5 m up on the chassis: it
  // meets the turret only at its top front corner, whose wall turns on the hundredths of a millimetre the settled hull
  // leans. On its first charge the low arc comes down over that corner and grazes the roof: on the roof itself, a
  // millimetre or more from either end of it, where it and the wall it meets are one corner.
  const config = weaponSettings('howitzer', { preset: 'm119', ammo: 'he', spread: 0, charge: .08, trajectory: 'low' }),roof=vehicleRoof(w),
    [a,b]=[0,1].map(u=>roof.materialPosition({u,v:.5})),length=Math.hypot(b.x-a.x,b.y-a.y),
    along=p=>((p.x-a.x)*(b.x-a.x)+(p.y-a.y)*(b.y-a.y))/length,
    exposed=[.65,.55,.6,.7,.75,.85,.9,.95,.05,.1,.2,.3].map(u=>{
      const aim=roof.materialPosition({u,v:.5}),solution=firingSolution(w.launcher(config),aim,config),
        prediction=predictImpact(w.snapshot(),solution,config);
      return {aim,solution,prediction};
    }).find(candidate=>candidate.prediction?.owner.id===roof.id && along(candidate.prediction)>.001 && along(candidate.prediction)<length-.001);
  assert(exposed,'a real trajectory must clear the current raised sensors and reach the selected roof');
  const {aim,solution,prediction}=exposed;
  assert(prediction); assert.equal(prediction.owner.id, roof.id);
  // Asked for the whole life of the round instead of the flight to the aim, the forecast is the same contact.
  const whole = predictImpact(w.snapshot(), { ...solution, time: config.life }, config), fired = w.time;
  assert(w.fire(aim, config, true));
  let blast;
  for (let i = 0; i < Math.ceil(solution.time * 60) + 10 && !blast; i++) {
    w.step(); blast = w.drainEvents().find(e => e.type === 'explosion' && e.preset === 'm119');
  }
  assert(blast);
  for (const forecast of [prediction, whole]) {
    assert.equal(forecast.owner.id, blast.source);
    assert(Math.hypot(forecast.x - blast.x, forecast.y - blast.y) < 5e-5, 'a grazing contact is where a forecast a few millimetres off lands a hand away');
    assert(Math.abs(forecast.time - (blast.time - fired)) < 1e-6);
  }
});

// A live round travels one straight chord per simulation step and strikes where that chord does. The forecast
// traces the same chords: walked in longer ones, it hung under the arc and struck this wall 6 mm low.
for (const distance of [30, 120, 250]) test(`105 mm forecast at ${distance} m strikes a plain wall where the round does, asked to the aim or for its whole life`, t => {
  const w = damageWorld(t, { frontThickness: 200 });
  for (let i = 0; i < 30; i++) w.step(); w.drainEvents(); w.setTestDistance(distance);
  const config = weaponSettings('howitzer', { preset: 'm119', ammo: 'he', spread: 0, trajectory: 'low' }), aim = { x: 10.5, y: 1.7 },
    solution = firingSolution(w.launcher(config), aim, config), state = w.snapshot(), fired = w.time,
    forecasts = [predictImpact(state, solution, config), predictImpact(state, { ...solution, time: config.life }, config)];
  assert(w.fire(aim, config, true));
  let blast;
  for (let i = 0; i < Math.ceil(solution.time * 60) + 10 && !blast; i++) {
    w.step(); blast = w.drainEvents().find(e => e.type === 'explosion' && e.preset === 'm119');
  }
  assert(blast); assert.equal(blast.source, face(w).id);
  for (const forecast of forecasts) {
    assert.equal(forecast.owner.id, blast.source);
    assert(Math.hypot(forecast.x - blast.x, forecast.y - blast.y) < 1e-5, `${Math.hypot(forecast.x - blast.x, forecast.y - blast.y) * 1000} mm`);
    assert(Math.abs(forecast.time - (blast.time - fired)) < 1e-6);
  }
});

test('a forecast reports nothing beyond the point it was asked to reach, however long the step of the round', t => {
  const w = damageWorld(t, { frontThickness: 200 });
  for (let i = 0; i < 30; i++) w.step(); w.drainEvents(); w.setTestDistance(60);
  // A 120 mm round covers twenty-seven metres in one step: the wall is in the same step as an aim half a metre short of it.
  const config = weaponSettings('cannon', { preset: 'rh120', ammo: 'ap', spread: 0 }), launcher = w.launcher(config), state = w.snapshot(),
    short = firingSolution(launcher, { x: 9.9, y: 1.7 }, config), forecast = solution => predictImpact(state, solution, config);
  const wall = forecast(firingSolution(launcher, { x: 10.5, y: 1.7 }, config));
  assert.equal(wall.owner.id, face(w).id); assert(Math.abs(wall.x - 10.4) < 1e-9);
  assert.equal(Math.floor(short.time / FIXED_DT), Math.floor(wall.time / FIXED_DT), 'the aim and the wall lie on the same chord of the flight');
  assert.equal(forecast(short), null);
  // A hair past the face of the wall, the same contact.
  const past = forecast(firingSolution(launcher, { x: 10.41, y: 1.7 }, config));
  assert(Math.hypot(past.x - wall.x, past.y - wall.y) < 1e-9); assert(Math.abs(past.time - wall.time) < 1e-12);
});

test('a long high arc is forecast as exactly as a short flat shot', () => {
  // More than twenty seconds of flight: walked several steps at a time, and traced step by step only near the vehicle.
  const r = assessArtilleryVehicle({ preset: 'm119', trajectory: 'high', distance: 250, target: 'roof' });
  assert.deepEqual(r.failures, []); assert(r.predictions[0].intendedFlightS > 512 / 60);
  assert(r.agreement[0].ownerMatches && r.agreement[0].positionError < 1e-4 && r.agreement[0].timeError < 1e-6);
});

// On a low arc: a blast on the ground does what it does whatever arc the round came on, and a high one flies many
// seconds longer (its flight is the forecast test above).
test('105 mm ground blast damages exposed track and attenuates with distance without launching the chassis', () => {
  const trajectory = 'low', r = assessArtilleryVehicle({ preset: 'm119', distance: 60, trajectory, target: 'near-miss' });
  assert.deepEqual(r.failures, []);
  const forecast = r.predictions[0], bounds = forecast.missBounds;
  assert(bounds.hullMinX < bounds.gearMinX, 'the current hull projects beyond the track');
  assert.equal(bounds.minX,Math.min(bounds.hullMinX,bounds.moduleMinX), 'the miss includes the actual projected weapon and gear solids');
  assert(forecast.aim.x < bounds.minX - r.caliberMm / 2000,
    'the intended ground contact lies outside hull and all installed solids, including the shell radius');
  assert(r.blasts[0].x < bounds.minX, 'the observed blast occurs outside every installed solid, including the weapon');
  assert.equal(r.blasts[0].source, 'ground'); assert.equal(r.blasts[0].detonation, 'impact');
  assert(r.peaks.lift < .02 && r.peaks.speed < .3);
  assert(r.modules.find(m => m.kind === 'track').health < .5,
    'a miss outside the projecting barrel still causes substantial track damage');
  assert(r.modules.filter(m => ['engine', 'ammo', 'fuel'].includes(m.kind)).every(m => m.health > .95));
  assert(r.plates.every(p => p.attached)); assert(r.restored && r.unchanged);
  const far = assessArtilleryVehicle({ preset: 'm119', distance: 60, trajectory, target: 'far-miss' });
  assert.deepEqual(far.failures, []); assert.equal(far.blasts[0].source, 'ground');
  assert(far.modules.every(m => m.health > .99), 'outside the blast radius, installed components remain intact');
  assert(far.peaks.lift < .02 && far.peaks.speed < .3); assert(far.restored && far.unchanged);
});

test('native visual dents preserve the welded patch and independent ballistic thickness', t => {
  const w=damageWorld(t,{length:2,height:2,rideHeight:1,thicknesses:{floor:100}}),plate=face(w,'floor'),definition=plate.definition,
    original = n => localToWorld(definition, (n.u - .5) * definition.length,
      (.5 - n.v) * definition.thicknessMm / 1000),
    anchors = plate.definition.anchors;
  const mass = materialState(w, plate).mass;
  assert(dent(w, plate, { x: 11, y: .95 }, .026, .3));
  for(const node of plate.nodes) {
    const rest=original(node);assert(Math.hypot(node.x-rest.x,node.y-rest.y)<1e-9);
  }
  assert(plate.attached && anchors.length>0);assert(plate.dents.size>0);
  assert.equal(materialState(w, plate, {x:11,y:.95}).resistanceScale, 1);
  assert.equal(materialState(w, plate, {x:12,y:.95}).resistanceScale, 1);
  assert.equal(materialState(w, plate).mass, mass, 'a surface dent removes no material or rigid mass');
});

for (const id of ['artillery-mortar', 'artillery-howitzer']) test(`${id}: reference fires a catalogue round from its own range into the complete vehicle`, t => {
  const scene = referenceScenario(id), w = new World(scene.blueprint); t.after(() => w.dispose());
  w.setTestDistance(250); applyReferenceScene(w, scene);
  assert.equal(w.testDistance, 60);
  // Complete: what the design writes, the frame and the nose of its tracked chassis, and the track under them.
  assert.equal(w.plates.length,scene.blueprint.plates.length+3);
  assert.equal(w.modules.length,scene.blueprint.components.length+1);
  const solution = firingSolution(w.launcher(scene.weapon), scene.aim, scene.weapon), events = [];
  for (let i = 0; i < Math.ceil(solution.time * 60) + 80; i++) { w.step(); events.push(...w.drainEvents()); }
  const shell = events.filter(e => e.type === 'explosion' && e.preset === scene.weapon.preset);
  assert.equal(shell.length, 1); assert(w.plates.some(p => p.id === shell[0].source));
  assert.equal(shell[0].power, scene.weapon.power); assert.equal(shell[0].radius, scene.weapon.blastRadius);
});

test('three mortar rounds retain finite, local damage and reproduce with the same seed', () => {
  const config = { preset: 'm252', distance: 60, target: 'roof', salvos: 3, aftermath: 3 },
    a = assessArtilleryVehicle(config), b = assessArtilleryVehicle(config);
  assert.deepEqual(a.failures, []); assert.deepEqual(b.failures, []);
  assert.equal(a.blasts.length, 3); assert.equal(a.stats.shots, 3);
  assert.deepEqual(a.peaks, b.peaks); assert.deepEqual(a.modules, b.modules);
  assert(a.plates.every(p => p.attached && (1-p.integrity)*p.length < .55),
    'local material loss stays below a 55 cm opening, including the shorter turret roof');
});
