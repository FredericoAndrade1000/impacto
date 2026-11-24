use super::*;
use crate::game_damage::fixtures;
use crate::NativeWorld;

const DT: f64 = 1.0 / 60.0;

fn world(ground: Value, visual: bool) -> NativeWorld {
    let source = crate::game_templates::source("truck", &json!({}), fixtures::full_catalogue()).unwrap();
    let mut scene = fixtures::scene(&[(1, "local", source, 0.0, true)], ground);
    scene["visualEvents"] = json!(visual);
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    core.load_game(&scene.to_string()).unwrap();
    core
}

fn step(core: &mut NativeWorld, count: usize) {
    let mut game = core.game.take().unwrap();
    for _ in 0..count { game.step(core, DT).unwrap(); }
    core.game = Some(game);
}

fn drive(core: &mut NativeWorld, throttle: f64) {
    core.game_command(&json!({"op":"control","actorId":"local","throttle":throttle,"frame":false}).to_string()).unwrap();
}

fn health(core: &NativeWorld) -> Vec<(u32, u64)> {
    core.game.as_ref().unwrap().damage.modules.iter().map(|m| (m.owner, m.health.to_bits())).collect()
}

fn ground(points: Value) -> Value {
    json!({"id":"mixed","minX":-100,"maxX":1000,"points":points,
        "sectors":[{"start":-100,"end":1000,"surface":"concrete"}]})
}

fn drop_ground(depth: f64) -> Value {
    ground(json!([{"x":-100.0,"y":0.0},{"x":24.0,"y":0.0},
        {"x":24.05,"y":-depth},{"x":1000.0,"y":-depth}]))
}

#[test]
fn static_weight_and_fast_level_rolling_leave_every_part_undamaged() {
    let mut core = world(json!("flat"), true);
    let initial = health(&core);
    step(&mut core, 600);
    assert_eq!(health(&core), initial, "parked weight is not a damaging impact");
    drive(&mut core, 1.0);
    step(&mut core, 900);
    let game = core.game.as_ref().unwrap();
    assert!(game.actors[0].drive.as_ref().unwrap().velocity.x > 20.0, "this is fast rolling, not an idle fixture");
    assert_eq!(health(&core), initial);
    assert!(game.damage.plates.iter().all(|p| p.dents.is_empty()));
    assert!(game.damage.modules.iter().all(|m| m.marks.is_empty()));
    assert_eq!(game.recoveries, 0);
}

#[test]
fn ordinary_short_roughness_and_a_low_step_are_absorbed_by_the_existing_suspension() {
    let points = (-100..=200).map(|x| {
        let y = if x < 15 { 0.0 } else { 0.025 * sin((x - 15) as f64 * std::f64::consts::PI / 4.0) };
        json!({"x":x,"y":y})
    }).collect::<Vec<_>>();
    for terrain in [ground(json!(points)), drop_ground(0.08)] {
        let mut core = world(terrain, false);
        let initial = health(&core);
        step(&mut core, 60);
        let mut top = 0.0_f64;
        for _ in 0..600 {
            let speed = core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap().velocity.x;
            top = top.max(speed);
            drive(&mut core, if speed < 10.0 { 1.0 } else { 0.0 });
            step(&mut core, 1);
        }
        let game = core.game.as_ref().unwrap();
        assert!(top > 9.0 && game.actors[0].drive.as_ref().unwrap().pose.x > 60.0);
        assert_eq!(health(&core), initial, "routine terrain is not cumulative fatigue");
        assert!(game.damage.plates.iter().all(|p| p.dents.is_empty()));
        assert_eq!(game.recoveries, 0);
    }
}

