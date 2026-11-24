# Contextos e interações do cliente

O cliente compõe a interface em `src/main.ts`. As decisões de contexto e de
interação pertencem aos módulos abaixo; testes importam esses mesmos módulos.
Para outras áreas e as regras do campo, veja o [Mapa de manutenção](maintenance-map.md).

| Responsabilidade | Proprietário |
| --- | --- |
| Entrar, sair e enquadrar Oficina, Campo e testes privados | `src/play-context.ts` |
| Intenção de disparo, condução e liberação dos controles | `src/player-controls.ts` |
| Gestos do canvas, instalação e confirmação/cancelamento da edição | `src/canvas-controls.ts` |
| Linhas de disparo e resultados do ensaio de blindagem | `src/armour-trial.ts` |
| Salvamento, versões abertas, conflitos e recuperação do projeto | `src/project-workspace.ts` |
| Atualizações visuais de prévias e edições confirmadas | `createEditorView`, no mesmo módulo do projeto |
| Severidade, prazo e destino do aviso visível | `src/notices.ts` |
| Projetos conhecidos das construções presentes na facção | `src/field-designs.ts` |
| Obras, montes, estradas e postos: desenho, áreas de clique e descarte da cena | `src/site-markers.ts`, composto pelo `Renderer` com provedores explícitos de textura e texto |
| Solução física da mira, obstrução e previsão de impacto | `src/aim-queries.ts`, com snapshot, arma, alvo e terreno explícitos; sem câmera, DOM ou GPU |
| Melhorias da base e disponibilidade das escolhas | `src/industry-ui.ts`; regras em `server/industry.ts` e catálogo em `src/industry.ts` |
| Idioma inicial, preferência e frases | `src/bootstrap.ts` e `src/i18n.ts`; ver [tradução](localization.md) |

## Estado e efeitos

`view` continua sendo o estado lido pela interface e pelo renderizador.
`createPlayContext` é o proprietário das transições de `mode` e `trial`; não
mantém uma segunda cópia deles. `session.generation` identifica o mundo privado
atual e impede que uma resposta anterior reabra um teste cancelado ou que sua
falha restaure o contexto anterior sobre uma transição mais recente. A troca de
contexto solta os controles antes de mudar o destino dos comandos.

Os testes de blindagem e terreno usam o worker privado. O campo compartilhado
continua no servidor, inclusive quando a Oficina está na base ou um teste
privado está aberto. O projeto editável permanece no `Editor`; testes e
apresentação não substituem seu documento nem seu histórico.

`AimQueries` conserva as consultas físicas em um único objeto por cena, inclusive
na bancada da Oficina. `clearScene` libera o snapshot, o índice de colisão e as
trajetórias retidas, junto com a apresentação da mira. A suavização continua em
`AimPresentation`; poses interpoladas não entram no cálculo físico do disparo.

Pedidos de projetos em `field-designs.ts` pertencem ao intervalo em que a
construção está presente na facção. Ao sair dela, o pedido perde a validade;
uma nova entrada permite outra busca. Uma resposta do intervalo anterior não
substitui o projeto atual nem o devolve ao cache depois da saída.

As fábricas recebem os objetos existentes e as operações de interface/transporte
que precisam executar. Não há novo barramento, runtime, armazenamento ou
representação de estado a sincronizar. A composição fornece as superfícies
criadas posteriormente por acesso tardio, somente quando a ação acontece.

## Oficina e testes

Em `src/workshop-ux.ts`, a escolha da arma mantém seu alvo e a identidade do
documento juntos. O formulário de instalação, os gestos de crescimento de chapas,
os atalhos da paleta e os limites do setor têm entradas diretamente testáveis.
Os gestos e sua prévia visual compartilham o mesmo estado transitório.

Os testes substituem DOM, relógio, transporte ou GPU conforme a fronteira
exercitada. Editor, admissão, terreno e câmeras permanecem reais onde essas regras
determinam o resultado. Não se recortam funções do texto do código para executá-las
em VM. Confere-se o efeito observável: projeto salvo, gesto cancelado, controle
solto, câmera enquadrada e arma restaurada, sem exigir a identidade de objetos
temporários ou uma disposição específica das funções no arquivo.

Essa organização mantém coesas as responsabilidades, reúne o estado em sua fonte
e permite testar o comportamento em cada fronteira do jogo.
