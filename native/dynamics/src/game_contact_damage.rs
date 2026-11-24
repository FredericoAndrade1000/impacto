//! A violent stop on the terrain spends energy in the same installed parts as a hit.
//! Springs and Rapier do all the mechanics; this only records the overload they could not absorb. The gear that struck
//! takes it first: a wheel or a track on its springs, or the skids of an aircraft. What the gear could not take crushes
//! the hull from where it struck, and every part the crush reaches is harmed by the share of it the crush went through.
//! What the ground did is told apart from what any hit did (`ground_marks`, `ground_damage`): a fall is no attack.
use super::*;
use crate::game_damage::DENT_SHARE;
use crate::game_motion::gear_travel;
use crate::{Motion, VEHICLE_CONTACT_SKIN};
use rapier2d_f64::prelude::RigidBodyHandle;

/// The share of the length of the legs of an aircraft's skids, the height its frame stands over their runner, that they
/// give back as they bend. Over that travel they take the weight of the aircraft twice over (`Skids::elastic`): three
/// times its weight on the ground with its own, of the order of the limit load factor of the skid gear of a light
/// helicopter. A third of legs half a metre long so takes the limit drop of a rotorcraft, 13 inches or some 2.5 m/s
/// (14 CFR 27.725), whole; from half as high again, the reserve drop (27.727), they bend for good some way and hold.
const SKID_ELASTIC: f64 = 1.0 / 3.0;
/// The load at which the legs of an aircraft's skids yield, in weights of the aircraft: one and a half times the three of
/// their limit load, the factor of safety of an airframe (14 CFR 27.303). Bending flat over the rest of their length at
/// that load, they take a drop at 6–7 m/s, as the skid gear of a helicopter built to MIL-STD-1290A takes its 20 ft/s.
const SKID_YIELD: f64 = 4.5;
/// The load at which the hull of a construction crushes once its gear can take no more, in its weights. Twenty: the
/// reference aircraft (tests/helpers/aircraft.js `airBuilder`) comes through the 42 ft/s (12.8 m/s) vertical crash of
/// MIL-STD-1290A with its belly crushed under its bed and the pieces on its bed whole, has them harmed at 15 m/s and is
/// crushed up to its command post at some 26 m/s. An airframe's seats are tested at 30 g down (14 CFR 27.562): the crush
/// that slows it is of that order.
const HULL_CRUSH: f64 = 20.0;
/// How wide a gap a runner of skids opens where it breaks, in metres: some two diameters of its tube.
const SKID_GAP: f64 = 0.15;
/// How steeply the ground must have stopped a body, as the cosine of the way it pushed it from straight up, for the
/// stop to be a fall onto the ground and not a run into a face along it: within 45° of straight up.
const FALL: f64 = std::f64::consts::FRAC_1_SQRT_2;

/// What met the ground at a point: a wheel or a track, the plate of an aircraft's skids it met, or the hull. Of a skid or
/// the hull, the plate nearest to where it met it, which a dent marks.
#[derive(Clone, Copy, PartialEq)]
enum Struck {
    Gear(u32),
    Skid(u32),
    Hull(Option<u32>),
}

struct Impact {
    struck: Struck,
    point: Point,
    normal: Point,
    impulse: f64,
    closing: f64,
    energy: f64,
    capacity: f64,
}

/// A point the ground pressed in the step, as the contacts after the solve tell it.
struct Contact {
    subshape: u32,
    point: Point,
    normal: Point,
    impulse: f64,
    closing: f64,
}

/// The skids of an aircraft as its landing gear. The runner is pressed up toward the frame as their legs bend, as far as
/// they are long (`stroke`): elastically over `travel`, taking `elastic` there, and yielding over the rest, taking
/// `plastic` there as they bend flat. Each hard landing uses some of what they yield (`worn`, a share): the deepest dent
/// of their plates, a dent as deep as a plate dents (`DENT_SHARE`) is all of it, and skids worn through are broken —
/// they take nothing more, and the hull meets what comes.
#[derive(Clone, Copy)]
struct Skids {
    stroke: f64,
    travel: f64,
    elastic: f64,
    plastic: f64,
    worn: f64,
}

/// Where the gear let the energy of a hit on into the hull: the point and the way the ground met it, how far from that
/// point the gear itself reaches into the construction (`stroke`: the hull is crushed from there on), and the energy.
struct Crush {
    point: Point,
    normal: Point,
    stroke: f64,
    energy: f64,
}

