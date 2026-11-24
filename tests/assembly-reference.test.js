import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {compileBlueprint} from '../src/persistence.ts';
import {World} from '../src/physics.ts';
await initNativeDynamics();

test('the compiled assembly and live frame retain the same part IDs and documental attachments',t=>{
 const source=createConstruction('heavy'),dto=compileBlueprint(source),world=new World(source);t.after(()=>world.dispose());
 const frame=world.snapshot(),ids=new Set([...dto.plates,...dto.modules].map(p=>p.id));
 assert([...frame.plates,...frame.modules].every(p=>ids.has(p.definition?.id||p.id)));
 assert.equal(dto.mechanicalAdmission,true);
});
test('damage does not detach the documented hull or change admitted carrier mass and inertia',t=>{
 const world=new World(createConstruction('heavy'));t.after(()=>world.dispose());
 const query=()=>world.game().call({op:'physics'}),before=query().bodyStates[0],plate=world.plates[0];
 world.cutBody(plate,{x:plate.definition.x-.1,y:plate.definition.y},{x:plate.definition.x+.1,y:plate.definition.y},.03);
 const after=query().bodyStates[0];
 assert.equal(after.mass,before.mass);assert.equal(after.inertia,before.inertia);
 assert(world.plates.every(p=>p.attached!==false));
});


