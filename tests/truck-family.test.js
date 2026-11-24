import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { compileBlueprint, validateBlueprint } from '../src/persistence.ts';
import { bodyPanelSurfaces } from '../src/body-panels.ts';
import { designFrame } from '../src/scene-frame.ts';
import { boxWithin, hullLayout, CLEAR, fenderOver } from '../src/hull-details.ts';
import { cargoSpace } from '../src/component-volume.ts';
import { metresOf } from '../src/grid.ts';
import { miningWorld } from './helpers/mining-mobility.js';
import { advance, setPart } from './mechanical-queries.js';

const FAMILY = ['chassis', 'truck', 'supply', 'tanker'];
for (const id of FAMILY) test(`${id}: an editable bonnet and cab enclose the running equipment on the real chassis floor`, () => {
  const source = createConstruction(id), b = compileBlueprint(source), part = kind => b.modules.find(p => p.kind === kind),
    engine = part('engine'), fuel = part('fuel'), command = part('command'), { chassis } = b,
    points = new Map(source.nodes.map(p => [p.id, { x: 12 + metresOf(p.x), y: metresOf(p.y) }])),
    hood = points.get('hood-back'), roof = points.get('hull-3');
  assert.equal(b.mechanicalAdmission, true);
  assert(chassis.loadedKg <= chassis.limitKg * .9, 'the complete load has a real carrying margin');
  assert.equal(chassis.wheelDiameter, 1.25);
  assert.equal(chassis.axles.length, id === 'tanker' ? 4 : 3);
  assert(chassis.axles.at(-1) - chassis.axles.at(-2) < chassis.axles.at(-2) - chassis.axles[0], 'a rear tandem behind a separate front group');
  assert(roof.y - hood.y > .8, 'a low bonnet ahead of a distinctly taller cab');
  assert(engine.x + engine.width / 2 < hood.x && engine.height < .8, 'the engine really fits under the bonnet');
  assert(fuel.x > hood.x && command.x > hood.x && command.y > fuel.y, 'the command and its fuel are protected in the cab');
  // Its engine is as long and tall as the square root of 240/180 makes it: 240 kW to the last bits of that root.
  assert(Math.abs(engine.powerKw - 240) < 1e-9, engine.powerKw);
  assert.equal(b.rooms.length, 1, 'a normal stepped enclosure');
  assert.equal(b.plates.filter(p => p.id.startsWith('chassis:top-')).length, 1);
  assert(!source.plates.some(p => p.id.includes('floor')), 'the one chassis floor closes the cab');
  // The owner's cab: a short windscreen between the steel brow under its roof and the steel over its bonnet.
  const visor = source.plates.find(p => p.material === 'glass'), tall = metresOf(Math.abs(source.nodes.find(p => p.id === visor.a).y - source.nodes.find(p => p.id === visor.b).y));
  assert(tall >= .3 && tall <= .4 && visor.thicknessMm === 40, 'a real windscreen, set in steel');
  assert.deepEqual(source.components.filter(p => p.kind === 'sensor').map(p => p.sensorMode), ['visual']);
  assert.deepEqual(validateBlueprint(JSON.parse(JSON.stringify(source))), source);
  const edited = structuredClone(source); edited.name += ' editado'; edited.appearance.paint = '#8c794a';
  if (id !== 'chassis') edited.components.find(p => ['hopper', 'supply', 'cistern'].includes(p.kind)).pose.x += 1;
  assert.equal(compileBlueprint(validateBlueprint(edited)).mechanicalAdmission, true, 'ordinary edits do not need a factory attachment or a special vehicle tag');
});

