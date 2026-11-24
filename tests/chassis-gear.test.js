import test from 'node:test';
import assert from 'node:assert/strict';
import { AXLE_GAP, CHASSIS_METALS, CHASSIS_MODELS, axleSpacing, chassisAxles, chassisFront, chassisSkids, chassisSpec,
  chassisTrack, frameThicknessMm, gearProblem, straightChassis, suspensionHeight, trackLength, trackLengthRange, withAxle,
  trackFloorY, withAxleCount, withChassisMetal, withFrameThickness, withGearScale, withGearWritten, withTrackEnd, withTrackPosition, writtenTrack } from '../src/chassis.ts';
import { constructionCatalogue } from '../src/construction-admission.ts';
import { withChassisPoint, withChassisSuspension } from '../src/chassis-editing.ts';
import { compileNativeConstruction, initNativeDynamics } from '../src/native-dynamics.ts';
import { compileDraftConstruction } from '../src/structured-construction.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';
import { MATERIALS, METALS } from '../src/materials.ts';
import { constructionCost, pieceCostBreakdown } from '../src/construction-cost.ts';
import { designBill } from '../src/economy.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { CELL, cellOf } from '../src/grid.ts';
await initNativeDynamics();

// The models with running gear: the skids of an aircraft are told in flight.test.js.
const MODELS = Object.keys(CHASSIS_MODELS).filter(model => CHASSIS_MODELS[model].kind !== 'aircraft');
// A box of thin steel from end to end of its chassis, with a command post in it, written in cells (grid.ts): its floor
// on the cell of the deck, 1.2 m tall; where the model of the chassis hangs its gear (chassis-editing.ts
// `withChassisSuspension`).
const boxed = chassis => withChassisSuspension(bare(chassis), 0);
const bare = chassis => {
  const corner = i => `hull-${i}`, front = chassis.points[0].x, rear = chassis.points.at(-1).x,
    floor = chassis.points[0].y;
  return { version: DESIGN_VERSION, preset: 'vehicle', chassis,
    nodes: [[front, 0], [rear, 0], [rear, 24], [front, 24]].map(([x, y], i) => ({ id: corner(i), x, y: y + floor })),
    plates: ['floor', 'rear', 'roof', 'front'].map((side, i) => ({ id: `hull:${side}`, a: corner(i), b: corner((i + 1) % 4), material: 'steel', thicknessMm: 8 })),
    components: [{ id: 'command', kind: 'command', pose: { x: 0, y: floor + 6, angle: 0 } }] };
};
const compiled = chassis => compileNativeConstruction(boxed(chassis), constructionCatalogue());
// The core and the drag bounds share refusal codes and their small context.
// The core also tells what was written and what the key takes (`value`, `range`), which the page's check does not.
const coreProblem = chassis => {
  try { compiled(chassis); return null; } catch ({ reason, code, name, message, stack, value, range, ...context }) { return { code: reason, ...context }; }
};
// A straight chassis `length` metres long about the reference, its ends on the cells nearest.
const ends = (model, length) => straightChassis(model, cellOf(-length / 2), cellOf(length / 2));
const near = (a, b, tolerance = 1e-9 * Math.max(Math.abs(a), Math.abs(b), 1e-6)) =>
  assert.ok(Math.abs(a - b) < tolerance, `${a} != ${b}`);
const frameMass = design => design.plates.filter(plate => plate.chassis).reduce((sum, plate) => sum + plate.physicalMass, 0);
const runningGear = design => design.modules.filter(part => part.id.startsWith('chassis:'));
// Structural values come from the compiler. Check their physical invariants
// and their correspondence to generated parts, without a second JS solver.
const sameStructure = (chassis, told) => {
  for (const field of ['deck', 'depth', 'frameKg', 'sectionAreaM2', 'secondMomentM4', 'frameLimitKg', 'gearLimitKg', 'limitKg'])
    assert(Number.isFinite(told[field]) && told[field] > 0, field);
  const supportKg = told.axleKg ?? told.roadWheelKg,
    supports = chassisSpec(chassis.model).kind === 'wheeled' ? told.axles.length : told.track.wheels;
  // The admitted envelope depends on COM as reserves empty independently;
  // the uniform sum is only its upper bound, never a guaranteed capacity.
  assert.ok(told.gearLimitKg >= supportKg - 1e-9);
  assert.ok(told.gearLimitKg <= supportKg * supports + 1e-9);
  near(told.limitKg, Math.min(told.frameLimitKg, told.gearLimitKg));
};

