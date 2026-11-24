import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { World } from '../src/physics.ts';
import type { PlateMesh, MeshNode } from '../src/mesh.ts';
import type { Point, Pose, Basis, LocalPoint } from '../src/math.ts';
import type { SceneModule, SceneEvent } from '../src/scene-contract.ts';
import type { Vehicle } from '../src/vehicle.ts';
import { decodePhysicsState, physicsCarriers } from './review-physics.ts';
import type { PhysicsStateProbe, ProbeBody, ProbeContact, ProbeEnergyAudit } from './review-physics.ts';
export type { PhysicsStateProbe } from './review-physics.ts';

interface PlateMaterialState {
  revision: number; markRevision: number; finite: boolean; localDentMeters: number;
  dentLimitRatio: number; maxLocalDent: number; maxShapeError?: number;
}
export interface PlateShape {
  present: boolean; maxDisplacement: number; maxLocalDent: number;
  relativeAngle?: number; maxShapeResidual?: number; centerDisplacement?: number;
}
export interface ProbeOptions {
  peaks?: Record<string, number>; limits?: Record<string, number>; geometry?: boolean;
}
export interface ReviewSubject { world: World; step(): unknown; status?: string }
export interface AdvanceOptions {
  before?: ((step: number, world: World) => unknown) | undefined;
  after?: ((step: number, world: World, events: SceneEvent[]) => unknown) | undefined;
  until?: ((step: number, world: World) => unknown) | undefined;
  samples?: number[]; events?: SceneEvent[]; snapshots?: number[]; snapshotEvery?: number;
}


export const isMain = (url: string) => Boolean(process.argv[1] && url === pathToFileURL(resolve(process.argv[1])).href);
export const round = (value: number, places = 3) => +value.toFixed(places);
export const mean = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
export function fingerprint(value: unknown, { opaqueIdentities = false } = {}) {
  let source = JSON.stringify(value);
  if (source === undefined) throw new TypeError('Review fingerprint needs a JSON value.');
  // Host-created UUIDs label parts/owners; a benchmark compares their physical
  // state and relationships, not the random spelling of those identities.
  // Preserve aliasing, order, every number and all non-identity text.
  if (opaqueIdentities) {
    const names = new Map<string, string>();
    source = source.replace(/[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}/gi,
      id => { const name = names.get(id) ?? 'identity-' + names.size; names.set(id, name); return name; });
  }
  return createHash('sha256').update(source).digest('hex');
}
export function timing(samples: readonly number[]) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { meanMs: round(mean(samples)), p95Ms: round(sorted[Math.floor(sorted.length * .95)] || 0), peakMs: round(sorted.at(-1) || 0) };
}
export const eventCounts = (events: readonly { type: string }[]) => {
  const counts: Record<string, number> = {};
  for (const event of events) counts[event.type] = (counts[event.type] || 0) + 1;
  return counts;
};

export function finiteWorld(world: World) {
  return world.actors.every(a => !a.vehicle || Number.isFinite(a.vehicle.x + a.vehicle.y + a.vehicle.angle +
    a.vehicle.vx + a.vehicle.vy + a.vehicle.omega + a.vehicle.mass) && a.vehicle.mass > 0) &&
    world.plates.every(p => Number.isFinite(p.remainingArea + p.frame.x + p.frame.y + p.frame.c + p.frame.s) &&
      p.remainingArea >= 0 && plateMaterialState(p).finite) &&
    world.modules.every(m => Number.isFinite(m.health + m.x + m.y));
}

export function requireVehicle(world: World): Vehicle {
  if (!world.vehicle) throw new TypeError('The review requires an authored vehicle.');
  return world.vehicle;
}
export const errorDetail = (error: unknown): string => String(error !== null && (typeof error === 'object' || typeof error === 'function') && 'stack' in error ? error.stack || error : error);

