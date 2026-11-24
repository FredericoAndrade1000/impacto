import { GlProgram, Mesh, Shader, Texture } from 'pixi.js';
import type { DestroyOptions, Geometry } from 'pixi.js';

const vertex = `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
out vec2 vUV;
out vec4 vColor;
void main() {
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vUV = aUV;
    vColor = uColor * uWorldColorAlpha;
}`;
const fragment = `
in vec2 vUV;
in vec4 vColor;
uniform sampler2D uFirst;
uniform sampler2D uSecond;
uniform float uShare;
out vec4 finalColor;
void main() {
    finalColor = mix(texture(uFirst, vUV), texture(uSecond, vUV), uShare) * vColor;
}`;

// The samplers already contain premultiplied RGBA. Mix both colour and coverage
// before compositing this depth over the sky: neither biome is an opaque base.
// A layer owns its geometry and shader; the image cache owns the textures.
export class RangeBlend extends Mesh<Geometry, Shader> {
  constructor(geometry: Geometry) {
    super({ geometry, texture: Texture.EMPTY, shader: new Shader({
      glProgram: GlProgram.from({ name: 'range-blend', vertex, fragment, preferredFragmentPrecision: 'highp' }),
      resources: { uFirst: Texture.EMPTY.source, uSecond: Texture.EMPTY.source,
        blendUniforms: { uShare: { value: 0, type: 'f32' } } },
    }) });
  }
  blend(first: Texture, second: Texture, share: number): void {
    this.texture = first;
    this.shader!.resources.uFirst = first.source;
    this.shader!.resources.uSecond = second.source;
    this.shader!.resources.blendUniforms.uniforms.uShare = share;
  }
  override destroy(options?: DestroyOptions): void {
    const { geometry, shader } = this;
    super.destroy(options); geometry.destroy(); shader!.destroy();
  }
}
