# Automático, serviços e interrupções

[Voltar ao mapa de manutenção](maintenance-map.md).
As regras abaixo descrevem o comportamento atual; os links levam a quem decide
e aos cenários que o verificam. Limites e tempos continuam definidos no código.

## Quem decide o quê

| Informação | Proprietário e significado |
| --- | --- |
| Automático ligado | `room.records.get(id).auto`: permite receber tarefas. Não significa que o veículo esteja livre ou trabalhando. |
| Controle direto e ordens | `Squad.manual` e `Squad.units`: quem está sendo conduzido e as ordens de movimento, ataque e coleta. |
| Serviço que segura uma construção | `room.records.get(id).service`: fabricação, reparo, giro ou desmontagem. [construction-service](../src/construction-service.ts) define as variantes, o avanço e as projeções; `SharedRoom.held` informa a retenção. |
| Tarefa atribuída e sua etapa | `SupplyDispatch.jobs`: entrega, construção, estrada ou transporte em andamento. `paused` e `waits` explicam suspensões e esperas. |
| Trabalho efetivamente realizado | A sala transfere carga e pede potência; `Works` e `Roadworks` avançam a obra/estrada. `actor.field` é a apresentação desse resultado. |
| Estratégia da facção autônoma | `SharedRoom.commanders`: escolhe coleta, fabricação, obra, melhoria e defesa. Emite os mesmos comandos de um jogador; não executa transferência, serviço ou física. Ver [comandante de base](faction-commander.md). |

São informações diferentes, não um único estado exclusivo. Por exemplo:
Automático **ligado**, controle **manual** e **sem tarefa atribuída** é uma
combinação normal. O serviço local de reparo também pode atender veículos cujo
Automático esteja desligado.
Serviços e esperas usam o relógio da simulação do campo.

O comandante distingue a intenção estratégica das ordens em execução. Não
reenvia coleta enquanto o veículo viaja, descarrega, recebe serviço ou recua.
Ao substituir extração móvel por mineração fixa na mesma boca, usa **Parar**
para liberar a coleta antiga; preserva a viagem que já retorna com carga. O
minerador pode receber outra jazida conhecida ou **Voltar à base** para abrir
passagem. O cargueiro continua usando o dispatcher comum para buscar o material
pronto. Essa coordenação pertence à estratégia; não cria outra máquina de
estados de transporte.

A estratégia reconhece planta e cargueiro como uma alternativa ao minerador
móvel para financiar os próximos serviços e compras. Se uma ameaça conhecida
chega à região da base, pode recolher a própria exploração de um defensor;
isso não toma um veículo em controle direto ou serviço. A ordem de retorno
reancora o Fogo livre pelo mecanismo normal do `Squad`, ao terminar a viagem.

Entradas: [SharedRoom](../server/room.ts), [SupplyDispatch](../server/supply-dispatch.ts),
[Squad](../src/squad.ts), [Works](../server/field-construction.ts).

No dispatcher, `playerOrder` distingue ordens do jogador da rota/coleta que a
própria tarefa criou; um serviço é verificado separadamente. `releaseHaul` libera
essa coleta em `cancel` e `home` somente se ainda pertencer à tarefa. `equipped` reúne
o critério de componentes funcionais para ligar Automático e para despachar.
Na sala, `canServe` reúne as condições comuns do atendimento local;
`canMend` acrescenta os vetos específicos de reparo.
`grounded` usa o apoio publicado pelo Native; `still` também exige velocidade
baixa. O ápice de um salto não autoriza serviço, trabalho parado ou proteção
offline. Captura usa o mesmo critério de apoio, permitindo movimento no solo.
Abastecer um tanque cobra os litros realmente transferidos, inclusive frações:
dez reposições de 0,6 L custam os mesmos 6 L de uma reposição única. O último
0,125 L do estoque ou dos suprimentos a bordo continua utilizável; repor
munição não pode conceder combustível quando esse estoque estiver zerado.
Na base ou no posto, o estoque atende primeiro; esgotado o combustível, um
veículo de suprimentos pode usar a própria carga para abastecer seu tanque.
Isso também conserva as restrições de combustível reservado para uma obra.
Compras, reparos e o carregamento de suprimentos em lotes inteiros conservam
suas regras; arredondar um valor apresentado não arredonda o tanque nem o débito.
Ver [service-feedback](../tests/service-feedback.test.js) e
[logistics](../tests/logistics.test.js).
`waitForMove` compartilha a espera pela rota e pelo prazo de nova tentativa
entre construtores e máquinas de estrada. Trabalho, combustível necessário
para partir e travamento físico continuam nas respectivas tarefas.

