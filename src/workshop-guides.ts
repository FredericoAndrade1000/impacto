import type { Editor } from './editor.ts';
import type { Renderer } from './render.ts';
import type { Camera, FramedCamera } from './camera.ts';
export interface WorkshopGuides { editor: Editor; renderer: Renderer; seen: string; limits: HTMLDivElement; ends: Record<'left' | 'right', HTMLDivElement> }
import { tr } from './i18n.ts';
import { FRAME_REACH } from './frame-editing.ts';
import { clamp } from './math.ts';
import { node, icon } from './dom-view.ts';
import { number } from './format.ts';

// View-only construction limits and end labels. The editor owns all design state.
export class WorkshopGuides {
  constructor(canvas: HTMLCanvasElement, editor: Editor, renderer: Renderer) {
    this.editor = editor; this.renderer = renderer; this.seen = '';
    const limits = this.limits = node('div', 'build-limits'); limits.hidden = true;
    limits.innerHTML = '<i data-side="top"></i><i data-side="left"></i><i data-side="right"></i><i data-side="base"></i><b></b>';
    const end = (side: 'left' | 'right') => { const tag = node('div', 'build-end'); tag.dataset.side = side; tag.hidden = true; return tag; };
    this.ends = { left: end('left'), right: end('right') };
    canvas.after(limits, this.ends.left, this.ends.right);
  }
  render(camera: Camera | FramedCamera, { active, shaping = false, frameGuide = false }: { active: boolean; shaping?: boolean; frameGuide?: boolean }) {
    const { editor, renderer, limits, ends } = this, frame = active && renderer.ready ? editor.blueprint.frame : null,
      turned = camera.turn < 0;
    limits.hidden = !(frame && (shaping || frameGuide)); ends.left.hidden = ends.right.hidden = !frame;
    if (!frame) return;
    const box = { minX: frame.origin.x + FRAME_REACH.minX, maxX: frame.origin.x + FRAME_REACH.maxX,
        minY: frame.origin.y + FRAME_REACH.minY, maxY: frame.origin.y + FRAME_REACH.maxY },
      xs = [...frame.nodes, ...editor.chassisPoints(), ...editor.blueprint.modules].map(point => point.x),
      nose = xs.length ? Math.min(...xs) : frame.origin.x, tail = xs.length ? Math.max(...xs) : frame.origin.x,
      front = nose <= box.minX + 1e-6, rear = tail >= box.maxX - 1e-6,
      line = [...frame.nodes, ...editor.blueprint.chassis?.points || []], under = [...line, ...(editor.blueprint.chassis?.outlines || []).flat()],
      touch = { left: turned ? rear : front, right: turned ? front : rear, top: line.some(point => point.y >= box.maxY - 1e-6),
        base: under.some(point => point.y <= box.minY + 1e-6) },
      low = camera.toScreen(box.minX, box.maxY), high = camera.toScreen(box.maxX, box.minY),
      corner = { x: Math.min(low.x, high.x), y: low.y }, opposite = { x: Math.max(low.x, high.x), y: high.y },
      [left, right] = turned ? [tail, nose] : [nose, tail],
      // An end out of view still says which way it lies.
      stand = (x: number) => clamp(camera.toScreen(x, renderer.board.ground?.height?.(x) || 0).y + 7, 108, camera.height - 78),
      seen = [corner.x, corner.y, opposite.x, opposite.y, nose, tail, turned, touch.left, touch.right, touch.top, touch.base, shaping, camera.width, camera.height].join('|');
    if (seen === this.seen) return;
    this.seen = seen;
    Object.assign(limits.style, { left: corner.x + 'px', top: corner.y + 'px', width: opposite.x - corner.x + 'px', height: opposite.y - corner.y + 'px' });
    limits.toggleAttribute('data-held', shaping);
    for (const side of ['left', 'right', 'top', 'base'] as const) limits.querySelector(`[data-side=${side}]`)!.toggleAttribute('data-at', touch[side]);
    const label = limits.querySelector('b')!;
    label.textContent = tr`Limite da construção · ${number(box.maxX - box.minX, 2)} × ${number(box.maxY - box.minY, 2)} m`;
    label.style.transform = `translate(${Math.max(8, 204 - corner.x)}px, ${Math.max(6, 116 - corner.y)}px)`;
    // The front of a design is its first point, the nose of what drives: on the left as it is written, on the right in a
    // view turned about, as the workshop shows it.
    ends.left.innerHTML = icon('i-arrow-left') + (turned ? tr('Trás') : tr('Frente'));
    ends.right.innerHTML = (turned ? tr('Frente') : tr('Trás')) + icon('i-arrow-right');
    Object.assign(ends.left.style, { left: clamp(camera.toScreen(left, 0).x - 6, 96, camera.width - 14) + 'px', top: stand(left) + 'px' });
    Object.assign(ends.right.style, { left: clamp(camera.toScreen(right, 0).x + 6, 14, camera.width - 104) + 'px', top: stand(right) + 'px' });
  }
}
