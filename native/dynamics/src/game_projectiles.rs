//! Drag/gravity swept CCD and finite secondary damage budgets. Geometry and
//! damage are queried directly in Rust.
use serde::{Deserialize, Serialize};
use crate::game_damage::{
    DamageState, Effects, Material, Point, add, dot, flag, length, num, optional_id, point, scale, sub,
    unit,
};
use crate::game_geometry::{
    Bounds, ComponentKind, EntityGeometry, Geometry, RayHit, RayOptions, SurfaceKind, Terrain, TerrainHit,
    cos, segment_convex, sin, sqrt,
};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};
use std::collections::{HashMap, VecDeque};
use crate::game_flight::{Drag, FLIGHT_HORIZON, FORECAST_DT, FlightState, required};
use crate::game_weapons::Settings;

pub const SECONDARY_ENERGY_PER_POWER: f64 = 200.0;
/// Energy can damage a mechanism without granting a fragment the penetrator's
/// ability to bore armour. Spall inherits both budgets from its source contact;
/// blast fragments retain the existing energy-to-power conversion.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct RayBudget {
    pub energy: f64,
    pub power: f64,
}
impl RayBudget {
    pub fn blast(energy: f64) -> Self { Self { energy, power: energy / SECONDARY_ENERGY_PER_POWER } }
    fn scaled(self, share: f64) -> Self { Self { energy: self.energy * share, power: self.power * share } }
    fn plus(self, other: Self) -> Self { Self { energy: self.energy + other.energy, power: self.power + other.power } }
}
const RICOCHET_SPEED: f64 = 0.62;
const RICOCHET_POWER: f64 = 0.48;
const INTERFACE_PROBE: f64 = 1e-7;
/// Of a shaped charge's power, the share its explosive bursts with where it strikes; the rest is the jet.
pub const HEAT_BLAST_SHARE: f64 = 0.15;
/// How fast the jet of a shaped charge goes on from where it strikes, in metres a second.
pub const JET_SPEED: f64 = 2000.0;
/// A jet loses what it can pierce in the air: to 1/e of it over this many metres. Armour spaced a metre out from
/// the hull leaves the jet half of what it had after the first plate.
pub const JET_REACH: f64 = 1.5;
/// How far a fragment a ray stands for flies from where it is thrown, in metres (`trace_damage_ray`).
pub const FRAGMENT_FLIGHT: f64 = 12.0;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Ammo {
    /// A full-calibre armour-piercing round.
    Ap,
    /// A high-explosive shell: it bursts where it strikes, or in the air.
    He,
    /// A long rod: armour-piercing, fin-stabilised and discarding its sabot.
    Apfsds,
    /// A shaped charge: a small burst where it strikes, and a jet that pierces as much at any range.
    Heat,
}
impl Ammo {
    pub fn name(self) -> &'static str {
        match self {
            Self::Ap => "ap",
            Self::He => "he",
            Self::Apfsds => "apfsds",
            Self::Heat => "heat",
        }
    }
    pub fn from_name(name: &str) -> Self {
        match name {
            "he" => Self::He,
            "apfsds" => Self::Apfsds,
            "heat" => Self::Heat,
            _ => Self::Ap,
        }
    }
    /// A round that strikes by its own motion: what it can still pierce falls with its speed.
    pub fn kinetic(self) -> bool {
        matches!(self, Self::Ap | Self::Apfsds)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Blast {
    pub point: Point,
    pub power: f64,
    pub radius: f64,
    pub source: Option<u32>,
    /// The construction whose side it is of: the one that fired the round that burst, or the one whose fuel or
    /// rounds blew up. A blast nobody's side is of harms everyone.
    pub actor: Option<u32>,
    pub details: Value,
}
/// A field's current protection: its teams and their direct diplomatic partners. Their rounds, fragments and blasts
/// spare the other living constructions they protect, but pay for their material as for anyone else's. The source
/// construction is still harmed by its own fire. Wrecks are intangible, and shelters spare their occupants for every side.
#[derive(Default)]
pub struct Sides {
    /// The last side and whether every occurrence is a wreck, by handle.
    sides: HashMap<u32, (usize, bool)>,
    /// The constructions of each side that stand, but those sheltered.
    standing: Vec<Vec<u32>>,
    /// Direct partners from the canonical alliance authority, never a transitive closure.
    partners: Vec<Vec<usize>>,
    /// The sheltered constructions that stand, whatever their side.
    sheltered: Vec<u32>,
    /// Whole defeated constructions, excluded from weapon material but kept in their original side.
    wrecks: Vec<u32>,
}
impl Sides {
    /// Each construction by its handle, team, wreck and shelter state; `allied` is the current diplomatic authority.
    pub fn new<'a>(constructions: impl IntoIterator<Item = (u32, &'a str, bool, bool)>, allied: impl Fn(&str, &str) -> bool) -> Self {
        let (mut teams, mut names, mut sides) = (HashMap::new(), Vec::new(), Self::default());
        for (handle, team, wreck, sheltered) in constructions {
            let next = teams.len();
            let side = *teams.entry(team).or_insert(next);
            if side == sides.standing.len() {
                names.push(team);
                sides.standing.push(Vec::new());
                sides.partners.push(Vec::new());
            }
            sides.sides.entry(handle).and_modify(|entry| {
                entry.0 = side;
                entry.1 &= wreck;
            }).or_insert((side, wreck));
            if wreck {
                continue;
            }
            if sheltered {
                sides.sheltered.push(handle);
            } else {
                sides.standing[side].push(handle);
            }
        }
        for a in 0..names.len() {
            for b in a + 1..names.len() {
                if allied(names[a], names[b]) {
                    sides.partners[a].push(b);
                    sides.partners[b].push(a);
                }
            }
        }
        // The existing handle map coalesces aliases in one pass. Only membership
        // is consumed by weapon queries; its iteration order is not exposed.
        sides.wrecks = sides.sides.iter().filter_map(|(&handle, &(_, wreck))| wreck.then_some(handle)).collect();
        sides
    }
    /// Whole wrecks remain observable material but never intersect weapon queries.
    pub fn wrecks(&self) -> &[u32] { &self.wrecks }
    /// Same team or a direct diplomatic partner, excluding the source. Defeat does not change a public relationship.
    pub fn friendly(&self, actor: Option<u32>, other: u32) -> bool {
        if actor == Some(other) { return false; }
        let Some(&(side, _)) = actor.and_then(|actor| self.sides.get(&actor)) else { return false; };
        self.sides.get(&other).is_some_and(|&(target, _)|
            side == target || self.partners[side].contains(&target))
    }
    /// What a round or blast spares: the living team and its direct partners, plus shelters, but never the source.
    /// With no known source, only shelters are spared. A wreck's old rounds still protect its living partners.
    pub fn allies(&self, actor: Option<u32>) -> impl Iterator<Item = u32> + '_ {
        let side = actor.and_then(|actor| self.sides.get(&actor)).map(|(side, _)| *side);
        side.into_iter().flat_map(move |side| std::iter::once(side).chain(self.partners[side].iter().copied()))
            .flat_map(move |side| self.standing[side].iter().copied()).chain(self.sheltered.iter().copied())
            .filter(move |other| Some(*other) != actor)
    }
    /// Retain raw physical contacts for audit, distinguishing friendly immunity from an enemy's shelter for publication.
    pub fn tag_friendly_contacts(&self, actor: Option<u32>, events: &mut [Value], damage: &DamageState) {
        for event in events {
            if event["spared"] != true { continue; }
            let target = optional_id(event, "owner").and_then(|owner| damage.plate(owner).map(|p| p.actor)
                .or_else(|| damage.module(owner).map(|m| m.actor)));
            if target.is_some_and(|other| self.friendly(actor, other)) { event["friendly"] = json!(true); }
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CrossedLayer {
    pub ids: Vec<u32>,
    pub entry: Point,
    pub exit: Point,
    pub direction: Point,
}
/// Spall generated inside continuous material can leave only at its final
/// free rear face. Keep that transfer across a long chord's flight steps.
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct SpallTransfer {
    pub budget: RayBudget,
    pub exit: Point,
    pub normal: Point,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Projectile {
    pub id: u64,
    pub actor: Option<u32>,
    pub point: Point,
    pub velocity: Point,
    pub mass: f64,
    pub caliber_mm: f64,
    pub drag: Drag,
    pub power: f64,
    pub radius: f64,
    pub ammo: Ammo,
    pub age: f64,
    pub blast_radius: f64,
    pub fuze_time: Option<f64>,
    pub detonated: bool,
    /// The fragment a ray stands for (`ProjectileState::trace_damage_ray`): it strikes at once and never flies.
    pub fragment: bool,
    /// Of such a fragment, that a perforation threw it inwards.
    pub spall: bool,
    pub emitter: bool,
    pub emitter_ids: Vec<u32>,
    pub visited: Vec<u32>,
    pub crossed_layers: Vec<CrossedLayer>,
    pub pending_spall: Option<SpallTransfer>,
    pub ground_bounces: u8,
    pub cold: Value,
    /// The number of its kind in the legend of the scene, once it has one.
    pub kind: u32,
    /// How far into the step it was fired in it leaves the muzzle, s: a gun that fires faster than the field steps fires
    /// the rest of its rounds of a step after the first, each that much behind it in the air (game.rs `volley`).
    pub hold: f64,
}
/// What tells one kind of round from another on a screen: who fired it, with
/// what, and what it is. A scene has a few of these, however many rounds fly.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ShotKind {
    pub actor: Option<u32>,
    pub weapon: String,
    pub preset: Option<String>,
    pub ammo: Ammo,
    pub powered: bool,
    /// The name of a round that was given one; the others are named `shot-` and their number.
    pub name: Option<String>,
}
impl ShotKind {
    fn of(p: &Projectile) -> Self {
        Self {
            actor: p.actor,
            weapon: p.cold["weapon"].as_str().unwrap_or("").into(),
            preset: p.cold.get("preset").and_then(Value::as_str).map(str::to_owned),
            ammo: p.ammo,
            powered: p.cold["poweredTrail"] == true,
            name: p.cold.get("id").and_then(Value::as_str).map(str::to_owned),
        }
    }
    pub fn to_value(&self) -> Value {
        json!({"actor":self.actor,"weapon":self.weapon,"preset":self.preset,"ammo":self.ammo.name(),
            "poweredTrail":self.powered,"name":self.name})
    }
}
/// Numbers a round takes in the block of the rounds in the air.
pub const SHOT_WORDS: usize = 8;
impl Projectile {
    pub fn from_value(v: &Value) -> Result<Self,String> {
        let mass=required(v,"mass")?;
        let caliber_mm=required(v,"caliberMm")?;
        let family=v["weapon"].as_str().unwrap_or("cannon");
        // A round keeps the drag its ammunition was admitted with; one that
        // states none flies as its family does.
        let drag=if v["flight"].is_null() {Drag::admit(mass,caliber_mm,family,None)?} else {
            let stated=Drag::from_value(&v["flight"])?;
            let own=Drag::admit(mass,caliber_mm,family,Some(stated.cd))?;
            if stated.per_meter.to_bits()!=own.per_meter.to_bits() {
                return Err("Projectile flight metadata differs from its physical ammunition".into());
            }
            own
        };
        if mass<1e-9 || mass>1000.0
            || ["x","y","vx","vy","age","power"].iter().any(|key|
                v.get(*key).is_some_and(|value|value.as_f64().is_none_or(|n|!n.is_finite())))
            || ["vx","vy"].iter().any(|key|num(v,key,0.0).abs()>10000.0) {
            return Err("Invalid physical projectile state".into());
        }
        let pending_spall: Option<SpallTransfer> = match v.get("pendingSpall").filter(|value|!value.is_null()) {
            Some(value)=>Some(serde_json::from_value(value.clone()).map_err(|_|"Invalid pending material transfer")?),
            None=>None,
        };
        if pending_spall.is_some_and(|s| ![s.budget.energy,s.budget.power,s.exit.x,s.exit.y,s.normal.x,s.normal.y].iter().all(|v|v.is_finite())
            || s.budget.energy<0.0 || s.budget.power<0.0 || (length(s.normal)-1.0).abs()>1e-8) {
            return Err("Invalid pending material transfer".into());
        }
        let crossed_layers = match v.get("crossedLayers") {
            Some(value)=>serde_json::from_value(value.clone()).map_err(|_|"Invalid material transit")?,
            None=>Vec::new(),
        };
        Ok(Self {
            id: num(v, "numericId", num(v, "id", 0.0)) as u64,
            actor: optional_id(v, "actor"),
            point: point(num(v, "x", 0.0), num(v, "y", 0.0)),
            velocity: point(num(v, "vx", 0.0), num(v, "vy", 0.0)),
            mass,
            caliber_mm,
            drag,
            power: num(v, "power", 0.0),
            radius: num(v, "radius", 0.01),
            ammo: Ammo::from_name(v["ammo"].as_str().unwrap_or("ap")),
            age: num(v, "age", 0.0),
            blast_radius: num(
                v,
                "blastRadius",
                if v["weapon"] == "rocket" { 2.6 } else { 1.75 },
            ),
            fuze_time: v.get("fuzeTime").and_then(Value::as_f64),
            detonated: flag(v, "detonated", false),
            fragment: false,
            spall: false,
            emitter: flag(v, "emitter", false),
            emitter_ids: ids(v, "emitterOwners"),
            visited: ids(v, "visitedOwners"),
            crossed_layers,
            pending_spall,
            ground_bounces: num(v, "groundBounces", 0.0) as u8,
            cold: v.clone(),
            kind: u32::MAX,
            hold: 0.0,
        })
    }
    /// A round as a gun, or the bench launcher, puts it in the air, with what its weapon fires.
    /// `told` holds what it keeps only to tell of itself: who fired it, with which charge and fuze.
    pub fn fired(id: u64, actor: u32, point: Point, velocity: Point, s: &Settings, fuze_time: Option<f64>,
        gun: Option<u32>, told: Value) -> Result<Self, String> {
        if ![point.x, point.y, velocity.x, velocity.y].iter().all(|x| x.is_finite())
            || velocity.x.abs() > 10000.0 || velocity.y.abs() > 10000.0 {
            return Err("Invalid physical projectile state".into());
        }
        Ok(Self {
            id,
            actor: Some(actor),
            point,
            velocity,
            mass: s.mass,
            caliber_mm: s.caliber_mm,
            drag: s.drag,
            power: s.power,
            radius: s.radius,
            ammo: Ammo::from_name(&s.ammo),
            age: 0.0,
            blast_radius: s.blast_radius,
            fuze_time: fuze_time.filter(|t| t.is_finite()),
            detonated: false,
            fragment: false,
            spall: false,
            emitter: s.mounted,
            emitter_ids: gun.into_iter().collect(),
            visited: Vec::new(),
            crossed_layers: Vec::new(),
            pending_spall: None,
            ground_bounces: 0,
            cold: told,
            kind: u32::MAX,
            hold: 0.0,
        })
    }
    /// The fragment a ray stands for, with no more power than its motion carries.
    pub fn secondary(id: u64, p: Point, velocity: Point, mass: f64, caliber_mm: f64, power: f64, radius: f64) -> Self {
        let power = secondary_power(power, mass, velocity);
        Self {
            id,
            actor: None,
            point: p,
            velocity,
            mass,
            caliber_mm,
            drag:Drag::admit(mass,caliber_mm,"fragment",None).expect("physical internal fragment"),
            power,
            radius,
            ammo: Ammo::Ap,
            age: 0.0,
            blast_radius: 1.75,
            fuze_time: None,
            detonated: false,
            fragment: true,
            spall: false,
            emitter: false,
            emitter_ids: Vec::new(),
            visited: Vec::new(),
            crossed_layers: Vec::new(),
            pending_spall: None,
            ground_bounces: 0,
            cold: Value::Null,
            kind: u32::MAX,
            hold: 0.0,
        }
    }
    pub fn to_value(&self) -> Value {
        let mut v = self.cold.clone();
        if !v.is_object() {
            v = json!({});
        }
        if v.get("id").and_then(Value::as_str).is_none() {
            v["id"] = json!(format!("{}-{}", self.prefix(), self.id));
        }
        v["numericId"] = json!(self.id);
        v["actor"] = json!(self.actor);
        v["emitter"] = json!(self.emitter);
        v["emitterOwners"] = json!(self.emitter_ids);
        v["visitedOwners"] = json!(self.visited);
        v["x"] = json!(self.point.x);
        v["y"] = json!(self.point.y);
        v["vx"] = json!(self.velocity.x);
        v["vy"] = json!(self.velocity.y);
        v["age"] = json!(self.age);
        v["groundBounces"] = json!(self.ground_bounces);
        v["crossedLayers"] = json!(self.crossed_layers);
        v["pendingSpall"] = json!(self.pending_spall);
        v["detonated"] = json!(self.detonated);
        v["power"] = json!(self.power);
        v["mass"] = json!(self.mass);
        v["caliberMm"] = json!(self.caliber_mm);
        v["flight"]=self.drag.to_value(self.mass,self.caliber_mm,self.cold["weapon"].as_str().unwrap_or("cannon"));
        v["radius"] = json!(self.radius);
        v["ammo"] = json!(self.ammo.name());
        v
    }
    pub fn prefix(&self) -> &'static str {
        if self.fragment { "ejecta" } else { "shot" }
    }
    pub fn visual_id(&self) -> String {
        self.cold
            .get("id")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{}-{}", self.prefix(), self.id))
    }
    /// The construction whose side the round is of (`Sides`): the one that fired it from a gun of its own. A round of
    /// the bench launcher stands for no construction — it is fired at the design under test —, and neither does one
    /// put in the air by a host without a gun: those are nobody's. The fragments of a blast are of its side
    /// (`Sides::allies`).
    pub fn side(&self) -> Option<u32> {
        self.actor.filter(|_| !self.emitter_ids.is_empty())
    }
}
fn ids(v: &Value, key: &str) -> Vec<u32> {
    v.get(key)
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(Value::as_u64)
                .map(|n| n as u32)
                .collect()
        })
        .unwrap_or_default()
}
fn advance_air(p:&mut Projectile,dt:f64) {
    let next=FlightState::new(p.point,p.velocity).advance(dt,p.drag);
    commit_air(p,next);
}
fn advance_to(p:&mut Projectile,dt:f64,point:Point) {
    let mut next=FlightState::new(p.point,p.velocity).advance(dt,p.drag);
    // CCD clips a flight chord at this known face. Keep its existing time/velocity integration, but do not
    // charge air along a different intermediate endpoint that would immediately be replaced by this point.
    next.point=point;
    commit_air(p,next);
}
// A penetration pays its entire chord at entry. Keep using that recorded chord after damage cuts a hole, including
// across flight steps: only the rest of this segment is air. Nested paid chords cover their union, not their sum.
fn air_distance(start:Point,end:Point,paid:&[CrossedLayer])->f64 {
    let travel=sub(end,start);
    let distance=length(travel);
    if paid.is_empty() {return distance;}
    let mut spans=Vec::with_capacity(paid.len());
    for layer in paid {
        let from=dot(sub(start,layer.entry),layer.direction);
        let across=dot(travel,layer.direction);
        let depth=dot(sub(layer.exit,layer.entry),layer.direction);
        let (lo,hi)=if across==0.0 {
            if from<0.0 || from>depth {continue;}
            (0.0,1.0)
        } else {
            let a=-from/across;
            let b=(depth-from)/across;
            (a.min(b).max(0.0),a.max(b).min(1.0))
        };
        if hi>lo {spans.push((lo,hi));}
    }
    spans.sort_unstable_by(|a,b|a.0.total_cmp(&b.0));
    let (mut covered,mut until)=(0.0,0.0);
    for (lo,hi) in spans {
        if hi>until {covered+=hi-lo.max(until);until=hi;}
    }
    distance*(1.0-covered).max(0.0)
}
fn commit_air(p:&mut Projectile,next:FlightState) {
    let before=dot(p.velocity,p.velocity);
    if p.ammo.kinetic() && before>0.0 {
        // Material losses remain spent: scaling the remaining budget never
        // restores the catalogue power after a penetration. HE fill is fixed.
        p.power*=dot(next.velocity,next.velocity)/before;
    } else if p.ammo==Ammo::Heat && !p.visited.is_empty() {
        // The jet of a shaped charge that has struck spreads in the air it crosses: spaced armour defeats it.
        p.power*=ComplexField::exp(-air_distance(p.point,next.point,&p.crossed_layers)/JET_REACH);
    }
    p.point=next.point;p.velocity=next.velocity;
}
// Immunity covers the connected initial material chord of the emitting gun.
// Splitting at its exit preserves collisions with every other part, including
// a later return to this gun in the same frame. No lifetime depends on dt.
fn emitter_exit(emitters: &[u32], geometry: &Geometry, start: Point, end: Point) -> Option<f64> {
    let mut exit: f64 = 0.0;
    let mut inside = false;
    for owner in emitters {
        for poly in geometry.projectile_shapes_world(*owner).into_iter().flatten() {
            if segment_convex(start, start, poly).is_some() {
                if let Some(chord) = segment_convex(start, end, poly) {
                    exit = exit.max(chord.exit);
                    inside = true;
                }
            }
        }
    }
    if !inside {
        return None;
    }
    loop {
        let mut next = exit;
        for owner in emitters {
            for poly in geometry.projectile_shapes_world(*owner).into_iter().flatten() {
                if let Some(chord) = segment_convex(start, end, poly) {
                    if chord.enter <= exit + 1e-10 {
                        next = next.max(chord.exit);
                    }
                }
            }
        }
        if next == exit {
            return Some(exit);
        }
        exit = next;
    }
}
/// What a round put in the air at `point` with `velocity` meets first about `near`, as a step flies it: chord by chord
/// of `dt` (`ProjectileState::integrate`), clear of the gun it leaves (`gun`, `emitter_exit`). The construction it
/// meets, by its handle; none when the ground comes first, or when nothing does before the round is past `near` the
/// way it flies, or below it on its way down. Away from `near` nothing is looked for: a line of fire is asked only
/// whether it runs into what stands there, before `until` (the fuze or the end of the forecast).
pub fn first_contact_near(intangible: &[u32],
    point: Point,
    velocity: Point,
    drag: Drag,
    gun: &[u32],
    near: Bounds,
    until: f64,
    dt: f64,
    geometry: &Geometry,
    terrain: &Terrain,
) -> Option<u32> {
    let near = near.padded(0.01);
    // Drag slows a round and gravity bends it down; neither turns it back the way it came.
    let way = if velocity.x > 0.0 { 1.0 } else if velocity.x < 0.0 { -1.0 } else { 0.0 };
    let mut state = FlightState::new(point, velocity);
    let mut emitter = !gun.is_empty();
    let mut time = 0.0;
    let until = until.min(FLIGHT_HORIZON);
    while time < until {
        let step = dt.min(until - time);
        let next = state.advance(step, drag);
        let (start, end) = (state.point, next.point);
        if way > 0.0 && start.x > near.max_x || way < 0.0 && start.x < near.min_x
            || start.y < near.min_y && state.velocity.y <= 0.0
        {
            return None;
        }
        if Bounds::points(&[start, end]).overlaps(near) {
            let exit = if emitter { emitter_exit(gun, geometry, start, end) } else { None };
            emitter = exit.is_some_and(|exit| exit >= 1.0);
            let split = start.lerp(end, exit.unwrap_or(0.0));
            for (a, b, ignore_ids) in [(start, split, gun), (split, end, &[][..])] {
                if a.distance(b) <= 1e-12 {
                    continue;
                }
                let hit = geometry.raycast(a, b, &RayOptions { ignore_actors: intangible, ignore_ids, projectile: true, ..RayOptions::default() });
                if terrain.raycast(a, b).is_some_and(|g| hit.as_ref().is_none_or(|h| g.enter <= h.enter)) {
                    return None;
                }
                if let Some(hit) = hit {
                    return Some(hit.actor);
                }
            }
        } else {
            emitter = false;
        }
        state = next;
        time += step;
    }
    None
}
/// A round about to leave a gun, as its line of fire is asked before it is fired: the gun it leaves, where and how it
/// leaves it, and what it is.
#[derive(Clone, Copy, Debug)]
pub struct LineOfFire {
    pub gun: u32,
    pub point: Point,
    pub velocity: Point,
    pub drag: Drag,
    pub ammo: Ammo,
    /// What it can pierce as it leaves the gun.
    pub power: f64,
}
/// What of its own side a line of fire meets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Line {
    /// Neither the construction the gun is on nor an ally that would stop the round.
    Clear,
    /// The construction the gun is on, first: the gun does not fire into it.
    Own,
    /// An ally that would stop the round, turn it aside or burst it, or leave it too little to go on with
    /// (`THROUGH_ALLY`). The round would harm nothing of the ally: a pilot does not waste it.
    Ally,
}
/// A round is fired through an ally only if it keeps this share of what it could pierce past it, for what it is fired
/// at beyond.
pub const THROUGH_ALLY: f64 = 0.5;
/// What of its own side a round of the construction `own` (by its handle and what it spans) meets on its way, for
/// `until` seconds: itself first, or one of `allies` that would stop it (`through`).
pub fn line_of_fire(intangible: &[u32],
    line: &LineOfFire,
    until: f64,
    own: (u32, Bounds),
    allies: &[(u32, Bounds)],
    dt: f64,
    damage: &DamageState,
    geometry: &Geometry,
    terrain: &Terrain,
) -> Line {
    if first_contact_near(intangible, line.point, line.velocity, line.drag, &[line.gun], own.1, until, dt, geometry, terrain) == Some(own.0) {
        return Line::Own;
    }
    let stopped = allies.iter().any(|&(ally, near)| {
        through(intangible, line, ally, near, until, dt, damage, geometry, terrain).is_some_and(|kept| kept < THROUGH_ALLY)
    });
    if stopped { Line::Ally } else { Line::Clear }
}
/// What a round keeps, of what it could pierce, past what stands of construction `actor` across its flight for
/// `until` seconds, as a step flies it and as its plates and pieces take it (`strike_cost`,
/// `ProjectileState::resolve_impact`): none if it is stopped there, glances off or bursts there. Nothing when it
/// meets none of it, or the ground first. `near` is what the construction spans; far short of it the flight is
/// followed by long steps, for nothing there is asked of it.
pub fn through(intangible: &[u32],
    line: &LineOfFire,
    actor: u32,
    near: Bounds,
    until: f64,
    dt: f64,
    damage: &DamageState,
    geometry: &Geometry,
    terrain: &Terrain,
) -> Option<f64> {
    if intangible.contains(&actor) { return None; }
    let near = near.padded(0.01);
    let way = if line.velocity.x > 0.0 { 1.0 } else if line.velocity.x < 0.0 { -1.0 } else { 0.0 };
    let until = until.min(FLIGHT_HORIZON);
    let (mut state, mut time, mut power) = (FlightState::new(line.point, line.velocity), 0.0, line.power);
    // What a kinetic round can pierce falls with its speed in the air (`commit_air`).
    let flown = |power: f64, from: FlightState, to: FlightState| {
        if line.ammo.kinetic() && dot(from.velocity, from.velocity) > 0.0 {
            power * dot(to.velocity, to.velocity) / dot(from.velocity, from.velocity)
        } else {
            power
        }
    };
    let short = |p: Point| way > 0.0 && p.x < near.min_x || way < 0.0 && p.x > near.max_x;
    while time + FORECAST_DT < until {
        let next = state.advance(FORECAST_DT, line.drag);
        if !short(next.point) {
            break;
        }
        if next.point.y <= terrain.height(next.point.x) {
            return None;
        }
        power = flown(power, state, next);
        (state, time) = (next, time + FORECAST_DT);
    }
    let (mut met, mut crossed) = (None, Vec::new());
    while time < until {
        let next = state.advance(dt, line.drag);
        let (start, end) = (state.point, next.point);
        if way > 0.0 && start.x > near.max_x || way < 0.0 && start.x < near.min_x
            || start.y < near.min_y && state.velocity.y <= 0.0
        {
            break;
        }
        power = flown(power, state, next);
        let mut velocity = next.velocity;
        if Bounds::points(&[start, end]).overlaps(near) {
            let ground = terrain.raycast(start, end);
            let (mut cursor, mut fraction) = (start, 0.0);
            while fraction < 1.0 {
                let options = RayOptions { ignore_actors: intangible, only_actor: Some(actor), paid_initial: &crossed,
                    complete_exit: true, projectile: true, ..RayOptions::default() };
                let Some(hit) = geometry.raycast(cursor, end, &options) else {break;};
                let entered = fraction + (1.0 - fraction) * hit.enter;
                if ground.as_ref().is_some_and(|g| g.enter <= entered) {
                    break;
                }
                let newly_paid = !crossed.contains(&hit.owner);
                // Each query moves forward or pays a new owner at this point.
                // Paid material at the origin is excluded by Geometry; later
                // disconnected regions of the same owner remain ordinary hits.
                if entered <= fraction && !newly_paid {return Some(0.0);}
                let entering: f64 = *met.get_or_insert(power);
                if !line.ammo.kinetic() || entering <= 0.0 {
                    return Some(0.0);
                }
                let cosine = dot(unit(velocity), hit.normal).abs();
                let (material, cost) = strike_cost(damage, &hit, cosine);
                if cosine < material.ricochet && power < cost * 1.3 || power < cost {
                    return Some(0.0);
                }
                velocity = scale(velocity, sqrt((power - cost) / power));
                power -= cost;
                if newly_paid {crossed.push(hit.owner);}
                (cursor, fraction) = (hit.point, entered);
            }
            if ground.is_some() {
                break;
            }
        }
        (state, time) = (FlightState::new(end, velocity), time + dt);
    }
    met.map(|entering: f64| power / entering)
}
/// The material a ray meets on a plate or a piece, and what it takes to get through there,
/// met at `cosine` to its face.
fn strike_cost(damage: &DamageState, hit: &RayHit, cosine: f64) -> (Material, f64) {
    // A piece meets it as what it is made of, as a plate does: a shot glances off a laminate as off its plates.
    let material = damage
        .plate(hit.owner)
        .map(|p| p.material)
        .or_else(|| damage.module(hit.owner).map(|m| m.metal().material()))
        .unwrap_or_else(|| Material::from_name("steel"));
    let cost = if let Some(module) = damage.module(hit.owner) {
        module.chord_resistance(hit.point, hit.exit_point, hit.depth, cosine)
    } else if let Some(plate) = damage.plate(hit.owner) {
        // DDA returns the occupied chord. Visual dents do not reduce it again.
        (hit.depth * 1000.0 * material.resistance * plate.material_scale).max(0.5)
    } else {
        (hit.depth * 1000.0 * material.resistance).max(0.5)
    };
    (material, cost)
}
pub fn secondary_power(requested: f64, mass: f64, velocity: Point) -> f64 {
    requested
        .max(0.0)
        .min((0.5 * mass.max(0.0) * dot(velocity, velocity)).max(0.0) / SECONDARY_ENERGY_PER_POWER)
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Random {
    pub state: u32,
}
impl Random {
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
        ((t ^ (t >> 14)) as f64) / 4294967296.0
    }
    pub fn normal(&mut self) -> f64 {
        sqrt(-2.0 * ComplexField::ln(self.next().max(1e-9)))
            * cos(std::f64::consts::TAU * self.next())
    }
}
#[derive(Clone, Copy, Debug, PartialEq)]
struct GroundResponse {
    velocity: Point,
    power: f64,
    retained: f64,
    cosine: f64,
}
impl GroundResponse {
    fn to_value(self) -> Value {
        json!({"vx":self.velocity.x,"vy":self.velocity.y,"power":self.power,
            "retained":self.retained,"cosine":self.cosine})
    }
}
/// A grazing kinetic contact, independent of a world or the rest of a round.
fn ground_impact(
    velocity: Point,
    power: f64,
    kinetic: bool,
    bounces: u8,
    normal: Point,
    surface: SurfaceKind,
) -> Option<GroundResponse> {
    let (grazing, tangent, restitution) = match surface {
        SurfaceKind::Rock => (0.28, 0.64, 0.38),
        // A grazing round skips off a paved road as off concrete, and off a graded one as off soil.
        SurfaceKind::Concrete | SurfaceKind::Asphalt => (0.24, 0.68, 0.32),
        SurfaceKind::Gravel => (0.15, 0.48, 0.21),
        SurfaceKind::Sand => (0.025, 0.24, 0.07),
        SurfaceKind::Mud => (0.0, 0.12, 0.02),
        _ => (0.08, 0.38, 0.12),
    };
    let speed = length(velocity);
    let normal_speed = dot(velocity, normal);
    let cosine = if speed > 0.0 {
        (-normal_speed / speed).clamp(0.0, 1.0)
    } else {
        1.0
    };
    if !kinetic
        || normal_speed >= 0.0
        || speed < 8.0
        || cosine > grazing
        || bounces >= 2
    {
        return None;
    }
    let velocity = sub(
        scale(sub(velocity, scale(normal, normal_speed)), tangent),
        scale(normal, normal_speed * restitution),
    );
    let remaining = dot(velocity, velocity);
    let retained = remaining / (speed * speed);
    let power = power * remaining / (speed * speed);
    (power >= 0.5).then_some(GroundResponse { velocity, power, retained, cosine })
}
pub fn ground_response(p: &Projectile, hit: &TerrainHit) -> Option<(Point, f64)> {
    ground_impact(p.velocity, p.power, p.ammo.kinetic(), p.ground_bounces, hit.normal, hit.surface)
        .map(|response| (response.velocity, response.power))
}
pub fn ground_response_request(value: &Value) -> Result<Value, String> {
    let velocity = point(required(value, "vx")?, required(value, "vy")?);
    let power = required(value, "power")?;
    if velocity.x.abs() > 10000.0 || velocity.y.abs() > 10000.0 || !(0.0..=1e12).contains(&power) {
        return Err("Ground response exceeds the finite instrument range".into());
    }
    let normal = point(required(value, "nx")?, required(value, "ny")?);
    if (dot(normal, normal) - 1.0).abs() > 1e-6 {
        return Err("Ground response requires a unit surface normal".into());
    }
    let bounces = match value.get("groundBounces") {
        None | Some(Value::Null) => 0,
        Some(value) => value.as_u64().ok_or("Ground bounce count must be a nonnegative integer")?.min(2) as u8,
    };
    let kinetic = matches!(value["ammo"].as_str(), Some("ap" | "apfsds"));
    let surface = SurfaceKind::from_name(value["surface"].as_str().unwrap_or("soil"));
    Ok(ground_impact(velocity, power, kinetic, bounces, normal, surface)
        .map_or(Value::Null, GroundResponse::to_value))
}

