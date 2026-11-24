//! A gun mounted through a wall, as the field admits it: the walls, port and build it is admitted with must be its
//! own, its mantlet is charged once, its servo turns within a sector that turns with its carrier, and the plate it is
//! mounted in keeps its cut. Turned about, it is the same gun the other way round.
use super::*;
use crate::game_damage::fixtures::duel_scene;
use std::f64::consts::PI;

fn plate(id: &str, a: &str, b: &str) -> Value {
    json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":20})
}
/// A box 5.8 m long and 2 m high on a chassis of wheels as long, with a Minimi through its front wall (to the left)
/// and a camera on its roof.
fn source() -> Value {
    // Every position in cells of 5 cm: its floor on the deck of the chassis, 10 cm under the middle of the box.
    let floor=-2;
    json!({"version":crate::CONSTRUCTION_VERSION,"preset":"vehicle","name":"Enclosed Minimi","seed":6173,
        "chassis":{"model":"wheeled","points":[{"x":-58,"y":-2},{"x":58,"y":-2}],"thicknessMm":20.0,"axles":[-42,0,42]},
        "nodes":[{"id":"hull-0","x":-58,"y":floor},{"id":"hull-1","x":58,"y":floor},{"id":"hull-2","x":58,"y":floor+40},{"id":"hull-3","x":-58,"y":floor+40}],
        "plates":[plate("hull:floor","hull-0","hull-1"),plate("hull:rear","hull-1","hull-2"),
            plate("hull:roof","hull-2","hull-3"),plate("hull:front","hull-3","hull-0")],"components":[
        {"id":"command","kind":"command","pose":{"x":5,"y":7,"angle":0}},
        {"id":"engine","kind":"engine","pose":{"x":-13,"y":9,"angle":0}},
        {"id":"ammo","kind":"ammo","ammoPreset":"minimi","pose":{"x":8,"y":23,"angle":0}},
        {"id":"fuel","kind":"fuel","pose":{"x":28,"y":12,"angle":0}},
        {"id":"gun","kind":"weapon","weaponPreset":"minimi","pose":{"x":-56,"y":18,"angle":-PI},
            "mount":{"preset":"light-trunnion","sector":{"min":-0.2,"max":0.2},"radiusM":0.12499999999999999}},
        {"id":"camera","kind":"sensor","sensorMode":"visual","pose":{"x":17,"y":41,"angle":0}}]})
}
/// Two of them 200 m apart, the first turned to face the second.
fn pair(design: &Value) -> Value {
    duel_scene([design, design], 200.0)
}
fn admitted(scene: &Value) -> Result<NativeWorld, String> {
    let mut world = NativeWorld::new(&[], 0.0, -9.81)?;
    world.load_game_value(scene)?;
    Ok(world)
}
/// Where the part of the turned one named `id` stands among the scene's `plates` or `modules`.
fn index(scene: &Value, list: &str, id: &str) -> usize {
    scene[list].as_array().unwrap().iter().position(|part| part["id"] == format!("local:{id}")).unwrap()
}
fn query(world: &mut NativeWorld, request: Value) -> Value {
    let result: Value = serde_json::from_str(&world.game_command_value(&request).unwrap()).unwrap();
    result["result"].clone()
}
fn public_gun(world: &mut NativeWorld, owner: u32) -> Value {
    let frame: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    frame["modules"].as_array().unwrap().iter().find(|m| m["owner"] == owner).unwrap().clone()
}
fn public_aim(world: &mut NativeWorld, gun: &Value, target: f64) {
    assert_eq!(query(world, json!({"op":"aim","actorId":"local",
        "aim":{"x":gun["x"].as_f64().unwrap()+30.0*cos(target),"y":gun["y"].as_f64().unwrap()+30.0*sin(target)},
        "config":{"id":"machinegun","preset":"minimi","componentId":gun["id"],"platform":"vehicle",
            "aimAngle":target,"ammo":"ap","charge":1.0}})), true);
}

