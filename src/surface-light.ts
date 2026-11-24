import type { Container } from 'pixi.js';
import type { Point } from './math.ts';
import type { EffectCamera, EffectQuality, EffectLight } from './effect-types.ts';
import type { FireScene } from './fire-surface.ts';
interface LightSource extends Point { radius: number; strength: number; r: number; g: number; b: number }
interface SmokeParticle extends Point { kind: string; hotSmoke?: number | undefined; smokeTint: number; age: number; sprite: { tint: number } }
export interface SurfaceEffects { quality?: string; lights?: readonly EffectLight[]; particles?: readonly SmokeParticle[] }
interface SurfaceActor { body?: Container | null; container: Container; ghost?: unknown; extent?: { length?: number; left?: number; right?: number; bottom?: number; top?: number; angle?: number } }
interface LightEntry { filter: Filter; filters: Filter[]; body: Container | null; uniforms: ReturnType<typeof lightUniforms>['uniforms'] }
const lightUniforms = () => new UniformGroup({ uView: { value: new Float32Array(4), type: 'vec4<f32>' }, uLights: { value: new Float32Array(16), type: 'mat4x4<f32>' }, uColors: { value: new Float32Array(16), type: 'mat4x4<f32>' } });
import { Filter, Geometry, GlProgram, Mesh, Shader, UniformGroup } from 'pixi.js';

// Local reflected light, on the already drawn material only. Each lit body uses
// one small pooled filter; effects, labels and the sky never enter that capture.
// Nothing is repainted/uploaded as a flame flickers. Distant/empty scenes do no work.
const budgets = {
  high: { sources: 8, bodies: 6, smoke: 64 },
  balanced: { sources: 6, bodies: 4, smoke: 40 },
  low: { sources: 3, bodies: 2, smoke: 16 },
};
const LIGHTS = 4, SOURCES = 8, GROUND_STEPS = 12;
const vertex = `
in vec2 aPosition;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
uniform vec4 uView;
out vec2 vTextureCoord;
out vec2 vPlace;
void main() {
    vec2 pixel = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    vPlace = (pixel - uView.xy) * vec2(uView.z, -uView.z);
    gl_Position = vec4(pixel.x * (2.0 / uOutputTexture.x) - 1.0,
        pixel.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z, 0.0, 1.0);
    vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
}`;
const fragment = `
in vec2 vTextureCoord;
in vec2 vPlace;
uniform sampler2D uTexture;
uniform mat4 uLights;
uniform mat4 uColors;
out vec4 finalColor;
void main() {
    vec4 picture = texture(uTexture, vTextureCoord);
    vec3 light = vec3(0.0);
    for (int i = 0; i < 4; i++) {
        vec4 source = uLights[i];
        vec2 distance = (vPlace - source.xy) * source.z;
        float falloff = max(0.0, 1.0 - dot(distance, distance));
        light += uColors[i].rgb * source.w * falloff * falloff;
    }
    // Preserve the material's grain, damage, dark creases and coverage. A small
    // diffuse floor lets dark burnt paint still receive warm light, without neon edges.
    vec3 reflected = (picture.rgb * 1.25 + picture.a * 0.025) * min(light, vec3(1.25));
    finalColor = vec4(min(vec3(picture.a), picture.rgb + reflected), picture.a);
}`;
const groundVertex = `
in vec2 aPosition;
in vec2 aCoord;
in vec4 aTint;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vCoord;
out vec4 vTint;
void main() {
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vCoord = aCoord; vTint = aTint;
}`;
const groundFragment = `
in vec2 vCoord;
in vec4 vTint;
out vec4 finalColor;
void main() {
    float falloff = max(0.0, 1.0 - dot(vCoord, vCoord));
    float alpha = vTint.a * falloff * falloff;
    finalColor = vec4(vTint.rgb * alpha, alpha);
}`;

function lightFilter() {
  const uniforms = lightUniforms();
  const filter = new Filter({ glProgram: GlProgram.from({ name: 'surface-reflected-light', vertex, fragment }),
    // The cached bitmaps already contain their edge coverage. Avoid another
    // multisampled target for each illuminated body, while retaining full resolution.
    padding: 0, resolution: 'inherit', antialias: 'off', resources: { lightUniforms: uniforms } });
  return { filter, uniforms: uniforms.uniforms };
}
const overlaps = (source: Pick<LightSource, 'x' | 'y' | 'radius'>, left: number, right: number, bottom: number, top: number) => source.x + source.radius > left && source.x - source.radius < right &&
  source.y + source.radius > bottom && source.y - source.radius < top;

