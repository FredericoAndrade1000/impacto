// One entry point for mobile renderer comparisons. Frozen inputs and explicit profile; no silent CPU-only A15 mode.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { mobileProfile } from './mobile-profile.ts';
import { mobileNetwork } from './mobile-network.ts';
import { parseJSON, record, expectRecord, expectString, expectNumber, invoke, errorText, errorMessage } from './operational-input.ts';
import { frozenManifest, recordingIndex, benchmarkSource, benchmarkResult } from './mobile-benchmark-contract.ts';
import type { BenchmarkCase, FrozenManifest, BenchmarkResult } from './mobile-benchmark-contract.ts';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  args: Record<string, string | true> = Object.fromEntries(process.argv.slice(2).map(value => { const [key = '',...rest] = value.replace(/^--/,'').split('='); return [key,rest.length ? rest.join('=') : true]; }));
const argument = (name: string, fallback: string): string => { const value = args[name]; if (value === undefined) return fallback; return expectString(value); };
if (Object.keys(args).some(key => !['input','profile','diagnostic','variants','cases','rounds','network','functional'].includes(key))) throw Error('Opção desconhecida.');
if (['diagnostic','network','functional'].some(key => args[key] !== undefined && args[key] !== true)) throw Error('Flags booleanas usam apenas --diagnostic, --network ou --functional.');
const profileFile = path.resolve(repo, argument('profile', 'benchmarks/a15.json')), profile = mobileProfile(parseJSON(fs.readFileSync(profileFile, 'utf8')), { diagnostic: args.diagnostic === true });
if (!args.input) throw Error('Informe --input=validation/pasta com os manifestos e as gravações do benchmark.');
const directory = path.resolve(repo,expectString(args.input));
if (!directory.startsWith(path.join(repo,'validation') + path.sep)) throw Error('As gravações e saídas devem ficar em validation/.');
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex'), records = recordingIndex(parseJSON(fs.readFileSync(path.join(directory,'records.json'), 'utf8'))),
  variants = argument('variants', 'A,B').split(','), rounds = Number(argument('rounds', '2')),
  allCases: Record<string, BenchmarkCase> = { 'fleet-far': { record:'fleet', zoom:1 }, 'combat-far': { record:'combat', zoom:1 },
    'combat-panorama': { record:'combat', zoom:.677 }, 'fleet-near': { record:'fleet', near:true },
    'forest-entry': { record:'fleet', scenery:'forest', zoom:.145, enter:true },
    'forest-far': { record:'fleet', scenery:'forest', zoom:.2 },
    'forest-near': { record:'fleet', scenery:'forest', zoom:12 },
    'deposits-far': { record:'fleet', scenery:'deposits', zoom:.1 },
    'fire-close':{record:'fire',effect:'burn',zoom:45,photoTick:160},
    'fire-group':{record:'fire',effect:'burnGroup',zoom:10,photoTick:160},
    'fire-surface-close':{record:'fire',effect:'burn',opened:true,zoom:65,photoTick:160},
    'fire-surface-group':{record:'fire',effect:'burnGroup',opened:true,zoom:18,photoTick:160},
    'fire-components-close':{record:'fire',effect:'burn',parts:true,opened:true,zoom:65,photoTick:160},
    'fire-components-group':{record:'fire',effect:'burnGroup',parts:true,opened:true,zoom:18,photoTick:160},
    'muzzle-close':{record:'fire',effect:'muzzle',zoom:30,photoTick:161},
    'powder-smoke':{record:'fire',effect:'muzzle',zoom:45,photoTick:170},
    'explosion-near':{record:'fire',effect:'blast',zoom:20,photoTick:153},
    'explosion-single':{record:'fire',effect:'blastOnce',zoom:32,photoTick:70},
    'dust-group':{record:'fleet',effect:'drive',zoom:10,photoTick:160},
    'dust-road-group':{record:'dust',effect:'drive',zoom:18,photoTick:160},
    'wreck-rise':{record:'wreck',effect:'native',zoom:28,photoTick:42},
    'wreck-landing':{record:'wreck',effect:'native',zoom:24,photoTick:85},
    'wreck-close':{record:'wreck',effect:'native',zoom:32,photoTick:110},
    'wreck-ground':{record:'wreck-ground',effect:'native',zoom:32,photoTick:110},
    'smoke-white-steady':{record:'parked',effect:'muzzle',zoom:32,photoTick:170},
    'smoke-black-steady':{record:'parked',effect:'burn',zoom:32,photoTick:160},
    'blast-steady':{record:'parked',effect:'blastOnce',zoom:28,photoTick:70},
    'vegetation-blast':{record:'fire',scenery:'grass',effect:'vegetation',zoom:65,photoTick:124},
    'vegetation-rest':{record:'fire',scenery:'grass',effect:'vegetation',zoom:65,photoTick:120},
    'vegetation-recovery':{record:'fire',scenery:'grass',effect:'vegetation',zoom:65,photoTick:148},
    'jet-close':{record:'flight',module:'thruster',moduleIndex:1,zoom:110,photoTick:120},
    'jet-ground':{record:'flight',module:'thruster',moduleIndex:1,zoom:65,photoTick:6},
    'jet-group':{record:'flight',zoom:10,photoTick:120},
    'jet-far':{record:'flight',zoom:1,photoTick:120} },
  wantedCases = argument('cases', 'fleet-far,combat-far,combat-panorama,fleet-near').split(','), cases: Record<string, BenchmarkCase> = Object.fromEntries(wantedCases.map(name => { const spec=allCases[name];assert(spec);return [name,spec]; }));
