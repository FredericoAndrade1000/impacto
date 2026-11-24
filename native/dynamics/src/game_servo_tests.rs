//! The admitted mechanism limits elevation; a maintained pilot trigger must stay laid between decisions.
use super::*;
use std::f64::consts::PI;

fn ask(world: &mut NativeWorld, mut request: Value) -> Value {
    request["frame"] = json!(false);
    serde_json::from_str::<Value>(&world.game_command_value(&request).unwrap()).unwrap()["result"].clone()
}
fn source(model: &str, preset: &str) -> Value {
    crate::game_templates::source(model, &json!({"preset":preset}), crate::game_damage::fixtures::full_catalogue()).unwrap()
}
fn decision(world: &mut NativeWorld) -> Value {
    let game = world.game.as_mut().unwrap();
    game.refresh_sensors();
    let index = game.actors.iter().position(|a|a.id=="local").unwrap();
    game.scripted_choice(index, game.bounds, Some("opponent")).unwrap().action
}
fn shots(world: &NativeWorld) -> u64 {
    world.game.as_ref().unwrap().actors.iter().find(|a|a.id=="local").unwrap().shots
}

fn catalogued_servo(mount: &str, preset: &str, mirrored: bool) -> Module {
    let cat=crate::game_damage::fixtures::full_catalogue();let profile=&cat["mounts"][mount];
    let (min,max)=(profile["min"].as_f64().unwrap()+0.01,profile["max"].as_f64().unwrap()-0.02);
    let design=json!({"version":crate::CONSTRUCTION_VERSION,"preset":"bunker","nodes":[],"plates":[],
        "components":[{"id":"gun","kind":"weapon","weaponPreset":preset,
            "pose":{"x":0,"y":40,"angle":if mirrored {PI-0.23}else{-PI+0.31},"mirrored":mirrored},
            "mount":{"preset":mount,"sector":{"min":min,"max":max}}}]});
    let compiled=crate::game_construction::compile(&design,cat).unwrap()["compiled"].clone();
    let raw=&compiled["modules"][0];
    crate::game_mounts::WeaponMount::admit(raw,&cat["mounts"],&cat["weapons"][preset],
        raw["width"].as_f64().unwrap(),raw["height"].as_f64().unwrap(),
        crate::game_geometry::BarrelProfile::from_value(raw).unwrap()).unwrap();
    Module::from_value(1,1,raw,&cat["weapons"],&cat["mounts"]).unwrap()
}

fn bounded_servo_sweep(mut gun: Module, start: f64, end: f64) {
    let (min,max)={let mount=gun.mount.as_ref().unwrap();(mount.min,mount.max)};
    assert!(-PI<min && max<PI && max-min<2.0*PI,"the admitted travel is one bounded interval");
    // A carrier may accumulate whole turns; a restored barrel can name the
    // same physical bearing with another turn. Neither authoring nor the
    // servo gains an alternative angular format from those equivalent poses.
    gun.pose.angle+=8.0*PI;gun.barrel_angle=gun.pose.angle+start-6.0*PI;
    let mut servo=ServoState::from_value(gun.owner,&gun.to_value(),Default::default());
    let (dt,rate)=(1.0/60.0,crate::game_motion::ServoProfile::from_module(&gun).max_speed);
    let direction=(end-start).signum();let requested=gun.pose.angle+end+direction*0.05+4.0*PI;
    let mut travel=0.0;
    for _ in 0..((end-start).abs()/rate/dt).ceil() as usize+3 {
        let before=gun.barrel_angle;
        advance_servo(&mut servo,&mut gun,requested,dt);
        let offset=angle_difference(gun.barrel_angle,gun.pose.angle);let step=gun.barrel_angle-before;
        assert!(offset>=min-1e-9 && offset<=max+1e-9,"barrel {offset} left [{min},{max}]");
        assert!(step*direction>=-1e-10,"a step went through the excluded side");
        assert!(step.abs()<=rate*dt+1e-10,"a step exceeded the existing angular rate");
        assert!(servo.velocity.abs()<=rate+1e-10);
        assert!((angle_difference(servo.target,gun.pose.angle)-end).abs()<1e-8);
        travel+=step.abs();
    }
    assert!((angle_difference(gun.barrel_angle,gun.pose.angle)-end).abs()<1e-8,"the barrel reached its actual endpoint");
    assert!((travel-(end-start).abs()).abs()<1e-8,"the full path stayed inside the admitted travel");
    assert_eq!(servo.velocity,0.0);
}

