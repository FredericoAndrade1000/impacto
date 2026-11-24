//! One passive, tension-only cable per disjoint vehicle pair. The existing Rapier bodies,
//! terrain contacts and drivetrain own all movement; the cable never places or drives a body.
//! A towed vehicle whose engine drives it keeps pace with what tows it on its own drivetrain
//! (`hitch`, `Hitch::Paced`), and what tows it brakes no harder than it can follow (`Hitch::Leads`), so the two pull
//! and brake together and the cable carries what it cannot.
//! A vehicle with a thruster that works takes another up on a sling instead (`Tow::sling`): the cable hangs from a hook on
//! its chassis frame under its centre of mass, so that what hangs from it pulls through that centre and does not tip it,
//! to a ring a bridle holds over the centre of mass of the load, from the ends of the beam of its frame under that centre,
//! so that the load hangs level under it. Its flight computer holds it up against what the cable pulls it down with
//! (game_hover.rs `Body::pull`); the load holds its brakes and is not driven.
use super::*;
use crate::game_hover::Lift;
use rapier2d_f64::prelude::RigidBodyHandle;

// Initial basic-cable coefficients, in SI units, to calibrate with actual admitted light/heavy vehicles.
// They are not a chassis rating and cannot be supplied or increased by a command or cold save.
pub(super) const TOW_REACH: f64 = 4.0;
const TOW_STILL: f64 = 0.5;
const TOW_LEAST_LENGTH: f64 = 0.25;
const TOW_STIFFNESS: f64 = 500_000.0;
const TOW_DAMPING: f64 = 5_000.0;
pub(super) const TOW_LIMIT: f64 = 300_000.0;
/// The longest sling an aircraft takes a vehicle up on, in m: from a hover a few metres over the height its pilot flies
/// at the least (squad.js `FLIGHT_FLOOR`, 6 m) down to the ring over a vehicle standing under it, and as long as a short
/// long line under a helicopter, so that a load hangs clear of its skids and is set down with the aircraft well off it.
pub(super) const SLING_REACH: f64 = 15.0;
/// How far over the top of the load its ring is held, in m: so that the cable runs clear of what it carries.
const SLING_CLEAR: f64 = 1.0;
/// Where along a beam of a frame the ends of a bridle are, or where under a centre of mass a hook may be: inside the
/// ends of its material, as the anchors of a cable are (`tow_candidates`).
const BEAM_INSET: [f64; 2] = [0.02, 0.98];

#[derive(Clone, Copy, Serialize, Deserialize)]
pub(super) struct Tow {
    actor: u32,
    target: u32,
    part_a: u32,
    part_b: u32,
    local_a: Point,
    local_b: Point,
    length: f64,
    tension: f64,
    /// Whether it is a sling: its end on the target is the ring of a bridle over its centre of mass, held from the ends
    /// of the beam `part_b`, and not a point of the metal of that beam. Told by where that end is (`restore_tows`).
    #[serde(default)]
    pub(super) sling: bool,
}
#[derive(Clone, Copy)]
pub(super) struct Anchor {
    pub(super) part: u32,
    pub(super) local: Point,
    pub(super) world: Point,
}

