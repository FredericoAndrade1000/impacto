import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {compileBlueprint,serializeBlueprint,parseBlueprint} from '../src/persistence.ts';
import {assertMountProjection} from './helpers/weapon-mount-shape.js';
import {metresOf} from '../src/grid.ts';
await initNativeDynamics();

for(const template of ['heavy','scout','ifv'])test(template+': frontal mechanism is internal and barrel is generated through its host wall',()=>{
 const source=createConstruction(template),dto=compileBlueprint(source),gun=dto.modules.find(m=>m.kind==='weapon'),
  front=dto.plates.find(p=>p.id===gun.weaponMount.hostId),record=source.components.find(p=>p.id===gun.id);
 assert.equal(Object.hasOwn(record.mount,'hostId'),false);
 // The pose is written in cells; the gun stands on the field in metres.
 assert.deepEqual([gun.x,gun.y,gun.angle],[metresOf(record.pose.x)+12,metresOf(record.pose.y)+1.3,record.pose.angle]);
 assert.equal(front.id,'turret:front');
 assert(front);assertMountProjection(gun);assert.equal(gun.weaponMount.exposed,false);
 assert.equal(gun.weaponMount.hostId,front.id);
 assert.deepEqual(gun.weaponMount.walls.map(w=>w.wallId),[front.id]);assert(gun.weaponMount.walls[0].port.lo<gun.weaponMount.walls[0].port.hi);
 assert.equal(dto.mechanicalAdmission,true);
 assert.deepEqual(parseBlueprint(serializeBlueprint(source)),source);
});

test('removing an optional host keeps the gun pose, sector and physical mechanism unchanged',()=>{
 const source=createConstruction('heavy'),before=compileBlueprint(source).modules.find(m=>m.kind==='weapon'),
  open={...source,plates:source.plates.filter(p=>p.id!==before.weaponMount.hostId)},
  kept=structuredClone(open),after=compileBlueprint(open).modules.find(m=>m.id===before.id);
 assert.deepEqual(open,kept);
 for(const key of ['x','y','angle','physicalMass','physicalInertia','physicalCenterLocal','materialPolygons'])assert.deepEqual(after[key],before[key],key);
 assert.deepEqual([after.weaponMount.min,after.weaponMount.max],[before.weaponMount.min,before.weaponMount.max]);
 assert.deepEqual(after.weaponMount.shield,before.weaponMount.shield);
 assert.equal(after.weaponMount.hostId,null);assert.equal(after.weaponMount.hostOwner,0);
 assert.deepEqual(after.weaponMount.walls,[]);
 assertMountProjection(after);
});
