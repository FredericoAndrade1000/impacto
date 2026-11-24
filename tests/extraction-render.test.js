import { SiteMarkers } from '../src/site-markers.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { Renderer } from '../src/render.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { Terrain } from '../src/terrain.ts';
import { MODULES } from '../src/materials.ts';
import { LIFT_HOLD, LIFT_SECONDS } from '../src/work-arm.ts';
import { GraphicsRecorder } from './scenery-canvas.js';

// Presentation snapshots supply compiled health; these tests vary intact versus destroyed tools.
const module = (kind, id = kind) => ({ ...MODULES[kind], id, kind, health: 100, maxHealth: 100, actorId: 'vehicle', attached: true, x: 10, y: 1.5, angle: 0 }),
  frame = (modules, actor = {}) => ({ actors: [{ id: 'vehicle', vehicle: { x: 10, y: 1, angle: 0 }, ...actor }], modules, plates: [] });
function renderer() {
  return Object.assign(Object.create(Renderer.prototype), { siteMarkers: new SiteMarkers(), view: { mode: 'test' }, camera: { zoom: 22 }, ground: new Terrain('flat'),
    unseen: new Set(), drawn: new GraphicsRecorder(), actorLayer() { return this.drawn; } });
}
function draw(r, state, time) { r.scene = sampleScene(state); r.drawn.clear(); r.drawWorkArms(state, time); }
// What a renderer keeps of an arm goes with its piece as designed, whatever the revision of its construction.
const key = part => part.actorId + ':' + part.id;

test('ordinary reservoirs draw no arm even while their cargo grows', () => {
  const r = renderer(), hopper = module('hopper'), cistern = module('cistern');
  draw(r, frame([hopper, cistern]), 1);
  draw(r, frame([{ ...hopper, cargo: { ferro: 8000 } }, { ...cistern, cargo: { petroleo: 2000 } }]), 2);
  assert.equal(r.drawn.calls.length, 0); assert.equal(r.workArms.size, 0);
});

test('only the authoritative active extractors deploy, while ghost, destroyed and detached tools do no work', () => {
  const r = renderer(), tool = module('excavator'), other = module('drill'),
    active = frame([tool, other], { field: { extraction: [{ partId: tool.id, siteId: 'none' }] } });
  draw(r, active, 1); draw(r, active, 1.2); draw(r, active, 1.4);
  const arm = r.workArms.get(key(tool));
  assert.equal(arm.working, true); assert(arm.deployed > 0);
  assert.equal(r.workArms.get(key(other)).working, false); assert.equal(r.workArms.get(key(other)).deployed, 0);
  const before = arm.cycle, deployed = arm.deployed;
  draw(r, { ...active, actors: active.actors.map(actor => ({ ...actor, ghost: { since: 1.4 } })) }, 2);
  assert.equal(arm.working, false); assert.equal(arm.cycle, before); assert.equal(arm.deployed, deployed, 'a ghost does not continue its animation');
  draw(r, frame([{ ...tool, health: 0 }], active.actors[0]), 2.2); assert.equal(arm.working, false);
  draw(r, frame([{ ...tool, attached: false }], active.actors[0]), 2.4); assert.equal(r.workArms.has(key(tool)), false);
  // Two tools of one vehicle at work both deploy.
  const pair = new Array(2).fill().map((_, i) => module('excavator', 'excavator-' + i)),
    both = frame(pair, { field: { extraction: pair.map(part => ({ partId: part.id, siteId: 'none' })) } });
  draw(r, both, 3); draw(r, both, 3.2);
  for (const part of pair) assert.equal(r.workArms.get(key(part)).working, true, part.id);
});

