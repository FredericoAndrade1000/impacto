// Touch. A finger on the field says what the mouse says, in the gestures the page already takes from the mouse, with
// one of its own: a finger that drags over open ground moves the camera. What a press takes hold of — in the workshop
// a node, a plate, a piece or what is being installed (`grabs`) — the page hears at once, and the finger drags it as
// the mouse would; held still there, it is what the mouse says with Shift, where `held` says so. Anywhere else the
// page hears a finger only once it is clear what the finger does: a tap is a click, two taps a double click; one that
// moves is the camera's; one held still is the page's, and what it does next says how — dragged on, it is the mouse
// dragging from where it was held (a box of selection, a line of aim); let go, it is what the mouse says with its
// other button where `held` says so (an order on the field), and a click anywhere else. Two fingers move and zoom the
// camera: whatever a finger began is called off the moment a second one lands — the page hears a cancel, as of any
// pointer, when it heard that finger at all. When one of the two is lifted, the other goes on moving the camera, with
// no need to lift it and put it down again: a pinch runs straight into a drag.
//
// The way the player last pointed, 'touch' or 'mouse', is on the root of the page for the styles, and a finger takes
// hold of what lies farther from it than the mouse does.

import type { Point } from './math.ts';

export interface LabelArea { left?: number; top?: number; right: number; bottom: number }
export interface LabelPosition extends Point { room?: number }
export type HoldKind = 'secondary' | 'shift';
export interface TouchOptions {
  canvas: HTMLCanvasElement;
  zoom: (factor: number, x: number, y: number) => void;
  pan: (dx: number, dy: number) => void;
  grabs?: (x: number, y: number) => boolean;
  held?: (x?: number, y?: number) => HoldKind | null;
  holding?: () => number | null;
  changed?: () => void;
  shown?: (x: number, y: number) => Point | null;
}
type FingerState = 'page' | 'open' | 'held' | 'camera' | 'spent';
interface Finger extends Point { id: number; x0: number; y0: number; at: number; state: FingerState }
interface Pinch extends Point { ids: readonly [number, number]; span: number }
interface Tap extends Point { at: number }
type ToldEvent = 'pointerdown' | 'pointerup' | 'pointermove' | 'pointercancel' | 'dblclick';

export const HOLD_MS = 450, STILL_PX = 10;
const TAP_MS = 300;
// A finger held still is shown its hold filling, where the page says: a ring that comes a third of the way into the hold
// — a tap never sees it —, is full the moment the hold takes, and then pulses for `PULSE_MS`, as the device buzzes.
export const RING_FROM = 1 / 3, PULSE_MS = 260;
// How soon and how near after a tap a second one is a double click with it.
export const TWICE_MS = 350, TWICE_PX = 28;
let way = globalThis.matchMedia?.('(pointer: coarse)').matches ? 'touch' : 'mouse';
export const touching = () => way === 'touch';
// What a pointer takes hold of within `pixels` of it, a finger takes within twice that.
export const reach = (pixels: number): number => touching() ? pixels * 2 : pixels;
// How far above a finger what tells of the point under it is shown, in pixels: a fingertip covers some 45 px about
// where it touches, and the hand comes from below.
export const LIFT = 64;
// Where a label `width` × `height` pixels that tells of the point (x, y) stands, in the `area` of the view no panel
// covers (`left`, `right`, `bottom`, and `top`, 0 if not said): its foot `gap` pixels above the point, or `lift` above
// it, `LIFT` by default, where a finger may be on it; with no room for it there, beside the point, on the side with
// more room, and never out of the area. The middle of its foot, where a label drawn up from (`translate(-50%, -100%)`)
// is set, and beside the point the width there is room for (`room`).
export function clearOf(x: number, y: number, width: number, height: number, { left = 0, top = 0, right, bottom }: LabelArea, gap = 18, lift = LIFT): LabelPosition {
  lift = touching() ? lift : gap;
  const edge = 8,
    across = (value: number) => Math.max(left + width / 2 + edge, Math.min(right - width / 2 - edge, value));
  if (y - lift - height >= top + edge) return { x: across(x), y: y - lift };
  // Beside it, as far off as above, at its height.
  const after = right - edge - (x + lift), before = x - lift - (left + edge), side = after > before ? 1 : -1;
  return { x: across(x + side * (lift + width / 2)), y: Math.min(bottom - edge, Math.max(top + height + edge, y + height / 2)),
    room: Math.max(after, before) };
}
// A finger the page hears of only as it is let go has no pointer left to capture by then.
export const capture = (element: Element, pointerId: number): void => { try { element.setPointerCapture(pointerId); } catch {} };

