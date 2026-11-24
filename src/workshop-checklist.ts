import type { CompiledConstruction, CompiledModule, NativeAdmissionIssue } from './construction-contract.ts';
import type { ModuleKind } from './materials.ts';
export interface ChecklistItem { id: string; label: string; state: 'attention' | 'ready' | 'info'; detail: string; target: string; marked?: boolean; action?: string }
import { tr } from './i18n.ts';
// A short review of the compiled design in the Workshop. `attention` describes either
// the field's real publication requirements (chassis admission, Command and the rounds of each gun) or equipment that
// cannot do its work yet; the other rows never decide whether publishing is allowed.
import { CHASSIS_ID } from './chassis-editing.ts';
import { count, number, power } from './format.ts';
import { constructionEditMessage } from './structured-editing.ts';
import { cartridgeId } from './weapons.ts';

// A row the pieces of which the workshop marks (structured-editing.ts `MARKED_ISSUES`) is `marked` as they are.
const item = (id: string, label: string, state: ChecklistItem['state'], detail: string, target: string, marked = false): ChecklistItem => ({ id, label, state, detail, target, ...(marked ? { marked } : {}) });
const working = (module: CompiledModule & { detonated?: boolean }) => module.attached !== false && module.health !== 0 && !module.detonated;
const litres = (value: number) => value < 1 ? tr('menos de 1 L') : `${count(value)} L`;
// A gun by the rounds it fires (weapons.ts `cartridgeId`), a box by those it holds.
const preset = (module: CompiledModule) => module.weaponPreset ? cartridgeId(module.weaponPreset) : module.ammoPreset || 'rh120';
// Of the guns and the boxes of a compiled design: a gun fires the rounds of the boxes of its own calibre and of no other
// (game_damage.rs `consume_round`). `unfed` are the guns with no round of their calibre aboard, which are not fabricated
// (game_construction.rs `WEAPON_UNFED`); `small` the boxes of those, each too small for a round; and `idle` the boxes of a
// calibre no gun takes, which refuse nothing.
export function ammunitionFeed(modules: readonly CompiledModule[] = []) {
  const guns = modules.filter(module => module.kind === 'weapon'), boxes = modules.filter(module => module.kind === 'ammo'),
    of = (gun: CompiledModule) => boxes.filter(box => preset(box) === preset(gun)), unfed = guns.filter(gun => !of(gun).some(box => box.rounds > 0));
  return { unfed, small: [...new Set(unfed.flatMap(of))], idle: boxes.filter(box => !guns.some(gun => preset(gun) === preset(box))) };
}
// The boxes of a calibre no gun of the design takes, as the workshop marks them (`AMMUNITION_IDLE`).
export function idleAmmunition(blueprint: CompiledConstruction | null | undefined) {
  const ids = ammunitionFeed(blueprint?.modules).idle.map(box => box.id);
  return ids.length ? [{ code: 'AMMUNITION_IDLE', ids }] : [];
}
// What drives a vehicle, lifts it or builds from one, which does nothing on a construction that stays where it is built.
// There an engine and its fuel turn an excavator or a drill (`TOOL_POWER`), and serve one that has either.
const VEHICLE_ONLY = { engine: 'motor', fuel: tr('combustível'), builder: tr('braço construtor'), thruster: 'propulsor' } satisfies Partial<Record<ModuleKind, string>>;
const TOOL_POWER = ['engine', 'fuel'];
const tool = (module: CompiledModule) => module.kind === 'excavator' || module.kind === 'drill';
// The road machines: a grader's blade and a paver.
const road = (module: CompiledModule) => module.kind === 'blade' || module.kind === 'paver';
// What of those a design has that does nothing on it.
const idleKinds = (blueprint: CompiledConstruction, modules: readonly CompiledModule[]) => blueprint.vehicle?.enabled ? [] : Object.keys(VEHICLE_ONLY)
  .filter((kind): kind is keyof typeof VEHICLE_ONLY => Object.hasOwn(VEHICLE_ONLY, kind))
  .filter(kind => modules.some(module => module.kind === kind) && !(TOOL_POWER.includes(kind) && modules.some(tool)));
const opticsOf = (blueprint: CompiledConstruction | null | undefined) => (blueprint?.modules || []).filter(module => working(module) &&
  (module.kind === 'command' || module.kind === 'sensor' && module.sensorMode === 'visual'));
const opticalSights = (blueprint: CompiledConstruction | null | undefined) => {
  const ids = new Set(opticsOf(blueprint).map(module => module.id));
  return (blueprint?.sights || []).filter(sight => ids.has(sight.id));
};