#[test]
fn controlled_mixed_route_does_not_accumulate_damage_below_the_support_capacity() {
    // Captured from new Terrain('mixed').descriptor(): this authored test track is admitted by
    // contour, as the browser/server admit it, rather than copied as another terrain generator.
    let ground: Value = serde_json::from_str(include_str!("../../../tests/fixtures/contact-mixed-route.json")).unwrap();
    for template in ["scout", "heavy"] {
        // The public environmentDrive track, driven over every material at a controlled 2 m/s.
        // Face the route, so this measures ordinary forward rolling rather than backing the low rear into its hills.
        // This controlled pace isolates repeated subcritical loads before yielding.
        let source=crate::game_templates::source(template,&json!({}),fixtures::full_catalogue()).unwrap();
        let mut scene = fixtures::scene(&[(1, "local", source, 12.0, true)], ground.clone());
        scene["visualEvents"] = json!(true);
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        let initial = health(&core);
        step(&mut core, 30);
        drive(&mut core, 1.0);
        let mut throttle = 1.0;
        for _ in 0..60 * 60 {
            let hull = core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap();
            let wanted = if hypot(hull.velocity.x, hull.velocity.y) < 2.0 { 1.0 } else { 0.0 };
            if wanted != throttle { throttle = wanted; drive(&mut core, throttle); }
            step(&mut core, 1);
            if core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap().pose.x > 100.0 { break; }
        }
        let game = core.game.as_ref().unwrap();
        let hull = game.actors[0].drive.as_ref().unwrap();
        eprintln!("mixed at 2 m/s {template}: x={}, health={:?}, impacts={:?}", hull.pose.x,
            game.damage.modules.iter().filter(|m| m.kind.gear()).map(|m| (m.owner,m.health,m.max_health)).collect::<Vec<_>>(),
            game.events.iter().filter(|e| e["impactEnergy"].is_number()).collect::<Vec<_>>());
        assert!(hull.pose.x > 100.0, "{template}: {}", hull.pose.x);
        assert_eq!(health(&core), initial, "{template}: elastic work must not cause cumulative damage");
        assert!(game.damage.plates.iter().all(|p| p.dents.is_empty()));
        assert!(game.damage.modules.iter().all(|m| m.marks.is_empty()));
        assert!(!game.events.iter().any(|e| e["impactEnergy"].as_f64().is_some_and(|energy| energy > 0.0)));
        assert_eq!(game.recoveries, 0);
    }
}

#[test]
fn a_real_driven_drop_damages_gear_and_its_support_without_changing_the_carrier() {
    let mut core = world(drop_ground(10.0), true);
    let initial = health(&core);
    let game = core.game.as_ref().unwrap();
    let body = core.bodies[&game.actors[0].body];
    let mass = core.world.bodies[body].mass();
    let inertia = core.world.bodies[body].mass_properties().local_mprops.principal_inertia();
    let contour = game.actors[0].contact_contours.clone();
    // The admitted lattice sums clipped cells; original_area is the authored triangulation.
    // Their rounding (or an authored opening) need not match before any motion takes place.
    let material = |game: &GameState| game.damage.plates.iter().map(|p|
        (p.owner, p.attached, p.properties.area.to_bits(), p.original_area.to_bits(), p.grid.words().to_vec(), p.revision)
    ).collect::<Vec<_>>();
    let admitted = material(game);
    assert!(game.damage.plates.iter().all(|p| p.attached));
    for p in &game.damage.plates {
        if p.properties.area != p.original_area {
            eprintln!("admitted plate {}: material area {:.17}, original area {:.17}", p.owner, p.properties.area, p.original_area);
        }
    }
    drive(&mut core, 1.0);
    let mut airborne = 0;
    for _ in 0..720 {
        step(&mut core, 1);
        let game = core.game.as_ref().unwrap();
        if !game.actors[0].drive.as_ref().unwrap().grounded { airborne += 1; }
    }
    let game = core.game.as_ref().unwrap();
    assert!(airborne > 20, "the truck must drive off and fall, without a pose or velocity injection");
    assert!(game.actors[0].drive.as_ref().unwrap().pose.x > 27.0);
    assert_ne!(health(&core), initial);
    assert!(game.damage.modules.iter().any(|m| m.kind.gear() && m.health < m.max_health));
    assert!(game.damage.plates.iter().any(|p| !p.dents.is_empty()), "the loaded support carries an existing dent record");
    assert_eq!(material(game), admitted, "landing preserves each admitted plate's attachment, material cells, area and revision exactly");
    assert!(game.damage.modules.iter().all(|m| m.attached));
    assert_eq!(game.actors[0].contact_contours, contour);
    assert_eq!(core.world.bodies[body].mass(), mass, "gear damage does not take structural mass off");
    assert_eq!(core.world.bodies[body].mass_properties().local_mprops.principal_inertia(), inertia);
    assert_eq!(core.world.bodies[body].colliders().len(), 1);
    assert!(core.world.impulse_joints.is_empty());
    assert_eq!(game.recoveries, 0);
}

