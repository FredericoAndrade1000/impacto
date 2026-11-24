import test from 'node:test';
import assert from 'node:assert/strict';
import { CONSTRUCTION_TEMPLATES, createConstruction } from '../src/construction-templates.ts';
import { compileDraft, compileManufacture } from '../src/structured-construction.ts';
import { constructionCatalogue, constructionSupportSite } from '../src/construction-admission.ts';
import { coldConstructionPlacement, constructionSpan } from '../src/construction-placement.ts';
import { compileNativeConstruction, initNativeDynamics } from '../src/native-dynamics.ts';
import { DESIGN_VERSION, parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { skywatch } from './helpers/aircraft.js';
import { Terrain } from '../src/terrain.ts';

await initNativeDynamics();

// Consume the Native projection; do not rebuild physical geometry or reserve mass in JS.
const near = (a, b, label) => assert(Math.abs(a - b) <= 1e-8 * Math.max(1, Math.abs(a), Math.abs(b)), `${label}: ${a} != ${b}`);
function metric(b) {
  const m = b.manufacturing;
  assert(m?.envelope, 'Native manufacturing metrics must be published');
  for (const n of [m.emptyKg, m.envelope.lengthM, m.envelope.heightM]) assert(Number.isFinite(n) && n >= 0);
  return m;
}
function equal(a, b, label) {
  near(a.emptyKg, b.emptyKg, `${label}: dry mass`);
  near(a.envelope.lengthM, b.envelope.lengthM, `${label}: length`);
  near(a.envelope.heightM, b.envelope.heightM, `${label}: height`);
}
const build = source => compileDraft(source).compiled;

test('all templates publish generic dry mass and material dimensions, preserved on reopen and manufacture', () => {
  const terrain = new Terrain('flat');
  for (const { id, type } of CONSTRUCTION_TEMPLATES) {
    const source = createConstruction(id), b = build(source), m = metric(b);
    assert(m.emptyKg > 0 && m.envelope.lengthM > 0 && m.envelope.heightM > 0, id);
    if (b.chassis) {
      near(m.emptyKg, b.chassis.emptyKg, id);
      assert(m.emptyKg <= b.fixedAssembly.mass + 1e-7 && b.fixedAssembly.mass <= b.chassis.loadedKg + 1e-7, id);
    } else assert(m.emptyKg < b.fixedAssembly.mass, `${id}: full reserves exceed dry mass`);
    equal(m, metric(build(parseBlueprint(serializeBlueprint(source)))), `${id}: reopen`);
    if (type === 'structure') for (const facing of [-1, 1]) {
      const pose = coldConstructionPlacement(b, terrain, { x: 12, facing, settle: true }),
        site = constructionSupportSite(terrain, pose, constructionSpan(b));
      equal(m, metric(compileManufacture(source, site).compiled), `${id}: manufacture ${facing}`);
    }
  }
});

test('weapon aim sectors, recoil clearance and cartridge payload do not inflate manufacturing dimensions or dry mass', () => {
  // An exposed gun: changing the sector cannot cut new material out of a hull port.
  const wide = skywatch(), narrow = structuredClone(wide);
  narrow.components.find(p => p.kind === 'weapon').mount.sector = { min: -.2, max: .2 };
  const a = build(wide), b = build(narrow), gun = x => x.modules.find(p => p.kind === 'weapon');
  assert.notEqual(gun(a).barrelAngle, gun(b).barrelAngle, 'the sector changes the initial preview aim');
  equal(metric(a), metric(b), 'structural mounting axis');

  const source = createConstruction('heavy'), changedAmmo = structuredClone(source);
  changedAmmo.components.find(p => p.kind === 'weapon').weaponAmmo = 'he';
  const ap = build(source), he = build(changedAmmo);
  assert.notEqual(ap.fixedAssembly.mass, he.fixedAssembly.mass, 'different cartridge masses change built mass');
  equal(metric(ap), metric(he), 'cartridge payload');
  const catalogue = structuredClone(constructionCatalogue());
  catalogue.weapons.rh120.recoil *= .5;
  equal(metric(ap), metric(compileNativeConstruction(source, catalogue, true).compiled), 'empty recoil clearance');
});

function openPlate(vertical = false, extended = false) {
  return { version: DESIGN_VERSION, preset: 'bunker', name: 'Open plate',
    nodes: vertical ? [{ id: 'a', x: 0, y: 0 }, { id: 'b', x: 0, y: 80 }] : [{ id: 'a', x: -40, y: 40 }, { id: 'b', x: 40, y: 40 }],
    plates: [{ id: 'plate', a: 'a', b: 'b', material: 'steel', thicknessMm: 5, ...(extended ? { ends: { start: 20, end: 20 } } : {}) }], components: [] };
}

test('real stock extensions and post geometry count, independently of plate orientation', () => {
  const h = metric(build(openPlate())), v = metric(build(openPlate(true))), extended = metric(build(openPlate(false, true)));
  near(h.emptyKg, v.emptyKg, 'rotated plate mass');
  near(h.envelope.lengthM, v.envelope.heightM, 'rotated plate height');
  near(h.envelope.heightM, v.envelope.lengthM, 'rotated plate width');
  near(extended.envelope.lengthM - h.envelope.lengthM, 2, 'real end extensions');
  assert(extended.emptyKg > h.emptyKg);
  const camera = gap => {
    const source = openPlate();
    source.components = [{ id: 'camera', kind: 'sensor', sensorMode: 'visual', pose: { x: 0, y: (2 + .0025 + .12 + gap) / .05, angle: 0 } }];
    return build(source);
  };
  const flush = camera(0), raised = camera(.5), mast = raised.modules[0].support;
  assert(mast.mass > 0 && mast.polygon?.length >= 3, 'a physical support was actually generated');
  near(metric(raised).emptyKg - metric(flush).emptyKg, mast.mass, 'mass measured after support generation');
  near(metric(raised).emptyKg, raised.fixedAssembly.mass, 'no payload in this construction');
  near(metric(raised).envelope.heightM - metric(flush).envelope.heightM, .5, 'raised component and support height');
});

test('generated chassis and running gear are measured even without authored plates or equipment', () => {
  const b = build({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Bare chassis',
    chassis: { model: 'wheeled', points: [{ x: -60, y: -5 }, { x: 60, y: -5 }] }, nodes: [], plates: [], components: [] }), m = metric(b);
  near(m.emptyKg, b.fixedAssembly.mass, 'no payload');
  near(m.emptyKg, b.chassis.emptyKg, 'chassis mass parity');
  assert(m.envelope.lengthM >= 6 - 1e-8 && m.envelope.heightM >= 1.1 - 1e-8, 'frame and running gear count');
  const tilted = build({ version: DESIGN_VERSION, preset: 'vehicle', name: 'Tilted tracked chassis',
    chassis: { model: 'tracked', points: [{ x: -60, y: -6 }, { x: 60, y: 6 }] }, nodes: [], plates: [], components: [] }),
    outline = tilted.chassis.outlines.flat();
  // A tracked tub has no generated bottom rail. Its physical lower rear corner
  // extends beyond the deck; all of that Native outline still belongs to its size.
  for (const [axis, dimension] of [['x', 'lengthM'], ['y', 'heightM']]) {
    const span = Math.max(...outline.map(p => p[axis])) - Math.min(...outline.map(p => p[axis]));
    assert(metric(tilted).envelope[dimension] >= span - 1e-8, `the complete chassis ${dimension} counts`);
  }
});

test('cosmetics and translations preserve metrics; derived metrics cannot be authored', () => {
  const source = createConstruction('guard-post'), before = metric(build(source));
  source.name = 'Renamed project'; source.seed = 123; source.launcher = { x: 3, y: 2 };
  source.appearance = { paint: '#112233', automaticDetails: false, details: [] };
  source.nodes.forEach(p => p.x += 20); source.components.forEach(p => p.pose.x += 20);
  equal(before, metric(build(source)), 'metadata, cosmetics and translation');
  assert(!Object.hasOwn(compileDraft(source).construction, 'manufacturing'));
  assert.throws(() => compileDraft({ ...source, manufacturing: { emptyKg: 0, envelope: { lengthM: 0, heightM: 0 } } }), e => e.reason === 'AUTHORING_FIELDS');
  const empty = build({ version: DESIGN_VERSION, preset: 'bunker', name: 'Empty', nodes: [], plates: [], components: [] });
  assert(empty.admissionIssues.some(i => i.code === 'FRAME_EMPTY'));
  assert.deepEqual(metric(empty), { emptyKg: 0, envelope: { lengthM: 0, heightM: 0 } });
});
