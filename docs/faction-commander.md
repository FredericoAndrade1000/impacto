# Comandante de base

A primeira versão controla uma facção própria no servidor: coleta Ferro e
Petróleo, repõe veículos essenciais, mantém uma reserva, melhora a Oficina e
organiza defesa local e interceptações curtas para proteger rotas de trabalho.
Pode ampliar a mineração e preparar uma operação terrestre contra uma base
identificada. Não projeta veículos novos nem coordena aviação ou uma campanha
global com várias frentes.

Um adversário controlado por ferramentas pode usar a [ponte de jogador](player-bridge.md).
Ela conserva uma conexão normal entre decisões do planejador; não reutiliza a
política do comandante nem consulta seu estado interno. O transporte, as ordens,
o piloto e a admissão continuam sendo os do jogador.

Há um [experimento econômico com rede pequena](../scripts/commander-learning/episode.ts), executado
em CPU fora do servidor público. Ele compartilha a execução e a cadência do
comandante e grava as intenções escolhidas; o replay não depende do modelo.
A política padrão permanece a referência. Arenas com quatro facções complementam
os duelos e são identificadas como períodos de avaliação, sem vitória eliminatória.

## Fronteiras

| Responsabilidade | Proprietário |
| --- | --- |
| Tipos de intenção, observação e memória | [commander-contract](../server/commander-contract.ts) |
| Informação da própria facção e propostas de fabricação | [commander-observation](../server/commander-observation.ts) |
| Projetos admitidos compartilhados entre cotação e fabricação | [commander-designs](../server/commander-designs.ts) |
| Escolha determinística, sem referência à sala ou ao mundo | [commander-policy](../server/commander-policy.ts) |
| Adiar e retomar reparos leves sem consumir a reposição | [commander-maintenance](../server/commander-maintenance.ts) |
| Recuperar materiais de destroços conhecidos próximos | [commander-recovery](../server/commander-recovery.ts); [commander-routes](../server/commander-routes.ts) compartilha a avaliação dos corredores econômicos |
| Alerta e posicionamento antecipado da guarda | [commander-defense](../server/commander-defense.ts) |
| Missão limitada de proteção de rota | [commander-tactics](../server/commander-tactics.ts); [commander-units](../server/commander-units.ts) compartilha a autoridade de serviços/retorno |
| Preparação, reunião, avanço, combate, ocupação e retorno | [commander-operations](../server/commander-operations.ts) |
| Cadência, tentativas, execução e memória salva | [faction-commander](../server/faction-commander.ts) |
| Configuração e criação gradual de facções | [field-config](../server/field-config.ts), [commander-population](../server/commander-population.ts) e worker; fora da estratégia e do replay |
| Cobrança, serviços, transporte, piloto e combate | `SharedRoom`, `SupplyDispatch`, `Squad` e Native existentes |
| Identidade, presença, checkpoint e diário | `SharedRoom`, `FieldHost` e worker |

A observação usa o conhecimento da facção, seus equipamentos e terreno já
explorado. Não entrega inimigos ocultos, reservas atuais de jazidas fora da
visão ou referências mutáveis do mundo ao planejador. Sinais de risco usam as
mesmas áreas conhecidas que já orientam o transporte normal. Leituras antigas
podem estar erradas; revisitar uma fonte é uma tentativa, não uma consulta à
reserva oculta.

O aviso de captura da própria base também faz parte da observação e mantém o
alerta defensivo mesmo sem contato visual ou sensores funcionais. É o mesmo
aviso público da facção; não revela a identidade ou posição de inimigos ocultos
e não cria outro temporizador. Sua retirada normal encerra esse sinal.

Uma rota recebe uma espera de 180 s no relógio do campo após um recuo estratégico
confirmado por perigo conhecido, um aviso de perigo do próprio trabalhador ou
a perda dele. Ela vale também para outro veículo, evitando repetir a mesma perda
com uma reposição. A espera usa a memória
de tentativas existente, conserva o prazo ao retomar o campo e não é renovada a
cada decisão pelo mesmo aviso. Retornos carregados continuam; outras fontes
seguras podem ser usadas. Uma ordem recusada, um retorno por defeito e o simples
vencimento da espera não comprovam perigo novo. Desmontagem e abandono voluntário
também não provam perigo.

Um bloqueio físico de transporte adia a fonte por 600 s, compartilhados entre
trabalhadores, sem renovar o prazo pelo mesmo aviso. Um minerador preso fora da
base não conta como capacidade disponível; um veículo em reparo na base continua
contando. Se um transporte próprio estiver parado por `stuck-*`, carregado e
sem serviço ou controle manual, a IA pode usar **Despejar carga**. O comando normal
descarta uma parcela de até 25% da capacidade e permite uma tentativa realmente
mais leve. A carga descartada é perdida; a IA aguarda 180 s antes de outra descarga.
Isso não resolve um casco vazio preso ou sem motor. Não há reinícios sucessivos
de Home sobre o mesmo bloqueio.

Em confronto conhecido, a compra compara as propostas admitidas de blindado,
viatura protegida de 20 mm e viatura leve contra o orçamento e suas reservas.
A viatura de 20 mm usa o modelo público com `rh202` e blindagem ampliada,
admitido e cobrado normalmente pela Oficina. A falta de dinheiro para o blindado
não obriga a esperar quando a proposta intermediária cabe no orçamento.
A Oficina II também conserva a verba da próxima resposta militar útil, além
da reposição de mineração, antes de iniciar a melhoria. Ter uma guarda pronta
não justifica consumir a maior parte do capital inicial numa instalação.

Cada ação atravessa `room.command`. Kit inicial, preços, combustível, munição,
suprimentos, tempo de fabricação, instalações, apoio e espaço continuam normais.
A reserva para repor o minerador reduz a chance de gastar a única renda em
expansão. Quando já existe mineração fixa, o transporte dedicado passa a ser
essencial: a reposição pode consumir essa reserva, pagando o preço normal.
O minerador móvel estacionado não conta como o cargueiro da planta. Não há
crédito ou reposição gratuita após uma perda.

Capacidade de transporte não equivale a capacidade de extrair qualquer jazida.
Se falta um material conhecido que nenhuma planta local extrai, a IA repõe o
extrator móvel perdido, usando capital ocioso quando necessário. Um cargueiro
sem ferramenta só recebe destino com carga pronta ou extração fixa funcional.
Uma rota própria pode mudar de material na próxima saída vazia do depósito;
retornos carregados, serviços e ordens de outra origem mantêm sua autoridade.

Renda fixa funcional (planta e cargueiro) também permite repor o construtor,
preparar defesa e melhorar a Oficina após perder o minerador móvel. Com
combustível abaixo da reserva do perfil, a reposição da cisterna pode consumir
a reserva financeira; ainda exige preço completo e uma fonte conhecida segura.
Com estoque abundante, a compra continua sujeita à reserva normal.

Possuir um minerador não basta para financiar investimento: precisa haver
mobilidade, combustível e uma fonte conhecida com material disponível e rota
segura, ou uma carga retornando. Uma visita especulativa a uma jazida antiga não
conta como renda. Combustível já estocado pode financiar a Oficina II; não é
obrigatório comprar uma cisterna antes quando a melhoria e a reserva cabem no
estoque. Com renda de Ferro e uma guarda funcional pronta na base, uma compra
militar pode usar a reserva financeira de Ferro do minerador. Os demais materiais
conservam sua reserva completa; investimento civil conserva também o Ferro.

