//! One Rapier world, no callbacks into JavaScript while the solver borrows it.
//! Construction admission and mechanical commands are the only host boundary.
//! The same canonical world builds as a Node addon and as WebAssembly.
use rapier2d_f64::math::{Rotation, Vector};
use rapier2d_f64::prelude::nalgebra::Unit;
use rapier2d_f64::prelude::*;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use game_motion::{Climb, SPRING_SLANT};

pub(crate) const VEHICLE_CONTACT_SKIN: f64 = 0.02;
pub(crate) const VEHICLE_CONTACT_SLOP: f64 = 0.005;

mod game;
mod game_air;
mod game_construction;
pub use game_construction::CONSTRUCTION_VERSION;
mod game_templates;
mod game_cost;
mod game_damage;
mod game_dto;
mod game_fire;
mod game_flight;
mod game_geometry;
mod game_hover;
mod game_motion;
mod game_mounts;
#[cfg(not(target_arch = "wasm32"))]
mod game_parallel;
mod game_pressure;
mod game_projectiles;
mod game_scripted;
mod game_sensors;
mod game_shot_budget;
mod game_weapons;
mod game_barrel;
mod game_variant;
#[cfg(target_arch = "wasm32")]
use wasm_bindgen::prelude::*;

/// The number of what a host and this core say to each other: the frames, the commands, the
/// words of the rounds in the air, cold profiles, checkpoint layout and rules a diary records. A page carries the same number (`CORE_CONTRACT`, in
/// `src/native-dynamics.js`) and refuses a core that states another, so that a page of one
/// build never reads the frames of another. Raised, here and there, whenever that changes.
pub const HOST_CONTRACT: u32 = 90;
// A build-time export, never linked into the Native/Wasm runtime hosts.
#[cfg(feature = "typegen")]
pub fn typescript_contract() -> String {
    game_dto::typescript_contract()
}
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn host_contract() -> u32 {
    HOST_CONTRACT
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn compile_construction(request: &str) -> Result<String, String> {
    if request.len() > 8 * 1024 * 1024 {
        return Err("Construction compiler request exceeds 8 MiB".into());
    }
    let value: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    Ok(match game_construction::request(&value) {
        Ok(result)=>result,
        Err(error)=>serde_json::json!({"error":error}),
    }.to_string())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn template_source(request: &str) -> Result<String, String> {
    if request.len() > 8 * 1024 * 1024 { return Err("Template request exceeds 8 MiB".into()); }
    let value: Value = serde_json::from_str(request).map_err(|e|e.to_string())?;
    Ok(game_templates::request(&value)?.to_string())
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn construction_cost(request: &str) -> Result<String, String> {
    let value: Value = serde_json::from_str(request).map_err(|e|e.to_string())?;
    Ok(game_cost::request(&value)?.to_string())
}

/// What a gun of the catalogue may be made into in the workshop, and the gun a name makes of it.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn weapon_variant(request: &str) -> Result<String, String> {
    if request.len() > 256 * 1024 { return Err("Weapon variant request exceeds 256 KiB".into()); }
    let value: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    Ok(game_variant::request(&value)?.to_string())
}

/// Pure bounded flight instrument, shared by browser and native assistance.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn ballistic_flight(request: &str) -> Result<String, String> {
    if request.len()>128*1024 { return Err("Ballistic request exceeds 128 KiB".into()); }
    let value:Value=serde_json::from_str(request).map_err(|e|e.to_string())?;
    Ok(game_weapons::flight_request(&value)?.to_string())
}
/// Pure surface contact used by both live rounds and ballistic assistance.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn ground_response(request: &str) -> Result<String, String> {
    if request.len() > 4 * 1024 { return Err("Ground response request exceeds 4 KiB".into()); }
    let value: Value = serde_json::from_str(request).map_err(|e| e.to_string())?;
    Ok(game_projectiles::ground_response_request(&value)?.to_string())
}
/// Litres per hour at the delivered and installed engine powers.
#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
pub fn fuel_flow(engine_kw: f64, installed_kw: f64) -> f64 {
    game_motion::fuel_flow(engine_kw, installed_kw)
}
#[cfg(feature = "node")]
mod node;

#[derive(Clone, Copy, Default, Serialize, Deserialize)]
struct Metadata {
    object: u32,
    actor: u32,
    /// How many of the first shapes of the collider of a vehicle are the stops of gear on springs,
    /// each followed as many shapes on by the rim of the same gear (`GameState::seat`).
    sprung: u32,
}
/// One of `words`, read back from a state written out (`NativeWorld::export_state`) as the very word the game says.
fn word<E: serde::de::Error>(said: &str, words: &[&'static str]) -> Result<&'static str, E> {
    words.iter().copied().find(|word| *word == said).ok_or_else(|| E::custom(format!("unknown word {said}")))
}
fn integer(v: &Value, name: &str, default: u32) -> u32 {
    v.get(name)
        .and_then(Value::as_u64)
        .map(|x| x as u32)
        .unwrap_or(default)
}
fn array<'a>(v: &'a Value, name: &str) -> &'a [Value] {
    v.get(name)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}
