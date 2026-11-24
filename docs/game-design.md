# Game Design do Impacto

Este documento reúne regras do piloto e propostas para o jogo. O piloto mantém um mundo contínuo compartilhado, com foco em facções, criação, economia e PvP, incluindo comunicação, proteção offline e recuperação após derrota. O formato de partidas discutido anteriormente permanece como planejamento de um modo futuro.

A intenção é usar o jogo como ponto de partida para iniciar um RP militar dentro do Discord. Nesta etapa, basta registrar essa finalidade, sem detalhar regras próprias de RP. Possíveis integrações com o Discord podem ser avaliadas no curto prazo; ainda não há funcionalidades ou implementação definidas para elas.

## Piloto atual: mundo compartilhado

### Escopo consolidado

| Área | Recorte decidido para o piloto |
| --- | --- |
| Mundo e participação | Um mundo contínuo, com entrada e saída flexíveis e limite de 32 jogadores simultâneos por campo. |
| Facções e comunicação | Ingresso, convites, sucessão e permissões básicas; chat global e da facção. |
| Criação | Catálogo atual disponível, projetos pessoais e cópias coletivas, modelos básicos editáveis para todas as funções atuais. |
| Economia e patrimônio | Ferro, ligas, sílica e combustível; estoque e veículos coletivos; uma base ativa e cotas de 12 veículos e 32 construções fixas por facção. |
| Conflito e continuidade | PvP, ocupação de bases, proteção offline e recuperação após derrota, com preservação da facção e dos projetos. |
| Progresso | Desenvolvimento dos projetos e do patrimônio; ranking informativo de facções pelo patrimônio atual. |
| Aprendizado | Primeiros objetivos opcionais e dicas nas ações, com foco em coleta e uso dos veículos. |

Esta tabela consolida decisões de planejamento. A disponibilidade de cada regra na versão do jogo será conferida na preparação dos testes. Os valores iniciais, o roteiro proposto e as pendências ficam em [Balanceamento do Impacto](balanceamento.md).

### Público e atividades

O piloto aproveita o formato atual do jogo: um único mundo contínuo compartilhado, com jogadores entrando e saindo. A participação de cada pessoa pode acontecer em horários diferentes, mantendo a intenção de persistência e desenvolvimento de longo prazo.

Existe uma comunidade anterior com alguns milhares de membros, sem atividade há alguns anos. Segundo a estimativa do jogador, cerca de três pessoas experimentaram o jogo até agora, ainda sem divulgação ampla ou menções gerais à comunidade. A expectativa preliminar é de picos inferiores a 50 jogadores simultâneos, podendo ser bem menores. Após os ensaios com quatro threads, o limite foi ampliado de 20 para 32 jogadores simultâneos por campo em 15 de novembro de 2026, aceitando a margem menor nos cenários com frotas pesadas. O desempenho continuará sendo avaliado conforme a atividade observada.

Nos períodos em que apenas uma facção estiver online, o foco inicial são as atividades atuais: criar e testar projetos, coletar recursos e organizar a produção. Uma [facção autônoma experimental](faction-commander.md) já pode ser habilitada em servidor isolado: economia, melhorias e defesa local pelas regras comuns. Sua inclusão no campo público e o planejamento de invasões continuam para avaliação após os testes.

### Aprendizado e projetos iniciais

Os primeiros testes têm duas prioridades: a facilidade para um iniciante aprender coleta, construção e controle e a experiência de cooperação, conflito e recuperação das facções ao longo dos dias. A avaliação deve acompanhar tanto os primeiros passos quanto a continuidade após ausências e derrotas. As comparações detalhadas de combate e preços complementam essas prioridades. O roteiro de observação proposto fica em [Balanceamento do Impacto](balanceamento.md).

Na percepção do jogador, a coleta e as ações dos veículos são os pontos que mais podem confundir quem começa. Esses dois aspectos devem receber atenção especial na avaliação de aprendizado. As causas específicas das dificuldades ainda precisam ser verificadas com iniciantes.

A orientação inicial usa uma lista opcional de primeiros objetivos no próprio mundo, ensinando a coletar, entregar recursos e usar as ações de um veículo. Dicas junto às ações explicam seus requisitos. Ações compatíveis com o veículo permanecem visíveis quando estão temporariamente indisponíveis, mostrando o motivo e o que falta para executá-las. As etapas detalhadas, os critérios de conclusão e os textos ainda precisam ser definidos.

Desde o início, a biblioteca oferece projetos básicos prontos e editáveis para todas as funções atuais do jogo. A fabricação desses modelos usa os custos normais. O pacote inicial mantém um caminhão de minério, uma viatura de reconhecimento e um caminhão construtor, conforme o código conferido em 20 de outubro de 2026; os modelos exatos da biblioteca ainda precisam ser definidos.

### Progressão e classificação

O campo persistente usa [melhorias das instalações da base](industrial-progression.md), compartilhadas pela facção.
As funções básicas ficam disponíveis desde o início; melhorias pagas com os
estoques da facção e concluídas no tempo do campo liberam opções avançadas.
O catálogo completo continua disponível na oficina
e nos testes privados. Fabricação, custos e limitações físicas permanecem iguais
para todos que usam o mesmo equipamento. A pesquisa pessoal de um futuro modo
de partidas, discutida adiante, tem outro escopo.

