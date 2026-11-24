import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { World } from '../src/physics.ts';
import { Renderer } from '../src/render.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
await initNativeDynamics();

// Four real M777 mechanisms on one fixed construction, pointing along separated high arcs. This tests the arc
// cache rather than relying on a particular stock hull, automatic roof seating or chassis fitting policy. The guns
// stand 3 m apart and .4 m up, written in cells of 5 cm.
function battery() {
  const travel = { min: .35, max: .5 };
  return { version: DESIGN_VERSION, preset: 'bunker', name: 'Bateria', nodes: [], plates: [],
    components: ['weapon', 'gun1', 'gun2', 'gun3'].map((id, i) => ({ id, kind: 'weapon', weaponPreset: 'm777',
      pose: { x: -90 + 60 * i, y: 8, angle: Math.PI / 2 },
      mount: { preset: 'elevated-trunnion', sector: travel, radiusM: .275 } })) };
}

test('the guns switched on show their own arcs, worked out again one a frame and only when the aim or a gun moves', t => {
  const world = new World(battery(), { visualEvents: false }); t.after(() => world.dispose());
  for (let i = 0; i < 120; i++) world.step();
  const lead = world.modules.find(m => m.id === 'weapon'), ahead = Math.cos(lead.angle) >= 0 ? 1 : -1,
    view = { mode: 'test', weapon: { platform: 'vehicle', componentId: 'weapon', charge: 'auto', trajectory: 'auto' },
      linked: new Set(['gun1', 'gun2', 'gun3']), loadouts: {}, aim: { x: lead.x + ahead * 1400, y: world.terrain.height(lead.x + ahead * 1400) } },
    renderer = new Renderer({}, view), state = world.snapshot();
  renderer.playback.state = state;
  // A frame works out one arc: the three guns have theirs by the third frame, and none is for the gun in hand.
  assert.deepEqual([1, 2, 3].map(() => renderer.linkedArcs(state).length), [1, 2, 3]);
  const arcs = renderer.linkedArcs(state);
  for (const [i, id] of ['gun1', 'gun2', 'gun3'].entries()) {
    const gun = state.modules.find(m => m.id === id), { solution, path } = arcs[i];
    // From its own muzzle, at the bearing its barrel has now, with a charge of its own to the aim.
    const barrel = WEAPON_PRESETS.m777.barrel;
    assert(Math.hypot(path[0].x - gun.x - Math.cos(gun.barrelAngle) * barrel, path[0].y - gun.y - Math.sin(gun.barrelAngle) * barrel) < 1e-6, id);
    assert(Math.abs(solution.angle - gun.barrelAngle) < 1e-12, id); assert(path.length > 10);
    assert(renderer.weapon.charges.some(level => level.value === solution.charge), id);
  }
  // Nothing moved: the same arcs, none worked out again.
  assert(renderer.linkedArcs(state).every((arc, i) => arc === arcs[i]));
  // A barrel turned by less than a hundredth of a degree keeps its arc; turned further, that arc alone is worked out again.
  const turned = (id, by) => ({ ...state, modules: state.modules.map(m => m.id === id ? { ...m, barrelAngle: m.barrelAngle + by } : m) });
  let next = turned('gun2', 1e-5); renderer.playback.state = next;
  assert(renderer.linkedArcs(next).every((arc, i) => arc === arcs[i]));
  // A gun moved by less than two centimetres keeps its arc too, but it is drawn from where its muzzle is now: a gun that
  // goes fast is drawn far from where the frame that worked out its arc had it.
  const carried = { ...state, modules: state.modules.map(m => m.id === 'gun1' ? { ...m, x: m.x + .015 } : m) },
    [first] = renderer.linkedArcs(carried);
  assert.equal(first, arcs[0]);
  assert(Math.abs(first.drawn[0].x - first.path[0].x - .015) < 1e-9 && Math.abs(first.drawn.at(-1).x - first.path.at(-1).x) < 1e-9);
  renderer.linkedArcs(state);
  next = turned('gun2', 2e-3); renderer.playback.state = next;
  const moved = renderer.linkedArcs(next);
  assert(moved[0] === arcs[0] && moved[1] !== arcs[1] && moved[2] === arcs[2]);
  assert(Math.abs(moved[1].solution.angle - arcs[1].solution.angle - 2e-3) < 1e-12);
  // Another aim puts every arc out of date: they are worked out again over three frames, the one that waited longest first.
  renderer.playback.state = state; view.aim = { x: view.aim.x + ahead * 50, y: view.aim.y };
  const frames = [1, 2, 3].map(() => renderer.linkedArcs(state));
  assert.deepEqual(frames.map(frame => frame.map((arc, i) => arc !== arcs[i] && arc !== moved[i])),
    [[true, false, false], [true, false, true], [true, true, true]]);
  // A gun switched off has no arc; the bench gun fires alone.
  view.linked.delete('gun3');
  const left = renderer.linkedArcs(state);
  assert(left.length === 2 && left[0] === frames[2][0] && left[1] === frames[2][1]);
  view.weapon = { platform: 'ground', preset: 'm777' };
  assert.deepEqual(renderer.linkedArcs(state), []);
});
