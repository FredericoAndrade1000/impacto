# Balanceamento do Impacto

Revisão de 02/11/2026 para o campo persistente. Este documento reúne as regras
atuais, a evidência disponível e as hipóteses que precisam de partidas.
[Game Design](game-design.md) descreve a experiência; o
[mapa de manutenção](maintenance-map.md) indica onde alterar cada fluxo.
Os valores executáveis permanecem no código. As tabelas abaixo são fotografias
desta revisão, sem criar outro catálogo de configuração.

## Diretriz: preservar a física

Massa, inércia, tração, potência, empuxo, consumo, recuo, balística, blindagem
e propagação de calor continuam determinados pela simulação Native.
Uma instalação libera capacidade de fabricar; não multiplica dano, resistência,
velocidade ou eficiência do equipamento.

Ajustes de equilíbrio começam por orçamento, aquisição, materiais, logística,
acesso a recursos, requisitos de fabricação e recompensas. Uma divergência
física reproduzida deve ser corrigida na própria regra, com um caso que demonstre
o problema. A comparação usa projetos admitidos pelo compilador, carga real,
combustível finito e as mesmas condições para ambos os lados.

Registrar separadamente: **regra conferida no código**, **resultado medido** e
**hipótese de design**. Um ensaio técnico ou uma estimativa de financiamento
não demonstra equilíbrio PvP nem calibração física no mundo real.

## 1. Início e recuperação

Regra atual em [room](../server/room.ts), [economia](../src/economy.ts) e
[instalações](industrial-progression.md):

- Cada identidade nova recebe uma única provisão na primeira facção: 90 mil
  Ferro, 10 mil Ligas, 10 mil Sílica e 1.500 L, além de minerador, scout e
  construtor prontos. Reconexão, saída, expulsão e nova facção não repetem o kit.
- A primeira base é gratuita, com Oficina I e Processamento I; sem Hangar.
  O sorteio compara os locais válidos pelo pior acesso relativo a Ferro,
  Petróleo, Ligas e Sílica, usando alvos de 1/2/5/5 km. Esses alvos orientam
  a escolha; não garantem uma distância máxima. Espaços internos e externos
  são comparados, mantendo os afastamentos normais entre bases.
- Ferro e Petróleo utilizáveis são identificados na fundação. As outras
  jazidas fora do levantamento inicial continuam dependendo de exploração.
  A indicação prefere reserva disponível ou uma pilha pronta significativa;
  quando todo um recurso está esgotado, conserva a fonte real que se regenera.
- Sem nenhuma construção em campo, o auxílio cobre somente a falta para a
  base necessária, um minerador do catálogo com tanque cheio e mais dois tanques
  em estoque. Estoque e pátio refinável entram na conta. Outro subsídio positivo
  espera 30 minutos do campo; o histórico acompanha todos os beneficiários.
- Reconstruir a base custa 25% do estoque inicial de cada recurso. A escolha
  e a indicação de recursos usam a mesma política da fundação, afastada das
  bases atuais e da que foi perdida. Bases existentes não são reposicionadas
  na retomada de um save.
- Recuperação paga preserva o intervalo do último subsídio. Projetos pessoais
  sobrevivem à derrota; a capacidade industrial recomeça básica.

**Resultado:** ciclos de troca de facção não repetiram provisão nem auxílio.
A rodada de acesso abaixo qualificou primeiras entregas de Ferro e Petróleo
em posições favoráveis, medianas e distantes da amostra. O próximo controle
inclui concorrência, jazidas esgotadas e rotas difíceis; custo e tempo da primeira
missão útil continuam distintos do preço nominal de comprar uma melhoria.

## 2. Economia, logística e serviços

As autoridades são [economia](../src/economy.ts),
[jazidas](../src/deposits.ts), [despacho](../server/supply-dispatch.ts) e
[serviços](automatic-services.md).

| Etapa | Regra atual |
| --- | --- |
| Extração | Escavadeira de referência: 50 kg/s; perfuratriz: 10 L/s. Ritmo por tamanho e potência realmente disponível; sem combustível a ferramenta para. |
| Jazida | Reserva central de 60 mil unidades, crescendo até 3× nas extremidades. Recuperação uniforme em 2 h do campo; abaixo de mil unidades é apresentada como vazia. |
| Carga pronta | Transferência de 250 unidades/s por transportador, respeitando alcance, recipientes e volume; não extrai novamente a reserva. |
| Refino | Base: 1.000 unidades/s compartilhadas entre materiais; posto: 250. Sólidos 1:1; Petróleo rende 0,8 de combustível. |
| Suprimentos | Recursos refinados transportados fisicamente. Combustível entregue continua refinado, sem aplicar rendimento de petróleo outra vez. |
| Atendimento | Construção apoiada no solo, parada e fora de combate; reparo é pago e ocupa tempo. Controle manual na base permite reparo com pedais e gatilho liberados. |
| Automático | Usa informação conhecida da facção e capacidade real. Ordens manuais têm prioridade; Parar desliga o automático. Segurança depende de ameaça percebida e alcance. |

A jazida central recompõe 30 mil unidades/h. Instalar mais escavadeiras não
multiplica esse limite sustentado. Aumentar extração pode apenas esgotar mais
cedo a reserva acumulada. O ensaio de financiamento com três mineradores e uma
cisterna estimou todas as instalações em 13,4 h para viagens de 1,5 km e
33,1 h para 5 km, mantendo os mesmos preços. São cenários fluidos com velocidade
média suposta de 8 m/s, descoberta e conflitos omitidos, não renda medida.

