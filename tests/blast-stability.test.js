import test from 'node:test';
import assert from 'node:assert/strict';
import {damageConstruction,face,interior} from './damage-fixtures.js';
import {createConstruction} from '../src/construction-templates.ts';
import { weaponSettings } from '../src/weapons.ts';
import {salvoCase} from '../scripts/probes-impact.ts';
import {blastCase} from '../scripts/probes-blast.ts';
import { physics, ownerState, impulse, flyRound, managedWorld, advance } from './mechanical-queries.js';

const materialMass = w => physics(w).bodyStates.reduce((s, body) => s + body.mass, 0);

for (const [target, thickness, seed] of [['roof', 20, 6173], ['front', 20, 9031], ['roof', null, 9031]])
  test(`repeated 25 mm ${target} hits stay bounded after adjacent cuts (${thickness || 'stock'} mm, seed ${seed})`, () => {
    const result = salvoCase({ target, thickness, seed, count: 36 });
    assert.equal(result.stats.shots, 36);
    assert(result.stats.impacts >= 20, 'the salvo actually contacts the moving damaged vehicle');
    assert.equal(result.anomaly, null);
    assert(result.peaks.dentLimitRatio <= 1 + 1e-6, 'permanent local indentation stays within the material limit');
    assert(result.peaks.y < 1.5 && result.peaks.speed < 2, 'cuts do not catapult the chassis');
    assert(Number.isFinite(result.peaks.kineticJ) && result.peaks.kineticJ < 100000,
      'resting debris cannot create a runaway contact-energy cascade');
  });

test('rejected native requests preserve loaded momentum, visible geometry and material mass', t => {
  // Internal solver-energy rollback is exercised with typed Rapier bodies in
  // solver_tests.rs. The public boundary also rejects invalid input atomically.
  const world = managedWorld(t, createConstruction('heavy')), plate = face(world,'roof'),
    before = ownerState(world, plate).state,
    geometry = world.plates.map(p => p.nodes.map(n => ({ ...n.local }))), original = materialMass(world);
  impulse(world, plate, plate.definition, { x: 120, y: -30 });
  const loaded = physics(world), body = ownerState(world, plate).state;
  assert(Math.abs(before.mass * (body.vx - before.vx) - 120) < .002);
  assert(Math.abs(before.mass * (body.vy - before.vy) + 30) < .002);
  assert.throws(() => world.step(NaN), /fixed step/);
  assert.throws(() => world.step(Infinity), /fixed step/);
  assert.throws(() => world.dynamics.core.load_game('{'), /EOF|key/);
  assert.deepEqual(physics(world), loaded, 'rejection does not advance or replace the loaded world');
  assert.deepEqual(world.plates.map(p => p.nodes.map(n => n.local)), geometry);
  assert.equal(materialMass(world), original);
  advance(world, 1); assert(Number.isFinite(world.vehicle.x + world.vehicle.y));
});


test('blast damages exposed mechanisms while intact thick armour shields the same internal engine', t => {
  const hp = [];
  for (const thickness of [0, 20, 180]) {
    const b=damageConstruction({length:4,height:3,rideHeight:.5,frontThickness:thickness||5,components:[interior('engine',{x:-.65,y:.5675})]});
    const w=managedWorld(t,b);if(!thickness)w.cutBody(face(w),{x:9.8,y:2},{x:10.2,y:2},1.4); w.explode(9.88, 2, 410, 5.2, 'test'); advance(w, 80);
    hp.push(w.modules[0].health);
    if (thickness === 180) {
      assert.equal(face(w).integrity, 1);
      assert([...face(w).dents.values()].some(d => d.depth > 0.005),
        'protected components do not prevent a visible local armour dent');
    }
  }
  assert.equal(hp[0], 0); assert(hp[1] > 0 && hp[1] < 75); assert(hp[2] > 100);
});

