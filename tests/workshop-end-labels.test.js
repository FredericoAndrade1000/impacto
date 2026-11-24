import test from 'node:test';
import assert from 'node:assert/strict';
import { Camera, FramedCamera } from '../src/camera.ts';
import { Editor } from '../src/editor.ts';
import { WorkshopGuides } from '../src/workshop-guides.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { boardSite, BOARD_FACING } from '../src/workshop-site.ts';

// Only the DOM is supplied; the guide is imported directly alongside the real editor and camera.
function guide(editor, mirror = true) {
  const element = () => ({ style: {}, dataset: {}, hidden: false, innerHTML: '', attributes: new Set(),
    toggleAttribute(name, enabled) { if (enabled) this.attributes.add(name); else this.attributes.delete(name); } }),
    node = () => {
      const el = element(), children = new Map(); el.lastChild = element();
      el.querySelector = selector => { if (!children.has(selector)) children.set(selector, element()); return children.get(selector); };
      return el;
    },
    camera = new Camera(1000, 650), frame = { x: 0, y: 0, mirror },
    boardCamera = new FramedCamera(camera, () => frame, 12),
    renderer = { ready: true, board: { ground: { height: () => 0 } } };
  camera.x = 12; camera.y = 1; camera.zoom = 70;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let view;
  try {
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: node } });
    view = new WorkshopGuides({ after() {} }, editor, renderer);
  } finally {
    if (original) Object.defineProperty(globalThis, 'document', original); else delete globalThis.document;
  }
  const { ends, limits } = view;
  return { show: (options = {}) => view.render(boardCamera, { active: true, ...options }), frame, camera: boardCamera,
    labels: () => [ends.left.innerHTML, ends.right.innerHTML].map(html => html.replace(/<[^>]*>/g, '')),
    positions: () => [ends.left.style, ends.right.style].map(style => ({ ...style })),
    touched: () => ['left', 'right', 'top', 'base'].map(side => limits.querySelector(`[data-side=${side}]`).attributes.has('data-at')) };
}

test('the workshop shows every design with its front, its first chassis point, at the right of the screen', () => {
  // The board stands as a construction facing right does, on the bench and on the field alike.
  assert.equal(BOARD_FACING, 1);
  assert.equal(boardSite({ x: 500, y: 0, radius: 60 }, new Editor(createStructuredTemplate('scout')).blueprint).mirror, true);
  for (const name of ['scout', 'heavy', 'truck', 'grader']) {
    const editor = new Editor(createStructuredTemplate(name)), ui = guide(editor); ui.show();
    assert.deepEqual(ui.labels(), ['Trás', 'Frente'], name);
    assert(parseFloat(ui.positions()[0].left) < parseFloat(ui.positions()[1].left), 'arrows stay at the physical screen ends');
    const { front, rear } = editor.blueprint.chassis, first = ui.camera.toScreen(front, 0), last = ui.camera.toScreen(rear, 0);
    assert(first.x > last.x, `${name}: the nose is drawn at the right`);
  }
});

test('the labels follow the board, not the design: an unturned board would show the front at the left', () => {
  const editor = new Editor(createStructuredConstruction()), ui = guide(editor); ui.show();
  const touched = ui.touched();
  assert.deepEqual(ui.labels(), ['Trás', 'Frente']);
  ui.frame.mirror = false; ui.show();
  assert.deepEqual(ui.labels(), ['Frente', 'Trás']);
  ui.frame.mirror = true; ui.show();
  assert.deepEqual(ui.touched(), touched, 'construction limits remain tied to physical sides');
  // The workshop has no edit that turns the whole design about.
  assert.equal(editor.mirrorProject, undefined);
});