test('each running gear agrees with the core on support geometry, real frame mass and structural limits', () => {
  for (const model of MODELS) {
    const spec = CHASSIS_MODELS[model], [shortest, longest] = spec.length;
    if (spec.kind === 'wheeled') assert.ok(spec.axleRange[0] <= spec.axles && spec.axles <= spec.axleRange[1], model);
    else assert.equal(spec.axleRange, undefined);
    for (const length of [shortest, (shortest + longest) / 2, longest]) {
      // A twelve-metre box on only two axles genuinely needs a thicker frame;
      // this geometry fixture reinforces it instead of bypassing admission.
      const chassis = { ...ends(model, length), ...(spec.kind === 'wheeled' && length === longest ? { thicknessMm: 40 } : {}) },
        { construction, compiled: design } = compiled(chassis), { chassis: told } = design;
      // Optional settings are written only when the player has shaped them.
      assert.deepEqual(construction.chassis, boxed(chassis).chassis);
      sameStructure(chassis, told);
      near(frameMass(design), told.frameKg);
      // The editor puts it where the core does.
      if (spec.kind === 'wheeled') chassisAxles(chassis).forEach((x, i) => near(told.axles[i] - 12, x));
      else {
        const track = chassisTrack(chassis);
        assert.equal(track.wheels, told.track.wheels); near(told.track.front - 12, track.front); near(told.track.rear - 12, track.rear);
      }
    }
  }
  assert.deepEqual(MODELS, ['wheeled', 'tracked']);
});

// Geometry helpers and the core agree on layout. The core additionally weighs
// the construction and may refuse a geometrically valid support arrangement.
test('gear geometry refusals agree with the core while actual support loads remain canonical', () => {
  // Axles and track ends in cells (grid.ts); a track of so many road wheels written from its front end, in metres.
  const light = axles => ({ ...ends('wheeled', 4.8), axles }), heavy = track => ({ ...ends('tracked', 7), track }),
    wheels = (lead, n) => heavy(writtenTrack(ends('tracked', 7), lead, lead + trackLength('tracked', n))),
    width = n => trackLength('tracked', n), spacing = cellOf(axleSpacing('wheeled')), frontFiveRoadWheels = wheels(-3.45, 5);
  const shapes = [light([-32, 6, 36]), light([0]), light([-36, -12, 12, 36]), light([-40, 20]), light([-20, 39]),
    light([-20, -20 + spacing - 1]), light([-20, -20 + spacing]), light([-39, 39]),
    wheels(2.4 - width(5), 5), heavy(writtenTrack(ends('tracked', 7), -2, 2)), wheels(-1, 2),
    frontFiveRoadWheels, wheels(-width(3) / 2 - .2, 3),
    { ...ends('wheeled', 6), track: { front: -40, rear: 40 } }, { ...ends('tracked', 5), axles: [-20, 20] },
    { ...ends('wheeled', 6), metal: 'aluminum', thicknessMm: 20 }, { ...ends('wheeled', 6), metal: 'titanium', thicknessMm: 20 },
    { ...ends('wheeled', 6), metal: 'hha' }];
  for (const chassis of shapes) {
    if (chassis === frontFiveRoadWheels) {
      assert.equal(gearProblem(chassis), null, 'all five equal road wheels physically fit under the frame');
      assert.equal(coreProblem(chassis).code, 'CHASSIS_OVERLOAD',
        'the front-biased supports overload under the actual closed hull even though their geometry fits');
      continue;
    }
    assert.deepEqual(gearProblem(chassis), coreProblem(chassis), JSON.stringify(chassis));
    if (gearProblem(chassis)) continue;
    const told = compiled(chassis).compiled.chassis;
    sameStructure(chassis, told);
    near(frameThicknessMm(chassis), told.thicknessMm);
  }
});

