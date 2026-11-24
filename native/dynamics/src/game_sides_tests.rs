//! Our fire does not harm our allies, but their armour counts as anyone's: a round, its fragments and its blast meet
//! the plates and pieces of every other construction of the side that fired it that stands as they meet any — they
//! are stopped, turned aside or get through with what is left, and what is behind is covered —, and harm and push
//! none of them. The construction that fired is struck and harmed by its own fire as any other, and its gun does not
//! fire into it. Whole wrecks are intangible to weapons; their already fired rounds and reserve blasts keep their
//! original side and spare the living rest of it.
use super::*;
use crate::game_projectiles::through;
use std::f64::consts::FRAC_PI_2;

/// The height the machine guns of the scouts of `line` fire at, along their bores.
const BORE: f64 = 2.555;

/// Scouts on a line of flat ground with no weight, their machine guns turned to the left and fed from a box in the
/// hull: each construction by its handle, its name, its team and where it stands. A gun at the right fires at what
/// stands at its left. `walls` are upright plates standing on their own, each a construction by its handle, team,
/// place and thickness in millimetres; one of a scout's handle is a plate of that scout.
fn line_with(constructions: &[(u32, &str, &str, f64)], walls: &[(u32, &str, f64, f64)]) -> (NativeWorld, GameState) {
    let at: Vec<_> = constructions.iter().map(|&(handle, name, _, x)| (handle, name, x)).collect();
    let mut scene = crate::game_damage::fixtures::mounted_scene(&at, 2);
    for (actor, &(_, _, team, _)) in scene["actors"].as_array_mut().unwrap().iter_mut().zip(constructions) {
        actor["team"] = json!(team);
        actor["vehicle"]["enabled"] = json!(true);
    }
    scene["modules"].as_array_mut().unwrap().extend(constructions.iter().map(|&(handle, _, _, x)| json!({"owner":handle * 10 + 5,
        "actor":handle,"id":format!("{handle}-ammo"),"kind":"ammo","ammoPreset":"minimi","rounds":200,"x":x + 1.0,"y":1.2})));
    // Each wall a metre tall, its middle 0.3 m under the muzzle of the gun of the scout, at 2.7 m.
    for (i, &(handle, team, x, thickness)) in walls.iter().enumerate() {
        let owner = 190 + i as u32;
        let mut plate = crate::game_damage::fixtures::plate(owner, handle, &json!({"definition":{"id":format!("wall{owner}"),
            "x":x,"y":2.4,"length":1.0,"angle":FRAC_PI_2,"thicknessMm":thickness,"material":"steel"}})).to_value();
        plate["owner"] = json!(owner);
        plate["actor"] = json!(handle);
        scene["plates"].as_array_mut().unwrap().push(plate);
        if !constructions.iter().any(|c| c.0 == handle) {
            scene["actors"].as_array_mut().unwrap().push(json!({"handle":handle,"id":format!("wall{handle}"),"team":team,"x":x}));
        }
    }
    scene["visualEvents"] = json!(true);
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    core.load_game(&scene.to_string()).unwrap();
    let game = core.game.take().unwrap();
    (core, game)
}
fn line(constructions: &[(u32, &str, &str, f64)]) -> (NativeWorld, GameState) {
    line_with(constructions, &[])
}
/// What shows a construction was struck: what each plate and each piece of it has taken.
fn wear(game: &GameState, actor: u32) -> Vec<u64> {
    game.damage.plates.iter().filter(|p| p.actor == actor).flat_map(|p| [p.revision, p.mark_revision])
        .chain(game.damage.modules.iter().filter(|m| m.actor == actor)
            .flat_map(|m| [m.health.to_bits(), m.barrel_damage.to_bits(), m.mark_revision]))
        .collect()
}
/// How much a construction has taken: the health its pieces lost and what its plates lost of their area.
fn harm(game: &GameState, actor: u32) -> f64 {
    game.damage.modules.iter().filter(|m| m.actor == actor).map(|m| m.max_health - m.health).sum::<f64>()
        + game.damage.plates.iter().filter(|p| p.actor == actor)
            .map(|p| 1000.0 * (1.0 - p.to_value()["integrity"].as_f64().unwrap())).sum::<f64>()
}
/// How fast the body of a construction moves.
fn motion(core: &NativeWorld, game: &GameState, actor: u32) -> Vector {
    let body = game.actors.iter().find(|a| a.handle == actor).unwrap().body;
    core.world.bodies[core.bodies[&body]].linvel()
}
/// How often a round of construction `shooter` met construction `target`, as the field tells it.
fn contacts(game: &GameState, shooter: u32, target: u32) -> usize {
    game.events.iter().filter(|e| e["primaryContact"] == true && e["shooterActor"] == shooter && e["targetActor"] == target)
        .count()
}
fn gun(game: &GameState, actor: u32) -> &Module {
    game.damage.modules.iter().find(|m| m.actor == actor && m.kind == ComponentKind::Weapon).unwrap()
}
/// The mouth of the machine gun of `actor`.
fn muzzle(game: &GameState, actor: u32) -> Point {
    let gun = gun(game, actor);
    muzzle_point(Point::new(gun.pose.x, gun.pose.y), gun.barrel_angle, gun.weapon.as_ref().unwrap().barrel)
}
/// The machine gun of `actor` is told to fire one round to the left along its bore: whether it fired.
fn trigger(core: &mut NativeWorld, game: &mut GameState, actor: u32) -> bool {
    let (id, angle, ammo, name) = {
        let gun = gun(game, actor);
        (gun.cold["id"].clone(), gun.barrel_angle, gun.cold["weaponAmmo"].clone(),
            game.actors.iter().find(|a| a.handle == actor).unwrap().id.clone())
    };
    game.command(core, &json!({"op":"fire","actorId":name,"force":true,"aim":{"x":-500.0,"y":BORE},
        "config":{"id":"machinegun","preset":"minimi","componentId":id,"platform":"vehicle","aimAngle":angle,"ammo":ammo,"charge":1.0}}))
        .unwrap() == true
}
/// The machine gun of `actor` fires one round to the left along its bore, and the field goes on for half a second.
fn fire(core: &mut NativeWorld, game: &mut GameState, actor: u32) {
    assert!(trigger(core, game, actor));
    run(core, game, 30);
}
fn run(core: &mut NativeWorld, game: &mut GameState, steps: usize) {
    for _ in 0..steps {
        game.step(core, 1.0 / 60.0).unwrap();
    }
}
/// A round put in the air as if fired from the gun of `actor`: of its side, from `from` at `speed` along the bore (to
/// the right for a positive one), what it is and what it can pierce.
fn round(game: &mut GameState, actor: u32, from: Point, speed: f64, ammo: &str, power: f64, fuze: Option<f64>) {
    let owner = gun(game, actor).owner;
    let mut round = json!({"numericId":900,"actor":actor,"emitterOwners":[owner],"x":from.x,"y":from.y,"vx":speed,"vy":0.0,
        "mass":4.0,"caliberMm":76.0,"power":power,"radius":0.038,"life":5.0,"ammo":ammo,"weapon":"cannon","blastRadius":5.0});
    if let Some(fuze) = fuze {
        round["fuzeTime"] = json!(fuze);
    }
    game.projectiles.projectiles.push(Projectile::from_value(&round).unwrap());
}
/// A shell put in the air as if fired from the gun of `actor`, flying left from `x` along the bore.
fn shell(game: &mut GameState, actor: u32, x: f64, fuze: Option<f64>) {
    round(game, actor, Point::new(x, BORE), -300.0, "he", 420.0, fuze);
}
/// The field goes on until the shell in the air bursts, and no longer.
fn burst(core: &mut NativeWorld, game: &mut GameState) {
    for _ in 0..30 {
        if game.damage.stats.explosions > 0 {
            break;
        }
        game.step(core, 1.0 / 60.0).unwrap();
    }
    assert_eq!(game.damage.stats.explosions, 1);
    assert!(game.projectiles.projectiles.is_empty());
}
/// What the round in the air can still pierce once the field has gone on for `steps`.
fn left(core: &mut NativeWorld, game: &mut GameState, steps: usize) -> f64 {
    run(core, game, steps);
    assert_eq!(game.projectiles.projectiles.len(), 1, "the round is still in the air");
    game.projectiles.projectiles[0].power
}

