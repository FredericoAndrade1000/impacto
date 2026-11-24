import { BASIC_INDUSTRY, FACILITIES, INDUSTRY_UPGRADES, INDUSTRIAL_ENVELOPES, industrialAdmission, missingIndustry, nextUpgrade, upgradeById, upgradeShortages } from './industry.ts';
import { facilityName, industryRequirementMessage, levelLabel } from './industry-messages.ts';
import { compileDraft } from './structured-construction.ts';
import { tr, translate } from './i18n.ts';
import { count, number } from './format.ts';
import { node } from './dom-view.ts';
import { confirm } from './confirm-dialog.ts';
import { STOCKS, STOCK_IDS, billSum, billText } from './economy.ts';
import { INDUSTRY_EXAMPLES, industryExample, industryExampleSource } from './industry-examples.ts';
import { constructionSVG } from './construction-preview.ts';
import type { AuthoredConstruction, CompiledConstruction } from './construction-contract.ts';
import type { FactionView } from './field-contract.ts';
import type { FacilityId, IndustrialAdmission, UpgradeId } from './industry.ts';
import type { NetworkClient } from './network-client.ts';

const admissions = new WeakMap<CompiledConstruction, IndustrialAdmission>();
export function industryReasonFor(admission: IndustrialAdmission, faction: FactionView | null | undefined): string {
  return faction?.industry && (admission.oversized || missingIndustry(admission, faction.industry.levels).length)
    ? translate(industryRequirementMessage(admission, faction.industry.levels)) : '';
}
export function industryReason(source: AuthoredConstruction, faction: FactionView | null | undefined, compiled?: CompiledConstruction): string {
  if (!faction?.industry) return '';
  // Editor projections change with the physical document, including previews.
  // Mutable authoring itself is never used as a cache key.
  let admission = compiled && admissions.get(compiled);
  if (!admission) {
    // Invalid drafts already explain their Native admission in the workshop.
    try {
      const result = compiled ? { construction: source, compiled } : compileDraft(source);
      admission = industrialAdmission(result.construction, result.compiled);
    }
    catch { return ''; }
    if (compiled) admissions.set(compiled, admission);
  }
  return industryReasonFor(admission, faction);
}
export function industryPage(faction: FactionView | null | undefined, playerId: string | null | undefined, time = 0) {
  if (!faction?.industry) return null;
  const { levels, pending } = faction.industry, mayChoose = faction.members.some(member => member.id === playerId && member.role !== 'member');
  return { mayChoose, pending, cards: (Object.keys(FACILITIES) as FacilityId[]).map(facility => {
    const upgrade = nextUpgrade(levels, facility), active = pending && INDUSTRY_UPGRADES.find(item => item.id === pending.upgrade)?.facility === facility ? pending : null,
      lack = upgrade ? upgradeShortages(faction.stock, upgrade.cost).map(item => `${count(item.amount)}${item.id === 'combustivel' ? ' L' : ''} ${tr(STOCKS[item.id])}`).join(', ') : '',
      reason = !faction.base ? tr('Reconstrua a base para melhorar as instalações.') : !mayChoose ? tr('Só o líder e os administradores melhoram as instalações da base.') :
        active ? tr('Melhoria em andamento.') : pending ? tr('Conclua ou cancele a melhoria em andamento.') : lack ? tr`Faltam: ${lack}.` : '';
    return { facility, level: levels[facility], upgrade, active, remaining: active ? Math.max(0, Math.ceil(active.until - time)) : 0,
      progress: active ? Math.max(0, Math.min(1, (time - active.startedAt) / (active.until - active.startedAt))) : 0,
      reason, disabled: !upgrade || Boolean(reason) };
  }) };
}
export interface IndustryUIOptions {
  network: Pick<NetworkClient, 'faction' | 'playerId' | 'connected' | 'command'>;
  refresh(): void; tell(text: string, error?: boolean): void; getTime(): number;
  openExample(source: AuthoredConstruction, test: boolean): Promise<unknown>;
}
interface FacilityCard {
  card: HTMLElement; current: HTMLElement; capacity: HTMLElement; next: HTMLElement; description: HTMLElement;
  cost: HTMLElement; costLabel: HTMLElement; costs: Map<string, { row: HTMLElement; cost: HTMLElement; have: HTMLElement }>;
  status: HTMLElement; action: HTMLButtonElement; cancel: HTMLButtonElement; progress: HTMLProgressElement; time: HTMLElement;
  example: HTMLDetailsElement; exampleTitle: HTMLElement; exampleBody: HTMLElement; exampleId: UpgradeId | null;
  exampleTotal: HTMLElement | null;
}
const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
export class IndustryUI {
  readonly options: IndustryUIOptions;
  readonly cards = new Map<FacilityId, FacilityCard>();
  readonly summary: HTMLElement;
  pending = false;
  signature = '';
  constructor(host: HTMLElement, options: IndustryUIOptions) {
    this.options = options;
    const intro = node('header', 'industry-intro'); this.summary = node('p', 'industry-summary'); this.summary.setAttribute('role', 'status');
    intro.append(node('h2', '', tr('Melhorias da base')), node('p', 'helper', tr('Escolha o que sua facção poderá fabricar. Os benefícios valem para todos os membros.')), this.summary);
    const grid = node('div', 'industry-grid'); host.append(intro, grid);
    for (const facility of Object.keys(FACILITIES) as FacilityId[]) {
      const card = node('article', 'industry-card'), current = node('span', 'industry-level'), heading = node('header', 'industry-heading'),
        capacity = node('p', 'industry-capacity'), next = node('h4'), description = node('p', 'helper'), cost = node('section', 'industry-cost'),
        costs = new Map<string, { row: HTMLElement; cost: HTMLElement; have: HTMLElement }>(), status = node('p', 'industry-status'),
        action = node('button', 'card-primary'), cancel = node('button', '', tr('Cancelar melhoria')), progress = node('progress'), time = node('span', 'industry-time');
      heading.append(node('h3', '', tr(FACILITIES[facility])), current); card.append(heading, capacity, next, description);
      const costHeading = node('div', 'industry-resource'), costLabel = node('strong', '', tr('Custo'));
      costHeading.append(costLabel, node('small', '', tr('No estoque'))); cost.append(costHeading);
      for (const id of STOCK_IDS) {
        const row = node('div', 'industry-resource'), amount = node('span'), have = node('small');
        row.append(node('span', '', tr(STOCKS[id])), amount, have); cost.append(row); costs.set(id, { row, cost: amount, have });
      }
      progress.max = 1; progress.setAttribute('aria-label', tr('Progresso da melhoria'));
      status.id = `industry-status-${facility}`; action.setAttribute('aria-describedby', status.id);
      action.type = cancel.type = 'button';
      action.onclick = () => { const faction = options.network.faction; if (!faction) return; const upgrade = nextUpgrade(faction.industry.levels, facility); if (upgrade) void this.choose(upgrade.id); };
      cancel.onclick = () => void this.cancel();
      card.append(cost, progress, time, status, action, cancel);
      const future = node('details', 'industry-future'); future.append(node('summary', '', tr('Ver todos os níveis')));
      for (const upgrade of INDUSTRY_UPGRADES.filter(item => item.facility === facility)) future.append(node('strong', '', tr(upgrade.name)), node('p', 'helper', tr(upgrade.description)));
      const example = node('details', 'industry-example'), exampleTitle = node('summary'), exampleBody = node('div');
      example.append(exampleTitle, exampleBody);
      const record: FacilityCard = { card, current, capacity, next, description, cost, costLabel, costs, status, action, cancel, progress, time,
        example, exampleTitle, exampleBody, exampleId: null, exampleTotal: null };
      example.ontoggle = () => { if (example.open) this.renderExample(record); };
      card.append(example, future); grid.append(card); this.cards.set(facility, record);
    }
    const notes = node('details', 'industry-notes'); notes.append(node('summary', '', tr('Como funcionam as melhorias')),
      node('p', 'helper', tr('O nível atual continua funcionando durante a montagem. Cancelar devolve todo o custo e perde o progresso.')),
      node('p', 'helper', tr('A base já inclui mineração, logística, pavimentação e postos. Você pode continuar investindo na frota antes de melhorar instalações.')),
      node('p', 'helper', tr('As melhorias liberam projetos; não aumentam dano, resistência ou velocidade de refino. Perder a base remove suas ampliações.')),
      node('p', 'helper', tr('Projetos e testes na oficina continuam livres. Manutenção e abastecimento de veículos existentes não exigem melhorias.')));
    host.append(notes);
  }
  renderExample(record: FacilityCard): void {
    const id = record.exampleId, faction = this.options.network.faction;
    if (!id || !faction) return;
    const upgrade = upgradeById(id)!;
    if (!record.exampleBody.childElementCount) {
      try {
        const data = industryExample(id), { emptyKg, envelope } = data.admission.measurement,
          preview = node('div', 'industry-example-preview'), total = record.exampleTotal = node('p', 'helper'),
          actions = node('div', 'industry-example-actions');
        preview.innerHTML = constructionSVG(data.compiled);
        const needs = data.admission.requirements.filter(need => need.level > BASIC_INDUSTRY[need.facility])
          .map(need => translate(facilityName(need.facility, need.level))).join(', ');
        for (const test of [false, true]) {
          const action = node('button', '', test ? tr('Testar grátis') : tr('Abrir na oficina')); action.type = 'button';
          action.setAttribute('aria-label', test ? tr`Testar ${tr(INDUSTRY_EXAMPLES[id].name)}` : tr`Abrir ${tr(INDUSTRY_EXAMPLES[id].name)} na oficina`);
          action.onclick = async () => {
            action.disabled = true;
            try { await this.options.openExample(industryExampleSource(id), test); }
            catch (error) { this.options.tell(error instanceof Error ? error.message : String(error), true); }
            finally { action.disabled = false; }
          }; actions.append(action);
        }
        write(total, tr`Esta melhoria + 1 unidade: ${billText(billSum(upgrade.cost, data.cost))}.`);
        record.exampleBody.append(preview,
          node('p', 'helper', tr`${number(emptyKg / 1000)} t vazias · ${number(envelope.lengthM)} × ${number(envelope.heightM)} m`),
          node('p', 'helper', tr`Instalações para fabricar: ${needs}.`),
          node('p', 'helper', tr`Custo do projeto: ${billText(data.cost)}.`), total, actions,
          node('p', 'helper', tr('Abrir e testar não gasta recursos nem exige a melhoria.')),
          node('p', 'helper', tr('O custo do projeto inclui combustível e munição iniciais. Carga e manutenção são pagas à parte.')));
      } catch (error) { this.options.tell(error instanceof Error ? error.message : String(error), true); return; }
    }
    if (record.exampleTotal) record.exampleTotal.hidden = faction.industry.levels[upgrade.facility] >= upgrade.level;
  }
  async choose(id: UpgradeId): Promise<void> {
    const { network, tell, refresh, getTime } = this.options, factionId = network.faction?.id,
      choice = industryPage(network.faction, network.playerId, getTime())?.cards.find(card => card.upgrade?.id === id);
    if (this.pending || !network.connected || !choice?.upgrade || choice.disabled) return;
    const upgrade = choice.upgrade;
    this.pending = true; this.render();
    try {
      if (!await confirm(tr`Construir ${tr(upgrade.name)}?`, tr`${billText(upgrade.cost)} serão pagos pelo estoque da facção. Montagem: ${upgrade.seconds} s. Você pode cancelar e recuperar o custo.`, tr('Iniciar melhoria'))) return;
      if (network.faction?.id !== factionId || !network.connected || industryPage(network.faction, network.playerId, getTime())?.cards.find(card => card.upgrade?.id === id)?.disabled !== false) return;
      await network.command('upgrade', { id }); tell(tr`Melhoria iniciada: ${tr(upgrade.name)}.`);
    } catch (error) { tell(error instanceof Error ? error.message : String(error), true); }
    finally { this.pending = false; refresh(); this.render(); }
  }
  async cancel(): Promise<void> {
    const { network, tell, refresh } = this.options, pending = network.faction?.industry.pending, factionId = network.faction?.id;
    if (this.pending || !pending || !network.connected || !industryPage(network.faction, network.playerId)?.mayChoose) return;
    this.pending = true; this.render();
    try {
      if (!await confirm(tr('Cancelar melhoria?'), tr`${billText(pending.cost)} voltam ao estoque da facção. O progresso da montagem será perdido.`, tr('Cancelar melhoria'))) return;
      if (network.faction?.id !== factionId || network.faction?.industry.pending?.id !== pending.id || !network.connected) return;
      const result = await network.command('cancel-upgrade', { id: pending.id });
      tell(result.already ? tr('Esta melhoria já terminou ou foi cancelada.') : tr('Melhoria cancelada. Custo devolvido ao estoque da facção.'));
    } catch (error) { tell(error instanceof Error ? error.message : String(error), true); }
    finally { this.pending = false; refresh(); this.render(); }
  }
  render(): void {
    const { network, getTime } = this.options, faction = network.faction, page = industryPage(faction, network.playerId, getTime());
    if (!faction || !page) return;
    const signature = JSON.stringify([faction.id, faction.industry, faction.stock, Boolean(faction.base), page.mayChoose, this.pending, network.connected, Math.floor(getTime())]);
    if (signature === this.signature) return; this.signature = signature;
    write(this.summary, !network.connected ? tr('Aguarde a conexão com o campo.') : !faction.base ? tr('Reconstrua a base para melhorar as instalações.') :
      !page.mayChoose ? tr('Só o líder e os administradores melhoram as instalações da base.') : page.pending ? tr('Uma melhoria em montagem. As outras instalações continuam disponíveis.') : tr('Use os recursos da facção para iniciar uma melhoria.'));
    for (const item of page.cards) {
      const record = this.cards.get(item.facility)!;
      write(record.current, item.level ? tr`Nível ${levelLabel(item.level)}` : tr('Não construído'));
      const limit = item.facility === 'processing' ? null : INDUSTRIAL_ENVELOPES[item.facility][item.level];
      write(record.capacity, limit ? tr`Porte atual: ${number(limit.kg / 1000)} t · ${number(limit.length)} × ${number(limit.height)} m` :
        item.facility === 'hangar' ? tr('Construa para fabricar aeronaves.') : item.level === 1 ? tr('Aço, concreto e vidro.') : item.level === 2 ? tr('Básicos + alumínio, aço de alta dureza e plástico.') : tr('Todos os materiais compatíveis.'));
      const upgrade = item.upgrade;
      const exampleId = (upgrade ?? INDUSTRY_UPGRADES.filter(upgrade => upgrade.facility === item.facility).at(-1)!).id;
      if (record.exampleId !== exampleId) {
        record.exampleId = exampleId; record.exampleBody.replaceChildren(); record.exampleTotal = null;
        write(record.exampleTitle, tr`Exemplo: ${tr(INDUSTRY_EXAMPLES[exampleId].name)}`);
      }
      if (record.example.open) this.renderExample(record);
      write(record.next, upgrade ? tr`Próximo: ${tr(upgrade.name)}` : tr('Instalação completa'));
      write(record.description, upgrade ? tr(upgrade.description) : tr('Todos os níveis desta instalação estão disponíveis.'));
      record.cost.hidden = !upgrade;
      write(record.costLabel, item.active ? tr('Custo pago') : tr('Custo'));
      if (upgrade) for (const id of STOCK_IDS) {
        const row = record.costs.get(id)!; write(row.cost, count(upgrade.cost[id]) + (id === 'combustivel' ? ' L' : ''));
        write(row.have, count(faction.stock[id]) + (id === 'combustivel' ? ' L' : '')); row.row.classList.toggle('short', !item.active && faction.stock[id] < upgrade.cost[id]);
      }
      record.progress.hidden = record.time.hidden = !item.active; record.progress.value = item.progress;
      write(record.time, item.active ? item.remaining ? tr`Pronta em ${item.remaining} s` : tr('Concluindo…') : upgrade ? tr`Montagem: ${upgrade.seconds} s` : '');
      record.time.hidden = !item.active && !upgrade;
      const status = !network.connected ? tr('Aguarde a conexão com o campo.') : item.reason;
      write(record.status, status); record.status.hidden = !status;
      write(record.action, item.active ? tr('Em montagem') : upgrade ? item.level ? tr`Melhorar para ${levelLabel(upgrade.level)}` : tr`Construir ${tr(upgrade.name)}` : tr('Concluída'));
      record.action.disabled = this.pending || !network.connected || item.disabled;
      record.action.setAttribute('aria-label', item.active && upgrade ? tr`Em montagem: ${tr(upgrade.name)}` : upgrade ? tr`Construir ${tr(upgrade.name)}` : translate(facilityName(item.facility, item.level)));
      record.cancel.hidden = !item.active; record.cancel.disabled = this.pending || !network.connected || !page.mayChoose;
      record.card.classList.toggle('building', Boolean(item.active));
    }
  }
}