#[test]
fn a_mounted_gun_is_admitted_only_with_its_own_walls_port_and_build() {
    let good = pair(&source());
    admitted(&good).unwrap();
    let gun = index(&good, "modules", "gun");
    for field in ["owner", "wallId", "a", "thicknessMm"] {
        let mut bad = good.clone();
        let wall = &mut bad["modules"][gun]["weaponMount"]["walls"][0];
        wall[field] = match field { "owner" => json!(5), "wallId" => json!("invented-wall"), "a" => json!({"x": 999, "y": 0}), _ => json!(33) };
        assert!(admitted(&bad).is_err(), "{field}");
    }
    let mut bad = good.clone();
    bad["modules"][gun]["physicalMass"] = json!(1);
    assert!(admitted(&bad).is_err());
    for (field, value) in [("hi", 0.13), ("centerU", 0.12), ("max", 0.5)] {
        let mut bad = good.clone();
        bad["modules"][gun]["weaponMount"]["walls"][0]["port"][field] = json!(value);
        assert!(admitted(&bad).is_err(), "{field}");
    }
    for (field, value) in [("bodyWidth", 1.0), ("recoil", 0.10)] {
        let mut bad = good.clone();
        bad["modules"][gun]["weaponMount"][field] = json!(value);
        assert!(admitted(&bad).is_err(), "{field}");
    }
    // A fresh, wholly solid grid would heal the aperture the gun is mounted in.
    let mut bad = good.clone();
    let wall = &mut bad["plates"][index(&good, "plates", "hull:front")];
    let grid = crate::game_geometry::MaterialGrid::from_value(&wall["ballisticGrid"]).unwrap();
    wall["ballisticGrid"] = crate::game_geometry::MaterialGrid::new(grid.bounds).to_value();
    assert!(admitted(&bad).is_err());
}

#[test]
fn a_burned_mount_resumes_its_consumed_mass_without_healing_or_forged_inertia() {
    let good = pair(&source());
    let core = admitted(&good).unwrap();
    let gun = index(&good, "modules", "gun");
    let owner = good["modules"][gun]["owner"].as_u64().unwrap() as u32;
    let original = core.game.as_ref().unwrap().damage.module(owner).unwrap();
    for age in [30.0, 90.0] {
        let mut burned = original.clone();
        burned.burn_age = age;
        burned.fire_age = 20.0;
        burned.burning = true;
        burned.weigh();
        assert!(burned.physical_mass < original.physical_mass);
        let mut saved = good.clone();
        let live = burned.to_value();
        for key in ["dryMass", "physicalMass", "physicalInertia", "burnAge", "fireAge", "burning"] {
            saved["modules"][gun][key] = live[key].clone();
        }
        let mut resumed = admitted(&saved).unwrap();
        let actual = resumed.game.as_ref().unwrap().damage.module(owner).unwrap();
        assert_eq!(actual.physical_mass, burned.physical_mass);
        assert!((actual.physical_inertia - burned.physical_inertia).abs() < 1e-10);
        assert_eq!(actual.burn_age, age);
        assert_eq!(actual.dry_mass, original.dry_mass);
        public_gun(&mut resumed, owner);
        let warm = public_gun(&mut resumed, owner);
        assert!((warm["physicalInertia"].as_f64().unwrap()-burned.physical_inertia).abs()<1e-10,
            "warm host frames keep the current inertia with the mass");

        // Older host frames published the new mass but retained the initial inertia.
        let mut old = saved.clone();
        old["modules"][gun]["physicalInertia"] = json!(original.physical_inertia);
        let restored = admitted(&old).unwrap();
        let actual = restored.game.as_ref().unwrap().damage.module(owner).unwrap();
        assert!((actual.physical_inertia - burned.physical_inertia).abs() < 1e-10);

        let mut forged = saved.clone();
        forged["modules"][gun]["physicalMass"] = json!(burned.physical_mass - 1.0);
        assert!(admitted(&forged).is_err(), "fire cannot remove more material than it consumed");
        forged = saved.clone();
        forged["modules"][gun]["physicalInertia"] = json!(burned.physical_inertia * 2.0);
        assert!(admitted(&forged).is_err(), "the actual mount still determines inertia");
    }
}

