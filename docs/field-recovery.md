# Salvar e retomar o campo

O campo retoma o último checkpoint gravado com sucesso. O diário serve para
investigação e replay; a inicialização não aplica automaticamente suas linhas
posteriores ao checkpoint. Para outras áreas, veja o [mapa de manutenção](maintenance-map.md).

O formato atual é 32, com instalações, memória opcional dos comandantes, reparos
adiados pela IA e a regra opcional de duelo. O formato 31 conserva seu duelo e
abre com a lista de reparos adiados vazia; a primeira gravação preserva uma cópia
exata em `field.before-economy-save31-<hash>.json`.
O formato 30 abre como campo persistente, preservando
uma cópia exata em `field.before-duel-save30-<hash>.json` antes da primeira
gravação no formato atual. Um resultado de duelo exige formato 31 ou posterior;
reparos adiados exigem 32, impedindo que uma etiqueta antiga esconda esse estado.
Executá-los exige testes ou configuração pública explícita. O loader também
lê o formato 29, sem comandantes, preservando uma cópia
exata em `field.before-commanders-save29-<hash>.json` antes da primeira gravação
no formato atual. O diário atual é 59; veja [comandantes](faction-commander.md)
para a presença, pausa e replay dessas identidades.

## Backup e restauração

Pare o jogo com `docker compose stop game` antes de copiar o volume inteiro
para armazenamento privado. O checkpoint e os diários podem conter chaves de
assento, nomes e chat. Restrinja o acesso ao volume e às cópias, defina a retenção
dos backups e evite incluí-los na árvore publicada ou em relatos de erro.
Quem tiver uma chave de assento pode usá-la para retomar a identidade até que
o jogador emita outra chave. Os diários têm rotação com orçamento de 1 GiB.

Para restaurar, use um volume separado com a cópia consistente e a mesma
versão da aplicação usada na última gravação. Mantenha a combinação antiga de
build e volume até verificar a nova. Em uma instância isolada, confira a
abertura, reconecte um assento de teste e reinicie para confirmar a retomada.

Para uma cópia dos formatos 27 ou 28, use `scripts/convert-field-industry.ts`;
para 26, `convert-field-posts.ts`.
Os conversores validam e reabrem antes de escrever em pasta nova, somente com
`--write`; o loader não converte esses formatos automaticamente. A conversão registra níveis
concedidos e pontos antigos retirados. Ver [instalações](industrial-progression.md).
Leituras transitórias de contato com o chão (`groundContact` e `grounded`) são
recalculadas pelo Native ao retomar; sua ausência em checkpoints antigos não
representa perda de estado. Estoques, identidades e demais dados persistentes
continuam sujeitos à comparação de conservação da conversão.

| Responsabilidade | Proprietário |
| --- | --- |
| Reconexão e ticket da publicação sem resposta | [NetworkClient](../src/network-client.ts) |
| Conclusão, prazo e rejeição de pedidos pendentes de rede ou worker privado | [PendingReplies](../src/pending-replies.ts) |
| Comprovantes de fabricação por jogador e estado durável do jogo | [SharedRoom.keep/resume](../server/room.ts) |
| Arquivo temporário, sincronização e substituição do checkpoint | [field-save](../server/field-save.ts) |
| Salvamento periódico, aviso de falha e liberação dos controles | [physics-worker](../server/physics-worker.ts) |
| Encerramento e recuperação do worker | [network-server](../server/network-server.ts) |
| Diário, origem da retomada e fotos binárias para replay | [field-host](../server/field-host.ts), [field-snapshot](../server/field-snapshot.ts) |

## Exemplos de retomada

**Fabricar e perder a resposta.** O cliente mantém o ticket enquanto a mesma
publicação estiver sem confirmação. Ao tentar novamente, a sala consulta os
comprovantes antes de validar ou cobrar outra fabricação, substituição ou mudança
de estrutura. Eles acompanham o jogador no checkpoint, inclusive se a construção
original já tiver sido substituída ou a obra tiver terminado. A retenção continua
limitada por `ANSWERS_KEPT`; não é um histórico permanente de todos os comandos.
Saves anteriores sem esse campo abrem com os comprovantes vazios.
Os tipos de publicação com ticket são definidos uma vez em
`PUBLICATION_COMMANDS`, no [protocolo](../src/network-protocol.ts), incluindo o
posto. Cliente e sala usam essa mesma definição.

**Receber uma resposta atrasada.** Uma resposta identificada só pode concluir o
pedido ainda pendente. Depois do prazo ou de uma conclusão anterior, ela é
ignorada, inclusive seus erros e configurações. Avisos de salvamento e recusas de
entrada não têm identificador de pedido e seguem seu fluxo próprio. Mensagens de
um socket anterior também são ignoradas. A reconexão não repete automaticamente
ordens de movimento, chat ou controle manual.
Uma nova tentativa fecha a conexão anterior antes de abrir outra. Um pedido
que não pôde ser enviado é rejeitado na hora, liberando os controles; a
configuração de arma só é considerada enviada depois de o transporte aceitá-la.

**Reiniciar durante um trabalho.** A carga e as ordens manuais de transporte são
preservadas; tarefas de transporte automático são escolhidas novamente a partir
da carga e do automático salvo. Obras mantêm material entregue e progresso;
reparos mantêm seu serviço e prazo no relógio do campo. Nenhum jogador retoma
segurando os controles. Veja as regras e interrupções em [automático e serviços](automatic-services.md).

Uma falha de gravação mantém o checkpoint anterior e informa os clientes. Um
checkpoint inválido bloqueia a abertura sem ser substituído por um campo novo.
Dados de comprovantes presentes, mas malformados ou acima do limite, também são
recusados. Essas garantias não recuperam mudanças que nunca chegaram a um
checkpoint bem-sucedido, nem tickets que a página deixou de guardar.

## Validar uma mudança

Comece por [network-client](../tests/network-client.test.js),
[network-save](../tests/network-save.test.js), [network-renewal](../tests/network-renewal.test.js),
[field-save](../tests/field-save.test.js) e [field-replay](../tests/field-replay.test.js).
Os testes de rede usam portas temporárias e diretórios próprios; cobrem reinício,
queda do worker e falha real de escrita sem tocar no campo do jogador.

Para transporte e serviços, acrescente os testes do fluxo afetado indicados no
mapa. Execute o recorte compartilhado em Native e Wasm; fotos binárias pertencem
ao Native. Uma inspeção no navegador deve usar um [servidor isolado](test-tools.md#servidor-isolado).
