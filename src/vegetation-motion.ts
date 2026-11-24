import type { Point } from './math.ts';
import type { EffectCamera, EffectQuality } from './effect-types.ts';
interface Wave extends Point { strength: number; reach: number; life: number; speed: number; age: number; previousAge: number; wait: number }
export interface VegetationEvent extends Point { type: string; radius?: number; power?: number; weapon?: string | null | undefined; caliberMm?: number }
export interface PlantUniforms { uPlantMotion: Float32Array; uPlantGusts: Float32Array; uPlantForces: Float32Array }
import { clamp, TAU } from './math.ts';

export const VEGETATION_WAVES = 4;
const limits = { high: VEGETATION_WAVES, balanced: 3, low: 2 };

// Local presentation impulses outlive the very short optical pressure front. No plant is stepped on the CPU.
export class VegetationMotion {
  declare waves: Wave[]; declare quality: EffectQuality;
  constructor() { this.waves = []; this.quality = 'high'; }
  clear() { this.waves.length = 0; }
  setQuality(quality: string) {
    this.quality = quality === 'balanced' || quality === 'low' ? quality : 'high';
    if (this.waves.length > limits[this.quality]) {
      this.waves.sort((a,b) => b.strength - a.strength); this.waves.length = limits[this.quality];
    }
  }
  emit(event: VegetationEvent, ahead = 0) {
    if (![event?.x,event?.y].every(Number.isFinite) || Math.max(Math.abs(event.x),Math.abs(event.y)) > 1e7) return;
    let strength, reach, life;
    if (event.type === 'explosion') {
      const radius = (event.radius ?? 0) > 0 ? event.radius! : Math.sqrt(Math.max(0,event.power || 240)/240);
      strength = clamp(radius / 7.2, .12, 1.2); reach = clamp(radius * 3.2, 2.5, 28); life = .85 + strength * .3;
    } else if (event.type === 'muzzle' && ['cannon','howitzer','mortar'].includes(event.weapon ?? '')) {
      const bore = clamp(Math.sqrt((event.caliberMm || 120)/120),.3,1.3);
      strength = bore * (event.weapon === 'mortar' ? .16 : .28); reach = bore * 5.5; life = .7;
    } else return;
    const wave = { x:event.x,y:event.y,strength,reach,life,speed:100+strength*65,age:0,previousAge:0,wait:Number.isFinite(ahead)?Math.max(0,ahead):0 };
    if (this.waves.length >= limits[this.quality]) {
      let weakest=0;
      const weight = (w: Wave) => w.strength * Math.max(0,1-w.age/(w.life+w.reach/w.speed));
      for(let i=1;i<this.waves.length;i++)if(weight(this.waves[i]!)<weight(this.waves[weakest]!))weakest=i;
      if(weight(this.waves[weakest]!)>=strength)return;
      this.waves.splice(weakest,1);
    }
    this.waves.push(wave);
  }
  update(dt: number) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    let kept=0;
    for(const wave of this.waves){
      wave.previousAge=wave.age;const step=Math.max(0,dt-wave.wait);wave.wait=Math.max(0,wave.wait-dt);wave.age+=step;
      if(wave.age < wave.life+wave.reach/wave.speed)this.waves[kept++]=wave;
    }
    this.waves.length=kept;
  }
  write(uniforms: PlantUniforms, camera: EffectCamera, origin: Point, time: number, alpha = 1) {
    const motion=uniforms.uPlantMotion,gusts=uniforms.uPlantGusts,forces=uniforms.uPlantForces;
    gusts.fill(0);forces.fill(0);motion.fill(0);
    if (!(camera.zoom >= 3) || ![camera.zoom,origin.x,origin.y].every(Number.isFinite)) return;
    motion[0]=(Math.max(0,Number.isFinite(time)?time:0)*.9)%TAU;motion[1]=1/camera.zoom;
    motion[2]=this.quality==='low'?.10:.20;
    const half=camera.width/(camera.zoom*2),t=Number.isFinite(alpha)?clamp(alpha,0,1):1;
    let count=0;
    for(const wave of this.waves){
      if(Math.abs(wave.x-camera.x)>half+wave.reach+12)continue;
      const at=count*4;
      // The CPU combines the large world coordinates; the shader only reads nearby screen-space roots and centres.
      gusts[at]=origin.x+wave.x*camera.zoom;gusts[at+1]=origin.y-wave.y*camera.zoom;
      gusts[at+2]=wave.previousAge+(wave.age-wave.previousAge)*t;gusts[at+3]=wave.reach;
      forces[at]=wave.strength;forces[at+1]=wave.speed;forces[at+2]=wave.life;count++;
    }
    motion[3]=count;
  }
}
