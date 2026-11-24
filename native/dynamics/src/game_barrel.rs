//! The temperature of a gun's barrel: a lump of steel that each round heats by what its manual allows of it, and that
//! the air cools by convection, natural and of the wind of its own motion, and by radiation.
use crate::game_flight::{GRAVITY, air_density, required};
use crate::game_geometry::sqrt;
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How a barrel's steel gives off heat as light: measured by infrared on a machine-gun barrel (ARDEC, ADA434693).
pub const EMISSIVITY: f64 = 0.95;
const STEFAN: f64 = 5.670374419e-8;
const PRANDTL: f64 = 0.71;
/// The density of gun steel, kg/m³: what makes a barrel of its mass and length as thick as it is about its bore.
const STEEL_DENSITY: f64 = 7830.0;
/// How many degrees under its limit a barrel a pilot waits on is to cool before it fires again.
pub const RESUME: f64 = 10.0;
/// The temperature, °C, from which a barrel throws its rounds wider, and by how much more it takes to throw them twice as
/// wide; at most two and a half times as wide.
pub const SPREAD_FROM: f64 = 200.0;
pub const SPREAD_SPAN: f64 = 300.0;
/// The temperature, °C, at which a barrel gives way, as rifle barrels fired to destruction ruptured at 870 °C (Rock
/// Island Arsenal, ADA317929); a round fired from one cooler takes e times less of it for each `WEAR_SCALE` degrees,
/// and nothing a field would see below `WEAR_FROM`.
pub const FAIL: f64 = 870.0;
pub const WEAR_SCALE: f64 = 25.0;
pub const WEAR_FROM: f64 = 500.0;

/// The air about a barrel: how warm (°C) and dense (kg/m³) it is, and how fast it blows past (m/s).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Air { pub temperature: f64, pub density: f64, pub speed: f64 }
impl Air {
    /// The still air `altitude` metres over sea level, as warm as the standard atmosphere has it, with the barrel going
    /// through it at `speed`.
    pub fn at(altitude: f64, speed: f64) -> Self {
        Self { temperature: 15.0 - 0.0065 * altitude.clamp(-1000.0, 11000.0), density: air_density(altitude), speed }
    }
}

/// The specific heat of steel at `temperature` °C, J/(kg·K) (EN 1993-1-2, 3.4.1.2): it rises, and peaks at 735 °C where
/// the steel changes its crystal.
pub fn steel_heat(temperature: f64) -> f64 {
    let t = temperature.clamp(20.0, 1200.0);
    if t < 600.0 { 425.0 + 0.773 * t - 1.69e-3 * t * t + 2.22e-6 * t * t * t }
    else if t < 735.0 { 666.0 + 13002.0 / (738.0 - t) }
    else if t < 900.0 { 545.0 + 17820.0 / (t - 731.0) }
    else { 650.0 }
}