assert(variants.every(name=>/^[A-Z]{1,3}$/.test(name)) && new Set(variants).size === variants.length);
assert([1,2].includes(rounds) && wantedCases.every(name=>allCases[name]));
const sources: Record<string, FrozenManifest> = Object.fromEntries(variants.map(name=>[name,frozenManifest(parseJSON(fs.readFileSync(path.join(directory,name+'-manifest.json'), 'utf8')))]));
if (profile.simulatedDeviceFPS) {
  assert(profile.calibration, 'Calibração ausente.');
  assert.equal(profile.calibration.inputsSHA256,sha(fs.readFileSync(path.join(directory,'records.json'))),'Calibração de outros inputs.');
  for (const name of ['host','reference']) {
    const file:unknown=profile.calibration[name+'File']; assert(typeof file==='string','Falta resultado bruto de calibração: '+name);
    assert.equal(sha(fs.readFileSync(path.resolve(repo,file))),profile.calibration[name+'SHA256'],'Resultado de calibração mudou: '+name);
  }
}
function verify() {
  for (const [name,source] of Object.entries(sources)) for (const [file,record] of Object.entries(source.files))
    assert.equal(sha(fs.readFileSync(path.join(directory,'frozen',name,file))),record.sha256, name+'/'+file+' mudou.');
  for (const record of Object.values(records.records)) assert.equal(sha(fs.readFileSync(path.join(directory,record.file))),record.sha256);
}
verify();
assert(process.env.LOCALAPPDATA, 'LOCALAPPDATA indisponível para localizar o Playwright existente.');
const require = createRequire(path.join(repo,'package.json')), cache = path.join(process.env.LOCALAPPDATA,'ms-playwright'), candidates = ['playwright','playwright-core'];
if(fs.existsSync(path.join(cache,'.links'))) for(const name of fs.readdirSync(path.join(cache,'.links'))) candidates.push(fs.readFileSync(path.join(cache,'.links',name),'utf8').trim());
let chromium: Record<string, unknown> | undefined; for(const installed of candidates) try { const module: unknown = require(installed); if(record(module)&&record(module.chromium)){chromium=module.chromium;break;} } catch {}
assert(chromium,'Playwright existente exigido; nenhuma instalação automática.');
const preferredExecutable = expectString(invoke(chromium,'executablePath')),
  executablePath = fs.existsSync(preferredExecutable) ? preferredExecutable : fs.readdirSync(cache).filter(name=>/^chromium-\d+$/.test(name)).sort((a,b)=>+b.slice(9)-+a.slice(9)).map(name=>path.join(cache,name,'chrome-win64/chrome.exe')).find(fs.existsSync);
assert(executablePath);
const output = path.join(directory,'run-'+new Date().toISOString().replace(/[:.]/g,'-')); fs.mkdirSync(output);
const save = (name: string,value: unknown): void=>fs.writeFileSync(path.join(output,name),JSON.stringify(value,null,2)+'\n');
const config = { benchmark:profile.benchmark, profile, directory:'/'+path.relative(repo,directory).replaceAll('\\','/'), cases,
  sources:Object.fromEntries(Object.entries(sources).map(([name,value])=>[name,benchmarkSource(value)])) };
save('protocol.json',{...config,records,profileFileSHA256:sha(fs.readFileSync(profileFile)),network:args.network ? profile.network : null,
  schedule:`Each case ${variants.join(',')} and inverse order, finite 2s settle+6s measured; first draw retained separately. No failed frame filtering, GC or automatic retry.`,
  limitations:'CPU proxy does not emulate GPU. Valid GPU queries and observed transfer quotas are distinct. Missing calibration => desktop diagnostic, never A15 FPS. Renderer replay has no live WebSocket state traffic; network here affects assets only. Use the TCP link against the real app for online validation.'});
