# Conversão explícita do campo 49 para a base física 50

`scripts/convert-field-base49.ts` converte uma **cópia** de um campo JSON aceito pelo Core49 para o Core50 com as bases físicas das armas. Não converte versões anteriores de projetos, top plates antigas ou replays binários. O envelope permanece JSON25; o carregamento normal50 recusa o prefixo físico antigo das armas integradas, sem conversão automática.

Guarde o checkout49 executável com seu addon, manifesto e dependências. O checkout50 precisa ter o Native correspondente às fontes finais. Os dois são carregados em processos separados; nenhum servidor é iniciado e nenhum passo da simulação é executado. Não edite esses checkouts durante a conversão.

Os caminhos abaixo são exemplos; use entradas privadas e uma pasta de saída que ainda não existe. A pasta dos pins deve ficar fora de `src`, `server` e `scripts`.

```powershell
node scripts/convert-field-base49.ts --pin --old-root ../copia-core49 --new-root ../copia-core50 --pins ../copia-privada/base49-pins.json
node scripts/convert-field-base49.ts --input ../copia-privada/field.json --pins ../copia-privada/base49-pins.json --output ../copia-privada/convertido
```

O segundo comando é uma simulação completa: valida o input com49, reconstrói o candidato50 e exige duas reaberturas estritas. Cada uma precisa coincidir exatamente com a reabertura correspondente49 nos estados que a conversão preserva. Não cria a saída. Confira o recibo e repita com `--write` para gravar:

```powershell
node scripts/convert-field-base49.ts --input ../copia-privada/field.json --pins ../copia-privada/base49-pins.json --output ../copia-privada/convertido --write
```

`--project caminho.json` pode ser repetido para projetos atuais da Oficina, uma Garagem v4 exportada ou o registro atual `{projectId, blueprint}` de edição. Esses documentos são validados nos dois cores e copiados literalmente como `project-1.json` etc. A ferramenta não lê o armazenamento do navegador nem procura arquivos automaticamente.

A conversão enumera as fontes dos atores, bibliotecas das facções e obras pendentes. Substitui somente `physicalMass`, `physicalCenterLocal`, `physicalInertia` e `materialPolygons` das armas integradas. O Native reconstrói a máscara com os furos salvos. Os momentos agregados dos veículos afetados são refeitos com combustível, munição e carga salvos, na pose rígida salva. Um oráculo49 regenerado a frio distingue a geometria de contato de diferenças de reconstrução; as bases não ganham colliders rígidos e o contorno salvo é preservado.

As duas reaberturas não procuram um ponto fixo por repetição: são duas operações predefinidas em cada core. O caminho normal49 pode arredondar novamente uma pose ao convertê-la entre os referenciais local e global. A ferramenta exige a mesma sequência exata em50, sem tolerância numérica maior. Os novos derivados e os momentos agregados precisam permanecer idênticos aos gravados nas duas reaberturas.

Saúde, danos, poses, velocidade, mira, reservas, terrenos, estradas, relógios, contadores, chat, relações, projetos, custos e entregas das obras permanecem no documento original. Não há nova cobrança, ajuste automático de peças ou teste de fabricação em `resume`/conclusão de obras.

O recibo contém hashes, versões, contagens e deltas de inércia; nunca inclui tokens ou o conteúdo privado do campo. `field.json` na nova pasta continua privado. O input, addon49, checkpoints e segmentos de replay não são alterados.

Uma fonte que passe49 e intercepte a nova base em50 é recusada com fase/código/localização numérica. A saída permanece ausente. Use a cópia original49 para consultar e exportar essa fonte; a ferramenta não move peças para fazê-la passar. Também recusa pins alterados, input modificado durante a leitura, caminhos com redirecionamento e qualquer pasta de saída existente.

Antes do corte para50, execute o caso dirigido do arquivo de testes existente com a raiz49 preservada:

```powershell
$env:IMPACTO_BASE49_ROOT = '../copia-core49'
node --test --test-name-pattern='explicit base49 converter' tests/field-save.test.js
```

Esse caso usa um campo49 privado de ensaio com duas orientações de M777, veículo deslocado e inclinado, máscara e chapa danificadas, reservas/carga, biblioteca e obra pendente. Verifica a recusa do campo49 no carregamento normal50, simulação, escrita, reabertura, preservação e recusa de uma interseção real. É explicitamente pendente enquanto não houver Native50 e raiz49 correspondentes; um teste pulado não valida a conversão.
