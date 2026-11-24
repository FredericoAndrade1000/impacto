# Jogar por ferramentas

A ponte mantém um `NetworkClient` normal conectado ao campo. Cada chamada da
CLI conversa com esse processo por um canal IPC local; encerrar uma chamada
não desconecta o jogador nem envia a frota para casa. O planejador pode mudar
de estratégia enquanto ordens, fabricação, serviços e piloto continuam.

```powershell
npm run player -- start --session validation/player-session --server http://127.0.0.1:8404/ --name "Jogador de ferramentas"
```

Deixe esse processo aberto e use outro terminal para as operações abaixo.
Use a mesma revisão do projeto no cliente CLI e no servidor, especialmente
para as cotações locais e o contrato da rede.
Uma pasta representa uma conexão. Iniciar outra ponte na mesma pasta é
recusado antes de assumir o assento. Para retomar um assento existente, use
`--key-file` com um JSON privado contendo `key`; a ponte guarda a chave recebida
em `seat.json`. Chaves e segredos IPC não aparecem nas observações.

## Operações

| Operação | Uso |
| --- | --- |
| `observe` | Resumo da facção, frota, trabalhos, contatos conhecidos, fontes conhecidas, relógio, plano e cursor de eventos. |
| `inspect --actor c1` | Componentes, danos, recarga, montagem de armas, estado físico publicado do veículo, trabalho e ordens da própria facção. `--blueprint` pede seu projeto pelo protocolo normal. |
| `quote --model scout` | Cotação Native, requisitos industriais e faltas de estoque. A resposta lista os modelos disponíveis. |
| `send --file ordem.json` | Intenção tipada de grupo, fabricação, substituição, serviços ou infraestrutura. `--file -` lê JSON da entrada padrão. |
| `wait --after <cursor>` | Aguarda mudança relevante ou prazo, mantendo a conexão com o jogo. Aceita `--kinds contact,unit,stalled,duel`, `--sim-seconds 30` e `--wall-seconds 45`. |
| `plan --goal "..." --notes "..."` | Conserva a estratégia atual em `plan.json`; não instala outra política de IA. |
| `speed --factor 4 --reason "..."` | Ajusta somente o relógio de um servidor de testes. |
| `stop` | Encerra a ponte: é uma desconexão real, com o retorno normal do jogo. Para parar veículos, use uma ordem de grupo. |

Exemplo de ordem em `ordem.json`:

```json
{
  "op": "order",
  "observedAt": 120,
  "reason": "Reunir a força mantendo um guarda na base",
  "action": { "kind": "move", "ids": ["c1", "c2"], "x": 350 }
}
```

```powershell
npm run player -- send --session validation/player-session --file ordem.json --id reunir-forca-1
```

O mesmo identificador e a mesma intenção reaproveitam a resposta durante a
vida da ponte. Outro conteúdo com esse identificador é recusado. Isso evita
repetir uma compra quando só a resposta da ferramenta se perdeu. Um erro de
conexão com o campo pode deixar a execução incerta: consulte o estado antes de
decidir uma nova intenção. Reiniciar o processo não reproduz ordens antigas.

`ok` confirma a resposta da ferramenta. Ordens de grupo também conservam as
recusas e unidades retidas informadas pelo jogo; operações por unidade retornam
sucesso ou erro para cada identificador. A resposta de envio não certifica que
o deslocamento, serviço ou fabricação já terminou: acompanhe os eventos e o estado.

Fabricação, incluindo um projeto próprio:

```json
{ "op": "build", "design": { "model": "ifv" }, "reason": "Repor o blindado perdido" }
```

`design` aceita `model` ou `blueprint` no formato existente. `replaceId`
solicita uma substituição paga; também é aceito por `quote` para cotar a
diferença usando o valor residual publicado. `x` e `facing` são opcionais na
fabricação. A cotação não reserva dinheiro ou espaço: a admissão final e a
cobrança continuam no servidor, inclusive apoio e terreno.

Ordens de grupo: `move`, `attack`, `bombard`, `haul`, `home`, `stop`, `free`,
`turn` e `stance`. `auto`, `homing`, `repair`, `cancel-repair`, `remove`,
`cancel-dismantle`, `abandon` e `dump-cargo` também recebem `ids`. Recuperação,
salvamento, melhorias, estradas, postos e reboque usam os comandos normais
correspondentes. O contrato completo fica em `scripts/player/contract.ts`.

## Informação e tempo

O processo recebe apenas a conexão de jogador: facção, esquadrão e quadros
filtrados pela névoa. Não lê saves, observadores ou replays para decidir. Uma
lembrança continua marcada como lembrança; peças inimigas ausentes não
certificam ausência de armas. Contatos de outras facções devem ser lidos junto
dos acordos publicados, não como autorização automática para atacar.

O relógio inicia em **8×** quando o servidor oferece ferramentas de testes;
em um campo comum conserva o relógio autorizado. A orientação para os duelos
é tentar outras estratégias, composição e coordenação antes de reduzir para
4× ou 2×. A redução é explícita, com motivo registrado; não há redução
automática ao perder unidades. A física mantém seus passos normais.

`observedAt` registra a idade da decisão em segundos simulados no diário de
comandos. Eventos carregam o instante simulado e o horário de registro. O
cursor identifica a instância da ponte: após reiniciá-la, obtenha outro cursor
com `observe`. A fila mantém 512 eventos; um cursor expirado retorna uma
lacuna explícita e um estado atual.

Um alerta `stalled` indica 30 segundos simulados sem viagem observada de 1 m,
mudança de carga, munição ou integridade enquanto há uma ordem ativa. É um
indício para inspecionar o veículo, não um diagnóstico automático de física.
Serviços e unidades sem ordens não são tratados como viagens presas.

## Manutenção

| Arquivo | Responsabilidade |
| --- | --- |
| `scripts/player.ts` | CLI, início e retomada da conexão. |
| `scripts/player/contract.ts` | Intenções permitidas, validação e tipos derivados. |
| `scripts/player/observation.ts` | Projeção de informação pública e cotações existentes. |
| `scripts/player/session.ts` | Uma conexão, eventos, plano, serialização e respostas de comandos. |
| `scripts/player/transport.ts` | Canal IPC local autenticado e chamadas curtas da CLI. |

Verificação inicial: `npm run check` e
`node --test tests/player-bridge.test.ts tests/network-client.test.js`.
O teste de integração usa um campo técnico isolado com fabricação e custos
normais; verifica também a CLI em processos separados. Não é uma avaliação
de força da IA nem uma partida completa.
