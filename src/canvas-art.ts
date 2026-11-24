export type ArtCanvas = HTMLCanvasElement | OffscreenCanvas;
export type ArtContext = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
export type CanvasFactory<C extends ArtCanvas = ArtCanvas> = (width: number, height: number) => C;
export type CanvasPaint = string | CanvasGradient | CanvasPattern;
export type GradientStop = readonly [number, string];
export type XY = readonly [number, number];

// The painter asks only for a 2D context. Narrow the browser's context union once,
// including workers, without promising that every canvas supports this context.
export function context2d(canvas: ArtCanvas): ArtContext {
  const context = 'transferToImageBitmap' in canvas ? canvas.getContext('2d') : canvas.getContext('2d');
  if (!context) throw new TypeError('Canvas 2D context is not available.');
  return context;
}
