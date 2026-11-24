import { tr, preferredLanguage, languageURL, isLanguagePreference } from './i18n.ts';
import { createPlayerControls } from './player-controls.ts';
import { createArmourTrial } from './armour-trial.ts';
import { createCanvasControls } from './canvas-controls.ts';
import { createNotices } from './notices.ts';
import { createFieldDesigns } from './field-designs.ts';
import { createProjectWorkspace, createEditorView } from './project-workspace.ts';
import { createPlayContext, PLACE_VIEW } from './play-context.ts';
import { Editor, pickShownPiece } from './editor.ts';
import type { EditorEvent } from './editor.ts';
import { DetailEditor } from './detail-editor.ts';
import { pointOf } from './frame-points.ts';
import { Renderer } from './render.ts';
import { createStructuredTemplate } from './structured-templates.ts';
import { initNativeDynamics } from './native-dynamics.ts';
import { allowedAmmo, isCartridgeId, isWeaponPresetId } from './weapons.ts';
import { MODULES } from './materials.ts';
import type { ModuleKind } from './materials.ts';
import { parseBlueprint, workshopDraft, compileBlueprint } from './persistence.ts';
import { projectRefusalMessage } from './project-refusal.ts';
import { DesignLibrary, LIBRARY_KEY } from './library.ts';
import { captureProjectRecords, openProjectOriginals } from './project-originals.ts';
import { ConstructionUI, garageCard } from './construction-ui.ts';
import { confirm } from './confirm-dialog.ts';
import { EncounterBands } from './encounter-bands.ts';
import { clamp, plateCorners } from './math.ts';
import { componentPolygons } from './assembly.ts';
import { FrameBudget } from './performance.ts';
import { FrameMeter, detailLines } from './frame-meter.ts';
import { ClientPerformance, gpuInformation } from './client-performance.ts';
import { watchContext } from './context-loss.ts';
import { NetworkClient, keptName } from './network-client.ts';
import { createServerMenu, type ServerChoice } from './server-menu.ts';
import { rememberServer, serverHttpOrigin } from './server-browser.ts';
import { PendingReplies } from './pending-replies.ts';
import { keyOf } from './network-protocol.ts';
import { SoundSystem } from './audio.ts';
import { soundFiles } from './sound-art.ts';
import { Mood, tracksByMood } from './soundtrack.ts';
import { TRIAL_WORLD } from './battle-rules.ts';
import { shotCount } from './shots.ts';
import { screenModel, controlContext, armamentIntent, lookIntent, linkedArmament, pieceKey, loadout, trialOpened, flies } from './ui-model.ts';
import { DomView, keepDisclosures } from './dom-view.ts';
import { WorkshopScreen } from './workshop-screen.ts';
import { FieldScreen } from './field-screen.ts';
import { TestConsole } from './test-console.ts';
import { FirstObjectives } from './first-objectives.ts';
import { WorkspaceChrome } from './workspace-chrome.ts';
import { PublicationPlacement } from './publication-placement.ts';
import { RoadPlacement } from './road-placement.ts';
import { PostPlacement } from './post-placement.ts';
import { PLACEMENT_FIELDS, STRIKE_DISTANCES, mountForms } from './ui-fields.ts';
import { initWorkshopUX } from './workshop-ux.ts';
import { installPageKeys, installSettingsKeys } from './workshop-keys.ts';
import { initSquadUX } from './squad-ux.ts';
import { initFactionUX } from './faction-ux.ts';
import { industryReason } from './industry-ui.ts';
import { initInfrastructureUX } from './infrastructure-ux.ts';

import { initChat } from './chat-ux.ts';
import { publishedText, knownVeins, depositMarks, obraQuote, postQuote } from './faction-ui.ts';
import { depositsOf } from './deposits.ts';
import { Overview } from './overview.ts';
import { touching, initStick } from './touch.ts';
import { workshopReviewPart } from './workshop-checklist.ts';
import { suggestedAmmunition } from './workshop-actions.ts';
import { vehicleSpeed } from './vehicle-speed.ts';
import { bill, billSum, designBill, STOCK_IDS } from './economy.ts';
import { SHOT_BUDGET } from './construction-limits.ts';
import type { AuthoredConstruction, WithAbsentSlots } from './construction-contract.ts';
import type { LibraryEntry } from './library.ts';
import type { Point } from './math.ts';
import type { UiView, UiSession, FabricationNotice, UiModel } from './ui-model.ts';
import type { CanvasControlInput } from './canvas-controls.ts';
import type { PlayerControlInput, ControlArmament } from './player-controls.ts';
import type { FrameReport, FrameDetail } from './frame-meter.ts';
import type { PublicationBegin, PublicationIntent } from './publication-placement.ts';
import type { RoadIntent } from './road-placement.ts';
import type { PostIntent } from './post-placement.ts';
import type { TemplateId } from './construction-template-catalogue.ts';
import type { ArmamentIntent } from './ui-model.ts';
import type { ObjectiveAction } from './first-objectives.ts';
import type { FieldView } from './faction-ui.ts';
import type { CommandData, CommandKind, CommandResult, TestRequest, TestAct, TestResultFor } from './field-protocol-contract.ts';
import type { WorkerCommands, WorkerCommandKind, WorkerMessage, WorkerFrame } from './simulation-contract.ts';
import type { SceneEventBase } from './scene-contract.ts';
import type { SupplyBill } from './economy-contract.ts';
import { decodeTestResultFor } from './field-protocol-codec.ts';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object';
const errorMessage = (error: unknown): string => record(error) && typeof error.message === 'string' ? error.message : String(error);
const moduleKind = (value: unknown): value is ModuleKind => typeof value === 'string' && Object.hasOwn(MODULES, value);
type ObjectiveIntent = ObjectiveAction | Omit<ObjectiveAction, 'kind'> & { kind: 'cancelPlacement' };
interface LockingOrientation extends ScreenOrientation { lock(direction: 'landscape'): Promise<void> }
const canLockOrientation = (orientation: ScreenOrientation | null | undefined): orientation is LockingOrientation => Boolean(orientation && 'lock' in orientation && typeof orientation.lock === 'function');

// The compiler is a pure export of this same admitted native/Wasm module.
// Garage documents are validated only after that module has been loaded.
// The player is told plainly that the game did not load; what failed is for the console.
await initNativeDynamics().catch((error: unknown) => {
  console.error(error); document.getElementById('loading-text')!.textContent = tr('O jogo não carregou. Recarregue a página.'); throw error;
});
mountForms();
const ui = new DomView();
const $ = (selector: string): HTMLElement => {
  const element = ui.get(selector); if (!element) throw new Error('Controle ausente: ' + selector); return element;
};
const control = <ElementType extends HTMLElement>(selector: string, type: new () => ElementType): ElementType => {
  const element = $(selector); if (!(element instanceof type)) throw new TypeError('Tipo de controle inválido: ' + selector); return element;
};
const $$ = (selector: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(selector)];
const workspace = new WorkspaceChrome({ get: $, set: (selector, changes) => ui.set(selector, changes) }, { stopControls }), screen = new WorkshopScreen(ui);
// The way a construction published will face: the pair of buttons under the publishing of the workshop.
const deployFacing = {
  get value() { return Number($('#deploy-facing').dataset.facing); },
  set value(way) {
    $('#deploy-facing').dataset.facing = String(way);
    for (const button of $$('#deploy-facing button')) { const on = Number(button.dataset.facing) === Number(way); button.classList.toggle('active', on); button.setAttribute('aria-pressed', String(on)); }
  },
};
// Capture literal project records before this page or another tab can rewrite them. Credentials are not part of it.
let tabStorage: Storage | undefined, browserStorage: Storage | undefined;
try { tabStorage = window.sessionStorage; } catch {}
try { browserStorage = window.localStorage; } catch {}
const projectOriginals = captureProjectRecords({ local: browserStorage, session: tabStorage });
let startupNotice = '', library: DesignLibrary;
// Missing storage intentionally fails inside this try and retains the browser's original error below.
try { library = new DesignLibrary(browserStorage!); } catch (error) { library = new DesignLibrary({ getItem: () => null, setItem: () => { throw error; } }); library.error = error; }
// A browser that keeps nothing for the page says so in its own words, in English: the player is told in ours.
startupNotice = !browserStorage || library.error instanceof DOMException ? tr('Este navegador não deixa o jogo guardar dados: a garagem não vai salvar projetos.')
  : record(library.error) && typeof library.error.message === 'string' ? library.error.message : '';
if (library.error) console.error(library.error);
// Confirmed edits belong to their project in the garage. Other drafts stay untouched and exportable.
const workingStores = [tabStorage, browserStorage];
let editor!: Editor;
// Versions this editor actually opened or saved, independent of passive library sync. Undo can revisit each project.
const projectVersions = new Map<string, string>();
const opens = (from: Pick<LibraryEntry, 'id' | 'blueprint'>): boolean => {
  try {
    editor = new Editor(workshopDraft(from.blueprint), from.id || null);
    projectVersions.set(editor.projectId, JSON.stringify(from.blueprint)); return true;
  }
  catch (error) {
    // What the core refuses in it, a project of another version and one the workshop does not make are told to the
    // player, and where; a project of the garage stays there as it was. Anything else is a slip of the code.
    if (!record(error) || typeof error.reason !== 'string' && !['DESIGN_VERSION', 'NOT_A_CONSTRUCTION'].includes(String(error.code))) throw error;
    console.warn(error);
    const reason = projectRefusalMessage(error, from.blueprint);
    startupNotice = (error.code === 'NOT_A_CONSTRUCTION' ? reason : tr('Não foi possível abrir o último projeto. ') + reason) + tr(' O original continua na garagem e pode ser exportado.');
    return false;
  }
};
if (!(library.active && opens(library.active))) editor = new Editor(createStructuredTemplate('scout'));
if (projectOriginals.records.some(record => record.key !== LIBRARY_KEY && record.raw))
  startupNotice ||= tr('Há rascunhos disponíveis em Garagem → Baixar originais deste navegador. Os originais não foram alterados.');
// `trial` is the test the design is in, 'armour' or 'terrain', while it is in one.
const view: UiView = { editor, mode: 'edit', trial: null, buildTool: 'select', repeatPlacement: false, testTool: 'fire',
  aim: { x: 10, y: 1.4 }, placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' },
  weapon: armamentIntent({ preset: 'rh120', platform: 'ground' }),
  // The guns switched on to fire with the one in hand, and what each was last loaded with.
  linked: new Set(), loadouts: {} };
