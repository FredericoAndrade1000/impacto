// Current catalogue products and real fresh-vehicle replacement quotes.
// All work stays in an isolated room; price sensitivity never changes a live field.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rehearsal } from '../server/room.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { compileManufacture } from '../src/structured-construction.ts';
import { MATERIALS } from '../src/materials.ts';
import { bill, billSum, STOCK_IDS, STARTING_STOCK, designBill } from '../src/economy.ts';
import { POST_BILL } from '../src/territory.ts';
import { CONSTRUCTION_LIMITS } from '../src/construction-limits.ts';
import { INDUSTRY_UPGRADES, BASIC_INDUSTRY, industrialAdmission } from '../src/industry.ts';
import { industryExampleSource } from '../src/industry-examples.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { foundationAccess } from './review-foundations.ts';
import type { SupplyBill } from '../src/economy-contract.ts';
import type { MaterialId } from '../src/materials.ts';
import type { WeaponId, WeaponPresetId } from '../src/weapons.ts';
import type { IndustryRequirement, UpgradeId } from '../src/industry.ts';

interface Product {
  price: SupplyBill; emptyKg: number; glass: { id: string; thicknessMm: number }[];
  ammunition: { preset: WeaponId; rounds: number }[]; requirements: IndustryRequirement[]; replaceGrantedScout?: SupplyBill;
}
interface Opening {
  upgrade: string; product: string; factor: number; mode: string; cost: SupplyBill;
  affordableFromInitial: boolean; shortage: SupplyBill; vehicleCountWithKit: number; nextFullLossReplacement: SupplyBill;
  installations: UpgradeId[];
}
interface Bundle { id: string; units: string[]; upgrade?: string; post?: boolean }

const sum = (costs: readonly SupplyBill[]): SupplyBill => costs.reduce((total, cost) => billSum(total, cost), bill());
const scaled = (cost: SupplyBill, factor: number): SupplyBill => bill(cost.ferro * factor, cost.ligas * factor, cost.silica * factor, cost.combustivel * factor);
const shortage = (wallet: SupplyBill, cost: SupplyBill): SupplyBill => bill(Math.max(0, cost.ferro - wallet.ferro), Math.max(0, cost.ligas - wallet.ligas), Math.max(0, cost.silica - wallet.silica), Math.max(0, cost.combustivel - wallet.combustivel));
const fits = (wallet: SupplyBill, cost: SupplyBill): boolean => STOCK_IDS.every(id => cost[id] <= wallet[id] + 1e-6);
const materialScout = (material: MaterialId, preset: WeaponPresetId = 'm2hb') => {
  const s = createConstruction('scout', { preset });
  for (const p of s.plates) if (p.material === 'steel') p.material = material;
  return s;
};
const baseline = createConstruction('scout'), glass = new Map(baseline.plates.filter(p => p.material === 'glass').map(p => [p.id, p.thicknessMm]));
const steelControl = createConstruction('scout', { armourScale: 1.26 });
for (const p of steelControl.plates) { const thickness = glass.get(p.id); if (thickness !== undefined) p.thicknessMm = thickness; }
const sources = {
  scout: baseline, rh202: createConstruction('scout', { preset: 'rh202' }), at4: createConstruction('scout', { preset: 'at4' }),
  mortar: createConstruction('mortar'), ifv: createConstruction('ifv'),
  'm119-light': createConstruction('scout', { preset: 'm119' }), 'm119-large': createConstruction('howitzer', { preset: 'm119' }),
  'air-scout': industryExampleSource('hangar-i'), 'air-supply': industryExampleSource('hangar-ii'),
  heavy: industryExampleSource('workshop-iii'), titanium: industryExampleSource('processing-iii'),
  hha: materialScout('hha'), 'hha-rh202': materialScout('hha', 'rh202'), aluminum: materialScout('aluminum'), 'steel-control': steelControl,
  miner: createConstruction('mining-truck'), tanker: createConstruction('tanker'),
};
const products: Record<string, Product | undefined> = Object.fromEntries(Object.entries(sources).map(([id, source]) => {
  const result = compileManufacture(source), b = result.compiled;
  assert(b.mechanicalAdmission, `Native manufacture must admit ${id}`);
  assert(b.chassis, `Mobile Native product must publish its chassis: ${id}`);
  const admission = industrialAdmission(result.construction, b);
  assert.equal(admission.oversized, null, `The current industrial catalogue must admit ${id}`);
  return [id, { price: designBill(b), emptyKg: admission.measurement.emptyKg, requirements: admission.requirements,
    glass: result.construction.plates.filter(p => p.material === 'glass').map(p => ({ id: p.id, thicknessMm: p.thicknessMm })),
    ammunition: b.modules.filter(m => m.kind === 'ammo').map(m => ({ preset: m.ammoPreset, rounds: m.rounds })) }];
}));
const product = (id: string): Product => { const value = products[id]; assert(value, `Missing admitted product ${id}`); return value; };
assert.deepEqual(product('hha').glass, product('scout').glass, 'Material variants must preserve the visor');
assert.deepEqual(product('steel-control').glass, product('scout').glass);

