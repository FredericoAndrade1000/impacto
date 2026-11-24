import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { FramePresentation } from '../src/presentation.ts';
import { pickPiece, pickShownPiece } from '../src/editor.ts';
import { regionContains, sampleScene } from '../src/scene-frame.ts';
import { AimPresentation, carried, movedPath } from '../src/weapon-presentation.ts';
import { weaponAngle } from '../src/weapon-geometry.ts';
import { contactMarks } from '../src/faction-ui.ts';
import { Renderer } from '../src/render.ts';
import { managedWorld } from './mechanical-queries.js';

await initNativeDynamics();

// What the page shows of the shared field is a frame a little behind the newest state it holds, between the two states
// about its time (presentation.ts): a construction that goes at 360 m/s, told twenty times a second, is drawn some 27 m
// behind where the newest state has it. What the player presses, and what is drawn over the field, go by the frame.
const SPEED = 360, EVERY = 50;
// The state of a construction `dx` metres on from where it was, going at SPEED.
const moved = (state, dx, time) => ({ ...state, time, shared: true,
  actors: state.actors.map(actor => ({ ...actor, vehicle: actor.vehicle && { ...actor.vehicle, x: actor.vehicle.x + dx, vx: SPEED, vy: 0, omega: 0 } })),
  plates: state.plates.map(plate => ({ ...plate, definition: { ...plate.definition, x: plate.definition.x + dx } })),
  modules: state.modules.map(module => ({ ...module, x: module.x + dx })) });
const middle = plate => ({ x: plate.definition.x, y: plate.definition.y });

test('a piece of a construction going at 360 m/s is picked where the frame draws it, not where the newest state has it', t => {
  const still = managedWorld(t, createConstruction('heavy')).snapshot(), playback = new FramePresentation();
  // States come every 50 ms and the page draws 120 frames a second, as it does on the field: the frame is from 25 to 75 ms
  // behind the newest state, the most as a state comes.
  let sample = null;
  for (let frame = 0, next = 0; frame <= 120; frame++) {
    const now = frame * 25 / 3;
    for (; next * EVERY <= now; next++) playback.receive(moved(still, SPEED * next * EVERY / 1000, next * EVERY / 1000), [], { now: next * EVERY });
    sample = playback.sample(now);
  }
  const { scene } = sample, newest = playback.state, id = newest.actors[0].id,
    behind = newest.actors[0].vehicle.x - scene.actor(id).x;
  assert(Math.abs(behind - SPEED * .075) < .5, `the frame draws the construction ${behind.toFixed(1)} m behind the newest state`);
  let checked = 0;
  for (const plate of newest.plates) {
    const drawn = scene.pose(plate.id), at = { x: drawn.x, y: drawn.y };
    if (pickShownPiece(scene, at) !== plate.id) continue;
    checked++;
    // Read from the newest state, the press finds nothing there; and where that state has the plate nothing is drawn.
    assert.notEqual(pickPiece(newest.plates, newest.modules, at, 0, part => part.material ? regionContains(part, at) : undefined), plate.id);
    assert.notEqual(pickShownPiece(scene, middle(plate)), plate.id);
  }
  assert(checked > 3, 'the plates of the hull are found where they are seen');
  const pieces = newest.modules.filter(module => module.kind !== 'weapon' && pickShownPiece(scene, scene.pose(module.id)) === module.id);
  assert(pieces.length > 0, 'and so are the pieces within it');
  // A piece under a skin not looked into is not found, where it is seen or not.
  const [hidden] = pieces;
  assert.notEqual(pickShownPiece(scene, scene.pose(hidden.id), new Set([hidden.id])), hidden.id);
});

