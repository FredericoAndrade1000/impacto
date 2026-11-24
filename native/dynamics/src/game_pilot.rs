//! Adapts the authoritative scene and team measurements to the stationary pilot.
use super::*;
use std::cell::OnceCell;
use crate::game_scripted::{self, Aim, Observed, OwnView, Part};
use crate::game_sensors::{Contact, ContactSource, ObservedTerrain, RosterContact, SensorView, Sight, TerrainReading};

#[cfg(test)]
#[path = "game_exposed_tests.rs"]
mod exposed_tests;

/// What an enemy that only sees for its side, or only drives, is worth a round as beside one whose guns fire.
const SPOTTER: f64 = 0.4;
// Bound temporary observations even when the whole field decides in one batch.
const PILOT_JOBS: usize = 128;

struct RosterMember {
    first: usize,
    parts: Vec<usize>,
    unavailable: bool,
    armed: bool,
    seeing: bool,
    engines: bool,
    gear: bool,
}
impl RosterMember {
    fn include(&mut self, reading: &SensorModule) {
        if !reading.attached || reading.health <= 0.0 || reading.detonated { return; }
        match reading.kind {
            ComponentKind::Weapon if !reading.barrel_disabled => self.armed = true,
            ComponentKind::Sensor | ComponentKind::Command => self.seeing = true,
            ComponentKind::Engine => self.engines = true,
            ComponentKind::Wheel | ComponentKind::Track => self.gear = true,
            _ => {}
        }
    }
}
/// Indices and lazy threat worth for one immutable shared batch, never kept in GameState.
pub(super) struct PilotPreparation {
    roster: HashMap<u32, RosterMember>,
    sides: Sides,
    threats: OnceCell<HashMap<String, f64>>,
}

/// One pilot's authorized observations, prepared in request order before any CPU job starts.
/// Geometry, hardware and terrain remain borrowed from the world, not cloned per pilot.
struct PilotReading {
    index: usize,
    handle: u32,
    arena: Bounds,
    ordered: bool,
    friendly_target: bool,
    terrain: TerrainReading,
    own: Bounds,
    allies: Vec<(u32, Bounds)>,
    intangible: Vec<u32>,
    modules: Vec<usize>,
    contacts: Vec<RosterContact>,
    threats: HashMap<String, f64>,
}

struct PilotJob {
    reading: PilotReading,
    state: PilotState,
}

impl GameState {
    pub(super) fn scripted_entries(&mut self, requests: &[Value]) -> Vec<Result<Value, String>> {
        // Duplicate owners keep the existing cover-transfer cursor, which changes on refresh.
        let shared = requests.len() > 1 && {
            let mut owners = HashSet::with_capacity(self.damage.modules.len());
            self.damage.modules.iter().all(|module| owners.insert(module.owner))
        };
        #[cfg(not(target_arch = "wasm32"))]
        let parallel = shared && requests.len() >= 4 && {
            // Repeated requests for one handle must see that pilot's preceding decision.
            let mut handles = HashSet::with_capacity(requests.len());
            requests.iter().filter_map(|r| self.actor_index(r).ok())
                .all(|index| handles.insert(self.actors[index].handle))
                && crate::game_parallel::pool().current_num_threads() > 1
        };
        #[cfg(target_arch = "wasm32")]
        let parallel = false;
        let (mut refreshed, mut last, mut prepared) = (false, None, None);
        let mut results = Vec::with_capacity(requests.len());
        let mut jobs = Vec::new();
        for r in requests {
            let reading = (|| {
                let index = self.actor_index(r)?;
                let arena = if r["arenaBounds"].is_object() { Bounds::from_value(&r["arenaBounds"]) } else { self.bounds };
                if !arena.min_x.is_finite() || !arena.max_x.is_finite() || arena.min_x >= arena.max_x {
                    return Err("Limites de pilotagem inválidos.".into());
                }
                let handle = self.actors[index].handle;
                if !shared || !refreshed {
                    self.refresh_sensors_for(if shared { None } else { Some(handle) });
                    refreshed = true;
                }
                last = Some(handle);
                // Target validation follows refresh, including a refused final target's gun scope.
                let only = match &r["targetId"] {
                    Value::Null => None,
                    Value::String(id) if self.actors[index].id != *id && self.actors.iter().any(|a| a.id == *id) => Some(id.as_str()),
                    _ => return Err("Alvo de pilotagem inválido.".into()),
                };
                let preparation = shared.then(|| prepared.get_or_insert_with(|| self.prepare_pilots()));
                self.read_pilot(index, arena, only, preparation.map(|p| &*p))
            })();
            if parallel {
                jobs.push(reading.map(|reading| {
                    let state = self.scripted.remove(&reading.handle).unwrap_or_default();
                    PilotJob { reading, state }
                }));
                if jobs.len() == PILOT_JOBS {
                    results.extend(self.run_pilot_jobs(std::mem::take(&mut jobs)));
                }
            } else {
                results.push(reading.and_then(|reading| {
                    let index = reading.index;
                    self.choose_pilot(reading).map(|decision| self.pilot_value(index, decision))
                }));
            }
        }
        if parallel && !jobs.is_empty() { results.extend(self.run_pilot_jobs(jobs)); }
        if shared && let Some(handle) = last {
            for reading in self.sensor_modules.iter_mut().filter(|reading| reading.actor != handle) {
                reading.reload = 0.0; reading.cooling = false; reading.servo_max_speed = 0.0; reading.muzzle_blocked = false;
            }
        }
        results
    }

    fn pilot_value(&self, index: usize, decision: game_scripted::Decision) -> Value {
        let shared_sound = decision.contact.channel == Some(crate::game_sensors::ContactSource::Sound)
            && decision.target.as_ref().and_then(|id| self.actors.iter().find(|actor| actor.id == *id))
                .and_then(|target| self.sensors.sound_receipt(self.actors[index].handle, target.handle))
                .is_some_and(|receipt| receipt.team != self.actors[index].team);
        let mut value = decision.to_value();
        // Internal to the host: a shared ear is never this vehicle's local hearing.
        if shared_sound { value["contact"]["sharedSound"] = json!(true); }
        value
    }

