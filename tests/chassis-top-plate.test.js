import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileDraft } from '../src/structured-construction.ts';
import { withChassisTopMaterial, withChassisTopThickness, withChassisPoint, withChassisSuspension, CHASSIS_ID } from '../src/chassis-editing.ts';
import { withPieceProperty } from '../src/structured-editing.ts';
import { pieceSettings, topPlateChoices, applySettings } from '../src/piece-settings.ts';
import { MATERIALS } from '../src/materials.ts';
import { Editor } from '../src/editor.ts';
import { constructionCost, piecesCost } from '../src/construction-cost.ts';
import { createCompartmentFromPlate } from '../src/workshop-ux.ts';
import { workshopActions } from '../src/workshop-actions.ts';
import { CELL } from '../src/grid.ts';

test('the chassis floor closes real compartments, without a second authored floor, and opens them again when removed', () => {
  const editor=new Editor(withChassisTopMaterial(bare(),'steel')),
    span=editor.plateSpans().find(p=>p.id==='chassis:top-0');
  assert(span);assert.equal(editor.pick({x:(span.a.x+span.b.x)/2,y:span.a.y},.001),span.id);
  editor.select(span.id);
  assert.equal(workshopActions({source:editor.source,blueprint:editor.blueprint,spans:editor.plateSpans()},[span.id]).grow.available,true);
  const made=createCompartmentFromPlate(editor,span.id);assert(made);
  assert.equal(editor.source.plates.length,3,'the chassis floor itself is the fourth wall');
  assert.equal(editor.blueprint.rooms.length,1);
  assert(editor.blueprint.rooms[0].walls.some(w=>w.id===span.id));
  const origin=editor.blueprint.frame.origin;
  for(const end of [made.polygon[0],made.polygon.at(-1)]){
    assert(Math.abs(end.y-span.a.y)<1e-12&&end.x>=Math.min(span.a.x,span.b.x)&&end.x<=Math.max(span.a.x,span.b.x));
    assert(editor.source.nodes.some(node=>Math.hypot(origin.x+node.x*CELL-end.x,origin.y+node.y*CELL-end.y)<1e-12),
      'the authored walls meet the exact fractional ends of the offered floor stretch');
  }
  const middle={x:(span.a.x+span.b.x)/2,y:span.a.y+.3};
  editor.addModule('command',middle);
  assert(!editor.blueprint.modules.find(m=>m.kind==='command').exposed);
  editor.select(span.id);editor.commit();editor.editProperty('thicknessMm',10,true);
  assert.equal(editor.source.chassis.topPlate.thicknessMm,10);
  assert.equal(editor.blueprint.rooms.length,1);
  assert(!pieceSettings(editor.selected).some(s=>s.key==='angle'),'profile controls the floor orientation');
  editor.remove();
  assert.equal(editor.source.chassis.topPlate,undefined);assert.equal(editor.blueprint.rooms.length,0);
  assert(editor.blueprint.modules.find(m=>m.kind==='command').exposed);
  editor.undo();assert.equal(editor.blueprint.rooms.length,1);
  const reopened=new Editor(JSON.parse(JSON.stringify(editor.source)));
  assert.equal(reopened.blueprint.rooms.length,1);
  assert.equal(reopened.source.plates.length,3);
  assert(!reopened.blueprint.modules.find(m=>m.kind==='command').exposed);
  for(const [i,point] of editor.source.chassis.points.entries()){
    const node=editor.blueprint.frame.nodes.find(n=>n.id===`chassis:top-point-${i}`),
      deck=editor.blueprint.frame.origin.y+point.y*CELL;
    assert(Math.abs(node.y-editor.source.chassis.topPlate.thicknessMm/2000-deck)<1e-12,
      'the generated armour lower face follows the actual chassis deck after undo and reopen');
  }
});

await initNativeDynamics();
const top = made => made.compiled.plates.filter(plate => plate.id.startsWith('chassis:top-'));
const close = (a, b) => assert(Math.abs(a-b)<1e-7, `${a} != ${b}`);
const bare = () => {
  const source = createConstruction('chassis');
  delete source.chassis.topPlate; source.chassis.axles = [-35, 35];
  return { ...source, nodes: [], plates: [], components: [] };
};