interface PartIdentity { id: string; actorId?: string | undefined; attached?: boolean }
export interface IdentityWorld {
  plates: readonly PartIdentity[]; modules: readonly PartIdentity[];
  game(): {call(request: {op: 'physics'}): unknown};
}
// Installed identities and the single rigid carrier survive functional damage.
export function permanentParts(world: IdentityWorld) {
  const identity = (p: PartIdentity) => ({ id: p.id, actorId: p.actorId, attached: p.attached !== false }),
    bodies = physicsCarriers(world.game().call({op: 'physics'})).filter(b => b.actor).map(b => ({ actor: b.actor, body: b.handle }));
  return { plates: world.plates.map(identity), modules: world.modules.map(identity), bodies };
}

export function partsPreserved(world: IdentityWorld, initial: ReturnType<typeof permanentParts>) {
  return JSON.stringify(permanentParts(world)) === JSON.stringify(initial);
}

export function resetRestored(world: World, initial = permanentParts(world)) {
  world.reset();
  // Compare installed parts. Bodies are created by construction;
  // functional damage never transfers a welded component into a new body.
  const current = permanentParts(world), { bodies: ignoredBefore, ...before } = initial,
    { bodies: ignoredAfter, ...after } = current;
  return JSON.stringify(before) === JSON.stringify(after) && world.projectiles.length === 0 &&
    world.stats.explosions === 0 && world.modules.every(m => m.health === m.maxHealth && !m.detonated) &&
    world.plates.every(p => p.integrity === 1);
}

const materialMeasurements = new WeakMap<PlateMesh, PlateMaterialState>();
export function plateMaterialState(plate: PlateMesh): PlateMaterialState {
  const previous = materialMeasurements.get(plate);
  if(previous?.revision===plate.revision&&previous.markRevision===plate.markRevision)return previous;
  const result: PlateMaterialState={revision:plate.revision,markRevision:plate.markRevision,finite:true,localDentMeters:0,dentLimitRatio:0,
    maxLocalDent:0},limit=plate.definition.thicknessMm/1000*.26;
  for(const node of plate.nodes) {
    const rest=materialRestPoint(plate,node),p=node.local;
    result.finite&&=Number.isFinite(p.x+p.y+node.u+node.v);
    // Rigid material must not stretch; dents are a separate bounded surface state.
    result.maxShapeError=Math.max(result.maxShapeError||0,Math.hypot(p.x-rest.x,p.y-rest.y));
  }
  for(const dent of plate.dents?.values()||[]) {
    result.finite&&=Number.isFinite(dent.u+dent.v+dent.depth+dent.radius);
    result.localDentMeters=Math.max(result.localDentMeters,dent.depth);
  }
  result.maxLocalDent=result.localDentMeters;
  result.dentLimitRatio=result.localDentMeters/Math.max(1e-9,limit);
  result.finite&&=plate.solidRegions.every(r=>Number.isFinite(r.minX+r.minY+r.maxX+r.maxY)&&r.minX<r.maxX&&r.minY<r.maxY);
  materialMeasurements.set(plate, result);
  return result;
}

export function indentationState(world: World) {
  let localDentMeters = 0, dentLimitRatio = 0;
  for (const plate of world.plates) {
    const material = plateMaterialState(plate);
    localDentMeters = Math.max(localDentMeters, material.localDentMeters);
    dentLimitRatio = Math.max(dentLimitRatio, material.dentLimitRatio);
  }
  return { localDentMeters, dentLimitRatio };
}

export function toCarrier(point: Point, vehicle: Pose) {
  const x = point.x - vehicle.x, y = point.y - vehicle.y,
    c = Math.cos(vehicle.angle), s = Math.sin(vehicle.angle);
  return { x: c * x + s * y, y: -s * x + c * y };
}

