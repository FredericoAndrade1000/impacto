//! The flight computer through the core as a field runs it: an aircraft takes off from its skids, hovers, keeps level,
//! shares out its thrust, goes as fast as its thrust holds it to against the air, burns its fuel, falls when it cannot
//! hold itself up and comes down in time to be set down on its skids. A scout on wheels with thrusters, as a field saved
//! before there were aircraft holds one, flies as one does.
use super::*;
use crate::game_hover::{CLEARANCE, IDLE_SHARE, LEAN, SPECIFIC_FUEL, TOUCH};
use crate::game_motion::FUEL_KG_PER_LITRE;

const DT: f64 = 1.0 / 60.0;
/// A scout with thrusters, each `(x, y, angle, size)` in metres and radians of its design, put over its hull.
fn wheeled(thrusters: &[(f64, f64, f64, f64)]) -> Value {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    let mut source = crate::game_templates::source("scout", &json!({}), catalogue).unwrap();
    for (i, &(x, y, angle, size)) in thrusters.iter().enumerate() {
        source["components"].as_array_mut().unwrap().push(json!({"id":format!("lift{i}"),"kind":"thruster","metal":"titanium",
            "sizeScale":size,"pose":{"x":x/crate::game_construction::CELL,"y":y/crate::game_construction::CELL,"angle":angle}}));
    }
    source
}
/// That scout built as an aircraft, on skids where its wheels were.
fn flier(thrusters: &[(f64, f64, f64, f64)]) -> Value {
    let mut source = wheeled(thrusters);
    let chassis = source["chassis"].as_object_mut().unwrap();
    chassis.insert("model".into(), json!("aircraft"));
    for key in ["axles", "track", "gearScale"] {
        chassis.remove(key);
    }
    crate::game_construction::seated(&source, crate::game_damage::fixtures::full_catalogue())
}
fn world(thrusters: &[(f64, f64, f64, f64)]) -> NativeWorld {
    field(flier(thrusters))
}
fn field(source: Value) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", source, 0.0, false)], json!("flat"));
    scene["visualEvents"] = json!(false);
    core.load_game_value(&scene).unwrap();
    core
}
/// Two of the reference thruster at one and a half times its size, on either side of the middle, over the hull.
const PAIR: [(f64, f64, f64, f64); 2] = [(-1.6, 4.5, 0.0, 1.5), (1.6, 4.5, 0.0, 1.5)];
/// Two upright and two leant out at 45° beyond them, which push it along the field as well as up: with two alone, what
/// pushes it one way would turn it as well.
const LEANT: [(f64, f64, f64, f64); 4] = [(-1.6, 4.5, 0.0, 1.3), (1.6, 4.5, 0.0, 1.3),
    (-3.2, 4.5, std::f64::consts::FRAC_PI_4, 1.3), (3.2, 4.5, -std::f64::consts::FRAC_PI_4, 1.3)];
fn ask(core: &mut NativeWorld, throttle: f64, rise: f64) {
    core.game_command_value(&json!({"op":"input","actorId":"fly","input":{"type":"drive","phase":"before","throttle":throttle,"brake":0,"rise":rise}}))
        .unwrap();
}
fn run(core: &mut NativeWorld, seconds: f64) {
    for _ in 0..(seconds / DT).round() as usize {
        core.game_advance(DT).unwrap();
    }
}
fn game(core: &NativeWorld) -> &GameState {
    core.game.as_ref().unwrap()
}
fn drive(core: &NativeWorld) -> &DriveState {
    game(core).actors[0].drive.as_ref().unwrap()
}
fn center(core: &NativeWorld) -> Point {
    drive(core).center()
}
fn thrusters(core: &NativeWorld) -> Vec<&Module> {
    game(core).damage.modules.iter().filter(|m| m.kind == ComponentKind::Thruster).collect()
}
fn fuel(core: &NativeWorld) -> f64 {
    game(core).damage.modules.iter().filter(|m| m.kind == ComponentKind::Fuel).map(|m| m.fuel_litres).sum()
}
fn weight(core: &NativeWorld) -> f64 {
    drive(core).carrier_mass * 9.81
}
/// What its thrusters push it with together now, along the field and up, in the air they breathe where it flies.
fn pushing(core: &NativeWorld) -> Point {
    let breathes = crate::game_flight::thrust_share(center(core).y);
    thrusters(core).iter().fold(Point::ZERO, |sum, m| {
        let push = m.thrust * m.kind.thrust_n(m.volume) * breathes;
        Point::new(sum.x - m.pose.angle.sin() * push, sum.y + m.pose.angle.cos() * push)
    })
}
fn along(core: &NativeWorld) -> f64 {
    pushing(core).x
}
fn air(core: &NativeWorld) -> &crate::game_motion::Powertrain {
    &game(core).actors[0].powertrain
}
/// Takes off on a share of what its key asks and comes to a hover some metres up.
fn hovering(thrusters: &[(f64, f64, f64, f64)]) -> NativeWorld {
    taken_up(world(thrusters))
}
fn taken_up(mut core: NativeWorld) -> NativeWorld {
    ask(&mut core, 0.0, 0.3);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 8.0);
    core
}

#[test]
fn an_aircraft_with_nothing_asked_stands_on_its_skids_and_takes_off_when_asked_to_climb() {
    let mut core = world(&PAIR);
    run(&mut core, 1.0);
    let rest = center(&core);
    assert!(drive(&core).grounded && !drive(&core).flying && thrusters(&core).iter().all(|m| m.thrust == 0.0),
        "it stands on its skids burning nothing");
    let (litres, before) = (fuel(&core), rest.y);
    run(&mut core, 1.0);
    assert!((center(&core).y - before).abs() < 1e-3 && fuel(&core) == litres);
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 0.5);
    let d = drive(&core);
    assert!(d.flying && !d.grounded, "it flies: {:?}", (d.flying, d.grounded));
    // All of its thrust over its weight speeds it up, as much of it as holds it level.
    let spare = (pushing(&core).y - weight(&core)) / d.carrier_mass;
    let speeding = d.velocity.y;
    run(&mut core, 0.5);
    let gained = (drive(&core).velocity.y - speeding) / 0.5;
    assert!((gained - spare).abs() < 0.1 * spare, "{gained} m/s² for {spare}");
    assert!(center(&core).y > rest.y + 1.0, "it climbs: {} from {}", center(&core).y, rest.y);
}

#[test]
fn flat_out_it_goes_as_fast_as_the_air_lets_its_thrust_take_it() {
    // Straight up, until what holds it back over its hull is what its thrusters push it up with over its weight.
    let mut core = world(&PAIR);
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 25.0);
    let d = drive(&core);
    let k = air(&core).air(d.pose.angle, d.velocity, -1.0, center(&core).y);
    let terminal = ((pushing(&core).y - weight(&core)) / k).sqrt();
    assert!(d.velocity.y > 6.0 && (d.velocity.y - terminal).abs() < 0.02 * terminal, "{} m/s for {terminal}", d.velocity.y);
    // Along the field, until the air holds it back by as much as its thrusters push it along with: to the right, the
    // other way from where its design faces, leant as far as they hold it up at its height, by what it shows the air
    // astern and, leant so, over it. Its thrusters, grown in length and height alone, push it with less than they would
    // grown across the body as well: it is given 40 s to come to that speed, over level ground that goes on for 8 km.
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", flier(&LEANT), 0.0, false)],
        json!({"id":"flat","points":[{"x":-1600,"y":0},{"x":8000,"y":0}]}));
    scene["visualEvents"] = json!(false);
    core.load_game_value(&scene).unwrap();
    let mut core = taken_up(core);
    let height = center(&core).y;
    ask(&mut core, 1.0, 0.0);
    run(&mut core, 2.0);
    let early = drive(&core).pose.angle;
    run(&mut core, 38.0);
    let d = drive(&core);
    let terminal = (along(&core) / air(&core).air(d.pose.angle, d.velocity, -1.0, center(&core).y)).sqrt();
    assert!(d.velocity.x > 20.0 && (d.velocity.x - terminal).abs() < 0.03 * terminal, "{} m/s for {terminal}", d.velocity.x);
    // Leant as far as they hold it up at its height, which the air it meets changes a little as it speeds up.
    assert!(early < -0.1 && early >= -LEAN && (d.pose.angle - early).abs() < 0.02, "leant {early} rad, then {} rad", d.pose.angle);
    assert!((center(&core).y - height).abs() < 0.5, "at its height: {} from {height}", center(&core).y);
    // Let go, it is slowed to a hover with what its thrusters give the other way, and held there — its tanks filled again
    // for it, after so long flat out.
    for m in &mut core.game.as_mut().unwrap().damage.modules {
        if m.kind == ComponentKind::Fuel { m.fuel_litres = m.capacity_litres; }
    }
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 20.0);
    let d = drive(&core);
    assert!(d.velocity.x.abs() < 0.05 && d.station.0.is_some(), "{:?}", d.velocity);
    assert!((center(&core).y - height).abs() < 0.5, "{} from {height}", center(&core).y);
}