#[test]
fn the_curved_mantlet_pays_its_finite_radial_thickness_and_leaves_a_clear_bore() {
    let world = admitted(&pair(&source())).unwrap();
    let gun = world.game.as_ref().unwrap().damage.modules.iter().find(|m| m.mount.is_some()).unwrap();
    let mount = gun.mount.as_ref().unwrap();
    let barrel = crate::game_geometry::BarrelProfile::from_value(&gun.cold).unwrap();
    let resistance = |mount: &crate::game_mounts::WeaponMount, a: Point, b: Point|
        mount.resistance(a, b, gun.width, gun.height, barrel, gun.receiver_mm, 1.0, 0.0);
    let receiver = resistance(mount, Point::new(-gun.width, 0.0), Point::new(0.0, 0.0));
    assert!((receiver - (gun.receiver_mm / 1000.0 * 1250.0).max(0.5)).abs() < 1e-12);
    let shield = mount.shield.unwrap();
    let angle = 0.6;
    let radial = |r| Point::new(r * cos(angle), r * sin(angle));
    let a = radial(shield.radius - 0.04);
    let b = radial(shield.radius + shield.thickness + 0.04);
    let cost = resistance(mount, a, b);
    let expected = shield.thickness * 1000.0 * mount.material.resistance;
    assert!((cost / expected - 1.0).abs() < 0.005,
        "faceted radial armour chord: {cost} versus {expected}");
    assert!((resistance(mount, b, a) - cost).abs() < 1e-10);
    assert_eq!(resistance(mount, Point::new(0.01, 0.0), Point::new(barrel.end, 0.0)), 0.0,
        "the real bore opening never becomes a solid armour block");
    let aim = Pose { angle: gun.barrel_angle, ..gun.pose };
    assert!((gun.chord_resistance(aim.world_point(a), aim.world_point(b), a.distance(b), 1.0) - cost).abs() < 1e-8);
}

#[test]
fn widening_the_allowed_sector_adds_no_mantlet_mass_or_ballistic_thickness() {
    let mut previous = None;
    for half in [0.1, 0.3, 0.6] {
        let mut design = source();
        design["components"][4]["mount"]["sector"] = json!({"min":-half,"max":half});
        let world = admitted(&pair(&design)).unwrap();
        let gun = world.game.as_ref().unwrap().damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap();
        let mount = gun.mount.as_ref().unwrap();
        let shield = mount.shield.unwrap();
        let barrel = crate::game_geometry::BarrelProfile::from_value(&gun.cold).unwrap();
        let angle = 0.6;
        let radial = |r| Point::new(r * cos(angle), r * sin(angle));
        let cost = mount.resistance(radial(shield.radius - 0.04), radial(shield.radius + shield.thickness + 0.04),
            gun.width, gun.height, barrel, gun.receiver_mm, 1.0, 0.0);
        let current = (shield, gun.physical_mass.to_bits(), gun.physical_center.x.to_bits(),
            gun.physical_inertia.to_bits(), cost.to_bits());
        if let Some(before) = &previous { assert_eq!(&current, before, "sector ±{half}"); }
        previous = Some(current);
    }
}

#[test]
fn the_mantlet_uses_the_same_material_density_and_resistance_as_armour_plates() {
    let world = admitted(&pair(&source())).unwrap();
    let gun = world.game.as_ref().unwrap().damage.modules.iter().find(|m| m.mount.is_some()).unwrap();
    let mount = gun.mount.as_ref().unwrap();
    let shield = mount.shield.unwrap();
    let barrel = crate::game_geometry::BarrelProfile::from_value(&gun.cold).unwrap();
    let installed = crate::game_damage::fixtures::catalogue()[&gun.weapon_preset]["installedMassKg"].as_f64().unwrap();
    let angle = 0.6;
    let radial = |r| Point::new(r * cos(angle), r * sin(angle));
    let cost = |mount: &crate::game_mounts::WeaponMount| mount.resistance(
        radial(shield.radius - 0.04), radial(shield.radius + shield.thickness + 0.04),
        gun.width, gun.height, barrel, gun.receiver_mm, 1.0, 0.0);
    let steel_mass = mount.fixed_properties(installed, gun.width, gun.height, barrel).0 - installed;
    let steel_cost = cost(mount);
    assert!(steel_mass > 0.0 && steel_cost > 0.0);
    for name in ["aluminum", "titanium", "hha"] {
        let mut changed = mount.clone();
        changed.material = crate::game_damage::Material::named(name).unwrap();
        let mass = changed.fixed_properties(installed, gun.width, gun.height, barrel).0 - installed;
        assert!((mass / steel_mass - changed.material.density / mount.material.density).abs() < 1e-10, "{name} mass");
        assert!((cost(&changed) / steel_cost - changed.material.resistance / mount.material.resistance).abs() < 1e-10, "{name} resistance");
    }
}