Durante um alerta na base, compras civis opcionais preservam também o orçamento
do próximo defensor. Uma reposição militar urgente pode usar essa reserva mesmo
após perder a renda; continua pagando o preço completo. Se a opção principal não
cabe no estoque, a viatura admitida mais barata pode preencher uma vaga de guarda.
Uma base rival conhecida e sem proteção mantém essa reserva durante as pausas do
alerta local. Assim, uma troca de tiros não libera de repente o orçamento militar
para outro construtor. Isso usa o conhecimento já observado, sem novo prazo oculto.
Reposições essenciais também preservam os minérios da próxima defesa que não
conseguem recuperar por uma rota conhecida, segura e produtiva. Um cargueiro de
ferro não pode gastar a última Sílica militar; um extrator que realmente pode
buscar Sílica conhecida pode financiar essa recuperação. Sem destino produtivo
compatível, a IA não repete a compra civil. A política usa os preços existentes,
sem reservar saldo em outro estado ou alterar os recursos da facção.
A compra prevista continua orientando a reposição de materiais mesmo quando a
guarda está completa. Um minerador vazio pode trocar o material na sua próxima
saída da base; não precisa juntar todo o Ferro da futura compra antes de buscar
Sílica ou Ligas. Quando a falta é preenchida, retoma o Ferro. Carga de retorno,
trajeto fora da base e serviços mantêm sua autoridade; fabricar continua exigindo
o preço completo e a reserva aplicável.

A previsão de materiais inclui a próxima compra militar, sua reposição e o
minerador de reserva. Assim, uma fonte desconhecida de Sílica pode motivar busca
antes da última compra possível. Havendo renda, combustível e guarda, a Oficina II
tem precedência sobre outro construtor ocioso ou uma nova preparação de força leve.

Reparos leves pagos pelo estoque podem ser cancelados pelo comando normal quando
consomem a reserva de reposição. O reembolso é o do serviço; dano importante,
pagamento por suprimentos e controle manual são preservados. A IA salva quais
reparos adiou e só os retoma quando pode pagar sem consumir a reserva do mesmo
material. Cancelamentos do jogador não são assumidos pela IA. Automático,
trabalho ativo, coleta e deslocamentos são preservados, inclusive quando o trabalhador também
está recebendo reparo: cancelá-lo pode reiniciar um ciclo de trabalho e retorno.
Se perder a renda e não puder repô-la, a facção pode desmontar um veículo
realmente ocioso na base quando seu valor residual pagar a reposição. A última
guarda, cargas, reparos, obras em andamento e trabalho ativo são preservados.
Se ainda houver uma guarda pronta e funcional na base, repor a renda vem antes
de completar a quantidade de guardas. Sem essa guarda, a resposta armada imediata
conserva prioridade. Assim, desmontar um excedente para financiar o minerador não
faz a facção recomprar esse excedente no ciclo seguinte.

Um construtor desarmado e realmente ocioso também pode financiar a próxima
melhoria ou compra militar, se o valor residual completar todo o orçamento
aplicável. A decisão não vende uma peça por um plano que continua impagável.
Uma guarda ainda em fabricação não permite desmontar a última guarda pronta.

Destroços conhecidos a até 1 km da base podem devolver materiais em falta pelo
comando normal de recuperação. Sem alerta ou operação, um guarda ou construtor
disponível pode aproximar-se por uma rota conhecida segura. A coleta exige os
30 m e o período de calma normais; não há recuperação remota. Trabalho, carga,
retorno e controle manual mantêm sua autoridade. O deslocamento reutiliza uma
ordem de posicionamento, sem criar missão ou prazo persistente; concluída a
coleta, a unidade volta pelo fluxo normal da guarda. A aproximação continua
sujeita ao terreno e a ameaças que apareçam no caminho.

Uma decisão ocorre a cada cinco segundos simulados, com no máximo uma ação
estratégica por passo do campo. O piloto e os serviços conservam suas próprias
cadências. Tentativas recusadas têm espera; o histórico guarda as últimas
40 transições. A memória de ordens não substitui as ordens do esquadrão.

`balanced` e `cautious` compartilham a regra; o segundo conserva mais combustível,
explora em passos menores e pode preparar mais defesa local. São hipóteses
comparáveis, não níveis de dificuldade calibrados.

Um contato atual a até 1.800 m, um sinal a até 1.000 m ou combate nos últimos
20 s de uma unidade própria a até 1.000 m aciona o alerta. Um veículo que a
facção vê estar desarmado não dispara esse alerta; radar não certifica ausência
de armas. A guarda usa Mover para se posicionar 80 m à frente, dentro da base,
e pode chamar de volta a exploração do próprio comandante.
Essa aproximação aceita a ameaça que a motivou: a retirada de rotina não a
cancela no ciclo seguinte. O guarda precisa conservar os mesmos limites físicos
de integridade, munição e combustível usados para cobrir interceptações e
operações; se não puder, permanece no ponto de serviço ou recua. Serviços atuais
continuam tendo prioridade.
**Voltar à base** conserva a rota e a reancoragem normais; serviços, controle
direto, coleta e retorno carregado mantêm sua autoridade. A reação armada
depende das condições reais de tiro, inclusive obstáculos e aliados na trajetória.

Sob alerta, um informe anônimo de tiro terrestre com até 60 s, erro dentro do
limite normal de contrabateria permite preparar um morteiro se a origem, incluindo
a margem de erro, couber no alcance balístico da oferta admitida. Esse alcance
reutiliza o cálculo Native das armas; não há um segundo teto estratégico em quilômetros.
Os informes são os mesmos medidos pelos sensores da facção; não revelam o ator
oculto nem seguem sua posição. A artilharia permanece na base com Fogo livre,
usando a contrabateria normal do esquadrão. Não conta como guarda direto, explorador
ou participante da operação terrestre. Uma peça em fabricação já evita a compra
duplicada, mas não conta como defesa pronta. Havendo uma guarda direta funcional
pronta na base, a contrabateria válida precede completar a quantidade desejada
de defensores diretos. Sem essa guarda, a reposição direta vem primeiro. A
alternativa mais barata ainda pode ser usada quando o
estoque não paga nenhum defensor admitido.

A busca econômica evita corredores perigosos e a área de serviço de bases
hostis conhecidas, mesmo sem um defensor visível. O reconhecimento militar usa
apenas um defensor excedente preparado, preservando um guarda; pode atravessar
risco conhecido para identificar uma base, mas volta com dano, reservas baixas,
impedimento de terreno ou alerta na sua própria base. Ambos usam o piloto normal.

Quando há mais de um defensor, até a exploração de recursos preserva o guarda
preparado de maior integridade nominal na base, antes de identificar rivais.
Sem excedente, a busca prefere um utilitário ocioso elegível antes de retirar a
última guarda. Só quando essa alternativa falta um único reconhecimento pode
procurar os recursos básicos na abertura; com uma base rival conhecida, a última
guarda fica na base. Um veículo preso fora dela não
conta como reserva defensiva disponível. Veículos já pagos e em serviço na base
continuam contando para a compra, mas precisam estar preparados para sair.

Sem um defensor excedente, um utilitário terrestre ocioso, vazio e em boas
condições pode procurar materiais desconhecidos. Há uma busca econômica em
deslocamento por vez; ela evita os corredores perigosos conhecidos e volta com
um novo alerta na base. Não substitui coleta, serviço ou controle manual. Essa
alternativa não participa do reconhecimento militar ou da operação de ataque.

