import { clamp } from './math.ts';
import { distance } from './format.ts';
import { clearOf } from './touch.ts';
import type { Point } from './math.ts';

export interface RulerCamera {
  width: number; height: number;
  toWorld(sx: number, sy: number): Point;
  toScreen(x: number, y: number): Point;
}
export interface RulerPointer { sx: number; sy: number }

// The selection's width and height use world coordinates, including when the camera moves or zooms.
// Geometry comes from the camera; no DOM measurement is needed.
export function selectionRuler(camera: RulerCamera, start: Point, pointer: RulerPointer) {
  const end = camera.toWorld(pointer.sx, pointer.sy), anchor = camera.toScreen(start.x, start.y),
    left = clamp(Math.min(anchor.x, pointer.sx), 0, camera.width), right = clamp(Math.max(anchor.x, pointer.sx), 0, camera.width),
    top = clamp(Math.min(anchor.y, pointer.sy), 0, camera.height), bottom = clamp(Math.max(anchor.y, pointer.sy), 0, camera.height),
    label = clearOf(clamp(pointer.sx, 0, camera.width), clamp(pointer.sy, 0, camera.height),
      Math.min(176, Math.max(0, camera.width - 16)), 28, { right: camera.width, bottom: camera.height });
  return { end, box: { left, top, width: right - left, height: bottom - top }, label: { left: label.x, top: label.y },
    text: distance(Math.abs(end.x - start.x)) + ' × ' + distance(Math.abs(end.y - start.y)) };
}
