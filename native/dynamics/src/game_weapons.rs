//! Weapon admission and ballistic solutions.
use serde::{Deserialize, Serialize};
use crate::game_geometry::{BARREL_REACH, Point, atan2, cos, hypot, number, sin, sqrt};
use crate::game_flight::{Drag, FLIGHT_HORIZON, FlightState, ShotLaunch, farthest, required, required_point};
use serde_json::{Value, json};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use std::cell::RefCell;
use std::collections::HashMap;
use std::f64::consts::{FRAC_PI_2, FRAC_PI_4, PI};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MuzzleProfile {
    pub radius: f64,
    pub barrel: f64,
}
impl MuzzleProfile {
    fn from_value(value: &Value) -> Result<Self, String> {
        Ok(Self {radius:required(value,"radius")?.clamp(0.001,0.12),
            barrel:required(value,"barrel")?.clamp(BARREL_REACH.0,BARREL_REACH.1)})
    }
}
fn weapon_source<'a>(catalogue: &'a Value, preset: &str, family: Option<&str>) -> Result<&'a Value, String> {
    let key = if preset=="custom" {family.ok_or("Custom weapon requires a family")?} else {preset};
    catalogue.get(key).filter(|v|v.is_object()).ok_or_else(||format!("Unknown weapon {key}"))
}