const renderer = new Renderer($('#viewport'), view);
screen.onTask = task => {
  detailsUX?.close();
  if (['project', 'publish', 'test'].includes(task) && view.mode === 'edit' && view.buildTool !== 'select') {
    view.buildTool = 'select'; renderer.modulePreview = renderer.platePreview = null; requestUI();
  }
  if (task === 'adjust') requestUI();
};
// Framing leaves room for the persistent inspector and controls. Temporary
// surfaces are modal: framing must remain useful when the surface is dismissed.
renderer.camera.cover = () => {
  const field = $('#viewport'), box = field.getBoundingClientRect(),
    shown = (selector: string, within: ParentNode = document) => [...within.querySelectorAll<HTMLElement>(selector)].filter(panel => panel.offsetParent).map(panel => panel.getBoundingClientRect()),
    [inspector] = shown('#project-inspector, #vehicle-details', field), [parts] = shown(':scope > #workshop-parts', field),
    // The list of pieces is a column at the left, or a row across the foot of an upright phone.
    column = parts && parts.height > parts.width,
    // The buttons at the top stand over the game: what is framed stays below their row.
    cover = { top: Math.max(0, $('#workspace-bar').getBoundingClientRect().bottom - box.top), bottom: 0,
      left: column ? Math.max(0, parts.right - box.left + 8) : 0,
      right: inspector ? Math.max(0, box.right - inspector.left + 8) : 0 };
  return { ...cover, top: Math.max(cover.top, ...shown(':scope > .camera-tools, :scope > .build-stats' +
      (view.mode === 'test' ? ', :scope > .faction-hud' : ''), field).map(r => r.bottom - box.top)),
    bottom: Math.max(cover.bottom, ...shown(':scope > .touch-pad, :scope > #field-dock, :scope > .publication-placement .publication-dock' +
      (column ? '' : ', :scope > #workshop-parts'), field)
      .filter(r => r.width > box.width * .4 || box.bottom - r.bottom < 16).map(r => box.bottom - r.top)) };
};
// The music is every track beside the game, by the mood its name says.
const sound = new SoundSystem({ sounds: { files: soundFiles(import.meta.glob('../sounds/*.mp3', { eager: true, query: '?url', import: 'default' })) }, music: { tracks: tracksByMood(import.meta.glob('../music/*.mp3', { eager: true, query: '?url', import: 'default' })) } }), mood = new Mood();
let worker: Worker | null = null, workerBoot: Promise<unknown> | undefined;
const network = new NetworkClient();
// The page is on the shared field when it is joined and no test of the design is under way: a test is the page's own
// world, and the field goes on without being shown until the player leaves it.
const onField = () => network.enabled && !view.trial;
const onTestServer = () => network.enabled && network.connected && network.testTools === true && !view.trial;
const instantFabrication = () => onTestServer() && testConsole?.instant === true;
// What a test is told of the field, on the screen and in the hands of the player: nothing.
const ALONE = Object.freeze({ enabled: false, connected: false, designs: new Map<string, { blueprint: AuthoredConstruction }>() }), seen = () => view.trial ? ALONE : network;
// Both worker and page use this fixed real-world segment; the armour bench stays flat.
const TRIAL_TERRAIN = TRIAL_WORLD.terrain;
const TRIAL_TERRAIN_SETTINGS = Object.freeze({ seed: TRIAL_WORLD.seed, length: TRIAL_WORLD.mapLength, center: TRIAL_WORLD.center });
// What the player sees into (faction-ui.ts `seenFromOutside`): in a test, the design as `trialOpened` says; on the field,
// the constructions picked (squad-ux.ts).
const opened = () => view.trial ? trialOpened(view) : squadUX?.opened() ?? null;
renderer.setTerrain('flat');
const replies = new PendingReplies();
const session: UiSession = { paused: true, generation: 0, requestSerial: 0, ready: false,
  physicsMs: 0, testDistance: STRIKE_DISTANCES[0]!, fitPending: null, slowed: false };
// An arrow let go stays among the look keys until a frame has moved the view for it: a tap shorter than a frame still counts.
const input: CanvasControlInput & PlayerControlInput = { gesture: null, pointerFire: false, keyFire: false, driveKeys: new Set(), lookKeys: new Set(), lookReleased: new Set(),
  spacePan: false, stick: null };
// The arrow keys carry the view this many times its own width in a second.
const LOOK_SPEED = .9;
let frameLimit = 0;
try { if (localStorage.getItem('impacto.frame-limit') === '60') frameLimit = 60; } catch {}
const frameBudget = new FrameBudget(performance.now(), frameLimit);
const clientPerformance = new ClientPerformance({ send: report => network.send('performance', report), context: () => {
  const actors = renderer.state?.actors ?? [], unseen = renderer.unseen, dotted = renderer.dotted;
  let visible = 0, moving = 0;
  for (const actor of actors) if (!unseen.has(actor.id) || dotted.has(actor.id)) {
    visible++;
    if (Math.hypot(actor.vehicle?.vx ?? 0, actor.vehicle?.vy ?? 0) > .15 || Math.abs(actor.vehicle?.omega ?? 0) > .05) moving++;
  }
  return { mode: renderer.site ? 'workshop' : 'field', viewport: [innerWidth, innerHeight], canvas: [renderer.camera.width, renderer.camera.height],
    pixels: [renderer.canvas.width, renderer.canvas.height], dpr: devicePixelRatio || 1, resolution: renderer.app.renderer.resolution,
    zoom: renderer.camera.zoom, actors: actors.length, visible, moving, particles: renderer.effects.particles.length,
    shots: shotCount(renderer.state?.shots), pingMs: network.pingMs };
} });
control('#frame-limit', HTMLSelectElement).value = String(frameLimit);
// How much the view shakes (screen-shake.ts), as the player last set it: normal until he does.
try { renderer.screenShake.setLevel(localStorage.getItem('impacto.screen-shake')); } catch {}
control('#screen-shake', HTMLSelectElement).value = renderer.screenShake.level;
// The meter of the frames (F3) is a diagnosis, off until the player asks for it. Asked once, it times the stretches of
// every frame and the work between frames, hears of the long tasks the browser tells of, and writes over the field,
// twice a second, what it found (frame-meter.ts). Asked again, it tells besides every part of the frames, what they
// sent to the video card, the card and the screen; a third time it is off, and nothing is timed, counted or written.
const METER = ['off', 'on', 'detail'];
const meter = renderer.meter = new FrameMeter(), longTasks = globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')
  ? new PerformanceObserver(list => { for (const task of list.getEntries()) meter.busy(task.duration); }) : null;
function setMeter(state: string) {
  const on = state !== 'off', detailed = state === 'detail';
  meter.turn(on, detailed); renderer.countCalls(detailed); network.onspent = on ? ms => meter.add('network', ms) : null;
  $('#frame-meter-toggle').setAttribute('aria-pressed', String(on));
  if (on) longTasks?.observe({ entryTypes: ['longtask'] }); else longTasks?.disconnect();
  $('#frame-meter').hidden = !on; $('#frame-meter').dataset.state = 'fine'; $('#frame-rate').textContent = 'medindo…'; $('#frame-causes').hidden = true;
  $('#frame-detail').hidden = !detailed; $('#frame-detail').replaceChildren();
  try { if (on) localStorage.setItem('impacto.frame-meter', state); else localStorage.removeItem('impacto.frame-meter'); } catch {}
}
const cycleMeter = () => setMeter(METER[(METER.indexOf(meter.detailed ? 'detail' : meter.on ? 'on' : 'off') + 1) % METER.length]!);
function showFrames(report: FrameReport) {
  const causes = $('#frame-causes');
  $('#frame-rate').textContent = report.rate; causes.textContent = report.causes.join(' · '); causes.hidden = !report.causes.length;
  $('#frame-meter').dataset.state = report.poor ? 'poor' : 'fine';
  if (report.detail) $('#frame-detail').replaceChildren(...frameDetail(report.detail, {
    gpu: clientPerformance.device.gpu, screen: [renderer.camera.width, renderer.camera.height], pixels: [renderer.canvas.width, renderer.canvas.height] }));
}
// The detail as it is written under the meter: a table of the parts of the frames in milliseconds, one of what they sent to
// the video card, each by its mean and its worst, and the lines of what was drawn and on what.
function frameDetail(detail: FrameDetail, page: Parameters<typeof detailLines>[1]) {
  const cell = (tag: 'th' | 'td' | 'p', text: string) => Object.assign(document.createElement(tag), { textContent: text }),
    row = (tag: 'th' | 'td', cells: string[]) => { const line = document.createElement('tr'); line.append(...cells.map(text => cell(tag, text))); return line; },
    table = (head: string, lines: FrameDetail['parts']) => { const made = document.createElement('table'); made.append(row('th', [head, tr('média'), 'pior']), ...lines.map(({ label, mean, worst }) => row('td', [label, mean, worst]))); return made; },
    lines = document.createElement('div');
  lines.append(...detailLines(detail, page).map(text => cell('p', text)));
  return [table(tr('ms por quadro'), detail.parts), table(tr('por quadro'), detail.tallies), lines];
}
let metered = 'off'; try { metered = localStorage.getItem('impacto.frame-meter') ?? 'off'; } catch {}
if (METER.includes(metered) && metered !== 'off') setMeter(metered);
let hudUpdated = 0, aimSent = 0, uiUpdated = 0, lookedAt = 0;
const encounterBands = new EncounterBands();
const { toast, placeToast, timeToast } = createNotices({ get: $, renderer, encounterBands, attempt, showPlace: x => showPlace(x) });
const workshop = new ConstructionUI({
  library, toast, confirm, stopControls, getBlueprint: () => editor.source, getProjectId: () => editor.projectId,
  getTrialWeapon: () => view.trial === 'armour' ? view.weapon.preset : null,
  onIndustry: () => factionUX.openIndustry(),
  getStock: () => network.enabled ? network.faction?.stock ?? null : null, onLibraryChange: requestUI,
  // The library of the faction, on the shared field.
  getFaction: () => network.enabled ? network.faction : null, getPlayerId: () => network.playerId, getTime: () => renderer.state?.time ?? 0,
  command: (type, data) => network.command(type, data),
  onRecover: () => {
    const current = captureProjectRecords({ local: browserStorage, session: tabStorage });
    openProjectOriginals({ ...projectOriginals, records: [...projectOriginals.records,
      ...current.records.filter((record, index) => record.raw !== projectOriginals.records[index]!.raw)
        .map(record => ({ ...record, label: tr('Após abrir esta página') }))] });
  },
  // A name given on the card of the open project is its name in the workshop too, with nothing left to save for it.
  onRename: (id, name) => projectWorkspace.rename(id, name),
  onOpen: openWorkshopDesign,
  onRemove: id => {
    const current = id === editor.projectId;
    // Another project takes its place: the last one opened, or else the first, of those that open.
    let next: Pick<LibraryEntry, 'id' | 'blueprint'> | null | undefined = current ? [library.active, ...library.entries].find(entry => entry && !garageCard(entry).refusal) : null;
    if (current && !next) next = { id: library.id(), blueprint: createStructuredTemplate('scout') };
    if (current && library.has(next!.id)) projectVersions.set(next!.id, JSON.stringify(next!.blueprint));
    editor.forgetProject(id, next ? { id: next.id, blueprint: workshopDraft(next.blueprint) } : next);
    projectVersions.delete(id);
    if (!current) return;
    clearGesture(); workshopUX?.cancelWeaponChoice();
    setTool('select', { open: false }); screen.closeInspector();
    standBoard(); renderer.board.camera.fit(editor.blueprint, true);
  },
  onInstall: async id => {
    stopControls(); await toWorkshop();
    if (workshopUX?.replaceWeapon(id)) return;
    Object.assign(view.placement, { kind: 'weapon', weaponPreset: id }); setTool('module');
  },
  // In the test of armour, the gun it is struck with is changed and the design stays as it stands.
  onTrialWeapon: id => changeWeapon({ preset: id }),
});

async function openWorkshopDesign(blueprint: unknown, id: string | null = null): Promise<boolean> {
  workshopDraft(blueprint); stopControls(); await toWorkshop();
  if (!await openProject(blueprint, id)) return false;
  standBoard(); renderer.board.camera.fit(editor.blueprint, true);
  toast(id ? tr('Construção aberta na Oficina.') : tr('Modelo aberto na Oficina.'));
  return true;
}
function reportError(error: unknown) {
  if (view.mode === 'edit') editor.rejectEdit(error);
  toast(view.mode === 'edit' ? editor.blockedEdit!.message : errorMessage(error), true); requestUI();
}
function attempt(action: () => unknown): unknown {
  try { const result = action(); return result && (typeof result === 'object' || typeof result === 'function') && 'catch' in result && typeof result.catch === 'function' ? result.catch(reportError) : result; }
  catch (error) { reportError(error); }
}
function click(ids: string, action: (event: MouseEvent) => unknown) {
  for (const id of ids.split(' ')) $('#' + id).onclick = event => attempt(() => action(event));
}
type PrivateCommandKind = Exclude<WorkerCommandKind, CommandKind>;
type NetworkCommandCall = { [Kind in CommandKind]: [type: Kind, data?: CommandData[Kind]] }[CommandKind];
type PrivateCommandCall = { [Kind in PrivateCommandKind]: [type: Kind, data?: WorkerCommands[Kind]] }[PrivateCommandKind];
type CommandCall = NetworkCommandCall | PrivateCommandCall;
const PRIVATE_COMMANDS: Readonly<Record<PrivateCommandKind, true>> = { ack: true, clear: true, load: true, strike: true,
  quicken: true, resistance: true, pause: true, visible: true, reset: true };
