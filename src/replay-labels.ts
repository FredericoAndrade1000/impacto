import { tr, translate } from './i18n.ts';
import type { CommanderReason } from '../server/commander-contract.ts';

// Observer wording is separate from the commander's canonical diagnostic codes.
// Adding a strategic reason requires choosing a label here too.
export function replayDecisionText(code: string): string {
  if (code === 'duel-won') return tr('Vitória · duelo encerrado');
  if (code === 'duel-lost') return tr('Derrota · duelo encerrado');
  if (code === 'duel-draw') return tr('Empate · capturas simultâneas');
  const words: Record<CommanderReason, string> = {
    recover: tr('Recuperar a base'), 'restore-mining': tr('Retomar a mineração'),
    'restore-construction': tr('Repor o construtor'), 'secure-fuel': tr('Garantir combustível'),
    'collect-material': tr('Coletar recursos'), 'revisit-source': tr('Reavaliar uma jazida'),
    explore: tr('Explorar o terreno'), 'local-defense': tr('Defender a base'), retreat: tr('Recuar para reparos'),
    'recover-mobility': tr('Recuar do bloqueio'),
    'evade-fire': tr('Reposicionar sob bombardeio'),
    'preserve-income': tr('Adiar reparos para preservar a reposição'), 'resume-repair': tr('Retomar os reparos adiados'),
    'build-mining': tr('Construir um posto de mineração'), 'release-mining-site': tr('Liberar o acesso à mineração'),
    'expand-transport': tr('Ampliar o transporte'), 'improve-workshop': tr('Melhorar a oficina'),
    'manufacture-defense': tr('Reforçar a defesa'), 'fund-production': tr('Realocar recursos para produção'),
    'recover-materials': tr('Recuperar materiais dos destroços'),
    'counter-battery': tr('Preparar contrabateria'), 'protect-route': tr('Proteger a rota'),
    'intercept-contact': tr('Interceptar o inimigo detectado'), 'end-interception': tr('Encerrar a interceptação'),
    'prepare-operation': tr('Preparar a operação terrestre'), 'rally-force': tr('Reunir a força de ataque'),
    'advance-operation': tr('Avançar para a base inimiga'), 'fight-operation': tr('Combater os defensores'),
    'occupy-base': tr('Ocupar a base inimiga'), 'return-operation': tr('Retornar da operação'),
    'complete-operation': tr('Objetivo terrestre cumprido'), 'abort-operation': tr('Encerrar a operação com segurança'),
    'preserve-reserve': tr('Preservar a reserva de recursos'), busy: tr('Mantendo as tarefas em andamento'),
    'waiting-source': tr('Aguardando uma fonte de recursos'), 'waiting-service': tr('Aguardando os serviços em andamento'),
    'no-base': tr('Sem base disponível'), disabled: tr('Comandante desativado'),
  };
  return Object.entries(words).find(([key]) => key === code)?.[1] ?? translate(code);
}
export function replayActivityText(code: string): string {
  return ({ watching: tr('Em vigilância'), firing: tr('Atirando'), attacking: tr('Atacando'),
    'moving-firing': tr('Em deslocamento') + ' · ' + tr('Atirando'), reloading: tr('Recarregando'), cooling: tr('Esfriando o cano'),
    'terrain-cover': tr('alvo encoberto pelo terreno'), 'servo-aligning': tr('Alinhando a arma'),
    'search-contact': tr('Nenhum inimigo detectado.'), idle: tr('parado'), moving: tr('Em deslocamento'), hauling: tr('Transportando') }[code] ?? translate(code));
}
