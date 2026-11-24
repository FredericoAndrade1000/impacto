import { Container, Graphics, Sprite } from 'pixi.js';
import { weaponMaterialRole } from './weapon-geometry.ts';
import { weaponLayout, weaponCanvas, weaponPiece, weaponMoves, feedLook, rotorLook, rotorBarrel, routeAt, beltFade, drumChamber } from './weapon-paint.ts';
import { pieceTexture } from './textures.ts';
import { weaponRecoilStroke } from './weapon-art.ts';
import type { Texture } from 'pixi.js';
import type { Point } from './math.ts';
import type { WeaponId } from './weapons.ts';
import type { WeaponArtSource } from './weapon-art.ts';
import type { WeaponPart, WeaponCanvasArt, WeaponPiece, FeedLook } from './weapon-paint.ts';
import type { WeatheringMaps } from './weathering.ts';
import type { PieceTexture } from './textures.ts';

export interface WeaponTextureEntry { texture: Texture; art?: WeaponCanvasArt | null }
interface ArtworkPart { key: string; place: string | null; painted: WeaponCanvasArt | null; create(): PieceTexture }
// The ready rounds of a gun as they stand this frame (weapon-presentation.ts `followFeed`): the places its drum or belt has
// gone forward and how far the drawing has come towards them, the rounds it holds (none told: full), which chambers of its
// drum hold one, and whether its compartment was wrecked. The turn of its rotor, and how blurred it is.
export interface WeaponFeedPose { places: number; turned: number; loaded: number | null; chambers: readonly boolean[] | null; cut: boolean }
export interface WeaponSpinPose { angle: number; blur: number }
// What moves over a gun, in the frame of the picture it moves over (`frame`: the index of that sprite): a container laid as
// that sprite is, its pictures in the canvas frame of the gun (weapon-paint.ts), each painted once.
interface Overlay<Entry> { container: Container; frame: number; pieces: Partial<Record<WeaponPiece, ArtworkPart>>; sprites: Sprite[]; entries: Partial<Record<WeaponPiece, Entry>> }
interface FeedOverlay<Entry> extends Overlay<Entry> { look: FeedLook }
interface RotorOverlay<Entry> extends Overlay<Entry> { look: ReturnType<typeof rotorLook> }
interface WeaponSpriteItem<Entry extends WeaponTextureEntry> {
  sprites: Sprite[]; base: Graphics; textures: Entry[];
  geometry?: string; preset?: WeaponId | undefined; mounted?: boolean; exposed?: boolean; reserve?: number; finish?: number;
  flip?: number; turn?: number; cut?: boolean; parts?: ArtworkPart[]; laid?: string; feed?: FeedOverlay<Entry> | null; rotor?: RotorOverlay<Entry> | null;
}
export interface WeaponSpriteOptions { recoil?: number; alpha?: number; tint?: number; weathering?: WeatheringMaps | null;
  feed?: WeaponFeedPose | null; spin?: WeaponSpinPose | null }

// Painted weapons enter the scene as sprites: the receiver, the tube and the mantlet follow the servo, and the receiver
// and the tube recoil along the bore; only the post of an exposed mount stays on its host axis. Textures use the
// renderer's transient cache, so stale mount geometry is released with it.
const geometryKeys = new WeakMap<readonly (readonly Point[])[], string>();
function geometryKey(polygons: readonly (readonly Point[])[]) {
  let key = geometryKeys.get(polygons);
  if (!key) {
    key = polygons.map(poly => poly.map(p => Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000)).join(' ')).join('|');
    geometryKeys.set(polygons, key);
  }
  return key;
}

