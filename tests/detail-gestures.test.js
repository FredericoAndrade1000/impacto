import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { Editor } from '../src/editor.ts';
import { DetailEditor } from '../src/detail-editor.ts';
import { within } from '../src/hull-details.ts';
import { DETAIL_LIMIT, VEHICLE_DETAILS, detailAt, detailPose, detailCorners, editableDetailHosts, hostForDetail } from '../src/vehicle-details.ts';
import { DETAIL_GROUPS, TURN_STEP, detailRange, placedDetail, resizedPose, turnedAngle, snappedPoint, movedDetail, detailUnder, hiddenDetail,
  strayDetails, additionSpot, innerPoint, mirroredDetail, copiedDetail } from '../src/detail-gestures.ts';

await initNativeDynamics();
const near = (a, b, why = '') => assert(Math.abs(a - b) < 1e-6, `${a} ≠ ${b} ${why}`);
const hostsOf = blueprint => editableDetailHosts(blueprint);

test('the catalogue groups hold every kind of detail exactly once', () => {
  const grouped = DETAIL_GROUPS.flatMap(group => group.kinds);
  assert.deepEqual([...grouped].sort(), Object.keys(VEHICLE_DETAILS).sort());
  assert.equal(new Set(grouped).size, grouped.length);
  for (const group of DETAIL_GROUPS) assert(group.name && group.kinds.length);
});

test('a detail placed at a pose of the world reads back that pose on the hull, the chassis and a reflected component', () => {
  // A component reflected in its own frame.
  const source = createConstruction('supply'), engine = source.components.find(part => part.id === 'engine');
  engine.pose = { ...engine.pose, mirrored: true };
  const hosts = hostsOf(compileBlueprint(source));
  assert(hosts.find(h => h.host === 'engine').mirrored);
  for (const host of [hosts.find(h => h.surface === 'body'), hosts.find(h => h.surface === 'chassis'), hosts.find(h => h.host === 'engine')]) {
    assert(host, 'every kind of surface is present');
    const detail = { ...detailAt(host, host.pose, 'bin', `on-${host.surface}`), automatic: true },
      at = hostForDetail(hosts, detail), pose = { x: host.pose.x + .1, y: host.pose.y - .05, angle: .4, width: 1.1, height: .5 },
      moved = placedDetail(detail, at, pose), back = detailPose(hostForDetail(hosts, moved), moved);
    near(back.x, pose.x, host.surface); near(back.y, pose.y, host.surface); near(back.angle, pose.angle, host.surface);
    assert.equal(back.mirrored, detailPose(at, detail).mirrored, 'a move keeps the reflection as seen');
    assert.equal(moved.width, 1.1); assert.equal(moved.height, .5);
    assert.equal(moved.automatic, undefined, 'what the player changes is no longer automatic');
  }
});

test('a corner sizes a detail from the opposite corner, in proportion unless free, within its catalogue range', () => {
  const pose = { x: 2, y: 1, angle: Math.PI / 6 }, size = { width: .8, height: .4 }, project = { origin: { x: 0, y: 0 } },
    box = (p, s) => detailCorners(project, { space: 'project', x: p.x, y: p.y, angle: p.angle, width: s.width, height: s.height });
  const before = box(pose, size), grown = resizedPose(pose, size, 2, { x: before[2].x + .2, y: before[2].y + .5 }, 'bin');
  near(grown.width / grown.height, 2, 'proportion kept');
  const after = box(grown, grown);
  near(after[0].x, before[0].x); near(after[0].y, before[0].y, 'the opposite corner stays');
  near(grown.angle, pose.angle);
  const free = resizedPose(pose, size, 2, before[3], 'bin', true), range = detailRange('bin');
  near(free.width, range.width[0], 'taken past the opposite side, the side stops at its smallest');
  near(free.height, size.height, 'the other side follows the pointer alone');
  const huge = resizedPose(pose, size, 2, { x: 50, y: 50 }, 'bin');
  assert(huge.width <= range.width[1] && huge.height <= range.height[1]);
  near(huge.width / huge.height, 2, 'stopped in proportion at the first limit');
  const tiny = resizedPose(pose, size, 1, box(pose, size)[3], 'bin');
  assert(tiny.width >= range.width[0] && tiny.height >= range.height[0]);
});

