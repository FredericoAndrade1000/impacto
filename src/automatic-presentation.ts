import { tr } from './i18n.ts';
import { RAW, bill, billText, billTotal } from './economy.ts';
import type { SupplyBill, StockId } from './economy-contract.ts';
import type { ActorService } from './construction-service.ts';
import type { DispatchView, DispatchPhase, HaulPhase, JobReason, WaitReason, PauseReason } from './automatic-jobs.ts';

interface WaitWords { text: string; advice?: string }
interface AutomaticUnit {
  job?: DispatchView | null;
  auto?: boolean;
  service?: ActorService | null;
  supplies?: SupplyBill | null;
  atBase?: boolean;
  atPost?: boolean;
  builder?: { working?: string | null } | null;
}
interface WorkMaterials { id?: string; waiting?: boolean; share?: number; cost?: SupplyBill; delivered?: SupplyBill }
interface BuilderSent { phase: DispatchPhase | HaulPhase | 'dismantle'; reason: JobReason }
const isWaitReason = (reason: JobReason): reason is keyof typeof JOB_WAITS => Object.hasOwn(JOB_WAITS, reason);
const waitWords = (reason: JobReason): WaitWords | undefined => isWaitReason(reason) ? JOB_WAITS[reason] : undefined;
function unknownJob(kind: never): never { throw new Error('Unknown automatic job: ' + kind); }


// What an aircraft does whose thrusters left, once it lost one, no longer hold it up as its pilot flies it (squad.ts
// `crippled`): it goes home to be mended, comes down where it is, or waits on its skids to be mended. Its job, its haul and
// its row say the same words.
export const THRUSTER_LOST = Object.freeze({ home: tr('propulsor perdido · voltando para reparo'), forced: tr('propulsor perdido · pousando onde está'),
  waiting: tr('propulsor perdido · aguardando reparo') });
