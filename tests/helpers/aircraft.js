import { createStructuredTemplate } from '../../src/structured-templates.ts';
import { compileDraftConstruction, compileStructuredConstruction } from '../../src/structured-construction.ts';
import { withChassisSuspension, withConstructionKind } from '../../src/chassis-editing.ts';
import { SKID_RISE, suspensionHeight } from '../../src/chassis.ts';
import { CELL } from '../../src/grid.ts';
import { componentDimensions } from '../../src/component-size.ts';

// The designs the tests of the pilots fly and shoot at, as tests/flight.test.js builds them (`built`, `gunship`): the
// chassis of the stock truck without its cab, as an aircraft, its tank at the front, its command post on the bed behind it
// and its engine, smaller, at the back, and four thrusters of the reference size standing on the bed between them — two
// upright either side of its centre of mass and one leant 45° out beyond each, which push it along the field.
export function aircraft({ tankScale = 1 } = {}) {
  const stock = createStructuredTemplate('chassis');
  Object.assign(stock, { plates: [], nodes: [] });
  stock.components = stock.components.filter(m => m.kind !== 'sensor');
  const source = withConstructionKind(stock, 'aircraft'), bed = compileDraftConstruction(source).plates.find(plate => plate.id === 'chassis:top-0'),
    floor = bed.y - 1.3 + bed.thicknessMm / 2000, part = kind => source.components.find(m => m.kind === kind),
    standing = (piece, x) => { piece.pose = { x: x / CELL, y: (floor + componentDimensions(piece, piece.sizeScale ?? 1).height / 2) / CELL, angle: 0 }; },
    leant = (.64 + 1.31) / 2 * Math.SQRT1_2;
  part('engine').sizeScale = Math.sqrt(.512);
  if (tankScale !== 1) part('fuel').sizeScale = tankScale;
  standing(part('engine'), 2.9); standing(part('fuel'), -2.75); standing(part('command'), -2);
  [[-1.1, floor + leant, -Math.PI / 4], [-.05, floor + 1.31 / 2, 0], [.62, floor + 1.31 / 2, 0], [1.67, floor + leant, Math.PI / 4]]
    .forEach(([x, y, angle], i) => source.components.push({ id: `lift${i}`, kind: 'thruster', metal: 'titanium', pose: { x: x / CELL, y: y / CELL, angle } }));
  return source;
}
// That aircraft on skids raised as high as the Oficina raises them, a heavy machine gun hung under the middle of its hull,
// pointed 45° down and ahead — its front is at the smaller x of the design — and turning to straight down or level ahead,
// fed by a belt of 400 as FN's HMP400 pod holds, and a box of its rounds at the front of its bed. Its command post on the bed hardly sees under it: with `eye`, a camera
// hangs upside down from its rail 0.8 m before the gun, and sees the ground it flies over.
export function gunship({ eye = false, tankScale = 1 } = {}) {
  const source = withChassisSuspension(aircraft({ tankScale }), suspensionHeight(aircraft().chassis) + SKID_RISE),
    bed = compileDraftConstruction(source).plates.find(plate => plate.id === 'chassis:top-0'), floor = bed.y - 1.3 + bed.thicknessMm / 2000,
    box = { id: 'rounds', kind: 'ammo', ammoPreset: 'm2hb', sizeScale: .6 }, under = source.chassis.points[0].y;
  box.pose = { x: -3.5 / CELL, y: (floor + componentDimensions(box, .6).height / 2) / CELL, angle: 0 };
  source.components.push(box, { id: 'gun', kind: 'weapon', weaponPreset: 'm2hb|M400', pose: { x: 0, y: under - 22, angle: -3 * Math.PI / 4 },
    mount: { preset: 'pintle', sector: { min: -Math.PI / 4, max: Math.PI / 4 } } });
  if (eye) source.components.push({ id: 'eye', kind: 'sensor', sensorMode: 'visual', pose: { x: -.8 / CELL, y: under - 12, angle: Math.PI } });
  return source;
}
// The aircraft the tests send to work, each passed by the Oficina as it is (`mechanicalAdmission`): their thrusters lift
// them loaded full, and hold them level. Each has a larger tank than its vehicle has: the thrusters holding up a lorry burn
// the tank of one in a minute and a half. A piece is `[kind, x, size]`, standing on the bed at x metres of its middle —
// its front at the smaller x —, as it is on the stock vehicle of its kind but for its size; a thruster is of titanium.
const PIECES = { ...Object.fromEntries(['supply', 'mining-truck', 'chassis'].flatMap(template => createStructuredTemplate(template).components)
  .map(piece => [piece.kind, piece])) };
