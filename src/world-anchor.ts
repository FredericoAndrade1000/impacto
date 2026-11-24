export interface AnchorContext {
  instructions: { length: number };
  clear(): unknown;
  resetTransform(): unknown;
  translate(x: number, y: number): this;
}
export interface AnchorGraphics {
  context: AnchorContext;
  position: { set(x: number, y: number): unknown };
}

// A drawing must not hand Pixi the places of the world as they are. Past two hundred vertices Pixi keeps
// those of a drawing in single precision and moves them on the GPU with a single-precision matrix; the
// particles of a container and the corners of a mesh of its own are always kept so. A float tells apart
// places 7.8 mm from one another at 128 km from the origin, five pixels of a close view, and the matrix
// that takes such a place to the screen carries tens of millions of pixels, which it tells to eight.
//
// So whatever is under the world of the renderer stands at an anchor near what it shows and holds only
// what is left of each place once the anchor is taken away: numbers a float keeps to a fraction of a
// millimetre. Pixi works out where the anchor is on the screen in double precision, and that is a small
// number too.
//
// The calls that draw go on stating places of the world. The transform of the context takes the anchor
// from each as it is issued, in double precision, before anything is rounded. Emptying a context resets
// that transform, so a drawing of the world is emptied here and nowhere else: one emptied by `clear()`
// would be drawn its whole anchor away from where it stands.
export function anchorContext<T extends AnchorContext>(context: T, x: number, y: number): T {
  // An empty drawing is left as it is: emptying it again would have Pixi build it once more.
  if (context.instructions.length) context.clear(); else context.resetTransform();
  // Both, always: a translation told one number moves by it along both axes.
  return context.translate(-x, -y);
}

// Empties a drawing and stands it at an anchor, ready for calls that state places of the world.
export function anchorGraphics<T extends AnchorGraphics>(graphics: T, x: number, y: number): T {
  anchorContext(graphics.context, x, y); graphics.position.set(x, y);
  return graphics;
}
