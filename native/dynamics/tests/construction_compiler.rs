//! Pure public compiler ABI; these tests do not run or settle a battle.
use batalha_dynamics::{CONSTRUCTION_VERSION, NativeWorld, compile_construction, construction_cost};
use serde_json::{Value,json};
use std::f64::consts::PI;
mod common;

// The floor of the hull on the deck of its chassis, its roof two metres over it.
const FLOOR:f64=0.0;
const ROOF:f64=FLOOR+2.0;

/// A length in metres as a design writes it, in cells of 5 cm: the fixtures are laid out on the grid.
fn c(metres:f64) -> i64 {let n=(metres/0.05).round();assert!((n*0.05-metres).abs()<1e-9,"{metres} m is off the grid");n as i64}
fn node(id:&str,x:f64,y:f64) -> Value {json!({"id":id,"x":c(x),"y":c(y)})}
fn pose(x:f64,y:f64,angle:f64) -> Value {json!({"x":c(x),"y":c(y),"angle":angle})}
fn plate(id:&str,a:&str,b:&str) -> Value {json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":20})}
fn refused(input:&Value) -> Value {
    let value:Value=serde_json::from_str(&compile_construction(&input.to_string()).unwrap()).unwrap();
    assert!(value["error"]["code"].is_string());value["error"].clone()
}
fn compiled(input:&Value) -> (String,Value) {
    let text=compile_construction(&input.to_string()).unwrap();let value:Value=serde_json::from_str(&text).unwrap();assert!(value["error"].is_null(),"{value}");(text,value)
}

fn request() -> Value {
    json!({"version":1,"construction":{"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":{"model":"wheeled","points":[{"x":c(-2.9),"y":0},{"x":c(2.9),"y":0}],"thicknessMm":20.0,"axles":[c(-1.95),0,c(1.9)]},
        "nodes":[node("hull-0",-2.9,FLOOR),node("hull-1",2.9,FLOOR),node("hull-2",2.9,ROOF),node("hull-3",-2.9,ROOF)],
        "plates":[plate("hull:floor","hull-0","hull-1"),plate("hull:rear","hull-1","hull-2"),
            plate("hull:roof","hull-2","hull-3"),plate("hull:front","hull-3","hull-0")],
        "components":[{"id":"gun","kind":"weapon","weaponPreset":"minimi",
            "pose":pose(-2.8,FLOOR+1.0,PI),
            "mount":{"preset":"light-trunnion","radiusM":0.125,"sector":{"min":-0.2,"max":0.2}}}]},
        "catalogue":common::catalogue()})
}

// A room standing on the roof, centred at `x`. Its two feet divide the roof in
// three, and the middle stretch is its floor: one plate with a room on each side.
fn stand_tower(input:&mut Value,x:f64,length:f64,height:f64) {
    let design=&mut input["construction"];let roof=design["nodes"][2]["y"].as_f64().unwrap()*0.05;
    let (front,rear)=(x-length/2.0,x+length/2.0);
    design["nodes"].as_array_mut().unwrap().extend([node("tower-0",front,roof),node("tower-1",rear,roof),
        node("tower-2",rear,roof+height),node("tower-3",front,roof+height)]);
    let plates=design["plates"].as_array_mut().unwrap();
    plates.splice(2..3,[plate("hull:roof","hull-2","tower-1"),plate("tower:floor","tower-1","tower-0"),plate("hull:deck","tower-0","hull-3")]);
    plates.extend([plate("tower:rear","tower-1","tower-2"),plate("tower:roof","tower-2","tower-3"),plate("tower:front","tower-3","tower-0")]);
}

// A node set on a plate divides it: the two stretches take its place in the written order.
fn divide(input:&mut Value,index:usize,joint:Value,stretches:[Value;2]) {
    input["construction"]["nodes"].as_array_mut().unwrap().push(joint);
    input["construction"]["plates"].as_array_mut().unwrap().splice(index..=index,stretches);
}

fn compact_tower(length:f64,height:f64) -> Value {
    let mut input=request();stand_tower(&mut input,0.0,length,height);
    let gun=&mut input["construction"]["components"][0];
    gun["pose"]=pose(-length/2.0+0.1,ROOF+height/2.0,PI);
    gun["mount"]["sector"]=json!({"min":-0.6,"max":0.6});input
}

#[test]
fn tower_elevation_keeps_the_rotating_breech_clear_of_its_floor_and_roof() {
    // The breech turns with the barrel. The low tower admits a narrower sector,
    // while a taller one gives the whole weapon its full travel.
    let mut low=compact_tower(2.0,0.6);
    assert!(({let refusal=&(refused(&low));refusal["code"]=="BREECH_PLATE" && refusal["surface"]=="floor" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("tower:floor")))}));
    low["construction"]["components"][0]["mount"]["sector"]=json!({"min":0.0,"max":0.6});
    assert!(({let refusal=&(refused(&low));refusal["code"]=="BREECH_PLATE" && refusal["surface"]=="roof" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("tower:roof")))}));
    low["construction"]["components"][0]["mount"]["sector"]=json!({"min":-0.4,"max":0.4});
    compiled(&low);
    let mut input=compact_tower(2.0,0.7);
    let (first,result)=compiled(&input);
    let gun=&result["compiled"]["modules"][0];
    assert_eq!(gun["weaponMount"]["min"],-0.6);assert_eq!(gun["weaponMount"]["max"],0.6);
    assert_eq!(gun["weaponMount"]["recoil"],0.0);
    assert_eq!(gun["weaponMount"]["hostId"],"tower:front");
    assert_eq!(gun["width"],0.39);assert_eq!(gun["height"],0.15);
    assert!(gun["physicalMass"].as_f64().unwrap()>16.0);
    assert!(gun["physicalInertia"].as_f64().unwrap()>0.0);
    input["construction"]=result["construction"].clone();
    assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
}

