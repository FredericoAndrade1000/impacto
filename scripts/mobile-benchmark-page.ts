// The shared renderer benchmark. No product flags or physics changes; all cases consume fixed Native recordings.
import { MobileFrameBudget } from './mobile-profile.ts';
import { webglUploadBytes } from './mobile-transfer-bytes.ts';
import { effectsFixture } from './mobile-effects-fixture.ts';
import { benchmarkConfig, recording as readRecording, benchmarkPacket } from './mobile-benchmark-contract.ts';
import type { BenchmarkPacket, BenchmarkCase } from './mobile-benchmark-contract.ts';
import type { Renderer as OwnedRenderer, RenderFieldView } from '../src/render.ts';
import type { FrameReader as OwnedFrameReader } from '../src/network-protocol.ts';
import { record, expectRecord, expectArray, expectNumber, expectString, invoke } from './operational-input.ts';
function rendererConstructor(value: unknown): value is typeof OwnedRenderer {
  return typeof value === 'function' && record(value.prototype) && ['init','resize','receive','draw','setTerrain'].every(name=>typeof value.prototype[name]==='function');
}
function frameReaderConstructor(value: unknown): value is typeof OwnedFrameReader {
  return typeof value === 'function' && record(value.prototype) && typeof value.prototype.decode === 'function';
}
const query = new URLSearchParams(location.search), variant = query.get('variant'), caseName = query.get('case'), config = benchmarkConfig(await (await fetch('/__mobile/config')).json());
if (!variant || !caseName || !/^[A-Z]{1,3}$/.test(variant)) throw Error('Caso ou versão inválida.');
const chosenSpec = config.cases[caseName], chosenSource = config.sources[variant];
if (!chosenSpec || !chosenSource) throw Error('Caso ou versão inválida.');
const spec:BenchmarkCase=chosenSpec,source=chosenSource;
const root = config.directory + '/frozen/' + variant + '/src/',
  load = async (name: string): Promise<Record<string,unknown>> => { const file = source.modules[name];if(!file)throw Error('Módulo ausente do manifesto: '+name);const module:unknown=await import(/* @vite-ignore */ root+file);return expectRecord(module); },
  runtime = await load('native-dynamics');
await invoke(runtime,'initNativeDynamics');
if (runtime.nativeDynamicsRuntime !== 'wasm') throw Error('Benchmark exige o Wasm real.');
const [drawing, protocol, shots, performanceModule] = await Promise.all([load('render'), load('network-protocol'),load('shots'),load('client-performance')]);
const Renderer=drawing.Renderer,FrameReader=protocol.FrameReader;
if(!rendererConstructor(Renderer)||!frameReaderConstructor(FrameReader))throw Error('API da variante congelada incompatível com o benchmark.');
const shotCount=(value:unknown):number=>expectNumber(invoke(shots,'shotCount',value));
const recording = readRecording(await (await fetch('/__mobile/record/' + spec.record)).json()), reader = new FrameReader(),
  packets = recording.packets.map((packet,index) => {
    const bytes = Uint8Array.from(atob(packet.data), char => char.charCodeAt(0));
    const decoded=benchmarkPacket(reader.decode(bytes.buffer),bytes.byteLength,packet.time);
    // Fixed presentation fixture: changing stock at known Native-generated sites, not extra physics or network traffic.
    if(spec.scenery==='deposits') decoded.state={...decoded.state,faction:{id:'benchmark-scenery',known:[],
      flag:{field:'plain',colours:[0,1,2],emblem:'none'},...(record(decoded.state.faction)?decoded.state.faction:{}),
      deposits:expectArray(expectRecord(expectRecord(recording.watch.scenery).deposits).known).map(value=>{
        const vein=expectRecord(value);return {...vein,id:expectString(vein.id),left:expectNumber(vein.left),stock:index+1};
      })}};
    return decoded;
  });