test('skid geometry refusals agree with the core, which lays the skids where the editor reads them', () => {
  // The smallest aircraft, its skids written in cells (grid.ts), or where the model puts them.
  const small = (skids, more = {}) => ({ ...ends('aircraft', 2.5), ...more, ...(skids ? { skids } : {}) }),
    shapes = [small({ front: -26, rear: 20, legs: [-10, 10] }), small({ front: -20, rear: 26, legs: [-10, 10] }),
      small({ front: -20, rear: 20, legs: [-17, 10] }), small({ front: -20, rear: 20, legs: [-10, 17] }),
      small({ front: -20, rear: 20, legs: [-15, 14] }, { gearScale: 1.5 }), small({ front: -20, rear: 20, legs: [-5, 4] }),
      small({ front: -20, rear: 20, legs: [-10, 10] }, { axles: [-10, 10] }), { ...ends('wheeled', 6), skids: { front: -50, rear: 50, legs: [-30, 30] } }];
  assert.deepEqual(shapes.map(chassis => gearProblem(chassis)?.code),
    ['SKID_EXTENT', 'SKID_EXTENT', 'SKID_RUNNER', 'SKID_RUNNER', 'SKID_RUNNER', 'SKID_SPACING', 'CHASSIS_GEAR_KIND', 'CHASSIS_GEAR_KIND']);
  for (const chassis of shapes) assert.deepEqual(gearProblem(chassis), coreProblem(chassis), JSON.stringify(chassis));
  // Admitted, with nothing yet to lift them: the core lays the runner, its tube and its legs where the editor reads them.
  for (const chassis of [small(null), small(null, { gearScale: .5 }), small({ front: -24.5, rear: 25, legs: [-16, -6] }, { gearScale: 1.5 }),
    small({ front: -20, rear: 20, legs: [-6, 4] }, { gearScale: .75 })]) {
    assert.equal(gearProblem(chassis), null, JSON.stringify(chassis));
    assert.equal(coreProblem(chassis).code, 'AIRCRAFT_LIFT');
    const told = compileDraftConstruction(boxed(chassis)).chassis.skids, skids = chassisSkids(chassis);
    near(told.front - 12, skids.front); near(told.rear - 12, skids.rear); near(told.tube, skids.tube);
    told.struts.forEach((x, i) => near(x - 12, skids.legs[i]));
  }
});

test('an axle moves along the frame no nearer its neighbours than a wheel and a gap, with as many axles as physically fit', () => {
  const medium = withAxleCount(ends('wheeled', 6), 3), spacing = chassisSpec('wheeled').wheel + AXLE_GAP;
  assert.equal(axleSpacing('wheeled'), spacing);
  // Moved where the model puts it, it is no longer written.
  const moved = withAxle(medium, 1, .7);
  assert.deepEqual(moved.axles, [-44, 14, 44]);
  assert.deepEqual(withAxle(moved, 1, chassisAxles(medium)[1]), medium);
  // As far as the next and the end let it.
  assert.equal(withAxle(medium, 1, 3).axles[1], cellOf(2.2 - spacing)); assert.equal(withAxle(medium, 0, -9).axles[0], cellOf(-3 + .55));
  assert.equal(withAxle(medium, 2, 9).axles[2], cellOf(3 - .55));
  for (const shaped of [withAxle(medium, 1, 3), withAxle(medium, 0, -9), withAxle(medium, 2, 9)]) assert.equal(coreProblem(shaped), null);
  // Changing the count reuses the same uniform placement rule.
  assert.deepEqual(withAxleCount(medium, 2), ends('wheeled', 6));
  assert.deepEqual(withAxleCount(moved, 3), medium);
  const four = withAxleCount(medium, 4);
  assert.equal(four.axles.length, 4); assert.equal(coreProblem(four), null);
  sameStructure(four, compiled(four).compiled.chassis);
  assert.ok(compiled(four).compiled.chassis.gearLimitKg > compiled(medium).compiled.chassis.gearLimitKg);
  assert.ok(compiled(four).compiled.chassis.limitKg > compiled(medium).compiled.chassis.limitKg);
  // On the shorter frame, four fit as near one another as wheels stand, nearer the ends. Five fit on
  // six metres, so an old class maximum cannot silently refuse the fifth.
  const short = withAxleCount(ends('wheeled', 5), 4);
  assert.equal(short.axles[0], -36); assert.equal(short.axles[3], 36); assert.equal(short.axles[1] - short.axles[0], cellOf(spacing));
  assert.equal(coreProblem(short), null);
  const five = withAxleCount(medium, 5);
  assert.equal(five.axles.length, 5); assert.equal(coreProblem(five), null);
  assert.equal(withAxleCount(medium, 6), null); assert.equal(withAxleCount(medium, 9), null);
  assert.equal(withAxleCount(medium, 1), null);
  assert.equal(withAxleCount(ends('tracked', 6), 3), null);
});