#[test]
fn breech_clearance_includes_recoil_and_finite_armour() {
    // The receiver of the Minimi reaches 0.39 m behind its trunnion, which stands 10 cm behind the face.
    assert!(({let refusal=&(refused(&compact_tower(0.5,0.7)));refusal["code"]=="BREECH_PLATE" && refusal["surface"]=="wall" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("tower:rear")))}));
    let mut recoil_outside=compact_tower(0.6,0.8);
    compiled(&recoil_outside);
    // At this length the receiver itself fits, but not that of a gun that
    // runs 15 cm back in its cradle. Its stroke is not occupied metal or free space.
    recoil_outside["catalogue"]["weapons"]["minimi"]["recoil"]=json!(0.15);
    let refusal=refused(&recoil_outside);
    assert!(refusal["code"]=="BREECH_PLATE" && refusal["surface"]=="wall" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("tower:rear"))),"{refusal}");
    // Laid down in this short tower, its barrel passes out through the front and on into the deck so close before the
    // tower that no port fits there; and its mounting port needs clear armour at either end.
    let refusal=refused(&compact_tower(2.0,0.3));
    assert_eq!((&refusal["code"],&refusal["ids"]),(&json!("MOUNT_PORT"),&json!(["hull:deck","gun"])),"{refusal}");
    assert!((refused(&compact_tower(2.0,0.20))["code"]=="MOUNT_PORT"));
}

fn cannon_request() -> Value {
    let mut input=request();
    input["catalogue"]["mounts"]["heavy-trunnion"]=json!({"families":["cannon"],"ratedMass":5000.0,
        "min":-0.6,"max":0.6,"maxSpeed":std::f64::consts::PI/6.0,"armourMm":65.0,"surface":"front"});
    input["construction"]["nodes"][2]["y"]=json!(c(FLOOR+1.2));input["construction"]["nodes"][3]["y"]=json!(c(FLOOR+1.2));
    input["construction"]["components"][0]["weaponPreset"]=json!("rh120");
    input["construction"]["components"][0]["pose"]=pose(-2.6,FLOOR+0.6,PI);
    input["construction"]["components"][0]["mount"]=json!({"preset":"heavy-trunnion","radiusM":0.26,
        "sector":{"min":-0.2,"max":0.2}});input
}

