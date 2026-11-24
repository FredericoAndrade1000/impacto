//! Borrowed presentation packets. Authoritative/cold snapshots stay in GameState::frame.
use crate::game_geometry::ComponentKind;
use super::*;
use crate::game_damage::{BarrelMark, Dent, Mark, Perforation};
use crate::game_dto::{NativeVehicle, VehicleWords, VEHICLE_NUMBERS};
use crate::game_geometry::TerrainSupport;
use serde::{
    Deserialize, Serialize, Serializer,
    ser::{SerializeMap, SerializeSeq},
};

// Maps and iterators write directly to the output string, without a Value tree.
macro_rules! fields {
    ($serializer:expr, {$($key:literal => $value:expr),* $(,)?}) => {{
        let mut map = $serializer.serialize_map(None)?;
        $(map.serialize_entry($key, &$value)?;)*
        map.end()
    }};
}
struct Seq<I>(I);
impl<I: Iterator + Clone> Serialize for Seq<I>
where
    I::Item: Serialize,
{
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let (min, max) = self.0.size_hint();
        let mut seq = serializer.serialize_seq(max.filter(|n| *n == min))?;
        for item in self.0.clone() {
            seq.serialize_element(&item)?;
        }
        seq.end()
    }
}
impl Serialize for Point {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"x" => self.x, "y" => self.y})
    }
}
impl Serialize for Pose {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"x" => self.x, "y" => self.y, "angle" => self.angle})
    }
}
impl Serialize for Bounds {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"minX" => self.min_x, "maxX" => self.max_x, "minY" => self.min_y, "maxY" => self.max_y})
    }
}

