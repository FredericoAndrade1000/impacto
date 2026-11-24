// Independent physical bound: 200 joules per damage-power unit.
const SECONDARY_ENERGY_PER_POWER = 200;
import { WEAPON_PRESETS, isWeaponPresetId } from '../src/weapons.ts';
import { record, expectArray } from './operational-input.ts';
import type { ReviewCase } from './review-cases.ts';

const finiteNumbers = (value: unknown): boolean => typeof value === 'number' ? Number.isFinite(value) : value && typeof value === 'object' ? Object.values(value).every(finiteNumbers) : true;

// Outcomes, not mesh layout. A case's documented limits are retained even
// when source geometry changes; edge ratios of edited contours stay diagnostic.
const records = (value: unknown): Record<string, unknown>[] | undefined => {
  if (value === undefined || value === null) return undefined;
  const values = expectArray(value);
  if (!values.every(record)) throw new TypeError('Review outcome contains a non-object row.');
  return values;
};
export function reviewFailures(entry: Pick<ReviewCase, 'checks'>, r: Record<string, unknown>): unknown[] {
  const failures: unknown[] = [], require = (condition: unknown, reason: unknown) => { if (!condition) failures.push(reason); };
  const peaks = record(r.peaks) ? r.peaks : undefined, start = record(r.start) ? r.start : undefined;
  require(!r.error && !r.thrown, r.error || 'simulation threw');
  require(r.finite !== false && finiteNumbers(r), 'non-finite state or metrics');
  require(r.partsPreserved !== false, 'construction identities or connections changed');
  require(!r.recoveries, 'solver recovery');
  require(!(Number(peaks?.dentLimitRatio) > 1 + 1e-6), 'indentation exceeds material limit');
  if (r.failures) failures.push(...expectArray(r.failures));
  if (r.invalid) failures.push(String(r.invalid));
  switch (entry.checks) {
    case 'secondary': {
      const hits = records(r.hits), rays = records(r.rays), raysAtImpact = records(r.raysAtImpact), hitsAtImpact = records(r.hitsAtImpact);
      require(r.activePackets === 0 && r.peakPackets === 0, 'secondary lifetime');
      require(r.partsPreserved === true, 'secondary damage changed construction parts');
      require(r.massPreserved === true, 'secondary damage changed admitted mass');
      require(Number(r.health) >= 0 && Number(r.health) <= Number(r.initialHealth), 'invalid component health');
      require(hits?.every(h => h.secondary && h.instantaneous && h.impulse === 0 &&
        Number.isFinite(Number(h.damage) + Number(h.energy) + Number(h.power))), 'primary or persistent damage contaminated instantaneous rays');
      require(hits?.every(h => Number(h.damage) >= 0 && Number(h.power) <= Number(h.energy) / SECONDARY_ENERGY_PER_POWER + 1e-8),
        'damage exceeds secondary kinetic energy');
      // Each subsequent fuel/ammunition explosion has its own finite source.
      // The initial impact's budget must not include those later bursts.
      require(Array.isArray(r.raysAtImpact) && r.raysAtImpact.length > 0 &&
        r.raysAtImpact.length <= (r.casing || r.blast ? 6 : 3), 'ray budget exceeded');
      require(rays?.every(ray => Number.isFinite(Number(ray.energyBudget) + Number(ray.energySpent)) &&
        Number(ray.energyBudget) > 0 && Number(ray.energySpent) >= 0 && Number(ray.energySpent) <= Number(ray.energyBudget) + 1e-8),
        'invalid secondary ray energy');
      const budget = raysAtImpact?.reduce((sum, ray) => sum + Number(ray.energyBudget), 0),
        spent = raysAtImpact?.reduce((sum, ray) => sum + Number(ray.energySpent), 0),
        limit = r.casing || r.blast ? Number(r.blastPower) * SECONDARY_ENERGY_PER_POWER * .1 * .5 : Number(r.consumedPrimaryEnergy) * .08;
      require(Number.isFinite(Number(budget) + limit) && Number(budget) <= limit + 1e-4 &&
        Math.abs(Number(budget) - Number(r.energyBudgetAtImpact)) <= 1e-8 &&
        Math.abs(Number(spent) - Number(r.energySpentAtImpact)) <= 1e-8 && Number(spent) <= Number(budget) + 1e-8,
        'secondary ray energy exceeds source budget');
      require(r.emittedAtImpact === raysAtImpact?.length && r.secondaryShots === rays?.length,
        'secondary ray accounting mismatch');
      require(Math.abs((rays?.reduce((sum, ray) => sum + Number(ray.energyBudget), 0) ?? NaN) - Number(r.energyBudget)) <= 1e-8 &&
        Math.abs((rays?.reduce((sum, ray) => sum + Number(ray.energySpent), 0) ?? NaN) - Number(r.energySpent)) <= 1e-8,
        'secondary total energy accounting mismatch');
      require(Number(r.secondaryDamage) >= 0 && Number(r.secondaryDamage) <= Number(r.initialHealth) &&
        Number(r.secondaryDamageAtImpact) >= 0 && Number(r.secondaryDamageAtImpact) <= Number(r.secondaryDamage) &&
        r.secondaryDamageAtImpact === hitsAtImpact?.reduce((sum, hit) => sum + Number(hit.damage), 0) &&
        r.secondaryDamage === hits?.reduce((sum, hit) => sum + Number(hit.damage), 0), 'excess or unaccounted secondary health damage');
      require(!r.shield || r.blast || r.secondaryDamageAtImpact === 0 && (r.casing || r.healthAfterImpact === r.initialHealth),
        'shield did not intercept chips');
      break;
    }
    case 'armor': require(Number(r.impacts) >= 1 && r.shots === r.count, 'missing armor trial shot/impact'); break;
    case 'vehicle-blast': require(r.unchanged && r.restored, 'construction/reset changed'); break;
    case 'drive': require(r.originalUnchanged && r.restored && Number.isFinite(peaks?.kineticJ), 'drive/reset state'); break;
    case 'wheel': {
      if (!isWeaponPresetId(r.preset)) throw new TypeError('Wheel outcome needs its weapon preset.');
      const p = WEAPON_PRESETS[r.preset];
      require(Number(peaks?.clearance) <= 2 && Number(peaks?.passiveGrowth) <= 500, 'wheel passive energy/launch');
      require(Number(peaks?.energy) <= Number(start?.energy) + Number(r.shots) * .5 * p.mass * p.speed ** 2, 'wheel energy exceeds input');
      break;
    }
    case 'launch': require(Number(peaks?.verticalSpeed) <= 8 && Number(peaks?.clearance) <= 2, 'carrier launched'); break;
    case 'durability':
      require(Number.isInteger(r.authoredPlateCount) && Number(r.authoredPlateCount) > 0 &&
        Array.isArray(r.authoredPlateIds) && r.authoredPlateIds.length === r.authoredPlateCount &&
        new Set(r.authoredPlateIds).size === r.authoredPlateCount &&
        r.attachedPlates === r.authoredPlateCount && r.partsPreserved && r.roofAttached &&
        Number(r.roofIntegrity) >= .75 && Number(r.impacts) >= 1 && Number(r.peakY) <= 1.5, 'roof material/mount/motion');
      break;
    case 'long-range':
      require(r.accepted && r.shellBlasts === 1 && r.secondaryBlasts === r.uniqueSecondary && Number(r.peakY) <= 4, 'range detonation/height');
      break;
  }
  return [...new Set(failures)];
}
