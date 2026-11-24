# Licenças e créditos dos recursos

Frederico Andrade disponibiliza os recursos próprios identificados abaixo sob [Creative Commons Atribuição 4.0 Internacional (CC BY 4.0)](https://creativecommons.org/licenses/by/4.0/). Crédito sugerido para redistribuição: **Impacto, por Frederico Andrade, CC BY 4.0**. Preserve os créditos de origem e indique alterações. Veja também [TRADEMARKS.md](TRADEMARKS.md).

## Trilha e efeitos

- `music/calm-{1..4}.mp3`, `music/construction-{1..4}.mp3` e `music/tense-{1..7}.mp3` — 15 faixas geradas localmente por Frederico Andrade com ACE-Step 1.5 e selecionadas para o jogo. O modelo oficial declara licença MIT e autoriza uso comercial da música gerada. As gravações distribuídas pelo projeto estão sob CC BY 4.0. A variante e a revisão dos pesos usadas em cada faixa não constam nos MP3. [Ficha oficial do ACE-Step 1.5](https://huggingface.co/ACE-Step/Ace-Step1.5)
- `sounds/*.mp3` — 29 efeitos gerados por Frederico Andrade a partir de prompts de texto com MOSS-SoundEffect v2.0, selecionados e preparados para o jogo, e dois sintetizados localmente (`alert-contact.mp3` e `breakup.mp3`). A licença declarada para o modelo MOSS é Apache-2.0. Os 31 efeitos finais do projeto estão sob CC BY 4.0. [Ficha oficial do MOSS](https://huggingface.co/OpenMOSS-Team/MOSS-SoundEffect-v2.0) · [Procedência por arquivo](sounds/origem.tsv)

## Imagens

`favicon.svg` e as imagens listadas a seguir são recursos do projeto, atribuídos a Frederico Andrade, sob CC BY 4.0. As texturas e os atlas da tabela foram preparados com Imagegen da OpenAI. A coluna de origem descreve as entradas e o acabamento. Os termos da OpenAI atribuem ao usuário os direitos da OpenAI sobre as saídas na medida permitida pela lei. [Termos da OpenAI](https://openai.com/policies/terms-of-use/)

| Arquivo em `src/assets/` | Origem e preparação |
| --- | --- |
| `wheel-grain.webp` | Microtextura extraída de um estudo Imagegen de roda do projeto, reduzida a 512 × 512. |
| `terrain-rock-detail.webp`, `terrain-soil-detail.webp` | Capturas do terreno do jogo, estudos e extração de material mineral repetível. |
| `hull-inside-grain.webp`, `track-rubber-grain.webp` | Estudos de acabamento a partir do desenho procedural da carroceria e das esteiras. |
| `boulder-grain.webp` | Estudo da rocha da jazida a partir de captura do jogo. |
| `wear-earth.webp`, `wear-oil.webp`, `wear-oxide.webp`, `wear-scuffs.webp` | Estudos de desgaste sobre peças do jogo e extração de mapas isolados. |
| `radar-grain.webp`, `base-canvas-grain.webp`, `base-concrete-grain.webp`, `base-earth-grain.webp`, `base-paint-grain.webp`, `base-rubber-grain.webp` | Estudos de materiais a partir dos desenhos do radar e da base do jogo. |
| `flora-natural-v2.webp` | Árvores, arbustos e detalhes de chão gerados, recortados e empacotados em atlas. |
| `clouds-natural-v6.webp` | Oito silhuetas Imagegen geradas com transparência, recortadas e empacotadas em atlas. O estudo usou referências meteorológicas para comparação visual. |
| `scenery-ranges-v4.webp` | Panoramas gerados para os biomas do jogo, refinados a partir dos estudos do projeto e preparados em atlas. |

O código dos desenhos procedurais integra a licença do código em [LICENSE](LICENSE).

## Imagens de terceiros

- `src/assets/fire-flame.png` — Unity Labs Paris, sequência de VFX preparada em atlas. CC0-1.0. [Fonte, receita e hashes](src/assets/fire-flame.LICENSE.txt)
- `src/assets/hull-outside-grain.webp`, `src/assets/frame-grain.webp` e `src/assets/track-steel-grain.webp` — Green Metal Rust, de Rob Tuytel (Poly Haven), CC0-1.0. A fonte de 1 m foi redimensionada com Lanczos a 200 px, repetida e recortada em mapa de 512 × 512 (WebP 90, método 6). SHA-256 da fonte `4509ab0cb1cf6bf9b9f970450a41f83ebd9bff178006deae568ff34b404856fc` e do mapa `c924a0a43df8ff9e39394ab0e8cadb799c232f2522e44a071636b43f477efea9`. [Material original](https://polyhaven.com/a/green_metal_rust) · [Licença](https://polyhaven.com/license)
- `src/assets/concrete-grain.webp` — Rough Concrete, de Dimitrios Savva (Poly Haven), CC0-1.0. Mesma preparação do metal, a partir de fonte de 1,23 m. SHA-256 da fonte `dd7fc03e152eb8c2fd511248aa2e9bf7428a645bd0e0b74ac1d887ad136cb0bc` e do mapa `73e42ad9a2a3140395058b3dfc06a157b048c067e7dbea8481342418beb081dd`. [Material original](https://polyhaven.com/a/rough_concrete) · [Licença](https://polyhaven.com/license)
- `public/flags/*.svg` — coleção flag-icons, licença MIT, incluindo `cs.svg` derivada de `cz.svg`. As 19 bandeiras históricas indicadas na ficha usam desenhos marcados como domínio público no Wikimedia Commons, recortados para 4:3. [Licença flag-icons](public/flags/LICENSE) · [Origens históricas por arquivo](public/flags/HISTORIC.txt)
