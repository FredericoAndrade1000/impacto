import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {compileBlueprint,validateBlueprint} from '../src/persistence.ts';
import {assertMountProjection} from './helpers/weapon-mount-shape.js';
await initNativeDynamics();

test('a weapon integrated into armour names its real host and retains its finite curved material projection',()=>{
 const source=createConstruction('heavy'),dto=compileBlueprint(source),weapon=dto.modules.find(m=>m.kind==='weapon'),
  before=structuredClone(source);
 assertMountProjection(weapon);
 assert(dto.plates.some(p=>p.id===weapon.weaponMount.hostId));assert.equal(dto.mechanicalAdmission,true);
 assert.deepEqual(source,before);
});
test('narrowing the elevation sector preserves the shield metal and its admitted mass',()=>{
 const source=createConstruction('heavy'),broad=compileBlueprint(source).modules.find(m=>m.kind==='weapon'),
  restricted=structuredClone(source),record=restricted.components.find(m=>m.id===broad.id),
  mid=(record.mount.sector.min+record.mount.sector.max)/2;
 record.mount.sector={min:mid-.01,max:mid+.01};
 const narrow=compileBlueprint(restricted).modules.find(m=>m.id===broad.id);
 assertMountProjection(broad);assertMountProjection(narrow);
 assert.deepEqual([narrow.weaponMount.min,narrow.weaponMount.max],[mid-.01,mid+.01]);
 assert.notDeepEqual([narrow.weaponMount.min,narrow.weaponMount.max],[broad.weaponMount.min,broad.weaponMount.max]);
 assert.deepEqual(narrow.weaponMount.shield,broad.weaponMount.shield);
 assert.deepEqual(narrow.materialPolygons,broad.materialPolygons);
 for(const key of ['physicalMass','physicalInertia','physicalCenterLocal'])assert.deepEqual(narrow[key],broad[key],key);
 const[narrowPort,broadPort]=[narrow,broad].map(gun=>gun.weaponMount.walls[0].port);
 assert(narrowPort.lo>=broadPort.lo);assert(narrowPort.hi<=broadPort.hi);
});
test('author cannot inject several support chains or change derived mount geometry',()=>{
 const source=createConstruction('heavy'),weapon=source.components.find(m=>m.kind==='weapon');
 for(const field of ['mountId','mountIds','mountGeometry','weaponMount','materialPolygons']){
  const broken=structuredClone(source);broken.components.find(m=>m.id===weapon.id)[field]=[];
  assert.throws(()=>validateBlueprint(broken),field);
 }
});
