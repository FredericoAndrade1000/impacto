import { MATERIALS } from './materials.ts';
import { clamp, localToWorld, pointInTriangle } from './math.ts';
import { DamageRegions } from './damage-regions.ts';
import { gridRegions } from './armor-grid.ts';
import type { ArmourMaterial, MaterialId } from './materials.ts';
import type { Basis, Point, Pose, PlateGeometry, LocalPoint } from './math.ts';
import type { PolygonProperties } from './damage-regions.ts';
import type { MaterialGrid, GridBounds } from './armor-grid.ts';
import type { CompiledPlate } from './construction-contract.ts';
import type { ScenePlate, SurfaceMark, PlatePerforation, PlateDent } from './scene-contract.ts';
import type { Vehicle } from './vehicle.ts';

export interface PlateDefinition extends PlateGeometry {
  id: string; actorId?: string | undefined; material: MaterialId; anchors?: LocalPoint[]; widthM?: number;
  mountId?: string | null; owner?: number; massScale?: number; ballisticGrid?: MaterialGrid;
  originalArea?: number; physicalMass?: number; physicalInertia?: number; physicalCenterLocal?: Point;
  chassis?: CompiledPlate['chassis']; dragWidthM?: number;
}
export interface MeshNode extends Point { u: number; v: number; local: Point }
export interface SolidSpan { lo: number; hi: number }
type PhysicalFields = Pick<PlateDefinition, 'originalArea' | 'physicalMass' | 'physicalInertia' | 'physicalCenterLocal'>;
function copyPhysical<K extends keyof PhysicalFields>(target: PhysicalFields, source: PhysicalFields, key: K): void {
  const value = source[key]; if (value !== undefined) target[key] = value;
}

// One rigid outline and bounded local damage. Hits never refine or integrate vertices.
export class PlateMesh {
  declare definition: PlateDefinition & { anchors: LocalPoint[] };
  declare id: string; declare actorId: string | undefined; declare material: ArmourMaterial; declare massScale: number;
  declare frame: Point & Basis; declare nodes: MeshNode[];
  declare materialFrame: Point & { u: Point; v: Point; det: number };
  declare marks: SurfaceMark[]; declare perforations: PlatePerforation[]; declare revision: number; declare markRevision: number;
  declare activeIndices: Uint32Array; declare damage: DamageRegions; declare originalArea: number;
  declare ballisticGrid?: MaterialGrid; declare physicalMass?: number; declare physicalInertia?: number; declare physicalCenterLocal?: Point;
  declare groundMarks?: number; declare attached?: boolean; declare source?: string;
  declare dents?: Map<number, PlateDent>; declare carrier?: Vehicle | null;
  declare spans: SolidSpan[]; declare bounds: GridBounds;

