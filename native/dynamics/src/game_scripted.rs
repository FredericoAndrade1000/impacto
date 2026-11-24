//! The scripted adversary is a sensor client, not a privileged game controller.
//! It reads its own hardware, measured contacts and optional observed heights;
//! the solver, ammunition ledger and servo still admit every resulting command.
use serde::{Deserialize, Serialize};
use crate::game_geometry::ComponentKind;
use crate::game_damage::{Module};
use crate::game_geometry::{Bounds, Point, atan2, hypot, sin, sqrt};
#[cfg(test)]
use crate::game_geometry::cos;
use crate::game_motion::DriveState;
use crate::game_sensors::{
    Contact, ContactClassification, ContactSource, RosterContact, SensorActor, SensorModule, TerrainReading, speed_noise,
};
use crate::game_weapons::{Settings, angle_difference};
use crate::game_flight::{Drag,FlightState,ShotLaunch,Trajectory};
use crate::game_projectiles::{Ammo, Line, LineOfFire};
use serde_json::{Value, json};
use std::f64::consts::PI;

/// Only the enemy it chose last and the way it last looked persist between calls.
/// SensorMemory remains the sole owner of observations and their ageing.
#[derive(Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(Debug, PartialEq))]
pub struct PilotState {
    target: Option<String>,
    bearing: f64,
}
pub struct OwnView<'a> {
    pub actor: &'a SensorActor,
    pub drive: Option<&'a DriveState>,
    pub modules: &'a [&'a Module],
    pub readings: &'a [&'a SensorModule],
    pub catalogue: &'a Value,
    pub contacts: &'a [RosterContact],
    pub arena: Bounds,
    /// Whether the player ordered the pilot onto its one target (`contacts` holds it alone).
    pub ordered: bool,
}
/// What the side of a pilot has observed besides its contacts: the ground its optics read, whether an optic or a
/// radar of the pilot's own reaches a target, and a target as it shows from outside to a side that identifies it
/// by sight; and what the pilot knows of its own side, whether its own construction or an ally stands in a line of
/// fire of its own. There is deliberately no terrain-height or material-raycast escape hatch.
pub trait Observed {
    fn height(&mut self, x: f64) -> Option<f64>;
    fn reading(&self) -> &TerrainReading;
    fn sees(&mut self, _target: &str) -> bool {
        false
    }
    fn outside(&mut self, _target: &str) -> Vec<Aim> {
        Vec::new()
    }
    /// What an enemy is worth a round as, beside others: 1 for one whose guns fire, less for one that only sees for
    /// its side or drives.
    fn threat(&mut self, _target: &str) -> f64 {
        1.0
    }
    /// What of its own side a round of a gun of the pilot's meets on its way for `until` seconds
    /// (`game_projectiles::line_of_fire`): its own construction, which it strikes as any other and which the gun
    /// does not fire into, or an ally that would stop it and take no harm of it.
    fn in_line(&mut self, _line: &LineOfFire, _until: f64) -> Line {
        Line::Clear
    }
}
/// What a pilot may aim at on a target it identifies by sight: the pieces that show from outside — a fuel tank and a
/// load among them when they are carried out in the open — and the middle of the hull.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Part {
    Weapon,
    Sensor,
    Gear,
    Hull,
    Fuel,
    Cargo,
}
impl Part {
    pub fn name(self) -> &'static str {
        match self {
            Self::Weapon => "weapon",
            Self::Sensor => "sensor",
            Self::Gear => "gear",
            Self::Hull => "hull",
            Self::Fuel => "fuel",
            Self::Cargo => "cargo",
        }
    }
}
/// A place to aim at on a target: the part there, how far it stands from the middle of the target, whether it is a
/// gun whose barrel is already out, and what shows of the shots that struck it, or struck the face in front of it
/// for a shot from the pilot's side: holes they made and those that did not get through.
#[derive(Clone, Copy, Debug)]
pub struct Aim {
    pub part: Part,
    pub offset: Point,
    pub disabled: bool,
    pub holes: u32,
    /// The rounds stopped there, each as far from getting through as it was: a shallow dent counts whole, one nearly
    /// through hardly at all, and a ricochet half, for a face turns a round from one way and not from another.
    pub stopped: f64,
}
impl Aim {
    /// What putting a round there is worth: a gun first, then the eyes, a fuel tank out in the open, which burns, the
    /// hull, a load out in the open and the running gear. Where rounds got through is worth more of them; where they
    /// were stopped, less with each, so that a pilot whose rounds keep failing on one place turns to another.
    fn worth(&self) -> f64 {
        let part = match self.part {
            Part::Weapon if self.disabled => 0.2,
            Part::Weapon => 1.0,
            Part::Sensor => 0.9,
            Part::Fuel => 0.8,
            Part::Hull => 0.55,
            Part::Cargo => 0.5,
            Part::Gear => 0.45,
        };
        part * (1.0 + 0.3 * self.holes.min(4) as f64) / (1.0 + 0.5 * self.stopped)
    }
}
/// How near the line a round aimed at a place comes in along a mark must be to be one of the rounds aimed there.
const NEAR: f64 = 0.75;
/// The places on a target worth a round, from what of it shows outside: each piece that shows, by its part, where it
/// stands and whether it is a gun whose barrel is out, and the middle of the hull, `middle`. The marks of the shots
/// that struck it, each where it is, of what kind and how deep of the plate it went (a dent's share of it), are
/// counted for each place they are near the line to, a level line from the side of `from`: those at the place or
/// before it, on the face toward the pilot.
pub fn aims(middle: Point, from: f64, pieces: &[(Part, Point, bool)], marks: &[(Point, &str, f64)]) -> Vec<Aim> {
    let side = if from < middle.x { -1.0 } else { 1.0 };
    pieces.iter().copied().chain([(Part::Hull, middle, false)]).map(|(part, at, disabled)| {
        let struck = marks.iter().filter(|(mark, _, _)| (mark.y - at.y).abs() <= NEAR && (mark.x - at.x) * side >= -NEAR);
        let holes = struck.clone().filter(|(_, kind, _)| *kind == "hole").count() as u32;
        let stopped = struck.map(|(_, kind, strength)| match *kind {
            "dent" => (1.0 - strength).clamp(0.0, 1.0),
            "ricochet" => 0.5,
            _ => 0.0,
        }).sum();
        Aim { part, offset: Point::new(at.x - middle.x, at.y - middle.y), disabled, holes, stopped }
    }).collect()
}
pub struct Decision {
    pub action: Value,
    pub target: Option<String>,
    pub contact: Contact,
    pub diagnostics: Value,
}
impl Decision {
    pub fn to_value(self) -> Value {
        json!({"action":self.action,"targetId":self.target,"contact":self.contact.to_value(),"diagnostics":self.diagnostics})
    }
}