/// The steel of a gun's barrel (the catalogue's `steel`): its mass and length, how thick that makes it about its bore,
/// the temperature its manual has it held under (`limitC`), and the heat a round of each kind it fires leaves in it at
/// its full charge (`heatJ`, and a round's own under `rounds`). A gun that turns several barrels (`barrels`) has that
/// mass among them: a round heats the one it is fired from, the next the next, so all of them warm as one, each of its
/// share of the steel and each giving the air its heat. A gun the catalogue gives no steel heats not at all.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BarrelSteel {
    pub mass: f64,
    pub outer: f64,
    pub area: f64,
    pub limit: f64,
    pub rounds: Vec<(String, f64)>,
}
impl BarrelSteel {
    pub fn from_catalogue(source: &Value) -> Result<Self, String> {
        let Some(steel) = source.get("steel").filter(|steel| !steel.is_null()) else { return Ok(Self::default()); };
        let (mass, length, limit, heat) = (required(steel, "massKg")?, required(steel, "lengthM")?, required(steel, "limitC")?, required(steel, "heatJ")?);
        let bore = required(source, "caliberMm")? / 1000.0;
        let barrels = steel.get("barrels").map_or(Some(1), Value::as_u64).filter(|n| (1..=12).contains(n)).ok_or("Invalid barrel steel")? as f64;
        if !(mass > 0.0 && length > 0.0 && bore > 0.0 && heat >= 0.0 && limit > 0.0 && mass.is_finite() && length.is_finite() && heat.is_finite()) {
            return Err("Invalid barrel steel".into());
        }
        // A tube of its share of that mass and length about its bore is as thick as this.
        let outer = sqrt(4.0 * mass / barrels / (std::f64::consts::PI * STEEL_DENSITY * length) + bore * bore);
        let mut rounds = vec![(String::new(), heat)];
        if let Some(own) = source.get("rounds").and_then(Value::as_object) {
            for (id, round) in own {
                let Some(joules) = round.get("heatJ").and_then(Value::as_f64) else { continue };
                if !(joules.is_finite() && joules >= 0.0) { return Err("Invalid barrel heat of a round".into()); }
                rounds.push((id.clone(), joules));
            }
        }
        Ok(Self { mass, outer, area: barrels * std::f64::consts::PI * outer * length, limit, rounds })
    }
    pub fn heats(&self) -> bool { self.mass > 0.0 }
    /// The heat a round of `ammo` leaves in the barrel at `charge` of its full propellant, J.
    pub fn round(&self, ammo: &str, charge: f64) -> f64 {
        let full = self.rounds.iter().find(|(id, _)| id == ammo).or(self.rounds.first()).map_or(0.0, |(_, joules)| *joules);
        full * charge.clamp(0.0, 1.0)
    }
    /// How much heat the steel holds for each degree at `temperature`, J/K.
    pub fn capacity(&self, temperature: f64) -> f64 { self.mass * steel_heat(temperature) }
    /// What the steel at `temperature` gives the air, W: by convection, natural (Churchill and Chu, of a cylinder lying
    /// across) and forced (Churchill and Bernstein), mixed as Churchill has them, and by radiation.
    pub fn losing(&self, temperature: f64, air: Air) -> f64 {
        let (steel, around) = (temperature + 273.15, air.temperature + 273.15);
        let film = 0.5 * (steel + around);
        // The air at the film between them: thinner as it is warmer, its viscosity and conductivity by Sutherland's laws.
        let density = air.density * around / film;
        let viscosity = 1.458e-6 * film * sqrt(film) / (film + 110.4);
        let ratio = film / 273.15;
        let conductivity = 0.02414 * ratio * sqrt(ratio) * (273.15 + 194.0) / (film + 194.0);
        let kinematic = viscosity / density;
        let rayleigh = GRAVITY * (steel - around).abs() * self.outer * self.outer * self.outer * PRANDTL / (film * kinematic * kinematic);
        let natural = 0.60 + 0.32128 * ComplexField::powf(rayleigh, 1.0 / 6.0);
        let natural = natural * natural;
        let forced = if air.speed > 0.05 {
            let reynolds = air.speed * self.outer / kinematic;
            0.3 + 0.48567 * sqrt(reynolds) * ComplexField::powf(1.0 + ComplexField::powf(reynolds / 282000.0, 0.625), 0.8)
        } else { 0.0 };
        let nusselt = ComplexField::powf(natural * natural * natural + forced * forced * forced, 1.0 / 3.0);
        let convection = nusselt * conductivity / self.outer;
        let (steel2, around2) = (steel * steel, around * around);
        self.area * (convection * (steel - around) + EMISSIVITY * STEFAN * (steel2 * steel2 - around2 * around2))
    }
    /// How much wider a round goes from a barrel at `temperature` than from a cold one.
    pub fn spread(temperature: f64) -> f64 { 1.0 + ((temperature - SPREAD_FROM) / SPREAD_SPAN).clamp(0.0, 1.5) }
    /// What a round takes of a barrel at `temperature`, as a share of the wear that disables it: all of it at `FAIL`.
    pub fn wear(temperature: f64) -> f64 {
        if temperature <= WEAR_FROM { 0.0 } else { ComplexField::exp((temperature - FAIL) / WEAR_SCALE) }
    }
}