#[test]
fn external_cannon_elevation_clears_a_low_roof_and_a_tower_in_an_empty_envelope_corner() {
    let mut input=cannon_request();stand_tower(&mut input,-1.45,0.8,0.8);
    let (first,result)=compiled(&input);
    let gun=&result["compiled"]["modules"][0];let at=|v:&Value,key:&str|v[key].as_f64().unwrap();
    assert_eq!(gun["weaponMount"]["min"],-0.2);assert_eq!(gun["weaponMount"]["max"],0.2);
    assert!(at(&gun["weaponMount"]["walls"][0]["port"],"lo")<at(&gun["weaponMount"]["walls"][0]["port"],"hi"));
    // One box around the whole weapon would reach the tower: the raised muzzle
    // is above its floor and the recoil reserve ends behind its front wall.
    let foot=&result["compiled"]["rooms"][1]["polygon"][0];
    assert!(at(gun,"y")+4.25*0.2_f64.sin()>at(foot,"y") && at(gun,"x")+1.35+0.30>at(foot,"x"));
    input["construction"]=result["construction"].clone();assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
}

#[test]
fn a_real_descending_tower_barrel_cannot_cross_the_deck_in_front_of_it() {
    // Give the rotating breech enough room inside, so the rejection measures the
    // external tube crossing the deck, too nearly along it for a port to fit there,
    // rather than an earlier collision with the roof.
    let mut input=cannon_request();stand_tower(&mut input,0.5,2.0,2.2);
    input["construction"]["components"][0]["pose"]=pose(-0.5+0.3,FLOOR+1.2+1.1,PI);
    input["construction"]["components"][0]["mount"]=json!({"preset":"heavy-trunnion","radiusM":0.26,
        "sector":{"min":-0.2,"max":0.5}});
    let error=refused(&input);
    assert_eq!((&error["code"],&error["ids"]),(&json!("MOUNT_PORT"),&json!(["hull:deck","gun"])),"{error}");
    input["construction"]["components"][0]["mount"]["sector"]["max"]=json!(0.1);
    compiled(&input);
}

#[test]
fn fixed_equipment_can_occupy_empty_space_above_a_low_cannon_receiver() {
    let mut input=cannon_request();
    input["construction"]["nodes"][2]["y"]=json!(c(FLOOR+2.2));input["construction"]["nodes"][3]["y"]=json!(c(FLOOR+2.2));
    input["construction"]["components"][0]["pose"]["y"]=json!(c(FLOOR+0.7));
    input["construction"]["components"].as_array_mut().unwrap().push(json!({"id":"command","kind":"command",
        "pose":pose(-2.25,FLOOR+1.8,0.0)}));
    compiled(&input);
    input["construction"]["components"][1]["pose"]["y"]=json!(c(FLOOR+0.6));
    let error=refused(&input);
    assert!(({let refusal=&(error);refusal["code"]=="BREECH_COMPONENT" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("gun"))) && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("command")))}),"{error}");
}

#[test]
fn a_tower_floor_is_one_real_plate_of_both_rooms_and_dividing_it_adds_a_plate_but_no_metal() {
    let mut input=compact_tower(2.0,0.7);let (first,result)=compiled(&input);
    let plates=result["compiled"]["plates"].as_array().unwrap();assert_eq!(plates.len(),11);
    let rooms=result["compiled"]["rooms"].as_array().unwrap();assert_eq!(rooms.len(),2);
    let floor=plates.iter().find(|p|p["id"]=="tower:floor").unwrap();
    for room in rooms {
        let sides:Vec<_>=room["walls"].as_array().unwrap().iter().filter(|w|w["id"]=="tower:floor").collect();
        assert_eq!(sides.len(),1);assert_eq!(sides[0]["owner"],floor["owner"]);assert_eq!(sides[0]["exterior"],false);
    }
    // The port refers to its real host; the mount no longer saves a copy of
    // every wall of the room as an installation permission.
    let walls=result["compiled"]["modules"][0]["weaponMount"]["walls"].as_array().unwrap();assert_eq!(walls.len(),1);
    assert!(walls.iter().all(|wall|plates.iter().any(|p|p["owner"]==wall["owner"] && p["id"]==wall["wallId"])));
    input["construction"]=result["construction"].clone();assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
    // A node under the tower divides that floor: one more plate, the same metal.
    divide(&mut input,3,node("tower-mid",0.25,ROOF),[plate("tower:floor","tower-1","tower-mid"),plate("tower:floor-front","tower-mid","tower-0")]);
    let split=compiled(&input).1;let mass=|v:&Value|v["compiled"]["fixedAssembly"]["mass"].as_f64().unwrap();
    assert_eq!(split["compiled"]["plates"].as_array().unwrap().len(),12);
    assert!((mass(&split)-mass(&result)).abs()<1e-9*mass(&result));
    let physical_mount=|result:&Value|{
        let plates=result["compiled"]["plates"].as_array().unwrap();
        let mut mount=result["compiled"]["modules"][0]["weaponMount"].clone();
        let host=plates.iter().find(|plate|plate["owner"]==mount["hostOwner"]).unwrap();
        assert_eq!(host["id"],mount["hostId"]);
        mount["hostOwner"]=host["id"].clone();
        for wall in mount["walls"].as_array_mut().unwrap() {
            let plate=plates.iter().find(|plate|plate["owner"]==wall["owner"]).unwrap();
            assert_eq!(plate["id"],wall["wallId"]);
            wall["owner"]=plate["id"].clone();
        }
        mount
    };
    assert_eq!(physical_mount(&split),physical_mount(&result));
}