#[test]
fn impact_energy_is_finite_and_never_exceeds_the_solve_loss() {
    // A real ten-metre ledge overloads the current truck supports after suspension work.
    let mut core = world(drop_ground(10.0), true);
    drive(&mut core, 1.0);
    let mut hits = 0;
    for _ in 0..720 {
        let mut game = core.game.take().unwrap();
        game.events.clear();
        game.step(&mut core, DT).unwrap();
        let spent = game.events.iter().filter_map(|e| e["impactEnergy"].as_f64()).sum::<f64>();
        if spent > 0.0 {
            hits += 1;
            let audit = &core.energy_audit.last;
            let budget = (audit.before - audit.after + audit.gravity_work + audit.constraint_energy).max(0.0);
            assert!(spent.is_finite() && spent <= budget + 1e-7 * budget.max(1.0), "{spent} > {budget}");
        }
        assert!(game.damage.modules.iter().all(|m| m.health.is_finite() && m.health >= 0.0));
        assert!(game.damage.plates.iter().flat_map(|p| p.dents.values()).all(|d| d.depth.is_finite() && d.radius.is_finite()));
        assert_eq!(game.recoveries, 0);
        core.game = Some(game);
    }
    assert!(hits > 0);
}

#[test]
fn landing_damage_is_local_and_independent_of_horizontal_speed() {
    let mut stopped = world(json!("flat"), false);
    let mut rolling = world(json!("flat"), false);
    // Isolate the contact law on an admitted truck: identical normal motion and mass. No drive,
    // drag or angular damping is integrated by this probe, so tangential speed has no damage term.
    let probe = |core: &mut NativeWorld, vx: f64| {
        let mut game = core.game.take().unwrap();
        let body = core.bodies[&game.actors[0].body];
        let rigid = &mut core.world.bodies[body];
        rigid.set_linvel(Vector::new(vx, -12.0), true);
        let before = core.solve(DT, 0.0, game.time).unwrap();
        game.sync_poses(core);
        game.contact_damage(core, &before, &mut Effects::default());
        core.game = Some(game);
    };
    probe(&mut stopped, 0.0);
    probe(&mut rolling, 45.0);
    let a = health(&stopped);
    let b = health(&rolling);
    assert!(stopped.game.as_ref().unwrap().damage.modules.iter().any(|m| m.kind.gear() && m.health < m.max_health));
    for ((owner, ha), (other, hb)) in a.into_iter().zip(b) {
        assert_eq!(owner, other);
        assert!((f64::from_bits(ha) - f64::from_bits(hb)).abs() < 1e-7, "tangential speed must not be a damage multiplier");
    }
}

#[test]
fn saved_airborne_motion_and_presentation_flags_do_not_change_the_landing() {
    let mut visible = world(drop_ground(10.0), true);
    let mut quiet = world(drop_ground(10.0), false);
    drive(&mut visible, 1.0);
    drive(&mut quiet, 1.0);
    let mut found = false;
    for _ in 0..600 {
        step(&mut visible, 1);
        step(&mut quiet, 1);
        let game = visible.game.as_ref().unwrap();
        let d = game.actors[0].drive.as_ref().unwrap();
        if !d.grounded && d.pose.x > 28.0 && d.velocity.y < -1.0 { found = true; break; }
    }
    assert!(found);
    let state = visible.export_state().unwrap();
    let mut resumed = world(drop_ground(10.0), true);
    resumed.import_state(&state).unwrap();
    for _ in 0..300 {
        step(&mut visible, 1);
        step(&mut resumed, 1);
        step(&mut quiet, 1);
        assert_eq!(health(&visible), health(&resumed));
        assert_eq!(health(&visible), health(&quiet));
        let a = &visible.game.as_ref().unwrap().damage;
        let b = &resumed.game.as_ref().unwrap().damage;
        assert_eq!(a.plates.iter().map(|p| p.to_value()).collect::<Vec<_>>(), b.plates.iter().map(|p| p.to_value()).collect::<Vec<_>>());
    }
    assert!(visible.game.as_ref().unwrap().damage.modules.iter().any(|m| m.kind.gear() && m.health < m.max_health));
}