#[test]
fn with_nothing_asked_it_hovers_still_and_level_where_it_came_to_a_hover() {
    let mut core = hovering(&PAIR);
    let (at, d) = (center(&core), drive(&core));
    assert!(d.flying && d.station.0.is_some() && d.station.1.is_some(), "{:?}", d.station);
    run(&mut core, 10.0);
    let d = drive(&core);
    assert!(center(&core).distance(at) < 0.02, "it stays where it hovers: {:?} from {:?}", center(&core), at);
    assert!(d.pose.angle.abs() < 1e-3 && d.omega.abs() < 1e-3, "level: {} rad", d.pose.angle);
    assert!(d.velocity.x.abs() < 1e-3 && d.velocity.y.abs() < 1e-3, "{:?}", d.velocity);
    // What its thrusters give together holds up its weight, and no more.
    let given = pushing(&core).y;
    assert!((given - weight(&core)).abs() < 0.01 * weight(&core), "{given} N for {} N", weight(&core));
}

#[test]
fn pushed_and_turned_it_is_damped_back_level_to_where_it_hovered() {
    let mut core = hovering(&LEANT);
    let at = center(&core);
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"vx":4.0,"vy":-2.0,"omega":0.8}})).unwrap();
    run(&mut core, 0.5);
    assert!(drive(&core).pose.angle.abs() > 0.05, "the blow turned it: {}", drive(&core).pose.angle);
    run(&mut core, 9.5);
    let d = drive(&core);
    assert!(d.pose.angle.abs() < 0.01 && d.omega.abs() < 0.01, "level again: {} rad, {} rad/s", d.pose.angle, d.omega);
    assert!(hypot(d.velocity.x, d.velocity.y) < 0.05, "still again: {:?}", d.velocity);
    assert!(center(&core).distance(at) < 0.3, "back where it hovered: {:?} from {:?}", center(&core), at);
}

#[test]
fn thrusters_unlike_and_off_the_middle_share_out_what_keeps_it_level() {
    // A large thruster near the middle and a small one far out on the other side: each takes the share that balances the
    // other about the centre of mass.
    let mut core = hovering(&[(-0.9, 4.5, 0.0, 1.7), (2.6, 4.5, 0.0, 1.2)]);
    let at = center(&core);
    run(&mut core, 5.0);
    let d = drive(&core);
    assert!(d.flying && d.pose.angle.abs() < 2e-3 && center(&core).distance(at) < 0.02, "{} rad, {:?}", d.pose.angle, center(&core));
    let pushes: Vec<(f64, f64)> = thrusters(&core).iter().map(|m| (m.pose.x - center(&core).x, m.thrust * m.kind.thrust_n(m.volume))).collect();
    let moment: f64 = pushes.iter().map(|(arm, push)| arm * push).sum();
    assert!(moment.abs() < 0.01 * weight(&core), "{pushes:?}: {moment} N·m left");
    // The one nearer the middle pushes as much more as the other is farther out.
    let ratio = pushes[0].1 / pushes[1].1;
    assert!((ratio - pushes[1].0 / -pushes[0].0).abs() < 0.01 * ratio, "{pushes:?}");
}

#[test]
fn thrusters_leant_both_ways_take_it_along_the_field_at_the_height_it_was() {
    let mut core = hovering(&LEANT);
    let at = center(&core);
    ask(&mut core, 1.0, 0.0);
    run(&mut core, 4.0);
    let d = drive(&core);
    assert!(d.velocity.x > 10.0, "it goes along the field the way its key asks: {} m/s", d.velocity.x);
    assert!((center(&core).y - at.y).abs() < 0.5, "at the height it was: {} from {}", center(&core).y, at.y);
    assert!(d.pose.angle < 0.0 && d.pose.angle >= -LEAN, "leant the way it goes, no further than it leans: {}", d.pose.angle);
    // A touch of its key asks no more than its thrusters push it along with level: it goes level, pushed by them, and by
    // half as much for half as much of its key.
    let touched = |share: f64| {
        let mut core = hovering(&LEANT);
        ask(&mut core, share, 0.0);
        run(&mut core, 3.0);
        assert!(drive(&core).pose.angle.abs() < 1e-3 && drive(&core).velocity.x > share, "level: {} rad", drive(&core).pose.angle);
        along(&core)
    };
    let (part, half) = (touched(0.2), touched(0.1));
    assert!((half / part - 0.5).abs() < 0.02, "{half} N of {part} N");
    // Let go, it comes to a hover again.
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 10.0);
    assert!(hypot(drive(&core).velocity.x, drive(&core).velocity.y) < 0.05, "{:?}", drive(&core).velocity);
}

#[test]
fn too_little_thrust_does_its_best_and_falls() {
    // Two small thrusters push with less than the scout weighs: flat out, it does not leave the ground. No aircraft is
    // built so; one on wheels from before them stands on a field.
    let mut core = field(wheeled(&[(-1.6, 4.5, 0.0, 0.8), (1.6, 4.5, 0.0, 0.8)]));
    run(&mut core, 1.0);
    let rest = center(&core).y;
    assert!(drive(&core).thrust_n < weight(&core));
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 3.0);
    assert!(center(&core).y < rest + 0.5, "it stays down: {} from {}", center(&core).y, rest);
    // As level as it is held, the one that holds up more of it flat out.
    let shares: Vec<f64> = thrusters(&core).iter().map(|m| m.thrust).collect();
    assert!(shares.iter().any(|share| *share > 0.99) && shares.iter().all(|share| *share > 0.8), "flat out: {shares:?}");
    // Put up in the air, it falls however it is asked to climb.
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":rest+60.0,"vy":0.0}})).unwrap();
    run(&mut core, 2.0);
    assert!(drive(&core).velocity.y < -5.0, "{}", drive(&core).velocity.y);
}

#[test]
fn thrust_all_on_one_side_of_its_centre_of_mass_cannot_hold_it_up_level() {
    let mut core = field(wheeled(&[(2.4, 4.5, 0.0, 1.5), (3.4, 4.5, 0.0, 1.5)]));
    run(&mut core, 1.0);
    let rest = center(&core).y;
    assert!(drive(&core).thrust_n > weight(&core), "it has the thrust, on one side");
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 3.0);
    let d = drive(&core);
    assert!(center(&core).y < rest + 2.0 || d.pose.angle.abs() > 0.3, "it neither climbs level: {} from {}, {} rad", center(&core).y, rest, d.pose.angle);
}

#[test]
fn a_thruster_destroyed_in_a_hover_unbalances_it() {
    let mut core = hovering(&PAIR);
    let at = center(&core);
    let lost = game(&core).damage.modules.iter().position(|m| m.kind == ComponentKind::Thruster).unwrap();
    core.game.as_mut().unwrap().damage.modules[lost].health = 0.0;
    run(&mut core, 3.0);
    let d = drive(&core);
    assert!(at.y - center(&core).y > 2.0 || d.pose.angle.abs() > 0.3, "{:?} from {:?}, {} rad", center(&core), at, d.pose.angle);
    assert_eq!(game(&core).damage.modules[lost].thrust, 0.0);
}