function stood(source, pieces) {
  const bed = compileDraftConstruction({ ...source, components: [] }).plates.find(plate => plate.id === 'chassis:top-0'),
    floor = bed.y - 1.3 + bed.thicknessMm / 2000;
  return pieces.map(([kind, x, size], i) => {
    const { pose, ...piece } = { ...PIECES[kind], ...source.components.find(m => m.kind === kind) }, scale = size ?? piece.sizeScale ?? 1;
    Object.assign(piece, { id: kind === 'thruster' ? `lift${i}` : kind, kind, sizeScale: scale }, kind === 'thruster' ? { metal: 'titanium' } : {});
    return { ...piece, pose: { x: x / CELL, y: (floor + componentDimensions(piece, scale).height / 2) / CELL, angle: 0 } };
  });
}
// One with no cab, as the aircraft above: the chassis of the stock truck drawn out to 10 m, with what it carries between its
// pairs of thrusters, where its load does not tip it over.
function open(pieces) {
  const stock = createStructuredTemplate('chassis');
  Object.assign(stock, { plates: [], nodes: [], components: [] });
  const source = withConstructionKind(stock, 'aircraft');
  source.chassis.points = source.chassis.points.map(point => ({ ...point, x: Math.sign(point.x) * 100 }));
  return { ...source, components: stood(source, pieces) };
}
// The ore lorry's digger and hopper on one: its digger at the rear end, delivering into its hopper over the rear thrusters;
// or, without its digger (`tool`), one that carries what is out of the ground already.
export const airMiner = ({ tool = true, size = tool ? 1.15 : 1.1 } = {}) => open([...(tool ? [['excavator', 4.35]] : []), ['thruster', 3.3, size],
  ['thruster', 2.45, size], ['hopper', 1.2], ['engine', -.2, .8], ['fuel', -1.3, 1.4], ['command', -2.1], ['thruster', -3.3, size], ['thruster', -4.15, size]]);
// The supply truck's supply piece on one, smaller.
export const airSupply = ({ size = 1.1 } = {}) => open([['thruster', 4.15, size], ['thruster', 3.3, size], ['supply', 1.75, 1.2], ['engine', 0, .8],
  ['fuel', -1.2, 1.3], ['command', -2.1], ['thruster', -3.3, size], ['thruster', -4.15, size]]);
// The constructor as an aircraft, its cab where it was and without its supply pieces — a builder that carries nothing, so
// that it weighs as much whatever it does —, on its chassis drawn out to 11 m: its crane at the rear end, two thrusters
// before the cab and two behind it.
export function airBuilder() {
  const source = withConstructionKind(createStructuredTemplate('construction-truck'), 'aircraft');
  source.chassis.points = source.chassis.points.map(point => ({ ...point, x: Math.sign(point.x) * 110 }));
  const kept = source.components.filter(m => ['command', 'sensor'].includes(m.kind));
  return { ...source, components: [...kept, ...stood(source, [['thruster', -5.15, 1.2], ['thruster', -4.35, 1.2], ['fuel', -3.25, 1.25], ['engine', -1.4],
    ['thruster', 2.6, 1.2], ['thruster', 3.4, 1.2], ['builder', 4.85]])] };
}
// The stock scout with its heavy machine gun taken out of its turret and set on a post on the roof of the turret, behind
// its camera, pointed straight up and turning down to a little under level on either side (weapon-mounts.ts `pintle`): a
// gun that reaches the sky.
export function skywatch() {
  const source = createStructuredTemplate('scout'), compiled = compileStructuredConstruction(source),
    gun = source.components.find(m => m.kind === 'weapon'), at = compiled.modules.find(m => m.id === gun.id),
    roof = compiled.plates.find(plate => plate.id === 'turret:roof'), top = roof.y + roof.thicknessMm / 2000;
  // The compiled design stands where its pose puts it, shifted as a whole: the gun's own pose and place tell by how much.
  // Kept for aircraft, it is fed by a belt of 400, the ready rounds of the .50 of a CROWS station.
  Object.assign(gun, { weaponPreset: 'm2hb|M400', pose: { x: gun.pose.x + (roof.x + .3 - at.x) / CELL, y: gun.pose.y + (top + 1.1 - at.y) / CELL, angle: Math.PI / 2 },
    mount: { preset: 'pintle' } });
  return source;
}
