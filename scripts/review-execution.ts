import { record, expectRecord } from './operational-input.ts';
const groups = {
  'probes-impact.ts': ['runFireCase', 'repeatedFire', 'blastCase', 'salvoCase', 'assessVehicleBlast', 'assessArtilleryVehicle', 'armorTrial', 'reviewSecondary', 'reviewFrontMounts'],
  'probes-mobility.ts': ['reviewDrive', 'environmentDrive', 'runTrackEdge', 'probeLightWheel'],
  'probes-trajectory.ts': ['probeBlastLaunch', 'probeMortarRoof'],
  'probes-scenes.ts': ['probeReferenceBlast', 'probeJoint', 'probeConcentrated', 'probeDamagedBlast', 'probeDurability', 'probeLongRange', 'probeExposed', 'profileScenario', 'probeExplosionPerformance'],
  'probes-replay.ts': ['probeTopology'],
};
const modules = new Map<string, Promise<unknown>>(), paths = new Map(Object.entries(groups).flatMap(([file, names]) => names.map(name => [name, file])));

export async function executeReviewCase(value: unknown): Promise<unknown> {
  const entry = expectRecord(value);
  if (typeof entry.probe !== 'string' || !record(entry.params)) throw new TypeError('Invalid review case.');
  const file = paths.get(entry.probe);
  if (!file) throw new Error('Probe de diagnóstico desconhecido: ' + entry.probe);
  if (!modules.has(file)) modules.set(file, import('./' + file));
  const module = expectRecord(await modules.get(file)), fn = module[entry.probe], p = entry.params;
  if (typeof fn !== 'function') throw new TypeError('Review probe is not callable: ' + entry.probe);
  switch (entry.probe) {
    case 'reviewFrontMounts': return Reflect.apply(fn, undefined, [p.preset, p.weapon, p.burst, p.seconds]);
    case 'probeExplosionPerformance': return Reflect.apply(fn, undefined, [p.model, p.location, p.frames]);
    default: return Reflect.apply(fn, undefined, [p]);
  }
}
