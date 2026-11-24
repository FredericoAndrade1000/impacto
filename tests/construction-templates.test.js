import test from 'node:test';
import assert from 'node:assert/strict';
import { structuredTemplateSource, createStructuredTemplate, templateCatalogue } from '../src/structured-templates.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { duel } from './helpers/duel.js';
import { World } from '../src/physics.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';
import { firingSolution, flightPoint } from '../src/ballistics.ts';
import { blueprintMass, pieceMass } from '../src/mass-properties.ts';
import { constructionCost, pieceCost } from '../src/construction-cost.ts';
import { reserveState } from '../src/component-volume.ts';
import { DESIGN_VERSION, validateBlueprint, compileBlueprint } from '../src/persistence.ts';
import { muzzleObstruction } from '../src/weapon-geometry.ts';
import { designBill } from '../src/economy.ts';

test('current native templates are deterministic, admitted and use only basic sensors', () => {
  for (const { id } of templateCatalogue().templates) {
    const a = createStructuredTemplate(id);
    assert.deepEqual(a, createStructuredTemplate(id)); assert.equal(a.version, DESIGN_VERSION);
    assert.equal('rideHeight' in a, false);
    for (const c of a.components) {
      assert.equal('placement' in c, false);
      assert([c.pose.x, c.pose.y, c.pose.angle].every(Number.isFinite));
      if (c.kind === 'sensor') assert(['visual', 'radar', 'sound'].includes(c.sensorMode));
      if (c.kind === 'weapon') assert(c.mount.preset && Number.isFinite(c.mount.sector.min) && Number.isFinite(c.mount.sector.max));
    }
  }
  for (const sensorMode of ['camera-track', 'radar-track', 'unknown'])
    assert.throws(() => createStructuredTemplate('scout', { sensorModes: [sensorMode] }), /sensor mode|Modo de sensor|SENSOR_MODE/);
  const options = { preset: 'rh120', engineScale: 1 }, before = structuredClone(options);
  assert.deepEqual(structuredTemplateSource('heavy', options), structuredTemplateSource('heavy', options));
  assert.deepEqual(options, before);
});

test('the starter miner carries its excavation equipment and a separate hopper within a light tracked chassis limit', () => {
  const source = createConstruction('mining-truck'), compiled = compileBlueprint(source), { chassis, modules } = compiled;
  assert.equal(compiled.mechanicalAdmission, true);
  assert.equal(chassis.kind, 'tracked'); assert(chassis.limitKg > 0);
  assert(chassis.loadedKg > chassis.emptyKg && chassis.loadedKg <= chassis.limitKg * .9);
  assert.equal(source.chassis.thicknessMm, 12);
  assert.equal(source.components.find(component => component.kind === 'engine').sizeScale, 1);
  assert(chassis.loadedKg < 14000, 'the ordinary mining kit remains light with a full iron-ore hopper');
  assert.deepEqual(modules.map(module => module.kind).sort(), ['command', 'engine', 'excavator', 'fuel', 'hopper', 'sensor', 'track']);
  const hopper = modules.find(module => module.kind === 'hopper'), excavator = modules.find(module => module.kind === 'excavator');
  assert(hopper.capacityM3 > 1);
  for (const module of [hopper, excavator]) {
    assert.equal(module.exposed, true); assert.equal(module.angle, 0);
  }
  assert.equal(source.components.find(component => component.kind === 'hopper').pose.mirrored, true);
  assert.equal(source.components.find(component => component.kind === 'excavator').pose.mirrored, undefined);
  assert(excavator.x - excavator.width / 2 - (hopper.x + hopper.width / 2) > .09);
  assert.deepEqual(validateBlueprint(JSON.parse(JSON.stringify(source))), source, 'the initial vehicle remains an ordinary editable document');
});

test('field construction offers an editable light fixed defence and a tracked builder with separate real supplies', () => {
  const source = createStructuredTemplate('guard-post'), guard = compileBlueprint(source), price = designBill(guard);
  assert.equal(source.preset, 'bunker'); assert.equal(guard.vehicle.enabled, false); assert.equal(price.combustivel, 0);
  assert(price.ferro > 0 && price.ferro < 7000);
  assert.deepEqual(guard.modules.map(piece => piece.kind).sort(), ['ammo', 'command', 'sensor', 'weapon']);
  assert(guard.modules.some(piece => piece.weaponPreset === 'minimi'));
  const edited = structuredClone(source); edited.name = 'Defesa editada'; edited.appearance = { paint: '#a99760' };
  assert.deepEqual(validateBlueprint(edited), edited);
  const builder = compileBlueprint(createStructuredTemplate('construction-truck'));
  assert.equal(builder.chassis.kind, 'tracked'); assert(builder.chassis.loadedKg < builder.chassis.limitKg * .9);
  assert.equal(builder.modules.filter(piece => piece.kind === 'builder').length, 1);
  assert.equal(builder.modules.filter(piece => piece.kind === 'supply').length, 1);
  assert(!builder.modules.some(piece => ['weapon', 'ammo', 'excavator', 'drill'].includes(piece.kind)));
});

