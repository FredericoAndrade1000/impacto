//! One persistent, authoritative mechanical scene for Wasm and native workers.
//! JSON is admitted at construction/input boundaries; substeps use typed state.
use crate::game_damage::{BARREL_DISABLED_SHARE, DamageState, Effects, Module, Plate};
use crate::game_geometry::{
    Bounds, ComponentKind, EntityGeometry, EntityKind, Geometry, Point, Pose, RayOptions, Terrain, cos, hypot,
    number, sin,
};
use crate::game_motion::{
    DriveState, GearState, Hitch, Lead, Pace, Powertrain, SPRING_REST, ServoState,
    advance_servo, fuel_flow, gear_rim, track_stand,
};
use crate::game_air::{HullAir, Piece};
use crate::game_flight::Drag;
use crate::game_projectiles::{Ammo, Line, LineOfFire, Projectile, ProjectileState, Sides, first_contact_near, line_of_fire};
use crate::game_scripted::PilotState;
use crate::game_shot_budget::{Airborne, ShotBudget};
use crate::game_sensors::{
    Armour, Cover, Eye, SensorActor, SensorHit, SensorMemory, SensorModule, SensorQuery,
    SensorWeather, VehicleReading,
};
use crate::game_weapons::{Sector, Settings, angle_difference, laying, muzzle_point, solution_with_motion};
use crate::{NativeWorld, array, integer};
use rapier2d_f64::prelude::{MassProperties as RigidMass, Vector};
#[cfg(test)]
use crate::game_sensors::TerrainReading;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
/// What the sensors of a game look at, as `$view`: its constructions and their pieces as they were last read, the
/// weather, and the rays a look casts into the ground and into the material. It is put together here alone, and by
/// a macro rather than a method, so that it borrows those fields only: the sensors' memory stays free to take in
/// what they see.
macro_rules! sensor_view {
    ($game:expr => $view:ident) => {
        let query = $crate::game::Query { geometry: &$game.geometry, terrain: &$game.terrain };
        let $view = $crate::game_sensors::SensorView {
            time: $game.time,
            seed: $game.seed,
            weather: $game.weather,
            actors: &$game.sensor_actors,
            modules: &$game.sensor_modules,
            query: &query,
        };
    };
}

#[cfg(test)]
#[path = "game_blast_chain_tests.rs"]
mod blast_chain_tests;
#[cfg(test)]
#[path = "game_mount_tests.rs"]
mod mount_tests;
#[cfg(test)]
#[path = "game_servo_tests.rs"]
mod servo_tests;
#[cfg(test)]
#[path = "game_sides_tests.rs"]
mod sides_tests;
#[cfg(test)]
#[path = "game_restore_tests.rs"]
mod restore_tests;
#[cfg(test)]
#[path = "game_shot_budget_tests.rs"]
mod shot_budget_tests;
#[cfg(test)]
#[path = "game_towing_tests.rs"]
mod towing_tests;
#[cfg(test)]
#[path = "game_hover_tests.rs"]
mod hover_tests;
#[cfg(test)]
#[path = "game_sling_tests.rs"]
mod sling_tests;
#[cfg(test)]
#[path = "game_air_tests.rs"]
mod air_tests;
#[cfg(test)]
#[path = "game_atmosphere_tests.rs"]
mod atmosphere_tests;
#[cfg(test)]
#[path = "game_feed_tests.rs"]
mod feed_tests;
#[path = "game_commands.rs"]
mod commands;
#[path = "game_input.rs"]
mod input;
#[path = "game_pilot.rs"]
mod pilot;
#[path = "game_frame.rs"]
mod frame;
#[path = "game_install.rs"]
mod install;
#[path = "game_towing.rs"]
mod towing;
#[path = "game_contact_damage.rs"]
mod contact_damage;

fn id(v: &Value, key: &str) -> u32 {
    v[key].as_u64().unwrap_or(0) as u32
}
fn text<'a>(v: &'a Value, key: &str, default: &'a str) -> &'a str {
    v[key].as_str().unwrap_or(default)
}
// Select the existing nearest branch, then anchor it to the physical phase.
// Repeated reads of one phase cannot accumulate trig roundoff in the old angle.
fn unwrap_angle(phase: f64, previous: f64) -> f64 {
    let nearest = previous + angle_difference(phase, previous);
    let turns = ((nearest - phase) / std::f64::consts::TAU).round();
    if turns == 0.0 { phase } else { phase + turns * std::f64::consts::TAU }
}
fn body_pose(core: &NativeWorld, body: u32) -> Option<Pose> {
    let b = core.world.bodies.get(*core.bodies.get(&body)?)?;
    let p = b.translation();
    Some(Pose {
        x: p.x,
        y: p.y,
        angle: b.rotation().angle(),
    })
}
#[cfg(test)]
fn compose(parent: Pose, local: Pose) -> Pose {
    let p = parent.world_point(Point::new(local.x, local.y));
    Pose {
        x: p.x,
        y: p.y,
        angle: parent.angle + local.angle,
    }
}
/// Immutable readings shared by consecutive bindings of the same rigid body.
/// This cache lives only within one synchronization; no mutation is skipped.
#[derive(Clone, Copy)]
struct BodyReading {
    pose: Pose,
    cosine: f64,
    sine: f64,
    velocity: Point,
    omega: f64,
    mass_center: Point,
    sleeping: bool,
}
impl BodyReading {
    fn read(core: &NativeWorld, id: u32) -> Option<Self> {
        let body = core.world.bodies.get(*core.bodies.get(&id)?)?;
        let position = body.translation();
        let angle = body.rotation().angle();
        let velocity = body.linvel();
        let center = body.center_of_mass();
        Some(Self {
            pose: Pose {
                x: position.x,
                y: position.y,
                angle,
            },
            cosine: cos(angle),
            sine: sin(angle),
            velocity: Point::new(velocity.x, velocity.y),
            omega: body.angvel(),
            mass_center: Point::new(center.x, center.y),
            sleeping: body.is_sleeping(),
        })
    }
    fn compose(self, local: Pose) -> Pose {
        // Preserve Pose::world_point's arithmetic order, including signed zero.
        Pose {
            x: self.pose.x + self.cosine * local.x - self.sine * local.y,
            y: self.pose.y + self.sine * local.x + self.cosine * local.y,
            angle: self.pose.angle + local.angle,
        }
    }
}
// The bearings a mounted gun can take: the travel of its mount about the axis it was built on.
fn mount_sector(module: &Module) -> Option<Sector> {
    module.mount.as_ref().map(|mount| Sector { axis: module.pose.angle, min: mount.min, max: mount.max })
}
// How far from an end of the ground an enclosed field stops a vehicle.
const WORLD_EDGE: f64 = 10.0;
/// How far above or below the field an aim may be put, in metres: far above the top of any
/// arc and far under the lowest ground. The page and the server hold the same number
/// (AIM_SKY in battle-rules.js).
const AIM_SKY: f64 = 50000.0;
/// The step a round flies its chords by: the one the game takes (`GameState::step`).
const ROUND_STEP: f64 = 1.0 / 60.0;
/// The most rounds one gun fires in a step: four, past the fastest rate a gun may have (`MAX_RATE`).
const MOST_ROUNDS_A_STEP: usize = 4;
// Retain fractional-frame reload phase only for an uninterrupted held trigger.
// A blocked attempt or released trigger cannot bank a future burst.
fn advance_cooldown(cooldown: f64, dt: f64, held: bool) -> f64 {
    let remaining = cooldown - dt;
    if held && cooldown > 0.0 {
        remaining.max(-dt)
    } else {
        remaining.max(0.0)
    }
}
/// The rounds each construction's boxes that work hold of each cartridge, by its handle and the cartridge's name: what
/// its guns may fire (`DamageState::consume_round`).
fn rounds_aboard(damage: &DamageState) -> HashMap<(u32, &str), u32> {
    let mut aboard = HashMap::new();
    for m in &damage.modules {
        if m.kind == ComponentKind::Ammo && m.usable() && m.rounds > 0 {
            *aboard.entry((m.actor, m.ammo_preset.as_str())).or_insert(0) += m.rounds;
        }
    }
    aboard
}
/// The rounds of its cartridge the boxes of the construction of the gun `gun` hold, of those `rounds_aboard` counted: none
/// for a gun whose compartment of ready rounds was wrecked (`Module::belt_cut`), which can hold none.
fn aboard_for(aboard: &HashMap<(u32, &str), u32>, gun: &Module) -> u32 {
    if gun.belt_cut { return 0; }
    // A gun of the catalogue fires rounds of its own name; one made over, those its name makes (game_variant.rs).
    let cartridge = if gun.weapon_preset.contains('|') { std::borrow::Cow::Owned(crate::game_variant::cartridge(&gun.weapon_preset)) }
        else { std::borrow::Cow::Borrowed(gun.weapon_preset.as_str()) };
    aboard.get(&(gun.actor, &*cartridge)).copied().unwrap_or(0)
}
/// How much what a construction carries may change, in kilograms, before its body is weighed
/// again: the fuel it burnt, the rounds it fired, the cargo it took on or put down.
const LOAD_STEP: f64 = 20.0;
// A change of velocity too small to matter is not written: writing takes the
// body mutably and has its joint assembly made again for nothing.
fn drive_velocity_change(current: Vector, target: Point) -> Option<Vector> {
    ((current.x - target.x).abs() + (current.y - target.y).abs() > 1e-5)
        .then(|| Vector::new(target.x, target.y))
}
fn set_mass(core: &mut NativeWorld, id: u32, mass: f64, center: Point, inertia: f64) {
    let Some(body) = core
        .bodies
        .get(&id)
        .and_then(|h| core.world.bodies.get_mut(*h))
    else {
        return;
    };
    let old = body.center_of_mass();
    let velocity = body.linvel();
    let omega = body.angvel();
    body.set_additional_mass_properties(
        RigidMass::new(
            Vector::new(center.x, center.y),
            mass,
            inertia,
        ),
        false,
    );
    body.recompute_mass_properties_from_colliders(&core.world.colliders);
    let new = body.center_of_mass();
    body.set_linvel(
        Vector::new(
            velocity.x - omega * (new.y - old.y),
            velocity.y + omega * (new.x - old.x),
        ),
        false,
    );
}

