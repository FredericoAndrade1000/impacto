import { tr } from './i18n.ts';
import { node, icon } from './dom-view.ts';
import { knownVeins } from './faction-ui.ts';
import { CARGO } from './component-volume.ts';
import { confirm } from './confirm-dialog.ts';
import { BUILD_REACH, HOME_CLEARANCE } from './construction-site.ts';
import type { Deposit } from './deposits.ts';
import type { FactionView, FieldView, KnownVein } from './faction-ui.ts';
import type { FieldPanelView, FieldOrderId } from './field-panel.ts';
import type { AuthoredConstruction } from './construction-contract.ts';
import type { CargoKind } from './economy-contract.ts';

export interface ObjectivesWorkspace {
  picked?: readonly string[] | undefined; libraryOpen?: boolean | undefined; edit?: boolean | undefined;
  projectMiner?: boolean | undefined; projectBuilder?: boolean | undefined; task?: string | null | undefined;
  placing?: boolean | undefined; pointChosen?: boolean | undefined; sourcePreset?: AuthoredConstruction['preset'] | undefined;
  armed?: FieldOrderId | null | undefined;
}
export interface FirstObjectivesContext {
  faction?: FactionView | null | undefined; state?: FieldView | null | undefined; deposits?: readonly Deposit[];
  connected?: boolean; panel?: Partial<Pick<FieldPanelView, 'squad' | 'orders' | 'control' | 'controlTitle'>> | null;
  workspace?: ObjectivesWorkspace;
}
export type ObjectiveActionKind = 'pick' | 'release' | 'follow' | 'model' | 'fabricate' | 'publish' | 'models' | 'condition' |
  'explore' | 'collect' | 'confirmDefense' | 'chooseDefensePoint' | 'placeDefense' | 'prepareDefense' | 'defense' | 'moveBuilder' | 'project' | 'control';
interface ObjectiveActionDetails {
  actorId?: string | undefined; templateId?: string; depositId?: string; x?: number;
}
export interface ObjectiveAction extends ObjectiveActionDetails { kind: ObjectiveActionKind; label: string }
interface ObjectiveGuidance { hint: string; action: ObjectiveAction; alternate?: ObjectiveAction }
export interface ObjectiveRow {
  id: ObjectiveId; title: string; complete: boolean; hint: string; action: ObjectiveAction | null; alternate: ObjectiveAction | null;
}
export interface FirstObjectivesModel { fieldId: string; rows: ObjectiveRow[]; count: number; total: number; next: ObjectiveId | null }
type ObjectiveTarget = HTMLElement | null | undefined;
export interface FirstObjectivesOptions {
  host: HTMLElement; tools: HTMLElement; projectTools?: HTMLElement; placementTools?: HTMLElement; restore?: HTMLElement | null;
  storage?: Pick<Storage, 'getItem' | 'setItem'> | undefined; ask?: typeof confirm; onOpen?: () => void;
  onAction?: (action: ObjectiveAction) => unknown; resolveTarget?: (action: ObjectiveAction) => ObjectiveTarget | ObjectiveTarget[];
}
export interface FirstObjectivesRenderOptions extends FirstObjectivesContext { active?: boolean; playerId?: string | null | undefined; touch?: boolean }
interface ObjectiveElements { item: HTMLLIElement; button: HTMLButtonElement; check: HTMLSpanElement }
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing objective view record'); return value; };
type MaterialVein = Extract<KnownVein, { material: CargoKind }>;
const oreVein = (vein: KnownVein): vein is MaterialVein => 'material' in vein && CARGO[vein.material]?.liquid === false;

const OBJECTIVES = Object.freeze([
  ['selectMiner', tr('Selecionar seu minerador'), tr('Você selecionou um veículo capaz de extrair e transportar minério.')],
  ['collectOre', tr('Começar a coletar'), tr('Material de uma jazida entrou na caçamba do seu veículo.')],
  ['deliverOre', tr('Entregar minério à base'), tr('Seu veículo descarregou o minério coletado na base.')],
  ['directControl', tr('Experimentar o controle direto'), tr('Você assumiu um veículo e voltou a Comandar.')],
  ['fabricateVehicle', tr('Fabricar um veículo'), tr('Um veículo que você pediu para fabricar ficou pronto.')],
  ['buildDefense', tr('Construir uma defesa no campo'), tr('Sua defesa fixa ficou pronta, em terreno conhecido fora da base.')],
] as const);
export type ObjectiveId = typeof OBJECTIVES[number][0];
const write = (element: HTMLElement, value: string) => { if (element.textContent !== value) element.textContent = value; };
const attribute = (element: HTMLElement, key: string, value: string) => { if (element.getAttribute(key) !== value) element.setAttribute(key, value); };