#[test]
fn a_hover_burns_what_its_thrust_takes_at_the_rate_of_a_lift_jet() {
    let mut core = hovering(&PAIR);
    let litres = fuel(&core);
    run(&mut core, 2.0);
    let burned = litres - fuel(&core);
    let shares: Vec<f64> = thrusters(&core).iter().map(|m| m.thrust).collect();
    assert!(shares.iter().all(|share| *share > IDLE_SHARE), "{shares:?}");
    let expected = SPECIFIC_FUEL * weight(&core) / FUEL_KG_PER_LITRE * 2.0 / 3600.0;
    assert!((burned - expected).abs() < 0.03 * expected, "{burned} L for {expected} L");
    let rate = drive(&core).fuel_rate;
    assert!((rate - expected * 1800.0).abs() < 0.03 * expected * 1800.0, "{rate} L/h");
    // With the tanks dry, it falls.
    for m in &mut core.game.as_mut().unwrap().damage.modules {
        if m.kind == ComponentKind::Fuel { m.fuel_litres = 0.0; }
    }
    run(&mut core, 1.0);
    let d = drive(&core);
    assert!(!d.flying && d.velocity.y < -5.0 && thrusters(&core).iter().all(|m| m.thrust == 0.0), "{}", d.velocity.y);
}

#[test]
fn asked_down_it_falls_with_its_thrusters_idling_and_burns_hard_at_the_last_to_be_set_down_on_its_skids_and_burns_no_more() {
    // Upright thrusters, two leant in with its weight off the middle of them, which hold it up level by less than all
    // they push it up with, and upright ones with jets along the hull, which hold it up by nothing: from 300 m, each falls
    // as fast as the air lets it until its thrusters must slow it, then is slowed by most of all they can to touch the
    // ground at `TOUCH` — never climbing back, in a fraction of the time and the fuel coming down at 3 m/s would take.
    for design in [&PAIR[..], &OFF_THE_MIDDLE[..], &JETS[..]] {
        let mut core = hovering(design);
        let at = center(&core).y;
        let before = fuel(&core);
        run(&mut core, 1.0);
        let hovers = before - fuel(&core);
        core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":drive(&core).pose.y+300.0,"vy":0.0}})).unwrap();
        let start = fuel(&core);
        ask(&mut core, 0.0, -1.0);
        let (mut fastest, mut touched, mut falling, mut idled, mut burns, mut most, mut climbed, mut took) =
            (0.0_f64, None, [0.0_f64; 3], 0, 0, 0.0_f64, 0.0_f64, 0.0);
        for _ in 0..(60.0 / DT) as usize {
            core.game_advance(DT).unwrap();
            took += DT;
            let d = drive(&core);
            fastest = fastest.min(d.velocity.y);
            climbed = climbed.max(d.velocity.y);
            // How many times it is burnt for — its thrusters pushing with more than they idle at, after a tenth of a second
            // or more idling — until it is held to touch, a metre or so over the ground, and how hard it is slowed.
            let thrust = thrusters(&core).iter().map(|m| m.thrust).fold(0.0, f64::max);
            if thrust <= IDLE_SHARE {
                idled += 1;
            } else {
                if idled >= 6 && center(&core).y - at > 1.0 {
                    burns += 1;
                }
                idled = 0;
            }
            most = most.max(thrust);
            // How fast it fell as it came onto the ground, the step or two before it is told it stands on it.
            if d.grounded && touched.is_none() {
                touched = Some(falling.into_iter().fold(0.0, f64::min));
            }
            falling = [falling[1], falling[2], d.velocity.y];
            if !d.flying {
                break;
            }
        }
        let d = drive(&core);
        let litres = start - fuel(&core);
        assert!(!d.flying && d.grounded, "set down: {:?}", (d.flying, d.grounded));
        assert!(fastest < -20.0 && burns == 1, "it falls as fast as it falls, to {fastest} m/s, and is burnt for once: {burns} times");
        assert!(most > 0.8 && climbed < 0.05, "and is slowed with {most} of its thrust, climbing back at {climbed} m/s at the most");
        assert!(touched.is_some_and(|v| v > -TOUCH - 0.05), "and touches the ground at a walk: {touched:?}");
        assert!(took < 0.25 * 100.0 && litres < 0.25 * 100.0 * hovers, "in {took} s on {litres} L, where hovering down it would burn {} L", 100.0 * hovers);
        assert!(game(&core).damage.plates.iter().all(|p| p.dents.is_empty()) && game(&core).damage.modules.iter().all(|m| m.health >= m.max_health), "unharmed");
        ask(&mut core, 0.0, 0.0);
        run(&mut core, 2.0);
        let (litres, rest) = (fuel(&core), center(&core));
        run(&mut core, 2.0);
        assert!(fuel(&core) == litres && center(&core).distance(rest) < 1e-3 && rest.y < at, "it stands on its skids burning nothing");
        assert!(thrusters(&core).iter().all(|m| m.thrust == 0.0));
    }
}

#[test]
fn a_round_flies_between_the_skids_of_an_aircraft_as_a_line_of_sight_does_not() {
    // Straight down through the middle of its runner, and across the middle of a leg, a few centimetres either way.
    let core = world(&PAIR);
    let game = game(&core);
    let part = |name: &str| game.damage.plates.iter().find(|p| p.cold["definition"]["id"] == name).unwrap();
    for name in ["fly:chassis:skid-0", "fly:chassis:leg-0"] {
        let plate = part(name);
        let (start, end) = if name.contains("skid") {
            (Point::new(plate.pose.x, plate.pose.y + 0.05), Point::new(plate.pose.x, plate.pose.y - 0.05))
        } else {
            (Point::new(plate.pose.x - 0.05, plate.pose.y), Point::new(plate.pose.x + 0.05, plate.pose.y))
        };
        let round = crate::game_geometry::RayOptions { projectile: true, ..Default::default() };
        assert!(game.geometry.raycast(start, end, &round).is_none_or(|hit| hit.owner != plate.owner), "{name}");
        assert_eq!(game.geometry.raycast(start, end, &Default::default()).map(|hit| hit.owner), Some(plate.owner), "{name}");
    }
}

#[test]
fn a_flier_out_of_the_fight_falls() {
    let mut core = hovering(&PAIR);
    core.game_command_value(&json!({"op":"input","actorId":"fly","input":{"type":"release","phase":"before","defeated":true}})).unwrap();
    run(&mut core, 1.0);
    assert!(!drive(&core).flying && drive(&core).velocity.y < -3.0);
}

#[test]
fn a_drop_ends_at_the_speed_the_air_holds_it_to_and_a_hard_landing_harms_the_gear() {
    // No thruster: the air holds the hull back by what it shows under it, the way it falls.
    let mut core = field(wheeled(&[]));
    // The air it falls through thickens under it: falling at v, it is slowed down by v²/2H to what the air holds it to
    // lower down, and so falls faster than the air where it is holds it to, by √(1 + v²/2Hg).
    let (k, m) = (game(&core).actors[0].powertrain.drag_under, drive(&core).carrier_mass);
    let terminal = |y: f64| (m * 9.81 / (k * crate::game_flight::air_density(y) / crate::game_flight::AIR_DENSITY)).sqrt();
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":8000.0,"vy":-1.4*terminal(8000.0)}})).unwrap();
    run(&mut core, 30.0);
    let (v, there) = (drive(&core).velocity.y, terminal(center(&core).y));
    let thickening = (1.0 + v * v / (2.0 * crate::game_flight::SCALE_HEIGHT * 9.81)).sqrt();
    assert!((-v / (there * thickening) - 1.0).abs() < 0.01, "{v} m/s for {there}, thickening by {thickening}");
    // Dropped from 40 m, it lands at some 28 m/s: its gear takes it.
    let mut core = field(wheeled(&[]));
    run(&mut core, 1.0);
    let rest = center(&core).y;
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":drive(&core).pose.y+40.0,"vy":0.0}})).unwrap();
    run(&mut core, 5.0);
    assert!((center(&core).y - rest).abs() < 1.0, "it is down");
    assert!(game(&core).damage.modules.iter().any(|m| m.kind.gear() && m.health < m.max_health), "the landing harmed its gear");
}