#[test]
fn every_catalogued_servo_traverses_its_admitted_interval_each_frame_without_a_second_angle_wrap() {
    for (mount,preset) in [("light-trunnion","minimi"),("medium-trunnion","m242"),("heavy-trunnion","rh120"),
        ("elevated-trunnion","m119"),("roof-mortar","m224"),("pintle","minimi")] {for mirrored in [false,true] {
        let gun=catalogued_servo(mount,preset,mirrored);let travel=gun.mount.as_ref().unwrap();let (min,max)=(travel.min,travel.max);
        if mount=="pintle" {assert!(max-min>PI,"this admitted arc is wider than the shortest world-angle path");}
        for (start,end) in [(min,max),(max,min)] {bounded_servo_sweep(gun.clone(),start,end);}
        if mount=="pintle" {
            let mut damaged=gun.clone();damaged.elevation_damage=gun.max_health*BARREL_DISABLED_SHARE*0.5;
            assert_eq!(crate::game_motion::ServoProfile::from_module(&damaged).max_speed,travel.max_speed*0.5);
            bounded_servo_sweep(damaged.clone(),min,max);bounded_servo_sweep(damaged.clone(),max,min);
            let mut servo=ServoState::from_value(damaged.owner,&damaged.to_value(),Default::default());let before=damaged.barrel_angle;
            assert!(!advance_servo(&mut servo,&mut damaged,before+max,0.0));assert_eq!(damaged.barrel_angle,before);
            damaged.elevation_damage=damaged.max_health*BARREL_DISABLED_SHARE;damaged.elevation_disabled=true;
            assert!(!advance_servo(&mut servo,&mut damaged,before+min,0.1));assert_eq!(damaged.barrel_angle,before);
        }
    }}
}

#[test]
fn a_pintle_in_the_real_scene_crosses_between_both_stops_through_its_face_for_each_facing_and_authored_parity() {
    for mirrored in [false,true] {
        let mut design=source("guard-post","minimi");
        let gun=design["components"].as_array_mut().unwrap().iter_mut().find(|p|p["kind"]=="weapon").unwrap();
        gun["pose"]=json!({"x":0,"y":90,"angle":PI/2.0,"mirrored":mirrored});
        gun["mount"]=json!({"preset":"pintle","sector":{"min":-1.73,"max":1.74}});
        let mut world=crate::game_damage::fixtures::duel([&design,&design],200.0);
        for actor in ["local","opponent"] {
            let (owner,id,axis,min,max,rate)={
                let game=world.game.as_ref().unwrap();let handle=game.actors.iter().find(|a|a.id==actor).unwrap().handle;
                let gun=game.damage.modules.iter().find(|m|m.actor==handle && m.kind==ComponentKind::Weapon).unwrap();let mount=gun.mount.as_ref().unwrap();
                (gun.owner,gun.cold["id"].clone(),gun.pose.angle,mount.min,mount.max,mount.max_speed)
            };
            for target in [min,max,min] {
                let start=world.game.as_ref().unwrap().damage.module(owner).unwrap().barrel_angle;
                let current=angle_difference(start,axis);let direction=(target-current).signum();let bearing=axis+target;
                let pivot=world.game.as_ref().unwrap().damage.module(owner).unwrap().pose;
                assert_eq!(ask(&mut world,json!({"op":"aim","actorId":actor,
                    "aim":{"x":pivot.x+80.0*cos(bearing),"y":pivot.y+80.0*sin(bearing)},
                    "config":{"id":"machinegun","preset":"minimi","componentId":id,"platform":"vehicle","aimAngle":bearing,"ammo":"ap","charge":1.0}})),true);
                let mut previous=start;let mut travel=0.0;
                for _ in 0..((target-current).abs()/rate*60.0).ceil() as usize+4 {
                    world.game_step(1.0/60.0).unwrap();
                    let gun=world.game.as_ref().unwrap().damage.module(owner).unwrap();let step=gun.barrel_angle-previous;
                    let offset=angle_difference(gun.barrel_angle,gun.pose.angle);
                    assert!(offset>=min-1e-8 && offset<=max+1e-8,"{actor}, parity{mirrored}: {offset} not in [{min},{max}]");
                    assert!(step*direction>=-1e-9 && step.abs()<=rate/60.0+1e-9,"each real frame follows the allowed path at the existing rate");
                    previous=gun.barrel_angle;travel+=step.abs();
                }
                assert!((angle_difference(previous,axis)-target).abs()<1e-8);
                assert!((travel-(target-current).abs()).abs()<1e-8);
            }
        }
    }
}

