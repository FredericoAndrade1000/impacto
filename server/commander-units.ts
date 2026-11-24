import type { CommanderOrder, CommanderUnit } from './commander-contract.ts';
import { isSquadHaulBlock } from '../src/squad-contract.ts';

export const exploring = (order: CommanderOrder | undefined): boolean => order?.kind === 'explore' || order?.kind === 'reconnoitre';

export const returning = (unit: CommanderUnit): boolean => unit.home || unit.haul?.phase === 'home' ||
  unit.haul?.phase === 'unload' || unit.job?.phase === 'return';

export const activeJob = (unit: CommanderUnit): boolean => Boolean(unit.job &&
  (unit.job.kind !== null || !['idle', 'paused'].includes(unit.job.phase)));

export const isDefender = (unit: CommanderUnit): boolean => unit.vehicle && !unit.aircraft && unit.armed && !unit.artillery && !unit.builder &&
  unit.extracts.length === 0 && unit.carries.length === 0;

export const FUEL_RESERVE_SHARE = .25;

// Physical reserve floor for local guard duty. Each duty also checks its
// location, current service and order authority before assigning movement.
export const canGuard = (unit: CommanderUnit): boolean => isDefender(unit) && unit.health >= .55 && unit.ammoRatio >= .1 &&
  unit.fuelCapacity > 0 && unit.fuel >= unit.fuelCapacity * FUEL_RESERVE_SHARE;

export const mobilityBlocked = (unit: CommanderUnit): boolean => isSquadHaulBlock(unit.halt);

// A gun stranded outside the yard cannot replace a guard there. Keep counting
// already-paid vehicles at home; readiness gates guard duty and departures.
export const stranded = (unit: CommanderUnit): boolean => !unit.atBase && mobilityBlocked(unit);
