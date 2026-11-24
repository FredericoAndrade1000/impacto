//! Admit one immutable compound contact shape and one rigid body per vehicle.
//! Projectile hitboxes remain in Geometry, independently of the contact hull.
use super::*;
use crate::game_geometry::{ComponentKind, Pose, track_wheels};
use crate::game_motion::{Built, gear_seats, gear_travel, springs};
use crate::Metadata;
use parry2d_f64::shape::{Compound, TriMesh};
use rapier2d_f64::prelude::*;

fn vector(p: Point) -> Vector {
    Vector::new(p.x, p.y)
}
fn relative(parent: Pose, child: Pose) -> Pose {
    let p = parent.local_point(Point::new(child.x, child.y));
    Pose {
        x: p.x,
        y: p.y,
        angle: child.angle - parent.angle,
    }
}
/// What a vehicle turned about in the air goes on with (`GameState::admit`), from the one it takes the place of as that one
/// was before it left: where its centre of mass was, how it moved and turned, whether its flight computer flew it and where
/// it held it, what it was asked (throttle, brake and climb), and how hard each of its thrusters pushed, in the order of its
/// pieces — the order its mirror image has them in. And how it is to lean (`angle`): where it hovers still is the mirror
/// image of where that one did (game_hover.rs `poise`), and off it it leans as far as that one did off its own, the same
/// way in the field, so that what its thrusters push it with points where theirs did. One that hovered leans the other
/// way; one leant over to go along the field — or level, with thrusters that hold it up level — leans as it leant.
struct Aloft {
    handle: u32,
    center: Point,
    velocity: Point,
    angle: f64,
    omega: f64,
    flying: bool,
    station: (Option<f64>, Option<f64>),
    asked: (f64, f64, f64),
    thrust: Vec<f64>,
}
impl Aloft {
    fn of(d: &DriveState, handle: u32, damage: &crate::game_damage::DamageState, gravity: Point) -> Self {
        let body = crate::game_hover::Body { mass: d.carrier_mass, inertia: d.carrier_inertia, center: d.center(), gravity, above: None, air: None,
            pull: Default::default(), hung: 0.0, swing: 0.0 };
        Self { handle, center: d.center(), velocity: d.velocity, angle: d.pose.angle - 2.0 * crate::game_hover::poise(d, damage, handle, body),
            omega: d.omega, flying: d.flying, station: d.station, asked: (d.throttle, d.brake, d.rise),
            thrust: damage.modules.iter().filter(|m| m.actor == handle && m.kind == ComponentKind::Thruster).map(|m| m.thrust).collect() }
    }
}
fn body(core: &mut NativeWorld, builder: RigidBodyBuilder) -> u32 {
    // One more than the last given, whichever were taken away since.
    let id = core.bodies.keys().next_back().map_or(1, |last| last + 1);
    let handle = core.world.insert_body(builder);
    core.bodies.insert(id, handle);
    id
}

/// Rooms and chassis beams are solid to terrain, but the space between separate
/// pieces and under an arch is not. The compiler supplies those exact volumes;
/// contact admission decomposes them once and adds real walls and equipment.
/// Running gear, barrels and small sensors retain their existing contact roles.
fn contact_contours(plates: &[Plate], modules: &[Module], actor: u32, pose: Pose, volumes: &[Value]) -> Result<Vec<Vec<Point>>, String> {
    let mut contours: Vec<Vec<Point>> = Vec::new();
    let polygon = |mut vertices: Vec<Vector>| -> Result<TriMesh, String> {
        let area = vertices.iter().enumerate().map(|(i, p)| {
            let next = vertices[(i + 1) % vertices.len()];
            p.x * next.y - p.y * next.x
        }).sum::<f64>();
        if area < 0.0 { vertices.reverse(); }
        TriMesh::from_polygon(vertices).ok_or_else(|| "Invalid rigid contact polygon".into())
    };
    let mut solid = |mesh: TriMesh| -> Result<(), String> {
        let parts = Compound::decompose_trimesh(&mesh).ok_or("Invalid rigid contact mesh")?;
        for (_, shape) in parts.shapes() {
            let points = if let Some(polygon) = shape.as_convex_polygon() { polygon.points() }
                else { shape.as_triangle().ok_or("Invalid rigid contact mesh")?.vertices() };
            contours.push(points.iter().map(|p| Point::new(p.x, p.y)).collect());
        }
        Ok(())
    };
    for volume in volumes {
        let vertices = volume.as_array().filter(|points| points.len() >= 3).ok_or("Invalid rigid contact volume")?.iter()
            .map(|p| vector(pose.local_point(Point::from_value(p)))).collect();
        solid(polygon(vertices)?)?;
    }
    for plate in plates {
        if plate.actor != actor || !plate.attached {
            continue;
        }
        // All authored stock, including end extensions, is real contact metal.
        // Neither attachment anchors nor the damaged grid clip this base mesh.
        let vertices = plate.local_nodes.iter().map(|&p| vector(pose.local_point(plate.pose.world_point(p)))).collect::<Vec<_>>();
        let triangles = plate.indices.chunks_exact(3).map(|indices| {
            let [a,b,c] = [vertices[indices[0] as usize],vertices[indices[1] as usize],vertices[indices[2] as usize]];
            let area = (b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x);
            if area.abs()<=1e-12 {return Err("Invalid rigid contact plate mesh");}
            Ok(if area<0.0 {[indices[0],indices[2],indices[1]]} else {[indices[0],indices[1],indices[2]]})
        }).collect::<Result<Vec<_>,_>>()?;
        solid(TriMesh::new(vertices,triangles).map_err(|_|"Invalid rigid contact plate mesh")?)?;
    }
    for module in modules {
        if module.actor != actor || !module.attached {
            continue;
        }
        if module.kind.gear() || matches!(module.kind, ComponentKind::Weapon | ComponentKind::Sensor) {
            continue;
        }
        for outline in module.world_polygons() {
            let vertices = outline.into_iter().map(|p| vector(pose.local_point(p))).collect();
            // Module outlines are ordered polygons; reuse the same exact partition.
            solid(polygon(vertices)?)?;
        }
    }
    // Equipment wholly inside one convex volume adds no contact surface. Keep
    // only one of identical volumes, without joining across gaps or concavities.
    let contains = |outer: &[Point], inner: &[Point]| outer.iter().enumerate().all(|(i, a)| {
        let b = outer[(i + 1) % outer.len()];
        inner.iter().all(|p| Point::new(b.x-a.x, b.y-a.y).cross(Point::new(p.x-a.x, p.y-a.y)) >= -1e-9)
    });
    Ok(contours.iter().enumerate().filter(|(i, contour)| !contours.iter().enumerate()
        .any(|(j, other)| *i != j && contains(other, contour) && (j < *i || !contains(contour, other))))
        .map(|(_, contour)| contour.clone()).collect())
}

/// Saved contours are already convex and ordered. Re-hulling them on every
/// readmission changes almost-collinear corners and the bit-exact saved state.
fn contact_shape(points: &[Point]) -> Result<SharedShape, String> {
    if points.len() < 3 || points.iter().enumerate().any(|(i, a)| {
        let b = points[(i + 1) % points.len()];
        a.distance(b) <= 1e-12 || points.iter().any(|p|
            Point::new(b.x-a.x, b.y-a.y).cross(Point::new(p.x-a.x, p.y-a.y)) < -1e-9)
    }) { return Err("Invalid rigid contact contour".into()); }
    if points.iter().enumerate().map(|(i, a)| a.cross(points[(i + 1) % points.len()])).sum::<f64>() <= 1e-12 {
        return Err("Invalid rigid contact contour".into());
    }
    SharedShape::convex_polyline_unmodified(points.iter().copied().map(vector).collect())
        .ok_or_else(|| "Invalid rigid contact contour".into())
}

/// Admission prepares every fallible part before replacing an existing actor.
/// A supplied contact, even [], preserves a saved carrier; a new one is weighed
/// from its complete material before any damage can change its functionality.
pub(super) fn prepare_contact(plates: &[Plate], modules: &[Module], actor: &mut Actor) -> Result<(), String> {
    let pose = actor.drive.as_ref().map_or_else(|| Pose::from_value(&actor.cold), |drive| drive.pose);
    if actor.contact_contours.is_none() {
        actor.contact_contours = Some(contact_contours(plates, modules, actor.handle, pose, array(&actor.cold,"contactVolumes"))?);
        if let Some(drive) = &mut actor.drive {
            let (mass, center, inertia) = weighed(plates, modules, actor.handle, pose, |m| (m.physical_mass, m.physical_inertia));
            drive.carrier_mass = mass;
            drive.carrier_center = center;
            drive.carrier_inertia = inertia;
        }
    }
    for contour in actor.contact_contours.as_ref().unwrap() { contact_shape(contour)?; }
    if let Some(cold) = actor.cold.as_object_mut() {
        cold.remove("contactVolumes");
        cold.remove("contactContours");
    }
    Ok(())
}

/// The complete construction has one COM and inertia. Damage changes functionality,
/// never this mass distribution; what the construction carries does, each time it is
/// weighed (`GameState::weigh`).
pub(super) fn assembly_mass(damage: &DamageState, actor: u32, pose: Pose) -> (f64, Point, f64) {
    weighed(&damage.plates, &damage.modules, actor, pose, |m| (m.physical_mass, m.physical_inertia))
}
/// The construction as it was built, whatever it carries now (`Module::built_mass`). The springs
/// of its gear are made for this one, so they are the same each time it is admitted.
fn built(damage: &DamageState, actor: u32, pose: Pose) -> Built {
    let (mass, center, inertia) = weighed(&damage.plates, &damage.modules, actor, pose, |m| {
        let mass = m.built_mass();
        (mass, if m.reservoir() { mass * (m.width * m.width + m.height * m.height) / 12.0 } else { m.physical_inertia })
    });
    // Size the spring's reserve for the installed payload. A static frame/yield
    // allowance does not change elastic stiffness when the payload is unchanged.
    // It lies where what holds it stands: a load bed over the rear axles loads those.
    let (mut payload, mut moment) = (0.0, Point::ZERO);
    for m in damage.modules.iter().filter(|m| m.actor == actor && m.attached) {
        let extra = m.full_mass() - m.built_mass();
        if extra <= 0.0 { continue; }
        let c = pose.local_point(m.pose.world_point(m.physical_center));
        payload += extra;
        moment.x += extra * c.x;
        moment.y += extra * c.y;
    }
    let laden_center = Point::new((mass * center.x + moment.x) / (mass + payload), (mass * center.y + moment.y) / (mass + payload));
    Built { mass, center, inertia, laden: (mass + payload) / mass, laden_center }
}
fn weighed(plates: &[Plate], modules: &[Module], actor: u32, pose: Pose, weigh: impl Fn(&Module) -> (f64, f64)) -> (f64, Point, f64) {
    let mut mass = 0.0;
    let mut first = Point::ZERO;
    let mut second = 0.0;
    for p in plates {
        if p.actor != actor || !p.attached {
            continue;
        }
        let m = p.mass();
        let c = pose.local_point(p.pose.world_point(p.physical_center));
        mass += m;
        first.x += m * c.x;
        first.y += m * c.y;
        second += p.inertia() + m * c.dot(c);
    }
    for m in modules {
        if m.actor != actor || !m.attached {
            continue;
        }
        let c = pose.local_point(m.pose.world_point(m.physical_center));
        let (weight, turning) = weigh(m);
        mass += weight;
        first.x += weight * c.x;
        first.y += weight * c.y;
        second += turning + weight*c.dot(c);
    }
    mass = mass.max(0.001);
    let center = Point::new(first.x / mass, first.y / mass);
    let inertia = (second - mass * center.dot(center)).max(mass * 0.001);
    (mass, center, inertia)
}