#[test]
fn artillery_rates_are_shared_by_compiler_and_raw_mount_admission_without_alternate_mount_bypasses() {
    let cat = crate::game_damage::fixtures::full_catalogue();
    for (model,preset,mount,rate) in [
        ("howitzer","m119","heavy-trunnion",PI/30.0), ("howitzer","m119","elevated-trunnion",PI/30.0),
        ("howitzer","m777","heavy-trunnion",PI/30.0), ("howitzer","m777","elevated-trunnion",PI/30.0),
        ("mortar","m224","roof-mortar",PI/18.0), ("mortar","m224","light-trunnion",PI/18.0),
        ("mortar","m252","roof-mortar",PI/18.0), ("mortar","m252","light-trunnion",PI/18.0),
    ] {
        let mut design = source(model,preset);
        let part = design["components"].as_array_mut().unwrap().iter_mut().find(|p|p["kind"]=="weapon").unwrap();
        part["mount"]["preset"] = json!(mount);
        let compiled = crate::game_construction::compile(&design,cat).unwrap()["compiled"].clone();
        let raw = compiled["modules"].as_array().unwrap().iter().find(|m|m["kind"]=="weapon").unwrap();
        let weapon = &cat["weapons"][preset];
        let admit = |raw:&Value| crate::game_mounts::WeaponMount::admit(raw,&cat["mounts"],weapon,
            raw["width"].as_f64().unwrap(),raw["height"].as_f64().unwrap(),crate::game_geometry::BarrelProfile::from_value(raw).unwrap());
        assert_eq!(raw["weaponMount"]["maxSpeed"].as_f64().unwrap(),rate,"{preset}/{mount}");
        assert!((raw["weaponMount"]["fireTolerance"].as_f64().unwrap()-PI/1800.0).abs()<1e-15,"{preset}/{mount}");
        assert_eq!(admit(raw).unwrap().max_speed,rate);
        for forged in [cat["mounts"][mount]["maxSpeed"].as_f64().unwrap(),rate*0.5] {
            let mut bad = raw.clone(); bad["weaponMount"]["maxSpeed"] = json!(forged);
            assert!(admit(&bad).is_err(),"{preset}/{mount}: raw rate {forged} must be the exact derived rate");
        }
        for forged in [PI/180.0,0.0] {
            let mut bad=raw.clone();bad["weaponMount"]["fireTolerance"]=json!(forged);
            assert!(admit(&bad).is_err(),"{preset}/{mount}: fire tolerance is a derived family policy");
        }
    }
    for (preset,mount,rate) in [("minimi","light-trunnion",PI/3.0),("minimi","pintle",PI/2.0),
        ("m242","medium-trunnion",PI/4.0),("rh120","heavy-trunnion",PI/6.0)] {
        assert_eq!(crate::game_mounts::effective_speed(&cat["mounts"][mount],&cat["weapons"][preset]).unwrap(),rate);
    }
    let slow = json!({"maxSpeed":PI/90.0,"ratedMass":5000.0});
    assert_eq!(crate::game_mounts::effective_speed(&slow,&cat["weapons"]["m119"]).unwrap(),PI/90.0);
    // A mount carrying four times the weight it is rated for grows to it, and lays it half as fast.
    let rated = json!({"maxSpeed":PI/90.0,"ratedMass":cat["weapons"]["m119"]["installedMassKg"].as_f64().unwrap()/4.0});
    assert_eq!(crate::game_mounts::effective_speed(&rated,&cat["weapons"]["m119"]).unwrap(),PI/180.0);
    assert!(crate::game_mounts::effective_speed(&json!({"maxSpeed":PI/90.0}),&cat["weapons"]["m119"]).is_err(),"a mount states its rated weight");
    for invalid in [json!(0.0),json!(-1.0),json!("fast"),json!(null)] {
        assert!(crate::game_mounts::effective_speed(&slow,&json!({"servoMaxSpeed":invalid})).is_err());
    }
}

