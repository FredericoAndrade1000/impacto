import { Geometry, Mesh, Shader, GlProgram, Texture, UniformGroup, BufferImageSource, GpuGraphicsContext, buildContextBatches } from 'pixi.js';
import type { GraphicsContext } from 'pixi.js';
import { Random } from './math.ts';
import { VEGETATION_WAVES } from './vegetation-motion.ts';

export interface SurfaceTerrain { height(x: number): number; materialAt(x: number): string }

// Broad pigment belongs to the map, never to a chunk, the camera or the corners of a mesh. The corners of a bed
// stand up to 256 m apart, and a tone read at them is stretched between them into streaks down the earth and a
// step where two beds meet. So a corner tells only where it lies (`groundPlaces`), and each pixel reads the pigment
// there (`PIGMENT`) from a small lattice of the map's own, which repeats every PIGMENT_CELLS cells either way.
export const PIGMENT_CELLS = 64;
// Broad patches of 32 by 11 m and finer ones of 10 by 4 m: the metres across and down of a cell of each lattice.
export const PIGMENT_PATCHES: readonly [readonly [number, number], readonly [number, number]] = Object.freeze([[32, 11], [10, 4]]);
// A chunk counts its places from a whole number of repeats of both lattices under its left end: the same point reads
// the same pigment in every chunk, and the numbers stay small far from the origin.
export const PIGMENT_REPEAT = 10240;
export function groundPlaces(positions: ArrayLike<number>, terrain: SurfaceTerrain, left: number,
  places: Float32Array = new Float32Array(positions.length * 2)): Float32Array {
  const phase = ((left % PIGMENT_REPEAT) + PIGMENT_REPEAT) % PIGMENT_REPEAT;
  for (let i = 0, at = 0; i < positions.length; i += 2, at += 4) {
    const localX = Number(positions[i]), x = left + localX, y = Number(positions[i + 1]), depth = terrain.height(x) - y;
    places[at] = phase + localX; places[at + 1] = y; places[at + 2] = depth;
    // Concrete near the surface keeps its own colour.
    places[at + 3] = depth < 2.1 && terrain.materialAt(x) === 'concrete' ? 0 : 1;
  }
  return places;
}
export function pigmentTexture(seed: number): Texture {
  const random = new Random((seed ^ 0x6a09e667) >>> 0), data = new Uint8Array(PIGMENT_CELLS * PIGMENT_CELLS * 4);
  for (let i = 0; i < data.length; i += 4) { data[i] = random.next() * 256; data[i + 1] = random.next() * 256; data[i + 3] = 255; }
  return new Texture({ source: new BufferImageSource({ resource: data, width: PIGMENT_CELLS, height: PIGMENT_CELLS,
    format: 'rgba8unorm', alphaMode: 'no-premultiply-alpha', scaleMode: 'linear', addressMode: 'repeat' }) });
}
// Warmer where lighter, fading out between 30 and 100 m under the surface. The filter blends two neighbouring
// cells; the smoothstep eases where between them.
const glsl = (value: number): string => value.toFixed(1), [BROAD, FINE] = PIGMENT_PATCHES.map(([across, down]) => `vec2(${glsl(across)}, ${glsl(down)})`);
const PIGMENT = `
uniform sampler2D uPigment;
vec4 lattice(vec2 p) {
  vec2 cell = floor(p), f = fract(p);
  return texture2D(uPigment, (cell + f * f * (3.0 - 2.0 * f) + 0.5) / ${glsl(PIGMENT_CELLS)});
}
vec3 pigment(vec4 place) {
  float broad = lattice(place.xy / ${BROAD}).r * 2.0 - 1.0, fine = lattice(place.xy / ${FINE}).g * 2.0 - 1.0,
    fade = (1.0 - smoothstep(30.0, 100.0, place.z)) * place.w, light = (0.13 * broad + 0.045 * fine) * fade, warm = 0.035 * broad * fade;
  return vec3(1.0 + light + warm, 1.0 + light, 1.0 + light - warm);
}`;

// Keep Pixi's polygon/stroke tessellation, including paint order, but give this
// solid-colour layer its own simple vertex layout and shader. No texture IDs,
// UVs or packed attributes participate in positioning the surface of the earth.
// Its triangles go by 32-bit indices, as those of every other mesh of the earth do. A 16-bit list held an odd
// number of indices in most chunks, a size in bytes that is no whole number of 4-byte words, the only such list
// the GPU was handed; and in a surface of 65536 corners it would hold 65535, the restart index of WebGL 2.
export function surfaceGeometry(context: GraphicsContext, terrain: SurfaceTerrain | null = null, left = 0): Geometry {
  const built = new GpuGraphicsContext();
  try {
    buildContextBatches(context, built);
    const { vertices, indices } = built.geometryData, positions = new Float32Array(vertices),
      colors = new Float32Array(vertices.length * 2), places = new Float32Array(vertices.length * 2);
    for (const batch of built.batches) {
      if (batch.texture !== Texture.WHITE || batch.topology !== 'triangle-list')
        throw new Error('A ground surface must contain solid triangles only.');
      // Match Graphics' UNORM8 conversion, including its truncation of alpha.
      const packed = batch.color, rgba = [packed & 255, packed >>> 8 & 255, packed >>> 16 & 255, packed >>> 24].map(value => value / 255);
      for (let i = batch.attributeOffset; i < batch.attributeOffset + batch.attributeSize; i++) colors.set(rgba, i * 4);
    }
    if (terrain) groundPlaces(positions, terrain, left, places);
    return new Geometry({ attributes: {
      aPosition: { buffer: positions, format: 'float32x2', stride: 8 },
      aColor: { buffer: colors, format: 'float32x4', stride: 16 },
      aPlace: { buffer: places, format: 'float32x4', stride: 16 },
    }, indexBuffer: new Uint32Array(indices) });
  } finally { built.destroy(); }
}

