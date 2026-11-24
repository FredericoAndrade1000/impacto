//! Public cold flight API contracts. No JS/vacuum solver is used as an oracle.
use batalha_dynamics::{ballistic_flight,NativeWorld};
use serde_json::{Value,json};
mod common;
fn call(v:Value)->Value {serde_json::from_str(&ballistic_flight(&v.to_string()).unwrap()).unwrap()}
fn settings()->Value {
    let mut settings=common::catalogue()["weapons"]["m252"].clone();
    settings.as_object_mut().unwrap().extend(json!({"id":"mortar","preset":"m252","mass":2.2,"caliberMm":81,
        "speed":72,"rate":14,"spread":0,"power":260,"barrel":0.85,"life":45,
        "ammo":"he","trajectory":"high","charge":0.4,"aimAngle":1.1,"fuzeTime":9,
        "charges":[{"value":0.08},{"value":0.25},{"value":0.4},{"value":0.6},{"value":1.0}]}).as_object().unwrap().clone());
    settings
}
#[test]
fn path_density_changes_only_sampling_and_matches_point_including_velocity() {
    let solution=call(json!({"op":"solution","launcher":{"x":2,"y":5},
        "aim":{"x":120,"y":4},"settings":settings(),"inherited":{"x":3,"y":-0.2}}));
    for count in [1,4,16,96,512] {
        let path=call(json!({"op":"path","solution":solution,"count":count,"endTime":9.0}));
        assert_eq!(path.as_array().unwrap().len(),count+1);
        for sample in path.as_array().unwrap() {
            let point=call(json!({"op":"point","solution":solution,"time":sample["time"]}));
            assert_eq!(*sample,point,"count {count}: {sample}");
        }
    }
}
#[test]
fn physical_calibre_and_canonical_coefficients_are_mandatory() {
    let request=json!({"op":"solution","launcher":{"x":0,"y":2},"aim":{"x":50,"y":2},"settings":settings()});
    let mut missing=request.clone();missing["settings"].as_object_mut().unwrap().remove("caliberMm");
    missing["settings"]["radius"]=json!(0.04);
    assert!(ballistic_flight(&missing.to_string()).is_err());
    let admitted=call(request);
    // A flight forecast follows the canonical 120 s horizon rather than the
    // weapon's old display lifetime. Airburst fuzes impose their own shorter limit.
    assert_eq!(admitted["flightLimit"],120.0);
    assert_eq!(call(json!({"op":"point","solution":admitted,"time":120.0}))["time"],120.0);
    for limit in [-1.0,120.0001,1000.0] {
        let mut spoofed=admitted.clone();spoofed["flightLimit"]=json!(limit);
        assert!(ballistic_flight(&json!({"op":"point","solution":spoofed,"time":0}).to_string()).is_err());
        assert!(ballistic_flight(&json!({"op":"path","solution":spoofed,"count":4,"endTime":0}).to_string()).is_err());
    }
    let mut solution=admitted;solution["flight"]["dragCoefficient"]=json!(0.0);
    assert!(ballistic_flight(&json!({"op":"point","solution":solution,"time":1}).to_string()).is_err());
    assert!(ballistic_flight(&json!({"op":"point","solution":{"x":0,"y":0,"vx":10,"vy":0},"time":1}).to_string()).is_err());
}
#[test]
fn mounted_physical_bearing_and_fuze_horizon_do_not_recommend_a_new_control() {
    let mut config=settings();config["detonation"]=json!("airburst");config["fuzeTime"]=json!(0.75);
    let angle=-0.2_f64;
    let solution=call(json!({"op":"mounted","launcher":{"x":2,"y":5,"barrelAngle":angle},
        "aim":{"x":120,"y":4},"settings":config,"inherited":{"x":3,"y":-0.2}}));
    assert_eq!(solution["angle"].as_f64().unwrap().to_bits(),angle.to_bits());
    assert_eq!(solution["charge"],0.4);assert_eq!(solution["time"],0.75);
    assert_eq!(solution["flightLimit"],0.75);
    assert!(ballistic_flight(&json!({"op":"path","solution":solution,"count":16,"endTime":0.751}).to_string()).is_err());
}
#[test]
fn rejected_projectile_admission_preserves_all_world_state_and_energy() {
    let mut world=NativeWorld::new(&[],0.0,-9.81).unwrap();
    world.load_game(&json!({"terrain":"flat","actors":[],"plates":[],"modules":[]}).to_string()).unwrap();
    let before=world.current_frame().unwrap();
    let request=json!({"op":"projectile","projectile":{"x":0,"y":20,"vx":100,"vy":0,
        "mass":1,"radius":0.06,"power":10,"ammo":"ap"}});
    assert!(world.game_command(&request.to_string()).is_err());
    assert_eq!(world.current_frame().unwrap(),before);
    let mut bad=request;bad["projectile"]["caliberMm"]=json!(-1);
    assert!(world.game_command(&bad.to_string()).is_err());assert_eq!(world.current_frame().unwrap(),before);
}
#[test]
fn measured_component_impact_uses_the_predicted_velocity_and_unchanged_he_fill() {
    let mut config=common::catalogue()["weapons"]["m242"].clone();
    config.as_object_mut().unwrap().extend(json!({"id":"autocannon","preset":"m242",
        "ammo":"he","charge":1,"trajectory":"direct","aimAngle":0}).as_object().unwrap().clone());
    let barrel=config["barrel"].as_f64().unwrap();let fill=config["power"].as_f64().unwrap();
    let solution=call(json!({"op":"solution","launcher":{"x":-barrel,"y":20},
        "aim":{"x":200,"y":20},"settings":config}));
    // The HE round has its own speed and drag, distinct from the weapon's first round.
    assert_eq!(solution["speed"].as_f64().unwrap(),config["rounds"]["he"]["speed"].as_f64().unwrap());
    assert_eq!(solution["flight"]["dragCoefficient"].as_f64().unwrap(),config["rounds"]["he"]["drag"].as_f64().unwrap());
    let mut world=NativeWorld::new(&[],0.0,-9.81).unwrap();
    world.load_game(&json!({"terrain":"flat","visualEvents":true,"actors":[
        {"handle":1,"id":"local"},{"handle":2,"id":"opponent"}],"plates":[],
        "modules":[{"owner":10,"actor":2,"id":"target","kind":"engine","x":100,"y":20,
            "width":1,"height":2,"health":110,"maxHealth":110,"physicalMass":100}]}).to_string()).unwrap();
    let command=|world:&mut NativeWorld,request:Value|->Value {
        serde_json::from_str(&world.game_command(&request.to_string()).unwrap()).unwrap()
    };
    command(&mut world,json!({"op":"projectile",
        "projectile":{"numericId":7,"actor":1,"x":solution["x"],"y":solution["y"],
            "vx":solution["vx"],"vy":solution["vy"],"mass":solution["flight"]["mass"],"caliberMm":solution["flight"]["caliberMm"],
            "weapon":"autocannon","ammo":"he","power":fill,"flight":solution["flight"]}}));
    // The round flies the steps of the scene until it strikes; its charge is read on the way.
    let mut events=Vec::new();let mut power=Value::Null;
    for _ in 0..12 {
        let frame:Value=serde_json::from_str(&world.game_step(1.0/60.0).unwrap()).unwrap();
        events.extend(frame["events"].as_array().unwrap().iter().cloned());
        if frame["shots"]==0 {break;}
        power=command(&mut world,json!({"op":"projectiles"}))["result"][0]["power"].clone();
        assert_eq!(power.as_f64(),Some(fill),"HE fill stays constant throughout the flight");
    }
    let impact=events.iter().find(|e|e["type"]=="primary-contact").unwrap();
    let prediction=call(json!({"op":"point","solution":solution,"time":impact["time"]}));
    let speed=(prediction["vx"].as_f64().unwrap().powi(2)+prediction["vy"].as_f64().unwrap().powi(2)).sqrt();
    assert!((impact["speed"].as_f64().unwrap()-speed).abs()<0.002);
    assert!(impact["speed"].as_f64().unwrap()<solution["speed"].as_f64().unwrap());
    assert_eq!(power.as_f64(),Some(fill));
    assert_eq!(command(&mut world,json!({"op":"projectiles"}))["result"],json!([]));
}
