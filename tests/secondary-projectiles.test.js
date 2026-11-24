import test from 'node:test';
import assert from 'node:assert/strict';
import { reviewSecondary } from '../scripts/probes-secondary.ts';
import { World } from '../src/physics.ts';
import {damageConstruction,interior} from './damage-fixtures.js';
const SECONDARY_ENERGY_PER_POWER = 200;

const rayBudget = row => {
  // A later reserve detonation owns another budget. The initial impact is the
  // only burst whose energy is attributable to this primary here.
  const rays=row.raysAtImpact,hits=row.hitsAtImpact;
  assert(rays.length > 0 && rays.length <= (row.casing || row.blast ? 6 : 3));
  assert(row.energyBudgetAtImpact > 0 && row.energyBudgetAtImpact <= row.rayEnergyLimit + 1e-4);
  assert(row.energySpentAtImpact >= 0 && row.energySpentAtImpact <= row.energyBudgetAtImpact + 1e-8);
  assert(rays.every(r => r.energySpent >= 0 && r.energySpent <= r.energyBudget + 1e-8));
  assert(hits.every(h => h.instantaneous && h.impulse === 0 &&
    h.power <= h.energy / SECONDARY_ENERGY_PER_POWER + 1e-8));
  assert.equal(row.emittedAtImpact, rays.length);
  assert.equal(row.peakPackets, 0); assert.equal(row.activePackets, 0);
  assert.equal(row.massPreserved, true); assert.equal(row.partsPreserved, true);
  if(!row.blast&&!row.casing){
    assert.equal(row.primaryHits.length,1,'the budget belongs to one real source-plate contact');
    const contact=row.primaryHits[0];
    assert(contact.energy>0&&contact.remaining>=0&&contact.remaining<contact.power);
    assert(row.consumedPrimaryEnergy>0&&row.consumedPrimaryEnergy<=contact.energy);
  }
};

for (const kind of ['engine', 'fuel', 'ammo', 'weapon', 'wheel', 'track'])
  test(`a finite M242 AP burst damages ${kind}, respects sufficient shielding and leaves no delayed cloud`, () => {
    const exposed = reviewSecondary({ kind,preset:'m242' }),
      shielded = reviewSecondary({ kind,preset:'m242',shield:20 });
    rayBudget(exposed); rayBudget(shielded);
    assert.equal(exposed.raysAtImpact.length,3);assert.equal(shielded.raysAtImpact.length,3);
    assert(shielded.raysAtImpact.every(r=>r.energyBudget/200<20*1.25),
      'the shield cost exceeds every incoming ray budget at this finite dose');
    assert.equal(exposed.secondaryShots,exposed.emittedAtImpact);
    assert.equal(exposed.secondaryDamage,exposed.secondaryDamageAtImpact);
    assert.equal(shielded.secondaryShots,shielded.emittedAtImpact);
    assert(exposed.hits.some(h => h.secondary && h.damage > 0));
    assert(exposed.hits.every(h => h.secondary && h.damage >= 0 && Number.isFinite(h.speed + h.energy)));
    assert(exposed.health > 0 && exposed.health < exposed.initialHealth, 'this sublethal catalogue burst must cause real damage rather than a visual-only hit');
    assert.equal(exposed.health, exposed.healthAfterImpact);
    assert.equal(shielded.health, shielded.initialHealth); assert.equal(shielded.hits.length, 0);
    assert.equal(exposed.explosions, 0); assert.equal(shielded.explosions, 0);
    assert(exposed.impactEvents >= exposed.hits.length, 'actual material intersections have contact cues');
  });

test('the three-ray cone disperses with distance without creating extra energy, mass or recursion', () => {
  const near = reviewSecondary({ gap: .1 }), far = reviewSecondary({ gap: 5 });
  rayBudget(near); rayBudget(far);
  assert(near.hits.length > far.hits.length && far.hits.length > 0);
  assert(near.initialHealth - near.health > far.initialHealth - far.health);
  assert.equal(near.rays.length, 3); assert.equal(far.rays.length, 3);
  assert.equal(near.energyBudget, far.energyBudget, 'moving the target cannot mint extra ray energy');
  assert.equal(near.explosions, 0); assert.equal(far.explosions, 0);
});

