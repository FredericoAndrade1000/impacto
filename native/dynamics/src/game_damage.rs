//! Persistent damage state. A part keeps its installation identity after failure;
//! only its fixed material lattice and functional state change. Damage takes no mass off the carrier:
//! what a reservoir holds does, when the construction is weighed again.
pub use crate::game_geometry::{Bounds, Point, Pose};
use serde::{Deserialize, Serialize};
use crate::game_geometry::{CARGO, ComponentKind, MaterialGrid, region_interval};
use crate::game_projectiles::Blast;
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

const EPS: f64 = 1e-12;
/// How many sums of plate material are kept before all are let go.
const MATERIAL_KEPT: usize = 4096;
/// The share of its health a gun's barrel takes, in damage of its own, before it is disabled.
pub(crate) const BARREL_DISABLED_SHARE: f64 = 0.35;
/// The share of its health a gun's compartment of ready rounds takes, in hits of its own, before it is wrecked and the
/// rounds in it go off: as a box of them goes off below 38 % of its health (`damage_module`).
pub(crate) const READY_COOKS: f64 = 0.62;
/// How deep a plate is dented at most, as a share of its thickness.
pub(crate) const DENT_SHARE: f64 = 0.26;
thread_local! {
    /// The material of plates already summed, by what each sum was made from.
    static MATERIAL: std::cell::RefCell<HashMap<Vec<u64>, MassProperties>> = std::cell::RefCell::new(HashMap::new());
}
pub fn point(x: f64, y: f64) -> Point {
    Point { x, y }
}
pub fn add(a: Point, b: Point) -> Point {
    point(a.x + b.x, a.y + b.y)
}
pub fn sub(a: Point, b: Point) -> Point {
    point(a.x - b.x, a.y - b.y)
}
pub fn scale(a: Point, s: f64) -> Point {
    point(a.x * s, a.y * s)
}
pub fn dot(a: Point, b: Point) -> f64 {
    a.x * b.x + a.y * b.y
}
pub fn cross(a: Point, b: Point) -> f64 {
    a.x * b.y - a.y * b.x
}
pub fn length(a: Point) -> f64 {
    crate::game_geometry::hypot(a.x, a.y)
}
pub fn unit(a: Point) -> Point {
    scale(a, 1.0 / length(a).max(1e-15))
}
pub fn num(v: &Value, key: &str, default: f64) -> f64 {
    v.get(key).and_then(Value::as_f64).unwrap_or(default)
}
pub fn flag(v: &Value, key: &str, default: bool) -> bool {
    v.get(key).and_then(Value::as_bool).unwrap_or(default)
}
pub fn optional_id(v: &Value, key: &str) -> Option<u32> {
    v.get(key).and_then(Value::as_u64).map(|n| n as u32)
}
fn array<'a>(v: &'a Value, key: &str) -> &'a [Value] {
    v.get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