export class SurfaceLight {
  declare sources: LightSource[]; declare entries: LightEntry[]; declare count: number; declare quality: EffectQuality; declare enabled: boolean;
  declare positions: Float32Array; declare coords: Float32Array; declare tints: Float32Array; declare indices: Uint16Array; declare geometry?: Geometry; declare shader?: Shader; declare ground?: Mesh<Geometry, Shader>;
  constructor() {
    this.sources = []; this.entries = []; this.count = 0; this.quality = 'high'; this.enabled = true;
    this.positions = new Float32Array(SOURCES * (GROUND_STEPS + 1) * 4);
    this.coords = new Float32Array(this.positions.length); this.tints = new Float32Array(this.positions.length * 2);
    this.indices = new Uint16Array(SOURCES * GROUND_STEPS * 6);
    for (let s = 0; s < SOURCES; s++) for (let i = 0; i < GROUND_STEPS; i++) {
      const v = s * (GROUND_STEPS + 1) * 2 + i * 2;
      this.indices.set([v,v+1,v+2,v+1,v+3,v+2], (s * GROUND_STEPS + i) * 6);
    }
  }
  init(parent: Container) {
    if (this.ground) return;
    this.geometry = new Geometry({ attributes: {
      aPosition: { buffer: this.positions, format: 'float32x2' }, aCoord: { buffer: this.coords, format: 'float32x2' },
      aTint: { buffer: this.tints, format: 'float32x4' },
    }, indexBuffer: this.indices });
    this.shader = new Shader({ glProgram: GlProgram.from({ name: 'ground-reflected-light', vertex: groundVertex, fragment: groundFragment }) });
    this.ground = new Mesh({ geometry: this.geometry, shader: this.shader }); this.ground.blendMode = 'add';
    this.ground.label = 'effects:ground-light'; this.ground.visible = false; parent.addChild(this.ground);
  }
  collect(effects: SurfaceEffects | null | undefined, camera: EffectCamera | null | undefined) {
    this.sources.length = 0;
    this.quality = effects?.quality === 'balanced' || effects?.quality === 'low' ? effects.quality : 'high';
    if (!this.enabled || !camera || ![camera.x,camera.y,camera.width,camera.height,camera.zoom].every(Number.isFinite) || camera.zoom <= 0) return this.sources;
    const budget = budgets[this.quality], halfX = camera.width / camera.zoom / 2, halfY = camera.height / camera.zoom / 2;
    const extra = [];
    for (const light of effects?.lights || []) {
      const strength = light.displayStrength ?? light.strength * Math.max(0, 1 - light.age / light.life) ** 2.4,
        x = light.displayX ?? light.x, y = light.displayY ?? light.y,
        radius = Math.min(8, Math.max(.4, light.size * (light.key ? 1.3 : .8)));
      if (![x,y,radius,strength].every(Number.isFinite) || strength < .006 || radius * camera.zoom < 10 || light.age >= light.life ||
          !overlaps({ x,y,radius }, camera.x-halfX, camera.x+halfX, camera.y-halfY, camera.y+halfY)) continue;
      const tint = light.displayTint || light.tint || 0xffb36a;
      const source = { x, y, radius, strength: strength * (light.key ? 3 : 2),
        r: (tint >> 16 & 255) / 255, g: (tint >> 8 & 255) / 255 * .72, b: (tint & 255) / 255 * .48 };
      this.sources.push(source);
      for (const site of light.sites || []) {
        const sx = site.displayX ?? site.x, sy = site.displayY ?? site.y;
        if (Number.isFinite(sx) && Number.isFinite(sy) && Math.hypot(sx-x,sy-y)>radius*.3)
          extra.push({ ...source,x:sx,y:sy,strength:source.strength*.65 });
      }
    }
    this.sources.sort((a,b) => b.strength - a.strength);
    // One main source per fire gets priority before the optional end regions
    // of a developed fire. Several vehicles cannot monopolise the whole budget.
    this.sources.push(...extra);
    this.sources.length = Math.min(this.sources.length, budget.sources);
    return this.sources;
  }
  sample(effects: SurfaceEffects | null | undefined, camera: EffectCamera, layers: Iterable<readonly [string, SurfaceActor]> | null | undefined, scene: Pick<FireScene, 'actor'> | null | undefined, terrain: { height(x: number): number } | null | undefined, world: Point | null = null) {
    this.collect(effects, camera); const budget = budgets[this.quality]; this.count = 0;
    for (const [id, actor] of layers || []) {
      if (!this.sources.length || this.count >= budget.bodies) break;
      if (!actor.body?.visible || !actor.container.visible || actor.ghost || actor.container.alpha < .01) continue;
      const pose = scene?.actor(id), extent = actor.extent;
      if (!pose) continue;
      const reach = Number.isFinite(extent?.length) ? extent!.length! : 16, box = {
        left:pose.x-reach,right:pose.x+reach,bottom:pose.y-reach,top:pose.y+reach,
      };
      if (extent && [extent.left!,extent.right!,extent.bottom!,extent.top!].every(Number.isFinite)) {
        const c = Math.cos((pose.angle||0)-(extent.angle||0)), s = Math.sin((pose.angle||0)-(extent.angle||0)),
          x = (extent.left!+extent.right!)/2, y = (extent.bottom!+extent.top!)/2,
          halfX = (extent.right!-extent.left!)/2, halfY = (extent.top!-extent.bottom!)/2,
          hx = Math.abs(c)*halfX+Math.abs(s)*halfY+1, hy = Math.abs(s)*halfX+Math.abs(c)*halfY+1,
          cx = pose.x+c*x-s*y, cy = pose.y+s*x+c*y;
        box.left=cx-hx;box.right=cx+hx;box.bottom=cy-hy;box.top=cy+hy;
      }
      const sources = this.sources.filter(source => overlaps(source,box.left,box.right,box.bottom,box.top)).slice(0,LIGHTS);
      if (!sources.length) continue;
      let entry = this.entries[this.count];
      if (!entry) { const { filter, uniforms } = lightFilter(); entry = { filter, uniforms, filters: [filter], body: null }; this.entries.push(entry); }
      if (entry.body !== actor.body) { if (entry.body && !entry.body.destroyed && entry.body.filters?.[0] === entry.filter) entry.body.filters = null; entry.body = actor.body; }
      if (actor.body.filters?.[0] !== entry.filter) actor.body.filters = entry.filters;
      const uniforms = entry.uniforms;
      uniforms.uView.set([world ? world.x + camera.x * camera.zoom : camera.width/2,
        world ? world.y - camera.y * camera.zoom : camera.height/2, 1/camera.zoom, 0]);
      uniforms.uLights.fill(0); uniforms.uColors.fill(0);
      sources.forEach((source,i) => {
        uniforms.uLights.set([source.x-camera.x,source.y-camera.y,1/source.radius,source.strength],i*4);
        uniforms.uColors.set([source.r,source.g,source.b,0],i*4);
      });
      this.count++;
    }
    for (let i = this.count; i < this.entries.length; i++) {
      const entry = this.entries[i]!; if (entry.body && !entry.body.destroyed && entry.body.filters?.[0] === entry.filter) entry.body.filters = null; entry.body = null;
    }
    this.drawGround(terrain, camera);
    this.warmSmoke(effects, budget.smoke);
  }
  drawGround(terrain: { height(x: number): number } | null | undefined, camera: EffectCamera) {
    if (!this.ground) return;
    this.ground.visible = false; let count = 0;
    if (!terrain?.height) return;
    this.ground.position.set(camera.x,camera.y);
    const depth = Math.min(.2, Math.max(.06, 5/camera.zoom));
    for (const source of this.sources) {
      if (Math.abs(source.y-terrain.height(source.x)) >= source.radius) continue;
      for (let i = 0; i <= GROUND_STEPS; i++) {
        const x = source.x + source.radius * (i/GROUND_STEPS*2-1), y = terrain.height(x), at = (count*(GROUND_STEPS+1)+i)*4;
        this.positions.set([x-camera.x,y-camera.y,x-camera.x,y-depth-camera.y],at);
        this.coords.set([(x-source.x)/source.radius,(y-source.y)/source.radius,
          (x-source.x)/source.radius,(y-depth-source.y)/source.radius],at);
        this.tints.set([source.r,source.g,source.b,source.strength*.19,source.r,source.g,source.b,0],at*2);
      }
      count++;
    }
    if (!count) return;
    for (const name of ['aPosition','aCoord','aTint']) this.geometry!.getBuffer(name).update();
    this.geometry!.indexCount = count * GROUND_STEPS * 6; this.ground.visible = true;
  }
  warmSmoke(effects: SurfaceEffects | null | undefined, most: number) {
    // Only young combustion smoke receives this local reflection. The bounded
    // subset keeps the existing particles, batching and atlas; cooled smoke stays grey.
    let count = 0;
    for (const p of effects?.particles || []) {
      if (p.kind !== 'smoke' || p.hotSmoke !== 5 || !p.smokeTint) continue;
      let heat = 0;
      for (const source of p.age < 1.3 && count < most ? this.sources : []) {
        const distance = Math.hypot(p.x-source.x,p.y-source.y)/source.radius;
        heat += source.strength * Math.max(0,1-distance*distance) ** 2;
      }
      const amount = Math.min(.3,heat*.24) * (1-p.age/1.3), base = p.smokeTint,
        tint = [16,8,0].reduce((color,shift,i) => color | Math.round((base>>shift&255)*(1-amount)+[232,150,75][i]!*amount)<<shift,0);
      if (p.sprite.tint !== tint) p.sprite.tint = tint; if (heat > 0) count++;
    }
  }
  clear() {
    for (const entry of this.entries) { if (entry.body && !entry.body.destroyed && entry.body.filters?.[0] === entry.filter) entry.body.filters = null; entry.body = null; }
    this.sources.length = 0; this.count = 0; if (this.ground) this.ground.visible = false;
  }
  destroy() {
    this.clear(); for (const entry of this.entries) entry.filter.destroy(); this.entries.length = 0;
    this.ground?.destroy(); this.geometry?.destroy(true); this.shader?.destroy();
  }
}