## Atribuição normal

`SupplyDispatch.step` acompanha as tarefas existentes e chama `plan` para as
novas. `ready` verifica disponibilidade, ordens, serviço, capacidade e segurança.
Construtores e máquinas de estrada recebem primeiro as tarefas de sua capacidade;
os demais transportadores/supridores disputam as demandas compatíveis.
`offer`/`plan` consideram prioridade, espera e tempo de execução: o mais próximo
não vence sempre. Os pesos ficam em `PRIORITY` e `AGING`, no mesmo módulo.

Com muitos construtores, três regras evitam viagens à toa:

- Um construtor com peças de suprimento, sem nada a bordo que uma obra peça, pesa
  pelo mesmo valor a obra e o reabastecimento ou reparo que nenhum veículo de
  suprimentos livre pode atender (`unserved`): a frota sem munição não espera todas
  as obras, e uma obra quase pronta não espera um reparo pequeno longe.
- Uma obra sem nada a montar não recebe um construtor que nada leva e chegaria
  depois de um veículo com guindaste que já traz o material dela (`ahead`): esse
  monta enquanto descarrega, e o cartão da obra diz que o construtor está a caminho.
- Uma máquina de estrada que também tem guindaste e suprimentos leva às obras o
  que falta, depois dos caminhões; antes, longe da base, a obra dela ficava sem
  material para sempre.

Ver [supply-dispatch-jobs](../tests/supply-dispatch-jobs.test.js) e
[road-works](../tests/road-works.test.js): `a constructor that grades too`.

Uma obra tem uma vaga de cada lado (`stop`, pelo `Squad.clear` do esquadrão).
Com as duas tomadas, quem chega espera fora do alcance dela (`outside`): do lado
de onde vem, além dos 7 m de `BUILD_REACH`, a dois comprimentos do próprio veículo
e mais o vão de `GAP`. Lá, o motivo é `waiting-place` (no caminho, ele está indo
para a obra), e ele entra quando uma vaga abre (`approach`). Ninguém para em cima
de outro. Quem espera com material que a obra pede ganha a vaga de quem está ali
sem nada a levar (`makeRoom`): esse sai para fora (etapa `aside`, *abrindo vaga
na obra*), a não ser que fosse o único
braço montando e o que chega não tenha braço. Enquanto alguém espera por ela, a
obra não é dada de novo a um construtor que nada traz e nada teria a montar. Com
mais construtores que vagas, os outros vão para outras obras ou esperam do lado
de fora. Um construtor que já está ao lado, sem nada a montar e num lugar que
outro ocupa, também sai.

Quem carrega na base para uma tarefa leva também, no espaço e no peso que sobram,
o que espera perto do caminho e que ninguém atende (`combine`): do mesmo lado da
base, até a distância da base ao destino além dele, ou até 60 m dele (`NEARBY`).

- Numa viagem de reabastecimento entram outro veículo com pouca munição e
  reparos, inclusive o do veículo que ela reabastece. Material de obra não entra:
  só deixaria o caminhão mais pesado e mais lento.
- Numa viagem de reparo ou de obra entram reparos, também em parte, e material de
  outras obras.
- A carga é repartida nesta ordem: quem tem pouca munição, reparos, obras; em cada
  grupo, o mais perto primeiro. De um estoque que não cobre o que as obras pedem,
  uma obra no caminho leva só o que as outras deixam, para que a viagem não tire
  de uma obra o que o planejamento daria a ela.
