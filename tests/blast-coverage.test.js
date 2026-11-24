import test from 'node:test';
import assert from 'node:assert/strict';
import {damageConstruction,face,interior} from './damage-fixtures.js';
import { weaponSettings } from '../src/weapons.ts';
import { managedWorld, advance } from './mechanical-queries.js';


test('an instantaneous heavy blast dents a broad local area without changing the rigid outline', t => {
  const b=damageConstruction({length:4,height:3,rideHeight:.5,frontThickness:80});
  const w = managedWorld(t, b), p = face(w);
  w.explode(9.8, 2, 410, 5.2, p.id); advance(w, 45);
  assert(p.dents.size >= 3, 'the real blast damages several face samples');
  assert([...p.dents.values()].some(d => Math.abs((d.u - .5) * p.definition.length) > .25 && d.depth > .0001),
    'plastic impressions extend beside the centre of a heavy blast');
  assert.equal(p.nodes.length, 4, 'surface dents preserve the rigid contact outline');
});

test('an exposed part of a component receives blast damage even when its closest point is hidden', t => {
  const b=damageConstruction({frontThickness:180,components:[interior('engine',{x:-.65,y:.2675})]}),w=managedWorld(t,b),
    origin={x:10.1,y:1.7},module=w.modules[0],whole=managedWorld(t,b);
  // The same blast against the whole wall: under a hundredth of its power reaches the engine.
  whole.explode(origin.x, origin.y, 410, 4, 'test'); advance(whole, 10);
  assert(module.maxHealth - whole.modules[0].health < 410 * .01);
  // The aperture lies below the straight line to the engine, whose nearest point stays behind the wall.
  w.cutBody(face(w),{x:10.3,y:1.42},{x:10.7,y:1.42},.17);
  assert.equal(w.index.raycast(origin,{x:module.x-module.width/2,y:origin.y},{ignoreIds:new Set([module.id])})?.owner.id,face(w).id);
  const before = module.health;
  w.explode(origin.x, origin.y, 410, 4, 'test'); advance(w, 10);
  assert(before - module.health > 100, 'an uncovered edge admits the instantaneous blast');
  assert.equal(module.health, 0);
});

test('large explosive rounds cause severe distant damage while small grenade rays keep a finite small dose', t => {
  const health = [];
  for (const [family, preset] of [['grenade', 'mk19'], ['howitzer', 'm119']]) {
    const b=damageConstruction({height:3,rideHeight:.3,components:[interior('engine',{x:.05,y:.6675})]});
    const w = managedWorld(t, b), config = weaponSettings(family, { preset, ammo: 'he' });
    for(const plate of w.plates)w.cutBody(plate,{x:plate.definition.x,y:plate.definition.y},{x:plate.definition.x,y:plate.definition.y},10);
    w.drainEvents();const initialHealth=w.modules[0].health;
    w.explode(8, 2, config.power, config.blastRadius, 'test');
    const atImpact = w.modules[0].health, events = w.drainEvents(),
      rays = events.filter(event => event.type === 'secondary-ray'&&!event.internal),
      secondaryDamage = events.filter(event => event.type === 'secondary-impact')
        .reduce((sum, event) => sum + event.damage, 0),
      rayBudget = rays.reduce((sum, ray) => sum + ray.energyBudget, 0);
    assert.equal(rays.length, 3);
    assert(rays.every(ray => ray.energySpent >= 0 && ray.energySpent <= ray.energyBudget + 1e-8));
    assert(rayBudget <= config.power * 200 * .1 * .5 + 1e-8, 'representative rays use the finite explosive energy allocation');
    if (preset === 'mk19') {
      assert(4 > config.blastRadius, 'the grenade fixture is beyond its direct blast radius');
      assert(Math.abs(initialHealth - atImpact - secondaryDamage) < 1e-9,
        'the small distant dose comes from real material rays, not unbounded radial damage');
      assert(secondaryDamage > 0 && secondaryDamage <= rayBudget / 200);
    }
    advance(w, 70);
    assert.equal(w.modules[0].health, atImpact, 'no delayed pressure state or persistent cloud adds damage');
    health.push(w.modules[0].health);
  }
  assert(health[0] > 105 && health[0] < 110); assert(health[1] < 60);
});
