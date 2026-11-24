import test from 'node:test';
import assert from 'node:assert/strict';

import { createPlacementControls } from '../src/workshop-ux.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { Editor } from '../src/editor.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { mountChoices } from '../src/piece-settings.ts';
import { WEAPON_MOUNTS, defaultWeaponMount } from '../src/weapon-mounts.ts';
import { createStructuredConstruction, PART_LIMITS } from '../src/structured-construction.ts';
import { structuredComponent } from '../src/structured-editing.ts';
import { mountedWeaponPolygons, weaponAngle } from '../src/weapon-geometry.ts';
import { unitsOf } from '../src/grid.ts';

import { AimQueries } from '../src/aim-queries.ts';
import { sampleScene } from '../src/scene-frame.ts';
import { weaponSettings } from '../src/weapons.ts';
import { presentedPivotVelocity } from '../src/weapon-presentation.ts';
import { firingSolution, flightState, mountedFiringSolution } from '../src/ballistics.ts';
import { assertMountProjection } from './helpers/weapon-mount-shape.js';
import { workshopCanvas } from './helpers/workshop-canvas.js';
import { workspaceDOM } from './helpers/dom.js';
await initNativeDynamics();
test('a weapon defaults to the mount of its model and permits an explicit compatible choice before or after placement', () => {
  const source = createStructuredConstruction({ length: 6, height: 3, thicknessMm: 8, frontInset: 0, rearInset: 0 }),
    pivot = { x: 8, y: 2.8 };
  // A model alone still has the full catalogue mount and sector; an explicit mounting choice is optional.
  const editor = new Editor(source), part = editor.addModule('weapon', pivot, { weaponPreset: 'm2hb', ammoPreset: 'm2hb', sensorMode: 'visual' }),
    authored = editor.source.components.find(component => component.id === part.id), mount = defaultWeaponMount('m2hb');
  assert.equal(authored.mount.preset, mount); assert.equal(part.weaponMount.preset, mount);
  assert(authored.mount.sector.min >= WEAPON_MOUNTS[mount].min && authored.mount.sector.max <= WEAPON_MOUNTS[mount].max);
  assertMountProjection(part);
  // Where a model has more than one mount to stand on, each says what tells it from the others: a machine gun has
  // the light one and the one on the roof, out in the open.
  assert.deepEqual(mountChoices('m2hb').map(choice => choice.id), [mount, 'pintle']);
  const howitzer = new Editor(createConstruction('howitzer')), gun = howitzer.blueprint.modules.find(m => m.kind === 'weapon'),
    placed = () => howitzer.source.components.find(component => component.id === gun.id).mount, choices = mountChoices(gun.weaponPreset);
  assert.deepEqual(choices.map(choice => choice.id).sort(), ['elevated-trunnion', 'heavy-trunnion']);
  for (const choice of choices) {
    assert.equal(choice.name, WEAPON_MOUNTS[choice.id].name);
    assert.match(choice.detail, /^−\d+° a \+\d+° · \d+°\/s · \d+ mm · [\d.]+ cr$/);
  }
  const other = choices.find(choice => choice.id !== placed().preset).id, before = structuredClone(howitzer.source);
  howitzer.select(gun.id); howitzer.editProperty('mountPreset', other, true);
  assert.equal(placed().preset, other); assert.equal(howitzer.selected.weaponMount.preset, other);
  assertMountProjection(howitzer.selected);
  assert(placed().sector.min >= WEAPON_MOUNTS[other].min && placed().sector.max <= WEAPON_MOUNTS[other].max);
  howitzer.undo(); assert.deepEqual(howitzer.source, before);
});