test('the turn handle settles on steps of fifteen degrees, or anywhere with Shift', () => {
  const centre = { x: 0, y: 0 };
  near(turnedAngle(centre, { x: 0, y: 1 }), 0, 'the handle stands above an upright detail');
  near(turnedAngle(centre, { x: -1, y: 1.02 }), Math.PI / 4);
  near(turnedAngle(centre, { x: -1, y: 1.3 }), 3 * TURN_STEP);
  const free = turnedAngle(centre, { x: -1, y: 1.3 }, true);
  near(free, Math.atan2(1.3, -1) - Math.PI / 2);
  near(turnedAngle(centre, { x: 0, y: -1 }) ** 2, Math.PI ** 2, 'upside down');
});

test('a moved detail settles on the middle of its surface and on the lines of other details, with the lines shown', () => {
  const surface = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 2 }, { x: 0, y: 2 }], size = { width: .4, height: .2 },
    snapped = snappedPoint({ x: 2.03, y: 1.4 }, size, 0, surface, [], .05);
  near(snapped.point.x, 2, 'the middle of the surface'); near(snapped.point.y, 1.4, 'nothing near along the other axis');
  assert.equal(snapped.guides.length, 1);
  near(snapped.guides[0][0].x, 2); near(snapped.guides[0][1].x, 2);
  const other = [{ x: 3, y: .5 }, { x: 3.5, y: .5 }, { x: 3.5, y: .9 }, { x: 3, y: .9 }],
    beside = snappedPoint({ x: 1.2, y: .72 }, size, 0, surface, [other], .05);
  near(beside.point.y, .7, 'the middle of the other detail'); near(beside.point.x, 1.2);
  const far = snappedPoint({ x: 1.2, y: 1.4 }, size, 0, surface, [other], .05);
  assert.deepEqual(far, { point: { x: 1.2, y: 1.4 }, guides: [] });
  const edge = snappedPoint({ x: .22, y: 1.4 }, size, 0, surface, [], .05);
  near(edge.point.x, .2, 'its side on the side of the surface');
});

test('a moved detail goes onto the surface under it, and with Shift exactly where it is taken', () => {
  const blueprint = compileBlueprint(createConstruction('supply')), hosts = hostsOf(blueprint), details = blueprint.appearance.details,
    detail = details.find(d => d.surface === 'body'), host = hostForDetail(hosts, detail), pose = detailPose(host, detail),
    cargo = hosts.find(h => h.host === 'supply'), drag = { detail, host, pose, point: pose },
    free = movedDetail(hosts, details, drag, { x: cargo.pose.x + .013, y: cargo.pose.y + .007 }, { reach: .5, free: true }).detail;
  assert.equal(free.surface, 'part'); assert.equal(free.host, 'supply');
  const at = detailPose(hostForDetail(hosts, free), free);
  near(at.x, cargo.pose.x + .013); near(at.y, cargo.pose.y + .007);
  const settled = movedDetail(hosts, details, drag, { x: cargo.pose.x + .013, y: cargo.pose.y + .007 }, { reach: .05 });
  assert(settled.guides.length, 'within reach of a line it settles and shows it');
});

test('a press takes a detail a few pixels across, and the outline of one that does not show', () => {
  const blueprint = compileBlueprint(createConstruction('truck')), hosts = hostsOf(blueprint), body = hosts.find(h => h.surface === 'body'),
    centre = innerPoint(body.polygon), tiny = detailAt(body, centre, 'marker', 'tiny'), lost = detailAt(body, { x: centre.x + 40, y: centre.y }, 'bin', 'lost');
  assert(!hiddenDetail(body, tiny)); assert(hiddenDetail(hostForDetail(hosts, lost), lost));
  const beside = { x: centre.x + .05, y: centre.y };
  assert.equal(detailUnder(hosts, [tiny], beside, 0), null, 'off it, with no reach');
  assert.equal(detailUnder(hosts, [tiny], beside, .03)?.id, 'tiny', 'within the reach of the pointer');
  assert.equal(detailUnder(hosts, [tiny, lost], { x: centre.x + 40.1, y: centre.y })?.id, 'lost', 'its outline is taken');
  assert.deepEqual(strayDetails(hosts, [tiny, lost]), [], 'a hidden detail still has a surface');
  const gone = { ...detailAt(hosts.find(h => h.surface === 'part'), centre, 'marker', 'gone'), host: 'removed-part' };
  assert.deepEqual(strayDetails(hosts, [tiny, gone]).map(d => d.id), ['gone']);
});

test('a detail added goes to the middle of the view on a surface, or within the nearest one', () => {
  const hosts = hostsOf(compileBlueprint(createConstruction('truck'))), body = hosts.find(h => h.surface === 'body'),
    on = innerPoint(body.polygon), there = additionSpot(hosts, on);
  assert.deepEqual(there.point, on);
  const off = additionSpot(hosts, { x: on.x, y: on.y + 30 });
  assert(off && within(off.point, off.host.polygon), 'within the surface nearest to a view of the sky');
  const notch = [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 3, y: 3 }, { x: 3, y: .5 }, { x: 1, y: .5 }, { x: 1, y: 3 }, { x: 0, y: 3 }];
  assert(within(innerPoint(notch), notch), 'a point within a hollow outline');
});

