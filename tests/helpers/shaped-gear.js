import { createConstruction } from '../../src/construction-templates.ts';
import { validateStructuredConstruction } from '../../src/structured-construction.ts';
import { chassisFront, chassisRear, chassisTrack, suspensionHeight, trackLength, withAxleCount, withTrackEnd, writtenTrack } from '../../src/chassis.ts';
import { withChassisSuspension } from '../../src/chassis-editing.ts';

// Templates on running gear the player placed otherwise than their model does, each as unevenly as the compiler
// admits: the weight of each still falls between its first axle and its last, or within its track. Each is
// [name, template, how its chassis is shaped]. Axles use 5 cm authoring units; track coordinates may be fractional.
export const SHAPED_GEAR = Object.freeze([
  // The scout's two axles bunched under its middle, as near as their wheels let them.
  ['scout on bunched axles', 'scout', chassis => ({ ...chassis, axles: [-10, 11] })],
  // Three axles behind the scout's front half, with its long front span reinforced.
  ['scout on three axles to the rear', 'scout', chassis => ({ ...chassis, thicknessMm: 10, axles: [-6, 15, 36] })],
  // Three uneven axles biased forward. The last stands 0.5 m behind the middle so the reinforced
  // 35 mm rails carry the full hopper over their 3.2 m rear overhang.
  ['truck on three uneven axles', 'truck', chassis => ({ ...chassis, thicknessMm: 35, axles: [-52, -21, 32] })],
  // Five axles on the truck, as many as its model takes.
  ['truck on five axles', 'truck', chassis => withAxleCount(chassis, 5)],
  // Preserve the physical four-pitch specimen under the heavy's middle, the short span that carries this load.
  ['heavy on the shortest track', 'heavy', chassis => {
    const middle = (chassisFront(chassis) + chassisRear(chassis)) / 2, half = trackLength(chassis.model, 4, chassis) / 2;
    return { ...chassis, track: writtenTrack(chassis, middle - half, middle + half) };
  }],
  // A 5.2 m track to the rear, with its weight near the first support.
  ['heavy on a short track to the rear', 'heavy', chassis => withTrackEnd(chassis, 'front', chassisTrack(chassis).rear - 5.2)],
]);
// A template on its shaped gear, all of it hung as high over that gear as the template is over its own.
export function shapedDesign(template, shape) {
  const design = createConstruction(template);
  return validateStructuredConstruction(withChassisSuspension({ ...design, chassis: shape(design.chassis) }, suspensionHeight(design.chassis)));
}