const firstPacket=packets[0],stage=document.querySelector<HTMLElement>('#stage');
if(!firstPacket||!stage)throw Error('Benchmark sem quadro inicial ou área de desenho.');
const packetAt=(index:number):BenchmarkPacket=>{const packet=packets[index];if(!packet)throw Error('Quadro ausente da gravação: '+index);return packet;};
const renderer = new Renderer<RenderFieldView>(stage, { mode: 'test', testTool: 'select', weapon: { platform: 'vehicle' }, aim: { x: 0, y: 0 } });
await renderer.init(); renderer.app.renderer.resolution = config.profile.dpr; renderer.resize(); renderer.opened = new Set();
const stationaryDemo=spec.record==='parked'||spec.record==='wreck-ground';
if(stationaryDemo)renderer.screenShake.setLevel('off');
if(spec.opened){
  const playerId=recording.watch.playerId;
  if(typeof playerId!=='string'||!playerId)throw Error('Inspeção exige o observador da gravação.');
  for(const packet of packets)packet.state={...packet.state,localPlayerId:playerId};
  renderer.opened=new Set(firstPacket.state.actors.map(actor=>actor.id));
}
if(spec.effect&&spec.effect!=='native'){
  const state=firstPacket.state,weather=state.weather;
  if(weather!==undefined&&typeof weather!=='string')throw Error('Tempo da gravação inválido.');
  renderer.setTerrain(state.terrain||'flat',record(state.terrainSettings)?state.terrainSettings:{},weather);
  const [geometry,weapons]=await Promise.all([load('weapon-geometry'),load('weapons')]),presets:Record<string,{family:string;caliberMm:number}>={};
  for(const [name,value]of Object.entries(expectRecord(weapons.WEAPON_PRESETS))){const model=expectRecord(value);presets[name]={family:expectString(model.family),caliberMm:expectNumber(model.caliberMm)};}
  effectsFixture(packets,spec,recording,renderer.ground,{weaponAngle:part=>expectNumber(invoke(geometry,'weaponAngle',part)),weaponBarrelProfile:part=>({end:expectNumber(expectRecord(invoke(geometry,'weaponBarrelProfile',part)).end)}),presets});
}
let plantsBuilt=0,postsBuilt=0;
if(spec.scenery){
  const plant=renderer.terrainScene.plant.bind(renderer.terrainScene),deposits=renderer.drawDeposits.bind(renderer);
  renderer.terrainScene.plant=(...args:Parameters<typeof plant>)=>{plantsBuilt++;return plant(...args);};
  renderer.drawDeposits=(...args:Parameters<typeof deposits>)=>{const before=renderer.depositPosts?.context.instructions[0];deposits(...args);
    if(renderer.depositPosts?.context.instructions[0]!==before)postsBuilt++;};
}
const backend=renderer.app.renderer;
if(!('gl'in backend))throw Error('Benchmark exige renderizador WebGL.');
const gl = backend.gl, extension:unknown = gl.getExtension('EXT_disjoint_timer_query_webgl2'),
  ext = record(extension)&&typeof extension.GPU_DISJOINT_EXT==='number'&&typeof extension.TIME_ELAPSED_EXT==='number'?{GPU_DISJOINT_EXT:extension.GPU_DISJOINT_EXT,TIME_ELAPSED_EXT:extension.TIME_ELAPSED_EXT}:null, hardware = {
  ...expectRecord(invoke(performanceModule,'gpuInformation',gl)), viewport: [innerWidth, innerHeight], pixels: [renderer.canvas.width, renderer.canvas.height],
  cpuRate: config.profile.cpu.rate, dpr: devicePixelRatio, gpuTimer: Boolean(ext) };
