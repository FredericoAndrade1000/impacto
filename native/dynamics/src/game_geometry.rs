//! Persistent base contours and bounded material-grid CCD. Handles are assigned
//! once; damage clears grid cells, never the rigid contact outline.
use serde::{Deserialize, Serialize};
use rapier2d_f64::prelude::nalgebra::{ComplexField, RealField};
use serde_json::{Value, json};
use std::f64::consts::PI;
use std::sync::Arc;

#[path = "game_terrain.rs"]
mod terrain;
pub use terrain::{SURFACE_KINDS, SurfaceKind, Terrain, TerrainHit, TerrainSupport};

// Use the same libm implementation selected by enhanced-determinism on both
// hosts. Primitive f64::sin/cos would silently reintroduce platform trig.
pub fn sin(x: f64) -> f64 {
    ComplexField::sin(x)
}
pub fn cos(x: f64) -> f64 {
    ComplexField::cos(x)
}
pub fn sqrt(x: f64) -> f64 {
    ComplexField::sqrt(x)
}
pub fn exp_m1(x: f64) -> f64 {
    ComplexField::exp_m1(x)
}
pub fn atan2(y: f64, x: f64) -> f64 {
    RealField::atan2(y, x)
}
pub fn hypot(x: f64, y: f64) -> f64 {
    sqrt(x * x + y * y)
}
pub fn number(v: &Value, field: &str, default: f64) -> f64 {
    v.get(field)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .unwrap_or(default)
}

// Written out as the frames write it (game_frame.rs), and read back so.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[cfg_attr(feature = "typegen", ts(rename = "NativePoint"))]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
impl Point {
    pub const ZERO: Self = Self { x: 0.0, y: 0.0 };
    pub const fn new(x: f64, y: f64) -> Self {
        Self { x, y }
    }
    pub fn from_value(v: &Value) -> Self {
        Self::new(number(v, "x", 0.0), number(v, "y", 0.0))
    }
    pub fn to_value(self) -> Value {
        json!({"x":self.x,"y":self.y})
    }
    pub fn lerp(self, b: Self, t: f64) -> Self {
        Self::new(self.x + (b.x - self.x) * t, self.y + (b.y - self.y) * t)
    }
    pub fn distance(self, b: Self) -> f64 {
        hypot(self.x - b.x, self.y - b.y)
    }
    pub fn dot(self, b: Self) -> f64 {
        self.x * b.x + self.y * b.y
    }
    pub fn cross(self, b: Self) -> f64 {
        self.x * b.y - self.y * b.x
    }
}
pub type Polygon = Vec<Point>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
pub struct Pose {
    pub x: f64,
    pub y: f64,
    pub angle: f64,
}
impl Pose {
    pub fn from_value(v: &Value) -> Self {
        Self {
            x: number(v, "x", 0.0),
            y: number(v, "y", 0.0),
            angle: number(v, "angle", 0.0),
        }
    }
    pub fn to_value(self) -> Value {
        json!({"x":self.x,"y":self.y,"angle":self.angle})
    }
    pub fn world_point(self, p: Point) -> Point {
        transform(p, self, cos(self.angle), sin(self.angle))
    }
    pub fn local_point(self, p: Point) -> Point {
        inverse(p, self, cos(self.angle), sin(self.angle))
    }
}
fn transform(p: Point, pose: Pose, c: f64, s: f64) -> Point {
    Point::new(pose.x + c * p.x - s * p.y, pose.y + s * p.x + c * p.y)
}
fn inverse(p: Point, pose: Pose, c: f64, s: f64) -> Point {
    let x = p.x - pose.x;
    let y = p.y - pose.y;
    Point::new(c * x + s * y, -s * x + c * y)
}

