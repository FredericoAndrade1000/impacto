import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor, pickPiece } from '../src/editor.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { controlContext, screenContext, screenModel, trialHint, trialOpened } from '../src/ui-model.ts';
import { designFrame, regionContains } from '../src/scene-frame.ts';
import { blueprintPowertrain, installedPower } from '../src/mass-properties.ts';
import { pieceCost, formatCredits } from '../src/construction-cost.ts';
import { MODULES } from '../src/materials.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { WEAPON_PRESETS } from '../src/weapons.ts';
import { managedWorld } from './mechanical-queries.js';
import { power } from '../src/format.ts';
import { CELL } from '../src/grid.ts';
import { TRIAL_WORLD } from '../src/battle-rules.ts';

await initNativeDynamics();

test('audio settings expose the saved background-alert choice independently of global mute', () => {
  const editor = new Editor(createConstruction('scout')), blueprint = editor.blueprint,
    sound = { enabled: true, musicOn: true, volume: .35, backgroundAlerts: true },
    view = { mode: 'edit', buildTool: 'select', testTool: 'fire', weapon: { preset: 'rh120' }, placement: { kind: 'engine' } },
    model = () => screenModel({ view, editor, network: { enabled: false, connected: false, designs: new Map() },
      state: null, session: { paused: true }, terrainId: 'flat', sound }).bindings;
  assert.equal(model()['background-alerts-toggle'].attr['aria-pressed'], true);
  assert.equal(model()['background-alerts-state'].text, 'Ligados');
  sound.enabled = false;
  assert.equal(model()['background-alerts-toggle'].attr['aria-pressed'], true, 'muting does not erase the preference');
  sound.backgroundAlerts = false;
  assert.equal(model()['background-alerts-toggle'].attr['aria-pressed'], false);
  assert.equal(model()['background-alerts-state'].text, 'Desligados');
});

test('the screen preserves selection order and the inspected identity when the last intended part disappears', () => {
  const editor = new Editor(createConstruction('heavy')), blueprint = editor.blueprint,
    engine = blueprint.modules.find(part => part.kind === 'engine'), plate = blueprint.plates[0],
    view = { mode: 'edit', weapon: { preset: 'rh120' } }, network = { enabled: false };
  editor.select([engine.id, plate.id]);
  const workshop = screenContext(view, editor, null, network);
  assert.deepEqual(workshop.selection.map(part => part.id), [engine.id, plate.id]);
  assert.equal(workshop.selected, workshop.selection[1]); assert.equal(workshop.selected.definition, editor.selected);

  editor.select([plate.id, engine.id]); view.mode = 'test';
  const state = designFrame(blueprint); state.modules.find(part => part.id === engine.id).health = 0;
  const inspected = screenContext(view, editor, state, network);
  assert.deepEqual(inspected.selection.map(part => part.id), [plate.id, engine.id]);
  assert.equal(inspected.selected, inspected.selection[1]); assert.equal(inspected.selected.health.fraction, 0);
  const missing = screenContext(view, editor, { ...state, modules: state.modules.filter(part => part.id !== engine.id) }, network);
  assert.deepEqual(missing.selection.map(part => part.id), [plate.id]);
  assert.equal(missing.selected, undefined, 'a missing primary intent never silently inspects another selected part');
  assert.equal(editor.selection, engine.id, 'reading the screen preserves the editor intent');
  editor.select([]);
  const empty = screenContext(view, editor, state, network);
  assert.deepEqual(empty.selection, []); assert.equal(empty.selected, undefined);
});

test('placement prices follow the actual planned size and are shown only while installing a component', () => {
  const editor = new Editor(createConstruction('scout')),
    view = { mode: 'edit', buildTool: 'module', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground' },
      placement: { kind: 'engine', sizeScale: .5, angle: Math.PI / 9, ammoPreset: 'rh120', weaponPreset: 'rh120', sensorMode: 'visual' } },
    model = () => screenModel({ view, editor, modulePreview: preview, network: { enabled: false, connected: false, designs: new Map() },
      state: { actors: [], plates: [], modules: [], stats: {}, time: 0 }, session: { paused: true, testDistance: 0 },
      terrainId: 'flat', sound: { enabled: false, volume: .4 } });
  let preview = null;
  assert.equal(model().bindings['component-placement-cost'].text, '', 'no valid cursor plan has a price yet');
  const plan = editor.planModule('engine', { x: 12, y: 5 }, view.placement);
  assert(plan.source, plan.reason);
  preview = { modules: plan.modules, plates: plan.plates, refused: false };
  const installing = model();
  assert.deepEqual(installing.bindings['edit-controls'], { data: { installing: true } });
  assert.equal(installing.bindings['component-placement-cost'].text, formatCredits(pieceCost(plan.module)));
  assert.notEqual(pieceCost(plan.module), pieceCost({ ...MODULES.engine, kind: 'engine' }), 'a half-sized engine is not priced as the default engine');
  assert.equal(installing.placementTitle, 'Instalar motor');
  assert.equal(installing.bindings['workshop-placement-hint'].text, 'Clique para instalar. Encaixe alinha apoios próximos.');
  assert.match(installing.bindings['snap-grid'].attr.title, /apoio em chapas próximas/);
  for (const [mode, buildTool] of [['edit', 'select'], ['test', 'module'], ['test', 'select']]) {
    Object.assign(view, { mode, buildTool });
    const c = model();
    assert.equal(c.bindings['component-placement-cost'].text, '', `${mode}/${buildTool} has no installation price to show`);
    assert.deepEqual(c.bindings['edit-controls'], { data: { installing: buildTool !== 'select' } }, 'surface visibility is not a scalar binding');
  }
  Object.assign(view, { mode: 'edit', buildTool: 'module' });
  assert.equal(model().bindings['component-placement-cost'].text, installing.bindings['component-placement-cost'].text);
  editor.snap = false;
  assert.equal(model().bindings['workshop-placement-hint'].text, 'Clique para instalar.');
  assert.equal(model().bindings['snap-grid'].attr['aria-pressed'], false);
  editor.snap = true; view.placement.kind = 'weapon';
  assert.equal(model().bindings['workshop-placement-hint'].text, 'Clique para instalar.', 'weapons keep their explicit mount placement');
});