struct Gun<'a> {
    module: &'a Module,
    settings: Settings,
    rounds: u32,
    sensor: Option<&'a SensorModule>,
}
#[derive(Clone)]
struct Shot {
    gun: usize,
    ammo: String,
    trajectory: &'static str,
    charge: f64,
    aim: Point,
    muzzle: Point,
    velocity: Point,
    drag:Drag,
    angle: f64,
    time: f64,
    score: f64,
    dispersion: f64,
    /// Set to burst in the air where it is aimed, over the target, rather than when it strikes.
    burst: bool,
    /// When a high-explosive shell bursts if it has struck nothing: where it is aimed, for one set to burst over the
    /// target; just past the middle of the target, for one aimed at it.
    fuze: f64,
}
#[derive(Default)]
struct Path {
    blocked: bool,
    /// The pilot's own construction is the first thing in its way.
    own: bool,
    /// An ally in its way would stop the round.
    ally: bool,
    cover: bool,
    known: usize,
    samples: usize,
}
/// A target that moves may not keep its course while a round is in the air:
/// this share of the way it would cover is doubt about where it will be.
const TARGET_DRIFT: f64 = 0.08;
/// A shell the pilot sets to burst in the air bursts this share of its blast over the top of the target: near
/// enough for the blast to reach down to it, high enough to clear a crest the target stands just behind.
const BURST_RISE: f64 = 0.35;
/// What of a strike a burst over the target is worth: its blast comes from above and farther off.
const BURST_SHARE: f64 = 0.5;
/// A shell of a smaller blast than this is never set to burst: from over the target it would not reach it.
const BURST_BLAST: f64 = 1.5;
/// The step of the field, in seconds: the only one the core takes (`GameState::step`).
const FIELD_STEP: f64 = 1.0 / 60.0;
/// How high over the ground its optics read under it a muzzle stands, in metres, for its rounds to be taken past ground no
/// optic read as over ground that runs straight to the target (`check_path`): as low as an aircraft flies (squad.js
/// `FLIGHT_FLOOR`).
const ALOFT: f64 = 6.0;
/// Of the shots set to burst, this many more paths are looked at when no strike has a clear one.
const BURST_CHECKS: usize = 2;
/// How long and how tall a target is taken for: as its silhouette was seen, or no smaller than a small part of
/// one stands out. A target no optic sized, held by a radar or heard, is taken for the least a construction is.
fn extent(c: &Contact) -> Point {
    if c.width == 0.0 && c.height == 0.0 {
        Point::new(4.0, 2.0)
    } else {
        Point::new(c.width.max(2.0), c.height.max(1.0))
    }
}
fn estimate(c: &Contact, time: f64) -> Point {
    Point::new(c.x + c.vx * (c.age + time), c.y + c.vy * (c.age + time))
}
fn quality(c: &Contact) -> f64 {
    if !c.detected || c.confidence < 0.08 || c.age > 2.0 {
        0.0
    } else {
        c.confidence / (1.0 + c.uncertainty.max(0.0) * 0.12)
    }
}
fn direct_gun(family: &str) -> bool {
    matches!(family, "machinegun" | "autocannon" | "cannon")
}
/// A current, unrecognized visual silhouette supplies a box, not the pieces hidden within it. Sample its height
/// only after a real shot advances the actor's existing counter. Tiny/unsized contacts keep their middle.
fn visual_sample(c: &Contact, shots: u64) -> Option<Point> {
    if !c.visible || c.classification != ContactClassification::Estimated
        || c.channel.unwrap_or(c.source) != ContactSource::Visual || !c.height.is_finite() || c.height < 1.0 {
        return None;
    }
    match shots % 3 {
        1 => Some(Point::new(0.0, -0.2 * c.height)),
        2 => Some(Point::new(0.0, 0.2 * c.height)),
        _ => None,
    }
}
fn arcs(family: &str) -> &'static [&'static str] {
    match family {
        "mortar" => &["high", "low"],
        "howitzer" | "grenade" => &["low", "high", "direct"],
        _ => &["low", "direct"],
    }
}
fn guns<'a>(own: &OwnView<'a>) -> Result<Vec<Gun<'a>>, String> {
    own.modules
        .iter()
        .copied()
        .filter(|m| {
            m.actor == own.actor.handle
                && m.kind == ComponentKind::Weapon
                && m.usable()
                && !m.barrel_disabled
        })
        .filter_map(|m| {
            let cartridge = crate::game_variant::cartridge(&m.weapon_preset);
            let rounds = own
                .modules
                .iter()
                .copied()
                .filter(|feed| {
                    feed.actor == m.actor
                        && feed.kind == ComponentKind::Ammo
                        && feed.usable()
                        && feed.ammo_preset == cartridge
                })
                .map(|feed| feed.rounds)
                .sum::<u32>();
            (rounds > 0).then_some((m, rounds))
        })
        .map(|(m, rounds)| {
            let mut config = json!({"preset":m.weapon_preset,"platform":"vehicle"});
            if let Some(ammo) = m.weapon_ammo(own.catalogue) {
                config["ammo"] = json!(ammo);
            }
            Ok(Gun {
                module: m,
                settings: Settings::admit(own.catalogue, &config, Some(m.owner), true)?,
                rounds,
                sensor: own.readings.iter().copied().find(|s| s.handle == m.owner),
            })
        })
        .collect()
}
/// Target leading includes both linear and angular muzzle motion. No enemy
/// mechanics or hidden map data enter this measured-contact calculation.
/// `offset`: where on the target the round is aimed, from its middle.
/// `burst`: a shell set to burst in the air, aimed `BURST_RISE` of its blast
/// over the top of the target, whatever place on it a strike would be aimed at.
fn intercept(
    own: &OwnView<'_>,
    gun: &Gun<'_>,
    index: usize,
    c: &Contact,
    offset: Point,
    ammo: &str,
    trajectory: &'static str,
    charge: f64,
    burst: bool,
) -> Option<Shot> {
    let origin = Point::new(gun.module.pose.x, gun.module.pose.y);
    let s = &gun.settings;
    // Each round of a gun leaves it at its own speed and meets its own drag.
    let (muzzle_speed, drag) = s.round(own.catalogue, ammo).ok()?;
    let speed = muzzle_speed * sqrt(charge);
    let inherited_origin = own.drive.map_or(Point::ZERO, |d| d.velocity_at(origin));
    let omega = own.drive.map_or(0.0, |d| d.omega);
    let size = extent(c);
    let shift = if burst { Point::new(0.0, size.y * 0.5 + s.blast_radius * BURST_RISE) } else { offset };
    let over = |p: Point| Point::new(p.x + shift.x, p.y + shift.y);
    let present = over(estimate(c, 0.0));
    let launch=ShotLaunch {origin,speed,barrel:s.barrel,inherited:inherited_origin,omega,life:s.life,drag};
    let solved=launch.pilot_intercept(present,Point::new(c.vx,c.vy),trajectory=="high")?;
    let time=solved.time;let angle=solved.angle;
    let mount=gun.module.mount.as_ref()?;
    let relative=angle_difference(angle,gun.module.pose.angle);
    if !(mount.min..=mount.max).contains(&relative) { return None; }
    let initial=launch.initial(angle);
    let muzzle=initial.point;let velocity=initial.velocity;
    let aim = over(estimate(c, time));
    let end=solved.flight.point;
    if end.distance(aim) > 0.35_f64.max(c.height * 0.2)
        || aim.x < own.arena.min_x
        || aim.x > own.arena.max_x
    {
        return None;
    }
    // A bearing off by the spread of the gun carries the round past the target
    // across its path, measured on the arc itself: a flat shot strays by its
    // range, a shell near its longest reach by very little.
    let probe = 1e-5;
    let nudged = launch.initial(angle + probe).at(time, drag).point;
    let arrival = solved.flight.velocity;
    // A shell aimed at the target that has struck nothing by the time it is past the target's middle by half the
    // target, along its path, has missed over it: there it is still beside it. One that strikes has struck before.
    let pass = if burst {
        0.0
    } else {
        (arrival.x.abs() * size.x + arrival.y.abs() * size.y) * 0.5 / (arrival.x * arrival.x + arrival.y * arrival.y).max(1e-6)
    };
    let across = ((nudged.x - end.x) * arrival.y - (nudged.y - end.y) * arrival.x).abs()
        / hypot(arrival.x, arrival.y).max(1e-6) / probe;
    let dispersion = s.spread * PI / 180.0 * across * 0.5;
    let uncertainty = c.uncertainty.max(0.0) + dispersion + time * 0.03
        + hypot(c.vx, c.vy) * time * TARGET_DRIFT;
    // A burst reaches the target with what of its blast is left past the height it bursts at.
    let footprint = if burst {
        s.blast_radius * (1.0 - BURST_RISE)
    } else {
        hypot(size.x, size.y) * 0.55
            + if ammo == "he" {
                s.blast_radius * 0.75
            } else {
                0.0
            }
    };
    // A recent optical fix can make a short automatic salvo worthwhile even
    // when one projectile is unlikely to hit. Use measured certainty and at
    // most six available rounds from a second of fire, never hidden armour or
    // an enlarged target. Every accepted shot still checks path and servo.
    let expected = c.confidence * (footprint / (footprint + uncertainty)).powi(2);
    let automatic_opportunity = !burst && matches!(s.family.as_str(), "machinegun" | "autocannon")
        && c.visible && c.channel.unwrap_or(c.source) == ContactSource::Visual
        && c.age <= 0.35 && c.confidence >= 0.5
        && expected * (s.rate / 60.0).min(6.0).min(gun.rounds as f64) >= 0.3;
    if uncertainty > footprint * 1.5 && !automatic_opportunity {
        return None;
    }
    let alignment = angle_difference(angle, gun.module.barrel_angle).abs();
    let servo = gun
        .sensor
        .map_or(PI / 6.0, |sensor| sensor.servo_max_speed)
        .max(0.02);
    // Power and certainty, rather than hidden target armour/health, select the gun.
    let score = s.power
        * expected
        * if matches!(ammo, "ap" | "apfsds") && s.family == "cannon" {
            1.12
        } else {
            1.0
        }
        / (1.0 + time * 0.05 + alignment / servo * 0.16)
        * (0.85 + 0.15 * (gun.rounds as f64 / 10.0).min(1.0))
        * if burst { BURST_SHARE } else { 1.0 };
    Some(Shot {
        gun: index,
        ammo: ammo.into(),
        trajectory,
        charge,
        aim,
        muzzle,
        velocity,
        drag,
        angle,
        time,
        score,
        dispersion,
        burst,
        fuze: time + pass,
    })
}
#[cfg(test)]
fn flight(shot: &Shot, t: f64) -> Point {
    FlightState::new(shot.muzzle,shot.velocity).at(t,shot.drag).point
}
/// `id`: the target. Whether an optic or a radar of the pilot's own reaches it is asked only of a path that
/// crosses ground no optic of its side has read, once.
fn check_path(
    own: &OwnView<'_>,
    gun: &Gun<'_>,
    id: &str,
    target: &Contact,
    shot: &Shot,
    observed: &mut impl Observed,
) -> Path {
    let mut path = Path::default();
    let line = LineOfFire { gun: gun.module.owner, point: shot.muzzle, velocity: shot.velocity, drag: shot.drag,
        ammo: Ammo::from_name(&shot.ammo), power: gun.settings.power };
    match observed.in_line(&line, shot.time) {
        Line::Own => path.own = true,
        Line::Ally => path.ally = true,
        Line::Clear => {}
    }
    if path.own || path.ally {
        path.blocked = true;
        return path;
    }
    let count = ((shot.muzzle.distance(shot.aim) / 18.0).ceil() as usize).clamp(16, 32);
    // The reading the side holds of the target may be another's while the pilot's own optic sees it too.
    let mut current_los = (target.visible && (matches!(target.source, ContactSource::Visual | ContactSource::Radar)
        || target.source == ContactSource::Team && target.source_actor == Some(own.actor.handle)
            && matches!(target.channel, Some(ContactSource::Visual | ContactSource::Radar)))).then_some(true);
    let shared_los = target.visible && target.source == ContactSource::Team
        && matches!(
            target.channel,
            Some(ContactSource::Visual | ContactSource::Radar)
        );
    let origin = observed
        .reading()
        .origin
        .unwrap_or(Point::new(own.actor.x, own.actor.y));
    let flight=Trajectory::new(FlightState::new(shot.muzzle,shot.velocity),shot.time,shot.drag);
    // The last ground read on the way, and where the target stands on the ground when an optic of the side sees it
    // whole: ground no optic read between the two is taken to run straight from the one to the other. A gun high over
    // the ground under it, as an aircraft's, fires down past what its own optic looks along so as well: the panorama of
    // one up there reads the ground far below it out to its range, but only along its few lines (`TERRAIN_DEGREES`,
    // `HIGH_OPTIC`), and a camera an arm's length off the muzzle sees along a line its rounds never keep to.
    let mut read = None;
    let foot = (target.visible && target.classification == ContactClassification::Identified)
        .then(|| Point::new(target.x, target.y - target.height * 0.5));
    let mut aloft = None;
    for i in 1..=count {
        let t = shot.time * i as f64 / count as f64;
        let p = flight.sample(t).point;
        path.samples += 1;
        if let Some(height) = observed.height(p.x) {
            path.known += 1;
            read = Some(Point::new(p.x, height));
            if p.y <= height + gun.settings.radius && i < count {
                path.blocked = true;
                return path;
            }
        } else if i < count {
            path.cover = true;
            // A local optical/radar contact certifies a sight corridor, not the
            // map beyond it. Indirect fire may clear unknown ground above the
            // observed endpoints; no hidden height is used for this inference.
            let fraction = ((p.x - origin.x) / (shot.aim.x - origin.x)).clamp(0.0, 1.0);
            let sight = origin.y + (target.y - origin.y) * fraction;
            let sighted = target.visible && *current_los.get_or_insert_with(|| observed.sees(id));
            let high = sighted && read.is_some() && foot.is_some() && *aloft.get_or_insert_with(||
                observed.height(shot.muzzle.x).is_some_and(|ground| shot.muzzle.y - ground >= ALOFT));
            let between = read.zip(foot).filter(|_| !sighted || high).map(|(read, foot)| {
                let span = foot.x - read.x;
                read.y + (foot.y - read.y) * if span.abs() < 1e-9 { 1.0 } else { ((p.x - read.x) / span).clamp(0.0, 1.0) }
            });
            let over = |ground: f64| p.y > ground + gun.settings.radius + target.height * 0.25;
            let clear = if sighted {
                p.y >= sight - target.height.max(1.0) * 0.25 || between.is_some_and(over)
            } else if let Some(ground) = between {
                over(ground)
            } else {
                shared_los && shot.trajectory == "high" && p.y >= sight + 3.0 * sin(PI * fraction)
            };
            if !clear {
                path.blocked = true;
                return path;
            }
        }
    }
    path
}

/// The enemies a pilot weighs at once, the best first: one no gun of its own has a shot at gives way to the next.
const TARGETS: usize = 4;
/// Of those, how many have the paths of their shots looked along: the costly part of a choice.
const LOOKED_TARGETS: usize = 2;
/// A target whose best place is worth less than this, where no round got through, is not worth a round more to a
/// pilot with no order: it turns to another, or holds its fire.
const FUTILE: f64 = 0.2;
/// What a contact its side only hears is worth beside one it sees or holds on a radar, to a pilot choosing.
const HEARD_SHARE: f64 = 0.3;

/// What a pilot makes of one enemy: how it lays a round on it, where on it it aims, and the shot a gun of its own
/// has at it, if any.
struct Engagement<'r> {
    target: &'r RosterContact,
    /// The contact as a round is laid on it: its speed shrunk by what the noise of its readings could make up.
    aimed: Contact,
    /// Every place on it stopped the rounds that struck it, and none got through.
    futile: bool,
    candidates: Vec<Shot>,
    candidate_count: usize,
    selected: Option<Shot>,
    path: Path,
    cover: bool,
    /// A shot looked along had the pilot's own construction in its way.
    own: bool,
    /// A shot looked along had an ally in its way that would stop it.
    ally: bool,
    /// A shot that bursts was not taken: its blast would reach the pilot (`solve`).
    close: bool,
    checked: usize,
    aimed_at: Option<Aim>,
}

