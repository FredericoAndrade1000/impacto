import type { DomView } from './dom-view.ts';
import type { ConstructionTemplate } from './construction-template-catalogue.ts';
import type { SupplyBill,StockId } from './economy-contract.ts';
import type { TestAct,TestActor,TestRequest,TestResultFor,TestSpeed } from './field-protocol-contract.ts';
export type TestConsoleActor = Pick<TestActor,'id'|'x'|'mobile'|'active'> & {name?:string|undefined;facing?:number|undefined};
export interface TestConsoleContext {
 key:unknown;available:boolean;trial:boolean;testServer:boolean;open:boolean;blocked:string;
 actors:readonly TestConsoleActor[];selectedId?:string|null|undefined;stock?:SupplyBill|null|undefined;speed?:TestSpeed|null|undefined;
}
export interface TestConsoleOptions {
 request<Act extends TestAct>(intent:Extract<TestRequest,{act:Act}>):Promise<TestResultFor<Act>>;
 cameraX():number;stopControls():void;refresh?():unknown;notify?(message:string,error?:boolean):unknown;
}
interface PendingRequest {key:unknown;selection?:string}
type TestConsoleUi = Pick<DomView,'get'|'set'|'apply'>;
function inputControl(ui:TestConsoleUi,selector:string):HTMLInputElement {
 const element=ui.get(selector);
 if (!isInput(element)) throw new TypeError('Controle de entrada ausente: '+selector);
 return element;
}
function selectControl(ui:TestConsoleUi,selector:string):HTMLSelectElement {
 const element=ui.get(selector);
 if (!isSelect(element)) throw new TypeError('Controle de seleção ausente: '+selector);
 return element;
}
const isInput=(element:HTMLElement|null):element is HTMLInputElement=>element?.tagName.toUpperCase()==='INPUT';
const isSelect=(element:HTMLElement|null):element is HTMLSelectElement=>element?.tagName.toUpperCase()==='SELECT';
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object';
const validFacing=(facing:number):facing is -1|1=>facing===-1||facing===1;
import { tr } from './i18n.ts';
import { CONSTRUCTION_TEMPLATES } from './construction-template-catalogue.ts';
import { number } from './format.ts';
import { STOCK_IDS } from './economy.ts';

const vehicles = CONSTRUCTION_TEMPLATES.filter(model => model.type === 'vehicle');
const templates = (models:readonly ConstructionTemplate[]) => models.map<[string,string]>(model => [model.id, model.name]);
const actorName = (actor:TestConsoleActor) => `${actor.name} · ${actor.id}${actor.active ? '' : ' · inativa'}`;
const validStock = (stock:unknown):stock is SupplyBill => record(stock) && STOCK_IDS.every(id => {const value=stock[id];return typeof value==='number' && Number.isSafeInteger(value) && value>=0;});
const validSpeed = (factor:unknown):factor is TestSpeed => factor===1||factor===2||factor===4||factor===8;