// A draft remains editable and saveable. Only fabrication needs these native
// native findings resolved; presentation never recomputes admission.
const admissionIssues = (blueprint: CompiledConstruction | null | undefined, manufactureIssues: readonly NativeAdmissionIssue[]) => [...(blueprint?.mechanicalAdmission === false ? blueprint.admissionIssues || [] : []),
  ...manufactureIssues.filter(issue => ['PHYSICAL_SUPPORT', 'WEAPON_UNFED', 'THRUSTER_CHASSIS'].includes(issue.code))];
// What an aircraft's thrusters cannot do, told with its flight rather than with its chassis.
const FLIGHT_ISSUES = ['AIRCRAFT_LIFT', 'AIRCRAFT_BALANCE'];
// What the player is told of each, a road tool too high by its kind (structured-editing.ts `TOOL_GROUND`), and once of
// what is told alike of several.
function admissionText(blueprint: CompiledConstruction | null | undefined, issues: readonly NativeAdmissionIssue[]) {
  if (!issues.length) return '';
  const fixed = blueprint?.preset !== 'vehicle', kind = (id: string | undefined) => blueprint?.modules?.find(module => module.id === id)?.kind, reasons = issues
    .map(issue => constructionEditMessage(issue.code === 'TOOL_GROUND' ? { ...issue, tool: kind(issue.ids?.[0]) } : issue, { quiet: true, fixed }));
  return [...new Set(reasons)].join(' ') || tr('Revise o projeto para fabricar.');
}
export const workshopAdmissionMessage = (blueprint: CompiledConstruction | null | undefined, manufactureIssues: readonly NativeAdmissionIssue[] = []) => admissionText(blueprint, admissionIssues(blueprint, manufactureIssues));

// Open the equipment responsible for the review, independent of catalogue order.
export function workshopReviewPart(blueprint: CompiledConstruction, id: string, manufactureIssues: readonly NativeAdmissionIssue[] = []) {
  if (id === 'support') return manufactureIssues.find(issue => issue.code === 'PHYSICAL_SUPPORT')?.ids?.[0] ?? null;
  const modules = blueprint?.modules || [];
  if (['chassis', 'running-gear'].includes(id) && blueprint?.chassis) return CHASSIS_ID;
  if (id === 'vision') return opticalSights(blueprint).find(sight => sight.left > 0 &&
    modules.some(module => module.id === sight.id && module.kind === 'sensor'))?.id ||
    opticalSights(blueprint).find(sight => sight.left > 0)?.id ||
    opticsOf(blueprint).find(module => module.kind === 'sensor')?.id || opticsOf(blueprint)[0]?.id || null;
  // A box too small for a round of a gun it should feed, then a box no gun takes rounds from, whose calibre may be changed
  // to that of a gun that has none, then such a gun.
  if (id === 'armament') {
    const guns = modules.filter(module => module.kind === 'weapon'), boxes = modules.filter(module => module.kind === 'ammo'),
      compatible = boxes.filter(box => guns.some(gun => preset(gun) === preset(box))), { unfed, small, idle } = ammunitionFeed(modules);
    return (small[0] || idle[0] || unfed[0] || compatible.find(box => !(box.rounds > 0)) || compatible[0] || guns[0] || boxes[0])?.id ?? null;
  }
  const kindGroups: Record<string, readonly string[]> = { command: ['command'], engine: ['engine'], fixed: idleKinds(blueprint, modules), 'running-gear': ['wheel', 'track'], fuel: ['fuel'],
    extraction: ['excavator', 'drill'], building: ['builder'], road: ['blade', 'paver'], flight: ['thruster'] }, kinds = kindGroups[id] || [];
  return modules.find(module => kinds.includes(module.kind))?.id ?? null;
}