const isNetworkCall = (call: CommandCall): call is NetworkCommandCall => !Object.hasOwn(PRIVATE_COMMANDS, call[0]);
function command<Kind extends CommandKind>(type: Kind, data?: CommandData[Kind]): Promise<CommandResult<Kind>>;
function command<Kind extends PrivateCommandKind>(type: Kind, data?: WorkerCommands[Kind]): Promise<unknown>;
function command(...call: CommandCall): Promise<unknown> {
  const [type, data = {}] = call;
  if (onField() && type === 'visible') { if ('value' in data && !data.value) network.send('release'); return Promise.resolve(); }
  if (onField() && isNetworkCall(call)) {
    const [type, data = {}] = call;
    if (!network.selected && ['trigger', 'drive'].includes(type)) return Promise.resolve();
    // Taking a vehicle over also makes it the construction the workshop commands refer to.
    if (call[0] === 'squad') return network.command(call[0], call[1]).then(result => { rememberConstruction(result); return result; });
    return network.command(type, data);
  }
  // Before the first private trial there is no simulation to clear, pause or release.
  if (!worker) return Promise.resolve();
  const request = ++session.requestSerial;
  const response = replies.wait(request); worker.postMessage({ type, request, ...data }); return response;
}
async function requestTestTool<Act extends TestAct>(payload: Extract<TestRequest, { act: Act }>): Promise<TestResultFor<Act>> {
  const generation = session.generation, trial = view.trial === 'terrain';
  const answer = await command('test', payload);
  if (trial && view.trial === 'terrain' && generation === session.generation && payload.act === 'spawn' && 'kind' in payload && payload.kind === 'vehicle')
    view.weapon = armamentIntent({ platform: 'vehicle' });
  requestUI(); return decodeTestResultFor(payload.act, answer);
}

// The message is opened inside what the meter times: the browser makes the state of it when it is first read.
const receiveWorker = (event: MessageEvent<WorkerMessage>) => meter.run('simulation', () => {
  const { data } = event;
  if (data.type === 'ready') { replies.settle(0); return; }
  if (data.type === 'reply' && data.request !== undefined) replies.settle(data.request, 'error' in data && data.error && new Error(data.error), data);
  if (data.type === 'frame') {
    worker!.postMessage({ type: 'ack', serial: data.serial });
    if (onField() || data.generation !== session.generation) return;
    receiveFrame(data);
  }
});
interface ReceivedFrame {
  state: FieldView; events: readonly SceneEventBase[]; paused: boolean; physicsMs?: number | undefined; pace?: number | undefined;
  flight?: WorkerFrame['flight'] | undefined; slowed?: boolean | undefined;
  profile: { measured: boolean; simRatio: number | undefined };
}
function receiveFrame(data: ReceivedFrame) {
  const pauseChanged = session.paused !== data.paused;
  session.physicsMs = data.physicsMs;
  session.paused = data.paused;
  // A test of armour slows its world as a round struck at the design flies and strikes (slow-motion.ts); the field never does.
  const pace = data.pace ?? 1; session.slowed = Boolean(data.slowed);
  renderer.receive(data.state, data.events, { paused: session.paused, pace, ...(data.flight !== undefined ? { flight: data.flight } : {}), visible: !document.hidden, maxPace: onTestServer() ? network.testSpeed : 1 });
  if (session.fitPending === 'placed' && view.mode === 'test' && data.state.plates.length) {
    session.fitPending = null; renderer.camera.fit(currentTarget(true), true);
  }
  const now = performance.now();
  if (data.state.shared) clientPerformance.state(now, data.state.time, data.profile?.simRatio);
  // The pace of the world is that of its states: how much of its time each brings, and how it says the simulation keeps up.
  if (meter.on) meter.state(now, { time: data.state.time, speed: session.paused ? 0 : pace, field: Boolean(data.state.shared),
    told: data.profile.measured ? data.profile.simRatio! : null, ping: network.pingMs });
  if (data.paused || pauseChanged || now - uiUpdated > 110) {
    requestUI(); uiUpdated = now;
  }
}
// What broke is for the console: the player is told the game stopped, and how to get back to the project.
const workerFailed = (event: ErrorEvent) => {
  console.error(tr('Simulação:'), event.message);
  replies.rejectAll(new Error(tr('O jogo parou. Recarregue a página.')));
  sound.stop();
  session.paused = true; $('#loading').hidden = false; $('#loading-text').textContent = tr('O jogo parou. Recarregue a página para voltar ao seu projeto.');
};
// A video card the browser does not give back (context-loss.ts) leaves a page that draws nothing: the player is told to
// reload it, and the controls are let go. Given back after all, the game is seen again.
const CONTEXT_GONE = tr('O navegador perdeu o acesso à placa de vídeo. Recarregue a página para voltar ao jogo.');
const contextGone = () => { stopControls(); $('#loading').hidden = false; $('#loading-text').textContent = CONTEXT_GONE; };
const contextRestored = () => { if ($('#loading-text').textContent === CONTEXT_GONE) $('#loading').hidden = true; };

function startWorker() {
  if (workerBoot) return workerBoot;
  toast('Preparando o ensaio…');
  workerBoot = replies.wait(0, 45000, tr('O ensaio não terminou de carregar. Tente recarregar a página.'));
  try {
    worker = new Worker(new URL('./simulation-worker.ts', import.meta.url), { type: 'module', name: 'rust' });
    worker.onmessage = receiveWorker; worker.onerror = workerFailed;
    worker.postMessage({ type: 'visible', value: !document.hidden });
  } catch (error) { replies.settle(0, error); }
  return workerBoot;
}

let updateVersion: string | null = null, updatePending = false;
function updatePage(version: string) {
  if (updatePending || updateVersion === version) return;
  updateVersion = version;
  const url = new URL(location.href);
  // A fresh URL also prevents an automatic loop when a proxy still serves old HTML.
  if (url.searchParams.get('_impacto_build') === version) {
    toast(tr('Uma versão antiga ainda está sendo entregue. Tente recarregar quando a atualização terminar.'), true); return;
  }
  if (!keepBeforeReload()) return;
  updatePending = true; stopControls();
  const notice = document.createElement('dialog'), words = document.createElement('p');
  notice.setAttribute('aria-label', tr('Atualização do jogo')); words.setAttribute('role', 'status');
  words.textContent = tr('Atualização pronta. O jogo vai recarregar em 2 segundos.');
  notice.append(words); document.body.append(notice); notice.addEventListener('cancel', event => event.preventDefault()); notice.showModal();
  setTimeout(() => {
    if (!keepBeforeReload()) { updatePending = false; notice.close(); notice.remove(); return; }
    url.searchParams.set('_impacto_build', version); location.replace(url.href);
  }, 2000);
}
window.addEventListener('beforeunload', event => {
  if (projectWorkspace.workingError) { event.preventDefault(); event.returnValue = ''; }
});
let workshopUX: ReturnType<typeof initWorkshopUX>, squadUX: ReturnType<typeof initSquadUX>, factionUX: ReturnType<typeof initFactionUX>,
  infrastructureUX: ReturnType<typeof initInfrastructureUX>, fieldScreen: FieldScreen, testConsole: TestConsole, firstSteps: FirstObjectives,
  publication: PublicationPlacement, roadPlacement: RoadPlacement, postPlacement: PostPlacement, detailsUX: DetailEditor;
// What is being placed on the field, if anything: a works (publication-placement.ts), a road (road-placement.ts) or a post
// (post-placement.ts). Each hears the pointer and the keys the same way, and holds the view of the field and its dock meanwhile.
const placing = () => publication?.active ? publication : roadPlacement?.active ? roadPlacement : postPlacement?.active ? postPlacement : null;
// The construction of the shared field the base works on and the workshop would replace: the one in the
// player's hands or picked alone, and from the workshop the one that last was.
const serviced = () => squadUX?.focused() ?? null;
const projectWorkspace = createProjectWorkspace({ library, editor, projectVersions, workingStores, toast,
  opened: () => { clearGesture(); workshopUX?.cancelWeaponChoice(); setTool('select', { open: false }); screen.closeInspector(); },
});
const { keepProject, keepBeforeReload, openProject } = projectWorkspace;
const editorView = createEditorView({ editor, renderer, meter, keepProject, refreshUI });
const { refreshDesign, flushUI } = editorView;
const playerControls = createPlayerControls({ renderer, view, input,
  effects: { get: $, manualControl, armament, command, toast, requestUI, flies: () => flies(controlContext(view, renderer.state, seen()).actor) },
});
const { syncTrigger, syncDrive, updateBallisticHUD, explainSilence } = playerControls;
function stopControls() { return playerControls.stopControls(); }

const armourTrial = createArmourTrial({ view, renderer, input, session, command, toast });
const { quicken } = armourTrial;
const canvasControls = createCanvasControls({ editor, renderer, view, session, input,
  effects: { get detailsUX() { return detailsUX; }, armour: armourTrial, placing, seen, onField,
    stopControls, requestUI, inspectAt, sendAim, syncTrigger, explainSilence, followAim, attempt, cue: cue => sound.cue(cue), toast, reportError },
});
const { clearGesture, pointAim } = canvasControls;

function requestUI(event?: Partial<EditorEvent>) { editorView.requestUI(event); }
const forgetLost = createFieldDesigns(network, rememberConstruction);

const playContext = createPlayContext({ editor, renderer, network, session, view, input,
  ui: {
    closeDetails: () => detailsUX?.close(), closeScreens: () => { screen.close(); fieldScreen?.close(); },
    cancelWeaponChoice: () => workshopUX?.cancelWeaponChoice(), unwatch: () => squadUX?.unwatch(), frameChoice: () => squadUX?.frame(),
    placing, framePublication,
    adjustPublication: () => { if (!publication?.active) return false; publication.cancel({ adjust: true }); return true; },
    cancelRoad: () => { roadPlacement?.cancel(); postPlacement?.cancel(); }, refresh: requestUI, advise,
    showWorkshop: () => showPanel(true), enterField: () => serverMenu.open(), notice: toast, touching,
  },
  simulation: { stopControls, start: startWorker, command, pause: () => worker?.postMessage({ type: 'pause', value: true }), sendAim },
});
const { currentTarget, fitCurrent, standBoard, holdBoard, frameField, lookAt, overGround, framePlace, showPlace,
  requireAdmittedDesign, presentMode, loadWorld, setMode, toWorkshop, toField, startTrial, endTrial, reset } = playContext;