test('mirror and copy keep the detail and make it the player\'s', () => {
  const detail = { id: 'a', kind: 'cans', surface: 'body', host: 'h', x: 1, y: 2, angle: 0, width: .42, height: .52, space: 'project', automatic: true };
  const { automatic, ...authored } = detail;
  assert(automatic);
  assert.deepEqual(mirroredDetail(detail), { ...authored, mirrored: true });
  assert.deepEqual(mirroredDetail(mirroredDetail(detail)), authored);
  const copy = copiedDetail(detail, 'b');
  assert.equal(copy.id, 'b'); near(copy.x, 1.12); assert.equal(copy.automatic, undefined);
});

// The controller of the page with the drawing's camera and nothing of the page around it.
function controllerFor(source) {
  const editor = new Editor(source), errors = [], view = { mode: 'edit', exterior: true },
    camera = { zoom: 100, turn: 1, width: 1200, height: 800, x: 0, y: 0, cover: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
      toWorld(x, y) { return { x: (x - this.width / 2) / this.zoom + this.x, y: (this.height / 2 - y) / this.zoom + this.y }; } },
    controller = Object.assign(Object.create(DetailEditor.prototype), { editor: () => editor, view, enabled: true, pending: false, arrows: new Set(),
      renderer: { board: { camera } }, canvas: { setPointerCapture() {}, hasPointerCapture: () => false, style: {} }, at: event => event.point,
      toast: message => errors.push(message), render() { this.syncSelection(); }, changed() {} });
  return { editor, controller, camera, errors };
}

test('a detail taken from the catalogue goes in the middle of the view, picked, in one step of the history', () => {
  const source = createConstruction('truck'), { editor, controller, camera, errors } = controllerFor(source),
    body = hostsOf(editor.blueprint).find(h => h.surface === 'body'), middle = innerPoint(body.polygon);
  Object.assign(camera, { x: middle.x, y: middle.y });
  const count = controller.details.length;
  controller.add('headlight');
  assert.equal(controller.details.length, count + 1); assert.equal(editor.past.length, 1); assert.deepEqual(errors, []);
  const added = controller.picked, pose = detailPose(hostForDetail(controller.hosts, added), added);
  assert.equal(added.kind, 'headlight'); near(pose.x, middle.x); near(pose.y, middle.y);
  controller.add('headlight');
  const second = detailPose(hostForDetail(controller.hosts, controller.picked), controller.picked);
  assert(Math.hypot(second.x - pose.x, second.y - pose.y) > .1, 'a second one steps aside from the first');
  assert(editor.undo()); assert(editor.undo()); assert.equal(controller.details.length, count);
});

test('the handles size and turn the detail picked, each drag one step of the history, within the format', () => {
  const { editor, controller, errors } = controllerFor(createConstruction('truck')),
    detail = controller.details.find(d => d.kind === 'armour-door'), host = hostForDetail(controller.hosts, detail), corners = detailCorners(host, detail);
  controller.selected = detail.id;
  const handle = { setPointerCapture() {} }, press = (point, more = {}) => ({ point, pointerId: 1, button: 0, currentTarget: handle,
    preventDefault() {}, stopPropagation() {}, ...more });
  controller.grab(press(corners[2]), 'corner', 2);
  controller.stretch(press({ x: corners[2].x + 5, y: corners[2].y + 5 }));
  controller.let(press(corners[2], { type: 'pointerup' }));
  assert.equal(editor.past.length, 1); assert.deepEqual(errors, []);
  const grown = controller.picked, range = detailRange('armour-door');
  assert(Math.abs(grown.width - range.width[1]) < 1e-9 || Math.abs(grown.height - range.height[1]) < 1e-9, 'stopped where a side is at its largest'); near(grown.width / grown.height, detail.width / detail.height);
  const anchor = detailCorners(hostForDetail(controller.hosts, grown), grown)[0];
  near(anchor.x, corners[0].x); near(anchor.y, corners[0].y);
  const pose = detailPose(hostForDetail(controller.hosts, grown), grown);
  controller.grab(press({ x: pose.x, y: pose.y + 2 }), 'turn', null);
  controller.stretch(press({ x: pose.x - 1, y: pose.y + 1.05 }));
  controller.let(press(pose, { type: 'pointerup' }));
  near(detailPose(hostForDetail(controller.hosts, controller.picked), controller.picked).angle, Math.PI / 4);
  assert.equal(editor.past.length, 2);
  controller.grab(press(pose), 'turn', null);
  controller.stretch(press({ x: pose.x + 1, y: pose.y }));
  controller.let(press(pose, { type: 'pointercancel' }));
  near(detailPose(hostForDetail(controller.hosts, controller.picked), controller.picked).angle, Math.PI / 4, 'a cancelled turn is undone');
  assert.equal(editor.past.length, 2);
  assert(editor.undo()); assert(editor.undo()); assert.deepEqual(controller.picked, detail);
});

