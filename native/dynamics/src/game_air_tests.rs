//! What the air takes of what a construction shows it, through the core as a field runs it and as the Oficina tells it:
//! the same reading in both, the open frame of a drone against one boxed in plates, and the top speeds that gives.
use super::*;

const DT: f64 = 1.0 / 60.0;
const TEMPLATES: [&str; 15] = ["heavy", "ifv", "scout", "recon", "mortar", "howitzer", "chassis", "tracked", "mining-truck",
    "construction-truck", "paver", "truck", "tanker", "supply", "grader"];
fn catalogue() -> &'static Value {
    crate::game_damage::fixtures::full_catalogue()
}
fn cells(metres: f64) -> f64 {
    metres / crate::game_construction::CELL
}
/// A drone on the chassis of an aircraft 4 m long: a tank with its command post on it in the middle, and four thrusters
/// at 75 % standing on its rails, two upright either side of them and one leant 45° out beyond each. `fairing` closes them
/// under plates of 8 mm aluminium from the rails up over them: `None` leaves them bare, `Some((out, rise))` stands the foot
/// of the front and rear walls that far out beyond the ends of the chassis and their tops that far in from their feet.
fn drone(fairing: Option<(f64, f64)>) -> Value {
    let mut source = crate::game_templates::source("scout", &json!({}), catalogue()).unwrap();
    source["chassis"] = json!({"model":"aircraft","points":[{"x":-40,"y":-7},{"x":40,"y":-7}]});
    let deck = -0.35;
    let thruster = |id: &str, x: f64, angle: f64| {
        let (w, h) = (0.64 * 0.75, 1.31 * 0.75);
        let lift = if angle == 0.0 { h / 2.0 } else { (w + h) / 2.0 * std::f64::consts::FRAC_1_SQRT_2 };
        json!({"id":id,"kind":"thruster","metal":"titanium","sizeScale":0.75,"pose":{"x":cells(x),"y":cells(deck+lift),"angle":angle}})
    };
    let quarter = std::f64::consts::FRAC_PI_4;
    source["components"] = json!([
        {"id":"fuel","kind":"fuel","sizeScale":0.6,"pose":{"x":0,"y":cells(deck+0.72*0.6/2.0),"angle":0}},
        {"id":"command","kind":"command","pose":{"x":0,"y":cells(deck+0.72*0.6+0.14),"angle":0}},
        thruster("lift0", -1.4, quarter), thruster("lift1", -0.5, 0.0), thruster("lift2", 0.5, 0.0), thruster("lift3", 1.4, -quarter),
    ]);
    source["nodes"] = json!([]);
    source["plates"] = json!([]);
    if let Some((out, rise)) = fairing {
        let (front, rear, top) = (-40.0 - cells(out), 40.0 + cells(out), cells(deck + 1.05));
        source["nodes"] = json!([{"id":"f0","x":front,"y":-6.9},{"id":"f1","x":front+cells(rise),"y":top},
            {"id":"r1","x":rear-cells(rise),"y":top},{"id":"r0","x":rear,"y":-6.9}]);
        source["plates"] = json!([{"id":"fair:front","a":"f0","b":"f1","material":"aluminum","thicknessMm":8},
            {"id":"fair:roof","a":"f1","b":"r1","material":"aluminum","thicknessMm":8},
            {"id":"fair:rear","a":"r1","b":"r0","material":"aluminum","thicknessMm":8}]);
    }
    crate::game_construction::seated(&source, catalogue())
}
const BARE: Option<(f64, f64)> = None;
const BOXED: Option<(f64, f64)> = Some((0.0, 0.0));
const SLOPED: Option<(f64, f64)> = Some((1.0, 1.3));
fn field(source: Value) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut scene = crate::game_damage::fixtures::scene(&[(1, "fly", source, 0.0, false)], json!("flat"));
    scene["visualEvents"] = json!(false);
    core.load_game_value(&scene).unwrap();
    core
}
fn powertrain(core: &NativeWorld) -> Powertrain {
    core.game.as_ref().unwrap().actors[0].powertrain
}
fn ask(core: &mut NativeWorld, throttle: f64, rise: f64) {
    core.game_command_value(&json!({"op":"input","actorId":"fly","input":{"type":"drive","phase":"before","throttle":throttle,"brake":0,"rise":rise}}))
        .unwrap();
}
/// Runs it for `seconds`, its tanks kept full: how fast it goes is what is measured, not how long it lasts.
fn run(core: &mut NativeWorld, seconds: f64) {
    for i in 0..(seconds / DT).round() as usize {
        if i % 30 == 0 {
            for m in &mut core.game.as_mut().unwrap().damage.modules {
                if m.kind == ComponentKind::Fuel { m.fuel_litres = m.capacity_litres; }
            }
        }
        core.game_advance(DT).unwrap();
    }
}
fn velocity(core: &NativeWorld) -> Point {
    core.game.as_ref().unwrap().actors[0].drive.as_ref().unwrap().velocity
}
/// How fast it climbs flat out for `seconds` from its skids, in m/s.
fn climbs(source: &Value, seconds: f64) -> f64 {
    let mut core = field(source.clone());
    ask(&mut core, 0.0, 1.0);
    run(&mut core, seconds);
    velocity(&core).y
}
/// How fast it goes along the field flat out for `seconds` from a hover, ahead (-1, the way its design faces) or astern.
fn flies(source: &Value, way: f64, seconds: f64) -> f64 {
    let mut core = field(source.clone());
    ask(&mut core, 0.0, 0.3);
    run(&mut core, 2.0);
    ask(&mut core, 0.0, 0.0);
    run(&mut core, 8.0);
    ask(&mut core, way, 0.0);
    run(&mut core, seconds);
    velocity(&core).x.abs()
}