impl GameState {
    // `seat` installs sprung stops, sprung rims, rigid gear, then the hull. Neither the rim
    // nor the stop is a separate piece: both overload that same installed gear.
    fn contact_gear(&self, actor: u32, sprung: u32, subshape: u32) -> Option<u32> {
        let (spring, index) = if subshape < 2 * sprung {
            (true, (subshape % sprung) as usize)
        } else {
            (false, (subshape - 2 * sprung) as usize)
        };
        self.damage.modules.iter().filter(|m| m.actor == actor && m.attached && m.kind.gear())
            .filter(|m| self.gears.iter().any(|g| g.owner == m.owner && !g.springs.is_empty()) == spring)
            .nth(index).map(|m| m.owner)
    }

    /// The skids of this aircraft, carrying `weight`, if it stands on skids.
    fn skids(&self, actor: u32, weight: f64) -> Option<Skids> {
        let plates = || self.damage.plates.iter().filter(move |p| p.actor == actor && p.attached)
            .filter(|p| p.cold["definition"]["id"].as_str().is_some_and(crate::game_geometry::skid));
        let stroke = plates().filter(|p| p.cold["definition"]["id"].as_str().and_then(|id| id.rsplit(':').next())
            .is_some_and(|last| last.starts_with("leg-"))).map(|p| p.length).fold(0.0, f64::max);
        if stroke <= 0.0 {
            return None;
        }
        let travel = stroke * SKID_ELASTIC;
        let worn = plates().flat_map(|p| p.dents.values().map(move |d| d.depth / (DENT_SHARE * p.thickness)))
            .fold(0.0, f64::max).min(1.0);
        Some(Skids { stroke, travel, elastic: weight * travel, plastic: SKID_YIELD * weight * (stroke - travel), worn })
    }