// Completion comes only from the player's private server record. The current
// field supplies hints, never evidence inferred from stock, cargo or unit counts.
// The player's own vehicles are those of the faction no other member holds.
export function firstObjectives({ faction, state, deposits = [], connected = true, panel = null, workspace = {} }: FirstObjectivesContext = {}): FirstObjectivesModel | null {
  const progress = faction?.objectives;
  if (!faction || !progress?.fieldId) return null;
  const own = (state?.squad?.units || []).filter(unit => !unit.defeated && !('by' in unit && unit.by)), ids = new Set(own.map(unit => unit.id)),
    selected = new Set(workspace.picked ?? panel?.squad?.units?.filter(unit => unit.selected).map((unit: { id: string }) => unit.id) ?? []),
    actor = (id: string | undefined) => state?.actors?.find(actor => actor.id === id), quote = (id: string) => faction.units?.find(unit => unit.id === id),
    pieces = (state?.modules || []).filter(part => ids.has(part.actorId) && Number(part.health) > 0 && part.attached !== false),
    vehicles = own.filter(unit => actor(unit.id)?.vehicle && quote(unit.id)?.service?.kind !== 'build'),
    miners = vehicles.filter(unit =>
      ['excavator', 'hopper'].every(kind => pieces.some(part => part.actorId === unit.id && part.kind === kind)) &&
      quote(unit.id)?.service?.kind !== 'build'),
    miner = miners.find(unit => selected.has(unit.id)) || miners[0],
    scouts = vehicles.filter(unit => !miners.includes(unit) && pieces.some(part => part.actorId === unit.id && part.kind === 'sensor')),
    scout = scouts.find(unit => selected.has(unit.id)) || scouts[0],
    veins = knownVeins(deposits, faction).filter(oreVein),
    // The vein of ore to collect at is the nearest to the miner that no base stills with something left there, as the
    // faction knows; with none, the nearest that no base stills, which comes back.
    minerX = actor(miner?.id)?.vehicle?.x ?? actor(miner?.id)?.x ?? faction.base?.x ?? 0, nearest = <T extends { x: number }>(list: T[]) => list.sort((a, b) => Math.abs(a.x - minerX) - Math.abs(b.x - minerX))[0],
    workable = veins.filter(vein => vein.active && (!('type' in vein) || vein.type !== 'airdrop' || vein.stock !== undefined && vein.stock > 0)),
    vein = nearest(workable.filter(vein => vein.left !== undefined && vein.left > 0 || vein.stock !== undefined && vein.stock > 0)) ?? nearest(workable),
    held = miners.length && miners.every(unit => quote(unit.id)?.service),
    building = own.find(unit => quote(unit.id)?.service?.kind === 'build' && actor(unit.id)?.vehicle),
    pendingMiner = own.find(unit => quote(unit.id)?.service?.kind === 'build' &&
      ['excavator', 'hopper'].every(kind => pieces.some(part => part.actorId === unit.id && part.kind === kind))),
    hauling = miners.find(unit => unit.haul),
    action = (kind: ObjectiveActionKind, label: string, extra: ObjectiveActionDetails = {}): ObjectiveAction => ({ kind, label, ...extra }),
    chooseMiner = action('pick', tr('Escolher meu minerador'), { actorId: miner?.id }),
    release = action('release', tr('Voltar a Comandar')),
    collection: ObjectiveGuidance = !miner ? pendingMiner ? { hint: tr('Seu minerador está sendo fabricado. Aguarde ficar pronto antes de selecioná-lo e coletar; não é preciso pedir outro.'),
      action: action('follow', tr('Acompanhar a fabricação do minerador'), { actorId: pendingMiner.id }) } :
      workspace.libraryOpen ? { hint: tr('Escolha Caminhão de minério de esteiras pelo botão Construir. Depois confira o custo e fabrique o veículo para ter Escavadeira e Caçamba.'),
      action: action('model', tr('Escolher o modelo de mineração'), { templateId: 'mining-truck' }) } :
      workspace.edit && workspace.projectMiner ? { hint: tr('Seu projeto tem Escavadeira e Caçamba. Confira o custo, fabrique o minerador e aguarde ficar pronto antes de coletar.'),
        action: workspace.task === 'publish' ? action('fabricate', tr('Fabricar o minerador')) : action('publish', tr('Ver custo do minerador')) } :
      { hint: tr('Você precisa de um veículo com Escavadeira e Caçamba. Em Construir, abra a Garagem para escolher um modelo de mineração.'),
        action: action('models', tr('Ver modelos de mineração')) } :
      held ? { hint: tr('Seu minerador está em serviço. Aguarde o término antes de selecionar e coletar.'), action: action('condition', tr('Ver o serviço do minerador'), { actorId: miner.id }) } :
      state?.squad?.manual ? { hint: tr('Use Comandar para voltar às ordens. Depois selecione o minerador e escolha Coletar.'), action: release } :
      !vein ? { hint: !veins.length ? tr('Nenhuma jazida de minério conhecida. Selecione a viatura de reconhecimento na coluna à esquerda e use Mover para explorar.') :
        tr('As jazidas de minério conhecidas ficam junto de bases. Explore com a viatura de reconhecimento para encontrar outra.'),
        action: action(scout && selected.has(scout.id) ? 'explore' : 'pick', scout && selected.has(scout.id) ? tr('Escolher destino para explorar') : tr('Escolher reconhecimento'), { actorId: scout?.id }) } :
      !selected.has(miner.id) ? { hint: tr('Selecione seu minerador na coluna à esquerda. Depois toque em Coletar, sobre uma jazida conhecida no campo.'), action: chooseMiner } :
      { hint: panel?.orders?.find(order => order.id === 'haul')?.reason || tr('Toque em Coletar, sobre a jazida no campo. Aguarde material entrar na caçamba.'),
        action: action('collect', tr('Mostrar a jazida para coletar'), { actorId: miner.id, depositId: vein.id, x: vein.x }) };
  // A defence is a works opened from the workshop, at a place of the field chosen there; a builder in automatic goes there by
  // itself, and standing still beside it puts it up as its material comes — from the base by supply vehicles, or what the
  // builder carries. The works followed is the first the faction opened anew, or else one a structure is moved to.
  const builder = vehicles.find(unit => quote(unit.id)?.builder), work = builder && quote(builder.id),
    pendingBuilder = own.find(unit => quote(unit.id)?.service?.kind === 'build' && pieces.some(part => part.actorId === unit.id && part.kind === 'builder')),
    works = faction.works || [], site = works.find(w => !w.from) || works[0], follow = (label: string) => action('follow', label, { actorId: required(builder).id });
  let defense: ObjectiveGuidance;
  if (workspace.placing) defense = workspace.pointChosen ? {
    hint: tr('Confira o local e use Abrir obra. Abrir a obra não custa nada: o material é levado até ela.'),
    action: action('confirmDefense', tr('Abrir a obra neste ponto')),
  } : { hint: tr`Toque num ponto de chão já visto, a ${HOME_CLEARANCE} m ou mais da base. O contorno mostra onde a defesa fica.`,
    action: action('chooseDefensePoint', tr('Escolher ponto no terreno')) };
  else if (workspace.edit && workspace.sourcePreset === 'bunker') defense = {
    hint: tr('O projeto da defesa está pronto. Use Escolher local no campo e toque num ponto de chão já visto, longe da base.'),
    action: action('placeDefense', tr('Escolher local da defesa')) };
  else if (state?.squad?.manual && !workspace.edit) defense = { hint: tr('Use Comandar para voltar às ordens da frota. Depois selecione o construtor.'), action: release };
  else if (pendingBuilder) defense = { hint: tr('Seu construtor está sendo fabricado. Aguarde ficar pronto.'),
    action: action('follow', tr('Acompanhar a fabricação do construtor'), { actorId: pendingBuilder.id }) };
  else if (!builder && workspace.edit && workspace.projectBuilder) defense = { hint: tr('Confira o custo e fabrique o veículo construtor. Espere ficar pronto antes de levá-lo à obra.'),
    action: workspace.task === 'publish' ? action('fabricate', tr('Fabricar o construtor')) : action('publish', tr('Ver custo do construtor')) };
  else if (!builder) defense = { hint: tr('Para montar uma defesa no campo, você precisa de um veículo com Braço construtor. Abra o modelo do construtor, confira o custo e fabrique-o.'),
    action: action('prepareDefense', tr('Preparar um veículo construtor')) };
  else if (!site) defense = { hint: tr('Abra o posto de defesa leve na Oficina e escolha o local da obra no campo. Um construtor em automático vai até ela e a monta.'),
    action: action('defense', tr('Abrir o posto de defesa leve')) };
  else if (required(required(work).builder).working === site.id) defense = { hint: tr('A obra está sendo montada. Mantenha o construtor parado ao lado até ela ficar pronta.'),
    action: follow(tr('Acompanhar a obra')) };
  else if (site.waiting) defense = { hint: tr('Falta material na obra. Um caminhão de suprimentos em automático traz o resto da base; o construtor monta assim que chegar.'),
    action: follow(tr('Acompanhar a obra')) };
  else if (required(work).service) defense = { hint: tr('Seu construtor está em serviço. Aguarde o término: depois ele vai sozinho à obra.'),
    action: action('condition', tr('Ver o serviço do construtor'), { actorId: builder.id }) };
  else if (required(work).job?.kind === 'build' && required(work).job?.targetId === site.id) defense = { hint: tr('O construtor vai sozinho à obra. Aguarde ele chegar e parar ao lado.'), action: follow(tr('Acompanhar o construtor')) };
  else if (builder.move) defense = { hint: tr('Aguarde o construtor chegar à obra e parar.'), action: follow(tr('Acompanhar o construtor')) };
  else if (required(required(work).builder).ready === false) defense = { hint: required(required(work).builder).reason || tr('O construtor ainda não está pronto. Consulte sua condição.'),
    action: action('condition', tr('Ver condição do construtor'), { actorId: builder.id }) };
  else defense = { hint: tr`Selecione o construtor e use Mover para levá-lo a até ${BUILD_REACH} m da obra. Parado e fora de combate, ele descarrega o material que leva e monta.`,
    action: action('moveBuilder', tr('Levar o construtor à obra'), { actorId: builder.id }) };
  const fabrication: ObjectiveGuidance = building ? { hint: tr('Seu veículo está sendo fabricado. Aguarde o serviço terminar e o veículo ficar disponível no campo.'),
      action: action('follow', tr('Acompanhar a fabricação'), { actorId: building.id }) } :
    workspace.libraryOpen ? { hint: tr('Na Garagem, escolha um modelo de veículo pelo botão Construir. Isso abre o projeto; a fabricação é confirmada depois, com o custo visível.'),
      action: action('model', tr('Escolher modelo de veículo'), { templateId: 'scout' }) } :
    !workspace.edit ? { hint: tr('Abra Construir para preparar um veículo. Você pode escolher um modelo na Garagem antes de conferir o custo de fabricação.'), action: action('project', tr('Abrir Construir')) } :
    workspace.sourcePreset === 'bunker' ? { hint: tr('Este projeto é uma defesa fixa. Para este objetivo, escolha um modelo de veículo na Garagem.'), action: action('models', tr('Escolher um modelo de veículo')) } :
    workspace.task === 'publish' ? { hint: tr('Confira os materiais e o tempo. Use Fabricar veículo para solicitar um novo veículo e aguarde ele ficar pronto.'), action: action('fabricate', tr('Solicitar a fabricação')) } :
      { hint: tr('Em Fabricar, confira o custo do projeto e solicite um novo veículo. Para experimentar outro projeto, use a Garagem de modelos prontos.'),
        action: action('publish', tr('Ver custo e fabricação')), alternate: action('models', tr('Escolher outro modelo')) };
  const selectedVehicle = selected.size === 1 && vehicles.find(unit => selected.has(unit.id)),
    freeVehicle = vehicles.find(unit => !quote(unit.id)?.service),
    directControl: ObjectiveGuidance = state?.squad?.manual ? { hint: tr('Você está no controle direto. Use Comandar, junto dos controles do veículo, para voltar às ordens da frota.'), action: release } :
      selectedVehicle && (quote(selectedVehicle.id)?.service || panel?.control === false) ? {
        hint: quote(selectedVehicle.id)?.service ? tr('Este veículo está em serviço. Aguarde o término para usar Conduzir; consulte a condição para acompanhar.') :
          panel?.controlTitle || tr('O controle deste veículo está indisponível. Consulte a condição ou escolha outro veículo na coluna à esquerda.'),
        action: action('condition', tr('Ver condição do veículo'), { actorId: selectedVehicle.id }) } :
      selectedVehicle ? { hint: tr('Use Conduzir para assumir o veículo destacado. Depois use Comandar para devolver as ordens à frota.'), action: action('control', tr('Assumir o controle direto')) } :
      { hint: tr('Escolha um veículo na coluna à esquerda e use Conduzir. Depois use Comandar para devolver as ordens à frota.'),
        action: freeVehicle ? action('pick', tr('Escolher veículo para conduzir'), { actorId: freeVehicle.id }) : vehicles[0] ?
          action('condition', tr('Ver condição do veículo'), { actorId: vehicles[0].id }) : action('models', tr('Escolher um modelo de veículo')) };
  const guidance: Record<ObjectiveId, ObjectiveGuidance> = {
    selectMiner: state?.squad?.manual ? { hint: tr('Use Comandar para voltar às ordens. Depois escolha seu minerador na coluna à esquerda.'), action: release } :
      miners.length && !held ? { hint: tr('Toque no minerador destacado na coluna à esquerda. Ele tem Escavadeira e Caçamba para extrair e transportar minério.'), action: chooseMiner } : collection,
    collectOre: state?.squad?.manual ? collection : hauling ? { hint: tr('A ordem de coleta está em andamento. Aguarde material de uma jazida entrar na caçamba; uma ordem enviada ainda não conclui o objetivo.'),
      action: action('follow', tr('Acompanhar a coleta'), { actorId: hauling.id }) } : collection,
    deliverOre: state?.squad?.manual ? { hint: tr('Use Comandar para deixar a ordem de coleta continuar. O minerador volta e descarrega automaticamente; não substitua a ordem por Mover.'), action: release } :
      hauling ? { hint: tr('Na ordem Coletar, o minerador retorna à base e descarrega automaticamente. Acompanhe sem substituir a ordem por Mover; só chegar à base não basta.'),
      action: action('follow', tr('Acompanhar a entrega'), { actorId: hauling.id }) } :
      { hint: tr('Use Coletar para carregar minério e deixá-lo voltar à base automaticamente. A conclusão vem quando esse minério é realmente descarregado.'), action: collection.action },
    directControl,
    fabricateVehicle: fabrication, buildDefense: defense,
  };
  const rows = OBJECTIVES.map(([id, title, result]) => {
    const complete = progress.completed?.[id] === true, step = guidance[id];
    return { id, title, complete,
      hint: complete ? result : !connected ? tr('Aguarde a conexão com o campo para continuar. Seu progresso concluído está preservado.') : step.hint,
      action: complete || !connected ? null : step.action, alternate: complete || !connected ? null : step.alternate ?? null };
  });
  return { fieldId: progress.fieldId, rows, count: rows.filter(row => row.complete).length, total: rows.length,
    next: rows.find(row => !row.complete)?.id ?? null };
}