- Toda viagem vai primeiro ao próprio destino, como iria sozinha (um construtor
  que para numa obra a monta enquanto descarrega); depois, a quem tem pouca
  munição e então à parada mais perto de cada vez.
- O tanque precisa levar o veículo por todas as paradas e de volta, com o
  combustível que sobra no estoque; senão ele vai só à dele.

As paradas seguintes ficam em `job.after` (`next`), e o que é delas não paga a
parada atual (`later`; `keep` em `Works.attend`). Assim, uma viagem faz o que
antes eram três idas e voltas. Ver [supply-dispatch-jobs](../tests/supply-dispatch-jobs.test.js):
`a works has a place on each side` e `one trip from the base`, e
[supply-dispatch](../tests/supply-dispatch.test.js): `one urgent delivery`.

O dispatcher envia uma ordem; `Squad` dirige o veículo real. Chegar ao destino
não cria material: a sala transfere apenas o que está disponível e ao alcance.
Concluída a tarefa, o planejamento parte de onde o veículo está.

Quem volta à base com carga e espaço livre — a coleta cuja pilha acabou antes de
encher (`homing`) ou a volta com sobra de outro trabalho — continua no plano, mas
só para o que pega no caminho (`passing`): pilhas prontas conhecidas, airdrop e
montes da facção, na peça que leva cada coisa. O desvio de ida e volta pode tomar
até a fração de uma viagem cheia da base até ali igual à fração da carga cheia
que a coleta ocupa; no caminho, pega até pouco. Um monte fora do caminho segue a
regra de qualquer monte (vai de onde está), menos na volta de uma coleta. Valem as mesmas exclusões das
outras coletas (o que outra tarefa ou ordem já busca, alvos recusados), o
combustível para voltar por ali e a regra de segurança de `ready`; a pilha que
acabou de esvaziar não entra. Só conta como carregado (`loaded`) quem leva ao menos
`LOAD_SHARE` (um décimo) do que cabe; só volta por fim de pilha (`homing`) quem deixou a
pilha esgotada ou perdida. Ao retomar o campo, a ordem do jogador que um veículo em
automático cumpria volta a segurá-lo (`paused`), e a sala o carrega como antes. Ver [haul-on-the-way](../tests/haul-on-the-way.test.js).

## O efeito de cada interrupção

| Acontecimento aceito | Efeito e condição de retorno |
| --- | --- |
| Mover, Atacar, Coletar ou Virar por ordem do jogador | A atribuição automática anterior termina; a preferência Automático permanece ligada. Enquanto a ordem retém o veículo, não recebe outra tarefa. Ao terminar, o planejamento reavalia a situação. |
| Assumir controle direto | Cancela a tarefa e limpa as ordens anteriores de condução/coleta/ataque. Ao soltar, pode receber uma nova tarefa se Automático continuar ligado. Não restaura uma pilha de ordens antigas. |
| Parar, por ordem do esquadrão fora do controle direto | Cancela as ordens e desliga Automático. Precisa religá-lo para voltar a receber tarefas. |
| Trocar só a postura de fogo | Não cancela, por si só, a tarefa automática em andamento. |
| Comando recusado ou dirigido a outro veículo | Não deve cancelar a atribuição deste veículo. |
| Serviço em andamento | Segura a construção; não equivale a desligar Automático. Cada serviço tem sua conclusão/cancelamento próprios. |
| Falta de recursos, ameaça ou impedimento físico | A razão aparece na espera/tarefa, com o trabalho a que se refere. Nem toda espera permite nova tentativa apenas por passar tempo; um travamento físico confirmado permanece bloqueado até intervenção. Na tarefa de um construtor ou de uma máquina de estrada, um caminho que só deixou de avançar é tentado de novo depois de um tempo. |

Fonte: `SupplyDispatch.command/off/ordered/ready`, `SharedRoom.command/give` e
`Squad.command/resume`. As guardas da sala vêm antes de executar o comando;
essa tabela não dá prioridade irrestrita a uma ordem sobre um serviço ou cabo.

