import type { FilterSystem, Texture, RenderSurface, Renderer as PixiRenderer } from 'pixi.js';
import type { EffectQuality, EffectCamera, EffectView, EffectLight } from './effect-types.ts';
import type { BlastWave } from './blast-waves.ts';
export type RefractionRenderer = PixiRenderer | { backBuffer?: { useBackBuffer: boolean } | undefined };
interface HeatJet { x: number; y: number; dx: number; dy: number; length: number; nozzle: number; thrust: number; seed?: number }
export interface HeatEffects { quality?: string; lights?: readonly EffectLight[]; jets?: { heat: readonly HeatJet[] }; blastWaves?: { waves: readonly BlastWave[] } }
// A barrel hot enough for the air over it to shimmer (weapons.ts `BARREL_SHIMMER`), as the renderer draws it (render.ts
// `drawArmament`): its tube along its top from breech to muzzle, in the world, how thick it is, how hot it and the air
// round it are, °C, and how fast the gun goes.
export interface HotBarrel { id: string; actorId: string | null; x0: number; y0: number; x1: number; y1: number; diameter: number; temperature: number; air: number; vx: number; vy: number }
interface HeatSource extends EffectView { mode: 0 | 1; actorId: string | null; x: number; y: number; rx: number; ry: number; rotation: number; strength: number; phase: number; seed: number; band: number }
type Source = Omit<HeatSource, keyof EffectView>;
const airUniforms = () => new UniformGroup({ uBackSize: { value: new Float32Array([1, 1, 1, 1]), type: 'vec4<f32>' }, uAmplitude: { value: 5, type: 'f32' } });
import { Container, Filter, Geometry, GlProgram, Mesh, Rectangle, Shader, UniformGroup } from 'pixi.js';
import { BARREL_SHIMMER } from './weapons.ts';

// How many columns of hot air (`heat`) and pressure fronts bend the air at most, and how many of those columns may be over
// the jets of thrusters and over hot barrels, after the flames: a thruster burns for as long as it flies and a barrel
// stays hot for minutes, and on the lowest quality neither stirs the air, for the pass not to run all the while.
const settings = Object.freeze({
  high: { heat: 24, waves: 8, jets: 8, barrels: 6, resolution: .55, amplitude: 1 },
  balanced: { heat: 16, waves: 6, jets: 4, barrels: 3, resolution: .45, amplitude: .8 },
  low: { heat: 8, waves: 3, jets: 0, barrels: 0, resolution: .35, amplitude: .6 },
});
// How far past its plume the air over a jet shimmers, and how fast the shimmer runs along it against that over a flame.
const JET_AIR = 1.35, JET_FLOW = 2.5;
const CAPACITY = 32;
const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
const finite = (...values: number[]) => values.every(Number.isFinite);
// The air over a hot barrel (`HotBarrel`). It rises off the steel as a sheet the length of the tube, seen from the side as
// a row of columns over it, as fast as its warmth lifts it, some √(g·D·ΔT/T) (the scale of speed of a free plume), and some
// dozen diameters up before it has mixed into the air. How much it bends the light goes with how much thinner it is than
// the air round it, 1 − T(air)/T. Over a gun that moves the air streams back from it, bent as it goes past and the
// thinner as more of it carries the same heat away. It comes in over the first 50 degrees from `BARREL_SHIMMER`.
const GRAVITY = 9.81, KELVIN = 273.15, SHIMMER = .65, PLUME_DIAMETERS = 12, SHIMMER_IN = 50;
export function barrelPlume(barrel: HotBarrel): { strength: number; flow: number; dx: number; dy: number; height: number } {
  const air = barrel.air + KELVIN, steel = barrel.temperature + KELVIN, diameter = Math.max(.01, barrel.diameter),
    rise = Math.sqrt(GRAVITY * diameter * Math.max(0, steel - air) / air), dx = -barrel.vx, dy = rise - barrel.vy,
    flow = Math.hypot(dx, dy), entering = clamp((barrel.temperature - BARREL_SHIMMER) / SHIMMER_IN, 0, 1), moving = flow > 1e-6;
  return { strength: barrel.temperature >= BARREL_SHIMMER && moving ? SHIMMER * (1 - air / steel) * entering * entering * (3 - 2 * entering) * Math.min(1, rise / flow) : 0,
    flow, dx: moving ? dx / flow : 0, dy: moving ? dy / flow : 1, height: clamp(PLUME_DIAMETERS * diameter, .35, 3) };
}
// Each barrel shimmers in its own way, the same from one frame to the next.
const seedOf = (id: string) => { let hash = 0; for (let i = 0; i < id.length; i++) hash = hash * 31 + id.charCodeAt(i) | 0; return (hash >>> 0) % 997 / 997 * 6; };