    fn run_pilot_jobs(&mut self, jobs: Vec<Result<PilotJob, String>>) -> Vec<Result<Value, String>> {
        let solve = |job: Result<PilotJob, String>| job.map(|mut job| {
            let handle = job.reading.handle;
            let index = job.reading.index;
            let decision = self.calculate_pilot(job.reading, &mut job.state);
            (index, handle, job.state, decision)
        });
        #[cfg(not(target_arch = "wasm32"))]
        let solved: Vec<_> = {
            use rayon::prelude::*;
            crate::game_parallel::pool().install(|| jobs.into_par_iter().map(solve).collect())
        };
        #[cfg(target_arch = "wasm32")]
        let solved: Vec<_> = jobs.into_iter().map(solve).collect();
        // Indexed collection preserves request/error order, independent of worker completion order.
        solved.into_iter().map(|entry| entry.and_then(|(index, handle, state, decision)| {
            self.scripted.insert(handle, state);
            decision.map(|decision| self.pilot_value(index, decision))
        })).collect()
    }

    fn pilot_roster(&self) -> HashMap<u32, RosterMember> {
        debug_assert_eq!(self.sensor_actors.len(), self.actors.len());
        let mut roster = HashMap::with_capacity(self.actors.len());
        for (index, (target, actor)) in self.sensor_actors.iter().zip(&self.actors).enumerate() {
            debug_assert_eq!(target.handle, actor.handle);
            let state = roster.entry(target.handle).or_insert(RosterMember {
                first: index, parts: Vec::new(), unavailable: false, armed: false, seeing: false, engines: false, gear: false,
            });
            state.unavailable |= actor.defeated || actor.sheltered;
        }
        roster
    }
    /// The audience may observe defeat or shelter before any pilot is asked. Remember only current optical evidence.
    pub(super) fn remember_optical_availability(&mut self, sight: &[(String, Vec<Sight>)]) {
        if !sight.iter().any(|(_,rows)|rows.iter().any(|row|row.visible && row.channel==ContactSource::Visual)) {return;}
        let roster=self.pilot_roster();
        for (team,rows) in sight { for row in rows.iter().filter(|row|row.visible && row.channel==ContactSource::Visual) {
            if let Some(member)=roster.get(&row.target) {self.sensors.observe_optical(team,row.target,member.unavailable,None);}
        }}
    }
    pub(super) fn prepare_pilots(&self) -> PilotPreparation {
        let mut roster = self.pilot_roster();
        debug_assert_eq!(self.damage.modules.len(), self.sensor_modules.len());
        for (index, (module, reading)) in self.damage.modules.iter().zip(&self.sensor_modules).enumerate() {
            debug_assert_eq!(module.owner, reading.handle);
            debug_assert_eq!(module.actor, reading.actor);
            if let Some(member) = roster.get_mut(&reading.actor) {
                member.parts.push(index);
                member.include(reading);
            }
        }
        PilotPreparation { roster, sides: self.sides(), threats: OnceCell::new() }
    }
    /// What each construction on the field is worth a round as, by name, by the state of its parts: one with a gun
    /// that can fire is a threat (1); one with none that still sees for its side (a sensor, or the optic of its
    /// command post) or still drives a wheel or a track by an engine is worth less (`SPOTTER`); one with none of
    /// these can neither strike, nor tell anybody where to, nor go anywhere, and stands to be taken as it is (0).
    fn threats(&self, roster: &HashMap<u32, RosterMember>) -> HashMap<String, f64> {
        self.actors
            .iter()
            .filter(|a| !a.defeated)
            .map(|a| {
                let member = &roster[&a.handle];
                let worth = if member.armed {
                    1.0
                } else if member.seeing || member.engines && member.gear {
                    SPOTTER
                } else {
                    0.0
                };
                (a.id.clone(), worth)
            })
            .collect()
    }
    #[cfg(test)]
    pub(super) fn scripted_choice(
        &mut self,
        index: usize,
        arena: Bounds,
        only: Option<&str>,
    ) -> Result<game_scripted::Decision, String> {
        let reading = self.read_pilot(index, arena, only, None)?;
        self.choose_pilot(reading)
    }
    fn choose_pilot(&mut self, reading: PilotReading) -> Result<game_scripted::Decision, String> {
        let handle = reading.handle;
        let mut state = self.scripted.remove(&handle).unwrap_or_default();
        let decision = self.calculate_pilot(reading, &mut state);
        self.scripted.insert(handle, state);
        decision
    }
    fn read_pilot(
        &mut self,
        index: usize,
        arena: Bounds,
        only: Option<&str>,
        prepared: Option<&PilotPreparation>,
    ) -> Result<PilotReading, String> {
        let handle = self.actors[index].handle;
        let scalar_sides = prepared.is_none().then(|| self.sides());
        let sides = prepared.map_or_else(|| scalar_sides.as_ref().unwrap(), |prepared| &prepared.sides);
        let (near, allies) = self.spans_with_sides(handle, sides);
        let a = &self.actors[index];
        sensor_view!(self => view);
        let reading = self.sensors.sense_terrain(&view, a.handle)?;
        debug_assert_eq!(view.actors.len(), self.actors.len());
        debug_assert_eq!(view.actors[index].handle, a.handle);
        // A handle keeps its first sensor actor, as SensorView::actor does. Any unavailable actor of that
        // handle rules the target out, including scenes admitted with duplicate handles.
        let mut scalar_roster = if prepared.is_none() { self.pilot_roster() } else { HashMap::new() };
        let roster = prepared.map_or(&scalar_roster, |prepared| &prepared.roster);
        let observer = &view.actors[roster[&a.handle].first];
        // Only a current optical contact may use the target's present condition. In particular, revoking a
        // source does not let a remembered position disclose a new defeat, shelter or change of armament.
        let current = |contact: &Contact| contact.visible &&
            (contact.channel == Some(ContactSource::Visual) || contact.source == ContactSource::Team && contact.channel.is_none());
        // Hold protected targets without disclosing a hidden actor's presence or condition through the reason.
        let friendly_target = only.is_some_and(|id| view.actors.iter().any(|target| target.id == id &&
            sides.friendly(Some(a.handle), target.handle) &&
            current(&self.sensors.sampled_contact(observer, &view.actors[roster[&target.handle].first], view.time))));
        let (mut measured,mut measured_handles)=(Vec::new(),Vec::new());
        for target in view.actors {
            if target.team==a.team || sides.friendly(Some(a.handle), target.handle)
                || only.is_some_and(|id|target.id!=id) {continue;}
            let contact=self.sensors.sampled_contact(observer,&view.actors[roster[&target.handle].first],view.time);
            if !contact.detected {continue;}
            let unavailable=if current(&contact) {
                let unavailable=roster[&target.handle].unavailable;
                self.sensors.observe_optical(&observer.team,target.handle,unavailable,None); unavailable
            } else {self.sensors.optical_condition(&observer.team,target.handle).is_some_and(|known|known.unavailable)};
            if unavailable {continue;}
            measured.push(RosterContact {id:target.id.clone(),contact}); measured_handles.push(target.handle);
        }
        // The handles only align this decision's rows; intelligence remains in the existing Measurement slots.
        let classify = only.is_none() && measured.iter().any(|row|current(&row.contact));
        let mut modules = Vec::new();
        let threats = if let Some(prepared) = prepared {
            modules.extend(&prepared.roster[&handle].parts);
            HashMap::new()
        } else {
            debug_assert_eq!(self.damage.modules.len(), view.modules.len());
            for (index, (module, reading)) in self.damage.modules.iter().zip(view.modules).enumerate() {
                debug_assert_eq!(module.owner, reading.handle);
                debug_assert_eq!(module.actor, reading.actor);
                if module.actor == a.handle { modules.push(index); }
                if classify && let Some(member) = scalar_roster.get_mut(&reading.actor) { member.include(reading); }
            }
            if classify { self.threats(&scalar_roster) } else { HashMap::new() }
        };
        let threats = if classify {
            prepared.map_or(&threats, |prepared| prepared.threats.get_or_init(|| self.threats(&prepared.roster)))
        } else { &threats };
        // Keep optical condition already received when a contact changes channel or becomes memory. Unknown
        // condition is neutral; losing sight must not turn a known inert/defeated construction into a threat again.
        let mut known_threats=HashMap::new();
        if only.is_none() {for (row,&target) in measured.iter().zip(&measured_handles) {
            let observed=if current(&row.contact) {threats.get(&row.id).copied()}else{None};
            if current(&row.contact) {self.sensors.observe_optical(&observer.team,target,false,observed);}
            if let Some(worth)=self.sensors.optical_condition(&observer.team,target).and_then(|known|known.worth).or(observed) {
                known_threats.insert(row.id.clone(),worth);
            }
        }}
        let threats=known_threats;
        // What the pilot may engage. An order names the one enemy. With none, an enemy put out of the fight (worth
        // nothing, `threats`) is not worth a round: the pilot leaves it, and only an order takes it on.
        let out = |id: &str| threats.get(id).is_some_and(|worth| *worth <= 0.0);
        if only.is_none() { measured.retain(|r| !out(&r.id)); }
        Ok(PilotReading { index, handle, arena, ordered: only.is_some(), friendly_target,
            terrain: reading, own: near, allies, intangible: sides.wrecks().to_vec(), modules,
            contacts: measured, threats })
    }
    fn calculate_pilot(&self, input: PilotReading, state: &mut PilotState) -> Result<game_scripted::Decision, String> {
        let a = &self.actors[input.index];
        sensor_view!(self => view);
        let modules: Vec<_> = input.modules.iter().map(|&index| &self.damage.modules[index]).collect();
        let readings: Vec<_> = input.modules.iter().map(|&index| &view.modules[index]).collect();
        let own = OwnView {
            actor: &view.actors[input.index],
            drive: a.drive.as_ref(),
            modules: &modules,
            readings: &readings,
            catalogue: &self.catalogue,
            contacts: &input.contacts,
            arena: input.arena,
            ordered: input.ordered,
        };
        let mut observed = ObservedCamera {
            memory: &self.sensors,
            view: &view,
            damage: &self.damage,
            observer: a.handle,
            reading: input.terrain,
            terrain: None,
            sight: None,
            threats: &input.threats,
            side: OwnSide { geometry: &self.geometry, terrain: &self.terrain, own: (input.handle, input.own),
                allies: input.allies, intangible: &input.intangible },
        };
        let mut decision = game_scripted::decide(
            state,
            &own,
            &mut observed,
        )?;
        if input.friendly_target { decision.diagnostics["reason"] = json!("ally-target"); }
        Ok(decision)
    }
}