## Exemplos concretos

**1. Caminhão em entrega recebe Mover.** A entrega atual é cancelada e a nova
ordem de movimento permanece intacta. Ele chega, para e pode receber outra
entrega a partir dali. Se receber outro Mover antes de chegar, vale o último.
Se receber Parar, fica fora do automático até o jogador religá-lo.
Ver [supply-dispatch](../tests/supply-dispatch.test.js): casos `a manual move pauses`,
`a new order during the pause` e `Stop is the one order`.

**2. Veículo danificado sob controle manual na base.** Parado, fora de combate,
sem aceleração nem gatilho e com recursos disponíveis, pode entrar em reparo
automático mesmo continuando sob controle direto. O reparo é cobrado no início;
uma atualização de pedal neutro não o cancela. Acelerar com um comando válido
cancela esse reparo na base. O cancelamento devolve a conta ao pagador conforme
a regra de reembolso e marca o lugar em `declined`, impedindo recomeço automático
ali até o veículo se afastar. Fora da base, o controle manual veta o reparo automático.
Fonte: `SharedRoom.canMend/mend/cancel/command/survey`,
[ofertas de serviço](../server/service-policy.ts). Ver
[field-economy](../tests/field-economy.test.js) e os vetos de reparo em
[supply-dispatch](../tests/supply-dispatch.test.js).

**3. Construtor chega, mas a obra não tem material ou o motor ficou sem combustível.**
Estar ao lado e com Automático ligado não basta. `Works.attend/step` limita o
avanço ao material entregue e à potência efetiva calculada pela sala. A animação
usa o trabalho publicado; não deve inventar trabalho enquanto está esperando.
Se houver logística disponível, o material/combustível é levado ou buscado e a
obra pode continuar: o construtor espera (*aguardando material*) só o que outra
tarefa já traz e, com peças de suprimentos, busca o que nenhuma traz. O que um
veículo leva para a obra não abastece outros ao lado dele (`SupplyDispatch.giving`).
Ver [supply-dispatch-jobs](../tests/supply-dispatch-jobs.test.js): `a constructor by a works waits`
e `a vehicle beside a builder fills its tank`. Parar desliga o despacho automático, mas um construtor
estacionado ao alcance ainda pode trabalhar localmente se satisfizer as condições.
Ver [field-construction](../tests/field-construction.test.js): `a builder really runs dry`,
[builder-dispatch](../tests/builder-dispatch.test.js): `a constructor out of automatic`,
e [work-arm](../tests/work-arm.test.js).

**4. Parar perto de uma jazida não é desligar toda atividade local.** A ordem
termina a rota e o automático de tarefas; extração/carga por proximidade ainda
podem acontecer se o veículo estiver parado, apto e fora de combate. Para sair
daquele atendimento, afaste-o. O reparo e o reabastecimento local também têm
suas próprias condições, independentes do botão Automático.
Fonte: `SharedRoom.haul/serve`. Ver [haul-places](../tests/haul-places.test.js) e
[field-economy](../tests/field-economy.test.js).

**5. Conectar e soltar um reboque.** A relação física precisa ser aceita antes
de apagar ordens. Ao conectar, os dois ficam fora do automático; o rebocado
perde controle/ordens e o rebocador ainda pode executar Mover. O cabo impede
iniciar trabalho automático, giro ou reparo. Soltar não restaura as ordens nem
religa Automático: o rebocado fica parado e novas ações são explícitas.
Fonte: `SharedRoom.tow/idleTowTarget` e as guardas de serviços. Ver
[network-squad](../tests/network-squad.test.js), [squad-towing](../tests/squad-towing.test.js)
e [towing-native](../tests/towing-native.test.js).