struct GroundContacts<'a> {
    metadata: &'a HashMap<ColliderHandle, Metadata>,
    held: &'a HashMap<u32, f64>,
}
impl PhysicsHooks for GroundContacts<'_> {
    fn modify_solver_contacts(&self, ctx: &mut ContactModificationContext) {
        let a = self.metadata.get(&ctx.collider1).map_or(0, |m| m.actor);
        let b = self.metadata.get(&ctx.collider2).map_or(0, |m| m.actor);
        if (a == 0) == (b == 0) {
            return;
        }
        let ModifiableContacts::Rigid(contact) = &mut ctx.contacts else {
            return;
        };
        let (handle, subshape) = if a != 0 {
            (ctx.collider1, contact.manifold.subshape1)
        } else {
            (ctx.collider2, contact.manifold.subshape2)
        };
        let Some(compound) = ctx.colliders[handle].shape().as_compound() else {
            return;
        };
        let Some((_, shape)) = compound.shapes().get(subshape as usize) else {
            return;
        };
        // A wheel/capsule is fixed to the single body, but rolls along terrain.
        // DriveState already supplies grip, rolling loss and braking. Applying
        // Coulomb friction here would brake the first landing frame as well.
        // Only a vehicle its brake holds at rest grips the ground through them;
        // the gear pulls itself up a face as `NativeWorld::climb` has it. The
        // outline of a track, round its belt, rolls the same way on all it meets.
        let outline = shape.as_round_convex_polygon().is_some();
        if !outline && shape.as_ball().is_none() && shape.as_capsule().is_none() {
            return;
        }
        let actor = a.max(b);
        *contact.friction = self.held.get(&actor).copied().unwrap_or(0.0);
        if outline {
            return;
        }
        let Some(body) = ctx.colliders[handle].parent().map(|parent| &ctx.bodies[parent]) else {
            return;
        };
        // The ground pushes the gear along `into`. A face that would push it more aslant of the hull
        // than `SPRING_SLANT` is one it climbs, not ground it stands on: a gear on springs meets the
        // ground it stands on with its stop, and such a face with its rim.
        let into = if handle == ctx.collider2 { *contact.normal } else { -*contact.normal };
        let angle = body.rotation().angle();
        let face = into.dot(Vector::new(-angle.sin(), angle.cos())) < SPRING_SLANT;
        let sprung = self.metadata.get(&handle).map_or(0, |m| m.sprung);
        let index = subshape as u32;
        if index < 2 * sprung && (index >= sprung) != face {
            contact.solver_contacts.clear();
        }
    }
}
#[derive(Clone, Copy)]
struct Motion {
    position: Vector,
    center: Vector,
    rotation: Rotation,
    velocity: Vector,
    omega: f64,
    mass: f64,
    inertia: f64,
    dynamic: bool,
}
impl Motion {
    fn capture(body: &RigidBody) -> Self {
        Self {
            position: body.translation(),
            center: body.center_of_mass(),
            rotation: *body.rotation(),
            velocity: body.linvel(),
            omega: body.angvel(),
            mass: body.mass(),
            inertia: body.mass_properties().local_mprops.principal_inertia(),
            dynamic: body.is_dynamic(),
        }
    }
    fn energy(&self) -> f64 {
        if self.dynamic {
            (self.mass * (self.velocity.x.powi(2) + self.velocity.y.powi(2))
                + self.inertia * self.omega.powi(2))
                / 2.0
        } else {
            0.0
        }
    }
}
#[derive(Clone, Copy, Default, Serialize, Deserialize)]
struct EnergySample {
    before: f64,
    after: f64,
    gravity_work: f64,
    constraint_energy: f64,
    invalid: u32,
}
impl EnergySample {
    fn growth(&self) -> f64 {
        self.after - self.before
    }
    fn to_value(&self) -> Value {
        json!({"before":self.before,"after":self.after,"growth":self.growth(),
            "gravityWork":self.gravity_work,"constraintEnergy":self.constraint_energy,"invalid":self.invalid})
    }
}
#[derive(Clone, Default, Serialize, Deserialize)]
struct EnergyAudit {
    solves: u64,
    last: EnergySample,
    max_growth: EnergySample,
    max_before: f64,
    max_after: f64,
}
impl EnergyAudit {
    fn record(&mut self, sample: EnergySample) {
        self.solves += 1;
        if self.solves == 1 || sample.growth() > self.max_growth.growth() {
            self.max_growth = sample;
        }
        self.max_before = self.max_before.max(sample.before);
        self.max_after = self.max_after.max(sample.after);
        self.last = sample;
    }
    fn to_value(&self) -> Value {
        json!({"solves":self.solves,"last":self.last.to_value(),"maxGrowth":self.max_growth.to_value(),
            "maxBefore":self.max_before,"maxAfter":self.max_after})
    }
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
#[derive(Serialize, Deserialize)]
pub struct NativeWorld {
    game: Option<game::GameState>,
    world: PhysicsWorld,
    bodies: BTreeMap<u32, RigidBodyHandle>,
    colliders: HashMap<u32, ColliderHandle>,
    metadata: HashMap<ColliderHandle, Metadata>,
    /// The vehicles their brakes hold at rest in the step being solved, with the grip of each.
    held: HashMap<u32, f64>,
    invalid_reason: u32,
    energy_audit: EnergyAudit,
    /// The ground as a written world holds it, and its print (`export_state`): the ground collider is laid
    /// once, as the world is made, so it is written once.
    #[cfg(not(target_arch = "wasm32"))]
    #[serde(skip)]
    ground: std::sync::OnceLock<Ground>,
}
#[cfg(not(target_arch = "wasm32"))]
struct Ground {
    words: Vec<u8>,
    print: [u8; 32],
}

#[cfg_attr(target_arch = "wasm32", wasm_bindgen)]
impl NativeWorld {
    #[cfg_attr(target_arch = "wasm32", wasm_bindgen(constructor))]
    pub fn new(terrain: &[f64], gx: f64, gy: f64) -> Result<NativeWorld, String> {
        if !terrain.len().is_multiple_of(2)
            || terrain.len() == 2
            || terrain.iter().any(|x| !x.is_finite())
            || !gx.is_finite()
            || !gy.is_finite()
        {
            return Err("Invalid terrain or gravity".into());
        }
        let mut world = PhysicsWorld::new();
        #[cfg(all(not(target_arch = "wasm32"), feature = "native-parallel"))]
        world.set_thread_pool(Some(std::sync::Arc::clone(game_parallel::physics_pool())));
        world.gravity = Vector::new(gx, gy);
        let p = &mut world.integration_parameters;
        p.num_solver_iterations = 8;
        p.num_internal_pgs_iterations = 4;
        p.max_ccd_substeps = 4;
        p.normalized_allowed_linear_error = 0.0003;
        // Gentle overlap correction avoids launching a hull wedged between steep faces.
        // This bounds separation bias, not the response to an incoming physical impact.
        p.normalized_max_corrective_velocity = 0.5;
        // Sparse round gear contacts need a firm terrain response at ramp
        // corners. Stiffen the static contact, without adding solver passes,
        // joint constraints or a larger visible clearance around the wheels.
        p.static_contact_softness.natural_frequency = 100.0;
        // At 60 Hz, speculative contacts must be assembled before a normal
        // approach of several centimetres. This is prediction, not a pose snap.
        p.normalized_prediction_distance = 0.1;
        let ground = if terrain.is_empty() {
            ColliderBuilder::halfspace(Unit::new_unchecked(Vector::Y))
        } else {
            let vertices = terrain
                .chunks_exact(2)
                .map(|p| Vector::new(p[0], p[1]))
                .collect();
            ColliderBuilder::polyline_with_flags(vertices, None, PolylineFlags::ORIENTED)
        };
        let ground = world.insert_collider(ground.friction(0.7).restitution(0.0), None);
        Ok(Self {
            game: None,
            world,
            bodies: BTreeMap::new(),
            colliders: HashMap::from([(0, ground)]),
            metadata: HashMap::new(),
            held: HashMap::new(),
            invalid_reason: 0,
            energy_audit: EnergyAudit::default(),
            #[cfg(not(target_arch = "wasm32"))]
            ground: std::sync::OnceLock::new(),
        })
    }