if (config.profile.applyBudgets && !ext) throw Error('Sem temporizador GPU: resultado mobile indisponível.');
interface MeasuredFrame {
  elapsed:number;intervalMs:number|null;gpuMs:number|null;receiveMs?:number;drawMs?:number;uploadBytes?:number;
  plantBuilds?:number;postBuilds?:number;floraQuads?:number;visible?:number;dotted?:number;particles?:number;shots?:number;
  burningSources?:number;burningSurfaces?:number;flames?:number;vegetationWaves?:number;camera?:{x:number;y:number;zoom:number};
}
const pending: {query:WebGLQuery;frame:MeasuredFrame}[] = [], frames:MeasuredFrame[] = [], budget = new MobileFrameBudget(config.profile);
let bytesUploaded = 0, disjoints = 0;
// These are boundary transfers, not a measurement of all RAM/VRAM reads, caches or shader traffic.
for (const name of ['bufferData', 'bufferSubData', 'texImage2D', 'texSubImage2D', 'compressedTexImage2D', 'compressedTexSubImage2D']) {
  const boundary=expectRecord(gl),original=boundary[name];
  if(typeof original!=='function')throw Error('Transferência WebGL indisponível: '+name);
  boundary[name] = (...args:unknown[]) => {
    bytesUploaded += webglUploadBytes(name, args);
    const result:unknown=Reflect.apply(original,gl,args);return result;
  };
}
const poll = () => {
  if (!ext) return;
  if (gl.getParameter(ext.GPU_DISJOINT_EXT)) {
    disjoints += pending.length; for (const item of pending) gl.deleteQuery(item.query); pending.length = 0; return;
  }
  while (pending[0] && gl.getQueryParameter(pending[0].query, gl.QUERY_RESULT_AVAILABLE)) {
    const item = pending.shift();if(!item)break; item.frame.gpuMs = expectNumber(gl.getQueryParameter(item.query, gl.QUERY_RESULT)) / 1e6; gl.deleteQuery(item.query);
    if (config.profile.applyBudgets) budget.spend(performance.now(), { gpuMs: item.frame.gpuMs, uploadBytes: expectNumber(item.frame.uploadBytes) });
  }
};
const nextFrame = ():Promise<number> => new Promise(resolve => requestAnimationFrame(resolve));
const singleBlast=spec.effect==='blastOnce'?packets.flatMap(packet=>packet.events).find(event=>event.type==='explosion'):null;
function camera(packet:BenchmarkPacket, elapsed:number):void {
  if(stationaryDemo){
    const x=singleBlast?expectNumber(singleBlast.x):firstPacket!.state.actors[0].vehicle.x;
    renderer.camera.x=x;renderer.camera.y=renderer.ground.height(x)+3;renderer.camera.zoom=expectNumber(spec.zoom);return;
  }
  if (spec.record === 'flight') {
    const parts = spec.module ? packet.state.modules.filter(piece => piece.kind === spec.module).slice(spec.moduleIndex || 0, (spec.moduleIndex || 0) + 1) : packet.state.actors.map(actor => actor.vehicle);
    renderer.camera.x = parts.reduce((sum, piece) => sum + piece.x, 0) / parts.length;
    renderer.camera.y = parts.reduce((sum, piece) => sum + piece.y, 0) / parts.length - (spec.module ? .6 : 0);
    renderer.camera.zoom = expectNumber(spec.zoom); return;
  }
  if(spec.scenery){
    const place=expectRecord(expectRecord(recording.watch.scenery)[spec.scenery]), zoom=spec.enter&&elapsed<2.2?.13:expectNumber(spec.zoom), x=expectNumber(place.x);
    renderer.camera.x=x;renderer.camera.y=renderer.ground.height(x)+(spec.scenery==='grass'?1.4:zoom>=3?3:20);renderer.camera.zoom=zoom;
    return;
  }
  const actors = packet.state.actors, first = actors[0].vehicle;
  const meanX = actors.reduce((sum, actor) => sum + (actor.vehicle?.x ?? actor.x), 0) / actors.length;
  const x = spec.record === 'combat' ? expectNumber(expectRecord(recording.watch.watch).x) : meanX;
  if(spec.effect){
    renderer.camera.x=spec.effect==='burnGroup'||spec.effect==='drive'?meanX:first.x;
    renderer.camera.y=first.y+2;renderer.camera.zoom=expectNumber(spec.zoom);
  } else if (spec.near) {
    renderer.camera.x = first.x; renderer.camera.y = first.y + 2; renderer.camera.zoom = 24;
    renderer.opened = new Set([actors[0].id]);
  } else {
    renderer.camera.x = x; renderer.camera.y = renderer.ground.height(x) + 20; renderer.camera.zoom = expectNumber(spec.zoom);
    if (spec.pan) renderer.camera.x += Math.sin(elapsed * 2 * Math.PI) * renderer.camera.width / expectNumber(spec.zoom) * .15;
  }
}
const percentile = (values:readonly(number|null|undefined)[], share:number):number|null => {
  const sorted = values.filter((value):value is number=>typeof value==='number'&&Number.isFinite(value)).sort((a,b) => a-b); return sorted[Math.max(0,Math.ceil(sorted.length * share)-1)] ?? null;
};
window.mobileBenchmark = { ready: true, renderer, hardware, async replay(options={}) {
  const first=packetAt(0),last=packetAt(packets.length-1),duration=last.sourceTime-first.sourceTime;
  const blast=singleBlast,steady=options.steady||stationaryDemo,oldShake=renderer.screenShake.level,captureScale=options.captureScale??1;
  if(!Number.isFinite(captureScale)||captureScale<1||captureScale>3)throw Error('Invalid visual capture scale.');
  if(steady)renderer.screenShake.setLevel('off');
  const fixedX=blast?expectNumber(blast.x):first.state.actors[0].vehicle.x;
  let minX=Infinity,maxX=-Infinity,minY=Infinity,maxY=-Infinity,minZoom=Infinity,maxZoom=-Infinity,maxShakePixels=0;
  try{
  renderer.receive(first.state,[],{now:performance.now(),paused:true});camera(first,0);
  renderer.camera.zoom*=captureScale;
  for(let i=0;i<60;i++){const now=await nextFrame();renderer.draw({now});}
  renderer.playback.clear();renderer.effects.clear();renderer.groundTrails.clear();
  const began=performance.now();let received=-1,events=0;
  while(true){
    const now=await nextFrame(),elapsed=Math.min(duration,(now-began)/1000);
    while(received+1<packets.length&&packetAt(received+1).sourceTime-first.sourceTime<=elapsed){
      const packet=packetAt(++received);
      renderer.receive(packet.state,packet.events,{now:began+(packet.sourceTime-first.sourceTime)*1000,paused:false});
      events+=packet.events.length;
    }
    camera(packetAt(Math.max(0,received)),elapsed);
    renderer.camera.zoom*=captureScale;
    // A visual replay keeps the whole launch/landing area in frame. Timed
    // benchmark windows and fixed comparison photos retain their own camera.
    if(blast||steady){renderer.camera.x=fixedX;renderer.camera.y=renderer.ground.height(fixedX)+3;}
    renderer.draw({now});
    minX=Math.min(minX,renderer.camera.x);maxX=Math.max(maxX,renderer.camera.x);
    minY=Math.min(minY,renderer.camera.y);maxY=Math.max(maxY,renderer.camera.y);
    minZoom=Math.min(minZoom,renderer.camera.zoom);maxZoom=Math.max(maxZoom,renderer.camera.zoom);
    const shake=renderer.screenShake.offset(renderer.camera.zoom,renderer.mode);maxShakePixels=Math.max(maxShakePixels,Math.hypot(shake.x,shake.y));
    if(elapsed>=duration)break;
  }
  return {firstTime:first.sourceTime,lastTime:last.sourceTime,duration,packets:received+1,totalPackets:packets.length,events,
    complete:received+1===packets.length,fixedExplosionCamera:Boolean(blast),steadyCamera:Boolean(steady),
    cameraSpan:{x:maxX-minX,y:maxY-minY,zoom:maxZoom-minZoom},maxShakePixels,
    canvasPixels:{width:renderer.canvas.width,height:renderer.canvas.height},captureScale,
    scope:'Full chronological renderer playback of this fixed recording; not an AI match or performance measurement.'};
  }finally{renderer.screenShake.setLevel(oldShake);}
}, async photo() {
  const tick=spec.photoTick??160,packet = packetAt(tick);let now = 10000;
  renderer.playback.clear(); renderer.effects.clear(); renderer.groundTrails.clear();
  if(spec.effect || spec.record === 'flight')for(let i=spec.record==='wreck'||spec.record==='wreck-ground'?0:Math.max(0,tick-40);i<tick;i++){
    const frame=packetAt(i);renderer.receive(frame.state,frame.events,{now,paused:false});camera(frame,4);renderer.draw({now});now+=50;await nextFrame();
  }
  renderer.receive(packet.state, [], { now, paused: true }); camera(packet,spec.enter?4:0);
  for(let n=0;n<90;n++){await nextFrame();renderer.draw({now});}
  return { time:packet.state.time,camera:{x:renderer.camera.x,y:renderer.camera.y,zoom:renderer.camera.zoom},
    particles:renderer.effects.particles.length,burningSources:renderer.effects.burningSources?.size??0,
    jetGroups:renderer.effects.jets.jets.size,jetHeat:renderer.effects.jets.heat.length,
    jetGroundContacts:renderer.effects.jets.heat.filter(jet=>jet.contact).length,
    vegetationWaves:renderer.effects.vegetation?.waves.length??0,
    paintPending:[...renderer.textures.values()].filter(x=>x.paint).length };
}, async run() {
  const firstPacket = packetAt(0), coldAt = performance.now();
  renderer.receive(firstPacket.state, [], { paused: true, now: coldAt }); camera(firstPacket, 0); renderer.draw({ now: coldAt });
  if(spec.opened&&firstPacket.state.actors.some(actor=>renderer.closed.has(actor.id)))throw Error('A inspeção não abriu os veículos do observador.');
  const coldDrawMs = performance.now() - coldAt;
  // Keep initial artwork cost separate. Do not filter slow useful frames or force GC.
  const warmUntil = performance.now() + 1200;
  while (performance.now() < warmUntil) { const now = await nextFrame(); renderer.draw({ now }); }
  renderer.playback.clear(); renderer.effects.clear(); renderer.groundTrails.clear(); budget.reset();
  let received = -1, previous:number|null = null, index = 0, deliveredEvents = 0;
  const ceiling:number[] = [];let previousRaf:number|null=null;
  for(let n=0;n<24;n++){const now=await nextFrame();if(previousRaf!=null)ceiling.push(now-previousRaf);previousRaf=now;}
  const refreshPeriodMs=percentile(ceiling,.5), began = performance.now();
  while (true) {
    const now = await nextFrame(), elapsed = (now - began) / 1000; poll();
    if (elapsed > 8) break;
    if (!budget.ready(now)) continue;
    const frame:MeasuredFrame = { elapsed, intervalMs: previous == null ? null : now - previous, gpuMs: null }, before = performance.now();
    while (received + 1 < packets.length && packetAt(received + 1).sourceTime - firstPacket.sourceTime <= elapsed) {
      const packet = packetAt(++received); renderer.receive(packet.state, packet.events, { now: began + (packet.sourceTime - firstPacket.sourceTime) * 1000, paused: false });
      deliveredEvents += packet.events.length;
    }
    const packet = packetAt(Math.max(0,received)); frame.receiveMs = performance.now() - before; camera(packet,elapsed);
    let gpuQuery:WebGLQuery|null=null;
    if (ext && pending.length < 16 && (config.profile.applyBudgets || index % 3 === 0)) {
      gpuQuery = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, gpuQuery);
    }
    bytesUploaded = 0; const started = performance.now(),grew=plantsBuilt,posted=postsBuilt; renderer.draw({ now }); frame.drawMs = performance.now() - started;
    if (gpuQuery && ext) { gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push({ query: gpuQuery, frame }); }
    frame.uploadBytes = bytesUploaded;
    if(spec.scenery){
      frame.plantBuilds=plantsBuilt-grew;frame.postBuilds=postsBuilt-posted;
      const scene=renderer.terrainScene,shown=scene.shown;let quads=0;
      if(!shown)throw Error('Vegetação ainda não desenhada no cenário do benchmark.');
      for(let i=shown.first;i<shown.last;i++)for(const name of ['flora','frontFlora']){
        const chunk=scene.activeChunks[i];if(!chunk)throw Error('Trecho de vegetação ausente.');
        const mesh=name==='flora'?chunk.flora:chunk.frontFlora;if(mesh?.visible)quads+=mesh.geometry.indices.length/6;
      }
      frame.floraQuads=quads;
    }
    frame.visible = packet.state.actors.filter(actor => !renderer.unseen.has(actor.id) || renderer.dotted.has(actor.id)).length;
    frame.dotted = renderer.dotted.size; frame.particles = renderer.effects.particles.length; frame.shots = shotCount(packet.state.shots);
    frame.burningSources = renderer.effects.burningSources?.size ?? 0;
    frame.burningSurfaces = renderer.burningSurfaceCount ?? 0;
    frame.flames = renderer.effects.fireCount ?? 0;
    frame.vegetationWaves = renderer.effects.vegetation?.waves.length ?? 0;
    frame.camera = { x: renderer.camera.x, y: renderer.camera.y, zoom: renderer.camera.zoom };
    frames.push(frame); previous = now; index++;
  }
  for (let n=0;n<6;n++) { await nextFrame(); poll(); }
  for (const item of pending) gl.deleteQuery(item.query); pending.length = 0;
  type MeanMetric='drawMs'|'particles'|'shots'|'visible'|'dotted'|'uploadBytes'|'floraQuads';
  const useful = frames.filter(frame => frame.elapsed >= 2), first = useful[0], last = useful.at(-1),
    mean = (key:MeanMetric):number => useful.reduce((sum,frame) => sum + expectNumber(frame[key]),0) / useful.length;
  if(!first||!last)throw Error('Benchmark sem quadros úteis.');
  const result = { benchmark: config.profile.benchmark, variant, caseName, hardware, source: config.sources[variant],
    profile: config.profile, scope: 'Fixed current Native recordings through frozen Renderer/Wasm; no live simulation, HUD, network-state delivery or audio timings. Profile with missing domains is a desktop diagnostic only.',
    coldDrawMs, warmupMs: 1200, settleSeconds: 2, usefulSeconds: 6, refreshPeriodMs, disjoints, deliveredEvents, lastPacket: received, frames,
    summary: { frames: useful.length, fps: (useful.length-1)*1000/((last.elapsed-first.elapsed)*1000),
      intervalP50Ms: percentile(useful.map(x=>x.intervalMs),.5), intervalP95Ms: percentile(useful.map(x=>x.intervalMs),.95),
      maxIntervalMs: percentile(useful.map(x=>x.intervalMs),1), meanDrawMs: mean('drawMs'), p95DrawMs: percentile(useful.map(x=>x.drawMs),.95),
      gpuSamples: useful.filter(x=>Number.isFinite(x.gpuMs)).length, medianGpuMs: percentile(useful.map(x=>x.gpuMs),.5), p95GpuMs: percentile(useful.map(x=>x.gpuMs),.95),
      meanParticles: mean('particles'), maxParticles: percentile(useful.map(x=>x.particles),1),
      maxBurningSources: percentile(useful.map(x=>x.burningSources),1), maxVegetationWaves: percentile(useful.map(x=>x.vegetationWaves),1),
      maxBurningSurfaces: percentile(useful.map(x=>x.burningSurfaces),1),
      maxFlames: percentile(useful.map(x=>x.flames),1),
      meanShots: mean('shots'), meanVisible: mean('visible'), meanDotted: mean('dotted'),
      meanUploadBytes: mean('uploadBytes'), maxUploadBytes: percentile(useful.map(x=>x.uploadBytes),1),
      maxDrawMs:percentile(useful.map(x=>x.drawMs),1),
      ...spec.scenery?{meanFloraQuads:mean('floraQuads'),maxPlantBuilds:percentile(useful.map(x=>x.plantBuilds),1),
        totalPostBuilds:useful.reduce((n,x)=>n+expectNumber(x.postBuilds),0)}:{} },
    valid: useful.length > 5 && document.visibilityState === 'visible' && hardware.pixels[0] === config.profile.viewport[0]*config.profile.dpr && hardware.pixels[1] === config.profile.viewport[1]*config.profile.dpr };
  const status=document.querySelector('#status');if(status)status.textContent = JSON.stringify(result.summary); return result;
} };