Propostas de construções fixas passam pela validação normal de posicionamento:
ela recusa um contorno desconhecido antes de examinar terreno ou território e
considera somente a ocupação própria. As outras jazidas conhecidas dentro do
alcance também são consideradas quando as mais próximas não servem. A proposta
não reserva terreno ou materiais; a execução confere novamente posição e custo.

Um bloqueio físico no trajeto de ida do comandante permite uma tentativa de
**Voltar à base**. Se o retorno também falhar, a IA não reinicia a mesma rota nem
reutiliza o veículo após expirar a espera. A ordem de deslocamento de uma operação
atualiza essa memória. Coleta carregada, serviços, controle direto e movimento
em andamento mantêm a autoridade; aeronaves e falhas mecânicas não recebem essa
tentativa. A regra não cria tração, teletransporte ou garantia de vencer a encosta.

## Executar sem alterar um campo existente

Em PowerShell na raiz, com uma pasta dedicada e sem `IMPACTO_SAVE_DIR`:

```powershell
$env:IMPACTO_TEST_SERVER = '1'
$env:IMPACTO_TEST_SAVE_DIR = Join-Path $PWD 'validation/commander-test-server'
$env:IMPACTO_TEST_COMMANDERS = '2'
npm run dev -- --host 0.0.0.0 --port 8421
```

O padrão é desligado. São aceitos de zero a quatro controladores; valores
positivos exigem servidor de testes. Com comandantes, o campo usa estoques e
fabricação normais, sem ensaio de recursos ilimitados. As ferramentas de teste
continuam disponíveis aos jogadores humanos, mas o comandante não as utiliza.

O worker cria somente as identidades que faltarem para a contagem. Um comandante
salvo e pausado também conta: reiniciar ou aumentar/diminuir a variável não
renova seu kit nem apaga facções existentes. Um campo com controladores exige
esse modo de testes ou a configuração pública explícita descrita abaixo.

Para ferramentas internas, `FieldHost.addCommander(nome, perfil)` cria a
identidade; `setCommanderEnabled(id, enabled)` pausa/retoma a estratégia. A
pausa usa a desconexão normal; não congela o mundo. Uma IA ativa conta como
presença e não recebe proteção de ausência. Não existe comando de cliente
para criar um controlador nem chave de acesso utilizável para assumir sua
identidade.

## Proteger uma rota

A facção pode enviar um defensor excedente contra um contato atual próximo de
uma rota ou veículo de trabalho. A missão exige dois defensores preparados na
base, preserva um deles ali e não substitui coleta, serviço, controle direto
ou retorno. Um posto distante não conta como guarda da base.

O contato precisa estar em visão/radar, próximo ao chão conhecido e entre
1 e 3 km da base. Som e lembranças de inimigos não identificam um alvo. O
veículo visto estar desarmado não justifica essa saída de proteção; uma
leitura apenas de radar conserva a incerteza sobre suas armas. O
destino fica 200 m antes da posição observada; uma ordem normal de Mover faz
a aproximação. Ao chegar, Atacar fixa o foco de tiro. A física e o piloto
continuam decidindo alcance, linha de tiro, munição e movimento.

Há no máximo uma interceptação por facção, por até 180 s, sem renovar o prazo
ao focar o alvo ou retomar um checkpoint. A perda do contato, uma ameaça na
base, a indisponibilidade do guarda, danos ou reservas baixas levam a Voltar.
Exploração aguarda o retorno do defensor. Uma nova saída contra o mesmo alvo
tem espera de 360 s desde o início anterior, inclusive se ele mudar de posição
ou outro defensor estiver disponível. Essa missão protege uma rota; uma
operação contra base tem estado e critérios próprios, descritos a seguir.

## Operação terrestre

Há no máximo uma operação por facção. O alvo é uma base inimiga conhecida,
sem proteção de ausência observada, em terreno já explorado. A posição de uma
base fixa continua conhecida enquanto nenhuma observação indicar sua mudança.
Não é preciso ver continuamente todo o chão entre as bases: uma
depressão oculta atrás de uma crista não apaga o reconhecimento já realizado.
O planejador usa a velocidade e a autonomia Native dos próprios veículos para
avaliar a viagem; o piloto continua sujeito ao terreno real. Não há uma faixa
fixa de distância que exclua as bases normais, separadas por cerca de 10 km.

Preparar exige renda de Ferro funcional, reserva financeira e de combustível,
sem obra inacabada. Combustível já estocado pode pagar uma saída limitada mesmo
após perder a cisterna; isso não fabrica combustível nem libera uma rota insegura
de coleta. A próxima compra militar e a busca de materiais usam a mesma cotação:
uma preparação que exige três defensores também procura os materiais do terceiro.
O levantamento de uma jazida necessária pode continuar durante essa preparação,
até haver orçamento para reunir a força.
O único minerador também pode buscar outro material antes de juntar todo o
Ferro da compra prevista. Uma rota em andamento só muda
de material ao sair da base ou de um posto, com carga vazia e ainda sob a ordem do
comandante. Carga, retorno, serviço, controle manual e viagem fora do depósito
são preservados. Ao suprir a carência, o minerador retoma Ferro. Isso evita
exigir Sílica para comprar um segundo minerador antes de conseguir buscar Sílica.

A facção reúne três defensores terrestres
com pelo menos 80% de integridade média, 60% de munição e 75% de combustível;
preserva um guarda preparado na base e envia os dois excedentes com maior
capacidade nominal de integridade dos componentes entre os capazes de cumprir
a viagem. A autonomia precisa pagar ida e volta mantendo 25% do tanque original.
Um veículo de menor autonomia ainda pode guardar a base. Esse critério simples evita
mandar o scout à frente enquanto dois blindados ficam atrás; não estima sozinho
blindagem, alcance ou vantagem contra cada arma. Serviços automáticos na base podem
suspender brevemente a reunião. Controle manual, logística e outros trabalhos
não são apropriados pela operação.

| Fase | Ordem normal e critério de saída |
| --- | --- |
| Preparar | Repor a força e chamar o reconhecimento de volta. |
| Reunir | Mover os dois excedentes até 250 m à frente; esperar chegada e serviços. |
| Avançar | Mover até 220 m antes da posição conhecida da base. Em alvos próximos, esses recuos ficam limitados a um terço da distância. |
| Combater | Atacar um contato armado atual; o piloto resolve aproximação e balística. |
| Ocupar | Mover ao centro e limitar perseguição; as regras normais decidem a captura. |
| Retornar | Voltar à base após captura confirmada, perda de propósito ou retirada; esperar terminar o estacionamento. |

A preparação tem até 1.200 s. Na saída, o prazo inclui mais 1.200 s para combate
e a viagem de ida e volta a metade da velocidade mecânica máxima da dupla,
limitado a duas horas desde o início da preparação. É uma margem de planejamento,
não uma previsão da velocidade no terreno. O prazo de saída não se renova por
troca de fase ou retomada. Mudança observada do objetivo, ameaça na própria base,
perda do guarda, dano, munição ou combustível insuficientes encerram a investida.
O retorno tem até 300 s adicionais; o fim da memória não teleporta nem
recupera veículos presos. Há 600 s de espera antes de outra operação contra
a mesma facção. Nenhum desses limites muda alcance, tração, proteção ou
tempo de captura. Capturar segue a regra atual: derruba a base adversária e
registra a conquista; não transfere a base nem cria uma instalação nova ali.
Um serviço temporário em um sobrevivente fora da base suspende sua ordem de
retorno, sem declarar a operação concluída. Retirada também pode sofrer perdas;
uma ordem de Voltar não prova que o veículo conseguiu chegar.