#[test]
fn a_round_meets_a_friend_in_its_way_as_any_construction_and_harms_it_not() {
    // The friend stands between the gun and the enemy: the round meets it, and takes nothing of it.
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", "blue", 20.0), (4, "opponent", "red", 0.0)]);
    let (friend, own) = (wear(&game, 2), wear(&game, 1));
    let still = motion(&core, &game, 2);
    fire(&mut core, &mut game, 1);
    assert!(contacts(&game, 1, 2) > 0, "the round meets the friend in its way");
    assert!(game.events.iter().filter(|e| e["targetActor"] == 2 && e["primaryContact"] == true).all(|e| e["spared"] == true));
    assert_eq!(wear(&game, 2), friend, "the friend in the way is untouched");
    assert_eq!(motion(&core, &game, 2), still, "and unpushed");
    assert_eq!(wear(&game, 1), own, "and so is the gun that fired");
    // The armour-piercing 5.56 mm round goes through the rear of the friend's tower, with what that leaves of it, and
    // is stopped by what stands in it after that, a friend's tower no less than an enemy's: the enemy behind it is
    // covered.
    let met: Vec<_> = game.events.iter().filter(|e| e["primaryContact"] == true && e["targetActor"] == 2).collect();
    assert!(met.len() >= 2 && met[0]["result"] == "penetration" && met.last().unwrap()["result"] == "blocked", "{}", json!(met));
    assert!(met.last().unwrap()["power"].as_f64().unwrap() < met[0]["power"].as_f64().unwrap() * 0.5,
        "the friend's armour took its share of the round, as the enemy's would");
    assert_eq!(contacts(&game, 1, 4), 0, "and the enemy behind the friend is covered");
    // The enemy stands before the friend: the round strikes the enemy, and the friend behind it, met by what is left
    // of the round, takes nothing.
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 20.0), (2, "local-2", "blue", 0.0)]);
    let friend = wear(&game, 2);
    fire(&mut core, &mut game, 1);
    assert!(contacts(&game, 1, 4) > 0);
    assert_eq!(wear(&game, 2), friend);
}

