import type { MessageKey } from './message-contract.ts';
import type { StockId } from './economy-contract.ts';
import type { SensorMode } from './combat-sensors.ts';

export interface ArmourMaterial {
  id: string; name: MessageKey; short: MessageKey; color: number; density: number; resistance: number;
  brittle: boolean; ricochet: number; youngModulus: number; poissonRatio: number; minThicknessMm: number;
  fixed?: boolean; transparent?: boolean;
}
export interface PieceMetal {
  id: string; name: MessageKey; short: MessageKey; health: number; stock: StockId; tag: MessageKey;
  look: { hue: number; saturation: number; lift: number } | null;
}
export interface ModuleSpec {
  name: MessageKey; description: MessageKey; color: number; width: number; height: number; depthM?: number;
}
export interface MetalChoicePart { kind: ModuleKind; sensorMode?: SensorMode | undefined; metal?: MetalId | undefined }

// The densities are those of the real materials, and `resistance` is 1.25 times the thickness of rolled
// armour steel a millimetre of each is worth against a shot, within the range its published ballistic tests
// give (README, "Materiais de blindagem"). `brittle` and `ricochet` are of this model, and the Young modulus
// and the Poisson ratio pitch the sound of a struck plate. The Young modulus
// also feeds the chassis' elastic structural check. `minThicknessMm` is the thinnest plate of each a
// construction may have — the one that bends no more and breaks no sooner than 5 mm of steel —, and `fixed`
// marks the armour only a construction that does not drive may be made of.
export const MATERIALS = Object.freeze({
  steel: { id: 'steel', name: 'Aço', short: 'AÇO', color: 0x829292, density: 7800, resistance: 1.25, brittle: false, ricochet: 0.30, youngModulus: 2e11, poissonRatio: 0.3, minThicknessMm: 5 },
  aluminum: { id: 'aluminum', name: 'Alumínio', short: 'ALUMÍNIO', color: 0xb8c2ba, density: 2700, resistance: 0.48, brittle: false, ricochet: 0.24, youngModulus: 7e10, poissonRatio: 0.33, minThicknessMm: 8 },
  ceramic: { id: 'ceramic', name: 'Cerâmica', short: 'CERÂMICA', color: 0xb9ae96, density: 3500, resistance: 1.30, brittle: true, ricochet: 0.20, youngModulus: 1.6e11, poissonRatio: 0.22, minThicknessMm: 8 },
  concrete: { id: 'concrete', name: 'Concreto', short: 'CONCRETO', color: 0x929285, density: 2350, resistance: 0.18, brittle: true, ricochet: 0.12, youngModulus: 3e10, poissonRatio: 0.2, minThicknessMm: 50, fixed: true },
  hha: { id: 'hha', name: 'Aço de alta dureza', short: 'AÇO DURO', color: 0x66757d, density: 7850, resistance: 1.55, brittle: false, ricochet: 0.36, youngModulus: 2.05e11, poissonRatio: 0.29, minThicknessMm: 5 },
  titanium: { id: 'titanium', name: 'Titânio', short: 'TITÂNIO', color: 0xa7adb6, density: 4500, resistance: 1.12, brittle: false, ricochet: 0.28, youngModulus: 1.14e11, poissonRatio: 0.34, minThicknessMm: 6 },
  fiberglass: { id: 'fiberglass', name: 'Fibra de vidro', short: 'FIBRA', color: 0xb3b587, density: 1950, resistance: 0.30, brittle: true, ricochet: 0.08, youngModulus: 2.6e10, poissonRatio: 0.25, minThicknessMm: 10 },
  glass: { id: 'glass', name: 'Vidro blindado', short: 'VIDRO', color: 0x8fc7cf, density: 2500, resistance: 0.20, brittle: true, ricochet: 0.10, youngModulus: 7e10, poissonRatio: 0.22, minThicknessMm: 15, transparent: true },
} satisfies Record<string, ArmourMaterial>);
export type MaterialId = keyof typeof MATERIALS;
export const isMaterialId = (value: unknown): value is MaterialId => typeof value === 'string' && Object.hasOwn(MATERIALS, value);
// What sets each armour apart, for the workshop. The numbers above mirror the
// native table (game_damage.rs `Material::named`), which is the one that counts.
export const MATERIAL_NOTES = Object.freeze({
  steel: 'Referência: barato e equilibrado',
  hha: 'Mais proteção na mesma espessura; lança mais estilhaços',
  aluminum: 'Um décimo mais leve que o aço para a mesma proteção, com duas vezes e meia a espessura',
  titanium: 'Protege quase como o aço com pouco mais da metade do peso; caro',
  ceramic: 'Cerâmica sobre apoio: a maior proteção por peso; trinca e se desgasta a cada impacto',
  fiberglass: 'Mesmo peso do aço para a mesma proteção, mas quatro vezes mais grossa; quase não lança estilhaços para dentro; o radar atravessa',
  concrete: 'Pago quase todo em Sílica, com pouco Ferro, mas pede sete vezes a espessura e o dobro do peso do aço; só para posições fixas',
  glass: 'Transparente: a câmera e o Comando veem através dele, o radar não; pesado e caro para o que protege',
} satisfies Record<MaterialId, MessageKey>);
// The same in two or three words, beside the name.
export const MATERIAL_TAGS = Object.freeze({ steel: 'referência', hha: 'mais duro · mais estilhaços', aluminum: 'pouco mais leve · muito espesso',
  titanium: 'leve e resistente · caro', ceramic: 'máxima proteção por peso · trinca', fiberglass: 'volumosa · quase sem estilhaços · o radar atravessa',
  glass: 'transparente para câmeras', concrete: 'pago em Sílica · muito volumoso · só posições fixas' } satisfies Record<MaterialId, MessageKey>);
