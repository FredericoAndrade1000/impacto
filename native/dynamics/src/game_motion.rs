//! Drive, running-gear support and bounded weapon motors. Module health,
//! reserves and mass stay in DamageState; these controllers never mirror them.
use serde::{Deserialize, Serialize};
use crate::game_geometry::ComponentKind;
use crate::game_air::HullAir;
use crate::game_damage::{DamageState, Module};
use crate::game_dto::{NativePowertrain, NativeVehicle};
use crate::game_barrel::BarrelState;
use crate::game_variant::{Feed, FeedKind};
use crate::game_geometry::{
    Geometry, MAX_ROAD_WHEELS, Point, Pose, RayOptions, SurfaceKind, Terrain, TerrainSupport, atan2, cos,
    hypot, number, sin, sqrt, track_outline, track_wheels,
};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};
use std::f64::consts::PI;

pub fn angle_difference(a: f64, b: f64) -> f64 {
    atan2(sin(a - b), cos(a - b))
}
fn sign(x: f64) -> f64 {
    if x > 0.0 {
        1.0
    } else if x < 0.0 {
        -1.0
    } else {
        0.0
    }
}
/// The density of the air at sea level, in kg/m³ (game_flight.rs `air_density`): what a hull is rated in.
const AIR_DENSITY: f64 = crate::game_flight::AIR_DENSITY;
/// How fast a track may run over the ground, in m/s, however large its sprocket: 70 km/h. Its links and pins wear and
/// heat, and it may be thrown, at the same speed on a small vehicle as on a large one: a Leopard 2 reaches some 70 km/h,
/// and so does a Wiesel, far smaller. Wheels have no ceiling: their speed follows the available pull, power, grip,
/// rolling resistance and drag.
pub const TRACK_SPEED_LIMIT: f64 = 70.0 / 3.6;
/// The share of its top speed a vehicle backs at: a gearbox has fewer and slower gears the other way. A tank of
/// today backs at some 40 % of what it does ahead (a Leopard 2 at 31 km/h against 72).
pub const REVERSE_SHARE: f64 = 0.4;
/// The radius the stall force is quoted at, so pull does not change with the
/// size of the running gear.
const REFERENCE_RADIUS: f64 = 0.37;
/// The reduction of the lowest gear, from the engine to a running gear of that
/// radius: the one of a lorry or of a tank, which pulls some 400 N for each
/// kilowatt it has and so climbs a slope of 60 % laden. Wheels and tracks have
/// the same one, and differ by what their drivetrains lose.
const LOW_RATIO: f64 = 36.0;
/// Below this speed the drivetrain slips: the engine turns as if the vehicle
/// moved this fast, both for the pull it can give and for the power that costs.
/// It is under the speed at which the lowest gear takes all the engine has, so
/// that gear is what limits the pull of a vehicle that stands.
const SLIP_SPEED: f64 = 1.5;
/// A running gear that grips turns a little faster than the ground passes under it as the push nears the grip there
/// is, below the speed the drivetrain slips at: it begins to creep when the push takes the first share of the grip,
/// and creeps up to that speed at all of it. It begins to churn when rolling over the ground takes the first share of
/// what the drivetrain can pull, and churns freely at the second: a load too heavy for soft ground.
const SLIP_GRIP: (f64, f64) = (0.7, 1.0);
const SLIP_SINK: (f64, f64) = (0.5, 0.9);
/// A gear that slipped in the step before turned faster than its drivetrain turns one that grips, which is no faster
/// than the ground passes under it or than `SLIP_SPEED`, by more than this, in m/s: what the weight and the bumps of
/// the ground may move a vehicle by between one step and the next. It goes on slipping until the ground has slowed it
/// down to that, which it does once the drivetrain pushes it less than the ground holds it back by
/// (`SurfaceKind::sliding`, `SPINNING`), and grips again: what keeps it from slipping and gripping by turns.
const SLIPPED_BY: f64 = 0.1;
/// The share of the weight of a vehicle that the gear spins up and down with as it slips: the wheels or tracks, the
/// shafts, and the engine through its gear, which add some 5–10 % to the mass a vehicle is speeded up with in its high
/// gears and more in its low ones. A gear broken loose spins up no faster than that lets what the drivetrain gives
/// beyond what the ground takes, nor down faster than what it gives short of it: barely on the ground over a bump for a
/// step or two, a gear spins up but a little.
const SPINNING: f64 = 0.1;
/// A vehicle is stuck when the most it pushes with gains it nothing — all its drivetrain pulls as far as the ground holds
/// that, or what the ground holds its gear back by once it slips —, or it leans on a face it does not get up, and it goes
/// no faster than this the way it is driven.
const STUCK_SPEED: f64 = 0.3;
/// Below this speed a direction change engages the engine.
/// A small rollback on a slope must not keep putting the brake back on before it can pull away.
const STANDSTILL_SPEED: f64 = 0.1;
/// How far `x` is from the first of two marks to the second, eased at both ends.
fn rise(x: f64, (from, to): (f64, f64)) -> f64 {
    let t = ((x - from) / (to - from)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}
/// What keeps a vehicle where it is while its engine pushes.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stuck {
    /// The ground holds less than the drivetrain pulls: the gear slips on it.
    Grip,
    /// Rolling over the ground takes what the drivetrain pulls: too heavy for ground this soft.
    Ground,
    /// The climb takes what the drivetrain pulls.
    Slope,
}
impl Stuck {
    pub fn name(self) -> &'static str {
        match self {
            Self::Grip => "grip",
            Self::Ground => "ground",
            Self::Slope => "slope",
        }
    }
    fn from_name(name: &str) -> Option<Self> {
        [Self::Grip, Self::Ground, Self::Slope].into_iter().find(|stuck| stuck.name() == name)
    }
}
/// Diesel burned per unit of work at the crankshaft, and its density.
const FUEL_KG_PER_KWH: f64 = 0.25;
pub(crate) const FUEL_KG_PER_LITRE: f64 = 0.835;
/// What an engine turning under command burns before it delivers anything, as
/// a share of its installed power.
const TURNING_SHARE: f64 = 0.04;
/// Litres per hour burned by an engine under command that delivers `engine_kw`
/// out of `installed_kw`. Fuel follows the work done: holding a speed the
/// running gear limits costs what rolling and drag take there, and a vehicle
/// already faster than its gear burns only what keeps the engine turning.
pub fn fuel_flow(engine_kw: f64, installed_kw: f64) -> f64 {
    (engine_kw.max(0.0) + TURNING_SHARE * installed_kw.max(0.0)) * FUEL_KG_PER_KWH
        / FUEL_KG_PER_LITRE
}
/// Rated output of the complete installed engine, before fuel or damage limits.
pub(crate) fn engine_power_kw(volume: f64) -> f64 {
    180.0 * (volume / (1.05 * 0.64 * 0.65))
}
/// The share of its rated output an engine still on its construction gives, as its damage leaves it.
fn engine_condition(m: &Module) -> f64 {
    if m.max_health > 0.0 {
        (m.health / m.max_health).max(0.0)
    } else {
        1.0
    }
}
/// What tools did for a while (`run_tools`): the share of their full pace they worked at over it, and what held them
/// under that pace, if anything did — no engine that turns, no fuel, or engines weaker than they ask.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ToolWork {
    pub share: f64,
    pub limit: Option<ToolLimit>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ToolLimit {
    Engine,
    Fuel,
    Power,
}
impl ToolLimit {
    pub fn name(self) -> &'static str {
        match self {
            Self::Engine => "engine",
            Self::Fuel => "fuel",
            Self::Power => "power",
        }
    }
}
/// What the tools of a construction, by their owners, do for `seconds`: each takes its power
/// (`ComponentKind::work_power_kw`) from the engines of that construction, which burn as much for what they deliver
/// as they burn for it driving (`fuel_flow`). Engines weaker than all the tools ask turn each of them at the share of its pace they
/// give, and fuel that runs out meanwhile lasts for the share of those seconds it does. A tool destroyed or torn off,
/// or of another construction, asks nothing; with nothing asked, nothing is done and nothing burned.
pub fn run_tools(damage: &mut DamageState, actor: u32, tools: &[u32], seconds: f64) -> ToolWork {
    let asked: f64 = tools
        .iter()
        .filter_map(|&owner| damage.module(owner))
        .filter(|m| m.actor == actor && m.usable())
        .map(|m| m.kind.work_power_kw(m.volume))
        .sum();
    let idle = |limit| ToolWork { share: 0.0, limit };
    if !(asked > 0.0) {
        return idle(None);
    }
    let parts = || damage.modules.iter().filter(|m| m.actor == actor);
    let power: f64 = parts()
        .filter(|m| m.kind == ComponentKind::Engine && m.attached)
        .map(|m| engine_power_kw(m.volume) * engine_condition(m))
        .sum();
    if !(power > 0.0) {
        return idle(Some(ToolLimit::Engine));
    }
    if !(parts().filter(|m| m.kind == ComponentKind::Fuel && m.usable()).map(|m| m.fuel_litres).sum::<f64>() > 1e-9) {
        return idle(Some(ToolLimit::Fuel));
    }
    let delivered = asked.min(power);
    let wanted = fuel_flow(delivered, power) * seconds.max(0.0) / 3600.0;
    let burned = damage.consume_fuel(actor, wanted);
    let lasted = if wanted > 0.0 { (burned / wanted).min(1.0) } else { 1.0 };
    ToolWork {
        share: delivered / asked * lasted,
        limit: if lasted < 1.0 - 1e-9 {
            Some(ToolLimit::Fuel)
        } else if delivered < asked {
            Some(ToolLimit::Power)
        } else {
            None
        },
    }
}
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Powertrain {
    pub power_kw: f64,
    pub torque_nm: f64,
    pub efficiency: f64,
    pub rolling_coefficient: f64,
    /// What the air takes of it for the square of its speed, in N·s²/m², by each side of its hull it moves towards: ½·ρ
    /// by what that side shows the air (`HullAir`, game_air.rs) — `drag` ahead, the way it drives, and `drag_astern`
    /// the other way along its hull; `drag_over` as it climbs, across it, and `drag_under` as it falls —, with ρ the
    /// density of the air at sea level: higher up, as much less as the air there is thinner (`Powertrain::air`).
    pub drag: f64,
    pub drag_astern: f64,
    pub drag_over: f64,
    pub drag_under: f64,
    pub radius: f64,
    pub max_drive_force: f64,
    /// The speed a track runs at no faster (`TRACK_SPEED_LIMIT`), absent for wheels.
    pub geared_speed: Option<f64>,
    pub max_speed: f64,
    pub power_per_tonne: f64,
    pub fueled: bool,
    pub fuel_litres: f64,
    /// Range on a level paved road at the current top speed, in kilometres.
    pub range_km: f64,
    pub fuel_starved: bool,
    pub tracked: bool,
}
/// What a running gear takes to roll over firm ground, for the weight on it: a tyre 0.018, a track, which turns its
/// own links and wheels, 0.045. A ground takes more or less (`SurfaceKind::rolling`).
pub fn firm_rolling(track: bool) -> f64 {
    if track { 0.045 } else { 0.018 }
}
impl Powertrain {
    fn cruise_range(self, mass: f64) -> f64 {
        if !(self.max_speed > 0.0 && self.power_kw > 0.0 && self.fuel_litres > 0.0) {
            return 0.0;
        }
        let holding = self.power_kw.min(
            (mass * 9.81 * self.rolling_coefficient + self.drag * self.max_speed.powi(2))
                * self.max_speed / self.efficiency / 1000.0,
        );
        self.fuel_litres / fuel_flow(holding, self.power_kw) * self.max_speed * 3.6
    }
    pub fn project(actor: u32, mass: f64, damage: &DamageState, hull: HullAir) -> Self {
        Self::project_modules(mass, damage.modules.iter().filter(|m| m.actor == actor), hull)
    }
    pub(super) fn project_modules<'a>(
        mass: f64,
        modules: impl Iterator<Item = &'a Module> + Clone,
        hull: HullAir,
    ) -> Self {
        let fuel_litres = modules.clone()
            .filter(|m| m.kind == ComponentKind::Fuel && m.usable())
            .map(|m| m.fuel_litres)
            .sum::<f64>();
        let fueled = fuel_litres > 1e-9;
        let mut power_kw = 0.0;
        let mut torque_nm = 0.0;
        let mut fuel_starved = false;
        let mut tracked = false;
        let mut count = 0;
        let mut radius_sum = 0.0;
        for m in modules {
            if !m.attached {
                continue;
            }
            if m.kind.gear() && m.health > 0.0 {
                tracked |= m.kind == ComponentKind::Track;
                count += 1;
                radius_sum += m.height / 2.0;
            }
            if m.kind != ComponentKind::Engine {
                continue;
            }
            let engine_power = engine_power_kw(m.volume);
            let engine_rpm = 2300.0;
            let engine_torque = engine_power * 1000.0 / (engine_rpm * PI / 30.0) * 1.34;
            let factor = if fueled { engine_condition(m) } else { 0.0 };
            power_kw += engine_power * factor;
            torque_nm += engine_torque * factor;
            fuel_starved |= m.health != 0.0 && !fueled;
        }
        let efficiency = if tracked { 0.72 } else { 0.82 };
        // A vehicle is rated on a level paved road, as a lorry's top speed and range are.
        let rolling_coefficient = firm_rolling(tracked) + SurfaceKind::Asphalt.rolling(tracked);
        let radius = if count > 0 {
            radius_sum / count as f64
        } else {
            0.37
        };
        let geared_speed = if count > 0 {
            if tracked {
                Some(TRACK_SPEED_LIMIT)
            } else { None }
        } else {
            Some(0.0)
        };
        let drag = 0.5 * AIR_DENSITY * hull.ahead;
        let rolling_force = mass * 9.81 * rolling_coefficient;
        let mut low = 0.0;
        // Drag alone takes all the power at this speed, so the equilibrium is
        // below it. This brackets the estimate; it never limits the live drive.
        let mut high = geared_speed.unwrap_or_else(|| ComplexField::cbrt(power_kw * 1000.0 * efficiency / drag));
        for _ in 0..30 {
            let speed = (low + high) / 2.0;
            if (rolling_force + drag * speed * speed) * speed > power_kw * 1000.0 * efficiency {
                high = speed;
            } else {
                low = speed;
            }
        }
        let mut result = Self {
            power_kw,
            torque_nm,
            efficiency,
            rolling_coefficient,
            drag,
            drag_astern: 0.5 * AIR_DENSITY * hull.astern,
            drag_over: 0.5 * AIR_DENSITY * hull.over,
            drag_under: 0.5 * AIR_DENSITY * hull.under,
            radius,
            max_drive_force: torque_nm * LOW_RATIO * efficiency / REFERENCE_RADIUS,
            geared_speed,
            max_speed: if power_kw > 0.0 && count > 0 {
                (low + high) / 2.0
            } else {
                0.0
            },
            power_per_tonne: power_kw / (mass / 1000.0).max(0.001),
            fueled,
            fuel_litres,
            range_km: 0.0,
            fuel_starved,
            tracked,
        };
        result.range_km = result.cruise_range(mass);
        result
    }
    /// What the air takes of a vehicle whose hull stands at `angle`, driving the way `facing` points along it (see
    /// `HullAir::read`), and moves at `velocity` `altitude` metres over sea level, for the square of its speed: the drag of
    /// the side of its hull it moves towards along it as much as it moves along it, and that of the side it moves towards
    /// across it as much as it moves across it — the sides it shows the air the way it goes —, in the air as dense as it is
    /// there (game_flight.rs `air_density`).
    pub fn air(&self, angle: f64, velocity: Point, facing: f64, altitude: f64) -> f64 {
        let speed = hypot(velocity.x, velocity.y);
        if !(speed > 0.0) {
            return 0.0;
        }
        let (c, s) = (cos(angle), sin(angle));
        let (along, across) = (velocity.x * c + velocity.y * s, velocity.y * c - velocity.x * s);
        let lengthwise = if along * facing > 0.0 { self.drag } else { self.drag_astern };
        let crosswise = if across > 0.0 { self.drag_over } else { self.drag_under };
        (lengthwise * along.abs() + crosswise * across.abs()) / speed * crate::game_flight::air_density(altitude) / AIR_DENSITY
    }
    pub fn to_value(self) -> Value {
        serde_json::to_value(NativePowertrain::from(&self)).expect("serializable powertrain DTO")
    }
}