impl GameState {
    pub(crate) fn install(&mut self, core: &mut NativeWorld) -> Result<(), String> {
        let terrain = if self.terrain.is_flat() {
            Vec::new()
        } else {
            self.terrain
                .points
                .iter()
                .rev()
                .flat_map(|p| [p.x, p.y])
                .collect()
        };
        let gravity = core.world.gravity;
        *core = NativeWorld::new(&terrain, gravity.x, gravity.y)?;
        self.seat(core, None)?;
        self.sync_poses(core);
        self.update_powertrains();
        self.refresh_sensors();
        Ok(())
    }
    /// Gives the constructions their bodies: every one of a scene, or `only` those that came to a field
    /// that goes on, among the others as they stand.
    fn seat(&mut self, core: &mut NativeWorld, only: Option<&[u32]>) -> Result<(), String> {
        let gravity = core.world.gravity;
        let coming = |actor: u32| only.is_none_or(|handles| handles.contains(&actor));
        for actor in &mut self.actors {
            if !coming(actor.handle) {
                continue;
            }
            let pose = actor.drive.as_ref().map_or_else(
                || Pose {
                    x: number(&actor.cold, "x", 0.0),
                    y: number(&actor.cold, "y", 0.0),
                    angle: number(&actor.cold, "angle", 0.0),
                },
                |d| d.pose,
            );
            let dynamic = actor.drive.as_ref().is_some_and(|d| d.enabled);
            let velocity = actor.drive.as_ref().map_or(Point::ZERO, |d| d.velocity);
            let omega = actor.drive.as_ref().map_or(0.0, |d| d.omega);
            actor.body = body(
                core,
                RigidBodyBuilder::new(if dynamic {
                    RigidBodyType::Dynamic
                } else {
                    RigidBodyType::Fixed
                })
                .translation(vector(Point::new(pose.x, pose.y)))
                .rotation(pose.angle)
                .linvel(vector(velocity))
                .angvel(omega)
                .ccd_enabled(true)
                // At 60 Hz a moving hull can cover over 20 cm in one frame.
                // Predict across that travel before the next terrain contact.
                .soft_ccd_prediction(0.4)
                .can_sleep(true),
            );
            let (mass, center, inertia) = actor.drive.as_ref().map_or_else(
                || assembly_mass(&self.damage, actor.handle, pose),
                |d| (d.carrier_mass, d.carrier_center, d.carrier_inertia),
            );
            set_mass(core, actor.body, mass, center, inertia);
            let rigid = &mut core.world.bodies[core.bodies[&actor.body]];
            rigid.set_linvel(vector(velocity), false);
            rigid.set_angvel(omega, false);
            if let Some(d) = &mut actor.drive {
                d.mass = mass;
                d.carrier_mass = mass;
                d.inertia = inertia;
                d.carrier_inertia = inertia;
                d.local_center = center;
                d.carrier_center = center;
                d.gear_count = self
                    .damage
                    .modules
                    .iter()
                    .filter(|m| {
                        m.actor == actor.handle && m.attached && m.kind.gear() && m.health > 0.0
                    })
                    .count() as u32;
                d.grounded = false;
            }
            let body_shapes = actor.contact_contours.as_ref().unwrap().iter()
                .map(|contour| contact_shape(contour).map(|shape| (rapier2d_f64::math::Pose::IDENTITY, shape)))
                .collect::<Result<Vec<_>, _>>()?;
            // Its gear is given its springs, made for the vehicle as it was built.
            let (mut seats, mut of) = (Vec::new(), Vec::new());
            for (index, gear) in self.gears.iter_mut().enumerate() {
                let Some(m) = self.damage.module(gear.owner).filter(|m| m.actor == actor.handle && m.attached) else {
                    continue;
                };
                gear.springs.clear();
                let local = relative(pose, m.pose);
                for at in gear_seats(m) {
                    let (c, s) = (cos(local.angle), sin(local.angle));
                    seats.push((
                        Point::new(local.x + c * at.x - s * at.y, local.y + s * at.x + c * at.y),
                        at.x,
                        gear_travel(m),
                    ));
                    of.push(index);
                }
            }
            if dynamic {
                let made = springs(&seats, &built(&self.damage, actor.handle, pose), -gravity.y);
                for (index, spring) in of.into_iter().zip(made) {
                    self.gears[index].springs.extend(spring);
                }
            }
            // On its springs a gear meets the ground it stands on only at its stop, with all its travel
            // taken, and a face it climbs (`SPRING_SLANT`) with its rim where it stands at rest. The shapes
            // of its stops come first, then those of its rims, then those of gear without springs, which
            // meets all the ground with its rim (`Metadata::sprung`). The belt of a track runs up from its
            // road wheels to its idler and its sprocket, which the hull holds: its stop is the whole of it,
            // its road wheels pressed up all their travel, which meets all it meets as the hull does
            // (`GroundContacts`), and its rim is its lower run, at rest.
            let gear: Vec<(&crate::game_damage::Module, bool)> = self.damage.modules.iter()
                .filter(|m| m.actor == actor.handle && m.attached && m.kind.gear())
                .map(|m| (m, self.gears.iter().any(|gear| gear.owner == m.owner && !gear.springs.is_empty())))
                .collect();
            // The solver holds a shape as far off the ground as the contact margin of its collider: the
            // shape is that much smaller than the gear, and the gear meets the ground with its own rim —
            // where its springs meet it, and where a page draws it.
            let skin = crate::VEHICLE_CONTACT_SKIN;
            let place = |m: &crate::game_damage::Module, at: Point| {
                let local = relative(pose, m.pose);
                let (c, s) = (cos(local.angle), sin(local.angle));
                rapier2d_f64::math::Pose::new(
                    vector(Point::new(local.x + c * at.x - s * at.y, local.y + s * at.x + c * at.y)),
                    local.angle,
                )
            };
            // A track whole, its road wheels pressed up `lift`.
            let outline = |m: &crate::game_damage::Module, lift: f64| {
                let wheels = track_wheels(m.width, m.height);
                SharedShape::round_convex_hull(&wheels.corners(lift).map(vector), wheels.radius - skin).map_or_else(
                    // Pressed up as far as its ends, it is its upper run.
                    || (place(m, Point::new(0.0, wheels.end.y)), SharedShape::capsule_x(wheels.end.x, wheels.radius - skin)),
                    |shape| (place(m, Point::ZERO), shape),
                )
            };
            let rim = |m: &crate::game_damage::Module| {
                if m.kind == ComponentKind::Wheel {
                    return (place(m, Point::ZERO), SharedShape::ball(m.height / 2.0 - skin));
                }
                let wheels = track_wheels(m.width, m.height);
                (place(m, Point::new(0.0, wheels.low)), SharedShape::capsule_x(wheels.road[wheels.road.len() - 1], wheels.radius - skin))
            };
            let stop = |m: &crate::game_damage::Module| {
                let travel = gear_travel(m) * (1.0 - SPRING_REST);
                if m.kind == ComponentKind::Wheel {
                    (place(m, Point::new(0.0, travel)), SharedShape::ball(m.height / 2.0 - skin))
                } else {
                    outline(m, travel)
                }
            };
            let whole = |m: &crate::game_damage::Module| if m.kind == ComponentKind::Wheel { rim(m) } else { outline(m, 0.0) };
            let on_springs = || gear.iter().filter(|(_, sprung)| *sprung).map(|(m, _)| *m);
            let sprung = on_springs().count() as u32;
            let mut gear_shapes = on_springs()
                .map(stop)
                .chain(on_springs().map(rim))
                .chain(gear.iter().filter(|(_, sprung)| !*sprung).map(|(m, _)| whole(m)))
                .collect::<Vec<_>>();
            gear_shapes.extend(body_shapes);
            if !gear_shapes.is_empty() {
                let builder = ColliderBuilder::compound(gear_shapes);
                let owner = self
                    .damage
                    .plates
                    .iter()
                    .find(|p| p.actor == actor.handle && p.attached)
                    .map(|p| p.owner)
                    .or_else(|| {
                        self.damage
                            .modules
                            .iter()
                            .find(|m| m.actor == actor.handle && m.attached)
                            .map(|m| m.owner)
                    })
                    .unwrap_or(0);
                let id = core.next_collider();
                core.insert_collider(
                    id,
                    actor.body,
                    builder
                        .density(0.0)
                        .friction(0.6)
                        .friction_combine_rule(CoefficientCombineRule::Min)
                        .restitution(0.0)
                        // A 2 cm contact margin absorbs the lag
                        // between the 60 Hz manifold and a fast hull entering
                        // a curved slope. It changes neither ballistic metal
                        // nor the admitted mass/contour, and needs no pose snap.
                        .contact_skin(crate::VEHICLE_CONTACT_SKIN)
                        // Constructions meet terrain and non-actor obstacles, never each other.
                        .collision_groups(InteractionGroups::new(Group::GROUP_3, Group::ALL & !Group::GROUP_3, InteractionTestMode::And))
                        .active_hooks(ActiveHooks::MODIFY_SOLVER_CONTACTS),
                    Metadata {
                        object: owner,
                        actor: actor.handle,
                        sprung,
                    },
                )?;
                if let Some(binding) = self.bindings.iter_mut().find(|b| b.owner == owner) {
                    binding.colliders.push(id);
                }
            }
        }
        for binding in &mut self.bindings {
            let state = self
                .damage
                .plate(binding.owner)
                .map(|p| (p.actor, p.pose))
                .or_else(|| self.damage.module(binding.owner).map(|m| (m.actor, m.pose)));
            if let Some((actor, pose)) = state {
                if !coming(actor) {
                    continue;
                }
                binding.body = self
                    .actors
                    .iter()
                    .find(|a| a.handle == actor)
                    .map_or(0, |a| a.body);
                binding.local =
                    body_pose(core, binding.body).map_or(pose, |parent| relative(parent, pose));
            }
        }
        for gear in &mut self.gear_bindings {
            let module = self.damage.module(gear.owner).unwrap();
            if !coming(module.actor) {
                continue;
            }
            gear.travel = gear_travel(module);
            gear.displacement = 0.0;
            gear.tilt = 0.0;
            gear.compression = 0.0;
        }
        Ok(())
    }
    /// A construction comes to a field that goes on, and those it takes the place of leave it (`leaving`).
    /// It is admitted as a scene admits its constructions and given its body alone: the ground, the others
    /// and the rounds in the air stand as they stood. What comes is read before anything leaves: one that
    /// is refused leaves the field as it was, with the one it would have taken the place of.
    /// The answer is what a cold frame would say of what came: the frames told the host nothing of it yet.
    /// One turned about in the air (`aloft`, by its handle) takes the place of the vehicle of its own handle and goes on
    /// as that one went (`Aloft`): laid wherever the host laid it, it is stood where that one flew once it is seated.
    pub(super) fn admit(&mut self, core: &mut NativeWorld, r: &Value) -> Result<Value, String> {
        crate::game_construction::require_runtime_admission(r)?;
        let leaving = array(r, "leaving").iter().map(|handle| handle.as_u64().unwrap_or(0) as u32).collect::<Vec<_>>();
        let coming = array(r, "actors").iter().map(|a| id(a, "handle")).collect::<Vec<_>>();
        if coming.iter().any(|&handle| handle == 0 || !leaving.contains(&handle) && self.actors.iter().any(|a| a.handle == handle)) {
            return Err("Construction already on the field".into());
        }
        let aloft = array(r, "aloft").iter().map(|handle| {
            let handle = handle.as_u64().unwrap_or(0) as u32;
            self.actors.iter().find(|a| a.handle == handle).filter(|_| leaving.contains(&handle) && coming.contains(&handle))
                .and_then(|a| a.drive.as_ref()).map(|d| Aloft::of(d, handle, &self.damage, Point::new(core.world.gravity.x, core.world.gravity.y)))
                .ok_or_else(|| "Only a vehicle that takes its own place turns about in the air".to_string())
        }).collect::<Result<Vec<_>, _>>()?;
        let (stood, theirs) = (self.actors.len(), leaving.iter().map(|&handle| self.owners(handle)).collect::<Vec<_>>());
        if let Err(refused) = self.enter(r) {
            self.actors.truncate(stood);
            self.forget(&array(r, "plates").iter().chain(array(r, "modules")).map(|part| id(part, "owner")).collect());
            return Err(refused);
        }
        for (&handle, owners) in leaving.iter().zip(&theirs) {
            self.leave(core, handle, owners);
        }
        for flight in &aloft {
            self.weigh_aloft(flight.handle);
        }
        let seated = self.seat(core, Some(&coming));
        if seated.is_err() {
            for &handle in &coming {
                let owners = self.owners(handle);
                self.leave(core, handle, &owners);
            }
        } else {
            for flight in &aloft {
                self.go_on(core, flight);
            }
        }
        // What the sensors read of a field is of the constructions it had: of one that took the place of
        // another, nothing.
        let here = self.actors.iter().map(|a| a.handle).filter(|handle| !leaving.contains(handle)).collect();
        self.sensors.retain_actors(&here);
        self.extents = (u64::MAX, HashMap::new());
        self.sync_poses(core);
        self.update_powertrains();
        self.refresh_sensors();
        seated.map(|()| self.cold_parts(&coming))
    }
    /// A vehicle turned about in the air comes weighed by what it holds, as `GameState::weigh` weighs one: what its pieces
    /// carry is what the one it takes the place of carried, and its centre of mass is to be where that one's was.
    fn weigh_aloft(&mut self, handle: u32) {
        for m in self.damage.modules.iter_mut().filter(|m| m.actor == handle) {
            m.weigh();
        }
        let Some(d) = self.actors.iter_mut().find(|a| a.handle == handle).and_then(|a| a.drive.as_mut()) else {
            return;
        };
        let (mass, center, inertia) = assembly_mass(&self.damage, handle, d.pose);
        (d.mass, d.carrier_mass, d.inertia, d.carrier_inertia, d.local_center, d.carrier_center) = (mass, mass, inertia, inertia, center, center);
    }
    /// Seated, a vehicle turned about in the air is stood where the one it took the place of was (`flight`): its own centre
    /// of mass where that one's was, leant as `Aloft` says, and moving and turning as that one did — the same way along the
    /// field and the same way round. It flies as that one flew, held where that one hovered and asked what that one was
    /// asked, and each of its thrusters pushes as the one of that one it is the mirror image of pushed, until its flight
    /// computer shares them out again, in its first step.
    fn go_on(&mut self, core: &mut NativeWorld, flight: &Aloft) {
        let Some(a) = self.actors.iter_mut().find(|a| a.handle == flight.handle) else {
            return;
        };
        let (Some(d), Some(&body)) = (a.drive.as_mut(), core.bodies.get(&a.body)) else {
            return;
        };
        let angle = flight.angle;
        let center = Pose { x: 0.0, y: 0.0, angle }.world_point(d.carrier_center);
        d.pose = Pose { x: flight.center.x - center.x, y: flight.center.y - center.y, angle };
        (d.velocity, d.omega, d.flying, d.station) = (flight.velocity, flight.omega, flight.flying, flight.station);
        d.control(flight.asked.0, flight.asked.1);
        d.climb_asked(flight.asked.2);
        let rigid = &mut core.world.bodies[body];
        rigid.set_translation(vector(Point::new(d.pose.x, d.pose.y)), true);
        rigid.set_rotation(Rotation::from_angle(angle), true);
        rigid.set_linvel(vector(d.velocity), true);
        rigid.set_angvel(d.omega, true);
        let thrusters = self.damage.modules.iter_mut().filter(|m| m.actor == flight.handle && m.kind == ComponentKind::Thruster);
        for (m, &share) in thrusters.zip(&flight.thrust) {
            m.thrust = share;
        }
    }
    /// The plates and the pieces of a construction, by the names the host knows them by.
    fn owners(&self, handle: u32) -> HashSet<u32> {
        self.damage.plates.iter().filter(|p| p.actor == handle).map(|p| p.owner)
            .chain(self.damage.modules.iter().filter(|m| m.actor == handle).map(|m| m.owner))
            .collect()
    }
    /// A construction leaves a field that goes on: its body and what stands on it, its parts (`owners`),
    /// what was kept of how it was driven and the rounds it had in the air.
    fn leave(&mut self, core: &mut NativeWorld, handle: u32, owners: &HashSet<u32>) {
        self.release_tow(handle, "removed");
        if let Some(index) = self.actors.iter().position(|a| a.handle == handle) {
            core.remove_body(self.actors.remove(index).body);
        }
        self.forget(owners);
        self.scripted.remove(&handle);
        self.projectiles.projectiles.retain(|p| p.actor != Some(handle));
    }
    /// Forgets plates and pieces, with all that is kept of each.
    fn forget(&mut self, owners: &HashSet<u32>) {
        // What is told of the pieces goes by their order: of each that stays, what was told stays with it.
        let mut exports = std::mem::take(&mut self.module_exports).into_iter().zip(&self.damage.modules)
            .filter(|(_, module)| !owners.contains(&module.owner)).map(|(export, _)| export).collect::<Vec<_>>();
        self.damage.withdraw(owners);
        for &owner in owners {
            self.geometry.remove(owner);
        }
        self.bindings.retain(|b| !owners.contains(&b.owner));
        self.gear_bindings.retain(|g| !owners.contains(&g.owner));
        self.gears.retain(|g| !owners.contains(&g.owner));
        self.servos.retain(|s| !owners.contains(&s.owner));
        for (export, module) in exports.iter_mut().zip(&self.damage.modules) {
            export.place(module.owner, &self.servos, &self.gears, &self.gear_bindings);
        }
        self.module_exports = exports;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_geometry::atan2;

    fn scene() -> Value {
        let plate = |owner, x, y, length, angle| {
            let mut value=crate::game_damage::fixtures::plate(owner,1,&json!({"definition":{
                "id":format!("plate-{owner}"),"x":x,"y":y,"length":length,"angle":angle,"thicknessMm":80,"material":"steel"}})).to_value();
            value["actor"]=json!(1);value
        };
        let mut modules = vec![
            json!({"owner":20,"actor":1,"id":"command","kind":"command","x":0,"y":1.2,"width":0.3,"height":0.2,"physicalMass":25}),
            // As long and tall as gives it the room, and so the power, of one 0.6 m long and 0.4 m tall that grew across the
            // body as well, 4/7 of the depth of its kind (`installed_depth`): the ground holds all it pulls.
            json!({"owner":21,"actor":1,"id":"engine","kind":"engine","x":0.8,"y":1.1,"width":0.6*(4.0f64/7.0).sqrt(),
                "height":0.4*(4.0f64/7.0).sqrt(),"physicalMass":280}),
            json!({"owner":22,"actor":1,"id":"fuel","kind":"fuel","x":-0.8,"y":1.1,"width":0.3,"height":0.4,"fuelLitres":20}),
            json!({"owner":23,"actor":1,"id":"camera","kind":"sensor","sensorMode":"visual","x":0,"y":1.7,"width":0.2,"height":0.15,"physicalMass":8}),
        ];
        for (i, x) in [-1.2, 1.2].into_iter().enumerate() {
            let component = 30 + i as u32;
            modules.push(json!({"owner":component,"actor":1,"id":format!("wheel-{i}"),"kind":"wheel","x":x,"y":0.4,
                "width":0.8,"height":0.8,"physicalMass":100}));
        }
        json!({"terrain":"flat","seed":6173,"visualEvents":false,"actors":[
            {"id":"local","handle":1,"vehicle":{"x":0,"y":0.9,"enabled":true},"defeated":false,
                "contactVolumes":[[{"x":-1.7,"y":0.8},{"x":1.7,"y":0.8},{"x":1.7,"y":1.6},{"x":-1.7,"y":1.6}]]},
            {"id":"opponent","handle":2,"x":35}],
            "plates":[plate(10,0.0,0.8,3.4,0.0),plate(11,0.0,1.6,3.4,0.0),
                plate(12,-1.7,1.2,0.8,std::f64::consts::FRAC_PI_2),plate(13,1.7,1.2,0.8,std::f64::consts::FRAC_PI_2)],
            "modules":modules,"bounds":{"minX":-50,"maxX":50,"minY":-5,"maxY":30}})
    }
    fn world() -> NativeWorld {
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene().to_string()).unwrap();
        core
    }
    fn advance(core: &mut NativeWorld, frames: u32) {
        let mut game = core.game.take().unwrap();
        for _ in 0..frames {
            game.step(core, 1.0 / 60.0).unwrap();
        }
        core.game = Some(game);
    }
    fn command(core: &mut NativeWorld, request: Value) -> Value {
        serde_json::from_str::<Value>(&core.game_command(&request.to_string()).unwrap()).unwrap()["result"].clone()
    }
    fn defeat(core: &mut NativeWorld) {
        command(
            core,
            json!({"op":"input","actorId":"local","input":{"type":"release","phase":"before","defeated":true}}),
        );
    }
    #[test]
    fn installed_gear_uses_global_budget_without_extra_body_iterations() {
        let core = world();
        let p = &core.world.integration_parameters;
        assert_eq!(p.num_solver_iterations, 8);
        assert_eq!(p.num_internal_pgs_iterations, 4);
        assert_eq!(p.max_ccd_substeps, 4);
        assert_eq!(p.max_corrective_velocity(), 0.5);
        assert!(
            core.world
                .bodies
                .iter()
                .all(|(_, body)| body.additional_solver_iterations() == 0)
        );
        let game = core.game.as_ref().unwrap();
        assert_eq!(game.gear_bindings.len(), 2);
        assert!(game.gear_bindings.iter().all(|gear| gear.travel > 0.0));
        assert!(
            core.world.impulse_joints.is_empty(),
            "logical running gear has no solver constraints"
        );
        assert_eq!(core.bodies.len(), game.actors.len());
    }
    #[test]
    fn a_gear_that_slips_turns_by_more_than_the_ground_that_passed_under_it() {
        // What the vehicle and one of its wheels say: how far it went, how far its gear slipped, and the angle of the wheel.
        let told = |core: &NativeWorld| {
            let game = core.game.as_ref().unwrap();
            let d = game.actors[0].drive.as_ref().unwrap();
            (d.travel, d.slipped, game.gear_bindings[0].angle, game.gear_bindings[0].angular_speed)
        };
        let radius = 0.4;
        // On concrete the ground holds all this vehicle pulls: its wheels turn as it goes, and no more.
        let mut core = world();
        advance(&mut core, 60);
        let (from, _, parked, _) = told(&core);
        command(&mut core, json!({"op":"control","actorId":"local","throttle":1}));
        advance(&mut core, 120);
        let (travel, slipped, angle, _) = told(&core);
        assert!(travel - from > 1.0 && slipped == 0.0, "{travel} {slipped}");
        assert!((angle - parked + (travel - from) / radius).abs() < 1e-9);
        // On sand, with nine tonnes more aboard, it is too heavy to set off: it stands, and its wheels churn the way it is driven.
        let mut sand = scene();
        sand["terrain"] = json!({"id":"sand","material":"sand","points":[{"x":-1600,"y":0},{"x":1600,"y":0}],
            "sectors":[{"start":-1600,"end":1600,"surface":"sand"}]});
        sand["modules"][0]["physicalMass"] = json!(9025);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&sand.to_string()).unwrap();
        advance(&mut core, 60);
        for throttle in [1.0, -1.0] {
            let (from, before, parked, _) = told(&core);
            command(&mut core, json!({"op":"control","actorId":"local","throttle":throttle}));
            advance(&mut core, 120);
            let (travel, slipped, angle, speed) = told(&core);
            let drive = core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap();
            let slip = drive.slip;
            assert_eq!(drive.stuck, Some(crate::game_motion::Stuck::Ground));
            assert!((travel - from).abs() < 0.02, "it stands: {}", travel - from);
            assert!(((slipped - before) * throttle - 3.0).abs() < 0.1, "two seconds at the speed the drivetrain slips: {slipped}");
            assert!((angle - parked + (travel - from + slipped - before) / radius).abs() < 1e-9);
            assert!((speed + slip / radius).abs() < 0.05 && speed * throttle < -3.5, "{speed}");
            let frame = core.game.as_mut().unwrap().frame();
            assert_eq!(frame["actors"][0]["vehicle"]["stuck"], "ground");
            assert_eq!(frame["actors"][0]["vehicle"]["slip"], slip);
        }
        // The key let go, the wheels stand with the vehicle.
        command(&mut core, json!({"op":"control","actorId":"local","throttle":0}));
        advance(&mut core, 2);
        let (_, _, angle, speed) = told(&core);
        advance(&mut core, 30);
        assert_eq!((told(&core).2, speed.abs() < 0.05), (angle, true));
        assert_eq!(core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap().stuck, None);
    }
    #[test]
    fn low_crest_fits_between_wheels_but_a_high_crest_supports_the_real_floor() {
        for (height, supported_wheels) in [(0.3, 2), (1.0, 0)] {
            let mut s = scene();
            s["terrain"] = json!({"id":"rough","points":[{"x":-500,"y":0},{"x":-0.7,"y":0},
                {"x":-0.4,"y":height},{"x":0.4,"y":height},{"x":0.7,"y":0},{"x":500,"y":0}]});
            let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
            core.load_game(&s.to_string()).unwrap();
            command(&mut core, json!({"op":"setVehicleState","state":{"y":2.1}}));
            advance(&mut core, 360);
            let game = core.game.as_ref().unwrap();
            let d = game.actors[0].drive.as_ref().unwrap();
            assert_eq!(game.gears.iter().filter(|g| g.ground_contact.is_some()).count(), supported_wheels,
                "height={height}, y={}, x={}", d.pose.y, d.pose.x);
            if supported_wheels > 0 {
                assert!((d.pose.y - 0.9).abs() < 0.025, "a low crest cannot support an invisible floor: {}", d.pose.y);
                assert!(d.traction > 0.9);
            } else {
                assert!(d.pose.y > 1.1, "the real hull must not penetrate the tall crest");
                assert_eq!(d.traction, 0.0);
            }
            assert_eq!(game.recoveries, 0);
            assert_eq!(core.world.bodies[core.bodies[&game.actors[0].body]].colliders().len(), 1);
            assert!(core.world.impulse_joints.is_empty());
        }
    }
    #[test]
    fn a_closed_concave_hull_and_separate_parts_keep_their_real_empty_spaces() {
        let pose = Pose { x: 10.0, y: 4.0, angle: 0.3 };
        let room = [(-2.0,0.0),(-1.0,0.0),(-0.6,1.0),(0.6,1.0),(1.0,0.0),(2.0,0.0),(2.0,2.0),(-2.0,2.0)]
            .map(|(x,y)| pose.world_point(Point::new(x,y)));
        let polygons = contact_contours(&[], &[], 1, pose, &[json!(room)]).unwrap();
        let covers = |point| polygons.iter().any(|polygon| contact_shape(polygon).unwrap().contains_local_point(vector(point)));
        assert!(!covers(Point::new(0.0,0.5)), "the space under the arch stays empty");
        assert!(covers(Point::new(0.0,1.5)), "the closed room remains a solid terrain volume");
        assert!(covers(Point::new(1.5,0.5)), "the low side of the room stays solid");
        // Two unconnected pieces belong to one actor without filling the space between them.
        let mut told = scene();
        told["actors"][0]["contactVolumes"] = json!([]);
        told["modules"] = json!([]);
        told["plates"].as_array_mut().unwrap().retain(|p| matches!(p["owner"].as_u64(),Some(12|13)));
        let mut core = NativeWorld::new(&[],0.0,0.0).unwrap();
        core.load_game(&told.to_string()).unwrap();
        let contours = core.game.as_ref().unwrap().actors[0].contact_contours.as_ref().unwrap();
        assert_eq!(contours.len(), 2);
        assert!(!contours.iter().any(|p| contact_shape(p).unwrap().contains_local_point(vector(Point::new(0.0,0.3)))));
        assert_eq!(core.world.bodies[core.bodies[&core.game.as_ref().unwrap().actors[0].body]].colliders().len(),1);
    }
    #[test]
    fn the_beam_web_is_solid_between_its_flanges_but_not_under_its_arch_or_across_a_gap() {
        // The filled profile is supplied by the chassis compiler; thin ballistic flanges alone omit the web.
        let beam=[(-3.0,0.8),(-1.0,0.8),(-0.5,1.2),(0.5,1.2),(1.0,0.8),(3.0,0.8),
            (3.0,0.6),(1.0,0.6),(0.5,1.0),(-0.5,1.0),(-1.0,0.6),(-3.0,0.6)]
            .map(|(x,y)|Point::new(x,y));
        let separate=[(4.0,0.8),(5.0,0.8),(5.0,0.6),(4.0,0.6)].map(|(x,y)|Point::new(x,y));
        let polygons=contact_contours(&[],&[],1,Pose::default(),&[json!(beam),json!(separate)]).unwrap();
        let covers=|point|polygons.iter().any(|polygon|contact_shape(polygon).unwrap().contains_local_point(vector(point)));
        assert!(covers(Point::new(-2.0,0.7)),"the actual web between the lower and upper flanges contacts terrain");
        assert!(covers(Point::new(0.0,1.1)),"the raised part keeps its own full depth");
        assert!(!covers(Point::new(0.0,0.7)),"a beam profile does not fill the arch beneath it");
        assert!(!covers(Point::new(3.5,0.7)),"separate beam sections preserve their gap");
    }
    #[test]
    fn a_crest_passes_under_the_arch_until_it_reaches_the_actual_raised_floor() {
        let ring = [(-1.7,0.8),(-1.1,0.8),(-0.6,1.4),(0.6,1.4),(1.1,0.8),(1.7,0.8),(1.7,2.1),(-1.7,2.1)];
        for (height,supported) in [(1.0,2),(1.8,0)] {
            let mut told = scene();
            told["actors"][0]["contactVolumes"] = json!([ring.map(|(x,y)|Point::new(x,y))]);
            told["plates"] = json!(ring.iter().enumerate().map(|(i,&(x,y))| {
                let (bx,by) = ring[(i+1)%ring.len()];
                let mut p = crate::game_damage::fixtures::plate(100+i as u32,1,&json!({"definition":{
                    "id":format!("arch-{i}"),"x":(x+bx)/2.0,"y":(y+by)/2.0,"length":hypot(bx-x,by-y),
                    "angle":atan2(by-y,bx-x),"thicknessMm":80,"material":"steel"}})).to_value();
                p["actor"]=json!(1);p
            }).collect::<Vec<_>>());
            told["modules"].as_array_mut().unwrap().retain(|m|m["kind"]=="wheel");
            told["terrain"] = json!({"id":"rough","points":[{"x":-50,"y":0},{"x":-0.6,"y":0},
                {"x":-0.3,"y":height},{"x":0.3,"y":height},{"x":0.6,"y":0},{"x":50,"y":0}]});
            let mut core = NativeWorld::new(&[],0.0,-9.81).unwrap();
            core.load_game(&told.to_string()).unwrap();
            command(&mut core,json!({"op":"setVehicleState","state":{"y":2.1}}));
            advance(&mut core,360);
            let game = core.game.as_ref().unwrap();
            let d = game.actors[0].drive.as_ref().unwrap();
            assert_eq!(game.gears.iter().filter(|g|g.ground_contact.is_some()).count(), supported,
                "height={height}, body={}, traction={}",d.pose.y,d.traction);
            if supported>0 {
                assert!((d.pose.y-0.9).abs()<0.025,"a visible arch must clear the crest: {}",d.pose.y);
            } else { assert!(d.pose.y>1.2,"the raised floor must still meet the taller crest"); }
            assert_eq!(game.recoveries,0);
            assert_eq!(core.bodies.len(),game.actors.len());
            assert_eq!(core.world.bodies[core.bodies[&game.actors[0].body]].colliders().len(),1);
        }
    }
    #[test]
    fn rolling_gear_has_no_coulomb_brake_on_the_first_landing_frame() {
        for (speed, angle) in [(12.0, -0.15), (-12.0, 0.15), (25.0, 0.0), (-25.0, 0.0)] {
            let mut core = world();
            command(&mut core, json!({"op":"setVehicleState","state":{"y":2.4,"vx":speed,"angle":angle,"omega":0}}));
            let mut first_contact = None;
            let mut max_angle: f64 = 0.0;
            for _ in 0..120 {
                advance(&mut core, 1);
                let game = core.game.as_ref().unwrap();
                let drive = game.actors[0].drive.as_ref().unwrap();
                max_angle = max_angle.max(drive.pose.angle.abs());
                for pair in core.world.narrow_phase.contact_pairs() {
                    for manifold in pair.manifolds() {
                        if manifold.points.iter().any(|p| p.dist <= 0.02) {
                            assert_eq!(manifold.data.friction, 0.0, "wheel terrain contact, including initial touchdown, must roll freely");
                        }
                    }
                }
                if drive.grounded && first_contact.is_none() {
                    first_contact = Some(drive.velocity.x);
                }
            }
            assert!(first_contact.is_some());
            assert!(first_contact.unwrap() * speed.signum() > speed.abs() * 0.98);
            assert!(max_angle < 0.35, "a routine wheel landing must not flip the carrier: {max_angle}");
            assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
        }
    }
    #[test]
    fn construction_admits_one_body_per_actor_with_complete_mass_and_ballistic_shapes() {
        let mut core = world();
        let game = core.game.as_ref().unwrap();
        let drive = game.actors[0].drive.as_ref().unwrap();
        assert!(
            !game.actors[0].defeated,
            "false is a live participant, not a defeat reason"
        );
        assert_eq!(drive.gear_count, 2);
        assert_eq!(core.bodies.len(), 2);
        assert!(core.world.impulse_joints.is_empty());
        let sum = core
            .world
            .bodies
            .iter()
            .map(|(_, body)| body.mass())
            .sum::<f64>();
        assert!(
            (sum - drive.mass).abs() < 0.002,
            "all construction mass belongs to one carrier exactly once"
        );
        assert!(drive.mass > 5000.0 && drive.mass < 7000.0);
        let packet = command(
            &mut core,
            json!({"op":"raycastLayers","start":{"x":-5,"y":1.2},"end":{"x":5,"y":1.2}}),
        );
        assert!(packet.as_array().unwrap().len() >= 3);
        assert_eq!(packet[0]["owner"], 12);
        let before = core.bodies.len();
        core.load_game(&scene().to_string()).unwrap();
        assert_eq!(
            core.bodies.len(),
            before,
            "cold admission replaces, never accumulates a second installation"
        );
    }
    #[test]
    fn cold_readmission_preserves_carrier_velocity_and_has_no_wheel_kinetic_body() {
        let mut scene = scene();
        scene["actors"][0]["vehicle"]["vx"] = json!(4.0);
        scene["actors"][0]["vehicle"]["omega"] = json!(0.5);
        let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
        for _ in 0..20 {
            core.load_game(&scene.to_string()).unwrap();
            let game = core.game.as_ref().unwrap();
            let d = game.actors[0].drive.as_ref().unwrap();
            assert_eq!(d.velocity.x, 4.0);
            assert_eq!(d.omega, 0.5);
            assert_eq!(core.bodies.len(), game.actors.len());
            assert!(core.world.impulse_joints.is_empty());
        }
    }
    #[test]
    fn defeated_assembly_settles_sleeps_and_accepts_a_new_physical_impact() {
        let mut core = world();
        defeat(&mut core);
        advance(&mut core, 900);
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
        let sleeping = core
            .world
            .bodies
            .iter()
            .filter(|(_, b)| b.is_dynamic() && b.is_sleeping())
            .count();
        assert_eq!(
            sleeping,
            core.world
                .bodies
                .iter()
                .filter(|(_, b)| b.is_dynamic())
                .count(),
            "a settled defeat must not be kept awake by brakes or suspension bookkeeping"
        );
        let before = core.game.as_ref().unwrap().actors[0]
            .drive
            .as_ref()
            .unwrap()
            .pose;
        command(
            &mut core,
            json!({"op":"impulse","owner":10,"point":{"x":0,"y":1},"impulse":{"x":8000,"y":1500}}),
        );
        assert!(
            core.world
                .bodies
                .iter()
                .any(|(_, b)| b.is_dynamic() && !b.is_sleeping())
        );
        advance(&mut core, 30);
        let game = core.game.as_ref().unwrap();
        assert!(game.actors[0].drive.as_ref().unwrap().pose.x > before.x + 0.1);
        assert!(game.actors[0].defeated);
        assert_eq!(
            command(
                &mut core,
                json!({"op":"control","actorId":"local","throttle":1})
            ),
            false
        );
    }
    #[test]
    fn airborne_defeat_keeps_gravity_and_sensor_memory_only_ages() {
        let mut core = world();
        core.game.as_mut().unwrap().sense_terrain("local");
        command(
            &mut core,
            json!({"op":"setVehicleState","actorId":"local","state":{"y":8}}),
        );
        defeat(&mut core);
        advance(&mut core, 60);
        let d = core.game.as_ref().unwrap().actors[0]
            .drive
            .as_ref()
            .unwrap();
        assert!(
            d.pose.y < 5.0 && d.velocity.y < -3.0,
            "defeat cannot freeze a wreck in midair"
        );
        let terrain = core.game.as_mut().unwrap().sense_terrain("local");
        assert!(terrain.samples.iter().all(|sample| sample.known && !sample.fresh && sample.age > 0.9));
        advance(&mut core, 840);
        assert!(
            core.game.as_ref().unwrap().actors[0]
                .drive
                .as_ref()
                .unwrap()
                .pose
                .y
                < 2.0
        );
        assert!(
            core.world
                .bodies
                .iter()
                .filter(|(_, b)| b.is_dynamic())
                .all(|(_, b)| b.is_sleeping())
        );
    }
    #[test]
    fn damage_cannot_change_mass_com_inertia_or_contact_shape() {
        let mut core = world();
        let actor = core.game.as_ref().unwrap().actors[0].body;
        let handle = core.bodies[&actor];
        let before = core.world.bodies[handle].mass_properties().local_mprops;
        let collider = core.world.bodies[handle].colliders()[0];
        let shape = core.world.colliders[collider].shared_shape().clone();
        // The engine and a wheel are each destroyed by a charge set off on them.
        let on = |owner| {
            let pose = core.game.as_ref().unwrap().damage.module(owner).unwrap().pose;
            json!({"op":"explode","x":pose.x,"y":pose.y,"power":5000,"radius":1})
        };
        for request in [
            json!({"op":"cut","owner":10,"start":{"x":-2,"y":0.8},"end":{"x":2,"y":0.8},"radius":0.05}),
            on(21),
            on(30),
            json!({"op":"explode","x":0,"y":1.1,"power":5000,"radius":1}),
        ] {
            command(&mut core, request);
        }
        let after = core.world.bodies[handle].mass_properties().local_mprops;
        assert_eq!(before, after);
        assert!(std::sync::Arc::ptr_eq(&shape.0, &core.world.colliders[collider].shared_shape().0),
            "damage must preserve the admitted compound and every primitive without rebuilding");
        assert_eq!(core.world.bodies[handle].colliders().len(), 1);
        assert_eq!(core.bodies.len(), core.game.as_ref().unwrap().actors.len());
        assert!(core.world.impulse_joints.is_empty());
        let game = core.game.as_ref().unwrap();
        let d = game.actors[0].drive.as_ref().unwrap();
        assert_eq!(d.mass, d.carrier_mass);
        assert_eq!(d.local_center, d.carrier_center);
        assert_eq!(d.inertia, d.carrier_inertia);
        assert_eq!(game.damage.module(21).unwrap().health, 0.0);
        assert_eq!(game.damage.module(30).unwrap().health, 0.0);
    }
    /// The scene with a hopper, a cistern and a magazine in its hull, every reservoir admitted with
    /// the mass of what it holds.
    fn hauler() -> NativeWorld {
        let mut s = scene();
        s["catalogue"] = crate::game_damage::fixtures::catalogue().clone();
        s["modules"][2]["fuelLitres"] = json!(60);
        s["modules"].as_array_mut().unwrap().extend([
            json!({"owner":24,"actor":1,"id":"hopper","kind":"hopper","x":0.4,"y":1.2,"width":0.8,"height":0.45}),
            json!({"owner":25,"actor":1,"id":"cistern","kind":"cistern","x":-0.35,"y":1.2,"width":0.7,"height":0.45}),
            json!({"owner":26,"actor":1,"id":"ammo","kind":"ammo","ammoPreset":"rh120","x":1.2,"y":1.1,"width":0.39,"height":0.325,
                "rounds":3,"capacityRounds":3,"roundMass":27}),
        ]);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&s.to_string()).unwrap();
        for module in s["modules"].as_array_mut().unwrap() {
            let owner = module["owner"].as_u64().unwrap() as u32;
            module["physicalMass"] = json!(core.game.as_ref().unwrap().damage.module(owner).unwrap().live_mass());
        }
        core.load_game(&s.to_string()).unwrap();
        core
    }
    #[test]
    fn what_a_construction_carries_is_weighed_into_its_body_a_step_of_load_at_a_time() {
        let mut core = hauler();
        let body = core.bodies[&core.game.as_ref().unwrap().actors[0].body];
        let drive = |core: &NativeWorld| core.game.as_ref().unwrap().actors[0].drive.clone().unwrap();
        let weighed = |core: &NativeWorld, owner: u32| core.game.as_ref().unwrap().damage.module(owner).unwrap().physical_mass;
        let stow = |core: &mut NativeWorld, owner: u32, cargo: Value| {
            command(core, json!({"op":"setPartState","owner":owner,"state":{"cargo":cargo}}));
        };
        let empty = drive(&core);
        assert!((core.world.bodies[body].mass() - empty.mass).abs() < 1e-9);
        // A hopper that fills a little at a time: the body is weighed when the load has grown by a step.
        let hopper = weighed(&core, 24);
        for kilograms in [4.0, 8.0, 12.0, 16.0] {
            stow(&mut core, 24, json!({"ferro":kilograms}));
            advance(&mut core, 6);
            assert_eq!(drive(&core).mass, empty.mass, "{kilograms} kg are not yet a step");
            assert_eq!(weighed(&core, 24), hopper);
        }
        stow(&mut core, 24, json!({"ferro":20}));
        advance(&mut core, 5);
        assert_eq!(drive(&core).mass, empty.mass, "the load is looked at ten times a second");
        advance(&mut core, 1);
        let d = drive(&core);
        assert!((d.mass - empty.mass - 20.0).abs() < 1e-9);
        assert_eq!(weighed(&core, 24), hopper + 20.0);
        // Loaded, the whole of it is in the body: mass, centre and inertia, and what the drive reads of them.
        stow(&mut core, 24, json!({"ferro":300,"ligas":50}));
        stow(&mut core, 25, json!({"petroleo":100}));
        advance(&mut core, 6);
        let d = drive(&core);
        assert!((d.mass - empty.mass - 350.0 - 85.0).abs() < 1e-9);
        assert!((core.world.bodies[body].mass() - d.mass).abs() < 1e-9);
        assert_eq!((d.carrier_mass, d.carrier_inertia, d.carrier_center), (d.mass, d.inertia, d.local_center));
        assert!(d.local_center.x > empty.local_center.x + 0.01, "the hopper stands behind the middle, and the centre goes to it");
        assert!(d.inertia > empty.inertia);
        let local = core.world.bodies[body].mass_properties().local_mprops;
        assert!((local.local_com.x - d.local_center.x).abs() < 1e-9 && (local.local_com.y - d.local_center.y).abs() < 1e-9);
        let powertrain = core.game.as_ref().unwrap().actors[0].powertrain;
        assert!((powertrain.power_per_tonne - powertrain.power_kw / (d.mass / 1000.0)).abs() < 1e-9);
        // A piece is given only what it takes, and a refusal changes nothing.
        for (owner, cargo) in [(24, json!({"petroleo":1})), (25, json!({"ferro":1})), (21, json!({"ferro":1}))] {
            assert!(core.game_command(&json!({"op":"setPartState","owner":owner,"state":{"cargo":cargo}}).to_string()).is_err());
        }
        // The frame tells what each carries, and the mass the body was last weighed with.
        let told = core.game.as_mut().unwrap().frame();
        let module = |owner: u64| told["modules"].as_array().unwrap().iter().find(|m| m["owner"] == owner).unwrap().clone();
        assert_eq!(module(24)["cargo"], json!({"ferro":300.0,"ligas":50.0,"silica":0.0}));
        assert_eq!(module(25)["cargo"], json!({"petroleo":100.0}));
        assert_eq!(module(24)["physicalMass"].as_f64(), Some(hopper + 350.0));
        assert_eq!(told["actors"][0]["vehicle"]["mass"].as_f64(), Some(d.mass));
        // Fuel burnt and rounds fired come off it as well.
        command(&mut core, json!({"op":"setPartState","owner":22,"state":{"fuelLitres":0}}));
        advance(&mut core, 6);
        assert!((drive(&core).mass - d.mass + 60.0 * 0.835).abs() < 1e-9);
        let fuelled = drive(&core).mass;
        assert!(core.game.as_mut().unwrap().damage.consume_round(1, "rh120"));
        advance(&mut core, 6);
        assert!((drive(&core).mass - fuelled + 27.0).abs() < 1e-9);
        // Put down, the load leaves the body as it was but for what was spent.
        stow(&mut core, 24, json!({}));
        stow(&mut core, 25, json!({}));
        advance(&mut core, 6);
        let d = drive(&core);
        assert!((d.mass - empty.mass + 60.0 * 0.835 + 27.0).abs() < 1e-9);
        assert_eq!(core.world.bodies[body].colliders().len(), 1);
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    }
    #[test]
    fn admitted_contact_and_mass_survive_cold_readmission_after_ballistic_geometry_changes() {
        let mut core = world();
        command(
            &mut core,
            json!({"op":"cut","owner":10,"start":{"x":-2,"y":0.8},"end":{"x":2,"y":0.8},"radius":0.05}),
        );
        let game = core.game.as_mut().unwrap();
        let contour = game.actors[0].contact_contours.clone();
        let d = game.actors[0].drive.as_ref().unwrap();
        let mass = d.mass;
        let center = d.carrier_center;
        let inertia = d.inertia;
        let frame = game.frame();
        let mut restored = scene();
        for (source, target) in frame["actors"]
            .as_array()
            .unwrap()
            .iter()
            .zip(restored["actors"].as_array_mut().unwrap())
        {
            target["vehicle"] = source["vehicle"].clone();
            target["contactContours"] = source["contactContours"].clone();
        }
        for (source, target) in frame["plates"]
            .as_array()
            .unwrap()
            .iter()
            .zip(restored["plates"].as_array_mut().unwrap())
        {
            let owner = target["owner"].clone();
            *target = source["damage"].clone();
            target["owner"] = owner;
            target["actor"] = json!(1);
        }
        let mut changed=restored.clone();
        changed["plates"][0]["vertices"] = json!([{"x":-0.01,"y":-0.01},{"x":0.01,"y":-0.01},{"x":0.01,"y":0.01},{"x":-0.01,"y":0.01}]);
        assert!(core.load_game(&changed.to_string()).is_err(),"base contour cannot diverge from its material lattice");
        core.load_game(&restored.to_string()).unwrap();
        let game = core.game.as_ref().unwrap();
        let d = game.actors[0].drive.as_ref().unwrap();
        assert_eq!(game.actors[0].contact_contours, contour);
        assert_eq!(d.mass, mass);
        assert_eq!(d.carrier_center, center);
        assert_eq!(d.inertia, inertia);
        assert_eq!(core.bodies.len(), game.actors.len());
        assert_eq!(
            core.world.bodies[core.bodies[&game.actors[0].body]]
                .colliders()
                .len(),
            1
        );
    }
    #[test]
    fn an_admitted_contour_is_kept_as_it_was_told_from_whichever_corner_it_starts() {
        // A field read back writes the contour it read. Hulled again, one told from another corner came back from the
        // corner the hull starts at, and a field resumed twice wrote another contour than once. This one is a scout's,
        // the corners of the three plates of its glacis all but in line, as a field resumed once wrote it.
        let mut core = world();
        let game = core.game.as_mut().unwrap();
        let contour = [(1.399999799999993, 1.0499999999999703), (-1.0999999999999999, 1.6090000000000197),
            (-3.0499999999999967, 1.6090000000000904), (-3.054192218081512, 1.607724941752964),
            (-3.578479962733536, 0.8745244757769755), (-3.6759799627335368, 0.7245244757768653),
            (-3.704999999999993, 0.6049999999999557), (-3.7049999999999916, -0.2950000000000098),
            (-3.7000000000000006, -0.5999999999998956), (3.70000000000001, -0.5999999999998311),
            (3.7000000000000006, -0.29999999999995636)].map(|(x, y)| Point::new(x, y)).to_vec();
        let mut told = scene();
        told["actors"][0]["vehicle"] = game.frame()["actors"][0]["vehicle"].clone();
        told["actors"][0]["contactContours"] = json!([contour]);
        let mut again = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        again.load_game(&told.to_string()).unwrap();
        assert_eq!(again.game.as_ref().unwrap().actors[0].contact_contours, Some(vec![contour]));
    }
    #[test]
    fn an_admitted_empty_body_contact_is_kept_and_invalid_contours_are_refused() {
        let mut told = scene();
        told["actors"][0]["contactContours"] = json!([]);
        let mut core = NativeWorld::new(&[],0.0,-9.81).unwrap();
        core.load_game(&told.to_string()).unwrap();
        assert_eq!(core.game.as_ref().unwrap().actors[0].contact_contours,Some(vec![]));
        let body = core.bodies[&core.game.as_ref().unwrap().actors[0].body];
        let shape = core.world.colliders[core.world.bodies[body].colliders()[0]].shape().as_compound().unwrap();
        assert_eq!(shape.shapes().len(),4,"the two wheels keep their stops and rims, with no regenerated body");
        for contours in [
            json!([[{"x":0,"y":0},{"x":1,"y":0}]]),
            json!([[{"x":0,"y":0},{"x":1,"y":0},{"x":2,"y":0}]]),
            json!([[{"x":0,"y":0},{"x":1,"y":1},{"x":0,"y":1},{"x":1,"y":0}]]),
            json!([[{"x":0,"y":0},{"x":0,"y":1},{"x":1,"y":1},{"x":1,"y":0}]]),
        ] {
            told["actors"][0]["contactContours"]=contours;
            assert!(core.load_game(&told.to_string()).is_err());
        }
    }
    #[test]
    fn powered_contact_drives_both_directions_and_brakes_without_reversing() {
        for throttle in [-1.0, 1.0] {
            let mut core = world();
            advance(&mut core, 120);
            command(
                &mut core,
                json!({"op":"control","actorId":"local","throttle":throttle}),
            );
            advance(&mut core, 240);
            let d = core.game.as_ref().unwrap().actors[0]
                .drive
                .as_ref()
                .unwrap();
            assert!(d.grounded && d.traction > 0.0);
            assert!(
                d.velocity.x * throttle > 0.25,
                "traction must move in the chosen direction"
            );
            let speed = d.velocity.x.abs();
            command(
                &mut core,
                json!({"op":"control","actorId":"local","throttle":0,"brake":1.0}),
            );
            advance(&mut core, 300);
            let d = core.game.as_ref().unwrap().actors[0]
                .drive
                .as_ref()
                .unwrap();
            assert!(d.velocity.x.abs() < speed * 0.25);
            assert!(
                d.velocity.x * throttle >= -0.01,
                "braking must not produce reverse propulsion"
            );
            assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
        }
    }
    #[test]
    fn fuel_is_burned_only_under_command_and_as_the_work_the_engine_delivers() {
        let fuel = |core: &NativeWorld| core.game.as_ref().unwrap().damage.module(22).unwrap().fuel_litres;
        let drive = |core: &NativeWorld| core.game.as_ref().unwrap().actors[0].drive.clone().unwrap();
        let mut core = world();
        // Parked, however long: nothing.
        advance(&mut core, 600);
        assert_eq!(fuel(&core), 20.0);
        assert_eq!(drive(&core).fuel_rate, 0.0);
        // Under the key every step takes what the reading says, and the reading follows the engine.
        command(&mut core, json!({"op":"control","actorId":"local","throttle":1}));
        let power = core.game.as_ref().unwrap().actors[0].powertrain.power_kw;
        let full = power * 0.25 / 0.835;
        let (mut burned, mut launch) = (0.0, 0.0);
        for step in 0..600 {
            advance(&mut core, 1);
            let d = drive(&core);
            assert!(d.traction > 0.0 && d.engine_kw <= power * (1.0 + 1e-12));
            assert_eq!(d.fuel_rate, crate::game_motion::fuel_flow(d.engine_kw, power));
            burned += d.fuel_rate / 3600.0 / 60.0;
            if step == 0 {
                launch = d.fuel_rate;
            }
        }
        assert!((20.0 - fuel(&core) - burned).abs() < 1e-9);
        assert!(launch > 0.04 * full && launch < 0.9 * full, "from rest the pull is limited, not the power: {launch}");
        let accelerating = drive(&core);
        assert!(accelerating.velocity.x > 5.0);
        assert!((accelerating.fuel_rate - 1.04 * full).abs() < 1e-9, "still gaining speed, all the engine has: {}", accelerating.fuel_rate);
        // Above its flat-road estimate the wheels still receive power: resistance, not RPM, slows it.
        let estimate = core.game.as_ref().unwrap().actors[0].powertrain.max_speed;
        assert_eq!(core.game.as_ref().unwrap().actors[0].powertrain.geared_speed, None);
        // This fixture faces -X; driving the other way retains the existing reverse-gear limit.
        command(&mut core, json!({"op":"control","actorId":"local","throttle":-1}));
        command(&mut core, json!({"op":"setVehicleState","actorId":"local","state":{"vx":-(estimate + 6.0)}}));
        advance(&mut core, 1);
        assert!(drive(&core).velocity.x < -estimate);
        assert!((drive(&core).fuel_rate - 1.04 * full).abs() < 1e-9);
        // The key released, the brake held, the wheels off the ground: nothing.
        for (request, airborne) in [
            (json!({"op":"control","actorId":"local","throttle":0}), false),
            (json!({"op":"control","actorId":"local","throttle":1,"brake":1.0}), false),
            (json!({"op":"control","actorId":"local","throttle":1}), true),
        ] {
            command(&mut core, request);
            if airborne {
                command(&mut core, json!({"op":"setVehicleState","actorId":"local","state":{"y":8,"vy":0}}));
            }
            advance(&mut core, 1);
            let before = fuel(&core);
            advance(&mut core, 20);
            assert_eq!(fuel(&core), before, "airborne={airborne}");
            assert_eq!(drive(&core).fuel_rate, 0.0);
            assert_eq!(drive(&core).traction > 0.0, !airborne);
        }
    }
    #[test]
    fn airborne_and_overturned_vehicle_have_no_traction_or_forced_uprighting() {
        let mut core = world();
        command(
            &mut core,
            json!({"op":"setVehicleState","actorId":"local","state":{"y":8,"vx":0,"vy":0}}),
        );
        command(
            &mut core,
            json!({"op":"control","actorId":"local","throttle":1}),
        );
        advance(&mut core, 30);
        let d = core.game.as_ref().unwrap().actors[0]
            .drive
            .as_ref()
            .unwrap();
        assert!(!d.grounded);
        assert_eq!(d.traction, 0.0);
        assert!(d.velocity.x.abs() < 0.001);
        assert!(d.velocity.y < -4.0);
        command(
            &mut core,
            json!({"op":"setVehicleState","actorId":"local","state":{"y":4,"angle":std::f64::consts::PI,"vx":0,"vy":0,"omega":0}}),
        );
        advance(&mut core, 120);
        let d = core.game.as_ref().unwrap().actors[0]
            .drive
            .as_ref()
            .unwrap();
        assert!(
            cos(d.pose.angle) < -0.5,
            "the body must remain free to overturn"
        );
        assert_eq!(d.traction, 0.0);
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
        advance(&mut core, 780);
        let body = core.bodies[&core.game.as_ref().unwrap().actors[0].body];
        assert!(
            core.world.bodies[body].is_sleeping(),
            "an overturned hull must settle without forced uprighting"
        );
        let collider = core.world.bodies[body].colliders()[0];
        assert_eq!(core.world.colliders[collider].friction(), 0.6);
    }
    #[test]
    fn coarse_contact_contours_crosses_a_ramp_with_finite_energy_and_no_recovery() {
        let mut s = scene();
        // The small 36.7 kW fixture motor would crawl up this 20% grade.
        // A standard 180 kW engine supplies a wide uphill force margin.
        s["modules"][1]["width"] = json!(1.05);
        s["modules"][1]["height"] = json!(0.64);
        s["modules"][1]["physicalMass"] = json!(880.0);
        s["terrain"] = json!({"id":"mixed","points":[{"x":-500,"y":0},{"x":3,"y":0},{"x":10,"y":1.4},{"x":18,"y":1.4},{"x":25,"y":0},{"x":500,"y":0}]});
        s["bounds"] = json!({"minX":-500,"maxX":500,"minY":-5,"maxY":30});
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&s.to_string()).unwrap();
        let game = core.game.as_ref().unwrap();
        let drive = game.actors[0].drive.as_ref().unwrap();
        let drivetrain = game.actors[0].powertrain;
        assert!(
            drivetrain.max_drive_force
                > drive.mass * 9.81 * (0.2 + drivetrain.rolling_coefficient + 0.025),
            "the ramp fixture must have sufficient motor force for grade, rolling resistance and hull contact friction"
        );
        advance(&mut core, 120);
        command(
            &mut core,
            json!({"op":"control","actorId":"local","throttle":1}),
        );
        let mut max_y: f64 = 0.0;
        for index in 0..900 {
            let actor = &core.game.as_ref().unwrap().actors[0];
            let before = actor.drive.as_ref().unwrap().to_value(&actor.powertrain);
            core.energy_audit = Default::default();
            advance(&mut core, 1);
            let d = core.game.as_ref().unwrap().actors[0]
                .drive
                .as_ref()
                .unwrap();
            assert!(
                [
                    d.pose.x,
                    d.pose.y,
                    d.pose.angle,
                    d.velocity.x,
                    d.velocity.y,
                    d.omega
                ]
                .iter()
                .all(|n| n.is_finite())
            );
            assert!(
                hypot(d.velocity.x, d.velocity.y) < 50.0,
                "frame={index} before={before} after={} solver={}",
                d.to_value(&core.game.as_ref().unwrap().actors[0].powertrain),
                core.energy_audit.to_value()
            );
            max_y = max_y.max(d.pose.y);
        }
        let game = core.game.as_ref().unwrap();
        let d = game.actors[0].drive.as_ref().unwrap();
        assert!(d.pose.x > 10.0, "usable running gear must climb the ramp");
        assert!(max_y > 1.7, "the body must respond to the raised ground");
        assert_eq!(game.recoveries, 0);
    }
    #[test]
    fn defeat_does_not_suspend_local_combustion_or_make_fuel_explode() {
        let mut core = world();
        defeat(&mut core);
        advance(&mut core, 600);
        let explosions = core.game.as_ref().unwrap().damage.stats.explosions;
        core.game
            .as_mut()
            .unwrap()
            .damage
            .module_mut(22)
            .unwrap()
            .burning = true;
        advance(&mut core, 30);
        let game = core.game.as_ref().unwrap();
        let fuel = game.damage.module(22).unwrap();
        assert!(fuel.fire_age > 0.4 && fuel.burn_age > 0.0 && fuel.health < fuel.max_health);
        let (health, litres) = (fuel.health, fuel.fuel_litres);
        advance(&mut core, 300);
        let game = core.game.as_ref().unwrap();
        let fuel = game.damage.module(22).unwrap();
        assert!(fuel.health < health && fuel.fuel_litres < litres);
        assert!(fuel.burning);
        assert!(game.damage.modules.iter().any(|m| m.kind == ComponentKind::Engine && m.burn_age == 0.0),
            "a weak neighbouring fire does not immediately consume another part's material");
        assert_eq!(game.damage.stats.explosions, explosions);
        assert_eq!(game.recoveries, 0);
    }
    /// The scene with a wheel at each of these places along its hull, each with this travel where
    /// one is given, on ground that runs straight between these points.
    fn on_wheels(places: &[f64], travel: Option<f64>, ground: &[[f64; 2]]) -> NativeWorld {
        let mut s = scene();
        let modules = s["modules"].as_array_mut().unwrap();
        let wheel = modules[4].clone();
        modules.truncate(4);
        for (i, x) in places.iter().enumerate() {
            let mut wheel = wheel.clone();
            wheel["owner"] = json!(30 + i);
            wheel["id"] = json!(format!("wheel-{i}"));
            wheel["x"] = json!(x);
            if let Some(travel) = travel {
                wheel["suspension"] = json!({"travel":travel});
            }
            modules.push(wheel);
        }
        s["terrain"] = json!({"id":"rough","points":ground.iter().map(|p| json!({"x":p[0],"y":p[1]})).collect::<Vec<_>>()});
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&s.to_string()).unwrap();
        core
    }
    /// A stock design on flat ground, as drawn: it drives ahead to the left.
    fn stock(template: &str) -> NativeWorld {
        let scene = crate::game_damage::fixtures::stock_scene(&[(1, "local", template, 0.0)], json!("flat"));
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        core
    }
    fn drive(core: &NativeWorld) -> DriveState {
        core.game.as_ref().unwrap().actors[0].drive.clone().unwrap()
    }
    fn asleep(core: &NativeWorld) -> bool {
        let game = core.game.as_ref().unwrap();
        game.actors.iter().filter(|a| a.drive.is_some()).all(|a| core.world.bodies[core.bodies[&a.body]].is_sleeping())
    }
    #[test]
    fn suspension_is_made_for_full_fuel_and_ammunition_whatever_the_vehicle_holds_now() {
        let source=design("recon");
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        let compiled=crate::game_construction::compile(&source,catalogue).unwrap();
        let full=compiled["compiled"]["chassis"]["loadedKg"].as_f64().unwrap();
        let scene=crate::game_damage::fixtures::scene(&[(1,"local",source,0.0,false)],json!("flat"));
        let mut core=NativeWorld::new(&[],0.0,-9.81).unwrap();core.load_game(&scene.to_string()).unwrap();
        let game=core.game.as_mut().unwrap();let pose=game.actors[0].drive.as_ref().unwrap().pose;
        // Built, its tank and its magazine are full: what it weighs is all it can carry.
        let before=built(&game.damage,1,pose);
        let (mass,center,inertia)=assembly_mass(&game.damage,1,pose);
        assert!((before.mass-mass).abs()<1e-6 && before.center.distance(center)<1e-9 && (before.inertia-inertia).abs()<1e-6);
        assert!((before.mass-full).abs()<1e-6 && before.laden==1.0);
        let mut drained=0;
        for module in game.damage.modules.iter_mut().filter(|m|m.actor==1 && m.attached) {
            match module.kind {
                ComponentKind::Fuel=>{assert_eq!(module.fuel_litres,module.capacity_litres);module.fuel_litres=module.capacity_litres/4.0;drained+=1;},
                ComponentKind::Ammo=>{assert_eq!(module.rounds,module.capacity_rounds);module.rounds=module.capacity_rounds/4;drained+=1;},
                _=>continue,
            }
            module.weigh();
        }
        assert_eq!(drained,2,"the real design includes both refillable reserves");
        assert!(assembly_mass(&game.damage,1,pose).0<full-1.0,"what it spent is no longer carried");
        let after=built(&game.damage,1,pose);
        assert_eq!((after.mass,after.center,after.inertia,after.laden),(before.mass,before.center,before.inertia,before.laden),
            "spending and refilling must not rebuild the spring's factory mass, COM, inertia or full-load reserve");
        for (kind,density,cargo) in [("hopper",2400.0,json!({"ferro":4800.0})),
            ("cistern",850.0,json!({"petroleo":2000.0})),("supply",2400.0,json!({"ferro":4800.0}))] {
            let mut module=crate::game_damage::fixtures::module(700,1,&json!({"kind":kind,"capacityM3":2.0}));
            let full=module.full_mass();
            assert!((full-module.dry_mass-2.0*density).abs()<1e-9,"{kind}: full capacity uses the heaviest accepted cargo");
            module.stow(&cargo).unwrap();module.weigh();
            assert_eq!(module.full_mass(),full,"{kind}: current cargo cannot count twice in the full-load rating");
        }
    }
    #[test]
    fn the_springs_of_a_paver_are_made_for_its_hopper_full_whatever_it_holds_now() {
        // The hopper is the paver's own, as a tank is its vehicle's: built, the vehicle weighs it full, and nothing it
        // takes aboard weighs past that.
        let mut core=stock("paver");let game=core.game.as_mut().unwrap();
        let pose=game.actors[0].drive.as_ref().unwrap().pose;let before=built(&game.damage,1,pose);
        let paver=game.damage.modules.iter().position(|m|m.actor==1 && m.kind==ComponentKind::Paver).unwrap();
        let limit=game.damage.modules[paver].cargo_limit();let (empty,_,_)=assembly_mass(&game.damage,1,pose);
        assert!(limit>13000.0 && before.laden==1.0,"{limit} kg of mix, laden {}",before.laden);
        assert!((before.mass-empty-limit).abs()<1e-6,"built, it weighs {} with its hopper full, {empty} empty",before.mass);
        // Filled, it weighs what it holds, and is the same vehicle to its springs.
        let module=&mut game.damage.modules[paver];
        module.stow(&json!({"silica":1000.0,"petroleo":50.0})).unwrap();module.weigh();
        assert!((assembly_mass(&game.damage,1,pose).0-empty-1000.0-50.0*0.85).abs()<1e-6);
        let after=built(&game.damage,1,pose);
        assert_eq!((after.mass,after.center,after.inertia,after.laden),(before.mass,before.center,before.inertia,before.laden));
    }
    #[test]
    fn static_chassis_capacity_metadata_does_not_change_elastic_springs() {
        let mut core=stock("truck");let game=core.game.as_mut().unwrap();
        let pose=game.actors[0].drive.as_ref().unwrap().pose;let before=built(&game.damage,1,pose);
        let seats=game.gears.iter().flat_map(|gear| {
            let travel=gear_travel(game.damage.module(gear.owner).unwrap());
            gear.springs.iter().map(move|spring|(spring.seat,spring.arm,travel))
        }).collect::<Vec<_>>();
        let elastic=serde_json::to_value(springs(&seats,&before,9.81)).unwrap();
        let mut changed=0;
        for plate in game.damage.plates.iter_mut().filter(|p|p.actor==1 && p.attached) {
            if plate.cold["definition"]["chassis"].get("limitKg").is_some() {
                plate.cold["definition"]["chassis"]["limitKg"]=json!(1e12);changed+=1;
            }
        }
        assert_eq!(changed,1,"the admitted frame actually exposes a static design allowance");
        let after=built(&game.damage,1,pose);
        assert_eq!((after.mass,after.center,after.inertia,after.laden),(before.mass,before.center,before.inertia,before.laden));
        assert!(!seats.is_empty() && before.laden>1.0,"the truck has real springs and a nonempty cargo reserve");
        assert_eq!(serde_json::to_value(springs(&seats,&after,9.81)).unwrap(),elastic,
            "changing a yield/admission allowance cannot change elastic load, rate, firmness or damping");
    }
    #[test]
    fn every_stock_design_rests_on_its_springs_where_it_was_built() {
        for template in ["heavy", "ifv", "scout", "recon", "mortar", "howitzer", "chassis", "tracked", "truck", "tanker", "supply"] {
            let mut core = stock(template);
            advance(&mut core, 240);
            let game = core.game.as_ref().unwrap();
            assert!(asleep(&core), "{template}");
            let hulls: Vec<Pose> = game.actors.iter().map(|a| a.drive.as_ref().unwrap().pose).collect();
            // Measure levelness as less than a millimetre over the whole hull,
            // rather than one angular tolerance for every chassis length.
            assert!(hulls.iter().all(|hull| hull.angle.abs()*crate::game_construction::BODY_WIDTH < 1e-3
                && (hull.y-hulls[0].y).abs()<1e-9),"{template}: {hulls:?}");
            // Every gear in its place under the hull to half a millimetre, a third of its travel
            // taken, and its rim on the ground, with nothing between them.
            for (told, gear) in game.gear_bindings.iter().zip(&game.gears) {
                let m = game.damage.module(told.owner).unwrap();
                assert!(told.travel > 0.0 && gear.carried.load > 0.0, "{template}");
                assert!(told.displacement.abs() < 5e-4 && told.tilt.abs() < 1e-4, "{template}: {} {}", told.displacement, told.tilt);
                assert!((told.compression - told.travel * SPRING_REST).abs() < 5e-4, "{template}: {}", told.compression);
                let clear = m.pose.y - m.height / 2.0 - game.terrain.height(m.pose.x);
                assert!(clear.abs() < 1e-6, "{template}: {clear}");
            }
            assert_eq!(game.recoveries, 0);
        }
    }
    #[test]
    fn every_stock_design_drives_ahead_on_all_its_gear_and_climbs_a_slope_of_thirty_percent() {
        // Flat ahead of it, or a slope that rises 30 m over the 100 m that begin 30 m ahead and is flat again above:
        // a minute flat out, in which the heaviest for its engine, the howitzer, comes up to its road speed.
        let slope = json!({"id":"flat","points":[{"x":-600,"y":30},{"x":-130,"y":30},{"x":-30,"y":0},{"x":400,"y":0}]});
        for template in ["heavy", "ifv", "scout", "recon", "mortar", "howitzer", "chassis", "tracked", "truck", "tanker", "supply"] {
            for ground in [json!("flat"), slope.clone()] {
                let climb = ground != "flat";
                let scene = crate::game_damage::fixtures::stock_scene(&[(1, "local", template, 0.0)], ground);
                let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
                core.load_game(&scene.to_string()).unwrap();
                advance(&mut core, 120);
                command(&mut core, json!({"op":"control","actorId":"local","throttle":-1}));
                let (mut top, mut lean, mut lifted) = (0.0_f64, 0.0_f64, 0);
                for frame in 0..3600 {
                    advance(&mut core, 1);
                    let game = core.game.as_ref().unwrap();
                    let hull = drive(&core);
                    top = top.max(-hull.velocity.x * 3.6);
                    lean = lean.max(hull.pose.angle.abs());
                    // On flat ground every wheel or track carries its part, all the way.
                    if !climb && frame > 60 && game.gears.iter().any(|gear| gear.carried.load <= 0.0) {
                        lifted += 1;
                    }
                }
                let (game, hull) = (core.game.as_ref().unwrap(), drive(&core));
                assert_eq!((game.recoveries, lifted), (0, 0), "{template}");
                if climb {
                    // Over the crest and on, never near tipping over: the slope leans it 0.29 rad.
                    assert!(hull.pose.x < -150.0 && lean < 0.45, "{template}: {} {lean}", hull.pose.x);
                } else {
                    // A road speed of a vehicle of its kind, and level.
                    // These armoured designs now carry the real box-frame mass
                    // on the same engines, rather than the old lighter proxy.
                    let minimum=if matches!(template,"ifv"|"howitzer") {50.0} else {60.0};
                    // Level but for sitting back as it pulls away, as far as two and a half degrees on a tall track.
                    assert!(top > minimum && top.is_finite() && lean < 0.045, "{template}: {top} km/h {lean}");
                }
            }
        }
    }
    // The source of a stock design as its template writes it.
    fn design(template: &str) -> serde_json::Value {
        crate::game_templates::source(template, &json!({}), crate::game_damage::fixtures::full_catalogue()).unwrap()
    }
    // Drives a design ahead over concrete ground through `points`, keeping under `speed`, for as long as it makes
    // way, until it is 32 m on. Tells how far it went, the most it leaned on the way, how many steps the solver took
    // back and the deepest the outline of a track of it went under the ground. The ground is not the level one,
    // which the solver holds as a plane.
    fn drive_over(source: &serde_json::Value, points: serde_json::Value, speed: f64) -> (f64, f64, u64, f64) {
        let (made, lean, recovered, sunk, _, _, _) = drive_over_health(source, points, speed);
        (made, lean, recovered, sunk)
    }
    // Also keeps the admitted/final gear health, final speed and peak hull height, distinguishing
    // damage and a ballistic launch from a geometric failure to climb the same step at a walk.
    fn drive_over_health(source: &serde_json::Value, points: serde_json::Value, speed: f64) -> (f64, f64, u64, f64, Vec<(u32, f64, f64)>, f64, f64) {
        let ground = json!({"id":"mixed","minX":-600,"maxX":400,"points":points,
            "sectors":[{"start":-600,"end":400,"surface":"concrete"}]});
        let scene = crate::game_damage::fixtures::scene(&[(1, "local", source.clone(), 0.0, false)], ground);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        advance(&mut core, 60);
        let health = core.game.as_ref().unwrap().damage.modules.iter().filter(|m| m.kind.gear())
            .map(|m| (m.owner, m.health)).collect::<Vec<_>>();
        let (mut throttle, mut lean, mut made, mut idle, mut sunk) = (0.0, 0.0_f64, 0.0_f64, 0, 0.0_f64);
        let mut peak_y = drive(&core).pose.y;
        while idle < 600 && drive(&core).pose.x > -32.0 {
            let hull = drive(&core);
            let wanted = if hypot(hull.velocity.x, hull.velocity.y) < speed { -1.0 } else { 0.0 };
            if wanted != throttle {
                throttle = wanted;
                command(&mut core, json!({"op":"control","actorId":"local","throttle":throttle}));
            }
            advance(&mut core, 1);
            let hull = drive(&core);
            lean = lean.max(hull.pose.angle.abs());
            peak_y = peak_y.max(hull.pose.y);
            (made, idle) = if -hull.pose.x > made + 0.1 { (-hull.pose.x, 0) } else { (made, idle + 1) };
            let game = core.game.as_ref().unwrap();
            for m in game.damage.modules.iter().filter(|m| m.kind == ComponentKind::Track) {
                let (c, s) = (cos(m.pose.angle), sin(m.pose.angle));
                for p in crate::game_geometry::track_outline(m.width, m.height) {
                    sunk = sunk.max(game.terrain.height(m.pose.x + c * p.x - s * p.y) - (m.pose.y + s * p.x + c * p.y));
                }
            }
        }
        let game = core.game.as_ref().unwrap();
        let health = health.into_iter().map(|(owner, before)| (owner, before, game.damage.module(owner).unwrap().health)).collect();
        let hull = drive(&core);
        (-hull.pose.x, lean, game.recoveries, sunk, health, hypot(hull.velocity.x, hull.velocity.y), peak_y)
    }
    // Whether a design drives on 12 m past a step `height` high whose face rises over 2 cm, 20 m ahead of the
    // middle of the design, the most it leaned on the way and the deepest a track of it went under the ground.
    fn at_a_step(source: &serde_json::Value, height: f64, speed: f64) -> (bool, f64, f64) {
        let step = json!([{"x":-600,"y":height},{"x":-20.02,"y":height},{"x":-20,"y":0},{"x":400,"y":0}]);
        let (made, lean, recovered, sunk) = drive_over(source, step, speed);
        assert_eq!(recovered,0,"a vertical step must not rely on solver recovery");
        (made >= 32.0, lean, sunk)
    }
    #[test]
    fn a_vehicle_climbs_a_wall_as_high_as_its_gear_takes_it_up_the_face_and_no_higher() {
        // Wheels grip the edge of a step with their rims and pull themselves up on it, as hard as the gear behind
        // pushes them there: three axles of wheels 1.1 m across take the recon and the mortar up nearly as high as
        // their axles stand. A track meets the face with its belt round the idler, raised at the front of the hull,
        // and pulls itself up it, the hull sitting back on its springs as the belt pulls it, and slipping on the ground
        // behind the face, which holds a track that spins by less than one that grips (game_terrain.rs `sliding`): at a
        // walk the heavy tank, 600 kW in 33 t, goes up a wall of 0.85 m (the Leopard 2, 1100 kW in 62 t, over a metre
        // [S], the Abrams 1.07 m [D]), the ifv one of 0.8 m (the Bradley 0.76-0.91 m [S]), the howitzer 0.75 m, and the
        // recon on a 0.7 m track with a 15 mm structural tub at least 0.5 m. Its negative face is above the entire
        // 0.7 m belt: removing fictitious mantlet mass can legitimately improve its climb.
        // These designs have their own mass, COM and payload-sized springs. The howitzer's negative
        // face is 0.9 m, above its entire 0.78 m belt; 0.8 m is not a universal geometric limit of that track.
        // Their springs travel as far as their tracks let them (game_chassis.rs), and sitting back on them the ifv, on a
        // track of 0.97 m, goes up a metre, past the Bradley, and the howitzer 0.9 m.
        let mut light = design("recon");
        light["chassis"]=json!({"model":"tracked","points":light["chassis"]["points"],
            "gearScale":0.7/0.78,"thicknessMm":15.0});
        // Its smaller track keeps the height of its suspension, as the workshop keeps it: the whole of it a little lower.
        let light=crate::game_construction::seated(&light,crate::game_damage::fixtures::full_catalogue());
        for (name, source, climbs, stops) in [("recon", design("recon"), 0.45, 0.6), ("mortar", design("mortar"), 0.3, 0.6),
            ("heavy", design("heavy"), 0.85, 1.05), ("ifv", design("ifv"), 0.8, 1.05), ("howitzer", design("howitzer"), 0.75, 0.95),
            ("light", light, 0.5, 1.1)] {
            let (over, lean, _) = at_a_step(&source, climbs, 1.4);
            assert!(over && lean < 0.6, "{name} climbs {climbs} m: {over} {lean}");
            assert!(!at_a_step(&source, stops, 1.4).0, "{name} climbs {stops} m");
        }
    }
    #[test]
    fn a_track_up_a_step_rests_the_run_to_an_end_on_the_edge_and_never_goes_under_the_ground() {
        // Up the half-metre step at a walk, the run to the idler rests on the edge while the road wheels under it
        // hang over the ground below, and then the run to the sprocket on the edge while those ahead are pressed up
        // on the step. The hull holds the idler and the sprocket: the track stands at the end that rests on the edge
        // as the hull holds it there, not hanging into the ground with its road wheels, and nothing of it goes under
        // the ground on the way.
        for template in ["heavy", "ifv", "tracked"] {
            let (over, _, sunk) = at_a_step(&design(template), 0.5, 1.4);
            assert!(over && sunk < 0.025, "{template}: {over}, {sunk} m under the ground");
        }
    }
    #[test]
    fn a_lorry_nosed_into_a_ditch_is_not_thrown_out_by_its_wheels_spinning_against_the_walls() {
        // A ditch 3.5 m across and 1.5 m deep, its walls rising over a quarter of a metre, as on the proving
        // ground. A lorry goes in nose first and sticks there, wedged from wall to wall, its wheels spinning
        // against them: they pull on them no harder than the drivetrain gives, and the solver takes no step back.
        let ditch = json!([{"x":-600,"y":0},{"x":-23.5,"y":0},{"x":-23.25,"y":-1.5},{"x":-20.25,"y":-1.5},
            {"x":-20,"y":0},{"x":400,"y":0}]);
        for template in ["truck", "mortar", "supply"] {
            let (made, lean, recovered, _, health, _, height) = drive_over_health(&design(template), ditch.clone(), 1.4);
            assert!(made < 32.0 && recovered == 0, "{template}: {made} m, {recovered} steps taken back");
            // Road level is y=0 and the pit is 1.5 m deep: correcting the wedge must not
            // throw the hull above 2 m or turn it past 60 degrees, even if it lands in the pit again.
            assert!(height < 2.0 && lean < std::f64::consts::FRAC_PI_3, "{template}: height={height}, lean={lean}");
            assert!(health.iter().all(|(_, before, after)| before == after), "{template}: {health:?}");
        }
    }
    #[test]
    fn a_full_hopper_presses_a_lorry_down_on_its_springs_short_of_their_stops() {
        let mut core = stock("truck");
        advance(&mut core, 240);
        let empty = drive(&core);
        let empty_compression:Vec<_>=core.game.as_ref().unwrap().gear_bindings.iter().map(|g|g.compression).collect();
        let hopper = core.game.as_ref().unwrap().damage.modules.iter()
            .find(|m| m.actor == 1 && m.kind == ComponentKind::Hopper).unwrap().owner;
        // All the iron it has room for: the lorry weighs more than twice what it was built at,
        // and every axle takes its part of the full payload.
        command(&mut core, json!({"op":"setPartState","owner":hopper,"state":{"cargo":{"ferro":1e9}}}));
        advance(&mut core, 600);
        let full = drive(&core);
        assert!(full.mass > empty.mass * 2.2, "{} {}", full.mass, empty.mass);
        let game = core.game.as_ref().unwrap();
        let springs: Vec<_> = game.gear_bindings.iter().filter(|g| game.damage.module(g.owner).unwrap().actor == 1).collect();
        let travel = springs[0].travel;
        let sunk = empty.pose.y - full.pose.y;
        // The same millimetre of geometric resolution bounds body sag and spring compression.
        let resolution=0.001;
        assert!(sunk > 0.02 && sunk < travel * (1.0 - SPRING_REST) / 2.0 + resolution, "{sunk}");
        assert!(springs.iter().all(|g| g.compression > 0.0 && g.compression < travel - 0.03)
            && springs.iter().map(|g|g.compression).sum::<f64>() > empty_compression.iter().sum::<f64>() + 0.02
            && game.gears.iter().all(|g|g.carried.load > 0.0),
            "{:?}", springs.iter().map(|g| g.compression).collect::<Vec<_>>());
        // The hopper is not centred on the factory COM: a small settled pitch is real load transfer.
        // Its pitch stays within the differential travel between its outer supports, with every spring clear of its stop.
        let xs:Vec<_>=game.damage.modules.iter().filter(|m|m.actor==1 && m.kind.gear()).map(|m|m.pose.x).collect();
        let span=xs.iter().copied().fold(f64::NEG_INFINITY,f64::max)-xs.iter().copied().fold(f64::INFINITY,f64::min);
        assert!(full.pose.angle.abs() < crate::game_geometry::atan2(travel-0.06,span) && asleep(&core), "{}", full.pose.angle);
        // Tipped out, it stands again where it was built.
        command(&mut core, json!({"op":"setPartState","owner":hopper,"state":{"cargo":{}}}));
        advance(&mut core, 600);
        let tipped = drive(&core);
        assert_eq!(tipped.mass, empty.mass);
        assert!((tipped.pose.y - empty.pose.y).abs() < 5e-4 && tipped.pose.angle.abs() < 1e-4 && asleep(&core),
            "{} {}", tipped.pose.y - empty.pose.y, tipped.pose.angle);
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    }
    #[test]
    fn a_wheel_over_a_dip_carries_and_drives_on_its_spring_where_one_without_travel_hangs() {
        let dip = [[-500.0, 0.0], [-0.45, 0.0], [-0.3, -0.07], [0.3, -0.07], [0.45, 0.0], [500.0, 0.0]];
        for (travel, reaches) in [(0.3, true), (0.0, false)] {
            let mut core = on_wheels(&[-1.2, 0.0, 1.2], Some(travel), &dip);
            advance(&mut core, 240);
            // The wheel ahead is shot away: of the two left to drive, one stands over the dip.
            command(&mut core, json!({"op":"setPartState","owner":32,"state":{"health":0}}));
            advance(&mut core, 2);
            let game = core.game.as_ref().unwrap();
            let d = game.actors[0].drive.as_ref().unwrap();
            let middle = game.gears.iter().find(|g| g.owner == 31).unwrap();
            let told = game.gear_bindings.iter().find(|g| g.owner == 31).unwrap();
            assert_eq!(middle.ground_contact.is_some(), reaches);
            assert_eq!(d.traction, if reaches { 1.0 } else { 0.5 });
            if reaches {
                assert!(middle.carried.load > d.mass * 9.81 / 10.0, "{}", middle.carried.load);
                assert!(told.displacement < -0.03 && told.displacement > -0.07 && told.compression > 0.0, "{}", told.displacement);
            } else {
                assert_eq!((middle.carried.load, told.displacement, told.compression), (0.0, 0.0, 0.0));
            }
            assert_eq!(game.recoveries, 0);
        }
    }
    #[test]
    fn a_bump_crossed_at_speed_throws_a_hull_on_springs_less_than_one_without() {
        let bump = [[-500.0, 0.0], [6.0, 0.0], [6.3, 0.06], [6.6, 0.06], [6.9, 0.0], [500.0, 0.0]];
        // How fast the hull is thrown up and turned, how far it rises, and for how many steps it
        // has less than all its gear on the ground.
        let crossing = |travel: Option<f64>| {
            let mut core = on_wheels(&[-1.2, 1.2], travel, &bump);
            advance(&mut core, 120);
            let rest = drive(&core).pose.y;
            command(&mut core, json!({"op":"setVehicleState","state":{"vx":6}}));
            command(&mut core, json!({"op":"control","actorId":"local","throttle":1}));
            let (mut heave, mut pitch, mut rise, mut loose) = (0.0_f64, 0.0_f64, 0.0_f64, 0);
            for _ in 0..180 {
                advance(&mut core, 1);
                let d = drive(&core);
                heave = heave.max(d.velocity.y.abs());
                pitch = pitch.max(d.omega.abs());
                rise = rise.max(d.pose.y - rest);
                loose += (d.traction < 1.0) as u32;
            }
            assert!(drive(&core).pose.x > 15.0);
            assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
            (heave, pitch, rise, loose)
        };
        let (sprung, rigid) = (crossing(None), crossing(Some(0.0)));
        assert!(sprung.0 < rigid.0 * 0.6 && sprung.1 < rigid.1 * 0.75 && sprung.2 < rigid.2 * 0.6 && sprung.3 < rigid.3,
            "{sprung:?} against {rigid:?}");
    }
    #[test]
    fn on_a_slope_a_vehicle_on_springs_comes_to_rest_sleeps_and_stays_where_it_stopped() {
        let mut core = on_wheels(&[-1.2, 1.2], None, &[[-500.0, 100.0], [500.0, -100.0]]);
        command(&mut core, json!({"op":"setVehicleState","state":{"y":1.0,"angle":-0.1974}}));
        advance(&mut core, 300);
        let rested = drive(&core);
        assert!(asleep(&core) && rested.hold > 0.0 && rested.traction == 1.0);
        // It leans a little on the spring downhill, and has not run away while it settled.
        assert!(rested.pose.x.abs() < 0.05 && (rested.pose.angle + 0.1974).abs() < 0.01, "{:?}", rested.pose);
        advance(&mut core, 600);
        assert_eq!(drive(&core).pose, rested.pose);
        assert!(asleep(&core));
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    }
    #[test]
    fn on_a_slope_every_wheel_stands_with_its_rim_on_the_ground_with_its_travel_or_without() {
        // The ground falls to the right at each of these grades, through the middle of the hull.
        for degrees in [0.0_f64, 10.0, 17.0, 25.0] {
            let grade = degrees.to_radians().tan();
            for travel in [None, Some(0.0)] {
                let mut core = on_wheels(&[-1.2, 1.2], travel, &[[-500.0, 500.0 * grade], [500.0, -500.0 * grade]]);
                // Let down along the slope from five centimetres over it.
                command(&mut core, json!({"op":"setVehicleState","state":{"y":0.95 / degrees.to_radians().cos(),"angle":-degrees.to_radians()}}));
                advance(&mut core, 300);
                let game = core.game.as_ref().unwrap();
                for g in &game.gear_bindings {
                    let m = game.damage.module(g.owner).unwrap();
                    let clear = (grade * m.pose.x + m.pose.y) / grade.hypot(1.0) - m.height / 2.0;
                    assert!(clear.abs() < 1e-4, "{degrees}° {travel:?}: {clear}");
                }
                assert_eq!(game.recoveries, 0);
            }
        }
    }
    #[test]
    fn a_gear_without_travel_carries_its_hull_on_the_ground_itself() {
        let mut core = on_wheels(&[-1.2, 1.2], Some(0.0), &[[-500.0, 0.0], [500.0, 0.0]]);
        advance(&mut core, 120);
        let game = core.game.as_ref().unwrap();
        let d = drive(&core);
        assert!(game.gears.iter().all(|g| g.springs.is_empty() && g.carried.load == 0.0 && g.ground_contact.is_some()));
        assert!(game.gear_bindings.iter().all(|g| (g.travel, g.displacement, g.tilt, g.compression) == (0.0, 0.0, 0.0, 0.0)));
        let body = &core.world.bodies[core.bodies[&game.actors[0].body]];
        assert_eq!((body.user_force(), body.user_torque()), (Vector::new(0.0, 0.0), 0.0));
        assert_eq!(core.world.narrow_phase.contact_pairs().map(|pair|
            pair.manifolds().iter().map(|m| m.points.len()).sum::<usize>()).sum::<usize>(), 2);
        assert!((d.pose.y - 0.9).abs() < 0.025 && d.traction == 1.0 && body.is_sleeping(), "{}", d.pose.y);
    }
    #[test]
    fn pulling_away_braking_and_firing_lean_a_heavy_hull_a_little_and_it_comes_back_level() {
        let mut core = stock("heavy");
        advance(&mut core, 240);
        // How far back and how far down the hull leans over these steps, in radians: it faces left, so its nose
        // rises as it turns clockwise.
        let lean = |core: &mut NativeWorld, frames: u32| {
            let (mut back, mut down) = (0.0_f64, 0.0_f64);
            for _ in 0..frames {
                advance(core, 1);
                let angle = -drive(core).pose.angle;
                back = back.max(angle);
                down = down.min(angle);
            }
            (back, down)
        };
        let level = |core: &NativeWorld| drive(core).pose.angle.abs() < 1e-3 && asleep(core);
        // It sits back as it pulls away, ahead to the left, and dips as it brakes, by a degree or two: on springs that
        // travel as far as its track of 1.02 m lets them, 0.29 m.
        command(&mut core, json!({"op":"control","actorId":"local","throttle":-1}));
        let away = lean(&mut core, 240);
        assert!(away.0 > 0.005 && away.0 < 0.045 && away.1 > -0.002, "{away:?}");
        assert!(drive(&core).velocity.x < -8.0);
        command(&mut core, json!({"op":"control","actorId":"local","throttle":0,"brake":1.0}));
        let braked = lean(&mut core, 600);
        assert!(braked.1 < -0.005 && braked.1 > -0.045, "{braked:?}");
        assert!(level(&core), "{}", drive(&core).pose.angle);
        // Its own gun rocks it back by half a degree.
        let game = core.game.as_ref().unwrap();
        let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.kind == ComponentKind::Weapon).unwrap();
        let (id, angle) = (gun.cold["id"].clone(), gun.barrel_angle);
        let aim = Point::new(gun.pose.x + 30.0 * cos(angle), gun.pose.y + 30.0 * sin(angle));
        assert_eq!(command(&mut core, json!({"op":"fire","actorId":"local","force":true,"aim":aim.to_value(),
            "config":{"id":"cannon","preset":"rh120","componentId":id,"platform":"vehicle","aimAngle":angle,"ammo":"apfsds","charge":1.0}})), true);
        let fired = lean(&mut core, 300);
        assert!(fired.0 > 0.002 && fired.0 < 0.0175, "{fired:?}");
        assert!(level(&core), "{}", drive(&core).pose.angle);
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    }
    #[test]
    fn a_destroyed_wheel_stands_still_while_the_other_turns_and_turns_again_once_repaired() {
        // The angle of each of the two wheels and how fast it turns.
        let told = |core: &NativeWorld| {
            let game = core.game.as_ref().unwrap();
            [0, 1].map(|i| (game.gear_bindings[i].angle, game.gear_bindings[i].angular_speed))
        };
        let mut core = world();
        let whole = core.game.as_ref().unwrap().damage.module(30).unwrap().max_health;
        advance(&mut core, 60);
        command(&mut core, json!({"op":"control","actorId":"local","throttle":1}));
        advance(&mut core, 120);
        // Thrown off the ground both turn on with the speed they left it with. Destroyed there, one stops.
        command(&mut core, json!({"op":"setVehicleState","state":{"y":2.0}}));
        advance(&mut core, 2);
        assert!(told(&core).iter().all(|wheel| wheel.1 < -1.0), "{:?}", told(&core));
        command(&mut core, json!({"op":"setPartState","owner":30,"state":{"health":0}}));
        advance(&mut core, 1);
        let [stood, flying] = told(&core);
        assert_eq!(stood.1, 0.0);
        advance(&mut core, 5);
        let [dead, alive] = told(&core);
        assert_eq!(dead, stood);
        assert!(alive.0 < flying.0 - 0.1 && alive.1 < -1.0, "{alive:?}");
        // Back on the ground the vehicle drives on its other wheel, and the destroyed one still stands.
        advance(&mut core, 180);
        let [dead, alive] = told(&core);
        assert_eq!(dead, stood);
        assert!(alive.0 < flying.0 - 5.0 && alive.1 < -1.0, "{alive:?}");
        assert_eq!(core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap().traction, 0.5);
        // Repaired, it turns with the ground again from where it stood: as far as the other, and no further.
        command(&mut core, json!({"op":"setPartState","owner":30,"state":{"health":whole}}));
        advance(&mut core, 1);
        let [mended, other] = told(&core);
        assert!(mended.0 < stood.0 && (mended.0 - stood.0 - (other.0 - alive.0)).abs() < 1e-9, "{mended:?} {other:?}");
        assert!((mended.1 - other.1).abs() < 0.05 && mended.1 < -1.0, "{mended:?} {other:?}");
        assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    }
    // A small vehicle on two wheels: its actor, its plates and its pieces, as a scene has them.
    fn cart(handle: u32, name: &str, owner: u32, x: f64) -> (Value, Vec<Value>, Vec<Value>) {
        let plate = |owner: u32, dx: f64, y: f64, length: f64, angle: f64| {
            let mut value = crate::game_damage::fixtures::plate(owner, handle, &json!({"definition":{
                "id":format!("{name}-plate-{owner}"),"x":x+dx,"y":y,"length":length,"angle":angle,"thicknessMm":40,"material":"steel"}})).to_value();
            value["actor"] = json!(handle);
            value
        };
        let plates = vec![plate(owner, 0.0, 0.8, 3.4, 0.0), plate(owner + 1, 0.0, 1.6, 3.4, 0.0)];
        let mut modules = vec![
            json!({"owner":owner+2,"actor":handle,"id":format!("{name}-command"),"kind":"command","x":x,"y":1.2,"width":0.3,"height":0.2,"physicalMass":25}),
            json!({"owner":owner+3,"actor":handle,"id":format!("{name}-engine"),"kind":"engine","x":x+0.8,"y":1.1,"width":0.6,"height":0.4,"physicalMass":280}),
        ];
        for (i, dx) in [-1.2, 1.2].into_iter().enumerate() {
            modules.push(json!({"owner":owner+4+i as u32,"actor":handle,"id":format!("{name}-wheel-{i}"),"kind":"wheel","x":x+dx,"y":0.4,
                "width":0.8,"height":0.8,"physicalMass":100}));
        }
        (json!({"id":name,"handle":handle,"team":name,"vehicle":{"x":x,"y":0.9,"enabled":true},"defeated":false}), plates, modules)
    }
    fn field(carts: &[(Value, Vec<Value>, Vec<Value>)]) -> NativeWorld {
        let scene = json!({"terrain":"flat","seed":6173,"visualEvents":false,"bounds":{"minX":-80,"maxX":80,"minY":-5,"maxY":30},
            "actors":carts.iter().map(|c| c.0.clone()).collect::<Vec<_>>(),
            "plates":carts.iter().flat_map(|c| c.1.clone()).collect::<Vec<_>>(),
            "modules":carts.iter().flat_map(|c| c.2.clone()).collect::<Vec<_>>()});
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        core
    }
    fn coming(leaving: &[u32], carts: &[(Value, Vec<Value>, Vec<Value>)]) -> Value {
        json!({"op":"admit","leaving":leaving,
            "actors":carts.iter().map(|c| c.0.clone()).collect::<Vec<_>>(),
            "plates":carts.iter().flat_map(|c| c.1.clone()).collect::<Vec<_>>(),
            "modules":carts.iter().flat_map(|c| c.2.clone()).collect::<Vec<_>>()})
    }
    fn stands(core: &NativeWorld, handle: u32) -> (f64, f64, f64, f64, f64) {
        let game = core.game.as_ref().unwrap();
        let actor = game.actors.iter().find(|a| a.handle == handle).unwrap();
        let body = &core.world.bodies[core.bodies[&actor.body]];
        (body.translation().x, body.translation().y, body.rotation().angle(), body.linvel().x, body.linvel().y)
    }
    #[test]
    fn constructions_cross_without_contact_pairs_and_keep_terrain_and_ballistic_cover() {
        for (team, defeated, enabled) in [("other", false, true), ("moving", false, true),
            ("other", true, true), ("other", false, false)] {
            let mut target = cart(2, "target", 20, 0.0);
            target.0["team"] = json!(team);
            target.0["defeated"] = json!(defeated);
            target.0["vehicle"]["enabled"] = json!(enabled);
            let mut core = field(&[cart(1, "moving", 10, -6.0), target]);
            advance(&mut core, 60);
            command(&mut core, json!({"op":"setVehicleState","actorId":"moving","state":{"vx":8.0}}));
            // The cart has no fuel. Holding the throttle releases its automatic parking brake; it only coasts.
            command(&mut core, json!({"op":"control","actorId":"moving","throttle":1.0,"brake":0.0}));
            for _ in 0..120 {
                advance(&mut core, 1);
                assert!(core.world.narrow_phase.contact_pairs().all(|pair| {
                    let actor = |handle| core.metadata.get(&handle).map_or(0, |m| m.actor);
                    actor(pair.collider1) == 0 || actor(pair.collider2) == 0
                }), "construction pairs never enter the contact graph");
            }
            assert!(stands(&core, 1).0 > stands(&core, 2).0 + 3.4, "the hull crossed the whole other construction");
            let game = core.game.as_ref().unwrap();
            assert!(game.actors[0].drive.as_ref().unwrap().grounded);
            assert!(game.gear_bindings.iter().filter(|g| g.owner == 14 || g.owner == 15).any(|g| g.touching));
            let module = game.damage.module(23).unwrap();
            let hit = game.geometry.raycast_owner(23, Point::new(module.pose.x - 1.0, module.pose.y),
                Point::new(module.pose.x + 1.0, module.pose.y)).unwrap();
            assert_eq!(hit.actor, 2, "the crossed construction retains its projectile geometry");
            assert_eq!(game.recoveries, 0);
        }
    }
    #[test]
    fn a_construction_admitted_to_a_field_that_goes_on_is_the_one_a_scene_would_have_brought() {
        let (first, second) = (cart(1, "first", 10, 0.0), cart(2, "second", 20, 30.0));
        let mut whole = field(&[first.clone(), second.clone()]);
        let mut grown = field(&[first]);
        // The answer is what a cold frame says of what came, and of nothing else.
        let told = command(&mut grown, coming(&[], &[second]));
        assert_eq!((told["actors"][0]["id"].as_str(), told["actors"].as_array().unwrap().len()), (Some("second"), 1));
        assert_eq!(told["plates"].as_array().unwrap().iter().map(|p| p["owner"].as_u64().unwrap()).collect::<Vec<_>>(), [20, 21]);
        assert_eq!(told["modules"].as_array().unwrap().iter().map(|m| m["owner"].as_u64().unwrap()).collect::<Vec<_>>(), [22, 23, 24, 25]);
        assert!(told["plates"][0]["damage"].is_object() && told["modules"][2]["suspension"]["travel"].as_f64().unwrap() > 0.0);
        assert_eq!((grown.bodies.len(), grown.colliders.len()), (whole.bodies.len(), whole.colliders.len()));
        for core in [&mut whole, &mut grown] {
            advance(core, 180);
        }
        assert_eq!(stands(&grown, 1), stands(&whole, 1));
        assert_eq!(stands(&grown, 2), stands(&whole, 2));
        let (game, cold) = (grown.game.as_ref().unwrap(), whole.game.as_ref().unwrap());
        assert_eq!(game.damage.modules.len(), cold.damage.modules.len());
        assert_eq!(game.module_exports.len(), game.damage.modules.len());
        assert_eq!((game.gears.len(), game.gear_bindings.len(), game.bindings.len()), (cold.gears.len(), cold.gear_bindings.len(), cold.bindings.len()));
        // It is on its wheels as the other is: its springs were made, and carry it.
        assert!(game.gear_bindings.iter().all(|gear| gear.travel > 0.0 && gear.touching));
    }
    #[test]
    fn a_construction_that_leaves_takes_what_was_its_own_and_the_others_stand_as_they_stood() {
        let (first, second) = (cart(1, "first", 10, 0.0), cart(2, "second", 20, 30.0));
        let mut core = field(&[first.clone(), second]);
        let mut alone = field(&[first]);
        advance(&mut core, 90);
        advance(&mut alone, 90);
        let before = stands(&core, 1);
        let told = serde_json::from_str::<Value>(&core.game_command(&coming(&[2], &[]).to_string()).unwrap()).unwrap();
        assert_eq!(stands(&core, 1), before);
        assert_eq!((core.bodies.len(), core.colliders.len(), core.metadata.len()), (alone.bodies.len(), alone.colliders.len(), alone.metadata.len()));
        {
            let game = core.game.as_ref().unwrap();
            assert_eq!(game.actors.len(), 1);
            assert!(game.damage.plates.iter().all(|p| p.actor == 1) && game.damage.modules.iter().all(|m| m.actor == 1));
            assert!((20..26).all(|owner| game.damage.plate(owner).is_none() && game.damage.module(owner).is_none() && game.geometry.bounds(owner).is_none()));
            assert!((10..16).all(|owner| game.geometry.bounds(owner).is_some()));
            assert_eq!((game.bindings.len(), game.gears.len(), game.gear_bindings.len(), game.module_exports.len()), (6, 2, 2, 4));
            // The frame of the command tells no part of the one that left.
            assert!(told["frame"]["plates"].as_array().unwrap().iter().all(|p| p["owner"].as_u64().unwrap() < 20));
        }
        // The one that stays goes on as on a field that never had the other.
        advance(&mut core, 90);
        advance(&mut alone, 90);
        assert_eq!(stands(&core, 1), stands(&alone, 1));
        // Another takes its place under its handle, with parts of its own; and one comes where the second was.
        command(&mut core, coming(&[1], &[cart(1, "first", 40, 0.0), cart(3, "third", 50, 30.0)]));
        advance(&mut core, 120);
        let game = core.game.as_ref().unwrap();
        assert_eq!((core.bodies.len(), game.actors.len(), game.damage.plates.len(), game.damage.modules.len(), game.module_exports.len()), (2, 2, 4, 8, 8));
        assert!(game.damage.plate(10).is_none() && game.damage.plate(40).is_some() && game.damage.module(54).is_some());
        assert!(game.gear_bindings.iter().all(|gear| gear.touching));
    }
    #[test]
    fn a_construction_that_is_refused_leaves_nothing_of_itself_on_the_field() {
        let mut core = field(&[cart(1, "first", 10, 0.0)]);
        advance(&mut core, 30);
        let before = stands(&core, 1);
        // One under the handle of another that stands there.
        assert!(core.game_command(&coming(&[], &[cart(1, "again", 60, 20.0)]).to_string()).is_err());
        // One with a piece no scene admits: its plates had entered before the piece was read.
        let mut broken = cart(2, "broken", 70, 30.0);
        broken.2.push(json!({"owner":79,"actor":2,"id":"broken-mount","kind":"engine","x":30,"y":1.2,"width":0.3,"height":0.2,"weaponMount":{}}));
        assert!(core.game_command(&coming(&[], &[broken.clone()]).to_string()).is_err());
        // The same one in the place of the first: the first stands, with its parts and its body.
        broken.0["handle"] = json!(1);
        for part in broken.1.iter_mut().chain(broken.2.iter_mut()) {
            part["actor"] = json!(1);
        }
        assert!(core.game_command(&coming(&[1], &[broken]).to_string()).is_err());
        // Contact preparation can fail after the parts were read. It still happens before the old actor leaves.
        for (key,value) in [
            ("contactContours",json!([[{"x":0,"y":0},{"x":2,"y":0},{"x":1,"y":1},{"x":2,"y":2},{"x":0,"y":2}]])),
            ("contactVolumes",json!([[{"x":0,"y":0},{"x":0,"y":0},{"x":0,"y":0}]])),
        ] {
            let mut bad_contact = cart(1,"bad-contact",80,30.0);
            bad_contact.0[key]=value;
            assert!(core.game_command(&coming(&[1],&[bad_contact]).to_string()).is_err());
            assert_eq!(stands(&core,1),before,"{key} must not remove the standing actor");
        }
        let game = core.game.as_ref().unwrap();
        assert_eq!((core.bodies.len(), game.actors.len(), game.damage.plates.len(), game.damage.modules.len(), game.bindings.len(), game.module_exports.len()), (1, 1, 2, 4, 6, 4));
        assert!((60..90).all(|owner| game.damage.plate(owner).is_none() && game.damage.module(owner).is_none() && game.geometry.bounds(owner).is_none()));
        assert_eq!(stands(&core, 1), before);
        advance(&mut core, 30);
    }
    #[test]
    fn the_sensors_read_by_rays_that_go_by_the_groups_of_where_the_parts_stand() {
        let mut core = field(&[cart(1, "first", 10, 0.0), cart(2, "second", 20, 30.0)]);
        advance(&mut core, 3);
        // A part was put elsewhere since the rays of the step were grouped: the groups are of where it was.
        {
            let game = core.game.as_mut().unwrap();
            let moved = crate::game_geometry::EntityGeometry::from_plate(game.damage.plate(10).unwrap());
            game.geometry.upsert(10, moved);
            assert!(!game.geometry.grouped());
        }
        // A reading of the sensors groups them again before it casts a ray, and reads what it read without them.
        let read = command(&mut core, json!({"op":"teamSight"}));
        assert!(core.game.as_ref().unwrap().geometry.grouped());
        let mut plain = field(&[cart(1, "first", 10, 0.0), cart(2, "second", 20, 30.0)]);
        advance(&mut plain, 3);
        assert_eq!(command(&mut plain, json!({"op":"teamSight"})), read);
    }
}
