//! Installed construction prices.
use crate::game_geometry::ComponentKind;
use serde_json::{Value,json};

fn number(v:&Value,k:&str,d:f64)->f64 {v[k].as_f64().unwrap_or(d)}
fn credits(n:f64)->f64 {(n-1e-9).ceil().max(0.0)}
/// What a piece costs of `metal` whose steel price is `base`, when `share` of that is of its material and `steel` more is
/// of steel whatever it is made of: the whole, to the credit begun, and of it what is kept as on a steel piece — the rest
/// of it and that steel —, paid from Ferro (`kept`). A steel piece costs what it did.
fn made(base:f64,share:f64,metal:&crate::game_geometry::Metal,steel:f64)->(f64,f64) {
    let whole=credits(if metal.name=="steel" {base+steel} else {base*(1.0-share)+base*share*metal.price+steel});
    let kept=credits(base*(1.0-share)+steel).min(whole);
    (whole-kept,kept)
}
/// The groups a price is told in. `supplies` is what a piece holds, its rounds or its fuel; `kept`, what of a piece its
/// material does not change: the equipment in the housing of a sensor or a command post, the rubber and the steel armour
/// of running gear, the steel column a piece stands on or hangs from. Both are paid as on a steel piece.
const GROUPS:[&str;9]=["command","chassis","armour","engines","weapons","runningGear","storage","supplies","kept"];
fn groups()->Value {Value::Object(GROUPS.iter().map(|k|(k.to_string(),json!(0))).collect())}
pub(crate) fn piece(piece:&Value,catalogue:&Value)->Result<Value,String> {
    let mut groups=groups();
    // The chassis is paid once, as its model and length make it, on its frame: its other plates are in that price.
    if piece["chassis"].is_object() {
        groups["chassis"]=json!(credits(piece["chassis"]["credits"].as_f64().unwrap_or(0.0)));return Ok(groups)
    }
    if let Some(material)=piece["material"].as_str() {
        let (density,rate)=crate::game_damage::Material::named(material).map(|m|(m.density,m.price)).ok_or("Invalid price material")?;
        let mass=piece["physicalMass"].as_f64().unwrap_or_else(||number(piece,"length",0.0)*number(piece,"thicknessMm",0.0)/1000.0*number(piece,"widthM",1.0)*density);
        groups["armour"]=json!(credits(mass*rate));return Ok(groups)
    }
    let kind=ComponentKind::from_name(piece["kind"].as_str().ok_or("Missing priced component")?)?;
    let (w,h,d)=kind.dimensions();
    let width=number(piece,"width",w);let height=number(piece,"height",h*width/w);
    let scale=kind.scale(width,height);
    let volume=(w*scale)*(h*scale)*crate::game_geometry::installed_depth(kind,d,scale);
    // A piece of another metal than steel, of glass fibre or of plastic, is paid as that is: its armour, its fuel and its rounds as
    // they are, and of a sensor or a command post only the housing (`housing`).
    let made_of=crate::game_geometry::metal(kind,piece)?;let metal=made_of.price;
    match kind {
        ComponentKind::Command|ComponentKind::Sensor=>{
            let mode=piece["sensorMode"].as_str().unwrap_or("visual");
            let cost=if kind==ComponentKind::Command {800.0} else {catalogue["sensors"][mode]["cost"].as_f64().ok_or("Invalid installed price catalogue")?};
            let (housing,kept)=made(cost,kind.housing(mode).1,made_of,0.0);
            groups["command"]=json!(housing);groups["kept"]=json!(kept);
        },
        ComponentKind::Engine=>groups["engines"]=json!(credits(180.0*volume/(1.05*0.64*0.65)*35.0*metal)),
        // A thruster is paid as the titanium it is (`empty_price`), from Ligas.
        ComponentKind::Excavator|ComponentKind::Drill|ComponentKind::Builder|ComponentKind::Blade|ComponentKind::Paver|ComponentKind::Thruster=>
            groups["engines"]=json!(credits(kind.empty_price(volume)*metal)),
        // A track costs by its length as it weighs by it; the armour of either is paid as the steel it is, and its rubber
        // as on a steel one: its metal is the rest of it, as much of its price as of its weight (`rubberShare`).
        ComponentKind::Wheel|ComponentKind::Track=>{
            let length=if kind==ComponentKind::Track {width/(w*scale)} else {1.0};
            let steel=crate::game_damage::Material::named("steel").ok_or("Invalid price material")?.price;
            let model=if kind==ComponentKind::Wheel {"wheeled"} else {"tracked"};
            let rubber=catalogue["chassis"][model]["structure"]["rubberShare"][model].as_f64().filter(|r|(0.0..=1.0).contains(r))
                .ok_or("Invalid installed price catalogue")?;
            let (gear,kept)=made((if kind==ComponentKind::Wheel{450.0}else{9000.0})*scale.powf(2.5)*length,1.0-rubber,made_of,
                kind.armour_mass(width,height,number(piece,"armorMm",0.0))*steel);
            groups["runningGear"]=json!(gear);groups["kept"]=json!(kept);
        },
        ComponentKind::Weapon=>{
            let preset=piece["weaponPreset"].as_str().ok_or("Missing priced weapon preset")?;
            let spec=catalogue["weapons"].get(preset).filter(|v|v.is_object()).ok_or("Unknown priced weapon")?;
            let mount=&piece["weaponMount"];
            let mut cost=number(spec,"costCredits",0.0);
            if mount.is_object() {
                let preset=&catalogue["mounts"][mount["preset"].as_str().unwrap_or("")];
                // A mount grown to a gun heavier than it is rated for costs as much more (game_mounts.rs `rated`).
                let (rated,installed)=crate::game_mounts::rated(preset,spec)?;
                cost+=number(preset,"cost",0.0)*(installed/rated).max(1.0);
                let material=crate::game_damage::Material::named(mount["material"].as_str().ok_or("Missing mounting price material")?).ok_or("Invalid mounting price material")?;
                // The post, or the same actual curved armour used by queries and mass.
                let area: f64=if preset["exposed"]==true {
                    let post=piece["materialPolygons"][0].as_array().ok_or("Missing mounting price geometry")?.iter().map(crate::game_geometry::Point::from_value).collect::<Vec<_>>();
                    crate::game_geometry::signed_area(&post).abs()
                } else {
                    crate::game_mounts::Shield::from_value(&mount["shield"])?.polygons(&[]).iter()
                        .map(|p|crate::game_geometry::signed_area(p).abs()).sum()
                };
                cost+=(area*number(mount,"materialDepth",0.0)*material.density*material.price).ceil();
            }
            groups["weapons"]=json!(cost);
        },
        // A hopper, a cistern and a supply piece cost by their volume, and come empty.
        ComponentKind::Hopper|ComponentKind::Cistern|ComponentKind::Supply=>groups["storage"]=json!(credits(kind.empty_price(volume)*metal)),
        ComponentKind::Fuel|ComponentKind::Ammo=>{
            groups["storage"]=json!(credits(volume*1000.0*(if kind==ComponentKind::Fuel{6.0}else{8.0})*metal));
            // It is paid for full, as it is built.
            let supply=if kind==ComponentKind::Fuel{volume*0.78*1000.0*0.8}else{
                let preset=piece["ammoPreset"].as_str().ok_or("Missing priced ammunition preset")?;
                let weapon=catalogue["weapons"].get(preset).filter(|v|v.is_object()).ok_or("Unknown priced ammunition")?;
                // A box is paid for the rounds it carries: those its calibre's guns are fed.
                let cartridge=&crate::game_weapons::cartridge(weapon,piece["ammoType"].as_str().unwrap_or(""));
                let litres=number(cartridge,"litres",0.0);if litres<=0.0{return Err("Missing cartridge price".into())}
                crate::game_geometry::ammunition_capacity(volume,litres)*number(cartridge,"costCredits",0.0)
            };
            groups["supplies"]=json!(credits(supply));
        }
    }
    // The steel column a sensor stands on or a blade hangs from is paid with its piece, as the steel it is.
    if let Some(mass)=piece["support"]["mass"].as_f64() {
        let steel=crate::game_damage::Material::named("steel").ok_or("Invalid price material")?.price;
        groups["kept"]=json!(groups["kept"].as_f64().unwrap_or(0.0)+credits(mass*steel));
    }
    if groups.as_object().unwrap().values().any(|v|!v.as_f64().is_some_and(f64::is_finite)){return Err("Invalid installed price catalogue".into())}
    Ok(groups)
}
pub(crate) fn construction(compiled:&Value,catalogue:&Value)->Result<Value,String> {
    let mut groups=groups();
    for p in crate::array(compiled,"plates").iter().chain(crate::array(compiled,"modules")) {
        for (key,value) in piece(p,catalogue)?.as_object().unwrap() {groups[key]=json!(groups[key].as_f64().unwrap()+value.as_f64().unwrap());}
    }
    let total:f64=groups.as_object().unwrap().values().map(|v|v.as_f64().unwrap()).sum();
    groups["total"]=json!(total);Ok(groups)
}
pub(crate) fn request(r:&Value)->Result<Value,String> {
    if r["version"]!=1{return Err("Invalid cost request".into())}
    if r["piece"].is_object(){piece(&r["piece"],&r["catalogue"])}else{construction(&r["compiled"],&r["catalogue"])}
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn equipment_prices_require_explicit_known_weapon_and_ammunition_presets() {
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        for (kind,key) in [("weapon","weaponPreset"),("ammo","ammoPreset")] {
            let mut part=json!({"kind":kind});
            assert!(piece(&part,catalogue).is_err());
            part[key]=json!("unknown");assert!(piece(&part,catalogue).is_err());
            part[key]=json!("rh120");assert!(piece(&part,catalogue).is_ok());
        }
        // Pricing an already compiled mount needs only its price catalogue, not another physical admission.
        for (preset,mount_id) in [("rh120","heavy-trunnion"),("m2hb","pintle")] {
            let part=crate::game_damage::fixtures::module(1,0,&json!({"kind":"weapon","weaponPreset":preset,"weaponMount":{"preset":mount_id}})).to_value();
            let(spec,mount)=(&catalogue["weapons"][preset],&catalogue["mounts"][mount_id]);
            let mut prices=json!({"weapons":{},"mounts":{}});
            prices["weapons"][preset]=json!({"costCredits":spec["costCredits"],"cartridge":spec["cartridge"],"rounds":spec["rounds"],"installedMassKg":spec["installedMassKg"]});
            prices["mounts"][mount_id]=json!({"cost":mount["cost"],"exposed":mount["exposed"],"ratedMass":mount["ratedMass"]});
            assert_eq!(piece(&part,&prices).unwrap(),piece(&part,catalogue).unwrap(),"{preset}");
            if !part["weaponMount"]["exposed"].as_bool().unwrap() {
                let mut invalid=part.clone();invalid["weaponMount"]["shield"]["opening"]=part["weaponMount"]["shield"]["radius"].clone();
                assert!(piece(&invalid,&prices).is_err(),"pricing still validates the actual shield dimensions");
            }
        }
    }
    #[test]
    fn a_hopper_and_a_cistern_cost_by_their_volume_and_come_without_supplies() {
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        for (kind,width,price) in [("hopper",1.6,900.0),("cistern",1.4,1100.0)] {
            for scale in [1.0,1.5,2.0] {
                let groups=piece(&json!({"kind":kind,"width":width*scale,"height":0.9*scale}),catalogue).unwrap();
                // Its size makes it longer and taller, not deeper: it holds, and costs, the square of it.
                assert_eq!(groups["storage"].as_f64(),Some(credits(price*scale*scale)),"{kind} at {scale}");
                assert_eq!(groups["supplies"],0);
            }
        }
    }
    #[test]
    fn a_box_is_paid_for_the_rounds_its_calibres_guns_are_fed() {
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        let gun=&catalogue["weapons"]["rh120"];
        let supplies=|ammo:Option<&str>|{
            let mut part=json!({"kind":"ammo","ammoPreset":"rh120"});
            if let Some(ammo)=ammo {part["ammoType"]=json!(ammo);}
            piece(&part,catalogue).unwrap()["supplies"].as_f64().unwrap()
        };
        // The rounds are as many whatever they are; each is paid at its own price.
        let rounds=supplies(Some("apfsds"))/gun["cartridge"]["costCredits"].as_f64().unwrap();
        assert!(rounds>=1.0 && rounds.fract()==0.0,"{rounds} rounds");
        for ammo in ["heat","he"] {
            assert_eq!(supplies(Some(ammo)),rounds*gun["rounds"][ammo]["cartridge"]["costCredits"].as_f64().unwrap(),"{ammo}");
        }
        assert!(supplies(Some("he"))<supplies(Some("heat")) && supplies(Some("heat"))<supplies(Some("apfsds")));
        // A box that states no rounds is paid for the first its calibre takes.
        assert_eq!(supplies(None),supplies(Some("apfsds")));
    }
    #[test]
    fn a_piece_of_another_metal_of_glass_fibre_or_of_plastic_is_paid_its_share_of_the_steel_one_and_what_it_holds_as_it_is(){
        let catalogue=crate::game_damage::fixtures::full_catalogue();
        let rubber=|model:&str|catalogue["chassis"][model]["structure"]["rubberShare"][model].as_f64().unwrap();
        let total=|groups:&Value|GROUPS.iter().map(|k|groups[*k].as_f64().unwrap()).sum::<f64>();
        // Of each, the share of its price that is of its material: the housing of a sensor or a command post, the metal of
        // running gear, and the whole of anything else.
        for (kind,group,extra,share) in [("command","command",json!({}),0.1),("sensor","command",json!({"sensorMode":"radar"}),0.05),
            ("sensor","command",json!({"sensorMode":"visual"}),0.1),("sensor","command",json!({"sensorMode":"sound"}),0.1),
            ("wheel","runningGear",json!({}),1.0-rubber("wheeled")),("track","runningGear",json!({}),1.0-rubber("tracked")),
            ("wheel","runningGear",json!({"armorMm":12}),1.0-rubber("wheeled")),
            ("fuel","storage",json!({}),1.0),("ammo","storage",json!({"ammoPreset":"rh120"}),1.0),("supply","storage",json!({}),1.0),
            ("cistern","storage",json!({}),1.0),("blade","engines",json!({}),1.0),("paver","engines",json!({}),1.0)] {
            let k=ComponentKind::from_name(kind).unwrap();
            let priced=|metal:&str|{
                let mut part=extra.clone();part["kind"]=json!(kind);
                if metal!="steel" {part["metal"]=json!(metal);}
                piece(&part,catalogue)
            };
            let steel=priced("steel").unwrap();
            let base=total(&steel)-steel["supplies"].as_f64().unwrap();
            if share==1.0 {assert_eq!(steel["kept"],0.0,"{kind}: all of it is of its material");}
            else {assert!(steel["kept"].as_f64().unwrap()>0.0 && steel[group].as_f64().unwrap()>0.0,"{kind}: {steel}");}
            for metal in crate::game_geometry::METALS.iter() {
                let result=priced(metal.name);
                if !k.metals(extra["sensorMode"].as_str().unwrap_or("visual")).contains(&metal.name) {assert!(result.is_err(),"{kind} of {}",metal.name);continue;}
                let groups=result.unwrap();
                // What is kept is as on the steel one, and so is what it holds; the rest of it is of its material, its share
                // of the steel price at the price of that, to the credit begun.
                assert_eq!(groups["kept"],steel["kept"],"{kind} of {}: what its material does not change",metal.name);
                assert_eq!(groups["supplies"],steel["supplies"],"{kind}: what it holds is paid as it is");
                let (paid,was)=(groups[group].as_f64().unwrap(),steel[group].as_f64().unwrap());
                assert!((paid-was*metal.price).abs()<=metal.price+1.0+1e-9,"{kind} of {}: {paid} for {was}",metal.name);
                // That share is what its material is of the steel price, the rest of it being kept; armour is all kept.
                if extra.get("armorMm").is_none() {assert!((was-base*share).abs()<=1.0,"{kind}: {was} of {base}");}
            }
        }
        // A command post and a sensor of steel cost what they did, and of that the equipment is most.
        let post=piece(&json!({"kind":"command"}),catalogue).unwrap();
        assert_eq!((total(&post),post["command"].as_f64().unwrap(),post["kept"].as_f64().unwrap()),(800.0,80.0,720.0));
        let radar=piece(&json!({"kind":"sensor","sensorMode":"radar"}),catalogue).unwrap();
        assert_eq!(total(&radar),catalogue["sensors"]["radar"]["cost"].as_f64().unwrap());
        // Glass fibre makes the housing of a radar a tenth dearer, in Sílica; titanium triples that of a command post alone.
        let fibre=piece(&json!({"kind":"sensor","sensorMode":"radar","metal":"fiberglass"}),catalogue).unwrap();
        assert_eq!((fibre["command"].as_f64().unwrap(),fibre["kept"].as_f64().unwrap()),(660.0,11400.0));
        let titanium=piece(&json!({"kind":"command","metal":"titanium"}),catalogue).unwrap();
        assert_eq!((titanium["command"].as_f64().unwrap(),titanium["kept"].as_f64().unwrap()),(240.0,720.0));
        // Plastic makes the case of a camera two-fifths as dear, and the equipment in it is what it was; a radar and a
        // command post are not made of it.
        let camera=piece(&json!({"kind":"sensor","sensorMode":"visual","metal":"plastic"}),catalogue).unwrap();
        let cost=catalogue["sensors"]["visual"]["cost"].as_f64().unwrap();
        assert_eq!((camera["command"].as_f64().unwrap(),camera["kept"].as_f64().unwrap()),(cost*0.1*0.4,cost*0.9));
        for part in [json!({"kind":"sensor","sensorMode":"radar","metal":"plastic"}),json!({"kind":"command","metal":"plastic"})] {
            assert!(piece(&part,catalogue).is_err(),"{part}");
        }
    }
}
