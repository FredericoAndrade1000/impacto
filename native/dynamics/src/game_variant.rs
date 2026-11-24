//! The one gun of the workshop: made from a real gun of the catalogue, its reference, with whatever the player changes of
//! it — its barrel, its calibre, its charge, its projectile, its rate, how many barrels turn and how many rounds it holds
//! loaded — and what the physics of guns makes of that (`derive`). What it is follows from what it became (`kind`): a
//! reference bored out to 20 mm is an autocannon, and fires, aims and is mounted as one. It is named by its reference and
//! what was changed of it, in a set order and only what differs (`m2hb|L140|N3`): the name every part of the game keeps it
//! by, which the catalogue holds once it was asked for (`ensure`). Its rounds are named by the reference and what changed of
//! the round alone (`cartridge`): a longer barrel, more barrels, another rate or feed fire the very rounds of the gun it
//! came from; another calibre, charge or projectile, or a round made otherwise — its penetrator, its shaped charge's cone
//! and standoff, its shell's explosive (`made`) —, rounds of its own.
//!
//! The reference carries what the physics leaves to the design of each gun — its powder, its shape, its mechanism — and
//! each change is reckoned from it, so that a reference is exactly the gun it is and each change acts as it would on it.
use crate::game_barrel::{Air, BarrelSteel};
use crate::game_flight::{Drag, farthest, required};
use crate::game_construction::{RECEIVER_HEIGHT, RECEIVER_LENGTH, RECOIL};
use crate::game_geometry::{BARREL_RADIUS, BARREL_REACH, exp_m1, sin, sqrt};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::f64::consts::PI;

/// The ratio of the specific heats of a gun's powder gas as it expands down the bore, 1.264 for M1 propellant (BRL Report
/// 1183, 1962): the work it does on the round is the share 1 − (V₀/V)^(γ−1) of what it could, V₀ the chamber and V the
/// chamber and the bore behind the round as it leaves. So reckoned, barrels cut shorter or made longer give the speeds
/// measured within 1–2 %: 7.62 × 51 mm from 28 to 16.5 in (rifleshooter.com, 2014), the M33 from 45 to 36 in (General
/// Dynamics, NDIA 2011), the 120 mm DM53 from L/44 to L/55.
pub const GAMMA: f64 = 1.25;
/// How much powder a cartridge may hold, as a share of its reference's (scaled to its calibre): from half to half again,
/// its case as much smaller or larger; in steps of 5 %.
pub const CHARGE: (u32, u32, u32) = (50, 150, 5);
/// How heavy its projectile, as a share of its reference's (scaled to its calibre): from half to twice, as much shorter or
/// longer; in steps of 5 %.
pub const PROJECTILE: (u32, u32, u32) = (50, 200, 5);
/// How fast a gun that fires by itself is set to fire, as a share of the most its mechanism gives: down to a quarter.
pub const RATE: (u32, u32, u32) = (25, 100, 5);
/// The calibres a gun may be bored to, mm: from the smallest rifle round to the heaviest howitzer.
pub const CALIBRE_MM: (f64, f64) = (5.0, 210.0);
/// How long a barrel may be, in calibres: from a short mortar's 8 to a machine gun's 110 (the Minimi's is 94, the M2's 90).
pub const SLENDERNESS: (f64, f64) = (8.0, 110.0);
/// The calibres in common use, mm, which the workshop steps through; any other may be typed.
pub const CALIBRES: &[f64] = &[5.45, 5.56, 6.5, 7.62, 9.0, 12.7, 14.5, 20.0, 23.0, 25.0, 27.0, 30.0, 35.0, 40.0, 45.0, 50.0,
    57.0, 60.0, 75.0, 76.0, 81.0, 82.0, 90.0, 100.0, 105.0, 107.0, 115.0, 120.0, 122.0, 125.0, 130.0, 140.0, 152.0, 155.0,
    175.0, 203.0];
/// The peak pressure of a charge over the mean that does the work on the round, the piezometric ratio: some 2.6 for the
/// guns of the catalogue, whose mean pressures come from their muzzle energies and bores, against the maximum operating
/// pressures published for their rounds (.50 BMG 379 MPa, 120 mm 710 MPa).
pub const PIEZOMETRIC: f64 = 2.6;
/// The most pressure a chamber of gun steel is made for, Pa: no service gun runs past some 900 MPa.
pub const MOST_PRESSURE: f64 = 900.0e6;
/// What the wall of a barrel is made to bear at its bore, Pa: gun steel of some 1,200 MPa yield, autofrettaged so that its
/// bore bears near that (ASTM A723).
pub const STEEL: f64 = 1200.0e6;
/// The speed of the gas of a charge as it leaves the muzzle, over the round's: it pushes the gun back as much again as it
/// moves (the recoil of small arms and cannon, SAAMI; Carlucci and Jacobson, Ballistics, 2018).
pub const GAS_SPEED: f64 = 1.5;
/// The most barrels a rotary gun turns: seven, as the GAU-8 Avenger.
pub const MOST_BARRELS: u32 = 7;
/// The rounds a minute each barrel of a rotary gun fires, of any calibre: some 600, as the M134 fires 500 to 667 from each
/// of its six, the GAU-19 433 to 667 from each of its three, the M197 500, the GAU-22 825 and the GAU-8 557 to 600 (General
/// Dynamics; NavWeaps).
pub const ROTARY_RATE: f64 = 600.0;
/// What the rotor, its bearings and its drive add for each barrel past the first, as a share of the steel of one: 0.43,
/// what the GAU-19 (62.6 kg, three barrels of 36 in) weighs past the M2's receiver (38.1 kg less its 11.79 kg barrel)
/// and its own barrels (General Dynamics, NDIA 2005; TC 3-22.50).
pub const ROTOR_MASS: f64 = 0.43;
/// A gun of another calibre: its rate by the calibre to the −0.6, as machine guns of 5.56, 7.62 and 12.7 mm fire 850, 800
/// and 525 a minute; and the rest of it, its receiver and its mount, by the square of the calibre, as guns weigh by their
/// muzzle energy to the 0.6 to 0.7 (M240, M2, M242, the 120 mm mount).
pub const RATE_EXPONENT: f64 = -0.6;
pub const MASS_EXPONENT: f64 = 2.0;
/// How long a rotary gun takes to come up to its rate from rest and to stop, s: the M134 in half a second and a quarter
/// (NavWeaps), the GAU-19 in 0.4, the GAU-8 in some 0.46. It fires from the first turn, at a tenth of its rate.
pub const SPIN_UP: f64 = 0.4;
pub const SPIN_DOWN: f64 = 0.25;
pub const SPIN_FLOOR: f64 = 0.1;
/// How much wider a rotary gun throws its rounds for each barrel past the first: its barrels whip as they turn.
pub const ROTARY_SPREAD: f64 = 0.12;
/// What the ready rounds of a gun take of room, as a share of the rounds alone (`cartridge.litres`): a belt in its can and
/// chute, as the M2A1 can of 100 linked rounds of .50 BMG measures 11.75 × 6 × 7.5 in outside, 8.66 L for 6.5 L of rounds
/// (ammoman.com, M2A1 ammo can); an autoloader's magazine with its conveyor and rammer, as the Leclerc's in its bustle,
/// 1.40 × 2.40 × 0.50 m, 1.68 m³ for its 22 rounds of 120 mm, 264 L (GIAT; HandWiki, Leclerc tank).
pub const BELT_BULK: f64 = 1.33;
pub const MAGAZINE_BULK: f64 = 6.4;
/// The longest a compartment of ready rounds reaches behind a gun's receiver, m: as long as the bustle of a turret.
pub const COMPARTMENT_LENGTH: f64 = 3.0;
/// How wide across a belt's can beside a gun's receiver grows, as many times as it is high, once it is as long as the
/// receiver: the 400 rounds of .50 of a CROWS station or an FN HMP400 pod lie beside the M2 (estimate).
pub const BESIDE_WIDTH: f64 = 2.0;
/// What blow-out panels weigh, kg for each m² of a compartment's roof, and the blast door that holds between it and the gun
/// while they give way, kg for each m² of the side it shares with the gun: steel of 10 and 20 mm (estimates; no measure of
/// the Abrams' or the Leclerc's is published). As in the bustles of the Abrams and the Leclerc, the roof of the compartment
/// is panels that give way first, and the blast and fire of its rounds go out through them, not into the construction.
pub const PANEL_STEEL: f64 = 0.010 * 7850.0;
pub const DOOR_STEEL: f64 = 0.020 * 7850.0;

/// What the penetrator of a kinetic round may be made of (`T`, by its place here from 1): hardened steel or a tungsten heavy
/// alloy. Its density, kg/m³: 7,850 (Nammo gives 8 for its steel cores, NDIA 2015) and 17,600, the middle of the ASTM B777
/// classes (16.85–18.85). Its price, credits a kg: steel as the armour of the workshop; tungsten bar at some 130 USD/kg in
/// December 2025 (SMM; Fastmarkets has it up 210 % over 2025), about three times that sintered and machined [E], at the
/// 40–50 USD a credit its rounds are priced at (the M829A4 at 10,100–13,000 USD against the 260 of the Rh-120's) [D]. As a
/// long rod it pierces by Lanz and Odermatt's fit of its tests (`LONG_ROD_TARGET`): `fit` is their a, `strength` their
/// s² times its density, against rolled steel of 270 HB, Pa — (134.5 − 0.148·270)·270 MPa for tungsten, and
/// 9,874·270^0.3598·500^−0.2342 MPa for a steel rod of 500 HB (longrods.ch, perforation equation). No round of the game is
/// of depleted uranium: one of a reference that fires it is told as of tungsten, as dense to a twentieth.
pub struct Core { pub name: &'static str, pub density: f64, pub price: f64, pub fit: f64, pub strength: f64 }
pub const CORES: [Core; 2] = [
    Core { name: "steel", density: 7850.0, price: 1.4, fit: 1.104, strength: 17.27e9 },
    Core { name: "tungsten", density: 17600.0, price: 10.0, fit: 0.994, strength: 25.53e9 },
];
/// What a long rod pierces for its working length, P/L = a·√(ρ/ρ_t)·e^(−s²/v²) (Lanz and Odermatt, 1992; current fit on
/// longrods.ch, within 3.3 % of 99 tests of tungsten and 2.8 % of 40 of steel): its target rolled steel of this density.
/// Rods of the same shape and another material, the rest as it is, pierce as much more as that gives them at the speed each
/// leaves at. Against the published DM33, DM43A1 and M829A1 it comes within 2–10 % [D].
pub const LONG_ROD_TARGET: f64 = 7850.0;
/// What a full-calibre or a sub-calibre round's core pierces, by De Marre (1890; navweaps.com): T ∝ (v·√M / D^0.75)^(1/0.7),
/// its core of the same size and another material as much heavier as its density.
pub const DE_MARRE: f64 = 0.7;
/// The cone of a shaped charge, % of its calibre: from half of it to the most a case of a twenty-fifth of it on either side
/// leaves (Walters, ARL-RP-232, 2008: the Japanese rule of a liner 4/5 of the charge); in steps of 5.
pub const CONE: (u32, u32, u32) = (50, 90, 5);
/// How far before what it strikes a shaped charge bursts, tenths of its cone's diameter: from half a diameter to the
/// 8 of a long probe; in steps of half a diameter.
pub const STANDOFF: (u32, u32, u32) = (5, 80, 5);
/// What a shaped charge's jet pierces of steel, in diameters of its cone, against how far before the target it bursts, in
/// diameters: a copper cone of 45°, the best of those Sandia reckoned and tested (Vigil, SAND88-1790, 1988, table II). The
/// jet forms over the first diameters, and past six it breaks up.
pub const JET: &[(f64, f64)] = &[(0.0, 3.7), (1.0, 4.7), (2.0, 5.2), (3.0, 5.5), (4.0, 5.7), (6.0, 5.7), (8.0, 5.5)];
/// Of a shaped charge's round, the share its warhead weighs and costs, by the cube of its cone: the DM12A1's 1.62 kg of
/// explosive and some 1 kg of liner [E] in its 14.1 kg (120×570 mm NATO).
pub const WARHEAD: f64 = 0.2;
/// What a shell's explosive may be of its weight, %: from the thick case of a 30 mm HEI-T, 8 % (29 g of 357 g, ZVS), to the
/// thin one a gun's setback still lets stand, past the 23 % of the M795; in steps of 1.
pub const FILL: (u32, u32, u32) = (5, 30, 1);
/// The density of a shell's explosive, kg/m³ (TNT, Composition B), and of its steel case; what each costs a kg, credits:
/// explosive some ten times its steel [E].
pub const EXPLOSIVE_DENSITY: f64 = 1650.0;
pub const CASE_DENSITY: f64 = 7850.0;
pub const EXPLOSIVE_PRICE: f64 = 14.0;
pub const CASE_PRICE: f64 = 1.4;

/// What a gun is, by its calibre, its barrel and how fast it fires (AAP-6; US Army ATP 3-09.50, FM 3-22.68):
/// - under 20 mm, a machine gun;
/// - from 20 to under 60 mm, an autocannon, or, firing slower than 400 m/s, a grenade launcher;
/// - from 60 mm, a mortar if its barrel is under 20 calibres and its round slower than 400 m/s; a cannon if its round
///   leaves at 1,000 m/s or more; otherwise a howitzer.
pub fn kind(caliber_mm: f64, slenderness: f64, speed: f64) -> &'static str {
    if caliber_mm < 20.0 { "machinegun" }
    else if caliber_mm < 60.0 { if speed < 400.0 { "grenade" } else { "autocannon" } }
    else if slenderness < 20.0 && speed < 400.0 { "mortar" }
    else if speed >= 1000.0 { "cannon" }
    else { "howitzer" }
}
/// The guns that may turn more than one barrel and be set to fire slower: those that fire by themselves.
fn rotary(family: &str) -> bool { matches!(family, "machinegun" | "autocannon") }
fn automatic(family: &str) -> bool { matches!(family, "machinegun" | "autocannon" | "grenade") }
/// What falls on a place takes its arc by itself: mortars, howitzers and grenade launchers.
fn arcs(family: &str) -> bool { matches!(family, "mortar" | "howitzer" | "grenade") }
/// How a gun is fed: a belt or box of linked rounds the crew changes when it runs out; or, a gun that loads a round at a
/// time, by hand or, holding more than one, by an autoloader the crew fills again.
fn belted(family: &str) -> bool { automatic(family) }

