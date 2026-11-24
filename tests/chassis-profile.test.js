import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { plateCorners } from '../src/math.ts';
import { CHASSIS_STRUCTURE, suspensionHeight } from '../src/chassis.ts';
import { withChassisGearScale, withChassisThickness } from '../src/chassis-editing.ts';
import { World } from '../src/physics.ts';
import { metresOf } from '../src/grid.ts';

await initNativeDynamics();
const close = (a, b) => assert(Math.abs(a - b) < 1e-9, `${a} != ${b}`);

test('stock sizing changes the physical section without moving authored hull or equipment', () => {
  const source = createConstruction('scout'), before = structuredClone(source), thin = compileBlueprint(source),
    thick = compileBlueprint({ ...source, chassis: { ...source.chassis, thicknessMm: 16 } });
  close(thin.chassis.depth, .18); close(thick.chassis.depth, .26);
  assert.deepEqual(source, before, 'sizing never rewrites the authored project');
  const lift = thick.chassis.deck - thin.chassis.deck;
  close(lift, 0);
  for (const [i, part] of thin.modules.entries()) {
    const changed = thick.modules[i];
    assert.deepEqual([part.id, part.x, part.width, part.height], [changed.id, changed.x, changed.width, changed.height]);
    close(changed.y, part.y);
  }
  for (const part of thin.plates.filter(p => !p.chassis)) {
    const changed = thick.plates.find(p => p.id === part.id);
    assert.deepEqual([changed.id, changed.material, changed.thicknessMm], [part.id, part.material, part.thicknessMm]);
    for (const field of ['length', 'angle', 'physicalMass', 'physicalInertia']) close(changed[field], part[field]);
    for (const [i, corner] of plateCorners(part).entries()) {
      const after = plateCorners(changed)[i]; close(after.x, corner.x); close(after.y - corner.y, lift);
    }
    close(changed.y - part.y, lift);
  }
  for (const blueprint of [thin, thick]) {
    const { chassis } = blueprint, rail = blueprint.plates.find(p => p.chassis?.part === 'rail');
    close(Math.min(...plateCorners(rail).map(p => p.y)), chassis.deck - chassis.depth);
    close(Math.min(...chassis.outlines.flat().map(p => p.y)), chassis.deck - chassis.depth);
    close(chassis.depth / CHASSIS_STRUCTURE.profileStep, Math.round(chassis.depth / CHASSIS_STRUCTURE.profileStep));
    for (const part of blueprint.plates.filter(p => p.chassis)) close(part.chassis.depth, chassis.depth);
  }
  for (const field of ['frameKg', 'sectionAreaM2', 'secondMomentM4', 'frameLimitKg', 'limitKg'])
    assert(thick.chassis[field] > thin.chassis[field], `${field} must use the larger physical section`);
});

test('factory wheeled and tracked designs remain valid with their newly sized sections', () => {
  for (const { id } of CONSTRUCTION_TEMPLATES.filter(template => template.type === 'vehicle')) {
    const blueprint = compileBlueprint(createConstruction(id)), { chassis } = blueprint;
    assert(chassis.loadedKg <= chassis.limitKg, id);
    if (chassis.model === 'aircraft') continue; // Skid rails use their own profile, not the road-vehicle section steps.
    assert(chassis.deck > chassis.depth && chassis.depth >= 2 * chassis.thicknessMm / 1000, id);
    close(chassis.depth / CHASSIS_STRUCTURE.profileStep, Math.round(chassis.depth / CHASSIS_STRUCTURE.profileStep));
  }
});

test('wheel size and frame gauge keep the suspension height, carrying the authored profile up or down with the whole construction', () => {
  const original = createConstruction('scout'), ordinary = compileBlueprint(original).plates.find(plate => plate.id === 'chassis:top-0'),
    height = suspensionHeight(original.chassis);
  for (const scale of [.75, 1, 1.5]) for (const thicknessMm of [8, 20, 80, 125]) {
    const source = withChassisGearScale(withChassisThickness({ ...original, chassis: { ...original.chassis, axles: [-31, 31] } },
        thicknessMm), scale),
      blueprint = compileBlueprint(source), { chassis } = blueprint,
      rail = blueprint.plates.find(p => p.chassis?.part === 'rail'),
      bottom = Math.min(...plateCorners(rail).map(p => p.y)), lift = source.chassis.points[0].y - original.chassis.points[0].y;
    close(bottom, chassis.deck - chassis.depth);
    for (const wheel of blueprint.modules.filter(m => m.kind === 'wheel')) {
      close(wheel.y - wheel.height / 2, .01);
      assert(wheel.suspension.travel > 0);
    }
    close(blueprint.frame.origin.y, 1.3);
    close(chassis.deck, metresOf(source.chassis.points[0].y) + 1.3);
    close(chassis.suspension, metresOf(height)); assert.equal(suspensionHeight(source.chassis), height);
    for(const [i,node] of source.nodes.entries()){
      assert.equal(node.x,original.nodes[i].x);
      close(node.y-original.nodes[i].y,lift);
    }
    for(const [i,part] of source.components.entries()){
      assert.equal(part.pose.x,original.components[i].pose.x);
      close(part.pose.y-original.components[i].pose.y,lift);
      assert.equal(part.pose.angle,original.components[i].pose.angle);
    }
    const floor = blueprint.plates.find(plate => plate.id === 'chassis:top-0');
    close(floor.x, ordinary.x); close(floor.y, ordinary.y + metresOf(lift)); close(floor.angle, ordinary.angle);
  }
});