// A vehicle the player went to fabricate (the workshop's `publish`) that the stocks alone kept from it: its name and what it
// costs, of the faction it was asked of. The stocks it costs more of stand still for it over the field (faction-ui.ts
// `stockWants`) until they have it, the player fabricates another, or goes to fabricate one the stocks do not keep from it.
let fabrication: FabricationNotice | null = null;
function heldFabrication(c: UiModel) {
  const quote = c.panel.publish, faction = network.faction;
  if (c.edit && screen.surface === 'publish' && quote)
    fabrication = quote.unpaid && faction ? { factionId: faction.id, name: editor.source.name || tr('o veículo'), price: designBill(editor.blueprint) } : null;
  if (fabrication && (fabrication.factionId !== faction?.id || STOCK_IDS.every(id => fabrication!.price[id] <= faction!.stock[id] + 1e-6))) fabrication = null;
}
function refreshUI() {
  workspace.app.toggleAttribute('data-session-ready', session.ready);
  refreshDesign();
  if (view.mode === 'edit') editor.reviewManufacture();
  // A test is the page's own: the screen is told nothing of the field while one is under way.
  const aimSolution = view.mode === 'test' ? renderer.aimingSolution() : null;
  const c = screenModel({ view, editor, state: renderer.state, network: seen(), session, touch: touching(), aimSolution, fabrication,
    terrainId: view.trial === 'terrain' ? TRIAL_TERRAIN : 'flat',
    obstruction: view.mode === 'test' ? renderer.weaponObstruction(undefined, aimSolution) : null,
    modulePreview: renderer.modulePreview, sound, choice: squadUX?.choice() ?? null, shotsHeld: performance.now() < shotsHeldUntil, instant: instantFabrication(),
    vehicle: vehicleSpeed(renderer.state, squadUX?.focused() || controlContext(view, renderer.state, seen()).actorId), camera: cameraHud(),
    // The sites are those of the field's ground, in both of its tabs: in a test the ground at hand is not the field's.
    deposits: renderer.mode === 'test' && renderer.state?.shared ? depositsOf(renderer.ground) : [] });
  // The bench away from the field stands on a floor of its own; a test, on its ground. The board that stands in the
  // field is on the ground of the field, as the field itself is.
  heldFabrication(c);
  const terrain = c.edit && !renderer.site ? 'flat' : c.terrain;
  renderer.setTerrain(terrain, view.trial === 'terrain' && terrain === TRIAL_TERRAIN ? TRIAL_TERRAIN_SETTINGS : c.terrainSettings, c.weather);
  screen.render(c, view);
  detailsUX?.render();
  ui.set('#unit-control', { attr: { title: (c.panel.controlTitle || tr('Assumir o controle desta construção.')) + ' · C',
    'aria-label': c.panel.controlTitle || tr('Assumir o controle desta construção') } });
  workshopUX?.render(c); squadUX?.render(c.panel); factionUX?.render(c.panel); infrastructureUX?.render(c.panel.infrastructure); workshop.watchShelf();
  const privateTest = view.trial === 'terrain', privateReady = privateTest && renderer.state && !renderer.state.shared,
    testServer = onTestServer();
  testConsole?.render({ key: privateTest ? session.generation : network.socket,
    available: session.ready && view.mode === 'test' && Boolean(privateReady || testServer),
    trial: privateTest, testServer, stock: testServer ? network.faction?.stock : null,
    speed: testServer ? network.testSpeed : null, open: fieldScreen?.task === 'test',
    blocked: placing() ? tr('Conclua ou cancele o posicionamento.') : '',
    actors: privateReady ? renderer.state.actors.map(actor => ({ id: actor.id, name: actor.name,
      x: actor.vehicle?.x ?? actor.x, facing: actor.facing, mobile: Boolean(actor.vehicle), active: !actor.defeated })) : [],
    selectedId: privateTest ? c.selected?.actorId || c.actorId : squadUX?.focused() || network.manualActorId || null });
  fieldScreen?.render(c, c.shared ? network.faction : null);
  chatUX?.render();
  // Rendering may retire an order that is no longer available. Resolve the tutorial's choice afterwards, once.
  const choice = squadUX?.choice();
  firstSteps?.render({ active: network.enabled && !view.trial, playerId: network.playerId, touch: touching(),
    faction: network.faction, state: renderer.state, connected: network.connected,
    deposits: c.shared && renderer.ground ? depositsOf(renderer.ground) : [], panel: c.panel,
    workspace: { edit: c.edit, task: c.edit ? screen.surface : fieldScreen?.task, picked: choice?.picked ?? [],
      armed: choice?.armed, sourcePreset: editor.source.preset, projectBuilder: editor.blueprint.modules.some(module => module.kind === 'builder'),
      projectMiner: ['excavator', 'hopper'].every(kind => editor.blueprint.modules.some(module => module.kind === kind)),
      placing: Boolean(publication?.active), pointChosen: Boolean(publication?.chosen), libraryOpen: control('#library-dialog', HTMLDialogElement).open } });
  const panel = c.edit ? screen.surface : fieldScreen?.task ?? null,
    projectTitles: Readonly<Record<string, string>> = { build: tr('Adicionar equipamento'), project: tr('Revisão do projeto'),
      publish: tr('Fabricar no campo'), test: tr('Testar o projeto') };
  workspace.render({ space: view.trial ? 'trial' : c.edit ? 'project' : 'field', panel,
    title: c.edit ? projectTitles[String(panel)] ?? '' : fieldScreen?.titleText ?? '',
    inspector: screen.inspectorVisible, trial: view.trial });
  const placed = placing();
  if (placed) {
    workspace.dock.hidden = true; workspace.fieldTools.hidden = true;
    $('#touch-pad').hidden = true;
    control('#go-workshop', HTMLButtonElement).disabled = control('#go-field', HTMLButtonElement).disabled = placed.pending;
    placed.render();
  } else control('#go-workshop', HTMLButtonElement).disabled = control('#go-field', HTMLButtonElement).disabled = false;
  firstSteps?.follow();
  sound.setActive(worldShown() && !session.paused && !document.hidden);
}
// A world is on the screen: a test, or the field about the workshop that stands in it.
const worldShown = () => view.mode === 'test' || Boolean(renderer.site);