/// The rounds a feed may hold, which the workshop steps through; up to the longest belts and the largest magazines.
const BELTS: &[u32] = &[10, 20, 25, 30, 48, 50, 60, 75, 100, 125, 150, 200, 250, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 4000];
const MAGAZINES: &[u32] = &[1, 2, 3, 4, 5, 6, 8, 10, 12, 14, 15, 16, 18, 20, 21, 22, 24, 28, 30, 32, 40, 48, 60];

/// What was changed of a gun: its barrel's length, cm; its calibre, tenths of a mm; its charge and projectile, % of its
/// reference's at that calibre; what its kinetic round's penetrator is made of (`CORES`); its shaped charge's cone, % of its
/// calibre, and how far before what it strikes it bursts, tenths of the cone's diameter; its shell's explosive, % of its
/// weight; its rate, % of the most its mechanism gives; how many barrels it turns; and how many rounds its feed holds; and
/// whether its compartment has blow-out panels (1, `PANEL_STEEL`). None is what the reference had.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Custom {
    pub length: Option<u32>, pub calibre: Option<u32>, pub charge: Option<u32>, pub projectile: Option<u32>,
    pub core: Option<u32>, pub cone: Option<u32>, pub standoff: Option<u32>, pub fill: Option<u32>,
    pub rate: Option<u32>, pub barrels: Option<u32>, pub magazine: Option<u32>, pub vent: Option<u32>,
}
/// The letters of a name, in its order, and where each change stands in it.
const LETTERS: [&str; 12] = ["L", "D", "C", "P", "T", "O", "S", "E", "R", "N", "M", "V"];
const LENGTH: usize = 0;
const CALIBRE: usize = 1;
const CHARGED: usize = 2;
const PROJECTED: usize = 3;
const CORE: usize = 4;
const CONED: usize = 5;
const STOOD: usize = 6;
const FILLED: usize = 7;
const RATED: usize = 8;
const BARRELS: usize = 9;
const MAGAZINE: usize = 10;
const VENT: usize = 11;
impl Custom {
    fn values(self) -> [Option<u32>; 12] {
        [self.length, self.calibre, self.charge, self.projectile, self.core, self.cone, self.standoff, self.fill,
            self.rate, self.barrels, self.magazine, self.vent]
    }
    fn set(&mut self, order: usize, value: Option<u32>) {
        match order { LENGTH => self.length = value, CALIBRE => self.calibre = value, CHARGED => self.charge = value,
            PROJECTED => self.projectile = value, CORE => self.core = value, CONED => self.cone = value, STOOD => self.standoff = value,
            FILLED => self.fill = value, RATED => self.rate = value, BARRELS => self.barrels = value, MAGAZINE => self.magazine = value,
            _ => self.vent = value }
    }
    /// What of a gun its rounds are: its calibre, its charge, its projectile and how each of its rounds is made.
    pub fn cartridge(self) -> Self {
        Self { calibre: self.calibre, charge: self.charge, projectile: self.projectile, core: self.core, cone: self.cone,
            standoff: self.standoff, fill: self.fill, ..Self::default() }
    }
    pub fn plain(self) -> bool { self == Self::default() }
}

/// The reference and what was changed of it, of a name; a name with nothing changed is its own reference.
pub fn parse(id: &str) -> Result<(&str, Custom), String> {
    let mut parts = id.split('|');
    let base = parts.next().unwrap_or_default();
    let mut custom = Custom::default();
    let mut last = None;
    for part in parts {
        let (letter, digits) = part.split_at(part.len().min(1));
        let order = LETTERS.iter().position(|l| *l == letter);
        if order.is_none() || order <= last || digits.is_empty() || digits.starts_with('0') || !digits.bytes().all(|b| b.is_ascii_digit()) || digits.len() > 5 {
            return Err(format!("Unknown weapon {id}"));
        }
        last = order;
        let value = digits.parse::<u32>().map_err(|_| format!("Unknown weapon {id}"))?;
        custom.set(order.unwrap_or(0), Some(value));
    }
    if base.is_empty() || (id.contains('|') && custom.plain()) { return Err(format!("Unknown weapon {id}")); }
    Ok((base, custom))
}
/// The name of a gun made of `base` with `custom` changed of it.
pub fn name(base: &str, custom: Custom) -> String {
    let mut id = base.to_owned();
    for (letter, value) in LETTERS.iter().zip(custom.values()) {
        if let Some(value) = value { id.push('|'); id.push_str(letter); id.push_str(&value.to_string()); }
    }
    id
}
/// The name of the rounds a gun fires: its reference's, unless its calibre, charge or projectile were changed.
pub fn cartridge(id: &str) -> String {
    match parse(id) { Ok((base, custom)) => name(base, custom.cartridge()), Err(_) => id.to_owned() }
}

fn pow(x: f64, y: f64) -> f64 { ComplexField::powf(x, y) }
fn exp(x: f64) -> f64 { exp_m1(x) + 1.0 }
fn area(caliber_mm: f64) -> f64 { PI * (caliber_mm / 2000.0) * (caliber_mm / 2000.0) }
/// The work the gas of a charge does over a bore, as a share of what it could (`GAMMA`).
fn work(chamber: f64, bore: f64, travel: f64) -> f64 { 1.0 - pow(1.0 + bore * travel / chamber, 1.0 - GAMMA) }
/// The peak pressure a charge makes, Pa: its mean, the energy it gives the round and the third of its own gas that keeps up
/// with it, over the volume the round sweeps, by `PIEZOMETRIC`. It peaks as the round starts down the bore, whatever the
/// length of the barrel after: a gun's is reckoned over its reference's bore, at its calibre.
fn pressure(projectile: f64, propellant: f64, speed: f64, bore: f64, travel: f64) -> f64 {
    PIEZOMETRIC * 0.5 * (projectile + propellant / 3.0) * speed * speed / (bore * travel)
}
/// How thick a wall the pressure needs, as the area of steel about the bore over the bore's: 2P/(σ − P) (Lamé).
fn wall(pressure: f64) -> f64 { 2.0 * pressure / (STEEL - pressure).max(STEEL * 0.05) }
/// How hard the gun is pushed back, N·s: the round and the gas of its charge (`GAS_SPEED`).
fn impulse(projectile: f64, propellant: f64, speed: f64) -> f64 { (projectile + GAS_SPEED * propellant) * speed }

/// The reference as the physics reads it, and as it is drawn: its tube's radius, its receiver's length and height and how
/// far it runs back.
struct Reference {
    family: String, length: f64, caliber: f64, drawn: f64, chamber: f64, travel: f64, propellant: f64, projectile: f64,
    speed: f64, pressure: f64, impulse: f64, rounds: u32, radius: f64, receiver: (f64, f64), recoil: f64, litres: f64,
    flight: f64, design: Design, allowed: Vec<String>, kinds: Map<String, Value>,
}
/// How the reference's rounds are made, as the catalogue states it (`design`): what its kinetic round's penetrator is of
/// (its place in `CORES` from 1) and what share of the round in flight it weighs; its shaped charge's cone, % of its
/// calibre, and how far before the target it bursts, tenths of the cone's diameter; its shell's explosive, % of its weight.
/// None where it fires no such round.
#[derive(Clone, Copy, Default)]
struct Design { core: Option<(u32, f64)>, cone: Option<u32>, standoff: Option<u32>, fill: Option<u32> }
impl Design {
    fn of(base: &Value) -> Self {
        let design = &base["design"];
        let fires = |ammo: &[&str]| base["allowedAmmo"].as_array().is_some_and(|list| list.iter().any(|a| a.as_str().is_some_and(|a| ammo.contains(&a))));
        let whole = |key: &str, (min, max, _): (u32, u32, u32)| design[key].as_u64().filter(|v| (u64::from(min)..=u64::from(max)).contains(v)).map(|v| v as u32);
        let core = design["core"].as_str().and_then(|name| CORES.iter().position(|core| core.name == name))
            .zip(design["coreShare"].as_f64().filter(|share| *share > 0.0 && *share <= 1.0))
            .map(|(place, share)| (place as u32 + 1, share)).filter(|_| fires(&["ap", "apfsds"]));
        let heat = fires(&["heat"]);
        Self { core, cone: whole("cone", CONE).filter(|_| heat), standoff: whole("standoff", STANDOFF).filter(|_| heat),
            fill: whole("fill", FILL).filter(|_| fires(&["he"])) }
    }
}
impl Reference {
    /// The rounds a gun made of it fires, being of `family`: its own, and, where it became another kind, those of them the
    /// catalogue's kinds of gun give that kind (`kinds`) — all its own where that kind takes none of them.
    fn fired(&self, family: &str) -> Vec<String> {
        if family == self.family { return self.allowed.clone(); }
        let taken: Vec<String> = self.allowed.iter().filter(|ammo| self.kinds.get(family)
            .and_then(|kind| kind["allowedAmmo"].as_array()).is_some_and(|list| list.iter().any(|a| a == ammo.as_str()))).cloned().collect();
        if taken.is_empty() { self.allowed.clone() } else { taken }
    }
    /// The reference the catalogue states as `base`, with the kinds of gun it may become (`families`).
    fn of(base: &Value, families: &Value) -> Option<Self> {
        let steel = base.get("steel").filter(|steel| steel.is_object())?;
        let bore = base.get("bore").filter(|bore| bore.is_object())?;
        if !["chamberL", "travelM", "propellantKg", "projectileKg"].iter().all(|key| bore[*key].as_f64().is_some_and(|v| v > 0.0 && v.is_finite())) { return None; }
        let (length, caliber) = (steel["lengthM"].as_f64()?, base["caliberMm"].as_f64()?);
        let (chamber, travel) = (bore["chamberL"].as_f64()? / 1000.0, bore["travelM"].as_f64()?);
        let (propellant, projectile, speed) = (bore["propellantKg"].as_f64()?, bore["projectileKg"].as_f64()?, base["speed"].as_f64()?);
        let rounds = base["feed"]["rounds"].as_u64().map_or(1, |n| n.clamp(1, 4000) as u32);
        let receiver = (base["receiver"]["length"].as_f64()?, base["receiver"]["height"].as_f64()?);
        Some(Self { family: base["family"].as_str()?.to_owned(), length, caliber, drawn: base["barrel"].as_f64()?, chamber, travel,
            propellant, projectile, speed, pressure: pressure(projectile, propellant, speed, area(caliber), travel),
            impulse: impulse(projectile, propellant, speed), rounds, radius: base["barrelRadius"].as_f64()?, receiver,
            recoil: base["recoil"].as_f64().unwrap_or(0.0), litres: base["cartridge"]["litres"].as_f64().unwrap_or(0.0),
            flight: base["mass"].as_f64().filter(|m| *m > 0.0).unwrap_or(projectile), design: Design::of(base),
            allowed: base["allowedAmmo"].as_array().into_iter().flatten().filter_map(Value::as_str).map(str::to_owned).collect(),
            kinds: families.as_object().map(|all| all.iter().filter(|(_, kind)| kind["allowedAmmo"].is_array())
                .map(|(id, kind)| (id.clone(), json!({"allowedAmmo":kind["allowedAmmo"]}))).collect()).unwrap_or_default() })
    }
}

/// A gun as the physics makes it of its reference and what was changed, and as it is drawn: its barrel from the trunnion,
/// the radius of its tube or of all its barrels about their axis, its receiver's length and height, and how much farther it
/// runs back than its reference.
struct Gun {
    family: &'static str, length: f64, caliber: f64, k: f64, charge: f64, projectile_share: f64, rate_share: f64, barrels: u32,
    rounds: u32, travel: f64, chamber: f64, propellant: f64, projectile: f64, faster: f64, pressure: f64,
    impulse: f64, drawn: f64, radius: f64, receiver: (f64, f64), pushed: f64, compartment: Option<Compartment>, made: Made,
}
/// What the design of each kind of a gun's rounds makes of it (`Round`): its kinetic round, its shaped charge, its shell.
#[derive(Clone, Copy, Debug)]
struct Made { kinetic: Round, heat: Round, he: Round }
impl Made {
    fn of(&self, ammo: &str) -> Round { match ammo { "ap" | "apfsds" => self.kinetic, "heat" => self.heat, _ => self.he } }
}
/// What a round's design makes of it against the reference's round of its kind, made as the rest of the gun is: how much
/// heavier it flies, how much faster it leaves, how much more it pierces and how much farther it bursts; of a shell, the
/// share of its burst its fragments carry and how far, in its burst's reach, they fly; what its cartridge weighs more, as a
/// share of its projectile, holds more, L, and costs: as many times its own and credits more for each kg of its projectile.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Round { mass: f64, faster: f64, power: f64, blast: f64, fragments: Option<(f64, f64)>, kg: f64, litres: f64, cost_by: f64, cost_per_kg: f64 }
impl Round {
    const SAME: Round = Round { mass: 1.0, faster: 1.0, power: 1.0, blast: 1.0, fragments: None, kg: 0.0, litres: 0.0, cost_by: 1.0, cost_per_kg: 0.0 };
}
/// What a shaped charge's jet pierces bursting `standoff` tenths of its cone's diameter before its target, in diameters
/// (`JET`): between the measures, as they run.
fn jet(standoff: u32) -> f64 {
    let at = f64::from(standoff) / 10.0;
    let (first, last) = (JET[0], JET[JET.len() - 1]);
    if at <= first.0 { return first.1; }
    if at >= last.0 { return last.1; }
    JET.windows(2).find(|pair| at <= pair[1].0).map_or(last.1, |pair| pair[0].1 + (pair[1].1 - pair[0].1) * (at - pair[0].0) / (pair[1].0 - pair[0].0))
}
/// Of a shell whose explosive is the share `fill` of its weight, the bare charge its blast is worth, as a share of its
/// explosive: F = 0.6 + 0.4/(1 + 2·Wc/W), Wc its case (NAVFAC DM-2.08, Blast Resistant Structures, p. 2.08-16).
fn bare(fill: f64) -> f64 { 0.6 + 0.4 / (1.0 + 2.0 * (1.0 - fill) / fill) }
/// Of the energy of its explosive, the share a shell's case takes as fragments, (M/C)/(M/C + 1/2) (Gurney, 1943, of a
/// cylinder): the more case for the charge, the more of it, the slower.
fn gurney(fill: f64) -> f64 { let case = (1.0 - fill) / fill; case / (case + 0.5) }
/// What the reference has, in the units of a name, its barrel as it has it at the calibre `tenths` (`natural`): no gun of the
/// catalogue has blow-out panels; its rounds as it makes them, none where it fires no such round.
fn own(reference: &Reference, tenths: u32) -> [u32; 12] {
    let design = reference.design;
    [(natural(reference, tenths) * 100.0).round() as u32, (reference.caliber * 10.0).round() as u32, 100, 100,
        design.core.map_or(0, |(core, _)| core), design.cone.unwrap_or(0), design.standoff.unwrap_or(0), design.fill.unwrap_or(0),
        100, 1, reference.rounds, 0]
}
/// The barrel of a gun whose length is not asked, m: its reference's at its calibre; bored to another, as many calibres long,
/// within its calibres and what may be drawn. So a gun bored keeps its reference's shape, and so does the gun its rounds
/// name (`cartridge`): the rounds of any gun that may be made are those of a gun that may be made.
fn natural(reference: &Reference, tenths: u32) -> f64 {
    let caliber = f64::from(tenths) / 10.0;
    if (caliber - reference.caliber).abs() < 1e-9 { return reference.length; }
    let reach = reference.length - reference.drawn;
    let (low, high) = ((SLENDERNESS.0 * caliber / 1000.0).max(BARREL_REACH.0 + reach), (SLENDERNESS.1 * caliber / 1000.0).min(BARREL_REACH.1 + reach));
    let length = reference.length * caliber / reference.caliber;
    if low <= high { length.clamp(low, high) } else { length }
}