test('copy placement prices use a valid native preview and disappear when its position is refused', () => {
  const editor = new Editor(createStructuredConstruction()), engine = editor.addModule('engine', { x: 11, y: 1.6 }, { sizeScale: .5 }),
    b = editor.blueprint, view = { mode: 'edit', buildTool: 'module', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground' } };
  editor.select(engine.id); view.placement = { kind: 'engine', ...editor.duplicate() };
  let preview = null;
  const price = () => screenModel({ view, editor, modulePreview: preview,
    network: { enabled: false, connected: false, designs: new Map() }, state: { actors: [], plates: [], modules: [], stats: {}, time: 0 },
    session: { paused: true, testDistance: 0 }, terrainId: 'flat', sound: { enabled: false, volume: .4 } }).bindings['component-placement-cost'].text;
  assert.equal(price(), '');
  const plan = editor.planModule('engine', { x: 13, y: 1.6 }, view.placement);
  assert(plan.source, plan.reason); preview = { modules: plan.modules, refused: false };
  assert.equal(price(), formatCredits(pieceCost(plan.module)));
  preview = { modules: plan.modules, refused: true }; assert.equal(price(), '');
});

test('ammunition placement always shows the full calibre catalogue and preserves the explicit selection', () => {
  const editor = new Editor(createConstruction('scout')), b = editor.blueprint,
    preset = b.modules.find(part => part.kind === 'weapon').weaponPreset,
    view = { mode: 'edit', buildTool: 'module', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground' },
      placement: { kind: 'ammo', ammoPreset: preset, weaponPreset: 'rh120', sensorMode: 'visual' } },
    model = () => screenModel({ view, editor, network: { enabled: false, connected: false, designs: new Map() },
      state: { actors: [], plates: [], modules: [], stats: {}, time: 0 }, session: { paused: true, testDistance: 0 },
      terrainId: 'flat', sound: { enabled: false, volume: .4 } });
  const initial = model();
  assert.equal(initial.bindings['new-ammo-field'].hidden, false);
  assert.equal(initial.bindings['new-ammo-assist'].hidden, false);
  assert(initial.bindings['new-ammo-preset'].options.length > 1);
  view.placement.ammoPreset = 'rh120';
  const explicit = model();
  assert.equal(explicit.bindings['new-ammo-field'].hidden, false);
  assert(explicit.bindings['new-ammo-preset'].options.length > 1);
  assert.equal(explicit.bindings['new-ammo-preset'].value, 'rh120');
  assert.equal(view.placement.ammoPreset, 'rh120', 'painting never overrides a deliberate calibre choice');
  editor.replace(createConstruction('heavy'));
  assert.equal(model().bindings['new-ammo-preset'].value, 'rh120');
  assert.equal(view.placement.ammoPreset, 'rh120', 'another project cannot realign the selection');
});

test('manual commands and the screen resolve the construction in hand and the shared connection identically', () => {
  const view = { mode: 'test' }, network = { enabled: false, connected: false }, state = { actors: [{ id: 'driver' }, { id: 'local' }] };
  assert.deepEqual([controlContext(view, state, network).actorId, controlContext(view, state, network).manual], ['local', true], 'the construction of a test is in the player\'s hands');
  network.enabled = true; network.selected = 'driver'; network.manualActorId = 'driver';
  assert.equal(controlContext(view, state, network).manual, false, 'reconnecting retains selection but releases commands');
  network.connected = true; assert.equal(controlContext(view, state, network).manual, true);
  network.selected = null; assert.equal(controlContext(view, state, network).manual, false);
  view.mode = 'edit'; assert.equal(controlContext(view, state, network).manual, false);
});

test('fresh input authority gates a retained rendered squad without changing its actor or armament identity', () => {
  const view = { mode: 'test' }, actors = [{ id: 'a' }, { id: 'b' }],
    state = { actors, squad: { manual: 'a', units: [{ id: 'a' }, { id: 'b' }] } },
    network = { enabled: true, connected: true, selected: 'a', manualActorId: 'a' },
    context = () => controlContext(view, state, network);
  assert.equal(context().manual, true);
  assert.equal(controlContext(view, { ...state, actors: [] }, network).manual, false, 'fresh metadata without an admitted visual actor is not permission to send its inputs');
  network.manualActorId = null;
  assert.equal(context().manual, false, 'release metadata removes permission before the next frame');
  assert.equal(context().actorId, 'a'); assert.equal(context().actor, actors[0]);
  assert.equal(state.squad.manual, 'a', 'resolving permission does not patch the rendered frame');
  network.manualActorId = 'b'; network.selected = 'b';
  assert.equal(context().manual, false, 'old geometry/armament cannot drive the newly controlled construction');
  state.squad = { ...state.squad, manual: 'b' };
  assert.equal(context().manual, true); assert.equal(context().actor, actors[1]);
  actors[1].defeated = true; assert.equal(context().manual, false);
  actors[1].defeated = false; network.connected = false; assert.equal(context().manual, false);
  network.connected = true; network.manualActorId = null;
  assert.equal(context().manual, false, 'a retained selection cannot authorize an incomplete handshake');
  network.manualActorId = 'b'; view.mode = 'edit'; assert.equal(context().manual, false);
  view.mode = 'test'; network.enabled = false;
  assert.equal(context().actorId, 'b'); assert.equal(context().manual, true, 'the private worker keeps its own control context');
});

test('the test of armour names its gun in the panel and tells no reload, rounds nor trigger of it, and asks how far only of a round its speed matters to', t => {
  const source = createConstruction('heavy'), world = managedWorld(t, source), editor = new Editor(source), b = editor.blueprint,
    view = { mode: 'test', trial: 'armour', buildTool: 'select', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground', ammo: 'apfsds' },
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } },
    screen = weapon => screenModel({ view: { ...view, weapon }, editor, state: world.snapshot(), terrainId: 'flat', touch: true,
      network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 10 },
      sound: { enabled: false, volume: .4 } }),
    shown = (c, ids) => ids.map(id => c.bindings[id].hidden === false);
  const kinetic = screen(view.weapon);
  assert.deepEqual([kinetic.bindings['weapon-description'].hidden, kinetic.bindings['weapon-description'].text], [false, WEAPON_PRESETS.rh120.name]);
  assert.deepEqual(shown(kinetic, ['catalog-test', 'ammo-options', 'test-distance-field']), [true, true, true]);
  // A finger strikes the design itself: no pedals nor Fogo; nothing tells a reload or rounds, nor a flight or an impact to an aim.
  assert.deepEqual(shown(kinetic, ['touch-pad', 'weapon-runtime', 'impact-info', 'ballistic-info', 'propellant-charge-field', 'detonation-field']),
    [false, false, false, false, false, false]);
  assert.deepEqual([kinetic.gunTold, kinetic.fires, kinetic.bindings.viewport.data.tool], [false, true, 'fire']);
  // A shell bursts as it bursts however fast it comes: its fuze is asked, not how far, nor the charge it is fired with.
  const shell = screen({ preset: 'm777', platform: 'ground', ammo: 'he' });
  assert.equal(shell.weapon.variableCharge, true);
  assert.deepEqual(shown(shell, ['detonation-field', 'test-distance-field', 'propellant-charge-field']), [true, false, false]);
  // Set to burst in the air, it bursts where the line drawn ends, if it meets nothing first; a gun in hand bursts it
  // where it aims.
  assert.deepEqual(shell.bindings.detonation.options, [['impact', 'Ao atingir'], ['airburst', 'Explosão aérea no fim da linha']]);
  const mounted = screen({ preset: 'rh120', platform: 'vehicle', ammo: 'he' }).bindings.detonation.options;
  assert.deepEqual(mounted.at(-1), ['airburst', 'Explosão aérea no ponto de mira']);
});