test('a nearby blast opens thin metal locally without deleting its remaining width or mass', t => {
  const b=damageConstruction({length:4,height:3,rideHeight:.5,frontThickness:20});
  const w = managedWorld(t, b), plate = face(w), original = materialMass(w);
  w.explode(9.88, 2, 410, 5.2, plate.id); advance(w, 70);
  assert(plate.integrity > 0.8 && plate.integrity < 0.99);
  assert(w.stats.secondaryShots > 0);
  assert(Math.abs(materialMass(w) - original) < 1e-7);
  const spans = plate.solidSpans();
  assert(spans.some(s => s.lo === 0 && s.hi < .5) && spans.some(s => s.lo > .5 && s.hi === 1));
  assert(spans[0].hi > .4 && spans.at(-1).lo < .6, 'material loss stays local to the blast');
  assert.equal(plate.nodes.length, 4, 'surface damage preserves the contact outline');
});

test('a real aperture admits blast exposure that an intact wall blocks', t => {
  const b=damageConstruction({length:4,height:3,rideHeight:.5,frontThickness:180,components:[interior('engine',{x:-.65,y:.5675})]});
  // What the pulse of one blast in front of the wall takes from the engine behind it, apart from the
  // fragments that the same blast throws through an opening.
  const pulse = radius => {
    const w = managedWorld(t, b), plate = face(w), engine = w.modules[0], game = w.game();
    if (radius) game.call({ op: 'cut', owner: game.handle(plate), start: { x: 9.8, y: 2 }, end: { x: 10.2, y: 2 }, radius });
    w.drainEvents(); w.explode(9, 2, 100, 3);
    const fragments = w.drainEvents().filter(e => e.type === 'secondary-impact' && e.id === engine.id)
      .reduce((sum, e) => sum + e.damage, 0);
    assert(engine.health > 0, 'the engine is left alive, so that what it lost is all that reached it');
    return engine.maxHealth - engine.health - fragments;
  };
  const shielded = pulse(0), admitted = pulse(.04), open = pulse(1.4);
  assert(admitted > 0 && shielded < 0.01 * admitted);
  assert.equal(admitted, open, 'a narrow hole in line with the engine admits the whole pulse, as a wall cut wide open does');
});

test('internal blasts disable mechanisms and secondary detonations occur only once per component', () => {
  const result = blastCase({ location: 'internal', seconds: 3 });
  assert.equal(result.modules.find(m => m.kind === 'engine').fraction, 0);
  assert.equal(result.modules.find(m => m.kind === 'ammo').fraction, 0);
  assert.equal(result.stats.explosions, 2, 'the initiating blast and ammunition detonate; fuel burns');
  assert(result.peaks.y < 1.5);
  assert(result.peaks.dentLimitRatio <= 1 + 1e-6);
});

test('a real roof aperture stays clear and permits a weaker round to hit the mounted receiver',t=>{
  const w=managedWorld(t,createConstruction('heavy')),gun=w.modules.find(m=>m.kind==='weapon'),
    roof=w.plates.find(p=>p.id===gun.weaponMount.hostId.replace(/:[^:]+$/, ':roof')),
    uv=roof.materialUV({x:gun.x+gun.width/2,y:roof.definition.y}),point=roof.materialPosition(uv),
    config=weaponSettings('autocannon',{preset:'m242',ammo:'ap',spread:0}),
    primary={...config,x:point.x,y:point.y+.3,vx:0,vy:-config.speed,age:0,visited:new Set()};
  // The primary ends a decimetre under the roof, short of the receiver: a round is not ended while it is
  // still leaving a plate, and the hull heaves a few millimetres on its springs in the step that flies it.
  flyRound(w,primary,(.4+roof.definition.thicknessMm/2000)/config.speed);
  const a={x:point.x,y:point.y+.2},z={x:point.x,y:point.y-.2};
  assert.equal(w.index.raycast(a,z),null,'actual AP opens the admitted roof grid');
  assert.equal(w.projectiles.length,0);
  const health=gun.health;assert(health>0,'the opening proof leaves a live receiver for the next contact');w.drainEvents();
  const weak=weaponSettings('machinegun',{preset:'fnmag',ammo:'ap',spread:0}),
    follow={...weak,x:point.x,y:point.y+.3,vx:0,vy:-weak.speed,age:0,visited:new Set()};
  flyRound(w,follow,(point.y+.3-gun.y+gun.height)/weak.speed);
  assert(gun.health<health);assert(w.drainEvents().some(e=>e.type==='module'&&e.id===gun.id));
  assert.equal(w.index.raycast(a,z),null,'no simulated chip replaces the real opening');
});