// In the field a gun is painted `animated` (weapon-paint.ts): its turning barrels and its ready rounds are pictures of
// their own. The part that holds its compartment is painted again, once, when that is wrecked (`cut`).
function artwork(preset: WeaponId | undefined, polygons: readonly (readonly Point[])[] | null, geometry: string, id: string, name: WeaponPart, flip: number, reserve = 0, exposed = false, weathering: WeatheringMaps | null = null, cut = false) {
  const part: ArtworkPart = { key: ['weapon', preset, name, flip, geometry, reserve, exposed, weathering?.id ?? 0, cut ? 'cut' : ''].join(':'),
    place: polygons ? 'weapon:' + id + ':' + name : null, painted: null, create() {
      part.painted = weaponCanvas(weaponLayout(preset, polygons, flip, reserve, exposed), name, { weathering, animated: true, cut });
      return pieceTexture(part.painted.canvas);
    } };
  return part;
}
function piece(preset: WeaponId | undefined, polygons: readonly (readonly Point[])[] | null, geometry: string, id: string, name: WeaponPiece, flip: number, exposed: boolean, weathering: WeatheringMaps | null) {
  const part: ArtworkPart = { key: ['weapon', preset, name, flip, geometry, exposed, weathering?.id ?? 0].join(':'),
    place: polygons ? 'weapon:' + id + ':' + name : null, painted: null, create() {
      part.painted = weaponPiece(weaponLayout(preset, polygons, flip, 0, exposed), name, { weathering })!;
      return pieceTexture(part.painted.canvas);
    } };
  return part;
}
// A tint darkened towards black by `light` (0 to 1), as a part beyond the axis it turns about is.
function shaded(tint: number, light: number) {
  if (light >= 1) return tint;
  return Math.round((tint >> 16 & 255) * light) << 16 | Math.round((tint >> 8 & 255) * light) << 8 | Math.round((tint & 255) * light);
}
const depthLight = (depth: number) => depth >= 0 ? 1 : 1 - .36 * -depth;
const destroyOverlay = (overlay: Overlay<unknown> | null | undefined) => { if (overlay && !overlay.container.destroyed) overlay.container.destroy({ children: true }); };