test('the dock tells the speed of the vehicle in hand, and of one commanded while it goes, and has the camera button but in the test of armour', t => {
  const source = createConstruction('heavy'), world = managedWorld(t, source), editor = new Editor(source), b = editor.blueprint,
    view = { mode: 'test', trial: null, buildTool: 'select', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground' },
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } },
    screen = ({ vehicle, camera = { name: 'Pesado', locked: false }, state = world.snapshot(), ...patch }) => screenModel({ view: { ...view, ...patch }, editor, state, terrainId: 'flat', network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0 },
      sound: { enabled: false, volume: .4 }, vehicle, camera }).bindings,
    still = { speed: '0 km/h', moving: false, reverse: false }, backing = { speed: '18 km/h', moving: true, reverse: true },
    told = bindings => [bindings['field-dock-speed'].hidden, bindings['field-dock-speed'].text, bindings['field-dock-reverse'].hidden];
  // In hand, its speed is told even standing still; going backwards, it says so.
  assert.deepEqual(told(screen({ vehicle: still })), [false, '0 km/h', true]);
  assert.deepEqual(told(screen({ vehicle: backing })), [false, '18 km/h', false]);
  assert.equal(screen({ vehicle: backing })['field-dock-speed'].attr['aria-label'], 'Velocidade: 18 km/h');
  // Commanded, only while it goes: a squad with nobody in hand drives itself.
  const commanded = { ...world.snapshot(), squad: { manual: null, units: [], out: [] } };
  assert.deepEqual(told(screen({ vehicle: still, state: commanded })), [true, '', true]);
  assert.deepEqual(told(screen({ vehicle: backing, state: commanded })), [false, '18 km/h', false]);
  // Nothing to tell of: no vehicle, the workshop, the test of armour.
  assert.deepEqual(told(screen({ vehicle: null })), [true, '', true]);
  assert.deepEqual(told(screen({ vehicle: backing, mode: 'edit' })), [true, '', true]);
  assert.deepEqual(told(screen({ vehicle: backing, trial: 'armour' })), [true, '', true]);
  assert.deepEqual(told(screen({ vehicle: backing, trial: 'terrain' })), [false, '18 km/h', false], 'the strip of ground tells it as the field does');
  // The camera button: its words in its title, pressed while the camera goes with the vehicle.
  const free = screen({ vehicle: still })['camera-lock'], held = screen({ vehicle: still, camera: { name: 'Pesado', locked: true } })['camera-lock'];
  assert.deepEqual([free.hidden, free.attr['aria-pressed'], free.attr['aria-label'], free.title],
    [false, 'false', 'Fixar câmera', 'Fixar câmera · seguir Pesado sem assumir o controle']);
  assert.deepEqual([held.attr['aria-pressed'], held.attr['aria-label'], held.title], ['true', 'Soltar câmera', 'Soltar câmera · parar de seguir Pesado']);
  for (const away of [{ camera: null }, { mode: 'edit' }, { trial: 'armour' }]) assert.equal(screen({ vehicle: still, ...away })['camera-lock'].hidden, true, JSON.stringify(away));
});

test('inspection picks surviving material through the same visible order as construction', () => {
  const plate = {id:'plate',x:10,y:2,length:4,angle:0,material:'steel',thicknessMm:1000}, engine = {id:'engine',kind:'engine',x:10,y:2,angle:0,width:1.1,height:.8},
    surface = { definition: plate,
      solidRegions: [{ minX: -2, minY: -.5, maxX: -.3, maxY: .5 }, { minX: .3, minY: -.5, maxX: 2, maxY: .5 }] };
  const pick = point => pickPiece([plate], [engine], point, 0,
    part => part === plate ? regionContains(surface, point) : undefined);
  assert.equal(pickPiece([plate], [engine], engine, 0), plate.id);
  assert.equal(pick(engine), engine.id, 'a real opening exposes the component behind it');
  assert.equal(pick({ x: 11, y: 2 }), plate.id, 'surviving plate still occludes the component');
  assert.equal(pick({ x: 14, y: 2 }), null);
  assert.equal(pickPiece([plate], [], plate, 0, () => false), null, 'empty material never falls back to the old outline');
});