// How the field and the workshop are played, with the mouse and keys or with a finger: nothing over the game says it,
// so the first objectives keep it, in a row of their own beside the objectives.
const CONTROLS = Object.freeze({
  field: { title: tr('Controles do campo'),
    keys: [
      tr('Clique num veículo ou arraste para selecionar; 1–9 escolhem pelo número; duplo clique segue com a câmera.'),
      tr('Com veículos selecionados, o botão direito manda mover, atacar ou coletar numa jazida; com Ctrl, bombardeia.'),
      tr('Cada ordem tem sua tecla, no canto do botão.'),
      tr('Setas movem a vista, a roda aproxima e Home enquadra; Enter escreve na conversa.'),
      tr('C assume o veículo: A/D andam, S freia, clique ou F dispara; Esc devolve.')],
    touch: [
      tr('Toque num veículo ou segure e arraste para selecionar; toque duplo segue com a câmera.'),
      tr('Com veículos selecionados, segure no terreno para mover, atacar ou coletar numa jazida.'),
      tr('Toque na marca de uma jazida ou de destroços para ver o que há ali.'),
      tr('Arraste para mover a vista; dois dedos aproximam e afastam.'),
      tr('Conduzir assume o veículo: os botões à esquerda andam, toque no campo para mirar e Fogo dispara; Comandar devolve.')] },
  workshop: { title: tr('Controles da Oficina'),
    keys: [
      tr('Clique numa peça para ajustá-la; Shift ou Ctrl + clique soma outras; arraste no vazio para marcar várias.'),
      tr('Arraste nós, chapas e peças; Shift + arrastar numa face cria um compartimento; duplo clique na chapa cria um nó.'),
      tr('1, 2, 3… instalam as peças da categoria aberta em Adicionar; R ajusta o chassi.'),
      tr('X remove a seleção e C cancela; Ctrl+Z desfaz e Ctrl+S salva.'),
      tr('Espaço + arrastar move a vista, a roda aproxima e Home enquadra; Enter vai ao campo.')],
    touch: [
      tr('Toque numa peça, no projeto ou na lista, para ajustá-la; segure no vazio e arraste para marcar várias.'),
      tr('Arraste nós, chapas e peças; segure uma face e arraste para criar um compartimento; toque duplo na chapa cria um nó.'),
      tr('Toque no chassi e arraste as pontas para mudar o comprimento.'),
      tr('Em Adicionar, escolha a peça, toque no projeto, arraste até uma posição livre e solte.'),
      tr('Dois dedos movem e aproximam a vista.')] },
});
// The controls of where the player is, the workshop (`edit`) or the field, for the way they play: a finger (`touch`) or the mouse and keys.
export function controlsGuide({ edit = false, touch = false }: { edit?: boolean | undefined; touch?: boolean } = {}) {
  const place = CONTROLS[edit ? 'workshop' : 'field'];
  return { title: place.title, lines: touch ? place.touch : place.keys };
}