struct ObservedCamera<'a> {
    memory: &'a SensorMemory,
    view: &'a SensorView<'a>,
    damage: &'a DamageState,
    observer: u32,
    reading: TerrainReading,
    terrain: Option<Result<ObservedTerrain<'a>, String>>,
    /// Whether the pilot's own optics or radars reach a target, once asked.
    sight: Option<(String, bool)>,
    /// What each construction is worth a round as (`threats`); to a pilot under orders, every one is a threat.
    threats: &'a HashMap<String, f64>,
    side: OwnSide<'a>,
}
/// What a pilot knows of its own side to tell what of it a line of fire of its own meets: its own construction and
/// each of its allies, by handle and what each spans.
struct OwnSide<'a> {
    geometry: &'a Geometry,
    intangible: &'a [u32],
    terrain: &'a Terrain,
    own: (u32, Bounds),
    allies: Vec<(u32, Bounds)>,
}
impl Observed for ObservedCamera<'_> {
    fn height(&mut self, x: f64) -> Option<f64> {
        let memory = self.memory;
        let view = self.view;
        let observer = self.observer;
        self.terrain
            .get_or_insert_with(|| memory.observed_terrain(view, observer))
            .as_ref()
            .ok()?
            .height(x)
    }
    fn reading(&self) -> &TerrainReading {
        &self.reading
    }
    fn sees(&mut self, target: &str) -> bool {
        if let Some((asked, seen)) = &self.sight
            && asked == target
        {
            return *seen;
        }
        let seen = self.view.actors.iter().find(|a| a.id == target)
            .is_some_and(|enemy| self.memory.sees(self.view, self.observer, enemy.handle));
        self.sight = Some((target.to_owned(), seen));
        seen
    }
    /// The construction as it shows from outside: its guns, its sensors and its running gear, the tanks and loads
    /// it carries out in the open, the plates of its hull, and the marks the shots that struck them left.
    fn outside(&mut self, target: &str) -> Vec<Aim> {
        let (Some(enemy), Ok(pilot)) = (self.view.actors.iter().find(|a| a.id == target), self.view.actor(self.observer)) else {
            return Vec::new();
        };
        let b = enemy.bounds;
        let middle = Point::new((b.min_x + b.max_x) * 0.5, (b.min_y + b.max_y) * 0.5);
        let shows = |m: &&Module| m.actor == enemy.handle && m.usable()
            && (matches!(m.kind, ComponentKind::Weapon | ComponentKind::Sensor) || m.kind.gear() || m.cold["exposed"] == true);
        let pieces: Vec<(Part, Point, bool)> = self.damage.modules.iter().filter(shows).map(|m| {
            let part = match m.kind {
                ComponentKind::Weapon => Part::Weapon,
                ComponentKind::Sensor => Part::Sensor,
                ComponentKind::Fuel => Part::Fuel,
                ComponentKind::Hopper | ComponentKind::Cistern | ComponentKind::Supply => Part::Cargo,
                _ => Part::Gear,
            };
            (part, Point::new(m.pose.x, m.pose.y), m.barrel_disabled)
        }).collect();
        let marks: Vec<(Point, &str, f64)> = self.damage.plates.iter().filter(|p| p.actor == enemy.handle && p.attached)
            .flat_map(|p| p.marks.iter().map(|mark| (p.material_point(mark.uv), mark.kind, mark.strength)))
            .chain(self.damage.modules.iter().filter(shows)
                .flat_map(|m| m.marks.iter().map(|mark| (m.material_point(mark.uv), mark.kind, mark.strength))))
            .collect();
        game_scripted::aims(middle, pilot.vehicle.map_or(pilot.x, |v| v.x), &pieces, &marks)
    }
    fn threat(&mut self, target: &str) -> f64 {
        self.threats.get(target).copied().unwrap_or(1.0)
    }
    fn in_line(&mut self, line: &LineOfFire, until: f64) -> Line {
        let side = &self.side;
        line_of_fire(side.intangible, line, until, side.own, &side.allies, ROUND_STEP, self.damage, side.geometry, side.terrain)
    }
}

