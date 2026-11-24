import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { rustSourceHash } from './rust-source-hash.ts';
import { parseJSON, stringFlags } from './operational-input.ts';
import { frozenManifest, recordingIndex, nativeFingerprint, buildFingerprint, benchmarkPacket } from './mobile-benchmark-contract.ts';
import type { FrozenManifest, RecordingKind, RecordingFile } from './mobile-benchmark-contract.ts';
import type { SharedRoom } from '../server/room.ts';
import type { ModuleKind } from '../src/materials.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), args = stringFlags(process.argv.slice(2));
if (!args.output || Object.keys(args).some(name => !['output','freeze','base','overlay','record'].includes(name))) throw Error('Use --output=validation/pasta [--freeze=V] [--base=A --overlay=src/effects.ts] [--record=fire|flight|dust|wreck|parked|wreck-ground].');
const directory = path.resolve(repo,args.output);
if (!directory.startsWith(path.join(repo,'validation') + path.sep)) throw Error('Saídas somente dentro de validation/.');
fs.mkdirSync(directory,{recursive:true});
const sha = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
export function freeze(name: string): FrozenManifest {
  const dest = path.join(directory, 'frozen', name);
  assert(!fs.existsSync(dest), 'Variant already exists: ' + name);
  assert(/^[A-Z]{1,3}$/.test(name) && (!args.base || /^[A-Z]{1,3}$/.test(args.base)));
  const base = args.base ? path.join(directory,'frozen',args.base) : repo;
  fs.mkdirSync(dest, { recursive: true }); fs.cpSync(path.join(base, 'src'), path.join(dest, 'src'), { recursive: true });
  fs.copyFileSync(path.join(repo,'package.json'),path.join(dest,'package.json'));
  // src/tsconfig.json extends this root file. Freeze it as well so the Vite
  // TypeScript transform can load a self-contained source snapshot.
  const configBase = fs.existsSync(path.join(base,'tsconfig.base.json')) ? base : repo;
  fs.copyFileSync(path.join(configBase,'tsconfig.base.json'),path.join(dest,'tsconfig.base.json'));
  if (args.overlay) for (const file of args.overlay.split(',')) {
    assert(file.startsWith('src/') && path.resolve(repo,file).startsWith(path.join(repo,'src')+path.sep),'Overlay fora de src/.');
    fs.copyFileSync(path.join(repo,file),path.join(dest,file));
  }
  const files: FrozenManifest['files'] = {};
  const scan = (dir: string): void => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name); if (entry.isDirectory()) scan(file);
    else files[path.relative(dest, file).replaceAll('\\', '/')] = { sha256: sha(fs.readFileSync(file)), bytes: fs.statSync(file).size };
  } };
  scan(dest);
  const manifest = { name, commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', windowsHide: true }).trim(),
    sourceTreeSHA256: sha(JSON.stringify(files)), files };
  fs.writeFileSync(path.join(directory, name + '-manifest.json'), JSON.stringify(manifest, null, 2));
  return manifest;
}
if (args.freeze) { const saved=freeze(args.freeze);console.log(JSON.stringify({name:saved.name,sourceTreeSHA256:saved.sourceTreeSHA256}));process.exit(0); }

const native = nativeFingerprint(parseJSON(fs.readFileSync(path.join(repo, 'native/artifacts/battle_dynamics-win32-x64.json'), 'utf8'))),
  wasm = buildFingerprint(parseJSON(fs.readFileSync(path.join(repo, 'src/native/battle_dynamics.json'), 'utf8')));
