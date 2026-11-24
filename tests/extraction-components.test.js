import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MODULES, METALS, PIECE_METALS } from '../src/materials.ts';
import { componentSizeLimits } from '../src/component-size.ts';
import { cargoRoom, holdsCargo } from '../src/component-volume.ts';
import { pieceMass, blueprintMass } from '../src/mass-properties.ts';
import { pieceCostBreakdown } from '../src/construction-cost.ts';
import { createStructuredConstruction, planStructuredComponent,
  structuredPlacementIntent, compileStructuredConstruction } from '../src/structured-construction.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { FrameWriter, FrameReader } from '../src/network-protocol.ts';
import { CELL } from '../src/grid.ts';

await initNativeDynamics();
const near = (a, b) => assert(Math.abs(a - b) < 1e-7, `${a} differs from ${b}`);
const base = () => createStructuredConstruction({ length: 8, height: 3, thicknessMm: 10,
  frontInset: 0, rearInset: 0, preset: 'bunker', chassis: null });
// Standing on the floor, whose face is 2.405 m up: on the first cell clear of it.
const machine = (kind, extra = {}) => ({ id: 'machine', kind, ...extra,
  pose: { x: 0, y: Math.ceil((2.405 + MODULES[kind].height * (extra.sizeScale ?? 1) / 2) / CELL - 1e-9), angle: 0 } });

for (const [kind, mass, price, health] of [['excavator', 650, 1800, 140], ['drill', 800, 2200, 130], ['builder', 700, 2200, 140]]) {
  test(`${kind}: canonical dimensions, mass and price follow size and metal, without cargo`, () => {
    const source = base(), before = blueprintMass(source);
    assert.deepEqual(PIECE_METALS[kind], ['steel', 'aluminum', 'titanium']);
    for (const scale of [.25, 1, componentSizeLimits({ kind }).max]) for (const metal of PIECE_METALS[kind].map(id => METALS[id])) {
      const [massShare, priceShare] = { steel: [1, 1], aluminum: [.65, 1.3], titanium: [.6, 3] }[metal.id],
        result = planStructuredComponent(source, machine(kind, { sizeScale: scale, metal: metal.id })),
        part = result.compiled.modules[0], cost = pieceCostBreakdown(part);
      near(part.width, MODULES[kind].width * scale); near(part.height, MODULES[kind].height * scale);
      // Its size makes it longer and taller, as deep across the body at any size: mass and price follow the square of it.
      near(part.mechanicalDepth, MODULES[kind].depthM);
      near(pieceMass(part), mass * scale ** 2 * massShare);
      near(part.maxHealth, health * metal.health);
      near(blueprintMass(result.compiled) - before, pieceMass(part));
      assert.equal(cost.engines, Math.ceil(price * scale ** 2 * priceShare - 1e-9));
      assert.equal(cost.storage, 0); assert.equal(cost.supplies, 0);
      assert.equal(holdsCargo(part), false); assert.equal(cargoRoom(part), 0);
      assert(!Object.hasOwn(part, 'capacityM3')); assert(!Object.hasOwn(part, 'cargo'));
      assert.equal(part.attached, true); assert.equal(part.exposed, true);
    }
  });

  test(`${kind}: cursor authors the requested pose without searching for a supporting face`, () => {
    const source = base(), compiled = compileStructuredConstruction(source),
      point = { x: compiled.frame.origin.x, y: compiled.frame.origin.y + 1 }, part = { id: 'machine', kind },
      pose = structuredPlacementIntent(part, point);
    assert.deepEqual(pose, { x: 0, y: 20, angle: 0 });
    assert.deepEqual(planStructuredComponent(source, { ...part, pose }).component.pose, pose);
    const positioned = planStructuredComponent(source, { ...part, pose }).compiled.modules[0];
    assert.equal(positioned.x, point.x); assert.equal(positioned.y, point.y);
    for (const extra of [{ cargo: {} }, { capacityM3: 10 }, { physicalMass: 0 }])
      assert.throws(() => planStructuredComponent(source, machine(kind, extra)), { reason: 'AUTHORING_FIELDS' });
  });

  test(`${kind}: stable identity survives canonical save and binary network framing`, () => {
    const result = planStructuredComponent(base(), machine(kind));
    assert.deepEqual(parseBlueprint(serializeBlueprint(result.construction)), result.construction);
    const packet = { type: 'state', seq: 7, state: { modules: result.compiled.modules } },
      decoded = new FrameReader().decode(new FrameWriter().encode(packet, true));
    const part = decoded.state.modules[0], original = packet.state.modules[0];
    assert.equal(decoded.seq, packet.seq); assert.equal(part.kind, kind); assert.equal(part.id, 'machine');
    for (const key of ['width', 'height', 'mechanicalDepth', 'physicalMass', 'maxHealth', 'exposed'])
      assert.equal(part[key], original[key], key);
    assert(Math.abs(part.x - original.x) <= .00005); assert(Math.abs(part.y - original.y) <= .00005);
  });
}