// Why a vehicle that works by itself waits, in a few words (server/supply-dispatch.ts).
const JOB_WAITS = Object.freeze({
  'waiting-stock': { text: tr('aguardando estoque na base'),
    advice: tr('A tarefa aguarda materiais do estoque da base. Entregue os recursos que faltam.') },
  // The stocks have what a service or a works takes, and this vehicle has not the room for a part of it worth the trip.
  'no-room': { text: tr('sem espaço na carga'),
    advice: tr('A base tem o material, mas nem uma parte que valha a viagem cabe nas caixas de suprimentos deste veículo. Esvazie as caixas, use um veículo com mais espaço de carga ou, num reparo, leve a construção até a base.') },
  // Both places by a works are taken: it waits outside, and goes in once one is free (server/supply-dispatch.ts `approach`).
  'waiting-place': { text: tr('aguardando vaga na obra'),
    advice: tr('Há uma vaga de cada lado da obra. Aguarde um acesso livre; se veículos parados estiverem bloqueando o caminho, afaste-os.') },
  'waiting-fuel': { text: tr('aguardando combustível para a viagem'),
    advice: tr('O combustível no tanque do motor precisa cobrir o trajeto. Abasteça na base ou leve suprimentos com combustível até o veículo. Se o tanque cheio não bastar, use um veículo com mais autonomia.') },
  // A builder beside its works with nothing to put up until what other vehicles bring comes: its advice is what the works lacks.
  'waiting-material': { text: tr('aguardando material') },
  'waiting-dismantle': { text: tr('aguardando a desmontagem para levar o material'),
    advice: tr('O material virá da estrutura em desmontagem. Aguarde um construtor desmontá-la para continuar a mudança.') },
  'waiting-grade': { text: tr('aguardando o nivelamento'),
    advice: tr('A pavimentadora precisa do trecho nivelado. Aguarde a motoniveladora; se não houver uma trabalhando, coloque uma em automático.') },
  'target-lost': { text: tr('alvo indisponível'), advice: tr('O alvo não está mais disponível. O automático procura outro trabalho compatível.') },
  threat: { text: tr('aguardando segurança'),
    advice: tr('O trabalho foi interrompido por combate ou ameaça detectada. Afaste o veículo do perigo ou proteja a área; o automático reavalia quando houver segurança.') },
  // The faction holds the place of the job dangerous — another's territory, an armed enemy seen there lately, or an airdrop
  // its sentinel guards (server/supply-dispatch.ts `perils`): no vehicle is sent there, and one on its way gives it up.
  danger: { text: tr('destino perigoso'),
    advice: tr('O destino fica em território de outra facção, perto de um inimigo armado visto há pouco ou de um airdrop com sentinela. O automático não vai até lá; para ir mesmo assim, dê a ordem você mesmo.') },
  immobile: { text: tr('sem mobilidade') },
  'blocked-way': { text: tr('caminho bloqueado'),
    advice: tr('O caminho ficou bloqueado. Reposicione o veículo com Mover ou conduza-o por outro trecho para retomar o trabalho.') },
  'no-loader': { text: tr('o equipamento não alcança o local de coleta; reposicione-o na Oficina'),
    advice: tr('O equipamento não alcança o local de coleta. Ajuste sua posição na Oficina antes de tentar novamente.') },
  'stuck-ground': { text: tr('atolado') }, 'stuck-grip': { text: tr('patinando · sem avanço') }, 'stuck-slope': { text: tr('sem força para a subida') },
  // An aircraft works only on its skids: by what it was sent to there is no ground level enough for it to come down on.
  'no-landing': { text: tr('sem chão plano para pousar no local'),
    advice: tr('A aeronave só trabalha pousada, e perto do alvo o chão é inclinado demais ou está ocupado. O automático tenta de novo daqui a pouco; aplaine o terreno ou use um veículo de rodas ou esteiras.') },
  // Sent home for its fuel on its way out after it left full, it gives the job up for a while (squad.ts `homeward`).
  'out-of-range': { text: tr('longe demais para o combustível'),
    advice: tr('Com o tanque cheio a aeronave não chega lá e volta. O automático tenta de novo daqui a pouco; use um tanque maior, menos peso ou um veículo de rodas ou esteiras.') },
  // Sent home for its fuel by its pilot (squad.ts `homeward`), it keeps its job and takes it up again once filled up.
  refuelling: { text: tr('pouco combustível · abastecendo na base'),
    advice: tr('A aeronave voltou à base para abastecer e retoma a tarefa com o tanque cheio.') },
  // Sent home to be mended for a thruster it lost (squad.ts `mend`), it keeps its job, waits there until it is mended, and takes
  // it up again; set down where it is for one, it gives the job up. Given nothing until it is mended (`mending`).
  'thruster-lost': { text: THRUSTER_LOST.home,
    advice: tr('Um propulsor foi perdido e os que restam não sustentam a aeronave com folga. Ela volta à base ou ao posto mais perto, é reparada lá com os estoques da facção e retoma a tarefa.') },
  'forced-landing': { text: THRUSTER_LOST.forced,
    advice: tr('Um propulsor foi perdido e a aeronave não chega à base: os que restam não a sustentam ou falta combustível para a volta. Ela pousa onde está, deixa a tarefa e espera ali um veículo de suprimentos que a repare.') },
  mending: { text: THRUSTER_LOST.waiting,
    advice: tr('Um propulsor foi perdido e os que restam não sustentam a aeronave com folga. Ela não recebe tarefas até ser reparada: na base ou num posto o reparo é automático quando os estoques pagam por ele; longe deles, por um veículo de suprimentos.') },
} satisfies Record<WaitReason, WaitWords>);
// Why a vehicle that works by itself does nothing by itself now, out of automatic and in it: an order of the player's — out of
// it, Stop, which put it out; in it, one it carries out first —, or the player's hands on it.
const PAUSES = Object.freeze({ 'manual-order': [tr('desligado pela ordem Parar'), tr('pausado · cumprindo sua ordem')],
  'manual-control': [tr('sob seu controle'), tr('pausado · sob seu controle')] } satisfies Record<PauseReason, readonly [string, string]>);
