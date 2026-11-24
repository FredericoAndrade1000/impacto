import type { CommandKind, CommandData, CommandResult } from './field-protocol-contract.ts';
import type { NetworkClient } from './network-client.ts';
import type { FactionView } from './faction-ui.ts';
import type { FieldPanelView } from './field-panel.ts';
import type { TowUIOptions } from './tow-ui.ts';
import type { FlagChoice } from './flag.ts';
import type { MemberAction } from './faction-page.ts';
import type { factionPage } from './faction-page.ts';
type FactionPageView = NonNullable<ReturnType<typeof factionPage>>;
export interface FactionUXOptions {
  readonly network: Pick<NetworkClient, 'enabled' | 'connected' | 'faction' | 'name' | 'playerId' | 'token' | 'command' | 'rename' | 'rekey' | 'socket'>;
  readonly renderer: TowUIOptions['renderer'] & { readonly canvas: HTMLCanvasElement };
  readonly toast: (text: string, error?: boolean) => void; readonly refresh: () => void; readonly stopControls: () => void;
  readonly remember: (result: CommandResult) => unknown; readonly serviced: () => string | null; readonly leaving: (actorId: string) => unknown;
  readonly showPlace: (x: number) => unknown;
  readonly openExample: import('./industry-ui.ts').IndustryUIOptions['openExample'];
}
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing faction control'); return value; };
const isHtml = (element: Element): element is HTMLElement => 'dataset' in element;
const html = (value: Element | null | undefined): HTMLElement => { const element = required(value); if (!isHtml(element)) throw new Error('Missing faction HTML control'); return element; };
const errorText = (error: unknown): string => error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error);
const isElement = (value: EventTarget | null): value is Element => value !== null && 'closest' in value;
const isMemberAction = (act: string): act is MemberAction => Object.hasOwn(MEMBER_ACTIONS, act);
import { tr } from './i18n.ts';
import { node, icon } from './dom-view.ts';
import { confirm } from './confirm-dialog.ts';
import { billText } from './economy.ts';
import { cancelledText, dumpedText, returnedText, dismantleQuestion, dismantledNews, arrivals, joinWarning, factionSaid } from './faction-ui.ts';
import { flagMarkup } from './flag.ts';
import { IdentityUI } from './identity-ui.ts';
import { MEMBER_ACTIONS, memberQuestion, leaveWarning, factionNews } from './faction-page.ts';
import { keyText } from './network-protocol.ts';
import { initFactionSocial } from './faction-social-ux.ts';
import { FactionDialog } from './faction-dialog.ts';
import { TowUI } from './tow-ui.ts';
import { IndustryUI } from './industry-ui.ts';