    pub(super) fn contact_damage(&mut self, core: &NativeWorld, before: &[(RigidBodyHandle, Motion)], effects: &mut Effects) {
        let gravity = core.world.gravity.length();
        if gravity <= 0.0 { return; }
        let dt = core.world.integration_parameters.dt;
        for (handle, old) in before {
            if !old.dynamic || old.energy() <= 0.0 { continue; }
            let body = &core.world.bodies[*handle];
            let after = Motion::capture(body);
            let moved = after.center - old.center;
            // Only energy actually dissipated in this solve can damage a carrier. Spring/weight work
            // is already included in its motion. A contact cannot spend a vehicle's kinetic energy
            // more than once when several wheels or manifold points stop it together.
            let budget = (old.energy() - after.energy()
                + (old.mass * core.world.gravity.dot(moved)).max(0.0)
                + (body.user_force().dot(moved) + body.user_torque()
                    * angle_difference(after.rotation.angle(), old.rotation.angle())).max(0.0)).max(0.0);
            if budget <= 0.0 { continue; }
            let mut actor = 0;
            let (mut contacts, mut pressed) = (Vec::new(), Vector::ZERO);
            for &collider in body.colliders() {
                let Some(meta) = core.metadata.get(&collider).filter(|m| m.actor != 0) else { continue };
                let shape = &core.world.colliders[collider];
                for pair in core.world.narrow_phase.contact_pairs_with(collider) {
                    let first = pair.collider1 == collider;
                    let other = if first { pair.collider2 } else { pair.collider1 };
                    // This path is ground/static-obstacle loading, not a second vehicle collision model.
                    if core.world.colliders[other].parent().is_some_and(|h| core.world.bodies[h].is_dynamic()) { continue; }
                    for manifold in pair.manifolds() {
                        if manifold.data.solver_contacts.is_empty() { continue; }
                        let normal = if first { -manifold.data.normal } else { manifold.data.normal };
                        let (subshape, pose) = if first {
                            (manifold.subshape1, manifold.subshape_pos1())
                        } else {
                            (manifold.subshape2, manifold.subshape_pos2())
                        };
                        for contact in &manifold.points {
                            let impulse = contact.data.impulse.max(0.0);
                            pressed += normal * impulse;
                            let local = if first { contact.local_p1 } else { contact.local_p2 };
                            let at = shape.position() * pose.map_or(local, |pose| pose * local);
                            // The point is told in the solved pose. Its lever travels with the body;
                            // horizontal translation during a fast step must not invent angular closing.
                            let arm = old.rotation * after.rotation.inverse() * (at - after.center);
                            let velocity = old.velocity + Vector::new(-old.omega * arm.y, old.omega * arm.x);
                            let closing = -velocity.dot(normal);
                            // Ordinary support/rolling takes no owner lookup. Even gear without travel
                            // has the contact skin's allowance, so reject it before scanning any pieces.
                            if closing <= 0.0 || closing * closing <= 4.0 * gravity * VEHICLE_CONTACT_SKIN { continue; }
                            actor = meta.actor;
                            contacts.push((meta.sprung, Contact { subshape, point: Point::new(at.x, at.y),
                                normal: Point::new(normal.x, normal.y), impulse, closing }));
                        }
                    }
                }
            }
            if contacts.is_empty() { continue; }
            // A fast body meets the ground part way through a step: the solver stops it there, and the contacts
            // looked at again for the rest of the step tell only what pressed it last. What the ground gave it all
            // through the step is the change of its momentum less its weight and the forces on it (its springs and
            // its thrusters). What the contacts do not tell of that is shared among the points that closed on the
            // ground, as fast as each did — where it came down onto the ground (`FALL`). Run into a face along
            // the ground, a wheel or a track climbs what the rigid solve stops it short against: what its contacts
            // tell of that is all that is counted.
            let way = if pressed.length() > 0.0 { pressed / pressed.length() } else {
                let closed = contacts.iter().fold(Vector::ZERO, |sum, (_, c)| sum + Vector::new(c.normal.x, c.normal.y) * c.closing);
                closed / closed.length()
            };
            let given = ((after.velocity - old.velocity) * old.mass - (core.world.gravity * old.mass + body.user_force()) * dt).dot(way);
            let hidden = given - pressed.dot(way);
            if hidden > 0.0 && -way.dot(core.world.gravity) >= FALL * gravity {
                let closing = contacts.iter().map(|(_, c)| c.closing).sum::<f64>();
                for (_, c) in &mut contacts { c.impulse += hidden * c.closing / closing; }
            }
            let weight = old.mass * gravity;
            let skids = self.skids(actor, weight);
            let mut impacts = Vec::new();
            for (sprung, c) in contacts {
                if c.impulse <= 0.0 { continue; }
                let struck = match self.contact_gear(actor, sprung, c.subshape) {
                    Some(owner) => Struck::Gear(owner),
                    None => {
                        let plate = self.damage.plates.iter().filter(|p| p.actor == actor && p.attached)
                            .min_by(|a, b| plate_distance(a, c.point).total_cmp(&plate_distance(b, c.point)));
                        match plate {
                            Some(p) if skids.is_some() && p.cold["definition"]["id"].as_str().is_some_and(crate::game_geometry::skid) => Struck::Skid(p.owner),
                            _ => Struck::Hull(plate.map(|p| p.owner)),
                        }
                    }
                };
                // The existing suspension's full travel is a harmless impact allowance too, as the elastic travel of skids is.
                let travel = match struck {
                    Struck::Gear(owner) => self.damage.module(owner).map_or(0.0, gear_travel),
                    Struck::Skid(_) => skids.map_or(0.0, |s| s.travel),
                    Struck::Hull(_) => 0.0,
                }.max(2.0 * VEHICLE_CONTACT_SKIN);
                let excess = c.closing * c.closing - 2.0 * gravity * travel;
                if excess <= 0.0 { continue; }
                let energy = 0.5 * c.impulse * excess / c.closing;
                // The springs already encode the built load, laden rating and travel. Work
                // at their full stop is the local overload scale, not armour thickness or km/h.
                let capacity = match struck {
                    Struck::Gear(owner) => self.gears.iter().find(|g| g.owner == owner).filter(|g| !g.springs.is_empty()).map_or_else(
                        || weight * travel / self.damage.modules.iter().filter(|m| m.actor == actor && m.attached && m.kind.gear()).count().max(1) as f64,
                        |g| g.springs.iter().map(|s| (s.load + s.firm * travel * (1.0 - SPRING_REST)) * travel).sum::<f64>(),
                    ),
                    // All the skids take all the aircraft: their hits are reckoned together (`land`).
                    Struck::Skid(_) => skids.map_or(0.0, |s| s.elastic),
                    Struck::Hull(_) => weight * travel,
                }.max(1.0);
                impacts.push(Impact { struck, point: c.point, normal: c.normal, impulse: c.impulse, closing: c.closing, energy, capacity });
            }
            let spent = impacts.iter().map(|hit| hit.energy).sum::<f64>();
            if spent > budget {
                for hit in &mut impacts { hit.energy *= budget / spent; }
            }
            self.land(actor, weight, skids, &impacts, effects);
        }
    }