#[test]
fn a_pierced_mantlet_opens_only_the_struck_place_and_the_hole_turns_with_the_gun() {
    let mut world = admitted(&pair(&source())).unwrap();
    let game = world.game.as_mut().unwrap();
    let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap().clone();
    let shield = gun.mount.as_ref().unwrap().shield.unwrap();
    let angle = 0.55;
    let radial = |r: f64, a: f64| Point::new(r * cos(a), r * sin(a));
    let cost = |gun: &crate::game_damage::Module, a: f64| {
        let pose = Pose { angle: gun.barrel_angle, ..gun.pose };
        let start = pose.world_point(radial(shield.radius - 0.04, a));
        let end = pose.world_point(radial(shield.radius + shield.thickness + 0.04, a));
        gun.chord_resistance(start, end, start.distance(end), 1.0)
    };
    let intact = cost(&gun, angle);
    let neighbour = cost(&gun, angle + 0.25);
    assert!(intact > 0.0 && neighbour > 0.0);
    let at = Pose { angle: gun.barrel_angle, ..gun.pose }
        .world_point(radial(shield.radius + shield.thickness * 0.5, angle));
    game.damage.component_strike(gun.owner, at, at, 30.0, 0.006, true, false, &mut crate::game_damage::Effects::new(false));
    let changed = game.damage.module_mut(gun.owner).unwrap();
    assert_eq!(changed.mantlet_holes.len(), 1);
    assert!(cost(changed, angle) < 1e-8, "a second round crosses the real opening");
    assert!((cost(changed, angle + 0.25) - neighbour).abs() < neighbour * 0.005,
        "neighbouring armour retains its original thickness");
    assert_eq!(changed.elevation_damage, 0.0, "remote armour is away from the elevation mechanism");
    changed.barrel_angle += 0.17;
    assert!(cost(changed, angle) < 1e-8, "the hole follows the aimed shell");
    assert!((cost(changed, angle + 0.25) - neighbour).abs() < neighbour * 0.005);
}

#[test]
fn mirrored_mounts_have_the_same_radial_armour_and_reflected_local_holes() {
    let mut world = admitted(&pair(&source())).unwrap();
    let game = world.game.as_mut().unwrap();
    let guns = game.damage.modules.iter().filter(|m| m.mount.is_some()).cloned().collect::<Vec<_>>();
    assert_eq!(guns.len(), 2);
    let angle = 0.6;
    let shield = guns[0].mount.as_ref().unwrap().shield.unwrap();
    assert_eq!(guns[1].mount.as_ref().unwrap().shield, Some(shield));
    let radial = |r: f64, a: f64| Point::new(r * cos(a), r * sin(a));
    let mut costs = Vec::new();
    for (gun, sign) in guns.iter().zip([1.0, -1.0]) {
        let pose = Pose { angle: gun.barrel_angle, ..gun.pose };
        let a = pose.world_point(radial(shield.radius - 0.04, sign * angle));
        let b = pose.world_point(radial(shield.radius + shield.thickness + 0.04, sign * angle));
        costs.push(gun.chord_resistance(a, b, a.distance(b), 1.0));
        let at = pose.world_point(radial(shield.radius + shield.thickness * 0.5, sign * angle));
        game.damage.component_strike(gun.owner, at, at, 30.0, 0.006, true, false, &mut crate::game_damage::Effects::new(false));
        let changed = game.damage.module(gun.owner).unwrap();
        assert!(changed.chord_resistance(a, b, a.distance(b), 1.0) < 1e-8);
    }
    assert!((costs[0] - costs[1]).abs() < 1e-8);
    let a = game.damage.module(guns[0].owner).unwrap().mantlet_holes[0];
    let b = game.damage.module(guns[1].owner).unwrap().mantlet_holes[0];
    assert!((a.0 + b.1).abs() < 1e-10 && (a.1 + b.0).abs() < 1e-10);
}