#[test]
fn the_air_holds_a_hull_back_by_the_side_it_shows_the_way_it_goes() {
    let p = crate::game_motion::Powertrain { drag: 2.0, drag_astern: 3.0, drag_over: 8.0, drag_under: 9.0, ..Default::default() };
    // Facing left, as a design is drawn: it drives ahead to the left and backs to the right.
    assert_eq!(p.air(0.0, Point::new(-3.0, 0.0), -1.0, 0.0), 2.0);
    assert_eq!(p.air(0.0, Point::new(3.0, 0.0), -1.0, 0.0), 3.0);
    assert_eq!(p.air(0.0, Point::new(3.0, 0.0), 1.0, 0.0), 2.0, "mirrored, it drives ahead to the right");
    assert_eq!(p.air(0.0, Point::new(0.0, 5.0), -1.0, 0.0), 8.0);
    assert_eq!(p.air(0.0, Point::new(0.0, -5.0), -1.0, 0.0), 9.0);
    assert!((p.air(0.0, Point::new(-1.0, 1.0), -1.0, 0.0) - 10.0 / 2.0_f64.sqrt()).abs() < 1e-12);
    // A hull stood on its nose shows the air what is over it as it moves along the field, the way its top points.
    assert!((p.air(std::f64::consts::FRAC_PI_2, Point::new(-4.0, 0.0), -1.0, 0.0) - 8.0).abs() < 1e-12);
    assert_eq!(p.air(0.3, Point::ZERO, -1.0, 0.0), 0.0);
}

#[test]
fn a_thruster_is_titanium_turned_by_eighths_and_paid_from_ligas() {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    let compiled = |angle: f64, metal: Option<&str>| {
        let mut source = json!({"version":crate::game_construction::CONSTRUCTION_VERSION,"preset":"bunker","nodes":[],"plates":[],
            "components":[{"id":"lift","kind":"thruster","pose":{"x":0,"y":20,"angle":angle}}]});
        if let Some(metal) = metal { source["components"][0]["metal"] = json!(metal); }
        crate::game_construction::compile(&source, catalogue)
    };
    let thruster = compiled(-3.0 * std::f64::consts::FRAC_PI_4, Some("titanium")).unwrap();
    let module = &thruster["compiled"]["modules"][0];
    assert_eq!(module["thrustN"], 23_350.0);
    assert!((module["physicalMass"].as_f64().unwrap() - 127.2).abs() < 1e-9, "{}", module["physicalMass"]);
    assert_eq!(thruster["construction"]["components"][0]["pose"]["angle"], -3.0 * std::f64::consts::FRAC_PI_4);
    for angle in [0.5, std::f64::consts::FRAC_PI_6] {
        let error = compiled(angle, Some("titanium")).unwrap_err();
        assert_eq!(error["code"], "THRUSTER_ANGLE", "{error}");
    }
    for metal in [None, Some("steel"), Some("aluminum")] {
        assert_eq!(compiled(0.0, metal).unwrap_err()["code"], "FIELD", "{metal:?}");
    }
    let price = crate::game_cost::piece(module, catalogue).unwrap();
    assert_eq!((price["engines"].as_f64(), price["kept"].as_f64()), (Some(2400.0), Some(0.0)), "{price}");
}

#[test]
fn the_oficina_is_told_whether_its_thrusters_lift_a_design_and_hold_it_up_still() {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    let flight = |thrusters: &[(f64, f64, f64, f64)]| {
        crate::game_construction::request(&json!({"version":1,"construction":flier(thrusters),"catalogue":catalogue,"draft":true})).unwrap()["compiled"]["flight"].clone()
    };
    let told = |thrusters: &[(f64, f64, f64, f64)]| { let f = flight(thrusters); (f["lifts"].clone(), f["balanced"].clone()) };
    assert_eq!(flight(&[]), Value::Null, "a design with none is told nothing");
    assert_eq!(told(&PAIR), (json!(true), json!(true)));
    assert_eq!(told(&LEANT), (json!(true), json!(true)));
    assert_eq!(told(&[(-1.6, 4.5, 0.0, 0.5), (1.6, 4.5, 0.0, 0.5)]), (json!(false), json!(false)));
    assert_eq!(told(&[(2.4, 4.5, 0.0, 1.5), (3.4, 4.5, 0.0, 1.5)]), (json!(true), json!(false)), "all on one side");
    let down: Vec<_> = PAIR.iter().map(|&(x, y, _, size)| (x, y, std::f64::consts::PI, size)).collect();
    assert_eq!(told(&down), (json!(false), json!(false)), "turned down, they push nothing up");
    // Hovering full, it burns what holds its weight up: 108 kg of fuel for each kN an hour (`SPECIFIC_FUEL`).
    let weight = crate::game_construction::request(&json!({"version":1,"construction":flier(&PAIR),"catalogue":catalogue,"draft":true}))
        .unwrap()["compiled"]["fixedAssembly"]["mass"].as_f64().unwrap() * crate::game_flight::GRAVITY;
    let burns = flight(&PAIR)["hoverLitres"].as_f64().unwrap();
    assert!((burns - SPECIFIC_FUEL * weight / FUEL_KG_PER_LITRE / 3600.0).abs() < 0.02 * burns, "{burns} L/s for {weight} N");
    // And, for its pilot to reckon how it comes down, what they push it up with at the most and hold it level — upright
    // either side of the middle, all they push it with but what the one further from its centre of mass is held back by;
    // none of it, all on one side — and what they burn idling.
    let pushes = |thrusters: &[(f64, f64, f64, f64)]| {
        let compiled = crate::game_construction::request(&json!({"version":1,"construction":flier(thrusters),"catalogue":catalogue,"draft":true}))
            .unwrap()["compiled"].clone();
        let thrust: f64 = compiled["modules"].as_array().unwrap().iter().filter(|m| m["kind"] == "thruster").map(|m| m["thrustN"].as_f64().unwrap()).sum();
        (compiled["flight"]["liftN"].as_f64().unwrap(), compiled["flight"]["idleLitres"].as_f64().unwrap(), thrust)
    };
    let (held, idles, thrust) = pushes(&PAIR);
    let idling = SPECIFIC_FUEL * IDLE_SHARE * thrust / FUEL_KG_PER_LITRE / 3600.0;
    assert!(held < thrust && held > 0.9 * thrust && (idles - idling).abs() < 1e-6 * idling, "{held} N, {idles} L/s, of {thrust} N");
    let (held, _, thrust) = pushes(&[(2.4, 4.5, 0.0, 1.5), (3.4, 4.5, 0.0, 1.5)]);
    assert!(held < 1e-6 * thrust, "all on one side: {held} N of {thrust} N");
}

#[test]
fn with_its_centre_of_mass_gone_past_its_upright_thrusters_a_jet_that_turns_it_back_lets_them_hold_it_up_leant_a_little() {
    // In its weight and the reach of its inertia, as its flight computer shares them out (`column`): a large upright
    // just behind its centre of mass and a small one far behind turn it the same way, as when the tanks ahead of them run
    // dry; a jet laid along the hull over that centre turns it back as it pushes it along the field.
    let held = crate::game_hover::held_up;
    let (main, small, jet) = ([0.0, 1.0, -0.05], [0.0, 0.3, -3.0], [-1.5, 0.0, 2.0]);
    assert_eq!(held(&[main, small]), 0.0, "on its upright thrusters alone, nothing holds it up level");
    // All of the large one, for which the jet pushes it along by 0.0375 of its weight, and of the small one as much as
    // keeps all the jet pushes it along with to what leaning it 15° bears of all they hold it up with.
    let up = held(&[main, small, jet]);
    let along = 1.5 * (0.05 + (up - 1.0) / 0.1) / 2.0;
    assert!(up > 1.0 && up < 1.1 && (along - (15.0_f64).to_radians().tan() * up).abs() < 1e-9, "{up} of its weight, pushed along by {along}");
    // With the large one further behind, the jet pushes it along by more than that for it alone: it hovers on it leant
    // further, and the small one, which would lean it further still, holds it up by none.
    assert_eq!(held(&[[0.0, 1.0, -0.5], small, jet]), 1.0);
    // With its upright thrusters either side of that centre, the jet adds nothing: they hold it up level as they did.
    let (ahead, behind) = ([0.0, 1.0, 0.5], [0.0, 1.0, -1.0]);
    assert!((held(&[ahead, behind]) - 1.5).abs() < 1e-12 && held(&[ahead, behind, jet]) == held(&[ahead, behind]));
}