// Why a vehicle that works by itself turned home from its job, said after where it goes: combat or a threat by it, or a place
// its faction holds dangerous where it was going (server/supply-dispatch.ts `DANGER`).
const RETURNS = Object.freeze({ threat: tr('risco de combate'), danger: JOB_WAITS.danger.text });
// What a road machine does at a road, by its part of the work (server/road-works.ts).
const ROAD_JOBS = Object.freeze({ grade: tr('nivelando a estrada'), pave: tr('asfaltando a estrada') });
// What a vehicle that works by itself does now, in a few words (server/supply-dispatch.ts): its job — to rearm one of the
// fleet or pay its repair, to bring a works its material, to take a heap or a ready pile home — or to take one on by its way
// home with a load (`passing`: of what) —, to put a works up, to take a structure down, or to grade or pave a road the faction
// asked for —, with what it is for
// named as the faction knows it (`name`: a vehicle, a works, a structure or a site), and why it waits; on its way home; or that it has
// nothing to do, or why it is given nothing and what for. Held by the player, only by what (`PAUSES`). Where it loads and
// unloads is its base, or a post where the job says so (`post`). The job is the room's:
// no client-side timer or target is put in its place. What a builder does at its works the field tells otherwise
// (`builder.working`).
export function jobText(unit: AutomaticUnit | null | undefined, { name = () => '' }: { name?: (id: string) => string } = {}): string {
  if (!unit?.job) return '';
  const job = unit.job;
  const named = job.targetId ? name(job.targetId) : '', of = (words: string) => words + (named ? ' ' + named : ''),
    post = 'post' in job && job.post, at = post ? tr('no posto') : tr('na base'), to = post ? tr('ao posto') : tr('à base'),
    reason = job.reason === 'target-moving' ? named ? tr`aguardando o ${named} parar` : tr('aguardando o alvo parar') : waitWords(job.reason)?.text || '';
  if (job.phase === 'paused') return job.reason === 'manual-order' || job.reason === 'manual-control' ? PAUSES[job.reason][unit.auto === true ? 1 : 0] : '';
  if (job.phase === 'idle') return reason ? reason + (named ? ' · ' + named : '') : tr('aguardando trabalho');
  if (job.phase === 'aside') return tr('abrindo vaga na obra');
  if (job.phase === 'return') return (unit.atBase || unit.atPost ? tr`devolvendo suprimentos ${unit.atPost ? tr('no posto') : tr('na base')}` : tr`voltando ${to}` +
    (unit.supplies && billTotal(unit.supplies) > 0 ? tr(' com a carga restante') : '')) + (job.reason === 'threat' || job.reason === 'danger' ? ' · ' + RETURNS[job.reason] : '');
  if (reason) return reason + (named && job.reason !== 'target-moving' ? ' · ' + named : '');
  if (job.kind === 'rearm') return job.phase === 'collect' ? tr`buscando suprimentos ${at}` : tr('levando suprimentos ') + (named ? tr`ao ${named}` : tr('à frota'));
  if (job.kind === 'repair') return job.phase === 'collect' ? tr`buscando material de reparo ${at}` : tr('levando material para reparar ') + (named || tr('a frota'));
  if (job.kind === 'work') return (job.phase === 'deliver' ? tr('levando material ') : tr('buscando material ')) + (named ? tr`para a obra ${named}` : tr('para uma obra'));
  if (job.kind === 'heap') return job.passing ? tr('pegando o material de um monte no caminho') : tr('buscando o material de um monte');
  if (job.kind === 'haul') return job.phase === 'collect' ? tr`preparando transporte ${at}` : job.phase === 'home' ? tr`levando a carga ${to}` :
    job.phase === 'unload' ? tr`descarregando ${at}` :
    job.passing ? tr`pegando ${job.passing === 'supplies' ? tr('suprimentos') : tr(RAW[job.passing]) ?? tr('material')} no caminho` + (named ? ' · ' + named : '') :
    job.phase === 'load' ? tr('carregando material pronto') : tr('indo recolher material pronto');
  if (job.kind === 'grade' || job.kind === 'pave') return job.phase === 'work' ? ROAD_JOBS[job.kind] : job.phase === 'collect' ? tr`buscando material ${at} para a estrada` : tr('indo à estrada');
  const going = job.kind === 'build' ? of(tr('à obra')) : job.kind === 'dismantle' ? of(tr('desmontar')) : unknownJob(job.kind);
  if (job.phase === 'load') return tr('carregando o material desmontado');
  if (job.phase === 'work') {
    const active = Boolean(job.targetId && unit.builder?.working === job.targetId);
    return of(job.kind === 'build' ? active ? tr('montando') : tr('aguardando para montar') : active ? tr('desmontando') : tr('aguardando para desmontar'));
  }
  return tr`indo ${going}` + (job.phase === 'collect' ? job.post ? tr(' pelo posto') : tr(' pela base') : '');
}
// Remedies explain the published wait. They do not choose a task, infer a hidden threat,
// or promise a retry deadline; physical damage and active services keep their own advice.
export function jobAdvice(unit: AutomaticUnit | null | undefined, { work = null }: { work?: WorkMaterials | null } = {}): string {
  if (!unit?.job || unit.service) return '';
  const job = unit.job;
  if (job.phase === 'paused') {
    if (job.reason === 'manual-order') return unit.auto ? tr('Cumprindo sua ordem. O automático volta a escolher trabalho quando ela terminar.') :
      tr('Automático desligado pela ordem Parar. Ligue Automático para voltar a receber tarefas.');
    if (job.reason === 'manual-control') return unit.auto ? tr('Sob controle manual. Use Comandar para liberar a condução e permitir novas tarefas automáticas.') : '';
    return '';
  }
  if (unit.auto !== true) return '';
  if (job.reason === 'target-moving') return tr('O veículo atendido precisa parar em local seguro para receber os suprimentos.');
  const advice = waitWords(job.reason)?.advice;
  if (advice) return advice;
  if (job.kind === 'build' && job.phase === 'work' && work?.id === job.targetId && work.waiting) {
    const material = workMaterialsText(work);
    if (material) return material + tr('. Leve os materiais com um veículo de suprimentos em automático ou parado ao lado da obra.');
  }
  return job.phase === 'idle' && !job.reason && unit.supplies && !billTotal(unit.supplies) ?
    tr('Sem tarefa atribuída. Em automático, os suprimentos são carregados conforme o próximo trabalho; vazios não significam tanque do motor vazio.') : '';
}
// Where the builder sent to a works or to a structure being taken down is, as either tells it after the word for it: on its
// way, beside it, or first taking down the structure a works is moved from.
export const comingText = (sent: BuilderSent | null | undefined): string => !sent ? '' : waitWords(sent.reason)?.text ||
  (sent.phase === 'dismantle' ? tr('desmontando a estrutura antes') : sent.phase === 'work' ? tr('ao lado') : tr('a caminho'));
// The works of the faction on the field, as the card by the mark of each tells it (field-sites.ts): how far it is put up,
// with a bar of that (`share`); how much of its material came, and what of the rest the stocks do not have (`lack`);
// whether a builder puts it up, waits beside it for more, is sent to it (`comingText`), or none is near; why it waits all
// put up; whether a supply vehicle unloads into it; that it is a structure being moved; and where it is from the base.
// Given up (`cancel`), what came of it is left there.
export function workMaterialsText(work: WorkMaterials | null | undefined): string {
  if (!work?.cost || !work.delivered || (work.share ?? 0) >= 1) return '';
  const { cost, delivered } = work, lack = (id: StockId) => Math.max(0, cost[id] - delivered[id]),
    need = bill(lack('ferro'), lack('ligas'), lack('silica'), lack('combustivel'));
  return billTotal(need) > 0 ? tr('Falta entregar à obra: ') + billText(need) : '';
}
