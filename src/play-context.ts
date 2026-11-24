import { BOARD, boardHeight, boardSite } from './workshop-site.ts';
import { TRIAL_WORLD } from './battle-rules.ts';
import { clamp } from './math.ts';
import { armamentIntent, trialHint } from './ui-model.ts';
import { weaponAngle } from './weapon-geometry.ts';
import { compileBlueprint } from './persistence.ts';
import { constructionEditMessage } from './structured-editing.ts';

import type { Editor } from './editor.ts';
import type { Point } from './math.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { DrawingScene } from './scene-drawing-contract.ts';
import type { UiView, UiSession, ArmamentIntent } from './ui-model.ts';
import type { WeaponPresetId } from './weapons.ts';
import type { TerrainId, TerrainOptions } from './terrain.ts';
import type { Camera, CameraFrame, CameraTarget } from './camera.ts';
import type { WorkshopBase, BoardSite, WorkshopGround } from './workshop-site.ts';
import type { CanvasControlInput } from './canvas-controls.ts';

export type PlayScene = Pick<DrawingScene, 'actors' | 'plates' | 'modules'> & { shared?: boolean };
export interface PlayRenderer {
  state: PlayScene | null; ground: WorkshopGround; camera: Camera; board: { camera: CameraFrame }; site: BoardSite | null; canvas: HTMLCanvasElement;
  modulePreview: object | null; platePreview: object | null; strike: object | null;
  stand(site: BoardSite | null): void; clearScene(): void; setTerrain(terrain: TerrainId, options?: TerrainOptions): void;
}
export interface PlayNetwork {
  enabled: boolean; selected?: string | null; playerId?: string | null; base?: WorkshopBase | null;
  watch?: (Point & { zoom: number }) | null;
  faction?: { id: string; objectives?: { fieldId: string }; fell?: { from: number } | null } | null;
}
export interface PlayUi {
  placing(): unknown; framePublication(): void; frameChoice(): boolean | void; unwatch(): void;
  closeDetails(): void; closeScreens(): void; refresh(): void; advise(): void; showWorkshop(): void;
  adjustPublication(): unknown; cancelRoad(): void; enterField(): void; cancelWeaponChoice(): void;
  touching(): boolean; notice(message: string, error?: boolean): void;
}
interface LoadCommand { blueprint: AuthoredConstruction; terrain: TerrainId; targets: boolean; slow: boolean; generation: number; paused: boolean }
export interface PlaySimulation {
  stopControls(): void; start(): Promise<unknown> | void; sendAim(): void; pause(): void;
  command(type: 'clear', data: { generation: number }): Promise<unknown>;
  command(type: 'load', data: LoadCommand): Promise<unknown>;
}
export interface PlayPresentationOptions {
  paused?: boolean; tool?: UiView['testTool']; sameWorld?: boolean; weapon?: ArmamentIntent; aim?: Point;
  fit?: UiSession['fitPending']; selection?: boolean;
}
export interface LoadWorldOptions extends PlayPresentationOptions { mode?: UiView['mode'] }
export interface PlayContextOptions {
  editor: Pick<Editor, 'blueprint' | 'source' | 'selected' | 'selection' | 'before' | 'commit'>;
  renderer: PlayRenderer; network: PlayNetwork;
  session: Pick<UiSession, 'paused' | 'slowed' | 'generation' | 'ready' | 'fitPending'>;
  view: Pick<UiView, 'mode' | 'trial' | 'testTool' | 'weapon' | 'aim' | 'buildTool' | 'placement'>;
  input: Pick<CanvasControlInput, 'gesture'>; ui: PlayUi; simulation: PlaySimulation;
}
export interface WorkshopFieldView extends Point { zoom: number; field: string; player: string; base: number | undefined; faction: string | undefined }

const TRIAL_TERRAIN = TRIAL_WORLD.terrain;
const TRIAL_TERRAIN_SETTINGS = Object.freeze({ seed: TRIAL_WORLD.seed, length: TRIAL_WORLD.mapLength, center: TRIAL_WORLD.center });
export const PLACE_VIEW = 60;