// This surface owns only UI intent. The host validates every typed command;
// its roster is for these controls, never a replacement for the visible scene.
export class TestConsole {
  declare ui:TestConsoleUi;declare request:TestConsoleOptions['request'];declare cameraX:()=>number;declare stopControls:()=>void;declare refresh:(()=>unknown)|undefined;declare notify:((message:string,error?:boolean)=>unknown)|undefined;
  declare context:Readonly<TestConsoleContext>|null;declare actors:readonly TestConsoleActor[];declare pending:PendingRequest|null;declare initialized:boolean;declare selectNext:string|null;declare message:string;
  declare x:HTMLInputElement;declare facing:HTMLSelectElement;declare actor:HTMLSelectElement;declare stockInputs:Partial<Record<StockId,HTMLInputElement>>;declare instantInput:HTMLInputElement;declare speed:HTMLSelectElement;declare vehicle:HTMLSelectElement;declare target:HTMLSelectElement;
  declare actions:Record<'vehicle'|'target'|'repair'|'resupply'|'reposition',HTMLElement>;
  constructor(ui:TestConsoleUi,{request,cameraX,stopControls,refresh,notify}:TestConsoleOptions) {
    Object.assign(this, { ui, request, cameraX, stopControls, refresh, notify });
    this.context = null; this.actors = []; this.pending = null;
    this.initialized = false; this.selectNext = null; this.message = '';
    this.x = inputControl(ui,'#test-position-x'); this.facing = selectControl(ui,'#test-facing');
    this.actor = selectControl(ui,'#test-actor');
    this.stockInputs = Object.fromEntries(STOCK_IDS.map(id => [id, inputControl(ui,'#test-stock-'+id)]));
    this.instantInput = inputControl(ui,'#test-instant');
    this.speed = selectControl(ui,'#test-speed');
    this.vehicle = selectControl(ui,'#test-vehicle-template'); this.target = selectControl(ui,'#test-target-template');
    this.actions = {
      vehicle: ui.get('#test-create-vehicle')!, target: ui.get('#test-create-target')!,
      repair: ui.get('#test-repair')!, resupply: ui.get('#test-resupply')!, reposition: ui.get('#test-reposition')!,
    };
    ui.set('#test-vehicle-template', { options: [['', tr('Escolha um veículo')], ...templates(vehicles)], value: '' });
    ui.set('#test-target-template', { options: [['', tr('Escolha um alvo')], ...templates(CONSTRUCTION_TEMPLATES)], value: '' });
    this.actions.vehicle.onclick = () => this.act('spawn', 'vehicle');
    this.actions.target.onclick = () => this.act('spawn', 'target');
    for (const act of (['repair', 'resupply', 'reposition'] as const)) this.actions[act].onclick = () => this.act(act);
    ui.get('#test-refresh-actors')!.onclick = () => this.act('list');
    ui.get('#test-use-camera')!.onclick = () => { this.useCamera(); this.edited(); };
    ui.get('#test-set-stock')!.onclick = () => this.act('resources');
    ui.get('#test-use-stock')!.onclick = () => { this.useStock(); this.edited(); };
    ui.get('#test-set-speed')!.onclick = () => this.act('speed');
    for (const element of [this.x, this.vehicle, this.target, this.facing, this.instantInput, this.speed, ...Object.values(this.stockInputs)])
      element.addEventListener('input', () => this.edited());
    this.actor.onchange = () => {
      const actor = this.actors.find(actor => actor.id === this.actor.value);
      if (actor) this.facing.value = String(actor.facing);
      this.edited();
    };
    this.draw();
  }

  get available() { return Boolean(this.context?.available); }
  get blocked() { return this.context?.blocked || ''; }
  get busy() { return Boolean(this.pending); }
  get instant() { return Boolean(this.context?.testServer && this.instantInput.checked); }

  // key is an existing generation/socket identity, stable until this context ends.
  // Only the private trial supplies actors from its frames. A test server lists
  // its world explicitly on open/refresh/action; normal frames retain their fog.
  render(context:Readonly<TestConsoleContext>|null) {
    // Editing in the same explicit test connection hides the surface but keeps
    // its fabrication choice. Disconnect, another socket or a trial clears it.
    const next = context?.available || context?.testServer ? context : null,
      changed = Boolean(this.context) !== Boolean(next) || this.context?.key !== next?.key || this.context?.trial !== next?.trial,
      blockedChanged = this.blocked !== (next?.blocked || ''),
      availabilityChanged = this.available !== Boolean(next?.available),
      speedChanged = this.context?.speed !== next?.speed,
      selectionChanged = !changed && Boolean(next) && this.context?.selectedId !== next!.selectedId;
    this.context = next;
    if (changed) {
      this.actors = []; this.pending = null; this.initialized = false;
      this.selectNext = null; this.message = '';
      this.x.value = ''; this.facing.value = '-1';
      this.vehicle.value = this.target.value = '';
      this.instantInput.checked = false;
      for (const input of Object.values(this.stockInputs)) input.value = '';
      this.setActors([], '');
    }
    if (changed || speedChanged) this.speed.value = validSpeed(next?.speed) ? String(next!.speed) : '';
    if (selectionChanged) {
      this.selectNext = next!.selectedId || null;
      if (this.pending) this.pending.selection = next!.selectedId || '';
      const actor = this.actors.find(actor => actor.id === next!.selectedId);
      this.actor.value = actor ? actor.id : '';
      if (actor) { this.facing.value = String(actor.facing); if (next!.trial) this.selectNext = null; }
      this.message = '';
    }
    if (next?.trial && next.open) {
      const selected = this.selectNext || this.actor.value;
      this.setActors(next.actors, selected);
      if (this.actors.some(actor => actor.id === this.selectNext)) this.selectNext = null;
    }
    if (selectionChanged && next!.open && !next!.trial && this.selectNext && !this.busy)
      this.act('list', null, this.selectNext, true);
    // Server frame updates do not rebuild or query the separate test roster.
    if (changed || blockedChanged || availabilityChanged || speedChanged || selectionChanged || next?.trial && next.open) this.draw();
  }

