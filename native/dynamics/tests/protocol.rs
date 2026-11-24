//! The public boundary admits construction, not a second Rapier descriptor ABI.
use batalha_dynamics::NativeWorld;
use serde_json::{Value, json};
mod common;

fn scene() -> Value {
    json!({"terrain":"flat","actors":[{"id":"local","handle":1,"vehicle":{"x":0,"y":3}}],
        "plates":[common::rectangle_plate(10,1,json!({"x":0,"y":3,"angle":0,"length":2,"thicknessMm":100,"material":"steel"}))],
        "modules":[{"owner":20,"actor":1,"kind":"command","x":0,"y":3.5,"width":0.3,"height":0.2,"physicalMass":25}]})
}
fn world(scene: &Value) -> NativeWorld {
    let mut world = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    world.load_game(&scene.to_string()).unwrap();
    world
}
fn query(world: &mut NativeWorld, request: Value) -> Value {
    let packet: Value =
        serde_json::from_str(&world.game_command(&request.to_string()).unwrap()).unwrap();
    assert!(
        packet["frame"].is_null(),
        "diagnostics never export or consume presentation state"
    );
    packet["result"].clone()
}

#[test]
fn cold_replacement_discards_old_handles_and_admits_exact_component_mass() {
    let mut world = world(&scene());
    let old = query(&mut world, json!({"op":"physics"}));
    assert_eq!(old["bodies"], 1);
    assert_eq!(old["colliders"], 2);
    assert!((old["bodyStates"][0]["mass"].as_f64().unwrap() - 1585.0).abs() < 0.01);
    assert_eq!(old["bodyStates"][0]["actor"], 1);
    let mut replacement = scene();
    replacement["modules"] = json!([]);
    world.load_game(&replacement.to_string()).unwrap();
    let new = query(&mut world, json!({"op":"physics"}));
    assert_eq!(new["bodies"], 1);
    assert_eq!(new["colliders"], 2);
    assert_eq!(new["owners"].as_array().unwrap().len(), 1);
    assert!((new["bodyStates"][0]["mass"].as_f64().unwrap() - 1560.0).abs() < 0.01);
    world.game_step(1.0 / 60.0).unwrap();
    assert_eq!(query(&mut world, json!({"op":"physics"}))["recoveries"], 0);
}
#[test]
fn canonical_concave_material_keeps_empty_space_and_the_original_mass() {
    let scene = json!({"terrain":"flat","actors":[{"id":"local","handle":1,"vehicle":{"x":0,"y":3,"enabled":false}}],
        "plates":[common::material_plate(10,1,json!({"x":0,"y":3,"angle":0,"length":2,"thicknessMm":2000,"material":"steel"}),
            &[[-1.,-1.],[1.,-1.],[1.,0.],[0.,0.],[0.,1.],[-1.,1.]],&[0,1,3,1,2,3,0,3,5,3,4,5])]});
    let mut world = world(&scene);
    let material = query(&mut world, json!({"op":"material","owner":10}));
    // Cell/triangle integration sums many small areas; preserve the material
    // invariant without requiring an exact floating-point addition order.
    assert!((material["area"].as_f64().unwrap() - 3.0).abs() < 1e-12);
    assert!((material["mass"].as_f64().unwrap() - 23400.0).abs() < 1e-7);
    assert!(
        query(
            &mut world,
            json!({"op":"raycast","start":{"x":0.2,"y":3.5},"end":{"x":0.8,"y":3.5}})
        )
        .is_null()
    );
    assert_eq!(
        query(
            &mut world,
            json!({"op":"raycast","start":{"x":-0.5,"y":5},"end":{"x":-0.5,"y":2.5}})
        )["owner"],
        10
    );
    let physics = query(&mut world, json!({"op":"physics"}));
    assert_eq!(physics["bodies"], 1);
    assert_eq!(physics["colliders"], 2, "one compound carrier collider and one terrain collider");
    // Drop the inverted L toward a crest: it fits below the notch but catches
    // the intact wing at the same height. Start clear of the one-sided terrain.
    for (crest_x,touches) in [(-0.5,false),(0.5,true)] {
        let mut contact_scene = scene.clone();
        contact_scene["actors"][0]["vehicle"]["enabled"] = json!(true);
        contact_scene["actors"][0]["vehicle"]["y"] = json!(4);
        contact_scene["actors"][0]["vehicle"]["angle"] = json!(std::f64::consts::PI);
        contact_scene["plates"][0]["definition"]["y"] = json!(4);
        contact_scene["plates"][0]["definition"]["angle"] = json!(std::f64::consts::PI);
        contact_scene["terrain"] = json!({"id":"rough","points":[{"x":-5,"y":0},
            {"x":crest_x-0.25,"y":0},{"x":crest_x-0.15,"y":2.8},
            {"x":crest_x+0.15,"y":2.8},{"x":crest_x+0.25,"y":0},{"x":5,"y":0}]});
        let mut physical = NativeWorld::new(&[],0.0,-9.81).unwrap();
        physical.load_game(&contact_scene.to_string()).unwrap();
        let mut touching = false;
        for _ in 0..24 {
            physical.game_step(1.0/60.0).unwrap();
            touching |= query(&mut physical,json!({"op":"physics","contacts":true}))["contactStates"].as_array().unwrap().iter()
                .any(|contact|!contact["solverContacts"].as_array().unwrap().is_empty());
        }
        let contacts = query(&mut physical,json!({"op":"physics"}));
        assert_eq!(touching,touches,"crest at {crest_x}: the actual material defines terrain contact");
        assert_eq!(contacts["bodies"],1);
        assert_eq!(contacts["colliders"],2);
        assert_eq!(contacts["recoveries"],0);
        if !touches {
            let y = contacts["bodyStates"][0]["y"].as_f64().unwrap();
            assert!(y>3.0 && y<3.3 && contacts["bodyStates"][0]["vy"].as_f64().unwrap()< -3.8,
                "the crest enters the notch without stopping the falling carrier: {contacts}");
        }
    }
}
#[test]
fn explicit_plate_end_stock_contacts_terrain_and_remains_admitted_after_perforation() {
    // Nodes at +/-6 m with 1.5 m of explicit stock at each end: material,
    // mass and terrain support all span the complete 15 m plate.
    let scene = json!({"terrain":{"id":"rough","points":[{"x":-50,"y":0},{"x":6.5,"y":0},
            {"x":6.8,"y":2.5},{"x":7.2,"y":2.5},{"x":7.5,"y":0},{"x":50,"y":0}]},
        "actors":[{"id":"local","handle":1,"vehicle":{"x":0,"y":3}}],
        "plates":[common::rectangle_plate(10,1,json!({"x":0,"y":3,"angle":0,"length":15,"thicknessMm":100,
            "material":"steel","anchors":[{"u":-0.4,"v":0},{"u":0.4,"v":0}]}))]});
    let mut world = world(&scene);
    let admitted: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    let contours = admitted["actors"][0]["contactContours"].clone();
    let points = contours.as_array().unwrap().iter().flat_map(|polygon|polygon.as_array().unwrap());
    let (mut left,mut right) = (f64::INFINITY,f64::NEG_INFINITY);
    for point in points {let x=point["x"].as_f64().unwrap();left=left.min(x);right=right.max(x);}
    assert!((left+7.5).abs()<1e-10 && (right-7.5).abs()<1e-10,"contact keeps the complete authored stock");
    let initial = query(&mut world,json!({"op":"physics"}));
    let mut end_contact = false;
    for _ in 0..24 {
        world.game_step(1.0/60.0).unwrap();
        end_contact |= query(&mut world,json!({"op":"physics","contacts":true}))["contactStates"].as_array().unwrap().iter()
            .flat_map(|contact|contact["solverContacts"].as_array().unwrap())
            .any(|contact|contact["point"]["x"].as_f64().unwrap()>6.3);
    }
    assert!(end_contact,"the crest catches real stock beyond the attachment nodes");
    world.game_command(&json!({"op":"cut","owner":10,"start":{"x":0,"y":0},"end":{"x":0,"y":5},"radius":20}).to_string()).unwrap();
    assert_eq!(query(&mut world,json!({"op":"material","owner":10}))["area"],0.0);
    let after: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    assert_eq!(after["actors"][0]["contactContours"],contours,"damage never rebuilds the admitted support");
    let physics = query(&mut world,json!({"op":"physics"}));
    assert_eq!(physics["bodyStates"][0]["mass"],initial["bodyStates"][0]["mass"]);
    assert_eq!(physics["bodyStates"][0]["inertia"],initial["bodyStates"][0]["inertia"]);
    assert_eq!(physics["bodies"],1);assert_eq!(physics["colliders"],2);assert_eq!(physics["recoveries"],0);
}
#[test]
fn malformed_admission_and_invalid_fixed_steps_leave_the_existing_scene_usable() {
    let initial = scene();
    let mut world = world(&initial);
    let before = query(&mut world, json!({"op":"physics"}));
    for indices in [
        json!([0, 1]),
        json!([0, 1, 999]),
        json!([0, 1, -1]),
        json!(["bad", 1, 2]),
    ] {
        let mut bad = initial.clone();
        bad["plates"][0]["indices"] = indices;
        assert!(world.load_game(&bad.to_string()).is_err());
        assert_eq!(query(&mut world, json!({"op":"physics"})), before);
    }
    assert!(world.load_game("{").is_err());
    assert!(world.game_step(0.0).is_err());
    assert!(world.game_step(f64::NAN).is_err());
    assert!(world.game_command("{").is_err());
    world.game_step(1.0 / 60.0).unwrap();
    let frame: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    assert_eq!(frame["tick"], 1);
}
#[test]
fn diagnostics_expose_real_contacts_energy_and_material_without_mutating_time() {
    let mut world = world(&scene());
    for _ in 0..120 {
        world.game_step(1.0 / 60.0).unwrap();
    }
    let frame: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    let physics = query(
        &mut world,
        json!({"op":"physics","contacts":true,"resetEnergy":true}),
    );
    assert_eq!(physics["energy"]["solves"], 120);
    assert!(physics["bodyStates"].as_array().unwrap().len() == 1);
    assert!(
        physics["contactStates"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c["ownerA"].is_null() || c["ownerB"].is_null())
    );
    for field in ["kinetic", "gravity", "spring", "total"] {
        assert!(
            physics["energyStoredJ"][field]
                .as_f64()
                .unwrap()
                .is_finite()
        );
    }
    assert_eq!(
        query(&mut world, json!({"op":"physics"}))["energy"]["solves"],
        0
    );
    let again: Value = serde_json::from_str(&world.current_frame().unwrap()).unwrap();
    assert_eq!(again["time"], frame["time"]);
    assert_eq!(again["tick"], frame["tick"]);
    let point = json!({"x":0,"y":0.1});
    let material = query(
        &mut world,
        json!({"op":"material","owner":10,"point":point}),
    );
    assert!(material["resistanceScale"].as_f64().unwrap() > 0.0);
    assert!(material["uv"].is_object());
}
