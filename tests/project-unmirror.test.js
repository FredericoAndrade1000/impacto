import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { compileBlueprint, parseBlueprint } from '../src/persistence.ts';
import { DesignLibrary, LIBRARY_KEY } from '../src/library.ts';
import { unmirrored } from '../src/project-unmirror.ts';

await initNativeDynamics();

// Recreate the retired editor operation using built-in designs. The input has
// only project geometry and does not require a room, a player or a seat.
const TEMPLATES = ['heavy', 'grader', 'truck'];
function mirroredOf(id) {
  const design = createStructuredTemplate(id), { chassis } = design;
  const flip = value => value ? -value : 0;
  const toggle = ({ mirrored, ...piece }) => mirrored ? piece : { ...piece, mirrored: true };
  const lastSegment = chassis.points.length - 2;
  const points = chassis.points.map(({ gap, ...point }, index) => ({
    ...point, x: flip(point.x), ...(chassis.points[index - 1]?.gap ? { gap: true } : {}),
  })).reverse();
  if (chassis.axles) chassis.axles = chassis.axles.map(flip).reverse();
  if (chassis.track) {
    const { front, rear } = chassis.track;
    Object.assign(chassis.track, { front: flip(rear), rear: flip(front) });
  }
  Object.assign(chassis, { points, mirrored: true });
  for (const component of design.components) {
    const { pose } = component;
    component.pose = toggle({ ...pose, x: flip(pose.x), angle: flip(pose.angle) });
  }
  for (const node of design.nodes) node.x = flip(node.x);
  if (design.appearance?.details) design.appearance.details = design.appearance.details.map(detail => {
    if (detail.surface === 'part') return detail;
    const host = detail.host?.replace(/^chassis:(top|frame|rail)-(\d+)$/, (match, tag, segment) =>
      Number(segment) <= lastSegment ? `chassis:${tag}-${lastSegment - Number(segment)}` : match);
    return toggle({ ...detail, host, ...(detail.space === 'project' || detail.surface === 'chassis'
      ? { x: flip(detail.x), angle: flip(detail.angle) }
      : { y: flip(detail.y), angle: -detail.angle - Math.PI }) });
  });
  return design;
}
function store(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
}

test('a mirrored project is read once the right way round: the very design turning it about once more makes of it', () => {
  for (const id of TEMPLATES) {
    const old = mirroredOf(id);
    assert.equal(old.chassis.mirrored, true);
    assert.deepEqual(unmirrored(old), createStructuredTemplate(id));
  }
  // Anything else is given back as it is.
  for (const value of [createStructuredTemplate('heavy'), createStructuredTemplate('bunker'), null, 'texto', { chassis: { mirrored: true } }])
    assert.equal(unmirrored(value), value);
});

test('the core and the import refuse the mark of a project turned about whole', () => {
  const old = mirroredOf('heavy');
  assert.throws(() => compileBlueprint(old));
  assert.throws(() => parseBlueprint(JSON.stringify(old)));
  assert.doesNotThrow(() => compileBlueprint(unmirrored(old)));
});

test('the garage reads a mirrored project the right way round and keeps it so', () => {
  const heavy = createStructuredTemplate('heavy'), bunker = createStructuredTemplate('bunker');
  const browser = store({ [LIBRARY_KEY]: JSON.stringify({ version: 4, activeId: 'a', entries: [
    { id: 'a', createdAt: '2026-10-01', updatedAt: '2026-10-02', blueprint: mirroredOf('heavy') },
    { id: 'b', createdAt: '2026-10-01', updatedAt: '2026-10-01', blueprint: bunker }] }) });
  const garage = new DesignLibrary(browser);
  assert.equal(garage.error, null);
  assert.deepEqual(garage.get('a').blueprint, heavy); assert.deepEqual(garage.get('b').blueprint, bunker);
  const kept = JSON.parse(browser.getItem(LIBRARY_KEY));
  assert.equal(kept.entries.some(entry => entry.blueprint.chassis?.mirrored), false);
  assert.deepEqual(kept.entries.map(entry => [entry.createdAt, entry.updatedAt]), [['2026-10-01', '2026-10-02'], ['2026-10-01', '2026-10-01']]);
  const text = browser.getItem(LIBRARY_KEY);
  new DesignLibrary(browser); assert.equal(browser.getItem(LIBRARY_KEY), text);
});
