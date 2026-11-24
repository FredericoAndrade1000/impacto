//! Causal gates for the public Native command/physical/persistence contract. No JS mechanics.
use super::*;
fn scene() -> Value {
    let mut scene = crate::game_damage::fixtures::stock_scene(
        &[(1, "tug", "scout", 0.0), (2, "load", "scout", 8.0)],
        json!("flat"),
    );
    for actor in scene["actors"].as_array_mut().unwrap() {
        actor["team"] = json!("blue");
        actor["ownerId"] = json!("blue");
    }
    scene["visualEvents"] = json!(false);
    scene
}
fn world_gravity(gy: f64) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, gy).unwrap();
    core.load_game_value(&scene()).unwrap();
    core
}
fn world() -> NativeWorld {
    world_gravity(-9.81)
}
fn call(core: &mut NativeWorld, request: Value) -> Value {
    serde_json::from_str::<Value>(&core.game_command_value(&request).unwrap()).unwrap()["result"]
        .clone()
}
fn frame(core: &mut NativeWorld) -> Value {
    serde_json::from_str(&core.current_frame().unwrap()).unwrap()
}
fn attach(core: &mut NativeWorld) {
    let result =
        core.game_command_value(&json!({"op":"towAttach","actorId":"tug","targetId":"load"}));
    assert!(
        result.is_ok(),
        "tow_native: attach is a real Native command: {result:?}"
    );
}
fn row(core: &mut NativeWorld) -> Value {
    frame(core)["tows"][0].clone()
}
fn owner(core: &NativeWorld, actor: u32, kind: ComponentKind) -> u32 {
    core.game
        .as_ref()
        .unwrap()
        .damage
        .modules
        .iter()
        .find(|m| m.actor == actor && m.kind == kind)
        .unwrap()
        .owner
}
fn airborne(core: &mut NativeWorld, outward: f64) {
    for (id, sign) in [("tug", -1.0), ("load", 1.0)] {
        let y = {
            let g = core.game.as_ref().unwrap();
            g.actors
                .iter()
                .find(|a| a.id == id)
                .unwrap()
                .drive
                .as_ref()
                .unwrap()
                .pose
                .y
                + 40.0
        };
        call(
            core,
            json!({"op":"setVehicleState","actorId":id,"state":{"y":y,"vx":outward*sign,"vy":0.0}}),
        );
    }
}
fn momentum(core: &NativeWorld) -> rapier2d_f64::prelude::Vector {
    core.game
        .as_ref()
        .unwrap()
        .actors
        .iter()
        .map(|a| {
            let body = &core.world.bodies[core.bodies[&a.body]];
            body.linvel() * body.mass()
        })
        .fold(rapier2d_f64::prelude::Vector::ZERO, |a, b| a + b)
}
fn cold(core: &mut NativeWorld) -> Value {
    let full = core.game.as_mut().unwrap().frame();
    let mut value = scene();
    // Frames update an authored scene; the presentation packet is not a load_game scene.
    // Keep the actor identity/team/contact authoring and module catalogue/mount descriptors.
    for (kind, identity) in [("actors", "id"), ("modules", "owner")] {
        for authored in value[kind].as_array_mut().unwrap() {
            let live = full[kind]
                .as_array()
                .unwrap()
                .iter()
                .find(|live| live[identity] == authored[identity])
                .unwrap();
            authored
                .as_object_mut()
                .unwrap()
                .extend(live.as_object().unwrap().clone());
        }
    }
    // A cold plate frame wraps live material in damage and its pose in a separate envelope.
    // Admission still receives the original canonical definition/vertices/UVs/triangulation.
    for authored in value["plates"].as_array_mut().unwrap() {
        let live = full["plates"]
            .as_array()
            .unwrap()
            .iter()
            .find(|live| live["owner"] == authored["owner"])
            .unwrap();
        authored
            .as_object_mut()
            .unwrap()
            .extend(live["damage"].as_object().unwrap().clone());
        authored["definition"]
            .as_object_mut()
            .unwrap()
            .extend(live["pose"].as_object().unwrap().clone());
        for key in ["vx", "vy", "omega", "age", "sleeping"] {
            authored[key] = live["motion"][key].clone();
        }
    }
    for key in [
        "time",
        "tick",
        "randomState",
        "nextId",
        "stats",
        "recoveries",
    ] {
        value[key] = full[key].clone();
    }
    value["tows"] = json!(
        full["tows"]
            .as_array()
            .unwrap()
            .iter()
            .map(|tow| {
                json!({"actorId":tow["actorId"],"targetId":tow["targetId"],
            "partAId":tow["partAId"],"partBId":tow["partBId"],
            "localA":tow["localA"],"localB":tow["localB"],"length":tow["length"]})
            })
            .collect::<Vec<_>>()
    );
    value
}
#[test]
fn tow_native_attach_is_atomic_idempotent_and_neutralizes_late_parking() {
    let mut core = world();
    attach(&mut core);
    let before = row(&mut core);
    assert_eq!(frame(&mut core)["tows"].as_array().unwrap().len(), 1);
    for request in [
        json!({"op":"control","actorId":"load","throttle":1.0,"brake":1.0}),
        json!({"op":"input","actorId":"load","input":{"type":"drive","phase":"before","throttle":-1.0,"brake":1.0}}),
        json!({"op":"input","actorId":"load","input":{"type":"release","phase":"before","brake":1.0}}),
    ] {
        call(&mut core, request);
        let d = core.game.as_ref().unwrap().actors[1]
            .drive
            .as_ref()
            .unwrap();
        assert_eq!((d.throttle, d.brake), (0.0, 0.0));
    }
    call(
        &mut core,
        json!({"op":"setVehicleState","actorId":"load","state":{"vx":2.0}}),
    );
    let engine = owner(&core, 1, ComponentKind::Engine);
    call(
        &mut core,
        json!({"op":"setPartState","owner":engine,"state":{"health":0.0}}),
    );
    assert_eq!(
        call(
            &mut core,
            json!({"op":"towAttach","actorId":"tug","targetId":"load"})
        ),
        json!(true)
    );
    assert_eq!(
        row(&mut core),
        before,
        "retry does not recapture length or anchors after motion/motor damage"
    );
    let refused =
        core.game_command_value(&json!({"op":"towAttach","actorId":"load","targetId":"tug"}));
    assert!(refused.unwrap_err().contains("TOW_BUSY"));
    assert_eq!(row(&mut core), before);
    let velocity = core.game.as_ref().unwrap().actors[1]
        .drive
        .as_ref()
        .unwrap()
        .velocity;
    assert_eq!(
        call(&mut core, json!({"op":"towDetach","actorId":"load"})),
        json!(true)
    );
    let d = core.game.as_ref().unwrap().actors[1]
        .drive
        .as_ref()
        .unwrap();
    assert_eq!((d.throttle, d.brake), (0.0, 1.0));
    assert_eq!(d.velocity, velocity);
    assert_eq!(
        call(&mut core, json!({"op":"towDetach","actorId":"load"})),
        json!(false)
    );
    assert!(
        core.game_command_value(&json!({"op":"towAttach","actorId":"tug","targetId":"load"}))
            .unwrap_err()
            .contains("TOW_MOTOR")
    );
}
#[test]
fn tow_native_slack_zero_force_then_equal_opposite_force_and_real_anchor_torque() {
    let mut slack = world_gravity(0.0);
    airborne(&mut slack, -0.2);
    attach(&mut slack);
    for _ in 0..4 {
        slack.game_step(1.0 / 60.0).unwrap();
        assert_eq!(row(&mut slack)["tension"], json!(0.0));
    }
    let (mut core, mut baseline) = (world_gravity(0.0), world_gravity(0.0));
    for world in [&mut core, &mut baseline] {
        airborne(world, 0.2);
    }
    attach(&mut core);
    let masses = core
        .game
        .as_ref()
        .unwrap()
        .actors
        .iter()
        .map(|a| core.world.bodies[core.bodies[&a.body]].mass())
        .collect::<Vec<_>>();
    let mut positive = false;
    let mut torque = false;
    for _ in 0..8 {
        let before = row(&mut core);
        let centers = core
            .game
            .as_ref()
            .unwrap()
            .actors
            .iter()
            .map(|a| core.world.bodies[core.bodies[&a.body]].center_of_mass())
            .collect::<Vec<_>>();
        core.game_step(1.0 / 60.0).unwrap();
        baseline.game_step(1.0 / 60.0).unwrap();
        let cable = row(&mut core);
        let tension = cable["tension"].as_f64().unwrap();
        assert!(
            tension.is_finite() && tension >= 0.0 && tension <= cable["limit"].as_f64().unwrap()
        );
        let g = core.game.as_ref().unwrap();
        assert_eq!(g.recoveries, 0);
        assert_eq!(core.bodies.len(), 2);
        assert!(core.world.impulse_joints.is_empty());
        assert_eq!(
            g.actors
                .iter()
                .map(|a| core.world.bodies[core.bodies[&a.body]].mass())
                .collect::<Vec<_>>(),
            masses
        );
        let (pa, pb) = (
            Point::from_value(&before["anchorA"]),
            Point::from_value(&before["anchorB"]),
        );
        let span = pa.distance(pb);
        let direction = Point::new((pb.x - pa.x) / span, (pb.y - pa.y) / span);
        let mut forces = rapier2d_f64::prelude::Vector::ZERO;
        for (i, (key, part_key, sign)) in
            [("anchorA", "partAId", 1.0), ("anchorB", "partBId", -1.0)]
                .into_iter()
                .enumerate()
        {
            let actor = &g.actors[i];
            let drive = actor.drive.as_ref().unwrap();
            let body = &core.world.bodies[core.bodies[&actor.body]];
            assert!(
                hypot(drive.carried.push.x, drive.carried.push.y) < 1e-8
                    && drive.carried.moment.abs() < 1e-8,
                "0g airborne fixture has no spring/ground force"
            );
            let at = Point::from_value(&before[key]);
            let expected = rapier2d_f64::prelude::Vector::new(
                sign * direction.x * tension,
                sign * direction.y * tension,
            );
            assert!(
                (body.user_force() - expected).length() < 1e-7,
                "current force, with no previous cable force accumulated"
            );
            let lever = Point::new(at.x - centers[i].x, at.y - centers[i].y);
            let moment = lever.x * expected.y - lever.y * expected.x;
            assert!(
                (body.user_torque() - moment).abs() < 1e-7,
                "cable acts at real chassis anchors, not the COM"
            );
            torque |= moment.abs() > 1e-6;
            let plate = g
                .damage
                .plates
                .iter()
                .find(|p| p.cold["id"] == cable[part_key])
                .unwrap();
            assert_eq!(plate.cold["definition"]["chassis"]["part"], "frame");
            let current = Point::from_value(&cable[key]);
            assert!(plate.contains_local(plate.pose.local_point(current)));
            forces += body.user_force();
        }
        assert!(
            forces.length() < 1e-7,
            "force is equal and opposite before the same Rapier solve"
        );
        if tension > 0.0 && !positive {
            assert!(
                (momentum(&core) - momentum(&baseline)).length() < 1e-7,
                "first tensile solve creates no pair momentum compared with identical no-cable 0g baseline"
            );
            positive = true;
        }
    }
    assert!(positive && torque);
    for (id, vx) in [("tug", 0.4), ("load", -0.4)] {
        call(
            &mut core,
            json!({"op":"setVehicleState","actorId":id,"state":{"vx":vx}}),
        );
    }
    let mut loose = false;
    for _ in 0..30 {
        core.game_step(1.0 / 60.0).unwrap();
        let cable = row(&mut core);
        if Point::from_value(&cable["anchorA"]).distance(Point::from_value(&cable["anchorB"]))
            < cable["length"].as_f64().unwrap()
            && cable["tension"] == 0.0
        {
            for a in &core.game.as_ref().unwrap().actors {
                let body = &core.world.bodies[core.bodies[&a.body]];
                assert!(body.user_force().length() < 1e-8 && body.user_torque().abs() < 1e-8);
            }
            loose = true;
            break;
        }
    }
    assert!(
        loose,
        "after a taut interval a slack cable has no residual force or torque"
    );
}
#[test]
fn tow_native_repairable_engine_and_wheel_damage_stays_attached_until_command_loss() {
    let mut core = world();
    attach(&mut core);
    for kind in [ComponentKind::Engine, ComponentKind::Wheel] {
        let part = owner(&core, 2, kind);
        call(
            &mut core,
            json!({"op":"setPartState","owner":part,"state":{"health":0.0}}),
        );
        assert_eq!(
            frame(&mut core)["tows"].as_array().unwrap().len(),
            1,
            "repairable damage cannot silently detach the load"
        );
    }
    let command = owner(&core, 2, ComponentKind::Command);
    call(
        &mut core,
        json!({"op":"setPartState","owner":command,"state":{"health":0.0}}),
    );
    assert!(frame(&mut core)["tows"].as_array().unwrap().is_empty());
}
#[test]
fn tow_native_actual_anchor_loss_or_endpoint_removal_releases_the_relation() {
    let mut cut = world();
    attach(&mut cut);
    let cable = row(&mut cut);
    let part = cut
        .game
        .as_ref()
        .unwrap()
        .damage
        .plates
        .iter()
        .find(|p| p.cold["id"] == cable["partBId"])
        .unwrap()
        .owner;
    assert_eq!(
        call(
            &mut cut,
            json!({"op":"cut","owner":part,"start":cable["anchorB"],"end":cable["anchorB"],"radius":0.15})
        ),
        json!(true)
    );
    assert!(frame(&mut cut)["tows"].as_array().unwrap().is_empty());
    let d = cut.game.as_ref().unwrap().actors[1].drive.as_ref().unwrap();
    assert_eq!((d.throttle, d.brake), (0.0, 1.0));
    let mut gone = world();
    attach(&mut gone);
    let parts = call(
        &mut gone,
        json!({"op":"admit","leaving":[2],"actors":[],"plates":[],"modules":[],"frame":false}),
    );
    assert!(parts["tows"].as_array().unwrap().is_empty());
    assert_eq!(gone.game.as_ref().unwrap().actors.len(), 1);
}
#[test]
fn tow_native_overload_breaks_without_delivering_an_unbounded_rope_impulse() {
    let mut core = world_gravity(0.0);
    airborne(&mut core, 0.0);
    attach(&mut core);
    let (part, p, mass) = {
        let g = core.game.as_ref().unwrap();
        let a = &g.actors[1];
        let h = core.bodies[&a.body];
        (
            g.damage.plates.iter().find(|p| p.actor == 2).unwrap().owner,
            core.world.bodies[h].center_of_mass(),
            core.world.bodies[h].mass(),
        )
    };
    call(
        &mut core,
        json!({"op":"impulse","owner":part,"point":{"x":p.x,"y":p.y},"impulse":{"x":mass*80.0,"y":0.0}}),
    );
    let mut released = false;
    for _ in 0..6 {
        core.game_step(1.0 / 60.0).unwrap();
        let f = frame(&mut core);
        for cable in f["tows"].as_array().unwrap() {
            assert!(cable["tension"].as_f64().unwrap() <= cable["limit"].as_f64().unwrap());
        }
        if f["tows"].as_array().unwrap().is_empty() {
            released = true;
            break;
        }
    }
    assert!(released);
    let g = core.game.as_ref().unwrap();
    let d = g.actors[1].drive.as_ref().unwrap();
    assert_eq!((d.throttle, d.brake), (0.0, 1.0));
    assert!(
        d.velocity.x.abs() > 1.0,
        "rupture cannot zero real momentum"
    );
    assert!(
        g.actors[0].drive.as_ref().unwrap().velocity.x.abs() < 1e-8,
        "over-rating demand breaks before any excessive force reaches the tug"
    );
    assert_eq!(g.recoveries, 0);
}
#[test]
fn tow_native_slack_relation_changes_digest_and_bad_cold_load_is_atomic() {
    let mut core = world();
    let no_cable = call(&mut core, json!({"op":"digest","frame":false}));
    attach(&mut core);
    assert_eq!(row(&mut core)["tension"], json!(0.0));
    let digest = call(&mut core, json!({"op":"digest","frame":false}));
    assert_ne!(
        digest, no_cable,
        "a cable is physical state even while slack"
    );
    let before = row(&mut core);
    let saved = cold(&mut core);
    let mut broken = Vec::new();
    for (key, value) in [
        ("targetId", json!("missing")),
        ("partAId", json!("load:not-the-tug")),
        ("length", json!(20.0)),
        ("localB", json!({"x":5000.0,"y":0.0})),
    ] {
        let mut bad = saved.clone();
        bad["tows"][0][key] = value;
        broken.push(bad);
    }
    let mut duplicate = saved.clone();
    duplicate["tows"]
        .as_array_mut()
        .unwrap()
        .push(before.clone());
    broken.push(duplicate);
    for bad in broken {
        let error = core.load_game_value(&bad).unwrap_err();
        assert!(error.contains("TOW_STATE"), "{error}");
        assert_eq!(
            call(&mut core, json!({"op":"digest","frame":false})),
            digest
        );
        assert_eq!(row(&mut core), before);
    }
}
#[test]
#[cfg(not(target_arch = "wasm32"))]
fn tow_native_moving_cold_and_exact_photo_keep_the_relationship_and_progress() {
    let mut core = world_gravity(0.0);
    airborne(&mut core, 0.2);
    attach(&mut core);
    for _ in 0..3 {
        core.game_step(1.0 / 60.0).unwrap();
    }
    let cable = row(&mut core);
    assert!(cable["tension"].as_f64().unwrap() > 0.0);
    // A load moving faster than the attach gate is still a legal checkpoint, never replayed as a new coupling.
    call(
        &mut core,
        json!({"op":"setVehicleState","actorId":"load","state":{"vx":2.0}}),
    );
    let saved = cold(&mut core);
    let mut resumed = world_gravity(0.0);
    resumed.load_game_value(&saved).unwrap();
    let restored = row(&mut resumed);
    for key in [
        "actorId", "targetId", "partAId", "partBId", "localA", "localB", "length",
    ] {
        assert_eq!(restored[key], cable[key], "cold {key}");
    }
    assert_eq!(
        resumed.game.as_ref().unwrap().actors[1]
            .drive
            .as_ref()
            .unwrap()
            .velocity
            .x,
        2.0
    );
    let state = core.export_state().unwrap();
    let mut exact = world_gravity(0.0);
    exact.import_state(&state).unwrap();
    assert_eq!(row(&mut exact), row(&mut core));
    for _ in 0..60 {
        core.game_step(1.0 / 60.0).unwrap();
        exact.game_step(1.0 / 60.0).unwrap();
        assert_eq!(
            call(&mut exact, json!({"op":"digest","frame":false})),
            call(&mut core, json!({"op":"digest","frame":false}))
        );
    }
}

