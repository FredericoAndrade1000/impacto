import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { MODULES, METALS, PIECE_METALS } from '../src/materials.ts';
import { componentSizeLimits } from '../src/component-size.ts';
import { CARGO, cargoUnitMass, holdsCargo, holdsMix, mixRoom, mixSpace } from '../src/component-volume.ts';
import { pieceMass } from '../src/mass-properties.ts';
import { pieceCostBreakdown } from '../src/construction-cost.ts';
import { compileManufacture, compileDraftConstruction, planStructuredComponent, structuredPlacementIntent } from '../src/structured-construction.ts';
import { moveStructuredComponents } from '../src/structured-editing.ts';
import { projectRefusalMessage } from '../src/project-refusal.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { createConstruction } from '../src/construction-templates.ts';
import { World } from '../src/physics.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-template-catalogue.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { roadRate, toolPace, PAVING, billTotal } from '../src/economy.ts';
import { workshopChecklist, workshopAdmissionMessage } from '../src/workshop-checklist.ts';
import { designation } from '../src/designation.ts';
import { withConstructionKind } from '../src/chassis-editing.ts';
import { chassisRear, frameThicknessMm } from '../src/chassis.ts';
import { REACH_CELLS } from '../src/frame-editing.ts';
import { CELL, metresOf } from '../src/grid.ts';

await initNativeDynamics();
const near = (a, b, what) => assert(Math.abs(a - b) < 1e-7 * Math.max(1, Math.abs(b)), `${what}: ${a} differs from ${b}`);
// Spacious frames for the scale, mass and capacity checks. Their tools have explicit physical poses; the field tests
// below use the factory road machines and their working geometry.
const bare = (id, kind) => { const design = createStructuredTemplate(id); return { ...design, components: design.components.filter(part => part.kind !== kind) }; };
// A whole straight frame with large wheels and its axles at the ends provides a generous structural envelope, raised
// with all on it clear of a blade of the largest size standing on the floor between them: it hangs from the rail over
// it by its column (game_construction.rs `standoff`). Places in cells (grid.ts).
const roomy = (sizeScale = 1) => { const design = bare('grader', 'blade'), { points } = design.chassis, up = at => ({ ...at, y: at.y + 12 }),
  source = { ...design, nodes: design.nodes.map(up), components: design.components.map(part => ({ ...part, pose: up(part.pose) })),
    chassis: { ...design.chassis, points: [points[0], points.at(-1)].map(up), gearScale: 1.5, thicknessMm: 40, axles: [-58, 58] } },
  tool = blade(source, sizeScale);
  // An editable Draft alone does not prove physical support; admit the complete fixture with its actual sized tool.
  assert.deepEqual(compileManufacture({ ...source, components: [...source.components, tool] }, {}, false).compiled.admissionIssues, [], `blade fixture ×${sizeScale}`);
  return source; };
const deck = () => { const design = createStructuredTemplate('tracked'); return { ...design, chassis: { ...design.chassis, thicknessMm: 60 } }; };
// A blade stands where it is put, on the floor of the workshop: nothing goes under it. On the cell clear of it.
const blade = (_source, sizeScale = 1) => ({ id: 'machine', kind: 'blade', sizeScale,
  pose: { x: 0, y: REACH_CELLS.minY + Math.ceil((MODULES.blade.height * sizeScale / 2 + .01) / CELL - 1e-9), angle: 0 } });
// A paver on the rear of the chassis, on the cell within it and clear of its frame.
const paver = (source, sizeScale = 1) => ({ id: 'machine', kind: 'paver', sizeScale, pose: {
  x: Math.floor((chassisRear(source.chassis) - MODULES.paver.width * sizeScale / 2) / CELL + 1e-9),
  y: source.chassis.points.at(-1).y + Math.ceil((frameThicknessMm(source.chassis) / 2000 + MODULES.paver.height * sizeScale / 2) / CELL - 1e-9), angle: 0 } });