/// How far a place stands outside a span.
fn apart(b: Bounds, p: Point) -> f64 {
    hypot((b.min_x - p.x).max(p.x - b.max_x).max(0.0), (b.min_y - p.y).max(p.y - b.max_y).max(0.0))
}
/// Each gun's ballistic options at the place `offset` from the middle of a target: strikes there, or shells set to
/// burst over it. The best first. A round that bursts is not fired where its blast or its fragments would reach the
/// pilot's own construction (`game_pressure::thrown`), off by as much as the gun strays: they would harm it as any
/// other's. One left out so is told by `close`.
fn solve(own: &OwnView<'_>, guns: &mut [Gun<'_>], aimed: &Contact, offset: Point, sample: Option<Point>, burst: bool, close: &mut bool) -> Vec<Shot> {
    let mut shots = Vec::<Shot>::new();
    let too_close = |gun: &Gun<'_>, shot: &Shot| !Ammo::from_name(&shot.ammo).kinetic()
        && apart(own.actor.bounds, shot.aim) < crate::game_pressure::thrown(gun.settings.blast_radius, gun.settings.fragments.map_or(1.0, |(_, reach)| reach)) + shot.dispersion;
    for (index, gun) in guns.iter_mut().enumerate() {
        // A gun fires only the ammunition it was built to be fed.
        let ammo = gun.settings.ammo.clone();
        if burst && (ammo != "he" || gun.settings.blast_radius < BURST_BLAST) {
            continue;
        }
        let charges = gun.settings.charges.clone();
        let sampled = sample.filter(|_| !burst && direct_gun(&gun.settings.family));
        let mut low = 0..0;
        for &arc in arcs(&gun.settings.family) {
            // Here direct is the identical low solution. Reserve the same group of two looks for sample + centre,
            // so obstructed guns cannot spend the eight-path budget twice on those same physical trajectories.
            if sampled.is_some() && arc == "direct" { continue; }
            let start = shots.len();
            gun.settings.trajectory.clear();
            gun.settings.trajectory.push_str(arc);
            gun.settings.automatic = false;
            gun.settings.aim_angle = None;
            for &charge in &charges {
                gun.settings.charge = charge;
                // Low and direct differ only in their label; keep both options and their original order.
                let option = if arc == "direct" {
                    shots[low.clone()].iter().find(|shot| shot.charge == charge).cloned().map(|mut shot| {
                        shot.trajectory = arc;
                        shot
                    })
                } else {
                    intercept(own, gun, index, aimed, sampled.unwrap_or(offset), &ammo, arc, charge, burst)
                        .or_else(|| sampled.and_then(|_| intercept(own, gun, index, aimed, offset, &ammo, arc, charge, burst)))
                };
                let Some(mut shot) = option else {
                    continue;
                };
                if too_close(gun, &shot) {
                    *close = true;
                    let central = sampled.and_then(|_| intercept(own, gun, index, aimed, offset, &ammo, arc, charge, burst));
                    let Some(central) = central.filter(|s| !too_close(gun, s)) else { continue; };
                    shot = central;
                }
                shots.push(shot);
            }
            if arc == "low" { low = start..shots.len(); }
        }
    }
    shots.sort_by(|a: &Shot, b: &Shot| b.score.total_cmp(&a.score).then_with(|| a.gun.cmp(&b.gun)));
    if sample.is_some() && !burst {
        // A sampled direct shot is followed by its central fallback, within the SAME path/group budgets below.
        // Indirect guns keep their original central candidates, also when they share a vehicle with a direct gun.
        let mut choices = Vec::with_capacity(shots.len() * 2);
        for shot in shots {
            let gun = &guns[shot.gun];
            let middle = estimate(aimed, shot.time);
            let shifted = direct_gun(&gun.settings.family)
                && shot.aim != Point::new(middle.x + offset.x, middle.y + offset.y);
            let fallback = if shifted {
                intercept(own, gun, shot.gun, aimed, offset, &shot.ammo, shot.trajectory, shot.charge, false)
                    .filter(|central| { if too_close(gun, central) { *close = true; false } else { true } })
            } else { None };
            choices.push(shot);
            if let Some(fallback) = fallback { choices.push(fallback); }
        }
        return choices;
    }
    shots
}

/// A pilot's look at one enemy. With `look`, the paths of its shots are looked along for one that is clear; without,
/// it only says whether a gun has a shot at it at all.
fn engage<'r>(
    own: &OwnView<'_>,
    guns: &mut [Gun<'_>],
    target: &'r RosterContact,
    observed: &mut impl Observed,
    look: bool,
) -> Engagement<'r> {
    let contact = &target.contact;
    let id = target.id.as_str();
    // A speed the noise of the readings could make up is shrunk toward standing still, the more the nearer it is to
    // that noise: a round is not led off a target that stands, nor left far behind one that creeps.
    let mut aimed = contact.clone();
    let noise = speed_noise(aimed.channel.unwrap_or(aimed.source), aimed.uncertainty);
    let speed = hypot(aimed.vx, aimed.vy);
    let kept = if speed > noise { 1.0 - (noise / speed).powi(2) } else { 0.0 };
    (aimed.vx, aimed.vy) = (aimed.vx * kept, aimed.vy * kept);
    // A target the side identifies by sight shows what it has outside: the place most worth a round is aimed at, a
    // little inside its outline so that a round off by a little still strikes the target. Of two worth as much, the
    // nearer the pilot.
    let places = if contact.visible && contact.classification == ContactClassification::Identified {
        observed.outside(id)
    } else {
        Vec::new()
    };
    let near = |a: &Aim| (contact.x + a.offset.x - own.actor.x).abs();
    let best = places
        .iter()
        .copied()
        .max_by(|a, b| a.worth().total_cmp(&b.worth()).then_with(|| near(b).total_cmp(&near(a))));
    let futile = best.is_some_and(|best| best.worth() < FUTILE) && places.iter().all(|a| a.holes == 0);
    let aim = best.map(|aim| {
        let margin = contact.width.min(contact.height) * 0.2;
        let room = |size: f64| (size * 0.5 - margin).max(0.0);
        Aim { offset: Point::new(aim.offset.x.clamp(-room(contact.width), room(contact.width)),
            aim.offset.y.clamp(-room(contact.height), room(contact.height))), ..aim }
    });
    let eligible = contact.confidence >= 0.32
        && contact.age <= 1.25
        && !matches!(contact.channel.unwrap_or(contact.source), ContactSource::Sound | ContactSource::None);
    let mut e = Engagement { target, aimed, futile, candidates: Vec::new(), candidate_count: 0, selected: None,
        path: Path::default(), cover: false, own: false, ally: false, close: false, checked: 0, aimed_at: None };
    if !eligible {
        return e;
    }
    // The place most worth a round is tried first, and the middle of the target when no gun has a clear way to it:
    // a place low on the target may be hidden by the ground before it.
    for place in aim.map(Some).into_iter().chain([None]) {
        e.candidates = solve(own, guns, &e.aimed, place.map_or(Point::ZERO, |a: Aim| a.offset),
            visual_sample(contact, own.actor.shots), false, &mut e.close);
        e.candidate_count = e.candidate_count.max(e.candidates.len());
        if !look {
            if e.candidate_count > 0 {
                break;
            }
            continue;
        }
        // Ballistic options are cheap; expensive sensory path checks are bounded to
        // eight distinct useful options a place, never performed at the physics frequency.
        let mut looked = 0;
        let mut groups = std::collections::HashMap::new();
        for shot in &e.candidates {
            let group = groups
                .entry((shot.gun, shot.ammo.clone(), shot.trajectory))
                .or_insert(0);
            if *group >= 2 {
                continue;
            }
            *group += 1;
            looked += 1;
            let path = check_path(own, &guns[shot.gun], id, &e.aimed, shot, observed);
            e.cover |= path.cover;
            e.own |= path.own;
            e.ally |= path.ally;
            if !path.blocked {
                e.selected = Some(shot.clone());
                e.path = path;
                break;
            }
            if looked >= 8 {
                break;
            }
        }
        e.checked += looked;
        if e.selected.is_some() {
            e.aimed_at = place;
            break;
        }
    }
    // No strike has a clear path: a shell set to burst over the target may clear the crest it stands behind. A burst
    // the ground hides is no better.
    if look && e.selected.is_none() {
        for shot in solve(own, guns, &e.aimed, Point::ZERO, None, true, &mut e.close).iter().take(BURST_CHECKS) {
            e.checked += 1;
            let path = check_path(own, &guns[shot.gun], id, &e.aimed, shot, observed);
            e.cover |= path.cover;
            e.own |= path.own;
            e.ally |= path.ally;
            if !path.blocked {
                e.selected = Some(shot.clone());
                e.path = path;
                break;
            }
        }
    }
    e
}

