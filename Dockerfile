# syntax=docker/dockerfile:1
# O jogo como ele é servido fora de casa: a página construída e o campo compartilhado no mesmo
# processo (compose.yaml).

# O núcleo do campo compilado para Linux, da mesma fonte de que saiu o núcleo da página.
FROM rust:1.98-bookworm AS core
COPY --from=node:24-bookworm-slim /usr/local/bin/node /usr/local/bin/node
WORKDIR /game
RUN rustup target add wasm32-unknown-unknown
COPY package.json ./
COPY scripts scripts
# A ferramenta fixada não depende das fontes do jogo; mudanças nelas reaproveitam esta camada.
RUN node scripts/build-dynamics.ts --tools-only
COPY src src
COPY native/dynamics native/dynamics
# Quantos núcleos a compilação toma (`--build-arg CARGO_BUILD_JOBS=8`); todos, quando não é dito.
ARG CARGO_BUILD_JOBS
# O cache é exclusivo; uma lock restante pertence a um contêiner encerrado, cujo PID pode ser reutilizado.
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/game/native/dynamics/target,sharing=locked \
    rm -rf /game/native/dynamics/target/.dynamics-build.lock && \
    CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS:-$(nproc)} node scripts/build-dynamics.ts --native && \
    node scripts/build-dynamics.ts

FROM node:24-bookworm-slim
RUN mkdir /game /data && chown node:node /game /data
USER node
WORKDIR /game
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
COPY --chown=node:node . .
# O núcleo vem antes de a página ser construída: a página leva o carimbo do código que o campo roda.
COPY --chown=node:node --from=core /game/native/artifacts native/artifacts
COPY --chown=node:node --from=core /game/src/native src/native
# A imagem não leva fixtures de testes ou referências de áudio dos diagnósticos.
# Verifique todo o cliente e servidor, incluindo suas dependências transitivas.
# A checagem completa de ferramentas continua em npm run check no workspace.
RUN node scripts/check-typescript.ts && \
    npx tsc -p tsconfig.runtime.json && npx tsc -p src/tsconfig.json && \
    npm run check:translations && node scripts/build-dynamics.ts --prepare && \
    npx vite build
VOLUME /data
EXPOSE 8131
CMD ["node", "node_modules/vite/bin/vite.js", "preview"]