fn build(id: &str, reference: &Reference, custom: Custom) -> Result<Gun, String> {
    let tenths = custom.calibre.unwrap_or((reference.caliber * 10.0).round() as u32);
    let own = own(reference, tenths);
    for (value, base) in custom.values().iter().zip(own) {
        if *value == Some(base) { return Err(format!("{id}: asks what its reference has")); }
    }
    let share = |value: Option<u32>, (min, max, step): (u32, u32, u32), what: &str| -> Result<f64, String> {
        match value {
            None => Ok(1.0),
            Some(v) if v >= min && v <= max && v % step == 0 => Ok(f64::from(v) / 100.0),
            Some(_) => Err(format!("{id}: {what} out of reach")),
        }
    };
    let caliber = custom.calibre.map_or(reference.caliber, |tenths| f64::from(tenths) / 10.0);
    if !(CALIBRE_MM.0..=CALIBRE_MM.1).contains(&caliber) { return Err(format!("{id}: no such calibre")); }
    let length = custom.length.map_or_else(|| natural(reference, tenths), |cm| f64::from(cm) / 100.0);
    let slenderness = length / (caliber / 1000.0);
    if !(SLENDERNESS.0 - 1e-9..=SLENDERNESS.1 + 1e-9).contains(&slenderness) { return Err(format!("{id}: barrel out of reach")); }
    let (charge, projectile_share) = (share(custom.charge, CHARGE, "charge")?, share(custom.projectile, PROJECTILE, "projectile")?);
    let k = caliber / reference.caliber;
    let k3 = k * k * k;
    // Interior ballistics: the expansion of the gas from the chamber to the muzzle, then and now. The chamber is of the
    // shape of the reference's, by the cube of the calibre and as much larger as the charge it holds.
    let behind = (reference.length - reference.travel).max(0.0) * k * pow(charge, 1.0 / 3.0);
    let travel = length - behind;
    if travel < 0.05 { return Err(format!("{id}: barrel out of reach")); }
    let chamber = reference.chamber * k3 * charge;
    let efficiency = work(chamber, area(caliber), travel) / work(reference.chamber, area(reference.caliber), reference.travel);
    let (projectile, propellant) = (reference.projectile * k3 * projectile_share, reference.propellant * k3 * charge);
    let lagrange = (reference.projectile + reference.propellant / 3.0) / (reference.projectile * projectile_share + charge * reference.propellant / 3.0);
    let faster = sqrt(charge * efficiency * lagrange);
    let speed = reference.speed * faster;
    let made = made(id, reference, custom, k, charge, projectile_share, faster)?;
    let bore = reference.travel * k;
    let peak = sqrt(charge * work(chamber, area(caliber), bore) / work(reference.chamber, area(reference.caliber), reference.travel) * lagrange);
    let pressure = pressure(projectile, propellant, reference.speed * peak, area(caliber), bore);
    if pressure > MOST_PRESSURE && pressure > reference.pressure * (1.0 + 1e-9) { return Err(format!("{id}: more pressure than gun steel bears")); }
    let family = kind(caliber, slenderness, speed);
    // A round is made as it is asked only of a gun that fires it.
    let fired = reference.fired(family);
    let fires = |kinds: &[&str]| fired.iter().any(|ammo| kinds.contains(&ammo.as_str()));
    if custom.core.is_some() && !fires(&["ap", "apfsds"]) || (custom.cone.is_some() || custom.standoff.is_some()) && !fires(&["heat"])
        || custom.fill.is_some() && !fires(&["he"]) {
        return Err(format!("{id}: fires no such round"));
    }
    let rate_share = share(custom.rate, RATE, "rate")?;
    if custom.rate.is_some() && !automatic(family) { return Err(format!("{id}: a gun loaded a round at a time fires as fast as it is loaded")); }
    let barrels = match custom.barrels {
        Some(n) if n >= 2 && n <= MOST_BARRELS && rotary(family) => n,
        Some(_) => return Err(format!("{id}: barrels out of reach")),
        None => 1,
    };
    let rounds = custom.magazine.unwrap_or(reference.rounds);
    let stops = if belted(family) { BELTS } else { MAGAZINES };
    if custom.magazine.is_some() && !stops.contains(&rounds) { return Err(format!("{id}: no such feed")); }
    // As drawn, within what a gun may be (game_construction.rs `receiver_dimensions`, `recoil`; game_geometry.rs
    // `BarrelProfile`): its barrel from the trunnion, changed by as much as the steel is; its tube as thick as its wall
    // about its bore and, turning, all its barrels about the axis, touching; what is behind the trunnion by the calibre,
    // and the housing of a rotor about the barrels; and it runs back as far as it is pushed, its cradle and buffer of the
    // reference's make, by the square of the calibre.
    let drawn = reference.drawn + (length - reference.length);
    let tube = reference.radius * k * sqrt((1.0 + wall(pressure)) / (1.0 + wall(reference.pressure)));
    let radius = if barrels > 1 { tube * (1.0 + 1.0 / sin(PI / f64::from(barrels))) } else { tube };
    let (behind_trunnion, height) = (reference.receiver.0 * k, reference.receiver.1 * k);
    let receiver = (behind_trunnion, if barrels > 1 { height.max(2.4 * radius) } else { height });
    // It is pushed back by its first round as that is made: of tungsten, heavier and slower, harder.
    let flown = fired.first().map_or(Round::SAME, |ammo| made.of(ammo));
    let projectile = projectile * flown.mass;
    let impulse = impulse(projectile, propellant, speed * flown.faster);
    let pushed = impulse / reference.impulse / (k * k);
    let within = |(min, max): (f64, f64), value: f64| (min - 1e-9..=max + 1e-9).contains(&value);
    if !within(BARREL_REACH, drawn) { return Err(format!("{id}: barrel out of reach")); }
    if !within(BARREL_RADIUS, radius) || !within(RECEIVER_LENGTH, receiver.0) || !within(RECEIVER_HEIGHT, receiver.1)
        || !(RECOIL.0..=RECOIL.1).contains(&(reference.recoil * pushed)) {
        return Err(format!("{id}: larger or smaller than a gun may be drawn"));
    }
    // A measure on the edge of what may be drawn, by the rounding of its reckoning, stands on it.
    let (radius, receiver) = (radius.clamp(BARREL_RADIUS.0, BARREL_RADIUS.1),
        (receiver.0.clamp(RECEIVER_LENGTH.0, RECEIVER_LENGTH.1), receiver.1.clamp(RECEIVER_HEIGHT.0, RECEIVER_HEIGHT.1)));
    // Its ready rounds behind its receiver, in no longer a compartment than may be drawn (`compartment`).
    let feed = if belted(family) { FeedKind::Belt } else if rounds > 1 { FeedKind::Magazine } else { FeedKind::Hand };
    let litres = reference.litres * k3 * bulkier(charge, projectile_share);
    let compartment = compartment_of(feed, rounds, litres, receiver);
    if compartment.is_some_and(|c| c.behind > COMPARTMENT_LENGTH + 1e-9) {
        return Err(format!("{id}: more rounds than may be drawn behind it"));
    }
    // Blow-out panels are the roof of a compartment: a gun loaded a round at a time has none.
    let compartment = match (custom.vent, compartment) {
        (None, c) => c,
        (Some(1), Some(c)) => Some(Compartment { vented: true, ..c }),
        _ => return Err(format!("{id}: no compartment for blow-out panels")),
    };
    Ok(Gun { family, length, caliber, k, charge, projectile_share, rate_share, barrels, rounds, travel, chamber, propellant,
        projectile, faster, pressure, impulse, drawn: drawn.clamp(BARREL_REACH.0, BARREL_REACH.1), radius, receiver, pushed, compartment, made })
}

/// What the design of each kind of round makes of it (`Round`), in a gun of the calibre `k` times its reference's whose
/// charge does `work` times the work on its round and whose projectile is `projectile_share` of its reference's: each
/// against the reference's round of its kind in that gun. A round leaves as much faster as the work of the charge over all
/// it moves, its own weight and a third of its powder's (Lagrange), as `build` reckons it. What the reference does not
/// make — a kinetic round of a gun that fires none — may not be asked.
/// - A penetrator of another material is of the same shape: as much heavier as its density, and the round with it (its
///   sabot, fins or jacket stay as they were); a long rod pierces as Lanz and Odermatt have it (`CORES`, `LONG_ROD_TARGET`),
///   the core of a full-calibre or sub-calibre round as De Marre (`DE_MARRE`); it is paid by the kg (`CORES`).
/// - A shaped charge's jet pierces by the diameter of its cone and as `JET` has it for the standoff it bursts at; a larger
///   cone is more explosive and liner, by its cube (`WARHEAD`), and a longer standoff is a probe as wide as the round before
///   it, as long as it reaches.
/// - A shell of the same shape and more explosive is lighter by as much of its steel case as that displaces; it bursts by
///   the cube root of the bare charge it is worth (`bare`; Hopkinson–Cranz); its fragments carry the energy `gurney` gives
///   its case, against what its burst has, and fly as far as their size, as thick as its case, to the two thirds (Mott,
///   1947, their size; a fragment keeps its speed over a length as its size, its weight over its section); each kg of it
///   is paid as explosive or as steel.
fn made(id: &str, reference: &Reference, custom: Custom, k: f64, charge: f64, projectile_share: f64, gun_faster: f64) -> Result<Made, String> {
    let design = reference.design;
    let within = |value: u32, (min, max, step): (u32, u32, u32)| value >= min && value <= max && value % step == 0;
    let refused = |what: &str| Err(format!("{id}: no such {what}"));
    // How much faster than the reference's round of its kind in this gun a round leaves that weighs `more` of its projectile
    // more: the same work, on more to move.
    let moved = reference.projectile * projectile_share;
    let faster = |more: f64| sqrt((moved + charge * reference.propellant / 3.0) / (moved * (1.0 + more) + charge * reference.propellant / 3.0));
    let kinetic = match (custom.core, design.core) {
        (None, _) => Round::SAME,
        (Some(asked), Some((own, share))) if (1..=CORES.len() as u32).contains(&asked) => {
            let (new, old) = (&CORES[asked as usize - 1], &CORES[own as usize - 1]);
            let denser = new.density / old.density;
            let more = share * (denser - 1.0);
            let quicker = faster(more);
            let at = reference.speed * gun_faster;
            // A long rod by Lanz and Odermatt, a core by De Marre.
            let rod = |core: &Core, speed: f64| core.fit * sqrt(core.density / LONG_ROD_TARGET) * exp(-core.strength / (core.density * speed * speed));
            let power = if reference.allowed.iter().any(|ammo| ammo == "apfsds") { rod(new, at * quicker) / rod(old, at) }
                else { pow(denser * quicker * quicker, 0.5 / DE_MARRE) };
            Round { mass: 1.0 + more * reference.projectile / reference.flight.min(reference.projectile), faster: quicker, power, kg: more,
                cost_per_kg: share * (denser * new.price - old.price), ..Round::SAME }
        }
        _ => return refused("penetrator"),
    };
    let heat = match (custom.cone.or(custom.standoff), design.cone.zip(design.standoff)) {
        (None, _) => Round::SAME,
        (Some(_), Some((cone0, standoff0))) => {
            let (cone, standoff) = (custom.cone.unwrap_or(cone0), custom.standoff.unwrap_or(standoff0));
            if !within(cone, CONE) || !within(standoff, STANDOFF) { return refused("shaped charge"); }
            let wider = f64::from(cone) / f64::from(cone0);
            let more = WARHEAD * (wider * wider * wider - 1.0);
            let reach = f64::from(standoff as i32 - standoff0 as i32) / 10.0 * f64::from(cone) / 100.0 * reference.caliber * k / 1000.0;
            Round { mass: 1.0 + more, faster: faster(more), power: wider * jet(standoff) / jet(standoff0), kg: more,
                litres: reach * area(reference.caliber * k) * 1000.0, cost_by: 1.0 + more, ..Round::SAME }
        }
        _ => return refused("shaped charge"),
    };
    let he = match (custom.fill, design.fill) {
        (None, _) => Round::SAME,
        (Some(asked), Some(own)) if within(asked, FILL) => {
            let (fill, fill0) = (f64::from(asked) / 100.0, f64::from(own) / 100.0);
            let room = |fill: f64| fill / EXPLOSIVE_DENSITY + (1.0 - fill) / CASE_DENSITY;
            let mass = room(fill0) / room(fill);
            let explosive = fill * mass / fill0;
            let blast = pow(explosive * bare(fill) / bare(fill0), 1.0 / 3.0);
            let thrown = explosive * gurney(fill) / gurney(fill0);
            let case = (1.0 - fill) * mass / (1.0 - fill0);
            let price = |fill: f64| fill * EXPLOSIVE_PRICE + (1.0 - fill) * CASE_PRICE;
            Round { mass, faster: faster(mass - 1.0), power: blast, blast, fragments: Some((0.5 * thrown / blast, pow(case, 2.0 / 3.0) / blast)),
                kg: mass - 1.0, cost_per_kg: mass * price(fill) - price(fill0), ..Round::SAME }
        }
        _ => return refused("shell"),
    };
    Ok(Made { kinetic, heat, he })
}

