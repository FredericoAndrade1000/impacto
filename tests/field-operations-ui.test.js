import test from 'node:test';
import assert from 'node:assert/strict';
import { initFactionUX } from '../src/faction-ux.ts';
import { jobText, dismantlePlan } from '../src/faction-ui.ts';
import { bill, load } from '../src/economy.ts';
import { descendants } from './helpers/dom.js';

class Element {
  constructor(tag) { this.tagName=tag.toUpperCase();this.children=[];this.dataset={};this.attributes=new Map();this.hidden=false;this.disabled=false;this._text='';this.title=''; }
  set textContent(text) { this._text=String(text);this.children=[]; }
  get textContent() { return this._text+this.children.map(child=>child.textContent).join(''); }
  append(...children) { for(const child of children){child.parentNode=this;this.children.push(child);} }
  before(child) { child.parentNode=this.parentNode;this.parentNode.children.splice(this.parentNode.children.indexOf(this),0,child); }
  replaceChildren(...children) { this.children=[];this.append(...children); }
  setAttribute(key,value) { this.attributes.set(key,String(value)); }
  getAttribute(key) { return this.attributes.get(key)??null; }
  querySelector(selector) { return this.children.find(child=>'.'+child.className===selector)||this.children.map(child=>child.querySelector(selector)).find(Boolean)||null; }
  addEventListener(type,action) { this['on'+type]=action; }
  get options() { return this.tagName === 'SELECT' ? this.children : undefined; }
  focus() { this.focused=true; }
}
function setup(t) {
  const before=globalThis.document,elements=new Map(),get=id=>{
    // This unit page does not mount the separately tested window of the faction.
    if(id==='faction-dialog')return null;
    if(!elements.has(id))elements.set(id,new Element('div'));return elements.get(id);
  };
  globalThis.document={getElementById:get,createElement:tag=>new Element(tag)};
  t.after(()=>{globalThis.document=before;});
  get('unit-panel').append(get('unit-services'));
  const requests=[],toasts=[],quotes=[{id:'supply',auto:false}],network={enabled:false,faction:{units:quotes},
    command:async(type,data)=>{requests.push({type,data});return{refund:bill(40),lost:bill(2)};}},
    state={focus:'supply',selected:[]},renderer={canvas:new Element('canvas')},noop=()=>{},ux=initFactionUX({network,renderer,
      toast:(...args)=>toasts.push(args),refresh:noop,stopControls:noop,remember:noop,serviced:()=>state.focus,
      leaving:id=>left.push(id),showPlace:noop}),left=[],
    empty={faction:null,automatic:null,builder:null,dismantling:null},
    render=patch=>ux.render({...empty,...patch}),find=className=>get('unit-panel').querySelector('.'+className);
  // The question asked first (confirm-dialog.ts), and the answer the player gives it.
  const dialog=get('confirm-dialog'),asked=[];
  Object.assign(dialog,{showModal(){this.open=true;asked.push([get('confirm-title').textContent,get('confirm-text').textContent]);},close(){this.open=false;}});
  const answer=value=>dialog.onclick({target:{closest:()=>({value})}});
  return{get,render,find,requests,toasts,quotes,state,renderer,network,ux,asked,answer,left};
}
const supply=patch=>({actorId:'supply',on:false,status:'',title:'Uma ordem sua o pausa até ser cumprida; Parar o desliga.',...patch});

test('the contextual automatic switch sends one explicit request and waits for the real published value',async t=>{
  const f=setup(t);f.render({automatic:supply()});
  const section=f.find('unit-dispatch'),button=f.find('unit-operation-toggle');
  assert.equal(section.hidden,false);assert.equal(button.getAttribute('aria-pressed'),'false');
  assert.match(section.textContent,/Automático/);assert.match(section.textContent,/Desligado/);
  await button.onclick();
  assert.deepEqual(f.requests,[{type:'auto',data:{actorId:'supply',on:true}}]);
  assert.equal(button.getAttribute('aria-pressed'),'false','a command acknowledgement does not invent an updated quote');
  f.quotes[0].auto=true;f.render({automatic:supply({on:true,status:'levando suprimentos ao veículo 2'})});
  assert.equal(f.find('unit-operation-toggle'),button,'the clickable control survives status changes');
  assert.equal(button.getAttribute('aria-pressed'),'true');
  assert.match(section.textContent,/levando suprimentos ao veículo 2/);
  await button.onclick();assert.deepEqual(f.requests.at(-1),{type:'auto',data:{actorId:'supply',on:false}});
});

