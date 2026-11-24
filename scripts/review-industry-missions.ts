// Bounded live-physics trips for current ready models, not a PvP or mobile
// benchmark. All work stays in isolated rooms, without opening a live save.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { rehearsal } from '../server/room.ts';
import { onField } from '../tests/helpers/field.js';
import { createConstruction } from '../src/construction-templates.ts';
import { compileManufacture } from '../src/structured-construction.ts';
import { bill, designBill, carriedBy, supplied, suppliesFill } from '../src/economy.ts';
import { fuelRefused } from '../src/squad.ts';
import { cargoMass } from '../src/component-volume.ts';
import { nativeRuntimeInfo } from './native-dynamics-host.ts';
import { isWireMessage } from '../src/message-contract.ts';
import type { WireMessage } from '../src/message-contract.ts';

const STEADY = { pace: () => 1 }, HOLD_SECONDS = 15, LIMIT_SECONDS = 240;
const designs = {
  scout: () => createConstruction('scout'),
  'air-scout': () => createConstruction('air-scout'),
  'air-supply': () => createConstruction('air-supply'),
};
type MissionDesign = keyof typeof designs;
const isMissionDesign = (id: string): id is MissionDesign => Object.hasOwn(designs, id);
const recordValue = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
function mission({ design, distance, direction }: { design: MissionDesign; distance: number; direction: number }) {
  const cleanups: (() => unknown)[] = [], room = rehearsal([0], bill(1e9, 1e9, 1e9, 1e9), { fog: false });
  const f = onField({ after: (fn: () => unknown) => cleanups.push(fn) }, room);
  try {
    const player = room.join('Missão'), source = designs[design](), compiled = compileManufacture(source).compiled;
    const id: unknown = f.publish(player, source), state = room.players.get(player.playerId);
    assert(typeof id === 'string' && state?.squad); const squad = state.squad;
    room.supplyDispatch.set(id, false);
    if (room.crates(id).length) {
      f.order(player, 'control', { id: null });
      for (let i = 0; i < 5 * 60 && suppliesFill(room.crates(id)) < .998; i++) room.step(STEADY);
      assert(suppliesFill(room.crates(id)) >= .998, 'The carrier must take on a full normal mixture through base service');
      for (let i = 0; i < 60; i++) room.step(STEADY); // Let Native publish the new moving mass before measuring.
    }
    // Disable every source of base service after admitting the product. This
    // isolates a tank's real range; publication affordability is audited apart.
    Object.assign(room.faction(state).stock, bill());
    const vehicle = () => room.world.actor(id)?.vehicle;
    const fuel = (): number => room.world.modules.filter(p => p.actorId === id && p.kind === 'fuel').reduce((sum, p) => sum + (p.kind === 'fuel' ? p.fuelLitres : 0), 0);
    const initialVehicle = vehicle(); assert(initialVehicle);
    const origin = initialVehicle.x, goal = origin + direction * distance, start = room.field.time, initialFuel = fuel(), homeDepot = squad.side.depot?.(id),
      initialMassKg = initialVehicle.mass, initialSupplies = supplied(carriedBy(room.crates(id)).carried);
    assert(homeDepot, 'The mission needs the real base service area for its return');
    const carriedKg = room.crates(id).reduce((sum, piece) => sum + cargoMass(piece), 0);
    assert(initialMassKg >= compiled.manufacturing.emptyKg + carriedKg - 1, 'Native must include the actual carried payload before departure');
    assert(initialFuel > 0, 'Read actual fuel modules, not cargo reservoirs');
    assert(compiled.chassis, 'A mobile mission must publish its Native chassis');
    const air = compiled.chassis.model === 'aircraft', goalHeight = room.field.terrain.height(goal) + (air ? 30 : 0);
    let refusal: WireMessage | null = null;
    try { f.order(player, 'move', { ids: [id], x: goal, y: goalHeight }); }
    catch (error) {
      if (!recordValue(error) || !isWireMessage(error.userMessage) || error.userMessage.key !== fuelRefused(['short'], 1).key) throw error;
      refusal = error.userMessage;
    }
    let phase: 'out' | 'hold' | 'back' = 'out', reachedAt: number | null = null, returnedAt: number | null = null, divertedAt: number | null = null, returnLandingX = origin,
      fuelEmptyAt: number | null = null, farthest = 0, status = 'time-limit';
    if (refusal) status = 'order-refused';
    const samples: { seconds: number; phase: string; x: number; height: number; fuelLitres: number; landing: string | null; moveX: number | null; grounded: boolean; flying: boolean }[] = [];
    for (let i = 0; !refusal && i < LIMIT_SECONDS * 60; i++) {
      room.step(STEADY);
      const v = vehicle(), now = room.field.time - start, unit = squad.units.get(id);
      if (!v || room.outOfAction()[id]) { status = 'out-of-action'; break; }
      assert([v.x, v.y, v.vx, v.vy, fuel()].every(Number.isFinite), 'Finite Native trip state');
      assert(fuel() >= 0, 'No fuel debt');
      farthest = Math.max(farthest, direction * (v.x - origin));
      if (fuel() < .001) fuelEmptyAt ??= now;
      if (unit?.move?.land === 'fuel') divertedAt ??= now;
      if (i % 60 === 0) samples.push({ seconds: now, phase, x: v.x - origin,
        height: v.y - room.field.terrain.height(v.x), fuelLitres: fuel(), landing: unit?.move?.land ?? null,
        moveX: unit?.move?.x ?? null, grounded: v.grounded === true, flying: v.flying === true });
      if (phase === 'out' && Math.abs(v.x - goal) < 3 && Math.hypot(v.vx, v.vy) < 1 &&
          (!air || Math.abs(v.y - goalHeight) < 3)) { reachedAt = now; phase = 'hold'; }
      if (phase === 'hold' && reachedAt !== null && now - reachedAt >= HOLD_SECONDS) {
        phase = 'back'; f.order(player, 'home', { ids: [id] });
        // Return to base accepts a safe touchdown anywhere in its service area.
        // Retain the assigned site's displacement instead of hiding landing drift.
        returnLandingX = squad.units.get(id)?.move?.x ?? origin;
      }
      const home = Math.abs(v.x - homeDepot.x) < homeDepot.radius && v.grounded === true && !v.flying && Math.hypot(v.vx, v.vy) < 1 && !unit?.move;
      if (phase === 'back' && home) { returnedAt = now; status = 'completed'; break; }
      if (divertedAt !== null && home) { status = 'returned-for-fuel'; break; }
    }
    const remainingSupplies = supplied(carriedBy(room.crates(id)).carried);
    return { design, distance, direction, status, refusal, cost: designBill(compiled), emptyKg: compiled.manufacturing.emptyKg,
      initialMassKg, initialSupplies, remainingSupplies, initialFuel, remainingFuel: fuel(),
      consumedFuel: initialFuel + initialSupplies.combustivel - fuel() - remainingSupplies.combustivel, reachedAt, returnedAt, divertedAt, fuelEmptyAt,
      returnLandingOffset: returnLandingX - origin, finalOffset: (vehicle()?.x ?? origin) - origin,
      homeDepot, farthest, terrain: { id: room.field.terrain.id, seed: room.field.terrain.seed }, samples };
  } finally { for (const fn of cleanups) fn(); }
}
const scenarios = Object.keys(designs).filter(isMissionDesign).flatMap(design => [500, 1500].flatMap(distance => [-1, 1].map(direction => ({ design, distance, direction }))));
const cases = scenarios.map(mission);
let repeated = false;
if (process.argv.includes('--verify-repeat')) {
  assert.deepEqual(scenarios.map(mission), cases, 'Fixed-input trips must repeat with the same state, fuel and timings');
  repeated = true;
}
const runtime = nativeRuntimeInfo('native');
assert(runtime.runtime === 'native');
const report = { scope: 'Native trips and AI, not validated PvP or a hardware/FPS measurement',
  runtime: { sourceSHA256: runtime.sourceSHA256, binarySHA256: runtime.binarySHA256, profile: runtime.profile },
  assumptions: { authoredDesigns: 'Three normal catalogue models: ground scout, reconnaissance aircraft and airborne supply carrier.',
    admission: 'Native manufacture with full installed capacity in rehearsal; no live field is edited.',
    route: 'Same generated terrain/seed, base at x0, both directions; natural start and takeoff, no teleport, velocity overwrite or repair.',
    order: 'Ground destination for scout; 30m over target terrain for aircraft. Stop within3m on both axes below1m/s; hold15s; request Return to base.',
    control: 'Real squad pilots with fixed decision pace,1/60s physics, normal fuel-home diversion,240s maximum. Return order must finish in the real base service area, below1m/s, Native grounded and no longer flying. Assigned and actual landing displacements are reported; this is not a precision-landing test.',
    resources: 'Publish with enough stock, let the supply carrier load a full mixture through normal base service, then zero every faction stock. Normal onboard supplies remain aboard and may be consumed by service. No external replenishment, income, enemy, ammunition expenditure or hostile fire. Tank fuel and carried fuel are accounted together. Mission value is not measured.',
    samples: 'One state per simulated second; raw precision describes a deterministic run, not a prediction for other maps.', repeated }, cases };
const out = process.argv.indexOf('--out');
if (out >= 0) {
  const path = process.argv[out + 1];
  if (!path) throw new Error('--out needs a path');
  writeFileSync(resolve(path), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify({ scope: report.scope, repeated,
  cases: cases.map(({ design, distance, direction, status, reachedAt, returnedAt, consumedFuel, remainingFuel }) =>
    ({ design, distance, direction, status, reachedAt, returnedAt, consumedFuel, remainingFuel })) }, null, 2));
assert(cases.every(item => item.status === 'completed'), 'Every ready model must complete these bounded round trips; inspect the report for failures');