#[cfg(test)]
mod roster_tests {
    use super::*;
    use crate::game_sensors::SensorMode;

    fn world(actors: Value) -> NativeWorld {
        let mut plate = crate::game_damage::fixtures::plate(20, 2, &json!({"definition":{
            "id":"target-silhouette","x":30,"y":2,"length":2,"angle":0,"thicknessMm":1000,"material":"steel"}})).to_value();
        plate["actor"] = json!(2);
        let mut command = crate::game_damage::fixtures::module(10, 1, &json!({
            "id":"command","kind":"command","x":0,"y":2,"width":0.3,"height":0.2,"physicalMass":25,
            "health":100,"maxHealth":100})).to_value();
        command["owner"] = json!(10); command["actor"] = json!(1);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game_value(&json!({"terrain":"flat","actors":actors,"plates":[plate],"modules":[command],
            "visualEvents":false,"bounds":{"minX":-100,"maxX":100,"minY":-5,"maxY":20}})).unwrap();
        core
    }

    #[test]
    fn revoked_contact_does_not_disclose_new_pose_defeat_shelter_or_internal_damage_to_the_pilot() {
        let mut core = world(json!([
            {"id":"pilot","handle":1,"team":"blue","x":-9000},
            {"id":"relay","handle":3,"team":"amber","x":0},
            {"id":"target","handle":2,"team":"red","x":30}
        ]));
        let game = core.game.as_mut().unwrap();
        // Move the fixture's only command optic to the relay. The pilot's own construction is blind and far away.
        let optic = game.damage.module_mut(10).unwrap(); optic.actor = 3;
        game.geometry.upsert(10,EntityGeometry::from_module(optic));
        let target_sensor = crate::game_damage::fixtures::module(21,2,&json!({"id":"target-sensor","kind":"sensor","x":30,"y":1,
            "health":100,"maxHealth":100}));
        game.geometry.upsert(21,EntityGeometry::from_module(&target_sensor)); game.damage.insert_module(target_sensor);
        game.sensors.set_alliances(vec![("blue".into(),"amber".into())]); game.refresh_sensors();
        let seen = game.scripted_choice(0,game.bounds,None).unwrap().contact;
        assert!(seen.detected && seen.visible);
        game.sensors.set_alliances(Vec::new());
        let remembered = game.scripted_choice(0,game.bounds,Some("target")).unwrap();
        assert_eq!(remembered.target.as_deref(),Some("target")); assert!(!remembered.contact.visible);
        // No step or sensor age passes between revocation and changing every live-state input used by acquisition.
        game.actors[2].cold["x"] = json!(800.0); game.actors[2].defeated = true; game.actors[2].sheltered = true;
        let plate=game.damage.plate_mut(20).unwrap(); plate.pose.x=800.0;
        game.geometry.upsert(20,EntityGeometry::from_plate(plate));
        let target_sensor=game.damage.module_mut(21).unwrap(); target_sensor.pose.x=800.0; target_sensor.health=0.0;
        game.geometry.upsert(21,EntityGeometry::from_module(target_sensor)); game.refresh_sensors(); game.scripted.clear();
        let after = game.scripted_choice(0,game.bounds,Some("target")).unwrap();
        assert_eq!(after.target,remembered.target); assert_eq!(after.contact.to_value(),remembered.contact.to_value());
        assert_eq!((after.contact.x,after.contact.y),(seen.x,seen.y));
        assert_eq!(after.diagnostics["nearestFreshContactDistance"], remembered.diagnostics["nearestFreshContactDistance"]);
        // How far off the contact is, by the straight line from the pilot to where it was seen.
        let pilot = &game.sensor_actors[0];
        assert_eq!(after.diagnostics["nearestFreshContactDistance"], crate::game_geometry::hypot(seen.x-pilot.x, seen.y-pilot.y));
        assert_ne!(after.diagnostics["nearestFreshContactDistance"], json!(crate::game_geometry::hypot(game.sensor_actors[2].x-pilot.x, game.sensor_actors[2].y-pilot.y)),
            "worker proximity cannot use a target's new hidden position after the contact is revoked");
    }

    #[test]
    fn a_known_defeat_or_shelter_is_not_reacquired_from_memory_even_without_a_prior_pilot_or_alliance() {
        for allied in [false,true] { for defeated in [false,true] {
            let mut core=world(json!([
                {"id":"pilot","handle":1,"team":"blue","x":if allied {-9000.0}else{0.0}},
                {"id":"relay","handle":3,"team":"amber","x":0},
                {"id":"target","handle":2,"team":"red","x":30,"defeated":defeated}
            ]));
            {
                let game=core.game.as_mut().unwrap();
                game.actors[2].sheltered=!defeated;
                if allied {
                    let optic=game.damage.module_mut(10).unwrap(); optic.actor=3;
                    game.geometry.upsert(10,EntityGeometry::from_module(optic));
                    game.sensors.set_alliances(vec![("blue".into(),"amber".into())]);
                }
            }
            let packet:Value=serde_json::from_str(&core.game_command_value(&json!({"op":"teamSight","frame":false})).unwrap()).unwrap();
            assert!(packet["result"]["sight"]["blue"].as_array().unwrap().iter().any(|row|row["actorId"]=="target"&&row["visible"]==true));
            let game=core.game.as_mut().unwrap();
            game.damage.module_mut(10).unwrap().health=0.0;
            game.sensors.set_alliances(Vec::new()); game.refresh_sensors();
            {
                sensor_view!(game => view);
                let held=game.sensors.sense_combat(&view,1,2).unwrap();
                assert!(held.detected && !held.visible,"the unavailable target really remains in contact memory");
            }
            let before=game.scripted_choice(0,game.bounds,Some("target")).unwrap();
            assert!(before.target.is_none(),"a received unavailable condition remains excluded after optical loss");
            assert!(before.diagnostics["nearestFreshContactDistance"].is_null(), "a remembered wreck or shelter is no nearby threat");
            // Hidden restoration is no new optical evidence, in the same tick or after a snapshot restore.
            game.actors[2].defeated=false; game.actors[2].sheltered=false;
            game.sensors=rmp_serde::from_slice(&rmp_serde::to_vec(&game.sensors).unwrap()).unwrap();
            game.refresh_sensors(); game.scripted.clear();
            assert_ne!(game.scripted_choice(0,game.bounds,None).unwrap().target.as_deref(),Some("target"));
            assert!(game.scripted_choice(0,game.bounds,Some("target")).unwrap().target.is_none());
            game.damage.module_mut(10).unwrap().health=100.0;
            if allied {game.sensors.set_alliances(vec![("blue".into(),"amber".into())]);} else {game.sensors.set_alliances(Vec::new());}
            game.refresh_sensors();
            assert_eq!(game.scripted_choice(0,game.bounds,Some("target")).unwrap().target.as_deref(),Some("target"),"actual optical evidence may update the received condition");
        }}
    }