/// Bound the small outward tolerance accepted by `segment_convex`. Tiny or
/// acute shapes need more than a fixed geometric epsilon. Degenerate shapes
/// remain queryable by the narrow phase without any new rejection.
fn convex_ray_padding(vertices: &[Point]) -> f64 {
    let mut padding: f64 = 1e-5;
    for (i, p) in vertices.iter().enumerate() {
        let before=vertices[(i+vertices.len()-1)%vertices.len()];
        let after=vertices[(i+1)%vertices.len()];
        let a=Point::new(p.x-before.x,p.y-before.y);
        let b=Point::new(after.x-p.x,after.y-p.y);
        let determinant=a.cross(b).abs();
        if determinant<=1e-20 {return f64::INFINITY;}
        padding=padding.max(2e-9*(a.x.abs()+a.y.abs()+b.x.abs()+b.y.abs())/determinant);
    }
    padding
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bounds {
    pub min_x: f64,
    pub min_y: f64,
    pub max_x: f64,
    pub max_y: f64,
}
impl Bounds {
    pub fn empty() -> Self {
        Self {
            min_x: f64::INFINITY,
            min_y: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
            max_y: f64::NEG_INFINITY,
        }
    }
    pub fn from_value(v: &Value) -> Self {
        Self {
            min_x: number(v, "minX", 0.0),
            min_y: number(v, "minY", 0.0),
            max_x: number(v, "maxX", 0.0),
            max_y: number(v, "maxY", 0.0),
        }
    }
    pub fn points(points: &[Point]) -> Self {
        let mut b = Self::empty();
        for p in points {
            b.include(*p);
        }
        b
    }
    pub fn include(&mut self, p: Point) {
        self.min_x = self.min_x.min(p.x);
        self.min_y = self.min_y.min(p.y);
        self.max_x = self.max_x.max(p.x);
        self.max_y = self.max_y.max(p.y);
    }
    pub fn union(&mut self, b: Self) {
        self.min_x = self.min_x.min(b.min_x);
        self.min_y = self.min_y.min(b.min_y);
        self.max_x = self.max_x.max(b.max_x);
        self.max_y = self.max_y.max(b.max_y);
    }
    pub fn overlaps(self, b: Self) -> bool {
        self.max_x >= b.min_x
            && self.min_x <= b.max_x
            && self.max_y >= b.min_y
            && self.min_y <= b.max_y
    }
    pub fn padded(self, d: f64) -> Self {
        Self {
            min_x: self.min_x - d,
            min_y: self.min_y - d,
            max_x: self.max_x + d,
            max_y: self.max_y + d,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum EntityKind {
    Plate,
    Module,
}
/// The road wheels of the reference track, and the fewest and the most a track may run on.
pub(crate) const ROAD_WHEELS: f64 = 7.0;
pub(crate) const MIN_ROAD_WHEELS: f64 = 3.0;
pub(crate) const MAX_ROAD_WHEELS: f64 = 14.0;
/// How far out from the middle of a wheel of a track its belt runs, over the height of the track: the road wheels it
/// runs on, and the sprocket and the idler at its ends, are all as large.
pub(crate) const TRACK_WHEEL: f64 = 0.36;
/// The wheels a track `width` long and `height` high turns its belt round, in the frame of the track (its middle at
/// the origin), each `radius` round with the belt on it and all of them evenly along it. Its road wheels carry it on
/// the lower run, their middles `low` over its middle, as many as it is long in road wheels
/// (`ComponentKind::road_wheels`). The sprocket and the idler stand one road wheel further on at either end, at
/// `±end.x`, with the upper run over them: raised off the ground, as on the Leopard 2 and the Abrams, so that the belt
/// runs up to each of them from the last road wheel, and meets the edge of a step with that run.
pub(crate) struct TrackWheels {
    pub(crate) radius: f64,
    pub(crate) end: Point,
    pub(crate) road: Vec<f64>,
    pub(crate) low: f64,
}
pub(crate) fn track_wheels(width: f64, height: f64) -> TrackWheels {
    let radius = TRACK_WHEEL * height;
    let end = width / 2.0 - radius;
    let count = ComponentKind::road_wheels(width, height);
    let pitch = 2.0 * end / (count + 1.0);
    TrackWheels {
        radius,
        end: Point::new(end, height / 2.0 - radius),
        road: (1..=count as usize).map(|i| pitch * i as f64 - end).collect(),
        low: radius - height / 2.0,
    }
}
impl TrackWheels {
    /// The middles of the outermost of its wheels, that its outline runs round (`track_outline`): the last road wheel at
    /// each end and the idler and the sprocket, the last road wheel lifted `lift` along the run up to the end.
    pub(crate) fn corners(&self, lift: f64) -> [Point; 4] {
        let last = self.road[self.road.len() - 1];
        let rise = (lift / (self.end.y - self.low)).min(1.0);
        let low = Point::new(last + (self.end.x - last) * rise, self.low + (self.end.y - self.low) * rise);
        [low, self.end, Point::new(-self.end.x, self.end.y), Point::new(-low.x, low.y)]
    }
    /// What one side of the track covers: its outline, as far out as its belt.
    pub(crate) fn side(&self) -> f64 {
        let [low, end, ..] = self.corners(0.0);
        let run = hypot(end.x - low.x, end.y - low.y);
        (low.x + end.x) * (end.y - low.y) + 2.0 * (low.x + end.x + run) * self.radius + PI * self.radius * self.radius
    }
}
/// The outline of a track: its belt round its wheels (`track_wheels`), along the lower run under its road wheels, up the
/// run to each end, round the idler and the sprocket and along the upper run; each turn of it straight pieces of no
/// more than a tenth of a half turn, and that round an end wheel in two at its outermost point, where the track ends.
pub(crate) fn track_outline(width: f64, height: f64) -> Polygon {
    let wheels = track_wheels(width, height);
    let [low, end, ..] = wheels.corners(0.0);
    // The run up to the end faces down and out at this angle.
    let run = atan2(low.x - end.x, end.y - low.y);
    let back = Point::new(-end.x, end.y);
    let turns = [(low, -PI / 2.0, run, 0), (end, run, 0.0, 0), (end, 0.0, PI / 2.0, 1), (back, PI / 2.0, PI, 0),
        (back, PI, PI - run, 1), (Point::new(-low.x, low.y), PI - run, 1.5 * PI, 0)];
    let mut outline = Vec::new();
    for (middle, from, to, first) in turns {
        let steps = ((to - from) / (PI / 10.0)).ceil().max(1.0) as usize;
        outline.extend((first..=steps).map(|i| {
            let a = from + (to - from) * i as f64 / steps as f64;
            Point::new(middle.x + wheels.radius * cos(a), middle.y + wheels.radius * sin(a))
        }));
    }
    outline
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComponentKind {
    Sensor,
    Command,
    Engine,
    Weapon,
    Fuel,
    Ammo,
    Wheel,
    Track,
    /// What a construction hauls in: a bin for what is dug and a tank for what is pumped.
    Hopper,
    Cistern,
    /// What a supply vehicle takes the stocks of its faction to the front in: crates and cans, for every material and fuel.
    Supply,
    /// Complete extraction mechanisms; their articulated arms are presentation only. They carry no cargo.
    Excavator,
    Drill,
    /// A complete construction mechanism; work is scheduled by the field, not a new physical solver.
    Builder,
    /// The road machines: the blade of a motor grader, which levels natural ground into packed earth as its vehicle goes
    /// slowly over it, and a paver, which lays asphalt on packed earth of the mix it carries in the hopper built into it
    /// (`PAVER_METRES`). Like the tools above they work on the power of the engines of their construction; their work is
    /// the field's.
    Blade,
    Paver,
    /// A lift jet, which pushes its construction the way it points in the hull and burns the fuel of its tanks for it, as
    /// the flight computer asks (game_hover.rs). No wing holds anything up: what flies is held up by its thrusters.
    Thruster,
}
/// What a piece may be made of (`metal`, `ComponentKind::metals`): the steel of reference, the one that is not written;
/// a lighter metal, paid from the alloys of a faction; a glass-fibre laminate, paid from its silica; or a polyethylene
/// moulding, paid from its fuel, as plastic is made of petroleum. Neither of the last two is a metal, but each is chosen
/// as one. Each says what the piece weighs, stands and costs, as shares of the steel one; the armour of a running gear
/// stays steel, and what a piece holds stays what it is. The laminate is told as its plates are (`Material::named`): to
/// stand as 5 mm of steel stands it takes 10 mm (`least_thickness`), a quarter as dense — half the mass —; those 10 mm
/// stop 0.6 of what the 1.25 of steel stop — half the health —; and half the mass at the 3.2 a kilogram of its plates for
/// the 1.4 of steel is 1.1 times the price. The moulding, which no plate is made of, is told as a tank of it is moulded:
/// walls 2.9 times as thick as the 2 mm of a steel one (`fresh_component`), of a material an eighth as dense (950 kg/m³)
/// — 0.35 of the mass —; they hold 34 MPa where that steel holds 285, which over 2.9 times the thickness is 0.35 of the
/// health; and that mass at 1.6 a kilogram for the 1.4 of steel is 0.4 of the price. A piece is brittle, and clear to a
/// wave, as a plate of its name is (`material`). Mirrored in `src/materials.js` (`METALS`).
pub(crate) struct Metal {
    pub name: &'static str,
    pub mass: f64,
    pub health: f64,
    pub price: f64,
}
pub(crate) const METALS: [Metal; 5] = [
    Metal { name: "steel", mass: 1.0, health: 1.0, price: 1.0 },
    Metal { name: "aluminum", mass: 0.65, health: 0.75, price: 1.3 },
    Metal { name: "titanium", mass: 0.6, health: 1.1, price: 3.0 },
    Metal { name: "fiberglass", mass: 0.5, health: 0.5, price: 1.1 },
    Metal { name: "plastic", mass: 0.35, health: 0.35, price: 0.4 },
];
impl Metal {
    /// The armour of the same name, or the polyethylene no armour is made of (`Material::PLASTIC`): whether a piece of it
    /// cracks where steel would dent, how it glances a shot off, and the wave that runs through it.
    pub(crate) fn material(&self) -> crate::game_damage::Material {
        if self.name == "plastic" { crate::game_damage::Material::PLASTIC } else { crate::game_damage::Material::from_name(self.name) }
    }
}
/// What a piece of this kind is written of: steel when it says none. One it may not be made of is refused; a sensor is
/// held to what its way of detecting may be made of, a camera when it says none.
pub(crate) fn metal(kind: ComponentKind, v: &Value) -> Result<&'static Metal, String> {
    let name = match v.get("metal") { Some(name) => name.as_str().ok_or("Invalid component metal")?, None => "steel" };
    let mode = v.get("sensorMode").and_then(Value::as_str).unwrap_or("visual");
    METALS.iter().find(|metal| metal.name == name && kind.metals(mode).contains(&name)).ok_or_else(|| "Unknown component metal".into())
}
/// What the field hauls. A unit of a solid is a kilogram and a unit of a liquid a litre; `density`
/// is what a cubic metre of it weighs as it lies in a hopper or stands in a cistern, and `paving` how many units of it
/// the mix of a metre of asphalt takes (economy.js `PAVING`): 2.4 m by 5 cm of mix, 288 kg, its aggregate in Sílica
/// and the 5 % of bitumen in it, 14 L, in petroleum.
pub(crate) struct Cargo {
    pub name: &'static str,
    pub liquid: bool,
    pub density: f64,
    pub paving: f64,
}
pub(crate) const CARGO: [Cargo; 4] = [
    Cargo { name: "ferro", liquid: false, density: 2400.0, paving: 0.0 },
    Cargo { name: "ligas", liquid: false, density: 1500.0, paving: 0.0 },
    Cargo { name: "silica", liquid: false, density: 1600.0, paving: 280.0 },
    Cargo { name: "petroleo", liquid: true, density: 850.0, paving: 14.0 },
];
/// The metres of asphalt a paver of the reference size carries the mix for, in the hopper built into it: 45 m, some
/// 13 t of mix, as the hopper of a Vögele Super 1800-3 takes. One of size s carries s² of that, as it holds and weighs
/// s² of what it does (`installed_depth`).
pub(crate) const PAVER_METRES: f64 = 45.0;
/// The room the mix of a metre of asphalt takes, in cubic metres.
pub(crate) fn mix_volume() -> f64 {
    CARGO.iter().map(|c| c.paving * c.unit_volume()).sum()
}
impl Cargo {
    /// What a unit of it weighs, in kilograms.
    pub(crate) fn unit_mass(&self) -> f64 {
        if self.liquid { self.density / 1000.0 } else { 1.0 }
    }
    /// The room a unit of it takes, in cubic metres.
    pub(crate) fn unit_volume(&self) -> f64 {
        if self.liquid { 0.001 } else { 1.0 / self.density }
    }
}
impl ComponentKind {
    pub fn from_name(name: &str) -> Result<Self, String> {
        Ok(match name {
            "sensor" => Self::Sensor,
            "command" => Self::Command,
            "engine" => Self::Engine,
            "weapon" => Self::Weapon,
            "fuel" => Self::Fuel,
            "ammo" => Self::Ammo,
            "wheel" => Self::Wheel,
            "track" => Self::Track,
            "hopper" => Self::Hopper,
            "cistern" => Self::Cistern,
            "supply" => Self::Supply,
            "excavator" => Self::Excavator,
            "drill" => Self::Drill,
            "builder" => Self::Builder,
            "blade" => Self::Blade,
            "paver" => Self::Paver,
            "thruster" => Self::Thruster,
            _ => return Err(format!("Unknown component kind {name}")),
        })
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Engine => "engine", Self::Weapon => "weapon", Self::Fuel => "fuel",
            Self::Ammo => "ammo", Self::Wheel => "wheel", Self::Track => "track",
            Self::Command => "command", Self::Sensor => "sensor",
            Self::Hopper => "hopper", Self::Cistern => "cistern", Self::Supply => "supply",
            Self::Excavator => "excavator", Self::Drill => "drill", Self::Builder => "builder",
            Self::Blade => "blade", Self::Paver => "paver", Self::Thruster => "thruster",
        }
    }
    pub fn gear(self) -> bool { matches!(self, Self::Wheel | Self::Track) }
    /// Whether this piece carries a load: a hopper, a cistern, a supply piece, and a paver the mix it lays.
    pub(crate) fn carrier(self) -> bool {
        matches!(self, Self::Hopper | Self::Cistern | Self::Supply | Self::Paver)
    }
    /// The room a piece of this volume has for what it carries, in cubic metres: a hopper, a cistern or a supply piece a
    /// share of its volume — crates and cans pack less of it than a bin or a tank —, and a paver the room of the mix of
    /// `PAVER_METRES` of asphalt at the reference size, and as much more as it is larger. Nothing else carries.
    pub(crate) fn cargo_room(self, volume: f64) -> f64 {
        match self {
            Self::Hopper => 0.8 * volume, Self::Cistern => 0.78 * volume, Self::Supply => 0.7 * volume,
            Self::Paver => {
                let (w, h, d) = self.dimensions();
                PAVER_METRES * volume / (w * h * d) * mix_volume()
            }
            _ => 0.0,
        }
    }
    /// Whether this piece takes such cargo: solids go into hoppers and liquids into cisterns, a supply piece takes both, and
    /// a paver what the mix of asphalt is made of.
    pub(crate) fn takes(self, cargo: &Cargo) -> bool {
        match self { Self::Hopper => !cargo.liquid, Self::Cistern => cargo.liquid, Self::Supply => true, Self::Paver => cargo.paving > 0.0, _ => false }
    }
    /// The most units of such cargo a piece with so much room holds: a paver what the mix of the asphalt its room takes
    /// has of it, whatever else it holds — it holds that mix alone —, and anything else that takes it as much as fills
    /// the room.
    pub(crate) fn cargo_most(self, cargo: &Cargo, room: f64) -> f64 {
        if self == Self::Paver { room / mix_volume() * cargo.paving } else if self.takes(cargo) { room / cargo.unit_volume() } else { 0.0 }
    }
    /// The most so much room weighs full: a paver full of its mix, and anything else full of the heaviest it takes.
    pub(crate) fn cargo_limit(self, room: f64) -> f64 {
        if self == Self::Paver {
            CARGO.iter().map(|c| self.cargo_most(c, room) * c.unit_mass()).sum()
        } else {
            room * CARGO.iter().filter(|c| self.takes(c)).fold(0.0, |most, c| c.density.max(most))
        }
    }
    /// The power a tool of this volume takes from the engines of its construction while it works at its full pace, in
    /// kW. Of the reference size (`dimensions`): an excavator, the hydraulics of a 20 t excavator such as the
    /// Caterpillar 320 (110 kW net), which loads the 50 kg of ore a second it digs; a drill, the pump that lifts its
    /// 10 L of petroleum a second from a kilometre down — 83 kW of work on 850 kg/m³ of oil — at the 55 % an electric
    /// submersible pump set gives of what it takes; a builder, the hydraulics of an arm as the excavator's. A tool does
    /// as much more work as it holds more room than one of the reference size, which at size s is s² of it, as deep
    /// across the body as that one (`installed_depth`, economy.js `toolPace`): a pump asks as much more of the power, and
    /// an arm the 5/6 power of that, s^(5/3), as the net power of excavators grows with their bucket — 19 kW for an
    /// eighth of the room, at s 0.35, about a mini Cat 301.7; 190 kW for 1.95 times it, at s 1.4, a Cat 336; 805 kW for
    /// the largest, 10.9 times it at s 3.3, on the way to the 1 260 kW of a Cat 6040 mining shovel at 18.6 times it. A
    /// blade, the 150 kW of a motor grader such as the Caterpillar
    /// 140, which levels a metre of road a second, and the 5/6 power of its room, as an arm: the net power of graders
    /// grows with their moldboard as that of excavators with their bucket; 47 kW at s 0.5, a small grader, 690 kW at
    /// 2.5. A paver, the 120 kW of a tracked one such as the Vögele Super 1800-3 (127 kW), which lays half a metre of
    /// road a second, some 520 t of mix an hour of the 700 it is rated for, and as much more as its room, as a pump: it
    /// spends it heating and moving the mix it lays, as much more as there is more of it — the Super 3000-3 has 2.8
    /// times its power for 2.6 times its mix. Nothing else works.
    pub(crate) fn work_power_kw(self, volume: f64) -> f64 {
        let (w, h, d) = self.dimensions();
        // The room of the piece as a share of that of the reference size: s² at size s.
        let room = volume / (w * h * d);
        match self {
            Self::Excavator | Self::Builder => 110.0 * ComplexField::powf(room, 5.0 / 6.0),
            Self::Drill => 150.0 * room,
            Self::Blade => 150.0 * ComplexField::powf(room, 5.0 / 6.0),
            Self::Paver => 120.0 * room,
            _ => 0.0,
        }
    }
    /// What a piece of this kind may be made of (`METALS`), steel first; of a sensor, what one that detects so
    /// (`sensorMode`) may. A weapon is steel; a radar steel or, as its dome is, glass fibre, stiff enough to hold its antenna
    /// true; a camera and a microphone either or polyethylene, as their cases are moulded of it; a fuel tank, a cistern and a
    /// supply piece any metal, glass fibre or polyethylene, as tanks and crates are made of them; a thruster titanium
    /// alone, as the hot turbine of a jet is of titanium and of the superalloys the Ligas of a faction stand for, which no
    /// other of these stands the heat of — it is never steel, and so always says what it is made of; anything else — the
    /// running gear and the frame it comes with, an engine, a tool, a box of rounds, a command post — any of the metals.
    pub(crate) fn metals(self, sensor_mode: &str) -> &'static [&'static str] {
        match self {
            Self::Weapon => &["steel"],
            Self::Thruster => &["titanium"],
            Self::Sensor if sensor_mode == "radar" => &["steel", "fiberglass"],
            Self::Sensor => &["steel", "fiberglass", "plastic"],
            Self::Fuel | Self::Cistern | Self::Supply => &["steel", "aluminum", "titanium", "fiberglass", "plastic"],
            _ => &["steel", "aluminum", "titanium"],
        }
    }
    /// How much of a piece of this kind its material is, as the share of its mass and the share of its price (in that
    /// order): the rest is kept as on a steel one and paid from Ferro. A sensor and a command post are made of what their
    /// housing is; what is in it, the electronics and the optics, is what it is. Of a radar, the radome and the case are three
    /// tenths of what it weighs, at a twentieth of its price; of a camera or a microphone, the case and its window half
    /// of what it weighs and a tenth of the price, as of the case of a command post. Running gear is of its metal but for
    /// its rubber, which its chassis tells (`rubberShare`, game_chassis.rs). Any other piece is all of its material, and
    /// what it holds is apart.
    pub(crate) fn housing(self, sensor_mode: &str) -> (f64, f64) {
        match self {
            Self::Sensor if sensor_mode == "radar" => (0.3, 0.05),
            Self::Sensor | Self::Command => (0.5, 0.1),
            _ => (1.0, 1.0),
        }
    }
    /// What a storage or extraction assembly of this volume weighs empty, and what it costs: both follow its volume. A
    /// thruster is told as a steel one would be, which none is (`metals`): of titanium it weighs 0.6 of that, the 127 kg
    /// of a Rolls-Royce RB162, and costs three times that, 2 400 credits of Ligas.
    pub(crate) fn empty_mass(self, volume: f64) -> f64 {
        let (w, h, d) = self.dimensions();
        (match self { Self::Hopper => 380.0, Self::Cistern => 260.0, Self::Supply => 300.0,
            Self::Excavator => 650.0, Self::Drill => 800.0, Self::Builder => 700.0,
            Self::Blade => 1100.0, Self::Paver => 2200.0, Self::Thruster => 212.0, _ => 0.0 }) * volume / (w * h * d)
    }
    pub(crate) fn empty_price(self, volume: f64) -> f64 {
        let (w, h, d) = self.dimensions();
        (match self { Self::Hopper => 900.0, Self::Cistern => 1100.0, Self::Supply => 1200.0,
            Self::Excavator => 1800.0, Self::Drill => 2200.0, Self::Builder => 2200.0,
            Self::Blade => 1600.0, Self::Paver => 2600.0, Self::Thruster => 800.0, _ => 0.0 }) * volume / (w * h * d)
    }
    /// The most a thruster of this volume pushes with, in newtons: that of the reference size (`dimensions`) is a
    /// Rolls-Royce RB162 lift jet, 1.31 m long and 0.64 m across, which gives 23.35 kN (5 250 lbf) for its 127 kg. One of
    /// another size pushes as much more as it holds more, as an engine gives as much more power (`engine_power_kw`).
    pub(crate) fn thrust_n(self, volume: f64) -> f64 {
        let (w, h, d) = self.dimensions();
        if self == Self::Thruster { 23_350.0 * volume / (w * h * d) } else { 0.0 }
    }
    /// How long a track at the reference scale is on this many road wheels; the reference track runs on seven.
    pub(crate) fn track_length(road_wheels: f64) -> f64 {
        if road_wheels == ROAD_WHEELS { 5.04 } else { 5.04 * road_wheels / ROAD_WHEELS }
    }
    /// The road wheels a track of these dimensions runs on: an installed one shows them in its length.
    pub(crate) fn road_wheels(width: f64, height: f64) -> f64 {
        (ROAD_WHEELS * (width / 5.04) / (height / 0.74)).round().clamp(MIN_ROAD_WHEELS, MAX_ROAD_WHEELS)
    }
    /// The one scale of a component of these dimensions. That of a track is the scale of its height,
    /// whatever its length.
    pub(crate) fn scale(self, width: f64, height: f64) -> f64 {
        match self {
            Self::Weapon => 1.0,
            Self::Track => height / self.dimensions().1,
            _ => width / self.dimensions().0,
        }
    }
    /// The thickest armour a piece of running gear may wear, in millimetres; none on anything else.
    pub(crate) fn armour_limit(self) -> f64 {
        match self { Self::Wheel => 40.0, Self::Track => 80.0, _ => 0.0 }
    }
    /// What the armour of a piece of running gear weighs: steel of that thickness over the whole of
    /// its side, on both sides of the vehicle.
    pub(crate) fn armour_mass(self, width: f64, height: f64, armour_mm: f64) -> f64 {
        let side = if self == Self::Track { track_wheels(width, height).side() } else { PI * height * height / 4.0 };
        2.0 * side * armour_mm / 1000.0 * 7850.0
    }
    pub(crate) fn dimensions(self) -> (f64, f64, f64) {
        match self {
            Self::Engine => (1.05, 0.64, 0.65), Self::Weapon => (1.1, 0.42, 0.45),
            Self::Fuel => (0.8, 0.72, 0.45), Self::Ammo => (0.78, 0.65, 0.45),
            Self::Wheel => (0.74, 0.74, 0.45), Self::Track => (5.04, 0.74, 0.45),
            Self::Command => (0.44, 0.28, 0.18), Self::Sensor => (0.32, 0.24, 0.18),
            Self::Hopper => (1.6, 0.9, 1.2), Self::Cistern => (1.4, 0.9, 1.1), Self::Supply => (1.5, 0.9, 1.1),
            Self::Excavator => (1.2, 0.6, 0.9), Self::Drill => (0.8, 1.3, 0.8), Self::Builder => (1.2, 0.6, 0.9),
            Self::Blade => (1.6, 0.45, 1.2), Self::Paver => (1.6, 0.9, 1.2),
            // Standing on its axis, as it lifts with no angle: as wide and as deep as it is across.
            Self::Thruster => (0.64, 1.31, 0.64),
        }
    }
    /// The largest size a piece of this kind is built at, a multiple of its `dimensions` (component-size.js
    /// `componentSizeLimits`). A hopper, a cistern and a supply piece reach three times theirs, as long and as tall as
    /// the body of a large dump truck or tanker; any other piece as much as keeps it within 4 m long and tall. At any size
    /// a piece stands as deep across the body as its kind (`installed_depth`), which every kind is within the body.
    /// A command post, a sensor and a weapon have the one size.
    pub(crate) fn largest_scale(self) -> f64 {
        let (w, h, _) = self.dimensions();
        match self {
            Self::Hopper | Self::Cistern | Self::Supply => 3.0,
            Self::Command | Self::Sensor | Self::Weapon => 1.0,
            _ => (f64::min(4.0 / w, 4.0 / h) * 20.0).floor() / 20.0,
        }
    }
    pub(crate) fn health(self) -> f64 {
        match self {
            Self::Engine => 110.0, Self::Weapon => 900.0, Self::Fuel => 75.0,
            Self::Ammo => 65.0, Self::Wheel => 80.0, Self::Track => 160.0,
            Self::Command => 60.0, Self::Sensor => 35.0,
            Self::Hopper => 120.0, Self::Cistern => 90.0, Self::Supply => 100.0,
            Self::Excavator => 140.0, Self::Drill => 130.0, Self::Builder => 140.0,
            Self::Blade => 160.0, Self::Paver => 130.0, Self::Thruster => 80.0,
        }
    }
}
/// How long a barrel may be, from the trunnion to the muzzle, in metres: the shortest launcher to the longest field
/// howitzer (weapons.js `BARREL_REACH`).
pub const BARREL_REACH: (f64, f64) = (0.2, 7.5);
/// How thick a tube may be, half its outer diameter, in metres: the pod of nineteen rockets is the thickest.
pub const BARREL_RADIUS: (f64, f64) = (0.001, 0.2);
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct BarrelProfile {
    pub start: f64,
    pub end: f64,
    pub radius: f64,
}
impl BarrelProfile {
    /// The tube of a weapon as its preset states it: from a hand before the trunnion to the muzzle, as thick as
    /// its thickest common section (weapons.js `barrel`, `barrelRadius`).
    pub fn from_weapon(weapon: &Value) -> Result<Self, String> {
        Self::admit(crate::game_flight::required(weapon,"barrel")?, crate::game_flight::required(weapon,"barrelRadius")?)
            .ok_or_else(||"Invalid weapon barrel geometry".into())
    }
    pub fn from_value(v: &Value) -> Result<Self, String> {
        let b = &v["barrelProfile"];
        let result = Self::admit(crate::game_flight::required(b,"end")?, crate::game_flight::required(b,"radius")?)
            .ok_or("Invalid native barrel profile")?;
        if crate::game_flight::required(b,"start")? != result.start {
            return Err("Invalid native barrel profile".into());
        }
        Ok(result)
    }
    fn admit(end: f64, radius: f64) -> Option<Self> {
        ((BARREL_REACH.0..=BARREL_REACH.1).contains(&end) && (BARREL_RADIUS.0..=BARREL_RADIUS.1).contains(&radius))
            .then_some(Self {start:0.10,end,radius})
    }
    pub fn to_value(self) -> Value { json!({"start":self.start,"end":self.end,"radius":self.radius}) }
}
pub fn rectangle(width: f64, height: f64) -> Polygon {
    vec![
        Point::new(-width / 2.0, -height / 2.0),
        Point::new(width / 2.0, -height / 2.0),
        Point::new(width / 2.0, height / 2.0),
        Point::new(-width / 2.0, height / 2.0),
    ]
}
/// How deep a piece of this kind and reference depth stands across the body at this size (component-volume.js
/// `componentDepth`). A piece the workshop sizes is as deep as its kind at any size: the side view shows its length and
/// its height, and those alone grow with it, so that what it holds, gives and weighs, which follow its volume, grow
/// with what the field sees of it — at size s, s² of what one of the reference size does, as four of half its size side
/// by side and one over the other do. Running gear, which its chassis sizes, stands as deep as the wheel or the track of
/// the catalogue drawn to its height, by that one scale and no deeper than the body is wide.
pub(crate) fn installed_depth(kind: ComponentKind, reference: f64, scale: f64) -> f64 {
    if kind.gear() { (reference * scale).min(crate::game_construction::BODY_WIDTH) } else { reference }
}
/// The share of a box of ammunition its cartridges fill.
pub(crate) const AMMUNITION_PACKING: f64 = 0.55;
/// Whole cartridges packed in a box, shared by admission and its full purchase price.
pub(crate) fn ammunition_capacity(volume: f64, litres: f64) -> f64 {
    (volume * AMMUNITION_PACKING * 1000.0 / litres).floor()
}
pub fn component_polygon(kind: ComponentKind, width: f64, height: f64) -> Polygon {
    let radius = height / 2.0;
    if kind == ComponentKind::Wheel {
        return (0..48)
            .map(|i| {
                let a = -PI / 2.0 + i as f64 * PI / 24.0;
                Point::new(cos(a) * radius, sin(a) * radius)
            })
            .collect();
    }
    if kind != ComponentKind::Track {
        return rectangle(width, height);
    }
    track_outline(width, height)
}
pub const MAX_GRID_COLUMNS: usize = 256;
pub const GRID_THICKNESS_ROWS: usize = 16;
pub const MAX_GRID_CELLS: usize = MAX_GRID_COLUMNS * GRID_THICKNESS_ROWS;

/// Fixed admission-time material lattice. Each bit represents a finite local
/// thickness slice, never a new polygon, node or rigid-body contact feature.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct MaterialGrid {
    pub bounds: Bounds,
    pub nx: usize,
    pub ny: usize,
    bits: Vec<u64>,
}
impl MaterialGrid {
    pub fn new(bounds: Bounds) -> Self {
        // A plate written on the grid of the construction is a whole number of 5 cm cells long, as many 2 cm columns
        // as rounding leaves it: told the same way wherever it stands, as the port across it is (game_mounts.rs).
        let nx = (((bounds.max_x - bounds.min_x) / 0.02 - 1e-9).ceil() as usize)
            .clamp(1, MAX_GRID_COLUMNS);
        let ny = GRID_THICKNESS_ROWS;
        debug_assert!(nx * ny <= MAX_GRID_CELLS);
        let mut bits = vec![u64::MAX; (nx * ny).div_ceil(64)];
        if nx * ny % 64 != 0 {
            let last = bits.len() - 1;
            bits[last] = (1u64 << (nx * ny % 64)) - 1;
        }
        Self {
            bounds,
            nx,
            ny,
            bits,
        }
    }
    pub fn from_value(v: &Value) -> Option<Self> {
        if v["version"].as_u64()? != 1 {
            return None;
        }
        let nx = usize::try_from(v["nx"].as_u64()?).ok()?;
        let ny = usize::try_from(v["ny"].as_u64()?).ok()?;
        if nx == 0 || nx > MAX_GRID_COLUMNS || ny != GRID_THICKNESS_ROWS {
            return None;
        }
        let bounds = Bounds {
            min_x: v["bounds"]["minX"].as_f64()?,
            max_x: v["bounds"]["maxX"].as_f64()?,
            min_y: v["bounds"]["minY"].as_f64()?,
            max_y: v["bounds"]["maxY"].as_f64()?,
        };
        if ![bounds.min_x, bounds.max_x, bounds.min_y, bounds.max_y]
            .iter()
            .all(|x| x.is_finite())
            || bounds.max_x <= bounds.min_x
            || bounds.max_y <= bounds.min_y
        {
            return None;
        }
        if nx != Self::new(bounds).nx {
            return None;
        }
        let encoded = v["bits"].as_str()?.as_bytes();
        let bytes = (nx * ny).div_ceil(8);
        if encoded.len() != bytes * 2 {
            return None;
        }
        let mut bits = vec![0; (nx * ny).div_ceil(64)];
        fn digit(c: u8) -> Option<u8> {
            match c {
                b'0'..=b'9' => Some(c - b'0'),
                b'a'..=b'f' => Some(c - b'a' + 10),
                _ => None,
            }
        }
        for (i, pair) in encoded.chunks_exact(2).enumerate() {
            let byte = digit(pair[0])? * 16 + digit(pair[1])?;
            bits[i / 8] |= u64::from(byte) << ((i % 8) * 8);
        }
        // Unused bits are canonical zero in cold and hot projections.
        if nx * ny % 64 != 0 {
            let last = bits.len() - 1;
            bits[last] &= (1u64 << (nx * ny % 64)) - 1;
        }
        Some(Self {
            bounds,
            nx,
            ny,
            bits,
        })
    }
    pub fn to_value(&self) -> Value {
        let alphabet = b"0123456789abcdef";
        let mut encoded = String::with_capacity((self.nx * self.ny).div_ceil(8) * 2);
        for i in 0..(self.nx * self.ny).div_ceil(8) {
            let mut byte = (self.bits[i / 8] >> ((i % 8) * 8)) as u8;
            if i + 1 == (self.nx * self.ny).div_ceil(8) && self.nx * self.ny % 8 != 0 {
                byte &= (1 << (self.nx * self.ny % 8)) - 1;
            }
            encoded.push(alphabet[(byte >> 4) as usize] as char);
            encoded.push(alphabet[(byte & 15) as usize] as char);
        }
        json!({"version":1,"nx":self.nx,"ny":self.ny,"bounds":{
            "minX":self.bounds.min_x,"maxX":self.bounds.max_x,
            "minY":self.bounds.min_y,"maxY":self.bounds.max_y},"bits":encoded})
    }
    /// The cells as they are kept, sixty-four to a word.
    pub fn words(&self) -> &[u64] {
        &self.bits
    }
    pub fn occupied(&self, x: usize, y: usize) -> bool {
        if x >= self.nx || y >= self.ny {
            return false;
        }
        let i = y * self.nx + x;
        self.bits[i / 64] & (1u64 << (i % 64)) != 0
    }
    pub fn clear_cell(&mut self, x: usize, y: usize) -> bool {
        if !self.occupied(x, y) {
            return false;
        }
        let i = y * self.nx + x;
        self.bits[i / 64] &= !(1u64 << (i % 64));
        true
    }
    pub fn cell_bounds(&self, x: usize, y: usize) -> Bounds {
        let dx = (self.bounds.max_x - self.bounds.min_x) / self.nx as f64;
        let dy = (self.bounds.max_y - self.bounds.min_y) / self.ny as f64;
        Bounds {
            min_x: self.bounds.min_x + x as f64 * dx,
            max_x: if x + 1 == self.nx {
                self.bounds.max_x
            } else {
                self.bounds.min_x + (x + 1) as f64 * dx
            },
            min_y: self.bounds.min_y + y as f64 * dy,
            max_y: if y + 1 == self.ny {
                self.bounds.max_y
            } else {
                self.bounds.min_y + (y + 1) as f64 * dy
            },
        }
    }
    pub fn contains(&self, p: Point) -> bool {
        if p.x < self.bounds.min_x
            || p.x > self.bounds.max_x
            || p.y < self.bounds.min_y
            || p.y > self.bounds.max_y
        {
            return false;
        }
        let x = (((p.x - self.bounds.min_x) / (self.bounds.max_x - self.bounds.min_x)
            * self.nx as f64)
            .floor() as usize)
            .min(self.nx - 1);
        let y = (((p.y - self.bounds.min_y) / (self.bounds.max_y - self.bounds.min_y)
            * self.ny as f64)
            .floor() as usize)
            .min(self.ny - 1);
        self.occupied(x, y)
    }
    pub fn remaining_thickness(&self, x: usize) -> f64 {
        (0..self.ny).filter(|&y| self.occupied(x, y)).count() as f64
            * (self.bounds.max_y - self.bounds.min_y)
            / self.ny as f64
    }
    /// Grid DDA visits at most nx+ny+2 cells regardless of shot history.
    pub fn intervals(&self, a: Point, b: Point, visit: &mut impl FnMut(RayInterval)) {
        let Some(outer) = region_interval(a, b, self.bounds) else {
            return;
        };
        let mut t = outer.enter.max(0.0);
        let end = outer.exit.min(1.0);
        if end - t <= 1e-12 {
            return;
        }
        let (dx, dy) = (b.x - a.x, b.y - a.y);
        let cell_x = (self.bounds.max_x - self.bounds.min_x) / self.nx as f64;
        let cell_y = (self.bounds.max_y - self.bounds.min_y) / self.ny as f64;
        let at = a.lerp(b, t);
        let index = |p: f64, min: f64, step: f64, n: usize, direction: f64| {
            let f = ((p - min) / step).clamp(0.0, n as f64);
            let mut i = f.floor() as isize;
            if direction < 0.0 && f == i as f64 {
                i -= 1;
            }
            i.clamp(0, n as isize - 1)
        };
        let mut x = index(at.x, self.bounds.min_x, cell_x, self.nx, dx);
        let mut y = index(at.y, self.bounds.min_y, cell_y, self.ny, dy);
        let sx = if dx > 0.0 { 1 } else { -1 };
        let sy = if dy > 0.0 { 1 } else { -1 };
        let next_x = |x: isize| {
            if dx.abs() < 1e-15 {
                f64::INFINITY
            } else {
                (self.bounds.min_x + (x + if sx > 0 { 1 } else { 0 }) as f64 * cell_x - a.x) / dx
            }
        };
        let next_y = |y: isize| {
            if dy.abs() < 1e-15 {
                f64::INFINITY
            } else {
                (self.bounds.min_y + (y + if sy > 0 { 1 } else { 0 }) as f64 * cell_y - a.y) / dy
            }
        };
        let mut normal = outer.normal;
        let mut run: Option<RayInterval> = None;
        for _ in 0..self.nx + self.ny + 2 {
            if x < 0 || y < 0 || x >= self.nx as isize || y >= self.ny as isize {
                break;
            }
            let (tx, ty) = (next_x(x), next_y(y));
            let next = tx.min(ty).min(end).max(t);
            if self.occupied(x as usize, y as usize) && next > t + 1e-12 {
                if let Some(hit) = &mut run {
                    hit.exit = next;
                } else {
                    run = Some(RayInterval {
                        enter: t,
                        exit: next,
                        normal,
                    });
                }
            } else if let Some(hit) = run.take() {
                visit(hit);
            }
            if next >= end - 1e-12 {
                break;
            }
            if tx <= ty + 1e-12 {
                x += sx;
                normal = Point::new(-(sx as f64), 0.0);
            }
            if ty <= tx + 1e-12 {
                y += sy;
                if ty < tx {
                    normal = Point::new(0.0, -(sy as f64));
                }
            }
            t = next;
        }
        if let Some(hit) = run {
            visit(hit);
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct EntityGeometry {
    pub owner: u32,
    pub actor: u32,
    pub kind: EntityKind,
    pub pose: Pose,
    pub barrel_angle: Option<f64>,
    /// Explicit material role: an exposed mount's post alone stays on its face.
    pub post: bool,
    pub polygons: Vec<Polygon>,
    pub grid: Option<Arc<MaterialGrid>>,
    /// The wave that runs through it, if one does: light through glass, a radar's through fibreglass.
    /// Every other line meets it.
    pub clear_to: Option<crate::game_damage::Wave>,
    /// Whether the line of a sensor passes beside it, whatever its wave: a sensor stands on a roof as deep as it is,
    /// a share of the width of its construction, and what looks across that roof looks past it. A round meets it.
    pub aside: bool,
    /// Whether a round passes between it: the skids of an aircraft, a tube at either side of its body, which a round
    /// along the middle of it flies between, as one from a gun hung under its hull. A sensor's line passes as well: a
    /// camera hung there sees out between them, and one outside looks past them.
    pub between: bool,
}
/// Whether the plate of this id, as a field names it (`actor:chassis:skid-0`), is of the skids of an aircraft: its runner
/// or a leg (game_chassis.rs).
pub fn skid(id: &str) -> bool {
    let mut parts = id.rsplit(':');
    matches!((parts.next(), parts.next()), (Some(last), Some("chassis")) if last.starts_with("skid-") || last.starts_with("leg-"))
}
/// Posts and integrated feet stay fixed. The receiver, tube and mask follow aim.
pub fn material_pose(pose: Pose, barrel_angle: Option<f64>, role: usize, post: bool) -> Pose {
    if barrel_angle.is_some() && !crate::game_mounts::role(post,role).fixed() {
        Pose { angle: barrel_angle.unwrap(), ..pose }
    } else { pose }
}
/// Whether the first solid of a gun is the post of an exposed mount: what it carries on it reaches back past its
/// trunnion, where nothing of an enclosed mount does (game_mounts.rs `carries`).
impl EntityGeometry {
    pub fn from_plate(plate: &crate::game_damage::Plate) -> Self {
        Self {owner:plate.owner,actor:plate.actor,kind:EntityKind::Plate,pose:plate.pose,
            barrel_angle:None,post:false,polygons:plate.indices.chunks_exact(3).map(|t|
                t.iter().map(|i|plate.local_nodes[*i as usize]).collect()).collect(),
            grid:Some(plate.grid.clone()),clear_to:plate.material.clear_to(),aside:false,
            between:plate.cold["definition"]["id"].as_str().is_some_and(skid)}
    }
    pub fn from_module(module: &crate::game_damage::Module) -> Self {
        Self {owner:module.owner,actor:module.actor,kind:EntityKind::Module,pose:module.pose,
            barrel_angle:(module.kind==ComponentKind::Weapon).then_some(module.barrel_angle),
            post:module.mount.as_ref().is_some_and(|m|m.exposed),polygons:module.local_polygons(),grid:None,
            clear_to:module.metal().material().clear_to(),aside:module.kind==ComponentKind::Sensor,between:false}
    }
}
#[derive(Clone, Copy, Debug, Default)]
pub struct RayOptions<'a> {
    /// Rounds pass through the drawn tube. Placement, sensors and mechanism
    /// clearance continue to query the complete finite shape.
    pub projectile: bool,
    pub ignore_ids: &'a [u32],
    /// Only the connected material containing the origin was already paid.
    /// Other regions of these owners remain ordinary material in this ray.
    pub paid_initial: &'a [u32],
    pub ignore_actors: &'a [u32],
    pub only_actor: Option<u32>,
    pub complete_exit: bool,
    /// The wave the line is, if it is one: what that wave runs through is not in its way, nor a sensor it passes
    /// beside (`EntityGeometry::aside`).
    pub wave: Option<crate::game_damage::Wave>,
}
impl RayOptions<'_> {
    fn ignores_actor(&self, actor: u32) -> bool {
        self.only_actor.is_some_and(|only| only != actor) || self.ignore_actors.contains(&actor)
    }
}
#[derive(Clone, Copy, Debug)]
pub struct RayHit {
    pub owner: u32,
    pub actor: u32,
    pub kind: EntityKind,
    pub enter: f64,
    pub exit: f64,
    pub normal: Point,
    pub point: Point,
    pub exit_point: Point,
    pub depth: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct RayInterval {
    pub enter: f64,
    pub exit: f64,
    pub normal: Point,
}
pub fn segment_convex(a: Point, b: Point, vertices: &[Point]) -> Option<RayInterval> {
    if vertices.len() < 3 {
        return None;
    }
    let sign = if signed_area(vertices) >= 0.0 {
        1.0
    } else {
        -1.0
    };
    let mut lo: f64 = 0.0;
    let mut hi: f64 = 1.0;
    let mut normal = Point::ZERO;
    let dx = b.x - a.x;
    let dy = b.y - a.y;
    for i in 0..vertices.len() {
        let p = vertices[i];
        let q = vertices[(i + 1) % vertices.len()];
        let ex = q.x - p.x;
        let ey = q.y - p.y;
        let d0 = sign * (ex * (a.y - p.y) - ey * (a.x - p.x));
        let dv = sign * (ex * dy - ey * dx);
        if dv.abs() < 1e-12 {
            if d0 < -1e-9 {
                return None;
            }
            continue;
        }
        let t = -d0 / dv;
        if dv > 0.0 {
            if t > lo {
                lo = t;
                let len = hypot(ex, ey).max(f64::MIN_POSITIVE);
                normal = Point::new(sign * ey / len, -sign * ex / len);
            }
        } else {
            hi = hi.min(t);
        }
        if lo > hi + 1e-10 {
            return None;
        }
    }
    if hi < 0.0 || lo > 1.0 {
        return None;
    }
    if normal == Point::ZERO {
        let len = hypot(dx, dy);
        normal = if len > 0.0 {
            Point::new(-dx / len, -dy / len)
        } else {
            Point::ZERO
        };
    }
    Some(RayInterval {
        enter: lo.clamp(0.0, 1.0),
        exit: hi.clamp(0.0, 1.0),
        normal,
    })
}
pub fn region_interval(a: Point, b: Point, box_: Bounds) -> Option<RayInterval> {
    let mut enter: f64 = 0.0;
    let mut exit: f64 = 1.0;
    let mut normal = Point::ZERO;
    for (axis, start, delta, low, high) in [
        (0, a.x, b.x - a.x, box_.min_x, box_.max_x),
        (1, a.y, b.y - a.y, box_.min_y, box_.max_y),
    ] {
        if delta.abs() < 1e-12 {
            if start < low - 1e-12 || start > high + 1e-12 {
                return None;
            }
            continue;
        }
        let u = (low - start) / delta;
        let v = (high - start) / delta;
        let lo = u.min(v);
        let hi = u.max(v);
        if lo > enter {
            enter = lo;
            normal = if axis == 0 {
                Point::new(-delta.signum(), 0.0)
            } else {
                Point::new(0.0, -delta.signum())
            };
        }
        exit = exit.min(hi);
        if exit - enter <= 1e-12 {
            return None;
        }
    }
    Some(RayInterval {
        enter,
        exit,
        normal,
    })
}
pub fn signed_area(poly: &[Point]) -> f64 {
    poly.iter()
        .enumerate()
        .map(|(i, p)| p.cross(poly[(i + 1) % poly.len()]))
        .sum::<f64>()
        / 2.0
}
#[derive(Clone, Debug)]
struct CachedEntity {
    entity: EntityGeometry,
    world: Vec<Polygon>,
    bounds: Bounds,
    polygon_bounds: Vec<Bounds>,
    /// Edges on the skin of an enclosed shield. Shared facet seams are not
    /// armour surfaces and cannot supply an impact normal.
    shield_edges: Vec<(usize,usize,f64)>,
    ray_padding: f64,
    c: f64,
    s: f64,
    active: bool,
}
impl CachedEntity {
    fn new(entity: EntityGeometry) -> Self {
        let ray_padding=entity.polygons.iter().map(|p|convex_ray_padding(p))
            .fold(1e-5,f64::max);
        let world = entity
            .polygons
            .iter()
            .map(|p| vec![Point::ZERO; p.len()])
            .collect();
        let mut shield_edges:Vec<(usize,usize,f64)>=Vec::new();
        if entity.barrel_angle.is_some() && !entity.post {
            for (role,polygon) in entity.polygons.iter().enumerate()
                .filter(|(i,_)|crate::game_mounts::role(entity.post,*i)==crate::game_mounts::Role::Shield) {
                let orientation=signed_area(polygon).signum();
                for edge in 0..polygon.len() {
                    let (a,b)=(polygon[edge],polygon[(edge+1)%polygon.len()]);
                    if let Some(at)=shield_edges.iter().position(|&(role,edge,_)|{
                        let other=&entity.polygons[role];other[edge]==b && other[(edge+1)%other.len()]==a
                    }) {shield_edges.remove(at);} else {shield_edges.push((role,edge,orientation));}
                }
            }
        }
        let mut cached = Self {
            entity,
            world,
            bounds: Bounds::empty(),
            polygon_bounds: Vec::new(),
            shield_edges,
            ray_padding,
            c: 1.0,
            s: 0.0,
            active: true,
        };
        cached.refresh();
        cached
    }
    fn shield_normal(&self,start:Point,end:Point,enter:f64)->Option<Point> {
        let at=start.lerp(end,enter);let direction=Point::new(end.x-start.x,end.y-start.y);
        let mut best=None;let mut facing=0.0;
        for &(role,edge,orientation) in &self.shield_edges {
            let polygon=&self.world[role];let (a,b)=(polygon[edge],polygon[(edge+1)%polygon.len()]);
            let along=Point::new(b.x-a.x,b.y-a.y);let length=along.distance(Point::ZERO);
            if length<=1e-12 {continue;}
            let offset=Point::new(at.x-a.x,at.y-a.y);
            let u=offset.dot(along)/(length*length);
            if !(-1e-7..=1.0+1e-7).contains(&u) || offset.cross(along).abs()>length*1e-7 {continue;}
            let normal=Point::new(orientation*along.y/length,-orientation*along.x/length);
            let against=-normal.dot(direction);
            if against>facing {facing=against;best=Some(normal);}
        }
        best
    }
    fn refresh(&mut self) {
        self.c = cos(self.entity.pose.angle);
        self.s = sin(self.entity.pose.angle);
        self.bounds = Bounds::empty();
        self.polygon_bounds.clear();
        let barrel_rotation = self.entity.barrel_angle.map(|angle| (cos(angle), sin(angle)));
        let post = self.entity.post;
        for (role, (local, world)) in self.entity.polygons.iter().zip(&mut self.world).enumerate() {
            let pose = material_pose(self.entity.pose, self.entity.barrel_angle, role, post);
            let (c, s) = if !crate::game_mounts::role(post,role).fixed() { barrel_rotation.unwrap_or((self.c, self.s)) }
                else { (self.c, self.s) };
            for (a, b) in local.iter().zip(world.iter_mut()) {
                *b = transform(*a, pose, c, s);
            }
            let bounds = Bounds::points(world);
            self.bounds.union(bounds);
            self.polygon_bounds.push(bounds);
        }
    }
    fn ignored(&self, options: &RayOptions) -> bool {
        let e = &self.entity;
        !self.active
            || options.ignores_actor(e.actor)
            || options.ignore_ids.contains(&e.owner)
            || options.wave.is_some() && (e.aside || e.between || e.clear_to == options.wave)
            || options.projectile && e.between
    }
    fn intervals(&self, start: Point, end: Point, projectile:bool, paid_initial:bool, out: &mut Vec<RayInterval>) {
        let from = out.len();
        let local_start = inverse(start, self.entity.pose, self.c, self.s);
        let local_end = inverse(end, self.entity.pose, self.c, self.s);
        for (role,(polygon, bounds)) in self.world.iter().zip(&self.polygon_bounds).enumerate() {
            if projectile && self.entity.barrel_angle.is_some() && role==1 {continue;}
            // This is only a conservative rejection. Preserve the original
            // convex/grid calculation, including its endpoint tolerances.
            if region_interval(start, end, bounds.padded(self.ray_padding)).is_none() {
                continue;
            }
            let Some(hit) = segment_convex(start, end, polygon) else {
                continue;
            };
            if hit.exit - hit.enter < 1e-10 {
                continue;
            }
            out.push(hit);
        }
        if let Some(grid) = &self.entity.grid {
            let raw_end = out.len();
            if raw_end > from {
                // Callers sort by entry. Nonempty clips of disjoint DDA regions cannot tie.
                // Polygon order, including equal entries, is kept within each region.
                grid.intervals(local_start, local_end, &mut |clipped| {
                    for i in from..raw_end {
                        let hit = out[i];
                        let enter = hit.enter.max(clipped.enter);
                        let exit = hit.exit.min(clipped.exit);
                        if exit - enter < 1e-10 {
                            continue;
                        }
                        let normal = if clipped.enter > hit.enter + 1e-10 {
                            Point::new(
                                self.c * clipped.normal.x - self.s * clipped.normal.y,
                                self.s * clipped.normal.x + self.c * clipped.normal.y,
                            )
                        } else {
                            hit.normal
                        };
                        out.push(RayInterval {
                            enter,
                            exit,
                            normal,
                        });
                    }
                });
                out.drain(from..raw_end);
            }
        }
        if paid_initial {
            out[from..].sort_by(|a,b|a.enter.total_cmp(&b.enter));
            // An entry materialized in world space can return a few ulps
            // outside its face after the inverse transform. Recognize that
            // same origin in metres, independent of the length of this ray.
            let roundoff = 16.0*f64::EPSILON*(1.0+start.x.abs()+start.y.abs()
                +self.entity.pose.x.abs()+self.entity.pose.y.abs());
            let length = start.distance(end);
            if let Some(first) = out.get(from).filter(|first|first.enter*length <= roundoff) {
                let (mut exit,mut paid) = (first.exit,1);
                for next in &out[from+1..] {
                    if next.enter > exit+1e-6 {break;}
                    exit=exit.max(next.exit);paid+=1;
                }
                out.drain(from..from+paid);
            }
        }
    }
}
#[derive(Clone, Debug, Default)]
pub struct Geometry {
    entities: Vec<Option<CachedEntity>>,
    /// Counts the changes that move or reshape an entity: what the index below is made of.
    placed: u64,
    /// Neighbouring owners of one actor under one box, and all of them under another:
    /// a ray far from every construction is turned away by a single comparison.
    runs: Vec<(usize, usize, Bounds)>,
    scene: Bounds,
    indexed: Option<u64>,
}
impl Geometry {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn upsert(&mut self, owner: u32, mut entity: EntityGeometry) {
        entity.owner = owner;
        if self.entities.len() <= owner as usize {
            self.entities.resize_with(owner as usize + 1, || None);
        }
        self.entities[owner as usize] = Some(CachedEntity::new(entity));
        self.placed += 1;
    }
    /// Groups the entities for the rays of this step. It visits them in the order
    /// a ray does, so a ray that uses the groups meets the same owners in the same order.
    pub fn index(&mut self) {
        if self.indexed == Some(self.placed) {
            return;
        }
        self.runs.clear();
        self.scene = Bounds::empty();
        let mut open: Option<(usize, u32, Bounds)> = None;
        for (i, e) in self.entities.iter().enumerate() {
            let Some(e) = e else { continue };
            let bounds = e.bounds.padded(e.ray_padding);
            match &mut open {
                Some((start, actor, run)) if *actor == e.entity.actor && i - *start < 48 => run.union(bounds),
                _ => {
                    if let Some((start, _, run)) = open.take() {
                        self.runs.push((start, i, run));
                    }
                    open = Some((i, e.entity.actor, bounds));
                }
            }
            self.scene.union(bounds);
        }
        if let Some((start, _, run)) = open {
            self.runs.push((start, self.entities.len(), run));
        }
        self.indexed = Some(self.placed);
    }
    /// Whether the groups are of where the entities stand now.
    #[cfg(test)]
    pub fn grouped(&self) -> bool {
        self.indexed == Some(self.placed)
    }
    pub fn remove(&mut self, owner: u32) {
        let Some(e) = self.entities.get_mut(owner as usize) else {
            return;
        };
        let removed = e.take().is_some();
        if removed {
            self.placed += 1;
        }
    }
    pub fn shapes_world(&self, owner: u32) -> Option<&[Polygon]> {
        self.entities
            .get(owner as usize)?
            .as_ref()
            .map(|e| e.world.as_slice())
    }
    pub fn projectile_shapes_world(&self,owner:u32)->Option<impl Iterator<Item=&Polygon>> {
        let e=self.entities.get(owner as usize)?.as_ref()?;
        Some(e.world.iter().enumerate().filter(move |(role,_)|e.entity.barrel_angle.is_none() || *role!=1).map(|(_,p)|p))
    }
    pub fn bounds(&self, owner: u32) -> Option<Bounds> {
        Some(self.entities.get(owner as usize)?.as_ref()?.bounds)
    }
    pub fn set_active(&mut self, owner: u32, active: bool) {
        let Some(Some(e)) = self.entities.get_mut(owner as usize) else {
            return;
        };
        e.active = active;
    }
    pub fn set_pose(&mut self, owner: u32, pose: Pose, barrel_angle: Option<f64>) {
        let Some(Some(e)) = self.entities.get_mut(owner as usize) else {
            return;
        };
        if e.entity.pose != pose || e.entity.barrel_angle != barrel_angle {
            e.entity.pose = pose;
            e.entity.barrel_angle = barrel_angle;
            e.refresh();
            self.placed += 1;
        }
    }
    pub fn set_grid(&mut self, owner: u32, grid: &Arc<MaterialGrid>) {
        let Some(Some(e)) = self.entities.get_mut(owner as usize) else {
            return;
        };
        if e.entity
            .grid
            .as_ref()
            .is_none_or(|live| !Arc::ptr_eq(live, grid) && live.as_ref() != grid.as_ref())
        {
            e.entity.grid = Some(grid.clone());
        }
    }
    pub fn raycast(&self, start: Point, end: Point, options: &RayOptions) -> Option<RayHit> {
        let mut first = None;
        // The nearest owner; of two met at the same point, the one that comes first among the
        // owners, in whatever order the groups were looked into.
        self.owner_intervals(start, end, None, options, true, &mut |hit| {
            if first.as_ref().is_none_or(|h: &RayHit| hit.enter < h.enter || hit.enter == h.enter && hit.owner < h.owner) {
                first = Some(hit);
            }
            first.as_ref().unwrap().enter
        });
        first.map(|h| self.complete_contact(h, start, end, options))
    }
    /// Query one stable handle without constructing an ignore list or visiting
    /// unrelated entities. The same material-chord path is used by all queries.
    pub fn raycast_owner(&self, owner: u32, start: Point, end: Point) -> Option<RayHit> {
        let options = RayOptions {
            complete_exit: true,
            ..RayOptions::default()
        };
        let mut first = None;
        self.owner_intervals(start, end, Some(owner), &options, false, &mut |hit| {
            first = Some(hit);
            1.0
        });
        first.map(|hit| self.complete_contact(hit, start, end, &options))
    }
    pub fn raycast_layers(&self, start: Point, end: Point, options: &RayOptions) -> Vec<RayHit> {
        let mut out = Vec::new();
        self.raycast_layers_into(start, end, options, &mut out);
        out
    }
    pub fn raycast_layers_into(
        &self,
        start: Point,
        end: Point,
        options: &RayOptions,
        out: &mut Vec<RayHit>,
    ) {
        out.clear();
        self.owner_intervals(start, end, None, options, false, &mut |hit| {
            out.push(hit);
            1.0
        });
        out.sort_by(|a, b| a.enter.total_cmp(&b.enter));
        let mut consumed = options.ignore_ids.to_vec();
        out.retain_mut(|hit| {
            if consumed.contains(&hit.owner) {
                return false;
            }
            *hit = self.complete_contact(*hit, start, end, options);
            consumed.push(hit.owner);
            true
        });
    }
    fn owner_intervals(
        &self,
        start: Point,
        end: Point,
        only_owner: Option<u32>,
        options: &RayOptions,
        nearest_first: bool,
        visit: &mut impl FnMut(RayHit) -> f64,
    ) {
        let bounds = Bounds::points(&[start, end]).padded(1e-5);
        let mut hits = Vec::new();
        let mut limit = 1.0;
        let whole = [(0, self.entities.len(), bounds)];
        let one;
        // The groups of the index, while it stands; otherwise every entity, as one group.
        let runs: &[(usize, usize, Bounds)] = match only_owner {
            Some(owner) => {
                one = [(owner as usize, (owner as usize + 1).min(self.entities.len()), bounds)];
                if (owner as usize) < self.entities.len() { &one } else { &[] }
            }
            None if self.indexed == Some(self.placed) => {
                if !self.scene.overlaps(bounds) {
                    return;
                }
                &self.runs
            }
            None => &whole,
        };
        // What one entity puts in the way, shown to the visitor; the limit that stands after it.
        let mut each = |e: &CachedEntity, limit: f64| -> f64 {
            // The box first: the actors a ray passes through are looked for only among those near it.
            if !e.bounds.overlaps(bounds) || e.ignored(options) {
                return limit;
            }
            let Some(bound) = region_interval(start, end, e.bounds.padded(e.ray_padding)) else {
                return limit;
            };
            // A conservative lower bound can only discard a strictly later
            // owner. Keep equal entries and their stable owner ordering. Layer
            // queries return 1.0 and still use this exact same chord path.
            if bound.enter > limit + 1e-10 {
                return limit;
            }
            hits.clear();
            e.intervals(start, end, options.projectile, options.paid_initial.contains(&e.entity.owner), &mut hits);
            hits.sort_by(|a, b| a.enter.total_cmp(&b.enter));
            let Some(mut hit) = hits.first().copied() else {
                return limit;
            };
            for next in hits.iter().skip(1) {
                if next.enter > hit.exit + 1e-6 {
                    break;
                }
                hit.exit = hit.exit.max(next.exit);
            }
            if let Some(normal)=e.shield_normal(start,end,hit.enter) {hit.normal=normal;}
            visit(RayHit {
                owner: e.entity.owner,
                actor: e.entity.actor,
                kind: e.entity.kind,
                enter: hit.enter,
                exit: hit.exit,
                normal: hit.normal,
                point: Point::ZERO,
                exit_point: Point::ZERO,
                depth: 0.0,
            })
        };
        if nearest_first && only_owner.is_none() && self.indexed == Some(self.placed) {
            // The groups in the order the ray enters their boxes. The box of a group holds the
            // boxes of its entities, so a group the ray enters beyond the limit has nothing
            // before it, and neither has any group after that one.
            let mut order: Vec<(f64, usize)> = runs.iter().enumerate()
                .filter(|(_, run)| run.2.overlaps(bounds))
                // A fresh group holds one actor. Per-owner and wave exclusions still belong to each entity.
                .filter(|(_, run)| self.entities[run.0].as_ref().is_none_or(|e| !options.ignores_actor(e.entity.actor)))
                .filter_map(|(at, run)| region_interval(start, end, run.2).map(|bound| (bound.enter, at)))
                .collect();
            order.sort_by(|a, b| a.0.total_cmp(&b.0));
            for (enter, at) in order {
                if enter > limit + 1e-10 {
                    break;
                }
                for e in self.entities[runs[at].0..runs[at].1].iter().flatten() {
                    limit = each(e, limit);
                }
            }
            return;
        }
        for e in runs.iter().filter(|run| run.2.overlaps(bounds)).flat_map(|run| self.entities[run.0..run.1].iter().flatten()) {
            limit = each(e, limit);
        }
    }
    fn complete_contact(
        &self,
        mut hit: RayHit,
        start: Point,
        end: Point,
        options: &RayOptions,
    ) -> RayHit {
        let length = start.distance(end);
        if options.complete_exit && hit.exit >= 1.0 - 1e-8 && length > 1e-10 {
            if let Some(Some(e)) = self.entities.get(hit.owner as usize) {
                let ux = (end.x - start.x) / length;
                let uy = (end.y - start.y) / length;
                let mut reach = length;
                for b in &e.polygon_bounds {
                    reach = reach.max(
                        ((if ux >= 0.0 { b.max_x } else { b.min_x }) - start.x) * ux
                            + ((if uy >= 0.0 { b.max_y } else { b.min_y }) - start.y) * uy
                            + 0.006,
                    );
                }
                let mut hits = Vec::new();
                e.intervals(
                    start,
                    Point::new(start.x + ux * reach, start.y + uy * reach),
                    options.projectile,
                    options.paid_initial.contains(&e.entity.owner),
                    &mut hits,
                );
                hits.sort_by(|a, b| a.enter.total_cmp(&b.enter));
                if let Some(first) = hits.first() {
                    let mut exit = first.exit;
                    for next in hits.iter().skip(1) {
                        if next.enter > exit + 1e-6 / reach {
                            break;
                        }
                        exit = exit.max(next.exit);
                    }
                    hit.exit = exit * reach / length;
                }
            }
        }
        hit.point = start.lerp(end, hit.enter);
        hit.exit_point = start.lerp(end, hit.exit);
        hit.depth = length * (hit.exit - hit.enter);
        hit
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn the_belt_of_a_track_runs_up_from_its_last_road_wheels_to_the_idler_and_the_sprocket_raised_at_its_ends() {
        // The track of the heavy chassis, on eight road wheels, 0.88 m high, over the ground as the chassis lays it.
        let (width, height) = (ComponentKind::track_length(8.0) * 0.88 / 0.74, 0.88);
        let wheels = track_wheels(width, height);
        assert_eq!(wheels.road.len(), 8);
        let outline = component_polygon(ComponentKind::Track, width, height);
        // How low the track reaches at a place along it.
        let lowest = |x: f64| outline.iter().zip(outline.iter().cycle().skip(1))
            .filter(|(a, b)| (a.x - x) * (b.x - x) <= 0.0 && a.x != b.x)
            .map(|(a, b)| a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)).fold(f64::INFINITY, f64::min);
        let bottom = -height / 2.0;
        // It runs as far as its ends and as high as its top, and lies on the ground under all its road wheels.
        let (left, right) = outline.iter().fold((0.0_f64, 0.0_f64), |(l, r), p| (l.min(p.x), r.max(p.x)));
        assert!((right - width / 2.0).abs() < 1e-9 && (left + width / 2.0).abs() < 1e-9);
        assert!(outline.iter().all(|p| p.y >= bottom - 1e-9 && p.y <= height / 2.0 + 1e-9));
        for &x in &wheels.road {
            assert!((lowest(x) - bottom).abs() < 1e-9, "under the road wheel at {x}: {}", lowest(x));
        }
        // Past the last road wheel the belt runs up, ever further off the ground, to the idler at the end: its middle
        // 0.56 m over the foot of the belt, and the run up to it 0.23 m off the ground under it.
        let last = wheels.road[wheels.road.len() - 1];
        let rises = (0..=20).map(|i| lowest(last + (wheels.end.x - last) * i as f64 / 20.0)).collect::<Vec<_>>();
        assert!(rises.windows(2).all(|pair| pair[1] > pair[0]), "{rises:?}");
        assert!((wheels.end.y - bottom - 0.5632).abs() < 1e-4 && (wheels.end.x - (width / 2.0 - wheels.radius)).abs() < 1e-12);
        assert!((lowest(wheels.end.x) - bottom - 0.2268).abs() < 1e-4, "{}", lowest(wheels.end.x) - bottom);
    }
    #[test]
    fn ray_bounds_rejection_keeps_every_admitted_convex_interval() {
        // Property of the rejection itself: every nonzero interval accepted by
        // the original narrow phase must survive both cached bounding boxes.
        // The narrow phase is the oracle, so no copy of the engine is retained.
        let mut polygons = vec![rectangle(2.0, 0.005), rectangle(0.05, 0.002),
            rectangle(2.0,1e-5),
            component_polygon(ComponentKind::Wheel, 0.74, 0.74),
            component_polygon(ComponentKind::Track, 5.04, 0.74),
            vec![Point::new(-2.0,-0.0025),Point::new(2.0,-0.0025),Point::new(2.0,0.0025)],
            vec![Point::new(-2.0,-0.0025),Point::new(2.0,0.0025),Point::new(-2.0,0.0025)]];
        polygons.extend([rectangle(1.1,0.42),rectangle(0.035,0.12)]);
        let mut rng = crate::game_projectiles::Random::new(0x312cab);
        let mut accepted = 0;
        for angle in [0.0,0.25,-0.7,PI/2.0,PI,PI+0.25] {
            let entity = CachedEntity::new(EntityGeometry {owner:1,actor:1,kind:EntityKind::Module,
                pose:Pose{x:1_950.0,y:12.0,angle},barrel_angle:None,post:false,
                polygons:polygons.clone(),grid:None,clear_to:None,aside:false,between:false});
            for (polygon, bounds) in entity.world.iter().zip(&entity.polygon_bounds) {
                let center = Point::new((bounds.min_x+bounds.max_x)/2.0,(bounds.min_y+bounds.max_y)/2.0);
                for index in 0..3000 {
                    let dx=(rng.next()-0.5)*2000.0; let dy=(rng.next()-0.5)*2000.0;
                    let (a,b)=if index%3==0 {
                        (Point::new(center.x-dx,center.y-dy),Point::new(center.x+dx,center.y+dy))
                    } else {
                        let at=polygon[index%polygon.len()];
                        let epsilon=if index%3==1 {0.0} else {1e-8};
                        (Point::new(at.x-dx,at.y-dy+epsilon),Point::new(at.x+dx,at.y+dy+epsilon))
                    };
                    for (start,end) in [(a,b),(b,a)] {
                        if let Some(hit)=segment_convex(start,end,polygon) {
                            if hit.exit-hit.enter>=1e-10 {
                                accepted+=1;
                                assert!(region_interval(start,end,bounds.padded(entity.ray_padding)).is_some(),
                                    "polygon={polygon:?} ray={start:?}->{end:?} hit={hit:?}");
                                assert!(region_interval(start,end,entity.bounds.padded(entity.ray_padding)).is_some());
                                let bound=region_interval(start,end,entity.bounds.padded(entity.ray_padding)).unwrap();
                                assert!(bound.enter<=hit.enter+1e-10,
                                    "bound must remain below every narrow-phase entry: {bound:?} {hit:?}");
                            }
                        }
                    }
                }
                // Exact vertices, nearly parallel edge rays and point queries.
                for (i,p) in polygon.iter().enumerate() {
                    let q=polygon[(i+1)%polygon.len()];
                    for offset in [0.0,-1e-12,1e-12,-1e-8,1e-8] {
                        let start=Point::new(p.x,p.y+offset); let end=Point::new(q.x,q.y+offset);
                        for (start,end) in [(start,end),(end,start),(start,start)] {
                            if let Some(hit)=segment_convex(start,end,polygon) {
                                if hit.exit-hit.enter>=1e-10 {
                                    accepted+=1;
                                    assert!(region_interval(start,end,bounds.padded(entity.ray_padding)).is_some());
                                }
                            }
                        }
                    }
                }
            }
        }
        assert!(accepted>100_000,"the oracle must exercise many material intervals");
    }
    #[test]
    fn ray_bounds_do_not_change_cross_product_tolerance_for_a_thin_mantlet() {
        let thin=rectangle(2.0,1e-5);
        let a=Point::new(1.00005,-1.0);let b=Point::new(1.00005,1.0);
        let expected=segment_convex(a,b,&thin).unwrap();
        assert!(region_interval(a,b,Bounds::points(&thin).padded(1e-5)).is_none(),
            "a constant padding would reject material the current narrow phase accepts");
        // A disconnected second role makes the entity AABB overlap this ray,
        // as occurs for a mounted receiver, tube and thin mantlet.
        let other=rectangle(1.0,1.0).into_iter().map(|p|Point::new(p.x+2.0,p.y+3.0)).collect();
        let mut geometry=Geometry::new();geometry.upsert(1,EntityGeometry {
            owner:1,actor:1,kind:EntityKind::Module,pose:Pose::default(),barrel_angle:None,post:false,
            polygons:vec![thin,other],grid:None,clear_to:None,aside:false,between:false});
        let actual=geometry.raycast(a,b,&RayOptions::default()).unwrap();
        assert_eq!(actual.enter.to_bits(),expected.enter.to_bits());
        assert_eq!(actual.exit.to_bits(),expected.exit.to_bits());
        assert_eq!(actual.normal,expected.normal);
    }
    #[test]
    fn nearest_query_is_bit_exact_with_the_first_complete_layer() {
        let mut geometry=Geometry::new();
        for owner in 1..=96 {
            let mut e=plate(owner,((owner-1)/16) as f64*70.0);
            e.actor=(owner-1)/16+1;
            e.clear_to=match owner%9 {0=>Some(crate::game_damage::Wave::Light),1=>Some(crate::game_damage::Wave::Radio),_=>None};
            e.aside=owner%13==0;
            e.pose.y=((owner-1)%8) as f64*0.12;
            e.pose.angle=if owner%3==0 {0.25}else{0.0};
            e.polygons=if owner%4==0 {
                vec![component_polygon(ComponentKind::Wheel,0.74,0.74)]
            }else if owner%5==0 {
                vec![component_polygon(ComponentKind::Track,5.04,0.74)]
            }else {
                vec![rectangle(0.05+(owner%7) as f64*0.1,1.0)]
            };
            if owner%6==0 {e.polygons.push(rectangle(2.0,1e-5));}
            geometry.upsert(owner,e);
            if owner%7==0 {
                set_grid_regions(&mut geometry,owner,&[Bounds {
                    min_x:-4.0,max_x:4.0,min_y:0.1,max_y:0.5
                }]);
            }
        }
        // Two coincident owners exercise stable equal-entry selection.
        geometry.upsert(97,plate(97,-10.0));
        geometry.upsert(98,plate(98,-10.0));
        geometry.index();
        let mut rng=crate::game_projectiles::Random::new(0x16bcee);
        let signature=|hit:RayHit| (
            (hit.owner,hit.actor,hit.kind),
            [hit.enter,hit.exit,hit.normal.x,hit.normal.y,hit.point.x,hit.point.y,
                hit.exit_point.x,hit.exit_point.y,hit.depth].map(f64::to_bits)
        );
        for i in 0..1600 {
            let a=Point::new(rng.next()*430.0-30.0,rng.next()*2.0-0.5);
            let b=if i%4==0 {Point::new(a.x,a.y-2.0)}else {
                Point::new(rng.next()*430.0-30.0,rng.next()*2.0-0.5)
            };
            let options=RayOptions {complete_exit:i%2==0,
                wave:match i%3 {0=>Some(crate::game_damage::Wave::Light),1=>Some(crate::game_damage::Wave::Radio),_=>None},
                ignore_actors:if i%5==0{&[2]}else{&[]},
                only_actor:if i%7==0{Some(3)}else{None},
                ignore_ids:if i%3==0{&[1,17,98]}else{&[]},
                ..RayOptions::default()};
            for (start,end) in [(a,b),(b,a)] {
                let expected=geometry.raycast_layers(start,end,&options).first().copied();
                let actual=geometry.raycast(start,end,&options);
                assert_eq!(actual.map(signature),expected.map(signature),"{start:?}->{end:?}");
            }
        }
        let a=Point::new(-15.0,0.0);let b=Point::new(10.0,0.0);
        assert_eq!(geometry.raycast(a,b,&RayOptions::default()).unwrap().owner,97);
        assert_eq!(geometry.raycast_layers(a,b,&RayOptions::default()).iter()
            .filter(|h|matches!(h.owner,97|98)).map(|h|h.owner).collect::<Vec<_>>(),vec![97,98]);
    }
    #[test]
    fn the_index_of_a_step_turns_rays_away_without_changing_what_they_meet() {
        let field = |index: bool| {
            let mut geometry = Geometry::new();
            // Constructions of several plates each, far apart, with gaps in the handles.
            for owner in 1..400u32 {
                if owner % 11 == 0 { continue; }
                let actor = owner / 60;
                let mut entity = plate(owner, actor as f64 * 70.0 + (owner % 60) as f64 * 0.31);
                entity.actor = actor;
                entity.pose.y = (owner % 7) as f64 * 0.4;
                entity.pose.angle = owner as f64 * 0.37;
                geometry.upsert(owner, entity);
            }
            if index { geometry.index(); }
            geometry
        };
        let (plain, mut indexed) = (field(false), field(true));
        assert!(indexed.runs.len() >= 7 && indexed.runs.len() < 20, "about a group per construction: {}", indexed.runs.len());
        let signature = |hits: Vec<RayHit>| hits.into_iter().map(|hit| ((hit.owner, hit.actor),
            [hit.enter, hit.exit, hit.point.x, hit.point.y, hit.depth].map(f64::to_bits))).collect::<Vec<_>>();
        let mut rng = crate::game_projectiles::Random::new(0x1d3a);
        let mut compare = |plain: &Geometry, indexed: &Geometry| {
            let mut met = 0;
            for i in 0..3000 {
                let a = Point::new(rng.next() * 520.0 - 40.0, rng.next() * 8.0 - 2.0);
                let b = match i % 4 {
                    0 => Point::new(a.x + rng.next() * 3.0, a.y + 400.0 + rng.next() * 9000.0),
                    1 => Point::new(a.x + (rng.next() - 0.5) * 6.0, a.y + (rng.next() - 0.5) * 6.0),
                    _ => Point::new(rng.next() * 520.0 - 40.0, rng.next() * 8.0 - 2.0),
                };
                let a = if i % 9 == 0 { Point::new(a.x, a.y + 5000.0) } else { a };
                let options = RayOptions { complete_exit: i % 2 == 0, ignore_actors: if i % 5 == 0 { &[2] } else { &[] },
                    only_actor: if i % 7 == 0 { Some(3) } else { None }, ignore_ids: if i % 3 == 0 { &[1, 17, 98] } else { &[] },
                    ..RayOptions::default() };
                let expected = signature(plain.raycast_layers(a, b, &options));
                met += expected.len();
                assert_eq!(signature(indexed.raycast_layers(a, b, &options)), expected, "{a:?} -> {b:?}");
                assert_eq!(indexed.raycast(a, b, &options).map(|h| h.owner), plain.raycast(a, b, &options).map(|h| h.owner));
            }
            assert!(met > 500, "the rays met plates: {met}");
        };
        compare(&plain, &indexed);
        // A plate that moved leaves the index behind: rays go back to every entity until the next step makes it again.
        let (mut plain, moved) = (plain, Pose { x: 9000.0, y: 4.0, angle: 0.3 });
        plain.set_pose(5, moved, None);
        indexed.set_pose(5, moved, None);
        assert_ne!(indexed.indexed, Some(indexed.placed));
        let (a, b) = (Point::new(8990.0, 4.0), Point::new(9010.0, 4.0));
        assert_eq!(indexed.raycast(a, b, &RayOptions::default()).map(|h| h.owner), Some(5));
        compare(&plain, &indexed);
        indexed.index();
        assert_eq!(indexed.raycast(a, b, &RayOptions::default()).map(|h| h.owner), Some(5));
        compare(&plain, &indexed);
    }
    #[test]
    fn the_nearest_owner_is_the_same_whichever_group_is_looked_into_first() {
        let field = |index: bool| {
            let mut geometry = Geometry::new();
            // Constructions in a row, each a group of plates: a ray along the row crosses many of them.
            for owner in 1..640u32 {
                let actor = owner / 40;
                let mut entity = plate(owner, actor as f64 * 9.0 + (owner % 40) as f64 * 0.11);
                entity.actor = actor;
                entity.pose.y = (owner % 9) as f64 * 0.35;
                entity.pose.angle = owner as f64 * 0.53;
                geometry.upsert(owner, entity);
            }
            // Two plates of two constructions in one place. The second has a part above the row
            // besides, so a ray along the row enters its group before the group of the first.
            let (mut first, mut second) = (plate(700, -30.0), plate(701, -30.0));
            (first.actor, second.actor) = (50, 51);
            second.polygons.push(rectangle(1.0, 1.0).into_iter().map(|p| Point::new(p.x - 6.0, p.y + 5.0)).collect());
            geometry.upsert(700, first);
            geometry.upsert(701, second);
            if index { geometry.index(); }
            geometry
        };
        let (plain, indexed) = (field(false), field(true));
        let signature = |hit: RayHit| ((hit.owner, hit.actor, hit.kind),
            [hit.enter, hit.exit, hit.normal.x, hit.normal.y, hit.point.x, hit.point.y,
                hit.exit_point.x, hit.exit_point.y, hit.depth].map(f64::to_bits));
        let mut rng = crate::game_projectiles::Random::new(0x51e7);
        let mut met = 0;
        for i in 0..6000 {
            let a = Point::new(rng.next() * 220.0 - 50.0, rng.next() * 6.0 - 1.5);
            let b = if i % 3 == 0 { Point::new(a.x + (rng.next() - 0.5) * 8.0, a.y + (rng.next() - 0.5) * 8.0) }
                else { Point::new(rng.next() * 220.0 - 50.0, rng.next() * 6.0 - 1.5) };
            let options = RayOptions { complete_exit: i % 2 == 0, ignore_actors: if i % 5 == 0 { &[2, 7] } else { &[] },
                only_actor: if i % 11 == 0 { Some(3) } else { None }, ignore_ids: if i % 3 == 0 { &[1, 17, 98] } else { &[] },
                ..RayOptions::default() };
            for (start, end) in [(a, b), (b, a)] {
                let expected = plain.raycast(start, end, &options);
                met += expected.is_some() as usize;
                assert_eq!(indexed.raycast(start, end, &options).map(signature), expected.map(signature), "{start:?} -> {end:?}");
            }
        }
        assert!(met > 3000, "the rays met plates: {met}");
        for (a, b) in [(Point::new(-45.0, 0.0), Point::new(-20.0, 0.0)), (Point::new(-20.0, 0.0), Point::new(-45.0, 0.0))] {
            assert_eq!(plain.raycast(a, b, &RayOptions::default()).unwrap().owner, 700);
            assert_eq!(indexed.raycast(a, b, &RayOptions::default()).unwrap().owner, 700);
        }
    }
    #[test]
    fn indexed_actor_filters_keep_owner_wave_and_dirty_fallback_results() {
        let offset = 125_000.0;
        let mut plain = Geometry::new();
        // More than one group of one actor, with gaps between its owners.
        for owner in 1..=60 {
            if matches!(owner, 8 | 36) { continue; }
            let mut entity = plate(owner, offset + owner as f64 * 2.5);
            if owner == 1 { entity.clear_to = Some(crate::game_damage::Wave::Light); }
            plain.upsert(owner, entity);
        }
        for owner in 80..=83 {
            let mut entity = plate(owner, offset + 180.0 + (owner - 80) as f64 * 0.25);
            entity.actor = 2;
            plain.upsert(owner, entity);
        }
        let mut tied = plate(90, offset + 180.0);
        tied.actor = 3;
        plain.upsert(90, tied);
        let mut indexed = plain.clone();
        indexed.index();
        assert!(indexed.runs.iter().filter(|run| indexed.entities[run.0].as_ref().unwrap().entity.actor == 1).count() > 1);
        let (a, b) = (Point::new(offset - 5.0, 0.0), Point::new(offset + 205.0, 0.0));
        assert_eq!(indexed.raycast(a, b, &RayOptions { ignore_ids: &[1], ..RayOptions::default() }).unwrap().owner, 2);
        assert_eq!(indexed.raycast(a, b, &RayOptions { wave: Some(crate::game_damage::Wave::Light), ..RayOptions::default() }).unwrap().owner, 2);
        assert_eq!(indexed.raycast(a, b, &RayOptions { ignore_actors: &[1], ..RayOptions::default() }).unwrap().owner, 80);
        assert_eq!(indexed.raycast(a, b, &RayOptions { only_actor: Some(3), ..RayOptions::default() }).unwrap().owner, 90);
        let signature = |hit: RayHit| ((hit.owner, hit.actor, hit.kind),
            [hit.enter, hit.exit, hit.normal.x, hit.normal.y, hit.point.x, hit.point.y,
                hit.exit_point.x, hit.exit_point.y, hit.depth].map(f64::to_bits));
        let compare = |plain: &Geometry, indexed: &Geometry| {
            for options in [
                RayOptions::default(),
                RayOptions { ignore_actors: &[1], ..RayOptions::default() },
                RayOptions { ignore_actors: &[1, 2], ..RayOptions::default() },
                RayOptions { only_actor: Some(1), ..RayOptions::default() },
                RayOptions { only_actor: Some(2), ..RayOptions::default() },
                RayOptions { only_actor: Some(1), ignore_actors: &[1], ..RayOptions::default() },
                RayOptions { ignore_ids: &[1, 49, 80], ..RayOptions::default() },
                RayOptions { wave: Some(crate::game_damage::Wave::Light), complete_exit: true, ..RayOptions::default() },
            ] {
                for (start, end) in [(a, b), (b, a)] {
                    let expected = plain.raycast(start, end, &options).map(&signature);
                    assert_eq!(indexed.raycast(start, end, &options).map(&signature), expected, "{start:?} -> {end:?}: {options:?}");
                }
            }
        };
        compare(&plain, &indexed);
        // Removing the first owner invalidates the groups, including their old first entity.
        plain.remove(1);
        indexed.remove(1);
        assert!(!indexed.grouped());
        compare(&plain, &indexed);
        indexed.index();
        compare(&plain, &indexed);
        let moved = Pose { x: offset - 2.0, y: 0.0, angle: 0.0 };
        plain.set_pose(60, moved, None);
        indexed.set_pose(60, moved, None);
        assert!(!indexed.grouped());
        compare(&plain, &indexed);
        indexed.index();
        assert_eq!(indexed.raycast(a, b, &RayOptions::default()).unwrap().owner, 60);
        compare(&plain, &indexed);
    }
    fn plate(owner: u32, x: f64) -> EntityGeometry {
        EntityGeometry {
            owner,
            actor: 1,
            kind: EntityKind::Plate,
            barrel_angle: None,post:false,
            pose: Pose {
                x,
                y: 0.0,
                angle: 0.0,
            },
            polygons: vec![rectangle(2.0, 1.0)],
            grid: None,
            clear_to: None,
            aside: false,
            between: false,
        }
    }
    fn set_grid_regions(g: &mut Geometry, owner: u32, regions: &[Bounds]) {
        let polygons = &g.entities[owner as usize].as_ref().unwrap().entity.polygons;
        let points: Vec<_> = polygons.iter().flatten().copied().collect();
        let mut grid=MaterialGrid::new(Bounds::points(&points));
        for y in 0..grid.ny {for x in 0..grid.nx {
            let b=grid.cell_bounds(x,y);let p=Point::new((b.min_x+b.max_x)/2.0,(b.min_y+b.max_y)/2.0);
            if !regions.iter().any(|r|p.x>=r.min_x && p.x<=r.max_x && p.y>=r.min_y && p.y<=r.max_y) {grid.clear_cell(x,y);}
        }}
        let grid=Arc::new(grid);
        g.set_grid(owner, &grid);
    }
    #[test]
    fn mounted_material_turns_with_the_barrel_while_bases_and_posts_keep_the_host_frame() {
        // Admission supplies the current weapon and mounting dimensions and materials.
        let gun=|exposed:bool|json!({"kind":"weapon","weaponPreset":if exposed {"m2hb"}else{"rh120"},
            "x":0,"y":0,"angle":0,"barrelAngle":0,
            "weaponMount":{"preset":if exposed {"pintle"}else{"heavy-trunnion"}}});
        let enclosed=gun(false);
        let entity=crate::game_damage::fixtures::geometry(1,1,EntityKind::Module,&enclosed).unwrap();
        let material=entity.polygons.clone();let mut g=Geometry::new();g.upsert(1,entity);
        assert!(material.len()>4,"the enclosed mount has a receiver, tube, fixed feet and curved shield");
        for elevation in [-0.6,0.0,0.6] {
            g.set_pose(1,Pose::default(),Some(elevation));
            // The receiver, tube and shield follow the barrel; both feet keep the host pose.
            let laid=Pose{angle:elevation,..Pose::default()};
            for (role,polygon) in material.iter().enumerate() {
                let at=if matches!(role,2|3) {Pose::default()}else{laid};
                assert_eq!(g.shapes_world(1).unwrap()[role],polygon.iter().map(|p|at.world_point(*p)).collect::<Vec<_>>());
            }
            assert!(g.raycast_owner(1,laid.world_point(Point::new(-1.0,-0.15)),laid.world_point(Point::new(-1.0,0.15))).is_some());
            assert!(g.raycast_owner(1,laid.world_point(Point::new(0.8,-0.2)),laid.world_point(Point::new(0.8,0.2))).is_some());
            // Where the breech stood with the barrel level there is nothing of it with the barrel laid away.
            assert_eq!(g.raycast_owner(1,Point::new(-0.8,-0.2),Point::new(-0.8,0.2)).is_some(),elevation==0.0,"{elevation}");
        }
        for host_angle in [0.25,PI+0.25] {
            let pose=Pose{x:5.0,y:3.0,angle:host_angle};
            g.set_pose(1,pose,Some(host_angle+0.6));
            let laid=Pose{angle:host_angle+0.6,..pose};
            for (role,polygon) in material.iter().enumerate() {
                let at=if matches!(role,2|3) {pose}else{laid};
                assert_eq!(g.shapes_world(1).unwrap()[role],polygon.iter().map(|p|at.world_point(*p)).collect::<Vec<_>>());
            }
        }
        // A current exposed M2 mount keeps its post on the host however the gun is laid.
        let exposed=gun(true);
        let entity=crate::game_damage::fixtures::geometry(2,1,EntityKind::Module,&exposed).unwrap();
        let post=entity.polygons[0].clone();g.upsert(2,entity);
        for elevation in [-0.6,0.6] {
            g.set_pose(2,Pose::default(),Some(elevation));
            assert_eq!(g.shapes_world(2).unwrap()[0],post);
        }
    }
    #[test]
    fn fixed_grid_is_bounded_and_cold_round_trip_is_lossless_even_when_empty() {
        let bounds = Bounds {
            min_x: -500.0,
            max_x: 500.0,
            min_y: -0.0025,
            max_y: 0.0025,
        };
        let mut grid = MaterialGrid::new(bounds);
        assert_eq!(grid.nx * grid.ny, MAX_GRID_CELLS);
        assert_eq!(grid.to_value()["bits"].as_str().unwrap().len(), 1024);
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                assert!(grid.clear_cell(x, y));
            }
        }
        let saved = grid.to_value();
        assert_eq!(MaterialGrid::from_value(&saved).unwrap(), grid);
        assert!(!grid.contains(Point::ZERO));
        let mut intervals = Vec::new();
        grid.intervals(Point::new(0.0, -1.0), Point::new(0.0, 1.0), &mut |h| {
            intervals.push(h)
        });
        assert!(intervals.is_empty());
        let mut invalid = saved.clone();
        invalid["nx"] = json!(257);
        assert!(MaterialGrid::from_value(&invalid).is_none());
        invalid = saved;
        invalid["bits"] = json!("00");
        assert!(MaterialGrid::from_value(&invalid).is_none());
    }
    #[test]
    fn grid_dda_preserves_five_millimeter_cover_and_remaining_thickness_in_both_directions() {
        let bounds = Bounds {
            min_x: -1.0,
            max_x: 1.0,
            min_y: -0.0025,
            max_y: 0.0025,
        };
        let mut grid = MaterialGrid::new(bounds);
        let x = grid.nx / 2;
        for count in 0..=16 {
            let expected = 0.005 * (16 - count) as f64 / 16.0;
            assert!((grid.remaining_thickness(x) - expected).abs() < 1e-14);
            for sign in [-1.0, 1.0] {
                let a = Point::new(0.001, -sign);
                let b = Point::new(0.001, sign);
                let mut material = 0.0;
                grid.intervals(a, b, &mut |hit| material += (hit.exit - hit.enter) * 2.0);
                assert!(
                    (material - expected).abs() < 1e-12,
                    "count={count} sign={sign} got={material}"
                );
            }
            if count < 16 {
                grid.clear_cell(x, count);
            }
        }
    }
    #[test]
    fn grid_dda_matches_exhaustive_occupied_cell_intervals_for_oblique_and_boundary_rays() {
        let mut grid = MaterialGrid::new(Bounds {
            min_x: -0.2,
            max_x: 0.2,
            min_y: -0.04,
            max_y: 0.04,
        });
        for y in 0..grid.ny {
            for x in 0..grid.nx {
                if (x + 3 * y) % 7 == 0 {
                    grid.clear_cell(x, y);
                }
            }
        }
        for (a, b) in [
            (Point::new(-1.0, -0.03), Point::new(1.0, 0.02)),
            (Point::new(1.0, 0.03), Point::new(-1.0, -0.02)),
            (Point::new(-1.0, 0.0), Point::new(1.0, 0.0)),
            (Point::new(0.0, -1.0), Point::new(0.0, 1.0)),
        ] {
            let mut dda = Vec::new();
            grid.intervals(a, b, &mut |h| dda.push(h));
            // Interior rays have one unambiguous cell on a boundary; exhaustive
            // quadrature is performed at interval midpoints to avoid double edges.
            for step in 0..1001 {
                let t = (step as f64 + 0.5) / 1001.0;
                let at = a.lerp(b, t);
                assert_eq!(
                    dda.iter().any(|h| t >= h.enter && t <= h.exit),
                    grid.contains(at),
                    "{a:?}->{b:?} t={t}"
                );
            }
        }
    }
    #[test]
    fn holes_affect_ccd_without_changing_outline() {
        let mut g = Geometry::new();
        g.upsert(3, plate(3, 0.0));
        let a = Point::new(-2.0, 0.0);
        let b = Point::new(2.0, 0.0);
        assert!((g.raycast(a, b, &RayOptions::default()).unwrap().depth - 2.0).abs() < 1e-10);
        set_grid_regions(
            &mut g,
            3,
            &[Bounds {
                min_x: -1.0,
                min_y: 0.1,
                max_x: 1.0,
                max_y: 0.5,
            }],
        );
        assert!(g.raycast(a, b, &RayOptions::default()).is_none());
        assert_eq!(g.shapes_world(3).unwrap()[0].len(), 4);
    }
    #[test]
    fn empty_material_regions_invalidate_the_material_cache() {
        let mut g = Geometry::new();
        g.upsert(3, plate(3, 0.0));
        let start = Point::new(-2.0, 0.0);
        let end = Point::new(2.0, 0.0);
        assert!(g.raycast(start, end, &RayOptions::default()).is_some());
        set_grid_regions(&mut g, 3, &[]);
        assert!(
            g.raycast(
                Point::new(-2.0, 0.0),
                Point::new(2.0, 0.0),
                &RayOptions::default()
            )
            .is_none()
        );
        set_grid_regions(&mut g, 3, &[]);
        assert!(g.raycast(start, end, &RayOptions::default()).is_none());
    }
    #[test]
    fn complete_exit_stops_at_first_connected_region() {
        let mut g = Geometry::new();
        g.upsert(1, plate(1, 0.0));
        set_grid_regions(
            &mut g,
            1,
            &[
                Bounds {
                    min_x: -1.0,
                    min_y: -0.5,
                    max_x: -0.2,
                    max_y: 0.5,
                },
                Bounds {
                    min_x: 0.2,
                    min_y: -0.5,
                    max_x: 1.0,
                    max_y: 0.5,
                },
            ],
        );
        let hit = g
            .raycast(
                Point::new(-2.0, 0.0),
                Point::new(-0.8, 0.0),
                &RayOptions {
                    complete_exit: true,
                    ..Default::default()
                },
            )
            .unwrap();
        assert!((hit.exit_point.x + 0.2).abs() < 1e-9);
    }
    #[test]
    fn triangulated_material_keeps_complete_hits_holes_and_paid_regions() {
        let signature=|hit:RayHit|((hit.owner,hit.actor,hit.kind),[
            hit.enter,hit.exit,hit.normal.x,hit.normal.y,hit.point.x,hit.point.y,
            hit.exit_point.x,hit.exit_point.y,hit.depth].map(f64::to_bits));
        for origin in [0.0,125000.0] {
            let mut whole=Geometry::new();
            whole.upsert(7,plate(7,origin));
            // Two separated material regions, with a hole through the first.
            set_grid_regions(&mut whole,7,&[
                Bounds{min_x:-1.0,max_x:-0.25,min_y:-0.5,max_y:-0.125},
                Bounds{min_x:-1.0,max_x:-0.25,min_y:0.125,max_y:0.5},
                Bounds{min_x:-1.0,max_x:-0.75,min_y:-0.125,max_y:0.125},
                Bounds{min_x:-0.5,max_x:-0.25,min_y:-0.125,max_y:0.125},
                Bounds{min_x:0.25,max_x:1.0,min_y:-0.5,max_y:0.5},
            ]);
            let mut mesh=whole.clone();
            let mut entity=whole.entities[7].as_ref().unwrap().entity.clone();
            let corners=rectangle(2.0,1.0);
            entity.polygons=(0..4).map(|i|vec![corners[i],corners[(i+1)%4],Point::ZERO]).collect();
            mesh.upsert(7,entity);
            whole.index();mesh.index();
            let world=|p:Point|Point::new(origin+p.x,p.y);
            let paid=[7];
            for (a,b,paid_initial,complete_exit) in [
                (Point::new(-2.0,0.0),Point::new(2.0,0.0),false,false),
                (Point::new(2.0,0.0),Point::new(-2.0,0.0),false,false),
                (Point::new(-2.0,-0.375),Point::new(2.0,0.375),false,false),
                (Point::new(-0.5,-1.0),Point::new(-0.5,1.0),false,false),
                (Point::new(-0.9,0.0),Point::new(2.0,0.0),true,false),
                (Point::new(-2.0,-0.25),Point::new(-0.8,-0.25),false,true),
            ] {
                let options=RayOptions{paid_initial:if paid_initial {&paid}else{&[]},complete_exit,..Default::default()};
                let expected=whole.raycast(world(a),world(b),&options).unwrap();
                let actual=mesh.raycast(world(a),world(b),&options).unwrap();
                assert_eq!(signature(actual),signature(expected),"{origin}: {a:?}->{b:?}, paid={paid_initial}, complete={complete_exit}");
                if paid_initial {
                    assert!(actual.point.x>origin-0.75 && actual.point.x<origin-0.25,
                        "only the initial connected region was paid; the same owner is met beyond the hole");
                }
            }
            for (a,b) in [(Point::new(0.0,-1.0),Point::new(0.0,1.0)),
                (Point::new(-0.625,-0.0625),Point::new(-0.625,0.0625))] {
                for geometry in [&whole,&mesh] {
                    assert!(geometry.raycast(world(a),world(b),&RayOptions::default()).is_none(),
                        "neither the gap between regions nor the enclosed hole contains material");
                }
            }
        }
    }
    #[test]
    fn layered_query_preserves_owner_order_and_explicit_exclusion() {
        let mut g=Geometry::new();
        for owner in [4,5,6] {g.upsert(owner,plate(owner,0.0));}
        let query=|ignored:&[u32]|g.raycast_layers(Point::new(-3.0,0.0),Point::new(3.0,0.0),
            &RayOptions{ignore_ids:ignored,..RayOptions::default()}).iter().map(|h|h.owner).collect::<Vec<_>>();
        assert_eq!(query(&[]),vec![4,5,6]);assert_eq!(query(&[4]),vec![5,6]);
    }
    #[test]
    fn an_admitted_breech_follows_the_servo_angle() {
        let value=json!({"kind":"weapon","weaponPreset":"rh120","x":3.0,"y":2.0,"angle":0.0,"barrelAngle":0.6});
        let module=crate::game_damage::fixtures::module(1,1,&value);
        let mut geometry=Geometry::new();geometry.upsert(1,EntityGeometry::from_module(&module));
        let receiver=&geometry.shapes_world(1).unwrap()[0];
        let laid=Pose{x:3.0,y:2.0,angle:0.6};
        assert!(segment_convex(laid.world_point(Point::new(-0.44,0.0)),laid.world_point(Point::new(-0.44,0.0)),receiver).is_some());
        assert!(segment_convex(Point::new(2.56,2.0),Point::new(2.56,2.0),receiver).is_none());
        // Its material is laid with it: a scar halfway along the breech, near its top, stays there.
        let uv=module.material_uv(laid.world_point(Point::new(-0.5*module.width,0.4*module.height)));
        assert!((uv.x-0.5).abs()<1e-9 && (uv.y-0.1).abs()<1e-9,"{uv:?}");
    }
    #[test]
    fn a_line_of_sight_passes_beside_a_sensor_and_a_round_meets_it() {
        // A radar standing before an engine: the line of a camera or of a radar passes beside the radar and meets the
        // engine; a round meets the radar.
        let mut g=Geometry::new();
        for (owner,value) in [(1,json!({"kind":"sensor","sensorMode":"radar","x":0.0,"y":0.5,"width":1.0,"height":0.84})),
            (2,json!({"kind":"engine","x":2.0,"y":0.5,"width":1.0,"height":0.8}))] {
            g.upsert(owner,EntityGeometry::from_module(&crate::game_damage::fixtures::module(owner,1,&value)));
        }
        let first=|wave|g.raycast(Point::new(-2.0,0.5),Point::new(4.0,0.5),&RayOptions{wave,..RayOptions::default()}).map(|hit|hit.owner);
        assert_eq!(first(None),Some(1));
        for wave in [crate::game_damage::Wave::Light,crate::game_damage::Wave::Radio] {assert_eq!(first(Some(wave)),Some(2));}
    }
    fn installed_gear_geometry(owner:u32,kind:ComponentKind,x:f64,width:f64,height:f64,mass:f64)
        -> (crate::game_damage::Module,EntityGeometry) {
        let module=crate::game_damage::fixtures::module(owner,1,&json!({"kind":kind.name(),"x":x,"y":0.38,
            "width":width,"height":height,"physicalMass":mass}));
        let geometry=EntityGeometry::from_module(&module);(module,geometry)
    }
    #[test]
    fn experimental_tank_and_wheel_casings_keep_their_installation_frame() {
        let mut g = Geometry::new();
        // src/blueprints.js createBlueprint('vehicle'), before any damage.
        for (i, (x, y, length, angle, thickness)) in [
            (12.0, 0.70, 4.8, 0.0, 80.0),
            (12.05, 1.94, 4.45, 0.0, 65.0),
            (9.73, 1.31, 1.39, 1.19, 125.0),
            (14.35, 1.30, 1.22, PI / 2.0, 65.0),
            (12.07, 2.88, 2.22, 0.0, 70.0),
            (10.88, 2.42, 1.00, 1.35, 110.0),
            (13.22, 2.42, 0.92, PI / 2.0, 60.0),
        ]
        .into_iter()
        .enumerate()
        {
            let cold = json!({"x":x,"y":y,"length":length,"angle":angle,"thicknessMm":thickness,"widthM":2.6});
            g.upsert(
                i as u32 + 1,
                crate::game_damage::fixtures::geometry(i as u32 + 1, 1, EntityKind::Plate, &cold).unwrap(),
            );
        }
        let (track, contour) =
            installed_gear_geometry(30, ComponentKind::Track, 12.0, 5.04, 0.74, 2800.0);
        assert!((track.physical_mass - 2800.0).abs() < 1e-8);
        g.upsert(30, contour);
        let track_bounds = g.bounds(30).unwrap();
        assert!((track_bounds.min_x - 9.48).abs() < 1e-10);
        assert!((track_bounds.max_x - 14.52).abs() < 1e-10);
        let hit = g
            .raycast(
                Point::new(8.0, 0.38),
                Point::new(12.0, 0.38),
                &RayOptions::default(),
            )
            .unwrap();
        assert_eq!(hit.owner, 30);
        let roof = g
            .raycast(
                Point::new(12.5, 4.0),
                Point::new(12.5, 1.0),
                &RayOptions::default(),
            )
            .unwrap();
        assert_eq!(roof.owner, 5);
        let terrain = Terrain::new("flat").unwrap();
        let outline = component_polygon(ComponentKind::Track, 5.04, 0.74)
            .into_iter()
            .map(|p| track.pose.world_point(p))
            .collect::<Vec<_>>();
        // It stands on the ground from its first road wheel to its last.
        let support = terrain.support(&outline, 0.055, None, false).unwrap();
        let last = track_wheels(5.04, 0.74).road[6];
        assert!(support.min_x < 12.0 - last && support.max_x > 12.0 + last, "{} to {}", support.min_x, support.max_x);
        g.remove(30);
        for (owner, x) in [(31, 10.06), (32, 12.0), (33, 13.94)] {
            let (wheel, contour) =
                installed_gear_geometry(owner, ComponentKind::Wheel, x, 0.74, 0.74, 110.0);
            assert!((wheel.physical_mass - 110.0).abs() < 1e-8);
            g.upsert(owner, contour);
            let bounds = g.bounds(owner).unwrap();
            assert!((bounds.min_x - (x - 0.37)).abs() < 1e-10);
            assert!((bounds.min_y - 0.01).abs() < 1e-10);
        }
        let wheel = g
            .raycast(
                Point::new(8.0, 0.38),
                Point::new(12.0, 0.38),
                &RayOptions::default(),
            )
            .unwrap();
        assert_eq!(wheel.owner, 31);
    }
}