// The weapon in hand with the guns switched on to fire along with it.
function armament(): ControlArmament {
  const weapon = renderer.weapon, state = renderer.state, actorId = state?.controlledActor || 'local',
    also = state && view.linked?.size ? linkedArmament(view, state.modules.filter(m => m.actorId === actorId), weapon) : [];
  return also.length ? { ...weapon, also } : weapon;
}
// The vehicle the view goes with: the one in the player's hands, at any zoom, and on with it to where it stops once it
// is a wreck there, as the field goes on with one it took from the player's hands (squad-ux.ts `watched`). One that is
// only commanded — picked, sent somewhere — is not followed: the view stays where the player put it; nor is the design
// under a test of armour, which stands still.
function followed() {
  if (!session.ready || placing() || view.mode !== 'test' || view.trial === 'armour') return null;
  const { manual, actorId, actor } = controlContext(view, renderer.state, seen());
  return squadUX?.watched() || (!view.cameraFree && (manual || actor?.defeated) ? actorId : null);
}
function cameraTarget() {
  return squadUX?.watched() || controlContext(view, renderer.state, seen()).actorId || squadUX?.focused() || null;
}
// The vehicle the camera goes with, or would at the press of Fixar câmera: by its name, and whether it does.
function cameraHud() {
  const id = cameraTarget(), actor = id && renderer.state?.actors.find(actor => actor.id === id);
  return actor && !actor.defeated && !actor.ghost ? { name: actor.name || tr('o veículo'), locked: Boolean(followed()) } : null;
}
function toggleCamera() {
  if (followed()) squadUX.unwatch();
  else {
    const id = cameraTarget(), actor = renderer.state?.actors.find(actor => actor.id === id);
    if (!actor) return;
    squadUX.watch(id);
  }
  requestUI();
}
// Only the explicit Locate action moves the view to the selection. Selecting,
// changing a property and releasing a drag leave the player's camera untouched.
function revealWorkshopSelection() {
  if (!renderer.ready || view.mode !== 'edit' || view.buildTool !== 'select' || !screen.inspectorVisible || input.gesture || editor.before) return;
  const selected = editor.captureSelection(), ids = new Set(selected.map(part => part.id)), b = editor.blueprint,
    points = [...b.plates.filter(part => ids.has(part.id)).flatMap(plateCorners),
      ...b.modules.filter(part => ids.has(part.id)).flatMap(part => componentPolygons(part).flat()),
      ...selected.filter(part => pointOf(part.id))];
  renderer.board.camera.reveal(points);
}
function sendAim() {
  if (!manualControl()) return;
  if (onField()) network.aim(renderer.aim, armament());
  else worker?.postMessage({ type: 'aim', aim: renderer.aim, weapon: armament() });
}
// The aim as the pointer moves: the field's own page keeps to its pace (NetworkClient.aim), the test is told it every 30 ms.
function followAim() {
  const now = performance.now();
  if (onField() || now - aimSent > 30) { sendAim(); aimSent = now; }
}
// The design under a test of armour is neither driven nor fired: it is struck (`strikes`).
function manualControl() { return session.ready && !placing() && view.trial !== 'armour' && controlContext(view, renderer.state, seen()).manual; }
// The vehicle in the player's hands, whose crew he hears the field with (audio.ts, `hearing`); not the design under a
// test of armour, which is shot at.
const inHands = () => view.mode === 'test' && view.trial !== 'armour' && manualControl() ? controlContext(view, renderer.state, seen()).actorId : null;
// What a reply changed of the player's side of the field: a design to keep, the constructions
// that left it, the one in focus and, on joining another faction, the base.
function rememberConstruction(result: WithAbsentSlots<CommandResult>) {
  const focus = network.selected, gone = [result.removed ?? []].flat(), squad = network.squad;
  if (result.actor) network.designs.set(result.actor.id, result.actor);
  for (const id of gone) network.designs.delete(id);
  // The squad as last told still lists them: until the field tells it again, nobody drives or orders what left.
  if (squad && gone.length) network.squad = { ...squad, manual: squad.manual !== null && gone.includes(squad.manual) ? null : squad.manual, units: squad.units.filter(u => !gone.includes(u.id)) };
  if ('selected' in result) network.selected = result.selected;
  if (result.base) { network.base = result.base; deployFacing.value = result.base.facing; standBoard(); }
  // The construction in focus left the player's hands, or the base is another: the camera goes to the next one, or to the base.
  if (view.mode === 'test' && onField() && (result.base || result.removed && network.selected !== focus)) session.fitPending = 'controlled';
  requestUI();
}
async function publishConstruction(replace = false) {
  try {
    stopControls(); editor.commit();
    requireAdmittedDesign();
    if (!replace && editor.source.preset === 'bunker') {
      const facing = deployFacing.value;
      placeStructure({ blueprint: editor.blueprint, source: editor.source, facing }, network.base?.x);
      return;
    }
    const instant = instantFabrication(),
      result = await network.command(replace ? 'replace' : 'spawn', { blueprint: editor.source, facing: deployFacing.value,
      ...(instant && { instant: true }),
      ...(replace && { actorId: serviced() }) });
    rememberConstruction(result); fabrication = null;
    squadUX.pick(result.actor!.id); session.fitPending = network.enabled ? 'controlled' : null; await setMode('test'); requestUI();
    toast(publishedText(result, replace));
  } catch (error) { toast(errorMessage(error), true); }
}
// A structure is not made at the base: it is a works opened at a place of the field the player chooses there
// (publication-placement.ts), from the workshop, or for a structure moved, from the field (`field`, `move`). From the workshop,
// keep the field pose the player left. Without one from this field, seat, faction and base, open `PLACE_VIEW` metres about
// `at`, shifted outside the base by `PLACE_START` when necessary.
const PLACE_START = 200;
let placingAt: number | null | undefined = null;
function placeStructure(intent: PublicationBegin, at: number | undefined) {
  const quote = publicationQuote(intent), home = network.base?.x,
    remembered = !intent.field && playContext.fieldView?.field === network.faction?.objectives?.fieldId && playContext.fieldView?.player === network.playerId &&
      playContext.fieldView?.base === home && playContext.fieldView?.faction === network.faction?.id ? playContext.fieldView : null;
  if (quote.spawn.disabled) throw new Error(quote.spawn.title || quote.text);
  if (remembered) at = remembered.x;
  else if (Number.isFinite(home) && Math.abs(at! - home!) < PLACE_START) at = home! + (Math.sign(at! - home!) || intent.facing!) * PLACE_START;
  squadUX.cancelOrder(); stopControls(); setMode('test'); session.fitPending = null; playContext.cancelPlaceRequest(); screen.close(); fieldScreen.close();
  if (remembered) {
    squadUX.unwatch();
    Object.assign(renderer.camera, { x: remembered.x, y: remembered.y, zoom: remembered.zoom });
  }
  if (!publication.begin({ ...intent, x: at })) throw new Error(tr('Aguarde a resposta do campo.'));
  placingAt = at; requestUI();
  if (!remembered) queueMicrotask(framePublication);
}
// `footing` is what the footing of the place pointed at costs (publication-placement.ts): nothing until there is one.
function publicationQuote(intent: Pick<PublicationIntent, 'blueprint' | 'source'> & Partial<Pick<PublicationIntent, 'move'>>, footing?: SupplyBill) {
  const moved = intent.move ? network.faction?.units.find(unit => unit.id === intent.move) : undefined;
  return obraQuote({ price: designBill(intent.blueprint), ...(footing !== undefined ? { footing } : {}), faction: network.faction, connected: network.connected,
    admissionReason: industryReason(intent.source, network.faction),
    commanded: intent.blueprint.modules.some(module => module.kind === 'command'), moving: Boolean(intent.move),
    value: moved?.value ? billSum(moved.value, moved.supplies ?? bill()) : null, instant: instantFabrication() });
}
// The ground of the place is framed between the buttons at the top and the dock of the placement, a little under the
// middle of that band, the ghost standing over it in the middle of the view: the stocks and the squad at its sides
// leave it in sight, so they do not narrow the band. A road is chosen over a wider view (`ROAD_VIEW`), and so is a post (`POST_VIEW`).
function framePublication() {
  const placed = placing();
  if (!placed || !Number.isFinite(placingAt)) return;
  lookAt(placingAt!);
  const camera = renderer.camera, field = $('#viewport').getBoundingClientRect(),
    top = Math.max(0, $('#workspace-bar').getBoundingClientRect().bottom - field.top),
    band = Math.max(camera.height / 4, placed.dock.getBoundingClientRect().top - field.top - top);
  camera.zoom = clamp(camera.width / (placed === roadPlacement ? ROAD_VIEW : placed === postPlacement ? POST_VIEW : PLACE_VIEW), camera.minZoom, 60);
  camera.y = renderer.ground.height(placingAt!) + (top + band * .65 - camera.height / 2) / camera.zoom;
}
// Called off, the place is left as it was: from the workshop, the project is there again; asked to be adjusted from the
// field, the project is opened in the workshop.
async function returnFromPlacement(intent: PublicationIntent, adjust = false) {
  deployFacing.value = intent.facing;
  if (intent.field && adjust) {
    await toWorkshop();
    if (await openProject(intent.source)) { standBoard(); renderer.board.camera.fit(editor.blueprint, true); screen.openTask('publish'); }
  } else if (!intent.field) { setMode('edit'); if (adjust) screen.openTask('publish'); }
  requestUI();
}
async function confirmPlacement(intent: PublicationIntent) {
  requestUI();
  try {
    const instant = !intent.move && instantFabrication(),
      result = await (intent.move ? network.command('relocate', { actorId: intent.move, x: intent.x!, facing: intent.facing })
        : network.command('spawn', { blueprint: intent.source, facing: intent.facing, x: intent.x!,
          ...(instant && { instant: true }) }));
    if (result.actor) rememberConstruction(result);
    publication.finish(); requestUI();
    toast(intent.move ? tr('Mudança iniciada: um construtor em automático desmonta a estrutura e a monta no lugar novo, e o material vai para a nova obra.')
      : result.actor ? tr('Estrutura fabricada. O custo foi pago pelo estoque da sua facção.')
        : tr('Obra aberta: um construtor em automático vai até ela e a monta, e o material que falta é levado da base.'));
  } catch (error) { publication.reject(error); toast(errorMessage(error), true); requestUI(); }
}
// A structure moved (Mais ações, squad-ux.ts) is placed about where it stands, facing as it faces.
async function moveStructure(actorId: string | null) {
  try {
    const actor = renderer.state?.actors?.find(actor => actor.id === actorId), source = network.designs.get(actorId!)?.blueprint;
    if (!actor || !source) throw new Error(tr('Essa estrutura já não está no campo.'));
    placeStructure({ blueprint: compileBlueprint(source), source, facing: actor.facing === -1 ? -1 : 1, move: actorId, field: true }, actor.x);
  } catch (error) { toast(errorMessage(error), true); }
}
// A post raised from the Infraestrutura page (infrastructure-ux.ts): its place is chosen about the middle of the view, as
// a works from the field is (post-placement.ts), over a view `POST_VIEW` metres across — the ground it serves, and room
// about it —, and a builder in automatic goes there and puts it up.
const POST_VIEW = 180;
function openPost() {
  const at = renderer.camera.x, quote = postQuote({ faction: network.faction, connected: network.connected, instant: instantFabrication() });
  if (quote.refused) throw new Error(quote.refused);
  squadUX.cancelOrder(); stopControls(); setMode('test'); session.fitPending = null; playContext.cancelPlaceRequest(); screen.close(); fieldScreen.close();
  if (!postPlacement.begin({ facing: 1, x: at })) throw new Error(tr('Aguarde a resposta do campo.'));
  placingAt = at; requestUI(); queueMicrotask(framePublication);
}
async function confirmPost(intent: PostIntent) {
  requestUI();
  try {
    const instant = instantFabrication(), result = await network.command('post', { ...intent, ...(instant && { instant: true }) });
    postPlacement.finish(); requestUI();
    toast(result.post ? tr('Posto erguido. O custo foi pago pelo estoque da sua facção.')
      : tr('Obra do posto aberta: um construtor em automático vai até ela e o ergue, e o material que falta é levado da base.'));
  } catch (error) { postPlacement.reject(error); toast(errorMessage(error), true); requestUI(); }
}
// A road asked for from the Infraestrutura page, as what it is to be: its stretch is chosen about the middle of the view
// (road-placement.ts), over a view `ROAD_VIEW` metres across, and the road machines of the faction in automatic make it.
const ROAD_VIEW = 240;
function openRoad(kind: RoadIntent['kind']) {
  const at = renderer.camera.x;
  squadUX.cancelOrder(); stopControls(); setMode('test'); session.fitPending = null; screen.close(); fieldScreen.close();
  if (!roadPlacement.begin({ kind })) throw new Error(tr('Aguarde a resposta do campo.'));
  placingAt = at; requestUI(); queueMicrotask(framePublication);
}
async function confirmRoad(intent: RoadIntent) {
  requestUI();
  try {
    await network.command('road', intent);
    roadPlacement.finish(); requestUI();
    toast(intent.kind === 'asphalt' ? tr('Estrada pedida: as niveladoras em automático nivelam o trecho e as pavimentadoras o asfaltam, com material da base.')
      : tr('Estrada pedida: as niveladoras em automático vão até o trecho e o nivelam.'));
  } catch (error) { roadPlacement.reject(error); toast(errorMessage(error), true); requestUI(); }
}
// The first objectives open a model of the garage in the workshop, at its fabrication: the builder to make, or the light
// defence, whose works a builder in automatic goes to put up once its place is chosen on the field.
async function openObjectiveModel(templateId: TemplateId, said: string) {
  try {
    stopControls();
    await toWorkshop(); if (!await openProject(createStructuredTemplate(templateId))) return; standBoard();
    renderer.board.camera.fit(editor.blueprint, true); showPanel(true); screen.openTask('publish'); requestUI();
    toast(said);
  } catch (error) { toast(errorMessage(error), true); }
}
// The player has nothing on the field: show the player's base, and what stands near it; with no base, where the last one stood.
// The way into the field: a name, kept for the next visit, which goes straight in with it; or the key of a seat, from
// another device (`withKey`), which comes back to that seat under the name it had unless another is written. `reason` is
// why the field let go of the player, when it did, and `key` opens the way in by a key.
function entry(reason = '', key = false) {
  $('#entry-reason').hidden = !reason; $('#entry-reason').textContent = reason;
  control('#player-name', HTMLInputElement).value = network.name || keptName();
  control('#entry-key', HTMLDetailsElement).open = key;
  if (!control('#entry-dialog', HTMLDialogElement).open) control('#entry-dialog', HTMLDialogElement).showModal();
}
let chosenServer: ServerChoice | undefined;
const serverMenu = createServerMenu(control('#servers-dialog', HTMLDialogElement), server => {
  if (server.address.href !== chosenServer?.address.href) control('#entry-key-text', HTMLInputElement).value = '';
  chosenServer = server;
  $('#entry-server').hidden = false;
  $('#entry-server').textContent = [server.official ? tr('Oficial') : '', server.name,
    server.name === server.address.host ? '' : server.address.host].filter(Boolean).join(' · ');
  $('#entry-community').hidden = server.official;
  entry();
}, () => { void toWorkshop().then(() => screen.openTask('build')); });
function join(key = '') {
  if (network.enabled || !renderer.ready || !chosenServer) return;
  const name = control('#player-name', HTMLInputElement).value.trim() || null;
  if (!session.ready) { $('#loading-text').textContent = ENTERING; $('#loading').hidden = false; }
  control('#entry-dialog', HTMLDialogElement).close(); network.connect(name, key, new URL(serverHttpOrigin(chosenServer.address))); requestUI();
}
function withKey() {
  const key = keyOf(control('#entry-key-text', HTMLInputElement).value);
  if (!key) { entry(tr('Digite a chave de acesso.'), true); return; }
  join(key);
}
// A key the field does not know: the one typed is said wrong, and the one the browser kept was changed on another device
// or is of a field begun anew. The way in asks again.
network.onkey = (reason, typed) => entry(typed ? reason : tr('Sua chave de acesso não vale mais neste campo: entre com a chave nova ou como jogador novo.'), typed);
// A name another player goes by: the way in says so, with the name and the key as they were, for another name.
network.onname = (reason, typed) => entry(reason, typed);
// The loading screen waits for the first connection result. The workshop is only drawn when chosen.
const ENTERING = tr('Entrando no campo…');
function arrived() { if ($('#loading-text').textContent === ENTERING && network.phase !== 'connecting') $('#loading').hidden = true; }
network.onframe = (packet, recovered = false) => {
  if (!onField()) return;
  // The squad says which vehicle is in the player's hands, if any; the selected one stays the construction in focus.
  const squad = network.squad?.units.length ? network.squad : null, manual = squad ? squad.manual : network.selected,
    controlled = packet.state.actors.find(a => a.id === manual), focus = controlled || packet.state.actors.find(a => a.id === network.selected);
  const state = { ...packet.state, squad, faction: network.faction, controlledActor: manual, localPlayerId: network.playerId };
  forgetLost(state.actors);
  // Of how the server keeps up, a frame says the pace of its world, when it was measured: the meter of the frames reads it.
  receiveFrame({ ...packet, state, paused: false, profile: { measured: state.pace !== undefined, simRatio: state.pace } });
  // A recovered baseline leaves the obsolete reserve behind, as returning to the tab does.
  if (recovered) {
    sound.stop({ keepAlerts: true });
    renderer.playback.rest(performance.now(), dt => renderer.advanceEffects(dt));
  }
  playContext.showRequestedPlace();
  if (session.fitPending === 'controlled' && focus) { framePlace(focus.vehicle?.x ?? focus.x); renderer.aim = { x: focus.x + Number(focus.facing) * 12, y: renderer.ground.height(focus.x) + 2.42 }; session.fitPending = null; sendAim(); }
  else if (session.fitPending === 'controlled' && !network.selected) { frameField(state); session.fitPending = null; }
  // receiveFrame paces the readings; squad, faction and connection changes refresh them immediately.
};
network.onstatus = () => { if (!network.connected) stopControls(); arrived(); requestUI(); };
network.onoutdated = () => network.checkUpdates?.();
network.onsquad = () => requestUI();
network.ontestsettings = () => requestUI();
// The faction is told again whenever anything of it changes. When its base is another — established at the word of a
// member — the workshop faces the way the new base does, and the board moves there; with none, the board goes back to the bench.
let facedBase: number | null = null;
network.onfaction = () => {
  const base = network.base;
  if (base && facedBase !== null && base.x !== facedBase) deployFacing.value = base.facing;
  if (base) facedBase = base.x;
  if (renderer.site && base?.x !== playContext.boardHome) standBoard();
  requestUI();
};
network.onerror = message => toast(message, true);
// The conversation of the field is told on its own, to its box in a corner of the field (chat-ux.ts).
let chatUX: ReturnType<typeof initChat> | null = null;
network.onchat = message => chatUX?.receive(message);
network.onwelcome = async welcome => {
  arrived();
  if (chosenServer) rememberServer(chosenServer.address);
  if (!welcome.reconnected) encounterBands.clear();
  try {
    // A test under way goes on: the field is there when the player leaves it.
    if (view.trial) { requestUI(); return; }
    // A restored session keeps the view, camera and workshop the player had when the connection fell.
    if (welcome.reconnected) { requestUI(); toast(tr('Conexão restabelecida.')); return; }
    if (welcome.base) deployFacing.value = welcome.base.facing;
    presentMode('test', { weapon: { ...view.weapon, platform: 'vehicle' },
      fit: 'controlled', selection: true });
    session.ready = true;
    requestUI(); session.fitPending = network.enabled ? 'controlled' : null;
    // Whoever comes into the field finds nothing picked, a new player as one coming back: the vehicle to command is
    // chosen there.
    squadUX.clearSelection();
    // What to do first is the first objectives' to say; on coming in, only a faction without a base is told so.
    if (!welcome.base) toast(tr('Você entrou no campo. Sua facção está sem base: estabeleça outra no painel.'));
  } catch (error) { toast(errorMessage(error), true); await setMode('edit'); }
};
// A lost connection, update or account taken to another device stays in context. The connection card offers its recovery.

function setTool(value: UiView['buildTool'], { open = true } = {}) {
  if (view.mode !== 'edit') return;
  detailsUX?.close();
  renderer.canvas.style.cursor = '';
  if (value === 'module' && view.placement.kind === 'ammo') {
    view.placement.ammoPreset = suggestedAmmunition(editor.blueprint, view.placement.ammoPreset);
  }
  delete view.placement.copies;
  delete view.placement.plates; delete view.placement.anchor;
  delete view.placement.angle; delete view.placement.sizeScale; delete view.placement.mountPreset;
  view.buildTool = value; renderer.modulePreview = renderer.platePreview = null;
  if (open) screen.openTask(value === 'select' ? 'adjust' : 'build');
  requestUI();
}

