import type { ColorSource, FillInput, StrokeInput } from 'pixi.js';
import { Color, FillGradient, Graphics } from 'pixi.js';

// What stands behind the vehicles — the works of a base, the workings of a deposit, ruins and trees — is seen through
// a little more air than they are: its colours a little greyer and drawn a little towards the pale of the haze, so
// that its contrast is lower and what is in front stands out against it. The colours are changed as the scenery is
// drawn, once; nothing is filtered on a frame, and the grain of what is painted with a picture keeps its sharpness.

// The pale grey-green of the air, and how much of each colour goes grey (`GREY`) and how much towards it (`HAZE`).
export const AIR = 0xb4bfb8, GREY = .32, HAZE = .16;
const AIR_RGB = [AIR >> 16 & 255, AIR >> 8 & 255, AIR & 255];

// A colour (a number) as it is seen from behind the vehicles, or through `amount` of that haze.
export function recede(color: number, amount = 1) {
  const rgb = [color >> 16 & 255, color >> 8 & 255, color & 255], grey = .299 * rgb[0]! + .587 * rgb[1]! + .114 * rgb[2]!;
  return rgb.reduce((made, c, i) => {
    const greyed = c + (grey - c) * GREY * amount;
    return made << 8 | Math.round(greyed + (AIR_RGB[i]! - greyed) * HAZE * amount);
  }, 0);
}

// A gradient with every stop seen from behind the vehicles: made once for each gradient.
const hazedGradients = new WeakMap<FillGradient, FillGradient>();
function hazedGradient(gradient: FillGradient): FillGradient {
  let made = hazedGradients.get(gradient);
  if (!made) {
    const stops = gradient.colorStops.map(({ offset, color }) => {
      const tone = new Color(color);
      return { offset, color: new Color(recede(tone.toNumber())).setAlpha(tone.alpha).toHexa() };
    });
    made = new FillGradient({ type: gradient.type, textureSpace: gradient.textureSpace, textureSize: gradient['_textureSize'], wrapMode: gradient['_wrapMode'],
      ...gradient.type === 'radial' ? { center: gradient.center, outerCenter: gradient.outerCenter, innerRadius: gradient.innerRadius,
        outerRadius: gradient.outerRadius, scale: gradient.scale, rotation: gradient.rotation } : { start: gradient.start, end: gradient.end },
      colorStops: stops });
    hazedGradients.set(gradient, made);
  }
  return made;
}
// A style of a fill or a line as it is seen from behind the vehicles: its colour or its gradient. A picture is left
// as it is painted.
export function hazedStyle(style: ColorSource): ColorSource;
export function hazedStyle(style: FillInput | StrokeInput | undefined): FillInput | StrokeInput | undefined;
export function hazedStyle(style: FillInput | StrokeInput | undefined): FillInput | StrokeInput | undefined {
  if (typeof style === 'number') return recede(style);
  if (typeof style === 'string') { const tone = new Color(style); return new Color(recede(tone.toNumber())).setAlpha(tone.alpha).toHexa(); }
  if (style instanceof FillGradient) return hazedGradient(style);
  if (!style || typeof style !== 'object' || ('texture' in style && style.texture)) return style;
  if ('fill' in style && style.fill instanceof FillGradient) return { ...style, fill: hazedGradient(style.fill) };
  return 'color' in style && typeof style.color === 'number' ? { ...style, color: recede(style.color) } : style;
}

// A drawing of what stands behind the vehicles: whatever is drawn into it is seen through the haze.
export class HazedGraphics extends Graphics {
  override fill(style?: FillInput): this;
  override fill(color: ColorSource, alpha?: number): this;
  override fill(...args: [style?: FillInput | undefined] | [color: ColorSource, alpha?: number | undefined]): this {
    if (args.length === 2) {
      const [color, alpha] = args;
      return alpha === undefined ? super.fill(hazedStyle(color)) : super.fill(hazedStyle(color), alpha);
    }
    return super.fill(hazedStyle(args[0]));
  }
  override stroke(style?: StrokeInput): this { return super.stroke(hazedStyle(style)); }
}

// A picture (an image or a canvas) as it is seen from behind the vehicles, painted once on a canvas of its own. Trees
// are painted pale already, as they are seen across the field, and are given only `TREE_HAZE` of it.
export const TREE_HAZE = .5;
export function hazedPicture(picture: (CanvasImageSource & { width: number; height: number }), amount = 1) {
  const canvas = Object.assign(document.createElement('canvas'), { width: picture.width, height: picture.height }),
    ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(picture, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height), data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3];
    if (!alpha) continue;
    // The canvas holds its colours apart from their opacity: the haze is laid over the colour alone.
    const color = recede(data[i]! << 16 | data[i + 1]! << 8 | data[i + 2]!, amount);
    data[i] = color >> 16 & 255; data[i + 1] = color >> 8 & 255; data[i + 2] = color & 255;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}
