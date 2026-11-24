use super::*;

#[test]
fn restored_queries_rebuild_damaged_and_inactive_material_before_the_first_step() {
    let mut scene = crate::game_damage::fixtures::mounted_scene(&[(1, "local", 0.0), (2, "opponent", 20.0)], 2);
    scene["visualEvents"] = json!(true);
    let loose = scene["modules"].as_array_mut().unwrap().iter_mut().find(|m| m["kind"] == "wheel").unwrap();
    loose["attached"] = json!(false);
    loose["x"] = json!(100.0);
    loose["y"] = json!(10.0);
    let loaded = || {
        let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
        core.load_game(&scene.to_string()).unwrap();
        core
    };
    let ask = |core: &mut NativeWorld, mut request: Value| {
        request["frame"] = json!(false);
        serde_json::from_str::<Value>(&core.game_command(&request.to_string()).unwrap()).unwrap()["result"].clone()
    };
    let shapes = |core: &NativeWorld| {
        let game = core.game.as_ref().unwrap();
        game.damage.plates.iter().map(|p| p.owner).chain(game.damage.modules.iter().map(|m| m.owner))
            .map(|owner| (owner, game.geometry.shapes_world(owner).unwrap().iter().flatten()
                .map(|p| (p.x.to_bits(), p.y.to_bits())).collect::<Vec<_>>())).collect::<Vec<_>>()
    };
    let mut one = loaded();
    for _ in 0..15 { one.game_step(1.0 / 60.0).unwrap(); }
    let plate = &one.game.as_ref().unwrap().damage.plates[0];
    let cut = json!({"op":"cut","owner":plate.owner,"start":plate.pose.world_point(Point::new(0.0,-0.3)),
        "end":plate.pose.world_point(Point::new(0.0,0.3)),"radius":0.08});
    assert_eq!(ask(&mut one, cut), true);
    ask(&mut one, json!({"op":"projectile","projectile":{"x":-50.0,"y":50.0,"vx":20.0,"vy":0.0,
        "mass":1.0,"caliberMm":20.0,"power":5.0}}));
    one.game_step(1.0 / 60.0).unwrap();
    let game = one.game.as_mut().unwrap();
    game.extents();
    game.geometry.index();
    let spans = game.extents.clone();
    assert_eq!(spans.0, game.tick);
    assert!(!spans.1.is_empty());
    let state = one.export_state().unwrap();
    let mut resumed = loaded();
    resumed.import_state(&state).unwrap();
    assert_eq!(resumed.game.as_ref().unwrap().extents, spans, "the current tick keeps its measured spans");
    assert_eq!(shapes(&resumed), shapes(&one), "world contours retain every floating-point bit");
    for y in [0.0, 1.0, 2.0, 3.0, 10.0] {
        let ray = json!({"op":"raycastLayers","start":{"x":-100.0,"y":y},"end":{"x":150.0,"y":y}});
        assert_eq!(ask(&mut resumed, ray.clone()), ask(&mut one, ray));
    }
    assert_eq!(ask(&mut resumed, json!({"op":"teamSight"})), ask(&mut one, json!({"op":"teamSight"})));
    for _ in 0..90 {
        one.game_step(1.0 / 60.0).unwrap();
        resumed.game_step(1.0 / 60.0).unwrap();
        assert_eq!(ask(&mut resumed, json!({"op":"digest"})), ask(&mut one, json!({"op":"digest"})));
    }
    assert_eq!(resumed.current_frame().unwrap(), one.current_frame().unwrap());
}
