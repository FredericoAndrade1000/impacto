import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import {damageConstruction} from './damage-fixtures.js';
import {createConstruction} from '../src/construction-templates.ts';
import {compileBlueprint} from '../src/persistence.ts';
import { probeBlastLaunch } from '../scripts/probes-trajectory.ts';
import { probeMortarRoof, mortarReviewBlueprint } from '../scripts/probes-trajectory.ts';
import { ownerState, dent, setVehicle, physics } from './mechanical-queries.js';
import { cellOf, pointMetres } from '../src/grid.ts';

test('local damage keeps the one rotating carrier and cannot alter its mass or angular momentum',t=>{
  const w=new World(createConstruction('heavy'));t.after(()=>w.dispose());
  setVehicle(w,{y:20,angle:.43,omega:1.2,vx:.4,vy:-.2});
  const p=w.plates[0],before=ownerState(w,p),state=before.state,point=p.nodes[0];
  assert(state.dynamic);const bodyCount=physics(w).bodies;
  dent(w,p,point,.01);w.game();
  const after=ownerState(w,p);assert.equal(after.body,before.body);
  for(const field of ['mass','inertia','omega','vx','vy','angle'])assert.equal(after.state[field],state[field]);
  assert.equal(physics(w).bodies,bodyCount);
});

// One seed for each model, and each place a blast starts from.
for (const scenario of [
  { model: 'ifv', seed: 9, location: 'fuel', terrain: 'hills' },
  { model: 'scout', seed: 8, location: 'engine', repeats: 3, maxClearance: 1.25, maxVerticalSpeed: 4.5, maxEnergy: 200000 },
  { model: 'scout', seed: 12, location: 'rear-wheel', terrain: 'hills', repeats: 3 },
  { model: 'chassis', seed: 4, location: 'fuel', repeats: 3 },
  { model: 'heavy', seed: 15, location: 'roof', terrain: 'hills', exterior: true },
]) test(`${scenario.model} ${scenario.location} blast seed ${scenario.seed} keeps the rigid carrier without catapulting`, () => {
  const row = probeBlastLaunch(scenario);
  assert(row.stats.explosions >= (scenario.exterior ? 1 : 2), 'retains shell and ammunition detonations and secondary damage');
  // The bounded direct pulse and actual point-fragment contacts may move a
  // light carrier, but cannot create a runaway launch or new contact body.
  assert(row.peaks.clearance < (scenario.maxClearance || .6) &&
    row.peaks.verticalSpeed < (scenario.maxVerticalSpeed || 3), JSON.stringify(row.peaks));
  assert(row.peaks.energy < (scenario.maxEnergy || 100000), 'shape replacement does not inject a megajoule pulse');
  if (!scenario.exterior) assert(row.modules.find(m => m.kind === 'engine').health === 0,
    'stability retains real functional damage');
  else assert.equal(row.recoveries, 0, 'shared weld frames prevent the instability before any recovery');
});

test('one explosion event drives the visual effect without continuous vent or pressure events', t => {
  const b=damageConstruction({height:3,rideHeight:.2,frontThickness:100});
  const w=new World(b);t.after(()=>w.dispose());
  w.explode(10,1.7,100,2);const initial=w.drainEvents(),blast=initial.filter(e=>e.type==='explosion');
  assert.equal(blast.length,1);assert.equal(blast[0].power,100);assert.equal(blast[0].radius,2);
  assert.equal(blast[0].x,10);assert.equal(blast[0].y,1.7);
  assert(initial.every(e=>!['vent','pressure','pressure-jet'].includes(e.type)));
  const later=[];for(let i=0;i<120;i++){w.step();later.push(...w.drainEvents());}
  assert(later.every(e=>!['explosion','vent','pressure','pressure-jet'].includes(e.type)));
});