test('factory floor edits preserve equipment and still refuse real component and breech overlap', () => {
  for (const id of ['heavy','recon']) {
    const source = createConstruction(id), original = structuredClone(source);
    for (const thickness of [5,Math.min(20,source.chassis.topPlate.thicknessMm)]) {
      const made = compileDraft(withChassisTopThickness(withChassisTopMaterial(source,'steel'),thickness));
      assert(top(made).length > 0, `${id}: ${thickness} mm`);
      assert.deepEqual(made.construction.plates,source.plates);
      assert.deepEqual(made.construction.components,source.components);
    }
    assert.deepEqual(source,original);
  }
  // Test the same 20 mm recoil envelope without another piece on the floor masking a breech refusal first.
  const gunOnly=preset=>{const source=createConstruction('howitzer',{preset});
    source.components=source.components.filter(part=>part.kind==='weapon');return source;};
  const m777=compileDraft(withChassisTopThickness(withChassisTopMaterial(gunOnly('m777'),'steel'),20));
  assert(top(m777).length>0,'the M777 cut-off recoil clears this real layer after exact factory placement');
  const howitzer=gunOnly('m119');
  assert.throws(()=>compileDraft(withChassisTopThickness(withChassisTopMaterial(howitzer,'steel'),20)),
    error=>error.reason==='BREECH_PLATE'&&error.ids.includes('chassis:top-0'),
    'extra armour still respects the gun breech throughout its allowed arc');
  // Isolate the actual hopper for this thickness edit: the factory's other floor-mounted pieces stay unmodified.
  const truck=createConstruction('truck');truck.components=truck.components.filter(part=>part.id==='hopper');
  const original=structuredClone(truck), plain=compileDraft(truck).compiled,
    hopper=plain.modules.find(part=>part.id==='hopper'), initial=truck.chassis.topPlate.thicknessMm;
  close(hopper.y-hopper.height/2,plain.chassis.deck+initial/1000);
  for(const thickness of [initial+5,initial+20,100]){
    const bottom=hopper.y-hopper.height/2;
    assert(bottom>=plain.chassis.deck&&bottom<plain.chassis.deck+thickness/1000,
      `the hopper really occupies the proposed ${thickness} mm layer`);
    assert.throws(()=>compileDraft(withChassisTopThickness(withChassisTopMaterial(truck,'steel'),thickness)),
      error=>error.reason==='COMPONENT_PLATE'&&error.ids.includes('chassis:top-0')&&error.ids.includes('hopper'),
      'top armour cannot occupy existing equipment or silently move it');
  }
  assert.deepEqual(truck,original,'a refused layer does not move the existing equipment');
  const cleared=structuredClone(truck), lifted=cleared.components.find(part=>part.id==='hopper');
  const lift=(20-initial)/1000;lifted.pose.y+=lift/CELL;
  const made=compileDraft(withChassisTopThickness(withChassisTopMaterial(cleared,'steel'),20));
  assert(top(made).length>0);
  const raised=made.compiled.modules.find(part=>part.id==='hopper');
  close(raised.y-hopper.y,lift);
  close(raised.y-raised.height/2,plain.chassis.deck+.02);
  assert.deepEqual(made.construction.components,cleared.components,'only the explicit authored hopper move creates room for the layer');
});

test('the extra top armour has its own real mass and stock, leaving structural strength and the source profile unchanged', () => {
  const source = bare(), original = structuredClone(source), plain = compileDraft(source),
    changed = withChassisTopThickness(withChassisTopMaterial(source, 'aluminum'), 20), made = compileDraft(changed), plates = top(made);
  assert.deepEqual(source, original); assert.equal(plates.length, source.chassis.points.length-1);
  assert.deepEqual(made.construction.chassis.topPlate, { material: 'aluminum', thicknessMm: 20 });
  close(made.compiled.chassis.frameKg, plain.compiled.chassis.frameKg);
  close(made.compiled.chassis.frameLimitKg, plain.compiled.chassis.frameLimitKg);
  const extra = plates.reduce((sum, p) => sum+p.physicalMass, 0);
  close(made.compiled.chassis.loadedKg-plain.compiled.chassis.loadedKg, extra);
  close(constructionCost(made.construction).total-constructionCost(plain.construction).total,piecesCost(plates));
  for (const plate of plates) {
    assert.equal(plate.material, 'aluminum'); assert.equal(plate.thicknessMm, 20);
    assert.equal(plate.mountId, CHASSIS_ID); assert.equal(plate.chassis, undefined, 'ordinary armour is painted by its actual material');
    close(plate.physicalMass, plate.length*.02*plate.widthM*MATERIALS.aluminum.density);
    assert(plate.ballisticGrid, 'the additional layer is real ballistic stock');
  }
  const removed = withChassisTopMaterial(changed, 'none');assert.equal(removed.chassis.topPlate, undefined);
  assert.deepEqual(compileDraft(removed), plain);
});