// From the everyday steel to the special cases.
export const MATERIAL_ORDER = Object.freeze(['steel', 'hha', 'aluminum', 'titanium', 'ceramic', 'fiberglass', 'glass', 'concrete'] satisfies MaterialId[]);
// What a piece may be made of: steel, the one that is not written (`metal`); a lighter metal, paid from the Ligas of a
// faction; a glass-fibre laminate, paid from its Sílica; or a polyethylene moulding, paid from its Combustível, as plastic
// is made of petroleum — a credit of it a litre, as a credit of the others is a kilogram of their stock. Neither of the
// last two is a metal, but each is chosen as one. Health shares mirror the core (game_geometry.rs `METALS`); mass and
// price come from compiled pieces and Native cost. The fuel, the rounds and the load stay what they are. Running gear
// inherits the chassis' metal for its rim/hub/links; chassis admission uses real structural density while rubber and
// optional steel armour stay their own material. `look` is how the piece is drawn (component-art.ts `metalRgb`): the
// olive of the painted steel (`STEEL_PAINT`) turned to the hue of the material, as grey as `saturation`, and lighter by
// `lift` (darker below zero); the steel has none, the laminate takes the pale yellow-green of its plates (textures.ts
// `MATERIAL_TONES`), and the moulding the charcoal of black polyethylene.
export const METALS = Object.freeze({
  steel: Object.freeze({ id: 'steel', name: 'Aço', short: 'AÇO', health: 1, stock: 'ferro', tag: 'referência', look: null }),
  aluminum: Object.freeze({ id: 'aluminum', name: 'Alumínio', short: 'ALUMÍNIO', health: .75, stock: 'ligas', tag: 'mais leve · aguenta menos',
    look: Object.freeze({ hue: 205, saturation: .1, lift: .32 }) }),
  titanium: Object.freeze({ id: 'titanium', name: 'Titânio', short: 'TITÂNIO', health: 1.1, stock: 'ligas', tag: 'leve e resistente · caro',
    look: Object.freeze({ hue: 255, saturation: .08, lift: .06 }) }),
  fiberglass: Object.freeze({ id: 'fiberglass', name: 'Fibra de vidro', short: 'FIBRA', health: .5, stock: 'silica', tag: 'leve · frágil',
    look: Object.freeze({ hue: 62, saturation: .3, lift: .28 }) }),
  plastic: Object.freeze({ id: 'plastic', name: 'Plástico', short: 'PLÁSTICO', health: .35, stock: 'combustivel', tag: 'a mais leve e barata · frágil',
    look: Object.freeze({ hue: 215, saturation: .05, lift: -.4 }) }),
} satisfies Record<string, PieceMetal>);
export type MetalId = keyof typeof METALS;
// The olive a piece of steel is painted in, which the `look` of another material turns.
export const STEEL_PAINT = 0x65725a;
// What each piece may be made of, steel first (game_geometry.rs `ComponentKind::metals`): a weapon steel alone; a camera
// and a microphone steel, glass fibre or polyethylene, as their cases are moulded of it, and a radar steel or, as its dome
// is, glass fibre (`RADAR_METALS`); a fuel tank, a cistern and a supply piece any metal, glass fibre or polyethylene, as
// tanks and crates are made of them; a thruster titanium alone, as the hot turbine of a jet is of titanium and of the
// superalloys the Ligas stand for, and no other metal of these stands its heat; anything else — the running gear and the
// frame it comes with, an engine, a tool, a box of rounds, a command post — any of the metals.
const ANY_METAL = Object.freeze(['steel', 'aluminum', 'titanium'] satisfies MetalId[]), CASED = Object.freeze([...ANY_METAL, 'fiberglass', 'plastic'] satisfies MetalId[]);
export const PIECE_METALS = Object.freeze({ sensor: Object.freeze(['steel', 'fiberglass', 'plastic']), command: ANY_METAL, engine: ANY_METAL,
  weapon: Object.freeze(['steel']), fuel: CASED, ammo: ANY_METAL, hopper: ANY_METAL, cistern: CASED, supply: CASED,
  excavator: ANY_METAL, drill: ANY_METAL, builder: ANY_METAL, blade: ANY_METAL, paver: ANY_METAL, wheel: ANY_METAL, track: ANY_METAL,
  thruster: Object.freeze(['titanium']) } satisfies Record<ModuleKind, readonly MetalId[]>);
