# Benchmark mobile

O ponto de entrada é `npm run benchmark:mobile`. O perfil fica em
[`benchmarks/a15.json`](../benchmarks/a15.json); não repetir multiplicadores em
scripts de cada investigação. O jogo não importa esses módulos.

## Referência recuperada

Em 18/10/2026, o S20 FE Snapdragon 865 marcou **5,29 ± 0,40** no Speedometer 3.0;
a referência publicada do A15 4G foi **3,66**. Nesse computador, CPU 4× marcou
**3,74 ± 0,21**. É uma calibração histórica da thread principal, dependente do
host. Speedometer não fornece uma razão entre GPUs nem entre bandas de memória.

As capturas físicas disponíveis do benchmark do jogo foram feitas no S20 FE e
registraram temporizadores GPU indisponíveis. FPS perto de 60 pode estar limitado pela tela: não
usar seu inverso como tempo de GPU ou como multiplicador de CPU.

O perfil recuperado está, portanto, **incompleto para GPU e transferências**.
O comando padrão recusa anunciá-lo como uma simulação completa do A15.
`--diagnostic` permite comparar o código no desktop, preservando essa identificação
nos resultados. Não mudar um campo ausente para 1 nem obter sua razão do Speedometer.

## Executar e comparar

```powershell
npm run benchmark:mobile:prepare -- --output=validation/mobile-minha-rodada
# Depois da alteração, conservar a referência A e congelar a candidata B:
npm run benchmark:mobile:prepare -- --output=validation/mobile-minha-rodada --freeze=B
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --diagnostic
```

São gravações novas do Native atual: seis blindados andando, 48 construções em
combate, seis blindados com canhão para os efeitos e seis blindados em estrada
de terra (`dust`). A preparação verifica fonte, hash e perfil release de Native/Wasm. Cada
variante conserva seu `src`, manifesto e hash; as gravações não são recalculadas
entre variantes. Um overlay isolado também pode partir de uma referência:
`--freeze=E --base=A --overlay=src/effects.ts`.

O renderer real consome essas gravações em quatro casos: frota distante, combate
distante, panorama e inspeção próxima. Duas ordens inversas, dois segundos de
assentamento e seis medidos por janela. Primeiro desenho, picos, contagens e
erros são preservados; não há repetição automática de uma captura ruim.

Esse ensaio separa CPU de desenho, intervalos apresentados e duração assíncrona
dos comandos GPU. Não inclui física ao vivo, HUD completo, áudio nem transporte
de estados por WebSocket. Verificar esses caminhos no aplicativo completo quando
a mudança os atingir; não transformar FPS desse replay em FPS da partida.

## Vegetação e jazidas

A preparação atual também conserva as posições de uma região
arborizada e de jazidas do próprio terreno. Selecionar esses casos explicitamente:

```powershell
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=forest-entry,forest-far,forest-near,deposits-far --diagnostic
```

`forest-entry` cruza o limiar das árvores durante a janela útil, após 2,2 segundos.
Os outros casos comparam a vista distante, a próxima e os marcadores de jazidas.
O último acrescenta uma condição fixa de apresentação: jazidas conhecidas cujo
estoque muda a cada pacote. Não é uma simulação de extração ou tráfego de rede.
O relatório conta malhas de vegetação preparadas por quadro, plantas desenhadas
e reconstruções de marcadores. Inputs históricos sem essas posições continuam
servindo aos quatro casos originais; preparar uma gravação nova para estes casos.

## Fogo, disparos e ondas na vegetação

Selecionar os casos do mesmo benchmark:

```powershell
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=fire-close,fire-group,muzzle-close,explosion-near,vegetation-blast --diagnostic
# Explosão isolada, rajadas e poeira dos seis veículos gravados:
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=explosion-single,explosion-near,dust-group --diagnostic
# Poeira contínua na estrada de terra, com física e contatos Native:
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=dust-road-group --diagnostic
# Capturas visuais em instantes fixos, sem medição de desempenho:
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=fire-close,vegetation-blast --rounds=1 --functional --diagnostic
```

Esses casos conservam as poses reais da gravação `fire` e aplicam uma sequência
fixa de eventos locais por [mobile-effects-fixture](../scripts/mobile-effects-fixture.ts).
Não simulam perfuração do tanque, dano, consumo de munição ou tráfego de eventos
pela rede. A queima real deve ser conferida nos testes do núcleo e de integração.
As contagens incluem focos de incêndio, impulsos de vegetação e partículas.