#[derive(Clone, Serialize, Deserialize)]
struct Binding {
    owner: u32,
    body: u32,
    local: Pose,
    colliders: Vec<u32>,
    last_revision: u64,
    last_marks: u64,
    age: f64,
    sleeping: bool,
}
// Another gun of the vehicle laid and fired along with the one the actor leads
// with: its own aim and settings, its own trigger and its own waiting shot.
#[derive(Clone, Serialize, Deserialize)]
struct Extra {
    aim: Point,
    settings: Settings,
    held: bool,
    pending: Option<f64>,
}
// What makes two layings of a gun the same shot: a waiting shot survives only these.
const SHOT_KEYS: [&str; 9] = [
    "preset",
    "componentId",
    "ammo",
    "trajectory",
    "platform",
    "aimAngle",
    "charge",
    "fuzeTime",
    "detonation",
];
fn same_shot(aim: Point, s: &Settings, old_aim: Point, old: &Settings) -> bool {
    hypot(aim.x - old_aim.x, aim.y - old_aim.y) <= 1e-6
        && SHOT_KEYS.iter().all(|key| s.value[*key] == old.value[*key])
}
#[derive(Clone, Serialize, Deserialize)]
struct Actor {
    handle: u32,
    id: String,
    team: String,
    cold: Value,
    body: u32,
    contact_contours: Option<Vec<Vec<Point>>>,
    drive: Option<DriveState>,
    powertrain: Powertrain,
    hull: HullAir,
    // The reload of the bench launcher. A mounted gun keeps its own, with its servo.
    cooldown: f64,
    shots: u64,
    aim: Point,
    weapon: Option<Settings>,
    trigger: Option<(Point, Settings)>,
    pending: Option<(Point, Settings, f64)>,
    also: Vec<Extra>,
    launcher: Point,
    last_weapon: String,
    defeated: bool,
    message_until: f64,
    /// The wear its armour had when the covers of its optics were worked out, and what it sees
    /// with: its optics that work and see out to a side, as the last step or question left them.
    armour: Option<u64>,
    eyes: Vec<Eye>,
    /// Whether its base shelters it (`setActorState`): no round, fragment or blast harms or pushes it, as none of an
    /// ally's does (`Sides`), and its guns put no round in the air.
    #[serde(default)]
    sheltered: bool,
}
impl Actor {
    // Let go of every trigger and waiting shot; the guns stay laid where they are.
    fn release(&mut self, cancel: bool) {
        self.trigger = None;
        if cancel {
            self.pending = None;
        }
        for e in &mut self.also {
            e.held = false;
            if cancel {
                e.pending = None;
            }
        }
    }
    fn vehicle_reading(&self) -> Option<VehicleReading> {
        self.drive.as_ref().map(|d| VehicleReading {
            x: d.pose.x,
            y: d.pose.y,
            vx: d.velocity.x,
            vy: d.velocity.y,
            angle: d.pose.angle,
            throttle: d.throttle,
            engine: self.powertrain.power_kw > 0.0,
        })
    }
}
#[derive(Clone, Serialize, Deserialize)]
struct GearBinding {
    owner: u32,
    travel: f64,
    /// Where its springs have it from where it was built: how far towards the hull, and how far
    /// turned against it. And how much of its travel they have taken: none where it hangs let go,
    /// all of it on its stop.
    displacement: f64,
    tilt: f64,
    compression: f64,
    angle: f64,
    angular_speed: f64,
    /// How far its drivetrain had turned it when it was last looked at: the travel of its vehicle and what it slipped.
    last_turned: f64,
    /// Whether the ground turns it: off the ground it turns of itself, with what speed it has left.
    touching: bool,
}
#[derive(Serialize, Deserialize)]
pub struct GameState {
    actors: Vec<Actor>,
    #[serde(default)]
    tows: Vec<towing::Tow>,
    bindings: Vec<Binding>,
    gear_bindings: Vec<GearBinding>,
    gears: Vec<GearState>,
    servos: Vec<ServoState>,
    pub damage: DamageState,
    // Queries are rebuilt from the admitted material when a saved world is taken back.
    #[serde(skip)]
    pub geometry: Geometry,
    // The ground does not change: a world taking a state written out has it already (`adopt`).
    #[serde(skip)]
    pub terrain: Terrain,
    projectiles: ProjectileState,
    // What a world is loaded with, and keeps whatever state it takes (`adopt`).
    #[serde(skip)]
    catalogue: Value,
    #[serde(skip)]
    mount_catalogue: Value,
    time: f64,
    tick: u64,
    recoveries: u64,
    visual: bool,
    enclosed: bool,
    // Spans stay fixed for a tick even as a gun turns. Keep that phase across a resume,
    // ordering the map only when saving so its hash seed cannot change the saved bytes.
    #[serde(serialize_with = "serialize_extents")]
    extents: (u64, HashMap<u32, Bounds>),
    seed: u32,
    weather: SensorWeather,
    sensors: SensorMemory,
    events: Vec<Value>,
    bounds: Bounds,
    sensor_actors: Vec<SensorActor>,
    sensor_modules: Vec<SensorModule>,
    scripted: HashMap<u32, PilotState>,
    module_exports: Vec<frame::ModuleExport>,
    told: frame::Told,
    /// The numbers of the last live frame, until the host takes them (`take_block`).
    #[serde(skip)]
    frame_block: Vec<f64>,
    // What a shared field lets each side have in the air (game_shot_budget.rs), the field's to say and not kept with the
    // state, and what each side and construction has there: the rounds in the air, counted over at the end of each step
    // and as a state is taken back, and added to as each is fired.
    #[serde(skip)]
    shot_budget: Option<ShotBudget>,
    #[serde(skip)]
    airborne: Airborne,
}
fn serialize_extents<S: serde::Serializer>(extents: &(u64, HashMap<u32, Bounds>), serializer: S) -> Result<S::Ok, S::Error> {
    let ordered: std::collections::BTreeMap<_, _> = extents.1.iter().collect();
    (extents.0, ordered).serialize(serializer)
}
impl GameState {
    /// This game as a state written out of it reads back (`export_state`), without writing it: what a written state
    /// leaves out is left out, for `adopt` to take from the world that takes it. Every field is named, so that a new
    /// one is written here as well as in the state.
    #[cfg(not(target_arch = "wasm32"))]
    pub fn written_copy(&self) -> GameState {
        let GameState { actors, tows, bindings, gear_bindings, gears, servos, damage, geometry: _, terrain: _, projectiles,
            catalogue: _, mount_catalogue: _, time, tick, recoveries, visual, enclosed, extents, seed, weather, sensors, events,
            bounds, sensor_actors, sensor_modules, scripted, module_exports, told, frame_block: _, shot_budget: _, airborne: _ } = self;
        GameState {
            actors: actors.clone(),
            tows: tows.clone(),
            bindings: bindings.clone(),
            gear_bindings: gear_bindings.clone(),
            gears: gears.clone(),
            servos: servos.clone(),
            damage: damage.clone(),
            geometry: Default::default(),
            terrain: Default::default(),
            projectiles: projectiles.written_copy(),
            catalogue: Default::default(),
            mount_catalogue: Default::default(),
            time: *time,
            tick: *tick,
            recoveries: *recoveries,
            visual: *visual,
            enclosed: *enclosed,
            extents: extents.clone(),
            seed: *seed,
            weather: weather.clone(),
            sensors: sensors.clone(),
            events: events.clone(),
            bounds: *bounds,
            sensor_actors: sensor_actors.clone(),
            sensor_modules: sensor_modules.clone(),
            scripted: scripted.clone(),
            module_exports: module_exports.clone(),
            told: told.clone(),
            frame_block: Default::default(),
            shot_budget: Default::default(),
            airborne: Default::default(),
        }
    }
    /// Takes the ground and catalogues from the loaded game and rebuilds queries from the saved material: the guns made
    /// over in the workshop its pieces name are made again of the catalogue (game_variant.rs).
    /// Only a native core writes a world out (`export_state`).
    #[cfg(not(target_arch = "wasm32"))]
    pub fn adopt(&mut self, other: &mut GameState) -> Result<(), String> {
        std::mem::swap(&mut self.terrain, &mut other.terrain);
        std::mem::swap(&mut self.catalogue, &mut other.catalogue);
        std::mem::swap(&mut self.mount_catalogue, &mut other.mount_catalogue);
        let named: Vec<String> = self.damage.modules.iter().flat_map(|m| [m.weapon_preset.clone(), m.ammo_preset.clone()]).collect();
        self.ensure_variants(named.iter().map(String::as_str))?;
        for plate in &self.damage.plates {
            self.geometry.upsert(plate.owner, EntityGeometry::from_plate(plate));
        }
        for module in &self.damage.modules {
            self.geometry.upsert(module.owner, EntityGeometry::from_module(module));
            self.geometry.set_active(module.owner, module.attached);
        }
        self.geometry.index();
        self.shot_budget = other.shot_budget;
        self.count_airborne();
        Ok(())
    }
    /// Puts in the catalogue the guns made over in the workshop (game_variant.rs) these names name, made of the guns it has.
    fn ensure_variants<'a>(&mut self, named: impl IntoIterator<Item = &'a str>) -> Result<(), String> {
        named.into_iter().try_for_each(|id| crate::game_variant::ensure(&mut self.catalogue, id))
    }
    pub fn from_value(v: &Value, _core: &NativeWorld) -> Result<Self, String> {
        let terrain = Terrain::from_value(&v["terrain"])?;
        let mut damage = DamageState::default();
        damage.stats = crate::game_damage::CombatStats::from_value(&v["stats"]);
        let geometry = Geometry::new();
        let (actors, bindings, gear_bindings, gears, servos, module_exports) =
            (Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new(), Vec::new());
        let seed = integer(v, "sensorSeed", integer(v, "seed", 6173));
        let bounds = Bounds::from_value(&v["bounds"]);
        let mut game = Self {
            actors,
            tows: Vec::new(),
            bindings,
            gear_bindings,
            gears,
            servos,
            damage,
            geometry,
            terrain,
            projectiles: ProjectileState::from_value(v)?,
            catalogue: v["catalogue"].clone(),
            mount_catalogue:v["mountCatalogue"].clone(),
            time: number(v, "time", 0.0),
            tick: number(v, "tick", 0.0) as u64,
            recoveries: number(v, "recoveries", 0.0) as u64,
            visual: v["visualEvents"] != false,
            enclosed: v["enclosed"] == true,
            extents: (u64::MAX, HashMap::new()),
            seed,
            weather: SensorWeather::from_name(text(v, "weather", "clear")),
            sensors: SensorMemory::default(),
            events: Vec::new(),
            bounds,
            sensor_actors: Vec::new(),
            sensor_modules: Vec::new(),
            scripted: HashMap::new(),
            module_exports,
            told: frame::Told::default(),
            frame_block: Vec::new(),
            shot_budget: ShotBudget::from_value(&v["shotBudget"]),
            airborne: Airborne::default(),
        };
        game.enter(v)?;
        game.update_powertrains();
        game.restore_tows(v)?;
        game.refresh_sensors();
        game.count_airborne();
        Ok(game)
    }
    /// The plates, the pieces and the constructions a scene brings, admitted as they come: all of a scene
    /// when it is loaded, and the one construction that comes to a field that goes on (`admit`).
    fn enter(&mut self, v: &Value) -> Result<(), String> {
        let material = (self.damage.plates.len(),self.damage.modules.len());
        let first_servo = self.servos.len();
        self.ensure_variants(array(v, "modules").iter().flat_map(|m| [&m["weaponPreset"], &m["ammoPreset"]]).filter_map(Value::as_str))?;
        let first_gear = self.gear_bindings.len();
        for value in array(v, "plates") {
            let owner = id(&value, "owner");
            let actor = id(&value, "actor");
            let plate = Plate::from_value(owner, actor, &value)?;
            let geom = EntityGeometry::from_plate(&plate);
            self.bindings.push(Binding {
                owner,
                body: 0,
                local: plate.pose,
                colliders: Vec::new(),
                last_revision: u64::MAX,
                last_marks: u64::MAX,
                age: number(&value, "age", 0.0),
                sleeping: value["sleeping"] == true,
            });
            self.geometry.upsert(owner, geom);
            self.damage.insert_plate(plate);
        }
        for value in array(v, "modules") {
            let owner = id(&value, "owner");
            let actor = id(&value, "actor");
            let mut module = Module::from_value(owner, actor, &value, &self.catalogue, &self.mount_catalogue)?;
            if module.mount.is_some() {
                if value["kind"]!="weapon" {return Err("Only weapons admit mounts".into());}
                let preset=value["weaponPreset"].as_str().ok_or("Missing mounted weapon preset")?;
                crate::game_mounts::admit_runtime(value,&mut module,&self.catalogue[preset],&self.damage.plates[material.0..],actor)?;
            }
            self.bindings.push(Binding {
                owner,
                body: 0,
                local: module.pose,
                colliders: Vec::new(),
                last_revision: 0,
                last_marks: 0,
                age: 0.0,
                sleeping: false,
            });
            self.geometry.upsert(
                owner,
                EntityGeometry::from_module(&module),
            );
            self.geometry.set_active(owner, module.attached);
            if module.kind.gear() {
                self.gears.push(GearState::from_value(owner, &value));
                self.gear_bindings.push(GearBinding {
                    owner,
                    travel: 0.0,
                    displacement: number(&value["suspension"], "displacement", 0.0),
                    tilt: number(&value["suspension"], "tilt", 0.0),
                    compression: 0.0,
                    angle: number(&value, "wheelSpin", 0.0),
                    angular_speed: number(&value, "wheelAngularSpeed", 0.0),
                    last_turned: 0.0,
                    touching: false,
                });
            }
            if module.kind == ComponentKind::Weapon {
                let steel = crate::game_barrel::BarrelSteel::from_catalogue(&self.catalogue[&module.weapon_preset])?;
                let barrel = crate::game_barrel::BarrelState::new(steel, &value, crate::game_barrel::Air::at(module.pose.y, 0.0));
                let mut servo = ServoState::from_value(owner, &value, barrel);
                servo.spin_up = number(&self.catalogue[&module.weapon_preset], "spinUp", 0.0).max(0.0);
                self.servos.push(servo);
            }
            self.damage.insert_module(module);
            self.module_exports.push(frame::ModuleExport::new(owner, &self.servos, &self.gears, &self.gear_bindings));
        }
        // Its guns come loaded from the boxes it came with.
        self.load_guns(first_servo);
        for actor in array(v, "actors") {
            if actor.get("contactContour").is_some() {
                return Err("Unsupported rigid contact contour format".into());
            }
            for key in ["contactContours", "contactVolumes"] {
                if let Some(value) = actor.get(key).filter(|value| !value.is_null()) {
                    let contours = value.as_array().ok_or("Invalid rigid contact contours")?;
                    let mut count = 0;
                    for contour in contours {
                        let points = contour.as_array().ok_or("Invalid rigid contact contour")?;
                        count += points.len();
                        if points.len() < 3 || points.len() > 1024 || points.iter().any(|p| ["x", "y"].iter()
                            .any(|key| p[*key].as_f64().is_none_or(|n| !n.is_finite()))) {
                            return Err("Invalid rigid contact contour".into());
                        }
                    }
                    if contours.len() > 512 || count > 8192 {
                        return Err("Invalid rigid contact contours".into());
                    }
                }
            }
        }
        let mut coming = array(v, "actors")
            .iter()
            .map(|a| Actor {
                handle: id(a, "handle"),
                id: text(a, "id", "local").into(),
                team: text(a, "team", text(a, "ownerId", text(a, "id", "local"))).into(),
                cold: a.clone(),
                body: 0,
                contact_contours: a.get("contactContours").and_then(Value::as_array).map(|contours|
                    contours.iter().map(|contour| contour.as_array().unwrap().iter().map(Point::from_value).collect()).collect()),
                drive: if a["vehicle"].is_object() {
                    Some(DriveState::from_value(id(a, "handle"), &a["vehicle"]))
                } else {
                    None
                },
                powertrain: Powertrain {
                    efficiency: 0.82, rolling_coefficient: 0.018, drag: 1.0, radius: 0.37,
                    ..Default::default()
                },
                hull: HullAir::default(),
                cooldown: number(a, "cooldown", 0.0),
                shots: number(&a["stats"], "shots", 0.0) as u64,
                aim: Point::from_value(&a["aim"]),
                weapon: None,
                trigger: None,
                pending: None,
                also: Vec::new(),
                launcher: Point::from_value(&a["launcher"]),
                last_weapon: text(a, "lastWeapon", "").into(),
                defeated: a
                    .get("defeated")
                    .is_some_and(|x| *x == true || x.is_string()),
                message_until: 0.0,
                armour: None,
                eyes: Vec::new(),
                sheltered: false,
            })
            .collect::<Vec<_>>();
        // Readmission tells the gear on its springs; its rigid binding and mass use where it was built.
        for gear in &self.gear_bindings[first_gear..] {
            let module = self.damage.module_mut(gear.owner).unwrap();
            if let Some(hull) = coming.iter().find(|a| a.handle == module.actor).and_then(|a| a.drive.as_ref()) {
                module.pose.x += sin(hull.pose.angle) * gear.displacement;
                module.pose.y -= cos(hull.pose.angle) * gear.displacement;
                module.pose.angle -= gear.tilt;
            }
        }
        // What each shows the air, read as it was built: its plates as the scene tells them, and its pieces where their
        // bindings hold them, its gear where it was built and not where its springs have it now.
        for actor in &mut coming {
            let plates = json!(array(v, "plates").iter().filter(|p| id(p, "actor") == actor.handle).cloned().collect::<Vec<_>>());
            let pieces = self.damage.modules[material.1..].iter().filter(|m| m.actor == actor.handle && m.attached).map(Piece::of);
            actor.hull = HullAir::read(&plates, pieces, number(&actor.cold, "facing", -1.0), number(&actor.cold["vehicle"], "angle", 0.0));
            // The first order and the page need the same available thrust that fly() will read on the first step.
            if let Some(drive) = &mut actor.drive {
                drive.thrust_n = self.damage.modules[material.1..].iter()
                    .filter(|m| m.actor == actor.handle && m.kind == ComponentKind::Thruster && m.usable())
                    .map(|m| m.kind.thrust_n(m.volume)).sum();
            }
        }
        for actor in &mut coming {
            install::prepare_contact(&self.damage.plates[material.0..],&self.damage.modules[material.1..],actor)?;
        }
        let first = self.actors.len();
        self.actors.extend(coming);
        for (i, a) in array(v, "actors").iter().enumerate() {
            let i = first + i;
            if a["weapon"].is_object() {
                self.actors[i].weapon = Some(self.settings(&a["weapon"], false)?);
            }
            if a["trigger"].is_object() {
                self.actors[i].trigger = Some((
                    Point::from_value(&a["trigger"]["aim"]),
                    self.settings(&a["trigger"]["config"], false)?,
                ));
            }
            if a["pendingShot"].is_object() {
                self.actors[i].pending = Some((
                    Point::from_value(&a["pendingShot"]["aim"]),
                    self.settings(&a["pendingShot"]["settings"], false)?,
                    number(&a["pendingShot"], "expires", self.time),
                ));
            }
            for e in a["also"].as_array().into_iter().flatten() {
                let settings = self.settings(&e["config"], false)?;
                if settings.mounted && settings.component.is_some() {
                    self.actors[i].also.push(Extra {
                        aim: Point::from_value(&e["aim"]),
                        settings,
                        held: e["held"] == true,
                        pending: e["expires"].as_f64(),
                    });
                }
            }
        }
        Ok(())
    }
    pub fn preserve_runtime(&mut self, previous: Self) {
        let retained = self
            .actors
            .iter()
            .filter(|a| {
                previous.actors.iter().any(|old| {
                    old.handle == a.handle
                        && old.id == a.id
                        && old.cold["revision"] == a.cold["revision"]
                })
            })
            .map(|a| a.handle)
            .collect::<HashSet<_>>();
        self.sensors = previous.sensors;
        self.sensors.retain_actors(&retained);
        self.scripted = previous
            .scripted
            .into_iter()
            .filter(|(actor, _)| retained.contains(actor))
            .collect();
        for a in &mut self.actors {
            if retained.contains(&a.handle) {
                if let Some(old) = previous.actors.iter().find(|old| old.handle == a.handle) {
                    a.message_until = old.message_until;
                }
            }
        }
    }
    fn actor_index(&self, request: &Value) -> Result<usize, String> {
        let Some(name) = request["actorId"].as_str() else {
            return self
                .actors
                .iter()
                .position(|a| a.id == "local")
                .or(if self.actors.is_empty() {
                    None
                } else {
                    Some(0)
                })
                .ok_or_else(|| "Actor not found".into());
        };
        self.actors
            .iter()
            .position(|a| a.id == name)
            .ok_or_else(|| "Actor not found".into())
    }
    fn settings(&self, config: &Value, fixed: bool) -> Result<Settings, String> {
        let component = config["componentId"].as_str().and_then(|s| {
            self.damage
                .modules
                .iter()
                .find(|m| m.cold["id"] == s)
                .map(|m| m.owner)
        });
        Settings::admit(&self.catalogue, config, component, fixed)
    }
    fn update_powertrains(&mut self) {
        let mut groups: HashMap<u32, Vec<&Module>> = self.actors.iter()
            .filter(|a| a.drive.is_some())
            .map(|a| (a.handle, Vec::new())).collect();
        if groups.is_empty() { return; }
        // Each construction keeps its pieces in the order of the field, including repeated handles.
        for module in &self.damage.modules {
            if let Some(parts) = groups.get_mut(&module.actor) { parts.push(module); }
        }
        for a in &mut self.actors {
            if let Some(d) = &mut a.drive {
                let parts = groups.get(&a.handle).map_or(&[][..], Vec::as_slice);
                a.powertrain = Powertrain::project_modules(d.mass, parts.iter().copied(), a.hull);
            }
        }
    }
    fn sync_poses(&mut self, core: &NativeWorld) {
        for a in &mut self.actors {
            if let (Some(d), Some(p)) = (&mut a.drive, body_pose(core, a.body)) {
                let body = &core.world.bodies[core.bodies[&a.body]];
                let v = body.linvel();
                let old = d.pose;
                d.pose = Pose {
                    angle: unwrap_angle(p.angle, old.angle),
                    ..p
                };
                d.velocity = Point::new(v.x, v.y);
                d.omega = body.angvel();
                d.travel += (p.x - old.x) * cos(d.pose.angle) + (p.y - old.y) * sin(d.pose.angle);
            }
        }
        let mut last_body: Option<(u32, Option<BodyReading>)> = None;
        for b in &mut self.bindings {
            let reading = match last_body {
                Some((id, reading)) if id == b.body => reading,
                _ => {
                    let reading = BodyReading::read(core, b.body);
                    last_body = Some((b.body, reading));
                    reading
                }
            };
            let p = reading.map(|reading| reading.compose(b.local));
            if let Some(plate) = self.damage.plate_mut(b.owner) {
                if let Some(p) = p {
                    plate.pose = Pose {
                        angle: unwrap_angle(p.angle, plate.pose.angle),
                        ..p
                    };
                }
                if let Some(reading) = reading {
                    plate.velocity = reading.velocity;
                    plate.angular_velocity = reading.omega;
                    plate.mass_center_world = reading.mass_center;
                    b.sleeping = reading.sleeping;
                }
                self.geometry.set_pose(b.owner, plate.pose, None);
            } else if let Some(module) = self.damage.module_mut(b.owner) {
                if let Some(p) = p {
                    let angle = unwrap_angle(p.angle, module.pose.angle);
                    let delta = angle - module.pose.angle;
                    module.pose = Pose { angle, ..p };
                    if delta != 0.0 {
                        module.barrel_angle += delta;
                        if let Some(servo) = self.servos.iter_mut().find(|s| s.owner == b.owner) {
                            servo.target += delta;
                        }
                    }
                }
                self.geometry.set_pose(b.owner, module.pose,
                    (module.kind == ComponentKind::Weapon).then_some(module.barrel_angle));
            }
        }
        for (g, gear) in self.gear_bindings.iter_mut().zip(&mut self.gears) {
            let Some(m) = self.damage.module_mut(g.owner) else {
                continue;
            };
            let Some(d) = self
                .actors
                .iter_mut()
                .find(|a| a.handle == m.actor)
                .and_then(|a| a.drive.as_mut())
            else {
                continue;
            };
            // A gear with travel stands where its springs have it from where it was built, and a
            // vehicle its springs carry is on the ground.
            if !gear.springs.is_empty() {
                let (c, s) = (cos(d.pose.angle), sin(d.pose.angle));
                let pressed;
                (g.displacement, g.tilt, pressed) = gear.carry(d, gear_rim(m), g.travel, c > 0.15, &self.terrain);
                if m.kind == ComponentKind::Track {
                    (g.displacement, g.tilt) = track_stand(m, d.pose.angle, g.displacement, g.tilt, g.travel, &self.terrain);
                }
                g.compression = pressed + g.travel * SPRING_REST;
                d.grounded |= gear.carried.load > 0.0;
                m.pose.x -= s * g.displacement;
                m.pose.y += c * g.displacement;
                m.pose.angle += g.tilt;
                self.geometry.set_pose(g.owner, m.pose, None);
            }
            let touching = d.grounded && gear.ground_contact.is_some();
            let radius = (m.height / 2.0).max(0.01);
            g.touching = touching;
            // On the ground the gear turns as the ground passes under it, and as much more as its drivetrain
            // slips it on ground that does not hold. Off it, it keeps the speed it left with: `coast_gears`
            // turns it on from there. A gear that is destroyed turns no more, on the ground or off it.
            let turned = d.travel + d.slipped;
            if m.health <= 0.0 {
                g.angular_speed = 0.0;
            } else if touching {
                g.angle -= (turned - g.last_turned) / radius;
                let velocity = d.velocity_at(Point::new(m.pose.x, m.pose.y));
                g.angular_speed =
                    -(velocity.x * cos(d.pose.angle) + velocity.y * sin(d.pose.angle) + d.slip) / radius;
            }
            g.last_turned = turned;
        }
    }
    /// A wheel or a belt that has left the ground goes on turning with the speed it left it with. Nothing
    /// drives it there, and the drag of its own train slows it: a wheel has about a third of its speed
    /// left after a second and a half, a belt after half a second, and a brake stops either at once.
    /// One that is destroyed has no speed left to turn on with. It is what is seen of the gear: no force
    /// comes of it.
    fn coast_gears(&mut self, dt: f64) {
        for g in &mut self.gear_bindings {
            if g.touching || g.angular_speed == 0.0 {
                continue;
            }
            let Some(m) = self.damage.module(g.owner) else {
                continue;
            };
            let braked = self
                .actors
                .iter()
                .find(|a| a.handle == m.actor)
                .and_then(|a| a.drive.as_ref())
                .is_some_and(|d| d.brake > 0.0);
            let lasting = if braked {
                0.05
            } else if m.kind == ComponentKind::Track {
                0.5
            } else {
                1.5
            };
            g.angle += g.angular_speed * dt;
            // The share kept in one step, written without an exponential: both hosts must turn it alike.
            g.angular_speed *= 1.0 - dt / lasting;
            if g.angular_speed.abs() < 0.05 {
                g.angular_speed = 0.0;
            }
        }
    }
    fn terrain_support(&mut self, core: &NativeWorld) {
        for a in &mut self.actors {
            if let Some(d) = &mut a.drive {
                d.grounded = false;
            }
        }
        for pair in core.world.narrow_phase.contact_pairs() {
            let first = core.metadata.get(&pair.collider1).map_or(0, |m| m.actor);
            let second = core.metadata.get(&pair.collider2).map_or(0, |m| m.actor);
            let (actor, direction) = if first != 0 && second == 0 {
                (first, -1.0)
            } else if first == 0 && second != 0 {
                (second, 1.0)
            } else {
                continue;
            };
            let support_limit = core.world.colliders[pair.collider1].contact_skin()
                + core.world.colliders[pair.collider2].contact_skin() + crate::VEHICLE_CONTACT_SLOP;
            if !pair.manifolds().iter().any(|m| {
                m.data.normal.y * direction > 0.25 && m.points.iter().any(|p| p.dist <= support_limit)
            }) {
                continue;
            }
            if let Some(d) = self
                .actors
                .iter_mut()
                .find(|a| a.handle == actor)
                .and_then(|a| a.drive.as_mut())
            {
                d.grounded = true;
            }
        }
    }
    fn refresh_readings(&mut self) {
        // The eyes every frame tells of need live health and poses at 60 Hz.
        // Full armament, bounds and sensor projection is only consumed at
        // decision/query boundaries. The roster is fixed until scene admission.
        debug_assert_eq!(self.sensor_modules.len(), self.damage.modules.len());
        debug_assert_eq!(self.sensor_actors.len(), self.actors.len());
        let controlled: HashSet<_> = self.actors.iter().filter(|actor| !actor.defeated)
            .map(|actor| actor.handle).collect();
        for (reading, module) in self.sensor_modules.iter_mut().zip(&self.damage.modules) {
            debug_assert_eq!(reading.handle, module.owner);
            reading.x = module.pose.x;
            reading.y = module.pose.y;
            reading.turn = module.pose.angle;
            reading.health = module.health;
            reading.attached = module.attached
                && (!matches!(module.kind, ComponentKind::Command | ComponentKind::Sensor)
                    || controlled.contains(&module.actor));
            reading.detonated = module.detonated;
            reading.barrel_disabled = module.barrel_disabled;
        }
        for (reading, actor) in self.sensor_actors.iter_mut().zip(&self.actors) {
            debug_assert_eq!(reading.handle, actor.handle);
            reading.defeated = actor.defeated;
            reading.vehicle = actor.vehicle_reading();
            reading.x = reading
                .vehicle
                .map_or(number(&actor.cold, "x", 12.0), |v| v.x);
            reading.y = reading.vehicle.map_or(1.3, |v| v.y);
        }
        self.refresh_sight();
    }
    /// What each construction sees with. An optic or a radar turns with its construction as one piece,
    /// so what its own armour hides from it changes only as that armour wears: its cover is worked out
    /// again then, and at no other time, of the plates its wave does not run through. The eyes are read
    /// off the optics as they now stand; a construction out of action has none.
    fn refresh_sight(&mut self) {
        // The wear of each construction's armour and whether it is out of action.
        let mut positions = HashMap::with_capacity(self.actors.len());
        for (index, actor) in self.actors.iter().enumerate() {
            positions.entry(actor.handle).or_insert(index);
        }
        let mut state = vec![(0u64, false); self.actors.len()];
        let mut at = 0;
        for p in self.damage.plates.iter().filter(|p| p.attached) {
            if self.actors.get(at).is_none_or(|a| a.handle != p.actor) {
                let Some(&found) = positions.get(&p.actor) else {
                    continue;
                };
                at = found;
            }
            state[at].0 += p.revision + 1;
        }
        for (a, state) in self.actors.iter_mut().zip(&mut state) {
            a.eyes.clear();
            state.1 = a.defeated;
        }
        let mut armour: Option<(usize, Vec<(Option<crate::game_damage::Wave>, Armour)>)> = None;
        for index in 0..self.sensor_modules.len() {
            let reading = &self.sensor_modules[index];
            let Some(wave) = reading.wave() else {
                continue;
            };
            if self.actors.get(at).is_none_or(|a| a.handle != reading.actor) {
                let Some(&found) = positions.get(&reading.actor) else {
                    continue;
                };
                at = found;
            }
            let actor = &self.actors[at];
            if reading.cover.is_none() || actor.armour != Some(state[at].0) {
                let plates = match &armour {
                    Some((of, plates)) if *of == at => plates,
                    _ => {
                        let plates = self
                            .damage
                            .plates
                            .iter()
                            // The skids of an aircraft are tubes beside its body: an optic under it sees out between them.
                            .filter(|p| p.actor == actor.handle && p.attached
                                && !p.cold["definition"]["id"].as_str().is_some_and(crate::game_geometry::skid))
                            .map(|p| (p.material.clear_to(), Armour::of(p.pose, &p.grid)))
                            .collect();
                        &armour.insert((at, plates)).1
                    }
                };
                let hull = actor.drive.as_ref().map_or(0.0, |d| d.pose.angle);
                let opaque = plates.iter().filter(|(clear, _)| *clear != Some(wave)).map(|(_, plate)| plate);
                let cover = Cover::around(self.damage.modules[index].pose, hull, opaque);
                self.sensor_modules[index].cover = Some(std::sync::Arc::new(cover));
            }
            let reading = &self.sensor_modules[index];
            if reading.kind == ComponentKind::Command && !reading.active() {
                state[at].1 = true;
            }
            if let Some(eye) = reading.eye(self.weather) {
                self.actors[at].eyes.push(eye);
            }
        }
        for (a, (wear, out)) in self.actors.iter_mut().zip(state) {
            a.armour = Some(wear);
            if out {
                a.eyes.clear();
            }
        }
    }
    fn refresh_sensors(&mut self) {
        self.refresh_sensors_for(None);
    }
    // Only a pilot consumes gun status, from readings of its own handle. Other callers keep
    // the complete projection. All other fields and the serialized layout stay the same.
    fn refresh_sensors_for(&mut self, gun_actor: Option<u32>) {
        // What the sensors read next, they read by rays: the parts are grouped for those as they stand now.
        // A part that moved or changed since the rounds of the step grouped them leaves the groups of no
        // use, and a ray without groups meets every part of the field.
        self.geometry.index();
        // The map is only looked up by handle; each actor keeps the source order of plates, then modules.
        let mut actor_state: HashMap<u32, (bool, Bounds)> = HashMap::with_capacity(self.actors.len());
        for a in &self.actors {
            actor_state.entry(a.handle).or_insert((false, Bounds::empty())).0 |= !a.defeated;
        }
        for p in &self.damage.plates {
            if p.properties.area > 0.0 {
                if let Some((_, bounds)) = actor_state.get_mut(&p.actor) {
                    if let Some(b) = self.geometry.bounds(p.owner) { bounds.union(b); }
                }
            }
        }
        let mut servos = HashMap::with_capacity(self.servos.len());
        for servo in &self.servos { servos.entry(servo.owner).or_insert(servo); }
        // The covers of the optics stand while their armour does: they are carried over, in the order of the pieces.
        let covers: Vec<_> = self
            .sensor_modules
            .iter_mut()
            .filter_map(|m| m.cover.take().map(|cover| (m.handle, cover)))
            .collect();
        let mut kept = covers.into_iter().peekable();
        self.sensor_modules.clear();
        for m in &self.damage.modules {
            let controlled = if let Some((controlled, bounds)) = actor_state.get_mut(&m.actor) {
                if let Some(b) = self.geometry.bounds(m.owner) { bounds.union(b); }
                *controlled
            } else { false };
            let gun_status = gun_actor.is_none_or(|actor| m.actor == actor);
            let servo = if gun_status { servos.get(&m.owner).copied() } else { None };
            self.sensor_modules.push(SensorModule {
                handle: m.owner,
                actor: m.actor,
                kind: m.kind,
                x: m.pose.x,
                y: m.pose.y,
                health: m.health,
                attached: m.attached
                    && (controlled || !matches!(m.kind, ComponentKind::Command | ComponentKind::Sensor)),
                detonated: m.detonated,
                sensor_mode: crate::game_sensors::SensorMode::from_name(text(&m.cold, "sensorMode", "visual")),
                range: number(&m.cold, "range", number(&m.cold, "sensorRange", 0.0)),
                barrel_disabled: m.barrel_disabled,
                // A pilot waits as long for a belt changed or a round put back in an empty magazine as for its reload.
                reload: servo.map_or(0.0, |s| s.reload.max(0.0).max(s.feed_wait())),
                cooling: servo.is_some_and(|s| s.barrel.cooling),
                servo_max_speed: if gun_status { crate::game_motion::ServoProfile::from_module(m).max_speed } else { 0.0 },
                muzzle_blocked: controlled && gun_status && m.weapon.as_ref().is_some_and(|weapon| {
                    crate::game_motion::muzzle_obstruction(&self.geometry,&self.terrain,m.owner,
                        Some(m.actor),
                        muzzle_point(Point::new(m.pose.x,m.pose.y),m.barrel_angle,weapon.barrel),
                        m.barrel_angle,weapon.radius)
                }),
                turn: m.pose.angle,
                cover: kept.next_if(|(owner, _)| *owner == m.owner).map(|(_, cover)| cover),
            });
        }
        drop(servos);
        for (index, a) in self.actors.iter().enumerate() {
            let bounds = actor_state[&a.handle].1;
            let vehicle = a.vehicle_reading();
            let (mut id, mut team) = self.sensor_actors.get_mut(index)
                .map(|reading| (std::mem::take(&mut reading.id), std::mem::take(&mut reading.team)))
                .unwrap_or_default();
            id.clone_from(&a.id);
            team.clone_from(&a.team);
            let reading = SensorActor {
                handle: a.handle,
                id,
                team,
                defeated: a.defeated,
                facing: number(&a.cold, "facing", -1.0),
                x: vehicle.map_or(number(&a.cold, "x", 12.0), |v| v.x),
                y: vehicle.map_or(1.3, |v| v.y),
                shots: a.shots,
                bounds,
                vehicle,
            };
            if let Some(slot) = self.sensor_actors.get_mut(index) { *slot = reading; }
            else { self.sensor_actors.push(reading); }
        }
        self.sensor_actors.truncate(self.actors.len());
        self.refresh_sight();
    }
    fn set_vehicle_state(
        &mut self,
        core: &mut NativeWorld,
        index: usize,
        state: &serde_json::Map<String, Value>,
    ) -> Result<(), String> {
        let a = &self.actors[index];
        let d = a.drive.as_ref().ok_or("Actor is not mobile")?;
        let mut pose = d.pose;
        let mut velocity = d.velocity;
        let mut omega = d.omega;
        for (key, value) in state {
            let n = value.as_f64().unwrap();
            match key.as_str() {
                "x" => pose.x = n,
                "y" => pose.y = n,
                "angle" => pose.angle = n,
                "vx" => velocity.x = n,
                "vy" => velocity.y = n,
                "omega" => omega = n,
                _ => {}
            }
        }
        let body = core
            .bodies
            .get(&a.body)
            .and_then(|handle| core.world.bodies.get_mut(*handle))
            .ok_or("Missing vehicle carrier")?;
        body.set_translation(Vector::new(pose.x, pose.y), true);
        body.set_rotation(
            rapier2d_f64::prelude::Rotation::from_angle(pose.angle),
            true,
        );
        body.set_linvel(Vector::new(velocity.x, velocity.y), true);
        body.set_angvel(omega, true);
        let drive = self.actors[index].drive.as_mut().unwrap();
        let moved = pose.x != drive.pose.x || pose.y != drive.pose.y || pose.angle != drive.pose.angle;
        drive.pose.angle = pose.angle;
        if moved {
            drive.grounded = false;
        }
        self.sync_poses(core);
        Ok(())
    }
    pub fn step(&mut self, core: &mut NativeWorld, dt: f64) -> Result<(), String> {
        if !dt.is_finite() || (dt - 1.0 / 60.0).abs() > 1e-9 {
            return Err("The game accepts a fixed step of 1/60 s".into());
        }
        self.sync_poses(core);
        self.coast_gears(dt);
        let h = dt;
        self.advance_weapons(h, None);
        self.air_barrels(h);
        for i in 0..self.actors.len() {
            if self.actors[i].defeated {
                continue;
            }
            self.actors[i].cooldown = advance_cooldown(
                self.actors[i].cooldown,
                h,
                self.actors[i].trigger.as_ref().is_some_and(|(_, s)| !s.mounted),
            );
            let handle = self.actors[i].handle;
            for k in 0..self.servos.len() {
                let (owner, reload) = (self.servos[k].owner, self.servos[k].reload);
                if (reload != 0.0 || self.servos[k].spin_up > 0.0) && self.damage.module(owner).is_some_and(|m| m.actor == handle) {
                    let held = self.gun_held(i, owner);
                    if reload != 0.0 { self.servos[k].reload = advance_cooldown(reload, h, held); }
                    self.servos[k].spin(h, held);
                }
            }
            let trigger = self.actors[i]
                .trigger
                .as_ref()
                .filter(|(_, settings)| self.ready_to_fire(i, settings))
                .cloned();
            if let Some((aim, settings)) = trigger {
                if self.fire(core, i, aim, &settings, false)? { self.volley(core, i, aim, &settings, h)?; }
            }
            for k in 0..self.actors[i].also.len() {
                let e = &self.actors[i].also[k];
                if e.held && self.ready_to_fire(i, &e.settings) {
                    let (aim, settings) = (e.aim, e.settings.clone());
                    if self.launch(core, i, aim, &settings, false)? { self.volley(core, i, aim, &settings, h)?; }
                }
            }
            // Unavailable shots do not accumulate reload credit.
            self.actors[i].cooldown = self.actors[i].cooldown.max(0.0);
            for servo in &mut self.servos {
                if servo.reload < 0.0 && self.damage.module(servo.owner).is_some_and(|m| m.actor == handle) {
                    servo.reload = 0.0;
                }
            }
            if let Some((aim, settings, expires)) = self.actors[i].pending.as_ref() {
                let gun = self.mounted_gun(i, settings);
                if *expires < self.time
                    || gun.is_none()
                {
                    self.actors[i].pending = None;
                } else if self.ready_to_fire(i, settings) {
                    let (aim, settings) = (*aim, settings.clone());
                    self.fire(core, i, aim, &settings, false)?;
                }
            }
            for k in 0..self.actors[i].also.len() {
                let e = &self.actors[i].also[k];
                let Some(expires) = e.pending else { continue };
                if expires < self.time || self.mounted_gun(i, &e.settings).is_none() {
                    self.actors[i].also[k].pending = None;
                } else if self.ready_to_fire(i, &e.settings) {
                    let (aim, settings) = (e.aim, e.settings.clone());
                    if self.launch(core, i, aim, &settings, false)? {
                        self.actors[i].also[k].pending = None;
                    }
                }
            }
        }
        self.update_powertrains();
        let mut effects = Effects::new(self.visual);
        core.held.clear();
        self.prune_tows(core);
        // What tows a vehicle is driven before it, which keeps pace with it as it has just been driven (`hitch`); what
        // tows reads of it only how it moved and could brake in the step before. Nothing else of one vehicle's drive
        // reads another's, so the order of the rest is the order of the field.
        let towed = |i: &usize| self.is_towed(self.actors[*i].handle);
        let order = (0..self.actors.len())
            .filter(|i| !towed(i))
            .chain((0..self.actors.len()).filter(towed))
            .collect::<Vec<_>>();
        // What each vehicle that flies spans, for its flight computer to come down in time over the ground under it.
        let flown = if self.actors.iter().any(|a| a.drive.as_ref().is_some_and(|d| d.flying)) { self.extents().clone() } else { HashMap::new() };
        for i in order {
            let hitch = self.hitch(i, h);
            // What the cable it is on pulls it with, and what it holds up on a sling off the ground, for its flight computer.
            let (pull, hung) = (self.tow_pull(self.actors[i].handle), self.tow_hanging(self.actors[i].handle));
            let a = &mut self.actors[i];
            let facing = number(&a.cold, "facing", -1.0);
            if let Some(d) = &mut a.drive {
                if a.defeated {
                    d.control(0.0, 1.0);
                }
                if a.defeated
                    && core
                        .bodies
                        .get(&a.body)
                        .is_some_and(|h| core.world.bodies[*h].is_sleeping())
                {
                    d.engine_kw = 0.0;
                    d.fuel_rate = 0.0;
                    // Woken by a blow, the wreck is still held as it was when it fell asleep.
                    if d.hold > 0.0 {
                        core.held.insert(a.handle, d.hold);
                    }
                    continue;
                }
                // How hard the faces its gear meets the way it is driven pressed on it in the step before.
                let faces = match core.bodies.get(&a.body) {
                    Some(&body) if d.throttle != 0.0 => core.pressing(body, d.throttle.signum()) / h,
                    _ => 0.0,
                };
                d.drive(
                    h,
                    &self.damage,
                    &self.geometry,
                    &self.terrain,
                    &mut self.gears,
                    &a.powertrain,
                    facing,
                    faces,
                    hitch,
                );
                if d.hold > 0.0 {
                    core.held.insert(a.handle, d.hold);
                }
                // The ground ends with the world: a vehicle is held a hull's length short of it.
                if self.enclosed
                    && (d.pose.x <= self.terrain.min_x + WORLD_EDGE && d.velocity.x < 0.0
                        || d.pose.x >= self.terrain.max_x - WORLD_EDGE && d.velocity.x > 0.0)
                {
                    d.velocity.x = 0.0;
                }
                // An engine burns only while it turns under command. A parked,
                // braked, airborne or disabled vehicle costs nothing.
                d.fuel_rate = if d.enabled
                    && a.powertrain.power_kw > 0.0
                    && d.traction > 0.0
                    && d.drive_speed != 0.0
                {
                    fuel_flow(d.engine_kw, a.powertrain.power_kw)
                } else {
                    0.0
                };
                if d.fuel_rate > 0.0 {
                    self.damage.consume_fuel(a.handle, d.fuel_rate * h / 3600.0);
                }
                // Its thrusters push it as its flight computer shares out their thrust, and burn for it on their own.
                let flew = d.flying;
                let gravity = core.world.gravity;
                // How high the lowest of it is over the highest of the ground under its ends and its middle, and the lowest of
                // what it holds up on a sling, lower.
                let terrain = &self.terrain;
                let clear = |b: &Bounds| {
                    b.min_y - [b.min_x, (b.min_x + b.max_x) / 2.0, b.max_x].into_iter().map(|x| terrain.height(x)).fold(f64::MIN, f64::max)
                };
                let above = flown.get(&a.handle).filter(|_| d.flying).map(|b| {
                    hung.and_then(|(load, ..)| flown.get(&load)).map_or(clear(b), |load| clear(b).min(clear(load)))
                });
                // And, flying or taken up, the corners of its outline about its centre of mass, to lean it no further than keeps it
                // off the ground.
                let outline: Vec<Point> = if d.flying || d.rise > 0.0 {
                    a.contact_contours.iter().flatten().flatten().map(|p| Point::new(p.x - d.carrier_center.x, p.y - d.carrier_center.y)).collect()
                } else {
                    Vec::new()
                };
                let ground = |x: f64| terrain.height(x);
                let lift = crate::game_hover::fly(d, &mut self.damage, a.handle, a.defeated, crate::game_hover::Body {
                    mass: d.carrier_mass, inertia: d.carrier_inertia, center: d.center(), gravity: Point::new(gravity.x, gravity.y), above,
                    air: Some((a.powertrain, facing)), pull, hung: hung.map_or(0.0, |(_, mass, _)| mass),
                    swing: hung.map_or(0.0, |(.., swing)| swing),
                }, Some(crate::game_hover::Underneath { outline: &outline, ground: &ground }), h);
                if let Some(handle) = core.bodies.get(&a.body).copied() {
                    let body = &core.world.bodies[handle];
                    // Free rolling removes contact friction from the fixed
                    // wheels/tracks. Damp chassis rocking through their ground
                    // support, without a target pitch or any torque in flight.
                    let damping = if d.grounded { 2.0 } else { 0.0 };
                    let damping_changed = body.angular_damping() != damping;
                    if let Some(next) = drive_velocity_change(body.linvel(), d.velocity) {
                        core.world.bodies[handle].set_linvel(next, !a.defeated);
                    }
                    if damping_changed {
                        core.world.bodies[handle].set_angular_damping(damping);
                    }
                    // What its springs give it over this step is a force on its body, carried through
                    // the solve along with its weight: standing where they balance it, it does not
                    // move at all. They wake no body, and one settled on them goes to sleep there.
                    // Its thrusters push it along with them, and wake it as they take it up or let it go: one that
                    // hovers still goes to sleep where it hovers.
                    let push = Vector::new(d.carried.push.x + lift.force.x, d.carried.push.y + lift.force.y);
                    let moment = d.carried.moment + lift.torque;
                    let body = &core.world.bodies[handle];
                    if body.user_force() != push || body.user_torque() != moment {
                        let wake = flew || d.flying;
                        let body = &mut core.world.bodies[handle];
                        body.reset_forces(wake);
                        body.reset_torques(wake);
                        body.add_force(push, wake);
                        body.add_torque(moment, wake);
                    }
                    if let Some(climb) = d.climb(&a.powertrain, h) {
                        core.climb(handle, climb);
                    }
                }
            }
        }
        self.apply_effects(core, &mut effects)?;
        self.advance_tows(core);
        let before = core.solve(h, 0.0, self.time)?;
        if core.invalid_reason != 0 {
            self.recoveries += 1;
        }
        self.terrain_support(core);
        self.sync_poses(core);
        if core.invalid_reason == 0 {
            self.contact_damage(core, &before, &mut effects);
        }
        self.seat_fresh_rounds();
        let sides = self.sides();
        self.projectiles.step(
            h,
            self.time,
            &sides,
            &mut self.damage,
            &mut self.geometry,
            &self.terrain,
            &mut effects,
        );
        self.count_airborne();
        // Damage/fire progresses at 10 Hz; the phase is the persisted frame
        // counter, so cold resumes do not introduce a second simulation clock.
        if (self.tick + 1) % 6 == 0 {
            self.damage.step_burning(6.0 * h, &self.geometry, &mut effects);
        }
        self.apply_effects(core, &mut effects)?;
        if (self.tick + 1) % 6 == 0 {
            self.weigh(core);
        }
        self.prune_tows(core);
        // The crews load their guns from what the boxes hold once the step took what it took of them.
        self.feed_guns(h);
        self.time += h;
        self.tick += 1;
        self.refresh_readings();
        Ok(())
    }
    /// The weight of what a construction carries is real: its mass, its centre and its inertia
    /// follow the fuel in its tanks, the rounds in its magazines and the cargo in its hoppers
    /// and cisterns. They are looked at ten times a second, on the phase of the fire, and a
    /// body is weighed again only when they changed by `LOAD_STEP` since it last was: a truck
    /// that loads, or a vehicle that drives, is not weighed at every step.
    fn weigh(&mut self, core: &mut NativeWorld) {
        let mut changed: Vec<(u32, f64)> = Vec::new();
        for m in &self.damage.modules {
            let change = (m.live_mass() - m.physical_mass).abs();
            if change == 0.0 || !m.attached {
                continue;
            }
            match changed.iter_mut().find(|(actor, _)| *actor == m.actor) {
                Some((_, sum)) => *sum += change,
                None => changed.push((m.actor, change)),
            }
        }
        for (handle, change) in changed {
            if change < LOAD_STEP {
                continue;
            }
            let Some(a) = self.actors.iter_mut().find(|a| a.handle == handle) else {
                continue;
            };
            let Some(pose) = body_pose(core, a.body) else {
                continue;
            };
            for m in &mut self.damage.modules {
                if m.actor == handle {
                    m.weigh();
                }
            }
            let (mass, center, inertia) = install::assembly_mass(&self.damage, handle, pose);
            set_mass(core, a.body, mass, center, inertia);
            // Its springs find where they carry the new weight: asleep, it would stay where the old one left it.
            if let Some(body) = core.bodies.get(&a.body).and_then(|h| core.world.bodies.get_mut(*h)) {
                body.wake_up(true);
            }
            if let Some(d) = &mut a.drive {
                d.mass = mass;
                d.carrier_mass = mass;
                d.inertia = inertia;
                d.carrier_inertia = inertia;
                d.local_center = center;
                d.carrier_center = center;
                a.powertrain = Powertrain::project(a.handle, mass, &self.damage, a.hull);
            }
        }
    }
    // A round is fired before the solve moves its gun, and its flight is
    // traced against the poses after it. Until its first flight it stays at
    // the muzzle, so it never starts inside or beside the weapon that fired
    // it, however fast the carrier moves or turns. A projectile placed by
    // hand is left where it was put.
    fn seat_fresh_rounds(&mut self) {
        for p in &mut self.projectiles.projectiles {
            if p.age != 0.0 || p.cold["atMuzzle"] != true {
                continue;
            }
            let Some(gun) = p.emitter_ids.first().and_then(|owner| self.damage.module(*owner)) else {
                continue;
            };
            if let Some(weapon) = &gun.weapon {
                let muzzle = muzzle_point(Point::new(gun.pose.x, gun.pose.y), gun.barrel_angle, weapon.barrel);
                p.point.x = muzzle.x;
                p.point.y = muzzle.y;
            }
        }
    }
    fn ready_to_fire(&self, index: usize, settings: &Settings) -> bool {
        let actor = &self.actors[index];
        self.reload(index, settings) <= 1e-5 && self.fed(index, settings)
            || (!settings.mounted
                && !actor.last_weapon.is_empty()
                && actor.last_weapon != settings.family)
    }
    /// The servo of the mounted gun these settings name.
    fn gun_servo(&self, index: usize, settings: &Settings) -> Option<&ServoState> {
        self.mounted_gun(index, settings).and_then(|gun| self.servos.iter().find(|servo| servo.owner == gun.owner))
    }
    // Seconds until the weapon these settings name fires again: the gun's own
    // when it is mounted, the bench launcher's otherwise.
    fn reload(&self, index: usize, settings: &Settings) -> f64 {
        if !settings.mounted {
            return self.actors[index].cooldown;
        }
        self.gun_servo(index, settings).map_or(0.0, |servo| servo.reload)
    }
    /// Whether the feed of the weapon these settings name lets it fire (`ServoState::fed`): the bench launcher has none.
    fn fed(&self, index: usize, settings: &Settings) -> bool {
        !settings.mounted || self.gun_servo(index, settings).is_none_or(ServoState::fed)
    }
    // A gun keeps its reload phase only while a trigger that names it stays held.
    fn gun_held(&self, index: usize, owner: u32) -> bool {
        let a = &self.actors[index];
        a.also.iter().any(|e| e.held && e.settings.component == Some(owner))
            || a.trigger.as_ref().is_some_and(|(_, s)| {
                s.mounted && self.mounted_gun(index, s).is_some_and(|gun| gun.owner == owner)
            })
    }
    /// Brings the guns from the `first` on into the field with their feeds as the catalogue states them, as full as the
    /// boxes of their constructions let them (`ServoState::load`).
    fn load_guns(&mut self, first: usize) {
        let aboard = rounds_aboard(&self.damage);
        for servo in &mut self.servos[first..] {
            let Some(gun) = self.damage.module(servo.owner) else { continue };
            servo.load(crate::game_variant::Feed::of(&self.catalogue[&gun.weapon_preset]), aboard_for(&aboard, gun));
        }
    }
    /// A step of `dt` of every gun's feed (`ServoState::feed_step`), with the rounds its boxes hold now and whether the
    /// trigger that names it is held.
    fn feed_guns(&mut self, dt: f64) {
        if self.servos.is_empty() { return; }
        let aboard = rounds_aboard(&self.damage);
        let index: HashMap<u32, usize> = self.actors.iter().enumerate().map(|(i, a)| (a.handle, i)).collect();
        for k in 0..self.servos.len() {
            let owner = self.servos[k].owner;
            let Some(gun) = self.damage.module(owner) else { continue };
            let rounds = aboard_for(&aboard, gun);
            let held = index.get(&gun.actor).is_some_and(|&i| self.gun_held(i, owner));
            self.servos[k].feed_step(dt, rounds, held);
        }
        // What its compartment holds goes off with it (`Module::ready_blast`).
        for k in 0..self.servos.len() {
            let (owner, loaded) = (self.servos[k].owner, self.servos[k].loaded);
            if let Some(gun) = self.damage.module_mut(owner) { gun.ready = loaded; }
        }
    }
    /// Every barrel a step of `dt` in the air about it: as warm and as dense as the air is at its height, blowing past it
    /// as fast as its construction carries it (game_barrel.rs).
    fn air_barrels(&mut self, dt: f64) {
        for servo in &mut self.servos {
            let Some(m) = self.damage.module(servo.owner) else { continue };
            let point = Point::new(m.pose.x, m.pose.y);
            let speed = self.actors.iter().find(|a| a.handle == m.actor).and_then(|a| a.drive.as_ref())
                .map_or(0.0, |d| { let v = d.velocity_at(point); crate::game_geometry::hypot(v.x, v.y) });
            servo.barrel.air(crate::game_barrel::Air::at(m.pose.y, speed), dt);
        }
    }
    /// Lays the guns on what they are aimed at and turns them for `dt`: every gun of the field at a step,
    /// or those of `only` one construction when a command changed what it aims at. The others aim at what
    /// they aimed at, and the step that comes lays them: a field of many is not laid again at every command.
    fn advance_weapons(&mut self, dt: f64, only: Option<u32>) {
        for servo in &mut self.servos {
            let Some(module) = self.damage.module_mut(servo.owner) else {
                continue;
            };
            if only.is_some_and(|actor| actor != module.actor) {
                continue;
            }
            if !module.usable() || module.barrel_disabled {
                continue;
            }
            let actor = self.actors.iter().find(|a| a.handle == module.actor);
            if actor.is_some_and(|a| a.defeated) {
                servo.velocity = 0.0;
                continue;
            }
            let target = actor
                .and_then(|a| {
                    a.also
                        .iter()
                        .find(|e| e.settings.component == Some(module.owner))
                        .map(|e| (e.aim, &e.settings))
                        .or_else(|| {
                            a.weapon
                                .as_ref()
                                .filter(|w| w.mounted && w.component.is_none_or(|o| o == module.owner))
                                .map(|w| (a.aim, w))
                        })
                        .map(|(aim, w)| {
                            let origin=Point::new(module.pose.x,module.pose.y);
                            let inherited=a.drive.as_ref().map_or(Point::ZERO,|d|d.velocity_at(origin));
                            let omega=a.drive.as_ref().map_or(0.0,|d|d.omega);
                            laying(origin,aim,w,inherited,omega,mount_sector(&*module)).0
                        })
                })
                .unwrap_or(servo.target);
            advance_servo(servo, module, target, dt);
            self.geometry.set_pose(
                module.owner,
                module.pose,
                Some(module.barrel_angle),
            );
        }
    }
    // The gun these settings name, or the first that works of the construction when they name none: a piece is found by
    // its owner, not looked for among all of them.
    fn mounted_gun(&self, index: usize, s: &Settings) -> Option<&Module> {
        let handle = self.actors[index].handle;
        let works = |m: &&Module| m.actor == handle && m.kind == ComponentKind::Weapon && m.usable() && !m.barrel_disabled;
        match s.component {
            Some(owner) => self.damage.module(owner).filter(works),
            None => self.damage.modules.iter().find(works),
        }
    }
    fn update_aim(&mut self, index: usize, aim: Point, s: &Settings) {
        let a = &mut self.actors[index];
        if a.pending.as_ref().is_some_and(|(old, settings, _)| !same_shot(aim, s, *old, settings)) {
            a.pending = None;
        }
        a.aim = aim;
        a.weapon = Some(s.clone());
    }
    /// What each construction spans, by its handle, as the field stands this step: its plates and its pieces.
    fn extents(&mut self) -> &HashMap<u32, Bounds> {
        if self.extents.0 != self.tick {
            let mut extents: HashMap<u32, Bounds> = HashMap::new();
            let parts = self.damage.plates.iter().filter(|p| p.properties.area > 0.0).map(|p| (p.actor, p.owner))
                .chain(self.damage.modules.iter().map(|m| (m.actor, m.owner)));
            for (actor, owner) in parts {
                if let Some(b) = self.geometry.bounds(owner) {
                    extents.entry(actor).or_insert_with(Bounds::empty).union(b);
                }
            }
            self.extents = (self.tick, extents);
        }
        &self.extents.1
    }
    fn spans_with_sides(&mut self, handle: u32, sides: &Sides) -> (Bounds, Vec<(u32, Bounds)>) {
        let allies: Vec<u32> = sides.allies(Some(handle)).collect();
        let extents = self.extents();
        let own = extents.get(&handle).copied().unwrap_or_else(Bounds::empty);
        (own, allies.into_iter().filter_map(|ally| extents.get(&ally).map(|b| (ally, *b))).collect())
    }
    /// Whether a round a gun of the construction `index` would put in the air at `point` with `velocity` meets that
    /// construction first (`first_contact_near`): its own rounds strike it as any other, and its gun does not fire
    /// into it.
    fn into_own(&mut self, index: usize, gun: u32, point: Point, velocity: Point, drag: Drag, until: f64) -> bool {
        let handle = self.actors[index].handle;
        let near = self.extents().get(&handle).copied().unwrap_or_else(Bounds::empty);
        first_contact_near(self.sides().wrecks(), point, velocity, drag, &[gun], near, until, ROUND_STEP, &self.geometry, &self.terrain) == Some(handle)
    }
    // A shot waits only for a gun that can reach the aim, is still turning to it and has a round to fire.
    fn waits_for_servo(&self, index: usize, aim: Point, s: &Settings) -> bool {
        s.mounted
            && self.mounted_gun(index, s).is_some_and(|gun| {
                let cartridge = crate::game_variant::cartridge(&gun.weapon_preset);
                let origin=Point::new(gun.pose.x,gun.pose.y);
                let drive=self.actors[index].drive.as_ref();
                let inherited=drive.map_or(Point::ZERO,|d|d.velocity_at(origin));
                let omega=drive.map_or(0.0,|d|d.omega);
                laying(origin,aim,s,inherited,omega,mount_sector(gun)).1
                    && self.servos.iter().any(|servo| {
                        servo.owner == gun.owner
                            && angle_difference(servo.target, gun.barrel_angle).abs()
                                > s.servo_fire_tolerance()
                    })
                    && self.damage.modules.iter().any(|m| {
                        m.actor == gun.actor
                            && m.kind == ComponentKind::Ammo
                            && m.usable()
                            && m.ammo_preset == cartridge
                            && m.rounds > 0
                    })
            })
    }
    fn queue_pending(&mut self, index: usize, aim: Point, s: Settings) {
        if self.waits_for_servo(index, aim, &s) {
            self.actors[index].pending = Some((aim, s, self.time + 12.0));
        }
    }
    // The shot of the weapon the actor leads with: it becomes the weapon and the aim in hand.
    fn fire(
        &mut self,
        core: &mut NativeWorld,
        index: usize,
        aim: Point,
        s: &Settings,
        force: bool,
    ) -> Result<bool, String> {
        if !self.launch(core, index, aim, s, force)? {
            return Ok(false);
        }
        let a = &mut self.actors[index];
        a.last_weapon = s.family.clone();
        a.aim = aim;
        a.weapon = Some(s.clone());
        a.pending = None;
        Ok(true)
    }
    // The rounds a held gun fires in a step after its first, when it fires faster than the field steps: each as much
    // later in the step as it fires them, and that far behind in the air (`Projectile::hold`), while its reload allows.
    fn volley(&mut self, core: &mut NativeWorld, index: usize, aim: Point, s: &Settings, dt: f64) -> Result<(), String> {
        let Some(owner) = s.mounted.then(|| self.mounted_gun(index, s).map(|gun| gun.owner)).flatten() else { return Ok(()) };
        let mut hold = 0.0;
        for _ in 1..MOST_ROUNDS_A_STEP {
            let turning = self.servos.iter().find(|servo| servo.owner == owner).map_or(1.0, ServoState::turning);
            hold += 60.0 / (s.rate * turning);
            if hold >= dt || !self.ready_to_fire(index, s) || !self.launch_held(core, index, aim, s, false, hold)? { break; }
        }
        Ok(())
    }
    // One round out of one weapon. Its reload starts on that weapon alone.
    fn launch(
        &mut self,
        core: &mut NativeWorld,
        index: usize,
        aim: Point,
        s: &Settings,
        force: bool,
    ) -> Result<bool, String> {
        self.launch_held(core, index, aim, s, force, 0.0)
    }
    // One round, leaving the muzzle `hold` seconds into the step.
    fn launch_held(
        &mut self,
        core: &mut NativeWorld,
        index: usize,
        aim: Point,
        s: &Settings,
        force: bool,
        hold: f64,
    ) -> Result<bool, String> {
        if self.actors[index].defeated || self.actors[index].sheltered {
            return Ok(false);
        }
        if !s.mounted
            && !self.actors[index].last_weapon.is_empty()
            && self.actors[index].last_weapon != s.family
        {
            self.actors[index].cooldown = 0.0;
        }
        let a = &self.actors[index];
        let reload = self.reload(index, s);
        // A forced shot is let off whatever its reload and its feed.
        if !force && (reload > 1e-5 || !self.fed(index, s)) {
            return Ok(false);
        }
        let gun = if s.mounted {
            self.damage.modules.iter().find(|m| {
                m.actor == a.handle
                    && m.kind == ComponentKind::Weapon
                    && m.usable()
                    && !m.barrel_disabled
                    && s.component.is_none_or(|o| o == m.owner)
            })
        } else {
            None
        };
        if s.mounted && gun.is_none() {
            return Ok(false);
        }
        let origin = gun.map_or(a.launcher, |m| Point::new(m.pose.x, m.pose.y));
        let pivot_velocity=if s.mounted {a.drive.as_ref().map_or(Point::ZERO,|d|d.velocity_at(origin))}else{Point::ZERO};
        let omega=if s.mounted {a.drive.as_ref().map_or(0.0,|d|d.omega)}else{0.0};
        let sector = gun.and_then(mount_sector);
        let (ideal_angle, reachable) = laying(origin, aim, s, pivot_velocity, omega, sector);
        if !reachable {
            return Ok(false);
        }
        // The rounds after the first of a step leave as it was laid: the recoil of one does not hold the next.
        if let Some(gun) = gun.filter(|_| hold == 0.0) {
            if (s.aim_angle.is_none() || s.requires_alignment)
                && angle_difference(ideal_angle, gun.barrel_angle).abs()
                    > s.servo_fire_tolerance()
            {
                return Ok(false);
            }
        }
        let muzzle = solution_with_motion(origin, aim, s, gun.map(|m| m.barrel_angle),pivot_velocity,omega,sector);
        let (gun_owner, gun_preset) = gun.map_or((None, s.preset.clone()), |g| {
            (Some(g.owner), g.weapon_preset.clone())
        });
        let inherited = if s.mounted {
            a.drive
                .as_ref()
                .map_or(Point::ZERO, |d| d.velocity_at(muzzle.point))
        } else {
            Point::ZERO
        };
        if let Some(gun) = gun {
            if crate::game_motion::muzzle_obstruction(
                &self.geometry,
                &self.terrain,
                gun.owner,
                Some(gun.actor),
                muzzle.point,
                muzzle.angle,
                s.radius,
            ) {
                let owner = gun.owner;
                if self.visual && self.actors[index].message_until <= self.time {
                    self.events.push(json!({"type":"weapon-blocked","time":self.time,"owner":owner,"x":muzzle.point.x,"y":muzzle.point.y,"angle":muzzle.angle,"reason":"obstruction"}));
                    self.actors[index].message_until = self.time + 0.4;
                }
                return Ok(false);
            }
            // Nor does it fire when the first thing its round would meet is the construction it is on: a plate set
            // before its own muzzle is no shield to fire from behind.
            let (owner, velocity) = (gun.owner, crate::game_weapons::launch_velocity(muzzle.angle, muzzle.speed));
            // A timed shell no longer exists after its fuze fires. Its later return to the vehicle is no obstruction.
            let until = if s.airburst { muzzle.time } else { crate::game_flight::FLIGHT_HORIZON };
            if self.into_own(index, owner, muzzle.point, Point::new(velocity.x + inherited.x, velocity.y + inherited.y), s.drag, until) {
                if self.visual && self.actors[index].message_until <= self.time {
                    self.events.push(json!({"type":"weapon-blocked","time":self.time,"owner":owner,"x":muzzle.point.x,"y":muzzle.point.y,"angle":muzzle.angle,"reason":"own-vehicle"}));
                    self.actors[index].message_until = self.time + 0.4;
                }
                return Ok(false);
            }
        }
        // Nor while its side has as many rounds in the air as the field lets it (game_shot_budget.rs): it waits for some
        // to come down, with this round still in its box.
        let a = &self.actors[index];
        if self.shot_budget.is_some_and(|budget| !self.airborne.allows(budget, &a.team, a.handle)) {
            if self.visual && a.message_until <= self.time {
                self.events.push(json!({"type":"weapon-blocked","time":self.time,"actorId":a.id,"owner":gun_owner,"x":muzzle.point.x,"y":muzzle.point.y,"angle":muzzle.angle,"reason":"budget"}));
                self.actors[index].message_until = self.time + 0.4;
            }
            return Ok(false);
        }
        let mut effects = Effects::new(self.visual);
        if s.mounted && !self.damage.consume_round(a.handle, &crate::game_variant::cartridge(&gun_preset)) {
            if self.visual && self.actors[index].message_until <= self.time {
                self.events.push(json!({"type":"weapon-empty","time":self.time,"owner":gun_owner,"x":muzzle.point.x,"y":muzzle.point.y,"angle":muzzle.angle}));
                self.actors[index].message_until = self.time + 0.4;
            }
            return Ok(false);
        }
        let handle = a.handle;
        // A hot barrel throws its rounds wider (`BarrelSteel::spread`).
        let hot = gun_owner.and_then(|owner| self.servos.iter().find(|servo| servo.owner == owner))
            .map_or(1.0, |servo| crate::game_barrel::BarrelSteel::spread(servo.barrel.temperature));
        let angle = muzzle.angle + self.projectiles.random.normal() * s.spread * hot * std::f64::consts::PI / 180.0;
        let velocity = crate::game_weapons::launch_velocity(angle, muzzle.speed);
        let projectile_id = self.projectiles.allocate_id();
        let fuze_time = if s.airburst { Some(muzzle.time) } else { None };
        let mut told = json!({"actorId":a.id,"weapon":s.family,"preset":s.preset,"charge":muzzle.charge,"blastRadius":s.blast_radius,
            "poweredTrail":s.powered,"detonation":if s.airburst{"airburst"}else{"impact"},"fuzeTime":fuze_time,"atMuzzle":s.mounted});
        // A shell made otherwise than its reference's carries how its fragments go to where it bursts.
        if let Some((share, reach)) = s.fragments { told["fragments"] = json!(share); told["fragmentReach"] = json!(reach); }
        let mut round = Projectile::fired(projectile_id, handle, muzzle.point,
            Point::new(velocity.x + inherited.x, velocity.y + inherited.y), s, fuze_time, gun_owner, told)?;
        round.hold = hold;
        self.projectiles.projectiles.push(round);
        if self.shot_budget.is_some() {
            let a = &self.actors[index];
            self.airborne.launched(&a.team, a.handle);
        }
        if let Some(gun) = gun_owner {
            effects.impulse(
                gun,
                muzzle.point,
                Point::new(
                    -velocity.x * s.mass * s.recoil,
                    -velocity.y * s.mass * s.recoil,
                ),
            );
        }
        self.apply_effects(core, &mut effects)?;
        // A held trigger carries the fraction of a step the round was late into the next reload.
        let held = match gun_owner {
            Some(owner) => self.gun_held(index, owner),
            None => self.actors[index].trigger.as_ref().is_some_and(|(_, t)| !t.mounted),
        };
        let carried = if held { reload.min(0.0) } else { 0.0 };
        match gun_owner.and_then(|owner| self.servos.iter_mut().find(|servo| servo.owner == owner)) {
            Some(servo) => {
                servo.reload = 60.0 / (s.rate * servo.turning()) + carried;
                servo.fired_round();
                // The round heats the barrel; one fired past the limit wears it, until the barrel is disabled.
                let (owner, worn) = (servo.owner, servo.barrel.fired(&s.ammo, muzzle.charge));
                if worn > 0.0 {
                    if let Some(module) = self.damage.module_mut(owner) { module.wear_barrel(worn); }
                }
            }
            None => self.actors[index].cooldown = 60.0 / s.rate + carried,
        }
        let a = &mut self.actors[index];
        a.shots += 1;
        self.damage.stats.shots += 1;
        if self.visual {
            self.events.push(json!({"type":"muzzle","time":self.time,"actorId":a.id,"owner":gun_owner,"x":muzzle.point.x,"y":muzzle.point.y,"angle":muzzle.angle,"weapon":s.family,"preset":s.preset,"power":s.power,"platform":if s.mounted{"vehicle"}else{"ground"},"caliberMm":s.value["caliberMm"]}));
        }
        Ok(true)
    }
    fn apply_effects(
        &mut self,
        core: &mut NativeWorld,
        effects: &mut Effects,
    ) -> Result<(), String> {
        self.projectiles.append_effects(effects);
        self.commit_ballistic_effects(core, effects);
        let mut guard = 0;
        let sides = if self.projectiles.pending_blasts.is_empty() { Sides::default() } else { self.sides() };
        while let Some(blast) = self.projectiles.pending_blasts.pop_front() {
            let source = blast.actor;
            let event_begin = effects.events.len();
            let mut spared: Vec<u32> = sides.allies(source).collect();
            // Through blow-out panels, it goes off out of its own construction, which their blast door shields
            // (game_damage.rs `Module::ready_blast`).
            if blast.details["vented"] == true { spared.extend(source); }
            let carrier = |actor| {
                let actor = self.actors.iter().find(|a| a.handle == actor)?;
                let body = core.world.bodies.get(*core.bodies.get(&actor.body)?)?;
                if !body.is_dynamic() {
                    return None;
                }
                let center = body.center_of_mass();
                let velocity = body.linvel();
                Some(crate::game_pressure::BlastBody {
                    mass: body.mass(),
                    inertia: body.mass_properties().local_mprops.principal_inertia(),
                    center: Point::new(center.x, center.y),
                    velocity: Point::new(velocity.x, velocity.y),
                    omega: body.angvel(),
                })
            };
            crate::game_pressure::explode(sides.wrecks(),
                blast,
                &spared,
                self.time,
                &mut self.damage,
                &mut self.geometry,
                &self.terrain,
                &mut self.projectiles,
                effects,
                &carrier,
            );
            self.projectiles.append_effects(effects);
            sides.tag_friendly_contacts(source, &mut effects.events[event_begin..], &self.damage);
            // The next detonation sees the preceding impulse and aperture.
            self.commit_ballistic_effects(core, effects);
            guard += 1;
            if guard >= 20 {
                break;
            }
        }
        for mut event in effects.events.drain(..) {
            if event["time"].is_null() {
                event["time"] = json!(self.time);
            }
            self.events.push(event);
        }
        Ok(())
    }
    /// Current teams, direct diplomacy, wrecks and shelters; none of this projection is kept separately.
    fn sides(&self) -> Sides {
        Sides::new(self.actors.iter().map(|a| (a.handle, a.team.as_str(), a.defeated, a.sheltered)),
            |a, b| self.sensors.allied(a, b))
    }
    // The rounds in the air of each side and construction, counted over; a field with no budget counts none.
    fn count_airborne(&mut self) {
        if self.shot_budget.is_none() {
            return;
        }
        let sides: HashMap<u32, &str> = self.actors.iter().map(|a| (a.handle, a.team.as_str())).collect();
        self.airborne = Airborne::of(self.projectiles.projectiles.iter().filter_map(|p| p.actor), |actor| sides.get(&actor).copied());
    }
    fn commit_ballistic_effects(&mut self, core: &mut NativeWorld, effects: &mut Effects) {
        // Ballistic apertures affect rays only: damage changes neither the admitted
        // contact contour nor the mass, COM and inertia of the body.
        for owner in effects.region_changes.drain(..) {
            if let Some(p) = self.damage.plate(owner) {
                self.geometry.set_grid(owner, &p.grid);
            }
        }
        let moved = !effects.impulses.is_empty();
        for impulse in effects.impulses.drain(..) {
            let Some(b) = self.bindings.iter().find(|b| b.owner == impulse.owner) else {
                continue;
            };
            if let Some(body) = core
                .bodies
                .get(&b.body)
                .and_then(|h| core.world.bodies.get_mut(*h))
            {
                body.apply_impulse_at_point(
                    Vector::new(impulse.impulse.x, impulse.impulse.y),
                    Vector::new(impulse.point.x, impulse.point.y),
                    true,
                );
            }
            if let Some(a) = self.actors.iter_mut().find(|a| a.body == b.body) {
                if let Some(d) = &mut a.drive {
                    d.record_impulse(impulse.impulse);
                }
            }
        }
        if moved {
            self.sync_poses(core);
        }
    }
    /// What a cold frame says of a construction, of a plate and of a piece: all the host keeps of each, whatever
    /// the frames before it told. A scene that was loaded is told so, and a construction that came to a field
    /// that goes on (`admit`).
    fn cold_actor(a: &Actor) -> Value {
        json!({"id":a.id,"contactContours":a.contact_contours,"cooldown":a.cooldown,"lastWeapon":a.last_weapon,"aim":a.aim.to_value(),"weapon":a.weapon.as_ref().map(|w|&w.value),
            "trigger":a.trigger.as_ref().map(|(aim,w)|json!({"aim":aim.to_value(),"config":w.value})),"pendingShot":a.pending.as_ref().map(|(aim,w,e)|json!({"aim":aim.to_value(),"settings":w.value,"expires":e})),
            "also":a.also.iter().map(|e|json!({"aim":e.aim.to_value(),"config":e.settings.value,"held":e.held,"expires":e.pending})).collect::<Vec<_>>(),
            "stats":{"shots":a.shots},"eyes":a.eyes,"vehicle":a.drive.as_ref().map(|d|d.to_value(&a.powertrain))})
    }
    fn cold_plate(&self, b: &Binding) -> Option<Value> {
        let p=self.damage.plate(b.owner)?;
        let damage=Some(p.to_value());
        let velocity=p.velocity_at(Point::new(p.pose.x,p.pose.y));Some(json!({"owner":p.owner,"pose":p.pose.to_value(),"motion":{"x":p.pose.x,"y":p.pose.y,"angle":p.pose.angle,"vx":velocity.x,"vy":velocity.y,"omega":p.angular_velocity,"sleeping":b.sleeping,"age":b.age},"damage":damage}))
    }
    fn cold_module(&self, m: &Module) -> Value {
        let mut value = m.to_value();
        value["owner"] = json!(m.owner);
        if let Some(s) = self.servos.iter().find(|s| s.owner == m.owner) {
            for (k, v) in s.to_value().as_object().unwrap() {
                value[k] = v.clone();
            }
            if m.mount.is_some() {value["targetAimOffset"]=json!(angle_difference(s.target,m.pose.angle));}
        }
        if let Some(g) = self.gears.iter().find(|g| g.owner == m.owner) {
            value["groundContact"] = g
                .ground_contact
                .as_ref()
                .map(|c| c.to_value())
                .unwrap_or(Value::Null);
        }
        if let Some(g) = self.gear_bindings.iter().find(|g| g.owner == m.owner) {
            value["wheelSpin"] = json!(g.angle);
            value["wheelAngularSpeed"] = json!(g.angular_speed);
            value["suspension"]["travel"] = json!(g.travel);
            value["suspension"]["displacement"] = json!(g.displacement);
            value["suspension"]["tilt"] = json!(g.tilt);
            value["suspension"]["compression"] = json!(g.compression);
        }
        value
    }
    pub(super) fn cold_parts(&self, handles: &[u32]) -> Value {
        json!({"actors":self.actors.iter().filter(|a| handles.contains(&a.handle)).map(Self::cold_actor).collect::<Vec<_>>(),
            "plates":self.bindings.iter().filter(|b| self.damage.plate(b.owner).is_some_and(|p| handles.contains(&p.actor)))
                .filter_map(|b| self.cold_plate(b)).collect::<Vec<_>>(),
            "modules":self.damage.modules.iter().filter(|m| handles.contains(&m.actor)).map(|m| self.cold_module(m)).collect::<Vec<_>>(),
            "tows":self.tow_frame()})
    }
    pub fn frame(&mut self) -> Value {
        // A complete cold frame can replace the host's presentation cache.
        let actors=self.actors.iter().map(Self::cold_actor).collect::<Vec<_>>();
        // Cold consumers require a complete, independently usable snapshot even
        // after presentation packets have already exported these revisions.
        let plates=self.bindings.iter().filter_map(|b|self.cold_plate(b)).collect::<Vec<_>>();
        let modules = self
            .damage
            .modules
            .iter()
            .map(|m| self.cold_module(m))
            .collect::<Vec<_>>();
        // A cold frame tells the whole legend of the kinds of round over again.
        self.projectiles.publish_kinds();
        self.projectiles.kinds_told = self.projectiles.kinds.len();
        let kinds = self.projectiles.kinds.iter().map(|kind| kind.to_value()).collect::<Vec<_>>();
        json!({"time":self.time,"tick":self.tick,"nextId":self.projectiles.next_id,"randomState":self.projectiles.random.state,"recoveries":self.recoveries,"actors":actors,"plates":plates,"modules":modules,"tows":self.tow_frame(),
            "projectiles":self.projectiles.projectiles.iter().map(Projectile::to_value).collect::<Vec<_>>(),
            "shots":self.projectiles.projectiles.len(),"shotKinds":{"from":0,"list":kinds},"stats":self.damage.stats.to_value(),"events":std::mem::take(&mut self.events)})
    }
    /// The rounds in the air as words, for a screen: see `ProjectileState::block`.
    pub fn shot_block(&mut self) -> Vec<f64> {
        self.projectiles.block()
    }
    /// What the air takes of each of those rounds: see `ProjectileState::drags`.
    pub fn shot_drags(&self) -> Vec<f64> {
        self.projectiles.drags()
    }
    pub fn clock(&self) -> (f64, u64) {
        (self.time, self.tick)
    }
    // A print of the field as it stands, by which two runs of it are told apart: its time, the place and the
    // motion of every body to the last bit, and every round in the air. Fields that stepped alike print alike.
    fn digest(&self, core: &NativeWorld) -> String {
        use sha2::{Digest, Sha256};
        let mut words = vec![self.time, self.tick as f64];
        for (id, handle) in &core.bodies {
            let Some(body) = core.world.bodies.get(*handle) else { continue };
            let (place, motion) = (body.translation(), body.linvel());
            words.extend([f64::from(*id), place.x, place.y, body.rotation().angle(), motion.x, motion.y, body.angvel()]);
        }
        for round in &self.projectiles.projectiles {
            words.extend([round.id as f64, round.point.x, round.point.y, round.velocity.x, round.velocity.y,
                round.power, round.age, f64::from(u8::from(round.detonated))]);
        }
        self.tow_digest(&mut words);
        let mut hash = Sha256::new();
        for word in words {
            hash.update(word.to_bits().to_le_bytes());
        }
        hash.finalize().iter().map(|byte| format!("{byte:02x}")).collect()
    }
    pub fn command(&mut self, core: &mut NativeWorld, r: &Value) -> Result<Value, String> {
        let op = text(r, "op", "");
        let result = match op {
            "towAttach" => self.command_tow_attach(core, r),
            "towDetach" => self.command_tow_detach(r),
            "sync" => Ok(Value::Null),
            "admit" => self.admit(core, r),
            "projectiles" => Ok(json!(self.projectiles.projectiles.iter().map(Projectile::to_value).collect::<Vec<_>>())),
            "digest" => Ok(json!(self.digest(core))),
            "material" => self.command_material(r),
            "raycast" | "raycastLayers" => self.command_ray(text(r, "op", ""), r),
            "physics" => self.command_physics(core, r),
            "scriptedDecision" => self.command_scripted(r),
            "scriptedDecisions" => self.command_scripted_batch(r),
            "lineOfFire" => self.command_line(r),
            "teamSight" => self.command_sight(r),
            "alliances" => self.command_alliances(r),
            "projectile" => self.command_projectile(r),
            "setPartStates" => self.command_part_states(core, r),
            "work" => self.command_work(r),
            // The field lays its roads anew (`Terrain::set_roads`): the ground under them is theirs from the next step.
            "roads" => self.terrain.set_roads(&r["roads"]).map(|()| json!(true)),
            "setVehicleState" | "setActorState" => self.command_state(core, text(r, "op", ""), r),
            "explode" | "cut" | "setPartState" | "dent" | "impulse" => self.command_damage(core, text(r, "op", ""), r),
            op => self.command_actor(core, op, r),
        };
        // Queries do not change gameplay. Even a partly accepted damage batch must release a lost anchor.
        if !matches!(op, "sync" | "projectiles" | "digest" | "material" | "raycast" | "raycastLayers" | "physics" |
            "scriptedDecision" | "scriptedDecisions" | "lineOfFire" | "teamSight") { self.prune_tows(core); }
        result
    }

}
#[cfg(test)]
impl GameState {
    fn handle_of(&self, id: &str) -> u32 {
        self.actors.iter().find(|a| a.id == id).unwrap().handle
    }
    /// What the sensors of a construction's side hold of another, as its pilot asks them before it decides.
    fn sense_combat(&mut self, observer: &str, target: &str) -> crate::game_sensors::Contact {
        let (observer, target) = (self.handle_of(observer), self.handle_of(target));
        self.refresh_sensors();
        sensor_view!(self => view);
        self.sensors.sense_combat(&view, observer, target).unwrap()
    }
    /// What they read of the ground, as its pilot asks them.
    fn sense_terrain(&mut self, observer: &str) -> TerrainReading {
        let observer = self.handle_of(observer);
        self.refresh_sensors();
        sensor_view!(self => view);
        self.sensors.sense_terrain(&view, observer).unwrap()
    }
    /// The height of the ground at a place, as its pilot holds it once it has read the ground.
    fn observed_height(&mut self, observer: &str, x: f64) -> Option<f64> {
        self.sense_terrain(observer);
        let observer = self.handle_of(observer);
        sensor_view!(self => view);
        self.sensors.observed_terrain(&view, observer).unwrap().height(x)
    }
}
struct Query<'a> {
    geometry: &'a Geometry,
    terrain: &'a Terrain,
}
impl SensorQuery for Query<'_> {
    fn terrain_raycast(&self, a: Point, b: Point) -> Option<SensorHit> {
        self.terrain.raycast(a, b).map(|h| SensorHit {
            enter: h.enter,
            point: h.point,
            normal: h.normal,
            actor: None,
        })
    }
    fn material_raycast(&self, a: Point, b: Point, actor: u32, wave: Option<crate::game_damage::Wave>) -> Option<SensorHit> {
        self.geometry
            .raycast(
                a,
                b,
                &RayOptions {
                    ignore_actors: &[actor],
                    wave,
                    ..Default::default()
                },
            )
            .map(|h| SensorHit {
                enter: h.enter,
                point: h.point,
                normal: h.normal,
                actor: Some(h.actor),
            })
    }
}