O save mantém o estado discriminado da operação e o prazo em segundos do
mundo. Saves anteriores sem esse campo começam sem missão; estados explícitos
malformados são recusados. O diário foi atualizado porque a estratégia mudou;
replays visuais preparados anteriormente continuam utilizáveis no cache.

## Preencher população em um campo público

`IMPACTO_AI_MIN_PLAYERS=4` habilita um piso de criação no servidor normal,
com `IMPACTO_SAVE_DIR` absoluto e explícito. A opção é desligada por ausência;
aceita de zero até a capacidade humana de [room-limits](../server/room-limits.ts).
O leitor recusa combinar esse modo com testes, ensaio ou stress, antes de
alterar pastas. Habilitar IA não libera ferramentas, fabricação instantânea
ou ajuste de velocidade aos clientes.

O worker conta jogadores humanos conectados e IAs ativas. Após um minuto e
um passo físico, avalia a população a cada minuto e cria no máximo uma facção
por avaliação, até **quatro identidades de IA**. Cada uma recebe somente o kit
normal de uma facção nova, usa o perfil `balanced` e paga os preços comuns.
Reiniciar adia a primeira avaliação; não adianta concessões.

Esse piso não é um limite total: humanos que chegam mantêm suas vagas e as
IAs existentes continuam no campo. Nenhuma facção humana é assumida. Não se
apaga patrimônio, pausa uma IA automaticamente ou cria outra identidade para
substituir uma derrotada. Pausas explícitas contam no teto e permanecem
pausadas. A opção `0` permite retomar o campo e impede novas criações; não
desliga as estratégias já salvas. Retirar a opção de um campo com IAs recusa
a abertura, preservando o checkpoint.

Criações passam pelo `FieldHost` e ficam no diário. O agendamento operacional
não faz parte da política nem roda no replay: são os eventos gravados que
recriam as identidades. Membros, ranking e veículos mostram **IA** ou
**IA pausada**, também em inglês, sem inventar conexão de socket. O teto de
quatro limita o crescimento; o custo junto de um servidor humano lotado ainda
precisa de medição antes de ampliar esse número.

## Persistência e comparação

O checkpoint conserva identidade, memória e cadência no relógio do mundo.
Criação e pausa/retomada são eventos do diário; decisões internas são
recalculadas no replay e não são registradas uma segunda vez como comandos
externos. O formato atual é 32; 31 conserva o duelo e recebe a lista de reparos
adiados vazia. Antes da primeira gravação atual, seu checkpoint é preservado em
`field.before-economy-save31-<hash>.json`. O formato 29 é lido
sem controladores; no primeiro salvamento é preservada uma cópia exata em
`field.before-commanders-save29-<hash>.json`. Outros contratos históricos
continuam seguindo as conversões explícitas do projeto.
Mudanças da estratégia avançam `DIARY` (atualmente 57) em [field-host](../server/field-host.ts):
cada diário deve ser reproduzido pela versão que o gravou. Os replays visuais
já preparados continuam no cache. A versão da rede está em
[network-protocol](../src/network-protocol.ts), incluindo a identificação tipada
de IA. O checkpoint 30 conserva as mesmas identidades e
memória, sem renovar o kit, inclusive o prazo de uma interceptação em curso.

```powershell
$env:IMPACTO_DYNAMICS_RUNTIME = 'native'
npm run review:commanders -- --scenario opening --seconds 3600 --verify-repeat --out validation/commander-20261103/openings.json
```

O runner aceita `opening`, `depleted`, `loss`, `competition`, `activities`, as
famílias `arena-normal`, `arena-frontier`, `arena-compact` ou um identificador
de cenário. Parte do kit normal, deixa a física avançar e não dá
ordens de coleta, construção ou transporte por fora do comandante. A perda
controlada do minerador aos 900 s, a perda do cargueiro após descarregar e as
reservas inicialmente esgotadas ficam identificadas
como condições do experimento. A repetição compara resultados completos.

A corrida econômica troca os perfis entre as mesmas posições de entrada. Isso
separa posição e estratégia, mas não qualifica combate entre bases. Entregas
são medidas no descarregamento real; estoque, carga, obras e capital são
separados. O critério de progresso inclui entrega recente de Ferro: ter uma
mina e um caminhão parados não demonstra economia autônoma.

Casos mantidos: visão limitada, decisões e reservas, passagem móvel/fixa,
incursão real, retomada, replay, migração e worker sem clientes. Os resultados
e limites da rodada ficam em [balanceamento](balanceamento.md), sem transformar
uma abertura de uma hora em garantia para todos os mapas ou sessões longas.

O [registro da primeira rodada, de 02/11](../validation/commander-20261102/verification.json)
aponta os oito relatórios de nove cenários, repetidos integralmente, e os
recortes finais de testes. Onze balanços de Ferro fecharam com residual máximo
de `5,46 × 10⁻¹¹`. O caso esgotado conserva renda, mas fica abaixo do marco de
melhoria na primeira hora; essa limitação não é classificada como sucesso de
progressão.

## Continuação de 03/11

As três correções seguintes mantêm as mesmas ordens, equipamentos e preços:
reconhecer planta e cargueiro como renda após perder o minerador móvel;
permitir reposição paga da cisterna quando o combustível está baixo; recolher
o defensor que explorava antes de comprar outra resposta à ameaça local.

A regressão Native acompanha a incursão real e a autoria dos disparos. O scout
inicial recebe **Voltar à base** aos 90 s e chega aos 134 s; a resposta armada
da facção começa aos 148 s, contra 445 s antes. Nessa geometria, dois aliados
interceptam a linha do primeiro scout; outro veículo dispara com solução
viável. Retornar não autoriza ignorar a linha de tiro ou a região de manobra.

Os controles de duas horas mantêm renda nos últimos dez minutos, com o kit
normal. Um cenário separado usa orçamento inicial restrito: 30.000 Fe,
10.000 Ligas, 10.000 Sílica e 250 L, mais as três unidades iniciais normais.
Ele não recebe recursos durante a simulação. A cisterna custa 29.688 Fe,
787 Sílica e 203 L, sendo comprada aos 5 s; o primeiro Petróleo é entregue
aos 667,23 s. Esse caso valida abastecimento, sem exigir Oficina II na hora.

Os arquivos de `validation/commander-20261103/` distinguem controles anteriores,
cenários atuais, orçamento restrito e diagnósticos de combate. A memória e as
identidades de um checkpoint anterior com mais de cinco horas também retomaram
na nova política, sem duplicar controladores ou registrar falhas Native.

O [registro desta continuação](../validation/commander-20261103/verification.json)
reúne seis relatórios repetidos sem divergência e um ensaio adicional de três
horas, não repetido. No último, o minerador móvel foi perdido aos 2.541,05 s;
a planta e o cargueiro mantiveram renda e financiaram um IFV aos 8.975 s, pelo
preço normal, sem reconstruir o minerador. O controle de duas horas manteve
exatamente comandos, estado final, memória e digest da política anterior.

## Comparar quatro facções no mesmo campo

