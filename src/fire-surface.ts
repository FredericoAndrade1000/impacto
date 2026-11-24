import type { Point } from './math.ts';
import type { DrawingBodyPanel, DrawingModule } from './scene-drawing-contract.ts';
import type { EffectView } from './effect-types.ts';
export interface FirePose extends Point { angle?: number | undefined; carrier?: string | undefined }
export type FirePiece = Partial<Pick<DrawingModule, 'kind' | 'width' | 'height'>> & { id?: string | undefined; mirrored?: boolean | undefined };
type FireComponent = Pick<DrawingModule, 'id' | 'actorId' | 'kind' | 'width' | 'height' | 'x' | 'y' | 'angle' | 'burning' | 'attached' | 'exposed'> & { mirrored?: boolean | undefined };
type SurfacePanel = DrawingBodyPanel & { actorId: string; localPolygon: Point[] };
interface FireSource { bodyPanels?: readonly DrawingBodyPanel[] | undefined; modules?: readonly FireComponent[] }
export interface FireScene { frame?: { source: FireSource }; actor(id: string): FirePose | null | undefined; pose?(id: string): FirePose | null | undefined }
export type FireProfile = [Point[], Point[], Point[], Point[]];
export type FireProfileProvider = (id: string) => FireProfile | null | undefined;
interface UpperSurface { points: (Point & { across: number })[]; width: number; min: number; max: number; projected: Point[][]; axisC: number; axisS: number }
interface FireOrigin { pose: FirePose; carrier: string | undefined; burning: readonly FireComponent[] | undefined; scene: FireScene; componentProfile: FireProfileProvider | null }
export type FireSurface = FireOrigin & ({ opened: true; width: 0 } | (UpperSurface & { opened?: false }));
interface SurfaceCache { polygons: (readonly Point[])[]; tilts: Map<number, UpperSurface | null> }
export interface FirePoint extends Point { carrier?: string | undefined; span?: number; profile?: FireProfile | null }
// Fire uses the visible hull already sent to the client, never hidden interior pieces.
// Index each immutable snapshot once. Cache eight upper-surface sites per shape/tilt;
// nearby angles share a five-degree sample, with at most eight cached tilts per shape.
const snapshots = new WeakMap<FireSource, { actors: Map<string, SurfacePanel[]>; burning: Map<string, FireComponent[]> }>(), profiles = new WeakMap<readonly Point[], SurfaceCache>(), ANGLE_STEP = Math.PI / 36;
function hasFirePolygon(panel: DrawingBodyPanel): panel is SurfacePanel {
  const poly = panel.localPolygon;
  return typeof panel.actorId === 'string' && !!poly && poly.length >= 3 && poly.every(p => Number.isFinite(p.x) && Number.isFinite(p.y));
}
export function fireSurface(scene: FireScene | null | undefined, actorId: string | null | undefined, opened = false, attachment: FireProfileProvider | null = null, view: EffectView | null = null): FireSurface | null {
  const source = scene?.frame?.source;
  if (!source || actorId == null) return null;
  let snapshot = snapshots.get(source);
  if (!snapshot) {
    const actors = new Map<string, SurfacePanel[]>(), burning = new Map<string, FireComponent[]>();
    for (const panel of source.bodyPanels || []) {
      if (!hasFirePolygon(panel)) continue;
      if (!actors.has(panel.actorId)) actors.set(panel.actorId, []);
      actors.get(panel.actorId)!.push(panel);
    }
    for (const part of source.modules || []) if (part.burning && part.attached !== false && !part.exposed && !['wheel', 'track'].includes(part.kind)) {
      if (!burning.has(part.actorId)) burning.set(part.actorId, []);
      burning.get(part.actorId)!.push(part);
    }
    snapshot = { actors, burning }; snapshots.set(source, snapshot);
  }
  const panels = snapshot.actors.get(actorId), burning=snapshot.burning.get(actorId),
    first = panels?.[0], body = scene.actor(actorId),
    pose = body || first?.pose || (opened&&burning?.[0]&&(scene.pose?.(burning[0].id)||burning[0]));
  if (!pose || !scene) return null;
  const origin = { pose, carrier: body ? actorId : undefined, burning, scene, componentProfile: attachment };
  if (opened) return { ...origin, opened: true, width: 0,
    burning:view?origin.burning?.filter(part=>{
      const at=scene.pose?.(part.id)||part,reach=Math.hypot(part.width||0,part.height||0)/2+1;
      return at.x+reach>view.left&&at.x-reach<view.right&&at.y+reach>view.bottom&&at.y-reach<view.top;
    }):origin.burning };
  if (!panels?.length) return null;
  let profile = profiles.get(first!.localPolygon);
  if (!profile || profile.polygons.length !== panels.length || panels.some((panel, i) => panel.localPolygon !== profile!.polygons[i])) {
    profile = { polygons: panels.map(panel => panel.localPolygon), tilts: new Map<number, UpperSurface | null>() };
    profiles.set(first!.localPolygon, profile);
  }
  const tilt = ((Math.round((pose.angle || 0) / ANGLE_STEP) % 72) + 72) % 72;
  if (!profile.tilts.has(tilt)) {
    profile.tilts.set(tilt, upperSurface(profile.polygons, tilt * ANGLE_STEP));
    if (profile.tilts.size > 8) profile.tilts.delete(profile.tilts.keys().next().value!);
  }
  const surface = profile.tilts.get(tilt);
  return surface ? { ...surface, ...origin } : null;
}