test('assisted artillery reports a fractional remaining angle instead of zero while it is aligning',t=>{
  const source=createConstruction('howitzer',{preset:'m119'}),world=managedWorld(t,source),editor=new Editor(source),state=world.snapshot(),
    gun=state.modules.find(part=>part.kind==='weapon');
  gun.targetBarrelAngle=gun.barrelAngle+.24*Math.PI/180;
  const view={mode:'test',trial:null,buildTool:'select',testTool:'fire',weapon:{preset:'m119',platform:'vehicle',componentId:gun.id},placement:{kind:'engine'}},
    bindings=screenModel({view,editor,state,terrainId:'flat',network:{enabled:false,connected:false,designs:new Map()},
      session:{paused:false,testDistance:0},sound:{enabled:false,volume:.4}}).bindings;
  assert.equal(bindings['weapon-runtime'].data.state,'aligning');
  assert.match(bindings['weapon-runtime'].text,/faltam 0,2°/);
});

test('shared picking follows the observed servo angle rather than an unachieved target', () => {
  const gun = compileBlueprint(createConstruction('heavy')).modules.find(m=>m.kind==='weapon'); gun.x=10;gun.y=3; gun.barrelAngle = Math.PI / 2;
  assert.equal(pickPiece([], [gun], { x: 10, y: 4.1 }, .01), gun.id);
  assert.equal(pickPiece([], [gun], { x: 8.9, y: 3 }, .01), null);
});

test('explicit plate rotation and removal are canonical atomic undo edits',()=>{
 const editor=new Editor(createStructuredConstruction({preset:'bunker',length:4,height:2,thicknessMm:20})),before=structuredClone(editor.source);
 editor.select('hull:roof');const angle=editor.selected.angle-.1;
 // Each end goes to its nearest cell: the plate turns as asked to within a cell across its length.
 editor.editProperty('angle',angle,true);assert(Math.abs(editor.selected.angle-angle)<=Math.atan2(CELL,editor.selected.length));
 assert(editor.undo());assert.deepEqual(editor.source,before);
 for(const id of ['hull:floor','hull:rear']){
  editor.select(id);editor.remove();assert.equal(editor.source.plates.length,before.plates.length-1);
  assert.equal(editor.past.length,1);assert(editor.undo());assert.deepEqual(editor.source,before);
 }
 editor.change(s=>s.name='Edited');assert(editor.undo());assert.deepEqual(editor.source,before);
});

test('the weight of the design is told against what its chassis carries, full, and is warned of near that', () => {
  const weight = source => {
    const editor = new Editor(source), b = editor.blueprint,
      view = { mode: 'edit', trial: null, buildTool: 'select', testTool: 'fire', weapon: { preset: 'rh120', platform: 'ground' },
        placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual', snap: true } },
      state = { actors: [], plates: [], modules: [], stats: { shots: 0 }, time: 0, terrain: 'hills', terrainSettings: {}, weather: 'clear' };
    return screenModel({ view, editor, state, network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0, physicsMs: 0 },
      terrainId: 'hills', particles: 0, sound: { enabled: false, volume: .4 } }).figures[0];
  };
  // The stock tank is shown against its compiled structural limit, with fuel
  // and rounds aboard; its empty mass remains a separate reading.
  const heavySource = createConstruction('heavy'), heavy = weight(heavySource),
    capacity = compileBlueprint(heavySource).chassis, tonnes = text => Number(text.replace(',', '.'));
  assert.equal(heavy.label, 'PESO'); assert.equal(heavy.over, false);
  const [, full, limit] = heavy.value.match(/^([\d,]+) \/ ([\d,]+) t$/),
    [, empty] = heavy.title.match(/^Com combustível, munição e carga cheios; vazio: ([\d,]+) t$/);
  for (const [shown, actual] of [[full, capacity.loadedKg], [limit, capacity.limitKg], [empty, capacity.emptyKg]])
    assert(Math.abs(tonnes(shown) - actual / 1000) <= .05, `${shown} t represents ${actual} kg`);
  assert(tonnes(empty) < tonnes(full) && tonnes(full) < tonnes(limit), `${empty} < ${full} < ${limit}`);
  // Near what the chassis carries the figure says nothing more: it is told only once the design is over it.
  const near = [65, 68].map(thicknessMm => createStructuredConstruction({ thicknessMm })),
    [below, above] = near.map(source => compileBlueprint(source).chassis);
  assert(below.loadedKg < .9 * below.limitKg);
  assert(above.loadedKg >= .9 * above.limitKg && above.loadedKg < above.limitKg, 'the design near its limit remains physically admitted');
  const readings = near.map(weight);
  assert.deepEqual(readings.map(figure => figure.over), [false, false]);
  assert(readings.every(figure => figure.title.startsWith('Com combustível') && !Object.hasOwn(figure, 'warn')));
  for (const [index, figure] of readings.entries()) {
    const [, shownFull, shownLimit] = figure.value.match(/^([\d,]+) \/ ([\d,]+) t$/), chassis = [below, above][index];
    for (const [shown, actual] of [[shownFull, chassis.loadedKg], [shownLimit, chassis.limitKg]])
      assert(Math.abs(tonnes(shown) - actual / 1000) <= .05, `${shown} t represents ${actual} kg`);
  }
  // Two supports give the chassis the limit for its actual centre of mass, rather than a nominal sum.
  const chassis = createStructuredTemplate('chassis'), supported = { ...chassis, chassis: { ...chassis.chassis, axles: [-35, 34] } },
    supports = compileBlueprint(supported).chassis, [, shownLimit] = weight(supported).value.match(/^[\d,]+ \/ ([\d,]+) t$/);
  assert.equal(supports.axles.length, 2); assert(supports.gearLimitKg < 2 * supports.axleKg);
  assert(Math.abs(tonnes(shownLimit) - supports.limitKg / 1000) <= .05, 'the displayed limit follows the compiler for this proposed support layout');
  // A structure of the laboratory stands on no chassis: it is told its weight alone.
  const plate = weight(createStructuredTemplate('plate'));
  assert.equal(plate.label, 'PESO'); assert.match(plate.value, /^[\d,.]+ t$/); assert.equal(plate.over, undefined);
});