/// What a sensor looks out with where something may stand in its way: light, for a camera and a
/// command post, or the waves of a radar. A microphone hears through whatever stands about it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Wave {
    Light,
    Radio,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MaterialKind {
    Steel,
    Aluminum,
    Ceramic,
    Concrete,
    HardSteel,
    Titanium,
    Fiberglass,
    Glass,
    Plastic,
}
impl MaterialKind {
    pub fn name(self) -> &'static str {
        match self {
            MaterialKind::Steel => "steel",
            MaterialKind::Aluminum => "aluminum",
            MaterialKind::Ceramic => "ceramic",
            MaterialKind::Concrete => "concrete",
            MaterialKind::HardSteel => "hha",
            MaterialKind::Titanium => "titanium",
            MaterialKind::Fiberglass => "fiberglass",
            MaterialKind::Glass => "glass",
            MaterialKind::Plastic => "plastic",
        }
    }
}
/// One row per armour material. A plate keeps its own copy, so an impact
/// reads these numbers without any lookup. `resistance` is what a millimetre
/// of it takes from a shot, and `blast` what it stands of an explosion; `spall`
/// scales the energy thrown inward by a perforation and is exactly one for the
/// original materials.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Material {
    pub kind: MaterialKind,
    pub density: f64,
    pub resistance: f64,
    /// The same as `resistance` in every material but concrete.
    pub blast: f64,
    pub brittle: bool,
    pub ricochet: f64,
    pub spall: f64,
    /// Workshop price of installed armour, in credits per kilogram.
    pub price: f64,
}
impl Material {
    const fn row(kind: MaterialKind, density: f64, resistance: f64, brittle: bool, ricochet: f64, spall: f64, price: f64) -> Self {
        Self { kind, density, resistance, blast: resistance, brittle, ricochet, spall, price }
    }
    /// The materials a construction may name. Steel is the reference, rolled armour plate, and the
    /// resistance of each of the others is 1.25 times the thickness of that steel a millimetre of
    /// it is worth against a shot, within the range its published ballistic tests give.
    pub fn named(name: &str) -> Option<Self> {
        Some(match name {
            "steel" => Self::row(MaterialKind::Steel, 7800.0, 1.25, false, 0.30, 1.0, 1.4),
            "aluminum" => Self::row(MaterialKind::Aluminum, 2700.0, 0.48, false, 0.24, 1.0, 3.2),
            // A ceramic plate on its backing, as it is fielded: a bare tile would be worth far less.
            "ceramic" => Self::row(MaterialKind::Ceramic, 3500.0, 1.30, true, 0.20, 1.0, 6.0),
            // A shot bores through concrete far more easily than a blast breaks it: a wall stands
            // an explosion by its mass, and that is the one number that is not its resistance. It is
            // paid by what it is made of: 0.8 a kilogram for its sand, gravel and cement, and 0.06 for
            // the bar that reinforces it, some 100 kg of steel to the cubic metre (src/economy.js `OWN_PRICES`).
            "concrete" => Self { blast: 0.38, ..Self::row(MaterialKind::Concrete, 2350.0, 0.18, true, 0.12, 1.0, 0.86) },
            // High-hardness steel: more resistance for the same plate, but it throws more spall.
            "hha" => Self::row(MaterialKind::HardSteel, 7850.0, 1.55, false, 0.36, 1.3, 2.6),
            "titanium" => Self::row(MaterialKind::Titanium, 4500.0, 1.12, false, 0.28, 0.9, 12.0),
            // Glass-fibre laminate: bulky and soon worn, yet it sheds almost no spall.
            "fiberglass" => Self::row(MaterialKind::Fiberglass, 1950.0, 0.30, true, 0.08, 0.2, 3.2),
            "glass" => Self::row(MaterialKind::Glass, 2500.0, 0.20, true, 0.10, 0.7, 9.0),
            _ => return None,
        })
    }
    /// Polyethylene, which only pieces are made of (game_geometry.rs `Metal::material`), never a plate: a moulding gives
    /// way to what strikes it, splitting where a metal would dent, and a shot sinks into it rather than glance off. A
    /// millimetre of it is worth an eighth of one of steel, as it is an eighth as dense.
    pub const PLASTIC: Self = Self::row(MaterialKind::Plastic, 950.0, 0.15, true, 0.05, 0.2, 1.6);
    pub fn from_name(name: &str) -> Self {
        Self::named(name).unwrap_or(Self::row(MaterialKind::Steel, 7800.0, 1.25, false, 0.30, 1.0, 1.4))
    }
    pub fn name(self) -> &'static str {
        self.kind.name()
    }
    /// The wave that runs through it, if one does: light through glass, the waves of a radar through
    /// fibreglass and polyethylene. It stops everything else as its numbers say.
    pub fn clear_to(self) -> Option<Wave> {
        match self.kind {
            MaterialKind::Glass => Some(Wave::Light),
            MaterialKind::Fiberglass | MaterialKind::Plastic => Some(Wave::Radio),
            _ => None,
        }
    }
    /// The thinnest plate of it a construction may have, in millimetres: the one that bends no more, and
    /// breaks under no smaller a load, than five millimetres of the steel of reference. A plate resists
    /// bending by its modulus times the cube of its thickness and breaks at its strength times the square
    /// of it, so the least is five times the greater of the cube root of how much less stiff the material
    /// is than that steel (200 GPa) and the square root of how much weaker (900 MPa), to the millimetre,
    /// and never under the five of the steel.
    pub fn least_thickness(self) -> f64 {
        match self.kind {
            MaterialKind::Steel | MaterialKind::HardSteel => 5.0,
            // 114 GPa: it gives where steel would not.
            MaterialKind::Titanium => 6.0,
            // 70 GPa, and 380 MPa of an armour alloy.
            MaterialKind::Aluminum => 8.0,
            // A tile breaks at 350 MPa in bending.
            MaterialKind::Ceramic => 8.0,
            // 26 GPa: a laminate is a seventh as stiff as steel.
            MaterialKind::Fiberglass => 10.0,
            // 100 MPa in bending, laminated.
            MaterialKind::Glass => 15.0,
            // 9 MPa in bending, reinforced: a slab, never a sheet.
            MaterialKind::Concrete => 50.0,
            // 1 GPa: a moulding is a two-hundredth as stiff as steel, and no plate is made of it.
            MaterialKind::Plastic => 29.0,
        }
    }
    /// Whether only a construction that does not drive may be made of it.
    pub fn fixed(self) -> bool {
        self.kind == MaterialKind::Concrete
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Impulse {
    pub owner: u32,
    pub point: Point,
    pub impulse: Point,
}
#[derive(Default)]
pub struct Effects {
    pub impulses: Vec<Impulse>,
    pub region_changes: Vec<u32>,
    pub events: Vec<Value>,
    pub detonations: Vec<Blast>,
    pub visual_events: bool,
}
impl Effects {
    pub fn new(visual_events: bool) -> Self {
        Self {
            visual_events,
            ..Self::default()
        }
    }
    pub fn impulse(&mut self, owner: u32, at: Point, impulse: Point) {
        if length(impulse) > 1e-12 {
            self.impulses.push(Impulse {
                owner,
                point: at,
                impulse,
            });
        }
    }
    pub fn event(&mut self, event: Value) {
        if self.visual_events {
            self.events.push(event);
        }
    }
}
/// The counts of what was fired and struck on a field, as a frame tells them.
#[derive(Default, Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CombatStats {
    pub shots: u64,
    pub impacts: u64,
    pub penetrations: u64,
    pub ricochets: u64,
    pub explosions: u64,
    pub spall_bursts: u64,
    pub secondary_shots: u64,
    pub secondary_component_hits: u64,
}
impl CombatStats {
    pub fn from_value(v: &Value) -> Self {
        Self {
            shots: num(v, "shots", 0.0) as u64,
            impacts: num(v, "impacts", 0.0) as u64,
            penetrations: num(v, "penetrations", 0.0) as u64,
            ricochets: num(v, "ricochets", 0.0) as u64,
            explosions: num(v, "explosions", 0.0) as u64,
            spall_bursts: num(v, "spallBursts", 0.0) as u64,
            secondary_shots: num(v, "secondaryShots", 0.0) as u64,
            secondary_component_hits: num(v, "secondaryComponentHits", 0.0) as u64,
        }
    }
    pub fn to_value(&self) -> Value {
        json!(self)
    }
}
#[derive(Clone, Copy, Default, Debug, Serialize, Deserialize)]
pub struct MassProperties {
    pub area: f64,
    pub center: Point,
    pub second: f64,
}
pub fn polygon_properties(poly: &[Point]) -> MassProperties {
    let mut p = MassProperties::default();
    if poly.len() < 3 {
        return p;
    }
    for i in 1..poly.len() - 1 {
        let (a, b, c) = (poly[0], poly[i], poly[i + 1]);
        let m = cross(sub(b, a), sub(c, a)).abs() / 2.0;
        p.area += m;
        p.center = add(p.center, scale(add(add(a, b), c), m / 3.0));
        p.second +=
            m / 6.0 * (dot(a, a) + dot(b, b) + dot(c, c) + dot(a, b) + dot(b, c) + dot(c, a));
    }
    if p.area > 0.0 {
        p.center = scale(p.center, 1.0 / p.area);
    }
    p
}
pub fn clip_region(poly: &[Point], bounds: Bounds) -> Vec<Point> {
    let mut points = poly.to_vec();
    for (axis, edge, sign) in [
        (0, bounds.min_x, 1.0),
        (0, bounds.max_x, -1.0),
        (1, bounds.min_y, 1.0),
        (1, bounds.max_y, -1.0),
    ] {
        let mut next = Vec::with_capacity(points.len() + 2);
        for i in 0..points.len() {
            let (a, b) = (points[i], points[(i + 1) % points.len()]);
            let coordinate = |p: Point| if axis == 0 { p.x } else { p.y };
            let da = sign * (coordinate(a) - edge);
            let db = sign * (coordinate(b) - edge);
            if da >= -EPS {
                next.push(a);
            }
            if (da >= -EPS) != (db >= -EPS) {
                let mut p = add(a, scale(sub(b, a), da / (da - db)));
                if axis == 0 {
                    p.x = edge
                } else {
                    p.y = edge
                }
                next.push(p);
            }
        }
        points = next;
        if points.len() < 3 {
            return Vec::new();
        }
    }
    points
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Perforation {
    pub u: f64,
    pub radius: f64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Span {
    pub lo: f64,
    pub hi: f64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Dent {
    pub uv: Point,
    pub depth: f64,
    pub radius: f64,
}
#[derive(Clone, Debug, Serialize)]
pub struct Mark {
    pub uv: Point,
    pub kind: &'static str,
    pub strength: f64,
    pub depth: f64,
    pub radius: f64,
    pub part: Option<u8>,
}
// A mark read back from a state written out: its kind is one of the few the game names marks by.
impl<'de> Deserialize<'de> for Mark {
    fn deserialize<D: serde::Deserializer<'de>>(said: D) -> Result<Self, D::Error> {
        let (uv, kind, strength, depth, radius, part): (Point, String, f64, f64, f64, Option<u8>) = Deserialize::deserialize(said)?;
        if part.is_some_and(|p|p!=2&&p!=3) {return Err(serde::de::Error::custom("Invalid mark material part"));}
        Ok(Self { uv, kind: crate::word(&kind, &["dent", "burn", "hole", "crack", "ricochet"])?, strength, depth, radius, part })
    }
}
fn marks_from_value(v: &Value, limit: usize, base:bool) -> Result<Vec<Mark>,String> {
    let marks = array(v, "marks");
    let offset = marks.len().saturating_sub(limit);
    marks[offset..]
        .iter()
        .map(|m| {let part=match m.get("part").filter(|p|!p.is_null()) {
            None=>None,Some(p)=>Some(p.as_u64().filter(|p|base&&matches!(*p,2|3))
                .ok_or("Invalid mark material part")? as u8),
        };Ok(Mark {
            uv: point(num(m, "u", 0.5), num(m, "v", 0.5)),
            kind: match m["kind"].as_str().unwrap_or("dent") {
                "burn" => "burn",
                "hole" => "hole",
                "crack" => "crack",
                "ricochet" => "ricochet",
                _ => "dent",
            },
            strength: num(m, "strength", 0.0),
            depth: num(m, "depth", 0.0),
            radius: num(m, "radius", num(m, "radiusU", 0.0)),
            part,
        })})
        .collect()
}
#[derive(Clone, Debug)]
pub struct RemovedPatch {
    pub area: f64,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
struct MaterialFrame {
    origin: Point,
    u: Point,
    v: Point,
    det: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Plate {
    pub owner: u32,
    pub actor: u32,
    pub attached: bool,
    pub pose: Pose,
    pub local_nodes: Vec<Point>,
    pub uvs: Vec<Point>,
    pub indices: Vec<u32>,
    pub length: f64,
    pub thickness: f64,
    pub material: Material,
    pub material_scale: f64,
    pub mass_scale: f64,
    pub grid: Arc<MaterialGrid>,
    pub properties: MassProperties,
    pub physical_mass: f64,
    pub physical_inertia: f64,
    pub physical_center: Point,
    pub original_area: f64,
    pub perforations: Vec<Perforation>,
    pub revision: u64,
    pub mark_revision: u64,
    /// How many of its revisions and mark revisions the ground made (game_contact_damage.rs): a fall is no hit.
    pub ground_marks: u64,
    pub marks: Vec<Mark>,
    pub dents: BTreeMap<u32, Dent>,
    pub velocity: Point,
    pub angular_velocity: f64,
    pub mass_center_world: Point,
    pub radius: f64,
    pub cold: Value,
    material_frame: MaterialFrame,
}
impl Plate {
    pub fn from_value(owner: u32, actor: u32, value: &Value) -> Result<Self, String> {
        use crate::game_flight::required;
        if ["isFragment","source","solidRegions","regions","massRevision"].iter().any(|key|value.get(*key).is_some()) {
            return Err("Obsolete plate state is not admitted".into());
        }
        let d = value.get("definition").filter(|v|v.is_object()).ok_or("Missing plate definition")?;
        let pose = Pose {x:required(d,"x")?,y:required(d,"y")?,angle:required(d,"angle")?};
        let length = required(d,"length")?;
        let thickness = required(d,"thicknessMm")? / 1000.0;
        if length <= 0.0 || thickness <= 0.0 {return Err("Invalid plate dimensions".into());}
        let nodes = value["vertices"].as_array().filter(|v|v.len()>=3).ok_or("Missing local material vertices")?;
        let local_nodes = nodes.iter().map(|p|Ok(point(required(p,"x")?,required(p,"y")?)))
            .collect::<Result<Vec<_>,String>>()?;
        let raw_uv = value["uvs"].as_array().filter(|v|v.len()==local_nodes.len()*2).ok_or("Invalid material UVs")?;
        let uvs = raw_uv.chunks_exact(2).map(|p| {
            let x=p[0].as_f64().filter(|v|v.is_finite()).ok_or("Invalid material UVs")?;
            let y=p[1].as_f64().filter(|v|v.is_finite()).ok_or("Invalid material UVs")?;
            Ok(point(x,y))
        }).collect::<Result<Vec<_>,String>>()?;
        let indices = value["indices"].as_array().filter(|v|!v.is_empty() && v.len().is_multiple_of(3)).ok_or("Invalid material triangulation")?
            .iter().map(|v|v.as_u64().filter(|&i|i<local_nodes.len() as u64)
                .map(|i|i as u32).ok_or("Invalid material triangulation"))
            .collect::<Result<Vec<_>,_>>()?;
        let bounds = Bounds::points(&local_nodes);
        let grid = MaterialGrid::from_value(&value["ballisticGrid"]).ok_or("Invalid ballistic grid")?;
        if grid.bounds != bounds {return Err("Ballistic grid bounds differ from the base plate".into());}
        let material_name = d["material"].as_str().filter(|name|Material::named(name).is_some())
            .ok_or("Invalid plate material")?;
        let material = Material::from_name(material_name);
        let mut result = Self {
            owner,
            actor,
            attached: flag(value, "attached", true),
            pose,
            local_nodes,
            uvs,
            indices,
            length,
            thickness,
            material,
            material_scale: num(value, "materialScale", 1.0),
            mass_scale: num(value, "massScale", num(d, "massScale", num(d, "widthM", 1.0))),
            grid: Arc::new(grid),
            properties: MassProperties::default(),
            physical_mass: 0.0,
            physical_inertia: 0.0,
            physical_center: Point::ZERO,
            original_area: 0.0,
            perforations: Vec::new(),
            revision: num(value, "revision", 1.0) as u64,
            mark_revision: num(value, "markRevision", 0.0) as u64,
            ground_marks: num(value, "groundMarks", 0.0) as u64,
            marks: marks_from_value(value, 32, false)?,
            dents: BTreeMap::new(),
            velocity: point(num(value, "vx", 0.0), num(value, "vy", 0.0)),
            angular_velocity: num(value, "omega", 0.0),
            mass_center_world: point(pose.x, pose.y),
            radius: 0.0,
            cold: value.clone(),
            material_frame: MaterialFrame {
                origin: point(-length / 2.0, thickness / 2.0),
                u: point(length, 0.0),
                v: point(0.0, -thickness),
                det: -length * thickness,
            },
        };
        // Existing cuts live in the ballistic grid. Retired impact histories
        // have no effect on that material and are not carried into new saves.
        if let Some(cold) = result.cold.as_object_mut() {
            cold.remove("wear");
            cold.remove("wearCount");
        }
        result.build_material_frame();
        result.refresh();
        // Ballistic regions may change; physical admission data never do.
        let mut base = MassProperties::default();
        for polygon in result.polygons_in(bounds) {
            let part = polygon_properties(&polygon);
            base.area += part.area;
            base.center = add(base.center, scale(part.center, part.area));
            base.second += part.second;
        }
        if base.area > 0.0 {
            base.center = scale(base.center, 1.0 / base.area);
        }
        let density = result.material.density * result.mass_scale;
        result.physical_mass = num(value, "physicalMass", base.area * density).max(0.0);
        result.physical_inertia = num(
            value,
            "physicalInertia",
            (base.second - base.area * dot(base.center, base.center)).max(0.0) * density,
        )
        .max(0.0);
        result.physical_center = value
            .get("physicalCenterLocal")
            .map(Point::from_value)
            .unwrap_or(base.center);
        result.original_area = num(value, "originalArea", base.area);
        let dents = array(value, "dents");
        if !dents.is_empty() {
            for d in dents {
                let uv = point(num(d, "u", 0.5), num(d, "v", 0.5));
                let key =
                    (uv.x.clamp(0.0, 0.999999) * 32.0).floor() as u32 * 2 + u32::from(uv.y > 0.5);
                result.dents.insert(
                    key,
                    Dent {
                        uv,
                        depth: num(d, "depth", 0.0).clamp(0.0, result.thickness * DENT_SHARE),
                        radius: num(d, "radius", 0.0),
                    },
                );
            }
        } else {
            for m in &result.marks {
                if m.kind == "dent" && m.depth > 0.0 && m.radius > 0.0 {
                    let key = (m.uv.x.clamp(0.0, 0.999999) * 32.0).floor() as u32 * 2
                        + u32::from(m.uv.y > 0.5);
                    result.dents.insert(
                        key,
                        Dent {
                            uv: m.uv,
                            depth: m.depth.min(result.thickness * DENT_SHARE),
                            radius: m.radius,
                        },
                    );
                }
            }
        }
        Ok(result)
    }
    fn build_material_frame(&mut self) {
        if self.local_nodes.len() < 3 || self.uvs.len() != self.local_nodes.len() {
            return;
        }
        let (a, uv) = (self.local_nodes[0], self.uvs[0]);
        for i in 1..self.local_nodes.len() {
            for j in i + 1..self.local_nodes.len() {
                let (b, c) = (sub(self.local_nodes[i], a), sub(self.local_nodes[j], a));
                let (d, e) = (sub(self.uvs[i], uv), sub(self.uvs[j], uv));
                let det = cross(d, e);
                if det.abs() < EPS {
                    continue;
                }
                let u = scale(sub(scale(b, e.y), scale(c, d.y)), 1.0 / det);
                let v = scale(sub(scale(c, d.x), scale(b, e.x)), 1.0 / det);
                self.material_frame = MaterialFrame {
                    origin: sub(sub(a, scale(u, uv.x)), scale(v, uv.y)),
                    u,
                    v,
                    det: cross(u, v),
                };
                return;
            }
        }
    }
    pub fn polygons_in(&self, region: Bounds) -> Vec<Vec<Point>> {
        self.indices
            .chunks_exact(3)
            .filter_map(|tri| {
                let ids = [tri[0] as usize, tri[1] as usize, tri[2] as usize];
                if ids.iter().any(|&i| i >= self.local_nodes.len()) {
                    return None;
                }
                let poly = clip_region(
                    &[
                        self.local_nodes[ids[0]],
                        self.local_nodes[ids[1]],
                        self.local_nodes[ids[2]],
                    ],
                    region,
                );
                (polygon_properties(&poly).area > EPS).then_some(poly)
            })
            .collect()
    }
    /// The area, centre and second moment of the material in the occupied cells of the grid:
    /// every cell clipped out of every triangle. A field reloads all its plates whenever a
    /// construction comes or goes, and the plates of one design are the same on every vehicle
    /// built from it, so a sum is kept by the nodes, the triangles and the grid it was made from.
    fn material(&self) -> MassProperties {
        let grid = &self.grid;
        let mut key = Vec::with_capacity(7 + grid.words().len() + self.local_nodes.len() * 2 + self.indices.len());
        key.extend([grid.nx as u64, grid.ny as u64, grid.bounds.min_x.to_bits(), grid.bounds.max_x.to_bits(),
            grid.bounds.min_y.to_bits(), grid.bounds.max_y.to_bits(), self.local_nodes.len() as u64]);
        key.extend_from_slice(grid.words());
        key.extend(self.local_nodes.iter().flat_map(|p| [p.x.to_bits(), p.y.to_bits()]));
        key.extend(self.indices.iter().map(|&i| u64::from(i)));
        if let Some(known) = MATERIAL.with(|kept| kept.borrow().get(&key).copied()) {
            return known;
        }
        let mut properties = MassProperties::default();
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                if !grid.occupied(x, y) {
                    continue;
                }
                for poly in self.polygons_in(grid.cell_bounds(x, y)) {
                    let p = polygon_properties(&poly);
                    properties.area += p.area;
                    properties.center = add(properties.center, scale(p.center, p.area));
                    properties.second += p.second;
                }
            }
        }
        if properties.area > 0.0 {
            properties.center = scale(properties.center, 1.0 / properties.area);
        }
        MATERIAL.with(|kept| {
            let mut kept = kept.borrow_mut();
            // Every hole makes another grid: the sums of a long battle are let go together.
            if kept.len() >= MATERIAL_KEPT {
                kept.clear();
            }
            kept.insert(key, properties);
        });
        properties
    }
    pub fn refresh(&mut self) {
        let properties = self.material();
        self.properties = properties;
        self.refresh_projection();
        self.radius = self
            .local_nodes
            .iter()
            .map(|p| length(*p))
            .fold(0.0, f64::max);
    }
    fn refresh_projection(&mut self) {
        self.perforations.clear();
        let mut run: Option<(bool, usize)> = None;
        for x in 0..=self.grid.nx {
            let occupied = x < self.grid.nx && (0..self.grid.ny).any(|y| self.grid.occupied(x, y));
            if let Some((old, lo)) = run {
                if x == self.grid.nx || old != occupied {
                    let left = self.grid.bounds.min_x
                        + (self.grid.bounds.max_x - self.grid.bounds.min_x) * lo as f64
                            / self.grid.nx as f64;
                    let right = self.grid.bounds.min_x
                        + (self.grid.bounds.max_x - self.grid.bounds.min_x) * x as f64
                            / self.grid.nx as f64;
                    if !old {
                        self.perforations.push(Perforation {
                            u: (left + right) / 2.0,
                            radius: (right - left) / 2.0,
                        });
                    }
                    run = None;
                }
            }
            if run.is_none() && x < self.grid.nx {
                run = Some((occupied, x));
            }
        }
    }
    pub fn mass(&self) -> f64 {
        self.physical_mass
    }
    pub fn inertia(&self) -> f64 {
        self.physical_inertia
    }
    pub fn velocity_at(&self, p: Point) -> Point {
        let d = sub(p, self.mass_center_world);
        add(
            self.velocity,
            point(-self.angular_velocity * d.y, self.angular_velocity * d.x),
        )
    }
    pub fn contains_local(&self, p: Point) -> bool {
        self.grid.contains(p)
            && self.indices.chunks_exact(3).any(|t| {
                let (a, b, c) = (
                    self.local_nodes[t[0] as usize],
                    self.local_nodes[t[1] as usize],
                    self.local_nodes[t[2] as usize],
                );
                let (d, e, f) = (
                    cross(sub(b, a), sub(p, a)),
                    cross(sub(c, b), sub(p, b)),
                    cross(sub(a, c), sub(p, c)),
                );
                (d >= -EPS && e >= -EPS && f >= -EPS) || (d <= EPS && e <= EPS && f <= EPS)
            })
    }
    /// Where on the field a place of the material of the plate is: the point `material_uv` took it from.
    pub fn material_point(&self, uv: Point) -> Point {
        let frame = &self.material_frame;
        self.pose.world_point(add(add(frame.origin, scale(frame.u, uv.x)), scale(frame.v, uv.y)))
    }
    pub fn material_uv(&self, p: Point) -> Point {
        let d = sub(self.pose.local_point(p), self.material_frame.origin);
        point(
            (cross(d, self.material_frame.v) / self.material_frame.det).clamp(0.0, 1.0),
            (cross(self.material_frame.u, d) / self.material_frame.det).clamp(0.0, 1.0),
        )
    }
    pub fn mark(&mut self, p: Point, kind: &'static str, strength: f64) {
        self.marks.push(Mark {
            uv: self.material_uv(p),
            kind,
            strength,
            depth: 0.0,
            radius: 0.0,
            part: None,
        });
        if self.marks.len() > 32 {
            self.marks.remove(0);
        }
        self.mark_revision += 1;
    }
    pub fn record_dent(&mut self, p: Point, depth: f64, radius: f64) -> bool {
        if depth <= 1e-8 {
            return false;
        }
        let uv = self.material_uv(p);
        let key = (uv.x.clamp(0.0, 0.999999) * 32.0).floor() as u32 * 2 + u32::from(uv.y > 0.5);
        let old = self.dents.get(&key).map(|d| d.depth).unwrap_or(0.0);
        let amount = (old + depth).min(self.thickness * DENT_SHARE);
        if amount <= old + 1e-10 {
            return false;
        }
        self.dents.insert(
            key,
            Dent {
                uv,
                depth: amount,
                radius,
            },
        );
        self.mark(p, "dent", (amount / self.thickness).clamp(0.0, 1.0));
        if let Some(mark) = self.marks.last_mut() {
            mark.depth = amount;
            mark.radius = radius;
        }
        true
    }
    pub fn plastic_impression(
        &mut self,
        p: Point,
        direction: Point,
        strength: f64,
        power: f64,
        projectile_radius: f64,
        normal: Point,
        radius: Option<f64>,
        depth_limit: f64,
        depth_scale: f64,
    ) {
        if self.material.brittle || power <= 0.0 {
            return;
        }
        let incidence = dot(unit(direction), scale(unit(normal), -1.0)).max(0.0);
        let caliber = (projectile_radius * 2.0).max(0.002);
        let r = radius.unwrap_or((caliber * 1.75).max(0.055 * 1.3));
        let requested = caliber
            * (0.015 + 0.2 * strength.clamp(0.0, 1.0))
            * if power < 90.0 { 0.4 } else { 1.0 }
            * depth_scale;
        self.record_dent(
            p,
            (self.thickness * depth_limit).min(requested) * incidence,
            r,
        );
    }
    pub fn resistance_scale(&self, p: Point) -> f64 {
        let local = self.pose.local_point(p);
        let span = self.grid.bounds.max_x - self.grid.bounds.min_x;
        let x = (((local.x - self.grid.bounds.min_x) / span * self.grid.nx as f64).floor()
            as usize)
            .min(self.grid.nx - 1);
        self.grid.remaining_thickness(x) / (self.grid.bounds.max_y - self.grid.bounds.min_y)
    }
    // The optional local half-open band bounds normal damage depth. Clearing,
    // moments, revision and projection remain the same canonical grid path.
    pub fn cut_clipped(
        &mut self,
        start: Point,
        end: Point,
        radius: f64,
        clip: Option<Bounds>,
    ) -> Vec<RemovedPatch> {
        if !radius.is_finite() || radius <= 0.0 {
            return Vec::new();
        }
        let (a, b) = (self.pose.local_point(start), self.pose.local_point(end));
        let dx = (self.grid.bounds.max_x - self.grid.bounds.min_x) / self.grid.nx as f64;
        let dy = (self.grid.bounds.max_y - self.grid.bounds.min_y) / self.grid.ny as f64;
        let index = |v: f64, min: f64, step: f64, n: usize| {
            ((v - min) / step).floor().clamp(0.0, n as f64 - 1.0) as usize
        };
        let x0 = index(
            a.x.min(b.x) - radius,
            self.grid.bounds.min_x,
            dx,
            self.grid.nx,
        );
        let x1 = index(
            a.x.max(b.x) + radius,
            self.grid.bounds.min_x,
            dx,
            self.grid.nx,
        );
        let y0 = index(
            a.y.min(b.y) - radius,
            self.grid.bounds.min_y,
            dy,
            self.grid.ny,
        );
        let y1 = index(
            a.y.max(b.y) + radius,
            self.grid.bounds.min_y,
            dy,
            self.grid.ny,
        );
        let mut changed = Vec::new();
        let mut removed = MassProperties::default();
        for y in y0..=y1 {
            for x in x0..=x1 {
                if !self.grid.occupied(x, y) {
                    continue;
                }
                let cell = self.grid.cell_bounds(x, y);
                if clip.is_some_and(|limit| {
                    cell.min_x >= limit.max_x - EPS
                        || cell.max_x <= limit.min_x + EPS
                        || cell.min_y >= limit.max_y - EPS
                        || cell.max_y <= limit.min_y + EPS
                }) {
                    continue;
                }
                if region_interval(a, b, cell.padded(radius)).is_none() {
                    continue;
                }
                let polygons = self.polygons_in(cell);
                let mut area = 0.0;
                for poly in polygons {
                    let part = polygon_properties(&poly);
                    area += part.area;
                    removed.area += part.area;
                    removed.center = add(removed.center, scale(part.center, part.area));
                    removed.second += part.second;
                }
                if area > EPS {
                    changed.push((x, y));
                }
            }
        }
        if changed.is_empty() {
            return Vec::new();
        }
        let grid = Arc::make_mut(&mut self.grid);
        for (x, y) in changed {
            grid.clear_cell(x, y);
        }
        let first = sub(
            scale(self.properties.center, self.properties.area),
            removed.center,
        );
        self.properties.area = (self.properties.area - removed.area).max(0.0);
        self.properties.center = if self.properties.area > EPS {
            scale(first, 1.0 / self.properties.area)
        } else {
            Point::ZERO
        };
        self.properties.second = (self.properties.second - removed.second).max(0.0);
        self.revision += 1;
        self.refresh_projection();
        vec![RemovedPatch { area: removed.area }]
    }
    pub fn to_value(&self) -> Value {
        let mut value = self.cold.clone();
        value["owner"] = json!(self.owner);
        value["x"] = json!(self.pose.x);
        value["y"] = json!(self.pose.y);
        value["angle"] = json!(self.pose.angle);
        value["attached"] = json!(self.attached);
        value["revision"] = json!(self.revision);
        value["markRevision"] = json!(self.mark_revision);
        value["groundMarks"] = json!(self.ground_marks);
        value["mass"] = json!(self.mass());
        value["physicalMass"] = json!(self.physical_mass);
        value["physicalInertia"] = json!(self.physical_inertia);
        value["physicalCenterLocal"] =
            json!({"x":self.physical_center.x,"y":self.physical_center.y});
        value["massScale"] = json!(self.mass_scale);
        value["integrity"] = json!(if self.original_area > 0.0 {
            (self.properties.area / self.original_area).clamp(0.0, 1.0)
        } else {
            0.0
        });
        value["ballisticGrid"] = self.grid.to_value();
        value["remainingArea"] = json!(self.properties.area);
        value["vertices"] = json!(
            self.local_nodes
                .iter()
                .map(|p| p.to_value())
                .collect::<Vec<_>>()
        );
        value["positions"] = json!(
            self.local_nodes
                .iter()
                .flat_map(|p| {
                    let w = self.pose.world_point(*p);
                    [w.x, w.y]
                })
                .collect::<Vec<_>>()
        );
        value["indices"] = json!(self.indices);
        value["uvs"] = json!(self.uvs.iter().flat_map(|p| [p.x, p.y]).collect::<Vec<_>>());
        value["marks"]=json!(self.marks.iter().map(|m|json!({"u":m.uv.x,"v":m.uv.y,"kind":m.kind,"strength":m.strength,"depth":m.depth,"radius":m.radius})).collect::<Vec<_>>());
        value["perforations"] = json!(
            self.perforations
                .iter()
                .map(|p| json!({"u":p.u,"radius":p.radius}))
                .collect::<Vec<_>>()
        );
        value["dents"] = json!(
            self.dents
                .values()
                .map(|d| json!({"u":d.uv.x,"v":d.uv.y,"depth":d.depth,"radius":d.radius}))
                .collect::<Vec<_>>()
        );
        if let Some(d) = value.get_mut("definition") {
            d["x"] = json!(self.pose.x);
            d["y"] = json!(self.pose.y);
            d["angle"] = json!(self.pose.angle);
        }
        value
    }
}
pub fn merge_spans(mut spans: Vec<Span>) -> Vec<Span> {
    spans.sort_by(|a, b| a.lo.total_cmp(&b.lo));
    let mut merged: Vec<Span> = Vec::new();
    for span in spans {
        if let Some(previous) = merged.last_mut() {
            if span.lo <= previous.hi + 1e-10 {
                previous.hi = previous.hi.max(span.hi);
                continue;
            }
        }
        merged.push(span);
    }
    merged
}

/// The blast of rounds going off, as large as that of a box of `volume` m³ full of them: by the cube root of it, from what
/// one of 0.78 × 0.65 × 0.45 m does, 540 within 2.6 m, and never more than 950 within 6 m.
fn rounds_blast(at: Point, volume: f64, owner: u32, actor: u32) -> Option<Blast> {
    if !(volume.is_finite() && volume > 0.0) { return None; }
    let (reference, base_power, base_radius) = (0.78 * 0.65 * 0.45, 540.0, 2.6);
    let size = ComplexField::cbrt(volume / reference);
    Some(Blast { point: at, power: (base_power * size).min(950.0), radius: (base_radius * size).min(6.0), source: Some(owner),
        actor: Some(actor), details: Value::Null })
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct BarrelMark {
    pub point: Point,
    pub radius: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Module {
    pub owner: u32,
    pub actor: u32,
    pub kind: ComponentKind,
    pub pose: Pose,
    pub width: f64,
    pub height: f64,
    pub volume: f64,
    pub health: f64,
    pub max_health: f64,
    pub physical_mass: f64,
    pub physical_center: Point,
    pub physical_inertia: f64,
    pub mount: Option<crate::game_mounts::WeaponMount>,
    /// The steel column a sensor stands on or a blade hangs from off the metal that holds it, in its own frame
    /// (game_construction.rs `stand_off`): struck as the piece is.
    pub column: Option<Vec<Point>>,
    pub weapon: Option<crate::game_weapons::WeaponSpec>,
    pub dry_mass: f64,
    pub attached: bool,
    pub fuel_litres: f64,
    pub capacity_litres: f64,
    pub rounds: u32,
    pub capacity_rounds: u32,
    pub round_mass: f64,
    /// What a hopper, a cistern, a supply piece or a paver carries, in units of each of `CARGO`, and the room it has for
    /// it in cubic metres.
    pub cargo: [f64; CARGO.len()],
    pub cargo_room: f64,
    /// The armour a piece of running gear wears, in millimetres of steel.
    pub armour_mm: f64,
    pub ammo_preset: String,
    pub weapon_preset: String,
    pub detonated: bool,
    pub burning: bool,
    pub burn_age: f64,
    // Keep the existing checkpoint field/position; this clock now tracks shared fire growth.
    #[serde(rename = "smoke_clock")]
    pub fire_age: f64,
    pub barrel_angle: f64,
    pub barrel_damage: f64,
    pub barrel_disabled: bool,
    pub elevation_damage: f64,
    pub elevation_disabled: bool,
    pub mantlet_holes: Vec<(f64,f64)>,
    pub barrel_marks: Vec<BarrelMark>,
    pub barrel_end: f64,
    pub barrel_radius: f64,
    pub receiver_mm: f64,
    pub barrel_mm: f64,
    /// A track's belt cut; of a gun, the compartment of its ready rounds wrecked (`READY_COOKS`): none more is fed to it.
    pub belt_cut: bool,
    pub marks: Vec<Mark>,
    pub mark_revision: u64,
    /// How many of its mark revisions, and how much of its health, the ground took (game_contact_damage.rs): a fall is
    /// no hit.
    pub ground_marks: u64,
    pub ground_damage: f64,
    pub ballistic_scars: BTreeMap<u32, f64>,
    /// The share of the most a thruster pushes with (`ComponentKind::thrust_n`) that the flight computer gave it in the
    /// last step (game_hover.rs): none while its construction does not fly. Nothing else pushes.
    pub thrust: f64,
    pub cold: Value,
    /// Of a gun, the compartment of its ready rounds (game_variant.rs `compartment`): how far from the back of its receiver
    /// the rounds lie, m, and how many of how many litres each it holds; none for a gun loaded a round at a time. The rounds
    /// ready in it as its feed last told (`GameState::feed_guns`), and the hits it took.
    #[serde(default)]
    pub ready_length: f64,
    #[serde(default)]
    pub ready_capacity: u32,
    #[serde(default)]
    pub ready_litres: f64,
    #[serde(default)]
    pub ready: u32,
    #[serde(default)]
    pub ready_damage: f64,
    /// Whether the roof of its compartment is blow-out panels (game_variant.rs `PANEL_STEEL`): what goes off in it goes out
    /// through them (`ready_blast`).
    #[serde(default)]
    pub ready_vented: bool,
}
impl Module {
    /// How long, how high and how deep across the body a piece of `kind` told by `v` is, as it is admitted.
    pub fn extent(kind: ComponentKind, v: &Value) -> (f64, f64, f64) {
        let (base_w, base_h, base_d) = kind.dimensions();
        let width = num(v,"width",base_w);
        let default_height=base_h*if kind==ComponentKind::Weapon {1.0} else {width/base_w};
        let height = num(v,"height",default_height);
        let size=kind.scale(width,height);
        (width,height,num(v,"mechanicalDepth",crate::game_geometry::installed_depth(kind,base_d,size)))
    }
    pub fn from_value(owner: u32, actor: u32, v: &Value, catalogue: &Value, mounts:&Value) -> Result<Self, String> {
        use crate::game_flight::required;
        if ["barrelEnd","barrelRadius","isFragment","source"].iter().any(|key|v.get(*key).is_some()) {
            return Err("Obsolete component geometry is not admitted".into());
        }
        let kind = ComponentKind::from_name(v["kind"].as_str().ok_or("Missing component kind")?)?;
        let (width, height, depth) = Self::extent(kind, v);
        let volume = width*height*depth;
        let health = num(v,"maxHealth",kind.health());
        if ![width,height,depth,health].iter().all(|x|x.is_finite() && *x>0.0) {return Err("Invalid component dimensions/health".into());}
        let preset = |key:&str| -> Result<String,String> {
            let name=v[key].as_str().ok_or_else(||format!("Missing component {key}"))?;
            if !catalogue.get(name).is_some_and(Value::is_object) {return Err(format!("Unknown weapon {name}"));}
            Ok(name.to_owned())
        };
        let weapon_preset = if kind==ComponentKind::Weapon {preset("weaponPreset")?} else {String::new()};
        let ammo_preset = if kind==ComponentKind::Ammo {preset("ammoPreset")?} else {String::new()};
        let ready = if kind==ComponentKind::Weapon {crate::game_variant::compartment(&catalogue[&weapon_preset])} else {None};
        let ready_litres = if ready.is_some() {catalogue[&weapon_preset]["cartridge"]["litres"].as_f64().unwrap_or(0.0)} else {0.0};
        if let Some(ammo)=v.get("weaponAmmo") {
            if kind!=ComponentKind::Weapon || !catalogue[&weapon_preset]["allowedAmmo"].as_array().is_some_and(|feed|feed.contains(ammo)) {
                return Err("Unavailable weapon ammunition".into());
            }
        }
        let (mount,weapon,barrel) = if kind==ComponentKind::Weapon {
            let barrel=crate::game_geometry::BarrelProfile::from_weapon(&catalogue[&weapon_preset])?;
            if crate::game_geometry::BarrelProfile::from_value(v)? != barrel {
                return Err("Barrel profile differs from the catalogue".into());
            }
            let mount=crate::game_mounts::WeaponMount::admit(v,mounts,&catalogue[&weapon_preset],width,height,barrel)?;
            required(v,"receiverMm")?;required(v,"barrelMm")?;
            let weapon=crate::game_weapons::WeaponSpec::from_catalogue(catalogue,&weapon_preset,mount.max_speed)?;
            (Some(mount),Some(weapon),barrel)
        } else {
            if v.get("weaponMount").is_some() || v.get("barrelProfile").is_some() {return Err("Only weapons admit mounts".into());}
            (None,None,crate::game_geometry::BarrelProfile{start:0.0,end:0.0,radius:0.0})
        };
        let column=match v.get("support").and_then(|support|support.get("polygon")) {
            None=>None,
            Some(polygon)=>{
                if !matches!(kind,ComponentKind::Sensor|ComponentKind::Blade) {return Err("Only sensors and blades stand on a column".into());}
                let points=polygon.as_array().filter(|points|(3..=4).contains(&points.len())).ok_or("Invalid support column")?.iter()
                    .map(|p|{let q=Point::from_value(p);(q.x.is_finite()&&q.y.is_finite()&&length(q)<=width.max(height)+2.0).then_some(q)})
                    .collect::<Option<Vec<_>>>().ok_or("Invalid support column")?;
                if crate::game_geometry::signed_area(&points)<=0.0 {return Err("Invalid support column".into());}
                Some(points)
            }
        };
        let metal = crate::game_geometry::metal(kind, v)?;
        let (dry, round_mass) = if matches!(kind, ComponentKind::Fuel | ComponentKind::Ammo) {
            let shell = metal.mass * 2.0
                * (width * height + (width + height) * depth)
                * if kind == ComponentKind::Fuel {
                    0.002
                } else {
                    0.003
                }
                * 7800.0;
            let count = num(v, "rounds", 0.0);
            (
                shell,
                num(
                    v,
                    "roundMass",
                    if count > 0.0 {
                        ((num(v, "physicalMass", shell) - shell) / count).max(0.0)
                    } else {
                        27.0
                    },
                ),
            )
        } else if kind.carrier() {
            (kind.empty_mass(volume) * metal.mass, 0.0)
        } else {
            (num(v, "dryMass", num(v, "physicalMass", 0.0)), 0.0)
        };
        let marks=marks_from_value(v,48,mount.as_ref().is_some_and(|m|m.base.is_some()))?;
        let mut m = Self {
            owner,
            actor,
            kind,
            pose: Pose {
                x: num(v, "x", 0.0),
                y: num(v, "y", 0.0),
                angle: num(v, "angle", 0.0),
            },
            width,
            height,
            volume,
            health: num(v, "health", health),
            max_health: health,
            physical_mass: num(v, "physicalMass", dry),
            physical_center: Point::from_value(&v["physicalCenterLocal"]),
            physical_inertia: num(v,"physicalInertia",num(v,"physicalMass",dry)*(width*width+height*height)/12.0),
            mount,
            column,
            weapon,
            dry_mass: dry,
            attached: flag(v, "attached", true),
            fuel_litres: num(v, "fuelLitres", 0.0),
            capacity_litres: num(v, "capacityLitres", volume * 0.78 * 1000.0),
            rounds: num(v, "rounds", 0.0) as u32,
            capacity_rounds: num(v, "capacityRounds", 0.0) as u32,
            round_mass,
            cargo: [0.0; CARGO.len()],
            cargo_room: num(v, "capacityM3", kind.cargo_room(volume)).max(0.0),
            armour_mm: if kind.gear() {num(v, "armorMm", 0.0).clamp(0.0, kind.armour_limit())} else {0.0},
            ammo_preset,
            weapon_preset,
            detonated: flag(v, "detonated", false),
            burning: flag(v, "burning", false),
            burn_age: num(v, "burnAge", 0.0),
            fire_age: num(v, "fireAge", num(v, "smokeClock", 0.0)).max(0.0),
            barrel_angle: num(
                v,
                "barrelAngle",
                std::f64::consts::PI + num(v, "angle", 0.0),
            ),
            barrel_damage: num(v, "barrelDamage", 0.0),
            barrel_disabled: flag(v, "barrelDisabled", false),
            elevation_damage: num(v,"elevationDamage",0.0),
            elevation_disabled: flag(v,"elevationDisabled",false),
            mantlet_holes: Vec::new(),
            barrel_marks: v
                .get("barrelMarks")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .take(16)
                .map(|mark| BarrelMark {
                    point: Point::from_value(mark),
                    radius: num(mark, "radius", 0.025),
                })
                .collect(),
            barrel_end: barrel.end,
            barrel_radius: barrel.radius,
            receiver_mm: num(v, "receiverMm", 70.0),
            barrel_mm: num(v, "barrelMm", 22.0),
            belt_cut: flag(v, "beltCut", false),
            marks,
            mark_revision: num(v, "markRevision", 0.0) as u64,
            ground_marks: num(v, "groundMarks", 0.0) as u64,
            ground_damage: num(v, "groundDamage", 0.0).max(0.0),
            ballistic_scars: BTreeMap::new(),
            thrust: if kind == ComponentKind::Thruster { num(v, "thrust", 0.0).clamp(0.0, 1.0) } else { 0.0 },
            cold: v.clone(),
            ready_length: ready.map_or(0.0, |c| c.reach()),
            ready_capacity: ready.map_or(0, |c| c.rounds),
            ready_litres,
            ready: 0,
            ready_damage: num(v, "readyDamage", 0.0).max(0.0),
            ready_vented: ready.is_some_and(|c| c.vented),
        };
        if !m.elevation_damage.is_finite() || m.elevation_damage<0.0 || m.elevation_disabled!=(m.elevation_damage>=health*BARREL_DISABLED_SHARE) {
            return Err("Invalid elevation mechanism damage".into());
        }
        if let Some(holes)=v.get("mantletHoles") {
            m.set_mantlet_holes(holes)?;
        }
        if let Some(scars) = v.get("ballisticScars").and_then(Value::as_object) {
            for (key, value) in scars {
                let Some((u, w)) = key.split_once(':') else {
                    continue;
                };
                let (Ok(u), Ok(w)) = (u.parse::<u32>(), w.parse::<u32>()) else {
                    continue;
                };
                if u < 32 && w < 32 {
                    m.ballistic_scars
                        .insert(u * 32 + w, value.as_f64().unwrap_or(0.0).clamp(0.0, 8.0));
                }
            }
        }
        if let Some(held) = v.get("cargo") {
            m.stow(held)?;
        }
        Ok(m)
    }
    pub fn usable(&self) -> bool {
        self.attached && self.health > 0.0 && !self.detonated
    }
    /// What it was made of (`metal`), as it was admitted: steel when it says none.
    pub(crate) fn metal(&self) -> &'static crate::game_geometry::Metal {
        crate::game_geometry::metal(self.kind, &self.cold).unwrap_or(&crate::game_geometry::METALS[0])
    }
    /// The ammunition a gun was built to be fed, and the only one it fires: the first its feed
    /// takes is the one that is not written.
    pub fn weapon_ammo<'a>(&'a self, catalogue: &'a Value) -> Option<&'a str> {
        self.cold.get("weaponAmmo").or_else(|| catalogue[&self.weapon_preset]["allowedAmmo"].get(0)).and_then(Value::as_str)
    }
    /// Sets what a hopper, a cistern, a supply piece or a paver carries: units of each material by name, taken in the
    /// order of `CARGO`, each as far as there is room left — in a paver, as far as its share of the mix goes. A piece is
    /// given only what it takes: solids go into hoppers, liquids into cisterns, either into a supply piece, and what the
    /// mix of asphalt is made of into a paver (`ComponentKind::cargo_most`).
    pub fn stow(&mut self, held: &Value) -> Result<(), String> {
        let held = held.as_object().ok_or("Invalid cargo")?;
        if held.iter().any(|(name, units)| {
            !CARGO.iter().any(|c| c.name == name && self.kind.takes(c))
                || units.as_f64().is_none_or(|n| !n.is_finite() || n < 0.0)
        }) {
            return Err("This component does not carry that cargo".into());
        }
        let mut room = self.cargo_room;
        for (i, c) in CARGO.iter().enumerate() {
            let most = self.kind.cargo_most(c, if self.kind == ComponentKind::Paver { self.cargo_room } else { room });
            let units = held.get(c.name).and_then(Value::as_f64).unwrap_or(0.0).min(most);
            self.cargo[i] = units;
            room = (room - units * c.unit_volume()).max(0.0);
        }
        Ok(())
    }
    /// What it carries, by name: every material the piece takes, whether it holds any or none.
    pub fn cargo_value(&self) -> Value {
        Value::Object(CARGO.iter().zip(self.cargo).filter(|(c, _)| self.kind.takes(c))
            .map(|(c, units)| (c.name.to_owned(), json!(units))).collect())
    }
    /// Whether what it weighs follows what it holds: fuel, rounds or cargo.
    pub fn reservoir(&self) -> bool {
        matches!(self.kind, ComponentKind::Fuel | ComponentKind::Ammo) || self.kind.carrier()
    }
    /// What it weighs now: its unconsumed structure and the reserves it still holds.
    pub fn live_mass(&self) -> f64 {
        let dry = self.dry_mass - crate::game_fire::consumed_solid(self);
        match self.kind {
            ComponentKind::Fuel => dry + self.fuel_litres.max(0.0) * 0.835,
            ComponentKind::Ammo => dry + self.rounds as f64 * self.round_mass,
            kind if kind.carrier() => {
                dry + CARGO.iter().zip(self.cargo).map(|(c, units)| units * c.unit_mass()).sum::<f64>()
            }
            _ => dry,
        }
    }
    /// What it weighed as it was built: a tank and a magazine full, and a paver with its hopper full — the
    /// hopper is the paver's own, as a tank is its vehicle's, and its springs are made for it full —; a
    /// hopper, a cistern and a supply piece empty, anything else what it was admitted with.
    pub fn built_mass(&self) -> f64 {
        match self.kind {
            ComponentKind::Fuel => self.dry_mass + self.capacity_litres * 0.835,
            ComponentKind::Ammo => self.dry_mass + self.capacity_rounds as f64 * self.round_mass,
            ComponentKind::Paver => self.dry_mass + self.cargo_limit(),
            kind if kind.carrier() => self.dry_mass,
            _ => self.dry_mass,
        }
    }
    /// Its installed structure and every reserve it can hold, whatever it holds now: as it was built,
    /// with a hopper, a cistern and a supply piece full. This sizes support for the actual payload.
    pub fn full_mass(&self) -> f64 {
        if self.kind.carrier() { self.dry_mass + self.cargo_limit() } else { self.built_mass() }
    }
    /// The most what it carries weighs over that: a paver full of its mix, anything else full of the heaviest it takes.
    pub fn cargo_limit(&self) -> f64 {
        self.kind.cargo_limit(self.cargo_room)
    }
    /// Weighed again: the mass the body carries for it becomes what it weighs now. A reservoir
    /// is a plain box about its own middle.
    pub fn weigh(&mut self) {
        if self.reservoir() {
            self.physical_mass = self.live_mass();
            self.physical_inertia = self.physical_mass * (self.width * self.width + self.height * self.height) / 12.0;
        } else {
            let mass = self.live_mass();
            if self.physical_mass > 0.0 { self.physical_inertia *= mass / self.physical_mass; }
            self.physical_mass = mass;
        }
    }
    /// The frame of the piece's material: a weapon's is that of its receiver, which turns with the barrel in a room and
    /// stands on its post on an exposed mount.
    fn material_pose(&self) -> Pose {
        match &self.mount {
            Some(mount) if !mount.carries() => Pose { angle: self.barrel_angle, ..self.pose },
            _ => self.pose,
        }
    }
    /// Where on the field a place of the piece's material is: the point `material_uv` took it from.
    pub fn material_point(&self, uv: Point) -> Point {
        let base = if self.kind == ComponentKind::Weapon { 1.0 } else { 0.5 };
        self.material_pose().world_point(point((uv.x - base) * self.width, (0.5 - uv.y) * self.height))
    }
    pub fn material_uv(&self, p: Point) -> Point {
        let fixed=self.pose.local_point(p);
        let on_base=self.mount.as_ref().and_then(|m|m.base).is_some_and(|base|base.part_at(fixed).is_some());
        let d = if on_base {fixed}else{self.material_pose().local_point(p)};
        point(
            ((if self.kind==ComponentKind::Weapon {1.0}else{0.5}) + d.x / self.width).clamp(0.0, 1.0),
            (0.5 - d.y / self.height).clamp(0.0, 1.0),
        )
    }
    fn mark_material(&self,p:Point)->(Point,Option<u8>,f64) {
        let fixed=self.pose.local_point(p);
        if let Some(base)=self.mount.as_ref().and_then(|m|m.base) {
            if let Some(part)=base.part_at(fixed) {
                let b=base.bounds(part);let width=b.max_x-b.min_x;
                return (point(((fixed.x-b.min_x)/width).clamp(0.0,1.0),
                    ((b.max_y-fixed.y)/(b.max_y-b.min_y)).clamp(0.0,1.0)),Some(part as u8),width);
            }
        }
        (self.material_uv(p),None,self.width)
    }
    #[cfg(test)]
    fn mark_point(&self,mark:&Mark)->Point {
        if let Some(part)=mark.part {
            let b=self.mount.as_ref().and_then(|m|m.base).expect("admitted base mark").bounds(part as usize);
            self.pose.world_point(point(b.min_x+mark.uv.x*(b.max_x-b.min_x),b.max_y-mark.uv.y*(b.max_y-b.min_y)))
        } else {self.material_point(mark.uv)}
    }
    pub fn barrel_strike(&self, p: Point) -> bool {
        if self.kind != ComponentKind::Weapon {
            return false;
        }
        let local = Pose {
            x: self.pose.x,
            y: self.pose.y,
            angle: self.barrel_angle,
        }
        .local_point(p);
        let mount=self.mount.as_ref().expect("admitted mounted weapon");
        if mount.base.is_some_and(|base|base.part_at(self.pose.local_point(p)).is_some()) {return false;}
        let receiver=if mount.carries() {self.pose.local_point(p)} else {local};
        // The breech behind the port, which turns with the barrel, or the post of an exposed mount, which stands
        // still, is no barrel.
        if crate::game_geometry::segment_convex(receiver,receiver,&mount.receiver(self.width,self.height)).is_some() {return false;}
        if mount.polygons(self.width,self.height,crate::game_geometry::BarrelProfile{start:0.10,end:self.barrel_end,radius:self.barrel_radius}).iter().enumerate()
            .filter(|(i,_)|crate::game_mounts::role(mount.exposed,*i)==crate::game_mounts::Role::Shield)
            .any(|(_,polygon)|crate::game_geometry::segment_convex(local,local,polygon).is_some()) {return false;}
        local.x>0.025 && local.x<=self.barrel_end+0.02 && local.y.abs()<=self.barrel_radius+1e-9
    }
    /// Whether `p` strikes the compartment of the gun's ready rounds, turning with it at the back of its receiver: beside the
    /// back of it or behind it, within its height, and on no fixed foot or post.
    pub fn ready_strike(&self, p: Point) -> bool {
        if self.kind != ComponentKind::Weapon || self.ready_length <= 0.0 { return false; }
        let Some(mount) = self.mount.as_ref() else { return false };
        let fixed = self.pose.local_point(p);
        if mount.base.is_some_and(|base| base.part_at(fixed).is_some())
            || mount.post.is_some_and(|post| crate::game_geometry::segment_convex(fixed, fixed, &post.shape()).is_some()) { return false; }
        let local = Pose { angle: self.barrel_angle, ..self.pose }.local_point(p);
        local.x >= -self.width - 1e-9 && local.x <= -self.width + self.ready_length + 1e-9 && local.y.abs() <= self.height / 2.0 + 1e-9
    }
    /// The blast of the rounds ready in a gun's compartment going off, at the middle of it: as large as that of a box of as
    /// many (`rounds_blast`). Through blow-out panels (`ready_vented`), it goes off out of the roof of the compartment, the
    /// face of it that looks up, and its blast door shields its own construction (`vented`, `GameState::apply_effects`).
    pub fn ready_blast(&self) -> Option<Blast> {
        if self.ready == 0 || self.ready_length <= 0.0 { return None; }
        let frame = Pose { angle: self.barrel_angle, ..self.pose };
        let middle = frame.world_point(point(-self.width + self.ready_length / 2.0, 0.0));
        let mut blast = rounds_blast(middle, f64::from(self.ready) * self.ready_litres / 1000.0 / crate::game_geometry::AMMUNITION_PACKING, self.owner, self.actor)?;
        if self.ready_vented {
            let across = point(-crate::game_geometry::sin(self.barrel_angle), crate::game_geometry::cos(self.barrel_angle));
            let up = if across.y < 0.0 { scale(across, -1.0) } else { across };
            blast.point = add(middle, scale(up, self.height / 2.0));
            blast.details = json!({"vented":true,"nx":up.x,"ny":up.y});
        }
        Some(blast)
    }
    pub fn world_polygons(&self) -> Vec<Vec<Point>> {
        let barrel_angle = (self.kind == ComponentKind::Weapon).then_some(self.barrel_angle);
        let post = self.mount.as_ref().is_some_and(|mount| mount.carries());
        self.local_polygons()
        .into_iter()
        .enumerate()
        .map(|(role,poly)| {
            let pose=crate::game_geometry::material_pose(self.pose,barrel_angle,role,post);
            poly.into_iter().map(|p| pose.world_point(p)).collect()
        })
        .collect()
    }
    pub fn local_polygons(&self)->Vec<Vec<Point>> {
        if self.kind==ComponentKind::Weapon {
            let barrel=crate::game_geometry::BarrelProfile {start:0.10,end:self.barrel_end,radius:self.barrel_radius};
            self.mount.as_ref().expect("admitted mounted weapon").remaining_polygons(self.width,self.height,barrel,&self.mantlet_holes)
        } else {
            std::iter::once(crate::game_geometry::component_polygon(self.kind,self.width,self.height)).chain(self.column.clone()).collect()
        }
    }
    pub fn chord_resistance(&self,start:Point,end:Point,path:f64,cosine:f64)->f64 {
        if let Some(mount)=&self.mount {
            return mount.remaining_resistance(self.pose.local_point(start),self.pose.local_point(end),self.width,self.height,
                crate::game_geometry::BarrelProfile {start:0.0,end:self.barrel_end,radius:self.barrel_radius},
                self.receiver_mm,cosine,self.barrel_angle-self.pose.angle,&self.mantlet_holes);
        }
        self.resistance(start,path,cosine)
    }
    fn scar_key(uv: Point) -> u32 {
        (uv.x.clamp(0.0, 1.0) * 32.0).floor().min(31.0) as u32 * 32
            + (uv.y.clamp(0.0, 1.0) * 32.0).floor().min(31.0) as u32
    }
    pub fn resistance(&self, p: Point, path: f64, cosine: f64) -> f64 {
        if self.kind == ComponentKind::Weapon {
            if self.barrel_strike(p) {return 0.0;}
            let wall = self.receiver_mm / 1000.0;
            return (path.min(wall / cosine.max(0.08)) * 1250.0).max(0.5);
        }
        let (sheet, packing) = match self.kind {
            ComponentKind::Engine => (2.0, 0.12),
            ComponentKind::Fuel => (2.0, 0.025),
            ComponentKind::Ammo => (3.0, 0.06),
            ComponentKind::Command => (1.5, 0.06),
            ComponentKind::Sensor => (1.0, 0.04),
            ComponentKind::Wheel => (1.0, 0.03),
            ComponentKind::Track => (3.0, 0.05),
            ComponentKind::Hopper => (4.0, 0.08),
            ComponentKind::Cistern => (3.0, 0.03),
            ComponentKind::Supply => (3.0, 0.06),
            ComponentKind::Excavator | ComponentKind::Drill | ComponentKind::Builder | ComponentKind::Blade | ComponentKind::Paver => (4.0, 0.12),
            // The thin casing of a lift jet over the discs of its compressor and its turbine.
            ComponentKind::Thruster => (1.5, 0.08),
            _ => (2.0, 0.05),
        };
        // A shot meets what a reservoir holds now, whatever the body was last weighed with.
        let fill = (self.live_mass() / (self.volume.max(1e-8) * 7800.0)).clamp(0.0, 1.0);
        let chord = if self.kind.gear() {
            path.min(self.height)
        } else {
            path
        };
        // What a shot crosses of the casing going in and coming out, and of the armour over it.
        let sheet = (path.max(0.0) * 1000.0).min(2.0 * (sheet + self.armour_mm) / cosine.max(0.2));
        let scar = self
            .ballistic_scars
            .get(&Self::scar_key(self.material_uv(p)))
            .copied()
            .unwrap_or(0.0);
        ((sheet + chord.max(0.0) * 1000.0 * fill * packing)
            * 1.25
            * ComplexField::exp(-scar * 0.65).max(0.08))
        .max(0.25)
    }
    /// What a round fired from it past the heat limit of its barrel takes of the barrel (`HEAT_WEAR`): a share of what
    /// disables it.
    pub fn wear_barrel(&mut self, share: f64) {
        self.barrel_damage += share * self.max_health * BARREL_DISABLED_SHARE;
        self.barrel_disabled = self.barrel_damage >= self.max_health * BARREL_DISABLED_SHARE;
    }
    pub fn strike_damage(&self, p: Point, power: f64, penetrated: bool) -> f64 {
        // A laminate cracks, as its plates do, and a moulding splits where a metal would only dent: what it stops harms it
        // as what goes through.
        let penetrated = penetrated || self.metal().material().brittle;
        let uv = self.material_uv(p);
        let offset = (uv.y - 0.5).abs();
        let mut factor = if offset < 0.23 {
            1.15
        } else if offset < 0.38 {
            0.75
        } else {
            0.4
        };
        if self.kind == ComponentKind::Weapon && uv.x > 0.76 {
            factor *= 0.55;
        }
        if self.kind == ComponentKind::Weapon {
            if !penetrated {
                factor *= 0.035;
            } else if self.barrel_strike(p) {
                factor *= 0.55;
            }
        }
        if self.kind == ComponentKind::Track && offset > 0.34 {
            factor *= 0.85;
        }
        // What does not get through armoured running gear does it less harm: half of it at 15 mm.
        if !penetrated {
            factor *= 15.0 / (15.0 + self.armour_mm);
        }
        if power < 90.0 {
            if self.kind == ComponentKind::Track {
                factor *= if penetrated { 0.035 } else { 0.10 };
            } else if self.kind == ComponentKind::Wheel {
                factor *= 0.28;
            }
            if !penetrated {
                factor *= 0.55;
            }
        }
        power.max(0.0) * 0.62 * factor * if penetrated { 1.15 } else { 1.0 }
    }
    pub(crate) fn fire_strength(&self) -> f64 {
        let heat = if self.detonated { 1.6 } else { 1.15 };
        heat * (self.fuel_litres / self.capacity_litres.max(1e-9) * 4.0).clamp(0.25, 1.0)
            * crate::game_fire::development(self.fire_age)
    }
    pub fn reserve_blast(&self) -> Option<Blast> {
        if self.kind != ComponentKind::Ammo { return None; }
        let fraction = self.rounds as f64 / self.capacity_rounds.max(1) as f64;
        if fraction <= 0.0 {
            return None;
        }
        rounds_blast(point(self.pose.x, self.pose.y), self.volume * fraction, self.owner, self.actor)
    }
    pub fn to_value(&self) -> Value {
        let mut v = self.cold.clone();
        for (key, value) in [
            ("x", json!(self.pose.x)),
            ("y", json!(self.pose.y)),
            ("angle", json!(self.pose.angle)),
            ("health", json!(self.health)),
            ("maxHealth", json!(self.max_health)),
            ("physicalMass", json!(self.physical_mass)),
            ("dryMass", json!(self.dry_mass)),
            ("physicalCenterLocal",self.physical_center.to_value()),
            ("physicalInertia",json!(self.physical_inertia)),
            ("attached", json!(self.attached)),
            ("detonated", json!(self.detonated)),
            ("burning", json!(self.burning)),
            ("burnAge", json!(self.burn_age)),
            ("fireAge", json!(self.fire_age)),
            ("barrelAngle", json!(self.barrel_angle)),
            ("barrelDamage", json!(self.barrel_damage)),
            ("barrelDisabled", json!(self.barrel_disabled)),
            ("elevationDamage",json!(self.elevation_damage)),
            ("elevationDisabled",json!(self.elevation_disabled)),
            ("beltCut", json!(self.belt_cut)),
            ("readyDamage", json!(self.ready_damage)),
            ("markRevision", json!(self.mark_revision)),
            ("groundMarks", json!(self.ground_marks)),
            ("groundDamage", json!(self.ground_damage)),
        ] {
            v[key] = value;
        }
        if self.mount.is_some() {
            v["mantletHoles"]=self.holes_value();
            v["aimOffset"]=json!(crate::game_weapons::angle_difference(self.barrel_angle,self.pose.angle));
            let shapes=self.local_polygons();
            v["materialPolygons"]=json!(shapes.iter().map(|p|p.iter().map(|p|p.to_value()).collect::<Vec<_>>()).collect::<Vec<_>>());
        }
        if self.kind == ComponentKind::Fuel {
            v["fuelLitres"] = json!(self.fuel_litres);
            v["capacityLitres"] = json!(self.capacity_litres);
        }
        if self.kind == ComponentKind::Ammo {
            v["rounds"] = json!(self.rounds);
            v["capacityRounds"] = json!(self.capacity_rounds);
        }
        if self.kind.carrier() {
            v["cargo"] = self.cargo_value();
            v["capacityM3"] = json!(self.cargo_room);
        }
        if self.kind == ComponentKind::Thruster {
            v["thrust"] = json!(self.thrust);
        }
        v["marks"]=json!(self.marks.iter().map(|m|{let mut value=json!({"u":m.uv.x,"v":m.uv.y,"kind":m.kind,"strength":m.strength,"radiusU":m.radius});
            if let Some(part)=m.part {value["part"]=json!(part);}value}).collect::<Vec<_>>());
        v["barrelMarks"] = json!(
            self.barrel_marks
                .iter()
                .map(|mark| json!({"x":mark.point.x,"y":mark.point.y,"radius":mark.radius}))
                .collect::<Vec<_>>()
        );
        v["ballisticScars"] = json!(
            self.ballistic_scars
                .iter()
                .map(|(key, value)| (format!("{}:{}", key / 32, key % 32), json!(value)))
                .collect::<serde_json::Map<String, Value>>()
        );
        v
    }
    pub fn holes_value(&self)->Value {json!(self.mantlet_holes.iter().map(|(min,max)|json!({"min":min,"max":max})).collect::<Vec<_>>())}
    pub fn set_mantlet_holes(&mut self,value:&Value)->Result<(),String> {
        let holes=value.as_array().filter(|holes|holes.len()<=48).ok_or("Invalid mantlet holes")?;
        let shield=self.mount.as_ref().and_then(|m|m.shield);
        let mut previous=f64::NEG_INFINITY;let mut admitted=Vec::with_capacity(holes.len());
        for hole in holes {let lo=crate::game_flight::required(hole,"min")?;let hi=crate::game_flight::required(hole,"max")?;
            if lo>=hi || lo<=previous || shield.is_none_or(|s|lo< -s.half_angle || hi>s.half_angle) {return Err("Invalid mantlet hole interval".into());}
            admitted.push((lo,hi));previous=hi;
        }
        self.mantlet_holes=admitted;Ok(())
    }
    /// Clear the pierced angular strip through the sheet. The rest of the
    /// curved metal, including adjacent hits, remains the same armour.
    fn pierce_mantlet(&mut self,at:Point,exit:Point,radius:f64) {
        let Some(shield)=self.mount.as_ref().and_then(|m|m.shield) else{return;};
        let pose=Pose{angle:self.barrel_angle,..self.pose};
        let local=pose.local_point(at);let through=pose.local_point(exit);
        // Facets are chords of the arc; allow their submillimetre sagitta.
        let r=length(local);let angle=crate::game_geometry::atan2(local.y,local.x);
        if r<shield.radius-0.002 || r>shield.radius+shield.thickness+0.002 || angle.abs()>shield.half_angle+1e-8 {return;}
        // An oblique round enters and leaves at different angles. Clear the
        // complete pierced chord and its finite radius, in either direction.
        let end=crate::game_geometry::atan2(through.y,through.x);
        let radius=radius.max(0.002);
        let half=crate::game_geometry::atan2(radius,crate::game_geometry::sqrt((shield.radius*shield.radius-radius*radius).max(0.0)));
        self.mantlet_holes.push(((angle.min(end)-half).max(-shield.half_angle),(angle.max(end)+half).min(shield.half_angle)));
        self.mantlet_holes.sort_by(|a,b|a.0.total_cmp(&b.0));
        let mut merged:Vec<(f64,f64)>=Vec::new();
        for &(lo,hi) in &self.mantlet_holes {
            if let Some(last)=merged.last_mut().filter(|last|last.1>=lo-1e-10) {last.1=last.1.max(hi);} else {merged.push((lo,hi));}
        }
        // Bounded state, merging the closest neighbouring holes if necessary.
        while merged.len()>48 {let i=(0..merged.len()-1).min_by(|&a,&b|(merged[a+1].0-merged[a].1).total_cmp(&(merged[b+1].0-merged[b].1))).unwrap();
            merged[i].1=merged[i+1].1;merged.remove(i+1);}
        self.mantlet_holes=merged;
    }
}

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
enum Slot {
    #[default]
    Missing,
    Plate(usize),
    Module(usize),
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct DamageState {
    pub plates: Vec<Plate>,
    pub modules: Vec<Module>,
    pub stats: CombatStats,
    slots: Vec<Slot>,
}
impl DamageState {
    pub fn insert_plate(&mut self, p: Plate) {
        let owner = p.owner as usize;
        if self.slots.len() <= owner {
            self.slots.resize(owner + 1, Slot::Missing);
        }
        self.slots[owner] = Slot::Plate(self.plates.len());
        self.plates.push(p);
    }
    pub fn insert_module(&mut self, m: Module) {
        let owner = m.owner as usize;
        if self.slots.len() <= owner {
            self.slots.resize(owner + 1, Slot::Missing);
        }
        self.slots[owner] = Slot::Module(self.modules.len());
        self.modules.push(m);
    }
    /// Forgets the plates and the pieces of these owners. The others are found by theirs as before.
    pub fn withdraw(&mut self, owners: &std::collections::HashSet<u32>) {
        self.plates.retain(|p| !owners.contains(&p.owner));
        self.modules.retain(|m| !owners.contains(&m.owner));
        self.slots.fill(Slot::Missing);
        for (index, plate) in self.plates.iter().enumerate() {
            self.slots[plate.owner as usize] = Slot::Plate(index);
        }
        for (index, module) in self.modules.iter().enumerate() {
            self.slots[module.owner as usize] = Slot::Module(index);
        }
    }
    pub fn plate(&self, owner: u32) -> Option<&Plate> {
        match self.slots.get(owner as usize) {
            Some(Slot::Plate(i)) => self.plates.get(*i),
            _ => None,
        }
    }
    pub fn plate_mut(&mut self, owner: u32) -> Option<&mut Plate> {
        match self.slots.get(owner as usize).copied() {
            Some(Slot::Plate(i)) => self.plates.get_mut(i),
            _ => None,
        }
    }
    pub fn module(&self, owner: u32) -> Option<&Module> {
        match self.slots.get(owner as usize) {
            Some(Slot::Module(i)) => self.modules.get(*i),
            _ => None,
        }
    }
    pub fn module_mut(&mut self, owner: u32) -> Option<&mut Module> {
        match self.slots.get(owner as usize).copied() {
            Some(Slot::Module(i)) => self.modules.get_mut(i),
            _ => None,
        }
    }
    pub fn cut(&mut self, owner: u32, start: Point, end: Point, radius: f64, effects: &mut Effects) -> Vec<RemovedPatch> {
        self.cut_clipped(owner, start, end, radius, None, effects)
    }
    pub fn cut_clipped(
        &mut self,
        owner: u32,
        start: Point,
        end: Point,
        radius: f64,
        clip: Option<Bounds>,
        effects: &mut Effects,
    ) -> Vec<RemovedPatch> {
        let Some(p) = self.plate_mut(owner) else {
            return Vec::new();
        };
        let removed = p.cut_clipped(start, end, radius, clip);
        if removed.iter().any(|r| r.area > 0.0) {
            if !effects.region_changes.contains(&owner) {
                effects.region_changes.push(owner);
            }
        }
        removed
    }
    pub fn destroy_module(&mut self, owner: u32, effects: &mut Effects) {
        let ready = self.module(owner).and_then(Module::ready_blast);
        let Some(m) = self.module_mut(owner) else {
            return;
        };
        if m.detonated {
            return;
        }
        m.detonated = true;
        m.health = 0.0;
        m.burning |= crate::game_fire::ignites(m);
        if let Some(blast) = m.reserve_blast() {
            effects.detonations.push(blast);
        }
        if m.kind == ComponentKind::Ammo {
            m.rounds = 0;
        }
        // A gun destroyed with rounds ready in its compartment takes them with it, as a box does.
        if let Some(blast) = ready {
            effects.detonations.push(blast);
            m.ready = 0;
        }
        if m.kind == ComponentKind::Fuel {
            // A ruptured tank is unusable, but its remaining fuel feeds a larger fire rather than a blast.
            m.burning = m.fuel_litres > 0.0;
            if m.burning { m.fire_age = m.fire_age.max(18.0); }
            if m.burning && effects.visual_events {
                let outside=crate::game_fire::exterior(m);
                effects.events.push(json!({"type":"burn","owner":owner,"x":m.pose.x,"y":m.pose.y,"strength":m.fire_strength(),
                    "radius":(m.width*0.35).max(0.15),"spread":0.0,"exterior":outside}));
            }
        }
        // The mix of a paver is lost with it.
        if m.kind == ComponentKind::Paver {
            m.cargo = [0.0; CARGO.len()];
        }
        if effects.visual_events {
            effects.events.push(json!({"type":"destroyed","owner":owner,"x":m.pose.x,"y":m.pose.y,"kind":m.kind.name()}));
        }
    }
    pub fn damage_module(&mut self, owner: u32, mut damage: f64, at: Point, effects: &mut Effects) {
        let Some(m) = self.module_mut(owner) else {
            return;
        };
        if m.health <= 0.0 || m.detonated {
            return;
        }
        if m.kind==ComponentKind::Weapon && damage>0.0 {
            let local=Pose{angle:m.barrel_angle,..m.pose}.local_point(at);
            // The trunnion and elevation gear live beside the front of the
            // receiver. A remote armour hit is not automatically a servo hit.
            let reach=m.height*0.75;
            let coupling=(1.0-length(local)/reach.max(0.01)).clamp(0.0,1.0);
            m.elevation_damage+=damage*coupling;
            m.elevation_disabled=m.elevation_damage>=m.max_health*BARREL_DISABLED_SHARE;
        }
        // Its compartment of ready rounds holds them until it is wrecked, and then they go off with it.
        if damage > 0.0 && m.ready_strike(at) {
            m.ready_damage += damage;
            if !m.belt_cut && m.ready_damage >= m.max_health * READY_COOKS {
                m.belt_cut = true;
                if let Some(blast) = m.ready_blast() { effects.detonations.push(blast); }
                m.ready = 0;
            }
        }
        if m.barrel_strike(at) && damage > 0.0 {
            m.barrel_damage += damage;
            m.barrel_disabled = m.barrel_damage >= m.max_health * BARREL_DISABLED_SHARE;
            let local = Pose {
                angle: m.barrel_angle,
                ..m.pose
            }
            .local_point(at);
            if !m
                .barrel_marks
                .iter()
                .any(|mark| (mark.point.x - local.x).abs() < 0.04)
            {
                m.barrel_marks.push(BarrelMark {
                    point: local,
                    radius: 0.025,
                });
                if m.barrel_marks.len() > 16 {
                    m.barrel_marks.remove(0);
                }
            }
            damage *= 0.18;
        }
        m.health = (m.health - damage.max(0.0)).max(0.0);
        if crate::game_fire::ignites(m) {
            m.burning = true;
        }
        let destroy =
            m.health <= 0.0 || (m.kind == ComponentKind::Ammo && m.health < m.max_health * 0.38);
        if destroy {
            self.destroy_module(owner, effects);
        }
    }
    /// A mechanical overload leaves the same bounded marks and functional damage as other hits,
    /// without claiming a ballistic perforation or letting armour shield an axle from its load.
    pub fn contact_strike(&mut self, owner: u32, at: Point, fraction: f64, effects: &mut Effects) {
        let Some(m) = self.module_mut(owner).filter(|m| m.usable()) else {
            return;
        };
        let damage = m.max_health * fraction.max(0.0);
        if damage <= 0.0 {
            return;
        }
        let (uv,part,width)=m.mark_material(at);
        m.marks.push(Mark {
            uv, part, kind: "dent", strength: fraction.min(3.0),
            depth: 0.0, radius: 0.1*m.width/width,
        });
        if m.marks.len() > 48 { m.marks.remove(0); }
        m.mark_revision += 1;
        self.damage_module(owner, damage, at, effects);
    }
    pub fn component_strike(
        &mut self,
        owner: u32,
        at: Point,
        exit: Point,
        power: f64,
        radius: f64,
        penetrated: bool,
        secondary: bool,
        effects: &mut Effects,
    ) {
        let Some(m) = self.module_mut(owner) else {
            return;
        };
        let (uv,part,material_width) = m.mark_material(at);
        if penetrated && m.kind==ComponentKind::Weapon {m.pierce_mantlet(at,exit,radius);}
        if penetrated && m.kind != ComponentKind::Weapon {
            let key = Module::scar_key(uv);
            let scar = m.ballistic_scars.entry(key).or_default();
            *scar = (*scar + (power / 160.0).clamp(0.08, 1.0)).min(8.0);
        }
        m.marks.push(Mark {
            uv,
            kind: if penetrated { "hole" } else { "dent" },
            strength: (power / 90.0).clamp(0.08, 3.0),
            depth: 0.0,
            radius: (radius * 1.8 / material_width).max(0.003),
            part,
        });
        if m.marks.len() > 48 {
            m.marks.remove(0);
        }
        m.mark_revision += 1;
        let damage = m.strike_damage(at, power, penetrated);
        let kind = m.kind;
        self.damage_module(owner, damage, at, effects);
        if secondary {
            self.stats.secondary_component_hits += 1;
        }
        if effects.visual_events {
            effects.events.push(json!({"type":if secondary{"secondary-impact"}else{"module"},"owner":owner,"x":at.x,"y":at.y,"kind":kind.name(),"power":power,"penetrated":penetrated}));
        }
    }
    // Takes `litres` from the usable tanks of an actor, and says how much they gave.
    pub fn consume_fuel(&mut self, actor: u32, litres: f64) -> f64 {
        let mut litres = litres.max(0.0);
        let requested = litres;
        for m in &mut self.modules {
            if m.actor != actor || m.kind != ComponentKind::Fuel || !m.usable() {
                continue;
            }
            let take = m.fuel_litres.min(litres);
            m.fuel_litres -= take;
            litres -= take;
            if litres <= EPS {
                break;
            }
        }
        requested - litres
    }
    /// Takes a round of `cartridge` from a box of `actor` that holds one (game_variant.rs `cartridge`).
    pub fn consume_round(&mut self, actor: u32, cartridge: &str) -> bool {
        let Some(m) = self.modules.iter_mut().find(|m| {
            m.actor == actor
                && m.kind == ComponentKind::Ammo
                && m.ammo_preset == cartridge
                && m.usable()
                && m.rounds > 0
        }) else {
            return false;
        };
        m.rounds -= 1;
        true
    }
    pub fn step_burning(&mut self, dt: f64, geometry: &crate::game_geometry::Geometry, effects: &mut Effects) {
        crate::game_fire::step(self, geometry, dt, effects);
    }

}

#[cfg(test)]
pub(crate) mod fixtures {
    use super::*;
    use std::sync::OnceLock;
    use std::f64::consts::PI;
    pub fn full_catalogue() -> &'static Value {
        static VALUE: OnceLock<Value> = OnceLock::new();
        VALUE.get_or_init(|| serde_json::from_str::<Value>(include_str!("../../construction-catalogue.json")).unwrap())
    }
    pub fn catalogue() -> &'static Value { &full_catalogue()["weapons"] }
    /// Stock designs as their templates make them, `(handle, id, template, x)`, each as drawn: see `scene`.
    pub fn stock_scene(placed:&[(u32,&str,&str,f64)],terrain:Value) -> Value {
        let placed=placed.iter().map(|&(handle,id,template,x)|
            (handle,id,crate::game_templates::source(template,&json!({}),full_catalogue()).unwrap(),x,false)).collect::<Vec<_>>();
        scene(&placed,terrain)
    }
    /// Constructions as the workshop compiles their sources, `(handle, id, source, x, turned)`: each as drawn (facing
    /// left), or turned about to face right as a page turns one, with the middle of its chassis (the origin of its frame
    /// if it is fixed) at `x` on ground that is level at height zero under it, raised by the contact margin over its
    /// lowest wheel or plate as the field admits a construction. Their parts are named after them (`local:gun`). Owners
    /// run over all the plates, then over all the pieces.
    pub fn scene(placed:&[(u32,&str,Value,f64,bool)],terrain:Value) -> Value {
        let cat=full_catalogue();
        let margin=crate::VEHICLE_CONTACT_SKIN+crate::VEHICLE_CONTACT_SLOP;
        let (mut actors,mut plates,mut modules)=(Vec::new(),Vec::new(),Vec::new());
        for (handle,id,source,x,turned) in placed {
            let (handle,id,x,turned)=(*handle,*id,*x,*turned);
            let compiled=crate::game_construction::compile(source,cat).unwrap()["compiled"].clone();
            let number=|value:&Value,key:&str|value[key].as_f64().unwrap();
            let lowest=compiled["plates"].as_array().unwrap().iter().map(|p|{
                let angle=number(p,"angle");
                number(p,"y")-(crate::game_geometry::sin(angle).abs()*number(p,"length")+crate::game_geometry::cos(angle).abs()*number(p,"thicknessMm")/1000.0)/2.0
            }).chain(compiled["modules"].as_array().unwrap().iter().filter(|m|matches!(m["kind"].as_str(),Some("wheel"|"track")))
                .map(|m|number(m,"y")-number(m,"height")/2.0)).fold(f64::INFINITY,f64::min);
            let middle=compiled.get("chassis").map_or_else(||number(&compiled["frame"]["origin"],"x"),|c|number(c,"front")+number(c,"length")/2.0);
            let (dx,lift)=(x-middle,(margin-lowest).max(0.0));
            let qualify=|value:&Value|value.as_str().map_or(Value::Null,|name|json!(format!("{id}:{name}")));
            // Turned about, a part stands as far behind the middle of the chassis as it stood before it, and what is
            // across a part, in its own frame, is across it the other way.
            let moved=|part:&Value|{
                let mut part=part.clone();
                let along=number(&part,"x")+dx;
                part["x"]=json!(if turned {2.0*x-along} else {along});part["y"]=json!(number(&part,"y")+lift);
                for key in ["id","mountId"] {part[key]=qualify(&part[key]);}
                let axis=if part.get("material").is_some() || part["kind"]=="weapon" {"y"} else {"x"};
                if let Some(center)=part.get_mut("physicalCenterLocal").filter(|_|turned) {center[axis]=json!(-center[axis].as_f64().unwrap_or(0.0));}
                part
            };
            for p in compiled["plates"].as_array().unwrap() {
                let mut definition=moved(p);
                if turned {
                    definition["angle"]=json!(PI-number(p,"angle"));
                    for anchor in definition["anchors"].as_array_mut().into_iter().flatten() {anchor["v"]=json!(-anchor["v"].as_f64().unwrap_or(0.0));}
                }
                let mut value=plate(0,handle,&json!({"definition":definition,"ballisticGrid":p["ballisticGrid"],
                    "physicalMass":p["physicalMass"],"physicalInertia":p["physicalInertia"],"physicalCenterLocal":definition["physicalCenterLocal"]})).to_value();
                value["actor"]=json!(handle);value["id"]=definition["id"].clone();plates.push(value);
            }
            for original in compiled["modules"].as_array().unwrap() {
                let mut module=moved(original);module["actor"]=json!(handle);
                if module["kind"]=="weapon" {
                    let mount=&mut module["weaponMount"];
                    mount["hostId"]=qualify(&mount["hostId"]);
                    for wall in mount["walls"].as_array_mut().unwrap() {
                        wall["wallId"]=qualify(&wall["wallId"]);
                        if turned {
                            for end in ["a","b"] {wall[end]["y"]=json!(-number(&wall[end],"y"));}
                            // The stretch of the sector that fires through it turns over with the sector.
                            if let Some(port)=wall.get_mut("port") {(port["min"],port["max"])=(json!(-number(port,"max")),json!(-number(port,"min")));}
                        }
                    }
                    if turned {
                        let given=&original["weaponMount"];
                        mount["mirrored"]=json!(given["mirrored"]!=true);
                        (mount["min"],mount["max"])=(json!(-number(given,"max")),json!(-number(given,"min")));
                        if let Some(axis)=given["hullAxis"].as_f64() {mount["hullAxis"]=json!(PI-axis);}
                        module["angle"]=json!(PI-number(original,"angle"));
                        if let Some(offset)=original["aimOffset"].as_f64() {module["aimOffset"]=json!(-offset);}
                    }
                    module["barrelAngle"]=json!(number(&module,"angle")+module["aimOffset"].as_f64().unwrap_or(0.0));
                    module["targetBarrelAngle"]=module["barrelAngle"].clone();
                } else if let Some(angle)=original["angle"].as_f64().filter(|_|turned) {
                    module["angle"]=json!(-angle);
                    module["mirrored"]=json!(original["mirrored"]!=true);
                }
                modules.push(module);
            }
            // A vehicle stands at the origin of its frame, moved and turned as its parts are.
            let origin=&compiled["frame"]["origin"];
            let along=number(origin,"x")+dx;
            let vehicle=if compiled["preset"]=="vehicle" {
                json!({"x":if turned {2.0*x-along} else {along},"y":number(origin,"y")+lift,"enabled":true})
            } else {Value::Null};
            let contact_volumes=crate::array(&compiled,"rooms").iter().map(|room|&room["polygon"])
                .chain(crate::array(&compiled["chassis"],"outlines").iter()).map(|polygon|
                polygon.as_array().unwrap().iter().map(|p| {
                    let along=number(p,"x")+dx;
                    json!({"x":if turned {2.0*x-along} else {along},"y":number(p,"y")+lift})
                }).collect::<Vec<_>>()).collect::<Vec<_>>();
            actors.push(json!({"handle":handle,"id":id,"ownerId":id,"facing":if turned {1.0} else {-1.0},
                "vehicle":vehicle,"contactVolumes":contact_volumes}));
        }
        for (i,p) in plates.iter_mut().enumerate() {p["owner"]=json!(i+1);}
        let count=plates.len();
        for (i,m) in modules.iter_mut().enumerate() {m["owner"]=json!(count+i+1);}
        let owner=|wall:&str|plates.iter().find(|p|p["id"]==wall).unwrap()["owner"].clone();
        for module in &mut modules {
            if let Some(mount)=module.get_mut("weaponMount") {
                mount["hostOwner"]=mount["hostId"].as_str().map_or(json!(0),owner);
                for wall in mount["walls"].as_array_mut().unwrap() {wall["owner"]=owner(wall["wallId"].as_str().unwrap());}
            }
        }
        json!({"version":1,"terrain":terrain,"actors":actors,"plates":plates,"modules":modules,
            "catalogue":cat["weapons"],"mountCatalogue":cat["mounts"],"seed":6173,"visualEvents":false,
            "bounds":{"minX":-400.0,"maxX":400.0,"minY":-50.0,"maxY":200.0}})
    }
    /// Two constructions on level ground, `apart` metres between the middles of their chassis about x = 12: `local`
    /// (handle 1) turned to face `opponent` (handle 2), which stands as drawn. Their guns may be laid on a point 25 km
    /// off either way.
    pub fn duel_scene(sources:[&Value;2],apart:f64) -> Value {
        let mut scene=scene(&[(1,"local",sources[0].clone(),12.0-apart/2.0,true),(2,"opponent",sources[1].clone(),12.0+apart/2.0,false)],json!("flat"));
        scene["bounds"]=json!({"minX":-25000.0,"maxX":25000.0,"minY":-50.0,"maxY":1000.0});
        scene
    }
    /// The duel loaded, and let settle for a second.
    pub fn duel(sources:[&Value;2],apart:f64) -> crate::NativeWorld {
        let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();
        world.load_game(&duel_scene(sources,apart).to_string()).unwrap();
        for _ in 0..60 {world.game_step(1.0/60.0).unwrap();}
        world
    }
    pub fn mounted_scene(positions:&[(u32,&str,f64)],gear_count:usize) -> Value {
        let cat=full_catalogue();
        let mut source=crate::game_templates::source("scout",&json!({"preset":"minimi","sensorModes":[]}),cat).unwrap();
        source["components"].as_array_mut().unwrap().retain(|part|matches!(part["kind"].as_str(),Some("command"|"weapon")));
        let compiled=crate::game_construction::compile(&source,cat).unwrap()["compiled"].clone();
        let mut plates=Vec::new();let mut modules=Vec::new();let mut actors=Vec::new();
        for &(actor,id,x) in positions {
            let owner_map:std::collections::HashMap<_,_>=compiled["plates"].as_array().unwrap().iter()
                .map(|p|(p["owner"].as_u64().unwrap() as u32,actor*100+p["owner"].as_u64().unwrap() as u32)).collect();
            for p in compiled["plates"].as_array().unwrap() {
                let mut definition=p.clone();definition["x"]=json!(p["x"].as_f64().unwrap()+x-12.0);
                definition["id"]=json!(format!("{id}:{}",p["id"].as_str().unwrap()));
                let owner=owner_map[&(p["owner"].as_u64().unwrap() as u32)];
                let mut value=plate(owner,actor,&json!({"definition":definition,"ballisticGrid":p["ballisticGrid"],
                    "physicalMass":p["physicalMass"],"physicalInertia":p["physicalInertia"],"physicalCenterLocal":p["physicalCenterLocal"]})).to_value();
                value["actor"]=json!(actor);value["id"]=definition["id"].clone();plates.push(value);
            }
            let mut gear_index=0;
            for original in compiled["modules"].as_array().unwrap() {
                let mut module=original.clone();let kind=module["kind"].as_str().unwrap().to_owned();
                // The wheels the chassis brings, as many as asked, only under the first.
                if kind=="wheel" && (actor!=1 || gear_index>=gear_count as u32) {continue;}
                let owner=match kind.as_str() {"command"=>actor*10,"weapon"=>actor*10+1,_=>{let n=30+gear_index;gear_index+=1;n}};
                module["owner"]=json!(owner);module["actor"]=json!(actor);
                module["id"]=json!(format!("{actor}-{kind}{owner}"));
                module["x"]=json!(original["x"].as_f64().unwrap()+x-12.0);
                if let Some(mount)=module.get_mut("weaponMount") {
                    if let Some(host)=mount["hostOwner"].as_u64().filter(|owner|*owner>0){mount["hostOwner"]=json!(owner_map[&(host as u32)]);}
                    if let Some(host)=mount["hostId"].as_str(){mount["hostId"]=json!(format!("{id}:{host}"));}
                    for wall in mount["walls"].as_array_mut().unwrap() {
                        wall["owner"]=json!(owner_map[&(wall["owner"].as_u64().unwrap() as u32)]);
                        wall["wallId"]=json!(format!("{id}:{}",wall["wallId"].as_str().unwrap()));
                    }
                }
                modules.push(module);
            }
            let contact_volumes=crate::array(&compiled,"rooms").iter().map(|room|&room["polygon"])
                .chain(crate::array(&compiled["chassis"],"outlines").iter()).map(|polygon|
                polygon.as_array().unwrap().iter().map(|p|
                    json!({"x":p["x"].as_f64().unwrap()+x-12.0,"y":p["y"]})).collect::<Vec<_>>()).collect::<Vec<_>>();
            actors.push(json!({"handle":actor,"id":id,"ownerId":if id.starts_with("local"){"local"}else{"opponent"},
                "vehicle":{"x":x,"y":1.0,"enabled":false},"contactVolumes":contact_volumes}));
        }
        json!({"version":1,"terrain":"flat","actors":actors,"plates":plates,"modules":modules,
            "catalogue":cat["weapons"],"mountCatalogue":cat["mounts"],"seed":6173,"visualEvents":false,
            "bounds":{"minX":-200.0,"maxX":200.0}})
    }
    /// Build fresh current material for mechanical unit tests. Saved states
    /// are passed unchanged to the sole runtime admission.
    pub fn plate(owner: u32, actor: u32, config: &Value) -> Plate {
        let mut v=config.clone();
        if !v["definition"].is_object() { v["definition"]=config.clone(); }
        for (key,value) in [("x",json!(0.0)),("y",json!(0.0)),("angle",json!(0.0)),
            ("length",json!(1.0)),("thicknessMm",json!(100.0)),("material",json!("steel"))] {
            if v["definition"].get(key).is_none() {v["definition"][key]=value;}
        }
        let length=v["definition"]["length"].as_f64().unwrap();
        let thickness=v["definition"]["thicknessMm"].as_f64().unwrap()/1000.0;
        if v.get("vertices").is_none() {
            v["vertices"]=json!(crate::game_geometry::rectangle(length,thickness).iter().map(|p|p.to_value()).collect::<Vec<_>>());
        }
        let vertices:Vec<_>=v["vertices"].as_array().unwrap().iter().map(Point::from_value).collect();
        if v.get("uvs").is_none() {v["uvs"]=json!(vertices.iter().flat_map(|p|[0.5+p.x/length,0.5-p.y/thickness]).collect::<Vec<_>>());}
        if v.get("indices").is_none() {v["indices"]=json!((1..vertices.len()-1).flat_map(|i|[0,i as u32,i as u32+1]).collect::<Vec<_>>());}
        if v.get("ballisticGrid").is_none() {
            let mut grid=MaterialGrid::new(Bounds::points(&vertices));
            if let Some(regions)=config["solidRegions"].as_array() {
                let regions:Vec<_>=regions.iter().map(Bounds::from_value).collect();
                for y in 0..grid.ny {for x in 0..grid.nx {
                    let b=grid.cell_bounds(x,y);let p=point((b.min_x+b.max_x)/2.0,(b.min_y+b.max_y)/2.0);
                    if !regions.iter().any(|r|p.x>=r.min_x && p.x<=r.max_x && p.y>=r.min_y && p.y<=r.max_y) {grid.clear_cell(x,y);}
                }}
            }
            v["ballisticGrid"]=grid.to_value();
        }
        v.as_object_mut().unwrap().remove("solidRegions");
        v.as_object_mut().unwrap().remove("isFragment");
        Plate::from_value(owner,actor,&v).unwrap()
    }
    pub fn module(owner:u32, actor:u32, config:&Value) -> Module {
        let mut v=config.clone();
        for key in ["barrelEnd","barrelRadius"] {v.as_object_mut().unwrap().remove(key);}
        let kind=ComponentKind::from_name(v["kind"].as_str().unwrap()).unwrap();
        if kind==ComponentKind::Ammo && v.get("ammoPreset").is_none() {v["ammoPreset"]=json!("rh120");}
        if kind==ComponentKind::Weapon {
            if v.get("weaponPreset").is_none() {v["weaponPreset"]=json!("rh120");}
            let weapon=&catalogue()[v["weaponPreset"].as_str().unwrap()];
            let preset=v["weaponMount"]["preset"].as_str().unwrap_or_else(||match weapon["family"].as_str().unwrap() {
                "machinegun"|"grenade"|"rocket"=>"light-trunnion","autocannon"=>"medium-trunnion",
                "mortar"=>"roof-mortar","howitzer"=>"elevated-trunnion",_=>"heavy-trunnion"});
            let profile=&full_catalogue()["mounts"][preset];
            let sector=json!({"min":v["weaponMount"].get("min").unwrap_or(&profile["min"]),
                "max":v["weaponMount"].get("max").unwrap_or(&profile["max"])});
            let source=json!({"version":crate::CONSTRUCTION_VERSION,"preset":"bunker","nodes":[],"plates":[],
                "components":[{"id":"gun","kind":"weapon","weaponPreset":v["weaponPreset"],
                    "pose":{"x":0,"y":0,"angle":num(&v,"angle",0.0)},"mount":{"preset":preset,"sector":sector}}]});
            let fresh=crate::game_construction::compile(&source,full_catalogue()).unwrap()["compiled"]["modules"][0].clone();
            for key in ["width","height","barrelProfile","weaponMount","receiverMm","barrelMm",
                "physicalMass","physicalCenterLocal","physicalInertia","materialPolygons","barrelAngle","targetBarrelAngle","aimOffset"] {
                if v.get(key).is_none() {v[key]=fresh[key].clone();}
            }
            // Partial test setup still uses the catalogue's complete physical mount.
            if let Some(written)=config["weaponMount"].as_object() {
                let mut mount=fresh["weaponMount"].clone();
                for (key,value) in written {mount[key]=value.clone();}v["weaponMount"]=mount;
            }
            for (key,value) in [("receiverMm",json!(70.0)),("barrelMm",json!(22.0))] {
                if v.get(key).is_none() {v[key]=value;}
            }
        }
        Module::from_value(owner,actor,&v,catalogue(),&full_catalogue()["mounts"]).unwrap()
    }
    pub fn geometry(owner:u32,actor:u32,kind:crate::game_geometry::EntityKind,config:&Value) -> Result<crate::game_geometry::EntityGeometry,String> {
        Ok(match kind {
            crate::game_geometry::EntityKind::Plate=>crate::game_geometry::EntityGeometry::from_plate(&plate(owner,actor,config)),
            crate::game_geometry::EntityKind::Module=>crate::game_geometry::EntityGeometry::from_module(&module(owner,actor,config)),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plate() -> Plate {
        crate::game_damage::fixtures::plate(
            1,
            0,
            &json!({"id":"p","x":0,"y":0,"angle":0,"length":2,"thicknessMm":100,"material":"steel","widthM":1}),
        )
    }
    #[test]
    fn the_material_of_a_plate_is_the_same_summed_or_remembered() {
        // The sum as it is defined: every occupied cell clipped out of every triangle.
        let summed = |plate: &Plate| {
            let mut sum = MassProperties::default();
            for y in 0..plate.grid.ny {
                for x in 0..plate.grid.nx {
                    if !plate.grid.occupied(x, y) { continue; }
                    for poly in plate.polygons_in(plate.grid.cell_bounds(x, y)) {
                        let p = polygon_properties(&poly);
                        sum.area += p.area;
                        sum.center = add(sum.center, scale(p.center, p.area));
                        sum.second += p.second;
                    }
                }
            }
            if sum.area > 0.0 { sum.center = scale(sum.center, 1.0 / sum.area); }
            [sum.area.to_bits(), sum.center.x.to_bits(), sum.center.y.to_bits(), sum.second.to_bits()]
        };
        let bits = |plate: &Plate| [plate.properties.area.to_bits(), plate.properties.center.x.to_bits(),
            plate.properties.center.y.to_bits(), plate.properties.second.to_bits()];
        let mut p = plate();
        assert!(p.properties.area > 0.19 && bits(&p) == summed(&p));
        // Asked again, the sum is the one remembered, bit for bit.
        p.refresh();
        assert_eq!(bits(&p), summed(&p));
        // A grid with a hole is another plate: its sum is its own, and so is the whole one's after it.
        let whole = p.properties.area;
        let mut holed = plate();
        assert!(Arc::make_mut(&mut holed.grid).clear_cell(5, 1));
        holed.refresh();
        assert!(holed.properties.area < whole && bits(&holed) == summed(&holed));
        p.refresh();
        assert!(p.properties.area == whole && bits(&p) == summed(&p));
        // So is a plate of other nodes under the same grid numbers.
        let other = crate::game_damage::fixtures::plate(2, 0,
            &json!({"id":"q","x":0,"y":0,"angle":0,"length":2.5,"thicknessMm":100,"material":"steel","widthM":1}));
        assert!(other.properties.area > whole && bits(&other) == summed(&other));
    }
    #[test]
    fn ballistic_cuts_preserve_physical_mass_inertia_and_base_contour() {
        let mut p = plate();
        let initial = p.mass();
        let inertia = p.inertia();
        let center = p.physical_center;
        let nodes = p.local_nodes.clone();
        let removed = p.cut_clipped(point(-1.1, 0.0), point(1.1, 0.0), 0.01, None);
        assert!(removed.iter().map(|r| r.area).sum::<f64>() > 0.0);
        assert_eq!(p.mass(), initial);
        assert_eq!(p.inertia(), inertia);
        assert_eq!(p.physical_center, center);
        let reloaded = crate::game_damage::fixtures::plate(1, 0, &p.to_value());
        assert_eq!(reloaded.mass(), initial);
        assert_eq!(reloaded.inertia(), inertia);
        assert_eq!(reloaded.physical_center, center);
        assert_eq!(p.local_nodes.len(), nodes.len());
        assert!(!p.contains_local(point(0.0, 0.0)));
        assert!(p.contains_local(point(0.0, 0.04)));
    }
    #[test]
    fn shallow_crater_does_not_create_gas_aperture() {
        let mut p = plate();
        p.cut_clipped(point(0.0, -0.06), point(0.0, -0.03), 0.02, None);
        assert!(p.contains_local(point(0.0, 0.04)));
        assert!(p.perforations.is_empty());
    }
    #[test]
    fn armoured_running_gear_resists_more_and_is_hurt_less_by_what_does_not_get_through() {
        let gear=|kind:&str,width:f64,mass:f64,armour:f64|crate::game_damage::fixtures::module(2,0,
            &json!({"kind":kind,"health":80,"maxHealth":80,"physicalMass":mass,"x":0,"y":0,"width":width,"height":0.74,"armorMm":armour}));
        for (kind,width,mass) in [("wheel",0.74,110.0),("track",5.04,2800.0)] {
            let bare=gear(kind,width,mass,0.0);
            let unwritten=crate::game_damage::fixtures::module(2,0,&json!({"kind":kind,"health":80,"maxHealth":80,"physicalMass":mass,"x":0,"y":0,"width":width,"height":0.74}));
            assert_eq!(bare.resistance(point(0.0,0.0),0.74,1.0),unwritten.resistance(point(0.0,0.0),0.74,1.0));
            assert_eq!(bare.strike_damage(point(0.0,0.0),300.0,false),unwritten.strike_damage(point(0.0,0.0),300.0,false));
            let mut last=bare.resistance(point(0.0,0.0),0.74,1.0);
            for mm in [10.0,20.0,40.0] {
                let armoured=gear(kind,width,mass,mm);
                let resistance=armoured.resistance(point(0.0,0.0),0.74,1.0);
                // A shot goes in through the armour and comes out through it: twice its thickness, as steel is counted.
                assert!((resistance-bare.resistance(point(0.0,0.0),0.74,1.0)-2.0*mm*1.25).abs()<1e-9,"{kind} {mm} mm: {resistance}");
                assert!(resistance>last);last=resistance;
                // A shot that grazes it crosses no more armour than there is of the gear along its path.
                assert_eq!(armoured.resistance(point(0.0,0.0),0.001,1.0),bare.resistance(point(0.0,0.0),0.001,1.0));
                for power in [40.0,300.0] {
                    assert_eq!(armoured.strike_damage(point(0.0,0.0),power,true),bare.strike_damage(point(0.0,0.0),power,true));
                    let ratio=armoured.strike_damage(point(0.0,0.0),power,false)/bare.strike_damage(point(0.0,0.0),power,false);
                    assert!((ratio-15.0/(15.0+mm)).abs()<1e-12);
                }
            }
        }
        // Nothing but running gear wears it, and none wears more than it may.
        let engine=crate::game_damage::fixtures::module(2,0,&json!({"kind":"engine","health":110,"maxHealth":110,"physicalMass":880,"x":0,"y":0,"width":1.05,"height":0.64,"armorMm":30}));
        assert_eq!(engine.armour_mm,0.0);assert_eq!(gear("wheel",0.74,110.0,500.0).armour_mm,40.0);assert_eq!(gear("track",5.04,2800.0,500.0).armour_mm,80.0);
    }
    #[test]
    fn a_piece_of_glass_fibre_or_of_plastic_is_hurt_by_what_it_stops_as_by_what_goes_through_and_a_radar_sees_through_it() {
        let cistern=|metal:Option<&str>|{
            let mut v=json!({"kind":"cistern","health":90,"maxHealth":90,"x":0,"y":0,"width":1.4,"height":0.9});
            if let Some(metal)=metal {v["metal"]=json!(metal);}
            crate::game_damage::fixtures::module(2,0,&v)
        };
        let steel=cistern(None);
        for name in ["fiberglass","plastic"] {
            let soft=cistern(Some(name));
            assert_eq!((steel.metal().name,soft.metal().name),("steel",name));
            for power in [40.0,300.0] {
                let at=point(0.0,0.0);
                assert_eq!(soft.strike_damage(at,power,true),steel.strike_damage(at,power,true),"{name}: what goes through hurts the same");
                assert_eq!(soft.strike_damage(at,power,false),steel.strike_damage(at,power,true),"{name} gives way under what it stops");
                assert!(steel.strike_damage(at,power,false)<steel.strike_damage(at,power,true),"a metal only dents");
                for metal in ["aluminum","titanium"] {
                    assert_eq!(cistern(Some(metal)).strike_damage(at,power,false),steel.strike_damage(at,power,false),"{metal} dents as steel does");
                }
            }
            // A radar's waves run through it as through a plate of glass fibre; light does not, nor anything through a piece
            // of metal.
            assert_eq!(crate::game_geometry::EntityGeometry::from_module(&soft).clear_to,Some(Wave::Radio),"{name}");
        }
        for metal in [None,Some("aluminum"),Some("titanium")] {
            assert_eq!(crate::game_geometry::EntityGeometry::from_module(&cistern(metal)).clear_to,None,"{metal:?}");
        }
        // Each piece is held to what its kind may be made of, whatever it is told: a sensor to what one that detects so may.
        let made=|kind:&str,metal:&str,mode:&str|Module::from_value(2,0,&json!({"kind":kind,"metal":metal,"sensorMode":mode,"health":110,
            "maxHealth":110,"physicalMass":880,"x":0,"y":0,"width":1.05,"height":0.64}),fixtures::catalogue(),&Value::Null);
        assert!(made("engine","titanium","").is_ok());assert!(made("engine","fiberglass","").is_err());assert!(made("engine","plastic","").is_err());
        for (mode,plastic) in [("visual",true),("sound",true),("radar",false)] {
            assert!(made("sensor","fiberglass",mode).is_ok(),"{mode}");
            assert_eq!(made("sensor","plastic",mode).is_ok(),plastic,"{mode}");
        }
    }
    #[test]
    fn disabling_engine_retains_physical_mass_and_resistance() {
        let mut d = DamageState::default();
        d.insert_module(crate::game_damage::fixtures::module(2,0,&json!({"kind":"engine","health":110,"maxHealth":110,"physicalMass":880,"x":0,"y":0,"width":1.05,"height":0.64})));
        let before = d.module(2).unwrap().resistance(point(0.0, 0.0), 1.05, 1.0);
        d.damage_module(2, 200.0, point(0.0, 0.0), &mut Effects::default());
        let m = d.module(2).unwrap();
        assert_eq!(m.health, 0.0);
        assert_eq!(m.physical_mass, 880.0);
        assert_eq!(m.resistance(point(0.0, 0.0), 1.05, 1.0), before);
    }
    #[test]
    fn a_ruptured_tank_feeds_a_stronger_fire_until_empty_without_a_blast() {
        let mut d = DamageState::default();
        d.insert_module(crate::game_damage::fixtures::module(2,0,&json!({"kind":"fuel","health":75,"maxHealth":75,"physicalMass":180,"fuelLitres":100,"capacityLitres":202.176,"x":0,"y":0,"width":0.8,"height":0.72})));
        let mut e = Effects::new(true);
        d.damage_module(2, 30.0, point(0.0, 0.0), &mut e);
        d.step_burning(0.5, &crate::game_geometry::Geometry::new(), &mut e);
        let mild = e.events.iter().find(|e| e["type"] == "burn").unwrap()["strength"].as_f64().unwrap();
        e.events.clear();
        d.destroy_module(2, &mut e);
        d.destroy_module(2, &mut e);
        assert!(e.detonations.is_empty());
        assert_eq!(e.events.iter().filter(|e| e["type"] == "burn").count(), 1);
        assert!(e.events[0]["strength"].as_f64().unwrap() > mild);
        assert!(d.module(2).unwrap().burning && !d.module(2).unwrap().usable());
        assert!(d.module(2).unwrap().fuel_litres > 99.0);
        assert_eq!(d.consume_fuel(0, 1.0), 0.0, "a ruined tank no longer feeds the engine");
        for _ in 0..1800 { d.step_burning(0.1, &crate::game_geometry::Geometry::new(), &mut e); }
        let refreshes = e.events.iter().filter(|e| e["type"] == "burn").count();
        assert!((800..1000).contains(&refreshes), "one refresh per 10 Hz damage step until this half-full tank empties: {refreshes}");
        assert_eq!(d.module(2).unwrap().fuel_litres, 0.0);
        assert!(!d.module(2).unwrap().burning);
        assert!(e.detonations.is_empty());
        let events = e.events.len(); d.step_burning(1.0, &crate::game_geometry::Geometry::new(), &mut e); assert_eq!(e.events.len(), events);
        assert!(d.module(2).unwrap().physical_mass > 0.0);
    }
    #[test]
    fn plate_admission_requires_current_grid_and_never_repairs_missing_material() {
        let current=plate().to_value();
        assert!(Plate::from_value(1,0,&current).is_ok());
        for field in ["definition","vertices","uvs","indices","ballisticGrid"] {
            let mut bad=current.clone();bad.as_object_mut().unwrap().remove(field);
            assert!(Plate::from_value(1,0,&bad).is_err(),"{field}");
        }
        for key in ["isFragment","source","solidRegions","regions","massRevision"] {
            let mut bad=current.clone();bad[key]=json!(1);
            assert!(Plate::from_value(1,0,&bad).is_err(),"{key}");
        }
        let mut bad=current.clone();bad["ballisticGrid"]["bounds"]["minX"]=json!(-100.0);
        assert!(Plate::from_value(1,0,&bad).is_err());
        let mut missing=current.clone();missing.as_object_mut().unwrap().remove("ballisticGrid");
        missing["solidRegions"]=json!([{"minX":-1,"maxX":1,"minY":-0.05,"maxY":0.05}]);
        assert!(Plate::from_value(1,0,&missing).is_err());
    }
    #[test]
    fn mounted_weapon_admission_rejects_missing_catalogue_mount_and_alias_geometry() {
        let current=fixtures::module(1,0,&json!({"kind":"weapon","weaponPreset":"rh120"})).to_value();
        let mut admitted=Module::from_value(1,0,&current,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).unwrap();
        let weapon=&fixtures::catalogue()["rh120"];
        crate::game_mounts::admit_runtime(&current,&mut admitted,weapon,&[],0).unwrap();
        // Old JSON can retain current moments and still be missing the new fixed feet.
        let mut old=current.clone();old["materialPolygons"].as_array_mut().unwrap().drain(2..4);
        for key in ["physicalMass","physicalCenterLocal","physicalInertia"] {assert_eq!(old[key],current[key]);}
        assert_eq!(crate::game_mounts::admit_runtime(&old,&mut admitted,weapon,&[],0).unwrap_err(),
            "Integrated weapon material prefix differs from current fixed base geometry");
        let mut missing=current.clone();missing.as_object_mut().unwrap().remove("materialPolygons");
        assert_eq!(crate::game_mounts::admit_runtime(&missing,&mut admitted,weapon,&[],0).unwrap_err(),
            "Missing integrated weapon material prefix");
        let mut invalid=current.clone();invalid["materialPolygons"][2][0]["x"]=Value::Null;
        assert!(crate::game_mounts::admit_runtime(&invalid,&mut admitted,weapon,&[],0).is_err());
        for key in ["weaponPreset","weaponMount","barrelProfile","receiverMm","barrelMm"] {
            let mut bad=current.clone();bad.as_object_mut().unwrap().remove(key);
            assert!(Module::from_value(1,0,&bad,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).is_err(),"{key}");
        }
        for key in ["barrelEnd","barrelRadius","isFragment","source"] {
            let mut bad=current.clone();bad[key]=json!(1);
            assert!(Module::from_value(1,0,&bad,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).is_err(),"{key}");
        }
        for name in ["unknown","custom",""] {
            let mut bad=current.clone();bad["weaponPreset"]=json!(name);
            assert!(Module::from_value(1,0,&bad,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).is_err());
        }
        let mut bad=current.clone();bad["barrelProfile"]["end"]=json!(1.0);
        assert!(Module::from_value(1,0,&bad,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).is_err());
        assert!(ComponentKind::from_name("other").is_err());
        // The ammunition a gun is fed is one its feed takes; a gun that names none is fed the first.
        let gun=Module::from_value(1,0,&current,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).unwrap();
        assert_eq!(gun.weapon_ammo(fixtures::catalogue()),Some("apfsds"));
        let mut fed=current.clone();fed["weaponAmmo"]=json!("he");
        assert_eq!(Module::from_value(1,0,&fed,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).unwrap().weapon_ammo(fixtures::catalogue()),Some("he"));
        for ammo in [json!("smoke"),json!(1)] {
            let mut bad=current.clone();bad["weaponAmmo"]=ammo;
            assert!(Module::from_value(1,0,&bad,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).is_err());
        }
    }
    #[test]
    fn an_integrated_base_hit_and_mark_stay_on_fixed_metal_while_the_gun_aims(){
        let mut gun=fixtures::module(1,0,&json!({"kind":"weapon","weaponPreset":"m242","angle":0.2}));
        let base=gun.mount.as_ref().unwrap().base.unwrap();
        let at=gun.pose.world_point(point(0.03,base.inner_y+base.thickness*0.35));
        let damage=gun.strike_damage(at,90.0,true);let (uv,part,width)=gun.mark_material(at);
        assert_eq!(part,Some(2));assert_eq!(width,2.0*base.half_width);
        let mark=Mark{uv,part,kind:"dent",strength:1.0,depth:0.0,radius:0.02/width};
        assert!(gun.mark_point(&mark).distance(at)<1e-10);
        gun.barrel_angle+=0.5;
        assert_eq!(gun.strike_damage(at,90.0,true),damage);
        assert!(gun.mark_point(&mark).distance(at)<1e-10);assert!(!gun.barrel_strike(at));
        let encoded=rmp_serde::to_vec(&mark).unwrap();let decoded:Mark=rmp_serde::from_slice(&encoded).unwrap();
        assert_eq!(decoded.part,Some(2));assert!(gun.mark_point(&decoded).distance(at)<1e-10);
        let intact=gun.local_polygons();let facet=&intact[4];
        let lo=crate::game_geometry::atan2(facet[0].y,facet[0].x);let hi=crate::game_geometry::atan2(facet[2].y,facet[2].x);
        let holes=json!([{"min":lo+(hi-lo)*0.25,"max":lo+(hi-lo)*0.75}]);
        gun.set_mantlet_holes(&holes).unwrap();
        let mut saved=gun.to_value();saved["marks"]=json!([{"u":uv.x,"v":uv.y,"part":2,"radiusU":mark.radius}]);
        let mut restored=Module::from_value(1,0,&saved,fixtures::catalogue(),&fixtures::full_catalogue()["mounts"]).unwrap();
        assert_eq!(restored.marks[0].part,Some(2));assert!(restored.mark_point(&restored.marks[0]).distance(at)<1e-10);
        assert_eq!(restored.holes_value(),holes);
        assert!(restored.local_polygons().iter().map(|p|polygon_properties(p).area).sum::<f64>()
            <intact.iter().map(|p|polygon_properties(p).area).sum::<f64>());
        crate::game_mounts::admit_runtime(&saved,&mut restored,&fixtures::catalogue()["m242"],&[],0).unwrap();
    }
    #[test]
    fn plate_import_keeps_explicit_vertices_local() {
        let p = crate::game_damage::fixtures::plate(
            1,
            0,
            &json!({"x":12,"y":3,"angle":0.3,
            "length":1,"thicknessMm":100,"material":"steel","massScale":2,
            "vertices":[{"x":-0.5,"y":-0.05},{"x":0.5,"y":-0.05},{"x":0.5,"y":0.05},{"x":-0.5,"y":0.05}],
            "positions":[-0.5,-0.05,0.5,-0.05,0.5,0.05,-0.5,0.05]}),
        );
        assert_eq!(p.local_nodes[0], point(-0.5, -0.05));
        assert!((p.mass() - 1560.0).abs() < 1e-10);
        assert!(p.contains_local(Point::ZERO));
    }
    #[test]
    fn repeated_grid_damage_is_bounded_and_never_removes_physical_mass_or_heals_on_load() {
        let mut p = plate();
        p.record_dent(point(0.0, -0.05), 0.004, 0.08);
        let (mass, inertia, center) = (p.mass(), p.inertia(), p.physical_center);
        let mut last = p.properties.area;
        for i in 0..2000 {
            let x = -0.99 + (i % 100) as f64 * 0.02;
            p.cut_clipped(point(x, -0.08), point(x, 0.08), 0.003, None);
            assert!(p.properties.area <= last + 1e-12);
            last = p.properties.area;
        }
        let mut saved = p.to_value();
        // Current saves may carry retired histories alongside real material
        // cuts and visual dents. Only those histories are discarded on load.
        saved["wear"] = json!({"metal":[{"bin":0,"positive":false,"hits":479,"stage":3}],
            "brittle":[{"bin":0,"face":-1,"energy":159,"cut":false}]});
        saved["wearCount"] = json!(2);
        let q = crate::game_damage::fixtures::plate(p.owner, p.actor, &saved);
        assert_eq!(q.grid.to_value(), p.grid.to_value());
        assert_eq!(
            (p.mass(), p.inertia(), p.physical_center),
            (mass, inertia, center)
        );
        assert_eq!(
            (q.mass(), q.inertia(), q.physical_center),
            (mass, inertia, center)
        );
        assert_eq!(p.local_nodes.len(), 4);
        assert_eq!(p.indices.len(), 6);
        assert!(p.grid.nx * p.grid.ny <= 4096);
        assert!(p.perforations.len() <= p.grid.nx);
        assert!((q.properties.area - p.properties.area).abs() < 1e-10);
        let loaded = q.to_value();
        assert_eq!(loaded["marks"], saved["marks"]);
        assert_eq!(loaded["dents"], saved["dents"]);
        assert_eq!(loaded["perforations"], saved["perforations"]);
        assert!(loaded.get("wear").is_none());
        assert!(loaded.get("wearCount").is_none());
    }
    #[test]
    fn a_dent_and_its_remaining_thickness_survive_cold_round_trip() {
        let mut p = plate();
        p.record_dent(point(0.0, -0.05), 0.004, 0.08);
        let q = crate::game_damage::fixtures::plate(1, 0, &p.to_value());
        assert_eq!(p.dents.len(), q.dents.len());
        assert_eq!(
            p.resistance_scale(point(0.0, -0.05)),
            q.resistance_scale(point(0.0, -0.05))
        );
        assert_eq!(p.mass(), q.mass());
        assert_eq!(p.marks.len(), q.marks.len());
    }
    #[test]
    fn barrel_marks_follow_the_tube_and_survive_cold_round_trip() {
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(
            2,
            0,
            &json!({"kind":"weapon","x":5,"y":2,"angle":0.2,
            "health":900,"maxHealth":900,"barrelAngle":0.73,"weaponPreset":"rh120"}),
        ));
        let pose = Pose {
            x: 5.0,
            y: 2.0,
            angle: 0.73,
        };
        for i in 0..22 {
            damage.damage_module(
                2,
                20.0,
                pose.world_point(point(0.5 + i as f64 * 0.06, 0.01)),
                &mut Effects::default(),
            );
        }
        let last = pose.world_point(point(1.76, 0.01));
        damage.damage_module(2, 20.0, last, &mut Effects::default());
        let module = damage.module(2).unwrap();
        assert_eq!(module.barrel_marks.len(), 16);
        assert!((module.barrel_marks.last().unwrap().point.x - 1.76).abs() < 1e-12);
        assert!((module.barrel_marks.last().unwrap().point.y - 0.01).abs() < 1e-12);
        assert!(module.barrel_disabled);
        assert!((module.health - (900.0 - 23.0 * 20.0 * 0.18)).abs() < 1e-10);
        let loaded = crate::game_damage::fixtures::module(2, 0, &module.to_value());
        assert_eq!(
            loaded.to_value()["barrelMarks"],
            module.to_value()["barrelMarks"]
        );
        assert_eq!(loaded.barrel_damage, module.barrel_damage);
        assert_eq!(loaded.barrel_disabled, module.barrel_disabled);
    }
    #[test]
    fn a_hopper_takes_solids_and_a_cistern_liquids_each_as_far_as_it_has_room() {
        let piece=|kind:&str,extra:Value|{let mut v=json!({"kind":kind,"x":0,"y":0});
            for (key,value) in extra.as_object().unwrap() {v[key]=value.clone();}
            crate::game_damage::fixtures::module(2,0,&v)};
        let mut hopper=piece("hopper",json!({}));let room=hopper.cargo_room;
        assert!((room-1.6*0.9*1.2*0.8).abs()<1e-12);
        assert!((hopper.dry_mass-380.0).abs()<1e-9 && (hopper.live_mass()-380.0).abs()<1e-9);
        hopper.stow(&json!({"ferro":1200,"silica":400})).unwrap();
        assert_eq!(hopper.cargo_value(),json!({"ferro":1200.0,"ligas":0.0,"silica":400.0}));
        assert!((hopper.live_mass()-1980.0).abs()<1e-9,"a unit of a solid is a kilogram");
        // A mixed load fills by volume: a cubic metre of iron leaves the rest of the room to the lighter ore.
        hopper.stow(&json!({"ferro":2400,"ligas":1e9})).unwrap();
        assert_eq!(hopper.cargo[0],2400.0);assert!((hopper.cargo[1]-(room-1.0)*1500.0).abs()<1e-6);assert_eq!(hopper.cargo[2],0.0);
        hopper.stow(&json!({"ferro":1e9})).unwrap();assert!((hopper.cargo[0]-room*2400.0).abs()<1e-6);
        // A load is told whole: what is not named is put down.
        hopper.stow(&json!({})).unwrap();assert_eq!(hopper.cargo,[0.0;4]);
        for bad in [json!({"petroleo":1}),json!({"ferro":-1}),json!({"gold":1}),json!({"ferro":"1"}),json!(3)] {
            assert!(hopper.stow(&bad).is_err(),"{bad}");
        }
        let mut cistern=piece("cistern",json!({}));
        assert!((cistern.dry_mass-260.0).abs()<1e-9);
        cistern.stow(&json!({"petroleo":500})).unwrap();
        assert!((cistern.live_mass()-260.0-425.0).abs()<1e-9,"a litre of petroleum weighs 0.85 kg");
        cistern.stow(&json!({"petroleo":1e9})).unwrap();
        assert!((cistern.cargo[3]-1.4*0.9*1.1*0.78*1000.0).abs()<1e-6);
        assert!(cistern.stow(&json!({"ferro":1})).is_err());
        // What it carries is told with it, and it is admitted again with what it was told with.
        let told=cistern.to_value();assert_eq!(told["cargo"],cistern.cargo_value());
        let again=crate::game_damage::fixtures::module(2,0,&told);
        assert_eq!(again.cargo,cistern.cargo);assert_eq!(again.cargo_room,cistern.cargo_room);
        // A supply piece takes every material and fuel, in one room: crates and cans pack seven tenths of it.
        let mut crates=piece("supply",json!({}));
        assert!((crates.cargo_room-1.5*0.9*1.1*0.7).abs()<1e-12 && (crates.dry_mass-300.0).abs()<1e-9);
        crates.stow(&json!({"ferro":1200,"ligas":300,"silica":150,"petroleo":200})).unwrap();
        assert_eq!(crates.cargo,[1200.0,300.0,150.0,200.0]);
        assert!((crates.live_mass()-300.0-1650.0-170.0).abs()<1e-9);
        let told=crates.to_value();assert_eq!(told["cargo"],json!({"ferro":1200.0,"ligas":300.0,"silica":150.0,"petroleo":200.0}));
        assert_eq!(crate::game_damage::fixtures::module(2,0,&told).cargo,crates.cargo);
        // Nothing else carries, and a load makes a reservoir harder to shoot through.
        let mut engine=piece("engine",json!({"physicalMass":880}));
        assert_eq!(engine.cargo_room,0.0);assert!(engine.stow(&json!({"ferro":1})).is_err());
        engine.weigh();assert_eq!((engine.live_mass(),engine.physical_mass),(880.0,880.0));
        let empty=hopper.resistance(point(0.0,0.0),1.6,1.0);
        hopper.stow(&json!({"ferro":3000})).unwrap();
        assert!(hopper.resistance(point(0.0,0.0),1.6,1.0)>empty*3.0);
    }
    #[test]
    fn a_paver_carries_the_mix_of_its_asphalt_alone_each_thing_in_its_share_and_loses_it_with_itself() {
        let paver=|scale:f64|crate::game_damage::fixtures::module(2,0,&json!({"kind":"paver","x":0,"y":0,"width":1.6*scale}));
        for scale in [0.5,1.0,2.0] {
            // Its size makes it longer and taller, not deeper: it carries, and weighs, the square of it.
            let mut m=paver(scale);let metres=45.0*scale*scale;
            assert!((m.cargo_room-metres*crate::game_geometry::mix_volume()).abs()<1e-9,"{scale}");
            assert!((m.dry_mass-2200.0*scale*scale).abs()<1e-6 && m.live_mass()==m.dry_mass && m.reservoir());
            // Full of its mix it weighs what 280 kg of Sílica and 14 L of petroleum to the metre do: 13.1 t at 100 %.
            assert!((m.cargo_limit()-metres*(280.0+14.0*0.85)).abs()<1e-6);
            m.stow(&json!({"silica":1e9,"petroleo":1e9})).unwrap();
            assert!((m.cargo[2]-280.0*metres).abs()<1e-6 && (m.cargo[3]-14.0*metres).abs()<1e-6,"each thing as far as its share");
            assert!((m.live_mass()-m.dry_mass-m.cargo_limit()).abs()<1e-6);
        }
        assert!((paver(1.0).cargo_limit()-13135.5).abs()<1e-6);
        // Each thing of the mix in its own share: the Sílica of all of it leaves the room of its petroleum.
        let mut m=paver(1.0);
        m.stow(&json!({"silica":12600,"petroleo":100})).unwrap();
        assert_eq!(m.cargo,[0.0,0.0,12600.0,100.0]);
        assert_eq!(m.cargo_value(),json!({"silica":12600.0,"petroleo":100.0}));
        for bad in [json!({"ferro":1}),json!({"ligas":1}),json!({"silica":-1})] {assert!(m.stow(&bad).is_err(),"{bad}");}
        // Told with what it carries, it is admitted again with it.
        let again=crate::game_damage::fixtures::module(2,0,&m.to_value());
        assert_eq!((again.cargo,again.cargo_room),(m.cargo,m.cargo_room));
        // Destroyed, its mix is lost with it, and weighed again it is the paver alone; a hopper keeps what it had.
        let mut d=DamageState::default();d.insert_module(m);
        let mut hopper=crate::game_damage::fixtures::module(3,0,&json!({"kind":"hopper","x":0,"y":0}));
        hopper.stow(&json!({"silica":400})).unwrap();d.insert_module(hopper);
        let mut effects=Effects::default();
        d.destroy_module(2,&mut effects);d.destroy_module(3,&mut effects);
        assert!(effects.detonations.is_empty());
        assert_eq!(d.module(3).unwrap().cargo,[0.0,0.0,400.0,0.0]);
        let m=d.module_mut(2).unwrap();
        assert_eq!(m.cargo,[0.0;4]);
        m.weigh();assert_eq!(m.physical_mass,m.dry_mass);
    }
    #[test]
    fn a_reserve_weighs_what_it_holds_once_it_is_weighed_again() {
        let mut d = DamageState::default();
        d.insert_module(crate::game_damage::fixtures::module(
            2,
            0,
            &json!({"kind":"fuel",
            "physicalMass":122.812,"fuelLitres":100,"capacityLitres":202.176}),
        ));
        d.insert_module(crate::game_damage::fixtures::module(
            3,
            0,
            &json!({"kind":"ammo",
            "physicalMass":200,"rounds":3,"capacityRounds":3,"ammoPreset":"rh120"}),
        ));
        let mut effects = Effects::default();
        assert_eq!(d.consume_fuel(0, 0.25), 0.25);
        assert_eq!(d.module(2).unwrap().fuel_litres, 99.75);
        assert_eq!(d.consume_fuel(1, 0.25), 0.0, "another actor's tank gives nothing");
        assert!(d.consume_round(0, "rh120"));
        assert_eq!(d.module(3).unwrap().rounds, 2);
        assert_eq!(d.module(2).unwrap().physical_mass, 122.812);
        assert_eq!(d.module(3).unwrap().physical_mass, 200.0);
        d.destroy_module(2, &mut effects);
        d.destroy_module(3, &mut effects);
        assert_eq!(d.module(2).unwrap().fuel_litres, 99.75);
        assert_eq!(d.module(3).unwrap().rounds, 0);
        assert_eq!(d.module(2).unwrap().physical_mass, 122.812);
        assert_eq!(d.module(3).unwrap().physical_mass, 200.0);
        d.step_burning(180.0, &crate::game_geometry::Geometry::new(), &mut effects);
        // Until it is weighed the body carries it as it was; weighed, it is its casing and what is left in it.
        for owner in [2, 3] {
            let m = d.module_mut(owner).unwrap();
            let remaining = m.dry_mass - crate::game_fire::consumed_solid(m);
            assert_eq!(m.live_mass(), remaining);
            m.weigh();
            assert_eq!(m.physical_mass, remaining);
            assert_eq!(m.physical_inertia, remaining * (m.width * m.width + m.height * m.height) / 12.0);
        }
        assert_eq!(effects.detonations.len(), 1, "only the ammunition detonates");
        assert!(d.stats.to_value().get("ejectedMass").is_none());
    }
    #[test]
    fn combat_counts_start_at_zero_and_round_trip() {
        assert_eq!(CombatStats::from_value(&Value::Null).to_value(), CombatStats::default().to_value());
        let value = CombatStats::from_value(&json!({"impacts":12,"shots":4,"spallBursts":2})).to_value();
        assert_eq!(value, json!({"shots":4,"impacts":12,"penetrations":0,"ricochets":0,"explosions":0,"spallBursts":2,
            "secondaryShots":0,"secondaryComponentHits":0}));
        assert_eq!(CombatStats::from_value(&value).to_value(), value);
    }
}
