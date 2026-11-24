//! The one atmosphere of the world through the core as a field runs it: the same numbers the page has (atmosphere.js),
//! a hull held back by the air as much less as the air is thinner where it is, and an aircraft whose thrusters, jets
//! that breathe the air, hold it up no higher than its ceiling.
use super::*;
use crate::game_flight::{AIR_DENSITY, JET_LAPSE, RATED_ALTITUDE, SCALE_HEIGHT, air_density, thinning, thrust_share};

const DT: f64 = 1.0 / 60.0;
/// A scout with thrusters, each `(x, y, angle, size)` in metres and radians of its design, put over its hull; built as
/// an aircraft, on skids where its wheels were, where there are any (as game_hover_tests.rs builds them).
fn scout(thrusters: &[(f64, f64, f64, f64)]) -> Value {
    let catalogue = crate::game_damage::fixtures::full_catalogue();
    let mut source = crate::game_templates::source("scout", &json!({}), catalogue).unwrap();
    for (i, &(x, y, angle, size)) in thrusters.iter().enumerate() {
        source["components"].as_array_mut().unwrap().push(json!({"id":format!("lift{i}"),"kind":"thruster","metal":"titanium",
            "sizeScale":size,"pose":{"x":x/crate::game_construction::CELL,"y":y/crate::game_construction::CELL,"angle":angle}}));
    }
    if !thrusters.is_empty() {
        let chassis = source["chassis"].as_object_mut().unwrap();
        chassis.insert("model".into(), json!("aircraft"));
        for key in ["axles", "track", "gearScale"] {
            chassis.remove(key);
        }
    }
    crate::game_construction::seated(&source, catalogue)
}
/// Two of the reference thruster at one and a half times its size, upright on either side of the middle, over the hull.
const PAIR: [(f64, f64, f64, f64); 2] = [(-1.6, 4.5, 0.0, 1.5), (1.6, 4.5, 0.0, 1.5)];
fn field(source: Value) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", source, 0.0, false)], json!("flat"));
    scene["visualEvents"] = json!(false);
    core.load_game_value(&scene).unwrap();
    core
}
fn drive(core: &NativeWorld) -> &DriveState {
    core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap()
}
fn ask(core: &mut NativeWorld, rise: f64) {
    core.game_command_value(&json!({"op":"input","actorId":"fly","input":{"type":"drive","phase":"before","throttle":0,"brake":0,"rise":rise}}))
        .unwrap();
}
fn run(core: &mut NativeWorld, seconds: f64) {
    for _ in 0..(seconds / DT).round() as usize {
        core.game_advance(DT).unwrap();
    }
}
/// Fills its tanks up.
fn fill(core: &mut NativeWorld) {
    for m in core.game.as_mut().unwrap().damage.modules.iter_mut().filter(|m| m.kind == ComponentKind::Fuel) {
        m.fuel_litres = m.capacity_litres;
    }
}
/// Puts it with its centre of mass `height` metres over sea level, going at `vx`, `vy`, its tanks filled up.
fn put(core: &mut NativeWorld, height: f64, vx: f64, vy: f64) {
    let d = drive(core);
    let y = d.pose.y + height - d.center().y;
    core.game_command_value(&json!({"op":"setVehicleState","actorId":"fly","state":{"y":y,"vx":vx,"vy":vy,"omega":0.0}})).unwrap();
    fill(core);
}

#[test]
fn the_atmosphere_is_the_one_the_page_has() {
    let fixture: Value = serde_json::from_str(include_str!("../../../tests/fixtures/atmosphere-parity.json")).unwrap();
    // The density to the last bit; the share of a jet's thrust, a power the two hosts work out each its own way, to the
    // last few.
    for row in fixture["heights"].as_array().unwrap() {
        let (altitude, share) = (row["altitude"].as_f64().unwrap(), row["thrustShare"].as_f64().unwrap());
        assert_eq!(air_density(altitude).to_bits(), row["density"].as_f64().unwrap().to_bits(), "{row}");
        assert!((thrust_share(altitude) - share).abs() <= 1e-15 * share, "{row}: {}", thrust_share(altitude));
    }
    for row in fixture["thinning"].as_array().unwrap() {
        let (from, to) = (row["from"].as_f64().unwrap(), row["to"].as_f64().unwrap());
        assert_eq!(thinning(from, to).to_bits(), row["share"].as_f64().unwrap().to_bits(), "{row}");
        // It is the ratio of the densities at the two heights, to a ten-millionth.
        assert!((thinning(from, to) - air_density(to) / air_density(from)).abs() < 1e-7, "{row}");
    }
    // A scale height up the air is 1/e as dense; a jet gives all its thrust up to `RATED_ALTITUDE`, and a scale height
    // over that (1/e)^0.7 of it. Under sea level the air is denser, and it stays a number however deep.
    assert_eq!(air_density(0.0), AIR_DENSITY);
    assert!((air_density(SCALE_HEIGHT) * std::f64::consts::E - AIR_DENSITY).abs() < 1e-12);
    assert!([-500.0, 0.0, 700.0, RATED_ALTITUDE].iter().all(|&altitude| thrust_share(altitude) == 1.0) && thrust_share(RATED_ALTITUDE + 1.0) < 1.0);
    assert!((thrust_share(RATED_ALTITUDE + SCALE_HEIGHT) - (-JET_LAPSE).exp()).abs() < 1e-12);
    assert!(air_density(-1000.0) > AIR_DENSITY && air_density(-1e300).is_finite());
}

