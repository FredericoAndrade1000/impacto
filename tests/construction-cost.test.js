import test from 'node:test';
import assert from 'node:assert/strict';
import {initNativeDynamics,nativeConstructionCost} from '../src/native-dynamics.ts';
import {constructionCatalogue} from '../src/construction-admission.ts';
import {MATERIALS} from '../src/materials.ts';
import {armourBill} from '../src/economy.ts';
import {constructionCost,pieceCost,piecesCost,pieceCostBreakdown,weaponCost,ammunitionCost,formatCredits} from '../src/construction-cost.ts';
import {createConstruction,CONSTRUCTION_TEMPLATES} from '../src/construction-templates.ts';
import {structuredTemplateSource} from '../src/structured-templates.ts';
import {compileBlueprint,validateBlueprint,parseBlueprint,serializeBlueprint} from '../src/persistence.ts';
import {WEAPON_PRESETS} from '../src/weapons.ts';
import {WEAPON_MOUNTS} from '../src/weapon-mounts.ts';
import {Editor} from '../src/editor.ts';
import {BODY_WIDTH} from '../src/component-size.ts';
import {DesignLibrary,LIBRARY_KEY} from '../src/library.ts';
import {garageCard} from '../src/construction-ui.ts';
import {vehicleBox} from './helpers/designs.js';
import {withChassisThickness} from '../src/chassis-editing.ts';
await initNativeDynamics();
test('an empty selection costs zero',()=>{
 assert.equal(piecesCost([]),0);
});
// What a construction is paid for, group by group: the total is their sum.
// `kept` is what of a piece its material does not change, paid as on a steel one (game_cost.rs).
const COST_GROUPS=['command','chassis','armour','engines','weapons','runningGear','storage','supplies','kept'];
// Independent price expectations; no runtime rate table supplies these oracles.
const PRICE_PER_KG={steel:1.4,aluminum:3.2,ceramic:6,concrete:.86,hha:2.6,titanium:12,fiberglass:3.2,glass:9};
const fullPieceCost=piece=>nativeConstructionCost({version:1,piece,catalogue:constructionCatalogue()});
for(const template of CONSTRUCTION_TEMPLATES)test(template.id+': canonical purchase reconciles every compiled piece and cost group',()=>{
 const source=createConstruction(template.id),dto=compileBlueprint(source),cost=constructionCost(source),before=structuredClone(source);
 assert.deepEqual(cost,nativeConstructionCost({version:1,compiled:{plates:dto.plates,modules:dto.modules},catalogue:constructionCatalogue()}));
 for(const piece of [...dto.plates,...dto.modules]){
  const expected=fullPieceCost(piece);
  assert.deepEqual(pieceCostBreakdown(piece),expected,template.id+'/'+piece.id);
  assert.equal(piecesCost([piece]),Object.values(expected).reduce((sum,n)=>sum+n,0),template.id+'/'+piece.id+' batch');
 }
 assert.equal(cost.total,[...dto.plates,...dto.modules].reduce((n,p)=>n+pieceCost(p),0));
 assert.equal(piecesCost([...dto.plates,...dto.modules]),cost.total);
 assert.equal(cost.total,COST_GROUPS.reduce((n,k)=>n+cost[k],0));assert(Number.isSafeInteger(cost.total));
 assert.deepEqual(constructionCost(dto),cost);assert.deepEqual(source,before);
});
test('armour pieces agree with complete native requests with absent, zero, null and explicit mass',()=>{
 for(const material of Object.keys(MATERIALS))for(const physicalMass of ['absent',0,null,123.456]){
  const piece={material,length:2.8,thicknessMm:5,widthM:2.4};
  if(physicalMass!=='absent')piece.physicalMass=physicalMass;
  const before=structuredClone(piece),expected=fullPieceCost(piece);
  assert.deepEqual(pieceCostBreakdown(piece),expected,material+': '+physicalMass);
  assert.equal(piecesCost([piece]),Object.values(expected).reduce((sum,n)=>sum+n,0),material+': '+physicalMass+' batch');
  assert.deepEqual(piece,before);
 }
});

