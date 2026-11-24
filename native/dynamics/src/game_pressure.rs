//! Instantaneous blast damage. No gas cells, waves, pressure clock or continuous forces.
use crate::game_geometry::ComponentKind;
use crate::game_damage::{
    DamageState, Effects, Impulse, Plate, Point, Span, add, cross, dot, length,
    merge_spans, point, scale, sub, unit,
};
use crate::game_geometry::{Bounds, Geometry, RayOptions, Terrain, sqrt};
use crate::game_projectiles::{Blast, FRAGMENT_FLIGHT, ProjectileState, RayBudget, SECONDARY_ENERGY_PER_POWER};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::json;
use std::collections::BTreeMap;

const MECHANICAL_FRACTION: f64 = 0.10;
const FACE_OFFSET: f64 = 0.0001;
/// A blast throws its fragments at what stands within this many radii of it.
pub const FRAGMENT_AIM: f64 = 4.0;
/// How far from where it goes off a blast harms anything: as far as its radius, and its fragments past it, as far as
/// they fly at what stands within `FRAGMENT_AIM` radii.
pub fn reach(radius: f64) -> f64 {
    thrown(radius, 1.0)
}
/// How far a shell's blast and fragments harm anything (`reach`), its fragments flying as many more radii as its case
/// makes them (`fragments`, 1 of a shell as its reference makes it; game_variant.rs `made`).
pub fn thrown(radius: f64, fragments: f64) -> f64 {
    radius.max((radius * FRAGMENT_AIM * fragments).min(FRAGMENT_FLIGHT))
}

