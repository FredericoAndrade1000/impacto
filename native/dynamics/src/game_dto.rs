//! The vehicle projection shared by cold snapshots, live frames and host types.
//! These views contain scalars and borrowed points, with no JSON Value tree in the live path.
use crate::game_geometry::{Point, SurfaceKind};
use crate::game_motion::{DriveState, Powertrain, Stuck};
use serde::Serialize;

#[derive(Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativePowertrain {
    power_kw: f64,
    torque_nm: f64,
    efficiency: f64,
    rolling_coefficient: f64,
    drag: f64,
    drag_astern: f64,
    drag_over: f64,
    drag_under: f64,
    radius: f64,
    max_drive_force: f64,
    geared_speed: Option<f64>,
    max_speed: f64,
    power_per_tonne: f64,
    fueled: bool,
    fuel_litres: f64,
    range_km: f64,
    fuel_starved: bool,
    tracked: bool,
}
impl From<&Powertrain> for NativePowertrain {
    fn from(p: &Powertrain) -> Self {
        Self {
            power_kw: p.power_kw,
            torque_nm: p.torque_nm,
            efficiency: p.efficiency,
            rolling_coefficient: p.rolling_coefficient,
            drag: p.drag,
            drag_astern: p.drag_astern,
            drag_over: p.drag_over,
            drag_under: p.drag_under,
            radius: p.radius,
            max_drive_force: p.max_drive_force,
            geared_speed: p.geared_speed,
            max_speed: p.max_speed,
            power_per_tonne: p.power_per_tonne,
            fueled: p.fueled,
            fuel_litres: p.fuel_litres,
            range_km: p.range_km,
            fuel_starved: p.fuel_starved,
            tracked: p.tracked,
        }
    }
}

#[derive(Serialize)]
#[cfg_attr(feature = "typegen", derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeVehicle<'a> {
    x: f64,
    y: f64,
    angle: f64,
    enabled: bool,
    mass: f64,
    mass_tonnes: f64,
    inertia: f64,
    carrier_mass: f64,
    carrier_inertia: f64,
    local_center: &'a Point,
    carrier_center: &'a Point,
    max_speed: f64,
    power_kw: f64,
    power_per_tonne: f64,
    fuel_starved: bool,
    fuel_litres: f64,
    vx: f64,
    vy: f64,
    omega: f64,
    travel: f64,
    engine: bool,
    throttle: f64,
    brake: f64,
    traction: f64,
    gear_count: u32,
    suspension_count: u32,
    drive_speed: f64,
    ground_slope: f64,
    ground_surface: Option<&'static str>,
    ground_grip: f64,
    ground_load: f64,
    ground_pressure_k_pa: f64,
    ground_resistance: f64,
    soft_ground_load: f64,
    last_impulse: f64,
    peak_impulse: f64,
    fuel_rate: f64,
    slip: f64,
    slipped: f64,
    stuck: Option<&'static str>,
    rise: f64,
    flying: bool,
    grounded: bool,
    thrust_n: f64,
    station: (Option<f64>, Option<f64>),
    drivetrain: NativePowertrain,
}
impl<'a> NativeVehicle<'a> {
    pub(crate) fn new(d: &'a DriveState, p: &Powertrain) -> Self {
        Self {
            x: d.pose.x,
            y: d.pose.y,
            angle: d.pose.angle,
            enabled: d.enabled,
            mass: d.mass,
            mass_tonnes: d.mass / 1000.0,
            inertia: d.inertia,
            carrier_mass: d.carrier_mass,
            carrier_inertia: d.carrier_inertia,
            local_center: &d.local_center,
            carrier_center: &d.carrier_center,
            max_speed: p.max_speed,
            power_kw: p.power_kw,
            power_per_tonne: p.power_per_tonne,
            fuel_starved: p.fuel_starved,
            fuel_litres: p.fuel_litres,
            vx: d.velocity.x,
            vy: d.velocity.y,
            omega: d.omega,
            travel: d.travel,
            engine: p.power_kw > 0.0,
            throttle: d.throttle,
            brake: d.brake,
            traction: d.traction,
            gear_count: d.gear_count,
            suspension_count: 0,
            drive_speed: d.drive_speed,
            ground_slope: d.ground_slope,
            ground_surface: d.mobility.surface.map(SurfaceKind::name),
            ground_grip: d.mobility.grip,
            ground_load: d.ground_load(),
            ground_pressure_k_pa: d.mobility.pressure_kpa,
            ground_resistance: d.mobility.rolling,
            soft_ground_load: d.mobility.softness,
            last_impulse: d.last_impulse,
            peak_impulse: d.peak_impulse,
            fuel_rate: d.fuel_rate,
            slip: d.slip,
            slipped: d.slipped,
            stuck: d.stuck.map(Stuck::name),
            rise: d.rise,
            flying: d.flying,
            grounded: d.grounded,
            thrust_n: d.thrust_n,
            station: d.station,
            drivetrain: NativePowertrain::from(p),
        }
    }
}