/// The guns a reference may be made into, as it is now: its barrel from and to what length, cm, at its calibre; the
/// calibres it may be bored to, tenths of a mm (its barrel kept as many calibres long); its charge, projectile and rate
/// from and to what share, %; of the rounds it fires, what its kinetic round's penetrator may be of (`CORES`, from 1), its
/// shaped charge's cone and standoff and its shell's explosive (`made`); how many barrels it may turn; how many rounds its
/// feed may hold; and whether its compartment may have blow-out panels. Each range holds the guns that may be made, the
/// rest of it as it is; a feed with no compartment is held as the gun without its panels (`request`), and a calibre as the
/// gun without the design of a round it no longer fires there (`fitted`). A gun with no barrel of steel — a launcher — is
/// not made over. `families` are the kinds of gun of the catalogue.
pub fn options(base: &Value, custom: Custom, families: &Value) -> Option<Value> {
    let reference = Reference::of(base, families)?;
    let own = own(&reference, custom.calibre.unwrap_or((reference.caliber * 10.0).round() as u32));
    let made = |custom: Custom| build("", &reference, fitted(&reference, custom)).ok();
    let gun = made(custom)?;
    // A change to what the reference has is none.
    let with = |order: usize, value: u32| { let mut asked = custom; asked.set(order, (value != own[order]).then_some(value)); asked };
    let admissible = |order: usize, value: u32| made(with(order, value)).is_some();
    let range = |order: usize, (min, max, step): (u32, u32, u32)| {
        let fits: Vec<u32> = (min..=max).step_by(step as usize).filter(|v| admissible(order, *v)).collect();
        json!({"min":fits.first().copied().unwrap_or(own[order]),"max":fits.last().copied().unwrap_or(own[order]),"step":step,"base":own[order]})
    };
    // The barrel, cm: within its calibres and what may be drawn, as far as the steel bears its charge.
    let (shortest, longest) = ((SLENDERNESS.0 * gun.caliber / 10.0).ceil() as u32, (SLENDERNESS.1 * gun.caliber / 10.0).floor() as u32);
    let lengths: Vec<u32> = (shortest..=longest).filter(|cm| admissible(LENGTH, *cm)).collect();
    let calibres: Vec<u32> = CALIBRES.iter().map(|d| (d * 10.0).round() as u32).chain(std::iter::once(own[CALIBRE]))
        .collect::<std::collections::BTreeSet<_>>().into_iter().filter(|tenths| made(shaped(custom, &gun, &reference, *tenths)).is_some()).collect();
    let family = gun.family;
    // As many barrels as may be turned about its axis and drawn: more of them stand wider about it.
    let barrels = if rotary(family) { (2..=MOST_BARRELS).take_while(|n| admissible(BARRELS, *n)).last().unwrap_or(1) } else { 1 };
    let feeds: Vec<u32> = if belted(family) { BELTS } else { MAGAZINES }.iter().copied().chain(std::iter::once(reference.rounds))
        .collect::<std::collections::BTreeSet<_>>().into_iter()
        .filter(|n| admissible(MAGAZINE, *n) || made(Custom { vent: None, ..with(MAGAZINE, *n) }).is_some_and(|gun| gun.compartment.is_none())).collect();
    // How each of the rounds it fires may be made: none of a round it does not fire, or whose making the reference does not state.
    let fired = reference.fired(family);
    let fires = |kinds: &[&str]| fired.iter().any(|ammo| kinds.contains(&ammo.as_str()));
    let design = reference.design;
    let cores: Vec<u32> = (1..=CORES.len() as u32).filter(|core| *core == own[CORE] || admissible(CORE, *core)).collect();
    let names: Vec<&str> = cores.iter().map(|core| CORES[*core as usize - 1].name).collect();
    let core = if design.core.is_some() && fires(&["ap", "apfsds"]) && cores.len() > 1 { json!({"choices":cores,"names":names,"base":own[CORE]}) } else { Value::Null };
    let heat = design.cone.is_some() && design.standoff.is_some() && fires(&["heat"]);
    let he = design.fill.is_some() && fires(&["he"]);
    Some(json!({
        "length":{"min":lengths.first().copied().unwrap_or(own[LENGTH]),"max":lengths.last().copied().unwrap_or(own[LENGTH]),"base":own[LENGTH]},
        "calibres":calibres,"caliber":own[CALIBRE],
        "charge":range(CHARGED, CHARGE),"projectile":range(PROJECTED, PROJECTILE),
        "core":core,"cone":if heat { range(CONED, CONE) } else { Value::Null },
        "standoff":if heat { range(STOOD, STANDOFF) } else { Value::Null },"fill":if he { range(FILLED, FILL) } else { Value::Null },
        "rate":if automatic(family) { range(RATED, RATE) } else { Value::Null },
        "barrels":barrels,
        "feeds":feeds,"rounds":own[MAGAZINE],"panels":admissible(VENT, 1),"family":family}))
}
/// A gun asked as `custom`, without the design of a round it would not fire (`Reference::fired`): bored to a calibre where
/// it is another kind of gun, it keeps how the rest of its rounds are made.
fn fitted(reference: &Reference, custom: Custom) -> Custom {
    let plain = Custom { core: None, cone: None, standoff: None, fill: None, ..custom };
    let Ok(gun) = build("", reference, plain) else { return custom };
    let fired = reference.fired(gun.family);
    let fires = |kinds: &[&str]| fired.iter().any(|ammo| kinds.contains(&ammo.as_str()));
    Custom { core: custom.core.filter(|_| fires(&["ap", "apfsds"])), cone: custom.cone.filter(|_| fires(&["heat"])),
        standoff: custom.standoff.filter(|_| fires(&["heat"])), fill: custom.fill.filter(|_| fires(&["he"])), ..custom }
}
/// A gun bored to `tenths` of a mm, its barrel kept as many calibres long as it is, within what may be drawn: of the shape of
/// its reference where its barrel was its reference's (`natural`).
fn shaped(custom: Custom, gun: &Gun, reference: &Reference, tenths: u32) -> Custom {
    let own = own(reference, tenths);
    let caliber = f64::from(tenths) / 10.0;
    let reach = (reference.length - reference.drawn) * 100.0;
    let cm = (gun.length * caliber / gun.caliber * 100.0).round()
        .clamp((BARREL_REACH.0 * 100.0 + reach).ceil(), (BARREL_REACH.1 * 100.0 + reach).floor()) as u32;
    let mut asked = custom;
    asked.calibre = (tenths != own[CALIBRE]).then_some(tenths);
    asked.length = custom.length.and((cm != own[LENGTH]).then_some(cm));
    fitted(reference, asked)
}

/// The gun `custom` makes of `base`, as the catalogue states a gun: by the physics of guns, from what the catalogue states of
/// its reference, and what it is (`kind`) from what it became, with what the catalogue states of that kind (`families`).
/// Each change acts on what it would:
/// - The gas of the charge does work on the round as it expands from the chamber down the bore (`GAMMA`): a longer barrel
///   lets it do more, a shorter less. A calibre is of the reference's shape, its chamber and charge by the cube and its bore
///   by the square. More powder does more work, and the round leaves as much faster as the square root of that, less what
///   the gas spends on itself: a third of it goes, on average, as fast as the round (Lagrange), and more powder or a heavier
///   round is more of it to move.
/// - The pressure the charge makes (`pressure`) is borne by the wall of the barrel (`wall`), which is as thick as it needs:
///   the steel, by its length and its bore, weighs as much more as that. Past `MOST_PRESSURE` no barrel is made.
/// - A kinetic round pierces by its mass and the square of its speed over its section; a shaped charge by its calibre; a
///   burst by its calibre and the cube root of its weight, as a blast by its charge (Hopkinson–Cranz).
/// - The rest of the gun, its receiver and its cradle, by the square of the calibre and the root of the pressure its breech
///   bears; its rate as guns of other calibres have them (`RATE_EXPONENT`), and slower as it is set; its recoil by how hard
///   it is pushed back (`impulse`).
/// - A rotary gun turns its barrels about one axis, a rotor and its drive about them (`ROTOR_MASS`): each barrel fires as a
///   Gatling's does (`ROTARY_RATE`); the rounds go a little wider (`ROTARY_SPREAD`); and it comes up to its rate in `SPIN_UP`.
/// - Its feed holds as many rounds as it is made for: a belt the crew changes, or a magazine an autoloader fires from and
///   the crew fills again; links, chutes and the loader weigh by the rounds they hold.
pub fn derive(id: &str, base: &Value, custom: Custom, families: &Value) -> Result<Value, String> {
    let reference = Reference::of(base, families).ok_or_else(|| format!("{id}: this weapon is not made over"))?;
    let gun = build(id, &reference, custom)?;
    let (steel, k, n) = (&base["steel"], gun.k, f64::from(gun.barrels));
    let (k2, k3) = (k * k, k * k * k);
    let mut entry = base.as_object().cloned().ok_or("Catalogue weapon is not an object")?;
    let scale = |entry: &mut Map<String, Value>, key: &str, by: f64| {
        if let Some(value) = entry.get(key).and_then(Value::as_f64) { entry.insert(key.into(), json!(value * by)); }
    };
    entry.insert("preset".into(), json!(id));
    entry.insert("variantOf".into(), base["preset"].clone());
    entry.insert("caliberMm".into(), json!(gun.caliber));

    // What it is now, and what it takes of that: the rounds it may be fed of those of its reference, its propellant levels,
    // its arcs and how fast it is laid.
    let family = gun.family;
    if family != reference.family {
        let kind = families.get(family).filter(|v| v.is_object()).ok_or_else(|| format!("{id}: no such kind of gun {family}"))?;
        let allowed: Vec<Value> = reference.fired(family).into_iter().map(Value::String).collect();
        if allowed.len() < reference.allowed.len() { entry.insert("allowedAmmo".into(), Value::Array(allowed.clone())); entry.insert("ammo".into(), allowed[0].clone()); }
        for key in ["charges", "variableCharge", "charge", "servoMaxSpeed", "life"] {
            match kind.get(key) { Some(value) => { entry.insert(key.into(), value.clone()); } None => { entry.remove(key); } }
        }
        entry.insert("family".into(), json!(family));
        entry.insert("id".into(), json!(family));
        entry.insert("trajectory".into(), json!(if arcs(family) { "auto" } else { "direct" }));
        if !arcs(family) { entry.remove("recoilCutoff"); }
        if arcs(family) { entry.insert("life".into(), kind.get("life").cloned().unwrap_or(json!(120.0))); }
    }

    // The round: of the reference's shape, as heavy as asked, as fast as its charge drives it down this bore; each kind as
    // its design makes it (`made`). Its fragments, of a shell made otherwise: the share of its burst they carry and how far,
    // in radii of its burst, they fly (game_pressure.rs `explode`).
    let pierce = gun.projectile_share * k * gun.faster * gun.faster;
    let burst = k * pow(gun.projectile_share, 1.0 / 3.0);
    let power = |ammo: &str, value: f64| gun.made.of(ammo).power * match ammo { "ap" | "apfsds" => value * pierce, "heat" => value * k, _ => value * burst };
    let fragments = |round: &mut Map<String, Value>, made: Round| if let Some((share, reach)) = made.fragments {
        round.insert("fragments".into(), json!(share));
        round.insert("fragmentReach".into(), json!(reach));
    };
    let first = entry.get("allowedAmmo").and_then(|list| list[0].as_str()).unwrap_or("ap").to_owned();
    let main = base["allowedAmmo"][0].as_str().unwrap_or("ap").to_owned();
    let own_round = gun.made.of(&main);
    let flight = base["mass"].as_f64().unwrap_or(0.0) * k3 * gun.projectile_share;
    scale(&mut entry, "radius", k);
    scale(&mut entry, "mass", k3 * gun.projectile_share * own_round.mass);
    scale(&mut entry, "speed", gun.faster * own_round.faster);
    if let Some(value) = base["power"].as_f64() { entry.insert("power".into(), json!(power(&main, value))); }
    let blast0 = base["blastRadius"].as_f64();
    scale(&mut entry, "blastRadius", burst * own_round.blast);
    fragments(&mut entry, own_round);
    let spread = base["spread"].as_f64().unwrap_or(0.0) * (1.0 + ROTARY_SPREAD * (n - 1.0));
    entry.insert("spread".into(), json!(spread));
    let most = if gun.barrels > 1 { n * ROTARY_RATE } else { base["rate"].as_f64().unwrap_or(0.0) * pow(k, RATE_EXPONENT) };
    entry.insert("rate".into(), json!(most * gun.rate_share));

    // The cartridge: case and round by the cube of the calibre, the powder and the projectile as asked, the case as much
    // larger as the powder it holds; the round as its design makes it, of a projectile as heavy as the reference's weighs
    // against the cartridge of its first round (`made`).
    let (projectile0, propellant0) = (reference.projectile * k3, reference.propellant * k3);
    let main_kg = base["cartridge"]["massKg"].as_f64().filter(|m| *m > 0.0);
    let cartridge_of = |cartridge: &Value, made: Round| -> Value {
        let mut whole = cartridge.as_object().cloned().unwrap_or_default();
        let projectile = projectile0 * gun.projectile_share * main_kg.zip(cartridge["massKg"].as_f64()).map_or(1.0, |(main, own)| own / main);
        if let Some(mass) = cartridge["massKg"].as_f64() {
            whole.insert("massKg".into(), json!(mass * k3 + propellant0 * (gun.charge - 1.0) * 2.0 + projectile0 * (gun.projectile_share - 1.0)
                + made.kg * projectile));
        }
        let litres = cartridge["litres"].as_f64().or_else(|| base["cartridge"]["litres"].as_f64().filter(|_| made.litres != 0.0));
        if let Some(litres) = litres {
            whole.insert("litres".into(), json!((litres * k3 * bulkier(gun.charge, gun.projectile_share) + made.litres).max(litres * k3 * 0.25)));
        }
        if let Some(cost) = cartridge["costCredits"].as_f64() {
            whole.insert("costCredits".into(), json!((cost * k3 * (1.0 + 0.5 * (gun.charge - 1.0) + 0.3 * (gun.projectile_share - 1.0)) * made.cost_by
                + made.cost_per_kg * projectile).max(cost * k3 * 0.05)));
        }
        Value::Object(whole)
    };
    entry.insert("cartridge".into(), cartridge_of(&base["cartridge"], own_round));
    let heat0 = required(steel, "heatJ")?;
    if let Some(rounds) = base["rounds"].as_object() {
        let mut own = Map::new();
        for (ammo, round) in rounds {
            if !entry["allowedAmmo"].as_array().is_some_and(|list| list.iter().any(|a| a == ammo)) { continue; }
            let made = gun.made.of(ammo);
            let mut round = round.as_object().cloned().unwrap_or_default();
            scale(&mut round, "speed", gun.faster * made.faster);
            if let Some(value) = round.get("power").and_then(Value::as_f64) { round.insert("power".into(), json!(power(ammo, value))); }
            // A round that bursts as wide as the gun's first, made otherwise, states its own burst; and one that weighs
            // otherwise in flight than the gun's first, its weight.
            match (round.get("blastRadius").and_then(Value::as_f64), blast0) {
                (Some(radius), _) => { round.insert("blastRadius".into(), json!(radius * burst * made.blast)); }
                (None, Some(radius)) if made.blast != own_round.blast => { round.insert("blastRadius".into(), json!(radius * burst * made.blast)); }
                _ => {}
            }
            if made.mass != own_round.mass && flight > 0.0 { round.insert("mass".into(), json!(flight * made.mass)); }
            fragments(&mut round, made);
            scale(&mut round, "heatJ", k3 * gun.charge);
            if let Some(cartridge) = round.get("cartridge").cloned() { round.insert("cartridge".into(), cartridge_of(&cartridge, made)); }
            own.insert(ammo.clone(), Value::Object(round));
        }
        entry.insert("rounds".into(), Value::Object(own));
    }
    // A round of the reference's it no longer fires states what the gun's first now is.
    if first != main {
        if let Some(round) = entry.get("rounds").and_then(|r| r.get(&first)).cloned() {
            for key in ["speed", "drag", "power", "blastRadius", "mass", "fragments", "fragmentReach"] {
                match round.get(key) { Some(v) => { entry.insert(key.into(), v.clone()); } None if ["fragments", "fragmentReach"].contains(&key) => { entry.remove(key); } None => {} }
            }
        }
    }

    // The steel: each barrel by the square of the calibre, its length, and the wall its pressure needs; all of them.
    let barrel_mass = required(steel, "massKg")? * k2 * (gun.length / reference.length) * wall(gun.pressure) / wall(reference.pressure);
    entry.insert("steel".into(), json!({"massKg":barrel_mass * n,"lengthM":gun.length,"limitC":required(steel,"limitC")?,
        "heatJ":heat0 * k3 * gun.charge,"barrels":gun.barrels}));
    entry.insert("bore".into(), json!({"chamberL":gun.chamber * 1000.0,"travelM":gun.travel,"propellantKg":gun.propellant,
        "projectileKg":gun.projectile}));

    // The gun as drawn (`build`).
    entry.insert("barrel".into(), json!(gun.drawn));
    entry.insert("barrelRadius".into(), json!(gun.radius));
    entry.insert("receiver".into(), json!({"length":gun.receiver.0,"height":gun.receiver.1}));
    scale(&mut entry, "recoil", gun.pushed);
    if let Some(cutoff) = entry.get_mut("recoilCutoff").and_then(Value::as_object_mut) {
        if let Some(recoil) = cutoff.get("recoil").and_then(Value::as_f64) { cutoff.insert("recoil".into(), json!(recoil * gun.pushed)); }
    }

    // The feed: a belt the crew changes, or an autoloader's magazine it fills again.
    let round_mass = entry["cartridge"]["massKg"].as_f64().unwrap_or(0.0);
    let feed = feed_of(base, &reference, &gun, round_mass);
    let fed = feed["massKg"].as_f64().unwrap_or(0.0);
    // An autoloader fires as fast as it rams a round, while its magazine holds one.
    if let Some(cycle) = feed["cycleS"].as_f64().filter(|_| feed["kind"] == "magazine") {
        let rate = entry["rate"].as_f64().unwrap_or(0.0).max(60.0 / cycle);
        entry.insert("rate".into(), json!(rate));
    }

    // The installation: its steel as changed, the rest by the square of the calibre and the root of the pressure, a rotor
    // and the feed; its price by its weight.
    let installed0 = required(base, "installedMassKg")?;
    let steel0 = required(steel, "massKg")?;
    let rest = (installed0 - steel0).max(0.0) * pow(k, MASS_EXPONENT) * sqrt(gun.pressure / reference.pressure);
    let installed = (rest + barrel_mass * (n + ROTOR_MASS * (n - 1.0)) + fed).max(installed0 * 0.05);
    entry.insert("installedMassKg".into(), json!(installed));
    scale(&mut entry, "costCredits", installed / installed0);
    entry.insert("feed".into(), feed);
    if gun.barrels > 1 { entry.insert("spinUp".into(), json!(SPIN_UP)); }
    entry.insert("made".into(), changed(custom));
    let figures = figures(&Value::Object(entry.clone()))?;
    entry.insert("figures".into(), figures);
    Ok(Value::Object(entry))
}
/// How much larger a cartridge is than its reference's at its calibre, with as much more powder and as heavy a projectile:
/// its case by half the powder, its round by three tenths the projectile.
fn bulkier(charge: f64, projectile_share: f64) -> f64 { 1.0 + 0.5 * (charge - 1.0) + 0.3 * (projectile_share - 1.0) }
fn changed(custom: Custom) -> Value {
    json!({"length":custom.length,"calibre":custom.calibre,"charge":custom.charge,"projectile":custom.projectile,
        "core":custom.core,"cone":custom.cone,"standoff":custom.standoff,"fill":custom.fill,
        "rate":custom.rate,"barrels":custom.barrels,"magazine":custom.magazine,"vent":custom.vent})
}