export const RADAR_METALS = Object.freeze(['steel', 'fiberglass'] satisfies MetalId[]);
// What a piece may be made of: what its kind may, and a sensor what one that detects as it does may (`sensorMode`, a
// camera when it says none).
const radar = (part: MetalChoicePart) => part.kind === 'sensor' && part.sensorMode === 'radar';
export const pieceMetals = (part: MetalChoicePart): readonly MetalId[] => radar(part) ? RADAR_METALS : PIECE_METALS[part.kind];
// Whether a piece may be made of a material, and whether it has any to choose from.
export const takesMetal = (part: MetalChoicePart, metal: MetalId) => Boolean(pieceMetals(part)?.includes(metal));
export const choosesMetal = (part: MetalChoicePart) => pieceMetals(part)?.length > 1;
// Why a piece is not made of a material there is, in one sentence.
export const metalRefusal = (part: MetalChoicePart, metal: MetalId): MessageKey => part.kind === 'weapon' ? 'O armamento é só de aço.'
  : radar(part) ? 'O radar é de aço ou de fibra de vidro.'
    : metal === 'fiberglass' ? 'Só tanque de combustível, cisterna, suprimentos e sensor podem ser de fibra de vidro.'
      : metal === 'plastic' ? 'Só tanque de combustível, cisterna, suprimentos, câmera e escuta podem ser de plástico.'
        : 'A câmera e a escuta são de aço, de fibra de vidro ou de plástico.';