test('the placement form offers compatible mounting choices before any weapon is installed', t => {
  const dom = workspaceDOM(t), cost = dom.create('div', 'component-placement-cost'),
    editor = new Editor(createStructuredConstruction({ length: 6, height: 3, thicknessMm: 8 })),
    view = { mode: 'edit', buildTool: 'module', placement: { kind: 'weapon', weaponPreset: 'm2hb' } },
    before = structuredClone(editor.source), history = editor.past.length;
  cost.before = control => cost.parentNode.insertBefore(control, cost);
  const context = {};
  context.describePlacementSettings = createPlacementControls({ editor, view, refresh: () => context.describePlacementSettings() });
  context.describePlacementSettings();
  const control = document.querySelector('#placement-mount-preset');
  assert(control && !control.parentNode.hidden && !control.parentNode.parentNode.hidden);
  assert.deepEqual(control.children.map(option => option.value), ['', ...mountChoices('m2hb').map(choice => choice.id)]);
  assert.equal(control.value, '', 'surface adaptation is the default; compatible mounts remain explicit choices');
  control.value = 'pintle'; control.dispatch('change');
  assert.equal(view.placement.mountPreset, 'pintle');
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history);
  const gun = editor.addModule('weapon', { x: 17, y: 6 }, view.placement);
  assert.equal(gun.weaponMount.preset, 'pintle'); assert(gun.weaponMount.exposed);
  view.placement = { kind: 'weapon', weaponPreset: 'rh120' }; context.describePlacementSettings();
  assert(!control.children.some(option => option.value === 'pintle'), 'a heavy cannon never receives an incompatible external post');
});

test('canvas weapon drops validate the release coordinate, with the same physical post and transactional history', () => {
  const f = workshopCanvas(), lower = f.editor.addPlate({ x: 16, y: 4 }, { x: 18, y: 4 }),
    upper = f.editor.addPlate({ x: 16, y: 6 }, { x: 18, y: 6 });
  f.view.buildTool = 'module'; f.view.placement = { kind: 'weapon', weaponPreset: 'm2hb', mountPreset: 'pintle' };
  const at = f.renderer.board.camera.toScreen(17, lower.y);
  f.moveAt(at.x, at.y);
  const preview = f.renderer.modulePreview.modules[0];
  assert(!f.renderer.modulePreview.refused); assert.equal(preview.weaponMount.hostId, lower.id);
  assert(Math.abs(Math.min(...mountedWeaponPolygons(preview)[0].map(point => point.y)) - lower.y - lower.thicknessMm / 2000) < 1e-10);
  f.downAt(at.x, at.y); f.upAt(at.x, at.y);
  const gun = f.editor.selected, before = structuredClone(f.editor.source), history = f.editor.past.length,
    authored = () => f.editor.source.components.find(part => part.id === gun.id), configuration = structuredClone(authored());
  assert.equal(gun.x, preview.x); assert.equal(gun.y, preview.y);
  const drag = f.renderer.board.camera.toScreen(gun.x, gun.y), invalid = f.renderer.board.camera.toScreen(gun.x, upper.y + .3),
    destination = f.renderer.board.camera.toScreen(gun.x, upper.y);
  f.downAt(drag.x, drag.y); assert.equal(f.input.gesture.type, 'move'); f.moveAt(invalid.x, invalid.y);
  assert(f.renderer.modulePreview.refused, 'an invalid intermediate pixel does not end or lock the gesture');
  f.upAt(destination.x, destination.y);
  assert.equal(f.editor.source.components.filter(part => part.id === gun.id).length, 1);
  assert.equal(f.editor.selected.weaponMount.hostId, upper.id); assert.equal(authored().mount.preset, configuration.mount.preset);
  assert.deepEqual(authored().mount.sector, configuration.mount.sector); assert.equal(authored().weaponAmmo, configuration.weaponAmmo);
  assert.equal(f.editor.past.length, history + 1);
  const moved = structuredClone(f.editor.source);
  f.editor.undo(); assert.deepEqual(f.editor.source, before); f.editor.redo(); assert.deepEqual(f.editor.source, moved);

  f.editor.snap = false;
  // Direct Editor undo/redo clears selection; the next real pointerdown selects the same gun again.
  const original = f.editor.blueprint.modules.find(part => part.id === gun.id), past = f.editor.past.length,
    start = f.renderer.board.camera.toScreen(original.x, original.y),
    valid = f.renderer.board.camera.toScreen(original.x + .2, original.y),
    refused = f.renderer.board.camera.toScreen(original.x, upper.y);
  f.downAt(start.x, start.y); assert.equal(f.input.gesture.type, 'move'); f.moveAt(valid.x, valid.y);
  assert(f.editor.weaponMovePreview && !f.editor.weaponMovePreview.refused);
  f.upAt(refused.x, refused.y); assert.equal(f.renderer.modulePreview, null);
  assert.deepEqual(f.editor.source, moved, 'dropping at the refused position cancels the whole gesture');
  assert.equal(f.editor.past.length, past); assert.equal(f.input.gesture, null); assert.equal(f.captured.size, 0);
  f.editor.undo(); assert.deepEqual(f.editor.source, before);
  f.editor.redo(); assert.deepEqual(f.editor.source, moved);
});

