import type { CommandData } from './field-protocol-contract.ts';
import type { FactionView } from './faction-ui.ts';
import type { StockId, SupplyBill } from './economy-contract.ts';
import type { FlagChoice } from './flag.ts';
import type { NetworkClient } from './network-client.ts';
type TradeView = FactionView['trades'][number];
type AccordView = FactionView['accords'][number];
export type SocialPart = { name: string; text?: never; stock?: never } | { name?: never; text: string; stock?: StockId };
export type AccordState = 'asked' | 'sent' | 'kept' | 'public';
export interface FactionSocialOptions {
  readonly trade: HTMLElement; readonly diplomacy: HTMLElement;
  readonly network: Pick<NetworkClient, 'enabled' | 'connected' | 'faction' | 'playerId' | 'command'>;
  readonly refresh: () => void; readonly tell: (text: string, error?: boolean) => void;
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing faction social control'); return value; };
const errorText = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
import { tr } from './i18n.ts';
import { node, icon } from './dom-view.ts';
import { confirm } from './confirm-dialog.ts';
import { STOCKS, STOCK_IDS, stocked } from './economy.ts';
import { count } from './format.ts';
import { factionName, factionSaid } from './faction-ui.ts';
import { flagMarkup } from './flag.ts';
import { compactStock } from './field-navigation.ts';
import { SOCIAL_LIMITS, socialText, tradeBill } from './faction-social.ts';

// What an alliance does, in a line, and whole for whoever wants to know more. Recorded terms are replay data
// (faction-social.ts): the page says the current rules without rewriting those records.
export const ALLIANCE_LINE = tr('Compartilha visão e radar; aliados não se ferem.');
export const ALLIANCE_DESCRIPTION = tr('Vocês veem o que o outro vê: visão, radar, sons ouvidos e o terreno já descoberto, também para a mira e os pilotos. ')
  + tr('Os pilotos não atacam aliados, e os tiros de um não ferem o outro; a blindagem do aliado ainda segura o seu tiro, e o seu próprio veículo pode ser atingido. ')
  + tr('Estoques, projetos e veículos continuam separados. Encerrar corta o compartilhamento e a proteção; o terreno descoberto fica.');
const DECLARATION_LINE = tr('Uma promessa por escrito, que fica pública quando aceita.');

// An amount of a stock in words — "500 Ferro", "200 L de Combustível" —, and the stocks a bill has, in order.
const amountText = (id: StockId, value: number): string => id === 'combustivel' ? `${count(value)} L de ${tr(STOCKS[id])}` : `${count(value)} ${tr(STOCKS[id])}`;
const amounts = (bill: SupplyBill) => STOCK_IDS.filter(id => bill[id] > 0).map(id => ({ id, text: amountText(id, bill[id]) }));
const listed = (items: readonly { text: string }[]): string => items.length < 2 ? items.map(item => item.text).join('') : `${items.slice(0, -1).map(item => item.text).join(', ')} e ${required(items.at(-1)).text}`;
export const tradeAmountsText = (bill: SupplyBill): string => listed(amounts(bill));
// An offer of trade in one line, as the parts it is said with: words, the name of a faction (`name`) and amounts of stocks
// (`stock`). One made to the player's faction says what the other offers and for what; one of its own, what it offers to whom.
export function offerParts(offer: TradeView, ref: string | null | undefined): SocialPart[] {
  const own = offer.from.ref === ref, give = amounts(offer.give), want = amounts(offer.want), parts: SocialPart[] = [];
  const put = (list: readonly { id: StockId; text: string }[], ...more: SocialPart[]): void => { list.forEach((item, i) => { if (i) parts.push({ text: i === list.length - 1 ? tr(' e ') : ', ' }); parts.push({ stock: item.id, text: item.text }); }); parts.push(...more); };
  if (own) {
    const to = { name: factionSaid(offer.to) };
    if (give.length) { parts.push({ text: tr('Você oferece ') }); put(give, { text: tr(' à ') }, to); if (want.length) { parts.push({ text: ' por ' }); put(want); } }
    else { parts.push({ text: tr('Você pede ') }); put(want, { text: tr(' à ') }, to); }
  } else {
    parts.push({ name: factionName(offer.from) });
    if (give.length) { parts.push({ text: ' oferece ' }); put(give); if (want.length) { parts.push({ text: ' por ' }); put(want); } }
    else { parts.push({ text: ' pede ' }); put(want); }
  }
  if (!give.length || !want.length) parts.push({ text: tr(', sem nada em troca') });
  return parts;
}
// An accord in one line, as the same parts, with how it stands (`state`): proposed to the player's faction, proposed by it,
// in force for it, or between two others, which the field makes public once it is accepted.
export function accordParts(accord: AccordView, ref: string | null | undefined): { state: AccordState; parts: SocialPart[] } {
  const alliance = accord.kind === 'alliance', pending = accord.acceptedAt === null, what = alliance ? tr('uma aliança') : tr('um compromisso');
  if (accord.to.ref === ref && pending) return { state: 'asked', parts: [{ name: factionName(accord.from) }, { text: tr` propõe ${what}` }] };
  if (accord.from.ref === ref && pending) return { state: 'sent', parts: [{ text: tr`Você propôs ${what} à ` }, { name: factionSaid(accord.to) }] };
  const other = accord.from.ref === ref ? accord.to : accord.to.ref === ref ? accord.from : null, kind = alliance ? tr('Aliança') : tr('Compromisso');
  return other ? { state: 'kept', parts: [{ text: `${kind} com a ` }, { name: factionSaid(other) }] } :
    { state: 'public', parts: [{ name: factionName(accord.from) }, { text: tr(' e ') }, { name: factionName(accord.to) }, { text: ': ' + kind.toLowerCase() }] };
}
export const partsText = (parts: readonly SocialPart[]): string => parts.map(part => part.text ?? part.name).join('');

const write = (element: HTMLElement, text: string): void => { if (element.textContent !== text) element.textContent = text; };
const button = (text: string, className = ''): HTMLButtonElement => { const b = node('button', className, text); b.type = 'button'; return b; };
const labelled = (text: string, input: HTMLElement, className = ''): HTMLLabelElement => { const label = node('label', className, text); label.append(input); return label; };
const heading = (text: string, count?: HTMLElement): HTMLHeadingElement => { const h = node('h3', 'social-heading', text); if (count) h.append(count); return h; };
// A line said by its parts: the names of factions in bold, each amount after the mark of its stock.
function spell(line: HTMLElement, parts: readonly SocialPart[]): void {
  line.replaceChildren(...parts.map(part => {
    if (part.name) return node('strong', '', part.name);
    if (!part.stock) return node('span', '', part.text);
    const amount = node('span', 'trade-amount'), mark = node('span', 'trade-mark'); mark.innerHTML = icon('r-' + part.stock, 'stock-icon');
    amount.append(mark, node('span', '', part.text)); return amount;
  }));
}

// The tabs of trade and of diplomacy of the window of the faction (faction-dialog.ts): the offers and the accords there are,
// each in a line with what the player may do of it, and under them the forms that propose another, for the leader and the
// administrators. Only drafts and DOM nodes live here; the room owns every record. `tell` says what came of a request.
export function initFactionSocial({ trade, diplomacy, network, refresh, tell }: FactionSocialOptions) {
  // Trade: the offers there are, then what the player gives and what they want, a box for each stock with its mark.
  const offerCount = node('output'), offerList = node('div', 'social-records'), offerEmpty = node('p', 'helper', tr('Nenhuma oferta no momento.')),
    tradeForm = node('form', 'social-form'), tradeTarget = node('select'), give: Partial<Record<StockId, HTMLInputElement>> = {}, want: Partial<Record<StockId, HTMLInputElement>> = {}, has: Partial<Record<StockId, HTMLElement>> = {},
    offer = button(tr('Enviar oferta'), 'card-primary'), tradeOnly = node('p', 'helper social-only', tr('Só o líder e os administradores propõem e aceitam trocas.'));
  tradeForm.id = 'trade-form'; tradeTarget.id = 'trade-target'; tradeTarget.required = true; offer.type = 'submit'; offer.id = 'trade-send';
  offer.title = tr('A troca acontece quando a outra facção aceitar.');
  const side = (kind: 'give' | 'want', words: string, inputs: Partial<Record<StockId, HTMLInputElement>>): HTMLElement => {
    const group = node('div', 'trade-side'), name = node('span', 'trade-side-name', words), cells = node('div', 'trade-cells');
    name.id = `trade-${kind}-title`; group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', name.id);
    for (const id of STOCK_IDS) {
      const cell = node('label', 'trade-cell'), mark = node('span', 'trade-mark'), input = node('input');
      mark.innerHTML = icon('r-' + id, 'stock-icon'); cell.title = tr(STOCKS[id]);
      input.type = 'number'; input.min = '0'; input.step = '1'; input.max = String(Number.MAX_SAFE_INTEGER); input.inputMode = 'numeric'; input.placeholder = '0';
      input.id = `trade-${kind}-${id}`; input.setAttribute('aria-label', `${words}: ${tr(STOCKS[id])}`); inputs[id] = input; cell.append(mark, input);
      if (kind === 'give') { has[id] = node('small', 'trade-has'); required(has[id]).id = 'trade-has-' + id; cell.append(required(has[id])); }
      cells.append(cell);
    }
    group.append(name, cells); return group;
  };
  tradeForm.append(heading(tr('Propor troca')), labelled(tr('Para'), tradeTarget, 'social-target'), side('give', tr('Você entrega'), give), side('want', tr('Você recebe'), want), offer);
  trade.append(heading('Ofertas ', offerCount), offerList, offerEmpty, tradeForm, tradeOnly);

  // Diplomacy: the accords there are, then the kind of the next — a commitment or an alliance —, whom it is made with and, for a
  // commitment, its words.
  const accordCount = node('output'), accordList = node('div', 'social-records'), accordEmpty = node('p', 'helper', tr('Nenhum acordo ainda.')),
    accordForm = node('form', 'social-form'), kinds = node('div', 'accord-kinds'), kindLine = node('p', 'helper accord-line'),
    more = node('details', 'alliance-more'), accordTarget = node('select'), terms = node('textarea'),
    propose = button('', 'card-primary'), accordOnly = node('p', 'helper social-only', tr('Só o líder e os administradores fazem acordos.'));
  accordForm.id = 'accord-form'; accordTarget.id = 'accord-target'; accordTarget.required = true; propose.type = 'submit'; propose.id = 'accord-send';
  kinds.setAttribute('role', 'group'); kinds.setAttribute('aria-label', tr('Tipo de acordo')); more.id = 'alliance-terms';
  more.append(node('summary', '', tr('Saiba mais')), node('p', '', ALLIANCE_DESCRIPTION));
  const kindButtons = Object.fromEntries(([['declaration', tr('Compromisso')], ['alliance', tr('Aliança')]] satisfies [string, string][]).map(([id, words]) => {
    const b = button(words); b.dataset.kind = id; b.setAttribute('aria-pressed', String(id === 'declaration')); kinds.append(b); return [id, b];
  }));
  terms.id = 'accord-text'; terms.rows = 3; terms.maxLength = SOCIAL_LIMITS.text; terms.required = true; terms.placeholder = tr('Ex.: não atacar a base um do outro.');
  const termLabel = labelled('O compromisso', terms, 'accord-terms');
  accordForm.append(heading(tr('Propor acordo')), kinds, kindLine, more, labelled(tr('Com'), accordTarget, 'social-target'), termLabel, propose);
  diplomacy.append(heading('Acordos ', accordCount), accordList, accordEmpty, accordForm, accordOnly);

  const tradeRows = new Map<string, ReturnType<typeof recordRow>>(), accordRows = new Map<string, ReturnType<typeof recordRow>>();
  let ownRef: string | null | undefined = null, busy = false, optionsKey = '', kind = 'declaration';
  const clearDrafts = () => {
    for (const input of [...Object.values(give), ...Object.values(want), terms]) input.value = '';
    tradeTarget.value = accordTarget.value = ''; kind = 'declaration';
  };
  // One request for the faction: asked first when it takes something away, and told when it is done — unless the faction is
  // another by then, when what it gave is no longer the player's to hear of.
  async function request<Kind extends 'trade' | 'accord'>(type: Kind, data: CommandData[Kind], said: string, question?: [string, string, string] | null, done?: () => void): Promise<void> {
    if (busy || !network.connected) return;
    const ref = network.faction?.ref; busy = true; render();
    try {
      if (question && !await confirm(...question)) return;
      if (network.faction?.ref !== ref) throw new Error(tr('Sua facção mudou. Confira antes de continuar.'));
      await network.command(type, data);
      if (network.faction?.ref === ref) { tell(said); done?.(); }
    } catch (error) { if (network.faction?.ref === ref) tell(errorText(error), true); }
    finally { busy = false; render(); refresh(); }
  }
  tradeForm.onsubmit = event => {
    event.preventDefault();
    try {
      const read = (controls: Partial<Record<StockId, HTMLInputElement>>): SupplyBill => tradeBill(Object.fromEntries(STOCK_IDS.map(id => [id, Number(required(controls[id]).value || 0)]))),
        drafts = [...Object.values(give), ...Object.values(want)].map(input => input.value),
        other = network.faction?.ranking.find(f => f.ref === tradeTarget.value);
      request('trade', { act: 'offer', ref: tradeTarget.value, give: read(give), want: read(want) }, other ? tr`Oferta enviada à ${factionSaid(other)}.` : tr('Oferta enviada.'), null, () => {
        const inputs = [...Object.values(give), ...Object.values(want)];
        if (inputs.every((input, i) => input.value === drafts[i])) for (const input of inputs) input.value = '';
      });
    } catch (error) { tell(errorText(error), true); }
  };
  for (const input of Object.values(give)) input.oninput = () => render();
  for (const [id, b] of Object.entries(kindButtons)) b.onclick = () => { kind = id; render(); };
  accordForm.onsubmit = event => {
    event.preventDefault();
    try {
      const draft = terms.value, alliance = kind === 'alliance';
      request('accord', { act: 'propose', ref: accordTarget.value, ...(alliance ? { kind: 'alliance' } : { text: socialText(draft) }) }, tr('Proposta enviada.'), null,
        () => { if (!alliance && terms.value === draft) terms.value = ''; });
    } catch (error) { tell(errorText(error), true); }
  };
  // The rows of a list are made once for each record, and kept in place while the record is there: a button made again under
  // the pointer would lose the click.
  function rows<Record extends { id: string }, Row extends { element: HTMLElement }>(container: HTMLElement, held: Map<string, Row>, records: readonly Record[], make: (id: string) => Row, update: (row: Row, record: Record) => void): void {
    const present = new Set(records.map(record => record.id));
    for (const [id, row] of held) if (!present.has(id)) { row.element.remove(); held.delete(id); }
    records.forEach((record, index) => {
      let row = held.get(record.id); if (!row) { row = make(record.id); held.set(record.id, row); }
      if (container.children[index] !== row.element) container.insertBefore(row.element, container.children[index] || null);
      update(row, record);
    });
  }
  const recordRow = (id: string) => {
    const element = node('article', 'social-record'), flag = node('span', 'row-flag'), body = node('div', 'social-body'), line = node('p', 'social-line'),
      detail = node('small'), text = node('p', 'social-terms'), actions = node('div', 'social-actions'),
      accept = button(tr('Aceitar'), 'card-primary'), end = button(tr('Recusar'));
    element.dataset.id = id; actions.append(accept, end); body.append(line, detail, text); element.append(flag, body, actions);
    return { element, flag, line, detail, text, actions, accept, end, said: '', flown: '' };
  };
  // A row says its line again only when the line is another.
  const sayRow = (row: ReturnType<typeof recordRow>, parts: readonly SocialPart[], flag: FlagChoice | null | undefined): void => {
    const said = JSON.stringify(parts), flown = JSON.stringify(flag);
    if (row.said !== said) { row.said = said; spell(row.line, parts); }
    if (row.flown !== flown) { row.flown = flown; row.flag.innerHTML = flag ? flagMarkup(flag) : ''; }
  };
  function render() {
    const faction = network.enabled ? network.faction : null, ref = faction?.ref,
      manager = Boolean(faction?.members.some(m => m.id === network.playerId && ['leader', 'admin'].includes(m.role))), ready = manager && network.connected && !busy;
    if (ref !== ownRef) { ownRef = ref; clearDrafts(); optionsKey = ''; }
    tradeForm.hidden = accordForm.hidden = !manager; tradeOnly.hidden = accordOnly.hidden = manager || !faction;
    const alliance = kind === 'alliance';
    for (const [id, b] of Object.entries(kindButtons)) { b.setAttribute('aria-pressed', String(id === kind)); b.disabled = !ready; }
    write(kindLine, alliance ? ALLIANCE_LINE : DECLARATION_LINE); more.hidden = !alliance;
    termLabel.hidden = alliance; terms.required = !alliance;
    write(propose, alliance ? tr('Propor aliança') : tr('Propor compromisso'));
    offer.disabled = propose.disabled = !ready;
    // What the faction has of each stock, beside what it gives: more than it has is marked.
    for (const id of STOCK_IDS) {
      const held = stocked(faction?.stock?.[id] ?? 0), over = Number(required(give[id]).value || 0) > held;
      const litres = id === 'combustivel' ? ' L' : '', whole = tr`A facção tem ${count(held)}${litres} de ${tr(STOCKS[id])}`;
      write(required(has[id]), 'tem ' + compactStock(held) + litres); if (required(has[id]).title !== whole) required(has[id]).title = whole;
      if (required(give[id]).getAttribute('aria-invalid') !== String(over)) required(give[id]).setAttribute('aria-invalid', String(over));
    }
    const choices = (faction?.ranking || []).filter(f => f.ref !== ref), key = choices.map(f => f.ref + ':' + factionName(f)).join('|');
    if (key !== optionsKey) {
      optionsKey = key;
      for (const select of [tradeTarget, accordTarget]) {
        const value = select.value, placeholder = node('option', '', choices.length ? tr('Escolha a facção') : tr('Nenhuma outra facção no campo')); placeholder.value = ''; placeholder.disabled = true;
        select.replaceChildren(placeholder, ...choices.map(f => { const option = node('option', '', factionName(f)); option.value = f.ref; return option; }));
        select.value = choices.some(f => f.ref === value) ? value : '';
      }
    }
    // Offers made to the faction first, then its own.
    const offers = [...(faction?.trades || [])].sort((a, b) => (a.to.ref === ref ? 0 : 1) - (b.to.ref === ref ? 0 : 1)),
      agreements = [...(faction?.accords || [])].sort((a, b) => order(a, ref) - order(b, ref));
    write(offerCount, offers.length ? String(offers.length) : ''); offerEmpty.hidden = Boolean(offers.length);
    write(accordCount, agreements.length ? String(agreements.length) : ''); accordEmpty.hidden = Boolean(agreements.length);
    rows(offerList, tradeRows, offers, id => {
      const row = recordRow(id);
      row.accept.onclick = () => {
        const deal = network.faction?.trades.find(t => t.id === id); if (!deal) return;
        const given = tradeAmountsText(deal.want), taken = tradeAmountsText(deal.give);
        request('trade', { act: 'accept', id }, tr`Troca feita${given ? tr(': você entregou ') + given : ''}${taken ? (given ? ' e recebeu ' : tr(': você recebeu ')) + taken : ''}.`,
          ['Aceitar a troca?', [given && tr`Vocês entregam ${given}`, taken && `${given ? 'recebem' : tr('Vocês recebem')} ${taken}`].filter(Boolean).join(tr(' e ')) + tr('. A troca é imediata.'), tr('Aceitar troca')]);
      };
      row.end.onclick = () => {
        const currentFaction = network.faction, deal = currentFaction?.trades.find(t => t.id === id); if (!currentFaction || !deal) return;
        request('trade', { act: 'cancel', id }, deal.to.ref === currentFaction.ref ? tr('Oferta recusada.') : tr('Oferta cancelada.'));
      };
      return row;
    }, (row, deal) => {
      const asked = deal.to.ref === ref;
      sayRow(row, offerParts(deal, ref), (asked ? deal.from : deal.to).flag);
      write(row.detail, asked ? '' : tr('aguardando resposta')); row.detail.hidden = asked; row.text.hidden = true;
      row.element.classList.toggle('asked', asked);
      row.accept.hidden = !manager || !asked; row.end.hidden = !manager; write(row.end, asked ? tr('Recusar') : tr('Cancelar'));
      row.actions.hidden = !manager; row.accept.disabled = row.end.disabled = !ready;
    });
    rows(accordList, accordRows, agreements, id => {
      const row = recordRow(id);
      row.accept.onclick = () => {
        const agreement = network.faction?.accords.find(a => a.id === id); if (!agreement) return;
        const allied = agreement.kind === 'alliance';
        request('accord', { act: 'accept', id, ...(allied ? { kind: 'alliance' } : {}) }, allied ? tr('Aliança feita: vocês já compartilham visão e radar.') : tr('Compromisso aceito.'),
          allied ? [tr('Aceitar a aliança?'), tr('Vocês passam a compartilhar visão e radar, e os tiros de um não ferem o outro. Estoques e veículos continuam separados.'), tr('Aceitar aliança')] :
            ['Aceitar o compromisso?', agreement.text, tr('Aceitar compromisso')]);
      };
      row.end.onclick = () => {
        const currentFaction = network.faction, agreement = currentFaction?.accords.find(a => a.id === id); if (!currentFaction || !agreement) return;
        const allied = agreement.kind === 'alliance', pending = agreement.acceptedAt === null;
        request('accord', { act: 'end', id }, pending ? agreement.to.ref === currentFaction.ref ? tr('Proposta recusada.') : tr('Proposta cancelada.') : allied ? tr('Aliança encerrada.') : tr('Compromisso encerrado.'),
          pending ? null : allied ? [tr('Encerrar a aliança?'), tr('A visão e o radar deixam de ser compartilhados, e os tiros voltam a ferir. O terreno já descoberto continua.'), tr('Encerrar aliança')] :
            ['Encerrar o compromisso?', agreement.text, tr('Encerrar compromisso')]);
      };
      return row;
    }, (row, agreement) => {
      const { state, parts } = accordParts(agreement, ref), allied = agreement.kind === 'alliance', involved = state !== 'public',
        other = agreement.from.ref === ref ? agreement.to : agreement.from;
      sayRow(row, parts, involved ? other.flag : null);
      write(row.detail, state === 'sent' ? tr('aguardando resposta') : state === 'kept' && allied ? tr('visão e radar compartilhados') : '');
      row.detail.hidden = !row.detail.textContent;
      write(row.text, allied ? '' : agreement.text); row.text.hidden = allied;
      row.element.classList.toggle('asked', state === 'asked');
      row.accept.hidden = !manager || state !== 'asked'; row.end.hidden = !manager || !involved; row.actions.hidden = !manager || !involved;
      write(row.end, state === 'asked' ? tr('Recusar') : state === 'sent' ? tr('Cancelar') : tr('Encerrar'));
      row.accept.disabled = row.end.disabled = !ready;
    });
  }
  render(); return { render };
}
// Accords in the order the player reads them: those that wait for the player's answer, those in force, those the player sent,
// and those between other factions.
const order = (accord: AccordView, ref: string | null | undefined): number => {
  const { state } = accordParts(accord, ref);
  return { asked: 0, kept: 1, sent: 2, public: 3 }[state];
};
