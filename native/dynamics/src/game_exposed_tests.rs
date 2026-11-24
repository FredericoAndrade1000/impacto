//! What a construction carries out in the open, in the field: a machine gun on its roof, a fuel tank strapped to its
//! back and a hopper on its roof stand admitted on either side of the field, the gun fires, a pilot sees each of
//! them and what is struck there is struck with no plate before it.
use super::*;

fn plate(id: &str, a: &str, b: &str) -> Value {
    json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":20})
}
/// A box 5.8 m long and 2 m high on a chassis of wheels as long, its front to the left, with a command post in it and
/// the pieces given.
fn design(parts: &[Value]) -> Value {
    // Every position in cells of 5 cm: its floor on the deck of the chassis, 10 cm under the middle of the box.
    let floor=-2;
    let mut components = vec![json!({"id":"command","kind":"command","pose":{"x":5,"y":7,"angle":0}})];
    components.extend(parts.iter().cloned());
    json!({"version":crate::CONSTRUCTION_VERSION,"preset":"vehicle","chassis":{"model":"wheeled","points":[{"x":-58,"y":-2},{"x":58,"y":-2}],
        "thicknessMm":20.0,"axles":[-42,0,42]},
        "nodes":[{"id":"hull-0","x":-58,"y":floor},{"id":"hull-1","x":58,"y":floor},{"id":"hull-2","x":58,"y":floor+40},{"id":"hull-3","x":-58,"y":floor+40}],
        "plates":[plate("hull:floor","hull-0","hull-1"),plate("hull:rear","hull-1","hull-2"),
            plate("hull:roof","hull-2","hull-3"),plate("hull:front","hull-3","hull-0")],"components":components})
}
/// Two of them in a duel, 200 m apart, the first turned to face the second.
fn duel(parts: &[Value]) -> NativeWorld {
    let design = design(parts);
    crate::game_damage::fixtures::duel([&design, &design], 200.0)
}
fn piece<'a>(game: &'a GameState, actor: u32, id: &str) -> &'a Module {
    let id = format!(":{id}");
    game.damage.modules.iter().find(|m| m.actor == actor && m.cold["id"].as_str().is_some_and(|name| name.ends_with(&id))).unwrap()
}
fn outside_parts() -> Vec<Value> {
    vec![
        json!({"id":"engine","kind":"engine","pose":{"x":-13,"y":9,"angle":0}}),
        json!({"id":"ammo","kind":"ammo","ammoPreset":"m2hb","pose":{"x":8,"y":23,"angle":0}}),
        json!({"id":"inner","kind":"fuel","pose":{"x":44,"y":12,"angle":0}}),
        // On its post, free over the roof: its foot clear of the plate, on the first cell that leaves it so.
        json!({"id":"gun","kind":"weapon","weaponPreset":"m2hb","pose":{"x":23,"y":55,"angle":std::f64::consts::FRAC_PI_2},
            "mount":{"preset":"pintle","sector":{"min":-1.75,"max":1.75}}}),
        json!({"id":"tank","kind":"fuel","pose":{"x":67,"y":18,"angle":0}}),
        json!({"id":"hopper","kind":"hopper","pose":{"x":-41,"y":48,"angle":0,"mirrored":true}}),
    ]
}