Cada arena tem duas instâncias `balanced` e duas `cautious`, com estoques,
kit, visão e física normais. Não são quatro estratégias diferentes. A troca
ABBA/BAAB distribui cada perfil pelas quatro posições; na fronteira e no
diagnóstico compacto, a segunda disposição também inverte a ordem de entrada.
Depois de criar as facções, somente os comandantes emitem suas ordens.

```powershell
$env:IMPACTO_DYNAMICS_RUNTIME = 'native'
npm run review:commanders -- --scenario arena-normal --seconds 3600 --out validation/commander-20261103/arena/normal.json
npm run review:commanders -- --scenario arena-frontier --seconds 3600 --out validation/commander-20261103/arena/frontier.json
npm run review:commanders -- --scenario arena-compact --seconds 300 --verify-repeat --out validation/commander-20261103/arena/compact.json
```

`normal` conserva a fundação automática. `frontier` fixa somente as posições
iniciais em −14.800, −4.800, 5.200 e 15.200 m, sem mudar terreno ou jazidas.
As bases ficam a 10 km, sem sobreposição territorial, mas as rotas podem
compartilhar fontes e cruzar outras bases. `compact` aproxima as bases a
cerca de 1,6 km: provoca encontros rápidos, porém a sobreposição territorial
restringe obras. Serve para diagnosticar combate, sem avaliar a progressão
normal das instalações.

O relatório separa entregas físicas, caixa, capital, perdas, disparos e
disputas de jazidas; não calcula um vencedor por uma soma arbitrária. Ordens
para a mesma fonte não demonstram extração simultânea. Disparos são um mínimo
amostrado a 1 Hz: uma substituição por reparo completo pode zerar o contador
entre amostras. Os eventos Native atribuem somente dano primário de integridade
dos componentes, sem totalizar blindagem, incêndio ou explosões; contatos em
várias camadas não são tiros distintos. As perdas pertencem à facção vítima,
sem atribuir um abate por proximidade. O balanço simples de Ferro fica sem
avaliação quando combate ou serviços exigem contabilidade adicional.

As arenas aceleram a execução mantendo passos de 1/60 s. O campo interativo
continua no ritmo normal. Um único mapa e duas disposições não calibram a
dificuldade nem sustentam uma classificação geral dos perfis.

O [registro da evolução militar e operação pública](../validation/commander-20261103/operations/verification.json)
separa controle econômico, missão física preparada, retomada, correção de
cooldown e permissões públicas. O caso Native de rota comprova envio e retorno
com guarda preservado; não teve disparos nem demonstra eficácia em combate.

## Gravar e avaliar combates

```powershell
$env:IMPACTO_DYNAMICS_RUNTIME = 'native'
npm run review:commander-combat -- --seconds 600 --out validation/commander-combat-20261103
```

O runner cria campos separados, sem abrir ou alterar saves em uso. `--scenario`
aceita `incursion`, `arena-a`, `arena-b`, `capture`, `duel`, `duel-b`, `supply`,
`operations` ou `all`.
O padrão `combat` conserva os três primeiros casos. A saída deve ser uma pasta
dedicada dentro de `validation`; capturas existentes não são sobrescritas.

A incursão usa uma IA na base e um scout inimigo com duas ordens iniciais normais:
Fogo livre e Mover até a base. A defesa recebe somente decisões do comandante.
As arenas usam quatro IAs, trocando perfis e ordem de entrada entre as mesmas
posições próximas. Depois da criação, todas as ordens das arenas são autônomas.
São diagnósticos de encontro e reação; a sobreposição territorial não serve para
avaliar progressão normal ou declarar um perfil vencedor.

Estoque, kit, neblina, munição, serviços e física permanecem normais. A execução
avança sem esperar o relógio real, mantendo passos de 1/60 s. `result.json` separa
disparos, contato entre componentes, perda amostrada de integridade e veículos
fora de ação. `firstSeenAt` indica o primeiro encontro com outra facção, não a
detecção de um alvo específico. As mesmas limitações de autoria e dano das
arenas acima continuam valendo.

Cada caso inclui um diário Native com snapshot inicial e pode ser aberto no
[visualizador](replay-viewer.md). A validação compara os prints e a quantidade de
eventos de disparo entre a simulação e os quadros exportados. Campos só com IAs
continuam descartando os eventos normalmente; o observador os lê antes disso.

`capture` e `duel` começam com bases em −1.800 e +1.800 m, Oficina II e capital
declarado igual: 400.000 Ferro, 10.000 Ligas, 10.000 Sílica e 4.000 L refinados.
Conservam o kit inicial de três veículos, preços, tempos, munição, terreno e
física. Não avaliam quanto demora alcançar esse capital numa partida normal.
Em `capture`, o scout do alvo recebe apenas Segurar fogo; todas as decisões
do atacante são autônomas. Em `duel`, ambos os lados têm comandante ativo.
O relatório distingue captura, conclusão com retorno físico e limite de tempo;
um confronto sem captura não é apresentado como vitória.

### Validação da operação terrestre em 03/11/2026

Os três [resultados e replays integrais](../validation/commander-operations-20261103/prepared.json)
preservam todos os capítulos, com física Native a 60 Hz:

| Cenário | Duração e encerramento | Resultado observado |
| --- | --- | --- |
| Defesa com estoque inicial normal | 10 min, limite de tempo | Primeiro tiro aos 91,4 s; 114 disparos defensivos e 301 de dano primário recebido. O invasor foi imobilizado antes de alcançar a base; o construtor foi perdido. |
| Captura com capital e Oficina II declarados | 24 min 56 s, objetivo e retorno | Reconhecimento neutralizou a defesa; reunião e avanço de dois veículos com guarda preservado; captura aos 19 min 38 s e ambos de volta à base, com estacionamento concluído. |
| Duas IAs ativas com esse mesmo capital | 30 min, limite de tempo | 316 disparos e seis veículos fora de ação; as preparações foram canceladas e nenhuma base caiu. Não comprova capacidade de vencer uma defesa ativa. |

No mesmo diagnóstico de incursão anterior, o primeiro tiro defensivo ocorreu
aos 147,2 s e o dano primário recebido foi 1.184,7. São medidas desse encontro,
não uma classificação de dificuldade ou garantia para outros terrenos.
Os registros distinguem a simulação completa dos ensaios anteriores que revelaram
encosta intransponível, restrição excessiva de visão e interrupção por serviço.

Os testes puros cobrem fases, autoridade, inteligência, reservas, guarda,
recusas com cooldown e memória retomada; a integração Native mantém movimento,
defesa, interceptação, serviços, diário e reprodução de disparos. O antigo
segundo teste Native de defesa pressupunha uma exploração que a abertura atual
não produz: foi consolidado no caso físico de defesa e nas verificações de
interrupção e retorno existentes, sem fabricar uma saída do scout no teste.

### Continuação: suprimentos e composição da força

Os [replays e condições completos](../validation/commander-sustain-20261103/prepared.json)
usam a mesma física, os mesmos preços e o capital declarado do ensaio anterior.
Os dois duelos têm 40 minutos simulados e invertem os perfis `balanced` e
`cautious` entre as posições, sem alterar equipamentos ou conceder recursos
durante o campo.

- Na disposição original, a força passou por reunião, avanço, combate e ocupação.
  A defesa recompôs sua posição armada, os atacantes foram perdidos e não houve
  captura. Houve nova preparação; veículos presos na encosta impediram outra
  saída antes do limite de tempo.