test('small calibre secondary shots retain their low damage and an intervening plate intercepts them', () => {
  const exposed = reviewSecondary({ preset: 'fnmag', thickness: 5 }), shielded = reviewSecondary({ preset: 'fnmag', thickness: 5, shield: 5 });
  rayBudget(exposed); rayBudget(shielded);
  assert(exposed.hits.length > 0); assert(exposed.health < exposed.initialHealth);
  assert(exposed.initialHealth - exposed.health < 1);
  assert.equal(shielded.health, shielded.initialHealth);
});

test('explosive casing rays have bounded energy and real contact damage without persistent packets', () => {
  const exposed = reviewSecondary({ casing: true }), covered = reviewSecondary({ casing: true, shield: 5 });
  rayBudget(exposed); rayBudget(covered);
  assert.equal(exposed.rays.length, 3); assert.equal(covered.rays.length, 3);
  assert(exposed.rays.every(r => !r.internal), 'this blast fixture isolates the external material rays');
  assert(exposed.hits.some(h => h.damage > 0));
  assert(exposed.secondaryDamage < 2);
  assert.equal(covered.secondaryDamage, 0, 'a five millimeter shield intercepts the low-energy rays');
  assert.equal(exposed.requestedExplosions, 1); assert.equal(covered.requestedExplosions, 1);
  assert.equal(exposed.explosions, 0); assert.equal(covered.explosions, 0);
  assert.equal(exposed.directHits.length,0,'the target is outside the direct explosion pulse');
  assert.equal(covered.directHits.length,0);
  assert(exposed.blastPoint.x<10.5-2.5&&covered.blastPoint.x<10.5-2.5);
});

for(const shield of [0,160])test(`authored turret demonstration isolates secondary contacts (${shield}mm spaced roof)`,()=>{
  const row=reviewSecondary({shield});assert.equal(row.directHits.length,0,'the primary ends before the target');
  assert(row.hits.every(e=>e.secondary&&e.instantaneous&&e.impulse===0));
  if(shield){assert.equal(row.hitsAtImpact.length,0);assert.equal(row.health,row.initialHealth);assert(row.collisions.includes(row.shieldId));}
  else{assert(row.hitsAtImpact.length>0);assert(row.health<row.initialHealth);}
});

test('secondary trajectories cannot reach a component outside the cone by radial damage', t => {
  const b=damageConstruction({height:5,frontThickness:50,components:[interior('engine',{x:-.05,y:2.6675})]});b.launcher={x:7,y:1.7};
  const w = new World(b); t.after(() => w.dispose());
  w.fire({ x: 10.5, y: 1.7 }, { id: 'cannon', preset: 'rh120', ammo: 'apfsds', spread: 0 }, true);
  for (let i = 0; i < 60; i++) w.step();
  assert(w.stats.secondaryShots > 0); assert.equal(w.modules[0].health, w.modules[0].maxHealth);
});

test('repeated impacts reuse the real aperture instead of spawning free extra spall', t => {
  const b=damageConstruction({frontThickness:50,components:[interior('engine',{x:-.05,y:-.0325})]});b.launcher={x:7,y:1.7};
  const w=new World(b);t.after(()=>w.dispose());const aim={x:10.5,y:1.7},weapon={id:'cannon',preset:'rh120',ammo:'apfsds',spread:0};
  w.fire(aim,weapon,true);for(let i=0;i<90;i++)w.step();
  const count = w.stats.secondaryShots, health = w.modules[0].health;
  for (let j = 0; j < 10; j++) { w.fire(aim,weapon,true); for (let i = 0; i < 30; i++) w.step(); }
  assert.equal(w.stats.secondaryShots, count); assert.equal(w.modules[0].health, health);
});
