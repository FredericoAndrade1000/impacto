import test from 'node:test';
import assert from 'node:assert/strict';
import { createConstruction } from '../src/construction-templates.ts';
import { parseBlueprint } from '../src/persistence.ts';
import { chassisFront, chassisTrack, trackLengthRange, writtenTrack } from '../src/chassis.ts';
import { projectRefusalMessage } from '../src/project-refusal.ts';
import { constructionEditMessage } from '../src/structured-editing.ts';
import { initNativeDynamics } from '../src/native-dynamics.ts';

await initNativeDynamics();

const part = (project, id) => project.components.find(piece => piece.id === id);
const plate = (project, id) => project.plates.find(piece => piece.id === id);
// A stock design written out, edited by hand and brought back in as a file: the code the core refuses it with, and
// what the player is told.
function brought(template, edit) {
  const project = createConstruction(template); edit(project);
  const text = JSON.stringify(project);
  try { parseBlueprint(text); } catch (error) { return [error.reason, projectRefusalMessage(error, JSON.parse(text))]; }
  return ['aceito', ''];
}
// A stock design on wheels written over by hand as an aircraft, its skids as `skids` writes them from the ends of its
// chassis, in cells.
const flown = (p, skids) => {
  const { axles, armorMm, ...chassis } = p.chassis;
  p.chassis = { ...chassis, model: 'aircraft', skids: skids(chassis.points[0].x, chassis.points.at(-1).x) };
};
// Each code an edited file meets, by one edit of a stock design, with the sentence it is told in.
const EDITS = [
  ['AUTHORING_FIELDS', 'heavy', p => { p.cor = 'verde'; }, 'Chave desconhecida "cor" no projeto.'],
  ['AUTHORING_FIELDS', 'heavy', p => { plate(p, 'hull:roof').cor = 1; plate(p, 'hull:roof').peso = 2; }, 'Chaves desconhecidas "cor", "peso" na chapa "hull:roof".'],
  ['AUTHORING_FIELDS', 'heavy', p => { part(p, 'weapon').pose.foo = 1; }, 'Chave desconhecida "foo" em "pose" no componente "weapon".'],
  ['AUTHORING_FIELDS', 'heavy', p => { part(p, 'weapon').mount.sector.mid = 0; }, 'Chave desconhecida "mid" em "mount.sector" no componente "weapon".'],
  ['AUTHORING_FIELDS', 'heavy', p => { p.chassis.cor = 1; }, 'Chave desconhecida "cor" no chassi.'],
  ['AUTHORING_FIELDS', 'heavy', p => { p.nodes[0].z = 0; }, 'Chave desconhecida "z" no nó "hull-0".'],
  ['AUTHORING_FIELDS', 'heavy', p => { part(p, 'engine').potencia = 900; }, 'Chave desconhecida "potencia" no componente "engine".'],
  ['AUTHORING_OBJECT', 'guard-post', p => { p.nodes[2] = 'nó'; }, 'O nó nº 3 precisa ser um objeto { }.'],
  ['AUTHORING_OBJECT', 'scout', p => { p.chassis = 'rodas'; }, 'O chassi precisa ser um objeto { }.'],
  ['AUTHORING_LIMIT', 'guard-post', p => { for (let i = 0; i < 49; i++) p.components.push({ ...part(p, 'sensor'), id: 's' + i }); }, 'O projeto tem mais de 48 componentes, o limite.'],
  ['FIELD', 'heavy', p => { plate(p, 'hull:roof').thicknessMm = -5; }, 'A chapa "hull:roof": espessura -5 mm fora de 5–1000 mm.'],
  ['FIELD', 'heavy', p => { plate(p, 'hull:roof').thicknessMm = 'grossa'; }, 'A chapa "hull:roof": "thicknessMm" precisa ser um número.'],
  ['FIELD', 'heavy', p => { p.nodes[0].x = 180; }, 'O nó "hull-0": x 180 casas fora de -120 a 120 casas.'],
  ['FIELD', 'heavy', p => { part(p, 'engine').sizeScale = 9; }, 'Componente "engine": tamanho ("sizeScale") 9 fora de 0,25–3,8.'],
  ['FIELD', 'guard-post', p => { part(p, 'command').sizeScale = 2; }, 'Componente "command": tamanho ("sizeScale") 2, mas só pode ser 1.'],
  ['FIELD', 'heavy', p => { part(p, 'weapon').mount.sector = { min: -3, max: .1 }; }, 'Componente "weapon": "mount.sector.min" -3 rad fora de -0,6 a 0,6 rad.'],
  ['FIELD', 'scout', p => { p.chassis.points[0].x = -180; delete p.chassis.axles; }, 'O ponto nº 1 do chassi: x -180 casas fora de -120 a 120 casas.'],
  ['AUTHORING_EXTENT', 'scout', p => { p.chassis.points[1].y = 180; }, 'O ponto nº 2 do chassi passa de 8 m acima do chão.'],
  ['AUTHORING_EXTENT', 'heavy', p => { p.nodes[0].y = -40; }, 'O nó "hull-0" fica abaixo do chão.'],
  ['AUTHORING_EXTENT', 'heavy', p => { part(p, 'engine').pose.y = -26; }, 'Componente "engine" fica abaixo do chão.'],
  ['AUTHORING_EXTENT', 'scout', p => { for (const point of p.chassis.points) point.y = -24; }, 'O chassi fica abaixo do chão.'],
  ['FIELD', 'scout', p => { p.chassis.armorMm = 500; }, 'O chassi: blindagem da rodagem 500 mm fora de 0–40 mm.'],
  ['FIELD', 'heavy', p => { p.chassis.track = { front: 'a', rear: 1, y: 0 }; }, 'O chassi: "track.front" precisa ser um número.'],
  ['FIELD', 'heavy', p => { const track = chassisTrack(p.chassis); p.chassis.track = writtenTrack(p.chassis, track.front, track.rear); delete p.chassis.track.y; }, 'O chassi: falta "track.y".'],
  ['FIELD', 'heavy', p => { const track = chassisTrack(p.chassis); p.chassis.track = { ...writtenTrack(p.chassis, track.front, track.rear), y: null }; }, 'O chassi: "track.y" precisa ser um número.'],
  ['FIELD', 'guard-post', p => { p.launcher = { x: 99, y: 1 }; }, 'O projeto: "launcher.x" 99 m fora de -15 a 50 m.'],
  ['FIELD', 'guard-post', p => { delete part(p, 'sensor').pose.x; }, 'Componente "sensor": falta "pose.x".'],
  ['FIELD', 'guard-post', p => { p.name = 7; }, 'O projeto: "name" precisa ser um texto entre aspas.'],
  ['FIELD', 'guard-post', p => { p.nodes = {}; }, 'O projeto: "nodes" precisa ser uma lista [ ].'],
  ['FIELD', 'heavy', p => { part(p, 'weapon').weaponPreset = 'laser'; }, 'Componente "weapon": arma "laser" não existe.'],
  ['FIELD', 'guard-post', p => { part(p, 'weapon-ammo').ammoPreset = 'nope'; }, 'Componente "weapon-ammo": calibre "nope" não existe.'],
  ['FIELD', 'heavy', p => { part(p, 'weapon').mount.preset = 'torre'; }, 'Componente "weapon": montagem "torre" não existe ("light-trunnion", "medium-trunnion", "heavy-trunnion", "elevated-trunnion", "roof-mortar" ou "pintle").'],
  ['FIELD', 'scout', p => { p.chassis.metal = 'ouro'; }, 'O chassi: metal "ouro" não existe ("steel", "aluminum" ou "titanium").'],
  ['FIELD', 'heavy', p => { part(p, 'fuel').metal = 'ouro'; }, 'Componente "fuel": metal "ouro" não existe ("steel", "aluminum", "titanium", "fiberglass" ou "plastic").'],
  ['FIELD', 'heavy', p => { part(p, 'engine').metal = 'fiberglass'; }, 'Componente "engine": metal "fiberglass" não serve aqui ("steel", "aluminum" ou "titanium").'],
  ['FIELD', 'heavy', p => { part(p, 'engine').metal = 'plastic'; }, 'Componente "engine": metal "plastic" não serve aqui ("steel", "aluminum" ou "titanium").'],
  ['FIELD', 'heavy', p => { part(p, 'sensor-0').metal = 'titanium'; }, 'Componente "sensor-0": metal "titanium" não serve aqui ("steel", "fiberglass" ou "plastic").'],
  ['FIELD', 'heavy', p => { Object.assign(part(p, 'sensor-0'), { sensorMode: 'radar', radarModel: 'mobile', metal: 'plastic' }); },
    'Componente "sensor-0": metal "plastic" não serve aqui ("steel" ou "fiberglass").'],
  ['FIELD', 'scout', p => { p.chassis.metal = 'fiberglass'; }, 'O chassi: metal "fiberglass" não serve aqui ("steel", "aluminum" ou "titanium").'],
  ['ARMOUR_MATERIAL', 'heavy', p => { plate(p, 'hull:roof').material = 'madeira'; }, 'A chapa "hull:roof": material "madeira" não existe ("steel", "aluminum", "ceramic", "concrete", "hha", "titanium", "fiberglass" ou "glass").'],
  ['ARMOUR_MATERIAL', 'heavy', p => { plate(p, 'hull:roof').material = 'plastic'; }, 'A chapa "hull:roof": material "plastic" não existe ("steel", "aluminum", "ceramic", "concrete", "hha", "titanium", "fiberglass" ou "glass").'],
  ['COMPONENT_KIND', 'heavy', p => { part(p, 'engine').kind = 'foguete'; }, 'Componente "engine": tipo "foguete" não existe ("sensor", "command", "engine", "weapon", "fuel", "ammo", "hopper", "cistern", "supply", "excavator", "drill", "builder", "blade", "paver" ou "thruster").'],
  ['CHASSIS_GEAR', 'scout', p => { p.components.push({ id: 'roda', kind: 'wheel', pose: { x: 0, y: 0, angle: 0 } }); }, 'Componente "roda": o tipo "wheel" vem com o chassi e não é um componente.'],
  ['PLATE_NODE', 'heavy', p => { plate(p, 'hull:roof').b = 'nada'; }, 'A chapa "hull:roof" liga o nó "nada", que não existe.'],
  ['SENSOR_MODE', 'guard-post', p => { part(p, 'sensor').sensorMode = 'sonar'; }, 'Componente "sensor": sensor "sonar" não existe ("visual", "radar" ou "sound").'],
  ['THRUSTER_ANGLE', 'heavy', p => { Object.assign(part(p, 'engine'), { kind: 'thruster', metal: 'titanium', sizeScale: 1 }).pose.angle = .5; },
    'Componente "engine": um propulsor aponta de 45 em 45° (um "angle" múltiplo de π/4), não 0,5 rad.'],
  ['FIELD', 'heavy', p => { Object.assign(part(p, 'engine'), { kind: 'thruster', sizeScale: 1 }); }, 'Componente "engine": falta "metal".'],
  ['WEAPON_AMMUNITION', 'heavy', p => { part(p, 'weapon').weaponAmmo = 'nuke'; }, 'Componente "weapon": munição "nuke" não serve nesta arma ("apfsds", "heat" ou "he").'],
  ['AMMUNITION_MISMATCH', 'heavy', p => { p.components.push({ ...structuredClone(part(p, 'weapon')), id: 'weapon-2', weaponAmmo: 'heat' }); }, 'Componente "weapon-2": munição "heat", mas outra arma do mesmo calibre usa "apfsds"; um calibre usa uma só.'],
  ['CONSTRUCTION_VERSION', 'heavy', p => { p.preset = 'tanque'; }, 'O tipo de projeto "tanque" não existe ("vehicle" ou "bunker").'],
  ['CHASSIS_MODEL', 'heavy', p => { p.chassis.model = 'hover'; }, 'O chassi "hover" não existe ("wheeled", "tracked" ou "aircraft").'],
  ['PAINT', 'guard-post', p => { p.appearance = { paint: 'verde' }; }, '"appearance.paint" "verde" não é uma cor: use "#rrggbb".'],
  ['TERRAIN', 'guard-post', p => { p.terrain = ''; }, '"terrain" precisa ser um texto de 1 a 64 letras.'],
  ['IDENTITY', 'heavy', p => { p.plates[1].id = 'a b'; }, 'A chapa nº 2: id "a b" não serve: um id tem só letras, números, "_", "-" e ":", até 64.'],
  ['IDENTITY', 'guard-post', p => { p.plates[0].a = 'a b'; }, 'A chapa "hull:floor": nó "a b" não serve: um id tem só letras, números, "_", "-" e ":", até 64.'],
  ['CHASSIS_IDENTITY', 'guard-post', p => { part(p, 'sensor').id = 'chassis:olho'; }, 'Componente nº 4: o id "chassis:olho" começa com "chassis:", que é das peças do chassi.'],
  ['NODE_IDENTITY', 'guard-post', p => { p.nodes[1].id = 'hull-0'; }, 'O id "hull-0" se repete: cada nó, chapa e componente tem o seu.'],
  ['PLATE_IDENTITY', 'guard-post', p => { p.plates[1].id = 'hull-0'; }, 'O id "hull-0" se repete: cada nó, chapa e componente tem o seu.'],
  ['COMPONENT_IDENTITY', 'heavy', p => { p.components[0].id = 'hull:rear'; }, 'O id "hull:rear" se repete: cada nó, chapa e componente tem o seu.'],
  ['PLATE_LENGTH', 'guard-post', p => { p.nodes[1].x = p.nodes[0].x + 1; p.components = []; }, 'A chapa "hull:floor" tem 0,05 m: uma chapa vai de 0,08 a 12 m.'],
  ['PLATE_REPEATED', 'guard-post', p => { p.plates.push({ ...p.plates[0], id: 'outra' }); }, 'A chapa "outra" repete a chapa "hull:floor": as duas ligam os mesmos nós.'],
  ['PLATE_LENGTH', 'guard-post', p => { p.plates[1].b = p.plates[1].a; }, 'A chapa "hull:rear" tem 0 m: uma chapa vai de 0,08 a 12 m.'],
  ['ARMOUR_FIXED', 'scout', p => { Object.assign(plate(p, 'hull:roof'), { material: 'concrete', thicknessMm: 400 }); }, 'A chapa "hull:roof": material "concrete" só serve numa construção fixa ("bunker").'],
  ['CHASSIS_REQUIRED', 'scout', p => { delete p.chassis; }, 'Um veículo ("vehicle") precisa de "chassis".'],
  ['CHASSIS_FIXED', 'guard-post', p => { p.chassis = { model: 'wheeled', points: [{ x: -1.2, y: 0 }, { x: 1.2, y: 0 }] }; }, 'Uma construção fixa ("bunker") não leva "chassis".'],
  ['CHASSIS_LENGTH', 'scout', p => { p.chassis.points = [{ x: -4, y: 0 }, { x: 4, y: 0 }]; delete p.chassis.axles; }, 'O chassi tem 0,4 m do primeiro ao último ponto: este vai de 2,5 a 12 m.'],
  ['CHASSIS_GEAR_KIND', 'heavy', p => { p.chassis.axles = [-1, 1]; }, 'Um chassi de esteiras ("tracked") não leva "axles" nem "skids".'],
  ['CHASSIS_GEAR_KIND', 'scout', p => { p.chassis.track = { front: -1, rear: 1 }; }, 'Um chassi de rodas ("wheeled") não leva "track" nem "skids".'],
  ['CHASSIS_GEAR_KIND', 'scout', p => { p.chassis.skids = { front: -20, rear: 20, legs: [-10, 10] }; }, 'Um chassi de rodas ("wheeled") não leva "track" nem "skids".'],
  ['CHASSIS_GEAR_KIND', 'scout', p => { flown(p, () => ({ front: -20, rear: 20, legs: [-10, 10] })); p.chassis.axles = [-10, 10]; },
    'Uma aeronave ("aircraft") não leva "axles" nem "track": fica sobre esquis ("skids").'],
  ['SKID_EXTENT', 'scout', p => flown(p, (front, rear) => ({ front: front - 1, rear, legs: [front + 10, rear - 10] })),
    'O chassi: o patim dos esquis ("skids") passa do primeiro ou do último ponto.'],
  // The scout's gear is smaller than the model's: so are its skids, and a leg stands nearer the ends of their runner.
  ['SKID_RUNNER', 'scout', p => flown(p, (front, rear) => ({ front, rear, legs: [front + 1, rear - 10] })),
    'O chassi: a perna da frente dos esquis precisa ficar sobre o patim, a 17 cm ou mais das pontas dele.'],
  ['SKID_SPACING', 'scout', p => flown(p, (front, rear) => ({ front, rear, legs: [0, 9] })), 'O chassi: as pernas dos esquis ficam a 45 cm uma da outra; o mínimo é 50 cm.'],
  ['FIELD', 'scout', p => flown(p, (front, rear) => ({ front, rear, legs: [0] })), 'O chassi: "skids.legs" precisa ser uma lista [ ] de 2 números.'],
  ['FIELD', 'scout', p => flown(p, front => ({ front, legs: [-10, 10] })), 'O chassi: falta "skids.rear".'],
  ['AXLES', 'scout', p => { p.chassis.axles = 'dois'; }, 'O chassi: "axles" precisa ser uma lista de números.'],
  ['AXLE_COUNT', 'scout', p => { p.chassis.axles = [0]; }, 'O chassi tem 1 eixo: este leva de 2 a 8.'],
  ['AXLE_EXTENT', 'scout', p => { p.chassis.axles = [-48, 33]; }, 'O chassi: cada roda precisa ficar inteira do primeiro ao último ponto.'],
  ['AXLE_SPACING', 'scout', p => { p.chassis.axles = [-34, -30]; }, 'O chassi: os eixos estão perto demais para o tamanho das rodas.'],
  ['TRACK_LENGTH', 'heavy', p => { const front = chassisFront(p.chassis); p.chassis.track = writtenTrack(p.chassis, front, front + trackLengthRange(p.chassis)[0] - .01); }, 'O comprimento da esteira está fora dos limites para essa altura. Ajuste o comprimento ou a altura da esteira.'],
  ['TRACK_EXTENT', 'heavy', p => { const front = chassisFront(p.chassis) - .1; p.chassis.track = writtenTrack(p.chassis, front, front + trackLengthRange(p.chassis)[0] + .4); }, 'O chassi: a esteira passa do primeiro ou do último ponto.'],
  ['CHASSIS_POINTS', 'scout', p => { p.chassis.points.pop(); }, 'O chassi tem 1 ponto: leva de 2 a 16.'],
  ['CHASSIS_ORDER', 'scout', p => { p.chassis.points.splice(1, 0, { x: p.chassis.points[0].x + 1, y: 0 }); }, 'O chassi: o ponto nº 2 precisa ficar ao menos 10 cm atrás do anterior.'],
  ['CHASSIS_SLOPE', 'scout', p => { p.chassis.points.splice(1, 0, { x: 0, y: 0 }, { x: 10, y: 12 }); p.chassis.points.at(-1).y = 12; }, 'O chassi: o trecho nº 2 sobe 50,2°; o máximo é 45°.'],
  ['CHASSIS_GAP', 'scout', p => { p.chassis.points[0].gap = true; }, 'O chassi: o vão no ponto nº 1 não fica entre dois trechos de chassi.'],
  ['SUSPENSION_REACH', 'scout', p => { for (const at of [...p.chassis.points, ...p.nodes, ...p.components.map(piece => piece.pose)]) at.y += 5; },
    'O chassi fica 25 cm acima da altura da suspensão do modelo: a suspensão alcança as rodas até 20 cm para cima ou para baixo.'],
  ['CONSTRUCTION_OVERLAP', 'guard-post', p => { part(p, 'weapon-ammo').pose = { ...part(p, 'command').pose }; }, 'Os componentes "command" e "weapon-ammo" ocupam o mesmo espaço.'],
  ['MOUNT_KIND', 'guard-post', p => { part(p, 'weapon').weaponPreset = 'rh120'; }, 'Componente "weapon": essa montagem não é feita para esse tipo de arma.'],
  ['FIELD', 'guard-post', p => { part(p, 'sensor').pose.x = 260; }, 'Componente "sensor": "pose.x" 260 casas fora de -240 a 240 casas.'],
];
for (const [code, template, edit, sentence] of EDITS) test(`a file refused with ${code} is told what is wrong in it and where: ${sentence}`, () => {
  assert.deepEqual(brought(template, edit), [code, sentence]);
});