#[derive(Clone, Debug)]
enum Target {
    PlateDamage {
        owner: u32,
        point: Point,
        normal: Point,
        dose: f64,
        surface_only: bool,
    },
    Impulse {
        owner: u32,
        point: Point,
        impulse: Point,
    },
    Module {
        owner: u32,
        point: Point,
        damage: f64,
    },
}
fn falloff(distance: f64, radius: f64) -> f64 {
    if radius <= 0.0 {
        return 0.0;
    }
    let f = (1.0 - distance / radius).max(0.0);
    f * sqrt(f)
}
// Direct damage keeps its authored radius. The outward mechanical tail uses
// the existing total reach and dissipates smoothly without adding energy.
fn impulse_falloff(distance: f64, radius: f64) -> f64 {
    if radius <= 0.0 {
        return 0.0;
    }
    let spread = radius / (radius + distance);
    falloff(distance, reach(radius)) * spread * spread
}
fn closest(p: Point, a: Point, b: Point) -> (Point, f64) {
    let d = sub(b, a);
    let t = (dot(sub(p, a), d) / dot(d, d).max(1e-30)).clamp(0.0, 1.0);
    (a.lerp(b, t), t)
}
/// What of a blast at `start` reaches `end` past what stands between: all of it in the open. Whosever it is, what
/// stands between covers what is behind it.
pub fn exposure(intangible: &[u32],
    start: Point,
    end: Point,
    ignore: Option<u32>,
    damage: &DamageState,
    geometry: &Geometry,
    terrain: &Terrain,
) -> f64 {
    if terrain.raycast(start, end).is_some_and(|h| h.enter < 0.98) {
        return 0.0;
    }
    let near = add(start, scale(unit(sub(end, start)), 0.0001));
    let hits = geometry.raycast_layers(
        near,
        end,
        &RayOptions { ignore_actors: intangible,
            ignore_ids: ignore.as_slice(),
            complete_exit: true,
            ..RayOptions::default()
        },
    );
    let mut transmission = 1.0;
    for hit in hits.iter().take(12) {
        if hit.enter >= 0.98 {
            break;
        }
        let t = if let Some(module) = damage.module(hit.owner) {
            // Explosive cover uses a normal sheet incidence, matching the damage
            // model's blast attenuation rather than projectile ricochet rules.
            ComplexField::exp(-module.chord_resistance(hit.point, hit.exit_point, hit.depth, 1.0) / 18.0)
                .clamp(0.003, 0.9)
        } else if let Some(plate) = damage.plate(hit.owner) {
            ComplexField::exp(
                -hit.depth.max(0.0) * 1000.0 * plate.material.blast * plate.material_scale
                    / 18.0,
            )
            .clamp(0.003, 0.85)
        } else {
            0.85
        };
        transmission *= t;
        if transmission < 0.0001 {
            return 0.0;
        }
    }
    transmission
}
fn bounds_near(bounds: Bounds, p: Point, radius: f64) -> bool {
    length(point(
        (bounds.min_x - p.x).max(p.x - bounds.max_x).max(0.0),
        (bounds.min_y - p.y).max(p.y - bounds.max_y).max(0.0),
    )) <= radius
}
fn face_spans(plate: &Plate, a: Point, b: Point) -> Vec<Span> {
    let (a, b) = (plate.pose.local_point(a), plate.pose.local_point(b));
    let d = sub(b, a);
    let along_x = d.x.abs() >= d.y.abs();
    let n = if along_x {
        plate.grid.nx
    } else {
        plate.grid.ny
    };
    let other = if along_x {
        plate.grid.ny
    } else {
        plate.grid.nx
    };
    let origin = if along_x { a.x } else { a.y };
    let delta = if along_x { d.x } else { d.y };
    if delta.abs() < 1e-15 {
        return Vec::new();
    }
    let lo = if along_x {
        plate.grid.bounds.min_x
    } else {
        plate.grid.bounds.min_y
    };
    let hi = if along_x {
        plate.grid.bounds.max_x
    } else {
        plate.grid.bounds.max_y
    };
    let mut spans = Vec::new();
    for i in 0..n {
        if !(0..other).any(|j| {
            if along_x {
                plate.grid.occupied(i, j)
            } else {
                plate.grid.occupied(j, i)
            }
        }) {
            continue;
        }
        let first = (lo + (hi - lo) * i as f64 / n as f64 - origin) / delta;
        let last = (lo + (hi - lo) * (i + 1) as f64 / n as f64 - origin) / delta;
        let (lo, hi) = (first.min(last).max(0.0), first.max(last).min(1.0));
        if hi > lo + 1e-12 {
            spans.push(Span { lo, hi });
        }
    }
    merge_spans(spans)
}
// Search only this plate along the inward normal. DDA visits at most
// nx+ny+2 cells per BASE triangle; no full-grid or other-owner scan is needed.
fn material_face(plate: &Plate, geometry: &Geometry, at: Point, normal: Point) -> Option<Point> {
    geometry
        .raycast_owner(
            plate.owner,
            add(at, scale(normal, FACE_OFFSET)),
            sub(at, scale(normal, plate.radius * 2.0 + 0.01)),
        )
        .map(|hit| hit.point)
}
// Another piece may occupy a face even when a radial ray only touches their shared corner.
// Check immediately outside the actual face; distant cover still attenuates through exposure.
fn uncovered_face(intangible: &[u32], plate: &Plate, geometry: &Geometry, at: Point, normal: Point) -> bool {
    let outside = add(at, scale(normal, FACE_OFFSET));
    geometry.raycast(outside, outside, &RayOptions { ignore_actors: intangible,
        ignore_ids: &[plate.owner], ..RayOptions::default()
    }).is_none()
}
// Restrict superficial erosion to a finite normal depth. Its tangential
// radius does not widen that depth; whole-cell quantization is handled below.
fn surface_band(plate: &Plate, face: Point, into: Point, depth: f64, radius: f64) -> Bounds {
    let tangent = point(-into.y, into.x);
    let a = sub(face, scale(tangent, radius));
    let b = add(face, scale(tangent, radius));
    Bounds::points(&[
        plate.pose.local_point(a),
        plate.pose.local_point(b),
        plate.pose.local_point(add(a, scale(into, depth))),
        plate.pose.local_point(add(b, scale(into, depth))),
    ])
}
fn on_face(a: Point, b: Point, spans: &[Span], t: f64) -> Point {
    let hit = spans
        .iter()
        .map(|s| t.clamp(s.lo, s.hi))
        .min_by(|a, b| (a - t).abs().total_cmp(&(b - t).abs()))
        .unwrap_or(t);
    a.lerp(b, hit)
}
fn nearest_perimeter(center: Point, outlines: &[Vec<Point>]) -> Option<Point> {
    outlines
        .iter()
        .flat_map(|poly| {
            (0..poly.len()).map(move |i| closest(center, poly[i], poly[(i + 1) % poly.len()]).0)
        })
        .min_by(|a, b| a.distance(center).total_cmp(&b.distance(center)))
}
fn module_blast_damage(kind: ComponentKind, dose: f64) -> f64 {
    dose.max(0.0)
        * match kind {
            ComponentKind::Track => 0.95,
            ComponentKind::Wheel => 1.15,
            ComponentKind::Engine => 0.85,
            ComponentKind::Weapon => 0.95,
            ComponentKind::Fuel | ComponentKind::Ammo => 1.1,
            _ => 1.0,
        }
}
#[derive(Clone, Copy)]
struct PlateResponse {
    ratio: f64,
    radius: f64,
    perforate: bool,
    depth: f64,
    strength: f64,
    significant: bool,
}
fn plate_response(plate: &Plate, dose: f64, thickness: f64) -> PlateResponse {
    let capacity = (thickness * 1000.0).max(8.0)
        * plate.material.blast
        * if plate.material.brittle { 2.2 } else { 3.2 };
    let ratio = dose.max(0.0) / capacity;
    PlateResponse {
        ratio,
        radius: (sqrt(dose.max(0.0)) * 0.0075).clamp(0.025, 0.22),
        perforate: ratio > 2.2,
        depth: (thickness * 0.3).min(dose / (plate.material.blast * 6500.0)),
        strength: ratio.clamp(0.0, 1.0),
        significant: dose > if plate.material.brittle { 35.0 } else { 25.0 },
    }
}
/// What a blast harms and pushes: every plate and piece within its reach but those of the constructions it spares
/// (`spared`), which cover what is behind them all the same.
fn targets(intangible: &[u32],
    blast: &Blast,
    spared: &[u32],
    damage: &mut DamageState,
    geometry: &Geometry,
    terrain: &Terrain,
) -> Vec<Target> {
    let (center, power, radius) = (blast.point, blast.power, blast.radius);
    let wave_radius = reach(radius);
    let reach = (sqrt(power) * 0.025).clamp(0.15, 0.55);
    // What of the blast reaches `p` on the part `owner`: all of it on the part it went off in.
    let open = |owner: u32, p: Point| {
        if Some(owner) == blast.source {
            1.0
        } else {
            exposure(intangible, center, p, Some(owner), damage, geometry, terrain)
        }
    };
    let mut targets = Vec::new();
    let mut burns = Vec::new();
    for plate in &damage.plates {
        if plate.properties.area <= 0.0
            || spared.contains(&plate.actor)
            || intangible.contains(&plate.actor)
            || geometry
                .bounds(plate.owner)
                .is_none_or(|b| !bounds_near(b, center, wave_radius))
        {
            continue;
        }
        let corners = [
            point(-plate.length / 2.0, -plate.thickness / 2.0),
            point(plate.length / 2.0, -plate.thickness / 2.0),
            point(plate.length / 2.0, plate.thickness / 2.0),
            point(-plate.length / 2.0, plate.thickness / 2.0),
        ]
        .map(|p| plate.pose.world_point(p));
        let mut candidates = Vec::new();
        let mut loaded = None;
        let mut strongest = 0.0;
        for i in 0..4 {
            let (a, b) = (corners[i], corners[(i + 1) % 4]);
            let d = sub(b, a);
            let len = length(d);
            let spans = face_spans(plate, a, b);
            if spans.is_empty() || len < 1e-8 {
                continue;
            }
            let normal = point(d.y / len, -d.x / len);
            let nearest = on_face(a, b, &spans, closest(center, a, b).1);
            if dot(sub(nearest, center), normal) > 0.0001 {
                continue;
            }
            let contact = closest(nearest, a, b).1;
            // Erosion and rear flakes model loading through sheet thickness.
            // An end loads the body below, but is not a thin sheet along its length.
            let offsets: &[f64] = if i % 2 == 1 || geometry.bounds(plate.owner).is_none_or(|b| !bounds_near(b, center, radius)) {
                &[]
            } else if power >= 240.0 {
                &[0.0, -reach * 0.7, reach * 0.7]
            } else {
                &[0.0]
            };
            for offset in offsets {
                let base_point = on_face(a, b, &spans, contact + offset / len);
                let Some(p) = material_face(plate, geometry, base_point, normal) else {
                    continue;
                };
                if !uncovered_face(intangible, plate, geometry, p, normal) { continue; }
                let distance = p.distance(center);
                let weight = falloff(distance, radius);
                if weight == 0.0 {
                    continue;
                }
                let dose = power * weight * open(plate.owner, p);
                if dose > 0.0 {
                    candidates.push(Target::PlateDamage {
                        owner: plate.owner,
                        point: p,
                        normal,

                        dose,
                        surface_only: false,
                    });
                }
            }
            let coverage = spans.iter().map(|s| s.hi - s.lo).sum::<f64>();
            let centroid = spans
                .iter()
                .map(|s| (s.hi - s.lo) * (s.lo + s.hi) * 0.5)
                .sum::<f64>()
                / coverage;
            let p = a.lerp(b, centroid);
            if !uncovered_face(intangible, plate, geometry, p, normal) { continue; }
            let distance = p.distance(center);
            // A contact fuze may detonate exactly on the exterior face. The
            // limiting inward load uses the face normal, not a zero-length
            // or tangent ray from that coincident surface source.
            let on_surface = closest(center, a, b).0.distance(center) <= 1e-9;
            let incidence = if on_surface {
                1.0
            } else {
                (-dot(normal, sub(p, center)) / distance.max(1e-15)).max(0.0)
            };
            if distance >= wave_radius || incidence < 0.03 {
                continue;
            }
            let impulse = power
                * 8.0
                * len
                * coverage
                * incidence
                * impulse_falloff(distance, radius)
                * open(plate.owner, on_face(a, b, &spans, centroid));
            targets.push(Target::Impulse {
                owner: plate.owner,
                point: p,

                impulse: scale(normal, -impulse),
            });
            if distance < radius && impulse > strongest {
                strongest = impulse;
                loaded = Some(p);
            }
        }
        candidates.sort_by(|a, b| {
            let dose = |t: &Target| {
                if let Target::PlateDamage { dose, .. } = t {
                    *dose
                } else {
                    0.0
                }
            };
            dose(b).total_cmp(&dose(a))
        });
        let mut selected: Vec<Point> = Vec::new();
        if let Some(Target::PlateDamage {
            point: focal, dose, ..
        }) = candidates.first()
        {
            let focal = *focal;
            let spacing = (plate_response(plate, *dose, plate.thickness).radius * 1.25).max(0.10);
            for mut candidate in candidates {
                let Target::PlateDamage {
                    point: p,
                    surface_only,
                    dose,
                    ..
                } = &mut candidate
                else {
                    continue;
                };
                if selected.len() >= if power >= 240.0 { 3 } else { 1 } {
                    break;
                }
                if p.distance(focal) > reach || selected.iter().any(|q| q.distance(*p) < spacing) {
                    continue;
                }
                *surface_only = !selected.is_empty();
                if *surface_only {
                    *dose *= 0.65;
                }
                selected.push(*p);
                targets.push(candidate);
            }
        }
        if let Some(p) = loaded {
            burns.push((plate.owner, p, (power / 500.0).min(1.0)));
        }
    }
    for module in damage.modules.iter().filter(|m| m.attached && !spared.contains(&m.actor) && !intangible.contains(&m.actor)) {
        if geometry.bounds(module.owner).is_some_and(|b| !bounds_near(b, center, wave_radius)) {
            continue;
        }
        let outlines = if let Some(shapes) = geometry.shapes_world(module.owner) {
            std::borrow::Cow::Borrowed(shapes)
        } else {
            std::borrow::Cow::Owned(module.world_polygons())
        };
        let mut bounds = Bounds::empty();
        for polygon in outlines.iter() {
            for p in polygon {
                bounds.include(*p);
            }
        }
        if !bounds_near(bounds, center, wave_radius) {
            continue;
        }
        let mut samples = Vec::new();
        if let Some(p) = nearest_perimeter(center, &outlines) {
            samples.push(p);
        }
        for poly in outlines.iter() {
            for i in 0..4 {
                if !poly.is_empty() {
                    samples.push(poly[i * poly.len() / 4]);
                }
            }
        }
        let mut best: Option<(Point, f64, f64)> = None;
        let mut strongest: Option<(Point, f64)> = None;
        for p in samples {
            let distance = p.distance(center);
            let weight = falloff(distance, radius);
            let wave_weight = impulse_falloff(distance, radius);
            if weight == 0.0 && wave_weight == 0.0 {
                continue;
            }
            let transmission = open(module.owner, p);
            let dose = power * weight * transmission;
            if dose > 0.0 && best.is_none_or(|b| dose > b.2) {
                best = Some((p, distance, dose));
            }
            let load = module_blast_damage(module.kind, power * wave_weight * transmission) * 4.0;
            if load > 0.0 && strongest.is_none_or(|(_, old)| load > old) {
                strongest = Some((p, load));
            }
        }
        if let Some((p, _distance, dose)) = best {
            targets.push(Target::Module {
                owner: module.owner,
                point: p,

                damage: module_blast_damage(module.kind, dose),
            });
        }
        if let Some((p, load)) = strongest {
            let radial = sub(p, center);
            let direction = if length(radial) > 1e-9 {
                unit(radial)
            } else {
                unit(sub(point(module.pose.x, module.pose.y), center))
            };
            targets.push(Target::Impulse { owner: module.owner, point: p, impulse: scale(direction, load) });
        }
    }
    for (owner, p, strength) in burns {
        if let Some(plate) = damage.plate_mut(owner) {
            plate.mark(p, "burn", strength);
        }
    }
    targets
}
/// One representative internal spall direction. The explosion chooses at most
/// three such rays, sharing its finite secondary budget with external fragments.
#[derive(Clone, Copy)]
pub struct InternalBurst {
    pub owner: u32,
    pub actor: u32,
    pub origin: Point,
    pub direction: Point,
    pub power: f64,
}
pub fn blast_plate(
    owner: u32,
    mut at: Point,
    normal: Point,
    dose: f64,
    surface_only: bool,
    damage: &mut DamageState,
    geometry: &mut Geometry,
    effects: &mut Effects,
) -> Option<InternalBurst> {
    let Some(plate) = damage.plate(owner) else {
        return None;
    };
    if plate.properties.area <= 0.0 {
        return None;
    }
    let actor = plate.actor;
    let mut burst = None;
    // A missing outer row is an erosion crater, not an invulnerable absence
    // of a BASE face. Find the actual first occupied surface in this column.
    let Some(surface) = material_face(plate, geometry, at, normal) else {
        return None;
    };
    at = surface;
    let response = plate_response(plate, dose, plate.thickness * plate.resistance_scale(at));
    if !response.significant {
        return None;
    }
    let (thickness, brittle) = (plate.thickness, plate.material.brittle);
    let inward = scale(normal, -1.0);
    if !brittle {
        if let Some(plate) = damage.plate_mut(owner) {
            plate.plastic_impression(
                at,
                inward,
                response.strength,
                dose,
                response.radius / 3.0,
                normal,
                Some(response.radius),
                0.26,
                5.0,
            );
            plate.mark(at, "dent", (dose / 300.0).min(1.0));
        }
    }
    let strength = ((response.ratio - if brittle { 1.0 } else { 1.25 }) / 0.8).clamp(0.0, 1.0);
    let rear = !surface_only && strength > 0.0 && !response.perforate && thickness >= 0.012;
    let mut through_exit = None;
    if rear || (response.perforate && !surface_only) {
        let hit = geometry.raycast_owner(
            owner,
            add(at, scale(normal, 0.06)),
            add(at, scale(inward, thickness + 0.15)),
        );
        if let Some(hit) = hit.filter(|h| h.owner == owner) {
            if response.perforate {
                through_exit = Some(hit.exit_point);
            }
            let depth = (thickness * 0.065).min(0.012);
            if rear && hit.depth > depth * 3.0 && hit.depth > thickness * 0.6 {
                let r = (response.radius * 0.35).clamp(0.025, 0.075);
                // Tangential flake radius must not become normal depth.
                // A conservative whole-cell band can exceed `depth` only by
                // one thickness row, while the front wall stays material.
                let limit = surface_band(
                    damage.plate(owner).unwrap(),
                    hit.exit_point,
                    scale(inward, -1.0),
                    depth,
                    r,
                );
                let removed = damage.cut_clipped(
                    owner,
                    sub(hit.exit_point, scale(inward, depth)),
                    add(hit.exit_point, scale(inward, 0.015)),
                    r,
                    Some(limit),
                    effects,
                );
                if !removed.is_empty() {
                    burst = Some(InternalBurst {
                        owner,
                        actor,
                        origin: add(hit.exit_point, scale(inward, 0.004)),
                        direction: inward,
                        power: dose * 0.04 * strength,
                    });
                    damage.stats.spall_bursts += 1;
                    if let Some(p) = damage.plate_mut(owner) {
                        geometry.set_grid(owner, &p.grid);
                        p.mark(
                            hit.exit_point,
                            if brittle { "crack" } else { "dent" },
                            response.strength,
                        );
                    }
                    effects.event(json!({"type":"spall","owner":owner,"x":hit.exit_point.x,"y":hit.exit_point.y,"nx":inward.x,"ny":inward.y,"power":dose*0.04*strength}));
                }
            }
        }
    }
    if brittle || (response.perforate && !surface_only) {
        let depth = if response.perforate && !surface_only {
            thickness * 1.2
        } else {
            response.depth
        };
        let clip = if response.perforate && !surface_only {
            None // A true perforation intentionally crosses the full thickness.
        } else {
            Some(surface_band(
                damage.plate(owner).unwrap(),
                at,
                inward,
                depth,
                response.radius,
            ))
        };
        let removed = damage.cut_clipped(
            owner,
            add(at, scale(normal, response.radius * 0.2)),
            sub(at, scale(normal, depth)),
            response.radius,
            clip,
            effects,
        );
        if !removed.is_empty() {
            if let Some(exit) = through_exit {
                burst = Some(InternalBurst {
                    owner,
                    actor,
                    origin: add(exit, scale(inward, 0.004)),
                    direction: inward,
                    power: dose * 0.04,
                });
            }
            if let Some(p) = damage.plate_mut(owner) {
                geometry.set_grid(owner, &p.grid);
                p.mark(at, if brittle { "crack" } else { "hole" }, dose / 300.0);
            }
        }
    }
    burst
}