/// How many numbers a vehicle is told in (`NativeVehicle::numbers`), drivetrain included.
pub(crate) const VEHICLE_NUMBERS: usize = 39 + 19;
/// An optional number as two: whether it is there, then the number or 0.
fn optional(out: &mut Vec<f64>, value: Option<f64>) {
    out.push(if value.is_some() { 1.0 } else { 0.0 });
    out.push(value.unwrap_or(0.0));
}
fn flag(value: bool) -> f64 {
    if value { 1.0 } else { 0.0 }
}
/// The words of a vehicle that are no numbers: the ground it stands on and what holds it, by name.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct VehicleWords {
    ground_surface: Option<&'static str>,
    stuck: Option<&'static str>,
}
impl NativeVehicle<'_> {
    /// The numbers of a live frame's vehicle, in the order the host reads them (rust-game.ts
    /// `VEHICLE_NUMBERS`): what it reads of a vehicle but its two names (`words`), and the
    /// summaries it takes from the drivetrain instead.
    pub(crate) fn numbers(&self, out: &mut Vec<f64>) {
        out.extend([self.x, self.y, self.angle, flag(self.enabled), self.mass_tonnes, self.carrier_mass, self.carrier_inertia,
            self.local_center.x, self.local_center.y, self.carrier_center.x, self.carrier_center.y,
            self.vx, self.vy, self.omega, self.travel, self.throttle, self.brake, self.traction,
            self.gear_count as f64, self.suspension_count as f64, self.drive_speed, self.ground_slope, self.ground_grip,
            self.ground_load, self.ground_pressure_k_pa, self.ground_resistance, self.soft_ground_load,
            self.last_impulse, self.peak_impulse, self.fuel_rate, self.slip, self.rise, flag(self.flying), flag(self.grounded),
            self.thrust_n]);
        optional(out, self.station.0);
        optional(out, self.station.1);
        let p = &self.drivetrain;
        out.extend([p.power_kw, p.torque_nm, p.efficiency, p.rolling_coefficient, p.drag, p.drag_astern, p.drag_over,
            p.drag_under, p.radius, p.max_drive_force]);
        optional(out, p.geared_speed);
        out.extend([p.max_speed, p.power_per_tonne, flag(p.fueled), p.fuel_litres, p.range_km, flag(p.fuel_starved), flag(p.tracked)]);
    }
    pub(crate) fn words(&self) -> VehicleWords {
        VehicleWords { ground_surface: self.ground_surface, stuck: self.stuck }
    }
}

#[cfg(feature = "typegen")]
pub(crate) fn typescript_contract() -> String {
    use ts_rs::{Config, TS};
    let config = Config::default();
    format!(
        "// Generated by the Rust vehicle DTOs. Run npm run generate:native-contract.\n\nexport {}\n\nexport {}\n\nexport {}\n",
        Point::decl(&config),
        NativePowertrain::decl(&config),
        NativeVehicle::decl(&config)
    )
}