const plateReferences = new WeakMap<PlateMesh, Point & Basis>();
export function materialRestPoint(plate: PlateMesh, node: LocalPoint) {
  const f=plate.materialFrame;
  return {x:f.x+f.u.x*node.u+f.v.x*node.v,y:f.y+f.u.y*node.u+f.v.y*node.v};
}
// Where a material UV of an installed component lies in the world.
export function componentMaterialPoint(module: Pick<SceneModule, 'x' | 'y' | 'width' | 'height'> & {angle?: number | undefined}, uv: LocalPoint) {
  const x = (uv.u - .5) * module.width, y = (.5 - uv.v) * module.height,
    c = Math.cos(module.angle || 0), s = Math.sin(module.angle || 0);
  return { x: module.x + x * c - y * s, y: module.y + x * s + y * c };
}
export function plateShape(plate: PlateMesh, vehicle: Pose = { x: 12, y: 1.3, angle: 0 }): PlateShape {
  const nodes = plate.remainingArea > 1e-12 ? plate.nodes : [];
  if (!nodes.length) return { present: false, maxDisplacement: 0, maxLocalDent: 0 };
  // Diagnostic reference is one mounted pose, never a second integrated mesh.
  // Material UVs reconstruct the unyielded sheet after clipping/damage.
  let reference = plateReferences.get(plate);
  if (!reference) {
    const angle = Math.atan2(plate.frame.s, plate.frame.c) - vehicle.angle;
    reference = { ...toCarrier(plate.frame, vehicle), c: Math.cos(angle), s: Math.sin(angle) };
    plateReferences.set(plate, reference);
  }
  const mounted = reference;
  const restPoint = (node: MeshNode) => {
    const p = materialRestPoint(plate, node);
    return { x: mounted.x + mounted.c * p.x - mounted.s * p.y,
      y: mounted.y + mounted.s * p.x + mounted.c * p.y };
  }, points = nodes.map(node => ({ now: toCarrier(node, vehicle), rest: restPoint(node) })),
    mean = (key: 'now' | 'rest') => points.reduce((p, n) => ({ x: p.x + n[key].x / points.length,
      y: p.y + n[key].y / points.length }), { x: 0, y: 0 }), now = mean('now'), rest = mean('rest');
  let dot = 0, cross = 0, maxDisplacement = 0;
  const { maxLocalDent } = plateMaterialState(plate);
  for (const p of points) {
    const ax = p.rest.x - rest.x, ay = p.rest.y - rest.y, bx = p.now.x - now.x, by = p.now.y - now.y;
    dot += ax * bx + ay * by; cross += ax * by - ay * bx;
    maxDisplacement = Math.max(maxDisplacement, Math.hypot(p.now.x - p.rest.x, p.now.y - p.rest.y));
  }
  const relativeAngle = Math.atan2(cross, dot), c = Math.cos(relativeAngle), sn = Math.sin(relativeAngle);
  let maxShapeResidual = 0;
  for (const p of points) {
    const x = p.rest.x - rest.x, y = p.rest.y - rest.y;
    maxShapeResidual = Math.max(maxShapeResidual,
      Math.hypot(p.now.x - now.x - (c * x - sn * y), p.now.y - now.y - (sn * x + c * y)));
  }
  return { present: true, maxDisplacement, maxLocalDent, relativeAngle, maxShapeResidual,
    centerDisplacement: Math.hypot(now.x - rest.x, now.y - rest.y) };
}

// Read-only diagnostics use the same compiled scene as gameplay.
export function physicsState(world: World, options: { contacts: true; resetEnergy?: boolean }): PhysicsStateProbe & { contactStates: ProbeContact[] };
export function physicsState(world: World, options?: { contacts?: boolean; resetEnergy?: boolean }): PhysicsStateProbe;
export function physicsState(world: World, options: { contacts?: boolean; resetEnergy?: boolean } = {}): PhysicsStateProbe {
  const state = decodePhysicsState(world.game().call({ op: 'physics', ...options }));
  if (options.contacts && state.contactStates === undefined) throw new TypeError('Native contact diagnostic is absent.');
  return state;
}
export const partPhysics = (world: World, part: PlateMesh | SceneModule | string, physics = physicsState(world)) =>
  physics.owners.find(record => record.owner === world.game().handle(part));