// What keeps a gun from firing, as the core tells it (`weapon-blocked`).
const BLOCKED = Object.freeze({ obstruction: tr('Cano obstruído'), 'own-vehicle': tr('O próprio veículo está na linha de tiro') });
// Until when the faction is told its guns wait for its rounds in the air to come down (`budget`): a little longer than
// the core goes between saying so of a gun.
let shotsHeldUntil = 0;
function tellBlocked(events: readonly SceneEventBase[]) {
  // A vehicle standing over a wreck holds its fire, as does one of a faction with as many rounds in the air as the field
  // lets it; only the one in the player's hands says so.
  const mine = renderer.state?.controlledActor || 'local',
    obstructed = events.find(e => e.type === 'weapon-blocked' && (!['overlap', 'budget'].includes(e.reason!) || e.actorId === mine));
  if (obstructed) toast(obstructed.reason === 'overlap' ? tr('Veículo sobre destroços: saia de cima para atirar.')
    : obstructed.reason === 'budget' ? tr`Limite de ${SHOT_BUDGET.faction} tiros no ar da facção: a arma dispara quando abrir vaga.`
    : ((obstructed.reason === 'obstruction' || obstructed.reason === 'own-vehicle' ? BLOCKED[obstructed.reason] : undefined) || obstructed.reason) + tr(': ajuste a mira ou mude a arma de lugar.'));
  if (events.some(e => e.type === 'weapon-blocked' && e.reason === 'budget')) {
    const now = performance.now(), before = shotsHeldUntil;
    shotsHeldUntil = now + 1500;
    if (before <= now) requestUI();
  }
}

// The piece pressed is the one the last frame drew under the pointer, where it drew it (editor.ts `pickShownPiece`). What
// the skin of a hull of another side covers is not there to be looked into.
function inspectAt(point: Point) {
  const scene = renderer.state && renderer.scene;
  editor.selection = scene ? pickShownPiece(scene, point, renderer.covered) : null;
}

function undo() {
  if (view.mode !== 'edit') return;
  const selected = [...editor.selectionIds]; if (editor.undo()) editor.select(selected);
}
function redo() {
  if (view.mode !== 'edit') return;
  const selected = [...editor.selectionIds]; if (editor.redo()) editor.select(selected);
}
// Symmetric editing on or off (symmetry.ts): it changes how the frame is edited, not the project.
function toggleSymmetric() {
  editor.symmetric = !editor.symmetric;
  toast(editor.symmetric ? tr('Edição simétrica: o outro lado do eixo acompanha.') : tr('Edição simétrica desligada.')); requestUI();
}
function duplicate() { workshopUX?.duplicate(); }
// The help says how to play, and the address that brings someone else into the field.
async function showHelp() {
  control('#help-dialog', HTMLDialogElement).showModal();
  const list = $('#network-addresses'), link = (address: string) => { const a = document.createElement('a'); a.href = a.textContent = address; a.target = '_blank'; a.rel = 'noopener'; return a; };
  list.replaceChildren(link(location.origin + '/'));
  try {
    const data: unknown = await fetch('/api/network').then(r => { if (!r.ok) throw new Error(); return r.json(); });
    if (record(data) && Array.isArray(data.addresses) && data.addresses.every((address: unknown): address is string => typeof address === 'string') && data.addresses.length)
      list.replaceChildren(...data.addresses.map(link));
  } catch {}
}

for (const [ids, action] of Object.entries({
  'go-workshop connection-workshop': toWorkshop, 'go-field': toField, 'trial-armour': () => startTrial('armour').catch((error: unknown) => toast(errorMessage(error), true)),
  'trial-terrain': () => startTrial('terrain').catch((error: unknown) => toast(errorMessage(error), true)), reset,
  'workshop-connect': toField,
  'workshop-placement-cancel': () => { setTool('select'); if (editor.selection) screen.openTask('adjust'); },
  undo, redo, symmetric: toggleSymmetric,
  'snap-grid': () => { editor.snap = !editor.snap; toast(editor.snap ? tr('Grade de 5 cm ligada. O apoio em chapas continua automático.') : tr('Grade desligada. Movimento livre com apoio em chapas próximas.')); requestUI(); },
  'focus-selection': revealWorkshopSelection,
  'add-plate': () => setTool('plate'),
  exterior: () => { view.exterior = !view.exterior; requestUI(); },
  // Inspecting, the line under the field tells the piece picked, or how to pick one.
  inspect: () => { view.testTool = view.testTool === 'inspect' ? 'fire' : 'inspect'; requestUI(); },
  'publish-industry': () => factionUX.openIndustry(),
  'publish-new': () => publishConstruction(), 'publish-replace': () => publishConstruction(true), 'publish-models': () => workshop.openLibrary('templates'),
  'unit-control': () => squadUX.take(),
  'camera-lock': toggleCamera,
  help: showHelp, 'close-help': () => control('#help-dialog', HTMLDialogElement).close(), 'network-join': () => join(), 'entry-key-join': withKey,
  'connection-retry': () => network.retryNow(),
  'connection-servers': () => { if (network.cancelEntry()) serverMenu.open(); },
  'connection-reload': () => { if (keepBeforeReload()) location.reload(); },
  'entry-workshop': async () => { await toWorkshop(); control('#entry-dialog', HTMLDialogElement).close(); screen.openTask('build'); },
  'entry-servers': () => { control('#entry-dialog', HTMLDialogElement).close(); serverMenu.open(); },
  import: () => { clearLibraryImportError(); control('#file-input', HTMLInputElement).click(); },
  'sound-toggle': () => { sound.setEnabled(!sound.enabled); if (sound.enabled) sound.unlock(); },
  'music-toggle': () => { sound.setMusic(!sound.musicOn); if (sound.enabled) sound.unlock(); },
  'background-alerts-toggle': () => { sound.setBackgroundAlerts(!sound.backgroundAlerts); if (sound.enabled && sound.backgroundAlerts) sound.unlock(); },
  'settings-menu': () => settingsPanel($('#settings-panel').hidden),
})) click(ids, action);
// The settings are a block under the gear, open while they are being changed: a press elsewhere puts it away, and so
// does choosing one of its actions (the full screen, the help).
function settingsPanel(open: boolean | 'until-found') {
  $('#settings-panel').hidden = !open; $('#settings-menu').setAttribute('aria-expanded', String(open));
}
document.addEventListener('pointerdown', event => { if (!(event.target instanceof Element) || !event.target.closest('#settings-panel, #settings-menu')) settingsPanel(false); }, true);
$('#settings-panel').addEventListener('click', event => { if (event.target instanceof Element && event.target.closest('.settings-actions button')) settingsPanel(false); });
installSettingsKeys({ view, get: $, settingsPanel });
for (const button of $$('[data-component]')) button.onclick = () => {
  const kind = button.dataset.component; if (!moduleKind(kind)) throw new TypeError('Tipo de componente inválido: ' + kind);
  view.placement.kind = kind; setTool('module');
};
for (const descriptor of PLACEMENT_FIELDS) control('#' + descriptor.id, HTMLSelectElement).onchange = () => {
  const value = control('#' + descriptor.id, HTMLSelectElement).value;
  if (descriptor.key === 'sensorMode') {
    if (value !== 'visual' && value !== 'radar' && value !== 'sound') throw new TypeError('Detecção inválida: ' + value);
    view.placement.sensorMode = value;
    for (const copy of view.placement.copies || []) if (copy.component.kind === 'sensor' && Object.hasOwn(copy.component, descriptor.key)) copy.component.sensorMode = value;
  } else {
    // A box may be of the rounds of a gun made over (workshop-ux.ts `feedGun`); a gun to place is one of the catalogue.
    const preset = descriptor.key === 'ammoPreset' ? isCartridgeId(value) && value : isWeaponPresetId(value) && value;
    if (!preset) throw new TypeError('Arma inválida: ' + value);
    view.placement[descriptor.key] = preset;
    for (const copy of view.placement.copies || []) if (Object.hasOwn(copy.component, descriptor.key)) {
      if (descriptor.key === 'weaponPreset' && copy.component.kind === 'weapon') copy.component.weaponPreset = preset;
      else if (descriptor.key === 'ammoPreset' && copy.component.kind === 'ammo') copy.component.ammoPreset = preset;
    }
  }
  if (descriptor.key === 'weaponPreset') delete view.placement.mountPreset;
  requestUI();
};
control('#workshop-repeat', HTMLInputElement).onchange = () => { view.repeatPlacement = control('#workshop-repeat', HTMLInputElement).checked; requestUI(); };
$('.sidebar').addEventListener('click', event => {
  const button = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-workshop-review]') : null;
  if (!button) return;
  const id = button.dataset.workshopReview!, modules = editor.blueprint.modules, piece = workshopReviewPart(editor.blueprint, id, editor.manufactureIssues);
  if (button.dataset.target === 'adjust' && piece) {
    view.buildTool = 'select'; renderer.modulePreview = null; editor.select(piece); screen.openTask('adjust');
  } else if (id === 'armament' && !modules.some(module => module.kind === 'weapon')) workshop.openArsenal();
  else {
    const kinds: Readonly<Record<string, ModuleKind>> = { command: 'command', vision: 'sensor', engine: 'engine', 'running-gear': 'track', fuel: 'fuel', armament: 'ammo' }, kind = kinds[id!];
    if (!kind) return;
    if (id === 'vision') view.placement.sensorMode = 'visual';
    view.placement.kind = kind; setTool(kind === 'track' ? 'track' : 'module');
  }
  requestUI();
});
// Other projects changed in another tab: merge the garage before the next confirmed edit writes this project.
window.addEventListener('storage', event => { if (event.key === LIBRARY_KEY) { try { library.sync(); if (control('#library-dialog', HTMLDialogElement).open) workshop.refreshLibrary(); requestUI(); }
  catch (error) { toast(errorMessage(error), true); } } });
