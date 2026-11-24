// The video card can be taken from the page: a reset of its driver, the GPU process of the browser started again, the
// browser freeing it. The canvas of WebGL loses its context with it, and Pixi asks to have it back (GlContextSystem);
// when it comes back the renderer paints again what it lost (Renderer.repaint), and `restored` is told. A context the
// browser has not given back after `CONTEXT_WAIT` milliseconds leaves a page that draws nothing: `gone` is told, once a
// loss, and `restored` still if it comes back after all.
export const CONTEXT_WAIT = 5000;
export interface ContextRecovery { gone(): void; restored(): void }
export function watchContext(canvas: Pick<EventTarget, 'addEventListener'>, { gone, restored }: ContextRecovery): void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  canvas.addEventListener('webglcontextlost', () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; gone(); }, CONTEXT_WAIT);
  });
  canvas.addEventListener('webglcontextrestored', () => { if (timer !== null) clearTimeout(timer); timer = null; restored(); });
}