#[test]
fn localized_mantlet_and_elevation_damage_survive_cold_readmission() {
    let mut generated = pair(&source());
    let mut world = admitted(&generated).unwrap();
    let game = world.game.as_mut().unwrap();
    let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap().clone();
    let shield = gun.mount.as_ref().unwrap().shield.unwrap();
    let pose = Pose { angle: gun.barrel_angle, ..gun.pose };
    let at = pose.world_point(Point::new((shield.radius + shield.thickness * 0.5) * cos(0.6),
        (shield.radius + shield.thickness * 0.5) * sin(0.6)));
    let mut effects = crate::game_damage::Effects::new(false);
    game.damage.component_strike(gun.owner, at, at, 30.0, 0.006, true, false, &mut effects);
    game.damage.damage_module(gun.owner, gun.max_health * 0.1, pose.world_point(Point::new(-0.001, 0.0)), &mut effects);
    let damaged = game.damage.module(gun.owner).unwrap().clone();
    assert!(!damaged.mantlet_holes.is_empty() && damaged.elevation_damage > 0.0);
    let at = generated["modules"].as_array().unwrap().iter().position(|m| m["owner"] == gun.owner).unwrap();
    generated["modules"][at] = damaged.to_value();
    generated["modules"][at]["actor"] = json!(gun.actor);
    let restored = admitted(&generated).unwrap();
    let loaded = restored.game.as_ref().unwrap().damage.module(gun.owner).unwrap();
    assert_eq!(loaded.mantlet_holes, damaged.mantlet_holes);
    assert_eq!(loaded.elevation_damage.to_bits(), damaged.elevation_damage.to_bits());
    assert_eq!(loaded.elevation_disabled, damaged.elevation_disabled);
    assert_eq!(loaded.physical_mass.to_bits(), gun.physical_mass.to_bits());
    assert_eq!(loaded.local_polygons(), damaged.local_polygons());
    assert_eq!(crate::game_motion::ServoProfile::from_module(loaded).max_speed.to_bits(),
        crate::game_motion::ServoProfile::from_module(&damaged).max_speed.to_bits());
}

#[test]
fn trunnion_hits_slow_then_jam_elevation_before_destroying_the_gun() {
    let mut world = admitted(&pair(&source())).unwrap();
    let game = world.game.as_mut().unwrap();
    let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap().clone();
    let healthy_rate = crate::game_motion::ServoProfile::from_module(&gun).max_speed;
    let pivot = Pose { angle: gun.barrel_angle, ..gun.pose }.world_point(Point::new(-0.001, 0.0));
    let mut effects = crate::game_damage::Effects::new(false);
    game.damage.damage_module(gun.owner, gun.max_health * 0.15, pivot, &mut effects);
    let changed = game.damage.module_mut(gun.owner).unwrap();
    let rate = crate::game_motion::ServoProfile::from_module(changed).max_speed;
    assert!(changed.usable() && !changed.elevation_disabled && !changed.barrel_disabled);
    assert!(rate > 0.0 && rate < healthy_rate);
    let mut servo = crate::game_motion::ServoState::from_value(gun.owner, &changed.to_value(), Default::default());
    let before = changed.barrel_angle;
    let target = changed.pose.angle + 0.2;
    assert!(crate::game_motion::advance_servo(&mut servo, changed, target, 0.01));
    assert!((changed.barrel_angle - before).abs() <= rate * 0.01 + 1e-12);
    let pivot = Pose { angle: changed.barrel_angle, ..changed.pose }.world_point(Point::new(-0.001, 0.0));
    game.damage.damage_module(gun.owner, gun.max_health * 0.4, pivot, &mut effects);
    let changed = game.damage.module_mut(gun.owner).unwrap();
    assert!(changed.usable() && changed.elevation_disabled && !changed.barrel_disabled,
        "the damaged elevation gear jams while the receiver and tube remain usable");
    let before = changed.barrel_angle;
    assert!(!crate::game_motion::advance_servo(&mut servo, changed, target, 0.1));
    assert_eq!(changed.barrel_angle.to_bits(), before.to_bits());
}