test('a track has literal sub-cell endpoints and its centre on the floor, independent of body points', () => {
  const heavy = ends('tracked', 7), track = chassisTrack(heavy);
  near(track.front, chassisFront(heavy)); near(track.rear, -chassisFront(heavy)); near(track.y, trackFloorY(track.height));
  const shorter = withTrackEnd(heavy, 'front', track.front + .013), shaped = chassisTrack(shorter);
  near(shaped.front, track.front + .013); near(shaped.rear, track.rear); near(shaped.y, track.y);
  assert.equal(shaped.wheels, track.wheels, 'a short continuous edit changes dimensions without quantizing to a support');
  assert.equal(coreProblem(shorter), null); sameStructure(shorter, compiled(shorter).compiled.chassis);
  // Larger, it grows up from the floor.
  const larger = withGearScale(shorter, 1.1), after = chassisTrack(larger);
  near(after.front, shaped.front); near(after.rear, shaped.rear); near(after.height, shaped.height * 1.1);
  near(after.y, trackFloorY(after.height)); assert.deepEqual(larger.points, heavy.points);
  // Along the design only, as high as it was.
  const moved = withTrackPosition(shorter, (shaped.front + shaped.rear) / 2 + .037), there = chassisTrack(moved);
  near(there.front, shaped.front + .037); near(there.rear, shaped.rear + .037); near(there.y, shaped.y);
  assert.equal(suspensionHeight(moved), suspensionHeight(shorter)); assert.deepEqual(moved.points, heavy.points);
  // A centre written under the floor, as a file may have it, counts as the suspension that much higher, as the
  // compiler reckons it.
  const lower = { ...shorter, track: { ...shorter.track, y: shorter.track.y - .06 / CELL } };
  near(suspensionHeight(lower) - suspensionHeight(shorter), .06 / CELL); assert.equal(coreProblem(lower), null);
  const as = chassis => compileNativeConstruction(bare(chassis), constructionCatalogue()).compiled.chassis.suspension;
  near(as(lower) - as(shorter), .06);
  assert.deepEqual(withGearWritten(heavy).track, writtenTrack(heavy, track.front, track.rear, track.y));
  const explicit = withTrackEnd(shorter, 'front', track.front);
  assert(explicit.track, 'returning to the default does not erase explicit coordinates');
  near(chassisTrack(explicit).front, track.front); near(chassisTrack(explicit).rear, track.rear);
  const invalid = withTrackEnd(heavy, 'front', track.rear - trackLengthRange(heavy)[0] + .001);
  assert.equal(gearProblem(invalid).code, 'TRACK_LENGTH'); assert.equal(coreProblem(invalid).code, 'TRACK_LENGTH');
  const outside = withTrackPosition(heavy, 1);
  assert.equal(gearProblem(outside).code, 'TRACK_EXTENT'); assert.equal(coreProblem(outside).code, 'TRACK_EXTENT');
});

test('changing metal preserves real millimetres and changes frame mass, stiffness, capacity and installed price', () => {
  // This longer span is governed by frame deflection for all three metals;
  // the six-metre frame is now governed by axle yield in steel instead.
  const steel = { ...ends('wheeled', 7.4), thicknessMm: 12 }, base = compiled(steel), before = base.compiled.chassis;
  // A frame is of every metal there is, never of glass fibre nor of plastic, which are no metals and make no frame.
  assert.deepEqual(CHASSIS_METALS, Object.keys(METALS).filter(metal => !['fiberglass', 'plastic'].includes(metal)));
  assert.equal(withChassisMetal(steel, 'fiberglass'), null); assert.equal(withChassisMetal(steel, 'plastic'), null);
  for (const metal of ['aluminum', 'titanium']) {
    const chassis = withChassisMetal(steel, metal), { construction, compiled: design } = compiled(chassis),
      after = design.chassis, density = MATERIALS[metal].density / MATERIALS.steel.density,
      modulus = MATERIALS[metal].youngModulus / MATERIALS.steel.youngModulus;
    assert.deepEqual(construction.chassis, { ...boxed(steel).chassis, metal });
    near(frameThicknessMm(chassis), 12);
    near(after.sectionAreaM2, before.sectionAreaM2); near(after.secondMomentM4, before.secondMomentM4);
    near(frameMass(design), frameMass(base.compiled) * density);
    near(design.chassis.frameKg, before.frameKg * density);
    near(design.chassis.limitKg, before.limitKg * modulus);
    assert.ok(design.chassis.emptyKg < base.compiled.chassis.emptyKg && design.chassis.limitKg < base.compiled.chassis.limitKg);
    sameStructure(chassis, design.chassis);
    // The chassis line costs as that metal does, and the faction pays it from its Ligas; the rubber of the gear is paid
    // as on a steel one, from Ferro (`kept`), and so the same whatever the metal.
    const credits = constructionCost(construction).chassis, gear = runningGear(design).map(piece => pieceCostBreakdown(piece)),
      steelGear = runningGear(base.compiled).map(piece => pieceCostBreakdown(piece)),
      gearCredits = gear.reduce((sum, groups) => sum + groups.runningGear, 0);
    assert.equal(credits, Math.ceil(design.chassis.frameKg * ({ aluminum: 3.2, titanium: 12 })[metal] - 1e-9));
    assert.equal(designBill(design).ligas, credits + gearCredits);
    assert.deepEqual(gear.map(groups => groups.kept), steelGear.map(groups => groups.kept));
    const rubber = chassisSpec('wheeled').structure.rubberShare.wheeled, price = ({ aluminum: 1.3, titanium: 3 })[metal];
    gear.forEach((groups, i) => {
      const steelPrice = steelGear[i].runningGear + steelGear[i].kept;
      assert(Math.abs(groups.runningGear + groups.kept - steelPrice * (rubber + (1 - rubber) * price)) <= price + 1, `${metal} wheel ${i}`);
    });
    assert.deepEqual(withChassisMetal(chassis, 'steel'), steel);
  }
  assert.equal(constructionCost(base.construction).chassis, Math.ceil(base.compiled.chassis.frameKg * 1.4 - 1e-9));
  assert.equal(withChassisMetal(steel, 'hha'), null);
});

