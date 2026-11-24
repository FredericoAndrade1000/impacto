import test from 'node:test';
import assert from 'node:assert/strict';
import { MODULES } from '../src/materials.ts';
import { CHASSIS_MODELS, chassisGearSize, chassisSpec } from '../src/chassis.ts';
import { builtGear, trackGear, trackOutline, trackWheels } from '../src/running-gear.ts';
import { blueprintMass, pieceMass } from '../src/mass-properties.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { structuredTemplateSource } from '../src/structured-templates.ts';
import { constructionCost, pieceCost } from '../src/construction-cost.ts';
import { compileBlueprint, validateBlueprint, serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { vehicleBox } from './helpers/designs.js';
await initNativeDynamics();

const near = (a, b, slack = 1e-9) => assert(Math.abs(a - b) <= slack, `${a} is not ${b}`);
const flat = { height: () => 0, surface: x => ({ x, y: 0, nx: 0, ny: 1 }) };
// The track of the catalogue runs on seven road wheels: each takes a seventh of its length, at its height.
const pitch = height => MODULES.track.width / 7 * height / MODULES.track.height;

// Continuous authored track dimensions are covered in track-links.test.js and track-suspension.test.js.

test('road wheels too large to stand side by side are drawn in two rows, interleaved, none over another of its row', () => {
  let twice = 0;
  for (const scale of [.5, 1, 1.5]) for (let wheels = 3; wheels <= 14; wheels++) {
    const height = CHASSIS_MODELS.tracked.track * scale, width = wheels * pitch(height), gear = builtGear(width, height),
      { size, rows } = trackWheels(width, height), what = `${wheels} of ${height} m`, apart = gear.road[1].x - gear.road[0].x;
    assert.equal(gear.road.length, wheels, what);
    // Side by side they would stand over one another, or so close as to seem to touch: in two rows, every other one in each.
    assert.equal(rows, apart < 2 * size + .05 * height ? 2 : 1, what);
    for (const row of [0, 1]) {
      const xs = gear.road.filter(wheel => wheel.row === row).map(wheel => wheel.x);
      for (let i = 1; i < xs.length; i++) assert(xs[i] - xs[i - 1] >= 2 * size, `${what}: none over another in its row`);
    }
    if (rows === 1) { assert(gear.road.every(wheel => wheel.row === 0), what); continue; }
    twice++;
    // The inner row behind the outer one and in its shade, the sprocket and the idler between them.
    const order = gear.drawn.filter(wheel => wheel.role !== 'roller').map(wheel => wheel.role === 'road' ? wheel.shade < 1 ? 'inner' : 'outer' : wheel.role);
    assert.deepEqual([...new Set(order)], ['inner', 'sprocket', 'idler', 'outer'], what);
    assert.equal(order.filter(role => role === 'inner').length, Math.floor(wheels / 2), what);
  }
  assert(twice > 0, 'some tracks are drawn in two rows');
});

// A template with its chassis written in this armour.
const armoured = (template, mm) => {
  const source = structuredTemplateSource(template);
  source.chassis.armorMm = mm;
  return source;
};
const gearOf = compiled => compiled.modules.filter(module => ['wheel', 'track'].includes(module.kind));
// What a polygon covers.
const area = points => Math.abs(points.reduce((sum, p, i) => { const q = points[(i + 1) % points.length]; return sum + p.x * q.y - q.x * p.y; }, 0)) / 2;
// Steel of this thickness over the whole side of a piece of gear, on both sides of the vehicle: a wheel round, a track
// as far out as its belt round its wheels (its outline, each turn cut very fine).
const sides = (gear, mm) =>
  2 * (gear.kind === 'track' ? area(trackOutline(gear.width, gear.height, 0, 40000)) : Math.PI * (gear.height / 2) ** 2) * mm / 1000 * 7850;

test('the armour of the running gear weighs what steel of its thickness over both of its sides weighs', () => {
  for (const template of ['scout', 'heavy']) {
    const plain = gearOf(compileBlueprint(armoured(template, 0))), thin = gearOf(compileBlueprint(armoured(template, 10))),
      thick = gearOf(compileBlueprint(armoured(template, 30)));
    plain.forEach((gear, i) => {
      // As high as its chassis has its wheels or its track.
      assert.equal(gear.height, chassisGearSize(armoured(template, 0).chassis));
      assert.equal(gear.armorMm, undefined);
      assert.deepEqual([thin[i].armorMm, thick[i].armorMm], [10, 30]);
      near(pieceMass(thin[i]) - pieceMass(gear), sides(gear, 10), 1e-6);
      near(pieceMass(thick[i]) - pieceMass(gear), 3 * (pieceMass(thin[i]) - pieceMass(gear)), 1e-6);
    });
  }
});

test('the running gear wears the armour of its chassis by the millimetre: it is weighed and paid as the steel it is, and only the gear wears it', () => {
  for (const [template, limit] of [['heavy', 80], ['scout', 40]]) {
    const plain = compileBlueprint(armoured(template, 0)), cost = constructionCost(plain).total, mass = blueprintMass(plain),
      source = JSON.stringify(validateBlueprint(structuredTemplateSource(template)));
    assert.equal(chassisSpec(plain.chassis.model).armourMm, limit);
    for (const mm of [10, 25, limit]) {
      const design = armoured(template, mm), compiled = compileBlueprint(design);
      let armour = 0, paid = 0;
      assert.equal(compiled.chassis.armorMm, mm);
      gearOf(compiled).forEach((gear, i) => {
        const before = gearOf(plain)[i], steel = sides(gear, mm), price = pieceCost(gear) - pieceCost(before);
        assert.deepEqual([gear.id, gear.armorMm, gear.width, gear.height], [before.id, mm, before.width, before.height]);
        near(gear.physicalMass, before.physicalMass + steel, 1e-6);
        // Steel is paid 1.4 credits the kilogram, as the plates of the hull are.
        assert(Math.abs(price - steel * 1.4) <= 1, `${gear.id} ${mm} mm paid ${price}`);
        armour += steel; paid += price;
      });
      near(blueprintMass(compiled) - mass, armour, 1e-6);
      assert.equal(constructionCost(compiled).total - cost, paid);
      assert.deepEqual(parseBlueprint(serializeBlueprint(design)), validateBlueprint(design));
    }
    // Past what the gear of its model wears, it is refused in so many words.
    let refusal; try { validateBlueprint(armoured(template, limit + 5)); } catch (error) { refusal = constructionEditMessage(error); }
    assert.equal(refusal, `A blindagem da rodagem deste chassi vai até ${limit} mm.`);
    // No armour is the one that is not written.
    assert.equal(JSON.stringify(validateBlueprint(armoured(template, 0))), source);
  }
  const engine = structuredTemplateSource('heavy');
  engine.components.find(part => part.kind === 'engine').armorMm = 10;
  assert.throws(() => validateBlueprint(engine), error => error.reason === 'AUTHORING_FIELDS' && ["engine"].every(id => error.ids?.includes(id)));
});