pub fn decide(
    state: &mut PilotState,
    own: &OwnView<'_>,
    observed: &mut impl Observed,
) -> Result<Decision, String> {
    let mut guns = guns(own)?;
    // The enemies best first: as surely held and as near as they are — an aircraft overhead as far as it is up there —, the
    // one it chose last a little before the others, and as much a threat as each is; one only heard far behind one seen.
    // And how far off the nearest it holds fresh is, by the same straight line, for the work it would hold up (squad.js
    // `endangered`): an aircraft high over it is as far as it is up there.
    let mut ranked = Vec::new();
    let mut nearest_fresh_contact_distance: Option<f64> = None;
    for r in own.contacts.iter().filter(|r| quality(&r.contact) > 0.0) {
        let distance = hypot(r.contact.x - own.actor.x, r.contact.y - own.actor.y);
        if r.contact.age < 1.0 {
            nearest_fresh_contact_distance = Some(nearest_fresh_contact_distance.map_or(distance, |near| near.min(distance)));
        }
        let heard = r.contact.channel.unwrap_or(r.contact.source) == ContactSource::Sound;
        let score = quality(&r.contact) / (1.0 + distance * 0.0015)
            * if state.target.as_deref() == Some(r.id.as_str()) { 1.15 } else { 1.0 }
            * if heard { HEARD_SHARE } else { 1.0 }
            * observed.threat(&r.id);
        ranked.push((r, score));
    }
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1).then_with(|| a.0.id.cmp(&b.0.id)));
    // The first a gun has a clear shot at is engaged; with none, the best of all is the one the pilot keeps its eye
    // and its guns on. One where every round so far was stopped gives way, to a pilot with no order, to any other,
    // and is not fired at.
    let mut engagement: Option<Engagement> = None;
    let mut looked = 0;
    for &(r, _) in ranked.iter().take(TARGETS) {
        let e = engage(own, &mut guns, r, observed, looked < LOOKED_TARGETS);
        looked += usize::from(e.checked > 0);
        if e.selected.is_some() && (own.ordered || !e.futile) {
            engagement = Some(e);
            break;
        }
        if engagement.is_none() {
            engagement = Some(e);
        }
    }
    let futile = engagement.as_ref().is_some_and(|e| e.futile && !own.ordered);
    if futile && let Some(e) = engagement.as_mut() {
        e.selected = None;
        e.aimed_at = None;
    }
    let target = engagement.as_ref().map(|e| e.target);
    if let Some(target) = target {
        state.target = Some(target.id.clone());
        let dx = estimate(&target.contact, 0.0).x - own.actor.x;
        if dx.abs() > 1.0 {
            state.bearing = dx.signum();
        }
    }
    let bearing = if state.bearing != 0.0 {
        state.bearing
    } else {
        if own.actor.facing == 0.0 {
            1.0
        } else {
            own.actor.facing.signum()
        }
    };
    let contact = target.map_or_else(Contact::default, |r| r.contact.clone());
    let id = target.map_or("", |r| r.id.as_str());
    let (own_line, ally_line, close) = engagement.as_ref().map_or((false, false, false), |e| (e.own, e.ally, e.close));
    let (aimed, candidates, candidate_count, selected, selected_path, cover, checked, aimed_at) = match engagement {
        Some(e) => (e.aimed, e.candidates, e.candidate_count, e.selected, e.path, e.cover, e.checked, e.aimed_at),
        None => (Contact::default(), Vec::new(), 0, None, Path::default(), false, 0, None),
    };
    // The other guns join in, each with the best shot of its own that has a
    // clear path: two looks a gun, on top of the eight spent choosing the lead.
    let mut others = Vec::new();
    if let Some(lead) = &selected {
        for index in (0..guns.len()).filter(|index| *index != lead.gun) {
            for shot in candidates.iter().filter(|shot| shot.gun == index).take(2) {
                if !check_path(own, &guns[index], id, &aimed, shot, observed).blocked {
                    others.push(shot.clone());
                    break;
                }
            }
        }
    }
    // `fire` is a maintained trigger. Reload admission belongs to the gun;
    // dropping the trigger on cooldown would halve automatic-gun cadence.
    let laid = |shot: &Shot| {
        let gun = &guns[shot.gun];
        let range = shot.muzzle.distance(shot.aim);
        let tolerance = atan2(
            extent(&contact).y * 0.25
                + if shot.ammo == "he" {
                    gun.settings.blast_radius * 0.1
                } else {
                    0.0
                },
            range,
        )
        .clamp(0.00025, gun.settings.servo_fire_tolerance());
        // A gun laid on the bearing of the last decision lags a target that moves by as far as the target went since.
        // One its servo turns onto the new bearing within a step of the field lies on it when it may fire: the core
        // turns a gun before it looks at its trigger (`GameState::step`).
        let slew = gun.sensor.map_or(0.0, |sensor| sensor.servo_max_speed) * FIELD_STEP;
        let aligned = angle_difference(gun.module.barrel_angle, shot.angle).abs() <= tolerance + slew;
        let blocked = gun.sensor.is_some_and(|s| s.muzzle_blocked);
        (aligned, blocked)
    };
    // The pilot holds its place, braked: an order is what drives it (`Squad.drive`).
    let mut action = json!({"type":"controls","phase":"decision","platform":"vehicle","throttle":0.0,"brake":1.0,"fire":false,
        "aim":{"x":target.map_or(own.actor.x+bearing*40.0,|r|r.contact.x),"y":target.map_or(own.actor.y,|r|r.contact.y)},
        "componentId":"none","detonation":"impact","cancel":true,
        });
    let mut fire_reason = if target.is_none() {
        "search-contact"
    } else if contact.confidence < 0.32 || contact.age > 1.25 {
        "uncertain-contact"
    } else if guns.is_empty() {
        "no-armed-feed"
    } else if futile {
        "futile-target"
    } else if candidate_count == 0 && close {
        "blast-too-close"
    } else if candidate_count == 0 {
        "no-ballistic-solution"
    } else if own_line {
        "own-in-line"
    } else if ally_line {
        "ally-in-line"
    } else {
        "terrain-cover"
    };
    // Every high-explosive shell the pilot fires is fuzed: one that strikes bursts on what it strikes, one that
    // misses over the target bursts beside it rather than far behind it.
    let fuzed = |shot: &Shot| (shot.ammo == "he").then_some(shot.fuze);
    // A gun whose barrel the pilot brought to its heat limit is let cool before it fires again (`ServoState::cooling`).
    let cooling = |shot: &Shot| guns[shot.gun].sensor.is_some_and(|s| s.cooling);
    if let Some(shot) = &selected {
        let gun = &guns[shot.gun];
        let (aligned, blocked) = laid(shot);
        let fire = aligned && !blocked && !cooling(shot);
        fire_reason = if blocked {
            "servo-obstruction"
        } else if !aligned {
            "servo-aligning"
        } else if cooling(shot) {
            "cooling"
        } else if gun.sensor.is_some_and(|s| s.reload > 1e-5) {
            "reloading"
        } else {
            "firing"
        };
        action["componentId"] = gun.module.cold["id"].clone();
        action["ammo"] = json!(shot.ammo);
        action["trajectory"] = json!(shot.trajectory);
        action["charge"] = json!(shot.charge);
        action["aim"] = shot.aim.to_value();
        action["aimAngle"] = json!(shot.angle);
        action["fire"] = json!(fire);
        if let Some(fuze) = fuzed(shot) {
            action["detonation"] = json!("airburst");
            action["fuzeTime"] = json!(fuze);
        }
        if !others.is_empty() {
            action["also"] = others.iter().map(|shot| {
                let (aligned, blocked) = laid(shot);
                let mut also = json!({"componentId":guns[shot.gun].module.cold["id"],"ammo":shot.ammo,"trajectory":shot.trajectory,
                    "charge":shot.charge,"aim":shot.aim.to_value(),"aimAngle":shot.angle,"detonation":"impact",
                    "fire":aligned && !blocked && !cooling(shot)});
                if let Some(fuze) = fuzed(shot) {
                    also["detonation"] = json!("airburst");
                    also["fuzeTime"] = json!(fuze);
                }
                also
            }).collect();
        }
    } else if let Some(gun) = guns.first() {
        action["componentId"] = gun.module.cold["id"].clone();
        action["ammo"] = json!(gun.settings.ammo);
        action["trajectory"] = json!(if gun.settings.family == "mortar" {
            "high"
        } else {
            "low"
        });
        action["charge"] = json!(gun.settings.charge);
        // No selected shot means no executable aim. Keep the current bore
        // instead of solving a new low arc that the installed sector may reject.
        action["aimAngle"] = json!(gun.module.barrel_angle);
    }
    let aim_offset = aimed_at.map(|a| a.offset).or_else(|| {
        visual_sample(&contact, own.actor.shots)?;
        let shot = selected.as_ref().filter(|s| !s.burst && direct_gun(&guns[s.gun].settings.family))?;
        let middle = estimate(&aimed, shot.time);
        Some(Point::new(shot.aim.x - middle.x, shot.aim.y - middle.y))
    });
    let diagnostics = json!({"reason":fire_reason,"confidence":contact.confidence,"uncertainty":contact.uncertainty,
        "nearestFreshContactDistance":nearest_fresh_contact_distance,
        "flightTime":selected.as_ref().map(|s|s.time),"detonation":if selected.as_ref().and_then(fuzed).is_some(){"airburst"}else{"impact"},
        "burst":selected.as_ref().is_some_and(|s|s.burst),"weaponCandidates":guns.len(),"shotCandidates":candidate_count,
        "checkedPaths":checked,"viableShots":usize::from(selected.is_some()),"guns":usize::from(selected.is_some())+others.len(),
        "contactCover":cover,"terrainKnown":if selected_path.samples>0{selected_path.known as f64/selected_path.samples as f64}else{0.0},
        "dispersion":selected.as_ref().map(|s|s.dispersion),"aim":aimed_at.map(|a|a.part.name()),"aimOffset":aim_offset.map(|p|p.to_value())});
    Ok(Decision {
        action,
        target: target.map(|r| r.id.clone()),
        contact,
        diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_sensors::{ContactClassification, VehicleReading};
    struct Scene {
        actor: SensorActor,
        drive: DriveState,
        modules: Vec<Module>,
        readings: Vec<SensorModule>,
        catalogue: Value,
        contacts: Vec<RosterContact>,
        arena: Bounds,
        ordered: bool,
    }
    impl Scene {
        fn new() -> Self {
            let drive = DriveState::from_value(
                1,
                &json!({"x":0,"y":1,"mass":10000,"carrierMass":10000,"enabled":true}),
            );
            let actor = SensorActor {
                handle: 1,
                id: "local".into(),
                team: "local".into(),
                defeated: false,
                facing: 1.0,
                x: 0.0,
                y: 1.0,
                shots: 0,
                bounds: Bounds {
                    min_x: -3.0,
                    max_x: 3.0,
                    min_y: 0.0,
                    max_y: 3.0,
                },
                vehicle: Some(VehicleReading {
                    x: 0.0,
                    y: 1.0,
                    engine: true,
                    ..Default::default()
                }),
            };
            let modules = vec![
                crate::game_damage::fixtures::module(
                    1,
                    1,
                    &json!({"id":"gun","kind":"weapon","weaponPreset":"rh120","x":0,"y":2,
                    "health":100,"maxHealth":100,"barrelAngle":0}),
                ),
                crate::game_damage::fixtures::module(
                    2,
                    1,
                    &json!({"id":"feed","kind":"ammo","ammoPreset":"rh120","rounds":20,
                    "health":100,"maxHealth":100}),
                ),
            ];
            Self {
                actor,
                drive,
                modules,
                readings: Vec::new(),
                catalogue: crate::game_damage::fixtures::catalogue().clone(),
                contacts: vec![RosterContact {
                    id: "opponent".into(),
                    contact: Contact {
                        detected: true,
                        visible: true,
                        source: ContactSource::Visual,
                        classification: ContactClassification::Identified,
                        confidence: 0.9,
                        uncertainty: 0.3,
                        x: 300.0,
                        y: 2.0,
                        width: 6.0,
                        height: 3.0,
                        ..Default::default()
                    },
                }],
                arena: Bounds {
                    min_x: -800.0,
                    max_x: 800.0,
                    min_y: 0.0,
                    max_y: 100.0,
                },
                ordered: false,
            }
        }
        fn run(&self, state: &mut PilotState, terrain: &mut impl Observed) -> Decision {
            let modules = self.modules.iter().collect::<Vec<_>>();
            let readings = self.readings.iter().collect::<Vec<_>>();
            let view = OwnView {
                actor: &self.actor,
                drive: Some(&self.drive),
                modules: &modules,
                readings: &readings,
                catalogue: &self.catalogue,
                contacts: &self.contacts,
                arena: self.arena,
                ordered: self.ordered,
            };
            decide(state, &view, terrain).unwrap()
        }
        fn shot(&self, arc: &'static str, charge: f64) -> Option<Shot> {
            let modules = self.modules.iter().collect::<Vec<_>>();
            let readings = self.readings.iter().collect::<Vec<_>>();
            let own = OwnView {
                actor: &self.actor,
                drive: Some(&self.drive),
                modules: &modules,
                readings: &readings,
                catalogue: &self.catalogue,
                contacts: &self.contacts,
                arena: self.arena,
                ordered: false,
            };
            let mut gun = guns(&own).unwrap().remove(0);
            gun.settings.trajectory = arc.into();
            gun.settings.charge = charge;
            intercept(&own, &gun, 0, &self.contacts[0].contact, Point::ZERO, "he", arc, charge, false)
        }
    }
    struct Ground {
        reading: TerrainReading,
        ridge: bool,
        ridge_height: f64,
        hidden: bool,
        hidden_height: f64,
        floor: f64,
        sight: bool,
        outside: Vec<Aim>,
        outside_reads: usize,
        /// Targets every place of which stopped many rounds, and none got through.
        spent: Vec<&'static str>,
        threats: std::collections::HashMap<&'static str, f64>,
        /// What of its own side stands in a line of fire that goes below this height where it is aimed.
        line: Option<(Line, f64)>,
        blocked_guns: Vec<u32>,
    }
    impl Ground {
        fn flat() -> Self {
            Self {
                reading: TerrainReading {
                    origin: Some(Point::new(0.0, 2.0)),
                    samples: std::array::from_fn(|_| Default::default()),
                },
                ridge: false,
                ridge_height: 8.0,
                hidden: false,
                hidden_height: 0.0,
                floor: 0.0,
                sight: false,
                outside: Vec::new(),
                outside_reads: 0,
                spent: Vec::new(),
                threats: Default::default(),
                line: None,
                blocked_guns: Vec::new(),
            }
        }
    }
    impl Observed for Ground {
        fn height(&mut self, x: f64) -> Option<f64> {
            if self.hidden && x > 100.0 {
                None
            } else {
                Some(if self.ridge && (100.0..180.0).contains(&x) {
                    self.ridge_height
                } else {
                    self.floor
                })
            }
        }
        fn reading(&self) -> &TerrainReading {
            &self.reading
        }
        fn sees(&mut self, _: &str) -> bool {
            self.sight
        }
        fn outside(&mut self, target: &str) -> Vec<Aim> {
            self.outside_reads += 1;
            if self.spent.contains(&target) {
                return [(Part::Weapon, 1.0), (Part::Hull, 0.0)].map(|(part, y)| Aim { part, offset: Point::new(0.0, y),
                    disabled: false, holes: 0, stopped: 9.0 }).to_vec();
            }
            self.outside.clone()
        }
        fn threat(&mut self, target: &str) -> f64 {
            self.threats.get(target).copied().unwrap_or(1.0)
        }
        fn in_line(&mut self, line: &LineOfFire, until: f64) -> Line {
            if self.blocked_guns.contains(&line.gun) { return Line::Ally; }
            let end = FlightState::new(line.point, line.velocity).at(until, line.drag).point;
            self.line.filter(|(_, below)| end.y < *below).map_or(Line::Clear, |(what, _)| what)
        }
    }
    #[test]
    fn worker_proximity_reads_all_fresh_eligible_contacts_before_target_ranking() {
        let mut scene = Scene::new();
        scene.modules.clear();
        let contact = scene.contacts[0].contact.clone();
        let mut ground = Ground::flat();
        scene.contacts = ["far-a", "far-b", "far-c", "far-d"].into_iter().enumerate().map(|(i, id)| {
            ground.threats.insert(id, 100.0);
            RosterContact { id: id.into(), contact: Contact { x: 2000.0 + i as f64 * 25.0, ..contact.clone() } }
        }).collect();
        scene.contacts.push(RosterContact { id: "near".into(), contact: Contact { x: 750.0, ..contact.clone() } });
        scene.contacts.push(RosterContact { id: "stale".into(), contact: Contact { x: 10.0, age: 2.0, ..contact.clone() } });
        let decision = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(decision.target.as_deref(), Some("far-a"), "the worker still keeps its ranked distant primary");
        assert_eq!(decision.action["fire"], false);
        // The contacts stand a metre higher than the pilot: each is as far off as the straight line to it.
        assert_eq!(decision.diagnostics["nearestFreshContactDistance"], hypot(750.0, 1.0),
            "a fresh nearby contact below the four-target cutoff must still pause work");
        scene.contacts[4].contact.age = 1.0;
        assert_eq!(scene.run(&mut PilotState::default(), &mut ground).diagnostics["nearestFreshContactDistance"], hypot(2000.0, 1.0));
        scene.contacts[4].contact.age = 0.0; scene.contacts[4].contact.detected = false;
        assert_eq!(scene.run(&mut PilotState::default(), &mut ground).diagnostics["nearestFreshContactDistance"], hypot(2000.0, 1.0));
        for row in &mut scene.contacts { row.contact.age = 2.0; }
        assert!(scene.run(&mut PilotState::default(), &mut ground).diagnostics["nearestFreshContactDistance"].is_null());
    }
    #[test]
    fn worker_proximity_of_a_contact_overhead_is_as_far_as_it_is_up_there() {
        let mut scene = Scene::new();
        scene.modules.clear();
        let contact = scene.contacts[0].contact.clone();
        let mut ground = Ground::flat();
        // An aircraft 100 m along the field from the pilot and 2 km over it is 2 km off, not 100 m: nothing it holds up for.
        scene.contacts = vec![RosterContact { id: "high".into(), contact: Contact { x: 100.0, y: 2001.0, ..contact } }];
        let distance = |scene: &Scene, ground: &mut Ground| scene.run(&mut PilotState::default(), ground).diagnostics["nearestFreshContactDistance"].clone();
        assert_eq!(distance(&scene, &mut ground), hypot(100.0, 2000.0));
        // Come down to 300 m over it, it is near.
        scene.contacts[0].contact.y = 301.0;
        assert_eq!(distance(&scene, &mut ground), hypot(100.0, 300.0));
    }
    #[test]
    fn no_contact_looks_out_in_own_facing_without_target_coordinates_or_fire() {
        let mut scene = Scene::new();
        scene.contacts.clear();
        scene.actor.facing = -1.0;
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.action["fire"], false);
        assert!(decision.target.is_none());
        assert!(!decision.contact.detected);
        assert_eq!(decision.action["aim"]["x"], -40.0);
    }
    #[test]
    fn shared_visual_contact_is_usable_without_a_separate_tracking_action() {
        let mut scene=Scene::new();
        scene.contacts[0].contact.source=ContactSource::Team;
        scene.contacts[0].contact.channel=Some(ContactSource::Visual);
        scene.contacts[0].contact.source_actor=Some(scene.actor.handle);
        let decision=scene.run(&mut PilotState::default(),&mut Ground::flat());
        assert_eq!(decision.target.as_deref(),Some("opponent"));
        assert!(decision.action.get("trackTargetId").is_none());
        assert!(decision.action["fire"].as_bool().unwrap());
        scene.contacts[0].contact.detected=false;
        let unknown=scene.run(&mut PilotState::default(),&mut Ground::flat());
        assert!(!unknown.action["fire"].as_bool().unwrap());assert!(unknown.target.is_none());
    }
    #[test]
    fn held_trigger_does_not_throttle_automatic_rate_on_cooldown() {
        let mut scene = Scene::new();
        // What the gun reads tells it is still loading.
        scene.readings.push(SensorModule { handle: 1, actor: 1, kind: ComponentKind::Weapon, reload: 0.07,
            servo_max_speed: PI / 6.0, ..Default::default() });
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.action["fire"], true);
        assert_eq!(decision.diagnostics["reason"], "reloading");
        assert_eq!(decision.action["componentId"], "gun");
        assert_eq!(decision.action["charge"], 1.0);
    }
    #[test]
    fn a_gun_whose_barrel_is_cooling_holds_its_fire_and_says_why() {
        let mut scene = Scene::new();
        // The pilot brought the barrel to its limit: it waits for it, aimed and ready, without firing.
        scene.readings.push(SensorModule { handle: 1, actor: 1, kind: ComponentKind::Weapon, cooling: true,
            servo_max_speed: PI / 6.0, ..Default::default() });
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.action["fire"], false);
        assert_eq!(decision.diagnostics["reason"], "cooling");
        assert_eq!(decision.action["componentId"], "gun");
    }
    #[test]
    fn fresh_visual_automatic_fire_can_use_a_short_burst_without_improving_precision() {
        let catalogue = crate::game_damage::fixtures::full_catalogue();
        let source = crate::game_templates::source("scout", &json!({"preset":"rh202"}), catalogue).unwrap();
        let compiled = crate::game_construction::compile(&source, catalogue).unwrap();
        let definition = compiled["compiled"]["modules"].as_array().unwrap().iter()
            .find(|part| part["kind"] == "weapon").unwrap();
        for bearing in [-1.0, 1.0] {
            let mut scene = Scene::new();
            scene.catalogue = catalogue["weapons"].clone();
            scene.modules[0] = Module::from_value(1, 1, definition, &catalogue["weapons"], &catalogue["mounts"]).unwrap();
            scene.modules[0].pose.x = 0.0; scene.modules[0].pose.y = 2.0;
            scene.modules[0].pose.angle = if bearing < 0.0 { PI } else { 0.0 };
            scene.modules[0].barrel_angle = scene.modules[0].pose.angle;
            scene.modules[1].ammo_preset = "rh202".into(); scene.modules[1].rounds = 100;
            scene.arena.min_x = -4000.0; scene.arena.max_x = 4000.0;
            let contact = &mut scene.contacts[0].contact;
            contact.x = bearing * 1400.0; contact.y = 2.0;
            contact.width = 0.0; contact.height = 0.0;
            contact.classification = ContactClassification::Detected;
            contact.confidence = 0.65; contact.uncertainty = 2.2;
            let laying = scene.run(&mut PilotState::default(), &mut Ground::flat());
            assert!(laying.diagnostics["shotCandidates"].as_u64().unwrap() > 0, "{}", laying.diagnostics);
            let angle = laying.action["aimAngle"].as_f64().unwrap();
            assert!((scene.modules[0].mount.as_ref().unwrap().min..=scene.modules[0].mount.as_ref().unwrap().max)
                .contains(&angle_difference(angle, scene.modules[0].pose.angle)));
            scene.modules[0].barrel_angle = angle;
            assert_eq!(scene.run(&mut PilotState::default(), &mut Ground::flat()).action["fire"], true);
            // Stale, non-visual, weak or very imprecise observations never earn
            // this automatic-fire allowance. Neither does the last cartridge.
            for condition in 0..5 {
                let original = scene.contacts[0].contact.clone();
                let c = &mut scene.contacts[0].contact;
                match condition {
                    0 => c.age = 0.6,
                    1 => { c.visible = false; c.source = ContactSource::Radar; c.channel = Some(ContactSource::Radar); },
                    2 => c.confidence = 0.4,
                    3 => c.uncertainty = 15.0,
                    _ => scene.modules[1].rounds = 1,
                }
                let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
                assert_eq!(decision.action["fire"], false, "bearing={bearing}, condition={condition}, {}", decision.diagnostics);
                scene.contacts[0].contact = original; scene.modules[1].rounds = 100;
            }
            let mut own_hull = Ground::flat(); own_hull.line = Some((Line::Own, 1000.0));
            assert_eq!(scene.run(&mut PilotState::default(), &mut own_hull).action["fire"], false,
                "a useful salvo still cannot shoot through its own hull");
            // This ground fixture has its ridge at positive x.
            if bearing > 0.0 {
                let mut covered = Ground::flat(); covered.ridge = true;
                assert_eq!(scene.run(&mut PilotState::default(), &mut covered).action["fire"], false,
                    "a useful salvo still cannot fire through the terrain");
            }
        }
    }
    #[test]
    fn lead_accounts_for_gravity_target_velocity_and_angular_muzzle_motion() {
        let mut scene = Scene::new();
        scene.drive.velocity = Point::new(7.0, 0.5);
        scene.drive.omega = 0.3;
        scene.contacts[0].contact.vx = -4.0;
        scene.contacts[0].contact.vy = 0.2;
        let modules = scene.modules.iter().collect::<Vec<_>>();
        let readings = Vec::new();
        let view = OwnView {
            actor: &scene.actor,
            drive: Some(&scene.drive),
            modules: &modules,
            readings: &readings,
            catalogue: &scene.catalogue,
            contacts: &scene.contacts,
            arena: scene.arena,
            ordered: false,
        };
        let mut gun = guns(&view).unwrap().remove(0);
        gun.settings.trajectory = "low".into();
        gun.settings.automatic = false;
        let shot = intercept(&view, &gun, 0, &scene.contacts[0].contact, Point::ZERO, "apfsds", "low", 1.0, false).unwrap();
        assert!(
            flight(&shot, shot.time).distance(estimate(&scene.contacts[0].contact, shot.time))
                < 0.001
        );
        let inherited = scene.drive.velocity_at(shot.muzzle);
        assert!(
            (shot.velocity.x - cos(shot.angle) * gun.settings.speed - inherited.x).abs() < 1e-10
        );
        assert!(
            (shot.velocity.y - sin(shot.angle) * gun.settings.speed - inherited.y).abs() < 1e-10
        );
        assert!(shot.aim.x < scene.contacts[0].contact.x);
    }
    #[test]
    fn low_and_direct_preserve_duplicate_charges_and_observation_budget() {
        struct Unread {
            reading: TerrainReading,
            calls: Vec<&'static str>,
        }
        impl Observed for Unread {
            fn height(&mut self, _: f64) -> Option<f64> { self.calls.push("height"); None }
            fn reading(&self) -> &TerrainReading { &self.reading }
            fn sees(&mut self, _: &str) -> bool { self.calls.push("sees"); false }
            fn outside(&mut self, _: &str) -> Vec<Aim> { self.calls.push("outside"); Vec::new() }
            fn in_line(&mut self, _: &LineOfFire, _: f64) -> Line { self.calls.push("line"); Line::Clear }
        }
        for bearing in [-1.0, 1.0] {
            let mut scene = Scene::new();
            scene.catalogue["rh120"]["charges"] = json!([{"value":0.000001},{"value":1.0},{"value":0.4},{"value":0.4}]);
            scene.actor.facing = bearing;
            scene.modules[0].pose.angle = if bearing < 0.0 { PI } else { 0.0 };
            scene.modules[0].barrel_angle = scene.modules[0].pose.angle;
            let mut other = scene.modules[0].clone();
            other.owner = 3; other.cold["id"] = json!("other-gun");
            scene.modules.push(other);
            let contact = &mut scene.contacts[0].contact;
            contact.x = bearing * 300.0;
            contact.source = ContactSource::Team;
            contact.channel = Some(ContactSource::Visual);
            contact.source_actor = Some(99);
            {
                let modules = scene.modules.iter().collect::<Vec<_>>();
                let readings = scene.readings.iter().collect::<Vec<_>>();
                let own = OwnView { actor: &scene.actor, drive: Some(&scene.drive), modules: &modules,
                    readings: &readings, catalogue: &scene.catalogue, contacts: &scene.contacts,
                    arena: scene.arena, ordered: false };
                let mut guns = guns(&own).unwrap();
                let mut close = false;
                let shots = solve(&own, &mut guns, &scene.contacts[0].contact, Point::ZERO, None, false, &mut close);
                assert!(!close);
                assert_eq!(shots.len(), 12, "two guns retain both labels and duplicate charges; the tiny charge cannot reach");
                for index in 0..2 {
                    for (charge, expected) in [(1.0, vec!["low", "direct"]), (0.4, vec!["low", "low", "direct", "direct"])] {
                        let labels = shots.iter().filter(|shot| shot.gun == index && shot.charge == charge)
                            .map(|shot| shot.trajectory).collect::<Vec<_>>();
                        assert_eq!(labels, expected, "bearing={bearing}, gun={index}, charge={charge}");
                    }
                    assert_eq!(guns[index].settings.charge, 0.4);
                    assert_eq!(guns[index].settings.trajectory, "direct");
                    assert!(!guns[index].settings.automatic);
                    assert!(guns[index].settings.aim_angle.is_none());
                }
            }
            let mut observed = Unread { reading: Ground::flat().reading, calls: Vec::new() };
            let decision = scene.run(&mut PilotState::default(), &mut observed);
            assert_eq!(decision.target.as_deref(), Some("opponent"));
            assert_eq!(decision.action["fire"], false);
            assert_eq!(decision.action["charge"], 0.4, "a held bore retains the final propellant level");
            assert_eq!(decision.action["aimAngle"], scene.modules[0].barrel_angle);
            assert_eq!(decision.diagnostics["reason"], "terrain-cover");
            assert_eq!(decision.diagnostics["shotCandidates"], 12);
            assert_eq!(decision.diagnostics["checkedPaths"], 8);
            let expected = std::iter::once("outside")
                .chain((0..8).flat_map(|_| ["line", "height", "sees"])).collect::<Vec<_>>();
            assert_eq!(observed.calls, expected, "the labels retain each observable path check in order");
        }
    }
    #[test]
    fn mortar_and_howitzer_intercepts_account_for_motion_relative_to_stationary_air() {
        for (preset, speed, barrel, charge, range) in [
            ("m252", 72.0, 0.85, 0.4, 40.0),
            ("m252", 72.0, 0.85, 0.4, 150.0),
            ("m119", 110.0, 1.6, 0.6, 300.0),
        ] {
            let mut scene = Scene::new();
            scene.modules[0].weapon_preset = preset.into();
            scene.modules[0].pose.angle = PI/2.0;
            scene.modules[1].ammo_preset = preset.into();
            scene.catalogue[preset].as_object_mut().unwrap().extend(json!({"family":if preset=="m252"{"mortar"}else{"howitzer"},
                "mass":if preset=="m252"{2.2}else{8.0},"caliberMm":if preset=="m252"{81.0}else{105.0},
                "allowedAmmo":["he"],"speed":speed,"barrel":barrel,"spread":0.13,"life":45,"blastRadius":3.5}).as_object().unwrap().clone());
            for bearing in [-1.0, 1.0] {
                scene.contacts[0].contact.x = bearing * range;
                scene.drive.velocity = Point::ZERO;
                scene.contacts[0].contact.vx = 0.0;
                scene.contacts[0].contact.vy = 0.0;
                let rest = scene.shot("high", charge).unwrap();
                for boost in [-5.0, 5.0] {
                    scene.drive.velocity = Point::new(boost, 1.25);
                    scene.contacts[0].contact.vx = boost;
                    scene.contacts[0].contact.vy = 1.25;
                    let moving = scene.shot("high", charge).unwrap();
                    // Air defines a rest frame: a common boost changes drag.
                    assert!((moving.time-rest.time).abs()>1e-8 || angle_difference(moving.angle,rest.angle).abs()>1e-8);
                    assert!(
                        flight(&moving, moving.time)
                            .distance(estimate(&scene.contacts[0].contact, moving.time))
                            < 0.01
                    );
                }
            }
        }
    }
    #[test]
    fn high_arcs_keep_reachable_reverse_and_rotating_muzzle_solutions() {
        let mut scene = Scene::new();
        scene.modules[0].weapon_preset = "m252".into();
        scene.modules[0].pose.angle = PI/2.0;
        scene.modules[1].ammo_preset = "m252".into();
        scene.catalogue["m252"].as_object_mut().unwrap().extend(json!({"family":"mortar","allowedAmmo":["he"],"speed":72,"barrel":0.85,
            "mass":2.2,"caliberMm":81,"life":45,"spread":0.2,"blastRadius":3.5}).as_object().unwrap().clone());
        scene.contacts[0].contact.x = 40.0;
        scene.drive.velocity = Point::new(-5.0, 0.0);
        let reverse = scene.shot("high", 0.4).unwrap();
        assert!(reverse.time > 8.0 && reverse.time < 10.0);
        assert!(
            flight(&reverse, reverse.time)
                .distance(estimate(&scene.contacts[0].contact, reverse.time))
                < 0.01
        );
        scene.modules[0].weapon_preset = "m119".into();
        scene.modules[1].ammo_preset = "m119".into();
        scene.catalogue["m119"].as_object_mut().unwrap().extend(json!({"family":"howitzer","allowedAmmo":["he"],"speed":110,"barrel":1.6,
            "mass":8,"caliberMm":105,"life":45,"spread":0.13,"blastRadius":5.2}).as_object().unwrap().clone());
        scene.contacts[0].contact.x = 300.0;
        scene.contacts[0].contact.vx = -4.0;
        scene.drive.velocity = Point::new(7.0, 0.5);
        scene.drive.omega = 0.3;
        let rotating = scene.shot("high", 0.6).unwrap();
        assert!(
            flight(&rotating, rotating.time)
                .distance(estimate(&scene.contacts[0].contact, rotating.time))
                < 0.01
        );
        let inherited = scene.drive.velocity_at(rotating.muzzle);
        assert!(
            (rotating.velocity.x - cos(rotating.angle) * 110.0 * sqrt(0.6) - inherited.x).abs()
                < 1e-10
        );
    }
    #[test]
    fn intercept_search_rejects_unreachable_and_expired_high_arcs() {
        let delta = Point::new(40.0, 0.0);
        let launch=ShotLaunch {origin:Point::ZERO,inherited:Point::ZERO,omega:0.0,
            speed:72.0*sqrt(0.4),barrel:0.85,life:1.0,drag:Drag::admit(2.2,81.0,"mortar",None).unwrap()};
        assert!(
            launch.intercept(delta,Point::ZERO,false).is_some()
        );
        assert!(launch.pilot_intercept(delta,Point::ZERO,false).is_some());
        assert!(
            launch.intercept(delta,Point::ZERO,true).is_none()
        );
        assert!(launch.pilot_intercept(delta,Point::ZERO,true).is_none());
        for high in [false, true] {
            assert!(
                ShotLaunch {speed:72.0,life:45.0,..launch}.intercept(Point::new(1000.0,0.0),Point::ZERO,high).is_none()
            );
            assert!(ShotLaunch {speed:72.0,life:45.0,..launch}
                .pilot_intercept(Point::new(1000.0,0.0),Point::ZERO,high).is_none());
        }
    }
    #[test]
    fn authored_front_and_roof_sectors_admit_only_executable_arcs_on_both_sides() {
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        // A howitzer on a front mount reaches a near target on a flat arc; on a
        // roof mount its lowest charge already carries a steep arc kilometres out.
        for (preset, steep) in [("m119", 1500.0), ("m777", 6000.0)] {
            for high in [false, true] {
                let source=crate::game_templates::source("howitzer", &json!({"preset":preset,"highArc":high}), catalogue).unwrap();
                let compiled=crate::game_construction::compile(&source, catalogue).unwrap();
                let definition=compiled["compiled"]["modules"].as_array().unwrap().iter()
                    .find(|part| part["kind"]=="weapon").unwrap();
                for bearing in [-1.0, 1.0] {
                    let mut scene=Scene::new();
                    let mut gun=Module::from_value(1,1,definition,&catalogue["weapons"],&catalogue["mounts"]).unwrap();
                    gun.pose.x=0.0; gun.pose.y=2.0;
                    if bearing>0.0 {
                        gun.pose.angle=PI-gun.pose.angle;
                        let mount=gun.mount.as_mut().unwrap();
                        (mount.min,mount.max)=(-mount.max,-mount.min);
                    }
                    gun.barrel_angle=gun.pose.angle;
                    scene.modules[0]=gun;
                    scene.modules[1].ammo_preset=preset.into();
                    scene.arena.min_x=-steep-100.0; scene.arena.max_x=steep+100.0;
                    scene.contacts[0].contact.x=bearing*if high {steep} else {300.0};
                    let mut viable=0;
                    for charge in catalogue["weapons"][preset]["charges"].as_array().unwrap() {
                        let charge=charge["value"].as_f64().unwrap();
                        let legal=scene.shot(if high {"high"} else {"low"},charge);
                        if let Some(shot)=legal {
                            viable+=1;
                            let mount=scene.modules[0].mount.as_ref().unwrap();
                            assert!((mount.min..=mount.max).contains(&angle_difference(shot.angle,scene.modules[0].pose.angle)));
                            // Automatic aim admits at most a centimetre of forecast residual.
                            assert!(flight(&shot,shot.time).distance(estimate(&scene.contacts[0].contact,shot.time))<0.01);
                        }
                        assert!(scene.shot(if high {"low"} else {"high"},charge).is_none(),
                            "{preset} high-mount={high} bearing={bearing} charge={charge}");
                    }
                    assert!(viable>0,"{preset} high-mount={high} bearing={bearing}");
                }
            }
        }
    }
    #[test]
    fn absent_or_out_of_sector_solutions_hold_the_actual_bore_without_path_queries() {
        let mut scene=Scene::new();
        scene.modules[0].barrel_angle=0.23;
        scene.contacts[0].contact.x=-300.0;
        let decision=scene.run(&mut PilotState::default(),&mut Ground::flat());
        assert_eq!(decision.diagnostics["shotCandidates"],0);
        assert_eq!(decision.diagnostics["checkedPaths"],0);
        assert_eq!(decision.diagnostics["reason"],"no-ballistic-solution");
        assert_eq!(decision.action["aimAngle"],0.23);
        assert_eq!(decision.action["fire"],false);
        scene.contacts.clear();
        let missing=scene.run(&mut PilotState::default(),&mut Ground::flat());
        assert_eq!(missing.action["aimAngle"],0.23);
        assert_eq!(missing.action["fire"],false);
    }
    #[test]
    fn unusable_or_unfed_weapons_are_not_candidates() {
        let mut scene = Scene::new();
        scene.modules[1].ammo_preset = "m252".into();
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.diagnostics["weaponCandidates"], 0);
        assert_eq!(decision.action["fire"], false);
        scene.modules[1].ammo_preset = "rh120".into();
        scene.modules[0].barrel_disabled = true;
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.diagnostics["weaponCandidates"], 0);
    }
    #[test]
    fn a_pilot_turns_to_the_next_enemy_when_no_gun_has_a_shot_at_the_first_and_to_threats_before_spotters() {
        // An enemy as far off behind the pilot, where its gun does not turn, comes first by name: the one before it is
        // fired at.
        let mut scene = Scene::new();
        let mut behind = scene.contacts[0].clone();
        behind.id = "behind".into();
        behind.contact.x = -300.0;
        scene.contacts.push(behind);
        let mut state = PilotState::default();
        let decision = scene.run(&mut state, &mut Ground::flat());
        assert_eq!(decision.target.as_deref(), Some("opponent"));
        assert_eq!(decision.action["fire"], true);
        assert_eq!(state.target.as_deref(), Some("opponent"));
        // Shells alone, and an enemy parked within the reach of their blast: the blast and the fragments of a round
        // harm the pilot's own construction as any other, and the pilot shells the farther one.
        let mut scene = Scene::new();
        scene.modules[0].cold["weaponAmmo"] = json!("he");
        let mut hugger = scene.contacts[0].clone();
        hugger.id = "hugger".into();
        hugger.contact.x = 6.0;
        scene.contacts.push(hugger);
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.target.as_deref(), Some("opponent"));
        assert_eq!(decision.action["fire"], true);
        // The hugger alone: the pilot holds its fire and says why. Fed long rods, which do not burst, it fires.
        scene.contacts.remove(0);
        let held = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(held.target.as_deref(), Some("hugger"));
        assert_eq!((held.action["fire"].clone(), held.diagnostics["reason"].clone()), (json!(false), json!("blast-too-close")));
        scene.modules[0].cold["weaponAmmo"] = json!("apfsds");
        assert_eq!(scene.run(&mut PilotState::default(), &mut Ground::flat()).action["fire"], true);
        // Just past the reach of the blast and its fragments from the hull, and the stray of the gun, it is shelled.
        scene.modules[0].cold["weaponAmmo"] = json!("he");
        let reach = crate::game_pressure::reach(1.75);
        scene.contacts[0].contact.x = scene.actor.bounds.max_x + reach + 0.2;
        assert_eq!(scene.run(&mut PilotState::default(), &mut Ground::flat()).action["fire"], true, "reach {reach}");
        // Of two it can strike, one with guns comes before one that only sees for its side, though farther.
        let mut scene = Scene::new();
        let mut spotter = scene.contacts[0].clone();
        spotter.id = "spotter".into();
        spotter.contact.x = 250.0;
        scene.contacts.push(spotter);
        let mut ground = Ground::flat();
        assert_eq!(scene.run(&mut PilotState::default(), &mut ground).target.as_deref(), Some("spotter"));
        ground.threats.insert("spotter", 0.4);
        assert_eq!(scene.run(&mut PilotState::default(), &mut ground).target.as_deref(), Some("opponent"));
    }
    #[test]
    fn a_pilot_with_no_order_spends_no_round_more_where_every_round_was_stopped() {
        let mut scene = Scene::new();
        let mut ground = Ground::flat();
        ground.spent.push("opponent");
        let held = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(held.action["fire"], false);
        assert_eq!(held.diagnostics["reason"], "futile-target");
        // Ordered onto it, it lays its gun on it all the same.
        scene.ordered = true;
        let ordered = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(ordered.diagnostics["viableShots"], 1);
        assert_ne!(ordered.diagnostics["reason"], "futile-target");
        // With another enemy in reach, it turns to that one.
        scene.ordered = false;
        let mut other = scene.contacts[0].clone();
        other.id = "other".into();
        other.contact.x = 420.0;
        scene.contacts.push(other);
        let turned = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(turned.target.as_deref(), Some("other"));
        assert_eq!(turned.action["fire"], true);
    }
    #[test]
    fn a_pilot_holds_its_fire_into_its_own_construction_and_into_an_ally_that_would_stop_it() {
        let scene = Scene::new();
        for (what, reason) in [(Line::Own, "own-in-line"), (Line::Ally, "ally-in-line")] {
            // Every line that comes in low on the target meets it: none is fired.
            let mut ground = Ground::flat();
            ground.line = Some((what, f64::INFINITY));
            let held = scene.run(&mut PilotState::default(), &mut ground);
            assert_eq!(held.action["fire"], false, "{reason}");
            assert_eq!(held.diagnostics["viableShots"], 0, "{reason}");
            assert_eq!(held.diagnostics["reason"], reason);
            // One that comes in higher on it clears what is in the way, and the gun is laid on it.
            ground.line = Some((what, 2.0));
            ground.outside = vec![Aim { part: Part::Sensor, offset: Point::new(0.0, 1.0), disabled: false, holes: 0, stopped: 0.0 }];
            ground.sight = true;
            let clear = scene.run(&mut PilotState::default(), &mut ground);
            assert_eq!(clear.diagnostics["viableShots"], 1, "{reason}");
            assert_eq!(clear.diagnostics["aim"], "sensor", "{reason}");
            assert!(clear.action["aim"]["y"].as_f64().unwrap() >= 2.0);
        }
    }
    #[test]
    fn observed_ridge_blocks_low_fire() {
        let mut scene = Scene::new();
        let mut ground = Ground::flat();
        ground.ridge = true;
        let decision = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(decision.action["fire"], false);
        assert_eq!(decision.diagnostics["viableShots"], 0);
        // Observed terrain also blocks an explicit target order.
        assert_eq!(decision.diagnostics["reason"], "terrain-cover");
        assert_eq!(decision.target.as_deref(), Some("opponent"));
        scene.ordered = true;
        let ordered = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(ordered.target, decision.target);
        assert_eq!(ordered.contact.to_value(), decision.contact.to_value());
        assert_eq!(ordered.action, decision.action);
        assert_eq!(ordered.diagnostics, decision.diagnostics);
    }
    #[test]
    fn a_target_just_behind_a_crest_is_shelled_with_a_burst_over_it_and_one_in_the_open_is_struck() {
        let mut scene = Scene::new();
        scene.contacts[0].contact.x = 200.0;
        // The cannon was built to be fed high-explosive shells.
        scene.modules[0].cold["weaponAmmo"] = json!("he");
        let blast = {
            let modules = scene.modules.iter().collect::<Vec<_>>();
            let readings = Vec::new();
            let view = OwnView { actor: &scene.actor, drive: Some(&scene.drive), modules: &modules, readings: &readings,
                catalogue: &scene.catalogue, contacts: &scene.contacts, arena: scene.arena, ordered: false };
            guns(&view).unwrap()[0].settings.blast_radius
        };
        assert!(blast >= BURST_BLAST, "the cannon's shell bursts wide enough to be set to burst: {blast}");
        let run = |scene: &Scene, ground: &mut Ground| scene.run(&mut PilotState::default(), ground);
        // In the open the pilot strikes, aimed at the target's middle. The shell is fuzed just past it: struck, it
        // bursts on what it strikes; missed over, it bursts beside the target rather than far behind.
        let open = run(&scene, &mut Ground::flat());
        assert_eq!(open.action["detonation"], "airburst");
        assert_eq!(open.diagnostics["burst"], false);
        let (flight, fuze) = (open.diagnostics["flightTime"].as_f64().unwrap(), open.action["fuzeTime"].as_f64().unwrap());
        assert!(fuze > flight && fuze < flight + 0.02, "fuzed {fuze} s for a flight of {flight} s");
        // Its hull behind a crest three metres high that ends twenty metres before it: no strike clears the crest. A
        // high-explosive shell set to burst over the target does, timed to the place it is aimed at, over its top by
        // a share of its blast.
        let mut ground = Ground::flat();
        ground.ridge = true;
        ground.ridge_height = 3.0;
        let hidden = run(&scene, &mut ground);
        assert_eq!(hidden.action["detonation"], "airburst");
        assert_eq!(hidden.diagnostics["burst"], true);
        assert_eq!(hidden.action["ammo"], "he");
        let fuze = hidden.action["fuzeTime"].as_f64().unwrap();
        assert_eq!(hidden.diagnostics["flightTime"].as_f64().unwrap(), fuze);
        assert!(fuze > 0.1 && fuze < 0.5, "{fuze} s to 200 m");
        let aim = hidden.action["aim"]["y"].as_f64().unwrap();
        assert!((aim - (2.0 + 1.5 + blast * BURST_RISE)).abs() < 1e-9, "aimed {aim} m up");
        assert_eq!(hidden.diagnostics["viableShots"], 1);
        // A crest too high for a burst over the target to clear: nothing to fire, and nothing set to burst.
        ground.ridge_height = 8.0;
        let blocked = run(&scene, &mut ground);
        assert_eq!(blocked.action["fire"], false);
        assert_eq!(blocked.action["detonation"], "impact");
        assert!(blocked.action.get("fuzeTime").is_none());
        // Fed long rods, the same cannon has no shell to burst: behind the low crest it holds its fire,
        // and in the open it strikes with what it is fed.
        scene.modules[0].cold["weaponAmmo"] = json!("apfsds");
        ground.ridge_height = 3.0;
        let piercing = run(&scene, &mut ground);
        assert_eq!(piercing.action["fire"], false);
        assert_eq!(piercing.action["detonation"], "impact");
        let open = run(&scene, &mut Ground::flat());
        assert_eq!(open.action["fire"], true);
        assert_eq!(open.action["ammo"], "apfsds");
    }
    #[test]
    fn hidden_terrain_changes_do_not_change_a_sensor_identical_decision() {
        let scene = Scene::new();
        let mut a = Ground::flat();
        a.hidden = true;
        a.hidden_height = 1000.0;
        let mut b = Ground::flat();
        b.hidden = true;
        b.hidden_height = -1000.0;
        let first = scene
            .run(&mut PilotState::default(), &mut a)
            .to_value();
        let second = scene
            .run(&mut PilotState::default(), &mut b)
            .to_value();
        assert_eq!(first, second);
        assert_eq!(first["diagnostics"]["contactCover"], true);
    }
    #[test]
    fn a_pilot_whose_own_optic_sees_a_target_another_read_fires_over_unread_ground() {
        let mut scene = Scene::new();
        let contact = &mut scene.contacts[0].contact;
        contact.source = ContactSource::Team;
        contact.channel = Some(ContactSource::Visual);
        contact.source_actor = Some(7);
        contact.classification = ContactClassification::Estimated;
        let mut ground = Ground::flat();
        ground.hidden = true;
        let blind = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(blind.action["fire"], false);
        assert_eq!(blind.diagnostics["reason"], "terrain-cover");
        ground.sight = true;
        let seen = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(seen.action["fire"], true);
        assert_eq!(seen.diagnostics["contactCover"], true);
    }
    #[test]
    fn unread_ground_runs_straight_from_the_last_read_to_where_a_target_seen_whole_stands() {
        let mut scene = Scene::new();
        let contact = &mut scene.contacts[0].contact;
        contact.source = ContactSource::Team;
        contact.channel = Some(ContactSource::Visual);
        contact.source_actor = Some(7);
        // Read up to 100 m, the ground then runs down to the foot of the target, 3 m tall, 300 m off: the round clears it.
        let mut ground = Ground::flat();
        ground.hidden = true;
        let open = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(open.action["fire"], true);
        // Ground read a little under the bore at 100 m runs on near enough to it for a round to strike it.
        ground.floor = 1.5;
        let low = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(low.action["fire"], false);
        assert_eq!(low.diagnostics["reason"], "terrain-cover");
    }
    #[test]
    fn a_gun_high_over_the_ground_fires_down_past_unread_ground_at_a_target_its_own_optic_sees() {
        // Its optic 2 m over its bore sees a target 1 500 m off, 3 m tall, over ground read out to 100 m. On the ground, a
        // round laid on the target runs too far under the line the optic looks along, where nothing was read under it.
        let mut scene = Scene::new();
        scene.contacts[0].contact.x = 1500.0;
        scene.arena.max_x = 2000.0;
        let mut ground = Ground::flat();
        ground.hidden = true;
        ground.sight = true;
        ground.reading.origin = Some(Point::new(0.0, 4.0));
        let low = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(low.action["fire"], false);
        assert_eq!(low.diagnostics["reason"], "terrain-cover");
        // 200 m up, the ground under it read, the unread ground is taken to run straight to the foot of the target.
        let up = 200.0;
        scene.actor.y += up;
        scene.actor.bounds.min_y += up;
        scene.actor.bounds.max_y += up;
        if let Some(vehicle) = scene.actor.vehicle.as_mut() { vehicle.y += up; }
        scene.drive = DriveState::from_value(1, &json!({"x":0,"y":1.0 + up,"mass":10000,"carrierMass":10000,"enabled":true}));
        scene.modules[0].pose.y += up;
        scene.arena.max_y = 400.0;
        ground.reading.origin = Some(Point::new(0.0, 4.0 + up));
        let laying = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!((laying.diagnostics["reason"].as_str(), laying.diagnostics["viableShots"].as_u64()), (Some("servo-aligning"), Some(1)));
        // Laid down on it, it fires.
        scene.modules[0].barrel_angle = laying.action["aimAngle"].as_f64().unwrap();
        let high = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(high.action["fire"], true, "{}", high.diagnostics);
        assert_eq!(high.diagnostics["contactCover"], true);
    }
    #[test]
    fn a_pilot_aims_at_the_place_most_worth_a_round_and_turns_from_where_rounds_are_stopped() {
        let mut scene = Scene::new();
        let mut ground = Ground::flat();
        let place = |part, x, y| Aim { part, offset: Point::new(x, y), disabled: false, holes: 0, stopped: 0.0 };
        ground.outside = vec![place(Part::Weapon, -1.0, 1.0), place(Part::Sensor, 0.5, 1.4), place(Part::Hull, 0.0, 0.0)];
        let decide = |scene: &Scene, ground: &mut Ground| scene.run(&mut PilotState::default(), ground);
        // Its gun first, a little inside the outline: the target is 3 m tall, so a round goes no higher than 0.9 m over its middle.
        let gun = decide(&scene, &mut ground);
        assert_eq!(gun.diagnostics["aim"], "weapon");
        assert!((gun.action["aim"]["x"].as_f64().unwrap() - 299.0).abs() < 1e-6);
        assert!((gun.action["aim"]["y"].as_f64().unwrap() - 2.9).abs() < 1e-6);
        // Rounds stopped on its gun, the pilot turns to its eyes.
        ground.outside[0].stopped = 2.0;
        let eyes = decide(&scene, &mut ground);
        assert_eq!(eyes.diagnostics["aim"], "sensor");
        assert!((eyes.action["aim"]["x"].as_f64().unwrap() - 300.5).abs() < 1e-6);
        // Where they got through is worth more rounds still.
        ground.outside[0].holes = 3;
        assert_eq!(decide(&scene, &mut ground).diagnostics["aim"], "weapon");
        // Its running gear, low on it, the ground before it hides from the bore: the pilot fires at its middle.
        ground.outside = vec![place(Part::Gear, 0.0, -1.4)];
        let low = decide(&scene, &mut ground);
        assert_eq!(low.diagnostics["aim"], "gear");
        assert!((low.action["aim"]["y"].as_f64().unwrap() - 1.1).abs() < 1e-6);
        ground.ridge = true;
        ground.ridge_height = 1.6;
        let hidden = decide(&scene, &mut ground);
        assert!(hidden.diagnostics["aim"].is_null());
        assert_eq!(hidden.action["fire"], true);
        assert!((hidden.action["aim"]["y"].as_f64().unwrap() - 2.0).abs() < 1e-6);
        ground.ridge = false;
        // A target the pilot does not identify by sight is aimed at in the middle.
        scene.contacts[0].contact.classification = ContactClassification::Estimated;
        let middle = decide(&scene, &mut ground);
        assert!(middle.diagnostics["aim"].is_null());
        assert!((middle.action["aim"]["y"].as_f64().unwrap() - 2.0).abs() < 1e-6);
    }
    #[test]
    fn estimated_visual_sampling_waits_for_real_shots_and_keeps_its_point_during_alignment_and_reload() {
        let mut scene = Scene::new();
        scene.contacts[0].contact.classification = ContactClassification::Estimated;
        scene.contacts[0].contact.height = 2.0;
        let mut ground = Ground::flat();
        let mut state = PilotState::default();
        let middle = scene.run(&mut state, &mut ground);
        assert_eq!(middle.action["aim"]["y"], 2.0);
        scene.actor.shots = 1;
        scene.modules[0].barrel_angle = 0.23;
        let lower = scene.run(&mut state, &mut ground);
        assert!((lower.action["aim"]["y"].as_f64().unwrap() - 1.6).abs() < 1e-6);
        assert_eq!(lower.diagnostics["reason"], "servo-aligning");
        assert_eq!(lower.action["fire"], false);
        assert_eq!(scene.run(&mut state, &mut ground).action["aim"], lower.action["aim"], "no shot, no new sample");
        scene.modules[0].barrel_angle = lower.action["aimAngle"].as_f64().unwrap();
        scene.readings.push(SensorModule { handle: 1, actor: 1, kind: ComponentKind::Weapon, reload: 0.3, ..Default::default() });
        let loading = scene.run(&mut state, &mut ground);
        assert_eq!(loading.action["aim"], lower.action["aim"]);
        assert_eq!(loading.diagnostics["reason"], "reloading");
        assert_eq!(loading.action["fire"], true, "the maintained trigger does not bypass reload admission");
        scene.actor.shots = 2;
        let upper = scene.run(&mut state, &mut ground);
        assert!((upper.action["aim"]["y"].as_f64().unwrap() - 2.4).abs() < 1e-6);
        assert!(upper.diagnostics["aim"].is_null(), "a sample identifies no hidden part");
        assert!((upper.diagnostics["aimOffset"]["y"].as_f64().unwrap() - 0.4).abs() < 1e-6);
        scene.actor.shots = 3;
        assert_eq!(scene.run(&mut state, &mut ground).action["aim"]["y"], 2.0);
        assert_eq!(ground.outside_reads, 0);
    }
    #[test]
    fn estimated_visual_sampling_uses_a_safe_central_fallback_within_the_existing_path_budget() {
        let mut scene = Scene::new();
        scene.actor.shots = 1;
        scene.contacts[0].contact.classification = ContactClassification::Estimated;
        scene.contacts[0].contact.height = 2.0;
        let mut ground = Ground::flat();
        ground.line = Some((Line::Ally, 1.8));
        let blocked = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(blocked.action["aim"]["y"], 2.0, "the lower line crosses an ally, the middle does not");
        assert_eq!(blocked.diagnostics["aimOffset"]["y"], 0.0);
        assert!((2..=8).contains(&blocked.diagnostics["checkedPaths"].as_u64().unwrap()));
        ground.line = None;
        scene.modules[0].mount.as_mut().unwrap().min = 0.0;
        let sector = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(sector.action["aim"]["y"], 2.0, "the sample is outside the mount sector, the middle is legal");
        assert_eq!(sector.diagnostics["viableShots"], 1);
        assert_eq!(ground.outside_reads, 0);
        let mut many = Scene::new();
        many.actor.shots = 1;
        many.contacts[0].contact.classification = ContactClassification::Estimated;
        many.contacts[0].contact.height = 2.0;
        many.catalogue["rh120"]["charges"] = json!([{"value":1.0}]);
        for (owner, name) in [(3, "second-gun"), (5, "third-gun")] {
            let mut gun = many.modules[0].clone(); gun.owner = owner; gun.cold["id"] = json!(name);
            let mut feed = many.modules[1].clone(); feed.owner = owner + 1;
            many.modules.extend([gun, feed]);
        }
        ground.blocked_guns = vec![1, 3];
        let third = many.run(&mut PilotState::default(), &mut ground);
        assert_eq!(third.action["componentId"], "third-gun", "two obstructed guns leave the third its first look");
        assert_eq!(third.diagnostics["checkedPaths"], 5, "sample + centre each, then the unobstructed gun");
        assert_eq!(ground.outside_reads, 0);
    }
    #[test]
    fn estimated_visual_sampling_keeps_indirect_guns_central_and_other_observations_unchanged() {
        let mut scene = Scene::new();
        scene.actor.shots = 1;
        scene.contacts[0].contact.classification = ContactClassification::Estimated;
        scene.contacts[0].contact.height = 2.0;
        let mut indirect = scene.modules[0].clone();
        indirect.owner = 3; indirect.weapon_preset = "m119".into(); indirect.cold["id"] = json!("indirect-gun");
        let mut feed = scene.modules[1].clone(); feed.owner = 4; feed.ammo_preset = "m119".into();
        scene.modules.extend([indirect, feed]);
        let mut ground = Ground::flat();
        let mixed = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(mixed.action["componentId"], "gun");
        assert!((mixed.action["aim"]["y"].as_f64().unwrap() - 1.6).abs() < 1e-6);
        let indirect = mixed.action["also"].as_array().unwrap().iter().find(|a| a["componentId"] == "indirect-gun").unwrap();
        assert_eq!(indirect["aim"]["y"], 2.0);
        assert_eq!(ground.outside_reads, 0);
        // A stale/tiny visual estimate, radar and audio retain their original actions regardless of the shot count.
        for contact in [Contact { visible: false, ..scene.contacts[0].contact.clone() },
            Contact { height: 0.5, ..scene.contacts[0].contact.clone() },
            Contact { source: ContactSource::Team, channel: Some(ContactSource::Radar), ..scene.contacts[0].contact.clone() },
            Contact { source: ContactSource::Team, channel: Some(ContactSource::Sound), ..scene.contacts[0].contact.clone() },
            Contact { classification: ContactClassification::Identified, ..scene.contacts[0].contact.clone() }] {
            scene.contacts[0].contact = contact;
            scene.actor.shots = 0;
            let before = scene.run(&mut PilotState::default(), &mut ground);
            scene.actor.shots = 1;
            assert_eq!(scene.run(&mut PilotState::default(), &mut ground).action, before.action);
        }
    }
    #[test]
    fn the_marks_a_place_is_known_by_are_those_on_the_way_a_round_comes_to_it() {
        let pieces = [(Part::Weapon, Point::new(101.0, 3.0), false)];
        let marks = [(Point::new(98.0, 3.2), "ricochet", 0.6), (Point::new(98.1, 2.9), "dent", 0.25), (Point::new(101.2, 3.1), "hole", 0.4),
            (Point::new(103.0, 3.0), "dent", 0.0), (Point::new(98.0, 1.0), "dent", 0.0), (Point::new(100.5, 3.0), "burn", 0.2)];
        let middle = Point::new(100.0, 2.0);
        // From the left, the face before the gun and the gun itself, at its height: not the far side, not below. A
        // ricochet counts half a round stopped, a dent a quarter through three quarters.
        let left = aims(middle, 0.0, &pieces, &marks);
        assert_eq!((left[0].part, left[0].holes, left[0].stopped), (Part::Weapon, 1, 1.25));
        assert_eq!((left[0].offset.x, left[0].offset.y), (1.0, 1.0));
        assert_eq!((left[1].part, left[1].holes, left[1].stopped), (Part::Hull, 0, 0.0));
        // From the right, the far face is the near one: a dent that went nowhere counts whole.
        let right = aims(middle, 200.0, &pieces, &marks);
        assert_eq!((right[0].holes, right[0].stopped), (1, 1.0));
    }
    #[test]
    fn a_tank_out_in_the_open_is_worth_a_round_before_the_hull_and_a_load_after_it() {
        let worth = |part| Aim { part, offset: Point::ZERO, disabled: false, holes: 0, stopped: 0.0 }.worth();
        let order = [Part::Weapon, Part::Sensor, Part::Fuel, Part::Hull, Part::Cargo, Part::Gear].map(worth);
        assert!(order.windows(2).all(|pair| pair[0] > pair[1]), "{order:?}");
    }
    #[test]
    fn indirect_fire_chooses_an_allowed_high_arc_over_observed_cover() {
        let mut scene = Scene::new();
        scene.modules[0].weapon_preset = "m119".into();
        scene.modules[0].pose.angle = PI/2.0;
        scene.modules[1].ammo_preset = "m119".into();
        scene.catalogue["m119"].as_object_mut().unwrap().extend(json!({"family":"howitzer","allowedAmmo":["he"],"charges":[{"value":0.25},{"value":0.6},{"value":1}],
            "speed":110,"rate":6,"power":410,"mass":8,"caliberMm":105,"barrel":1.6,"radius":0.05,"blastRadius":5.2,"spread":0.13,"life":45}).as_object().unwrap().clone());
        let mut ground = Ground::flat();
        ground.ridge = true;
        ground.ridge_height = 85.0;
        let decision = scene.run(&mut PilotState::default(), &mut ground);
        assert_eq!(decision.diagnostics["viableShots"], 1);
        assert_eq!(decision.action["trajectory"], "high");
        assert!([0.25, 0.6, 1.0].contains(&decision.action["charge"].as_f64().unwrap()));
        assert_eq!(decision.action["ammo"], "he");
        assert_eq!(decision.action["fire"], false);
        assert_eq!(decision.diagnostics["reason"], "servo-aligning");
        let bearing=decision.action["aimAngle"].as_f64().unwrap();
        scene.modules[0].barrel_angle=bearing+0.2*PI/180.0;
        assert_eq!(scene.run(&mut PilotState::default(),&mut ground).action["fire"],false);
        scene.modules[0].barrel_angle=bearing+0.05*PI/180.0;
        assert_eq!(scene.run(&mut PilotState::default(),&mut ground).action["fire"],true);
        // At a longer range the existing target-sized angular window is smaller than the family cap.
        scene.contacts[0].contact.x=750.0;
        let distant=scene.run(&mut PilotState::default(),&mut ground);
        assert_eq!(distant.diagnostics["viableShots"],1);
        scene.modules[0].barrel_angle=distant.action["aimAngle"].as_f64().unwrap()+0.099*PI/180.0;
        let held=scene.run(&mut PilotState::default(),&mut ground);
        assert_eq!(held.action["fire"],false);assert_eq!(held.diagnostics["reason"],"servo-aligning");
    }
    #[test]
    fn a_pilot_holds_its_place_even_driving_fast_at_the_end_of_the_arena() {
        let mut scene = Scene::new();
        scene.contacts.clear();
        let v = scene.actor.vehicle.as_mut().unwrap();
        v.x = 780.0;
        v.vx = 12.0;
        scene.actor.x = 780.0;
        scene.actor.bounds.min_x = 777.0;
        scene.actor.bounds.max_x = 783.0;
        let decision = scene.run(&mut PilotState::default(), &mut Ground::flat());
        assert_eq!(decision.action["throttle"], 0.0);
        assert_eq!(decision.action["brake"], 1.0);
    }
}
