# Melhorias da base

As instalações substituem a pesquisa da facção no campo persistente. A interface
fica em **Facção → Melhorias**; os bloqueios da fabricação e da garagem levam
até ela. Oficina I e Processamento I vêm com a base. Hangar começa ausente.
A capacidade pertence à facção e é compartilhada entre seus membros.

## O que cada instalação permite

| Instalação | Capacidade |
| --- | --- |
| Oficina I | Projetos terrestres/fixos até 20 t, 10 × 6 m. Mineração, construção, logística, pavimentação, postos, câmeras, escuta e armamento básico. |
| Oficina II | Até 40 t, 14 × 8 m; radar, automáticos acima de 20 mm, lançadores de apoio e obuseiro de 105 mm. |
| Oficina III | Até 80 t, 18 × 10 m; canhão de 120 mm e obuseiro de 155 mm. |
| Hangar I | Aeronaves até 5 t, 9 × 5 m, incluindo turbinas. |
| Hangar II | Aeronaves até 15 t, 14 × 8 m. |
| Processamento I | Aço, concreto e vidro nas peças compatíveis. |
| Processamento II | Alumínio, aço de alta dureza e plástico. |
| Processamento III | Titânio, cerâmica e fibra de vidro. |

Os três limites de porte são cumulativos: massa **vazia**, comprimento e altura
dos materiais reais. A autoridade é a projeção `manufacturing` do Native.
Carga, combustível, munição, detalhes cosméticos, arco de mira e espaço vazio
de recuo não aumentam o nível exigido. Materiais obrigatórios da peça acompanham
sua família: o titânio intrínseco da turbina está incluído no Hangar. Escolher
um motor de titânio exige Processamento III.

Armas e munições avançadas de uma aeronave também exigem a Oficina correspondente.
Projetos e ensaios privados permanecem livres. A instalação não aumenta dano,
resistência ou velocidade de refino. Serviços de veículos existentes continuam
funcionando independentemente dos níveis. Postos não concedem capacidade de fábrica.
Os limites físicos do projeto continuam valendo, inclusive o chassi de até 12 m.

## Exemplos antes de investir

Cada nível tem um exemplo em **Facção → Melhorias → Exemplo**: apoio e blindado
pesado para Oficina; reconhecimento e transporte de suprimentos para Hangar;
variantes do explorador com HHA e titânio para Processamento. Cada exemplo cabe
no nível demonstrado com as outras instalações básicas, sem requisitos ocultos.
O vidro é preservado nas variantes de blindagem.

A prévia mostra massa vazia, dimensões, instalações necessárias, custo do projeto
e a soma **desta melhoria + uma unidade**. A soma inclui combustível e munição
iniciais; não inclui carga de suprimentos, compras anteriores, manutenção ou
ampliações futuras. Abrir na oficina e testar são gratuitos e
continuam disponíveis antes de comprar a melhoria. O projeto aberto é uma cópia
editável; os exemplos não mudam quando o jogador os modifica.

As duas aeronaves também estão nos modelos prontos. O reconhecimento tem câmera
voltada ao solo, cabine leve, quatro turbinas e 316 L de combustível. O transporte
tem convés aberto de 10 m e módulo de suprimentos; seu comprimento exige Hangar II.
O comando `review:industry:missions` verifica ida e volta a 500 e 1.500 m, nos dois
sentidos, com combustível finito, o transporte carregado pelo serviço normal e
a ordem Voltar à base concluída com pouso na área de serviço. Os deslocamentos
entre ponto pedido e pouso são registrados; não é ensaio de pouso de precisão.
Não há reposição externa durante a viagem. Isso não valida combate ou equilíbrio
entre jogadores.

## Pagamento, montagem e perda

Líder e administradores iniciam/cancelam melhorias. Cada base monta uma melhoria
por vez, paga integralmente no início. O nível anterior funciona durante os
120 s da primeira ampliação ou 240 s da seguinte, medidos no relógio do campo.
Fechar a página não cancela; servidor desligado não concede tempo offline.
Cancelamento devolve uma vez o pagamento e perde o progresso. Pedidos repetidos
não cobram outra vez; cancelar uma operação antiga não afeta uma montagem nova.

O capital pago, concluído ou pendente, entra uma vez no acerto normal de
salvamento e saque da base derrotada. A facção recupera somente os níveis básicos;
o vencedor não recebe uma fábrica. Níveis básicos ou concedidos pela conversão
não têm capital pago e não geram salvamento gratuito.

## Balanceamento e fontes

Os custos incrementais estão no catálogo executável
[`src/industry.ts`](../src/industry.ts), compartilhado com a interface e o servidor.
Oficina II custa 60 mil Fe, 2 mil Ligas, 3 mil Sílica e 300 L; Hangar I,
60 mil Fe, 8 mil Ligas, 5 mil Sílica e 300 L. Processamento II custa 50 mil Fe,
4 mil Ligas, 5 mil Sílica e 200 L. O estoque inicial permite qualquer primeira
escolha, mas não as três. Adiar uma instalação para expandir a frota é válido.

Os seis níveis compráveis foram integrados para substituir todos os antigos
bloqueios. **Preços, tempos e valor dos níveis superiores ainda precisam de partidas
com jogadores.** Não anunciar equilíbrio PvP com base somente nos ensaios.
Os cenários de sensibilidade leem o mesmo catálogo, sem outra regra de admissão.
Ver [os cenários de validação de missões](../scripts/review-industry-missions.ts).
As regras atuais, os resultados da revisão e as próximas comparações por fluxo
estão em [balanceamento](balanceamento.md). A prioridade é medir acesso aos
recursos e a primeira missão útil, preservando a física dos projetos.