test('at 360 m/s the arc leaves the muzzle the frame draws, and two forecasts of the gun going by are still blended', () => {
  const step = SPEED * EVERY / 1000, first = { time: 0 }, next = { time: EVERY / 1000 }, alpha = .3,
    impact = { x: 1200, y: 290, nx: 0, ny: 1, angleDegrees: 12, time: 2, bounce: null },
    before = { key: 'gun:ground', flight: 2, path: [{ time: 0, x: 0, y: 500 }, { time: 1, x: 600, y: 420 }, { x: 1200, y: 290 }], impact },
    // The gun is 18 m on in the next snapshot, and its round comes down on the same ground.
    current = { ...before, path: [{ time: 0, x: step, y: 500 }, { time: 1, x: 600 + step / 2, y: 420 }, { x: 1200, y: 290 }] },
    drawn = { x: step * alpha, y: 500 }, original = structuredClone([before, current]),
    // As the renderer tells it (`forecastShift`): from the muzzle of each forecast to the one the frame draws; the ground stays.
    shift = forecast => ({ from: { x: drawn.x - forecast.path[0].x, y: drawn.y - forecast.path[0].y }, to: { x: 0, y: 0 } }),
    context = { state: next, previous: first, alpha, now: 50, zoom: 2 };
  const start = () => { const display = new AimPresentation(); display.sample(before, { state: first, previous: null, alpha: 1, now: 0, zoom: 2 }); return display; };
  // Told nothing of the frame, the move of the gun between two snapshots is a jump: the newest forecast is drawn, ahead of the gun.
  assert.equal(start().sample(current, context), current);
  const shown = start().sample(current, { ...context, shift });
  assert.notEqual(shown, current);
  assert(Math.hypot(shown.path[0].x - drawn.x, shown.path[0].y - drawn.y) < 1e-9, 'the arc leaves where the gun is drawn');
  assert(Math.hypot(shown.path.at(-1).x - impact.x, shown.path.at(-1).y - impact.y) < 1e-9, 'and comes down where the round does');
  assert.deepEqual([shown.impact.x, shown.impact.y], [shown.path.at(-1).x, shown.path.at(-1).y]);
  // With no pair to blend — the first frame, a pause, an obstruction — the forecast is drawn moved all the same.
  const alone = new AimPresentation().sample(current, { ...context, reset: true, shift });
  assert(Math.hypot(alone.path[0].x - drawn.x, alone.path[0].y - drawn.y) < 1e-9);
  assert.deepEqual(alone.path.map(point => point.time), [0, 1, 2]);
  assert.deepEqual([before, current], original, 'drawing the forecasts cannot edit them');
  // A gun that did not move is drawn as its forecast was solved.
  assert.equal(new AimPresentation().sample(current, { ...context, reset: true, shift: () => null }), current);
});

test('a path is moved at its start and its end, and between them by the share of its flight', () => {
  const path = [{ time: 0, x: 0, y: 0 }, { time: 1, x: 10, y: 5 }, { time: 3, x: 30, y: 0 }, { x: 40, y: -2 }],
    shown = movedPath(path, 4, { x: 8, y: 4 }, { x: -2, y: 1 });
  assert.deepEqual(shown.map(({ x, y, time }) => [x, y, time]), [[8, 4, 0], [10 + 6 - .5, 5 + 3 + .25, 1], [30 + 2 - 1.5, 1 + .75, 3], [38, -1, 4]]);
  assert.equal(path[0].x, 0, 'the path itself stays as it was');
  const turned = carried({ x: 2, y: 1 }, { x: 1, y: 1, angle: 0 }, { x: 5, y: 3, angle: Math.PI / 2 });
  assert(Math.hypot(turned.x - 5, turned.y - 4) < 1e-12, 'a point carried by a piece turns with it about its place');
});