    #[test]
    fn an_optically_known_inert_target_stays_inert_through_radar_sound_and_memory_until_seen_again() {
        for mode in [SensorMode::Radar,SensorMode::Sound] {
            let mut core=world(json!([
                {"id":"pilot","handle":1,"team":"blue","x":0},
                {"id":"target","handle":2,"team":"red","x":30}
            ]));
            let game=core.game.as_mut().unwrap();
            game.damage.module_mut(10).unwrap().kind=ComponentKind::Sensor;
            game.refresh_sensors();
            assert!(game.scripted_choice(0,game.bounds,None).unwrap().target.is_none(),"an observed inert target is not acquired naturally");
            assert_eq!(game.scripted_choice(0,game.bounds,Some("target")).unwrap().target.as_deref(),Some("target"),"explicit orders may still take an inert target");
            let optic=game.damage.module_mut(10).unwrap(); optic.health=0.0;
            let sensor=crate::game_damage::fixtures::module(11,1,&json!({"id":"non-optical","kind":"sensor","sensorMode":mode.name(),"x":0,"y":2,"health":100,"maxHealth":100}));
            game.geometry.upsert(11,EntityGeometry::from_module(&sensor)); game.damage.insert_module(sensor);
            let weapon=crate::game_damage::fixtures::module(21,2,&json!({"id":"hidden-weapon","kind":"weapon","x":30,"y":1,"health":100,"maxHealth":100}));
            game.geometry.upsert(21,EntityGeometry::from_module(&weapon)); game.damage.insert_module(weapon);
            game.actors[1].shots=1;
            game.sensors.set_alliances(Vec::new()); game.refresh_sensors(); game.scripted.clear();
            let sensed=game.scripted_choice(0,game.bounds,Some("target")).unwrap().contact;
            assert!(sensed.detected && sensed.visible);
            assert_eq!(sensed.channel,Some(if mode==SensorMode::Radar {ContactSource::Radar}else{ContactSource::Sound}));
            let nonvisual=game.scripted_choice(0,game.bounds,None).unwrap();
            assert!(nonvisual.target.is_none(),"another sensor cannot promote known worth zero to neutral one");
            game.damage.module_mut(11).unwrap().health=0.0;
            game.sensors.set_alliances(Vec::new()); game.refresh_sensors(); game.scripted.clear();
            let held=game.scripted_choice(0,game.bounds,Some("target")).unwrap().contact;
            assert!(held.detected && !held.visible); assert_eq!(held.time,sensed.time);
            assert!(game.scripted_choice(0,game.bounds,None).unwrap().target.is_none(),"the received zero survives loss of every sensor");
            game.damage.module_mut(10).unwrap().health=100.0;
            game.sensors.set_alliances(Vec::new()); game.refresh_sensors(); game.scripted.clear();
            assert_eq!(game.scripted_choice(0,game.bounds,None).unwrap().target.as_deref(),Some("target"),"fresh optical classification sees the now armed target");
        }
    }

    #[test]
    fn every_duplicate_target_is_unavailable_when_any_occurrence_is_defeated_or_sheltered() {
        for defeated in [false, true] {
            for blocked in [1, 2] {
                let mut actors = json!([
                    {"id":"pilot","handle":1,"team":"blue","x":0},
                    {"id":"target-first","handle":2,"team":"red","x":30},
                    {"id":"target-copy","handle":2,"team":"red","x":50}
                ]);
                actors[blocked]["defeated"] = json!(defeated);
                let blocked_id = actors[blocked]["id"].as_str().unwrap().to_owned();
                let target = if blocked == 1 { "target-copy" } else { "target-first" };
                let mut core = world(actors);
                assert_eq!(core.game.as_ref().unwrap().actors.iter().filter(|a| a.handle == 2).count(), 2);
                if !defeated {
                    core.game_command_value(&json!({"op":"setActorState","actorId":blocked_id,
                        "state":{"sheltered":true},"frame":false})).unwrap();
                }
                let game = core.game.as_mut().unwrap();
                sensor_view!(game => view);
                assert!(game.sensors.sense_combat(&view, 1, 2).unwrap().detected, "the target is measured before its availability is checked");
                let decision = game.scripted_choice(0, game.bounds, Some(target)).unwrap();
                assert!(decision.target.is_none(), "blocked occurrence {blocked}, defeated={defeated}");
                assert_eq!(decision.diagnostics["reason"], "search-contact");
            }
        }
    }

    #[test]
    fn duplicate_contacts_keep_first_handle_actors_and_the_pilots_own_index() {
        let mut core = world(json!([
            {"id":"observer-first","handle":1,"team":"blue","x":0,"facing":1},
            {"id":"pilot","handle":1,"team":"red","x":90,"y":3,"facing":-1},
            {"id":"target-first","handle":2,"team":"blue","x":30},
            {"id":"target-copy","handle":2,"team":"green","x":55}
        ]));
        let game = core.game.as_mut().unwrap();
        let expected = {
            sensor_view!(game => view);
            game.sensors.sense_combat(&view, 1, 2).unwrap()
        };
        assert_eq!(expected.source, crate::game_sensors::ContactSource::Team);
        let decision = game.scripted_choice(1, game.bounds, Some("target-copy")).unwrap();
        assert_eq!(decision.target.as_deref(), Some("target-copy"), "the roster keeps the selected occurrence's id");
        assert_eq!(decision.contact.to_value(), expected.to_value(), "the checked sensor query resolves both handles to their first occurrence");
        assert_eq!(decision.diagnostics["reason"], "no-armed-feed");
        let search = game.scripted_choice(1, game.bounds, Some("absent")).unwrap();
        assert!(search.target.is_none());
        assert_eq!(search.action["aim"], json!({"x":50.0,"y":1.3}), "the pilot still acts from its corresponding sensor actor at the fixed sensor height");
    }