- Com os perfis trocados, uma IA capturou a base de outra IA ativa aos 25 min 21 s.
  Os dois blindados voltaram, estacionaram e receberam os serviços normais aos
  30 min 40 s. O campo continuou até 40 min, com reconstrução da facção derrotada.
- O controle de captura contra o scout em Segurar fogo conservou a conclusão
  com retorno: 25 min 06 s. Esse controle não substitui o duelo entre IAs ativas.

O cenário `supply` isola a recuperação de material: uma IA em −4.200 m, Oficina II,
kit normal e estoque declarado de 150.000 Ferro, 10.000 Ligas, 1.000 Sílica e
3.000 L de combustível. A jazida, a visão, a extração, o transporte e o refino
seguem as regras normais; não há oponentes nem créditos durante o teste.
Com o mesmo minerador, a IA coletou Sílica, pagou a cisterna e o IFV, retomou
Ferro e concluiu a fabricação aos 4 min 51 s. O caixa restante foi 49.155 Ferro,
10.000 Ligas, 3.064 Sílica e 2.591 L, acima da reserva. O cenário termina por
esse objetivo e não mede o tempo de progressão de uma abertura normal.

Isso não classifica os perfis nem torna a vitória garantida: acesso ao petróleo,
encostas, reconstrução da defesa e perdas de renda mudam o resultado. A capacidade
nominal de integridade serve para compor a força; ainda não há escolha de arma
por tipo de fortificação. Cada troca de fase do runner agora registra somente
o estoque, as unidades e as ameaças que aquele comandante conhecia, para permitir
investigar uma interrupção sem reconstruir hipóteses a partir do estado final.

Validação em [commander-sustain](../validation/commander-sustain-20261103/verification.json):
84 testes relevantes em Native, tipagem, traduções, build e conferência integral
dos replays. O diário estratégico desse ensaio é a versão 31; saves frios continuam
compatíveis e os replays visuais já preparados permanecem no cache.

### Partida pela interface do jogador

O [ensaio interativo de 03/11/2026](../validation/commander-player-20261103/verification.json)
usa um jogador sem comandante contra uma IA `balanced`, nas mesmas posições,
com Oficina II, capital declarado de 400.000 Ferro, 10.000 Ligas, 10.000 Sílica
e 4.000 L por lado e o kit normal. As decisões do jogador foram dadas pela
interface, com neblina: coleta, compras, posturas, movimento, condução direta e
retorno. O painel de testes serviu somente para alternar o relógio entre 1× e
8×; sua lista global de construções não foi usada para escolher alvos. Não houve
disparo manual. A IA começou 47,2 s antes da conexão do jogador; o replay inclui
esse intervalo. Não é uma medição de dificuldade ou da progressão inicial.

A IA pressionou a coleta e destruiu a viatura, o minerador e o construtor do
jogador. Dois IFVs sobreviveram à defesa e contra-atacaram; o jogador pagou outro
IFV para guardar a base e um minerador para retomar a renda. A captura ocorreu
aos 28 min 34 s, seguida pelo retorno físico dos dois atacantes e pelos serviços
normais. A IA reconstruiu uma base distante. O
[replay integral](../validation/commander-player-20261103/prepared.json) tem nove
capítulos, até 43 min 12 s de relógio do campo, quando o ensaio foi encerrado
após o objetivo. O diário confirma 2.592 prints Native; a cauda de 0,5 s sem
print posterior fica fora da reprodução verificada.

A inspeção interna ocorreu depois de encerrar o campo. Aos 25 min, o blindado
de reposição `c12` estava com integridade e munição completas, mas parado em
`stuck-slope`, em x ≈ 2.626 m, cerca de 826 m da própria base. Essa força não
estava disponível para contestar a ocupação. Essa observação motivou a recuperação
limitada e a avaliação de disponibilidade descritas acima; o ensaio não justifica
alterar a física das encostas.

O ensaio também revelou marcadores de perda repetidos no início dos capítulos:
40 marcações representam dez destroços distintos. A auditoria conta cada ator
uma vez; os quadros e os prints Native foram conferidos integralmente. O registro
separa essa pendência de apresentação das perdas físicas e dos dois veículos
desmontados na captura.

### Retorno bloqueado e comparação controlada em 03/11/2026

A [validação da correção](../validation/commander-recovery-20261103/verification.json)
repete os mesmos comandos, instantes de entrada e relógio do jogador contra o
comandante atualizado, com as condições iniciais do ensaio interativo. É uma
comparação com decisões gravadas, sem adaptação posterior do jogador, recursos
gratuitos ou alterações na física. Publicações pagas recebem os identificadores
reais da nova partida. O campo original e o servidor ativo foram preservados.

Ambas as bases permaneceram ocupadas pelas facções originais até o limite de
43 min 12 s. Isso demonstra a resposta a esse ataque, sem calibrar dificuldade
ou garantir vitória. O replay integral reúne nove capítulos e confere os prints
Native. Os testes de regressão cobrem também retorno fracassado sem repetição,
guarda em serviço, ordens protegidas e prazo de encerramento de operações.

O gravador passa a registrar destroços presentes no início de um capítulo como
estado inicial, sem emitir novas perdas. Uma morte posterior continua sendo
marcada, inclusive após voltar a um checkpoint em que o ator estava vivo. Para
o ensaio interativo anterior, uma cópia corrige somente os marcadores a partir
dos quadros já verificados: dez perdas, com os mesmos 51.849 quadros e 2.592
prints. O arquivo original permanece disponível. O diário estratégico daquele
ensaio era a versão 32; o formato visual, o protocolo e o formato de saves não mudaram.

### Ensaio interativo até a primeira captura

O [ensaio de finalização](../validation/commander-finish-20261103/verification.json)
volta às mesmas condições iniciais, com a IA atualizada e decisões novas do
jogador pela interface e com neblina. Foram pagos três blindados e três
porta-morteiros; um blindado ficou na base, enquanto os demais avançaram em
etapas, com os morteiros atrás. A viatura inicial foi perdida. O minerador
recebeu uma rota somente após a jazida ser descoberta. O relógio alternou entre
1× e 8×; nenhum recurso, reparo ou deslocamento foi concedido por teste.

A primeira captura ocorreu aos 38 min 27 s: o jogador tomou a base da IA.
O ensaio foi encerrado após a confirmação, com replay integral até 41 min 16 s,
em nove capítulos. A reconstrução distante da IA faz parte da gravação; a
condição de término deste ensaio é a primeira captura, não eliminar uma facção
do campo persistente. A política ficou congelada durante toda a partida.

A defesa atacou e repôs blindados, mas o apoio indireto e a perda da renda
esgotaram sua resposta. Aos 30 min não havia defensor armado disponível, e
restavam 1.216 de Sílica após repor um construtor, abaixo dos 1.572 de um IFV.
Aos 35 min havia 82.427 Ferro, mas a mesma falta de Sílica. Esse caso motivou
reservar os materiais de reposição militar antes de compras civis durante um
cerco e diversificar a resposta ao fogo indireto. Não justifica alterar a física
nem serve como uma medição de dificuldade.

A partida também reproduziu uma falha de apresentação: uma espera automática
sem tarefa mantinha uma rota do esquadrão, e o painel exigia um tipo de tarefa
para mostrar o estado. O painel agora só acrescenta distância de obra quando
existe uma tarefa de construção em deslocamento; o estado de espera continua
visível. A regressão preserva os trajetos de construção e os demais serviços.

### Ciclos de partidas completas