/// A gear with travel carries the hull on springs: a wheel on one at its axle, a track on one at
/// each of its road wheels. A spring is made for the vehicle as it was built: under what it
/// carries of that vehicle it has taken this share of its travel, and there the vehicle stands
/// where it was built. Let go, it hangs that far below; the rest of the travel is what it takes
/// before the gear meets its stop and holds as a gear without travel does.
pub const SPRING_REST: f64 = 1.0 / 3.0;
/// The share of the damping that would bring the hull to rest without a swing.
const SPRING_DAMPING: f64 = 0.6;
/// A step of the world carries no spring stiffer than this for each kilogram that moves on it, in
/// N/m, and no damper stronger, in N·s/m: with very little travel a gear is as stiff as that.
const SPRING_LIMIT: (f64, f64) = (900.0, 30.0);
/// The ground moves a vehicle along from under it, and that leans the hull on its springs. On
/// wheels they take this share of the moment of it; the arms that hold the wheels, which drive
/// them, take the rest straight into the hull, as they are laid out to in a vehicle that neither
/// dives nor squats much. A track is driven by its sprocket on the hull, through its belt: the arms
/// of its road wheels only roll them along the belt and take none of the push, and its springs take
/// the whole moment of it, as the hull of a tank sits back as it pulls away and dips as it brakes.
const SPRING_LEAN: f64 = 0.5;
/// The ground pushes a wheel square to itself, and its spring takes what of that runs along the
/// hull. Ground that would push it more aslant of the hull than this cosine, 60°, gives its spring
/// less than half of that and pushes the wheel back near twice as hard as it bears it up: it is a
/// face the wheel climbs, the edge of a step or the side of a rock, not ground it stands on. The arm
/// that holds the wheel takes such a push straight into the hull, and the wheel meets the face with
/// its rim where it stands at rest (`GameState::seat`), which the gear grips and pulls itself up on
/// as it does on the ground (`Climb`).
pub const SPRING_SLANT: f64 = 0.5;
/// A tyre pressed on the ground under its share of the vehicle is flat for this share of its radius to either side of
/// its axle: a truck's tyre 1.1 m across on some 33 cm of the ground.
const TYRE_PATCH: f64 = 0.3;
#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Spring {
    /// Where its wheel stands in the vehicle as built, in the frame of the hull, and how far along
    /// its gear that is from the middle of it.
    pub seat: Point,
    pub arm: f64,
    /// What it carries of the vehicle as built, in newtons.
    pub load: f64,
    /// What it gives for each metre it is pressed, short of where it was built and past it, in
    /// N/m, and for each m/s it is pressed at, in N·s/m.
    pub rate: f64,
    pub firm: f64,
    pub damping: f64,
}
/// A vehicle as it was built: its mass, the centre of it in the frame of the hull and its inertia
/// about it, how many times that mass it weighs with all it can take aboard, and where the centre
/// of it all lies then, as what it takes aboard lies in it.
#[derive(Clone, Copy, Debug)]
pub struct Built {
    pub mass: f64,
    pub center: Point,
    pub inertia: f64,
    pub laden: f64,
    pub laden_center: Point,
}
/// What share of a weight each seat carries, `arms` along the hull from the centre of it, so that
/// together they leave the hull level; a seat that would have to pull carries nothing.
fn shares(arms: &[f64]) -> Vec<f64> {
    let mut share = vec![0.0; arms.len()];
    let mut carrying = vec![true; arms.len()];
    loop {
        let among = |i: &usize| carrying[*i];
        let count = (0..arms.len()).filter(among).count() as f64;
        let mean = (0..arms.len()).filter(among).map(|i| arms[i]).sum::<f64>() / count;
        let spread = (0..arms.len()).filter(among).map(|i| (arms[i] - mean) * (arms[i] - mean)).sum::<f64>();
        let mut least = 0;
        for i in 0..arms.len() {
            share[i] = if !carrying[i] {
                0.0
            } else if spread > 0.0 {
                1.0 / count - (arms[i] - mean) * mean / spread
            } else {
                1.0 / count
            };
            if share[i] < share[least] {
                least = i;
            }
        }
        if arms.is_empty() || share[least] >= 0.0 {
            break;
        }
        carrying[least] = false;
    }
    share
}
/// The springs of a vehicle, one for each seat with the travel of its gear: none where there is
/// no travel, and none in a world without weight. Each carries what leaves the vehicle as built
/// level, as near alike as where its weight lies among them allows; a seat that would have to pull
/// carries nothing. Past where it was built each spring is stiff enough to carry its own part of all
/// the vehicle can take aboard, where that lies, on half of the travel left — as a chassis rates
/// the axles under its load bed for the load —, and none softer than where it rests.
pub fn springs(seats: &[(Point, f64, f64)], built: &Built, gravity: f64) -> Vec<Option<Spring>> {
    let arms: Vec<f64> = seats.iter().map(|(seat, _, _)| seat.x - built.center.x).collect();
    let share = shares(&arms);
    let laden: Vec<f64> = shares(&seats.iter().map(|(seat, _, _)| seat.x - built.laden_center.x).collect::<Vec<_>>());
    let even = 1.0 / arms.len() as f64;
    seats
        .iter()
        .zip(arms)
        .zip(share)
        .zip(laden)
        .map(|(((&(seat, along, travel), arm), share), laden)| {
            if travel <= 0.0 || gravity <= 0.0 {
                return None;
            }
            let moved = 1.0 / (1.0 / built.mass + arm * arm / built.inertia);
            // A seat that carries little is still as stiff as one that carries half an even share.
            let stiff = share.max(even / 2.0) * built.mass * gravity / (travel * SPRING_REST);
            let rate = stiff.min(SPRING_LIMIT.0 * moved);
            Some(Spring {
                seat,
                arm: along,
                load: share * built.mass * gravity,
                rate,
                firm: ((laden * built.laden - share).max(0.0) * built.mass * gravity / (travel * SPRING_REST)).max(stiff).min(SPRING_LIMIT.0 * moved),
                damping: (2.0 * SPRING_DAMPING * sqrt(rate * share.max(even / 2.0) * built.mass)).min(SPRING_LIMIT.1 * moved),
            })
        })
        .collect()
}
/// What the springs of a gear do as its hull stands: how hard they press the ground, the force
/// and the moment about its centre of mass they give the hull for it, that load times the place
/// of the ground under each of them, and the work it took to press them from where they hang.
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Carried {
    pub load: f64,
    pub push: Point,
    pub moment: f64,
    pub foot: Point,
    pub work: f64,
}
impl Carried {
    fn add(&mut self, other: &Carried) {
        self.load += other.load;
        self.push.x += other.push.x;
        self.push.y += other.push.y;
        self.moment += other.moment;
        self.foot.x += other.foot.x;
        self.foot.y += other.foot.y;
        self.work += other.work;
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GearState {
    pub owner: u32,
    pub ground_contact: Option<TerrainSupport>,
    /// Its springs, none for a gear without travel, and what they do as the hull was last looked at.
    pub springs: Vec<Spring>,
    pub carried: Carried,
}
impl GearState {
    pub fn from_value(owner: u32, _v: &Value) -> Self {
        Self {
            owner,
            ground_contact: None,
            springs: Vec::new(),
            carried: Carried::default(),
        }
    }
    fn contact(&mut self, damage: &DamageState, geometry: &Geometry, terrain: &Terrain) {
        self.ground_contact = None;
        let Some(module) = damage.module(self.owner).filter(|m| m.attached) else {
            return;
        };
        // A gear on springs is on the ground while they carry. One without them, and the ground a
        // gear stands on, are read off its contour where the frames have it, within contact slop.
        if !self.springs.is_empty() && self.carried.load == 0.0 {
            return;
        }
        if let Some(polygon) = geometry
            .shapes_world(module.owner)
            .and_then(|shapes| shapes.first())
        {
            self.ground_contact = terrain.support(polygon, 0.055, None, !self.springs.is_empty());
        }
    }
    /// Stands its springs on the ground under the hull as `drive` has it. A wheel is pushed along
    /// its hull by as much of its travel as leaves its rim on the ground, between where it hangs let
    /// go and its stop, and gives what its spring and its damper give for that; the ground pushes it
    /// square to itself, with what that takes. A face it would climb rather than stand on
    /// (`SPRING_SLANT`) its rim meets instead. The springs carry only a hull that is `upright`.
    /// The rim is the gear as large as it is (`radius`): no margin of the solver stands between it
    /// and the ground, which a page draws the wheel on.
    ///
    /// Tells where that leaves the gear from where it was built: how far towards the hull, how far
    /// turned against it, and the mean of how far its wheels are pushed. A wheel goes with its axle.
    /// A track lies along its road wheels as near as a straight one can, on the highest of them.
    pub fn carry(&mut self, drive: &DriveState, radius: f64, travel: f64, upright: bool, terrain: &Terrain) -> (f64, f64, f64) {
        self.carried = Carried::default();
        let (rest, stop) = (travel * SPRING_REST, travel * (1.0 - SPRING_REST));
        // An overturned hull has no spring support: the gear hangs unloaded. Reading the ground
        // through its inverted axis would turn no contact (-infinity) into full compression.
        if !upright {
            return (-rest, 0.0, -rest);
        }
        let (c, s) = (cos(drive.pose.angle), sin(drive.pose.angle));
        let center = drive.center();
        let count = self.springs.len() as f64;
        // A tyre stands on the bumps of the ground (`Terrain::seat`) on its footprint. A track stands on its belt, which
        // runs flat between its road wheels, each of them on it halfway to the next, and round the last at either end.
        let (first, last) = self.springs.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(first, last), spring| {
            (first.min(spring.arm), last.max(spring.arm))
        });
        let belt = (last - first) / (count - 1.0).max(1.0) / 2.0;
        // Where each wheel stands as built and on what foot, and the bumps of the ground under them all.
        let mut feet = [(Point::ZERO, [0.0; 2]); MAX_ROAD_WHEELS as usize];
        let (mut lo, mut hi) = (f64::INFINITY, f64::NEG_INFINITY);
        for (spring, foot) in self.springs.iter().zip(&mut feet) {
            let built = Point::new(
                drive.pose.x + c * spring.seat.x - s * spring.seat.y,
                drive.pose.y + s * spring.seat.x + c * spring.seat.y,
            );
            let flat = if self.springs.len() > 1 {
                [if spring.arm > first { belt } else { 0.0 }, if spring.arm < last { belt } else { 0.0 }]
            } else {
                [TYRE_PATCH * radius; 2]
            };
            (lo, hi) = (lo.min(built.x - flat[0] - radius), hi.max(built.x + flat[1] + radius));
            *foot = (built, flat);
        }
        let under = terrain.underfoot(lo, hi);
        let (mut reach, mut lean, mut spread) = (0.0, 0.0, 0.0);
        let mut reached = [0.0; MAX_ROAD_WHEELS as usize];
        for ((spring, reached), &(built, flat)) in self.springs.iter().zip(&mut reached).zip(&feet) {
            let (rise, normal) = terrain.seat(built, radius, flat, Point::new(-s, c), SPRING_SLANT, &under);
            let along = c * normal.y - s * normal.x;
            let pressed = rise * normal.y / along;
            *reached = pressed.clamp(-rest, stop);
            reach += *reached / count;
            lean += *reached * spring.arm;
            spread += spring.arm * spring.arm;
            if pressed <= -rest {
                continue;
            }
            let pressed = pressed.min(stop);
            let closing = ((drive.velocity.x - drive.omega * (built.y - center.y)) * normal.x
                + (drive.velocity.y + drive.omega * (built.x - center.x)) * normal.y)
                / -along;
            let give = pressed * if pressed < 0.0 { spring.rate } else { spring.firm };
            let force = (spring.load + give + spring.damping * closing).max(0.0) / along;
            let axle = Point::new(built.x - s * pressed, built.y + c * pressed);
            self.carried.add(&Carried {
                load: force,
                push: Point::new(normal.x * force, normal.y * force),
                moment: force * ((axle.x - center.x) * normal.y - (axle.y - center.y) * normal.x),
                foot: Point::new((axle.x - normal.x * radius) * force, (axle.y - normal.y * radius) * force),
                work: spring.load * (pressed + rest) + (give * pressed - spring.rate * rest * rest) / 2.0,
            });
        }
        if spread == 0.0 {
            return (reach, 0.0, reach);
        }
        let over = self.springs.iter().zip(reached).fold(0.0, |over: f64, (spring, reached)| {
            over.max(reached - reach - spring.arm * lean / spread)
        });
        (reach + over, atan2(lean, spread), reach)
    }
}

/// Where a gear carries its hull, in its own frame: a wheel at its axle, a track at each of its road
/// wheels (`track_wheels`), and not at its idler or its sprocket, which the hull holds.
pub fn gear_seats(module: &Module) -> Vec<Point> {
    if module.kind != ComponentKind::Track {
        return vec![Point::ZERO];
    }
    let wheels = track_wheels(module.width, module.height);
    wheels.road.iter().map(|&x| Point::new(x, wheels.low)).collect()
}
/// Where a track stands on its springs from where it was built, which is where `module` stands: `displacement` along
/// its hull, which leans at `hull`, and `tilt`. It stands as its road wheels have it, but at either end no lower than
/// keeps it out of the ground there, and no higher than where it was built; and at its outermost road wheels no higher
/// than the stop of their springs, which travel `travel`: leaning on from the highest of them, as over a rock under
/// one between, it is held there by the hull at their stop. The idler and the sprocket are the hull's: where the road
/// wheels at an end hang and the run there rests on the ground, as up the face of a step, the track does not hang
/// with them into the ground. Under its road wheels the ground meets it at its springs.
pub fn track_stand(module: &Module, hull: f64, displacement: f64, tilt: f64, travel: f64, terrain: &Terrain) -> (f64, f64) {
    let wheels = track_wheels(module.width, module.height);
    let (end, last) = (wheels.end.x, wheels.road[wheels.road.len() - 1]);
    let ends = [displacement + end * tilt, displacement - end * tilt];
    // How far each end may stand up from where its road wheels have it: as far as where it was built.
    let room = ends.map(|lift| (-lift).max(0.0));
    let (displacement, tilt) = if room == [0.0, 0.0] {
        (displacement, tilt)
    } else {
        let (c, s) = (cos(hull), sin(hull));
        let (x, y, angle) = (module.pose.x - s * displacement, module.pose.y + c * displacement, module.pose.angle + tilt);
        let (pc, ps) = (cos(angle), sin(angle));
        // How far up each end has to stand for the belt beyond the last road wheel there to be out of the ground: a
        // point of it rises by its share of what the end it is nearer rises, the rest by what the other does.
        let mut lift = [0.0_f64; 2];
        for p in track_outline(module.width, module.height).into_iter().filter(|p| p.x.abs() > last) {
            let under = terrain.height(x + pc * p.x - ps * p.y) - (y + ps * p.x + pc * p.y);
            let (side, share) = (usize::from(p.x < 0.0), (1.0 + p.x.abs() / end) / 2.0);
            lift[side] = lift[side].max(under / share);
        }
        let [one, other] = [0, 1].map(|side| ends[side] + lift[side].clamp(0.0, room[side]));
        ((one + other) / 2.0, (one - other) / (2.0 * end))
    };
    let stop = travel * (1.0 - SPRING_REST);
    let outermost = [displacement + last * tilt, displacement - last * tilt];
    if outermost.iter().all(|&at| at <= stop) {
        return (displacement, tilt);
    }
    let [one, other] = outermost.map(|at| at.min(stop));
    ((one + other) / 2.0, (one - other) / (2.0 * last))
}
/// How far from each of those the ground meets the gear: at the rim of a wheel, and under a road
/// wheel of a track at the belt round it.
pub fn gear_rim(module: &Module) -> f64 {
    if module.kind == ComponentKind::Track {
        track_wheels(module.width, module.height).radius
    } else {
        module.height / 2.0
    }
}
/// How far a gear moves on its springs, from where it hangs let go to its stop.
pub fn gear_travel(module: &Module) -> f64 {
    if let Some(travel) = module.cold["suspension"]["travel"].as_f64().filter(|v| v.is_finite()) {
        return travel.clamp(0.0, 0.4);
    }
    if module.kind == ComponentKind::Wheel {
        (module.height * 0.28).clamp(0.06, 0.30)
    } else {
        (module.height * 0.16).clamp(0.035, 0.13)
    }
}

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct Mobility {
    pub grip: f64,
    pub rolling: f64,
    pub pressure_kpa: f64,
    pub softness: f64,
    pub surface: Option<SurfaceKind>,
}
fn contact_footprint(module: &Module, contact: &TerrainSupport) -> f64 {
    let scale = module.height / 0.74;
    if module.kind == ComponentKind::Track {
        0.92 * scale
            * (contact.max_x - contact.min_x).clamp(module.height * 0.35, module.width * 0.78)
    } else {
        0.38 * scale * module.height * 0.24
    }
}
pub fn ground_mobility(
    actor: u32,
    gears: &[GearState],
    damage: &DamageState,
    mass: f64,
) -> Mobility {
    let mut area = 0.0;
    for gear in gears {
        if let (Some(m), Some(contact)) = (damage.module(gear.owner), &gear.ground_contact) {
            if m.actor == actor {
                area += contact_footprint(m, contact);
            }
        }
    }
    if area <= 0.0 {
        return Mobility::default();
    }
    let pressure = mass.max(0.0) * 9.81 / area.max(0.005);
    let mut out = Mobility {
        pressure_kpa: pressure / 1000.0,
        ..Default::default()
    };
    let mut grip_weight = 0.0;
    let mut materials = [0.0; crate::game_geometry::SURFACE_KINDS];
    let mut order = Vec::new();
    for gear in gears {
        let (Some(m), Some(contact)) = (damage.module(gear.owner), &gear.ground_contact) else {
            continue;
        };
        if m.actor != actor {
            continue;
        }
        let track = m.kind == ComponentKind::Track;
        let share = contact_footprint(m, contact) / area;
        let condition = if m.max_health > 0.0 {
            (m.health / m.max_health).clamp(0.0, 1.0)
        } else {
            0.0
        };
        out.rolling += (firm_rolling(track) + 0.10 * (1.0 - condition)) * share;
        for &surface in &contact.material_order {
            let fraction = contact.materials[surface as usize];
            let bearing = surface.bearing_pa();
            let loss = if bearing > 0.0 {
                (pressure / bearing).clamp(0.0, 3.0)
            } else {
                0.0
            };
            let coefficient =
                surface.grip(track) / (1.0 + loss * (if track { 0.07 } else { 0.14 }));
            out.grip += coefficient * condition * fraction * share;
            grip_weight += condition * fraction * share;
            out.rolling += fraction
                * share
                * (surface.rolling(track) + loss * (if track { 0.014 } else { 0.032 }));
            out.softness += loss * fraction * share;
            if materials[surface as usize] == 0.0 {
                order.push(surface);
            }
            materials[surface as usize] += fraction * share;
        }
    }
    if grip_weight > 0.0 {
        out.grip /= grip_weight;
    }
    for surface in order {
        if out
            .surface
            .is_none_or(|best| materials[surface as usize] > materials[best as usize])
        {
            out.surface = Some(surface);
        }
    }
    out
}

/// How the running gear of a vehicle its engine drives pulls on a face of the ground it meets with
/// its rim (`SPRING_SLANT`): it grips the face as it grips the ground, its rim runs over it as fast
/// as the gear turns, and it pulls on it with no more than its drivetrain gives over the step. A
/// vehicle that runs into a wall stops against it: the spin of its wheels does not throw it up.
#[derive(Clone, Copy, Debug)]
pub struct Climb {
    pub grip: f64,
    /// How fast its rim runs, in m/s along the hull, ahead or back.
    pub speed: f64,
    /// What its drivetrain gives over the step, in N·s.
    pub impulse: f64,
}

/// How fast a towed vehicle that keeps pace with what tows it (`Pace`) takes up what its cable is out of its length by,
/// for each metre of it, in m/s: in about a sixth of a second, so that a cable drawn out as the other pulls away is let
/// go again before it pulls hard, and one gone slack is taken up with nothing to snatch at.
const PACE_TAKE_UP: f64 = 6.0;
/// The most it goes faster or slower than what tows it to do that, in m/s.
const PACE_CATCH: f64 = 0.5;
/// How much faster than its pace it may roll while what tows it is driven before it brakes, in m/s: what the ground and
/// the air take off it in a step or two.
const PACE_EASE: f64 = 0.05;
/// The least share of a cable that runs along its ground it is counted to: one that hangs nearly plumb, as over a ledge,
/// gains or loses little length as the vehicle goes, and is not chased the faster for it.
const PACE_SQUARE: f64 = 0.5;
/// How far short of its length the cable to a towed vehicle that keeps pace with what tows it may close as the two brake,
/// in m: where its own brake, all of it, does not bring it down as fast as what tows it, as with that one already climbing
/// out of a dip it is still running down into, what tows it brakes no harder than lets the cable close to that (`Lead`).
const PACE_ROOM: f64 = 0.5;
/// How a vehicle on a cable is driven (`DriveState::drive`).
#[derive(Clone, Copy, Debug)]
pub enum Hitch {
    /// Nothing tows it: it is driven as it is asked to be.
    Free,
    /// It is towed with no engine that drives it: it rolls free on its gear, to be pulled, whatever is asked of it.
    Towed,
    /// It is towed, and its engine drives it to keep pace with what tows it.
    Paced(Pace),
    /// It tows one that keeps pace with it, and brakes no harder than that one can follow.
    Leads(Lead),
}
/// What a towed vehicle that drives itself keeps pace with, once what tows it has been driven in the same step: the way
/// the cable runs from that end to this one, as a unit vector; how fast the end on what tows it moves; where the end on
/// this one is; how far the cable is drawn out beyond its length, short of it below zero; and the way, ahead or back along
/// the field, that the engine of what tows it drives it in, none while it brakes or nobody drives it.
#[derive(Clone, Copy, Debug)]
pub struct Pace {
    pub along: Point,
    pub lead: Point,
    pub anchor: Point,
    pub stretch: f64,
    pub driven: f64,
}
/// What a vehicle that tows one keeping pace with it brakes no harder than lets that one follow, as both were at the end
/// of the step before: the way the cable runs from this end to the other, as a unit vector; where the end on this one is;
/// how fast the end on the other moves; how far the cable is drawn out beyond its length, short of it below zero; and the
/// speed all of the brake of the other takes off it in a step, in m/s.
#[derive(Clone, Copy, Debug)]
pub struct Lead {
    pub along: Point,
    pub anchor: Point,
    pub end: Point,
    pub stretch: f64,
    pub follows: f64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct DriveState {
    pub actor: u32,
    pub enabled: bool,
    pub pose: Pose,
    pub velocity: Point,
    pub omega: f64,
    pub mass: f64,
    pub inertia: f64,
    pub carrier_mass: f64,
    pub carrier_inertia: f64,
    pub local_center: Point,
    pub carrier_center: Point,
    pub throttle: f64,
    /// How hard its brakes are asked for, as a share of what they give: from none to all of it.
    pub brake: f64,
    pub travel: f64,
    pub last_impulse: f64,
    pub peak_impulse: f64,
    pub traction: f64,
    pub gear_count: u32,
    pub grounded: bool,
    pub drive_speed: f64,
    pub ground_slope: f64,
    pub mobility: Mobility,
    /// What the engine delivered in the last step, in kW at the crankshaft.
    pub engine_kw: f64,
    /// What it burned for that, in litres per hour; zero while nothing is burned.
    pub fuel_rate: f64,
    /// The grip its running gear has on the ground while the brake holds it at rest; zero otherwise.
    pub hold: f64,
    /// How much faster than the ground passes under it the drivetrain turns the running gear, in m/s
    /// along the ground, as the step leaves the vehicle: no more than a creep while the ground gives back
    /// the pull it is asked for. It is what tells the next step that the gear slipped (`SLIPPED_BY`).
    pub slip: f64,
    /// How far the running gear has turned beyond what the vehicle travelled, in metres.
    pub slipped: f64,
    /// What keeps it where it is while its engine pushes; nothing while it makes way or is not driven.
    pub stuck: Option<Stuck>,
    /// What the springs of its gear give it in the step it was last driven for: `Carried`, of them all.
    pub carried: Carried,
    /// How hard it is asked to climb, from all of it down (−1) to all of it up (1): what W and S ask of a vehicle that
    /// flies. A vehicle that does not fly does nothing with it.
    pub rise: f64,
    /// Whether its flight computer holds it in the air (game_hover.rs): from a climb asked of thrusters that work until
    /// it is set down on the ground, or they or its fuel fail it.
    pub flying: bool,
    /// The most its thrusters that work push with together at sea level, in newtons: none on a vehicle that does not
    /// fly. Higher up they push with less (game_flight.rs `thrust_share`).
    pub thrust_n: f64,
    /// Where its flight computer keeps its centre of mass along the field and up, each while nothing is asked of it that
    /// way: where it came to a hover.
    pub station: (Option<f64>, Option<f64>),
}
impl DriveState {
    pub fn from_value(actor: u32, v: &Value) -> Self {
        let mass = number(v, "mass", number(v, "massTonnes", 0.001) * 1000.0);
        let inertia = number(v, "inertia", mass * (5.04 * 5.04 + 2.9 * 2.9) / 12.0);
        Self {
            actor,
            enabled: v["enabled"].as_bool().unwrap_or(true),
            pose: Pose::from_value(v),
            velocity: Point::new(number(v, "vx", 0.0), number(v, "vy", 0.0)),
            omega: number(v, "omega", 0.0),
            mass,
            inertia,
            carrier_mass: number(v, "carrierMass", mass),
            carrier_inertia: number(v, "carrierInertia", inertia),
            local_center: Point::from_value(&v["localCenter"]),
            carrier_center: Point::from_value(v.get("carrierCenter").unwrap_or(&v["localCenter"])),
            throttle: number(v, "throttle", 0.0).clamp(-1.0, 1.0),
            brake: number(v, "brake", 0.0).clamp(0.0, 1.0),
            travel: number(v, "travel", 0.0),
            last_impulse: number(v, "lastImpulse", 0.0),
            peak_impulse: number(v, "peakImpulse", 0.0),
            traction: number(v, "traction", 1.0),
            gear_count: number(v, "gearCount", 0.0) as u32,
            grounded: v["grounded"] == true,
            drive_speed: number(v, "driveSpeed", 0.0),
            ground_slope: number(v, "groundSlope", 0.0),
            mobility: Mobility {
                grip: number(v, "groundGrip", 0.0),
                rolling: number(v, "groundResistance", 0.0),
                pressure_kpa: number(v, "groundPressureKPa", 0.0),
                softness: number(v, "softGroundLoad", 0.0),
                surface: v["groundSurface"].as_str().map(SurfaceKind::from_name),
            },
            engine_kw: 0.0,
            fuel_rate: number(v, "fuelRate", 0.0),
            hold: 0.0,
            slip: number(v, "slip", 0.0),
            slipped: number(v, "slipped", 0.0),
            stuck: v["stuck"].as_str().and_then(Stuck::from_name),
            carried: Carried { load: number(v, "groundLoad", 0.0) * mass * 9.81, ..Carried::default() },
            rise: number(v, "rise", 0.0).clamp(-1.0, 1.0),
            flying: v["flying"] == true,
            thrust_n: number(v, "thrustN", 0.0),
            station: (v["station"][0].as_f64(), v["station"][1].as_f64()),
        }
    }
    /// How hard the springs of its gear pressed it on the ground in the step it was last driven for (`carried`), for its
    /// weight: all of it where nothing of it was pressed by springs.
    pub fn ground_load(&self) -> f64 {
        if self.carried.load == 0.0 {
            1.0
        } else {
            self.carried.load / (self.mass * 9.81)
        }
    }
    pub fn center(&self) -> Point {
        self.pose.world_point(self.carrier_center)
    }
    pub fn velocity_at(&self, point: Point) -> Point {
        let c = self.center();
        Point::new(
            self.velocity.x - self.omega * (point.y - c.y),
            self.velocity.y + self.omega * (point.x - c.x),
        )
    }
    pub fn control(&mut self, throttle: f64, brake: f64) {
        let share = |x: f64, low: f64| if x.is_finite() { x.clamp(low, 1.0) } else { 0.0 };
        self.throttle = share(throttle, -1.0);
        self.brake = share(brake, 0.0);
    }
    /// How hard it is asked to climb (`rise`): nothing for what is not a number.
    pub fn climb_asked(&mut self, rise: f64) {
        self.rise = if rise.is_finite() { rise.clamp(-1.0, 1.0) } else { 0.0 };
    }
    pub fn record_impulse(&mut self, impulse: Point) {
        self.last_impulse = hypot(impulse.x, impulse.y);
        self.peak_impulse = self.peak_impulse.max(self.last_impulse);
    }
    /// `facing` is the way the hull drives ahead (see `HullAir::read`): driven the other way, it backs.
    /// `faces` is how hard the faces its gear meets the way it is driven pressed on it in the step before, in N
    /// (`NativeWorld::pressing`). `hitch` is how a cable it is towed on has it driven: on one, what it is asked is let go.
    #[allow(clippy::too_many_arguments)]
    pub fn drive(
        &mut self,
        dt: f64,
        damage: &DamageState,
        geometry: &Geometry,
        terrain: &Terrain,
        gears: &mut [GearState],
        powertrain: &Powertrain,
        facing: f64,
        faces: f64,
        hitch: Hitch,
    ) {
        let towed = matches!(hitch, Hitch::Towed | Hitch::Paced(_));
        if towed { self.control(0.0, 0.0); }
        // How much faster than the ground passed under it its drivetrain turned the gear in the step before.
        let spun = self.slip;
        self.engine_kw = 0.0;
        self.hold = 0.0;
        self.slip = 0.0;
        self.stuck = None;
        self.carried = Carried::default();
        if !self.enabled {
            self.velocity = Point::ZERO;
            self.omega = 0.0;
            return;
        }
        self.gear_count = 0;
        self.traction = 0.0;
        let mut nx = 0.0;
        let mut ny = 0.0;
        let mut rigid = false;
        for gear in gears.iter_mut() {
            let Some(module) = damage.module(gear.owner) else {
                continue;
            };
            if module.actor != self.actor {
                continue;
            }
            self.carried.add(&gear.carried);
            gear.ground_contact = None;
            if self.grounded && cos(self.pose.angle) > 0.15 {
                gear.contact(damage, geometry, terrain);
            }
            if module.attached && module.kind.gear() {
                if module.health > 0.0 {
                    self.gear_count += 1;
                }
            }
            if let Some(contact) = &gear.ground_contact {
                rigid |= gear.springs.is_empty();
                // The ground pushes a gear without springs square to itself, and counts for all the
                // vehicle. Under a gear with them it pushes the way its springs are pushed, and counts
                // for as much of the vehicle as they carry: along the ground is square to that.
                if gear.springs.is_empty() {
                    nx += contact.normal.x;
                    ny += contact.normal.y;
                } else {
                    nx += gear.carried.push.x / (self.mass * 9.81);
                    ny += gear.carried.push.y / (self.mass * 9.81);
                }
                if module.health > 0.0 && module.max_health > 0.0 {
                    self.traction += module.health
                        / module.max_health
                        / if module.kind == ComponentKind::Wheel {
                            2.0
                        } else {
                            1.0
                        };
                }
            }
        }
        self.traction = self.traction.clamp(0.0, 1.0);
        let norm = hypot(nx, ny);
        let tangent = if norm > 0.0 {
            Point::new(ny / norm, -nx / norm)
        } else {
            Point::new(1.0, 0.0)
        };
        let speed = self.velocity.dot(tangent);
        // How hard the gear is pressed on the ground, for the weight of the vehicle: what its springs
        // carry, and a gear without springs carries what is left of the weight.
        let pressed = if rigid { self.ground_load().max(1.0) } else { self.ground_load() };
        self.ground_slope = atan2(tangent.y, tangent.x);
        self.mobility = ground_mobility(self.actor, gears, damage, self.mass);
        let carrier_mass = if self.carrier_mass > 0.0 {
            self.carrier_mass
        } else {
            self.mass
        };
        // Towed with an engine of its own, it keeps pace with what tows it: at the speed along its ground at which the
        // cable, as fast as its two ends move now, keeps its length, and takes up what it is out of it by
        // (`PACE_TAKE_UP`); never against the way the other is driven or rolls, and with nothing to take up while the
        // other stands. While the other is driven, it is driven flat out the same way, no faster than that (`paced`):
        // what it cannot give, the cable pulls it with; a little faster than that (`PACE_EASE`), or pulled on by a
        // cable it follows drawn out, which its brake would only draw out further, it lets the ground and the air slow it
        // with its engine still in gear. Otherwise, faster than that, it brakes as hard as brings it down to it, and
        // with all of its brake to stand where it is to keep none; slower, it rolls free on the cable. It never runs
        // into what tows it nor past it, whatever its own engine could give.
        let mut paced = None;
        if let Hitch::Paced(p) = hitch {
            let toward = p.along.dot(tangent);
            let toward = if toward.abs() < PACE_SQUARE { PACE_SQUARE.copysign(toward) } else { toward };
            let end = self.velocity_at(p.anchor);
            let drawing = (end.x - p.lead.x) * p.along.x + (end.y - p.lead.y) * p.along.y;
            let wanted = -(PACE_TAKE_UP * p.stretch).clamp(-PACE_CATCH, PACE_CATCH);
            let mut pace = speed + (wanted - drawing) / toward;
            let way = if p.driven != 0.0 { p.driven } else { sign(p.lead.dot(tangent)) };
            if pace * way < 0.0 || p.driven == 0.0 && hypot(p.lead.x, p.lead.y) < STANDSTILL_SPEED {
                pace = 0.0;
            }
            let pulled = p.stretch > 0.0 && speed * toward < 0.0;
            let (throttle, brake) = if pace * p.driven > 0.0 && ((pace - speed) * p.driven > -PACE_EASE || pulled) {
                paced = Some(pace.abs());
                (p.driven, 0.0)
            } else if pace == 0.0 {
                (0.0, 1.0)
            } else if (speed - pace) * sign(speed) > 0.0 {
                // What it has to lose, over what all of its brake takes off in a step.
                let lose = if pace * speed > 0.0 { speed.abs() - pace.abs() } else { speed.abs() };
                let most = 5.0_f64.min(9.81 * self.mobility.grip * pressed) * dt * self.mass / carrier_mass;
                (0.0, if most > 0.0 { (lose / most).min(1.0) } else { 1.0 })
            } else {
                (0.0, 0.0)
            };
            self.control(throttle, brake);
        }
        // Backing, the running gear turns no faster than its reverse gear lets the vehicle go.
        let ceiling = if self.throttle * facing < 0.0 {
            Some(powertrain.geared_speed.map_or(powertrain.max_speed * REVERSE_SHARE,
                |top| top.min(powertrain.max_speed * REVERSE_SHARE)))
        } else {
            powertrain.geared_speed
        };
        let ceiling = match paced {
            Some(pace) => Some(ceiling.map_or(pace, |top| top.min(pace))),
            None => ceiling,
        };
        let desired = sign(self.throttle) * ceiling.unwrap_or(powertrain.max_speed);
        // The share of what its brakes give that it brakes with: what is asked of them; with nothing asked, all of it
        // while nobody drives it, and while it is driven against the way it rolls.
        let braking = if self.brake > 0.0 {
            self.brake
        } else if (!towed && self.throttle == 0.0) || speed * sign(self.throttle) < -STANDSTILL_SPEED {
            1.0
        } else {
            0.0
        };
        let mut held = 0.0;
        self.drive_speed = if braking > 0.0 { 0.0 } else { desired };
        // What rolling over this ground takes.
        let rolling = self.mass * 9.81 * self.mobility.rolling * tangent.x.max(0.1);
        // The speed along the ground, the way it is driven, its drivetrain turns the gear at, and the share of what that is
        // beyond the speed the vehicle goes that the ground lets go of: what is seen of the gear once the vehicle is moved.
        let mut turns = None;
        if self.traction > 0.0 && powertrain.power_kw > 0.0 && self.throttle != 0.0 && braking == 0.0 {
            let turning = speed.abs().max(SLIP_SPEED);
            let power = powertrain.power_kw * 1000.0 * powertrain.efficiency;
            // What the drivetrain pulls flat out, and the share of that the key asks of the gear; what the ground under it
            // holds it by, and the faces it meets as it goes as well: the push of the drivetrain on the gear bears on
            // the face as it does on the ground, and the gear runs up the face (`NativeWorld::climb`) with what the face
            // holds, while what the ground holds is what it pushes the hull with.
            let pull = powertrain.max_drive_force.min(power / turning);
            let demand = pull * self.throttle.abs();
            let ground = self.mass * 9.81 * self.mobility.grip * pressed;
            let grip = ground + self.mobility.grip * faces.max(0.0);
            let along = speed * sign(self.throttle);
            // Asked for more than the ground and the faces hold, the gear breaks loose. One that slipped (`SLIPPED_BY`)
            // slips on until the ground has slowed it to the speed it passes under it.
            let spun = spun * sign(self.throttle);
            let slipping = demand > grip || spun > 0.0 && along + spun > turning + SLIPPED_BY;
            // Slipping, the gear turns on from the speed it turned at, and the ground holds it back by less the more of
            // that it slips by (`SurfaceKind::sliding`), which is what it pushes the vehicle with, and the faces as well.
            // What the drivetrain gives for the key at that speed beyond what they hold spins it up, and what it gives
            // short of that lets them slow it (`SPINNING`): towards where the two would be even, no faster than the
            // drivetrain drives the vehicle, or, where the drivetrain gives less than they hold at any speed, the speed
            // the ground passes under it.
            // Gripping, it pushes with all that is asked as far as the ground holds it, creeps as that nears the grip of
            // the ground, and churns too heavy for soft ground, up to the speed the drivetrain slips at.
            let (loose, turned, delivered, held) = if slipping {
                let rim = along + spun.max(0.0);
                let sliding = self.mobility.surface.map_or(1.0, SurfaceKind::sliding);
                let held = grip * (1.0 - (1.0 - sliding) * ((rim - along) / rim.max(SLIP_SPEED)).clamp(0.0, 1.0));
                let given = powertrain.max_drive_force.min(power / rim.max(SLIP_SPEED)) * self.throttle.abs();
                let even = if powertrain.max_drive_force * self.throttle.abs() > held {
                    (power * self.throttle.abs() / held).min(ceiling.unwrap_or(powertrain.max_speed))
                } else {
                    along
                };
                let towards = even.max(along);
                let spin = (given - held).abs() / (SPINNING * self.mass).max(0.001) * dt;
                let turned = if rim < towards { (rim + spin).min(towards) } else { (rim - spin).max(towards) };
                (1.0, turned, given * rim.max(SLIP_SPEED), held * ground / grip.max(f64::MIN_POSITIVE))
            } else {
                let sunk = rolling / (pull.min(ground) * self.traction);
                (rise(demand / ground, SLIP_GRIP).max(rise(sunk, SLIP_SINK)), SLIP_SPEED, 0.0, demand.min(ground))
            };
            let force = held * self.traction;
            turns = Some((turned, loose));
            let climb = self.mass * 9.81 * tangent.y * sign(self.throttle);
            // The most it pushes with: gripping, all the drivetrain pulls as far as the ground holds it; slipping, what
            // the ground holds the gear back by, whatever the key.
            // Pushed harder than the ground under it holds, it leans on a face it meets: one it does not get up holds it
            // for the grip of its gear on it.
            let most = if slipping { held } else { pull.min(ground) };
            let leaning = demand > ground && faces > 0.0;
            if along < STUCK_SPEED && (leaning || most * self.traction <= rolling + climb) {
                self.stuck = Some(if leaning || most < pull {
                    Stuck::Grip
                } else if rolling >= climb {
                    Stuck::Ground
                } else {
                    Stuck::Slope
                });
            }
            let limit = force / carrier_mass.max(0.001) * dt;
            // A wheel keeps receiving the pull its engine can deliver at the
            // current speed. An estimate of flat-road equilibrium cuts no pull.
            // A track or reverse gear can still stop adding it above its ceiling.
            let change = match ceiling {
                None => sign(self.throttle) * limit,
                Some(_) if self.throttle > 0.0 => (desired - speed).clamp(0.0, limit),
                Some(_) => (desired - speed).clamp(-limit, 0.0),
            };
            self.velocity.x += tangent.x * change;
            self.velocity.y += tangent.y * change;
            // The push it gave, at the speed it turned for it, through the losses of the drivetrain: never more than the
            // power installed. Slipping, it is what the drivetrain gave the gear at the speed the gear turned.
            if dt > 0.0 && powertrain.efficiency > 0.0 {
                let pushed = if slipping { delivered * self.traction } else { change.abs() * carrier_mass.max(0.001) / dt * turning };
                self.engine_kw = pushed / powertrain.efficiency / 1000.0;
            }
        }
        // A vehicle nobody is driving holds its brake instead of rolling away on a slope.
        // The opposite key uses this same brake until nearly stopped, then engages its new gear.
        // The brake asked for by name is held even against the throttle, with the share of it asked for.
        if braking > 0.0 && self.traction > 0.0 {
            let limit = braking * 5.0_f64.min(9.81 * self.mobility.grip * pressed);
            let mut loss = speed.abs().min(limit * dt * self.mass / carrier_mass);
            // Towing one that keeps pace with it, it loses no more speed than closes the cable faster than all of the
            // brake of the other opens it again, and than takes it in to `PACE_ROOM` short of its length at the rate
            // that one takes it up at (`PACE_TAKE_UP`): the two brake as one, as hard as the one that brakes less can.
            if let Hitch::Leads(l) = hitch {
                let closes = -sign(speed) * l.along.dot(tangent);
                if closes > 0.0 {
                    let end = self.velocity_at(l.anchor);
                    let opening = (l.end.x - end.x) * l.along.x + (l.end.y - end.y) * l.along.y;
                    let room = (PACE_TAKE_UP * (l.stretch + PACE_ROOM)).clamp(0.0, PACE_CATCH);
                    loss = loss.min(((opening + l.follows + room) / closes).max(0.0));
                }
            }
            let change = -sign(speed) * loss;
            self.velocity.x += tangent.x * change;
            self.velocity.y += tangent.y * change;
            // Brought to rest, the brake holds. Taking speed away step by step would let the
            // weight on a slope carry the vehicle a little between one step and the next, so
            // its running gear grips the ground with what the brake can give for as long as it stands.
            if speed + change == 0.0 {
                self.hold = limit / 9.81 / tangent.x.abs().max(0.5);
                // A gear on its springs rubs nothing on the ground. It holds back what they and the
                // weight would move the vehicle by along the ground in this step, as far as it grips.
                let grip = self.hold * (tangent.x * self.carried.push.y - tangent.y * self.carried.push.x).max(0.0);
                held = (self.mass * 9.81 * tangent.y - self.carried.push.dot(tangent)).clamp(-grip, grip);
            }
        }
        // Rolling holds it back along the ground, and the air the way it moves, as hard as the side it shows that way
        // takes in the air at the height of its centre of mass (`Powertrain::air`): in the air as on the ground, and
        // neither past standing still.
        let rolling_speed = self.velocity.dot(tangent);
        let roll = -sign(rolling_speed) * rolling_speed.abs().min(rolling / carrier_mass.max(0.001) * dt);
        self.velocity.x += tangent.x * roll;
        self.velocity.y += tangent.y * roll;
        let moving = hypot(self.velocity.x, self.velocity.y);
        if moving > 0.0 {
            let air = powertrain.air(self.pose.angle, self.velocity, facing, self.center().y) * moving * moving;
            let kept = 1.0 - moving.min(air / carrier_mass.max(0.001) * dt) / moving;
            self.velocity.x *= kept;
            self.velocity.y *= kept;
        }
        // The gear is seen to turn faster than the ground now passes under it by what the ground lets go of.
        if let Some((turned, loose)) = turns {
            self.slip = sign(self.throttle) * loose * (turned - self.velocity.dot(tangent) * sign(self.throttle)).max(0.0);
            self.slipped += self.slip * dt;
        }
        // The ground moves a vehicle along from under it. On springs that leans the hull: it sits
        // back as it pulls away and dips as it brakes, by what its springs give for their share of
        // the moment of that push about its centre of mass (`SPRING_LEAN`).
        if self.carried.load > 0.0 && dt > 0.0 {
            let center = self.center();
            let along = carrier_mass * (self.velocity.dot(tangent) - speed) / dt + held;
            let share = if powertrain.tracked { 1.0 } else { SPRING_LEAN };
            self.carried.moment += share
                * along
                * ((self.carried.foot.x / self.carried.load - center.x) * tangent.y
                    - (self.carried.foot.y / self.carried.load - center.y) * tangent.x);
            self.carried.push.x += tangent.x * held;
            self.carried.push.y += tangent.y * held;
        }
    }
    /// How the running gear pulls on a face it meets as `drive` left it, over a step of `dt`: not at
    /// all while the engine does not drive it, nor against the brake. It turns as fast as the vehicle
    /// goes and as it slips, and pulls with what the drivetrain gives at that speed.
    pub fn climb(&self, powertrain: &Powertrain, dt: f64) -> Option<Climb> {
        // drive_speed is the effective target from drive, including its braking decision.
        if !self.enabled || self.traction <= 0.0 || powertrain.power_kw <= 0.0 || self.drive_speed == 0.0 {
            return None;
        }
        let along = self.velocity.x * cos(self.pose.angle) + self.velocity.y * sin(self.pose.angle);
        let power = powertrain.power_kw * 1000.0 * powertrain.efficiency;
        let pull = powertrain.max_drive_force.min(power / along.abs().max(SLIP_SPEED));
        Some(Climb {
            grip: self.mobility.grip,
            speed: along + self.slip,
            impulse: pull * self.throttle.abs() * self.traction * dt,
        })
    }
    pub fn to_value(&self, powertrain: &Powertrain) -> Value {
        serde_json::to_value(NativeVehicle::new(self, powertrain)).expect("serializable vehicle DTO")
    }
}

#[derive(Clone, Copy, Debug)]
pub struct ServoProfile {
    pub max_speed: f64,
}
impl ServoProfile {
    pub fn from_module(module: &Module) -> Self {
        let remaining=(1.0-module.elevation_damage/(module.max_health*crate::game_damage::BARREL_DISABLED_SHARE)).clamp(0.0,1.0);
        Self {max_speed:module.mount.as_ref().map_or(0.0,|m|m.max_speed)*remaining}
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ServoState {
    pub owner: u32,
    pub velocity: f64,
    pub target: f64,
    // Seconds until this gun fires again: every gun of a vehicle reloads on its own.
    pub reload: f64,
    // How hot its barrel is, and whether a pilot that brought it to the limit waits for it to cool (game_barrel.rs).
    pub barrel: BarrelState,
    // Of a rotary gun, the seconds its barrels take to come up to their rate from rest (game_variant.rs `SPIN_UP`), none
    // for a gun of one barrel; and how far up to it they turn now, from 0 to 1. A field read back starts them at rest.
    pub spin_up: f64,
    pub spin: f64,
    // How it is fed (game_variant.rs `Feed`); the rounds ready in its belt or magazine, never more than its boxes hold of
    // its cartridge; the seconds left of the belt its crew is changing or of the round it is putting back in its magazine;
    // and how long the trigger that names it has been let go. A gun comes into the field full (`GameState::load_guns`).
    pub feed: Feed,
    pub loaded: u32,
    pub feed_reload: f64,
    pub lull: f64,
}
/// How long the trigger of a gun fed by a belt is let go before its crew changes a belt half spent or more for a full one.
pub const BELT_LULL: f64 = 3.0;
impl ServoState {
    pub fn from_value(owner: u32, v: &Value, barrel: BarrelState) -> Self {
        Self {
            owner,
            velocity: number(v, "servoVelocity", 0.0),
            target: number(v, "targetBarrelAngle",
                number(v, "barrelAngle", PI + number(v, "angle", 0.0))),
            reload: number(v, "reload", 0.0).max(0.0),
            barrel,
            spin_up: 0.0,
            spin: 0.0,
            feed: Feed::HAND,
            // A piece that tells none comes full: a construction that turned about tells what it had.
            loaded: v["loaded"].as_u64().map_or(u32::MAX, |n| n.min(u64::from(u32::MAX)) as u32),
            feed_reload: number(v, "feedReload", 0.0).max(0.0),
            lull: 0.0,
        }
    }
    /// Whether its feed lets it fire: a round ready. A belt being topped up in a lull still holds the rounds it had, and
    /// the crew leaves it as it is when the trigger comes back (`feed_step`). A gun loaded by hand is loaded as it fires,
    /// as its rate has it.
    pub fn fed(&self) -> bool {
        match self.feed.kind {
            FeedKind::Hand => true,
            FeedKind::Belt | FeedKind::Magazine => self.loaded >= 1,
        }
    }
    /// Seconds until its feed lets it fire again: its belt or magazine empty, the rest of the belt being changed or of the
    /// round going back in the magazine.
    pub fn feed_wait(&self) -> f64 {
        match self.feed.kind {
            FeedKind::Hand => 0.0,
            FeedKind::Belt | FeedKind::Magazine => if self.loaded == 0 { self.feed_reload.max(0.0) } else { 0.0 },
        }
    }
    /// Seconds until its belt is changed or its magazine full again, none while it is not being loaded: of a magazine, the
    /// round going in and those it lacks after it.
    pub fn feed_left(&self) -> f64 {
        match self.feed.kind {
            FeedKind::Hand => 0.0,
            FeedKind::Belt => self.feed_reload.max(0.0),
            FeedKind::Magazine if self.feed_reload > 0.0 =>
                self.feed_reload + self.feed.per_round * f64::from(self.feed.rounds.saturating_sub(self.loaded + 1)),
            FeedKind::Magazine => 0.0,
        }
    }
    /// Takes its feed as the catalogue states it (`Feed::of`) and comes as full as `aboard` rounds of its cartridge let it,
    /// or with what it told it had (`from_value`): the rest of a belt change, or of the round going in a magazine.
    pub fn load(&mut self, feed: Feed, aboard: u32) {
        self.feed = feed;
        self.loaded = self.loaded.min(feed.rounds).min(aboard);
        let told = self.feed_reload;
        self.feed_reload = match feed.kind {
            FeedKind::Hand => 0.0,
            FeedKind::Belt => told.min(feed.reload),
            // What a magazine tells is how long until it is full (`feed_left`).
            FeedKind::Magazine => (told - feed.per_round * f64::from(feed.rounds.saturating_sub(self.loaded + 1))).clamp(0.0, feed.per_round),
        };
    }
    /// A step of `dt` seconds of its feed, with `aboard` rounds of its cartridge in its boxes and the trigger that names it
    /// `held` or not. A belt that ran out is changed, and one half spent or more is topped up when the trigger was let go
    /// `BELT_LULL`, until the trigger comes back; the crew puts a round back in a magazine every `per_round` seconds while
    /// the trigger is let go or the magazine is empty; a gun loaded by hand holds the round it fires next.
    pub fn feed_step(&mut self, dt: f64, aboard: u32, held: bool) {
        self.lull = if held { 0.0 } else { self.lull + dt };
        self.loaded = self.loaded.min(aboard);
        let full = self.feed.rounds.min(aboard);
        match self.feed.kind {
            FeedKind::Hand => { self.loaded = full; self.feed_reload = 0.0; }
            FeedKind::Belt => {
                if self.feed_reload > 0.0 {
                    // With no round of it left aboard there is no belt to put in; firing from the belt it holds, the crew
                    // leaves it as it is.
                    if aboard == 0 || held && self.loaded > 0 { self.feed_reload = 0.0; return; }
                    self.feed_reload -= dt;
                    if self.feed_reload <= 1e-9 { self.feed_reload = 0.0; self.loaded = full; }
                } else if aboard > self.loaded && (self.loaded == 0 || self.lull >= BELT_LULL && self.loaded * 2 <= self.feed.rounds) {
                    self.feed_reload = self.feed.reload;
                    if self.feed_reload <= 0.0 { self.loaded = full; }
                }
            }
            FeedKind::Magazine => {
                if self.loaded >= full || held && self.loaded > 0 {
                    // Full as far as its boxes go, or firing from it: the crew puts none back.
                    self.feed_reload = 0.0;
                } else if self.feed.per_round <= 0.0 {
                    self.loaded = full;
                } else {
                    if self.feed_reload <= 0.0 { self.feed_reload = self.feed.per_round; }
                    self.feed_reload -= dt;
                    if self.feed_reload <= 1e-9 {
                        self.loaded += 1;
                        self.feed_reload = if self.loaded < full { self.feed_reload + self.feed.per_round } else { 0.0 };
                    }
                }
            }
        }
    }
    /// A round fired from its feed: a belt that runs out is changed at once.
    pub fn fired_round(&mut self) {
        self.loaded = self.loaded.saturating_sub(1);
        if self.feed.kind == FeedKind::Belt && self.loaded == 0 && self.feed_reload <= 0.0 {
            self.feed_reload = self.feed.reload;
        }
    }
    /// The share of its rate the gun fires at now: all of it, or a rotor's as far as it turns, from its first turn.
    pub fn turning(&self) -> f64 {
        if self.spin_up > 0.0 { self.spin.max(crate::game_variant::SPIN_FLOOR) } else { 1.0 }
    }
    /// A step of `dt` seconds with the trigger that names the gun `held` or not: a rotor comes up to its rate, or down.
    pub fn spin(&mut self, dt: f64, held: bool) {
        if self.spin_up > 0.0 {
            let change = if held { dt / self.spin_up } else { -dt / crate::game_variant::SPIN_DOWN };
            self.spin = (self.spin + change).clamp(0.0, 1.0);
        }
    }
    pub fn to_value(&self) -> Value {
        json!({"owner":self.owner,"servoVelocity":self.velocity,"targetBarrelAngle":self.target,"reload":self.reload,
            "barrelTemperature":self.barrel.temperature,"barrelCooling":self.barrel.cooling,"loaded":self.loaded,"feedReload":self.feed_left()})
    }
}
// A fixed angular rate is the entire aiming actuator. Its barrel has no
// contact geometry or reaction torque; projectile/muzzle occlusion is separate.
pub fn advance_servo(state: &mut ServoState, module: &mut Module, target: f64, dt: f64) -> bool {
    let current = module.barrel_angle;
    let mount=module.mount.as_ref().expect("admitted mounted weapon");
    let current_offset=angle_difference(current,module.pose.angle);
    let target_offset=angle_difference(target,module.pose.angle).clamp(mount.min,mount.max);
    // Both bearings share this bounded interval about the mount axis. Wrapping
    // their difference again can take a wide pintle through its excluded back.
    let error = target_offset-current_offset;
    state.target = current + error;
    state.velocity = 0.0;
    if dt <= 0.0 || !module.usable() || module.barrel_disabled || module.elevation_disabled { return false; }
    let rate = ServoProfile::from_module(module).max_speed;
    let delta = error.clamp(-rate * dt, rate * dt);
    if delta.abs() < 1e-10 { return false; }
    module.barrel_angle = current + delta;
    if delta.abs() < error.abs() { state.velocity = sign(delta) * rate; }
    true
}
/// Whether something stands in the mouth of a gun: the ground, or the material of a
/// construction — of any, or of `only` the one named. On an open field, where
/// constructions pass through each other, a gun is stopped by its own construction
/// alone: it is not plugged by driving into it, and fires into what it stands in.
pub fn muzzle_obstruction(
    geometry: &Geometry,
    terrain: &Terrain,
    owner: u32,
    only: Option<u32>,
    tip: Point,
    angle: f64,
    radius: f64,
) -> bool {
    let dir = Point::new(cos(angle), sin(angle));
    let pad = 0.006_f64.max(radius * 1.1);
    let ignore = [owner];
    let options = RayOptions {
        ignore_ids: &ignore,
        only_actor: only,
        ..Default::default()
    };
    for offset in [0.0, -radius, radius] {
        let a = Point::new(
            tip.x - dir.x * pad - dir.y * offset,
            tip.y - dir.y * pad + dir.x * offset,
        );
        let b = Point::new(
            tip.x + dir.x * pad - dir.y * offset,
            tip.y + dir.y * pad + dir.x * offset,
        );
        if geometry.raycast(a, b, &options).is_some()
            || terrain.raycast(a, b).is_some()
            || a.y <= terrain.height(a.x)
            || b.y <= terrain.height(b.x)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_geometry::{EntityGeometry, EntityKind, rectangle};
    fn module(owner: u32, kind: &str, x: f64, y: f64) -> Module {
        let mut value=json!({"kind":kind,"x":x,"y":y,"health":80,"maxHealth":80});
        if kind!="weapon" {
            value["width"]=json!(0.74);value["height"]=json!(0.74);value["physicalMass"]=json!(110);
        }
        crate::game_damage::fixtures::module(owner,1,&value)
    }
    #[test]
    fn explicit_suspension_travel_including_zero_is_preserved() {
        for kind in ["wheel", "track"] {
            let mut gear = module(1, kind, 0.0, 0.5);
            for (travel, expected) in [(0.0, 0.0), (0.2, 0.2), (0.4, 0.4), (2.0, 0.4)] {
                gear.cold["suspension"] = json!({"travel":travel});
                assert_eq!(gear_travel(&gear), expected);
            }
        }
    }
    #[test]
    fn live_powertrain_obeys_volume_health_and_reserves() {
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(
            1,
            1,
            &json!({
                "kind":"engine", "width":1.05, "height":0.64,
                "mechanicalDepth":0.65, "health":110, "maxHealth":110,
            }),
        ));
        damage.insert_module(crate::game_damage::fixtures::module(
            2,
            1,
            &json!({
                "kind":"fuel", "fuelLitres":20, "health":75, "maxHealth":75,
            }),
        ));
        damage.insert_module(module(3, "wheel", 0.0, 0.37));
        let full = Powertrain::project(1, 30000.0, &damage, HullAir::default());
        assert!((full.power_kw - 180.0).abs() < 1e-10);
        assert!(full.max_speed > 0.0);
        assert!(full.range_km > 0.0);
        assert_eq!(full.to_value()["rangeKm"], full.range_km);
        damage.module_mut(2).unwrap().fuel_litres /= 2.0;
        let half = Powertrain::project(1, 30000.0, &damage, HullAir::default());
        assert!((half.range_km - full.range_km / 2.0).abs() < 1e-10);
        damage.module_mut(2).unwrap().fuel_litres *= 2.0;
        // An engine of size s is as deep as the reference one and holds s² of its volume, and gives s² of its power.
        let reference_volume = damage.module(1).unwrap().volume;
        for scale in [0.5_f64, 1.5, 2.0] {
            damage.module_mut(1).unwrap().volume = reference_volume * scale.powi(2);
            let sized = Powertrain::project(1, 30000.0, &damage, HullAir::default());
            assert!((sized.power_kw - full.power_kw * scale.powi(2)).abs() < 1e-8);
            assert!((sized.torque_nm - full.torque_nm * scale.powi(2)).abs() < 1e-8);
        }
        damage.module_mut(1).unwrap().volume = reference_volume;
        damage.module_mut(1).unwrap().health = 55.0;
        let worn = Powertrain::project(1, 30000.0, &damage, HullAir::default());
        assert!((worn.power_kw - 90.0).abs() < 1e-10);
        assert!(worn.max_speed < full.max_speed);
        damage.module_mut(2).unwrap().fuel_litres = 0.0;
        let empty = Powertrain::project(1, 30000.0, &damage, HullAir::default());
        assert_eq!(empty.power_kw, 0.0);
        assert_eq!(empty.max_speed, 0.0);
        assert_eq!(empty.range_km, 0.0);
        assert!(empty.fuel_starved);
    }
    #[test]
    fn suspension_travel_follows_the_height_of_the_gear_within_bounds() {
        let wheel = module(1, "wheel", 0.0, 0.37);
        let track = module(2, "track", 0.0, 0.37);
        assert!((gear_travel(&wheel) - 0.2072).abs() < 1e-9);
        assert!((gear_travel(&track) - 0.1184).abs() < 1e-9);
        let mut small = wheel.clone();
        small.height = 0.01;
        assert_eq!(gear_travel(&small), 0.06);
        let mut large = wheel;
        large.height = 10.0;
        assert_eq!(gear_travel(&large), 0.30);
    }
    #[test]
    fn a_track_stands_at_its_outermost_road_wheels_no_higher_than_the_stop_of_their_springs() {
        // The smallest track a chassis makes and the largest, high over the ground, which lifts neither end of them, on
        // springs that travel as far as their road wheels stand under their ends (game_chassis.rs).
        let terrain = Terrain::new("flat").unwrap();
        for height in [0.39, 1.17] {
            let mut track = module(1, "track", 0.0, 10.0);
            (track.width, track.height) = (8.0 * height, height);
            let wheels = track_wheels(track.width, track.height);
            let (travel, last) = (wheels.end.y - wheels.low, wheels.road[wheels.road.len() - 1]);
            let stop = travel * (1.0 - SPRING_REST);
            let near = |a: (f64, f64), b: (f64, f64)| (a.0 - b.0).abs() < 1e-12 && (a.1 - b.1).abs() < 1e-12;
            // Short of its stop, hanging or leaning, it stands where its road wheels have it.
            for stand in [(0.0, 0.0), (stop / 2.0, 0.4 * stop / last), (-travel * SPRING_REST, 0.01)] {
                assert!(near(track_stand(&track, 0.0, stand.0, stand.1, travel, &terrain), stand), "{height}: {stand:?}");
            }
            // Leaning on past it from a road wheel at its stop between them, either way: held at the stop at the end it
            // leans up to, and where it was at the other.
            for lean in [1.0, -1.0] {
                let (displacement, tilt) = track_stand(&track, 0.0, 0.9 * stop, lean * stop / last, travel, &terrain);
                let ends = [displacement + lean * last * tilt, displacement - lean * last * tilt];
                assert!((ends[0] - stop).abs() < 1e-12 && (ends[1] + 0.1 * stop).abs() < 1e-12, "{height} {lean}: {ends:?}");
            }
            // Pressed up past it all along: at the stop, level.
            assert!(near(track_stand(&track, 0.0, 1.5 * stop, 0.0, travel, &terrain), (stop, 0.0)), "{height}");
            // At the stop its road wheels still stand a third of their travel under its idler and its sprocket, which
            // its belt goes round outside.
            assert!((wheels.end.y - (wheels.low + stop) - travel * SPRING_REST).abs() < 1e-12);
        }
    }
    #[test]
    fn springs_share_the_vehicle_as_built_and_take_a_third_of_their_travel_under_it() {
        let seat = |x: f64, travel: f64| (Point::new(x, -0.5), 0.0, travel);
        let built = |x: f64, laden: f64| Built { mass: 6000.0, center: Point::new(x, 0.0), inertia: 9000.0, laden, laden_center: Point::new(x, 0.0) };
        let weight = 6000.0 * 9.81;
        // Wherever the weight lies among them they carry all of it and leave the hull level.
        for center in [0.0, 0.6, -0.4] {
            let made = springs(&[seat(-2.0, 0.2), seat(-0.5, 0.2), seat(1.0, 0.2), seat(2.0, 0.2)], &built(center, 1.0), 9.81);
            let made: Vec<Spring> = made.into_iter().map(Option::unwrap).collect();
            assert!((made.iter().map(|s| s.load).sum::<f64>() - weight).abs() < 1e-6);
            assert!(made.iter().map(|s| s.load * (s.seat.x - center)).sum::<f64>().abs() < 1e-6);
            for s in &made {
                assert!(s.load > 0.0 && (s.load / s.rate - 0.2 * SPRING_REST).abs() < 1e-12 && s.firm == s.rate);
                // Short of critical damping, and nothing a step of the world cannot carry.
                assert!(s.damping > 0.0 && s.damping < 2.0 * sqrt(s.rate * s.load / 9.81));
            }
        }
        // A seat that would have to pull carries nothing, and is still a spring.
        let made = springs(&[seat(-2.0, 0.2), seat(0.0, 0.2), seat(2.0, 0.2)], &built(1.9, 1.0), 9.81);
        let made: Vec<Spring> = made.into_iter().map(Option::unwrap).collect();
        assert_eq!(made[0].load, 0.0);
        assert!(made[0].rate > 0.0 && (made[1].load + made[2].load - weight).abs() < 1e-6);
        // What the vehicle can take aboard stiffens them past where it was built: three times its
        // own mass, and twice as stiff there.
        let laden = springs(&[seat(-2.0, 0.2), seat(2.0, 0.2)], &built(0.0, 3.0), 9.81);
        assert!(laden.iter().flatten().all(|s| (s.firm - 2.0 * s.rate).abs() < 1e-9));
        // A load bed over the rear axle loads that one: it is the stiffer, and laden the hull sits level
        // with each spring a third of its travel past where it rests, as it does under an even load.
        let mut rear = built(0.0, 3.0);
        rear.laden_center = Point::new(-0.5, 0.0);
        let bed: Vec<Spring> = springs(&[seat(-2.0, 0.2), seat(2.0, 0.2)], &rear, 9.81).into_iter().map(Option::unwrap).collect();
        assert!(bed[0].firm > 2.0 * bed[1].firm, "{} against {}", bed[0].firm, bed[1].firm);
        let carried = [0.625 * 3.0 * weight, 0.375 * 3.0 * weight];
        for (s, carried) in bed.iter().zip(carried) {
            assert!(((carried - s.load) / s.firm - 0.2 * SPRING_REST).abs() < 1e-9, "{}", (carried - s.load) / s.firm);
        }
        // With very little travel a spring is as stiff as a step of the world carries, and no stiffer.
        let short = springs(&[seat(-2.0, 0.001), seat(2.0, 0.001)], &built(0.0, 1.0), 9.81);
        let moved = 1.0 / (1.0 / 6000.0 + 4.0 / 9000.0);
        assert!(short.iter().flatten().all(|s| s.rate == SPRING_LIMIT.0 * moved && s.damping == SPRING_LIMIT.1 * moved));
        // No travel, no spring; and none in a world without weight.
        assert!(springs(&[seat(-2.0, 0.0), seat(2.0, 0.2)], &built(0.0, 1.0), 9.81)[0].is_none());
        assert!(springs(&[seat(-2.0, 0.2), seat(2.0, 0.2)], &built(0.0, 1.0), 0.0).iter().all(Option::is_none));
    }
    #[test]
    fn a_gear_in_the_air_has_no_contact_and_a_failed_one_stays_on_the_ground() {
        let mut damage = DamageState::default();
        damage.insert_module(module(1, "wheel", 0.0, 0.55));
        let mut geometry = Geometry::new();
        let wheel = damage.module(1).unwrap();
        geometry.upsert(1, crate::game_damage::fixtures::geometry(1, 1, EntityKind::Module, &wheel.to_value()).unwrap());
        let terrain = Terrain::new("flat").unwrap();
        let mut gear = GearState::from_value(1, &Value::Null);
        gear.contact(&damage, &geometry, &terrain);
        assert!(gear.ground_contact.is_none());
        let wheel = damage.module_mut(1).unwrap();
        wheel.pose.y = 0.37;
        wheel.health = 0.0;
        geometry.set_pose(1, wheel.pose, None);
        gear.contact(&damage, &geometry, &terrain);
        assert!(gear.ground_contact.is_some(), "failed gear remains physical material on the ground");
        // On springs it is on the ground for as long as they carry.
        gear.springs = springs(&[(Point::new(0.0, 0.37), 0.0, 0.2)], &Built { mass: 110.0, center: Point::ZERO, inertia: 10.0, laden: 1.0, laden_center: Point::ZERO }, 9.81)
            .into_iter().flatten().collect();
        gear.contact(&damage, &geometry, &terrain);
        assert!(gear.ground_contact.is_none());
        gear.carried.load = 1.0;
        gear.contact(&damage, &geometry, &terrain);
        assert!(gear.ground_contact.is_some());
    }
    #[test]
    fn ballistic_material_is_independent_of_movement_contacts() {
        let mut g = Geometry::new();
        g.upsert(
            2,
            EntityGeometry {
                owner: 2,
                actor: 2,
                kind: EntityKind::Plate,
                barrel_angle: None,post:false,
                pose: Pose::default(),
                polygons: vec![rectangle(1.0, 1.0)],
                grid: None,
                clear_to: None,
                aside: false,
                between: false,
            },
        );
        let hit = g
            .raycast(
                Point::new(-2.0, 0.0),
                Point::new(2.0, 0.0),
                &RayOptions::default(),
            )
            .unwrap();
        assert_eq!(hit.actor, 2);
        assert!((hit.depth - 1.0).abs() < 1e-10);
    }
    #[test]
    fn pressure_affects_mobility_without_adding_energy() {
        let mut damage = DamageState::default();
        let m = module(1, "wheel", 0.0, 0.37);
        damage.insert_module(m);
        let contact = TerrainSupport {
            normal: Point::new(0.0, 1.0),
            tangent: Point::new(1.0, 0.0),
            point: Point::ZERO,
            contacts: 4,
            materials: [0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0],
            material_order: vec![SurfaceKind::Mud],
            min_x: -0.1,
            max_x: 0.1,
        };
        let mut gear = GearState::from_value(1, &Value::Null);
        gear.ground_contact = Some(contact);
        let small = ground_mobility(1, &[gear.clone()], &damage, 1000.0);
        let large = ground_mobility(1, &[gear], &damage, 10000.0);
        assert!(large.rolling > small.rolling);
        assert!(large.grip < small.grip);
    }
    #[test]
    fn post_brake_drag_never_reverses_vehicle() {
        let mut damage = DamageState::default();
        for owner in 1..=2 {
            damage.insert_module(module(owner, "wheel", owner as f64, 0.37));
        }
        let mut geometry = Geometry::new();
        for m in &damage.modules {
            let mut e =
                crate::game_damage::fixtures::geometry(m.owner, m.actor, EntityKind::Module, &m.to_value())
                    .unwrap();
            e.pose = m.pose;
            geometry.upsert(m.owner, e);
        }
        let mut gears = vec![
            GearState::from_value(1, &Value::Null),
            GearState::from_value(2, &Value::Null),
        ];
        let terrain = Terrain::new("flat").unwrap();
        let mut drive = DriveState::from_value(
            1,
            &json!({"mass":1000,"vx":0.01,"brake":1.0,"grounded":true}),
        );
        let p = Powertrain {
            drag: 100000.0,
            ..Default::default()
        };
        drive.drive(0.1, &damage, &geometry, &terrain, &mut gears, &p, -1.0, 0.0, Hitch::Free);
        assert!(drive.velocity.x >= 0.0);
        assert_eq!(drive.velocity.x, 0.0);
    }
    #[test]
    fn wheels_follow_power_and_resistance_while_tracks_keep_their_rotation_ceiling() {
        let powered = |gear: &str, height: f64| {
            let mut damage = DamageState::default();
            damage.insert_module(crate::game_damage::fixtures::module(1, 1, &json!({
                "kind":"engine", "width":1.05, "height":0.64, "mechanicalDepth":0.65, "health":110, "maxHealth":110})));
            damage.insert_module(crate::game_damage::fixtures::module(2, 1, &json!({
                "kind":"fuel", "fuelLitres":20, "health":75, "maxHealth":75})));
            let mut running = module(3, gear, 0.0, 0.37);
            running.height = height;
            damage.insert_module(running);
            damage
        };
        let light = Powertrain::project(1, 4000.0, &powered("wheel", 0.74), HullAir::default());
        assert_eq!(light.geared_speed, None);
        assert!(light.max_speed > 65.0 * 0.37, "the old wheel rotation ceiling no longer limits the estimate");
        // Rolling more weight consumes more of the same available power.
        let laden = Powertrain::project(1, 60000.0, &powered("wheel", 0.74), HullAir::default());
        assert_eq!(laden.geared_speed, light.geared_speed);
        assert!(laden.max_speed < light.max_speed * 0.8 && laden.max_speed > 1.0);
        let held = (60000.0 * 9.81 * laden.rolling_coefficient + laden.drag * laden.max_speed * laden.max_speed) * laden.max_speed;
        assert!((held - laden.power_kw * 1000.0 * laden.efficiency).abs() < 1.0, "there the power exactly holds rolling and drag");
        // A wheel half the size turns faster at the same road speed and pulls the same.
        let small = Powertrain::project(1, 4000.0, &powered("wheel", 0.37), HullAir::default());
        assert_eq!(small.geared_speed, None);
        assert_eq!(small.max_speed, light.max_speed);
        assert_eq!(small.max_drive_force, light.max_drive_force);
        let tracked = Powertrain::project(1, 4000.0, &powered("track", 0.74), HullAir::default());
        assert_eq!(tracked.geared_speed, Some(TRACK_SPEED_LIMIT));
        // A track half the size runs as fast.
        let small_track = Powertrain::project(1, 4000.0, &powered("track", 0.37), HullAir::default());
        assert_eq!(small_track.geared_speed, tracked.geared_speed);
        assert!(tracked.geared_speed.unwrap() < light.max_speed);
        let heavy_track = Powertrain::project(1, 60000.0, &powered("track", 0.74), HullAir::default());
        assert_eq!(heavy_track.geared_speed, tracked.geared_speed);
        assert!(heavy_track.max_speed < tracked.max_speed);
        let held = (60000.0 * 9.81 * heavy_track.rolling_coefficient + heavy_track.drag * heavy_track.max_speed.powi(2)) * heavy_track.max_speed;
        assert!((held - heavy_track.power_kw * 1000.0 * heavy_track.efficiency).abs() < 1.0);
        // The air holds a hull by what it shows ahead (game_air.rs): sixteen metres high, a wall and a wedge are both held
        // by it, the wedge by less, and it goes faster. Hulls told by their corners in order, facing left.
        let tall = |corners: &[(f64, f64)]| {
            let plates = json!(corners.iter().enumerate().map(|(i, &(x, y))| {
                let (x2, y2) = corners[(i + 1) % corners.len()];
                let (x, y, x2, y2) = (x * 8.0, y * 8.0, x2 * 8.0, y2 * 8.0);
                json!({"x": (x + x2) / 2.0, "y": (y + y2) / 2.0, "angle": atan2(y2 - y, x2 - x), "length": hypot(x2 - x, y2 - y), "widthM": 2.4})
            }).collect::<Vec<_>>());
            HullAir::read(&plates, [], -1.0, 0.0)
        };
        let blunt = Powertrain::project(1, 4000.0, &powered("wheel", 0.74), tall(&[(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (0.0, 2.0)]));
        let keen = Powertrain::project(1, 4000.0, &powered("wheel", 0.74), tall(&[(0.0, 0.0), (6.0, 0.0), (6.0, 2.0), (4.0, 2.0)]));
        assert_eq!(blunt.geared_speed, None);
        assert!(keen.drag < blunt.drag && (keen.drag_astern - blunt.drag).abs() < 1e-9, "backing, the wedge shows its upright back");
        assert!(keen.max_speed > blunt.max_speed * 1.02, "{} against {}", keen.max_speed, blunt.max_speed);
    }
    #[test]
    fn the_engine_only_pushes_and_never_holds_a_faster_vehicle_back() {
        let mut damage = DamageState::default();
        damage.insert_module(module(1, "wheel", 0.0, 0.37));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 1, EntityKind::Module, &damage.modules[0].to_value()).unwrap(),
        );
        let terrain = Terrain::new("flat").unwrap();
        let powertrain = Powertrain {
            power_kw: 100.0,
            efficiency: 0.8,
            max_drive_force: 5000.0,
            geared_speed: Some(20.0),
            drag: 2.0,
            ..Default::default()
        };
        // The same vehicle with an engine that gives nothing: asked to go, it only rolls.
        let dead = Powertrain {
            efficiency: 0.8,
            max_drive_force: 5000.0,
            geared_speed: Some(20.0),
            drag: 2.0,
            ..Default::default()
        };
        // Pushed ahead, whichever way that is.
        let step = |state: Value, powertrain: &Powertrain| {
            let mut gears = vec![GearState::from_value(1, &Value::Null)];
            let mut drive = DriveState::from_value(1, &state);
            let ahead = number(&state, "throttle", 1.0).signum();
            drive.drive(1.0 / 60.0, &damage, &geometry, &terrain, &mut gears, powertrain, ahead, 0.0, Hitch::Free);
            assert!(drive.traction > 0.0);
            drive.velocity.x
        };
        let after = |vx: f64, throttle: f64| {
            step(json!({"mass":1000,"vx":vx,"throttle":throttle,"grounded":true}), &powertrain)
        };
        let rolled = |vx: f64| {
            step(json!({"mass":1000,"vx":vx,"throttle":if vx < 0.0 { -1 } else { 1 },"grounded":true}), &dead)
        };
        // Faster than the ceiling, as down a slope: holding the throttle is exactly rolling.
        assert_eq!(after(30.0, 1.0), rolled(30.0));
        assert_eq!(after(-30.0, -1.0), rolled(-30.0));
        assert!(rolled(30.0) < 30.0, "only rolling and drag slow it down");
        // Below the ceiling the engine pushes the way it is asked to.
        assert!(after(10.0, 1.0) > rolled(10.0));
        assert!(after(-10.0, -1.0) < rolled(-10.0));
        // Asked the other way, it brakes before engaging its new gear.
        assert!(after(30.0, -1.0) < rolled(30.0));
        // The last of the way up to the ceiling stops at it.
        assert!(after(19.999, 1.0) <= 20.0);
    }
    #[test]
    fn a_vehicle_backs_at_a_share_of_its_top_speed() {
        let mut rig = Rig::new(8000.0);
        let ahead = rig.settled(0.0).velocity.x;
        assert!((ahead - rig.powertrain.max_speed).abs() < 0.05 * ahead, "{ahead} against {}", rig.powertrain.max_speed);
        // The same vehicle turned the other way: the key that drove it ahead now backs it.
        rig.facing = -1.0;
        let backing = rig.settled(0.0).velocity.x;
        let reverse = REVERSE_SHARE * rig.powertrain.max_speed;
        assert!((backing - reverse).abs() < 0.01 * reverse, "{backing} against {reverse}");
        // Faster than that already, as rolling down a slope, the engine adds nothing and holds nothing back.
        let mut fast = rig.drive(ahead, 1.0);
        rig.step(&mut fast);
        assert!(fast.velocity.x <= ahead && fast.velocity.x > backing, "{}", fast.velocity.x);
    }
    #[test]
    fn wheels_keep_receiving_physical_pull_above_their_flat_road_estimate() {
        let mut powered = Rig::new(4000.0);
        let mut dead = Rig::new(4000.0);
        dead.powertrain.power_kw = 0.0;
        assert_eq!(powered.powertrain.geared_speed, None);
        for speed in [65.0 * powered.powertrain.radius + 8.0, powered.powertrain.max_speed * 1.2] {
            let pushed = powered.at(speed, 1.0);
            let rolling = dead.at(speed, 1.0);
            assert!(pushed.velocity.x > rolling.velocity.x, "the engine still pushes above {speed}");
            assert!(pushed.velocity.x.is_finite() && pushed.slip.is_finite());
            assert!((pushed.engine_kw - powered.powertrain.power_kw).abs() < 1e-9);
        }
    }
    #[test]
    fn a_vehicle_nobody_drives_holds_its_brake() {
        let mut damage = DamageState::default();
        damage.insert_module(module(1, "wheel", 0.0, 0.37));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 1, EntityKind::Module, &damage.modules[0].to_value()).unwrap(),
        );
        let terrain = Terrain::new("flat").unwrap();
        let powertrain = Powertrain {
            power_kw: 100.0,
            efficiency: 0.8,
            max_drive_force: 5000.0,
            geared_speed: Some(20.0),
            drag: 2.0,
            ..Default::default()
        };
        let after = |state: Value| {
            let mut gears = vec![GearState::from_value(1, &Value::Null)];
            let mut drive = DriveState::from_value(1, &state);
            drive.drive(1.0 / 60.0, &damage, &geometry, &terrain, &mut gears, &powertrain, 1.0, 0.0, Hitch::Free);
            assert!(drive.traction > 0.0);
            (drive.velocity.x, drive.engine_kw, drive.hold)
        };
        let let_go = |vx: f64| after(json!({"mass":1000,"vx":vx,"grounded":true}));
        let braked = |vx: f64| after(json!({"mass":1000,"vx":vx,"brake":1.0,"grounded":true}));
        // Let go, it brakes as hard as with the brake asked for, either way it rolls, and burns nothing.
        for vx in [12.0, -12.0, 0.6] {
            assert_eq!(let_go(vx), braked(vx));
            assert!(let_go(vx).0.abs() < vx.abs() - 0.05, "the brake takes more than rolling does");
            assert_eq!(let_go(vx).1, 0.0);
        }
        // What a slope of thirty degrees adds to it in a step, eight hundredths of a metre a second, the brake takes back.
        assert_eq!(let_go(0.08).0, 0.0);
        assert_eq!(let_go(-0.08).0, 0.0);
        // Brought to rest, its running gear grips the ground with what the brake can give; still rolling, it does not.
        for vx in [0.08, -0.08, 0.0] {
            assert!(let_go(vx).2 > 0.0 && let_go(vx).2 <= 5.0 / 9.81);
        }
        assert_eq!(let_go(12.0).2, 0.0);
        // The throttle held, the brake is off unless it is asked for.
        let driven = after(json!({"mass":1000,"vx":12,"throttle":1,"grounded":true}));
        assert!(driven.0 > 12.0);
        assert_eq!(after(json!({"mass":1000,"vx":0,"throttle":1,"grounded":true})).2, 0.0);
    }
    #[test]
    fn a_share_of_the_brake_takes_that_share_of_what_the_brakes_give() {
        let mut damage = DamageState::default();
        damage.insert_module(module(1, "wheel", 0.0, 0.37));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 1, EntityKind::Module, &damage.modules[0].to_value()).unwrap(),
        );
        let terrain = Terrain::new("flat").unwrap();
        // No drag: what rolling takes is the same at every speed, and the rest is the brake's.
        let powertrain = Powertrain { power_kw: 100.0, efficiency: 0.8, max_drive_force: 5000.0, max_speed: 20.0, ..Default::default() };
        let after = |vx: f64, throttle: f64, brake: f64| {
            let mut gears = vec![GearState::from_value(1, &Value::Null)];
            let mut drive = DriveState::from_value(1, &json!({"mass":1000,"vx":vx,"throttle":throttle,"brake":brake,"grounded":true}));
            drive.drive(1.0 / 60.0, &damage, &geometry, &terrain, &mut gears, &powertrain, 1.0, 0.0, Hitch::Free);
            (drive.velocity.x, drive.engine_kw, drive.hold, drive.drive_speed)
        };
        // Under its top speed either way, ahead and backing.
        for vx in [12.0, -6.0] {
            // Over a step a share of the brakes takes that share of what all of them take off it, beside what rolling does.
            let taken = |brake: f64| (vx - after(vx, 0.0, brake).0) * vx.signum();
            let all = 2.0 * (taken(1.0) - taken(0.5));
            assert!(all > 4.0 / 60.0 && all <= 5.0 / 60.0 + 1e-12, "{all}");
            for brake in [0.1, 0.25, 0.8] {
                assert!((taken(1.0) - taken(brake) - (1.0 - brake) * all).abs() < 1e-9, "{vx} {brake}: {}", taken(brake));
                // Braking, the engine gives nothing, however the throttle is held.
                let driven = after(vx, vx.signum(), brake);
                assert_eq!((driven.0, driven.1, driven.3), (after(vx, 0.0, brake).0, 0.0, 0.0));
            }
            // Asked for none, a vehicle nobody drives holds all of it, and one driven brakes not at all.
            assert_eq!(after(vx, 0.0, 0.0).0, after(vx, 0.0, 1.0).0);
            assert!(after(vx, vx.signum(), 0.0).1 > 0.0);
        }
        // Brought to rest, its running gear grips the ground with that share of what the brakes can give.
        let held = after(0.0, 0.0, 1.0).2;
        assert!(held > 0.0);
        for brake in [0.1, 0.5] {
            assert!((after(0.0, 0.0, brake).2 - brake * held).abs() < 1e-12);
        }
    }
    /// A test track of one surface, by its outline as a page sends one: level, and from x = 0 on climbing `rise` to the metre.
    fn ground(surface: &str, rise: f64) -> Terrain {
        Terrain::from_value(&json!({"id":"hills","material":surface,"points":[{"x":-100,"y":0},{"x":0,"y":0},{"x":100,"y":100.0*rise}],
            "sectors":[{"start":-1600,"end":1600,"surface":surface}]})).unwrap()
    }
    // A stock 180 kW engine, a tank and two wheels on flat ground, under a vehicle of a given mass.
    struct Rig {
        damage: DamageState,
        geometry: Geometry,
        terrain: Terrain,
        gears: Vec<GearState>,
        powertrain: Powertrain,
        mass: f64,
        // Ahead is to the right, the way the key held in `settled` drives it.
        facing: f64,
    }
    impl Rig {
        fn new(mass: f64) -> Self {
            Self::of_kind(mass, "wheel")
        }
        fn tracked(mass: f64) -> Self {
            Self::of_kind(mass, "track")
        }
        fn of_kind(mass: f64, kind: &str) -> Self {
            let mut damage = DamageState::default();
            damage.insert_module(crate::game_damage::fixtures::module(1, 1, &json!({
                "kind":"engine", "width":1.05, "height":0.64, "mechanicalDepth":0.65, "health":110, "maxHealth":110})));
            damage.insert_module(crate::game_damage::fixtures::module(2, 1, &json!({
                "kind":"fuel", "fuelLitres":20, "health":75, "maxHealth":75})));
            let mut geometry = Geometry::new();
            for owner in 3..=4 {
                let wheel = module(owner, kind, owner as f64, 0.37);
                let mut entity = crate::game_damage::fixtures::geometry(owner, 1, EntityKind::Module, &wheel.to_value()).unwrap();
                entity.pose = wheel.pose;
                geometry.upsert(owner, entity);
                damage.insert_module(wheel);
            }
            let powertrain = Powertrain::project(1, mass, &damage, HullAir::default());
            Self {
                damage,
                geometry,
                terrain: Terrain::new("flat").unwrap(),
                gears: (3..=4).map(|owner| GearState::from_value(owner, &Value::Null)).collect(),
                powertrain,
                mass,
                facing: 1.0,
            }
        }
        // The same rig with its wheels stood on another ground, the first of them at `x`.
        fn on(mut self, terrain: Terrain, x: f64) -> Self {
            self.terrain = terrain;
            for (owner, x) in [(3, x), (4, x + 1.0)] {
                let pose = Pose { x, y: self.terrain.height(x) + 0.37, angle: 0.0 };
                self.damage.module_mut(owner).unwrap().pose = pose;
                self.geometry.set_pose(owner, pose, None);
            }
            self
        }
        fn drive(&self, vx: f64, throttle: f64) -> DriveState {
            DriveState::from_value(1, &json!({"mass":self.mass,"vx":vx,"throttle":throttle,"grounded":true}))
        }
        fn step(&mut self, drive: &mut DriveState) {
            drive.drive(1.0 / 60.0, &self.damage, &self.geometry, &self.terrain, &mut self.gears, &self.powertrain, self.facing, 0.0, Hitch::Free);
            assert_eq!(drive.traction, 1.0);
        }
        // One step at a speed with the key held so far.
        fn at(&mut self, vx: f64, throttle: f64) -> DriveState {
            let mut drive = self.drive(vx, throttle);
            self.step(&mut drive);
            drive
        }
        // The key held all the way down until the speed no longer changes.
        fn settled(&mut self, from: f64) -> DriveState {
            let mut drive = self.drive(from, 1.0);
            for _ in 0..60000 {
                let before = drive.velocity.x;
                self.step(&mut drive);
                if (drive.velocity.x - before).abs() < 1e-11 {
                    break;
                }
            }
            drive
        }
        // What rolling and drag take from the engine at a speed, in kW at the crankshaft.
        fn holding_kw(&self, drive: &DriveState, speed: f64) -> f64 {
            (self.powertrain.drag * speed * speed + self.mass * 9.81 * drive.mobility.rolling) * speed
                / self.powertrain.efficiency
                / 1000.0
        }
    }

    #[test]
    fn opposite_keys_use_the_brake_then_engage_the_engine_near_rest_in_either_facing() {
        for kind in ["wheel", "track"] {
            for facing in [-1.0, 1.0] {
                let mut rig = Rig::of_kind(8000.0, kind);
                rig.facing = facing;
                for direction in [-1.0, 1.0] {
                    for speed in [0.5, 12.0] {
                        let opposite = rig.at(direction * speed, -direction);
                        let mut manual = rig.drive(direction * speed, 0.0);
                        manual.brake = 1.0;
                        rig.step(&mut manual);
                        assert_eq!(opposite.velocity, manual.velocity);
                        assert_eq!((opposite.drive_speed, opposite.engine_kw, opposite.slip), (0.0, 0.0, 0.0));
                        assert!(opposite.climb(&rig.powertrain, 1.0 / 60.0).is_none(), "braking applies no engine impulse to a face");
                        assert_eq!((opposite.throttle, opposite.brake), (-direction, 0.0), "the held input survives the braking phase");
                    }
                    let launch = rig.at(-direction * 0.06, direction);
                    assert!(launch.engine_kw > 0.0 && launch.velocity.x * direction > -0.06, "a small rollback does not keep the brake on");
                    assert!(launch.climb(&rig.powertrain, 1.0 / 60.0).is_some());
                }
            }
        }
    }
    #[test]
    fn fuel_flow_is_the_work_delivered_plus_a_turning_share() {
        let full = 180.0 * 0.25 / 0.835;
        assert!((fuel_flow(180.0, 180.0) - 1.04 * full).abs() < 1e-12);
        assert!((fuel_flow(45.0, 180.0) - 0.29 * full).abs() < 1e-12);
        assert!((fuel_flow(0.0, 180.0) - 0.04 * full).abs() < 1e-12, "an engine that pushes nothing only turns");
        assert_eq!(fuel_flow(0.0, 0.0), 0.0);
        assert_eq!(fuel_flow(-10.0, -20.0), 0.0);
    }
    #[test]
    fn cruise_range_uses_the_current_reserve_and_caps_work_at_installed_power() {
        let drive = Powertrain { max_speed: 20.0, power_kw: 180.0, efficiency: 0.8,
            rolling_coefficient: 0.02, drag: 3.0, fuel_litres: 100.0, ..Default::default() };
        // A four-tonne vehicle at 72 km/h needs 49.62 kW; the turning share
        // brings the fuel flow to 17.01197604790419 litres per hour.
        let range = drive.cruise_range(4000.0);
        assert!((range - 423.2312565997888).abs() < 1e-9);
        assert!((Powertrain { fuel_litres: 50.0, ..drive }.cruise_range(4000.0) - range / 2.0).abs() < 1e-9);
        assert!(drive.cruise_range(8000.0) < range);
        assert!((Powertrain { power_kw: 20.0, ..drive }.cruise_range(4000.0) - 1156.1538461538462).abs() < 1e-9);
        for stopped in [Powertrain { fuel_litres: 0.0, ..drive }, Powertrain { power_kw: 0.0, ..drive },
            Powertrain { max_speed: 0.0, ..drive }] {
            assert_eq!(stopped.cruise_range(4000.0), 0.0);
        }
    }
    #[test]
    fn full_throttle_delivers_the_installed_power_only_above_the_crossover_speed() {
        // Thirty-six tonnes on concrete: the ground holds all the drivetrain pulls.
        let mut rig = Rig::new(36000.0);
        let p = rig.powertrain;
        // Below it the pull is what the transmission allows, at the speed the drivetrain slips.
        let launch = rig.at(0.0, 1.0);
        assert!(rig.mass * 9.81 * launch.mobility.grip > p.max_drive_force);
        let crossover = p.power_kw * 1000.0 * p.efficiency / p.max_drive_force;
        assert!(crossover > SLIP_SPEED && crossover < p.max_speed, "{crossover}");
        assert!((launch.engine_kw - p.max_drive_force * SLIP_SPEED / p.efficiency / 1000.0).abs() < 1e-9);
        assert!(launch.engine_kw < p.power_kw, "launching is limited by pull, not by power: {}", launch.engine_kw);
        // Four tonnes on the same ground pull more than it holds: flat out the gear slips, and once it has spun up past
        // that speed all the engine gives goes into it, at the speed it spins.
        let mut light = Rig::new(4000.0);
        let mut spinning = light.drive(0.0, 1.0);
        for _ in 0..10 {
            light.step(&mut spinning);
        }
        assert!(light.powertrain.max_drive_force > light.mass * 9.81 * spinning.mobility.grip);
        let lp = light.powertrain;
        assert!(spinning.velocity.x + spinning.slip > lp.power_kw * 1000.0 * lp.efficiency / lp.max_drive_force, "{}", spinning.slip);
        assert!((spinning.engine_kw - lp.power_kw).abs() < 1e-9, "{}", spinning.engine_kw);
        // Above it every step takes all the engine has, whatever the speed.
        for speed in [crossover * 1.05, 10.0, 20.0] {
            let accelerating = rig.at(speed, 1.0);
            assert!(accelerating.velocity.x > rig.at(speed, 0.0).velocity.x);
            assert!((accelerating.engine_kw - p.power_kw).abs() < 1e-9, "{speed}: {}", accelerating.engine_kw);
            // Half the key asks for half of it; reversing against the motion uses the brake first.
            assert!((rig.at(speed, 0.5).engine_kw - p.power_kw / 2.0).abs() < 1e-9);
            assert_eq!(rig.at(speed, -1.0).engine_kw, 0.0);
        }
        assert_eq!(rig.at(10.0, 0.0).engine_kw, 0.0, "a released key delivers nothing");
    }
    #[test]
    fn the_gear_turns_with_the_ground_while_the_ground_gives_back_the_pull() {
        // Thirty-six tonnes on concrete: the pull is a third of the grip, and rolling takes little of it.
        let mut rig = Rig::new(36000.0);
        for (speed, throttle) in [(0.0, 1.0), (1.0, 1.0), (0.0, -1.0), (8.0, 1.0), (8.0, -1.0), (0.0, 0.3)] {
            let drive = rig.at(speed, throttle);
            assert_eq!((drive.slip, drive.slipped, drive.stuck), (0.0, 0.0, None), "{speed} {throttle}");
        }
        // Nothing slips that is not driven: the key let go, the brake held, the engine dead.
        let mut sand = Rig::new(24000.0).on(ground("sand", 0.0), 3.0);
        assert_eq!(sand.at(0.0, 0.0).slip, 0.0);
        let mut braked = sand.drive(0.0, 1.0);
        braked.brake = 1.0;
        sand.step(&mut braked);
        assert_eq!((braked.slip, braked.stuck), (0.0, None));
        sand.powertrain.power_kw = 0.0;
        assert_eq!((sand.at(0.0, 1.0).slip, sand.at(0.0, 1.0).stuck), (0.0, None));
    }
    #[test]
    fn too_heavy_for_soft_ground_the_gear_churns_where_the_vehicle_stands() {
        let mut rig = Rig::new(64000.0).on(ground("sand", 0.0), 3.0);
        let p = rig.powertrain;
        for throttle in [1.0_f64, -1.0, 0.4] {
            let mut drive = rig.drive(0.0, throttle);
            for _ in 0..60 {
                rig.step(&mut drive);
            }
            let m = drive.mobility;
            assert!(rig.mass * 9.81 * m.grip > p.max_drive_force, "the sand holds more than the drivetrain pulls");
            assert!(rig.mass * 9.81 * m.rolling > p.max_drive_force, "and rolling over it takes more than that");
            assert_eq!(drive.velocity.x, 0.0, "{throttle}");
            // The gear turns at the speed the drivetrain slips, the way it is driven, and that adds up.
            assert_eq!(drive.slip, SLIP_SPEED * throttle.signum(), "{throttle}");
            assert!((drive.slipped - SLIP_SPEED * throttle.signum()).abs() < 1e-9, "{}", drive.slipped);
            assert_eq!(drive.stuck, Some(Stuck::Ground));
        }
        // Lighter, the same ground lets it go: it makes way, and its gear slips less the faster it goes.
        let mut light = Rig::new(40000.0).on(ground("sand", 0.0), 3.0);
        let setting_off = light.at(0.0, 1.0);
        assert!(setting_off.velocity.x > 0.0 && setting_off.stuck.is_none());
        assert!(setting_off.slip > 0.0 && setting_off.slip < SLIP_SPEED, "{}", setting_off.slip);
        let under_way = light.at(0.8, 1.0).slip;
        assert!(under_way > 0.0 && under_way < setting_off.slip, "{under_way}");
        assert_eq!(light.at(SLIP_SPEED, 1.0).slip, 0.0);
    }
    #[test]
    fn asked_for_more_than_the_ground_holds_the_gear_breaks_loose() {
        // Four tonnes and 180 kW on concrete: the drivetrain pulls near three times what the wheels can put down.
        let mut rig = Rig::new(4000.0);
        let p = rig.powertrain;
        let launch = rig.at(0.0, 1.0);
        let grip = rig.mass * 9.81 * launch.mobility.grip;
        let pull = p.max_drive_force.min(p.power_kw * 1000.0 * p.efficiency / SLIP_SPEED);
        assert!(pull > 2.5 * grip, "{pull} {grip}");
        // Flat out the gear breaks loose, and the vehicle still sets off. As the gear begins to slip the ground holds it
        // back by all of the grip, and the drivetrain spins it up by what it gives beyond that, against the share of the
        // weight the gear spins up with.
        let spun = (pull - grip) / (SPINNING * rig.mass) / 60.0;
        assert!((launch.velocity.x + launch.slip - spun).abs() < 1e-9, "{} {spun}", launch.slip);
        assert!(launch.slip > SLIP_SPEED && launch.velocity.x > 0.0 && launch.stuck.is_none());
        // It spins on ahead of the vehicle, the ground holding it back by less the more of its turning it slips by, up to
        // where all the engine gives at the speed it turns the gear is what the ground holds it back by: a little short
        // of it, as that falls while the vehicle speeds up.
        let power = p.power_kw * 1000.0 * p.efficiency;
        let sliding = launch.mobility.surface.map_or(1.0, SurfaceKind::sliding);
        let mut spinning = rig.drive(0.0, 1.0);
        for _ in 0..45 {
            rig.step(&mut spinning);
        }
        let rim = spinning.velocity.x + spinning.slip;
        let holding = grip * (1.0 - (1.0 - sliding) * spinning.slip / rim);
        assert!(rim > spinning.velocity.x.max(SLIP_SPEED) + SLIPPED_BY, "{rim} {}", spinning.velocity.x);
        assert!((power / rim / holding - 1.0).abs() < 0.05, "{rim} {}", power / rim / holding);
        // The key at what the ground holds gets it going sooner than flat out, the gear only creeping under it, while it
        // goes slower than its drivetrain slips at (`SLIP_SPEED`), where the key asks the same of it; a fifth of that,
        // not at all.
        let held = rig.at(0.0, 0.99 * grip / pull);
        assert!(held.slip > 0.0 && held.velocity.x + held.slip < SLIP_SPEED, "{}", held.slip);
        let (mut dosed, mut flat) = (rig.drive(0.0, 0.99 * grip / pull), rig.drive(0.0, 1.0));
        for _ in 0..10 {
            rig.step(&mut dosed);
            rig.step(&mut flat);
        }
        assert!(dosed.velocity.x < SLIP_SPEED && dosed.velocity.x > flat.velocity.x, "{} {}", dosed.velocity.x, flat.velocity.x);
        assert_eq!(rig.at(0.0, 0.2 * grip / pull).slip, 0.0);
        // Half the key asks for more than the ground holds: it breaks loose too, pushed as hard as it begins to, and spun
        // up by less.
        let half = rig.at(0.0, 0.5);
        assert!(half.slip > 0.0 && half.slip < launch.slip, "{} {}", half.slip, launch.slip);
        assert!((half.velocity.x - launch.velocity.x).abs() < 1e-9);
        // Past the speed a gear spinning free turns at, there is nothing left to slip.
        let turned = power / (sliding * grip);
        assert!(turned > SLIP_SPEED && turned < p.max_speed);
        assert_eq!(rig.at(turned + 1.0, 1.0).slip, 0.0);
        // In mud, on wheels half shot away, the grip left is less than rolling takes: it slips where it stands.
        let mut mud = Rig::new(6000.0).on(ground("mud", 0.0), 3.0);
        for owner in 3..=4 {
            mud.damage.module_mut(owner).unwrap().health = 40.0;
        }
        let mut drive = mud.drive(0.0, 1.0);
        drive.drive(1.0 / 60.0, &mud.damage, &mud.geometry, &mud.terrain, &mut mud.gears, &mud.powertrain, mud.facing, 0.0, Hitch::Free);
        assert_eq!(drive.traction, 0.5);
        assert_eq!((drive.velocity.x, drive.stuck), (0.0, Some(Stuck::Grip)));
        assert!(drive.slip > SLIP_SPEED, "{}", drive.slip);
    }
    #[test]
    fn a_gear_that_broke_loose_slips_on_until_it_is_pushed_less_than_the_ground_holds_it_back() {
        // Four tonnes and 180 kW on concrete, flat out from rest: the gear slips, spinning ahead of the vehicle, until the
        // vehicle goes about as fast; from there on it grips. It changes once, and the gear goes on turning as fast as it did.
        let mut rig = Rig::new(4000.0);
        let mut drive = rig.drive(0.0, 1.0);
        let mut seen = Vec::new();
        for _ in 0..600 {
            rig.step(&mut drive);
            seen.push((drive.slip > 0.0, drive.velocity.x + drive.slip));
        }
        let changes: Vec<usize> = (1..seen.len()).filter(|&i| seen[i].0 != seen[i - 1].0).collect();
        assert_eq!(changes.len(), 1, "{changes:?}");
        let gripped = changes[0];
        assert!(seen[..gripped].iter().all(|s| s.0), "{:?}", &seen[..gripped]);
        assert!((seen[gripped].1 - seen[gripped - 1].1).abs() < 0.12, "{:?}", &seen[gripped - 1..=gripped]);
        let grip = rig.mass * 9.81 * drive.mobility.grip;
        let p = rig.powertrain;
        let power = p.power_kw * 1000.0 * p.efficiency;
        let pull = p.max_drive_force.min(power / SLIP_SPEED);
        // A gear slipping by `slip` under a vehicle going `vx`, with the key held at `throttle`.
        fn spinning(rig: &Rig, vx: f64, slip: f64, throttle: f64) -> DriveState {
            let mut drive = rig.drive(vx, throttle);
            drive.slip = slip;
            drive
        }
        // How many steps it slips for, at the most `steps`.
        fn slips(rig: &mut Rig, drive: &mut DriveState, steps: usize) -> usize {
            (0..steps).take_while(|_| {
                rig.step(drive);
                drive.slip > SLIPPED_BY
            }).count()
        }
        // Under way, where the drivetrain gives the less the faster it turns the gear, a gear spun far ahead of the vehicle
        // is slowed by the ground under a key that asks for less than the ground holds, and grips again.
        let mut fast = spinning(&rig, 5.0, 20.0, 0.95 * grip * 5.0 / power);
        assert!(slips(&mut rig, &mut fast, 60) < 30, "{}", fast.slip);
        // At rest, where the drivetrain pulls the same however fast it turns the gear: a key that asks for less than the
        // ground holds back a gear spinning free lets the ground slow it, and it grips again; one between that and all the
        // grip spins it on if it slips by much of its turning, and lets the ground slow it if by little: at nine tenths
        // of the grip, by half of it.
        let mut free = spinning(&rig, 0.0, 1.8, 0.75 * grip / pull);
        assert!(slips(&mut rig, &mut free, 20) < 10);
        let mut free = spinning(&rig, 0.0, 1.8, 0.9 * grip / pull);
        let before = free.slip;
        assert_eq!(slips(&mut rig, &mut free, 5), 5);
        assert!(free.velocity.x + free.slip > before, "{}", free.slip);
        let mut little = spinning(&rig, 1.4, 0.3, 0.9 * grip / pull);
        assert!(slips(&mut rig, &mut little, 10) < 5, "{}", little.slip);
        // Gripping, keys under all the grip hold. Past it the gear breaks loose, and is pushed with all of it; it spins
        // ahead of the vehicle once the drivetrain gives more than the ground holds back the gear and the vehicle with
        // together (`SPINNING`), and further ahead step by step.
        for share in [0.75, 0.9, 0.99] {
            let mut gripping = rig.drive(0.0, share * grip / pull);
            for _ in 0..10 {
                rig.step(&mut gripping);
                assert!(gripping.velocity.x + gripping.slip <= SLIP_SPEED, "{share}");
            }
        }
        let mut past = rig.drive(0.0, 1.02 * grip / pull);
        let mut pushed = rig.drive(0.0, grip / pull);
        rig.step(&mut past);
        rig.step(&mut pushed);
        assert!(past.slip == 0.0 && (past.velocity.x - pushed.velocity.x).abs() < 1e-9, "{}", past.slip);
        let mut past = rig.drive(0.0, (1.0 + 1.5 * SPINNING) * grip / pull);
        let mut ahead = 0.0;
        for _ in 0..5 {
            rig.step(&mut past);
            assert!(past.slip > ahead, "{} {ahead}", past.slip);
            ahead = past.slip;
        }
    }
    #[test]
    fn up_a_slope_that_takes_more_than_the_gear_gives_as_it_slides_a_key_under_the_grip_climbs() {
        // Four tonnes on concrete that climbs at about five in six: it takes more than its gear gives as it slides, less
        // than it holds.
        let mut rig = Rig::new(4000.0).on(ground("concrete", 0.84), 20.0);
        let mut slipping = rig.drive(0.0, 1.0);
        rig.step(&mut slipping);
        let grip = rig.mass * 9.81 * slipping.mobility.grip;
        let need = rig.mass * 9.81 * (sin(slipping.ground_slope) + slipping.mobility.rolling * cos(slipping.ground_slope));
        assert!(need > SurfaceKind::Concrete.sliding() * grip && need < 0.95 * grip, "{need} {grip}");
        // Flat out its gear breaks loose, spins free where it stands the step after, and it says so; the rig has no weight
        // to hold it back up the slope, only its drivetrain and the ground.
        rig.step(&mut slipping);
        assert_eq!(slipping.stuck, Some(Stuck::Grip));
        assert!(slipping.slip > SLIP_SPEED);
        // The key under what the ground holds climbs.
        let pull = rig.powertrain.max_drive_force.min(rig.powertrain.power_kw * 1000.0 * rig.powertrain.efficiency / SLIP_SPEED);
        let mut held = rig.drive(0.0, 0.97 * grip / pull);
        rig.step(&mut held);
        assert_eq!(held.stuck, None);
        assert!(held.velocity.x + held.slip < SLIP_SPEED);
    }
    #[test]
    fn a_climb_too_steep_for_the_engine_stops_it_without_slipping() {
        // Firm ground that climbs by more than the seventh of its weight the drivetrain pulls.
        let mut rig = Rig::new(60000.0).on(ground("soil", 0.4), 20.0);
        let mut drive = rig.drive(0.0, 1.0);
        drive.drive(1.0 / 60.0, &rig.damage, &rig.geometry, &rig.terrain, &mut rig.gears, &rig.powertrain, rig.facing, 0.0, Hitch::Free);
        assert!(drive.traction > 0.0 && drive.ground_slope > 0.2, "{} {}", drive.traction, drive.ground_slope);
        assert_eq!((drive.slip, drive.stuck), (0.0, Some(Stuck::Slope)));
        // Driven down the same slope it is not stuck at all.
        let mut down = rig.drive(0.0, -1.0);
        down.drive(1.0 / 60.0, &rig.damage, &rig.geometry, &rig.terrain, &mut rig.gears, &rig.powertrain, rig.facing, 0.0, Hitch::Free);
        assert_eq!(down.stuck, None);
    }
    #[test]
    fn what_a_gear_slipped_is_kept_with_the_state_of_its_vehicle() {
        let mut rig = Rig::new(64000.0).on(ground("sand", 0.0), 3.0);
        let mut drive = rig.drive(0.0, 1.0);
        for _ in 0..60 {
            rig.step(&mut drive);
        }
        let kept = DriveState::from_value(1, &drive.to_value(&rig.powertrain));
        assert_eq!((kept.slip, kept.slipped, kept.stuck), (drive.slip, drive.slipped, drive.stuck));
        assert!(kept.slipped > 1.0 && kept.stuck == Some(Stuck::Ground));
    }
    #[test]
    fn tracks_hold_their_speed_ceiling_without_reducing_low_speed_pull() {
        let mut free = Rig::tracked(4000.0);
        let top = TRACK_SPEED_LIMIT;
        let mut held = Rig::tracked(4000.0);
        assert_eq!((held.powertrain.geared_speed, held.powertrain.max_drive_force), (Some(top), free.powertrain.max_drive_force));
        assert!((held.powertrain.max_speed - top).abs() < 1e-6, "{}", held.powertrain.max_speed);
        // The track's ceiling sets the road speed, and the reverse gear takes a share of it.
        let ahead = held.settled(0.0).velocity.x;
        assert!(ahead <= top && ahead > top - 0.02, "{ahead} against {top}");
        held.facing = -1.0;
        let backing = held.settled(0.0).velocity.x;
        assert!((backing - REVERSE_SHARE * top).abs() < 0.01 * REVERSE_SHARE * top, "{backing}");
        // Below it, starting off and climbing, the ceiling takes no pull away.
        free.powertrain.geared_speed = None;
        held.facing = 1.0;
        for speed in [0.0, 2.0, top * 0.8] {
            assert_eq!(held.at(speed, 1.0).velocity.x, free.at(speed, 1.0).velocity.x, "{speed}");
        }
        let climb = |rig: &mut Rig, speed: f64| {
            let mut drive = rig.drive(speed, 1.0);
            drive.drive(1.0 / 60.0, &rig.damage, &rig.geometry, &rig.terrain, &mut rig.gears, &rig.powertrain, rig.facing, 0.0, Hitch::Free);
            assert!(drive.traction > 0.0 && drive.ground_slope > 0.05, "{} {}", drive.traction, drive.ground_slope);
            (drive.velocity.x, drive.velocity.y)
        };
        let (mut free, mut held) = (free.on(ground("soil", 0.2), 20.0), held.on(ground("soil", 0.2), 20.0));
        for speed in [0.0, 2.0] {
            assert_eq!(climb(&mut held, speed), climb(&mut free, speed), "{speed}");
        }
    }
    #[test]
    fn a_light_vehicle_at_its_gear_ceiling_burns_what_holding_that_speed_costs() {
        let mut rig = Rig::tracked(4000.0);
        let p = rig.powertrain;
        let cruising = rig.settled(0.0);
        let ceiling = p.geared_speed.unwrap();
        assert!(cruising.velocity.x < ceiling && cruising.velocity.x > ceiling - 0.02, "{}", cruising.velocity.x);
        let holding = rig.holding_kw(&cruising, ceiling);
        assert!((cruising.engine_kw - holding).abs() < holding * 1e-3, "{} against {holding}", cruising.engine_kw);
        assert!(cruising.engine_kw < p.power_kw * 0.4, "well under the installed power: {}", cruising.engine_kw);
        let full = fuel_flow(p.power_kw, p.power_kw);
        assert!(fuel_flow(cruising.engine_kw, p.power_kw) < full * 0.45);
        let range = p.fuel_litres / fuel_flow(cruising.engine_kw, p.power_kw) * cruising.velocity.x * 3.6;
        assert!((range - p.range_km).abs() < p.range_km * 0.005,
            "the track-limited cruise burns the projected range: {range} against {}", p.range_km);
    }
    #[test]
    fn a_power_limited_vehicle_at_its_top_speed_burns_the_full_flow() {
        let mut rig = Rig::new(60000.0);
        let p = rig.powertrain;
        let top = rig.settled(p.max_speed);
        assert!(top.velocity.x > 1.0 && top.velocity.x < p.max_speed * 1.01, "{}", top.velocity.x);
        // There all the power holds rolling and drag, and the engine gives all of it.
        let holding = rig.holding_kw(&top, top.velocity.x);
        assert!((holding - p.power_kw).abs() < p.power_kw * 1e-3, "{holding}");
        assert!((top.engine_kw - p.power_kw).abs() < 1e-9, "{}", top.engine_kw);
        assert!((fuel_flow(top.engine_kw, p.power_kw) - 1.04 * p.power_kw * 0.25 / 0.835).abs() < 1e-9);
        let range = p.fuel_litres / fuel_flow(top.engine_kw, p.power_kw) * top.velocity.x * 3.6;
        assert!((range - p.range_km).abs() < p.range_km * 0.005,
            "the power-limited cruise burns the projected range: {range} against {}", p.range_km);
    }
    #[test]
    fn faster_than_the_gear_ceiling_a_held_key_only_keeps_the_engine_turning() {
        let mut rig = Rig::tracked(4000.0);
        let p = rig.powertrain;
        // The same rig with an engine that gives nothing: the key held, it only rolls.
        let mut dead = Rig::tracked(4000.0);
        dead.powertrain.power_kw = 0.0;
        let ceiling = p.geared_speed.unwrap();
        for (speed, throttle) in [(ceiling + 8.0, 1.0), (-ceiling - 8.0, -1.0)] {
            let rolling = rig.at(speed, throttle);
            assert_eq!(rolling.engine_kw, 0.0);
            assert_eq!(rolling.velocity.x, dead.at(speed, throttle).velocity.x);
            assert!(rolling.velocity.x.abs() > rig.at(speed, 0.0).velocity.x.abs(), "let go, it brakes");
            assert!((fuel_flow(rolling.engine_kw, p.power_kw) - 0.04 * p.power_kw * 0.25 / 0.835).abs() < 1e-12);
        }
    }
    #[test]
    fn unpowered_drive_dissipates_speed() {
        let mut damage = DamageState::default();
        damage.insert_module(module(1, "wheel", 0.0, 0.37));
        let m = &damage.modules[0];
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 1, EntityKind::Module, &m.to_value()).unwrap(),
        );
        let mut gears = vec![GearState::from_value(1, &Value::Null)];
        let terrain = Terrain::new("flat").unwrap();
        let mut drive =
            DriveState::from_value(1, &json!({"mass":1000,"vx":8,"throttle":1,"grounded":true}));
        drive.drive(
            1.0 / 60.0,
            &damage,
            &geometry,
            &terrain,
            &mut gears,
            &Powertrain {
                drag: 2.0,
                ..Default::default()
            },
            1.0,
            0.0,
            Hitch::Free,
        );
        assert!(drive.velocity.x < 8.0);
        assert!(drive.velocity.x > 0.0);
    }
    #[test]
    fn paused_servo_changes_only_target() {
        let mut m = module(1, "weapon", 0.0, 2.0);
        let before = m.barrel_angle;
        let mut servo = ServoState::from_value(1, &m.to_value(), BarrelState::default());
        assert!(!advance_servo(&mut servo, &mut m, 0.25, 0.0));
        assert_eq!(m.barrel_angle, before);
        assert_ne!(servo.target, before);
    }
    #[test]
    fn servo_has_bounded_rate_without_overshoot_or_contact_state() {
        let mut m = module(1, "weapon", 0.0, 1.0);
        m.barrel_angle = 0.0;
        let mut servo = ServoState::from_value(1, &m.to_value(), BarrelState::default());
        let limit = ServoProfile::from_module(&m).max_speed;
        assert!(advance_servo(&mut servo, &mut m, PI / 2.0, 0.1));
        assert!((m.barrel_angle - limit * 0.1).abs() < 1e-12);
        for _ in 0..60 { advance_servo(&mut servo, &mut m, PI / 2.0, 0.1); }
        assert!((m.barrel_angle - m.mount.as_ref().unwrap().max).abs() < 1e-12);
        assert_eq!(servo.velocity, 0.0);
        assert!(servo.to_value().get("servoBlocked").is_none());
    }
    #[test]
    fn disabled_servo_does_not_rotate() {
        let mut m = module(1, "weapon", 0.0, 1.0);
        m.health = 0.0;
        let before = m.barrel_angle;
        let mut servo = ServoState::from_value(1, &m.to_value(), BarrelState::default());
        assert!(!advance_servo(&mut servo, &mut m, 0.0, 0.1));
        assert_eq!(m.barrel_angle, before);
    }
}
