//! An aircraft takes a vehicle up on a sling (game_towing.rs `Tow::sling`): from a hook on its frame under its centre of
//! mass to a ring over the centre of mass of the load, as the core runs a field. The load hangs level, the flight computer
//! holds its height with it, the sling reaches further than a cable on the ground, snaps over its limit and is kept and
//! taken back as it was.
use super::*;

const DT: f64 = 1.0 / 60.0;
/// The scout built as an aircraft, on skids where its wheels were, with two thrusters upright on either side of its
/// middle and two leant out 45° beyond them, each 1.3 times the reference size, over its hull (game_hover_tests.rs).
fn aircraft() -> Value {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    let mut source = crate::game_templates::source("scout", &json!({}), catalogue).unwrap();
    let leant = [(-1.6, 4.5, 0.0), (1.6, 4.5, 0.0), (-3.2, 4.5, std::f64::consts::FRAC_PI_4), (3.2, 4.5, -std::f64::consts::FRAC_PI_4)];
    for (i, &(x, y, angle)) in leant.iter().enumerate() {
        source["components"].as_array_mut().unwrap().push(json!({"id":format!("lift{i}"),"kind":"thruster","metal":"titanium",
            "sizeScale":1.3,"pose":{"x":x/crate::game_construction::CELL,"y":y/crate::game_construction::CELL,"angle":angle}}));
    }
    let chassis = source["chassis"].as_object_mut().unwrap();
    chassis.insert("model".into(), json!("aircraft"));
    for key in ["axles", "track", "gearScale"] {
        chassis.remove(key);
    }
    crate::game_construction::seated(&source, catalogue)
}
/// A light truck: the stock truck chassis without its cab, as tests/helpers/aircraft.js builds its aircraft from it.
fn light() -> Value {
    let mut source = crate::game_templates::source("chassis", &json!({}), crate::game_damage::fixtures::full_catalogue()).unwrap();
    source["plates"] = json!([]);
    source["nodes"] = json!([]);
    source
}
fn template(name: &str) -> Value {
    crate::game_templates::source(name, &json!({}), crate::game_damage::fixtures::full_catalogue()).unwrap()
}
/// The aircraft `fly` at the middle of flat ground and a load of `load` 20 m off, of one side.
fn scene(load: Value) -> Value {
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", aircraft(), 0.0, false), (2, "load", load, 20.0, false)], json!("flat"));
    for actor in scene["actors"].as_array_mut().unwrap() {
        actor["team"] = json!("blue");
        actor["ownerId"] = json!("blue");
    }
    scene["visualEvents"] = json!(false);
    scene
}
fn field(scene: &Value) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    core.load_game_value(scene).unwrap();
    core
}
fn call(core: &mut NativeWorld, request: Value) -> Result<Value, String> {
    core.game_command_value(&request).map(|text| serde_json::from_str::<Value>(&text).unwrap()["result"].clone())
}
fn frame(core: &mut NativeWorld) -> Value {
    serde_json::from_str(&core.current_frame().unwrap()).unwrap()
}
fn run(core: &mut NativeWorld, seconds: f64) {
    for _ in 0..(seconds / DT).round() as usize {
        core.game_step(DT).unwrap();
    }
}
fn ask(core: &mut NativeWorld, throttle: f64, rise: f64) {
    call(core, json!({"op":"input","actorId":"fly","input":{"type":"drive","phase":"before","throttle":throttle,"brake":0,"rise":rise}})).unwrap();
}
fn drive(core: &NativeWorld, id: &str) -> DriveState {
    core.game.as_ref().unwrap().actors.iter().find(|a| a.id == id).unwrap().drive.clone().unwrap()
}
fn put(core: &mut NativeWorld, id: &str, x: f64, y: f64) {
    call(core, json!({"op":"setVehicleState","actorId":id,"state":{"x":x,"y":y,"vx":0.0,"vy":0.0,"omega":0.0,"angle":0.0}})).unwrap();
}
fn attach(core: &mut NativeWorld) -> Result<Value, String> {
    call(core, json!({"op":"towAttach","actorId":"fly","targetId":"load"}))
}
/// The aircraft taken off and come to a hover plumb over the load where that stands, its hook `gap` metres over the ring.
fn over(load: Value, gap: f64) -> (NativeWorld, Value) {
    let scene = scene(load);
    let mut core = field(&scene);
    run(&mut core, 1.0);
    ask(&mut core, 0.0, 0.3);
    run(&mut core, 0.5);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 1.0);
    let (hook, ring) = {
        let g = core.game.as_ref().unwrap();
        (g.tow_hook(1).unwrap().world, g.tow_ring(2).unwrap().world)
    };
    let a = drive(&core, "fly");
    put(&mut core, "fly", a.pose.x + ring.x - hook.x, a.pose.y + ring.y + gap - hook.y);
    // Asked for next to nothing a step, it takes where it was put as where it hovers.
    ask(&mut core, 1e-9, 1e-9);
    run(&mut core, DT);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 6.0);
    assert!(drive(&core, "fly").flying && drive(&core, "load").grounded, "it hovers over the load standing on the ground");
    (core, scene)
}
fn row(core: &mut NativeWorld) -> Value {
    frame(core)["tows"][0].clone()
}