/// The scout of the hover tests built as an aircraft (game_hover_tests.rs): on skids where its wheels were, with two
/// thrusters over its hull, its tanks dry and its magazine empty: nothing holds it up, and nothing it carries burns or goes
/// off when it breaks. Standing on its skids.
fn aircraft() -> NativeWorld {
    let catalogue = fixtures::full_catalogue();
    let mut source = crate::game_templates::source("scout", &json!({}), catalogue).unwrap();
    for (i, x) in [-1.6, 1.6].into_iter().enumerate() {
        source["components"].as_array_mut().unwrap().push(json!({"id":format!("lift{i}"),"kind":"thruster","metal":"titanium",
            "sizeScale":1.5,"pose":{"x":x/crate::game_construction::CELL,"y":4.5/crate::game_construction::CELL,"angle":0.0}}));
    }
    let chassis = source["chassis"].as_object_mut().unwrap();
    chassis.insert("model".into(), json!("aircraft"));
    for key in ["axles", "track", "gearScale"] { chassis.remove(key); }
    let source = crate::game_construction::seated(&source, catalogue);
    let mut scene = fixtures::scene(&[(1, "fly", source, 0.0, false)], json!("flat"));
    scene["visualEvents"] = json!(true);
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    core.load_game_value(&scene).unwrap();
    let stores = core.game.as_ref().unwrap().damage.modules.iter().filter(|m| matches!(m.kind, ComponentKind::Fuel | ComponentKind::Ammo))
        .map(|m| (m.owner, m.kind)).collect::<Vec<_>>();
    for (owner, kind) in stores {
        let state = if kind == ComponentKind::Fuel { json!({"fuelLitres":0.0}) } else { json!({"rounds":0}) };
        core.game_command_value(&json!({"op":"setPartState","owner":owner,"state":state})).unwrap();
    }
    step(&mut core, 120);
    core
}

/// The lowest any plate of the construction reaches.
fn lowest(core: &NativeWorld) -> f64 {
    core.game.as_ref().unwrap().damage.plates.iter().flat_map(|p| p.local_nodes.iter().map(|n| p.pose.world_point(*n).y))
        .fold(f64::INFINITY, f64::min)
}

/// Lets the aircraft at rest on its ground fall flat on it, upright or `upside_down`, meeting it at `speed`, and lets it
/// come to rest again. In every step, the ground's events spend no more than the solve lost. The energy they spent.
fn fall(core: &mut NativeWorld, speed: f64, upside_down: bool) -> f64 {
    const LIFT: f64 = 0.08;
    let rest = lowest(core);
    let d = core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap();
    let (y, angle) = (d.pose.y, d.pose.angle + if upside_down { std::f64::consts::PI } else { 0.0 });
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":y,"vy":0.0,"angle":angle}})).unwrap();
    let mut game = core.game.take().unwrap();
    game.sync_poses(core);
    core.game = Some(game);
    // Held just clear of its ground, as fast as falls on from there to meet it at `speed`.
    let lift = rest - lowest(core) + LIFT;
    let vy = (speed * speed - 2.0 * 9.81 * LIFT).max(0.0).sqrt();
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":y+lift,"vy":-vy,"angle":angle}})).unwrap();
    let body = core.bodies[&core.game.as_ref().unwrap().actors[0].body];
    assert!((core.world.bodies[body].linvel().y + vy).abs() < 1e-9, "it falls as it is let go");
    let mut energy = 0.0;
    for _ in 0..240 {
        let mut game = core.game.take().unwrap();
        game.events.clear();
        game.step(core, DT).unwrap();
        let spent = game.events.iter().filter(|e| e["type"] == "ground").filter_map(|e| e["impactEnergy"].as_f64()).sum::<f64>();
        let audit = &core.energy_audit.last;
        let budget = (audit.before - audit.after + audit.gravity_work + audit.constraint_energy).max(0.0);
        assert!(spent.is_finite() && spent <= budget + 1e-7 * budget.max(1.0), "{spent} > {budget}");
        energy += spent;
        core.game = Some(game);
    }
    energy
}

/// The plates of the aircraft's skids, by the last part of their name: how worn each is (its deepest dent, of what a
/// plate dents), and its revision, which a break raises.
fn skids(core: &NativeWorld) -> Vec<(String, f64, u64)> {
    core.game.as_ref().unwrap().damage.plates.iter().filter_map(|p| {
        let id = p.cold["definition"]["id"].as_str().filter(|id| crate::game_geometry::skid(id))?;
        let worn = p.dents.values().map(|d| d.depth / (crate::game_damage::DENT_SHARE * p.thickness)).fold(0.0, f64::max);
        Some((id.rsplit(':').next().unwrap().to_owned(), worn, p.revision))
    }).collect()
}

/// Whether a plate of the skids is torn, of those they were (`fresh`).
fn torn(fresh: &[(String, f64, u64)], now: &[(String, f64, u64)]) -> bool {
    now.iter().zip(fresh).any(|(now, fresh)| now.2 > fresh.2)
}

/// The kinds of the pieces of the construction the ground harmed.
fn harmed(core: &NativeWorld) -> Vec<&'static str> {
    core.game.as_ref().unwrap().damage.modules.iter().filter(|m| m.health < m.max_health).map(|m| m.kind.name()).collect()
}