    /// Shares out what a construction carrying `weight` met the ground with in a step: each wheel and track takes what
    /// its springs take and breaks under what they do not, the skids of an aircraft take all their hits together, and
    /// the hull is crushed by whatever its gear did not take, and by what it met the ground with itself past its skin.
    fn land(&mut self, actor: u32, weight: f64, skids: Option<Skids>, impacts: &[Impact], effects: &mut Effects) {
        let mut crush = Vec::new();
        for hit in impacts {
            let (Struck::Gear(owner), true) = (hit.struck, hit.energy > hit.capacity) else { continue };
            // Capacity is the elastic work the installed support can take, not a damage scale
            // starting at zero. Subcritical support cycles must not accumulate fatigue or events.
            let fraction = hit.energy / hit.capacity - 1.0;
            // What breaks it takes the rest of its health; the work past that goes on through its mount, from the
            // middle of the gear on.
            let (left, middle) = self.damage.module(owner)
                .map_or((0.0, hit.point), |m| (if m.usable() { m.health / m.max_health } else { 0.0 }, Point::new(m.pose.x, m.pose.y)));
            self.ground_strike(owner, hit.point, fraction, effects);
            if fraction > left {
                let stroke = (middle.x - hit.point.x) * hit.normal.x + (middle.y - hit.point.y) * hit.normal.y;
                crush.push(Crush { point: hit.point, normal: hit.normal, stroke: stroke.max(0.0), energy: hit.capacity * (fraction - left) });
            }
            // Dents use the existing fixed material coordinates. A violent landing does not bore a
            // ballistic hole, remove mass, change the admitted hull or detach a welded part.
            let mount = self.damage.module(owner).and_then(|m| m.cold["mountId"].as_str());
            let plate = self.damage.plates.iter().filter(|p| p.actor == actor && p.attached)
                .filter(|p| mount.is_none_or(|id| p.cold["definition"]["id"].as_str() == Some(id)))
                .min_by(|a, b| plate_distance(a, hit.point).total_cmp(&plate_distance(b, hit.point)))
                .map(|p| p.owner);
            if let Some(plate) = plate {
                self.ground_dent(plate, hit.point, |p| p.thickness * fraction.min(DENT_SHARE));
            }
            event(actor, hit, Some(owner), effects);
        }
        let on_skids = impacts.iter().filter(|hit| matches!(hit.struck, Struck::Skid(_))).collect::<Vec<_>>();
        if let Some(skids) = skids.filter(|_| !on_skids.is_empty()) {
            let energy = on_skids.iter().map(|hit| hit.energy).sum::<f64>();
            // Skids worn through take nothing more.
            let (elastic, left) = if skids.worn >= 1.0 { (0.0, 0.0) } else { (skids.elastic, 1.0 - skids.worn) };
            if energy > elastic {
                let used = ((energy - elastic) / skids.plastic).min(left);
                let through = energy - elastic - skids.plastic * left;
                for hit in &on_skids {
                    let Struck::Skid(owner) = hit.struck else { continue };
                    // Each spot of them they met the ground with is worn as far as they all are now.
                    let worn = if through > 0.0 { 1.0 } else { skids.worn + used };
                    self.ground_dent(owner, hit.point, |p| {
                        let uv = p.material_uv(hit.point);
                        let key = (uv.x.clamp(0.0, 0.999999) * 32.0).floor() as u32 * 2 + u32::from(uv.y > 0.5);
                        worn * DENT_SHARE * p.thickness - p.dents.get(&key).map_or(0.0, |d| d.depth)
                    });
                    event(actor, hit, Some(owner), effects);
                    if through > 0.0 {
                        crush.push(Crush { point: hit.point, normal: hit.normal, stroke: skids.stroke, energy: through * hit.energy / energy });
                    }
                }
                // Broken, each plate of them that took the ground is torn through where it took it hardest.
                if through > 0.0 && left > 0.0 {
                    let mut torn: Vec<(u32, &Impact)> = Vec::new();
                    for hit in &on_skids {
                        let Struck::Skid(owner) = hit.struck else { continue };
                        match torn.iter_mut().find(|(plate, _)| *plate == owner) {
                            Some(entry) => if hit.energy > entry.1.energy { entry.1 = hit },
                            None => torn.push((owner, hit)),
                        }
                    }
                    for (owner, hit) in torn { self.ground_tear(owner, hit.point, effects); }
                }
            }
        }
        // The hull has no travel of its own. Each point of it past its contact skin is dented, and all it met the
        // ground with past that skin, once for the whole hull, goes into crushing it.
        let on_hull = impacts.iter().filter(|hit| matches!(hit.struck, Struck::Hull(_))).collect::<Vec<_>>();
        for hit in &on_hull {
            let (Struck::Hull(plate), true) = (hit.struck, hit.energy > hit.capacity) else { continue };
            let fraction = hit.energy / hit.capacity - 1.0;
            if let Some(plate) = plate {
                self.ground_dent(plate, hit.point, |p| p.thickness * fraction.min(DENT_SHARE));
            }
            event(actor, hit, plate, effects);
        }
        let energy = on_hull.iter().map(|hit| hit.energy).sum::<f64>();
        let through = energy - on_hull.first().map_or(0.0, |hit| hit.capacity);
        if through > 0.0 {
            crush.extend(on_hull.iter().map(|hit| Crush { point: hit.point, normal: hit.normal, stroke: 0.0, energy: through * hit.energy / energy }));
        }
        self.crush(actor, weight, &crush, effects);
    }

