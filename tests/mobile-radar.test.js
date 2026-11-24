import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { createStructuredConstruction, planStructuredComponent } from '../src/structured-construction.ts';
import { compileBlueprint, validateBlueprint, serializeBlueprint, parseBlueprint } from '../src/persistence.ts';
import { Editor } from '../src/editor.ts';
import { componentDepth } from '../src/component-volume.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { pieceCost } from '../src/construction-cost.ts';
import { sensorSupport } from '../src/sensor-support.ts';

await initNativeDynamics();
const near = (a, b) => assert(Math.abs(a - b) < 1e-8, `${a} differs from ${b}`);

test('new radars use their compact base envelope on a continuous roof, with full detection and real support', () => {
  for (const id of ['recon', 'heavy', 'ifv', 'scout']) {
    const source = createConstruction(id, { sensorModes: ['visual', 'radar', 'sound'] }), b = compileBlueprint(source),
      radar = b.modules.find(p => p.sensorMode === 'radar'), authored = source.components.find(p => p.id === radar.id),
      roof = source.plates.find(p => p.id === 'turret:roof'), sight = b.sights.find(s => s.mode === 'radar');
    assert.equal(authored.sizeScale, 1); assert.equal(authored.radarModel, 'mobile');
    near(radar.width, .65); near(radar.height, .546); near(componentDepth(radar), .13);
    assert.equal(pieceMass(radar), 35); assert.equal(pieceCost(radar), 12000);
    assert.deepEqual([roof.a, roof.b], ['turret-top-rear', 'turret-top-front']);
    assert(!source.plates.some(p => p.id.startsWith('turret:radar-')));
    assert.deepEqual([sight.range, sight.left, sight.right], [8000, 8000, 8000]);
    // It stands right on the roof (game_construction.rs `standoff`), painted with its own foot.
    assert.equal(radar.support.host, roof.id); assert.equal(radar.support.reach, 0);
    for (const foot of radar.support.foot) near(foot.y, -radar.height / 2);
    assert.equal(sensorSupport(radar), null);
    assert.deepEqual(parseBlueprint(serializeBlueprint(source)), source);
  }
});

test('unlabelled saved radars preserve their full-size envelope and mass while newly added hardware uses the mobile base', () => {
  const base = createStructuredConstruction({ length: 8, height: 3 }),
    part = { id: 'radar', kind: 'sensor', sensorMode: 'radar', pose: { x: 0, y: base.nodes[0].y + 15, angle: 0 } },
    old = planStructuredComponent(base, part).construction, b = compileBlueprint(old), radar = b.modules.find(p => p.id === part.id);
  assert.equal(old.components.find(p => p.id === part.id).radarModel, 'legacy');
  near(radar.width, 1); near(radar.height, .84); near(componentDepth(radar), .2);
  assert.equal(pieceMass(radar), 90); assert.equal(pieceCost(radar), 12000);
  assert.deepEqual(parseBlueprint(serializeBlueprint(old)), old);
  const editor = new Editor(base), added = editor.addModule('sensor', { x: 12, y: 2.5 }, { sensorMode: 'radar' });
  assert.equal(added.radarModel, 'mobile'); near(added.width, .65); near(added.height, .546);
  for (const bad of ['tiny', null, 2]) {
    const invalid = structuredClone(old); invalid.components.find(p => p.id === part.id).radarModel = bad;
    assert.throws(() => validateBlueprint(invalid));
  }
});