#[test]
fn direct_diplomacy_protects_current_contacts_and_revocation_restores_damage() {
    for in_flight in [false,true] {
        let (mut core, mut game) = line(&[(1,"local","blue",40.0),(2,"partner","amber",20.0)]);
        let before = wear(&game,2);
        if in_flight { assert!(trigger(&mut core,&mut game,1)); }
        game.command(&mut core,&json!({"op":"alliances","pairs":[["blue","amber"]]})).unwrap();
        assert!(game.sides().friendly(Some(1),2));
        if in_flight { run(&mut core,&mut game,30); } else { fire(&mut core,&mut game,1); }
        assert!(contacts(&game,1,2)>0,"forced fire still meets the partner's real material");
        assert_eq!(wear(&game,2),before,"also for a round already in the air when the alliance was accepted");
        assert!(game.events.iter().filter(|e|e["primaryContact"]==true && e["targetActor"]==2)
            .all(|e|e["spared"]==true && e["friendly"]==true));
        game.command(&mut core,&json!({"op":"alliances","pairs":[]})).unwrap();
        assert!(!game.sides().friendly(Some(1),2));
        fire(&mut core,&mut game,1);
        assert_ne!(wear(&game,2),before,"revocation restores normal damage without changing either physical team");
    }
}

#[test]
fn a_round_loses_on_a_friend_s_plate_what_it_loses_on_anyone_s_and_harms_only_the_others() {
    // A plate of 20 mm standing on its own at 26, of the shooter's side or of the enemy's: the same round flies at it
    // from 32, and after it, before anything else, it can pierce as much.
    let through = |team: &str| {
        let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(5, team, 26.0, 20.0)]);
        game.command(&mut core,&json!({"op":"alliances","pairs":[["blue","amber"]]})).unwrap();
        let plate = wear(&game, 5);
        round(&mut game, 1, Point::new(32.0, BORE), -300.0, "ap", 420.0, None);
        let left = left(&mut core, &mut game, 2);
        assert!(contacts(&game, 1, 5) > 0);
        (left, wear(&game, 5) == plate)
    };
    let (friend, partner, enemy) = (through("blue"), through("amber"), through("red"));
    assert!(friend.0 < 420.0 * 0.95, "the friend's plate took its share of the round: {}", friend.0);
    assert_eq!(friend.0, enemy.0, "and the enemy's the same");
    assert_eq!(partner.0, friend.0,"a direct partner's armour takes exactly the same share");
    assert!(friend.1 && partner.1, "friendly plates are untouched");
    assert!(!enemy.1, "the enemy's is holed");
}

#[test]
fn a_thin_friend_lets_a_round_through_to_the_enemy_behind_it_and_a_heavy_one_shields_it() {
    for (thickness, shielded) in [(5.0, false), (400.0, true)] {
        let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 20.0)], &[(5, "blue", 26.0, thickness)]);
        let (plate, enemy) = (wear(&game, 5), wear(&game, 4));
        round(&mut game, 1, Point::new(32.0, BORE), -300.0, "ap", 420.0, None);
        run(&mut core, &mut game, 10);
        assert!(contacts(&game, 1, 5) > 0, "{thickness} mm");
        assert_eq!(wear(&game, 5), plate, "{thickness} mm of the friend's steel take nothing");
        assert_eq!(contacts(&game, 1, 4) == 0, shielded, "{thickness} mm");
        assert_eq!(wear(&game, 4) == enemy, shielded, "{thickness} mm");
    }
}

#[test]
fn a_friend_s_plate_takes_of_the_enemy_s_round_coming_to_us_what_it_takes_of_ours_going_to_them() {
    // The plate of 20 mm of our side at 26: our round flies left at it from 32, the enemy's right from 20, as fast.
    let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 10.0)], &[(5, "blue", 26.0, 20.0)]);
    round(&mut game, 1, Point::new(32.0, BORE), -300.0, "ap", 420.0, None);
    let ours = left(&mut core, &mut game, 2);
    let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 10.0)], &[(5, "blue", 26.0, 20.0)]);
    let plate = wear(&game, 5);
    round(&mut game, 4, Point::new(20.0, BORE), 300.0, "ap", 420.0, None);
    let theirs = left(&mut core, &mut game, 2);
    assert!(ours < 420.0 * 0.95);
    assert!((ours - theirs).abs() < 1e-6 * ours, "ours {ours}, theirs {theirs}");
    assert_ne!(wear(&game, 5), plate, "the enemy's round harms the plate it crosses");
}