test('top armour follows bends, point edits and suspension while preserving intentional chassis gaps', () => {
  let source = bare();const y = source.chassis.points[0].y;
  source.chassis.points = [{x:-54,y},{x:-30,y:y+6},{x:-10,y:y+6,gap:true},{x:10,y:y+6},{x:30,y:y+6},{x:54,y}];
  source = withChassisTopThickness(withChassisTopMaterial(source, 'steel'), 10);
  const before = compileDraft(source), plates = top(before);
  assert.equal(plates.length, 4);assert(!plates.some(p => p.id === 'chassis:top-2'));
  assert(plates.some(p => Math.abs(Math.sin(p.angle))>.1), 'the layer follows the sloped arch');
  const reshaped = compileDraft(withChassisPoint(source, 1, {x:-30,y:y+5}));
  assert.notEqual(top(reshaped).find(p=>p.id==='chassis:top-0').angle,plates[0].angle);
  const raised = compileDraft(withChassisSuspension(source, 2)), shift = raised.compiled.chassis.deck-before.compiled.chassis.deck;
  for(const plate of plates){const other=top(raised).find(p=>p.id===plate.id);close(other.x,plate.x);close(other.y-plate.y,shift);close(other.angle,plate.angle);}
  assert.deepEqual(before.construction.chassis.topPlate,{material:'steel',thicknessMm:10});
  assert(!('points' in before.construction.chassis.topPlate), 'only stock is saved, never a second geometry');
});

test('an intentional gap in the chassis floor leaves a hull open', () => {
  let source=bare();const y=source.chassis.points[0].y;
  source.chassis.points=[{x:-54,y},{x:-30,y},{x:-10,y,gap:true},{x:10,y},{x:30,y},{x:54,y}];
  source=withChassisTopMaterial(source,'steel');
  const made=compileDraft(source).compiled,level=Math.round((made.frame.nodes.find(n=>n.id==='chassis:top-point-0').y-made.frame.origin.y)/CELL);
  source.nodes=[{id:'a',x:-54,y:level},{id:'b',x:54,y:level},{id:'c',x:54,y:level+12},{id:'d',x:-54,y:level+12}];
  source.plates=[['front','d','a'],['roof','c','d'],['rear','b','c']].map(([id,a,b])=>({id,a,b,material:'steel',thicknessMm:5}));
  assert.equal(compileDraft(source).compiled.rooms.length,0);
  delete source.chassis.points[2].gap;
  assert.equal(compileDraft(source).compiled.rooms.length,1);
});

test('the chassis inspector installs, changes and removes the layer with normal undo and material limits', () => {
  const editor = new Editor(bare());editor.select(CHASSIS_ID);editor.commit();
  editor.editProperty('topPlateMaterial','steel',true);
  assert.equal(editor.source.chassis.topPlate.material,'steel');
  const setting=pieceSettings(editor.selected,editor.source.chassis).find(s=>s.key==='topPlateThicknessMm');
  assert.deepEqual([setting.value,setting.min,setting.max,setting.step],[5,5,1000,5]);
  editor.commit();applySettings(editor,'topPlateThicknessMm',new Map([[CHASSIS_ID,15]]));
  assert.equal(editor.source.chassis.topPlate.thicknessMm,15);editor.undo();assert.equal(editor.source.chassis.topPlate.thicknessMm,5);
  const aluminum=withPieceProperty(editor.source,CHASSIS_ID,'topPlateMaterial','aluminum');
  assert.equal(aluminum.chassis.topPlate.thicknessMm,8);
  assert.throws(()=>compileDraft({...aluminum,chassis:{...aluminum.chassis,topPlate:{material:'aluminum',thicknessMm:5}}}));
  assert.throws(()=>compileDraft(withChassisTopMaterial(editor.source,'concrete')));
  const choices=topPlateChoices(editor.source);assert.equal(choices[0].id,'none');assert(!choices.some(c=>c.id==='concrete'));
  assert(choices.find(c=>c.id==='titanium').detail.includes('kg'));
});
