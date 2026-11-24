import { tr } from './i18n.ts';
export interface ConnectionState {
  readonly enabled: boolean;
  readonly connected: boolean;
  readonly persistenceFailed?: boolean;
  readonly phase?: string | null;
  readonly issue?: string | null;
  readonly playerId?: string | null;
}
interface NoticeText { title: string; detail: string }
export type ConnectionNotice =
  | NoticeText & { compact: true; retry: false; reload: false; retryText?: never }
  | NoticeText & { compact?: never; retry: true; reload: false; retryText: string }
  | NoticeText & { compact?: never; retry: false; reload: true; retryText: string };
// The field stays on screen when its connection is lost. Only the action that can recover this session is offered.
export function connectionNotice(network: ConnectionState, trial: unknown = false): ConnectionNotice | null {
  if (!network.enabled || trial) return null;
  if (network.connected) return network.persistenceFailed ? {
    title: tr('Salvamento indisponível'),
    detail: tr('O campo continua funcionando, mas o servidor não está conseguindo salvar. Alterações recentes podem se perder se ele reiniciar. A gravação será tentada novamente.'),
    compact: true, retry: false, reload: false,
  } : null;
  const phase = network.phase || 'reconnecting', retry = phase !== 'updated';
  const notice = {
    title: phase === 'updated' ? tr('Atualização disponível') : phase === 'elsewhere' ? tr('Conta em outro aparelho') :
      phase === 'refused' ? tr('Não foi possível conectar') : phase === 'connecting' ? tr('Conectando ao campo') : tr('Conexão interrompida'),
    detail: network.issue || (network.playerId ? tr('Tentando retomar sua sessão automaticamente. A última visão do campo continua aqui.') :
      tr('Aguardando o servidor. A conexão será tentada novamente sem precisar criar outro jogador.')),
    retryText: phase === 'elsewhere' ? tr('Jogar aqui') : tr('Tentar agora'),
  };
  return retry ? { ...notice, retry: true, reload: false } : { ...notice, retry: false, reload: true };
}