#[test]
fn a_gun_on_the_roof_stands_admitted_either_way_round_and_fires_from_the_rounds_inside() {
    let mut world = duel(&outside_parts());
    let game = world.game.as_ref().unwrap();
    let (a, b) = (piece(game, 1, "gun"), piece(game, 2, "gun"));
    let (ma, mb) = (a.mount.as_ref().unwrap(), b.mount.as_ref().unwrap());
    assert_eq!((&a.cold["weaponMount"]["preset"], a.cold["weaponMount"].get("port")), (&json!("pintle"), None));
    assert_eq!((ma.min.to_bits(), ma.max.to_bits()), ((-mb.max).to_bits(), (-mb.min).to_bits()));
    assert_eq!(a.physical_mass.to_bits(), b.physical_mass.to_bits());
    // Nothing is cut out of the roof of either.
    for p in game.damage.plates.iter().filter(|p| p.cold["id"].as_str().is_some_and(|id| id.ends_with("hull:roof"))) {
        assert!((0..p.grid.nx).all(|x| (0..p.grid.ny).all(|y| p.grid.occupied(x, y))));
    }
    // It is fed from the box inside. Level, its bore runs into the hopper on the roof before it: it does not fire
    // into its own construction. Laid over the hopper, it fires.
    let tip = muzzle_point(Point::new(a.pose.x, a.pose.y), a.barrel_angle, a.barrel_end);
    assert!(!crate::game_motion::muzzle_obstruction(&game.geometry, &game.terrain, a.owner, None, tip, a.barrel_angle, a.barrel_radius));
    let (id, ammo, origin) = (a.cold["id"].clone(), a.cold["weaponAmmo"].clone(), Point::new(a.pose.x, a.pose.y));
    let box_owner = piece(game, 1, "ammo").owner;
    let before = piece(game, 1, "ammo").rounds;
    let command = |world: &mut NativeWorld, op: &str, angle: f64| -> Value {
        let aim = Point::new(origin.x + 30.0 * cos(angle), origin.y + 30.0 * sin(angle));
        let result: Value = serde_json::from_str(&world.game_command_value(&json!({"op":op,"actorId":"local","force":true,"aim":aim.to_value(),
            "config":{"id":"machinegun","preset":"m2hb","componentId":id,"platform":"vehicle","aimAngle":angle,"ammo":ammo,"charge":1.0}})).unwrap()).unwrap();
        result["result"].clone()
    };
    assert_eq!(command(&mut world, "fire", 0.0), false);
    assert_eq!(command(&mut world, "aim", 0.12), true);
    for _ in 0..30 {
        world.game_step(1.0 / 60.0).unwrap();
    }
    assert_eq!(command(&mut world, "fire", 0.12), true);
    world.game_step(1.0 / 60.0).unwrap();
    let game = world.game.as_ref().unwrap();
    assert_eq!(game.damage.module(box_owner).unwrap().rounds, before - 1);
    assert_eq!(game.damage.stats.shots, 1);
}

#[test]
fn the_gun_on_the_roof_is_struck_on_its_narrow_post_and_on_the_receiver_lying_behind_its_trunnion() {
    let world = duel(&outside_parts());
    let game = world.game.as_ref().unwrap();
    let gun = piece(game, 1, "gun");
    let first = |from: Point, to: Point| game.geometry.raycast(from, to, &RayOptions::default());
    let (x, y) = (gun.pose.x, gun.pose.y);
    // Level, a hand above the roof: the post is struck, and beside it, where a box the width of the receiver would
    // have stood upright, nothing is.
    let low = y - 0.4;
    let hit = first(Point::new(x - 0.3, low), Point::new(x + 0.3, low)).unwrap();
    assert_eq!((hit.owner, hit.kind), (gun.owner, EntityKind::Module));
    assert!((hit.point.x - x).abs() < 0.05, "struck {} m off the post", hit.point.x - x);
    assert!(first(Point::new(x - 0.3, low), Point::new(x - 0.05, low)).is_none());
    // From above, behind the trunnion, the receiver lies level and is no barrel; before it the barrel is.
    let (c, s) = (cos(gun.barrel_angle), sin(gun.barrel_angle));
    for (along, barrel) in [(-0.3, false), (0.5, true)] {
        let at = Point::new(x + along * c, y + along * s);
        let hit = first(Point::new(at.x, at.y + 2.0), at).unwrap();
        assert_eq!((hit.owner, hit.kind), (gun.owner, EntityKind::Module), "{along}");
        assert_eq!(gun.barrel_strike(hit.point), barrel, "{along}");
    }
}