    #[test]
    fn pilot_classification_keeps_nan_capabilities_orders_and_last_live_id() {
        let core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
        // The corresponding pilot is red, while its handle's first sensor actor is blue.
        // Team contacts give equal confidence, so the selected enemy proves the threat classification.
        let mut game = GameState::from_value(&json!({"terrain":"flat","actors":[
            {"id":"observer-first","handle":1,"team":"blue","x":0},
            {"id":"pilot","handle":1,"team":"red","x":0},
            {"id":"near","handle":2,"team":"blue","x":30},
            {"id":"far","handle":3,"team":"blue","x":60},
            {"id":"friend","handle":4,"team":"red","x":5},
            {"id":"wreck","handle":5,"team":"blue","x":10,"defeated":true},
            {"id":"shelter","handle":6,"team":"blue","x":15}
        ],"bounds":{"minX":-100,"maxX":100,"minY":-5,"maxY":20}}), &core).unwrap();
        for (owner, actor, kind, x) in [
            (31,3,"engine",60.0), (21,2,"sensor",30.0), (32,3,"weapon",60.0),
            (88,88,"weapon",90.0), (33,3,"wheel",60.0),
            (41,4,"sensor",5.0), (51,5,"weapon",10.0), (61,6,"weapon",15.0),
        ] {
            let mut config = json!({"kind":kind,"x":x,"y":5,"width":0.3,"height":0.2,"health":80,"maxHealth":80});
            // Weapons use their catalogue dimensions; only generic fixture pieces need the small test box.
            if kind == "weapon" { for key in ["width", "height"] { config.as_object_mut().unwrap().remove(key); } }
            let mut module = crate::game_damage::fixtures::module(owner, actor, &config);
            if owner == 33 { module.attached = false; }
            game.geometry.upsert(owner, EntityGeometry::from_module(&module));
            game.geometry.set_active(owner, module.attached);
            game.damage.insert_module(module);
        }
        // The old threat predicate accepts NaN health: health<=0 is false, unlike active()/usable().
        game.actors[6].sheltered = true;
        game.damage.module_mut(32).unwrap().health = f64::NAN;
        let choose = |game: &mut GameState, only: Option<&str>| {
            game.scripted.clear();
            game.refresh_sensors();
            game.scripted_choice(1, game.bounds, only).unwrap()
        };
        let ranked = choose(&mut game, None);
        assert_eq!(ranked.target.as_deref(), Some("far"), "an armed threat outranks a nearer spotter");
        // The spotter's sensor stands 30 m along the field and higher than the pilot's: as far off as the line to it.
        let spotter = { sensor_view!(game => view); game.sensors.sense_combat(&view, 1, 2).unwrap() };
        assert_eq!(ranked.diagnostics["nearestFreshContactDistance"],
            crate::game_geometry::hypot(spotter.x-game.sensor_actors[1].x, spotter.y-game.sensor_actors[1].y),
            "the nearer active spotter counts, while a friend, a wreck and a shelter do not");
        assert_eq!((spotter.x-game.sensor_actors[1].x).abs(), 30.0);
        game.damage.module_mut(32).unwrap().barrel_disabled = true;
        assert_eq!(choose(&mut game, None).target.as_deref(), Some("near"), "an engine without live attached gear has no threat worth");
        game.damage.module_mut(33).unwrap().attached = true;
        game.geometry.set_active(33, true);
        game.damage.module_mut(21).unwrap().health = 0.0;
        let moving = choose(&mut game, None);
        assert_eq!(moving.target.as_deref(), Some("far"), "engine and gear together remain a spotter");
        assert_eq!(moving.diagnostics["nearestFreshContactDistance"],
            crate::game_geometry::hypot(moving.contact.x-game.sensor_actors[1].x, moving.contact.y-game.sensor_actors[1].y),
            "only the remaining active construction contributes its received measurement; the inert nearer one does not");
        let ordered = choose(&mut game, Some("near"));
        assert_eq!(ordered.target.as_deref(), Some("near"), "an explicit order may engage an inert target");
        assert_eq!(ordered.diagnostics["reason"], "no-armed-feed", "the unarmed pilot still chooses and reports its contact");
        game.damage.module_mut(21).unwrap().health = 80.0;
        game.damage.module_mut(33).unwrap().attached = false;
        game.geometry.set_active(33, false);
        game.actors[2].id = "repeated".into();
        game.actors[3].id = "repeated".into();
        assert!(choose(&mut game, None).target.is_none(), "the last live occurrence of an id is inert, so both occurrences are excluded");
        game.actors[3].defeated = true;
        assert_eq!(choose(&mut game, None).target.as_deref(), Some("repeated"), "a defeated later occurrence does not overwrite the live spotter's worth");
    }