test('a current file keeps continuous physical track ends and centre without a whole-wheel length rule', () => {
  const project = createConstruction('heavy'), track = chassisTrack(project.chassis);
  project.chassis.track = writtenTrack(project.chassis, track.front + .0137, track.rear - .0193, track.y + .01125);
  const restored = parseBlueprint(JSON.stringify(project));
  assert.deepEqual(restored.chassis.track, project.chassis.track);
  assert(!Number.isInteger(restored.chassis.track.front)); assert(!Number.isInteger(restored.chassis.track.rear));
  assert(!Number.isInteger(restored.chassis.track.y));
});

test('a current file preserves fractional component and axle positions without imposing the optional drawing grid', () => {
  const vehicle = createConstruction('heavy'), engine = part(vehicle, 'engine');
  engine.pose.y += .25;
  const restoredVehicle = parseBlueprint(JSON.stringify(vehicle));
  assert.deepEqual(part(restoredVehicle, engine.id).pose, engine.pose);
  const scout = createConstruction('scout'); scout.chassis.axles = [-20.5, 20];
  const restoredScout = parseBlueprint(JSON.stringify(scout));
  assert.deepEqual(restoredScout.chassis.axles, scout.chassis.axles);
});

// What the core refuses only past one edit of a stock design, or only on admission, with the context it gives.
test('the refusals that take more than one edit are told with the pieces they name', () => {
  const project = createConstruction('heavy'), told = refusal => projectRefusalMessage(refusal, project);
  assert.equal(told({ reason: 'WEAPON_SWEEP', ids: ['hull:deck', 'weapon'] }), 'Componente "weapon": o setor de tiro cruza a chapa "hull:deck".');
  assert.equal(told({ reason: 'COMPONENT_PLATE', ids: ['hull:rear', 'fuel'] }), 'O componente "fuel" ocupa espaço da chapa "hull:rear".');
  assert.equal(told({ reason: 'COMPONENT_GEAR', ids: ['blade', 'chassis:wheel-0'] }), 'O componente "blade" ocupa espaço da rodagem "chassis:wheel-0".');
  assert.equal(told({ reason: 'PLATE_OVERLAP', ids: ['hull:floor', 'hull:deck'] }), 'As chapas "hull:floor" e "hull:deck" ocupam o mesmo lugar.');
  assert.equal(told({ reason: 'PLATE_OVERLAP', ids: ['hull:floor', 'hull:deck'], nodeIds: ['hull-2'] }),
    'As chapas "hull:floor" e "hull:deck" entram uma na outra no nó "hull-2": abra mais o ângulo entre elas.');
  assert.equal(told({ reason: 'PLATE_JUNCTION', ids: ['hull:floor'], nodeIds: ['hull-2'] }), 'O nó "hull-2" fica no meio da chapa "hull:floor": divida a chapa nesse nó.');
  assert.equal(told({ reason: 'PLATE_CROSSING', ids: ['hull:floor', 'hull:deck'] }), 'As chapas "hull:floor" e "hull:deck" se cruzam: divida as duas num nó onde se cruzam.');
  assert.equal(told({ reason: 'AUTHORING_EXTENT', side: 'above', nodeIds: ['hull-2'] }), 'O nó "hull-2" passa de 8 m acima do chão.');
  assert.equal(told({ reason: 'AUTHORING_EXTENT', side: 'below', ids: ['weapon'], within: 'pose' }), 'Componente "weapon" fica abaixo do chão.');
  assert.equal(told({ reason: 'FRAME_EMPTY' }), 'Adicione uma chapa ou um componente antes de fabricar.');
  assert.equal(told({ reason: 'BREECH_COMPONENT', ids: ['weapon', 'command'], angleDegrees: -12 }), 'A culatra de "weapon" bate no componente "command" com o cano a 12° para baixo.');
  assert.equal(told({ reason: 'FRAME_SECTION', model: 'tracked' }), 'O chassi: a espessura da estrutura não cabe com essa rodagem.');
  assert.equal(told({ reason: 'CHASSIS_BALANCE', model: 'tracked', direction: 'rear' }), 'O peso fica atrás da rodagem: o veículo se arrastaria no casco.');
  assert.equal(told({ reason: 'CHASSIS_OVERLOAD', loadedKg: 41200, limitKg: 38000 }), 'O chassi não aguenta o peso: 41,2 de 38 t com tudo cheio.');
  assert.equal(told({ reason: 'CONSTRUCTION_VERSION', field: 'version', value: 4 }), 'O projeto é de outra versão do jogo.');
});