#[test]
fn a_shell_that_strikes_a_friend_bursts_on_it_and_harms_the_enemy_beside_it_where_its_armour_does_not_cover_it() {
    // A plate of 50 mm of the shooter's side at 30, a metre high about the bore, and the enemy hugging it from behind.
    let scene = |wall: Option<(&str, bool)>| {
        let walls: Vec<_> = wall.iter().map(|(team, _)| (5, *team, 30.0, 50.0)).collect();
        let (core, mut game) = line_with(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 27.0)], &walls);
        // The box of the enemy is empty: its rounds, which would blow up beside the plate, are of the enemy's side.
        game.damage.module_mut(45).unwrap().rounds = 0;
        if let Some((_, true)) = wall {
            game.actors.iter_mut().find(|a| a.handle == 5).unwrap().defeated = true;
        }
        (core, game)
    };
    let (mut core, mut game) = scene(Some(("blue", false)));
    let plate = wear(&game, 5);
    shell(&mut game, 1, 33.0, None);
    burst(&mut core, &mut game);
    let explosion = game.events.iter().find(|e| e["type"] == "explosion").unwrap();
    assert_eq!(explosion["detonation"], "impact");
    assert!((explosion["x"].as_f64().unwrap() - 30.025).abs() < 0.02, "it burst on the friend's plate: {explosion}");
    assert_eq!(wear(&game, 5), plate, "which takes nothing");
    let covered = harm(&game, 4);
    assert!(covered > 0.0, "the enemy is harmed where the plate leaves it open");
    // The same programmed burst in the open or beside a wreck harms it alike; a live friend's plate remains cover.
    let (mut core, mut game) = scene(None);
    shell(&mut game, 1, 33.0, Some(2.975 / 300.0));
    burst(&mut core, &mut game);
    let open_wear = wear(&game, 4);
    let open_motion = motion(&core, &game, 4);
    let open_burst = game.events.iter().find(|e| e["type"] == "explosion").unwrap().clone();
    assert!(harm(&game, 4) > covered * 1.5, "open {} covered {covered}", harm(&game, 4));
    let (mut core, mut game) = scene(Some(("blue", true)));
    let wreck = wear(&game, 5);
    shell(&mut game, 1, 33.0, Some(2.975 / 300.0));
    burst(&mut core, &mut game);
    assert_eq!(contacts(&game, 1, 5), 0);
    assert_eq!(wear(&game, 5), wreck, "pressure and fragments do not consume salvage");
    assert_eq!(wear(&game, 4), open_wear, "a wreck neither attenuates the wave nor consumes radial fragment directions");
    assert_eq!(motion(&core, &game, 4), open_motion);
    assert_eq!(game.events.iter().find(|e| e["type"] == "explosion").unwrap(), &open_burst, "the programmed fuze is unchanged");
}

#[test]
fn whole_wrecks_neither_stop_rounds_nor_silence_an_overlapping_mounted_gun() {
    for (wreck_x, explosive) in [(20.0, false), (40.0, false), (20.0, true)] {
        let (mut open_core, mut open) = line(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 0.0)]);
        let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", "blue", wreck_x), (4, "opponent", "red", 0.0)]);
        game.actors.iter_mut().find(|a| a.handle == 2).unwrap().defeated = true;
        for game in [&mut open, &mut game] { game.damage.module_mut(45).unwrap().rounds = 0; }
        let wreck = wear(&game, 2);
        let still = motion(&core, &game, 2);
        if explosive {
            for game in [&mut open, &mut game] { shell(game, 1, 33.0, None); }
            burst(&mut open_core, &mut open); burst(&mut core, &mut game);
            assert_eq!(game.events.iter().find(|e| e["type"] == "explosion"), open.events.iter().find(|e| e["type"] == "explosion"));
        } else {
            fire(&mut open_core, &mut open, 1); fire(&mut core, &mut game, 1);
        }
        assert_eq!(contacts(&game, 1, 2), 0);
        assert_eq!(wear(&game, 2), wreck);
        assert_eq!(motion(&core, &game, 2), still);
        assert!(contacts(&game, 1, 4) > 0, "the round really reaches a living target");
        assert_eq!(wear(&game, 4), wear(&open, 4), "wreck_x={wreck_x}, explosive={explosive}");
    }
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 0.0)]);
    game.actors[0].defeated = true;
    assert!(!trigger(&mut core, &mut game, 1), "the wreck itself is never allowed to fire");
    assert_eq!(game.damage.stats.shots, 0);
}

#[test]
fn a_round_of_the_bench_launcher_is_nobody_s_and_strikes_the_design_it_is_fired_at() {
    // The same round with no gun it left: it stands for no construction, and strikes the one it meets.
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", "blue", 20.0)]);
    let friend = wear(&game, 2);
    shell(&mut game, 1, 30.0, None);
    game.projectiles.projectiles[0].emitter_ids.clear();
    run(&mut core, &mut game, 10);
    assert!(contacts(&game, 1, 2) > 0);
    assert_ne!(wear(&game, 2), friend);
}

#[test]
fn a_shell_that_bursts_among_friends_harms_and_pushes_only_the_enemy() {
    // A friend at 20 and an enemy at 8, their ends seven metres apart: a shell flies over the friend and bursts
    // between them, its blast reaching both.
    for team in ["blue","amber"] {
        let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", team, 20.0), (4, "opponent", "red", 8.0)]);
        game.command(&mut core,&json!({"op":"alliances","pairs":[["blue","amber"]]})).unwrap();
        let (friend, enemy) = (wear(&game, 2), wear(&game, 4));
        let still = (motion(&core, &game, 2), motion(&core, &game, 4));
        round(&mut game, 1, Point::new(36.0, 4.0), -300.0, "he", 420.0, Some(22.0 / 300.0));
        burst(&mut core, &mut game);
        assert!(game.events.iter().any(|e| e["type"] == "explosion" && e["detonation"] == "airburst"
            && (11.0..17.0).contains(&e["x"].as_f64().unwrap())), "it burst between them, in the air");
        assert_eq!(contacts(&game, 1, 2), 0);
        assert_eq!(wear(&game, 2), friend, "the friend takes nothing of the blast ({team})");
        assert_eq!(motion(&core, &game, 2), still.0, "nor is it pushed ({team})");
        assert_ne!(wear(&game, 4), enemy, "the enemy takes it");
        assert_ne!(motion(&core, &game, 4), still.1, "and is pushed");
    }
}