#[test]
fn leant_far_over_on_a_thruster_at_its_centre_of_mass_it_is_turned_back_no_faster_than_its_jet_can_without_pushing_it_the_other_way() {
    // In its weight and the reach of its inertia, as a level hull gives them (`column`): a large upright through its
    // centre of mass, which turns it neither way; a small one far ahead, which turns it one way; and a jet laid along the
    // hull over that centre, the only one that turns it the other way, pushing it ahead as it does. Leant 51° back
    // (`leant`), asked to go back by 0.645 of its weight and held up — its keys ask it along (`ASKED`) —, and to be turned
    // 11° forward of that, as its pilot asks it a little less: the jet alone gives that turn, and turned as fast as that
    // (all of it asked of it as it holds its spin) the jet pushes it ahead by most of its weight while it is asked back.
    let lean = 0.894_f64;
    let level = [[0.0, 2.0, 0.0], [0.0, 0.59, 0.88], [3.24, 0.0, -1.46]];
    let columns: Vec<[f64; 3]> = level.iter().map(|c| [lean.cos() * c[0] - lean.sin() * c[1], lean.sin() * c[0] + lean.cos() * c[1], c[2]]).collect();
    let costs = [2.0, 0.59, 3.24];
    let given = |shares: &[f64]| (0..3).map(|k| columns.iter().zip(shares).map(|(c, s)| c[k] * s).sum::<f64>()).collect::<Vec<f64>>();
    let (asked, weights, turn) = ([-0.645, 0.918], [0.01, 1.0, 2.0], -0.6);
    let mut whole = vec![0.48, 0.58, 0.04];
    crate::game_hover::turned_out(&columns, &costs, asked, weights, &mut whole, turn, 0.0);
    let pushed = given(&whole);
    assert!(pushed[0] > 0.5 && (pushed[2] - turn).abs() < 0.1, "turned as asked, pushed {pushed:?}");
    // Turned no faster than pushes it ahead by `TURN_COST` of its weight more than turning it slower would: pushed ahead by
    // a seventh of its weight at the most, held up, and turned forward by more than half of what it is asked to be.
    let mut shares = vec![0.48, 0.58, 0.04];
    crate::game_hover::turned_out(&columns, &costs, asked, weights, &mut shares, 0.0, turn);
    let pushed = given(&shares);
    assert!(pushed[0] < 0.15 && (pushed[1] - asked[1]).abs() < 0.1, "pushed {pushed:?} for {asked:?}");
    assert!(pushed[2] < 0.5 * turn && pushed[2] > 0.7 * turn, "turned by {} of {turn}", pushed[2]);
    // With an upright thruster either side of its centre of mass, which turn it either way pushing it along as they hold it
    // up, it is turned as fast as it is asked.
    let pair: Vec<[f64; 3]> = [[0.0, 1.5, -1.5], [0.0, 1.5, 1.5]].iter()
        .map(|c: &[f64; 3]| [lean.cos() * c[0] - lean.sin() * c[1], lean.sin() * c[0] + lean.cos() * c[1], c[2]]).collect();
    let mut shares = vec![0.5, 0.5];
    crate::game_hover::turned_out(&pair, &[1.5, 1.5], asked, weights, &mut shares, 0.0, turn);
    let torque: f64 = pair.iter().zip(&shares).map(|(c, s)| c[2] * s).sum();
    assert!((torque - turn).abs() < 1e-3, "turned by {torque} of {turn}");
}

/// Two of the reference thruster at 1.7 times its size leant 45° in over the hull, the one behind further out than the
/// one ahead: their thrust lines meet over a point to one side of its centre of mass, and level what they push it with
/// holds it up with no torque only pushing it along the field as well.
const OFF_THE_MIDDLE: [(f64, f64, f64, f64); 2] = [(-1.6, 4.5, -std::f64::consts::FRAC_PI_4, 1.7), (2.4, 4.5, std::f64::consts::FRAC_PI_4, 1.7)];
/// Two upright, and two jets laid along the hull, one under its centre of mass and one over it: what they push it with is
/// all along the field, and they turn it either way.
const JETS: [(f64, f64, f64, f64); 4] = [(-1.6, 4.5, 0.0, 1.5), (1.6, 4.5, 0.0, 1.5),
    (4.4, 0.2, std::f64::consts::FRAC_PI_2, 1.5), (4.4, 2.6, std::f64::consts::FRAC_PI_2, 1.5)];
/// The same with its two upright larger: they hold it up by more than half its weight over it.
const STRONG_JETS: [(f64, f64, f64, f64); 4] = [(-1.6, 4.5, 0.0, 1.8), (1.6, 4.5, 0.0, 1.8),
    (4.4, 0.2, std::f64::consts::FRAC_PI_2, 1.5), (4.4, 2.6, std::f64::consts::FRAC_PI_2, 1.5)];
/// And with one large upright near its middle and a small one far behind, which turn it one way hard and the other
/// way little: the jets turn it the other way better.
const LOPSIDED: [(f64, f64, f64, f64); 4] = [(0.8, 4.5, 0.0, 2.0), (-3.0, 4.5, 0.0, 1.3),
    (4.4, 0.2, std::f64::consts::FRAC_PI_2, 1.5), (4.4, 2.6, std::f64::consts::FRAC_PI_2, 1.5)];
/// Where the thrust lines of its two thrusters meet, in the field.
fn meeting(core: &NativeWorld) -> Point {
    let lines: Vec<(Point, Point)> = thrusters(core).iter().map(|m| (Point::new(m.pose.x, m.pose.y), Point::new(-m.pose.angle.sin(), m.pose.angle.cos()))).collect();
    let ((p, u), (q, w)) = (lines[0], lines[1]);
    let t = Point::new(q.x - p.x, q.y - p.y).cross(w) / u.cross(w);
    Point::new(p.x + t * u.x, p.y + t * u.y)
}
fn oficina(thrusters: &[(f64, f64, f64, f64)]) -> Value {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    crate::game_construction::request(&json!({"version":1,"construction":flier(thrusters),"catalogue":catalogue,"draft":true})).unwrap()["compiled"]["flight"].clone()
}

/// Takes off on all of what its key asks and comes to a hover well over the ground, high enough to lean as far as it leans.
fn aloft(thrusters: &[(f64, f64, f64, f64)]) -> NativeWorld {
    let mut core = world(thrusters);
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 12.0);
    core
}

#[test]
fn slowed_from_going_the_way_its_jets_push_it_as_it_comes_to_where_it_is_sent_its_jets_do_not_push_it_on() {
    // Flown flat out the way its jets push it, then slowed as hard as it slows, and, a little faster than 12 m/s, slowed
    // less, as its pilot slows it coming to where it is sent: its upright thrusters, leant back, hold it up and slow it,
    // and its jets — pointing up the way it goes — are given next to nothing: holding it up or levelling it as well as
    // the uprights do, they would push it on, and it would stop half a second later or more.
    for design in [&LOPSIDED[..], &STRONG_JETS[..]] {
        let mut core = aloft(design);
        ask(&mut core, -1.0, 0.0);
        run(&mut core, 3.0);
        ask(&mut core, 1.0, 0.0);
        while drive(&core).velocity.x < -12.0 {
            core.game_advance(DT).unwrap();
        }
        ask(&mut core, 0.4, 0.0);
        let (at, mut pushed, mut lowest, mut stopped) = (center(&core).y, 0.0, center(&core).y, 0.0);
        while drive(&core).velocity.x < 0.0 && stopped < 4.0 {
            core.game_advance(DT).unwrap();
            pushed += thrusters(&core).iter().skip(2).map(|m| m.thrust).sum::<f64>() * DT;
            lowest = lowest.min(center(&core).y);
            stopped += DT;
        }
        assert!(stopped < 1.8 && pushed < 0.15 && at - lowest < 0.3,
            "stopped in {stopped} s, its jets pushing it on {pushed} of all of theirs for a second, {} m down", at - lowest);
    }
}