const fieldVertex = `
precision highp float;
in vec2 aPosition;
in vec2 aCoord;
in vec4 aParams;
in vec4 aBasis;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
out vec2 vCoord;
out vec4 vParams;
out vec4 vBasis;
void main() {
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vCoord = aCoord; vParams = aParams; vBasis = aBasis;
}`;

const fieldFragment = `
precision highp float;
in vec2 vCoord;
in vec4 vParams;
in vec4 vBasis;
out vec4 finalColor;
void main() {
    vec2 direction;
    float envelope;
    if (vParams.x < 0.5) {
        // Narrow rising refraction, strongest above the flame and vanishing
        // before the column's top. Phase uses simulation time only.
        float height = vCoord.y * 0.5 + 0.5;
        float side = max(0.0, 1.0 - vCoord.x * vCoord.x);
        envelope = side * side * smoothstep(0.0, 0.16, height)
            * (1.0 - smoothstep(0.52, 1.0, height));
        float flow = vCoord.y * 11.0 - vParams.y * 9.0 + vParams.w;
        direction = vec2(sin(flow + sin(vCoord.x * 5.0 + vParams.y * 3.7))
            * 0.78 + sin(flow * 0.57 + vCoord.x * 7.0) * 0.22,
            cos(flow * 0.73 + vCoord.x * 4.0) * 0.28);
    } else {
        // A brief change in air density follows the actual visible front,
        // rather than a filled lens or a second expanding coloured ring.
        float distance = length(vCoord);
        float band = max(0.008, vBasis.w);
        float angle = atan(vCoord.y, vCoord.x);
        float ripple = sin(angle * 3.0 + 1.3) * 0.008
            + sin(angle * 7.0 + 0.7) * 0.004;
        float front = (distance - 0.82 - ripple) / band;
        envelope = 1.0 - smoothstep(0.15, 1.0, abs(front));
        vec2 gradient = vec2(vCoord.x, vCoord.y / max(0.08, vBasis.z));
        gradient /= max(0.001, length(gradient));
        direction = vec2(gradient.x * vBasis.x - gradient.y * vBasis.y,
            -gradient.x * vBasis.y - gradient.y * vBasis.x)
            * (front < 0.0 ? -0.7 : 1.0);
    }
    float alpha = clamp(envelope * vParams.z, 0.0, 0.90);
    // Signed offsets are packed around neutral .5 in a premultiplied field.
    // Normal blending combines overlapping plumes without another GPU pass.
    finalColor = vec4((vec2(0.5) + direction * 0.48) * alpha, 0.0, alpha);
}`;

const refractionVertex = `
precision highp float;
in vec2 aPosition;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;
out vec2 vTextureCoord;
void main() {
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    gl_Position = vec4(position, 0.0, 1.0);
    vTextureCoord = aPosition * uOutputFrame.zw * uInputSize.zw;
}`;