  open() {
    if (!this.available || this.blocked) return false;
    this.stopControls();
    let selected = this.selectNext || this.actor.value;
    const first = !this.initialized, adoptFacing = first || Boolean(this.selectNext);
    if (first) {
      this.initialized = true; this.useCamera();
      this.useStock();
      selected = this.context!.selectedId || '';
    }
    if (this.context!.trial) {
      this.setActors(this.context!.actors, selected);
      if (this.actors.some(actor => actor.id === this.selectNext)) this.selectNext = null;
      const actor = this.actors.find(actor => actor.id === selected);
      if (actor) this.facing.value = String(actor.facing);
      this.draw();
    } else if (!this.busy) this.act('list', null, selected, adoptFacing);
    return true;
  }

  close() { this.stopControls(); }

  useCamera() {
    const x = this.cameraX();
    if (Number.isFinite(x)) this.x.value = String(Math.round(x * 10) / 10);
  }

  useStock() {
    if (this.context?.testServer && validStock(this.context!.stock)) this.setStock(this.context!.stock);
  }

  setStock(stock:SupplyBill) { for (const id of STOCK_IDS) this.stockInputs[id]!.value = String(stock[id]); }
  stockIntent():SupplyBill { return {ferro:this.stockInputs.ferro!.valueAsNumber,ligas:this.stockInputs.ligas!.valueAsNumber,silica:this.stockInputs.silica!.valueAsNumber,combustivel:this.stockInputs.combustivel!.valueAsNumber}; }

  edited() { this.selectNext = null; this.message = ''; this.draw(); }

  setActors(actors:readonly TestConsoleActor[],selected=this.actor.value) {
    this.actors = actors;
    this.ui.set('#test-actor', { options: [['', tr('Escolha uma construção')], ...actors.map<[string,string]>(actor => [actor.id, actorName(actor)])] });
    const value = actors.some(actor => actor.id === selected) ? selected : '';
    if (this.actor.value !== value) this.ui.set('#test-actor', { value });
  }