#[test]
fn the_air_holds_a_hull_back_as_much_less_as_it_is_thinner_where_it_is() {
    // A scout thrown along the field, 500 m up and 10.5 km up: what the air takes of its speed in a step up there is what
    // it takes down here as much less as the air there is thinner.
    let slowed = |height: f64| {
        let mut core = field(scout(&[]));
        put(&mut core, height, 100.0, 0.0);
        let before = drive(&core).velocity.x;
        core.game_advance(DT).unwrap();
        before - drive(&core).velocity.x
    };
    let (low, high) = (slowed(500.0), slowed(10500.0));
    let thinner = air_density(10500.0) / air_density(500.0);
    assert!(low > 0.0 && (high / low - thinner).abs() < 1e-6 * thinner, "{high} m/s against {low} m/s, for {thinner}");
}

#[test]
fn an_aircraft_climbs_no_higher_than_where_its_thrusters_still_hold_it_up() {
    let mut core = field(scout(&PAIR));
    ask(&mut core, 1.0);
    run(&mut core, 1.0);
    let d = drive(&core);
    assert!(d.flying, "it took off");
    let (mass, thrust) = (d.carrier_mass, d.thrust_n);
    // Both push it straight up: its ceiling is where all they push with in the air they breathe there is its weight, over
    // the height up to which they push with all they have.
    let ceiling = RATED_ALTITUDE - SCALE_HEIGHT / JET_LAPSE * (mass * 9.81 / thrust).ln();
    assert!(ceiling > 5000.0 && ceiling < 15000.0, "{ceiling} m");
    // Under it, asked to climb flat out from a hover, it is sped up by what they push it with in the air there over its
    // weight; over it they push as hard as they can and still keep it level, and it sinks. What they push with is read
    // over a step, half a second on.
    for off in [-2000.0, 2000.0] {
        put(&mut core, ceiling + off, 0.0, 0.0);
        run(&mut core, 0.5);
        let before = drive(&core).velocity.y;
        core.game_advance(DT).unwrap();
        let (d, game) = (drive(&core), core.game.as_ref().unwrap());
        let shares: Vec<f64> = game.damage.modules.iter().filter(|m| m.kind == ComponentKind::Thruster).map(|m| m.thrust).collect();
        let pushed = shares.iter().sum::<f64>() * thrust / shares.len() as f64 * thrust_share(d.center().y) * d.pose.angle.cos();
        let (expected, sped) = ((pushed - mass * 9.81) / mass, (d.velocity.y - before) / DT);
        assert!(d.flying && (sped - expected).abs() < 0.05 * expected.abs(), "{off} m: {sped} m/s² for {expected}");
        assert!(if off < 0.0 { expected > 1.0 } else { expected < -1.0 && shares.iter().any(|share| *share > 0.999) }, "{off} m: {shares:?}");
    }
    // From 1.5 km under it, flat out, with its tanks kept full so that it weighs the same all the way, it climbs to just
    // under it — its flight computer keeps back the little of the thrust that holds it level — and no higher: from there
    // it sinks back, and swings slowly about where they hold it up.
    put(&mut core, ceiling - 1500.0, 0.0, 0.0);
    let mut highest = f64::MIN;
    for _ in 0..(150.0 / DT) as usize {
        fill(&mut core);
        core.game_advance(DT).unwrap();
        highest = highest.max(drive(&core).center().y);
    }
    assert!(drive(&core).flying && highest < ceiling && highest > ceiling - 200.0, "{highest} m at the highest, for a ceiling at {ceiling} m");
}