#[test]
fn a_friend_shields_the_enemy_behind_it_from_a_blast_and_its_fragments_as_anyone_does() {
    // The enemy at 8 stands behind the friend at 14 from a blast at 18.
    let blast = |actor: Option<u32>| crate::game_projectiles::Blast { point: Point::new(18.0, 2.0), power: 600.0,
        radius: 10.0, source: None, actor, details: json!({}) };
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", "blue", 14.0), (4, "opponent", "red", 8.0)]);
    let friend = wear(&game, 2);
    game.projectiles.pending_blasts.push_back(blast(Some(1)));
    let mut effects = Effects::new(true);
    game.apply_effects(&mut core, &mut effects).unwrap();
    assert_eq!(wear(&game, 2), friend, "the friend takes nothing");
    let parts = |game: &GameState, actor: u32| -> Vec<u32> {
        game.damage.plates.iter().filter(|p| p.actor == actor).map(|p| p.owner)
            .chain(game.damage.modules.iter().filter(|m| m.actor == actor).map(|m| m.owner)).collect()
    };
    let (theirs, ours) = (parts(&game, 4), parts(&game, 2));
    // The fragments thrown at the enemy end on the friend, harming nothing of it.
    let rays: Vec<_> = game.events.iter().filter(|e| e["type"] == "secondary-ray" && e["internal"] == false).collect();
    assert_eq!(rays.len(), 3);
    for ray in &rays {
        assert!(ray["endX"].as_f64().unwrap() > 11.6, "{ray}");
    }
    let struck = |e: &Value| e["owner"].as_u64().map(|owner| owner as u32);
    assert!(game.events.iter().any(|e|e["type"]=="secondary-impact" && struck(e).is_some_and(|owner|ours.contains(&owner))));
    assert!(game.events.iter().filter(|e| struck(e).is_some_and(|owner| ours.contains(&owner)))
        .all(|e| e["spared"] == true && e["friendly"] == true),"secondary friendly contacts are audit-only too");
    assert!(!game.events.iter().any(|e| e["type"] == "secondary-impact" && struck(e).is_some_and(|owner| theirs.contains(&owner))));
    // With the friend out of the way, the pieces of the enemy take far more of the same blast.
    let wounds = |game: &GameState| game.damage.modules.iter().filter(|m| m.actor == 4).map(|m| m.max_health - m.health).sum::<f64>();
    let sheltered = wounds(&game);
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (2, "local-2", "blue", 30.0), (4, "opponent", "red", 8.0)]);
    game.projectiles.pending_blasts.push_back(blast(Some(1)));
    game.apply_effects(&mut core, &mut Effects::new(true)).unwrap();
    assert!(wounds(&game) > sheltered * 4.0, "open {} sheltered {sheltered}", wounds(&game));
}

#[test]
fn a_vehicle_that_shells_an_enemy_at_point_blank_is_harmed_by_its_own_blast() {
    // The enemy at 35 nearly touches the vehicle at 40. The shell leaves its muzzle, flies over its front and bursts on
    // the enemy, its blast reaching back over the whole front of the vehicle.
    let (mut core, mut game) = line(&[(1, "local", "blue", 40.0), (4, "opponent", "red", 35.0), (2, "local-2", "blue", 46.0)]);
    // The box of the enemy is empty: its rounds, which would blow up beside the vehicle, are of the enemy's side.
    game.damage.module_mut(45).unwrap().rounds = 0;
    let (own, enemy, friend) = (wear(&game, 1), wear(&game, 4), wear(&game, 2));
    let still = (motion(&core, &game, 1), motion(&core, &game, 2));
    let from = muzzle(&game, 1);
    shell(&mut game, 1, from.x, None);
    burst(&mut core, &mut game);
    assert_eq!(contacts(&game, 1, 1), 0, "it left its own gun clear of the vehicle");
    assert!(contacts(&game, 1, 4) > 0);
    assert_ne!(wear(&game, 4), enemy);
    assert_ne!(wear(&game, 1), own, "its own blast harms it");
    assert_ne!(motion(&core, &game, 1), still.0, "and pushes it");
    assert_eq!(wear(&game, 2), friend, "the friend behind it takes nothing");
    assert_eq!(motion(&core, &game, 2), still.1);
}

#[test]
fn a_round_strikes_a_plate_of_the_construction_that_fired_it_as_any_other() {
    // A plate of the vehicle's own stands a metre before its front, across its bore.
    let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(1, "blue", 36.5, 20.0)]);
    let own = wear(&game, 1);
    let from = muzzle(&game, 1);
    round(&mut game, 1, from, -300.0, "ap", 420.0, None);
    run(&mut core, &mut game, 5);
    assert!(contacts(&game, 1, 1) > 0, "the round strikes its own plate");
    assert_ne!(wear(&game, 1), own, "and holes it");
}