O mundo oferece um ranking informativo de facções pelo patrimônio atual, considerando os recursos em estoque, o valor restante das construções, as cargas em trânsito, as matérias-primas aguardando refino e os suprimentos embarcados. A avaliação usa os valores econômicos da fabricação, com uma conversão fixa para combustível, e contabiliza cada quantidade uma única vez, considerando seu estado atual. O ranking exibe publicamente a posição e a pontuação total de cada facção, acompanhando as mudanças no patrimônio ao longo do jogo. O mundo continua aberto, com cada grupo escolhendo seus objetivos. Os valores de conversão necessários e a forma de atualização ainda precisam ser definidos.

### Facções, chat e bibliotecas

Ao entrar, quem ainda não pertence a uma facção pode criar a própria ou solicitar ingresso em uma já existente. Quem já pertence a uma facção também pode pedir para entrar em outra. Cada jogador mantém apenas um pedido de ingresso ativo; enviar outro substitui o anterior. Enquanto aguarda aprovação, pode manter sua facção atual e continuar jogando.

A troca de facção acontece automaticamente quando o pedido de ingresso é aprovado. Base, estoque e veículos permanecem na facção original, e quem sai perde o acesso a esses bens. O jogador conserva os projetos de veículos que criou e pode usá-los na nova facção.

Cada jogador mantém uma biblioteca pessoal e pode publicar cópias de projetos na biblioteca da facção. Todos os membros podem publicar projetos e novas versões; remover projetos compartilhados fica com o líder e os membros autorizados por ele. As cópias publicadas continuam pertencendo à biblioteca coletiva quando o autor sai, enquanto ele conserva seus projetos pessoais.

O chat oferece um canal global e um canal exclusivo dos membros atuais da facção. Cada canal conserva até 50 mensagens recentes; cada mensagem aceita até 500 caracteres e o intervalo entre envios é de dois segundos do campo. Sair da facção retira o acesso ao histórico privado e às novas mensagens dela, sem apagar o histórico global. A aba de facções permite consultar facções e seus membros, ver quem está online e gerenciar convites e pedidos de entrada. O líder, inicialmente o fundador, e os membros autorizados por ele podem convidar, aprovar pedidos e expulsar membros. A saída do líder segue a regra de sucessão.

Líder e administradores podem propor e responder trocas de ferro, ligas, sílica e combustível entre facções. A proposta já confirma a origem; o aceite da destinatária transfere os recursos imediatamente entre estoques, sem transporte. Ofertas pendentes não reservam saldo: no aceite, ambas as facções precisam ter o que prometeram. Qualquer parte pode cancelar uma oferta pendente.

Os mesmos representantes podem propor compromissos públicos. Depois do aceite das duas partes, o texto e os participantes ficam visíveis para todos, sem vencimento; qualquer parte pode encerrar o acordo. Esses compromissos não impedem disparos nem dão acesso a estoques, projetos ou controle de construções.

Uma aliança de inteligência exige proposta e aceite próprios, distintos do compromisso declarado. As duas facções compartilham o que seus sensores realmente medem: visão atual, contatos de radar e som com a precisão e idade da leitura, e terreno descoberto. A informação também orienta a mira e o piloto automático. O compartilhamento é direto: o aliado de um aliado não recebe essas informações. Estoques, projetos e controle continuam exclusivos de cada facção.

O piloto não escolhe outras construções da mesma facção ou de uma facção diretamente aliada como alvos, inclusive sob ordem explícita. O disparo manual continua possível: projéteis, fragmentos e explosões não danificam nem empurram essas construções, mas seu material consome a perfuração e cobre quem está atrás. A construção que originou o disparo ou a explosão continua vulnerável ao próprio fogo. O piloto só atravessa uma construção protegida com munição cinética que mantenha pelo menos metade da perfuração. Qualquer parte pode encerrar a aliança; a proteção e o compartilhamento seguem a relação vigente, inclusive para munições já no ar. Novas informações deixam de chegar imediatamente; o terreno descoberto permanece e os contatos já recebidos seguem seus prazos normais de memória. Um relato sonoro aliado informa o lado em relação ao observador que o ouviu, sem inventar a posição exata da fonte ou marcar o lado do veículo do destinatário.

Se houver outros membros, quem ocupa a liderança deve indicar um sucessor antes de deixar a facção. Ao solicitar ingresso em outra facção, o líder indica o sucessor no pedido e mantém a liderança até a aprovação efetivar a troca; nesse momento, a liderança é transferida ao indicado. Se o último membro deixar a facção, ela é encerrada e seu patrimônio é removido do mundo. Os projetos pessoais permanecem com seus autores. Facções com membros cadastrados continuam existindo durante períodos em que todos estejam offline.