Para acrescentar essa gravação a uma rodada anterior que ainda não a tenha,
usar `benchmark:mobile:prepare -- --output=validation/mobile-minha-rodada --record=fire`.
A operação exige os mesmos Native/Wasm e não sobrescreve a referência ou as gravações existentes.
As capturas funcionais aquecem os efeitos com pacotes anteriores e depois pausam
o relógio no instante escolhido; não misturar seus tempos com a medição.
`explosion-single` injeta somente uma detonação no pacote 60; `explosion-near`
repete a detonação a cada 30 pacotes. `dust-group` mantém os contatos e as poses
dos seis veículos da gravação `fleet`, ainda sobre o pavimento da base na maior
parte da janela; ele não representa poeira densa. `dust-road-group` usa a gravação
`dust`, em que a pista é preparada como terra compactada (`graded`) antes de
gravar a física Native. Ambos usam contatos reais, sem emissores artificiais.
Uma rodada antiga com os mesmos Native/Wasm pode acrescentar `--record=dust`
pela preparação, sem sobrescrever os outros inputs.
As fontes congeladas incluem a configuração TypeScript herdada por `src`.
O servidor do benchmark não monitora alterações no disco: os inputs são imutáveis
e o HMR fica desativado, evitando trabalho extra sobre capturas históricas.

### Fumaça densa e destroços

`--record=wreck` acrescenta uma gravação Native de 12 segundos, sem substituir
as existentes. Em 1,5 s, um veículo leve recebe uma condição inicial controlada
de lançamento: +4 m de altura, 6 m/s vertical, 3 m/s horizontal e 0,35 rad/s.
Uma explosão de potência 100 e raio 1,2 m atinge seu combustível. O lançamento
é imposto para testar a queda; não é uma alegação de impulso causado pela explosão.
Os eventos de queima e choque no terreno e todas as poses seguintes são Native.
A preparação exige eventos reais de explosão e contato no chão.

```powershell
npm run benchmark:mobile:prepare -- --output=validation/mobile-minha-rodada --record=wreck
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=fire-close,fire-group,explosion-near,muzzle-close,wreck-close --diagnostic
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=powder-smoke,wreck-rise,wreck-landing,wreck-close --rounds=1 --functional --diagnostic
```

As fotos de `wreck` recebem a gravação desde o início para conservar fumaça
e poeira de eventos antigos. A API `mobileBenchmark.replay()` reproduz todos os
pacotes cronologicamente até o final da gravação; serve de prévia visual, com
retorno dos instantes inicial/final e da quantidade de pacotes. Ela não faz uma
medição de desempenho. Fumaça branca de propelente, fuligem escura da combustão
e poeira da superfície usam os mesmos limites de partículas. Os quatro novos
quadros densos compartilham o atlas, que permanece abaixo de 4 MiB RGBA na base.

### Vídeos com câmera fixa

`--record=parked` grava seis veículos estacionados e `--record=wreck-ground`
grava o incêndio de um veículo no chão, sem impor altura ou velocidade de lançamento.
As duas gravações exigem elevação máxima inferior a 1 m em relação à pose inicial
e velocidade vertical máxima abaixo de 2,5 m/s. Os valores efetivos ficam em `stats`.
O antigo `wreck` continua sendo o teste de queda controlada e fica identificado
como histórico; não é a demonstração padrão dos efeitos.

`replay({steady:true})` fixa o enquadramento e desliga o tremor somente durante
a prévia. Os casos baseados em `parked` e `wreck-ground` já usam câmera fixa e
tremor desligado. O retorno inclui `cameraSpan` e `maxShakePixels`: os vídeos
estabilizados exigem zero nos dois. Isso não altera a câmera ou o tremor do jogo
nem os resultados dos casos anteriores do benchmark.

### Captura de vídeo em alta resolução

`replay({steady:true,captureScale:1920/844})` pode ser usado numa área de desenho
de 1920×888 pixels, com o mesmo campo de visão da prévia 844×390. A exportação
1920×1080 conserva essa proporção com faixas e verifica a resolução real do canvas;
não amplia o vídeo antigo. Essa opção é exclusiva da reprodução visual, sem mudar
o perfil ou as janelas medidas do benchmark.

Na revisão da poeira suspensa, os grãos finos usam movimento de fumaça e vida
de 5–6 segundos; os fragmentos sólidos desaparecem em até 0,55 segundo. A coluna
não recebe gravidade de detrito, e continua usando o atlas e as quotas existentes.

### Margens transparentes da fumaça

`createParticleAtlas` recorta somente as margens totalmente transparentes dos
oito quadros de fumaça leve e quatro de fumaça densa. O cálculo aproveita os
pixels já gerados, sem ler o canvas/GPU. `Texture.orig` conserva os 128×128
originais e `Texture.trim` conserva posição, escala e âncora; sobra um texel
transparente para amostragem linear. Não há cálculo adicional por quadro,
novo passe, redução de resolução ou alteração de emissões e vidas.

O experimento reproduzível está em `validation/smoke-cost-20261115/`: A é a
revisão anterior E da poeira suspensa; B testa o recorte com leitura inicial do
canvas; C adiciona composição em meia resolução; D é o recorte final sem leitura
do canvas. A matriz inicial cobre cinco casos em duas ordens inversas; a
verificação final A/D repete os dois casos mais carregados. O perfil continua
sendo diagnóstico de desktop, CPU 4× e GPU nativa. A economia de área dos quads
não equivale à mesma redução do tempo total da GPU ou da memória do atlas.