/// What one round of a weapon weighs, takes up and costs when it is fed `ammo`: the round's own where it states
/// them, and otherwise the weapon's cartridge.
pub fn cartridge(weapon: &Value, ammo: &str) -> Value {
    let mut whole = weapon["cartridge"].clone();
    if let (Some(base), Some(own)) = (whole.as_object_mut(), weapon["rounds"][ammo]["cartridge"].as_object()) {
        for (key, value) in own {
            base.insert(key.clone(), value.clone());
        }
    }
    whole
}
/// The rounds a weapon may be fed: armour-piercing, high-explosive, long rod and shaped charge.
pub fn known_ammo(name: &str) -> bool {
    matches!(name, "ap" | "he" | "apfsds" | "heat")
}
/// The fastest round a gun may fire: the gas of its charge, which must move itself as well as the round, pushes none much
/// past 2 km/s, as a long-rod penetrator leaves a long tank gun at full charge.
pub const MAX_MUZZLE_SPEED: f64 = 2100.0;
/// Rounds a minute with the trigger held: the fastest rotary gun turns its barrels up to six thousand (M134).
pub const MAX_RATE: f64 = 6000.0;
/// The maximum laying error for assisted fire. The pilot may require a smaller error.
pub const SERVO_FIRE_TOLERANCE: f64 = PI / 180.0;
pub fn servo_fire_tolerance(family: &str) -> f64 {
    if matches!(family, "mortar" | "howitzer") { SERVO_FIRE_TOLERANCE / 10.0 } else { SERVO_FIRE_TOLERANCE }
}
/// The speed and drag of one round: its own, where the catalogue states them
/// beside the weapon's, and otherwise the weapon's.
fn round_flight(source:&Value,weapon:&Value,ammo:&str,mass:f64,caliber_mm:f64,family:&str)->Result<(f64,Drag),String> {
    let round=&source["rounds"][ammo];
    let stated=|key:&str| round[key].as_f64().or_else(||weapon[key].as_f64()).filter(|x|x.is_finite());
    Ok((stated("speed").ok_or("Finite speed is required")?.clamp(60.0,MAX_MUZZLE_SPEED),
        Drag::admit(mass,caliber_mm,family,stated("drag"))?))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct Settings {
    pub value: Value,
    pub family: String,
    pub preset: String,
    pub ammo: String,
    pub component: Option<u32>,
    pub mounted: bool,
    pub aim_angle: Option<f64>,
    pub speed: f64,
    pub rate: f64,
    pub spread: f64,
    pub power: f64,
    pub mass: f64,
    pub caliber_mm: f64,
    pub drag: Drag,
    pub radius: f64,
    pub barrel: f64,
    pub blast_radius: f64,
    pub recoil: f64,
    pub life: f64,
    pub charge: f64,
    pub charges: Vec<f64>,
    pub automatic: bool,
    pub trajectory: String,
    pub airburst: bool,
    /// Of a shell made otherwise than its reference's (game_variant.rs `made`), the share of its burst its fragments
    /// carry and how far, in radii of its burst, they fly (game_pressure.rs `explode`).
    #[serde(default)]
    pub fragments: Option<(f64, f64)>,
    pub fuze: f64,
    pub powered: bool,
    // A recorded pilot decision keeps its chosen bearing/fuze, but rechecks laying when the round leaves.
    // Derived only from the admitted input phase; never read from client weapon settings.
    pub requires_alignment: bool,
}
impl Settings {
    pub fn servo_fire_tolerance(&self) -> f64 {
        if self.aim_angle.is_none() || self.requires_alignment { servo_fire_tolerance(&self.family) } else { SERVO_FIRE_TOLERANCE }
    }
    pub fn admit(
        catalogue: &Value,
        config: &Value,
        component: Option<u32>,
        fixed: bool,
    ) -> Result<Self, String> {
        let preset = config["preset"].as_str().ok_or("Missing weapon preset")?;
        let source = weapon_source(catalogue, preset, config["id"].as_str())?;
        let mut v = source.clone();
        for key in [
            "platform",
            "componentId",
            "aimAngle",
            "fuzeTime",
            "charge",
            "trajectory",
            "detonation",
        ] {
            if let Some(x) = config.get(key) {
                v[key] = x.clone();
            }
        }
        if !fixed {
            for key in [
                "speed", "rate", "spread", "power", "mass", "radius", "barrel",
            ] {
                if let Some(x) = config.get(key) {
                    v[key] = x.clone();
                }
            }
        }
        let feed = source["allowedAmmo"].as_array().filter(|f|!f.is_empty() && f.iter().all(|a|a.as_str().is_some_and(known_ammo)))
            .ok_or("Invalid weapon ammunition feed")?;
        let requested_ammo = config.get("ammo").map(|a|a.as_str().ok_or("Invalid weapon ammunition"))
            .transpose()?;
        let ammo = requested_ammo.unwrap_or(feed[0].as_str().expect("admitted feed"));
        if !feed.iter().any(|a|a==ammo) {return Err("Unavailable weapon ammunition".into());}
        let ammo=ammo.to_owned();
        // A round states what it strikes with, how far it bursts, what it weighs in flight and its fragments, where it
        // differs from the weapon's first.
        for key in ["power","blastRadius","mass"] {
            if let Some(x)=source["rounds"][&ammo].get(key) {
                if fixed || config.get(key).is_none() {v[key]=x.clone();}
            }
        }
        let levels=source["charges"].as_array().filter(|a|!a.is_empty() && a.len()<=7)
            .ok_or("Weapon requires 1..7 propellant levels")?;
        let charges=levels.iter().map(|level|required(level,"value").and_then(|x|
            if x>0.0 && x<=1.0 {Ok(x)}else{Err("Invalid propellant level".into())}))
            .collect::<Result<Vec<_>,_>>()?;
        let bearing = v["aimAngle"]
            .as_f64()
            .filter(|x| x.is_finite())
            .map(normalize_angle);
        let requested = v["charge"].as_f64().unwrap_or(1.0);
        let automatic = bearing.is_none()
            && charges.len() > 1
            && (v["charge"] == "auto"
                || !config.get("charge").is_some() && source["defaultCharge"] == "auto");
        let charge = *charges
            .iter()
            .min_by(|a, b| (*a - requested).abs().total_cmp(&(*b - requested).abs()))
            .unwrap_or(&1.0);
        let muzzle = MuzzleProfile::from_value(&v)?;
        let family = if preset=="custom" {config["id"].as_str().ok_or("Missing custom weapon family")?}
            else {source["family"].as_str().ok_or("Missing weapon family")?};
        let mass = required(&v, "mass")?.clamp(0.005, 60.0);
        let caliber_mm = required(&v,"caliberMm")?;
        let (speed,drag) = round_flight(source,&v,&ammo,mass,caliber_mm,family)?;
        let s = Self {
            value: Value::Null,
            family: family.into(),
            preset: preset.into(),
            ammo,
            component,
            mounted: v["platform"] == "vehicle",
            aim_angle: bearing,
            requires_alignment: false,
            speed,
            rate: required(&v,"rate")?.clamp(4.0,MAX_RATE),
            spread: required(&v,"spread")?.clamp(0.0,3.0),
            power: required(&v,"power")?.clamp(10.0,1500.0),
            mass,
            caliber_mm,
            drag,
            radius: muzzle.radius,
            barrel: muzzle.barrel,
            blast_radius: required(&v,"blastRadius")?,
            recoil: if family == "rocket" { 0.04 } else { 1.05 },
            life: required(&v,"life")?.clamp(0.05,FLIGHT_HORIZON),
            charge,
            charges,
            automatic,
            trajectory: v["trajectory"].as_str().unwrap_or("direct").into(),
            airburst: feed.iter().any(|x|x=="he")
                && v["detonation"] == "airburst",
            fuze: number(&v, "fuzeTime", 1.0),
            fragments: None,
            powered: v["poweredTrail"] == true,
        };
        let mut s = s;
        s.airburst = s.airburst && s.ammo == "he";
        // The weapon states its first round's fragments, and a round of another kind its own.
        let stated = if s.ammo == feed[0].as_str().unwrap_or_default() { source } else { &source["rounds"][&s.ammo] };
        s.fragments = stated["fragments"].as_f64().zip(stated["fragmentReach"].as_f64())
            .filter(|(share, reach)| share.is_finite() && reach.is_finite() && *share > 0.0 && *reach > 0.0)
            .map(|(share, reach)| (share.clamp(0.05, 0.95), reach.clamp(0.1, 4.0)));
        s.value = json!({"id":s.family,"preset":s.preset,"ammo":s.ammo,"speed":s.speed,"rate":s.rate,
            "spread":s.spread,"power":s.power,"mass":s.mass,"radius":s.radius,"barrel":s.barrel,
            "platform":if s.mounted{"vehicle"}else{"ground"},"componentId":config["componentId"],
            "trajectory":s.trajectory,"charge":if s.automatic{json!("auto")}else{json!(s.charge)},
            "charges":source["charges"],"variableCharge":s.charges.len()>1,"life":s.life,"blastRadius":s.blast_radius,
            "detonation":if s.airburst{"airburst"}else{"impact"},"poweredTrail":s.powered,"recoilFactor":s.recoil,
            "caliberMm":s.caliber_mm,"drag":s.drag.cd,"flight":s.drag.to_value(s.mass,s.caliber_mm,&s.family)});
        if let Some(angle) = bearing {
            s.value["aimAngle"] = json!(angle);
            s.value["fuzeTime"] = json!(s.fuze.clamp(0.05, s.life));
        }
        Ok(s)
    }
    /// The speed and drag of another round this weapon feeds.
    pub fn round(&self, catalogue: &Value, ammo: &str) -> Result<(f64, Drag), String> {
        if ammo == self.ammo { return Ok((self.speed, self.drag)); }
        let source = weapon_source(catalogue, &self.preset, Some(&self.family))?;
        // What it weighs in flight: its own where it states it, the weapon's first's where this one states its own.
        let mass = match (source["rounds"][ammo]["mass"].as_f64(), source["rounds"][&self.ammo]["mass"].as_f64()) {
            (Some(own), _) => own,
            (None, Some(_)) => source["mass"].as_f64().unwrap_or(self.mass),
            (None, None) => self.mass,
        }.clamp(0.005, 60.0);
        round_flight(source, source, ammo, mass, self.caliber_mm, &self.family)
    }
}
/// The bore of an installed weapon, as its preset states it: how long the barrel and how wide
/// the round. Read once, when the weapon is admitted.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeaponSpec {
    pub barrel: f64,
    pub radius: f64,
}
impl WeaponSpec {
    pub fn from_catalogue(catalogue: &Value, preset: &str, servo_max_speed: f64) -> Result<Self, String> {
        if !servo_max_speed.is_finite() || servo_max_speed <= 0.0 {
            return Err("Invalid mounted servo rate".into());
        }
        let source = catalogue.get(preset).ok_or_else(|| format!("Unknown weapon {preset}"))?;
        let feed = source["allowedAmmo"].as_array().filter(|a| !a.is_empty()).ok_or("Missing weapon ammunition feed")?;
        if feed.iter().any(|a| !a.as_str().is_some_and(known_ammo)) {
            return Err("Invalid weapon ammunition feed".into());
        }
        let settings = Settings::admit(catalogue, &json!({"preset":preset}), None, true)?;
        Ok(Self { barrel: settings.barrel, radius: settings.radius })
    }
}
/// What keeps an arc from the point it was given.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Limit {
    None,
    /// No admitted charge carries that far.
    Range,
    /// A charge would, at an elevation outside the travel of the mount.
    Sector,
    /// A high arc would, steeper than the mount rises: the steepest it allows comes down beyond the point.
    Near,
}
/// The world bearings a mount allows its barrel: its axis and the travel to either side.
#[derive(Clone, Copy, Debug)]
pub struct Sector {
    pub axis: f64,
    pub min: f64,
    pub max: f64,
}
impl Sector {
    pub fn clamp(self, angle: f64) -> f64 {
        self.axis + angle_difference(angle, self.axis).clamp(self.min, self.max)
    }
    pub fn admits(self, angle: f64) -> bool {
        angle_difference(self.clamp(angle), angle).abs() < 1e-6
    }
}
#[derive(Clone, Copy)]
pub struct Muzzle {
    pub point: Point,
    pub angle: f64,
    pub speed: f64,
    pub charge: f64,
    pub time: f64,
    pub reachable: bool,
    pub limit: Limit,
    /// Unreachable: how far from the point the nearest shot lands.
    pub miss: f64,
}
// Re-admitting a recorded bearing must retain its exact bits. The libm
// projection is periodic, but atan2(sin(x), cos(x)) is not bit-idempotent.
fn normalize_angle(angle: f64) -> f64 {
    if (-PI..=PI).contains(&angle) {
        angle
    } else {
        atan2(sin(angle), cos(angle))
    }
}
pub fn angle_difference(a: f64, b: f64) -> f64 {
    normalize_angle(a - b)
}
pub fn muzzle_point(origin: Point, angle: f64, barrel: f64) -> Point {
    Point::new(
        origin.x + cos(angle) * barrel,
        origin.y + sin(angle) * barrel,
    )
}
pub fn launch_velocity(angle: f64, speed: f64) -> Point {
    Point::new(cos(angle) * speed, sin(angle) * speed)
}
#[cfg(test)]
fn solution(origin: Point, aim: Point, s: &Settings, actual: Option<f64>) -> Muzzle {
    solution_with_motion(origin,aim,s,actual,Point::ZERO,0.0,None)
}
/// The bearing, charge and flight of an arc to a point. The lowest charge
/// whose arc the mount can elevate to is the solution. With none, the gun
/// still gets a bearing: the nearest landing it can make, marked unreachable.
/// A bearing given, a direct shot and a point straight over the gun are told at once. An arc is
/// searched for, a flight for each arc and charge tried, and the arcs found lately are kept: every
/// servo asks again at every step, and one whose vehicle stands asks with the same numbers.
fn lay(origin:Point,aim:Point,s:&Settings,inherited:Point,omega:f64,sector:Option<Sector>)->Laid {
    if s.aim_angle.is_some() || s.trajectory == "direct" || (aim.x-origin.x).abs()<=0.02 {
        let angle = s.aim_angle.unwrap_or_else(|| atan2(aim.y-origin.y,aim.x-origin.x));
        return Laid { angle, charge: s.charge, speed: s.speed*sqrt(s.charge), reachable: true, limit: Limit::None, miss: 0.0, time: None };
    }
    // The automatic arc is the weapon's own — the high one of a mortar, the low one of the others — and, for a
    // place its mount lets no charge reach by that one, the other.
    let arcs: &[bool] = match s.trajectory.as_str() {
        "high" => &[true],
        "auto" if s.family == "mortar" => &[true, false],
        "auto" => &[false, true],
        _ => &[false],
    };
    let levels = if s.automatic {
        s.charges.as_slice()
    } else {
        std::slice::from_ref(&s.charge)
    };
    // Every number the search reads, bit for bit: asked the same, it finds the same arc.
    let mount = sector.map_or([f64::NAN; 3], |mount| [mount.axis, mount.min, mount.max]);
    let asked: Vec<u64> = [origin.x, origin.y, aim.x, aim.y, inherited.x, inherited.y, omega, mount[0], mount[1], mount[2],
        s.speed, s.barrel, s.drag.per_meter, s.charge].iter().map(|x| x.to_bits())
        .chain([sector.is_some() as u64, arcs[0] as u64 | (arcs.len() as u64) << 1])
        .chain(levels.iter().map(|x| x.to_bits())).collect();
    if let Some(laid) = FOUND.with(|found| found.borrow().get(&asked).copied()) {
        return laid;
    }
    let laid = search(origin, aim, s, inherited, omega, sector, arcs, levels);
    FOUND.with(|found| {
        let mut found = found.borrow_mut();
        if found.len() >= KEPT { found.clear(); }
        found.insert(asked, laid);
    });
    laid
}
/// How many arcs, and how many reaches, are kept. Past that many all are let go, and kept again as they are asked for.
const KEPT: usize = 2048;
thread_local! {
    /// The arcs searched for lately, by every number each search read (`lay`). Whether one is kept or
    /// searched for again, it is the same arc: the field that resumes, which keeps none, goes on as it was.
    static FOUND: RefCell<HashMap<Vec<u64>, Laid>> = RefCell::new(HashMap::new());
    /// How far a round reaches, by band of speed, of the height of its muzzle and of the height under it (`beyond_reach`).
    static REACHES: RefCell<HashMap<[u64; 4], f64>> = RefCell::new(HashMap::new());
}
#[cfg(test)]
thread_local! {
    /// The searches made and the arcs they flew, for the tests that bound what laying costs.
    static SEARCHED: std::cell::Cell<(usize, usize)> = const { std::cell::Cell::new((0, 0)) };
}
/// How much steeper than the vacuum rule the longest low arc may be, in radians: the air thins as a steep arc climbs, and
/// carries the fastest rounds furthest a little over 45° — a 155 mm shell at its top charge at 46.5° from sea level, and
/// steeper from higher up —, where a vacuum would carry them at 45° and drag alone lower.
const ALOFT: f64 = 10.0 * PI / 180.0;
/// Bands of launch speed, of the height of the muzzle over sea level and of the height under it that a reach is worked
/// out for, at the end of each that carries furthest: the fastest, the highest muzzle, in the thinnest air, and the
/// lowest point.
const REACH_SPEED: f64 = 2.0;
const REACH_HEIGHT: f64 = 128.0;
/// Whether the point is further off than any bearing of this launch can put a round at its height: an
/// arc to it would be searched for in vain. The round is taken as fast as the launch can make it — the
/// charge, the motion of the vehicle and its turn — leaving from anywhere on the barrel, and a little
/// further than the forecast takes it, for the roundings of the flight.
fn beyond_reach(shot: &ShotLaunch, aim: Point) -> bool {
    let speed = ((shot.speed + hypot(shot.inherited.x, shot.inherited.y) + shot.omega.abs() * shot.barrel) / REACH_SPEED).ceil() * REACH_SPEED;
    let altitude = ((shot.origin.y + shot.barrel) / REACH_HEIGHT).ceil().max(0.0) * REACH_HEIGHT + 0.0;
    let height = ((aim.y - shot.origin.y - shot.barrel) / REACH_HEIGHT).floor().min(0.0) * REACH_HEIGHT + 0.0;
    let band = [speed.to_bits(), altitude.to_bits(), height.to_bits(), shot.drag.per_meter.to_bits()];
    let reach = REACHES.with(|reaches| {
        if let Some(&reach) = reaches.borrow().get(&band) {
            return reach;
        }
        let reach = farthest(speed, altitude, height, shot.drag);
        let mut reaches = reaches.borrow_mut();
        if reaches.len() >= KEPT { reaches.clear(); }
        reaches.insert(band, reach);
        reach
    });
    (aim.x - shot.origin.x).abs() - shot.barrel > reach * 1.001 + 1.0
}
/// The search of `lay`: the arcs, and the charges of each, in their order, until one reaches the point.
/// A charge the point is beyond the reach of is not flown: it has no arc there. Where the mount refuses
/// the arc of a charge, the round that falls nearest is flown only when no arc is left at all.
/// A point no further from the trunnion than the muzzle is one the round leaves behind as it leaves the
/// barrel, and no flight meets it: the low arc lays the gun at it all the same, along the line of sight,
/// and the round goes that way. A high arc may still come down on it.
fn search(origin:Point,aim:Point,s:&Settings,inherited:Point,omega:f64,sector:Option<Sector>,arcs:&[bool],levels:&[f64])->Laid {
    #[cfg(test)]
    SEARCHED.with(|n| n.set((n.get().0 + 1, n.get().1)));
    let mut angle = atan2(aim.y-origin.y,aim.x-origin.x);
    let mut charge = s.charge;
    let mut speed = s.speed * sqrt(charge);
    let mut reachable = false;
    let mut limit = Limit::Range;
    let mut miss = 0.0;
    let launch=|speed| ShotLaunch {origin,speed,barrel:s.barrel,inherited,omega,life:FLIGHT_HORIZON,drag:s.drag};
    let mut solved_time=None;
    let high = arcs[0];
    let mut nearest: Option<(f64,f64,f64,f64)> = None;
    // The strongest charge with no arc to the point: the one that falls nearest it.
    let mut short: Option<f64> = None;
    let mut refused: Vec<(f64, f64, ShotLaunch)> = Vec::new();
    let inside = origin.distance(aim) <= s.barrel;
    for (&arc, level) in arcs.iter().flat_map(|arc| levels.iter().map(move |level| (arc, level))) {
        let shot = launch(s.speed * sqrt(*level));
        // The bearing of the arc, and its flight time when flying it told it.
        let hit = if inside && !arc {
            Some((atan2(aim.y-origin.y,aim.x-origin.x), None))
        } else if beyond_reach(&shot, aim) {
            None
        } else {
            #[cfg(test)]
            SEARCHED.with(|n| n.set((n.get().0, n.get().1 + 1)));
            shot.intercept(aim,Point::ZERO,arc).map(|hit| (hit.angle, Some(hit.time)))
        };
        let Some((bearing, time)) = hit else {
            if short.is_none_or(|best|*level>best) {short=Some(*level);}
            continue;
        };
        if sector.is_none_or(|mount| mount.admits(bearing)) {
            charge=*level; speed=shot.speed; angle=bearing; solved_time=time;
            reachable=true; limit=Limit::None;
            break;
        }
        // A high arc held flatter than it asks for comes down further off: the point is too near for it.
        let held = sector.map_or(bearing,|mount|mount.clamp(bearing));
        let near = arc && angle_difference(held,FRAC_PI_2).abs() > angle_difference(bearing,FRAC_PI_2).abs();
        limit = if near || limit == Limit::Near { Limit::Near } else { Limit::Sector };
        refused.push((*level, held, shot));
    }
    if !reachable {
        for (level, bearing, shot) in refused {
            let (distance,time) = shot.nearest(bearing,aim);
            if nearest.is_none_or(|(best,..)|distance<best) {
                nearest=Some((distance,level,bearing,time));
            }
        }
        // A charge that falls short is fired at its longest. In a vacuum that is half way between
        // the line of sight and the vertical; drag brings it lower, and the thin air a steep arc
        // climbs into higher again, by amounts only the flight itself tells. So the elevation is
        // searched for: from the line of sight up to `ALOFT` past the vacuum rule on a low arc,
        // from 45 degrees up on a high one, inside the travel of the mount. The barrel then stays
        // where the last arc in range left it as the aim runs on.
        if let Some(level) = short {
            let shot = launch(s.speed * sqrt(level));
            let sight = atan2(aim.y-origin.y,(aim.x-origin.x).abs());
            // A moving mount throws its round a little further at a steeper barrel.
            let drift = (hypot(inherited.x,inherited.y)/shot.speed).min(0.35);
            let (floor,ceiling) = if high {(FRAC_PI_4,FRAC_PI_2)} else {(sight,(FRAC_PI_4+sight*0.5+drift+ALOFT).min(FRAC_PI_2))};
            let travel = |elevation:f64| {
                let bearing = if aim.x>=origin.x {elevation} else {PI-elevation};
                sector.map_or(bearing,|mount|mount.clamp(bearing))
            };
            let (bearing,distance,time) = shot.closest(travel(floor),travel(ceiling),aim);
            if nearest.is_none_or(|(best,..)|distance<best) {
                nearest=Some((distance,level,bearing,time));
            }
        }
        if let Some((distance,level,bearing,time)) = nearest {
            charge=level; speed=s.speed*sqrt(level); angle=bearing; miss=distance; solved_time=Some(time);
        }
    }
    Laid { angle, charge, speed, reachable, limit, miss, time: solved_time }
}
/// An arc as it was found: the flight time only when finding it told it.
#[derive(Clone, Copy)]
struct Laid { angle: f64, charge: f64, speed: f64, reachable: bool, limit: Limit, miss: f64, time: Option<f64> }
/// Where a mount turns its barrel for an aim, and whether a shot from there reaches it: what a
/// servo asks at every step. The clock of a direct shot, told only by flying it, is not asked for.
pub fn laying(origin:Point,aim:Point,s:&Settings,inherited:Point,omega:f64,sector:Option<Sector>)->(f64,bool) {
    let laid=lay(origin,aim,s,inherited,omega,sector);
    (laid.angle,laid.reachable)
}
/// That arc as a shot: where the round leaves the barrel, and how long it flies. `actual` is
/// the bearing the barrel has instead of the one the arc asks for.
pub fn solution_with_motion(origin:Point,aim:Point,s:&Settings,actual:Option<f64>,inherited:Point,omega:f64,sector:Option<Sector>)->Muzzle {
    let Laid { angle, charge, speed, reachable, limit, miss, time: solved_time } = lay(origin,aim,s,inherited,omega,sector);
    let launch=|speed| ShotLaunch {origin,speed,barrel:s.barrel,inherited,omega,life:FLIGHT_HORIZON,drag:s.drag};
    let angle = actual.unwrap_or(angle);
    let point = muzzle_point(origin, angle, s.barrel);
    let time = if s.aim_angle.is_some() {
        s.fuze.clamp(0.05, s.life)
    } else {
        solved_time.filter(|_|actual.is_none()).unwrap_or_else(||if reachable {
            launch(speed).crossing_time(angle,aim.x)
        } else {
            launch(speed).nearest(angle,aim).1
        })
    };
    Muzzle {
        point,
        angle,
        speed,
        charge,
        time,
        reachable,
        limit,
        miss,
    }
}

