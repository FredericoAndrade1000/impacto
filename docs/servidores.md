# Servidores do Impacto

O menu permite escolher um campo anunciado, informar um endereço ou jogar no
servidor que serviu a página. A última entrada bem-sucedida fica no navegador.
Cada origem do jogo guarda uma chave de assento por servidor de destino, incluindo
porta. Uma chave digitada é enviada ao destino exibido no formulário de entrada.
Campos comunitários têm identificação própria na lista e na entrada.

## Hospedar um campo

Para iniciar um campo local, execute `docker compose up -d --build` e abra
`http://localhost:8141/`. A porta da origem fica em loopback. O volume `field`
mantém o checkpoint e os diários. Defina `IMPACTO_AI_MIN_PLAYERS` para ativar
a população automática. O envio de métricas do cliente ao armazenamento do
campo pode ser habilitado pelo operador com `IMPACTO_CLIENT_TELEMETRY=1`.

Para Cloudflare Tunnel, copie `.env.example` para `.env`, configure
`IMPACTO_ADDRESS` com o seu domínio HTTPS e `TUNNEL_TOKEN` com o token emitido
para o túnel. Aponte o hostname no túnel para `http://game:8131` e execute
`docker compose --profile tunnel up -d --build`. O Compose confia no IP
reservado ao túnel para `CF-Connecting-IP` e `X-Forwarded-Proto`.

Defina `IMPACTO_SOURCE_URL` com a URL HTTPS da fonte correspondente ao build
servido. No menu, ela aparece como **Código-fonte**. O padrão aponta para o
repositório do projeto.

### Proxy HTTPS próprio

Use o Dockerfile do jogo, com um volume novo e um domínio HTTPS seu. Este exemplo
publica a origem apenas em loopback para um proxy TLS na mesma máquina.

```sh
docker build -t impacto-game .
docker volume create impacto-meu-campo
docker run -d --name impacto-meu-campo --init --restart unless-stopped \
  --env-file .env.jogo -p 127.0.0.1:8240:8131 \
  -v impacto-meu-campo:/data impacto-game
```

Em `.env.jogo`, defina `IMPACTO_ADDRESS=https://jogo.example/` e
`IMPACTO_SAVE_DIR=/data`. Configure DNS, TLS e o redirecionamento de HTTP para
HTTPS no proxy. Preserve `Host`, encaminhe o upgrade de `/world` e defina
`X-Forwarded-Proto: https`. Faça o proxy de borda substituir `X-Forwarded-For`
pelo IP do cliente ou definir o cabeçalho confiável do seu provedor. Defina
`IMPACTO_TRUSTED_PROXIES` com o IP exato do peer do proxy **visto pelo processo**,
que pode ser o gateway da rede Docker. Para Cloudflare Tunnel, o
[`compose.yaml`](../compose.yaml) reserva um IP para o túnel e usa
`cf-connecting-ip`. Limites por endereço podem ser compartilhados por jogadores
atrás do mesmo NAT.

Restrinja a origem HTTP ao proxy e ao acesso local autorizado. Em produção,
a descoberta de interfaces LAN fica desativada por padrão. Ative-a somente
para diagnóstico em rede privada com `IMPACTO_DISCOVER_LAN=1`.

O endereço público de jogo é `wss://jogo.example/world`. Mantenha o save fora da
raiz publicada e siga o [guia de recuperação](field-recovery.md) para backup,
restauração e atualização. O campo novo usa as regras padrão e a população
automática de IA pode ser ativada pelo operador.

## Anunciar o campo

Peça ao operador da lista que cadastre o endereço WSS e entregue a chave por um
canal privado. Configure o ambiente do jogo com os valores do cadastro. O
`compose.yaml` repassa essas variáveis. A URL sozinha habilita a consulta da lista.