test('reinforcement changes the real section and continues above the former class ceilings', () => {
  for (const [model, length, gauge, formerLimit] of [['wheeled', 8, 40, 38000], ['tracked', 7, 60, 70000]]) {
    const ordinary = model === 'wheeled' ? withAxleCount(ends(model, length), 4) : ends(model, length), reinforced = withFrameThickness(ordinary, gauge),
      before = compiled(ordinary).compiled, after = compiled(reinforced).compiled;
    sameStructure(reinforced, after.chassis);
    for (const field of ['sectionAreaM2', 'secondMomentM4', 'frameKg', 'frameLimitKg', 'gearLimitKg', 'limitKg'])
      assert.ok(after.chassis[field] > before.chassis[field], `${model}: ${field} grows with reinforcement`);
    assert.ok(after.chassis.limitKg > formerLimit, `${model}: the old class ceiling does not cap real reinforcement`);
    assert.ok(constructionCost(after).chassis > constructionCost(before).chassis);
    near(frameMass(after), after.chassis.frameKg);
  }
});

test('wheel rims and track structure share the chassis metal while rubber and optional armour keep their mass', () => {
  for (const model of MODELS) {
    const steel = { ...ends(model, 6), thicknessMm: 12 }, base = compiled(steel).compiled,
      armouredBase = compiled({ ...steel, armorMm: 10 }).compiled, rubber = chassisSpec(model).structure.rubberShare[model];
    assert.ok(rubber > 0 && rubber < 1);
    for (const metal of ['aluminum', 'titanium']) {
      const chassis = withChassisMetal(steel, metal), design = compiled(chassis).compiled,
        armoured = compiled({ ...chassis, armorMm: 10 }).compiled,
        density = MATERIALS[metal].density / MATERIALS.steel.density;
      for (const [i, part] of runningGear(design).entries()) {
        const original = runningGear(base)[i], plated = runningGear(armoured)[i], steelPlated = runningGear(armouredBase)[i];
        assert.equal(part.metal, metal);
        assert.equal(plated.metal, metal); assert.equal(plated.armorMm, 10);
        assert.equal(part.width, original.width); assert.equal(part.height, original.height);
        assert.deepEqual(part.suspension, original.suspension);
        near(part.physicalMass, original.physicalMass * (rubber + (1 - rubber) * density));
        assert.ok(part.physicalMass > original.physicalMass * density, 'rubber has not turned into a lighter metal');
        near(plated.physicalMass - part.physicalMass, steelPlated.physicalMass - original.physicalMass);
      }
    }
  }
});