A composição global em meia resolução foi descartada: no grupo de seis
incêndios, seus passes adicionais aumentaram CPU e a mediana do temporizador
GPU. A atribuição complementar em `cpu-phases.json` separa cálculos dos efeitos
de submissão de desenho, que inclui chamadas do driver e possíveis esperas;
essa última medida não é tempo puro de execução da GPU. Os resultados completos,
incluindo quadros lentos, ficam nos respectivos `run-*/summary.json`.

### Submissão das esteiras

O experimento `validation/draw-submission-20261115/` separa chamadas WebGL,
tipos de desenho e amostras de CPU dentro da janela útil de submissão. Perfis
instrumentados são complementares; comparações principais continuam usando o
benchmark compartilhado sem esses medidores adicionais.

No nível de detalhe intermediário, `TrackLinks` conserva só corpos e juntas:
10 vértices e 18 índices por elo, em vez de 18 e 30. As duas faces que antes
eram colapsadas em pontos não tinham área visível. O zoom que ativa os detalhes
continua o mesmo; posições, UVs, contornos e textura das faces visíveis são
preservados. A topologia só muda com a quantidade de elos ou a troca de LOD;
movimento no mesmo LOD reutiliza os buffers. A política `no-batch` permanece.

As variantes B/C ampliaram batching de superfícies comuns; D/E testaram batching
das coberturas e elos das esteiras. Elas foram descartadas. F omite somente os
triângulos invisíveis. `muzzle-close` e `smoke-black-steady` exercitam o LOD
intermediário; os casos de incêndio a zoom 10, 45 e 65 servem também de controle,
pois seus elos estão escondidos ou usam a geometria detalhada. As transições
24 → 30 → 32 → 45 → 65 → 30 são verificadas no renderer real. Os limites do
diagnóstico de desktop continuam válidos; menor volume enviado não é sinônimo
de um ganho igual de FPS ou de tempo de GPU.

## Propulsores

Acrescentar `--record=flight` pela mesma preparação. A gravação contém seis
aeronaves com quatro propulsores cada, com poses e empuxos do Native. Não injeta
um jato artificial numa peça de outro tipo. Usar `jet-close`, `jet-group` e
`jet-far` para comparar desenho próximo, grupo e distância. `jet-ground` é uma
captura funcional da decolagem, com contato no chão; a janela medida de 2–8 s
já ocorre em voo e não deve ser anunciada como benchmark de poeira de decolagem.

```powershell
npm run benchmark:mobile:prepare -- --output=validation/mobile-minha-rodada --record=flight
npm run benchmark:mobile -- --input=validation/mobile-minha-rodada --variants=A,B --cases=jet-close,jet-group,jet-far --diagnostic
```

## Quais limites são aplicados

| Domínio | Implementação e alcance |
| --- | --- |
| CPU | Throttle da thread principal pelo CDP, com fator e host registrados. Não limita o servidor nem todo Worker. |
| GPU | Com calibração do mesmo benchmark, a quota usa durações GPU válidas e controla a cadência de trabalho submetido. A GPU desktop continua executando seus comandos em velocidade nativa; isto é orçamento relativo, não emulação de uma Mali. |
| Transferências | Orçamento para bytes enviados a buffers e texturas WebGL. Conta a faixa/retângulo realmente enviado, separado de capacidade e alocação. Não representa leituras de shaders, caches, cópias JS arbitrárias ou toda a banda física da RAM/VRAM. |
| Rede | Proxy TCP local com banda agregada por sentido e metade da latência em cada sentido. Inclui HTTP, handshake e WebSockets comprimidos. Nenhum formato do jogo é alterado. |

`--network` aplica a condição do perfil ao acesso ao servidor do benchmark.
Nesse replay ela afeta carregamento de assets; não há tráfego de estados durante
as janelas. Para validar o jogo online, usar `mobileNetwork` de
[`scripts/mobile-network.ts`](../scripts/mobile-network.ts) apontado para um
servidor de testes separado e conectar o cliente à porta do proxy. Seus testes
conferem duas conexões compartilhando a banda e uma troca WebSocket comprimida.

```powershell
node scripts/mobile-network-cli.ts --target=8411 --port=8413
# Abrir http://127.0.0.1:8413/ para acessar o servidor de testes da porta 8411.
```

Os **8 Mbps de download, 2 Mbps de upload e 80 ms de RTT** são uma condição de
teste explícita, não características do A15. Uma rede degradada é outro cenário;
não alterar o perfil gráfico para compensá-la. A banda de RAM/VRAM inteira não
tem um limitador físico por aba no navegador. Não alegar que uma espera entre
quadros, um teto de memória ou a quota de uploads reproduz esse hardware.

Para concluir a calibração, conservar o resultado bruto, dispositivo, método,
versão, hashes de inputs/benchmark e host. Uma referência com outro método de
medição ou com GPU ausente não qualifica um perfil completo. Os relatórios
históricos de CPU 4× permanecem diagnósticos de desktop; a padronização não muda
retroativamente o que foi medido.

O [Chrome documenta](https://developer.chrome.com/blog/devtools-grounded-real-world)
que o throttle de CPU não limita o processo GPU e não reproduz memória ou
comportamento térmico do telefone. Não alterar clocks globais do computador
para rodar este benchmark.