// The switch of the fuel return of an aircraft (Volta automática à base) beside the automatic one: one request each press,
// for the aircraft in focus, and it shows what the field says of it next.
test('the fuel return switch of an aircraft asks the field once, for the aircraft in focus, and waits for its published value',async t=>{
  const f=setup(t),homing=patch=>({actorId:'air',on:true,status:'Volta sozinha para reabastecer e recusa ordens que a deixariam sem combustível para voltar.',title:'Ligada, a aeronave guarda combustível.',...patch});
  f.quotes.push({id:'air',homing:true});f.state.focus='air';f.render({homing:homing()});
  const section=f.find('unit-homing'),button=section.querySelector('.unit-operation-toggle');
  assert.equal(section.hidden,false);assert.equal(f.find('unit-dispatch').hidden,true,'an aircraft that does no work for its faction has no automatic switch');
  assert.equal(button.getAttribute('aria-pressed'),'true');assert.match(section.textContent,/Volta automática à base/);assert.match(section.textContent,/Ligada/);
  assert.match(section.textContent,/recusa ordens/);assert.equal(button.title,'Ligada, a aeronave guarda combustível.');
  await button.onclick();
  assert.deepEqual(f.requests,[{type:'homing',data:{actorId:'air',on:false}}]);
  assert.match(f.toasts.at(-1)[0],/Volta automática desligada/);
  assert.equal(button.getAttribute('aria-pressed'),'true','an acknowledgement does not invent the new value');
  f.quotes[1].homing=false;f.render({homing:homing({on:false,status:'Não volta sozinha para reabastecer.'})});
  assert.equal(button.getAttribute('aria-pressed'),'false');assert.match(section.textContent,/Desligada/);
  f.state.focus='other';await button.onclick();assert.equal(f.requests.length,1,'nothing is asked for an aircraft out of focus');
  f.render({});assert.equal(section.hidden,true);
});

test('missing selection and a pending toggle never issue an automatic order',async t=>{
  const f=setup(t);f.render({automatic:supply()});const button=f.find('unit-operation-toggle');
  f.state.focus='other';await button.onclick();assert.equal(f.requests.length,0);
  f.state.focus='supply';let release;
  f.network.command=(type,data)=>{f.requests.push({type,data});return new Promise(resolve=>{release=resolve;});};
  const pending=button.onclick();await button.onclick();assert.equal(f.requests.length,1,'a second press cannot issue a second unacknowledged toggle');
  release({});await pending;
  f.render({});assert.equal(f.find('unit-field-operations').hidden,true);
});

test('a builder says only what it works on: a works is opened from the workshop, and a builder in automatic goes to it',t=>{
  const f=setup(t);f.render({builder:{status:'Montando Posto de defesa leve · 40%'}});
  const section=f.find('unit-builder');
  assert.deepEqual([section.hidden,section.children.length,section.textContent],[false,1,'Montando Posto de defesa leve · 40%']);
  assert(!descendants(section).some(element=>element.tagName==='BUTTON'),'no button opens a works from the builder');
  // With nothing to say, it has no block.
  f.render({builder:{status:''}});assert.deepEqual([section.hidden,f.find('unit-field-operations').hidden],[true,true]);
});