#[test]
fn neither_laying_the_gun_nor_losing_it_changes_the_mass_of_what_carries_it() {
    let mut world = admitted(&pair(&source())).unwrap();
    let physics = |world: &mut NativeWorld| query(world, json!({"op":"physics"}));
    let built = |state: &Value| state["bodyStates"].as_array().unwrap().iter()
        .map(|b| (b["mass"].clone(), b["inertia"].clone())).collect::<Vec<_>>();
    let initial = physics(&mut world);
    assert_eq!(initial["bodies"], 2);
    let owner = world.game.as_ref().unwrap().damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap().owner;
    for step in 0..120 {
        let gun = public_gun(&mut world, owner);
        let axis = gun["angle"].as_f64().unwrap();
        public_aim(&mut world, &gun, axis + if step < 60 { 2.0 } else { -2.0 });
        world.game_step(1.0 / 60.0).unwrap();
    }
    // A charge set off on the gun destroys it.
    let gun = public_gun(&mut world, owner);
    world.game_command_value(&json!({"op":"explode","x":gun["x"],"y":gun["y"],"power":5000,"radius":1})).unwrap();
    assert_eq!(public_gun(&mut world, owner)["health"], 0.0);
    let after = physics(&mut world);
    assert_eq!(built(&initial), built(&after));
    assert_eq!(after["recoveries"], 0);
}

#[test]
fn the_servo_turns_within_a_sector_that_turns_with_its_carrier_and_no_faster_than_its_rate() {
    let mut generated = pair(&source());
    // A carrier that is held still keeps the servo apart from its settling; turning the carrier by hand then shows
    // the sector turns with it.
    for actor in generated["actors"].as_array_mut().unwrap() {
        actor["vehicle"]["enabled"] = json!(false);
    }
    let mut world = admitted(&generated).unwrap();
    let owner = generated["modules"][index(&generated, "modules", "gun")]["owner"].as_u64().unwrap() as u32;
    let before = public_gun(&mut world, owner);
    let axis = before["angle"].as_f64().unwrap();
    let min = before["weaponMount"]["min"].as_f64().unwrap();
    let max = before["weaponMount"]["max"].as_f64().unwrap();
    let rate = before["weaponMount"]["maxSpeed"].as_f64().unwrap();
    public_aim(&mut world, &before, axis + 2.0);
    world.game_step(1.0 / 60.0).unwrap();
    let after = public_gun(&mut world, owner);
    assert_ne!(after["barrelAngle"], before["barrelAngle"]);
    assert!((after["barrelAngle"].as_f64().unwrap() - before["barrelAngle"].as_f64().unwrap()).abs() <= rate / 60.0 + 1e-15);
    // What the frame tells of the laying is the difference of the angles in the world, to the bit; the sector bound
    // allows only for the error of that subtraction.
    let projected = after["targetAimOffset"].as_f64().unwrap();
    let canonical = angle_difference(after["targetBarrelAngle"].as_f64().unwrap(), after["angle"].as_f64().unwrap());
    assert_eq!(projected.to_bits(), canonical.to_bits());
    assert!((projected - max).abs() < 1e-12);
    for _ in 0..60 {
        world.game_step(1.0 / 60.0).unwrap();
    }
    assert!((public_gun(&mut world, owner)["aimOffset"].as_f64().unwrap() - max).abs() < 1e-12);
    assert_eq!(query(&mut world, json!({"op":"setVehicleState","actorId":"local","state":{"angle":0.4}})), true);
    let rotated = public_gun(&mut world, owner);
    assert!(rotated["angle"].as_f64().unwrap() > axis + 0.39);
    assert!((rotated["aimOffset"].as_f64().unwrap() - max).abs() < 1e-12);
    let target = rotated["angle"].as_f64().unwrap() - 2.0;
    public_aim(&mut world, &rotated, target);
    assert!((public_gun(&mut world, owner)["targetAimOffset"].as_f64().unwrap() - min).abs() < 1e-12);
    for _ in 0..60 {
        world.game_step(1.0 / 60.0).unwrap();
    }
    assert!((public_gun(&mut world, owner)["aimOffset"].as_f64().unwrap() - min).abs() < 1e-12);
    // A gun that is lost lays no more.
    assert_eq!(query(&mut world, json!({"op":"setPartState","owner":owner,"state":{"health":0}})), true);
    let failed = public_gun(&mut world, owner);
    public_aim(&mut world, &failed, failed["angle"].as_f64().unwrap());
    world.game_step(1.0 / 60.0).unwrap();
    let still = public_gun(&mut world, owner);
    assert_eq!(still["barrelAngle"], failed["barrelAngle"]);
    assert_eq!(still["health"], 0.0);
}