    pub fn load_game(&mut self, scene: &str) -> Result<(), String> {
        let value = serde_json::from_str(scene).map_err(|e| e.to_string())?;
        self.load_game_value(&value)
    }
    pub fn current_frame(&mut self) -> Result<String, String> {
        Ok(self
            .game
            .as_mut()
            .ok_or("Game scene not loaded")?
            .frame()
            .to_string())
    }
    pub fn game_step(&mut self, dt: f64) -> Result<String, String> {
        let mut game = self.game.take().ok_or("Game scene not loaded")?;
        let result = game.step(self, dt).and_then(|()| game.frame_json());
        self.game = Some(game);
        result
    }
    /// A step that tells nothing but the clock. What changed is kept for the
    /// next frame asked for: a host that shows one step in three exports one in three.
    pub fn game_advance(&mut self, dt: f64) -> Result<String, String> {
        let mut game = self.game.take().ok_or("Game scene not loaded")?;
        let result = game.step(self, dt).map(|()| {
            let (time, tick) = game.clock();
            serde_json::json!({"time":time,"tick":tick}).to_string()
        });
        self.game = Some(game);
        result
    }
    /// The rounds in the air, eight numbers each (`ProjectileState::block`).
    pub fn shot_block(&mut self) -> Result<Vec<f64>, String> {
        Ok(self.game.as_mut().ok_or("Game scene not loaded")?.shot_block())
    }
    /// The numbers of the last live frame (`frame::Told`), to be taken once after a frame that says `"block":true`.
    pub fn frame_block(&mut self) -> Result<Vec<f64>, String> {
        Ok(self.game.as_mut().ok_or("Game scene not loaded")?.take_block())
    }
    pub fn shot_drags(&mut self) -> Result<Vec<f64>, String> {
        Ok(self.game.as_ref().ok_or("Game scene not loaded")?.shot_drags())
    }
    pub fn game_command(&mut self, request: &str) -> Result<String, String> {
        let value = serde_json::from_str(request).map_err(|e| e.to_string())?;
        self.game_command_value(&value)
    }
}

// A field written out whole is the server's to keep and to take back (field-host.js): the page's core leaves it out,
// and with it the weight of writing every part of a world.
#[cfg(not(target_arch = "wasm32"))]
impl NativeWorld {
    /// The whole of this world as it stands, to the last bit: a world that takes it (`import_state`) goes on as
    /// this one goes on. The ground and the catalogues of the game are not in it: the world that takes it, opened on
    /// the same ground, has them. The ground stands in the solver as the shape of its first collider, which is most of
    /// what a world says: those words are cut out where they stand, and the state begins by where and how many they
    /// were, with their print.
    pub fn export_state(&self) -> Result<Vec<u8>, String> {
        let whole = rmp_serde::to_vec(self).map_err(|e| e.to_string())?;
        let Ground { words: ground, print } = self.ground()?;
        let head = &ground[..ground.len().min(64)];
        let at = whole
            .windows(head.len())
            .enumerate()
            .filter(|(_, words)| *words == head)
            .map(|(at, _)| at)
            .find(|&at| whole[at..].starts_with(ground))
            .ok_or("The ground is not where a world says it")?;
        let mut state = Vec::with_capacity(whole.len() - ground.len() + 48);
        state.extend((at as u64).to_le_bytes());
        state.extend((ground.len() as u64).to_le_bytes());
        state.extend(print);
        state.extend(&whole[..at]);
        state.extend(&whole[at + ground.len()..]);
        Ok(state)
    }
    /// Makes this world the one whose state this is (`export_state`), keeping the ground and the catalogues it was loaded with.
    pub fn import_state(&mut self, state: &[u8]) -> Result<(), String> {
        let Ground { words: ground, print } = self.ground()?;
        let (head, rest) = state.split_at_checked(48).ok_or("A state cut short")?;
        let at = u64::from_le_bytes(head[..8].try_into().unwrap()) as usize;
        let length = u64::from_le_bytes(head[8..16].try_into().unwrap()) as usize;
        if length != ground.len() || head[16..] != print[..] || at > rest.len() {
            return Err("A state of a world on another ground".into());
        }
        let mut whole = Vec::with_capacity(rest.len() + ground.len());
        whole.extend(&rest[..at]);
        whole.extend(ground);
        whole.extend(&rest[at..]);
        let taken: NativeWorld = rmp_serde::from_slice(&whole).map_err(|e| e.to_string())?;
        self.take(taken)
    }
    /// Makes this world what `import_state(source.export_state())` would, without writing the state out and reading it
    /// back: the replay's render copies (replay-recording.ts), many a second. Both worlds stand on the same ground.
    pub fn copy_from(&mut self, source: &NativeWorld) -> Result<(), String> {
        if self.ground()?.print != source.ground()?.print {
            return Err("A state of a world on another ground".into());
        }
        let NativeWorld { game, world, bodies, colliders, metadata, held, invalid_reason, energy_audit, ground: _ } = source;
        let PhysicsWorld {
            gravity,
            integration_parameters,
            physics_pipeline: _,
            collision_pipeline: _,
            islands,
            broad_phase,
            narrow_phase,
            bodies: rigid_bodies,
            colliders: shapes,
            impulse_joints,
            multibody_joints,
            soft_bodies,
            ccd_solver: _,
        } = world;
        // What a state leaves out (the pipelines, the CCD solver's scratch) starts anew, as it does read back.
        let copied = PhysicsWorld {
            gravity: *gravity,
            integration_parameters: *integration_parameters,
            physics_pipeline: PhysicsPipeline::new(),
            collision_pipeline: CollisionPipeline::new(),
            islands: islands.clone(),
            broad_phase: broad_phase.clone(),
            narrow_phase: narrow_phase.clone(),
            bodies: rigid_bodies.clone(),
            colliders: shapes.clone(),
            impulse_joints: impulse_joints.clone(),
            multibody_joints: multibody_joints.clone(),
            soft_bodies: soft_bodies.clone(),
            ccd_solver: CCDSolver::new(),
        };
        self.take(NativeWorld {
            game: game.as_ref().map(game::GameState::written_copy),
            world: copied,
            bodies: bodies.clone(),
            colliders: colliders.clone(),
            metadata: metadata.clone(),
            held: held.clone(),
            invalid_reason: *invalid_reason,
            energy_audit: energy_audit.clone(),
            ground: std::sync::OnceLock::new(),
        })
    }
    /// Becomes a world read back from a state (`import_state`, `copy_from`).
    fn take(&mut self, mut taken: NativeWorld) -> Result<(), String> {
        match (taken.game.as_mut(), self.game.as_mut()) {
            (Some(game), Some(mine)) => game.adopt(mine)?,
            (None, _) => {}
            (Some(_), None) => return Err("A world with no game loaded cannot take one".into()),
        }
        // The pipeline is scratch state, omitted from the checkpoint. Restore its CPU budget too.
        #[cfg(feature = "native-parallel")]
        taken.world.set_thread_pool(Some(std::sync::Arc::clone(game_parallel::physics_pool())));
        // Its ground is this one, to the print: it is written already.
        taken.ground = std::mem::take(&mut self.ground);
        *self = taken;
        Ok(())
    }
    fn ground(&self) -> Result<&Ground, String> {
        use sha2::{Digest, Sha256};
        if let Some(ground) = self.ground.get() {
            return Ok(ground);
        }
        let collider = self.colliders.get(&0).and_then(|&handle| self.world.colliders.get(handle)).ok_or("A world without ground")?;
        let words = rmp_serde::to_vec(collider.shared_shape()).map_err(|e| e.to_string())?;
        let mut print = [0; 32];
        print.copy_from_slice(&Sha256::digest(&words));
        Ok(self.ground.get_or_init(|| Ground { words, print }))
    }
}

impl NativeWorld {
    // Bindings parse their boundary once; a test admits the Value it built. A scene that is refused leaves the world
    // as it was.
    pub(crate) fn load_game_value(&mut self, value: &Value) -> Result<(), String> {
        game_construction::require_runtime_admission(value)?;
        let gravity = self.world.gravity;
        let mut replacement = Self::new(&[], gravity.x, gravity.y)?;
        let mut game = game::GameState::from_value(value, &replacement)?;
        game.install(&mut replacement)?;
        if let Some(previous) = self.game.take() {
            game.preserve_runtime(previous);
        }
        replacement.game = Some(game);
        *self = replacement;
        Ok(())
    }
    pub(crate) fn game_command_value(&mut self, value: &Value) -> Result<String, String> {
        let mut game = self.game.take().ok_or("Game scene not loaded")?;
        let result = game.command(self, value).and_then(|result| {
            let query = matches!(
                value["op"].as_str(),
                Some(
                    "teamSight"
                        | "scriptedDecision"
                        | "scriptedDecisions"
                        | "lineOfFire"
                        | "raycast"
                        | "raycastLayers"
                        | "physics"
                        | "material"
                        | "projectiles"
                        | "digest"
                )
            // A caller that steps the world next may decline the scene: the step exports it.
            ) || value["frame"] == false;
            game.command_frame_json(&result, query)
        });
        self.game = Some(game);
        result
    }
}

impl NativeWorld {
    fn stability_snapshot(&self) -> Vec<(RigidBodyHandle, Motion)> {
        // Rapier's arena iteration is stable. A randomized HashMap changes the
        // order of f64 sums and can change the stability guard by one ULP.
        self.world
            .bodies
            .iter()
            .map(|(handle, body)| (handle, Motion::capture(body)))
            .collect()
    }
    /// Work of the normal impulses correcting actual overlap, including their torque about the COM.
    fn corrective_work(&self, before: &[(RigidBodyHandle, Motion)], gained: &[(RigidBodyHandle, f64)], dt: f64) -> f64 {
        let params = &self.world.integration_parameters;
        let subdt = dt / params.num_solver_iterations as f64;
        let mut credited = vec![0.0_f64; gained.len()];
        for pair in self.world.narrow_phase.contact_pairs().filter(|pair| pair.has_any_active_contact()) {
            for manifold in pair.solver_manifolds() {
                let data = &manifold.data;
                let sides = [(data.rigid_body1, data.relative_dominance > 0), (data.rigid_body2, data.relative_dominance < 0)];
                let winners = sides.map(|(body, attached)| (!attached).then(|| gained.iter().position(|(h, _)| Some(*h) == body)).flatten());
                let total = winners.iter().flatten().map(|&i| gained[i].1).sum::<f64>();
                if total <= 0.0 { continue; }
                let fixed = data.relative_dominance != 0 || sides.iter().any(|(h, _)| h.is_none_or(|h| self.world.bodies[h].is_fixed()));
                let softness = if fixed { &params.static_contact_softness } else { &params.contact_softness };
                for contact in &data.solver_contacts {
                    let (p1, p2) = data.solver_contact_world_points(contact, &self.world.bodies);
                    let old = |anchor: Vector, (body, attached): (Option<RigidBodyHandle>, bool)| {
                        body.filter(|_| !attached).and_then(|h| before.iter().find(|(at, _)| *at == h))
                            .map_or(anchor, |(_, motion)| motion.center + motion.rotation * anchor)
                    };
                    let distance_before = (old(contact.anchor2, sides[1]) - old(contact.anchor1, sides[0])).dot(data.normal);
                    let distance_after = (p2 - p1).dot(data.normal);
                    if !distance_before.is_finite() || !distance_after.is_finite() { continue; }
                    let depth = -distance_before.min(distance_after);
                    if depth <= 0.0 { continue; }
                    let Some(point) = manifold.points.get(contact.contact_indices()[0] as usize) else { continue; };
                    let impulse = point.data.impulse;
                    if !impulse.is_finite() || impulse <= 0.0 { continue; }
                    let correction = (depth * softness.erp_inv_dt(subdt)).min(params.max_corrective_velocity());
                    let work = impulse * correction;
                    if !work.is_finite() || work <= 0.0 { continue; }
                    // A contact's work is shared, never counted twice, and cannot pay for a different body.
                    for i in winners.into_iter().flatten() {
                        credited[i] = (credited[i] + work * (gained[i].1 / total)).min(gained[i].1);
                    }
                }
            }
        }
        // Preserve the arena order used by the guard's other energy sums.
        credited.into_iter().sum()
    }

