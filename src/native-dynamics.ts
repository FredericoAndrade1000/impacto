import { loadDynamicsHost } from '#dynamics-host';
import type { NativeRuntime } from './native-host-contract.ts';
import { decodeGroundResponse } from './ground-response-contract.ts';
import type { GroundResponseRequest, GroundResponse } from './ground-response-contract.ts';
import { decodeBallisticReply } from './ballistic-contract.ts';
import type { BallisticRequest, BallisticReply, SolutionRequest, MountedRequest, PointRequest, PathRequest, FlightSolution, FlightState } from './ballistic-contract.ts';
import { isNativeAdmissionIssue, isNativeCompilerResponse } from './construction-codec.ts';
import type { NativeCompilerResponse } from './construction-contract.ts';
import { isNativeWorldConstructor } from './native-world-contract.ts';
import { bindWeaponVariants } from './weapons.ts';
import { weaponCatalogue } from './construction-admission.ts';
import type { NativeWorldConstructor, NativeWorldHandle } from './native-world-contract.ts';
export type { NativeWorldHandle } from './native-world-contract.ts';

type JsonCall = (request: string) => unknown;
type FuelCall = (engineKw: number, installedKw: number) => unknown;
let NativeWorld: NativeWorldConstructor | undefined, compileConstruction: JsonCall | undefined, ballisticFlight: JsonCall | undefined,
  templateSource: JsonCall | undefined, constructionCost: JsonCall | undefined, groundResponse: JsonCall | undefined,
  fuelFlow: FuelCall | undefined, initialization: Promise<void> | null = null;
export let nativeDynamicsRuntime: NativeRuntime | undefined;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
// These signatures follow the synchronous Rust bindings in lib.rs and node.rs.
const jsonCall = (value: unknown): value is JsonCall => typeof value === 'function';
const fuelCall = (value: unknown): value is FuelCall => typeof value === 'function';
// The number of what this page and the core say to each other: the frames, the commands, the
// words of the rounds in the air, cold profiles and replay rules (`HOST_CONTRACT`, in native/dynamics/src/lib.rs). A core that
// states another number is of another build, and its frames are not the ones this page reads:
// a page loaded while the core was being rebuilt says so instead of failing on a frame.
export const CORE_CONTRACT = 90;
// What a player is told of a core of another build, and of one asked for before `initNativeDynamics` loaded it. The
// numbers behind it go to the console, for whoever runs the game: the core may still be being rebuilt.
const OTHER_BUILD = 'Esta página é de outra versão do jogo. Recarregue a página.',
  NOT_LOADED = 'O jogo ainda não terminou de carregar. Recarregue a página.';
function agreed(contract: unknown): void {
  if (typeof contract !== 'function' || contract() !== CORE_CONTRACT) {
    console.error(`Núcleo de física de outro build: contrato ${typeof contract === 'function' ? contract() : 'ausente'}, esperado ${CORE_CONTRACT}.`);
    throw new Error(OTHER_BUILD);
  }
}
// The package's host import selects Node or the browser, including browser workers.
// One binding per host; each episode owns its solver.
export async function initNativeDynamics(): Promise<void> {
  return initialization ||= (async () => {
    const host = await loadDynamicsHost();
    agreed(host.host_contract);
    NativeWorld = isNativeWorldConstructor(host.NativeWorld) ? host.NativeWorld : undefined;
    compileConstruction = jsonCall(host.compile_construction) ? host.compile_construction : undefined;
    ballisticFlight = jsonCall(host.ballistic_flight) ? host.ballistic_flight : undefined;
    templateSource = jsonCall(host.template_source) ? host.template_source : undefined;
    constructionCost = jsonCall(host.construction_cost) ? host.construction_cost : undefined;
    groundResponse = jsonCall(host.ground_response) ? host.ground_response : undefined;
    if (jsonCall(host.weapon_variant)) bindWeaponVariants(host.weapon_variant, weaponCatalogue);
    fuelFlow = fuelCall(host.fuel_flow) ? host.fuel_flow : undefined;
    nativeDynamicsRuntime = host.runtime;
  })().catch(error => { initialization = null; throw error; });
}

function pureNative(call: JsonCall | undefined, request: unknown): unknown {
  if (typeof call !== 'function') throw new Error(NOT_LOADED);
  try {
    const encoded = JSON.stringify(request);
    if (encoded === undefined) throw new TypeError('Native requests must be serializable as JSON.');
    const text = call(encoded);
    if (typeof text !== 'string') throw new Error(OTHER_BUILD);
    const value: unknown = JSON.parse(text);
    return value;
  }
  catch (cause) { throw cause instanceof Error ? cause : new Error(String(cause)); }
}
export const nativeTemplateSource = (request: unknown): unknown => pureNative(templateSource, request);
export const nativeConstructionCost = (request: unknown): unknown => pureNative(constructionCost, request);
export const nativeGroundResponse = (request: GroundResponseRequest): GroundResponse | null => decodeGroundResponse(pureNative(groundResponse, request));
export function nativeFuelFlow(engineKw: number, installedKw: number): number {
  if (typeof fuelFlow !== 'function') throw new Error(NOT_LOADED);
  const result = fuelFlow(engineKw, installedKw);
  if (typeof result !== 'number') throw new Error(OTHER_BUILD);
  return result;
}

// A cold, pure module call: no World, sensor reading or solver is created.
export function compileNativeConstruction(construction: unknown, catalogue: unknown, draft = false, manufacture?: unknown, placement?: unknown): NativeCompilerResponse {
  if (typeof compileConstruction !== 'function') throw new Error(NOT_LOADED);
  let response: unknown;
  try { response = pureNative(compileConstruction, { version: 1, construction, catalogue, draft, manufacture, placement }); }
  catch (cause) { console.error('Compilação nativa:', cause); throw new Error(OTHER_BUILD, { cause }); }
  if (record(response) && response.error) {
    const error = response.error;
    if (!isNativeAdmissionIssue(error)) throw new Error(OTHER_BUILD);
    const code = error.code === 'CHASSIS_OVERLOAD' ? error.code :
      ['CONSTRUCTION_OVERLAP', 'BREECH_COMPONENT'].includes(error.code) ? 'CONSTRUCTION_OVERLAP' : 'STRUCTURED_CONSTRUCTION';
    throw Object.assign(new Error(error.code), error, { reason: error.code, code });
  }
  if (!isNativeCompilerResponse(response, draft)) {
    console.error('O compilador do núcleo respondeu em outro formato:', record(response) ? response.contract : undefined);
    throw new Error(OTHER_BUILD);
  }
  return response;
}

export function nativeBallisticFlight(request: SolutionRequest | MountedRequest): FlightSolution;
export function nativeBallisticFlight(request: PointRequest): FlightState;
export function nativeBallisticFlight(request: PathRequest): FlightState[];
export function nativeBallisticFlight(request: BallisticRequest): BallisticReply {
  return decodeBallisticReply(request.op, pureNative(ballisticFlight, request));
}

// Rust owns scene admission, rigid bodies, contacts and all mechanical state.
// The host keeps one opaque core and projects its ordinary game frames. The core
// starts without ground: the scene it is given names the ground, and the core lays it.
export class NativeDynamics {
  core: NativeWorldHandle;
  backend = 'rust';
  runtime: NativeRuntime | undefined;
  recoveries = 0;
  constructor() {
    if (!NativeWorld) throw new Error(NOT_LOADED);
    this.core = new NativeWorld(new Float64Array(), 0, -9.81);
    this.backend = 'rust';
    this.runtime = nativeDynamicsRuntime;
    this.recoveries = 0;
  }
  free() { this.core.free(); }
}