test('a structure taken down says how far that has gone beside Cancelar desmontagem; it is moved and taken down from Mais ações',async t=>{
  const f=setup(t);f.state.focus='post';
  f.render({});const section=f.find('unit-dismantle');
  assert.deepEqual([section.hidden,f.find('unit-field-operations').hidden],[true,true],'a structure standing has no block in the panel');
  const dismantling={actorId:'post',moving:true,progress:.5,text:'Desmontando para a mudança · 50% · braço construtor trabalhando'};
  f.render({dismantling});const [keep,status]=section.children;
  assert.deepEqual([section.hidden,section.children.length,keep.textContent,status.textContent],
    [false,2,'Cancelar desmontagem','Desmontando para a mudança · 50% · braço construtor trabalhando']);
  assert(!descendants(f.get('unit-panel')).some(element=>element.tagName==='BUTTON'&&['Mover','Mudar de lugar','Desmontar'].includes(element.textContent)),
    'Mudar de lugar and Desmontar are in Mais ações');
  f.network.command=async(type,data)=>{f.requests.push({type,data});return{kept:'post',heap:'c9'};};
  await keep.onclick();assert.deepEqual(f.requests.at(-1),{type:'cancel-dismantle',data:{actorId:'post'}});
  assert.equal(f.toasts.at(-1)[0],'Desmontagem cancelada: a estrutura fica onde está e a obra nova foi cancelada; o material dela ficou no local.');
  // For another selection nothing is asked, nor once it is no longer taken down.
  f.state.focus='other';await keep.onclick();f.state.focus='post';f.render({});await keep.onclick();
  assert.deepEqual([f.requests.length,section.hidden],[1,true]);
});

// Constructions of the faction as it quotes them: a vehicle standing still in the base and calm unless told otherwise, and a structure.
const quote=(id,patch={})=>({id,vehicle:true,atBase:true,still:true,calm:true,service:null,value:bill(1000),supplies:null,cargo:load(),...patch});

test('one vehicle or one structure picked alone is dismantled as it always was, asked first',async t=>{
  const f=setup(t);
  let asked=f.ux.dismantle(dismantlePlan([quote('lorry',{cargo:load(300)})]));f.answer('cancel');await asked;
  assert.deepEqual([f.asked,f.requests],[[['Desmontar este veículo?','O veículo sai do campo de vez: Ferro 1.000 de volta aos estoques da facção e carga Ferro 300 no pátio.']],[]]);
  f.network.command=async(type,data)=>{f.requests.push({type,data});return{removed:data.actorId,selected:null,refund:bill(1000),cargo:load(300)};};
  asked=f.ux.dismantle(dismantlePlan([quote('lorry',{cargo:load(300)})]));f.answer('ok');await asked;
  assert.deepEqual([f.requests,f.toasts.at(-1)],[[{type:'remove',data:{actorId:'lorry'}}],['Veículo desmontado · Ferro 1.000 de volta aos estoques da facção e carga Ferro 300 no pátio.']]);
  f.network.command=async(type,data)=>{f.requests.push({type,data});return{dismantling:data.actorId,seconds:13};};
  asked=f.ux.dismantle(dismantlePlan([quote('post',{vehicle:false,atBase:false})]));f.answer('ok');await asked;
  assert.equal(f.asked.at(-1)[0],'Desmontar esta estrutura?');assert.match(f.asked.at(-1)[1],/^Um construtor em automático vai até ela e a desmonta no lugar/);
  assert.deepEqual([f.requests.at(-1),f.toasts.at(-1)],[{type:'remove',data:{actorId:'post'}},['Desmontagem iniciada: um construtor em automático vai até ela.']]);
});