const vertex = `
precision highp float;
attribute vec2 aPosition;
attribute vec4 aColor;
attribute vec4 aPlace;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uWorldColorAlpha;
varying vec4 vColor;
varying vec4 vPlace;
void main() {
  mat3 matrix = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  gl_Position = vec4((matrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vColor = vec4(aColor.rgb * aColor.a, aColor.a) * uColor * uWorldColorAlpha;
  vPlace = aPlace;
}`;
const fragment = `
precision highp float;
varying vec4 vColor;
varying vec4 vPlace;
${PIGMENT}
void main() { gl_FragColor = vec4(vColor.rgb * pigment(vPlace), vColor.a); }`;

// One program for the surface of every chunk of a map, reading that map's pigment.
export function surfaceShader(pigment: Texture): Shader {
  return new Shader({ glProgram: GlProgram.from({ name: 'ground-surface', vertex, fragment }), resources: { uPigment: pigment.source } });
}
export function surfaceMesh(context: GraphicsContext, terrain: SurfaceTerrain | null, left: number, shader: Shader): Mesh<Geometry, Shader> {
  return new Mesh({ label: 'Ground surface', geometry: surfaceGeometry(context, terrain, left), shader });
}

// The beds and their buried stones keep their shared palette and existing triangles, and read the pigment where
// each pixel lies.
export function strataShader(tones: Texture, pigment: Texture): Shader {
  return new Shader({ glProgram: GlProgram.from({ name: 'ground-strata', vertex: `
precision highp float;
attribute vec2 aPosition;
attribute vec2 aUV;
attribute vec4 aPlace;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uWorldColorAlpha;
varying vec2 vUV;
varying vec4 vPlace;
varying vec4 vColor;
void main() {
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
  vUV = aUV; vPlace = aPlace;
  vColor = uColor * uWorldColorAlpha;
}`, fragment: `
precision highp float;
uniform sampler2D uTexture;
varying vec2 vUV;
varying vec4 vPlace;
varying vec4 vColor;
${PIGMENT}
void main() { gl_FragColor = texture2D(uTexture, vUV) * vec4(pigment(vPlace), 1.0) * vColor; }` }),
  resources: { uTexture: tones.source, uPigment: pigment.source } });
}

// Plants keep their shared atlas and existing triangles. Prepared vertex colour
// needs only this same one-sampler program for either atlas.
export function vegetationUniforms() {
  return new UniformGroup({
    uPlantMotion:{value:new Float32Array(4),type:'vec4<f32>'},
    uPlantGusts:{value:new Float32Array(VEGETATION_WAVES*4),type:'vec4<f32>',size:VEGETATION_WAVES},
    uPlantForces:{value:new Float32Array(VEGETATION_WAVES*4),type:'vec4<f32>',size:VEGETATION_WAVES},
  });
}
export function terrainTextureShader(texture: Texture, motion = vegetationUniforms()): Shader {
  return new Shader({ glProgram: GlProgram.from({ name: 'ground-flora', vertex: `
precision highp float;
attribute vec2 aPosition;
attribute vec2 aUV;
attribute vec4 aColor;
attribute vec4 aPlant;
uniform vec4 uPlantMotion;
uniform vec4 uPlantGusts[${VEGETATION_WAVES}];
uniform vec4 uPlantForces[${VEGETATION_WAVES}];
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform vec4 uWorldColorAlpha;
varying vec2 vUV;
varying vec4 vColor;
void main() {
  vec2 position = aPosition;
  if(aPlant.z>0.0 && (uPlantMotion.z>0.0 || uPlantMotion.w>0.0)) {
    float bend=uPlantMotion.z*(sin(uPlantMotion.x+aPlant.w)*.72+sin(uPlantMotion.x*2.0-aPlant.w*.7)*.28);
    float press=0.0;
    if(uPlantMotion.w>0.0) {
      vec2 root=(uWorldTransformMatrix*uTransformMatrix*vec3(aPlant.xy,1.0)).xy;
      for(int i=0;i<${VEGETATION_WAVES};i++) {
        if(float(i)>=uPlantMotion.w)break;
        vec4 gust=uPlantGusts[i], force=uPlantForces[i];
        vec2 delta=(root-gust.xy)*uPlantMotion.y;
        float distance=length(delta), lag=gust.z-distance/force.y;
        if(distance<gust.w && lag>0.0 && lag<force.z) {
          float envelope=1.0-distance/gust.w;
          float pulse=2.0*sin(lag*9.0)*exp(-lag*4.5)*envelope*envelope*force.x*min(1.0,(force.z-lag)*8.0);
          vec2 direction=delta/max(.05,distance);
          bend+=direction.x*pulse;
          press+=max(0.0,direction.y)*max(0.0,pulse)*.6;
        }
      }
    }
    bend=clamp(bend,-1.1,1.1);
    position+=vec2(bend,-abs(bend)*.35-min(.7,press))*aPlant.z;
  }
  gl_Position = vec4((uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(position, 1.0)).xy, 0.0, 1.0);
  vUV = aUV;
  vColor = aColor * uColor * uWorldColorAlpha;
}`, fragment: `
precision mediump float;
uniform sampler2D uTexture;
varying vec2 vUV;
varying vec4 vColor;
void main() { gl_FragColor = texture2D(uTexture, vUV) * vColor; }` }), resources: { uTexture: texture.source, vegetationUniforms: motion } });
}