export const actorPhysics = (world: World, id = 'local', physics = physicsState(world)) =>
  physics.bodyStates.find(body => body.actor === world.game().actorHandles.get(id));
// What the reserves of a construction weigh in its body: their casings and what they held when the body
// was last weighed. Fire can also consume combustible interiors of other pieces.
const RESERVES = new Set(['fuel', 'ammo', 'hopper', 'cistern']);
export const reservesMass = (world: World, actorId?: string) => world.modules.reduce((sum, m) =>
  sum + (RESERVES.has(m.kind) && (actorId === undefined || m.actorId === actorId) ? m.physicalMass : 0), 0);
// Actual installed component masses, including unburnt interiors and remaining reserves.
// Subtract these from a carrier to audit its permanent hull/chassis without reimplementing combustion.
export const installedModuleMass = (world: World, actorId?: string) => world.modules.reduce((sum, m) =>
  sum + (m.attached !== false && (actorId === undefined || m.actorId === actorId) ? m.physicalMass : 0), 0);
export const kineticEnergyOf = (bodies: readonly Pick<ProbeBody, 'dynamic' | 'mass' | 'vx' | 'vy' | 'inertia' | 'omega'>[]) => bodies.reduce((sum, b) => sum + (b.dynamic ?
  (b.mass * (b.vx ** 2 + b.vy ** 2) + b.inertia * b.omega ** 2) / 2 : 0), 0);
export function mechanicalState(world: World, details = false, physics = physicsState(world)) {
  const bodies = physics.bodyStates.filter(b => b.dynamic);
  return { mass: bodies.reduce((sum, b) => sum + b.mass, 0), kineticJ: kineticEnergyOf(bodies),
    px: bodies.reduce((sum, b) => sum + b.mass * b.vx, 0), py: bodies.reduce((sum, b) => sum + b.mass * b.vy, 0),
    angular: bodies.reduce((sum, b) => sum + b.inertia * b.omega + b.mass * (b.center.x * b.vy - b.center.y * b.vx), 0),
    ...(details ? { energies: bodies.map(b => ({ kind: 'rigid', handle: b.handle, mass: b.mass,
      kineticJ: kineticEnergyOf([b]), velocity: { x: b.vx, y: b.vy }, omega: b.omega })) } : {}) };
}