    /// The faces the gear of a vehicle met in the last step, the way it goes along its hull (`ahead`, a sign): the faces
    /// the solver held a wheel on (`GroundContacts`), and all that the belt of a track meets ahead of it, an edge it runs
    /// up onto. Of each point of them, the way along the face it goes, where it is, and how hard the face pressed on the
    /// gear there in that step, in N·s.
    fn faces(&self, body: RigidBodyHandle, ahead: f64) -> Vec<(Vector, Vector, f64)> {
        let mut faces = Vec::new();
        let Some(rigid) = self.world.bodies.get(body) else {
            return faces;
        };
        let angle = rigid.rotation().angle();
        let up = Vector::new(-angle.sin(), angle.cos());
        let way = Vector::new(angle.cos(), angle.sin()) * ahead;
        for &handle in rigid.colliders() {
            let collider = &self.world.colliders[handle];
            let Some(compound) = collider.shape().as_compound() else {
                continue;
            };
            for pair in self.world.narrow_phase.contact_pairs_with(handle) {
                let first = pair.collider1 == handle;
                let other = if first { pair.collider2 } else { pair.collider1 };
                if self.metadata.get(&other).is_some_and(|m| m.actor != 0) {
                    continue;
                }
                for manifold in pair.manifolds() {
                    let (subshape, pose) = if first {
                        (manifold.subshape1, manifold.subshape_pos1())
                    } else {
                        (manifold.subshape2, manifold.subshape_pos2())
                    };
                    let (gear, outline) = compound.shapes().get(subshape as usize).map_or((false, false), |(_, shape)| {
                        let outline = shape.as_round_convex_polygon().is_some();
                        (outline || shape.as_ball().is_some() || shape.as_capsule().is_some(), outline)
                    });
                    let into = if first { -manifold.data.normal } else { manifold.data.normal };
                    let met = if outline { into.dot(way) < 0.0 } else { into.dot(up) < SPRING_SLANT };
                    if !gear || manifold.data.solver_contacts.is_empty() || !met {
                        continue;
                    }
                    let along = Vector::new(into.y, -into.x) * ahead;
                    for point in &manifold.points {
                        let local = if first { point.local_p1 } else { point.local_p2 };
                        faces.push((along, collider.position() * pose.map_or(local, |pose| pose * local), point.data.impulse));
                    }
                }
            }
        }
        faces
    }
    /// How hard the faces the gear of a vehicle meets the way it goes along its hull (`ahead`, a sign) pressed on it in
    /// the last step, in N·s (`faces`): they hold the gear as the ground under it does (`DriveState::drive`).
    pub(crate) fn pressing(&self, body: RigidBodyHandle, ahead: f64) -> f64 {
        self.faces(body, ahead).iter().map(|&(_, _, impulse)| impulse).sum()
    }
    /// Pushes the body of a vehicle its engine drives up the faces its gear met in the last step
    /// (`Climb`, `faces`), at the gear and along each face the way it goes: as hard as the gear grips the
    /// face, pressed on it as hard as it was then, no harder than the drivetrain gives over the step
    /// all told, and not so hard that the hull runs up a face faster than the rim of its gear runs
    /// over it. Gripping the face in the solve itself would pull as hard as the face presses in this
    /// step, which is boundless where it wedges the gear against another face, and the spin of the
    /// gear would throw the hull out.
    pub(crate) fn climb(&mut self, body: RigidBodyHandle, climb: Climb) {
        let faces = self.faces(body, climb.speed.signum());
        let Some(rigid) = self.world.bodies.get(body) else {
            return;
        };
        let mass = rigid.mass_properties();
        let pushes = faces
            .into_iter()
            .map(|(along, at, impulse)| {
                let lever = at - mass.world_com;
                let arm = lever.x * along.y - lever.y * along.x;
                let room = (climb.speed.abs() - rigid.velocity_at_point(at).dot(along)).max(0.0)
                    / (mass.effective_inv_mass.x + arm * arm * mass.effective_world_inv_inertia);
                (along, at, (climb.grip * impulse).min(room).max(0.0))
            })
            .collect::<Vec<_>>();
        let total = pushes.iter().map(|(_, _, impulse)| impulse).sum::<f64>();
        let share = if total > climb.impulse { climb.impulse / total } else { 1.0 };
        let rigid = &mut self.world.bodies[body];
        for (along, at, impulse) in pushes {
            rigid.apply_impulse_at_point(along * (impulse * share), at, true);
        }
    }
    fn solve(
        &mut self,
        dt: f64,
        constraint_energy: f64,
        time: f64,
    ) -> Result<Vec<(RigidBodyHandle, Motion)>, String> {
        if !dt.is_finite()
            || dt <= 0.0
            || !constraint_energy.is_finite()
            || constraint_energy < 0.0
            || !time.is_finite()
        {
            return Err("Invalid step parameters".into());
        }
        self.world.integration_parameters.dt = dt;
        let before = self.stability_snapshot();
        let initial_energy: f64 = before.iter().map(|(_, motion)| motion.energy()).sum();
        let hooks = GroundContacts {
            metadata: &self.metadata,
            held: &self.held,
        };
        {
            #[cfg(all(not(target_arch = "wasm32"), feature = "native-parallel"))]
            let _reservation = game_parallel::reserve_physics();
            self.world.step_with_events(&hooks, &());
        }
        self.invalid_reason = 0;
        let mut energy = 0.0;
        let mut gravity_work = 0.0;
        let mut carried_work = 0.0;
        // What each body gained beyond what its weight and its springs gave it.
        let mut gained = Vec::new();
        for (h, m) in &before {
            let b = &self.world.bodies[*h];
            let mut after = Motion::capture(b);
            // Match the reference budget: only velocities/poses are sampled
            // after solving; the loaded mass and inertia are frozen beforehand.
            after.mass = m.mass;
            after.inertia = m.inertia;
            after.dynamic = m.dynamic;
            if !after.position.is_finite()
                || !after.center.is_finite()
                || !after.velocity.is_finite()
                || !after.rotation.angle().is_finite()
                || !after.omega.is_finite()
            {
                self.invalid_reason = 1;
            }
            energy += after.energy();
            if m.dynamic {
                // A rotating carrier moves its origin around the COM. Only
                // the COM's descent releases gravitational potential energy.
                let fell = (m.mass * 9.81 * (m.center.y - after.center.y)).max(0.0);
                // A force carried through the whole step, as the springs of a gear give one,
                // did its work over the way the body went.
                let carried = (b.user_force().dot(after.center - m.center)
                    + b.user_torque() * game_weapons::angle_difference(after.rotation.angle(), m.rotation.angle()))
                .max(0.0);
                let gain = after.energy() - m.energy() - fell - carried;
                if gain > 0.0 {
                    gained.push((*h, gain));
                }
                gravity_work += fell;
                carried_work += carried;
            }
        }
        let budget = initial_energy * 4.0 + gravity_work + constraint_energy + carried_work + 100.0;
        // Depenetration can do rotational work as well as accelerate the COM. Bound it by the
        // actual normal impulse times the solver's correction bias, only at active overlap.
        // It is looked for only in a step that goes over the rest of the budget.
        let given_back = if energy.is_finite() && energy > budget {
            self.corrective_work(&before, &gained, dt)
        } else {
            0.0
        };
        if self.invalid_reason == 0 && (!energy.is_finite() || energy > budget + given_back) {
            self.invalid_reason = 2;
        }
        // These scalars come from the stability guard itself. Diagnostics never
        // infer solver work from frame boundaries that include new game loads.
        self.energy_audit.record(EnergySample {
            before: initial_energy,
            after: energy,
            gravity_work,
            constraint_energy: constraint_energy + carried_work + given_back,
            invalid: self.invalid_reason,
        });
        if self.invalid_reason != 0 {
            for (h, m) in &before {
                let b = &mut self.world.bodies[*h];
                b.set_translation(m.position, true);
                b.set_rotation(m.rotation, true);
                b.set_linvel(m.velocity, true);
                b.set_angvel(m.omega, true);
            }
        }
        // The game reads closing velocities from this same pre-solve sample.
        // It is transient: no second capture, solver or saved contact history.
        Ok(before)
    }

