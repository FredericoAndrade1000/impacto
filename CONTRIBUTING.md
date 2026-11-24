# Contribuir com o Impacto

- Explique a mudança e como verificá-la. Envie contribuições sob a licença do código ou a licença indicada para o recurso e documente a procedência de novos recursos.
- Mantenha a paridade entre cliente, servidor, Native e Wasm. Use os contratos e geradores existentes e verifique os fluxos de construção, rede e retomada afetados.
- Mantenha uma implementação vigente de cada comportamento. Ao concluir uma migração, retire auxiliares e cópias obsoletas após verificar os consumidores. Preserve saves e fichas de origem fora da distribuição.
- Rode `npm run check`, `npm test -- --test-concurrency=4` e, em mudanças no núcleo, `npm run test:rust`. Use fixtures sintéticas nos testes. Consulte [medições mobile](docs/mobile-performance.md) para distinguir diagnósticos de desktop de calibrações no aparelho.
