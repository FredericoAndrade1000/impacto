# Contratos TypeScript

O código autoral do cliente, servidor e ferramentas usa TypeScript, com uma única implementação
executável. Node 22.18 ou superior remove os tipos diretamente; o Vite existente
prepara o código do navegador. São usados somente tipos apagáveis, imports ESM
com extensão explícita e nenhum alias de caminho que dependa de transformação.

`npm run typecheck` verifica o código migrado em modo estrito, incluindo leitura
de índices e propriedades opcionais. O programa Node cobre servidor, ferramentas
e testes; o programa do navegador cobre `src`. `scripts/check-typescript.ts`
recusa novos módulos JavaScript nessas três áreas, para não contornar a checagem.
Os bindings Wasm gerados em `src/native` e os testes legados continuam em JavaScript;
não há cópias JavaScript dos módulos TypeScript.

TypeScript 7 executa a checagem. A API TypeScript 6 é uma dependência de
desenvolvimento para analisar fontes nos verificadores; não entra no jogo ou no
servidor. Stamps e grafo de módulos usam a remoção nativa de tipos do Node.

Build e testes executam a checagem de tipos. O runner descobre `.test.js`,
`.test.mjs`, `.test.cjs`, `.test.ts`, `.test.mts` e `.test.cts`. Os carimbos de
versão seguem dependências executáveis, incluindo workers; imports somente de
tipos e declarações não introduzem dependências de execução.

Entradas externas entram como `unknown` e são validadas pelo proprietário do
contrato. Dados internos usam tipos explícitos nas bordas; inferência atende os
detalhes locais. Uma afirmação de tipo não substitui validação ou autoria do
contrato. Física e seus dados derivados continuam pertencendo ao Native.

## Catálogos e geometria compartilhados

`materials.ts`, `weapons.ts`, `combat-sensors.ts`, `weapon-mounts.ts` e
`construction-template-catalogue.ts` são os donos dos IDs e opções de seus
catálogos. Derive as escolhas desses módulos; não mantenha uma segunda união de
strings no consumidor. Os rótulos autorais usam `MessageKey`, inclusive os que
a interface ainda não exibe.

`math.ts` define pontos, poses e bases geométricas. Os leitores de blindagem,
casco, terreno e ferramentas declaram somente os campos de que precisam. Esses
tipos estruturais não substituem o documento completo de construção ou a cena
Native. Um componente de referência e um componente com dimensões compiladas
têm entradas diferentes em `component-size.ts`.

## Mensagens e idiomas

`src/message-contract.ts` define a mensagem canônica: chave em português e valores
separados. `phrase`, `tr` e `userError` compartilham esse contrato; nomes do jogador,
quantidades e mensagens aninhadas entram como valores, nunca como novas chaves.
Por exemplo, `userError` recebe a frase marcada
`` `Leve a construção até a base para ${phrase('reparar')}.` ``. O servidor mantém
o erro canônico em português e a página apresenta a mensagem no idioma escolhido.

Chaves literais e seus parâmetros são verificados pelo TypeScript. O verificador
`npm run check:translations` também cobre frases marcadas e
os catálogos finitos usados em chamadas dinâmicas. Ao criar um rótulo, acrescente a
tradução inglesa e preserve os parâmetros da frase. Não traduza novamente um
rótulo que o produtor já localizou.

Uma resposta externa é diferente de uma mensagem autoral. `messageText` valida
o envelope recebido como `unknown`, incluindo profundidade e limites de tamanho;
`errorText` preserva a leitura de recusas antigas. Esse caminho de compatibilidade
não deve ser usado para contornar a checagem de uma nova mensagem. A tradução da
página HTML inicial fica em `localize-page.ts`; não instala observadores de DOM.

## Fronteiras

`native-host-contract.ts` identifica o host e mantém seus bindings como dados
externos. `native-dynamics.ts` confere o contrato de versão e as funções usadas;
as respostas JSON começam como `unknown`. `ballistic-contract.ts` discrimina
solução, ponto e trajetória; `ground-response-contract.ts` admite o retorno de
ricochete. Esses decoders conferem o formato, preservam as referências e não
recalculam física. `construction-codec.ts` valida as respostas de compilação,
custos e instalação. `ConstructionSource` aceita omissões legítimas do documento
autoral, como ângulos ainda não definidos; `CompiledConstruction` representa o
resultado admitido pelo Native. Não complete o documento salvo para satisfazer
o tipo de um leitor.