test('a forecast is drawn from the gun and onto the piece it strikes as the frame draws them; the ground stays', () => {
  const gun = { id: 'gun', actorId: 'a', kind: 'weapon', x: 100, y: 5, angle: 0, barrelAngle: .1 },
    armour = { id: 'armour', actorId: 'b', definition: { x: 400, y: 4, angle: 0, length: 3, thicknessMm: 40 }, material: 'steel' },
    at = (dx, target) => ({ time: dx / SPEED, shared: true, actors: [], plates: [{ ...armour, definition: { ...armour.definition, x: armour.definition.x - target } }],
      modules: [{ ...gun, x: gun.x + dx, barrelAngle: gun.barrelAngle + dx / 1000 }] }),
    previous = at(0, 0), current = at(18, 9), scene = sampleScene(current, previous, .5), renderer = { scene },
    muzzle = { x: current.modules[0].x + Math.cos(.118) * 2, y: 5 + Math.sin(.118) * 2 }, contact = { x: 391 - 1.5, y: 4.5 },
    forecast = { state: current, gun: 'gun', path: [{ time: 0, ...muzzle }, { time: .2, x: 240, y: 9 }, contact],
      impact: { ...contact, owner: { type: 'plate', id: 'armour' } } },
    shift = Renderer.prototype.forecastShift.call(renderer, forecast),
    mouth = carried(muzzle, current.modules[0], scene.pose('gun'), weaponAngle);
  assert(Math.hypot(shift.from.x - (mouth.x - muzzle.x), shift.from.y - (mouth.y - muzzle.y)) < 1e-12);
  assert(Math.abs(shift.from.x + 9) < .01, 'the muzzle is drawn half a step back');
  assert(Math.hypot(shift.to.x - 4.5, shift.to.y) < 1e-9, 'the contact goes with the plate it is on');
  const ground = Renderer.prototype.forecastShift.call(renderer, { ...forecast, impact: { ...contact, owner: { type: 'ground', id: 'ground' } } });
  assert.deepEqual(ground.to, { x: 0, y: 0 });
  assert.equal(Renderer.prototype.forecastShift.call(renderer, { ...forecast, gun: 'another' }), null, 'nothing of a gun the frame does not draw');
});

test('the lead and the marks of what a construction heard stand where the frame draws the constructions', () => {
  const body = x => ({ x, y: 300, angle: 0, vx: SPEED, vy: 0, omega: 0 }),
    state = (x, time) => ({ time, shared: true, controlledActor: 'a', modules: [], plates: [],
      actors: [{ id: 'a', team: 1, vehicle: body(0) }, { id: 'b', team: 2, vehicle: body(x) }],
      contacts: [{ kind: 'sound', by: 'b', side: 1, at: time }] }),
    previous = state(500, 0), current = state(518, .05), scene = sampleScene(current, previous, .5),
    renderer = { camera: { zoom: 2 }, aim: { x: 509, y: 300 }, sceneFor: () => scene },
    lead = Renderer.prototype.movingTarget.call(renderer, current, 1);
  assert.equal(lead.from.x, 509); assert.equal(lead.to.x, 509 + SPEED);
  const [heard] = contactMarks(current, .05, actor => scene.actor(actor.id));
  assert.equal(heard.x, 509);
  assert.equal(contactMarks(current)[0].x, 518, 'read from the state alone, it is where the state has it');
});

test('a press anywhere on the depth of a chassis rail takes the rail, and a piece in front of it the piece', () => {
  const sheet = (id, y, thicknessMm) => ({ id, x: 12, y, length: 6.6, angle: Math.PI, thicknessMm, material: 'steel' }),
    plates = [sheet('a:chassis:frame-0', .896, 8), sheet('a:chassis:rail-0', .664, 8), sheet('a:chassis:top-0', .903, 6)],
    box = { id: 'a:box', kind: 'command', x: 10, y: .78, width: .6, height: .1, angle: 0 };
  // Between its bottom plate and the frame plate over it, nothing but the rail is pressed.
  for (const y of [.7, .78, .85]) assert.equal(pickPiece(plates, [], { x: 13, y }, 0), 'a:chassis:rail-0', `${y} m`);
  assert.equal(pickPiece(plates, [], { x: 15.4, y: .78 }, 0), null, 'past its end');
  assert.equal(pickPiece(plates, [], { x: 13, y: .5 }, 0), null, 'under it');
  assert.equal(pickPiece(plates, [box], { x: 10, y: .78 }, 0), 'a:box');
});