/// Small cold JSON façade; the simulation uses typed states.
pub fn flight_request(r:&Value)->Result<Value,String> {
    match r["op"].as_str().ok_or("Ballistic operation is required")? {
        "solution"|"mounted" => {
            let raw=&r["settings"];
            if required(raw,"mass")?<=0.0 {return Err("Positive physical mass is required".into());}
            let family=raw["id"].as_str().ok_or("Weapon id is required")?;
            let preset=raw["preset"].as_str().ok_or("Weapon preset is required")?;
            let mut source=raw.clone();
            source["family"]=json!(family);
            source["allowedAmmo"]=json!([raw["ammo"].as_str().ok_or("Weapon ammunition is required")?]);
            let mut catalogue=json!({});catalogue[if preset=="custom"{family}else{preset}]=source;
            let mut config=raw.clone();config["preset"]=json!(preset);
            let s=Settings::admit(&catalogue,&config,None,true)?;
            let origin=required_point(&r["launcher"])?;
            let aim=required_point(&r["aim"])?;
            let inherited=if r["inherited"].is_null(){Point::ZERO}else{required_point(&r["inherited"])?};
            let omega=if r["inherited"]["omega"].is_null(){0.0}else{required(&r["inherited"],"omega")?};
            let actual=if r["op"]=="mounted" {Some(required(&r["launcher"],"barrelAngle")?)} else {None};
            // A launcher on a mount brings the travel of that mount with it.
            let mount=&r["launcher"]["weaponMount"];
            let sector=if mount.is_null() {None} else {
                Some(Sector {axis:required(&r["launcher"],"angle")?,min:required(mount,"min")?,max:required(mount,"max")?})
            };
            let m=solution_with_motion(origin,aim,&s,actual,inherited,omega,sector);
            let launch=ShotLaunch {origin,speed:m.speed,barrel:s.barrel,inherited,omega,life:FLIGHT_HORIZON,drag:s.drag};
            let initial=launch.initial(m.angle);
            if !initial.velocity.x.is_finite() || !initial.velocity.y.is_finite()
                || initial.velocity.x.abs()>10000.0 || initial.velocity.y.abs()>10000.0 {
                return Err("Invalid physical flight state".into());
            }
            let flight_limit=if s.airburst {m.time.min(FLIGHT_HORIZON)}else{FLIGHT_HORIZON};
            let time=m.time.min(flight_limit);
            let trajectory=crate::game_flight::Trajectory::new(initial,time,s.drag);
            let apex=trajectory.states[..trajectory.len].iter().map(|s|s.point.y).fold(initial.point.y,f64::max);
            Ok(json!({"x":m.point.x,"y":m.point.y,"angle":m.angle,
                "vx":initial.velocity.x,"vy":initial.velocity.y,"speed":m.speed,"charge":m.charge,
                "time":time,"reachable":m.reachable,"distance":origin.distance(aim),"target":aim.to_value(),"apex":apex,
                "limit":match m.limit {Limit::None=>Value::Null,Limit::Range=>json!("range"),Limit::Sector=>json!("sector"),Limit::Near=>json!("near")},"miss":m.miss,
                "flightLimit":flight_limit,"flight":s.drag.to_value(s.mass,s.caliber_mm,&s.family)}))
        },
        "point"|"path" => {
            let value=&r["solution"];
            let drag=Drag::from_value(&value["flight"])?;
            let initial=FlightState::new(required_point(value)?,Point::new(required(value,"vx")?,required(value,"vy")?));
            if initial.velocity.x.abs()>10000.0 || initial.velocity.y.abs()>10000.0
                || required(&value["flight"],"mass")?<1e-9 {
                return Err("Invalid physical flight state".into());
            }
            let limit=required(value,"flightLimit")?;
            if !(0.0..=FLIGHT_HORIZON).contains(&limit) {
                return Err("Flight lifetime/fuze must be within the flight horizon".into());
            }
            let end=if r["op"]=="point" {required(r,"time")?}
                else if r["endTime"].is_null(){required(value,"time")?}else{required(r,"endTime")?};
            if !(0.0..=FLIGHT_HORIZON).contains(&end) || end>limit+1e-12 {return Err("Flight time exceeds the admitted lifetime/fuze".into());}
            if r["op"]=="point" {return Ok(initial.at(end,drag).to_value(end));}
            let count=r["count"].as_u64().filter(|n| (1..=512).contains(n)).ok_or("Path count must be an integer in 1..512")? as usize;
            let mut values=Vec::with_capacity(count+1); values.push(initial.to_value(0.0));
            let trajectory=crate::game_flight::Trajectory::new(initial,end,drag);
            for i in 1..=count {let time=end*i as f64/count as f64;
                values.push(trajectory.sample(time).to_value(time));}
            Ok(json!(values))
        },
        _=>Err("Unknown ballistic operation".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn cannon_catalogue() -> Value {
        json!({"cannon":crate::game_damage::fixtures::catalogue()["rh120"]})
    }
    #[test]
    fn an_aim_past_the_range_keeps_the_longest_arc_the_drag_allows() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let origin=Point::new(0.0,2.0);
        for (preset,trajectory) in [("m777","low"),("m119","low"),("mk19","low"),("m252","high")] {
            let s=Settings::admit(catalogue,&json!({"preset":preset,"platform":"vehicle","trajectory":trajectory,"charge":1.0}),None,true).unwrap();
            let at=|x:f64| solution(origin,Point::new(x,0.0),&s,None);
            let (mut near,mut far)=(20.0,200000.0);
            for _ in 0..50 {let mid=(near+far)*0.5;if at(mid).reachable {near=mid;}else{far=mid;}}
            let last=at(near-0.01);
            assert!(last.reachable && last.limit==Limit::None && last.miss==0.0,"{preset}");
            for beyond in [0.1,10.0,1000.0,50000.0] {
                let m=at(near+beyond);
                assert!(!m.reachable && m.limit==Limit::Range,"{preset} +{beyond}");
                // The round still falls where the range ends, and the barrel stays where the last arc in range left it.
                assert!((m.miss-beyond).abs()<0.05,"{preset} +{beyond}: {}",m.miss);
                assert!(angle_difference(m.angle,last.angle).abs()<0.3_f64.to_radians(),"{preset} +{beyond}: {}",m.angle.to_degrees());
                // To the other side, the same arc mirrored.
                let left=solution(origin,Point::new(-near-beyond,0.0),&s,None);
                assert!((left.miss-m.miss).abs()<1e-3 && angle_difference(left.angle,PI-m.angle).abs()<1e-4,"{preset} +{beyond}");
            }
            // The longest low arc is not at the 45 degrees of a vacuum, which falls short of it: drag brings it under
            // that, well under for the slower rounds, and the thin air a steep arc climbs into over it again — a little
            // past it for the 155 mm shell.
            if trajectory=="low" {
                let shot=ShotLaunch {origin,speed:s.speed,barrel:s.barrel,inherited:Point::ZERO,omega:0.0,life:FLIGHT_HORIZON,drag:s.drag};
                let aim=Point::new(near+100.0,0.0);
                let longest=at(aim.x).angle;
                assert!(if preset=="m777" {longest>FRAC_PI_4+0.01} else {longest<FRAC_PI_4-0.02},"{preset}: {}",longest.to_degrees());
                assert!(shot.nearest(FRAC_PI_4,aim).0>at(aim.x).miss+10.0,"{preset}");
            }
        }
        // A mount that cannot elevate to the longest arc holds the end of its travel.
        let s=Settings::admit(catalogue,&json!({"preset":"m777","platform":"vehicle","trajectory":"low","charge":1.0}),None,true).unwrap();
        let mount=Sector {axis:0.0,min:-0.1,max:0.35};
        let held=solution_with_motion(origin,Point::new(60000.0,0.0),&s,None,Point::ZERO,0.0,Some(mount));
        assert!(!held.reachable && held.limit==Limit::Range && (held.angle-0.35).abs()<1e-12 && held.miss>100.0);
    }

    #[test]
    fn an_aim_by_the_muzzle_is_met_and_one_short_of_it_is_fired_at_along_the_line_of_sight() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let origin=Point::new(0.0,2.0);
        for preset in ["m2hb","m242","rh120","mk19","m119"] {
            let s=Settings::admit(catalogue,&json!({"preset":preset,"platform":"vehicle","trajectory":"low","charge":1.0}),None,true).unwrap();
            for degrees in [-40.0_f64,-5.0,0.0,12.0,60.0,170.0,-160.0] {
                let bearing=degrees.to_radians();
                let along=|reach:f64| Point::new(origin.x+cos(bearing)*reach,origin.y+sin(bearing)*reach);
                // Past the muzzle by less than the round flies in a millisecond, moving or not: its arc meets the aim.
                for past in [1e-4,0.02,0.3,s.speed*0.001] {
                    for (inherited,omega) in [(Point::ZERO,0.0),(Point::new(18.0,-1.0),0.3),(Point::new(-12.0,0.5),-0.2)] {
                        let aim=along(s.barrel+past);
                        let m=solution_with_motion(origin,aim,&s,None,inherited,omega,None);
                        assert!(m.reachable && m.limit==Limit::None && m.miss==0.0,"{preset} {degrees} {past}");
                        let shot=ShotLaunch {origin,speed:m.speed,barrel:s.barrel,inherited,omega,life:FLIGHT_HORIZON,drag:s.drag};
                        assert!(shot.initial(m.angle).at(m.time,s.drag).point.distance(aim)<1e-6,"{preset} {degrees} {past}");
                    }
                }
                // Short of the muzzle no round meets it: the gun is laid at it, and its round goes that way.
                for share in [0.05,0.5,0.999] {
                    let m=solution_with_motion(origin,along(s.barrel*share),&s,None,Point::ZERO,0.0,None);
                    assert!(m.reachable && m.limit==Limit::None,"{preset} {degrees} {share}");
                    assert!(angle_difference(m.angle,bearing).abs()<1e-12,"{preset} {degrees} {share}");
                }
            }
        }
        // A mount that does not rise to a near aim says so, short of the muzzle or past it, and holds the end of its travel.
        let s=Settings::admit(catalogue,&json!({"preset":"m2hb","platform":"vehicle","trajectory":"low","charge":1.0}),None,true).unwrap();
        let mount=Sector {axis:0.0,min:-0.2,max:0.35};
        for aim in [Point::new(0.4,2.6),Point::new(1.0,3.2)] {
            let m=solution_with_motion(origin,aim,&s,None,Point::ZERO,0.0,Some(mount));
            assert!(!m.reachable && m.limit==Limit::Sector && (m.angle-0.35).abs()<1e-12,"{aim:?}");
        }
    }

    #[test]
    fn a_high_arc_steeper_than_its_mount_rises_is_too_near_and_a_flat_shot_out_of_its_travel_is_not() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let origin=Point::new(0.0,2.0);
        // A mortar laid 45 degrees up rises to 79: its steepest arc comes down a couple of hundred metres off.
        for (axis,side) in [(FRAC_PI_4,1.0),(PI-FRAC_PI_4,-1.0)] {
            let mount=Sector {axis,min:-0.6,max:0.6};
            for trajectory in ["high","auto"] {
                let s=Settings::admit(catalogue,&json!({"preset":"m252","platform":"vehicle","trajectory":trajectory,"charge":"auto"}),None,true).unwrap();
                let at=|distance:f64| solution_with_motion(origin,Point::new(side*distance,0.0),&s,None,Point::ZERO,0.0,Some(mount));
                for distance in [0.5,5.0,60.0] {
                    let m=at(distance);
                    let steepest=if side>0.0 {axis+0.6} else {axis-0.6};
                    assert!(!m.reachable && m.limit==Limit::Near,"{trajectory} {side} {distance}");
                    assert!(angle_difference(m.angle,steepest).abs()<1e-12 && m.miss>50.0,"{trajectory} {side} {distance}: {} {}",m.angle,m.miss);
                }
                // Further off the steep arcs reach it, and past the strongest charge it is out of range.
                assert!(at(1500.0).reachable,"{trajectory} {side}");
                assert_eq!(at(20000.0).limit,Limit::Range,"{trajectory} {side}");
            }
        }
        // A flat-fire gun aimed below the travel of its mount cannot point there: that is its sector, near or far.
        let s=Settings::admit(catalogue,&json!({"preset":"m2hb","platform":"vehicle","trajectory":"low","charge":1.0}),None,true).unwrap();
        let mount=Sector {axis:0.0,min:-0.2,max:0.35};
        for aim in [Point::new(0.3,1.6),Point::new(3.0,0.0),Point::new(300.0,-200.0)] {
            assert_eq!(solution_with_motion(origin,aim,&s,None,Point::ZERO,0.0,Some(mount)).limit,Limit::Sector,"{aim:?}");
        }
    }

    #[test]
    fn the_automatic_arc_takes_the_other_where_the_mount_refuses_its_own() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let origin=Point::new(0.0,2.0);
        let reach=|preset:&str,trajectory:&str,mount:Sector| {
            let s=Settings::admit(catalogue,&json!({"preset":preset,"platform":"vehicle","trajectory":trajectory,"charge":"auto"}),None,true).unwrap();
            (1..=100).map(|i| solution_with_motion(origin,Point::new(i as f64*50.0,0.0),&s,None,Point::ZERO,0.0,Some(mount)))
                .map(|m| (m.reachable,m.angle)).collect::<Vec<_>>()
        };
        let holes=|r:&[(bool,f64)]| {
            let (first,last)=(r.iter().position(|x|x.0).unwrap(),r.iter().rposition(|x|x.0).unwrap());
            r[first..=last].iter().filter(|x|!x.0).count()
        };
        // A mortar on a plate leaning forward rises to no steep arc: by the high one alone each charge reaches a
        // narrow band, and the places between are out of reach.
        let leaning=Sector {axis:0.5,min:-0.6,max:0.6};
        let (high,auto)=(reach("m252","high",leaning),reach("m252","auto",leaning));
        assert!(holes(&high)>10,"{}",holes(&high));
        assert_eq!(holes(&auto),0);
        assert!(high.iter().zip(&auto).all(|(h,a)| !h.0 || a.0 && (h.1-a.1).abs()<1e-9),"where the high arc reaches, it is the one");
        // Upright, the automatic arc of a mortar is the high one, and that of a howitzer the low one.
        let upright=Sector {axis:FRAC_PI_2,min:-0.6,max:0.6};
        assert_eq!(reach("m252","auto",upright),reach("m252","high",upright));
        let level=Sector {axis:0.3,min:-0.4,max:0.9};
        assert_eq!(reach("m119","auto",level),reach("m119","low",level));
    }

    // The searches made and the arcs they flew since this was last asked.
    fn searched() -> (usize, usize) {
        SEARCHED.with(|n| n.replace((0, 0)))
    }
    fn forget() {
        FOUND.with(|found| found.borrow_mut().clear());
        REACHES.with(|reaches| reaches.borrow_mut().clear());
    }
    fn bits(laid: &Laid) -> [u64; 8] {
        [laid.angle.to_bits(), laid.charge.to_bits(), laid.speed.to_bits(), laid.reachable as u64, laid.limit as u64,
            laid.miss.to_bits(), laid.time.is_some() as u64, laid.time.unwrap_or(0.0).to_bits()]
    }
    #[test]
    fn no_charge_is_flown_at_a_point_beyond_its_reach() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        for (preset,trajectory) in [("m777","auto"),("m119","auto"),("m252","auto"),("m224","high"),("mk19","low")] {
            let s=Settings::admit(catalogue,&json!({"preset":preset,"platform":"vehicle","trajectory":trajectory,"charge":"auto"}),None,true).unwrap();
            let levels=if s.automatic {s.charges.clone()} else {vec![s.charge]};
            for (inherited,omega) in [(Point::ZERO,0.0),(Point::new(14.0,-0.6),0.25),(Point::new(-9.0,0.3),-0.4)] {
                for level in &levels {
                    let origin=Point::new(3.0,2.5);
                    let shot=ShotLaunch {origin,speed:s.speed*sqrt(*level),barrel:s.barrel,inherited,omega,life:FLIGHT_HORIZON,drag:s.drag};
                    for rise in [-300.0,-3.0,150.0] {
                        // Where, at that height, the charge stops being flown.
                        let (mut near,mut far)=(1.0,200000.0);
                        for _ in 0..40 {
                            let mid=(near+far)*0.5;
                            if beyond_reach(&shot,Point::new(origin.x+mid,origin.y+rise)) {far=mid;} else {near=mid;}
                        }
                        // There, to either side, no arc of it reaches the point.
                        for side in [1.0,-1.0] {
                            let aim=Point::new(origin.x+side*far,origin.y+rise);
                            assert!(beyond_reach(&shot,aim));
                            for arc in [false,true] {
                                assert!(shot.intercept(aim,Point::ZERO,arc).is_none(),"{preset} {level} {inherited:?} {rise} {side} {arc}: {far}");
                            }
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn a_search_flies_only_the_charges_that_reach_the_point() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let s=Settings::admit(catalogue,&json!({"preset":"m777","platform":"vehicle","trajectory":"auto","charge":"auto"}),None,true).unwrap();
        let (origin,front,roof)=(Point::new(0.0,2.0),Sector {axis:0.0,min:-0.2,max:0.5},Sector {axis:FRAC_PI_2,min:-0.6,max:0.6});
        let flown=|distance:f64,sector:Option<Sector>| {
            forget();searched();
            let laid=lay(origin,Point::new(distance,0.0),&s,Point::ZERO,0.0,sector);
            (searched().1,laid)
        };
        // At 17.2 km the fourth of five charges is the lowest that reaches, and the only one flown: the three
        // below it fall short, and the fifth comes after it.
        for sector in [None,Some(front)] {
            let (arcs,laid)=flown(17200.0,sector);
            assert_eq!((arcs,laid.charge,laid.reachable),(1,0.8,true));
        }
        // Beyond the reach of every charge none is flown; the longest shot is all that is searched for.
        for distance in [25000.0,60000.0] {
            let (arcs,laid)=flown(distance,Some(front));
            assert_eq!((arcs,laid.charge,laid.reachable,laid.limit),(0,1.0,false,Limit::Range));
        }
        // On a roof the low arc of the one charge that reaches at 22 km is flown and refused, and the high one
        // of it, too flat for the roof so near its reach, after it; none of a charge that falls short.
        let (arcs,laid)=flown(22000.0,Some(roof));
        assert_eq!((arcs,laid.reachable,laid.limit),(2,false,Limit::Sector));
        let (arcs,laid)=flown(15000.0,Some(roof));
        assert!(arcs<=5 && laid.reachable && laid.angle>FRAC_PI_4,"{arcs}");
    }
    #[test]
    fn an_arc_kept_is_the_one_searched_for_again_and_only_the_same_question_finds_it() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        for (preset,trajectory,charge) in [("m777","auto",json!("auto")),("m252","auto",json!("auto")),("m119","high",json!("auto")),("mk19","low",json!(1.0))] {
            let s=Settings::admit(catalogue,&json!({"preset":preset,"platform":"vehicle","trajectory":trajectory,"charge":charge}),None,true).unwrap();
            for (aim,inherited,omega,sector) in [
                (Point::new(450.0,-1.0),Point::ZERO,0.0,None),
                (Point::new(-3200.0,40.0),Point::new(2.5,-0.1),0.03,Some(Sector {axis:PI,min:-0.6,max:0.3})),
                (Point::new(9000.0,-120.0),Point::new(-0.4,0.05),-0.01,Some(Sector {axis:FRAC_PI_2,min:-0.6,max:0.6})),
                (Point::new(90000.0,0.0),Point::ZERO,0.0,Some(Sector {axis:0.1,min:-0.2,max:0.5})),
            ] {
                let origin=Point::new(1.25,2.875);
                let ask=|origin:Point,aim:Point,inherited:Point,omega:f64,sector:Option<Sector>| lay(origin,aim,&s,inherited,omega,sector);
                forget();searched();
                let first=ask(origin,aim,inherited,omega,sector);
                assert_eq!(searched().0,1);
                // Asked again, it is the arc kept; with none kept, and with not even the reaches, the one searched for again.
                assert_eq!(bits(&ask(origin,aim,inherited,omega,sector)),bits(&first));
                assert_eq!(searched(),(0,0));
                FOUND.with(|found| found.borrow_mut().clear());
                assert_eq!(bits(&ask(origin,aim,inherited,omega,sector)),bits(&first));
                forget();
                assert_eq!(bits(&ask(origin,aim,inherited,omega,sector)),bits(&first));
                assert_eq!(searched().0,2);
                // A question that differs by the last bit of any number is searched for anew.
                let next=|x:f64| f64::from_bits(x.to_bits()+1);
                let mut others=vec![(Point::new(next(origin.x),origin.y),aim,inherited,omega,sector),
                    (origin,Point::new(aim.x,next(aim.y)),inherited,omega,sector),(origin,aim,Point::new(next(inherited.x),inherited.y),omega,sector),
                    (origin,aim,inherited,next(omega),sector)];
                match sector {
                    Some(mount) => others.push((origin,aim,inherited,omega,Some(Sector {axis:next(mount.axis),..mount}))),
                    None => others.push((origin,aim,inherited,omega,Some(Sector {axis:0.0,min:-PI,max:PI}))),
                }
                for (origin,aim,inherited,omega,sector) in others {
                    ask(origin,aim,inherited,omega,sector);
                    assert_eq!(searched().0,1);
                }
            }
        }
    }
    // Four M777 on a dedicated ten-metre carrier. This fixture tests linked fire and arc reuse,
    // with explicit recoil clearance, independently of changing factory cab and turret proportions.
    fn battery() -> crate::NativeWorld {
        let cat=crate::game_damage::fixtures::full_catalogue();
        let mut design=json!({"version":crate::CONSTRUCTION_VERSION,"preset":"vehicle","name":"Bateria de ensaio",
            "chassis":{"model":"wheeled","points":[{"x":-100,"y":0},{"x":100,"y":0}],"thicknessMm":40,
                "gearScale":1.25/1.1,"topPlate":{"material":"steel","thicknessMm":15},"axles":[-78,-26,26,76]},
            "nodes":[],"plates":[],"components":[]});
        let deck=crate::game_construction::cell(crate::game_construction::factory_deck(&design,cat).unwrap()-1.3) as f64;
        for point in design["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(deck);}
        // The hull joins the 15 mm deck's centreline, 0.15 cells above the frame; 2.4 m of headroom holds the breeches.
        let floor=deck+0.15;
        design["nodes"]=json!([{"id":"a","x":-100,"y":floor},{"id":"b","x":100,"y":floor},
            {"id":"c","x":100,"y":floor+48.0},{"id":"d","x":-100,"y":floor+48.0}]);
        design["plates"]=json!([{"id":"hull:rear","a":"b","b":"c","material":"steel","thicknessMm":8},
            {"id":"hull:roof","a":"c","b":"d","material":"steel","thicknessMm":8},
            {"id":"hull:front","a":"d","b":"a","material":"steel","thicknessMm":8}]);
        for (kind,t) in [("engine",0.25),("fuel",0.5),("command",0.75),("ammo",0.1)] {
            let mut part=json!({"id":if kind=="ammo" {"weapon-ammo"}else{kind},"kind":kind});
            if kind=="ammo" {part["ammoPreset"]=json!("m777");}
            let height=crate::game_geometry::ComponentKind::from_name(kind).unwrap().dimensions().1;
            part["pose"]=json!({"x":100.0-200.0*t,"y":floor+0.15+height/0.1,"angle":0});
            design["components"].as_array_mut().unwrap().push(part);
        }
        let mut sensor=json!({"id":"sensor-0","kind":"sensor","sensorMode":"visual"});
        sensor["pose"]=crate::game_construction::part_on_plate(&design,cat,&sensor,"hull:rear",0.5).unwrap();
        design["components"].as_array_mut().unwrap().push(sensor);
        for (id,t) in [("weapon",0.2),("gun1",0.4),("gun2",0.6),("gun3",0.8)] {
            let placed=crate::game_construction::mount_on_plate(&design,cat,"hull:roof",t,"m777","elevated-trunnion",(0.35,0.5)).unwrap();
            design["components"].as_array_mut().unwrap().push(json!({"id":id,"kind":"weapon","weaponPreset":"m777","pose":placed["pose"],"mount":placed["mount"]}));
        }
        let scout=crate::game_templates::source("scout",&json!({"preset":"minimi","sensorModes":["visual"]}),cat).unwrap();
        crate::game_damage::fixtures::duel([&design,&scout],400.0)
    }
    // Lays the four guns of the battery on a point `distance` ahead of it, the trigger held or not.
    fn order(world: &mut crate::NativeWorld, kind: &str, distance: f64) {
        let input=json!({"type":kind,"phase":"before","platform":"vehicle","componentId":"local:weapon","active":kind=="trigger",
            "aim":{"x":distance-185.5,"y":0.0},"charge":"auto","trajectory":"auto",
            "also":[{"componentId":"local:gun1"},{"componentId":"local:gun2"},{"componentId":"local:gun3"}]});
        let said:Value=serde_json::from_str(&world.game_command_value(&json!({"op":"input","actorId":"local","input":input})).unwrap()).unwrap();
        assert_eq!(said["result"]["accepted"],true);
        assert_eq!(said["result"]["record"]["also"].as_array().unwrap().len(),3);
    }
    #[test]
    fn four_linked_howitzers_are_laid_again_only_when_something_moved_and_fire_alike_with_or_without_the_arcs_kept() {
        use std::hash::{Hash,Hasher};
        // Laid on a point 19.6 km off and left there ten seconds, then fired at one 15 km off for fifteen.
        let script=|world:&mut crate::NativeWorld,step:usize| {
            if step==0 {order(world,"aim",19600.0);}
            if step==600 {order(world,"trigger",15000.0);}
        };
        let print=|frame:&str| {let mut h=std::collections::hash_map::DefaultHasher::new();frame.hash(&mut h);h.finish()};
        let settled=|| {let mut world=battery();for _ in 0..120 {world.game_step(1.0/60.0).unwrap();}world};
        let mut kept=settled();
        forget();searched();
        let (mut prints,mut searches,mut state)=(Vec::new(),Vec::new(),Vec::new());
        for step in 0..1500 {
            if step==1000 {state=kept.export_state().unwrap();}
            script(&mut kept,step);
            prints.push(print(&kept.game_step(1.0/60.0).unwrap()));
            searches.push(searched().0);
        }
        // The command lays each gun once; standing, they are not laid again, however long the aim is held.
        assert_eq!(searches[0],4);
        assert_eq!(searches[1..600].iter().sum::<usize>(),0);
        // Firing rocks the vehicle: a gun is laid again at a step it moved, once, and once more for the round it fired.
        assert!(searches.iter().all(|n|*n<=8),"{:?}",searches.iter().max());
        let whole=kept.current_frame().unwrap();
        let frame:Value=serde_json::from_str(&whole).unwrap();
        assert!(frame["actors"][0]["stats"]["shots"].as_u64().unwrap()>=3,"{}",frame["actors"][0]["stats"]);
        // Laid with no arc kept from a step to the next, the field goes on bit for bit as it did.
        let mut fresh=settled();
        for (step,expected) in prints.iter().enumerate() {
            forget();
            script(&mut fresh,step);
            assert_eq!(print(&fresh.game_step(1.0/60.0).unwrap()),*expected,"step {step}");
        }
        // So does the field written out in the middle of the fire and taken back by a world that kept nothing.
        let mut resumed=battery();
        resumed.import_state(&state).unwrap();
        forget();
        for (step,expected) in prints.iter().enumerate().skip(1000) {
            script(&mut resumed,step);
            assert_eq!(print(&resumed.game_step(1.0/60.0).unwrap()),*expected,"step {step}");
        }
        assert_eq!(fresh.current_frame().unwrap(),whole);
        assert_eq!(resumed.current_frame().unwrap(),whole);
    }
    #[test]
    fn a_round_strikes_and_bursts_as_its_own_ammunition_does() {
        let catalogue=crate::game_damage::fixtures::catalogue();
        let fed=|ammo:&str|Settings::admit(catalogue,&json!({"preset":"rh120","platform":"vehicle","ammo":ammo}),None,true).unwrap();
        let (rod,shaped,shell)=(fed("apfsds"),fed("heat"),fed("he"));
        let round=&catalogue["rh120"]["rounds"];
        assert_eq!((rod.power,rod.blast_radius),(catalogue["rh120"]["power"].as_f64().unwrap(),catalogue["rh120"]["blastRadius"].as_f64().unwrap()));
        assert_eq!((shaped.power,shaped.blast_radius),(round["heat"]["power"].as_f64().unwrap(),round["heat"]["blastRadius"].as_f64().unwrap()));
        assert!(shaped.power<rod.power && shaped.speed<rod.speed);
        // A shell bursts with a power of its own: what the gun's rod pierces is not its burst.
        assert_eq!((shell.power,shell.blast_radius,shell.speed),(round["he"]["power"].as_f64().unwrap(),rod.blast_radius,shaped.speed));
        assert!(shell.power<rod.power);
        // A preset gun fires its round as the catalogue makes it, whatever the order says.
        let told=Settings::admit(catalogue,&json!({"preset":"rh120","platform":"vehicle","ammo":"heat","power":700,"blastRadius":5}),None,true).unwrap();
        assert_eq!((told.power,told.blast_radius),(shaped.power,shaped.blast_radius));
        // A gun is fed only what its catalogue allows.
        assert!(Settings::admit(catalogue,&json!({"preset":"rh120","platform":"vehicle","ammo":"ap"}),None,true).is_err());
    }
    #[test]
    fn a_sector_admits_the_bearings_of_its_mount_across_the_branch_cut() {
        let mount = Sector { axis: PI - 0.1, min: -0.3, max: 0.4 };
        assert!(mount.admits(PI - 0.4) && mount.admits(PI) && mount.admits(-PI + 0.3));
        assert!(!mount.admits(PI - 0.41) && !mount.admits(-PI + 0.31) && !mount.admits(0.0));
        assert!(angle_difference(mount.clamp(0.0), PI - 0.4).abs() < 1e-12);
        assert!(angle_difference(mount.clamp(-PI / 2.0), -PI + 0.3).abs() < 1e-12);
        assert_eq!(mount.clamp(PI - 0.2), PI - 0.2);
    }

    #[test]
    fn admitted_angle_preserves_canonical_boundaries_signed_zero_and_repetition() {
        let catalogue = cannon_catalogue();
        for angle in [
            -PI,
            -f64::from_bits(PI.to_bits() - 1),
            -0.0005527000175788998,
            -f64::from_bits(1),
            -0.0,
            0.0,
            f64::from_bits(1),
            0.123456789,
            f64::from_bits(PI.to_bits() - 1),
            PI,
        ] {
            assert_eq!(normalize_angle(angle).to_bits(), angle.to_bits());
            assert_eq!(angle_difference(angle, 0.0).to_bits(), angle.to_bits());
            let mut config = json!({"id":"cannon","preset":"cannon","aimAngle":angle});
            for _ in 0..64 {
                let admitted = Settings::admit(&catalogue, &config, None, true).unwrap();
                assert_eq!(admitted.aim_angle.unwrap().to_bits(), angle.to_bits());
                assert_eq!(admitted.value["aimAngle"].as_f64().unwrap().to_bits(), angle.to_bits());
                config = admitted.value;
            }
        }
        // This actual archived decision exposed F(F(x)) differing by one ULP.
        let archived = f64::from_bits(0xbf421c623fffffff);
        assert_eq!(archived, -0.0005527000175788998);
        assert_eq!(normalize_angle(archived).to_bits(), 0xbf421c623fffffff);
    }

    #[test]
    fn outside_angle_retains_the_libm_projection_and_then_is_exactly_idempotent() {
        for angle in [
            -f64::MAX,
            -12.5,
            -3.0 * PI,
            -f64::from_bits(PI.to_bits() + 1),
            f64::from_bits(PI.to_bits() + 1),
            3.0 * PI,
            12.5,
            f64::MAX,
        ] {
            assert!(!(-PI..=PI).contains(&angle));
            let legacy = atan2(sin(angle), cos(angle));
            let mut projected = normalize_angle(angle);
            assert_eq!(projected.to_bits(), legacy.to_bits());
            assert!(projected.is_finite() && (-PI..=PI).contains(&projected));
            for _ in 0..64 {
                projected = normalize_angle(projected);
                assert_eq!(projected.to_bits(), legacy.to_bits());
            }
        }
        assert_eq!(angle_difference(-0.0, 0.0).to_bits(), (-0.0f64).to_bits());
        assert_eq!(angle_difference(0.0, -0.0).to_bits(), 0.0f64.to_bits());
    }

    #[test]
    fn recorded_decisions_and_public_inputs_preserve_the_entire_native_frame() {
        let scout = crate::game_templates::source("scout", &json!({"preset":"minimi","sensorModes":["visual"]}),
            crate::game_damage::fixtures::full_catalogue()).unwrap();
        let mut native = crate::game_damage::fixtures::duel([&scout, &scout], 400.0);
        let mut public = crate::game_damage::fixtures::duel([&scout, &scout], 400.0);
        let component = native.game.as_ref().unwrap().damage.modules.iter()
            .find(|m|m.actor==1 && m.kind==crate::game_geometry::ComponentKind::Weapon)
            .unwrap().cold["id"].as_str().unwrap().to_owned();
        for step in 0..64 {
            let angle = match step % 8 {
                0 => -0.0005527000175788998,
                1 => -PI,
                2 => -0.0,
                3 => 0.0,
                4 => PI,
                5 => -12.5,
                6 => 12.5,
                _ => 0.123456789,
            };
            let decision = json!({"type":"controls","phase":"decision","platform":"vehicle","throttle":0.0,"brake":1.0,
                "aimAngle":angle,"aim":{"x":50.0 * cos(angle),"y":5.0 + 50.0 * sin(angle)},
                "fire":false,"componentId":component,"charge":1.0});
            let response: Value = serde_json::from_str(&native.game_command_value(
                &json!({"op":"input","actorId":"local","input":decision})
            ).unwrap()).unwrap();
            let record = &response["result"]["record"];
            assert_eq!(record["aimAngle"].as_f64().unwrap().to_bits(), normalize_angle(angle).to_bits());
            let replay: Value = serde_json::from_str(&public.game_command(
                &json!({"op":"input","actorId":"local","input":record}).to_string()
            ).unwrap()).unwrap();
            assert_eq!(replay["result"]["record"], *record);
            native.game_step(1.0 / 60.0).unwrap();
            public.game_step(1.0 / 60.0).unwrap();
            // Byte equality checks every cold field and signed zero, including
            // weapon/servo, damage, RNG, projectiles and events.
            assert_eq!(native.current_frame().unwrap(), public.current_frame().unwrap());
            let physics = json!({"op":"physics","contacts":true}).to_string();
            assert_eq!(native.game_command(&physics).unwrap(), public.game_command(&physics).unwrap());
        }
    }

    #[test]
    fn weapon_admission_requires_one_complete_catalogue_entry() {
        let current=cannon_catalogue();
        assert!(Settings::admit(&current,&json!({}),None,true).err().unwrap().contains("preset"));
        assert!(Settings::admit(&current,&json!({"preset":"missing","id":"cannon"}),None,true).is_err());
        assert!(Settings::admit(&current,&json!({"preset":"cannon","ammo":"unavailable"}),None,true).is_err());
        for field in ["radius","barrel","caliberMm","speed","rate","spread","power","mass","life","blastRadius","family","allowedAmmo","charges"] {
            let mut incomplete=current.clone();incomplete["cannon"].as_object_mut().unwrap().remove(field);
            assert!(Settings::admit(&incomplete,&json!({"preset":"cannon"}),None,true).is_err(),"{field}");
        }
        for (radius,barrel) in [(0.00001_f64,0.01_f64),(0.8,9.0),(0.06,1.8123456789)] {
            let mut catalogue=current.clone();catalogue["cannon"]["radius"]=json!(radius);catalogue["cannon"]["barrel"]=json!(barrel);
            let profile=MuzzleProfile::from_value(&catalogue["cannon"]).unwrap();
            let settings=Settings::admit(&catalogue,&json!({"preset":"cannon","radius":0.0123,"barrel":1.25}),Some(42),true).unwrap();
            assert_eq!(profile.radius.to_bits(),radius.clamp(0.001,0.12).to_bits());
            assert_eq!(profile.barrel.to_bits(),barrel.clamp(BARREL_REACH.0,BARREL_REACH.1).to_bits());
            assert_eq!(settings.radius.to_bits(),profile.radius.to_bits());
            assert_eq!(settings.barrel.to_bits(),profile.barrel.to_bits());
        }
        // A named custom configuration remains an explicit current operation;
        // it never serves as a fallback for an unknown catalogue preset.
        let custom=Settings::admit(&current,&json!({"preset":"custom","id":"cannon"}),None,false).unwrap();
        assert_eq!(custom.family,"cannon");assert_eq!(custom.preset,"custom");
    }

    #[test]
    fn nonfixed_admission_keeps_geometry_overrides_and_fixed_admission_ignores_them() {
        let mut catalogue = cannon_catalogue();catalogue["cannon"]["radius"]=json!(0.06);
        for (radius, barrel) in [(0.023456789_f64, 0.712345678_f64), (-1.0, -1.0), (1.0, 9.0)] {
            let config = json!({"preset":"cannon","radius":radius,"barrel":barrel});
            let variable = Settings::admit(&catalogue, &config, None, false).unwrap();
            assert_eq!(
                variable.radius.to_bits(),
                radius.clamp(0.001, 0.12).to_bits()
            );
            assert_eq!(variable.barrel.to_bits(), barrel.clamp(BARREL_REACH.0, BARREL_REACH.1).to_bits());
            let fixed = Settings::admit(&catalogue, &config, None, true).unwrap();
            assert_eq!(fixed.radius.to_bits(), 0.06_f64.to_bits());
            // The 120 mm gun of 44 calibres, 4.25 m from its trunnion to its muzzle.
            assert_eq!(fixed.barrel.to_bits(), 4.25_f64.to_bits());
        }
    }

    #[test]
    fn direct_muzzle_is_bit_exact_to_actual_angle_solution_for_all_trajectory_modes() {
        let mut catalogue = cannon_catalogue();
        catalogue["cannon"]["radius"]=json!(0.06);catalogue["cannon"]["barrel"]=json!(1.812345678);
        catalogue["cannon"]["speed"]=json!(60.0);catalogue["cannon"]["charges"]=json!([{"value":0.1},{"value":0.5},{"value":1.0}]);
        catalogue["cannon"]["defaultCharge"]=json!("auto");
        let profile = MuzzleProfile::from_value(&catalogue["cannon"]).unwrap();
        for trajectory in ["direct", "low", "high"] {
            let settings = Settings::admit(&catalogue,
                &json!({"preset":"cannon","platform":"vehicle","trajectory":trajectory,"charge":"auto"}),
                Some(42), true).unwrap();
            for origin in [
                Point::ZERO,
                Point::new(300.123456789, -9.123456789),
                Point::new(-700.0, 12.5),
            ] {
                for aim in [
                    Point::ZERO,
                    Point::new(10.0, 5.0),
                    Point::new(1e6, 1e6),
                    Point::new(-100.0, 10.0),
                ] {
                    for angle in [
                        -12.5,
                        -PI,
                        -PI / 2.0,
                        -0.0,
                        0.0,
                        0.123456789,
                        PI / 2.0,
                        PI,
                        12.5,
                    ] {
                        let legacy = solution(origin, aim, &settings, Some(angle));
                        let direct = muzzle_point(origin, angle, profile.barrel);
                        assert_eq!(direct.x.to_bits(), legacy.point.x.to_bits());
                        assert_eq!(direct.y.to_bits(), legacy.point.y.to_bits());
                        assert_eq!(angle.to_bits(), legacy.angle.to_bits());
                        assert_eq!(profile.radius.to_bits(), settings.radius.to_bits());
                    }
                }
            }
        }
    }
}