test('selected armour, chassis, weapons and reserves keep their individual purchase prices without mutation',()=>{
 // Each subpiece starts a credit separately, including concrete's own-stock share.
 assert.deepEqual(armourBill('steel',[.1,.1]),{ferro:2,ligas:0,silica:0,combustivel:0});
 assert.deepEqual(armourBill('concrete',[1.2,1.2]),{ferro:2,ligas:0,silica:2,combustivel:0});
 assert.deepEqual(armourBill('concrete',[1.3,1.3]),{ferro:0,ligas:0,silica:4,combustivel:0});
 const dto=compileBlueprint(createConstruction('heavy')),reserves=dto.modules.filter(p=>['fuel','ammo'].includes(p.kind)),
  chassis=[...dto.plates.filter(p=>p.chassis),...dto.modules.filter(p=>dto.chassis.gear.includes(p.id))],
  mixed=[dto.plates.find(p=>!p.chassis),dto.modules.find(p=>p.kind==='weapon'),dto.modules.find(p=>p.kind==='engine'),...reserves],
  selections=[mixed,chassis,...[0,.5,1].map(loadFraction=>reserves.map(p=>({...p,loadFraction})))];
 assert(reserves.some(p=>p.kind==='fuel')&&reserves.some(p=>p.kind==='ammo'));
 for(const pieces of selections){
  const before=structuredClone(pieces);
  assert.equal(piecesCost(pieces),pieces.reduce((sum,p)=>sum+pieceCost(p),0));
  assert.deepEqual(pieces,before);
 }
});
// Generated plates carry the structure's actual mass. The frame pays for them all once, at its metal's price;
// a model has no fixed credit charge or proxy mass of its own.
const framePrice=source=>{
 const before=structuredClone(source),dto=compileBlueprint(source),cost=constructionCost(source),
  plates=dto.plates.filter(p=>p.chassis),frame=plates.find(p=>p.chassis.part==='frame'),
  mass=plates.reduce((sum,p)=>sum+p.physicalMass,0),metal=source.chassis.metal??'steel',
  price=Math.ceil(mass*PRICE_PER_KG[metal]-1e-9);
 assert(plates.length>1&&mass>0);assert(frame);
 assert(Math.abs(mass-dto.chassis.frameKg)<1e-6,'declared frame mass equals the generated physical plates');
 assert(Math.abs(mass-frame.chassis.frameKg)<1e-6);
 assert.equal(frame.chassis.credits,price);assert.equal(pieceCostBreakdown(frame).chassis,price);assert.equal(pieceCost(frame),price);
 for(const plate of plates)if(plate!==frame)assert.equal(pieceCost(plate),0,'the other chassis plates are already paid for');
 assert.equal(plates.reduce((sum,p)=>sum+pieceCost(p),0),price);
 assert.equal(cost.chassis,price);assert.equal(constructionCost(dto).chassis,price);assert.deepEqual(source,before);
 return price;
};
test('the chassis price follows actual structure mass when its span changes',()=>{
 // 20 cm (4 cells) longer at the rear.
 for(const id of ['scout','heavy','truck']){
  const source=createConstruction(id),longer=structuredClone(source);longer.chassis.points.at(-1).x+=4;
  assert(framePrice(longer)>framePrice(source),id);
 }
});
test('the same running gear prices its authored section in each structural metal',()=>{
 for(const model of ['wheeled','tracked'])for(const metal of ['steel','aluminum','titanium']){
  // A light box with an explicitly authored frame: no helper reinforces a design to make admission pass.
  const box=vehicleBox({model,length:4.5,height:1.2,thicknessMm:5}),
   source=withChassisThickness({...box,chassis:{...box.chassis,metal}},12),thicker=withChassisThickness(source,16);
  assert(framePrice(thicker)>framePrice(source),`${model}: ${metal}`);
 }
});
test('armour purchase follows authored thickness, span and material',()=>{
 const source=createConstruction('plate'),base=constructionCost(source).armour;
 const thick=structuredClone(source);thick.plates.find(p=>p.id==='hull:front').thicknessMm*=2;
 assert(constructionCost(thick).armour>base);
 // Twice as long, its floor and its roof are 2.8 m longer each: that much more 5 mm steel across the body, at 1.4 cr a kilogram.
 const long=structuredClone(source);for(const node of long.nodes)node.x*=2;
 assert(Math.abs(constructionCost(long).armour-base-2*2.8*.005*BODY_WIDTH*7800*1.4)<=2);
 const concrete=structuredClone(source);concrete.plates.find(p=>p.id==='hull:front').material='concrete';
 assert(constructionCost(concrete).armour<base);
});
test('reserves price containers and the full supplies they are built with separately, without runtime damage discounts',()=>{
 const dto=compileBlueprint(createConstruction('heavy'));
 for(const kind of ['fuel','ammo']){
  const part=dto.modules.find(m=>m.kind===kind),full=pieceCostBreakdown(part),
   supplies=kind==='fuel'?part.capacityLitres*.8:part.capacityRounds*ammunitionCost(part.ammoPreset,part.ammoType);
  assert(full.storage>0&&supplies>0);assert.equal(full.supplies,Math.ceil(supplies-1e-9));
  assert.equal(pieceCost({...part,health:0,rounds:0,fuelLitres:0,detonated:true}),pieceCost(part));
 }
});
for(const preset of Object.keys(WEAPON_PRESETS))test(preset+': prices include native mount and compatible ammunition',()=>{
 const source=structuredTemplateSource('scout',{preset}),gun=compileBlueprint(source).modules.find(m=>m.kind==='weapon');
 assert.equal(weaponCost(preset),WEAPON_PRESETS[preset].costCredits);
 assert.equal(ammunitionCost(preset),WEAPON_PRESETS[preset].cartridge.costCredits);
 const mount=gun.weaponMount,polygons=mount.exposed?[gun.materialPolygons[0]]:gun.materialPolygons.slice(4),
  area=polygons.reduce((sum,poly)=>sum+Math.abs(poly.reduce((value,p,i)=>{
   const q=poly[(i+1)%poly.length];return value+p.x*q.y-p.y*q.x;
  },0))/2,0),metal=Math.ceil(area*mount.materialDepth*mount.materialDensity*PRICE_PER_KG[mount.material]);
 assert.equal(pieceCost(gun),weaponCost(preset)+WEAPON_MOUNTS[mount.preset].cost+metal);
 assert(pieceCost(gun)>0);
});
test('cached prices and physical fields cannot override canonical purchases',()=>{
 const source=createConstruction('heavy');
 for(const mutate of [s=>s.cost=0,s=>s.totalCost=0,s=>s.components[0].price=0,s=>s.components[0].depthM=.001]){
  const invalid=structuredClone(source);mutate(invalid);assert.throws(()=>validateBlueprint(invalid));
 }
 assert.equal(formatCredits(ammunitionCost('minimi'),2),'0,08 cr');
});
test('a construction has a price and no budget of its own: a file that states one is of a format no longer read',()=>{
 const source=createConstruction('heavy'),cost=constructionCost(source);
 assert(cost.total>0);for(const key of ['budget','remaining','overBudget'])assert(!Object.hasOwn(cost,key),key);
 assert(!Object.hasOwn(source,'budgetCredits')&&!Object.hasOwn(compileBlueprint(source),'budgetCredits'));
 for(const value of [0,110000,cost.total])assert.throws(()=>validateBlueprint({...source,budgetCredits:value}));
 // The garage keeps such a one as it is kept, and says why it does not open.
 const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},library=new DesignLibrary(storage),kept=library.create(source);
 const stored=JSON.parse(data.get(LIBRARY_KEY));stored.entries.push({...stored.entries[0],id:'antiga',blueprint:{...stored.entries[0].blueprint,name:'Antiga',budgetCredits:110000}});
 data.set(LIBRARY_KEY,JSON.stringify(stored));
 const reloaded=new DesignLibrary(storage);
 assert.deepEqual(reloaded.entries.map(entry=>entry.id),[kept.id,'antiga']);
 assert.equal(garageCard(reloaded.get('antiga')).refusal,'Chave desconhecida "budgetCredits" no projeto.');
});
test('original purchases survive undo, JSON and garage reload',()=>{
 const source=createConstruction('scout'),editor=new Editor(source),total=constructionCost(source).total;
 editor.change(s=>s.name='Batedor leve');assert(editor.undo());assert.deepEqual(editor.source,source);assert(editor.redo());
 const data=new Map(),storage={getItem:k=>data.get(k)||null,setItem:(k,v)=>data.set(k,v)},library=new DesignLibrary(storage),
  saved=library.create(parseBlueprint(serializeBlueprint(editor.source)),{id:editor.projectId}),reloaded=new DesignLibrary(storage);
 assert.equal(reloaded.get(saved.id).blueprint.name,'Batedor leve');
 assert.equal(constructionCost(reloaded.get(saved.id).blueprint).total,total);
});