#[cfg(test)]
mod native_configuration_tests {
    use super::*;
    use rapier2d_f64::prelude::Rotation;

    fn pilot_sensor_world() -> NativeWorld { pilot_sensor_world_with_owners(true) }
    fn pilot_sensor_world_with_owners(duplicate_owners: bool) -> NativeWorld {
        let mut scene = crate::game_damage::fixtures::mounted_scene(&[(1,"local",0.0),(2,"opponent",60.0)],0);
        scene["actors"][0]["team"] = json!("red");
        scene["actors"][1]["team"] = json!("blue");
        // A repeated handle keeps two actors, with only the actual pilot carrying a vehicle.
        let mut first = scene["actors"][0].clone();
        first["id"] = json!("first-observer"); first["vehicle"] = Value::Null;
        scene["actors"].as_array_mut().unwrap().insert(0,first);
        let modules = scene["modules"].as_array_mut().unwrap();
        // A non-weapon reading wins the duplicate owner lookup of the first gun.
        if duplicate_owners { modules.iter_mut().find(|m|m["actor"]==1 && m["kind"]=="command").unwrap()["owner"] = json!(11); }
        let mut extra = modules.iter().find(|m|m["actor"]==1 && m["kind"]=="weapon").unwrap().clone();
        extra["owner"] = json!(17); extra["id"] = json!("extra-gun"); modules.push(extra);
        for (actor,x) in [(1,0.0),(2,60.0)] {
            for (owner,config) in [
                (actor*10+8,json!({"id":format!("feed-{actor}"),"kind":"ammo","ammoPreset":"minimi","rounds":30,"x":x,"y":2})),
                (actor*10+9,json!({"id":format!("camera-{actor}"),"kind":"sensor","sensorMode":"visual","x":x,"y":14})),
            ] {
                let mut module = crate::game_damage::fixtures::module(owner,actor,&config).to_value();
                module["owner"] = json!(owner); module["actor"] = json!(actor); modules.push(module);
            }
        }
        let mut core = NativeWorld::new(&[],0.0,-9.81).unwrap();
        core.load_game_value(&scene).unwrap();
        let game = core.game.as_mut().unwrap();
        // Clear firing corridors above the hulls, with separate heights for the two own guns.
        for module in &mut game.damage.modules {
            if module.kind != ComponentKind::Weapon { continue; }
            module.pose.y = if module.owner==17 {12.0} else {10.0};
            module.pose.angle = if module.actor==1 {0.0} else {std::f64::consts::PI};
            module.barrel_angle = module.pose.angle;
            game.geometry.upsert(module.owner,EntityGeometry::from_module(module));
        }
        game.refresh_sensors();
        core
    }
    #[test]
    fn launch_keeps_alignment_and_the_full_muzzle_flight_solution() {
        let mut core = pilot_sensor_world_with_owners(false);
        let mut game = core.game.take().unwrap();
        game.visual = true;
        let index = game.actors.iter().position(|a| a.id == "local").unwrap();
        let drive = game.actors[index].drive.as_mut().unwrap();
        drive.velocity = Point::new(2.0, 0.3);
        drive.omega = 0.05;
        let settings = Settings::admit(&game.catalogue,
            &json!({"preset":"minimi","platform":"vehicle"}), Some(11), true).unwrap();
        let gun = game.damage.module(11).unwrap();
        let origin = Point::new(gun.pose.x, gun.pose.y);
        let aim = Point::new(origin.x + 80.0, origin.y + 8.0);
        let sector = mount_sector(gun);
        let drive = game.actors[index].drive.as_ref().unwrap();
        let (pivot_velocity, omega) = (drive.velocity_at(origin), drive.omega);
        let ideal = solution_with_motion(origin, aim, &settings, None, pivot_velocity, omega, sector);
        assert!(ideal.reachable);
        let before = (game.damage.modules.iter().map(|m| m.rounds).collect::<Vec<_>>(),
            game.damage.stats.shots, game.projectiles.random.state);
        let gun = game.damage.module_mut(11).unwrap();
        gun.barrel_angle = ideal.angle + 0.1;
        game.geometry.set_pose(11, gun.pose, Some(gun.barrel_angle));
        assert!(!game.launch(&mut core, index, aim, &settings, false).unwrap());
        assert!(game.projectiles.projectiles.is_empty());
        assert_eq!(before, (game.damage.modules.iter().map(|m| m.rounds).collect::<Vec<_>>(),
            game.damage.stats.shots, game.projectiles.random.state));

        let gun = game.damage.module_mut(11).unwrap();
        gun.barrel_angle = ideal.angle;
        game.geometry.set_pose(11, gun.pose, Some(gun.barrel_angle));
        let muzzle = solution_with_motion(origin, aim, &settings, Some(ideal.angle), pivot_velocity, omega, sector);
        let inherited = game.actors[index].drive.as_ref().unwrap().velocity_at(muzzle.point);
        let mut random = game.projectiles.random;
        let angle = muzzle.angle + random.normal() * settings.spread * std::f64::consts::PI / 180.0;
        let velocity = crate::game_weapons::launch_velocity(angle, muzzle.speed);
        assert!(game.launch(&mut core, index, aim, &settings, false).unwrap());
        let round = &game.projectiles.projectiles[0];
        assert_eq!(round.point, muzzle.point);
        assert_eq!(round.velocity, Point::new(velocity.x + inherited.x, velocity.y + inherited.y));
        assert_eq!(round.actor, Some(1));
        assert_eq!(round.emitter_ids, vec![11]);
        assert_eq!(round.fuze_time, None);
        assert_eq!(round.cold["charge"], json!(muzzle.charge));
        assert_eq!(game.projectiles.random.state, random.state);
        assert_eq!(game.damage.module(18).unwrap().rounds, 29);
        assert_eq!(game.damage.stats.shots, before.1 + 1);
        assert_eq!(game.servos.iter().find(|s| s.owner == 11).unwrap().reload, 60.0 / settings.rate);
        let event = game.events.iter().find(|e| e["type"] == "muzzle").unwrap();
        assert_eq!((event["x"].as_f64().unwrap(), event["y"].as_f64().unwrap(), event["angle"].as_f64().unwrap()),
            (muzzle.point.x, muzzle.point.y, muzzle.angle));
    }
    #[test]
    fn a_rotary_gun_comes_up_to_its_rate_and_fires_the_rounds_of_a_step_one_behind_another() {
        let mut core = pilot_sensor_world_with_owners(false);
        let mut game = core.game.take().unwrap();
        let index = game.actors.iter().position(|a| a.id == "local").unwrap();
        let drive = game.actors[index].drive.as_mut().unwrap();
        (drive.velocity, drive.omega) = (Point::ZERO, 0.0);
        // The Minimi made over with seven barrels: it fires the Minimi's rounds, from the box it had.
        crate::game_variant::ensure(&mut game.catalogue, "minimi|N7").unwrap();
        game.damage.module_mut(11).unwrap().weapon_preset = "minimi|N7".into();
        game.damage.module_mut(18).unwrap().rounds = 500;
        let settings = Settings::admit(&game.catalogue, &json!({"preset":"minimi|N7","platform":"vehicle"}), Some(11), true).unwrap();
        assert_eq!(settings.rate, 7.0 * crate::game_variant::ROTARY_RATE);
        let k = game.servos.iter().position(|s| s.owner == 11).unwrap();
        // Its rotor comes up to its rate in `SPIN_UP` with the trigger held, and stops in `SPIN_DOWN`.
        let rotor = &mut game.servos[k];
        rotor.spin_up = crate::game_variant::SPIN_UP;
        assert_eq!(rotor.turning(), crate::game_variant::SPIN_FLOOR);
        rotor.spin(crate::game_variant::SPIN_UP / 2.0, true);
        assert!((rotor.turning() - 0.5).abs() < 1e-12);
        rotor.spin(crate::game_variant::SPIN_DOWN / 2.0, false);
        assert_eq!(rotor.spin, 0.0);
        rotor.spin(1.0, true);
        // Laid on its aim with a step's worth of reload in hand, it fires two rounds in the step: the second leaves
        // as much later as it fires them, and flies that much less of the step.
        let gun = game.damage.module(11).unwrap();
        let origin = Point::new(gun.pose.x, gun.pose.y);
        let aim = Point::new(origin.x + 80.0, origin.y + 8.0);
        let muzzle = solution_with_motion(origin, aim, &settings, None, Point::ZERO, 0.0, mount_sector(gun));
        let gun = game.damage.module_mut(11).unwrap();
        gun.barrel_angle = muzzle.angle;
        let laid = gun.pose;
        game.geometry.set_pose(11, laid, Some(muzzle.angle));
        game.actors[index].trigger = Some((aim, settings.clone()));
        game.servos[k].reload = -ROUND_STEP;
        assert!(game.launch(&mut core, index, aim, &settings, false).unwrap());
        game.volley(&mut core, index, aim, &settings, ROUND_STEP).unwrap();
        let gap = 60.0 / settings.rate;
        assert_eq!(game.projectiles.projectiles.iter().map(|p| p.hold).collect::<Vec<_>>(), vec![0.0, gap]);
        assert_eq!(game.damage.module(18).unwrap().rounds, 498);
        assert!((game.servos[k].reload - (2.0 * gap - ROUND_STEP)).abs() < 1e-12);
    }
    #[test]
    fn a_round_heats_its_barrel_a_hot_one_throws_wider_one_near_failure_wears_it_and_the_air_cools_it() {
        use crate::game_barrel::{Air, BarrelSteel};
        let mut core = pilot_sensor_world_with_owners(false);
        let mut game = core.game.take().unwrap();
        let index = game.actors.iter().position(|a| a.id == "local").unwrap();
        let drive = game.actors[index].drive.as_mut().unwrap();
        (drive.velocity, drive.omega) = (Point::ZERO, 0.0);
        let settings = Settings::admit(&game.catalogue, &json!({"preset":"minimi","platform":"vehicle"}), Some(11), true).unwrap();
        let steel = BarrelSteel::from_catalogue(&game.catalogue["minimi"]).unwrap();
        let servo = |game: &GameState| game.servos.iter().find(|s| s.owner == 11).unwrap().clone();
        // It comes in as warm as the air at the height it came in at.
        let gun = game.damage.module(11).unwrap();
        let cold = servo(&game).barrel.temperature;
        assert!((cold - Air::at(gun.pose.y, 0.0).temperature).abs() < 0.1 && servo(&game).barrel.steel == steel, "{cold}");
        let origin = Point::new(gun.pose.x, gun.pose.y);
        let aim = Point::new(origin.x + 80.0, origin.y + 8.0);
        let muzzle = solution_with_motion(origin, aim, &settings, None, Point::ZERO, 0.0, mount_sector(gun));
        let gun = game.damage.module_mut(11).unwrap();
        gun.barrel_angle = muzzle.angle;
        let laid = gun.pose;
        game.geometry.set_pose(11, laid, Some(muzzle.angle));
        // A round from a cold barrel heats it by what it leaves in its steel, and goes out as wide as the gun throws.
        let mut random = game.projectiles.random;
        let angle = muzzle.angle + random.normal() * settings.spread * std::f64::consts::PI / 180.0;
        assert!(game.launch(&mut core, index, aim, &settings, true).unwrap());
        assert_eq!(game.projectiles.projectiles[0].velocity, crate::game_weapons::launch_velocity(angle, muzzle.speed));
        assert_eq!((servo(&game).barrel.temperature, servo(&game).barrel.cooling), (cold + 810.0 / steel.capacity(cold), false));
        // At 500 °C it throws twice as wide and holds its pilot; at 800 °C a round wears its barrel. (The first round set the
        // vehicle going and its body moved the gun: both stand again as laid for the first.)
        let most = game.damage.module(11).unwrap().max_health * BARREL_DISABLED_SHARE;
        for (hot, wider, shot) in [(500.0, 2.0, 1), (800.0, 2.5, 2)] {
            let drive = game.actors[index].drive.as_mut().unwrap();
            (drive.velocity, drive.omega) = (Point::ZERO, 0.0);
            let gun = game.damage.module_mut(11).unwrap();
            (gun.pose, gun.barrel_angle, gun.barrel_damage) = (laid, muzzle.angle, 0.0);
            game.geometry.set_pose(11, laid, Some(muzzle.angle));
            game.servos.iter_mut().find(|s| s.owner == 11).unwrap().barrel.temperature = hot;
            let mut random = game.projectiles.random;
            let angle = muzzle.angle + random.normal() * settings.spread * wider * std::f64::consts::PI / 180.0;
            assert!(game.launch(&mut core, index, aim, &settings, true).unwrap());
            assert_eq!(game.projectiles.projectiles[shot].velocity, crate::game_weapons::launch_velocity(angle, muzzle.speed));
            assert_eq!((servo(&game).barrel.temperature, servo(&game).barrel.cooling), (hot + 810.0 / steel.capacity(hot), true));
            assert!((game.damage.module(11).unwrap().barrel_damage - BarrelSteel::wear(hot) * most).abs() < 1e-9);
        }
        // Enough wear disables it.
        game.damage.module_mut(11).unwrap().wear_barrel(1.0);
        assert!(game.damage.module(11).unwrap().barrel_disabled);
        // In the air it cools, and the pilot may fire again ten degrees under its limit.
        game.projectiles.projectiles.clear();
        game.servos.iter_mut().find(|s| s.owner == 11).unwrap().barrel.temperature = 500.0;
        let hot = servo(&game).barrel;
        game.step(&mut core, 1.0 / 60.0).unwrap();
        let module = game.damage.module(11).unwrap();
        let mut expected = hot.clone();
        expected.air(Air::at(module.pose.y, game.actors[index].drive.as_ref().unwrap().velocity_at(Point::new(module.pose.x, module.pose.y)).x.hypot(
            game.actors[index].drive.as_ref().unwrap().velocity_at(Point::new(module.pose.x, module.pose.y)).y)), 1.0 / 60.0);
        assert!((servo(&game).barrel.temperature - expected.temperature).abs() < 1e-6, "{} {}", servo(&game).barrel.temperature, expected.temperature);
        let mut steps = 1;
        while servo(&game).barrel.cooling { game.step(&mut core, 1.0 / 60.0).unwrap(); steps += 1; }
        assert!(servo(&game).barrel.temperature <= 490.0 && servo(&game).barrel.temperature > 489.0);
        assert!(steps > 60, "{steps} steps to cool");
    }
    #[test]
    fn scripted_batches_continue_after_errors_and_keep_the_final_gun_scope() {
        for duplicates in [false, true] { for (requests, last, good) in [
            (json!([{"actorId":"local","targetId":"opponent"},{"actorId":"missing"},
                {"actorId":"opponent","targetId":"local"}]), 2, 2),
            (json!([{"actorId":"opponent","targetId":"local"},
                {"actorId":"local","targetId":"local"}]), 1, 0),
        ] {
            let mut core = pilot_sensor_world_with_owners(duplicates);
            let game = core.game.as_mut().unwrap();
            for servo in &mut game.servos { servo.reload = 0.5; }
            for module in game.damage.modules.iter_mut().filter(|m|m.kind==ComponentKind::Weapon && m.actor==2) {
                module.pose.y = -5.0;
                game.geometry.upsert(module.owner,EntityGeometry::from_module(module));
            }
            let packet: Value = serde_json::from_str(&core.game_command_value(&json!({
                "op":"scriptedDecisions","requests":requests})).unwrap()).unwrap();
            assert!(packet["frame"].is_null());
            let rows = packet["result"].as_array().unwrap();
            assert_eq!(rows.len(),requests.as_array().unwrap().len());
            assert!(rows[1]["error"].is_string());
            assert_eq!(rows[good]["result"]["targetId"],"local");
            assert_eq!(rows[good]["result"]["contact"]["detected"],true);
            let readings = &core.game.as_ref().unwrap().sensor_modules;
            assert!(readings.iter().any(|r|r.actor==last && r.kind==ComponentKind::Weapon && r.reload==0.5 && r.servo_max_speed>0.0));
            assert!(readings.iter().filter(|r|r.actor!=last).all(|r|r.reload==0.0 && r.servo_max_speed==0.0 && !r.muzzle_blocked));
            assert_eq!(readings.iter().any(|r|r.actor==2 && r.muzzle_blocked),last==2,
                "an invalid final target still owns the final sensor refresh");
        } }
    }

