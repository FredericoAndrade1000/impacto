import { boxBlueprint } from './perception-scene.js';

// Deliberate closed authors for contact/ownership tests. They are not a parser
// or a migration of arbitrary loose geometry. A low heavy slab on the light wheeled chassis, which brings its
// two axles.
export function gearChassis() {
  const source = boxBlueprint({ preset: 'vehicle', length: 2.4, height: .4, thicknessMm: 5 });
  source.plates.find(plate => plate.id === 'hull:floor').thicknessMm = 60;
  source.plates.find(plate => plate.id === 'hull:roof').thicknessMm = 40;
  return source;
}

export function engineBox(sizeScale = 1) {
  return boxBlueprint({ length: 3, height: 2.1, thicknessMm: 5, components: [{
    id: 'engine', kind: 'engine', sizeScale,
    pose: { x: -.25, y: .1, angle: 0 },
  }] });
}
