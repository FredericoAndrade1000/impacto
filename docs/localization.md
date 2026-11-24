# Idiomas

O jogo oferece português, inglês e espanhol latino-americano. A opção inicial segue a primeira preferência
compatível do navegador; outros idiomas usam inglês. **Configurações → Idioma**
permite português, inglês, espanhol ou automático. A escolha fica neste navegador e na URL
como alternativa quando o armazenamento está bloqueado. Mudar idioma salva o
projeto pelo fluxo existente e recarrega; falha no salvamento impede a troca.

`src/bootstrap.ts` configura o idioma antes de carregar as interfaces.
`src/i18n.ts` resolve as frases. `src/locales/en.ts` e `src/locales/es.ts` contêm
os dicionários, com as frases em português como chaves. Consulte o [glossário de espanhol](glossario-es.md).
`src/localize-page.ts` traduz o HTML inicial uma vez. Textos dinâmicos usam `tr('Texto')` ou
`tr` como tag de template, mantendo dados do jogador em valores posicionais.
Não há observador de DOM nem varredura de tradução por quadro.

Ao adicionar um texto de interface, marque a frase e adicione as duas traduções.
`npm run check:translations` verifica as chamadas, os catálogos e o HTML inicial;
`npm run typecheck` verifica chaves e parâmetros nos módulos migrados. Ambos
fazem parte de `npm run check`, executado antes do build e da suíte de testes.
Traduza nomes de equipamentos ao apresentá-los; não altere as tabelas físicas,
IDs de comandos ou os nomes escritos por jogadores. Números usam `format.ts`;
datas e nomes de países usam o locale selecionado.

O servidor mantém mensagens canônicas em português para logs e replay.
`userError` pode enviar a frase e seus valores; o cliente valida essa estrutura
antes de traduzir. `phrase` marca rótulos de catálogo dentro de outra frase;
nomes, chat e projetos permanecem texto literal. Os diagnósticos internos de
saves e núcleo mantêm o texto de origem. Cada frase de interface precisa de
tradução. Ver [contratos](typescript.md).

`i18n.test.js` verifica preferência, armazenamento bloqueado, números,
preservação de conteúdo e parâmetros do dicionário. Valide também uma interface
no navegador após incluir novos controles, especialmente texto em atributos e
frases produzidas por catálogos. A troca de idioma é por recarga, não em tempo real.
