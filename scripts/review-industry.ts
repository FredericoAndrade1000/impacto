// Read-only economic sensitivity audit of the live industrial catalogue.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INDUSTRY_PROPOSAL } from './industry-proposal.ts';
import { reviewIndustryEconomy } from './review-industry-economy.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { initNativeDynamics, nativeDynamicsRuntime } from '../src/native-dynamics.ts';
import { CONSTRUCTION_TEMPLATES, createConstruction } from '../src/construction-templates.ts';
import { compileDraft, compileManufacture } from '../src/structured-construction.ts';
import { parseBlueprint, serializeBlueprint } from '../src/persistence.ts';
import { constructionSupportSite } from '../src/construction-admission.ts';
import { coldConstructionPlacement, constructionSpan } from '../src/construction-placement.ts';
import { industrialAdmission } from '../src/industry.ts';
import { industryExample } from '../src/industry-examples.ts';
import { CARGO } from '../src/component-volume.ts';
import { STARTING_STOCK, REFINE_RATE, POST_REFINE_RATE, billSum, designBill, designRoom, extractRate, buildSeconds } from '../src/economy.ts';
import { POST_BILL } from '../src/territory.ts';
import { Terrain } from '../src/terrain.ts';
import { aircraft, gunship, airMiner, airSupply, airBuilder } from '../tests/helpers/aircraft.js';
import type { CanonicalConstruction, CompiledConstruction } from '../src/construction-contract.ts';

await initNativeDynamics();
assert.equal(nativeDynamicsRuntime, 'native');
const terrain = new Terrain('flat');
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function inspect(source: unknown) {
  const { construction: s, compiled: b } = compileDraft(source), admission = industrialAdmission(s, b), requirements = { workshop: 0, hangar: 0, processing: 1 };
  for (const need of admission.requirements) requirements[need.facility] = need.level;
  const { emptyKg, envelope: { lengthM: length, heightM: height } } = admission.measurement;
  return { requirements: admission.oversized ? null : requirements,
    measurement: { emptyKg, length, height,
      status: admission.oversized ? 'outside-industrial-envelope' : 'native-manufacturing-metrics' }, source: s, compiled: b };
}

function manufacture(s: CanonicalConstruction, b: CompiledConstruction) {
  const results: { facing: number; admitted: boolean }[] = [];
  for (const facing of b.chassis ? [1] : [-1, 1]) {
    const pose = coldConstructionPlacement(b, terrain, { facing, settle: true });
    const site = b.chassis ? {} : constructionSupportSite(terrain, pose, constructionSpan(b));
    const made = compileManufacture(s, site).compiled;
    assert(made.mechanicalAdmission, `Mechanical refusal for ${s.name}: ${JSON.stringify(made.admissionIssues)}`);
    results.push({ facing, admitted: true });
  }
  return results;
}
function record(id: string, source: unknown) {
  const result = inspect(source), b = result.compiled, tool = b.modules.find(m => m.kind === 'excavator' || m.kind === 'drill');
  const extraction: { rate: number; workKw: number }[] = [];
  if (tool) { assert(typeof tool.workKw === 'number', 'A Native extractor must publish its workload'); extraction.push({ rate: extractRate(tool), workKw: tool.workKw }); }
  return { id, requirements: result.requirements, measurement: result.measurement,
    manufacture: manufacture(result.source, b), cost: designBill(b), capacity: designRoom(b),
    engineKw: b.modules.reduce((sum, m) => sum + ('powerKw' in m ? m.powerKw ?? 0 : 0), 0),
    extraction };
}
const templates = CONSTRUCTION_TEMPLATES.map(({ id }) => record(id, createConstruction(id)));
const airSources: readonly (readonly [string, unknown])[] = [['aircraft', aircraft()], ['gunship-eye', gunship({ eye: true })], ['air-miner', airMiner()],
  ['air-supply', airSupply()], ['air-builder', airBuilder()], ['gunship-eye-tank1.25', gunship({ eye: true, tankScale: 1.25 })]];
const air = airSources.map(([id, source]) => {
  const r = record(id, source), b = inspect(source).compiled;
  const fuel = b.modules.filter(m => m.kind === 'fuel').reduce((n, m) => n + m.fuelLitres, 0);
  assert(b.flight, 'An aircraft fixture must publish Native flight metrics');
  return { ...r, fuelLitres: fuel, hoverLitresPerSecond: b.flight.hoverLitres,
    theoreticalHoverSeconds: fuel / b.flight.hoverLitres, buildSeconds: buildSeconds(r.cost) };
});

