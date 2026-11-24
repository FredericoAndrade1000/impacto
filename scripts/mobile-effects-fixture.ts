// Fixed presentation events over real Native vehicle poses. No damage, ammunition or network simulation is claimed.
import { record, expectRecord, expectNumber } from './operational-input.ts';
import type { SceneEventBase } from '../src/scene-contract.ts';
export interface EffectModule { id: string; actorId: string; kind: string; x?: number; y?: number; weaponPreset?: string; burning?: boolean }
export interface EffectActor { id: string; vehicle?: { x: number; y: number } | null }
export interface EffectState<Module extends EffectModule = EffectModule> { actors: EffectActor[]; modules: Module[] }
interface FixtureEvent extends SceneEventBase { type: 'burn' | 'muzzle' | 'explosion'; x: number; y: number }
export function effectsFixture<Module extends EffectModule, State extends EffectState<Module>>(packets: { state: State; events?: readonly SceneEventBase[] }[],
  spec: { effect?: string; parts?: boolean }, recording: unknown, ground: { height(x: number): number } | null,
  { weaponAngle, weaponBarrelProfile, presets }: { weaponAngle?: (part: Module) => number; weaponBarrelProfile?: (part: Module) => { end: number }; presets?: Readonly<Record<string, { family: string; caliberMm: number }>> }): void {
  packets.forEach((packet,index)=>{
    const state=packet.state, first=state.actors[0];
    if (!first) throw Error('Effect fixture requires a recorded actor.');
    const actors=spec.effect==='burnGroup'?state.actors:[first], events:FixtureEvent[]=[],lit=new Set<string>();
    if(spec.effect==='burn'||spec.effect==='burnGroup')for(const actor of actors){
      const part=state.modules.find(m=>m.actorId===actor.id&&m.kind==='fuel');
      if(!part)throw Error('Fire fixture requires a real fuel component.');
      for(const piece of state.modules)if(piece.actorId===actor.id&&(piece.id===part.id||spec.parts&&['engine','thruster','ammo'].includes(piece.kind)))lit.add(piece.id);
      const event: FixtureEvent = {type:'burn',actorId:actor.id,componentId:part.id,x:expectNumber(part.x),y:expectNumber(part.y),strength:1.4,spread:1};
      events.push(event);
    }
    if(spec.effect==='muzzle'&&index%40===0){
      const gun=state.modules.find(m=>m.actorId===first.id&&m.kind==='weapon');
      if (!gun || !gun.weaponPreset || !weaponAngle || !weaponBarrelProfile) throw Error('Muzzle fixture requires a recorded weapon and its geometry.');
      const angle=weaponAngle(gun),length=weaponBarrelProfile(gun).end,model=presets?.[gun.weaponPreset];
      if (!model) throw Error('Muzzle fixture requires its weapon preset.');
      events.push({type:'muzzle',actorId:first.id,componentId:gun.id,preset:gun.weaponPreset,weapon:model.family,caliberMm:model.caliberMm,
        x:expectNumber(gun.x)+Math.cos(angle)*length,y:expectNumber(gun.y)+Math.sin(angle)*length,angle});
    }
    if(spec.effect==='blast'&&index%30===0||spec.effect==='blastOnce'&&index===60){
      if (!first.vehicle || !ground) throw Error('Blast fixture requires a recorded vehicle and terrain.');
      const x=first.vehicle.x+8;events.push({type:'explosion',x,y:ground.height(x)+.02,power:1400,radius:7.2,ground:true});
    }
    if(spec.effect==='vegetation'&&index%40===0){
      if (!ground || !record(recording)) throw Error('Vegetation fixture requires recorded scenery and terrain.');
      const grass=expectRecord(expectRecord(expectRecord(recording.watch).scenery).grass), x=expectNumber(grass.x)-5;events.push({type:'explosion',x,y:ground.height(x)+1,power:1000,radius:6});
    }
    if(spec.effect==='burn'||spec.effect==='burnGroup'){
      // The local presentation fixture includes the visual flag as well as
      // its events. Native health, fuel and the recorded poses stay untouched.
      packet.state={...state,modules:state.modules.map(part=>lit.has(part.id)?{...part,burning:true}:part)};
    }
    packet.events=events;
  });
}