#[test]
fn the_oficina_reads_the_air_as_the_field_does() {
    for id in TEMPLATES {
        let source = crate::game_templates::source(id, &json!({}), catalogue()).unwrap();
        let told = crate::game_construction::compile(&source, catalogue()).unwrap()["compiled"]["powertrain"].clone();
        let live = powertrain(&field(source));
        for (key, value) in [("drag", live.drag), ("dragAstern", live.drag_astern), ("dragOver", live.drag_over), ("dragUnder", live.drag_under)] {
            assert!((told[key].as_f64().unwrap() - value).abs() < 1e-9 * value, "{id} {key}: {} in the Oficina, {value} in the field", told[key]);
        }
        assert!((told["maxSpeed"].as_f64().unwrap() - live.max_speed).abs() < 1e-6, "{id}");
    }
}

#[test]
fn the_rails_and_the_skids_of_a_frame_show_the_air_what_they_are() {
    let plates = |source: &Value| crate::game_construction::compile(source, catalogue()).unwrap()["compiled"]["plates"].as_array().unwrap().clone();
    let width = |plates: &[Value], id: &str| plates.iter().find(|p| p["id"] == id).unwrap()["dragWidthM"].as_f64();
    // Two rails of 12 cm, and a cross member as wide every 1.5 m between them; tubes of 8 cm either side of the body, and
    // the legs of the tube of the struts of skids 0.6 m high.
    let rails = 2.0 * 0.12 + (crate::game_construction::BODY_WIDTH - 2.0 * 0.12) * 0.12 / 1.5;
    let drone = plates(&drone(BARE));
    assert!((width(&drone, "chassis:frame-0").unwrap() - rails).abs() < 1e-12 && width(&drone, "chassis:rail-0") == width(&drone, "chassis:frame-0"));
    assert_eq!(width(&drone, "chassis:skid-0"), Some(2.0 * 0.08));
    assert!((width(&drone, "chassis:leg-0").unwrap() - 2.0 * 0.18 * 0.6).abs() < 1e-12);
    // Skids half as large again have tubes half as thick again.
    let mut large = self::drone(BARE);
    large["chassis"]["gearScale"] = json!(1.5);
    let large = plates(&crate::game_construction::seated(&large, catalogue()));
    assert!((width(&large, "chassis:skid-0").unwrap() - 2.0 * 0.08 * 1.5).abs() < 1e-12);
    assert!((width(&large, "chassis:leg-0").unwrap() - 2.0 * 0.18 * 0.6 * 1.5).abs() < 1e-12);
    // The plate over the tub of a track, its nose and the plate over the profile of a frame on wheels are as wide as the body.
    let tank = plates(&crate::game_templates::source("heavy", &json!({}), catalogue()).unwrap());
    assert_eq!((width(&tank, "chassis:frame-0"), width(&tank, "chassis:nose")), (None, None));
    assert_eq!(width(&plates(&crate::game_templates::source("scout", &json!({}), catalogue()).unwrap()), "chassis:top-0"), None);
}

#[test]
fn a_drone_bare_on_its_rails_flies_faster_than_one_boxed_in_plates() {
    // Over it, the boxed one shows the air its roof, as wide as the body and as long as its chassis; the bare one its
    // thrusters, its tank, its command post and the rails between them.
    let (bare, boxed) = (powertrain(&field(drone(BARE))), powertrain(&field(drone(BOXED))));
    assert!((boxed.drag_over - 0.5 * crate::game_flight::AIR_DENSITY * crate::game_air::BLUNT * 4.0 * 2.4).abs() < 1e-9, "{boxed:?}");
    assert!(bare.drag_over < boxed.drag_over / 4.0 && bare.drag < boxed.drag / 3.0, "{bare:?} against {boxed:?}");
    // Its thrusters lift it, and take it along the field, faster for it.
    let (bare, boxed) = (drone(BARE), drone(BOXED));
    assert!(climbs(&bare, 20.0) > 2.0 * climbs(&boxed, 20.0));
    assert!(flies(&bare, -1.0, 30.0) > 1.5 * flies(&boxed, -1.0, 30.0));
}

#[test]
#[ignore = "measurement: prints the top speeds of the stock designs and of the drones; run with --ignored --nocapture"]
fn measure_top_speeds() {
    for id in TEMPLATES {
        let source = crate::game_templates::source(id, &json!({}), catalogue()).unwrap();
        println!("{id:20} {:7.2} km/h", powertrain(&field(source)).max_speed * 3.6);
    }
    for (name, fairing) in [("bare", BARE), ("boxed", BOXED), ("sloped", SLOPED)] {
        let source = drone(fairing);
        let mass = crate::game_construction::compile(&source, catalogue()).unwrap()["compiled"]["fixedAssembly"]["mass"].as_f64().unwrap();
        let hull = field(source.clone()).game.as_ref().unwrap().actors[0].hull;
        println!("{name:8} {mass:7.1} kg: climbs {:6.2} m/s, ahead {:6.2} m/s, astern {:6.2} m/s; {hull:?}",
            climbs(&source, 40.0), flies(&source, -1.0, 60.0), flies(&source, 1.0, 60.0));
    }
}