test('a code with no sentence of its own is told by its code and its piece, and what is no refusal says itself', () => {
  const project = createConstruction('heavy');
  assert.equal(projectRefusalMessage({ reason: 'WEAPON_BARREL', ids: ['weapon'] }, project), 'Recusado (WEAPON_BARREL) no componente "weapon".');
  assert.equal(projectRefusalMessage({ reason: 'OWNER' }, project), 'Recusado (OWNER) no projeto.');
  assert.equal(projectRefusalMessage({ reason: 'COMPONENT_MASS', ids: ['ghost'] }, null), 'Recusado (COMPONENT_MASS) na peça "ghost".');
  // A broken file, one of another version and a slip of the code.
  assert.throws(() => parseBlueprint('{'), error => projectRefusalMessage(error, null) === 'O arquivo não é um projeto: está corrompido ou é de outro tipo.');
  assert.throws(() => parseBlueprint(JSON.stringify({ ...createConstruction('heavy'), version: 4 })),
    error => projectRefusalMessage(error, null) === 'Esse não é um projeto desta versão do jogo. Exporte o original para preservá-lo e crie um projeto atual.');
  assert.equal(projectRefusalMessage(new TypeError('x is undefined'), project), 'O projeto não pôde ser aberto.');
});

test('the workshop keeps its own messages for the refusals of its edits', () => {
  assert.equal(constructionEditMessage({ reason: 'PLATE_REPEATED', ids: ['hull:floor', 'outra'] }), 'Já existe uma chapa entre esses pontos.');
  assert.equal(constructionEditMessage({ reason: 'FIELD', field: 'sizeScale', value: 9, range: [.25, 3.8], ids: ['engine'] }), 'Tamanho fora do que a peça admite.');
});
