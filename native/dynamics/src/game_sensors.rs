//! Gameplay perception. The mechanical state is borrowed at a decision boundary;
//! only measurements and their short-lived memory belong to this module.
use crate::game_damage::Wave;
use crate::game_geometry::{ComponentKind, Bounds, MaterialGrid, Point, Pose, atan2, cos, hypot, sin, sqrt};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet, VecDeque};
use std::f64::consts::{PI, TAU};
use std::sync::Arc;

/// Positive angles look below the horizon; negative angles see rising terrain.
pub const TERRAIN_DEGREES: [f64; 14] = [
    -5.0, -2.0, -0.5, 0.0, 1.0, 2.0, 3.0, 5.0, 8.0, 12.0, 20.0, 35.0, 60.0, 85.0,
];
pub const TERRAIN_RAY_COUNT: usize = TERRAIN_DEGREES.len() * 2;
pub const TERRAIN_MEMORY_SECONDS: f64 = 60.0;
pub const MEMORY_SECONDS: f64 = 2.0;
pub const TERRAIN_CAMERA_RANGE: f64 = 400.0;
pub const COMMAND_CAMERA_RANGE: f64 = 650.0;
/// How high over the ground under it an optic stands, in metres — over what its steepest line down meets —, to read
/// the ground along its panorama as far as it sees, its range, and not only as far as its terrain range: as low as an
/// aircraft flies (squad.js `FLIGHT_FLOOR`). From up there the ground lies far down every line of the panorama, and the
/// fog has it see what lies within its circle (ground-sight.js): what it reads of the ground is that ground.
pub const HIGH_OPTIC: f64 = 6.0;
/// How hard a construction may be expected to speed up, brake or turn about, in m/s²: what a track allows for
/// between two readings. Low, for a speed steady enough to lead a long flight by even when slow: a harder change
/// than this shows as a reading off the track, which starts it over (`RESTART`).
const MANOEUVRE: f64 = 1.0;
/// A track that has weighed this many readings and finds a new one farther off than both may be starts over from as
/// many: the construction changed its way.
const RESTART: f64 = 5.0;
fn exp(value: f64) -> f64 {
    ComplexField::exp(value)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum SensorMode {
    Visual,
    Radar,
    Sound,
}
impl SensorMode {
    fn config(self) -> (f64, f64, f64) {
        match self {
            Self::Visual => (4000.0, 0.1, 0.25),
            Self::Radar => (8000.0, 0.2, 0.75),
            Self::Sound => (1200.0, 0.5, 3.0),
        }
    }
    fn index(self) -> usize {
        match self {
            Self::Visual => 0,
            Self::Radar => 1,
            Self::Sound => 2,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Visual => "visual",
            Self::Radar => "radar",
            Self::Sound => "sound",
        }
    }
    pub fn from_name(name: &str) -> Self {
        match name {
            "radar" => Self::Radar,
            "sound" => Self::Sound,
            _ => Self::Visual,
        }
    }
    /// What it looks out with: a microphone hears round whatever construction stands in the way of a line.
    fn wave(self) -> Option<Wave> {
        match self {
            Self::Visual => Some(Wave::Light),
            Self::Radar => Some(Wave::Radio),
            Self::Sound => None,
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum SensorWeather {
    #[default]
    Clear,
    Haze,
    Mist,
}
impl SensorWeather {
    pub fn from_name(name: &str) -> Self {
        match name {
            "haze" => Self::Haze,
            "mist" => Self::Mist,
            _ => Self::Clear,
        }
    }
    // Optical attenuation/resolution only. Fog does not create wind or grant
    // radar and acoustic sensors an optical view of terrain.
    fn optical(self) -> (f64, f64, f64) {
        match self {
            Self::Clear => (1.0, 1.0, 1.0),
            Self::Haze => (0.8, 0.65, 2.0),
            Self::Mist => (0.45, 0.35, 3.0),
        }
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct VehicleReading {
    pub x: f64,
    pub y: f64,
    pub vx: f64,
    pub vy: f64,
    pub angle: f64,
    pub throttle: f64,
    pub engine: bool,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SensorActor {
    pub handle: u32,
    pub id: String,
    pub team: String,
    pub defeated: bool,
    pub facing: f64,
    pub x: f64,
    pub y: f64,
    pub shots: u64,
    pub bounds: Bounds,
    pub vehicle: Option<VehicleReading>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SensorModule {
    pub handle: u32,
    pub actor: u32,
    pub kind: ComponentKind,
    pub x: f64,
    pub y: f64,
    pub health: f64,
    pub attached: bool,
    pub detonated: bool,
    pub sensor_mode: SensorMode,
    pub range: f64,
    pub barrel_disabled: bool,
    pub reload: f64,
    // A pilot that brought the barrel to its heat limit waits for it to cool (`BarrelState::cooling`).
    pub cooling: bool,
    pub servo_max_speed: f64,
    pub muzzle_blocked: bool,
    /// How the piece is turned, and what of its own armour stands around it when it is an optic or a
    /// radar: none while nothing does.
    pub turn: f64,
    pub cover: Option<Arc<Cover>>,
}
impl Default for SensorModule {
    fn default() -> Self {
        Self {
            handle: 0,
            actor: 0,
            kind: ComponentKind::Sensor,
            x: 0.0,
            y: 0.0,
            health: 0.0,
            attached: true,
            detonated: false,
            sensor_mode: SensorMode::Visual,
            range: 0.0,
            barrel_disabled: false,
            reload: 0.0,
            cooling: false,
            servo_max_speed: 1.0,
            muzzle_blocked: false,
            turn: 0.0,
            cover: None,
        }
    }
}
impl SensorModule {
    pub fn active(&self) -> bool {
        self.health > 0.0 && self.attached && !self.detonated
    }
    /// What it looks out with, where its own armour may stand in the way: light for a camera and the
    /// sight of a command post, a radar's waves for a radar. A microphone and any other piece, nothing.
    pub fn wave(&self) -> Option<Wave> {
        match self.kind {
            ComponentKind::Command => Some(Wave::Light),
            ComponentKind::Sensor => self.sensor_mode.wave(),
            _ => None,
        }
    }
    /// The sensor this piece is while it works. An optic or a radar its own armour shuts in all around is none.
    fn camera(&self) -> Option<Camera> {
        if !self.active() || !matches!(self.kind, ComponentKind::Command | ComponentKind::Sensor) { return None; }
        let command = self.kind == ComponentKind::Command;
        let mode = if command { SensorMode::Visual } else { self.sensor_mode };
        let cover = self.cover.clone().filter(|_| mode.wave().is_some());
        if cover.as_ref().is_some_and(|cover| cover.sealed()) { return None; }
        let limited = self.range > 0.0 && self.range.is_finite();
        Some(Camera {
            handle: self.handle, origin: Point::new(self.x, self.y), mode, command,
            range: if command { COMMAND_CAMERA_RANGE } else if limited { self.range.min(mode.config().0) } else { mode.config().0 },
            identify_range: if command { 220.0 } else { 1500.0 },
            terrain_range: if command { 80.0 } else if limited { self.range.min(TERRAIN_CAMERA_RANGE) } else { TERRAIN_CAMERA_RANGE },
            precision: if command { 2.0 } else { 1.0 },
            turn: self.turn, cover,
        })
    }
    /// The eye this piece is: an optic that works and sees out to a side.
    pub fn eye(&self, weather: SensorWeather) -> Option<Eye> {
        let camera = self.camera().filter(|camera| camera.mode == SensorMode::Visual)?;
        let range = camera.range * weather.optical().0;
        let [left, right] = camera.sides().map(|open| if open { range } else { 0.0 });
        (left > 0.0 || right > 0.0).then_some(Eye { x: self.x, y: self.y, left, right })
    }
}
/// Where an optic of a construction stands and how far it sees out, level, to the left and to the right
/// of the field with the weather there is: nothing to a side its own armour hides from it.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Eye {
    pub x: f64,
    pub y: f64,
    pub left: f64,
    pub right: f64,
}
/// What a workshop is told of an optic or a radar of a design, standing level in clear weather, before it
/// is fielded: how far it reaches, nothing when its own armour shuts it in all around; the arcs that armour
/// hides from it, as angles of what is written, each from an angle to a greater one; how far it reaches out
/// level to the left of what is written and to the right; and the eye it is, if it is one.
#[derive(Clone, Debug, PartialEq)]
pub struct Outlook {
    pub range: f64,
    pub hidden: Vec<(f64, f64)>,
    pub left: f64,
    pub right: f64,
    pub eye: Option<Eye>,
}
/// The outlooks of the optics and the radars of a construction as it is written, each given by its kind,
/// its mode and how it stands, among the plates of the construction, each with the wave it lets through.
pub fn outlooks_as_written(sensors: &[(ComponentKind, SensorMode, Pose)], armour: &[(Option<Wave>, Armour)]) -> Vec<Outlook> {
    sensors.iter().map(|&(kind, sensor_mode, pose)| {
        let mut sensor = SensorModule { kind, sensor_mode, x: pose.x, y: pose.y, turn: pose.angle, health: 1.0, ..Default::default() };
        let wave = sensor.wave();
        let cover = Arc::new(Cover::around(pose, 0.0, armour.iter().filter(|(clear, _)| clear.is_none() || *clear != wave).map(|(_, plate)| plate)));
        let hidden = cover.hidden.iter().map(|arc| (arc.0 + pose.angle, arc.1 + pose.angle)).collect();
        sensor.cover = Some(cover);
        let camera = sensor.camera();
        let [left, right] = camera.as_ref().map_or([0.0; 2], |camera| camera.sides().map(|open| if open { camera.range } else { 0.0 }));
        Outlook { range: camera.map_or(0.0, |camera| camera.range), hidden, left, right, eye: sensor.eye(SensorWeather::Clear) }
    }).collect()
}
/// How far from level a line may run and still be a look out to a side. Two degrees either way is the
/// fan in which what stands on the same ground lies, from some way off to the end of a reach: a slit
/// that looks only down at the foot of its own hull, or up at the sky, is no look out.
const LEVEL: f64 = 2.0 * PI / 180.0;
/// Arcs this near are one: the pieces left of a plate leave no slit between them.
const SEAM: f64 = 1e-9;
/// An optic this deep in a plate is set in it.
const MOUNT: f64 = 0.001;
/// An angle within half a turn of nothing.
fn turned(angle: f64) -> f64 {
    angle - TAU * ((angle + PI) / TAU).floor()
}
/// One plate of the armour of a construction: where it stands, the box it was made as and what is left
/// of it, as a few rectangles of that box. Neighbouring columns worn alike are one rectangle.
pub struct Armour {
    pose: Pose,
    whole: Bounds,
    solid: Vec<Bounds>,
}
impl Armour {
    pub fn of(pose: Pose, grid: &MaterialGrid) -> Self {
        let mut solid = Vec::new();
        if grid.words().iter().map(|word| word.count_ones() as usize).sum::<usize>() == grid.nx * grid.ny {
            solid.push(grid.bounds);
        } else {
            let column = |x: usize| (0..grid.ny).fold(0u32, |rows, y| rows | u32::from(grid.occupied(x, y)) << y);
            let mut from = 0;
            while from < grid.nx {
                let (rows, mut to) = (column(from), from + 1);
                while to < grid.nx && column(to) == rows { to += 1; }
                let mut low = 0;
                while low < grid.ny {
                    if rows >> low & 1 == 0 { low += 1; continue; }
                    let mut high = low + 1;
                    while high < grid.ny && rows >> high & 1 == 1 { high += 1; }
                    let (first, last) = (grid.cell_bounds(from, low), grid.cell_bounds(to - 1, high - 1));
                    solid.push(Bounds { min_x: first.min_x, max_x: last.max_x, min_y: first.min_y, max_y: last.max_y });
                    low = high;
                }
                from = to;
            }
        }
        Self { pose, whole: grid.bounds, solid }
    }
}
/// What of its own armour stands around an optic or a radar: the plates its wave does not run through.
/// It turns with its construction as one piece, so the arcs that armour hides from it are kept about the
/// turn of its own piece and stand until the armour wears: a look asks one angle of them, and casts no
/// line into its own construction.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Cover {
    /// The arcs hidden, each from an angle to a greater one within one turn, in order and apart.
    hidden: Vec<(f64, f64)>,
    /// Where the length of the hull lies, and whether the optic sees out level along it and against it.
    axis: f64,
    level: [bool; 2],
}
impl Cover {
    /// The cover of an optic among the opaque plates of its own construction; `hull` is how the
    /// construction is turned. A plate the optic is set in is its mount, and hides nothing from it.
    pub fn around<'a>(optic: Pose, hull: f64, armour: impl IntoIterator<Item = &'a Armour>) -> Self {
        let mut arcs: Vec<(f64, f64)> = Vec::new();
        for plate in armour {
            let at = plate.pose.local_point(Point::new(optic.x, optic.y));
            let b = plate.whole;
            if at.x > b.min_x - MOUNT && at.x < b.max_x + MOUNT && at.y > b.min_y - MOUNT && at.y < b.max_y + MOUNT { continue; }
            for b in &plate.solid {
                // Seen from outside it a rectangle is the arc between two of its corners, less than half a turn.
                let middle = atan2((b.min_y + b.max_y) * 0.5 - at.y, (b.min_x + b.max_x) * 0.5 - at.x);
                let (mut low, mut high) = (0.0_f64, 0.0_f64);
                for (x, y) in [(b.min_x, b.min_y), (b.max_x, b.min_y), (b.max_x, b.max_y), (b.min_x, b.max_y)] {
                    let by = turned(atan2(y - at.y, x - at.x) - middle);
                    low = low.min(by);
                    high = high.max(by);
                }
                let from = turned(middle + low + plate.pose.angle - optic.angle);
                let to = from + high - low;
                if to > PI {
                    arcs.push((from, PI));
                    arcs.push((-PI, to - TAU));
                } else {
                    arcs.push((from, to));
                }
            }
        }
        arcs.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut hidden: Vec<(f64, f64)> = Vec::new();
        for arc in arcs {
            match hidden.last_mut() {
                Some(last) if arc.0 <= last.1 + SEAM => last.1 = last.1.max(arc.1),
                _ => hidden.push(arc),
            }
        }
        let axis = turned(hull - optic.angle);
        let mut cover = Self { hidden, axis, level: [false; 2] };
        cover.level = [cover.open(axis), cover.open(axis + PI)];
        cover
    }
    /// Whether the armour stands on the line from the optic to a place, the optic's piece turned as given.
    fn hides(&self, from: Point, to: Point, turn: f64) -> bool {
        if self.hidden.is_empty() { return false; }
        let angle = turned(atan2(to.y - from.y, to.x - from.x) - turn);
        self.hidden.iter().any(|arc| arc.0 <= angle && angle <= arc.1)
    }
    /// Whether some line within `LEVEL` of an angle runs clear of the armour.
    fn open(&self, angle: f64) -> bool {
        let from = turned(angle - LEVEL);
        let to = from + 2.0 * LEVEL;
        let shut = |from: f64, to: f64| self.hidden.iter().any(|arc| arc.0 <= from + SEAM && to <= arc.1 + SEAM);
        if to > PI { !shut(from, PI) || !shut(-PI, to - TAU) } else { !shut(from, to) }
    }
    /// The armour stands all around: nothing is seen past it.
    fn sealed(&self) -> bool {
        self.hidden.len() == 1 && self.hidden[0].0 <= -PI + SEAM && self.hidden[0].1 >= PI - SEAM
    }
    /// Whether the optic sees out level to the left and to the right of the field, its piece turned as given.
    fn sides(&self, turn: f64) -> [bool; 2] {
        if cos(turn + self.axis) >= 0.0 { [self.level[1], self.level[0]] } else { self.level }
    }
}
#[derive(Clone, Debug)]
pub struct SensorHit {
    pub enter: f64,
    pub point: Point,
    pub normal: Point,
    pub actor: Option<u32>,
}
pub trait SensorQuery: Sync {
    fn terrain_raycast(&self, start: Point, end: Point) -> Option<SensorHit>;
    /// Ignore every piece belonging to the observer, including casings/loose bodies. A line that is a
    /// `wave` runs through what that wave runs through, whoever it belongs to; any other line meets it.
    fn material_raycast(&self, start: Point, end: Point, ignore_actor: u32, wave: Option<Wave>) -> Option<SensorHit>;
}
pub struct SensorView<'a> {
    pub time: f64,
    pub seed: u32,
    pub weather: SensorWeather,
    pub actors: &'a [SensorActor],
    pub modules: &'a [SensorModule],
    pub query: &'a dyn SensorQuery,
}
impl SensorView<'_> {
    pub fn actor(&self, id: u32) -> Result<&SensorActor, String> {
        self.actors
            .iter()
            .find(|a| a.handle == id)
            .ok_or_else(|| "Participante do sensor não encontrado.".into())
    }
}

/// Mulberry32, including JavaScript's wrapping integer multiplications.
#[derive(Clone, Debug)]
pub struct PilotRandom {
    state: u32,
}
impl PilotRandom {
    pub fn new(seed: u32) -> Self {
        Self {
            state: if seed == 0 { 1 } else { seed },
        }
    }
    pub fn next(&mut self) -> f64 {
        self.state = self.state.wrapping_add(0x6d2b79f5);
        let mut t = self.state;
        t = (t ^ (t >> 15)).wrapping_mul(t | 1);
        t ^= t.wrapping_add((t ^ (t >> 7)).wrapping_mul(t | 61));
        (t ^ (t >> 14)) as f64 / 4294967296.0
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContactSource {
    #[default]
    None,
    Visual,
    Radar,
    Sound,
    Memory,
    Team,
}
impl ContactSource {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Visual => "visual",
            Self::Radar => "radar",
            Self::Sound => "sound",
            Self::Memory => "memory",
            Self::Team => "team",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub enum ContactClassification {
    #[default]
    None,
    Detected,
    Estimated,
    Identified,
}
impl ContactClassification {
    pub fn name(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Detected => "detected",
            Self::Estimated => "estimated",
            Self::Identified => "identified",
        }
    }
    fn aged(self, source: ContactSource, confidence: f64, age: f64) -> Self {
        if age > MEMORY_SECONDS || source == ContactSource::None {
            Self::None
        } else if self == Self::None {
            Self::None
        } else if confidence < 0.2 {
            Self::Detected
        } else if self == Self::Identified && (!matches!(source, ContactSource::Visual | ContactSource::Team) || age > 0.10001) {
            Self::Estimated
        } else {
            self
        }
    }
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
pub struct Contact {
    pub detected: bool,
    pub visible: bool,
    pub source: ContactSource,
    pub classification: ContactClassification,
    pub confidence: f64,
    pub time: f64,
    pub age: f64,
    pub uncertainty: f64,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub vx: f64,
    pub vy: f64,
    pub channel: Option<ContactSource>,
    pub source_actor: Option<u32>,
}
impl Contact {
    pub fn to_value(&self) -> Value {
        let mut v = json!({"detected":self.detected,"visible":self.visible,"source":self.source.name(),"confidence":self.confidence,
            "classification":self.classification.name(),"identified":self.classification==ContactClassification::Identified,
            "time":self.time,"age":self.age,"uncertainty":self.uncertainty,"x":self.x,"y":self.y,"width":self.width,"height":self.height,"vx":self.vx,"vy":self.vy});
        if let Some(channel) = self.channel {
            v["channel"] = json!(channel.name());
        }
        v
    }
}
#[derive(Clone, Debug)]
pub struct RosterContact {
    pub id: String,
    pub contact: Contact,
}
/// What the sensors of one team hold of a construction of another: by which kind of sensor, whether
/// it is held now, where and how far off that may be, how old it is and who took it. What a camera
/// sees is there to be seen: it is told where it is, with nothing off.
#[derive(Clone, Debug)]
pub struct Sight {
    pub target: u32,
    pub channel: ContactSource,
    pub visible: bool,
    pub x: f64,
    pub y: f64,
    pub error: f64,
    pub age: f64,
    pub by: Option<u32>,
    pub sound: Option<SoundReceipt>,
}
/// A camera sees the place where a construction was when its line there runs clear to this near it.
pub const GHOST_REACH: f64 = 2.0;
/// A host that asks what the teams see has the sensors read when nothing else read them for this long.
pub const SIGHT_READING: f64 = 0.5;
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
pub struct TerrainSample {
    #[cfg(test)]
    #[serde(skip)]
    pub side: usize,
    #[cfg(test)]
    #[serde(skip)]
    pub ray: usize,
    #[cfg(test)]
    #[serde(skip)]
    pub known: bool,
    #[cfg(test)]
    #[serde(skip)]
    pub fresh: bool,
    pub hit: bool,
    pub x: f64,
    pub y: f64,
    pub ny: f64,
    pub obstacle: bool,
    #[cfg(test)]
    #[serde(skip)]
    pub age: f64,
}
/// The ground as a side's optics read it for one of its constructions: where the optic it was read from stood. A
/// pilot goes by the heights its side holds (`observed_terrain`); the lines of the reading, none known when
/// the side holds none, are there for the tests to look along.
#[derive(Clone, Debug)]
pub struct TerrainReading {
    pub origin: Option<Point>,
    #[cfg(test)]
    pub samples: [TerrainSample; TERRAIN_RAY_COUNT],
}

#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
struct TerrainFrame {
    camera: u32,
    time: f64,
    range: f64,
    origin: Point,
    samples: [TerrainSample; TERRAIN_RAY_COUNT],
    // Who actually received this panorama when it was measured, never a live relay to its source.
    audiences: Vec<String>,
}
/// The panoramas a pilot may use during one choice, newest first. Borrowing them keeps that reading fixed.
pub(crate) struct ObservedTerrain<'a> {
    frames: Vec<&'a TerrainFrame>,
}
impl ObservedTerrain<'_> {
    pub(crate) fn height(&self,x:f64)->Option<f64> {
        for frame in &self.frames {
            let mut left:Option<&TerrainSample>=None;let mut right:Option<&TerrainSample>=None;
            for s in frame.samples.iter().filter(|s|s.hit&&!s.obstacle) {
                if (s.x-x).abs()<=1e-6 {return Some(s.y);}
                if s.x<x && left.is_none_or(|l|s.x>l.x) {left=Some(s);}
                if s.x>x && right.is_none_or(|r|s.x<r.x) {right=Some(s);}
            }
            if let (Some(a),Some(b))=(left,right) {
                if b.x-a.x<=8.0_f64.max(frame.range*0.2) && a.ny>=0.35 && b.ny>=0.35
                    && !frame.samples.iter().any(|s|s.hit&&s.obstacle&&s.x>a.x&&s.x<b.x) {
                    return Some(a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x));
                }
            }
        }None
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[cfg_attr(test, derive(PartialEq))]
pub struct SoundReceipt {
    pub side: i8,
    pub team: String,
}
#[derive(Clone, Copy, Serialize, Deserialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub(crate) struct OpticalCondition {
    pub unavailable: bool,
    pub worth: Option<f64>,
}
#[derive(Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
struct Measurement {
    sensor: u32,
    contact: Contact,
    // Receipt metadata belongs to this existing contact slot, not to a second intelligence cache.
    sound: Option<SoundReceipt>,
    optical: Option<OpticalCondition>,
}
#[derive(Clone)]
struct Camera {
    handle: u32, origin: Point, mode: SensorMode, command: bool,
    range: f64, identify_range: f64, terrain_range: f64, precision: f64,
    /// How its piece is turned and what of its own armour stands around it: an optic's or a radar's alone.
    turn: f64, cover: Option<Arc<Cover>>,
}
impl Camera {
    /// Whether its own armour stands between the sensor and a place.
    fn hidden(&self, place: Point) -> bool {
        self.cover.as_ref().is_some_and(|cover| cover.hides(self.origin, place, self.turn))
    }
    /// Whether it sees out level to the left and to the right of the field.
    fn sides(&self) -> [bool; 2] {
        self.cover.as_ref().map_or([true; 2], |cover| cover.sides(self.turn))
    }
}
/// One fog belongs to each team. Only bounded optical frames and measured
/// enemy contacts persist; there are no individual relays or target locks.
#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct SensorMemory {
    // Intelligence grants are separate from physical teams and projectile Sides. Only direct sources are shared.
    alliances: Vec<(String, String)>,
    members: HashMap<u32, (String, Point)>,
    contacts: HashMap<(String, u32), Measurement>,
    terrain: HashMap<u32, VecDeque<TerrainFrame>>,
    shots: HashMap<u32, (u64, f64)>,
    fresh: HashSet<(String, u32)>,
    time: Option<f64>,
    /// The camera that has each construction a team sees, by its construction and itself; the reading
    /// the cameras were last looked through after; and how many times they were asked what they see.
    sights: HashMap<(String, u32), (u32, u32)>,
    looked: Option<f64>,
    turn: usize,
}
fn intelligence_source(alliances: &[(String, String)], receiver: &str, source: &str) -> bool {
    receiver == source || alliances.iter().any(|(a, b)| a == receiver && b == source || b == receiver && a == source)
}
fn position(actor: &SensorActor) -> Point {
    actor.vehicle.map_or(Point::new(actor.x, actor.y), |v| Point::new(v.x, v.y))
}
fn facing(actor: &SensorActor) -> f64 { if actor.facing == 0.0 { 1.0 } else { actor.facing } }
fn quality(c: &Contact) -> f64 {
    if c.detected { c.confidence / (1.0 + c.uncertainty * 0.1) } else { 0.0 }
}
fn push_observer_camera(cameras: &mut Option<Vec<Camera>>, module: &SensorModule) {
    let Some(result) = cameras.as_mut() else { return; };
    if module.kind == ComponentKind::Command && !module.active() { *cameras = None; return; }
    if let Some(camera) = module.camera() { result.push(camera); }
}
fn sort_observer_cameras(cameras: &mut Option<Vec<Camera>>) {
    if let Some(cameras) = cameras {
        cameras.sort_by(|a,b| a.precision.total_cmp(&b.precision)
            .then_with(|| b.range.total_cmp(&a.range)).then_with(|| b.origin.y.total_cmp(&a.origin.y)));
    }
}
fn observer_cameras(view: &SensorView, actor: &SensorActor) -> Option<Vec<Camera>> {
    let mut result = Some(Vec::new());
    for module in view.modules.iter().filter(|module| module.actor == actor.handle) {
        push_observer_camera(&mut result, module);
        if result.is_none() { return None; }
    }
    sort_observer_cameras(&mut result);
    result
}
/// The same cameras prepared once by construction; feeds still follow the order of the field.
fn observer_camera_groups(view: &SensorView) -> HashMap<u32, Option<Vec<Camera>>> {
    let mut groups = HashMap::with_capacity(view.actors.len());
    for actor in view.actors { groups.entry(actor.handle).or_insert_with(|| Some(Vec::new())); }
    for module in view.modules {
        if let Some(cameras) = groups.get_mut(&module.actor) { push_observer_camera(cameras, module); }
    }
    for cameras in groups.values_mut() { sort_observer_cameras(cameras); }
    groups
}
/// The optic the ground is read with: one that sees out to both sides before one that sees out to one,
/// then the one that reaches farther and stands higher. One that sees out to neither reads no ground.
fn terrain_camera(cameras: &[Camera]) -> Option<&Camera> {
    let sides=|c:&Camera|c.sides().iter().filter(|open|**open).count();
    cameras.iter().filter(|c| c.mode == SensorMode::Visual && sides(c)>0).max_by(|a,b|
        sides(a).cmp(&sides(b)).then_with(|| a.terrain_range.total_cmp(&b.terrain_range)).then_with(|| a.origin.y.total_cmp(&b.origin.y)))
}
fn sensor_random(seed: u32, observer: &str, target: &str, mode: SensorMode, sample: u32) -> PilotRandom {
    let mut seed = seed ^ sample.wrapping_add(1).wrapping_mul(2654435761);
    for c in observer.encode_utf16().chain(target.encode_utf16()).chain(mode.name().encode_utf16()) {
        seed = (seed ^ c as u32).wrapping_mul(16777619);
    }
    PilotRandom::new(seed)
}
/// Whether a line runs clear to a construction or to a point of it. A camera's line is light, and runs
/// through glass; a radar's runs through fibreglass; both pass beside the sensors of others, which stand as deep
/// as they are on roofs as wide as their constructions.
fn clear_sight(view: &SensorView, start: Point, end: Point, observer: u32, target: u32, wave: Wave) -> bool {
    let material = view.query.material_raycast(start,end,observer,Some(wave));
    let sees_target = material.as_ref().is_some_and(|h| h.actor == Some(target));
    // The material of another in the way hides the target whatever the ground does: it is not asked.
    if material.is_some() && !sees_target { return false; }
    let ground = view.query.terrain_raycast(start,end);
    !ground.is_some_and(|g| !sees_target || g.enter < material.as_ref().unwrap().enter)
}
/// A partial silhouette describes only the part actually visible above cover. The optic's own armour
/// is asked first: a line it stands on is not cast.
fn optical_extent(view: &SensorView, sensor: &Camera, observer: u32, target: u32, b: Bounds)
    -> Option<(Point,f64,f64,bool)> {
    let center = Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    let points = [center,Point::new(b.min_x,center.y),Point::new(b.max_x,center.y),
        Point::new(center.x,b.min_y),Point::new(center.x,b.max_y)];
    let mut visible = Bounds::empty(); let mut count = 0;
    for p in points {
        if hypot(p.x-sensor.origin.x,p.y-sensor.origin.y)>sensor.range*view.weather.optical().0
            || sensor.hidden(p) || !clear_sight(view,sensor.origin,p,observer,target,Wave::Light) { continue; }
        visible.min_x=visible.min_x.min(p.x);visible.max_x=visible.max_x.max(p.x);
        visible.min_y=visible.min_y.min(p.y);visible.max_y=visible.max_y.max(p.y);count+=1;
    }
    (count>0).then(|| (Point::new((visible.min_x+visible.max_x)*0.5,(visible.min_y+visible.max_y)*0.5),
        visible.max_x-visible.min_x,visible.max_y-visible.min_y,count==points.len()))
}
/// What a track settles on weighing each reading by, for where a construction is and for how fast it goes, once it
/// has weighed enough of them: as much as readings off by up to `error`, taken `dt` apart, are worth while the
/// construction may speed up or brake by `MANOEUVRE` meanwhile (Kalata's tracking index). A reading is as likely
/// anywhere within its error.
fn settled(error: f64, dt: f64) -> (f64, f64) {
    let index = MANOEUVRE * dt * dt / (error / sqrt(3.0)).max(1e-9);
    let root = (4.0 + index - sqrt(8.0 * index + index * index)) / 4.0;
    let position = 1.0 - root * root;
    (position, 2.0 * (2.0 - position) - 4.0 * sqrt(1.0 - position))
}
/// The fastest a track has a construction on the ground go along the field and up or down, in m/s: what drives goes no
/// faster, and a faster speed is the noise of readings off by metres taken a fifth of a second apart.
const GROUND_SPEED: (f64, f64) = (30.0, 15.0);
/// And one that flies, either way: a little faster than the fastest aircraft go, some 1 300 km/h.
const AIR_SPEED: f64 = 400.0;
/// How far under a construction a sensor that holds it looks for the ground: one with none this near under it flies.
const ALOFT: f64 = 3.0;
/// Whether a construction flies, as a sensor that holds it tells: the ground is not under it, down from its middle to
/// `ALOFT` under its bottom.
fn aloft(view: &SensorView, enemy: &SensorActor) -> bool {
    let b = enemy.bounds;
    let x = (b.min_x + b.max_x) * 0.5;
    view.query.terrain_raycast(Point::new(x, (b.min_y + b.max_y) * 0.5), Point::new(x, b.min_y - ALOFT)).is_none()
}
/// A new reading of a sensor that read the construction before, weighed against where its track had the construction
/// go: where it is, how fast it goes and how far off that may be. A track fits its first readings with a straight
/// course through them all, and weighs each new one less until it weighs it as `settled` has it. How far along that
/// it is, its doubt tells: a track of one reading is as far off as the reading. A reading farther off than the track
/// and the reading could both be starts it over from `RESTART` readings. The speed it has the construction go is held to
/// what goes on the ground (`GROUND_SPEED`), or to `AIR_SPEED` when it goes faster than that and `flies`: asked then alone.
fn track(previous: &Contact, x: f64, y: f64, error: f64, dt: f64, flies: impl FnOnce() -> bool) -> (Point, Point, f64) {
    let share = (previous.uncertainty / error.max(1e-9)).powi(2).clamp(1e-9, 1.0);
    // The readings weighed so far, n, from the share of its doubt a straight course through them leaves: 2(2n-1)/(n(n+1)).
    let mut readings = (4.0 - share + sqrt(((4.0 - share) * (4.0 - share) - 8.0 * share).max(0.0))) / (2.0 * share) + 1.0;
    let ahead = Point::new(previous.x + previous.vx * dt, previous.y + previous.vy * dt);
    let (off_x, off_y) = (x - ahead.x, y - ahead.y);
    if hypot(off_x, off_y) > previous.uncertainty + error {
        readings = readings.min(RESTART);
    }
    let (settled_position, settled_speed) = settled(error, dt);
    let position = (2.0 * (2.0 * readings - 1.0) / (readings * (readings + 1.0))).max(settled_position);
    let speed = (6.0 / (readings * (readings + 1.0))).max(settled_speed);
    let (vx, vy) = (previous.vx + speed / dt * off_x, previous.vy + speed / dt * off_y);
    let (most_x, most_y) = if (vx.abs() > GROUND_SPEED.0 || vy.abs() > GROUND_SPEED.1) && flies() { (AIR_SPEED, AIR_SPEED) } else { GROUND_SPEED };
    (Point::new(ahead.x + position * off_x, ahead.y + position * off_y),
        Point::new(vx.clamp(-most_x, most_x), vy.clamp(-most_y, most_y)),
        error * sqrt(position))
}
/// How far off the next reading of a track can be at the least, with the best a sensor could read: the track never
/// weighs a reading less than once it has settled, and its doubt grows with the error of what it reads.
fn tracked_doubt(error: f64, dt: f64) -> f64 {
    error * sqrt(settled(error, dt).0)
}
/// How fast a track of a construction that stands still may seem to go, by the noise of its readings alone: what
/// a speed must stand above before it tells that the construction moves. It is read off how far off the track's
/// place may be (`doubt`) and the kind of sensor it was read with, which reads at its own pace: of a settled track,
/// the error of the readings is the one `tracked_doubt` has that far off; a track still settling is farther off, and
/// is taken for one of worse readings. An ear holds no speed.
pub fn speed_noise(channel: ContactSource, doubt: f64) -> f64 {
    let dt = match channel {
        ContactSource::Visual => SensorMode::Visual.config().1,
        ContactSource::Radar => SensorMode::Radar.config().1,
        _ => return 0.0,
    };
    // A track is never farther off than a reading: the error is at least the doubt.
    let (mut low, mut high) = (doubt.max(0.0), doubt.max(0.0) * 1e3 + 1.0);
    for _ in 0..60 {
        let middle = 0.5 * (low + high);
        if tracked_doubt(middle, dt) < doubt { low = middle; } else { high = middle; }
    }
    let error = 0.5 * (low + high);
    let (position, speed) = settled(error, dt);
    // What the noise of readings alone leaves in the speed of a filter that weighs them so (an alpha-beta filter).
    error / sqrt(3.0) * sqrt(2.0 * speed * speed / (position * (4.0 - 2.0 * position - speed)).max(1e-12)) / dt
}
/// Whether a radar or a microphone reaches a construction: one of three lines up its middle runs clear to it.
/// A radar's runs through no armour of its own but fibreglass. A microphone hears round whatever construction
/// stands in the way, of its own faction or another, and only the ground between shuts the sound off.
fn radar_in_view(view: &SensorView, sensor: &Camera, observer: u32, enemy: &SensorActor) -> bool {
    // An inert hull is still visible, but is no new radar or sound contact.
    if enemy.defeated {return false;}
    let b=enemy.bounds;
    let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    [0.2,0.5,0.85].iter().map(|fraction| Point::new(center.x,b.min_y+(b.max_y-b.min_y)*fraction))
        .any(|p| !sensor.hidden(p) && match sensor.mode.wave() {
            Some(wave) => clear_sight(view,sensor.origin,p,observer,enemy.handle,wave),
            None => view.query.terrain_raycast(sensor.origin,p).is_none(),
        })
}
fn measure(view: &SensorView, actor: &SensorActor, enemy: &SensorActor, sensor: &Camera,
    audible: f64, previous: Option<&Measurement>) -> Option<Measurement> {
    let b=enemy.bounds;
    if !(b.min_x+b.max_x+b.min_y+b.max_y).is_finite() {return None;}
    let mode=sensor.mode; let (_,interval,base_error)=mode.config();
    let (visibility,identification,weather_error)=view.weather.optical();
    let range=sensor.range*if mode==SensorMode::Visual {visibility} else {1.0};
    let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    if hypot(center.x-sensor.origin.x,center.y-sensor.origin.y)>range*
        if mode==SensorMode::Sound {audible} else {1.0} || mode==SensorMode::Sound && audible==0.0 {return None;}
    let (point,width,height,complete)=if mode==SensorMode::Visual {
        optical_extent(view,sensor,actor.handle,enemy.handle,b)?
    } else {
        // A radar's own armour hides what it hides from an optic, but for its fibreglass.
        if !radar_in_view(view,sensor,actor.handle,enemy) {return None;}
        (center,0.0,0.0,false)
    };
    let optical=previous.and_then(|p|p.optical);
    let previous=previous.filter(|p|p.sensor==sensor.handle && p.contact.source_actor==Some(actor.handle));
    if let Some(p)=previous.filter(|p|view.time-p.contact.time<interval-0.00001) {
        return Some(p.clone());
    }
    let dx=point.x-sensor.origin.x;let dy=point.y-sensor.origin.y;let distance=hypot(dx,dy);
    let silhouette=sqrt(width*height/6.4).clamp(0.5,1.5);
    // A dedicated optic identifies no farther than its stated reach; a small or obscured target may be harder.
    // The command post keeps its existing silhouette-dependent basic optic.
    let identify=sensor.identify_range*identification*if sensor.command {silhouette}else{silhouette.min(1.0)};
    let error=match mode {
        SensorMode::Sound=>(distance*0.25).max(base_error),
        SensorMode::Radar=>base_error+distance*0.012,
        SensorMode::Visual=>(base_error+distance*0.001)*sensor.precision*weather_error/silhouette,
    };
    let angle_error=match mode {SensorMode::Sound=>0.14,SensorMode::Radar=>0.006,
        SensorMode::Visual=>0.0007*sensor.precision*weather_error/silhouette};
    let classification=match mode {
        SensorMode::Sound=>ContactClassification::Detected,
        SensorMode::Radar=>ContactClassification::Estimated,
        SensorMode::Visual if complete && distance<=identify=>ContactClassification::Identified,
        SensorMode::Visual if width==0.0 || height==0.0 || error>(width*0.5).max(1.0)=>ContactClassification::Detected,
        SensorMode::Visual=>ContactClassification::Estimated,
    };
    let mut random=sensor_random(view.seed,&actor.id,&enemy.id,mode,(view.time/interval).floor() as u32);
    let bearing=atan2(dy,dx)+random.range(-1.0,1.0)*angle_error;
    let distance_estimate=(distance+random.range(-error,error)).max(0.1);
    let x=sensor.origin.x+cos(bearing)*distance_estimate;
    let y=sensor.origin.y+sin(bearing)*distance_estimate;
    let error=if mode==SensorMode::Sound {(distance*0.3).max(3.0)}else{hypot(error,distance*angle_error)};
    // An ear hears where, not how fast: each of its readings stands alone.
    let dt=previous.map_or(0.0,|p|view.time-p.contact.time);
    let (place,speed,uncertainty)=match previous {
        Some(p) if mode!=SensorMode::Sound && dt>0.0 && dt<2.0=>track(&p.contact,x,y,error,dt,||aloft(view,enemy)),
        _=>(Point::new(x,y),Point::ZERO,error),
    };
    Some(Measurement {sensor:sensor.handle,optical,
        sound:(mode==SensorMode::Sound).then(||SoundReceipt {side:if x<position(actor).x {-1}else{1},team:actor.team.clone()}),
        contact:Contact {
        detected:true,visible:true,source:ContactSource::Team,
        channel:Some(match mode {SensorMode::Visual=>ContactSource::Visual,SensorMode::Radar=>ContactSource::Radar,SensorMode::Sound=>ContactSource::Sound}),
        source_actor:Some(actor.handle),classification,time:view.time,age:0.0,x:place.x,y:place.y,
        confidence:match mode {SensorMode::Visual=>(0.95-distance/range*0.2)*if complete {1.0}else{0.7},
            SensorMode::Radar=>0.75-distance/range*0.25,SensorMode::Sound=>0.28-distance/range*0.12},
        uncertainty,
        width:if mode!=SensorMode::Visual || width==0.0 {0.0}else if classification==ContactClassification::Identified {width}else{(width+0.5).floor().max(1.0)},
        height:if mode!=SensorMode::Visual || height==0.0 {0.0}else if classification==ContactClassification::Identified {height}else{((height*2.0+0.5).floor()/2.0).max(0.5)},
        vx:speed.x,vy:speed.y,
    }})
}
/// The most a camera could make of an enemy: nothing when the enemy is out of its reach, and otherwise
/// a quality no reading `measure` takes with it can exceed. It costs no ray. A reading still fresh is
/// handed over as it is, so its own quality is the most; a new one is at its best with the whole
/// box of the enemy in sight and the nearest point of it for a centre.
fn promise(view: &SensorView, actor: &SensorActor, enemy: &SensorActor, sensor: &Camera,
    audible: f64, previous: Option<&Measurement>) -> Option<f64> {
    let b=enemy.bounds;
    if !(b.min_x+b.max_x+b.min_y+b.max_y).is_finite() {return None;}
    let mode=sensor.mode; let (_,interval,base_error)=mode.config();
    let (visibility,_,weather_error)=view.weather.optical();
    let range=sensor.range*if mode==SensorMode::Visual {visibility} else {1.0};
    let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    let reach=hypot(center.x-sensor.origin.x,center.y-sensor.origin.y);
    if reach>range*if mode==SensorMode::Sound {audible} else {1.0} || mode==SensorMode::Sound && audible==0.0 {return None;}
    let previous=previous.filter(|p|p.sensor==sensor.handle && p.contact.source_actor==Some(actor.handle));
    if let Some(p)=previous.filter(|p|view.time-p.contact.time<interval-0.00001) {return Some(quality(&p.contact));}
    // A sensor that read the construction last weighs its new reading into its track, which is never farther off
    // than `tracked_doubt` has it.
    let doubt=|error:f64|previous.map(|p|view.time-p.contact.time).filter(|dt|*dt<2.0)
        .map_or(error,|dt|tracked_doubt(error,dt));
    let best=match mode {
        SensorMode::Visual=>{
            let (left,right,low,high)=(b.min_x.min(b.max_x),b.min_x.max(b.max_x),b.min_y.min(b.max_y),b.min_y.max(b.max_y));
            let near=hypot((left-sensor.origin.x).max(sensor.origin.x-right).max(0.0),
                (low-sensor.origin.y).max(sensor.origin.y-high).max(0.0));
            let silhouette=sqrt((right-left)*(high-low)/6.4).clamp(0.5,1.5);
            let error=(base_error+near*0.001)*sensor.precision*weather_error/silhouette;
            let angle_error=0.0007*sensor.precision*weather_error/silhouette;
            (0.95-near/range*0.2)/(1.0+doubt(hypot(error,near*angle_error))*0.1)
        }
        SensorMode::Radar=>(0.75-reach/range*0.25)/(1.0+doubt(hypot(base_error+reach*0.012,reach*0.006))*0.1),
        SensorMode::Sound=>(0.28-reach/range*0.12)/(1.0+(reach*0.3).max(3.0)*0.1),
    };
    // The same numbers are worked out in another order by `measure`: the last bit is not relied on.
    // A part of a silhouette far beyond the reach of the camera may read below nothing.
    Some(best.max(0.0)*(1.0+1e-9))
}
/// Whether a camera sees the place where a construction was last seen. Its line there, and a little
/// past it, meets no material: what stands on that line hides the place, or is the construction
/// itself. The ground may stop the line only at the place. Its own armour hides the place as it hides anything.
fn sees_place(view: &SensorView, camera: &Camera, place: Point, observer: u32) -> bool {
    let start=camera.origin;
    let (dx,dy)=(place.x-start.x,place.y-start.y);let length=hypot(dx,dy);
    if length<1e-9 {return true;}
    if camera.hidden(place) {return false;}
    let past=Point::new(place.x+dx/length*GHOST_REACH,place.y+dy/length*GHOST_REACH);
    view.query.material_raycast(start,past,observer,Some(Wave::Light)).is_none()
        && view.query.terrain_raycast(start,past).is_none_or(|ground|hypot(ground.point.x-place.x,ground.point.y-place.y)<=GHOST_REACH)
}
/// Whether a camera sees a construction: what `measure` asks of a camera before it measures, and no
/// more. The first line that runs clear answers.
fn in_view(view: &SensorView, camera: &Camera, observer: u32, enemy: &SensorActor) -> bool {
    let b=enemy.bounds;
    if !(b.min_x+b.max_x+b.min_y+b.max_y).is_finite() {return false;}
    let range=camera.range*view.weather.optical().0;
    let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    if hypot(center.x-camera.origin.x,center.y-camera.origin.y)>range {return false;}
    [center,Point::new(center.x,b.max_y),Point::new(b.min_x,center.y),Point::new(b.max_x,center.y),Point::new(center.x,b.min_y)]
        .iter().any(|p|hypot(p.x-camera.origin.x,p.y-camera.origin.y)<=range && !camera.hidden(*p)
            && clear_sight(view,camera.origin,*p,observer,enemy.handle,Wave::Light))
}
/// One enemy against the same borrowed scene and the contacts received before it.
fn measure_enemy(view:&SensorView, enemy:&SensorActor, feeds:&[(&SensorActor,&[Camera])],
    teams:&[(String,Vec<usize>,Bounds,f64)], shots:&HashMap<u32,(u64,f64)>,
    contacts:&HashMap<(String,u32),Measurement>) -> Vec<(String,Measurement)> {
    let mut measured:Vec<(String,Measurement)>=Vec::new();
    let sound=enemy.vehicle.map_or(0.0,|v|if v.engine {0.15+(v.vx.abs()/15.0+v.throttle.abs()*0.5).min(0.85)}else{0.0})
        .max(if view.time-shots[&enemy.handle].1<1.5 {1.0}else{0.0});
    let b=enemy.bounds;let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
    let bounded=(b.min_x+b.max_x+b.min_y+b.max_y).is_finite()
        && center.x.is_finite() && center.y.is_finite() && sound.is_finite() && sound<=1.0;
    for (team,members,origins,reach) in teams {
        if *team==enemy.team {continue;}
        if bounded && reach.is_finite() {
            // The same hypot keeps the existing underflow and boundary behaviour.
            let dx=(origins.min_x-center.x).max(center.x-origins.max_x).max(0.0);
            let dy=(origins.min_y-center.y).max(center.y-origins.max_y).max(0.0);
            if hypot(dx,dy)>*reach {continue;}
        }
        let previous=contacts.get(&((*team).to_owned(),enemy.handle));
        // What a team knows of an enemy is the best reading any member takes, the first of them
        // in the order of the field among equals. The member that could take the best looks
        // first, and only with the kinds of camera that could better what is read by then; a
        // member that could not better it does not look at all.
        let mut order:Vec<(f64,usize,[f64;3])>=members.iter().filter_map(|&index| {
            let (actor,cameras)=&feeds[index];
            let mut most=[f64::NEG_INFINITY;3];
            for camera in cameras.iter() {
                let Some(could)=promise(view,actor,enemy,camera,sound,previous) else {continue;};
                let kind=&mut most[camera.mode.index()];
                *kind=if could.is_nan() {f64::INFINITY} else {kind.max(could)};
            }
            let top=most[0].max(most[1]).max(most[2]);
            (top>f64::NEG_INFINITY).then_some((top,index,most))
        }).collect();
        order.sort_by(|a,b|b.0.total_cmp(&a.0));
        let mut best:Option<(f64,usize,Measurement)>=None;
        for (top,index,most) in order {
            let had=best.as_ref().map_or(f64::NEG_INFINITY,|b|b.0);
            if top<had {break;}
            let (actor,cameras)=&feeds[index];
            let mut sampled=[false;3];
            let mut own:Option<(f64,Measurement)>=None;
            for camera in cameras.iter() {
                let kind=camera.mode.index();
                if sampled[kind] || most[kind]<own.as_ref().map_or(had,|o|o.0.max(had)) {continue;}
                if let Some(reading)=measure(view,actor,enemy,camera,sound,previous) {
                    sampled[kind]=true;
                    let found=quality(&reading.contact);
                    if own.as_ref().is_none_or(|old|found>old.0) {own=Some((found,reading));}
                }
            }
            let Some((found,reading))=own else {continue;};
            if best.as_ref().is_none_or(|(had,at,_)|found>*had || found==*had && index<*at) {best=Some((found,index,reading));}
        }
        if let Some((_,_,reading))=best {measured.push(((*team).to_owned(),reading));}
    }
    measured
}

impl SensorMemory {
    pub fn allied(&self, a: &str, b: &str) -> bool {
        a != b && intelligence_source(&self.alliances, a, b)
    }
    pub fn set_alliances(&mut self, alliances: Vec<(String, String)>) {
        self.alliances = alliances;
        // A command may revoke a source in the same tick it was read. Retain received memory, not freshness.
        self.fresh.clear(); self.time = None; self.looked = None;
    }
    pub(crate) fn sound_receipt(&self, observer: u32, target: u32) -> Option<&SoundReceipt> {
        self.contacts.get(&(self.team(observer)?.to_owned(),target))?.sound.as_ref()
    }
    pub(crate) fn optical_condition(&self, team: &str, target: u32) -> Option<OpticalCondition> {
        self.contacts.get(&(team.to_owned(),target)).and_then(|held|held.optical)
    }
    /// Only callers holding a current authorized optical sight annotate the contact's received condition.
    pub(crate) fn observe_optical(&mut self, team: &str, target: u32, unavailable: bool, worth: Option<f64>) {
        let Some(held)=self.contacts.get_mut(&(team.to_owned(),target)) else {return;};
        let previous=held.optical.filter(|old|old.unavailable==unavailable).and_then(|old|old.worth);
        held.optical=Some(OpticalCondition {unavailable,worth:worth.or(previous)});
    }
    fn sample(&mut self, view:&SensorView) {
        if self.time.is_some_and(|t|view.time-t<0.09999) {return;}
        self.time=Some(view.time);self.fresh.clear();
        self.members=view.actors.iter().map(|a|(a.handle,(a.team.clone(),position(a)))).collect();
        for a in view.actors {
            let shots=self.shots.entry(a.handle).or_insert((0,f64::NEG_INFINITY));
            if a.shots>shots.0 {*shots=(a.shots,view.time);}
        }
        let cameras=observer_camera_groups(view);
        let feeds:Vec<_>=view.actors.iter().filter_map(|a|cameras.get(&a.handle)
            .and_then(|cameras|cameras.as_deref()).map(|cameras|(a,cameras))).collect();
        for (actor,cameras) in &feeds {
            if let Some(camera)=terrain_camera(cameras) {self.scan_terrain(view,actor,camera);}
        }
        // A faction without a construction still receives its allies' view. Never follow a source's own grants.
        let mut names = Vec::new();
        for actor in view.actors { if !names.contains(&actor.team) { names.push(actor.team.clone()); } }
        for (a,b) in &self.alliances { for name in [a,b] { if !names.contains(name) { names.push(name.clone()); } } }
        let mut teams:Vec<(String,Vec<usize>,Bounds,f64)> = names.into_iter().map(|team| {
            let members = feeds.iter().enumerate().filter(|(_, (actor,_))|
                intelligence_source(&self.alliances,&team,&actor.team)).map(|(index,_)|index).collect();
            (team,members,Bounds::empty(),0.0)
        }).collect();
        // A team's origins and greatest reach bound every reading its cameras could take.
        // Sound reaches no farther than its full range; only visual reach follows the weather.
        let visibility=view.weather.optical().0;
        for (_,members,origins,reach) in &mut teams {
            for &index in members.iter() {
                for camera in feeds[index].1 {
                    let range=camera.range*if camera.mode==SensorMode::Visual {visibility}else{1.0};
                    if !camera.origin.x.is_finite() || !camera.origin.y.is_finite() || !range.is_finite() || range<0.0 {
                        *reach=f64::INFINITY;continue; // An unknown bound leaves the original reading path open.
                    }
                    origins.include(camera.origin);*reach=reach.max(range);
                }
            }
        }
        let mut pending:Option<std::vec::IntoIter<Vec<(String,Measurement)>>> = None;
        #[cfg(not(target_arch = "wasm32"))]
        if self.members.len()==view.actors.len() && view.actors.len()>1 {
            // Repeated handles read the preceding occurrence's contact: keep their original scalar chain.
            // Two jobs borrow the scene; neither may publish a contact before both have finished.
            let read = |actors:&[SensorActor]| actors.iter().map(|enemy|
                measure_enemy(view,enemy,&feeds,&teams,&self.shots,&self.contacts)).collect::<Vec<_>>();
            let middle=view.actors.len()/2;
            let pool = crate::game_parallel::pool();
            let (mut first,last)=pool.install(||rayon::join(||read(&view.actors[..middle]),||read(&view.actors[middle..])));
            first.extend(last);
            pending=Some(first.into_iter());
        }
        for enemy in view.actors {
            let measured=match &mut pending {
                Some(rows)=>rows.next().expect("one sensor result per actor"),
                None=>measure_enemy(view,enemy,&feeds,&teams,&self.shots,&self.contacts),
            };
            for (team,reading) in measured {let key=(team,enemy.handle);self.fresh.insert(key.clone());self.contacts.insert(key,reading);}
        }
        self.contacts.retain(|_,c|view.time-c.contact.time<=MEMORY_SECONDS);
        for frames in self.terrain.values_mut() {frames.retain(|f|view.time-f.time<=TERRAIN_MEMORY_SECONDS);}
    }
    fn scan_terrain(&mut self,view:&SensorView,actor:&SensorActor,camera:&Camera) {
        let visibility=view.weather.optical().0;
        let direction=facing(actor)*if actor.vehicle.is_some_and(|v|cos(v.angle)<0.0){-1.0}else{1.0};
        // The ground is read by sides. To a side the optic sees out to, its own construction is looked
        // past, as a crew looks past its own bonnet; of a side its own armour hides, nothing is read.
        // Another's glass is something in the way here: what stands on the ground is told as an obstacle.
        let open=camera.sides();
        let shut=|i:usize|!open[usize::from(direction*if i/TERRAIN_DEGREES.len()==0{1.0}else{-1.0}>0.0)];
        // One line of the panorama, read as far as `range`.
        let read=|i:usize,range:f64| {
            let side=i/TERRAIN_DEGREES.len();let ray=i%TERRAIN_DEGREES.len();let angle=TERRAIN_DEGREES[ray].to_radians();
            let toward=direction*if side==0{1.0}else{-1.0};
            if shut(i) {
                return TerrainSample {x:camera.origin.x,y:camera.origin.y,..Default::default()};
            }
            let end=Point::new(camera.origin.x+cos(angle)*range*toward,camera.origin.y-sin(angle)*range);
            // A line longer than a terrain range is read that much at a time, as far as the first ground it meets: from
            // high up most of it runs through the air, where no ground is to be met.
            let pieces=(range/TERRAIN_CAMERA_RANGE).ceil().max(1.0) as usize;
            let ground=(0..pieces).find_map(|piece| {
                let along=|i:usize|match i {0=>camera.origin,i if i==pieces=>end,i=>camera.origin.lerp(end,i as f64/pieces as f64)};
                view.query.terrain_raycast(along(piece),along(piece+1))
            });
            let obstacle=view.query.material_raycast(camera.origin,ground.as_ref().map_or(end,|g|g.point),actor.handle,None);
            let blocked=obstacle.as_ref().is_some_and(|h|ground.is_none()||h.enter<1.0-1e-8);
            let hit=if blocked{obstacle.as_ref()}else{ground.as_ref()};
            let p=hit.map_or(end,|h|h.point);let n=hit.map_or(Point::new(0.0,0.0),|h|h.normal);
            TerrainSample {hit:hit.is_some(),x:p.x,y:p.y,ny:n.y,obstacle:blocked,..Default::default()}
        };
        // Its steepest line down, to the first side it sees out to, tells whether something stands under it within
        // `HIGH_OPTIC`: one that meets nothing so near reads every line as far as it sees.
        let low=camera.terrain_range*visibility;
        let steep=(0..2).map(|side|side*TERRAIN_DEGREES.len()+TERRAIN_DEGREES.len()-1).find(|i|!shut(*i)).map(|i|(i,read(i,low)));
        let high=steep.as_ref().is_some_and(|(_,s)|!(s.hit && camera.origin.y-s.y<=HIGH_OPTIC));
        let range=if high {camera.range.max(camera.terrain_range)*visibility} else {low};
        let samples=std::array::from_fn(|i| match &steep {
            Some((at,sample)) if *at==i && !high => sample.clone(),
            _ => read(i,range),
        });
        let mut audiences = vec![actor.team.clone()];
        for (a,b) in &self.alliances {
            let other = if a == &actor.team { Some(b) } else if b == &actor.team { Some(a) } else { None };
            if let Some(other) = other { if !audiences.contains(other) { audiences.push(other.clone()); } }
        }
        let frames=self.terrain.entry(actor.handle).or_default();
        // Spatially separated snapshots retain explored terrain, with fixed memory
        // cost. A panorama always keeps its measured origin: never invent a fan.
        if frames.back().is_some_and(|f|f.camera==camera.handle && f.origin.distance(camera.origin)<8.0 && f.audiences==audiences) {frames.pop_back();}
        frames.push_back(TerrainFrame {camera:camera.handle,time:view.time,range,origin:camera.origin,samples,audiences});
        while frames.len()>8 {frames.pop_front();}
    }
    fn team(&self,observer:u32)->Option<&str> {self.members.get(&observer).map(|m|m.0.as_str())}
    // By the handle of who took them: the order a map keeps is seeded anew in every process, and a field restored
    // or replayed must read the same ground of two frames that score alike.
    fn frames<'a>(&'a self,observer:u32,time:f64)->impl Iterator<Item=(u32,&'a TerrainFrame)> {
        let team=self.team(observer);
        let mut ids:Vec<u32>=self.terrain.keys().copied().collect();
        ids.sort_unstable();
        ids.into_iter().flat_map(move |id|self.terrain[&id].iter().map(move |f|(id,f)))
            .filter(move |(_,f)|time-f.time<=TERRAIN_MEMORY_SECONDS
                && team.is_some_and(|team|f.audiences.iter().any(|audience|audience==team)))
    }
    fn terrain_reading(&self,observer:u32,time:f64)->TerrainReading {
        let origin=self.members.get(&observer).map_or(Point::new(0.0,0.0),|m|m.1);
        let frame=self.frames(observer,time).min_by(|(a,fa),(b,fb)| {
            let score=|id:u32,f:&TerrainFrame|if id==observer && time-f.time<0.10001 {-1.0}else{f.origin.distance(origin)+(time-f.time)*4.0};
            score(*a,fa).total_cmp(&score(*b,fb)).then_with(||fb.time.total_cmp(&fa.time))
        });
        TerrainReading {origin:frame.map(|(_,f)|f.origin),
            #[cfg(test)]
            samples:{
                let age=frame.map_or(TERRAIN_MEMORY_SECONDS,|(_,f)|(time-f.time).max(0.0));
                let fresh=frame.is_some_and(|(source,f)|f.time==time && self.team(source).is_some_and(|source|
                    self.team(observer).is_some_and(|team|intelligence_source(&self.alliances,team,source)))) && self.time==Some(time);
                std::array::from_fn(|i| {
                    let mut s=frame.map_or_else(TerrainSample::default,|(_,f)|f.samples[i].clone());
                    s.side=i/TERRAIN_DEGREES.len();s.ray=i%TERRAIN_DEGREES.len();
                    s.known=frame.is_some();s.fresh=fresh;s.age=age;s
                })
            }}
    }
    pub fn remembered_contact(&self,observer:u32,target:u32,time:f64)->Option<Contact> {
        let key=(self.team(observer)?.to_owned(),target);
        let original=&self.contacts.get(&key)?.contact;let age=(time-original.time).max(0.0);
        if age>MEMORY_SECONDS {return None;}
        let mut c=original.clone();c.age=age;
        // A reading stands until the next one is taken, a tenth of a second on: what it saw is in sight
        // for whoever decides by it meanwhile, not a memory from the step after it.
        c.visible=self.fresh.contains(&key) && self.time.is_some_and(|t|time-t<0.09999);
        if !c.visible {c.source=ContactSource::Memory;}
        c.confidence*=exp(-age*1.5);c.uncertainty+=age*2.0;
        c.classification=c.classification.aged(c.source,c.confidence,age);Some(c)
    }
    pub fn retain_actors(&mut self,unchanged:&HashSet<u32>) {
        self.members.retain(|id,_|unchanged.contains(id));self.terrain.retain(|id,_|unchanged.contains(id));
        self.shots.retain(|id,_|unchanged.contains(id));
        self.contacts.retain(|(_,target),reading|unchanged.contains(target) && reading.contact.source_actor.is_some_and(|id|unchanged.contains(&id)));
        self.sights.retain(|(_,target),(actor,_)|unchanged.contains(target) && unchanged.contains(actor));
        self.fresh.clear();self.time=None;
        self.looked=None;
    }
    /// Whether an optic or a radar of the observer's own reaches a construction now, along a line that runs clear
    /// to it: what the team holds of the construction may have been read by another of the team.
    pub fn sees(&self,view:&SensorView,observer:u32,target:u32)->bool {
        let (Ok(actor),Ok(enemy))=(view.actor(observer),view.actor(target)) else {return false;};
        let b=enemy.bounds;
        let center=Point::new((b.min_x+b.max_x)*0.5,(b.min_y+b.max_y)*0.5);
        observer_cameras(view,actor).is_some_and(|cameras| cameras.iter().any(|camera| match camera.mode {
            SensorMode::Visual=>in_view(view,camera,observer,enemy),
            SensorMode::Radar=>hypot(center.x-camera.origin.x,center.y-camera.origin.y)<=camera.range
                && radar_in_view(view,camera,observer,enemy),
            SensorMode::Sound=>false,
        }))
    }
    pub(crate) fn observed_terrain<'a>(&'a self,view:&SensorView<'_>,observer:u32)->Result<ObservedTerrain<'a>,String> {
        view.actor(observer)?;
        let mut frames:Vec<_>=self.frames(observer,view.time).map(|(_,frame)|frame).collect();
        frames.sort_by(|a,b|b.time.total_cmp(&a.time));
        Ok(ObservedTerrain {frames})
    }
    pub fn sense_terrain(&mut self,view:&SensorView,observer:u32)->Result<TerrainReading,String> {
        view.actor(observer)?;self.sample(view);
        Ok(self.terrain_reading(observer,view.time))
    }
    #[cfg(test)]
    pub(crate) fn sense_combat(&mut self,view:&SensorView,observer:u32,target:u32)->Result<Contact,String> {
        let actor=view.actor(observer)?;let enemy=view.actor(target)?;self.sample(view);
        Ok(self.sampled_contact(actor,enemy,view.time))
    }
    /// A contact from a reading already taken, for callers that hold the actors of that same view.
    pub(crate) fn sampled_contact(&self,actor:&SensorActor,enemy:&SensorActor,time:f64)->Contact {
        if actor.team==enemy.team {
            let b=enemy.bounds;let v=enemy.vehicle.unwrap_or_default();
            return Contact {detected:true,visible:true,source:ContactSource::Team,classification:ContactClassification::Identified,
                confidence:1.0,time,x:(b.min_x+b.max_x)*0.5,y:(b.min_y+b.max_y)*0.5,
                width:b.max_x-b.min_x,height:b.max_y-b.min_y,vx:v.vx,vy:v.vy,source_actor:Some(enemy.handle),..Default::default()};
        }
        self.remembered_contact(actor.handle,enemy.handle,time).unwrap_or_else(||Contact {
            age:MEMORY_SECONDS,uncertainty:100.0,x:position(actor).x+facing(actor)*40.0,y:position(actor).y,..Default::default()})
    }
    /// What each team sees and holds of the constructions of the others, for a host that shows a team no
    /// more than that: the teams in the order of the field and, for each, the constructions in that order.
    /// It is asked many times a second, and has the sensors read only when nothing else read them for
    /// `SIGHT_READING`: the vehicles that decide read them as often as they need. What a reading holds by
    /// radar or by ear is told as the reading has it. A sight is found by a reading, any sensor's, with the
    /// cameras of the team that reach the construction, and is then kept by the camera that has it for as
    /// long as one line of its runs clear; when that camera loses it the others look, once. So a call
    /// costs a line for each construction in sight, a sight ends on the call that finds it gone, and what
    /// comes into sight is told with the next reading.
    /// `ghosts` are the places where a team last saw a construction it sees no longer. Those a camera of
    /// that team now sees empty are named by their place in the list. One camera looks at each on a call,
    /// each camera in reach in its turn: a ghost is in no hurry.
    pub fn team_sight(&mut self,view:&SensorView,ghosts:&[(String,Point)])->(Vec<(String,Vec<Sight>)>,Vec<usize>) {
        if self.time.is_none_or(|t|view.time-t>=SIGHT_READING-0.00001) {self.sample(view);}
        let read=self.looked!=self.time;
        self.looked=self.time;self.turn=self.turn.wrapping_add(1);
        let mut cameras=observer_camera_groups(view);
        for cameras in cameras.values_mut() {
            if let Some(cameras)=cameras { cameras.retain(|camera|camera.mode==SensorMode::Visual); }
        }
        let feeds:Vec<(&SensorActor,&[Camera])>=view.actors.iter().filter_map(|a|cameras.get(&a.handle)
            .and_then(|cameras|cameras.as_deref()).map(|cameras|(a,cameras)))
            .filter(|(_,cameras)|!cameras.is_empty()).collect();
        let alliances = &self.alliances;
        let mut teams:Vec<String>=Vec::new();
        for a in view.actors {if !teams.contains(&a.team) {teams.push(a.team.clone());}}
        for (a,b) in alliances { for name in [a,b] { if !teams.contains(name) { teams.push(name.clone()); } } }
        let mut sight:Vec<(String,Vec<Sight>)>=Vec::new();
        for team in teams {
            let mut told=Vec::new();
            let receiver = team.as_str();
            let own=||feeds.iter().filter(move |(a,_)|intelligence_source(alliances,receiver,&a.team));
            for enemy in view.actors.iter().filter(|a|a.team!=team) {
                let key=(team.to_owned(),enemy.handle);
                let reading=self.contacts.get(&key);let fresh=self.fresh.contains(&key);
                if let Some(c)=reading.map(|r|&r.contact) {
                    if let Some(channel)=c.channel.filter(|channel|*channel!=ContactSource::Visual && !enemy.defeated) {
                        told.push(Sight {target:enemy.handle,channel,visible:fresh,x:c.x,y:c.y,error:c.uncertainty,
                            age:(view.time-c.time).max(0.0),by:c.source_actor,sound:reading.and_then(|r|r.sound.clone())});
                    }
                }
                let sees=|actor:u32,camera:u32|own().find(|(a,_)|a.handle==actor)
                    .and_then(|(_,cameras)|cameras.iter().find(|c|c.handle==camera)).is_some_and(|c|in_view(view,c,actor,enemy));
                let had=self.sights.get(&key).copied();
                let mut eye=had.filter(|(actor,camera)|sees(*actor,*camera));
                if eye.is_none() && (had.is_some() || read && fresh) {
                    // The camera of the reading looks first, when a camera took it: it has the construction.
                    let taken=reading.filter(|_|read && fresh).and_then(|r|r.contact.source_actor.map(|actor|(actor,r.sensor)));
                    eye=taken.filter(|at|Some(*at)!=had && sees(at.0,at.1)).or_else(||own().find_map(|(a,cameras)|cameras.iter()
                        .find(|c|Some((a.handle,c.handle))!=had && Some((a.handle,c.handle))!=taken && in_view(view,c,a.handle,enemy))
                        .map(|c|(a.handle,c.handle))));
                }
                match eye {
                    Some(at)=>{
                        self.sights.insert(key,at);let b=enemy.bounds;
                        told.push(Sight {target:enemy.handle,channel:ContactSource::Visual,visible:true,
                            x:(b.min_x+b.max_x)*0.5,y:(b.min_y+b.max_y)*0.5,error:0.0,age:0.0,by:Some(at.0),sound:None});
                    }
                    None=>{self.sights.remove(&key);}
                }
            }
            if !told.is_empty() {sight.push((team.to_owned(),told));}
        }
        let mut cleared=Vec::new();
        for (index,(team,at)) in ghosts.iter().enumerate() {
            if !(at.x+at.y).is_finite() {continue;}
            let reach:Vec<(u32,&Camera)>=feeds.iter().filter(|(a,_)|intelligence_source(alliances,team,&a.team))
                .flat_map(|(a,cameras)|cameras.iter().map(move |c|(a.handle,c)))
                .filter(|(_,c)|hypot(at.x-c.origin.x,at.y-c.origin.y)+GHOST_REACH<=c.range*view.weather.optical().0).collect();
            if reach.is_empty() {continue;}
            let (observer,camera)=reach[(self.turn+index)%reach.len()];
            if sees_place(view,camera,*at,observer) {cleared.push(index);}
        }
        (sight,cleared)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Mutex, atomic::{AtomicUsize, Ordering}};
    struct Ground { wall: bool }
    impl SensorQuery for Ground {
        fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {
            if a.y>=0.0 && b.y<0.0 {let t=a.y/(a.y-b.y);Some(SensorHit {enter:t,
                point:Point::new(a.x+(b.x-a.x)*t,0.0),normal:Point::new(0.0,1.0),actor:None})}else{None}
        }
        fn material_raycast(&self,a:Point,b:Point,_:u32,_:Option<Wave>)->Option<SensorHit> {
            if self.wall && a.x<20.0 && b.x>20.0 {let t=(20.0-a.x)/(b.x-a.x);Some(SensorHit {enter:t,
                point:Point::new(20.0,a.y+(b.y-a.y)*t),normal:Point::new(-1.0,0.0),actor:Some(9)})}else{None}
        }
    }
    fn actor(handle:u32,x:f64,team:&str)->SensorActor {
        SensorActor {handle,id:format!("actor{handle}"),team:team.into(),defeated:false,facing:1.0,x,y:1.0,shots:0,
            bounds:Bounds{min_x:x-1.0,max_x:x+1.0,min_y:0.0,max_y:2.0},vehicle:None}
    }
    fn sensor(actor:u32,mode:SensorMode,x:f64)->SensorModule {
        SensorModule {handle:actor,actor,kind:ComponentKind::Sensor,health:10.0,x,y:2.0,sensor_mode:mode,..Default::default()}
    }
    fn view<'a>(actors:&'a [SensorActor],modules:&'a [SensorModule],query:&'a dyn SensorQuery,time:f64)->SensorView<'a> {
        SensorView {actors,modules,query,time,seed:6173,weather:SensorWeather::Clear}
    }
    #[test]
    fn duplicate_enemy_handles_keep_the_received_contact_chain_for_direct_allies() {
        for mode in [SensorMode::Visual,SensorMode::Radar,SensorMode::Sound] {
            let mut actors=[actor(1,0.0,"blue"),actor(2,50.0,"red"),actor(2,100.0,"red")];
            actors[1].shots=1;actors[2].shots=1;actors[2].id="another occurrence".into();
            let modules=[sensor(1,mode,0.0)];let query=Ground{wall:false};
            let mut first=SensorMemory::default();let mut both=SensorMemory::default();
            for memory in [&mut first,&mut both] {memory.set_alliances(vec![("blue".into(),"green".into())]);}
            first.sample(&view(&actors[..2],&modules,&query,0.0));
            both.sample(&view(&actors,&modules,&query,0.0));
            assert_eq!(both.contacts,first.contacts,"the later occurrence keeps the fresh reading received from the first: {mode:?}");
            assert_eq!(both.fresh,first.fresh);
            for team in ["blue","green"] {
                let key=(team.to_owned(),2);
                assert_eq!(both.contacts[&key].contact.x.to_bits(),first.contacts[&key].contact.x.to_bits());
            }
        }
    }

    #[test]
    fn sampled_contacts_keep_public_validation_team_readings_and_absent_contacts() {
        let actors=[actor(1,0.0,"blue"),actor(2,50.0,"blue"),actor(3,100.0,"red"),actor(4,9000.0,"red")];
        let modules=[sensor(1,SensorMode::Visual,0.0)];let query=Ground{wall:false};
        let v=view(&actors,&modules,&query,0.0);let mut memory=SensorMemory::default();
        for (observer,target) in [(99,3),(1,99)] {
            assert_eq!(memory.sense_combat(&v,observer,target).err().unwrap(),"Participante do sensor não encontrado.");
            assert!(memory.time.is_none(), "an invalid query takes no reading");
        }
        // The public query still takes a reading; the pilot takes it once through sense_terrain instead.
        assert!(memory.sense_combat(&v,1,3).unwrap().visible);
        let mut pilot_memory=SensorMemory::default();
        pilot_memory.sense_terrain(&v,1).unwrap();
        for enemy in &actors[1..] {
            let projected=pilot_memory.sampled_contact(&actors[0],enemy,v.time);
            assert_eq!(projected.to_value(),memory.sense_combat(&v,1,enemy.handle).unwrap().to_value());
        }
        let ally=pilot_memory.sampled_contact(&actors[0],&actors[1],v.time);
        assert_eq!((ally.source,ally.classification,ally.x,ally.source_actor),
            (ContactSource::Team,ContactClassification::Identified,50.0,Some(2)));
        let absent=pilot_memory.sampled_contact(&actors[0],&actors[3],v.time);
        assert!(!absent.detected);
        assert_eq!((absent.source,absent.age,absent.uncertainty,absent.x,absent.y),
            (ContactSource::None,MEMORY_SECONDS,100.0,40.0,1.0));
    }
    #[test]
    fn observer_cameras_keep_empty_actors_stable_ties_and_late_command_failures() {
        let actors=[actor(1,0.0,"blue"),actor(2,100.0,"red"),actor(3,0.0,"empty")];
        let mut modules=[
            SensorModule {handle:30,range:500.0,y:4.0,..sensor(1,SensorMode::Visual,0.0)},
            SensorModule {handle:40,..sensor(1,SensorMode::Visual,0.0)},
            SensorModule {handle:10,..sensor(1,SensorMode::Visual,0.0)},
            SensorModule {handle:20,kind:ComponentKind::Command,..sensor(1,SensorMode::Visual,0.0)},
        ];
        let query=Ground{wall:false};let v=view(&actors,&modules,&query,0.0);
        assert!(observer_cameras(&v,&actors[2]).unwrap().is_empty(), "an active actor may have no camera");
        assert_eq!(observer_cameras(&v,&actors[0]).unwrap().iter().map(|c|c.handle).collect::<Vec<_>>(),vec![40,10,30,20]);
        let mut memory=SensorMemory::default();
        assert!(memory.sense_combat(&v,1,2).unwrap().visible);
        assert_eq!(memory.contacts[&("blue".into(),2)].sensor,40, "equal cameras retain their module order");
        // The failed command comes after working sensors: none may observe for the actor now.
        modules[3].health=0.0;
        let v=view(&actors,&modules,&query,0.1);
        assert!(observer_cameras(&v,&actors[0]).is_none());
        assert!(!memory.sees(&v,1,2));
        let remembered=memory.sense_combat(&v,1,2).unwrap();
        assert!(!remembered.visible);
        assert_eq!(remembered.source,ContactSource::Memory);
        assert!(memory.team_sight(&v,&[]).0.is_empty());
    }
    #[test]
    fn grouped_cameras_match_scalar_feeds_with_interleaved_and_duplicate_handles() {
        let actors=[actor(7,0.0,"blue"),actor(2,100.0,"red"),actor(9,0.0,"empty"),
            actor(7,30.0,"duplicate"),actor(4,0.0,"blocked")];
        let mut modules=[
            covered(SensorModule {handle:40,..sensor(7,SensorMode::Visual,0.0)},&[]),
            SensorModule {handle:20,..sensor(2,SensorMode::Radar,100.0)},
            SensorModule {handle:11,..sensor(4,SensorMode::Visual,0.0)},
            SensorModule {handle:40,..sensor(7,SensorMode::Visual,20.0)},
            sensor(77,SensorMode::Visual,0.0),
            SensorModule {handle:21,..sensor(2,SensorMode::Sound,100.0)},
            SensorModule {handle:70,kind:ComponentKind::Command,..sensor(7,SensorMode::Visual,0.0)},
            SensorModule {handle:10,range:500.0,..sensor(7,SensorMode::Visual,0.0)},
            SensorModule {handle:41,kind:ComponentKind::Command,health:0.0,..sensor(4,SensorMode::Visual,0.0)},
            SensorModule {handle:12,..sensor(4,SensorMode::Visual,0.0)},
            SensorModule {kind:ComponentKind::Command,health:0.0,..sensor(77,SensorMode::Visual,0.0)},
            SensorModule {handle:60,range:700.0,..sensor(7,SensorMode::Radar,0.0)},
            SensorModule {handle:22,kind:ComponentKind::Command,..sensor(2,SensorMode::Visual,100.0)},
            SensorModule {handle:42,kind:ComponentKind::Command,..sensor(4,SensorMode::Visual,0.0)},
        ];
        let keys=|cameras:Option<&[Camera]>|cameras.map(|cameras|cameras.iter().map(|c|(
            c.handle,c.mode,c.command,[c.origin.x,c.origin.y,c.range,c.identify_range,c.terrain_range,c.precision,c.turn].map(f64::to_bits),
            c.cover.as_ref().map(Arc::as_ptr))).collect::<Vec<_>>());
        let query=Ground{wall:false};
        for state in 0..4 {
            modules[6].health=if state==1 {0.0}else{10.0};
            modules[6].attached=state!=2;modules[6].detonated=state==3;
            let v=view(&actors,&modules,&query,0.0);let mut groups=observer_camera_groups(&v);
            assert_eq!(groups.len(),4,"duplicate actors share cameras; orphan modules create no group");
            for actor in &actors {
                // The single-observer path still filters the original module slice, without the grouping index.
                let scalar=observer_cameras(&v,actor);
                assert_eq!(keys(groups[&actor.handle].as_deref()),keys(scalar.as_deref()),"actor {} / state {state}",actor.handle);
            }
            assert!(groups[&9].as_ref().unwrap().is_empty());
            assert!(groups[&4].is_none(),"a later working camera or command cannot revive a failed command");
            let active:Vec<_>=actors.iter().enumerate().filter(|(_,a)|groups[&a.handle].is_some()).map(|(i,_)|i).collect();
            assert_eq!(active,if state==0 {vec![0,1,2,3]}else{vec![1,2]},"feeds retain both duplicate actors and the empty actor");
            if state==0 {
                assert_eq!(groups[&7].as_ref().unwrap().iter().map(|c|c.handle).collect::<Vec<_>>(),[40,40,60,10,70]);
            }
            for cameras in groups.values_mut() {
                if let Some(cameras)=cameras {cameras.retain(|c|c.mode==SensorMode::Visual);}
            }
            for actor in &actors {
                let scalar=observer_cameras(&v,actor).map(|mut cameras|{cameras.retain(|c|c.mode==SensorMode::Visual);cameras});
                assert_eq!(keys(groups[&actor.handle].as_deref()),keys(scalar.as_deref()));
            }
            let visual:Vec<_>=actors.iter().enumerate().filter(|(_,a)|groups[&a.handle].as_ref().is_some_and(|c|!c.is_empty())).map(|(i,_)|i).collect();
            assert_eq!(visual,if state==0 {vec![0,1,3]}else{vec![1]});
        }
    }
    #[test]
    fn dedicated_sensor_detection_obeys_its_range_weather_and_obstructions_at_the_boundary() {
        let read=|mode,distance,weather,wall| {
            let mut enemy=actor(2,distance,"red");
            enemy.bounds=Bounds{min_x:distance-2.0,max_x:distance+2.0,min_y:1.0,max_y:3.0};
            let actors=[actor(1,0.0,"blue"),enemy];let modules=[sensor(1,mode,0.0)];let q=Ground{wall};
            let mut v=view(&actors,&modules,&q,0.0);v.weather=weather;
            measure(&v,&actors[0],&actors[1],&modules[0].camera().unwrap(),1.0,None)
        };
        for (mode,weather,reach) in [(SensorMode::Visual,SensorWeather::Clear,4000.0),
            (SensorMode::Visual,SensorWeather::Haze,3200.0),(SensorMode::Visual,SensorWeather::Mist,1800.0),
            (SensorMode::Radar,SensorWeather::Clear,8000.0),(SensorMode::Radar,SensorWeather::Mist,8000.0)] {
            for offset in [-0.01,0.0,0.01] {
                let measured=read(mode,reach+offset,weather,false);
                assert_eq!(measured.is_some(),offset<=0.0,"{mode:?}/{weather:?} at {}",reach+offset);
                if let Some(m)=measured {if mode==SensorMode::Radar {
                    assert_eq!(m.contact.classification,ContactClassification::Estimated);
                    assert_eq!((m.contact.width,m.contact.height),(0.0,0.0));
                }}
            }
            assert!(read(mode,reach-10.0,weather,true).is_none(),"{mode:?}: an obstacle still hides the target");
        }
        // A saved or scripted shorter range stays shorter, and an oversized one grants no extra reach.
        for (mode,reach) in [(SensorMode::Visual,4000.0),(SensorMode::Radar,8000.0)] {
            assert_eq!(SensorModule{range:100000.0,..sensor(1,mode,0.0)}.camera().unwrap().range,reach);
            assert_eq!(SensorModule{range:500.0,..sensor(1,mode,0.0)}.camera().unwrap().range,500.0);
        }
        let command=SensorModule{kind:ComponentKind::Command,..sensor(1,SensorMode::Visual,0.0)}.camera().unwrap();
        assert_eq!((command.range,command.identify_range,command.terrain_range),(650.0,220.0,80.0));
        assert_eq!(sensor(1,SensorMode::Visual,0.0).camera().unwrap().terrain_range,400.0);
        assert_eq!(SensorMode::Sound.config(),(1200.0,0.5,3.0));
    }
    #[test]
    fn dedicated_optical_identification_is_capped_at_fifteen_hundred_metres_with_existing_penalties() {
        let read=|distance,width,height,weather,command| {
            let mut enemy=actor(2,distance,"red");
            enemy.bounds=Bounds{min_x:distance-width/2.0,max_x:distance+width/2.0,min_y:2.0-height/2.0,max_y:2.0+height/2.0};
            let actors=[actor(1,0.0,"blue"),enemy];let mut module=sensor(1,SensorMode::Visual,0.0);
            if command {module.kind=ComponentKind::Command;}
            let modules=[module];let q=Ground{wall:false};let mut v=view(&actors,&modules,&q,0.0);v.weather=weather;
            measure(&v,&actors[0],&actors[1],&modules[0].camera().unwrap(),0.0,None).unwrap().contact
        };
        // Large silhouettes no longer push a dedicated optic past its specified identification ceiling.
        for (width,height) in [(4.0,2.0),(8.0,4.0)] {
            for (weather,reach) in [(SensorWeather::Clear,1500.0),(SensorWeather::Haze,975.0),(SensorWeather::Mist,525.0)] {
                for offset in [-0.01,0.0,0.01] {
                    let c=read(reach+offset,width,height,weather,false);
                    assert_eq!(c.classification==ContactClassification::Identified,offset<=0.0,
                        "{width}x{height}/{weather:?} at {}",reach+offset);
                    assert!(c.detected&&c.visible);
                    for hidden in ["health","fuel","ammo","modules"] {assert!(c.to_value().get(hidden).is_none());}
                }
            }
        }
        // A small target retains its silhouette penalty; the command post retains its original basic optic.
        for offset in [-0.01,0.0,0.01] {
            assert_eq!(read(750.0+offset,0.5,0.5,SensorWeather::Clear,false).classification==ContactClassification::Identified,offset<=0.0);
            assert_eq!(read(330.0+offset,8.0,4.0,SensorWeather::Clear,true).classification==ContactClassification::Identified,offset<=0.0);
        }
    }
    #[test]
    fn sharing_is_immediate_with_identical_silhouette_position_and_age() {
        let actors=[actor(1,0.0,"blue"),actor(2,-1700.0,"blue"),actor(3,100.0,"red")];
        let modules=[sensor(1,SensorMode::Visual,0.0)];let q=Ground{wall:false};let mut memory=SensorMemory::default();
        let v=view(&actors,&modules,&q,0.0);
        let (a,b)=(memory.sense_combat(&v,1,3).unwrap(),memory.sense_combat(&v,2,3).unwrap());
        assert_eq!(a.to_value(),b.to_value());assert_eq!(a.source,ContactSource::Team);assert_eq!(a.channel,Some(ContactSource::Visual));
        assert_eq!(a.source_actor,Some(1));assert_eq!(a.classification,ContactClassification::Identified);assert_eq!(a.age,0.0);
        for forbidden in ["health","fuel","ammo","modules","command"] {assert!(a.to_value().get(forbidden).is_none());}
    }
    #[test]
    fn a_track_settles_on_a_still_construction_and_follows_one_that_drives_off() {
        let mut actors=[actor(1,0.0,"blue"),actor(2,800.0,"red")];
        let modules=[sensor(1,SensorMode::Radar,0.0)];let q=Ground{wall:false};let mut memory=SensorMemory::default();
        let mut read=|actors:&[SensorActor],time:f64| memory.sense_combat(&view(actors,&modules,&q,time),1,2).unwrap();
        let first=read(&actors,0.0);
        let still:Vec<Contact>=(1..=100).map(|step|read(&actors,step as f64*0.2)).collect();
        let mean=|values:&mut dyn Iterator<Item=f64>|{let v:Vec<f64>=values.collect();v.iter().sum::<f64>()/v.len() as f64};
        // A radar 800 m off: a reading is off by up to 11 m. Ten seconds on, the track is less than half that, and still.
        let settled=&still[50..];
        assert!(settled.iter().all(|c|c.uncertainty<first.uncertainty*0.5));
        assert!(mean(&mut settled.iter().map(|c|(c.x-800.0).abs()))<first.uncertainty*0.25);
        assert!(mean(&mut settled.iter().map(|c|c.vx.abs()))<1.0);
        // The speed it shows stays within what the noise of its readings makes up: a gun takes it for standing still.
        let noise=speed_noise(ContactSource::Radar,settled[0].uncertainty);
        assert!(noise>0.3 && noise<2.0,"{noise}");
        assert!(settled.iter().filter(|c|c.vx.abs()>2.0*noise).count()<settled.len()/10);
        // It drives off at 8 m/s: within a few seconds the track goes with it.
        let driving:Vec<Contact>=(101..=200).map(|step| {
            let x=800.0+8.0*(step-100) as f64*0.2;
            actors[1].x=x;actors[1].bounds.min_x=x-1.0;actors[1].bounds.max_x=x+1.0;
            read(&actors,step as f64*0.2)
        }).collect();
        assert!(mean(&mut driving[50..].iter().map(|c|(c.vx-8.0).abs()))<1.5);
        assert!(driving[50..].iter().all(|c|c.vx>2.0*speed_noise(ContactSource::Radar,c.uncertainty)));
    }
    #[test]
    fn a_track_follows_an_aircraft_faster_than_anything_goes_on_the_ground() {
        // A radar has a construction 800 m off cross the field at 60 m/s: 100 m up, its track goes as fast; on the ground
        // it is held to what drives there (`GROUND_SPEED`).
        for (up,most) in [(100.0,60.0),(0.0,GROUND_SPEED.0)] {
            let mut actors=[actor(1,0.0,"blue"),actor(2,800.0,"red")];
            let modules=[sensor(1,SensorMode::Radar,0.0)];let q=Ground{wall:false};let mut memory=SensorMemory::default();
            let speeds:Vec<f64>=(0..=100).map(|step| {
                let x=800.0+60.0*step as f64*0.2;
                actors[1].x=x;actors[1].bounds=Bounds{min_x:x-1.0,max_x:x+1.0,min_y:up,max_y:up+2.0};actors[1].y=up+1.0;
                memory.sense_combat(&view(&actors,&modules,&q,step as f64*0.2),1,2).unwrap().vx
            }).collect();
            let late=speeds[50..].iter().sum::<f64>()/speeds[50..].len() as f64;
            assert!((late-most).abs()<2.0,"{up} m up: {late} m/s");
        }
    }
    #[test]
    fn a_pilot_sees_a_target_with_an_optic_or_a_radar_of_its_own_and_not_with_a_friend_s() {
        let actors=[actor(1,0.0,"blue"),actor(2,-100.0,"blue"),actor(3,100.0,"red")];
        let memory=SensorMemory::default();
        let sees=|mode,wall,observer| memory.sees(&view(&actors,&[sensor(1,mode,0.0)],&Ground{wall},0.0),observer,3);
        assert!(sees(SensorMode::Visual,false,1));
        assert!(!sees(SensorMode::Visual,false,2));
        assert!(!sees(SensorMode::Visual,true,1));
        assert!(sees(SensorMode::Radar,false,1));
        assert!(!sees(SensorMode::Sound,false,1));
    }
    #[test]
    fn what_a_reading_saw_is_in_sight_until_the_next_reading() {
        let actors=[actor(1,0.0,"blue"),actor(3,100.0,"red")];
        let modules=[sensor(1,SensorMode::Visual,0.0)];let mut memory=SensorMemory::default();
        let first=memory.sense_combat(&view(&actors,&modules,&Ground{wall:false},0.0),1,3).unwrap();
        assert!(first.visible);assert_eq!(first.source,ContactSource::Team);
        // A round of decisions dealt over the steps that follow goes by the same reading: a step on, it is no memory yet.
        let next=memory.sense_combat(&view(&actors,&modules,&Ground{wall:true},1.0/60.0),1,3).unwrap();
        assert!(next.visible);assert_eq!(next.source,ContactSource::Team);assert_eq!(next.age,1.0/60.0);
        assert_eq!((next.x,next.y),(first.x,first.y));
        // Hidden when the next reading is taken, it is a memory from then on.
        let hidden=memory.sense_combat(&view(&actors,&modules,&Ground{wall:true},0.1),1,3).unwrap();
        assert!(!hidden.visible);assert_eq!(hidden.source,ContactSource::Memory);assert_eq!(hidden.age,0.1);
    }
    #[test]
    fn hidden_pose_silhouette_and_internal_health_cannot_refresh_team_fog() {
        let mut actors=[actor(1,0.0,"blue"),actor(2,-100.0,"blue"),actor(3,100.0,"red")];
        let mut modules=[sensor(1,SensorMode::Visual,0.0),SensorModule {handle:30,actor:3,
            kind:ComponentKind::Ammo,health:80.0,..Default::default()}];let mut memory=SensorMemory::default();
        let original=memory.sense_combat(&view(&actors,&modules,&Ground{wall:false},0.0),1,3).unwrap();
        actors[2].x=900.0;actors[2].bounds.min_x=800.0;actors[2].bounds.max_x=950.0;
        actors[2].bounds.max_y=30.0;actors[2].vehicle=Some(VehicleReading{vx:100.0,engine:true,..Default::default()});
        modules[1].health=0.0;
        for observer in [1,2] {
            let c=memory.sense_combat(&view(&actors,&modules,&Ground{wall:true},0.5),observer,3).unwrap();
            assert_eq!((c.x,c.y,c.width,c.height,c.vx,c.vy),(original.x,original.y,original.width,original.height,original.vx,original.vy));
            assert_eq!(c.source,ContactSource::Memory);assert_eq!(c.age,0.5);assert!(!c.visible);
            assert!(c.confidence<original.confidence && c.uncertainty>original.uncertainty);
        }
        modules[0].health=0.0;
        let blind=memory.sense_combat(&view(&actors,&modules,&Ground{wall:false},0.7),2,3).unwrap();
        assert_eq!(blind.x,original.x);assert_eq!(blind.age,0.7);assert_eq!(blind.source,ContactSource::Memory);
        assert!(!memory.sense_combat(&view(&actors,&modules,&Ground{wall:false},2.1),2,3).unwrap().detected);
    }
    #[test]
    fn a_reading_ages_down_its_classification_and_never_up() {
        for (mode,taken) in [(SensorMode::Visual,ContactClassification::Identified),(SensorMode::Radar,ContactClassification::Estimated)] {
            let actors=[actor(1,0.0,"blue"),actor(2,300.0,"red")];let mut modules=[sensor(1,mode,0.0)];
            let q=Ground{wall:false};let mut memory=SensorMemory::default();
            let mut read=|modules:&[SensorModule],time:f64|memory.sense_combat(&view(&actors,modules,&q,time),1,2).unwrap().classification;
            assert_eq!(read(&modules,0.0),taken,"{mode:?}");
            // With the sensor gone, what it identified is an estimate the moment it is a memory, and then barely held.
            modules[0].health=0.0;
            assert_eq!(read(&modules,0.2),ContactClassification::Estimated,"{mode:?}");
            assert_eq!(read(&modules,1.5),ContactClassification::Detected,"{mode:?}");
            assert_eq!(read(&modules,2.1),ContactClassification::None,"{mode:?}");
        }
    }
    #[test]
    fn every_channel_obeys_obstruction_and_range_and_sound_never_reveals_silhouette() {
        for mode in [SensorMode::Visual,SensorMode::Radar,SensorMode::Sound] {
            let mut actors=[actor(1,0.0,"blue"),actor(2,100.0,"red")];actors[1].shots=1;
            let modules=[sensor(1,mode,0.0)];
            // A construction between them, of the observer's faction or another (`Ground::wall`, actor 9): a camera
            // and a radar see nothing past it, a microphone hears round it. The ground between shuts off all three.
            assert_eq!(SensorMemory::default().sense_combat(&view(&actors,&modules,&Ground{wall:true},0.0),1,2).unwrap().detected,mode==SensorMode::Sound,"{mode:?}");
            assert!(!SensorMemory::default().sense_combat(&view(&actors,&modules,&Ridge(50.0),0.0),1,2).unwrap().detected,"{mode:?}");
            let c=SensorMemory::default().sense_combat(&view(&actors,&modules,&Ground{wall:false},0.0),1,2).unwrap();assert!(c.detected);
            if mode!=SensorMode::Visual {assert_eq!((c.width,c.height),(0.0,0.0));}
            if mode==SensorMode::Sound {assert_eq!((c.vx,c.vy),(0.0,0.0));assert_eq!(c.classification,ContactClassification::Detected);}
            actors[1].bounds.min_x=8100.0;actors[1].bounds.max_x=8102.0;
            assert!(!SensorMemory::default().sense_combat(&view(&actors,&modules,&Ground{wall:false},0.0),1,2).unwrap().detected);
        }
    }
    #[test]
    fn destroyed_detached_or_detonated_observers_stop_new_measurements() {
        // A construction out of the fight has its sensors detached: they stand as one torn off.
        for failure in [0,1,2] {
            let actors=[actor(1,0.0,"blue"),actor(2,-1700.0,"blue"),actor(3,100.0,"red")];
            let mut modules=[sensor(1,SensorMode::Visual,0.0)];let q=Ground{wall:false};let mut memory=SensorMemory::default();
            memory.sense_combat(&view(&actors,&modules,&q,0.0),1,3).unwrap();
            match failure {0=>modules[0].health=0.0,1=>modules[0].attached=false,_=>modules[0].detonated=true}
            let c=memory.sense_combat(&view(&actors,&modules,&q,0.2),2,3).unwrap();
            assert_eq!(c.source,ContactSource::Memory);assert_eq!(c.age,0.2);
        }
    }
    #[test]
    fn terrain_is_shared_with_measured_origin_and_preserves_memory_age_after_camera_loss() {
        let actors=[actor(1,0.0,"blue"),actor(2,-100.0,"blue")];let mut modules=[sensor(1,SensorMode::Visual,0.0)];
        let q=Ground{wall:false};let mut memory=SensorMemory::default();
        let own=memory.sense_terrain(&view(&actors,&modules,&q,0.0),1).unwrap();
        let shared=memory.sense_terrain(&view(&actors,&modules,&q,0.0),2).unwrap();
        assert_eq!(own.samples.len(),28);assert!(shared.samples.iter().all(|s|s.fresh));
        assert_eq!(own.origin,shared.origin);assert_eq!(json!(own.samples),json!(shared.samples));
        assert_eq!(memory.observed_terrain(&view(&actors,&modules,&q,0.0),2).unwrap().height(5.0),Some(0.0));
        modules[0].health=0.0;
        let remembered=memory.sense_terrain(&view(&actors,&modules,&q,0.5),2).unwrap();
        for (a,b) in own.samples.iter().zip(&remembered.samples) {assert_eq!((a.x,a.y),(b.x,b.y));assert_eq!(b.age,0.5);assert!(!b.fresh);}
        let expired=memory.sense_terrain(&view(&actors,&modules,&q,60.1),2).unwrap();assert!(expired.samples.iter().all(|s|!s.known));
    }
    #[test]
    fn terrain_freshness_requires_a_new_measurement_and_a_blind_ally_can_receive_one() {
        let actors=[actor(1,0.0,"blue"),actor(2,-100.0,"blue")];let mut modules=[sensor(1,SensorMode::Visual,0.0)];
        let q=Ground{wall:false};let mut memory=SensorMemory::default();
        let original=memory.sense_terrain(&view(&actors,&modules,&q,0.0),1).unwrap();
        assert!(original.samples.iter().all(|s|s.fresh));
        modules[0].health=0.0;
        for time in [1.0/60.0,0.1] {
            for observer in [1,2] {
                let old=memory.sense_terrain(&view(&actors,&modules,&q,time),observer).unwrap();
                for (a,b) in original.samples.iter().zip(old.samples.iter()) {
                    assert_eq!((a.x,a.y),(b.x,b.y));assert_eq!(b.age,time);assert!(!b.fresh);
                }
            }
        }
        modules[0].health=10.0;
        let shared=memory.sense_terrain(&view(&actors,&modules,&q,0.2),2).unwrap();
        assert_eq!(shared.origin,original.origin);assert!(shared.samples.iter().all(|s|s.fresh&&s.age==0.0));
    }
    #[test]
    fn terrain_panorama_stops_at_first_obstacle_and_unknown_ground_stays_unknown() {
        let actors=[actor(1,0.0,"blue")];let modules=[sensor(1,SensorMode::Visual,0.0)];let q=Ground{wall:true};let mut memory=SensorMemory::default();
        let reading=memory.sense_terrain(&view(&actors,&modules,&q,0.0),1).unwrap();
        assert!(reading.samples[..14].iter().all(|s|s.x<=20.0+1e-8));
        assert!(memory.observed_terrain(&view(&actors,&modules,&q,0.0),1).unwrap().height(30.0).is_none());
    }
    #[test]
    fn an_optic_high_over_the_ground_reads_the_ground_within_its_circle_and_one_on_it_as_far_as_its_terrain_range() {
        let q=Ground{wall:false};
        let read=|height:f64| {
            let actors=[actor(1,0.0,"blue")];let modules=[SensorModule{y:height,..sensor(1,SensorMode::Visual,0.0)}];
            let mut memory=SensorMemory::default();
            let reading=memory.sense_terrain(&view(&actors,&modules,&q,0.0),1).unwrap();
            let observed=memory.observed_terrain(&view(&actors,&modules,&q,0.0),1).unwrap();
            let heights:Vec<_>=[0.0,300.0,-560.0,1500.0,3000.0,5000.0].iter().map(|x|observed.height(*x)).collect();
            (reading.samples.iter().filter(|s|s.hit).map(|s|(s.x,s.y)).collect::<Vec<_>>(),heights)
        };
        // Two metres up, as before: every line under the level meets the ground short of the terrain range, 400 m.
        let (hits,_)=read(2.0);
        assert_eq!(hits.len(),20);assert!(hits.iter().all(|(x,y)|x.abs()<400.0 && *y==0.0));
        // A kilometre up its lines run out to its range, 4 km, and those steeper than 14.5° meet the ground within it: 20°, 35°,
        // 60° and 85°, to each side. It holds the ground under it and about it, where two readings stand close enough to run
        // straight between, and nothing past what it read.
        let (hits,heights)=read(1000.0);
        assert_eq!(hits.len(),8);
        assert!(hits.iter().all(|(x,y)|*y==0.0 && hypot(*x,1000.0)<=4000.0+1e-6));
        assert!(hits.iter().any(|(x,_)|(x.abs()-1000.0/20.0_f64.to_radians().tan()).abs()<1e-6),"the line at 20° meets the ground 2.7 km off");
        assert_eq!(heights,[Some(0.0),Some(0.0),Some(0.0),None,None,None]);
        // Higher over the ground than it sees: no ground at all.
        let (hits,heights)=read(5000.0);
        assert!(hits.is_empty());assert!(heights.iter().all(Option::is_none));
    }
    #[test]
    fn a_sensor_holds_what_lies_within_its_circle_up_and_down_alike() {
        let q=Ground{wall:false};
        let detected=|mode:SensorMode,eye:f64,x:f64,y:f64| {
            let mut enemy=actor(2,x,"red");enemy.bounds=Bounds{min_x:x-2.0,max_x:x+2.0,min_y:y-1.0,max_y:y+1.0};
            let actors=[actor(1,0.0,"blue"),enemy];let modules=[SensorModule{y:eye,..sensor(1,mode,0.0)}];
            SensorMemory::default().sense_combat(&view(&actors,&modules,&q,0.0),1,2).unwrap().detected
        };
        // A radar on the ground holds an aircraft within its eight kilometres, overhead as out along the field, and none past them.
        assert!(detected(SensorMode::Radar,2.0,0.0,7900.0));assert!(!detected(SensorMode::Radar,2.0,0.0,8100.0));
        assert!(detected(SensorMode::Radar,2.0,5000.0,6000.0));assert!(!detected(SensorMode::Radar,2.0,6000.0,6000.0));
        // An optic 2 km up sees a construction on the ground within 4 km of it, 3.46 km along the field at the most; one 5 km up, none.
        assert!(detected(SensorMode::Visual,2000.0,3400.0,1.0));assert!(!detected(SensorMode::Visual,2000.0,3500.0,1.0));
        assert!(!detected(SensorMode::Visual,5000.0,0.0,1.0));
    }
    #[test]
    fn terrain_history_is_bounded_and_cold_replacement_invalidates_measured_actors() {
        let mut actors=[actor(1,0.0,"blue"),actor(2,-100.0,"blue"),actor(3,100.0,"red")];
        let mut modules=[sensor(1,SensorMode::Visual,0.0)];let q=Ground{wall:false};let mut memory=SensorMemory::default();
        for i in 0..20 {actors[0].x=i as f64*10.0;modules[0].x=actors[0].x;
            memory.sense_terrain(&view(&actors,&modules,&q,i as f64*0.1),1).unwrap();}
        assert_eq!(memory.terrain[&1].len(),8);
        memory.retain_actors(&HashSet::from([2,3]));assert!(memory.terrain.is_empty());assert!(memory.contacts.is_empty());
        assert!(memory.remembered_contact(2,3,2.0).is_none());
    }
    #[test]
    fn own_team_state_needs_no_sensor_and_never_enters_enemy_fog() {
        let mut actors=[actor(1,0.0,"blue"),actor(2,2000.0,"blue"),actor(3,100.0,"red")];
        actors[1].vehicle=Some(VehicleReading{vx:12.0,vy:-2.0,..Default::default()});let q=Ground{wall:true};let mut memory=SensorMemory::default();
        let ally=memory.sense_combat(&view(&actors,&[],&q,0.0),1,2).unwrap();assert!(ally.detected&&ally.visible);
        assert_eq!((ally.x,ally.vx,ally.vy),(2000.0,12.0,-2.0));
        assert!(!memory.sense_combat(&view(&actors,&[],&q,0.0),1,3).unwrap().detected);
    }
    #[test]
    fn weather_limits_visual_range_without_improving_radar() {
        let actors=[actor(1,0.0,"blue"),actor(2,2200.0,"red")];let q=Ground{wall:false};
        for mode in [SensorMode::Visual,SensorMode::Radar] {
            let modules=[sensor(1,mode,0.0)];let mut v=view(&actors,&modules,&q,0.0);
            let clear=SensorMemory::default().sense_combat(&v,1,2).unwrap();v.weather=SensorWeather::Mist;
            let mist=SensorMemory::default().sense_combat(&v,1,2).unwrap();
            if mode==SensorMode::Visual {assert!(clear.detected);assert!(!mist.detected);}else{assert_eq!(clear.to_value(),mist.to_value());}
        }
    }
    /// Flat ground, open or with walls of several heights standing on it, and the count of the rays asked for.
    struct Walls { open: bool, rays: AtomicUsize }
    impl SensorQuery for Walls {
        fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {
            self.rays.fetch_add(1,Ordering::Relaxed);Ground{wall:false}.terrain_raycast(a,b)
        }
        fn material_raycast(&self,a:Point,b:Point,_:u32,_:Option<Wave>)->Option<SensorHit> {
            self.rays.fetch_add(1,Ordering::Relaxed);
            if self.open {return None;}
            [(-300.0,2.5),(20.0,1.2),(400.0,3.5)].iter().filter_map(|&(x,top)| {
                if (a.x-x)*(b.x-x)>=0.0 {return None;}
                let t=(x-a.x)/(b.x-a.x);let y=a.y+(b.y-a.y)*t;
                (y<top).then(||SensorHit {enter:t,point:Point::new(x,y),normal:Point::new(-1.0,0.0),actor:Some(99)})
            }).min_by(|p,q|p.enter.total_cmp(&q.enter))
        }
    }
    /// What the teams read when every member looks at every enemy with every camera it has.
    fn every_look(memory:&SensorMemory,view:&SensorView)->HashMap<(String,u32),Measurement> {
        let feeds:Vec<_>=view.actors.iter()
            .filter_map(|a|observer_cameras(view,a).map(|cameras|(a,cameras))).collect();
        let mut read:HashMap<(String,u32),Measurement>=HashMap::new();
        for enemy in view.actors {
            let fired=match memory.shots.get(&enemy.handle) {
                Some(&(count,at))=>if enemy.shots>count {view.time} else {at},
                None=>if enemy.shots>0 {view.time} else {f64::NEG_INFINITY},
            };
            let sound=enemy.vehicle.map_or(0.0,|v|if v.engine {0.15+(v.vx.abs()/15.0+v.throttle.abs()*0.5).min(0.85)}else{0.0})
                .max(if view.time-fired<1.5 {1.0}else{0.0});
            for (actor,cameras) in &feeds {
                if actor.team==enemy.team {continue;}
                let key=(actor.team.clone(),enemy.handle);let previous=memory.contacts.get(&key);
                let mut sampled=[false;3];
                for camera in cameras {
                    if sampled[camera.mode.index()] {continue;}
                    if let Some(reading)=measure(view,actor,enemy,camera,sound,previous) {
                        sampled[camera.mode.index()]=true;
                        if read.get(&key).is_none_or(|old|quality(&reading.contact)>quality(&old.contact)) {read.insert(key.clone(),reading);}
                    }
                }
            }
        }
        read
    }
    fn sample_matches_every_look(memory:&mut SensorMemory,view:&SensorView) {
        let expected=every_look(memory,view);memory.sample(view);
        assert_eq!(memory.fresh,expected.keys().cloned().collect::<HashSet<_>>());
        let words=|c:&Contact|[c.time,c.age,c.confidence,c.uncertainty,c.x,c.y,c.width,c.height,c.vx,c.vy].map(f64::to_bits);
        for (key,reading) in expected {
            let got=&memory.contacts[&key];
            assert_eq!((got.sensor,got.contact.source_actor,got.contact.to_value()),
                (reading.sensor,reading.contact.source_actor,reading.contact.to_value()),"{key:?} at {}",view.time);
            assert_eq!(words(&got.contact),words(&reading.contact),"float words of {key:?} at {}",view.time);
        }
    }
    #[test]
    fn a_team_reads_what_every_look_would_read_with_fewer_looks() {
        let mut random=PilotRandom::new(977);let (mut looked,mut all,mut readings)=(0,0,0);
        for field in 0..72 {
            let teams=["blue","red","green"];let count=6+(random.next()*10.0) as u32;
            // Some fields are a crowd within sight of one another, some are strung over the reach of every sensor.
            // The final fields also span the distant battles of the stress field.
            let spread=if field>=60 {80000.0} else if field%3==0 {60.0} else if field%3==1 {700.0} else {1800.0};
            let mut actors:Vec<SensorActor>=(0..count).map(|i| {
                let mut a=actor(i+1,random.range(-spread,spread),teams[(random.next()*3.0) as usize%3]);
                a.bounds.max_y=random.range(1.0,4.0);
                if random.next()<0.5 {a.vehicle=Some(VehicleReading{x:a.x,y:1.0,vx:random.range(-12.0,12.0),engine:random.next()<0.7,..Default::default()});}
                a
            }).collect();
            let mut modules=Vec::new();
            for a in &actors {
                if random.next()<0.8 {modules.push(SensorModule {handle:1000+a.handle,actor:a.handle,kind:ComponentKind::Command,
                    health:10.0,x:a.x,y:random.range(1.0,2.5),..Default::default()});}
                for k in 0..(random.next()*4.0) as u32 {
                    let mode=[SensorMode::Visual,SensorMode::Radar,SensorMode::Sound][(random.next()*3.0) as usize%3];
                    modules.push(SensorModule {handle:2000+a.handle*8+k,actor:a.handle,kind:ComponentKind::Sensor,health:10.0,
                        x:a.x+random.range(-1.0,1.0),y:random.range(1.0,5.0),sensor_mode:mode,
                        range:if random.next()<0.4 {random.range(100.0,1400.0)} else {0.0},..Default::default()});
                }
            }
            let query=Walls{open:field/3%2==0,rays:AtomicUsize::new(0)};let mut memory=SensorMemory::default();
            let weather=[SensorWeather::Clear,SensorWeather::Haze,SensorWeather::Mist][field/6%3];
            let counted=field<60 && query.open && field%3==0;
            for step in 0..9 {
                for a in actors.iter_mut() {
                    let by=random.range(-3.0,3.0);a.x+=by;a.bounds.min_x+=by;a.bounds.max_x+=by;
                    if let Some(v)=a.vehicle.as_mut() {v.x=a.x;}
                    if random.next()<0.1 {a.shots+=1;}
                }
                for m in modules.iter_mut() {
                    let a=actors.iter().find(|a|a.handle==m.actor).unwrap();m.x=a.x;
                    if random.next()<0.03 {m.health=0.0;}
                }
                let mut v=view(&actors,&modules,&query,step as f64*0.1);v.weather=weather;
                query.rays.store(0,Ordering::Relaxed);let expected=every_look(&memory,&v);if counted {all+=query.rays.load(Ordering::Relaxed);}
                let scanned=|memory:&mut SensorMemory| {
                    query.rays.store(0,Ordering::Relaxed);
                    for (actor,cameras) in v.actors.iter().filter_map(|a|observer_cameras(&v,a).map(|cameras|(a,cameras))) {
                        if let Some(camera)=terrain_camera(&cameras) {memory.scan_terrain(&v,actor,camera);}
                    }
                    query.rays.load(Ordering::Relaxed)
                };
                let ground=scanned(&mut SensorMemory::default());
                query.rays.store(0,Ordering::Relaxed);memory.sample(&v);if counted {looked+=query.rays.load(Ordering::Relaxed)-ground;}
                assert_eq!(memory.fresh.len(),expected.len());readings+=expected.len();
                for (key,reading) in &expected {
                    let got=&memory.contacts[key];assert!(memory.fresh.contains(key));
                    assert_eq!((got.sensor,got.contact.to_value()),(reading.sensor,reading.contact.to_value()),
                        "field {field}, step {step}, {key:?}");
                }
            }
        }
        assert!(readings>2000,"{readings} readings");
        // In a crowd where nothing hides an enemy, few of a team have to look at it.
        assert!(looked*2<all,"{looked} rays instead of {all}");
    }
    #[test]
    fn team_reach_matches_every_look_at_range_edges_with_ties_and_duplicate_members() {
        let query=Ground{wall:false};
        for mode in [SensorMode::Visual,SensorMode::Radar,SensorMode::Sound] {
            for weather in [SensorWeather::Clear,SensorWeather::Haze,SensorWeather::Mist] {
                let reach=500.0*if mode==SensorMode::Visual {weather.optical().0}else{1.0};
                for offset in [-0.000001,0.0,0.000001] {for second in [2,9] {
                    let mut actors=[actor(9,-80000.0,"blue"),actor(second,80000.0,"blue"),
                        actor(3,reach+offset,"red"),actor(8,0.0,"empty")];
                    actors[1].id="second member".into();actors[2].shots=1;
                    // Actual optics stand together, far from their carriers; authored ties stay interleaved.
                    let modules=[SensorModule{handle:90,y:1.0,range:500.0,..sensor(9,mode,0.0)},
                        SensorModule{handle:20,y:1.0,range:500.0,..sensor(second,mode,0.0)},
                        SensorModule{handle:91,y:1.0,range:500.0,..sensor(9,mode,0.0)},sensor(77,mode,reach+offset)];
                    let mut v=view(&actors,&modules,&query,0.0);v.weather=weather;
                    let mut memory=SensorMemory::default();sample_matches_every_look(&mut memory,&v);
                    let key=("blue".to_owned(),3);
                    assert_eq!(memory.fresh.contains(&key),offset<=0.0,"{mode:?}/{weather:?} offset {offset}");
                    if offset<=0.0 {let reading=&memory.contacts[&key];
                        assert_eq!((reading.sensor,reading.contact.source_actor),(90,Some(9)));
                    }
                }}
            }
        }
    }
    #[test]
    fn team_reach_keeps_every_look_memory_when_cameras_and_targets_cross_distant_regions() {
        let query=Ground{wall:false};
        let mut actors=[actor(9,0.0,"blue"),actor(2,80000.0,"blue"),actor(3,100.0,"red")];
        let mut modules=[SensorModule{handle:90,y:1.0,range:500.0,..sensor(9,SensorMode::Radar,0.0)},
            SensorModule{handle:20,y:1.0,range:500.0,..sensor(2,SensorMode::Radar,80000.0)}];
        let mut memory=SensorMemory::default();let key=("blue".to_owned(),3);
        for (step,(time,x,camera_x)) in [(0.0,100.0,80000.0),(0.1,100.0,80000.0),
            (0.2,40000.0,80000.0),(0.3,40000.0,40000.0),(0.4,160000.0,40000.0),(2.4,160000.0,40000.0)]
            .into_iter().enumerate() {
            actors[2].x=x;actors[2].bounds.min_x=x-1.0;actors[2].bounds.max_x=x+1.0;modules[1].x=camera_x;
            sample_matches_every_look(&mut memory,&view(&actors,&modules,&query,time));
            match step {
                0|1=>assert_eq!((memory.contacts[&key].sensor,memory.contacts[&key].contact.time),(90,0.0)),
                2|4=>{
                    assert!(!memory.fresh.contains(&key));
                    assert_eq!(memory.remembered_contact(9,3,time).unwrap().source,ContactSource::Memory);
                    assert_eq!(memory.contacts[&key].contact.time,if step==2 {0.0}else{0.3});
                }
                3=>assert_eq!((memory.contacts[&key].sensor,memory.contacts[&key].contact.time),(20,0.3)),
                _=>assert!(!memory.contacts.contains_key(&key)),
            }
        }
    }
    #[test]
    fn team_reach_keeps_sound_memory_when_noise_stops_inside_its_full_range() {
        let query=Ground{wall:false};let mut actors=[actor(1,0.0,"blue"),actor(2,400.0,"red")];
        let modules=[SensorModule{y:1.0,range:500.0,..sensor(1,SensorMode::Sound,0.0)}];
        let mut memory=SensorMemory::default();let key=("blue".to_owned(),2);
        for (time,engine,speed,shots,fresh,retained) in [(0.0,false,0.0,0,false,false),
            (0.1,true,15.0,0,true,true),(0.2,true,0.0,0,false,true),(0.3,false,0.0,1,true,true),
            (1.81,false,0.0,1,false,true),(2.2,false,0.0,1,false,false)] {
            actors[1].vehicle=Some(VehicleReading{x:400.0,y:1.0,vx:speed,engine,..Default::default()});
            actors[1].shots=shots;
            sample_matches_every_look(&mut memory,&view(&actors,&modules,&query,time));
            assert_eq!(memory.fresh.contains(&key),fresh,"sound freshness at {time}");
            assert_eq!(memory.contacts.contains_key(&key),retained,"sound memory at {time}");
            if retained {assert_eq!(memory.contacts[&key].contact.time,0.1);}
        }
    }
    #[test]
    fn team_reach_matches_every_look_for_tiny_ranges_nonfinite_origins_and_unusual_bounds() {
        let point=|x,y|Bounds{min_x:x,max_x:x,min_y:y,max_y:y};let query=Ground{wall:false};
        let cases=[("underflow",Point::new(0.0,1.0),1e-250,point(1e-200,1.0)),
            ("NaN range",Point::new(0.0,1.0),f64::NAN,point(100.0,1.0)),
            ("infinite range",Point::new(0.0,1.0),f64::INFINITY,point(100.0,1.0)),
            ("negative range",Point::new(0.0,1.0),-1.0,point(100.0,1.0)),
            ("NaN origin",Point::new(f64::NAN,1.0),500.0,point(100.0,1.0)),
            ("infinite origin",Point::new(f64::INFINITY,1.0),500.0,point(100.0,1.0)),
            ("overflow distance",Point::new(f64::MAX,1.0),500.0,point(-f64::MAX*0.5,1.0)),
            ("empty",Point::new(0.0,1.0),500.0,Bounds::empty()),
            ("inverted",Point::new(0.0,1.0),500.0,Bounds{min_x:101.0,max_x:99.0,min_y:2.0,max_y:0.0}),
            ("overflow centre",Point::new(0.0,1.0),500.0,Bounds{min_x:-f64::MAX,max_x:0.0,min_y:f64::MAX,max_y:f64::MAX})];
        for (name,origin,range,bounds) in cases {
            let mut actors=[actor(1,0.0,"blue"),actor(2,100.0,"red")];actors[1].bounds=bounds;
            let modules=[SensorModule{x:origin.x,y:origin.y,range,..sensor(1,SensorMode::Radar,0.0)}];
            let mut memory=SensorMemory::default();sample_matches_every_look(&mut memory,&view(&actors,&modules,&query,0.0));
            if name=="underflow" {
                assert!(1e-200>range);assert!(memory.fresh.contains(&("blue".to_owned(),2)),
                    "the existing scalar reading is retained when its squared distance underflows");
            }
        }
    }
    /// Flat ground with, at choice, a wall of some height standing on it and a body two metres high.
    struct Screen { wall: Option<(f64,f64)>, body: Option<(f64,u32)> }
    impl SensorQuery for Screen {
        fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {Ground{wall:false}.terrain_raycast(a,b)}
        fn material_raycast(&self,a:Point,b:Point,_:u32,_:Option<Wave>)->Option<SensorHit> {
            [self.wall.map(|(x,top)|(x,top,99)),self.body.map(|(x,actor)|(x,2.0,actor))].into_iter().flatten().filter_map(|(x,top,actor)| {
                if (a.x-x)*(b.x-x)>=0.0 {return None;}
                let t=(x-a.x)/(b.x-a.x);let y=a.y+(b.y-a.y)*t;
                (y<top).then(||SensorHit {enter:t,point:Point::new(x,y),normal:Point::new(-1.0,0.0),actor:Some(actor)})
            }).min_by(|p,q|p.enter.total_cmp(&q.enter))
        }
    }
    const OPEN:Screen=Screen{wall:None,body:None};
    fn targets(sight:&[(String,Vec<Sight>)],team:&str)->Vec<u32> {
        sight.iter().find(|(name,_)|name==team).map_or(Vec::new(),|(_,held)|held.iter().map(|s|s.target).collect())
    }
    #[test]
    fn team_sight_tells_each_team_what_its_cameras_see_of_the_others() {
        let actors=[actor(1,0.0,"blue"),actor(2,-50.0,"blue"),actor(3,100.0,"red"),actor(4,300.0,"green")];
        let modules=[sensor(1,SensorMode::Visual,0.0),sensor(3,SensorMode::Visual,100.0)];let mut memory=SensorMemory::default();
        let (sight,cleared)=memory.team_sight(&view(&actors,&modules,&OPEN,0.0),&[]);
        assert!(cleared.is_empty());
        // The teams in the order of the field, each with the constructions of the others in that order. A team with no sensor holds nothing.
        assert_eq!(sight.iter().map(|(team,_)|team.as_str()).collect::<Vec<_>>(),["blue","red"]);
        assert_eq!(targets(&sight,"blue"),[3,4]);assert_eq!(targets(&sight,"red"),[1,2,4]);
        for (team,by) in [("blue",1),("red",3)] {
            for s in &sight.iter().find(|(name,_)|name==team).unwrap().1 {
                assert!(s.visible);assert_eq!(s.channel,ContactSource::Visual);assert_eq!(s.by,Some(by));
                // What is seen is told where it is: the middle of its box, with nothing off.
                let place=actors.iter().find(|a|a.handle==s.target).unwrap().x;
                assert_eq!((s.x,s.y,s.error,s.age),(place,1.0,0.0,0.0));
            }
        }
        // A wall comes between the two cameras: what each saw across it is seen no longer, on the very
        // call, though no reading was taken since.
        let hidden=Screen{wall:Some((20.0,50.0)),body:None};
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&hidden,0.1),&[]);
        assert_eq!(memory.time,Some(0.0));
        assert!(targets(&sight,"blue").is_empty());assert_eq!(targets(&sight,"red"),[4]);
        // The wall goes. What it hid comes back with the next reading, not before.
        let (again,_)=memory.team_sight(&view(&actors,&modules,&OPEN,0.2),&[]);
        assert!(targets(&again,"blue").is_empty());assert_eq!(targets(&again,"red"),[4]);
        let (read,_)=memory.team_sight(&view(&actors,&modules,&OPEN,SIGHT_READING),&[]);
        assert_eq!(memory.time,Some(SIGHT_READING),"with nobody else to read the sensors, it has them read");
        assert_eq!(targets(&read,"blue"),[3,4]);assert_eq!(targets(&read,"red"),[1,2,4]);
        // A reading somebody else had taken is as good: a vehicle that decides, here.
        let (lost,_)=memory.team_sight(&view(&actors,&modules,&hidden,0.6),&[]);
        assert!(targets(&lost,"blue").is_empty());
        memory.sense_combat(&view(&actors,&modules,&OPEN,0.7),1,3).unwrap();
        let (found,_)=memory.team_sight(&view(&actors,&modules,&OPEN,0.7),&[]);
        assert_eq!(memory.time,Some(0.7));assert_eq!(targets(&found,"blue"),[3,4]);
        // Defeat changes acquisition, not the past reading or the optics: a wreck is seen,
        // never acquired anew by radar/ear, even before the next shared sampling interval.
        for mode in [SensorMode::Visual,SensorMode::Radar,SensorMode::Sound] {
            let mut actors=[actor(1,0.0,"blue"),actor(2,100.0,"red")];actors[1].shots=1;
            let modules=[sensor(1,mode,0.0)];let mut memory=SensorMemory::default();
            let (live,_)=memory.team_sight(&view(&actors,&modules,&OPEN,0.0),&[]);
            assert_eq!(targets(&live,"blue"),[2],"{mode:?}: the live target is a positive control");
            actors[1].defeated=true;
            let (same,_)=memory.team_sight(&view(&actors,&modules,&OPEN,0.01),&[]);
            assert_eq!(targets(&same,"blue"),if mode==SensorMode::Visual {vec![2]}else{vec![]},"{mode:?}: no fresh nonvisual emission");
            assert_eq!(memory.remembered_contact(1,2,0.01).unwrap().time,0.0,"{mode:?}: do not erase received knowledge");
            let mut unseen=SensorMemory::default();let wreck=view(&actors,&modules,&OPEN,SIGHT_READING);
            let (found,_)=unseen.team_sight(&wreck,&[]);
            assert_eq!(targets(&found,"blue"),if mode==SensorMode::Visual {vec![2]}else{vec![]},"{mode:?}: a wreck needs optics");
            assert_eq!(unseen.sense_combat(&wreck,1,2).unwrap().detected,mode==SensorMode::Visual,"{mode:?}");
            assert_eq!(unseen.sees(&wreck,1,2),mode==SensorMode::Visual,"{mode:?}: direct sight follows the same rule");
        }
    }
    #[test]
    fn same_timestamp_actor_admission_after_a_primed_sight_and_terrain_sample_finds_the_new_optical_contact() {
        let before=[actor(2,100.0,"red")];let mut memory=SensorMemory::default();
        assert!(memory.team_sight(&view(&before,&[],&OPEN,0.0),&[]).0.is_empty());
        assert_eq!((memory.time,memory.looked),(Some(0.0),Some(0.0)),"the old roster was already published at t0");
        // Install keeps the enemy and admits a new observer. A pilot/terrain reading can sample
        // that roster before the audience asks for sight, all at the very same timestamp.
        let actors=[actor(2,100.0,"red"),actor(1,0.0,"blue")];
        let modules=[sensor(1,SensorMode::Visual,0.0)];let current=view(&actors,&modules,&OPEN,0.0);
        memory.retain_actors(&HashSet::from([2]));assert!(memory.time.is_none());
        memory.sense_terrain(&current,1).unwrap();
        let contact=memory.remembered_contact(1,2,0.0).unwrap();
        assert!(contact.visible && contact.channel==Some(ContactSource::Visual),"the intervening sample did find the enemy");
        let (sight,_)=memory.team_sight(&current,&[]);
        assert_eq!(targets(&sight,"blue"),[2],"the first audience must receive that optical contact at t0");
        assert_eq!(memory.time,Some(0.0),"admission invalidates the roster, not the sensor cadence");
    }
    #[test]
    fn a_sight_is_kept_with_one_line_and_the_other_cameras_look_only_when_it_is_lost() {
        // Three of a team in a row, each with a camera, and one enemy before them in the open.
        let actors=[actor(1,0.0,"blue"),actor(2,10.0,"blue"),actor(3,20.0,"blue"),actor(4,200.0,"red")];
        let modules=[sensor(1,SensorMode::Visual,0.0),sensor(2,SensorMode::Visual,10.0),sensor(3,SensorMode::Visual,20.0)];
        let query=Walls{open:true,rays:AtomicUsize::new(0)};let mut memory=SensorMemory::default();
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&query,0.0),&[]);
        assert_eq!(targets(&sight,"blue"),[4]);let by=sight[0].1[0].by;
        // Between readings the camera that has it looks down one line, into the material and into the ground.
        for step in 1..5 {
            query.rays.store(0,Ordering::Relaxed);
            let (sight,_)=memory.team_sight(&view(&actors,&modules,&query,step as f64*0.1),&[]);
            assert_eq!((targets(&sight,"blue"),sight[0].1[0].by),(vec![4],by));assert_eq!(query.rays.load(Ordering::Relaxed),2);
        }
        // Hidden from that camera and from the others: every camera has looked, with all its lines, and that is the end of it.
        let hidden=Screen{wall:Some((100.0,50.0)),body:None};
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&hidden,0.45),&[]);
        assert!(sight.is_empty());assert!(memory.sights.is_empty());
        query.rays.store(0,Ordering::Relaxed);
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&query,0.47),&[]);
        assert!(sight.is_empty(),"in the open again, it is found by the next reading");assert_eq!(query.rays.load(Ordering::Relaxed),0,"and no line is spent meanwhile");
        // Hidden from the camera that has it alone: another takes it over on the same call.
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&query,0.5),&[]);
        let first=sight[0].1[0].by.unwrap();
        struct But(u32);
        impl SensorQuery for But {
            fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {Ground{wall:false}.terrain_raycast(a,b)}
            fn material_raycast(&self,a:Point,b:Point,observer:u32,_:Option<Wave>)->Option<SensorHit> {
                (observer==self.0).then(||SensorHit {enter:0.5,point:Point::new((a.x+b.x)*0.5,(a.y+b.y)*0.5),normal:Point::new(-1.0,0.0),actor:Some(99)})
            }
        }
        let (sight,_)=memory.team_sight(&view(&actors,&modules,&But(first),0.6),&[]);
        assert_eq!(targets(&sight,"blue"),[4]);assert_ne!(sight[0].1[0].by,Some(first));
    }
    #[test]
    fn a_team_sees_what_one_of_its_cameras_sees_whichever_sensor_reads_it_best() {
        // Over the wall the camera sees no more than the top of the enemy, and the radar beside it reads it better.
        let actors=[actor(1,0.0,"blue"),actor(2,60.0,"red")];let wall=Screen{wall:Some((20.0,1.85)),body:None};
        let radar=SensorModule {handle:11,..sensor(1,SensorMode::Radar,0.0)};
        let both=[sensor(1,SensorMode::Visual,0.0),radar.clone()];let mut memory=SensorMemory::default();
        let (sight,_)=memory.team_sight(&view(&actors,&both,&wall,0.0),&[]);
        assert_eq!(memory.contacts[&("blue".to_owned(),2)].contact.channel,Some(ContactSource::Radar));
        let held=&sight[0].1;
        assert_eq!(held.iter().map(|s|(s.target,s.channel,s.visible)).collect::<Vec<_>>(),
            [(2,ContactSource::Radar,true),(2,ContactSource::Visual,true)]);
        assert!(held[0].error>0.0 && held[1].error==0.0);assert_eq!(held[1].by,Some(1));
        // With no camera that reaches it, the radar holds it alone.
        for modules in [vec![radar.clone()],vec![SensorModule {range:30.0,..sensor(1,SensorMode::Visual,0.0)},radar.clone()]] {
            let (sight,_)=SensorMemory::default().team_sight(&view(&actors,&modules,&wall,0.0),&[]);
            assert_eq!(sight[0].1.iter().map(|s|s.channel).collect::<Vec<_>>(),[ContactSource::Radar]);
        }
        // Hidden altogether: the camera loses it at once. What the radar held is told as its last
        // reading had it, older by the call, and as a memory once a reading finds it gone.
        let hidden=Screen{wall:Some((20.0,50.0)),body:None};
        let (sight,_)=memory.team_sight(&view(&actors,&both,&hidden,0.2),&[]);
        assert_eq!(sight[0].1.iter().map(|s|(s.channel,s.visible,s.age)).collect::<Vec<_>>(),[(ContactSource::Radar,true,0.2)]);
        let (sight,_)=memory.team_sight(&view(&actors,&both,&hidden,SIGHT_READING),&[]);
        assert_eq!(sight[0].1.iter().map(|s|(s.channel,s.visible)).collect::<Vec<_>>(),[(ContactSource::Radar,false)]);
    }
    #[test]
    fn a_ghost_is_cleared_when_a_camera_of_its_team_sees_its_place_empty() {
        let actors=[actor(1,0.0,"blue"),actor(3,300.0,"red")];
        let mut modules=[sensor(1,SensorMode::Visual,0.0),sensor(3,SensorMode::Visual,300.0)];
        let ghost=|team:&str,x:f64,y:f64|(team.to_owned(),Point::new(x,y));
        let cleared=|modules:&[SensorModule],query:&dyn SensorQuery,ghosts:&[(String,Point)]|
            SensorMemory::default().team_sight(&view(&actors,modules,query,0.0),ghosts).1;
        // In the open: the place in plain view, the one whose ground the line ends on, and no other —
        // not the one past the reach of the camera, nor under the ground, nor of a team with no camera, nor one with no place.
        let ghosts=[ghost("blue",100.0,1.0),ghost("blue",4200.0,1.0),ghost("blue",100.0,-3.0),ghost("blue",100.0,0.01),
            ghost("green",100.0,1.0),ghost("blue",f64::NAN,1.0),ghost("red",250.0,1.0)];
        assert_eq!(cleared(&modules,&OPEN,&ghosts),[0,3,6]);
        // A wall hides a place from the camera it stands before, and no place it stands behind.
        assert_eq!(cleared(&modules,&Screen{wall:Some((200.0,50.0)),body:None},&ghosts),[0,3,6]);
        assert_eq!(cleared(&modules,&Screen{wall:Some((50.0,50.0)),body:None},&ghosts),[6]);
        // Something stands there, the construction itself or another: that is no sight of an empty place.
        assert_eq!(cleared(&modules,&Screen{wall:None,body:Some((99.0,3))},&ghosts),[6]);
        assert_eq!(cleared(&modules,&Screen{wall:None,body:Some((101.0,3))},&ghosts),[6],"nor just behind the place");
        assert_eq!(cleared(&modules,&Screen{wall:None,body:Some((104.0,3))},&ghosts),[0,3,6]);
        // A camera that is gone sees nothing.
        modules[0].health=0.0;
        assert_eq!(cleared(&modules,&OPEN,&ghosts),[6]);
    }
    #[test]
    fn the_cameras_of_a_team_look_at_the_place_of_a_ghost_one_on_each_call() {
        // Two cameras of a team with a wall between them, and a ghost on the far side of it from the first.
        let actors=[actor(1,0.0,"blue"),actor(2,200.0,"blue")];
        let modules=[sensor(1,SensorMode::Visual,0.0),sensor(2,SensorMode::Visual,200.0)];
        let wall=Screen{wall:Some((100.0,50.0)),body:None};let mut memory=SensorMemory::default();
        let ghosts=[("blue".to_owned(),Point::new(150.0,1.0))];
        let seen:Vec<usize>=(0..4).map(|step|memory.team_sight(&view(&actors,&modules,&wall,step as f64*0.1),&ghosts).1.len()).collect();
        assert!(seen==[0,1,0,1] || seen==[1,0,1,0],"the camera with the place in plain view has its turn every other call: {seen:?}");
    }
    /// A plate of armour so long and three centimetres thick, standing as its pose says.
    fn armour(x:f64,y:f64,angle:f64,length:f64)->Armour {
        Armour::of(Pose{x,y,angle},&MaterialGrid::new(Bounds{min_x:-length/2.0,max_x:length/2.0,min_y:-0.015,max_y:0.015}))
    }
    /// The optic among plates of its own construction, which stands level.
    fn covered(module:SensorModule,armour:&[Armour])->SensorModule {
        let cover=Cover::around(Pose{x:module.x,y:module.y,angle:module.turn},0.0,armour);
        SensorModule {cover:Some(Arc::new(cover)),..module}
    }
    #[test]
    fn the_armour_around_an_optic_hides_the_arcs_it_stands_on_and_turns_with_it() {
        use std::f64::consts::FRAC_PI_2;
        let optic=Pose{x:0.0,y:2.0,angle:0.0};let at=Point::new(0.0,2.0);
        let to=|degrees:f64|Point::new(at.x+cos(degrees.to_radians())*50.0,at.y+sin(degrees.to_radians())*50.0);
        // A wall a metre high half a metre before it hides the arc it stands on, some 46 degrees either way.
        let cover=Cover::around(optic,0.0,&[armour(0.5,2.0,FRAC_PI_2,1.0)]);
        for (degrees,hidden) in [(0.0,true),(40.0,true),(-44.0,true),(50.0,false),(-50.0,false),(90.0,false),(180.0,false),(-179.0,false)] {
            assert_eq!(cover.hides(at,to(degrees),0.0),hidden,"{degrees}");
        }
        assert_eq!(cover.sides(0.0),[true,false]);assert!(!cover.sealed());
        // Turned with its construction, the wall is before it still: what it hides has turned as far.
        assert_eq!(cover.sides(PI),[false,true]);
        assert!(cover.hides(at,to(180.0),PI) && !cover.hides(at,to(0.0),PI));
        assert!(cover.hides(at,to(90.0),FRAC_PI_2) && !cover.hides(at,to(0.0),FRAC_PI_2));
        assert!(cover.hides(at,to(0.0),-4.0*TAU) && !cover.hides(at,to(180.0),7.0*TAU),"however many turns it has made");
        // A low wall leaves a level line over it. The plate an optic is set in is its mount, and hides nothing.
        let low=Cover::around(optic,0.0,&[armour(0.5,1.7,FRAC_PI_2,0.5)]);
        assert_eq!(low.sides(0.0),[true,true]);assert!(low.hides(at,to(-20.0),0.0) && !low.hides(at,to(0.0),0.0));
        let mount=Cover::around(optic,0.0,&[armour(0.0,2.0,0.0,3.0)]);
        assert!(!mount.hides(at,to(0.0),0.0) && !mount.hides(at,to(-90.0),0.0));assert_eq!(mount.sides(0.0),[true,true]);
        // Walls all around shut it in: it is no camera, and a radar among them is none either. A microphone
        // hears through them as it did.
        let shut=[armour(0.5,2.0,FRAC_PI_2,1.06),armour(-0.5,2.0,FRAC_PI_2,1.06),armour(0.0,2.5,0.0,1.06),armour(0.0,1.5,0.0,1.06)];
        assert!(Cover::around(optic,0.0,&shut).sealed());
        assert!(covered(sensor(1,SensorMode::Visual,0.0),&shut).camera().is_none());
        assert!(covered(sensor(1,SensorMode::Radar,0.0),&shut).camera().is_none());
        assert!(covered(sensor(1,SensorMode::Sound,0.0),&shut).camera().is_some());
        // What a shot took out of the wall is an opening as wide as the hole; a dent is none.
        let pose=Pose{x:0.5,y:2.0,angle:FRAC_PI_2};
        let mut grid=MaterialGrid::new(Bounds{min_x:-0.5,max_x:0.5,min_y:-0.015,max_y:0.015});
        let mut dented=grid.clone();
        for x in 20..30 {for y in 0..grid.ny {grid.clear_cell(x,y);if y<8 {dented.clear_cell(x,y);}}}
        let holed=Cover::around(optic,0.0,&[Armour::of(pose,&grid)]);
        assert!(!holed.hides(at,to(0.0),0.0) && !holed.hides(at,to(10.0),0.0) && holed.hides(at,to(12.0),0.0) && holed.hides(at,to(-30.0),0.0));
        assert_eq!(holed.sides(0.0),[true,true]);
        let dented=Cover::around(optic,0.0,&[Armour::of(pose,&dented)]);
        assert!(dented.hides(at,to(0.0),0.0));assert_eq!(dented.sides(0.0),[true,false]);
    }
    #[test]
    fn a_line_its_own_armour_stands_on_is_not_cast_and_the_side_it_hides_is_not_read() {
        let actors=[actor(1,0.0,"blue"),actor(2,100.0,"red"),actor(3,-100.0,"green")];
        let wall=[armour(0.5,2.0,std::f64::consts::FRAC_PI_2,1.0)];
        let open=[sensor(1,SensorMode::Visual,0.0)];let behind=[covered(sensor(1,SensorMode::Visual,0.0),&wall)];
        // In the open: the ground read to both sides, and five lines to each of the two others.
        let query=Walls{open:true,rays:AtomicUsize::new(0)};let mut memory=SensorMemory::default();
        let v=view(&actors,&open,&query,0.0);
        assert!(memory.sense_combat(&v,1,2).unwrap().detected && memory.sense_combat(&v,1,3).unwrap().detected);
        let all=query.rays.load(Ordering::Relaxed);
        // Behind the wall: what stands before it is not seen, and costs no line into the wall to find so.
        query.rays.store(0,Ordering::Relaxed);let mut memory=SensorMemory::default();
        let v=view(&actors,&behind,&query,0.0);
        assert!(!memory.sense_combat(&v,1,2).unwrap().detected && memory.sense_combat(&v,1,3).unwrap().detected);
        assert_eq!((all,query.rays.load(Ordering::Relaxed)),(76,38));
        // Of the ground before it nothing is read; behind it, as ever.
        let reading=memory.sense_terrain(&v,1).unwrap();
        assert!(reading.samples[..14].iter().all(|s|s.known&&!s.hit&&!s.obstacle) && reading.samples[14..].iter().any(|s|s.hit));
        let ground=memory.observed_terrain(&v,1).unwrap();
        assert_eq!(ground.height(-5.0),Some(0.0));
        assert_eq!(ground.height(5.0),None);
        // Nor does it see the place of a ghost before it empty.
        let ghosts=[("blue".to_owned(),Point::new(50.0,1.0)),("blue".to_owned(),Point::new(-50.0,1.0))];
        assert_eq!(memory.team_sight(&v,&ghosts).1,[1]);
        // The eye it is tells as much: how far it sees to each side, with the weather, as it is turned.
        let eye=|left:f64,right:f64|Some(Eye{x:0.0,y:2.0,left,right});
        assert_eq!(open[0].eye(SensorWeather::Clear),eye(4000.0,4000.0));
        assert_eq!(behind[0].eye(SensorWeather::Clear),eye(4000.0,0.0));
        assert_eq!(behind[0].eye(SensorWeather::Haze),eye(3200.0,0.0));
        assert_eq!(SensorModule{turn:PI,..behind[0].clone()}.eye(SensorWeather::Clear),eye(0.0,4000.0));
        assert_eq!(SensorModule{range:300.0,..behind[0].clone()}.eye(SensorWeather::Mist),eye(135.0,0.0));
        assert_eq!(SensorModule{kind:ComponentKind::Command,..open[0].clone()}.eye(SensorWeather::Clear),eye(COMMAND_CAMERA_RANGE,COMMAND_CAMERA_RANGE));
        // One that does not work, one shut in and one that is no optic are no eyes.
        assert_eq!(SensorModule{health:0.0,..open[0].clone()}.eye(SensorWeather::Clear),None);
        assert_eq!(SensorModule{sensor_mode:SensorMode::Radar,..open[0].clone()}.eye(SensorWeather::Clear),None);
        let shut=[armour(0.5,2.0,std::f64::consts::FRAC_PI_2,1.06),armour(-0.5,2.0,std::f64::consts::FRAC_PI_2,1.06),armour(0.0,2.5,0.0,1.06),armour(0.0,1.5,0.0,1.06)];
        assert_eq!(covered(sensor(1,SensorMode::Visual,0.0),&shut).eye(SensorWeather::Clear),None);
    }
    /// Open ground that remembers the wave each line asked of it was, if any.
    struct Lines(Mutex<Vec<Option<Wave>>>);
    impl SensorQuery for Lines {
        fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {Ground{wall:false}.terrain_raycast(a,b)}
        fn material_raycast(&self,_:Point,_:Point,_:u32,wave:Option<Wave>)->Option<SensorHit> {self.0.lock().unwrap().push(wave);None}
    }
    #[test]
    fn a_camera_looks_by_light_a_radar_by_its_waves_and_a_microphone_by_neither() {
        for mode in [SensorMode::Visual,SensorMode::Radar,SensorMode::Sound] {
            let mut actors=[actor(1,0.0,"blue"),actor(2,100.0,"red")];actors[1].shots=1;
            let modules=[sensor(1,mode,0.0)];let lines=Lines(Default::default());
            assert!(SensorMemory::default().sense_combat(&view(&actors,&modules,&lines,0.0),1,2).unwrap().detected);
            // The five lines a camera measures a construction with are light, and run through glass; the
            // one of a radar that runs clear is its waves, and runs through fibreglass. No other line is
            // either: not a microphone's, nor those the ground is read with, where glass is in the way.
            let count=|wave:Wave|lines.0.lock().unwrap().iter().filter(|line|**line==Some(wave)).count();
            assert_eq!((count(Wave::Light),count(Wave::Radio)),match mode {SensorMode::Visual=>(5,0),SensorMode::Radar=>(0,1),SensorMode::Sound=>(0,0)},"{mode:?}");
            // A microphone asks no construction whether it stands in the way: it hears round it.
            assert_eq!(lines.0.lock().unwrap().iter().any(Option::is_none),mode==SensorMode::Visual,"{mode:?}");
        }
    }
    /// Open ground with a ridge across it at `x`: every line over it meets the ground there.
    struct Ridge(f64);
    impl SensorQuery for Ridge {
        fn terrain_raycast(&self,a:Point,b:Point)->Option<SensorHit> {
            ((a.x-self.0)*(b.x-self.0)<0.0).then(||{let t=(self.0-a.x)/(b.x-a.x);
                SensorHit {enter:t,point:Point::new(self.0,a.y+(b.y-a.y)*t),normal:Point::new(-1.0,0.0),actor:None}})
        }
        fn material_raycast(&self,_:Point,_:Point,_:u32,_:Option<Wave>)->Option<SensorHit> {None}
    }
    #[test]
    fn ground_two_teammates_read_alike_is_taken_by_their_handles_not_by_the_order_of_a_map() {
        // Scanned at the same moment, as far from the observer on either side: every map is seeded anew, so only
        // the handles can choose the same one each time.
        for turn in 0..16 {
            let mut memory=SensorMemory::default();
            memory.members.insert(1,("a".into(),Point::new(0.0,0.0)));
            let mut ids=[2_u32,3];if turn%2==1 {ids.reverse();}
            for id in ids {
                let x=if id==2 {-10.0} else {10.0};
                memory.members.insert(id,("a".into(),Point::new(x,0.0)));
                memory.terrain.insert(id,VecDeque::from([TerrainFrame {camera:id*10,time:5.0,range:f64::from(id),
                    origin:Point::new(x,0.0),samples:std::array::from_fn(|_|TerrainSample::default()),audiences:vec!["a".into()]}]));
            }
            assert_eq!(memory.terrain_reading(1,5.0).origin,Some(Point::new(-10.0,0.0)));
        }
    }
    #[test]
    fn prepared_ground_reuses_stable_overlaps_obstacles_expiry_and_handle_membership() {
        let actors=[actor(1,0.0,"foreign"),actor(1,0.0,"a"),actor(2,-10.0,"a"),actor(3,10.0,"a")];
        let q=Ground{wall:false};let v=view(&actors,&[],&q,5.0);
        let frame=|camera,time,center,y,obstacle| {
            let mut samples=std::array::from_fn(|_|TerrainSample::default());
            for (i,offset) in [-6.0,0.0,6.0].into_iter().enumerate() {
                samples[i]=TerrainSample {hit:true,x:center+offset,y,ny:1.0,..Default::default()};
            }
            if obstacle {samples[3]=TerrainSample {hit:true,x:center+2.0,y:1000.0,obstacle:true,..Default::default()};}
            TerrainFrame {camera,time,range:40.0,origin:Point::new(center,1.0),samples,audiences:vec!["a".into()]}
        };
        for ids in [[2_u32,3],[3,2]] {
            let mut memory=SensorMemory::default();
            memory.members.insert(1,("a".into(),Point::new(0.0,0.0)));
            for id in ids {
                memory.members.insert(id,("a".into(),Point::new(0.0,0.0)));
                let mut frames=VecDeque::new();
                if id==2 {
                    frames.push_back(frame(20,4.9,20.0,99.0,false));
                    frames.push_back(frame(20,f64::NAN,30.0,123.0,false));
                }
                frames.push_back(frame(id*10,5.0,0.0,if id==2 {20.0}else{30.0},id==2));
                memory.terrain.insert(id,frames);
            }
            let ground=memory.observed_terrain(&v,1).unwrap();
            assert_eq!([ground.height(-3.0),ground.height(0.0)], [Some(20.0),Some(20.0)], "equal times retain handle order and interpolate the same panorama");
            assert_eq!(ground.height(3.0),Some(30.0),"an obstacle leaves the overlapping ally panorama available");
            assert_eq!(ground.height(20.0),Some(99.0),"older ground remains available where newer panoramas have no samples");
            assert_eq!([ground.height(30.0),ground.height(f64::NAN)],[None,None]);
            let expired=memory.observed_terrain(&view(&actors,&[],&q,65.0),1).unwrap();
            assert_eq!([expired.height(0.0),expired.height(20.0)],[Some(20.0),None],"the sixty-second boundary retains the newer panorama alone");
            assert!(memory.observed_terrain(&v,99).is_err(),"the participant is still validated before ground is prepared");
        }
    }
    #[test]
    fn mulberry_noise_is_seeded() {
        let mut r=PilotRandom::new(6173);assert_eq!(r.next(),0.4512807675637305);assert_eq!(r.next(),0.5516326411161572);
    }
    #[test]
    fn alliance_reads_direct_sources_and_revoke_keeps_only_received_contact_and_terrain() {
        let mut actors = [actor(1,0.0,"blue"),actor(2,100.0,"amber"),actor(3,200.0,"green"),actor(4,300.0,"red")];
        let mut modules = vec![sensor(3,SensorMode::Visual,200.0)];
        let query = Ground { wall:false }; let mut memory = SensorMemory::default();
        memory.set_alliances(vec![("blue".into(),"amber".into()),("amber".into(),"green".into())]);
        assert!(!memory.sense_combat(&view(&actors,&modules,&query,0.0),1,4).unwrap().detected,"a source's grant is not relayed");
        assert!(memory.sense_combat(&view(&actors,&modules,&query,0.0),2,4).unwrap().visible);
        modules.push(sensor(2,SensorMode::Visual,100.0));
        let shared = memory.sense_combat(&view(&actors,&modules,&query,0.2),1,4).unwrap();
        let origin = memory.sense_terrain(&view(&actors,&modules,&query,0.2),1).unwrap().origin;
        assert!(shared.visible && shared.detected); assert_eq!(shared.source_actor,Some(2)); assert_eq!(origin,Some(Point::new(100.0,2.0)));
        memory.set_alliances(vec![("amber".into(),"green".into())]);
        actors[3] = actor(4,500.0,"red"); actors[1] = actor(2,800.0,"amber"); modules[1].x = 800.0;
        let old = memory.sense_combat(&view(&actors,&modules,&query,0.2),1,4).unwrap();
        assert_eq!((old.x,old.y,old.vx,old.vy),(shared.x,shared.y,shared.vx,shared.vy));
        assert!(!old.visible); assert_eq!(old.source,ContactSource::Memory);
        let historical = memory.sense_terrain(&view(&actors,&modules,&query,0.2),1).unwrap();
        assert_eq!(historical.origin,origin,"new panoramas do not overwrite a revoked recipient's last received view");
        assert!(historical.samples.iter().all(|sample|!sample.fresh),"same-tick historical terrain is not a new observation");
        let (sight,_) = memory.team_sight(&view(&actors,&modules,&query,0.2),&[]);
        assert!(sight.iter().find(|(team,_)|team=="blue").is_none_or(|(_,rows)|!rows.iter().any(|s|s.target==4&&s.visible)));
        assert!(!memory.sense_combat(&view(&actors,&modules,&query,2.3),1,4).unwrap().detected);
    }
    #[test]
    fn alliance_radar_and_sound_keep_their_own_precision_and_never_grant_own_team_state() {
        for mode in [SensorMode::Radar,SensorMode::Sound] {
            let mut actors = [actor(1,0.0,"blue"),actor(2,100.0,"amber"),actor(3,300.0,"red"),actor(4,9000.0,"amber")];
            actors[2].shots = 1;
            let modules = [sensor(2,mode,100.0)]; let query = Ground { wall:false }; let mut memory = SensorMemory::default();
            memory.set_alliances(vec![("blue".into(),"amber".into())]);
            let c = memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap();
            assert!(c.detected); assert_eq!(c.channel,Some(if mode==SensorMode::Radar {ContactSource::Radar}else{ContactSource::Sound}));
            assert_eq!((c.width,c.height),(0.0,0.0)); assert!(c.uncertainty>0.0);
            assert!(!memory.sense_combat(&view(&actors,&modules,&query,0.0),1,4).unwrap().detected,"an unseen allied fleet is not an own-team shortcut");
            memory.set_alliances(Vec::new()); actors[2] = actor(3,700.0,"red");
            let old = memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap();
            assert_eq!((old.x,old.y,old.vx,old.vy,old.uncertainty),(c.x,c.y,c.vx,c.vy,c.uncertainty));
            assert!(!old.visible); assert_eq!(old.source,ContactSource::Memory);
            let (sight,_) = memory.team_sight(&view(&actors,&modules,&query,0.0),&[]);
            let held = &sight.iter().find(|(team,_)|team=="blue").unwrap().1;
            assert!(held.iter().filter(|row|row.target==3).all(|row|!row.visible && row.x==c.x && row.y==c.y));
        }
    }
    #[test]
    fn changing_an_alliance_preserves_current_own_sensors_and_their_received_history() {
        let mut actors = [actor(1,0.0,"blue"),actor(2,100.0,"amber"),actor(3,200.0,"red")];
        let mut modules = [sensor(1,SensorMode::Visual,0.0)]; let query = Ground { wall:false };
        let mut memory = SensorMemory::default(); memory.set_alliances(vec![("blue".into(),"amber".into())]);
        let own = memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap(); assert!(own.visible);
        memory.set_alliances(Vec::new());
        let still = memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap();
        assert!(still.visible); assert_eq!(still.source_actor,Some(1)); assert_eq!(still.x,own.x);
        modules[0].health=0.0; actors[2]=actor(3,800.0,"red"); memory.set_alliances(Vec::new());
        let old = memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap();
        assert!(old.detected && !old.visible); assert_eq!(old.x,own.x,"changing policy does not erase legitimately received own history");
    }
    #[test]
    fn an_allied_ear_keeps_the_observed_side_when_both_references_move_and_when_the_grant_ends() {
        let mut actors=[actor(1,0.0,"blue"),actor(2,800.0,"amber"),actor(3,400.0,"red")];
        actors[2].shots=1;
        let mut modules=[sensor(2,SensorMode::Sound,800.0)]; let query=Ground{wall:false}; let mut memory=SensorMemory::default();
        memory.set_alliances(vec![("blue".into(),"amber".into())]);
        let first=memory.sense_combat(&view(&actors,&modules,&query,0.0),1,3).unwrap();
        let receipt=memory.sound_receipt(1,3).unwrap().clone();
        assert_eq!(receipt,SoundReceipt{side:-1,team:"amber".into()},"the target between the parties is left of the allied ear");
        assert!(first.x>0.0 && first.x<800.0);
        actors[0]=actor(1,900.0,"blue"); actors[1]=actor(2,100.0,"amber"); modules[0].x=100.0;
        let reused=memory.sense_combat(&view(&actors,&modules,&query,0.1),1,3).unwrap();
        assert_eq!((reused.x,reused.y,reused.time),(first.x,first.y,first.time));
        assert_eq!(memory.sound_receipt(1,3),Some(&receipt),"the half-second reading freezes its origin's side");
        memory.set_alliances(Vec::new()); actors[2]=actor(3,1200.0,"red");
        let held=memory.sense_combat(&view(&actors,&modules,&query,0.1),1,3).unwrap();
        assert!(!held.visible); assert_eq!(held.source,ContactSource::Memory);
        assert_eq!((held.x,held.y,held.time),(first.x,first.y,first.time));
        let restored:SensorMemory=rmp_serde::from_slice(&rmp_serde::to_vec(&memory).unwrap()).unwrap();
        assert_eq!(restored.sound_receipt(1,3),Some(&receipt),"receipt and original timestamp survive the existing snapshot");
        assert_eq!(restored.remembered_contact(1,3,0.1).unwrap().time,first.time);
    }
}