test('extractors follow their own faction tool pace without changing deployment, freeze or foreign activity', () => {
  for (const kind of ['excavator', 'drill']) {
    const tool = module(kind), active = frame([tool], { field: { extraction: [{ partId: tool.id, siteId: 'none' }] } }),
      full = renderer(), half = renderer(), foreign = renderer(),
      fullState = { ...active, faction: { units: [{ id: 'vehicle' }] } },
      halfState = { ...active, faction: { units: [{ id: 'vehicle', tools: { limit: 'power', pace: .5 } }] } },
      foreignState = { ...active, faction: { units: [{ id: 'another-own-vehicle', tools: { limit: 'power', pace: .1 } }] } };
    for (let tick = 0; tick <= 30; tick++) {
      const time = tick / 10;
      draw(full, fullState, time); draw(half, halfState, time); draw(foreign, foreignState, time);
    }
    const fullArm = full.workArms.get(key(tool)), halfArm = half.workArms.get(key(tool)), foreignArm = foreign.workArms.get(key(tool));
    assert.equal(fullArm.deployed, 1, kind); assert.equal(halfArm.deployed, 1, 'deployment keeps its ordinary duration');
    assert(fullArm.cycle > 1, 'the fixture reached the steady work cycle');
    assert(Math.abs(halfArm.cycle - fullArm.cycle * .5) < 1e-9, 'the displayed cycle follows the existing own-faction paid pace');
    assert.equal(foreignArm.cycle, fullArm.cycle, 'an actor absent from the faction roster keeps activity without inferring its power');
    const stoppedCycle = halfArm.cycle;
    draw(half, { ...halfState, actors: frame([tool]).actors }, 3.2);
    assert.equal(halfArm.working, false); assert.equal(halfArm.cycle, stoppedCycle, 'lost authoritative activity freezes the cycle immediately');
  }
});

test('folded, offscreen and distant tools do no extra delivery or terrain work', () => {
  const r = renderer(), tool = module('excavator'), hopper = module('hopper'), state = frame([tool, hopper]);
  r.ground.height = () => { throw Error('inactive arm queried terrain'); };
  draw(r, state, 1); assert.equal(r.workArms.get(key(tool)).deployed, 0);
  r.unseen.add('vehicle'); draw(r, state, 2); assert.equal(r.drawn.calls.length, 0);
  r.unseen.clear(); r.camera.zoom = .1; draw(r, state, 3); assert.equal(r.drawn.calls.length, 0);
});

test('a builder works only while the field says so, and between deliveries sets its load down and waits out a moment', () => {
  const r = renderer(), tool = module('builder'), works = { id: 'site', progress: .5, cost: { ferro: 40, ligas: 0, silica: 10 } },
    state = (field, more = {}) => ({ ...frame([tool], { field, ...more }), faction: { works: [works] } }), idle = state(null);
  r.siteMarkers.marks = new Map([['work:site', { shape: { minX: 14, maxX: 17, minY: 0, maxY: 2 } }]]);
  r.ground.height = () => { throw Error('a folded crane queried terrain'); };
  draw(r, idle, 1); draw(r, idle, 1.2);
  const arm = r.workArms.get(key(tool));
  assert.equal(arm.working, false); assert.equal(arm.deployed, 0); assert(r.drawn.calls.length > 0, 'the folded crane is drawn');
  r.ground = new Terrain('flat');
  draw(r, state({ building: { at: 'site' } }), 2); draw(r, state({ building: { at: 'site' } }), 2.2);
  assert.equal(arm.working, true); assert(arm.deployed > 0); assert.equal(arm.side, 1);
  assert.deepEqual(arm.target.materials, ['ferro', 'silica']); assert.deepEqual(arm.target.boxes, [{ lo: 14, hi: 17, top: 1 }]);
  // Between deliveries it stays out, working no more than to set down the load it lifts; only then it folds.
  const heldOpen = arm.deployed;
  draw(r, idle, 2.2 + LIFT_HOLD - .1);
  const out = arm.deployed;
  assert.equal(arm.working, false); assert(out > heldOpen, 'it goes on out');
  draw(r, idle, 2.2 + LIFT_HOLD + .1); assert.equal(arm.working, false); assert(arm.deployed < out);
  assert.equal(arm.target.boxes[0].top, 1, 'it keeps what it was at while it folds');
  // At its engines' pace.
  const full = state({ building: { at: 'site' } }), slow = state({ building: { at: 'site', pace: .5 } });
  for (let time = 4; time < 5.5; time += .1) draw(r, full, time);
  draw(r, full, 5.5); assert.equal(arm.deployed, 1);
  let before = arm.cycle; draw(r, full, 5.7); const step = arm.cycle - before;
  before = arm.cycle; draw(r, slow, 5.9); assert(step > .19 && Math.abs(arm.cycle - before - step / 2) < 1e-9);
  // Resource starvation stops the work at once, even with a fully open arm mid-cycle: it only sets down what it lifts.
  const deployed = arm.deployed, cycle = arm.cycle, end = Math.ceil(cycle / LIFT_SECONDS) * LIFT_SECONDS;
  assert(cycle > 0); draw(r, idle, 6.1);
  assert.equal(arm.working, false); assert(arm.cycle > cycle && arm.cycle <= end); assert.equal(arm.deployed, deployed);
  let time = 6.1;
  while (arm.finishing && time < 30) draw(r, idle, time += .1);
  assert.equal(arm.cycle, end, 'at the pace it lifted, and no more'); assert.equal(arm.deployed, 1);
  assert(time > 7.4 + LIFT_HOLD, 'past the moment it stays out for');
  draw(r, idle, time + .1); assert(arm.deployed < 1, 'then it folds');
  // A ghost and a destroyed builder do no work.
  const folding = arm.deployed;
  draw(r, state({ building: { at: 'site' } }, { ghost: { since: 6 } }), time + .2);
  assert.equal(arm.working, false); assert.equal(arm.deployed, folding);
  draw(r, { ...frame([{ ...tool, health: 0 }], { field: { building: { at: 'site' } } }), faction: { works: [works] } }, time + .3);
  assert.equal(arm.working, false);
});