// Include earlier levels when comparing a branch from the basic starting base.
// The next replacement pays only for the unit, with those installations retained.
const installations = (id: string) => {
  const target = INDUSTRY_UPGRADES.find(upgrade => upgrade.id === id); assert(target);
  return INDUSTRY_UPGRADES.filter(upgrade => upgrade.facility === target.facility && upgrade.level <= target.level);
};
const upgradeCost = (id: string, factor: number): SupplyBill => scaled(sum(installations(id).map(upgrade => upgrade.cost)), factor);
const choices: readonly (readonly [UpgradeId, string])[] = [
  ['workshop-ii', 'ifv'], ['workshop-ii', 'm119-light'], ['workshop-ii', 'm119-large'],
  ['workshop-iii', 'heavy'], ['hangar-i', 'air-scout'], ['hangar-ii', 'air-supply'],
  ['processing-ii', 'hha'], ['processing-ii', 'aluminum'], ['processing-ii', 'hha-rh202'],
  ['processing-iii', 'titanium'],
];
for (const [upgrade, id] of choices) {
  const target = INDUSTRY_UPGRADES.find(step => step.id === upgrade); assert(target);
  assert(product(id).requirements.every(need => need.level <=
    (need.facility === target.facility ? target.level : BASIC_INDUSTRY[need.facility])), `${id} must fit the complete priced branch`);
}
const room = rehearsal([0], undefined, { starter: true, fog: false });
let openings: Opening[] = [];
try {
  const p = room.join('Orçamento'), old = room.owned(p.playerId).find(a => a.blueprint.modules.some(m => m.kind === 'weapon'));
  assert(old, 'The granted kit must contain the scout');
  const quotes = Object.fromEntries(Object.entries(sources).map(([id, source]) => [id, room.draft(p.playerId, source, { actorId: old.id }).cost]));
  const quote = (id: string): SupplyBill => { const value = quotes[id]; assert(value); return value; };
  openings = [.75, 1].flatMap(factor => choices.flatMap(([upgrade, productId]) => ['additional', 'replace-granted-scout'].map(mode => {
    const cost = billSum(upgradeCost(upgrade, factor), mode === 'additional' ? product(productId).price : quote(productId));
    return { upgrade, product: productId, factor, mode, cost, affordableFromInitial: fits(STARTING_STOCK, cost),
      shortage: shortage(STARTING_STOCK, cost), vehicleCountWithKit: mode === 'additional' ? 4 : 3,
      nextFullLossReplacement: product(productId).price, installations: installations(upgrade).map(step => step.id) };
  })));
  for (const id of ['hha', 'steel-control', 'm119-light'])
    assert.deepEqual(quote(id), billSum(product(id).price, product('scout').price, -1), 'Fresh full-kit quote agrees with the complete refundable scout');
  product('hha').replaceGrantedScout = quote('hha');
  product('steel-control').replaceGrantedScout = quote('steel-control');
} finally { room.field.dispose(); }