#[test]
fn the_hook_is_under_the_centre_of_mass_of_the_aircraft_and_the_ring_over_that_of_the_load() {
    let (core, _) = over(light(), 5.0);
    let g = core.game.as_ref().unwrap();
    let (a, b) = (drive(&core, "fly"), drive(&core, "load"));
    let (hook, ring) = (g.tow_hook(1).unwrap(), g.tow_ring(2).unwrap());
    // On its frame plumb under its centre, in its hull: and on a beam of its frame.
    assert!((hook.local.x - a.carrier_center.x).abs() < 1e-9 && hook.local.y <= a.carrier_center.y, "{:?} {:?}", hook.local, a.carrier_center);
    assert!(g.tow_anchor_valid(1, hook.part, hook.local));
    // Plumb over the centre of the load, clear of its top, held by a bridle from the ends of the beam of its frame.
    let top = g.actors[1].contact_contours.iter().flatten().flatten().map(|p| p.y).fold(f64::MIN, f64::max);
    assert!((ring.local.x - b.carrier_center.x).abs() < 1e-9 && ring.local.y >= top + 0.99, "{:?} {top}", ring.local);
    assert!(g.tow_ring_valid(2, ring.part, ring.local) && !g.tow_anchor_valid(2, ring.part, ring.local));
}

#[test]
fn a_load_taken_up_hangs_level_under_the_aircraft_and_its_flight_computer_holds_its_height() {
    let (mut core, _) = over(light(), 5.0);
    assert_eq!(attach(&mut core).unwrap(), json!(true));
    let cable = row(&mut core);
    assert_eq!(cable["sling"], json!(true));
    assert!((cable["length"].as_f64().unwrap() - 5.0).abs() < 0.2, "{cable}");
    let load = drive(&core, "load");
    assert_eq!((load.throttle, load.brake), (0.0, 1.0), "the load stands on its brakes");
    // Taken up 4 m, then let be.
    let start = drive(&core, "fly").center().y;
    ask(&mut core, 0.0, 0.2);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 12.0);
    let held = drive(&core, "fly").center().y;
    let mut sway = (0.0_f64, f64::MAX, f64::MIN, 0.0_f64);
    for _ in 0..(6.0 / DT) as usize {
        core.game_step(DT).unwrap();
        let (a, b) = (drive(&core, "fly"), drive(&core, "load"));
        sway = (sway.0.max(b.pose.angle.abs()), sway.1.min(a.center().y), sway.2.max(a.center().y), sway.3.max(a.pose.angle.abs()));
        assert!(!b.grounded, "it hangs");
    }
    let (a, b, cable) = (drive(&core, "fly"), drive(&core, "load"), row(&mut core));
    let weight = b.carrier_mass * 9.81;
    eprintln!("sling hang: start {start:.2} held {held:.2} sway {sway:?} tension {} weight {weight}", cable["tension"]);
    assert!(held > start + 2.0, "it took the load up: {start} to {held}");
    assert!(sway.0 < 0.03, "the load hangs level: {} rad", sway.0);
    assert!(sway.2 - sway.1 < 0.1 && sway.3 < 0.03, "the aircraft holds its height and its hull level with the load on: {sway:?}");
    // The cable carries the load, plumb under the hook.
    let (pa, pb) = (Point::from_value(&cable["anchorA"]), Point::from_value(&cable["anchorB"]));
    assert!((cable["tension"].as_f64().unwrap() - weight).abs() < 0.05 * weight, "{} N for {weight} N", cable["tension"]);
    assert!((pa.x - pb.x).abs() < 0.1 && (b.center().x - a.center().x).abs() < 0.3, "{pa:?} {pb:?}");
}