#[test]
fn a_cut_wall_comes_back_from_a_cold_admission_neither_cut_again_nor_healed() {
    let mut generated = pair(&source());
    let at = index(&generated, "plates", "hull:front");
    let owner = generated["plates"][at]["owner"].as_u64().unwrap() as u32;
    let mut wall = crate::game_damage::fixtures::plate(owner, 1, &generated["plates"][at]);
    let (a, b) = (wall.pose.world_point(Point::new(-0.65, 0.0)), wall.pose.world_point(Point::new(-0.50, 0.0)));
    wall.cut_clipped(a, b, 0.02, None);
    let before = wall.to_value();
    generated["plates"][at] = before.clone();
    generated["plates"][at]["actor"] = json!(1);
    let mut world = admitted(&generated).unwrap();
    let frame = world.game.as_mut().unwrap().frame();
    let projected = frame["plates"].as_array().unwrap().iter().find(|p| p["owner"] == owner).unwrap();
    for key in ["ballisticGrid", "physicalMass", "originalArea"] {
        assert_eq!(projected["damage"][key], before[key], "{key}");
    }
}

#[test]
fn a_fixed_enclosure_mounts_its_gun_the_same_way_and_never_drives() {
    let mut design = source();
    design["preset"] = json!("bunker");
    design.as_object_mut().unwrap().remove("chassis");
    let mut world = admitted(&pair(&design)).unwrap();
    world.game_step(1.0 / 60.0).unwrap();
    let frame: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    assert!(frame["actors"].as_array().unwrap().iter().all(|a| a["vehicle"].is_null()));
    let physics = query(&mut world, json!({"op":"physics"}));
    assert_eq!(physics["bodies"], 2);
    assert!(physics["bodyStates"].as_array().unwrap().iter().all(|b| b["dynamic"] == false));
    assert!(world.game.as_ref().unwrap().damage.modules.iter().any(|m| m.kind == ComponentKind::Weapon && m.mount.is_some()));
}

#[test]
fn the_floor_of_a_tower_is_the_one_real_plate_it_shares_with_the_hull_below() {
    let mut design = source();
    // A room 3 m long and 1.6 m high on the middle of the roof: its feet divide the roof in three.
    let floor=design["nodes"][0]["y"].as_i64().unwrap();
    design["nodes"].as_array_mut().unwrap().extend([json!({"id":"tower-0","x":-30,"y":floor+40}),json!({"id":"tower-1","x":30,"y":floor+40}),
        json!({"id":"tower-2","x":30,"y":floor+72}),json!({"id":"tower-3","x":-30,"y":floor+72})]);
    design["plates"] = json!([plate("hull:floor","hull-0","hull-1"),plate("hull:rear","hull-1","hull-2"),
        plate("hull:roof","hull-2","tower-1"),plate("tower:floor","tower-1","tower-0"),plate("hull:deck","tower-0","hull-3"),
        plate("hull:front","hull-3","hull-0"),plate("tower:rear","tower-1","tower-2"),plate("tower:roof","tower-2","tower-3"),
        plate("tower:front","tower-3","tower-0")]);
    design["components"][4]["pose"] = json!({"x":-28,"y":54,"angle":-PI});
    design["components"].as_array_mut().unwrap().pop();
    let generated = pair(&design);
    assert_eq!(generated["plates"].as_array().unwrap().len(), 22);
    let world = admitted(&generated).unwrap();
    let damage = &world.game.as_ref().unwrap().damage;
    for gun in damage.modules.iter().filter(|m| m.mount.is_some()) {
        assert_eq!(damage.plates.iter().filter(|p|p.actor==gun.actor && p.cold["id"].as_str().unwrap().ends_with("tower:floor")).count(),1,
            "the rooms share one real floor, without an armour duplicate");
        let host=damage.plate(gun.cold["weaponMount"]["hostOwner"].as_u64().unwrap() as u32).unwrap();
        assert!(host.cold["id"].as_str().unwrap().ends_with("tower:front"));
        assert_eq!(host.actor,gun.actor);
    }
}

