import assert from 'node:assert/strict';
import type { AuthoredComponent, AuthoredConstruction } from '../src/construction-contract.ts';
import type { ModuleKind, MaterialId } from '../src/materials.ts';
import type { SceneEvent } from '../src/scene-contract.ts';
import type { WeaponPresetId } from '../src/weapons.ts';

type SecondaryKind = 'engine' | 'fuel' | 'ammo' | 'weapon' | 'wheel' | 'track';
interface SecondaryOptions {
  preset?: WeaponPresetId; material?: MaterialId; thickness?: number; kind?: SecondaryKind; gap?: number;
  shield?: number; seed?: number; blast?: boolean; casing?: boolean;
}
type SecondaryHit = {[Key in 'x' | 'y' | 'speed' | 'mass' | 'power' | 'energy' | 'impulse' | 'penetrated' | 'damage' | 'time']: SceneEvent[Key]} & {
  id: string | undefined; secondary: boolean; instantaneous: boolean;
};
// Authored damage assay; no generated blueprint admission or spall cloud.
import {World} from '../src/physics.ts';
import {damageConstruction,face,interior} from './damage-fixtures.ts';
import {cellOf} from '../src/grid.ts';
import {weaponSettings} from '../src/weapons.ts';
import {MODULES} from '../src/materials.ts';
import {withChassisThickness} from '../src/chassis-editing.ts';
import {physicsState,permanentParts,partsPreserved,finiteWorld} from './review-harness.ts';
// Running gear comes with the chassis: a wheel or a track as the target is the front wheel or the track of a vehicle,
// on a 7.5 m frame. The tall wheeled assay has four authored axles rather than an implicit load class.
const GEAR={wheel:{chassis:'wheeled',id:'chassis:wheel-0'},track:{chassis:'tracked',id:'chassis:track'}} satisfies Record<'wheel' | 'track', {chassis: 'wheeled' | 'tracked'; id: string}>,GEAR_LENGTH=7.5;
export function reviewSecondary({ preset = 'rh120', material = 'steel', thickness = 50,
  kind = 'engine', gap = .8, shield = 0, seed = 6173, blast = false, casing = false }: SecondaryOptions = {}) {
  // A real tower roof is the source. The hull roof it stands on is the spaced
  // shield: one plate between the two rooms, not an invented interior plate.
  const gear=kind === 'wheel' || kind === 'track' ? GEAR[kind] : undefined, near=gap<.4&&!gear&&kind!=='weapon', length=gear?GEAR_LENGTH:12,
    target: AuthoredComponent | null=kind==='weapon'?{id:'target',kind:'weapon',weaponPreset:'rh120',pose:{x:-5.715,y:2.4,angle:-Math.PI},
      mount:{preset:'heavy-trunnion',sector:{min:-.2,max:.2},radiusM:.34}}:
      kind==='wheel'||kind==='track'?null:
      interior(kind,{x:-.5+Math.ceil(MODULES[kind].width/.1-1e-9)*.05,
        y:-.6825+(near?6.1:Math.min(5,Math.max(.1,Math.floor((7.7-thickness/2000-gap-.8-.7)/.1)*.1)))+
          Math.ceil(MODULES[kind].height/.1-1e-9)*.05},'target'),
    made=damageConstruction({length,height:6,rideHeight:.7,seed,components:target?[target]:[],thicknesses:{roof:shield||5},
      ...(gear&&{dynamic:true,chassis:gear.chassis})}),targetId=gear?gear.id:'target',
    // The project is written in cells (grid.ts). Its frame made thicker hangs all of it as high over its wheels as it
    // was, as the Oficina does.
    blueprint=gear?.chassis==='wheeled' && made.preset==='vehicle'?withChassisThickness({...made,chassis:{...made.chassis,axles:[-2.8,-.95,.95,2.8].map(cellOf)}},20):made;
  // The roof of the tower 7 m over the floor of the hull as the assay has it, however high the hull over the wheels hangs.
  const floorNode=made.nodes.find(node=>node.id==='hull-0'); assert(floorNode, 'Secondary assay needs its hull floor node.');
  const floor=floorNode.y;
  blueprint.nodes.push({id:'turret-top-rear',x:cellOf(length/2),y:floor+cellOf(7)},{id:'turret-top-front',x:cellOf(-length/2),y:floor+cellOf(7)});
  blueprint.plates.push({id:'turret:rear',a:'hull-2',b:'turret-top-rear',material:'steel',thicknessMm:5},
    {id:'turret:roof',a:'turret-top-rear',b:'turret-top-front',material,thicknessMm:thickness},
    {id:'turret:front',a:'turret-top-front',b:'hull-3',material:'steel',thicknessMm:5});
  // The external-ray case has a separate, genuinely closed small hull. Its
  // blast is outside the direct pulse radius; the same front wall either has
  // a real ballistic aperture or retains the requested protective material.
  // A blast coincident with an erased BASE roof would choose a degenerate
  // radial direction, which does not test a fragment reaching this target.
  const casingInterior = () => {
    assert(kind !== 'wheel' && kind !== 'track', 'Casing assay needs an authored interior target.');
    return interior(kind,{x:-1.2+Math.ceil(MODULES[kind].width/.1-1e-9)*.05,
      y:-.0825+Math.ceil(MODULES[kind].height/.1-1e-9)*.05},'target');
  };
  const sourceBlueprint=casing?damageConstruction({seed,frontThickness:shield||5,
    components:[casingInterior()]}):blueprint;
  const world = new World(sourceBlueprint), hits: SecondaryHit[] = [], collisions: (string | undefined)[] = [], rays: SceneEvent[] = [], directHits: SceneEvent[] = [], primaryHits: SceneEvent[]=[],
    module=world.modules.find(m=>m.id===targetId||m.id.endsWith(':'+targetId)),
    source=casing?face(world):world.plates.find(p=>p.id==='turret:roof'||p.id.endsWith(':turret:roof'));
  assert(module && source, 'Secondary assay needs its admitted target and source roof.');
  const column=kind==='weapon'?module.x+module.width/2:module.x,
    sourceY=source.definition.y, shieldPlate=casing?source:face(world,'roof'),
    actualGap=casing?module.x-module.width/2-source.definition.x:
      sourceY-thickness/2000-(module.y+module.height/2);
  // The plate blast goes off five centimetres above the source roof and reaches a quarter of
  // a metre: it loads that roof alone, with a dose of 650 where the roof is nearest.
  const standoff=.05,reach=.25,
    blastPoint=casing?{x:source.definition.x-4,y:module.y}:blast?{x:column,y:sourceY+thickness/2000+standoff}:null;
  if(casing&&!shield)world.cutBody(source,{x:source.definition.x-.1,y:module.y},{x:source.definition.x+.1,y:module.y},.2);
  // A fuel or ammunition target has its casing hit, not what it holds: it is emptied, and weighed so, before the shot.
  if(['ammo','fuel'].includes(kind)){
    world.command('setPartState',{owner:world.game().handle(module),state:kind==='fuel'?{fuelLitres:0}:{rounds:0}});
    for(let i=0;i<6;i++)world.step();
  }
  if(!casing&&!shield)world.cutBody(shieldPlate,{x:column,y:shieldPlate.definition.y-.3},{x:column,y:shieldPlate.definition.y+.3},1.6);
  // The floor, and the frame of the chassis under it, are opened over the gear.
  if(!casing&&gear)for(const plate of [face(world,'floor'),world.plates.find(p=>p.actorId==='local'&&p.id==='chassis:frame-0')])
    { assert(plate, 'Gear assay needs its chassis frame plate.'); world.cutBody(plate,{x:column,y:plate.definition.y-.3},{x:column,y:plate.definition.y+.3},1.6); }
  world.drainEvents();
  try {
    const settings = weaponSettings(preset === 'rh120' ? 'cannon' : ['fnmag', 'm2hb'].includes(preset) ? 'machinegun' : 'autocannon', { preset, ammo: 'ap', spread: 0 });
    const primary = { ...settings, id: 'probe-primary', weapon: settings.id, x: column, y: sourceY+.30,
      vx: 0, vy: -settings.speed, age: 0, visited: new Set<string | number>() },
      initialEnergy = .5 * primary.mass * settings.speed ** 2,
      parts = permanentParts(world), initialHealth = module.health,
      initialExplosions = world.stats.explosions, initialSecondaryShots = world.stats.secondaryShots,
      massState = () => physicsState(world).bodyStates.map(b => ({ body: b.handle, mass: b.mass, inertia: b.inertia })),
      initialMass = massState();
    let peakPackets = 0, impactEvents = 0;
    const observe = (events: readonly SceneEvent[]) => { for (const e of events) {
      if (e.type === 'secondary-ray') rays.push({ ...e });
      if(e.projectileId==='probe-primary'&&e.id===source.id&&['penetration','blocked','ricochet'].includes(e.type))primaryHits.push({...e});
      if (e.type === 'secondary-impact') impactEvents++;
      if (['secondary-impact', 'penetration', 'blocked', 'ricochet'].includes(e.type)) collisions.push(e.id);
      if (e.id !== module.id || !e.kind) continue;
      if (e.type === 'secondary-impact') hits.push({ id: e.projectileId, x: e.x, y: e.y,
        speed: e.speed, mass: e.mass, power: e.power, energy: e.energy, secondary: true,
        instantaneous: e.instantaneous === true, impulse: e.impulse,
        penetrated: e.penetrated, damage: e.damage, time: e.time });
      else if (e.type === 'module') directHits.push({ ...e });
    } };
    // Both blasts are real explosions. The casing one is weak and out of reach of the target,
    // so that only its rays arrive; the row reports direct and ray damage apart.
    const blastPower = casing ? 20 : blast ? 650 / (1 - standoff / reach) ** 1.5 : null;
    if (casing || blast) { assert(blastPoint && blastPower !== null, 'Requested blast needs its point and power.'); world.explode(blastPoint.x,blastPoint.y,blastPower,casing?2.5:reach); }
    else {
      // The primary is a round in the scene, flown by one step. It carries a fuze with no
      // charge that ends it just under the source roof, before it reaches the target.
      const game = world.game();
      game.call({ op: 'projectile', projectile: game.projectile({ ...primary,
        fuzeTime: (.31 + thickness / 2000) / settings.speed, blastRadius: 0 }) });
      world.step();
    }
    observe(world.drainEvents());
    // Packets are whatever is in the air besides that primary: a round whose fuze time comes
    // while it is still leaving the plate is ended by the following step.
    const packets = () => world.projectiles.filter(p => p.id !== primary.id).length;
    const healthAfterImpact = module.health,
      emittedAtImpact = Number(world.stats.secondaryShots) - Number(initialSecondaryShots),
      raysAtImpact = rays.map(ray => ({ ...ray })),
      hitsAtImpact = hits.map(hit => ({ ...hit })),
      energyBudgetAtImpact = raysAtImpact.reduce((sum, ray) => sum + Number(ray.energyBudget), 0),
      energySpentAtImpact = raysAtImpact.reduce((sum, ray) => sum + Number(ray.energySpent), 0),
      secondaryDamageAtImpact = hitsAtImpact.reduce((sum, h) => sum + Number(h.damage), 0);
    peakPackets = packets();
    for (let i = 0; i < 90; i++) {
      world.step(); peakPackets = Math.max(peakPackets, packets());
      observe(world.drainEvents());
    }
    // Use the actual source contact's energy, including gravity/drag up to
    // impact. An input-speed subtraction would undercount gravitational work
    // on this downward shot and make the strict eight-percent gate incorrect.
    const contact=primaryHits[0],
      consumedPrimaryEnergy = blast || casing ? null : contact?
        Number(contact.energy)*Math.max(0,1-Number(contact.remaining)/Number(contact.power)):null,
      energyBudget = rays.reduce((sum, r) => sum + Number(r.energyBudget), 0),
      energySpent = rays.reduce((sum, r) => sum + Number(r.energySpent), 0),
      secondaryDamage = hits.reduce((sum, h) => sum + Number(h.damage), 0);
    return { preset, material, thickness, kind, gap, actualGap, shield, sourceId:source.id, shieldId:shieldPlate.id, seed, blast, casing, rays,
      blastPower, blastPoint, initialEnergy, primaryHits, consumedPrimaryEnergy,
      rayEnergyLimit: casing || blast ? Number(blastPower) * 200 * .1 * .5 : Number(consumedPrimaryEnergy) * .08,
      raysAtImpact, hitsAtImpact, energyBudgetAtImpact, energySpentAtImpact,
      energyBudget, energySpent, secondaryDamage, secondaryDamageAtImpact,
      emittedAtImpact, secondaryShots: Number(world.stats.secondaryShots) - Number(initialSecondaryShots),
      initialHealth, healthAfterImpact, health: module.health, maxHealth: module.maxHealth,
      hits, directHits, collisions,
      explosions: world.stats.explosions - initialExplosions - (casing || blast ? 1 : 0),
      requestedExplosions: casing || blast ? 1 : 0,
      peakPackets, activePackets: world.projectiles.length, impactEvents,
      massPreserved: JSON.stringify(massState()) === JSON.stringify(initialMass),
      partsPreserved: partsPreserved(world, parts), finite: finiteWorld(world) };
  } finally { world.dispose(); }
}