export function workshopChecklist(blueprint: CompiledConstruction | null | undefined, manufactureIssues: readonly NativeAdmissionIssue[] = []): ChecklistItem[] {
  if (blueprint?.derived !== true || !Array.isArray(blueprint.modules)) return [];

  const modules = blueprint.modules.filter(working), of = (kind: ModuleKind) => modules.filter(module => module.kind === kind),
    command = of('command'), engines = of('engine'), gears = modules.filter(module => module.kind === 'wheel' || module.kind === 'track'),
    tanks = of('fuel'), guns = of('weapon'), boxes = of('ammo'), thrusters = of('thruster'),
    fuel = tanks.reduce((sum, tank) => sum + Math.max(0, tank.fuelLitres || 0), 0);
  const sights = opticalSights(blueprint), forward = Math.max(0, ...sights.map(sight => sight.left)),
    cameras = modules.filter(module => module.kind === 'sensor' && module.sensorMode === 'visual'),
    vision = forward > 0 ? item('vision', tr('Visão à frente'), 'ready', tr`${count(forward)} m à frente.`, 'adjust') :
      cameras.length ? item('vision', tr('Visão à frente'), 'attention',
        sights.some(sight => sight.right > 0) ? tr('Só vê para trás.') : tr('O casco tapa a câmera.'), 'adjust') :
      item('vision', tr('Visão à frente'), command.length ? 'attention' : 'info', tr('Sem câmera por fora nem vidro.'), 'build');

  const mobility = engines.length ?
    item('engine', tr('Motor'), 'ready', engines.length === 1 ? tr('Motor instalado.') : tr`${engines.length} motores instalados.`, 'adjust') :
    item('engine', tr('Motor'), 'info', tr('Sem motor.'), 'build');
  const wheels = gears.some(gear => gear.kind === 'wheel'), tracks = gears.some(gear => gear.kind === 'track'),
    aircraft = blueprint.chassis?.model === 'aircraft',
    running = aircraft ? item('running-gear', tr('Esquis'), 'ready', tr('Pousa nos esquis.'), 'adjust') : gears.length ? item('running-gear', tr('Rodagem'), 'ready',
      wheels && tracks ? tr('Rodas e esteiras instaladas.') : wheels ? tr('Rodas instaladas.') : tr('Esteiras instaladas.'), 'adjust') :
      item('running-gear', tr('Rodagem'), engines.length && !thrusters.length ? 'attention' : 'info', tr('Sem rodas nem esteiras.'), 'build');
  // A tank is built full. Its fuel turns the engines and the thrusters.
  const fuelItem = !tanks.length ? item('fuel', tr('Combustível'), engines.length || thrusters.length ? 'attention' : 'info',
    engines.length ? tr('Sem tanque: o motor não funciona sem combustível.') :
      thrusters.length ? tr('Sem tanque: os propulsores não funcionam sem combustível.') : tr('Sem tanque; sem motor para abastecer.'), 'build') :
    !engines.length && !thrusters.length ? item('fuel', tr('Combustível'), 'info', tr`${litres(fuel)} no tanque, mas sem motor para usar.`, 'adjust') :
      item('fuel', tr('Combustível'), 'ready', tr`${litres(fuel)} no tanque.`, 'adjust');
  // An aircraft is told whether its thrusters lift it with what it carries full, with room to climb and steer, then
  // whether they hold it level, as the core tells it of its design (game_construction.rs `AIRCRAFT_LIFT`, game_hover.rs
  // `hover`): all of them as built, whatever of them is damaged later. A thruster on another vehicle lifts nothing.
  const grounded = (blueprint.admissionIssues ?? []).find(issue => FLIGHT_ISSUES.includes(issue.code)),
    flightItem = !blueprint.vehicle?.enabled ? null : !aircraft ? thrusters.length ?
      item('flight', tr('Voo'), 'attention', constructionEditMessage({ code: 'THRUSTER_CHASSIS' }), 'adjust') : null :
      grounded ? item('flight', tr('Voo'), 'attention', constructionEditMessage(grounded, { quiet: true }), 'adjust') :
        item('flight', tr('Voo'), 'ready', tr`Decola com até ${number(blueprint.chassis!.limitKg / 1000)} t.`, 'adjust');

  // A box is built full: one holds no round only when it is too small for one of its calibre. A gun with no round of its
  // calibre aboard is not fabricated, and is told the way to one: a box of its calibre that holds a round, the calibre of a
  // box no gun takes changed to its own, or a box put in. Such a box is told where every gun has its rounds.
  // What the suggestion of the review does about it, where that is not to enlarge a box or to put one in (workshop-context.ts).
  const feed = ammunitionFeed([...guns, ...boxes]), ARMAMENT = tr('Arma e munição compatível'), marked = (detail: string, target: string, action?: string) =>
      ({ ...item('armament', ARMAMENT, 'attention', detail, target, true), ...(action ? { action } : {}) }),
    rounds = boxes.filter(box => guns.some(gun => preset(gun) === preset(box))).reduce((sum, box) => sum + Math.max(0, box.rounds || 0), 0);
  let armament;
  if (!guns.length) armament = boxes.length ? marked(tr('Caixa de munição sem arma que a use.'), 'adjust', tr('Ver caixa')) :
    item('armament', ARMAMENT, 'info', tr('Sem arma (opcional).'), 'build');
  else if (feed.small.length) armament = marked(constructionEditMessage({ code: 'WEAPON_UNFED', ids: [feed.unfed[0]!.id, feed.small[0]!.id] }), 'adjust');
  else if (feed.unfed.length) armament = feed.idle.length ?
    marked(tr('Arma sem caixa de munição do calibre dela: troque o calibre da caixa que sobrou para fabricar.'), 'adjust', tr('Trocar calibre')) :
    marked(constructionEditMessage({ code: 'WEAPON_UNFED', ids: [feed.unfed[0]!.id] }), 'build');
  else if (feed.idle.length) armament = marked(feed.idle.length > 1 ? tr('Caixas de munição de calibres que nenhuma arma usa.') :
    tr('Caixa de munição de um calibre que nenhuma arma usa.'), 'adjust', tr('Trocar calibre'));
  else armament = item('armament', ARMAMENT, 'ready',
    tr`${guns.length} ${guns.length === 1 ? 'arma' : 'armas'} com munição compatível · ${count(rounds)} ${rounds === 1 ? 'tiro' : 'tiros'}.`, 'adjust');

  // A tool works on the power of the engines of its construction (`workKw`): at the share of its pace they give it. What
  // its tools ask of them is always told, with what they give.
  const given = engines.reduce((sum, engine) => sum + (engine.powerKw || 0), 0),
    powered = (id: string, label: string, tools: readonly CompiledModule[], does: string, ready: string | null) => {
      const asked = tools.reduce((sum, module) => sum + (module.workKw || 0), 0), them = tools.length > 1 ? tr('as ferramentas pedem') : tr('a ferramenta pede');
      return !tools.length ? null : !engines.length ? item(id, label, 'attention', tr`Sem motor: não ${does}.`, 'build') :
        given < asked ? item(id, label, 'attention',
          tr`O motor dá ${power(given)} dos ${power(asked)} que ${them}: ${does} a ${Math.floor(given / asked * 100)} % do ritmo.`, 'adjust') :
        item(id, label, 'ready', tr`${ready ? ready + ' ' : ''}${them[0]!.toUpperCase()}${them.slice(1)} ${power(asked)}; o motor dá ${power(given)}.`, 'adjust');
    },
    extraction = powered('extraction', tr('Extração'), modules.filter(tool), 'extrai', tr('Extrai na jazida; outro veículo pode levar.')),
    building = blueprint.vehicle?.enabled ? powered('building', tr('Obra'), of('builder'), 'monta', null) : null,
    issues = admissionIssues(blueprint, []), high = issues.filter(issue => issue.code === 'TOOL_GROUND'),
    // A blade or a screed that does not reach the ground makes no road, whatever its engine gives it; nor does one on an
    // aircraft, which works where it comes down and drives along nothing (server/supply-dispatch.ts `roadMachine`).
    roads = modules.filter(road), roadwork = aircraft && roads.length ? item('road', tr('Estrada'), 'info', tr('Aeronave não faz estradas.'), 'adjust') :
      high.length ? item('road', tr('Estrada'), 'attention', admissionText(blueprint, high.slice(0, 1)), 'adjust', true) :
      blueprint.vehicle?.enabled ? powered('road', tr('Estrada'), roads,
        roads.every(module => module.kind === 'blade') ? 'nivela' : roads.every(module => module.kind === 'paver') ? 'pavimenta' : 'trabalha', null) : null;

  const idle = idleKinds(blueprint, modules),
    named = idle.map(kind => VEHICLE_ONLY[kind]), listed = named.length > 1 ? `${named.slice(0, -1).join(', ')} e ${named.at(-1)}` : named[0],
    fixed = idle.length ? item('fixed', tr('Construção fixa'), 'attention',
      tr`${listed![0]!.toUpperCase()}${listed!.slice(1)} não ${idle.length > 1 ? 'servem' : 'serve'} numa construção fixa` +
      (idle.every(kind => TOOL_POWER.includes(kind)) ? tr(' sem escavadeira ou perfuratriz.') : tr(': ela não sai do lugar.')), 'adjust') : null;

  const admission = admissionText(blueprint, issues.filter(issue => issue.code !== 'TOOL_GROUND' && !FLIGHT_ISSUES.includes(issue.code))),
    support = manufactureIssues.find(issue => issue.code === 'PHYSICAL_SUPPORT');
  return [
    ...(admission && blueprint.chassis ? [item('chassis', tr('Chassi'), 'attention', admission, 'adjust')] : []),
    ...(support ? [item('support', tr('Apoio físico'), 'attention', constructionEditMessage(support, { fixed: blueprint.preset !== 'vehicle' }), 'adjust', true)] : []),
    command.length ? item('command', tr('Comando'), 'ready', tr('Comando instalado.'), 'adjust') :
      item('command', tr('Comando'), 'attention', tr('Sem Comando: não fabrica.'), 'build'),
    ...(fixed ? [fixed] : []), vision, ...(blueprint.vehicle?.enabled ? [mobility, running, fuelItem] : modules.some(tool) ? [fuelItem] : []),
    ...(flightItem ? [flightItem] : []),
    ...(extraction ? [extraction] : []), ...(building ? [building] : []), ...(roadwork ? [roadwork] : []), armament,
  ];
}
