# Visualizador de replay

Abra uma gravação do servidor sem conectar um jogador nem modificar o campo:

```powershell
npm run replay:viewer -- caminho/do/campo --port 8440
```

Acesse `http://127.0.0.1:8440/`. É possível indicar vários arquivos ou pastas;
uma pasta de campo usa seu subdiretório `replays`. O serviço escuta apenas na
própria máquina. Não inicia o servidor do jogo nem carrega seu save para escrita.

Escolha **Replay completo** para assistir todos os capítulos disponíveis do mesmo
campo em sequência, ou selecione uma gravação individual pela data. Clique em
**Abrir replay** e aguarde a preparação. Depois use a linha do tempo, pausa, passos de um segundo e velocidades
de 0,25× a 32×. As setas avançam ou voltam um segundo; Shift aumenta para dez.
Espaço pausa quando o foco está no campo. Arraste a câmera e use a roda para zoom.

O painel filtra facções, mostra estoques e atividades e permite localizar ou
acompanhar veículos. Círculos representam veículos, quadrados representam
estruturas e losangos marcam bases na visão geral. **Somente estruturas** filtra
a lista e os eventos para facilitar a inspeção. Bases e construções fixas são
desenhadas no campo. Clicar em um evento leva ao seu instante e localiza o objeto.
O seletor de capítulos permite saltar entre trechos sem abrir outra gravação.

Nas validações de IA, a entrega padrão é o replay integral de cada cenário,
incluindo preparação física, economia, deslocamentos, combate e desfecho durante
todo o período simulado. Marcadores ajudam a navegar; não substituem esse replay.
Informe a duração, o resultado da verificação e se houve desfecho ou encerramento
por limite de tempo. Em um campo que continua rodando,
informe até qual instante a cópia preparada cobre a gravação.

## O que é reproduzido

O worker executa o mesmo `replayField` da ferramenta de diagnóstico e compara os
prints do diário. Um observador separado publica a cena completa, sem neblina de
guerra, usando o protocolo e o renderizador do jogo. Ele não chama `tell`, não
consome eventos do campo e não gera ordens. Os eventos são observados também
antes de cada `tell` gravado e do descarte de eventos em campos sem jogadores
conectados, para que disparos das IAs não desapareçam na publicação.

Os quadros visuais são amostrados até 20 Hz, nos instantes em que a própria
gravação leu a cena, e interpolados durante a exibição. Passos silenciosos não
antecipam a leitura de eventos para desenhar um quadro. Quando necessário, os
quadros inicial e final são extraídos de checkpoints privados, sem alterar o
campo reproduzido. Campos silenciosos usam essas cópias até 10 Hz. O quadro
final corresponde ao último print verificado, incluindo os eventos ainda
pendentes nesse limite. A
simulação mantém seu passo original. A câmera é livre e os efeitos visuais são
recriados; isto não é um vídeo da câmera original nem uma reprodução de áudio.
A linha do tempo completa soma a duração confirmada dos capítulos. O rodapé mostra
também o relógio original do campo. Uma retomada de checkpoint pode recuar esse
relógio: o trecho é preservado, sem interpolar veículos entre os dois estados.
Os horários internos de eventos e serviços continuam sendo os do mundo original.

Uma divergência ou falha identifica a reprodução como parcial. Quadros depois
do último print confirmado são descartados, incluindo a cauda incompleta de um
diário ativo. Outra versão do diário, contrato, save, protocolo ou build/plataforma
do núcleo é recusada. Preserve esses arquivos e use a versão que os gravou.

## Limites e manutenção

A preparação usa um worker por vez e congela cópias de todos os capítulos antes de
começar. Gravações que chegarem depois ficam para a próxima preparação. O cache fica
em `validation/replay-viewer/cache`; `--cache pasta` escolhe outro diretório.
Reabrir a mesma entrada com o mesmo código reaproveita os trechos preparados.
Cancelar encerra o worker e remove somente sua tentativa ainda não publicada.
Um replay preparado pode ser reaberto por `?replay=ID_DO_ARQUIVO_PREPARADO`, usando
o ID de 24 caracteres retornado pela API; o cache restaura os vínculos dos capítulos.

São listados todos os capítulos disponíveis por pasta, inclusive os mais antigos
de gravações longas. Cada entrada pode ter até
128 MiB, inclusive após descompressão, e 15 minutos por capítulo; uma preparação
completa aceita até 1 GiB de entradas. Cada trecho visual tem limite de 64 MiB
descomprimidos e cada capítulo até 512 MiB comprimidos. A composição completa
referencia esses trechos, sem duplicá-los. O navegador retém no máximo três
trechos decodificados. Os saves e
diários originais não são servidos pelo servidor HTTP; a API recebe IDs da lista,
sem caminhos fornecidos pelo navegador.

O cache de dependências do Vite fica separado por porta em
`node_modules/.vite-replay`, permitindo abrir visualizadores de builds diferentes
ao mesmo tempo sem disputar arquivos temporários.

O fluxo está em `scripts/replay-viewer.ts` → `server/replay-viewer.ts` →
`server/replay-export-worker.ts` / `server/replay-recording.ts` →
`server/replay-series.ts` (composição dos capítulos) →
`src/replay-player.ts` / `src/replay-viewer.ts`. O formato visual está em
`src/replay-contract.ts`; ele não altera o contrato do diário.

Validação: `npm run check`, `tests/replay-viewer.test.ts` e
`tests/field-replay.test.js`. Execute a integração de exportação com
`$env:IMPACTO_DYNAMICS_RUNTIME='native'`; snapshots binários e o exportador do
servidor pertencem ao Native. Os casos de relógio e enquadramento de pacotes
também rodam em Wasm.
