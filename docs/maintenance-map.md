# Mapa de manutenção

Comece pela mudança desejada, encontre quem decide a regra e abra o teste vizinho.
Este mapa aponta os caminhos principais; o código e os testes definem os detalhes.
Para executar ou preparar Native/Wasm, use o [README](../README.md#desenvolver).

## Onde mexer

| Mudança | Ponto de entrada e responsabilidade | Verificação inicial |
| --- | --- | --- |
| Jogador controlado por ferramentas | [player](../scripts/player.ts) mantém a CLI; [contrato](../scripts/player/contract.ts) valida intenções; [observação](../scripts/player/observation.ts) resume dados do jogador; [sessão](../scripts/player/session.ts) conserva a conexão e os eventos; [transporte](../scripts/player/transport.ts) fornece IPC local. Piloto, balística, serviços e admissão continuam existentes. Ver [uso e limites](player-bridge.md). | [player-bridge](../tests/player-bridge.test.ts), [network-client](../tests/network-client.test.js), `npm run check` |
| Reparos adiados pela IA | [commander-maintenance](../server/commander-maintenance.ts) compara o custo com as reservas da política; [faction-commander](../server/faction-commander.ts) conserva a intenção e envia Cancelar/Reparar. Os serviços existentes cobram e reembolsam. Automático, movimento e trabalho ativo mantêm sua autoridade. | [commander-maintenance](../tests/commander-maintenance.test.ts), [commander-policy](../tests/commander-policy.test.ts), [commander-state](../tests/commander-state.test.ts) |
| Provisão inicial e auxílio | [room](../server/room.ts): `join` concede o pacote só à identidade nova; `found`/`part` criam facção vazia. `subsidyAt` reúne o histórico da facção e dos membros; `recover` registra os beneficiários e `leave` conserva a data. `keep`/`resume` preservam o campo opcional sem invalidar JSON antigo; a versão do diário fica em `field-host`. | [faction-grants](../tests/faction-grants.test.js), `npm run review:industry:abuse -- --expect-fixed` |
| Estratégia de uma facção autônoma | [commander-observation](../server/commander-observation.ts) limita a informação; [commander-policy](../server/commander-policy.ts) prioriza economia e defesa; [commander-defense](../server/commander-defense.ts) posiciona a guarda; [commander-tactics](../server/commander-tactics.ts) mantém a interceptação e [commander-operations](../server/commander-operations.ts) a operação terrestre com prazo; [faction-commander](../server/faction-commander.ts) executa comandos normais e conserva memória limitada. Serviços, piloto e física continuam com seus proprietários. Ver [escopo e execução](faction-commander.md). | [commander-policy](../tests/commander-policy.test.ts), [commander-operations](../tests/commander-operations.test.ts), [commander-tactics](../tests/commander-tactics.test.ts), [commander-perception](../tests/commander-perception.test.js), [commander-interception](../tests/commander-interception.test.js), `npm run review:commanders -- --verify-repeat`, `npm run review:commander-combat -- --scenario operations` |
| População de IA no campo público | [field-config](../server/field-config.ts) autoriza o modo; [commander-population](../server/commander-population.ts) agenda criações pelo host, fora do replay; [room-limits](../server/room-limits.ts) conserva a capacidade humana. Identidades persistem; configuração não concede ferramentas de testes. | [commander-population](../tests/commander-population.test.js), [commander-worker](../tests/commander-worker.test.js), [commander-room](../tests/commander-room.test.js) |
| Local da base e acesso inicial | [room](../server/room.ts): `settle` compara locais sem mover recursos; `baseDeposits` prefere fontes utilizáveis e `stake` identifica Ferro/Petróleo. Fundação e reconstrução compartilham a política. Ver [regras e limites da evidência](balanceamento.md#continuação-acesso-inicial-aos-recursos). | [base-placement](../tests/base-placement.test.js), `npm run review:resources -- --verify-repeat`; acrescentar `--occupied` para esgotamento e recuperação com frotas existentes. |
| Telas, controles e transições Oficina/Campo/Testes | [Contextos do cliente](client-context.md): cada interação tem seu proprietário; `main.ts` faz a composição. | [main-camera-transitions](../tests/main-camera-transitions.test.js), [trial-controls](../tests/trial-controls.test.js) |
| Montagem, chapas e encaixes | [Editor](../src/editor.ts) e [frame-editing](../src/frame-editing.ts) alteram o documento; a admissão confirma se o projeto é válido. | [workshop-surface-mounts](../tests/workshop-surface-mounts.test.js), [structured-construction](../tests/structured-construction.test.js) |
| Modelos prontos e equipamentos | [Catálogo de modelos](../src/construction-template-catalogue.ts) descreve as opções; [game_templates.rs](../native/dynamics/src/game_templates.rs) gera os projetos. Equipamentos entram pelo [catálogo de admissão](../src/construction-admission.ts). | [construction-templates](../tests/construction-templates.test.js), [construction-catalogue](../tests/construction-catalogue.test.js) |
| Fabricação e instalações | [manufacturing](../server/manufacturing.ts) decide admissão e espaço sem cobrar; a sala autoriza e executa. [industry](../server/industry.ts) mantém pagamentos/níveis; [catálogo](../src/industry.ts), [exemplos](../src/industry-examples.ts) e [interface](../src/industry-ui.ts) usam a mesma admissão Native. Ver [progressão](industrial-progression.md). | [manufacturing-placement](../tests/manufacturing-placement.test.js), [field-economy](../tests/field-economy.test.js), [industry](../tests/industry.test.js), [industry-ui](../tests/industry-ui.test.js), [exemplos](../tests/industry-examples.test.js), [conversão](../tests/field-industry-conversion.test.js) |
| Porte industrial e balanceamento | [game_construction.rs](../native/dynamics/src/game_construction.rs) publica massa vazia e envelope em `compiled.manufacturing`; [industry](../src/industry.ts) aplica os requisitos atuais. [Regras e hipóteses por fluxo](balanceamento.md) orientam custos/logística preservando a física. | [manufacturing-metrics](../tests/manufacturing-metrics.test.js), `npm run review:industry`, `npm run review:industry:openings`, `npm run review:mining -- --verify-repeat` |
| Idioma e textos | [i18n](../src/i18n.ts) resolve frases de [inglês](../src/locales/en.ts); [bootstrap](../src/bootstrap.ts) escolhe idioma antes das interfaces. [user-message](../src/user-message.ts) valida e transporta recusas sem traduzir dados do jogador. Ver [tradução](localization.md) e [contratos TypeScript](typescript.md). | `npm run check:translations`, [i18n](../tests/i18n.test.js), verificação visual PT/EN |
| Marcadores de obras e infraestrutura | [SiteMarkers](../src/site-markers.ts) possui arte, rótulos, áreas de clique e descarte de postos, obras, montes e estradas; `Renderer` compõe e conserva bases e jazidas. | [post-render](../tests/post-render.test.js), [work-art](../tests/work-art.test.js), [extraction-render](../tests/extraction-render.test.js) |
| Mira, obstrução e previsão de impacto | [AimQueries](../src/aim-queries.ts) consulta o snapshot físico e possui os caches de solução, colisão, trajetória e marcas de tempo; o renderizador fornece as entradas e limpa o conjunto ao sair da cena. [AimPresentation](../src/weapon-presentation.ts) suaviza o desenho usando as poses apresentadas. | [aim-sector](../tests/aim-sector.test.js), [impact-preview-performance](../tests/impact-preview-performance.test.js), [weapon-editor-current](../tests/weapon-editor-current.test.js), [presented-frame](../tests/presented-frame.test.js) |
| Automático, deslocamento e ordens | [SupplyDispatch](../server/supply-dispatch.ts) atribui tarefas; [automatic-jobs](../src/automatic-jobs.ts) define famílias e projeções; [Squad](../src/squad.ts) executa as ordens e conduz. A [sala](../server/room.ts) autoriza os comandos; [automatic-presentation](../src/automatic-presentation.ts) explica o trabalho publicado. Ver [fluxos e interrupções](automatic-services.md). | [supply-dispatch](../tests/supply-dispatch.test.js), [automatic-jobs](../tests/automatic-jobs.test.ts), [network-squad](../tests/network-squad.test.js) |
| Recursos, reparos e construções | [Economia](../src/economy.ts) calcula e cobra abastecimento pelos litros transferidos; [service-policy](../server/service-policy.ts) escolhe ofertas; a sala cobra e executa. [construction-service](../src/construction-service.ts) possui variantes, avanço e projeções dos serviços; [service-presentation](../src/service-presentation.ts) apresenta esperas e recibos. [Works](../server/field-construction.ts) monta/desmonta; [Roadworks](../server/road-works.ts) faz estradas. Ver [como ler o painel](automatic-services.md#ler-os-recursos-no-painel). | [field-economy](../tests/field-economy.test.js), [service-feedback](../tests/service-feedback.test.js) (conservação de combustível), [construction-service](../tests/construction-service.test.ts), [field-construction](../tests/field-construction.test.js), [road-works](../tests/road-works.test.js), [field-panel](../tests/field-panel.test.js) |
| Desenho, efeitos e desempenho visual | [Renderer](../src/render.ts) coordena a cena e conserva os marcadores de jazidas; [scene-frame](../src/scene-frame.ts) fornece poses/contornos; [TerrainScene](../src/terrain-scene.ts) prepara terreno e vegetação por trechos; [Effects](../src/effects.ts) emite fogo/fumaça nos pontos visíveis de [fire-surface](../src/fire-surface.ts); [surface-light](../src/surface-light.ts) reutiliza as fontes dos efeitos para iluminar materiais e chão, com limites por qualidade; [vegetation-motion](../src/vegetation-motion.ts) fornece impulsos visuais ao shader das plantas. [game_fire.rs](../native/dynamics/src/game_fire.rs) calcula combustão e aquecimento locais, consome apenas o material aceso e usa material e espessura da geometria para atenuar calor, inclusive até rodas e esteiras próximas; a apresentação agrega os focos internos; o cliente só apresenta os eventos. | [render-label-visibility](../tests/render-label-visibility.test.js), [scenery-lod](../tests/scenery-lod.test.js), [vegetation-motion](../tests/vegetation-motion.test.js), [effects-events](../tests/effects-events.test.js), [surface-light](../tests/surface-light.test.js) |
| Medir desempenho e comparar cargas | [physics-worker](../server/physics-worker.ts) executa o campo; [ClientPerformance](../src/client-performance.ts) observa quadros reais; [performance-report](../scripts/performance-report.ts) resume as janelas offline. Para celular, usar o [benchmark e perfil compartilhados](mobile-performance.md). | [client-performance](../tests/client-performance.test.js), [client-performance-network](../tests/client-performance-network.test.js), [mobile-profile](../tests/mobile-profile.test.js), [mobile-network](../tests/mobile-network.test.js) |
| Física, dano e sensores | [Núcleo Rust](../native/dynamics/src/game.rs) é a autoridade; [native-dynamics](../src/native-dynamics.ts) faz a fronteira TypeScript. [ballistic-contract](../src/ballistic-contract.ts) e [ground-response-contract](../src/ground-response-contract.ts) validam respostas externas sem recalcular física. Movimento, projéteis, dano e sensores têm módulos `game_*` próprios. | Testes Rust do domínio, [incêndio compartilhado](../tests/shared-fire.test.js) e integração correspondente: por exemplo, [physics](../tests/physics.test.js) ou [terrain-speed](../tests/terrain-speed.test.js). |
| Paralelismo do servidor | [game_parallel.rs](../native/dynamics/src/game_parallel.rs) limita o pool Native de sensores e pilotos e dá à física um pool próprio de uma thread (com mais, o Rapier 0.36 pode travar esperando a otimização adiada da BVH); [lib.rs](../native/dynamics/src/lib.rs) associa a física a esse pool inclusive após um checkpoint. [game_pilot.rs](../native/dynamics/src/game_pilot.rs) prepara observações em ordem e distribui cálculos independentes, aplicando resultados na ordem dos pedidos. Pilotos repetidos e aliases de componentes conservam a sequência original. | Testes Rust de `game_parallel` e `game::pilot`, [parallel-pilots](../tests/parallel-pilots.test.js), [network-squad](../tests/network-squad.test.js), [field-replay](../tests/field-replay.test.js) e [field-save](../tests/field-save.test.js). Comparar custo do lote e passo completo no mesmo campo e com a mesma cadência. |
| Presença no chão e em voo | Native calcula `grounded` (apoio físico), `flying` (modo de voo) e `thrustN` (empuxo disponível, inclusive na admissão). [game_motion.rs](../native/dynamics/src/game_motion.rs) calcula; [game_dto.rs](../native/dynamics/src/game_dto.rs) define a projeção única de snapshots (em palavras) e frames vivos (em números) e gera os tipos consumidos por [native-vehicle](../src/native-vehicle.ts). `room.besiege` exige apoio igual para capturar e contestar; velocidade baixa não prova apoio. | `npm run check:native-contract`, [aircraft-grounded](../tests/aircraft-grounded.test.js), [flight](../tests/flight.test.js), [base-capture](../tests/base-capture.test.js), [post-capture](../tests/post-capture.test.js) |
| Rede, alianças e informação visível | [network-server](../server/network-server.ts) transporta; [network-codec](../src/network-codec.ts) valida a moldura binária; [network-protocol](../src/network-protocol.ts) interpreta estados, eventos e deltas. A [sala](../server/room.ts) autoriza acordos; [Fog](../server/fog.ts) filtra o que cada facção pode saber. | [network](../tests/network.test.js), [network-codec](../tests/network-codec.test.ts), [fog-field](../tests/fog-field.test.js), [social-network](../tests/social-network.test.js) |
| Projetos salvos, campo e replay | [project-workspace](../src/project-workspace.ts) e [persistence](../src/persistence.ts) cuidam do projeto; [field-save](../server/field-save.ts) valida o envelope e grava o campo; [field-host](../server/field-host.ts) mantém diário e replay. O [visualizador](replay-viewer.md) observa os mesmos replays em um worker separado. Ver [retomada, reconexão e comandos pendentes](field-recovery.md). | [project-workspace](../tests/project-workspace.test.js), [field-save](../tests/field-save.test.js), [network-save](../tests/network-save.test.js), [field-replay](../tests/field-replay.test.js), [replay-viewer](../tests/replay-viewer.test.ts) |
| Áudio | [SoundSystem](../src/audio.ts) interpreta estado/eventos e mistura os jatos pelo empuxo público; [suspension-sound-gate](../src/suspension-sound-gate.ts) detecta compressões nos deslocamentos já publicados; [sound-art](../src/sound-art.ts) descreve os sons. | [assembly-audio](../tests/assembly-audio.test.js), [audio-distance](../tests/audio-distance.test.js), [vehicle-motion-sound](../tests/vehicle-motion-sound.test.js) |

## Como seguir uma mudança

**Um componente novo** atravessa autoria → catálogo/admissão → núcleo → estado
publicado → apresentação. Confira custo, dimensões, instalação, dano e retomada
somente onde esse componente introduz comportamento. Não acrescente uma regra
visual para compensar uma geometria física incorreta.

**Uma nova propriedade** pode atravessar mais de um contrato. Confira o que
mudou de forma ou significado, sem elevar todas as versões por rotina:

| Contrato | Definição |
| --- | --- |
| Documento do projeto | `DESIGN_VERSION` em [design-contract](../src/design-contract.ts) |
| Interface JS/Rust e snapshots do núcleo | `CORE_CONTRACT` em [native-dynamics](../src/native-dynamics.ts); contrato correspondente em [lib.rs](../native/dynamics/src/lib.rs) |
| Cliente/servidor | `NETWORK_VERSION` em [network-protocol](../src/network-protocol.ts) |
| Campo JSON | `FIELD_SAVE` em [field-save](../server/field-save.ts) |

**Um problema visual** pede distinguir coordenadas de autoria, mundo e câmera.
A pose interpolada serve ao desenho; a previsão física usa um snapshot coerente.
Ao tocar em cache, confira quem cria, compartilha e libera o recurso, incluindo
a bancada e a prévia da obra.

## Quanto validar

Comece pelo comportamento alterado e seus consumidores diretos. Exemplo de
recorte para ordens e reparos, no PowerShell:

```powershell
$env:IMPACTO_DYNAMICS_RUNTIME='native'
node --test --test-concurrency=4 tests/supply-dispatch.test.js tests/field-economy.test.js
```

- Em código compartilhado com o navegador, confira o mesmo recorte com
  `$env:IMPACTO_DYNAMICS_RUNTIME='wasm'`. Photos binárias pertencem ao Native.
- Se mudou Rust, prepare os núcleos conforme o README e execute
  `npm run test:rust`, além das integrações afetadas. Confira invariantes físicas
  e conservação; um modelo novo não deve exigir valores exatos do modelo antigo.
- Mudanças amplas em contratos, admissão ou coordenação pedem `npm test` completo
  no Native. Dependências JS: `npm run check:structure`. Interface/renderização:
  `npm run build` e os fluxos afetados no navegador.
- Texto e links pedem conferência documental; não exigem repetir a simulação.

Fixtures devem partir do produtor real e preparar dados somente quando usados.
[pilot-fixture](../tests/helpers/pilot-fixture.ts) consulta a decisão Native sem
criar uma sala. [network-fixtures](../tests/helpers/network-fixtures.js) prepara
mensagens, recibos e desenhos separadamente, com cópias independentes por cenário.
As salas e mundos usados na preparação são descartados antes de devolver os dados.

Para testar o campo, use uma instância e armazenamento próprios conforme
[test-tools](test-tools.md). Um backend já aberto conserva seu código até o
reinício; recarregar a página não atualiza o worker do servidor.

## Manter este mapa pequeno

Atualize a linha da área quando mudar seu proprietário ou sua fronteira. Se mudar
uma interrupção ou retomada, atualize o exemplo em [automático e serviços](automatic-services.md)
na mesma alteração e mantenha um teste de comportamento correspondente.
Números de versão, limites, tempos e prioridades ficam nas definições do código;
resultados de uma rodada ficam em seu relatório. Evite copiar essas listas para cá.