test('sensor modes keep fixed proportions and their physical mass, price and persistence', () => {
  for (const [mode, spec] of Object.entries(SENSOR_MODES)) {
    const b = createConstruction('scout', { sensorModes: [mode] }),
      sensor = compileBlueprint(b).modules.find(m => m.kind === 'sensor');
    assert.equal(pieceMass(sensor), spec.mass); assert.equal(pieceCost(sensor), spec.cost);
    assert.equal(validateBlueprint(b).components.find(m => m.kind === 'sensor').sensorMode, mode);
    const oversized = structuredClone(b); oversized.components.find(m => m.kind === 'sensor').sizeScale = 2;
    assert.throws(() => validateBlueprint(oversized), { reason: 'FIELD' });
    b.components.find(m => m.kind === 'sensor').sensorMode = 'xray';
    assert.throws(() => validateBlueprint(b), { reason: 'SENSOR_MODE' });
  }
});

// The support vehicle with a tank cannon and a machine gun beside it: a little shorter than the stock one, with thinner
// armour and a slightly smaller engine.
const dualSupport = () => createConstruction('ifv', { preset: 'rh120', dual: true, stretch: .996293058199808,
  armourScale: .8373825652524829, engineScale: .9842225659219548, sensorModes: ['visual', 'radar'] });

test('a dual support vehicle keeps its hardware, reserves, mass and cost when clearing the secondary bore', () => {
  const source = dualSupport(), b = compileBlueprint(source);
  validateBlueprint(source);
  assert.equal(b.mechanicalAdmission, true);
  assert(Math.abs(blueprintMass(b) - b.fixedAssembly.mass) < 1e-8);
  assert(constructionCost(b).total > 0);
  assert.deepEqual(b.modules.filter(m => m.kind === 'weapon').map(m => m.weaponPreset), ['rh120', 'm2hb']);
  assert.deepEqual(b.modules.filter(m => m.kind === 'sensor').map(m => m.sensorMode),
    ['visual', 'radar'], 'only the requested roof sensors; the Command uses its own visor');
  const reserves = b.modules.filter(m => ['fuel', 'ammo'].includes(m.kind));
  assert.deepEqual(reserves.map(m => [m.kind, m.ammoPreset ?? null, m.width, m.height]),
    [['fuel', null, .8, .72], ['ammo', 'rh120', .78, .65], ['ammo', 'm2hb', .78, .65]]);
  assert(reserves.every(m => m.kind === 'fuel' ? m.fuelLitres === m.capacityLitres : m.rounds === m.capacityRounds && reserveState(m).rounds > 0),
    'its tank and its boxes are built full');
  assert.deepEqual(compileBlueprint(dualSupport()), b);
});

test('a dual support vehicle fires its real secondary M2HB left and right without passing through own material', t => {
  for (const direction of [-1, 1]) {
    const b = dualSupport();
    const compiled = compileBlueprint(b);
    assert.equal(compiled.mechanicalAdmission, true);
    const w = new World(b); t.after(() => w.dispose());
    w.removeActor('local');
    w.addActor(b, { id: 'local', ownerId: 'local', facing: direction });
    const gun = w.modules.find(m => m.weaponPreset === 'm2hb');
    const settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id }), launcher = w.launcher(settings),
      aim = { x: gun.x + direction * 50, y: gun.y }, muzzle = firingSolution(launcher, aim, settings);
    assert.equal(muzzleObstruction(w.index, w.terrain, launcher, muzzle, settings.radius), null);
    assert(w.fire(aim, settings, true), 'native firing accepts the unblocked mounted M2HB');
    assert.equal(w.stats.shots, 1);
    assert.equal(w.drainEvents().some(e => e.type === 'weapon-blocked'), false);
  }
});

test('weapon mouths physically clear the closed tank turret from the machine guns to the howitzers', () => {
  for (const preset of ['m2hb', 'fnmag', 'm242', 'rh120', 'at4', 'mk19', 'm252', 'm119', 'm224', 'm777']) {
    const w = duel(null, createConstruction('heavy', { preset }));
    try {
      const gun = w.modules.find(m => m.actorId === 'local' && m.kind === 'weapon'),
        settings = w.playerWeapon({ platform: 'vehicle', componentId: gun.id,
          trajectory: ['m252', 'm119', 'm224', 'm777'].includes(preset) ? 'high' : 'direct' }, 'local'),
        solution = firingSolution(gun, { x: gun.x + 80, y: gun.y }, settings),
        end = flightPoint(solution, Math.min(.02, solution.time)),
        hit = w.index.raycast(solution, end, { ignoreIds: new Set([gun.id, gun.bodyId].filter(Boolean)) });
      // A high arc to 80 m asks more elevation than the closed turret gives, and 80 m is too near for it; the bearing
      // tested is then the limit of the mount.
      assert(solution.reachable || solution.limit === 'near', preset + ' must have a test trajectory within range');
      assert.notEqual(hit?.owner.object.actorId, 'local', preset + ' must clear its own armour');
    } finally { w.dispose(); }
  }
});