test('on-screen controls follow the active input and ignore old preferences while editing and inspection still hide them', () => {
  const editor = new Editor(createConstruction('scout')), b = editor.blueprint, before = structuredClone(editor.source),
    view = { mode: 'test', trial: 'terrain', testTool: 'fire', buildTool: 'select', weapon: { platform: 'vehicle' },
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } },
    shown = (touch, preference, mode = 'test', tool = 'fire') => {
      Object.assign(view, { screenControls: preference, mode, testTool: tool });
      return !screenModel({ view, editor, state: null, network: { enabled: false, connected: false, designs: new Map() },
        session: { paused: false, testDistance: 0 }, sound: { enabled: false, volume: .4 }, touch }).bindings['touch-pad'].hidden;
    };
  assert.equal(shown(false, 'auto'), false); assert.equal(shown(true, 'auto'), true);
  assert.equal(shown(false, 'on'), false); assert.equal(shown(true, 'off'), true);
  assert.equal(shown(true, 'on', 'edit'), false); assert.equal(shown(true, 'on', 'test', 'inspect'), false);
  assert.deepEqual(editor.source, before);
});

test('a fixed structure tells its weight alone, and a vehicle short of an engine or a tank says so of its power and range', () => {
  const figures = source => {
    const editor = new Editor(source), b = editor.blueprint,
      view = { mode: 'edit', buildTool: 'select', testTool: 'fire', weapon: { platform: 'ground' },
        placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual' } };
    return { b, figures: screenModel({ view, editor, state: null, network: { enabled: false, connected: false, designs: new Map() },
      session: { paused: true, testDistance: 0 }, sound: { enabled: false, volume: .4 } }).figures };
  };
  assert.deepEqual(figures(createConstruction('bunker')).figures.map(figure => figure.label), ['PESO']);
  const scout = createConstruction('scout'), without = kind => ({ ...scout, components: scout.components.filter(part => part.kind !== kind) }),
    told = figures => figures.slice(1).map(({ label, value, title }) => [label, value, title]);
  assert.deepEqual(told(figures(without('engine')).figures), [['POTÊNCIA', '—', 'Sem motor'], ['AUTONOMIA', '—', 'Sem motor']]);
  const dry = figures(without('fuel'));
  assert.deepEqual(dry.figures.map(figure => figure.label), ['PESO', 'POTÊNCIA', 'AUTONOMIA', 'MÁXIMA ESTIMADA']);
  assert.equal(blueprintPowertrain(dry.b).powerKw, 0, 'with no fuel the drivetrain gives nothing');
  assert.equal(dry.figures[1].value, power(installedPower(dry.b)), 'but the engines are as strong as installed');
  assert.deepEqual([dry.figures[2].value, dry.figures[2].title], ['—', 'Sem tanque']);
});

test('screen scalars preserve each real context while workspace navigation and workshop surfaces belong to their controllers', () => {
  const editor = new Editor(createConstruction('heavy')), b = editor.blueprint,
    bench = { preset: 'rh120', platform: 'ground' },
    view = { mode: 'edit', trial: null, buildTool: 'select', testTool: 'fire', weapon: bench,
      placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual', snap: true } },
    alone = { enabled: false, connected: false, designs: new Map() },
    faction = { id: 'own', ref: 'r-own', name: 'Alice', stock: { ferro: 60000, ligas: 0, silica: 10000, combustivel: 1500 }, yard: { ferro: 0, ligas: 0, silica: 0, petroleo: 0 }, base: { x: 125000, y: 40, facing: 1, radius: 100 }, units: [], count: 0, counts: { vehicles: 0, fixed: 0 },
      members: [{ id: 'me', name: 'Alice', connected: true }], known: [], strangers: [], ranking: [], invites: [], request: null, requests: [], library: [], wrecks: [], deposits: [] },
    joined = { enabled: true, connected: true, designs: new Map(), playerId: 'me', selected: null, name: 'Alice', pingMs: 20, faction },
    world = { actors: [], plates: [], modules: [], stats: { shots: 0 }, time: 12, terrain: 'hills', terrainSettings: { seed: 7, length: 2000 }, weather: 'rain' },
    field = { ...world, shared: true, time: 75.5, terrain: 'world', terrainSettings: { seed: 6173, length: 512000 }, weather: 'dust', players: [{ id: 'me', connected: true }] },
    screen = (mode, network, state, trial = null, weapon = bench, ready = false) => { Object.assign(view, { mode, trial, weapon });
      return screenModel({ view, editor, state, network, session: { ready, paused: false, testDistance: 0, physicsMs: 0 }, terrainId: 'hills', particles: 0, sound: { enabled: false, volume: .4 } }); };

  // Away from the field the workshop stands on a bench of its own, with the way into the field; and the design has its two tests.
  const own = screen('edit', alone, world), armour = screen('test', alone, world, 'armour'),
    terrain = screen('test', alone, world, 'terrain', { platform: 'vehicle' });
  assert.deepEqual([own.edit, armour.edit, terrain.edit], [true, false, false]);
  assert.deepEqual([own, armour, terrain].map(c => c.bindings.reset.hidden), [true, false, false], 'only private tests can be restored');
  for (const c of [own, armour, terrain]) {
    assert.equal(c.panel.situation, null, 'away from the field there is no situation of it');
    assert.equal(c.panel.publish, null, 'the bench cannot publish into the shared field');
    for (const id of ['network-connection', 'invite-panel', 'field-empty', 'unit-panel', 'faction-hud']) assert.equal(c.bindings[id].hidden, true, id + ' is of the field');
  }
  assert.deepEqual([own.panel.project, own.bindings['test-controls'].hidden], [true, true]);
  // Tests retain the design data without offering workshop editing or publishing.
  for (const c of [armour, terrain]) assert.equal(c.panel.project, false);
  // The test of armour has its gun named, with its ammunition, distance and damage inspection.
  for (const id of ['weapon-description', 'catalog-test', 'ammo-options', 'test-distance-field', 'inspect', 'health-legend'])
    assert.equal(armour.bindings[id].hidden, false, id);
  // Its gun is in no hand: the panel has no heading, picture, figures, flight nor impact of an aim of it.
  for (const id of ['weapon-heading', 'current-weapon-preview', 'ballistic-info', 'impact-info'])
    assert.equal(armour.bindings[id].hidden, true, id);
  assert.equal(armour.bindings['weapon-specs'], undefined);
  // The design under a test of armour stands still: it is not driven, and nothing tells how fast it goes.
  assert.deepEqual([armour.driven, terrain.driven, armour.inspection], [false, true, null]);
  // The gun in hand is told once, under the controls over the field. The test of armour has none in hand: nothing is
  // told there, and the round chosen is the one lit among the buttons.
  assert.deepEqual([armour.gunTold, armour.bindings['weapon-runtime'].hidden, armour.bindings['ammo-tag'].hidden, armour.touch], [false, true, true, false]);
  // On the terrain the design fires its own guns, and with none that fires it is only driven: no gun of the bench stands in for them.
  assert.deepEqual([terrain.weapon.platform, terrain.fires, terrain.gunTold, terrain.bindings['test-controls'].hidden], ['vehicle', false, false, true]);
  // The bench is told the ground it is given and the clear sky; a test shows the world it was opened on.
  assert.deepEqual([own.terrain, own.terrainSettings, own.weather], ['hills', {}, 'clear']);
  assert.deepEqual([armour.terrain, armour.terrainSettings, armour.weather], ['hills', world.terrainSettings, 'rain']);

  // The shared field: the workshop at the base, with the way back to the field, and the field with the way to build.
  const workshop = screen('edit', joined, field), live = screen('test', joined, field, null, { platform: 'vehicle' });
  assert.deepEqual([workshop.edit, live.edit, workshop.shared, live.shared], [true, false, true, true]);
  assert.equal(live.bindings['faction-vehicles'].text, 'Veículos 0/12');
  assert.equal(live.bindings['faction-structures'].text, 'Estruturas 0/32');
  assert.equal(live.bindings['faction-structures'].attr['aria-label'], 'Estruturas 0 de 32, incluindo obras em andamento.');
  assert.deepEqual([workshop.bindings.reset.hidden, live.bindings.reset.hidden], [true, true], 'the shared field never restores constructions for free');
  for (const c of [workshop, live]) {
    assert.deepEqual([c.terrain, c.terrainSettings, c.weather], ['world', field.terrainSettings, 'dust']);
    assert.equal(c.bindings['faction-hud'].hidden, c.edit, 'stocks are read in Fabricar while building and over the shared field');
  }
  assert.equal(live.bindings['test-distance-field'].hidden, true, 'the field has no bench');
  const besieged = screen('edit', { ...joined, faction: { ...faction, siege: { state: 'advancing', progress: 25, at: 75.5 } } }, field);
  assert.deepEqual([besieged.bindings['faction-hud'].hidden, besieged.bindings['faction-capture'].hidden], [false, false],
    'simplifying the workshop must retain the active capture warning');
  // Each tab of the field has its own blocks: the workshop the design and its publishing; the field, with nothing of
  // the player on it, one line that says so and the way to the workshop.
  assert.deepEqual([workshop.panel.situation, live.panel.situation], ['workshop', 'empty']);
  assert.deepEqual([workshop.panel.project, Boolean(workshop.panel.publish), workshop.bindings['field-empty'].hidden], [true, true, true]);
  assert.deepEqual([live.panel.project, live.panel.publish, ...['field-empty', 'test-controls', 'unit-panel'].map(id => live.bindings[id].hidden)], [false, null, false, true, true]);
  assert.equal(live.bindings.viewport.data.tool, 'drive');
  // A faction with nothing there and less than an ore lorry costs has, under it, what the aid would give and the button
  // that asks for it; one with no base, what establishing one costs and the button that does it.
  assert.deepEqual(['field-empty-text', 'field-recovery', 'recover-faction'].map(id => live.bindings[id]),
    [{ text: 'Você não tem construções no campo: monte uma em Construir e fabrique-a.' }, { hidden: true, text: '' }, { hidden: true, text: '' }]);
  const lorry = { ferro: 28022, ligas: 0, silica: 995, combustivel: 203 }, ruined = screen('test', { ...joined, faction: { ...faction,
    recovery: { base: null, lorry, reserve: 203, aid: { ferro: 27122, ligas: 0, silica: 995, combustivel: 0 }, offered: true } } }, field);
  assert.deepEqual([ruined.bindings['field-empty'].hidden, ruined.bindings['field-recovery'], ruined.bindings['recover-faction']], [false,
    { hidden: false, text: 'Nada no campo e sem estoque para um caminhão de minério (Ferro 28.022 + Sílica 995 + Combustível 203 L) com Combustível 203 L de reserva. ' +
      'O auxílio cobre o que falta: Ferro 27.122 + Sílica 995.' }, { hidden: false, text: 'Pedir auxílio' }]);
  const lost = screen('test', { ...joined, faction: { ...faction, base: null, fell: { at: 70, from: 0, by: null, dismantled: 0, returned: {}, cargo: {}, stock: {}, yard: {} },
    recovery: { base: { ferro: 22500, ligas: 2500, silica: 2500, combustivel: 375 }, lorry: null, reserve: 0, aid: { ferro: 0, ligas: 0, silica: 0, combustivel: 0 }, offered: true } } }, field);
  assert.deepEqual(['field-empty-text', 'field-recovery', 'recover-faction'].map(id => lost.bindings[id]), [{ text: 'Sua facção está sem base.' },
    { hidden: false, text: 'Estabelecer base custa Ferro 22.500 + Ligas 2.500 + Sílica 2.500 + Combustível 375 L.' }, { hidden: false, text: 'Estabelecer base' }]);
  // The page of the faction: where it stands among the nations by its wealth, its members, whoever it may invite, and
  // leaving it while another member keeps it.
  assert.deepEqual([live.bindings['member-count'].text, live.bindings['invitable-section'].hidden, live.bindings['leave-faction'].hidden],
    [1, true, true]);
  const flag = { country: 'pt' }, peopled = screen('test', { ...joined, faction: { ...faction, flag, members: [...faction.members, { id: 'bia', name: 'Bia', connected: true }],
    strangers: [{ id: 'caio', name: 'Caio', connected: true, invited: false }],
    ranking: [{ id: 'other', ref: 'r-other', name: 'Caio', nation: null, flag, wealth: 2_000_000 }, { id: 'own', ref: 'r-own', name: 'Alice', nation: null, flag, wealth: 71_500 }] } }, field);
  assert.deepEqual(['faction-place', 'faction-wealth', 'faction-of', 'member-count', 'invitable-count'].map(id => peopled.bindings[id].text), ['2º', '71,5 mil pontos', 'entre 2 nações no campo', 2, 1]);
  assert.deepEqual([peopled.bindings['faction-wealth'].title, peopled.bindings['invitable-section'].hidden, peopled.bindings['leave-faction'].hidden], ['71.500 pontos de riqueza', false, false]);
  // The requests to join the faction have their list while there are some to answer.
  const asked = screen('test', { ...joined, faction: { ...faction, requests: [{ id: 'caio', name: 'Caio', connected: true, from: { id: null, name: 'Caio', nation: null, flag } }] } }, field);
  assert.deepEqual([peopled.bindings['request-section'].hidden, asked.bindings['request-section'].hidden, asked.bindings['request-count'].text], [true, false, 1]);
  // In the Oficina the design is edited as on the bench, with every tool of the editor.
  assert.equal(workshop.bindings['test-controls'].hidden, true);
  assert.equal(workshop.bindings['body-paint'].disabled, false);
  assert.deepEqual([workshop.bindings.undo.disabled, workshop.bindings.redo.disabled], [own.bindings.undo.disabled, own.bindings.redo.disabled]);
  assert.equal(workshop.bindings.viewport.data.tool, 'select');
  assert.deepEqual([workshop.bindings['publish-new'].disabled, workshop.bindings['publish-replace'].hidden], [true, true],
    'a heavy tank is more than the iron a faction starts with, and with nothing to replace no replacing is offered');
  assert.match(workshop.bindings['publish-refused'].text, /^Falta Ferro/);
  assert.equal(workshop.bindings['publish-refused'].hidden, false);
  assert.equal(workshop.bindings['publish-refused'].text, workshop.bindings['publish-new'].title);
  assert.equal(workshop.bindings['publish-new'].attr['aria-describedby'], 'publish-refused');
  // Full design figures are available to Projeto wherever it is built, and only there.
  assert.deepEqual(workshop.figures, own.figures); assert.deepEqual(workshop.figures.map(figure => figure.label), ['PESO', 'POTÊNCIA', 'AUTONOMIA', 'MÁXIMA ESTIMADA']); assert.deepEqual([armour.figures, terrain.figures, live.figures], [[], [], []]);
  for (const c of [own, armour, terrain, workshop, live]) {
    assert.deepEqual(c.bindings['edit-controls'], { data: { installing: false } });
  }
  assert.equal(live.bindings['body-paint'].disabled, true);
  // While the connection is being made the field says so, on its own tab; a connection that answers is worth no line.
  const waiting = screen('test', { ...joined, connected: false, faction: null }, field);
  assert.deepEqual([waiting.bindings['network-connection'], waiting.bindings['field-empty'].hidden],
    [{ hidden: true, text: 'Sem conexão com o campo: reconectando…' }, true]);
  assert.equal(waiting.bindings['connection-notice'].hidden, false);
  assert.equal(waiting.bindings['connection-title'].text, 'Conexão interrompida');
  assert.deepEqual(live.bindings['network-connection'], { hidden: true, text: '' });
  assert.deepEqual(screen('test', { ...joined, pingMs: 412.4 }, field).bindings['network-connection'], { hidden: false, text: 'Conexão lenta · 412 ms' });
  // A save failure is persistent field status, including while the chosen workshop stays usable.
  const failed = { ...joined, persistenceFailed: true };
  for (const mode of ['test', 'edit']) {
    const warning = screen(mode, failed, field, null, bench, true), again = screen(mode, failed, field, null, bench, true);
    assert.deepEqual(warning.bindings['connection-notice'], { hidden: false, data: { compact: true } });
    assert.equal(warning.bindings['connection-title'].text, 'Salvamento indisponível');
    assert.match(warning.bindings['connection-detail'].text, /servidor não está conseguindo salvar/);
    assert.deepEqual(again.bindings['connection-notice'], warning.bindings['connection-notice']);
    for (const id of ['connection-retry', 'connection-reload', 'connection-workshop']) assert.equal(warning.bindings[id].hidden, true);
    if (mode === 'edit') assert.equal(warning.bindings['publish-new'].disabled, screen(mode, joined, field, null, bench, true).bindings['publish-new'].disabled);
    assert.deepEqual(screen(mode, { ...failed, persistenceFailed: false }, field, null, bench, true).bindings['connection-notice'], { hidden: true, data: { compact: false } });
  }
  assert.equal(screen('test', failed, world, 'armour').bindings['connection-notice'].hidden, true, 'a private trial keeps its own screen');
});

test('a test says its controls once as it starts, to the keys or to a finger', () => {
  // The test of armour is struck along a line drawn from where the round comes from, or level where the design is clicked.
  assert.equal(trialHint({ kind: 'armour' }), 'Arraste de onde vem o tiro até onde ele vai · clique no projeto para um tiro na horizontal.');
  assert.equal(trialHint({ kind: 'armour', touch: true }),
    'Arraste de onde vem o tiro até onde ele vai · toque no projeto para um tiro na horizontal · dois dedos movem a vista.');
  // The test of driving is named as the player knows it, the Campo de provas; a design with no gun of its own is only
  // driven there.
  assert.equal(trialHint({ kind: 'terrain', fires: false }), 'Campo de provas · terreno do mundo · A/D conduzem e S freia.');
  assert.equal(trialHint({ kind: 'terrain', touch: true }), 'Campo de provas · terreno do mundo · os botões à esquerda conduzem · toque para mirar e Fogo dispara.');
});

test('on the proving ground the design is driven seen from outside, and seen into, with the colours of its pieces, while inspected', () => {
  // The test of armour always looks into the design; the proving ground only while Inspecionar is on. The targets never.
  assert.deepEqual([...trialOpened({ trial: 'armour', testTool: 'fire' })], ['local']);
  assert.deepEqual([...trialOpened({ trial: 'terrain', testTool: 'fire' })], []);
  assert.deepEqual([...trialOpened({ trial: 'terrain', testTool: 'inspect' })], ['local']);
  // The legend of those colours is there while they are seen: in the test of armour, and on the proving ground while inspected.
  const editor = new Editor(createConstruction('heavy')), b = editor.blueprint,
    alone = { enabled: false, connected: false, designs: new Map() },
    world = { actors: [], plates: [], modules: [], stats: { shots: 0 }, time: 12, terrain: TRIAL_WORLD.terrain, terrainSettings: { seed: TRIAL_WORLD.seed, length: TRIAL_WORLD.mapLength, center: TRIAL_WORLD.center }, weather: 'clear' },
    screen = (trial, testTool) => screenModel({ editor, state: world, network: alone, terrainId: TRIAL_WORLD.terrain, sound: { enabled: false, volume: .4 },
      session: { paused: false, testDistance: 0, physicsMs: 0 },
      view: { mode: 'test', trial, buildTool: 'select', testTool, weapon: trial === 'armour' ? { preset: 'rh120', platform: 'ground' } : { platform: 'vehicle' },
        placement: { kind: 'engine', weaponPreset: 'rh120', ammoPreset: 'rh120', sensorMode: 'visual', snap: true } } }).bindings;
  const legend = (trial, tool) => [screen(trial, tool).inspect.hidden, screen(trial, tool)['health-legend'].hidden];
  assert.deepEqual([legend('armour', 'fire'), legend('terrain', 'fire'), legend('terrain', 'inspect')], [[false, false], [false, true], [false, false]]);
  assert.equal(screen('armour', 'fire')['trial-targets-details'].hidden, true);
  assert.equal(screen('terrain', 'fire')['trial-targets-details'].hidden, false);
  assert.match(screen('terrain', 'fire')['trial-targets-info'].text, /Artilharia: 8 km e 19,6 km/);
});

test('a sector refusal overrides ready or aligning words while preserving ordinary servo status', t => {
  const source = createConstruction('howitzer', { preset: 'm119' }), world = managedWorld(t, source), editor = new Editor(source), state = world.snapshot(),
    gun = state.modules.find(part => part.kind === 'weapon'),
    view = { mode: 'test', trial: null, buildTool: 'select', testTool: 'fire',
      weapon: { preset: 'm119', platform: 'vehicle', componentId: gun.id }, placement: { kind: 'engine' } },
    screen = aimSolution => screenModel({ view, editor, state, aimSolution, terrainId: 'flat',
      network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0 },
      sound: { enabled: false, volume: .4 } }).bindings['weapon-runtime'];
  gun.targetBarrelAngle = gun.barrelAngle; gun.reload = 0;
  assert.match(screen({ reachable: true }).text, /Pronta/);
  const refused = { reachable: false, limit: 'sector' };
  assert.equal(screen(refused).data.state, 'blocked'); assert.equal(screen(refused).text, 'Fora do setor da montagem');
  gun.targetBarrelAngle = gun.barrelAngle + .24 * Math.PI / 180;
  assert.equal(screen(refused).text, 'Fora do setor da montagem', 'turning toward the stop cannot promise a shot there');
  assert.equal(screen({ reachable: true }).data.state, 'aligning');
  assert.match(screen({ reachable: true }).text, /faltam 0,2°/);
});

test('a gun tells when its barrel is past the limit its manual sets and when it glows, and its switch says so', t => {
  const source = createConstruction('howitzer', { preset: 'm119' }), world = managedWorld(t, source), editor = new Editor(source), state = world.snapshot(),
    gun = state.modules.find(part => part.kind === 'weapon'),
    view = { mode: 'test', trial: null, buildTool: 'select', testTool: 'fire',
      weapon: { preset: 'm119', platform: 'vehicle', componentId: gun.id }, placement: { kind: 'engine' } },
    screen = () => screenModel({ view, editor, state, aimSolution: { reachable: true }, terrainId: 'flat',
      network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0 },
      sound: { enabled: false, volume: .4 } });
  gun.targetBarrelAngle = gun.barrelAngle; gun.reload = 0;
  // The howitzer's tube is held under the 182 °C red line of its thermometer; steel glows from 525 °C.
  const said = heat => { gun.barrelTemperature = heat; const model = screen(); return [model.bindings['weapon-runtime'].text, model.weaponButtons[0].status]; };
  assert.doesNotMatch(said(150)[0], /Cano/); assert.equal(said(150)[1], 'em uso');
  assert.match(said(200)[0], /^Pronta · Cano quente · /); assert.equal(said(200)[1], 'cano quente');
  assert.match(said(600)[0], /^Pronta · Cano superaquecido · /); assert.equal(said(600)[1], 'cano superaquecido');
});

