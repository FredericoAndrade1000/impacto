import { GlProgram, Shader, Texture, UniformGroup } from 'pixi.js';

// A tyre turns under a light that does not: the sky on its upper half and its own shade on the half that faces the
// ground (gear-art.ts `shade`). The light lies on the picture of the tyre alone, including the brake drum seen through
// its rim. Between the tread blocks the background stays as it is, with no light on it.
//
// The picture is turned by its mesh, as every picture of a piece is; the shade is read where each place of the picture
// stands once turned by the spin. Both are premultiplied, and the shade is laid over the picture by its coverage.

const vertex = `
in vec2 aPosition;
in vec2 aUV;
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec4 uColor;
uniform float uSpin;
out vec2 vUV;
out vec2 vStill;
out vec4 vColor;
void main() {
    vec3 position = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix * vec3(aPosition, 1.0);
    gl_Position = vec4(position.xy, 0.0, 1.0);
    vUV = aUV;
    // The place in the frame of the wheel (up the picture is up), turned as the mesh turns it, and read back as
    // a place of the still shade, whose rows run down as the picture's do.
    vec2 at = vec2(aUV.x - 0.5, 0.5 - aUV.y);
    float c = cos(uSpin), s = sin(uSpin);
    vStill = vec2(0.5 + c * at.x - s * at.y, 0.5 - s * at.x - c * at.y);
    vColor = uColor * uWorldColorAlpha;
}`;
const fragment = `
in vec2 vUV;
in vec2 vStill;
in vec4 vColor;
uniform sampler2D uTexture;
uniform sampler2D uShade;
out vec4 finalColor;
void main() {
    vec4 picture = texture(uTexture, vUV) * vColor;
    vec4 shade = texture(uShade, vStill);
    finalColor = picture * (1.0 - shade.a) + shade * picture.a;
}`;

// The shader a tyre is drawn with, its own for each tyre: the picture it wears (its mesh tells it, as the mesh's
// texture), the still shade over it — under a fender or out in the open (gear-art.ts) — and how far it has turned.
export class TyreShade extends Shader {
  declare private readonly spinUniforms: UniformGroup<{ uSpin: { value: number; type: 'f32' } }>;
  constructor(shade: Texture) {
    const tyreUniforms = new UniformGroup({ uSpin: { value: 0, type: 'f32' } });
    super({ glProgram: GlProgram.from({ name: 'tyre-shade', vertex, fragment }),
      resources: { uTexture: Texture.EMPTY.source, uShade: shade.source, tyreUniforms } });
    this.spinUniforms = tyreUniforms;
  }
  set texture(texture: Texture) { this.resources.uTexture = texture.source; }
  set shade(texture: Texture) { this.resources.uShade = texture.source; }
  get spin() { return this.spinUniforms.uniforms.uSpin; }
  set spin(value: number) { this.spinUniforms.uniforms.uSpin = value; }
}