/// What the host was last told of each actor and module in words, and of each actor, plate
/// and module in numbers. What would be told again alike is left out of a frame: a
/// construction that stands still costs the host nothing to read.
///
/// A live frame tells what changes at every step — where a part is, how its springs give,
/// where its wheels touch, how its vehicle goes — as numbers in a block the host takes
/// beside the words (`GameState::take_block`), and the rest as words. The block holds,
/// for each frame that told any, the actors, the plates and the modules, each list behind
/// how many records it has:
/// - an actor: its handle, how many numbers follow, then `actor_numbers`;
/// - a plate: its owner and its pose, `PLATE_NUMBERS` in all;
/// - a module: its owner, what it has (`ModuleNumbers`), then `MODULE_NUMBERS` numbers.
#[derive(Clone, Default, Serialize, Deserialize)]
pub(super) struct Told {
    actors: Vec<Vec<u8>>,
    modules: Vec<Vec<u8>>,
    actor_numbers: Vec<Vec<f64>>,
    plate_numbers: Vec<Vec<f64>>,
    module_numbers: Vec<Vec<f64>>,
}
/// A plate's record: its owner, then x, y and angle.
pub(super) const PLATE_NUMBERS: usize = 4;
/// The numbers of a module's record after its owner and what it has.
pub(super) const MODULE_NUMBERS: usize = 37;
/// What a module has, which says which of its numbers mean anything (rust-game.ts reads the same bits).
pub(super) struct ModuleNumbers;
impl ModuleNumbers {
    pub(super) const MOUNT: u32 = 1;
    pub(super) const FUEL: u32 = 2;
    pub(super) const AMMO: u32 = 4;
    pub(super) const THRUSTER: u32 = 8;
    pub(super) const SERVO: u32 = 16;
    pub(super) const GEAR: u32 = 32;
    pub(super) const CONTACT: u32 = 64;
    pub(super) const SUSPENSION: u32 = 128;
}
/// Appends to `block` how many entries changed their numbers, then their records, and
/// remembers them. `write` puts an entry's owner first; a record of no fixed length is told
/// with how many numbers follow the owner.
fn changed_numbers<T>(block: &mut Vec<f64>, told: &mut Vec<Vec<f64>>, entries: impl Iterator<Item = T>, sized: bool,
    mut write: impl FnMut(&T, &mut Vec<f64>)) {
    let at = block.len();
    block.push(0.0);
    let (mut numbers, mut changed, mut count) = (Vec::new(), 0usize, 0usize);
    for (i, entry) in entries.enumerate() {
        numbers.clear();
        write(&entry, &mut numbers);
        if told.len() <= i {
            told.push(Vec::new());
        }
        // To the bit, owner included: an entry that took another's place is another entry.
        let same = told[i].len() == numbers.len() && told[i].iter().zip(&numbers).all(|(a, b)| a.to_bits() == b.to_bits());
        if !same {
            block.push(numbers[0]);
            if sized {
                block.push((numbers.len() - 1) as f64);
            }
            block.extend_from_slice(&numbers[1..]);
            told[i].clone_from(&numbers);
            changed += 1;
        }
        count = i + 1;
    }
    told.truncate(count);
    block[at] = changed as f64;
}
/// An actor's numbers, behind its handle: its cooldown, where it aims, how many it fired,
/// whether it has a vehicle and that vehicle's numbers (`NativeVehicle::numbers`), then how
/// many eyes it sees with and each eye's x, y, left and right.
fn actor_numbers(a: &Actor, out: &mut Vec<f64>) {
    out.extend([a.handle as f64, a.cooldown, a.aim.x, a.aim.y, a.shots as f64]);
    match a.drive.as_ref() {
        Some(d) => {
            out.push(1.0);
            let at = out.len();
            NativeVehicle::new(d, &a.powertrain).numbers(out);
            debug_assert_eq!(out.len() - at, VEHICLE_NUMBERS);
        }
        None => out.push(0.0),
    }
    out.push(a.eyes.len() as f64);
    for e in &a.eyes {
        out.extend([e.x, e.y, e.left, e.right]);
    }
}
/// A module's numbers, behind its owner and what it has; what it does not have is told as 0.
fn module_numbers(m: &Module, export: &ModuleExport, game: &GameState, out: &mut Vec<f64>) {
    let servo = export.servo.map(|i| &game.servos[i]);
    let contact = export.gear.and_then(|i| game.gears[i].ground_contact.as_ref());
    let suspension = export.suspension.map(|i| &game.gear_bindings[i]);
    let (mount, fuel, ammo, thruster) = (m.mount.is_some(), m.kind == ComponentKind::Fuel, m.kind == ComponentKind::Ammo,
        m.kind == ComponentKind::Thruster);
    let mut has = 0u32;
    for (yes, bit) in [(mount, ModuleNumbers::MOUNT), (fuel, ModuleNumbers::FUEL), (ammo, ModuleNumbers::AMMO),
        (thruster, ModuleNumbers::THRUSTER), (servo.is_some(), ModuleNumbers::SERVO), (export.gear.is_some(), ModuleNumbers::GEAR),
        (contact.is_some(), ModuleNumbers::CONTACT), (suspension.is_some(), ModuleNumbers::SUSPENSION)] {
        if yes {
            has |= bit;
        }
    }
    let (when, at) = (|yes: bool, value: f64| if yes { value } else { 0.0 }, out.len());
    out.extend([m.owner as f64, has as f64, m.pose.x, m.pose.y, m.pose.angle, m.barrel_angle, m.health, m.physical_mass,
        m.physical_inertia, m.burn_age, m.fire_age, m.ground_marks as f64, m.ground_damage,
        when(mount, angle_difference(m.barrel_angle, m.pose.angle)), when(fuel, m.fuel_litres), when(ammo, m.rounds as f64),
        when(thruster, m.thrust)]);
    // Of a gun: where it is being laid, how its servo turns, its reload, the heat of its barrel, the rounds ready in its
    // feed and how long until its feed is loaded again (`ServoState::feed_left`).
    match servo {
        Some(s) => out.extend([when(mount, angle_difference(s.target, m.pose.angle)), s.velocity, s.target, s.reload.max(0.0), s.barrel.temperature,
            f64::from(s.loaded), s.feed_left()]),
        None => out.extend([0.0; 7]),
    }
    match contact {
        Some(c) => out.extend([c.normal.x, c.normal.y, c.tangent.x, c.tangent.y, c.point.x, c.point.y, c.contacts as f64, c.min_x, c.max_x]),
        None => out.extend([0.0; 9]),
    }
    match suspension {
        Some(b) => out.extend([b.travel, b.displacement, b.tilt, b.compression, b.angle, b.angular_speed]),
        None => out.extend([0.0; 6]),
    }
    debug_assert_eq!(out.len() - at, 2 + MODULE_NUMBERS);
}
fn plate_numbers(p: &Plate, out: &mut Vec<f64>) {
    let numbers: [f64; PLATE_NUMBERS] = [p.owner as f64, p.pose.x, p.pose.y, p.pose.angle];
    out.extend(numbers);
}
/// Appends `,"key":[...]` with the entries whose words changed, and remembers them.
fn changed<T: Serialize>(text: &mut String, key: &str, told: &mut Vec<Vec<u8>>, entries: impl Iterator<Item = T>) -> Result<(), String> {
    text.push_str(",\"");
    text.push_str(key);
    text.push_str("\":[");
    let (mut words, mut count, mut first) = (Vec::new(), 0, true);
    for (i, entry) in entries.enumerate() {
        words.clear();
        serde_json::to_writer(&mut words, &entry).map_err(|e| e.to_string())?;
        if told.len() <= i {
            told.push(Vec::new());
        }
        if told[i] != words {
            if !first {
                text.push(',');
            }
            first = false;
            // The serializer wrote UTF-8.
            text.push_str(std::str::from_utf8(&words).map_err(|e| e.to_string())?);
            told[i].clone_from(&words);
        }
        count = i + 1;
    }
    told.truncate(count);
    text.push(']');
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
pub(super) struct ModuleExport {
    revision: u64,
    barrels: Vec<[u64; 3]>,
    servo: Option<usize>,
    gear: Option<usize>,
    suspension: Option<usize>,
}
impl ModuleExport {
    pub(super) fn new(
        owner: u32,
        servos: &[ServoState],
        gears: &[GearState],
        bindings: &[GearBinding],
    ) -> Self {
        Self {
            revision: u64::MAX,
            barrels: Vec::new(),
            servo: servos.iter().position(|s| s.owner == owner),
            gear: gears.iter().position(|s| s.owner == owner),
            suspension: bindings.iter().position(|s| s.owner == owner),
        }
    }
    /// Finds its servo, its gear and its springs where they stand once others left.
    pub(super) fn place(&mut self, owner: u32, servos: &[ServoState], gears: &[GearState], bindings: &[GearBinding]) {
        self.servo = servos.iter().position(|s| s.owner == owner);
        self.gear = gears.iter().position(|s| s.owner == owner);
        self.suspension = bindings.iter().position(|s| s.owner == owner);
    }
    fn changed(&self, m: &Module) -> bool {
        self.revision != m.mark_revision
            || self.barrels.len() != m.barrel_marks.len()
            || self
                .barrels
                .iter()
                .zip(&m.barrel_marks)
                .any(|(a, b)| *a != barrel_bits(b))
    }
    fn commit(&mut self, m: &Module) {
        self.revision = m.mark_revision;
        self.barrels.clear();
        self.barrels.extend(m.barrel_marks.iter().map(barrel_bits));
    }
}
fn barrel_bits(m: &BarrelMark) -> [u64; 3] {
    [m.point.x.to_bits(), m.point.y.to_bits(), m.radius.to_bits()]
}

#[derive(Serialize)]
struct Trigger<'a> {
    aim: Point,
    config: &'a Value,
}
#[derive(Serialize)]
struct Pending<'a> {
    aim: Point,
    settings: &'a Value,
    expires: f64,
}
#[derive(Serialize)]
struct Also<'a> {
    aim: Point,
    config: &'a Value,
    held: bool,
    expires: Option<f64>,
}
/// An actor's words in a live frame; its numbers go in the block (`actor_numbers`).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ActorWords<'a> {
    id: &'a str,
    last_weapon: &'a str,
    weapon: Option<&'a Value>,
    trigger: Option<Trigger<'a>>,
    pending_shot: Option<Pending<'a>>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    also: Vec<Also<'a>>,
    vehicle: Option<VehicleWords>,
}
impl<'a> From<&'a Actor> for ActorWords<'a> {
    fn from(a: &'a Actor) -> Self {
        Self {
            id: &a.id,
            last_weapon: &a.last_weapon,
            weapon: a.weapon.as_ref().map(|w| &w.value),
            trigger: a.trigger.as_ref().map(|(aim, w)| Trigger {
                aim: *aim,
                config: &w.value,
            }),
            pending_shot: a.pending.as_ref().map(|(aim, w, expires)| Pending {
                aim: *aim,
                settings: &w.value,
                expires: *expires,
            }),
            also: a.also.iter().map(|e| Also {
                aim: e.aim,
                config: &e.settings.value,
                held: e.held,
                expires: e.pending,
            }).collect(),
            vehicle: a.drive.as_ref().map(|d| NativeVehicle::new(d, &a.powertrain).words()),
        }
    }
}
struct MarkFrame<'a>(&'a Mark, bool);
impl Serialize for MarkFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let m = self.0;
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("u", &m.uv.x)?;
        map.serialize_entry("v", &m.uv.y)?;
        map.serialize_entry("kind", m.kind)?;
        map.serialize_entry("strength", &m.strength)?;
        if let Some(part)=m.part {map.serialize_entry("part",&part)?;}
        if self.1 {
            map.serialize_entry("radiusU", &m.radius)?;
        } else {
            map.serialize_entry("depth", &m.depth)?;
            map.serialize_entry("radius", &m.radius)?;
        }
        map.end()
    }
}
struct DentFrame<'a>(&'a Dent);
impl Serialize for DentFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"u" => self.0.uv.x, "v" => self.0.uv.y, "depth" => self.0.depth, "radius" => self.0.radius})
    }
}
struct PerforationFrame<'a>(&'a Perforation);
impl Serialize for PerforationFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"u" => self.0.u, "radius" => self.0.radius})
    }
}
struct PlateDamage<'a> {
    plate: &'a Plate,
    geometry: bool,
    marks: bool,
}
impl Serialize for PlateDamage<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let p = self.plate;
        let mut map = s.serialize_map(None)?;
        map.serialize_entry("revision", &p.revision)?;
        map.serialize_entry("markRevision", &p.mark_revision)?;
        map.serialize_entry("groundMarks", &p.ground_marks)?;
        map.serialize_entry("massScale", &p.mass_scale)?;
        map.serialize_entry("physicalMass", &p.physical_mass)?;
        map.serialize_entry("physicalInertia", &p.physical_inertia)?;
        map.serialize_entry("physicalCenterLocal", &p.physical_center)?;
        if self.geometry {
            map.serialize_entry("ballisticGrid", &p.grid.to_value())?;
            map.serialize_entry(
                "perforations",
                &Seq(p.perforations.iter().map(PerforationFrame)),
            )?;
        }
        if self.marks {
            map.serialize_entry("marks", &Seq(p.marks.iter().map(|m| MarkFrame(m, false))))?;
            map.serialize_entry("dents", &Seq(p.dents.values().map(DentFrame)))?;
        }
        map.end()
    }
}
/// A plate's words in a live frame, told only when its damage changed; where it is goes in the block.
#[derive(Serialize)]
struct PlateWords<'a> {
    owner: u32,
    damage: PlateDamage<'a>,
}
impl<'a> PlateWords<'a> {
    fn new(p: &'a Plate, b: &Binding) -> Option<Self> {
        let geometry = b.last_revision != p.revision;
        let marks = b.last_marks != p.mark_revision;
        (geometry || marks).then_some(Self { owner: p.owner, damage: PlateDamage { plate: p, geometry, marks } })
    }
}