#[derive(Serialize, Deserialize)]
pub struct ProjectileState {
    pub projectiles: Vec<Projectile>,
    #[serde(skip)]
    spare_projectiles: Vec<Projectile>,
    pub pending_blasts: VecDeque<Blast>,
    pub random: Random,
    pub next_id: u64,
    pub min_x: f64,
    pub max_x: f64,
    #[serde(skip)]
    trace: Vec<(f64, Point, Point)>,
    #[serde(skip)]
    trace_on: bool,
    #[serde(skip)]
    trace_end: f64,
    /// The kinds of round this scene has seen, and how many of them its host was told of.
    pub kinds: Vec<ShotKind>,
    pub kinds_told: usize,
}
impl Default for ProjectileState {
    fn default() -> Self {
        Self {
            projectiles: Vec::new(),
            spare_projectiles: Vec::new(),
            pending_blasts: VecDeque::new(),
            random: Random::new(6173),
            next_id: 1,
            min_x: -1500.0,
            max_x: 1500.0,
            trace: Vec::new(),
            trace_on: false,
            trace_end: 0.0,
            kinds: Vec::new(),
            kinds_told: 0,
        }
    }
}
impl ProjectileState {
    /// These rounds as a state written out of them reads back (`GameState::written_copy`): the spare rounds and the
    /// trace are not written.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn written_copy(&self) -> ProjectileState {
        let ProjectileState { projectiles, spare_projectiles: _, pending_blasts, random, next_id, min_x, max_x, trace: _, trace_on: _,
            trace_end: _, kinds, kinds_told } = self;
        ProjectileState {
            projectiles: projectiles.clone(),
            spare_projectiles: Vec::new(),
            pending_blasts: pending_blasts.clone(),
            random: random.clone(),
            next_id: *next_id,
            min_x: *min_x,
            max_x: *max_x,
            trace: Vec::new(),
            trace_on: false,
            trace_end: 0.0,
            kinds: kinds.clone(),
            kinds_told: *kinds_told,
        }
    }
    pub fn from_value(v: &Value) -> Result<Self,String> {
        let mut state = Self::default();
        state.random = Random::new(num(v, "randomState", num(v, "seed", 6173.0)) as u32);
        state.next_id = num(v, "nextId", 1.0) as u64;
        state.min_x = num(&v["bounds"], "minX", -1500.0);
        state.max_x = num(&v["bounds"], "maxX", 1500.0);
        if let Some(projectiles) = v["projectiles"].as_array() {
            state.projectiles = projectiles.iter().map(Projectile::from_value).collect::<Result<_,_>>()?;
        }
        Ok(state)
    }
    /// Drop an oversized history only while publishing its replacement legend.
    /// Reading a binary block afterwards must keep those published indices.
    pub fn publish_kinds(&mut self) {
        self.name_kinds();
        if self.kinds.len() > 256 && self.kinds.len() > self.projectiles.len().saturating_mul(2) {
            self.kinds.clear();
            self.kinds_told = 0;
            for p in &mut self.projectiles { p.kind = u32::MAX; }
            self.name_kinds();
        }
    }
    /// Every round in the air gets the number of its kind.
    pub fn name_kinds(&mut self) {
        for p in &mut self.projectiles {
            if p.kind != u32::MAX {
                continue;
            }
            let kind = ShotKind::of(p);
            p.kind = match self.kinds.iter().position(|known| *known == kind) {
                Some(index) => index,
                None => {
                    self.kinds.push(kind);
                    self.kinds.len() - 1
                }
            } as u32;
        }
    }
    /// The rounds in the air, eight numbers each: number, kind, x, y, vx, vy, age
    /// and radius, as the core holds them. A screen needs no more of a round that
    /// only flies on, and thousands of them cost a copy, not a text.
    pub fn block(&mut self) -> Vec<f64> {
        self.name_kinds();
        let mut words = Vec::with_capacity(self.projectiles.len() * SHOT_WORDS);
        for p in &self.projectiles {
            words.extend_from_slice(&[p.id as f64, p.kind as f64, p.point.x, p.point.y,
                p.velocity.x, p.velocity.y, p.age, p.radius]);
        }
        words
    }
    /// The drag of each round in the air, per metre flown, in the order of `block`. With it a
    /// host tells a round once and a screen follows it from there: nothing but gravity and
    /// this acts on a round until it strikes.
    pub fn drags(&self) -> Vec<f64> {
        self.projectiles.iter().map(|p| p.drag.per_meter).collect()
    }
    pub fn allocate_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }
    /// What was set off goes off after the blasts already waiting, in the order it was set off.
    pub fn append_effects(&mut self, effects: &mut Effects) {
        self.pending_blasts.extend(effects.detonations.drain(..));
    }
    pub fn step(
        &mut self,
        dt: f64,
        time: f64,
        sides: &Sides,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
    ) {
        self.append_effects(effects);
        geometry.index();
        let mut current = std::mem::replace(
            &mut self.projectiles,
            std::mem::take(&mut self.spare_projectiles),
        );
        // New effects stay in the destination queue until the next step. The
        // drained source keeps its allocation for the following destination.
        for mut p in current.drain(..) {
            let initial = p.point;
            let fresh = p.age == 0.0;
            let hold = std::mem::take(&mut p.hold).clamp(0.0, dt);
            let (dt, time) = (dt - hold, time + hold);
            self.trace.clear();
            self.trace_on = effects.visual_events;
            self.trace_end = time + dt;
            if self.trace_on {
                self.trace.push((time, initial, p.velocity));
            }
            let source = p.side();
            let event_begin = effects.events.len();
            let alive = self.move_projectile(sides.wrecks(), &mut p, move |actor| sides.allies(source).any(|other| other == actor),
                dt, time, damage, geometry, terrain, effects);
            self.append_effects(effects);
            sides.tag_friendly_contacts(source, &mut effects.events[event_begin..], damage);
            // A path is sent for what the next snapshot cannot tell: the muzzle
            // a round left, a contact on its way, where it ended. A round that
            // only flew on is where the snapshot has it, and a long volley in
            // the air costs no event a round on every step.
            if effects.visual_events && (fresh || !alive || self.trace.len() > 1) {
                self.trace.push((
                    if alive { time + dt } else { self.trace_end },
                    p.point,
                    p.velocity,
                ));
                let mut event = json!({"type":"flight","id":p.visual_id(),"n":p.id as u32,"actor":p.actor,"ammo":p.ammo.name(),"weapon":p.cold["weapon"],"poweredTrail":p.cold["poweredTrail"],"radius":p.radius,"terminal":!alive,"time":time});
                event["points"] = Value::Array(self.trace.iter().map(|(time,point,v)|json!({"time":time,"x":point.x,"y":point.y,"vx":v.x,"vy":v.y})).collect());
                effects.events.push(event);
            }
            if alive {
                self.projectiles.push(p);
            }
        }
        self.spare_projectiles = current;
    }
    pub fn detonate(&mut self, p: &mut Projectile, at: Point, source: Option<u32>, time: f64) {
        if p.detonated {
            return;
        }
        p.detonated = true;
        p.point = at;
        self.trace_end = time;
        let mut details = json!({"time":time,"detonation":if source.is_some(){"impact"}else{"airburst"},"preset":p.cold.get("preset")});
        // A shell made otherwise than its reference's throws its fragments as it was made to (game_pressure.rs `explode`).
        for key in ["fragments", "fragmentReach"] { if let Some(value) = p.cold.get(key).filter(|v| v.is_number()) { details[key] = value.clone(); } }
        self.pending_blasts.push_back(Blast{point:at,power:p.power,radius:p.blast_radius,source,actor:p.side(),details});
    }
    /// The burst of a shaped charge where it strikes: a share of its power, as far as its blast reaches. The jet
    /// it forms is the round itself, going on.
    fn shaped_burst(&mut self, p: &Projectile, at: Point, source: Option<u32>, time: f64) {
        self.trace_end = time;
        self.pending_blasts.push_back(Blast{point:at,power:p.power*HEAT_BLAST_SHARE,radius:p.blast_radius,source,actor:p.side(),
            details:json!({"time":time,"detonation":"impact","shaped":true,"preset":p.cold.get("preset"),"projectileId":p.visual_id()})});
    }
    /// One round over a step. It harms and pushes none spared by its original side (`Sides`),
    /// and meets them as anything else.
    pub fn move_projectile(
        &mut self,
        intangible: &[u32],
        p: &mut Projectile,
        is_spared: impl Fn(u32) -> bool,
        requested_dt: f64,
        time: f64,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
    ) -> bool {
        if p.side().is_some_and(|actor| intangible.contains(&actor)) { p.emitter = false; }
        let dt = if let Some(fuze) = p.fuze_time {
            requested_dt.min((fuze - p.age).max(0.0))
        } else {
            requested_dt
        };
        p.age += dt;
        // A round stays in the air until it strikes something or leaves the
        // field by its sides, however long, high or slow that takes it. What
        // armour or ground has already spent is dropped.
        let touched = !p.visited.is_empty() || p.ground_bounces > 0;
        if touched && p.power < 0.5
            || p.point.x < self.min_x
            || p.point.x > self.max_x
        {
            return false;
        }
        self.integrate(intangible, p, is_spared, dt, time, damage, geometry, terrain, effects)
    }
    fn integrate(
        &mut self,
        intangible: &[u32],
        p: &mut Projectile,
        is_spared: impl Fn(u32) -> bool,
        dt: f64,
        time: f64,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
    ) -> bool {
        // A paid chord ceases to be material when its whole carrier becomes a wreck.
        // Keep past impacts and spent power; only future air/material queries change.
        if !intangible.is_empty() {
            for layer in &mut p.crossed_layers {
                layer.ids.retain(|owner| {
                    let actor = damage.plate(*owner).map(|part| part.actor)
                        .or_else(|| damage.module(*owner).map(|part| part.actor));
                    !actor.is_some_and(|actor| intangible.contains(&actor))
                });
            }
            p.crossed_layers.retain(|layer| !layer.ids.is_empty());
        }
        let mut remaining = dt;
        let mut crossings = 0;
        while crossings < 10 {
            if remaining <= 1e-7 {
                break;
            }
            let start = p.point;
            let mut segment_dt = remaining;
            let flight=FlightState::new(start,p.velocity).advance(remaining,p.drag);
            let mut end = flight.point;
            if p.emitter {
                if let Some(exit) = emitter_exit(&p.emitter_ids, geometry, start, end) {
                    segment_dt *= exit;
                    end = start.lerp(end,exit);
                    if segment_dt <= 1e-12 {
                        p.emitter = false;
                        continue;
                    }
                } else {
                    p.emitter = false;
                }
            }
            p.crossed_layers.retain(|layer| {
                dot(sub(start, layer.entry), layer.direction) >= -0.006
                    && dot(sub(start, layer.exit), layer.direction) <= 0.006
            });
            let paid: Vec<_> = p
                .crossed_layers
                .iter()
                .flat_map(|l| l.ids.iter().copied())
                .collect();
            let ignore_emitter = p.emitter;
            let options = RayOptions { ignore_actors: intangible,
                ignore_ids: if ignore_emitter { &p.emitter_ids } else { &[] },
                paid_initial: &paid,
                complete_exit: p.ammo != Ammo::He,
                projectile: true,
                ..RayOptions::default()
            };
            let hit = geometry.raycast(start, end, &options);
            let ground = terrain.raycast(start, end);
            if let Some(ground) = ground.filter(|g| hit.as_ref().is_none_or(|h| g.enter <= h.enter))
            {
                crossings += 1;
                p.emitter = false;
                advance_to(p,segment_dt*ground.enter,ground.point);
                let event_time = time + dt - remaining + segment_dt * ground.enter;
                self.trace_end = event_time;
                if self.trace_on {
                    self.trace.push((event_time, p.point, p.velocity));
                }
                if let Some((velocity, power)) = ground_response(p, &ground) {
                    p.velocity = velocity;
                    p.power = power;
                    p.ground_bounces += 1;
                    p.point = add(p.point, scale(ground.normal, 0.009));
                    damage.stats.ricochets += 1;
                    if effects.visual_events {
                        effects.events.push(json!({"type":"ricochet","x":ground.point.x,"y":ground.point.y,"nx":ground.normal.x,"ny":ground.normal.y,"enter":ground.enter,"ground":true,"surface":ground.surface.name(),"power":p.power,"time":event_time}));
                    }
                    remaining -= segment_dt * ground.enter;
                    continue;
                }
                if matches!(p.ammo, Ammo::He | Ammo::Heat) {
                    // A shaped charge that strikes the ground bursts there, and its jet goes into the ground.
                    if p.ammo == Ammo::Heat {
                        self.shaped_burst(p, add(ground.point, scale(ground.normal, 0.08)), None, event_time);
                    } else {
                        self.detonate(
                            p,
                            add(ground.point, scale(ground.normal, 0.08)),
                            None,
                            event_time,
                        );
                    }
                    if let Some(blast) = self.pending_blasts.back_mut() {
                        blast.details["detonation"] = json!("impact");
                        blast.details["ground"] = json!(true);
                        blast.details["source"] = json!("ground");
                    }
                } else if effects.visual_events {
                    effects.events.push(json!({"type":"ground","x":ground.point.x,"y":ground.point.y,"nx":ground.normal.x,"ny":ground.normal.y,"enter":ground.enter,"surface":ground.surface.name(),"power":p.power,"time":event_time}));
                }
                return false;
            }
            let Some(hit) = hit else {
                if p.pending_spall.is_some_and(|pending|dot(sub(end,pending.exit),pending.normal)>0.0) {
                    p.pending_spall = None;
                }
                if segment_dt==remaining {commit_air(p,flight);}else{advance_to(p,segment_dt,end);}
                if segment_dt < remaining {
                    remaining -= segment_dt;
                    p.emitter = false;
                    continue;
                }
                if p.fuze_time.is_some_and(|fuze| p.age >= fuze - 1e-9) {
                    self.detonate(p, p.point, None, time + dt);
                    return false;
                }
                return true;
            };
            crossings += 1;
            p.emitter = false;
            advance_to(p,segment_dt*hit.enter,hit.point);
            let event_time = time + dt - remaining + segment_dt * hit.enter;
            self.trace_end = event_time;
            if self.trace_on {
                self.trace.push((event_time, p.point, p.velocity));
            }
            let before = p.velocity;
            let spared = is_spared(hit.actor);
            if p.ammo == Ammo::He {
                if !p.visited.contains(&hit.owner) {
                    damage.stats.impacts += 1;
                }
                let target = hit.owner;
                if !spared {
                    effects.impulse(target, hit.point, scale(before, p.mass));
                }
                if effects.visual_events {
                    let mut event = json!({"type":"primary-contact","owner":hit.owner,
                        "projectileId":p.visual_id(),"ammo":"he","fragment":false,
                        "x":hit.point.x,"y":hit.point.y,"nx":hit.normal.x,"ny":hit.normal.y,
                        "speed":length(before),"mass":p.mass,"energy":0.5*p.mass*dot(before,before),
                        "result":"detonation","time":event_time});
                    primary_origin(&mut event, p, hit.actor);
                    if spared {
                        event["spared"] = json!(true);
                    }
                    effects.events.push(event);
                }
                let queued_blasts = self.pending_blasts.len();
                self.detonate(p, hit.point, Some(hit.owner), event_time);
                if self.pending_blasts.len() > queued_blasts {
                    if let Some(blast) = self.pending_blasts.back_mut() {
                        blast.details["projectileId"] = json!(p.visual_id());
                        blast.details["emitterOwner"] = json!(p.emitter_ids.first());
                        blast.details["shooterActor"] = json!(p.actor);
                        blast.details["targetActor"] = json!(hit.actor);
                        blast.details["primaryContact"] = json!(true);
                    }
                }
                return false;
            }
            let direction = unit(p.velocity);
            if p.ammo == Ammo::Heat && p.visited.is_empty() {
                // A shaped charge bursts on the first thing it strikes, and its jet goes on through it. The jet is
                // the liner's metal, a small part of the round going far faster: it carries the round's momentum.
                self.shaped_burst(p, hit.point, Some(hit.owner), event_time);
                let speed = length(p.velocity);
                if speed < JET_SPEED {
                    let mass=p.mass*(speed/JET_SPEED);
                    let Ok(drag)=Drag::admit(mass,p.caliber_mm,p.cold["weapon"].as_str().unwrap_or("cannon"),Some(p.drag.cd))
                        else {return false;};
                    // The lighter jet keeps the admitted coefficient and calibre; its drag follows its new mass,
                    // exactly as a diagnostic restoration derives it. Mass times speed still carries the same momentum.
                    p.mass=mass;p.drag=drag;
                    p.velocity = scale(direction, JET_SPEED);
                }
            }
            let result = self.resolve_impact(intangible,
                &hit, p, direction, spared, damage, geometry, terrain, effects, event_time,
            );
            match result {
                ImpactResult::Blocked => return false,
                ImpactResult::Ricochet => {
                    remaining -= segment_dt * hit.enter;
                    continue;
                }
                ImpactResult::Penetration => {}
            }
            let after_entry = (remaining - segment_dt * hit.enter).max(0.0);
            let residual_speed = length(p.velocity);
            let transit = hit.depth / residual_speed;
            if !transit.is_finite() {
                return false;
            }
            let consumed = vec![hit.owner];
            p.crossed_layers.push(CrossedLayer {
                ids: consumed.clone(),
                entry: hit.point,
                exit: hit.exit_point,
                direction,
            });
            let nested_start = hit.point;
            let nested_end = add(hit.point, scale(direction, hit.depth));
            let nested = if hit.depth > 0.0 {
                let mut ignored = if ignore_emitter { p.emitter_ids.clone() } else { Vec::new() };
                ignored.extend(consumed);
                geometry.raycast(
                    nested_start,
                    nested_end,
                    &RayOptions { ignore_actors: intangible,
                        ignore_ids: &ignored,
                        projectile: true,
                        ..RayOptions::default()
                    },
                )
            } else {
                None
            };
            if nested.is_some() {
                p.point = nested_start;
                remaining = after_entry;
                continue;
            }
            if transit > after_entry {
                advance_air(p,after_entry);
                return true;
            }
            advance_to(p,transit,hit.exit_point);
            // The completed paid chord excludes metal until its transit is committed. Keep only other,
            // still-crossed chords afterwards; geometry rejects a zero-length departure without skipping material.
            p.crossed_layers.pop();
            remaining = after_entry - transit;
        }
        if p.fuze_time.is_some_and(|fuze| p.age >= fuze - 1e-9) {
            self.detonate(p, p.point, None, time + dt);
            return false;
        }
        true
    }
    /// A representative fragment spends a finite energy budget on real material
    /// layers now. No body, persistent projectile or extra carrier force is made.
    /// Internal rays are restricted to the impacted carrier; external blast rays
    /// use `None`, harm none of the constructions their blast spares (`spared`,
    /// `Sides::allies`) and are stopped by them, as by every other actor and the terrain.
    pub fn trace_damage_ray(
        &mut self,
        intangible: &[u32],
        origin: Point,
        direction: Point,
        budget: RayBudget,
        max_distance: f64,
        source: Option<u32>,
        only_actor: Option<u32>,
        spared: &[u32],
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
        time: f64,
    ) -> f64 {
        if !budget.energy.is_finite() || budget.energy <= 0.0 || !budget.power.is_finite() || budget.power <= 0.0
            || !max_distance.is_finite() || max_distance <= 0.0 || length(direction) < 1e-12 {
            return 0.0;
        }
        let direction = unit(direction);
        let end = add(origin, scale(direction, max_distance.min(FRAGMENT_FLIGHT)));
        // The representative speed carries the energy, independently of the
        // inherited ability to pierce. Both decrease at every material contact.
        let speed = 150.0;
        let mut ray = Projectile::secondary(
            self.allocate_id(),
            origin,
            scale(direction, speed),
            2.0 * budget.energy / (speed * speed),
            6.0,
            budget.power,
            0.003,
        );
        ray.spall = only_actor.is_some();
        let initial_power = ray.power;
        let initial_energy = 0.5 * ray.mass * dot(ray.velocity, ray.velocity);
        let impulse_begin = effects.impulses.len();
        let event_begin = effects.events.len();
        damage.stats.secondary_shots += 1;
        let mut point = origin;
        // Bounded independently of historic damage. A blocked ray deposits its
        // remaining budget; a ricochet ends this trace with its retained energy.
        for _ in 0..12 {
            let options = RayOptions { ignore_actors: intangible,
                only_actor,
                complete_exit: true,
                projectile: true,
                ..RayOptions::default()
            };
            let hit = geometry.raycast(point, end, &options);
            if let Some(ground) = terrain
                .raycast(point, end)
                .filter(|g| hit.as_ref().is_none_or(|h| g.enter <= h.enter))
            {
                point = ground.point;
                break;
            }
            let Some(hit) = hit else {
                point = end;
                break;
            };
            let result = self.resolve_impact(intangible,
                &hit, &mut ray, direction, spared.contains(&hit.actor), damage, geometry, terrain, effects, time,
            );
            point = if result == ImpactResult::Penetration {
                let next = hit.exit_point;
                // A contact entered within range resolves its whole material chord.
                // The external cursor stops at end and cannot query another owner beyond it.
                if only_actor.is_none() && dot(sub(end, next), direction) <= 0.0 { end } else { next }
            } else {
                hit.point
            };
            if result != ImpactResult::Penetration
                || ray.power <= 1e-12
                || dot(sub(end, point), direction) <= 0.0
            {
                break;
            }
        }
        let spent_energy = (initial_energy - 0.5 * ray.mass * dot(ray.velocity, ray.velocity)).clamp(0.0, initial_energy);
        let spent_power = (initial_power - ray.power).clamp(0.0, initial_power);
        // Primary impacts and the once-per-actor blast impulse already account
        // for the carrier mechanics. Internal impulses cannot propel the hull.
        effects.impulses.truncate(impulse_begin);
        if effects.visual_events {
            for event in &mut effects.events[event_begin..] {
                if event["projectileId"] == ray.visual_id() {
                    event["impulse"] = json!(0.0);
                    event["instantaneous"] = json!(true);
                }
            }
            effects.events.push(json!({"type":"secondary-ray","projectileId":ray.visual_id(),
                "x":origin.x,"y":origin.y,"endX":point.x,"endY":point.y,
                "sourceOwner":source,"targetActor":only_actor,"internal":only_actor.is_some(),
                "energyBudget":initial_energy,"energySpent":spent_energy,
                "powerBudget":initial_power,"powerSpent":spent_power,
                "time":time}));
        }
        spent_energy
    }
    pub fn trace_internal_rays(
        &mut self,
        intangible: &[u32],
        origin: Point,
        direction: Point,
        budget: RayBudget,
        source: Option<u32>,
        actor: u32,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
        time: f64,
    ) -> f64 {
        let direction = unit(direction);
        let mut spent = 0.0;
        for (angle, weight) in [(-0.2, 0.25), (0.0, 0.5), (0.2, 0.25)] {
            let (c, s) = (cos(angle), sin(angle));
            let d = point(
                c * direction.x - s * direction.y,
                s * direction.x + c * direction.y,
            );
            spent += self.trace_damage_ray(intangible,
                origin,
                d,
                budget.scaled(weight),
                FRAGMENT_FLIGHT,
                source,
                Some(actor),
                &[],
                damage,
                geometry,
                terrain,
                effects,
                time,
            );
        }
        spent
    }
    /// What a round or a fragment does where it meets a plate or a piece. One it `spared`, of an ally of its side
    /// (`Sides::allies`), it meets as any other — it is stopped, glances off or gets through with what is left — and
    /// harms and pushes none of it: no mark, no hole, no wound, no spall within it.
    pub fn resolve_impact(
        &mut self,
        intangible: &[u32],
        hit: &RayHit,
        p: &mut Projectile,
        direction: Point,
        spared: bool,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
        time: f64,
    ) -> ImpactResult {
        let before = p.velocity;
        let power = p.power;
        let carried = p.pending_spall.take().filter(|pending| !p.fragment
            && dot(sub(hit.point,pending.exit),pending.normal).abs() <= 1e-6
            && dot(direction,pending.normal) > 0.0)
            .map_or(RayBudget{energy:0.0,power:0.0},|pending|pending.budget);
        let cosine = dot(direction, hit.normal).abs();
        let component = damage.module(hit.owner).map(|m| m.owner);
        let (material, cost) = strike_cost(damage, hit, cosine);
        // A shaped charge does not glance off: it bursts on what it strikes, and the jet goes where it points.
        let result = if p.ammo != Ammo::Heat && cosine < material.ricochet && power < cost * 1.3 {
            ImpactResult::Ricochet
        } else if power >= cost {
            ImpactResult::Penetration
        } else {
            ImpactResult::Blocked
        };
        let exit_normal = if !spared && component.is_none() && !p.fragment && result == ImpactResult::Penetration {
            let path = unit(sub(hit.exit_point,hit.point));
            geometry.raycast_owner(hit.owner,add(hit.exit_point,scale(path,INTERFACE_PROBE)),hit.point)
                .map_or(direction,|exit|exit.normal)
        } else { direction };
        let deposited_fraction = if result == ImpactResult::Ricochet { 1.0 - RICOCHET_SPEED * RICOCHET_SPEED }
            else { (cost / power.max(1e-15)).clamp(0.0, 1.0) };
        let deposited_energy = 0.5 * p.mass * dot(before, before) * deposited_fraction;
        let spent_power = if result == ImpactResult::Ricochet { power * (1.0 - RICOCHET_POWER) }
            else { cost.min(power) };
        let mut exported = RayBudget { energy: 0.0, power: 0.0 };
        let mut released = RayBudget { energy: 0.0, power: 0.0 };
        if let Some(owner) = component.filter(|_| !spared) {
            // A fragment can give the next mechanism only the energy it loses
            // here. Its remaining energy continues with its remaining power;
            // neither budget is reset by a component contact.
            let strike_power = if p.fragment {
                deposited_energy / SECONDARY_ENERGY_PER_POWER
            } else if result == ImpactResult::Ricochet { power * cosine } else { power };
            let health_before = damage.module(owner).map_or(0.0, |m| m.health);
            let shield_revision = damage.module(owner)
                .filter(|m| m.kind == ComponentKind::Weapon && m.mount.as_ref().is_some_and(|mount| !mount.exposed))
                .map(|m| m.mark_revision);
            damage.component_strike(
                owner,
                hit.point,
                hit.exit_point,
                strike_power,
                p.radius,
                result == ImpactResult::Penetration,
                p.fragment,
                effects,
            );
            if let Some(module) = damage.module(owner).filter(|m| shield_revision.is_some_and(|revision| m.mark_revision != revision)) {
                // A perforated shield must expose its opening to the rest of this same flight step.
                geometry.upsert(owner, EntityGeometry::from_module(module));
            }
            let health_after = damage.module(owner).map_or(0.0, |m| m.health);
            if effects.visual_events {
                // The component strike already emitted its one impact. Enrich
                // that contact instead of emitting a second generic spark burst.
                if let Some(event) = effects.events.last_mut() {
                    event["projectileId"] = json!(p.visual_id());
                    event["material"] = json!(material.name());
                    event["speed"] = json!(length(before));
                    event["mass"] = json!(p.mass);
                    event["energy"] = json!(0.5 * p.mass * dot(before, before));
                    event["energyDeposited"] = json!(deposited_energy);
                    event["powerSpent"] = json!(spent_power);
                    if p.fragment {
                        event["power"] = json!(power);
                        event["remaining"] = json!(power - spent_power);
                    }
                    event["fragment"] = json!(p.fragment);
                    event["spall"] = json!(p.spall);
                    event["nx"] = json!(-direction.x);
                    event["ny"] = json!(-direction.y);
                    event["damage"] = json!(health_before - health_after);
                    event["result"] = json!(if result == ImpactResult::Penetration {
                        "penetration"
                    } else {
                        "blocked"
                    });
                    event["time"] = json!(time);
                    if !p.fragment {
                        primary_origin(event, p, hit.actor);
                    }
                }
            }
        }
        if !p.fragment && !p.visited.contains(&hit.owner) {
            damage.stats.impacts += 1;
        }
        if !p.visited.contains(&hit.owner) {
            p.visited.push(hit.owner);
        }
        let target = hit.owner;
        if result == ImpactResult::Ricochet {
            let normal_speed = dot(p.velocity, hit.normal);
            p.velocity = scale(sub(p.velocity, scale(hit.normal, 2.0 * normal_speed)), RICOCHET_SPEED);
            p.power *= RICOCHET_POWER;
            p.point = add(hit.point, scale(hit.normal, 0.009));
            if let Some(plate) = damage.plate_mut(hit.owner).filter(|_| !spared) {
                plate.mark(hit.point, "ricochet", 0.6);
                plate.plastic_impression(
                    hit.point, direction, 0.2, p.power, p.radius, hit.normal, None, 0.18, 1.0,
                );
            }
        } else {
            let penetrated = result == ImpactResult::Penetration;
            let mut cut: Option<(Point, Point, f64)> = None;
            if component.is_none() && !spared {
                if let Some(plate) = damage.plate_mut(hit.owner) {
                    if !material.brittle {
                        plate.plastic_impression(
                            hit.point,
                            direction,
                            if penetrated { 0.72 } else { power / cost },
                            power,
                            p.radius,
                            hit.normal,
                            None,
                            0.18,
                            1.0,
                        );
                    }
                    if penetrated {
                        cut = Some((
                            sub(hit.point, scale(direction, 0.07)),
                            add(hit.exit_point, scale(direction, 0.07)),
                            p.radius * if material.brittle { 1.55 } else { 1.0 },
                        ));
                    } else if material.brittle {
                        plate.mark(hit.point, "crack", power / cost);
                        // A strong stopped impact chips the face immediately.
                        // Insufficient hits leave marks without storing energy
                        // that could weaken a later impact.
                        if power >= 90.0 {
                            cut = Some((
                                sub(hit.point, scale(direction, 0.015)),
                                add(
                                    hit.point,
                                    scale(
                                        direction,
                                        (hit.depth * 0.42)
                                            .min(power / (material.resistance * 1000.0) * 0.7),
                                    ),
                                ),
                                p.radius * (1.2 + power / cost),
                            ));
                        }
                    }
                }
            }
            if let Some((a, b, r)) = cut {
                let removed = damage.cut(hit.owner, a, b, r, effects);
                if !removed.is_empty() {
                    let plate = damage.plate(hit.owner).unwrap();
                    geometry.set_grid(hit.owner, &plate.grid);
                    if penetrated {
                        if let Some(plate) = damage.plate_mut(hit.owner) {
                            plate.mark(hit.point, "hole", power / 300.0);
                        }
                        let outward = add(hit.exit_point, scale(direction, INTERFACE_PROBE));
                        // An authored seam inside continuous material is not a
                        // rear face. Another actor touching it is material too.
                        // Do not jump four millimetres over a thin intact skin.
                        let free_exit = !p.fragment && geometry.raycast(hit.exit_point, outward, &RayOptions { ignore_actors: intangible,
                            ignore_ids: &[hit.owner], projectile: true, ..RayOptions::default()
                        }).is_none_or(|next| next.enter > 1e-4);
                        if !p.fragment {
                            // Internal fragments are three instantaneous material
                            // rays. Their energy comes from the consumed primary
                            // energy; forces within the one carrier are already
                            // represented by the primary momentum transfer.
                            let consumed = 0.5
                                * p.mass
                                * dot(before, before)
                                * (cost / power.max(1e-15)).clamp(0.0, 1.0);
                            exported = RayBudget { energy: consumed, power: cost }.scaled(0.08 * material.spall);
                            let budget = carried.plus(exported);
                            if free_exit {
                                released = budget;
                                self.trace_internal_rays(intangible, hit.exit_point,direction,budget,Some(hit.owner),hit.actor,
                                    damage,geometry,terrain,effects,time);
                            } else {
                                p.pending_spall = Some(SpallTransfer{budget,exit:hit.exit_point,normal:exit_normal});
                            }
                        }
                    } else if !p.fragment && effects.visual_events {
                        effects.events.push(json!({"type":"debris","owner":hit.owner,"x":hit.point.x,"y":hit.point.y,"material":material.name(),"vx":-direction.x,"vy":1.2,"count":removed.len().min(8)}));
                    }
                }
            }
            p.power = (power - cost).max(0.0);
            let residual = sqrt(p.power / power.max(1e-15));
            p.velocity = scale(p.velocity, residual);
        }
        let after = if result == ImpactResult::Blocked {
            Point::ZERO
        } else {
            p.velocity
        };
        let impulse = if spared { Point::ZERO } else { scale(sub(before, after), p.mass) };
        if !spared {
            effects.impulse(target, hit.point, impulse);
        }

        if !p.fragment {
            if result == ImpactResult::Ricochet {
                damage.stats.ricochets += 1;
            }
            if result == ImpactResult::Penetration {
                damage.stats.penetrations += 1;
            }
        }
        if effects.visual_events && (!p.fragment || component.is_none() || spared) {
            let mut event = json!({"type":if p.fragment{"secondary-impact"}else{result.name()},"owner":hit.owner,"projectileId":p.visual_id(),"x":hit.point.x,"y":hit.point.y,"nx":hit.normal.x,"ny":hit.normal.y,"material":material.name(),"power":if p.fragment{power.min(cost)}else{power},"remaining":p.power,"mass":p.mass,"energy":0.5*p.mass*dot(before,before),"speed":length(before),"fragment":p.fragment,"spall":p.spall,"impulse":length(impulse),"normalSpeed":length(before)*cosine,"time":time,"result":result.name()});
            // A contiguous sequence transfers one pool between its contacts.
            // Energy retained or released there is not heat deposited here;
            // a pool stopped in solid material is finally dissipated here.
            let pending = p.pending_spall.map_or(RayBudget{energy:0.0,power:0.0},|spall|spall.budget);
            event["energyDeposited"] = json!((deposited_energy + carried.energy - pending.energy - released.energy).max(0.0));
            event["powerSpent"] = json!(spent_power);
            if exported.energy > 0.0 || carried.energy > 0.0 {
                event["spallTransfer"] = json!({"generated":exported,"carried":carried,"released":released,"pending":pending});
            }
            if !p.fragment {
                primary_origin(&mut event, p, hit.actor);
            }
            if spared {
                event["spared"] = json!(true);
            }
            effects.events.push(event);
        }
        result
    }
}
fn primary_origin(event: &mut Value, projectile: &Projectile, target_actor: u32) {
    event["caliberMm"] = json!(projectile.caliber_mm);
    event["shooterActor"] = json!(projectile.actor);
    event["targetActor"] = json!(target_actor);
    event["emitterOwner"] = json!(projectile.emitter_ids.first());
    event["primaryContact"] = json!(true);
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ImpactResult {
    Blocked,
    Penetration,
    Ricochet,
}
impl ImpactResult {
    pub fn name(self) -> &'static str {
        match self {
            Self::Blocked => "blocked",
            Self::Penetration => "penetration",
            Self::Ricochet => "ricochet",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_geometry::EntityKind;

    #[test]
    fn a_shot_meets_a_piece_as_what_it_is_made_of() {
        let mut damage = DamageState::default();
        for (owner, metal) in [(2, None), (3, Some("aluminum")), (4, Some("fiberglass")), (5, Some("plastic"))] {
            let mut v = json!({"kind":"fuel","health":75,"maxHealth":75,"x":0,"y":0,"width":0.8,"height":0.72});
            if let Some(metal) = metal { v["metal"] = json!(metal); }
            damage.insert_module(crate::game_damage::fixtures::module(owner, 0, &v));
        }
        let hit = |owner| RayHit { owner, actor: 0, kind: EntityKind::Module, enter: 0.0, exit: 0.1, normal: point(-1.0, 0.0),
            point: point(-0.4, 0.0), exit_point: point(0.4, 0.0), depth: 0.8 };
        let met = |owner| strike_cost(&damage, &hit(owner), 1.0);
        assert_eq!([2, 3, 4, 5].map(|owner| met(owner).0.name()), ["steel", "aluminum", "fiberglass", "plastic"]);
        // What it takes to get through it is its own; a laminate glances off almost nothing, and a moulding less.
        for owner in [4, 5] {
            assert_eq!(met(owner).1, damage.module(owner).unwrap().chord_resistance(hit(owner).point, hit(owner).exit_point, 0.8, 1.0));
        }
        assert!(met(5).0.ricochet < met(4).0.ricochet && met(4).0.ricochet < met(2).0.ricochet);
    }

    #[test]
    fn explosive_sources_keep_the_authoritative_point_at_every_world_height() {
        for y in [-32.0, 0.04, 3.0, 32.0] {
            for source in [None, Some(9)] {
                for ammo in ["he", "heat"] {
                    let at = point(12.0, y);
                    let mut round = Projectile::from_value(&json!({
                        "x":12.0,"y":y,"vx":100,"vy":0,"mass":8.0,"caliberMm":105,
                        "power":410.0,"blastRadius":5.2,"ammo":ammo
                    })).unwrap();
                    let mut state = ProjectileState::default();
                    if ammo == "he" {
                        state.detonate(&mut round, at, source, 4.25);
                        assert_eq!(round.point, at);
                    } else {
                        state.shaped_burst(&round, at, source, 4.25);
                    }
                    assert_eq!(state.pending_blasts.len(), 1);
                    let burst = &state.pending_blasts[0];
                    assert_eq!(burst.point, at, "world height is not ground clearance: {ammo} {y}");
                    assert_eq!(burst.source, source);
                    assert_eq!(burst.details["time"], json!(4.25));
                    assert_eq!(burst.radius, 5.2);
                    assert_eq!(burst.power, if ammo == "he" { 410.0 } else { 410.0 * HEAT_BLAST_SHARE });
                }
            }
        }
    }

    #[test]
    fn explosive_ground_contacts_keep_the_existing_normal_clearance_after_translation() {
        for base in [-32.0, 0.0, 32.0] {
            for angle in [0.0_f64, 0.3] {
                let grade = angle.tan();
                let terrain = Terrain::from_value(&json!({"id":"flat","material":"concrete",
                    "points":[{"x":-100.0,"y":base-100.0*grade},{"x":100.0,"y":base+100.0*grade}]
                })).unwrap();
                for ammo in ["he", "heat"] {
                    let mut round = Projectile::from_value(&json!({
                        "x":0.0,"y":base+0.2,"vx":0,"vy":-100.0,"mass":8.0,"caliberMm":105,
                        "power":410.0,"blastRadius":5.2,"ammo":ammo
                    })).unwrap();
                    let mut state = ProjectileState::default();
                    assert!(!state.move_projectile(&[], &mut round, |_| false, 1.0/60.0, 0.0,
                        &mut DamageState::default(), &mut Geometry::new(), &terrain, &mut Effects::new(false)));
                    assert_eq!(state.pending_blasts.len(), 1);
                    let burst = &state.pending_blasts[0];
                    let expected = add(point(0.0, base), scale(point(-sin(angle), cos(angle)), 0.08));
                    assert!(burst.point.distance(expected) < 1e-9, "{ammo} base={base} angle={angle}: {:?}", burst.point);
                    assert_eq!(burst.details["ground"], true);
                    assert_eq!(burst.details["detonation"], "impact");
                }
            }
        }
    }

    #[test]
    fn pure_ground_instrument_matches_live_contacts_and_always_loses_energy() {
        for surface in ["soil", "rock", "concrete", "gravel", "sand", "mud", "graded", "asphalt"] {
            for ammo in ["ap", "apfsds", "he", "heat"] {
                for angle in [0.0, 0.61] {
                    let normal = point(-sin(angle), cos(angle));
                    let velocity = point(600.0 * cos(angle) + 100.0 * sin(angle),
                        600.0 * sin(angle) - 100.0 * cos(angle));
                    let request = json!({"vx":velocity.x,"vy":velocity.y,"power":100.0,
                        "ammo":ammo,"groundBounces":1,"nx":normal.x,"ny":normal.y,"surface":surface});
                    let told: Value = serde_json::from_str(&crate::ground_response(&request.to_string()).unwrap()).unwrap();
                    let round = Projectile::from_value(&json!({"vx":velocity.x,"vy":velocity.y,"power":100,
                        "mass":0.2,"caliberMm":25,"ammo":ammo,"groundBounces":1})).unwrap();
                    let hit = TerrainHit { enter: 0.0, point: Point::ZERO, normal,
                        surface: SurfaceKind::from_name(surface) };
                    match ground_response(&round, &hit) {
                        None => assert!(told.is_null(), "{surface} {ammo} {angle}"),
                        Some((velocity, power)) => {
                            assert_eq!(told["vx"], velocity.x);
                            assert_eq!(told["vy"], velocity.y);
                            assert_eq!(told["power"], power);
                            assert!(dot(velocity, normal) > 0.0);
                            assert!(power >= 0.5 && power < round.power);
                            let retained = told["retained"].as_f64().unwrap();
                            assert!(retained > 0.0 && retained < 1.0);
                            assert!((power / round.power - retained).abs() < 1e-15);
                            assert!((told["cosine"].as_f64().unwrap() - 0.1643989873053573).abs() < 1e-14);
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn ground_instrument_preserves_stop_conditions_and_refuses_invalid_requests() {
        let request = json!({"vx":600,"vy":-100,"power":100,"ammo":"ap","nx":0,"ny":1,"surface":"concrete"});
        let hard = ground_response_request(&request).unwrap();
        assert!((hard["vx"].as_f64().unwrap() - 408.0).abs() < 1e-12);
        assert!((hard["vy"].as_f64().unwrap() - 32.0).abs() < 1e-12);
        for (key, value) in [("ammo", json!("he")), ("ammo", json!("unknown")), ("ammo", Value::Null),
            ("vy", json!(-400)), ("vy", json!(100)), ("groundBounces", json!(2)),
            ("power", json!(0.6)), ("surface", json!("soil")), ("surface", json!("unknown"))] {
            let mut stopped = request.clone(); stopped[key] = value;
            assert!(ground_response_request(&stopped).unwrap().is_null(), "{stopped}");
        }
        let mut slow = request.clone(); slow["vx"] = json!(7); slow["vy"] = json!(-1);
        assert!(ground_response_request(&slow).unwrap().is_null());
        for (key, value) in [("vx", Value::Null), ("vx", json!(10001)), ("power", json!(-1)),
            ("power", json!(1e13)), ("nx", json!(2)), ("ny", json!(0)),
            ("groundBounces", json!(-1)), ("groundBounces", json!(0.5))] {
            let mut invalid = request.clone(); invalid[key] = value;
            assert!(ground_response_request(&invalid).is_err(), "{invalid}");
        }
        assert!(crate::ground_response("{}").is_err());
        assert!(crate::ground_response("{").is_err());
        assert!(crate::ground_response(&" ".repeat(4 * 1024 + 1)).is_err());
    }

    fn gun_material_fixture() -> (DamageState, Geometry, EntityGeometry) {
        let module = crate::game_damage::fixtures::module(1, 7, &json!({
            "kind":"weapon","weaponPreset":"rh120","x":0,"y":3,"angle":0,
            "barrelAngle":0,"health":110,"maxHealth":110
        }));
        let entity = EntityGeometry::from_module(&module);
        let mut damage = DamageState::default();
        damage.insert_module(module);
        let mut geometry = Geometry::new();
        geometry.upsert(1, entity.clone());
        (damage, geometry, entity)
    }

    #[test]
    fn rounds_cross_an_exposed_tube_as_air_without_damage_energy_loss_or_contact_events() {
        for ammo in ["ap", "apfsds", "he", "heat"] {
            let (mut damage, mut geometry, entity) = gun_material_fixture();
            let tube = Bounds::points(&entity.polygons[1]);
            let other_end = entity.polygons.iter().enumerate().filter(|(role, _)| *role != 1)
                .flat_map(|(_, poly)| poly.iter()).map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
            assert!(tube.max_x > other_end, "the gun has a tube exposed beyond its receiver and shield");
            let x = (tube.max_x + other_end) * 0.5;
            let mut round = Projectile::from_value(&json!({"numericId":77,"x":x,"y":4,
                "vx":0,"vy":-50,"mass":8,"caliberMm":120,"power":650,"radius":0.01,
                "ammo":ammo})).unwrap();
            let mut air_round = round.clone();
            let end = FlightState::new(round.point, round.velocity).advance(0.04, round.drag).point;
            assert_eq!(geometry.raycast(round.point, end, &RayOptions::default()).unwrap().owner, 1,
                "the material tube still exists for non-projectile queries");
            let before = damage.module(1).unwrap().to_value();
            let stats = damage.stats.to_value();
            let mut state = ProjectileState::default();
            let mut air_state = ProjectileState::default();
            let mut effects = Effects::new(true);
            let terrain = Terrain::new("flat").unwrap();
            assert!(state.move_projectile(&[], &mut round, |_| false, 0.04, 0.0,
                &mut damage, &mut geometry, &terrain, &mut effects));
            assert!(air_state.move_projectile(&[], &mut air_round, |_| false, 0.04, 0.0,
                &mut DamageState::default(), &mut Geometry::new(), &terrain, &mut Effects::new(true)));
            assert_eq!(round.to_value(), air_round.to_value(), "tube passage must spend only air drag: {ammo}");
            assert_eq!(damage.module(1).unwrap().to_value(), before);
            assert_eq!(damage.stats.to_value(), stats);
            assert!(effects.events.is_empty() && effects.impulses.is_empty());
            assert!(state.pending_blasts.is_empty() && round.visited.is_empty());
        }
    }

    #[test]
    fn projectile_forecasts_and_secondary_rays_also_pass_through_tubes() {
        let (mut damage, mut geometry, entity) = gun_material_fixture();
        let tube = Bounds::points(&entity.polygons[1]);
        let other_end = entity.polygons.iter().enumerate().filter(|(role, _)| *role != 1)
            .flat_map(|(_, poly)| poly.iter()).map(|p| p.x).fold(f64::NEG_INFINITY, f64::max);
        let origin = point((tube.max_x + other_end) * 0.5, 4.0);
        let round = Projectile::from_value(&json!({"x":origin.x,"y":origin.y,
            "vx":0,"vy":-50,"mass":8,"caliberMm":120,"power":650,"radius":0.01})).unwrap();
        let near = Bounds::points(&geometry.shapes_world(1).unwrap().iter().flatten().copied().collect::<Vec<_>>());
        let terrain = Terrain::new("flat").unwrap();
        assert_eq!(first_contact_near(&[], origin, round.velocity, round.drag, &[], near, 0.08, 0.01,
            &geometry, &terrain), None);
        let line = LineOfFire { gun: 99, point: origin, velocity: round.velocity, drag: round.drag,
            ammo: Ammo::Ap, power: round.power };
        assert_eq!(through(&[], &line, 7, near, 0.08, 0.01, &damage, &geometry, &terrain), None);
        let before = damage.module(1).unwrap().to_value();
        let mut effects = Effects::new(true);
        let spent = ProjectileState::default().trace_damage_ray(&[], origin, point(0.0, -1.0), RayBudget::blast(10000.0),
            2.0, None, None, &[], &mut damage, &mut geometry, &terrain, &mut effects, 0.0);
        assert_eq!(spent, 0.0);
        assert_eq!(damage.module(1).unwrap().to_value(), before);
        assert!(effects.events.iter().all(|event| event["type"] == "secondary-ray"));
        assert_eq!(effects.events[0]["endY"], 2.0);
    }

    #[test]
    fn skipping_the_tube_preserves_contacts_with_the_receiver_and_shield_behind_it() {
        for shield in [false, true] {
            let (mut damage, mut geometry, entity) = gun_material_fixture();
            let tube = Bounds::points(&entity.polygons[1]);
            let local_origin = point(tube.max_x + 1.0, 0.0);
            let target = if shield {
                let poly = &entity.polygons[2];
                scale(poly.iter().copied().fold(point(0.0, 0.0), add), 1.0 / poly.len() as f64)
            } else {
                let receiver = Bounds::points(&entity.polygons[0]);
                point((receiver.min_x + receiver.max_x) * 0.5, 0.0)
            };
            let direction = unit(sub(target, local_origin));
            let origin = entity.pose.world_point(local_origin);
            let velocity = scale(direction, 1000.0);
            let mut round = Projectile::from_value(&json!({"numericId":77,"x":origin.x,"y":origin.y,
                "vx":velocity.x,"vy":velocity.y,"mass":8,"caliberMm":120,"power":650,
                "radius":0.01,"ammo":"he"})).unwrap();
            let mut state = ProjectileState::default();
            let mut effects = Effects::new(true);
            let terrain = Terrain::new("flat").unwrap();
            assert!(!state.move_projectile(&[], &mut round, |_| false, 0.02, 0.0,
                &mut damage, &mut geometry, &terrain, &mut effects));
            assert_eq!(damage.stats.impacts, 1);
            assert_eq!(state.pending_blasts.front().unwrap().source, Some(1));
            let contact = effects.events.iter().find(|event| event["type"] == "primary-contact").unwrap();
            let hit = point(contact["x"].as_f64().unwrap(), contact["y"].as_f64().unwrap());
            // Nudge into the material so a contact on a rounded polygon edge is unambiguous.
            let inside = add(hit, scale(direction, 0.0001));
            let roles: Vec<_> = if shield { (2..entity.polygons.len()).collect() } else { vec![0] };
            assert!(roles.iter().any(|role| {
                let poly = &geometry.shapes_world(1).unwrap()[*role];
                segment_convex(inside, inside, poly).is_some()
            }), "contact must be on the remaining physical {}: {hit:?}", if shield { "shield" } else { "receiver" });
            assert!(contact["x"].as_f64().unwrap() < origin.x);
        }
    }

    fn curved_mantlet_fixture(pose:crate::game_geometry::Pose,thickness:f64)->(DamageState,Geometry) {
        let mut module=crate::game_damage::fixtures::module(1,7,&json!({
            "kind":"weapon","weaponPreset":"m777","x":pose.x,"y":pose.y,"angle":pose.angle,"barrelAngle":pose.angle,
            "health":1000,"maxHealth":1000
        }));
        // Isolate the finite curved skin in this geometry unit. Admission of real mounts is exercised separately;
        // start from a valid catalogue module and keep its two fixed feet clear of the test rays.
        let mount=module.mount.as_mut().unwrap();
        mount.shield=Some(crate::game_mounts::Shield{radius:0.275,thickness,half_angle:std::f64::consts::PI/3.0,opening:0.135});
        mount.base.as_mut().unwrap().inner_y=10.0;
        let mut geometry=Geometry::new();geometry.upsert(1,EntityGeometry::from_module(&module));
        let mut damage=DamageState::default();damage.insert_module(module);(damage,geometry)
    }
    #[test]
    fn an_exact_shield_vertex_uses_the_outer_skin_normal_instead_of_a_facet_seam() {
        for angle in [0.0,2.54159265927] {for reverse in [false,true] {
            let pose=crate::game_geometry::Pose{x:2.0,y:3.0,angle};
            let (mut damage,mut geometry)=curved_mantlet_fixture(pose,0.065);
            let radius:f64=0.275;let opening:f64=0.135;let outer=radius+0.065;
            let half=std::f64::consts::PI/3.0;
            let gap=crate::game_geometry::atan2(opening,sqrt(radius*radius-opening*opening));
            let theta=(gap+half)/2.0;let b=outer*cos((half-gap)/2.0*0.8);
            let normal=point(cos(theta),sin(theta));let tangent=point(-sin(theta),cos(theta));
            let (mut start,mut end)=(pose.world_point(add(scale(normal,b),scale(tangent,0.7))),pose.world_point(sub(scale(normal,b),scale(tangent,0.7))));
            if reverse {std::mem::swap(&mut start,&mut end);}
            let hit=geometry.raycast(start,end,&RayOptions{projectile:true,complete_exit:true,..RayOptions::default()}).unwrap();
            assert!((hit.depth-0.14416320627658).abs()<1e-8,"the exact vertex retains its full geometric chord");
            let radial=unit(sub(hit.point,point(pose.x,pose.y)));
            assert!(dot(radial,hit.normal)>0.999,"a shared internal edge is not a surface normal: {hit:?}");
            let direction=unit(sub(end,start));let cosine=dot(direction,hit.normal).abs();
            assert!((0.1..0.3).contains(&cosine),"the exact vertex is a grazing hit: {cosine}");
            let velocity=scale(direction,1000.0);
            let mut projectile=Projectile::from_value(&json!({"x":start.x,"y":start.y,"vx":velocity.x,"vy":velocity.y,
                "power":100,"mass":0.2,"caliberMm":25,"radius":0.006,"ammo":"ap","weapon":"autocannon"})).unwrap();
            let result=ProjectileState::default().resolve_impact(&[], &hit,&mut projectile,direction,false,&mut damage,&mut geometry,
                &Terrain::new("flat").unwrap(),&mut Effects::new(false),0.0);
            assert!(result==ImpactResult::Ricochet,"the real outer face determines grazing ricochet");
        }}
    }
    #[test]
    fn an_oblique_mantlet_perforation_clears_the_whole_chord_in_either_direction() {
        for angle in [0.0,0.37] {for side in [-1.0,1.0] {for reverse in [false,true] {
            let pose=crate::game_geometry::Pose{x:2.0,y:3.0,angle};
            let (mut damage,mut geometry)=curved_mantlet_fixture(pose,0.025);
            let (mut start,mut end)=(pose.world_point(point(0.5,side*0.2)),pose.world_point(point(0.14,side*0.2)));
            if reverse {std::mem::swap(&mut start,&mut end);}
            let options=RayOptions{projectile:true,complete_exit:true,..RayOptions::default()};
            let hit=geometry.raycast(start,end,&options).expect("the finite curved shield is hit");
            assert!((hit.depth-0.034751856).abs()<1e-7,"the original oblique chord: {hit:?}");
            let neighbour=|r:f64|pose.world_point(point(r*cos(-side*0.75),r*sin(-side*0.75)));
            let (near,far)=(neighbour(0.24),neighbour(0.34));
            let before=damage.module(1).unwrap().chord_resistance(near,far,near.distance(far),1.0);
            assert!(before>30.0);
            let direction=unit(sub(end,start));let velocity=scale(direction,1650.0);
            let mut projectile=Projectile::from_value(&json!({"numericId":91,"x":start.x,"y":start.y,"vx":velocity.x,"vy":velocity.y,
                "power":430,"mass":5,"caliberMm":120,"radius":0.006,"ammo":"apfsds","weapon":"cannon"})).unwrap();
            let result=ProjectileState::default().resolve_impact(&[], &hit,&mut projectile,direction,false,&mut damage,&mut geometry,
                &Terrain::new("flat").unwrap(),&mut Effects::new(false),0.0);
            assert!(result==ImpactResult::Penetration);
            assert!(geometry.raycast(start,end,&options).is_none(),"the same oblique path is now a real opening, reverse={reverse}, side={side}, angle={angle}");
            let changed=damage.module(1).unwrap();
            assert!(changed.chord_resistance(start,end,start.distance(end),1.0)<1e-8);
            assert!((changed.chord_resistance(near,far,near.distance(far),1.0)-before).abs()<1e-10,"adjacent armour is unchanged");
            assert!(changed.usable());
        }}}
    }

    // A round at a time, with no queue kept for the next step: an independent oracle of `ProjectileState::step`.
    fn reference_headless_step(
        state: &mut ProjectileState,
        dt: f64,
        time: f64,
        damage: &mut DamageState,
        geometry: &mut Geometry,
        terrain: &Terrain,
        effects: &mut Effects,
    ) {
        assert!(!effects.visual_events);
        state.pending_blasts.extend(effects.detonations.drain(..));
        let current = std::mem::take(&mut state.projectiles);
        for mut p in current {
            state.trace.clear();
            state.trace_on = false;
            state.trace_end = time + dt;
            let alive = state.move_projectile(&[], &mut p, |_| false, dt, time, damage, geometry, terrain, effects);
            state.pending_blasts.extend(effects.detonations.drain(..));
            if alive {
                state.projectiles.push(p);
            }
        }
    }
    fn projectile_values(state: &ProjectileState) -> Vec<Value> {
        state.projectiles.iter().map(Projectile::to_value).collect()
    }
    #[test]
    fn reused_projectile_queue_matches_a_round_by_round_step() {
        fn fixture() -> (ProjectileState, DamageState, Geometry, Effects) {
            let value = json!({"x":0,"y":2,"angle":std::f64::consts::FRAC_PI_2,
                "length":2,"thicknessMm":10,"material":"steel"});
            let mut damage = DamageState::default();
            damage.insert_plate(crate::game_damage::fixtures::plate(1, 0, &value));
            let mut geometry = Geometry::new();
            geometry.upsert(
                1,
                crate::game_damage::fixtures::geometry(1, 0, EntityKind::Plate, &value)
                    .unwrap(),
            );
            let mut state = ProjectileState::default();
            state.projectiles.push(Projectile::from_value(
                &json!({"numericId":1000,"x":-1,"y":2,
                "vx":240,"vy":0,"mass":8,"caliberMm":120,"power":300,"radius":0.012,"life":2}),
            ).unwrap());
            (state, damage, geometry, Effects::new(false))
        }
        let (mut actual, mut damage, mut geometry, mut effects) = fixture();
        let (mut expected, mut reference_damage, mut reference_geometry, mut reference_effects) =
            fixture();
        let terrain = Terrain::new("flat").unwrap();
        let dt = 1.0 / 60.0;
        for step in 0..4 {
            actual.step(
                dt,
                step as f64 * dt,
                &Sides::default(),
                &mut damage,
                &mut geometry,
                &terrain,
                &mut effects,
            );
            reference_headless_step(
                &mut expected,
                dt,
                step as f64 * dt,
                &mut reference_damage,
                &mut reference_geometry,
                &terrain,
                &mut reference_effects,
            );
            assert_eq!(projectile_values(&actual), projectile_values(&expected));
            assert_eq!(damage.stats.to_value(), reference_damage.stats.to_value());
            assert_eq!(
                damage.plates[0].to_value(),
                reference_damage.plates[0].to_value()
            );
            let impulses = |e: &Effects| {
                e.impulses
                    .iter()
                    .map(|i| (i.owner, i.point.x, i.point.y, i.impulse.x, i.impulse.y))
                    .collect::<Vec<_>>()
            };
            assert_eq!(impulses(&effects), impulses(&reference_effects));
            assert_eq!(actual.random.state, expected.random.state);
            assert_eq!(actual.next_id, expected.next_id);
            if step == 0 {
                assert_eq!(
                    damage.stats.secondary_shots, 3,
                    "one AP penetration emits three immediate rays"
                );
            }
        }
    }

    fn immediate_spall_fixture(cover: bool, visual: bool) -> (DamageState, Geometry, Effects) {
        let mut damage = DamageState::default();
        let mut geometry = Geometry::new();
        let armor = json!({"length":2,"thicknessMm":5,"material":"steel","x":0,"y":3,
            "angle":std::f64::consts::FRAC_PI_2});
        damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &armor));
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &armor)
                .unwrap(),
        );
        for (owner, actor, x) in [(2, 7, 0.7), (3, 8, 1.5)] {
            let value = json!({"kind":"engine","x":x,"y":3,"width":0.3,"height":0.6,
                "health":110,"maxHealth":110,"physicalMass":5});
            damage.insert_module(crate::game_damage::fixtures::module(owner, actor, &value));
            geometry.upsert(
                owner,
                crate::game_damage::fixtures::geometry(
                    owner,
                    actor,
                    EntityKind::Module,
                    &value,
                )
                .unwrap(),
            );
        }
        if cover {
            let value = json!({"length":2,"thicknessMm":5,"material":"steel","x":0.3,"y":3,
                "angle":std::f64::consts::FRAC_PI_2});
            damage.insert_plate(crate::game_damage::fixtures::plate(4, 7, &value));
            geometry.upsert(
                4,
                crate::game_damage::fixtures::geometry(4, 7, EntityKind::Plate, &value)
                    .unwrap(),
            );
        }
        (damage, geometry, Effects::new(visual))
    }
    #[test]
    fn ap_spall_is_three_instantaneous_energy_bounded_internal_rays_without_extra_impulse() {
        for covered in [false, true] {
            let (mut damage, mut geometry, mut effects) = immediate_spall_fixture(covered, true);
            let mass = damage.plate(1).unwrap().mass();
            let mut p = Projectile::from_value(&json!({"x":-1,"y":3,"vx":240,"vy":0,
                "mass":1,"caliberMm":20,"power":300,"radius":0.006})).unwrap();
            p.actor = Some(99);
            let hit = geometry
                .raycast(p.point, point(2.0, 3.0), &RayOptions::default())
                .unwrap();
            assert_eq!(hit.owner, 1);
            let initial_energy = 0.5 * p.mass * dot(p.velocity, p.velocity);
            let mut state = ProjectileState::default();
            assert_eq!(
                state
                    .resolve_impact(&[],
                        &hit,
                        &mut p,
                        point(1.0, 0.0),
                        false,
                        &mut damage,
                        &mut geometry,
                        &Terrain::new("flat").unwrap(),
                        &mut effects,
                        0.0
                    )
                    .name(),
                "penetration"
            );
            let budgets: Vec<_> = effects
                .events
                .iter()
                .filter(|e| e["type"] == "secondary-ray")
                .collect();
            assert_eq!(budgets.len(), 3);
            assert_eq!(damage.stats.secondary_shots, 3);
            let ray_energy = budgets
                .iter()
                .map(|e| e["energyBudget"].as_f64().unwrap())
                .sum::<f64>();
            let consumed = initial_energy - 0.5 * p.mass * dot(p.velocity, p.velocity);
            assert!(ray_energy <= consumed * 0.08 + 1e-8);
            assert!(state.projectiles.is_empty());
            assert_eq!(effects.impulses.len(), 1);
            assert_eq!(effects.impulses[0].owner, 1);
            assert_eq!(damage.plate(1).unwrap().mass(), mass);
            assert_eq!(
                damage.module(3).unwrap().health,
                110.0,
                "internal rays cannot reach another carrier"
            );
            if covered {
                assert_eq!(
                    damage.module(2).unwrap().health,
                    110.0,
                    "five millimeter cover must occlude low-energy spall"
                );
            } else {
                assert!(damage.module(2).unwrap().health < 110.0);
            }
        }
    }
    #[test]
    fn instantaneous_damage_is_visual_independent_clamped_and_occluded_by_terrain() {
        let mut states = Vec::new();
        for visual in [false, true] {
            let (mut damage, mut geometry, mut effects) = immediate_spall_fixture(false, visual);
            let mut state = ProjectileState::default();
            let spent = state.trace_internal_rays(&[],
                point(0.01, 3.0),
                point(1.0, 0.0),
                RayBudget::blast(1e8),
                Some(1),
                7,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut effects,
                1.0,
            );
            assert!(spent >= 0.0 && spent <= 1e8);
            // Only the energy actually deposited in this short mechanism
            // damages it; the rest of this enormous budget flies onward.
            assert!(damage.module(2).unwrap().health < 110.0);
            assert_eq!(damage.module(3).unwrap().health, 110.0);
            assert!(effects.impulses.is_empty());
            states.push((
                damage.stats.to_value(),
                damage.module(2).unwrap().to_value(),
                state.next_id,
            ));
        }
        assert_eq!(states[0], states[1]);
        let value = json!({"kind":"engine","x":2,"y":-1,"width":0.3,"height":0.3,"physicalMass":5});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(8, 8, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            8,
            crate::game_damage::fixtures::geometry(8, 8, EntityKind::Module, &value)
                .unwrap(),
        );
        let mut effects = Effects::new(true);
        ProjectileState::default().trace_damage_ray(&[],
            point(0.0, 1.0),
            point(1.0, -1.0),
            RayBudget::blast(1e6),
            FRAGMENT_FLIGHT,
            None,
            None,
            &[],
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut effects,
            0.0,
        );
        assert_eq!(damage.module(8).unwrap().health, 110.0);
        assert_eq!(damage.stats.secondary_component_hits, 0);
    }
    #[test]
    fn an_external_range_boundary_keeps_the_complete_contact_and_spares_the_next_owner() {
        let plate = json!({"length":2,"thicknessMm":20,"material":"steel",
            "x":2,"y":3,"angle":std::f64::consts::FRAC_PI_2});
        let detector = json!({"kind":"engine","x":2.8,"y":3,"width":0.3,"height":0.3,"physicalMass":10});
        let mut damage = DamageState::default();
        damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &plate));
        damage.insert_module(crate::game_damage::fixtures::module(2, 8, &detector));
        let mut geometry = Geometry::new();
        geometry.upsert(1, crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &plate).unwrap());
        geometry.upsert(2, crate::game_damage::fixtures::geometry(2, 8, EntityKind::Module, &detector).unwrap());
        let (origin, end) = (point(0.0, 3.0), point(2.0, 3.0));
        let hit = geometry.raycast(origin, end, &RayOptions { complete_exit: true, ..RayOptions::default() }).unwrap();
        assert!(hit.point.x < end.x && hit.exit_point.x > end.x);
        assert!((hit.depth - 0.020).abs() < 1e-10);
        let target = damage.plate(1).unwrap();
        let expected = 20.0 * target.material.resistance * target.material_scale * SECONDARY_ENERGY_PER_POWER;
        let health = damage.module(2).unwrap().health;
        let mut effects = Effects::new(true);
        let spent = ProjectileState::default().trace_damage_ray(&[], origin, point(1.0, 0.0), RayBudget::blast(20000.0), 2.0,
            None, None, &[], &mut damage, &mut geometry, &Terrain::new("flat").unwrap(), &mut effects, 0.0);
        assert!((spent - expected).abs() < 1e-6,
            "resistance uses the complete 20 mm chord, not the truncated 10 mm segment: {spent}");
        assert_eq!(damage.module(2).unwrap().health, health);
        let ray = effects.events.iter().find(|e| e["type"] == "secondary-ray").unwrap();
        assert_eq!(ray["endX"].as_f64().unwrap(), end.x);
        assert_eq!(ray["endY"].as_f64().unwrap(), end.y);
        assert_eq!(damage.stats.spall_bursts, 0, "an external fragment cannot recursively create internal rays");
        assert!(effects.impulses.is_empty());
    }
    #[test]
    fn stopped_instantaneous_ray_ends_at_its_real_contact_without_a_flight_or_extra_impulse() {
        let value = json!({"kind":"engine","x":2,"y":3,"width":1,"height":1,"physicalMass":10});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Module, &value)
                .unwrap(),
        );
        let mut effects = Effects::new(true);
        let mut state = ProjectileState::default();
        let spent = state.trace_damage_ray(&[],
            point(0.0, 3.0),
            point(1.0, 0.0),
            RayBudget::blast(10.0),
            FRAGMENT_FLIGHT,
            None,
            None,
            &[],
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut effects,
            17.5,
        );
        let contact = effects
            .events
            .iter()
            .find(|e| e["type"] == "secondary-impact")
            .unwrap();
        assert_eq!(contact["result"], "blocked");
        let ray = effects
            .events
            .iter()
            .find(|e| e["type"] == "secondary-ray")
            .unwrap();
        assert_eq!(ray["endX"], contact["x"]);
        assert_eq!(ray["endY"], contact["y"]);
        assert_eq!(ray["endX"], json!(1.5));
        assert_eq!(ray["time"], json!(17.5));
        assert!(spent >= 0.0 && spent <= 10.0);
        assert!(damage.module(1).unwrap().health < 110.0);
        assert!(state.projectiles.is_empty() && effects.impulses.is_empty());
    }
    #[test]
    fn symmetric_internal_rays_are_covariant_under_rotation_and_reflection() {
        let mut health = Vec::new();
        for angle in [0.0, 0.73, -1.2] {
            for sign in [-1.0, 1.0] {
                let (c, s) = (cos(angle), sin(angle));
                let direction = point(sign * c, sign * s);
                let origin = point(7.0, 20.0);
                let at = add(origin, scale(direction, 0.7));
                let value = json!({"kind":"engine","x":at.x,"y":at.y,"angle":angle,
                    "width":0.3,"height":0.6,"physicalMass":5,"health":110,"maxHealth":110});
                let mut damage = DamageState::default();
                damage.insert_module(crate::game_damage::fixtures::module(1, 7, &value));
                let mut geometry = Geometry::new();
                geometry.upsert(
                    1,
                    crate::game_damage::fixtures::geometry(
                        1,
                        7,
                        EntityKind::Module,
                        &value,
                    )
                    .unwrap(),
                );
                let mut effects = Effects::new(true);
                let spent = ProjectileState::default().trace_internal_rays(&[],
                    origin,
                    direction,
                    RayBudget::blast(400.0),
                    None,
                    7,
                    &mut damage,
                    &mut geometry,
                    &Terrain::new("flat").unwrap(),
                    &mut effects,
                    0.0,
                );
                assert!(spent <= 400.0 + 1e-10);
                assert!(effects.impulses.is_empty());
                health.push(damage.module(1).unwrap().health);
            }
        }
        assert!(health[0] < 110.0);
        assert!(
            health.iter().all(|h| (*h - health[0]).abs() < 1e-10),
            "{health:?}"
        );
    }
    #[test]
    fn secondary_component_contact_emits_one_complete_visual_impact() {
        let value = json!({"kind":"engine","x":0,"y":1,"width":1,"height":1,
            "health":110,"maxHealth":110,"physicalMass":100});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(1, 0, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 0, EntityKind::Module, &value)
                .unwrap(),
        );
        let mut p = Projectile::secondary(7, point(-1.0, 1.0), point(100.0, 0.0), 0.01, 10.0, 2.0, 0.005);
        p.spall = true;
        let hit = geometry
            .raycast(p.point, point(1.0, 1.0), &RayOptions::default())
            .unwrap();
        let mut effects = Effects::new(true);
        ProjectileState::default().resolve_impact(&[],
            &hit,
            &mut p,
            point(1.0, 0.0),
            false,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut effects,
            0.25,
        );
        let impacts: Vec<_> = effects
            .events
            .iter()
            .filter(|event| event["type"] == "secondary-impact")
            .collect();
        assert_eq!(impacts.len(), 1);
        assert_eq!(damage.stats.secondary_component_hits, 1);
        let event = impacts[0];
        assert_eq!(event["projectileId"], "ejecta-7");
        assert_eq!(event["owner"], 1);
        assert_eq!(event["kind"], "engine");
        assert_eq!(event["speed"], 100.0);
        assert_eq!(event["mass"], 0.01);
        assert_eq!(event["energy"], 50.0);
        assert_eq!(event["fragment"], true);
        assert_eq!(event["nx"], -1.0);
        assert_eq!(event["ny"], 0.0);
        assert_eq!(event["spall"], true);
        assert_eq!(event["time"], 0.25);
        assert_eq!(
            event["damage"].as_f64().unwrap(),
            110.0 - damage.module(1).unwrap().health
        );
        assert!(event["damage"].as_f64().unwrap() > 0.0);
    }
    fn primary_audit_fixture(
        source: Option<u32>,
        ammo: Ammo,
        visual: bool,
    ) -> (ProjectileState, Projectile, DamageState, Geometry, Effects) {
        let value = json!({"kind":"engine","x":0,"y":3,"width":1,"height":1,
            "health":110,"maxHealth":110,"physicalMass":100});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Module, &value)
                .unwrap(),
        );
        let mut p = Projectile::from_value(&json!({"numericId":77,"x":-1,"y":3,
            "vx":100,"vy":0,"mass":0.01,"caliberMm":7.62,"power":2,"radius":0.005,"life":1,
            "weapon":"machinegun","emitterOwners":[90]})).unwrap();
        p.actor = source;
        p.ammo = ammo;
        (
            ProjectileState::default(),
            p,
            damage,
            geometry,
            Effects::new(visual),
        )
    }
    #[test]
    fn allied_contact_predicate_keeps_the_captured_source_and_trajectory() {
        let sides = Sides::new([(7, "blue", false, false), (8, "blue", false, false),
            (9, "red", false, false), (10, "red", false, true)], |_, _| false);
        let terrain = Terrain::new("flat").unwrap();
        for shooter in [Some(8), Some(7), None] {
            let (mut state, mut round, mut damage, mut geometry, mut effects) =
                primary_audit_fixture(shooter, Ammo::Ap, true);
            let (mut reference, mut expected, mut reference_damage, mut reference_geometry, mut reference_effects) =
                primary_audit_fixture(shooter, Ammo::Ap, true);
            let source = round.side();
            let allies: Vec<_> = sides.allies(source).collect();
            // Attribution and emitter markers cannot change the side captured before movement.
            for projectile in [&mut round, &mut expected] {
                projectile.actor = Some(9);
                projectile.emitter_ids.clear();
            }
            for step in 0..8 {
                let dt = 1.0 / 240.0;
                let alive = state.move_projectile(&[], &mut round,
                    |actor| sides.allies(source).any(|other| other == actor), dt, step as f64 * dt,
                    &mut damage, &mut geometry, &terrain, &mut effects);
                let reference_alive = reference.move_projectile(&[], &mut expected, |actor| allies.contains(&actor),
                    dt, step as f64 * dt, &mut reference_damage, &mut reference_geometry, &terrain, &mut reference_effects);
                assert_eq!(alive, reference_alive);
                let flight = |p: &Projectile| [p.point.x, p.point.y, p.velocity.x, p.velocity.y, p.age, p.power].map(f64::to_bits);
                assert_eq!(flight(&round), flight(&expected));
                assert_eq!(round.to_value(), expected.to_value());
                assert_eq!(serde_json::to_value(&damage).unwrap(), serde_json::to_value(&reference_damage).unwrap());
                assert_eq!(serde_json::to_value(&state).unwrap(), serde_json::to_value(&reference).unwrap());
                assert_eq!(effects.events, reference_effects.events);
                assert_eq!(effects.region_changes, reference_effects.region_changes);
                let impulses = |e: &Effects| e.impulses.iter()
                    .map(|i| (i.owner, i.point, i.impulse)).collect::<Vec<_>>();
                assert_eq!(impulses(&effects), impulses(&reference_effects));
                assert_eq!(serde_json::to_value(&effects.detonations).unwrap(),
                    serde_json::to_value(&reference_effects.detonations).unwrap());
                if !alive { break; }
            }
            assert_eq!(damage.stats.impacts, 1);
            assert_eq!(damage.module(1).unwrap().health == 110.0, shooter == Some(8));
            assert!(!effects.events.is_empty());
        }
    }
    #[test]
    fn a_primary_ap_contact_tells_its_origin_and_a_fragment_tells_none() {
        for source in [Some(7), Some(8), None] {
            let (mut state, mut p, mut damage, mut geometry, mut effects) =
                primary_audit_fixture(source, Ammo::Ap, true);
            let hit = geometry
                .raycast(p.point, point(1.0, 3.0), &RayOptions::default())
                .unwrap();
            state.resolve_impact(&[],
                &hit,
                &mut p,
                point(1.0, 0.0),
                false,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut effects,
                0.25,
            );
            assert_eq!(damage.stats.impacts, 1);
            let loss = 110.0 - damage.module(1).unwrap().health;
            assert!(loss > 0.0);
            assert_eq!(effects.events.iter().find(|e| e["type"] == "module").unwrap()["damage"], json!(loss));
            for event in effects
                .events
                .iter()
                .filter(|e| e["projectileId"] == "shot-77")
            {
                assert_eq!(event["primaryContact"], true);
                assert_eq!(event["shooterActor"], json!(source));
                assert_eq!(event["targetActor"], 7);
                assert_eq!(event["emitterOwner"], 90);
            }
        }
        let (mut state, mut p, mut damage, mut geometry, mut effects) =
            primary_audit_fixture(Some(7), Ammo::Ap, true);
        p.fragment = true;
        p.spall = true;
        let hit = geometry
            .raycast(p.point, point(1.0, 3.0), &RayOptions::default())
            .unwrap();
        state.resolve_impact(&[],
            &hit,
            &mut p,
            point(1.0, 0.0),
            false,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut effects,
            0.25,
        );
        assert!(damage.module(1).unwrap().health < 110.0);
        assert_eq!(damage.stats.impacts, 0);
        assert!(
            effects
                .events
                .iter()
                .all(|e| e.get("shooterActor").is_none()),
            "a fragment's material owner cannot stand in for its original attacker"
        );
    }
    #[test]
    fn primary_he_contact_is_attributed_without_changing_headless_physics() {
        let mut results = Vec::new();
        for visual in [false, true] {
            let (mut state, mut p, mut damage, mut geometry, mut effects) =
                primary_audit_fixture(Some(7), Ammo::He, visual);
            assert!(!state.move_projectile(&[],
                &mut p,
                |_| false,
                1.0 / 60.0,
                0.0,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut effects
            ));
            assert_eq!(damage.stats.impacts, 1);
            assert_eq!(damage.module(1).unwrap().health, 110.0);
            assert_eq!(state.pending_blasts.len(), 1);
            let blast = state.pending_blasts.front().unwrap();
            assert_eq!(blast.source, Some(1));
            assert_eq!(blast.actor, Some(7));
            assert_eq!(blast.details["projectileId"], "shot-77");
            assert_eq!(blast.details["emitterOwner"], 90);
            assert_eq!(blast.details["shooterActor"], 7);
            assert_eq!(blast.details["targetActor"], 7);
            assert_eq!(blast.details["primaryContact"], true);
            let contacts: Vec<_> = effects
                .events
                .iter()
                .filter(|e| e["type"] == "primary-contact")
                .collect();
            assert_eq!(contacts.len(), if visual { 1 } else { 0 });
            if visual {
                assert_eq!(contacts[0]["owner"], 1);
                assert_eq!(contacts[0]["projectileId"], "shot-77");
                assert_eq!(contacts[0]["result"], "detonation");
            }
            let impulse = &effects.impulses[0];
            results.push((
                p.to_value(),
                damage.modules[0].to_value(),
                damage.stats.to_value(),
                state.random.state,
                blast.point,
                blast.power,
                blast.radius,
                impulse.owner,
                impulse.point,
                impulse.impulse,
            ));
        }
        assert_eq!(
            results[0], results[1],
            "diagnostic events cannot influence mechanics/RNG"
        );
    }
    fn gun_chord_fixture(x: f64, grazing: bool) -> (Projectile, DamageState, Geometry) {
        // The backwards shot crosses the exposed tube and then the receiver;
        // the forward shot enters the receiver first and leaves through its open bore.
        let angle=if grazing{std::f64::consts::PI}else{0.0};
        let value = json!({"kind":"weapon","weaponPreset":"m2hb","x":x,"y":10,"angle":angle,
            "health":220,"maxHealth":220,"physicalMass":40,
            "barrelAngle":angle+0.00025,"receiverMm":8,"barrelMm":5});
        let module = crate::game_damage::fixtures::module(1, 0, &value);
        // Start 30 mm behind the admitted receiver, as the original specimen did.
        let rear_start = -module.width - 0.03;
        let mut geometry = Geometry::new();
        geometry.upsert(1, EntityGeometry::from_module(&module));
        let mut damage = DamageState::default();
        damage.insert_module(module);
        let projectile = Projectile::from_value(&json!({"x":x+if grazing{-1.15}else{rear_start},
            "y":10.0-if grazing{0.02158}else{0.0},"vx":850,"vy":if grazing{-1.06}else{0.0},
            "power":35,"mass":0.05,"caliberMm":12.7,"radius":0.00635,"life":1,"ammo":"ap","weapon":"machinegun"})).unwrap();
        (projectile, damage, geometry)
    }
    fn emitted_round_fixture() -> (Projectile, DamageState, Geometry) {
        let value = json!({"kind":"weapon","weaponPreset":"m2hb","x":0,"y":10,
            "health":220,"maxHealth":220,
            "barrelAngle":0,"receiverMm":8,"barrelMm":5});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Module, &value)
                .unwrap(),
        );
        // The round leaves a hand inside the muzzle of the M2, 0.88 m before its trunnion.
        let p = Projectile::from_value(&json!({"x":0.87,"y":10,"vx":120,"vy":0,
            "actor":7,"power":35,"mass":0.05,"caliberMm":12.7,"radius":0.00635,"life":1,
            "weapon":"machinegun","emitter":true,"emitterOwners":[1]})).unwrap();
        (p, damage, geometry)
    }
    #[test]
    fn emitted_round_escapes_own_barrel_at_60hz_and_240hz_without_hitting_it() {
        for dt in [1.0 / 60.0, 1.0 / 240.0] {
            for ammo in [Ammo::Ap, Ammo::He] {
                let (mut p, mut damage, mut geometry) = emitted_round_fixture();
                p.ammo = ammo;
                let initial=FlightState::new(p.point,p.velocity);
                let free=initial.advance(dt,p.drag);
                assert!(emitter_exit(&p.emitter_ids,&geometry,initial.point,free.point).is_none(),
                    "an exposed tube supplies no initial projectile material chord");
                let mut state = ProjectileState::default();
                assert!(state.move_projectile(&[],
                    &mut p,
                    |_| false,
                    dt,
                    0.0,
                    &mut damage,
                    &mut geometry,
                    &Terrain::new("flat").unwrap(),
                    &mut Effects::new(true)
                ));
                assert_eq!(damage.stats.impacts, 0);
                assert_eq!(damage.module(1).unwrap().health, 220.0);
                assert_eq!(damage.module(1).unwrap().barrel_damage, 0.0);
                assert!(state.pending_blasts.is_empty());
                assert_eq!(p.point,free.point);
                assert_eq!(p.velocity,free.velocity);
                assert!(p.point.x < 0.87+120.0*dt,"air drag must reduce horizontal travel");
                assert!(p.velocity.x<120.0 && p.velocity.y<0.0);
                if ammo==Ammo::He {assert_eq!(p.power,35.0);}else{
                    assert!(p.power<35.0);
                    assert!((p.power/dot(p.velocity,p.velocity)-35.0/dot(initial.velocity,initial.velocity)).abs()<1e-15);
                }
                assert!(!p.emitter, "there is no initial real material to protect");
            }
        }
    }
    #[test]
    fn slow_round_keeps_receiver_chord_immunity_only_until_geometric_exit() {
        let (mut p, mut damage, mut geometry) = emitted_round_fixture();
        p.point.x = -0.09;
        p.velocity.x = 2.0;
        let mut state = ProjectileState::default();
        let terrain = Terrain::new("flat").unwrap();
        let mut effects = Effects::new(true);
        for step in 0..4 {
            assert!(state.move_projectile(&[],
                &mut p,
                |_| false,
                1.0 / 60.0,
                step as f64 / 60.0,
                &mut damage,
                &mut geometry,
                &terrain,
                &mut effects
            ));
            if step < 2 {
                assert!(
                    p.emitter,
                    "no fixed age window may expire inside the initial receiver material"
                );
            }
        }
        assert!(!p.emitter);
        assert_eq!(damage.stats.impacts, 0);
        assert_eq!(damage.module(1).unwrap().barrel_damage, 0.0);
        p.point = point(1.2, 10.0);
        p.velocity = point(-120.0, 0.0);
        state.move_projectile(&[],
            &mut p,
            |_| false,
            1.0 / 60.0,
            4.0 / 60.0,
            &mut damage,
            &mut geometry,
            &terrain,
            &mut effects,
        );
        assert_eq!(
            damage.stats.impacts, 1,
            "a returning round can hit its emitting gun"
        );
        assert_eq!(damage.module(1).unwrap().barrel_damage, 0.0,
            "returning through the tube cannot damage it");
        assert!(damage.module(1).unwrap().health < 220.0,
            "the physical receiver behind the tube remains vulnerable");
    }
    #[test]
    fn initial_barrel_immunity_does_not_protect_other_parts_of_the_shooting_actor() {
        let (mut p, mut damage, mut geometry) = emitted_round_fixture();
        p.ammo = Ammo::He;
        let value = json!({"kind":"engine","x":1.2,"y":10,"width":0.2,"height":1,
            "health":110,"maxHealth":110,"physicalMass":100});
        damage.insert_module(crate::game_damage::fixtures::module(2, 7, &value));
        geometry.upsert(
            2,
            crate::game_damage::fixtures::geometry(2, 7, EntityKind::Module, &value)
                .unwrap(),
        );
        let mut state = ProjectileState::default();
        assert!(!state.move_projectile(&[],
            &mut p,
            |_| false,
            1.0 / 60.0,
            0.0,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut Effects::new(true)
        ));
        assert_eq!(damage.stats.impacts, 1);
        assert_eq!(state.pending_blasts.front().unwrap().source, Some(2));
        assert_eq!(damage.module(1).unwrap().barrel_damage, 0.0);
        assert!(!p.emitter);
    }
    #[test]
    fn crossing_a_tube_before_the_receiver_spends_only_the_receiver_material() {
        for x in [0.0, 23.6023817405, -23.6023817405, 800.0] {
            let (mut projectile, mut damage, mut geometry) = gun_chord_fixture(x, true);
            let mut effects = Effects::new(true);
            assert!(ProjectileState::default().move_projectile(&[],
                &mut projectile,
                |_| false,
                1.0 / 240.0,
                0.0,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut effects
            ));
            let hits: Vec<_> = effects
                .events
                .iter()
                .filter(|e| e["type"] == "module")
                .collect();
            assert_eq!(hits.len(), 1, "only the receiver supplies a ballistic chord at {x}");
            assert!(hits.iter().all(|e| e["penetrated"] == true));
            assert_eq!(
                damage.stats.impacts, 1,
                "owner statistics are still deduplicated"
            );
            assert_eq!(
                damage.stats.penetrations, 1,
                "the drawn tube spends no power"
            );
            assert!(projectile.power > 20.0 && projectile.power < 35.0);
            let module=damage.module(1).unwrap();
            let contacts=hits.iter().map(|hit|Point::from_value(hit)).collect::<Vec<_>>();
            assert!(!module.barrel_strike(contacts[0]),"the contact is the receiver at {x}: {hits:?}");
            let receiver_loss=module.strike_damage(contacts[0],hits[0]["power"].as_f64().unwrap(),true);
            assert!(receiver_loss > 0.0);
            assert!((module.health-(220.0-receiver_loss)).abs()<1e-9,
                "only the real receiver contact inflicts damage at {x}");
            assert_eq!(module.barrel_damage, 0.0);
        }
    }
    #[test]
    fn partial_transit_charges_connected_gun_chord_once() {
        let (mut projectile, mut damage, mut geometry) = gun_chord_fixture(23.6023817405, false);
        let mut state = ProjectileState::default();
        let terrain = Terrain::new("flat").unwrap();
        let mut effects = Effects::new(true);
        for i in 0..4 {
            assert!(state.move_projectile(&[],
                &mut projectile,
                |_| false,
                0.0001,
                i as f64 * 0.0001,
                &mut damage,
                &mut geometry,
                &terrain,
                &mut effects
            ));
        }
        assert_eq!(
            projectile.crossed_layers.len(),
            1,
            "charged chord retained during partial transit"
        );
        let health = damage.module(1).unwrap().health;
        let power = projectile.power;
        let power_per_speed2=power/dot(projectile.velocity,projectile.velocity);
        // Defeat during a paid partial transit changes only subsequent material:
        // the same already-spent round now flies exactly as through empty geometry.
        let (mut departed, mut air) = (projectile.clone(), projectile.clone());
        air.crossed_layers.clear();
        let mut no_material = Geometry::new();
        let mut no_damage = DamageState::default();
        let mut after_defeat = Effects::new(true);
        assert!(state.move_projectile(&[0], &mut departed, |_| false, 0.0001, 0.0004,
            &mut damage, &mut geometry, &terrain, &mut after_defeat));
        assert!(ProjectileState::default().move_projectile(&[], &mut air, |_| false, 0.0001, 0.0004,
            &mut no_damage, &mut no_material, &terrain, &mut Effects::default()));
        assert_eq!(departed.point, air.point); assert_eq!(departed.velocity, air.velocity);
        assert_eq!(departed.power.to_bits(), air.power.to_bits());
        assert!(departed.crossed_layers.is_empty()); assert!(after_defeat.events.is_empty());
        assert_eq!(damage.module(1).unwrap().health, health);
        for i in 4..30 {
            assert!(state.move_projectile(&[],
                &mut projectile,
                |_| false,
                0.0001,
                i as f64 * 0.0001,
                &mut damage,
                &mut geometry,
                &terrain,
                &mut effects
            ));
        }
        assert_eq!(
            effects
                .events
                .iter()
                .filter(|e| e["type"] == "module")
                .count(),
            1
        );
        assert_eq!(damage.stats.penetrations, 1);
        assert_eq!(damage.module(1).unwrap().health, health);
        assert!(projectile.power<power);
        assert!((projectile.power/dot(projectile.velocity,projectile.velocity)-power_per_speed2).abs()<1e-12,
            "only flight energy changed during the already charged material chord");
        assert!(
            projectile.crossed_layers.is_empty(),
            "charged chord retired after exit"
        );
    }
    #[test]
    fn secondary_damage_cannot_exceed_kinetic_energy() {
        assert_eq!(secondary_power(100.0, 0.01, point(2.0, 0.0)), 0.0001);
        assert_eq!(secondary_power(-10.0, 0.01, point(100.0, 0.0)), 0.0);
    }
    #[test]
    fn random_matches_javascript_mulberry32() {
        let mut r = Random::new(6173);
        assert_eq!(r.next(), 0.4512807675637305);
    }
    #[test]
    fn airborne_flight_loses_ap_energy_without_changing_he_fill() {
        let mut state = ProjectileState::default();
        let mut p = Projectile::from_value(
            &json!({"x":0,"y":10,"vx":100,"vy":20,"power":10,"mass":1,"caliberMm":20,"life":10}),
        ).unwrap();
        let initial=p.clone();
        let mut d = DamageState::default();
        let mut geometry = Geometry::new();
        let terrain = Terrain::new("flat").unwrap();
        let dt = 1.0 / 60.0;
        assert!(state.move_projectile(&[],
            &mut p,
            |_| false,
            dt,
            0.0,
            &mut d,
            &mut geometry,
            &terrain,
            &mut Effects::default()
        ));
        assert!(p.point.x<100.0*dt);
        assert!(p.velocity.x<100.0);
        assert!(p.power<initial.power);
        assert!((p.power/initial.power-dot(p.velocity,p.velocity)/dot(initial.velocity,initial.velocity)).abs()<1e-12);
        let mut he=initial.clone();he.ammo=Ammo::He;
        assert!(state.move_projectile(&[], &mut he,|_| false,dt,0.0,&mut d,&mut geometry,&terrain,&mut Effects::default()));
        assert_eq!(he.power,initial.power);
        assert_eq!(he.point,p.point);assert_eq!(he.velocity,p.velocity);
    }
    #[test]
    fn ground_ricochet_reports_contact_before_separation_and_retains_bounces() {
        let mut state = ProjectileState::default();
        let mut p = Projectile::from_value(&json!({
            "x":0,"y":0.1,"vx":120,"vy":-12,"power":100,"mass":0.1,"caliberMm":20,"life":5
        })).unwrap();
        let mut damage = DamageState::default();
        let mut geometry = Geometry::new();
        let terrain = Terrain::new("flat").unwrap();
        let mut effects = Effects::new(true);
        assert!(state.move_projectile(&[],
            &mut p,
            |_| false,
            0.02,
            0.0,
            &mut damage,
            &mut geometry,
            &terrain,
            &mut effects
        ));
        let event = effects
            .events
            .iter()
            .find(|e| e["type"] == "ricochet")
            .unwrap();
        assert_eq!(event["y"], 0.0);
        assert_eq!(event["nx"], 0.0);
        assert_eq!(event["ny"], 1.0);
        assert!(p.point.y >= 0.009);
        assert_eq!(p.ground_bounces, 1);
        assert_eq!(p.to_value()["groundBounces"], 1);
        assert_eq!(damage.stats.ricochets, 1);
        let energy_after = 0.5 * p.mass * dot(p.velocity, p.velocity);
        assert!(energy_after < 0.5 * 0.1 * (120.0 * 120.0 + 12.0 * 12.0));
    }

    /// One round of `ammo` fired level from `from` metres short of steel plates `thickness` mm thick standing at `xs`,
    /// `lean` radians from upright, followed for 0.4 s: the plates it went through and glanced off, the blasts it
    /// made and the power it had at the end.
    fn strike(ammo: &str, from: f64, xs: &[f64], thickness: f64, lean: f64) -> (Value, Vec<Blast>, f64) {
        let mut damage = DamageState::default();
        let mut geometry = Geometry::new();
        for (i, x) in xs.iter().enumerate() {
            let owner = i as u32 + 1;
            let value = json!({"x":x,"y":2,"angle":std::f64::consts::FRAC_PI_2-lean,"length":2,
                "thicknessMm":thickness,"material":"steel"});
            damage.insert_plate(crate::game_damage::fixtures::plate(owner, 7, &value));
            geometry.upsert(owner, crate::game_damage::fixtures::geometry(owner, 7, EntityKind::Plate, &value).unwrap());
        }
        let mut state = ProjectileState::default();
        state.projectiles.push(Projectile::from_value(&json!({"numericId":1000,"x":-from,"y":2,"vx":300,"vy":0,
            "mass":2,"caliberMm":84,"power":300,"radius":0.01,"blastRadius":0.7,"weapon":"rocket","ammo":ammo})).unwrap());
        let (terrain, mut effects, dt) = (Terrain::new("flat").unwrap(), Effects::new(false), 1.0 / 120.0);
        for step in 0..48 {
            state.step(dt, step as f64 * dt, &Sides::default(), &mut damage, &mut geometry, &terrain, &mut effects);
        }
        let power = state.projectiles.first().map_or(0.0, |p| p.power);
        let stats = json!({"penetrations":damage.stats.penetrations,"ricochets":damage.stats.ricochets});
        (stats, state.pending_blasts.into_iter().collect(), power)
    }
    #[test]
    fn a_shaped_charge_pierces_as_much_at_any_range_and_spaced_armour_spends_its_jet() {
        // In the air a kinetic round loses what it pierces as it slows; a shaped charge keeps it.
        assert_eq!(strike("heat", 50.0, &[], 60.0, 0.0).2, 300.0);
        assert!(strike("ap", 50.0, &[], 60.0, 0.0).2 < 290.0);
        // Where it strikes it bursts once, with a share of its power, as far as its blast reaches, near or far.
        for from in [5.0, 60.0] {
            let (_, blasts, _) = strike("heat", from, &[0.0], 60.0, 0.0);
            assert_eq!(blasts.len(), 1);
            assert_eq!((blasts[0].power, blasts[0].radius, blasts[0].source), (300.0 * HEAT_BLAST_SHARE, 0.7, Some(1)));
            assert_eq!(blasts[0].details["shaped"], true);
        }
        // Two plates together: the jet goes through both. The same two a metre apart: the jet spends half of
        // itself in the gap and the second holds. A kinetic round of the same power goes through both either way.
        assert_eq!(strike("heat", 5.0, &[0.0, 0.12], 100.0, 0.0).0["penetrations"], 2);
        assert_eq!(strike("heat", 5.0, &[0.0, 1.0], 100.0, 0.0).0["penetrations"], 1);
        assert_eq!(strike("ap", 5.0, &[0.0, 1.0], 100.0, 0.0).0["penetrations"], 2);
        // Armour struck at a grazing angle turns a kinetic round aside; a shaped charge bursts on it all the same.
        let lean = 80f64.to_radians();
        assert_eq!(strike("ap", 5.0, &[0.0], 60.0, lean).0["ricochets"], 1);
        let (stats, blasts, _) = strike("heat", 5.0, &[0.0], 60.0, lean);
        assert_eq!((stats["ricochets"].as_u64(), blasts.len()), (Some(0), 1));
    }
}

#[cfg(test)]
#[path = "game_projectile_budget_tests.rs"]
mod budget_tests;