  constructor(definition: PlateDefinition) {
    const thickness = definition.thicknessMm / 1000,
      coordinates: [number, number][] = [[0,1],[1,1],[1,0],[0,0]],
      nodes = coordinates.map(([u,v]) => ({
        ...localToWorld(definition,(u-.5)*definition.length,(.5-v)*thickness), u, v,
        ...(definition.ballisticGrid ? { local: { x: (u-.5)*definition.length, y: (.5-v)*thickness } } : {}),
      }));
    this.definition = structuredClone({ ...definition, anchors: definition.anchors || [] });
    this.id = definition.id; this.actorId = definition.actorId;
    // A plate of a chassis weighs what its model makes it (`massScale`); any other is as wide as the hull.
    this.material = MATERIALS[definition.material]; this.massScale = definition.massScale ?? (definition.widthM || 1);
    this.frame = { x: definition.x, y: definition.y,
      c: Math.cos(definition.angle || 0), s: Math.sin(definition.angle || 0) };
    this.nodes = nodes.map(n => {
      const dx = n.x-this.frame.x, dy = n.y-this.frame.y;
      return { ...n, local: n.local ? { ...n.local } :
        {x:this.frame.c*dx+this.frame.s*dy,y:-this.frame.s*dx+this.frame.c*dy} };
    });
    // The texture/material frame is affine and immutable.
    const a=this.nodes[0]!;
    const b=this.nodes[1]!,c=this.nodes[2]!,du=b.u-a.u,dv=b.v-a.v,eu=c.u-a.u,ev=c.v-a.v,det=du*ev-dv*eu;
    const u={x:((b.local.x-a.local.x)*ev-(c.local.x-a.local.x)*dv)/det,
      y:((b.local.y-a.local.y)*ev-(c.local.y-a.local.y)*dv)/det},
      v={x:((c.local.x-a.local.x)*du-(b.local.x-a.local.x)*eu)/det,
        y:((c.local.y-a.local.y)*du-(b.local.y-a.local.y)*eu)/det};
    this.materialFrame={u,v,x:a.local.x-u.x*a.u-v.x*a.v,y:a.local.y-u.y*a.u-v.y*a.v,det:u.x*v.y-u.y*v.x};
    this.marks = []; this.perforations = []; this.revision = 0;
    this.markRevision = 0;
    this.activeIndices = new Uint32Array([0,1,2,0,2,3]);
    this.damage = new DamageRegions(this.nodes.map(n=>({...n.local,u:n.u,v:n.v})),this.activeIndices);
    this.damage.refresh(); this.revision++; this.refreshSpans();
    this.updateBounds();
    this.originalArea = this.remainingArea;
    if (definition.ballisticGrid) {
      // Native construction already cut the passage and fixed its properties.
      // The host projects that exact grid; it never heals/reopens the port.
      this.ballisticGrid = definition.ballisticGrid;
      this.damage.regions = gridRegions(this.ballisticGrid); this.damage.refresh(); this.refreshSpans();
      for (const key of ['originalArea', 'physicalMass', 'physicalInertia', 'physicalCenterLocal'] satisfies (keyof PhysicalFields)[])
        copyPhysical(this, definition, key);
    }
  }
  updateBounds() {
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    const f=this.frame, live=this.remainingArea>1e-12;
    for (const n of this.nodes) {
      n.x=f.x+f.c*n.local.x-f.s*n.local.y; n.y=f.y+f.s*n.local.x+f.c*n.local.y;
      if (live) { minX=Math.min(minX,n.x);minY=Math.min(minY,n.y);maxX=Math.max(maxX,n.x);maxY=Math.max(maxY,n.y); }
    }
    this.bounds={minX,minY,maxX,maxY};
  }
  get solidRegions() { return this.damage.regions; }
  get remainingArea() { return this.damage.properties.area; }
  get massProperties(): PolygonProperties { return this.damage.properties; }
  get integrity() { const ratio=this.originalArea ? clamp(this.remainingArea/this.originalArea,0,1) : 0; return ratio>1-1e-12?1:ratio; }
  localPoint(point: Point): Point {
    const dx=point.x-this.frame.x,dy=point.y-this.frame.y;
    return {x:this.frame.c*dx+this.frame.s*dy,y:-this.frame.s*dx+this.frame.c*dy};
  }
  containsLocal(point: Point): boolean {
    if (!this.solidRegions.some(r=>point.x>=r.minX-1e-10&&point.x<=r.maxX+1e-10&&point.y>=r.minY-1e-10&&point.y<=r.maxY+1e-10)) return false;
    const ids=this.activeIndices,nodes=this.nodes;
    for(let i=0;i<ids.length;i+=3)
      if(pointInTriangle(point,nodes[ids[i]!]!.local,nodes[ids[i+1]!]!.local,nodes[ids[i+2]!]!.local))return true;
    return false;
  }
  materialUV(point: Point,fallback=true): LocalPoint | null {
    const p=this.localPoint(point);
    if (!fallback&&!this.containsLocal(p)) return null;
    const f=this.materialFrame,dx=p.x-f.x,dy=p.y-f.y;
    return {u:clamp((dx*f.v.y-dy*f.v.x)/f.det,0,1),v:clamp((f.u.x*dy-f.u.y*dx)/f.det,0,1)};
  }
  materialPosition(uv: LocalPoint): Point | null {
    const f=this.materialFrame,p={x:f.x+f.u.x*uv.u+f.v.x*uv.v,y:f.y+f.u.y*uv.u+f.v.y*uv.v};
    if (!this.containsLocal(p)) return null;
    return {x:this.frame.x+this.frame.c*p.x-this.frame.s*p.y,y:this.frame.y+this.frame.s*p.x+this.frame.c*p.y};
  }
  solidSpans() { return this.spans; }
  refreshSpans() {
    const ranges=this.damage.polygons().map(poly=>({lo:Math.min(...poly.map(p=>p.x))/this.definition.length+.5,
      hi:Math.max(...poly.map(p=>p.x))/this.definition.length+.5})).sort((a,b)=>a.lo-b.lo),spans: SolidSpan[]=[];
    for(const range of ranges) {const old=spans.at(-1);if(old&&range.lo<=old.hi+1e-10)old.hi=Math.max(old.hi,range.hi);else spans.push({...range});}
    this.spans=spans;
  }
  snapshot(): ScenePlate {
    // Damage replaces these collections; readers retain them without writing into them.
    // Keep the wrapper new while old snapshots keep the material they were handed.
    return {id:this.id,actorId:this.actorId,material:this.definition.material,definition:this.definition,
      ballisticGrid:this.ballisticGrid,solidRegions:this.solidRegions,
      integrity:this.integrity,revision:this.revision,marks:this.marks,markRevision:this.markRevision,
      physicalMass:this.physicalMass,physicalInertia:this.physicalInertia,physicalCenterLocal:this.physicalCenterLocal,attached:this.attached!==false};
  }
}