export class WeaponSprites<Entry extends WeaponTextureEntry = WeaponTextureEntry> {
  declare texture: (key: string, create: () => PieceTexture, place: string | null) => Entry;
  declare keepTexture: ((entry: Entry) => void) | null;
  declare items: Map<string, WeaponSpriteItem<Entry>>; declare used: Set<string>;
  declare at: { x: number; y: number; angle: number };
  constructor(texture: WeaponSprites<Entry>['texture'], keepTexture: WeaponSprites<Entry>['keepTexture'] = null) {
    this.texture = texture; this.keepTexture = keepTexture; this.items = new Map(); this.used = new Set(); this.at = { x: 0, y: 0, angle: 0 };
  }
  begin() { this.used.clear(); }
  // A gun outside the camera keeps its pictures just as its chassis and hull do. It asks for no new
  // artwork there: in particular, a mount that was being edited must not finish painting offscreen.
  retain(id: string) {
    const item = this.items.get(id);
    if (!item || item.base.destroyed || item.sprites.some(sprite => sprite.destroyed)) return;
    this.used.add(id);
    for (const entry of item.textures) if (entry) this.keepTexture?.(entry);
    for (const overlay of [item.feed, item.rotor]) for (const entry of Object.values(overlay?.entries || {})) if (entry) this.keepTexture?.(entry);
  }
  // Where no canvas can be painted (Node), the weapon is left out of the picture.
  place(id: string, layer: Container | null | undefined, launcher: WeaponArtSource, angle: number, presetId: WeaponId | undefined, { recoil = 0, alpha = 1, tint = 0xffffff, weathering = null, feed = null, spin = null }: WeaponSpriteOptions = {}) {
    if (!layer || typeof document === 'undefined') return;
    const mounted = Boolean(launcher.weaponMount) && Array.isArray(launcher.materialPolygons),
      geometry = mounted ? geometryKey(launcher.materialPolygons!) : '', reserve = mounted ? weaponRecoilStroke(launcher, angle) : 0,
      finish = weathering?.id ?? 0, cut = Boolean(feed?.cut);
    let item = this.items.get(id);
    if (!item || item.base.destroyed || item.sprites.some(sprite => sprite.destroyed)) {
      if (item) { destroyOverlay(item.feed); destroyOverlay(item.rotor); }
      item = { sprites: [new Sprite(), new Sprite(), new Sprite()], base: new Graphics(), textures: [] }; this.items.set(id, item);
    }
    // The lit side is chosen once per geometry. A mounted weapon keeps it while
    // its vehicle rocks; a bench weapon turns over as it swings past vertical.
    const facing = Math.cos(mounted ? launcher.angle || 0 : angle) < -.01 ? -1 : 1,
      changedGeometry = item.geometry !== geometry || item.preset !== presetId || item.mounted !== mounted || item.exposed !== Boolean(launcher.weaponMount?.exposed),
      flip = changedGeometry || !mounted ? facing : item.flip!, changed = changedGeometry || item.flip !== flip || item.finish !== finish;
    item.flip = flip;
    // Fixed feet are two small solids, not a bitmap spanning their empty middle.
    if (changedGeometry) {
      item.base.clear();
      if (mounted) for (const [index, poly] of launcher.materialPolygons!.entries()) {
        if (weaponMaterialRole(launcher.weaponMount!.exposed, index) === 'base') {
          const xs=poly.map(p=>p.x), ys=poly.map(p=>p.y), x=Math.min(...xs), y=Math.min(...ys),
            w=Math.max(...xs)-x, h=Math.max(...ys)-y, lip=Math.min(.004,h*.16,w*.08), r=Math.min(.006,h*.22,w*.09);
          item.base.poly(poly.flatMap(p => [p.x,p.y])).fill(0x25372d);
          item.base.rect(x+lip,y+lip,w-2*lip,h-2*lip).fill(0x68785f);
          item.base.rect(x+lip,y+h-2*lip,w-2*lip,lip).fill(0xa3ae90);
          item.base.rect(x+w*.36,y+2*lip,w*.28,Math.max(0,h-4*lip)).fill(0x46573e);
          for (const along of [.15,.85]) {
            item.base.circle(x+w*along,y+h/2,r).fill(0x17271c);
            item.base.circle(x+w*along,y+h/2,r*.63).fill(0xa8b294);
          }
        }
      }
    }
    item.base.visible = mounted && !launcher.weaponMount!.exposed;
    item.base.position.set(launcher.x, launcher.y); item.base.rotation = launcher.angle || 0;
    item.base.tint = tint; item.base.alpha = alpha;
    // The receiver is painted in its own box and laid at its native turn about the pivot: along the bore, which it
    // recoils down with the tube, or, for the post of an exposed mount, on the host axis. A gun carried whole on a post
    // is painted once, lit side up as it points right, and turned over as it points left: what it carries is as high
    // above its bore as below it, so either way it stands in its own solids. The slide behind the breech is as long as
    // the gun recoils where it is laid: only the cradle is painted anew as a howitzer raised high recoils less.
    if (changed || item.reserve !== reserve || item.cut !== cut) {
      const polygons = mounted ? launcher.materialPolygons! : null, first = polygons?.[0], exposed = Boolean(launcher.weaponMount?.exposed),
        moving = exposed ? 1 : item.flip;
      item.exposed = exposed;
      item.turn = first ? Math.atan2(first[1]!.y - first[0]!.y, first[1]!.x - first[0]!.x) : 0;
      item.parts = mounted ? [artwork(presetId, polygons, geometry, id, 'receiver', item.flip, 0, exposed, weathering, !exposed && cut),
        artwork(presetId, polygons, geometry, id, 'moving', moving, 0, exposed, weathering, exposed && cut),
        ...(reserve > 0 || !exposed && polygons!.length > 4 ?
          [artwork(presetId, polygons, geometry, id, 'cradle', moving, reserve, exposed, weathering)] : [])]
        : [artwork(presetId, null, geometry, id, 'all', item.flip, 0, false, weathering, cut)];
      // What moves over it: the compartment's rounds in the picture that holds the compartment, the rotor's barrels in
      // the tube's. Laid out again only when the gun's geometry or lit side changes.
      const laid = [geometry, presetId, item.flip, mounted, exposed, finish].join(':');
      if (item.laid !== laid) {
        item.laid = laid;
        destroyOverlay(item.feed); destroyOverlay(item.rotor); item.feed = item.rotor = null;
      }
      if (!item.feed && !item.rotor && weaponMoves(presetId)) {
        const feedFlip = mounted && exposed ? 1 : item.flip, look = feedLook(weaponLayout(presetId, polygons, feedFlip, 0, exposed)),
          rotorFlip = mounted ? moving : item.flip, rotorLayout = weaponLayout(presetId, polygons, rotorFlip, 0, exposed);
        const names: WeaponPiece[] = look?.kind === 'magazine' ? ['round', 'cell', 'axle'] : ['link'],
          overlay = (frame: number, flipped: number, which: WeaponPiece[]): Overlay<Entry> => ({ container: new Container(), frame, sprites: [], entries: {},
            pieces: Object.fromEntries(which.map(name => [name, piece(presetId, polygons, geometry, id, name, flipped, exposed, weathering)])) });
        item.feed = look ? { ...overlay(mounted && exposed ? 1 : 0, feedFlip, names), look } : null;
        item.rotor = rotorLayout.barrels > 1 ? { ...overlay(mounted ? 1 : 0, rotorFlip, ['barrel', 'blur', 'rings']), look: rotorLook(rotorLayout) } : null;
        for (const each of [item.feed, item.rotor]) if (each) each.container.sortableChildren = true;
      }
      item.geometry = geometry; item.preset = presetId; item.mounted = mounted; item.reserve = reserve; item.finish = finish; item.cut = cut;
    }
    const exposed = item.exposed, aimed = Math.cos(angle) < -.01 ? -1 : 1, cos = Math.cos(angle), sin = Math.sin(angle);
    // Recoil only changes transforms. Texture keys, painters and mount roles
    // are retained through the whole stroke, including automatic bursts.
    for (let index = 0; index < item.sprites.length; index++) {
      const sprite = item.sprites[index]!, part = item.parts![index];
      sprite.visible = Boolean(part);
      if (!part) continue;
      // The art of a mounted gun follows its mount: asked by its place, it waits for a mount that is being moved.
      const entry = this.texture(part.key, part.create, part.place);
      item.textures[index] = entry;
      if (part.painted) { entry.art = part.painted; part.painted = null; }
      const art = entry.art!, shown = mounted && index > 0 && exposed ? aimed : item.flip!,
        fixed = index === 2 || mounted && index === 0 && exposed, shift = fixed ? 0 : recoil;
      if (sprite.parent !== layer) layer.addChild(sprite);
      sprite.texture = entry.texture;
      sprite.anchor.set(art.originX / art.canvas.width, art.originY / art.canvas.height);
      sprite.scale.set(1 / art.scale, -shown / art.scale);
      sprite.rotation = mounted && index === 0 ? (exposed ? launcher.angle || 0 : angle) + item.turn! : angle;
      sprite.position.set(launcher.x - cos * shift, launcher.y - sin * shift);
      sprite.tint = tint; sprite.alpha = alpha;
    }
    item.textures.length = item.parts!.length;
    if (item.base.parent !== layer) layer.addChild(item.base);
    if (item.rotor) this.placeRotor(item, item.rotor, layer, spin, tint, alpha);
    if (item.feed) this.placeFeed(item, item.feed, layer, feed, tint, alpha);
    this.used.add(id);
  }
  // An overlay is laid as the sprite it moves over is, in metres of the gun's canvas frame (y down, mirrored as that
  // sprite is), just over the tube's picture: under the mantlet of an enclosed mount. Its pictures are asked once a frame.
  layOverlay(item: WeaponSpriteItem<Entry>, overlay: Overlay<Entry>, layer: Container, alpha: number) {
    const under = item.sprites[overlay.frame]!, over = item.sprites[item.mounted ? 1 : 0]!;
    if (!under.visible || under.parent !== layer || over.parent !== layer) { overlay.container.visible = false; return false; }
    if (overlay.container.parent !== layer) layer.addChildAt(overlay.container, layer.getChildIndex(over) + 1);
    const container = overlay.container;
    container.visible = true; container.alpha = alpha;
    container.position.copyFrom(under.position); container.rotation = under.rotation;
    container.scale.set(1, under.scale.y < 0 ? -1 : 1);
    for (const [name, part] of Object.entries(overlay.pieces) as [WeaponPiece, ArtworkPart][]) {
      const entry = this.texture(part.key, part.create, part.place);
      if (part.painted) { entry.art = part.painted; part.painted = null; }
      overlay.entries[name] = entry;
    }
    return true;
  }
  sprite(overlay: Overlay<Entry>, index: number, name: WeaponPiece) {
    let sprite = overlay.sprites[index];
    if (!sprite || sprite.destroyed) { sprite = overlay.sprites[index] = new Sprite(); overlay.container.addChild(sprite); }
    const entry = overlay.entries[name]!, art = entry.art!;
    if (sprite.texture !== entry.texture) {
      sprite.texture = entry.texture;
      sprite.anchor.set(art.originX / art.canvas.width, art.originY / art.canvas.height);
      sprite.scale.set(1 / art.scale, 1 / art.scale);
    }
    sprite.visible = true; sprite.alpha = 1; sprite.rotation = 0;
    return sprite;
  }
  // The barrels of a rotary gun about its axis at the angle its rotor has come to, those beyond the axis behind and darker
  // (weapon-paint.ts `paintRotor`); over them, as it turns fast, the blur they run into; the clamps round them over all.
  placeRotor(item: WeaponSpriteItem<Entry>, rotor: RotorOverlay<Entry>, layer: Container, spin: WeaponSpinPose | null, tint: number, alpha: number) {
    if (!this.layOverlay(item, rotor, layer, alpha)) return;
    const look = rotor.look, turned = spin?.angle ?? 0, blur = spin?.blur ?? 0;
    for (let i = 0; i < look.n; i++) {
      const { y, depth } = rotorBarrel(look, 2 * Math.PI * (i + .5) / look.n + turned), sprite = this.sprite(rotor, i, 'barrel');
      sprite.position.set(look.from, y); sprite.zIndex = depth; sprite.tint = shaded(tint, depthLight(depth));
    }
    const smear = this.sprite(rotor, look.n, 'blur'), rings = this.sprite(rotor, look.n + 1, 'rings');
    smear.position.set(0, 0); smear.zIndex = 2; smear.alpha = blur; smear.visible = blur > 0; smear.tint = tint;
    rings.position.set(0, 0); rings.zIndex = 3; rings.tint = tint;
  }
  // The rounds of a gun's compartment as they stand: round the axis of its drum, each chamber where the drum has turned
  // to, with its round or empty; or along its belt, one link a pitch, gone forward a pitch a round, as many as it holds.
  // A wrecked compartment holds none: its picture is painted burnt and empty (weapon-paint.ts `cut`).
  placeFeed(item: WeaponSpriteItem<Entry>, feed: FeedOverlay<Entry>, layer: Container, pose: WeaponFeedPose | null, tint: number, alpha: number) {
    if (!this.layOverlay(item, feed, layer, alpha)) return;
    const look = feed.look, turned = pose?.turned ?? 0, loaded = pose?.loaded ?? null;
    let used = 0;
    if (!pose?.cut && look.kind === 'magazine') {
      for (let j = 0; j < look.chambers; j++) {
        const { y, depth } = drumChamber(look, 2 * Math.PI * (turned - j) / look.chambers),
          full = pose?.chambers ? Boolean(pose.chambers[j]) : loaded !== 0, sprite = this.sprite(feed, used++, full ? 'round' : 'cell');
        sprite.position.set(look.x0, y); sprite.zIndex = depth; sprite.tint = shaded(tint, depthLight(depth));
      }
      const axle = this.sprite(feed, used++, 'axle');
      axle.position.set(look.x0, look.cy); axle.zIndex = 0; axle.tint = tint;
    } else if (!pose?.cut && look.kind === 'belt') {
      const behind = Math.max(0, (pose?.places ?? 0) - turned), count = Math.ceil(look.length / look.pitch) + 2, first = Math.floor(-behind), at = this.at;
      for (let i = 0; i < count; i++) {
        const k = first + i, s = look.length - look.pitch * (.5 + k + behind), fade = beltFade(look, s);
        if (fade <= 0 || loaded !== null && k >= loaded) continue;
        routeAt(look, s, at);
        const sprite = this.sprite(feed, used++, 'link');
        sprite.position.set(at.x, at.y); sprite.rotation = at.angle; sprite.alpha = fade; sprite.zIndex = 0; sprite.tint = tint;
      }
    }
    for (let i = used; i < feed.sprites.length; i++) if (feed.sprites[i]) feed.sprites[i]!.visible = false;
  }
  end() {
    for (const [id, item] of this.items) if (!this.used.has(id)) {
      for (const sprite of item.sprites) if (!sprite.destroyed) sprite.destroy();
      if (!item.base.destroyed) item.base.destroy({ context: true });
      destroyOverlay(item.feed); destroyOverlay(item.rotor);
      this.items.delete(id);
    }
  }
  clear() { this.used.clear(); this.end(); }
}
