//! A side holds its fire while it has as many rounds in the air as the field lets it, and fires again as they come
//! down; the round it holds stays in its box. A construction still fires the few rounds of its own the field lets it
//! have up whatever its side has, and the rounds of one side hold no gun of another. A field with no budget holds none.
use super::*;

/// Scouts on flat ground with their machine guns turned to the left and fed from a box in the hull: two of side `a`
/// and one of side `b`, each by its handle, its name and where it stands, on a field with `budget`.
fn scouts(budget: Value) -> NativeWorld {
    let at = [(1, "a1", 0.0), (2, "a2", 40.0), (3, "b1", 80.0)];
    let mut scene = crate::game_damage::fixtures::mounted_scene(&at, 2);
    for (actor, team) in scene["actors"].as_array_mut().unwrap().iter_mut().zip(["a", "a", "b"]) {
        actor["team"] = json!(team);
        actor["vehicle"]["enabled"] = json!(true);
    }
    scene["modules"].as_array_mut().unwrap().extend(at.iter().map(|&(handle, _, x)| json!({"owner":handle * 10 + 5,
        "actor":handle,"id":format!("{handle}-ammo"),"kind":"ammo","ammoPreset":"minimi","rounds":200,"x":x + 1.0,"y":1.2})));
    scene["visualEvents"] = json!(true);
    scene["shotBudget"] = budget;
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    core.load_game(&scene.to_string()).unwrap();
    core
}
fn game(core: &mut NativeWorld) -> &mut GameState {
    core.game.as_mut().unwrap()
}
/// The machine gun of `actor` is told to fire one round to the left along its bore, its reload aside: whether it fired.
fn trigger(core: &mut NativeWorld, actor: u32) -> bool {
    let request = {
        let game = game(core);
        let gun = game.damage.modules.iter().find(|m| m.actor == actor && m.kind == ComponentKind::Weapon).unwrap();
        let name = &game.actors.iter().find(|a| a.handle == actor).unwrap().id;
        json!({"op":"fire","actorId":name,"force":true,"aim":{"x":-500.0,"y":2.555},"frame":false,
            "config":{"id":"machinegun","preset":"minimi","componentId":gun.cold["id"],"platform":"vehicle","aimAngle":gun.barrel_angle,
                "ammo":gun.cold["weaponAmmo"],"charge":1.0}})
    };
    serde_json::from_str::<Value>(&core.game_command(&request.to_string()).unwrap()).unwrap()["result"] == true
}
/// The rounds left in the box of `actor`.
fn rounds(core: &mut NativeWorld, actor: u32) -> u32 {
    game(core).damage.modules.iter().find(|m| m.actor == actor && m.kind == ComponentKind::Ammo).unwrap().rounds
}
/// The times the guns of `actor` were held by the rounds of their side in the air, as the field tells it.
fn held(core: &mut NativeWorld, actor: &str) -> usize {
    game(core).events.iter().filter(|e| e["type"] == "weapon-blocked" && e["reason"] == "budget" && e["actorId"] == actor).count()
}
/// Whether what the field has counted in the air of each side and construction is what there is.
fn counted(core: &NativeWorld) -> bool {
    let game = core.game.as_ref().unwrap();
    let sides: HashMap<u32, &str> = game.actors.iter().map(|a| (a.handle, a.team.as_str())).collect();
    game.airborne == Airborne::of(game.projectiles.projectiles.iter().filter_map(|p| p.actor), |actor| sides.get(&actor).copied())
}

#[test]
fn a_side_at_its_share_holds_its_fire_with_its_rounds_in_the_box_until_some_come_down() {
    let mut core = scouts(json!({"faction":3,"own":1}));
    for _ in 0..3 {
        assert!(trigger(&mut core, 1), "below the share of its side");
    }
    assert_eq!(rounds(&mut core, 1), 197);
    assert!(!trigger(&mut core, 1), "its side has its share up, and it more than its own");
    assert_eq!((rounds(&mut core, 1), held(&mut core, "a1")), (197, 1), "the round held stays in its box, and the field says why");
    assert!(trigger(&mut core, 2), "one of the side with none of its own up fires the one it may have");
    assert!(!trigger(&mut core, 2), "and no more");
    assert!(trigger(&mut core, 3), "another side has a share of its own");
    assert!(counted(&core), "counted as each is fired, as counted over");
    for _ in 0..600 {
        if game(&mut core).projectiles.projectiles.is_empty() {
            break;
        }
        core.game_step(1.0 / 60.0).unwrap();
        assert!(counted(&core), "counted over at the end of each step");
    }
    assert!(game(&mut core).projectiles.projectiles.is_empty(), "the rounds came down");
    assert!(trigger(&mut core, 1), "with them down it fires again");
}
#[test]
fn what_a_side_has_in_the_air_is_counted_again_as_a_state_is_taken_back() {
    let mut one = scouts(json!({"faction":2,"own":0}));
    assert!(trigger(&mut one, 1) && trigger(&mut one, 2));
    let state = one.export_state().unwrap();
    let mut other = scouts(json!({"faction":2,"own":0}));
    other.import_state(&state).unwrap();
    assert_eq!(game(&mut other).airborne, game(&mut one).airborne);
    assert!(!trigger(&mut other, 1) && !trigger(&mut one, 1), "both hold its fire alike");
}
#[test]
fn a_field_with_no_budget_holds_no_gun() {
    let mut core = scouts(Value::Null);
    for _ in 0..50 {
        assert!(trigger(&mut core, 1));
    }
    assert_eq!((rounds(&mut core, 1), held(&mut core, "a1")), (150, 0));
}
