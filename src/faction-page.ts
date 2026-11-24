import type { FactionView, FactionIdentity } from './faction-ui.ts';
import type { FactionNews } from './faction-dialog.ts';
import type { AiStatus } from './field-contract.ts';
export type MemberRole = 'leader' | 'admin' | 'member';
export type MemberAction = keyof typeof MEMBER_ACTIONS;
const required = <T>(value: T | null | undefined): T => { if (value == null) throw new Error('Missing faction ranking record'); return value; };
import { tr } from './i18n.ts';
import { count, compactNumber } from './format.ts';
import { ago, factionName, factionSaid, farText, aiStatusText } from './faction-ui.ts';

// The page of the faction, as the server last told it: the nations of the field by their wealth, each with the request to
// join it the player may send or take back, the faction's members and what the player may do of each, the requests to join
// it the player may answer, the invitations the player has and whoever the player may invite.
// Wealth is in points, the patrimony of a faction weighed whole on the server (`ranking`).
export const wealthText = (points: number): string => points >= 1e4 ? compactNumber(points, true) : count(points);
export const wealthTitle = (points: number): string => count(points) + tr(' pontos de riqueza');
// The same, said whole: "1,2 milhão de pontos", "350,4 mil pontos".
export const pointsText = (points: number): string => { const said = wealthText(points); return said + (/(ão|ões)$/.test(said) ? tr(' de pontos') : tr(' pontos')); };
export const ROLES = Object.freeze({ leader: tr('líder'), admin: tr('administrador'), member: tr('membro') });
const personStatus = (connected: boolean | undefined, ai?: AiStatus): string => aiStatusText(ai) || (connected ? '' : tr('desconectado'));

// What a member may do of another, by the roles of both: the leader of anybody, an administrator of a plain member.
// The leader also names and unnames administrators and hands the leadership over.
export function memberActions(mine: MemberRole, theirs: MemberRole): MemberAction[] {
  if (mine === 'leader') return ['remove', theirs === 'admin' ? 'member' : 'admin', 'leader'];
  return mine === 'admin' && theirs === 'member' ? ['remove'] : [];
}
// Each action on a member: its words, the mark of its button and what the faction is told when it is done.
export const MEMBER_ACTIONS = Object.freeze({
  remove: { text: tr('Remover da facção'), icon: 'i-close', done: (name: string): string => tr`${name} saiu da facção.` },
  admin: { text: tr('Tornar administrador'), icon: 'i-shield', done: (name: string): string => tr`${name} agora é administrador.` },
  member: { text: tr('Tirar a administração'), icon: 'i-shield', done: (name: string): string => tr`${name} deixou a administração.` },
  leader: { text: tr('Passar a liderança'), icon: 'i-flag', done: (name: string): string => tr`${name} agora lidera a facção.` },
});
// The actions that cannot be undone by the one who does them ask first.
export function memberQuestion(act: MemberAction, name: string, faction: FactionIdentity): [string, string, string] | null {
  if (act === 'remove') return [`Remover ${name}?`, tr`${name} sai da ${factionSaid(faction)} e começa uma facção nova. As construções ficam com vocês.`, tr('Remover')];
  if (act === 'leader') return [tr`Passar a liderança a ${name}?`, tr`${name} passa a liderar a ${factionSaid(faction)}, e você fica como administrador.`,
    tr('Passar a liderança')];
  return null;
}
// Leaving, in words: what stays with the faction, and what the player starts again with.
export const leaveWarning = (faction: FactionIdentity): string => tr`Os estoques e as construções ficam com a ${factionSaid(faction)}. ` +
  tr('Você começa uma facção nova, com base própria e os veículos de início.');