// `zoom(factor, x, y)` and `pan(dx, dy)` move the camera in pixels of the canvas. `grabs(x, y)` says whether a press
// there takes hold of something, in pixels of the window. `held(x, y)` says what a finger held still there is:
// 'secondary', a press and a release of the other button; 'shift', on what it took hold of, a press with Shift that the
// finger goes on with; or nothing. `holding()` is how long, in milliseconds, a finger is to stay still to be held, when it is
// not the usual: a gun is aimed by a finger held and dragged, and that wants to be quick. `changed()` is told when
// the way the player points changes. `shown(x, y)` says where, in pixels of the window, a finger held still there that
// a hold would do something for is shown the hold filling — about what it would take hold of —, or that it is not.
export function initTouch({ canvas, zoom, pan, grabs = () => false, held = () => null, holding = () => null, changed = () => {}, shown = () => null }: TouchOptions): void {
  const root = document.documentElement, fingers = new Map<number, Finger>();
  let pinch: Pinch | null = null, timer: ReturnType<typeof setTimeout> | 0 = 0, tapped: Tap | null = null,
    telling = false, canvasClick: number | null = null, ring: HTMLDivElement | null = null,
    ringTimer: ReturnType<typeof setTimeout> | 0 = 0, pulseTimer: ReturnType<typeof setTimeout> | 0 = 0;
  root.dataset.input = way;
  // An event the page hears on behalf of a finger, through every handler but these.
  const tell = (type: ToldEvent, finger: Finger, init: PointerEventInit = {}) => {
    telling = true;
    try {
      canvas.dispatchEvent(new (type === 'dblclick' ? MouseEvent : PointerEvent)(type, { bubbles: true, cancelable: true, composed: true,
        pointerId: finger.id, pointerType: 'touch', isPrimary: true, clientX: finger.x, clientY: finger.y, button: 0, buttons: 1, ...init }));
    } finally { telling = false; }
  };
  const cancel = (finger: Finger) => tell('pointercancel', finger, { button: -1, buttons: 0 });
  const click = (finger: Finger, button = 0) => { tell('pointerdown', finger, { button, buttons: button ? 2 : 1 }); tell('pointerup', finger, { button, buttons: 0 }); };
  const quiet = (event: Event) => { event.stopImmediatePropagation(); event.preventDefault(); };
  // A hold called off: what was waiting for it is not, and its ring goes, unless it is pulsing a hold taken.
  const rest = () => {
    clearTimeout(timer); clearTimeout(ringTimer); timer = ringTimer = 0;
    if (ring && !ring.hasAttribute('data-armed')) ring.hidden = true;
  };
  const middle = ([a, b]: readonly [Point, Point]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, span: Math.hypot(a.x - b.x, a.y - b.y) });
  const away = (finger: Finger) => Math.hypot(finger.x - finger.x0, finger.y - finger.y0) > STILL_PX;
  const pointing = (event: PointerEvent) => {
    const capabilities = 'sourceCapabilities' in event ? event.sourceCapabilities : null;
    if (telling || event.pointerType !== 'touch' && capabilities && typeof capabilities === 'object' &&
        'firesTouchEvents' in capabilities && capabilities.firesTouchEvents) return;
    const now = event.pointerType === 'touch' ? 'touch' : 'mouse';
    if (now !== way) { way = now; root.dataset.input = way; changed(); }
  };

  // A finger is 'page' once the page has heard its press, 'open' while it waits over open ground, 'held' once it was
  // held still there, 'camera' while it moves the camera, and 'spent' when the page hears no more of it.
  function hold(finger: Finger): void {
    timer = 0;
    if (fingers.size !== 1) return;
    if (finger.state === 'open') { navigator.vibrate?.(12); pulse(); tapped = null; finger.state = 'held'; return; }
    const kind = finger.state === 'page' ? held(finger.x, finger.y) : null;
    if (!kind) { rest(); return; }
    navigator.vibrate?.(12); pulse(); tapped = null; cancel(finger);
    if (kind === 'secondary') { click(finger, 2); finger.state = 'spent'; } else tell('pointerdown', finger, { shiftKey: true });
  }
  // The ring of a finger held still, where the page shows it when a hold would do something for the finger; made the
  // first time it is shown, over the page and in the way of nothing.
  function showRing(finger: Finger, duration: number): void {
    ringTimer = 0;
    const at = fingers.size === 1 && (finger.state === 'open' || finger.state === 'page' && held(finger.x, finger.y)) && shown(finger.x, finger.y);
    if (!at) return;
    if (!ring) {
      ring = document.createElement('div'); ring.className = 'hold-ring'; ring.hidden = true;
      ring.innerHTML = '<svg viewBox="0 0 40 40" aria-hidden="true"><circle cx="20" cy="20" r="17"/><circle cx="20" cy="20" r="17" pathLength="100"/></svg>';
      document.body.append(ring);
    }
    clearTimeout(pulseTimer); ring.removeAttribute('data-armed'); ring.hidden = true;
    ring.style.left = at.x + 'px'; ring.style.top = at.y + 'px'; ring.style.setProperty('--fill', Math.round(duration * (1 - RING_FROM)) + 'ms');
    // Shown again, it fills again from empty.
    void ring.offsetWidth; ring.hidden = false;
  }
  // The hold taken: its ring pulses, and goes.
  function pulse() {
    if (!ring || ring.hidden) return;
    ring.setAttribute('data-armed', ''); clearTimeout(pulseTimer);
    pulseTimer = setTimeout(() => { if (ring) { ring.hidden = true; ring.removeAttribute('data-armed'); } }, PULSE_MS);
  }

  document.addEventListener('pointerdown', event => {
    if (telling) return;
    canvasClick = null;
    pointing(event);
    if (event.pointerType !== 'touch' || event.target !== canvas) return;
    const finger: Finger = { id: event.pointerId, x: event.clientX, y: event.clientY, x0: event.clientX, y0: event.clientY, at: event.timeStamp, state: 'open' };
    fingers.set(finger.id, finger);
    if (fingers.size === 1) {
      if (grabs(event.clientX, event.clientY)) finger.state = 'page'; else quiet(event);
      const duration = holding() ?? HOLD_MS;
      timer = setTimeout(hold, duration, finger); ringTimer = setTimeout(showRing, duration * RING_FROM, finger, duration); return;
    }
    quiet(event); finger.state = 'spent';
    if (fingers.size > 2 || pinch) return;
    // The second finger: what the first began is called off, and the two are the camera's.
    rest(); tapped = null;
    const [first] = fingers.values();
    if (!first) return;
    if (first.state === 'page') cancel(first);
    first.state = 'spent';
    pinch = { ids: [first.id, finger.id], ...middle([first, finger]) };
  }, true);

  document.addEventListener('pointermove', event => {
    // A real mouse resumes the desktop controls on hybrids. Compatibility events
    // emitted by a finger, and a mouse moving during an active gesture, do not.
    if (event.pointerType === 'mouse' && !fingers.size) pointing(event);
    const finger = !telling && fingers.get(event.pointerId);
    if (!finger) return;
    const dx = event.clientX - finger.x, dy = event.clientY - finger.y;
    finger.x = event.clientX; finger.y = event.clientY;
    if (finger.state === 'page') { if (away(finger)) rest(); return; }
    quiet(event);
    if (finger.state === 'open') {
      if (!away(finger)) return;
      // Off it goes over open ground: the camera follows the finger, from where it was put down.
      rest(); tapped = null; finger.state = 'camera'; pan(finger.x - finger.x0, finger.y - finger.y0);
    } else if (finger.state === 'camera') pan(dx, dy);
    else if (finger.state === 'held') {
      if (!away(finger)) return;
      // Held, then dragged on: the mouse dragging from where the finger was held.
      finger.state = 'page'; tell('pointerdown', { ...finger, x: finger.x0, y: finger.y0 }); tell('pointermove', finger);
    } else if (pinch?.ids.includes(finger.id)) {
      const a = fingers.get(pinch.ids[0]), b = fingers.get(pinch.ids[1]);
      if (!a || !b) return;
      const now = middle([a, b]), box = canvas.getBoundingClientRect();
      if (pinch.span > 0 && now.span > 0) zoom(now.span / pinch.span, pinch.x - box.left, pinch.y - box.top);
      pan(now.x - pinch.x, now.y - pinch.y);
      Object.assign(pinch, now);
    }
  }, true);

  const lift = (event: PointerEvent) => {
    const finger = !telling && fingers.get(event.pointerId);
    if (!finger) return;
    canvasClick = finger.id;
    fingers.delete(finger.id); rest();
    const up = event.type === 'pointerup', state = finger.state,
      tap = up && (state === 'page' || state === 'open') && event.timeStamp - finger.at < TAP_MS && !away(finger);
    if (state !== 'page') {
      // What the page has not heard of a finger, it hears now that it is clear what the finger did.
      quiet(event);
      if (pinch?.ids.includes(finger.id)) {
        // The finger left of the two goes on with the camera from where it is.
        const other = fingers.get(pinch.ids[0] === finger.id ? pinch.ids[1] : pinch.ids[0]);
        if (other) other.state = 'camera';
        pinch = null;
      }
      if (up && state === 'open') click(finger);
      else if (up && state === 'held') click(finger, held() === 'secondary' ? 2 : 0);
      if (state !== 'open') return;
    }
    if (tap && tapped && event.timeStamp - tapped.at < TWICE_MS && Math.hypot(finger.x - tapped.x, finger.y - tapped.y) < TWICE_PX) {
      // The second tap is a double click, once the page has heard the end of it.
      tapped = null; setTimeout(() => tell('dblclick', finger, { detail: 2, buttons: 0 }));
    } else tapped = tap ? { at: event.timeStamp, x: finger.x, y: finger.y } : null;
  };
  document.addEventListener('pointerup', lift, true);
  document.addEventListener('pointercancel', lift, true);
  // The canvas already handles this gesture through pointer events. A panel
  // opened by its selection can stand under the finger before the browser's
  // click arrives; that click must not activate a newly appeared button.
  // The next physical press clears this token, including a normal button tap.
  document.addEventListener('click', event => {
    if (event.pointerType !== 'touch' || event.pointerId !== canvasClick) return;
    canvasClick = null; quiet(event);
  }, true);
  // The browser's own double click of two taps is not heard: the page hears the one said above, once.
  document.addEventListener('dblclick', event => { if (!telling && way === 'touch') quiet(event); }, true);
}