/// How a crew changes a belt, s, and how long the links of each round add; how long an autoloader takes to ram a round,
/// s, and the crew to put one back in its magazine. The reference's where the catalogue states them.
pub const BELT_CHANGE: f64 = 10.0;
pub const BELT_LINK: f64 = 0.01;
pub const AUTOLOADER_CYCLE: f64 = 4.0;
pub const AUTOLOADER_REFILL: f64 = 12.0;
/// What links, chutes and cans weigh, as a share of the rounds a belt holds; what an autoloader weighs for each round its
/// magazine holds, as a share of the round, and to begin with, kg by the square of the calibre over 120 mm.
pub const BELT_MASS: f64 = 0.12;
pub const MAGAZINE_MASS: f64 = 1.5;
pub const AUTOLOADER_MASS: f64 = 250.0;

/// The feed of a gun: how many rounds it holds; for a belt, how long the crew takes to change it; for a magazine of more
/// than one round, how fast the autoloader fires from it and how long the crew takes to fill each place again; what all
/// that weighs past the reference's own, with the blow-out panels of its compartment.
fn feed_of(base: &Value, reference: &Reference, gun: &Gun, round_mass: f64) -> Value {
    let own = &base["feed"];
    let n = f64::from(gun.rounds);
    let n0 = f64::from(reference.rounds);
    let vented = gun.compartment.is_some_and(|c| c.vented);
    let panels = gun.compartment.filter(|c| c.vented).map_or(0.0, |c| c.panels());
    if belted(gun.family) {
        // The reference's change is of its own belt: a longer one takes the links of the rounds it holds past that.
        let change = own["reloadS"].as_f64().unwrap_or(BELT_CHANGE) * sqrt(gun.k);
        let link = own["perRoundS"].as_f64().unwrap_or(BELT_LINK);
        json!({"kind":"belt","rounds":gun.rounds,"reloadS":(change + link * (n - n0)).max(BELT_LINK),"massKg":BELT_MASS * round_mass * (n - n0) + panels,
            "vented":vented})
    } else if gun.rounds > 1 {
        let cycle = own["cycleS"].as_f64().unwrap_or(AUTOLOADER_CYCLE) * pow(gun.k, 0.5);
        let refill = own["perRoundS"].as_f64().unwrap_or(AUTOLOADER_REFILL) * pow(gun.k, 0.5);
        let loader = if reference.rounds > 1 { 0.0 } else { AUTOLOADER_MASS * pow(gun.caliber / 120.0, 2.0) };
        json!({"kind":"magazine","rounds":gun.rounds,"cycleS":cycle,"perRoundS":refill,"reloadS":refill * n,
            "massKg":loader + MAGAZINE_MASS * round_mass * (n - n0) + panels,"vented":vented})
    } else {
        json!({"kind":"hand","rounds":1,"reloadS":0.0,"massKg":-(MAGAZINE_MASS * round_mass * (n0 - 1.0)) - if reference.rounds > 1 { AUTOLOADER_MASS * pow(gun.caliber / 120.0, 2.0) } else { 0.0 }})
    }
}

/// How a gun is fed as the field runs it: a belt the crew changes when it runs out; a magazine an autoloader fires from
/// and the crew fills a round at a time; or a round at a time, by hand, as fast as it fires.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeedKind { Belt, Magazine, Hand }
/// A gun's feed: how it is fed, how many rounds it holds ready, how long its crew takes to change its belt, s, and to put
/// a round back in its magazine, s.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Feed { pub kind: FeedKind, pub rounds: u32, pub reload: f64, pub per_round: f64 }
impl Feed {
    /// A gun loaded a round at a time, as it fires: what a launcher, which has no feed, is too.
    pub const HAND: Feed = Feed { kind: FeedKind::Hand, rounds: 1, reload: 0.0, per_round: 0.0 };
    /// The feed of the gun the catalogue states as `weapon`: a gun made over as `derive` made it; one of the catalogue by
    /// its own `feed`, as `derive` would make it of itself — a belt for a gun that fires by itself, a magazine where it
    /// holds more than a round, by hand otherwise, and what it does not state as `feed_of` takes it.
    pub fn of(weapon: &Value) -> Self {
        let own = &weapon["feed"];
        if !own.is_object() { return Self::HAND; }
        let rounds = own["rounds"].as_u64().map_or(1, |n| n.clamp(1, 4000) as u32);
        let kind = match own["kind"].as_str() {
            Some("belt") => FeedKind::Belt,
            Some("magazine") => FeedKind::Magazine,
            Some(_) => FeedKind::Hand,
            None if belted(weapon["family"].as_str().unwrap_or_default()) => FeedKind::Belt,
            None if rounds > 1 => FeedKind::Magazine,
            None => FeedKind::Hand,
        };
        let time = |key: &str, default: f64| own[key].as_f64().filter(|t| t.is_finite() && *t >= 0.0).unwrap_or(default);
        match kind {
            FeedKind::Belt => Self { kind, rounds, reload: time("reloadS", BELT_CHANGE), per_round: 0.0 },
            FeedKind::Magazine => {
                let per_round = time("perRoundS", AUTOLOADER_REFILL);
                Self { kind, rounds, reload: time("reloadS", per_round * f64::from(rounds)), per_round }
            }
            FeedKind::Hand => Self::HAND,
        }
    }
}

/// The compartment of a gun's ready rounds, turning and running back with it, as high as its receiver: what a belt or a
/// magazine of `rounds` cartridges of `litres` each takes of room (`BELT_BULK`, `MAGAZINE_BULK`), `volume` m³. A belt's
/// can stands beside the receiver at the back of it, as wide across as it is high, `beside` long, as the M2A1 can of 100
/// rounds, 7.5 in high, hangs beside the M2's receiver of 7.6 in; as long as the receiver, it grows wider across, up to
/// `BESIDE_WIDTH`; what it still has no room for reaches `behind` the receiver, as long as it is wide. An autoloader's magazine stands behind the breech, as long as it is wide, as the Leclerc's in its
/// bustle, 0.50 m high against its gun's 0.46 m. None for a gun loaded a round at a time. With blow-out panels (`vented`),
/// its roof gives way to what goes off in it.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Compartment { pub kind: FeedKind, pub rounds: u32, pub beside: f64, pub behind: f64, pub height: f64, pub volume: f64, pub vented: bool }
impl Compartment {
    /// How far from the back of the receiver, with what it reaches behind it, the rounds lie.
    pub fn reach(&self) -> f64 { self.behind + self.beside }
    /// What its blow-out panels weigh, kg: its roof, as large as its rounds lie wide (`volume` over `height`), and the blast
    /// door along the side it shares with the gun, as high as it and as long as it reaches (`PANEL_STEEL`, `DOOR_STEEL`).
    pub fn panels(&self) -> f64 { PANEL_STEEL * self.volume / self.height + DOOR_STEEL * self.height * self.reach() }
}
/// The compartment (`Compartment`) of `rounds` cartridges of `litres` each, fed as `kind`, about a receiver `receiver.0`
/// long behind its trunnion and `receiver.1` high.
pub fn compartment_of(kind: FeedKind, rounds: u32, litres: f64, receiver: (f64, f64)) -> Option<Compartment> {
    let bulk = match kind { FeedKind::Belt => BELT_BULK, FeedKind::Magazine => MAGAZINE_BULK, FeedKind::Hand => return None };
    let (length, height) = receiver;
    if !(litres.is_finite() && litres > 0.0 && height.is_finite() && height > 0.0 && length.is_finite() && length > 0.0) { return None; }
    let volume = f64::from(rounds) * litres / 1000.0 * bulk;
    let square = height * height;
    let (beside, held) = if kind == FeedKind::Belt { (length.min(volume / square), volume.min(length * square * BESIDE_WIDTH)) } else { (0.0, 0.0) };
    let rest = volume - held;
    Some(Compartment { kind, rounds, beside, behind: if rest > volume * 1e-9 { sqrt(rest / height) } else { 0.0 }, height, volume, vented: false })
}
/// The compartment of the gun the catalogue states as `weapon` (`compartment_of`), by its feed (`Feed::of`), its cartridge
/// and its own receiver, with the blow-out panels its feed states.
pub fn compartment(weapon: &Value) -> Option<Compartment> {
    let feed = Feed::of(weapon);
    compartment_of(feed.kind, feed.rounds, weapon["cartridge"]["litres"].as_f64()?,
        (weapon["receiver"]["length"].as_f64()?, weapon["receiver"]["height"].as_f64()?))
        .map(|c| Compartment { vented: weapon["feed"]["vented"] == true, ..c })
}