test('several picked are dismantled with one question, those that may not be left out, and one notice of what came of it',async t=>{
  const f=setup(t),plan=dismantlePlan([quote('a'),quote('b',{cargo:load(0,0,50)}),quote('away',{atBase:false}),quote('fighting',{calm:false}),
    quote('post',{vehicle:false,atBase:false}),quote('cabled'),quote('busy',{service:{kind:'repair'}})],id=>id==='cabled');
  assert.deepEqual([plan.ids,plan.vehicles,plan.structures,plan.left,plan.out,plan.reason],
    [['a','b','post'],2,1,4,'1 fora da base, 1 em combate, 1 no cabo, 1 em serviço','']);
  f.network.command=async(type,data)=>{f.requests.push({type,data});
    if(data.actorId==='b')throw new Error('Solte o cabo antes de modificar ou desmontar o veículo.');
    return data.actorId==='post'?{dismantling:'post',seconds:13}:{removed:data.actorId,selected:null,refund:bill(1000),cargo:load()};};
  const asked=f.ux.dismantle(plan);f.answer('ok');await asked;
  assert.deepEqual(f.asked,[['Desmontar 2 veículos e 1 estrutura?','Os veículos saem do campo de vez: Ferro 2.000 de volta aos estoques da facção e carga Sílica 50 no pátio. '+
    'Um construtor em automático vai até a estrutura e a desmonta no lugar. O material fica num monte ali, que ele mesmo ou um caminhão de suprimentos leva à base. '+
    'Ficam de fora: 1 fora da base, 1 em combate, 1 no cabo, 1 em serviço.']]);
  assert.deepEqual(f.requests.map(request=>request.data.actorId),['a','b','post'],'one request each, of those that may be');
  assert.deepEqual(f.toasts.at(-1),['1 veículo desmontado · 1 estrutura em desmontagem · 1 recusada: Solte o cabo antes de modificar ou desmontar o veículo.',false]);
  // All refused is bad news; none that may be asks nothing.
  f.network.command=async()=>{throw new Error('Essa construção já não está no campo.');};
  const again=f.ux.dismantle(dismantlePlan([quote('a'),quote('c')]));f.answer('ok');await again;
  assert.deepEqual(f.toasts.at(-1),['2 recusadas: Essa construção já não está no campo.',true]);
  const none=dismantlePlan([quote('away',{atBase:false}),quote('fighting',{calm:false})]),before=f.asked.length;
  assert.deepEqual([none.ids,none.reason],[[],'Nenhuma pode ser desmontada agora: 1 fora da base, 1 em combate.']);
  await f.ux.dismantle(none);assert.equal(f.asked.length,before);
});

test('the construction in focus is abandoned once the player says so, and its going is no news',async t=>{
  const f=setup(t);f.state.focus='lorry';
  f.network.command=async(type,data)=>{f.requests.push({type,data});return{removed:data.actorId,selected:null};};
  let asked=f.ux.abandon();f.answer('cancel');await asked;assert.deepEqual([f.asked[0][0],f.requests,f.left],['Abandonar esta construção?',[],[]]);
  asked=f.ux.abandon();f.answer('ok');await asked;await new Promise(setImmediate);
  assert.deepEqual([f.left,f.requests,f.toasts.at(-1)],[['lorry'],[{type:'abandon',data:{actorId:'lorry'}}],['Construção abandonada: agora são destroços.']]);
});

test('job messages do not invent a destination, movement or completed delivery out of automatic',()=>{
  const unit={auto:false,supplies:bill(20),job:{kind:null,phase:'paused',targetId:null,reason:''}};
  assert.equal(jobText(unit),'');
  assert.equal(jobText({...unit,auto:true,job:{kind:'rearm',phase:'deliver',targetId:'unknown',reason:''}}),'levando suprimentos à frota');
  for(const[reason,text]of[['immobile','sem mobilidade'],['blocked-way','caminho bloqueado'],['stuck-ground','atolado'],['stuck-grip','patinando · sem avanço'],['stuck-slope','sem força para a subida']])
    assert.equal(jobText({...unit,auto:true,job:{kind:null,phase:'idle',reason}}),text);
  assert.equal(jobText({...unit,job:{kind:null,phase:'paused',reason:'manual-control'}}),'sob seu controle');
  assert.equal(jobText({...unit,auto:true,job:{kind:null,phase:'paused',reason:'manual-control'}}),'pausado · sob seu controle');
});