#[test]
fn a_pilot_sees_a_tank_and_a_load_out_in_the_open_and_nothing_of_the_tank_within() {
    let mut world = duel(&outside_parts());
    let game = world.game.as_mut().unwrap();
    sensor_view!(game => view);
    let reading = game.sensors.sense_terrain(&view, 1).unwrap();
    let threats = HashMap::new();
    let mut camera = ObservedCamera { memory: &game.sensors, view: &view, damage: &game.damage, observer: 1, reading, terrain: None,
        sight: None, threats: &threats,
        side: OwnSide { geometry: &game.geometry, terrain: &game.terrain, own: (1, Bounds::empty()), allies: Vec::new(), intangible: &[] } };
    let places = camera.outside("opponent");
    assert!(camera.terrain.is_none(), "looking at exposed pieces does not prepare ground heights");
    let at = |part: Part| places.iter().filter(|aim| aim.part == part).map(|aim| aim.offset).collect::<Vec<_>>();
    let enemy = game.sensor_actors.iter().find(|a| a.id == "opponent").unwrap().bounds;
    let middle = Point::new((enemy.min_x + enemy.max_x) * 0.5, (enemy.min_y + enemy.max_y) * 0.5);
    let offset = |id: &str| { let m = piece(game, 2, id); Point::new(m.pose.x - middle.x, m.pose.y - middle.y) };
    assert_eq!(at(Part::Fuel), vec![offset("tank")]);
    assert_eq!(at(Part::Cargo), vec![offset("hopper")]);
    assert_eq!(at(Part::Weapon), vec![offset("gun")]);
    assert_eq!(at(Part::Gear).len(), 3);
    assert_eq!(at(Part::Hull).len(), 1);
}

#[test]
fn a_round_meets_a_piece_out_in_the_open_before_any_plate_and_one_within_only_through_one() {
    let world = duel(&outside_parts());
    let game = world.game.as_ref().unwrap();
    let first = |from: Point, to: Point| game.geometry.raycast(from, to, &RayOptions::default()).unwrap();
    for id in ["tank", "hopper"] {
        let m = piece(game, 1, id);
        // Level from the far side of the piece, away from the hull, and from straight above.
        let away = if m.pose.x > piece(game, 1, "command").pose.x { 1.0 } else { -1.0 };
        for from in [Point::new(m.pose.x + 20.0 * away, m.pose.y), Point::new(m.pose.x, m.pose.y + 20.0)] {
            let hit = first(from, Point::new(m.pose.x, m.pose.y));
            assert_eq!((hit.owner, hit.kind), (m.owner, EntityKind::Module), "{id}");
        }
    }
    let inner = piece(game, 1, "inner");
    let hit = first(Point::new(inner.pose.x, inner.pose.y + 20.0), Point::new(inner.pose.x, inner.pose.y));
    assert_eq!(hit.kind, EntityKind::Plate);
    assert_eq!(game.damage.plate(hit.owner).unwrap().cold["id"].as_str().map(|id| id.ends_with("hull:roof")), Some(true));
}

/// A tank sets off beside the engine, inside the hull or strapped to the back of it behind the rear plate: what the
/// engine keeps of its health, and how fast the construction is moving after.
fn tank_fire(outside: bool) -> (f64, Point) {
    let tank = if outside {
        json!({"id":"tank","kind":"fuel","pose":{"x":67,"y":8,"angle":0}})
    } else {
        json!({"id":"tank","kind":"fuel","pose":{"x":24,"y":6,"angle":0}})
    };
    let mut core = duel(&[json!({"id":"engine","kind":"engine","pose":{"x":45,"y":5,"angle":0}}), tank]);
    let mut game = core.game.take().unwrap();
    let (tank, engine) = (piece(&game, 1, "tank").owner, piece(&game, 1, "engine").owner);
    let body = |core: &NativeWorld, game: &GameState| {
        let v = core.world.bodies[core.bodies[&game.actors[0].body]].linvel();
        Point::new(v.x, v.y)
    };
    let before = body(&core, &game);
    let mut effects = Effects::new(false);
    game.damage.destroy_module(tank, &mut effects);
    game.apply_effects(&mut core, &mut effects).unwrap();
    let after = body(&core, &game);
    let m = game.damage.module(engine).unwrap();
    (m.health / m.max_health, Point::new(after.x - before.x, after.y - before.y))
}

#[test]
fn a_destroyed_tank_burns_without_a_blast_or_impulse_inside_or_outside() {
    let (inside, still) = tank_fire(false);
    let (outside, pushed) = tank_fire(true);
    assert_eq!((inside, outside), (1.0, 1.0), "fuel failure causes no explosive damage to the engine");
    assert_eq!((still.x, still.y), (0.0, 0.0));
    assert_eq!((pushed.x, pushed.y), (0.0, 0.0));
}