test('a chassis retains its authored running geometry when a frame end cannot fit', () => {
  const wheel = withAxleCount(ends('wheeled', 6), 4), shortened = withChassisPoint({ chassis: wheel, components: [] }, 0, { x: -30, y: wheel.points[0].y }).chassis;
  assert.equal(chassisAxles(shortened).length, 4);
  assert.deepEqual(gearProblem(shortened), { code: 'AXLE_EXTENT', model: 'wheeled' });
  assert.deepEqual(coreProblem(shortened), { code: 'AXLE_EXTENT', model: 'wheeled' });
  const track = withTrackEnd(ends('tracked', 7), 'rear', 2), end = { x: 20, y: track.points[1].y }, changed = { ...track, points: [track.points[0], end] };
  assert.deepEqual(withChassisPoint({ chassis: track, components: [] }, 1, end).chassis, changed);
  assert.equal(chassisTrack(changed).wheels, chassisTrack(track).wheels);
  assert.deepEqual(coreProblem(changed), { code: 'TRACK_EXTENT', model: 'tracked' });
});

test('the workshop tells what the gear and the metal of a chassis refuse in its own words', () => {
  const told = constructionEditMessage;
  assert.equal(told({ code: 'AXLE_COUNT', model: 'wheeled' }), 'O chassi de rodas leva de 2 a 8 eixos.');
  assert.equal(told({ code: 'AXLE_SPACING', model: 'wheeled' }), 'Os eixos ficariam perto demais para esse tamanho de roda. Afaste os eixos ou reduza a rodagem.');
  assert.equal(told({ code: 'AXLE_EXTENT', model: 'wheeled' }), 'Cada roda fica inteira embaixo do chassi, entre as pontas dele.');
  assert.equal(told({ code: 'TRACK_LENGTH', model: 'tracked' }), 'O comprimento da esteira está fora dos limites para essa altura. Ajuste o comprimento ou a altura da esteira.');
  assert.equal(told({ code: 'TRACK_EXTENT', model: 'tracked' }), 'A esteira fica embaixo do chassi, sem passar das pontas dele.');
  assert.equal(told({ code: 'FIELD', model: 'tracked', field: 'metal' }), 'O chassi é de aço, alumínio ou titânio.');
  for (const model of Object.keys(CHASSIS_MODELS)) assert.equal(told({ code: 'CHASSIS_GEAR_KIND', model }),
    'Um chassi de rodas não tem esteira nem esquis, um de esteiras não tem eixos nem esquis, e uma aeronave só tem esquis.');
  assert.equal(told({ code: 'CHASSIS_BALANCE', model: 'aircraft', direction: 'front' }),
    'Com o que leva cheio ou vazio, o peso cairia à frente do patim dos esquis e a aeronave tombaria pousada. Leve os esquis para a frente ou o peso para trás.');
  // The skids of an aircraft: their runner under the frame, each leg on it clear of its ends, the two apart.
  assert.equal(told({ code: 'SKID_EXTENT', model: 'aircraft' }), 'O patim dos esquis fica embaixo do chassi, sem passar das pontas dele.');
  assert.equal(told({ code: 'SKID_RUNNER', model: 'aircraft', index: 1, least: .3 }),
    'A perna de trás dos esquis fica em cima do patim, a pelo menos 30 cm das pontas dele: afaste a perna da ponta ou estique o patim.');
  assert.equal(told({ code: 'SKID_SPACING', model: 'aircraft', least: .5 }), 'As pernas dos esquis ficam a pelo menos 50 cm uma da outra.');
  assert.equal(told({ code: 'SKID_GAP', model: 'aircraft', index: 0 }),
    'A perna da frente dos esquis ficaria sob um vão do chassi, sem longarina para segurá-la: leve a perna para baixo de um trecho de chassi.');
  assert.equal(told({ code: 'FIELD', model: 'aircraft', field: 'gearScale' }), 'O tamanho dos esquis deve ficar entre 50 e 150 %.');
  assert.equal(told({ code: 'CHASSIS_BALANCE', model: 'wheeled', direction: 'front' }),
    'Com o que leva cheio ou vazio, o peso cairia à frente do primeiro eixo e o veículo se arrastaria no casco. Leve um eixo para a frente ou o peso para trás.');
  assert.equal(told({ code: 'CHASSIS_BALANCE', model: 'tracked', direction: 'rear' }),
    'Com o que leva cheio ou vazio, o peso cairia atrás da esteira e o veículo se arrastaria no casco. Leve a esteira para trás ou o peso para a frente.');
  // Reinforce this long front overhang so that the fixture reaches the balance
  // check; the axle positions still put the centre of mass ahead of both.
  const ahead = { ...ends('wheeled', 4.8), thicknessMm: 20, axles: [6, 32] };
  assert.deepEqual(coreProblem(ahead), { code: 'CHASSIS_BALANCE', model: 'wheeled', direction: 'front' });
  assert.equal(gearProblem(ahead), null, 'the editor leaves the balance to the core, which knows where the weight is');
});