export const objectivesPreferenceKey = (fieldId: string, playerId: string | null | undefined) => 'impacto.first-objectives.' + JSON.stringify([fieldId, playerId]);

// This is a nonmodal field aid. Closing it changes only its disclosure, never
// selection, orders or progress. Local storage keeps that preference per seat/field:
// open, closed, or dismissed — out of the top row until `restore`, in the settings, brings it back.
export class FirstObjectives {
  declare readonly host: HTMLElement;
  declare readonly tools: HTMLElement;
  declare readonly projectTools: HTMLElement;
  declare readonly placementTools: HTMLElement;
  declare readonly restore: HTMLElement | null;
  declare readonly ask: typeof confirm;
  declare readonly onAction: NonNullable<FirstObjectivesOptions['onAction']>;
  declare readonly resolveTarget: NonNullable<FirstObjectivesOptions['resolveTarget']>;
  declare readonly storage: Pick<Storage, 'getItem' | 'setItem'>;
  declare readonly toggle: HTMLButtonElement;
  declare readonly toggleLabel: HTMLSpanElement;
  declare readonly toggleCount: HTMLElement;
  declare readonly root: HTMLElement;
  declare readonly count: HTMLSpanElement;
  declare readonly close: HTMLButtonElement;
  declare readonly controls: HTMLButtonElement;
  declare readonly rows: Map<ObjectiveId, ObjectiveElements>;
  declare readonly hintTitle: HTMLElement;
  declare readonly hint: HTMLParagraphElement;
  declare readonly lines: HTMLUListElement;
  declare readonly help: HTMLDivElement;
  declare readonly action: HTMLButtonElement;
  declare readonly alternate: HTMLButtonElement;
  declare readonly dismissal: HTMLButtonElement;
  declare readonly instruction: HTMLSpanElement;
  declare readonly dock: HTMLElement | null;
  declare readonly publicationDock: HTMLElement | null;
  declare readonly chat: HTMLElement | null;
  declare readonly resize?: ResizeObserver;
  declare key: string | null;
  declare open: boolean;
  declare dismissed: boolean;
  declare selected: ObjectiveId | 'controls' | null;
  declare model: FirstObjectivesModel | null;
  declare touch: boolean;
  declare targets: Set<HTMLElement>;
  declare workspace: ObjectivesWorkspace;
  declare current?: ObjectiveRow | null | undefined;
  declare pending?: boolean;
  constructor({ host, tools, projectTools = tools, placementTools = tools, restore = null, storage, ask = confirm,
    onOpen = () => {}, onAction = () => {}, resolveTarget = () => null }: FirstObjectivesOptions) {
    this.host = host; this.key = null; this.open = false; this.dismissed = false; this.selected = null; this.model = null; this.touch = false;
    this.tools = tools; this.projectTools = projectTools; this.placementTools = placementTools; this.restore = restore;
    this.ask = ask; this.onAction = onAction; this.resolveTarget = resolveTarget; this.targets = new Set(); this.workspace = {};
    this.storage = storage ?? { getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) };
    this.toggle = node('button', 'field-tool'); this.toggle.id = 'first-objectives-toggle'; this.toggle.type = 'button'; this.toggle.hidden = true;
    const mark = node('span', 'field-button-icon'); mark.innerHTML = icon('i-help');
    this.toggleLabel = node('span', 'field-button-label', tr('Objetivos')); this.toggleCount = node('small', 'field-tool-count', '0/6');
    this.toggle.append(mark, this.toggleLabel, this.toggleCount); tools.append(this.toggle);
    this.toggle.setAttribute('aria-controls', 'first-objectives'); this.toggle.setAttribute('aria-expanded', 'false');
    this.toggle.onclick = () => {
      const opening = this.workspace.placing ? !this.open : Boolean(this.root.hidden);
      if (opening && !this.workspace.placing) onOpen(); this.disclose(opening);
    };
    this.root = node('section', 'first-objectives'); this.root.id = 'first-objectives'; this.root.hidden = true;
    this.root.setAttribute('aria-labelledby', 'first-objectives-title');
    const heading = node('header'), title = node('h2', '', tr('Primeiros objetivos')); title.id = 'first-objectives-title';
    this.count = node('span', 'first-objectives-count'); this.count.setAttribute('role', 'status');
    this.close = node('button', 'first-objectives-close'); this.close.id = 'first-objectives-close'; this.close.type = 'button';
    this.close.innerHTML = icon('i-close'); this.close.setAttribute('aria-label', tr('Recolher primeiros objetivos'));
    this.close.onclick = () => { this.disclose(false); this.toggle.focus({ preventScroll: true }); };
    heading.append(title, this.count, this.close);
    const content = node('div', 'first-objectives-content');
    content.append(node('p', 'first-objectives-caption', tr('Opcional · faça na ordem que preferir.')));
    const list = node('ul'); this.rows = new Map();
    // The controls of where the player is stand first, apart from the objectives: they are not one of them.
    const controls = node('li'), sign = node('span', 'first-objectives-check'), name = node('span', '', tr('Controles'));
    controls.id = 'first-objectives-controls'; sign.innerHTML = icon('i-controls'); sign.setAttribute('aria-hidden', 'true');
    this.controls = node('button'); this.controls.type = 'button'; this.controls.setAttribute('aria-controls', 'first-objectives-hint');
    this.controls.append(sign, name); this.controls.onclick = () => this.choose('controls');
    controls.append(this.controls); list.append(controls);
    for (const [id, title] of OBJECTIVES) {
      const item = node('li'); item.dataset.objective = id;
      const button = node('button'), check = node('span', 'first-objectives-check', '○'), label = node('span', '', title);
      button.type = 'button'; check.setAttribute('aria-hidden', 'true'); button.setAttribute('aria-controls', 'first-objectives-hint');
      button.append(check, label); button.onclick = () => this.choose(id);
      item.append(button); list.append(item); this.rows.set(id, { item, button, check });
    }
    this.hintTitle = node('strong'); this.hint = node('p'); this.lines = node('ul', 'first-objectives-lines'); this.lines.hidden = true;
    this.help = node('div', 'first-objectives-help'); this.help.id = 'first-objectives-hint'; this.help.setAttribute('role', 'status');
    this.action = node('button', 'first-objectives-action'); this.action.type = 'button'; this.action.id = 'first-objectives-action';
    this.alternate = node('button', 'first-objectives-alternate'); this.alternate.type = 'button'; this.alternate.id = 'first-objectives-alternate';
    this.action.onclick = () => this.act(this.current?.action); this.alternate.onclick = () => this.act(this.current?.alternate);
    this.dismissal = node('button', 'first-objectives-dismiss', tr('Dispensar objetivos')); this.dismissal.type = 'button'; this.dismissal.id = 'first-objectives-dismiss';
    this.dismissal.onclick = () => this.dismiss();
    if (restore) restore.onclick = () => { this.dismissed = false; this.selected = 'controls'; onOpen(); this.disclose(true); };
    this.help.append(this.hintTitle, this.hint, this.lines, this.action, this.alternate); content.append(this.help, list, this.dismissal);
    this.root.append(heading, content); host.append(this.root);
    this.instruction = node('span', 'sr-only'); this.instruction.id = 'first-objectives-instruction'; host.append(this.instruction);
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); this.close.click(); }
    });
    this.dock = host.querySelector<HTMLElement>('#field-dock'); this.publicationDock = host.querySelector<HTMLElement>('.publication-dock'); this.chat = host.querySelector<HTMLElement>('#field-chat');
    if (typeof ResizeObserver === 'function') {
      this.resize = new ResizeObserver(() => this.fit()); this.resize.observe(host);
      if (this.dock) this.resize.observe(this.dock);
      if (this.chat) this.resize.observe(this.chat);
      if (this.publicationDock) this.resize.observe(this.publicationDock);
    }
  }
  fit() {
    if (this.root.hidden) return;
    // It ends over the orders at the foot, and over the conversation where that stands under it (chat-ux.ts).
    const bounds = this.host.getBoundingClientRect(), top = parseFloat(getComputedStyle(this.root).top), box = this.root.getBoundingClientRect(),
      chat = this.chat && !this.chat.hidden ? this.chat.getBoundingClientRect() : null,
      footer = Math.min(this.dock && !this.dock.hidden ? this.dock.getBoundingClientRect().top - bounds.top : bounds.height,
        chat && chat.width && chat.left < box.right && chat.right > box.left ? chat.top - bounds.top : bounds.height);
    this.root.style.setProperty('--objectives-space', Math.max(80, Math.min(bounds.height, footer) - top - 10) + 'px');
  }
  keep(value: 'open' | 'closed' | 'dismissed'): void {
    if (this.key) try { this.storage.setItem(this.key, value); } catch {}
  }
  disclose(open: boolean): void {
    this.open = open; this.keep(open ? 'open' : 'closed');
    this.paint();
  }
  choose(id: ObjectiveId | 'controls'): void {
    this.selected = id; this.paint(); this.help.scrollIntoView({ block: 'nearest' });
  }
  // A player who does not want the objectives puts them away, asked first: the panel and its button go.
  async dismiss() {
    if (!await this.ask(tr('Dispensar os objetivos?'), tr('O botão Objetivos sai da barra. Para rever os objetivos e os controles, use Objetivos e controles, na engrenagem.'), tr('Dispensar'))) return;
    this.dismissed = true; this.open = false; this.keep('dismissed');
    this.paint();
  }
  render({ active, playerId, touch = false, ...context }: FirstObjectivesRenderOptions = {}): void {
    const previous = this.model;
    this.model = active && playerId ? firstObjectives(context) : null; this.workspace = context.workspace || {}; this.touch = touch;
    if (!this.model) { this.toggle.hidden = true; if (this.restore) this.restore.hidden = true; this.root.hidden = true; this.clearTargets(); return; }
    const tools = this.workspace.placing ? this.placementTools : this.workspace.edit ? this.projectTools : this.tools;
    if (this.toggle.parentNode !== tools) tools.append(this.toggle);
    const key = objectivesPreferenceKey(this.model.fieldId, playerId);
    if (key !== this.key) {
      this.key = key; this.selected = null;
      let kept = null; try { kept = this.storage.getItem(key); } catch {}
      this.dismissed = kept === 'dismissed';
      this.open = kept === 'open' || kept === null && this.host.clientHeight >= 520 && this.model.count < this.model.total;
    }
    // A result advances the suggested help. The player can still revisit any
    // completed objective or choose another pending objective at any time.
    if (this.selected && previous?.rows.find(row => row.id === this.selected)?.complete === false &&
        this.model.rows.find(row => row.id === this.selected)?.complete) this.selected = null;
    this.paint();
  }
  async act(action: ObjectiveAction | null | undefined): Promise<void> {
    if (!action || this.pending) return;
    this.pending = true; this.action.disabled = this.alternate.disabled = true;
    try { await this.onAction(action); }
    finally { this.pending = false; this.action.disabled = this.alternate.disabled = false; this.follow({ scroll: true }); }
  }
  clearTargets(keep: ReadonlySet<HTMLElement> = new Set()): void {
    for (const target of this.targets) {
      if (keep.has(target)) continue;
      target.classList.remove('objective-target');
      const descriptions = (target.getAttribute('aria-describedby') || '').split(/\s+/).filter(id => id && id !== this.instruction.id);
      if (descriptions.length) target.setAttribute('aria-describedby', descriptions.join(' ')); else target.removeAttribute('aria-describedby');
    }
    this.targets = new Set([...this.targets].filter(target => keep.has(target)));
  }
  follow({ scroll = false } = {}) {
    if (!this.model || !this.open || !this.current?.action) { this.clearTargets(); return; }
    const resolved = this.resolveTarget(this.current.action), targets = Array.isArray(resolved) ? resolved : [resolved], wanted = new Set<HTMLElement>();
    for (const target of targets) {
      if (!target?.isConnected || 'disabled' in target && target.disabled || target.closest('[hidden], [inert]')) continue;
      if (scroll) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      const bounds = target.getBoundingClientRect();
      if (!bounds.width || !bounds.height || bounds.bottom <= 0 || bounds.right <= 0 || bounds.top >= innerHeight || bounds.left >= innerWidth ||
          typeof target.checkVisibility === 'function' && !target.checkVisibility()) continue;
      const x = Math.min(innerWidth - 1, Math.max(0, bounds.left + bounds.width / 2)), y = Math.min(innerHeight - 1, Math.max(0, bounds.top + bounds.height / 2)),
        above = target.ownerDocument.elementFromPoint(x, y);
      if (above && above !== target && !target.contains(above)) continue;
      wanted.add(target);
    }
    if (!wanted.size && !this.root.hidden && !this.action.hidden) wanted.add(this.action);
    this.clearTargets(wanted);
    for (const target of wanted) {
      if (!this.targets.has(target)) target.classList.add('objective-target');
      const descriptions = new Set((target.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean)); descriptions.add(this.instruction.id);
      attribute(target, 'aria-describedby', [...descriptions].join(' ')); this.targets.add(target);
    }
  }
  paint() {
    if (!this.model) return;
    this.toggle.hidden = this.dismissed; if (this.restore) this.restore.hidden = !this.dismissed;
    const { count, total, rows, next } = this.model, controls = this.selected === 'controls',
      current = rows.find(row => row.id === this.selected) || rows.find(row => row.id === next) || rows.at(-1);
    if (!current) throw new Error('Missing objective guidance');
    // The controls lead nowhere: nothing is pointed at while they are shown.
    this.current = controls ? null : current;
    const showing = this.open && !this.dismissed && !this.workspace.task && !this.workspace.libraryOpen && !this.workspace.placing,
      opening = this.root.hidden && showing;
    this.root.hidden = !showing;
    if (opening) this.fit();
    attribute(this.toggle, 'aria-expanded', String(showing));
    if (this.workspace.placing) attribute(this.toggle, 'aria-pressed', String(this.open)); else this.toggle.removeAttribute('aria-pressed');
    const toggleAction = this.workspace.placing ? this.open ? tr('Ocultar destaques da orientação') : tr('Mostrar destaques da orientação') : showing ? tr('Recolher') : tr('Abrir');
    attribute(this.toggle, 'aria-label', tr`Primeiros objetivos: ${count} de ${total} concluídos. ${toggleAction}.`);
    this.toggle.title = tr('Primeiros objetivos (opcionais)');
    write(this.toggleCount, `${count}/${total}`); write(this.count, tr`${count} de ${total}`);
    for (const row of rows) {
      const { item, button, check } = required(this.rows.get(row.id));
      item.dataset.complete = String(row.complete); write(check, row.complete ? '✓' : '○');
      attribute(button, 'aria-label', tr`${row.title}: ${row.complete ? tr('concluído') : tr('pendente')}. Ver orientação.`);
      attribute(button, 'aria-pressed', String(!controls && row.id === current.id));
    }
    attribute(this.controls, 'aria-pressed', String(controls));
    this.hint.hidden = controls; this.lines.hidden = !controls;
    if (controls) {
      const guide = controlsGuide({ edit: this.workspace.edit, touch: this.touch }), shown = guide.title + (this.touch ? ' · toque' : '');
      write(this.hintTitle, guide.title); write(this.instruction, '');
      if (this.lines.dataset.guide !== shown) { this.lines.dataset.guide = shown; this.lines.replaceChildren(...guide.lines.map(line => node('li', '', line))); }
      this.action.hidden = this.alternate.hidden = true;
    } else {
      write(this.hintTitle, count === total && !this.selected ? tr('Você concluiu os primeiros objetivos') : current.title);
      write(this.hint, count === total && !this.selected ? tr('Continue explorando e construindo. Você pode recolher esta lista e consultá-la quando quiser.') : current.hint);
      write(this.instruction, current.hint);
      this.action.hidden = !current.action; this.alternate.hidden = !current.alternate;
      if (current.action) write(this.action, current.action.label);
      if (current.alternate) write(this.alternate, current.alternate.label);
    }
    this.follow();
  }
}