test('the three truck bodies retain their cargo capacity and stay over the rear deck, clear of the cab and drill', () => {
  for (const [id, kind, capacity] of [['truck', 'hopper', 4.6656], ['supply', 'supply', 4.257792], ['tanker', 'cistern', 4.42810368]]) {
    const b = compileBlueprint(createConstruction(id)), cargo = b.modules.find(p => p.kind === kind),
      rear = Math.max(...b.rooms[0].polygon.map(p => p.x));
    assert(Math.abs(cargo.capacityM3 - capacity) < 1e-9, id);
    assert(cargo.x - cargo.width / 2 > rear + .2 && cargo.x + cargo.width / 2 < b.chassis.rear, id);
    assert.equal(cargo.exposed, true);
    if (id === 'tanker') {
      const drill = b.modules.find(p => p.kind === 'drill');
      assert(drill.x - drill.width / 2 > cargo.x + cargo.width / 2 + .1);
      assert(b.modules.find(p => p.kind === 'engine').powerKw > 150, 'the working drill has a power margin');
    }
  }
  const base = compileBlueprint(createConstruction('chassis'));
  assert(base.chassis.rear - Math.max(...base.rooms[0].polygon.map(p => p.x)) >= 3, 'the bare base has a useful free deck');
});

test('legacy truck fittings retain their layout while new editable cab details follow a project mirror', () => {
  for (const id of FAMILY) {
    const b = compileBlueprint(createConstruction(id)), [skin] = bodyPanelSurfaces(designFrame(b), b.bodyPanels), scene = { ...skin.fittings(), manualDetails: false, details: [], automaticDetails: undefined },
      publicPieces = scene.pieces.filter(p => p.exposed || ['wheel', 'track'].includes(p.kind)),
      left = hullLayout(skin.artPolygon, { ...scene, side: 'outside', pieces: publicPieces }),
      reflect = p => ({ ...p, x: 24 - p.x }),
      right = hullLayout(skin.artPolygon.map(reflect), { ...scene, front: 1, side: 'outside', pieces: publicPieces.map(p => ({ ...reflect(p), angle: Math.PI - p.angle })), rooms: scene.rooms.map(r => r.map(reflect)) });
    assert.deepEqual(left, hullLayout(skin.artPolygon, { ...scene, side: 'outside' }), 'private equipment does not affect exterior art');
    for (const layout of [left, right]) {
      assert.equal(layout.fittings.filter(f => f.kind === 'cab-door').length, 1, `${id}: a glazed door`);
      assert(!layout.fittings.some(f => ['hatch', 'periscope', 'cable', 'tools', 'cans', 'bin'].includes(f.kind)), 'a road cab avoids generic armoured-hull fittings');
      for (const fitting of layout.fittings) {
        assert(boxWithin(fitting, layout === left ? skin.artPolygon : skin.artPolygon.map(reflect), CLEAR));
        for (const wheel of (layout === left ? publicPieces : publicPieces.map(reflect)).filter(p => p.kind === 'wheel')) {
          const reach = fenderOver(wheel.w / 2).outer;
          assert(Math.abs(fitting.x - wheel.x) >= fitting.w / 2 + reach || fitting.y - fitting.h / 2 > wheel.y + reach, `${id} ${fitting.kind}: clear of the wheel guard`);
        }
      }
    }
    const a = left.fittings.find(f => f.kind === 'cab-door'), z = right.fittings.find(f => f.kind === 'cab-door');
    assert(Math.abs(a.x + z.x - 24) < .002 && a.y === z.y && !a.flip && z.flip);
    assert(!hullLayout(skin.artPolygon, { ...scene, side: 'inside' }).fittings.some(f => f.kind.startsWith('cab-')));
  }
});

for (const id of FAMILY) for (const facing of [-1, 1]) test(`${id}: the new wheelbase drives on soil facing ${facing}`, t => {
  const world = miningWorld(createConstruction(id), { grade: .08, facing, direction: facing, cargo: id === 'truck' ? 'ferro' : null });
  t.after(() => world.dispose());
  if (id === 'tanker') {
    const tank = world.modules.find(p => p.kind === 'cistern');
    setPart(world, tank, { cargo: { petroleo: cargoSpace(tank, 'petroleo') } }); advance(world, 30, { drain: true });
  }
  const start = world.vehicle.x;
  world.controlVehicle(facing, 0); advance(world, 720, { drain: true });
  assert((world.vehicle.x - start) * facing > 15, 'it moves from rest under its own engine and ordinary tyre contacts');
  assert(Math.abs(world.vehicle.angle) < .3, 'the load and wheelbase stay stable');
  assert(world.modules.every(p => p.health / p.maxHealth > .99), 'the new silhouette has no damaging terrain contact');
});