O [registro dos ciclos](../validation/commander-loop-20261103/loop.json) reúne
condições, versões, hipóteses e replays integrais. A política fica congelada
durante a partida e sua reconstrução. A inspeção interna ocorre só depois de
encerrar o campo; até a primeira captura ou perda, o jogador decide pela
interface normal, com neblina. As partidas variam a abordagem e não formam uma
taxa de vitória calibrada.

A [primeira verificação](../validation/commander-loop-20261103/iteration-01/verification.json)
registrou resposta medida de contrabateria, mas também gasto repetido em
artilharia e saída da guarda para explorar. A
[segunda verificação](../validation/commander-loop-20261103/iteration-02/verification.json)
confirmou a guarda preservada e uma operação terrestre contra o jogador; a
captura ocorreu após esgotar a Sílica e perder a defesa para fogo indireto.
Os critérios econômicos e as propostas de posicionamento descritos acima
respondem a essas falhas. Os saves e gravações anteriores permanecem preservados.

A [terceira verificação](../validation/commander-loop-20261103/iteration-03/verification.json)
usa estoques normais, Oficina I e bases a 10 km. Expôs a preferência indevida
pela última guarda na abertura e o conflito entre defesa local e retirada de
rotina, ambos cobertos por regressão. A captura aos 75 min 04 s só avançou após
rearmar: a presença no chão, sozinha, não substitui uma arma abastecida.

A [quarta verificação](../validation/commander-loop-20261103/iteration-04/verification.json)
é um intervalo parcial: nenhuma base principal foi tomada, mesmo após três
auxílios normais de recuperação do jogador, somando 83.834 Ferro. O replay cobre
9 h 47 min 05 s, com 118 capítulos, 35.225 prints Native e 704.618 quadros
conferidos. As duas estruturas fixas também aparecem e podem ser localizadas
no visualizador. Foram contados 6.637 disparos primários e vinte destroços,
sem marcações repetidas; isso não transforma o intervalo em partida concluída.

Esse intervalo revelou dois limites artificiais da operação: distância máxima
de 6 km e validade de 600 s para uma base fixa já conhecida. A operação passou
a usar velocidade e autonomia próprias, reserva de combustível e prazo fixo,
sem alterar a física. A comparação dos checkpoints é um diagnóstico de decisão,
não uma vitória simulada com a nova política.

A [quinta verificação](../validation/commander-loop-20261103/iteration-05/verification.json)
repete as bases a 10 km com capital declarado de 400.000 Ferro e Oficina II.
O jogador pagou seus projetos e reformas, sem auxílio de recuperação, e tomou
a base aos 224 min 39 s. O replay integral chega a 227 min 10 s: 46 capítulos,
13.630 prints Native, 272.646 quadros e 2.867 disparos primários conferidos.
A recuperação distante da IA faz parte da cópia; não é eliminação permanente.

A produção fixa de Sílica e a viagem longa do único minerador de Ferro deixaram
estoques desequilibrados. Além disso, a exploração ainda aplicava os antigos
600 s à base que a operação já conservava como conhecida. A versão 38 compartilha
essa regra de conhecimento e compara as propostas de mineração admitidas pela
cobertura de materiais da próxima compra e da reserva. Segurança, posicionamento
e transporte continuam exigidos. São correções de decisão; a sexta partida
interativa valida seu efeito, sem inferir vitória dos testes.

A [sexta verificação](../validation/commander-loop-20261103/iteration-06/verification.json)
confirmou a escolha inicial de Ferro pela nova regra. A captura ocorreu aos
217 min 48 s; a cópia integral chega a 220 min 09 s, em 45 capítulos, com
13.209 prints Native, 264.225 quadros e 1.352 disparos primários conferidos.
As duas minas fixas aparecem no visualizador. O último defensor disparou 189
vezes; checkpoints silenciosos não comprovam uma falha de percepção.

O cargueiro sobrevivente perdeu a capacidade de carga, teve a rota Native
cancelada e conservou a intenção estratégica de transporte. Ficou parado
fora da base, apesar de ainda poder dirigir. Na versão 39, esse caso retorna
para reparo normal: exige intenção própria de transporte, falha de capacidade,
ausência de deslocamento ou serviço ativo e mobilidade funcional. Carga cheia
ainda válida, ordem manual e retorno existente mantêm sua prioridade. Em um
diagnóstico Native do checkpoint congelado, o retorno comum restaurou carga
e escavação em seis minutos e retomou entregas de Sílica; a continuação sem
essa ordem permaneceu parada por trinta minutos. Isso comprova o fluxo de
reparo, não prevê o resultado de outra partida. A regressão e os 159 testes
relacionados ativos passaram, com uma fixture histórica explicitamente pulada.

A [sétima verificação](../validation/commander-loop-20261103/iteration-07/verification.json)
usa os estoques iniciais normais, Oficina I e bases a 3,6 km. O jogador tomou
a base aos 46 min 53 s, usando somente modelos prontos e serviços pagos.
O replay integral cobre 50 minutos, 11 capítulos, 3.000 prints Native e
60.011 quadros, com 6.447 disparos primários e seis destroços distintos.

A exceção para o único batedor procurar recursos na abertura ainda podia
reabrir depois dos combates, quando os contatos desapareciam e nenhuma base
adversária havia sido localizada. A versão 40 exige que os sobreviventes não
tenham histórico próprio de combate para essa exceção. Isso usa os registros
já existentes, sem outro timer ou estado persistente. Veículos de apoio ociosos
e batedores com uma guarda de reserva continuam podendo explorar.

Há limites distintos ainda em aberto: o último defensor teve um aliado na linha
de tiro em um checkpoint Native, e a manutenção sob bombardeio consumiu o Ferro
disponível. A conferência física registra 108 disparos desse defensor, antes
de perder a arma; não é um defeito de percepção. Formação, reposicionamento
e prioridade de reparos merecem outra revisão causal, sem eliminar a proteção
de aliados, a perda de energia em blindagem ou o custo normal de manutenção.


A [oitava verificação](../validation/commander-loop-20261103/iteration-08/verification.json)
inverte o lado do jogador, usa estoques normais, Oficina I e perfil cauteloso.
O primeiro ataque com três viaturas falhou. O jogador depois pagou um morteiro,
reformou o construtor ocioso em outro e tomou a base com uma viatura de reposição
aos 62 min 45 s. A cópia integral cobre 67 min 21 s: 14 capítulos, 4.041 prints
Native, 80.834 quadros e 3.647 disparos primários, sendo 716 da IA.

As guardas conservaram a defesa nas pausas de combate. Isso é cobertura compatível
com a versão 40, não prova causal de que a exceção corrigida mudou o resultado.
A economia perdeu minerador e construtor; os 2.443 Ferro restantes não pagavam
outro minerador. O retorno do minerador antes da perda foi uma interrupção normal
por perigo, não uma falha demonstrada de navegação. Recuperação econômica com
capital existente e prioridade de manutenção continuam hipóteses separadas.


A [nona verificação](../validation/commander-loop-20261103/iteration-09/verification.json)
mantém a versão 40, com capital igual de 400.000 Ferro, Oficina II e bases a
3,6 km. A IA lançou dois blindados, preservou uma guarda e destruiu o minerador
e o construtor do jogador. O jogador repôs a logística por preços normais e
contra-atacou com dois blindados; a primeira captura ocorreu aos 85 min 13 s.
A cópia integral cobre 87 min 09 s, 18 capítulos, 5.229 prints Native e
104.598 quadros, incluindo a recuperação normal posterior da IA.