    #[test]
    fn scripted_batch_contact_controls_hold_a_trigger_until_the_world_steps() {
        let mut core = pilot_sensor_world_with_owners(false);
        let request = json!({"op":"scriptedDecisions","requests":[
            {"actorId":"local","targetId":"opponent"},{"actorId":"opponent","targetId":"local"}]});
        let first: Value = serde_json::from_str(&core.game_command_value(&request).unwrap()).unwrap();
        let chosen = &first["result"][0]["result"]["action"];
        assert_eq!(first["result"][0]["result"]["diagnostics"]["viableShots"],1);
        // Start with the selected real gun already laid, so this tests a held
        // trigger rather than depending on how long its servo takes to align.
        core.game.as_mut().unwrap().damage.modules.iter_mut()
            .find(|m|m.actor==1 && m.cold["id"]==chosen["componentId"]).unwrap().barrel_angle = chosen["aimAngle"].as_f64().unwrap();
        let packet: Value = serde_json::from_str(&core.game_command_value(&request).unwrap()).unwrap();
        let decision = &packet["result"][0]["result"];
        assert_eq!(decision["targetId"],"opponent"); assert_eq!(decision["contact"]["detected"],true);
        assert_eq!(decision["action"]["fire"],true); assert_ne!(decision["action"]["shot"],true);
        let game = core.game.as_ref().unwrap();
        let before = (game.damage.modules.iter().map(|m|m.rounds).collect::<Vec<_>>(),game.damage.stats.shots,game.projectiles.random.state);
        let admitted: Value = serde_json::from_str(&core.game_command_value(&json!({
            "op":"input","actorId":"local","input":decision["action"],"frame":false})).unwrap()).unwrap();
        assert_eq!(admitted["result"]["accepted"],true);
        assert_eq!(admitted["result"]["record"]["fire"],true); assert_eq!(admitted["result"]["record"]["shot"],false);
        let game = core.game.as_ref().unwrap();
        assert!(game.actors.iter().find(|a|a.id=="local").unwrap().trigger.is_some());
        assert_eq!(before,(game.damage.modules.iter().map(|m|m.rounds).collect::<Vec<_>>(),game.damage.stats.shots,game.projectiles.random.state));
    }