#[test]
fn flat_out_along_the_field_with_no_climb_asked_it_keeps_its_height_leant_as_far_as_its_thrusters_hold_it_up_as_they_point() {
    // Two upright and two leant out 45°, two leant out 45° with its weight off their middle, and two upright with jets
    // along the hull: leant towards one leant out, that one points nearer up and the other further from it — at 60°, 15°
    // off up and 105° —, and jets, level, hold it up by nothing. Either way it keeps its height, leant no further than
    // they still hold it up, and goes faster and faster.
    for (design, way) in [(&LEANT[..], 1.0), (&LEANT[..], -1.0), (&OFF_THE_MIDDLE[..], 1.0), (&OFF_THE_MIDDLE[..], -1.0), (&JETS[..], 1.0), (&JETS[..], -1.0)] {
        let mut core = aloft(design);
        let at = center(&core).y;
        ask(&mut core, way, 0.0);
        let (mut lowest, mut speeds, second) = (at, Vec::new(), (1.0 / DT).round() as usize);
        for step in 1..=4 * second {
            core.game_advance(DT).unwrap();
            lowest = lowest.min(center(&core).y);
            if step % second == 0 {
                speeds.push(way * drive(&core).velocity.x);
            }
        }
        assert!(at - lowest < 0.3, "asked {way}: from {at} m to {lowest} m at the lowest");
        assert!(speeds[0] > 1.0 && speeds.windows(2).all(|w| w[1] > w[0] + 1.0), "asked {way}: {speeds:?} m/s, leant {} rad", drive(&core).pose.angle);
    }
}

#[test]
fn with_its_centre_of_mass_off_the_middle_it_hovers_still_leant_where_its_thrust_lines_meet_over_it() {
    let mut core = aloft(&OFF_THE_MIDDLE);
    run(&mut core, 10.0);
    let (d, at) = (drive(&core), center(&core));
    // Leant so that where the lines meet stands straight over its centre of mass: what they push it with is straight up
    // through it.
    let over = meeting(&core);
    assert!(d.flying && d.pose.angle.abs() > 0.02, "it leans: {} rad", d.pose.angle);
    assert!((over.x - at.x).abs() < 0.01 * (over.y - at.y), "{over:?} over {at:?}, leant {} rad", d.pose.angle);
    assert!(hypot(d.velocity.x, d.velocity.y) < 1e-3 && d.omega.abs() < 1e-3, "still: {:?}, {} rad/s", d.velocity, d.omega);
    assert!(along(&core).abs() < 1e-3 * weight(&core), "{} N along", along(&core));
    run(&mut core, 5.0);
    assert!(center(&core).distance(at) < 0.02, "where it hovers: {:?} from {at:?}", center(&core));
    // The Oficina tells it is balanced so, at that lean.
    let told = oficina(&OFF_THE_MIDDLE);
    assert_eq!(told["balanced"], true);
    assert!((told["hoverLean"].as_f64().unwrap() - drive(&core).pose.angle).abs() < 0.003, "{} for {}", told["hoverLean"], drive(&core).pose.angle);
}

#[test]
fn upright_thrusters_alone_take_it_along_the_field_leant_and_let_go_it_comes_back_level_to_a_hover() {
    let mut core = hovering(&PAIR);
    let height = center(&core).y;
    assert!(drive(&core).pose.angle.abs() < 1e-3, "level as it hovers");
    // Asked to the right, it leans that way as far as they still hold it up at the height it was — not to `LEAN`, with
    // less than twice its weight to push it with —, and is pushed along by the rest of what they push it with, until the
    // air holds it back by as much, as it shows the air the way it goes leant so.
    let holds = (weight(&core) / drive(&core).thrust_n).acos();
    assert!(holds < LEAN, "{holds} rad");
    ask(&mut core, 1.0, 0.0);
    run(&mut core, 40.0);
    let d = drive(&core);
    assert!(d.pose.angle < -0.9 * holds && d.pose.angle > -holds - 0.02, "leant {} rad for {holds}", d.pose.angle);
    assert!((center(&core).y - height).abs() < 0.5, "at its height: {} from {height}", center(&core).y);
    let terminal = (along(&core) / air(&core).air(d.pose.angle, d.velocity, -1.0, center(&core).y)).sqrt();
    assert!(d.velocity.x > 30.0 && (d.velocity.x - terminal).abs() < 0.03 * terminal, "{} m/s for {terminal}", d.velocity.x);
    // Let go, it leans back to slow down, comes to a stop with no more than a short swing back and hovers there level.
    ask(&mut core, 0.0, 0.0);
    let (mut stopped, mut back) = (None, 0.0_f64);
    for _ in 0..(20.0 / DT) as usize {
        core.game_advance(DT).unwrap();
        let d = drive(&core);
        if stopped.is_none() && d.velocity.x < 0.05 {
            stopped = Some(center(&core).x);
        }
        if let Some(at) = stopped {
            back = back.max(at - center(&core).x);
        }
    }
    let d = drive(&core);
    assert!(stopped.is_some() && back < 0.3, "it swung {back} m back");
    assert!(d.pose.angle.abs() < 1e-3 && hypot(d.velocity.x, d.velocity.y) < 0.02 && d.station.0.is_some(), "{} rad, {:?}", d.pose.angle, d.velocity);
    assert!((center(&core).y - height).abs() < 0.5, "{} from {height}", center(&core).y);
}

/// Asked down as it is asked along the field, until it stands on the ground: how fast it came down over the last steps
/// before it touched, and how far it was leant as it touched.
fn set_down(core: &mut NativeWorld, throttle: f64) -> (f64, f64) {
    ask(core, throttle, -1.0);
    let (mut touched, mut falling) = (None, [0.0_f64; 3]);
    for _ in 0..(60.0 / DT) as usize {
        core.game_advance(DT).unwrap();
        let d = drive(core);
        if d.grounded && touched.is_none() {
            touched = Some((falling.into_iter().fold(0.0, f64::min), d.pose.angle));
        }
        falling = [falling[1], falling[2], d.velocity.y];
        if !d.flying {
            break;
        }
    }
    assert!(!drive(core).flying, "it stands on the ground");
    touched.expect("it came down")
}

#[test]
fn leant_to_go_along_it_is_levelled_as_it_comes_down_and_set_down_level() {
    let mut core = aloft(&PAIR);
    ask(&mut core, 1.0, 0.0);
    run(&mut core, 3.0);
    assert!(drive(&core).pose.angle < -0.5 * LEAN, "leant {} rad", drive(&core).pose.angle);
    let (falling, angle) = set_down(&mut core, 1.0);
    assert!(falling > -TOUCH - 0.05 && angle.abs() < 0.02, "touched at {falling} m/s leant {angle} rad");
}

#[test]
fn leant_to_hover_it_is_set_down_as_leant_as_it_hovers_still_at_where_it_hovered() {
    // With its weight off the middle of its thrusters, held level it would be pushed along the field as it comes down:
    // it comes down leant as it hovers still, no more, and is set down where it hovered.
    let mut core = aloft(&OFF_THE_MIDDLE);
    run(&mut core, 6.0);
    let leant = drive(&core).pose.angle;
    assert!(leant.abs() > 0.02, "{leant} rad");
    let x = center(&core).x;
    let (falling, angle) = set_down(&mut core, 0.0);
    assert!(falling > -TOUCH - 0.05 && (angle - leant).abs() < 0.01, "touched at {falling} m/s leant {angle} rad for {leant}");
    // Falling fast leant so, the air it meets pushes it aside a little, which its thrusters make up only as they slow it.
    assert!((center(&core).x - x).abs() < 1.0, "set down where it hovered: {} from {x}", center(&core).x);
}