#[test]
fn a_sling_reaches_fifteen_metres_and_a_cable_on_the_ground_still_four() {
    let (mut core, _) = over(light(), 14.5);
    assert_eq!(attach(&mut core).unwrap(), json!(true));
    assert!((row(&mut core)["length"].as_f64().unwrap() - 14.5).abs() < 0.2);
    let (mut core, _) = over(light(), 15.5);
    assert!(attach(&mut core).unwrap_err().contains("TOW_REACH"));
    // A tug of the ground 6 m off its load reaches it no more than before.
    let mut ground = crate::game_damage::fixtures::stock_scene(&[(1, "fly", "scout", 0.0), (2, "load", "scout", 10.8)], json!("flat"));
    for actor in ground["actors"].as_array_mut().unwrap() {
        actor["team"] = json!("blue");
        actor["ownerId"] = json!("blue");
    }
    let mut core = field(&ground);
    run(&mut core, 1.0);
    assert!(attach(&mut core).unwrap_err().contains("TOW_REACH"));
}

#[test]
fn thrusters_pull_without_an_engine_and_take_up_no_more_than_they_hold_up_with_the_margin_of_the_oficina() {
    let (mut core, _) = over(light(), 5.0);
    let engine = core.game.as_ref().unwrap().damage.modules.iter().find(|m| m.actor == 1 && m.kind == ComponentKind::Engine).unwrap().owner;
    call(&mut core, json!({"op":"setPartState","owner":engine,"state":{"health":0.0}})).unwrap();
    assert_eq!(attach(&mut core).unwrap(), json!(true), "its thrusters are its motor");
    // A tracked chassis of 12 t weighs more than they hold up with the aircraft, a quarter to spare.
    let (mut core, _) = over(template("tracked"), 5.0);
    let g = core.game.as_ref().unwrap();
    let weight = (drive(&core, "fly").carrier_mass + drive(&core, "load").carrier_mass) * 9.81;
    assert!(g.tow_lift(1) < 1.25 * weight && g.tow_lift(1) > weight * 0.5, "{} N for {weight} N", g.tow_lift(1));
    assert!(attach(&mut core).unwrap_err().contains("TOW_HEAVY"));
}

#[test]
fn a_sling_snaps_over_its_limit_and_lets_the_load_fall_as_it_moved() {
    let (mut core, _) = over(light(), 5.0);
    attach(&mut core).unwrap();
    ask(&mut core, 0.0, 0.2);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 4.0);
    assert_eq!(frame(&mut core)["tows"].as_array().unwrap().len(), 1);
    // The load sent down at 20 m/s: the cable stops it in a few centimetres, harder than it is rated for.
    call(&mut core, json!({"op":"setVehicleState","actorId":"load","state":{"vy":-20.0}})).unwrap();
    let mut released = None;
    for _ in 0..10 {
        let f: Value = serde_json::from_str(&core.game_step(DT).unwrap()).unwrap();
        for cable in f["tows"].as_array().unwrap() {
            assert!(cable["tension"].as_f64().unwrap() <= cable["limit"].as_f64().unwrap());
        }
        if let Some(event) = f["events"].as_array().into_iter().flatten().find(|e| e["type"] == "tow-release") {
            released = Some(event["reason"].clone());
        }
        if f["tows"].as_array().unwrap().is_empty() {
            break;
        }
    }
    assert_eq!(released, Some(json!("tension")));
    assert!(drive(&core, "load").velocity.y < -10.0, "it falls on as it moved");
    let load = drive(&core, "load");
    assert_eq!((load.throttle, load.brake), (0.0, 1.0));
}

