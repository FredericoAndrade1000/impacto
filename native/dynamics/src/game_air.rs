//! What the air holds a construction back by, for the square of its speed: what it shows the air on each of its sides,
//! read from its plates and its pieces as it was built, level (`HullAir::read`). The air goes through where nothing is,
//! and meets each thing that is there by its own width across the body and the drag of its shape. How hard that holds a
//! vehicle back the way it moves is `Powertrain::air` (game_motion.rs).
use crate::game_damage::Module;
use crate::game_geometry::{ComponentKind, Point, Pose, component_polygon, cos, number, sin};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The drag coefficient of what meets the air square on: a plate that stands across it, and a box met on its face, 1.05,
/// that of a cube face on (S. F. Hoerner, Fluid-Dynamic Drag, 1965, ch. 3).
pub const BLUNT: f64 = 1.05;
/// That of a plate that lies back from the air, which lets it by: from `BLUNT` for one that stands across it down to this
/// for one it runs along, by the square of the sine of the angle between them.
const LYING: f64 = 0.6;
/// That of a wheel, a cylinder lying across the body, met across its axle from whichever side the air comes in the
/// field: 0.6, between a short cylinder across the air, 0.63 at one diameter long (Hoerner, ch. 3, after Wieselsberger),
/// and a wheel that turns on the ground, 0.58 (Fackrell and Harvey, 1975). A track is met so at its ends, rounded over
/// its idler and its sprocket, and as a box over and under its run (`BLUNT`).
const WHEEL: f64 = 0.6;
/// Those of a thruster, a cylinder some two diameters long about the way it pushes, met across it and along it: 0.68, a
/// cylinder two diameters long across the air (Hoerner, ch. 3, after Wieselsberger), and 0.85, one along it (Hoerner,
/// ch. 3). Met at a slant, between the two by the square of the cosine of the slant.
const THRUSTER: (f64, f64) = (0.68, 0.85);
/// The thinnest the air is read in across what meets it, as a share of all it spans: between the ends of what is there,
/// each slice is read where it is thickest at its middle, and one that would be thicker than this is cut into slices this
/// thin, so that two things that cross over one another in it are read in the order they stand at each.
const SLICES: f64 = 64.0;
/// A piece that stands flush with a plate where the air meets them, as one set on it or in a port through it does, is
/// behind it: a plate is read as standing this much, in metres, ahead of where it reaches — far more than rounding moves
/// either by anywhere in a field, far less than any plate is thick.
const FLUSH: f64 = 1e-6;