function upperSurface(polygons: readonly (readonly Point[])[], angle: number): UpperSurface | null {
  const axisC = Math.cos(angle), axisS = Math.sin(angle),
    projected = polygons.map(poly => poly.map(p => ({ x: axisC * p.x - axisS * p.y, y: axisS * p.x + axisC * p.y }))),
    vertices = projected.flat(), min = Math.min(...vertices.map(p => p.x)), max = Math.max(...vertices.map(p => p.x)), points = [], count = 8;
  for (let i = 0; i < count; i++) {
    const x = min + (max - min) * (.04 + .92 * i / (count - 1));
    let y = -Infinity;
    for (const polygon of projected) for (let j = 0; j < polygon.length; j++) {
      const a = polygon[j]!, b = polygon[(j + 1) % polygon.length]!;
      if (Math.abs(b.x - a.x) < 1e-9 || x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) continue;
      y = Math.max(y, a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
    }
    if (Number.isFinite(y)) points.push({ x: axisC * x + axisS * y, y: -axisS * x + axisC * y, across: x });
  }
  return points.length ? { points, width: max - min, min, max, projected, axisC, axisS } : null;
}

// Spread selects more of the real surface, without drawing a uniform curtain or increasing particle quotas.
export function firePoint(surface: FireSurface | null | undefined, origin: FirePose, spread: number, random: number, radius?: number): FirePoint {
  if (!surface) return origin;
  // Use only actual burning pieces already visible in this snapshot. Observers
  // without these private pieces use the bounded radius of the aggregate event.
  let part;
  if ((radius !== undefined || surface.opened) && surface.burning?.length) {
    const slot = Math.min(surface.burning.length - 1, Math.floor(random * surface.burning.length));
    part = surface.burning[slot]!;
    origin = surface.scene?.pose?.(part.id) || part;
    random = random * surface.burning.length - slot;
    radius = Math.max(.12, part.width * .4);
  }
  if (surface.opened) return part ? componentFirePoint(part, origin, random, surface.componentProfile?.(part.id)) :
    { x: origin.x + (random * 2 - 1) * (radius || .12), y: origin.y, carrier: origin.carrier };
  const pose = surface.pose, c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0),
    localX = c * (origin.x - pose.x) + s * (origin.y - pose.y), localY = -s * (origin.x - pose.x) + c * (origin.y - pose.y),
    across = (surface.axisC ?? 1) * localX - (surface.axisS || 0) * localY, reach = radius ?? surface.width * spread;
  if (surface.projected) {
    const left = Math.max(surface.min, across - reach), right = Math.min(surface.max, across + reach),
      x = right >= left ? left + (right - left) * random : Math.max(surface.min, Math.min(surface.max, across));
    let y = -Infinity;
    for (const polygon of surface.projected) for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!, b = polygon[(i + 1) % polygon.length]!;
      if (Math.abs(b.x - a.x) < 1e-9 || x < Math.min(a.x, b.x) || x > Math.max(a.x, b.x)) continue;
      y = Math.max(y, a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x));
    }
    if (Number.isFinite(y)) {
      const lx = surface.axisC * x + surface.axisS * y, ly = -surface.axisS * x + surface.axisC * y;
      return { x: pose.x + c * lx - s * ly, y: pose.y + s * lx + c * ly, carrier: surface.carrier };
    }
  }
  let p = surface.points[0]!, nearest = Infinity, count = 0;
  for (const site of surface.points) {
    const distance = Math.abs((site.across ?? site.x) - across);
    if (distance < nearest) { nearest = distance; p = site; }
    if (distance <= reach) count++;
  }
  if (count) {
    let index = Math.min(count - 1, Math.floor(random * count));
    for (const site of surface.points) if (Math.abs((site.across ?? site.x) - across) <= reach && index-- === 0) { p = site; break; }
  }
  return { x: pose.x + c * p.x - s * p.y, y: pose.y + s * p.x + c * p.y, carrier: surface.carrier };
}