// The blade up to twice its size under those wheels, the paver as far as those tracks carry its hopper full. Each is as
// deep across the body at any size: its mass, its price and the road it makes follow the square of its size, and the power
// it asks that of a pump for the paver and the 5/6 power of its room, s^(5/3), for the blade, as an arm (game_geometry.rs
// `work_power_kw`).
for (const [kind, design, part, mass, price, health, kw, growth, rate, scales] of [
  ['blade', roomy, blade, 1100, 1600, 160, 150, 5 / 3, 1, [.5, 1, 2]], ['paver', deck, paver, 2200, 2600, 130, 120, 2, .5, [.5, 1, 1.1]]]) {
  test(`${kind}: its size, mass, price and the power it asks follow its size, and its mass, health and price its metal`, () => {
    assert.deepEqual([MODULES[kind].width, MODULES[kind].height, MODULES[kind].depthM], kind === 'blade' ? [1.6, .45, 1.2] : [1.6, .9, 1.2]);
    assert.deepEqual(componentSizeLimits({ kind }), { min: .25, max: 2.5 });
    assert.deepEqual(PIECE_METALS[kind], ['steel', 'aluminum', 'titanium']);
    for (const scale of scales) {
      const source = design(scale), result = planStructuredComponent(source, part(source, scale)), piece = result.compiled.modules.find(m => m.id === 'machine'),
        cost = pieceCostBreakdown(piece), column = piece.support?.mass ?? 0;
      near(piece.width, MODULES[kind].width * scale, 'width'); near(piece.height, MODULES[kind].height * scale, 'height');
      near(piece.mechanicalDepth, MODULES[kind].depthM, 'depth');
      // A blade hangs by a column of steel, which weighs and is paid with it, as steel at 1.4 a kilogram, from Ferro (game_cost.rs `kept`).
      if (kind === 'blade') assert(piece.support.reach > 0 && column > 0, `${kind} ×${scale} hangs by its column`);
      near(pieceMass(piece) - column, mass * scale ** 2, `${kind} ×${scale} mass`);
      near(piece.maxHealth, health, 'health');
      near(piece.workKw, kw * scale ** growth, `${kind} ×${scale} power`);
      assert.equal(cost.engines, Math.ceil(price * scale ** 2 - 1e-9)); assert.equal(cost.kept, Math.max(0, Math.ceil(column * 1.4 - 1e-9)));
      assert.equal(cost.storage, 0); assert.equal(cost.supplies, 0);
      assert.equal(holdsCargo(piece), false); assert.equal(piece.exposed, true);
      // As fast as it is big: a road machine of twice the size makes four times as much road a second.
      near(roadRate(piece), rate * scale ** 2, `${kind} ×${scale} rate`); near(toolPace(piece), scale ** 2, 'pace');
    }
    // Of another metal its body weighs, stands and costs its share of the steel one; the column it hangs by stays steel,
    // the power it asks and the road it makes what they were. It is no laminate.
    const source = design(), steel = planStructuredComponent(source, part(source)).compiled.modules.find(m => m.id === 'machine');
    for (const [metal, massShare, healthShare, priceShare] of [['aluminum', .65, .75, 1.3], ['titanium', .6, 1.1, 3]]) {
      const piece = planStructuredComponent(source, { ...part(source), metal }).compiled.modules.find(m => m.id === 'machine'),
        column = piece.support?.mass ?? 0, cost = pieceCostBreakdown(piece);
      assert.equal(piece.metal, metal); near(column, steel.support?.mass ?? 0, `${kind} of ${metal}: its column`);
      near(pieceMass(piece) - column, mass * massShare, `${kind} of ${metal}`);
      near(piece.maxHealth, health * healthShare, `${kind} of ${metal}: health`); assert.equal(METALS[metal].health, healthShare);
      assert.equal(cost.engines, Math.ceil(price * priceShare - 1e-9), `${kind} of ${metal}: price`);
      assert.equal(cost.kept, Math.max(0, Math.ceil(column * 1.4 - 1e-9)), `${kind} of ${metal}: its column, paid as steel from Ferro`);
      near(piece.workKw, steel.workKw); near(roadRate(piece), roadRate(steel));
    }
    assert.throws(() => planStructuredComponent(source, { ...part(source), metal: 'fiberglass' }), { reason: 'FIELD' });
  });
}