test('a builder of the faction standing by a works waits with its crane out over it, and folds it to drive or to turn to another', () => {
  const r = renderer(), tool = module('builder'), works = [{ id: 'east', progress: .3, cost: { ferro: 40, ligas: 0, silica: 0 } },
      { id: 'west', progress: 0, cost: { ferro: 0, ligas: 0, silica: 30 } }],
    state = (job, more = {}, field = null) => ({ ...frame([tool], { field, ...more }), faction: { works, units: [{ id: 'vehicle', job }] } }),
    standing = state({ kind: 'build', phase: 'work', targetId: 'east', reason: '' });
  r.siteMarkers.marks = new Map([['work:east', { shape: { minX: 14, maxX: 17, minY: 0, maxY: 2 } }], ['work:west', { shape: { minX: 5, maxX: 8, minY: 0, maxY: 2 } }]]);
  draw(r, state({ kind: 'build', phase: 'go', targetId: 'east', reason: '' }), 1);
  const arm = r.workArms.get(key(tool));
  assert.equal(arm.deployed, 0);
  for (let time = 1.1; time < 3; time += .1) draw(r, standing, time);
  assert.equal(arm.deployed, 1); assert.equal(arm.working, false); assert.equal(arm.side, 1);
  assert.deepEqual(arm.target.materials, ['ferro']); assert.equal(arm.cycle, 0, 'it waits ready, lifting nothing');
  // Told to build, it lifts at once from where it waited; told no more, it sets its load down and waits again.
  for (let time = 3; time < 6; time += .1) draw(r, state({ kind: 'build', phase: 'work', targetId: 'east' }, {}, { building: { at: 'east' } }), time);
  assert(arm.working && arm.cycle > 2.5);
  for (let time = 6; time < 14; time += .1) draw(r, standing, time);
  assert.equal(arm.deployed, 1); assert.equal(arm.cycle, LIFT_SECONDS);
  // Driving off, it folds; on its way to the other works, it stays folded; by that one, it turns out to it.
  for (let time = 14; time < 15.5; time += .1) draw(r, state({ kind: 'build', phase: 'work', targetId: 'east' }, { vehicle: { x: 10, y: 1, angle: 0, vx: 3, vy: 0 } }), time);
  assert.equal(arm.deployed, 0);
  for (let time = 15.5; time < 16; time += .1) draw(r, state({ kind: 'build', phase: 'go', targetId: 'west' }), time);
  assert.equal(arm.deployed, 0);
  for (let time = 16; time < 18; time += .1) draw(r, state({ kind: 'build', phase: 'work', targetId: 'west' }), time);
  assert.equal(arm.deployed, 1); assert.equal(arm.side, -1); assert.deepEqual(arm.target.materials, ['silica']);
  // A manual builder stands by the nearest; told of a works on the other side of its column, it folds before it turns.
  draw(r, state({ kind: null, phase: 'paused', targetId: null }), 18.1);
  assert.equal(arm.side, -1, 'the west works is nearer');
  draw(r, state(null, {}, { building: { at: 'east' } }), 18.2);
  assert.equal(arm.side, -1); assert(arm.deployed < 1 && !arm.working, 'it folds first');
  for (let time = 18.3; time < 21; time += .1) draw(r, state(null, {}, { building: { at: 'east' } }), time);
  assert.equal(arm.side, 1); assert(arm.working && arm.deployed === 1);
  // Nothing of it stands by what another faction's builder is at, nor while it turns about.
  const other = renderer();
  other.siteMarkers.marks = r.siteMarkers.marks;
  for (let time = 1; time < 3; time += .1) draw(other, { ...frame([tool]), faction: { works, units: [{ id: 'another' }] } }, time);
  assert.equal(other.workArms.get(key(tool)).deployed, 0);
  for (let time = 1; time < 3; time += .1) draw(other, state(null, {}, { wreck: null, service: { kind: 'turn', until: 9 } }), time);
  assert.equal(other.workArms.get(key(tool)).deployed, 0);
});