  draw() {
    const actor = this.actors.find(actor => actor.id === this.actor.value), ready = this.available && !this.blocked && !this.busy,
      located = Number.isFinite(this.x.valueAsNumber) && validFacing(Number(this.facing.value)), active = actor?.active === true,
      vehicleChosen = vehicles.some(model => model.id === this.vehicle.value), targetChosen = CONSTRUCTION_TEMPLATES.some(model => model.id === this.target.value),
      fixed = Boolean(actor && !actor.mobile), inactive = Boolean(actor && !actor.active),
      description = !actor ? tr('Escolha a construção que receberá a ação.') :
        `${actor.mobile ? tr('Veículo') : tr('Estrutura fixa')} · ${actorName(actor)} · ${number(actor.x, 1)} m. ` +
        (inactive ? this.context?.trial ? tr('Crie outra construção ou use Restaurar para recomeçar o ensaio.') : tr('Crie outra construção para continuar o teste.')
          : tr('A seleção não muda o controle.')),
      testServer = Boolean(this.context?.testServer), stockReady = testServer && validStock(this.context!.stock),
      stockValid = testServer && validStock(this.stockIntent()), speedReady = testServer && validSpeed(this.context!.speed),
      speedValid = testServer && validSpeed(Number(this.speed.value)), status = this.blocked || this.message;
    this.ui.apply({
      'test-console-toggle': { hidden: !this.available, disabled: Boolean(this.blocked),
        title: this.blocked || tr('Painel de testes · F1') },
      'test-console-scope': { text: this.context?.trial ? tr('Campo de provas · alterações só neste ensaio.') : tr('Servidor de testes · ferramentas habilitadas neste servidor.') },
      'test-vehicle-note': { text: this.context?.trial
        ? tr('Troca o veículo deste ensaio. Seu projeto da Oficina continua igual; Restaurar recomeça com ele e com os alvos originais.')
        : tr('O veículo entra na sua frota. Use Conduzir para assumir o controle.') },
      'test-create-vehicle': { disabled: !ready || !located || !vehicleChosen, text: this.context?.trial ? tr('Trocar veículo do teste') : tr('Adicionar veículo') },
      'test-create-target': { disabled: !ready || !located || !targetChosen },
      'test-repair': { disabled: !ready || !active },
      'test-resupply': { disabled: !ready || !active },
      'test-reposition': { disabled: !ready || !active || !located || !actor.mobile },
      'test-reposition-reason': { hidden: !fixed, text: tr('Nesta versão, só veículos podem ser reposicionados.') },
      'test-actor-description': { text: description },
      'test-position-help': { text: this.initialized && !located ? tr('Informe uma posição válida em metros.') : tr('Este local serve para reposicionar a seleção ou criar um modelo do catálogo.') },
      'test-server-tools': { hidden: !testServer },
      'test-private-fabrication-note': { hidden: !this.context?.trial },
      'test-use-stock': { disabled: !ready || !stockReady },
      'test-set-stock': { disabled: !ready || !stockValid },
      'test-instant': { disabled: !ready || !testServer },
      'test-stock-help': { text: !stockReady ? tr('Aguarde o estoque da sua facção.') : !stockValid
        ? tr('Use quatro valores inteiros entre zero e 9.007.199.254.740.991.')
        : tr('Valores absolutos: materiais em créditos e combustível em litros.') },
      'test-server-speed': { hidden: !testServer },
      'test-speed': { disabled: !ready || !testServer },
      'test-set-speed': { disabled: !ready || !speedReady || !speedValid },
      'test-speed-current': { text: speedReady ? tr`Velocidade atual: ${this.context!.speed!}×.` : tr('Aguardando a velocidade do servidor.') },
      'test-console-status': { text: status },
      'test-refresh-actors': { disabled: !ready },
      'test-use-camera': { disabled: !ready },
      'test-position-x': { disabled: !ready }, 'test-facing': { disabled: !ready },
      'test-vehicle-template': { disabled: !ready }, 'test-target-template': { disabled: !ready },
      'test-actor': { disabled: !ready },
    });
    for (const id of STOCK_IDS) this.ui.set('#test-stock-' + id, { disabled: !ready || !testServer });
  }

  intent(act:TestAct,kind?:'vehicle'|'target'|null):TestRequest {
    if (act === 'list') return { act };
    if (act === 'resources') {
      if (!this.context?.testServer) throw new Error(tr('O estoque só pode ser alterado no servidor de testes.'));
      const stock = this.stockIntent();
      if (!validStock(stock)) throw new Error(tr('Use quatro valores inteiros de estoque entre zero e 9.007.199.254.740.991.'));
      return { act, stock };
    }
    if (act === 'speed') {
      if (!this.context?.testServer) throw new Error(tr('A velocidade só pode ser alterada no servidor de testes.'));
      const factor = Number(this.speed.value);
      if (!validSpeed(factor)) throw new Error(tr('Escolha uma velocidade de 1×, 2×, 4× ou 8×.'));
      return { act, factor };
    }
    const x = this.x.valueAsNumber, facing = Number(this.facing.value),
      actor = this.actors.find(actor => actor.id === this.actor.value);
    if (act === 'spawn') {
      const models = kind === 'vehicle' ? vehicles : kind === 'target' ? CONSTRUCTION_TEMPLATES : [],
        templateId = kind === 'vehicle' ? this.vehicle.value : this.target.value;
      const model = models.find(model => model.id === templateId);
      if (!model) throw new Error(tr('Escolha um modelo do catálogo.'));
      if (!Number.isFinite(x) || !validFacing(facing)) throw new Error(tr('Informe uma posição e uma frente válidas.'));
      return { act, kind:kind!, templateId:model.id, x, facing };
    }
    if (!(['repair', 'resupply', 'reposition'] as const).includes(act)) throw new Error(tr('Ação de teste desconhecida.'));
    if (!actor) throw new Error(tr('Escolha uma construção da lista atual.'));
    if (!actor.active) throw new Error(tr('Esta construção está inativa. Crie outra para continuar o teste.'));
    if (act === 'reposition') {
      if (!actor.mobile) throw new Error(tr('Nesta versão, só veículos podem ser reposicionados.'));
      if (!Number.isFinite(x) || !validFacing(facing)) throw new Error(tr('Informe uma posição e uma frente válidas.'));
      return { act, actorId: actor.id, x, facing };
    }
    return { act, actorId: actor.id };
  }