struct Materials<'a>(&'a TerrainSupport);
impl Serialize for Materials<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.material_order.len()))?;
        for material in &self.0.material_order {
            map.serialize_entry(material.name(), &self.0.materials[*material as usize])?;
        }
        map.end()
    }
}
struct BarrelFrame<'a>(&'a BarrelMark);
impl Serialize for BarrelFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        fields!(s, {"x" => self.0.point.x, "y" => self.0.point.y, "radius" => self.0.radius})
    }
}
struct Scars<'a>(&'a Module);
impl Serialize for Scars<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let mut map = s.serialize_map(Some(self.0.ballistic_scars.len()))?;
        for (key, value) in &self.0.ballistic_scars {
            map.serialize_entry(&format!("{}:{}", key / 32, key % 32), value)?;
        }
        map.end()
    }
}
/// A module's words in a live frame: what changes by events, not by steps. Its numbers go
/// in the block (`module_numbers`), but for the kinds of ground its wheel stands on.
struct ModuleWords<'a> {
    module: &'a Module,
    export: &'a ModuleExport,
    game: &'a GameState,
}
impl Serialize for ModuleWords<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let m = self.module;
        let mut map = s.serialize_map(None)?;
        macro_rules! put { ($($key:literal => $value:expr),* $(,)?) => { $(map.serialize_entry($key, &$value)?;)* }; }
        put! {"owner" => m.owner, "dryMass" => m.dry_mass, "attached" => m.attached,
        "detonated" => m.detonated, "burning" => m.burning, "barrelDamage" => m.barrel_damage,
        "barrelDisabled" => m.barrel_disabled, "elevationDamage"=>m.elevation_damage,"elevationDisabled"=>m.elevation_disabled,
        "beltCut" => m.belt_cut, "markRevision" => m.mark_revision }
        // Whether a pilot waits for its barrel to cool: how hot it is goes in the block.
        if let Some(servo) = self.export.servo.map(|i| &self.game.servos[i]).filter(|s| s.barrel.steel.heats()) {
            put! {"barrelCooling" => servo.barrel.cooling}
        }
        if m.kind == ComponentKind::Fuel {
            put! {"capacityLitres" => m.capacity_litres}
        }
        if m.kind == ComponentKind::Ammo {
            put! {"capacityRounds" => m.capacity_rounds}
        }
        if m.kind.carrier() {
            put! {"cargo" => m.cargo_value(), "capacityM3" => m.cargo_room}
        }
        if self.export.changed(m) {
            put! {"marks" => Seq(m.marks.iter().map(|m| MarkFrame(m, true))),
            "barrelMarks" => Seq(m.barrel_marks.iter().map(BarrelFrame)), "ballisticScars" => Scars(m)}
            if m.mount.is_some() {
                put! {"mantletHoles"=>m.holes_value(),"materialPolygons"=>m.local_polygons().iter().map(|p|p.iter().map(|p|p.to_value()).collect::<Vec<_>>()).collect::<Vec<_>>()}
            }
        }
        if let Some(contact) = self.export.gear.and_then(|i| self.game.gears[i].ground_contact.as_ref()) {
            put! {"groundMaterials" => Materials(contact)}
        }
        map.end()
    }
}