    #[test]
    fn scripted_batches_rebuild_allied_and_sheltered_firing_lanes() {
        let mut scene = crate::game_damage::fixtures::mounted_scene(
            &[(1,"local",0.0),(2,"opponent",60.0),(3,"blocker",30.0)],0);
        for (actor, team) in scene["actors"].as_array_mut().unwrap().iter_mut().zip(["red","blue","green"]) {
            actor["team"] = json!(team);
        }
        let mut wall = crate::game_damage::fixtures::plate(900,3,&json!({"definition":{
            "id":"blocker-wall","x":30,"y":8,"length":8,"angle":std::f64::consts::FRAC_PI_2,
            "thicknessMm":400,"material":"glass"}})).to_value();
        wall["owner"] = json!(900); wall["actor"] = json!(3);
        scene["plates"].as_array_mut().unwrap().push(wall);
        for (actor,x) in [(1,0.0),(2,60.0)] {
            for (owner,config) in [
                (actor*10+8,json!({"id":format!("feed-{actor}"),"kind":"ammo","ammoPreset":"minimi","rounds":30,"x":x,"y":2})),
                (actor*10+9,json!({"id":format!("camera-{actor}"),"kind":"sensor","sensorMode":"visual","x":x,"y":12})),
            ] {
                let mut module = crate::game_damage::fixtures::module(owner,actor,&config).to_value();
                module["owner"] = json!(owner); module["actor"] = json!(actor);
                scene["modules"].as_array_mut().unwrap().push(module);
            }
        }
        let (mut batch,mut scalar) = (NativeWorld::new(&[],0.0,-9.81).unwrap(),NativeWorld::new(&[],0.0,-9.81).unwrap());
        for core in [&mut batch,&mut scalar] {
            core.load_game_value(&scene).unwrap();
            let game = core.game.as_mut().unwrap();
            // Internal static firing corridors, as in pilot_sensor_world: configure after admission's sync_poses.
            // Glass passes the cameras' light while the 400 mm wall still stops these rounds.
            for module in game.damage.modules.iter_mut().filter(|m|m.kind==ComponentKind::Weapon) {
                module.pose.y = 10.0;
                module.pose.angle = if module.actor==1 {0.0} else {std::f64::consts::PI};
                module.barrel_angle = module.pose.angle;
                game.geometry.upsert(module.owner,EntityGeometry::from_module(module));
            }
            game.refresh_sensors();
            let owners: HashSet<_> = game.damage.modules.iter().map(|module|module.owner).collect();
            assert_eq!(owners.len(),game.damage.modules.len(),"this functional case must exercise the shared batch path");
        }
        let requests = json!([{"actorId":"local","targetId":"opponent"},{"actorId":"opponent","targetId":"local"}]);
        for (team,sheltered,defeated,blocked) in [
            ("red",false,false,[true,false]), ("green",true,false,[true,true]),
            ("green",false,false,[false,false]), ("red",false,true,[false,false]),
        ] {
            // Ownership/protection changes only BETWEEN complete batches, without advancing or applying controls.
            for core in [&mut batch,&mut scalar] {
                let blocker = core.game.as_mut().unwrap().actors.iter_mut().find(|a|a.id=="blocker").unwrap();
                blocker.team = team.into(); blocker.sheltered = sheltered; blocker.defeated = defeated;
            }
            let packet: Value = serde_json::from_str(&batch.game_command_value(&json!({"op":"scriptedDecisions","requests":requests})).unwrap()).unwrap();
            let expected = requests.as_array().unwrap().iter().map(|request| {
                let mut single = request.clone(); single["op"] = json!("scriptedDecision");
                serde_json::from_str::<Value>(&scalar.game_command_value(&single).unwrap()).unwrap()["result"].clone()
            }).map(|result|json!({"result":result})).collect::<Vec<_>>();
            let rows = &packet["result"];
            assert_eq!(rows,&json!(expected),"team={team}, sheltered={sheltered}, defeated={defeated}");
            for (index,target) in ["opponent","local"].into_iter().enumerate() {
                let decision = &rows[index]["result"];
                assert_eq!(decision["targetId"],target);
                assert_eq!(decision["contact"]["detected"],true);
                assert!(decision["diagnostics"]["checkedPaths"].as_u64().unwrap()>0,"the real firing path must be checked");
                assert_eq!(decision["diagnostics"]["viableShots"],json!(usize::from(!blocked[index])),"team={team}, sheltered={sheltered}, defeated={defeated}, index={index}, decision={decision}");
                if blocked[index] {
                    assert_eq!(decision["diagnostics"]["reason"],"ally-in-line");
                    assert_eq!(decision["action"]["fire"],false);
                } else {
                    assert_ne!(decision["diagnostics"]["reason"],"ally-in-line");
                }
            }
        }
    }
    fn pilot_sensor_compare(full: &mut NativeWorld, scoped: &mut NativeWorld, actor: &str, target: &str) -> Value {
        let game = full.game.as_mut().unwrap();
        let index = game.actors.iter().position(|a|a.id==actor).unwrap();
        game.refresh_sensors();
        let expected = game.scripted_choice(index,game.bounds,Some(target)).unwrap().to_value();
        let actual = scoped.game.as_mut().unwrap().command_scripted(&json!({"actorId":actor,"targetId":target})).unwrap();
        assert_eq!(actual,expected,"complete decision for {actor}");
        assert_eq!(scoped.game.as_ref().unwrap().digest(scoped),full.game.as_ref().unwrap().digest(full));
        assert_eq!(scoped.game.as_ref().unwrap().events,full.game.as_ref().unwrap().events);
        actual
    }
    #[test]
    fn pilot_sensor_refresh_scopes_reload_and_damaged_servo_status_by_handle() {
        let mut core = pilot_sensor_world();
        let game = core.game.as_mut().unwrap();
        let normal_speed = game.sensor_modules.iter().find(|m|m.actor==2 && m.kind==ComponentKind::Weapon).unwrap().servo_max_speed;
        for (index,servo) in game.servos.iter_mut().enumerate() { servo.reload = 0.25+index as f64; }
        let mut later = game.servos[0].clone(); later.reload = 9.5; game.servos.push(later);
        for module in &mut game.damage.modules {
            if module.kind==ComponentKind::Weapon { module.elevation_damage = module.max_health*BARREL_DISABLED_SHARE*0.5; }
        }
        game.refresh_sensors();
        let repeated: Vec<_> = game.sensor_modules.iter().filter(|m|m.actor==1 && m.handle==11).collect();
        assert_eq!(repeated.len(),2);
        assert_eq!(repeated[0].kind,ComponentKind::Command);
        assert_eq!(repeated[1].kind,ComponentKind::Weapon);
        assert!(repeated.iter().all(|m|m.reload.to_bits()==0.25_f64.to_bits()),"the first global servo also supplies a non-weapon duplicate reading");
        let damaged_speed = game.sensor_modules.iter().find(|m|m.actor==2 && m.kind==ComponentKind::Weapon).unwrap().servo_max_speed;
        assert!(damaged_speed>0.0 && damaged_speed<normal_speed,"elevation damage changes the projected speed");
        let expected: Vec<_> = game.sensor_modules.iter().map(|m|(m.reload.to_bits(),m.servo_max_speed.to_bits(),m.muzzle_blocked)).collect();
        let complete = rmp_serde::to_vec(&game.sensor_modules).unwrap();
        for handle in [1,2,1] {
            game.refresh_sensors_for(Some(handle));
            for (reading,&(reload,speed,blocked)) in game.sensor_modules.iter().zip(&expected) {
                let own = reading.actor==handle;
                assert_eq!(reading.reload.to_bits(),if own {reload} else {0.0_f64.to_bits()});
                assert_eq!(reading.servo_max_speed.to_bits(),if own {speed} else {0.0_f64.to_bits()});
                assert_eq!(reading.muzzle_blocked,own && blocked);
            }
        }
        game.refresh_sensors();
        assert_eq!(rmp_serde::to_vec(&game.sensor_modules).unwrap(),complete,"None restores every complete reading");
    }
    #[test]
    fn pilot_sensor_refresh_keeps_decisions_when_handles_alternate_and_owners_repeat() {
        let (mut full,mut scoped) = (pilot_sensor_world(),pilot_sensor_world());
        for (actor,target) in [("local","opponent"),("opponent","local"),("local","opponent")] {
            let decision = pilot_sensor_compare(&mut full,&mut scoped,actor,target);
            assert_eq!(decision["targetId"],target);
            assert_eq!(decision["diagnostics"]["weaponCandidates"],if actor=="local" {2} else {1});
            assert!(decision["diagnostics"]["viableShots"].as_u64().unwrap()>0,"the comparison reaches the selected-gun path");
        }
        for game in [full.game.as_mut().unwrap(),scoped.game.as_mut().unwrap()] {
            game.actors[0].defeated = true;
            game.actors[1].sheltered = true;
            for module in &mut game.damage.modules {
                if module.kind==ComponentKind::Weapon {
                    module.pose.y = -5.0;
                    game.geometry.upsert(module.owner,EntityGeometry::from_module(module));
                }
            }
        }
        pilot_sensor_compare(&mut full,&mut scoped,"local","opponent");
        let game = scoped.game.as_mut().unwrap();
        let repeated: Vec<_> = game.sensor_modules.iter().filter(|m|m.actor==1 && m.handle==11).collect();
        assert_eq!(repeated.len(),2);
        assert!(!repeated[0].muzzle_blocked && repeated[1].muzzle_blocked,
            "a live duplicate controls its weapon even when sheltered; its first non-weapon reading stays unblocked");
        assert!(game.sensor_modules.iter().filter(|m|m.actor==2).all(|m|!m.muzzle_blocked),"other handles are not consulted");
        assert!(full.game.as_ref().unwrap().sensor_modules.iter().any(|m|m.actor==2 && m.muzzle_blocked));
        game.refresh_sensors();
        assert_eq!(serde_json::to_value(&game.sensor_modules).unwrap(),
            serde_json::to_value(&full.game.as_ref().unwrap().sensor_modules).unwrap(),"the wrapper still restores the full projection");
    }
    #[test]
    fn pilot_sensor_refresh_survives_save_import_with_other_muzzles_unread() {
        let (mut full,mut scoped) = (pilot_sensor_world(),pilot_sensor_world());
        for game in [full.game.as_mut().unwrap(),scoped.game.as_mut().unwrap()] {
            for module in &mut game.damage.modules {
                if module.kind==ComponentKind::Weapon {
                    module.pose.y = -5.0;
                    game.geometry.upsert(module.owner,EntityGeometry::from_module(module));
                }
            }
        }
        pilot_sensor_compare(&mut full,&mut scoped,"local","opponent");
        let saved = scoped.export_state().unwrap();
        let mut resumed = pilot_sensor_world();
        resumed.import_state(&saved).unwrap();
        assert_eq!(serde_json::to_value(&resumed.game.as_ref().unwrap().sensor_modules).unwrap(),
            serde_json::to_value(&scoped.game.as_ref().unwrap().sensor_modules).unwrap(),"the derived bools keep their RMP slots on resume");
        for (actor,target) in [("opponent","local"),("local","opponent")] {
            let request = json!({"actorId":actor,"targetId":target});
            assert_eq!(resumed.game.as_mut().unwrap().command_scripted(&request).unwrap(),
                scoped.game.as_mut().unwrap().command_scripted(&request).unwrap());
            resumed.game_step(1.0/60.0).unwrap(); scoped.game_step(1.0/60.0).unwrap();
            assert_eq!(resumed.game.as_ref().unwrap().digest(&resumed),scoped.game.as_ref().unwrap().digest(&scoped));
            assert_eq!(resumed.game.as_ref().unwrap().events,scoped.game.as_ref().unwrap().events);
        }
    }

