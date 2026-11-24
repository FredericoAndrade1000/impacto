import test from 'node:test';
import assert from 'node:assert/strict';
import { chassisAxles, chassisLength, chassisSegments, gearProblem,
  straightChassis, suspensionZero, withAxle, withGap, withPoint, withPointAdded, withPointRemoved } from '../src/chassis.ts';
import { constructionCatalogue } from '../src/construction-admission.ts';
import { compileNativeConstruction, initNativeDynamics } from '../src/native-dynamics.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { flyRound, managedWorld } from './mechanical-queries.js';
await initNativeDynamics();

// Points of a chassis, written in cells of 5 cm (grid.ts).
const at = (...points) => points.map(([x, y, gap]) => gap ? { x, y, gap } : { x, y });
const line = (...points) => ({ model: 'wheeled', points: at(...points) });
// A box of thin steel from end to end of the chassis, its floor a cell over the deck, with a command post in it.
const boxed = chassis => {
  const front = chassis.points?.[0]?.x ?? -40, rear = chassis.points?.at?.(-1)?.x ?? 40, corner = i => `hull-${i}`,
    floor = Math.max(0, ...(chassis.points || []).map(point => point.y).filter(Number.isInteger)) + 1;
  return { version: DESIGN_VERSION, preset: 'vehicle', chassis,
    nodes: [[front, 0], [rear, 0], [rear, 24], [front, 24]].map(([x, y], i) => ({ id: corner(i), x, y: y + floor })),
    plates: ['floor', 'rear', 'roof', 'front'].map((side, i) => ({ id: `hull:${side}`, a: corner(i), b: corner((i + 1) % 4), material: 'steel', thicknessMm: 8 })),
    components: [{ id: 'command', kind: 'command', pose: { x: 0, y: floor + 10, angle: 0 } }] };
};
const core = chassis => {
  try { compileNativeConstruction(boxed(chassis), constructionCatalogue(), true); return null; }
  catch (error) { return { code: error.reason, index: error.index }; }
};
const told = problem => problem && { code: problem.code, index: problem.index };
const POINT_CODES = ['FIELD', 'AUTHORING_EXTENT', 'CHASSIS_POINTS', 'CHASSIS_ORDER', 'CHASSIS_SLOPE', 'CHASSIS_GAP'];

test('the native compiler owns chassis point validation, including signed coordinates', () => {
  const many = Array.from({ length: 17 }, (_, i) => [-80 + i * 10, 0]);
  const rise = 10;
  for (const [points, code, index] of [
    [[[-40, 0]], 'CHASSIS_POINTS'], [many, 'CHASSIS_POINTS'],
    [[[-140, 0], [40, 0]], 'FIELD', 0], [[[-40, 0, 'sim'], [40, 0]], 'FIELD', 0],
    // Under the floor of the construction box, or over its top, 8 m up from the floor.
    [[[-40, 0], [40, -28]], 'AUTHORING_EXTENT', 1], [[[-40, 136], [40, 136]], 'AUTHORING_EXTENT', 0],
    [[[-40, 0], [-39, 0], [40, 0]], 'CHASSIS_ORDER', 1],
    [[[-40, 0], [0, 0], [10, 12], [40, 12]], 'CHASSIS_SLOPE', 1],
    [[[-40, 0, true], [0, 0], [40, 0]], 'CHASSIS_GAP', 0], [[[-40, 0], [0, 0, true], [40, 0]], 'CHASSIS_GAP', 1],
    [[[-40, 0], [-20, 0, true], [0, 0, true], [20, 0], [40, 0]], 'CHASSIS_GAP', 2], [[[-40, 0], [0, 0], [40, 0, true]], 'CHASSIS_GAP', 2],
    // Admitted: a gap between two segments, a knee as steep as it may be, collinear points.
    [[[-48, 0], [-20, 0, true], [20, 0], [48, 0]], null], [[[-48, 0], [-20, 0], [-10, rise], [48, rise]], null],
    [[[-48, 0], [0, 0], [48, 0]], null], [[[-48, -8], [48, -2]], null],
  ]) {
    const chassis = line(...points), refused = core(chassis);
    if (code) assert.deepEqual(told(refused), { code, index }, JSON.stringify(points));
    else assert(!POINT_CODES.includes(refused?.code), `${JSON.stringify(points)}: ${refused?.code}`);
  }
});