#[test]
fn a_collinear_split_keeps_independent_authoring_but_crossing_or_overlapping_metal_is_refused() {
    let mut input=request();
    divide(&mut input,0,node("keel",0.0,FLOOR),[plate("hull:floor","hull-0","keel"),plate("hull:keel","keel","hull-1")]);
    let (first,result)=compiled(&input);
    assert_eq!(result["construction"]["version"],CONSTRUCTION_VERSION);assert_eq!(result["compiled"]["vehicle"]["chassisId"],"chassis:frame-0");
    input["construction"]=result["construction"].clone();assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
    // Pulled past the rear corner, the first stretch of floor lies over that corner instead of ending on it.
    let mut overrun=input.clone();overrun["construction"]["nodes"][4]["x"]=json!(c(3.0));
    assert!(({let refusal=&(refused(&overrun));refusal["code"]=="PLATE_OVERLAP" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("hull:floor")))}));
    // Independent crossing stock inside the room isolates identity preservation from acute corner joints.
    input["construction"]["nodes"].as_array_mut().unwrap().extend([
        node("brace-a0",-2.8,FLOOR+0.1),node("brace-a1",2.8,ROOF-0.1),
        node("brace-b0",2.8,FLOOR+0.1),node("brace-b1",-2.8,ROOF-0.1)]);
    input["construction"]["plates"].as_array_mut().unwrap().extend([
        plate("brace-a","brace-a0","brace-a1"),plate("brace-b","brace-b0","brace-b1")]);
    let crossing=refused(&input);
    assert_eq!(crossing["code"],"PLATE_CROSSING");
    assert!(["brace-a","brace-b"].iter().all(|id|crossing["ids"].as_array().unwrap().contains(&json!(id))));
}

#[test]
fn sixty_four_nodes_and_plates_compile_and_a_sixty_fifth_of_either_is_rejected() {
    // Sixty joints along the floor of a hull 6.1 m long: 61 stretches of 10 cm, each a plate of its own.
    let mut input=request();let joint=|i:usize|match i {0=>"hull-0".to_owned(),61=>"hull-1".to_owned(),_=>format!("floor-{i}")};
    for (i,x) in [(0,-61),(1,61),(2,61),(3,-61)] {input["construction"]["nodes"][i]["x"]=json!(x);}
    input["construction"]["chassis"]["points"]=json!([{"x":-61,"y":0},{"x":61,"y":0}]);
    input["construction"]["nodes"].as_array_mut().unwrap().extend((1..61).map(|i|node(&joint(i),-3.05+0.1*i as f64,FLOOR)));
    input["construction"]["plates"].as_array_mut().unwrap().splice(0..1,(0..61).map(|i|plate(&format!("hull:floor-{i}"),&joint(i),&joint(i+1))));
    let result=compiled(&input).1;let count=|v:&Value|v.as_array().unwrap().len();
    // The two plates of the chassis come beside those written, and are not counted against them.
    assert_eq!((count(&result["compiled"]["frame"]["nodes"]),count(&result["compiled"]["frame"]["plates"]),count(&result["compiled"]["plates"])),(64,64,66));
    let mut crowded=input.clone();crowded["construction"]["nodes"].as_array_mut().unwrap().push(node("extra",0.0,1.0));
    assert!((refused(&crowded)["code"]=="AUTHORING_LIMIT"));
    input["construction"]["plates"].as_array_mut().unwrap().push(plate("brace","hull-0","hull-2"));
    assert!((refused(&input)["code"]=="AUTHORING_LIMIT"));
}