test('a builder that turned about unfolds its crane again, as the same piece, rather than showing it out at once', () => {
  const r = renderer(), tool = module('builder'), works = [{ id: 'east', progress: .3, cost: { ferro: 40, ligas: 0, silica: 0 } }],
    state = (part, field) => ({ ...frame([part], { field }), faction: { works, units: [{ id: 'vehicle', job: { kind: 'build', phase: 'work', targetId: 'east' } }] } });
  r.siteMarkers.marks = new Map([['work:east', { shape: { minX: 14, maxX: 17, minY: 0, maxY: 2 } }]]);
  for (let time = 1; time < 3; time += .1) draw(r, state(tool, null), time);
  assert.equal(r.workArms.get(key(tool)).deployed, 1);
  for (let time = 3; time < 5; time += .1) draw(r, state(tool, { wreck: null, service: { kind: 'turn', until: 8 } }), time);
  assert.equal(r.workArms.get(key(tool)).deployed, 0, 'it folds to turn');
  draw(r, state({ ...tool, id: 'vehicle:1:builder' }, { building: { at: 'east' } }), 5.1);
  const arm = r.workArms.get(key(tool));
  assert(arm.working && arm.deployed > 0 && arm.deployed < 1, 'and unfolds again'); assert.equal(r.workArms.size, 1);
});

test('the builder of another faction works past its construction at what it is not told of, and one taking a structure down works at its parts', () => {
  const r = renderer(), tool = module('builder');
  r.siteMarkers.marks = new Map([['work:site', { shape: { minX: 14, maxX: 17, minY: 0, maxY: 2 } }]]);
  const outsider = { ...frame([tool], { field: { building: {} } }), faction: { works: [] } };
  draw(r, outsider, 1); draw(r, outsider, 1.2);
  const arm = r.workArms.get(key(tool));
  assert.equal(arm.working, true); assert.equal(arm.target, null);
  const plate = { id: 'wall', actorId: 'post', material: 'concrete', definition: { x: 16, y: 1, angle: Math.PI / 2, length: 2, thicknessMm: 400 } },
    taking = { actors: [{ id: 'vehicle', vehicle: { x: 10, y: 1, angle: 0 }, field: { building: { at: 'post' } } },
      { id: 'post', vehicle: { x: 16, y: 1, angle: 0 }, field: { service: { kind: 'dismantle' } } }], modules: [tool], plates: [plate], faction: { works: [] } },
    other = module('builder', 'second');
  r.workArms.clear(); draw(r, taking, 2); draw(r, taking, 2.2);
  const down = r.workArms.get(key(tool)).target;
  assert.equal(down.down, true); assert.deepEqual(down.materials, ['silica']);
  assert(Math.abs(down.lo - 15.8) < 1e-9 && Math.abs(down.hi - 16.2) < 1e-9 && Math.abs(down.boxes[0].top - 2) < 1e-9);
  // A structure no longer being taken down is nothing to work at.
  draw(r, { ...taking, actors: [taking.actors[0], { ...taking.actors[1], field: null }], modules: [other] }, 3);
  assert.equal(r.workArms.get(key(other)).target, null);
});