// The faction on the shared field: the work asked for on one construction, at the base, beside a supply vehicle or wherever it stands;
// the window of the faction (faction-dialog.ts) — on its first tab the nations of the field by their wealth, asking to join one, its
// members and what the player may do of each, who asks to join it, who invited the player and whom it may invite, the key of the
// player's seat and leaving it; on the others its trade and its diplomacy (faction-social-ux.ts) —, and the name and the flag the
// faction gives itself (identity-ui.ts). What each list has is what `fieldPanel` says of the situation; all this keeps is which
// invitations and requests the player was already told of, and the request the player has out (`asking`).
// `serviced` names the construction the base works on. What is done to the constructions picked from Mais ações (squad-ux.ts)
// — dismantling them and abandoning one — is asked here.
export function initFactionUX({ network, renderer, toast, refresh, stopControls, remember, serviced, leaving, showPlace, openExample }: FactionUXOptions) {
  const $ = (id: string): HTMLElement => required(document.getElementById(id)),
    invites = $('invite-list'), ranking = $('ranking-list'), members = $('member-list'), invitable = $('invitable-list'), requests = $('request-list'),
    known = new Set<string>(), asked = new Set<string>(), keys = new Map<HTMLElement, string>();
  let asking: FactionView['request'] = null, headFlag = '';
  const put = (element: Element | null | undefined, value: string): void => { if (required(element).textContent !== value) required(element).textContent = value; };
  const button = (act: string, text: string, className = ''): HTMLButtonElement => { const b = node('button', className, text); b.type = 'button'; b.dataset.act = act; return b; };
  // The keyboard goes back to the field: Space must not press the same button again.
  const back = () => renderer.canvas.focus({ preventScroll: true });
  // The window of the faction, opened by its button over the field; what is done in it is told in it, over the notices of the field.
  const page = document.getElementById('faction-dialog') && new FactionDialog({ back, opened: () => { stopControls(); refresh(); }, closed: refresh }),
    tell = (text: string, error = false) => page?.isOpen ? page.say(text, error) : error ? toast(text, true) : toast(text),
    social = page && initFactionSocial({ trade: $('faction-panel-trade'), diplomacy: $('faction-panel-diplomacy'), network, refresh, tell });
  const industry = page && new IndustryUI($('faction-panel-industry'), { network, refresh, tell, getTime: () => renderer.state?.time ?? 0,
    openExample: async (source, test) => { page.close(); await openExample(source, test); } });
  const identity = new IdentityUI({ getFaction: () => network.faction, getName: () => network.name, stopControls, onRename: name => network.rename(name),
    onSave: async (data, renamed) => {
      await network.command('identity', data);
      tell(renamed ? tr('Seu nome e a facção salvos.') : tr('Nome e bandeira da facção salvos.')); refresh(); back();
    } });
  $('faction-head-identity').onclick = () => identity.open();

  // Field work belongs to the one construction in focus. The same controls stay in place
  // while status changes; selection and server quotes decide what is offered. A vehicle that works by itself has its switch,
  // with what it does now; an aircraft, the switch of its fuel return (Volta automática à base), with what that does; a
  // builder says what it is at; a structure being taken down says how far that has gone and may stand as it was again.
  // Roads are asked for from the Infraestrutura page (infrastructure-ux.ts).
  const operations = node('div', 'unit-field-operations'), dispatch = node('section', 'unit-dispatch'),
    dispatchToggle = button('auto', '', 'unit-operation-toggle'), dispatchState = node('b'),
    dispatchStatus = node('output', 'field-operation-status'), homing = node('section', 'unit-homing'),
    homingToggle = button('homing', '', 'unit-operation-toggle'), homingState = node('b'), homingStatus = node('output', 'field-operation-status'),
    builder = node('section', 'unit-builder'),
    buildStatus = node('output', 'field-operation-status'), taking = node('section', 'unit-dismantle'),
    keep = button('keep-up', tr('Cancelar desmontagem')), takenStatus = node('output', 'field-operation-status');
  dispatchToggle.append(node('span', '', tr('Automático')), dispatchState);
  dispatchToggle.setAttribute('aria-pressed', 'false');
  homingToggle.append(node('span', '', tr('Volta automática à base')), homingState);
  homingToggle.setAttribute('aria-pressed', 'false');
  dispatch.append(dispatchToggle, dispatchStatus); homing.append(homingToggle, homingStatus); builder.append(buildStatus); taking.append(keep, takenStatus);
  operations.append(dispatch, homing, builder, taking); $('unit-services').before(operations);
  operations.hidden = dispatch.hidden = homing.hidden = builder.hidden = taking.hidden = true;
  const towing = new TowUI($('unit-services'), { network, renderer, refresh, stopControls, serviced, toast });
  let dispatchPending = false;
  dispatchToggle.onclick = async () => {
    const actorId = dispatch.dataset.actorId, unit = network.faction?.units.find(unit => unit.id === actorId);
    if (dispatchToggle.disabled || dispatchPending || !unit || serviced() !== actorId || typeof unit.auto !== 'boolean') return;
    const on = !unit.auto;
    dispatchPending = true; refresh(); back();
    try { await ask('auto', { actorId, on }, () => toast(on ? tr('Automático ligado: faz sozinho o trabalho mais urgente e mais perto. Uma ordem sua o pausa até ser cumprida; Parar o desliga.') : tr('Automático desligado.'))); }
    finally { dispatchPending = false; refresh(); }
  };
  // The fuel return of the aircraft in focus, switched the other way: the switch shows what the field says of it next.
  let homingPending = false;
  homingToggle.onclick = async () => {
    const actorId = homing.dataset.actorId, unit = network.faction?.units.find(unit => unit.id === actorId);
    if (homingToggle.disabled || homingPending || !unit || serviced() !== actorId || typeof unit.homing !== 'boolean') return;
    const on = !unit.homing;
    homingPending = true; refresh(); back();
    try { await ask('homing', { actorId, on }, () => toast(on ? tr('Volta automática ligada: a aeronave guarda combustível para voltar à base.') :
      tr('Volta automática desligada: a aeronave cumpre toda ordem, mesmo até ficar sem combustível.'))); }
    finally { homingPending = false; refresh(); }
  };
  keep.onclick = () => {
    const actorId = taking.dataset.actorId;
    if (taking.hidden || !actorId || serviced() !== actorId) return;
    return work('cancel-dismantle', result => toast('heap' in result ? tr('Desmontagem cancelada: a estrutura fica onde está e a obra nova foi cancelada') +
      (result.heap ? tr('; o material dela ficou no local.') : '.') : tr('Desmontagem cancelada.')), actorId);
  };

  // One request to the field: what it changed is remembered, what it gave or why it was refused is said.
  async function ask<Kind extends CommandKind>(type: Kind, data?: CommandData[Kind], said?: (result: CommandResult<Kind>) => unknown): Promise<void> {
    try { const result = await network.command(type, data); remember(result); said?.(result); }
    catch (error) { tell(errorText(error), true); }
    refresh();
  }
  // Work on the construction in focus. The player's hands leave it first when it is the one being driven,
  // unless the work holds nobody (`driven`).
  function work<Kind extends 'repair' | 'cancel-repair' | 'dump-cargo' | 'abandon' | 'cancel-dismantle'>(type: Kind, said: (result: CommandResult<Kind>) => unknown, actorId = serviced(), driven = false) {
    if (!actorId) return;
    if (!driven && actorId === renderer.state?.controlledActor) stopControls();
    back(); return ask(type, { actorId }, said);
  }
  $('unit-repair').onclick = () => work('repair', r => toast(`${r.partial ? tr('Em reparo, em parte,') : tr('Em reparo')} por ${r.seconds} s · ${billText(r.cost)}.`));
  $('unit-cancel').onclick = () => work('cancel-repair', r => toast(cancelledText(r)));
  // Tipping part of a load out is asked for a vehicle that is stuck: in the player's hands it goes on being driven as it gets lighter.
  $('unit-dump').onclick = () => work('dump-cargo', r => toast(dumpedText(r)), serviced(), true);
  // Dismantling takes vehicles off the field for good and has builders take structures down, so it is asked first, once for
  // all those picked that may be (`dismantlePlan`), and then of the field for each: what came of it is said once.
  async function dismantle(plan: ReturnType<typeof import('./faction-ui.ts').dismantlePlan> | null): Promise<void> {
    if (!plan?.ids.length || !await confirm(...dismantleQuestion(plan))) return;
    back();
    if (plan.ids.length === 1) return ask('remove', { actorId: plan.ids[0] }, result => toast('removed' in result ? tr`Veículo desmontado · ${returnedText(result)}.` :
      tr('Desmontagem iniciada: um construtor em automático vai até ela.')));
    const done: { vehicles: number; structures: number; refused: string[] } = { vehicles: 0, structures: 0, refused: [] };
    for (const actorId of plan.ids) {
      try { const result = await network.command('remove', { actorId }); remember(result); done['removed' in result ? 'vehicles' : 'structures']++; }
      catch (error) { done.refused.push(errorText(error)); }
    }
    toast(dismantledNews(done), done.refused.length === plan.ids.length); refresh();
  }
  // Left where it stands, the construction in focus is a wreck: that is asked first.
  async function abandon() {
    const actorId = serviced();
    if (actorId && await confirm(tr('Abandonar esta construção?'), tr('Ela vira destroços onde está, com a carga que leva. Rende menos do que desmontar ') +
      tr('na base, e fica para quem recolher primeiro.'), tr('Abandonar'))) { leaving(actorId); work('abandon', () => toast(tr('Construção abandonada: agora são destroços.')), actorId); }
  }

  // The aid, asked for by any member for all of them: a base, or the ore lorry. What it costs is said beside the button. The field answers
  // with the base, where the page takes the player, and what is said of it comes with the faction told again.
  $('recover-faction').onclick = () => { if (network.faction?.recovery?.offered) { back(); ask('recover'); } };

  const pressed = (event: MouseEvent) => { const b = isElement(event.target) ? event.target.closest<HTMLButtonElement>('button[data-act]') : null; return b && !b.disabled ? { act: required(b.dataset.act), row: required(b.closest<HTMLElement>('[data-id]')) } : null; };
  // Changing faction, the player's hands leave what they drive, and a request the player had out is gone with it.
  const switching = <Kind extends CommandKind>(type: Kind, data: CommandData[Kind], said: (result: CommandResult<Kind>) => unknown): void => { stopControls(); asking = null; ask(type, data, said); };
  invites.onclick = async event => {
    const hit = pressed(event), faction = network.faction;
    if (!hit || !faction) return;
    const id = required(hit.row.dataset.id), invite = faction.invites.find(i => i.factionId === id);
    if (hit.act === 'decline') ask('decline', { factionId: id });
    else if (hit.act === 'join' && invite && await confirm(tr`Entrar na ${factionSaid(invite)}?`, joinWarning(invite, faction), tr('Entrar na facção')))
      switching('join-faction', { factionId: id }, () => tell(tr`Você entrou na ${factionSaid(invite)}: a base, os estoques e as construções agora são os dela.`));
  };
  // Asking to join a nation of the ranking says first what joining it would take away, and that a request out to another
  // is taken back; taking a request back asks nothing.
  const apply = async (ref: string | undefined): Promise<void> => {
    const faction = network.faction, other = faction?.ranking.find(f => f.ref === ref);
    if (!other || !faction || ref === undefined) return;
    const before = faction.request && faction.request.ref !== ref ? tr` O pedido à ${factionSaid(faction.request)} é cancelado.` : '';
    if (await confirm(tr`Pedir para entrar na ${factionSaid(other)}?`, joinWarning(other, faction, true) + before, tr('Pedir para entrar')))
      ask('apply', { ref }, () => tell(tr('Pedido enviado: o líder ou um administrador responde.')));
  };
  invitable.onclick = event => {
    const hit = pressed(event);
    if (hit?.act === 'invite') ask('invite', { playerId: required(hit.row.dataset.id) }, () => tell(tr('Convite enviado.')));
    else if (hit?.act === 'cancel') ask('invite', { playerId: required(hit.row.dataset.id), cancel: true }, () => tell(tr('Convite cancelado.')));
  };
  ranking.onclick = event => {
    const hit = pressed(event);
    if (hit?.act === 'see') { page?.close(); showPlace(Number(hit.row.dataset.x)); back(); }
    else if (hit?.act === 'apply') apply(hit.row.dataset.ref);
    else if (hit?.act === 'unapply') { asking = null; ask('apply', { ref: required(hit.row.dataset.ref), cancel: true }, () => tell(tr('Pedido cancelado.'))); }
  };
  requests.onclick = event => {
    const hit = pressed(event), name = hit && network.faction?.requests.find(r => r.id === hit.row.dataset.id)?.name;
    if (name && (hit.act === 'accept' || hit.act === 'refuse')) ask('answer', { playerId: required(hit.row.dataset.id), accept: hit.act === 'accept' },
      () => tell(hit.act === 'accept' ? tr`${name} entrou na facção.` : tr`Pedido de ${name} recusado.`));
  };
  // What one member does of another: what cannot be taken back asks first.
  members.onclick = async event => {
    const hit = pressed(event), faction = network.faction, said = hit && isMemberAction(hit.act) ? MEMBER_ACTIONS[hit.act] : null;
    const name = said && hit && faction?.members.find(m => m.id === hit.row.dataset.id)?.name;
    if (!name || !hit || !isMemberAction(hit.act) || !faction || !said) return;
    const question = memberQuestion(hit.act, name, faction);
    if (question && !await confirm(...question)) return;
    ask('member', { playerId: required(hit.row.dataset.id), act: hit.act }, () => tell(said.done(name)));
  };
  $('leave-faction').onclick = async () => {
    const faction = network.faction;
    if (faction && await confirm(tr`Sair da ${factionSaid(faction)}?`, leaveWarning(faction), tr('Sair da facção')))
      switching('leave-faction', {}, () => tell(tr('Você saiu da facção e começou uma nova, com base própria.')));
  };
  // The key of the player's seat (network-client.ts): copied to be typed on another device, or changed for another, which
  // leaves every device with the one before off the field.
  $('access-key-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(keyText(required(network.token))); tell(tr('Chave copiada.')); }
    catch { required(getSelection()).selectAllChildren($('access-key')); tell(tr('Copie a chave selecionada com Ctrl+C.')); }
  };
  $('access-key-change').onclick = async () => {
    if (!await confirm(tr('Trocar a chave de acesso?'), tr('A chave atual deixa de valer: os aparelhos que entram com ela saem do campo e só voltam com a nova.'),
      tr('Trocar a chave'))) return;
    try { await network.rekey(); tell(tr('Chave trocada. Use a nova para entrar em outros aparelhos.')); }
    catch (error) { tell(errorText(error), true); }
    refresh();
  };

  // A list is made again only when its rows are others: a button made again under the pointer would lose
  // the click. What each row says is written in place.
  function show<Row>(list: HTMLElement, rows: readonly Row[], key: (row: Row) => string, make: (row: Row) => HTMLElement, write: (element: HTMLElement, row: Row) => void): void {
    const now = rows.map(key).join();
    if (keys.get(list) !== now) { keys.set(list, now); list.replaceChildren(...rows.map(make)); }
    for (const [i, row] of rows.entries()) write(html(list.children[i]), row);
  }
  // A mark of the page's own, in a small button of a row: what it does is in its label and its title.
  const action = (act: string, id: string): HTMLButtonElement => { const b = button(act, '', 'row-act'); b.innerHTML = icon(id); return b; };
  const label = (b: HTMLElement, text: string, hint: string): void => { if (b.getAttribute('aria-label') !== text) b.setAttribute('aria-label', text); title(b, hint); };
  // Somebody of the field, and what can be asked of them.
  const person = (id: string, ...actions: HTMLElement[]): HTMLElement => {
    const row = node('div', 'faction-row'), text = node('span'); row.dataset.id = id;
    text.append(node('strong'), node('small')); row.append(text, ...actions); return row;
  };
  // A faction is told by its flag, at the head of its row.
  const flown = (row: HTMLElement, flag: FlagChoice): HTMLElement => { const mark = node('span', 'row-flag'); mark.innerHTML = flagMarkup(flag); row.prepend(mark); row.classList.add('flown'); return row; };
  // A nation of the ranking, in one line: its place, its flag, the name it goes by over where it was last seen, and its
  // points at the end. One met and out of sight is a button that takes the camera where it was last seen.
  // Beside it, the request to join it the player may send, or take back.
  const ranked = (r: FactionPageView['ranking'][number]): HTMLElement => {
    const row = node('li', 'ranking-row'), body = r.x !== null ? button('see', '', 'ranking-see') : node('div', 'ranking-see'),
      flag = node('span', 'row-flag'), text = node('span');
    row.dataset.id = String(r.id); row.dataset.ref = r.ref; flag.innerHTML = flagMarkup(r.flag); text.append(node('strong'), node('small'));
    if (r.x !== null) { row.dataset.x = String(r.x); body.title = tr('Levar a câmera até onde a nação foi vista pela última vez'); }
    body.append(node('b', 'ranking-place'), flag, text, node('output', 'ranking-wealth')); row.append(body);
    if (r.act) { const b = action(r.act, r.act === 'apply' ? 'i-plus' : 'i-close'), words = r.act === 'apply' ? tr('Pedir para entrar') : tr('Cancelar pedido'); label(b, words, words); row.append(b); }
    return row;
  };
  // A member with what the player may do of them, each a small button with its words in its label.
  const member = (r: FactionPageView['members'][number]): HTMLElement => person(r.id, ...r.actions.map(act => { const b = action(act, MEMBER_ACTIONS[act].icon); label(b, MEMBER_ACTIONS[act].text, MEMBER_ACTIONS[act].text); return b; }));
  const say = (row: HTMLElement, name: string, detail: string): void => { put(row.querySelector('strong'), name); put(row.querySelector('small'), detail); };
  const title = (element: Element | null, value: string): void => { if (html(element).title !== value) html(element).title = value; };

  return {
    dismantle, abandon, openIndustry: () => page?.open('industry'),
    // Paints the lists of the field as `fieldPanel` told them.
    render(p: FieldPanelView): void {
      social?.render();
      industry?.render();
      towing.render(p);
      const supply = p.automatic, fuel = p.homing, work = p.builder?.status ? p.builder : null, down = p.dismantling;
      operations.hidden = !supply && !fuel && !work && !down;
      dispatch.hidden = !supply; homing.hidden = !fuel; builder.hidden = !work; taking.hidden = !down;
      if (fuel) {
        homing.dataset.actorId = fuel.actorId;
        homingToggle.disabled = homingPending;
        if (homingToggle.getAttribute('aria-pressed') !== String(fuel.on)) homingToggle.setAttribute('aria-pressed', String(fuel.on));
        title(homingToggle, fuel.title); put(homingState, fuel.on ? tr('Ligada') : tr('Desligada')); put(homingStatus, fuel.status);
      }
      if (supply) {
        dispatch.dataset.actorId = supply.actorId;
        dispatchToggle.disabled = dispatchPending;
        if (dispatchToggle.getAttribute('aria-pressed') !== String(supply.on)) dispatchToggle.setAttribute('aria-pressed', String(supply.on));
        title(dispatchToggle, supply.title); put(dispatchState, supply.on ? tr('Ligado') : tr('Desligado'));
        put(dispatchStatus, supply.status || tr('Ligue para que faça sozinho os trabalhos da facção.'));
      }
      put(buildStatus, work?.status ?? '');
      if (down) { taking.dataset.actorId = down.actorId; put(takenStatus, down.text); }
      // An invitation is announced once, when it arrives; one answered or withdrawn may come again.
      const told = network.enabled && network.faction ? network.faction.invites : [], fresh = arrivals(known, told);
      for (const id of [...known]) if (!told.some(i => i.factionId === id)) known.delete(id);
      for (const invite of fresh) known.add(invite.factionId);
      if (fresh.length) tell(fresh.length === 1 ? tr`A ${factionSaid(required(fresh[0]))} convidou você. Responda em Facção.` :
        tr`${fresh.length} facções convidaram você. Responda em Facção.`);
      // A request to join the faction is announced to whoever answers it once, when it arrives.
      const asks = network.enabled && network.faction ? network.faction.requests : [], come = asks.filter(r => !asked.has(r.id));
      for (const id of [...asked]) if (!asks.some(r => r.id === id)) asked.delete(id);
      for (const r of come) asked.add(r.id);
      if (come.length) tell(come.length === 1 ? tr`${required(come[0]).name} pede para entrar na facção. Responda em Facção.` :
        tr`${come.length} jogadores pedem para entrar na facção. Responda em Facção.`);
      // The request the player has out is answered while the player looks elsewhere: the faction it went to is the player's
      // now, or it is gone and the player is where they were.
      const now = network.enabled ? network.faction : null;
      if (asking && now && now.ref === asking.ref) tell(tr`A ${factionSaid(asking)} aceitou o seu pedido: a base, os estoques e as construções agora são os dela.`);
      else if (asking && now && !now.request) tell(tr`O seu pedido à ${factionSaid(asking)} não foi aceito.`);
      if (now) asking = now.request;

      identity.show(network.enabled ? network.faction : null);
      const key = network.enabled && network.connected ? keyText(required(network.token)) : '';
      $('key-section').hidden = !key; put($('access-key'), key);
      const shown = p.faction;
      // Off the field or with no connection there is no faction to show: the window goes, and the field says why.
      if (page) {
        if (!shown) page.close();
        page.tell(factionNews(shown ? network.faction : null, network.playerId));
      }
      put($('faction-head-name'), shown?.name ?? '');
      if (shown && JSON.stringify(shown.flag) !== headFlag) { headFlag = JSON.stringify(shown.flag); $('faction-head-flag').innerHTML = flagMarkup(shown.flag); }
      show(invites, shown?.invites ?? [], r => r.factionId + JSON.stringify(r.flag),
        r => flown(person(r.factionId, button('join', tr('Entrar'), 'card-primary'), button('decline', tr('Recusar'))), r.flag), (row, r) => say(row, r.name, r.text));
      // A nation is made again when the place it was last seen at is another, or its flag is.
      show(ranking, shown?.ranking ?? [], r => [r.ref, r.x, r.act, JSON.stringify(r.flag)].join(), ranked, (row, r) => {
        say(row, r.name, r.detail); put(row.querySelector('.ranking-place'), r.place + 'º');
        const points = row.querySelector('.ranking-wealth'); put(points, r.wealth); title(points, r.title);
        if (row.classList.contains('own') !== r.own) row.classList.toggle('own', r.own);
      });
      show(members, shown?.members ?? [], r => r.id + ':' + r.actions.join(), member, (row, r) => say(row, r.name, r.detail));
      show(requests, shown?.requests ?? [], r => r.id, r => person(r.id, button('accept', tr('Aceitar'), 'card-primary'), button('refuse', tr('Recusar'))),
        (row, r) => say(row, r.name, r.detail));
      show(invitable, shown?.invitable ?? [], r => r.id + ':' + r.act, r => person(r.id, button(r.act, r.act === 'invite' ? tr('Convidar') : tr('Cancelar convite'))),
        (row, r) => say(row, r.name, r.detail));
    },
  };
}