/// What a construction shows the air on each of its sides, read as it was built, level: on each side, the drag
/// coefficient by the area of all the air meets there, summed (Cd·A, in m²). `ahead` the way it drives and `astern` the
/// other way, `over` it as it climbs and `under` it as it falls.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct HullAir {
    pub ahead: f64,
    pub astern: f64,
    pub over: f64,
    pub under: f64,
}
impl Default for HullAir {
    /// What is told of a construction with nothing to read: a hull 2 m high, 5.04 m long and 2.2 m wide, of the shape
    /// of an ordinary vehicle (0.85) ahead and astern, and a box (`BLUNT`) over and under.
    fn default() -> Self {
        let (ahead, across) = (0.85 * 2.0 * 2.2, BLUNT * 5.04 * 2.2);
        Self { ahead, astern: ahead, over: across, under: across }
    }
}
/// What the shape of a thing makes of the air that meets it, as its drag coefficient.
#[derive(Clone, Copy)]
enum Shape {
    /// A plate, from the one end of it to the other.
    Plate(Point),
    Box,
    Wheel,
    /// A track, along its run.
    Track(Point),
    /// A thruster, along the way it pushes.
    Thruster(Point),
}
impl Shape {
    /// Its drag coefficient met by the air coming along `toward`.
    fn drag(self, toward: Point) -> f64 {
        let along = |axis: Point| axis.dot(toward).powi(2);
        match self {
            Self::Plate(axis) => BLUNT - (BLUNT - LYING) * along(axis),
            Self::Box => BLUNT,
            Self::Wheel => WHEEL,
            Self::Track(axis) => WHEEL * along(axis) + BLUNT * (1.0 - along(axis)),
            Self::Thruster(axis) => THRUSTER.1 * along(axis) + THRUSTER.0 * (1.0 - along(axis)),
        }
    }
}
/// A piece as the air meets it: what it is, where it stands, and how long, how high and how deep across the body it is.
#[derive(Clone, Copy)]
pub struct Piece {
    pub kind: ComponentKind,
    pub pose: Pose,
    pub size: (f64, f64, f64),
}
impl Piece {
    /// A piece of a construction in the field, where its binding holds it: a gear where it was built, not on its springs.
    pub fn of(module: &Module) -> Self {
        Self { kind: module.kind, pose: module.pose, size: (module.width, module.height, module.volume / (module.width * module.height)) }
    }
    /// A piece of a compiled construction, as the Oficina tells it; none of a kind there is not.
    pub fn from_value(value: &Value) -> Option<Self> {
        let kind = ComponentKind::from_name(value["kind"].as_str()?).ok()?;
        Some(Self { kind, pose: Pose::from_value(value), size: Module::extent(kind, value) })
    }
}
/// One thing the air meets: its outline as it was built, level — the two ends of a plate, or the polygon of a piece —,
/// how wide it stands across the body, and its shape.
struct Seen {
    outline: Vec<Point>,
    width: f64,
    shape: Shape,
}
impl Seen {
    /// How far its outline reaches the way `toward` points where it crosses the line `across` · p = `at`, the
    /// foremost of it there; nothing where it does not cross it.
    fn reach(&self, toward: Point, across: Point, at: f64) -> Option<f64> {
        let n = self.outline.len();
        let edges = if n == 2 { 1 } else { n };
        (0..edges)
            .filter_map(|i| {
                let (a, b) = (self.outline[i], self.outline[(i + 1) % n]);
                let (sa, sb) = (a.dot(across), b.dot(across));
                if (sa - at) * (sb - at) > 0.0 || sa == sb {
                    return None;
                }
                let t = (at - sa) / (sb - sa);
                Some(a.dot(toward) + t * (b.dot(toward) - a.dot(toward)))
            })
            .reduce(f64::max)
    }
}
impl HullAir {
    /// What a construction shows the air, from its `plates`, as a field or the Oficina tells them, and its `pieces`, those
    /// of it alone: a plate that has come off it is not on it. `facing` is the way it drives: to the left (-1), as a
    /// design is drawn, or to the right (1), when it was admitted mirrored. `tilt` is the angle its vehicle stands at: it
    /// is read as it was built, level, whatever the ground under it, and a field resumed reads it as it was.
    ///
    /// Each side is read in slices across the air that comes at it: ahead and astern at heights over the hull, over and
    /// under it along its length. In each slice the air meets first what stands foremost there, and then, behind it, only
    /// as much of what is wider than what is ahead of it: a piece behind a plate in a slice, inside the hull or behind a
    /// fairing, is met nowhere, and a plate behind a piece narrower than it is met where the piece leaves it to the air.
    /// What it shows there is so the widest of what is there, each share of it by the shape of what meets the air first
    /// over it. A slice where nothing is shows the air nothing: it goes through. A plate is as wide as the body, unless it
    /// tells it is narrower (`dragWidthM`: the rails of a chassis and the tubes of skids, game_chassis.rs `drag_width`),
    /// and is met by the shape of a plate — square on, blunt (`BLUNT`); lying back from the air, less, down to `LYING`.
    /// A piece is as wide as it is deep, and met by the shape of what it is: a wheel, a track, a thruster, or, anything
    /// else, a box. Of a gun, its receiver; neither the tube of a gun nor the column a sensor stands on is read, nor how
    /// thick a plate is.
    pub fn read(plates: &Value, pieces: impl IntoIterator<Item = Piece>, facing: f64, tilt: f64) -> Self {
        let (s, c) = (sin(-tilt), cos(-tilt));
        let level = |p: Point| Point::new(c * p.x - s * p.y, s * p.x + c * p.y);
        let mut seen = Vec::new();
        for plate in plates.as_array().into_iter().flatten().filter(|plate| plate["attached"] != false) {
            let p = plate.get("definition").unwrap_or(plate);
            let (axis, half) = (Point::new(cos(number(p, "angle", 0.0)), sin(number(p, "angle", 0.0))), number(p, "length", 1.0) / 2.0);
            let (x, y) = (number(p, "x", 0.0), number(p, "y", 0.0));
            seen.push(Seen {
                outline: vec![level(Point::new(x - axis.x * half, y - axis.y * half)), level(Point::new(x + axis.x * half, y + axis.y * half))],
                width: number(p, "dragWidthM", number(p, "widthM", 1.0)),
                shape: Shape::Plate(level(axis)),
            });
        }
        for Piece { kind, pose, size: (width, height, depth) } in pieces {
            let (ms, mc) = (sin(pose.angle), cos(pose.angle));
            seen.push(Seen {
                outline: component_polygon(kind, width, height).into_iter().map(|p| level(pose.world_point(p))).collect(),
                width: depth,
                shape: match kind {
                    ComponentKind::Wheel => Shape::Wheel,
                    ComponentKind::Track => Shape::Track(level(Point::new(mc, ms))),
                    ComponentKind::Thruster => Shape::Thruster(level(Point::new(-ms, mc))),
                    _ => Shape::Box,
                },
            });
        }
        if seen.is_empty() {
            return Self::default();
        }
        let ahead = if facing > 0.0 { 1.0 } else { -1.0 };
        Self {
            ahead: side(&seen, Point::new(ahead, 0.0)),
            astern: side(&seen, Point::new(-ahead, 0.0)),
            over: side(&seen, Point::new(0.0, 1.0)),
            under: side(&seen, Point::new(0.0, -1.0)),
        }
    }
}
/// What all that is `seen` shows the air that comes at it moving along `toward`, as Cd·A in m² (`HullAir::read`).
fn side(seen: &[Seen], toward: Point) -> f64 {
    let across = Point::new(-toward.y, toward.x);
    let spans: Vec<(f64, f64)> = seen.iter().map(|thing| {
        thing.outline.iter().map(|p| p.dot(across)).fold((f64::INFINITY, f64::NEG_INFINITY), |(lo, hi), at| (lo.min(at), hi.max(at)))
    }).collect();
    let drags: Vec<(f64, f64)> = seen.iter().map(|thing| (thing.shape.drag(toward), if matches!(thing.shape, Shape::Plate(_)) { FLUSH } else { 0.0 })).collect();
    let mut ends: Vec<f64> = spans.iter().flat_map(|&(lo, hi)| [lo, hi]).collect();
    ends.sort_by(f64::total_cmp);
    ends.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let (Some(&first), Some(&last)) = (ends.first(), ends.last()) else {
        return 0.0;
    };
    let finest = (last - first) / SLICES;
    let mut shown = 0.0;
    let mut here: Vec<(f64, f64, f64)> = Vec::new();
    for stretch in ends.windows(2) {
        let count = ((stretch[1] - stretch[0]) / finest - 1e-9).ceil().max(1.0);
        let thick = (stretch[1] - stretch[0]) / count;
        for k in 0..count as usize {
            let at = stretch[0] + (k as f64 + 0.5) * thick;
            here.clear();
            here.extend(seen.iter().zip(&spans).zip(&drags).filter(|((_, span), _)| span.0 < at && at < span.1)
                .filter_map(|((thing, _), &(drag, lead))| thing.reach(toward, across, at).map(|reach| (reach + lead, thing.width, drag))));
            here.sort_by(|a, b| b.0.total_cmp(&a.0));
            let mut covered: f64 = 0.0;
            for &(_, width, drag) in &here {
                if width > covered {
                    shown += (width - covered) * drag * thick;
                    covered = width;
                }
            }
        }
    }
    shown
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    /// The plates of a hull told by its corners in order, each 2.4 m wide.
    fn hull(corners: &[(f64, f64)]) -> Vec<Value> {
        corners.iter().enumerate().map(|(i, &(x, y))| {
            let (x2, y2) = corners[(i + 1) % corners.len()];
            json!({"x": (x + x2) / 2.0, "y": (y + y2) / 2.0, "angle": (y2 - y).atan2(x2 - x), "length": (x2 - x).hypot(y2 - y), "widthM": 2.4})
        }).collect()
    }
    fn read(plates: &[Value], pieces: &[Piece], facing: f64) -> HullAir {
        HullAir::read(&json!(plates), pieces.iter().copied(), facing, 0.0)
    }
    fn piece(kind: ComponentKind, x: f64, y: f64, angle: f64, size: (f64, f64, f64)) -> Piece {
        Piece { kind, pose: Pose { x, y, angle }, size }
    }
    fn near(a: f64, b: f64) -> bool {
        (a - b).abs() < 1e-9
    }
    fn same(a: HullAir, b: HullAir) -> bool {
        near(a.ahead, b.ahead) && near(a.astern, b.astern) && near(a.over, b.over) && near(a.under, b.under)
    }
    const THRUSTER_SIZE: (f64, f64, f64) = (0.64, 1.31, 0.64);
    const WALL: [(f64, f64); 4] = [(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (0.0, 2.0)];
    const WEDGE: [(f64, f64); 4] = [(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (4.0, 2.0)];

    #[test]
    fn a_hull_shows_the_air_its_walls_whole_its_slopes_less_and_its_gaps_nothing() {
        // A box 6 m long and 2 m high: its front wall ahead and its rear astern, its roof over it and its floor under it.
        let wall = read(&hull(&WALL), &[], -1.0);
        assert!(near(wall.ahead, BLUNT * 2.0 * 2.4) && near(wall.astern, wall.ahead), "{wall:?}");
        assert!(near(wall.over, BLUNT * 6.0 * 2.4) && near(wall.under, wall.over), "{wall:?}");
        // The wedge rises two metres in four: ahead, the square of the cosine of its slope, four fifths, is what lets the
        // air by; over it, a fifth. Astern it shows its upright back.
        let wedge = read(&hull(&WEDGE), &[], -1.0);
        assert!(near(wedge.ahead, (BLUNT - (BLUNT - LYING) * 0.8) * 2.0 * 2.4), "{wedge:?}");
        assert!(near(wedge.astern, BLUNT * 2.0 * 2.4));
        assert!(near(wedge.over, ((BLUNT - (BLUNT - LYING) * 0.2) * 4.0 + BLUNT * 2.0) * 2.4) && near(wedge.under, BLUNT * 6.0 * 2.4));
        // Mirrored, it drives the other way, its slope ahead.
        let mirrored: Vec<(f64, f64)> = WEDGE.iter().map(|&(x, y)| (30.0 - x, y)).collect();
        assert!(near(read(&hull(&mirrored), &[], 1.0).ahead, wedge.ahead));
        // A step is two walls, however far back the one above stands.
        let cab = read(&hull(&[(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (3.0, 2.0), (3.0, 1.0), (0.0, 1.0)]), &[], -1.0);
        assert!(near(cab.ahead, wall.ahead));
        // Two boxes a metre high, one over the other with a metre between them: the air goes through between them.
        let stacked = [hull(&[(0.0, 0.0), (6.0, 0.0), (6.0, 1.0), (0.0, 1.0)]), hull(&[(0.0, 2.0), (6.0, 2.0), (6.0, 3.0), (0.0, 3.0)])].concat();
        assert!(near(read(&stacked, &[], -1.0).ahead, BLUNT * 2.0 * 2.4));
        // Stood on a slope, it is read as it was built.
        for tilt in [-0.3_f64, 0.05, 0.4] {
            let (s, c) = (tilt.sin(), tilt.cos());
            let laid: Vec<(f64, f64)> = WEDGE.iter().map(|&(x, y)| (c * x - s * y + 3.0, s * x + c * y + 1.0)).collect();
            let read = HullAir::read(&json!(hull(&laid)), [], -1.0, tilt);
            assert!([(read.ahead, wedge.ahead), (read.astern, wedge.astern), (read.over, wedge.over), (read.under, wedge.under)]
                .iter().all(|&(a, b)| (a - b).abs() < 1e-6), "{tilt}: {read:?}");
        }
        // A plate that came off is not on it; one that tells it is narrower than the body shows the air that much of it.
        let mut torn = hull(&WALL);
        torn.extend(hull(&[(40.0, 10.0), (42.0, 10.0), (42.0, 12.0), (40.0, 12.0)]).into_iter().map(|mut p| { p["attached"] = json!(false); p }));
        assert!(same(read(&torn, &[], -1.0), wall));
        let mut rails = hull(&WALL);
        rails.iter_mut().for_each(|p| p["dragWidthM"] = json!(0.6));
        assert!(near(read(&rails, &[], -1.0).over, wall.over / 4.0));
        assert_eq!(HullAir::read(&json!([]), [], -1.0, 0.0), HullAir::default(), "nothing to read");
    }

    #[test]
    fn a_piece_shows_the_air_its_own_size_and_shape_where_no_plate_stands_before_it() {
        use ComponentKind::*;
        // A thruster on its own, upright: across it ahead, along it over it.
        let upright = read(&[], &[piece(Thruster, 0.0, 1.0, 0.0, THRUSTER_SIZE)], -1.0);
        assert!(near(upright.ahead, THRUSTER.0 * 1.31 * 0.64) && near(upright.astern, upright.ahead), "{upright:?}");
        assert!(near(upright.over, THRUSTER.1 * 0.64 * 0.64) && near(upright.under, upright.over), "{upright:?}");
        // Leant at 45 degrees, it is met at a slant, between the two, over all it spans.
        let leant = read(&[], &[piece(Thruster, 0.0, 1.0, std::f64::consts::FRAC_PI_4, THRUSTER_SIZE)], -1.0);
        let span = (0.64 + 1.31) * std::f64::consts::FRAC_1_SQRT_2;
        assert!(near(leant.ahead, (THRUSTER.0 + THRUSTER.1) / 2.0 * span * 0.64) && near(leant.over, leant.ahead), "{leant:?}");
        // A wheel, a box and a track by their own shapes.
        let wheel = read(&[], &[piece(Wheel, 0.0, 0.37, 0.0, (0.74, 0.74, 0.45))], -1.0);
        assert!(near(wheel.ahead, WHEEL * 0.74 * 0.45) && near(wheel.over, wheel.ahead), "{wheel:?}");
        let engine = read(&[], &[piece(Engine, 0.0, 1.0, 0.0, (1.05, 0.64, 0.65))], -1.0);
        assert!(near(engine.ahead, BLUNT * 0.64 * 0.65) && near(engine.over, BLUNT * 1.05 * 0.65), "{engine:?}");
        let track = read(&[], &[piece(Track, 0.0, 0.37, 0.0, (5.04, 0.74, 0.45))], -1.0);
        assert!(near(track.ahead, WHEEL * 0.74 * 0.45) && (track.over - BLUNT * 5.04 * 0.45).abs() < 1e-3, "{track:?}");
        // Inside a hull, a piece is behind its walls, its roof and its floor.
        let wall = read(&hull(&WALL), &[], -1.0);
        assert!(same(read(&hull(&WALL), &[piece(Engine, 3.0, 1.0, 0.0, (1.05, 0.64, 0.65))], -1.0), wall));
        // Ahead of the front wall, a thruster meets the air where it stands, and the wall what it leaves of it; behind the
        // rear wall, as the hull backs, it is met nowhere.
        let ahead = read(&hull(&WALL), &[piece(Thruster, -1.0, 1.0, 0.0, THRUSTER_SIZE)], -1.0);
        assert!(near(ahead.ahead, 1.31 * (THRUSTER.0 * 0.64 + BLUNT * (2.4 - 0.64)) + BLUNT * 2.4 * (2.0 - 1.31)), "{ahead:?}");
        assert!(near(ahead.astern, wall.astern));
        // One behind another as wide is met nowhere: two thrusters in a row show the air one ahead, and both over them.
        let row = read(&[], &[piece(Thruster, 0.0, 1.0, 0.0, THRUSTER_SIZE), piece(Thruster, 2.0, 1.0, 0.0, THRUSTER_SIZE)], -1.0);
        assert!(near(row.ahead, upright.ahead) && near(row.over, 2.0 * upright.over), "{row:?}");
        // A thruster on rails narrower than it: over it, the thruster and the rails where it does not stand; under it, the
        // rails, and the thruster as much as it is wider than them.
        let rails = json!({"x": 0.0, "y": 0.0, "angle": 0.0, "length": 4.0, "widthM": 2.4, "dragWidthM": 0.4});
        let mounted = read(&[rails], &[piece(Thruster, 0.0, 0.655, 0.0, THRUSTER_SIZE)], -1.0);
        assert!(near(mounted.over, THRUSTER.1 * 0.64 * 0.64 + BLUNT * 0.4 * (4.0 - 0.64)), "{mounted:?}");
        assert!(near(mounted.under, BLUNT * 0.4 * 4.0 + THRUSTER.1 * (0.64 - 0.4) * 0.64), "{mounted:?}");
        // A piece flush with a plate where the air meets them is behind it.
        let flush = read(&hull(&WALL), &[piece(Engine, 0.525, 1.0, 0.0, (1.05, 0.64, 0.65))], -1.0);
        assert!(near(flush.ahead, wall.ahead), "{flush:?}");
    }
}