const refractionFragment = `
precision highp float;
in vec2 vTextureCoord;
uniform sampler2D uTexture;
uniform sampler2D uBackTexture;
uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uBackSize;
uniform float uAmplitude;
out vec4 finalColor;
void main() {
    vec4 field = texture(uTexture, vTextureCoord);
    if (field.a < 0.003) { finalColor = vec4(0.0); return; }
    // The displacement field can be low resolution while the copied image
    // retains the renderer's full resolution. Their pooled sizes differ.
    vec2 pixel = vTextureCoord * uInputSize.xy;
    vec2 uv = pixel * uBackSize.zw;
    vec2 shift = (field.rg / max(0.003, field.a) - vec2(0.5)) * uAmplitude * uBackSize.zw;
    vec2 edge = 0.5 * uBackSize.zw;
    vec2 maximum = uOutputFrame.zw * uBackSize.zw - edge;
    finalColor = texture(uBackTexture, clamp(uv + shift, edge, maximum)) * field.a;
}`;

class RefractionFilter extends Filter {
  declare readonly air: ReturnType<typeof airUniforms>;
  constructor() {
    const air = airUniforms();
    super({
      glProgram: GlProgram.from({ name: 'battle-air-refraction', vertex: refractionVertex, fragment: refractionFragment }),
      blendRequired: true, padding: 7, resolution: settings.high.resolution, antialias: 'off',
      resources: { airUniforms: air },
    });
    this.air = air;
  }
  override apply(manager: FilterSystem, input: Texture, output: RenderSurface, clear: boolean) {
    const source = manager.activeBackTexture!.source, values = this.air.uniforms.uBackSize;
    values[0] = source.width; values[1] = source.height;
    values[2] = 1 / source.width; values[3] = 1 / source.height;
    manager.applyFilter(this, input, output, clear);
  }
}

function sourceBounds(source: Source): EffectView {
  const c = Math.cos(source.rotation), s = Math.sin(source.rotation),
    rx = Math.abs(c) * source.rx + Math.abs(s) * source.ry,
    ry = Math.abs(s) * source.rx + Math.abs(c) * source.ry;
  return { left: source.x - rx, right: source.x + rx, bottom: source.y - ry, top: source.y + ry };
}

