import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint } from '../src/persistence.ts';
import { CONSTRUCTION_TEMPLATES } from '../src/construction-templates.ts';
import { openArcs, sightFigure, drawSight, sightText } from '../src/sight-art.ts';
import { SENSOR_MODES } from '../src/combat-sensors.ts';

await initNativeDynamics();
const TAU = Math.PI * 2, rad = degrees => degrees * Math.PI / 180,
  // Whether an angle lies in one of the arcs given, whichever turn it is told in.
  within = (arcs, angle) => arcs.some(([from, to]) => [-TAU, 0, TAU].some(turn => from <= angle + turn && angle + turn <= to)),
  // The support vehicle with its vision block of steel, and the plate asked for of glass.
  glazed = (plate, pane = 'glass') => {
    const source = createStructuredTemplate('ifv'), front = source.plates.find(candidate => candidate.id === plate);
    source.plates.find(candidate => candidate.id === 'hull:vision').material = 'steel';
    front.material = pane; front.thicknessMm = Math.max(front.thicknessMm, 40);
    return compileBlueprint(source);
  },
  sight = (blueprint, id) => blueprint.sights.find(candidate => candidate.id === id);

test('what is open to an optic is what of a whole turn its armour does not hide', () => {
  assert.deepEqual(openArcs({ hidden: [] }), [[-Math.PI, Math.PI]]);
  assert.deepEqual(openArcs({ hidden: [[-Math.PI, Math.PI]] }), []);
  // One arc hidden leaves the rest of the turn; an arc hidden across the back of the turn is told in two.
  const [[from, to]] = openArcs({ hidden: [[rad(-160), rad(-5)]] });
  assert(Math.abs(from - rad(-5)) < 1e-12 && Math.abs(to - rad(200)) < 1e-12);
  assert.deepEqual(openArcs({ hidden: [[-Math.PI, rad(-170)], [rad(-150), Math.PI]] }).map(arc => arc.map(angle => Math.round(angle * 180 / Math.PI))), [[-170, -150]]);
  // Turned with its piece, the arcs are told past half a turn: what is open is the same slit, turned as much.
  const turned = openArcs({ hidden: [[rad(-90), rad(80)], [rad(100), rad(260)]] }).map(arc => arc.map(angle => Math.round(angle * 180 / Math.PI)));
  assert.deepEqual(turned, [[80, 100], [260, 270]]);
});

test('the model reports its roof optic and the Command sight ahead through the real visor', () => {
  const blueprint = compileBlueprint(createStructuredTemplate('ifv')), optics = blueprint.modules.filter(module => module.kind === 'command' || ['visual', 'radar'].includes(module.sensorMode));
  assert.deepEqual(blueprint.sights.map(told => told.id).sort(), optics.map(module => module.id).sort());
  for (const told of blueprint.sights) { const module = optics.find(candidate => candidate.id === told.id); assert.deepEqual([told.x, told.y], [module.x, module.y]); }
  const camera = sight(blueprint, 'sensor-0'), post = sight(blueprint, 'command'), range = SENSOR_MODES.visual.range;
  assert.deepEqual([camera.range, camera.left, camera.right], [range, range, range]);
  // The Command looks ahead through its real visor at 650 m, without an extra internal 4 km optic.
  assert.deepEqual([post.range, post.left, post.right], [650, 650, 0]);
  assert.deepEqual(blueprint.eyes, [post, camera].map(told => ({ x: told.x, y: told.y, left: told.left, right: told.right })));
  const open = openArcs(camera);
  assert(within(open, 0) && within(open, Math.PI) && within(open, Math.PI / 2) && !within(open, -Math.PI / 2));
  assert(within(openArcs(post), Math.PI) && !within(openArcs(post), 0));
  assert.equal(sightText(camera), `vê ${range.toLocaleString('pt-BR')} m à frente e atrás`); assert.equal(sightText(post), 'vê 650 m à frente, nada atrás');
  // Its vision block of steel, the post sees nothing.
  const shut = sight(glazed('hull:vision', 'steel'), 'command');
  assert.deepEqual([shut.range, shut.left, shut.right], [0, 0, 0]); assert.deepEqual(openArcs(shut), []);
  assert.equal(sightText(shut), 'sem visão: blindagem em toda a volta');
});

test('a radar is told as an optic is, by how far it reaches: that of every model stands on top and reaches both ways', () => {
  const range = SENSOR_MODES.radar.range;
  for (const { id } of CONSTRUCTION_TEMPLATES)
    for (const radar of compileBlueprint(createStructuredTemplate(id)).sights.filter(told => told.mode === 'radar'))
      assert.deepEqual([radar.range, radar.left, radar.right], [range, range, range], id);
  const radar = { mode: 'radar', range: 4000, left: 4000, right: 4000, hidden: [] };
  assert.equal(sightText(radar), 'alcança 4.000 m à frente e atrás');
  assert.equal(sightText({ ...radar, right: 0 }), 'alcança 4.000 m à frente, nada atrás');
  assert.equal(sightText({ ...radar, left: 0, right: 0 }), 'radar sem alcance ao nível do solo');
  assert.equal(sightText({ ...radar, range: 0, left: 0, right: 0 }), 'radar bloqueado: blindagem em toda a volta');
});