for(const file of ['mobile-benchmark.ts','mobile-benchmark-page.ts','mobile-effects-fixture.ts','mobile-profile.ts','mobile-network.ts','mobile-transfer-bytes.ts','mobile-benchmark-contract.ts','operational-input.ts']) fs.copyFileSync(path.join(repo,'scripts',file),path.join(output,file));
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Record<string,unknown> | undefined, context: Record<string,unknown> | undefined, link: Awaited<ReturnType<typeof mobileNetwork>> | undefined;
const results: BenchmarkResult[]=[], failures: {name?:string;error:string;errors?:string[]}[]=[];
try {
  server = await createServer({root:repo,configFile:false,cacheDir:path.join(output,'vite-cache'),logLevel:'warn',
    // Inputs are frozen and HMR is off. Watching every historical validation
    // tree adds unrelated filesystem work and can stall startup and shutdown.
    optimizeDeps:{entries:[]},server:{port:8415,strictPort:true,host:'127.0.0.1',hmr:false,ws:false,watch:null},plugins:[{
      name:'mobile-benchmark',enforce:'pre',
      resolveId(source,importer){ if(source==='#dynamics-host' && importer?.includes('/frozen/')) { const typed=path.join(path.dirname(importer),'wasm-dynamics-host.ts');return fs.existsSync(typed)?typed:path.join(path.dirname(importer),'wasm-dynamics-host.js'); } },
      configureServer(vite){vite.middlewares.use((request,response,next)=>{
        const url = new URL(request.url??'/','http://127.0.0.1');
        if(url.pathname==='/__mobile/config'){response.setHeader('Content-Type','application/json');response.end(JSON.stringify(config));return;}
        const name = url.pathname.match(/^\/__mobile\/record\/(fleet|combat|fire|flight|dust|wreck|parked|wreck-ground)$/)?.[1]; if(!name)return next();
        response.setHeader('Content-Type','application/json');response.setHeader('Content-Encoding','gzip');
        const recorded=records.records[name];if(!recorded)throw Error('Gravação ausente: '+name);
        response.end(fs.readFileSync(path.join(directory,recorded.file)));
      });}
    }]}); await server.listen();
  let port=8415;
  if(args.network){link=await mobileNetwork({targetPort:port,...profile.network});port=link.port;}
  browser=expectRecord(await invoke(chromium,'launch',{executablePath,headless:true,args:['--disable-background-timer-throttling','--disable-backgrounding-occluded-windows','--disable-renderer-backgrounding']}));
  context=expectRecord(await invoke(browser,'newContext',{viewport:{width:profile.viewport[0],height:profile.viewport[1]},deviceScaleFactor:profile.dpr}));
  for(let round=0;round<rounds;round++) for(const caseName of round ? [...wantedCases].reverse() : wantedCases) for(const variant of round ? [...variants].reverse() : variants){
    const page=expectRecord(await invoke(context,'newPage')), errors:string[]=[], name=`${round+1}-${variant}-${caseName}`;
    console.log('START '+name);
    invoke(page,'on','pageerror',(error: unknown)=>errors.push(errorMessage(error)));
    try {
      const cdp=expectRecord(await invoke(context,'newCDPSession',page));await invoke(cdp,'send','Emulation.setCPUThrottlingRate',{rate:profile.cpu.rate});
      await invoke(page,'goto',`http://127.0.0.1:${port}/scripts/mobile-benchmark.html?variant=${variant}&case=${caseName}`);
      await invoke(page,'waitForFunction',()=>window.mobileBenchmark?.ready,undefined,{timeout:90000});
      const result: BenchmarkResult=args.functional ? {photo:expectRecord(await invoke(page,'evaluate',()=>{if(!window.mobileBenchmark)throw Error('Benchmark ausente.');return window.mobileBenchmark.photo();})),valid:true,variant,caseName,source:config.sources[variant],profile} : benchmarkResult(await invoke(page,'evaluate',()=>{if(!window.mobileBenchmark)throw Error('Benchmark ausente.');return window.mobileBenchmark.run();}));
      Object.assign(result,{round:round+1,errors,browser:invoke(browser,'version')});
      result.valid &&= !errors.length && (args.functional ? expectNumber(expectRecord(result.photo).paintPending)===0 : expectNumber(expectRecord(result.summary).gpuSamples)>0 && !/swiftshader|llvmpipe|software raster|basic render/i.test(String(expectRecord(result.hardware).gpu)));
      save(name+'.json',result); results.push(result);
      if(args.functional) await invoke(invoke(page,'locator','#stage canvas'),'screenshot',{path:path.join(output,name+'.png')});
      else await invoke(page,'screenshot',{path:path.join(output,name+'.png')});
      console.log(JSON.stringify({name,valid:result.valid,...result.summary,...result.photo}));
      if(!result.valid)throw Error('Captura inválida; encerrada sem repetição automática.');
    } catch(error){ failures.push({name,error:errorText(error),errors}); try{await invoke(page,'screenshot',{path:path.join(output,name+'-failure.png')});}catch{}throw error; }
    finally{await invoke(page,'close');}
  }
}catch(error){if(!failures.length)failures.push({error:errorText(error)});console.error(String(error));process.exitCode=1;}
finally{
  if(context)await invoke(context,'close');if(browser)await invoke(browser,'close');await link?.close();await server?.close();
  let sourcesVerified=true;
  try{verify();}catch(error){sourcesVerified=false;failures.push({error:String(error)});process.exitCode=1;}
  save('summary.json',{benchmark:profile.benchmark,profile,valid:!failures.length,results,failures,network:link?.metrics||null,
    ownBrowserClosed:true,ownServerClosed:true,sourcesVerified,host:{cpus:os.cpus()[0]?.model,memoryBytes:os.totalmem()},
    label:profile.label,simulatedDeviceFPS:profile.simulatedDeviceFPS});
  console.log('SUMMARY '+path.join(output,'summary.json'));
}
