import test from 'node:test';
import assert from 'node:assert/strict';
import { World } from '../src/physics.ts';
import { emptyBlueprint } from './helpers/perception-scene.js';
import { gearChassis, engineBox } from './helpers/mechanics-source.js';
import { permanentParts, partsPreserved, physicsState, partPhysics } from '../scripts/review-harness.ts';

function chassis() {
  return gearChassis();
}
function managed(t, parkedOwner = null) {
  const w = new World(emptyBlueprint(), { visualEvents: false });
  t.after(() => w.dispose()); w.removeActor('local');
  w.addActor(chassis(), { id: 'driver', ownerId: 'blue', x: 8 });
  if (parkedOwner) w.addActor(chassis(), { id: 'parked', ownerId: parkedOwner, x: 13 });
  for (let i = 0; i < 60; i++) w.step();
  return w;
}
function crossContacts(w) {
  const actor = owner => w.game().objects.get(owner)?.actorId;
  return physicsState(w, { contacts: true }).contactStates.filter(pair => {
    const ids = [actor(pair.ownerA), actor(pair.ownerB)];
    return ids.includes('driver') && ids.includes('parked');
  }).length;
}

test('a rolling vehicle passes through allies, live enemies and wrecks without creating contact pairs', t => {
  const worlds = [managed(t), managed(t, 'blue'), managed(t, 'red'), managed(t, 'red')],
    [solo, ally, enemy, wreck] = worlds;
  wreck.actor('parked').defeated = 'command';
  wreck.controlVehicle(0, 0, 'parked');
  const contacts = worlds.map(() => 0);
  // The chassis has no engine: with the throttle held nothing pushes it and its brake is off, so it only rolls.
  for (const w of worlds) { w.game().call({ op: 'setVehicleState', actorId: 'driver', state: { vx: 8 } }); w.controlVehicle(1, 0, 'driver'); }
  for (let i = 0; i < 120; i++) for (const [j, w] of worlds.entries()) {
    w.step(); contacts[j] = Math.max(contacts[j], crossContacts(w));
  }
  const baseline = solo.actor('driver').vehicle;
  assert(baseline.x > 17, 'the test actually crosses the entire parked vehicle');
  for (const w of [ally, enemy, wreck]) {
    const v = w.actor('driver').vehicle;
    assert(Math.abs(v.x - baseline.x) < .002, JSON.stringify({ x: v.x, baseline: baseline.x }));
    assert(Math.abs(v.y - baseline.y) < .002); assert(Math.abs(v.vx - baseline.vx) < .002);
    assert(v.y < 2 && (w.dynamics.recoveries || 0) === 0, 'ground contact remains stable');
    assert(w.actor('parked').vehicle.x > 12.99 && w.actor('parked').vehicle.x < 13.01);
  }
  assert.deepEqual(contacts, [0, 0, 0, 0]);
});

test('defeating an overlapping enemy does not change passage or create a contact pair', t => {
  const w = managed(t, 'red'), driver = w.actor('driver').vehicle, parked = w.actor('parked');
  w.game().call({ op: 'control', actorId: 'parked', throttle: 0, brake: 0, enabled: false });
  w.game().call({ op: 'setVehicleState', actorId: 'driver', state: { x: parked.vehicle.x, vx: 0 } });
  for (let i = 0; i < 20; i++) { w.step(); assert.equal(crossContacts(w), 0); }
  parked.defeated = 'command'; w.controlVehicle(0, 0, 'parked');
  w.game().call({ op: 'setVehicleState', actorId: 'driver', state: { vx: 8 } }); w.controlVehicle(1, 0, 'driver');
  for (let i = 0; i < 100; i++) w.step();
  assert(driver.x > parked.vehicle.x + 3);
  assert.equal(crossContacts(w), 0); assert.equal(w.dynamics.recoveries || 0, 0);
});

test('damaged running gear retains carrier ownership, pass-through contacts and ground support', t => {
  const w = managed(t, 'blue'), wheel = w.modules.find(m => m.actorId === 'parked' && m.kind === 'wheel'),
    initial = permanentParts(w), body = partPhysics(w, wheel).body,
    contours = structuredClone(w.actor('parked').contactContours), mass = partPhysics(w, wheel).state.mass;
  assert(contours.length > 0 && contours.every(contour => contour.length >= 3));
  w.command('setVehicleState', { actorId: 'driver', state: { x: 13, vx: 0 } });
  w.command('setPartState', { owner: w.game().handle(wheel), state: { health: 0 } });
  for (let i = 0; i < 60; i++) { w.step(); assert.equal(crossContacts(w), 0); }
  assert(wheel.attached); assert.equal(wheel.health, 0); assert.equal(wheel.actorId, 'parked');
  assert.equal(partPhysics(w, wheel).body, body); assert.equal(partPhysics(w, wheel).state.mass, mass);
  assert(partsPreserved(w, initial)); assert.deepEqual(w.actor('parked').contactContours, contours);
  assert(wheel.groundContact && wheel.suspension.compression > 0, 'the disabled gear goes on carrying the hull on its spring');
  assert(w.actor('parked').vehicle.y < 2 && w.dynamics.recoveries === 0);
});

test('pass-through live actors remain material while a whole wreck remains observable and takes no weapon damage', t => {
  const b = engineBox();
  const w = new World(emptyBlueprint(), { visualEvents: false });
  t.after(() => w.dispose()); w.removeActor('local');
  w.addActor(b, { id: 'shooter', ownerId: 'blue', x: 0 });
  w.addActor(b, { id: 'ally', ownerId: 'blue', x: 10 });
  w.addActor(b, { id: 'wreck', ownerId: 'red', x: 20 }); w.actor('wreck').defeated = 'command';
  w.addActor(b, { id: 'enemy', ownerId: 'red', x: 30 });
  for (const id of ['ally', 'enemy', 'wreck']) {
    const target = w.modules.find(m => m.actorId === id), before = target.health;
    const ray = w.index.raycast({ x: target.x - .8, y: target.y }, { x: target.x + .8, y: target.y });
    assert.equal(ray.owner.object, target, 'generic material queries still retain observable and salvage geometry');
    w.explode(target.x - 1, target.y, 410, 4, 'manual-test');
    for (let i = 0; i < 12; i++) w.step();
    if (id === 'wreck') assert.equal(target.health, before, 'the full wreck takes no pressure or fragment damage');
    else assert(target.health < before, id + ' still receives the external blast');
  }
});
