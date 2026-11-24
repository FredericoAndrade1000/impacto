//! The terrain profile is constructed once and shared by contacts, CCD,
//! sensors and drive loads. Hot queries read precomputed segment normals.
use serde::{Deserialize, Serialize};
use super::{Point, hypot, number, sqrt};
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Default, Serialize, Deserialize)]
#[repr(usize)]
pub enum SurfaceKind {
    #[default]
    Soil = 0,
    Rock = 1,
    Concrete = 2,
    Gravel = 3,
    Sand = 4,
    Mud = 5,
    /// A road of the field (`Terrain::roads`): earth graded and rolled firm.
    Graded = 6,
    /// A road of the field paved with asphalt.
    Asphalt = 7,
}
/// How many kinds of ground there are: what a share of each is counted in.
pub const SURFACE_KINDS: usize = 8;
impl SurfaceKind {
    pub fn from_name(name: &str) -> Self {
        match name {
            "rock" => Self::Rock,
            "concrete" => Self::Concrete,
            "gravel" => Self::Gravel,
            "sand" => Self::Sand,
            "mud" => Self::Mud,
            "graded" => Self::Graded,
            "asphalt" => Self::Asphalt,
            _ => Self::Soil,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Soil => "soil",
            Self::Rock => "rock",
            Self::Concrete => "concrete",
            Self::Gravel => "gravel",
            Self::Sand => "sand",
            Self::Mud => "mud",
            Self::Graded => "graded",
            Self::Asphalt => "asphalt",
        }
    }
    /// A road of the field is laid as one of these, and only these.
    fn road(name: &str) -> Option<Self> {
        match name {
            "graded" => Some(Self::Graded),
            "asphalt" => Some(Self::Asphalt),
            _ => None,
        }
    }
    pub fn grip(self, track: bool) -> f64 {
        match self {
            Self::Asphalt => 0.80,
            Self::Graded => 0.70,
            Self::Gravel => 0.60,
            Self::Sand => {
                if track {
                    0.54
                } else {
                    0.40
                }
            }
            Self::Mud => {
                if track {
                    0.44
                } else {
                    0.26
                }
            }
            _ => 0.72,
        }
    }
    /// The share of its grip (`grip`) this ground holds a running gear back by as it spins free over it: it holds it by
    /// all of it as the gear begins to slip, and by less the more of its turning it slips by (game_motion.rs `drive`). A
    /// tyre dragged over dry asphalt or concrete gives 0.75 against 0.85 as it grips, over gravel 0.55 against 0.60, over
    /// dry earth 0.65 against 0.68 (J. Y. Wong, Theory of Ground Vehicles, 2nd ed., 1993, p. 26). Loose sand and a mire
    /// shear under a gear more the more it slips, up to the most they bear, and do not give way past it (Wong, ch. 2,
    /// after Janosi and Hanamoto): a gear spinning in them is held back by all of its grip.
    pub fn sliding(self) -> f64 {
        match self {
            Self::Asphalt | Self::Concrete | Self::Rock => 0.88,
            Self::Gravel => 0.92,
            Self::Soil | Self::Graded => 0.96,
            Self::Sand | Self::Mud => 1.0,
        }
    }
    /// What rolling over this ground takes beyond what it takes on firm ground, for the weight on it, under a track
    /// when `track`. Asphalt and concrete are smoother than that: a tyre rolls on them at 0.012 of its load and not
    /// 0.018, as a truck tyre on a highway does. A tyre sinks into loose earth and sand and pushes it before it, as a
    /// track that spreads the weight over its length hardly does: on undisturbed earth it rolls at 0.030, and on sand
    /// at 0.073 before what it takes to sink in (`bearing_pa`). A track takes 0.65 of what the rest of a ground takes
    /// from a tyre, and nothing of that.
    pub fn rolling(self, track: bool) -> f64 {
        let (both, tyre) = match self {
            Self::Asphalt | Self::Concrete => (-0.006, 0.0),
            Self::Soil => (0.0, 0.012),
            Self::Gravel => (0.015, 0.0),
            Self::Sand => (0.022, 0.033),
            Self::Mud => (0.030, 0.0),
            _ => (0.0, 0.0),
        };
        if track { both * 0.65 } else { both + tyre }
    }
    /// The bumps of this ground under a running gear (`Terrain::bump`), none on concrete and asphalt.
    fn bumps(self) -> Option<Bumps> {
        let (pitch, low, high, stones) = match self {
            Self::Soil => (1.4, 0.03, 0.07, 0.0),
            Self::Sand => (2.6, 0.04, 0.06, 0.0),
            Self::Gravel => (0.2, 0.02, 0.035, 0.0),
            Self::Rock => (0.7, 0.08, 0.15, 0.12),
            Self::Mud => (1.2, 0.07, 0.13, 0.0),
            Self::Graded => (1.5, 0.005, 0.015, 0.0),
            Self::Concrete | Self::Asphalt => return None,
        };
        Some(Bumps { pitch, low, high, stones, channel: 600 + 4 * self as u32 })
    }
    pub fn bearing_pa(self) -> f64 {
        match self {
            Self::Sand => 180_000.0,
            Self::Mud => 100_000.0,
            _ => 0.0,
        }
    }
}
/// The ground is not as smooth to a running gear as the line it is drawn by: over that line lie bumps too small to
/// draw, which only the wheels feel (`Terrain::seat`, `Terrain::support`), and which the rounds, the sight and the
/// rest of the field know nothing of. They rise and fall from one knot to the next, a knot about every `pitch` metres
/// along the ground, each where the ground has it within its own stretch of `pitch`: as waves, a knot `low` to `high`
/// over the one before and the next under it, or as stones, a share `stones` of the knots a stone `low` to `high`
/// high and the rest at the ground. They are of the place and the field alone, drawn from its seed by `channel`, and
/// a stretch of one ground starts and ends level with the line, wherever another meets it.
#[derive(Clone, Copy, Debug)]
struct Bumps {
    pitch: f64,
    low: f64,
    high: f64,
    stones: f64,
    channel: u32,
}
/// The most a knot of any ground stands over or under the line, in metres.
const BUMPS_REACH: f64 = 0.15;
impl Bumps {
    /// The knot of the stretch `cell` of this ground, in a field of `seed`.
    fn knot(self, seed: u32, cell: i32) -> Point {
        let x = (cell as f64 + 0.25 + 0.5 * terrain_random(seed, self.channel, cell)) * self.pitch;
        let size = self.low + (self.high - self.low) * terrain_random(seed, self.channel + 1, cell);
        let y = if self.stones > 0.0 {
            if terrain_random(seed, self.channel + 2, cell) < self.stones { size } else { 0.0 }
        } else if cell & 1 == 0 {
            size / 2.0
        } else {
            -size / 2.0
        };
        Point::new(x, y)
    }
    /// Whether a knot is of the stretch from `start` to `end`: one too near an end of it, where it starts level with
    /// the line, would rise from there more steeply than the knots rise from one another.
    fn within(self, knot: Point, start: f64, end: f64) -> bool {
        knot.x > start + 0.5 * self.pitch && knot.x < end - 0.5 * self.pitch
    }
}
/// The bumps of the ground along a stretch of it (`Terrain::underfoot`), where a running gear stands: the knots of each
/// ground with them there, in order along it, and one on the line where each such ground starts and ends. Between two
/// knots the bumps are the line between them; before the first, past the last and over ground without them, there are
/// none.
pub struct Underfoot {
    knots: Vec<Point>,
}
impl Underfoot {
    fn push(&mut self, knot: Point) {
        if self.knots.last().is_none_or(|last| knot.x > last.x) {
            self.knots.push(knot);
        }
    }
    /// How far the bumps stand over the line at a place.
    fn bump(&self, x: f64) -> f64 {
        let i = self.knots.partition_point(|knot| knot.x <= x);
        match (i.checked_sub(1).map(|i| self.knots[i]), self.knots.get(i)) {
            (Some(left), Some(right)) => left.y + (right.y - left.y) * (x - left.x) / (right.x - left.x),
            _ => 0.0,
        }
    }
    /// How far the bumps stand a foot of the running gear up from the line, with its middle at `x`, and the way they
    /// push on it there, the line level. A foot is as round as its wheel, `radius`, and flat for `flat` behind its
    /// middle and ahead of it: the footprint of a tyre, or the belt of a track under a road wheel. Off the bumps it
    /// stands on the line, and the line pushes it straight up.
    fn rough(&self, x: f64, radius: f64, [behind, ahead]: [f64; 2]) -> (f64, Point) {
        let up = Point::new(0.0, 1.0);
        let (lo, hi) = (x - behind - radius, x + ahead + radius);
        // The knots from the last before the foot to the first past it.
        let from = self.knots.partition_point(|knot| knot.x <= lo).saturating_sub(1);
        let to = (self.knots.partition_point(|knot| knot.x <= hi) + 1).min(self.knots.len());
        let knots = &self.knots[from..to];
        let (Some(&first), Some(&last)) = (knots.first(), knots.last()) else {
            return (0.0, up);
        };
        let mut best = (f64::NEG_INFINITY, up);
        let mut meet = |a: Point, b: Point| {
            let (left, right) = (a.x.max(lo), b.x.min(hi));
            if left > right {
                return;
            }
            let slope = (b.y - a.y) / (b.x - a.x);
            let at = |x: f64| a.y + (x - a.x) * slope;
            // The flat of a foot meets the line between two knots at an end of where it runs over it.
            if behind + ahead > 0.0 {
                let (l, r) = (left.max(x - behind), right.min(x + ahead));
                if l <= r && at(l).max(at(r)) > best.0 {
                    best = (at(l).max(at(r)), up);
                }
            }
            // A round end meets it where it would touch it, or at an end of it, as a wheel meets the ground (`seat`).
            for (middle, from, to) in [(x - behind, left, right.min(x - behind)), (x + ahead, left.max(x + ahead), right)] {
                if from > to {
                    continue;
                }
                let dx = (radius * slope / sqrt(1.0 + slope * slope)).clamp(from - middle, to - middle);
                let span = sqrt((radius * radius - dx * dx).max(0.0));
                let y = at(middle + dx) - (radius - span);
                if y > best.0 {
                    best = (y, Point::new(-dx / radius, span / radius));
                }
            }
        };
        // Before the first knot and past the last the ground has none: it is its line.
        if first.x > lo {
            meet(Point::new(lo - 1.0, 0.0), first);
        }
        for pair in knots.windows(2) {
            meet(pair[0], pair[1]);
        }
        if last.x < hi {
            meet(last, Point::new(hi + 1.0, 0.0));
        }
        best
    }
}
#[derive(Clone, Copy, Debug)]
pub struct TerrainSurface {
    pub point: Point,
    pub normal: Point,
    pub surface: SurfaceKind,
}
#[derive(Clone, Copy, Debug)]
pub struct TerrainHit {
    pub enter: f64,
    pub point: Point,
    pub normal: Point,
    pub surface: SurfaceKind,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TerrainSupport {
    pub normal: Point,
    pub tangent: Point,
    pub point: Point,
    pub contacts: u32,
    pub materials: [f64; SURFACE_KINDS],
    pub material_order: Vec<SurfaceKind>,
    pub min_x: f64,
    pub max_x: f64,
}
impl TerrainSupport {
    pub fn to_value(&self) -> Value {
        let materials: serde_json::Map<_, _> = self
            .material_order
            .iter()
            .map(|s| (s.name().to_string(), json!(self.materials[*s as usize])))
            .collect();
        json!({"nx":self.normal.x,"ny":self.normal.y,"tx":self.tangent.x,"ty":self.tangent.y,"x":self.point.x,"y":self.point.y,"contacts":self.contacts,"materials":materials,"minX":self.min_x,"maxX":self.max_x})
    }
}
#[derive(Clone, Copy, Debug)]
pub struct Sector {
    pub start: f64,
    pub end: f64,
    pub surface: SurfaceKind,
}
#[derive(Clone, Copy, Debug)]
struct Profile {
    a: Point,
    b: Point,
    slope: f64,
    normal: Point,
}
#[derive(Clone, Debug, Default)]
pub struct Terrain {
    pub seed: u32,
    pub length: f64,
    pub center: f64,
    pub material: SurfaceKind,
    pub points: Vec<Point>,
    pub sectors: Vec<Sector>,
    /// The roads the field laid over the ground (`set_roads`): in order, apart from one another. Over a road the ground
    /// is the road's, for grip, rolling and bumps; its height is the ground's.
    pub roads: Vec<Sector>,
    pub min_x: f64,
    pub max_x: f64,
    profiles: Vec<Profile>,
    flat: bool,
    /// The highest ground: a chord that stays above it meets none.
    top: f64,
    /// The highest ground of each run of `RUN` points of the outline, from the first: a chord that stays above the
    /// highest of the runs it spans meets none of their ground.
    runs: Vec<f64>,
}
/// How many points of the outline make a run of `Terrain::runs`: 256 m of the main world's, as long as a line an optic
/// reads at a time is a piece of.
const RUN: usize = 64;
#[derive(Clone, Copy)]
struct Landform {
    kind: &'static str,
    start: f64,
    peak: f64,
    end: f64,
    height: f64,
    surface: SurfaceKind,
    crest: f64,
}
const MIN_LANDSCAPE_LENGTH: f64 = 1000.0;
const MAX_LANDSCAPE_LENGTH: f64 = 512000.0;
/// The biomes, and the landscapes: each biome alone, or the world that has them all.
pub const BIOME_IDS: [&str; 5] = ["wet-valley", "arid-basin", "rural-ridges", "highlands", "plateau"];
pub const LANDSCAPE_IDS: [&str; 6] = ["wet-valley", "arid-basin", "rural-ridges", "highlands", "plateau", "world"];
fn terrain_random(seed: u32, channel: u32, cell: i32) -> f64 {
    let mut n = seed
        ^ channel.wrapping_add(1).wrapping_mul(0x9e3779b9)
        ^ (cell as u32).wrapping_mul(0x85ebca6b);
    n = (n ^ (n >> 16)).wrapping_mul(0x7feb352d);
    n = (n ^ (n >> 15)).wrapping_mul(0x846ca68b);
    (n ^ (n >> 16)) as f64 / 4294967296.0
}
fn terrain_noise(seed: u32, channel: u32, x: f64, scale: f64) -> f64 {
    let cell = (x / scale).floor() as i32;
    let t = smooth(x / scale - cell as f64);
    let a = terrain_random(seed, channel, cell) * 2.0 - 1.0;
    let b = terrain_random(seed, channel, cell + 1) * 2.0 - 1.0;
    a + (b - a) * t
}
/// Local, correlated folds supplement the broad landforms without increasing
/// the contact contour's size. Even the shortest cell spans four 4 m samples.
fn local_relief(id: &str, seed: u32, u: f64) -> f64 {
    let amplitudes = match id {
        "wet-valley" => [1.4, 0.8, 0.2],
        "arid-basin" => [1.8, 1.0, 0.18],
        "rural-ridges" => [1.2, 0.9, 0.22],
        "highlands" => [1.2, 0.9, 0.24],
        "plateau" => [1.5, 0.9, 0.22],
        _ => unreachable!(),
    };
    amplitudes[0] * terrain_noise(seed, 401, u, 112.0)
        + amplitudes[1] * terrain_noise(seed, 402, u, 40.0)
        + amplitudes[2] * terrain_noise(seed, 403, u, 16.0)
}
const RELIEF_MARGIN: f64 = 32.0;
fn relief_guards(forms: &[Landform]) -> Vec<Landform> {
    forms.iter().filter(|f| matches!(f.kind, "road" | "ruins"))
        .map(|f| Landform { start: f.start - RELIEF_MARGIN, end: f.end + RELIEF_MARGIN, ..*f }).collect()
}
/// Roads and slabs retain their profile, with a smooth approach on both sides.
/// Broad mesa summits stay useful without becoming completely featureless.
fn relief_mask<'a>(u: f64, forms: impl Iterator<Item = &'a Landform>, guards: impl Iterator<Item = &'a Landform>) -> f64 {
    let mut gain = 1.0;
    for f in forms.filter(|f| f.kind == "plateau") {
        gain *= 1.0 - 0.8 * mound(u, f.start, f.peak - f.crest / 2.0, f.peak + f.crest / 2.0, f.end, 1.0);
    }
    for f in guards {
        gain *= 1.0 - mound(u, f.start, f.start + RELIEF_MARGIN, f.end - RELIEF_MARGIN, f.end, 1.0);
    }
    gain
}
fn landform_height(x: f64, f: &Landform) -> f64 {
    if x <= f.start || x >= f.end || f.height == 0.0 {
        return 0.0;
    }
    if f.kind == "plateau" {
        return mound(x, f.start, f.peak - f.crest / 2.0, f.peak + f.crest / 2.0, f.end, f.height);
    }
    f.height
        * if x <= f.peak {
            smooth((x - f.start) / (f.peak - f.start))
        } else {
            1.0 - smooth((x - f.peak) / (f.end - f.peak))
        }
}
fn landscape_id(id: &str) -> bool {
    LANDSCAPE_IDS.contains(&id)
}
fn relief_features(id: &str, seed: u32, length: f64) -> Vec<Landform> {
    let half = length / 2.0;
    let plateau = id == "plateau";
    let period = if plateau { 500.0 } else { 320.0 };
    let mut forms = Vec::new();
    let lo = ((-half + 100.0) / period).ceil() as i32;
    let hi = ((half - 100.0) / period).floor() as i32;
    for cell in lo..=hi {
        let x = cell as f64 * period + (terrain_random(seed, 201, cell) - 0.5) * 48.0;
        let height = (if plateau { 26.0 } else { 22.0 }) + terrain_random(seed, 202, cell) * (if plateau { 16.0 } else { 24.0 });
        let crest = if plateau { 70.0 + terrain_random(seed, 203, cell) * 56.0 } else { 0.0 };
        let width = height * (8.0 + terrain_random(seed, 204, cell) * 1.2);
        let left = if plateau { height * (3.9 + terrain_random(seed, 205, cell)) + crest / 2.0 }
            else { width * (0.48 + terrain_random(seed, 205, cell) * 0.04) };
        let right = if plateau { height * (3.8 + terrain_random(seed, 206, cell)) + crest / 2.0 } else { width - left };
        if x - left <= -half + 45.0 || x + right >= half - 45.0 { continue; }
        forms.push(Landform { kind: if plateau { "plateau" } else { "ridge" }, start: x - left, peak: x, end: x + right,
            height, surface: if plateau { SurfaceKind::Rock } else { SurfaceKind::Soil }, crest });
        let mut add = |kind, start, peak, end, height, surface| {
            if start > -half + 45.0 && end < half - 45.0 {
                forms.push(Landform { kind, start, peak, end, height, surface, crest: 0.0 });
            }
        };
        if plateau {
            add("scarp", x - left, x - crest / 2.0 - height, x - crest / 2.0, 0.0, SurfaceKind::Rock);
            add("scarp", x + crest / 2.0, x + crest / 2.0 + height, x + right, 0.0, SurfaceKind::Rock);
        } else { add("outcrop", x - 9.0, x, x + 9.0, 0.18, SurfaceKind::Rock); }
        add("talus", x - left - 10.0, x - left + 2.0, x - left + 14.0, 0.0, SurfaceKind::Gravel);
        add("talus", x + right - 14.0, x + right - 2.0, x + right + 10.0, 0.0, SurfaceKind::Gravel);
        let valley = x + period / 2.0;
        add("drywash", valley - 22.0, valley, valley + 22.0, -0.65, SurfaceKind::Gravel);
    }
    forms
}
fn landscape_features(id: &str, seed: u32, length: f64) -> Vec<Landform> {
    if matches!(id, "highlands" | "plateau") { return relief_features(id, seed, length); }
    let half = length / 2.0;
    let basin = terrain_random(seed, 100, 0) * 120.0 - 60.0;
    let mut forms = Vec::new();
    if id == "wet-valley" {
        forms.push(Landform {
            kind: "lowland",
            start: basin - 300.0,
            peak: basin,
            end: basin + 300.0,
            height: -6.0,
            surface: SurfaceKind::Mud,
            crest: 0.0,
        });
    }
    let mut add = |kind, start, peak, end, height, surface| {
        if start > -half + 45.0 && end < half - 45.0 {
            forms.push(Landform {
                kind,
                start,
                peak,
                end,
                height,
                surface,
                crest: 0.0,
            });
        }
    };
    if id == "wet-valley" {
        add(
            "road",
            basin - 290.0,
            basin - 235.0,
            basin - 180.0,
            0.0,
            SurfaceKind::Gravel,
        );
        add(
            "road",
            basin + 180.0,
            basin + 235.0,
            basin + 290.0,
            0.0,
            SurfaceKind::Gravel,
        );
    } else if id == "arid-basin" {
        add(
            "drywash",
            basin - 65.0,
            basin,
            basin + 65.0,
            -1.0,
            SurfaceKind::Gravel,
        );
    }
    let lo = ((-half + 100.0) / 180.0).ceil() as i32;
    let hi = ((half - 100.0) / 180.0).floor() as i32;
    for cell in lo..=hi {
        let x = cell as f64 * 180.0 + (terrain_random(seed, 101, cell) - 0.5) * 50.0;
        let width = 100.0 + terrain_random(seed, 102, cell) * 30.0;
        if id == "arid-basin" {
            add(
                "dune",
                x - width / 2.0,
                x - width * 0.08,
                x + width / 2.0,
                1.8 + terrain_random(seed, 103, cell) * 1.4,
                SurfaceKind::Sand,
            );
        } else if id == "rural-ridges" {
            add(
                "embankment",
                x - 40.0,
                x,
                x + 40.0,
                1.4 + terrain_random(seed, 103, cell),
                SurfaceKind::Soil,
            );
            if cell.abs() % 2 == 0 {
                add("ruins", x - 10.0, x, x + 10.0, 0.3, SurfaceKind::Concrete);
            } else {
                add("road", x - 48.0, x, x + 48.0, 0.0, SurfaceKind::Gravel);
            }
        } else if cell.abs() % 2 == 0 {
            add("lowland", x - 65.0, x, x + 65.0, -1.2, SurfaceKind::Mud);
        }
        if cell.abs() % 3 == 1 {
            add(
                "outcrop",
                x + 46.0,
                x + 56.0,
                x + 66.0,
                0.35,
                SurfaceKind::Rock,
            );
        }
    }
    forms
}
// Keep a small active set instead of scanning the entire map at every sample.
// Its original order preserves the established Float32 seed fixtures.
struct FormSweep<'a> { forms: &'a [Landform], order: Vec<usize>, active: Vec<usize>, cursor: usize }
impl<'a> FormSweep<'a> {
    fn new(forms: &'a [Landform]) -> Self {
        let mut order: Vec<_> = (0..forms.len()).collect();
        order.sort_by(|&a, &b| forms[a].start.total_cmp(&forms[b].start).then(a.cmp(&b)));
        Self { forms, order, active: Vec::with_capacity(12), cursor: 0 }
    }
    fn at(&mut self, x: f64) -> impl Iterator<Item = &'a Landform> + Clone + '_ {
        self.active.retain(|&i| self.forms[i].end >= x);
        let mut added = false;
        while self.cursor < self.order.len() && self.forms[self.order[self.cursor]].start <= x {
            let index = self.order[self.cursor]; self.cursor += 1;
            if self.forms[index].end >= x { self.active.push(index); added = true; }
        }
        if added { self.active.sort_unstable(); }
        let forms = self.forms;
        self.active.iter().map(move |&i| &forms[i])
    }
}
struct RegionalElevation { period: f64, lo: i32, levels: Vec<f64> }
impl RegionalElevation {
    fn new(id: &str, seed: u32, length: f64) -> Option<Self> {
        if !matches!(id, "highlands" | "plateau") { return None; }
        let period = if id == "plateau" { 500.0 } else { 320.0 };
        let lo = (-length / 2.0 / period).floor() as i32 - 2;
        let hi = (length / 2.0 / period).ceil() as i32 + 2;
        let mut levels = vec![0.0; (hi - lo + 1) as usize];
        let step = |cell| 28.0 * (0.65 * terrain_noise(seed, 220, cell as f64 * period, period * 7.0)
            + 0.35 * (terrain_random(seed, 221, cell) * 2.0 - 1.0));
        levels[(-lo) as usize] = 90.0 + terrain_random(seed, 222, 0) * 40.0;
        for cell in 1..=hi { let i = (cell - lo) as usize; levels[i] = levels[i - 1] + step(cell - 1); }
        for cell in (lo..0).rev() { let i = (cell - lo) as usize; levels[i] = levels[i + 1] - step(cell); }
        Some(Self { period, lo, levels })
    }
    fn at(&self, x: f64) -> f64 {
        let cell = (x / self.period).floor() as i32;
        let t = smooth(x / self.period - cell as f64);
        let i = (cell - self.lo) as usize;
        self.levels[i] + (self.levels[i + 1] - self.levels[i]) * t
    }
}
/// Ease the grade to zero at the edge while retaining its natural altitude.
fn eased(u: f64, half: f64) -> f64 {
    if u < -half + 40.0 {
        let t = (u + half) / 40.0;
        -half + 40.0 * (2.0 * t * t - t * t * t)
    } else if u > half - 40.0 {
        let t = (half - u) / 40.0;
        half - 40.0 * (2.0 * t * t - t * t * t)
    } else {
        u
    }
}
/// The level ground of a biome before its landforms. Serras and chapadas
/// follow their regional altitude.
fn biome_base<'a>(id: &str, seed: u32, u: f64, forms: impl Iterator<Item = &'a Landform> + Clone, elevation: Option<&RegionalElevation>) -> f64 {
    let a = if elevation.is_some() { 0.0 } else { terrain_noise(seed, 11, u, 420.0) };
    let b = if elevation.is_some() { 0.0 } else { terrain_noise(seed, 12, u, 160.0) };
    let c = terrain_noise(seed, 13, u, 48.0);
    let mut regional_x = u;
    if id == "plateau" {
        for f in forms.clone().filter(|f| f.kind == "plateau") {
            let influence = mound(u, f.start, f.peak - f.crest / 2.0, f.peak + f.crest / 2.0, f.end, 1.0);
            regional_x += (f.peak - u) * influence;
        }
    }
    if id == "wet-valley" {
        14.0 + 12.0 * a + 3.0 * b + 0.35 * c
    } else if id == "arid-basin" {
        10.0 + 8.0 * a + 2.8 * b + 0.25 * c
    } else if let Some(elevation) = elevation {
        elevation.at(regional_x) + 0.08 * c
    } else {
        12.0 + 10.0 * a + 3.0 * b + 0.3 * c
    }
}
fn landscape_height<'a>(id: &str, seed: u32, length: f64, u: f64, forms: impl Iterator<Item = &'a Landform> + Clone,
    guards: impl Iterator<Item = &'a Landform>, elevation: Option<&RegionalElevation>) -> f64 {
    let u = eased(u, length / 2.0);
    let mut y = biome_base(id, seed, u, forms.clone(), elevation);
    let detail = local_relief(id, seed, u) * relief_mask(u, forms.clone(), guards);
    for f in forms {
        y += landform_height(u, f);
    }
    (y + detail) as f32 as f64
}
fn biome_material(id: &str) -> SurfaceKind {
    match id {
        "arid-basin" => SurfaceKind::Sand,
        "plateau" => SurfaceKind::Rock,
        _ => SurfaceKind::Soil,
    }
}
// The world is a row of biomes a few kilometres long each. Everything about a
// region follows from the number of its cell, counted from the middle of the
// map, so a longer map keeps the geography of a shorter one and adds to it.
// src/terrain.js grows the same world; the parity fixture holds both to it.
const WORLD_CELL: f64 = 3200.0;
const WORLD_JITTER: f64 = 600.0;
const WORLD_BLEND: f64 = 120.0;
const WORLD_MARGIN: f64 = 160.0;
const WORLD_FLOOR: f64 = 20.0;
fn world_border(seed: u32, cell: i32) -> f64 {
    (cell as f64 - 0.5) * WORLD_CELL + (terrain_random(seed, 301, cell) * 2.0 - 1.0) * WORLD_JITTER
}
/// Every five cells in a row hold the five biomes, in an order of their own.
fn world_biome(seed: u32, cell: i32) -> &'static str {
    let block = cell.div_euclid(5);
    let mut order = [0usize, 1, 2, 3, 4];
    for j in (1..5usize).rev() {
        let r = (terrain_random(seed, 300, block * 8 + j as i32) * (j + 1) as f64).floor() as usize;
        order.swap(j, r);
    }
    BIOME_IDS[order[cell.rem_euclid(5) as usize]]
}
struct Biome { id: &'static str, start: f64, end: f64, offset: f64 }
struct World { seed: u32, regions: Vec<Biome>, highlands: RegionalElevation, plateau: RegionalElevation }
impl World {
    fn new(seed: u32, length: f64) -> Self {
        let half = length / 2.0;
        let cells = (half / WORLD_CELL).ceil() as i32 + 1;
        let mut regions: Vec<Biome> = Vec::new();
        for cell in -cells..=cells {
            let id = world_biome(seed, cell);
            let end = world_border(seed, cell + 1);
            match regions.last_mut() {
                Some(previous) if previous.id == id => previous.end = end,
                _ => regions.push(Biome { id, start: world_border(seed, cell), end, offset: 0.0 }),
            }
        }
        regions.retain(|r| r.end > -half && r.start < half);
        let mut world = Self { seed, regions,
            highlands: RegionalElevation::new("highlands", seed, length).unwrap(),
            plateau: RegionalElevation::new("plateau", seed, length).unwrap() };
        // The middle region keeps the altitude of its biome; each neighbour is
        // raised or lowered to meet the one before it at their border.
        let home = world.index(0.0);
        let none = std::iter::empty::<&Landform>;
        for i in home + 1..world.regions.len() {
            let x = world.regions[i].start;
            world.regions[i].offset = world.base(i - 1, x, none()) + world.regions[i - 1].offset - world.base(i, x, none());
        }
        for i in (0..home).rev() {
            let x = world.regions[i].end;
            world.regions[i].offset = world.base(i + 1, x, none()) + world.regions[i + 1].offset - world.base(i, x, none());
        }
        world
    }
    fn index(&self, u: f64) -> usize {
        let mut i = 0;
        while i + 1 < self.regions.len() && self.regions[i].end <= u { i += 1; }
        i
    }
    fn biome(&self, u: f64) -> &'static str { self.regions[self.index(u)].id }
    fn base<'a>(&self, i: usize, u: f64, forms: impl Iterator<Item = &'a Landform> + Clone) -> f64 {
        let id = self.regions[i].id;
        let elevation = match id { "highlands" => Some(&self.highlands), "plateau" => Some(&self.plateau), _ => None };
        biome_base(id, self.seed, u, forms, elevation)
    }
    /// A landform belongs to the world only well inside a region of its own biome.
    fn features(&self, length: f64) -> Vec<Landform> {
        let mut forms = Vec::new();
        for id in BIOME_IDS {
            for f in landscape_features(id, self.seed, length) {
                if self.regions.iter().any(|r| r.id == id && f.start >= r.start + WORLD_MARGIN && f.end <= r.end - WORLD_MARGIN) {
                    forms.push(f);
                }
            }
        }
        forms
    }
    /// Near a border the two grounds are faded into each other.
    fn height<'a>(&self, u: f64, forms: impl Iterator<Item = &'a Landform> + Clone, guards: impl Iterator<Item = &'a Landform>) -> f64 {
        let i = self.index(u);
        let r = &self.regions[i];
        let mut y = self.base(i, u, forms.clone()) + r.offset;
        let mut detail = local_relief(r.id, self.seed, u);
        if i > 0 && u - r.start < WORLD_BLEND {
            let other = self.base(i - 1, u, forms.clone()) + self.regions[i - 1].offset;
            let other_detail = local_relief(self.regions[i - 1].id, self.seed, u);
            let t = smooth((u - r.start + WORLD_BLEND) / (2.0 * WORLD_BLEND));
            y = other + (y - other) * t;
            detail = other_detail + (detail - other_detail) * t;
        } else if i + 1 < self.regions.len() && r.end - u < WORLD_BLEND {
            let other = self.base(i + 1, u, forms.clone()) + self.regions[i + 1].offset;
            let other_detail = local_relief(self.regions[i + 1].id, self.seed, u);
            let t = smooth((u - r.end + WORLD_BLEND) / (2.0 * WORLD_BLEND));
            y = y + (other - y) * t;
            detail += (other_detail - detail) * t;
        }
        let mask = relief_mask(u, forms.clone(), guards);
        for f in forms {
            y += landform_height(u, f);
        }
        // Do not feed local folds back into the offsets aligning whole regions.
        y + detail * mask
    }
}
/// One sample of a landscape: a biome's own ground, or the world's, still to be raised.
fn ground_height<'a>(world: Option<&World>, id: &str, seed: u32, length: f64, u: f64, forms: impl Iterator<Item = &'a Landform> + Clone,
    guards: impl Iterator<Item = &'a Landform>, elevation: Option<&RegionalElevation>) -> f64 {
    match world {
        Some(world) => world.height(eased(u, length / 2.0), forms, guards),
        None => landscape_height(id, seed, length, u, forms, guards, elevation),
    }
}
fn landscape_surface<'a>(
    id: &str,
    seed: u32,
    u: f64,
    forms: impl Iterator<Item = &'a Landform> + Clone,
    material: SurfaceKind,
) -> SurfaceKind {
    for kind in ["outcrop", "scarp", "talus", "ruins", "road", "drywash"] {
        if let Some(f) = forms
            .clone()
            .find(|f| f.kind == kind && u >= f.start && u < f.end)
        {
            return f.surface;
        }
    }
    if id == "wet-valley"
        && forms
            .clone()
            .any(|f| f.kind == "lowland" && landform_height(u, f) < f.height * 0.65)
    {
        return SurfaceKind::Mud;
    }
    if id == "arid-basin"
        && terrain_noise(seed, 11, u, 420.0) < -0.15
        && terrain_noise(seed, 12, u, 160.0) < 0.2
    {
        return SurfaceKind::Gravel;
    }
    material
}
/// Where level ground ends, as a page has its test tracks end: an enclosed field stops a vehicle short of it.
const LEVEL_MIN: f64 = -384.0;
const LEVEL_MAX: f64 = 408.0;
/// The test tracks a page draws whole and sends by their outline (`from_value`): the core grows none of them.
const TRACK_IDS: [&str; 5] = ["mixed", "mud", "sand", "hills", "rough"];
fn smooth(x: f64) -> f64 {
    let t = x.clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
fn mound(x: f64, a: f64, b: f64, c: f64, d: f64, height: f64) -> f64 {
    height * smooth((x - a) / (b - a)) * (1.0 - smooth((x - c) / (d - c)))
}
impl Terrain {
    /// The ground of a name alone: a landscape grown from its defaults or level concrete.
    pub fn new(id: &str) -> Result<Self, String> {
        if landscape_id(id) {
            return Self::landscape(id, 6173, 1600.0, 0.0);
        }
        match id {
            "flat" => Self::from_points(SurfaceKind::Concrete, vec![Point::new(-1600.0, 0.0), Point::new(1600.0, 0.0)],
                vec![Sector { start: -1600.0, end: 1600.0, surface: SurfaceKind::Concrete }], LEVEL_MIN, LEVEL_MAX),
            _ => Err(format!("Unknown terrain {id}")),
        }
    }
    pub fn landscape(id: &str, seed: u32, length: f64, center: f64) -> Result<Self, String> {
        if !landscape_id(id)
            || !length.is_finite()
            || !(MIN_LANDSCAPE_LENGTH..=MAX_LANDSCAPE_LENGTH).contains(&length)
            || !center.is_finite()
            || center.abs() > 100000.0
        {
            return Err("Invalid landscape parameters".into());
        }
        let length = (length + 0.5).floor();
        let center = (center * 2.0 + 0.5).floor() / 2.0;
        let half = length / 2.0;
        let min_x = center - half;
        let max_x = center + half;
        let material = biome_material(id);
        let world = (id == "world").then(|| World::new(seed, length));
        let forms = match &world {
            Some(world) => world.features(length),
            None => landscape_features(id, seed, length),
        };
        let elevation = RegionalElevation::new(id, seed, length);
        let spacing = if length <= 4096.0 { 1 } else if length <= 8192.0 { 2 } else { 4 };
        let mut heights = FormSweep::new(&forms);
        let mut regions = FormSweep::new(&forms);
        let guards = relief_guards(&forms);
        let mut protection = FormSweep::new(&guards);
        let mut points = Vec::with_capacity((length as usize).div_ceil(spacing) + 3);
        points.push(Point::new(
            min_x - 256.0,
            ground_height(world.as_ref(), id, seed, length, -half, forms.iter(), guards.iter(), elevation.as_ref()),
        ));
        for i in (0..length as usize).step_by(spacing) {
            points.push(Point::new(
                min_x + i as f64,
                ground_height(world.as_ref(), id, seed, length, i as f64 - half, heights.at(i as f64 - half), protection.at(i as f64 - half), elevation.as_ref()),
            ));
        }
        let end_height = ground_height(world.as_ref(), id, seed, length, half, forms.iter(), guards.iter(), elevation.as_ref());
        points.push(Point::new(max_x, end_height));
        points.push(Point::new(max_x + 256.0, end_height));
        if world.is_some() {
            // The whole world is raised until its lowest ground stands clear of zero.
            let low = points.iter().fold(f64::INFINITY, |low, p| if p.y < low { p.y } else { low });
            let lift = (WORLD_FLOOR - low).max(0.0);
            for p in &mut points {
                p.y = (p.y + lift) as f32 as f64;
            }
        }
        let mut sectors: Vec<Sector> = Vec::new();
        for i in (0..length as usize).step_by(spacing) {
            let x = min_x + i as f64;
            let end = min_x + ((i + spacing) as f64).min(length);
            let u = (x + end) / 2.0 - center;
            let surface = match &world {
                Some(world) => {
                    let biome = world.biome(u);
                    landscape_surface(biome, seed, u, regions.at(u), biome_material(biome))
                }
                None => landscape_surface(id, seed, u, regions.at(u), material),
            };
            if let Some(previous) = sectors.last_mut().filter(|p| p.surface == surface) {
                previous.end = end;
            } else {
                sectors.push(Sector {
                    start: x,
                    end,
                    surface,
                });
            }
        }
        sectors.first_mut().unwrap().start = min_x - 256.0;
        sectors.last_mut().unwrap().end = max_x + 256.0;
        let mut terrain = Self::from_points(material, points, sectors, min_x, max_x)?;
        terrain.seed = seed;
        terrain.length = length;
        terrain.center = center;
        Ok(terrain)
    }
    pub fn from_value(v: &Value) -> Result<Self, String> {
        if let Some(id) = v.as_str() {
            return Self::new(id);
        }
        let mut terrain = Self::outline(v)?;
        if let Some(roads) = v.get("roads") {
            terrain.set_roads(roads)?;
        }
        Ok(terrain)
    }
    /// Lays the roads of the field (`roads`) over the ground, in place of those it had: `[{x0, x1, kind}]`, a road from
    /// `x0` up to `x1`, of `graded` or `asphalt`, each after the one before and apart from it. Anything else is refused,
    /// and the ground keeps the roads it had.
    pub fn set_roads(&mut self, roads: &Value) -> Result<(), String> {
        let list = roads.as_array().ok_or("Roads must be an array")?;
        let mut laid: Vec<Sector> = Vec::with_capacity(list.len());
        for road in list {
            let (start, end) = (road["x0"].as_f64(), road["x1"].as_f64());
            let (Some(start), Some(end), Some(surface)) = (start, end, road["kind"].as_str().and_then(SurfaceKind::road)) else {
                return Err("Invalid road".into());
            };
            if !start.is_finite() || !end.is_finite() || end <= start || laid.last().is_some_and(|before| start < before.end) {
                return Err("Roads must be finite, in order and apart".into());
            }
            laid.push(Sector { start, end, surface });
        }
        self.roads = laid;
        Ok(())
    }
    fn outline(v: &Value) -> Result<Self, String> {
        let id = v["id"].as_str().unwrap_or("flat");
        let base = if landscape_id(id) {
            let scalar = |field: &str, default: f64| -> Result<f64, String> {
                match v.get(field) {
                    None | Some(Value::Null) => Ok(default),
                    Some(value) => value
                        .as_f64()
                        .ok_or_else(|| "Invalid landscape parameters".into()),
                }
            };
            let seed = scalar("seed", 6173.0)?;
            if !seed.is_finite() || seed.fract() != 0.0 || !(0.0..=u32::MAX as f64).contains(&seed)
            {
                return Err("Invalid terrain seed".into());
            }
            Self::landscape(
                id,
                seed as u32,
                scalar("length", 1600.0)?,
                scalar("center", 0.0)?,
            )?
        } else {
            // A test track is told by its outline; what it leaves unsaid is as level ground has it.
            Self::new(if TRACK_IDS.contains(&id) && v["points"].is_array() { "flat" } else { id })?
        };
        let Some(points) = v["points"].as_array() else {
            return Ok(base);
        };
        let points = points.iter().map(Point::from_value).collect();
        let sectors = v["sectors"]
            .as_array()
            .map(|a| {
                a.iter()
                    .map(|s| Sector {
                        start: number(s, "start", -1600.0),
                        end: number(s, "end", 1600.0),
                        surface: SurfaceKind::from_name(s["surface"].as_str().unwrap_or("soil")),
                    })
                    .collect()
            })
            .unwrap_or(base.sectors);
        let mut terrain = Self::from_points(
            SurfaceKind::from_name(v["material"].as_str().unwrap_or(base.material.name())),
            points,
            sectors,
            number(v, "minX", base.min_x),
            number(v, "maxX", base.max_x),
        )?;
        terrain.seed = base.seed;
        terrain.length = base.length;
        terrain.center = base.center;
        Ok(terrain)
    }
    pub fn from_points(
        material: SurfaceKind,
        points: Vec<Point>,
        mut sectors: Vec<Sector>,
        min_x: f64,
        max_x: f64,
    ) -> Result<Self, String> {
        if points.len() < 2
            || points.iter().any(|p| !p.x.is_finite() || !p.y.is_finite())
            || points.windows(2).any(|p| p[0].x >= p[1].x)
        {
            return Err("Invalid terrain polyline".into());
        }
        sectors.sort_by(|a, b| a.start.total_cmp(&b.start));
        let mut profiles = Vec::with_capacity(points.len() - 1);
        for pair in points.windows(2) {
            let a = pair[0];
            let b = pair[1];
            let slope = (b.y - a.y) / (b.x - a.x);
            let scale = hypot(1.0, slope);
            profiles.push(Profile {
                a,
                b,
                slope,
                normal: Point::new(-slope / scale, 1.0 / scale),
            });
        }
        let flat = points.iter().all(|p| p.y == 0.0);
        let highest = |run: &[Point]| run.iter().fold(f64::NEG_INFINITY, |top, p| if p.y > top { p.y } else { top });
        let (top, runs) = (highest(&points), points.chunks(RUN).map(highest).collect());
        Ok(Self {
            seed: 0,
            length: max_x - min_x,
            center: (max_x + min_x) / 2.0,
            material,
            points,
            sectors,
            roads: Vec::new(),
            min_x,
            max_x,
            profiles,
            flat,
            top,
            runs,
        })
    }
    /// Whether the actual contour is the zero-height plane, including restored terrain.
    pub fn is_flat(&self) -> bool {
        self.flat
    }
    /// The ground at a place: the road laid there, or the ground itself.
    pub fn material_at(&self, x: f64) -> SurfaceKind {
        let road = self.roads.partition_point(|s| s.end <= x);
        if let Some(road) = self.roads.get(road).filter(|s| x >= s.start) {
            return road.surface;
        }
        let i = self.sectors.partition_point(|s| s.end <= x);
        self.sectors
            .get(i)
            .filter(|s| x >= s.start)
            .map(|s| s.surface)
            .unwrap_or(self.material)
    }
    /// The stretch of one ground a place lies in (`material_at`): where it starts and where it ends, and of what it is.
    fn stretch(&self, x: f64) -> (f64, f64, SurfaceKind) {
        let r = self.roads.partition_point(|s| s.end <= x);
        if let Some(road) = self.roads.get(r).filter(|s| x >= s.start) {
            return (road.start, road.end, road.surface);
        }
        let before = if r > 0 { self.roads[r - 1].end } else { f64::NEG_INFINITY };
        let after = self.roads.get(r).map_or(f64::INFINITY, |s| s.start);
        let i = self.sectors.partition_point(|s| s.end <= x);
        let (start, end, surface) = match self.sectors.get(i).filter(|s| x >= s.start) {
            Some(s) => (s.start, s.end, s.surface),
            None => (
                if i > 0 { self.sectors[i - 1].end } else { f64::NEG_INFINITY },
                self.sectors.get(i).map_or(f64::INFINITY, |s| s.start),
                self.material,
            ),
        };
        (start.max(before), end.min(after), surface)
    }
    /// The bumps of the ground (`Bumps`) under a running gear standing on it from `lo` to `hi` along it.
    pub fn underfoot(&self, lo: f64, hi: f64) -> Underfoot {
        let mut under = Underfoot { knots: Vec::new() };
        let mut from = lo;
        loop {
            let (start, end, ground) = self.stretch(from);
            if let Some(bumps) = ground.bumps() {
                if start.is_finite() {
                    under.push(Point::new(start, 0.0));
                }
                // The knot of a stretch of `pitch` lies within it: from the last knot before `lo` to the first past `hi`.
                // Those within half a pitch of an end of the ground are left out (`Bumps::within`), so by its end the
                // last knot before `lo` may be two stretches back, and by its start the first past `hi` two on.
                let first = (from / bumps.pitch).floor() as i32 - 2;
                let last = (hi.min(end) / bumps.pitch).floor() as i32 + 2;
                for cell in first..=last {
                    let knot = bumps.knot(self.seed, cell);
                    if bumps.within(knot, start, end) {
                        under.push(knot);
                    }
                }
                if end.is_finite() {
                    under.push(Point::new(end, 0.0));
                }
            }
            if end >= hi {
                break;
            }
            from = end;
        }
        under
    }
    fn segment_index(&self, x: f64) -> usize {
        self.points
            .partition_point(|p| p.x <= x)
            .saturating_sub(1)
            .min(self.profiles.len() - 1)
    }
    pub fn height(&self, x: f64) -> f64 {
        if x <= self.min_x {
            return self.surface(self.min_x).point.y;
        }
        if x >= self.max_x {
            return self.surface(self.max_x).point.y;
        }
        let p = self.profiles[self.segment_index(x)];
        p.a.y + (x - p.a.x) * p.slope
    }
    pub fn surface(&self, x: f64) -> TerrainSurface {
        let p = self.profiles[self.segment_index(x)];
        TerrainSurface {
            point: Point::new(x, p.a.y + (x - p.a.x) * p.slope),
            normal: p.normal,
            surface: self.material_at(x),
        }
    }
    /// How far a wheel stands into the ground it stands on: the rise that would leave its rim on it,
    /// negative while it is off it, and the way the ground pushes on it there. The ground is straight
    /// between its breakpoints, so the rim meets each stretch at one place, or at an end of it, and
    /// is level past its ends. Ground that would push it more aslant of `up` than the cosine `least`
    /// is a face it climbs, not ground it stands on, and is left out: a wheel met by nothing else
    /// stands on nothing. On the ground it stands, its foot stands as far up again as the bumps of the
    /// ground `under` it have it, which turn the way the ground pushes it as they slope (`Underfoot::rough`),
    /// on a foot `flat` behind its middle and ahead of it.
    pub fn seat(&self, center: Point, radius: f64, flat: [f64; 2], up: Point, least: f64, under: &Underfoot) -> (f64, Point) {
        let stands = |normal: Point| normal.x * up.x + normal.y * up.y >= least;
        let (mut rise, mut normal, mut met) = (f64::NEG_INFINITY, Point::new(0.0, 1.0), false);
        let lo = center.x - radius;
        let hi = center.x + radius;
        if !self.flat {
            for p in &self.profiles[self.segment_index(lo)..=self.segment_index(hi)] {
                let left = lo.max(p.a.x);
                let right = hi.min(p.b.x);
                if left > right {
                    continue;
                }
                met = true;
                let dx = (-radius * p.normal.x).clamp(left - center.x, right - center.x);
                let span = sqrt((radius * radius - dx * dx).max(0.0));
                let over = p.a.y + (center.x + dx - p.a.x) * p.slope - (center.y - span);
                let pushes = Point::new(-dx / radius, span / radius);
                if over > rise && stands(pushes) {
                    (rise, normal) = (over, pushes);
                }
            }
        }
        if !met && stands(normal) {
            rise = self.height(center.x) + radius - center.y;
        }
        if rise > f64::NEG_INFINITY {
            let (bump, pushes) = under.rough(center.x, radius, flat);
            rise += bump;
            let turned = Point::new(normal.x * pushes.y + normal.y * pushes.x, normal.y * pushes.y - normal.x * pushes.x);
            if stands(turned) {
                normal = turned;
            }
        }
        (rise, normal)
    }
    pub fn raycast(&self, start: Point, end: Point) -> Option<TerrainHit> {
        // A chord wholly above the highest ground meets none. The millimetre
        // covers the tolerance the scan below gives the ends of a chord.
        if start.y > self.top + 1e-3 && end.y > self.top + 1e-3 {
            return None;
        }
        // Nor does one that stays above the highest ground of the runs of the outline it spans: from high up, most of
        // a long line.
        let (begin, stop) = self.segments(start, end);
        let low = start.y.min(end.y) - 1e-3;
        if self.runs[begin / RUN..=(stop + 1) / RUN].iter().all(|&top| low > top) {
            return None;
        }
        self.scan_segments(start, end, begin, stop)
    }
    /// Every piece of the outline a chord may meet, none turned away first: what the turning away is checked against.
    #[cfg(test)]
    fn scan(&self, start: Point, end: Point) -> Option<TerrainHit> {
        let (begin, stop) = self.segments(start, end);
        self.scan_segments(start, end, begin, stop)
    }
    /// The pieces of the outline a chord from `start` to `end` may meet: the first and the last.
    fn segments(&self, start: Point, end: Point) -> (usize, usize) {
        (self.segment_index(start.x.min(end.x)).saturating_sub(1), self.segment_index(start.x.max(end.x)))
    }
    fn scan_segments(&self, start: Point, end: Point, begin: usize, stop: usize) -> Option<TerrainHit> {
        let dx = end.x - start.x;
        let dy = end.y - start.y;
        if start.y < self.height(start.x) - 1e-6 {
            let s = self.surface(start.x);
            return Some(TerrainHit {
                enter: 0.0,
                point: s.point,
                normal: s.normal,
                surface: s.surface,
            });
        }
        if self.flat {
            if dy >= 0.0 || end.y > 1e-8 {
                return None;
            }
            let t = -start.y / dy;
            if !(-1e-8..=1.0 + 1e-8).contains(&t) {
                return None;
            }
            let x = start.x + dx * t;
            return Some(TerrainHit {
                enter: t.clamp(0.0, 1.0),
                point: Point::new(x, 0.0),
                normal: Point::new(0.0, 1.0),
                surface: self.material_at(x),
            });
        }
        let low = start.x.min(end.x);
        let high = start.x.max(end.x);
        let mut first = None;
        for i in begin..=stop {
            let p = self.profiles[i];
            if p.a.x > high || p.b.x < low {
                continue;
            }
            let sx = p.b.x - p.a.x;
            let sy = p.b.y - p.a.y;
            let den = dx * sy - dy * sx;
            if den.abs() < 1e-14 {
                continue;
            }
            let t = ((p.a.x - start.x) * sy - (p.a.y - start.y) * sx) / den;
            let u = ((p.a.x - start.x) * dy - (p.a.y - start.y) * dx) / den;
            if !(-1e-8..=1.0 + 1e-8).contains(&t)
                || !(-1e-8..=1.0 + 1e-8).contains(&u)
                || first.as_ref().is_some_and(|h: &TerrainHit| t >= h.enter)
                || dx * p.normal.x + dy * p.normal.y >= 0.0
            {
                continue;
            }
            let point = start.lerp(end, t);
            first = Some(TerrainHit {
                enter: t.clamp(0.0, 1.0),
                point,
                normal: p.normal,
                surface: self.material_at(point.x),
            });
        }
        first
    }
    /// Where an outline meets the ground within `tolerance` over it: a running gear on its springs, `rough`, meets it
    /// on its bumps (`Bumps`), which may stand through the line it is drawn by, and all else on its line.
    pub fn support(
        &self,
        polygon: &[Point],
        tolerance: f64,
        edges: Option<&[(usize, usize)]>,
        rough: bool,
    ) -> Option<TerrainSupport> {
        let count = edges.map_or(polygon.len(), |e| e.len());
        if polygon.is_empty() || count == 0 {
            return None;
        }
        let under = rough
            .then(|| {
                let (lo, hi) = polygon.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), p| (lo.min(p.x), hi.max(p.x)));
                self.underfoot(lo, hi)
            })
            .filter(|under| !under.knots.is_empty());
        let reach = if under.is_some() { BUMPS_REACH } else { 0.0 };
        let mut result = TerrainSupport {
            normal: Point::ZERO,
            tangent: Point::ZERO,
            point: Point::ZERO,
            contacts: 0,
            materials: [0.0; SURFACE_KINDS],
            material_order: Vec::new(),
            min_x: f64::INFINITY,
            max_x: f64::NEG_INFINITY,
        };
        for i in 0..count {
            let (a, b) = if let Some(edges) = edges {
                let &(a, b) = edges.get(i)?;
                (*polygon.get(a)?, *polygon.get(b)?)
            } else {
                (polygon[i], polygon[(i + 1) % polygon.len()])
            };
            let samples = ((a.distance(b) / 0.2).ceil() as usize).max(1);
            for k in 0..samples {
                let point = a.lerp(b, k as f64 / samples as f64);
                let p = self.profiles[self.segment_index(point.x)];
                let y = p.a.y + (point.x - p.a.x) * p.slope;
                // Deep under the line is none of the ground it stands on; over the bumps, or through them, it is.
                let gap = (point.y - y) * p.normal.y;
                if gap < -0.08
                    || gap >= tolerance + reach
                    || under.as_ref().is_some_and(|under| gap - under.bump(point.x) * p.normal.y >= tolerance)
                {
                    continue;
                }
                let material = self.material_at(point.x);
                if result.materials[material as usize] == 0.0 {
                    result.material_order.push(material);
                }
                result.materials[material as usize] += 1.0;
                result.contacts += 1;
                result.normal.x += p.normal.x;
                result.normal.y += p.normal.y;
                result.point.x += point.x;
                result.point.y += y;
                result.min_x = result.min_x.min(point.x);
                result.max_x = result.max_x.max(point.x);
            }
        }
        if result.contacts == 0 {
            return None;
        }
        for fraction in &mut result.materials {
            *fraction /= result.contacts as f64;
        }
        let scale = hypot(result.normal.x, result.normal.y);
        result.normal.x /= scale;
        result.normal.y /= scale;
        result.tangent = Point::new(result.normal.y, -result.normal.x);
        result.point.x /= result.contacts as f64;
        result.point.y /= result.contacts as f64;
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_motion::SPRING_SLANT;
    // The bumps of the ground at a place, and a wheel seated on the ground with the bumps under its foot alone.
    fn bump(terrain: &Terrain, x: f64) -> f64 {
        terrain.underfoot(x, x).bump(x)
    }
    fn seat(terrain: &Terrain, center: Point, radius: f64, flat: [f64; 2], up: Point, least: f64) -> (f64, Point) {
        terrain.seat(center, radius, flat, up, least, &terrain.underfoot(center.x - flat[0] - radius, center.x + flat[1] + radius))
    }
    #[test]
    fn a_wheel_is_seated_on_a_slope_square_to_it_and_on_a_crest_at_its_point() {
        let (center, level, least) = (Point::new(2.0, 1.7), Point::new(0.0, 1.0), SPRING_SLANT);
        for slope in [-3.0, -0.4, 0.0, 0.75, 3.0] {
            let terrain = Terrain::from_value(&json!({"id":"flat","points":[
                {"x":-20,"y":1.1-20.0*slope},{"x":20,"y":1.1+20.0*slope}]})).unwrap();
            let steep = sqrt(1.0 + slope * slope);
            // Its hull stands along the slope.
            let (rise, normal) = seat(&terrain, center, 0.4, [0.0; 2], Point::new(-slope / steep, 1.0 / steep), least);
            assert!((rise - (slope * center.x + 1.1 - center.y + 0.4 * steep)).abs() < 1e-12);
            assert!((normal.x + slope / steep).abs() < 1e-12 && (normal.y - 1.0 / steep).abs() < 1e-12);
        }
        // Over a crest the rim meets its point, and the ground pushes from there to the axle.
        let crest = Terrain::from_value(&json!({"id":"flat","points":[{"x":-2,"y":0},{"x":0,"y":0.8},{"x":2,"y":0}]})).unwrap();
        let (rise, normal) = seat(&crest, Point::new(0.0, 1.0), 0.7, [0.0; 2], level, least);
        assert!((rise - 0.5).abs() < 1e-12 && normal.x.abs() < 1e-12 && (normal.y - 1.0).abs() < 1e-12);
        let (rise, normal) = seat(&crest, Point::new(0.14, 1.2), 0.5, [0.0; 2], level, least);
        assert!((rise - 0.08).abs() < 1e-12 && (normal.x - 0.28).abs() < 1e-12 && (normal.y - 0.96).abs() < 1e-12);
        // Off the ground the rise is how far it hangs over it, below nothing.
        let (rise, normal) = seat(&Terrain::new("flat").unwrap(), Point::new(12.0, 3.0), 0.4, [0.0; 2], level, least);
        assert!((rise + 2.6).abs() < 1e-12 && normal == level);
    }
    #[test]
    fn a_wheel_against_a_step_stands_on_the_ground_under_it_and_leaves_the_edge_to_its_rim() {
        // A step half a metre high, its face rising over 2 cm, and a wheel 0.4 m in radius against its edge.
        let step = Terrain::from_value(&json!({"id":"flat","points":[
            {"x":-5,"y":0.5},{"x":0,"y":0.5},{"x":0.02,"y":0},{"x":5,"y":0}]})).unwrap();
        let (center, least) = (Point::new(0.35, 0.45), SPRING_SLANT);
        let corner = Point::new(0.875, sqrt(0.0375) / 0.4);
        // The edge would push the wheel of a level hull back near twice as hard as it bears it up: it
        // stands on the ground under it, 5 cm below its rim.
        let (rise, normal) = seat(&step, center, 0.4, [0.0; 2], Point::new(0.0, 1.0), least);
        assert!((rise + 0.05).abs() < 1e-12 && normal == Point::new(0.0, 1.0));
        // Its hull reared up towards the step, the edge is ground the wheel stands on.
        let (rise, normal) = seat(&step, center, 0.4, [0.0; 2], Point::new(0.6, 0.8), least);
        assert!((rise - (0.05 + sqrt(0.0375))).abs() < 1e-12);
        assert!((normal.x - corner.x).abs() < 1e-12 && (normal.y - corner.y).abs() < 1e-12);
        // Nor does a hull lying on its side stand on level ground.
        let (rise, _) = seat(&Terrain::new("flat").unwrap(), Point::new(12.0, 0.3), 0.4, [0.0; 2], Point::new(1.0, 0.0), least);
        assert_eq!(rise, f64::NEG_INFINITY);
    }
    #[test]
    fn a_road_is_the_ground_where_it_is_laid_and_leaves_the_relief_as_it_was() {
        let mut t = Terrain::landscape("rural-ridges", 6173, 1600.0, 12.0).unwrap();
        let heights: Vec<f64> = (0..64).map(|i| t.height(-300.0 + i as f64 * 9.7)).collect();
        let natural = t.material_at(50.0);
        t.set_roads(&json!([{"x0":-20,"x1":10,"kind":"asphalt"},{"x0":10,"x1":40,"kind":"graded"}])).unwrap();
        assert_eq!((t.material_at(-20.0), t.material_at(9.99), t.material_at(10.0), t.material_at(39.99)),
            (SurfaceKind::Asphalt, SurfaceKind::Asphalt, SurfaceKind::Graded, SurfaceKind::Graded));
        assert_eq!(t.material_at(50.0), natural);
        assert_eq!(heights, (0..64).map(|i| t.height(-300.0 + i as f64 * 9.7)).collect::<Vec<_>>());
        let y = t.height(0.0);
        assert_eq!(t.raycast(Point::new(0.0, y + 5.0), Point::new(0.0, y - 1.0)).unwrap().surface, SurfaceKind::Asphalt);
        let support = t.support(&[Point::new(-1.0, t.height(-1.0) + 0.01), Point::new(1.0, t.height(1.0) + 0.01)], 0.055, None, false).unwrap();
        assert_eq!(support.materials[SurfaceKind::Asphalt as usize], 1.0);
        // Roads out of order, overlapping, empty or of what is no road are refused, and leave those laid.
        for refused in [json!([{"x0":20,"x1":30,"kind":"graded"},{"x0":0,"x1":10,"kind":"graded"}]),
            json!([{"x0":0,"x1":10,"kind":"graded"},{"x0":5,"x1":20,"kind":"asphalt"}]), json!([{"x0":3,"x1":3,"kind":"graded"}]),
            json!([{"x0":0,"x1":10,"kind":"concrete"}]), json!([{"x0":0,"kind":"graded"}]), json!({"x0":0,"x1":1})] {
            assert!(t.set_roads(&refused).is_err(), "{refused}");
            assert_eq!(t.roads.len(), 2);
        }
        let laid = Terrain::from_value(&json!({"id":"flat","roads":[{"x0":-5,"x1":5,"kind":"graded"}]})).unwrap();
        assert_eq!((laid.material_at(0.0), laid.material_at(6.0)), (SurfaceKind::Graded, SurfaceKind::Concrete));
        assert_eq!(laid.raycast(Point::new(0.0, 2.0), Point::new(0.0, -1.0)).unwrap().surface, SurfaceKind::Graded);
    }
    #[test]
    fn a_road_grips_and_rolls_as_its_kind_does() {
        // Asphalt rolls as concrete does; a graded road as firmly as the earth it was graded from does under a track,
        // and more freely under a tyre, which sank into the loose earth before.
        for track in [false, true] {
            assert_eq!(SurfaceKind::Asphalt.rolling(track), SurfaceKind::Concrete.rolling(track));
            assert!(SurfaceKind::Asphalt.rolling(track) < SurfaceKind::Graded.rolling(track));
        }
        assert!(SurfaceKind::Asphalt.grip(false) > SurfaceKind::Graded.grip(false));
        assert!(SurfaceKind::Graded.rolling(false) < SurfaceKind::Soil.rolling(false));
        assert_eq!(SurfaceKind::Graded.rolling(true), SurfaceKind::Soil.rolling(true));
    }
    // Ground of one kind from -1000 to 1000, concrete on either side.
    fn of_ground(surface: SurfaceKind, seed: u32) -> Terrain {
        let mut terrain = Terrain::from_value(&json!({"id":"flat","points":[{"x":-1600,"y":0},{"x":1600,"y":0}],
            "sectors":[{"start":-1600,"end":-1000,"surface":"concrete"},{"start":-1000,"end":1000,"surface":surface.name()},
            {"start":1000,"end":1600,"surface":"concrete"}]})).unwrap();
        terrain.seed = seed;
        terrain
    }
    #[test]
    fn the_bumps_of_a_ground_stand_as_high_as_it_is_rough_and_leave_its_line_where_it_is() {
        // How high they stand over and under the line at the most, how far apart the crests are, and their mean.
        let measure = |surface: SurfaceKind| {
            let terrain = of_ground(surface, 6173);
            let at: Vec<f64> = (0..200_000).map(|i| bump(&terrain, -990.0 + i as f64 * 0.0099)).collect();
            let crests = at.windows(3).filter(|w| w[1] > w[0] && w[1] >= w[2] && w[1] > 0.0).count();
            (at.iter().cloned().fold(f64::MIN, f64::max), at.iter().cloned().fold(f64::MAX, f64::min), 1980.0 / crests as f64,
                at.iter().sum::<f64>() / at.len() as f64)
        };
        let (soil, gravel, sand, mud, graded, rock) = (measure(SurfaceKind::Soil), measure(SurfaceKind::Gravel), measure(SurfaceKind::Sand),
            measure(SurfaceKind::Mud), measure(SurfaceKind::Graded), measure(SurfaceKind::Rock));
        // Waves about the line: a crest some 5 cm over the trough before it on soil, every 1.5 to 4 m; 3 cm and short on gravel;
        // 5 cm and long on sand; 10 cm on mud; a centimetre on a graded road.
        for ((high, low, apart, mean), (most, from, to)) in [(soil, (0.035, 1.5, 4.0)), (gravel, (0.0175, 0.3, 1.0)), (sand, (0.03, 4.0, 7.0)),
            (mud, (0.065, 1.0, 2.5)), (graded, (0.0075, 1.5, 4.0))] {
            assert!(high <= most + 1e-12 && low >= -most - 1e-12 && high > most * 0.8 && low < -most * 0.8, "{high} {low}");
            assert!(apart > from && apart < to && mean.abs() < most * 0.05, "{apart} {mean}");
        }
        // Rock is strewn with stones 8 to 15 cm high, some six metres apart, on the line between them.
        assert!(rock.0 <= 0.15 && rock.0 > 0.14 && rock.1 == 0.0 && rock.2 > 4.0 && rock.2 < 9.0, "{rock:?}");
        // Concrete and asphalt have none, nor has the line of any ground moved.
        let mut paved = of_ground(SurfaceKind::Rock, 6173);
        let heights: Vec<f64> = (0..64).map(|i| paved.height(-300.0 + i as f64 * 9.7)).collect();
        paved.set_roads(&json!([{"x0":-50,"x1":50,"kind":"asphalt"}])).unwrap();
        assert!((0..1000).all(|i| bump(&paved, -50.0 + i as f64 * 0.1) == 0.0 && bump(&paved, -1500.0 + i as f64 * 0.4) == 0.0));
        assert_eq!(heights, (0..64).map(|i| paved.height(-300.0 + i as f64 * 9.7)).collect::<Vec<_>>());
        // Where one ground meets another they start level with its line, and they are the field's: another seed lays others.
        let soil = of_ground(SurfaceKind::Soil, 6173);
        assert!([-1000.0, 1000.0].iter().all(|&x| bump(&soil, x) == 0.0 && bump(&soil, x - 1e-6).abs() < 1e-5 && bump(&soil, x + 1e-6).abs() < 1e-5));
        let other = of_ground(SurfaceKind::Soil, 6174);
        assert!((0..100).any(|i| (bump(&other, i as f64) - bump(&soil, i as f64)).abs() > 0.01));
        assert!((0..100).all(|i| bump(&of_ground(SurfaceKind::Soil, 6173), i as f64 * 1.37) == bump(&soil, i as f64 * 1.37)));
    }
    #[test]
    fn read_as_narrow_as_under_a_tyre_the_bumps_by_either_end_of_a_stretch_are_those_of_the_whole_ground() {
        for surface in [SurfaceKind::Soil, SurfaceKind::Sand, SurfaceKind::Gravel, SurfaceKind::Rock, SurfaceKind::Mud] {
            let mut terrain = of_ground(surface, 6173);
            terrain.set_roads(&json!([{"x0":-200.3,"x1":-150.0,"kind":"graded"},{"x0":17.77,"x1":60.1,"kind":"asphalt"}])).unwrap();
            // About every end of a stretch of one ground, every centimetre for three metres either side: five centimetres to
            // either side of a place, as twenty metres about it.
            for end in [-1000.0, -200.3, -150.0, 17.77, 60.1, 1000.0] {
                for i in -300..=300 {
                    let x = end + i as f64 / 100.0;
                    let (narrow, whole) = (terrain.underfoot(x - 0.05, x + 0.05).bump(x), terrain.underfoot(x - 10.0, x + 10.0).bump(x));
                    assert!((narrow - whole).abs() < 1e-12, "{surface:?} {x}: {narrow} against {whole}");
                }
            }
        }
    }
    #[test]
    fn a_large_wheel_rolls_over_short_bumps_that_a_small_one_drops_into_and_a_belt_over_more() {
        // How steeply a foot goes up and down along a stretch of ground, the mean of the square of it: what a damper
        // pressed by it at a speed takes of the vehicle goes as that. And how far the ground turns its push at the most.
        let jolt = |ground: SurfaceKind, radius: f64, flat: [f64; 2]| {
            let terrain = of_ground(ground, 6173);
            let (mut steep, mut tilt, mut last) = (0.0, 0.0_f64, None);
            for i in 0..20_000 {
                let x = -500.0 + i as f64 * 0.05;
                let (rise, normal) = seat(&terrain, Point::new(x, radius), radius, flat, Point::new(0.0, 1.0), 0.5);
                steep += last.map_or(0.0, |last: f64| (rise - last) * (rise - last) / 0.05);
                (tilt, last) = (tilt.max(normal.x.abs()), Some(rise));
            }
            (steep / 1000.0, tilt)
        };
        // A tyre twice as large, on a footprint twice as long, and a road wheel on its belt or alone. The short bumps of
        // gravel a large tyre and a belt roll over; on the longer ones of the rest they still go easier.
        for ground in [SurfaceKind::Gravel, SurfaceKind::Rock, SurfaceKind::Mud, SurfaceKind::Soil, SurfaceKind::Sand] {
            let (small, large) = (jolt(ground, 0.3, [0.09; 2]), jolt(ground, 0.6, [0.18; 2]));
            let (road, belt) = (jolt(ground, 0.28, [0.0; 2]), jolt(ground, 0.28, [0.28; 2]));
            assert!(large.0 < small.0 && belt.0 < road.0 && large.1 <= small.1 && belt.1 <= road.1, "{ground:?}: {small:?} {large:?} {road:?} {belt:?}");
            if ground == SurfaceKind::Gravel {
                assert!(large.0 < small.0 / 4.0 && belt.0 < road.0 / 4.0 && large.1 < small.1 * 0.7, "{small:?} {large:?} {road:?} {belt:?}");
            }
        }
        // On its line, off the bumps, a wheel stands as it did: the rise of a wheel over concrete is the gap under it.
        let gravel = of_ground(SurfaceKind::Gravel, 6173);
        let (rise, normal) = seat(&gravel, Point::new(1200.0, 0.5), 0.4, [0.3; 2], Point::new(0.0, 1.0), 0.5);
        assert!((rise + 0.1).abs() < 1e-12 && normal == Point::new(0.0, 1.0));
        // A foot on its springs meets the ground on its bumps, even standing through them, and what else meets the
        // ground on its line.
        let x = (0..1000).map(|i| -100.0 + i as f64 * 0.37).find(|&x| bump(&gravel, x) > 0.012).unwrap();
        let foot = |over: f64| [Point::new(x - 0.01, bump(&gravel, x) + over), Point::new(x + 0.01, bump(&gravel, x) + over)];
        assert!(gravel.support(&foot(0.005), 0.01, None, true).is_some() && gravel.support(&foot(0.005), 0.01, None, false).is_none());
        assert!(gravel.support(&foot(-0.012), 0.01, None, true).is_some() && gravel.support(&foot(0.011), 0.01, None, true).is_none());
    }
    #[test]
    fn ridge_blocks_lower_terrain() {
        let t = Terrain::from_value(&json!({"id":"hills","points":[{"x":-100,"y":0},{"x":20,"y":0},{"x":28,"y":1.8},
            {"x":36,"y":0},{"x":100,"y":0}]})).unwrap();
        assert!(
            t.raycast(Point::new(16.0, 1.0), Point::new(40.0, 1.0))
                .is_some()
        );
    }
    #[test]
    fn a_chord_above_the_highest_ground_is_turned_away_as_the_scan_would() {
        for t in [Terrain::new("flat").unwrap(), Terrain::landscape("rural-ridges", 6173, 1600.0, 12.0).unwrap()] {
            assert_eq!(t.top, t.points.iter().map(|p| p.y).fold(f64::NEG_INFINITY, f64::max));
            let mut rng = crate::game_projectiles::Random::new(0x51ab);
            let (mut above, mut struck) = (0, 0);
            for i in 0..4000 {
                // Chords around the top of the ground: over it, across it, grazing it.
                let x = t.min_x + rng.next() * (t.max_x - t.min_x);
                let start = Point::new(x, t.top + (rng.next() - 0.4) * if i % 3 == 0 { 0.004 } else { 30.0 });
                let end = Point::new(x + (rng.next() - 0.5) * 60.0, t.top + (rng.next() - 0.4) * if i % 3 == 1 { 0.004 } else { 30.0 });
                let (quick, full) = (t.raycast(start, end), t.scan(start, end));
                assert_eq!(quick.map(|h| (h.enter.to_bits(), h.point.x.to_bits(), h.point.y.to_bits())),
                    full.map(|h| (h.enter.to_bits(), h.point.x.to_bits(), h.point.y.to_bits())), "{start:?} -> {end:?}");
                above += usize::from(start.y > t.top + 1e-3 && end.y > t.top + 1e-3);
                struck += usize::from(full.is_some());
            }
            assert!(above > 400 && struck > 400, "the chords tried both sides of the rule: {above} above, {struck} struck");
        }
    }
    #[test]
    fn a_chord_above_the_highest_ground_of_the_runs_it_spans_is_turned_away_as_the_scan_would() {
        let t = Terrain::landscape("highlands", 6173, 24000.0, 0.0).unwrap();
        assert_eq!(t.runs.len(), t.points.len().div_ceil(RUN));
        let mut rng = crate::game_projectiles::Random::new(0x7a1e);
        let (mut turned, mut struck) = (0, 0);
        for _ in 0..6000 {
            // Chords from a few metres to kilometres long, from over the ground under them and from under it, going up
            // and going down.
            let x = t.min_x + rng.next() * (t.max_x - t.min_x);
            let length = 4.0 * 1000f64.powf(rng.next());
            let start = Point::new(x, t.height(x) + (rng.next() - 0.2) * 300.0);
            let end = Point::new(x + (rng.next() - 0.5) * 2.0 * length, start.y + (rng.next() - 0.6) * length);
            let (quick, full) = (t.raycast(start, end), t.scan(start, end));
            assert_eq!(quick.map(|h| (h.enter.to_bits(), h.point.x.to_bits(), h.point.y.to_bits())),
                full.map(|h| (h.enter.to_bits(), h.point.x.to_bits(), h.point.y.to_bits())), "{start:?} -> {end:?}");
            let (begin, stop) = t.segments(start, end);
            turned += usize::from(t.runs[begin / RUN..=(stop + 1) / RUN].iter().all(|&top| start.y.min(end.y) - 1e-3 > top));
            struck += usize::from(full.is_some());
        }
        assert!(turned > 500 && struck > 500, "the chords tried both sides of the rule: {turned} turned away, {struck} struck");
    }
    #[test]
    fn unsupported_gear_does_not_grip() {
        let t = Terrain::new("flat").unwrap();
        assert!(
            t.support(&[Point::new(0.0, 2.0), Point::new(1.0, 2.0)], 0.055, None, false)
                .is_none()
        );
        let support = t
            .support(&[Point::new(0.0, 0.01), Point::new(1.0, 0.01)], 0.055, None, false)
            .unwrap();
        assert_eq!(support.materials[SurfaceKind::Concrete as usize], 1.0);
        assert_eq!(support.normal, Point::new(0.0, 1.0));
    }
    #[test]
    fn seeded_landscapes_match_every_reference_contour_sample_and_material_interval() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/landscape-parity.json"
        ))
        .unwrap();
        let fold = |hash: u32, word: u32| (hash ^ word).wrapping_mul(16777619);
        for row in fixture["cases"].as_array().unwrap() {
            let terrain = Terrain::from_value(row).unwrap();
            let mut contour = 2166136261u32;
            let mut regions = 2166136261u32;
            for point in &terrain.points {
                contour = fold(
                    fold(contour, (point.x * 2.0) as i32 as u32),
                    (point.y as f32).to_bits(),
                );
            }
            for sector in &terrain.sectors {
                regions = fold(
                    fold(
                        fold(regions, (sector.start * 2.0) as i32 as u32),
                        (sector.end * 2.0) as i32 as u32,
                    ),
                    sector.surface as u32,
                );
            }
            assert_eq!(
                contour as u64,
                row["contour"].as_u64().unwrap(),
                "contour: {row}"
            );
            assert_eq!(
                regions as u64,
                row["regions"].as_u64().unwrap(),
                "materials: {row}"
            );
            assert_eq!(terrain.seed as u64, row["seed"].as_u64().unwrap());
            assert_eq!(terrain.length, row["length"].as_f64().unwrap());
            assert_eq!(terrain.center, row["center"].as_f64().unwrap());
            let spacing = if terrain.length <= 4096.0 { 1 } else if terrain.length <= 8192.0 { 2 } else { 4 };
            assert_eq!(terrain.points.len(), (terrain.length as usize).div_ceil(spacing) + 3);
            for pair in terrain.points.windows(2) {
                let limit = if matches!(row["id"].as_str().unwrap(), "highlands" | "plateau" | "world") { 0.57735 } else { 0.35 };
                assert!(((pair[1].y - pair[0].y) / (pair[1].x - pair[0].x)).abs() < limit);
            }
            for x in [
                terrain.min_x - 0.01,
                terrain.min_x,
                terrain.max_x,
                terrain.max_x + 0.01,
            ] {
                assert_eq!(terrain.height(x), terrain.surface(x).point.y);
            }
        }
    }
    #[test]
    fn seeded_landscape_crests_occlude_sensors_and_ground_queries_follow_the_actual_surface() {
        for id in ["wet-valley", "arid-basin", "rural-ridges"] {
            let terrain = Terrain::landscape(id, 6173, 1600.0, 12.0).unwrap();
            let hidden = (80..terrain.points.len() - 200).step_by(8).any(|i| {
                let a = terrain.points[i];
                let b = terrain.points[i + 160];
                terrain
                    .raycast(Point::new(a.x, a.y + 1.3), Point::new(b.x, b.y + 0.1))
                    .is_some_and(|hit| hit.enter > 0.01 && hit.enter < 0.99)
            });
            assert!(hidden, "{id} must offer usable terrain occlusion");
            for x in [terrain.min_x + 70.3, terrain.center, terrain.max_x - 70.3] {
                let y = terrain.height(x);
                let hit = terrain
                    .raycast(Point::new(x, y + 10.0), Point::new(x, y - 2.0))
                    .unwrap();
                assert!((hit.point.y - y).abs() < 1e-10);
                assert_eq!(hit.surface, terrain.material_at(x));
                let support = terrain
                    .support(
                        &[
                            Point::new(x, y + 0.01),
                            Point::new(x + 0.1, terrain.height(x + 0.1) + 0.01),
                        ],
                        0.055,
                        None,
                        false,
                    )
                    .unwrap();
                assert!(support.normal.y > 0.94);
                assert!(support.materials[hit.surface as usize] > 0.0);
            }
            let moved = Terrain::landscape(id, 6173, 1600.0, -217.5).unwrap();
            for (a, b) in terrain.points.iter().zip(&moved.points) {
                assert_eq!(a.y, b.y);
                assert_eq!(a.x - b.x, 229.5);
            }
        }
    }
    #[test]
    fn landscape_import_preserves_custom_polylines_and_rejects_excessive_maps() {
        let base = Terrain::landscape("wet-valley", 0, 1000.0, -217.5).unwrap();
        let imported = Terrain::from_value(&json!({"id":"wet-valley","seed":0,"length":1000,"center":-217.5,
            "points":base.points.iter().map(|p|json!({"x":p.x,"y":p.y})).collect::<Vec<_>>(),
            "sectors":base.sectors.iter().map(|s|json!({"start":s.start,"end":s.end,"surface":s.surface.name()})).collect::<Vec<_>>()})).unwrap();
        assert_eq!(base.points, imported.points);
        assert_eq!(imported.seed, 0);
        assert_eq!(imported.length, 1000.0);
        assert_eq!(imported.center, -217.5);
        for spec in [
            json!({"id":"wet-valley","length":999}),
            json!({"id":"arid-basin","length":512001}),
            json!({"id":"rural-ridges","seed":-1}),
            json!({"id":"wet-valley","seed":4294967296u64}),
            json!({"id":"wet-valley","length":"1000"}),
            json!({"id":"wet-valley","center":"0"}),
            json!({"id":"wet-valley","seed":0.5}),
        ] {
            assert!(Terrain::from_value(&spec).is_err());
        }
        assert!(Terrain::landscape("wet-valley", 0, 1600.0, f64::INFINITY).is_err());
    }

    #[test]
    #[ignore = "generation timing; run in release mode"]
    fn benchmark_seeded_terrain_generation() {
        use std::time::Instant;
        for id in LANDSCAPE_IDS {
            for length in [1600.0, 8000.0, 16000.0] {
                let mut times = Vec::with_capacity(120);
                for seed in 0..130 {
                    let start = Instant::now();
                    let terrain = Terrain::landscape(id, seed, length, 12.0).unwrap();
                    std::hint::black_box(&terrain);
                    if seed >= 10 { times.push(start.elapsed().as_secs_f64() * 1000.0); }
                }
                times.sort_by(|a, b| a.total_cmp(b));
                eprintln!("terrain-generation {id} {length:.0}m mean={:.3}ms p95={:.3}ms", times.iter().sum::<f64>() / times.len() as f64, times[times.len() * 95 / 100]);
            }
        }
    }
}
