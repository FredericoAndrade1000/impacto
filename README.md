# Impacto

Impacto é um jogo 2D de construção e combate em um campo persistente. Na Oficina, você projeta veículos e estruturas. No campo, sua facção extrai recursos, fabrica os projetos e comanda unidades num mundo compartilhado.

[Jogue no servidor oficial](https://impacto.hexarail.com/). No menu **Servidores**, escolha um campo da lista, entre pelo endereço de outro servidor ou permaneça na Oficina. A chave de assento é própria de cada servidor.

## Hospede seu campo

Com Docker e Compose, na raiz do projeto:

```sh
docker compose up -d --build
```

Abra [http://localhost:8141/](http://localhost:8141/). A primeira inicialização com um volume novo gera um campo próprio. O [guia de servidores](docs/servidores.md) cobre HTTPS, entrada no diretório comunitário e o perfil opcional Cloudflare Tunnel. O [guia de recuperação](docs/field-recovery.md) cobre backup, restauração e atualização do volume.

Configure `IMPACTO_SOURCE_URL` com a URL HTTPS do código correspondente ao que sua instância serve, incluindo suas mudanças. O endereço aparece em **Código-fonte** no menu **Servidores**.

## Desenvolver

Use Node.js 22.18+ e o toolchain Rust com o alvo `wasm32-unknown-unknown`.

```sh
npm ci
npm run build:native
npm run dev
npm run check
npm test -- --test-concurrency=4
```

O build Wasm distribuído acompanha o código do núcleo. Após alterar o Rust, rode `npm run build:wasm` e `npm run build:native`. Veja [como contribuir](CONTRIBUTING.md), o [mapa de manutenção](docs/maintenance-map.md) e as [instruções de segurança](SECURITY.md).

## Licenças

Código de Frederico Andrade sob [AGPL-3.0-only](LICENSE). Os [recursos próprios e de terceiros](LICENSE-ASSETS.md) têm licenças por origem, incluindo CC BY 4.0 para arte e áudio próprios. Veja também os [avisos de dependências](THIRD_PARTY_NOTICES.md) e a [política de marca](TRADEMARKS.md).

## English

Impacto is a 2D construction and combat game in a persistent multiplayer world. Build vehicles in the Workshop, manufacture them and lead a faction. [Play on the official server](https://impacto.hexarail.com/) or follow the [server hosting guide](docs/servidores.md).

## Español

Impacto es un juego 2D de construcción y combate en un campo multijugador persistente. Diseña vehículos en el Taller, fabrícalos y dirige una facción. [Juega en el servidor oficial](https://impacto.hexarail.com/) o consulta la [guía para alojar un servidor](docs/servidores.md).
