import { tr } from './i18n.ts';
import { gridRegions } from './armor-grid.ts';
import { plateCorners } from './math.ts';
import { componentFootprintPolygons } from './assembly.ts';
import type { MaterialGrid } from './armor-grid.ts';
import type { CompiledConstruction } from './construction-contract.ts';
import type { SceneActor, LiveModule } from './scene-contract.ts';
import type { PlateMesh } from './mesh.ts';
import type { Pose } from './math.ts';

const middles = new WeakMap<Pick<CompiledConstruction, 'plates' | 'modules'>, number>();
// The middle of the whole design, measured from the origin it is admitted about. Turning keeps this place over
// the same ground; an asymmetric hull is seldom centred on its origin.
export function turningOffset(blueprint: Pick<CompiledConstruction, 'plates' | 'modules'>): number {
  if (!middles.has(blueprint)) {
    const xs = [...blueprint.plates.flatMap(plateCorners), ...blueprint.modules.flatMap(componentFootprintPolygons).flat()].map(p => p.x);
    middles.set(blueprint, (Math.min(...xs) + Math.max(...xs)) / 2 - 12);
  }
  return middles.get(blueprint)!;
}

// A ballistic preview of a mounted gun after its vehicle turns about. Reflect the trunnion and its elevation
// sector in the hull's frame, including its slope, about the upright of the hull that stands `offset` along it from its
// origin: the middle of the design, which a turn keeps over the same ground, or, in the air, its centre of mass
// (`aloftPose`). The live turn still admits and settles the whole design.
export function turnedLauncher(actor: SceneActor, gun: LiveModule & { weaponMount: { min: number; max: number } }, offset = actor.mirror * turningOffset(actor.blueprint)) {
  const pose = actor.vehicle!.pose(), angle = pose.angle || 0, c = Math.cos(angle), s = Math.sin(angle),
    along = (gun.x - pose.x) * c + (gun.y - pose.y) * s - offset;
  return { id: gun.id, weaponPreset: gun.weaponPreset, x: gun.x - 2 * along * c, y: gun.y - 2 * along * s,
    angle: Math.PI + 2 * angle - gun.angle,
    weaponMount: { min: -gun.weaponMount.max, max: -gun.weaponMount.min } };
}

// Where the origin of the hull of an aircraft stands once it turns about in the air (World.turnActor), and how it leans,
// as its pilot reckons with it: its own mirror image in the frame of its hull, about the upright of the hull through its
// centre of mass (`along` it from the origin) — the core then leans it about where it hovers still, a hull that hovers
// level as it leant (game_install.rs `Aloft`).
export function aloftPose(actor: SceneActor): Pose & { along: number } {
  const pose = actor.vehicle!.pose(), angle = pose.angle || 0, along = actor.vehicle!.carrierCenter?.x ?? 0;
  return { x: pose.x + 2 * along * Math.cos(angle), y: pose.y + 2 * along * Math.sin(angle), angle, along };
}

// A construction that turns about where it stands is its own mirror image. Each of its parts is admitted anew from
// the design, facing the other way (World.turnActor), and is given here what the part it was had become: what it
// holds, what it lost and the marks left on it, each on the side of the part it was on. The frame of a plate and
// that of a mounted gun keep their length and turn their thickness over: what was at `v` across it is at `1 - v`.
// The frame of any other component keeps its height and turns its length over: what was at `u` along it is at
// `1 - u`. What a part weighs is not carried: the core weighs a construction again by what it holds.
const across = <T extends { v: number }>(marks: readonly T[]): T[] => marks.map(mark => ({ ...mark, v: 1 - mark.v })),
  along = <T extends { u: number }>(marks: readonly T[]): T[] => marks.map(mark => ({ ...mark, u: 1 - mark.u }));
const cells = (grid: MaterialGrid): Uint8Array => Uint8Array.from({ length: grid.bits.length / 2 }, (_, i) => parseInt(grid.bits.slice(i * 2, i * 2 + 2), 16));
const SCAR_CELLS = 32; // the scars of a component are kept by cells of its frame, this many each way

// The armour grid of a plate turned about: `whole`, as the design has it, less what the grid it had become (`left`)
// had lost of it, each cell on the other side of the thickness. Rows run across the thickness (armor-grid.ts).
// A plate that lost nothing has the grid of its design itself.
export function turnedGrid(whole: MaterialGrid, left: MaterialGrid): MaterialGrid {
  const { nx, ny } = whole;
  if (left.nx !== nx || left.ny !== ny) throw new Error(tr('Grade de blindagem de outro projeto.'));
  const full = cells(whole), now = cells(left), turned = full.slice(), has = (grid: Uint8Array, cell: number): number => grid[cell >> 3]! & 1 << (cell & 7);
  let lost = false;
  for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
    if (!has(full, y * nx + x) || has(now, y * nx + x)) continue;
    const cell = (ny - 1 - y) * nx + x;
    turned[cell >> 3] = turned[cell >> 3]! & ~(1 << (cell & 7)); lost = true;
  }
  return lost ? { ...whole, bits: Array.from(turned, byte => byte.toString(16).padStart(2, '0')).join('') } : whole;
}