O host Node em `scripts/native-dynamics-host.ts` carrega o addon verificado; o
host do navegador em `wasm-dynamics-host.ts` carrega os mesmos bindings Wasm.
Mantenha ambos os caminhos nos testes de integração. Trocar uma ferramenta da
receita de build exige preparar novamente os artefatos, mesmo sem mudar Rust.

O codec em `src/network-codec.ts` conhece o cabeçalho, os limites e as três formas
binárias (`f32`, `u32`, `f64`). O JSON recebido começa como `unknown`; o codec
valida a moldura e as referências antes de devolver o pacote. A interpretação de
estados, eventos e deltas continua em `network-protocol.ts`. O transporte mantém
a cena opaca até o decoder do consumidor: `decodeFieldView` admite o estado da
interface; `decodeDrawingScene` admite somente a geometria necessária ao desenho.
`scene-contract.ts` descreve a cena física, e `scene-drawing-contract.ts` permite
observações parciais publicadas pelo Fog, sem inventar saúde, capacidade ou pose.
Os decoders reutilizam a validação de registros imutáveis e verificam novamente
o envelope que pode mudar. Não acrescente uma segunda varredura profunda de
todos os componentes a cada quadro.

`server/field-save.ts` possui apenas o envelope versionado e a gravação atômica.
O payload continua pertencendo a `SharedRoom.keep/resume`; `room-save.ts` valida
a entrada fria da sala, enquanto cenas e atividades seguem para seus donos.
O armazenamento não declara uma cópia completa do modelo da sala. Os contratos
existentes só mudam de versão quando o formato ou o significado muda, não pela
troca de extensão do código.

Os DTOs Rust de veículo e powertrain em `game_dto.rs` são a fonte de
`src/native-contract.gen.ts`. `npm run generate:native-contract` atualiza esse
arquivo; `npm run check:native-contract` recusa uma saída desatualizada e faz parte
dos testes Rust. A feature `typegen` e `ts-rs` servem à geração, sem entrar no núcleo
de produção. Não edite o tipo gerado à mão nem escreva uma declaração equivalente
no cliente. `native-vehicle.ts` usa o contrato na projeção real; os decoders em
`native-frame-contract.ts` e `native-world-contract.ts` conferem as fronteiras de
frames e bindings, sem duplicar o modelo físico. Um frame vivo diz em palavras o
que muda por evento (armas, marcas, dano das chapas) e, num bloco `f64` lido uma
vez por `frame_block`, o que muda a cada passo: poses, molas, contato com o chão,
olhos e veículo. Cada lista leva só o que mudou desde o último frame. `RustGame`
lê o bloco na ordem em que [game_frame.rs](../native/dynamics/src/game_frame.rs)
o escreve; um frame frio continua inteiro em palavras.

## Preservar o comportamento ao tipar

Use `declare` em campos que só descrevem atribuições já feitas pelo construtor
ou pelo ciclo de vida. Um campo emitido com `undefined` ou uma inicialização
defensiva nova pode mudar ordem, presença de propriedades ou retomada. Um leitor
deve pedir apenas os campos que consome; use os contratos portáveis de campo,
publicação e serviços, sem importar a implementação da sala para a interface.

Valide o fluxo afetado com dados reais de compilação, publicação e replay. Mocks
que atravessam uma fronteira externa precisam formar uma mensagem válida; não
enfraqueça o decoder para aceitar um mock incompleto. Veja o
[mapa de manutenção](maintenance-map.md#quanto-validar) para escolher os recortes.

## Serviços e automático

`construction-service.ts` define construção, reparo, giro e desmontagem, suas
factories, avanço e projeções. Desmontagem usa progresso, sem prazo inventado;
reparo conserva pagamento e reservas. `service-presentation.ts` lê esse contrato
e mantém os recibos separados das esperas com prazo.

`automatic-jobs.ts` reúne as famílias de trabalho, prioridades e a projeção
publicada por `SupplyDispatch.view`. A fase da viagem do Squad continua diferente
da fase de despacho. `automatic-presentation.ts` exige tratamento de cada família
e mantém nomes do jogador como dados. As opções de automático, controle manual,
serviço ativo e tarefa atribuída continuam independentes.

`economy-contract.ts` possui os valores de orçamento e reservas usados nesses
fluxos; deriva os IDs dos catálogos existentes. Não acrescente outro catálogo de
recursos ou uma cópia do estado da sala. Tipos e funções pequenas atendem esses
contratos; uma hierarquia de classes não é necessária.