    /// Crushes the hull of a construction carrying `weight` by what its gear let through to it in a step, together: from
    /// the ground it met, past where its gear reaches (`Crush::stroke`), as far as that energy takes it at the load the
    /// hull crushes at (`HULL_CRUSH`), and as far to either side of where it met the ground. Each piece the crush
    /// reaches loses the share of its depth the crush went through: a piece crushed through is destroyed, and the
    /// construction whose command posts are all destroyed is out of action, as when fire destroys them. Each plate it
    /// reaches is dented by as much.
    fn crush(&mut self, actor: u32, weight: f64, crush: &[Crush], effects: &mut Effects) {
        let energy = crush.iter().map(|c| c.energy).sum::<f64>();
        if !(energy > 0.0) { return; }
        let mean = |f: &dyn Fn(&Crush) -> f64| crush.iter().map(|c| f(c) * c.energy).sum::<f64>() / energy;
        let (nx, ny) = (mean(&|c| c.normal.x), mean(&|c| c.normal.y));
        let length = hypot(nx, ny);
        if !(length > 0.0) { return; }
        let (into, along) = (Point::new(nx / length, ny / length), Point::new(-ny / length, nx / length));
        let stroke = mean(&|c| c.stroke);
        let depth = stroke + energy / (HULL_CRUSH * weight);
        let (first, last) = crush.iter().fold((f64::INFINITY, f64::NEG_INFINITY), |(a, b), c| (a.min(c.point.dot(along)), b.max(c.point.dot(along))));
        let front = Front { into, along, ground: mean(&|c| c.point.dot(into)), stroke, depth, span: (first - depth, last + depth),
            at: Point::new(mean(&|c| c.point.x), mean(&|c| c.point.y)) };
        let pieces = self.damage.modules.iter().filter(|m| m.actor == actor && m.usable())
            .map(|m| (m.owner, front.share(m.world_polygons().into_iter().flatten(), Reach::of(m.kind)))).collect::<Vec<_>>();
        for (owner, (taken, point)) in pieces {
            if taken > 0.0 { self.ground_strike(owner, point, taken, effects); }
        }
        let plates = self.damage.plates.iter().filter(|p| p.actor == actor && p.attached)
            .map(|p| (p.owner, front.share(p.local_nodes.iter().map(|n| p.pose.world_point(*n)), Reach::Hull))).collect::<Vec<_>>();
        for (owner, (taken, point)) in plates {
            if taken > 0.0 { self.ground_dent(owner, point, |p| p.thickness * DENT_SHARE * taken); }
        }
    }

    /// Harms a piece as the ground does, and tells it apart from a hit (`Module::ground_marks`, `ground_damage`).
    fn ground_strike(&mut self, owner: u32, at: Point, fraction: f64, effects: &mut Effects) {
        let Some((marks, health)) = self.damage.module(owner).map(|m| (m.mark_revision, m.health)) else { return };
        self.damage.contact_strike(owner, at, fraction, effects);
        if let Some(m) = self.damage.module_mut(owner) {
            m.ground_marks += m.mark_revision - marks;
            m.ground_damage += health - m.health;
        }
    }

    /// Dents a plate as the ground does, `depth` of it deep where `at` is, and tells it apart from a hit (`Plate::ground_marks`).
    fn ground_dent(&mut self, owner: u32, at: Point, depth: impl FnOnce(&Plate) -> f64) {
        let Some(p) = self.damage.plate_mut(owner) else { return };
        let marks = p.mark_revision;
        let deep = depth(p);
        p.record_dent(at, deep, (p.length * 0.1).clamp(0.05, 0.4));
        p.ground_marks += p.mark_revision - marks;
    }