    #[test]
    fn grouped_powertrains_match_scalar_for_interleaved_duplicate_and_orphan_parts() {
        fn bits(p: Powertrain) -> ([u64; 14], Option<u64>, [bool; 3]) {
            let Powertrain { power_kw, torque_nm, efficiency, rolling_coefficient, drag, drag_astern, drag_over, drag_under, radius,
                max_drive_force, geared_speed, max_speed, power_per_tonne, fueled, fuel_litres,
                range_km, fuel_starved, tracked } = p;
            ([power_kw, torque_nm, efficiency, rolling_coefficient, drag, drag_astern, drag_over, drag_under, radius, max_drive_force,
                max_speed, power_per_tonne, fuel_litres, range_km].map(f64::to_bits),
                geared_speed.map(f64::to_bits), [fueled, fuel_starved, tracked])
        }
        let core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
        let mut game = GameState::from_value(&json!({"terrain":"flat","actors":[
            {"handle":9,"id":"without-drive"},
            {"handle":9,"id":"wheels","vehicle":{"mass":4000}},
            {"handle":2,"id":"tracks","vehicle":{"mass":18000}},
            {"handle":9,"id":"duplicate","vehicle":{"mass":71000}},
            {"handle":42,"id":"without-parts","vehicle":{"mass":5000}}
        ]}), &core).unwrap();
        game.actors[0].powertrain = Powertrain { power_kw: -0.0, radius: 43.25,
            geared_speed: Some(f64::from_bits(0x7ff8_0000_0000_0061)), fueled: true,
            ..Default::default() };
        game.actors[3].hull = HullAir { ahead: 13.6, astern: 11.9, over: 30.7, under: 27.2 };
        for (owner, actor, kind) in [
            (93,9,"fuel"), (21,2,"engine"), (91,9,"fuel"), (88,88,"engine"),
            (94,9,"engine"), (11,9,"wheel"), (22,2,"track"), (92,9,"fuel"),
            (24,2,"fuel"), (95,9,"engine"), (96,9,"track"), (25,2,"wheel"),
            (97,9,"fuel"), (26,2,"fuel"), (98,9,"engine"),
        ] {
            game.damage.insert_module(crate::game_damage::fixtures::module(owner, actor,
                &json!({"kind":kind,"width":1.05,"height":0.64,"mechanicalDepth":0.65,
                    "health":80,"maxHealth":80})));
        }
        // Fuel sums keep source order, not owner order: summing the two small tanks first changes a bit.
        for (owner, litres) in [(93,128.0), (91,1e-14), (92,1e-14), (24,0.0), (26,50.0), (97,100.0)] {
            game.damage.module_mut(owner).unwrap().fuel_litres = litres;
        }
        game.damage.module_mut(95).unwrap().health = 25.0;
        game.damage.module_mut(96).unwrap().attached = false;
        game.damage.module_mut(97).unwrap().attached = false;
        game.damage.module_mut(25).unwrap().health = 0.0;
        game.damage.module_mut(26).unwrap().detonated = true;
        // Engine projection deliberately has different predicates from usable fuel or live gear.
        game.damage.module_mut(98).unwrap().detonated = true;
        let compare = |game: &mut GameState| {
            let expected: Vec<_> = game.actors.iter().map(|a| bits(a.drive.as_ref().map_or(a.powertrain,
                |d| Powertrain::project(a.handle, d.mass, &game.damage, a.hull)))).collect();
            game.update_powertrains();
            assert_eq!(game.actors.iter().map(|a| bits(a.powertrain)).collect::<Vec<_>>(), expected);
        };
        compare(&mut game);
        assert_eq!(game.actors[1].powertrain.fuel_litres.to_bits(), 128.0_f64.to_bits());
        assert!(game.actors[1].powertrain.fueled && !game.actors[1].powertrain.tracked);
        assert!(game.actors[2].powertrain.tracked && game.actors[2].powertrain.fuel_starved);
        assert_ne!(game.actors[1].powertrain.max_speed.to_bits(), game.actors[3].powertrain.max_speed.to_bits(),
            "a duplicate handle still uses each actor's own mass and hull");
        assert_eq!(game.actors[4].powertrain.geared_speed, Some(0.0));
        game.damage.module_mut(24).unwrap().fuel_litres = 12.0;
        game.damage.module_mut(94).unwrap().attached = false;
        game.damage.module_mut(96).unwrap().attached = true;
        compare(&mut game);
        assert!(game.actors[1].powertrain.tracked && game.actors[2].powertrain.fueled);
        // Internal non-finite states retain the scalar predicates and NaN payloads, without JSON normalization.
        let nan = f64::from_bits(0x7ff8_0000_0000_0062);
        game.damage.module_mut(93).unwrap().fuel_litres = nan;
        game.damage.module_mut(95).unwrap().health = nan;
        game.damage.module_mut(98).unwrap().volume = nan;
        game.damage.module_mut(22).unwrap().health = nan;
        compare(&mut game);
        for a in &mut game.actors { a.drive = None; }
        compare(&mut game);
        game.actors.clear();
        compare(&mut game);
    }

    #[test]
    fn sensor_refresh_keeps_interleaved_bounds_and_duplicate_actor_control() {
        let mut scene=crate::game_damage::fixtures::mounted_scene(&[(9,"first",0.0),(2,"second",20.0),(77,"duplicate",40.0),(42,"empty",80.0)],0);
        for (owner,actor,attached) in [(92,9,true),(22,2,true),(772,77,true),(93,9,false)] {
            let mut sensor=crate::game_damage::fixtures::module(owner,actor,&json!({"id":format!("sensor-{owner}"),
                "kind":"sensor","sensorMode":"visual","x":0,"y":20,"width":0.2,"height":0.2})).to_value();
            sensor["owner"]=json!(owner);sensor["actor"]=json!(actor);sensor["attached"]=json!(attached);
            scene["modules"].as_array_mut().unwrap().push(sensor);
        }
        scene["plates"].as_array_mut().unwrap().sort_by_key(|p|p["owner"].as_u64().unwrap()%100);
        scene["modules"].as_array_mut().unwrap().sort_by_key(|m|m["owner"].as_u64().unwrap()%10);
        let core=NativeWorld::new(&[],0.0,0.0).unwrap();
        let mut game=GameState::from_value(&scene,&core).unwrap();
        game.actors[0].defeated=true;
        game.actors[1].defeated=true;
        game.actors[2].handle=9;
        let plates=game.damage.plates.iter().filter(|p|p.actor==9).map(|p|p.owner).collect::<Vec<_>>();
        game.damage.plate_mut(plates[0]).unwrap().attached=false;
        game.damage.plate_mut(plates[2]).unwrap().properties.area=0.0;
        game.damage.module_mut(91).unwrap().attached=false;
        let owners=game.damage.plates.iter().map(|p|p.owner).chain(game.damage.modules.iter().map(|m|m.owner)).collect::<Vec<_>>();
        for owner in owners {game.geometry.remove(owner);}
        let rectangle=|owner,actor,x,y,width,height,kind|EntityGeometry {
            owner,actor,kind,pose:Pose{x,y,angle:0.0},barrel_angle:None,post:false,
            polygons:vec![crate::game_geometry::rectangle(width,height)],grid:None,clear_to:None,aside:false,between:false,
        };
        for (owner,entity) in [
            (plates[0],rectangle(plates[0],9,-1.0,2.0,4.0,2.0,EntityKind::Plate)),
            (plates[1],rectangle(plates[1],9,5.0,-1.0,2.0,4.0,EntityKind::Plate)),
            (plates[2],rectangle(plates[2],9,900.0,900.0,10.0,10.0,EntityKind::Plate)),
            (91,rectangle(91,9,10.0,3.0,2.0,2.0,EntityKind::Module)),
            (21,rectangle(21,2,20.0,-4.0,2.0,2.0,EntityKind::Module)),
            (771,rectangle(771,77,150.0,150.0,10.0,10.0,EntityKind::Module)),
        ] {game.geometry.upsert(owner,entity);}
        let module_order=game.damage.modules.iter().map(|m|m.owner).collect::<Vec<_>>();
        game.refresh_sensors();
        assert_eq!(game.sensor_modules.iter().map(|m|m.handle).collect::<Vec<_>>(),module_order);
        for (reading,(handle,bounds)) in game.sensor_actors.iter().zip([
            (9,[-3.0,-3.0,11.0,4.0]),(2,[19.0,-5.0,21.0,-3.0]),(9,[-3.0,-3.0,11.0,4.0]),
            (42,[f64::INFINITY,f64::INFINITY,f64::NEG_INFINITY,f64::NEG_INFINITY]),
        ]) {
            assert_eq!(reading.handle,handle);
            assert_eq!([reading.bounds.min_x,reading.bounds.min_y,reading.bounds.max_x,reading.bounds.max_y].map(f64::to_bits),bounds.map(f64::to_bits));
        }
        let attached=|owner|game.sensor_modules.iter().find(|m|m.handle==owner).unwrap().attached;
        assert!(attached(90), "one live actor of a repeated handle still controls its command");
        assert!(!attached(20) && !attached(770), "defeated and orphan commands remain uncontrolled");
        assert!(!attached(91) && attached(21), "detachment and non-command attachment remain independent of control");
        assert!(attached(420), "missing query geometry does not detach a command");
        assert!(attached(92) && !attached(22) && !attached(772) && !attached(93), "sensor control keeps any-live, orphan and detached semantics");
        let check=|game:&GameState| {
            assert_eq!(game.sensor_modules.iter().map(|m|m.handle).collect::<Vec<_>>(),module_order);
            for (reading,module) in game.sensor_modules.iter().zip(&game.damage.modules) {
                let expected=module.attached && (!matches!(module.kind,ComponentKind::Command|ComponentKind::Sensor)
                    || game.actors.iter().any(|actor|actor.handle==module.actor && !actor.defeated));
                assert_eq!(reading.attached,expected,"component {}",module.owner);
            }
        };
        check(&game);
        // Partial readings keep control by any live duplicate, but sight still belongs to the first index.
        for (first,last) in [(true,false),(false,true),(true,true),(false,false)] {
            game.actors[0].defeated=first;game.actors[2].defeated=last;
            game.refresh_readings();
            check(&game);
            let wear=game.damage.plates.iter().filter(|p|p.actor==9 && p.attached).map(|p|p.revision+1).sum::<u64>();
            assert_eq!(game.actors[0].armour,Some(wear));
            assert_eq!(game.actors[2].armour,Some(0));
            assert!(game.actors[2].eyes.is_empty(),"a later duplicate receives no eyes");
            assert_eq!(game.actors[0].eyes.is_empty(),first,"the first duplicate keeps its own defeat state");
        }
    }
    #[test]
    fn sensor_refresh_keeps_the_first_servo_of_duplicate_owners_in_current_order() {
        let mut scene=crate::game_damage::fixtures::mounted_scene(&[(1,"local",0.0)],0);
        let modules=scene["modules"].as_array_mut().unwrap();
        modules.iter_mut().find(|m|m["kind"]=="command").unwrap()["owner"]=json!(11);
        let extra=modules.iter().find(|m|m["kind"]=="weapon").unwrap().clone();
        modules.push(extra);
        let core=NativeWorld::new(&[],0.0,0.0).unwrap();
        let mut game=GameState::from_value(&scene,&core).unwrap();
        assert_eq!(game.servos.len(),2);
        game.servos[0].reload=1.25;
        game.servos[1].reload=9.5;
        let compare=|game:&mut GameState| {
            game.refresh_sensors();
            for (reading,module) in game.sensor_modules.iter().zip(&game.damage.modules) {
                let expected=game.servos.iter().find(|s|s.owner==module.owner).map_or(0.0,|s|s.reload.max(0.0));
                assert_eq!(reading.reload.to_bits(),expected.to_bits());
            }
        };
        compare(&mut game);
        assert!(game.sensor_modules.iter().all(|m|m.reload==1.25));
        game.servos.reverse();
        compare(&mut game);
        assert!(game.sensor_modules.iter().all(|m|m.reload==9.5));
        game.servos[0].reload=-0.25;
        compare(&mut game);
        assert!(game.sensor_modules.iter().all(|m|m.reload==0.0));
        assert_eq!(game.servos[0].reload,-0.25, "reading a reload spends no phase credit");
    }

    #[test]
    fn body_reading_composition_is_bit_exact_for_shared_and_rotated_bindings() {
        let (mut core, game) = world();
        let id = game.actors[0].body;
        let handle = core.bodies[&id];
        for angle in [
            -12.5_f64,
            -std::f64::consts::PI,
            -0.0,
            0.0,
            0.135,
            std::f64::consts::PI,
            12.5,
        ] {
            let body = &mut core.world.bodies[handle];
            body.set_translation(Vector::new(123.45679, -71.125), false);
            body.set_rotation(Rotation::new(angle), false);
            body.set_linvel(Vector::new(-3.1234567, 0.0625), false);
            body.set_angvel(-0.125, false);
            let reading = BodyReading::read(&core, id).unwrap();
            let legacy_pose = body_pose(&core, id).unwrap();
            for x in [-145.125, -0.0, 0.0, 0.1, 19.654321] {
                for y in [-2.7654321, -0.0, 0.0, 3.125] {
                    let local = Pose {
                        x,
                        y,
                        angle: -0.23456789,
                    };
                    let expected = compose(legacy_pose, local);
                    let actual = reading.compose(local);
                    assert_eq!(actual.x.to_bits(), expected.x.to_bits());
                    assert_eq!(actual.y.to_bits(), expected.y.to_bits());
                    assert_eq!(actual.angle.to_bits(), expected.angle.to_bits());
                }
            }
            let body = &core.world.bodies[handle];
            assert_eq!(reading.velocity.x.to_bits(), body.linvel().x.to_bits());
            assert_eq!(reading.velocity.y.to_bits(), body.linvel().y.to_bits());
            assert_eq!(reading.omega.to_bits(), body.angvel().to_bits());
            assert_eq!(reading.mass_center.x.to_bits(), body.center_of_mass().x.to_bits());
            assert_eq!(reading.mass_center.y.to_bits(), body.center_of_mass().y.to_bits());
            assert_eq!(reading.sleeping, body.is_sleeping());
        }
        assert!(BodyReading::read(&core, u32::MAX).is_none());
    }

    #[test]
    fn body_readings_are_fresh_between_synchronizations_and_preserve_sleep() {
        let (mut core, mut game) = world();
        let id = game.actors[0].body;
        let handle = core.bodies[&id];
        for (x, speed, sleeping) in [(1.25, 2.5, false), (-7.5, -0.25, false), (0.0, 0.0, true)] {
            let body = &mut core.world.bodies[handle];
            body.set_translation(Vector::new(x, 3.0), false);
            body.set_linvel(Vector::new(speed, 0.0), false);
            if sleeping {
                body.sleep();
            } else {
                body.wake_up(true);
            }
            let expected = BodyReading::read(&core, id).unwrap();
            game.sync_poses(&core);
            for binding in game.bindings.iter().filter(|binding| binding.body == id) {
                if let Some(plate) = game.damage.plate(binding.owner) {
                    let expected_pose = expected.compose(binding.local);
                    assert_eq!(plate.pose.x.to_bits(), expected_pose.x.to_bits());
                    assert_eq!(plate.pose.y.to_bits(), expected_pose.y.to_bits());
                    assert_eq!(plate.velocity.x.to_bits(), expected.velocity.x.to_bits());
                    assert_eq!(plate.velocity.y.to_bits(), expected.velocity.y.to_bits());
                    assert_eq!(binding.sleeping, expected.sleeping);
                }
            }
        }
    }