test('wheel placement follows the chosen x independently of gaps and raised segments', () => {
  // Level with where the model hangs the deck of a frame this long, the suspension reaching its wheels.
  const deck = suspensionZero(line([-60, 0], [60, 0]));
  const chassis = line([-60, deck], [-20, deck, true], [20, deck], [30, deck], [40, deck + 6], [60, deck + 6]);
  assert.deepEqual(chassisSegments(chassis).map(({ index, gap }) => [index, gap]), [[0, false], [1, true], [2, false], [3, false], [4, false], [5, false]].slice(0, 5));
  for (const axles of [[-44, 25], [-44, 0], [-44, 48]]) {
    const shaped = { ...chassis, axles }, problem = gearProblem(shaped);
    assert.equal(problem, null, JSON.stringify(axles));
    assert.equal(core(shaped), null, JSON.stringify(axles));
  }
  const two = { ...line([-60, deck], [-20, deck, true], [20, deck], [60, deck]), axles: [-44, 44] };
  const moved = withAxle(two, 0, .5);
  assert.equal(chassisAxles(moved)[0], .5);
  assert.equal(gearProblem(moved), null); assert.equal(core(moved), null);
});

test('a point is put, moved and taken away, and a segment made a gap and a segment again', () => {
  const straight = straightChassis('wheeled', -40, 40);
  assert.deepEqual(straight, line([-40, -8], [40, -8]));
  // Put on a segment, at its height there, on the nearest cell; none in a gap or at an end.
  const bent = withPoint(withPointAdded(straight, 0), 1, { x: 0, y: 8 });
  assert.deepEqual(bent.points, at([-40, -8], [0, 8], [40, -8]));
  assert.deepEqual(withPointAdded(bent, 20).points, at([-40, -8], [0, 8], [20, 0], [40, -8]));
  assert.deepEqual(withPointAdded(bent, 3).points, at([-40, -8], [3, 6.8], [0, 8], [40, -8]).sort((p, q) => p.x - q.x));
  const gapped = withGap(bent, 0, true);
  assert.deepEqual(gapped.points, at([-40, -8, true], [0, 8], [40, -8]));
  assert.equal(withPointAdded(gapped, -20), null); assert.equal(withPointAdded(straight, -40), null);
  assert.deepEqual(withGap(gapped, 0, false), bent);
  // Taken away, the two segments beside it become one; a gap beside it takes the whole of it; an end stays.
  assert.deepEqual(withPointRemoved(bent, 1), straight);
  const middle = line([-60, 0], [-20, 0, true], [20, 0], [60, 0]);
  assert.deepEqual(withPointRemoved(middle, 2).points, at([-60, 0], [-20, 0, true], [60, 0]));
  assert.deepEqual(withPointRemoved(middle, 1).points, at([-60, 0, true], [20, 0], [60, 0]));
  assert.equal(withPointRemoved(middle, 0), null); assert.equal(withPointRemoved(middle, 3), null);
  assert.equal(chassisLength(middle), 6);
});

test('a round fired up through the gap of the motor grader meets no frame there, but the neck over it', t => {
  const source = createStructuredTemplate('grader'), { points } = source.chassis;
  for (const gap of [true, false]) {
    const design = gap ? source : { ...source, chassis: { ...source.chassis, points: [points[0], points.at(-1)] } };
    const world = managedWorld(t, design), floor = world.plates.find(plate => plate.id === 'bay-2:under-2').definition;
    // From under the frame, 0.9 m along the design, between the blade and the cab: in the gap, or under a whole chassis.
    flyRound(world, { x: 12 + .9, y: floor.y - .6, vx: 0, vy: 400, mass: .01, caliberMm: 7.62, power: 40, radius: .004,
      ammo: 'ap', weapon: 'cannon', age: 0, life: 1, visited: new Set() }, .01);
    const met = world.drainEvents().filter(event => ['penetration', 'blocked', 'ricochet'].includes(event.type) && !event.fragment)
      .map(event => event.id);
    if (gap) assert(met[0] === 'bay-2:under-2' && !met.some(id => id.startsWith('chassis:')), `through the gap to the neck: ${met}`);
    else assert.equal(met[0], 'chassis:frame-0', 'the rail of a whole chassis is in the way');
  }
});