test('very thick frames stand on their tyres in the actual flat-ground simulation without starting damage', () => {
  const original = createConstruction('scout');
  for (const gearScale of [.75, 1.25]) {
    const world = new World({ ...withChassisGearScale(withChassisThickness(original, 125), gearScale), terrain: 'flat' }, { visualEvents: false });
    try {
      const health = world.modules.map(part => [part.id, part.health]);
      for (let step = 0; step < 240; step++) world.step();
      for (const wheel of world.modules.filter(part => part.kind === 'wheel'))
        assert(Math.abs(wheel.y - wheel.height / 2 - world.terrain.height(wheel.x)) < .001, 'physical tyre rests on the actual ground');
      assert.deepEqual(world.modules.map(part => [part.id, part.health]), health, 'standing still causes no structural or wheel damage');
      assert.equal(world.dynamics.recoveries, 0);
    } finally { world.dispose(); }
  }
});

// A pickup's chassis arched over both its wheels (as players build them), and the same with its points all at its deck;
// in cells (grid.ts), its floor on the cells of the points under it.
function arched() {
  const base = createConstruction('chassis'), D = base.chassis.points[0].y, up = 6,
    points = [[-54, 0], [-48, up], [-22, up], [-16, 0], [16, -1], [23, up], [46, up], [52, 0], [54, 0]].map(([x, y]) => ({ x, y: D + y })),
    floor = points.map((p, i) => ({ id: `floor-${i}`, x: p.x, y: p.y })),
    top = [['rear-top', 54, D + 19], ['cab-low', -4, D + 19], ['cab-top', -10, D + 31], ['roof-front', -34, D + 31], ['front-top', -54, D + 19]].map(([id, x, y]) => ({ id, x, y })),
    ring = [...floor, ...top].map(node => node.id), { launcher: _, ...rest } = base;
  return { ...rest, chassis: { model: 'wheeled', points, axles: [-35, 34] }, nodes: [...floor, ...top],
    plates: ring.map((a, i) => ({ id: `hull:${i}`, a, b: ring[(i + 1) % ring.length], material: 'steel', thicknessMm: 10 })),
    components: [{ id: 'engine', kind: 'engine', pose: { x: -35, y: D + 15, angle: 0 }, sizeScale: .8 },
      { id: 'fuel', kind: 'fuel', pose: { x: 4, y: D + 9, angle: 0 }, sizeScale: 1 },
      { id: 'command', kind: 'command', pose: { x: -18, y: D + 22, angle: 0 }, sizeScale: 1 },
      { id: 'sensor-vision', kind: 'sensor', sensorMode: 'visual', pose: { x: -31, y: D + 26, angle: 0 }, sizeScale: 1 }] };
}

test('a wheel under a stretch raised over it stands and rides on the same springs as one under a level stretch', () => {
  const raised = arched(), deck = Math.min(...raised.chassis.points.map(p => p.y)),
    level = { ...raised, chassis: { ...raised.chassis, points: raised.chassis.points.map(p => ({ x: p.x, y: deck })) } };
  const ride = design => {
    const out = {};
    for (const terrain of ['flat', 'rough']) {
      const world = new World({ ...design, terrain, seed: 900015 }, { visualEvents: false }), wheels = () => world.modules.filter(part => part.kind === 'wheel');
      try {
        for (let step = 0; step < 120; step++) world.step();
        if (terrain === 'flat') { out.rest = wheels().map(wheel => ({ ...wheel.suspension })); continue; }
        world.controlVehicle(1);
        out.range = wheels().map(() => [Infinity, -Infinity]);
        for (let step = 0; step < 420; step++) {
          world.step();
          for (const [k, wheel] of wheels().entries()) out.range[k] = [Math.min(out.range[k][0], wheel.suspension.displacement), Math.max(out.range[k][1], wheel.suspension.displacement)];
        }
        assert.equal(world.dynamics.recoveries, 0);
      } finally { world.dispose(); }
    }
    return out;
  };
  const under = ride(raised), over = ride(level);
  // The same spring and travel, pressed as much standing; over rough ground each takes up its bumps as far.
  assert.deepEqual(compileBlueprint(raised).modules.filter(m => m.kind === 'wheel').map(m => [m.y, m.suspension]),
    compileBlueprint(level).modules.filter(m => m.kind === 'wheel').map(m => [m.y, m.suspension]));
  for (const [k, rest] of under.rest.entries()) {
    assert(rest.enabled && rest.travel === over.rest[k].travel);
    close(rest.compression, over.rest[k].compression);
    const [low, high] = under.range[k];
    assert(high > .05 && low < -.02, `wheel ${k} works on its springs: ${low}..${high}`);
    // Its stops: a third of its travel down from where it rests, two thirds up (game_motion.rs `SPRING_REST`).
    assert(high <= rest.travel * 2 / 3 + 1e-6 && low >= -rest.travel / 3 - 1e-6, `wheel ${k} within its travel`);
    assert(Math.abs(high - over.range[k][1]) < .03 && Math.abs(low - over.range[k][0]) < .03, `wheel ${k} as one under a level stretch`);
  }
});