test('a paver carries in the hopper built into it the mix of 45 m of asphalt at the reference size, s² of that at size s, which its chassis carries full', () => {
  for (const scale of [.25, .5, 1, 1.1]) {
    const source = deck(), compiled = planStructuredComponent(source, paver(source, scale)).compiled, piece = compiled.modules.find(m => m.id === 'machine'),
      metres = 45 * scale ** 2, full = metres * (PAVING.silica * cargoUnitMass('silica') + PAVING.combustivel * cargoUnitMass('petroleo'));
    near(mixRoom(piece), metres, `room at ×${scale}`);
    assert(holdsMix(piece) && !holdsCargo(piece), 'its hopper takes the mix, and no cargo');
    // Empty, it takes the mix of all of it: so many kilograms of Sílica and litres of Combustível as the metres ask for, and no more.
    near(mixSpace(piece, 'silica'), PAVING.silica * metres, 'Sílica'); near(mixSpace(piece, 'petroleo'), PAVING.combustivel * metres, 'Combustível');
    for (const name of Object.keys(CARGO).filter(name => !['silica', 'petroleo'].includes(name))) assert.equal(mixSpace(piece, name), 0, name);
    near(mixSpace({ ...piece, cargo: { silica: PAVING.silica * metres / 2 } }, 'silica'), PAVING.silica * metres / 2, 'half of its Sílica');
    // Its chassis is rated for it full: 13.1 t of mix at 100 %.
    assert(compiled.chassis.loadedKg - compiled.chassis.emptyKg >= full - 1e-6, `×${scale}: ${compiled.chassis.loadedKg} − ${compiled.chassis.emptyKg}`);
    assert.deepEqual(compiled.admissionIssues, [], `×${scale}`);
    if (scale === 1) near(full, 13135.5, 'the full mix at 100 %');
  }
  // Twice as big it carries the mix of 180 m of asphalt, 52.5 t of it: no chassis of tracks carries that full. The workshop
  // says so, and the field takes no such design.
  const source = deck(), big = planStructuredComponent(source, paver(source, 2));
  assert.deepEqual(big.compiled.admissionIssues.map(issue => issue.code), ['CHASSIS_OVERLOAD']);
  assert.throws(() => compileBlueprint(big.construction), { reason: 'CHASSIS_OVERLOAD' });
});

test('the mix in the hopper of a paver weighs on its vehicle, and is lost with the paver when it is destroyed', t => {
  const world = new World({ ...createConstruction('paver'), terrain: 'flat' }), step = n => { for (let i = 0; i < n; i++) world.step(); },
    piece = () => world.modules.find(m => m.kind === 'paver');
  t.after(() => world.dispose());
  step(30);
  const empty = world.vehicle.mass, mix = { silica: mixSpace(piece(), 'silica'), petroleo: mixSpace(piece(), 'petroleo') };
  world.command('setPartState', { owner: world.game().handle(piece()), state: { cargo: mix } });
  step(60);
  assert(Math.abs(world.vehicle.mass - empty - 13135.5) < 25, `${world.vehicle.mass} kg full, ${empty} kg empty`);
  // A charge on it destroys it, and nothing else: what it held goes with it.
  world.explode(piece().x, piece().y + 1.2, 250, 3); step(30);
  assert.equal(piece().health, 0); assert.deepEqual(piece().cargo, { silica: 0, petroleo: 0 });
  assert.deepEqual(world.modules.filter(m => m.health <= 0).map(m => m.kind), ['paver']);
  assert(Math.abs(world.vehicle.mass - empty) < 25, `${world.vehicle.mass} kg after, ${empty} kg empty`);
});

test('a metre of road paved takes 280 Sílica and 14 L of Combustível, and levelling takes no material', () => {
  assert.deepEqual(PAVING, { ferro: 0, ligas: 0, silica: 280, combustivel: 14 }); assert(Object.isFrozen(PAVING));
  assert.equal(billTotal(PAVING), 294);
  for (const [kind, rate] of [['blade', 1], ['paver', .5]]) assert.equal(roadRate({ kind, width: MODULES[kind].width }), rate);
});

test('road tools follow the cursor pose without choosing a chassis anchor or moving to its rear', () => {
  const source = bare('grader', 'blade'), point = { x: 12.2, y: .3 },
    part = { id: 'machine', kind: 'blade' }, pose = { x: 4, y: -20, angle: 0 };
  assert.deepEqual(structuredPlacementIntent(part, point), pose);
  const applied = planStructuredComponent(source, { ...part, pose }).component.pose;
  for (const key of ['x', 'y', 'angle']) near(applied[key], pose[key], 'cursor ' + key);
  const tracked = deck(), p = paver(tracked), at = { x: 12 + metresOf(p.pose.x), y: 1.4 + metresOf(p.pose.y) };
  const chosen = structuredPlacementIntent(p, at);
  const mounted = planStructuredComponent(tracked, { ...p, pose: chosen }).component.pose;
  for (const key of ['x', 'y', 'angle']) near(mounted[key], chosen[key], 'paver cursor ' + key);
  // Its foot where the paver's is, on the cell clear of the frame.
  const laid = { ...blade(tracked), pose: { x: 20, y: p.pose.y - Math.floor((MODULES.paver.height - MODULES.blade.height) / 2 / CELL), angle: 0 } };
  assert.equal(planStructuredComponent(tracked, laid).component.pose.x, 20, 'a blade has no wheels-only mounting permission');
});