#[test]
fn a_gun_does_not_fire_into_its_own_vehicle_and_fires_through_a_friend() {
    // The design of the owner's picture: a plate of the vehicle's own set before its muzzle, across its bore.
    let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(1, "blue", 36.5, 20.0)]);
    let (own, rounds, still) = (wear(&game, 1), game.damage.module(15).unwrap().rounds, motion(&core, &game, 1));
    assert!(!trigger(&mut core, &mut game, 1), "the gun does not fire");
    assert!(game.projectiles.projectiles.is_empty());
    assert_eq!(game.damage.stats.shots, 0);
    assert_eq!(game.damage.module(15).unwrap().rounds, rounds, "no round is spent");
    assert_eq!(motion(&core, &game, 1), still, "and nothing recoils");
    assert!(game.events.iter().any(|e| e["type"] == "weapon-blocked" && e["reason"] == "own-vehicle"));
    run(&mut core, &mut game, 30);
    assert_eq!(wear(&game, 1), own);
    // The same plate a friend's or an enemy's: the gun fires at it, and harms only the enemy's.
    for team in ["blue", "red"] {
        let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(5, team, 36.5, 20.0)]);
        let plate = wear(&game, 5);
        fire(&mut core, &mut game, 1);
        assert_eq!(game.damage.stats.shots, 1, "{team}");
        assert!(contacts(&game, 1, 5) > 0, "{team}");
        assert_eq!(wear(&game, 5) == plate, team == "blue", "{team}");
    }
}

#[test]
fn a_line_of_fire_tells_its_own_construction_and_an_ally_that_would_stop_its_round() {
    let drag = crate::game_flight::Drag::admit(4.0, 76.0, "cannon", None).unwrap();
    let shot = |game: &GameState, from: Point, ammo: &str| LineOfFire { gun: gun(game, 1).owner, point: from,
        velocity: Point::new(-300.0, 0.0), drag, ammo: Ammo::from_name(ammo), power: 420.0 };
    let ask = |walls: &[(u32, &str, f64, f64)], ammo: &str| {
        let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], walls);
        game.command(&mut core,&json!({"op":"alliances","pairs":[["blue","amber"]]})).unwrap();
        let line = shot(&game, muzzle(&game, 1), ammo);
        let sides = game.sides();
        let (own, allies) = game.spans_with_sides(1, &sides);
        line_of_fire(sides.wrecks(), &line, 1.0, (1, own), &allies, ROUND_STEP, &game.damage, &game.geometry, &game.terrain)
    };
    assert_eq!(ask(&[], "ap"), Line::Clear);
    assert_eq!(ask(&[(1, "blue", 36.5, 20.0)], "ap"), Line::Own, "its own plate before its muzzle");
    assert_eq!(ask(&[(5, "blue", 30.0, 400.0)], "ap"), Line::Ally, "a friend's plate that stops the round");
    assert_eq!(ask(&[(5, "blue", 30.0, 5.0)], "ap"), Line::Clear, "a friend's plate it gets through");
    assert_eq!(ask(&[(5, "blue", 30.0, 5.0)], "he"), Line::Ally, "a shell bursts on it all the same");
    assert_eq!(ask(&[(5, "red", 30.0, 400.0)], "ap"), Line::Clear, "an enemy's plate is what it is fired at");
    assert_eq!(ask(&[(5, "amber", 30.0, 400.0)], "ap"), Line::Ally, "a direct partner that would stop the round");
    assert_eq!(ask(&[(5, "amber", 30.0, 5.0)], "ap"), Line::Clear, "a useful kinetic round may cross a partner");
    assert_eq!(ask(&[(5, "amber", 30.0, 5.0)], "apfsds"), Line::Clear);
    assert_eq!(ask(&[(5, "amber", 30.0, 5.0)], "heat"), Line::Ally, "an explosive cannot pass the partner safely");
    // What a round is told it keeps past a friend's plate is what the round flown keeps of it.
    let flown = |walls: &[(u32, &str, f64, f64)]| {
        let (mut core, mut game) = line_with(&[(1, "local", "blue", 40.0)], walls);
        round(&mut game, 1, Point::new(32.0, BORE), -300.0, "ap", 420.0, None);
        left(&mut core, &mut game, 2)
    };
    let kept = flown(&[(5, "blue", 26.0, 20.0)]) / flown(&[]);
    let (_core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(5, "blue", 26.0, 20.0)]);
    let wall = game.extents()[&5];
    let told = through(&[], &shot(&game, Point::new(32.0, BORE), "ap"), 5, wall, 1.0, ROUND_STEP, &game.damage, &game.geometry,
        &game.terrain).unwrap();
    assert!(kept < 0.95 && (told - kept).abs() < 0.01, "told {told}, kept {kept}");
}

#[test]
fn a_timed_shell_is_not_blocked_by_a_return_after_its_fuze_fires() {
    let (_core, mut game) = line_with(&[(1, "local", "blue", 40.0)], &[(1, "blue", 30.0, 20.0)]);
    let near = game.extents()[&1];
    let contact = |until| first_contact_near(&[], Point::new(30.0, 4.0), Point::new(0.0, 8.0),
        crate::game_flight::Drag { per_meter: 0.0, cd: 0.0 }, &[], near, until, ROUND_STEP, &game.geometry, &game.terrain);
    assert_eq!(contact(0.2), None, "the shell bursts in clear air before returning");
    assert_eq!(contact(5.0), Some(1), "without the early burst it would strike its own plate");
}

