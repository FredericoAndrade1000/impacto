//! The typed cold path has the public JSON path's state and export effects.
use super::*;

fn scene() -> Value {
    let mut plate=crate::game_damage::fixtures::plate(1,1,&json!({"definition":{"x":12,"y":3,"angle":0,
        "length":2,"thicknessMm":100,"material":"steel"}})).to_value();plate["actor"]=json!(1);
    json!({"seed":6173,"sensorSeed":7123,"randomState":8291,"terrain":"flat",
        "actors":[{"id":"local","handle":1,"vehicle":{"x":12,"y":3}}],
        "plates":[plate],
        "modules":[{"id":"command","owner":2,"actor":1,"kind":"command",
            "x":12,"y":3.3,"width":0.3,"height":0.2,"physicalMass":8},
            {"id":"camera","owner":3,"actor":1,"kind":"sensor",
            "x":12,"y":3.6,"width":0.32,"height":0.22,"physicalMass":5,
            "sensorMode":"visual","range":500}]})
}

#[test]
fn typed_admission_commands_frames_and_queries_match_json_exactly() {
    let scene = scene();
    let mut json = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let mut typed = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    json.load_game(&scene.to_string()).unwrap();
    typed.load_game_value(&scene).unwrap();
    assert_eq!(
        json.current_frame().unwrap(),
        typed.current_frame().unwrap()
    );
    for _ in 0..60 {
        assert_eq!(
            json.game_step(1.0 / 60.0).unwrap(),
            typed.game_step(1.0 / 60.0).unwrap()
        );
    }
    for command in [
        json!({"op":"physics","contacts":true}),
        json!({"op":"scriptedDecision","actorId":"local","profile":"stationary"}),
        json!({"op":"teamSight","ghosts":[{"team":"local","actorId":"opponent","x":4.0,"y":1.5}]}),
        json!({"op":"control","actorId":"local","throttle":0.5,"brake":0.0}),
        json!({"op":"material","owner":1}),
    ] {
        assert_eq!(
            json.game_command(&command.to_string()),
            typed.game_command_value(&command)
        );
    }
    assert_eq!(
        json.game_step(1.0 / 60.0).unwrap(),
        typed.game_step(1.0 / 60.0).unwrap()
    );
    assert_eq!(
        json.current_frame().unwrap(),
        typed.current_frame().unwrap()
    );
}

#[test]
fn failed_typed_replacement_preserves_the_existing_world_and_memory() {
    let mut world = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    world.load_game_value(&scene()).unwrap();
    world
        .game_command_value(&json!({"op":"teamSight"}))
        .unwrap();
    let before = world.current_frame().unwrap();
    let physics = world.game_command_value(&json!({"op":"physics"})).unwrap();
    let mut bad = scene();
    bad["plates"][0]["indices"] = json!([0, 1, 999]);
    assert!(world.load_game_value(&bad).is_err());
    assert_eq!(world.current_frame().unwrap(), before);
    assert_eq!(
        world.game_command_value(&json!({"op":"physics"})).unwrap(),
        physics
    );
    world.game_step(1.0 / 60.0).unwrap();
}