// High-value counterexamples and metamorphic invariants, not tests of every
// configuration literal. Native refusals stay distinct from industrial gates.
const checks: string[] = [];
for (const id of ['mining-truck', 'construction-truck', 'truck', 'supply', 'tanker', 'grader', 'paver', 'scout', 'mortar',
  'guard-post', 'outpost', 'mining-site', 'oil-well']) {
  const t = templates.find(t => t.id === id);
  assert(t?.requirements, `Baseline template must fit the proposed envelope: ${id}`);
  assert.equal(t.requirements.workshop, 1, `Baseline role must remain buildable: ${id}`);
  assert.equal(t.requirements.processing, 1, `Baseline role must not need advanced materials: ${id}`);
}
checks.push('baseline mobile/fixed mining/building/logistics/roads/scouting/counters fit WorkshopI + ProcessingI');
const renamed = createConstruction('scout'); renamed.name = 'Aeronave pesada';
assert.deepEqual(inspect(parseBlueprint(serializeBlueprint(renamed))).requirements, inspect(createConstruction('scout')).requirements);
checks.push('renaming/export/import cannot alter requirements');
const defaultGun = createConstruction('heavy'), defaultWeapon = defaultGun.components.find(m => m.kind === 'weapon');
assert(defaultWeapon?.kind === 'weapon'); delete defaultWeapon.weaponPreset;
const heavyRequirements = inspect(defaultGun).requirements; assert(heavyRequirements); assert.equal(heavyRequirements.workshop, 3);
const ammoOnly = createConstruction('scout'), ammoBox = ammoOnly.components.find(m => m.kind === 'ammo');
assert(ammoBox?.kind === 'ammo'); ammoBox.ammoPreset = 'm777';
const ammunitionRequirements = inspect(ammoOnly).requirements; assert(ammunitionRequirements); assert.equal(ammunitionRequirements.workshop, 3);
checks.push('canonical default Rh120 and isolated M777 ammunition retain heavy family');
const firstAircraft = templates.find(item => item.id === 'air-scout'); assert(firstAircraft?.requirements); assert.equal(firstAircraft.requirements.processing, 1);
const largeTankAircraft = air.find(a => a.id === 'gunship-eye-tank1.25'); assert(largeTankAircraft);
assert.deepEqual(largeTankAircraft.requirements, { workshop: 1, hangar: 1, processing: 1 });
const chosenTi = aircraft(), chosenEngine = chosenTi.components.find(m => m.kind === 'engine');
assert(chosenEngine?.kind === 'engine'); chosenEngine.metal = 'titanium';
const titaniumRequirements = inspect(chosenTi).requirements; assert(titaniumRequirements); assert.equal(titaniumRequirements.processing, 3);
checks.push('intrinsic turbine Ti is covered by Hangar; chosen engine Ti requires ProcessingIII');
const invalidRadar = createConstruction('recon'), radar = invalidRadar.components.find(m => m.kind === 'sensor' && m.sensorMode === 'radar');
assert(radar?.kind === 'sensor'); radar.metal = 'plastic';
assert.throws(() => inspect(invalidRadar), (e: unknown) => recordValue(e) && (e.reason ?? e.code) === 'FIELD');
const unfed = createConstruction('scout'); unfed.components = unfed.components.filter(m => m.kind !== 'ammo');
const draftUnfed = compileDraft(unfed);
assert.throws(() => compileManufacture(draftUnfed.construction), (e: unknown) => recordValue(e) && (e.reason ?? e.code) === 'WEAPON_UNFED');
checks.push('invalid materials and unfed weapons fail Native before a capacity decision');
assert(templates.every(t => Number.isFinite(t.measurement.emptyKg) && t.measurement.emptyKg > 0));
checks.push('mobile and fixed projects use the same Native manufacturing mass and envelope');

const miner = templates.find(t => t.id === 'mining-truck'), tanker = templates.find(t => t.id === 'tanker');
assert(miner && tanker);
const economy = reviewIndustryEconomy({ templates, stock: STARTING_STOCK, postCost: POST_BILL, aircraft: firstAircraft,
  rawCapacity: { ferro: miner.capacity.solid * CARGO.ferro.density, ligas: miner.capacity.solid * CARGO.ligas.density,
    silica: miner.capacity.solid * CARGO.silica.density, petroleo: tanker.capacity.liquid } });
const runtime = nativeRuntimeInfo('native');
assert(runtime.runtime === 'native');
const openingProjects = [
  { upgrade: 'workshop-ii', project: templates.find(t => t.id === 'ifv') },
  { upgrade: 'hangar-i', project: firstAircraft },
  { upgrade: 'processing-ii', project: record('scout-hha-steel-plates-glass-preserved', industryExample('processing-ii').source) },
].map(({ upgrade, project }) => {
  assert(project, `Missing proposed opening project for ${upgrade}`);
  const installation = INDUSTRY_PROPOSAL.upgrades.find(n => n.id === upgrade); assert(installation);
  return { upgrade, project: project.id, requirements: project.requirements,
  installationCost: installation.cost,
  firstUnitAndInstallationCost: billSum(installation.cost, project.cost),
  nextFullReplacementCost: project.cost,
  missionStatus: 'Native manufacture admitted; mission value, ammunition, servicing and sustained fuel not measured' };
});
const report = { status: 'offline sensitivity audit; does not mutate a live field', runtime: { kind: nativeDynamicsRuntime,
  sourceSHA256: runtime.sourceSHA256, binarySHA256: runtime.binarySHA256 }, proposal: INDUSTRY_PROPOSAL, checks,
  templates, aircraft: air, openingProjects, refining: { basePerSecond: REFINE_RATE, postPerSecond: POST_REFINE_RATE }, economy };
const out = process.argv.indexOf('--out');
if (out >= 0) {
  const path = process.argv[out + 1];
  if (!path) throw new Error('--out needs a path');
  writeFileSync(resolve(path), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ status: report.status, runtime: report.runtime, checks,
  admittedTemplates: templates.length, admittedAircraftFixtures: air.length,
  measurementAuthority: 'Native manufacturing projection for mobile and fixed projects',
  totalCandidateCost: economy.totalCost,
  financing: economy.results.map(({ scenario, factor, status, failure, firstPurchaseMinutes, fundedHours, optimisticAircraftReadyMinutes }) =>
    ({ scenario, factor, status, failure, firstPurchaseMinutes, fundedHours, optimisticAircraftReadyMinutes })) }, null, 2));