/// Three constructions of an engine each and the ammunition of the second, carried out in the open: the second and the
/// first of team `blue`, the third of team `red`. The magazine stands between the first and the third, as far from each,
/// and below the engine of its own construction.
fn depot() -> (NativeWorld, GameState) {
    let engine = |owner: u32, actor: u32, x: f64, y: f64| json!({"owner":owner,"actor":actor,"id":format!("engine{owner}"),"kind":"engine",
        "x":x,"y":y,"width":0.6,"height":0.6,"physicalMass":500,"health":300,"maxHealth":300});
    let scene = json!({"terrain":"flat","seed":6173,"visualEvents":false,"catalogue":crate::game_damage::fixtures::catalogue(),"bounds":{"minX":-50,"maxX":50,"minY":-5,"maxY":30},
        "actors":[{"id":"first","handle":1,"team":"blue","vehicle":{"x":1.6,"y":3.0,"enabled":true}},
            {"id":"second","handle":2,"team":"blue","vehicle":{"x":0.0,"y":3.0,"enabled":true}},
            {"id":"third","handle":3,"team":"red","vehicle":{"x":-1.6,"y":3.0,"enabled":true}}],
        "plates":[],
        "modules":[engine(10, 1, 1.6, 3.0), engine(20, 2, 0.0, 4.0), engine(30, 3, -1.6, 3.0),
            {"owner":21,"actor":2,"id":"magazine","kind":"ammo","x":0.0,"y":3.0,"width":0.8,"height":0.6,"mechanicalDepth":1.0,
                "rounds":8,"capacityRounds":8,"ammoPreset":"rh120","physicalMass":350,"exposed":true}]});
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    core.load_game(&scene.to_string()).unwrap();
    let game = core.game.take().unwrap();
    (core, game)
}

#[test]
fn ammunition_harms_its_own_construction_and_the_enemy_beside_it_and_spares_the_rest_of_its_side() {
    for wrecked in [false, true] {
        let (mut core, mut game) = depot();
        // A construction just put out of the fight is a wreck: its ammunition is still of its side.
        game.actors[1].defeated = wrecked;
        let health = |game: &GameState, owner: u32| game.damage.module(owner).unwrap().health;
        let still = (motion(&core, &game, 1), motion(&core, &game, 3));
        let mut effects = Effects::new(false);
        game.damage.destroy_module(21, &mut effects);
        game.apply_effects(&mut core, &mut effects).unwrap();
        assert_eq!(game.damage.stats.explosions, 1);
        assert_eq!(health(&game, 10), 300.0, "the friend beside it takes nothing (wreck {wrecked})");
        assert_eq!(motion(&core, &game, 1), still.0, "nor is it pushed (wreck {wrecked})");
        assert!(health(&game, 30) < 300.0, "the enemy beside it is harmed (wreck {wrecked})");
        assert_ne!(motion(&core, &game, 3), still.1, "and pushed (wreck {wrecked})");
        if wrecked { assert_eq!(health(&game, 20), 300.0, "its own wreck is intangible too"); }
        else { assert!(health(&game, 20) < 300.0, "a living carrier is still harmed by its own reserve"); }
    }
}

#[test]
fn the_sides_of_a_field_are_its_teams_and_a_wreck_is_of_none() {
    let sides = crate::game_projectiles::Sides::new([(1, "blue", false, false), (2, "red", false, false), (3, "blue", false, false),
        (4, "blue", true, false), (5, "alvo", false, false)], |_, _| false);
    let allies = |actor: Option<u32>| sides.allies(actor).collect::<Vec<_>>();
    assert_eq!(sides.wrecks(), &[4]);
    assert_eq!(allies(Some(1)), [3], "a construction is no ally of itself");
    assert_eq!(allies(Some(4)), [1, 3], "a wreck's rounds are still of its side");
    assert!(allies(Some(2)).is_empty());
    assert!(allies(Some(5)).is_empty());
    assert!(allies(None).is_empty());
    assert!(allies(Some(9)).is_empty(), "nor are a round's whose construction left the field");
    let aliased = crate::game_projectiles::Sides::new([(7, "blue", true, false), (7, "blue", false, false)], |_, _| false);
    assert!(aliased.wrecks().is_empty(), "a live occurrence keeps its handle tangible");
    for live_last in [false, true] { for sheltered in [false, true] {
        let mut rows = [(7, "blue", true, false), (7, "red", false, sheltered)];
        if !live_last { rows.reverse(); }
        let aliased = crate::game_projectiles::Sides::new(rows.into_iter().chain([(8, "blue", false, false), (9, "red", false, false)]), |_, _| false);
        assert!(aliased.wrecks().is_empty(), "live_last={live_last}, sheltered={sheltered}");
        assert_eq!(aliased.allies(Some(7)).collect::<Vec<_>>(), [if live_last {9} else {8}], "the last side still wins");
    }}
    let wreck_alias = crate::game_projectiles::Sides::new([(7, "blue", true, false), (7, "red", true, true)], |_, _| false);
    assert_eq!(wreck_alias.wrecks(), &[7], "all occurrences are defeated, coalesced once");
}