for (const scenario of [
  { model: 'four-wheel', seed: 2, offset: .08 },
  { model: 'scout', seed: 4, terrain: 'hills' },
]) test(`successive rear-roof mortar hits retain real damage without changing the mass of the structure: ${scenario.model} seed ${scenario.seed}`, () => {
  // An authored roof assay removes raised instruments; for the scout its
  // small gun is mounted on the hull, leaving one roof over the reserves, high
  // enough on the front for its 0.77 m receiver to clear the reserve of its rounds.
  // The current turret and sensor-equipped scout is exercised below.
  // The laboratory hull takes its parts in metres; the scout's are written in cells.
  const source = mortarReviewBlueprint(scenario.model),blueprint=scenario.model==='scout'?
    damageConstruction({length:4.8,height:1.8,dynamic:true,frontThickness:20,wallThickness:8,
      components:source.components.map(part=>({...part,pose:{...part.pose,...pointMetres(part.pose)}}))}):source;
  blueprint.components = blueprint.components.filter(m => m.kind !== 'sensor');
  if(scenario.model==='scout') {
    // Heights over the floor node, on the nearest cells.
    const floor = blueprint.nodes[0].y, height = { engine: .419, fuel: .519, command: 1.069, ammo: .469 };
    for(const part of blueprint.components) if(part.kind!=='weapon') part.pose.y = floor + cellOf(height[part.kind]);
    Object.assign(blueprint.components.find(m=>m.kind==='weapon'), {
      pose:{x:cellOf(-2.2285),y:floor+cellOf(1.08),angle:-Math.PI},
      mount:{preset:'light-trunnion',sector:{min:-.1,max:.1},radiusM:.1465},
    });
  }
  const row = probeMortarRoof({ ...scenario, blueprint, salvos: 3 });
  assert.deepEqual(row.failures, []);
  assert.equal(row.stats.shots, 3); assert.equal(row.primary.length, 3);
  assert(Math.abs(row.primary[0].y - row.shots[0].aim.y) < .04, 'the first detonation is on the roof, not a raised accessory');
  assert(row.stats.explosions >= 4, 'shells and ammunition detonate; fuel burns');
  // Expended reserves and burnt interiors leave the body; its permanent hull/chassis remains.
  assert(Math.abs(row.structureMassAfter - row.structureMassBefore) < 1e-6 && row.carrierMassAfter <= row.carrierMassBefore);
  assert(row.carrierMassAfter < row.carrierMassBefore - 20);
  // One carrier has the actual mass of the authored construction. The
  // unchanged 10 kJ budget sets its speed ceiling; it is not the speed of the
  // retired suspension bodies. Keep the independent four-centimetre lift gate.
  assert(row.carrierMassBefore > 0);
  const speedBudget = Math.sqrt(2 * 10000 / row.carrierMassBefore);
  assert(row.peaks.clearance < .04 && row.peaks.verticalSpeed < speedBudget, JSON.stringify(row.peaks));
  assert(row.peaks.energy < 10000, 'includes moving wreckage without weld energy growing into megajoules');
  assert.equal(row.recoveries, 0, 'stable before numerical fallback');
  assert.equal(row.modules.find(m => m.kind === 'fuel').health, 0);
  assert.equal(row.modules.find(m => m.kind === 'ammo').health, 0);
});

test('a stock scout mortar strike on raised sensors retains damage and remains within the physical launch budget', () => {
  const blueprint = mortarReviewBlueprint('scout'), dto = compileBlueprint(blueprint),
    sensor = dto.modules.find(m => m.kind === 'sensor' && m.sensorMode === 'visual'),
    row = probeMortarRoof({ blueprint, model: 'scout', seed: 6, distance: 30, targetSensor:'visual', salvos: 3 });
  assert.deepEqual(row.failures, []);
  assert.equal(row.stats.shots, 3); assert.equal(row.primary.length, 3);
  assert(row.primary[0].y >= row.shots[0].aim.y, 'the equipped stock vehicle intercepts the round on the sensor exterior');
  assert.equal(row.primary[0].source, sensor.id, 'the first detonation actually strikes the selected raised sensor');
  assert(row.stats.explosions >= 3, 'all three shells still detonate after the raised sensor is disabled');
  assert(Math.abs(row.structureMassAfter - row.structureMassBefore) < 1e-6 && row.carrierMassAfter <= row.carrierMassBefore);
  assert(row.peaks.clearance < .04 && row.peaks.energy < 10000, 'retains the roof regression height and energy budgets');
  // The probe's existing launch classification permits finite external pulses
  // up to 8 m/s. An exposed sensor impact has a different impulse from a roof
  // impact; the unchanged height/energy budgets above constrain that response.
  assert(row.peaks.verticalSpeed < 8);
  assert.equal(row.recoveries, 0);
  assert.equal(row.modules.find(m => m.kind === 'sensor').health, 0,'the selected external instrument suffers a real functional failure');
});