#[test]
fn pilot_alignment_is_derived_from_existing_phase_for_every_gun_and_survives_checkpoint_and_replay() {
    let cat = crate::game_damage::fixtures::full_catalogue();
    let dual = crate::game_templates::source("scout",&json!({"preset":"m252","dual":true}),cat).unwrap();
    let mut world = crate::game_damage::fixtures::duel([&dual,&dual],400.0);
    let guns = world.game.as_ref().unwrap().damage.modules.iter().filter(|m|m.actor==1 && m.kind==ComponentKind::Weapon)
        .map(|m|(m.cold["id"].as_str().unwrap().to_owned(),m.barrel_angle)).collect::<Vec<_>>();
    assert_eq!(guns.len(),2);
    for phase in ["decision","before"] {
        let input = json!({"type":"controls","phase":phase,"platform":"vehicle","throttle":0.0,"brake":1.0,
            "componentId":guns[0].0,"aimAngle":guns[0].1+0.2,"aim":{"x":200.0,"y":10.0},"charge":0.25,
            "detonation":"airburst","fuzeTime":2.3,"fire":true,
            "requires_alignment":phase=="before",
            "also":[{"componentId":guns[1].0,"aimAngle":guns[1].1+0.2,"charge":1.0,"fire":true}]});
        let said = ask(&mut world,json!({"op":"input","actorId":"local","input":input}));
        let game = world.game.as_ref().unwrap();let actor = game.actors.iter().find(|a|a.id=="local").unwrap();
        let settings = &actor.trigger.as_ref().unwrap().1;
        assert_eq!(settings.requires_alignment,phase=="decision");
        assert!((settings.servo_fire_tolerance()-if phase=="decision" {PI/1800.0}else{PI/180.0}).abs()<1e-15);
        assert_eq!(actor.also[0].settings.requires_alignment,phase=="decision");
        assert_eq!(settings.aim_angle,Some(guns[0].1+0.2));
        assert_eq!(settings.charge,0.25);assert_eq!(settings.fuze,2.3);
        assert!(settings.value.get("requires_alignment").is_none());
        assert!(said["record"].get("requires_alignment").is_none());
        let current = serde_json::to_value(settings).unwrap();
        let mut incomplete = current.clone();incomplete.as_object_mut().unwrap().remove("requires_alignment");
        assert!(serde_json::from_value::<Settings>(incomplete).is_err(),"a checkpoint must include the current trigger state");
        let mut sequence = rmp_serde::to_vec(settings).unwrap();
        let decoded: Settings = rmp_serde::from_slice(&sequence).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(),current,"current trigger state roundtrips exactly");
        assert_eq!(sequence[0],0xdc,"Settings uses the MessagePack array16 header");
        let length = u16::from_be_bytes([sequence[1],sequence[2]]);
        sequence[1..3].copy_from_slice(&(length-1).to_be_bytes());
        assert_eq!(sequence.pop(),Some(if settings.requires_alignment {0xc3}else{0xc2}));
        assert!(rmp_serde::from_slice::<Settings>(&sequence).is_err(),"an incomplete checkpoint is refused");
        let record = said["record"].clone();
        ask(&mut world,json!({"op":"input","actorId":"local","input":record}));
        let state = world.export_state().unwrap();
        world.import_state(&state).unwrap();
        let actor = world.game.as_ref().unwrap().actors.iter().find(|a|a.id=="local").unwrap();
        assert_eq!(actor.trigger.as_ref().unwrap().1.requires_alignment,phase=="decision");
        assert_eq!(actor.also[0].settings.requires_alignment,phase=="decision");
    }
}

