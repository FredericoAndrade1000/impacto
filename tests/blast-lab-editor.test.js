import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics} from '../src/native-dynamics.ts';
import {World} from '../src/physics.ts';
import {Editor} from '../src/editor.ts';
import {createConstruction} from '../src/construction-templates.ts';
import {labConstruction} from '../src/lab-constructions.ts';
import {DESIGN_VERSION,compileBlueprint,parseBlueprint,serializeBlueprint,validateBlueprint} from '../src/persistence.ts';
import {referenceScenario,applyReferenceScene,angledJointBlueprint} from '../src/scenarios.ts';
import {componentPolygons} from '../src/assembly.ts';
import {weaponSettings} from '../src/weapons.ts';
import {FramePresentation} from '../src/presentation.ts';
import {physics,managedWorld} from './mechanical-queries.js';
import {shotCount} from '../src/shots.ts';
await initNativeDynamics();
const plateFixture=(thickness=125)=>labConstruction({thicknessMm:thickness});

test('construction picks the native exposed barrel without editing the closed document',()=>{
 const editor=new Editor(createConstruction('heavy')),gun=editor.blueprint.modules.find(m=>m.kind==='weapon'),
  poly=componentPolygons(gun)[1],point={x:poly.reduce((n,p)=>n+p.x,0)/poly.length,y:poly.reduce((n,p)=>n+p.y,0)/poly.length},
  before=structuredClone(editor.source);
 assert.equal(editor.pick(point,.01),gun.id);assert.deepEqual(editor.source,before);assert.equal(editor.past.length,0);
});
for(const snap of [false,true])test(`laboratory numeric plate edits preserve physical geometry and undo with grid assistance ${snap?'on':'off'}`,()=>{
 const source=validateBlueprint(plateFixture()),editor=new Editor(source);editor.snap=snap;editor.select('hull:front');
 const plate=()=>editor.blueprint.plates.find(plate=>plate.id==='hull:front'),before=plate(),near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-12,`${actual} != ${expected}`);
 for(const key of ['x','y'])assert.throws(()=>editor.editProperty(key,1,true), /arrastando nós e chapas/);
 assert.throws(()=>{editor.selected.x+=1;},TypeError);assert.deepEqual(editor.source,source);
 editor.editProperty('length',1.813,true);
 near(plate().length,1.813);near(plate().x,before.x);near(plate().y,before.y);near(plate().angle,before.angle);
 assert.equal(Object.hasOwn(editor.source.plates.find(plate=>plate.id==='hull:front'),'length'),false,'length remains derived from the authored endpoints');
 assert(editor.undo());assert.deepEqual(editor.source,source);editor.select('hull:front');
 editor.editProperty('angle',.3,true);
 // Numeric rotation keeps the physical plate and its centre even when the optional grid is enabled.
 near(plate().angle,.3);near(plate().length,before.length);near(plate().x,before.x);near(plate().y,before.y);
 assert.deepEqual(editor.source.plates.filter(plate=>plate.id!=='hull:front'),source.plates.filter(plate=>plate.id!=='hull:front'));
 for(const node of source.nodes)assert.deepEqual(editor.source.nodes.find(point=>point.id===node.id),node);
 assert.equal(editor.past.length,1);
 assert.deepEqual(parseBlueprint(serializeBlueprint(editor.source)),editor.source);
 assert(editor.undo());assert.deepEqual(editor.source,source);
});
test('a local opening reaches the next real hull wall while the contour and admitted mass stay fixed',t=>{
 const world=managedWorld(t,plateFixture(100)),front=world.plates.find(p=>p.definition.id==='hull:front'),
  before=physics(world).bodyStates[0],contour=structuredClone(world.snapshot().actors[0].contactContours),point={x:front.definition.x,y:front.definition.y};
 assert(contour.length>0&&contour.every(polygon=>polygon.length>=3));
 const integrity=front.integrity;assert(world.cutBody(front,point,point,.08).length);
 assert(front.integrity<integrity&&front.integrity>0);
 assert.equal(physics(world).bodyStates[0].mass,before.mass);assert.equal(physics(world).bodyStates[0].inertia,before.inertia);
 assert.deepEqual(world.snapshot().actors[0].contactContours,contour);
});
test('an angled assay is one closed authored frame with two real frontal plate thicknesses',()=>{
 const source=angledJointBlueprint(100),dto=compileBlueprint(source);
 assert.equal(source.version,DESIGN_VERSION);assert.equal(source.nodes.length,5);assert.equal(source.plates.length,5);assert.equal(dto.rooms.length,1);
 for(const id of ['upper-front','lower-front'])assert.equal(dto.plates.find(p=>p.id==='hull:'+id).thicknessMm,100);
 for(const derived of ['modules','rooms','frame'])assert(!Object.hasOwn(source,derived));assert.deepEqual(parseBlueprint(serializeBlueprint(source)),validateBlueprint(source));
});
test('static explosion scenarios retain finite rigid geometry and real damage without mechanical pressure',t=>{
 for(const id of ['blast-contact','blast-distance','blast-closed','blast-open']){
  const scene=referenceScenario(id),world=managedWorld(t,scene.blueprint),before=physics(world).bodyStates[0];
  applyReferenceScene(world,scene);world.step();const snapshot=world.snapshot(),body=physics(world).bodyStates[0];
  assert(world.stats.explosions>0);assert(Number.isFinite(body.x+body.y+body.angle+body.mass+body.inertia));
  assert.equal(body.mass,before.mass);assert.equal(body.inertia,before.inertia);
  assert(world.plates.every(p=>p.integrity>=0&&p.integrity<=1));
  assert(world.plates.every(p=>p.nodes.every(n=>Number.isFinite(n.x+n.y))));
 }
});
test('a stopped fast projectile is visible until contact, then damage and effects appear together', t => {
  const b = plateFixture(125), w = managedWorld(t, b), config = weaponSettings('autocannon', { preset: 'rh202', spread: 0 }), playback = new FramePresentation();
  w.fire({ x: 12, y: 1.7 }, config, true); const before = w.snapshot(); playback.receive(before, w.drainEvents(), { now: 0 });
  w.step(); const after = w.snapshot(), events = w.drainEvents(), blocked = events.find(e => e.type === 'blocked');
  assert(blocked.time > 0 && blocked.time < 1 / 60); assert.equal(shotCount(after.shots), 0);
  playback.receive(after, events, { now: 0 }); const at = blocked.time * 1000, consumed = [];
  const prior = playback.sample(at - 0.001); assert.equal(prior.state, before);
  const visible = playback.shotsAt(prior.time); assert.equal(visible.length, 1); assert(visible[0].x <= blocked.x);
  playback.advance(prior.time, () => {}, e => consumed.push(e)); assert(!consumed.some(e => e.type === 'blocked'));
  const contact = playback.sample(at + 0.001); assert.equal(contact.state, after);
  playback.advance(contact.time, () => {}, e => consumed.push(e)); assert.equal(consumed.filter(e => e.type === 'blocked').length, 1);
  assert.equal(playback.shotsAt(contact.time).length, 0);
  playback.advance(contact.time, () => {}, e => consumed.push(e)); assert.equal(consumed.filter(e => e.type === 'blocked').length, 1);
});
test('ordinary motion interpolates, paused stepping is immediate and resetting never replays old effects', () => {
  const p = new FramePresentation(), a = { time: 0, tick: 0 }, b = { time: 1 / 60, tick: 1 };
  p.receive(a, [], { now: 0 }); p.receive(b, [], { now: 0 });
  const middle = p.sample(8); assert.equal(middle.state, b); assert(middle.alpha > 0.4 && middle.alpha < 0.6);
  p.receive({ time: 2 / 60, tick: 2 }, [{ type: 'explosion', time: 0.025 }], { now: 100, paused: true });
  assert.equal(p.sample(100).alpha, 1); const events = []; p.advance(2 / 60, () => {}, e => events.push(e)); assert.equal(events.length, 1);
  p.receive(a, [], { now: 200, paused: true }); p.advance(0, () => {}, e => events.push(e)); assert.equal(events.length, 1); assert.equal(p.paths.length, 0);
});