assert.equal(native.sourceSHA256, rustSourceHash(path.join(repo, 'native/dynamics')));
assert.equal(wasm.sourceSHA256, native.sourceSHA256); assert.equal(native.profile, 'release'); assert.equal(wasm.profile, 'release');
assert.equal(sha(fs.readFileSync(path.join(repo, 'src/native/battle_dynamics_bg.wasm'))), wasm.binarySHA256);
assert.equal(sha(fs.readFileSync(path.join(repo, 'native/artifacts', native.binaryFile))), native.binarySHA256);
// Freezing sources above needs no simulation host. Load the recording path only after verifying its binaries.
const [{ rehearsal }, { stressField, stressBases }, { Publication }, { FrameLedger, FrameWriter, FrameReader, tellEvent },
  { shotCount }, { depositsOf, depositsNear }, { createStructuredTemplate }, { withConstructionKind },
  { compileDraftConstruction }, { componentDimensions }, { CELL }] = await Promise.all([
  import('../server/room.ts'), import('../server/stress-field.ts'), import('../server/publication.ts'),
  import('../src/network-protocol.ts'), import('../src/shots.ts'), import('../src/deposits.ts'), import('../src/structured-templates.ts'),
  import('../src/chassis-editing.ts'), import('../src/structured-construction.ts'), import('../src/component-size.ts'), import('../src/grid.ts'),
]);
const saved = args.record ? recordingIndex(parseJSON(fs.readFileSync(path.join(directory,'records.json'), 'utf8'))) : null;
if(saved){assert.equal(saved.native.binarySHA256,native.binarySHA256);assert.equal(saved.wasm.binarySHA256,wasm.binarySHA256);}
const recordKind = args.record;
assert(recordKind === undefined || recordKind === 'fleet' || recordKind === 'combat' || recordKind === 'fire' || recordKind === 'flight' || recordKind === 'dust' || recordKind === 'wreck' || recordKind === 'parked' || recordKind === 'wreck-ground');
// A publishable four-jet aircraft on its real skids. The recording keeps the
// Native flight computer's thrust and poses, without injecting visual jets.
function flightDesign() {
  const stock = createStructuredTemplate('chassis');
  Object.assign(stock, { plates: [], nodes: [], components: stock.components.filter(piece => piece.kind !== 'sensor') });
  const design = withConstructionKind(stock, 'aircraft'), bed = compileDraftConstruction(design).plates.find(plate => plate.id === 'chassis:top-0');
  assert(bed, 'Chassi da aeronave sem piso.');
  const floor = bed.y - 1.3 + bed.thicknessMm / 2000, piece = (kind: ModuleKind) => { const part = design.components.find(part => part.kind === kind); assert(part, 'Peça ausente na aeronave: '+kind); return part; };
  piece('engine').sizeScale = .8;
  for (const [kind, x] of [['engine', 2.9], ['fuel', -2.75], ['command', -2]] satisfies [ModuleKind, number][]) {
    const part = piece(kind); part.pose = { x: x / CELL, y: (floor + componentDimensions(part, part.sizeScale ?? 1).height / 2) / CELL, angle: 0 };
  }
  const diagonal = (.64 + 1.31) / 2 * Math.SQRT1_2;
  const jets: [number, number, number][] = [[-1.1, floor + diagonal, -Math.PI / 4], [-.05, floor + 1.31 / 2, 0], [.62, floor + 1.31 / 2, 0], [1.67, floor + diagonal, Math.PI / 4]];
  jets
    .forEach(([x, y, angle], i) => design.components.push({ id: `lift${i}`, kind: 'thruster', metal: 'titanium', pose: { x: x / CELL, y: y / CELL, angle } }));
  return design;
}
const baseline = saved ? frozenManifest(parseJSON(fs.readFileSync(path.join(directory,'A-manifest.json'), 'utf8'))) : freeze('A'), records: Record<string, RecordingFile> = saved?.records || {}, kinds: RecordingKind[] = recordKind ? [recordKind] : ['fleet', 'combat', 'fire', 'dust'];
for (const kind of kinds) {
  assert(!records[kind],'Recording already exists: '+kind);
  let driver: { feed(time: number): void }, room: SharedRoom, watch: Record<string, unknown>;
  if (kind === 'combat') {
    const simulation = stressField(4); driver = simulation; room = simulation.room;
    const viewer = room.join('QA replay'); watch = { ...simulation.seat(viewer.playerId) };
  } else {
    let bases: ReturnType<typeof stressBases> | undefined; room = rehearsal((i: number) => (bases ||= stressBases(room.world.terrain))[i]);
    const player = room.players.get(room.join('QA fleet').playerId), design = kind === 'flight' ? flightDesign() : createStructuredTemplate(kind==='wreck'||kind==='wreck-ground'?'scout':'heavy', { preset: kind==='fire'||kind==='parked'?'rh120':'rh202' });
    assert(player, 'Observador do benchmark ausente.');
    if(kind==='dust'||kind==='wreck'||kind==='parked'||kind==='wreck-ground'){
      // A real unpaved road replaces the base apron before recording Native
      // motion. Physics, ground contacts and the renderer see the same surface.
      const base=room.base(player);assert(base);
      room.pave(base.x-300,base.x+2000,'graded');
    }
    for (let n = 0; n < 6; n++) { player.builtAt = -Infinity; room.publish(player.id, structuredClone(design)); }
    room.take(player, null);
    const actors = room.owned(player.id), x = actors.reduce((sum,a) => { assert(a.vehicle);return sum + a.vehicle.x; },0) / actors.length;
    if(kind==='parked'||kind==='wreck-ground')room.order(player,{order:'stop',ids:actors.map(a=>a.id)});
    else room.order(player, { order: 'move', ids: actors.map(a => a.id), x: x + 1500 });
    watch = { base: room.base(player), playerId: player.id };
    let burst=false;
    driver = { feed(time) {
      if(kind!=='wreck'&&kind!=='wreck-ground'||burst||time<1.5)return;
      const at=room.world.actor(actors[0]!.id)?.vehicle;assert(at);
      // Controlled launch condition for the falling-wreck visual test; this
      // velocity is imposed, never claimed as a result of the blast model.
      if(kind==='wreck')room.world.command('setVehicleState',{actorId:actors[0]!.id,state:{y:at.y+4,vy:6,vx:3,omega:.35}});
      const fuel=room.world.modules.find(part=>part.actorId===actors[0]!.id&&part.kind==='fuel');assert(fuel);
      room.world.explode(fuel.x,fuel.y,100,1.2);
      burst=true;
    } };
    if(kind==='wreck')watch.controlledLaunch={atSeconds:1.5,offsetY:4,vy:6,vx:3,omega:.35,blast:{at:'fuel',power:100,radius:1.2}};
    if(kind==='parked'||kind==='wreck-ground')watch.groundedDemo={stationary:true,imposedLaunch:false,blastAtSeconds:kind==='wreck-ground'?1.5:null};
  }
  const world = room.world, publication = new Publication(), ledger = new FrameLedger(), writer = new FrameWriter(ledger), reader = new FrameReader(), packets: {time:number;data:string}[] = [], pending: ReturnType<typeof tellEvent>[] = [];
  if (kind !== 'combat') {
    const ground=world.terrain,biomes=ground.biomes;assert(biomes,'Scenery benchmark requires biome metadata.');
    const region=biomes.filter(r=>r.id==='wet-valley').sort((a,b)=>(b.end-b.start)-(a.end-a.start))[0];
    assert(region,'Scenery benchmark requires a real wooded biome.');
    const middle=(region.start+region.end)/2, grass=Array.from({length:101},(_,i)=>middle+(i%2?-1:1)*Math.ceil(i/2)*20)
      .find(x=>[-6,0,6].every(dx=>ground.materialAt(x+dx)==='soil')&&Math.abs(ground.surface(x).slope)<.18);
    assert(grass !== undefined && Number.isFinite(grass),'Scenery benchmark requires a grass-covered soil patch.');
    watch.scenery={forest:{x:middle},grass:{x:grass},deposits:{x:6832,
      known:depositsNear(depositsOf(ground),6832,10000).map(site=>({id:site.id,left:site.reserve,stock:0}))}};
  }
  const eventCounts: Record<string, number> = {}, stats = { maxShots: 0, actors: 0, movingActors: 0, maxActiveJets: 0, maxLooseGroundContacts:0,
    maxUpSpeed:0,maxRiseFromStart:0 },startHeights=new Map<string,number>();
  for (let step = 0; step <= 720; step++) {
    room.step({ quiet: true }); driver.feed(world.time);
    const events = world.drainEvents().map(tellEvent);
    for (const event of events) { if(typeof event.type!=='string')throw Error('Evento gravado sem tipo.');eventCounts[event.type] = (eventCounts[event.type] || 0) + 1; }
    if (step % 3) { pending.push(...events); continue; }
    const published = publication.state(world.snapshot()); assert(published.shots, 'Gravação sem projéteis publicados.');
    const state = { ...published, shots: { ...published.shots, drag: world.shotDrags }, shared: true };
    ledger.turn();
    const buffer = writer.encode({ type: 'frame', state, events: [...pending, ...events] }, step === 0); pending.length = 0;
    const decoded = benchmarkPacket(reader.decode(buffer), buffer.byteLength, state.time); assert(decoded.state.actors.length === (kind === 'combat' ? 48 : 6));
    stats.actors = decoded.state.actors.length;
    stats.movingActors = Math.max(stats.movingActors, decoded.state.actors.filter(a => Math.hypot(a.vehicle?.vx || 0, a.vehicle?.vy || 0) > .15).length);
    if(kind==='parked'||kind==='wreck-ground')for(const actor of decoded.state.actors){
      const vehicle=actor.vehicle;assert(vehicle);if(!startHeights.has(actor.id))startHeights.set(actor.id,vehicle.y);
      stats.maxRiseFromStart=Math.max(stats.maxRiseFromStart,vehicle.y-startHeights.get(actor.id)!);
      stats.maxUpSpeed=Math.max(stats.maxUpSpeed,vehicle.vy||0);
    }
    stats.maxShots = Math.max(stats.maxShots, shotCount(decoded.state.shots));
    stats.maxActiveJets = Math.max(stats.maxActiveJets, decoded.state.modules.filter(piece => piece.kind === 'thruster' && (piece.thrust ?? 0) > 0).length);
    stats.maxLooseGroundContacts=Math.max(stats.maxLooseGroundContacts,decoded.state.modules.filter(piece=>
      piece.groundContact&&world.terrain.groundAt(piece.groundContact.x)==='graded').length);
    packets.push({ time: state.time, data: Buffer.from(buffer).toString('base64') });
  }
  assert.equal(packets.length, 241); if(kind==='combat')assert((eventCounts.muzzle??0)>0);
  else if(kind!=='parked'&&kind!=='wreck-ground')assert(stats.movingActors>0);
  if (kind === 'flight') assert.equal(stats.maxActiveJets, 24, 'All six Native aircraft must be powered.');
  if(kind==='dust')assert(stats.maxLooseGroundContacts>=6,'The unpaved-road recording must contain real Native ground contacts.');
  if(kind==='wreck')assert((eventCounts.explosion??0)>0&&(eventCounts.ground??0)>0,'The wreck recording needs real blasts and terrain contacts: '+JSON.stringify(eventCounts));
  if(kind==='parked'||kind==='wreck-ground')assert(stats.maxRiseFromStart<1&&stats.maxUpSpeed<2.5,'Grounded demo must not launch vehicles: '+JSON.stringify(stats));
  if(kind==='wreck-ground')assert((eventCounts.burn??0)>0,'The grounded wreck needs real Native combustion.');
  const bytes = gzipSync(JSON.stringify({ kind, native, wasm, packets, watch, eventCounts, stats }));
  const file = kind + '.json.gz'; fs.writeFileSync(path.join(directory, file), bytes);
  records[kind] = { file, sha256: sha(bytes), bytes: bytes.length, snapshots: packets.length, eventCounts, stats };
  console.log(JSON.stringify({ kind, ...records[kind] })); world.dispose();
}
fs.writeFileSync(path.join(directory, 'records.json'), JSON.stringify({ sourceCommit: baseline.commit, native, wasm, records }, null, 2));