    fn insert_collider(
        &mut self,
        id: u32,
        parent: u32,
        builder: ColliderBuilder,
        meta: Metadata,
    ) -> Result<(), String> {
        if self.colliders.contains_key(&id) {
            return Err(format!("Duplicate collider id {id}"));
        }
        let parent = match parent {
            0 => None,
            id => Some(*self.bodies.get(&id).ok_or("Unknown collider parent")?),
        };
        let h = self.world.insert_collider(builder, parent);
        self.colliders.insert(id, h);
        self.metadata.insert(h, meta);
        Ok(())
    }
    /// The name the next collider goes by: one more than the last given, whichever were taken away since.
    fn next_collider(&self) -> u32 {
        self.colliders.keys().max().map_or(0, |last| last + 1)
    }
    /// Takes a body out of the world, with the colliders it carries.
    fn remove_body(&mut self, id: u32) {
        let Some(handle) = self.bodies.remove(&id) else {
            return;
        };
        let carried = self.world.bodies.get(handle).map(|body| body.colliders().to_vec()).unwrap_or_default();
        for collider in &carried {
            self.metadata.remove(collider);
        }
        self.colliders.retain(|_, collider| !carried.contains(collider));
        self.world.remove_body(handle);
    }
}

#[cfg(test)]
mod solver_tests;
#[cfg(test)]
mod typed_admission_tests;

#[cfg(test)]
mod center_of_mass_energy_tests {
    use super::*;