const wallet = bill(140000, 18000, 10000, 1500);
const bundleInputs: Bundle[] = [
  { id: 'basic-six-scouts', units: Array<string>(6).fill('scout') },
  { id: 'basic-combined-and-post', units: ['scout', 'rh202', 'at4', 'mortar'], post: true },
  { id: 'basic-logistics-and-post', units: ['miner', 'tanker', 'scout', 'scout'], post: true },
  { id: 'workshop-light-artillery-and-20mm', upgrade: 'workshop-ii', units: ['m119-light', 'rh202'] },
  { id: 'hangar-and-mortars', upgrade: 'hangar-i', units: ['air-scout', 'mortar', 'mortar'] },
  { id: 'processing-hha-and-scouts', upgrade: 'processing-ii', units: ['hha', 'scout', 'scout'] },
];
const bundles = bundleInputs.map(bundle => {
  const cost = sum([...(bundle.upgrade ? [upgradeCost(bundle.upgrade, 1)] : []),
    ...bundle.units.map(id => product(id).price), ...(bundle.post ? [POST_BILL] : [])]);
  const vehicleCount = 3 + bundle.units.length;
  return { ...bundle, cost, vehicleCount, affordable: fits(wallet, cost) && vehicleCount <= CONSTRUCTION_LIMITS.vehicles,
    remainingStock: billSum(wallet, cost, -1) };
});
assert(bundles.every(b => b.affordable), 'Common-wallet bundles must be affordable in every stock and within the shared quota');
const hha = sources.hha, controlById = new Map(steelControl.plates.map(p => [p.id, p]));
const nominalRatios = hha.plates.filter(p => p.material === 'hha').map(p => {
  const control = controlById.get(p.id);
  assert(control);
  return control.thicknessMm * MATERIALS.steel.resistance / (p.thicknessMm * MATERIALS.hha.resistance);
});
const runtime = nativeRuntimeInfo('native'); assert(runtime.runtime === 'native');
const report = {
  scope: 'Read-only admission, replacement prices and budget baskets; no PvP equivalence or measured income',
  runtime: { sourceSHA256: runtime.sourceSHA256, binarySHA256: runtime.binarySHA256 },
  assumptions: { wallet, initial: STARTING_STOCK,
    quotes: 'Actual SharedRoom.draft quotes on the pristine granted scout with full tank/ammunition, current terrain placement and full installed capacity; no publication or installation executes.',
    capital: 'Only installation prices scale. Earlier levels of the branch are included from the basic base; product prices and post bills stay current. Assembly time and mission utility are not measured.',
    bundles: 'Keep the three granted roles and all unspent stock. Products admitted individually; whole formation, post geography, ammunition use and supply not simulated.',
    materialControl: 'HHA changes steel plates only. Steel1.26 regenerates mounting/geometry, then restores original glass. Nominal thickness*resistance is not ballistic equivalence.',
    upperBounds: 'Fresh replacement credit is optimistic for used or damaged vehicles; use the real quote in play. No returns, salvage-income or daily rewards are invented.' },
  foundations: foundationAccess(), products, openings, bundles, steelControl: { minNominalRatioToHha: Math.min(...nominalRatios), maxNominalRatioToHha: Math.max(...nominalRatios),
    hhaMassSavedKg: product('steel-control').emptyKg - product('hha').emptyKg,
    hhaExtraFePerReplacement: product('hha').price.ferro - product('steel-control').price.ferro } };
const out = process.argv.indexOf('--out');
if (out >= 0) {
  const path = process.argv[out + 1];
  if (!path) throw new Error('--out needs a path');
  writeFileSync(resolve(path), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ scope: report.scope, steelControl: report.steelControl,
  initialOpenings: openings.filter(o => o.factor === 1 && o.mode === 'replace-granted-scout')
    .map(({ upgrade, product, cost, affordableFromInitial, shortage }) => ({ upgrade, product, cost, affordableFromInitial, shortage })),
  bundles: bundles.map(({ id, cost, vehicleCount, affordable }) => ({ id, cost, vehicleCount, affordable })) }, null, 2));