export const metalOf = (module: Pick<MetalChoicePart, 'metal'>) => METALS[module.metal ?? 'steel'];
// Whether the face a round struck (the `material` of an event) gives way where a metal would dent, and throws dust and
// no sparks: an armour as its plates do, and polyethylene, which only pieces are made of, as it splits (game_damage.rs
// `Material::PLASTIC`).
export const brittleMaterial = (material: string | null | undefined) => material === 'plastic' || isMaterialId(material) && MATERIALS[material].brittle;
// The pieces whose material is that of their housing alone (game_geometry.rs `housing`): what is in it, the electronics
// and the optics, weighs and is paid as on a steel one, from Ferro.
export const HOUSED = Object.freeze(['sensor', 'command']);
export const MODULES = Object.freeze({
  sensor: { name: 'Sensor', color: 0x84aeb5, width: .32, height: .24, depthM: 0.18, description: 'Câmera, radar ou escuta. Alcance, obstáculos e ruído limitam o que detecta; destruído ou solto, deixa de avisar o piloto. A câmera não vê através da blindagem do próprio veículo: fica por fora, ou por dentro atrás de um vidro.' },
  command: { name: 'Comando', color: 0x86b6a4, width: .44, height: .28, depthM: 0.18, description: 'Comando com visor básico: enxerga para fora por vidro ou aberturas da blindagem. Para observar mais longe, instale uma câmera óptica. Compartilha o que detecta com a facção. Destruído ou solto, deixa o veículo fora de combate e para de detectar.' },
  engine: { name: 'Motor', color: 0x7f9990, width: 1.05, height: 0.64, depthM: 0.65, description: 'Bloco do motor, radiador e transmissão. A carcaça protege pouco; não substitui a blindagem. Avariado, perde potência; inutilizado, o veículo só anda no embalo.' },
  weapon: { name: 'Armamento', color: 0xa4a994, width: 1.1, height: 0.42, description: 'Caixa da arma por dentro, abertura na blindagem e mantelete curvo acompanhando a elevação. A espessura da proteção é física e não aumenta com o setor. Impactos no mantelete podem perfurá-lo e travar a elevação; a caixa atingida pode inutilizar a arma. O cano reserva espaço de construção, mas disparos o atravessam. Metralhadoras e o lança-granadas também vão inteiros por fora, no suporte no teto: giram mais, sem blindagem.' },
  fuel: { name: 'Combustível', color: 0xb9a277, width: 0.8, height: 0.72, depthM: 0.45, description: 'Tanque preso por cintas, dentro de um compartimento ou por fora, em cima ou ao lado de uma chapa. Danificado, pode pegar fogo sem explodir. Dentro da carroceria, alimenta o incêndio interno; por fora, aquece apenas peças expostas próximas sem uma chapa no caminho. A queima diminui até os materiais combustíveis acabarem; um reparo apaga o fogo. Por fora fica sem a proteção da blindagem.' },
  ammo: { name: 'Munição', color: 0xb69369, width: 0.78, height: 0.65, depthM: 0.45, description: 'Projéteis presos em suportes. Proteja a reserva: um dano grave pode fazê-la explodir.' },
  hopper: { name: 'Caçamba', color: 0x8f8566, width: 1.6, height: 0.9, depthM: 1.2, description: 'Caixa aberta para minério: ferro, ligas e sílica. Vai dentro de um compartimento ou por fora, em cima de uma chapa, como numa carroceria. Leva o que couber no seu volume, e o que leva pesa no veículo. Para recolher pilhas sem escavadeira, basta uma caçamba do veículo com a base a até 2 m do chão: ela enche as outras.' },
  cistern: { name: 'Cisterna', color: 0x6f858c, width: 1.4, height: 0.9, depthM: 1.1, description: 'Tanque fechado para petróleo, dentro de um compartimento ou em cima de uma chapa. Leva o que couber no seu volume, e o que leva pesa no veículo. Recolhe petróleo já extraído quando uma cisterna do veículo tem a base a até 2 m do chão: ela enche as outras.' },
  supply: { name: 'Suprimentos', color: 0x8a7d5a, width: 1.5, height: 0.9, depthM: 1.1, description: 'Caixotes e galões com estoque da facção: materiais para reparar e remuniciar e combustível para abastecer outras construções longe da base. Vai dentro de um compartimento ou em cima de uma chapa. Carrega na base, e o que leva pesa no veículo.' },
  excavator: { name: 'Escavadeira', color: 0xa49a67, width: 1.2, height: 0.6, depthM: 0.9, description: 'Braço, pá e conjunto hidráulico em uma peça. Extrai ferro, ligas e sílica e deixa o material na jazida para coleta. Trabalha com a força do motor da própria construção, que gasta combustível enquanto ela cava. Fica em cima de um compartimento ou na carroceria livre do chassi. Precisa de uma caçamba separada para transportar.' },
  drill: { name: 'Perfuratriz', color: 0x8d9792, width: 0.8, height: 1.3, depthM: 0.8, description: 'Torre e mecanismo de perfuração em uma peça. Bombeia petróleo e o deixa na jazida para coleta. Trabalha com a força do motor da própria construção, que gasta combustível enquanto ela bombeia. Fica em cima de um compartimento ou na carroceria livre do chassi. Precisa de uma cisterna separada para transportar.' },
  builder: { name: 'Braço construtor', color: 0xa99760, width: 1.2, height: 0.6, depthM: 0.9, description: 'Braço e conjunto hidráulico para montar estruturas no campo. Trabalha parado e fora de combate, perto da obra, com materiais nas peças de suprimentos. Fica em cima de um compartimento ou na carroceria livre do chassi; não extrai minério.' },
  blade: { name: 'Lâmina niveladora', color: 0xa38f48, width: 1.6, height: 0.45, depthM: 1.2, description: 'Lâmina, círculo e barra de tração de uma motoniveladora em uma peça. Com o veículo andando devagar, transforma o chão natural em terra batida, sem gastar material: trabalha com a força do motor, que gasta combustível enquanto ela nivela. Fica pendurada embaixo de um chassi de rodas, entre dois eixos ou à frente do primeiro, sem encostar nos pneus.' },
  paver: { name: 'Pavimentadora', color: 0x7d7660, width: 1.6, height: 0.9, depthM: 1.2, description: 'Tremonha, esteira de alimentação e mesa de uma vibroacabadora em uma peça. Com o veículo andando devagar, transforma terra batida em asfalto, gastando a massa da própria tremonha — Sílica e Combustível, que ela enche na base e que as peças de suprimentos do veículo, se houver, levam a mais e repõem na obra — e a força do motor. Fica na traseira da carroceria livre do chassi, com a mesa arrastando atrás.' },
  thruster: { name: 'Propulsor', color: 0x8e918c, width: 0.64, height: 1.31, depthM: 0.64, description: 'Turbina de sustentação, como as dos aviões de decolagem vertical: empurra o veículo na direção escolhida, de 45 em 45°. O computador de voo reparte o empuxo entre os propulsores para compensar o peso e manter o veículo parado no ar sem comando; como num drone, inclina o veículo para andar de lado e o nivela para pousar. Gasta muito combustível dos tanques. Ponha propulsores dos dois lados do centro de massa. De titânio, pago em Ligas.' },
  wheel: { name: 'Roda', color: 0x777e71, width: 0.74, height: 0.74, description: 'Pneu, aro e cubo do eixo. Vem com o chassi de rodas e dá tração enquanto toca o chão.' },
  track: { name: 'Esteira', color: 0x899184, width: 5.04, height: 0.74, description: 'Elos, roda motriz e rodas de apoio. Vem com o chassi de esteiras e dá tração enquanto toca o chão.' },
} satisfies Record<string, ModuleSpec>);
export type ModuleKind = keyof typeof MODULES;