    #[test]
    fn rotating_offset_origin_does_not_release_gravity_energy() {
        let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
        let handle = core.world.insert_body(RigidBodyBuilder::dynamic()
            .translation(Vector::new(0.0, 10.0))
            .angvel(1.2)
            .can_sleep(false)
            .additional_mass_properties(MassProperties::new(Vector::X, 1000.0, 500.0)));
        core.world.bodies[handle].recompute_mass_properties_from_colliders(&core.world.colliders);
        let before = Motion::capture(&core.world.bodies[handle]);
        core.solve(1.0 / 60.0, 0.0, 0.0).unwrap();
        let after = Motion::capture(&core.world.bodies[handle]);
        assert!(after.position.y < before.position.y - 0.01, "the origin rotates around the fixed COM");
        assert_eq!(after.center.y, before.center.y);
        assert_eq!(core.energy_audit.last.gravity_work, 0.0);
        assert_eq!(core.invalid_reason, 0);
    }
}

#[cfg(test)]
mod contact_admission_tests {
    use super::*;

    #[test]
    fn quiet_heavy_admission_respects_contact_margin() {
        let catalogue = game_damage::fixtures::full_catalogue();
        for preset in ["rh120", "m242"] {
            let design = game_templates::source("heavy", &json!({"preset":preset}), catalogue).unwrap();
            let mut core = game_damage::fixtures::duel([&design, &design], 36.0);
            let mut game = core.game.take().unwrap();
            assert_eq!(game.frame()["recoveries"], 0, "{preset}: quiet admission must not need recovery");
            assert_eq!(core.invalid_reason, 0);
            for _ in 0..60 { game.step(&mut core, 1.0 / 60.0).unwrap(); }
            assert_eq!(game.frame()["recoveries"], 0, "{preset}: the admitted body must remain stable");
            assert_eq!(core.invalid_reason, 0);
            assert_eq!(core.bodies.len(), 2);
        }
    }
}