**6. Ninguém da facção continua no campo, ou o servidor retoma um save.** Ao sair
o último membro, `SharedRoom.recall` encerra tarefas e manda os veículos aptos
voltar à base; um serviço em andamento termina primeiro. A preferência Automático
permanece, mas não são atribuídas novas demandas enquanto a facção está ausente.
O save JSON guarda essa preferência, carga, serviços e ordens duráveis por
`unitOrders`; atribuições transitórias são replanejadas, não ressuscitadas.
Photos binárias e diário têm o contrato de replay exato do host, distinto do JSON.
Ver [supply-dispatch](../tests/supply-dispatch.test.js): `the faction leaving`,
[field-save](../tests/field-save.test.js) e [field-replay](../tests/field-replay.test.js).

**7. Reparo maior do que cabe nas peças de suprimentos.** Uma casamata tem uma
peça destruída cujo reparo ocupa mais do que as caixas do construtor levam. Ele
leva o que cabe, conserta essa parte e volta para buscar o resto: a peça
recupera a vida na mesma proporção do que foi pago
(`partialMend`). Uma peça destruída volta a funcionar acima de zero de vida,
como qualquer peça danificada (`worksAgain`); um paiol, só a partir de 38 %,
abaixo do qual o núcleo o estoura. A sala a recoloca no mesmo lugar, com o
estado das outras peças (`World.reviveActor`). As chapas voltam inteiras, uma de
cada vez. Ver [supply-dispatch](../tests/supply-dispatch.test.js): `mended in parts`
e `a plate is mended whole`.

## Investigar uma espera

Comece pela razão exibida por `SupplyDispatch.view` e pelo serviço em andamento.
`waiting-stock` (*aguardando estoque na base*) só aparece quando a base não tem o
material; tendo-o, se nem uma parte que valha a viagem cabe nas peças de
suprimentos daquele veículo, a razão é `no-room` (`SupplyDispatch.scant`).
Compare a preferência `auto`, o controle `manual`, a ordem da unidade e a tarefa
atribuída. Depois confira alcance, recursos físicos, potência e a informação de
ameaça que aquela facção realmente conhece. Limpar a razão ou reenviar Mover
continuamente pode esconder a causa e disputar com a ordem do jogador.

No cliente, [automatic-presentation](../src/automatic-presentation.ts) reúne o
texto e a orientação das tarefas; [service-presentation](../src/service-presentation.ts)
apresenta serviços e recibos. [field-panel](../src/field-panel.ts)
preserva a prioridade dos problemas físicos e serviços em andamento. Um bloqueio
substitui a indicação de deslocamento; o painel não cria prazo nem localização
de ameaça para explicar a espera.

## Ler os recursos no painel

| Informação | O que representa |
| --- | --- |
| Tanque do motor | Combustível disponível para condução e ferramentas; inclui a autonomia dos veículos. |
| Carga | Material nos compartimentos de transporte, incluindo petróleo extraído. |
| Mistura de asfalto | Material na tremonha da pavimentadora. |
| Suprimentos transportados | Estoques refinados que o veículo leva para abastecer, reparar ou entregar às obras. O combustível aparece em litros, inclusive quando está zerado. |
| Falta entregar à obra | Custo da obra menos o material já entregue. |
| Falta no estoque da base | Parte ainda descoberta, considerando também as entregas que o servidor já despachou. |

Por exemplo, um construtor pode ter **202 L no motor**, **0 L nos suprimentos**
e uma obra aguardando **20 L de combustível**. Para continuar essa obra, leve
combustível refinado nos suprimentos até ela, buscando na base quando houver
estoque. O painel mantém essas reservas em indicadores separados, inclusive em
veículos que levam carga e suprimentos juntos. Suprimentos vazios em automático
podem simplesmente significar que nenhuma tarefa recebeu material ainda.

Essas apresentações usam o estado já publicado. O servidor continua decidindo
segurança, atribuição, consumo e entrega. Ver [field-panel](../tests/field-panel.test.js),
[faction-ui](../tests/faction-ui.test.js) e os cenários reais em
[field-cases](../tests/field-cases.test.js).

Ao mudar uma dessas transições, ajuste o exemplo correspondente e um teste no
módulo dono da regra. Não copie para este documento todas as fases, mensagens,
tempos ou constantes; consulte as definições ligadas acima.