control('#body-paint', HTMLInputElement).onchange = () => { if (view.mode !== 'edit') return; editor.change(b => { b.appearance = { ...b.appearance, paint: control('#body-paint', HTMLInputElement).value }; }); };
// Each gun keeps the round, arc and charge it was last given: taking another one in hand brings its own back.
// A gun switched on to fire with the one in hand is given what it fires with: of the same model, what that one has.
const remember = () => {
  const weapon = renderer.weapon; if (weapon.platform !== 'vehicle' || !weapon.componentId) return;
  view.loadouts[pieceKey(weapon.componentId)] = loadout(weapon);
  for (const gun of armament().also || []) view.loadouts[pieceKey(gun.componentId)] = {
    trajectory: gun.trajectory, detonation: gun.detonation, charge: gun.charge };
};
function changeWeapon(patch: Partial<ArmamentIntent>) {
  input.pointerFire = input.keyFire = false; syncTrigger({ cancel: true });
  remember();
  view.weapon = armamentIntent({ ...view.weapon, ...(patch.componentId ? view.loadouts[pieceKey(patch.componentId)] : null), ...patch });
  remember(); requestUI(); sendAim();
}
$('#linked-weapons').onclick = event => {
  const id = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-weapon]')?.dataset.weapon : undefined;
  if (!id || id === renderer.weapon.componentId) return;
  const key = pieceKey(id); if (!view.linked.delete(key)) view.linked.add(key);
  requestUI(); sendAim(); if (input.pointerFire || input.keyFire) syncTrigger();
};
control('#propellant-charge', HTMLSelectElement).onchange = () => { const value = control('#propellant-charge', HTMLSelectElement).value; changeWeapon({ charge: value === 'auto' ? 'auto' : Number(value) }); };
control('#mounted-weapon', HTMLSelectElement).onchange = () => changeWeapon({ componentId: control('#mounted-weapon', HTMLSelectElement).value });
control('#detonation', HTMLSelectElement).onchange = () => {
  const detonation = control('#detonation', HTMLSelectElement).value;
  if (detonation !== 'impact' && detonation !== 'airburst') throw new TypeError('Detonação inválida: ' + detonation);
  changeWeapon({ detonation });
};
for (const button of $$('[data-ammo]')) button.onclick = () => {
  const ammo = allowedAmmo(renderer.weapon.preset).find(id => id === button.dataset.ammo);
  if (renderer.weapon.platform !== 'vehicle' && ammo !== undefined) changeWeapon({ ammo });
};
// How far from its gun the round of the test of armour strikes: it says how fast the round comes (armour-strike.ts `arrival`).
control('#test-distance', HTMLSelectElement).onchange = () => { session.testDistance = Number(control('#test-distance', HTMLSelectElement).value); requestUI(); };
// A press on the overview takes the camera to that place of the field, the ground a quarter of the way up the view.
const overview = new Overview($('#overview')), scout = (event: PointerEvent) => {
  if (overview.lo == null) return;
  const camera = renderer.camera; camera.follow(null);
  squadUX?.unwatch();
  camera.x = overview.worldX(event.clientX); camera.y = overGround(camera.x);
};
$('#overview').addEventListener('pointerdown', event => { if (event.button !== 0) return; overview.held = true; scout(event); $('#overview').setPointerCapture(event.pointerId); });
$('#overview').addEventListener('pointermove', event => { if (overview.held) scout(event); });
for (const type of ['pointerup', 'pointercancel']) $('#overview').addEventListener(type, () => { overview.held = false; });
const trigger = $('#touch-fire');
if (trigger) playerControls.installTrigger(trigger);
// What the keys A, S and D do, a finger does on the buttons beside that trigger, for as long as it is on them.
for (const pedal of $$('#touch-pad [data-drive]')) {
  const key = pedal.dataset.drive!, off = () => { if (input.driveKeys.delete(key)) syncDrive(); };
  pedal.addEventListener('pointerdown', event => { event.preventDefault(); pedal.setPointerCapture(event.pointerId); if (!input.driveKeys.has(key)) { input.driveKeys.add(key); syncDrive(); } });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) pedal.addEventListener(type, off);
}
// And a vehicle that flies, the stick in their place.
initStick($('#touch-stick'), stick => { input.stick = stick; syncDrive(); });
control('#effects-quality', HTMLSelectElement).addEventListener('change', () => renderer.effects.setQuality(control('#effects-quality', HTMLSelectElement).value));
$('#frame-meter-toggle').onclick = cycleMeter;
control('#language', HTMLSelectElement).value = preferredLanguage();
control('#language', HTMLSelectElement).onchange = () => {
  const field = control('#language', HTMLSelectElement);
  if (!keepBeforeReload()) { field.value = preferredLanguage(); return; }
  const value = field.value;
  if (!isLanguagePreference(value)) throw new TypeError('Idioma inválido: ' + value);
  stopControls(); location.replace(languageURL(value, { url: location.href }));
};
control('#frame-limit', HTMLSelectElement).onchange = () => {
  frameLimit = control('#frame-limit', HTMLSelectElement).value === '60' ? 60 : 0;
  frameBudget.setLimit(frameLimit); frameBudget.reset(performance.now()); meter.rest();
  try { localStorage.setItem('impacto.frame-limit', String(frameLimit)); } catch {}
};
control('#screen-shake', HTMLSelectElement).onchange = () => {
  renderer.screenShake.setLevel(control('#screen-shake', HTMLSelectElement).value);
  try { localStorage.setItem('impacto.screen-shake', renderer.screenShake.level); } catch {}
};
// Panels are temporary tools of the current workspace, not a persistent column.
function showPanel(shown: boolean) {
  if (!shown) { screen.close(); fieldScreen?.close(); }
  requestUI();
}
keepDisclosures();
let workshopResize: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('resize', () => {
  clearTimeout(workshopResize);
  workshopResize = setTimeout(() => {
    if (view.mode === 'edit' && renderer.ready && !document.activeElement?.matches('input,select,textarea'))
      renderer.board.camera.fit(editor.blueprint, true);
  }, 120);
});
// The whole page goes to the full screen, its dialogs and notices with it. A phone plays lying down: the full screen
// holds it so, where the browser lets it.
async function fill() {
  await document.documentElement.requestFullscreen();
  const orientation = window.screen.orientation;
  if (touching() && canLockOrientation(orientation)) await orientation.lock('landscape').catch(() => {});
}
$('#fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) { await document.exitFullscreen(); return; }
    await fill();
  } catch { toast(tr('Tela cheia indisponível neste navegador.')); }
};
// Only suggest actions the browser offers: rotate a portrait phone, or enter
// fullscreen when supported. A dismissed notice stays quiet for this visit.
const upright = matchMedia('(orientation: portrait)'), launched = matchMedia('(display-mode: fullscreen), (display-mode: standalone)');
function advise() {
  const full = Boolean(document.fullscreenElement) || launched.matches || ('standalone' in navigator && navigator.standalone === true),
    text = view.mode === 'edit' || !touching() || sessionStorage.getItem('impacto.screen-advice') === 'off' ? '' :
      document.fullscreenEnabled ? full ? upright.matches ? tr('Deite o celular: o jogo é feito para a tela deitada.') : '' :
        upright.matches ? tr('Deite o celular e use a tela cheia: o jogo é feito para a tela deitada.') : tr('Use a tela cheia para ver mais do campo.') :
      upright.matches ? tr('Deite o celular: o jogo é feito para a tela deitada.') : '';
  $('#screen-advice').hidden = !text; $('#screen-advice-text').textContent = text;
  $('#screen-advice-fill').hidden = !document.fullscreenEnabled || full;
}
$('#screen-advice-fill').onclick = () => fill().catch(() => toast(tr('Tela cheia indisponível neste navegador.')));
$('#screen-advice-close').onclick = () => { sessionStorage.setItem('impacto.screen-advice', 'off'); advise(); };
for (const watched of [upright, launched]) watched.addEventListener('change', advise);
document.addEventListener('fullscreenchange', advise);
control('#player-name', HTMLInputElement).addEventListener('keydown', event => { if (event.key === 'Enter') join(); });
control('#entry-dialog', HTMLDialogElement).addEventListener('cancel', event => {
  if (!session.ready) { event.preventDefault(); $('#entry-workshop').click(); }
});
control('#entry-key-text', HTMLInputElement).addEventListener('keydown', event => { if (event.key === 'Enter') withKey(); });
// A copy of the design of the construction in focus opens in the workshop (Mais ações, squad-ux.ts).
async function editCopy() {
  try { stopControls(); const result = await network.command('blueprint', { actorId: serviced() }); rememberConstruction(result); workshopDraft(result.actor.blueprint); await setMode('edit'); if (!await openProject(result.actor.blueprint)) return; renderer.board.camera.fit(editor.blueprint, Boolean(renderer.site)); toast(tr('Cópia aberta na Oficina.')); } catch (error) { toast(errorMessage(error), true); }
}
// The way the construction is to face on the field: the workshop still shows it with its front to the right.
for (const button of $$('#deploy-facing button')) button.onclick = () => { deployFacing.value = Number(button.dataset.facing); };
control('#help-dialog', HTMLDialogElement).addEventListener('click', event => { const dialog = control('#help-dialog', HTMLDialogElement); if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) dialog.close(); } });
function clearLibraryImportError() {
  const message = $('#library-import-error'); message.hidden = true; message.textContent = '';
}
control('#library-dialog', HTMLDialogElement).addEventListener('close', clearLibraryImportError);
control('#file-input', HTMLInputElement).addEventListener('change', async () => {
  clearLibraryImportError();
  const file = control('#file-input', HTMLInputElement).files?.[0]; if (!file) return;
  let text = '';
  try {
    if (file.size > 512000) throw new Error(tr('O arquivo é grande demais.')); text = await file.text(); const blueprint = workshopDraft(parseBlueprint(text));
    await toWorkshop(); if (!await openProject(blueprint)) return;
    control('#library-dialog', HTMLDialogElement).close(); renderer.board.camera.fit(editor.blueprint, Boolean(renderer.site)); toast(tr('Projeto importado.'));
  } catch (error) {
    // A file the core refuses is told what in it is wrong, and where.
    let project: unknown = null; try { project = JSON.parse(text); } catch {}
    const message = projectRefusalMessage(error, project), output = $('#library-import-error');
    if (control('#library-dialog', HTMLDialogElement).open) {
      output.textContent = message; output.hidden = false; output.scrollIntoView({ block: 'nearest' });
    } else toast(message, true);
  } finally { control('#file-input', HTMLInputElement).value = ''; }
});

sound.onChange = requestUI;
control('#sound-volume', HTMLInputElement).addEventListener('input', () => { sound.setVolume(Number(control('#sound-volume', HTMLInputElement).value) / 100); if (sound.enabled) sound.unlock(); });
document.addEventListener('pointerdown', () => { sound.unlock(); }, { passive: true });
document.addEventListener('keydown', () => { sound.unlock(); });
document.addEventListener('visibilitychange', () => {
  timeToast();
  const shown = !document.hidden;
  if (!shown) sound.setShown(false);
  sound.setActive(worldShown() && !session.paused && shown);
  if (shown) sound.setShown(true);
});
window.addEventListener('pagehide', () => sound.stop());
requestUI();

installPageKeys({ view, editor, session, renderer, input,
  effects: { get: $, all: selector => [...document.querySelectorAll<HTMLDialogElement>(selector)], cycleMeter, get testConsole() { return testConsole; }, get fieldScreen() { return fieldScreen; },
    workspace, get workshopUX() { return workshopUX; }, placing, toast, requestUI, framePublication, keepProject, redo, undo, duplicate,
    showHelp, fitCurrent, syncTrigger, syncDrive, explainSilence, quicken, stopControls, clearGesture, setTool },
});
window.addEventListener('blur', () => { input.spacePan = false; input.lookKeys.clear(); stopControls(); });
document.addEventListener('visibilitychange', () => {
  const now = performance.now();
  if (renderer.state?.shared) renderer.playback.rest(now, dt => renderer.advanceEffects(dt));
  input.lookKeys.clear(); stopControls(); frameBudget.reset(now); meter.rest(); clientPerformance.rest();
  command('visible', { value: !document.hidden }).catch(() => {});
});

function loop(now: number) {
  requestAnimationFrame(loop);
  if (!session.ready || document.hidden) { frameBudget.reset(now); meter.rest(); clientPerformance.rest(); return; }
  // Automatic draws at the browser's display cadence. The optional 60 FPS limit preserves its
  // remainder so a 165 Hz display does not round the capped mode down to 55 FPS.
  if (!frameBudget.take(now)) return;
  if (shotsHeldUntil > 0 && now >= shotsHeldUntil) { shotsHeldUntil = 0; requestUI(); }
  const holdArt = view.mode === 'edit' && Boolean(editor.before);
  flushUI(holdArt);
  // A frame of the meter is a turn that draws; the stretches of its work are marked as they end, here and in the renderer.
  meter.begin(now);
  // The held arrows pan like a drag does, by the time since the last frame.
  const seconds = Math.min(.1, (now - lookedAt) / 1000), look = lookIntent(input), reach = LOOK_SPEED * renderer.camera.width * seconds; lookedAt = now;
  if (look.x || look.y) renderer.camera.pan(-look.x * reach, look.y * reach);
  for (const key of input.lookReleased) input.lookKeys.delete(key); input.lookReleased.clear();
  // The board is the place of the workshop: the view may leave it by no more than a screen.
  if (renderer.site) holdBoard();
  meter.mark('camera');
  // The camera follows only the vehicle explicitly watched or under the player's hands.
  let presentation;
  const follow = followed(); renderer.opened = opened(); renderer.marked = squadUX?.marked() ?? null;
  // A detail in hand is drawn over the art of its surface, which is painted once without it (detail-editor.ts lift): that
  // art shows while the hand works, as the other details do.
  try { presentation = renderer.draw({ now, follow, holdArt: holdArt && !detailsUX?.enabled }); } catch (error) {
    if (network.enabled) network.send('release');
    stopControls(); sound.stop(); session.ready = false; if (!onField()) command('pause', { value: true }).catch(() => {});
    $('#loading').hidden = false; $('#loading-text').textContent = tr('O jogo parou de desenhar a tela. Recarregue a página para voltar ao seu projeto.');
    console.error(error); return;
  }
  // DOM guides use this frame's poses and camera, at the same display cadence as the game.
  const encounters = view.mode === 'test' && renderer.state?.shared ? encounterBands.sample(now / 1000) : [];
  workshopUX?.follow(); detailsUX?.follow(); squadUX?.follow(encounters); publication?.follow(); placeToast(); meter.mark('overlay');
  chatUX?.follow();
  // The flat ground of a test of armour has nothing to show from afar: Home frames it.
  overview.draw(view.mode === 'test' && view.trial !== 'armour' && presentation ? { ground: renderer.ground, camera: renderer.camera, state: presentation.state, time: presentation.time,
    shots: renderer.state!.shots, back: renderer.state!.time - presentation.time, arcs: presentation.fallenArcs, aim: renderer.aimPreview,
    deposits: renderer.state!.shared ? depositMarks(knownVeins(depositsOf(renderer.ground), renderer.state!.faction)) : [], fog: renderer.fog, encounters } : null);
  meter.mark('overview');
  sound.setMood(mood.of({ edit: view.mode === 'edit', state: renderer.state }, now / 1000));
  if (presentation) {
    sound.receive(presentation.state, presentation.events, {
      active: !session.paused && !document.hidden, time: presentation.time, listener: renderer.camera, hands: inHands(), following: follow, shots: presentation.shots });
    meter.mark('sound');
    if (presentation.events.length && view.mode === 'test') {
      tellBlocked(presentation.events);
      const parted = presentation.events.find(event => event.type === 'tow-release' && ['tension', 'endpoint'].includes(event.reason!));
      if (parted) toast(parted.reason === 'tension' ? tr('O cabo rompeu: puxe mais devagar.') : tr('O cabo se soltou.'), true);
    }
  }
  if (view.mode === 'test' && now - hudUpdated > 200) { updateBallisticHUD(); hudUpdated = now; }
  meter.mark('hud');
  const report = meter.end(now);
  if (report) showFrames(report);
  clientPerformance.frame(now, network.connected && onField() && renderer.mode === 'test' && !session.paused, frameLimit, network.socket);
}