    fn world() -> (NativeWorld, GameState) {
        let mut scene=crate::game_damage::fixtures::mounted_scene(&[(1,"local",0.0),(2,"opponent",20.0)],2);
        scene["actors"][0]["vehicle"]["enabled"]=json!(true);
        let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        let game = core.game.take().unwrap();
        (core, game)
    }
    #[test]
    fn held_trigger_preserves_catalog_rate_without_banking_blocked_or_released_shots() {
        let dt = 1.0 / 60.0;
        let period = 60.0 / 800.0;
        let mut cooldown = 0.0;
        let mut shots = 0;
        for _ in 0..600 {
            cooldown = advance_cooldown(cooldown, dt, true);
            if cooldown <= 1e-5 {
                cooldown = period + cooldown.min(0.0);
                shots += 1;
            }
            cooldown = cooldown.max(0.0);
        }
        assert_eq!(shots, 134);
        let overshoot = advance_cooldown(0.005, dt, true);
        assert!(overshoot < 0.0);
        // The caller clears a blocked attempt before another frame/command.
        assert_eq!(advance_cooldown(overshoot.max(0.0), dt, true), 0.0);
        assert_eq!(advance_cooldown(0.005, dt, false), 0.0);
        assert_eq!(advance_cooldown(0.0, dt, true), 0.0);
    }
    #[test]
    fn velocity_only_commands_preserve_grounded_contacts_but_teleports_invalidate_them() {
        let (mut core, mut game) = world();
        game.actors[0].drive.as_mut().unwrap().grounded = true;
        game.set_vehicle_state(&mut core, 0, json!({"vx":3.0}).as_object().unwrap()).unwrap();
        assert!(game.actors[0].drive.as_ref().unwrap().grounded);
        game.set_vehicle_state(&mut core, 0, json!({"y":10.0}).as_object().unwrap()).unwrap();
        assert!(!game.actors[0].drive.as_ref().unwrap().grounded);
    }
    #[test]
    fn a_command_lays_the_guns_of_the_vehicle_it_is_given_to_and_of_no_other() {
        let (mut core, mut game) = world();
        game.step(&mut core, 1.0 / 60.0).unwrap();
        let gun = |game: &GameState, actor: u32| {
            let gun = game.damage.modules.iter().find(|m| m.actor == actor && m.kind == ComponentKind::Weapon).unwrap();
            (gun.owner, gun.cold["id"].as_str().unwrap().to_owned())
        };
        let laid = |game: &GameState, owner: u32| game.servos.iter().find(|s| s.owner == owner).unwrap().target;
        let ((own, name), (other, _)) = (gun(&game, 1), gun(&game, 2));
        // Where the gun of the other is laid is marked, so that a laying of it shows.
        let before = laid(&game, own);
        game.servos.iter_mut().find(|s| s.owner == other).unwrap().target = 9.0;
        let said = game.command(&mut core, &json!({"op":"input","actorId":"local","input":{"type":"aim","phase":"before",
            "platform":"vehicle","componentId":name,"aim":{"x":40.0,"y":30.0}}})).unwrap();
        assert_eq!(said["accepted"], true);
        assert_ne!(laid(&game, own), before);
        assert_eq!(laid(&game, other), 9.0);
        // The step that comes lays every gun of the field.
        game.step(&mut core, 1.0 / 60.0).unwrap();
        assert_ne!(laid(&game, other), 9.0);
    }
    #[test]
    fn drive_guard_writes_the_target_itself_and_only_past_its_threshold() {
        assert!(drive_velocity_change(Vector::ZERO, Point::new(0.0, 0.0)).is_none());
        assert!(drive_velocity_change(Vector::ZERO, Point::new(0.000004, 0.000004)).is_none());
        assert!(drive_velocity_change(Vector::ZERO, Point::new(f64::NAN, 1.0)).is_none());
        let forward = Point::new(10.123456789, -0.0123456789);
        let next = drive_velocity_change(Vector::ZERO, forward).unwrap();
        assert_eq!(next.x.to_bits(), forward.x.to_bits());
        assert_eq!(next.y.to_bits(), forward.y.to_bits());
        assert!(drive_velocity_change(next, forward).is_none());
        let reverse = drive_velocity_change(next, Point::new(-forward.x, -forward.y)).unwrap();
        assert_eq!(reverse, -next);
        // The threshold is the same however fast the body goes: no rounding of a
        // large speed swallows a change of a millimetre a second.
        assert!(drive_velocity_change(Vector::new(65536.0, 0.0), Point::new(65536.001, 0.0)).is_some());
        assert!(drive_velocity_change(Vector::new(65536.0, 0.0), Point::new(65536.000001, 0.0)).is_none());
    }
    #[test]
    fn changed_drive_velocity_preserves_alive_and_defeated_wake_flags() {
        for defeated in [false, true] {
            let (mut core, game) = world();
            let handle = core.bodies[&game.actors[0].body];
            core.world.bodies[handle].sleep();
            let next =
                drive_velocity_change(core.world.bodies[handle].linvel(), Point::new(-2.5, 0.125))
                    .unwrap();
            core.world.bodies[handle].set_linvel(next, !defeated);
            let body = &core.world.bodies[handle];
            assert_eq!(body.linvel(), next);
            assert_eq!(body.is_sleeping(), defeated);
        }
    }
    #[test]
    fn weapon_pose_never_rebuilds_contact_or_wakes_sleeping_carriers() {
        let (mut core, mut game) = world();
        for (_, body) in core.world.bodies.iter_mut() {
            body.sleep();
        }
        let before = core
            .world
            .colliders
            .iter()
            .map(|(_, c)| c.position().clone())
            .collect::<Vec<_>>();
        for angle in [0.0, 0.4, 8.0 * std::f64::consts::TAU + 0.4, -0.7] {
            for owner in [11, 21] {
                game.damage.module_mut(owner).unwrap().barrel_angle = angle;
            }
            game.sync_poses(&core);
            let after = core
                .world
                .colliders
                .iter()
                .map(|(_, c)| c.position().clone())
                .collect::<Vec<_>>();
            assert_eq!(before, after);
            for owner in [11, 21] {
                let binding = game.bindings.iter().find(|b| b.owner == owner).unwrap();
                assert!(
                    binding.colliders.is_empty(),
                    "a servo must not create a terrain lever"
                );
                assert!((game.damage.module(owner).unwrap().barrel_angle - angle).abs() < 1e-9);
            }
            assert!(
                core.world
                    .bodies
                    .iter()
                    .all(|(_, body)| !body.is_dynamic() || body.is_sleeping())
            );
        }
    }
    #[test]
    fn a_field_prints_alike_while_it_steps_alike_and_otherwise_once_it_moves() {
        let scene = crate::game_damage::fixtures::mounted_scene(&[(1, "local", 0.0), (2, "opponent", 20.0)], 2);
        let cores = [(); 2].map(|_| {
            let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
            core.load_game(&scene.to_string()).unwrap();
            core
        });
        let [mut one, mut other] = cores;
        let print = |core: &mut NativeWorld| {
            let said = serde_json::from_str::<Value>(&core.game_command(r#"{"op":"digest","frame":false}"#).unwrap()).unwrap();
            assert!(said["frame"].is_null(), "a print brings no scene");
            said["result"].as_str().unwrap().to_owned()
        };
        let first = print(&mut one);
        assert_eq!(first.len(), 64);
        for _ in 0..30 {
            one.game_step(1.0 / 60.0).unwrap();
            other.game_step(1.0 / 60.0).unwrap();
        }
        assert_eq!(print(&mut one), print(&mut other));
        assert_ne!(print(&mut one), first);
        one.game_step(1.0 / 60.0).unwrap();
        assert_ne!(print(&mut one), print(&mut other));
    }
    #[test]
    fn a_world_written_out_and_taken_back_goes_on_as_the_world_it_was() {
        let mut scene = crate::game_damage::fixtures::mounted_scene(&[(1, "local", 0.0), (2, "opponent", 20.0)], 2);
        scene["actors"][0]["vehicle"]["enabled"] = json!(true);
        let loaded = || {
            let mut core = NativeWorld::new(&[-500.0, -1.0, 500.0, 1.5], 0.0, -9.81).unwrap();
            core.load_game(&scene.to_string()).unwrap();
            core
        };
        let print = |core: &mut NativeWorld| {
            serde_json::from_str::<Value>(&core.game_command(r#"{"op":"digest","frame":false}"#).unwrap()).unwrap()["result"].clone()
        };
        let mut one = loaded();
        for _ in 0..45 {
            one.game_step(1.0 / 60.0).unwrap();
        }
        let state = one.export_state().unwrap();
        // Taken by a world loaded with the same scene, and by one stepped elsewhere since: either is the world written out.
        let mut other = loaded();
        other.import_state(&state).unwrap();
        let mut stepped = loaded();
        stepped.game_step(1.0 / 60.0).unwrap();
        stepped.import_state(&state).unwrap();
        assert_eq!(print(&mut other), print(&mut one));
        assert_eq!(other.current_frame().unwrap(), one.current_frame().unwrap(), "and tells the host what it was told");
        for _ in 0..90 {
            for core in [&mut one, &mut other, &mut stepped] {
                core.game_step(1.0 / 60.0).unwrap();
            }
            let printed = print(&mut one);
            assert_eq!(print(&mut other), printed);
            assert_eq!(print(&mut stepped), printed);
        }
        assert_eq!(other.current_frame().unwrap(), one.current_frame().unwrap());
        assert!(NativeWorld::new(&[-500.0, -1.0, 500.0, 1.5], 0.0, -9.81).unwrap().import_state(&state).is_err(), "a world with no game takes none");
        assert!(loaded().import_state(&state[..state.len() / 2]).is_err());
    }
    #[test]
    fn a_world_copied_is_the_world_written_out_and_taken_back() {
        let mut scene = crate::game_damage::fixtures::mounted_scene(&[(1, "local", 0.0), (2, "opponent", 20.0)], 2);
        scene["actors"][0]["vehicle"]["enabled"] = json!(true);
        let loaded = || {
            let mut core = NativeWorld::new(&[-500.0, -1.0, 500.0, 1.5], 0.0, -9.81).unwrap();
            core.load_game(&scene.to_string()).unwrap();
            core
        };
        let print = |core: &mut NativeWorld| {
            serde_json::from_str::<Value>(&core.game_command(r#"{"op":"digest","frame":false}"#).unwrap()).unwrap()["result"].clone()
        };
        let mut one = loaded();
        for _ in 0..45 {
            one.game_step(1.0 / 60.0).unwrap();
        }
        let state = one.export_state().unwrap();
        let (mut copied, mut taken) = (loaded(), loaded());
        copied.game_step(1.0 / 60.0).unwrap();
        copied.copy_from(&one).unwrap();
        taken.import_state(&state).unwrap();
        assert_eq!(copied.export_state().unwrap(), state, "it writes out as the world it copied");
        assert_eq!(copied.current_frame().unwrap(), taken.current_frame().unwrap(), "and tells the host what one taken back tells");
        for _ in 0..90 {
            for core in [&mut one, &mut copied, &mut taken] {
                core.game_step(1.0 / 60.0).unwrap();
            }
            let printed = print(&mut taken);
            assert_eq!(print(&mut copied), printed);
            assert_eq!(print(&mut one), printed);
        }
        assert_eq!(copied.current_frame().unwrap(), taken.current_frame().unwrap());
        let mut elsewhere = NativeWorld::new(&[-400.0, -1.0, 400.0, 1.5], 0.0, -9.81).unwrap();
        assert!(elsewhere.copy_from(&one).is_err(), "a world on another ground takes none");
    }
    #[test]
    fn team_sight_tells_a_host_what_each_team_sees_and_which_ghosts_stand_in_plain_view() {
        let mut scene=crate::game_damage::fixtures::mounted_scene(&[(1,"local",0.0),(2,"opponent",60.0),(4,"local-4",120.0)],0);
        // Their command posts are shut in their hulls: each has a camera on a mast over it to see with.
        for (actor,x) in [(1,0.0),(2,60.0),(4,120.0)] {
            scene["modules"].as_array_mut().unwrap().push(json!({"owner":actor*10+5,"actor":actor,"id":format!("{actor}-camera"),"kind":"sensor","x":x,"y":4.0}));
        }
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        let mut ask=|request:Value|serde_json::from_str::<Value>(&core.game_command(&request.to_string()).unwrap()).unwrap();
        let ghosts=json!([{"team":"local","actorId":"left","x":30.0,"y":3.0},{"team":"local","actorId":"opponent","x":60.0,"y":1.2},
            {"team":"nobody","actorId":"left","x":30.0,"y":1.5},{"team":"local","actorId":"far","x":5000.0,"y":1.5}]);
        let answer=ask(json!({"op":"teamSight","ghosts":ghosts}));
        assert!(answer["frame"].is_null(),"a reading of the sensors brings no scene");
        let sight=answer["result"]["sight"].as_object().unwrap();
        assert_eq!(sight.keys().collect::<Vec<_>>(),["local","opponent"]);
        let held=|team:&str|sight[team].as_array().unwrap().iter().map(|s|(s["actorId"].as_str().unwrap(),s["channel"].as_str().unwrap(),s["visible"].as_bool().unwrap())).collect::<Vec<_>>();
        assert_eq!(held("local"),[("opponent","visual",true)]);
        assert_eq!(held("opponent"),[("local","visual",true),("local-4","visual",true)]);
        let seen=&sight["local"][0];
        assert!(["local","local-4"].contains(&seen["by"].as_str().unwrap()));
        assert!((seen["x"].as_f64().unwrap()-60.0).abs()<4.0 && seen["error"]==0.0 && seen["age"]==0.0);
        // The place between them is in plain view of the camera on its side and empty; the one the opponent stands on
        // is not; nobody's cameras clear nothing. One camera looks at each on a call: two calls are both cameras.
        let again=ask(json!({"op":"teamSight","ghosts":ghosts,"frame":false}));
        assert_eq!(again["result"]["sight"],answer["result"]["sight"],"asked again within the same reading, it sees the same");
        let cleared=[&answer,&again].map(|said|said["result"]["cleared"].clone());
        assert!(cleared.contains(&json!([{"team":"local","actorId":"left"}])),"{cleared:?}");
        assert!(cleared.iter().all(|said|said.as_array().unwrap().iter().all(|ghost|*ghost==json!({"team":"local","actorId":"left"}))));
        assert_eq!(ask(json!({"op":"teamSight"}))["result"]["cleared"],json!([]));
    }
}

// The state of the guns of a scene that is admitted and not installed: their barrels and their triggers.
#[cfg(test)]
mod gun_state_tests {
    use super::*;
    fn world() -> (NativeWorld, GameState) {
        let core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        let scene = crate::game_damage::fixtures::mounted_scene(&[(1, "local", 0.0), (2, "opponent", 100.0)], 0);
        let game = GameState::from_value(&scene, &core).unwrap();
        (core, game)
    }
    #[test]
    fn a_barrel_is_mended_by_its_damage_set_back_and_disabled_by_enough_of_it() {
        let (mut core, mut game) = world();
        let most = game.damage.module(11).unwrap().max_health * BARREL_DISABLED_SHARE;
        for (damage, disabled) in [(most, true), (0.0, false), (most * 0.99, false)] {
            game.command(&mut core, &json!({"op":"setPartState","owner":11,"state":{"barrelDamage":damage}})).unwrap();
            let gun = game.damage.module(11).unwrap();
            assert_eq!((gun.barrel_damage, gun.barrel_disabled), (damage, disabled));
        }
        assert!(game.command(&mut core, &json!({"op":"setPartState","owner":11,"state":{"barrelDamage":-1.0}})).is_err());
    }
    #[test]
    fn held_triggers_keep_reload_family_reset_and_pending_expiration() {
        let (mut core, mut game) = world();
        let settings = game
            .settings(&json!({"id":"cannon","preset":"rh120","platform":"ground"}), false)
            .unwrap();
        let aim = Point::new(50.0, 2.0);
        let actor = &mut game.actors[0];
        actor.launcher = Point::new(-20.0, 2.0);
        actor.cooldown = 10.0;
        actor.last_weapon = settings.family.clone();
        actor.trigger = Some((aim, settings.clone()));
        actor.pending = Some((aim, settings.clone(), -1.0));
        game.step(&mut core, 1.0 / 60.0).unwrap();
        assert_eq!(game.actors[0].shots, 0);
        assert!(game.actors[0].trigger.is_some());
        assert!(game.actors[0].pending.is_none());
        game.actors[0].last_weapon = "different-ground-family".into();
        game.step(&mut core, 1.0 / 60.0).unwrap();
        assert_eq!(game.actors[0].shots, 1);
        assert!(game.actors[0].cooldown > 0.0);
        assert!(game.actors[0].trigger.is_some());
        let mut mounted = settings;
        mounted.mounted = true;
        // A mounted gun waits out its own reload, whatever family fired last.
        for servo in &mut game.servos {
            servo.reload = 10.0;
        }
        game.actors[0].last_weapon = "different-mounted-family".into();
        game.actors[0].trigger = Some((aim, mounted));
        game.step(&mut core, 1.0 / 60.0).unwrap();
        assert_eq!(game.actors[0].shots, 1);
        assert!(!game.servos.is_empty() && game.servos.iter().all(|servo| servo.reload > 9.0));
    }
}

#[cfg(test)]
mod unwrap_idempotence_tests {
    use super::unwrap_angle;
    use crate::game_weapons::angle_difference;
    use std::f64::consts::{PI, TAU};
    #[test]
    fn recorded_crossing_converges_to_one_physical_anchor() {
        let phase = -3.1315925121307373;
        let anchor = unwrap_angle(phase, 3.1515927950488494);
        assert_eq!(anchor.to_bits(), unwrap_angle(phase, 3.15159279504885).to_bits());
        for _ in 0..1000 { assert_eq!(unwrap_angle(phase, anchor).to_bits(), anchor.to_bits()); }
    }
    #[test]
    fn pi_and_tau_ties_keep_the_existing_nearest_branch() {
        for (phase, previous, expected) in [
            (PI, 0.0, PI), (-PI, 0.0, -PI), (TAU, 0.0, 0.0), (-TAU, 0.0, 0.0),
            (0.0, TAU, TAU), (0.0, -TAU, -TAU), (PI, TAU, PI), (-PI, TAU, PI),
            (PI, -TAU, -PI), (-PI, -TAU, -PI),
        ] {
            let angle = unwrap_angle(phase, previous);
            assert_eq!(angle.to_bits(), expected.to_bits());
            assert_eq!(unwrap_angle(phase, angle).to_bits(), angle.to_bits());
        }
    }
    #[test]
    fn positive_and_reverse_crossings_are_continuous_and_idempotent() {
        for direction in [-1.0, 1.0] {
            let mut previous = 0.0;
            for i in 1..=20000 {
                let desired = direction * i as f64 * 0.001;
                let phase = angle_difference(desired, 0.0);
                let next = unwrap_angle(phase, previous);
                let delta = next - previous;
                assert!(delta * direction > 0.0 && delta.abs() < 0.002);
                assert_eq!(unwrap_angle(phase, next).to_bits(), next.to_bits());
                previous = next;
            }
        }
    }
    #[test]
    fn composed_local_angles_and_high_turn_counts_are_idempotent() {
        for turns in [-1000000, -1000, -8, -1, 0, 1, 8, 1000, 1000000] {
            for local in [-9.0, -PI, -PI / 2.0, 0.0, PI / 2.0, PI, 9.0] {
                for phase in [-PI, -3.1315925121307373, -0.1, 0.0, 0.1, PI] {
                    let phase = phase + local;
                    let angle = unwrap_angle(phase, phase + turns as f64 * TAU + 0.01);
                    for _ in 0..32 { assert_eq!(unwrap_angle(phase, angle).to_bits(), angle.to_bits()); }
                }
            }
        }
    }
    #[test]
    fn authoritative_signed_zero_and_zero_module_delta_are_stable() {
        assert_eq!(unwrap_angle(-0.0, -0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(unwrap_angle(0.0, 0.0).to_bits(), 0.0_f64.to_bits());
        let phase = -3.1315925121307373;
        let mut angle = 3.15159279504885;
        let mut barrel = angle + 0.2;
        let mut target = angle - 0.3;
        let mut expected = None;
        for _ in 0..1000 {
            let next = unwrap_angle(phase, angle);
            let delta = next - angle;
            angle = next;
            if delta != 0.0 { barrel += delta; target += delta; }
            let bits = (angle.to_bits(), barrel.to_bits(), target.to_bits());
            if let Some(expected) = expected { assert_eq!(bits, expected); } else { expected = Some(bits); }
        }
    }
}

#[cfg(test)]
mod sight_tests {
    use super::*;
    use crate::game_sensors::{COMMAND_CAMERA_RANGE, TERRAIN_DEGREES, TerrainSample};
    use std::f64::consts::FRAC_PI_2;
    use std::sync::Arc;

    fn plate(owner: u32, actor: u32, at: (f64, f64), length: f64, upright: bool, material: &str) -> Value {
        let mut value = crate::game_damage::fixtures::plate(owner, actor, &json!({"definition":{"id":format!("plate{owner}"),
            "x":at.0,"y":at.1,"length":length,"angle":if upright { FRAC_PI_2 } else { 0.0 },"thicknessMm":30,"material":material}}))
            .to_value();
        value["owner"] = json!(owner);
        value["actor"] = json!(actor);
        value
    }
    /// A box of armour four metres long and a metre and a half high about (0, 1.25), shut all around,
    /// its front wall of the material given: plates 10 to 13 of construction 1.
    fn hull(front: &str) -> Vec<Value> {
        vec![
            plate(10, 1, (0.0, 0.5), 4.06, false, "steel"),
            plate(11, 1, (0.0, 2.0), 4.06, false, "steel"),
            plate(12, 1, (-2.0, 1.25), 1.56, true, "steel"),
            plate(13, 1, (2.0, 1.25), 1.56, true, front),
        ]
    }
    /// `blue` with the plates and the pieces given, and a wall of steel of each of two others sixty
    /// metres from it: `red` before it, `green` behind. `grey` has what the plates give it.
    fn field(mut plates: Vec<Value>, pieces: Value) -> GameState {
        plates.push(plate(20, 2, (60.0, 1.25), 1.5, true, "steel"));
        plates.push(plate(30, 3, (-60.0, 1.25), 1.5, true, "steel"));
        GameState::from_value(&json!({"terrain":"flat","bounds":{"minX":-200,"maxX":200,"minY":-5,"maxY":20},
            "actors":[{"id":"blue","handle":1,"x":0.0},{"id":"red","handle":2,"x":60.0},{"id":"green","handle":3,"x":-60.0},
                {"id":"grey","handle":5,"x":30.0}],
            "plates":plates,"modules":pieces,"projectiles":[]}), &NativeWorld::new(&[], 0.0, -9.81).unwrap()).unwrap()
    }
    fn piece(owner: u32, kind: &str, y: f64) -> Value {
        json!({"owner":owner,"actor":1,"id":format!("piece{owner}"),"kind":kind,"x":0.0,"y":y})
    }
    /// The kind of sensor `blue` has the other in sight with on a new reading, if any.
    fn sees(game: &mut GameState, target: &str) -> Option<&'static str> {
        game.time += 0.25;
        let contact = game.sense_combat("blue", target);
        contact.visible.then(|| contact.channel.unwrap().name())
    }
    fn eye(y: f64, left: f64, right: f64) -> Eye {
        Eye { x: 0.0, y, left, right }
    }
    /// The scene of a lookout: `blue`, facing as given, with the pieces given three metres up over a roof of steel,
    /// on the ground given and in the weather given; and beside it a wall of steel of another for each of `walls`,
    /// where it says and as high: `(x, top)`.
    fn lookout_scene(terrain: Value, weather: &str, facing: f64, pieces: Value, walls: &[(f64, f64)]) -> Value {
        let mut actors = vec![json!({"id":"blue","handle":1,"x":0.0,"facing":facing})];
        let mut plates = vec![plate(10, 1, (0.0, 2.5), 4.0, false, "steel")];
        for (handle, &(x, top)) in (2..).zip(walls) {
            actors.push(json!({"id":format!("wall{handle}"),"handle":handle,"x":x}));
            plates.push(plate(handle * 10, handle, (x, (top + 0.15) * 0.5), top - 0.15, true, "steel"));
        }
        json!({"terrain":terrain,"weather":weather,"bounds":{"minX":-500,"maxX":500,"minY":-5,"maxY":20},
            "actors":actors,"plates":plates,"modules":pieces,"projectiles":[]})
    }
    fn lookout(terrain: Value, weather: &str, facing: f64, pieces: Value, walls: &[(f64, f64)]) -> GameState {
        let scene = lookout_scene(terrain, weather, facing, pieces, walls);
        GameState::from_value(&scene, &NativeWorld::new(&[], 0.0, -9.81).unwrap()).unwrap()
    }
    fn post() -> Value {
        json!([piece(40, "command", 3.0)])
    }
    #[test]
    fn a_command_post_reads_the_ground_either_way_out_to_its_reach_past_its_own_roof_and_anew_a_tenth_of_a_second_on() {
        let mut game = lookout(json!("flat"), "clear", 1.0, post(), &[]);
        let scan = game.sense_terrain("blue");
        let origin = scan.origin.unwrap();
        let reach = |s: &TerrainSample| hypot(s.x - origin.x, s.y - origin.y);
        // Its lines are named by side, ahead first, and by their place among the angles of a side.
        let rays = TERRAIN_DEGREES.len();
        assert_eq!(scan.samples.iter().map(|s| (s.side, s.ray)).collect::<Vec<_>>(),
            (0..2 * rays).map(|i| (i / rays, i % rays)).collect::<Vec<_>>());
        let (ahead, behind) = scan.samples.split_at(rays);
        for ((front, rear), degrees) in ahead.iter().zip(behind).zip(TERRAIN_DEGREES) {
            assert!(front.known && front.fresh && !front.obstacle && !rear.obstacle, "{degrees}");
            assert!((front.x + rear.x - 2.0 * origin.x).abs() < 1e-9 && front.y == rear.y && front.x >= origin.x, "{degrees}");
            // Two degrees down from three metres up, the ground lies farther off than the post reads, 80 m; three, nearer.
            assert_eq!(front.hit, degrees >= 3.0, "{degrees}");
            if front.hit {
                assert!(reach(front) <= 80.0 + 1e-8 && front.ny == 1.0 && front.y.abs() < 1e-9, "{degrees}");
            } else {
                assert!((reach(front) - 80.0).abs() < 1e-9, "{degrees}");
            }
        }
        // Asked again within a tenth of a second it tells the same reading; a tenth on, it reads the ground anew.
        game.time += 0.05;
        assert!(game.sense_terrain("blue").samples.iter().zip(&scan.samples).all(|(now, then)| (now.x, now.y) == (then.x, then.y) && !now.fresh));
        game.time += 0.05;
        assert!(game.sense_terrain("blue").samples.iter().all(|s| s.fresh && s.age == 0.0));
        // Turned about, it reads ahead what it read behind.
        let turned = lookout(json!("flat"), "clear", -1.0, post(), &[]).sense_terrain("blue");
        assert!(turned.samples[..rays].iter().all(|s| s.x < origin.x) && turned.samples[rays..].iter().all(|s| s.x > origin.x));
    }
    #[test]
    fn a_crest_hides_the_ground_beyond_it_and_what_lies_there_changes_nothing_read() {
        let read = |hidden: f64| {
            let crest = json!({"id":"flat","minX":-1600,"maxX":1600,"points":[{"x":-1600,"y":0},{"x":6,"y":0},{"x":8,"y":6},{"x":10,"y":6},
                {"x":14,"y":0},{"x":16,"y":0},{"x":17,"y":hidden},{"x":60,"y":hidden},{"x":61,"y":0},{"x":1600,"y":0}]});
            let mut game = lookout(crest, "clear", 1.0, post(), &[]);
            let scan = game.sense_terrain("blue");
            (json!(scan.samples), scan.origin, game.observed_height("blue", 20.0), game.observed_height("blue", 4.0))
        };
        let seen = read(0.0);
        assert_eq!(read(-2.0), seen);
        // Every line ahead ends on the near face of the crest. Past it nothing is held; before it, the ground.
        assert!(seen.0.as_array().unwrap()[..TERRAIN_DEGREES.len()].iter().all(|s| s["hit"] == true && s["x"].as_f64().unwrap() < 8.0));
        assert_eq!((seen.2, seen.3), (None, Some(0.0)));
    }
    #[test]
    fn what_stands_on_the_ground_is_read_before_the_ground() {
        let mut game = lookout(json!("flat"), "clear", 1.0, post(), &[(7.0, 6.0)]);
        let scan = game.sense_terrain("blue");
        let wall = game.geometry.bounds(20).unwrap();
        for (s, degrees) in scan.samples.iter().zip(TERRAIN_DEGREES) {
            if degrees <= 20.0 {
                assert!(s.obstacle && (s.x - wall.min_x).abs() < 1e-6, "{degrees}");
            } else {
                assert!(!s.obstacle && s.y.abs() < 1e-9, "{degrees}");
            }
        }
        assert_eq!(game.observed_height("blue", 12.0), None);
    }
    #[test]
    fn only_an_optic_reads_the_ground_and_the_weather_takes_of_how_far() {
        for mode in ["radar", "sound"] {
            let mut sensor = piece(40, "sensor", 3.0);
            sensor["sensorMode"] = json!(mode);
            let mut game = lookout(json!("flat"), "clear", 1.0, json!([sensor]), &[]);
            let scan = game.sense_terrain("blue");
            assert!(scan.origin.is_none() && scan.samples.iter().all(|s| !s.known), "{mode}");
            assert_eq!(game.observed_height("blue", 5.0), None, "{mode}");
        }
        for (weather, share) in [("clear", 1.0), ("haze", 0.8), ("mist", 0.45)] {
            for (kind, reach) in [("sensor", 400.0), ("command", 80.0)] {
                let mut game = lookout(json!("flat"), weather, 1.0, json!([piece(40, kind, 3.0)]), &[]);
                let scan = game.sense_terrain("blue");
                let origin = scan.origin.unwrap();
                let far = |s: &TerrainSample| hypot(s.x - origin.x, s.y - origin.y);
                // A line that meets nothing ends where the optic stops reading.
                assert!(scan.samples.iter().all(|s| if s.hit { far(s) <= reach * share + 1e-8 } else { (far(s) - reach * share).abs() < 1e-9 }),
                    "{kind} in {weather}");
                assert_eq!(game.observed_height("blue", reach * share + 1.0), None, "{kind} in {weather}");
            }
        }
    }
    #[test]
    fn what_a_lost_camera_read_of_the_ground_outlives_a_construction_that_takes_the_place_of_another() {
        fn game(core: &mut NativeWorld) -> &mut GameState {
            core.game.as_mut().unwrap()
        }
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&lookout_scene(json!("flat"), "clear", 1.0, post(), &[(60.0, 2.0)]).to_string()).unwrap();
        assert!(game(&mut core).sense_terrain("blue").samples.iter().all(|s| s.known));
        game(&mut core).damage.module_mut(40).unwrap().health = 0.0;
        core.game_step(1.0 / 60.0).unwrap();
        let memory = game(&mut core).sense_terrain("blue");
        assert!(memory.samples.iter().all(|s| s.known && !s.fresh));
        let wall = plate(21, 2, (60.0, 1.075), 1.85, true, "steel");
        core.game_command(&json!({"op":"admit","leaving":[2],"actors":[{"id":"wall2","handle":2,"x":60.0}],
            "plates":[wall],"modules":[]}).to_string()).unwrap();
        let kept = game(&mut core).sense_terrain("blue");
        assert_eq!((json!(kept.samples), kept.origin), (json!(memory.samples), memory.origin));
    }
    #[test]
    fn an_optic_sees_out_of_its_own_armour_through_glass_and_where_the_armour_is_gone_and_no_other_way() {
        for (kind, reach) in [("sensor", 4000.0), ("command", COMMAND_CAMERA_RANGE)] {
            // Shut in steel all around, a camera or a command post sees nothing and is no eye.
            let mut game = field(hull("steel"), json!([piece(40, kind, 1.25)]));
            assert_eq!(sees(&mut game, "red"), None, "{kind}");
            assert_eq!(sees(&mut game, "green"), None, "{kind}");
            assert!(game.actors[0].eyes.is_empty());
            // A hole shot through the wall before it is an opening: it sees out of it, that way alone.
            // The step that follows the shot finds the armour worn and works its cover out again.
            game.damage.plate_mut(13).unwrap().cut_clipped(Point::new(1.9, 1.25), Point::new(2.1, 1.25), 0.1, None);
            game.refresh_readings();
            assert_eq!(game.actors[0].eyes, [eye(1.25, 0.0, reach)], "{kind}");
            assert_eq!(sees(&mut game, "red"), Some("visual"), "{kind}");
            assert_eq!(sees(&mut game, "green"), None, "{kind}");
            // Behind a wall of glass it sees as if nothing stood there, and the host that asks is told so.
            let mut game = field(hull("glass"), json!([piece(40, kind, 1.25)]));
            assert_eq!(game.actors[0].eyes, [eye(1.25, 0.0, reach)], "{kind}");
            assert_eq!(sees(&mut game, "red"), Some("visual"), "{kind}");
            assert_eq!(sees(&mut game, "green"), None, "{kind}");
            let sight = game.command(&mut NativeWorld::new(&[], 0.0, -9.81).unwrap(), &json!({"op":"teamSight"})).unwrap();
            let held: Vec<_> = sight["sight"]["blue"].as_array().unwrap().iter()
                .map(|s| (s["actorId"].as_str().unwrap(), s["channel"].as_str().unwrap(), s["visible"].as_bool().unwrap())).collect();
            assert_eq!(held, [("red", "visual", true)], "{kind}");
        }
    }
    #[test]
    fn a_camera_on_the_roof_sees_over_its_hull_and_not_past_the_turret_it_stands_behind() {
        // Over its own roof it sees both ways: the roof is under its lines.
        let mut game = field(hull("steel"), json!([piece(40, "sensor", 2.2)]));
        assert_eq!(game.actors[0].eyes, [eye(2.2, 4000.0, 4000.0)]);
        assert_eq!(sees(&mut game, "red"), Some("visual"));
        assert_eq!(sees(&mut game, "green"), Some("visual"));
        // A wall of its own turret a metre high half a metre before it hides what is before it.
        let mut plates = hull("steel");
        plates.push(plate(14, 1, (0.5, 2.5), 1.0, true, "steel"));
        let mut game = field(plates, json!([piece(40, "sensor", 2.2)]));
        assert_eq!(game.actors[0].eyes, [eye(2.2, 4000.0, 0.0)]);
        assert_eq!(sees(&mut game, "red"), None);
        assert_eq!(sees(&mut game, "green"), Some("visual"));
        // Of glass, that wall hides nothing.
        let mut plates = hull("steel");
        plates.push(plate(14, 1, (0.5, 2.5), 1.0, true, "glass"));
        let mut game = field(plates, json!([piece(40, "sensor", 2.2)]));
        assert_eq!(game.actors[0].eyes, [eye(2.2, 4000.0, 4000.0)]);
        assert_eq!(sees(&mut game, "red"), Some("visual"));
    }
    #[test]
    fn the_glass_of_another_hides_nothing_from_a_camera_and_its_steel_does() {
        for (material, seen) in [("glass", Some("visual")), ("steel", None)] {
            let mut plates = hull("steel");
            plates.push(plate(50, 5, (30.0, 1.5), 3.0, true, material));
            let mut game = field(plates, json!([piece(40, "sensor", 2.2)]));
            assert_eq!(sees(&mut game, "red"), seen, "{material}");
            assert_eq!(sees(&mut game, "green"), Some("visual"), "{material}");
        }
    }
    #[test]
    fn a_radar_reads_out_of_its_own_armour_through_fibreglass_and_where_the_armour_is_gone_and_no_other_way() {
        let radar = |y: f64| {
            let mut radar = piece(40, "sensor", y);
            radar["sensorMode"] = json!("radar");
            json!([radar])
        };
        // Shut in its own steel it reads nothing, before it or behind, as a camera sees nothing. It is no eye.
        let mut game = field(hull("steel"), radar(1.25));
        assert!(game.actors[0].eyes.is_empty());
        assert_eq!(sees(&mut game, "red"), None);
        assert_eq!(sees(&mut game, "green"), None);
        // A hole shot through the wall before it is an opening: it reads out of it, that way alone.
        game.damage.plate_mut(13).unwrap().cut_clipped(Point::new(1.9, 1.25), Point::new(2.1, 1.25), 0.1, None);
        game.refresh_readings();
        assert_eq!(sees(&mut game, "red"), Some("radar"));
        assert_eq!(sees(&mut game, "green"), None);
        // Its waves run through a wall of fibreglass as through nothing; glass stops them as steel does.
        for (front, seen) in [("fiberglass", Some("radar")), ("glass", None)] {
            let mut game = field(hull(front), radar(1.25));
            assert_eq!(sees(&mut game, "red"), seen, "{front}");
            assert_eq!(sees(&mut game, "green"), None, "{front}");
        }
        // On its roof it reads over its hull both ways. The fibreglass of another hides nothing from it;
        // the glass and the steel of another do.
        for (material, seen) in [("fiberglass", Some("radar")), ("glass", None), ("steel", None)] {
            let mut plates = hull("steel");
            plates.push(plate(50, 5, (30.0, 1.5), 3.0, true, material));
            let mut game = field(plates, radar(2.2));
            assert!(game.actors[0].eyes.is_empty());
            assert_eq!(sees(&mut game, "red"), seen, "{material}");
            assert_eq!(sees(&mut game, "green"), Some("radar"), "{material}");
        }
    }
    #[test]
    fn a_radar_reads_through_a_piece_of_glass_fibre_or_of_plastic_of_another_and_a_camera_through_neither() {
        // A tank of another stands between the roof of `blue` and `red`, as tall as the plate of another above.
        for (metal, seen) in [(None, None), (Some("aluminum"), None), (Some("fiberglass"), Some("radar")), (Some("plastic"), Some("radar"))] {
            let mut tank = json!({"owner":50,"actor":5,"id":"tank","kind":"cistern","x":30.0,"y":1.5,"width":1.4,"height":3.0});
            if let Some(metal) = metal { tank["metal"] = json!(metal); }
            let mut radar = piece(40, "sensor", 2.2);
            radar["sensorMode"] = json!("radar");
            let mut game = field(hull("steel"), json!([radar, tank.clone()]));
            assert_eq!(sees(&mut game, "red"), seen, "{metal:?}");
            assert_eq!(sees(&mut game, "green"), Some("radar"), "{metal:?}");
            let mut game = field(hull("steel"), json!([piece(40, "sensor", 2.2), tank]));
            assert_eq!(sees(&mut game, "red"), None, "{metal:?}: no light runs through it");
            assert_eq!(sees(&mut game, "green"), Some("visual"), "{metal:?}");
        }
    }
    #[test]
    fn the_eyes_of_a_construction_are_its_working_optics_with_how_far_each_sees_to_either_side() {
        // A camera on the roof behind a turret wall, a radar beside it and a command post behind a windscreen.
        let mut plates = hull("glass");
        plates.push(plate(14, 1, (0.5, 2.5), 1.0, true, "steel"));
        let mut radar = piece(42, "sensor", 2.2);
        radar["sensorMode"] = json!("radar");
        let mut game = field(plates, json!([piece(40, "sensor", 2.2), piece(41, "command", 1.25), radar]));
        let whole = [eye(2.2, 4000.0, 0.0), eye(1.25, 0.0, COMMAND_CAMERA_RANGE)];
        assert_eq!(game.actors[0].eyes, whole);
        assert!(game.actors[1..].iter().all(|a| a.eyes.is_empty()), "a wall has no eye");
        // They are told with every frame, the hot one in its numbers and the cold in words.
        game.frame_json().unwrap();
        let told = frame::told_eyes(&game.take_block());
        assert_eq!(told[0], (game.actors[0].handle, whole.to_vec()));
        assert!(told[1..].iter().all(|(_, eyes)| eyes.is_empty()));
        assert_eq!(game.frame()["actors"][0]["eyes"], json!([{"x":0.0,"y":2.2,"left":4000.0,"right":0.0},{"x":0.0,"y":1.25,"left":0.0,"right":650.0}]));
        // The weather takes of their reach what it takes of a camera's.
        game.weather = SensorWeather::Mist;
        game.refresh_readings();
        assert_eq!(game.actors[0].eyes, [eye(2.2, 1800.0, 0.0), eye(1.25, 0.0, 292.5)]);
        game.weather = SensorWeather::Clear;
        // A camera that is destroyed is no eye; the others are.
        game.damage.module_mut(40).unwrap().health = 0.0;
        game.refresh_readings();
        assert_eq!(game.actors[0].eyes, whole[1..]);
        // With its command post gone a construction is out of action and has none, whatever camera works.
        game.damage.module_mut(40).unwrap().health = 10.0;
        game.damage.module_mut(41).unwrap().health = 0.0;
        game.refresh_readings();
        assert!(game.actors[0].eyes.is_empty());
        game.damage.module_mut(41).unwrap().health = 10.0;
        game.refresh_readings();
        assert_eq!(game.actors[0].eyes, whole);
        // So is a defeated one.
        game.actors[0].defeated = true;
        game.refresh_readings();
        assert!(game.actors[0].eyes.is_empty());
        game.frame_json().unwrap();
        assert_eq!(frame::told_eyes(&game.take_block())[0], (game.actors[0].handle, Vec::new()));
    }
    #[test]
    fn sensor_projection_refreshes_all_actor_fields_after_growth_reorder_and_removal() {
        let pieces = json!([piece(40,"sensor",2.2),piece(41,"command",1.25)]);
        let (mut warm,mut fresh) = (field(hull("glass"),pieces.clone()),field(hull("glass"),pieces));
        let check = |warm: &mut GameState, fresh: &mut GameState| {
            warm.refresh_sensors();
            // A fresh projection of the same world is the reference, without a second field formula.
            fresh.sensor_actors.clear();
            fresh.refresh_sensors();
            assert_eq!(rmp_serde::to_vec(&warm.sensor_actors).unwrap(),rmp_serde::to_vec(&fresh.sensor_actors).unwrap());
            assert_eq!(warm.actors.iter().map(|a|&a.eyes).collect::<Vec<_>>(),
                fresh.actors.iter().map(|a|&a.eyes).collect::<Vec<_>>());
        };
        check(&mut warm,&mut fresh);
        for game in [&mut warm,&mut fresh] {
            game.actors[0].id = "observação 🛞 ".repeat(32);
            game.actors[0].team = "facção-de-teste-".repeat(32);
            game.actors[0].cold["facing"] = json!(-0.0);
            game.actors[0].cold["x"] = json!(125000.0);
            game.actors[0].shots = 51;
            game.actors[1].defeated = true;
            game.actors.rotate_left(1);
            game.actors[0].id = "duplicate".into();
            game.actors[1].id = "duplicate".into();
            game.actors[1].handle = game.actors[0].handle;
        }
        check(&mut warm,&mut fresh);
        let core = NativeWorld::new(&[],0.0,0.0).unwrap();
        for game in [&mut warm,&mut fresh] {
            game.actors.extend(GameState::from_value(&json!({"terrain":"flat","actors":[
                {"id":"new-a","handle":80,"team":"new-team","x":-125000.0},
                {"id":"new-b","handle":81,"team":"another-team","x":25.0}
            ]}),&core).unwrap().actors);
        }
        check(&mut warm,&mut fresh);
        for game in [&mut warm,&mut fresh] {
            game.actors.remove(0);
            game.actors.truncate(2);
            game.actors[0].id.clear(); game.actors[0].team.clear();
        }
        check(&mut warm,&mut fresh);
        warm.actors.clear(); fresh.actors.clear();
        check(&mut warm,&mut fresh);
    }
    #[test]
    fn sensor_cover_transfer_keeps_the_existing_duplicate_owner_cursor() {
        let mut game = field(hull("glass"),json!([piece(40,"sensor",1.25),piece(40,"sensor",2.2),piece(41,"command",1.25)]));
        let upper = game.sensor_modules[1].cover.clone().unwrap();
        let command = game.sensor_modules[2].cover.clone().unwrap();
        game.sensor_modules[0].cover = None;
        game.refresh_sensors();
        // The first matching piece consumes the first retained cover; this is deliberately not by index.
        assert!(Arc::ptr_eq(game.sensor_modules[0].cover.as_ref().unwrap(),&upper));
        assert!(!Arc::ptr_eq(game.sensor_modules[1].cover.as_ref().unwrap(),&upper));
        assert!(Arc::ptr_eq(game.sensor_modules[2].cover.as_ref().unwrap(),&command));
        assert_eq!(game.actors[0].eyes,[eye(1.25,4000.0,4000.0),eye(2.2,4000.0,4000.0),
            eye(1.25,0.0,COMMAND_CAMERA_RANGE)]);
    }
    #[test]
    fn the_cover_of_an_optic_is_worked_out_again_only_when_its_armour_wears() {
        let mut game = field(hull("glass"), json!([piece(40, "sensor", 1.25), piece(41, "command", 1.25)]));
        let covers = |game: &GameState| game.sensor_modules.iter().map(|m| m.cover.clone().unwrap()).collect::<Vec<_>>();
        let first = covers(&game);
        // Steps and questions go by, and the same covers stand.
        for _ in 0..3 {
            game.refresh_readings();
            game.refresh_sensors();
        }
        assert!(covers(&game).iter().zip(&first).all(|(now, then)| Arc::ptr_eq(now, then)));
        // The armour of another wears: nothing of this one's is worked out.
        game.damage.plate_mut(20).unwrap().cut_clipped(Point::new(59.9, 1.25), Point::new(60.1, 1.25), 0.1, None);
        game.refresh_readings();
        assert!(covers(&game).iter().zip(&first).all(|(now, then)| Arc::ptr_eq(now, then)));
        // Its own wears: its covers are new, and what they hide is what is left of it.
        game.damage.plate_mut(12).unwrap().cut_clipped(Point::new(-2.1, 1.25), Point::new(-1.9, 1.25), 0.1, None);
        game.refresh_readings();
        assert!(covers(&game).iter().zip(&first).all(|(now, then)| !Arc::ptr_eq(now, then)));
        assert_eq!(game.actors[0].eyes, [eye(1.25, 4000.0, 4000.0), eye(1.25, COMMAND_CAMERA_RANGE, COMMAND_CAMERA_RANGE)]);
    }
}
