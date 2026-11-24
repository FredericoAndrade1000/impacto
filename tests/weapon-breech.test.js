import test from 'node:test';
import assert from 'node:assert/strict';
import { initNativeDynamics } from '../src/native-dynamics.ts';
import { compileStructuredConstruction } from '../src/structured-construction.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { createStructuredTemplate } from '../src/structured-templates.ts';
import { World } from '../src/physics.ts';
import { Renderer } from '../src/render.ts';
import { recoilAt } from '../src/weapons.ts';
import { weaponRecoilGuide } from '../src/weapon-art.ts';
import { DESIGN_VERSION } from '../src/persistence.ts';

await initNativeDynamics();

const node = (id, x, y) => ({ id, x, y }), plate = (id, a, b) => ({ id, a, b, material: 'steel', thicknessMm: 20 });
// A box that stands fixed, `height` cells high, with the gun of a tank in the middle of its front and what else is asked in
// it, written in cells of 5 cm.
function box(height, sector, components = []) {
  return { version: DESIGN_VERSION, preset: 'bunker', name: 'Breech fixture',
    nodes: [node('hull-0', -58, 0), node('hull-1', 58, 0), node('hull-2', 58, height), node('hull-3', -58, height)],
    plates: [plate('hull:floor', 'hull-0', 'hull-1'), plate('hull:rear', 'hull-1', 'hull-2'),
      plate('hull:roof', 'hull-2', 'hull-3'), plate('hull:front', 'hull-3', 'hull-0')],
    components: [{ id: 'gun', kind: 'weapon', weaponPreset: 'rh120', pose: { x: -53, y: height / 2, angle: Math.PI },
      mount: { preset: 'heavy-trunnion', radiusM: .28, ...(sector ? { sector } : {}) } }, ...components] };
}
const refusal = source => { try { compileStructuredConstruction(source); } catch (error) { return error; } return null; };

test('the player is told where the breech, turned with its gun, meets a roof, a floor or a piece, with the bore at what angle', () => {
  // Raised 29 degrees in a box 1.2 m high, the 1.65 m of the breech of the 120 mm and its recoil reach its floor; laid
  // down 20 degrees, its roof.
  const floor = refusal(box(24, { min: -.5, max: 0 })), roof = refusal(box(24, { min: 0, max: .35 }));
  assert.equal(floor.reason, 'BREECH_PLATE'); assert(floor.ids.includes('hull:floor'));
  assert.equal(floor.surface, 'floor'); assert(floor.angleDegrees > 0);
  assert.match(constructionEditMessage(floor), /^A culatra, que gira com o cano, bateria no piso com o cano a \d+° para cima\. Reduza o setor ou mude a arma de lugar\.$/);
  assert.match(constructionEditMessage(roof), /^A culatra, que gira com o cano, bateria no teto com o cano a \d+° para baixo\./);
  // A piece in the fan it sweeps is met, highlighted as overlapping pieces are.
  const piece = refusal(box(44, { min: -.5, max: .35 }, [{ id: 'command', kind: 'command', pose: { x: -45, y: 25, angle: 0 } }]));
  assert.equal(piece.code, 'CONSTRUCTION_OVERLAP');
  assert.equal(constructionEditMessage(piece), 'A culatra, que gira com o cano, bateria na peça destacada com o cano nivelado. Afaste a peça ou reduza o setor.');
});


test('the M777 recoils its whole stroke low and less from 35 to 55 degrees up; the others as far at any angle', () => {
  const degrees = d => d * Math.PI / 180;
  assert.deepEqual([0, 35, 45, 55, 70].map(d => Math.round(recoilAt('m777', degrees(d)) * 1e6) / 1e6), [1.4, 1.4, 1.12, .84, .84]);
  assert.deepEqual([0, 45, 70].map(d => recoilAt('m119', degrees(d))), [.635, .635, .635]);
  assert.equal(recoilAt('unknown', 0), 0);
});

test('a gun that fires is drawn recoiling its whole stroke at the elevation of its bore over its hull', () => {
  // The Paladin's gun, its mount on the front of its tower, which leans back 0.6 rad (on the grid 17 cells back over 25
  // up, 0.597 rad): laid at its rest it stands 34 degrees up, and the M777 there recoils its whole 1.4 m; laid 0.6 rad
  // higher, 69 degrees up, only 0.84 m.
  const world = new World(createStructuredTemplate('howitzer')), gun = world.modules.find(m => m.kind === 'weapon'),
    lean = Math.atan2(17, 25);
  try {
    const stroke = barrelAngle => Renderer.prototype.recoilStroke.call({ scene: { pose: () => ({ ...gun, barrelAngle }) } }, gun.id);
    assert(Math.abs(gun.weaponMount.hullAxis - (Math.PI - lean)) < 1e-6, String(gun.weaponMount.hullAxis));
    assert.equal(stroke(gun.angle), 1.4);
    assert.equal(stroke(gun.angle - .6), .84);
    // The workshop shows the room its breech recoils into as long, where it is laid.
    assert.deepEqual([0, -.6].map(turn => weaponRecoilGuide({ ...gun, barrelAngle: gun.angle + turn }).stroke), [1.4, .84]);
    // Turned about, its mount looks the other way over its hull, and it recoils as far at the same elevation.
    world.addActor(createStructuredTemplate('howitzer'), { id: 'other', ownerId: 'other', x: 60, facing: 1 });
    const other = world.modules.find(m => m.actorId === 'other' && m.kind === 'weapon');
    assert(Math.abs(other.weaponMount.hullAxis - lean) < 1e-6, String(other.weaponMount.hullAxis));
    assert.equal(Renderer.prototype.recoilStroke.call({ scene: { pose: () => ({ ...other, barrelAngle: other.angle + .6 }) } }, other.id), .84);
  } finally { world.dispose(); }
});