    #[test]
    fn scripted_batch_automatic_targets_match_scalar_state_and_continuation() {
        fn world(duplicate_owners: bool) -> NativeWorld {
            let mut scene = crate::game_damage::fixtures::mounted_scene(
                &[(1,"pilot",0.0),(2,"near",30.0),(3,"far",60.0)],0);
            for (index, team) in ["red","blue","blue"].into_iter().enumerate() {
                scene["actors"][index]["team"] = json!(team);
            }
            let mut first = scene["actors"][0].clone();
            first["id"] = json!("first-observer"); first["vehicle"] = Value::Null;
            first["x"] = json!(0.0);
            scene["actors"].as_array_mut().unwrap().insert(0,first);
            let modules = scene["modules"].as_array_mut().unwrap();
            for (owner, actor, config) in [
                (91,1,json!({"id":"camera","kind":"sensor","sensorMode":"visual","x":0,"y":14})),
                (92,3,json!({"id":"engine","kind":"engine","x":60,"y":5})),
            ] {
                let mut module = crate::game_damage::fixtures::module(owner,actor,&config).to_value();
                module["owner"] = json!(owner); module["actor"] = json!(actor); modules.push(module);
            }
            if duplicate_owners {
                // An engine alias forces the scalar cover-transfer path without adding a camera or gun.
                modules.push(modules.iter().find(|module| module["owner"] == 92).unwrap().clone());
            }
            let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
            // Keep the compiled plates, catalogues and complete mount descriptors in normal admission.
            core.load_game_value(&scene).unwrap();
            let game = core.game.as_mut().unwrap();
            for owner in [11,21] { game.damage.module_mut(owner).unwrap().barrel_disabled = true; }
            game.damage.module_mut(30).unwrap().health = 0.0;
            // The existing classification guard admits NaN health; active()/usable() do not.
            game.damage.module_mut(31).unwrap().health = f64::NAN;
            game.refresh_sensors();
            let owners: HashSet<_> = game.damage.modules.iter().map(|module| module.owner).collect();
            assert_eq!(owners.len() != game.damage.modules.len(), duplicate_owners);
            assert_ne!(game.actors[1].team, game.actors[3].team);
            sensor_view!(game => view);
            let contact = game.sensors.sense_combat(&view, 1, 3).unwrap();
            assert!(contact.detected, "the actual enemy is measured before any batch decision");
            // Fresh team-shared measurements use source=Team too; channel=None is the allied shortcut.
            assert_eq!(contact.channel, Some(crate::game_sensors::ContactSource::Visual));
            assert_eq!(contact.source_actor, Some(1));
            assert!(game.sensors.remembered_contact(1,3,game.time).is_some(), "contact memory is exercised");
            core
        }
        fn ask(core: &mut NativeWorld, request: Value) -> Value {
            serde_json::from_str::<Value>(&core.game_command_value(&request).unwrap()).unwrap()["result"].clone()
        }
        fn compare_state(batch: &NativeWorld, scalar: &NativeWorld) {
            let (a, b) = (batch.game.as_ref().unwrap(), scalar.game.as_ref().unwrap());
            assert_eq!(a.scripted, b.scripted, "all PilotState entries, not only the physical digest");
            // The existing serializer skips diagnostic TerrainSample fields. Compare every productive
            // memory field logically, without depending on randomized HashMap/HashSet serialization order.
            let memory = |source: &SensorMemory| -> SensorMemory {
                rmp_serde::from_slice(&rmp_serde::to_vec(source).unwrap()).unwrap()
            };
            assert_eq!(memory(&a.sensors), memory(&b.sensors));
            assert_eq!(rmp_serde::to_vec(&a.sensor_actors).unwrap(), rmp_serde::to_vec(&b.sensor_actors).unwrap());
            assert_eq!(rmp_serde::to_vec(&a.sensor_modules).unwrap(), rmp_serde::to_vec(&b.sensor_modules).unwrap());
            assert_eq!(a.events, b.events);
            assert_eq!(a.digest(batch), b.digest(scalar));
        }
        fn compare_requests(batch: &mut NativeWorld, scalar: &mut NativeWorld, requests: Value, targets: &[Option<&str>]) -> Value {
            let rows = ask(batch, json!({"op":"scriptedDecisions","requests":requests}));
            let expected: Vec<_> = requests.as_array().unwrap().iter().map(|request| {
                let mut single = request.clone(); single["op"] = json!("scriptedDecision");
                match scalar.game_command_value(&single) {
                    Ok(packet) => json!({"result":serde_json::from_str::<Value>(&packet).unwrap()["result"]}),
                    Err(error) => json!({"error":error}),
                }
            }).collect();
            assert_eq!(rows, json!(expected), "every result/error and its order");
            assert_eq!(rows.as_array().unwrap().len(), targets.len());
            for (row, target) in rows.as_array().unwrap().iter().zip(targets) {
                match target {
                    Some(id) => assert_eq!(row["result"]["targetId"], *id, "an expected automatic/ordered target"),
                    None => assert!(row["error"].is_string()),
                }
            }
            compare_state(batch, scalar);
            rows
        }
        for duplicate_owners in [false, true] {
            let (mut batch, mut scalar) = (world(duplicate_owners), world(duplicate_owners));
            assert_eq!(batch.game.as_ref().unwrap().actors.iter().filter(|a| a.handle == 1).count(), 2,
                "the first observer and actual pilot share one handle");
            for phase in 0..3 {
                for core in [&mut batch, &mut scalar] {
                    let game = core.game.as_mut().unwrap();
                    if phase >= 1 { game.damage.module_mut(31).unwrap().barrel_disabled = true; }
                    if phase == 2 {
                        game.damage.module_mut(30).unwrap().health = 80.0;
                        game.damage.module_mut(20).unwrap().health = 0.0;
                    }
                }
                if phase == 2 {
                    // An order must not initialize the lazy table before an automatic request.
                    let rows = compare_requests(&mut batch, &mut scalar,
                        json!([{"actorId":"pilot","targetId":"near"},{"actorId":"pilot","targetId":null}]),
                        &[Some("near"),Some("far")]);
                    assert_eq!(rows[1]["result"]["contact"]["detected"], true,
                        "the automatic row must classify a detected enemy, not an empty reading");
                }
                let (requests, targets) = match phase {
                    0 => (json!([{"actorId":"pilot","targetId":null},{"actorId":"pilot","targetId":null}]),
                        vec![Some("far"),Some("far")]),
                    1 => (json!([{"actorId":"pilot","targetId":null},{"actorId":"missing"},
                        {"actorId":"pilot","targetId":null},{"actorId":"pilot","targetId":"pilot"}]),
                        vec![Some("near"),None,Some("near"),None]),
                    _ => (json!([{"actorId":"pilot","targetId":null},{"actorId":"pilot","targetId":"near"},
                        {"actorId":"pilot","arenaBounds":{"minX":4,"maxX":4}},{"actorId":"pilot","targetId":null}]),
                        vec![Some("far"),Some("near"),None,Some("far")]),
                };
                let rows = compare_requests(&mut batch, &mut scalar, requests, &targets);
                let action = rows[0]["result"]["action"].clone();
                let input = json!({"op":"input","actorId":"pilot","input":action,"frame":false});
                assert_eq!(ask(&mut batch, input.clone()), ask(&mut scalar, input));
                for _ in 0..6 {
                    assert_eq!(serde_json::from_str::<Value>(&batch.game_step(1.0/60.0).unwrap()).unwrap(),
                        serde_json::from_str::<Value>(&scalar.game_step(1.0/60.0).unwrap()).unwrap());
                }
                compare_state(&batch, &scalar);
                // Read the same formats back, then cross the perception cadence again on the next phase.
                let (batch_state, scalar_state) = (batch.export_state().unwrap(), scalar.export_state().unwrap());
                batch.import_state(&batch_state).unwrap(); scalar.import_state(&scalar_state).unwrap();
                compare_state(&batch, &scalar);
                let expected = if phase == 1 { "near" } else { "far" };
                compare_requests(&mut batch, &mut scalar,
                    json!([{"actorId":"pilot","targetId":null},{"actorId":"pilot","targetId":null}]),
                    &[Some(expected),Some(expected)]);
            }
        }
    }