test('the arrows move the detail picked as one step of the history, and the actions of its bar are undoable', () => {
  const { editor, controller } = controllerFor(createConstruction('truck')), detail = controller.details[0],
    original = structuredClone(controller.details), start = detailPose(hostForDetail(controller.hosts, detail), detail);
  controller.selected = detail.id;
  for (let i = 0; i < 5; i++) controller.nudge('arrowright', false);
  controller.nudge('arrowup', true);
  assert.equal(editor.past.length, 0, 'still held'); controller.settle();
  assert.equal(editor.past.length, 1);
  const moved = detailPose(hostForDetail(controller.hosts, controller.picked), controller.picked);
  near(moved.x, start.x + .05); near(moved.y, start.y + .1);
  controller.mirror(); assert.equal(Boolean(controller.picked.mirrored), !detail.mirrored);
  controller.duplicate(); assert.notEqual(controller.selected, detail.id); assert.equal(controller.details.length, editor.past[0].blueprint.appearance.details.length + 1);
  controller.copy(); controller.paste(); assert.equal(controller.details.length, editor.past[0].blueprint.appearance.details.length + 2);
  controller.remove(); assert.equal(controller.selected, null);
  assert.equal(editor.past.length, 5);
  while (editor.undo());
  assert.deepEqual(controller.details, original);
});

test('a detail in hand is out of the art of its surface, the same at every step, until it is let go in its place', () => {
  const { editor, controller } = controllerFor(createConstruction('truck')), original = structuredClone(controller.details),
    index = 1, detail = original[index], start = detailPose(hostForDetail(controller.hosts, detail), detail),
    stored = () => editor.source.appearance.details, event = (type, dx, more = {}) => ({ type, button: 0, pointerId: 1, shiftKey: true,
      point: { x: start.x + dx, y: start.y }, clientX: 100 + dx * 100, clientY: 100, preventDefault() {}, stopImmediatePropagation() {}, ...more });
  controller.pointer(event('pointerdown', 0));
  controller.pointer(event('pointermove', .05));
  const art = editor.source.appearance;
  assert(!stored().some(d => d.id === detail.id), 'the art of the surface is painted without it');
  assert.equal(controller.details[index].id, detail.id); assert.equal(controller.details.length, original.length);
  controller.pointer(event('pointermove', .1));
  assert.equal(editor.source.appearance, art, 'its steps do not paint the art anew');
  assert.equal(controller.view.detailEdit.carried.detail.id, detail.id); near(controller.view.detailEdit.carried.pose.x, start.x + .1);
  controller.pointer(event('pointerup', .1));
  assert.equal(controller.view.detailEdit.carried, null); assert.equal(editor.past.length, 1);
  assert.equal(stored()[index].id, detail.id); near(detailPose(hostForDetail(controller.hosts, stored()[index]), stored()[index]).x, start.x + .1);
  controller.pointer(event('pointerdown', .1));
  controller.pointer(event('pointermove', .3));
  controller.pointer(event('pointercancel', .3));
  assert.equal(editor.past.length, 1); near(detailPose(hostForDetail(controller.hosts, stored()[index]), stored()[index]).x, start.x + .1, 'a cancelled drag puts it back');
  assert(editor.undo()); assert.deepEqual(controller.details, original);
});

test('the catalogue is closed when the project has its thirty-two details', () => {
  const source = createConstruction('truck'), first = source.appearance.details[0];
  source.appearance.details = Array.from({ length: DETAIL_LIMIT }, (_, i) => ({ ...first, id: `d-${i}` }));
  const { controller, errors, editor } = controllerFor(source);
  controller.add('marker');
  assert.equal(controller.details.length, DETAIL_LIMIT); assert.equal(editor.past.length, 0);
  assert.match(errors[0], /32/);
  controller.selected = 'd-0'; controller.duplicate(); assert.equal(controller.details.length, DETAIL_LIMIT);
});