test('removing a chassis preserves the explicit road-tool poses', () => {
  for (const design of [createStructuredTemplate('grader'), createStructuredTemplate('paver')]) {
    const fixed = withConstructionKind(design, 'fixed');
    assert.equal(fixed.chassis, undefined);
    assert.deepEqual(fixed.components, design.components, 'changing the construction kind does not reposition its equipment');
  }
});

test('the two models are named for their machine, have no gun, and are told what their machine asks of the engine', () => {
  for (const [id, name, kind] of [['grader', 'Motoniveladora', 'blade'], ['paver', 'Pavimentadora', 'paver']]) {
    const template = CONSTRUCTION_TEMPLATES.find(model => model.id === id), compiled = compileBlueprint(createStructuredTemplate(id));
    assert.equal(template.name, name); assert.equal(template.type, 'vehicle');
    assert.equal(designation(compiled), name);
    assert.equal(compiled.modules.filter(m => m.kind === kind).length, 1);
    assert(!compiled.modules.some(m => m.kind === 'weapon' || m.kind === 'ammo'));
    const road = workshopChecklist(compiled).find(item => item.id === 'road');
    assert.equal(road?.state, 'ready', `${id}: its engine works it at the full pace`);
    assert.match(road.detail, /^A ferramenta pede [\d.]+ hp; o motor dá [\d.]+ hp\.$/, id);
    // Starved of power, it is told what share it works at.
    const weak = { ...compiled, modules: compiled.modules.map(m => m.kind === 'engine' ? { ...m, powerKw: 30 } : m) },
      told = workshopChecklist(weak).find(item => item.id === 'road');
    assert(told && told.state !== 'ready', `${id}: ${JSON.stringify(told)}`);
  }
});

// A blade or a screed is made to reach the ground at work (game_construction.rs `TOOL_HEIGHT`): the workshop takes it as
// high as 1.5 m over the ground its vehicle stands on, at rest, and refuses it higher, saying which tool and what to do.
test('the workshop refuses a blade or a screed put more than 1.5 m over the ground, and lets one already so come down', () => {
  for (const [id, kind, fits, words] of [['grader', 'blade', 20, 'A lâmina fica alta demais para alcançar o chão. Abaixe-a.'],
    ['paver', 'paver', 8, 'A mesa fica alta demais para alcançar o chão. Abaixe-a.']]) {
    const source = createStructuredTemplate(id), tool = source.components.find(part => part.kind === kind),
      // The tool moved up by `cells` (grid.ts), as a drag in the workshop moves it, and what refused it, if anything.
      move = (from, cells) => { let refusal = null; const next = moveStructuredComponents(from, [{ id: tool.id, x: 0, y: 0 }],
        before => ({ x: before.x, y: before.y + metresOf(cells) }), error => { refusal = error; }); return { next, refusal }; },
      highest = move(source, fits), over = move(source, fits + 2);
    assert(highest.next, `${id}: ${fits} cells up is within reach of the ground`);
    assert.deepEqual([over.next, over.refusal?.reason, over.refusal?.ids, over.refusal?.message], [null, 'TOOL_GROUND', [tool.id], words], id);
    // A design made before, its tool higher than that, opens and is told why it cannot be made, by its tool; that may come
    // down a step at a time.
    const before = { ...source, components: source.components.map(part => part === tool ? { ...part, pose: { ...part.pose, y: part.pose.y + fits + 6 } } : part) },
      compiled = compileDraftConstruction(before), rows = workshopChecklist(compiled), road = rows.find(item => item.id === 'road');
    assert.deepEqual([road?.state, road?.detail], ['attention', words], `${id}: ${JSON.stringify(road)}`);
    assert(!rows.some(item => item.id === 'chassis'), `${id}: told of its tool, not of its chassis`);
    assert.equal(workshopAdmissionMessage(compiled), words, `${id}: why it is not made`);
    assert.throws(() => compileManufacture(before), { reason: 'TOOL_GROUND' }, `${id}: not made`);
    assert.equal(projectRefusalMessage({ reason: 'TOOL_GROUND', ids: [tool.id] }, before), `O componente "${tool.id}" fica alto demais para alcançar o chão.`);
    const lower = move(before, -2);
    assert(lower.next && !lower.refusal, `${id}: comes down, still too high`);
    assert(move(before, -6).next, `${id}: and within reach`);
  }
});