// One aggregate field and one bounded background copy serve every visible
// source. This class reads presentation effects; it never emits simulation
// events, edits particles, or creates a filter/texture per flame or per frame.
export class HeatHaze {
  declare host: Container; declare sources: Source[]; declare time: number; declare quality: EffectQuality; declare count: number; declare bounds: EffectView | null; declare enabled: boolean;
  declare mesh: Mesh<Geometry, Shader> | null; declare filter: RefractionFilter | null; declare geometry: Geometry | null; declare fieldShader?: Shader; declare renderer?: RefractionRenderer | null | undefined;
  declare positions: Float32Array; declare coords: Float32Array; declare params: Float32Array; declare basis: Float32Array; declare indices: Uint16Array; declare area: Rectangle;
  declare flows: Map<string, { phase: number; time: number }>;
  constructor() {
    this.host = new Container(); this.host.label = 'effects:air-refraction'; this.host.visible = false;
    this.sources = []; this.time = 0; this.quality = 'high'; this.count = 0; this.bounds = null; this.enabled = true; this.flows = new Map();
    this.mesh = null; this.filter = null; this.geometry = null;
    this.positions = new Float32Array(CAPACITY * 8); this.coords = new Float32Array(CAPACITY * 8);
    this.params = new Float32Array(CAPACITY * 16); this.basis = new Float32Array(CAPACITY * 16);
    this.indices = new Uint16Array(CAPACITY * 6);
    for (let i = 0; i < CAPACITY; i++) this.indices.set([i * 4, i * 4 + 1, i * 4 + 2, i * 4, i * 4 + 2, i * 4 + 3], i * 6);
    this.area = new Rectangle();
  }
  // Shaders are created lazily, after Renderer.init has a WebGL context.
  init() {
    if (this.mesh) return this;
    this.geometry = new Geometry({
      attributes: {
        aPosition: { buffer: this.positions, format: 'float32x2' },
        aCoord: { buffer: this.coords, format: 'float32x2' },
        aParams: { buffer: this.params, format: 'float32x4' },
        aBasis: { buffer: this.basis, format: 'float32x4' },
      }, indexBuffer: this.indices,
    });
    this.fieldShader = new Shader({ glProgram: GlProgram.from({ name: 'battle-air-field', vertex: fieldVertex, fragment: fieldFragment }) });
    this.mesh = new Mesh({ geometry: this.geometry, shader: this.fieldShader }); this.mesh.visible = false;
    this.filter = new RefractionFilter(); this.host.filters = [this.filter]; this.host.filterArea = this.area;
    this.host.addChild(this.mesh); return this;
  }
  update(dt: number) { if (Number.isFinite(dt) && dt > 0) this.time += dt; }
  setQuality(quality: string) { this.quality = quality === 'balanced' || quality === 'low' ? quality : 'high'; }
  setEnabled(enabled: boolean) {
    this.enabled = Boolean(enabled);
    if (!this.enabled) this.clearPass(this.renderer);
  }
  collect(effects: HeatEffects | null | undefined, camera: EffectCamera | null | undefined, hot: readonly HotBarrel[] = []) {
    this.sources.length = 0; this.bounds = null;
    if (!this.enabled || !camera || !finite(camera.x, camera.y, camera.zoom, camera.width, camera.height) || camera.zoom <= 0 || camera.width <= 0 || camera.height <= 0) return this.sources;
    this.setQuality(effects?.quality || this.quality);
    const budget = settings[this.quality], left = camera.x - camera.width / (2 * camera.zoom),
      right = camera.x + camera.width / (2 * camera.zoom), bottom = camera.y - camera.height / (2 * camera.zoom),
      top = camera.y + camera.height / (2 * camera.zoom);
    const accept = (source: Source) => {
      if (!finite(source.x, source.y, source.rx, source.ry, source.rotation, source.strength, source.phase) ||
          Math.abs(source.x) > 1e7 || Math.abs(source.y) > 1e7 || source.rx <= 0 || source.ry <= 0 || source.strength < .01) return;
      const bounds = sourceBounds(source);
      if (bounds.right < left || bounds.left > right || bounds.top < bottom || bounds.bottom > top || source.rx * camera.zoom < 1) return;
      this.sources.push(source);
      if (!this.bounds) this.bounds = { ...bounds };
      else {
        this.bounds.left = Math.min(this.bounds.left, bounds.left); this.bounds.right = Math.max(this.bounds.right, bounds.right);
        this.bounds.bottom = Math.min(this.bounds.bottom, bounds.bottom); this.bounds.top = Math.max(this.bounds.top, bounds.top);
      }
    };
    let heat = 0;
    for (const light of effects?.lights || []) {
      if (heat >= budget.heat) break;
      const x = light.displayX ?? light.x, y = light.displayY ?? light.y;
      if (!light.key?.startsWith('burn:') && !light.blast || !finite(x, y, light.size, light.age, light.life) || light.life <= 0 || light.age >= light.life) continue;
      const size = clamp(light.size, .3, 6), height = clamp(size * (light.blast ? .6 : 1.15), .45, 3.5),
        flameTop = y + size * (light.blast ? .28 : .27),
        fade = Math.pow(1 - clamp(light.age / light.life, 0, 1), light.blast ? 1.4 : .4), before = this.sources.length;
      accept({ mode: 0, actorId: light.effectActorId || null, x, y: flameTop + height * .5,
        rx: size * (light.blast ? .34 : .32), ry: height * .5, rotation: 0,
        strength: clamp((light.blast ? .78 : .62) * fade * budget.amplitude, 0, .9),
        phase: this.time, seed: Math.sin(x * 3.17 + y * 7.61) * 6, band: 0 });
      if (this.sources.length > before) heat++;
    }
    // The air over the jet of a thruster (effects.ts `ThrusterJets`), a column along the jet from its nozzle: it bends
    // most a little way out of the nozzle and settles again past the end of the plume.
    let jets = 0;
    for (const jet of effects?.jets?.heat || []) {
      if (heat >= budget.heat || jets >= budget.jets) break;
      const reach = jet.length * JET_AIR, before = this.sources.length;
      accept({ mode: 0, actorId: null, x: jet.x + jet.dx * reach / 2, y: jet.y + jet.dy * reach / 2,
        rx: jet.nozzle * .75, ry: reach / 2, rotation: Math.atan2(-jet.dx, jet.dy),
        strength: clamp(.5 * jet.thrust * budget.amplitude, 0, .9), phase: this.time * JET_FLOW, seed: jet.seed ?? 0, band: 0 });
      if (this.sources.length > before) { jets++; heat++; }
    }
    // The air over each hot barrel (`barrelPlume`), in as many columns along it as it is long across the way the air goes
    // up to three, each from the top of the tube. Its shimmer runs along the column as fast as the air goes up it.
    let barrels = 0;
    for (const barrel of hot) {
      if (heat >= budget.heat || barrels >= budget.barrels) break;
      if (!finite(barrel.x0, barrel.y0, barrel.x1, barrel.y1, barrel.diameter, barrel.temperature, barrel.air, barrel.vx, barrel.vy) || barrel.diameter <= 0) continue;
      const plume = barrelPlume(barrel);
      if (plume.strength < .01) continue;
      const span = Math.abs((barrel.x1 - barrel.x0) * plume.dy - (barrel.y1 - barrel.y0) * plume.dx),
        count = clamp(Math.ceil(span / (6 * barrel.diameter)), 1, 3), ry = plume.height / 2, rx = span / (2 * count) * 1.25 + barrel.diameter / 2,
        up = ry - barrel.diameter / 2, phase = this.flowOf(barrel.id, plume.flow * 11 / (9 * ry)), seed = seedOf(barrel.id), before = this.sources.length;
      for (let i = 0; i < count && heat < budget.heat; i++) {
        const t = (i + .5) / count, start = this.sources.length;
        accept({ mode: 0, actorId: barrel.actorId, x: barrel.x0 + (barrel.x1 - barrel.x0) * t + plume.dx * up, y: barrel.y0 + (barrel.y1 - barrel.y0) * t + plume.dy * up,
          rx, ry, rotation: Math.atan2(-plume.dx, plume.dy), strength: clamp(plume.strength * budget.amplitude, 0, .9), phase, seed: seed + i * 1.7, band: 0 });
        if (this.sources.length > start) heat++;
      }
      if (this.sources.length > before) barrels++;
    }
    for (const [id, kept] of this.flows) if (this.time - kept.time > 2) this.flows.delete(id);
    let fronts = 0;
    for (const wave of effects?.blastWaves?.waves || []) {
      if (fronts >= budget.waves) break;
      const sprite = wave.sprite;
      if (!sprite || !finite(wave.frontRadius, wave.displayAge, wave.displayAlpha, wave.opacity, wave.refraction,
        sprite.x, sprite.y, sprite.width, sprite.height, sprite.rotation, sprite.alpha) || wave.opacity <= 0)
        throw new TypeError('Pressure refraction requires a sampled blast wave.');
      if (!sprite.visible || sprite.alpha < .003) continue;
      const radius = wave.frontRadius,
        rx = radius / .82, aspect = clamp(sprite.height / Math.max(.001, sprite.width), .08, 1), before = this.sources.length,
        age = wave.displayAge;
      // Sampled alpha already includes quality and the front's fast decay; a
      // weaker front, with its fainter edge, bends the air less as well.
      const front = clamp(wave.displayAlpha / wave.opacity, 0, 1);
      accept({ mode: 1, actorId: wave.actorId || null, x: sprite.x, y: sprite.y,
        rx, ry: rx * aspect, rotation: sprite.rotation, strength: .72 * front * wave.refraction,
        phase: age, seed: 0, band: clamp(Math.max(3 / camera.zoom, radius * .045) / rx, .01, .18) });
      if (this.sources.length > before) fronts++;
    }
    return this.sources;
  }
  // The air over a barrel runs at its own pace, which changes as the barrel heats and as the gun moves: its phase is carried
  // on from where it was, rather than taken from the time, for its shimmer not to jump.
  flowOf(id: string, rate: number) {
    const kept = this.flows.get(id);
    if (!kept) { this.flows.set(id, { phase: 0, time: this.time }); return 0; }
    kept.phase += Math.max(0, this.time - kept.time) * rate; kept.time = this.time; return kept.phase;
  }
  // The corners are counted from the lower left of the stretch the sources cover, and the mesh stands
  // there: its buffer is single precision, and holds no place of the world as it is.
  writeGeometry() {
    const left = this.bounds?.left || 0, bottom = this.bounds?.bottom || 0;
    for (let i = 0; i < this.sources.length; i++) {
      const source = this.sources[i]!, c = Math.cos(source.rotation), s = Math.sin(source.rotation);
      for (let vertex = 0; vertex < 4; vertex++) {
        const x = vertex === 0 || vertex === 3 ? -1 : 1, y = vertex < 2 ? -1 : 1, xy = i * 8 + vertex * 2, data = i * 16 + vertex * 4;
        this.positions[xy] = source.x - left + x * source.rx * c - y * source.ry * s;
        this.positions[xy + 1] = source.y - bottom + x * source.rx * s + y * source.ry * c;
        this.coords[xy] = x; this.coords[xy + 1] = y;
        this.params.set([source.mode, source.phase, source.strength, source.seed], data);
        this.basis.set([c, s, source.ry / source.rx, source.band], data);
      }
    }
    // The allocation stays fixed, but bounds must exclude dormant quad slots.
    const x = (this.sources[0]?.x ?? left) - left, y = (this.sources[0]?.y ?? bottom) - bottom;
    for (let i = this.sources.length * 8; i < this.positions.length; i += 2) { this.positions[i] = x; this.positions[i + 1] = y; }
    this.count = this.sources.length;
    if (!this.geometry) return;
    this.mesh!.position.set(left, bottom);
    this.geometry.indexCount = this.count * 6;
    for (const attribute of ['aPosition', 'aCoord', 'aParams', 'aBasis']) this.geometry.getBuffer(attribute).update();
  }
  sample(effects: HeatEffects | null | undefined, camera: EffectCamera, renderer?: RefractionRenderer | null, barrels: readonly HotBarrel[] = []) {
    this.renderer = renderer;
    this.collect(effects, camera, barrels); this.writeGeometry();
    const backBuffer = renderer && 'backBuffer' in renderer ? renderer.backBuffer : undefined,
      active = Boolean(this.count && this.mesh && backBuffer);
    this.host.visible = active; if (this.mesh) this.mesh.visible = active;
    if (backBuffer) backBuffer.useBackBuffer = active;
    if (!active || !this.bounds || !this.filter) return active;
    const budget = settings[this.quality]; this.filter.resolution = budget.resolution;
    this.filter.air.uniforms.uAmplitude = clamp(camera.zoom * .026, 3.4, 8.5);
    this.area.x = this.bounds.left; this.area.y = this.bounds.bottom;
    this.area.width = this.bounds.right - this.bounds.left; this.area.height = this.bounds.top - this.bounds.bottom;
    return active;
  }
  clearPass(renderer: RefractionRenderer | null | undefined) {
    this.sources.length = 0; this.count = 0; this.bounds = null;
    this.host.visible = false; if (this.mesh) this.mesh.visible = false;
    if (renderer && 'backBuffer' in renderer && renderer.backBuffer) renderer.backBuffer.useBackBuffer = false;
  }
  clear(renderer = this.renderer) { this.clearPass(renderer); this.time = 0; this.flows.clear(); }
  destroy(renderer?: RefractionRenderer | null) {
    this.clear(renderer); this.host.filters = null; this.host.destroy({ children: true });
    this.geometry?.destroy(); this.fieldShader?.destroy(); this.filter?.destroy();
  }
}