#[test]
fn an_off_center_port_and_lopsided_sector_turn_about_without_cutting_the_wall_twice() {
    let mut design = source();
    design["components"][4]["pose"]["y"] = json!(24);
    design["components"][4]["mount"]["sector"] = json!({"min":-0.1,"max":0.25});
    let generated = pair(&design);
    let world = admitted(&generated).unwrap();
    let guns = world.game.as_ref().unwrap().damage.modules.iter().filter(|m| m.mount.is_some()).collect::<Vec<_>>();
    assert_eq!(guns.len(), 2);
    let (a, b) = (guns[0].mount.as_ref().unwrap(), guns[1].mount.as_ref().unwrap());
    assert_eq!((a.min.to_bits(), a.max.to_bits()), ((-b.max).to_bits(), (-b.min).to_bits()));
    assert_eq!(guns[0].physical_mass.to_bits(), guns[1].physical_mass.to_bits());
    assert_eq!(guns[0].physical_center.x.to_bits(), guns[1].physical_center.x.to_bits());
    assert_eq!(guns[0].physical_center.y.to_bits(), (-guns[1].physical_center.y).to_bits());
    let walls = generated["plates"].as_array().unwrap().iter().filter(|p| p["id"].as_str().unwrap().ends_with(":hull:front"))
        .map(|p| &p["ballisticGrid"]).collect::<Vec<_>>();
    assert_eq!(walls.len(), 2);
    assert_eq!(walls[0], walls[1]);
    // The same stretch of the same wall, cut by the sector turned about with the gun.
    let (port, turned) = (&guns[0].cold["weaponMount"]["walls"][0]["port"], &guns[1].cold["weaponMount"]["walls"][0]["port"]);
    for key in ["lo", "hi", "centerU"] { assert_eq!(port[key], turned[key], "{key}"); }
    assert_eq!((port["min"].as_f64().unwrap().to_bits(), port["max"].as_f64().unwrap().to_bits()),
        ((-turned["max"].as_f64().unwrap()).to_bits(), (-turned["min"].as_f64().unwrap()).to_bits()));
    assert!(guns[0].cold["materialPolygons"].as_array().unwrap().len() > 4,
        "the curved shell is made of finite convex facets");
}

#[test]
fn a_shot_through_the_port_leaves_clear_and_spends_a_round_from_the_box() {
    let design = source();
    let mut world = crate::game_damage::fixtures::duel([&design, &design], 200.0);
    let game = world.game.as_ref().unwrap();
    let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.mount.is_some()).unwrap();
    let (id, angle) = (gun.cold["id"].clone(), gun.barrel_angle);
    let tip = muzzle_point(Point::new(gun.pose.x, gun.pose.y), angle, gun.barrel_end);
    assert!(!crate::game_motion::muzzle_obstruction(&game.geometry, &game.terrain, gun.owner, None, tip, angle, gun.barrel_radius));
    let ammo = game.damage.modules.iter().find(|m| m.actor == 1 && m.kind == ComponentKind::Ammo).unwrap();
    let (owner, before) = (ammo.owner, ammo.rounds);
    let aim = Point::new(tip.x + 30.0 * cos(angle), tip.y + 30.0 * sin(angle));
    assert_eq!(query(&mut world, json!({"op":"fire","actorId":"local","force":true,"aim":aim.to_value(),
        "config":{"id":"machinegun","preset":"minimi","componentId":id,"platform":"vehicle","aimAngle":angle,"ammo":"ap","charge":1.0}})), true);
    world.game_step(1.0 / 60.0).unwrap();
    assert_eq!(world.game.as_ref().unwrap().damage.module(owner).unwrap().rounds, before - 1);
}