// Gives a plate admitted anew (`fresh`) what the plate it was (`old`) had become. A plate the design is no longer
// made into — one that came into the field when its joints were made otherwise — comes back as the design has it now:
// what became of a plate of another shape is not carried over to this one.
export function turnPlate(fresh: PlateMesh, old: PlateMesh): void {
  // Turning only readmits plates already admitted by the core, with their material grids.
  const whole = fresh.ballisticGrid!, left = old.ballisticGrid!;
  if (whole.nx !== left.nx || whole.ny !== left.ny) return;
  const grid = turnedGrid(whole, left);
  fresh.ballisticGrid = grid; fresh.damage.regions = gridRegions(grid); fresh.damage.refresh(); fresh.refreshSpans();
  Object.assign(fresh, { marks: across(old.marks), perforations: old.perforations.map(hole => ({ ...hole })),
    dents: new Map([...(old.dents?.values() || [])].map((dent, i) => [i, { ...dent, v: 1 - dent.v }])),
    revision: old.revision, markRevision: old.markRevision, groundMarks: old.groundMarks });
  fresh.updateBounds();
}

// What a component holds and what became of it, whichever way it faces.
const HELD = ['health', 'fuelLitres', 'rounds', 'detonated', 'burning', 'burnAge', 'fireAge', 'barrelDamage', 'barrelDisabled', 'beltCut', 'reload', 'barrelTemperature',
  'barrelCooling', 'loaded', 'feedReload', 'markRevision',
  'groundMarks', 'groundDamage',
  'elevationDamage', 'elevationDisabled'] as const satisfies readonly (keyof LiveModule)[];
type HeldState = Pick<LiveModule, typeof HELD[number]>;
function copyHeld<K extends keyof HeldState>(fresh: Partial<HeldState>, old: Partial<HeldState>, key: K): void {
  if (old[key] !== undefined) fresh[key] = old[key];
}

// Gives a plate admitted anew where it stood, facing as it faced (World.reviveActor), what the plate it was had become: its
// grid, its holes, its dents and its marks, as they were. One of another shape comes back as the design has it.
export function keepPlate(fresh: PlateMesh, old: PlateMesh): void {
  const whole = fresh.ballisticGrid!, left = old.ballisticGrid!;
  if (whole.nx !== left.nx || whole.ny !== left.ny) return;
  fresh.ballisticGrid = left; fresh.damage.regions = gridRegions(left); fresh.damage.refresh(); fresh.refreshSpans();
  Object.assign(fresh, { marks: (old.marks || []).map(mark => ({ ...mark })), perforations: old.perforations.map(hole => ({ ...hole })),
    dents: new Map([...(old.dents?.values() || [])].map((dent, i) => [i, { ...dent }])), revision: old.revision, markRevision: old.markRevision,
    groundMarks: old.groundMarks });
  fresh.updateBounds();
}
// Gives a component admitted anew where it stood, facing as it faced, what the component it was had become.
export function keepModule(fresh: LiveModule, old: LiveModule): void {
  for (const key of HELD) copyHeld(fresh, old, key);
  if (old.cargo) fresh.cargo = { ...old.cargo };
  if (old.marks) fresh.marks = old.marks.map(item => ({ ...item }));
  if (old.barrelMarks) fresh.barrelMarks = old.barrelMarks.map(item => ({ ...item }));
  if (old.mantletHoles) fresh.mantletHoles = old.mantletHoles.map(item => ({ ...item }));
  if (old.ballisticScars) fresh.ballisticScars = structuredClone(old.ballisticScars);
}

// Gives a component admitted anew (`fresh`) what the component it was (`old`) had become.
export function turnModule(fresh: LiveModule, old: LiveModule): void {
  for (const key of HELD) copyHeld(fresh, old, key);
  if (old.cargo) fresh.cargo = { ...old.cargo };
  if (old.marks) fresh.marks = old.weaponMount ? across(old.marks).map(mark =>
    mark.part === 2 || mark.part === 3 ? { ...mark, part: 5 - mark.part } : mark) : along(old.marks);
  // The marks of a barrel are told along it and to a side of it.
  if (old.barrelMarks) fresh.barrelMarks = old.barrelMarks.map(mark => ({ ...mark, y: -mark.y }));
  if (old.mantletHoles) fresh.mantletHoles = old.mantletHoles.map(hole => ({ min: -hole.max, max: -hole.min })).reverse();
  if (old.ballisticScars) fresh.ballisticScars = Object.fromEntries(Object.entries(old.ballisticScars).map(([cell, scar]) => {
    const [u, v] = cell.split(':'); return [`${SCAR_CELLS - 1 - Number(u)}:${v}`, scar];
  }));
}