// Owns entry, exit and framing of the workshop, field and private trials. View is
// the state read by the UI and renderer; no second copy of mode or trial is kept.
// UI and simulation are the existing effect boundaries, not alternative flows.
export function createPlayContext({ editor, renderer, network, session, view, input, ui, simulation }: PlayContextOptions) {
  const onField = () => network.enabled && !view.trial;
  function currentTarget(ownOnly = false): CameraTarget {
    if (view.mode !== 'test' || !renderer.state) return editor.blueprint;
    const actorId = ownOnly ? (onField() ? network.selected : 'local') : null;
    return { ...editor.blueprint, plates: renderer.state.plates.filter(p => !actorId || p.actorId === actorId).map(p => p.definition), modules: renderer.state.modules.filter(m => !actorId || m.actorId === actorId) };
  }
  // The ground under the design of a test. The drawing board stands at zero; a terrain may put the design anywhere.
  const testFloor = () => view.mode === 'test' && renderer.state ? renderer.ground.height(BOARD.middle) : 0;
  function fitCurrent(targetOnly = false) {
    if (ui.placing()) { ui.framePublication(); return; }
    const field = view.mode === 'test' && onField();
    if (field && !renderer.state) { session.fitPending = 'controlled'; return; }
    if (field && targetOnly) { if (ui.frameChoice()) return; targetOnly = false; }
    const target = currentTarget(targetOnly);
    if (field && !target.plates.length && !target.modules.length) { frameField(renderer.state); return; }
    // The shared field has no local floor to include beside its remote constructions.
    renderer.board.camera.fit(target, targetOnly || Boolean(renderer.site) || field, field ? 0 : testFloor());
  }
  // How high the camera is held over a place for its ground to stand a quarter of the way up the view.
  const overGround = (x: number): number => renderer.ground.height(x) + renderer.camera.height / renderer.camera.zoom * .25;
  // The camera goes to a place of the field, the ground a quarter of the way up the view.
  function lookAt(x: number): void {
    const camera = renderer.camera; camera.follow(null);
    ui.unwatch();
    camera.x = x; camera.y = overGround(x);
  }
  // A place to act on is shown with some sixty metres of field around it.
  function framePlace(x: number): void {
    const camera = renderer.camera;
    camera.zoom = clamp(camera.width / PLACE_VIEW, camera.minZoom, 60);
    camera.x = x; camera.y = overGround(x);
  }
  // A place of the shared field is shown on the field: from the workshop, once the field's next frame brings its ground.
  let sought: number | null = null;
  async function showPlace(x: number): Promise<void> {
    if (view.mode !== 'test') await setMode('test');
    session.fitPending = null; sought = x;
  }
  // On the shared field the workshop is a place of the base: the board the design is made on stands there,
  // where the design would come into the field, and the field goes on about it. It is stood when the player
  // comes to the workshop and stays where it was stood. Asked again while it stands — the place asked of the
  // field is another, or the base is — it goes there with the view the player has of it. Away from the field, and on
  // the field's own tab, it is taken back to the bench. Its height follows the ground and the design it stands for
  // (`boardStood`, `holdBoard`).
  // Only the visible field pose is remembered, in this page, while its workshop stands elsewhere.
  let boardRough = false, boardHome: number | null = null, boardStood: { ground: WorkshopGround | null; blueprint: CompiledConstruction } | null = null, workshopFieldView: WorkshopFieldView | null = null;
  function standBoard() {
    const before = renderer.site, camera = renderer.camera;
    if (view.mode !== 'edit' || !network.enabled || !network.base) {
      renderer.stand(null);
      // Back on the bench the design is where its own frame has it, on flat ground.
      if (before && view.mode === 'edit') { camera.fit(editor.blueprint, true); ui.refresh(); }
      return;
    }
    // The ground and the constructions are those of the field once a frame of it is here: until then the base alone says where.
    const state = renderer.state?.shared ? renderer.state : null, ground = state && renderer.ground,
      site = boardSite(network.base, editor.blueprint, { ground, state });
    boardRough = !state; boardHome = network.base.x; boardStood = { ground, blueprint: editor.blueprint }; renderer.stand(site);
    if (before) { camera.x += site.x - before.x; camera.y += site.y - before.y; }
  }
  // The board is stood again at its height, in the same place, with the view the player has of it.
  function settleBoard() {
    const site = renderer.site; if (!site) return;
    const y = boardHeight(editor.blueprint, site.x + BOARD.middle, renderer.ground);
    boardStood = { ground: renderer.ground, blueprint: editor.blueprint };
    if (y === site.y) return;
    renderer.stand({ ...site, y }); renderer.camera.y += y - site.y;
  }
  // The view of the workshop in the field looks about the base and never away from the board: some of what
  // the field takes of a construction stays on the screen.
  function holdBoard() {
    // Until the field returns, readback is still clamped by the private test's old camera limits.
    if (boardRough) { if (!renderer.state?.shared) return; standBoard(); }
    if (!renderer.site) return;
    // The field's ground may come after the board stood: the workshop is on flat ground until it does. A design
    // turned fixed, or back, is stood where its kind is; a fixed one rests as it is made, once the edit is done.
    if (!boardStood) throw new Error('Oficina sem posição de referência.');
    const fixed = editor.blueprint.preset === 'bunker';
    if (fixed !== (boardStood.blueprint.preset === 'bunker')) standBoard();
    else if (renderer.ground !== boardStood.ground || fixed && editor.blueprint !== boardStood.blueprint && !editor.before) settleBoard();
    const camera = renderer.board.camera, wide = camera.width / camera.zoom / 2, tall = camera.height / camera.zoom / 2,
      x = clamp(camera.x, BOARD.minX - wide, BOARD.maxX + wide), y = clamp(camera.y, BOARD.minY - tall, BOARD.maxY + tall);
    if (x !== camera.x) camera.x = x;
    if (y !== camera.y) camera.y = y;
  }

  function requireAdmittedDesign() {
    try { compileBlueprint(editor.source); }
    catch (error) { throw Object.assign(new Error(constructionEditMessage(error)), error); }
  }
  function frameField(state: PlayScene | null): void {
    // A field with something to watch says where (`watch`, in the welcome): the camera goes there instead.
    if (network.watch) { const { x, y, zoom } = network.watch, camera = renderer.camera; camera.zoom = clamp(zoom, camera.minZoom, 60); camera.x = x; camera.y = y; return; }
    const base = network.base?.x ?? network.faction?.fell?.from;
    if (typeof base !== 'number' || !Number.isFinite(base) || !state) return;
    const xs = [base - 15, base + 15, ...state.actors.map(a => a.vehicle?.x ?? a.x).filter(x => Math.abs(x - base) < 150)],
      camera = renderer.camera, minX = Math.min(...xs), maxX = Math.max(...xs);
    camera.zoom = clamp(camera.width / (maxX - minX + 30), camera.minZoom, 60);
    camera.x = (minX + maxX) / 2; camera.y = overGround(camera.x);
  }
  // `sameWorld` says the world on the screen stays the one it was: between the field and the workshop that
  // stands in it, nothing of the field is made again.
  function presentMode(mode: UiView['mode'], { paused = mode === 'edit', tool = 'fire', sameWorld = false,
    weapon, aim, fit = null, selection = false }: PlayPresentationOptions = {}) {
    ui.closeDetails();
    simulation.stopControls(); editor.commit(); input.gesture = null;
    ui.closeScreens();
    view.mode = mode; view.testTool = tool; renderer.canvas.style.cursor = ''; session.paused = onField() ? false : paused; session.slowed = false;
    if (weapon) view.weapon = armamentIntent(weapon);
    if (aim) view.aim = aim;
    if (selection) editor.selection = null;
    renderer.modulePreview = renderer.platePreview = renderer.strike = null;
    if (!sameWorld) renderer.clearScene();
    standBoard();
    session.fitPending = fit;
    renderer.camera.follow(null);
    // From the workshop in the field the view opens far enough to show the base about the board. Over the terrain of
    // the field it opens until a wide screen holds some twenty kilometres: far enough to find the way from a base to
    // another, and back in on the place under the pointer.
    renderer.camera.minZoom = mode === 'edit' ? renderer.site ? 4 : 16 : onField() ? .1 : view.trial === 'terrain' ? 0 : .4;
    if (!fit) renderer.board.camera.fit(mode === 'edit' ? editor.blueprint : currentTarget(), true);
    ui.refresh();
    ui.advise();
  }
  // The page's own world: the bench of the workshop away from the field, and the tests of the design.
  async function loadWorld(options: LoadWorldOptions = {}): Promise<unknown> {
    if (onField()) return;
    simulation.stopControls(); editor.commit();
    const { mode = view.mode,
      paused = mode === view.mode ? session.paused : mode === 'edit',
      tool = view.testTool, weapon = view.weapon, ...presentation } = options;
    const generation = ++session.generation, terrain = view.trial === 'terrain' ? TRIAL_TERRAIN : 'flat';
    // The host validates and creates the world before the visible session changes.
    let response;
    try {
      // The bench draws the authored geometry without creating a physical vehicle.
      // Only a test asks the worker to admit and manufacture the design.
      if (mode !== 'edit') {
        await simulation.start();
        if (session.generation !== generation) return;
      }
      response = mode === 'edit' ? await simulation.command('clear', { generation }) :
        await simulation.command('load', { blueprint: editor.source, terrain, targets: view.trial === 'terrain', slow: view.trial === 'armour', generation, paused });
    } catch (error) { if (session.generation === generation) session.generation--; throw error; }
    if (session.generation !== generation) return response;
    // Framing and the initial aim must use this world's ground before its first worker frame arrives.
    renderer.setTerrain(terrain, view.trial === 'terrain' ? TRIAL_TERRAIN_SETTINGS : {});
    presentMode(mode, { paused, tool, weapon, ...presentation });
    // The terrain places the construction: the camera goes up or down with the ground
    // now, and frames the construction once the first frame shows where it stands. The aim a test begins with, laid
    // along the gun of the design, goes up with them.
    if (mode === 'test') {
      renderer.camera.y += renderer.ground.height(12);
      if (presentation.aim) view.aim = { ...view.aim, y: view.aim.y + renderer.ground.height(12) };
      session.fitPending ||= 'placed';
    }
    if (mode === 'test' && weapon.platform === 'vehicle') simulation.sendAim();
    return response;
  }
  // Between the workshop and the field: the same world goes on about both.
  function setMode(mode: UiView['mode']): void {
    if (!session.ready || mode === view.mode || !onField()) return;
    if (mode === 'edit') {
      const { x, y, zoom } = renderer.camera, field = network.faction?.objectives?.fieldId, player = network.playerId;
      workshopFieldView = renderer.state?.shared && field && player && Number.isFinite(x + y + zoom) && zoom > 0
        ? { x, y, zoom, field, player, base: network.base?.x, faction: network.faction?.id } : null;
    }
    presentMode(mode, { sameWorld: true, fit: mode === 'test' ? 'controlled' : null });
  }
  // Construir: the workshop, from the field or from a test.
  async function toWorkshop() {
    if (ui.adjustPublication()) return;
    ui.cancelRoad();
    if (!session.ready) { await loadWorld({ mode: 'edit' }); session.ready = true; }
    else if (view.trial) await endTrial(); else setMode('edit');
    ui.showWorkshop();
  }
  // The field, from the workshop; with no field yet, the way into it.
  async function toField() {
    if (ui.placing()) return;
    if (view.trial) await endTrial();
    if (network.enabled) setMode('test'); else ui.enterField();
  }
  // The two tests of the design, the player's alone: its armour, standing on flat ground to be struck by a gun of the
  // catalogue (`preset`, or the one it was last struck with) from wherever the player draws a line, and the design on
  // the ground of the game, driven and fired with the guns it has — from the one picked, if one is. The field goes on
  // meanwhile, and leaving the test goes back to the workshop. The test of armour keeps its gun from one test to the
  // next; the field, the gun in hand.
  let armourWeapon = view.weapon, fieldWeapon = view.weapon;
  async function startTrial(kind: 'armour' | 'terrain', preset: WeaponPresetId | null = null): Promise<void> {
    if (!session.ready) throw new Error('O jogo ainda está carregando. Aguarde um instante.');
    editor.commit(); requireAdmittedDesign();
    ui.cancelWeaponChoice();
    view.buildTool = 'select'; delete view.placement?.copies; delete view.placement?.plates; delete view.placement?.anchor;
    renderer.modulePreview = renderer.platePreview = null;
    if (view.trial === 'armour') armourWeapon = view.weapon; else if (!view.trial) fieldWeapon = view.weapon;
    let weapon: ArmamentIntent, aim: Point | undefined;
    if (kind === 'armour') weapon = armamentIntent(preset ? { preset, platform: 'ground' } : armourWeapon);
    else {
      const selected = editor.selected, gun = selected && 'kind' in selected && selected.kind === 'weapon' ? selected : editor.blueprint.modules.find(m => m.kind === 'weapon');
      weapon = armamentIntent({ platform: 'vehicle', ...(gun && { componentId: gun.id }) });
      if (gun) { const rest = weaponAngle(gun); aim = { x: gun.x + Math.cos(rest) * 20, y: gun.y + Math.sin(rest) * 20 }; }
    }
    simulation.stopControls();
    const before = view.trial, generation = session.generation; view.trial = kind;
    try {
      await loadWorld({ mode: 'test', paused: false, tool: 'fire', weapon, ...(aim && { aim }) });
      if (view.trial !== kind || session.generation !== generation + 1) return;
    }
    // loadWorld rolls back only its current failed generation. An older failure
    // must not restore its previous mode over a newer transition.
    catch (error) { if (session.generation === generation) view.trial = before; throw error; }
    ui.notice(trialHint({ kind, touch: ui.touching(), fires: Boolean(weapon.componentId),
      flies: editor.blueprint.modules.some(module => module.kind === 'thruster') }));
  }
  async function endTrial() {
    simulation.stopControls();
    const before = view.trial, generation = session.generation;
    if (view.trial === 'armour') armourWeapon = view.weapon;
    // The private test has let go of its controls before commands route to the field again.
    if (network.enabled) view.mode = 'edit';
    view.trial = null;
    if (!network.enabled) {
      try { await loadWorld({ mode: 'edit', paused: true, weapon: fieldWeapon }); }
      catch (error) { if (session.generation === generation) view.trial = before; throw error; }
    } else {
      // On the field the workshop stands at the base again, and the page's own world rests.
      ++session.generation; simulation.pause();
      presentMode('edit', { weapon: fieldWeapon });
    }
  }
  // Restaurar: the test begins again, with the design whole.
  async function reset() {
    if (!session.ready || !view.trial) return;
    try { await loadWorld(); } catch (error) {
      if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') throw error;
      ui.notice(error.message, true);
    }
  }


  return { currentTarget, fitCurrent, standBoard, holdBoard, frameField, lookAt, overGround, framePlace, showPlace,
    requireAdmittedDesign, presentMode, loadWorld, setMode, toWorkshop, toField, startTrial, endTrial, reset,
    get boardHome() { return boardHome; }, get fieldView() { return workshopFieldView; },
    cancelPlaceRequest() { sought = null; },
    showRequestedPlace() { if (sought != null && view.mode === 'test') { lookAt(sought); sought = null; } },
  };
}