#[test]
fn a_sling_is_kept_and_taken_back_as_a_sling_and_goes_on_as_it_would() {
    let (mut core, mut scene) = over(light(), 5.0);
    attach(&mut core).unwrap();
    ask(&mut core, 0.0, 0.2);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 3.0);
    let cable = row(&mut core);
    assert!(cable["tension"].as_f64().unwrap() > 0.0);
    // Cold, from the frame and the canonical sources, as a host keeps a field.
    let full = core.game.as_mut().unwrap().frame();
    for (kind, identity) in [("actors", "id"), ("modules", "owner")] {
        for authored in scene[kind].as_array_mut().unwrap() {
            let live = full[kind].as_array().unwrap().iter().find(|live| live[identity] == authored[identity]).unwrap();
            authored.as_object_mut().unwrap().extend(live.as_object().unwrap().clone());
        }
    }
    for authored in scene["plates"].as_array_mut().unwrap() {
        let live = full["plates"].as_array().unwrap().iter().find(|live| live["owner"] == authored["owner"]).unwrap();
        authored.as_object_mut().unwrap().extend(live["damage"].as_object().unwrap().clone());
        authored["definition"].as_object_mut().unwrap().extend(live["pose"].as_object().unwrap().clone());
        for key in ["vx", "vy", "omega", "age", "sleeping"] {
            authored[key] = live["motion"][key].clone();
        }
    }
    for key in ["time", "tick", "randomState", "nextId", "stats", "recoveries"] {
        scene[key] = full[key].clone();
    }
    scene["tows"] = json!([{"actorId":cable["actorId"],"targetId":cable["targetId"],"partAId":cable["partAId"],"partBId":cable["partBId"],
        "localA":cable["localA"],"localB":cable["localB"],"length":cable["length"]}]);
    let mut resumed = field(&scene);
    let restored = row(&mut resumed);
    for key in ["actorId", "targetId", "partAId", "partBId", "localA", "localB", "length", "sling"] {
        assert_eq!(restored[key], cable[key], "cold {key}");
    }
    let load = drive(&resumed, "load");
    assert_eq!((load.throttle, load.brake), (0.0, 1.0));
    run(&mut resumed, 3.0);
    let (a, b, kept) = (drive(&resumed, "fly"), drive(&resumed, "load"), row(&mut resumed));
    assert!(!b.grounded && a.flying && kept["sling"] == json!(true), "it goes on holding the load up");
    assert!((kept["tension"].as_f64().unwrap() - b.carrier_mass * 9.81).abs() < 0.1 * b.carrier_mass * 9.81, "{}", kept["tension"]);
    // An exact photo goes on step for step as the field it was taken of.
    let state = core.export_state().unwrap();
    let mut exact = field(&scene);
    exact.import_state(&state).unwrap();
    assert_eq!(row(&mut exact), row(&mut core));
    for _ in 0..60 {
        core.game_step(DT).unwrap();
        exact.game_step(DT).unwrap();
        assert_eq!(call(&mut exact, json!({"op":"digest","frame":false})), call(&mut core, json!({"op":"digest","frame":false})));
    }
    // A sling stretched past its reach is not taken back.
    scene["tows"][0]["length"] = json!(15.5);
    assert!(NativeWorld::new(&[], 0.0, -9.81).unwrap().load_game_value(&scene).unwrap_err().contains("TOW_STATE"));
}

/// The aircraft hovering over the light truck with it taken up 4 m off the ground on a 5 m sling.
fn carrying() -> NativeWorld {
    let (mut core, _) = over(light(), 5.0);
    attach(&mut core).unwrap();
    ask(&mut core, 0.0, 0.2);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 6.0);
    core
}

#[test]
fn flown_along_the_field_the_load_trails_and_swings_and_let_be_both_come_to_rest() {
    let mut core = carrying();
    let height = drive(&core, "fly").center().y;
    ask(&mut core, 1.0, 0.0);
    let (mut trail, mut tilt) = (0.0_f64, 0.0_f64);
    for _ in 0..(4.0 / DT) as usize {
        core.game_step(DT).unwrap();
        trail = trail.max((drive(&core, "load").center().x - drive(&core, "fly").center().x).abs());
        tilt = tilt.max(drive(&core, "load").pose.angle.abs());
    }
    let (fast, gone) = (drive(&core, "fly").velocity.x, drive(&core, "fly").center().x);
    ask(&mut core, 0.0, 0.0);
    for _ in 0..(25.0 / DT) as usize {
        core.game_step(DT).unwrap();
        tilt = tilt.max(drive(&core, "load").pose.angle.abs());
    }
    let mut swing = 0.0_f64;
    for _ in 0..(5.0 / DT) as usize {
        core.game_step(DT).unwrap();
        swing = swing.max((drive(&core, "load").center().x - drive(&core, "fly").center().x).abs());
    }
    let (a, b) = (drive(&core, "fly"), drive(&core, "load"));
    eprintln!("sling swing: tilt {tilt:.3}, fast {fast:.2} m/s, trail {trail:.2} m, swing after {swing:.3} m, v {:?} {:?}, height {:.2} from {height:.2}, gone {gone:.1}", a.velocity, b.velocity, a.center().y);
    assert!(fast.abs() > 3.0 && trail > 0.3, "it went with the load trailing: {fast} m/s, {trail} m");
    assert!(tilt < 0.6, "sped up and stopped as hard as it is asked, it is sped up and stopped gently (`SLUNG`): {tilt} rad");
    assert!(swing < 0.1 && hypot(a.velocity.x, a.velocity.y) < 0.05 && hypot(b.velocity.x, b.velocity.y) < 0.05, "the swing is taken out: {swing} m");
    assert!((a.center().y - height).abs() < 1.0 && !b.grounded && frame(&mut core)["tows"].as_array().unwrap().len() == 1);
}

