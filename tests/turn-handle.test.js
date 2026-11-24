import test from 'node:test';
import assert from 'node:assert/strict';
import { Editor } from '../src/editor.ts';
import { createStructuredConstruction } from '../src/structured-construction.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { TURN_STEP } from '../src/detail-gestures.ts';
import { turnMagnets, turnedHeading, turnPiece } from '../src/turn-handle.ts';
import { applySettings } from '../src/piece-settings.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { wrapAngle } from '../src/math.ts';
await initNativeDynamics();
const DEG = Math.PI / 180;
const near = (a, b, message) => assert(Math.abs(wrapAngle(a - b)) < 1e-8, `${message ?? ''} ${a} != ${b}`);
const room = () => new Editor(createStructuredConstruction({ preset: 'bunker', length: 6, height: 2, frontInset: 0, rearInset: 0, thicknessMm: 20 }));
const bare = () => { const e = room(); return new Editor({ ...e.source, nodes: [], plates: [], components: [] }); };
const part = (e, id) => e.source.components.find(candidate => candidate.id === id);
// A point `distance` from `pivot`, `angle` round.
const toward = (pivot, angle, distance = 1) => ({ x: pivot.x + Math.cos(angle) * distance, y: pivot.y + Math.sin(angle) * distance });
// A camera standing on the roof of the room, selected.
function roofCamera() {
  const e = room(), roof = e.blueprint.plates.find(p => p.id === 'hull:roof'),
    camera = e.addModule('sensor', { x: roof.x + .3, y: roof.y + roof.thicknessMm / 2000 + .15 }, { sensorMode: 'visual', faceTolerance: .08 });
  e.select(camera.id); return e;
}

test('the handle turns a piece in steps of 15° about its pivot, and with Shift as the pointer puts it', () => {
  const pivot = { x: 3, y: 2 };
  // Above the piece: the handle a quarter turn round from its heading.
  near(turnedHeading(pivot, Math.PI / 2, toward(pivot, (90 + 40) * DEG)), 45 * DEG);
  near(turnedHeading(pivot, Math.PI / 2, toward(pivot, (90 + 37) * DEG)), 30 * DEG);
  near(turnedHeading(pivot, Math.PI / 2, toward(pivot, (90 + 40) * DEG), [], true), 40 * DEG);
  near(turnedHeading(pivot, Math.PI / 2, toward(pivot, -90 * DEG)), Math.PI, 'upside down');
  // Behind a gun: its bore runs from the pointer through the trunnion.
  near(turnedHeading(pivot, Math.PI, toward(pivot, (180 + 22) * DEG)), 15 * DEG);
  near(turnedHeading(pivot, Math.PI, toward(pivot, 0)), Math.PI);
  for (let step = -12; step < 12; step++) near(turnedHeading(pivot, 0, toward(pivot, step * TURN_STEP + .1 * DEG)), step * TURN_STEP);
});

test('a magnet takes the turn where it is nearer than the nearest step, never with Shift', () => {
  const pivot = { x: 0, y: 0 }, slope = 34.38 * DEG, magnets = [slope, slope + Math.PI / 2];
  near(turnedHeading(pivot, 0, toward(pivot, 33.5 * DEG), magnets), slope);
  near(turnedHeading(pivot, 0, toward(pivot, 36 * DEG), magnets), slope);
  near(turnedHeading(pivot, 0, toward(pivot, 31 * DEG), magnets), 30 * DEG, 'the step is nearer');
  near(turnedHeading(pivot, 0, toward(pivot, 125 * DEG), magnets), slope + Math.PI / 2);
  near(turnedHeading(pivot, 0, toward(pivot, 33.5 * DEG), magnets, true), 33.5 * DEG);
  near(turnedHeading(pivot, 0, toward(pivot, 33.5 * DEG), []), 30 * DEG);
});

test('a piece settles flush with a sloping plate it sits against, along it and square to it either way round', () => {
  const e = bare(); e.addPlate({ x: 11, y: 3 }, { x: 14, y: 5 });
  const slope = Math.atan2(2, 3), camera = e.addModule('sensor', { x: 12.5, y: 4.3 }, { sensorMode: 'visual', faceTolerance: .08 });
  const magnets = turnMagnets(e.blueprint.plates, e.blueprint.modules.find(m => m.id === camera.id));
  assert.equal(magnets.length, 4);
  for (let quarter = 0; quarter < 4; quarter++) assert(magnets.some(m => Math.abs(wrapAngle(m - slope - quarter * Math.PI / 2)) < 1e-9), `quarter ${quarter}`);
  // Far from any plate, a piece has the steps alone.
  const alone = e.addModule('sensor', { x: 16, y: 8 }, { sensorMode: 'visual' });
  assert.deepEqual(turnMagnets(e.blueprint.plates, e.blueprint.modules.find(m => m.id === alone.id)), []);
});

