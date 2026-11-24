# Painel de testes

No **Campo de provas**, abra **Testes** ou pressione **F1**. O painel também aparece em um servidor habilitado explicitamente para testes; o campo comum recusa essas ações.

- **Veículo:** escolha um modelo do catálogo. No ensaio privado, ele substitui o veículo em uso; o projeto da Oficina permanece igual e **Restaurar** volta ao projeto e aos alvos originais. No servidor de testes, o veículo entra na sua frota; use **Conduzir** para controlá-lo.
- **Alvo parado:** adiciona um modelo sem piloto, na posição e frente escolhidas. A confirmação informa seu identificador; no campo, o corpo continua dependendo da visão dos sensores da facção. Uma marca de radar ou som não revela o interior nem substitui a visão óptica.
- **Reparar:** restaura danos de uma construção ativa, mantendo combustível, munição e carga atuais. Não recupera destroços.
- **Reabastecer:** completa combustível e munição das reservas funcionais; mantém danos e carga.
- **Reposicionar:** leva um veículo ativo à coordenada X, apoiado no terreno e parado. Permite trocar a frente e preserva danos e reservas. Estruturas fixas recebem sua posição na criação.

Selecionar na lista não assume o controle. **Usar centro da câmera** preenche a posição; no servidor, **Atualizar lista** renova as posições e construções disponíveis. A manutenção interrompe o trabalho e os comandos de movimento atuais. Os limites de frota e a validação física dos modelos continuam valendo.

## Servidor isolado

Em um PowerShell na raiz do projeto, sem `IMPACTO_SAVE_DIR` configurado:

```powershell
$env:IMPACTO_TEST_SERVER = '1'
$env:IMPACTO_TEST_SAVE_DIR = Join-Path $PWD 'validation/test-server'
npm run dev -- --host 127.0.0.1 --port 8402
```

A pasta deve ser nova/vazia ou já identificada como servidor de testes. O campo normal recusa abrir essa pasta; os dados de um campo existente não são convertidos ou apagados. Todos os jogadores que entrarem nesse servidor recebem as ferramentas, inclusive a lista de posições do cenário inteiro. Para acesso pela rede local, use `--host 0.0.0.0`.

Para adicionar facções autônomas com economia normal, configure também
`IMPACTO_TEST_COMMANDERS` antes de iniciar. A contagem, retomada, comparação
reproduzível e limites estão em [comandante de base](faction-commander.md).

No campo público, `IMPACTO_AI_MIN_PLAYERS` é uma opção separada para criar
facções gradualmente. Ela exige save normal explícito e não concede o painel
de testes. Os dois modos não podem ser combinados.