/// What the workshop shows of one of a gun's rounds, as the catalogue states it (`ammo`, its first at the weapon's own keys
/// and each other in `rounds`): how far it goes; what it pierces at 500 m and 1 km, kinetic, or at any range, a shaped
/// charge, mm of rolled steel; how wide it bursts and how far its fragments fly, m (game_pressure.rs `explode`); how fast it
/// leaves; and what its cartridge weighs and costs.
fn round_figures(weapon: &Value, ammo: &str) -> Result<Value, String> {
    let family = weapon["family"].as_str().unwrap_or("cannon");
    let first = weapon["allowedAmmo"][0].as_str() == Some(ammo);
    let own = &weapon["rounds"][ammo];
    let stated = |key: &str| if first { weapon[key].as_f64() } else { own[key].as_f64().or_else(|| weapon[key].as_f64()) };
    // A round of another kind flies as heavy as the weapon's first, unless it states its own weight (game_weapons.rs `round`).
    let mass = if first { weapon["mass"].as_f64() } else { own["mass"].as_f64().or_else(|| weapon["mass"].as_f64()) };
    let (speed, mass, caliber) = (stated("speed").ok_or("Finite speed is required")?, mass.ok_or("Weapon requires mass")?, required(weapon, "caliberMm")?);
    let drag = Drag::admit(mass.clamp(0.005, 60.0), caliber, family, stated("drag"))?;
    let power = stated("power").ok_or("Weapon requires power")?;
    // Flat fire slows as e^(−kx), and a kinetic round pierces by the square of what it keeps (`commit_air`).
    let kinetic = |metres: f64| power * exp(-2.0 * drag.at(0.0) * metres) / 1.25;
    let pierce = match ammo { "ap" | "apfsds" => json!({"at500":kinetic(500.0),"at1000":kinetic(1000.0)}), "heat" => json!({"any":power / 1.25}), _ => Value::Null };
    let (blast, fragments) = if ammo == "he" {
        let radius = stated("blastRadius");
        let reach = if first { weapon["fragmentReach"].as_f64() } else { own["fragmentReach"].as_f64() }.unwrap_or(1.0);
        (json!(radius), json!(radius.map(|r| (r * crate::game_pressure::FRAGMENT_AIM * reach).min(crate::game_projectiles::FRAGMENT_FLIGHT))))
    } else { (Value::Null, Value::Null) };
    let cartridge = |key: &str| own["cartridge"][key].as_f64().filter(|_| !first).or_else(|| weapon["cartridge"][key].as_f64());
    Ok(json!({"rangeM":farthest(speed, 0.0, 0.0, drag),"pierceMm":pierce,"blastM":blast,"fragmentsM":fragments,"speed":speed,
        "massKg":cartridge("massKg"),"costCredits":cartridge("costCredits")}))
}
/// What the workshop shows of a gun, from the catalogue's statement of it: how far its first round goes; what its kinetic
/// rounds pierce at 500 m and 1 km, or its shaped charge at any range, mm of rolled steel; how wide its burst; how fast it
/// fires; how hard it is pushed back, N·s; how many rounds it fires on end before its barrel is too hot; what it weighs and
/// costs; and its feed; and each of its rounds (`round_figures`).
pub fn figures(weapon: &Value) -> Result<Value, String> {
    let family = weapon["family"].as_str().unwrap_or("cannon");
    let ammo = weapon["allowedAmmo"][0].as_str().unwrap_or("ap");
    let speed = required(weapon, "speed")?;
    let first = round_figures(weapon, ammo)?;
    let mut each = Map::new();
    for other in weapon["allowedAmmo"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        each.insert(other.to_owned(), round_figures(weapon, other)?);
    }
    let rate = required(weapon, "rate")?;
    let impulse = weapon["bore"]["projectileKg"].as_f64().zip(weapon["bore"]["propellantKg"].as_f64())
        .map_or(Value::Null, |(m, c)| json!(impulse(m, c, speed)));
    // Fired on end at its rate from cold, in still air, its barrels sharing the rounds: none past 2,000 is told.
    let hot = BarrelSteel::from_catalogue(weapon).ok().filter(BarrelSteel::heats).map(|steel| {
        let limit = weapon["steel"]["limitC"].as_f64().unwrap_or(500.0);
        let (mut temperature, mut rounds, step) = (20.0_f64, 0_u32, 60.0 / rate.max(1.0));
        let air = Air::at(0.0, 0.0);
        while rounds < 2000 && temperature < limit {
            temperature += steel.round(ammo, 1.0) / steel.capacity(temperature);
            temperature -= steel.losing(temperature, air) * step / steel.capacity(temperature);
            rounds += 1;
        }
        if temperature < limit { Value::Null } else { json!(rounds) }
    }).unwrap_or(Value::Null);
    Ok(json!({"family":family,"rangeM":first["rangeM"],"pierceMm":first["pierceMm"],"blastM":weapon["blastRadius"],"rounds":each,"rate":rate,"recoilNs":impulse,
        "roundsToHot":hot,"massKg":weapon["installedMassKg"],"costCredits":weapon["costCredits"],"feed":stated_feed(weapon),
        "compartment":compartment(weapon).map_or(Value::Null, |c| json!({"kind":match c.kind { FeedKind::Belt => "belt", _ => "magazine" },
            "rounds":c.rounds,"lengthM":c.behind,"besideM":c.beside,"heightM":c.height,"litres":c.volume * 1000.0,"vented":c.vented,
            "panelsKg":c.panels()}))}))
}
/// A gun's feed as the field runs it (`Feed::of`), told with what the catalogue states of it: how it is fed, the rounds it
/// holds and how long its belt takes to change, with its autoloader's cycle and what it weighs where stated.
fn stated_feed(weapon: &Value) -> Value {
    let Some(own) = weapon["feed"].as_object() else { return Value::Null };
    let fed = Feed::of(weapon);
    let mut feed = own.clone();
    feed.insert("kind".into(), json!(match fed.kind { FeedKind::Belt => "belt", FeedKind::Magazine => "magazine", FeedKind::Hand => "hand" }));
    feed.insert("rounds".into(), json!(fed.rounds));
    feed.insert("reloadS".into(), json!(fed.reload));
    Value::Object(feed)
}