test('a gun settles square out of the plate it fires through, and on nothing else', () => {
  const e = bare(), wall = e.addPlate({ x: 12, y: 3 }, { x: 12.6, y: 5 }),
    gun = e.addModule('weapon', { x: 12.3, y: 4 }, { weaponPreset: 'm2hb', faceTolerance: .08 });
  assert.equal(gun.weaponMount.hostId, wall.id);
  const magnets = turnMagnets(e.blueprint.plates, gun), normal = e.blueprint.plates.find(p => p.id === wall.id).angle + Math.PI / 2;
  assert.equal(magnets.length, 1);
  assert(Math.abs(Math.sin(magnets[0] - normal)) < 1e-9, 'square to the wall');
});

test('a turn is the Ângulo of the bar: admitted as one change of the history, which one undo takes back', () => {
  const e = roofCamera(), id = e.selection, before = structuredClone(e.source), past = e.past.length;
  e.commit(); e.begin();
  assert.equal(turnPiece(e, 90 * DEG), true, 'a quarter turn would put a corner through the roof');
  assert.equal(turnPiece(e, Math.PI), false);
  near(part(e, id).pose.angle, Math.PI);
  assert.equal(turnPiece(e, -Math.PI), false, 'the same heading the other way round asks nothing');
  assert(e.commit());
  assert.equal(e.past.length, past + 1);
  near(part(e, id).pose.angle, Math.PI);
  e.undo(); assert.deepEqual(e.source, before);
});

test('a turn asks what the Ângulo of the bar asks: the same pose admitted, the same refusal', () => {
  const turned = roofCamera(), typed = roofCamera();
  turned.begin(); turnPiece(turned, Math.PI); turned.commit();
  applySettings(typed, 'angle', new Map([[typed.selection, Math.PI]]));
  assert.deepEqual(part(turned, turned.selection).pose, part(typed, typed.selection).pose);
  const refused = roofCamera(), bar = roofCamera();
  refused.begin(); assert(turnPiece(refused, 45 * DEG)); refused.cancel();
  assert.throws(() => applySettings(bar, 'angle', new Map([[bar.selection, 45 * DEG]])), error => constructionEditMessage(error) === refused.blockedEdit.message);
});

test('a refused turn leaves the piece as it stood, says why, and is forgotten back on its own heading', () => {
  const e = roofCamera(), id = e.selection, before = structuredClone(e.source), past = e.past.length;
  e.commit(); e.begin();
  assert.equal(turnPiece(e, 45 * DEG), true);
  assert.deepEqual(e.source, before, 'nothing of the turn refused is kept');
  assert.equal(part(e, id).pose.angle, 0);
  assert.match(e.blockedEdit.message, /\S/);
  assert(e.blockedEdit.ids.includes(id), 'the piece refused is shown');
  assert.equal(turnPiece(e, 0), false);
  assert.equal(e.blockedEdit, null);
  assert.equal(e.commit(), false, 'only refused, the turn changes nothing');
  assert.equal(e.past.length, past);
  assert.deepEqual(e.source, before);
});

for (const mirrored of [false, true]) test(`a gun is turned by the heading of its bore, the angle written as its author writes it, mirrored=${mirrored}`, () => {
  const e = bare(), gun = e.addModule('weapon', { x: 13, y: 6 }, { weaponPreset: 'm2hb', mirrored });
  e.select(gun.id);
  near(gun.angle, part(e, gun.id).pose.angle + (mirrored ? Math.PI : 0), 'drawn the other way round');
  const heading = gun.angle + (mirrored ? -1 : 1) * 15 * DEG, before = structuredClone(e.source);
  e.begin();
  assert.equal(turnPiece(e, heading), false);
  assert(e.commit());
  near(e.selected.angle, heading, 'the bore');
  near(part(e, gun.id).pose.angle, heading - (mirrored ? Math.PI : 0), 'as written');
  e.undo(); assert.deepEqual(e.source, before);
});