// A small alpha sample of the finished artwork supplies four inset edge runs.
// This is prepared once per painted texture; a fire starts on the faces towards
// the ground. Its free tongue rises over the material and beyond its contour.
export function fireProfilePixels(pixels: ArrayLike<number>, width: number, height: number): FireProfile | null {
  const profile: FireProfile = [[], [], [], []], opaque = (x: number,y: number) => pixels[(y*width+x)*4+3]! >= 160,
    keep = (run: Point[],x: number,y: number,dx: number,dy: number) => {
      for(let step=0;step<2;step++){
        if(x+dx<0||x+dx>=width||y+dy<0||y+dy>=height||!opaque(x+dx,y+dy))break;
        x+=dx;y+=dy;
      }
      run.push({x:(x+.5)/width-.5,y:.5-(y+.5)/height});
    };
  for(let x=1;x<width-1;x++){
    for(let y=0;y<height;y++)if(opaque(x,y)){keep(profile[0],x,y,0,1);break;}
    for(let y=height-1;y>=0;y--)if(opaque(x,y)){keep(profile[1],x,y,0,-1);break;}
  }
  for(let y=1;y<height-1;y++){
    for(let x=0;x<width;x++)if(opaque(x,y)){keep(profile[2],x,y,1,0);break;}
    for(let x=width-1;x>=0;x--)if(opaque(x,y)){keep(profile[3],x,y,-1,0);break;}
  }
  return profile.every(run=>run.length) ? profile : null;
}

// The fallback serves missing/unfinished pictures and observers without parts.
// Only the root turns with its carrier; the flame's upward folds stay upright.
export function componentFirePoint(part: FirePiece, pose: FirePose, random: number, profile: FireProfile | null | undefined = null): FirePoint {
  const width = part.width || .24, height = part.height || .24, u = Math.max(0, Math.min(1, random)),
    c = Math.cos(pose.angle || 0), s = Math.sin(pose.angle || 0), mirror=part.kind!=='weapon'&&part.mirrored?-1:1,
    side=Math.abs(s)/(Math.abs(s)+Math.abs(c)), across=side===1||u<side,
    along=across?u/side:(u-side)/(1-side),face=across?(s*mirror>=0?2:3):(c>=0?1:0);
  let x, y;
  if (profile) {
    const run=profile[face],point=run[Math.min(run.length-1,Math.floor(along*run.length))]!;
    x=point.x*width*mirror;y=point.y*height;
  }
  else if(across){x=(face===2?-1:1)*mirror*width*.35;y=(along*2-1)*height*.3;}
  else {x=(along*2-1)*width*.35;y=(face===1?-1:1)*height*.35;}
  return { x: pose.x + c * x - s * y, y: pose.y + s * x + c * y, carrier: part.id || pose.carrier,
    span:Math.max(.35,Math.min(2.4,Math.max(width,height))),profile };
}