/// The kinds of round the host has not been told of yet, and where they go in its legend.
struct KindsFrame<'a>(&'a ProjectileState, usize);
impl Serialize for KindsFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let (state, from) = (self.0, self.1.min(self.0.kinds.len()));
        fields!(s, {"from" => from, "list" => Seq(state.kinds[from..].iter().map(|kind| kind.to_value()))})
    }
}
struct HotFrame<'a> {
    game: &'a GameState,
}
impl Serialize for HotFrame<'_> {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let g = self.game;
        fields!(s, {"time" => g.time, "tick" => g.tick, "nextId" => g.projectiles.next_id,
            "randomState" => g.projectiles.random.state, "recoveries" => g.recoveries,
            // Actors, plates and modules follow, each list with what changed: see `serialize_frame`.
            // The rounds themselves are fetched as a block of words; here, how many there are and the kinds new to the host.
            "shots" => g.projectiles.projectiles.len(), "shotKinds" => KindsFrame(&g.projectiles, g.projectiles.kinds_told),
            "stats" => g.damage.stats,
            "tows" => g.tow_frame(),
            "events" => g.events})
    }
}
#[derive(Serialize)]
struct Response<'a> {
    result: &'a Value,
    // Last: a frame is appended to these words in its place.
    frame: Option<()>,
}