#[test]
fn a_sheltered_construction_is_spared_by_every_side_and_a_sheltered_wreck_by_none() {
    let sides = crate::game_projectiles::Sides::new([(1, "blue", false, false), (2, "red", false, true), (3, "blue", false, true),
        (4, "red", true, true), (5, "red", false, false)], |_, _| false);
    let allies = |actor: Option<u32>| sides.allies(actor).collect::<Vec<_>>();
    assert_eq!(allies(Some(1)), [2, 3], "its own side's and the enemy's sheltered");
    assert_eq!(allies(Some(5)), [2, 3]);
    assert_eq!(allies(Some(2)), [5, 3], "a sheltered one is no ally of itself");
    assert_eq!(allies(None), [2, 3], "nor is it harmed by the rounds of nobody");
    assert!(!allies(Some(1)).contains(&4), "a wreck is intangible rather than a spared live ally");
    assert_eq!(sides.wrecks(), &[4]);
    assert!(sides.friendly(Some(1),3),"a sheltered friend is still friendly");
    assert!(!sides.friendly(Some(1),2),"an enemy shelter must keep its visible material contact");
    assert!(!sides.friendly(Some(1),4),"the enemy's defeat does not change its diplomatic relationship");
}

#[test]
fn diplomatic_protection_is_direct_and_symmetric_not_transitive_or_self_protection() {
    let sides = crate::game_projectiles::Sides::new([(1,"blue",false,false),(2,"amber",false,false),
        (3,"green",false,false),(4,"red",false,false),(5,"amber",true,false)],
        |a,b| matches!((a,b),("blue","amber") | ("amber","green")));
    assert_eq!(sides.allies(Some(1)).collect::<Vec<_>>(),[2]);
    assert_eq!(sides.allies(Some(2)).collect::<Vec<_>>(),[1,3]);
    assert_eq!(sides.allies(Some(3)).collect::<Vec<_>>(),[2]);
    assert!(sides.friendly(Some(1),2) && sides.friendly(Some(2),1));
    assert!(!sides.friendly(Some(1),3) && !sides.friendly(Some(1),1) && !sides.friendly(None,2));
    assert!(sides.friendly(Some(1),5),"the relationship cannot disclose the target's defeat to a pilot");
    assert_eq!(sides.allies(Some(5)).collect::<Vec<_>>(),[2,1,3],"the wreck's old rounds keep their direct partners");
}

/// Shelters construction `name` of the field, or lets it be harmed and fire again.
fn shelter(core: &mut NativeWorld, game: &mut GameState, name: &str, sheltered: bool) {
    game.command(core, &json!({"op":"setActorState","actorId":name,"state":{"sheltered":sheltered}})).unwrap();
}

#[test]
fn a_sheltered_construction_takes_no_harm_and_no_push_from_an_enemy_round_or_blast_and_fires_none() {
    // The enemy at 40 fires at the sheltered one at 20: the round meets it and takes nothing of it.
    let (mut core, mut game) = line(&[(1, "opponent", "red", 40.0), (2, "local", "blue", 20.0)]);
    shelter(&mut core, &mut game, "local", true);
    let (sheltered, still) = (wear(&game, 2), motion(&core, &game, 2));
    fire(&mut core, &mut game, 1);
    assert!(contacts(&game, 1, 2) > 0, "the round meets it");
    assert_eq!(wear(&game, 2), sheltered, "and harms it not");
    assert_eq!(motion(&core, &game, 2), still, "nor pushes it");
    assert!(game.events.iter().filter(|e|e["primaryContact"]==true && e["targetActor"]==2)
        .all(|e|e["spared"]==true && e["friendly"].is_null()),"enemy shelter remains a presentable material contact");
    // A shell that bursts over it harms it no more, where it harms one that is not sheltered.
    for shelter_it in [true, false] {
        let (mut core, mut game) = line(&[(1, "opponent", "red", 40.0), (2, "local", "blue", 20.0)]);
        shelter(&mut core, &mut game, "local", shelter_it);
        let (before, still) = (wear(&game, 2), motion(&core, &game, 2));
        round(&mut game, 1, Point::new(36.0, 4.0), -300.0, "he", 420.0, Some(14.0 / 300.0));
        // Out of its shelter, what the blast sets off aboard it may burst in the same step.
        for _ in 0..30 {
            if game.damage.stats.explosions > 0 {
                break;
            }
            game.step(&mut core, 1.0 / 60.0).unwrap();
        }
        assert!(game.damage.stats.explosions > 0 && game.projectiles.projectiles.is_empty(), "the shell burst");
        assert_eq!(wear(&game, 2) == before, shelter_it, "the blast harms it only out of its shelter");
        assert_eq!(motion(&core, &game, 2) == still, shelter_it, "and pushes it only so");
    }
    // Its own gun puts no round in the air.
    assert!(!trigger(&mut core, &mut game, 2), "a sheltered construction fires none");
    // Sheltered no longer, it is struck as any other, and fires again.
    shelter(&mut core, &mut game, "local", false);
    fire(&mut core, &mut game, 1);
    assert_ne!(wear(&game, 2), sheltered, "out of its shelter the enemy's round harms it");
    assert!(trigger(&mut core, &mut game, 2));
    assert!(game.command(&mut core, &json!({"op":"setActorState","actorId":"local","state":{"sheltered":1}})).is_err(),
        "a shelter is said yes or no");
}