#[test]
fn the_oficina_holds_a_design_balanced_that_hovers_still_leant_no_more_than_fifteen_degrees() {
    // Further out behind, where their lines meet stands further to the side of its centre of mass: it would hover leant
    // some 8°, and more than 15°.
    let lean = |behind: f64| oficina(&[(-1.6, 4.5, -std::f64::consts::FRAC_PI_4, 1.7), (behind, 4.5, std::f64::consts::FRAC_PI_4, 1.7)]);
    let (near, far) = (lean(4.0), lean(8.0));
    assert_eq!(near["balanced"], true, "{near}");
    assert!((near["hoverLean"].as_f64().unwrap() - 0.146).abs() < 0.01, "{near}");
    assert_eq!(far["balanced"], false, "{far}");
}

#[test]
fn with_thrusters_that_hold_it_up_level_in_more_ways_than_one_it_is_turned_back_level() {
    // Two upright, unlike about its centre of mass, and two leant in at 45° beyond them: they hold it up still level, and
    // as well leant a little, with the leant ones pushing against each other. Turned, it is not held leant as it was.
    let q = std::f64::consts::FRAC_PI_4;
    let mut core = hovering(&[(-3.0, 4.5, -q, 1.3), (-1.0, 4.5, 0.0, 1.3), (0.6, 4.5, 0.0, 1.3), (2.4, 4.5, q, 1.3)]);
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"omega":0.8}})).unwrap();
    run(&mut core, 0.5);
    assert!(drive(&core).pose.angle.abs() > 0.05, "the blow turned it: {}", drive(&core).pose.angle);
    run(&mut core, 10.0);
    for _ in 0..(20.0 / DT) as usize {
        core.game_advance(DT).unwrap();
        let d = drive(&core);
        assert!(d.pose.angle.abs() < 2e-3 && hypot(d.velocity.x, d.velocity.y) < 0.02, "level and still: {} rad, {:?}", d.pose.angle, d.velocity);
    }
}

/// How high the lowest corner of its outline stands over the ground under it.
fn lowest(core: &NativeWorld) -> f64 {
    let (game, d) = (game(core), drive(core));
    game.actors[0].contact_contours.iter().flatten().flatten().map(|&p| {
        let at = d.pose.world_point(p);
        at.y - game.terrain.height(at.x)
    }).fold(f64::INFINITY, f64::min)
}

#[test]
fn low_over_the_ground_it_is_leant_as_far_as_keeps_the_lowest_of_it_clear_of_the_ground() {
    // Taken up a little and sent along the field flat out: a pair of large thrusters some 2.6 m over the ground, small ones
    // under a metre over it, which leans it no further than its length lets it.
    for (size, leans) in [(1.5, true), (1.2, false)] {
        let mut core = world(&[(-1.6, 4.5, 0.0, size), (1.6, 4.5, 0.0, size)]);
        ask(&mut core, 0.0, 0.3);
        run(&mut core, 1.0);
        ask(&mut core, 0.0, 0.0);
        run(&mut core, 6.0);
        let over = lowest(&core);
        assert!(drive(&core).flying && over < 3.0, "low: {over} m");
        ask(&mut core, 1.0, 0.0);
        let (mut low, mut most) = (f64::INFINITY, 0.0_f64);
        for _ in 0..(8.0 / DT) as usize {
            core.game_advance(DT).unwrap();
            (low, most) = (low.min(lowest(&core)), most.min(drive(&core).pose.angle));
        }
        assert!(low > CLEARANCE - 0.1 && drive(&core).flying, "{size}: its lowest came {low} m over the ground");
        assert!(if leans { most < -0.9 * LEAN } else { most < -0.05 && most > -0.3 }, "{size}: leant {most} rad from {over} m");
    }
}

#[test]
fn with_little_thrust_to_spare_it_is_leant_as_far_as_still_holds_it_up() {
    // A third more thrust than it weighs: leant as far as that still holds it up, short of `LEAN`, it is held up at the
    // height it was.
    let mut core = aloft(&[(-1.6, 4.5, 0.0, 1.2), (1.6, 4.5, 0.0, 1.2)]);
    let ratio = drive(&core).thrust_n / weight(&core);
    assert!(ratio > 1.25 && ratio < 1.4, "{ratio}");
    let holds = (1.0 / ratio).acos();
    let height = center(&core).y;
    ask(&mut core, 1.0, 0.0);
    let mut dip = 0.0_f64;
    for _ in 0..(10.0 / DT) as usize {
        core.game_advance(DT).unwrap();
        dip = dip.min(center(&core).y - height);
    }
    let angle = drive(&core).pose.angle;
    assert!(angle < -0.85 * holds && angle > -holds - 0.02 && dip > -0.5, "leant {angle} rad for {holds}, sank {dip} m");
}

#[test]
fn asked_up_and_along_with_too_little_thrust_for_both_it_climbs_before_it_goes_along() {
    // A third more thrust than it weighs, asked to climb and to go along flat out: it climbs, leant no further than
    // what is left of its thrust pushes it along with.
    let mut core = aloft(&[(-1.6, 4.5, 0.0, 1.2), (1.6, 4.5, 0.0, 1.2)]);
    let height = center(&core).y;
    ask(&mut core, 1.0, 1.0);
    run(&mut core, 3.0);
    let d = drive(&core);
    assert!(d.velocity.y > 1.0 && center(&core).y > height + 1.0 && d.pose.angle > -0.6 * LEAN,
        "climbs at {} m/s, {} m up, leant {} rad", d.velocity.y, center(&core).y - height, d.pose.angle);
}

#[test]
fn asked_down_and_along_it_falls_by_part_of_its_weight_and_is_pushed_along_by_the_rest() {
    // Upright thrusters: let fall by half its weight at the most, and leant to go along.
    let mut core = aloft(&PAIR);
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 3.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 4.0);
    ask(&mut core, 1.0, -1.0);
    run(&mut core, 2.0);
    let d = drive(&core);
    assert!(d.velocity.y < -3.0 && d.velocity.y > -0.6 * 9.81 * 2.0 && d.velocity.x > 3.0 && d.pose.angle < -0.5 * LEAN,
        "{:?} m/s leant {} rad", d.velocity, d.pose.angle);
    // Two thrusters leant in, that push it along only as they push it up as well: flat out along the field and asked
    // down a little, it comes down — weighed as much as going along, it would climb.
    let mut core = aloft(&[(-1.6, 4.5, -std::f64::consts::FRAC_PI_4, 1.5), (1.6, 4.5, std::f64::consts::FRAC_PI_4, 1.5)]);
    ask(&mut core, 0.0, 1.0);
    run(&mut core, 4.0);
    ask(&mut core, 1.0, 0.0);
    run(&mut core, 12.0);
    ask(&mut core, 1.0, -0.3);
    run(&mut core, 3.0);
    let d = drive(&core);
    assert!(d.velocity.y < -1.5 && d.velocity.x > 40.0, "{:?} m/s", d.velocity);
}


#[test]
fn low_and_fast_over_ground_that_rises_under_it_it_is_lifted_over_it() {
    // A slope of one in ten from 60 m on, flown at flat out a few metres over the ground with nothing asked up: what
    // holds it where it hovers would take it into the slope; it is lifted over it as it closes on it.
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", flier(&PAIR), 0.0, false)],
        json!({"id":"flat","points":[{"x":-1600,"y":0},{"x":60,"y":0},{"x":1600,"y":154}]}));
    scene["visualEvents"] = json!(false);
    core.load_game_value(&scene).unwrap();
    ask(&mut core, 0.0, 0.3);
    run(&mut core, 1.5);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 4.0);
    let start = lowest(&core);
    assert!(start > 1.0 && start < 6.0, "{start} m over the ground");
    ask(&mut core, 1.0, 0.0);
    let mut least = f64::INFINITY;
    for _ in 0..(20.0 / DT) as usize {
        core.game_advance(DT).unwrap();
        least = least.min(lowest(&core));
    }
    let d = drive(&core);
    assert!(d.flying && center(&core).x > 300.0 && least > CLEARANCE, "{least} m over the ground at the least, at {} going {:?}", center(&core).x, d.velocity);
}