// One physical outcome vocabulary backs gun, blast, terrain and artillery reviews.
export class DamageProbe {
  declare world: World; declare peaks: Record<string, number>; declare limits: Record<string, number>; declare geometry: boolean;
  declare start: Pose & { vx?: number; vy?: number; omega?: number }; declare clearance: number;
  declare events: SceneEvent[]; declare durations: number[]; declare finite: boolean; declare invalid: string | null;
  declare parts: ReturnType<typeof permanentParts>; declare partsPreserved: boolean;
  constructor(world: World, { peaks = {}, limits = {}, geometry = true }: ProbeOptions = {}) {
    this.world = world; this.peaks = peaks; this.limits = limits; this.geometry = geometry;
    this.start = world.vehicle?.pose() || { x: 12, y: 1.3, angle: 0 };
    this.clearance = this.start.y - world.terrain.height(this.start.x);
    this.events = []; this.durations = []; this.finite = true; this.invalid = null;
    this.parts = permanentParts(world); this.partsPreserved = true;
    // Establish the mounted reference before the first intervention.
    if (geometry) world.plates.forEach(p => plateShape(p, world.vehicle || this.start));
  }
  sample() {
    const world = this.world, v = world.vehicle || this.start, speed = Math.hypot(v.vx || 0, v.vy || 0),
      shapes = this.geometry ? world.plates.map(p => plateShape(p, v)) : [],
      kineticJ = mechanicalState(world).kineticJ,
      maximum = (key: 'maxDisplacement' | 'maxShapeResidual' | 'maxLocalDent') => Math.max(0, ...shapes.map(p => p[key] || 0)),
      lift = v.y - this.start.y;
    const indentation = indentationState(world);
    const values = { speed, y: v.y, height: lift, lift, clearance: v.y - world.terrain.height(v.x) - this.clearance,
      absVy: Math.abs(v.vy || 0), verticalSpeed: Math.abs(v.vy || 0), angle: Math.abs(v.angle || 0),
      omega: Math.abs(v.omega || 0), kineticJ, energy: kineticJ, 
      nativeFragments: 0, nativeColliders: physicsState(world).colliders,
      carrierDisplacement: Math.abs(v.x - this.start.x), displacement: maximum('maxDisplacement'),
      plateDisplacement: maximum('maxDisplacement'), shapeResidual: maximum('maxShapeResidual'),
      plateAngle: Math.max(0, ...shapes.map(p => Math.abs(p.relativeAngle || 0))), localDent: maximum('maxLocalDent'),
      ...indentation };
    const metrics: Record<string, number> = values;
    for (const key of Object.keys(this.peaks)) this.peaks[key] = Math.max(Number(this.peaks[key]), metrics[key] ?? 0);
    this.peaks.localDent = Math.max(this.peaks.localDent || 0, values.localDent);
    for (const key of ['localDentMeters', 'dentLimitRatio'] as const) this.peaks[key] = Math.max(this.peaks[key] || 0, values[key]);
    this.finite &&= finiteWorld(world) && Number.isFinite(kineticJ);
    this.partsPreserved &&= partsPreserved(world, this.parts);
    this.invalid ||= !this.finite ? 'non-finite physical state' : !this.partsPreserved ? 'construction identity changed by damage' : indentation.dentLimitRatio > 1 + 1e-6 ?
      'local indentation exceeds physical limit' : Object.entries(this.limits).find(([key, limit]) => Number(metrics[key]) > limit)?.[0] || null;
    return { ...values, shapes };
  }
  run(steps: number, { before, after, events = this.events, durations = this.durations }: { before?: AdvanceOptions['before']; after?: ((step: number, values: ReturnType<DamageProbe['sample']>, events: SceneEvent[]) => unknown) | undefined; events?: SceneEvent[]; durations?: number[] } = {}) {
    advance(this.world, steps, { before, events, samples: durations, after: (step, world, frameEvents) => {
      const values = this.sample();
      return after?.(step, values, frameEvents) !== false && !this.invalid;
    } });
    return this;
  }
  timing() { return timing(this.durations); }
}

export class Intercepts {
  declare restore: (() => void)[];
  constructor() { this.restore = []; }
  replace(object: object | null | undefined, method: string, handler: (this: unknown, original: Function, args: unknown[]) => unknown) {
    const original: unknown = object == null ? undefined : Reflect.get(object, method);
    if (typeof original !== 'function') return this;
    if (!object) return this;
    if (!Reflect.set(object, method, function(this: unknown, ...args: unknown[]) { return handler.call(this, original, args); }))
      throw new TypeError('Cannot intercept ' + method);
    this.restore.push(() => { if (!Reflect.set(object, method, original)) throw new TypeError('Cannot restore ' + method); });
    return this;
  }
  close() { for (const restore of this.restore.reverse()) restore(); this.restore = []; }
}

export class Profiler extends Intercepts {
  declare costs: Map<string, {calls: number; ms: number}>;
  constructor() { super(); this.costs = new Map(); }
  watch(object: object | null | undefined, methods: readonly string[], prefix = '') {
    for (const method of methods) {
      const label = prefix + method, costs = this.costs;
      this.replace(object, method, function(original, args) {
        const start = performance.now();
        try { return Reflect.apply(original, this, args); }
        finally {
          const entry = costs.get(label) || { calls: 0, ms: 0 };
          entry.calls++; entry.ms += performance.now() - start; costs.set(label, entry);
        }
      });
    }
    return this;
  }
  totals(divisor = 1) { return Object.fromEntries([...this.costs].map(([name, value]) => [name, round(value.ms / Math.max(1, divisor))])); }
}