test('a gun tells its belt against what it holds, and while the crew changes it the trigger fills back up', t => {
  const source = createConstruction('scout'), world = managedWorld(t, source), editor = new Editor(source), state = world.snapshot(),
    gun = state.modules.find(part => part.kind === 'weapon'),
    view = { mode: 'test', trial: null, buildTool: 'select', testTool: 'fire',
      weapon: { preset: gun.weaponPreset, platform: 'vehicle', componentId: gun.id }, placement: { kind: 'engine' } },
    screen = () => screenModel({ view, editor, state, aimSolution: { reachable: true }, terrainId: 'flat',
      network: { enabled: false, connected: false, designs: new Map() }, session: { paused: false, testDistance: 0 },
      sound: { enabled: false, volume: .4 } });
  gun.targetBarrelAngle = gun.barrelAngle; gun.reload = 0; gun.barrelTemperature = 20;
  assert.equal(gun.weaponPreset, 'm2hb');
  // A frame that tells no feed tells none.
  delete gun.loaded; delete gun.feedReload;
  assert.doesNotMatch(screen().bindings['weapon-runtime'].text, /cinta/);
  gun.loaded = 87; gun.feedReload = 0;
  assert.match(screen().bindings['weapon-runtime'].text, /^Pronta · cinta 87\/100 · [\d.]+ munições$/);
  // The M2's crew changes its can in 15 s: with 12 left, four fifths of the change is ahead.
  gun.loaded = 0; gun.feedReload = 12;
  const changing = screen();
  assert.match(changing.bindings['weapon-runtime'].text, /^Trocando a cinta · 12 s · [\d.]+ munições$/);
  assert.equal(changing.bindings['touch-fire'].data.state, 'reloading');
  assert.equal(changing.bindings['touch-fire'].style['--reload'], '0.800');
  assert.equal(changing.weaponButtons[0].status, 'trocando a cinta');
});