/// The aircraft of `thrusters` turned about, as a host admits it in the place of the one `core` flies when it turns about
/// in the air (`GameState::admit`): laid at rest at the middle of the field, its plates and pieces under owners the field
/// has not given yet, each piece with the fuel the one it is the mirror image of has left.
fn turned_about(core: &NativeWorld, thrusters: &[(f64, f64, f64, f64)]) -> Value {
    turned(core, thrusters, true, 1000)
}
/// The same, facing the way its design faces when `mirrored` is not, and its owners `apart` from those the scene gives.
fn turned(core: &NativeWorld, thrusters: &[(f64, f64, f64, f64)], mirrored: bool, apart: u64) -> Value {
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", flier(thrusters), 0.0, mirrored)], json!("flat"));
    for (piece, was) in scene["modules"].as_array_mut().unwrap().iter_mut().zip(&game(core).damage.modules) {
        piece["fuelLitres"] = json!(was.fuel_litres);
    }
    let anew = |owner: &mut Value| if let Some(n) = owner.as_u64().filter(|&n| n > 0) { *owner = json!(n + apart); };
    for kind in ["plates", "modules"] {
        for part in scene[kind].as_array_mut().unwrap() {
            anew(&mut part["owner"]);
            if let Some(mount) = part.get_mut("weaponMount") {
                anew(&mut mount["hostOwner"]);
                for wall in mount["walls"].as_array_mut().unwrap() { anew(&mut wall["owner"]); }
            }
        }
    }
    json!({"op":"admit","leaving":[1],"actors":scene["actors"],"plates":scene["plates"],"modules":scene["modules"],"aloft":[1]})
}
/// Where the thrusters of the aircraft `core` flies hold it up still, as its flight computer reckons it now.
fn poised(core: &NativeWorld) -> f64 {
    let d = drive(core);
    crate::game_hover::poise(d, &game(core).damage, 1, crate::game_hover::Body { mass: d.carrier_mass, inertia: d.carrier_inertia,
        center: d.center(), gravity: Point::new(0.0, -9.81), above: None, air: None, pull: Default::default(), hung: 0.0, swing: 0.0 })
}

#[test]
fn turned_about_in_the_air_it_goes_on_from_where_it_was_as_its_own_mirror_image() {
    // Going along the field, leant, beside a twin that flies on as it was.
    let (mut core, mut twin) = (hovering(&LEANT), hovering(&LEANT));
    for flown in [&mut core, &mut twin] {
        ask(flown, 1.0, 0.2);
        run(flown, 3.0);
    }
    let (before, at, pushes) = (drive(&core).clone(), center(&core), thrusters(&core).iter().map(|m| m.thrust).collect::<Vec<_>>());
    let holds = game(&core).damage.plates.iter().map(|p| p.mass()).sum::<f64>() + game(&core).damage.modules.iter().map(|m| m.live_mass()).sum::<f64>();
    assert!(before.flying && before.velocity.x > 5.0 && before.pose.angle < -0.05 && pushes.iter().any(|&share| share > 0.0),
        "{:?} m/s leant {} rad", before.velocity, before.pose.angle);
    // Its thrusters hold it up still level: leant to go along, it is leant as far off that, the same way.
    assert!(poised(&core).abs() < 1e-3, "{} rad", poised(&core));
    let told: Value = serde_json::from_str(&core.game_command_value(&turned_about(&core, &LEANT)).unwrap()).unwrap();
    // Its centre of mass where the other's was, moving the same way along the field and turning the same way round.
    let d = drive(&core);
    assert_eq!((game(&core).actors.len(), game(&core).actors[0].cold["facing"].as_f64()), (1, Some(1.0)));
    assert!(center(&core).distance(at) < 1e-9, "{:?} for {:?}", center(&core), at);
    assert_eq!((d.velocity, d.omega), (before.velocity, before.omega));
    assert!((d.pose.angle - before.pose.angle).abs() < 2e-3, "{} rad for {}", d.pose.angle, before.pose.angle);
    // It flies on as asked, held where the other was, weighing what the other held — which that one was last weighed by
    // to `LOAD_STEP` —, its thrusters pushing as theirs did, its centre of mass on the other side of its middle.
    assert!(d.flying && !d.grounded && d.station == before.station && (d.throttle, d.brake, d.rise) == (before.throttle, before.brake, before.rise));
    assert!((d.carrier_mass - holds).abs() < 1e-6 && (d.carrier_mass - before.carrier_mass).abs() < LOAD_STEP, "{} kg for {holds}", d.carrier_mass);
    assert!((d.carrier_center.x + before.carrier_center.x).abs() < 0.01 && (d.carrier_center.y - before.carrier_center.y).abs() < 0.01,
        "{:?} for {:?}", d.carrier_center, before.carrier_center);
    assert_eq!(thrusters(&core).iter().map(|m| m.thrust).collect::<Vec<_>>(), pushes);
    // The host is told so at once.
    let vehicle = &told["result"]["actors"][0]["vehicle"];
    assert_eq!((vehicle["flying"].as_bool(), vehicle["vx"].as_f64()), (Some(true), Some(before.velocity.x)));
    // And it flies on: it drops nothing and holds its course. Not as its twin to the metre: leant as far as its thrusters
    // hold it up at its height, flat out along the field, it is its own mirror image leant the same way — its centre of
    // mass 8 cm off the middle of its thrusters, on the other side —, which shares out what they push it with otherwise
    // to hold it level, and goes a few in a hundred faster or slower than its twin. Turned back again at once, it is the
    // very aircraft it was and flies on as its twin does to some centimetres: nothing of how it flew is lost turning.
    let mut back = hovering(&LEANT);
    ask(&mut back, 1.0, 0.2);
    run(&mut back, 3.0);
    back.game_command_value(&turned(&back, &LEANT, true, 1000)).unwrap();
    back.game_command_value(&turned(&back, &LEANT, false, 2000)).unwrap();
    for flown in [&mut core, &mut twin, &mut back] {
        run(flown, 2.0);
    }
    let (here, there, again) = (center(&core), center(&twin), center(&back));
    assert!(drive(&core).flying && (here.y - there.y).abs() < 0.3 && (here.x - there.x).abs() < 0.04 * (there.x - at.x),
        "{here:?} for {there:?}, from {at:?}");
    assert!(drive(&back).flying && again.distance(there) < 0.1, "{again:?} for {there:?}");
}

#[test]
fn hovering_leant_where_its_thrust_holds_it_up_still_it_turns_about_to_hover_leant_the_other_way_where_it_was() {
    let mut core = aloft(&OFF_THE_MIDDLE);
    run(&mut core, 10.0);
    let (before, at) = (drive(&core).clone(), center(&core));
    assert!(before.flying && before.pose.angle.abs() > 0.03 && (poised(&core) - before.pose.angle).abs() < 1e-3,
        "leant {} rad, poised at {}", before.pose.angle, poised(&core));
    core.game_command_value(&turned_about(&core, &OFF_THE_MIDDLE)).unwrap();
    let d = drive(&core);
    assert!(center(&core).distance(at) < 1e-9 && (d.pose.angle + before.pose.angle).abs() < 2e-3, "{} rad for {}", d.pose.angle, before.pose.angle);
    // Its thrust lines meet over it as they did, on the other side of it: it hovers on there, leant so.
    run(&mut core, 5.0);
    let d = drive(&core);
    assert!(d.flying && center(&core).distance(at) < 0.1 && (d.pose.angle + before.pose.angle).abs() < 0.01,
        "{:?} for {:?}, leant {} rad", center(&core), at, d.pose.angle);
}