- [Catálogo e admissão](../src/industry.ts): requisitos por conteúdo e porte.
- [Transações e estado](../server/industry.ts): pagamento, conclusão, cancelamento e validação.
- [Integração da sala](../server/room.ts): permissões, relógio, fabricação e derrota.
- [Interface](../src/industry-ui.ts): três decisões, custos/estoque, faltas e progresso.
- [Testes de regras](../tests/industry.test.js), [interface](../tests/industry-ui.test.js)
  e [conversão](../tests/field-industry-conversion.test.js).

## Campos salvos anteriores

O save atual é **29**. O loader recusa versões antigas e preserva seus arquivos.
`scripts/convert-field-industry.ts` converte uma cópia do formato 27 ou 28,
valida/reabre e só escreve com `--write` em pasta nova. A conversão concede os
menores níveis que cobrem famílias já pesquisadas e projetos salvos da frota,
biblioteca e obras. Famílias adicionais do mesmo nível também ficam disponíveis.
Projetos fora do porte máximo recusam a conversão completa; nada é truncado.
Novas facções começam básicas. Facções já sem base também retomam básicas.

Os pontos antigos são retirados, sem inventar uma equivalência com recursos:
o recibo informa o total retirado e os níveis concedidos, e o snapshot original
continua preservado para conferência. Níveis convertidos não recebem capital
resgatável. Nenhum conversor é executado automaticamente na inicialização.
Para o formato 26, o conversor de postos continua disponível, agora com saída 29.

## Evidência econômica anterior à implantação

## O que os cenários dizem — e o que não dizem

`npm run review:industry -- --out validation/industry-review.json` verifica os
modelos com o compilador Native atual e repete a simulação analítica. Não é
uma partida, medição de renda, ensaio de GPU ou prova de equilíbrio PvP.

A comparação inicial usa três mineradores sólidos, uma cisterna, scout e
construtor: seis veículos. Compra dois mineradores e a cisterna por 88.798 Fe,
2.361 Si e 609 L; o relógio começa **depois** dessa montagem. Mantém por opção
30 mil Fe, 3 mil Si e 500 L de reserva para compras. Assume depósitos conhecidos,
1,5 km por trajeto a 8 m/s, reservas centrais e sua regeneração atual. Não há
minério infinito: mudar a logística altera o resultado.

As primeiras simulações com redistribuição por déficit produziram estes tempos
para **financiar** as seis melhorias, sem montagem das instalações:

| Cenário hipotético | Preços ×0,75 | Preços ×1 | Preços ×1,5 |
| --- | ---: | ---: | ---: |
| Duas jazidas de ferro | 9,9 h | 13,4 h | 20,5 h |
| Quatro jazidas, pagando dois postos | 9,1 h | 11,8 h | 17,3 h |
| Duas jazidas, provisão contínua de um scout a cada 2 h | 12,2 h | 16,6 h | Estratégia inviável |
| Duas jazidas, viagens de 5 km | 24,9 h | 33,1 h | 49,5 h |

São resultados de um modelo fluido, não previsões com precisão de décimos de
hora. Ele omite busca de jazidas, viagens extras para mudar minério, relevo,
munição, manutenção e combate além da perda declarada. Dois postos pagos não
garantem, no mapa real, acesso às quatro jazidas na distância suposta. A reserva
de caixa é uma política escolhida, não uma obrigação do jogo. O comando mantém
essas premissas explícitas e também compara redistribuição a cada 15 minutos.

A reposição acima é uma provisão contínua de custos, não eventos reais de perda.
A ×1,5 o despacho ignorou Sílica até não conseguir pagar essa provisão no minuto
977. A primeira versão do modelo aceitava saldo negativo intermediário e
anunciava 25,3 h; a revisão retirou esse resultado. O comando agora interrompe
o cenário antes de gastar recursos inexistentes. Priorizar a reposição é uma
política diferente a testar, não evidência de que aumentar preço seja seguro.

As antigas metas de primeira escolha em 20–40 min e árvore em 15–25 h eram
controladas pelo teto da pesquisa, não por renda medida. Não transpor o teto
como espera obrigatória. Medir **primeira unidade útil e missão sustentada**,
além da compra da instalação. Maior facção não significa multiplicar a renda
pelo número de membros: frota, jazidas e estoques continuam compartilhados.

Hangar I mais a aeronave simples usada nos testes custam 68.092 Fe, 17.600 Ligas,
5.000 Si e 503 L a ×1. Faltam 7.600 Ligas em relação ao caixa inicial. Com uma
jazida de ligas já conhecida a 1,5 km, a análise encontrou cerca de 27 min até
fabricá-la, **sem montagem do Hangar nem procura da jazida**. A fundação normal
só garante revelar ferro. Preservar caixa, investir primeiro na frota ou procurar
a jazida muda esse prazo. O exemplo não é promessa de ritmo.

Essa aeronave era um fixture mecânico, não um modelo pronto ou uma missão útil:
seu tanque de 202 L sustentava aproximadamente 170 s de hover teórico. Os valores
acima são o registro dessa hipótese anterior. A biblioteca agora oferece os dois
modelos descritos em **Exemplos antes de investir**; o comando econômico atual usa
o reconhecimento pronto para calcular o primeiro investimento no Hangar.
Exigir Processamento III pelo titânio obrigatório elevaria o mesmo conjunto
a 278.092 Fe e 37.600 Ligas; essa cadeia acidental foi descartada.