O Ferro continuou chegando, mas faltou Sílica para repor blindados. Aos 50
minutos nenhuma jazida de Sílica era conhecida; a encontrada depois ficava
a mais de 10 km da base. Economia e formação continuam frentes de investigação,
sem alterar custos, proteção física ou conhecimento da facção. Uma hipótese de
travamento foi descartada: a trajetória completa revela viagens de ida e volta,
enquanto as amostras a cada cinco minutos coincidiam com o mesmo trecho.
Não houve mudança de produção para essa hipótese.


## Duelo com resultado definitivo

O campo persistente continua permitindo recuperação. Uma disputa entre duas
facções pode chamar `room.startDuel()` depois de estabelecer ambas as bases.
A regra vale daquele instante em diante; uma captura antiga não decide o duelo.
Participantes e diplomacia ficam fixos durante essa disputa. A próxima tomada
da base principal registra vitória e derrota; duas capturas concluídas na
mesma avaliação do chão resultam em empate, sem prioridade pela ordem das facções.

O resultado encerra ordens e controles, bloqueia novas ações e recuperação e
fica no save 31. O servidor confirma a próxima impressão Native, em até um
segundo de efeitos físicos finais, e pausa o campo. Reconectar ou reiniciar
mostra o mesmo resultado. A interface e o replay mostram vitória, derrota ou
empate em português e inglês. O duelo é ativado pelo criador do campo; não
transforma automaticamente um servidor persistente em partida eliminatória.

A continuação do ciclo 9 parte dos 5.229 s já verificados, com a IA recuperada.
Os capítulos originais são preservados, e a continuação usa diário 41, rede 87
e Core82. A política estratégica da IA é a mesma da versão 40. Como o intervalo
anterior já foi analisado, esta continuação não mede dificuldade às cegas.

A continuação terminou com vitória definitiva do jogador aos 11.753,033 s.
O host parou nos 11.754 s e preservou o resultado ao reiniciar. O replay
completo reúne 40 capítulos e 235.120 quadros Native, incluindo a captura
anterior e a recuperação. As provas e condições estão em
`validation/commander-loop-20261103/iteration-09-continuation-01/verification.json`.
Depois de preservar a exportação, a revisão visual removeu ações contextuais
de destroços e de obras no fim do duelo e manteve o resultado do replay visível
também no layout estreito. A política estratégica continua sendo a versão 40.

## Oito duelos adicionais de 04/11/2026

A [rodada integral](../validation/commander-eight-duels-20261104/results.md)
terminou os oito duelos por captura efetiva, com sete vitórias do jogador e
uma da IA. São 15 h 49 min 34 s simuladas, 193 capítulos e 1.139.673 quadros
Native verificados. A política evoluiu de 43 a 46 entre partidas: alcance
físico de contrabateria, prioridade de recuperar mineração e distinção entre
carga e extração efetiva por material. A versão final passou em 90 testes
focados, tipagem, traduções e build. Condições, limitações, replays completos
e hipóteses restantes ficam no relatório, sem duplicar seus registros aqui.

A [comparação econômica do duelo 8](../validation/commander-economy-20261104/results-pressure.md)
reutiliza suas ordens gravadas nos diários 47–49. A versão final recuperou
destroços, retomou mineração e concluiu a captura em 2h03min47s. As tentativas
anteriores, os limites parciais e os quatro replays integrais estão no relatório.
Os 114 testes Native do comandante passaram; o adversário gravado não adapta
suas decisões, portanto essa comparação não estima taxa de vitória.

A [rodada de rotas e continuidade de combate](../validation/commander-adaptation-20261105/results.md)
concluiu dois duelos no diário 52 e preservou seus replays integrais. A conferência
pós-jogo encontrou um recuo estratégico que não conservava a fonte interrompida;
o diário 53 corrige esse caminho e foi comparado no checkpoint real. Recuperação
de carga presa no terreno e escolha de variantes militares continuam pendentes.

A [rodada de recuperação e produção](../validation/commander-recovery-designs-20261105/results.md)
adicionou descarga parcial, distinção de capacidade presa, uma proposta protegida
de 20 mm e reserva para a próxima compra antes da Oficina II. Três duelos completos
e 148 regressões passaram pela conferência. O jogador venceu os três; aquisição
de alvos e posicionamento ainda limitam o combate, e o resgate físico de um casco
vazio sem verba de reposição continua pendente. O relatório separa esses limites
das decisões efetivamente exercitadas.

Na aproximação de combate, a força troca o destino distante por um ponto a
até 200 m do contato atual, do lado da própria base. Um deslocamento já escolhido
só é revisto quando o contato anda mais de 150 m. O veículo de maior durabilidade
segue à frente e o apoio mantém até 180 m adicionais de distância, com ordens
individuais e a mesma memória de destino; focar o alvo continua sendo
uma ordem separada e a física conserva a decisão de atirar. Com guarda funcional,
a força que já está entre atacante e base pode interceptá-lo. Uma lacuna de visão
após uma ordem de combate confirmada tolera até 15 s, usando o histórico salvo,
sem renovar o prazo ao esperar. Captura real da base, perda da guarda, danos,
munição, combustível, serviços e prazo da missão continuam interrompendo a saída.

O piloto mantém a avaliação conservadora de um tiro individual. Para metralhadora
ou canhão automático, uma observação visual atual, visível e com confiança de pelo
menos 0,5 também pode justificar fogo pelo retorno esperado de até seis projéteis
disponíveis em um segundo. Essa alternativa exige pelo menos 0,3 acertos esperados;
não serve para contatos de radar, som, memória ou baixa confiança. É um critério
de decisão, não uma mudança de dispersão ou cadência: trajetória, montagem, servo,
munição, terreno, próprio casco e segurança de explosões continuam sendo admitidos
pelas mesmas regras. A consulta não recebe a blindagem ou a saúde oculta do alvo.

A [rodada de aquisição e continuidade](../validation/commander-acquisition-20261105/results.md)
concluiu dois duelos nos diários 56 e 57, com replays integrais verificados.
O jogador venceu ambos; no segundo, o canhão da IA disparou 27 vezes e houve
uma perda de blindado do jogador. Formação diante de aliados, resposta ao
bombardeio e recuperação da mineração continuam oportunidades. O relatório
separa os confrontos reais das consultas frias e dos testes de regressão.

Uma defesa funcional já paga na base, mesmo em montagem ou serviço, impede
que a falta temporária de prontidão consuma outra compra enquanto a mineração
precisa de reposição. Isso não autoriza o veículo a sair durante o serviço.
Sob dano recente e um informe de disparo dos últimos 15 s, um defensor móvel
pode trocar de posição dentro da base. O histórico aplicado preserva essa
posição por 30 s, sem novas reservas ou temporizadores; controle manual,
serviços e ordens de ataque continuam tendo prioridade. O informe anônimo
não identifica um atirador nem autoriza persegui-lo.

A [validação de formação, bombardeio e economia](../validation/commander-formation-20261105/results.md)
concluiu dois duelos no diário 58. O primeiro registrou três evasões sob
bombardeio; a formação passou nas regressões dos dois sentidos, mas não houve
operação ofensiva nesses duelos. A reposição de mineração foi comprada por vias
normais na segunda partida. A reserva durante montagem não resolve o consumo
de Ferro por reforços e reparos enquanto a rota está bloqueada; o relatório
preserva esse limite e os dois replays integrais.