fn point_value(value: &Value) -> Result<Point, String> {
    let x = value["x"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("TOW_STATE")?;
    let y = value["y"]
        .as_f64()
        .filter(|v| v.is_finite())
        .ok_or("TOW_STATE")?;
    Ok(Point::new(x, y))
}
fn demand(distance: f64, length: f64, separating: f64) -> f64 {
    if distance <= length {
        0.0
    } else {
        (TOW_STIFFNESS * (distance - length) + TOW_DAMPING * separating).max(0.0)
    }
}
impl GameState {
    fn tow_index(&self, handle: u32) -> Option<usize> {
        self.tows
            .iter()
            .position(|tow| tow.actor == handle || tow.target == handle)
    }
    pub(super) fn is_towed(&self, handle: u32) -> bool {
        self.tows.iter().any(|tow| tow.target == handle)
    }
    /// What is asked of a vehicle on a cable: nothing of one towed, which rolls free or keeps pace with what tows it
    /// (`hitch`), and all of its brakes on one taken up on a sling, which stands parked wherever it is set down.
    pub(super) fn tow_controls(&self, handle: u32, throttle: f64, brake: f64) -> (f64, f64) {
        match self.tows.iter().find(|tow| tow.target == handle) {
            Some(tow) if tow.sling => (0.0, 1.0),
            Some(_) => (0.0, 0.0),
            None => (throttle, brake),
        }
    }
    fn tow_actor(&self, handle: u32) -> Option<&Actor> {
        self.actors.iter().find(|actor| actor.handle == handle)
    }
    /// How the vehicle `index` is driven on the cable it is on, in a step of `dt`, read once what tows it has been driven in
    /// this step (`GameState::step`): a towed one whose engine drives it keeps pace with that (`Hitch::Paced`), and what
    /// tows it brakes no harder than it can follow (`Hitch::Leads`); one with none to drive it — destroyed, starved of
    /// fuel, or given nothing — or with no wheel or track left whole for it to drive, is pulled (`Hitch::Towed`), and what
    /// tows it is driven as it is asked, as one on no cable is (`Hitch::Free`). Both ends of a sling are driven as they are
    /// asked: what flies by its flight computer, and the load on its brakes (`tow_controls`).
    pub(super) fn hitch(&self, index: usize, dt: f64) -> Hitch {
        let handle = self.actors[index].handle;
        let Some(tow) = self.tows.iter().find(|tow| tow.target == handle || tow.actor == handle) else {
            return Hitch::Free;
        };
        if tow.sling {
            return Hitch::Free;
        }
        let leads = tow.actor == handle;
        let unpaced = if leads { Hitch::Free } else { Hitch::Towed };
        let (Some(tug), Some(towed)) = (self.tow_actor(tow.actor), self.tow_actor(tow.target)) else {
            return unpaced;
        };
        let (Some(lead), Some(load)) = (tug.drive.as_ref(), towed.drive.as_ref()) else {
            return unpaced;
        };
        let (pa, pb) = (lead.pose.world_point(tow.local_a), load.pose.world_point(tow.local_b));
        let distance = pa.distance(pb);
        if towed.defeated
            || !load.enabled
            || !(towed.powertrain.power_kw > 0.0)
            || load.gear_count == 0
            || !(distance > 1e-6)
        {
            return unpaced;
        }
        let along = Point::new((pb.x - pa.x) / distance, (pb.y - pa.y) / distance);
        let stretch = distance - tow.length;
        if leads {
            // All that the brake of the load takes off it in a step, as its gear was last pressed on the ground.
            let carrier = if load.carrier_mass > 0.0 { load.carrier_mass } else { load.mass };
            let follows = if load.traction > 0.0 {
                5.0_f64.min(9.81 * load.mobility.grip * load.ground_load()) * dt * load.mass / carrier
            } else {
                0.0
            };
            return Hitch::Leads(Lead { along, anchor: pa, end: load.velocity_at(pb), stretch, follows });
        }
        Hitch::Paced(Pace {
            along,
            lead: lead.velocity_at(pa),
            anchor: pb,
            stretch,
            driven: if lead.drive_speed > 0.0 {
                1.0
            } else if lead.drive_speed < 0.0 {
                -1.0
            } else {
                0.0
            },
        })
    }
    // A broken engine or running gear does not make a repairable vehicle leave its cable.
    fn tow_live(&self, handle: u32) -> bool {
        self.tow_actor(handle)
            .is_some_and(|actor| !actor.defeated && actor.drive.as_ref().is_some_and(|d| d.enabled))
            && self
                .damage
                .modules
                .iter()
                .any(|m| m.actor == handle && m.kind == ComponentKind::Command && m.usable())
    }
    fn tow_frame_part(&self, handle: u32, owner: u32) -> Option<&Plate> {
        self.damage.plate(owner).filter(|plate| {
            plate.actor == handle
                && plate.attached
                && plate.cold["definition"]["chassis"]["part"] == "frame"
        })
    }
    pub(super) fn tow_anchor_valid(&self, handle: u32, owner: u32, local: Point) -> bool {
        let Some(pose) = self
            .tow_actor(handle)
            .and_then(|a| a.drive.as_ref())
            .map(|d| d.pose)
        else {
            return false;
        };
        self.tow_frame_part(handle, owner).is_some_and(|plate| {
            plate.contains_local(plate.pose.local_point(pose.world_point(local)))
        })
    }
    fn tow_candidates(&self, handle: u32) -> Vec<Anchor> {
        let Some(pose) = self
            .tow_actor(handle)
            .and_then(|a| a.drive.as_ref())
            .map(|d| d.pose)
        else {
            return Vec::new();
        };
        self.damage
            .plates
            .iter()
            .filter(|plate| self.tow_frame_part(handle, plate.owner).is_some())
            .flat_map(|plate| {
                // Insets in the real material frame avoid choosing a point on a triangulation boundary.
                [0.02, 0.98].into_iter().filter_map(move |u| {
                    let world = plate.material_point(Point::new(u, 0.5));
                    plate
                        .contains_local(plate.pose.local_point(world))
                        .then_some(Anchor {
                            part: plate.owner,
                            local: pose.local_point(world),
                            world,
                        })
                })
            })
            .collect()
    }
    /// Where the line through the centre of mass of vehicle `handle` square to its hull — plumb in a level hull — crosses
    /// the middle of each beam of its chassis frame, inside its ends (`BEAM_INSET`) and on its material: each beam, the
    /// point in the frame of the hull, and how far over that centre it is in the hull, under it below zero.
    fn tow_plumb(&self, handle: u32) -> Vec<(u32, Point, f64)> {
        let Some(d) = self.tow_actor(handle).and_then(|a| a.drive.as_ref()) else {
            return Vec::new();
        };
        let (pose, center) = (d.pose, d.carrier_center);
        self.damage
            .plates
            .iter()
            .filter(|plate| self.tow_frame_part(handle, plate.owner).is_some())
            .filter_map(|plate| {
                let [a, b] = [0.0, 1.0].map(|u| pose.local_point(plate.material_point(Point::new(u, 0.5))));
                if !((b.x - a.x).abs() > 1e-6) {
                    return None;
                }
                let along = (center.x - a.x) / (b.x - a.x);
                let local = Point::new(center.x, a.y + (b.y - a.y) * along);
                ((BEAM_INSET[0]..=BEAM_INSET[1]).contains(&along)
                    && plate.contains_local(plate.pose.local_point(pose.world_point(local))))
                .then_some((plate.owner, local, local.y - center.y))
            })
            .collect()
    }
    /// The hook a vehicle that flies takes a sling up by: the point of its frame plumb under its centre of mass nearest it
    /// (`tow_plumb`), or one through that centre within the thickness of its beam. None where its frame passes under it
    /// nowhere.
    pub(super) fn tow_hook(&self, handle: u32) -> Option<Anchor> {
        let pose = self.tow_actor(handle)?.drive.as_ref()?.pose;
        self.tow_plumb(handle)
            .into_iter()
            .filter(|&(owner, _, over)| self.damage.plate(owner).is_some_and(|p| over <= p.thickness / 2.0))
            .max_by(|a, b| a.2.total_cmp(&b.2))
            .map(|(part, local, _)| Anchor { part, local, world: pose.world_point(local) })
    }
    /// The ends of the bridle that holds up the ring of a sling on the beam `owner` of the frame of vehicle `handle`, in
    /// the frame of its hull: near either end of the beam (`BEAM_INSET`), each on its material. None where either is not.
    fn tow_bridle(&self, handle: u32, owner: u32) -> Option<[Point; 2]> {
        let pose = self.tow_actor(handle)?.drive.as_ref()?.pose;
        let plate = self.tow_frame_part(handle, owner)?;
        let ends = BEAM_INSET.map(|u| plate.material_point(Point::new(u, 0.5)));
        ends.iter()
            .all(|&end| plate.contains_local(plate.pose.local_point(end)))
            .then(|| ends.map(|end| pose.local_point(end)))
    }
    /// The ring a vehicle is taken up by on a sling: plumb over its centre of mass, `SLING_CLEAR` over the top of it, on
    /// a bridle from the ends of the beam of its frame plumb under or over that centre nearest it (`tow_plumb`). Its part
    /// is that beam. None where its frame passes under or over that centre nowhere, or the bridle has no ends there.
    pub(super) fn tow_ring(&self, handle: u32) -> Option<Anchor> {
        let actor = self.tow_actor(handle)?;
        let d = actor.drive.as_ref()?;
        let (part, ..) = self
            .tow_plumb(handle)
            .into_iter()
            .filter(|&(owner, ..)| self.tow_bridle(handle, owner).is_some())
            .min_by(|a, b| a.2.abs().total_cmp(&b.2.abs()))?;
        let ends = self.tow_bridle(handle, part)?;
        let top = actor
            .contact_contours
            .iter()
            .flatten()
            .flatten()
            .map(|p| p.y)
            .chain(ends.iter().map(|end| end.y))
            .fold(f64::MIN, f64::max);
        let local = Point::new(d.carrier_center.x, top.max(d.carrier_center.y) + SLING_CLEAR);
        Some(Anchor { part, local, world: d.pose.world_point(local) })
    }
    /// Whether the ring of a sling at `local` in the hull of vehicle `handle` still hangs on a bridle from the beam
    /// `owner`: that beam is still a part of its frame with the ends of the bridle on its material, and the ring stands
    /// over both of them, between them along the hull.
    pub(super) fn tow_ring_valid(&self, handle: u32, owner: u32, local: Point) -> bool {
        self.tow_bridle(handle, owner).is_some_and(|[a, b]| {
            local.y > a.y.max(b.y) && (a.x.min(b.x)..=a.x.max(b.x)).contains(&local.x)
        })
    }
    /// Whether both ends of a cable are where they may be: each on the metal of its part, or, on a sling, the ring held
    /// over the target on its bridle (`tow_ring_valid`).
    fn tow_ends_valid(&self, tow: &Tow) -> bool {
        self.tow_anchor_valid(tow.actor, tow.part_a, tow.local_a)
            && if tow.sling {
                self.tow_ring_valid(tow.target, tow.part_b, tow.local_b)
            } else {
                self.tow_anchor_valid(tow.target, tow.part_b, tow.local_b)
            }
    }
    /// What the thrusters of vehicle `handle` that work push it up with, in newtons, held level and with no torque, in the
    /// air they breathe at the height of its centre of mass (game_flight.rs `thrust_share`), as its pilot reckons it
    /// (squad.js `held`, against `HOLDING`), so that a load it is let take up is one he flies it with there: each as it
    /// points in its hull held level, about its centre of mass, as its flight computer reckons what they hold it up with
    /// (game_hover.rs `held_up`).
    pub(super) fn tow_lift(&self, handle: u32) -> f64 {
        let Some(d) = self.tow_actor(handle).and_then(|a| a.drive.as_ref()) else {
            return 0.0;
        };
        let (angle, center) = (d.pose.angle, d.center());
        let level: Vec<[f64; 3]> = self.damage.modules.iter().filter(|m| m.actor == handle && m.kind == ComponentKind::Thruster && m.usable())
            .map(|m| {
                let (most, turn) = (m.kind.thrust_n(m.volume), m.pose.angle - angle);
                let (x, y) = (-sin(turn) * most, cos(turn) * most);
                let (dx, dy) = (m.pose.x - center.x, m.pose.y - center.y);
                let (along, over) = (cos(angle) * dx + sin(angle) * dy, cos(angle) * dy - sin(angle) * dx);
                [x, y, along * y - over * x]
            })
            .collect();
        crate::game_hover::held_up(&level) * crate::game_flight::thrust_share(center.y)
    }
    /// What the cable vehicle `handle` is on pulled it with in the step before, as its end of it is now, on its centre of
    /// mass: the force, and its torque about that centre. Nothing on no cable, or on one that does not pull.
    pub(super) fn tow_pull(&self, handle: u32) -> Lift {
        let Some(tow) = self.tows.iter().find(|tow| tow.actor == handle || tow.target == handle).filter(|tow| tow.tension > 0.0) else {
            return Lift::default();
        };
        let ends = self.tow_actor(tow.actor).and_then(|a| a.drive.as_ref()).zip(self.tow_actor(tow.target).and_then(|a| a.drive.as_ref()));
        let Some((a, b)) = ends else { return Lift::default() };
        let (pa, pb) = (a.pose.world_point(tow.local_a), b.pose.world_point(tow.local_b));
        let distance = pa.distance(pb);
        if !(distance > 1e-9) {
            return Lift::default();
        }
        let (from, to, drive) = if tow.actor == handle { (pa, pb, a) } else { (pb, pa, b) };
        let force = Point::new((to.x - from.x) / distance * tow.tension, (to.y - from.y) / distance * tow.tension);
        let center = drive.center();
        Lift { force, torque: Point::new(from.x - center.x, from.y - center.y).cross(force) }
    }
    /// What vehicle `handle` holds up on a sling off the ground: the load, while it is, its mass and how much faster along
    /// the field than the hook the ring it hangs by goes, as it swings under it and turns about the ring (`Body::swing`).
    pub(super) fn tow_hanging(&self, handle: u32) -> Option<(u32, f64, f64)> {
        let tow = self.tows.iter().find(|tow| tow.sling && tow.actor == handle)?;
        let d = self.tow_actor(tow.target)?.drive.as_ref().filter(|d| !d.grounded)?;
        let a = self.tow_actor(handle)?.drive.as_ref()?;
        let (ring, hook) = (d.pose.world_point(tow.local_b), a.pose.world_point(tow.local_a));
        let along = |d: &DriveState, at: Point| d.velocity.x - d.omega * (at.y - d.center().y);
        Some((tow.target, d.carrier_mass, along(d, ring) - along(a, hook)))
    }
    fn tow_body(&self, core: &NativeWorld, handle: u32) -> Option<RigidBodyHandle> {
        self.tow_actor(handle)
            .and_then(|a| core.bodies.get(&a.body))
            .copied()
            .filter(|&h| core.world.bodies.get(h).is_some_and(|b| b.is_dynamic()))
    }
    fn tow_id(&self, handle: u32) -> Option<&str> {
        self.tow_actor(handle).map(|a| a.id.as_str())
    }
    fn tow_part_id(&self, owner: u32) -> Option<&str> {
        self.damage.plate(owner).and_then(|p| p.cold["id"].as_str())
    }
    /// Each cable as the page draws it, its ends where they are on the field; a sling with where the two legs of its
    /// bridle hold its load (`bridle`), as the page has no beam of a load to find them by.
    pub(super) fn tow_frame(&self) -> Value {
        json!(self.tows.iter().filter_map(|tow| {
            let (a,b)=(self.tow_actor(tow.actor)?,self.tow_actor(tow.target)?);
            let (from,to)=(a.drive.as_ref()?.pose,b.drive.as_ref()?.pose);
            let (pa,pb)=(from.world_point(tow.local_a),to.world_point(tow.local_b));
            let bridle=tow.sling.then(|| self.tow_bridle(tow.target, tow.part_b)).flatten().map(|ends| ends.map(|end| to.world_point(end)));
            Some(json!({"actorId":a.id,"targetId":b.id,"partAId":self.tow_part_id(tow.part_a)?,"partBId":self.tow_part_id(tow.part_b)?,
                "localA":tow.local_a,"localB":tow.local_b,"anchorA":pa,"anchorB":pb,"length":tow.length,"tension":tow.tension,"limit":TOW_LIMIT,
                "sling":tow.sling,"bridle":bridle}))
        }).collect::<Vec<_>>())
    }
    pub(super) fn tow_digest(&self, words: &mut Vec<f64>) {
        words.push(self.tows.len() as f64);
        for tow in &self.tows {
            words.extend([
                tow.actor as f64,
                tow.target as f64,
                tow.part_a as f64,
                tow.part_b as f64,
                tow.local_a.x,
                tow.local_a.y,
                tow.local_b.x,
                tow.local_b.y,
                tow.length,
                tow.tension,
                if tow.sling { 1.0 } else { 0.0 },
            ]);
        }
    }
    pub(super) fn release_tow(&mut self, handle: u32, reason: &str) -> bool {
        let Some(index) = self.tow_index(handle) else {
            return false;
        };
        let tow = self.tows.remove(index);
        let ids = self
            .tow_id(tow.actor)
            .zip(self.tow_id(tow.target))
            .map(|(a, b)| (a.to_owned(), b.to_owned()));
        if let Some(actor) = self.actors.iter_mut().find(|a| a.handle == tow.target) {
            if let Some(drive) = &mut actor.drive {
                drive.control(0.0, 1.0);
            }
        }
        if let Some((actor, target)) = ids {
            self.events.push(json!({"type":"tow-release","actorId":actor,"otherId":target,"reason":reason,"time":self.time}));
        }
        true
    }
    pub(super) fn prune_tows(&mut self, core: &NativeWorld) {
        let invalid = self
            .tows
            .iter()
            .filter(|tow| {
                !self.tow_live(tow.actor)
                    || !self.tow_live(tow.target)
                    || self.tow_body(core, tow.actor).is_none()
                    || self.tow_body(core, tow.target).is_none()
                    || !self.tow_ends_valid(tow)
            })
            .map(|tow| tow.actor)
            .collect::<Vec<_>>();
        for actor in invalid {
            self.release_tow(actor, "endpoint");
        }
    }
    pub(super) fn command_tow_attach(
        &mut self,
        core: &NativeWorld,
        request: &Value,
    ) -> Result<Value, String> {
        let actor_id = request["actorId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("TOW_ACTOR")?;
        let target_id = request["targetId"]
            .as_str()
            .filter(|s| !s.is_empty() && *s != actor_id)
            .ok_or("TOW_ACTOR")?;
        let a = self
            .actors
            .iter()
            .find(|a| a.id == actor_id)
            .ok_or("TOW_ACTOR")?;
        let b = self
            .actors
            .iter()
            .find(|a| a.id == target_id)
            .ok_or("TOW_ACTOR")?;
        let (actor, target) = (a.handle, b.handle);
        if self
            .tows
            .iter()
            .any(|tow| tow.actor == actor && tow.target == target)
        {
            return Ok(json!(true));
        }
        if self.tow_index(actor).is_some() || self.tow_index(target).is_some() {
            return Err("TOW_BUSY".into());
        }
        if a.team != b.team || !self.tow_live(actor) || !self.tow_live(target) {
            return Err("TOW_ACTOR".into());
        }
        let (body_a, body_b) = (
            self.tow_body(core, actor).ok_or("TOW_ACTOR")?,
            self.tow_body(core, target).ok_or("TOW_ACTOR")?,
        );
        // What pulls: an engine, or thrusters, which take what they pull up on a sling.
        let works = |kind: ComponentKind| self.damage.modules.iter().any(|m| m.actor == actor && m.kind == kind && m.usable());
        let sling = works(ComponentKind::Thruster);
        if !sling && !works(ComponentKind::Engine) {
            return Err("TOW_MOTOR".into());
        }
        let (length, pa, pb) = if sling {
            let (pa, pb) = (self.tow_hook(actor).ok_or("TOW_ANCHOR")?, self.tow_ring(target).ok_or("TOW_ANCHOR")?);
            // It takes up no more than its thrusters hold up with the margin the Oficina asks of an aircraft loaded full
            // (game_construction.rs `LIFT_MARGIN`), as its pilot reckons that (`tow_lift`; squad.js `lifts` with `HOLDING`):
            // it flies with the load as any aircraft it passes flies, and its pilot flies it so.
            let weight = [actor, target].iter().filter_map(|&h| self.tow_actor(h)?.drive.as_ref()).map(|d| d.carrier_mass).sum::<f64>()
                * crate::game_flight::GRAVITY;
            if !(self.tow_lift(actor) > crate::game_construction::LIFT_MARGIN * weight) {
                return Err("TOW_HEAVY".into());
            }
            (pa.world.distance(pb.world), pa, pb)
        } else {
            let mut nearest: Option<(f64, Anchor, Anchor)> = None;
            for pa in self.tow_candidates(actor) {
                for pb in self.tow_candidates(target) {
                    let distance = pa.world.distance(pb.world);
                    if nearest.as_ref().is_none_or(|(best, ..)| distance < *best) {
                        nearest = Some((distance, pa, pb));
                    }
                }
            }
            nearest.ok_or("TOW_ANCHOR")?
        };
        let reach = if sling { SLING_REACH } else { TOW_REACH };
        if !length.is_finite() || !(TOW_LEAST_LENGTH..=reach).contains(&length) {
            return Err("TOW_REACH".into());
        }
        for (body, at) in [(body_a, pa.world), (body_b, pb.world)] {
            let v = core.world.bodies[body].velocity_at_point(Vector::new(at.x, at.y));
            if !v.x.is_finite() || !v.y.is_finite() || hypot(v.x, v.y) > TOW_STILL {
                return Err("TOW_SPEED".into());
            }
        }
        self.tows.push(Tow {
            actor,
            target,
            part_a: pa.part,
            part_b: pb.part,
            local_a: pa.local,
            local_b: pb.local,
            length,
            tension: 0.0,
            sling,
        });
        self.tows.sort_by_key(|tow| (tow.actor, tow.target));
        self.actors
            .iter_mut()
            .find(|a| a.handle == target)
            .unwrap()
            .drive
            .as_mut()
            .unwrap()
            .control(0.0, if sling { 1.0 } else { 0.0 });
        Ok(json!(true))
    }
    pub(super) fn command_tow_detach(&mut self, request: &Value) -> Result<Value, String> {
        let id = request["actorId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or("TOW_ACTOR")?;
        let handle = self.actors.iter().find(|a| a.id == id).map(|a| a.handle);
        Ok(json!(
            handle.is_some_and(|handle| self.release_tow(handle, "manual"))
        ))
    }
    pub(super) fn restore_tows(&mut self, value: &Value) -> Result<(), String> {
        let Some(value) = value.get("tows").filter(|v| !v.is_null()) else {
            return Ok(());
        };
        let rows = value
            .as_array()
            .filter(|rows| rows.len() <= self.actors.len() / 2)
            .ok_or("TOW_STATE")?;
        let mut staged: Vec<Tow> = Vec::new();
        for row in rows {
            let actor = self
                .actors
                .iter()
                .find(|a| row["actorId"].as_str() == Some(a.id.as_str()))
                .ok_or("TOW_STATE")?;
            let target = self
                .actors
                .iter()
                .find(|a| row["targetId"].as_str() == Some(a.id.as_str()))
                .ok_or("TOW_STATE")?;
            let (a, b) = (actor.handle, target.handle);
            if a == b
                || actor.team != target.team
                || !self.tow_live(a)
                || !self.tow_live(b)
                || staged
                    .iter()
                    .any(|tow| [tow.actor, tow.target].iter().any(|&id| id == a || id == b))
            {
                return Err("TOW_STATE".into());
            }
            let part = |key: &str, handle: u32| {
                let id = row[key]
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("TOW_STATE")?;
                self.damage
                    .plates
                    .iter()
                    .find(|p| p.actor == handle && p.cold["id"].as_str() == Some(id))
                    .map(|p| p.owner)
                    .ok_or("TOW_STATE")
            };
            let (part_a, part_b) = (part("partAId", a)?, part("partBId", b)?);
            let (local_a, local_b) = (point_value(&row["localA"])?, point_value(&row["localB"])?);
            // A cable whose end on the target is off the metal of its part is a sling: its ring over the target. Nothing
            // else is kept of it, and nothing else tells it.
            let sling = !self.tow_anchor_valid(b, part_b, local_b);
            let reach = if sling { SLING_REACH } else { TOW_REACH };
            let length = row["length"]
                .as_f64()
                .filter(|v| v.is_finite() && (TOW_LEAST_LENGTH..=reach).contains(v))
                .ok_or("TOW_STATE")?;
            let tow = Tow {
                actor: a,
                target: b,
                part_a,
                part_b,
                local_a,
                local_b,
                length,
                tension: 0.0,
                sling,
            };
            if !self.tow_ends_valid(&tow) {
                return Err("TOW_STATE".into());
            }
            staged.push(tow);
        }
        staged.sort_by_key(|tow| (tow.actor, tow.target));
        self.tows = staged;
        for tow in &self.tows {
            self.actors
                .iter_mut()
                .find(|a| a.handle == tow.target)
                .unwrap()
                .drive
                .as_mut()
                .unwrap()
                .control(0.0, if tow.sling { 1.0 } else { 0.0 });
        }
        Ok(())
    }
    pub(super) fn advance_tows(&mut self, core: &mut NativeWorld) {
        self.prune_tows(core);
        // Every actor has already composed its current spring force. Appending here prevents a later
        // actor's spring reset from erasing one half of the equal/opposite cable force.
        for i in (0..self.tows.len()).rev() {
            let tow = self.tows[i];
            let (a, b) = (
                self.tow_body(core, tow.actor).unwrap(),
                self.tow_body(core, tow.target).unwrap(),
            );
            let world = |body: RigidBodyHandle, local: Point| {
                let rigid = &core.world.bodies[body];
                let p = rigid.translation();
                Pose {
                    x: p.x,
                    y: p.y,
                    angle: rigid.rotation().angle(),
                }
                .world_point(local)
            };
            let (pa, pb) = (world(a, tow.local_a), world(b, tow.local_b));
            let distance = pa.distance(pb);
            let mut tension = 0.0;
            if distance > tow.length {
                let (n, va, vb) = (
                    Point::new((pb.x - pa.x) / distance, (pb.y - pa.y) / distance),
                    core.world.bodies[a].velocity_at_point(Vector::new(pa.x, pa.y)),
                    core.world.bodies[b].velocity_at_point(Vector::new(pb.x, pb.y)),
                );
                tension = demand(
                    distance,
                    tow.length,
                    (vb.x - va.x) * n.x + (vb.y - va.y) * n.y,
                );
                // No unlimited rope impulse is delivered before declaring rupture.
                if !tension.is_finite() || tension > TOW_LIMIT {
                    self.release_tow(tow.actor, "tension");
                    continue;
                }
                if tension > 0.0 {
                    let force = Vector::new(n.x * tension, n.y * tension);
                    core.world.bodies[a].add_force_at_point(force, Vector::new(pa.x, pa.y), true);
                    core.world.bodies[b].add_force_at_point(-force, Vector::new(pb.x, pb.y), true);
                }
            }
            self.tows[i].tension = tension;
        }
    }
}