/// The temperature of a barrel and its pilot's patience with it, as a servo carries them (game_motion.rs `ServoState`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct BarrelState {
    pub temperature: f64,
    pub cooling: bool,
    pub steel: BarrelSteel,
}
impl BarrelState {
    /// A barrel as a construction brings it, at the temperature it was kept at, or as warm as the air about it.
    pub fn new(steel: BarrelSteel, kept: &Value, air: Air) -> Self {
        let temperature = kept.get("barrelTemperature").and_then(Value::as_f64).filter(|t| t.is_finite() && steel.heats())
            .unwrap_or(air.temperature);
        let cooling = steel.heats() && temperature > steel.limit - RESUME && kept.get("barrelCooling") == Some(&Value::Bool(true));
        Self { temperature, cooling, steel }
    }
    /// A step of `dt` seconds in `air`: the steel gives it heat, or takes some, toward its temperature; within a
    /// twentieth of a degree it is as warm as the air. A pilot waiting on it fires again once it is cool enough.
    pub fn air(&mut self, air: Air, dt: f64) {
        if !self.steel.heats() || (self.temperature - air.temperature).abs() < 0.05 { self.temperature = air.temperature; }
        else { self.temperature -= self.steel.losing(self.temperature, air) * dt / self.steel.capacity(self.temperature); }
        if self.cooling && self.temperature <= self.steel.limit - RESUME { self.cooling = false; }
    }
    /// A round of `ammo` fired at `charge`: what it wore of the barrel (a share of the wear that disables it), at the
    /// temperature it went out at, and the heat it leaves.
    pub fn fired(&mut self, ammo: &str, charge: f64) -> f64 {
        if !self.steel.heats() { return 0.0; }
        let worn = BarrelSteel::wear(self.temperature);
        self.temperature += self.steel.round(ammo, charge) / self.steel.capacity(self.temperature);
        if self.temperature >= self.steel.limit { self.cooling = true; }
        worn
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const STEP: f64 = 1.0 / 60.0;
    fn barrel(preset: &str) -> BarrelState {
        let steel = BarrelSteel::from_catalogue(&crate::game_damage::fixtures::catalogue()[preset]).unwrap();
        BarrelState::new(steel, &json!({}), Air::at(0.0, 0.0))
    }
    /// A barrel fired by a table of the manual, `(rounds a minute, seconds)` one after another, a step at a time as the
    /// game steps it: its temperature at the end of each.
    fn fire(barrel: &mut BarrelState, table: &[(f64, f64)]) -> Vec<f64> {
        let air = Air::at(0.0, 0.0);
        table.iter().map(|&(rate, seconds)| {
            let mut next = 0.0;
            for step in 0..(seconds / STEP).round() as usize {
                barrel.air(air, STEP);
                if rate > 0.0 && step as f64 * STEP + 1e-9 >= next { barrel.fired("", 1.0); next += 60.0 / rate; }
            }
            barrel.temperature
        }).collect()
    }
    #[test]
    fn a_barrel_comes_where_the_manuals_tables_take_it() {
        let near = |found: f64, wanted: f64, by: f64, what: &str| assert!((found - wanted).abs() <= by, "{what}: {found:.0} °C, not {wanted} ± {by}");
        // FM 3-22.68: 200 rounds in 2 minutes make a hot gun, where ball powder ignites by itself.
        for preset in ["minimi", "fnmag"] { near(fire(&mut barrel(preset), &[(100.0, 120.0)])[0], 195.0, 15.0, preset); }
        // Its barrel changes, sustained for 10 minutes, rapid for 2 and cyclic for 1, come about the limit of an automatic gun.
        let changes: Vec<f64> = ["minimi", "fnmag"].iter().flat_map(|preset| [(100.0, 600.0), (200.0, 120.0), (800.0, 60.0)].iter()
            .map(move |&point| fire(&mut barrel(preset), &[point])[0])).collect();
        near(changes.iter().sum::<f64>() / changes.len() as f64, 500.0, 25.0, "the barrel changes of FM 3-22.68");
        // TC 3-22.50: the M2's barrel changed after an hour of rapid fire.
        near(fire(&mut barrel("m2hb"), &[(60.0, 3600.0)])[0], 500.0, 20.0, "an hour of the M2 at 60 a minute");
        // FM 23-90 and the howitzers' tables bring their tubes to the red line of a tube thermometer.
        near(fire(&mut barrel("m224"), &[(30.0, 240.0)])[0], 182.0, 8.0, "M224");
        near(fire(&mut barrel("m252"), &[(30.0, 120.0)])[0], 182.0, 8.0, "M252");
        near(fire(&mut barrel("m119"), &[(3.0, 1800.0)])[0], 182.0, 8.0, "M119");
        near(*fire(&mut barrel("m777"), &[(4.0, 180.0), (2.0, 1800.0)]).last().unwrap(), 182.0, 8.0, "M777");
        // A tank gun's load of forty rounds, at its loader's six a minute, does not bring it there.
        assert!(fire(&mut barrel("rh120"), &[(6.0, 400.0)])[0] < 150.0);
        // A launcher heats not at all.
        for preset in ["at4", "carlgustaf", "hydra70"] {
            let mut tube = barrel(preset);
            assert!(!tube.steel.heats(), "{preset}");
            assert_eq!(fire(&mut tube, &[(6.0, 60.0)])[0], Air::at(0.0, 0.0).temperature, "{preset}");
        }
    }
    #[test]
    fn the_air_takes_more_of_a_hotter_barrel_of_one_going_faster_and_warms_one_colder_than_it() {
        let steel = barrel("fnmag").steel;
        let still = Air::at(0.0, 0.0);
        assert!(steel.losing(400.0, still) > steel.losing(200.0, still) && steel.losing(200.0, still) > 0.0);
        assert!(steel.losing(200.0, Air::at(0.0, 20.0)) > 2.0 * steel.losing(200.0, still), "the wind of 72 km/h");
        assert!(steel.losing(-20.0, still) < 0.0, "a barrel colder than the air takes heat from it");
        // The air is colder and thinner up high, as the standard atmosphere has it.
        let high = Air::at(3000.0, 0.0);
        assert!((high.temperature - -4.5).abs() < 1e-9 && high.density < still.density);
        // The steel holds most heat where it changes its crystal.
        assert!((steel_heat(735.0) - 5000.0).abs() < 1e-6 && steel_heat(20.0) < steel_heat(400.0));
        // Of its mass and length about its bore, the MAG's barrel is 29 mm across.
        assert!((steel.outer - 0.0291).abs() < 5e-4, "{}", steel.outer);
    }
    #[test]
    fn a_barrel_heats_by_its_rounds_holds_its_pilot_at_its_limit_and_cools_back_to_the_air() {
        let air = Air::at(0.0, 0.0);
        let mut gun = barrel("fnmag");
        assert_eq!((gun.temperature, gun.cooling), (15.0, false));
        let capacity = gun.steel.capacity(15.0);
        assert_eq!(gun.fired("", 1.0), 0.0);
        assert_eq!(gun.temperature, 15.0 + 1430.0 / capacity);
        // A round of another kind leaves its own heat, and a lighter charge less of it.
        let cannon = barrel("mk44");
        assert_eq!((cannon.steel.round("apfsds", 1.0), cannon.steel.round("he", 1.0), cannon.steel.round("he", 0.5)), (22400.0, 20400.0, 10200.0));
        // At its limit a pilot holds its fire, until it is ten degrees cooler.
        gun.temperature = 499.9;
        gun.fired("", 1.0);
        assert!(gun.cooling);
        let mut seconds = 0.0;
        while gun.cooling { gun.air(air, STEP); seconds += STEP; }
        assert!(gun.temperature <= 490.0 && (5.0..30.0).contains(&seconds), "{seconds} s to cool ten degrees");
        // Kept and brought back, it is as hot and its pilot as patient; left alone, it comes back to the air.
        let kept = json!({"barrelTemperature": 495.0, "barrelCooling": true});
        let back = BarrelState::new(gun.steel.clone(), &kept, air);
        assert_eq!((back.temperature, back.cooling), (495.0, true));
        for _ in 0..(3.0 * 3600.0 / STEP) as usize { gun.air(air, STEP); }
        assert!(gun.temperature < 20.0, "three hours on, {} °C", gun.temperature);
        let mut steps = 0;
        while gun.temperature != air.temperature && steps < 86400 * 60 { gun.air(air, STEP); steps += 1; }
        assert_eq!(gun.temperature, air.temperature);
        // A hot barrel throws wider and wears; at 870 °C one round takes the rest of it.
        assert_eq!((BarrelSteel::spread(200.0), BarrelSteel::spread(500.0), BarrelSteel::spread(2000.0)), (1.0, 2.0, 2.5));
        assert_eq!((BarrelSteel::wear(500.0), BarrelSteel::wear(870.0)), (0.0, 1.0));
        assert!(BarrelSteel::wear(700.0) < 0.002, "a rifle barrel lasts some three hundred rounds from 500 to 870 °C");
        // Steel that cannot be is refused.
        for steel in [json!({"massKg":0,"lengthM":1,"limitC":500,"heatJ":1}), json!({"massKg":1,"lengthM":1,"limitC":500,"heatJ":-1})] {
            assert!(BarrelSteel::from_catalogue(&json!({"caliberMm":7.62,"steel":steel})).is_err());
        }
    }
}