/// A tug and a load of the kinds named on `terrain`, of one side: the load behind the tug, 2 m from chassis end to chassis
/// end, both settled on their springs for five seconds and on no cable yet. The tug drives ahead to the left.
fn convoy(tug: &str, load: &str, terrain: Value) -> NativeWorld {
    let mut value = crate::game_damage::fixtures::stock_scene(
        &[(1, "tug", tug, 0.0), (2, "load", load, 20.0)],
        terrain,
    );
    for actor in value["actors"].as_array_mut().unwrap() {
        actor["team"] = json!("blue");
        actor["ownerId"] = json!("blue");
    }
    value["visualEvents"] = json!(false);
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    core.load_game_value(&value).unwrap();
    let x = {
        let game = core.game.as_ref().unwrap();
        let mut spans = [[f64::INFINITY, f64::NEG_INFINITY]; 2];
        for plate in &game.damage.plates {
            if plate.cold["definition"]["chassis"]["part"] != "frame" {
                continue;
            }
            let span = &mut spans[(plate.actor - 1) as usize];
            for p in game
                .geometry
                .shapes_world(plate.owner)
                .unwrap()
                .iter()
                .flatten()
            {
                span[0] = span[0].min(p.x);
                span[1] = span[1].max(p.x);
            }
        }
        game.actors[1].drive.as_ref().unwrap().pose.x + spans[0][1] + 2.0 - spans[1][0]
    };
    call(
        &mut core,
        json!({"op":"setVehicleState","actorId":"load","state":{"x":x,"vx":0.0,"vy":0.0}}),
    );
    for _ in 0..300 {
        core.game_step(1.0 / 60.0).unwrap();
    }
    core
}
/// What the load is on the cable: driven by its own engine, or with its engine destroyed, or with its tanks emptied.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Load {
    Engine,
    Broken,
    Dry,
}
fn ready(core: &mut NativeWorld, load: Load) {
    let parts = |kind| {
        core.game.as_ref().unwrap().damage.modules.iter()
            .filter(|m| m.actor == 2 && m.kind == kind)
            .map(|m| m.owner)
            .collect::<Vec<_>>()
    };
    let (engines, tanks) = (parts(ComponentKind::Engine), parts(ComponentKind::Fuel));
    match load {
        Load::Engine => {}
        Load::Broken => engines.iter().for_each(|&engine| {
            call(core, json!({"op":"setPartState","owner":engine,"state":{"health":0.0}}));
        }),
        Load::Dry => tanks.iter().for_each(|&tank| {
            call(core, json!({"op":"setPartState","owner":tank,"state":{"fuelLitres":0.0}}));
        }),
    }
    attach(core);
}
fn fuel(core: &NativeWorld, actor: u32) -> f64 {
    core.game.as_ref().unwrap().damage.modules.iter()
        .filter(|m| m.actor == actor && m.kind == ComponentKind::Fuel)
        .map(|m| m.fuel_litres)
        .sum()
}
fn drive_of(core: &NativeWorld, actor: usize) -> &DriveState {
    core.game.as_ref().unwrap().actors[actor].drive.as_ref().unwrap()
}
/// What a cable did over a run: the most it pulled with, and the most it went slack (below zero) and was drawn out by
/// beyond its length, in N and m; and whether it held to the end.
#[derive(Debug)]
struct Cable {
    peak: f64,
    slack: f64,
    drawn: f64,
    held: bool,
}
/// Drives the tug for `steps` on the throttle `throttle` gives for each, as the keyboard leaves it, and reads the cable
/// after every step; `each` sees the field after it.
fn run(
    core: &mut NativeWorld,
    steps: usize,
    throttle: impl Fn(usize) -> f64,
    mut each: impl FnMut(usize, &NativeWorld),
) -> Cable {
    let mut cable = Cable { peak: 0.0, slack: 0.0, drawn: 0.0, held: true };
    for i in 0..steps {
        call(
            core,
            json!({"op":"control","actorId":"tug","throttle":throttle(i),"brake":0.0,"frame":false}),
        );
        core.game_step(1.0 / 60.0).unwrap();
        let rows = core.game.as_ref().unwrap().tow_frame();
        if let Some(row) = rows.as_array().unwrap().first() {
            let tension = row["tension"].as_f64().unwrap();
            assert!(tension <= row["limit"].as_f64().unwrap());
            let out = Point::from_value(&row["anchorA"]).distance(Point::from_value(&row["anchorB"]))
                - row["length"].as_f64().unwrap();
            cable.peak = cable.peak.max(tension);
            cable.slack = cable.slack.min(out);
            cable.drawn = cable.drawn.max(out);
        } else {
            cable.held = false;
        }
        each(i, core);
    }
    assert_eq!(core.game.as_ref().unwrap().recoveries, 0);
    cable
}
/// The ordinary keyboard throttle rises to full in half a second, ahead to the left.
fn keyboard(i: usize) -> f64 {
    -((i + 1) as f64 / 30.0).min(1.0)
}
#[test]
fn tow_native_heavy_and_utility_pairs_start_with_the_manual_keyboard_ramp() {
    for (tug, load) in [("heavy", "heavy"), ("construction-truck", "supply")] {
        let mut core = convoy(tug, load, json!("flat"));
        ready(&mut core, Load::Broken);
        let start = drive_of(&core, 1).pose.x;
        let cable = run(&mut core, 720, keyboard, |_, _| {});
        assert!(cable.held, "{tug} → {load}: ordinary flat-ground startup broke");
        let travelled = start - drive_of(&core, 1).pose.x;
        assert!(
            travelled > 3.0,
            "{tug} → {load}: damaged load must actually roll: {travelled} m"
        );
        eprintln!(
            "tow ground {tug} → {load}: {travelled} m, peak {} N, extension {} m in 12 s",
            cable.peak, cable.drawn
        );
    }
}
/// Ground that rises at `grade` to the left from 6 m ahead of the tug, by `rise` metres, and is level again past it.
fn hill(grade: f64, rise: f64) -> Value {
    json!({"id":"flat","points":[{"x":-1600.0,"y":rise},{"x":-6.0 - rise / grade,"y":rise},{"x":-6.0,"y":0.0},{"x":1600.0,"y":0.0}]})
}
#[test]
fn tow_native_two_engines_climb_a_grade_the_tug_cannot_pull_its_load_up() {
    let (grade, rise) = (0.45, 20.0);
    let (foot, top) = (-6.0, -6.0 - rise / grade);
    // How long the tug takes from the foot of the grade to its top, as the run goes: its speed up the grade.
    let climb = |core: &mut NativeWorld, load: Option<Load>| {
        if let Some(load) = load {
            ready(core, load);
        }
        let (mut from, mut to) = (None, None);
        let cable = run(core, 1800, keyboard, |i, core| {
            let x = drive_of(core, 0).pose.x;
            if x < foot && from.is_none() {
                from = Some(i);
            }
            if x < top && to.is_none() {
                to = Some(i);
            }
        });
        let speed = from.zip(to).map(|(from, to)| (foot - top) / ((to - from) as f64 / 60.0));
        (cable, speed)
    };
    let mut solo = convoy("scout", "scout", hill(grade, rise));
    let (_, alone) = climb(&mut solo, None);
    let mut pulled = convoy("scout", "scout", hill(grade, rise));
    let (dead, stalled) = climb(&mut pulled, Some(Load::Broken));
    let mut both = convoy("scout", "scout", hill(grade, rise));
    let fuel_before = fuel(&both, 2);
    let (cable, together) = climb(&mut both, Some(Load::Engine));
    let alone = alone.expect("a scout climbs the grade on its own");
    assert!(stalled.is_none(), "one scout cannot pull another without power up {grade}");
    assert!(
        drive_of(&pulled, 0).pose.y < rise / 2.0,
        "it stalls low on the grade: {}",
        drive_of(&pulled, 0).pose.y
    );
    let together = together.expect("two scouts that both drive climb it together");
    assert!(cable.held && dead.held);
    for actor in 0..2 {
        assert!(drive_of(&both, actor).pose.y > rise, "both reach the top");
    }
    assert!(
        together > 0.8 * alone,
        "the load carries itself: the pair climbs nearly as fast as one alone ({together} against {alone} m/s)"
    );
    assert!(
        cable.peak < super::towing::TOW_LIMIT / 4.0 && cable.peak < dead.peak / 2.0,
        "the cable carries only what the load cannot: {} N against {} N pulled",
        cable.peak,
        dead.peak
    );
    assert!(fuel(&both, 2) < fuel_before, "the load burns its own fuel");
    eprintln!(
        "grade {grade}: alone {alone:.2} m/s, both driving {together:.2} m/s (peak {:.0} N), engine broken stalls at {:.1} m (peak {:.0} N)",
        cable.peak,
        drive_of(&pulled, 0).pose.y,
        dead.peak
    );
}
#[test]
fn tow_native_engaged_pair_brakes_together_down_a_grade() {
    let (grade, fall) = (0.3, 30.0);
    let down = json!({"id":"flat","points":[{"x":-1600.0,"y":-fall},{"x":-6.0 - fall / grade,"y":-fall},{"x":-6.0,"y":0.0},{"x":1600.0,"y":0.0}]});
    // Driven over the brow and down for four seconds, then let go: the tug brakes on its own, nobody driving it.
    let descend = |load: Load| {
        let mut core = convoy("scout", "scout", down.clone());
        ready(&mut core, load);
        let mut stood = None;
        let cable = run(&mut core, 720, |i| if i < 240 { keyboard(i) } else { 0.0 }, |i, core| {
            let still = (0..2).all(|a| hypot(drive_of(core, a).velocity.x, drive_of(core, a).velocity.y) < 0.05);
            if i > 240 && still && stood.is_none() {
                stood = Some(i);
            }
            if stood.is_some() {
                assert!(still, "once stood, both are held on their brakes at step {i}");
            }
        });
        (cable, stood, drive_of(&core, 0).pose.y)
    };
    let (cable, stood, low) = descend(Load::Engine);
    assert!(cable.held);
    let stood = stood.expect("the two stand still together on the grade");
    assert!(low > -fall + 1.0, "they stop on the grade itself, not at its foot");
    assert!(
        cable.slack > -0.2,
        "the load brakes with the tug instead of running on to it: {} m",
        cable.slack
    );
    let (dead, kept, _) = descend(Load::Broken);
    assert!(kept.is_none(), "a load without an engine is not braked: the tug alone does not hold the two");
    assert!(dead.slack < -1.0, "and it runs on to the tug: {} m", dead.slack);
    assert!(cable.peak < dead.peak / 4.0, "{} N against {} N", cable.peak, dead.peak);
    eprintln!(
        "down {grade}: both braking stand {:.1} s after letting go, slack {:.2} m, peak {:.0} N; engine broken: slack {:.2} m, peak {:.0} N",
        (stood - 240) as f64 / 60.0,
        cable.slack,
        cable.peak,
        dead.slack,
        dead.peak
    );
}
#[test]
fn tow_native_engaged_lorries_stop_together_from_speed_on_the_level() {
    // Ten seconds flat out, near 80 km/h, then the brake asked for in full, as the keyboard asks for it.
    let mut core = convoy("truck", "truck", json!("flat"));
    ready(&mut core, Load::Engine);
    let mut stood = None;
    for i in 0..960 {
        let (throttle, brake) = if i < 600 { (keyboard(i), 0.0) } else { (0.0, 1.0) };
        call(&mut core, json!({"op":"control","actorId":"tug","throttle":throttle,"brake":brake,"frame":false}));
        core.game_step(1.0 / 60.0).unwrap();
        if i == 599 {
            assert!(drive_of(&core, 0).velocity.x < -20.0, "{}", drive_of(&core, 0).velocity.x);
        }
        let row = core.game.as_ref().unwrap().tow_frame()[0].clone();
        let out = Point::from_value(&row["anchorA"]).distance(Point::from_value(&row["anchorB"])) - row["length"].as_f64().unwrap();
        assert!(out > -0.1 && out < 0.02, "both brake as one: the cable is out by {out} m at step {i}");
        if i > 600 && stood.is_none() && (0..2).all(|a| drive_of(&core, a).velocity.x.abs() < 0.05) {
            stood = Some(i);
        }
    }
    assert!(stood.is_some(), "the two stand still together");
}
/// Ground that rolls in waves `wave` m long, as steep as `slope` at the most.
fn rolling(slope: f64, wave: f64) -> Value {
    let rise = slope * wave / std::f64::consts::TAU;
    let points = (0..=1600)
        .map(|k| {
            let x = -1600.0 + 2.0 * k as f64;
            json!({"x":x,"y":rise * (std::f64::consts::TAU * x / wave).sin()})
        })
        .collect::<Vec<_>>();
    json!({"id":"flat","points":points})
}
#[test]
fn tow_native_engaged_lorries_stop_together_from_speed_over_rolling_ground() {
    // Over rolling ground the two stand on different slopes as they brake: the one behind, still running down into a
    // dip the other is climbing out of, cannot lose its speed as fast with all of its brake. The tug brakes no harder
    // than lets it follow, so the load closes on it by no more than half a metre and never runs into it, and the two
    // stand still together about as soon as they do on the level.
    for (terrain, steps) in [(rolling(0.07, 25.0), 700), (rolling(0.1, 60.0), 480)] {
        let mut core = convoy("truck", "truck", terrain);
        ready(&mut core, Load::Engine);
        let (mut slack, mut peak, mut stood) = (0.0_f64, 0.0_f64, None);
        for i in 0..steps + 400 {
            let (throttle, brake) = if i < steps { (keyboard(i), 0.0) } else { (0.0, 1.0) };
            call(&mut core, json!({"op":"control","actorId":"tug","throttle":throttle,"brake":brake,"frame":false}));
            core.game_step(1.0 / 60.0).unwrap();
            if i < steps {
                continue;
            }
            let row = core.game.as_ref().unwrap().tow_frame()[0].clone();
            let out = Point::from_value(&row["anchorA"]).distance(Point::from_value(&row["anchorB"])) - row["length"].as_f64().unwrap();
            slack = slack.min(out);
            peak = peak.max(row["tension"].as_f64().unwrap());
            if stood.is_none() && (0..2).all(|a| drive_of(&core, a).velocity.x.abs() < 0.05) {
                stood = Some(i - steps);
            }
        }
        assert!(slack > -0.55, "the load closes on its tug by {slack} m");
        assert!(peak < 0.05 * super::towing::TOW_LIMIT, "the cable takes up with {peak} N");
        assert!(stood.is_some_and(|s| s < 300), "the two stand still together within five seconds: {stood:?}");
    }
}
#[test]
fn tow_native_engaged_start_takes_no_snatch_and_burns_both_tanks() {
    for kind in ["scout", "heavy"] {
        let start = |load: Load| {
            let mut core = convoy(kind, kind, json!("flat"));
            ready(&mut core, load);
            let tanks = [fuel(&core, 1), fuel(&core, 2)];
            let cable = run(&mut core, 720, keyboard, |_, _| {});
            (cable, [tanks[0] - fuel(&core, 1), tanks[1] - fuel(&core, 2)], core)
        };
        let (cable, burned, core) = start(Load::Engine);
        let (dead, dead_burned, _) = start(Load::Broken);
        assert!(cable.held && dead.held);
        assert!(
            cable.peak < 2500.0 && cable.peak * 10.0 < dead.peak,
            "{kind}: both pulling away, the cable hardly pulls: {} N against {} N",
            cable.peak,
            dead.peak
        );
        assert!(
            cable.slack > -0.01 && cable.drawn < 0.01,
            "{kind}: the cable stays at its length: [{}, {}] m",
            cable.slack,
            cable.drawn
        );
        assert!(burned[0] > 0.0 && burned[1] > 0.0 && dead_burned[1] == 0.0, "{burned:?} {dead_burned:?}");
        let (tug, load) = (drive_of(&core, 0), drive_of(&core, 1));
        assert!((tug.velocity.x - load.velocity.x).abs() < 0.05);
        eprintln!(
            "{kind} start: peak {:.0} N both driving against {:.0} N pulled; {:.1} m/s after 12 s; burned {:.3} + {:.3} L",
            cable.peak,
            dead.peak,
            -tug.velocity.x,
            burned[0],
            burned[1]
        );
    }
}
#[test]
#[cfg(not(target_arch = "wasm32"))]
fn tow_native_pace_is_read_from_the_field_and_resumes_exactly() {
    let mut core = convoy("scout", "scout", hill(0.25, 10.0));
    ready(&mut core, Load::Engine);
    run(&mut core, 120, keyboard, |_, _| {});
    // Nothing of the pace is kept beside the field: an exact photo goes on as the field itself does.
    let state = core.export_state().unwrap();
    let mut exact = convoy("scout", "scout", hill(0.25, 10.0));
    exact.import_state(&state).unwrap();
    for i in 120..240 {
        for world in [&mut core, &mut exact] {
            call(
                world,
                json!({"op":"control","actorId":"tug","throttle":keyboard(i),"brake":0.0,"frame":false}),
            );
            world.game_step(1.0 / 60.0).unwrap();
        }
        assert_eq!(
            call(&mut exact, json!({"op":"digest","frame":false})),
            call(&mut core, json!({"op":"digest","frame":false}))
        );
    }
    assert!(drive_of(&core, 1).throttle != 0.0, "the load drives itself up the grade");
}
#[test]
fn tow_native_load_without_fuel_is_pulled_as_before_and_drives_once_refuelled() {
    let mut core = convoy("scout", "scout", json!("flat"));
    ready(&mut core, Load::Dry);
    let start = drive_of(&core, 1).pose.x;
    let cable = run(&mut core, 480, |i| 0.6 * keyboard(i), |_, core| {
        let load = drive_of(core, 1);
        assert_eq!((load.throttle, load.brake), (0.0, 0.0), "pulled: its controls let go, no brake held");
        assert_eq!(load.fuel_rate, 0.0);
    });
    assert!(cable.held && cable.peak > 0.0, "the cable pulls it");
    assert!(start - drive_of(&core, 1).pose.x > 3.0, "it rolls behind the tug");
    assert_eq!(fuel(&core, 2), 0.0);
    // Fuel brought to it on the cable: from the next step it keeps pace on its own engine.
    let tank = owner(&core, 2, ComponentKind::Fuel);
    call(&mut core, json!({"op":"setPartState","owner":tank,"state":{"fuelLitres":50.0}}));
    let mut driven = 0;
    run(&mut core, 120, |i| 0.6 * keyboard(480 + i), |_, core| {
        driven += usize::from(drive_of(core, 1).throttle != 0.0);
    });
    assert!(driven > 100, "refuelled, it drives itself: {driven} of 120 steps");
    assert!(fuel(&core, 2) < 50.0);
}
#[test]
fn tow_native_load_with_its_running_gear_destroyed_is_pulled_whatever_its_engine() {
    let mut core = convoy("truck", "tracked", json!("flat"));
    let tracks = core.game.as_ref().unwrap().damage.modules.iter()
        .filter(|m| m.actor == 2 && m.kind == ComponentKind::Track)
        .map(|m| m.owner)
        .collect::<Vec<_>>();
    assert!(!tracks.is_empty());
    for track in tracks {
        call(&mut core, json!({"op":"setPartState","owner":track,"state":{"health":0.0}}));
    }
    ready(&mut core, Load::Engine);
    let start = drive_of(&core, 1).pose.x;
    let cable = run(&mut core, 480, |i| 0.6 * keyboard(i), |i, core| {
        let load = drive_of(core, 1);
        if i > 0 {
            assert_eq!((load.throttle, load.brake), (0.0, 0.0), "nothing of it to drive: pulled at step {i}");
        }
    });
    assert!(cable.held && start - drive_of(&core, 1).pose.x > 3.0);
}
#[test]
fn tow_native_engaged_pair_backs_together() {
    // Backing to the right, the tug comes on to its load: one that drives itself backs away ahead of it.
    let back = |i: usize| -keyboard(i);
    let mut core = convoy("scout", "scout", json!("flat"));
    ready(&mut core, Load::Engine);
    let start = [drive_of(&core, 0).pose.x, drive_of(&core, 1).pose.x];
    let cable = run(&mut core, 600, back, |_, _| {});
    let moved = [drive_of(&core, 0).pose.x - start[0], drive_of(&core, 1).pose.x - start[1]];
    assert!(cable.held && moved[0] > 20.0, "{moved:?}");
    assert!((moved[0] - moved[1]).abs() < 0.1, "they back as one: {moved:?}");
    assert!(cable.slack > -0.05 && cable.drawn < 0.02, "[{}, {}] m", cable.slack, cable.drawn);
    let mut dead = convoy("scout", "scout", json!("flat"));
    ready(&mut dead, Load::Broken);
    let pushed = run(&mut dead, 600, back, |_, _| {});
    assert!(pushed.slack < -1.0, "a load without an engine is run on to: {} m", pushed.slack);
}
#[test]
fn tow_native_engaged_pair_crosses_a_step_in_mud_and_a_drop_without_snatching() {
    let mud = json!({"id":"flat","points":[{"x":-1600.0,"y":0.3},{"x":-12.0,"y":0.3},{"x":-11.95,"y":0.0},{"x":1600.0,"y":0.0}],
        "sectors":[{"start":-1600.0,"end":1600.0,"surface":"mud"}]});
    let drop = json!({"id":"flat","points":[{"x":-1600.0,"y":-0.4},{"x":-12.0,"y":-0.4},{"x":-11.95,"y":0.0},{"x":1600.0,"y":0.0}]});
    // How hard the cable comes taut as the load meets the step is a matter of the phase it meets it in: a heavy pair that
    // drives over it in mud snatches at 58–64 kN and draws its cable out by 12–13 cm with the drag of the air a percent or
    // two more or less than it is, and at 94 kN and 19 cm with it as it is (2026-10-30), where a dead load snatches at
    // 130–138 kN. Each is held to no more than these shares of the limit of the cable and of what a dead load snatches
    // with, and to drawing its cable out by no more than this.
    for (name, kind, ground, (limit, share, drawn)) in [("step in mud", "heavy", mud, (1.0 / 3.0, 0.75, 0.2)),
        ("drop", "scout", drop.clone(), (0.25, 0.6, 0.15)), ("drop", "heavy", drop, (0.25, 0.6, 0.15))] {
        let cross = |load: Load| {
            let mut core = convoy(kind, kind, ground.clone());
            ready(&mut core, load);
            let cable = run(&mut core, 720, keyboard, |_, _| {});
            (cable, drive_of(&core, 1).pose.x)
        };
        let ((cable, at), (dead, _)) = (cross(Load::Engine), cross(Load::Broken));
        assert!(cable.held && at < -40.0, "{kind} over the {name}: {at}");
        assert!(
            cable.peak < super::towing::TOW_LIMIT * limit && cable.peak < share * dead.peak,
            "{kind} over the {name}: {} N against {} N pulled",
            cable.peak,
            dead.peak
        );
        assert!(cable.slack > -0.1 && cable.drawn < drawn, "{kind} over the {name}: [{}, {}] m", cable.slack, cable.drawn);
        eprintln!("{kind} over the {name}: peak {:.0} N, cable [{:.3}, {:.3}] m; engine broken: peak {:.0} N", cable.peak, cable.slack, cable.drawn, dead.peak);
    }
}