// What waits for the player's answer in the window of the faction, as keys by its tab: the invitations the player has and
// the requests to join the faction, and — for its leader and its administrators, who answer them — the offers of trade and
// the proposals of accords made to it.
export function factionNews(faction: FactionView | null | undefined, playerId: string | null | undefined): FactionNews {
  if (!faction) return { faction: [], trade: [], diplomacy: [] };
  const speaks = faction.members.some(m => m.id === playerId && m.role !== 'member'), to = (record: { to: { ref: string } }): boolean => record.to.ref === faction.ref;
  return {
    faction: [...faction.invites.map(i => 'invite:' + i.factionId), ...faction.requests.map(r => 'request:' + r.id)],
    trade: speaks ? (faction.trades ?? []).filter(to).map(t => 'trade:' + t.id) : [],
    diplomacy: speaks ? (faction.accords ?? []).filter(a => to(a) && a.acceptedAt === null).map(a => 'accord:' + a.id) : [],
  };
}

export function factionPage(faction: FactionView | null | undefined, playerId: string | null = null, time = 0) {
  if (!faction) return null;
  const mine = faction.members.find(m => m.id === playerId)?.role ?? 'member', met = new Map(faction.known.map(f => [f.id, f])),
    seen = (f: FactionView['known'][number]): string => f.seen ? tr('à vista agora') : f.at !== null ? `vista ${ago(required(f.at), time)}` + (faction.base ? ` · a ${farText(required(f.x), faction.base.x)}` : '') : `derrotada ${ago(required(f.defeated), time)}`,
    // A faction that invited the player is joined by its invitation: no request goes to it.
    inviting = new Set(faction.invites.map(i => i.ref)),
    ranking = faction.ranking.map((f, i) => {
      const known = f.id === null ? undefined : met.get(f.id), own = f.ref === faction.ref, asked = faction.request?.ref === f.ref;
      return { id: f.id, ref: f.ref, place: i + 1, name: factionName(f), flag: f.flag, wealth: wealthText(required(f.wealth)), title: wealthTitle(required(f.wealth)), own,
        detail: [aiStatusText(f.ai), own ? tr('sua nação') : '', !own && asked ? tr('pedido enviado') : '', !own && known ? seen(known) : ''].filter(Boolean).join(' · '),
        x: !own && known && !known.seen && known.at !== null ? known.x : null, act: own || inviting.has(f.ref) ? null : asked ? 'unapply' : 'apply' };
    }),
    place = ranking.find(row => row.own), invited = (person: { invited: boolean }): 'cancel' | 'invite' => person.invited ? 'cancel' : 'invite';
  return {
    name: factionName(faction), flag: faction.flag,
    standing: place && { place: place.place, of: ranking.length, points: pointsText(required(required(faction.ranking[place.place - 1]).wealth)), title: place.title },
    ranking,
    members: faction.members.map(m => ({ id: m.id, name: m.name, you: m.id === playerId,
      detail: [ROLES[m.role], m.id === playerId ? tr('você') : '', personStatus(m.connected, m.ai)].filter(Boolean).join(' · '),
      actions: m.id === playerId ? [] : memberActions(mine, m.role) })),
    invites: faction.invites.map(i => ({ factionId: i.factionId, name: factionName(i), flag: i.flag,
      text: `${i.members} ${i.members === 1 ? tr('membro') : 'membros'}` })),
    // Who asks to join the faction, from which: told only to its leader and its administrators, who answer.
    requests: faction.requests.map(r => ({ id: r.id, name: r.name, detail: [factionName(r.from), personStatus(r.connected, r.ai)].filter(Boolean).join(' · ') })),
    // Whoever is not of the faction: those of the factions met, under their nation's name, and those not met yet.
    invitable: [...faction.known.flatMap(f => f.members.map(m => ({ id: m.id, name: m.name, act: invited(m),
      detail: [factionName(f), personStatus(m.connected, m.ai)].filter(Boolean).join(' · ') }))),
    ...faction.strangers.map(m => ({ id: m.id, name: m.name, act: invited(m),
      detail: [tr('ainda não encontrado'), personStatus(m.connected, m.ai)].filter(Boolean).join(' · ') }))],
    // Leaving takes another member to keep the faction: alone, the player starts it again instead.
    leave: faction.members.length > 1,
  };
}