test('free dragging a cannon retains exact fractional pose, identity, ammunition and physical mount configuration', () => {
  const editor = new Editor(createStructuredConstruction({ preset: 'bunker', length: 6, height: 3, thicknessMm: 8 })),
    gun = editor.addModule('weapon', { x: 18, y: 6 }, { weaponPreset: 'rh120', angle: 0, sectorMin: -.1, sectorMax: .1 });
  editor.editProperty('weaponAmmo', 'heat', true); editor.snap = false;
  const before = structuredClone(editor.source), part = before.components.find(part => part.id === gun.id),
    original = editor.captureSelection(), history = editor.past.length;
  editor.begin(); assert(editor.moveSelection(original, .137, -.083, { faceTolerance: .1 })); assert(editor.commit());
  const moved = editor.source.components.find(candidate => candidate.id === gun.id);
  assert.equal(moved.id, part.id); assert.equal(moved.weaponPreset, part.weaponPreset); assert.equal(moved.weaponAmmo, 'heat');
  assert.deepEqual(moved.mount, part.mount); assert.equal(moved.pose.angle, part.pose.angle);
  assert(Math.abs(moved.pose.x - part.pose.x - unitsOf(.137)) < 1e-10);
  assert(Math.abs(moved.pose.y - part.pose.y - unitsOf(-.083)) < 1e-10);
  assert.equal(editor.past.length, history + 1); editor.undo(); assert.deepEqual(editor.source, before);
});

test('a new weapon respects the shared component quota while an existing weapon can still move at the quota', () => {
  const components = Array.from({ length: PART_LIMITS.components - 1 }, (_, index) => ({
    ...structuredComponent('command', {}, 'command-' + index),
    pose: { x: unitsOf(8 + index % 5 - 12), y: unitsOf(3 + Math.floor(index / 5) - 1.3), angle: 0 },
  })), source = createStructuredConstruction({ preset: 'bunker', length: 6, height: 3, thicknessMm: 8 }),
    editor = new Editor({ ...source, nodes: [], plates: [], components }),
    gun = editor.addModule('weapon', { x: 15, y: 7 }, { weaponPreset: 'm2hb' }), before = structuredClone(editor.source);
  assert.equal(editor.source.components.length, PART_LIMITS.components);
  const plan = editor.planModule('weapon', { x: 17, y: 7 }, { weaponPreset: 'm2hb' });
  assert(plan.refused); assert.equal(plan.error.reason, 'AUTHORING_LIMIT'); assert.deepEqual(editor.source, before);
  editor.select(gun.id); editor.snap = false; const original = editor.captureSelection();
  editor.begin(); assert(editor.moveSelection(original, .137, 0)); assert(editor.commit());
  assert.equal(editor.source.components.length, PART_LIMITS.components);
  assert.equal(editor.selected.id, gun.id); assert(Math.abs(editor.selected.x - gun.x - .137) < 1e-10);
});