// Observe compiled solve boundaries without changing bodies, contact filters or
// solver settings. Energy growth refers to actual subsolves, not frame impulses.
export interface NativeStepSample {
  before: Omit<PhysicsStateProbe, 'energy'> & { frameEnergy: number; energy: number; bodyBoundary: 'frame' };
  afterEnergy: number; nativeEnergy: ProbeEnergyAudit; substep: number; audit: NativeAudit;
}
export interface NativeRecovery {
  state: PhysicsStateProbe; reason: string; afterEnergy: number; restored: PhysicsStateProbe; audit: NativeAudit;
}
export interface NativeAuditOptions {
  onStep?: (sample: NativeStepSample) => unknown;
  onRecover?: (sample: NativeRecovery) => unknown;
  beforeStep?: (audit: NativeAudit) => unknown;
}
export class NativeAudit extends Intercepts {
  declare world: World; declare motion: PhysicsStateProbe | null; declare substeps: number;
  constructor(world: World, { onStep, onRecover, beforeStep }: NativeAuditOptions = {}) {
    super(); this.world = world; this.motion = null; this.substeps = 0;
    const audit = this;
    this.replace(world, 'step', function(original, args) {
      beforeStep?.(audit);
      const before = physicsState(world, { resetEnergy: true }), frameEnergy = kineticEnergyOf(before.bodyStates),
        result = Reflect.apply(original, this, args), after = physicsState(world), energy = after.energy;
      audit.motion = before;
      audit.substeps += energy.solves;
      if (energy.solves) onStep?.({ before: { ...before, frameEnergy, energy: energy.maxGrowth.before, bodyBoundary: 'frame' },
        afterEnergy: energy.maxGrowth.after, nativeEnergy: energy, substep: audit.substeps, audit });
      if (after.recoveries > before.recoveries) onRecover?.({ state: before, reason: 'native solver recovery',
        afterEnergy: kineticEnergyOf(after.bodyStates), restored: after, audit });
      return result;
    });
  }
  bodies(before: Pick<PhysicsStateProbe, 'bodyStates'> | null = this.motion) {
    const after = new Map(physicsState(this.world).bodyStates.map(b => [b.handle, b]));
    return (before?.bodyStates || []).filter(b => b.dynamic).map(b => {
      const next = after.get(b.handle) || b;
      return { handle: b.handle, mass: b.mass, inertia: b.inertia,
        beforeEnergy: kineticEnergyOf([b]), afterEnergy: kineticEnergyOf([next]),
        velocityBefore: { x: b.vx, y: b.vy }, velocityAfter: { x: next.vx, y: next.vy },
        omegaBefore: b.omega, omegaAfter: next.omega, translation: { x: next.x, y: next.y }, rotation: next.angle };
    });
  }
}

// Reviews supply interventions and outcomes; this owns only fixed stepping,
// event draining and optional timing. It never changes a pilot's decisions.
export function advance(subject: World | ReviewSubject, steps: number, { before, after, until, samples, events, snapshots, snapshotEvery = 3 }: AdvanceOptions = {}) {
  const world = 'world' in subject ? subject.world : subject;
  for (let step = 0; step < steps; step++) {
    const start = performance.now(); before?.(step, world); subject.step();
    samples?.push(performance.now() - start);
    const frameEvents = world.drainEvents(); events?.push(...frameEvents);
    if (snapshots && step % snapshotEvery === 0) { const at = performance.now(); world.snapshot(); snapshots.push(performance.now() - at); }
    if (after?.(step, world, frameEvents) === false || until?.(step, world) || 'status' in subject && subject.status && subject.status !== 'active') break;
  }
}
