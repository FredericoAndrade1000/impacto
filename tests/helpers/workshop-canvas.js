import { createCanvasControls } from '../../src/canvas-controls.ts';
import { createEditorView } from '../../src/project-workspace.ts';
import { Editor } from '../../src/editor.ts';
import { createStructuredTemplate } from '../../src/structured-templates.ts';

import { Camera, FramedCamera } from '../../src/camera.ts';

// Execute the page's actual canvas handlers and notification scheduling. The
// editor is real; only the DOM, display boundary and microtask queue are supplied.
export function workshopCanvas() {
  const draft = createStructuredTemplate('truck'), railY = draft.chassis.points[0].y,
    editor = new Editor({ ...draft, chassis: { ...draft.chassis, points: [{ x: -90, y: railY }, { x: 90, y: railY }] } }),
    listeners = new Map(), queued = [], events = [], captured = new Set(),
    calls = { refresh: 0, draftRefresh: 0, save: 0 }, refreshed = [], saved = [], input = { gesture: null },
    canvas = { style: {}, addEventListener: (type, action) => listeners.set(type, action), focus() {},
      getBoundingClientRect: () => ({ left: 0, top: 0 }),
      hasPointerCapture: id => captured.has(id), setPointerCapture: id => captured.add(id), releasePointerCapture: id => captured.delete(id) };
  // The cabin and its equipment move only when explicitly selected together.
  // The hopper stays separate so the fixture also has a real overlap refusal.
  editor.select([...editor.source.plates.map(plate => plate.id),
    ...editor.source.components.filter(part => part.kind !== 'hopper').map(part => part.id)]);
  const camera = new Camera(844, 390), boardFrame = { x: 0, y: 0, mirror: false },
    renderer = { canvas, ready: true, camera, blueprint: editor.blueprint,
      design(blueprint) { this.blueprint = blueprint; calls.draftRefresh++; },
      board: { camera: new FramedCamera(camera, () => boardFrame, 12) } };
  camera.zoom = 100;
  const context = {
      view: { mode: 'edit', buildTool: 'select', placement: {} }, session: { ready: true }, publication: null,
      initTouch() {}, placing: () => null,
      syncTrigger() {}, toast() {}, reportError: error => { throw error; },
      sound: { cue() {} }, attempt: action => action(),
      document: { querySelector(selector) {
        if (selector !== '#new-module-settings') throw new Error('Unexpected canvas form: ' + selector);
        return { addEventListener() {} };
      } },
      queueMicrotask: action => queued.push(action),
      keepProject() { calls.save++; saved.push(structuredClone(editor.source)); }, meter: { run: (_, action) => action() },
      refreshUI() {
        calls.refresh++; context.refreshDesign(); refreshed.push(editor.source);
      } };
  Object.assign(context, createEditorView({ editor, renderer, meter: context.meter, keepProject: context.keepProject,
    refreshUI: context.refreshUI, queueMicrotask: context.queueMicrotask }));
  const controls = createCanvasControls({ editor, renderer, input, view: context.view, session: context.session,
    document: context.document, touch: context.initTouch,
    effects: { ...context, cue: cue => context.sound.cue(cue), onField: () => false, seen: () => ({}), armour: {} } });
  controls.install();
  const changed = editor.onchange;
  editor.onchange = event => { events.push(event.kind); changed(event); };
  const microtasks = () => { while (queued.length) queued.shift()(); };
  const sendAt = (type, x, y, pointerType = 'mouse', modifiers = {}) => {
    listeners.get(type)({ clientX: x, clientY: y, pointerId: 7, pointerType, button: 0, ...modifiers, preventDefault() {} });
    microtasks();
  };
  const send = (type, dx = 0, dy = 0, pointerType = 'mouse') => {
    const start = input.gesture.start, at = camera.toScreen(start.x + dx, start.y + dy);
    sendAt(type, at.x, at.y, pointerType);
  };
  return { editor, renderer, boardFrame, input, calls, events, captured, refreshed, saved, view: context.view,
    downAt: (x, y, pointerType = 'mouse', modifiers = {}) => sendAt('pointerdown', x, y, pointerType, modifiers),
    upAt: (x, y, pointerType = 'mouse') => sendAt('pointerup', x, y, pointerType),
    begin() {
      editor.begin(); canvas.setPointerCapture(7);
      input.gesture = { type: 'move', start: { sx: 0, sy: 0, ...camera.toWorld(0, 0) }, original: editor.captureSelection(), moved: false };
    },
    // The display boundary executes the same pending flush as an accepted main frame.
    frame(holdArt = false) { context.flushUI(holdArt); microtasks(); },
    moveAt: (x, y, pointerType = 'mouse') => sendAt('pointermove', x, y, pointerType),
    move: (dx, dy = 0, pointerType = 'mouse') => send('pointermove', dx, dy, pointerType),
    end: (type = 'pointerup', pointerType = 'mouse') => send(type, 0, 0, pointerType) };
}