// Tutorial buttons navigate through the same controls as ordinary play. They
// never submit completion flags or replace an automatic mining order.
function objectiveTarget(action: ObjectiveIntent) {
  const find = (selector: string) => document.querySelector<HTMLElement>(selector),
    // The construction in the column the objective names, or the first there.
    pawn = () => action.actorId && find(`#field-pawns button[data-act="unit"][data-id="${CSS.escape(action.actorId)}"]`) || find('#field-pawns button[data-act="unit"]'),
    move = () => squadUX.choice().armed === 'move' ? renderer.canvas : find('#field-dock button[data-value="move"]');
  switch (action.kind) {
    case 'pick': return pawn();
    case 'collect': return find(`.field-site-action[data-kind="vein"][data-id="${CSS.escape(action.depositId!)}"]`);
    case 'explore': return move();
    case 'moveBuilder': return squadUX.picked().includes(action.actorId!) ? move() : pawn();
    case 'control': return find('#unit-control');
    case 'release': return find('.field-release');
    case 'condition': return fieldScreen.task === 'vehicle' ? find('#unit-services') : find('.field-details');
    case 'follow': return serviced() === action.actorId ? find('#field-dock-status') : null;
    case 'project': return find('#go-workshop');
    case 'models': return view.mode !== 'edit' ? find('#go-workshop') : find('#garage');
    case 'model': return find(`#library-grid [data-template="${CSS.escape(action.templateId!)}"] .card-primary`);
    case 'publish': return find('#project-publish');
    case 'fabricate': return find('#publish-new');
    case 'prepareDefense': case 'defense': return find('#go-workshop');
    case 'placeDefense': return screen.surface === 'publish' ? find('#publish-new') : find('#project-publish');
    case 'chooseDefensePoint': return [find('#publication-status'), renderer.canvas];
    case 'confirmDefense': return [find('#publication-confirm'), find('#publication-status')];
    case 'cancelPlacement': return find('#publication-cancel');
    default: return null;
  }
}
async function objectiveAction(action: ObjectiveIntent) {
  const click = (selector: string) => {
    const target = document.querySelector<HTMLButtonElement>(selector);
    if (!target || target.disabled || target.closest('[hidden], [inert]')) throw new Error(target?.title || tr('Esse controle ainda não está disponível. Confira a orientação do objetivo.'));
    target.click();
  }, field = async (actorId: string | undefined) => {
    await toField(); fieldScreen.close();
    if (actorId && !squadUX.picked().includes(actorId)) squadUX.select([actorId]);
  }, destination = () => {
    if (squadUX.choice().armed !== 'move') click('#field-dock button[data-value="move"]');
    renderer.canvas.setAttribute('tabindex', '-1'); renderer.canvas.focus({ preventScroll: true });
  };
  try {
    switch (action.kind) {
      case 'pick': await toField(); fieldScreen.close(); break;
      case 'collect': await field(action.actorId); framePlace(action.x!); await showPlace(action.x!); break;
      case 'explore': case 'moveBuilder': await field(action.actorId); destination(); break;
      case 'control': click('#unit-control'); break;
      case 'release': await squadUX.release(); break;
      case 'condition': await field(action.actorId); fieldScreen.openTask('vehicle'); break;
      case 'follow': await toField(); fieldScreen.close(); squadUX.watch(action.actorId); break;
      case 'project': await toWorkshop(); screen.close(); break;
      case 'models': await toWorkshop(); screen.close(); workshop.openLibrary('templates'); break;
      case 'model': click(`#library-grid [data-template="${CSS.escape(action.templateId!)}"] .card-primary`); break;
      case 'publish': await toWorkshop(); screen.openTask('publish'); break;
      case 'fabricate': click('#publish-new'); break;
      case 'prepareDefense': await openObjectiveModel('construction-truck', tr('Fabrique o construtor e leve-o para fora da base.')); break;
      case 'defense': await openObjectiveModel('guard-post', tr('Use Escolher local no campo e toque num ponto de chão já visto, longe da base.')); break;
      case 'placeDefense': if (screen.surface !== 'publish') screen.openTask('publish'); else click('#publish-new'); break;
      case 'chooseDefensePoint': renderer.canvas.setAttribute('tabindex', '-1'); renderer.canvas.focus({ preventScroll: true }); break;
      case 'confirmDefense': click('#publication-confirm'); break;
      case 'cancelPlacement': publication.cancel({ adjust: true }); break;
    }
  } catch (error) { toast(errorMessage(error), true); }
  requestUI();
}

function inspectGame() {
  return { mode: view.mode, trial: view.trial, paused: session.paused, stats: renderer.state?.stats, time: renderer.state?.time,
    physicsMs: session.physicsMs, particles: renderer.effects.particles.length, blueprint: structuredClone(editor.blueprint),
    camera: { x: renderer.camera.x, y: renderer.camera.y, zoom: renderer.camera.zoom, width: renderer.camera.width, height: renderer.camera.height },
    site: renderer.site && { ...renderer.site }, squad: renderer.state?.squad || null, faction: renderer.state?.faction || null,
    actors: renderer.state?.actors?.map(a => ({ id: a.id, ownerId: a.ownerId, team: a.team, defeated: a.defeated, field: a.field,
      x: a.vehicle?.x ?? a.x, y: a.vehicle?.y ?? null })) || [] };
}
declare global {
  interface Window { impacto?: { reset: typeof reset; trial: typeof startTrial; mode: typeof setMode; save: typeof keepProject; inspect: typeof inspectGame } }
}

async function start() {
  try {
    await renderer.init(); Object.assign(clientPerformance.device, gpuInformation('gl' in renderer.app.renderer ? renderer.app.renderer.gl : undefined)); renderer.countCalls(meter.detailed);
    watchContext(renderer.canvas, { gone: contextGone, restored: contextRestored });
    publication = new PublicationPlacement({ host: $('#viewport'), renderer, compile: compileBlueprint, getQuote: publicationQuote,
      onPosition: ({ facing }) => { deployFacing.value = facing; requestUI(); }, onConfirm: confirmPlacement,
      onCancel: intent => returnFromPlacement(intent), onAdjust: intent => returnFromPlacement(intent, true) });
    roadPlacement = new RoadPlacement({ host: $('#viewport'), renderer, onConfirm: confirmRoad, onCancel: () => requestUI() });
    postPlacement = new PostPlacement({ host: $('#viewport'), renderer, compile: compileBlueprint, onConfirm: confirmPost, onCancel: () => requestUI(),
      getQuote: () => postQuote({ faction: network.faction, connected: network.connected, instant: instantFabrication() }) });
    renderer.camera.fit(editor.blueprint, true); canvasControls.install();
    detailsUX = new DetailEditor({ host: $('#viewport'), canvas: renderer.canvas, button: control('#project-details', HTMLButtonElement), view, renderer,
      editor: () => editor, closePanels: () => { screen.close(); screen.closeInspector(); setTool('select'); editor.select([]); }, changed: requestUI, toast });
    workshopUX = initWorkshopUX({ editor, renderer, view, toast, refresh: requestUI, openTask: task => screen.openTask(task), selectTool: () => setTool('select'),
      gesture: () => input.gesture,
      project: () => { showPanel(true); screen.openTask('project'); }, aim: {
      active: () => renderer.tool !== 'inspect' && manualControl(),
      at: point => { pointAim(point); followAim(); } } });
    squadUX = initSquadUX({ renderer, view, command, toast, alert: kind => sound.alert(kind), refresh: requestUI, stopControls, sendAim,
      selected: ids => {
        if (onField() && network.connected && ids.length && network.faction?.objectives && !network.faction.objectives.completed?.selectMiner)
          network.command('objectives', { action: 'select', ids: [...ids] }).then(() => requestUI(), () => {});
      },
      blocked: () => Boolean(placing()), design: id => network.designs.get(id)?.blueprint,
      actions: { copy: editCopy, relocate: () => moveStructure(serviced()), dismantle: plan => { if (plan && 'ids' in plan) return factionUX.dismantle(plan); }, abandon: () => factionUX.abandon() } });
    factionUX = initFactionUX({ network, renderer, toast, refresh: requestUI, stopControls, remember: rememberConstruction, serviced,
      leaving: id => squadUX.leaving(id), showPlace,
      openExample: async (source, test) => {
        if (await openWorkshopDesign(source) && test) await startTrial('terrain');
      } });
    infrastructureUX = initInfrastructureUX({ post: openPost, road: openRoad, toast });
    // Enter is the conversation's on the shared field, but not while a works or a road is placed.
    chatUX = initChat({ host: $('#viewport'), network, canvas: renderer.canvas, toast,
      shown: () => onField() && view.mode === 'test' && session.ready, blocked: () => Boolean(placing()),
      fieldTime: () => renderer.state?.shared ? renderer.state.time : null });
    testConsole = new TestConsole(ui, { request: requestTestTool, cameraX: () => renderer.camera.x,
      stopControls, refresh: requestUI, notify: toast });
    fieldScreen = new FieldScreen(ui, { view, testConsole, notify: toast,
      release: () => squadUX.release(), turn: () => squadUX.turn(), cancelOrder: () => squadUX.cancelOrder() });
    firstSteps = new FirstObjectives({ host: $('#viewport'), tools: $('#field-tools'), projectTools: $('#project-tools'), placementTools: workspace.nav,
      restore: $('#objectives-restore'),
      onOpen: () => { fieldScreen.close(); screen.close(); requestUI(); }, onAction: objectiveAction, resolveTarget: objectiveTarget });
    workspace.onClose = () => { view.mode === 'edit' ? screen.close() : fieldScreen.close(); requestUI(); };
    screen.onVisibility(() => requestUI()); fieldScreen.onVisibility(() => requestUI());
    refreshUI();
    document.documentElement.dataset.ready = 'true';
    // The server says, in the page it serves, when the core of the page and its own were built from different sources.
    startupNotice ||= document.querySelector<HTMLMetaElement>('meta[name="impacto-core"]')?.content || '';
    network.watchUpdates(updatePage);
    requestAnimationFrame(loop); if (startupNotice) toast(startupNotice, true);
    advise();
    // Small explicit automation interface for repeatable visual verification.
    window.impacto = { reset, trial: startTrial, mode: setMode, save: keepProject, inspect: inspectGame };
    $('#loading').hidden = true;
    serverMenu.open();
  } catch (error) { $('#loading-text').textContent = record(error) && ['WEBGL_UNAVAILABLE', 'RENDERER_UNAVAILABLE'].includes(String(error.code)) ? errorMessage(error) : tr('O jogo não carregou. Recarregue a página.'); console.error(error, record(error) ? error.cause : undefined); }
}
start();