    #[test]
    fn parallel_pilots_preserve_scalar_errors_memory_and_resume_in_request_order() {
        fn world(aliases: bool) -> NativeWorld {
            let names: Vec<_> = ["one","two","three","four","five","six","seven","eight"].into_iter()
                .map(str::to_owned).chain((9..=40).map(|handle| format!("extra-{handle}"))).collect();
            let positions: Vec<_> = names.iter().enumerate().map(|(i, name)| (i as u32 + 1, name.as_str(), i as f64 * 8.0)).collect();
            let mut scene = crate::game_damage::fixtures::mounted_scene(&positions, 0);
            // The small mount fixture's module numbers overlap plate numbers past eight actors.
            // Keep disjoint material handles when extending it to a whole pilot batch.
            for module in scene["modules"].as_array_mut().unwrap() {
                module["owner"] = json!(module["owner"].as_u64().unwrap() + 1_000_000);
            }
            for (i, actor) in scene["actors"].as_array_mut().unwrap().iter_mut().enumerate() {
                actor["team"] = json!(if i % 2 == 0 { "red" } else { "blue" });
            }
            if aliases {
                let modules = scene["modules"].as_array_mut().unwrap();
                modules.push(modules[0].clone());
            }
            let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
            core.load_game_value(&scene).unwrap();
            core
        }
        fn ask(core: &mut NativeWorld, request: Value) -> Result<Value, String> {
            core.game_command_value(&request).map(|text| serde_json::from_str::<Value>(&text).unwrap()["result"].clone())
        }
        fn compare(batch: &NativeWorld, scalar: &NativeWorld) {
            let (a, b) = (batch.game.as_ref().unwrap(), scalar.game.as_ref().unwrap());
            assert_eq!(a.scripted, b.scripted, "each pilot keeps its own continuation");
            let memory = |source: &SensorMemory| -> SensorMemory {
                rmp_serde::from_slice(&rmp_serde::to_vec(source).unwrap()).unwrap()
            };
            assert_eq!(memory(&a.sensors), memory(&b.sensors), "received intelligence and terrain");
            assert_eq!(rmp_serde::to_vec(&a.sensor_modules).unwrap(), rmp_serde::to_vec(&b.sensor_modules).unwrap(),
                "the final request retains the same gun scope, even on refusal");
            assert_eq!(a.digest(batch), b.digest(scalar));
            assert_eq!(a.events, b.events);
        }
        for aliases in [false, true] {
            let (mut batch, mut scalar) = (world(aliases), world(aliases));
            let mut large = json!([{"actorId":"eight"},{"actorId":"one"},{"actorId":"six"},{"actorId":"three"},
                {"actorId":"four"},{"actorId":"five"},{"actorId":"two"},{"actorId":"seven"}]);
            large.as_array_mut().unwrap().extend((9..=40).map(|handle| json!({"actorId":format!("extra-{handle}")})));
            let cases = [
                large,
                json!([{"actorId":"missing"},{"actorId":"six","arenaBounds":{"minX":2,"maxX":2}},
                    {"actorId":"one","targetId":"two"},{"actorId":"four"},{"actorId":"five"},
                    {"actorId":"two"},{"actorId":"seven"},{"actorId":"eight","targetId":"absent"}]),
                // A repeated pilot must consume its own earlier result; it cannot be two independent jobs.
                json!([{"actorId":"one","targetId":"two"},{"actorId":"one","targetId":"four"},
                    {"actorId":"three"},{"actorId":"five"},{"actorId":"seven"}]),
            ];
            for requests in cases {
                let rows = ask(&mut batch, json!({"op":"scriptedDecisions","requests":requests})).unwrap();
                let expected: Vec<_> = requests.as_array().unwrap().iter().map(|r| {
                    let mut single = r.clone(); single["op"] = json!("scriptedDecision");
                    match ask(&mut scalar, single) {
                        Ok(value) => json!({"result":value}), Err(error) => json!({"error":error}),
                    }
                }).collect();
                assert_eq!(rows, json!(expected), "every result and refusal stays in input order");
                compare(&batch, &scalar);
                for (request, row) in requests.as_array().unwrap().iter().zip(rows.as_array().unwrap()) {
                    if row.get("result").is_some() {
                        let input = json!({"op":"input","actorId":request["actorId"],"input":row["result"]["action"],"frame":false});
                        assert_eq!(ask(&mut batch, input.clone()), ask(&mut scalar, input));
                    }
                }
                for _ in 0..7 {
                    assert_eq!(batch.game_step(1.0/60.0).unwrap(), scalar.game_step(1.0/60.0).unwrap());
                }
                compare(&batch, &scalar);
                for core in [&mut batch, &mut scalar] {
                    let state = core.export_state().unwrap(); core.import_state(&state).unwrap();
                }
                compare(&batch, &scalar);
            }
        }
    }

    #[test]
    fn a_large_pilot_batch_keeps_earlier_results_when_its_observation_buffer_fills() {
        let actors: Vec<_> = (0..140).map(|i| json!({"id":format!("pilot-{i}"),"handle":i+1,"team":"red","x":i*2})).collect();
        let scene = json!({"terrain":"flat","actors":actors,"visualEvents":false,
            "bounds":{"minX":-1000,"maxX":1000,"minY":-5,"maxY":20}});
        let make = || {
            let mut core = NativeWorld::new(&[],0.0,0.0).unwrap();
            core.load_game_value(&scene).unwrap(); core
        };
        let (mut batch,mut scalar) = (make(),make());
        let mut requests: Vec<_> = (0..140).map(|i| json!({"actorId":format!("pilot-{i}")})).collect();
        requests[7]["arenaBounds"] = json!({"minX":0,"maxX":0});
        requests[139]["targetId"] = json!("missing");
        let rows = batch.game.as_mut().unwrap().scripted_entries(&requests);
        let expected: Vec<_> = requests.iter().map(|request| scalar.game.as_mut().unwrap()
            .scripted_entries(std::slice::from_ref(request)).pop().unwrap()).collect();
        assert_eq!(rows.len(),140);
        assert_eq!(rows,expected,"earlier chunks and errors keep their exact positions");
        assert!(rows[7].is_err() && rows[139].is_err());
        assert_eq!(batch.game.as_ref().unwrap().scripted,scalar.game.as_ref().unwrap().scripted);
    }
}