/// Whether every command post of the construction is destroyed: the field makes it a wreck then (src/wreck.js).
fn out_of_action(core: &NativeWorld) -> bool {
    core.game.as_ref().unwrap().damage.modules.iter().filter(|m| m.kind == ComponentKind::Command).all(|m| m.health <= 0.0)
}

/// What hits left on the construction, as the field reckons it (src/squad.js `plateWear`, `pieceWear`): the revisions and
/// marks of its plates and the marks and lost health of its pieces, less all of them the ground made.
fn hits(core: &NativeWorld) -> f64 {
    let damage = &core.game.as_ref().unwrap().damage;
    damage.plates.iter().map(|p| (p.revision + p.mark_revision - p.ground_marks) as f64).sum::<f64>()
        + damage.modules.iter().map(|m| (m.mark_revision - m.ground_marks) as f64 - m.health - m.ground_damage).sum::<f64>()
}

#[test]
fn skids_take_the_weight_and_an_ordinary_landing_whole() {
    let mut core = aircraft();
    let fresh = skids(&core);
    assert!(fresh.len() >= 2 && harmed(&core).is_empty() && fresh.iter().all(|s| s.1 == 0.0), "it stands on its skids harmless");
    // Sinking at 3 m/s, a little faster than the limit drop of a rotorcraft (14 CFR 27.725), the skids bend and give it back.
    assert_eq!(fall(&mut core, 3.0, false), 0.0);
    assert!(harmed(&core).is_empty());
    assert_eq!(skids(&core), fresh);
}

#[test]
fn a_hard_landing_wears_the_skids_a_harder_one_breaks_them_and_worn_skids_give_way_sooner() {
    let mut core = aircraft();
    let fresh = skids(&core);
    // At 5.5 m/s they bend for good, some way, and nothing else is harmed.
    fall(&mut core, 5.5, false);
    let worn = skids(&core);
    assert!(worn.iter().any(|s| s.1 > 0.2 && s.1 < 0.9) && !torn(&fresh, &worn), "{worn:?}");
    assert!(harmed(&core).is_empty());
    // At 8 m/s, past the 20 ft/s the skids of a helicopter are built to take (MIL-STD-1290A), they bend flat and tear
    // where they met the ground. What they let on into the hull it takes at that speed with its pieces whole.
    let mut broken = aircraft();
    fall(&mut broken, 8.0, false);
    let now = skids(&broken);
    assert!(torn(&fresh, &now) && now.iter().any(|s| s.1 > 0.999), "{now:?}");
    assert!(harmed(&broken).is_empty() && !out_of_action(&broken));
    // Skids bent once stay bent: a second landing at 6.5 m/s breaks those that one landing at that speed did not.
    let mut twice = aircraft();
    fall(&mut twice, 6.5, false);
    assert!(!torn(&fresh, &skids(&twice)), "{:?}", skids(&twice));
    fall(&mut twice, 6.5, false);
    assert!(torn(&fresh, &skids(&twice)), "{:?}", skids(&twice));
}

#[test]
fn upside_down_the_parts_that_meet_the_ground_break_and_the_skids_are_untouched() {
    let mut down = aircraft();
    let fresh = skids(&down);
    fall(&mut down, 12.8, true);
    let kinds = harmed(&down);
    assert!(!kinds.is_empty() && kinds.iter().all(|kind| *kind == "thruster"), "the thrusters over its hull met the ground: {kinds:?}");
    assert_eq!(skids(&down), fresh);
    // Upright at that speed, the skids break, and what the crush reaches from under the hull is harmed: the thrusters
    // over it are whole.
    let mut up = aircraft();
    fall(&mut up, 12.8, false);
    let kinds = harmed(&up);
    assert!(!kinds.is_empty() && !kinds.contains(&"thruster"), "{kinds:?}");
    assert!(torn(&fresh, &skids(&up)));
}

#[test]
fn a_violent_fall_crushes_the_aircraft_out_of_action_and_none_of_it_is_a_hit() {
    let mut hard = aircraft();
    let before = hits(&hard);
    fall(&mut hard, 12.8, false);
    assert!(!out_of_action(&hard));
    let mut violent = aircraft();
    fall(&mut violent, 35.0, false);
    assert!(out_of_action(&violent), "its command post is crushed: {:?}", harmed(&violent));
    for (name, core) in [("hard", &hard), ("violent", &violent)] {
        assert!((hits(core) - before).abs() < 1e-6, "all that broke in the {name} fall, the ground broke: {} {before}", hits(core));
    }
}