A [comparação móvel/fixa](#continuação-mineração-móvelfixa-e-logística) mede
frotas pagas com orçamento e horizonte iguais, incluindo obra, viagens,
escassez e perda de um transportador. Não mede a abertura de um jogador novo
nem o valor da mobilidade para trocar de jazida.

## 3. Fabricação e melhorias

[Catálogo](../src/industry.ts), [exemplos](../src/industry-examples.ts) e
[transações](../server/industry.ts) compartilham os mesmos requisitos Native.
As funções econômicas, estradas e contramedidas básicas cabem no nível inicial.
Projetar e testar continua gratuito; fabricar exige capacidade concluída.

Uma melhoria por base, com pagamento integral no início. Primeiros níveis
levam 120 s; seguintes, 240 s. Cancelar devolve o pagamento uma vez e perde o
progresso. A montagem usa tempo simulado, sem avançar com o servidor desligado.
A massa de admissão é vazia; carga, combustível e munição continuam aumentando
a massa física real durante a operação.

Aberturas calculadas pela cotação real de **substituir o scout intacto**,
preservando minerador e construtor:

| Instalação + transformação | Ferro | Ligas | Sílica | Combustível | Caixa inicial |
| --- | ---: | ---: | ---: | ---: | --- |
| Oficina II + M119 leve | 83.882 | 2.000 | 3.000 | 300 L | Cabe |
| Oficina II + IFV | 109.094 | 2.000 | 3.281 | 300 L | Faltam 19.094 Fe |
| Hangar I + reconhecimento aéreo pronto | 49.020 | 17.600 | 4.236 | 413 L | Faltam 7.600 Ligas |
| Processamento II + scout HHA | 52.268 | 4.000 | 5.000 | 200 L | Cabe |

As três instalações iniciais isoladas cabem no caixa. Portanto, “primeira
compra em 20–40 min” não descreve o sistema atual. A primeira **missão útil**
e sua operação precisam ser medidas separadamente. No cenário otimista com um
minerador, Ligas conhecidas a 1,5 km e sem perdas, Hangar I + aeronave adicional
foram financiados em cerca de 26,8 min, incluindo só a fabricação da unidade.

O diagnóstico inclui agora os seis níveis compráveis e cobra todos os níveis
anteriores da mesma instalação ao comparar a partir da base básica. A reposição
da unidade preserva o investimento industrial já concluído. A interface mostra
o custo incremental da melhoria selecionada e uma unidade, com esse escopo.

**Hipóteses:** Oficina II deve competir com ampliar a frota básica; Hangar deve
oferecer reconhecimento/transporte que justifique aquisição e combustível;
Processamento deve justificar massa/encaixe/proteção na missão. HHA poupou
cerca de 760 kg frente ao controle de aço mais espesso e custou mais 1.186 Fe
por unidade, além da instalação. Isso exige benefício operacional demonstrado,
não promete retorno financeiro por volume nem equivalência balística.

## 4. Combate e reconhecimento

[Native](../native/dynamics/src/game_pilot.rs) decide percepção, mira e disparo;
[Squad](../src/squad.ts) conduz e reposiciona. Fogo livre permite perseguição
local de até 120 m; deslocamento e trabalho ordenados têm prioridade.
Câmera, radar e escuta fornecem informações diferentes; alcance nominal não
garante identificação através do terreno.

Construções da própria facção e de facções diretamente aliadas são protegidas
de projéteis, fragmentos e explosões de companheiros; o autor continua
vulnerável ao próprio disparo. A proteção não elimina o material que consome
a perfuração. Aliança não compartilha estoque ou controle de veículos.

**Comparar:** conjuntos com orçamento igual, posições alternadas, terreno
aberto/coberto, ambas as direções e múltiplas condições de combate. Incluir
scout, 20 mm, AT4, morteiro e defesas iniciais contra opções avançadas.
Medir detecção, tempo para inutilizar, munição gasta, perdas, reparo e retorno.
Um duelo isolado ou espessura × resistência não comprova equivalência.
Os ensaios desta rodada verificam regras; o confronto entre formações permanece
uma hipótese a experimentar com jogadores.

## 5. Território, recompensas e derrota

[Território](../src/territory.ts), [captura](../server/room.ts) e
[airdrop](../server/world-activities.ts):

- Território: 5 km de cada lado da base, mais 2 km por posto; até quatro postos,
  separados 1,5 km. Atendimento: base ±100 m, posto ±50 m. Postos servem/refinam,
  sem liberar fabricação industrial. Um posto custa 22.500 Fe + 2.500 Ligas +
  2.500 Sílica e depende de obra e local válido.
- Captura: 300 s na base, 120 s no posto; armado, operacional e com apoio Native.
  Defensor apto ou múltiplas facções atacantes contestam. Abandono regride 1:1.
  Base nova não tem carência. Aeronave pousada pode participar; pairando não.
- Base derrotada liquida frota, obras, postos e capital industrial pago, inclusive
  melhoria pendente. Saque: 25% do excedente de cada estoque acima do pacote
  inicial e 25% de cada matéria-prima; transferências arredondadas para baixo.
  A vencedora não recebe os níveis industriais. Níveis concedidos sem pagamento
  não criam material para resgatar.
- Posto capturado perde o capital recuperável do dono anterior; o estoque geral
  não é saqueado. O pátio volta refinado ao dono anterior; o posto troca de lado
  com pátio vazio e sem valor de desmontagem concedido ao captor.
- Airdrop: primeiro sorteio após 12 h do campo, aviso de 1 h, coleta por 8 h,
  intervalo configurado de 12 h. Carga: 48 mil Fe, 16 mil Ligas, 12 mil Sílica,
  4 mil L. Local depende da visão/ocupação atuais e a sentinela existe desde
  o anúncio. Transporte exige módulo compatível, deslocamento e risco.

**Hipóteses:** ganho de mais território não deve tornar a recuperação inviável;
um airdrop não deve financiar progressão desproporcional para quem já tem
mobilidade. Comparar recompensa líquida após escolta, combustível, transporte
e perdas. Verificar também facção distante, local sem posição válida e coleta
interrompida; o relógio é do servidor, não uma recompensa diária pessoal.

## 6. Multiplayer e persistência

Limites atuais: 32 jogadores conectados; 12 veículos e 32 fixos por facção,
compartilhados pelos membros. Identidade nova recebe kit próprio; entrar em
outra facção não transfere automaticamente o patrimônio da origem. Comércio
aceito transfere estoques imediatamente, sem transporte. É uma abstração
econômica atual, distinta da carga física em veículos.

Proteção offline exige todos ausentes por 120 s e 120 s sem combate, em paralelo;
captura em andamento impede ativação. Dura até sete dias simulados desde a última
saída e termina ao entrar um membro. Cobre construções apoiadas na base/postos,
sem disparar protegidas. Retorno automático continua vulnerável no percurso.
Ordens, pagamentos e capital persistem; servidor desligado não produz tempo.

O ranking é informativo: estoque, pátio refinável, cargas, valor recuperável de
peças, obras, montes, postos e capital industrial pago, cada quantidade uma vez.
Valor patrimonial não representa força de combate nem vitória.

**Hipóteses:** comparar facção solo, cooperativa e veterana contra iniciante;
membros novos, horários diferentes e alianças com visão compartilhada.
Múltiplas identidades e doações continuam um risco de design: limites por conexão
não comprovam uma identidade por pessoa. Trocas legítimas de facção e auxílios
mantêm seus testes de conservação, sem penalidade física escondida ao veterano.

## Resultado técnico desta rodada

- Corrigido serviço no ápice de um salto: velocidade baixa e modo terrestre
  permitiam abastecer ainda no ar. Serviços, trabalho parado, captura e proteção
  agora reutilizam apoio Native; a aterrissagem normal restaura o atendimento.
- Corrigido patrimônio de postos: concluir o posto retirava 27.500 pontos do
  ranking apesar de manter capital recuperável. A contagem acompanha posto,
  desmontagem e monte sem duplicação; posto capturado continua com capital zero.
- Orçamentos de abertura atualizados para as aeronaves prontas e os seis níveis,
  incluindo pré-requisitos. Custos e parâmetros físicos foram preservados.

Artefatos locais em `validation/balance-review-20261102/`: `openings.json`,
`economy.json`, `missions-grounded.json`, `placements.json` e logs de testes.
Os arquivos registram condições e fonte Native. Saves e servidor público
permanecem fora destes ensaios.

Validação: 288 casos distintos passaram no Native (310 execuções em dois
recortes com sobreposição), sete casos de apoio/patrimônio/indústria no Wasm,
12 missões repetidas, checagem TypeScript/traduções e build. Os testes novos
reproduziram as duas falhas antes das correções. O build mantém o aviso conhecido
de tamanho dos chunks. Não houve ensaio PvP entre formações nesta rodada.

### Continuação: acesso inicial aos recursos

A política antiga escolhia o primeiro ponto sorteado com Ferro próximo; o
fallback contava tipos próximos, sem comparar a distância do recurso que faltava.
Priorizar apenas Ferro/Petróleo no mesmo algoritmo melhorou a mediana do
combustível, mas manteve extremos acima de 12 km. A política atual compara o
pior acesso relativo e usa a soma das distâncias relativas como desempate.
Não move jazidas, aumenta reservas ou altera a física.

A amostra usa o mapa atual, 20 fundações em cada uma de três sequências de sorteio.
Cada política recebe as mesmas sequências iniciais, mas suas decisões mudam as
bases concorrentes seguintes. Não são pares de rotas com todas as demais bases
idênticas nem 60 mapas independentes.

| Recurso | Mediana anterior → atual | Máximo anterior → atual |
| --- | --- | --- |
| Ferro | 454 → 640 m | 2,4 → 1,8 km |
| Petróleo | 3,5 → 1,6 km | 13,6 → 7,3 km |
| Ligas | 3,2 → 3,1 km | 6,6 → 9,3 km |
| Sílica | 4,6 → 4,3 km | 20,1 → 10,9 km |

Posições com Petróleo além de 5 km caíram de 24 para 3 das 60. A orientação
inicial passou de 47 fontes de Petróleo desconhecidas para nenhuma nesta amostra.
O extremo de Ligas piorou; a política prioriza sustentar a operação e não deixa
todas as especializações igualmente perto.

`npm run review:resources -- --verify-repeat --out validation/resource-access.json`
usa os pontos favorável/mediano/distante de Ferro e Petróleo e executa a primeira
coleta e entrega. O minerador vem do kit; a cisterna é fabricada e paga com o
caixa inicial, incluindo seu tempo normal de montagem. Pilotos, carga, terreno,
combustível finito, abastecimento e refino são os do jogo.

- Ferro: primeira carga de cerca de 3,32 t entregue em 2,0–6,7 min.
- Petróleo: cerca de 4.428 L entregues em 9,0–22,7 min, incluindo 66 s de montagem
  da cisterna. O refino usa o rendimento normal de 0,8.
- Os seis cenários completaram sem falhas Native. A repetição confere horários,
  carga, massa e estoques; os custos de operação são separados da compra.
- No relatório histórico desta rodada, o custo de combustível incluía o
  arredondamento por atendimento e não media só a queima física. A continuação
  abaixo reproduziu e corrigiu esse problema.

A indicação de uma fonte esgotada também foi corrigida: uma pilha de 1 unidade
não substitui uma fonte com produção; uma pilha real utilizável pode atender
mesmo com a reserva vazia. A indicação não restaura minério, combustível ou
veículos. Fundar e recuperar compartilham essa regra.

Artefatos: `validation/resource-access-20261102/`, incluindo políticas de controle,
`openings-final.json`, `first-deliveries-final.json` e logs.
Validação desta continuação: 221 casos distintos no Native, sete no Wasm,
os seis cenários de entrega repetidos com resultado idêntico, TypeScript,
traduções e build aprovados. O aviso conhecido de chunks grandes permanece.
O diagnóstico de fundações fica em `review:industry:openings`, campo
`foundations`, compartilhado com `review:resources`.
Os trajetos usam uma facção isolada no ponto amostrado, sem os demais postos,
frotas ou inimigos. Não qualificam todas as 60 rotas, outros terrenos ou um
mundo antigo disputado. Distância em x continua sem garantir transitabilidade.

### Continuação: mundo ocupado, esgotamento e abastecimento

`npm run review:resources -- --occupied --verify-repeat --out validation/occupied.json`
acrescenta oito facções já fundadas, com suas frotas normais, antes da nova
facção. Um minerador antigo recebe uma coleta normal. Os cenários de
esgotamento zeram apenas as reservas geológicas iniciais; não criam pilhas,
créditos ou combustível. A regeneração avança pelos passos normais do campo.

| Cenário | Primeira entrega desde a entrada/recuperação |
| --- | --- |
| Petróleo, mundo ocupado sem esgotamento | 10,8 min, incluindo fabricação da cisterna |
| Ferro, fontes até 5 km das bases antigas esgotadas | 3,9 min |
| Ferro, todas as fontes inicialmente esgotadas | 2,7 min, incluindo 83 s de espera por regeneração |
| Ferro, reconstrução após derrota e todas as fontes esgotadas | 4,9 min, incluindo 59 s de espera por regeneração |

As primeiras cargas dos dois últimos casos são parciais: cerca de 0,63 t e
2,52 t. O quarto cenário usa o comando real de recuperação e seu auxílio normal;
a derrota concluída e o consumo dos estoques são condições iniciais declaradas,
sem reproduzir o combate anterior. As outras frotas existem fisicamente, mas
não representam oito jogadores ativos nem uma disputa PvP. São quatro casos
no mapa atual, não uma garantia para todo relevo, posição ou histórico do campo.

No abastecimento, dez reposições de 0,6 L cobravam 10 L; uma reposição de 6 L
cobrava 6 L. Além disso, repor munição podia completar um déficit de 0,25 L
sem estoque de combustível, e o fornecedor ignorava menos de 1 L da própria
carga. A cotação e o débito agora acompanham os litros realmente transferidos,
inclusive frações e estoques insuficientes. Não há combustível gratuito, dívida
ou sobretaxa por frequência de atendimento. Munição continua por cartucho;
compras, reparos e lotes de carga conservam suas regras. Contas pequenas de
combustível aparecem com até três casas em português e inglês.

Os ensaios mantêm os pilotos, consumo, carga, refino e física Native. O custo
de combustível separa o arredondamento da compra da cisterna e inclui estoques,
tanques, suprimentos e rendimento do pátio; mede a facção ensaiada, não as
concorrentes. Artefatos e logs desta continuação ficam em
`validation/occupied-resources-20261102/`.
Os dez cenários (seis isolados e quatro ocupados) repetiram com resultados
idênticos e sem falhas Native. A suíte completa terminou com 4.629 testes
aprovados, nenhuma falha e um caso histórico que exige o build físico Core50;
cinco regressões de abastecimento/textos também passaram no Wasm. Tipos,
traduções, build e `git diff --check` aprovados. O aviso conhecido de chunks
grandes permanece; a fonte Native não mudou nesta continuação.

### Continuação: mineração móvel/fixa e logística

`npm run review:mining -- --verify-repeat` usa uma hora de simulação e o mesmo
caixa: 150 mil Ferro, 10 mil Ligas, 10 mil Sílica e 3.000 L. Sem kit concedido,
com instalações básicas e fabricação normal. Ambos compram um construtor;
o móvel compra dois mineradores, e o fixo um posto de mineração e dois
caminhões. Os caminhões aguardam a conclusão do posto na base antes da ordem
de coleta; o despacho automático permanece ativo depois dessa ordem.

O conjunto móvel custa 112.333 Ferro, 3.414 Sílica e 609 L; o fixo, 111.638
Ferro, 5.654 Sílica e 812 L. Esses são investimentos, não renda da mineração.
Reservas no solo, pilha pública, carga em trânsito, suprimentos a bordo,
estoque/pátio e perdas de destroços são contabilizados separadamente.

| Cenário | Móvel entregue em 1 h | Fixo entregue em 1 h | Primeira entrega móvel / fixo |
| --- | --- | --- | --- |
| 500 m | 78,2 t | 90,6 t | 3,7 / 9,3 min |
| 1.500 m | 73,0 t | 88,3 t | 6,4 / 13,7 min |
| 4.000 m | 26,5 t | 81,6 t | 13,5 / 25,9 min |
| 1.500 m, reserva inicial de 1 t | 2,0 t | 31,1 t | 5,7 / 11,4 min |
| 1.500 m, perda de um transportador aos 15 min | 43,1 t | 88,1 t | 6,4 / 13,7 min |

O fixo paga sua implantação mais lenta com caminhões maiores e extração
contínua; não aumenta a regeneração da jazida. Nos cenários com reserva cheia,
o consumo foi de 44–96 L no móvel e 85–134 L no fixo. Por tonelada entregue,
500 m favoreceram o móvel (0,56 contra 0,93 L/t); 4 km favoreceram o fixo
(1,65 contra 3,62 L/t do móvel). Não há alteração de potência, carga, tração
ou consumo Native para produzir esses resultados.

Na escassez, a ordem móvel encerra quando a fonte esvazia, sem novo comando;
o produtor fixo continua extraindo a regeneração. Os cargueiros automáticos
fazem muitas viagens parciais: 38 entregas na hora, frequentemente perto de
0,67 t, consumindo cerca de 128 L no conjunto. A diferença de produção não é
uma multiplicação da capacidade física da ferramenta. O teste também não
explora a opção do móvel de procurar outra jazida.

A perda é uma condição declarada, sem simular a batalha: o móvel perdeu um
veículo carregado e o fixo um caminhão vazio. São exposições diferentes;
isso não qualifica sobrevivência PvP. Os cerca de 200 L que desapareceram com
cada destroço expirado aparecem como perda, separados da queima dos motores.

O complemento `--scenario middle --carriers 1 --verify-repeat` mediu a frota
menor desde o início: o fixo entregou 88,1 t com um caminhão, contra 88,3 t
com dois. O investimento caiu para 87.788 Ferro, 4.867 Sílica e 609 L; o
consumo caiu de 104,8 para 81,5 L. Nesse percurso o segundo caminhão estava
sobrando. O móvel com um único minerador entregou 36,5 t. Dimensionar a frota
importa mais que alterar o preço de todas as peças a partir de um caso.

Uma sonda de tráfego reproduzível usa `--scenario near --strategy fixed
--seconds 900 --early-haul --verify-repeat`: os caminhões enviados antes da
montagem ocupam o acesso; a obra permanece sem material e o construtor informa
`waiting-place`. O automático respeita essas ordens manuais. Melhorar a
orientação ao jogador sobre o acesso é uma frente distinta da produtividade;
a ajuda de espera foi esclarecida em português/inglês para indicar que
veículos parados bloqueando o caminho devem ser afastados.

Essa revisão também corrigiu um bloqueio de serviço: na base sem combustível,
um fornecedor não podia usar a própria carga para abastecer seu tanque.
O estoque da base mantém prioridade e, esgotado, permite esse atendimento próprio.
Artefatos e logs: `validation/mining-logistics-20261102/`.
Os 12 casos econômicos e a sonda de tráfego repetiram com resultado idêntico,
sem falhas Native. A rota de 500 m também repetiu igual após a correção do
estoque vazio; os casos econômicos conservam os três materiais e mantêm
combustível no estoque. A suíte completa passou com 4.630 testes, zero falhas
e um teste histórico dependente do Core50 não executado. Três regressões de
abastecimento também passaram no Wasm; após esclarecer a ajuda, 90 testes de
interface, contratos e idioma passaram. Tipos, traduções e build aprovados;
o aviso conhecido de chunks grandes permanece.

Os pares usam a mesma jazida real e o mesmo percurso por cenário, com terreno
conhecido e sem inimigos. Entre distâncias, o relevo e o sentido de aproximação
também mudam. São evidências de rotas escolhidas, não uma curva universal por
distância, teste de primeira melhoria ou qualificação de sessões longas.
Preços permanecem iguais; os dados não justificam um multiplicador artificial
de produção ou uma mudança precipitada de custo.

## Comandante de base: economia e defesa local

O [comandante experimental](faction-commander.md) usa decisões determinísticas
no servidor e os comandos comuns da facção. Aberturas Native partiram do kit
normal, neblina ligada e sem ordens fornecidas pelo runner. Os cenários de uma
hora comparam repetição integral de decisões, movimentos, estoques e memória.
Ferro abaixo significa material realmente descarregado, não saldo final nem
reserva encontrada no mapa.

| Hipótese/cenário | Resultado observado e implicação |
| --- | --- |
| Aberturas nas sementes 7, 1234 e 987654 | Primeira entrega de Ferro em 112–165 s, Petróleo em 631–667 s; Oficina II em 19,3–27 min. Entregas de 66,35–90,09 t de Ferro e 26.568 L de Petróleo em uma hora. A expansão fixa começa mais tarde nas sementes 7/987654; ao final seus cargueiros já carregam, ainda sem concluir essa primeira viagem. |
| Perder o minerador inicial aos 900 s | Reposição paga com o saldo normal, renda retomada, 85,15 t entregues e Oficina II em 39,4 min. O destroço mantém as regras comuns. |
| Perder o cargueiro após a primeira entrega da mina fixa | Caixa natural de 32.097 Fe: paga o caminhão de 23.850 Fe, mas não caminhão mais reserva de 53.405 Fe. Compra do substituto cerca de 4 s depois; nova entrega 114,5 s após a perda. 90,05 t no total. O minerador móvel estacionado não pode mascarar a ausência desse transporte. |
| Todas as reservas naturais inicialmente esgotadas | A regeneração normal sustenta 28,90 t de Ferro e 22.140 L de Petróleo. A IA conserva renda e reserva; não melhora a Oficina dentro da hora. Faltam 348 Fe para melhoria mais reserva, portanto esse cenário não passa o marco completo de progressão. |
| Corrida econômica, trocando `balanced`/`cautious` entre as posições | As duas facções mantêm renda e melhoram a Oficina. Os resultados acompanham a posição; as diferenças de perfil não foram determinantes nessa abertura. Não há vencedor estratégico qualificado nem torneio de combate. |
| Inicialização normal com atividades do host | A economia funciona com a agenda persistente. O primeiro airdrop só está previsto para 43.200 s; uma hora não exercita sua sentinela. |
| Incursão controlada com scout normal, sem reposicionar ou reabastecer | A defesa dispara 10 vezes e reduz a soma de integridade do invasor de 725 para 102,32, respeitando a âncora local. É um caso de resposta real, não uma medida geral de força ou rapidez defensiva. |

A simulação reproduziu um bloqueio na conversão móvel/fixa: a coleta antiga
reservava a boca e o construtor vazio permanecia junto da planta. O comandante
agora libera a intenção de extração conflitante, preserva o retorno com carga e
manda o construtor livre voltar à base depois da obra. No controle da semente
1234, a entrega passou de 66,35 t estagnadas para 90,09 t, com descarga até o
fim. Também foi corrigida a reposição obrigatória do cargueiro usando a reserva.
Essas mudanças coordenam ordens existentes; não mudam produção, preços, apoio,
tração, consumo ou combate.

Os registros ficam em `validation/commander-20261102/`, com fontes, runner e
Native identificados por hash. A verificação final distingue os relatórios
atuais dos diagnósticos anteriores. O saldo de Ferro é conferido contra renda,
veículos, capital industrial e obras; combustível, carga e destroços são
registrados separadamente. Verificação de visão limitada, migração, retomada,
replay e execução sem clientes complementam os ensaios econômicos.
O [registro final](../validation/commander-20261102/verification.json) reúne os
nove cenários repetidos sem divergência e os onze balanços avaliados. A suíte
completa passou com 4.660 testes e um histórico ignorado; os recortes finais
após o acabamento passaram com 31 casos Native, 22 Wasm (mais um exclusivo de
Native ignorado) e 23 de replay/worker. Os recortes se sobrepõem. Tipos,
traduções e build passaram; permanece o aviso conhecido de chunks grandes.

Limites: não foram calibradas invasões coordenadas, escolha de projetos novos,
progressão completa de todas as instalações, sentinelas depois de 12 h ou
sessões com jogadores humanos atacando simultaneamente. O campo público
continua sem criar essas facções por padrão.

### Continuação do comandante — 03/11

Três decisões foram corrigidas sem alterar preços, produção ou física: renda
fixa passa a habilitar reposição do construtor, melhoria e defesa após perder o
minerador móvel; a falta urgente de combustível permite comprar cisterna com a
reserva; uma ameaça conhecida perto da base recolhe a exploração de um defensor.

O [registro da rodada](../validation/commander-20261103/verification.json)
mantém controles anteriores e novos separados. Seis relatórios repetiram
exatamente; o ensaio adicional de progressão por três horas teve uma execução.
São 23 horas de campo simulado contando as repetições, com sete balanços de
Ferro avaliados e residual máximo de `1,17 × 10⁻¹⁰`.

| Caso | Evidência e limite |
| --- | --- |
| Controle 1234 por duas horas | Política nova conserva exatamente comandos, estado final, memória e digest: 120.026,53 kg de Fe e 53.136 L de Petróleo. Mais 4.938,39 kg de Fe foram entregues nos últimos dez minutos. |
| Perda do móvel depois da primeira descarga da planta | Em duas horas repetidas, a planta e o cargueiro mantêm o mesmo fluxo do controle, sem refazer o minerador. Em três horas, compram IFV aos 8.975 s por 71.157 Fe / 1.572 Si / 203 L e o põem em Fogo livre aos 9.130 s. Este último ensaio não foi repetido. |
| Cisterna perdida depois de entregar | Compra paga aos 670 s, nova entrega aos 1.329,03 s. Havia 1.283 L no momento da perda; esse cenário confirma reposição, não a exceção de emergência. |
| Início com orçamento restrito | 30.000 Fe / 10.000 Ligas / 10.000 Sílica / 250 L, mais o kit inicial normal. Compra de cisterna aos 5 s e Petróleo aos 667,23 s. Em uma hora, entrega 87.970 kg de Fe e 26.568 L de Petróleo, sem dívida ou recursos adicionais durante a simulação. Não exige Oficina II nesse horizonte. |
| Incursão local | Scout inicial recebe retorno aos 90 s, antes de comprar outro aos 95 s; chega aos 134 s. A primeira resposta armada da facção passa de 445 s para 148 s. No cenário de 600 s, o invasor termina com soma de integridade 33,94, partindo de 725. |

A ausência de IFV ao final das duas horas era coerente com a reserva: sua
invoice de 71.157 Fe cabe nos 85.773,53 Fe, mas ainda faltam 14.938,47 Fe para
também preservar os 29.555 Fe do minerador. O ensaio de três horas esperou o
caixa natural; não reduziu essa margem para forçar uma publicação.

Na incursão, dois aliados bloqueiam o tiro do scout recolhido, e o inimigo fica
146 m da sua âncora, fora dos 120 m de manobra. Outro defensor responde com uma
solução válida. O teste exige retorno armado e resposta/dano reais da facção;
não obriga um veículo sem solução a disparar. Visão, blindagem e perseguição
local continuam com as regras comuns.

A suíte Native passou com 4.670 testes, zero falhas e um conversor histórico
ignorado. O recorte Wasm passou com 35 e três casos exclusivos de Native
ignorados. Tipos, traduções, build e retomada de checkpoint anterior com mais
de cinco horas passaram. O diário foi para 26; o campo JSON permanece 30.

## Arenas com quatro facções — 03/11/2026

O [registro comparativo](../validation/commander-20261103/arena/comparison.json)
reúne quatro campos de uma hora e dois diagnósticos de cinco minutos, com duas
instâncias `balanced` e duas `cautious` por campo. Os diagnósticos curtos foram
repetidos integralmente; os campos longos não. Todos usam Native a 60 Hz,
semente 1234, visão limitada, kit e estoques normais. A troca ABBA/BAAB cobre
as quatro posições; fronteira e compacto também invertem a ordem de entrada.
Somente os comandantes emitem ordens depois da criação.

| Condição | Resultado dos dois arranjos | O que demonstra |
| --- | --- | --- |
| Fundação automática normal, quatro bases | 8/8 chegaram à Oficina II e entregaram Ferro nos últimos dez minutos. Cada posição manteve exatamente entregas, compras, estoques e marcos ao trocar o perfil. Ferro de 33,18 a 96,54 t; Petróleo de 22.140 a 30.997 L por facção. | Economia autônoma em diferentes posições. Sem contato visual registrado, disparos ou perdas nessa hora. |
| Fronteira: bases a 10 km, sem sobreposição territorial | 8/8 chegaram à Oficina II e mantiveram renda recente de Ferro. Ferro de 46,44 a 102,63 t; Petróleo de 4.428 a 22.141 L. Cada arranjo teve dois intervalos de ordens para fontes compartilhadas, mas nenhuma extração/carga simultânea amostrada. | Economia com rotas iniciais concorrentes e desvio para outras fontes. Não houve pressão militar observada. |
| Compacto: bases a cerca de 1,6 km, cinco minutos | A: pelo menos 323 disparos amostrados e quatro perdas. B: pelo menos 328 disparos e três perdas. Ambos repetiram exatamente, com dano primário Native atribuído entre facções. | Combate real e resposta local. A sobreposição territorial restringe obras e impede usar esse diagnóstico para classificar a progressão normal. |

Na fronteira, a cisterna da posição −14.800 abandona a rota inicial para
`petroleo:-4` e depois busca outra fonte; a de 15.200 também troca
`petroleo:12`. A primeira entrega de Petróleo pode levar 53 minutos. A posição
−4.800 não entregou Petróleo nos últimos dez minutos, embora tivesse estoque
e renda recente de Ferro. Portanto, os oito sucessos não significam uma
entrega recente de cada material.

A maior diferença de Ferro entre os arranjos de fronteira foi 102,63 contra
84,74 t na posição −14.800. Perfil e ordem de entrada mudaram juntos; essa
diferença não isola a contribuição da política. No compacto, a posição 800
concentrou os disparos nos dois arranjos, com perfis diferentes, enquanto a
posição 2.200 perdeu três unidades em ambos. Não há vencedor geral de perfil
qualificado por essa amostra.

Os 16 balanços de Ferro dos campos longos fecharam, com residual máximo de
`1,24 × 10⁻¹⁰`. Nos compactos, combate e serviços deixam o balanço simples sem
avaliação. Disparos são um mínimo amostrado; dano primário de componentes não
totaliza blindagem, fogo ou explosões. Perdas são da vítima, sem inferir o
autor de um abate. O mapa único e o horizonte não exercitam conquistas,
campanhas longas ou airdrops.

Tipos, traduções e verificação de diferenças passaram. Esta rodada amplia o
runner e a documentação; a política e o núcleo físico permanecem iguais.
Os resultados indicam que o próximo avanço militar exige uma escolha explícita
de objetivos e risco: os perfis atuais cuidam da economia e defesa local e
podem evitar o conflito ao descobrir uma rota insegura.

## Proteção de rotas e população — continuação de 03/11

A estratégia econômica permanece separada da missão militar limitada e da
criação operacional de facções. O controle Native de uma hora com quatro IAs
na fundação normal conservou exatamente entregas, compras, estoques e marcos
do arranjo A anterior. As quatro facções mantiveram renda e Oficina II, sem
recusas ou falhas; o balanço de Ferro fechou com residual máximo de
`4,37 × 10⁻¹¹`. Este controle não foi repetido e não teve combate.

O ensaio de interceptação prepara uma força com uma compra normal de Scout
(22.063 Fe, 1.291 Sílica e 203 L) e reconhecimento físico seguido de retorno.
Essa preparação é explícita: não valida a escolha autônoma de produzir ou
mapear. Depois, somente o comandante controla sua facção, e o oponente cruza
o terreno com seu kit finito normal.

Na rota reconhecida, o comandante enviou um defensor aos 820 s; ele percorreu
701 m, deixando o outro na base. Perder o contato após a retirada da cisterna
levou a Voltar aos 860 s, com retorno concluído aos 923 s. Não houve disparos,
foco de ataque ou dano nesse cenário; o inimigo conservou 725 de integridade.
A evidência demonstra deslocamento, guarda e retirada, sem qualificá-la como
vitória militar. Os ensaios anteriores em terreno ainda não conhecido não
ofereceram a janela exigida de contato junto ao chão e dois defensores prontos.
Essa limitação permanece explícita.

O modo público é opcional, limitado a quatro identidades e uma criação por
minuto. O piso de criação considera humanos conectados, preserva pausas e não
repõe kits após derrotas. Uma conexão real ao campo local confirmou quatro
IAs identificadas no ranking, kit humano normal, IDs de facções desconhecidas
ocultos e recusa das ferramentas de teste. Isso verifica a fronteira pública;
o custo com vinte humanos simultâneos ainda não foi medido.

As evidências desta continuação ficam em
`validation/commander-20261103/operations/`, separadas das arenas anteriores.
O campo continua em 30, o diário passa a 27 e a rede a 86. Ver
[regras, operação e limites](faction-commander.md).

O [registro de validação](../validation/commander-20261103/operations/verification.json)
separa as etapas e seus hashes. A suíte geral Native passou com 4.688 casos e
um conversor histórico ignorado. A revisão final encontrou uma espera que
podia ser contornada ao mover o alvo: a intenção agora usa sua identidade,
independentemente da posição e do defensor. Após essa correção isolada, foram
revalidados 81 casos Native e 74 Wasm, com quatro exclusivos de Native
ignorados no Wasm. Tipos, traduções, dependências e build passaram. O controle
econômico precede essa última correção e não exercita interceptações.

## Roteiro proposto dos primeiros testes

1. Ampliar início e abastecimento para outros relevos e concorrência ativa.
   As primeiras entregas isoladas, os quatro casos ocupados/esgotados e a
   recuperação controlada estão ensaiados; acompanhar o extremo de Ligas e a
   exploração necessária antes de uma especialização.
2. Ampliar a comparação móvel/fixa: valor de mudar de jazida, escolha do tamanho
   da frota, reabastecimento prolongado e carga parcial versus urgência da entrega.
   Os pares de uma hora estão medidos; a primeira missão e o ritmo das instalações
   ainda precisam de abertura real com o kit e o orçamento iniciais.
3. Comparar formações básicas/avançadas, captura e recuperação com perdas reais.
4. Repetir em multiplayer e após ausência/retomada, registrando recursos e
   intervenções. Manter as regras que já estão coerentes.

Para cada hipótese registrar cenário, objetivo, resultado esperado/observado,
recurso limitante, custo operacional e próximo ajuste. Alterar uma regra por
experimento. Prioridade: falha reproduzida → economia sustentável → utilidade
da primeira melhoria → confronto e recuperação → sessões com jogadores.
A rodada técnica está feita; preços finais e ritmo em partidas seguem abertos.

## Referências iniciais para armas e blindagens

Investigação sugerida pelo jogador, com consulta inicial em 19 de outubro de 2026. Os valores atuais servem de referência durante o estudo. As primeiras fontes permitem estruturar a comparação; a calibração do catálogo completo ainda precisa de dados equivalentes e validação em combate.

No catálogo consultado, os custos-base dos presets são: MAG 1.800 cr, M2HB 4.000 cr, M242 15.000 cr e Rh120 36.000 cr, em [weapons.ts](../src/weapons.ts). O cálculo em [game_cost.rs](../native/dynamics/src/game_cost.rs) acrescenta montagem e sua blindagem e contabiliza os suprimentos separadamente. A blindagem é cobrada pela massa física multiplicada pelo coeficiente do material. Em [game_damage.rs](../native/dynamics/src/game_damage.rs), os coeficientes atuais incluem aço 1,4, aço de alta dureza 2,6, alumínio 3,2, cerâmica 6 e titânio 12 cr/kg. Esses números são preços de jogo.

| Referência primária | Dado consultado | Aplicação no estudo |
| --- | --- | --- |
| [Exército dos EUA, PB 2025, linha M2A1, coluna FY 2024](https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2025/Base%20Budget/Procurement/Procurement-of-Weapons-and-Tracked-Combat-Vehicles.pdf) | 424 unidades e US$ 3,420 milhões; custo bruto unitário publicado de aproximadamente US$ 8.066. | Referência para a família M2; verificar os componentes incluídos e a diferença entre M2A1 e M2HB. |
| [Exército dos EUA, PB 2025, linha M240, coluna FY 2024](https://www.asafm.army.mil/Portals/72/Documents/BudgetMaterial/2025/Base%20Budget/Procurement/Procurement-of-Weapons-and-Tracked-Combat-Vehicles.pdf) | 19 M240L e US$ 0,425 milhão; custo bruto unitário de aproximadamente US$ 22.368. | A variante leve e o tamanho do lote precisam acompanhar a referência; o valor não estabelece sozinho o preço da MAG do jogo. |
| [USGS, Mineral Commodity Summaries 2026, alumínio](https://pubs.usgs.gov/periodicals/mcs2026/mcs2026.pdf) | Estimativa de 2025 para lingote no mercado spot dos EUA: 180 centavos de dólar por libra, aproximadamente US$ 3,97/kg. | Referência de insumo. O coeficiente de blindagem precisa representar a placa fabricada e sua especificação. |
| [Exército dos EUA, Laminated Metallic Armor](https://armysbir.army.mil/topics/laminated-metallic-armor/) | Dificuldades de produção, perdas de material e fabricação de componentes limitam a viabilidade econômica de blindagens avançadas. | Fundamentar o custo do material e de seu processamento no coeficiente de cada blindagem. |
| [SSAB, recomendações de oficina para Armox](https://www.ssab.com/-/media/files/en/armox/701en-armox-workshop-recommendations.pdf?m=20250626071536) | Recomendações específicas de soldagem, corte e usinagem para as placas de proteção. | Identificar os processos abrangidos pela estimativa de placa pronta. O guia não fornece uma tabela de preços. |
| [Saab, família AT4](https://www.saab.com/products/at4) | O sistema é de tiro único e completamente descartável. | Investigar se o custo recorrente do tiro representa o conjunto consumível, distinguindo-o do suporte instalado no veículo. |

Os dois valores do orçamento militar são custos brutos de programa, de variantes e lotes diferentes. Para formar uma tabela candidata, cada referência deve registrar modelo, ano, moeda, quantidade e conteúdo da aquisição. Os valores monetários acima permanecem no ano de origem.

Diretriz definida: usar referências reais como base e permitir ajustes documentados quando os testes apontarem desequilíbrios entre projetos. Preservar as características físicas dos equipamentos e ajustar primeiro preços e logística; corrigir a simulação quando os testes revelarem erros de modelagem. O método de trabalho proposto é:

1. Reunir referências por equipamento e material, identificando o que é dado direto, cálculo derivado ou estimativa. Comparar variantes e conjuntos equivalentes.
2. Normalizar moeda e ano antes de derivar proporções entre preços. Definir a escala inicial de conversão em créditos; os testes podem justificar ajustes documentados nessa referência.
3. Preservar o cálculo simples da blindagem por massa × coeficiente. Estimar nesse coeficiente o material pronto, incluindo os processos de fabricação pertinentes e o apoio já representado pelo material do jogo.
4. Avaliar armas como conjunto de aquisição, montagem e suprimentos. Considerar também munição consumida, combustível, reparo e reposição durante o uso. Cada item deve entrar uma única vez no custo.
5. Comparar projetos de referência com orçamento equivalente e condições reproduzíveis. Registrar função, mobilidade, autonomia, capacidade de detectar e inutilizar alvos e recursos consumidos. Os resultados orientarão eventuais alterações posteriores.

Cada ajuste deve registrar a fonte e o valor de referência, a conversão inicial em créditos, os preços anterior e proposto, o motivo da mudança, as condições do teste e os resultados observados. Assim, as diferenças em relação à referência real ficam rastreáveis e podem ser revistas.

Permanecem pendentes referências comparáveis para as demais armas, munições e placas prontas, a conversão em créditos e os ensaios de combate. Os preços atuais continuam sendo a referência do piloto durante essa investigação.


## Modo de partidas: planejamento futuro

O formato de partidas, com objetivos e progressão próprios, continua em
[Game Design](game-design.md#modo-de-partidas-planejamento-futuro).
Seus conceitos de pesquisa não são regras do campo persistente atual.
Custos, prazos e recompensas desse modo exigem avaliação específica.