impl GameState {
    pub fn frame_json(&mut self) -> Result<String, String> {
        self.serialize_frame(None)
    }
    pub fn command_frame_json(&mut self, result: &Value, query: bool) -> Result<String, String> {
        if query {
            return serde_json::to_string(&Response {
                result,
                frame: None,
            })
            .map_err(|e| e.to_string());
        }
        self.serialize_frame(Some(result))
    }
    fn serialize_frame(&mut self, result: Option<&Value>) -> Result<String, String> {
        self.projectiles.publish_kinds();
        let (mut told, mut block) = (std::mem::take(&mut self.told), Vec::new());
        let written = self.write_frame(result, &mut told, &mut block);
        // Words that failed half way were told to nobody: the next frame tells everything.
        self.told = if written.is_ok() { told } else { Told::default() };
        let output = written?;
        self.frame_block = block;
        // Commit export revisions only after a successful transfer.
        for b in &mut self.bindings {
            if let Some(p) = self.damage.plate(b.owner) {
                b.last_revision = p.revision;
                b.last_marks = p.mark_revision;
            }
        }
        for (export, m) in self.module_exports.iter_mut().zip(&self.damage.modules) {
            if export.changed(m) {
                export.commit(m);
            }
        }
        self.events.clear();
        self.projectiles.kinds_told = self.projectiles.kinds.len();
        Ok(output)
    }
    fn write_frame(&self, result: Option<&Value>, told: &mut Told, block: &mut Vec<f64>) -> Result<String, String> {
        let mut text = String::new();
        if let Some(result) = result {
            text = serde_json::to_string(&Response { result, frame: None })
                .map_err(|e| e.to_string())?;
            // `"frame":null}` gives its place to the frame.
            text.truncate(text.len() - "null}".len());
        }
        text.push_str(&serde_json::to_string(&HotFrame { game: self }).map_err(|e| e.to_string())?);
        text.pop();
        changed(&mut text, "actors", &mut told.actors, self.actors.iter().map(ActorWords::from))?;
        listed(&mut text, "plates", self.bindings.iter().filter_map(|b| self.damage.plate(b.owner).and_then(|p| PlateWords::new(p, b))))?;
        changed(&mut text, "modules", &mut told.modules,
            self.damage.modules.iter().zip(&self.module_exports).map(|(module, export)| ModuleWords { module, export, game: self }))?;
        let plates = self.bindings.iter().filter_map(|b| self.damage.plate(b.owner));
        changed_numbers(block, &mut told.actor_numbers, self.actors.iter(), true, |a, out| actor_numbers(a, out));
        changed_numbers(block, &mut told.plate_numbers, plates, false, |p, out| plate_numbers(p, out));
        changed_numbers(block, &mut told.module_numbers, self.damage.modules.iter().zip(&self.module_exports), false,
            |(m, export), out| module_numbers(m, export, self, out));
        // Whether the host has numbers to take beside these words: three lists of none tell nothing.
        text.push_str(if block.len() > 3 { ",\"block\":true}" } else { ",\"block\":false}" });
        if result.is_some() {
            text.push('}');
        }
        Ok(text)
    }
    /// The numbers of the last live frame (`Told`), once.
    pub fn take_block(&mut self) -> Vec<f64> {
        std::mem::take(&mut self.frame_block)
    }
}
/// The eyes each actor of a frame's block was told with, by handle (see `actor_numbers`).
#[cfg(test)]
pub(super) fn told_eyes(block: &[f64]) -> Vec<(u32, Vec<crate::game_sensors::Eye>)> {
    let (mut at, mut told) = (1, Vec::new());
    for _ in 0..block[0] as usize {
        let (handle, length) = (block[at] as u32, block[at + 1] as usize);
        let numbers = &block[at + 2..at + 2 + length];
        let first = 6 + if numbers[4] == 1.0 { VEHICLE_NUMBERS } else { 0 };
        let eyes = numbers[first..].chunks(4).map(|e| crate::game_sensors::Eye { x: e[0], y: e[1], left: e[2], right: e[3] });
        assert_eq!(numbers[first - 1] as usize * 4, length - first);
        told.push((handle, eyes.collect()));
        at += 2 + length;
    }
    told
}
/// Appends `,"key":[...]` with every entry.
fn listed<T: Serialize>(text: &mut String, key: &str, entries: impl Iterator<Item = T>) -> Result<(), String> {
    text.push_str(",\"");
    text.push_str(key);
    text.push_str("\":[");
    for (i, entry) in entries.enumerate() {
        if i > 0 {
            text.push(',');
        }
        text.push_str(&serde_json::to_string(&entry).map_err(|e| e.to_string())?);
    }
    text.push(']');
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn scene() -> GameState {
        let core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        let plate=crate::game_damage::fixtures::plate(10,1,&json!({"definition":{"id":"armor","x":0.0,"y":1.0,"length":2.0,"angle":0.0,"thicknessMm":30,"material":"steel"},"blueprint":"cold-only"})).to_value();
        GameState::from_value(&json!({"terrain":"flat","bounds":{"minX":-20,"maxX":20,"minY":-5,"maxY":20},
            "actors":[{"id":"local","handle":1,"vehicle":{"x":0,"y":1,"mass":4000},
                "contactContours":[[{"x":-1,"y":-1},{"x":1,"y":-1},{"x":1,"y":1},{"x":-1,"y":1}]]}],"plates":[plate],
            "modules":[{"owner":20,"actor":1,"id":"engine","kind":"engine","x":0,"y":2,"blueprint":"cold-only"}],
            "projectiles":[]}),&core).unwrap()
    }
    fn packet(game: &mut GameState) -> Value {
        serde_json::from_str(&game.frame_json().unwrap()).unwrap()
    }
    /// The actors', plates' and modules' records of a frame's block (`Told`).
    fn read_block(block: &[f64]) -> [Vec<Vec<f64>>; 3] {
        let (mut at, mut lists) = (0, [Vec::new(), Vec::new(), Vec::new()]);
        for (list, out) in lists.iter_mut().enumerate() {
            let count = block[at] as usize;
            at += 1;
            for _ in 0..count {
                let length = match list { 0 => 2 + block[at + 1] as usize, 1 => PLATE_NUMBERS, _ => 2 + MODULE_NUMBERS };
                out.push(block[at..at + length].to_vec());
                at += length;
            }
        }
        assert_eq!(at, block.len());
        lists
    }
    #[test]
    fn presentation_deltas_preserve_marks_mass_and_complete_cold_snapshots() {
        let mut game = scene();
        let admitted_mass = game.damage.plate(10).unwrap().mass();
        let first = packet(&mut game);
        assert!(first["actors"][0].get("contactContours").is_none());
        assert!(first["plates"][0].get("motion").is_none());
        assert!(first["plates"][0]["damage"]["ballisticGrid"].is_object());
        assert!(first["plates"][0]["damage"].get("wear").is_none());
        assert_eq!(first["plates"][0]["damage"]["physicalMass"], admitted_mass);
        assert!(first["plates"][0]["damage"]["physicalCenterLocal"].is_object());
        assert!(first["modules"][0]["marks"].is_array());
        assert!(first["modules"][0].get("blueprint").is_none());
        assert!(first["plates"][0]["damage"].get("positions").is_none());
        game.take_block();
        let unchanged = packet(&mut game);
        assert_eq!(unchanged["plates"], json!([]), "a plate whose damage stands has no words to tell");
        assert!(unchanged["modules"][0].get("marks").is_none());
        assert_eq!(unchanged["block"], false, "and nothing moved");
        // Told twice in different words, with and without its damage; in the same words, never again.
        let still = packet(&mut game);
        assert_eq!([&still["actors"], &still["plates"], &still["modules"]], [&json!([]), &json!([]), &json!([])]);
        // Internal motion alone changes the cold record, without a gameplay step or a visual delta.
        let before_motion = game.frame()["plates"][0].clone();
        game.damage.plate_mut(10).unwrap().velocity = Point::new(3.125, -0.75);
        let (sleeping, age) = {
            let binding = game.bindings.iter_mut().find(|b| b.owner == 10).unwrap();
            binding.sleeping = !binding.sleeping;
            binding.age += 0.25;
            (binding.sleeping, binding.age)
        };
        let motion_only = packet(&mut game);
        assert_eq!([&motion_only["actors"], &motion_only["plates"], &motion_only["modules"]], [&json!([]), &json!([]), &json!([])]);
        let cold_motion = game.frame()["plates"][0].clone();
        assert_eq!(cold_motion["pose"], before_motion["pose"]);
        assert_eq!(cold_motion["damage"], before_motion["damage"]);
        assert_ne!(cold_motion["motion"], before_motion["motion"]);
        assert_eq!(cold_motion["motion"]["vx"], 3.125);
        assert_eq!(cold_motion["motion"]["vy"], -0.75);
        assert_eq!(cold_motion["motion"]["sleeping"], sleeping);
        assert_eq!(cold_motion["motion"]["age"], age);
        game.actors[0].cooldown = 0.25;
        let reloading = packet(&mut game);
        assert_eq!([&reloading["actors"], &reloading["plates"], &reloading["modules"]], [&json!([]), &json!([]), &json!([])]);
        assert_eq!(reloading["block"], true);
        // Its cooldown is a number: one actor, its handle, how many numbers follow, the cooldown first; no plate, no module.
        let block = game.take_block();
        assert_eq!(&block[..4], &[1.0, 1.0, (block.len() - 5) as f64, 0.25]);
        assert_eq!(&block[block.len() - 2..], &[0.0, 0.0]);
        assert!(game.take_block().is_empty(), "taken once");

        let p = game.damage.plate_mut(10).unwrap();
        p.record_dent(Point::new(0.0, 1.01), 0.002, 0.01);
        let expected_marks = p.to_value()["marks"].clone();
        let marked = packet(&mut game);
        assert_eq!(marked["plates"][0]["damage"]["marks"], expected_marks);
        assert!(
            marked["plates"][0]["damage"]
                .get("ballisticGrid")
                .is_none()
        );
        assert!(marked["plates"][0]["damage"].get("wear").is_none());
        assert!(marked["plates"][0]["damage"].get("massRevision").is_none());
        assert_eq!(game.damage.plate(10).unwrap().mass(),admitted_mass);
        let p = game.damage.plate_mut(10).unwrap();
        p.cut_clipped(Point::new(0.0, 0.95), Point::new(0.0, 1.05), 0.02, None);
        let regions = p.to_value()["ballisticGrid"].clone();
        let cut = packet(&mut game);
        assert_eq!(cut["plates"][0]["damage"]["ballisticGrid"], regions);
        assert!(cut["plates"][0]["damage"]["perforations"].is_array());
        let cold = game.frame();
        assert_eq!(cold["actors"][0]["contactContours"], json!(game.actors[0].contact_contours));
        assert_eq!(cold["actors"][0]["contactContours"][0].as_array().unwrap().len(), 4);
        assert_eq!(cold["plates"][0]["damage"]["marks"], expected_marks);
        assert!(cold["plates"][0]["damage"].get("wear").is_none());
        assert_eq!(cold["plates"][0]["damage"]["ballisticGrid"], regions);
        assert_eq!(cold["modules"][0]["blueprint"], "cold-only");
        assert_eq!(cold["plates"][0]["damage"]["blueprint"], "cold-only");
        assert_eq!(cold["plates"][0]["damage"]["physicalMass"], admitted_mass);
        assert_eq!(game.damage.plate(10).unwrap().mass(), admitted_mass);
    }
    #[test]
    fn the_answer_to_a_command_carries_its_frame() {
        let mut game = scene();
        game.events.push(json!({"type":"test-event"}));
        let answer: Value = serde_json::from_str(&game.command_frame_json(&json!({"n":[1,"}"]}), false).unwrap()).unwrap();
        assert_eq!(answer.as_object().unwrap().len(), 2);
        assert_eq!(answer["result"], json!({"n":[1,"}"]}));
        assert_eq!(answer["frame"]["time"], game.time);
        assert_eq!(answer["frame"]["events"].as_array().unwrap().len(), 1);
        assert_eq!(answer["frame"]["plates"][0]["owner"], 10);
        assert_eq!(answer["frame"]["actors"][0]["id"], "local");
        assert!(game.events.is_empty());
    }
    #[test]
    fn queries_do_not_consume_events_or_export_revisions_and_barrel_content_is_exact() {
        let mut game = scene();
        game.events
            .push(json!({"type":"test-event","energy":1.2345678901234567}));
        let query: Value =
            serde_json::from_str(&game.command_frame_json(&json!(42), true).unwrap()).unwrap();
        assert_eq!(
            query,
            json!({"result":42,"frame":null})
        );
        let first = packet(&mut game);
        assert_eq!(first["events"].as_array().unwrap().len(), 1);
        assert!(first["modules"][0]["marks"].is_array());
        assert!(packet(&mut game)["events"].as_array().unwrap().is_empty());
        let module = game.damage.module_mut(20).unwrap();
        module.barrel_marks = (0..16)
            .map(|i| BarrelMark {
                point: Point::new(i as f64 * 0.1, 0.0),
                radius: 0.025,
            })
            .collect();
        packet(&mut game);
        let revision = game.damage.module(20).unwrap().mark_revision;
        let module = game.damage.module_mut(20).unwrap();
        module.barrel_marks.remove(0);
        module.barrel_marks.push(BarrelMark {
            point: Point::new(3.7, -0.002),
            radius: 0.025,
        });
        let expected = module.to_value()["barrelMarks"].clone();
        assert_eq!(module.mark_revision, revision);
        let changed = packet(&mut game);
        assert_eq!(changed["modules"][0]["barrelMarks"], expected);
        assert!(packet(&mut game)["modules"][0].get("barrelMarks").is_none());
    }
    #[test]
    fn rounds_are_told_as_words_with_a_legend_of_their_kinds() {
        let mut game = scene();
        let shot = |n: u64, x: f64| Projectile::from_value(
            &json!({"numericId":n,"actor":1,"x":x,"y":9.5,"vx":800.0,"vy":-3.0,"power":123.5,"mass":5,"caliberMm":120,
                "weapon":"cannon","preset":"rh120","ammo":"he","radius":0.06,"age":0.25}),
        ).unwrap();
        game.projectiles.projectiles.push(shot(7, 1.25));
        game.projectiles.projectiles.push(shot(9, 2.5));
        game.projectiles.projectiles.push(Projectile::from_value(
            &json!({"numericId":8,"actor":1,"x":2.0,"y":3.0,"vx":90.0,"vy":-10.0,"power":20.0,"mass":0.4,"caliberMm":30,
                "weapon":"autocannon","ammo":"ap","radius":0.015}),
        ).unwrap());
        let first = packet(&mut game);
        assert!(first.get("projectiles").is_none(), "a hot frame carries no round");
        assert_eq!(first["shots"], 3);
        assert_eq!(first["shotKinds"]["from"], 0);
        let kinds = first["shotKinds"]["list"].as_array().unwrap();
        assert_eq!(kinds.len(), 2, "two rounds of one gun are one kind");
        assert_eq!(kinds[0], json!({"actor":1,"weapon":"cannon","preset":"rh120","ammo":"he","poweredTrail":false,"name":null}));
        assert_eq!(kinds[1]["weapon"], "autocannon");
        assert_eq!(kinds[1]["preset"], Value::Null);
        let words = game.shot_block();
        assert_eq!(words.len(), 3 * crate::game_projectiles::SHOT_WORDS);
        // Number, kind, then where it is, how fast, its age and its radius, as the core holds them.
        assert_eq!(&words[..8], &[7.0, 0.0, 1.25, 9.5, 800.0, -3.0, 0.25, 0.06]);
        assert_eq!(&words[8..10], &[9.0, 0.0]);
        assert_eq!(&words[16..18], &[8.0, 1.0]);
        // A round far from the middle of a long world is told to the last bit.
        game.projectiles.projectiles[0].point.x = 127_999.123_456_789;
        assert_eq!(game.shot_block()[2].to_bits(), 127_999.123_456_789_f64.to_bits());
        game.projectiles.projectiles[0].point.x = 1.25;
        // Told once: the next frame names only what is new, and says where it goes in the legend.
        let second = packet(&mut game);
        assert_eq!(second["shotKinds"], json!({"from":2,"list":[]}));
        game.projectiles.projectiles.push(Projectile::from_value(
            &json!({"id":"named-shot","numericId":11,"x":0.0,"vx":10.0,"power":1.0,"mass":1,"caliberMm":20,"weapon":"autocannon","ammo":"ap"}),
        ).unwrap());
        let third = packet(&mut game);
        assert_eq!(third["shotKinds"]["from"], 2);
        assert_eq!(third["shotKinds"]["list"][0]["name"], "named-shot");
        // A cold frame tells every round in full and the whole legend over again.
        let cold = game.frame();
        assert_eq!(cold["projectiles"].as_array().unwrap().len(), 4);
        assert_eq!(cold["shotKinds"]["from"], 0);
        assert_eq!(cold["shotKinds"]["list"].as_array().unwrap().len(), 3);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        assert_eq!(game.command(&mut core, &json!({"op":"projectiles"})).unwrap(), cold["projectiles"]);
    }
    #[test]
    fn publishing_many_departed_shooters_bounds_the_legend_without_changing_live_rounds() {
        let mut game = scene();
        let shot = |actor: u32| Projectile::from_value(&json!({"numericId":actor,"actor":actor,
            "x":1.25,"y":9.5,"vx":800.0,"vy":-3.0,"power":123.5,"mass":5,"caliberMm":120,
            "weapon":"cannon","preset":"rh120","ammo":"he","radius":0.06,"age":0.25})).unwrap();
        game.projectiles.projectiles.push(shot(1));
        let mut legend = Vec::new();
        let mut resets = 0;
        for actor in 2..700 {
            game.projectiles.projectiles.truncate(1);
            game.projectiles.projectiles.push(shot(actor));
            let frame = packet(&mut game);
            let from = frame["shotKinds"]["from"].as_u64().unwrap() as usize;
            if from < legend.len() { resets += 1; }
            legend.truncate(from);
            legend.extend(frame["shotKinds"]["list"].as_array().unwrap().iter().cloned());
            assert!(legend.len() <= 256, "departed shooters must not accumulate forever");
            // A block read after its frame uses exactly the indices that frame published.
            let words = game.shot_block();
            for (index, expected) in [1, actor].into_iter().enumerate() {
                assert_eq!(legend[words[index * 8 + 1] as usize]["actor"], expected);
                assert_eq!(&words[index * 8 + 2..index * 8 + 8], &[1.25,9.5,800.0,-3.0,0.25,0.06]);
            }
            if actor % 19 == 0 {
                let cold = game.frame();
                assert_eq!(cold["shotKinds"]["from"], 0);
                assert_eq!(cold["shotKinds"]["list"], json!(legend));
            }
        }
        assert!(resets >= 2, "the test crossed more than one history window");
    }
    #[test]
    fn vehicle_numbers_match_lossless_cold_values() {
        for grounded in [false, true] {
            let mut game = scene();
            let a = &mut game.actors[0];
            a.powertrain.range_km = 123.45678901234567;
            a.powertrain.geared_speed = grounded.then_some(17.25);
            let d = a.drive.as_mut().unwrap();
            d.pose.x = 1e300;
            d.velocity = Point::new(1e-300, -0.0);
            d.local_center = Point::new(-1.2345678901234567, f64::MIN_POSITIVE);
            d.mobility.pressure_kpa = 123.45678901234567;
            d.grounded = grounded;
            d.flying = !grounded;
            d.stuck = grounded.then_some(crate::game_motion::Stuck::Grip);
            d.station = (Some(-0.0), grounded.then_some(1e300));
            let cold = game.frame()["actors"][0].clone();
            let words = packet(&mut game)["actors"][0]["vehicle"].clone();
            let [actors, ..] = read_block(&game.take_block());
            // Handle, how many follow, cooldown, aim, shots, whether it has a vehicle; then the vehicle; then its eyes.
            let numbers = &actors[0];
            assert_eq!(&numbers[..2], &[1.0, (numbers.len() - 2) as f64]);
            assert_eq!(numbers[6], 1.0);
            assert_eq!(numbers[7 + VEHICLE_NUMBERS], cold["eyes"].as_array().unwrap().len() as f64);
            // In the order the host reads them, each to the bit of what the cold Value path tells under its name.
            let v = &cold["vehicle"];
            let number = |value: &Value| value.as_f64().unwrap_or_else(|| if value.as_bool().unwrap() { 1.0 } else { 0.0 });
            let optional = |value: &Value| if value.is_null() { [0.0, 0.0] } else { [1.0, value.as_f64().unwrap()] };
            let mut expected = Vec::new();
            for key in ["x", "y", "angle", "enabled", "massTonnes", "carrierMass", "carrierInertia"] { expected.push(number(&v[key])); }
            for (point, axis) in [("localCenter", "x"), ("localCenter", "y"), ("carrierCenter", "x"), ("carrierCenter", "y")] { expected.push(number(&v[point][axis])); }
            for key in ["vx", "vy", "omega", "travel", "throttle", "brake", "traction", "gearCount", "suspensionCount", "driveSpeed",
                "groundSlope", "groundGrip", "groundLoad", "groundPressureKPa", "groundResistance", "softGroundLoad", "lastImpulse",
                "peakImpulse", "fuelRate", "slip", "rise", "flying", "grounded", "thrustN"] { expected.push(number(&v[key])); }
            expected.extend(optional(&v["station"][0]));
            expected.extend(optional(&v["station"][1]));
            let d = &v["drivetrain"];
            for key in ["powerKw", "torqueNm", "efficiency", "rollingCoefficient", "drag", "dragAstern", "dragOver", "dragUnder", "radius",
                "maxDriveForce"] { expected.push(number(&d[key])); }
            expected.extend(optional(&d["gearedSpeed"]));
            for key in ["maxSpeed", "powerPerTonne", "fueled", "fuelLitres", "rangeKm", "fuelStarved", "tracked"] { expected.push(number(&d[key])); }
            let hot = &numbers[7..7 + VEHICLE_NUMBERS];
            assert_eq!(hot.len(), expected.len());
            for (i, (got, want)) in hot.iter().zip(&expected).enumerate() {
                assert_eq!(got.to_bits(), want.to_bits(), "vehicle number {i}");
            }
            for (got, want) in [(hot[0], 1e300), (hot[11], 1e-300), (hot[12], -0.0), (hot[7], -1.2345678901234567), (hot[8], f64::MIN_POSITIVE)] {
                assert_eq!(got.to_bits(), want.to_bits());
            }
            assert_eq!(d, &game.actors[0].powertrain.to_value());
            // Its names are words.
            assert_eq!(words, json!({"groundSurface": v["groundSurface"], "stuck": v["stuck"]}));
            assert_eq!(words["stuck"], if grounded { json!("grip") } else { Value::Null });
        }
    }
    #[test]
    fn live_numbers_go_in_a_block_beside_the_words() {
        let mut game = scene();
        let words = packet(&mut game);
        assert_eq!(words["block"], true);
        assert!(words["actors"][0].get("cooldown").is_none() && words["actors"][0].get("eyes").is_none());
        assert!(words["modules"][0].get("x").is_none() && words["modules"][0].get("health").is_none());
        let [actors, plates, modules] = read_block(&game.take_block());
        assert_eq!((actors.len(), plates.len(), modules.len()), (1, 1, 1));
        let cold = game.frame();
        let (pose, module) = (&cold["plates"][0]["pose"], &cold["modules"][0]);
        let f = |value: &Value| value.as_f64().unwrap();
        assert_eq!(plates[0], vec![10.0, f(&pose["x"]), f(&pose["y"]), f(&pose["angle"])]);
        // An engine has none of what is told only of some: no mount, fuel, rounds, thrust, servo, gear or springs.
        assert_eq!(&modules[0][..2], &[20.0, 0.0]);
        assert_eq!(&modules[0][2..7], &[f(&module["x"]), f(&module["y"]), f(&module["angle"]), f(&module["barrelAngle"]), f(&module["health"])]);
        assert!(modules[0][15..].iter().all(|n| *n == 0.0));
        assert_eq!(packet(&mut game)["block"], false, "nothing moved");
        game.take_block();
        // A plate that moves is told alone, to the last bit.
        game.damage.plate_mut(10).unwrap().pose.x = 127_999.123_456_789;
        let moved = packet(&mut game);
        assert_eq!([&moved["actors"], &moved["plates"], &moved["modules"]], [&json!([]), &json!([]), &json!([])]);
        let [actors, plates, modules] = read_block(&game.take_block());
        assert!(actors.is_empty() && modules.is_empty());
        assert_eq!(plates[0][1].to_bits(), 127_999.123_456_789_f64.to_bits());
        // A frame that failed told nobody anything: the next tells every number again.
        game.told = Told::default();
        packet(&mut game);
        let [actors, plates, modules] = read_block(&game.take_block());
        assert_eq!((actors.len(), plates.len(), modules.len()), (1, 1, 1));
    }
}