#[test]
fn a_sensor_keeps_its_pose_across_roof_edits_and_rejects_only_actual_metal_overlap() {
    let mut input=request();
    input["construction"]["components"]=json!([{"id":"camera","kind":"sensor","sensorMode":"visual",
        "pose":pose(0.0,ROOF+0.15,0.0)}]);
    divide(&mut input,2,node("ridge",0.0,ROOF),[plate("hull:roof","hull-2","ridge"),plate("hull:deck","ridge","hull-3")]);
    let (first,result)=compiled(&input);
    let camera=&result["compiled"]["modules"][0];assert_eq!(camera["x"],12.0);
    input["construction"]=result["construction"].clone();assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
    let mut corner=input.clone();corner["construction"]["nodes"][4]["y"]=json!(c(ROOF+0.1));
    assert!(({let refusal=&(refused(&corner));refusal["code"]=="COMPONENT_PLATE" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("camera")))}));
    corner["construction"]["components"][0]["pose"]["y"]=json!(c(ROOF+0.25));
    compiled(&corner);
    input["construction"]["plates"][3]["thicknessMm"]=json!(30);
    let thicker=compiled(&input).1;
    assert_eq!(thicker["construction"]["components"],result["construction"]["components"]);
    assert_eq!(thicker["compiled"]["modules"][0]["y"],camera["y"]);
}

#[test]
fn a_compact_tower_rejects_a_real_component_inside_the_breech_sweep() {
    let mut input=compact_tower(2.0,0.7);
    let command=json!({"id":"command","kind":"command","pose":pose(-0.55,ROOF+0.25,0.0)});
    // Admit the independent real component first, so rejection is occupancy,
    // not an unrelated wall, grid, size or surface failure.
    let mut command_only=input.clone();command_only["construction"]["components"]=json!([command.clone()]);
    assert_eq!(compiled(&command_only).1["compiled"]["modules"][0]["x"],12.0-0.55);
    input["construction"]["components"].as_array_mut().unwrap().push(command);
    assert!(({let refusal=&(refused(&input));refusal["code"]=="BREECH_COMPONENT" && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("gun"))) && refusal["ids"].as_array().is_some_and(|ids|ids.contains(&json!("command")))}));
    input["construction"]["components"][1]["pose"]["x"]=json!(c(0.25));
    compiled(&input);
}

#[test]
fn actual_public_catalogue_accepts_the_minimal_mount_without_host_geometry() {
    let mut input=request();let minimi=&input["catalogue"]["weapons"]["minimi"];
    assert!(minimi.get("width").is_none() && minimi.get("height").is_none());
    let (first,result)=compiled(&input);
    assert_eq!(result["compiled"]["modules"][0]["width"],0.39);assert_eq!(result["compiled"]["modules"][0]["height"],0.15);
    assert_eq!(result["contract"]["mechanicalAdmission"],true);
    input["construction"]=result["construction"].clone();assert_eq!(compile_construction(&input.to_string()).unwrap(),first);
    // The receiver is the weapon's own, as the catalogue states it: none, and there is no gun.
    input["catalogue"]["weapons"]["minimi"].as_object_mut().unwrap().remove("receiver");
    assert!((refused(&input)["code"]=="WEAPON_RECEIVER"));
}

#[test]
fn cold_contract_and_repeated_compilation_are_exact_without_world_admission() {
    let expected=json!({"compilerVersion":CONSTRUCTION_VERSION,"constructionVersion":CONSTRUCTION_VERSION,"pure":true,
        "mechanicalAdmission":true,"drafts":true,"physicalSupport":true,"authoring":"grid-node-plate-v10","projection":"read-only-derived-v1"});
    let mut input=request();let (first,result)=compiled(&input);
    assert_eq!(result["contract"],expected);assert_eq!(result["compiled"]["canonicalVersion"],CONSTRUCTION_VERSION);
    input["construction"]=result["construction"].clone();
    for _ in 0..8 {assert_eq!(compile_construction(&input.to_string()).unwrap(),first);}
    let cost=||construction_cost(&json!({"version":1,"compiled":result["compiled"],"catalogue":input["catalogue"]}).to_string()).unwrap();
    let price:Value=serde_json::from_str(&cost()).unwrap();
    assert!(price["total"].as_f64().unwrap()>0.0);
    assert_eq!(cost(),cost());
}