test('through glass an optic in the hull sees out, level when the glass is at its height', () => {
  // The vision block low in the glacis is before the post, at its height: it sees ahead, which is the left of what is
  // written, and not behind.
  const ahead = sight(compileBlueprint(createStructuredTemplate('ifv')), 'command');
  assert.deepEqual([ahead.range, ahead.left, ahead.right], [650, 650, 0]);
  assert(within(openArcs(ahead), Math.PI) && !within(openArcs(ahead), 0));
  assert.equal(sightText(ahead), 'vê 650 m à frente, nada atrás');
  assert.equal(sightText({ ...ahead, left: 0, right: 650 }), 'vê 650 m atrás, nada à frente');
  // The plate under the glacis is below it: through that one it sees the ground before the hull and nothing level.
  const down = sight(glazed('hull:front'), 'command'), open = openArcs(down);
  assert.deepEqual([down.range, down.left, down.right], [650, 0, 0]);
  assert.equal(open.length, 1); assert(Math.cos((open[0][0] + open[0][1]) / 2) < 0 && Math.sin(open[0][0]) < 0 && Math.sin(open[0][1]) < 0, 'ahead and downwards');
  assert.equal(sightText(down), 'sem visão ao nível do solo');
});

test('the sight of an optic is drawn as a fan for each open arc, down to the ground and no lower, with the lines it sees out level along', () => {
  const camera = sight(compileBlueprint(createStructuredTemplate('ifv')), 'sensor-0'), figure = sightFigure(camera, 30, 0);
  assert.equal(figure.fans.length, 1);
  const [fan] = figure.fans, points = Array.from({ length: fan.points.length / 2 }, (_, i) => ({ x: fan.points[i * 2], y: fan.points[i * 2 + 1] }));
  assert.deepEqual(points[0], { x: camera.x, y: camera.y });
  assert(points.every(point => point.y >= -1e-9), 'nothing of it is under the ground');
  // It reaches as far as asked, or as far as the ground where a line meets it sooner.
  const far = points.slice(1).map(point => Math.hypot(point.x - camera.x, point.y - camera.y));
  assert(points.slice(1).every((point, i) => Math.abs(far[i] - 30) < 1e-9 || far[i] < 30 && Math.abs(point.y) < 1e-9 && point.y < camera.y));
  assert(far.some(length => length < 30) && !fan.whole && fan.edges.length === 2);
  assert.deepEqual(figure.level.map(([x, y]) => [Math.round((x - camera.x) * 1e6) / 1e6, Math.round((y - camera.y) * 1e6) / 1e6]), [[-30, 0], [30, 0]]);
  // With no ground told it goes out the whole way all around what is open; one that sees to one side has one line.
  assert(sightFigure(camera, 30).fans[0].points.every((value, i, all) => i < 2 || i % 2 || Math.abs(Math.hypot(value - camera.x, all[i + 1] - camera.y) - 30) < 1e-9));
  assert.equal(sightFigure({ ...camera, right: 0 }, 30, 0).level.length, 1);
  assert.equal(sightFigure({ ...camera, hidden: [] }, 30).fans[0].whole, true);
  // Ground that rises stops a line where the line meets it: a wall ten metres ahead lets nothing of the fan past it.
  const walled = sightFigure(camera, 30, x => x < camera.x - 10 ? 100 : 0).fans[0].points;
  assert(walled.every((value, i) => i % 2 || value > camera.x - 10 - 1e-6) && walled.some((value, i) => !(i % 2) && value < camera.x - 9.9));
  assert.deepEqual(sightFigure(camera, 30, () => camera.y + 1).fans, []);
  // What is drawn: a glow, the fan laid ring over ring from its outline in to the optic, each as faint as the
  // other; its outline; its two edges and the level lines, thinning out; and about the optic the dial of what is
  // open and what is hidden. Nothing of it goes past the reach. Shut in, a ring around the optic and nothing else.
  const calls = [], g = new Proxy({}, { get: (_, name) => (...args) => { calls.push([name, args]); return g; } });
  drawSight(g, camera, 30, 0, .01);
  const fills = calls.map(([name, args], i) => name === 'fill' ? { ...args[0], points: calls[i - 1][1][0] } : null).filter(Boolean),
    strokes = calls.filter(([name]) => name === 'stroke').map(([, args]) => args[0]);
  assert(fills.length > 8 && fills.every(fill => fill.alpha === fills[0].alpha && fill.points.length === fan.points.length));
  assert(fills[0].points.every((value, i) => Math.abs(value - fan.points[i]) < 1e-9));
  const reach = points => Math.max(...Array.from({ length: points.length / 2 }, (_, i) => Math.hypot(points[i * 2] - camera.x, points[i * 2 + 1] - camera.y)));
  assert(fills.every((fill, i) => !i || reach(fill.points) < reach(fills[i - 1].points)) && reach(fills.at(-1).points) < 30 / 8);
  const drawn = calls.filter(([name]) => name === 'moveTo' || name === 'lineTo').map(([, [x, y]]) => Math.hypot(x - camera.x, y - camera.y));
  assert(drawn.length > 30 && drawn.every(far => far <= 30 + 1e-9));
  assert(strokes.some(stroke => stroke.alpha > .9) && strokes.every((stroke, i) => stroke.alpha > 0));
  assert.equal(new Set(strokes.map(stroke => stroke.color)).size, 2, 'the tone of what is open and the tone of what is hidden');
  calls.length = 0; drawSight(g, { ...camera, range: 0, left: 0, right: 0, hidden: [[-Math.PI, Math.PI]] }, 30, 0, .01);
  assert.deepEqual(calls.map(([name]) => name), ['circle', 'stroke']); assert.deepEqual(calls[0][1].slice(0, 2), [camera.x, camera.y]);
});