test('changing weapon or sector is transactional; invalid sweep never changes the source', () => {
  const editor = new Editor(createConstruction('scout')), gun = editor.blueprint.modules.find(m => m.kind === 'weapon');
  editor.select(gun.id); editor.editProperty('weaponPreset', 'fnmag', true);
  assert.equal(editor.selected.weaponPreset, 'fnmag');
  assertMountProjection(editor.selected);
  assert.equal(editor.selected.weaponMount.preset, 'light-trunnion');
  const physicalOf = gun => ({ shield: gun.weaponMount.shield, materialPolygons: gun.materialPolygons,
    mass: gun.physicalMass, center: gun.physicalCenterLocal, inertia: gun.physicalInertia }),
    physical = structuredClone(physicalOf(editor.selected)), sector = { min: editor.selected.weaponMount.min, max: editor.selected.weaponMount.max };
  editor.editProperty('sectorMin', -.3, true); editor.editProperty('sectorMax', .3, true);
  assertMountProjection(editor.selected);
  assert.deepEqual(physicalOf(editor.selected), physical,
    'limiting permitted movement leaves the physical armour and mount mass unchanged');
  const before = structuredClone(editor.source), history = editor.past.length;
  assert.throws(() => editor.editProperty('sectorMax', 1.4, true));
  assert.deepEqual(editor.source, before); assert.equal(editor.past.length, history);
  editor.editProperty('sectorMin', sector.min, true); editor.editProperty('sectorMax', sector.max, true);
  assertMountProjection(editor.selected);
  assert.deepEqual(physicalOf(editor.selected), physical,
    'restoring the full sector does not add steel, mass or inertia');
  assert.equal(weaponAngle(editor.selected), editor.selected.barrelAngle,
    'testing starts at the native barrel angle, without adding another half turn');
});

test('default construction intent leaves the full sector to native admission and preserves explicit limits', () => {
  const part = structuredComponent('weapon', { weaponPreset: 'm2hb' }, 'new-gun');
  assert.equal(part.mount.preset, 'light-trunnion');
  assert.equal(Object.hasOwn(part.mount, 'sector'), false);
  const explicit = structuredComponent('weapon', { weaponPreset: 'm2hb', sectorMin: -.2, sectorMax: .1 }, 'limited-gun');
  assert.deepEqual(explicit.mount.sector, { min: -.2, max: .1 });
});

test('aim queries reuse the physical flight solution and invalidate it when motion or aim changes', () => {
  const admitted = new Editor(createConstruction('scout')).blueprint.modules.find(part => part.kind === 'weapon'),
    module = { ...admitted, id: 'gun', actorId: 'local', health: 1, attached: true,
    x: 5, y: 3, angle: .4, barrelAngle: .35 }, body = { x: 4, y: 2, angle: .4,
    vx: 3.2, vy: -.2, omega: .8, carrierCenter: { x: -.45, y: .7 } },
    state = { time: 1, modules: [module], plates: [], actors: [{ id: 'local', x: body.x, vehicle: body }] },
    queries = new AimQueries(), settings = { aim: { x: 80, y: 4 },
      weapon: weaponSettings('machinegun', { preset: 'm2hb', platform: 'vehicle', componentId: module.id }) },
    solution = () => queries.solution(state, settings.weapon, settings.aim, true),
    first = solution(), posed = sampleScene(state), pivot = posed.pose(module.id);
  assert.deepEqual(first, mountedFiringSolution(pivot, settings.aim, settings.weapon,
    presentedPivotVelocity(posed.actor('local'), pivot)));
  assert.equal(solution(), first, 'drawing and overlay share one read-only solution');
  settings.aim = { x: 81, y: 4 };
  const aimed = solution(); assert.notEqual(aimed, first);
  body.vx += 1;
  const moving = solution(); assert.notEqual(moving, aimed);
  assert.equal(solution(), moving);
});

test('five-second flight marks match the canonical dragged states and retain an unchanged result', () => {
  const cases = [[3, []], [7, [5]], [120, Array.from({ length: 23 }, (_, i) => (i + 1) * 5)]];
  for (const preset of ['m119', 'm777']) for (const side of [-1, 1]) for (const [seconds, times] of cases) {
    const launcher = { x: side * 125000, y: 400 }, aim = { x: launcher.x + side * 1000, y: launcher.y },
      settings = weaponSettings('howitzer', { preset, ammo: 'he', detonation: 'airburst', charge: 1,
        aimAngle: side > 0 ? Math.PI / 3 : Math.PI * 2 / 3, fuzeTime: seconds }),
      solution = firingSolution(launcher, aim, settings), queries = new AimQueries(),
      actual = queries.flightMarks(solution, solution.time),
      expected = times.map(time => flightState(solution, time)), label = `${preset} ${side} ${seconds}s`;
    assert.equal(solution.time, seconds, label);
    assert.equal(solution.flightLimit, seconds, 'airburst bounds the admitted flight');
    assert.deepEqual(actual, expected, label);
    assert.equal(queries.flightMarks(solution, solution.time), actual, 'unchanged marks stay retained');
  }
});