test('the faction page shows the key of the seat in groups, copies it as shown, and changes it only once the player confirms', async t => {
  const f = setup(t), key = 'ABCD2345EFGH6789JKMN0PQR', copied = [], said = [], navigation = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { value: { clipboard: { writeText: async text => { copied.push(text); } } }, configurable: true });
  t.after(() => Object.defineProperty(globalThis, 'navigator', navigation));
  const dialog = f.get('confirm-dialog');
  Object.assign(dialog, { showModal() { this.open = true; said.push(f.get('confirm-title').textContent); }, close() { this.open = false; } });
  const answer = value => dialog.onclick({ target: { closest: () => ({ value }) } });
  // Off the field, or with no connection, there is no key to show.
  f.render({}); assert.equal(f.get('key-section').hidden, true);
  Object.assign(f.network, { enabled: true, connected: true, token: key, faction: { ...f.network.faction, id: 'f1', name: 'Teste', flag: { country: 'br' }, invites: [], request: null, requests: [], library: [] } });
  f.render({});
  assert.deepEqual([f.get('key-section').hidden, f.get('access-key').textContent], [false, 'ABCD-2345-EFGH-6789-JKMN-0PQR']);
  await f.get('access-key-copy').onclick();
  assert.deepEqual([copied, f.toasts.at(-1)], [['ABCD-2345-EFGH-6789-JKMN-0PQR'], ['Chave copiada.']]);
  // Changing it is asked first: refused, nothing changes; confirmed, the field gives another, which the page shows.
  let changes = 0; f.network.rekey = async () => { changes++; f.network.token = 'WXYZ2345EFGH6789JKMN0PQR'; return f.network.token; };
  const refused = f.get('access-key-change').onclick(); answer('cancel'); await refused;
  assert.deepEqual([said, changes], [['Trocar a chave de acesso?'], 0]);
  const accepted = f.get('access-key-change').onclick(); answer('ok'); await accepted;
  assert.equal(changes, 1); assert.equal(f.toasts.at(-1)[0], 'Chave trocada. Use a nova para entrar em outros aparelhos.');
  f.render({}); assert.equal(f.get('access-key').textContent, 'WXYZ-2345-EFGH-6789-JKMN-0PQR');
});

// The panel of a vehicle on a cable, with the own-faction actor metadata a normal frame publishes. The cable is asked
// for on the field (tow-order.test.js); here it is only told, and let go of.
function towing(t) {
  const f = setup(t), actor = (id, x, patch = {}) => ({ id, name: 'Caminhão ' + id, team: 'f1', ownerId: 'player',
    preset: 'vehicle', vehicle: { x, y: 1, angle: 0 }, ...patch }), tug = actor('tug', 0), damaged = actor('damaged', 5);
  Object.assign(f.network, { enabled: true, connected: true, token: '', socket: {}, faction: {
    id: 'f1', name: 'Teste', flag: { country: 'br' }, units: [], invites: [], request: null, requests: [], library: [],
  } });
  f.renderer.state = { shared: true, actors: [tug, damaged, actor('foreign', 3, { team: 'f2' })], modules: [], plates: [], tows: [] };
  f.state.focus = tug.id;
  const squad = { units: [{ id: 'tug', number: 1, name: 'Reboque' }, { id: 'damaged', number: 2, name: 'Caminhão' }] },
    paint = (patch = {}) => f.render({ situation: 'command', squad, ...patch }); paint();
  const host = descendants(f.get('unit-panel')).find(element => element.id === 'unit-tow'),
    release = descendants(host).find(element => element.tagName === 'BUTTON'),
    cable = () => ({ actorId: tug.id, targetId: damaged.id, anchorA: { x: 1, y: 1 }, anchorB: { x: 4, y: 1 }, length: 3, tension: 0, limit: 10000 });
  return { ...f, host, release, paint, cable };
}