    /// Tears a plate of skids through across where `at` is (`SKID_GAP`), as a break does, and tells it apart from a hit.
    fn ground_tear(&mut self, owner: u32, at: Point, effects: &mut Effects) {
        let Some(p) = self.damage.plate(owner) else { return };
        let (revision, local) = (p.revision, p.pose.local_point(at));
        let x = local.x.clamp(-p.length / 2.0, p.length / 2.0);
        let (start, end) = (p.pose.world_point(Point::new(x, p.thickness)), p.pose.world_point(Point::new(x, -p.thickness)));
        self.damage.cut(owner, start, end, SKID_GAP / 2.0, effects);
        if let Some(p) = self.damage.plate_mut(owner) { p.ground_marks += p.revision - revision; }
    }
}

/// How far a crush went into a hull: the way into it from the ground and the way along the ground, how far along `into`
/// the ground it met is, how far from there its gear reaches and the crush goes (`stroke`, `depth`), between which
/// places along the ground (`span`), and where it met the ground, on the whole.
struct Front {
    into: Point,
    along: Point,
    ground: f64,
    stroke: f64,
    depth: f64,
    span: (f64, f64),
    at: Point,
}
impl Front {
    /// The share of the depth of a part spanning `points` the crush went through, past the gear and up to its depth, and
    /// the point of the part the crush met first. How the part meets it is its `reach`.
    fn share(&self, points: impl Iterator<Item = Point>, reach: Reach) -> (f64, Point) {
        let (mut low, mut high, mut start, mut end, mut nearest) = (f64::INFINITY, f64::NEG_INFINITY, f64::INFINITY, f64::NEG_INFINITY, self.at);
        for p in points {
            let deep = p.dot(self.into) - self.ground;
            if deep < low { low = deep; nearest = p; }
            high = high.max(deep);
            start = start.min(p.dot(self.along));
            end = end.max(p.dot(self.along));
        }
        if end < self.span.0 || start > self.span.1 { return (0.0, nearest); }
        if reach == Reach::Gear && low <= self.stroke + VEHICLE_CONTACT_SKIN { return (0.0, nearest); }
        let through = high.min(self.depth) - if reach == Reach::Hull && self.stroke == 0.0 { low } else { low.max(0.0).max(self.stroke) };
        ((through / (high - low).max(1e-3)).clamp(0.0, 1.0), nearest)
    }
}

/// How a part meets a crush of its hull from the ground (`Front::share`).
#[derive(Clone, Copy, PartialEq)]
enum Reach {
    /// The hull and what is on it. Where the hull itself met the ground, what of a part stuck out past that ground went
    /// through with all the crush there was: a sensor on the roof of a hull that lands on it is crushed first.
    Hull,
    /// A tool that digs, drills, lifts, levels or paves: stuck out past the ground, it is where its work puts it.
    Tool,
    /// Running gear. Down on the ground the crush met, or as low as the gear it went through reaches, it stands on that
    /// ground and takes its own hits there on its springs.
    Gear,
}
impl Reach {
    fn of(kind: ComponentKind) -> Reach {
        if kind.gear() { Reach::Gear }
        else if matches!(kind, ComponentKind::Excavator | ComponentKind::Drill | ComponentKind::Builder | ComponentKind::Blade | ComponentKind::Paver) { Reach::Tool }
        else { Reach::Hull }
    }
}

fn event(actor: u32, hit: &Impact, owner: Option<u32>, effects: &mut Effects) {
    effects.event(json!({"type":"ground","owner":owner,"x":hit.point.x,"y":hit.point.y,
        "nx":hit.normal.x,"ny":hit.normal.y,"material":"steel","otherMaterial":"ground",
        "impulse":hit.impulse,"normalSpeed":hit.closing,"closingSpeed":hit.closing,
        "impactEnergy":hit.energy,"contactPair":format!("terrain:{}:{}",actor,owner.unwrap_or(0))}));
}

fn plate_distance(plate: &Plate, at: Point) -> f64 {
    let local = plate.pose.local_point(at);
    let x = (local.x.abs() - plate.length / 2.0).max(0.0);
    let y = (local.y.abs() - plate.thickness / 2.0).max(0.0);
    x * x + y * y
}

#[cfg(test)]
#[path = "game_contact_damage_tests.rs"]
mod tests;