Cada identidade nova de jogador recebe uma única vez o pacote inicial de recursos e veículos, na sua primeira facção. Entrar em outra facção dá acesso ao patrimônio existente. Sair ou ser expulso cria uma facção com base vazia, sem repetir o pacote; a recuperação usa as regras normais de auxílio. Para os primeiros testes, o pacote mantém o caminhão de minério, a viatura de reconhecimento, o caminhão construtor e os saldos atuais, registrados em [Balanceamento do Impacto](balanceamento.md). Esses valores serão ajustados conforme os resultados.

O histórico de auxílio acompanha todos os membros beneficiados. O próximo subsídio considera a data mais recente da facção e de seus membros; sair, ser expulso, mudar de facção ou reabrir o servidor não zera o intervalo de trinta minutos. Recuperação paga continua disponível sem renovar essa data.

### Bases e patrimônio

A preservação do investimento e a possibilidade de voltar a participar depois de uma derrota orientam este piloto. Todo o mapa permite PvP. Cada facção pode ter apenas uma base ativa por vez, sem distinção entre principal e avançada. A perda da base não elimina a facção, que pode estabelecer outra.

A primeira base acompanha a identidade nova sem cobrança. Reconstruir após a perda custa 25% do estoque inicial de cada recurso, com auxílio apenas para a insuficiência nas condições descritas abaixo. O sorteio inicial e a reconstrução comparam o acesso aos quatro recursos, priorizando a operação com Ferro e Petróleo. A base identifica uma fonte utilizável desses dois recursos; materiais avançados fora do levantamento inicial exigem exploração. A seleção tem fallback e não garante uma distância máxima para cada recurso. A base fica pronta ao efetivar a ação. A mudança voluntária de uma base existente fica fora do escopo do piloto. A revisão do acesso aos recursos e seus resultados estão em [balanceamento](balanceamento.md#1-início-e-recuperação).

Bases novas e reconstruídas seguem as mesmas regras de captura das demais, sem carência após o estabelecimento. A proteção offline continua seguindo os requisitos definidos para a facção.

A facção tem um estoque único, compartilhado entre seus membros. Todos podem usá-lo para fabricar veículos e atender a frota. O patrimônio persistente pertence à facção e fica disponível por meio de sua base ativa. Estabelecer outra base dá acesso ao saldo remanescente, considerando os gastos, as perdas e o saque. Enquanto estiver sem base, a facção pode usar esse saldo para estabelecer outra; os demais usos nessa situação ainda precisam ser definidos.

### Proteção offline e ausências

Todos os membros contam como responsáveis para a proteção offline da base. Como valores iniciais dos testes, a ativação exige dois minutos com todos offline e dois minutos sem combate envolvendo a facção em qualquer lugar do mapa. Os prazos correm em paralelo, e ambos precisam estar cumpridos. Disparos e impactos de armamento envolvendo uma unidade da facção reiniciam o período sem combate, mesmo quando não causam dano. A ocupação hostil em andamento conta como combate e impede a ativação mesmo sem disparos.

A proteção abrange construções apoiadas no solo cujo centro está a até 100 m para cada lado da base ou 50 m de um posto em serviço; veículos no ar ou fora dessas áreas continuam vulneráveis. Enquanto a proteção estiver ativa, as unidades protegidas ficam sem disparar. Ela é desativada imediatamente quando qualquer membro entra no mundo ou quando se completam sete dias de simulação desde a saída do último membro. A mesma regra vale para qualquer base que a facção venha a estabelecer.

Se um jogador se desconecta enquanto outros membros continuam online, os veículos que estavam sob seu controle ficam disponíveis aos aliados. Quando o último membro online se desconecta, a frota retorna automaticamente à base e para, permanecendo no mundo e vulnerável durante o trajeto. Veículos que não conseguem retornar, por avaria ou falta de combustível, permanecem no local e vulneráveis até serem recuperados. Se a base for tomada, aplica-se a desmontagem da frota prevista para essa perda.

Quando todos os membros estão offline, as instalações executam as filas de fabricação já encomendadas enquanto houver recursos. Elas não criam novas ordens de produção durante essa ausência.

### Frota coletiva

Os veículos pertencem à facção. Qualquer membro pode assumir um veículo que não esteja sob controle de outro jogador. Cada veículo fica reservado a apenas um jogador por vez, até ele liberar a unidade ou desconectar, inclusive enquanto ela segue ordens automáticas. Ao sair da facção, o jogador perde o acesso e libera suas reservas de veículos. Todos os membros podem desmontar veículos livres, devolvendo os recursos recuperáveis ao estoque coletivo.

Como limite inicial para os testes, cada facção tem cotas independentes de 12 veículos e 32 construções fixas, compartilhadas entre todos os membros. Veículos de combate, coleta, reconhecimento e apoio usam a mesma cota de veículos. Obras em andamento já reservam uma vaga de construção fixa; uma fabricação na base ocupa sua categoria desde o início.

A categoria vem do projeto, inclusive quando um veículo está parado ou desativado. Frotas antigas acima da cota são preservadas e podem substituir uma construção por outra da mesma categoria. Uma nova fabricação ou uma substituição que muda de categoria exige vaga na categoria de destino. As cotas continuam sujeitas à avaliação de desempenho dos testes.

### Economia e custos

A economia do piloto mantém os recursos existentes: ferro, ligas, sílica e combustível. O petróleo continua como matéria-prima do combustível. Custos, taxas e reservas podem ser avaliados no balanceamento, preservando esses tipos de recurso.

Por enquanto, são mantidos o ritmo atual dos ciclos de coleta e a relação atual entre a renda da mineração e o custo de fabricar veículos. Esses parâmetros servem de referência para o piloto; novas metas numéricas de duração da coleta e de tempo para financiar um veículo ficam adiadas.

Os preços de armas e blindagens são uma prioridade de investigação sugerida pelo jogador. As referências reais de aquisição, materiais e fabricação orientam os valores iniciais, com liberdade para ajustes documentados quando os testes apontarem desequilíbrios entre projetos. Cada ajuste deve registrar a referência, o motivo e o resultado dos testes. A validação em combate e a definição de novos preços ficam pendentes; esta etapa registra as fontes e a diretriz em [Balanceamento do Impacto](balanceamento.md).

O balanceamento do combate preserva as características físicas dos equipamentos fundamentadas nas referências e prioriza ajustes de preços e logística. A simulação deve ser corrigida quando os testes revelarem erros de modelagem.

As jazidas são infinitas: cada uma tem uma reserva máxima, que a extração gasta e que volta sozinha, de vazia a cheia em 2 h de jogo. Uma jazida escavada mais depressa do que se recupera fica vazia, e o transportador que a encontra assim volta à base ou ao posto e para, o que leva a espalhar a coleta por várias jazidas. Ligas e sílica dependem da distribuição do mapa e da exploração; o acesso inicial garantido de uma base abrange ferro e petróleo.

### Ocupação, perdas e recuperação

A base vulnerável é perdida após a ocupação do perímetro por um veículo armado e operacional, no chão, sem defensor contestando. A duração inicial para os testes é de cinco minutos de ocupação sem contestação.

Um defensor pode contestar a ocupação se tiver Comando e arma funcionando, com munição, e estiver no chão. Aeronaves no ar, por mais baixo que pairem, não iniciam, não contestam e não seguram a ocupação. A regra vale também para veículos recém-fabricados. A ocupação fica pausada enquanto houver mais de uma facção atacante no perímetro; uma facção pode concluir a tomada quando for a única atacante presente e não houver defensor contestando. Se a facção que está capturando retirar todos os veículos aptos do perímetro, seu progresso diminui gradualmente até zerar. Como valor inicial para os testes, a regressão ocorre no mesmo ritmo do avanço: cada segundo de abandono retira um segundo de ocupação acumulada.

Na tomada da base, a facção derrotada perde as instalações e seus veículos sobreviventes são desmontados automaticamente, inclusive os que estiverem fora da base. Cada peça devolve recursos proporcionalmente à integridade restante. As cargas e os suprimentos que ainda existirem também são recuperados: matérias-primas permanecem pendentes de refino, e combustível e munição retornam pelos respectivos valores de recurso.

O valor recuperado da desmontagem é incorporado ao saldo antes de calcular o saque. Para cada recurso de estoque, o percentual inicial de saque nos testes é de 25% do excedente acima do respectivo saldo inicial. O saque é transferido automaticamente para a facção que concluiu a tomada. O saldo remanescente continua pertencendo à facção derrotada, e os projetos permanecem disponíveis aos seus autores.

Das matérias-primas ainda não refinadas, incluindo as cargas recuperadas dos veículos, 25% são transferidos como matéria-prima para a facção vencedora e 75% permanecem com a derrotada. O pacote inicial não inclui uma reserva bruta a preservar. As matérias-primas continuam pendentes de refino após a transferência.

Quando a facção não tem construções no campo, o auxílio pode completar a insuficiência para uma base, quando necessária, e para o caminhão de minério do catálogo com tanque cheio e mais duas cargas de tanque em estoque. O cálculo usa primeiro o estoque e o equivalente refinado do pátio, cobrindo somente o que faltar. Se esses recursos já cobrem todo esse conjunto, não há insuficiência a subsidiar; a fabricação normal na Oficina continua disponível. Outro subsídio positivo exige trinta minutos do relógio do jogo desde o anterior; a recuperação paga não reinicia esse intervalo. Custos e capacidade do tanque acompanham o catálogo atual, definidos em `SharedRoom.recovery` e `SharedRoom.recover`, em [room.ts](../server/room.ts). As demais unidades dependem do saldo e da produção da facção; o equilíbrio dessa proteção ainda requer avaliação em partidas.

### Validação do piloto

O roteiro proposto começa com uma a três pessoas, em sessões distintas, e avança conforme a adesão e a disponibilidade das regras na versão do jogo:

1. Aprendizado de coleta, ações dos veículos, projetos e fabricação.
2. Cooperação, ingresso, permissões e preservação de bens ao trocar de facção.
3. Ausência, retorno da frota, fabricação offline e proteção.
4. Ocupação, perda da base, contabilidade do saque e recuperação.
5. Continuidade ao longo dos dias e avaliação de escala, até o limite inicial de 20 simultâneos.

Cada cenário registra a versão, o estado inicial, as ações, o resultado esperado e o observado. Regras ou parâmetros ainda pendentes ficam identificados antes da execução. A preparação, os casos essenciais e o modelo de registro estão no [roteiro dos primeiros testes](balanceamento.md#roteiro-proposto-dos-primeiros-testes).

### Fora do escopo do piloto

- Pesquisa, pontos de pesquisa e faixas tecnológicas.
- Partidas separadas, com regras próprias de vitória e progressão.
- Adversários controlados por IA.
- Mudança voluntária de localização de uma base existente.
- Regras detalhadas de RP.

### Decisões em aberto do mundo compartilhado

| Tema | Decisão necessária |
| --- | --- |
| Estabelecimento da base | Custos, distâncias de acesso inicial a ferro e petróleo e demais critérios para validar os locais sorteados, respeitando o limite de uma base ativa por facção. |
| Acesso ao patrimônio | Demais usos do saldo persistente enquanto a facção estiver sem base, além do estabelecimento de outra. |
| Organização da facção | Permissões futuras de gestão das instalações da base; os papéis atuais e a representação em trocas e acordos já estão definidos acima. |
| Recuperação | Modelo do minerador, quantidade de combustível e critérios para avaliar o que falta para ter uma base operacional e retomar a coleta. |
| Continuidade do mundo | Tamanho das reservas, critérios e prazos de reposição em outros locais e condições para novos jogadores participarem ao longo da vida do mapa. |
| Equipamentos e projetos | Definir os modelos básicos prontos e editáveis que representarão cada função atual na biblioteca inicial. |
| Orientação inicial | Detalhar a lista opcional de primeiros objetivos, seus critérios de conclusão e as dicas sobre os requisitos das ações. |
| Custos de armas e blindagens | Completar referências comparáveis e definir sua conversão em preços de jogo, com validação em combate. |
| Classificação das facções | Valores de conversão para combustível e matérias-primas e forma de atualização do ranking por patrimônio atual, usando os valores econômicos da fabricação como referência. |

Os parâmetros do mundo compartilhado ficam em [Balanceamento do Impacto](balanceamento.md). Os valores e as regras de encerramento, economia e progressão do modo de partidas abaixo pertencem àquele formato; sua aplicação ao mundo contínuo exige uma decisão própria.

## Modo de partidas: planejamento futuro

As decisões seguintes preservam o planejamento de partidas separadas. Elas servem de referência para esse modo futuro.

### Visão e decisões definidas

O modo de partidas liga batalhas à progressão de longo prazo. A participação deve ser flexível, permitindo jogar em horários diferentes e continuar o desenvolvimento de projetos e pesquisas ao retornar.

Projetos e pesquisas devem ser preservados após derrotas. Veículos destruídos são perdidos e precisam ser fabricados novamente com recursos da partida; seus projetos permanecem disponíveis.

As batalhas dão propósito aos projetos e às pesquisas e concedem recompensas de progressão. Há classificações globais individuais separadas para 1v1 e 2v2, com Clash Royale como referência de intenção para a classificação global.

As partidas acontecem em mapas próprios, em vez de depender de um único mundo persistente compartilhado.

O primeiro formato de combate começa com uma base e permite extrair recursos e fabricar unidades durante a partida. Economia, expansão da força e combate fazem parte da mesma experiência. Ataques assíncronos a defesas preparadas e disputas por territórios persistentes ficam entre as ideias adiadas, sem compromisso de inclusão no primeiro formato.

Cada partida tem sua própria economia. Ao terminar, permanecem os projetos, as pesquisas e os pontos de pesquisa obtidos. Materiais e unidades fabricadas no combate pertencem à economia daquela partida.

A economia da partida administra dois recursos: materiais de produção e combustível. Os materiais das peças continuam relevantes para a massa, a resistência e o custo dos projetos. Fora das partidas, os pontos de pesquisa são a única moeda de progressão desse modo.

O jogador comanda várias unidades por ordens e pode assumir diretamente um veículo quando quiser. A equipe vence ao atingir a pontuação de vitória por posições mantidas, eliminar todos os jogadores adversários, receber a rendição da equipe adversária ou terminar o tempo regulamentar com mais pontos.

A escala desejada para o meio e o fim da partida é de aproximadamente 6 a 10 veículos de combate ativos por jogador, além dos mineradores, construtores e veículos de apoio. O limite inicial desse modo é de 16 veículos totais por jogador, contando todas essas funções. A meta de escala e o limite total devem ser validados nos testes.

As partidas são 1v1 ou 2v2, com um ou dois jogadores por lado. O mapa oferece três posições fixas que geram pontos enquanto são mantidas. A duração desejada de uma partida normal é de aproximadamente 20 a 30 minutos. O tempo regulamentar é de 35 minutos; ao final, vence a equipe com mais pontos, ou a partida termina empatada se houver igualdade.

A meta para os testes é que as primeiras disputas entre as equipes ocorram por volta de 2 a 3 minutos de partida. Distâncias, recursos iniciais e produção deverão ser avaliados em relação a esse ritmo.

Durante a partida, cada jogador tem base, estoque e unidades próprios, inclusive no 2v2. Os aliados cooperam pela pontuação da equipe, mantendo a administração de suas respectivas economias e unidades.

Cada jogador começa com sua base de combate, um minerador, uma viatura leve de reconhecimento e recursos iniciais. Os modelos das unidades e a quantidade dos recursos ainda serão definidos.

A base temporária de combate é atacável. Estruturas de produção podem ser destruídas e reconstruídas, afetando a economia, a reposição de unidades e a possibilidade de continuar na partida.

Desde o início da conta, há peças básicas disponíveis para combate direto, reconhecimento, apoio de fogo, economia, construção e logística. O jogador recebe uma biblioteca de projetos prontos e editáveis para todas essas funções. O catálogo exato de peças e projetos ainda precisa ser definido.

A progressão desbloqueia equipamentos, materiais, estruturas e opções de produção e logística. Cada equipamento ou estrutura segue as mesmas regras para todos os jogadores: uma mesma especificação conserva suas propriedades físicas, custos, tempos e taxas dentro da faixa tecnológica. As melhorias permanentes ampliam as opções disponíveis.

As pesquisas liberam equipamentos, mas cada partida usa uma faixa tecnológica comum aos dois lados. Cada faixa define uma lista de equipamentos permitidos, que os projetos precisam respeitar. O conteúdo dessas listas ainda precisa ser definido.

O recorte inicial desse modo tem duas faixas tecnológicas. Novas faixas são liberadas ao concluir as pesquisas exigidas, independentemente da classificação competitiva. Antes de buscar uma partida, o jogador escolhe qualquer faixa tecnológica que já tenha liberado. As pesquisas exigidas para cada faixa ainda precisam ser definidas.

StarCraft inspira a extração e fabricação durante a partida. War Thunder é uma referência para a disputa por posições e a relação entre partidas e progressão. Clash Royale é a referência citada para a classificação global.

### Partidas, recompensas e progressão

Entre partidas, permanecem os projetos, as pesquisas e os pontos de pesquisa obtidos. Os pontos ficam em um saldo, e o jogador escolhe em quais tecnologias investir, respeitando os pré-requisitos. Eles são a única moeda permanente desse modo.

Ao cumprir os requisitos de uma pesquisa, seu desbloqueio é imediato. Os custos, os caminhos e os pré-requisitos das pesquisas ainda precisam ser definidos.

A meta de ritmo é permitir que um iniciante alcance o primeiro desbloqueio pequeno após aproximadamente 1 a 2 partidas com participação, inclusive sem vencer. Essa meta deve orientar os custos e as recompensas iniciais e ser validada nos testes.

O primeiro modo começa com uma base temporária de combate no mapa da partida. As três posições fixas geram pontuação para a equipe que as mantém. Eliminar todos os jogadores adversários também encerra a partida com vitória imediata, independentemente da pontuação acumulada.

O jogador prepara e repõe sua força por meio da economia dentro da partida. Perder um veículo exige fabricar outra unidade usando esses recursos. O término da partida encerra sua economia; a progressão permanente recebe as recompensas em pontos de pesquisa. Vitórias e derrotas dão pontos por participação, e vencer concede um bônus. As quantidades de pontos, os critérios de participação, o cálculo e o tamanho desse bônus ainda serão definidos.

Projetos e pesquisas preservados e classificação competitiva têm regras distintas. Cada jogador tem uma classificação para 1v1 e outra para 2v2. A subida ou queda considera a vitória ou derrota e a classificação dos adversários. A contribuição individual influencia as recompensas de progressão. A fórmula da classificação, os valores iniciais e o cálculo da força das equipes no 2v2 ainda precisam ser definidos.

A preparação entre partidas ocorre em uma interface com projetos, pesquisa e perfil. Esse modo foi planejado sem uma base permanente.

### Cooperação e desconexões no 2v2

Os aliados compartilham automaticamente a exploração do terreno, as detecções e os últimos contatos conhecidos. Cada jogador mantém a administração de sua base, estoque e unidades. Não há transferência de recursos entre jogadores durante a partida.

Quando um jogador desconecta, uma IA assume temporariamente suas unidades e sua produção. O jogador retoma o controle ao retornar. As regras para uma ausência prolongada, uma saída definitiva e os limites de atuação da IA ainda precisam ser definidos. As possibilidades de prestar serviços ou executar obras para aliados também permanecem em aberto.

### Projetos e reconstrução

Durante a partida, o jogador pode usar sua biblioteca de projetos e o editor completo, inclusive para redesenhar casco e chassi ou trocar equipamentos. Os projetos continuam sujeitos às verificações físicas e à faixa tecnológica da partida. Cabe ao jogador decidir quanto tempo dedicar à edição; aprender a preparar e adaptar projetos com eficiência faz parte da experiência.

Alterações nos projetos valem apenas para novas fabricações. Veículos já fabricados conservam sua configuração, mesmo que o projeto usado para produzi-los seja editado.

Cada fábrica é universal: pode montar qualquer projeto compatível com seu espaço de montagem, os equipamentos liberados e a faixa tecnológica da partida. Produz um veículo por vez. Construir novas fábricas oferece filas independentes, permitindo fabricar veículos em paralelo. Os custos, os tempos e eventuais limites à quantidade de fábricas ainda precisam ser definidos.

O construtor é uma unidade separada, fabricada durante a partida. Ele não faz parte do kit inicial de minerador e viatura leve. Reconstruir a produção exige que um construtor chegue ao local e execute a obra. A obra consome materiais diretamente do estoque daquele jogador na partida. Os custos e tempos de fabricação do construtor e de execução das obras ainda precisam ser definidos.

O construtor pode erguer estruturas em qualquer local fisicamente válido que consiga alcançar no mapa da partida. Isso permite expandir a produção e estabelecer bases avançadas durante o combate.

### Economia e apoio em campo

Cada base tem jazidas de materiais e petróleo próximas. As jazidas se recuperam aos poucos depois de esvaziadas. Reservas adicionais ficam em áreas disputadas, oferecendo oportunidades de expansão da economia.

Materiais e petróleo podem ser entregues na base inicial ou em depósitos próprios construídos pelo jogador. Isso permite estabelecer pontos de entrega próximos das novas áreas de extração.

Os recursos já entregues permanecem no estoque do jogador durante a partida, mesmo se a base ou um depósito for destruído. A destruição das instalações afeta os pontos de entrega, a produção e os serviços disponíveis.

Os materiais de produção precisam ser extraídos e transportados até um desses pontos de entrega para entrar no estoque do jogador. A capacidade de carga e o percurso entre a jazida e o ponto de entrega fazem parte da operação de coleta.

O combustível é obtido a partir do petróleo extraído no mapa e transportado até um ponto de entrega próprio. Os equipamentos usados na coleta, as taxas de extração e a conversão em combustível ainda precisam ser definidos. A economia continua administrando os dois recursos escolhidos: materiais de produção e combustível.

Depois de receber uma ordem de coleta, o veículo repete automaticamente o ciclo de coleta e entrega entre a jazida e o ponto de entrega enquanto for possível, até receber outra ordem. O jogador não precisa ordenar cada viagem. O comportamento em caso de interrupção da coleta ou de uma rota bloqueada ainda precisa ser definido.

Reparar, rearmar e reabastecer veículos são serviços disponíveis na base e por veículos de apoio em campo. Esses serviços consomem recursos da partida. Os veículos de apoio carregam suprimentos limitados para os serviços que oferecem e precisam repô-los fisicamente. As capacidades de carga, os locais de reposição, as condições de atendimento, os custos e os tempos ainda precisam ser definidos.

### Exploração e reconhecimento

O terreno precisa ser explorado e permanece conhecido depois da exploração, mesmo quando a região deixa de ser observada. As unidades inimigas só aparecem quando detectadas.

Contatos perdidos deixam uma marca da última posição observada. Essa marca conserva a informação obtida no último contato; a posição do inimigo só é atualizada quando houver nova detecção. A duração e os critérios de remoção dessas marcas ainda precisam ser definidos.

As localizações das três posições de vitória ficam marcadas desde o início, inclusive em regiões ainda inexploradas. Reconhecer o terreno e detectar as forças adversárias continuam fazendo parte da preparação para disputá-las. Os alcances e os meios de detecção ainda precisam ser definidos.

### Captura de posições

Qualquer veículo com Comando funcionando pode capturar posições, armado ou não. Reconhecimento e transporte podem participar da ocupação sem precisar de uma arma instalada.

Como valor inicial para os testes, capturar uma posição neutra, sem disputa, leva aproximadamente 45 a 60 segundos. A quantidade de veículos presentes não altera o tempo de captura.

Tomar uma posição inimiga exige primeiro neutralizá-la, interrompendo sua geração de pontos, e depois capturá-la para a equipe. O tempo de neutralização será definido separadamente do tempo de captura neutra. Após a neutralização, a posição permanece neutra até uma equipe concluir sua captura.

Quando a equipe retira todos os veículos capazes de capturar antes de concluir uma etapa, o progresso dessa etapa diminui gradualmente. A velocidade dessa perda de progresso ainda precisa ser definida.

As três posições geram a mesma quantidade de pontos por tempo. A taxa absoluta de geração e a pontuação necessária para vencer ainda precisam ser definidas.

Uma posição capturada permanece da equipe e continua pontuando mesmo sem unidades no local, até ser neutralizada. A presença de uma guarnição não é necessária para preservar a posse. Quando veículos capazes de capturar das duas equipes estão na mesma posição, tanto a captura quanto a pontuação ficam pausadas enquanto durar essa disputa.

### Encerramento da partida

O jogador continua na partida enquanto tiver veículos capazes de capturar posições ou meios de produzir ou reconstruir. A eliminação ocorre quando perde todas essas possibilidades. Os critérios para identificar a capacidade de produzir ou reconstruir ainda precisam ser detalhados. Quando todos os jogadores de uma equipe forem eliminados, a partida termina imediatamente com vitória da outra equipe.

A partida também termina ao atingir a pontuação de vitória ou completar 35 minutos de tempo regulamentar. Ao fim do tempo, vence a equipe com mais pontos; se os pontos forem iguais, a partida termina empatada.

No 2v2, a rendição exige a concordância de todos os jogadores ainda ativos da equipe e concede a vitória aos adversários. As regras de votação durante uma desconexão ainda precisam ser detalhadas.

### Referências de design

| Referência | Aplicação ao planejamento |
| --- | --- |
| StarCraft | Economia e fabricação durante a partida, escolhidas para o primeiro modo. A economia e o combate disputam a atenção e os recursos do jogador. |
| War Thunder | Disputa por posições e relação entre partidas e progressão. |

As referências descrevem aspectos específicos: o [guia de recursos de StarCraft II](https://news.blizzard.com/en-us/article/4488900/game-guide-resources) trata da economia e fabricação no campo de batalha; as páginas de [batalhas Arcade](https://wiki.warthunder.com/gamemode/arcade_battles) e [economia de War Thunder](https://wiki.warthunder.com/mechanics/basic_economy) descrevem o uso de veículos nas partidas e as recompensas, pesquisas e custos fora delas.

### Outras direções discutidas

A discussão de longo prazo considerou facções com bases individuais seguras e recursos e progresso permanentes compartilhados. O campo persistente atual usa [Oficina, Hangar e Processamento](industrial-progression.md), comprando capacidade da base com recursos compartilhados, limites e recuperação explícitos. Esses avanços são independentes da pesquisa pessoal proposta para o futuro modo de partidas descrito acima. Clash of Clans permanece como referência de intenção para a direção de longo prazo.

A discussão anterior considerou bases avançadas reais em território hostil, vulneráveis mesmo com seus responsáveis offline, e perda de defesas em mapas PvP. Conquista territorial, janelas de cerco, estoques locais transportados por comboios e limites de exposição dos recursos foram explorados como desdobramentos. Essas regras ficam fora do recorte inicial em discussão e só serão retomadas se trouxerem valor ao formato básico de combate.

### Decisões em aberto do modo de partidas

| Tema | Decisão necessária |
| --- | --- |
| Cooperação | As possibilidades de prestar serviços e executar obras para aliados, os limites de atuação da IA e as regras para ausência prolongada ou saída definitiva no 2v2. |
| Perdas em batalha | Quais avarias podem ser reparadas, as condições e os custos dos serviços na base e em campo e o tratamento de sobreviventes e consumíveis. |
| Organização dos mapas | A disposição das três posições de vitória, as distâncias e reservas das jazidas próximas das bases e das áreas disputadas e as áreas iniciais de cada lado. |
| Reconhecimento | A duração e os critérios de remoção das marcas de contatos perdidos e os alcances e meios de detecção. |
| Base de combate | Os custos e tempos do construtor e da construção e os critérios para identificar a capacidade de produzir ou reconstruir. |
| Projetos e fabricação | Os custos e tempos dos projetos e das fábricas, eventuais limites de fábricas e qual versão do projeto é usada por uma encomenda já iniciada. |
| Recursos da partida | Os equipamentos, as capacidades de carga, as reservas e as taxas das jazidas, a conversão do petróleo em combustível, o tratamento de interrupções na coleta e como os materiais das peças entram no custo dos projetos. |
| Apoio em campo | As capacidades de suprimentos, os locais de reposição física, o alcance de atendimento e os limites de reparo, remuniciamento e reabastecimento. |
| Progressão | O catálogo exato de peças e projetos iniciais, os custos e caminhos de pesquisa, o conteúdo das duas faixas tecnológicas e as pesquisas exigidas para liberá-las. |
| Classificação global | A fórmula de variação, a classificação inicial, o tratamento de empates e o cálculo da força das equipes no 2v2. |
| Captura e pontuação | Tempo de neutralização, ajuste do tempo de captura, área de ocupação, velocidade de perda do progresso ao abandonar uma etapa, taxa de pontos por posição e pontuação de vitória. |
| Recompensas | As quantidades de pontos de pesquisa, como a participação é avaliada e como calcular as recompensas e o bônus de vitória, incluindo empates e rendições. |
| Início da partida | A composição da base, a quantidade de recursos iniciais e os modelos do minerador e da viatura leve. |
| Eliminações simultâneas | Como resolver o caso em que os dois lados perdem a capacidade de continuar ao mesmo tempo. |

### Planejamento do balanceamento das partidas

O balanceamento deverá considerar o orçamento inicial de cada lado, a distância e a taxa de extração dos recursos, o custo e o tempo de fabricação dos veículos e a reposição das perdas durante o combate. A diferença de opções entre jogadores com tempos de desenvolvimento distintos também precisa ser avaliada. As regras de perda e recompensa devem sustentar a participação flexível, a preservação dos projetos e pesquisas e a possibilidade de voltar a jogar após uma derrota. A classificação competitiva terá critérios próprios.

Os parâmetros confirmados e o método proposto de validação ficam em [Balanceamento do Impacto](balanceamento.md). Custos de fabricação e reparo, consumo e reposição, recompensas e ritmo das melhorias serão definidos junto da finalidade de cada parâmetro.