/// Flown flat out along the field for 20 s, as its pilot flies it to a place far off, it speeds up the two of them steadily
/// (`SLUNG`), and the load comes to trail it by as much as that leans the cable, swinging less and less, not more and more
/// each swing (`FOLLOW`).
#[test]
fn flown_flat_out_a_long_way_the_load_comes_to_trail_it_steady() {
    let mut core = carrying();
    ask(&mut core, 1.0, 0.0);
    let (mut first, mut last, mut tilt) = ((f64::INFINITY, f64::NEG_INFINITY), (f64::INFINITY, f64::NEG_INFINITY), 0.0_f64);
    for step in 0..(20.0 / DT) as usize {
        core.game_step(DT).unwrap();
        let (a, b) = (drive(&core, "fly"), drive(&core, "load"));
        let trail = b.center().x - a.center().x;
        let span = if step < (8.0 / DT) as usize { &mut first } else if step >= (14.0 / DT) as usize { &mut last } else { continue };
        *span = (span.0.min(trail), span.1.max(trail));
        tilt = tilt.max(b.pose.angle.abs());
    }
    let fast = drive(&core, "fly").velocity.x;
    eprintln!("sling flat out: {fast:.1} m/s, trail {first:?} then {last:?}, tilt {tilt:.3}");
    assert!(fast > 20.0, "it went on speeding up: {fast} m/s");
    assert!(last.1 - last.0 < 0.3 && last.1 - last.0 < (first.1 - first.0) / 3.0 && last.1 < -0.5, "the load trails it steady: {first:?} then {last:?}");
    assert!(tilt < 0.35, "and is not swung up: {tilt} rad");
}

#[test]
fn coming_down_with_a_load_its_flight_computer_sets_the_load_down_as_it_would_set_down_itself() {
    // Asked down, by half or by all of it, the load is lowered no faster than `LOWERED`, slowed gently (`LOWERING`), and
    // touches at about what the aircraft would touch at (`TOUCH`), the cable springing a little: slower than the ground
    // marks the bare skin of what it stands on at (0.886 m/s, `contact_damage`).
    for (rise, most) in [(-0.5, 0.65), (-1.0, 0.65)] {
        let mut core = carrying();
        ask(&mut core, 0.0, rise);
        let mut touched = None;
        for _ in 0..(20.0 / DT) as usize {
            core.game_step(DT).unwrap();
            let b = drive(&core, "load");
            if b.grounded {
                touched = Some(b.velocity.y);
                break;
            }
        }
        let load = touched.expect("the load comes down");
        eprintln!("sling set down: asked {rise}, touched at {load:.3} m/s");
        assert!(load > -most, "asked down by {rise}, it sets the load down at {load} m/s");
        // Down there the cable goes slack, and the aircraft goes on down by itself.
        run(&mut core, 1.5);
        let tension = row(&mut core)["tension"].as_f64().unwrap();
        assert!(tension < 0.05 * drive(&core, "load").carrier_mass * 9.81 && drive(&core, "load").grounded, "{tension} N");
    }
}

#[test]
fn a_load_set_rocking_on_its_sling_is_let_be_still_in_a_few_swings() {
    // The truck on its 5 m sling set turning at 0.4 rad/s, as a knock would: it rocks about its ring and swings the cable
    // with it, and the aircraft going the way the top of it rocks (`FOLLOW`) has it still in a few swings.
    let mut core = carrying();
    call(&mut core, json!({"op":"setVehicleState","actorId":"load","state":{"omega":0.4}})).unwrap();
    let most = |core: &mut NativeWorld, time: f64| {
        let mut most = (0.0_f64, 0.0_f64);
        for _ in 0..(time / DT) as usize {
            core.game_step(DT).unwrap();
            let (a, b) = (drive(core, "fly"), drive(core, "load"));
            most = (most.0.max(b.pose.angle.abs()), most.1.max((b.center().x - a.center().x).abs()));
        }
        most
    };
    let rocked = most(&mut core, 5.0);
    most(&mut core, 10.0);
    let still = most(&mut core, 5.0);
    eprintln!("sling rocking: {rocked:?} then {still:?}");
    assert!(rocked.0 > 0.1, "it rocked: {rocked:?}");
    assert!(still.0 < 0.02 && still.1 < 0.05 && !drive(&core, "load").grounded, "it is still: {still:?}");
}
