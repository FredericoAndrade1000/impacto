# Cópias explícitas de projetos 8 para 9

Este roteiro é da passagem do 8 ao 9; o jogo atual lê projetos 10 e não importa
arquivos 9. O formato 8 tratava as pontas da esteira como
marcadores de uma quantidade de rodas; no 9, extremos e centro são posições
físicas contínuas. Trocar apenas o número da versão reinterpretaria a geometria.

`scripts/convert-projects-design8.ts` usa separadamente um checkout Core52/Design8
preservado e o atual Core53/Design9, com seus respectivos Native correspondentes.
O compilador antigo informa a geometria efetiva; a cópia escreve esses extremos
e centro no formato novo. Nenhum carregamento normal importa esse script.

Antes de atualizar um navegador, **Garagem → Baixar originais deste navegador**
guarda os registros literais, inclusive os que já não abrem. O conversor aceita
um projeto 8, uma Garagem 4 contendo apenas projetos 8, ou a edição
`{ projectId, blueprint }` com projeto 8. Uma entrada inválida ou misturada é
recusada por inteiro. Não há descarte de itens, conversão de campo ou de diário.
Nessa janela, use **Baixar este original** na Garagem ou na Edição que deseja
converter. **Baixar todos os originais** produz um envelope de backup, que deve
ser guardado inteiro e não é uma entrada direta do conversor. Bancadas e versões
anteriores ao 8 permanecem para consulta no respectivo código histórico.

Exemplo em PowerShell, usando caminhos de cópias e uma pasta de saída nova:

```powershell
node scripts/convert-projects-design8.ts --pin --old-root ../backup/core52 --new-root ../jogo/core53 --pins ../backup/pins-8-9.json
node scripts/convert-projects-design8.ts --input ../backup/projeto8.json --pins ../backup/pins-8-9.json --output ../backup/projeto9
# Depois de conferir a simulação, repetir com --write:
node scripts/convert-projects-design8.ts --input ../backup/projeto8.json --pins ../backup/pins-8-9.json --output ../backup/projeto9 --write
```

Os pinos exigem os mesmos códigos, fontes Rust, manifestos e binários durante
toda a operação. Uma mudança exige novos pinos e nova conferência. Por padrão,
o comando só simula. `--write` cria uma pasta nova com o original byte a byte,
os projetos 9 individuais e o recibo; nunca sobrescreve uma pasta existente.

Importe os arquivos `project-*-design9.json` pela Garagem. Cada um recebe uma
identidade nova; o script não altera o armazenamento do navegador. Antes de
experimentar na Oficina, **Duplicar projeto** conserva outra versão.

A comparação verifica o DTO físico inteiro, a admissão e a fabricação. Custos,
tempo, conectividade, campos discretos, grades balísticas e decisões precisam
ser exatos. A passagem de coordenadas globais a locais pode mudar alguns bits
de ponto flutuante: somente nessa ferramenta offline, o limite é
`16 × Number.EPSILON × max(1, |antes|, |depois|)`. Cada diferença e seu limite,
assim como os dois hashes distintos, constam no recibo. Isso não garante
equivalência binária, reprodução de campo ou replay antigo no núcleo novo.

Projetos com peças sem apoio podem continuar como rascunho se os dois núcleos
conservarem a mesma recusa. Estruturas fixas ainda precisam passar pela admissão
no terreno real ao fabricar. Para consultar campos e diários antigos, preserve
também o código e os artefatos da versão que os produziu.
Na prova de rascunho, o tanque de combustível ficou 5 cm acima do piso: a
autoria continuou editável e a fabricação manteve `PHYSICAL_SUPPORT` para a
mesma peça, sem eliminar ou reposicioná-la.