#[test]
fn a_maintained_pilot_trigger_does_not_fire_off_bearing_between_decisions_but_a_manual_one_still_can() {
    let target = source("mining-truck","m2hb");
    for (model,preset,separation) in [("howitzer","m119",500.0),("howitzer","m777",500.0),
        ("mortar","m252",200.0),("recon","m2hb",50.0),("heavy","rh120",100.0)] {
        let own = source(model,preset);
        let mut world = crate::game_damage::fixtures::duel([&own,&target],separation);
        let mut ready = None;
        for tick in 0..1800 {
            if tick%6==0 {
                let mut action = decision(&mut world);
                if action["fire"]==true {ready=Some(action);break;}
                action["fire"]=json!(false);
                ask(&mut world,json!({"op":"input","actorId":"local","input":action}));
            }
            world.game_step(1.0/60.0).unwrap();
        }
        let action = ready.unwrap_or_else(||panic!("{preset}: pilot never laid a viable shot"));
        let saved = world.export_state().unwrap();
        for phase in ["decision","before"] {
            world.import_state(&saved).unwrap();
            ask(&mut world,json!({"op":"setActorState","actorId":"local","state":{"cooldown":0.05}}));
            let mut input=action.clone();input["phase"]=json!(phase);
            ask(&mut world,json!({"op":"input","actorId":"local","input":input}));
            ask(&mut world,json!({"op":"setVehicleState","actorId":"local","state":{"omega":4.0}}));
            for _ in 0..6 {world.game_step(1.0/60.0).unwrap();}
            assert_eq!(shots(&world),u64::from(phase=="before"),"{preset}: {phase}");
        }
    }
}

#[test]
fn a_pilot_looks_at_no_enemy_its_base_shelters() {
    let mut world = crate::game_damage::fixtures::duel([&source("heavy","rh120"),&source("mining-truck","m2hb")],100.0);
    let looks = |world: &mut NativeWorld| {
        let game = world.game.as_mut().unwrap();
        game.refresh_sensors();
        let index = game.actors.iter().position(|a|a.id=="local").unwrap();
        game.scripted_choice(index,game.bounds,None).unwrap().target
    };
    let mut seen = false;
    for _ in 0..600 {
        if looks(&mut world).as_deref()==Some("opponent") {seen=true;break;}
        world.game_step(1.0/60.0).unwrap();
    }
    assert!(seen,"the enemy before it is the one it looks at");
    ask(&mut world,json!({"op":"setActorState","actorId":"opponent","state":{"sheltered":true}}));
    assert_eq!(looks(&mut world),None,"sheltered, the enemy is nobody to aim at: its rounds would harm nothing");
    ask(&mut world,json!({"op":"setActorState","actorId":"opponent","state":{"sheltered":false}}));
    assert_eq!(looks(&mut world).as_deref(),Some("opponent"));
}

#[test]
fn a_gun_fires_at_an_aim_by_its_muzzle_and_along_one_short_of_it() {
    let target = source("mining-truck","m2hb");
    for (model,preset) in [("recon","m2hb"),("heavy","rh120")] {
        let mut world = crate::game_damage::fixtures::duel([&source(model,preset),&target],300.0);
        for _ in 0..30 {world.game_step(1.0/60.0).unwrap();}
        let saved = world.export_state().unwrap();
        let game = world.game.as_ref().unwrap();
        let handle = game.actors.iter().find(|a|a.id=="local").unwrap().handle;
        let gun = game.damage.modules.iter().find(|m|m.actor==handle && m.kind==ComponentKind::Weapon).unwrap();
        let (mount,barrel) = (gun.mount.as_ref().unwrap(),gun.weapon.as_ref().unwrap().barrel);
        // Laid in the middle of the travel of its mount, at a point between its trunnion and its muzzle and at one
        // past its muzzle by less than its round flies in a millisecond.
        let (id,bearing) = (gun.cold["id"].as_str().unwrap().to_owned(),gun.pose.angle+(mount.min+mount.max)*0.5);
        let pivot = (gun.pose.x,gun.pose.y);
        for reach in [barrel*0.6,barrel+0.25] {
            world.import_state(&saved).unwrap();
            let aim = json!({"x":pivot.0+bearing.cos()*reach,"y":pivot.1+bearing.sin()*reach});
            ask(&mut world,json!({"op":"input","actorId":"local","input":{"type":"trigger","phase":"before","platform":"vehicle",
                "componentId":id,"active":true,"aim":aim,"trajectory":"low"}}));
            for _ in 0..90 {world.game_step(1.0/60.0).unwrap();}
            assert!(shots(&world)>0,"{preset}: {reach} m from the trunnion");
        }
    }
}