```dotenv
IMPACTO_DIRECTORY_URL=https://lista.example/
IMPACTO_DIRECTORY_KEY=
IMPACTO_DIRECTORY_ADDRESS=wss://jogo.example/world
IMPACTO_DIRECTORY_NAME=Meu campo
IMPACTO_DIRECTORY_DESCRIPTION=Campo persistente da comunidade
IMPACTO_DIRECTORY_REGION=Brasil
IMPACTO_DIRECTORY_LANGUAGE=pt-BR
IMPACTO_DIRECTORY_FIELD=Campo principal
IMPACTO_CLIENT_ORIGINS=https://jogo-oficial.example
```

`IMPACTO_DIRECTORY_ADDRESS` assume o domínio de `IMPACTO_ADDRESS` quando omitido.
Preencha `IMPACTO_DIRECTORY_KEY` com a chave recebida no cadastro.
O idioma aceita `pt-BR`, `en` ou `es`. O campo pronto anuncia a cada minuto. A
lista verifica o upgrade WSS e compara as duas versões anunciadas com os cabeçalhos
da resposta. Após três minutos sem anúncio verificado, o registro some. Uma
verificação que falha retira a entrada assim que é concluída.

O proxy também precisa encaminhar `GET /api/server-status`. O navegador mede o
tempo dessa consulta sem credenciais, incluindo o custo de DNS/TLS quando abre uma
conexão nova. `IMPACTO_CLIENT_ORIGINS` enumera as origens HTTPS exatas autorizadas
a medir o ping e abrir o WebSocket de outra página. O próprio site do campo já
tem acesso. A opção por endereço verifica as versões antes de abrir o formulário.

## Operar a lista

Use outro domínio HTTPS, com proxy para `127.0.0.1:8195` na VPS. O contêiner usa
Node 24 e módulos padrão. O volume `registry` guarda apenas os hashes. A lista
viva é reconstruída pelos anúncios após um reinício.

```sh
docker compose --env-file .env.lista -f compose.directory.yaml build
docker compose --env-file .env.lista -f compose.directory.yaml run --rm directory register wss://jogo-oficial.example/world
docker compose --env-file .env.lista -f compose.directory.yaml up -d
```

O cadastro imprime uma chave aleatória uma vez. Use o mesmo comando para os
campos comunitários. Para revogar, execute `revoke <endereço-wss>` no lugar de
`register`. Uma entrada revogada pode aparecer até a expiração do último
anúncio, mais o cache HTTP. Para rotacionar, revogue, cadastre e atualize o jogo
com a nova chave. Faça backup privado do volume e evite registrar o cabeçalho
`Authorization` nos logs.

Em `.env.lista`, configure `IMPACTO_DIRECTORY_ORIGINS` com as origens HTTPS
exatas dos clientes que poderão consultar a lista, separadas por vírgula.
Configure `IMPACTO_DIRECTORY_TRUSTED_PROXIES` com o IP exato do peer do proxy visto
pelo serviço e, se necessário, `IMPACTO_DIRECTORY_PROXY_IP_HEADER`. Preserve o
encaminhamento de IP descrito acima. O público lê `GET /servers` em JSON, com
cache de dez segundos. `POST /servers` usa a chave vinculada ao endereço, com
limites de taxa, corpo, concorrência e quantidade de entradas. A sondagem só
conecta a endereços públicos, valida TLS e não segue redirecionamentos.

Defina `IMPACTO_OFFICIAL_SERVER` no serviço da lista e no ambiente do jogo que
vai exibir o selo. A página compara a entrada com esse endereço. Para o próprio
servidor oficial aparecer, cadastre-o e configure sua chave e URL da lista no
ambiente do jogo. Após isso ele anuncia da mesma forma que os demais.

## Para depois

Cadastro público, moderação e recuperação de chaves precisam de um fluxo
operacional. Mapas configuráveis e pacotes de dados precisam de um contrato de
compatibilidade próprio. O jogo conserva os contratos de rede, núcleo e save
desta versão. A primeira implantação pública ainda precisa validar proxy, TLS
e retomada do campo com dados descartáveis.