// The stick a finger flies a vehicle with on a phone, in place of the pedals (ui-model.ts `driveIntent`): pushed from the
// middle of `element`, it asks along the field and up as far as it is pushed each way, out to its rim, in tenths, and
// nothing within `STICK_STILL` of the middle, for a vehicle that is let be to hover. Its knob goes where the finger is,
// and back to the middle once it is let go. `changed(stick)` is told whenever what it asks changes: `{ x, y }` from -1
// to 1, and null once it is let go.
export const STICK_STILL = .15;
export interface StickPosition extends Point {}
export interface StickSample extends StickPosition { knob: Point }
export function stickAt(dx: number, dy: number): StickSample {
  const far = Math.hypot(dx, dy), inside = far > 1 ? 1 / far : 1,
    step = (value: number) => Math.abs(value) < STICK_STILL ? 0 : Math.round(value * 10) / 10;
  return { x: step(dx * inside), y: step(dy * inside), knob: { x: dx * inside, y: dy * inside } };
}
export function initStick(element: HTMLElement, changed: (stick: StickPosition | null) => void): void {
  const knob = element.querySelector('.touch-stick-knob');
  if (!(knob instanceof HTMLElement)) throw new Error('Missing touch stick knob');
  let finger: number | null = null, asked: StickPosition | null = null;
  const tell = (stick: StickPosition | null) => { if (stick?.x === asked?.x && stick?.y === asked?.y) return; asked = stick; changed(stick); };
  const follow = (event: PointerEvent) => {
    const box = element.getBoundingClientRect(), radius = box.width / 2,
      { x, y, knob: at } = stickAt((event.clientX - box.left - radius) / radius, (box.top + radius - event.clientY) / radius);
    knob.style.transform = `translate(${(at.x * radius * .54).toFixed(1)}px, ${(-at.y * radius * .54).toFixed(1)}px)`;
    tell({ x, y });
  };
  element.addEventListener('pointerdown', event => {
    if (finger !== null) return;
    event.preventDefault(); finger = event.pointerId; capture(element, finger); follow(event);
  });
  element.addEventListener('pointermove', event => { if (event.pointerId === finger) follow(event); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) element.addEventListener(type, event => {
    if (event.pointerId !== finger) return;
    finger = null; knob.style.transform = ''; tell(null);
  });
}