/// Puts the gun `id` names in the catalogue, made of its reference there, if it is a gun made over and not there yet.
pub fn ensure(catalogue: &mut Value, id: &str) -> Result<(), String> {
    if !id.contains('|') || catalogue.get(id).is_some_and(Value::is_object) { return Ok(()); }
    let (base, custom) = parse(id)?;
    if name(base, custom) != id { return Err(format!("Unknown weapon {id}")); }
    let entry = derive(id, catalogue.get(base).filter(|v| v.is_object()).ok_or_else(|| format!("Unknown weapon {id}"))?, custom, catalogue)?;
    catalogue.as_object_mut().ok_or("Catalogue is not an object")?.insert(id.to_owned(), entry);
    Ok(())
}
/// A pure request from a page about a gun of the catalogue, `base`, with the kinds of gun of the catalogue (`families`):
/// the gun a name makes of it (`id`); that gun bored to another calibre, its barrel kept as many calibres long (`id` and
/// `calibre`, tenths of a mm); or the one made of it as `custom` asks, in the units of `options`, each the reference's own
/// where it asks none or asks that. It answers with the name of that gun and of its rounds, what it may be made into from
/// there, and the gun as the catalogue states one, with what the workshop shows of it (`figures`).
pub fn request(value: &Value) -> Result<Value, String> {
    let base = value.get("base").filter(|v| v.is_object()).ok_or("Weapon variant request needs its base")?;
    let families = value.get("families").filter(|v| v.is_object()).ok_or("Weapon variant request needs the kinds of gun")?;
    let base_id = base["preset"].as_str().ok_or("Weapon variant request needs its base")?;
    let reference = Reference::of(base, families);
    let named = |id: &str| -> Result<Custom, String> {
        let (named, custom) = parse(id)?;
        if named != base_id || name(named, custom) != id { return Err(format!("Unknown weapon {id}")); }
        Ok(custom)
    };
    let (id, custom) = match (value.get("id").and_then(Value::as_str), value.get("custom").and_then(Value::as_object)) {
        (Some(id), None) => match value.get("calibre") {
            None => (id.to_owned(), named(id)?),
            Some(tenths) => {
                let tenths = tenths.as_u64().filter(|v| (1..=99999).contains(v)).ok_or("Invalid weapon calibre")? as u32;
                let reference = reference.as_ref().ok_or_else(|| format!("{base_id}: this weapon is not made over"))?;
                let custom = named(id)?;
                let gun = build(id, reference, custom)?;
                let bored = shaped(custom, &gun, reference, tenths);
                (name(base_id, bored), bored)
            }
        },
        (None, Some(asked)) => {
            let reference = reference.as_ref().ok_or_else(|| format!("{base_id}: this weapon is not made over"))?;
            // Its barrel is its reference's at the calibre it asks.
            let tenths = asked.get("calibre").and_then(Value::as_u64).filter(|v| (1..=99999).contains(v))
                .map_or((reference.caliber * 10.0).round() as u32, |v| v as u32);
            let own = own(reference, tenths);
            let mut custom = Custom::default();
            for (order, key) in ["length", "calibre", "charge", "projectile", "core", "cone", "standoff", "fill", "rate", "barrels", "magazine", "vent"].iter().enumerate() {
                if let Some(v) = asked.get(*key) {
                    let v = v.as_u64().filter(|v| *v <= 99999).ok_or_else(|| format!("Invalid weapon {key}"))? as u32;
                    custom.set(order, (v != own[order]).then_some(v));
                }
            }
            // A round it would not fire is made as none; a feed that has no compartment has no panels either: it is asked of
            // the gun without them.
            let mut custom = fitted(reference, custom);
            if custom.vent.is_some() && build(base_id, reference, Custom { vent: None, ..custom }).is_ok_and(|gun| gun.compartment.is_none()) {
                custom.vent = None;
            }
            (name(base_id, custom), custom)
        }
        _ => return Err("Weapon variant request needs a name or what to change".into()),
    };
    let weapon = if custom.plain() {
        let mut own = base.clone();
        if reference.is_some() { own["figures"] = figures(base)?; }
        own
    } else { derive(&id, base, custom, families)? };
    let options = options(base, custom, families);
    Ok(json!({"id":id,"cartridge":name(base_id, custom.cartridge()),"options":options,"weapon":weapon}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_damage::fixtures::catalogue;

    #[test]
    fn a_name_is_its_reference_and_its_changes_in_one_order_and_its_rounds_are_its_cartridges() {
        assert_eq!(parse("m2hb"), Ok(("m2hb", Custom::default())));
        assert_eq!(parse("m2hb|L140|N3"), Ok(("m2hb", Custom { length: Some(140), barrels: Some(3), ..Custom::default() })));
        for bad in ["m2hb|N3|L140", "m2hb|L0140", "m2hb|", "m2hb|X3", "|L140", "m2hb|L1x", "m2hb|M100|N3"] { assert!(parse(bad).is_err(), "{bad}"); }
        assert_eq!(cartridge("m2hb|L140|N3"), "m2hb");
        assert_eq!(cartridge("m2hb|L140|D145|C110|P120|R50|N3|M200"), "m2hb|D145|C110|P120");
        assert_eq!(name("m2hb", Custom { calibre: Some(145), magazine: Some(200), ..Custom::default() }), "m2hb|D145|M200");
    }

    fn made(id: &str) -> Value {
        let mut weapons = catalogue().clone();
        ensure(&mut weapons, id).unwrap_or_else(|e| panic!("{e}"));
        weapons[id].clone()
    }
    fn refused(id: &str) -> bool { ensure(&mut catalogue().clone(), id).is_err() }
    fn near(value: f64, expected: f64, share: f64, what: &str) {
        assert!((value / expected - 1.0).abs() <= share, "{what}: {value} against {expected}");
    }
    fn number(v: &Value, key: &str) -> f64 { v[key].as_f64().unwrap_or_else(|| panic!("{key} of {v}")) }

    #[test]
    fn a_barrel_cut_shorter_or_made_longer_gives_the_speeds_measured() {
        let own = |id: &str| number(&catalogue()[id], "speed");
        // The 120 mm DM53 from the L/44 to the L/55: 1,670 and 1,750 m/s.
        near(number(&made("rh120|L660"), "speed") / own("rh120"), 1750.0 / 1670.0, 0.02, "L/55");
        // 7.62 × 51 mm from the MAG's 24.8 in to 16.5 in: 2,682 against 2,927 fps (rifleshooter.com, 2014).
        near(number(&made("fnmag|L42"), "speed") / own("fnmag"), 2682.0 / 2927.0, 0.02, "16.5 in");
        // The M33 from 45 to 36 in: 2,905 against 2,980 fps (General Dynamics, NDIA 2011).
        near(number(&made("m2hb|L91"), "speed") / own("m2hb"), 2905.0 / 2980.0, 0.02, "36 in");
        // A longer barrel fires the rounds of the gun it was made of, and its kinetic rounds pierce more.
        let long = made("rh120|L660");
        assert!(number(&long, "power") > number(&catalogue()["rh120"], "power"));
        assert_eq!(cartridge("rh120|L660"), "rh120");
        assert!(number(&long["steel"], "massKg") > 1190.0 && number(&long, "barrel") > 5.5);
    }

    #[test]
    fn more_powder_is_more_gas_to_move_as_well_as_more_work_and_more_pressure_for_the_steel() {
        // The 30 mm Mk317 on 125 and 150 g of RP-910 under a 123 g round: 1,527 and 1,624 m/s (Gloude, NDIA 2011).
        let mut base = catalogue()["mk44"].clone();
        base["bore"]["propellantKg"] = json!(0.125);
        base["bore"]["projectileKg"] = json!(0.123);
        let more = derive("mk44|C120", &base, Custom { charge: Some(120), ..Custom::default() }, catalogue()).unwrap();
        // A fifth more powder in a case a fifth larger: the gas expands a little less far, which the Mk317's case did not.
        near(number(&more, "speed") / number(&base, "speed"), 1624.0 / 1527.0, 0.025, "Mk317");
        assert_eq!(cartridge("mk44|C120"), "mk44|C120");
        assert!(number(&more["cartridge"], "massKg") > number(&base["cartridge"], "massKg"));
        let (thick, thin) = (number(&more["steel"], "massKg"), number(&base["steel"], "massKg"));
        assert!(thick > thin * 1.1, "{thick} against {thin}");
        // Past what gun steel bears no barrel is made: the 120 mm with half as much powder again.
        assert!(refused("rh120|C150"));
        assert!(refused("mk44|C102"), "out of its steps");
    }

    #[test]
    fn a_heavier_round_leaves_slower_carries_further_and_pierces_more_up_close() {
        let (own, heavy) = (catalogue()["m2hb"].clone(), made("m2hb|P150"));
        assert!(number(&heavy, "speed") < number(&own, "speed"));
        assert!(number(&heavy, "power") > number(&own, "power"));
        assert_eq!(cartridge("m2hb|P150"), "m2hb|P150");
        assert!(number(&heavy["figures"], "rangeM") > number(&made("m2hb|P50")["figures"], "rangeM"));
    }

    #[test]
    fn what_a_gun_is_follows_from_what_it_became() {
        for (id, family) in [("minimi", "machinegun"), ("mk44", "autocannon"), ("mk19", "grenade"), ("m252", "mortar"),
            ("m119", "howitzer"), ("m777", "howitzer"), ("rh120", "cannon")] {
            let gun = &catalogue()[id];
            let slenderness = number(&gun["steel"], "lengthM") / number(gun, "caliberMm") * 1000.0;
            assert_eq!(kind(number(gun, "caliberMm"), slenderness, number(gun, "speed")), family, "{id}");
        }
        // The M2 bored to 20 mm, its barrel as many calibres long, is an autocannon: it is laid and fed as one, and may
        // turn barrels; its rounds are its own and its armour-piercing round the one it keeps.
        let bored = made("m2hb|L150|D200");
        assert_eq!(bored["family"], "autocannon");
        assert_eq!(bored["allowedAmmo"], json!(["ap"]));
        assert!(!refused("m2hb|L150|D200|N3"));
        // The M777 made to fire faster than 1,000 m/s is not; a 120 mm gun cut to a short barrel at low charge, a howitzer.
        let short = made("rh120|L300|C50|P200");
        assert_eq!(short["family"], "howitzer");
        assert_eq!(short["trajectory"], "auto");
        assert!(short["charges"].as_array().is_some_and(|c| c.len() > 1));
        assert_eq!(short["allowedAmmo"], json!(["he"]));
        // A howitzer fires a round at a time and turns no barrels.
        assert!(refused("m777|N2") && refused("m777|R50"));
    }

    #[test]
    fn a_rotary_gun_fires_as_a_gatling_and_weighs_its_barrels_and_rotor() {
        // Three barrels of 36 in about the M2's receiver: the GAU-19, 1,000 to 2,000 a minute, 24.5 kg over the M2.
        let (one, three) = (catalogue()["m2hb"].clone(), made("m2hb|L91|N3"));
        let rate = number(&three, "rate");
        assert!((1000.0..=2000.0).contains(&rate), "{rate}");
        let added = number(&three, "installedMassKg") - number(&one, "installedMassKg");
        near(added, 62.6 - 38.1, 0.08, "GAU-19");
        assert_eq!(three["steel"]["barrels"], 3);
        assert_eq!(three["spinUp"], json!(SPIN_UP));
        assert!(number(&three, "spread") > number(&one, "spread"));
        assert!(number(&three, "barrelRadius") > 2.0 * number(&one, "barrelRadius"));
        assert_eq!(cartridge("m2hb|L91|N3"), "m2hb");
        // Seven 30 mm barrels, the GAU-8: 3,900 to 4,200 a minute; set to half, half as fast.
        let rate = number(&made("mk44|N7"), "rate");
        assert!((3900.0..=4200.0).contains(&rate), "{rate}");
        near(number(&made("mk44|R50|N7"), "rate"), rate / 2.0, 1e-9, "set to half");
        assert_eq!(cartridge("mk44|R50|N7"), "mk44");
    }

    #[test]
    fn a_gun_of_another_calibre_is_of_its_shape_and_fires_rounds_of_its_own() {
        let (own, bored) = (catalogue()["m2hb"].clone(), made("m2hb|D145"));
        let k: f64 = 14.5 / 12.7;
        near(number(&bored, "mass"), number(&own, "mass") * k * k * k, 1e-9, "round");
        near(number(&bored, "rate"), 550.0 * pow(k, RATE_EXPONENT), 1e-9, "rate");
        assert!(number(&bored, "installedMassKg") > number(&own, "installedMassKg"));
        assert_eq!(cartridge("m2hb|L100|D145|N3"), "m2hb|D145");
        for bad in ["m2hb|D20", "m2hb|D127", "m2hb|L114", "m2hb|C100", "m2hb|N1", "m2hb|L10", "m2hb|L114|D1550"] { assert!(refused(bad), "{bad}"); }
        // Bored, a gun keeps its reference's shape, its barrel as many calibres long: the workshop asks the calibre alone.
        near(number(&bored["steel"], "lengthM"), 1.143 * k, 1e-9, "barrel");
        let asked = request(&json!({"base": own, "families": catalogue(), "id": "m2hb|N3", "calibre": 145})).unwrap();
        assert_eq!(asked["id"], "m2hb|D145|N3");
        assert_eq!(asked["cartridge"], "m2hb|D145");
        // A barrel it was given is kept as many calibres long as it was.
        let long = request(&json!({"base": own, "families": catalogue(), "id": "m2hb|L91|N3", "calibre": 145})).unwrap();
        let (_, longer) = parse(long["id"].as_str().unwrap()).unwrap();
        assert!((103..=105).contains(&longer.length.unwrap()), "{:?}", longer.length);
        // The rounds of a gun bored small are those of a gun that may be made, though its reference's barrel would be too long
        // for their calibre.
        let small = request(&json!({"base": own, "families": catalogue(), "id": "m2hb|L60", "calibre": 76})).unwrap();
        assert_eq!(small["cartridge"], "m2hb|D76");
        assert!(!refused("m2hb|D76"));
        assert_eq!(asked["options"]["family"], "machinegun");
        assert!(asked["options"]["calibres"].as_array().unwrap().contains(&json!(200)), "it may be bored on to an autocannon's");
        assert!(asked["weapon"]["figures"]["rangeM"].as_f64().unwrap() > 1000.0);
    }

    #[test]
    fn every_gun_the_workshop_offers_may_be_drawn_and_none_past_it() {
        // What the construction compiler draws of a gun: its receiver, its recoil and its barrel.
        let drawable = |entry: &Value, id: &str| {
            crate::game_construction::receiver_dimensions(entry).unwrap_or_else(|e| panic!("{id}: {e}"));
            crate::game_construction::recoil(entry).unwrap_or_else(|e| panic!("{id}: {e}"));
            crate::game_geometry::BarrelProfile::from_weapon(entry).unwrap_or_else(|e| panic!("{id}: {e}"));
        };
        let catalogue = catalogue();
        let mut offered = 0;
        for (id, base) in catalogue.as_object().unwrap() {
            let (Some(reference), Some(own)) = (Reference::of(base, catalogue), options(base, Custom::default(), catalogue)) else { continue };
            let gun = build(id, &reference, Custom::default()).unwrap();
            // Each calibre it may be bored to, with as many barrels as it may turn there and the largest feed.
            for tenths in own["calibres"].as_array().unwrap().iter().filter_map(Value::as_u64) {
                let bored = shaped(Custom::default(), &gun, &reference, tenths as u32);
                let there = options(base, bored, catalogue).unwrap();
                let most = |key: &str| there[key].as_u64().map(|n| n as u32);
                let mut turned = bored;
                turned.barrels = most("barrels").filter(|n| *n > 1);
                turned.magazine = there["feeds"].as_array().unwrap().last().and_then(Value::as_u64).map(|n| n as u32).filter(|n| Some(u64::from(*n)) != there["rounds"].as_u64());
                for made in [bored, turned] {
                    if made.plain() { continue; }
                    let named = name(id, made);
                    drawable(&derive(&named, base, made, catalogue).unwrap_or_else(|e| panic!("{e}")), &named);
                    offered += 1;
                }
            }
        }
        assert!(offered > 100, "{offered}");
        // The Minimi bored to 30 mm would have a receiver longer than a tank gun's: it is not offered, nor made.
        assert!(!options(&catalogue["minimi"], Custom::default(), catalogue).unwrap()["calibres"].as_array().unwrap().contains(&json!(300)));
        assert!(refused("minimi|D300"));
    }

    #[test]
    fn a_feed_holds_as_many_rounds_as_it_is_made_for_and_weighs_by_them() {
        let (own, long) = (catalogue()["m2hb"].clone(), made("m2hb|M400"));
        assert_eq!(long["feed"]["kind"], "belt");
        assert_eq!(long["feed"]["rounds"], 400);
        assert!(number(&long, "installedMassKg") > number(&own, "installedMassKg"));
        assert_eq!(cartridge("m2hb|M400"), "m2hb");
        assert!(refused("m2hb|M7"), "no such belt");
        // The workshop is told how each gun is fed, of the catalogue as made over.
        assert_eq!(figures(&catalogue()["m2hb"]).unwrap()["feed"]["kind"], "belt");
        assert_eq!(figures(&catalogue()["rh120"]).unwrap()["feed"]["kind"], "hand");
        assert_eq!(long["figures"]["feed"]["kind"], "belt");
        // A howitzer given a magazine fires from it by an autoloader the crew fills again, and weighs that.
        let loaded = made("m777|M12");
        assert_eq!(loaded["feed"]["kind"], "magazine");
        assert!(number(&loaded["feed"], "cycleS") < 60.0 / number(&catalogue()["m777"], "rate"));
        near(number(&loaded, "rate"), 60.0 / number(&loaded["feed"], "cycleS"), 1e-9, "fires as fast as it rams");
        assert!(number(&loaded, "installedMassKg") > number(&catalogue()["m777"], "installedMassKg"));
    }

    #[test]
    fn the_ready_rounds_take_the_room_of_the_m2a1_can_beside_the_receiver_and_of_the_leclercs_bustle_behind_the_breech() {
        let catalogue = catalogue();
        // The M2's belt of 100 in a can beside its receiver and as high: 8.66 L, as the M2A1 can outside, 11.75 in long.
        let m2 = compartment(&catalogue["m2hb"]).unwrap();
        assert_eq!((m2.kind, m2.rounds, m2.behind), (FeedKind::Belt, 100, 0.0));
        near(m2.volume * 1000.0, 8.66, 0.1, "the can");
        assert!(m2.beside > 0.2 && m2.beside < 0.31, "{}", m2.beside);
        assert_eq!(crate::game_construction::receiver_dimensions(&catalogue["m2hb"]).unwrap(), (0.77, 0.193));
        // A gun loaded a round at a time carries none, nor does a launcher.
        assert!(compartment(&catalogue["rh120"]).is_none() && compartment(&catalogue["at4"]).is_none());
        // The tank gun with an autoloader of 22: a magazine as large as the Leclerc's, 1.68 m³, all of it behind the breech.
        let bustle = compartment(&made("rh120|M22")).unwrap();
        assert_eq!((bustle.kind, bustle.beside), (FeedKind::Magazine, 0.0));
        near(bustle.volume, 1.68, 0.03, "the bustle");
        assert!(bustle.behind > 1.4 && bustle.behind < 2.2, "{}", bustle.behind);
        // A belt of 400, as a CROWS station's, in a can as long as the receiver and wider beside it; one of 1,000 fills it
        // twice as wide as it is high, and reaches behind it with the rest; the receiver is drawn as long as both.
        let crows = compartment(&made("m2hb|M400")).unwrap();
        assert!((crows.beside - 0.77).abs() < 1e-9 && crows.behind == 0.0, "{crows:?}");
        let long = made("m2hb|M1000");
        let fed = compartment(&long).unwrap();
        assert!((fed.beside - 0.77).abs() < 1e-9 && fed.behind > 0.3, "{fed:?}");
        near(fed.beside * 0.193 * 0.193 * BESIDE_WIDTH + fed.behind * fed.behind * 0.193, fed.volume, 1e-9, "all of it");
        assert!((crate::game_construction::receiver_dimensions(&long).unwrap().0 - 0.77 - fed.behind).abs() < 1e-9);
        // The autocannons of the catalogue hold their belts beside their receivers, as the Bradley's two boxes lie under its
        // gun; a longer belt reaches behind, and what the workshop shows of it says so.
        for id in ["m242", "mk44", "m230lf", "mk35"] { assert_eq!(compartment(&catalogue[id]).unwrap().behind, 0.0, "{id}"); }
        let chain = compartment(&made("m242|M1000")).unwrap();
        assert!(chain.behind > 0.5 && chain.behind < 1.2, "{chain:?}");
        let told = figures(&made("m242|M1000")).unwrap();
        near(number(&told["compartment"], "lengthM"), chain.behind, 1e-12, "behind");
        near(number(&told["compartment"], "besideM"), chain.beside, 1e-12, "beside");
        assert!(figures(&catalogue["rh120"]).unwrap()["compartment"].is_null());
    }

    #[test]
    fn the_workshop_offers_no_feed_that_reaches_farther_behind_its_receiver_than_a_bustle() {
        let catalogue = catalogue();
        let feeds = |id: &str| -> Vec<u32> { options(&catalogue[id], Custom::default(), catalogue).unwrap()["feeds"].as_array().unwrap()
            .iter().map(|n| n.as_u64().unwrap() as u32).collect() };
        for id in ["m2hb", "m242", "mk35", "m777", "rh120"] {
            for rounds in feeds(id) {
                let named = name(id, Custom { magazine: (Some(rounds) != options(&catalogue[id], Custom::default(), catalogue).unwrap()["rounds"].as_u64().map(|n| n as u32)).then_some(rounds), ..Custom::default() });
                let entry = if named == id { catalogue[id].clone() } else { made(&named) };
                assert!(compartment(&entry).map_or(0.0, |c| c.behind) <= COMPARTMENT_LENGTH + 1e-9, "{named}");
            }
        }
        // The 35 mm on a belt of 4,000 would reach 3.2 m behind its receiver: it is offered 3,000 at most.
        assert_eq!(feeds("mk35").last(), Some(&3000));
        assert!(derive("mk35|M4000", &catalogue["mk35"], Custom { magazine: Some(4000), ..Custom::default() }, catalogue).is_err());
    }

    #[test]
    fn blow_out_panels_are_the_roof_of_a_compartment_and_weigh_with_its_blast_door() {
        let catalogue = catalogue();
        assert_eq!(parse("rh120|M22|V1"), Ok(("rh120", Custom { magazine: Some(22), vent: Some(1), ..Custom::default() })));
        for bad in ["rh120|V1|M22", "rh120|M22|V2", "rh120|M22|V0"] { assert!(refused(bad), "{bad}"); }
        // A gun loaded a round at a time has no compartment to give panels to; a belt's can and a magazine have.
        assert!(refused("rh120|V1") && refused("m777|V1"));
        let (plain, vented) = (made("rh120|M22"), made("rh120|M22|V1"));
        let bustle = compartment(&vented).unwrap();
        assert!(bustle.vented && !compartment(&plain).unwrap().vented);
        // Its roof of 10 mm over its rounds and its door of 20 mm against the gun: some 0.4 t on the Leclerc's bustle.
        near(bustle.panels(), PANEL_STEEL * bustle.volume / bustle.height + DOOR_STEEL * bustle.height * bustle.behind, 1e-12, "panels");
        assert!(bustle.panels() > 300.0 && bustle.panels() < 550.0, "{}", bustle.panels());
        near(number(&vented, "installedMassKg") - number(&plain, "installedMassKg"), bustle.panels(), 1e-9, "weighed");
        near(number(&vented, "costCredits") / number(&plain, "costCredits"),
            number(&vented, "installedMassKg") / number(&plain, "installedMassKg"), 1e-9, "priced by its weight");
        assert_eq!(vented["figures"]["compartment"]["vented"], true);
        assert_eq!(vented["made"]["vent"], 1);
        // The M2's can: a few kilograms.
        let can = compartment(&made("m2hb|V1")).unwrap();
        assert!(can.vented && can.panels() > 2.0 && can.panels() < 20.0, "{}", can.panels());
        // The workshop offers panels where there is a compartment, and every feed with them: one with no compartment is the
        // gun without its panels.
        let options_of = |id: &str| { let (base, custom) = parse(id).unwrap(); options(&catalogue[base], custom, catalogue).unwrap() };
        assert_eq!(options_of("rh120")["panels"], false);
        assert_eq!(options_of("rh120|M22")["panels"], true);
        assert_eq!(options_of("m2hb")["panels"], true);
        assert!(options_of("rh120|M22|V1")["feeds"].as_array().unwrap().contains(&json!(1)));
        let families = json!({});
        let asked = request(&json!({"base":catalogue["rh120"],"families":families,"custom":{"magazine":1,"vent":1}})).unwrap();
        assert_eq!(asked["id"], "rh120");
        let asked = request(&json!({"base":catalogue["rh120"],"families":families,"custom":{"magazine":22,"vent":1}})).unwrap();
        assert_eq!(asked["id"], "rh120|M22|V1");
        // Its rounds are its gun's without them.
        assert_eq!(cartridge("rh120|M22|V1"), "rh120");
    }

    /// What one kind of a gun's rounds is, as the catalogue states it: its first at the weapon's keys, each other in `rounds`.
    fn round(weapon: &Value, ammo: &str, key: &str) -> f64 {
        let own = &weapon["rounds"][ammo];
        if weapon["allowedAmmo"][0] == ammo { number(weapon, key) } else { own[key].as_f64().unwrap_or_else(|| number(weapon, key)) }
    }
    fn cartridge_of(weapon: &Value, ammo: &str, key: &str) -> f64 {
        if weapon["allowedAmmo"][0] == ammo { number(&weapon["cartridge"], key) }
        else { weapon["rounds"][ammo]["cartridge"][key].as_f64().unwrap_or_else(|| number(&weapon["cartridge"], key)) }
    }

    #[test]
    fn how_each_round_is_made_is_part_of_its_name_and_of_its_cartridge() {
        assert_eq!(parse("rh120|T1|O90|S40|E25"), Ok(("rh120", Custom { core: Some(1), cone: Some(90), standoff: Some(40), fill: Some(25), ..Custom::default() })));
        for bad in ["rh120|O90|T1", "rh120|R50|E25", "rh120|E25|P120"] { assert!(parse(bad).is_err(), "{bad}"); }
        // Names made before stand as they were.
        assert_eq!(cartridge("m2hb|L140|D145|C110|P120|R50|N3|M200"), "m2hb|D145|C110|P120");
        assert_eq!(cartridge("m2hb|L140|D145|C110|P120|T2|R50|N3|M200"), "m2hb|D145|C110|P120|T2");
        assert_eq!(cartridge("rh120|T1|O90|S40|E25|M22|V1"), "rh120|T1|O90|S40|E25");
        // What the reference makes is no change; what it does not fire, or makes of nothing it has, may not be asked.
        for bad in ["rh120|T2", "rh120|O80", "rh120|S15", "rh120|E11", "rh120|T3", "rh120|O95", "rh120|S85", "rh120|E31", "rh120|E4",
            "m777|T1", "m2hb|O90", "m2hb|E20", "m777|S40", "minimi|E10", "rh120|O92"] {
            assert!(refused(bad), "{bad}");
        }
        let made = made("rh120|T1|O90|S40|E25");
        assert_eq!(made["made"]["core"], 1);
        assert_eq!(made["made"]["fill"], 25);
    }

    #[test]
    fn a_penetrator_of_steel_is_lighter_and_faster_and_pierces_less_and_one_of_tungsten_the_other_way() {
        let (tungsten, steel) = (catalogue()["rh120"].clone(), made("rh120|T1"));
        // The rod is of the same shape: some 4.3 kg of tungsten, 1.9 of steel, leaving the rest of the round as it was.
        let lighter = number(&steel, "mass") / number(&tungsten, "mass");
        near(lighter, 1.0 - 0.52 * 8.35 / 5.0 * (1.0 - 7850.0 / 17600.0), 1e-9, "in flight");
        assert!(number(&steel, "speed") > number(&tungsten, "speed") * 1.1);
        // Lanz and Odermatt: a tungsten rod pierces 1.7–2.3 times a steel one at the same speed; the faster steel rod, less
        // than that short of it.
        let pierced = number(&steel, "power") / number(&tungsten, "power");
        assert!(pierced > 1.0 / 2.3 && pierced < 1.0 / 1.2, "{pierced}");
        let at = |speed: f64, core: &Core| core.fit * sqrt(core.density / LONG_ROD_TARGET) * exp(-core.strength / (core.density * speed * speed));
        near(pierced, at(number(&steel, "speed"), &CORES[0]) / at(1650.0, &CORES[1]), 1e-9, "Lanz–Odermatt");
        // At 1.5 km/s, as Odermatt's fit has them, the rods of 500 by 25 mm: 424 and 226 mm.
        near(at(1500.0, &CORES[0]) / at(1500.0, &CORES[1]), 226.0 / 424.0, 0.01, "the same rod in steel");
        // Its cartridge is lighter and cheaper by its tungsten; the other rounds are as they were.
        assert!(number(&steel["cartridge"], "massKg") < 21.0 && number(&steel["cartridge"], "costCredits") < 260.0);
        assert_eq!(cartridge_of(&steel, "heat", "costCredits"), 200.0);
        assert_eq!(round(&steel, "heat", "mass"), 5.0);
        assert!(steel["figures"]["rounds"]["apfsds"]["pierceMm"]["at1000"].as_f64() < tungsten_figures("rh120")["rounds"]["apfsds"]["pierceMm"]["at1000"].as_f64());
        // The core of a full-calibre bullet, by De Marre: a tungsten one is heavier, slower, pierces more and costs more.
        let (plain, dense) = (catalogue()["m2hb"].clone(), made("m2hb|T2"));
        assert!(number(&dense, "mass") > number(&plain, "mass") && number(&dense, "speed") < number(&plain, "speed"));
        let quicker = number(&dense, "speed") / number(&plain, "speed");
        near(number(&dense, "power") / number(&plain, "power"), pow(17600.0 / 7850.0 * quicker * quicker, 0.5 / DE_MARRE), 1e-9, "De Marre");
        assert!(number(&dense["cartridge"], "costCredits") > 1.5 * number(&plain["cartridge"], "costCredits"));
        // Heavier and slower, it carries more momentum and pushes the gun back harder; the lighter steel rod, less.
        let pushed = |weapon: &Value| number(&weapon["figures"], "recoilNs");
        assert!(pushed(&dense) > number(&tungsten_figures("m2hb"), "recoilNs"));
        assert!(pushed(&steel) < number(&tungsten_figures("rh120"), "recoilNs"));
    }
    fn tungsten_figures(id: &str) -> Value { figures(&catalogue()[id]).unwrap() }

    #[test]
    fn a_shaped_charge_pierces_by_its_cone_and_the_standoff_it_bursts_at() {
        let plain = catalogue()["rh120"].clone();
        let pierce = |weapon: &Value| round(weapon, "heat", "power");
        // A cone of 90 % of the calibre against 80 %: as much more, and more explosive and liner to carry.
        let wide = made("rh120|O90");
        near(pierce(&wide) / pierce(&plain), 90.0 / 80.0, 1e-9, "cone");
        assert!(round(&wide, "heat", "mass") > round(&plain, "heat", "mass") && cartridge_of(&wide, "heat", "costCredits") > 200.0);
        // Bursting 4 cone diameters off against 1.5: Sandia's 5.7 against the 4.95 between 4.7 and 5.2; and its probe makes
        // the round longer, the jet no heavier.
        let long = made("rh120|S40");
        near(pierce(&long) / pierce(&plain), 5.7 / 4.95, 1e-9, "standoff");
        assert!(cartridge_of(&long, "heat", "litres") > 12.0 * 1.15);
        near(pierce(&made("rh120|S5")) / pierce(&plain), (3.7 + 0.5 * (4.7 - 3.7)) / 4.95, 1e-9, "close");
        // Past six diameters the jet breaks up.
        assert!(pierce(&made("rh120|S80")) < pierce(&made("rh120|S60")));
        assert_eq!(made("rh120|O90")["figures"]["rounds"]["heat"]["pierceMm"]["any"].as_f64().map(f64::round), Some((600.0 * 90.0 / 80.0 / 1.25_f64).round()));
    }

    #[test]
    fn more_explosive_in_a_shell_bursts_wider_and_its_thinner_case_throws_its_fragments_less_far() {
        let plain = catalogue()["m777"].clone();
        let (blast, frag) = (made("m777|E30"), made("m777|E8"));
        // Of the same shape, a shell of more explosive is lighter by the steel it displaces, and one of less heavier.
        assert!(number(&blast, "mass") < number(&plain, "mass") && number(&frag, "mass") > number(&plain, "mass"));
        assert!(number(&blast["cartridge"], "massKg") < 46.0 && number(&frag["cartridge"], "massKg") > 46.0);
        // It bursts as the cube root of the bare charge it is worth (NAVFAC), and throws its fragments as far as their size.
        assert!(number(&blast, "blastRadius") > 7.2 && number(&frag, "blastRadius") < 7.2);
        let reach = |weapon: &Value| weapon["figures"]["rounds"]["he"]["fragmentsM"].as_f64().unwrap();
        let mortar = |id: &str| reach(&made(id)) / number(&made(id), "blastRadius");
        assert!(mortar("m252|E30") < 4.0 && mortar("m252|E8") > 4.0);
        assert!(number(&blast, "fragmentReach") < 1.0 && number(&frag, "fragmentReach") > 1.0);
        // The share of its burst its fragments carry follows the energy Gurney gives its case.
        let (fill, fill0) = (0.30, 0.23);
        let room = |fill: f64| fill / EXPLOSIVE_DENSITY + (1.0 - fill) / CASE_DENSITY;
        let explosive = fill * room(fill0) / room(fill) / fill0;
        let wider = pow(explosive * bare(fill) / bare(fill0), 1.0 / 3.0);
        near(number(&blast, "blastRadius") / 7.2, wider, 1e-9, "burst");
        near(number(&blast, "fragments"), 0.5 * explosive * gurney(fill) / gurney(fill0) / wider, 1e-9, "fragments");
        // A round of another kind of the gun keeps its own: the Rh-120's shell bursts wider, its rod as it was.
        let shell = made("rh120|E25");
        assert!(round(&shell, "he", "blastRadius") > 1.75 && round(&shell, "he", "fragments") > 0.0);
        assert_eq!(number(&shell, "blastRadius"), 1.75);
        assert!(shell.get("fragments").is_none());
    }

    #[test]
    fn the_workshop_offers_how_each_round_it_fires_is_made_and_keeps_it_where_it_still_fires_it() {
        let catalogue = catalogue();
        let options_of = |id: &str| { let (base, custom) = parse(id).unwrap(); options(&catalogue[base], custom, catalogue).unwrap() };
        let tank = options_of("rh120");
        assert_eq!(tank["core"], json!({"choices":[1, 2],"names":["steel", "tungsten"],"base":2}));
        assert_eq!((tank["cone"]["min"].as_u64(), tank["cone"]["max"].as_u64(), tank["cone"]["base"].as_u64()), (Some(50), Some(90), Some(80)));
        assert_eq!((tank["standoff"]["min"].as_u64(), tank["standoff"]["base"].as_u64()), (Some(5), Some(15)));
        assert_eq!((tank["fill"]["min"].as_u64(), tank["fill"]["max"].as_u64(), tank["fill"]["base"].as_u64()), (Some(5), Some(30), Some(11)));
        let gun = options_of("m2hb");
        assert_eq!(gun["core"]["base"], 1);
        assert!(gun["cone"].is_null() && gun["fill"].is_null());
        let howitzer = options_of("m777");
        assert!(howitzer["core"].is_null() && howitzer["cone"].is_null() && howitzer["fill"]["base"] == 23);
        // Bored to 30 mm the tank gun is an autocannon that fires its shell alone: it keeps its shell as made, not its cone.
        let asked = request(&json!({"base":catalogue["rh120"],"families":catalogue,"id":"rh120|O90|E25","calibre":300})).unwrap();
        let id = asked["id"].as_str().unwrap();
        assert!(id.contains("|E25") && !id.contains("|O90"), "{id}");
        assert!(options_of("rh120|O90")["calibres"].as_array().unwrap().contains(&json!(300)));
        // Asked as the workshop asks, every setting with it, the reference's own are none.
        let asked = request(&json!({"base":catalogue["rh120"],"families":catalogue,"custom":{"core":2,"cone":80,"standoff":15,"fill":20}})).unwrap();
        assert_eq!(asked["id"], "rh120|E20");
        assert_eq!(asked["cartridge"], "rh120|E20");
        // What the workshop shows of each round it fires.
        let shown = &asked["weapon"]["figures"]["rounds"];
        assert!(shown["apfsds"]["pierceMm"]["at500"].as_f64().unwrap() > shown["apfsds"]["pierceMm"]["at1000"].as_f64().unwrap());
        assert!(shown["he"]["blastM"].as_f64().unwrap() > 1.75 && shown["he"]["fragmentsM"].as_f64().unwrap() > 0.0);
        assert!(shown["heat"]["speed"].as_f64().unwrap() > 0.0 && shown["heat"]["costCredits"] == 200.0);
    }
}