  current(pending:PendingRequest) { return this.pending === pending && this.context?.key === pending.key; }

  async act(act:TestAct,kind:'vehicle'|'target'|null=null,selected=this.actor.value,adoptFacing=false):Promise<boolean> {
    if (!this.available || this.blocked || this.busy) return false;
    if (act === 'list' && this.context!.trial) {
      this.selectNext = null; this.setActors(this.context!.actors, selected); this.message = tr('Lista atualizada.'); this.draw(); return true;
    }
    let intent:TestRequest;
    try { intent = this.intent(act,kind); }
    catch (error) { if (!(error instanceof Error)) throw error; this.message = error.message; this.draw(); return false; }
    const pending:PendingRequest = { key:this.context!.key };
    this.pending = pending; this.selectNext = null;
    this.message = act === 'list' ? tr('Atualizando lista…') : tr('Aplicando no teste…');
    if (act !== 'list') this.stopControls();
    this.draw();
    try {
      const result = await this.request(intent);
      if (!this.current(pending)) return false;
      if (act === 'list') {
        if (!('actors' in result)) throw new TypeError('Resposta de lista de testes inválida.');
        this.setActors(result.actors, pending.selection ?? selected); this.selectNext = null; this.message = tr('Lista atualizada.');
        const actor = (adoptFacing || pending.selection !== undefined) && this.actors.find(actor => actor.id === this.actor.value);
        if (actor) this.facing.value = String(actor.facing);
        return true;
      }
      if (act === 'resources') {
        if (!('stock' in result)) throw new TypeError('Resposta de estoque de testes inválida.');
        this.setStock(result.stock); this.message = tr('Estoque da sua facção atualizado.'); return true;
      }
      if (act === 'speed') {
        if (!('factor' in result)) throw new TypeError('Resposta de velocidade de testes inválida.');
        this.speed.value = String(result.factor);
        this.message = tr`Velocidade do servidor definida em ${result.factor}× para todos.`; return true;
      }
      const spawned = 'actor' in result ? result.actor : null, actorId = 'actorId' in intent ? intent.actorId : undefined;
      if (act==='spawn' && !spawned) throw new TypeError('Resposta de criação de testes inválida.');
      this.message = act === 'spawn' ? kind === 'target' ? `Alvo ${spawned!.id} criado.${this.context!.trial ? '' : tr(' A visibilidade segue os sensores da sua facção.')}` : this.context!.trial ? tr('Veículo do teste trocado.') : tr('Veículo adicionado.')
        : { repair: tr`Reparo aplicado em ${actorId!}.`, resupply: tr`Combustível e munição completos em ${actorId!}.`,
          reposition: tr`Veículo ${actorId!} reposicionado. O controle atual não muda.` }[act];
      const chosen = pending.selection ?? (act === 'spawn' ? spawned!.id : this.actor.value);
      if (this.context!.trial) {
        this.selectNext = act === 'spawn' ? chosen : null;
        this.setActors(this.context!.actors, chosen);
        if (this.actors.some(actor => actor.id === this.selectNext)) this.selectNext = null;
      } else {
        // Refresh only after the accepted action. A list failure must not be
        // reported as failure of a mutation the host already performed.
        try {
          const roster = await this.request({ act: 'list' });
          if (!this.current(pending)) return false;
          this.setActors(roster.actors, pending.selection ?? chosen); this.selectNext = null;
          const actor = pending.selection !== undefined && this.actors.find(actor => actor.id === this.actor.value);
          if (actor) this.facing.value = String(actor.facing);
        } catch (error) {
          if (!this.current(pending)) return false;
          if (!(error instanceof Error)) throw error;
          this.message += tr(' Não foi possível atualizar a lista: ') + error.message;
        }
      }
      return true;
    } catch (error) {
      if (!this.current(pending)) return false;
      if (!(error instanceof Error)) throw error;
      this.message = error.message; this.notify?.(error.message, true); return false;
    } finally {
      if (this.current(pending)) {
        this.pending = null; this.draw(); this.refresh?.();
        if (this.available && this.context!.open && !this.context!.trial && this.selectNext) {
          const selected = this.selectNext; this.selectNext = null;
          this.act('list', null, selected, true);
        }
      }
    }
  }
}