#[derive(Clone, Copy, Debug)]
pub struct BlastBody {
    pub mass: f64,
    pub inertia: f64,
    pub center: Point,
    pub velocity: Point,
    pub omega: f64,
}

#[derive(Default)]
struct Load {
    owner: u32,
    mass: f64,
    center: Point,
    inertia: f64,
    impulse: Point,
    torque: f64,
    velocity: Point,
    omega: f64,
    footprint: Vec<Point>,
}
fn loads<F: Fn(u32) -> Option<BlastBody>>(
    damage: &DamageState,
    source: Option<u32>,
    carrier: &F,
) -> BTreeMap<u32, Load> {
    let mut result = BTreeMap::<u32, Load>::new();
    for p in damage.plates.iter().filter(|p| p.attached) {
        let load = result.entry(p.actor).or_default();
        load.owner = p.owner;
        load.footprint
            .extend(p.local_nodes.iter().map(|v| p.pose.world_point(*v)));
    }
    // What blows up is no part of the outline its blast may stand inside: a tank or a box within the hull sets it
    // off inside, one carried out in the open outside, where it pushes the construction as any other blast does.
    for m in damage.modules.iter().filter(|m| m.attached) {
        let load = result.entry(m.actor).or_default();
        load.owner = m.owner;
        if Some(m.owner) != source {
            load.footprint
                .extend(m.world_polygons().into_iter().flatten());
        }
    }
    // The carrier is the sole physical authority. An actor without plates may
    // still be moving; reconstructing motion or inertia from hitboxes would
    // silently omit its existing kinetic energy from the explosion budget.
    result.retain(|actor, load| {
        let Some(body) = carrier(*actor) else {
            return false;
        };
        if body.mass <= 0.0
            || body.inertia <= 0.0
            || ![
                body.mass,
                body.inertia,
                body.center.x,
                body.center.y,
                body.velocity.x,
                body.velocity.y,
                body.omega,
            ]
            .iter()
            .all(|v| v.is_finite())
        {
            return false;
        }
        load.mass = body.mass;
        load.inertia = body.inertia;
        load.center = body.center;
        load.velocity = body.velocity;
        load.omega = body.omega;
        true
    });
    result
}
fn hull_contains(points: &mut Vec<Point>, p: Point) -> bool {
    points.sort_by(|a, b| a.x.total_cmp(&b.x).then(a.y.total_cmp(&b.y)));
    points.dedup();
    if points.len() < 3 {
        return false;
    }
    let mut hull = Vec::<Point>::with_capacity(points.len() * 2);
    for q in points.iter() {
        while hull.len() >= 2
            && cross(
                sub(hull[hull.len() - 1], hull[hull.len() - 2]),
                sub(*q, hull[hull.len() - 1]),
            ) <= 0.0
        {
            hull.pop();
        }
        hull.push(*q);
    }
    let lower = hull.len();
    for q in points.iter().rev().skip(1) {
        while hull.len() > lower
            && cross(
                sub(hull[hull.len() - 1], hull[hull.len() - 2]),
                sub(*q, hull[hull.len() - 1]),
            ) <= 0.0
        {
            hull.pop();
        }
        hull.push(*q);
    }
    hull.pop();
    // Surface/corner detonations are exterior loads. A one-nanometre margin
    // keeps this distinction covariant under ordinary pose roundoff.
    (0..hull.len()).all(|i| {
        let a = hull[i];
        let edge = sub(hull[(i + 1) % hull.len()], a);
        cross(edge, sub(p, a)) > 1e-9 * length(edge)
    })
}
fn finish_impulses(
    blast: &Blast,
    damage: &DamageState,
    loads: &mut BTreeMap<u32, Load>,
    begin: usize,
    budget: f64,
    effects: &mut Effects,
) {
    for impulse in effects.impulses.drain(begin..) {
        let actor = damage
            .plate(impulse.owner)
            .map(|p| p.actor)
            .or_else(|| damage.module(impulse.owner).map(|m| m.actor));
        let Some(load) = actor.and_then(|a| loads.get_mut(&a)) else {
            continue;
        };
        load.impulse = add(load.impulse, impulse.impulse);
        load.torque += cross(sub(impulse.point, load.center), impulse.impulse);
    }
    let mut energy = 0.0;
    let mut positive_work = 0.0;
    for load in loads.values_mut() {
        if load.impulse.x == 0.0 && load.impulse.y == 0.0 && load.torque == 0.0 {
            continue;
        }
        // A source inside its own rigid assembly cannot propel that assembly
        // by selecting an arbitrary internal face. Damage still applies.
        if hull_contains(&mut load.footprint, blast.point) {
            load.impulse = Point::ZERO;
            load.torque = 0.0;
        }
        energy += dot(load.impulse, load.impulse) / (2.0 * load.mass.max(1e-12))
            + load.torque * load.torque / (2.0 * load.inertia.max(1e-12));
        positive_work += (dot(load.velocity, load.impulse) + load.omega * load.torque).max(0.0);
    }
    // Include existing motion: limiting delta-v alone does not bound the
    // kinetic energy gained by a vehicle already travelling with the blast.
    let factor = if energy + positive_work > budget {
        2.0 * budget.max(0.0)
            / (sqrt(positive_work * positive_work + 4.0 * energy * budget.max(0.0)) + positive_work)
                .max(1e-30)
    } else {
        1.0
    };
    for load in loads.values() {
        let square = dot(load.impulse, load.impulse);
        if square <= 1e-20 || load.mass <= 0.0 {
            continue;
        }
        let offset = scale(point(load.impulse.y, -load.impulse.x), load.torque / square);
        effects.impulses.push(Impulse {
            owner: load.owner,
            point: add(load.center, offset),
            impulse: scale(load.impulse, factor),
        });
    }
}
/// A blast and all it does at once: what it harms and pushes, and the fragments it throws. It harms and pushes none
/// of the constructions it spares (`spared`, `Sides::allies`), and its fragments harm none of them; their plates and
/// pieces cover what is behind them, from the blast and from its fragments, as anyone's do.
pub fn explode<F: Fn(u32) -> Option<BlastBody>>(
    intangible: &[u32],
    blast: Blast,
    spared: &[u32],
    time: f64,
    damage: &mut DamageState,
    geometry: &mut Geometry,
    terrain: &Terrain,
    projectiles: &mut ProjectileState,
    effects: &mut Effects,
    carrier: &F,
) {
    if !blast.power.is_finite()
        || !blast.radius.is_finite()
        || blast.power <= 0.0
        || blast.radius <= 0.0
    {
        return;
    }
    // Impact fuzes retain their exact within-step detonation time; manual
    // and reserve explosions use the authoritative caller clock.
    let time = blast.details["time"]
        .as_f64()
        .filter(|t| t.is_finite())
        .unwrap_or(time);
    let begin = effects.impulses.len();
    let mut bursts = Vec::new();
    let mut loads = loads(damage, blast.source, carrier);
    let targets = targets(intangible, &blast, spared, damage, geometry, terrain);
    for target in targets {
        match target {
            Target::PlateDamage {
                owner,
                point,
                normal,
                dose,
                surface_only,
            } => {
                if let Some(burst) = blast_plate(
                    owner,
                    point,
                    normal,
                    dose,
                    surface_only,
                    damage,
                    geometry,
                    effects,
                ) {
                    bursts.push(burst);
                }
            }
            Target::Impulse {
                owner,
                point,
                impulse,
            } => effects.impulse(owner, point, impulse),
            Target::Module {
                owner,
                point,
                damage: amount,
            } => {
                damage.damage_module(owner, amount, point, effects);
            }
        }
    }
    damage.stats.explosions += 1;
    if effects.visual_events {
        let mut event = blast.details.clone();
        if !event.is_object() {
            event = json!({});
        }
        event["type"] = json!("explosion");
        event["time"] = json!(time);
        event["x"] = json!(blast.point.x);
        event["y"] = json!(blast.point.y);
        event["power"] = json!(blast.power);
        event["radius"] = json!(blast.radius);
        event["source"] = if blast.details["ground"] == true {
            json!("ground")
        } else {
            json!(blast.source)
        };
        event["sourceOwner"] = json!(blast.source);
        event["actor"] = json!(blast.actor);
        effects.events.push(event);
    }
    let budget = blast.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION;
    // Half of it goes into fragments, and they fly `FRAGMENT_AIM` radii: of a shell made otherwise than its reference's,
    // the share and the reach its case gives them (game_variant.rs `made`).
    let (share, reach) = blast.details["fragments"].as_f64().zip(blast.details["fragmentReach"].as_f64())
        .filter(|(share, reach)| share.is_finite() && reach.is_finite())
        .map_or((0.5, 1.0), |(share, reach)| (share.clamp(0.05, 0.95), reach.clamp(0.1, 4.0)));
    let aim = blast.radius * FRAGMENT_AIM * reach;
    let ray_budget = budget * share;
    // Three internal directions at most, chosen by actual material response.
    // No persistent fragment list and no work proportional to earlier shots.
    bursts.sort_by(|a, b| b.power.total_cmp(&a.power).then(a.owner.cmp(&b.owner)));
    bursts.truncate(3);
    let internal_budget = if bursts.is_empty() {
        0.0
    } else {
        ray_budget * 0.5
    };
    let sum_power = bursts.iter().map(|b| b.power).sum::<f64>();
    for burst in &bursts {
        projectiles.trace_damage_ray(intangible,
            burst.origin,
            burst.direction,
            RayBudget::blast(internal_budget * burst.power / sum_power.max(1e-15)),
            FRAGMENT_FLIGHT,
            Some(burst.owner),
            Some(burst.actor),
            &[],
            damage,
            geometry,
            terrain,
            effects,
            time,
        );
    }
    // Three radial quadrature rays represent the external fragment cloud.
    // Sampling measured physical outlines preserves reflection/rotation
    // covariance instead of a world-axis-biased random spray.
    let mut radial = BTreeMap::<u32, Point>::new();
    for m in &damage.modules {
        if m.attached && !spared.contains(&m.actor) && !intangible.contains(&m.actor) {
            if geometry.bounds(m.owner).is_some_and(|b| !bounds_near(b, blast.point, aim)) {
                continue;
            }
            let p = nearest_perimeter(blast.point, &m.world_polygons())
                .unwrap_or(point(m.pose.x, m.pose.y));
            if p.distance(blast.point) <= aim
                && radial
                    .get(&m.actor)
                    .is_none_or(|old| p.distance(blast.point) < old.distance(blast.point))
            {
                radial.insert(m.actor, p);
            }
        }
    }
    for p in &damage.plates {
        if p.attached && !spared.contains(&p.actor) && !intangible.contains(&p.actor) {
            let world: Vec<_> = p
                .local_nodes
                .iter()
                .map(|v| p.pose.world_point(*v))
                .collect();
            if let Some(at) = nearest_perimeter(blast.point, &[world]) {
                if at.distance(blast.point) <= aim
                    && radial
                        .get(&p.actor)
                        .is_none_or(|old| at.distance(blast.point) < old.distance(blast.point))
                {
                    radial.insert(p.actor, at);
                }
            }
        }
    }
    let mut radial: Vec<_> = radial.into_iter().collect();
    radial.sort_by(|a, b| {
        a.1.distance(blast.point)
            .total_cmp(&b.1.distance(blast.point))
            .then(a.0.cmp(&b.0))
    });
    radial.truncate(3);
    let external_budget = ray_budget - internal_budget;
    if !radial.is_empty() {
        for i in 0..3 {
            let (_, at) = radial[i % radial.len()];
            let direction = unit(sub(at, blast.point));
            projectiles.trace_damage_ray(intangible,
                add(blast.point, scale(direction, 0.0001)),
                direction,
                RayBudget::blast(external_budget / 3.0),
                (aim.min(FRAGMENT_FLIGHT) - 0.0001).max(0.0),
                blast.source,
                None,
                spared,
                damage,
                geometry,
                terrain,
                effects,
                time,
            );
        }
    }
    finish_impulses(
        &blast,
        damage,
        &mut loads,
        begin,
        budget - ray_budget,
        effects,
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game_geometry::EntityKind;
    use crate::game_geometry::{cos, sin};

    fn module_fixture(x: f64) -> (DamageState, Geometry) {
        let value = json!({"kind":"engine","x":x,"y":3,"width":1,"height":1,
            "physicalMass":1000,"health":10000,"maxHealth":10000});
        let mut damage = DamageState::default();
        damage.insert_module(crate::game_damage::fixtures::module(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Module, &value).unwrap(),
        );
        (damage, geometry)
    }
    fn blast(x: f64) -> Blast {
        Blast {
            point: point(x, 3.0),
            power: 400.0,
            radius: 4.0,
            source: None,
            actor: None,
            details: json!({}),
        }
    }
    fn body(x: f64) -> BlastBody {
        BlastBody {
            mass: 1000.0,
            inertia: 1000.0 / 6.0,
            center: point(x, 3.0),
            velocity: Point::ZERO,
            omega: 0.0,
        }
    }
    fn cover(damage: &mut DamageState, geometry: &mut Geometry) {
        let value = json!({"length":4,"thicknessMm":10,"material":"steel",
            "x":2,"y":3,"angle":std::f64::consts::FRAC_PI_2});
        damage.insert_plate(crate::game_damage::fixtures::plate(2, 8, &value));
        geometry.upsert(2, crate::game_damage::fixtures::geometry(2, 8, EntityKind::Plate, &value).unwrap());
    }
    #[test]
    fn an_attached_plate_has_an_open_end_until_real_join_metal_covers_it() {
        let terrain = Terrain::new("flat").unwrap();
        let end_load = |attached: bool, joined: bool, intangible: &[u32]| {
            let value = json!({"length":2,"thicknessMm":400,"material":"steel","x":2,"y":3,
                "attached":attached,"anchors":[{"u":-0.4,"v":0},{"u":0.4,"v":0}]});
            let mut damage = DamageState::default();
            let plate = crate::game_damage::fixtures::plate(1, 7, &value);
            let mut geometry = Geometry::new();
            geometry.upsert(1, crate::game_geometry::EntityGeometry::from_plate(&plate));
            damage.insert_plate(plate);
            if joined {
                let wall = crate::game_damage::fixtures::plate(2, 8,
                    &json!({"length":2,"thicknessMm":400,"material":"steel","x":1,"y":3,
                        "angle":std::f64::consts::FRAC_PI_2}));
                geometry.upsert(2, crate::game_geometry::EntityGeometry::from_plate(&wall));
                damage.insert_plate(wall);
            }
            targets(intangible, &blast(0.0), &[], &mut damage, &geometry, &terrain).iter()
                .filter_map(|target| match target {
                    Target::Impulse { owner: 1, impulse, .. } => Some(*impulse),
                    _ => None,
                }).fold(Point::ZERO, add)
        };
        let open = end_load(true, false, &[]);
        assert!(open.x > 0.0 && open.y.abs() < 1e-12, "the exposed end takes an end-on load: {open:?}");
        assert_eq!(open, end_load(false, false, &[]), "attachment and authored anchors do not seal an open end cap");
        let covered = end_load(true, true, &[]);
        assert_eq!(covered, Point::ZERO, "the end inside real join metal is not an exposed face");
        assert_eq!(end_load(true, true, &[8]), open, "a touching whole wreck neither seals the face nor attenuates its load");
        assert_eq!(end_load(true, false, &[7]), Point::ZERO, "a whole wreck is not a pressure recipient");
    }
    #[test]
    fn authored_end_stock_takes_blast_load_unless_real_metal_covers_it() {
        let terrain = Terrain::new("flat").unwrap();
        let load = |anchors: bool, covered: bool| {
            // Nodes span [-1, 0] inside stock [-1, 1]: the last metre is an explicit end extension.
            let mut value = json!({"length":2,"thicknessMm":100,"material":"steel","x":0,"y":3});
            if anchors {value["anchors"]=json!([{"u":-0.5,"v":0},{"u":0.0,"v":0}]);}
            let plate = crate::game_damage::fixtures::plate(1, 7, &value);
            let mut geometry = Geometry::new();
            geometry.upsert(1, crate::game_geometry::EntityGeometry::from_plate(&plate));
            let mut damage = DamageState::default();
            damage.insert_plate(plate);
            if covered {
                let cover = crate::game_damage::fixtures::plate(2, 7,
                    &json!({"length":2,"thicknessMm":50,"material":"steel","x":0.8,"y":2.875}));
                geometry.upsert(2, crate::game_geometry::EntityGeometry::from_plate(&cover));
                damage.insert_plate(cover);
            }
            let mut charge = blast(0.8);
            charge.point.y = 2.8;
            charge.power = 100.0;
            charge.radius = 0.3;
            let selected = targets(&[], &charge, &[], &mut damage, &geometry, &terrain);
            let dose = selected.iter().filter_map(|target| match target {
                Target::PlateDamage {owner:1,dose,..} => Some(*dose), _ => None,
            }).fold(0.0_f64, f64::max);
            let impulse = selected.iter().filter_map(|target| match target {
                Target::Impulse {owner:1,impulse,..} => Some(*impulse), _ => None,
            }).fold(Point::ZERO, add);
            (dose, impulse)
        };
        let exposed = load(true, false);
        assert!(exposed.0 > 0.0 && exposed.1.y > 0.0, "the extension receives both damage and mechanical load: {exposed:?}");
        assert_eq!(exposed, load(false, false), "authoring anchors cannot shorten real metal");
        let covered = load(true, true);
        assert!(covered.0 < exposed.0 * 0.1 && covered.1.y < exposed.1.y * 0.1,
            "real neighbouring metal still shields the extension: exposed={exposed:?} covered={covered:?}");
    }
    #[test]
    fn a_buried_long_face_stays_protected_at_its_corner_and_a_real_hole_reopens_it() {
        let terrain = Terrain::new("flat").unwrap();
        let load = |covered: bool, hole: bool| {
            let plate = crate::game_damage::fixtures::plate(1, 7,
                &json!({"length":2,"thicknessMm":100,"material":"steel","x":0,"y":3}));
            let mut geometry = Geometry::new();
            geometry.upsert(1, crate::game_geometry::EntityGeometry::from_plate(&plate));
            let mut damage = DamageState::default();
            damage.insert_plate(plate);
            if covered {
                // The two pieces share a left edge, and this piece lies immediately over the floor's top face.
                let cover = crate::game_damage::fixtures::plate(2, 7,
                    &json!({"length":2,"thicknessMm":100,"material":"steel","x":0,"y":3.1}));
                geometry.upsert(2, crate::game_geometry::EntityGeometry::from_plate(&cover));
                damage.insert_plate(cover);
                if hole {
                    damage.cut(2, point(-1.0, 3.0), point(-1.0, 3.2), 0.05, &mut Effects::default());
                    geometry.set_grid(2, &damage.plate(2).unwrap().grid);
                }
            }
            let mut charge = blast(-1.15);
            charge.point.y = 3.5;
            charge.power = 100.0;
            charge.radius = 1.0;
            let selected = targets(&[], &charge, &[], &mut damage, &geometry, &terrain);
            let dose = selected.iter().filter_map(|target| match target {
                Target::PlateDamage {owner:1,dose,..} => Some(*dose), _ => None,
            }).fold(0.0_f64, f64::max);
            let vertical = selected.iter().filter_map(|target| match target {
                Target::Impulse {owner:1,impulse,..} => Some(impulse.y), _ => None,
            }).sum::<f64>();
            (dose, vertical)
        };
        let open = load(false, false);
        assert!(open.0 > 0.0 && open.1 < 0.0, "an exposed face takes damage and downward load: {open:?}");
        assert_eq!(load(true, false), (0.0, 0.0), "a shared corner does not expose the buried long face");
        assert!(load(true, true).0 > 0.0, "a real opening in the cover exposes the floor again");
    }
    #[test]
    fn a_weak_end_on_blast_does_not_treat_a_long_plate_as_its_sheet_thickness() {
        let value = json!({"length":3,"thicknessMm":5,"material":"steel","x":2.5,"y":3,
            "anchors":[{"u":-0.5,"v":0},{"u":0.5,"v":0}]});
        let plate = crate::game_damage::fixtures::plate(1, 7, &value);
        let mut geometry = Geometry::new();
        geometry.upsert(1, crate::game_geometry::EntityGeometry::from_plate(&plate));
        let mut damage = DamageState::default();
        damage.insert_plate(plate);
        let mut charge = blast(0.95);
        charge.power = 100.0;
        charge.radius = 0.25;
        let mut effects = Effects::new(true);
        explode(&[], charge, &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(2.5)));
        assert!(effects.impulses.iter().any(|load| load.impulse.x > 0.0), "the open end still loads its carrier");
        assert_eq!(damage.stats.spall_bursts, 0);
        assert!(!effects.events.iter().any(|event| event["type"] == "secondary-ray" && event["internal"] == true),
            "an end-on load must not create a through-thickness burst at the far end of the plate");
        let grid = &damage.plate(1).unwrap().grid;
        assert!((0..grid.ny).all(|y| grid.occupied(grid.nx - 1, y)), "the far end retains its actual material");
    }
    #[test]
    fn the_mechanical_tail_is_smooth_finite_and_distinct_from_the_damage_core() {
        let radius = 4.0;
        let outer = reach(radius);
        let mut previous = impulse_falloff(0.0, radius);
        assert_eq!(previous, 1.0);
        for step in 1..=240 {
            let distance = outer * step as f64 / 240.0;
            let next = impulse_falloff(distance, radius);
            assert!(next.is_finite() && next >= 0.0 && next <= previous);
            previous = next;
        }
        assert_eq!(falloff(radius, radius), 0.0);
        assert!(impulse_falloff(radius, radius) > 0.0);
        assert_eq!(impulse_falloff(outer, radius), 0.0);
        assert_eq!(impulse_falloff(outer + 1.0, radius), 0.0);
        assert!((impulse_falloff(radius - 1e-7, radius) - impulse_falloff(radius + 1e-7, radius)).abs() < 1e-7);
        assert!(impulse_falloff(outer - 1e-7, radius) < 1e-10);
    }
    #[test]
    fn an_outer_mechanical_tail_does_not_damage_or_trigger_protected_reserves() {
        for kind in ["fuel", "ammo"] {
            let value = json!({"kind":kind,"x":6,"y":3,"width":1,"height":1,
                "physicalMass":1000,"fuelLitres":10,"capacityLitres":100,"rounds":2,"capacityRounds":10});
            let mut damage = DamageState::default();
            let mut module = crate::game_damage::fixtures::module(1, 7, &value);
            // A zero-damage callback would ignite the fuel or detonate the ammo.
            module.health = module.max_health * 0.25;
            let health = module.health;
            damage.insert_module(module);
            let mut geometry = Geometry::new();
            geometry.upsert(1, crate::game_damage::fixtures::geometry(1, 7, EntityKind::Module, &value).unwrap());
            cover(&mut damage, &mut geometry);
            let mut b = blast(0.0);
            b.power = 25.0; // The cover stops the fragment rays without being perforated.
            let mut effects = Effects::default();
            explode(&[], b, &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
                &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(6.0)));
            assert_eq!(effects.impulses.len(), 1, "kind={kind}");
            assert!(effects.impulses[0].impulse.x > 0.0, "kind={kind}");
            let module = damage.module(1).unwrap();
            assert_eq!(module.health, health, "kind={kind}");
            assert!(!module.burning && !module.detonated, "kind={kind}");
            assert_eq!((module.fuel_litres, module.rounds), (10.0, 2));
            assert!(effects.detonations.is_empty());
        }
    }
    #[test]
    fn outer_impulses_decay_with_distance_and_accelerate_a_heavier_body_less() {
        let mut previous = f64::INFINITY;
        for x in [4.75, 6.5, 9.0, 12.6] {
            let mut changes = Vec::new();
            for mass in [1000.0, 2000.0] {
                let (mut damage, mut geometry) = module_fixture(x);
                let mut b = blast(0.0); b.power = 25.0;
                let mut effects = Effects::default();
                let mut carrier = body(x); carrier.mass = mass; carrier.inertia = mass / 6.0;
                explode(&[], b, &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
                    &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then_some(carrier));
                changes.push(effects.impulses.iter().map(|i| i.impulse.x).sum::<f64>() / mass);
            }
            if x < 12.0 {
                assert!(changes[0] > 0.0 && changes[1] > 0.0 && changes[1] < changes[0]);
                assert!(changes[0] < previous); previous = changes[0];
            } else {
                assert_eq!(changes, vec![0.0, 0.0]);
            }
        }
    }
    #[test]
    fn the_outer_wave_keeps_real_cover_apertures_and_spared_actors() {
        let evaluate = |shield: bool, aperture: bool, spared: &[u32]| {
            let (mut damage, mut geometry) = module_fixture(6.0);
            if shield {
                cover(&mut damage, &mut geometry);
                if aperture {
                    damage.cut(2, point(1.8, 3.0), point(2.2, 3.0), 0.06, &mut Effects::default());
                    geometry.set_grid(2, &damage.plate(2).unwrap().grid);
                }
            }
            let mut b = blast(0.0); b.power = 25.0;
            let mut effects = Effects::default();
            explode(&[], b, spared, 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
                &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(6.0)));
            effects.impulses.iter().map(|i| i.impulse.x).sum::<f64>()
        };
        let (open, covered) = (evaluate(false, false, &[]), evaluate(true, false, &[]));
        assert!(covered > 0.0 && covered < open);
        assert!((evaluate(true, true, &[]) - open).abs() < 1e-10);
        assert!((evaluate(true, false, &[8]) - covered).abs() < 1e-10, "a spared cover still shields");
        assert_eq!(evaluate(true, false, &[7]), 0.0, "the recipient is spared");
    }
    #[test]
    fn outer_work_and_fragment_energy_stay_within_the_same_budget() {
        let (mut damage, mut geometry) = module_fixture(6.0);
        let mut carrier = body(6.0); carrier.velocity = point(100.0, -1.0); carrier.omega = 20.0;
        let b = blast(0.0);
        let mut effects = Effects::new(true);
        explode(&[], b.clone(), &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then_some(carrier));
        let work = effects.impulses.iter().map(|i| {
            let torque = cross(sub(i.point, carrier.center), i.impulse);
            dot(carrier.velocity, i.impulse) + carrier.omega * torque
                + dot(i.impulse, i.impulse) / (2.0 * carrier.mass)
                + torque * torque / (2.0 * carrier.inertia)
        }).sum::<f64>();
        let rays = effects.events.iter().filter(|e| e["type"] == "secondary-ray")
            .map(|e| e["energyBudget"].as_f64().unwrap()).sum::<f64>();
        assert!(work > 0.0 && rays > 0.0);
        assert!(work + rays <= b.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION + 1e-8);
    }
    #[test]
    fn an_internal_source_still_cannot_propel_its_carrier() {
        let (mut damage, mut geometry) = module_fixture(0.0);
        let mut effects = Effects::default();
        explode(&[], blast(0.0), &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(0.0)));
        assert!(damage.module(1).unwrap().health < 10000.0);
        assert!(effects.impulses.is_empty());
    }
    #[test]
    fn external_fragments_cannot_overshoot_their_declared_small_blast_reach() {
        let (mut damage, mut geometry) = module_fixture(9.5);
        let marker = json!({"length":1,"thicknessMm":10,"material":"steel",
            "x":2,"y":3,"angle":std::f64::consts::FRAC_PI_2});
        damage.insert_plate(crate::game_damage::fixtures::plate(2, 8, &marker));
        geometry.upsert(2, crate::game_damage::fixtures::geometry(2, 8, EntityKind::Plate, &marker).unwrap());
        damage.cut(2, point(2.0, 3.0), point(2.0, 3.0), 10.0, &mut Effects::default());
        geometry.set_grid(2, &damage.plate(2).unwrap().grid);
        let mut b = blast(0.0); b.power = 95.0; b.radius = 1.8;
        let limit = reach(b.radius);
        let mut effects = Effects::new(true);
        explode(&[], b, &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(9.5)));
        assert_eq!(damage.module(1).unwrap().health, 10000.0);
        let rays: Vec<_> = effects.events.iter().filter(|e| e["type"] == "secondary-ray" && e["internal"] == false).collect();
        assert_eq!(rays.len(), 3);
        for ray in rays {
            let end = point(ray["endX"].as_f64().unwrap(), ray["endY"].as_f64().unwrap());
            assert!(end.distance(point(0.0, 3.0)) <= limit + 1e-9);
        }
    }
    #[test]
    fn a_shell_made_otherwise_throws_its_fragments_with_the_share_and_as_far_as_its_case_gives_them() {
        // A 1.8 m burst throws its fragments 7.2 m: the module 9.5 m off is out of their reach, unless a thicker case makes
        // them fly half as far again; and they carry the share of the burst they were made to.
        let fired = |details: serde_json::Value| {
            let (mut damage, mut geometry) = module_fixture(9.5);
            let mut b = blast(0.0); b.power = 95.0; b.radius = 1.8; b.details = details;
            let mut effects = Effects::new(true);
            explode(&[], b, &[], 0.0, &mut damage, &mut geometry, &Terrain::new("flat").unwrap(),
                &mut ProjectileState::default(), &mut effects, &|actor| (actor == 7).then(|| body(9.5)));
            let rays = effects.events.iter().filter(|e| e["type"] == "secondary-ray")
                .map(|e| e["energyBudget"].as_f64().unwrap()).sum::<f64>();
            (damage.module(1).unwrap().health, rays)
        };
        assert_eq!(fired(json!({})).0, 10000.0);
        let (health, rays) = fired(json!({"fragments":0.25,"fragmentReach":1.5}));
        assert!(health < 10000.0, "{health}");
        let budget = 95.0 * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION;
        assert!(rays > 0.0 && rays <= 0.25 * budget + 1e-8, "{rays} of {budget}");
    }
    #[test]
    fn internal_damage_rays_retain_their_original_twelve_metre_range() {
        let (mut damage, mut geometry) = module_fixture(9.5);
        let mut effects = Effects::new(true);
        let spent = ProjectileState::default().trace_damage_ray(&[], point(0.0, 3.0), point(1.0, 0.0),
            RayBudget::blast(1000.0), FRAGMENT_FLIGHT, None, Some(7), &[], &mut damage, &mut geometry,
            &Terrain::new("flat").unwrap(), &mut effects, 0.0);
        assert!(spent > 0.0 && damage.module(1).unwrap().health < 10000.0);
        assert!(effects.impulses.is_empty());
    }
    #[test]
    fn rear_flakes_keep_their_normal_depth_and_front_wall_under_rotation_and_reflection() {
        let mut expected = None;
        for angle in [0.0, 0.6, -1.1] {
            for sign in [1.0, -1.0] {
                let value = json!({"length":2,"thicknessMm":80,"material":"steel",
                    "x":10,"y":3,"angle":angle});
                let mut damage = DamageState::default();
                damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
                let mut geometry = Geometry::new();
                geometry.upsert(
                    1,
                    crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
                );
                let plate = damage.plate(1).unwrap();
                let (mass, inertia, area) = (plate.mass(), plate.inertia(), plate.properties.area);
                let normal = point(-sin(angle) * sign, cos(angle) * sign);
                let at = plate.pose.world_point(point(0.0, 0.04 * sign));
                let mut effects = Effects::new(true);
                let burst = blast_plate(
                    1,
                    at,
                    normal,
                    650.0,
                    false,
                    &mut damage,
                    &mut geometry,
                    &mut effects,
                );
                assert!(burst.is_some());
                let plate = damage.plate(1).unwrap();
                let grid = &plate.grid;
                let dx = (grid.bounds.max_x - grid.bounds.min_x) / grid.nx as f64;
                let dy = (grid.bounds.max_y - grid.bounds.min_y) / grid.ny as f64;
                let depth = (plate.thickness * 0.065).min(0.012);
                let radius = (sqrt(650.0) * 0.0075 * 0.35).clamp(0.025, 0.075);
                assert!(plate.properties.area < area);
                assert!(
                    area - plate.properties.area
                        <= (2.0 * radius + 2.0 * dx) * (depth + dy) + 1e-12
                );
                assert_eq!(plate.mass(), mass);
                assert_eq!(plate.inertia(), inertia);
                assert_eq!(plate.perforations.len(), 0);
                let rows = (depth / dy).ceil() as usize;
                let mut canonical = Vec::new();
                for y in 0..grid.ny {
                    let actual_y = if sign > 0.0 { y } else { grid.ny - 1 - y };
                    for x in 0..grid.nx {
                        let solid = grid.occupied(x, actual_y);
                        if y >= rows {
                            assert!(solid, "a shallow rear flake erased a deeper/front row");
                        }
                        canonical.push(solid);
                    }
                }
                if let Some(previous) = &expected {
                    assert_eq!(&canonical, previous);
                } else {
                    expected = Some(canonical);
                }
                let hit = geometry
                    .raycast_owner(
                        1,
                        add(at, scale(normal, 0.01)),
                        sub(at, scale(normal, 0.12)),
                    )
                    .unwrap();
                assert!(hit.depth >= plate.thickness - depth - dy - 1e-10);
                assert!(effects.impulses.is_empty());
            }
        }
    }

    #[test]
    fn superficial_brittle_craters_keep_normal_depth_without_changing_true_perforation() {
        let mut expected = None;
        for angle in [0.0, 0.6, -1.1] {
            for sign in [1.0, -1.0] {
                let value = json!({"length":3,"thicknessMm":480,"material":"concrete",
                    "x":10,"y":3,"angle":angle});
                let mut damage = DamageState::default();
                damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
                let mut geometry = Geometry::new();
                geometry.upsert(
                    1,
                    crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
                );
                let plate = damage.plate(1).unwrap();
                let (mass, inertia, area) = (plate.mass(), plate.inertia(), plate.properties.area);
                let normal = point(-sin(angle) * sign, cos(angle) * sign);
                let at = plate.pose.world_point(point(0.0, 0.24 * sign));
                let response = plate_response(plate, 330.0, plate.thickness);
                assert!(!response.perforate);
                let mut effects = Effects::new(true);
                assert!(
                    blast_plate(
                        1,
                        at,
                        normal,
                        330.0,
                        false,
                        &mut damage,
                        &mut geometry,
                        &mut effects
                    )
                    .is_none()
                );
                let plate = damage.plate(1).unwrap();
                let grid = &plate.grid;
                let dx = (grid.bounds.max_x - grid.bounds.min_x) / grid.nx as f64;
                let dy = (grid.bounds.max_y - grid.bounds.min_y) / grid.ny as f64;
                let rows = (response.depth / dy).ceil() as usize;
                assert!(plate.properties.area < area);
                assert!(
                    area - plate.properties.area
                        <= (2.0 * response.radius + 2.0 * dx) * (response.depth + dy) + 1e-12
                );
                let mut canonical = Vec::new();
                for y in 0..grid.ny {
                    let actual_y = if sign > 0.0 { grid.ny - 1 - y } else { y };
                    for x in 0..grid.nx {
                        let solid = grid.occupied(x, actual_y);
                        if y >= rows {
                            assert!(solid, "superficial damage crossed its normal depth");
                        }
                        canonical.push(solid);
                    }
                }
                if let Some(previous) = &expected {
                    assert_eq!(&canonical, previous);
                } else {
                    expected = Some(canonical);
                }
                let hit = geometry
                    .raycast_owner(
                        1,
                        add(at, scale(normal, 0.01)),
                        sub(at, scale(normal, 0.55)),
                    )
                    .unwrap();
                assert!(hit.depth >= plate.thickness - response.depth - dy - 1e-10);
                assert_eq!(plate.mass(), mass);
                assert_eq!(plate.inertia(), inertia);
                assert_eq!(plate.perforations.len(), 0);
                assert!(effects.impulses.is_empty());
                // The unbounded path still makes a real through opening.
                let value = json!({"length":2,"thicknessMm":30,"material":"steel",
                    "x":10,"y":3,"angle":angle});
                let mut damage = DamageState::default();
                damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
                let mut geometry = Geometry::new();
                geometry.upsert(
                    1,
                    crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
                );
                let at = damage
                    .plate(1)
                    .unwrap()
                    .pose
                    .world_point(point(0.0, 0.015 * sign));
                assert!(
                    blast_plate(
                        1,
                        at,
                        normal,
                        650.0,
                        false,
                        &mut damage,
                        &mut geometry,
                        &mut effects
                    )
                    .is_some()
                );
                assert!(
                    geometry
                        .raycast_owner(
                            1,
                            add(at, scale(normal, 0.01)),
                            sub(at, scale(normal, 0.08))
                        )
                        .is_none()
                );
            }
        }
    }

    #[test]
    fn concrete_stands_a_blast_as_it_always_did_and_a_shot_by_its_lower_resistance() {
        use crate::game_damage::Material;
        for name in ["steel", "aluminum", "ceramic", "hha", "titanium", "fiberglass", "glass"] {
            let material = Material::named(name).unwrap();
            assert_eq!(material.blast, material.resistance, "{name}");
        }
        let concrete = Material::named("concrete").unwrap();
        assert_eq!((concrete.resistance, concrete.blast), (0.18, 0.38));
        let value = json!({"length":3,"thicknessMm":260,"material":"concrete","x":10,"y":3});
        let mut damage = DamageState::default();
        damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
        );
        let terrain = Terrain::new("flat").unwrap();
        let plate = damage.plate(1).unwrap();
        // A wall of 260 mm holds 260 × 0.38 × 2.2 = 217.36 of a blast and is opened by 2.2 times
        // that, 478.2: counted as a shot counts it, 226.5 would have opened it.
        let held = plate_response(plate, 470.0, plate.thickness);
        assert!(!held.perforate && (held.ratio - 470.0 / 217.36).abs() < 1e-12);
        assert!(plate_response(plate, 485.0, plate.thickness).perforate);
        // A dose of 100 craters its face 100 / (0.38 × 6500) m deep.
        assert!((plate_response(plate, 100.0, plate.thickness).depth - 100.0 / (0.38 * 6500.0)).abs() < 1e-15);
        // What stands behind it is reached by e^(-260 × 0.38 / 18) of a blast before it.
        let through = exposure(&[], point(10.0, 4.0), point(10.0, 2.0), None, &damage, &geometry, &terrain);
        assert!((through / (-260.0 * 0.38 / 18.0f64).exp() - 1.0).abs() < 1e-6, "{through}");
        // A fragment is a shot: of its 50 the wall takes 260 × 0.18 = 46.8 and lets it through.
        let spent = ProjectileState::default().trace_damage_ray(&[],
            point(10.0, 4.0),
            point(0.0, -1.0),
            RayBudget::blast(50.0 * SECONDARY_ENERGY_PER_POWER),
            FRAGMENT_FLIGHT,
            None,
            None,
            &[],
            &mut damage,
            &mut geometry,
            &terrain,
            &mut Effects::new(false),
            0.0,
        );
        assert!((spent / SECONDARY_ENERGY_PER_POWER - 46.8).abs() < 1e-6, "{spent}");
    }
    #[test]
    fn superficial_grid_erosion_keeps_a_real_surface_for_the_next_blast() {
        let value = json!({"length":2,"thicknessMm":100,"material":"concrete","x":0,"y":3});
        let mut damage = DamageState::default();
        damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
        let mut geometry = Geometry::new();
        geometry.upsert(
            1,
            crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
        );
        let mass = damage.plate(1).unwrap().mass();
        damage.cut(
            1,
            point(0.0, 2.94),
            point(0.0, 2.965),
            0.012,
            &mut Effects::default(),
        );
        geometry.set_grid(1, &damage.plate(1).unwrap().grid);
        let plate = damage.plate(1).unwrap();
        assert!(!plate.grid.contains(point(0.0, -0.05)));
        assert!(plate.grid.contains(point(0.0, 0.03)));
        assert!(!face_spans(plate, point(-1.0, 2.95), point(1.0, 2.95)).is_empty());
        let before = plate.properties.area;
        let _ = blast_plate(
            1,
            point(0.0, 2.95),
            point(0.0, -1.0),
            100.0,
            false,
            &mut damage,
            &mut geometry,
            &mut Effects::default(),
        );
        assert!(
            damage.plate(1).unwrap().properties.area < before,
            "the second strike must load and erode the remaining material"
        );
        assert_eq!(damage.plate(1).unwrap().mass(), mass);
    }
    #[test]
    fn explosion_loads_eroded_material_faces_and_still_respects_external_cover_and_energy() {
        for covered in [false, true] {
            let value = json!({"length":2,"thicknessMm":100,"material":"concrete","x":0,"y":3});
            let mut damage = DamageState::default();
            damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
            let mut geometry = Geometry::new();
            geometry.upsert(
                1,
                crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
            );
            // Remove only the outside thickness row. BASE face points now lie
            // in empty cells, although the real remaining face is intact.
            damage.cut(
                1,
                point(-1.0, 2.95),
                point(1.0, 2.95),
                0.001,
                &mut Effects::default(),
            );
            geometry.set_grid(1, &damage.plate(1).unwrap().grid);
            let plate = damage.plate(1).unwrap();
            assert!(!plate.contains_local(point(0.0, -0.05)));
            assert!(plate.contains_local(point(0.0, -0.04)));
            let (area, mass, inertia) = (plate.properties.area, plate.mass(), plate.inertia());
            if covered {
                let cover = json!({"length":4,"thicknessMm":60,"material":"steel","x":0,"y":2.875});
                damage.insert_plate(crate::game_damage::fixtures::plate(2, 8, &cover));
                geometry.upsert(
                    2,
                    crate::game_damage::fixtures::geometry(2, 8, EntityKind::Plate, &cover).unwrap(),
                );
            }
            let b = Blast {
                point: point(0.0, 2.8),
                power: 100.0,
                radius: 1.0,
                source: None,
                actor: None,
                details: json!({}),
            };
            let mut effects = Effects::new(true);
            explode(&[],
                b.clone(),
                &[],
                19.0,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut ProjectileState::default(),
                &mut effects,
                &|actor| (actor == 7).then(|| body(0.0)),
            );
            let plate = damage.plate(1).unwrap();
            if covered {
                assert_eq!(
                    plate.properties.area, area,
                    "intact steel cover must stop this blast dose"
                );
            } else {
                assert!(
                    plate.properties.area < area,
                    "explode must reach targets and erode the remaining real face"
                );
            }
            assert_eq!(plate.mass(), mass);
            assert_eq!(plate.inertia(), inertia);
            assert!(damage.stats.to_value().get("ejectedMass").is_none());
            let carrier = body(0.0);
            let body_energy = effects
                .impulses
                .iter()
                .map(|i| {
                    let torque = cross(sub(i.point, carrier.center), i.impulse);
                    dot(i.impulse, i.impulse) / (2.0 * carrier.mass)
                        + torque * torque / (2.0 * carrier.inertia)
                })
                .sum::<f64>();
            let ray_energy = effects
                .events
                .iter()
                .filter(|e| e["type"] == "secondary-ray")
                .map(|e| e["energyBudget"].as_f64().unwrap())
                .sum::<f64>();
            assert!(
                body_energy + ray_energy
                    <= b.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION + 1e-8
            );
        }
    }
    #[test]
    fn explosion_is_immediate_keeps_mass_and_has_no_pressure_state_to_advance() {
        let (mut damage, mut geometry) = module_fixture(0.0);
        let mut effects = Effects::new(true);
        explode(&[],
            blast(0.0),
            &[],
            0.0,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(),
            &mut effects,
            &|actor| (actor == 7).then(|| body(0.0)),
        );
        assert!(damage.module(1).unwrap().health < 10000.0);
        assert_eq!(damage.module(1).unwrap().physical_mass, 1000.0);
        assert_eq!(damage.stats.explosions, 1);
        assert!(damage.stats.to_value().get("ejectedMass").is_none());
        assert!(
            effects.impulses.is_empty(),
            "internal damage is not a propulsion source"
        );
        assert_eq!(
            effects
                .events
                .iter()
                .filter(|e| e["type"] == "explosion")
                .count(),
            1
        );
        assert!(
            effects
                .events
                .iter()
                .all(|e| e.get("compartmentId").is_none())
        );
    }
    #[test]
    fn late_explosion_rays_and_contacts_keep_the_actual_detonation_time() {
        for impact_time in [None, Some(37.492)] {
            let (mut damage, mut geometry) = module_fixture(2.0);
            let mut effects = Effects::new(true);
            let mut b = blast(0.0);
            if let Some(at) = impact_time {
                b.details["time"] = json!(at);
            }
            let at = impact_time.unwrap_or(37.5);
            explode(&[],
                b,
                &[],
                37.5,
                &mut damage,
                &mut geometry,
                &Terrain::new("flat").unwrap(),
                &mut ProjectileState::default(),
                &mut effects,
                &|actor| (actor == 7).then(|| body(2.0)),
            );
            let rays: Vec<_> = effects
                .events
                .iter()
                .filter(|e| e["type"] == "secondary-ray")
                .collect();
            assert_eq!(rays.len(), 3);
            assert!(rays.iter().all(|e| e["time"].as_f64() == Some(at)));
            assert!(
                effects.events.iter().any(|e| e["instantaneous"] == true),
                "the representative rays must actually contact the module"
            );
            assert!(
                effects
                    .events
                    .iter()
                    .filter(|e| e["instantaneous"] == true)
                    .all(|e| e["time"].as_f64() == Some(at))
            );
            assert_eq!(
                effects
                    .events
                    .iter()
                    .find(|e| e["type"] == "explosion")
                    .unwrap()["time"]
                    .as_f64(),
                Some(at)
            );
        }
    }
    #[test]
    fn external_blast_is_one_outward_impulse_and_is_covariant_under_reflection() {
        let terrain = Terrain::new("flat").unwrap();
        let mut result = Vec::new();
        for sign in [-1.0, 1.0] {
            let (mut damage, mut geometry) = module_fixture(sign * 2.0);
            let mut effects = Effects::default();
            explode(&[],
                blast(0.0),
                &[],
                0.0,
                &mut damage,
                &mut geometry,
                &terrain,
                &mut ProjectileState::default(),
                &mut effects,
                &|actor| (actor == 7).then(|| body(sign * 2.0)),
            );
            assert_eq!(effects.impulses.len(), 1);
            let load = &effects.impulses[0];
            assert!(load.impulse.x * sign > 0.0);
            assert!(load.impulse.y.abs() < 1e-10);
            result.push((load.impulse, damage.module(1).unwrap().health));
        }
        assert!((result[0].0.x + result[1].0.x).abs() < 1e-10);
        assert!((result[0].1 - result[1].1).abs() < 1e-10);
    }
    #[test]
    fn aggregated_impulse_preserves_moment_and_bounds_work_with_existing_motion() {
        let (damage, _) = module_fixture(2.0);
        for moving in [false, true] {
            let mut state = loads(&damage, None, &|actor| (actor == 7).then(|| body(2.0)));
            let load = state.get_mut(&7).unwrap();
            if moving {
                load.velocity = point(100.0, 0.0);
                load.omega = 20.0;
            }
            let (center, mass, inertia, velocity, omega) = (
                load.center,
                load.mass,
                load.inertia,
                load.velocity,
                load.omega,
            );
            let mut effects = Effects::default();
            effects.impulse(1, add(center, point(0.0, 0.3)), point(1e6, 2e5));
            effects.impulse(1, add(center, point(0.0, -0.2)), point(2e5, 1e5));
            finish_impulses(&blast(-4.0), &damage, &mut state, 0, 100.0, &mut effects);
            assert_eq!(effects.impulses.len(), 1);
            let out = &effects.impulses[0];
            let torque = cross(sub(out.point, center), out.impulse);
            let energy = dot(velocity, out.impulse)
                + omega * torque
                + dot(out.impulse, out.impulse) / (2.0 * mass)
                + torque * torque / (2.0 * inertia);
            assert!(energy <= 100.0 + 1e-8, "{energy}");
            assert!((out.impulse.y / out.impulse.x - 0.25).abs() < 1e-12);
            assert!((torque / out.impulse.x - (-0.3e6 + 0.2 * 2e5) / 1.2e6).abs() < 1e-12);
        }
    }
    #[test]
    fn exposure_is_pure_and_real_cover_still_attenuates_blast_damage() {
        let (mut damage, mut geometry) = module_fixture(2.0);
        let plate = json!({"length":3,"thicknessMm":100,"material":"steel","x":1,"y":3,"angle":std::f64::consts::FRAC_PI_2});
        damage.insert_plate(crate::game_damage::fixtures::plate(2, 8, &plate));
        geometry.upsert(
            2,
            crate::game_damage::fixtures::geometry(2, 8, EntityKind::Plate, &plate).unwrap(),
        );
        let terrain = Terrain::new("flat").unwrap();
        let before = damage.plate(2).unwrap().to_value();
        let stats = damage.stats.to_value();
        for _ in 0..25 {
            assert!(
                exposure(&[],
                    point(0.0, 3.0),
                    point(2.0, 3.0),
                    Some(1),
                    &damage,
                    &geometry,
                    &terrain
                ) < 0.01
            );
        }
        assert_eq!(damage.plate(2).unwrap().to_value(), before);
        assert_eq!(damage.stats.to_value(), stats);
        damage.cut(
            2,
            point(0.8, 3.0),
            point(1.2, 3.0),
            0.02,
            &mut Effects::default(),
        );
        geometry.set_grid(2, &damage.plate(2).unwrap().grid);
        assert_eq!(
            exposure(&[],
                point(0.0, 3.0),
                point(2.0, 3.0),
                Some(1),
                &damage,
                &geometry,
                &terrain
            ),
            1.0
        );
    }
    #[test]
    fn instantaneous_rays_and_body_impulse_share_one_finite_energy_budget() {
        let (mut damage, mut geometry) = module_fixture(2.0);
        let mut effects = Effects::new(true);
        let original = loads(&damage, None, &|actor| (actor == 7).then(|| body(2.0)));
        let b = blast(0.0);
        explode(&[],
            b.clone(),
            &[],
            0.0,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(),
            &mut effects,
            &|actor| (actor == 7).then(|| body(2.0)),
        );
        let load = original.get(&7).unwrap();
        let body_energy = effects
            .impulses
            .iter()
            .map(|i| {
                let torque = cross(sub(i.point, load.center), i.impulse);
                dot(i.impulse, i.impulse) / (2.0 * load.mass)
                    + torque * torque / (2.0 * load.inertia)
            })
            .sum::<f64>();
        let fragment_energy = effects
            .events
            .iter()
            .filter(|e| e["type"] == "secondary-ray")
            .map(|e| e["energyBudget"].as_f64().unwrap())
            .sum::<f64>();
        assert!(
            body_energy + fragment_energy
                <= b.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION + 1e-8
        );
        assert!(body_energy > 0.0 && fragment_energy > 0.0);
        assert_eq!(damage.module(1).unwrap().physical_mass, 1000.0);
    }

    #[test]
    fn moving_module_only_carrier_uses_its_authoritative_work_and_inertia() {
        let (mut damage, mut geometry) = module_fixture(2.0);
        assert!(damage.plates.is_empty());
        let mut moving = body(2.0);
        // Deliberately different from the module's mass: admission may include
        // other fixed construction masses, and the hitbox is not a body.
        moving.mass = 1700.0;
        moving.inertia = 410.0;
        moving.velocity = point(110.0, -1.0);
        moving.omega = 13.0;
        let calls = std::cell::Cell::new(0);
        let mut effects = Effects::default();
        let b = blast(0.0);
        explode(&[],
            b.clone(),
            &[],
            0.0,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(),
            &mut effects,
            &|actor| {
                calls.set(calls.get() + 1);
                (actor == 7).then_some(moving)
            },
        );
        assert_eq!(calls.get(), 1);
        assert_eq!(effects.impulses.len(), 1);
        let impulse = &effects.impulses[0];
        let torque = cross(sub(impulse.point, moving.center), impulse.impulse);
        let gained = dot(moving.velocity, impulse.impulse)
            + moving.omega * torque
            + dot(impulse.impulse, impulse.impulse) / (2.0 * moving.mass)
            + torque * torque / (2.0 * moving.inertia);
        assert!(gained > 0.0);
        assert!(gained <= b.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION + 1e-8);
        assert!(damage.module(1).unwrap().health < 10000.0);
    }

    #[test]
    fn static_module_only_actor_takes_damage_without_a_carrier_impulse() {
        let (mut damage, mut geometry) = module_fixture(2.0);
        let mut effects = Effects::new(true);
        explode(&[],
            blast(0.0),
            &[],
            0.0,
            &mut damage,
            &mut geometry,
            &Terrain::new("flat").unwrap(),
            &mut ProjectileState::default(),
            &mut effects,
            &|_| None,
        );
        assert!(effects.impulses.is_empty());
        assert!(damage.module(1).unwrap().health < 10000.0);
        assert!(damage.stats.secondary_shots > 0);
        assert!(effects.events.iter().any(|e| e["type"] == "explosion"));
        assert_eq!(damage.module(1).unwrap().physical_mass, 1000.0);
    }

    #[test]
    fn internal_footprint_requires_strict_interior_under_rotation_and_reflection() {
        for angle in [0.0, 0.73, std::f64::consts::PI] {
            for sign in [-1.0, 1.0] {
                let transform = |p: Point| {
                    let x = p.x * sign;
                    point(
                        17.0 + x * cos(angle) - p.y * sin(angle),
                        -8.0 + x * sin(angle) + p.y * cos(angle),
                    )
                };
                let base = [
                    point(0.0, 0.0),
                    point(1.0, 0.0),
                    point(1.0, 2.0),
                    point(0.0, 2.0),
                ]
                .map(transform)
                .to_vec();
                for (p, internal) in [
                    (point(0.5, 1.0), true),
                    (point(0.0, 1.0), false),
                    (point(0.0, 0.0), false),
                    (point(1e-10, 1.0), false),
                    (point(2e-9, 1.0), true),
                    (point(-1e-7, 1.0), false),
                ] {
                    assert_eq!(
                        hull_contains(&mut base.clone(), transform(p)),
                        internal,
                        "angle={angle} sign={sign} point={p:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn coincident_exterior_faces_receive_bounded_reflected_blast_impulses() {
        let terrain = Terrain::new("flat").unwrap();
        for module in [false, true] {
            let mut result = Vec::new();
            for sign in [-1.0, 1.0] {
                let (mut damage, mut geometry) = if module {
                    module_fixture(sign * 2.0)
                } else {
                    let mut damage = DamageState::default();
                    let mut geometry = Geometry::new();
                    let value = json!({"length":2,"thicknessMm":100,"material":"steel",
                        "x":sign*2.0,"y":3,"angle":std::f64::consts::FRAC_PI_2});
                    damage.insert_plate(crate::game_damage::fixtures::plate(1, 7, &value));
                    geometry.upsert(
                        1,
                        crate::game_damage::fixtures::geometry(1, 7, EntityKind::Plate, &value).unwrap(),
                    );
                    (damage, geometry)
                };
                let mut b = blast(sign * if module { 1.5 } else { 1.95 });
                b.source = Some(1);
                let mut effects = Effects::default();
                explode(&[],
                    b.clone(),
                    &[],
                    0.0,
                    &mut damage,
                    &mut geometry,
                    &terrain,
                    &mut ProjectileState::default(),
                    &mut effects,
                    &|actor| (actor == 7).then(|| body(sign * 2.0)),
                );
                assert_eq!(effects.impulses.len(), 1, "module={module} sign={sign}");
                let impulse = &effects.impulses[0];
                assert!(
                    impulse.impulse.x * sign > 0.0,
                    "module={module} sign={sign}"
                );
                let carrier = body(sign * 2.0);
                let torque = cross(sub(impulse.point, carrier.center), impulse.impulse);
                let body_energy = dot(impulse.impulse, impulse.impulse) / (2.0 * carrier.mass)
                    + torque * torque / (2.0 * carrier.inertia);
                assert!(body_energy <= b.power * SECONDARY_ENERGY_PER_POWER * MECHANICAL_FRACTION + 1e-8);
                result.push(impulse.impulse);
            }
            assert!((result[0].x + result[1].x).abs() < 1e-8, "module={module}");
            assert!((result[0].y - result[1].y).abs() < 1e-8, "module={module}");
        }
    }
}