test('a vehicle on no cable has no towing line in its panel: the cable is asked for on the field', t => {
  const f = towing(t);
  assert(f.host, 'the line stands in the panel of the vehicle'); assert.equal(f.host.hidden, true);
  assert(!descendants(f.get('unit-panel')).some(element => element.tagName === 'SELECT'), 'no list of every vehicle of the faction');
  f.renderer.state.tows = [f.cable()]; f.paint({ situation: 'workshop' });
  assert.equal(f.host.hidden, true, 'only while commanding or driving on the field');
});

test('the vehicle that pulls says what it tows and lets go with Soltar; the next frame ends the line', async t => {
  const f = towing(t); f.renderer.state.tows = [f.cable()]; f.paint();
  assert.equal(f.host.hidden, false);
  assert.equal(f.host.textContent, 'Rebocando Caminhão (2)Conduza ou use Mover.Soltar');
  await f.release.onclick();
  assert.deepEqual(f.requests, [{ type: 'tow', data: { act: 'detach', actorId: 'tug' } }]);
  assert.deepEqual(f.toasts.at(-1), ['Cabo solto.']);
  f.paint(); assert.equal(f.host.hidden, false, 'an acknowledgement is no frame: the cable stays until the field drops it');
  f.renderer.state.tows = []; f.paint(); assert.equal(f.host.hidden, true);
});

test('the towed end says what pulls it and lets go itself, without asking for the vehicle another member may hold', async t => {
  const f = towing(t); f.renderer.state.tows = [f.cable()]; f.state.focus = 'damaged'; f.paint();
  assert.equal(f.host.textContent, 'Rebocado por Reboque (1)Solte o cabo para conduzir.Soltar');
  await f.release.onclick();
  assert.deepEqual(f.requests, [{ type: 'tow', data: { act: 'detach', actorId: 'damaged' } }]);
});

test('with an engine of its own the towed vehicle pulls and brakes with the one that tows it, and both ends say so', t => {
  const f = towing(t); f.renderer.state.tows = [f.cable()];
  const damaged = f.renderer.state.actors.find(actor => actor.id === 'damaged');
  damaged.vehicle = { ...damaged.vehicle, engine: true, enabled: true, gearCount: 4 }; f.paint();
  assert.equal(f.host.textContent, 'Rebocando Caminhão (2)Os dois puxam e freiam juntos. Conduza ou use Mover.Soltar');
  f.state.focus = 'damaged'; f.paint();
  assert.equal(f.host.textContent, 'Rebocado por Reboque (1)Os dois puxam e freiam juntos. Solte o cabo para conduzir.Soltar');
  // Out of fuel or with its engine gone, it gives no power and is pulled: the line says nothing of it.
  damaged.vehicle = { ...damaged.vehicle, engine: false }; f.paint();
  assert.equal(f.host.textContent, 'Rebocado por Reboque (1)Solte o cabo para conduzir.Soltar');
});

test('Soltar keeps one pending request, and an old selection or connection hears no answer', async t => {
  const f = towing(t), pending = [];
  f.network.command = (type, data) => { f.requests.push({ type, data }); return new Promise((resolve, reject) => pending.push({ resolve, reject })); };
  f.renderer.state.tows = [f.cable()]; f.paint();
  const first = f.release.onclick(); f.paint(); await f.release.onclick();
  assert.equal(f.requests.length, 1, 'a repeated press cannot send twice'); assert.equal(f.release.disabled, true);
  f.state.focus = 'damaged'; pending[0].reject(new Error('Recusa da seleção anterior.')); await first; f.paint();
  assert.equal(f.toasts.length, 0, 'the answer for another selection is not told'); assert.equal(f.release.disabled, false);
  const second = f.release.onclick(); f.network.socket = {}; pending[1].resolve({}); await second;
  assert.equal(f.toasts.length, 0, 'nor the one for an old connection');
  const refused = f.release.onclick(); pending[2].reject(new Error('Essa construção já não está no campo.')); await refused;
  assert.deepEqual(f.toasts.at(-1), ['Essa construção já não está no campo.', true]);
});
