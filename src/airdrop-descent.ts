import { Container, Graphics, Sprite } from 'pixi.js';
import type { Texture } from 'pixi.js';
import { pileLook, pileSize } from './cargo-art.ts';
import type { SupplyBill } from './economy-contract.ts';
import type { Point } from './math.ts';

export interface HeightField { height(x: number): number }
export interface Airdrop {
  id: string; x: number; phase: string; arrivesAt: number; supplies?: Partial<SupplyBill> | null;
}
export interface PileAppearance { crates: string[]; cans: number }
export interface AirdropDescent<Ground extends HeightField = HeightField> {
  id: string; graphic: Container; canopy: Graphics; load: Sprite; key: string; ground: Ground; foot: number;
}
export interface AirdropRenderer<Ground extends HeightField = HeightField> {
  ground: Ground;
  camera: Point & { width: number; height: number; zoom: number };
  airdropDescent?: AirdropDescent<Ground> | null;
  world: Container; shadows: Container;
  textures: { has(key: string): boolean }; usedTextures: { add(key: string): unknown };
  pilePicture(look: PileAppearance): { key: string; texture: Texture };
}

// Both phases use this footing, leaving no edge of the symbolic pallet floating over a slope.
export function airdropFooting(ground: HeightField, x: number, width: number): number {
  let foot = ground.height(x + width / 2);
  for (let u = -width / 2; u <= width / 2; u += .5) foot = Math.min(foot, ground.height(x + u));
  return foot - .08;
}

// One cached drawing for the final minute of an already discovered drop. Its clock is the field's;
// animation neither creates cargo nor advances while the field is paused.
export function updateAirdropDescent<Ground extends HeightField>(renderer: AirdropRenderer<Ground>, drop: Airdrop | null | undefined, time: number): void {
  const left = drop ? drop.arrivesAt - time : NaN, supplies = drop?.supplies;
  const flying = drop && supplies && drop.phase === 'announcement' && Number.isFinite(left) && left > 0 && left <= 60;
  if (!flying || renderer.airdropDescent &&
      (renderer.airdropDescent.id !== drop.id || renderer.airdropDescent.ground !== renderer.ground)) {
    renderer.airdropDescent?.graphic.destroy({ children: true, context: true });
    renderer.airdropDescent = null;
  }
  if (!flying) return;
  const { camera, ground } = renderer, x = drop.x + Math.sin(time * .4) * Math.min(3, left * .2),
    y = (renderer.airdropDescent?.foot ?? ground.height(drop.x)) + left * 4, halfX = camera.width / camera.zoom / 2, halfY = camera.height / camera.zoom / 2,
    visible = Math.abs(x - camera.x) <= halfX + 16 && y <= camera.y + halfY && y + 19 >= camera.y - halfY;
  if (renderer.airdropDescent) {
    renderer.airdropDescent.graphic.visible = visible;
    if (visible) {
      if (!renderer.textures.has(renderer.airdropDescent.key)) {
        const picture = renderer.pilePicture(pileLook(supplies));
        renderer.airdropDescent.load.texture = picture.texture;
      }
      renderer.usedTextures.add(renderer.airdropDescent.key);
    }
  }
  if (!visible) return;
  if (!renderer.airdropDescent) {
    const group = renderer.world.addChildAt(new Container(), renderer.world.getChildIndex(renderer.shadows)),
      g = group.addChild(new Graphics()), look = pileLook(supplies),
      { height, width: wide } = pileSize(look), picture = renderer.pilePicture(look), foot = airdropFooting(ground, drop.x, wide);
    // Three canopies and a bundled load share one geometry, with local coordinates even at the map's ends.
    for (const cx of [-10, 0, 10]) {
      g.moveTo(cx - 5.4, 10).bezierCurveTo(cx - 5.2, 19, cx + 5.2, 19, cx + 5.4, 10)
        .quadraticCurveTo(cx + 2.7, 11.5, cx, 10).quadraticCurveTo(cx - 2.7, 11.5, cx - 5.4, 10)
        .closePath().fill(0xb5b69a).stroke({ color: 0x5d6553, width: .1 });
      for (const dx of [-3, 0, 3]) g.moveTo(cx + dx, 10.4)
        .quadraticCurveTo(cx + dx * .7, 14.6, cx + dx * .35, 16.4)
        .stroke({ color: 0x8a9176, width: .065 });
      for (const side of [-1, 1]) g.moveTo(cx + side * 4.8, 10.2).lineTo(cx / 10 * (wide / 2 - .5) + side * .35, height)
        .stroke({ color: 0xd2ceae, width: .06 });
    }
    const load = group.addChild(new Sprite(picture.texture));
    load.anchor.set(.5, 1); load.width = wide; load.height = height; load.scale.y = -Math.abs(load.scale.y);
    renderer.airdropDescent = { id: drop.id, graphic: group, canopy: g, load, key: picture.key, ground, foot };
  }
  const g = renderer.airdropDescent.graphic;
  g.position.set(x, renderer.airdropDescent.foot + left * 4);
  g.rotation = Math.sin(time * .5) * .015 * left / 60;
}