#[test]
fn free_authored_equipment_still_cannot_be_manufactured_above_the_real_chassis_capacity() {
    let mut input=request();
    input["construction"]["chassis"]["axles"]=json!([c(-1.9),c(1.9)]);
    input["construction"]["components"]=json!([
        {"id":"engine-a","kind":"engine","sizeScale":2.5,"pose":pose(-1.4,1.0,0.0)},
        {"id":"engine-b","kind":"engine","sizeScale":2.5,"pose":pose(1.4,1.0,0.0)},
        // Exposed pairs above the roof remain valid free authoring, with real
        // steel mass, but take this two-axle chassis over its capacity: three
        // of them, as an engine grown longer and taller is no deeper, and
        // weighs the square of its size rather than its cube.
        {"id":"engine-c","kind":"engine","sizeScale":2.5,"pose":pose(-1.4,3.0,0.0)},
        {"id":"engine-d","kind":"engine","sizeScale":2.5,"pose":pose(1.4,3.0,0.0)},
        {"id":"engine-e","kind":"engine","sizeScale":2.5,"pose":pose(-1.4,5.0,0.0)},
        {"id":"engine-f","kind":"engine","sizeScale":2.5,"pose":pose(1.4,5.0,0.0)},
        {"id":"engine-g","kind":"engine","sizeScale":2.5,"pose":pose(-1.4,7.0,0.0)},
        {"id":"engine-h","kind":"engine","sizeScale":2.5,"pose":pose(1.4,7.0,0.0)}]);
    input["draft"]=json!(true);
    let result=compiled(&input).1;
    assert_eq!(result["compiled"]["mechanicalAdmission"],false);
    assert!(result["compiled"]["admissionIssues"].as_array().unwrap().iter().any(|issue|issue["code"]=="CHASSIS_OVERLOAD"));
    let chassis=&result["compiled"]["chassis"];
    assert!(chassis["loadedKg"].as_f64().unwrap()>chassis["limitKg"].as_f64().unwrap(),"{chassis}");
    input["draft"]=json!(false);
    assert_eq!(refused(&input)["code"],"CHASSIS_OVERLOAD");
}

#[test]
fn unsupported_compiler_request_and_derived_authoring_are_rejected() {
    let mut input=request();input["version"]=json!(2);
    assert!((refused(&input)["code"]=="REQUEST_VERSION"));
    let mut input=request();input["world"]=json!({});
    assert_eq!(refused(&input)["code"],"AUTHORING_FIELDS");
    assert!(compile_construction("{").is_err());
    for version in [4,5,6,7] {
        let mut input=request();input["construction"]["version"]=json!(version);
        assert_eq!(refused(&input)["code"],"CONSTRUCTION_VERSION");
    }
    let result=compiled(&request()).1;
    let mut input=request();input["construction"]=result["compiled"].clone();
    assert_eq!(refused(&input)["code"],"AUTHORING_FIELDS");
    // Nothing the compiler derives can be written back beside the authoring.
    let mut input=request();input["construction"]["rooms"]=result["compiled"]["rooms"].clone();
    assert!((refused(&input)["code"]=="AUTHORING_FIELDS"));
    let mut input=request();input["construction"]["plates"][0]["mountId"]=json!("hull:rear");
    assert!((refused(&input)["code"]=="AUTHORING_FIELDS"));
}

#[test]
fn an_edited_compiler_cannot_be_mistaken_for_the_old_mechanical_runtime() {
    let result=compiled(&request()).1;
    let mut world=NativeWorld::new(&[],0.0,-9.81).unwrap();
    let error=world.load_game(&result["compiled"].to_string()).unwrap_err();
    assert!(error.contains("is not an admitted scene"));
    assert!(world.load_game(&result["construction"].to_string()).unwrap_err().contains("is not an admitted scene"));
    assert!(world.current_frame().is_err());
    // Removing the top-level marker must not turn an ignored mount into a gun.
    let scene=json!({"terrain":{"points":[[-10,0],[10,0]]},"modules":result["compiled"]["modules"]});
    assert!(world.load_game(&scene.to_string()).unwrap_err().contains("is not an admitted scene"));
}
