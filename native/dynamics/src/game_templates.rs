//! Authored designs, the same for every host: the chassis of a vehicle, nodes,
//! the plates between them and the equipment. No placement repair or mechanical
//! DTO is generated here; the construction compiler admits the proposed frame,
//! equipment, sector and quantized armour passage, and brings the running gear.
use crate::game_construction::{CELL, CLEARANCE, CONSTRUCTION_VERSION, Stroke, cell, metres, clear_sector, elevation, factory_deck, mount_on_plate, part_on_plate, receiver_dimensions, seed_plate_ends, sensor_dimensions};
use crate::game_geometry::{BarrelProfile, Bounds, ComponentKind, MAX_ROAD_WHEELS, atan2, cos, sin};
use crate::game_damage::Material;
use crate::game_mounts::{Base, Shield};
use std::f64::consts::PI;
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};

#[derive(Clone, Copy)]
struct Design {
    length:f64, height:f64, power:f64, armour:[f64;5],
    paint:&'static str, model:&'static str,
    /// The uniform wheel diameter or track height, and the wheel count/overhangs where it has axles.
    gear:f64, axles:Option<(usize,f64,f64)>,
    /// A design that is a cab at the front of its chassis, this long, with the bed behind it free; the others are one
    /// hull as long as the chassis.
    cab:Option<f64>,
    /// How far behind the front of the hull its roof begins, and how high its front plate stands, from where the
    /// glacis leans back to the roof.
    nose:(f64,f64),
    /// How far behind the front of the hull the front foot of its tower stands; the tower stands in the middle of
    /// the roof where the design does not say.
    tower:Option<f64>,
    /// The front deck may slope below the engine roof. A ring recessed into the hull shares its usable volume;
    /// neither dimension changes the catalogued weapon or its base.
    front_roof:f64, ring:f64,
    /// Initial body height relative to the model's sizing deck; running gear still starts on the floor.
    deck_offset:f64,
    /// Whether the roof behind a tower sunk into its ring stays level at the height of the hull, over an engine as tall
    /// as the hull leaves, the rear foot of that tower standing on it, instead of sloping down to a foot sunk as its front.
    level_deck:bool,
}
fn design(id:&str)->Option<Design> {
    let (length,height,power,armour,paint,model,cab)=match id {
        // The Leopard 2A4/L44 inspires the hull and gun overhang, not a replica of its mass or power. Its trunnion
        // stands 2.3 m behind the front of this hull [D], the front of its tower 2.0 m behind it. Its hull is 1.25 m
        // tall, as its 600 kW engine, 1.17 m tall on its floor, asks, and level behind its tower (`level_deck`).
        "heavy"=>(7.0,1.25,600.0,[32.0,40.0,25.0,125.0,85.0],"#68765a","tracked",None),
        "ifv"=>(6.4,1.35,240.0,[20.0,25.0,18.0,55.0,35.0],"#6d7863","tracked",None),
        "scout"=>(4.8,1.35,115.0,[10.0,12.0,10.0,20.0,15.0],"#9b8e68","wheeled",None),
        "recon"=>(5.2,1.45,115.0,[12.0,15.0,10.0,25.0,18.0],"#76806b","wheeled",None),
        "mortar"=>(5.8,1.35,180.0,[15.0,18.0,12.0,25.0,20.0],"#748269","wheeled",None),
        // The howitzer is drawn after the M109A7 Paladin, 38 t in combat [S]: a hull 6.19 m long [S] with its roof
        // 1.65 m over the ground [D, from a side drawing], here raised slightly to hold the engine, over a track that runs
        // from its nose nearly to its tail, as the Paladin's does; the glacis rising 1.1 m behind the nose from 0.4 m
        // over the deck; the tower from 2.0 m behind the front of the hull to its rear [D].
        "howitzer"=>(6.2,0.85,240.0,[15.0,10.0,10.0,30.0,20.0],"#8c8463","tracked",None),
        // The bare chassis: a cab with the engine, the fuel and the command post, and the bed behind it free.
        "chassis"=>(6.6,1.85,240.0,[6.0;5],"#7b8065","wheeled",Some(3.3)),
        // The tracked base and the miner have the owner's truck cab, as tall as the road trucks'.
        "tracked"=>(6.4,1.85,240.0,[8.0;5],"#777c63","tracked",Some(3.0)),
        // A miner carries its full 1.38 m³ hopper on a 0.7 m track. A light 5 mm cab, an ordinary 180 kW engine and a
        // 12 mm frame keep the fully loaded carrier able to restart on the field's steep hills.
        "mining-truck"=>(6.2,1.85,180.0,[5.0;5],"#aa914f","tracked",Some(2.8)),
        // The constructor leaves its base with its supply piece full, up to 10 t of iron, and goes by itself to works on
        // slopes of up to 30 degrees: it climbs them full as tracked vehicles climb 60 %, on the 12 mm frame of the
        // miner and an engine of 400 kW, some 16 kW a tonne full, as a tracked engineer vehicle such as the Terrier
        // has (520 kW for 32 t). That engine, 1.57 m long, takes a cab a little longer than the others, and its supply
        // piece, 3 m long, and the arm behind it a bed of 4.45 m.
        "construction-truck"=>(7.8,1.65,400.0,[8.0;5],"#a29057","tracked",Some(3.35)),
        // The paver, a road machine on the tracks and frame of the constructor, the paver at the rear end of its bed with
        // the mix of its asphalt in its hopper: an engine of 500 kW, some 16 kW a tonne with that hopper full as the
        // constructor has full, so that it climbs as the constructor does, in a cab a hand longer than the constructor's
        // for that engine, 1.75 m long. The motor grader is drawn as a whole (`grader`).
        "paver"=>(7.4,1.65,500.0,[8.0;5],"#a99b55","tracked",Some(3.55)),
        // One bonnet-and-cab family: a front axle and rear tandem on the 6x6, a longer four-axle frame for the
        // tanker and its drill. The cargo pieces keep their ordinary capacities.
        "truck"=>(7.0,1.85,240.0,[6.0;5],"#9a8759","wheeled",Some(3.3)),
        "tanker"=>(8.0,1.85,240.0,[6.0;5],"#6f7c80","wheeled",Some(3.3)),
        "supply"=>(7.0,1.85,240.0,[6.0;5],"#7a805c","wheeled",Some(3.3)),
        _=>return None,
    };
    let (nose,tower)=match id {
        "heavy"=>((0.65,0.60),Some(2.0)),
        "ifv"=>((1.05,0.65),None),
        "scout"=>((0.95,0.60),None),
        "recon"=>((0.95,0.65),None),
        "mortar"=>((1.15,0.50),None),
        "howitzer"=>((1.1,0.4),Some(2.0)),
        "chassis"|"tracked"|"mining-truck"|"construction-truck"|"paver"|"truck"|"tanker"|"supply"=>((0.65,0.65),None),
        _=>((0.65,0.9),None),
    };
    let (gear,axles)=match id {
        "scout"=>(0.95,Some((2,0.7,0.75))),
        "recon"|"mortar"=>(1.1,Some((3,0.95,1.0))),
        "chassis"|"truck"|"supply"=>(1.25,Some((3,1.0,0.75))),
        "tanker"=>(1.25,Some((4,1.0,0.75))),
        "heavy"=>(1.02,None),
        "ifv"=>(0.98,None),
        "howitzer"=>(0.90,None),
        "tracked"=>(0.88,None),
        "construction-truck"|"paver"=>(0.90,None),
        "mining-truck"=>(0.70,None),
        _=>(0.78,None),
    };
    let (front_roof,ring)=match id {
        "heavy"=>(1.0,0.20),"ifv"=>(1.20,0.05),"scout"=>(1.25,0.05),"recon"=>(1.35,0.05),_=>(height,0.0),
    };
    // The 600 kW engine of the heavy stands 1.17 m tall on its floor, under the 1.25 m of its hull: the deck behind its
    // tower stays level over the whole of that engine, as the engine deck of a tank stands behind its turret, the rear
    // foot of its tower on it, instead of sloping down to a rear foot sunk into its ring as the front one is. Its ring is
    // sunk the 10 cm its hull grew for that engine deeper: its tower, its gun and the deck before it stand where they
    // stood over a hull of 1.15 m.
    Some(Design{length,height,power,armour,paint,model,gear,axles,cab,nose,tower,front_roof,ring,
        deck_offset:if id=="heavy" {-0.15}else{0.0},level_deck:id=="heavy"})
}
/// The tower a weapon of a family stands in: how long and how high, the armour of its rear, roof and front, the
/// travel it is given about the normal of its front, and how far that front leans back from upright.
#[derive(Clone,Copy)]
struct Bay {length:f64,height:f64,armour:[f64;3],min:f64,max:f64,lean:f64}
fn bay(family:&str)->Result<Bay,String> {
    let (length,height,armour,min,max,lean)=match family {
        "machinegun"=>(1.6,0.8,[12.0,10.0,20.0],-0.35,0.35,0.0),
        "grenade"=>(1.9,0.85,[12.0,10.0,20.0],-0.4,0.4,0.0),
        "autocannon"=>(2.1,1.0,[25.0,18.0,45.0],-0.4,0.4,0.0),
        // The Leopard 2 lays its gun from 20 degrees up to 9 down [S].
        "cannon"=>(2.8,1.12,[45.0,25.0,100.0],-20f64.to_radians(),9f64.to_radians(),0.0),
        "rocket"=>(2.1,1.45,[15.0,12.0,25.0],-0.4,0.4,0.0),
        // The tower of the Paladin, 3.9 m long [D]. The face its gun stands in leans back 0.6 rad, so that the whole
        // travel of the mount lays the gun from level to 69 degrees up (the Paladin's own: -3 to +75 [S]); a face
        // more upright would have the shield over the port swing behind the trunnion at the top of that travel. It
        // stands 1.0 m over the roof [D]; here 1.25 m, for that shield to swing through all of that travel inside it.
        "howitzer"=>(3.9,1.25,[12.0,10.0,20.0],-0.6,0.6,0.6),
        _=>return Err("Armamento de modelo desconhecido.".into()),
    };
    Ok(Bay{length,height,armour,min,max,lean})
}
/// A tower on the roof of a hull: where its middle stands along that roof; its outline over the roof from the foot of
/// its front by the foot of its rear to the top of its rear and the top of its front; and the armour of its rear, roof
/// and front. Its rear may jut out over the roof behind the foot it stands on, as a bustle: upright from that foot to
/// the height of `bustle`, level from there back to `bustle`, the foot of its rear face. A tower `open` to the hull
/// under it has no floor: the breech of its gun goes down through its ring when the gun is raised, as a tank's does,
/// instead of meeting the floor.
#[derive(Clone,Copy)]
struct Tower {middle:f64,outline:[(f64,f64);4],armour:[f64;3],bustle:Option<(f64,f64)>,open:bool}
/// The bustle of the Paladin's tower [E, from a side photograph]: how far it juts out behind the foot of its rear and
/// how high over the roof the bottom of that stands, in metres.
const BUSTLE:(f64,f64)=(0.35,0.4);
fn default_mount(family:&str)->Result<&'static str,String> {
    match family {
        "machinegun"|"grenade"|"rocket"=>Ok("light-trunnion"),
        "autocannon"=>Ok("medium-trunnion"),
        "cannon"=>Ok("heavy-trunnion"),
        "howitzer"=>Ok("elevated-trunnion"),
        "mortar"=>Ok("roof-mortar"),
        _=>Err("Armamento de modelo desconhecido.".into()),
    }
}
pub(crate) fn option_number(options:&Value,key:&str,default:f64)->Result<f64,String> {
    match options.get(key) {
        None=>Ok(default),
        Some(v)=>v.as_f64().filter(|n|n.is_finite()).ok_or_else(||format!("Opção numérica inválida: {key}.")),
    }
}
/// The share of what its chassis carries a design leaves at most taken, loaded: the rest is for what the player adds.
pub(crate) const SPARE:f64=0.9;
/// The command visor: at least 0.15 m of real armoured glass [E], as thick as the glass sold to stand repeated hits of small-calibre
/// armour-piercing rounds, 85 to 105 mm [S, NATO SPS project on transparent armour, 2009]: 90 mm [E].
const VISION:(f64,f64)=(0.15,90.0);
fn rounded(value:f64)->f64 {(value+0.5).floor()}
/// A share of a length, to the millionth.
fn micro(value:f64)->f64 {(value*1e6).round()/1e6}
/// The size of a piece with this many times the room of one of the reference size: a piece stands as deep across the
/// body at any size (game_geometry.rs `installed_depth`), so that one of size s has s² of that room, and holds, gives
/// and weighs as much more.
fn room_size(room:f64)->f64 {ComplexField::sqrt(room)}
/// The size of an engine that gives so many kilowatts: one of the reference size gives 180 kW, and one of another as
/// much more as its room (game_motion.rs `engine_power_kw`).
fn engine_size(power:f64)->f64 {room_size(power/180.0)}
/// A node laid out in metres, written on the cell nearest to it, as every position of a design is (`cell`): the ends
/// of a chassis and the nodes on them alike.
fn node(id:&str,x:f64,y:f64)->Value {
    json!({"id":id,"x":cell(x),"y":cell(y)})
}
/// A position written in cells, in metres.
fn read(value:&Value)->f64 {value.as_f64().unwrap_or(0.0)/(1.0/CELL)}
/// The first cell at a height in metres or over it.
fn over(metres:f64)->i64 {(metres/CELL-1e-9).ceil() as i64}
/// The cell a factory lays the top of a chassis on, from the reference: that of the deck of its model, on which the tub
/// of a track stands as its model has it, since the factory sizes the track for it (`fitted_gear`); for wheels, the
/// first cell over it, so that the rails clear the wheels at full bump as the model has them.
fn deck_cell(source:&Value,catalogue:&Value)->Result<i64,String> {
    let deck=factory_deck(source,catalogue).map_err(|e|e.to_string())?-1.3;
    Ok(if source["chassis"]["model"]=="tracked" {cell(deck)} else {over(deck)})
}
/// The running gear a factory gives a chassis, `gear` across as its design has it: a track that sets the deck of its
/// model on a whole cell (the deck rises with the track, game_chassis.rs), the first under it, so that the track is no
/// larger than its design and pulls no less; wheels as they are.
fn fitted_gear(model:&str,gear:f64,spec:&Value)->Result<f64,String> {
    if model!="tracked" {return Ok(gear);}
    let (Some(deck),Some(track))=(spec["deck"].as_f64(),spec["track"].as_f64()) else {return Err("Rodagem de modelo desconhecido.".into())};
    let deck=deck+gear-track-1.3;
    Ok(gear+metres((deck/CELL+1e-9).floor() as i64)-deck)
}
/// One authored unit along the exact tangent of the plate, keeping a seated sensor on the same face.
fn along_plate(source:&Value,id:&str)->Result<(f64,f64),String> {
    let plate=source["plates"].as_array().and_then(|plates|plates.iter().find(|plate|plate["id"]==id)).ok_or("Chapa de modelo inválida.")?;
    let node=|end:&str|source["nodes"].as_array().and_then(|nodes|nodes.iter().find(|node|node["id"]==plate[end]))
        .map(|node|(node["x"].as_f64().unwrap_or(0.0),node["y"].as_f64().unwrap_or(0.0))).ok_or("Contorno de modelo inválido.");
    let (a,b)=(node("a")?,node("b")?);let (dx,dy)=(b.0-a.0,b.1-a.1);let length=(dx*dx+dy*dy).sqrt();
    if length==0.0{return Err("Contorno de modelo inválido.".into());}Ok((dx/length,dy/length))
}
fn plate(id:&str,a:&str,b:&str,material:&str,thickness:f64)->Value {
    json!({"id":id,"a":a,"b":b,"material":material,"thicknessMm":rounded(thickness)})
}
fn part_box(part:&Value,catalogue:&Value)->Result<Bounds,String> {
    let kind=part["kind"].as_str().ok_or("Peça de modelo inválida.")?;
    let (w,h)=if kind=="sensor" {
        let(w,h,_)=sensor_dimensions(catalogue,part).map_err(|error|error.to_string())?;(w,h)
    } else {let(w,h,_)=ComponentKind::from_name(kind)?.dimensions();(w,h)};
    if part["pose"]["angle"].as_f64()!=Some(0.0) || kind=="weapon" {return Err("Apoio de modelo requer uma caixa imóvel nivelada.".into());}
    let scale=part["sizeScale"].as_f64().unwrap_or(1.0);
    let(x,y)=(read(&part["pose"]["x"]),read(&part["pose"]["y"]));
    Ok(Bounds{min_x:x-w*scale/2.0,max_x:x+w*scale/2.0,min_y:y-h*scale/2.0,max_y:y+h*scale/2.0})
}
fn support_wall(source:&Value,id:&str)->Result<((f64,f64),(f64,f64),f64),String> {
    let plate=source["plates"].as_array().and_then(|plates|plates.iter().find(|plate|plate["id"]==id)).ok_or("Chapa de apoio de modelo inválida.")?;
    let node=|end:&str|source["nodes"].as_array().and_then(|nodes|nodes.iter().find(|node|node["id"]==plate[end]))
        .map(|node|(read(&node["x"]),read(&node["y"]))).ok_or("Contorno de modelo inválido.");
    Ok((node("a")?,node("b")?,plate["thicknessMm"].as_f64().ok_or("Chapa de apoio de modelo inválida.")?/2000.0))
}
/// A factory recipe rests a level box directly on its chosen real face. Only its starting height changes;
/// later edits retain the ordinary authored pose and must pass the same physical manufacture admission.
fn rest_on_face(source:&mut Value,catalogue:&Value,id:&str,span:(f64,f64),height:f64)->Result<(),String> {
    rest_part_on_face(source["components"].as_array_mut().ok_or("Peças de modelo inválidas.")?,catalogue,id,span,height)
}
fn rest_part_on_face(parts:&mut[Value],catalogue:&Value,id:&str,span:(f64,f64),height:f64)->Result<(),String> {
    let part=parts.iter_mut().find(|part|part["id"]==id).ok_or("Peça de modelo inválida.")?;
    let box_=part_box(part,catalogue)?;
    if box_.min_x.max(span.0)>=box_.max_x.min(span.1) {return Err(format!("Sem contato físico para assentar {id}."));}
    part["pose"]["y"]=json!((height+(box_.max_y-box_.min_y)/2.0)/CELL);
    Ok(())
}
fn rest_on_floor(source:&mut Value,catalogue:&Value,id:&str)->Result<(),String> {
    let(a,b,half)=support_wall(source,"hull:floor")?;
    if (a.1-b.1).abs()>1e-9 {return Err("Piso de modelo deve estar nivelado.".into());}
    rest_on_face(source,catalogue,id,(a.0.min(b.0),a.0.max(b.0)),a.1+half)
}
/// Keep the tank's established gun pose and armour. Where thicker front armour makes the fixed installation
/// reach the roof, extend its two real walls by exactly that deficit and carry the seated roof sensors with it.
/// This is a one-time factory dimension, never an edit-time fit or a different admission rule.
fn cannon_roof(source:&mut Value,catalogue:&Value,sensors:&[String])->Result<(),String> {
    let gun=source["components"].as_array().and_then(|parts|parts.iter().find(|part|part["id"]=="weapon")).ok_or("Canhão de modelo inválido.")?;
    let weapon=&catalogue["weapons"][gun["weaponPreset"].as_str().ok_or("Canhão de modelo inválido.")?];
    let profile=&catalogue["mounts"][gun["mount"]["preset"].as_str().ok_or("Montagem de modelo inválida.")?];
    let (width,height)=receiver_dimensions(weapon)?;let barrel=BarrelProfile::from_weapon(weapon)?;
    let shield=Shield{radius:gun["mount"]["radiusM"].as_f64().ok_or("Máscara de modelo inválida.")?,
        thickness:profile["armourMm"].as_f64().ok_or("Blindagem de montagem inválida.")?/1000.0,
        half_angle:PI/3.0,opening:barrel.radius+CLEARANCE};
    let base=Base::derive(profile,shield,width,height,barrel,
        profile["depthM"].as_f64().unwrap_or(ComponentKind::Weapon.dimensions().2),
        weapon["installedMassKg"].as_f64().ok_or("Massa de canhão inválida.")?,Material::named("steel").unwrap())?;
    let angle=gun["pose"]["angle"].as_f64().ok_or("Posição de canhão inválida.")?;
    let top=read(&gun["pose"]["y"])+base.half_width*sin(angle).abs()+(base.inner_y+base.thickness)*cos(angle).abs();
    let(a,b,half)=support_wall(source,"turret:roof")?;
    if (a.1-b.1).abs()>1e-9 {return Err("Teto de torre de canhão deve estar nivelado.".into());}
    let lift=top+half-a.1;
    if lift<=0.0 {return Ok(());}
    let lift=(lift+1e-9)/CELL;
    for node in source["nodes"].as_array_mut().ok_or("Contorno de modelo inválido.")? {
        if node["id"]=="turret-top-front" || node["id"]=="turret-top-rear" {node["y"]=json!(node["y"].as_f64().unwrap()+lift);}
    }
    for part in source["components"].as_array_mut().ok_or("Peças de modelo inválidas.")? {
        if sensors.iter().any(|id|part["id"].as_str()==Some(id.as_str())) {part["pose"]["y"]=json!(part["pose"]["y"].as_f64().unwrap()+lift);}
    }
    Ok(())
}
/// Factory layout only. The emitted design contains physical local poses: it has
/// no cells, placement classes or ongoing relationship to its starting surface.
struct Equipment<'a> {
    catalogue:&'a Value,
    parts:Vec<Value>,
    seats:Vec<(usize,String,f64)>,
    floor:f64,
}
impl<'a> Equipment<'a> {
    /// Its rows a tenth of a metre apart, from the first cell clear of the face of the floor, `floor_mm` thick.
    fn new(catalogue:&'a Value,floor_mm:f64)->Self {
        let face=floor_mm/2000.0+CLEARANCE;
        Self{catalogue,parts:Vec::new(),seats:Vec::new(),floor:metres(over(face))+0.1*(-face/0.1+1e-9).floor()}
    }
    fn inside(&mut self,id:&str,kind:&str,corner:[i64;2],extra:Value)->Result<(),String> {
        let mut part=json!({"id":id,"kind":kind});
        if let Some(values)=extra.as_object() {for (key,value) in values {part[key]=value.clone();}}
        if kind=="sensor" && part["sensorMode"]=="radar" {part["radarModel"]=json!("mobile");}
        let (w,h)=if kind=="sensor" {
            let(w,h,_)=sensor_dimensions(self.catalogue,&part).map_err(|error|error.to_string())?;(w,h)
        } else {let (w,h,_)=ComponentKind::from_name(kind)?.dimensions();(w,h)};
        let scale=part["sizeScale"].as_f64().unwrap_or(1.0);
        let extent=|m:f64|(m*scale/0.1-1e-9).ceil()*0.1;
        part["pose"]=json!({"x":cell(0.1*corner[0] as f64+extent(w)/2.0),"y":cell(self.floor+0.1*corner[1] as f64+extent(h)/2.0),"angle":0.0});
        self.parts.push(part);Ok(())
    }
    fn on(&mut self,id:&str,kind:&str,plate:&str,t:f64,extra:Value) {
        let mut part=json!({"id":id,"kind":kind});
        if let Some(values)=extra.as_object() {for (key,value) in values {part[key]=value.clone();}}
        if kind=="sensor" && part["sensorMode"]=="radar" {part["radarModel"]=json!("mobile");}
        self.seats.push((self.parts.len(),plate.to_owned(),t));self.parts.push(part);
    }
    fn gun(&mut self,id:&str,preset:&str,plate:&str,t:f64,mount:&str,sector:Value,reserve:[i64;2])->Result<(),String> {
        self.on(id,"weapon",plate,t,json!({"weaponPreset":preset,"mount":{"preset":mount,"sector":sector}}));
        self.inside(&format!("{id}-ammo"),"ammo",reserve,json!({"ammoPreset":preset}))
    }
    fn on_floor(&mut self,id:&str,span:(f64,f64),face:f64)->Result<(),String> {
        rest_part_on_face(&mut self.parts,self.catalogue,id,span,face)
    }
    fn on_box(&mut self,id:&str,base:&str)->Result<(),String> {
        let part=self.parts.iter().find(|part|part["id"]==base).ok_or("Peça de modelo inválida.")?;
        let box_=part_box(part,self.catalogue)?;
        rest_part_on_face(&mut self.parts,self.catalogue,id,(box_.min_x,box_.max_x),box_.max_y)
    }
    /// Lay out the factory geometry once. Later thickness, suspension or wheel
    /// edits leave all of these authored positions alone.
    fn finish(mut self,mut source:Value,hull_height:f64)->Result<Value,String> {
        let floor=if source.get("chassis").is_some() {source["chassis"]["topPlate"]["thicknessMm"].as_f64()}
            else {source["plates"].as_array().and_then(|plates|plates.iter().find(|plate|plate["id"]=="hull:floor"))
                .and_then(|plate|plate["thicknessMm"].as_f64())}.ok_or("Piso físico de modelo inválido.")?/2000.0;
        // The chassis starts on the model's deck; the hull floor rests exactly half its thickness over it.
        // Exact authored-unit shifts keep thin floors in contact without moving any existing design during compilation.
        let shift=if source.get("chassis").is_some() {
            let deck=deck_cell(&source,self.catalogue)?;
            for point in source["chassis"]["points"].as_array_mut().ok_or("Chassi de modelo inválido.")? {
                point["y"]=json!(point["y"].as_i64().unwrap_or(0)+deck);
            }
            deck as f64+floor/CELL
        } else {(hull_height-1.3)/CELL};
        for node in source["nodes"].as_array_mut().ok_or("Contorno de modelo inválido.")? {
            node["y"]=json!(node["y"].as_f64().unwrap_or(0.0)+shift);
        }
        seed_plate_ends(&mut source).map_err(|e|e.to_string())?;
        for part in &mut self.parts {if let Some(pose)=part.get_mut("pose") {
            pose["y"]=json!(pose["y"].as_f64().unwrap_or(0.0)+shift);
        }}
        // The helpers choose a starting pose from an explicitly drawn face.
        // No face-following relationship is saved in the finished design.
        // Nearby sensors separate along the true plate tangent, preserving their exact normal contact.
        let mut sensors:Vec<(f64,f64,f64,f64)>=Vec::new();
        for (i,plate,t) in self.seats {
            let part=&mut self.parts[i];
            if part["kind"]=="weapon" {
                let mount=&part["mount"];let sector=&mount["sector"];
                let placed=mount_on_plate(&source,self.catalogue,&plate,t,part["weaponPreset"].as_str().unwrap(),
                    mount["preset"].as_str().unwrap(),(sector["min"].as_f64().unwrap(),sector["max"].as_f64().unwrap()))
                    .map_err(|e|e.to_string())?;
                part["pose"]=placed["pose"].clone();part["mount"]=placed["mount"].clone();
            } else {
                let mut pose=if plate=="chassis:top-0" {
                    // Cargo rests on the upper face of this level factory deck. Its room's exterior normal points
                    // down under the cab, so an exterior-wall helper would put a bed load below the same floor.
                    let points=source["chassis"]["points"].as_array().filter(|points|points.len()==2&&points[0]["y"]==points[1]["y"])
                        .ok_or("Convés de modelo deve estar nivelado.")?;
                    let(_,height,_)=ComponentKind::from_name(part["kind"].as_str().ok_or("Peça de modelo inválida.")?)?.dimensions();
                    let scale=part["sizeScale"].as_f64().unwrap_or(1.0);
                    json!({"x":points[1]["x"].as_f64().unwrap()+(points[0]["x"].as_f64().unwrap()-points[1]["x"].as_f64().unwrap())*t,
                        "y":points[0]["y"].as_f64().unwrap()+(2.0*floor+height*scale/2.0)/CELL,"angle":0.0})
                } else {part_on_plate(&source,self.catalogue,part,&plate,t).map_err(|e|e.to_string())?};
                if part["kind"]=="sensor" {
                    let(w,h,_)=sensor_dimensions(self.catalogue,part).map_err(|error|error.to_string())?;
                    let scale=part["sizeScale"].as_f64().unwrap_or(1.0);
                    let half=(w*scale/2.0,h*scale/2.0);
                    let step=along_plate(&source,&plate)?;
                    for _ in 0..4 {
                        let (x,y)=(read(&pose["x"]),read(&pose["y"]));
                        let Some(&(ox,oy,_,_))=sensors.iter().find(|&&(ox,oy,ow,oh)|
                            (x-ox).abs()<half.0+ow+CLEARANCE-1e-9 && (y-oy).abs()<half.1+oh+CLEARANCE-1e-9) else {break};
                        let way=if (x-ox)*step.0+(y-oy)*step.1>=0.0 {1.0} else {-1.0};
                        pose["x"]=json!(pose["x"].as_f64().unwrap_or(0.0)+way*step.0);
                        pose["y"]=json!(pose["y"].as_f64().unwrap_or(0.0)+way*step.1);
                    }
                    sensors.push((read(&pose["x"]),read(&pose["y"]),half.0,half.1));
                }
                part["pose"]=pose;
            }
        }
        // Factory vehicles face left. Their rear-facing doors and screeds are
        // part of the authored pose, independent of which way an actor drives.
        for part in &mut self.parts {
            if matches!(part["kind"].as_str(),Some("hopper"|"cistern"|"supply"|"blade"|"paver")) {
                part["pose"]["mirrored"]=json!(true);
            }
        }
        source["components"]=json!(self.parts);Ok(source)
    }
}
/// How far a gun in the upright front of a tower is lowered at most: as far as it asks, or as far as its tube keeps a
/// hand over each corner of the plates before it, from its `trunnion`.
fn clear_depression(trunnion:(f64,f64),corners:&[(f64,f64)],radius:f64,maximum:f64)->f64 {
    corners.iter().fold(maximum,|lowest,&(x,y)|lowest.min(atan2(trunnion.1-y-radius-0.05,(trunnion.0-x).max(0.1))))
}
/// How far behind the face of its mount, `plate` thick, a weapon has its trunnion (game_construction.rs
/// `derive_mount`).
fn inset(catalogue:&Value,preset:&str,plate:f64)->Result<f64,String> {
    let weapon=&catalogue["weapons"][preset];
    Ok((receiver_dimensions(weapon)?.1/2.0).max(weapon["barrelRadius"].as_f64().unwrap_or(0.0))+plate/2.0+CLEARANCE)
}

/// The motor grader as the owner drew it in the workshop, after the Caterpillar 140: on six tyres of 1.25 m, an axle
/// under the nose and a tandem under the cab at the rear. Its frame is an arched neck, from the foot of the cab forward
/// and up over the blade, which hangs from the neck 2.35 m behind the front axle and 2.7 m ahead of the tandem, and
/// down to a push block over the front axle. Its chassis runs under the push block and under the cab, with a gap
/// between them under the neck, which bears the load over it. The cab stands tall, glazed at the front from its roof down: in it the
/// command post and the fuel. The command post looks through that glass over the neck, and on its roof a
/// camera; the engine in a box behind it. All of it is of 8 mm of steel, on a frame as thick. It is one outline, the
/// owner's: the options of the designs drawn below (their weapon, sensors, stretch, armour and engine) do not apply to it.
fn grader(name:&str,catalogue:&Value)->Result<Value,String> {
    // The nodes and the plates in the order the workshop wrote them, under its names: the cab with the box of the
    // engine behind it, from the front of its floor (`hull`); the neck (`bay-2`) and the push block (`bay-3`, `bay-4`).
    let nodes=[("hull-0",1.5,0.0),("hull-1",4.4,0.0),("hull-2",4.4,0.9),("hull-3",1.4,2.4),("hull-4",1.2,0.9),
        ("vision-bottom",1.5,1.1),("bay-2-0",-1.9,1.3),("bay-2-1",-1.9,1.1),("bay-3-1",-2.9,0.0),("node-2",-3.8,0.0),
        ("node-3",0.1,1.1),("node-4",-2.9,0.8),("node-5",-2.9,0.994),("node-6",0.2,1.3),("node-7",3.1,2.4),
        ("node-8",2.937876,0.9),("bay-4-1",-3.8,0.994)].map(|(id,x,y)|node(id,x,y));
    let plates=[("hull:rear","hull-1","hull-2"),("hull:roof","hull-2","node-8"),
        ("hull:roof-3","node-8","node-7"),("hull:roof-2","node-7","hull-3"),("hull:vision","hull-3","vision-bottom"),
        ("hull:glacis-foot","vision-bottom","hull-4"),("hull:front","hull-4","hull-0"),("bay-2:roof","hull-4","node-6"),
        ("bay-2:roof-2","node-6","bay-2-0"),("bay-2:under","bay-2-1","node-3"),("bay-2:under-2","node-3","hull-0"),
        ("bay-3:roof","bay-2-0","node-5"),("bay-3:front","bay-4-1","node-2"),("bay-3:front-2","node-2","bay-3-1"),
        ("bay-3:under","bay-3-1","node-4"),("bay-3:under-2","node-4","bay-2-1"),("bay-4:roof","node-5","bay-4-1")]
        .map(|(id,a,b)|if id=="hull:vision" {plate(id,a,b,"glass",60.0)} else {plate(id,a,b,"steel",8.0)});
    let mut parts=Equipment::new(catalogue,8.0);
    parts.inside("engine","engine",[32,2],Value::Null)?;
    parts.inside("fuel","fuel",[19,14],Value::Null)?;
    // Its own visor must stand over the real 1.3 m neck, not look into that steel.
    parts.inside("command","command",[21,13],Value::Null)?;
    // Keep the working blade pose: its lift group hangs it from the neck across the chassis gap, 1.42 m over it
    // (game_construction.rs `stand_off`).
    parts.parts.push(json!({"id":"blade","kind":"blade","sizeScale":1.0,
        "pose":{"x":cell(4.4-0.621951*8.2),"y":((-0.28-0.45/2.0)/CELL).floor() as i64,"angle":0.0}}));
    parts.on("sensor-0","sensor","hull:roof-2",0.490348,json!({"sensorMode":"visual"}));
    for id in ["engine","fuel"] {parts.on_floor(id,(1.5,4.4),0.004)?;}
    let wheel=catalogue["chassis"]["wheeled"]["wheel"].as_f64().ok_or("Rodagem de modelo desconhecido.")?;
    parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","name":name,"seed":6173,
        "chassis":{"model":"wheeled","points":[{"x":cell(-3.8),"y":0},{"x":cell(-2.9),"y":0,"gap":true},{"x":cell(1.5),"y":0},{"x":cell(4.4),"y":0}],
            "thicknessMm":8.0,"gearScale":1.25/wheel,"axles":[cell(-3.05),cell(2.0),cell(3.5)],
            "topPlate":{"material":"steel","thicknessMm":8.0}},
        "nodes":nodes,"plates":plates,"appearance":{"paint":"#a38f48"}}),0.0)
}
/// Both fixed extractors use a small service house. The engine has a working margin over its tool;
/// no running gear or container is paid for, since output stays in the vein's public pile.
fn fixed_extractor(name:&str,tool:&str,power:f64,catalogue:&Value)->Result<Value,String> {
    let (length,height)=(3.2,1.4);
    let nodes=[(-length/2.0,0.0),(length/2.0,0.0),(length/2.0,height),(-length/2.0,height)].into_iter().enumerate()
        .map(|(i,(x,y))|node(&format!("hull-{i}"),x,y)).collect::<Vec<_>>();
    let plates=["floor","rear","roof","front"].into_iter().enumerate().map(|(i,side)|
        plate(&format!("hull:{side}"),&format!("hull-{i}"),&format!("hull-{}",(i+1)%4),
            if i==2{"steel"}else{"concrete"},if i==2{8.0}else{80.0})).collect::<Vec<_>>();
    let mut parts=Equipment::new(catalogue,80.0);
    parts.inside("engine","engine",[-15,1],json!({"sizeScale":engine_size(power)}))?;
    parts.inside("fuel","fuel",[-3,1],Value::Null)?;
    parts.inside("command","command",[7,1],Value::Null)?;
    parts.on(tool,tool,"hull:roof",0.2,Value::Null);
    parts.on("sensor","sensor","hull:roof",0.8,json!({"sensorMode":"visual"}));
    let mut authored=parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"bunker","name":name,"seed":6173,
        "nodes":nodes,"plates":plates,"appearance":{"paint":"#8a7f5c"}}),0.15)?;
    for id in ["engine","fuel","command"] {rest_on_floor(&mut authored,catalogue,id)?;}
    Ok(authored)
}
/// The owner's truck cab, as he drew it in the workshop on the ore truck (2026-10-28), shared by the road trucks and the
/// tracked trucks that haul: a low bonnet from the nose, its roof rising 0.15 m back to the foot of the cab; the cab
/// 1.7 m long behind it and as tall as its design, glazed only in a short windscreen, 0.35 m, between a sloped brow of
/// steel under its flat roof and a sloped foot down to the bonnet; the rear of the cab upright. The cab keeps his
/// metres, from its rear wall at `cab`; the bonnet is as long as the rest of the cab length of each design, from the
/// nose at `front`. Its plates are `gauge` thick, its glass 40 mm.
fn bonnet_cab(front:f64,cab:f64,height:f64,gauge:f64)->(Vec<Value>,Vec<Value>) {
    let nodes=[("hull-0",front,0.0),("hull-1",cab,0.0),("hull-2",cab,height),
        ("hull-3",cab-1.45,height),("vision-top",cab-1.55,1.5),("vision-bottom",cab-1.65,1.15),
        ("hood-back",cab-1.7,0.95),("hood-front",front+0.1,0.8),("hull-4",front,0.65)]
        .into_iter().map(|(id,x,y)|node(id,x,y)).collect::<Vec<_>>();
    let plates=[("hull:rear","hull-1","hull-2"),("hull:roof","hull-2","hull-3"),
        ("hull:glacis","hull-3","vision-top"),("hull:vision","vision-top","vision-bottom"),
        ("hull:glacis-foot","vision-bottom","hood-back"),("hood:roof","hood-back","hood-front"),
        ("hood:nose","hood-front","hull-4"),("hull:front","hull-4","hull-0")]
        .into_iter().map(|(id,a,b)|plate(id,a,b,if id=="hull:vision"{"glass"}else{"steel"},
            if id=="hull:vision"{40.0}else{gauge})).collect::<Vec<_>>();
    (nodes,plates)
}
/// What that cab holds: the engine, `scale` its size, under the bonnet from the nose; the driver's command behind the
/// windscreen, looking out through it; the fuel behind him against the rear wall. Engine and fuel stand on the floor,
/// `gauge` thick.
fn bonnet_equipment(parts:&mut Equipment<'_>,front:f64,cab:f64,scale:f64,gauge:f64)->Result<(),String> {
    // The first row of a tenth of a metre at `x` or after it.
    let corner=|x:f64|(x/0.1-1e-6).ceil() as i64;
    parts.inside("engine","engine",[corner(front+0.2),1],json!({"sizeScale":scale}))?;
    parts.inside("fuel","fuel",[corner(cab-0.95),1],Value::Null)?;
    parts.inside("command","command",[corner(cab-1.4),11],Value::Null)?;
    parts.parts.last_mut().unwrap()["pose"]["y"]=json!(cell(1.3));
    for id in ["engine","fuel"] {parts.on_floor(id,(front,cab),gauge/2000.0)?;}
    Ok(())
}
/// Where a sensor of that cab stands: the camera at the front of its roof, over the windscreen; a radar at the rear of
/// the roof; a microphone on the bonnet.
fn bonnet_sensor(mode:&str)->(&'static str,f64) {
    match mode {"visual"=>("hull:roof",0.85),"radar"=>("hull:roof",0.35),_=>("hood:roof",0.6)}
}
/// The public truck family is authored as an ordinary stepped enclosure on a real chassis floor, in the owner's cab
/// (`bonnet_cab`). No decorative box conceals a different physical hull. The rear deck is free on the base, or carries
/// its own normal cargo piece.
fn road_truck(id:&str,name:&str,length:f64,options:&Value,catalogue:&Value)->Result<Value,String> {
    let design=design(id).ok_or("Chassi de caminhão desconhecido.")?;
    let armour=option_number(options,"armourScale",1.0)?;
    let scale=engine_size(design.power)*option_number(options,"engineScale",1.0)?;
    let (front,rear)=(metres(cell(-length/2.0)),metres(cell(length/2.0)));
    let cab=front+design.cab.ok_or("Cabine de caminhão ausente.")?;let floor=rounded(6.0*armour);
    if rear-cab<0.5 {return Err("O chassi não deixa espaço atrás da cabine do caminhão.".into());}
    let (nodes,plates)=bonnet_cab(front,cab,design.height,floor);
    let mut parts=Equipment::new(catalogue,floor);
    bonnet_equipment(&mut parts,front,cab,scale,floor)?;
    // The load of each, by the room it has: the lorry's hopper 3.375 times that of the reference one, 4.7 m³ that take
    // 11 t of ore; the supply piece and the cistern 4.096 times theirs, 4.3 m³ of crates and cans and 4.4 m³, 4 400 L, of
    // petroleum (`room_size`).
    let load=match id {"truck"=>Some(("hopper",3.375)),"supply"=>Some(("supply",4.096)),"tanker"=>Some(("cistern",4.096)),_=>None};
    if let Some((kind,room))=load {
        let size=room_size(room);
        let width=ComponentKind::from_name(kind)?.dimensions().0*size;
        let used=width+if id=="tanker"{0.15+ComponentKind::Drill.dimensions().0}else{0.0};
        if rear-cab<used+0.2 {return Err("A carroceria não cabe no convés deste caminhão.".into());}
        let start=cab+(rear-cab-used)/2.0;
        parts.on(kind,kind,"chassis:top-0",(rear-start-width/2.0)/(rear-front),json!({"sizeScale":size}));
        if id=="tanker" {parts.on("drill","drill","chassis:top-0",
            (rear-start-width-0.15-ComponentKind::Drill.dimensions().0/2.0)/(rear-front),Value::Null);}
    }
    for (i,mode) in template_sensor_modes(id,options,false)?.iter().enumerate() {
        let (roof,t)=bonnet_sensor(mode);
        parts.on(&format!("sensor-{i}"),"sensor",roof,t,json!({"sensorMode":mode}));
    }
    let mut axles=vec![cell(front+1.0)];if id=="tanker" {axles.push(cell(front+2.6));}
    axles.extend([cell(rear-2.3),cell(rear-0.9)]);
    let wheel=catalogue["chassis"]["wheeled"]["wheel"].as_f64().ok_or("Rodagem de caminhão desconhecida.")?;
    parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","name":name,"seed":6173,
        "chassis":{"model":"wheeled","points":[{"x":cell(front),"y":0},{"x":cell(rear),"y":0}],
            "gearScale":design.gear/wheel,"axles":axles,"topPlate":{"material":"steel","thicknessMm":floor}},
        "nodes":nodes,"plates":plates,"appearance":{"paint":design.paint}}),0.0)
}
/// The tracked carriers. The base chassis and the ore truck haul in the owner's truck cab (`bonnet_cab`). The
/// constructor and the paver keep the Panther T8's broad glazed cab and separate chamfered engine enclosure behind it:
/// their engines of 400 and 500 kW stand taller than that low bonnet. These are actual plates; the cosmetic side door
/// neither hides another hull nor grants vision through steel.
fn work_carrier(id:&str,name:&str,length:f64,options:&Value,catalogue:&Value)->Result<Value,String> {
    let design=design(id).ok_or("Máquina de trabalho desconhecida.")?;
    let armour=option_number(options,"armourScale",1.0)?;
    let gauge=rounded(design.armour[0]*armour);
    let scale=engine_size(design.power)*option_number(options,"engineScale",1.0)?;
    let (front,rear)=(metres(cell(-length/2.0)),metres(cell(length/2.0)));
    let cab=front+design.cab.ok_or("Cabine de trabalho ausente.")?;
    let truck=matches!(id,"tracked"|"mining-truck");
    let mut parts=Equipment::new(catalogue,gauge);
    let (nodes,plates)=if truck {
        bonnet_equipment(&mut parts,front,cab,scale,gauge)?;
        bonnet_cab(front,cab,design.height,gauge)
    } else {
        let mut nodes=[("hull-0",front,0.0),("hull-1",cab,0.0),("hull-2",cab,1.05),
            ("cab-foot",front+1.45,0.0),("cab-rear",front+1.45,1.65),("hull-3",front+0.26,1.65),
            ("cab-front",front+0.08,1.50),("vision-top",front+0.05,1.40),("vision-bottom",front,0.55),
            ("hood-foot",front+1.58,0.0),("hood-front",front+1.58,1.10),
            ("hood-brow",front+1.75,1.18),("hood-back",cab-0.12,1.18)]
            .into_iter().map(|(id,x,y)|node(id,x,y)).collect::<Vec<_>>();
        let mut plates=[("hull:rear","hull-1","hull-2"),("hood:rear-brow","hull-2","hood-back"),
            ("hood:roof","hood-back","hood-brow"),("hood:nose","hood-brow","hood-front"),
            ("hood:front","hood-front","hood-foot"),
            ("cab:rear","cab-foot","cab-rear"),("hull:roof","cab-rear","hull-3"),
            ("cab:brow","hull-3","cab-front"),("cab:front","cab-front","vision-top"),
            ("hull:vision","vision-top","vision-bottom"),("hull:front","vision-bottom","hull-0")]
            .into_iter().map(|(id,a,b)|plate(id,a,b,if id=="hull:vision"{"glass"}else{"steel"},
                if id=="hull:vision"{40.0}else{gauge})).collect::<Vec<_>>();
        if id=="paver" {
            // A low conveyor/service housing joins the engine bay to the paving unit. Its own walls close against
            // the same chassis floor; the hopper and rear screed remain the ordinary functional paver component.
            let end=rear-ComponentKind::Paver.dimensions().0-0.1;
            nodes.extend([node("conveyor-front",cab,0.55),node("conveyor-rear",end,0.55),node("conveyor-foot",end,0.0)]);
            plates.iter_mut().find(|plate|plate["id"]=="hull:rear").unwrap()["a"]=json!("conveyor-front");
            plates.extend([plate("conveyor:front","hull-1","conveyor-front","steel",gauge),
                plate("conveyor:roof","conveyor-front","conveyor-rear","steel",gauge),
                plate("conveyor:rear","conveyor-rear","conveyor-foot","steel",gauge)]);
        }
        let corner=|x:f64|(x/0.1-1e-9).ceil() as i64;
        parts.inside("engine","engine",[corner(front+1.70),1],json!({"sizeScale":scale}))?;
        parts.inside("fuel","fuel",[corner(front+0.1),1],Value::Null)?;
        parts.inside("command","command",[corner(front+0.35),10],Value::Null)?;
        parts.parts.last_mut().unwrap()["pose"]["y"]=json!(cell(1.08));
        for id in ["engine","fuel"] {parts.on_floor(id,(front,cab),gauge/2000.0)?;}
        (nodes,plates)
    };
    // The miner's hopper is of the reference size, 1.38 m³ of ore; the constructor's supply piece has 4.096 times the room
    // of that of the reference size, 4.3 m³ (`room_size`).
    let load=match id {"mining-truck"=>Some(("hopper",1.0)),"construction-truck"=>Some(("supply",4.096)),_=>None};
    if let Some((kind,room))=load {
        let scale=room_size(room);
        let width=ComponentKind::from_name(kind)?.dimensions().0*scale;
        let tool=if id=="mining-truck"{"excavator"}else{"builder"};
        let tool_width=ComponentKind::from_name(tool)?.dimensions().0;
        if cab+0.2+width+tool_width>rear {return Err("A carga e a ferramenta não cabem atrás desta cabine.".into());}
        parts.on(kind,kind,"chassis:top-0",(rear-cab-0.1-width/2.0)/(rear-front),json!({"sizeScale":scale}));
        parts.on(tool,tool,"chassis:top-0",(rear-cab-0.2-width-tool_width/2.0)/(rear-front),Value::Null);
    }
    if id=="paver" {parts.on("paver","paver","chassis:top-0",ComponentKind::Paver.dimensions().0/(2.0*length),Value::Null);}
    for (i,mode) in template_sensor_modes(id,options,false)?.iter().enumerate() {
        let (host,t)=if truck {bonnet_sensor(mode)} else {
            match mode.as_str() {"visual"=>("hull:roof",0.55),"radar"=>("hood:roof",0.45),_=>("hull:rear",0.6)}};
        parts.on(&format!("sensor-{i}"),"sensor",host,t,json!({"sensorMode":mode}));
    }
    parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","name":name,"seed":6173,
        "chassis":factory_frame(id,length,armour,catalogue)?,"nodes":nodes,"plates":plates,
        "appearance":{"paint":design.paint}}),0.0)
}
// Factory finish uses the same editable, clipped appearance items as a player's project.
// Admission converts these initial plate-local poses to fixed project coordinates for later editing.
fn factory_details(source:&Value,template:&str,catalogue:&Value)->Vec<Value> {
    let mut details=Vec::new();
    if source["preset"]!="vehicle" {return details;}
    let mut add=|host:&str,kind:&str,x:f64,y:f64,width:Option<f64>,height:Option<f64>| {
        if details.len()>=32 {return;}
        let Ok((a,b,_))=support_wall(source,host) else{return};let angle=atan2(b.1-a.1,b.0-a.0);
        let(dx,dy)=(x-(a.0+b.0)/2.0,y-(a.1+b.1)/2.0);let spec=&catalogue["details"]["kinds"][kind];
        let mut detail=json!({"id":format!("finish-{}",details.len()+1),"kind":kind,"surface":"body","host":host,
            "x":micro(dx*angle.cos()+dy*angle.sin()),"y":micro(-dx*angle.sin()+dy*angle.cos()),"angle":-angle,
            "width":width.unwrap_or_else(||spec["width"].as_f64().unwrap()),"height":height.unwrap_or_else(||spec["height"].as_f64().unwrap())});
        if kind=="number" {detail["text"]=json!(format!("{:02}",source["seed"].as_u64().unwrap_or(6173)%89+10));}
        details.push(detail);
    };
    let nodes=source["nodes"].as_array().unwrap();
    let hull=nodes.iter().filter(|node|node["id"].as_str().is_some_and(|id|id.starts_with("hull-"))).collect::<Vec<_>>();
    if hull.is_empty() {return details;}
    let left=hull.iter().map(|n|read(&n["x"])).fold(f64::INFINITY,f64::min);
    let right=hull.iter().map(|n|read(&n["x"])).fold(f64::NEG_INFINITY,f64::max);
    let bottom=hull.iter().map(|n|read(&n["y"])).fold(f64::INFINITY,f64::min);
    let top=hull.iter().map(|n|read(&n["y"])).fold(f64::NEG_INFINITY,f64::max);
    let roof_height=|x:f64|["hull:deck","hull:roof"].into_iter().filter_map(|id| {
        let(a,b,_)=support_wall(source,id).ok()?;
        if x<a.0.min(b.0) || x>a.0.max(b.0) || (a.0-b.0).abs()<1e-9 {return None;}
        Some(a.1+(b.1-a.1)*(x-a.0)/(b.0-a.0))
    }).reduce(f64::max).unwrap_or(top);
    if matches!(template,"chassis"|"truck"|"supply"|"tanker"|"tracked"|"mining-truck") {
        // The owner's cab (`bonnet_cab`) is finished as he finished it: a crew door with its small window in the cab, a
        // step under it on the cab and one on the rail under that, the grille upright in the nose, a large headlight
        // behind it, the number on the bonnet before the windscreen and the filler of the tank in the cab under it.
        // The tanker's second axle stands under the door, where the steps would be; a track covers the rail.
        let wheeled=source["chassis"]["model"]=="wheeled";
        add("hull:roof","armour-door",right-0.77,bottom+1.055,Some(0.91),Some(1.24));
        if template!="tanker" {add("hull:roof","cab-step",right-0.73,bottom+0.173,Some(0.62),Some(0.14));}
        add("hull:roof","engine",left+0.02,bottom+0.382,Some(0.558),Some(0.126));
        add("hull:roof","headlight",left+0.423,bottom+0.514,Some(0.416),Some(0.236));
        add("hull:roof","number",right-1.773,bottom+0.624,None,None);
        add("hull:roof","filler",right-0.167,bottom+0.487,None,None);
        // The grille stands upright: a quarter turn from the level the others are laid at.
        let grille=details.iter_mut().find(|detail|detail["kind"]=="engine").unwrap();
        let turn=grille["angle"].as_f64().unwrap()-PI/2.0;grille["angle"]=json!(atan2(sin(turn),cos(turn)));
        if wheeled && template!="tanker" {
            details.push(json!({"id":format!("finish-{}",details.len()+1),"kind":"cab-step","surface":"chassis","host":"chassis:frame-0",
                "x":micro(right-0.73),"y":micro(bottom-0.213),"angle":0.0,"width":0.62,"height":0.14,"space":"project"}));
        }
    } else if template=="grader" {
        add("hull:roof-2","cab-door",left+0.86,bottom+1.46,Some(0.95),Some(1.3));
        add("hull:roof","engine",right-0.72,bottom+0.58,Some(1.05),Some(0.25));
        add("hull:roof","number",right-0.45,bottom+0.23,None,None);
        add("hull:roof-2","cab-step",left+0.86,bottom+0.72,Some(0.72),None);
        add("hull:roof","filler",right-0.33,bottom+0.67,None,None);
        add("hull:roof","taillight",right-0.13,bottom+0.45,None,None);
        add("bay-4:roof","headlight",-3.58,bottom+0.60,None,None);
    } else if matches!(template,"construction-truck"|"paver") {
        add("hull:roof","industrial-door",left+0.80,bottom+0.915,Some(1.10),Some(1.35));
        add("hull:roof","cab-step",left+0.84,bottom+0.10,Some(0.74),None);
        let engine=(left+1.75+right-0.12)/2.0;
        let panel_width=right-left-1.90;
        add("hood:roof","service-panel",engine,bottom+0.59,Some(panel_width),Some(0.76));
        add("hood:roof","engine",engine,bottom+0.85,Some(panel_width-0.14),Some(0.26));
        add("hood:roof","exhaust",engine,bottom+0.32,None,None);
        add("hull:roof","filler",left+1.30,bottom+0.13,None,None);
        add("hull:roof","headlight",left+0.18,bottom+0.13,None,None);
        add("hood:roof","number",engine,bottom+1.07,Some(0.28),Some(0.14));
        if template=="paver" {
            if let Ok((a,b,_))=support_wall(source,"conveyor:roof") {
                add("conveyor:roof","service-panel",(a.0+b.0)/2.0,a.1-0.24,Some(1.15),Some(0.38));
                add("conveyor:roof","engine",(a.0+b.0)/2.0,a.1-0.25,Some(0.85),Some(0.20));
            }
        }
    } else if template=="mortar" {
        let host="hull:roof";
        add(host,"hatch",left+1.52,roof_height(left+1.52)-0.055,Some(0.55),None);
        add(host,"periscope",left+1.16,roof_height(left+1.16)-0.055,None,None);
        add(host,"hatch",right-1.65,top-0.055,Some(0.82),None);
        add(host,"service-panel",right-0.83,bottom+0.71,Some(1.15),Some(0.72));
        add(host,"engine",right-0.83,bottom+0.86,Some(0.92),Some(0.22));
        add(host,"exhaust",right-0.83,bottom+0.49,Some(0.55),Some(0.15));
        add(host,"tools",left+2.35,bottom+0.96,Some(0.95),None);
        add(host,"cable",left+2.45,bottom+0.31,Some(2.05),None);
        add(host,"number",left+1.38,bottom+0.68,Some(0.28),Some(0.18));
        add(host,"headlight",left+0.24,bottom+0.30,None,None);
        add(host,"shackle",left+0.23,bottom+0.13,None,None);
        add(host,"taillight",right-0.15,bottom+0.57,None,None);
        add(host,"filler",right-0.20,bottom+0.24,None,None);
    } else {
        let (w,h)=(right-left,top-bottom);let host="hull:roof";
        // Enclosed military hulls have engine access, tow gear and roof hatches. Only the light armoured car has
        // a crew door in its side; the tank and troop carrier keep uninterrupted side armour.
        add(host,"engine",right-0.95,bottom+h*0.62,Some(if template=="heavy"{1.65}else{1.15}),Some(0.26));
        add(host,"exhaust",right-0.52,bottom+h*0.30,None,None);
        add(host,"cable",left+w*0.50,bottom+0.20,Some((w*0.48).min(3.2)),None);
        add(host,"headlight",left+0.24,bottom+0.43,None,None);
        add(host,"taillight",right-0.14,bottom+0.72*h,None,None);
        add(host,"shackle",left+0.23,bottom+0.14,None,None);
        add(host,"filler",right-0.23,bottom+0.40,None,None);
        if template=="scout" {
            add(host,"armour-door",left+1.35,bottom+0.71,Some(0.72),None);
            add(host,"cab-step",left+1.35,bottom+0.17,Some(0.55),Some(0.09));
        } else if template!="howitzer" {
            add(host,"hatch",left+1.20,roof_height(left+1.20)-0.05,None,None);
            add(host,"periscope",left+1.62,roof_height(left+1.62)-0.05,None,None);
            add(host,"tools",left+w*0.44,bottom+h*0.65,Some(1.0),None);
        }
        add(host,"number",left+w*0.40,bottom+h*0.42,None,None);
        if let (Ok((a,b,_)),Ok((front,_,_)))=(support_wall(source,"turret:roof"),support_wall(source,"turret:front")) {
            let (mid,y)=((a.0+b.0)/2.0,(a.1+b.1)/2.0);let span=(a.0-b.0).abs();
            add("turret:roof","hatch",mid-0.10,y-0.06,Some(0.58),None);
            if span>1.6 {add("turret:roof","periscope",front.0+0.20,y-0.055,None,None);}
            add("turret:roof","number",front.0+0.35,y-0.43,None,None);
            if template=="howitzer" {
                add("turret:roof","access-hatch",a.0-0.95,y-0.62,Some(0.60),Some(0.80));
                add("turret:roof","tools",mid-0.4,y-1.03,Some(1.25),None);
            } else if span>1.3 {add("turret:roof","bin",a.0-0.40,y-0.54,Some(0.60),Some(0.28));}
        }
    }
    details
}
/// Small vertical-takeoff reconnaissance craft and its longer supply carrier.
/// Ordinary authored parts, with no flight or price exception for a factory model.
fn aircraft(name:&str,cargo:bool)->Result<Value,String> {
    let half=if cargo{5.0}else{3.3};
    let deck=0.1;let floor=deck+0.006;
    let mut parts=Vec::new();
    let mut stand=|id:&str,kind:&str,x:f64,size:f64,angle:f64|->Result<(),String>{
        let(w,h,_)=ComponentKind::from_name(kind)?.dimensions();
        let rise=(w*angle.sin().abs()+h*angle.cos().abs())*size/2.0;
        let base=floor+if !cargo && matches!(kind,"fuel"|"command"){0.005}else{0.0};
        let mut part=json!({"id":id,"kind":kind,"sizeScale":size,
            "pose":{"x":x/CELL,"y":(base+rise)/CELL,"angle":angle}});
        if kind=="thruster" {part["metal"]=json!("titanium");}
        parts.push(part);Ok(())
    };
    if cargo {
        for (i,x) in [-4.15,-3.3,3.3,4.15].into_iter().enumerate() {stand(&format!("lift{i}"),"thruster",x,1.1,0.0)?;}
        stand("fuel","fuel",-1.2,1.3,0.0)?;
        stand("command","command",-2.1,1.0,0.0)?;
        stand("engine","engine",0.0,0.8,0.0)?;
        stand("supply","supply",1.75,1.2,0.0)?;
    } else {
        for (i,(x,angle)) in [(-1.1,-PI/4.0),(-0.05,0.0),(0.62,0.0),(1.67,PI/4.0)].into_iter().enumerate() {
            stand(&format!("lift{i}"),"thruster",x,1.0,angle)?;
        }
        stand("fuel","fuel",-2.8,1.25,0.0)?;
        stand("command","command",-2.05,1.0,0.0)?;
        stand("engine","engine",2.9,engine_size(92.16),0.0)?;
    }
    // A downward optical camera sees the ground; the command post on the deck cannot.
    parts.push(json!({"id":"eye","kind":"sensor","sensorMode":"visual",
        "pose":{"x":-2.0/CELL,"y":(deck-0.6)/CELL,"angle":PI}}));
    let mut source=json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","name":name,"seed":6173,
        "chassis":{"model":"aircraft","points":[{"x":-half/CELL,"y":deck/CELL},{"x":half/CELL,"y":deck/CELL}],
            "topPlate":{"material":"steel","thicknessMm":6.0}},
        "nodes":[],"plates":[],"components":parts,"appearance":{"paint":"#748269"}});
    // The scout's shallow glazed nose shelters the command post and tank. The
    // carrier leaves its deck open for payload and its ordinary exposed supports.
    if !cargo {
        let outline=[(-3.55,floor+0.0025),(-3.55,floor+0.45),(-3.3,floor+1.05),(-1.8,floor+1.05),(-1.8,floor+0.0025)];
        source["nodes"]=json!(outline.into_iter().enumerate().map(|(i,(x,y))|
            json!({"id":format!("cab-{i}"),"x":x/CELL,"y":y/CELL})).collect::<Vec<_>>());
        source["plates"]=json!((0..outline.len()).map(|i|plate(&format!("cab:{i}"),&format!("cab-{i}"),&format!("cab-{}",(i+1)%outline.len()),
            if i==1{"glass"}else{"steel"},if i==1{15.0}else{5.0})).collect::<Vec<_>>());
    }
    Ok(source)
}
pub(crate) fn source(id:&str,options:&Value,catalogue:&Value)->Result<Value,String> {
    let mut authored=source_recipe(id,options,catalogue)?;
    if !authored["appearance"].is_object() {authored["appearance"]=json!({"paint":"#68765a"});}
    authored["appearance"]["details"]=json!(factory_details(&authored,id,catalogue));
    Ok(authored)
}
fn source_recipe(id:&str,options:&Value,catalogue:&Value)->Result<Value,String> {
    if !options.is_object() {return Err("Opções do modelo inválidas.".into());}
    let name=catalogue["templates"].as_array().and_then(|templates|templates.iter().find(|item|item["id"]==id))
        .and_then(|template|template["name"].as_str()).ok_or("Modelo de construção desconhecido.")?;
    if id=="guard-post" {
        // A first field defence pays for ordinary small assemblies, without discounting the larger fortifications.
        let nodes=[(-1.2,0.0),(1.2,0.0),(1.2,1.4),(-1.2,1.4)].into_iter().enumerate()
            .map(|(i,(x,y))|node(&format!("hull-{i}"),x,y)).collect::<Vec<_>>();
        let plates=["floor","rear","roof","front"].into_iter().enumerate().map(|(i,side)|
            plate(&format!("hull:{side}"),&format!("hull-{i}"),&format!("hull-{}",(i+1)%4),
                if i==2{"steel"}else{"concrete"},if i==2{8.0}else{80.0})).collect::<Vec<_>>();
        let mut parts=Equipment::new(catalogue,80.0);
        parts.inside("command","command",[-1,7],Value::Null)?;
        parts.gun("weapon","minimi","hull:front",0.5,"light-trunnion",json!({"min":-0.45,"max":0.45}),[4,1])?;
        // A box with 0.091 of the room of the reference one, 1 270 rounds of the Minimi (`room_size`).
        let size=room_size(0.091125);
        let ammo=parts.parts.last_mut().unwrap();ammo["sizeScale"]=json!(size);
        // This smaller reserve starts at the same lower corner.
        let (w,h,_)=ComponentKind::Ammo.dimensions();
        ammo["pose"]=json!({"x":cell(0.4+(w*size/0.1-1e-9).ceil()*0.05),
            "y":cell(parts.floor+0.1+(h*size/0.1-1e-9).ceil()*0.05),"angle":0.0});
        parts.on("sensor","sensor","hull:roof",0.5,json!({"sensorMode":"visual"}));
        let mut authored=parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"bunker","name":name,"seed":6173,
            "nodes":nodes,"plates":plates}),0.15)?;
        rest_on_floor(&mut authored,catalogue,"weapon-ammo")?;
        return Ok(authored);
    }
    if id=="oil-well" {return fixed_extractor(name,"drill",165.0,catalogue);}
    if id=="mining-site" {return fixed_extractor(name,"excavator",120.0,catalogue);}
    if matches!(id,"air-scout"|"air-supply") {return aircraft(name,id=="air-supply");}
    if matches!(id,"plate"|"empty") {
        let assay=id=="plate";let length=if assay{2.8}else{5.4};let height=if assay{2.4}else{1.6};
        let nodes=[(-length/2.0,0.0),(length/2.0,0.0),(length/2.0,height),(-length/2.0,height)]
            .into_iter().enumerate().map(|(i,(x,y))|node(&format!("hull-{i}"),x,y)).collect::<Vec<_>>();
        let plates=["floor","rear","roof","front"].into_iter().enumerate().map(|(i,side)|plate(&format!("hull:{side}"),
            &format!("hull-{i}"),&format!("hull-{}",(i+1)%4),"steel",if assay && i==3{100.0}else{5.0})).collect::<Vec<_>>();
        let mut parts=Equipment::new(catalogue,5.0);
        // The assay wall is shut all around its command post: a camera on its roof is what it sees with.
        if assay {
            parts.inside("command","command",[0,10],Value::Null)?;
            parts.on("sensor-0","sensor","hull:roof",0.85,json!({"sensorMode":"visual"}));
        }
        let mut authored=parts.finish(json!({"version":CONSTRUCTION_VERSION,"preset":"bunker","name":name,"seed":6173,
            "nodes":nodes,"plates":plates}),0.15)?;
        if assay {rest_on_floor(&mut authored,catalogue,"command")?;}
        return Ok(authored);
    }
    if id=="grader" {return grader(name,catalogue);}
    let fixed=matches!(id,"bunker"|"outpost");
    let Some(design)=design(id) else {
        return if fixed {draft(id,options,catalogue,name,None)} else {Err("Modelo de construção desconhecido.".into())};
    };
    // Factory designs reinforce their real section until the complete load
    // fits with margin. Ordinary edits never change thickness automatically.
    let mortar=catalogue["weapons"][preset(id,options)]["family"]=="mortar";
    let wanted=design.length*option_number(options,"stretch",1.0)?+if mortar && options["dual"]==true {1.0} else {0.0};
    let spec=&catalogue["chassis"][design.model];
    let shortest=spec["length"][0].as_f64().ok_or("Chassi de modelo desconhecido.")?;
    let mut authored=draft(id,options,catalogue,name,Some((design.model,micro(wanted.clamp(shortest,12.0)))))?;
    let maximum=if spec["kind"]=="wheeled" {spec["depth"].as_f64().unwrap_or(0.25)*500.0} else {200.0};
    let mut gauge=authored["chassis"]["thicknessMm"].as_f64().unwrap_or_else(||spec["frameMm"].as_f64().unwrap_or(8.0));
    for _ in 0..32 {
        authored["chassis"]["thicknessMm"]=json!(gauge);
        // Factory reinforcement chooses its initial clearance as well as its
        // gauge. This runs only while creating the preset, never when compiling
        // or editing an existing design.
        let top=deck_cell(&authored,catalogue)?+cell(design.deck_offset);
        let delta=top-authored["chassis"]["points"][0]["y"].as_i64().unwrap();
        if delta!=0 {
            for node in authored["nodes"].as_array_mut().unwrap() {node["y"]=json!(node["y"].as_f64().unwrap()+delta as f64);}
            for point in authored["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(point["y"].as_i64().unwrap()+delta);}
            for part in authored["components"].as_array_mut().unwrap() {part["pose"]["y"]=json!(part["pose"]["y"].as_f64().unwrap()+delta as f64);}
        }
        match crate::game_construction::compile(&authored,catalogue) {
            Ok(result)=>{
                let chassis=&result["compiled"]["chassis"];
                if chassis["loadedKg"].as_f64().unwrap_or(0.0)<=SPARE*chassis["limitKg"].as_f64().unwrap_or(0.0) {return Ok(authored);}
                if gauge>=maximum {return Err("O projeto de fábrica não deixa margem de carga nessa estrutura.".into());}
            },
            Err(error)=>{
                if error["code"]!="CHASSIS_OVERLOAD" {return Ok(authored);}
                if gauge>=maximum {return Err(error.to_string());}
            },
        }
        gauge=((gauge*1.25*10.0).ceil()/10.0).min(maximum);
    }
    Err("O projeto de fábrica não cabe na capacidade dessa estrutura.".into())
}
/// The weapon a design is armed with: the one asked for, or its own.
fn preset<'a>(id:&str,options:&'a Value)->&'a str {
    options["preset"].as_str().filter(|s|!s.is_empty()).unwrap_or(match id {"heavy"=>"rh120","ifv"=>"m242","mortar"=>"m252",
        "howitzer"=>"m777","bunker"=>"mk44","outpost"=>"fnmag",_=>"m2hb"})
}
fn template_sensor_modes(id:&str,options:&Value,elevated:bool)->Result<Vec<String>,String> {
    let modes=if let Some(modes)=options.get("sensorModes").filter(|v|!v.is_null()) {
        modes.as_array().ok_or("Modos de sensores inválidos.")?.iter().map(|m|m.as_str().ok_or("Modo de sensor inválido.").map(str::to_owned))
            .collect::<Result<Vec<_>,_>>()?
    } else if id=="recon" {["visual","radar","sound"].into_iter().map(str::to_owned).collect()}
    else if elevated {["visual","sound"].into_iter().map(str::to_owned).collect()}
    else {vec!["visual".to_owned()]};
    for (i,mode) in modes.iter().enumerate() {
        if modes[..i].contains(mode) {return Err("Modos de sensores repetidos.".into());}
    }
    Ok(modes)
}
/// Ordinary running gear for the military hulls and industrial carriers. The road-truck family places its tandem
/// separately; all recipes use the same native frame capacity, suspension and physical floor admission.
fn factory_frame(id:&str,length:f64,armour_scale:f64,catalogue:&Value)->Result<Value,String> {
    let design=design(id).ok_or("Chassi de modelo desconhecido.")?;
    let model=design.model;let spec=&catalogue["chassis"][model];
    let (first,last)=(cell(-length/2.0),cell(length/2.0));
    let (front,rear)=(metres(first),metres(last));
    let base=spec[if model=="wheeled" {"wheel"}else{"track"}].as_f64().ok_or("Rodagem de modelo desconhecido.")?;
    let gear=fitted_gear(model,design.gear,spec)?;
    let mut frame=json!({"model":model,"points":[{"x":first,"y":0},{"x":last,"y":0}],"gearScale":gear/base,
        "topPlate":{"material":"steel","thicknessMm":rounded(design.armour[0]*armour_scale).max(Material::named("steel").unwrap().least_thickness())}});
    if matches!(id,"tracked"|"mining-truck"|"construction-truck"|"paver") {frame["thicknessMm"]=json!(12.0);}
    if let Some((count,ahead,behind))=design.axles {
        let(first,last)=(front+ahead.max(gear/2.0),rear-behind.max(gear/2.0));
        frame["axles"]=json!((0..count).map(|i|{let x=if id=="mortar" && i==1 {last-1.25}
            else{first+(last-first)*i as f64/(count-1) as f64};
            if i==0 {over(x)}else if i+1==count {-over(-x)}else{cell(x)}}).collect::<Vec<_>>());
    } else {
        // A band follows the actual frame length, with a short end overhang; it is not shortened to a whole
        // number of reference wheels. Native admission derives the ordinary road wheels from these endpoints.
        let maximum=ComponentKind::track_length(MAX_ROAD_WHEELS)*gear/ComponentKind::Track.dimensions().1;
        let width=(rear-front-0.2).min(maximum);
        let front=front+if id=="heavy"{0.05}else{0.1};
        frame["track"]=json!({"front":front/CELL,"rear":(front+width)/CELL,"y":(gear/2.0+0.01-1.3)/CELL});
    }
    Ok(frame)
}
fn draft(id:&str,options:&Value,catalogue:&Value,name:&str,chassis:Option<(&str,f64)>)->Result<Value,String> {
    if matches!(id,"chassis"|"truck"|"supply"|"tanker") {
        return road_truck(id,name,chassis.ok_or("Chassi de caminhão ausente.")?.1,options,catalogue);
    }
    if matches!(id,"tracked"|"mining-truck"|"construction-truck"|"paver") {
        return work_carrier(id,name,chassis.ok_or("Chassi de trabalho ausente.")?.1,options,catalogue);
    }
    let fixed=chassis.is_none();let design=design(id);
    let cab=design.and_then(|design|design.cab);
    let preset=preset(id,options);
    let family=catalogue["weapons"][preset]["family"].as_str().unwrap_or("");
    let dual=options["dual"].as_bool().unwrap_or(false);
    // Generator choice only: the authored construction still uses one normal
    // roof mount, its real enclosed receiver and the catalogued firing sector.
    let elevated=family=="howitzer" && options["highArc"].as_bool().unwrap_or(false);
    // Only the reconnaissance specialist pays for radar by default. Defences keep ordinary optics;
    // an elevated howitzer also listens. An explicit sensor recipe is authoritative, including an empty one.
    let modes=template_sensor_modes(id,options,elevated)?;
    let stretch=option_number(options,"stretch",1.0)?;let armour_scale=option_number(options,"armourScale",1.0)?;
    let engine_scale=option_number(options,"engineScale",1.0)?;
    // The machine-gun post is a compact intermediate defence; the autocannon bunker pays for a thicker front and
    // overhead concrete. Neither needs the expensive steel roof or radar of the old shared surveillance building.
    let length=chassis.map_or(if id=="outpost"{3.2}else{4.4}*stretch,|(_,length)|length);
    let height=if fixed{if id=="outpost"{1.6}else{2.1}}else if family=="mortar" && cab.is_none(){
        if id=="mortar" {design.unwrap().height}else{1.55}
    }else{design.unwrap().height};
    let armour=if id=="outpost"{[80.0,140.0,100.0,180.0,0.0]}
        else if fixed{[100.0,220.0,200.0,320.0,0.0]}else{design.unwrap().armour};
    // The outline of the hull, counter-clockwise from the lower front corner: its roof runs
    // from points[2] at the rear to points[3] at the front. A cab ends where the bed begins.
    let ahead=-length/2.0;
    let rear=cab.map_or(length/2.0,|cab|cab-length/2.0);
    let nose=design.map_or((0.0,0.0),|design|design.nose);
    let front_roof=if fixed || family=="mortar" {height}else{design.unwrap().front_roof};
    // Whether the roof behind its tower stays level over its engine (`Design::level_deck`).
    let level_deck=design.is_some_and(|design|design.level_deck);
    let mut points=vec![(ahead,0.0),(rear,0.0),
        (rear-if fixed || cab.is_some(){0.0}else if id=="mortar"{0.30}else{0.12},height),(ahead+nose.0,front_roof)];
    if !fixed {points.push((ahead,nose.1));}
    let labels=if fixed{&["floor","rear","roof","front"][..]}else{&["floor","rear","roof","glacis","front"][..]};
    let roof_x=|t:f64|points[2].0+(points[3].0-points[2].0)*t;
    // The outer corners where the roof meets the plate before it, which a gun lowered over the front of the hull
    // clears: the metal of either plate stands a half-thickness and a clearance proud of its line, and a clearance
    // past its node (game_construction.rs `plate_polygon`).
    let corners=[2,3].map(|i|{
        let (from,to)=(points[i],points[(i+1)%points.len()]);let length=(to.0-from.0).hypot(to.1-from.1);
        let (along,proud)=(((to.0-from.0)/length,(to.1-from.1)/length),rounded(armour[i]*armour_scale)/2000.0+CLEARANCE);
        let end=if i==2 {(to.0+along.0*CLEARANCE,to.1+along.1*CLEARANCE)} else {(from.0-along.0*CLEARANCE,from.1-along.1*CLEARANCE)};
        (end.0+along.1*proud,end.1-along.0*proud)
    });
    // What stands on the roof.
    let mut tower:Option<Tower>=None;
    // Where a gun stands on the roof of the hull, as a share of it from its rear, and how far its tube reaches over
    // the roof before it, laid down as far as its sector lets it.
    let mut roof_gun:Option<(f64,f64)>=None;
    // The room of a second weapon stands on the front of the roof, a hand of deck ahead of it.
    let support_x=roof_x(0.83).max(points[3].0+0.9);
    let mut parts=Equipment::new(catalogue,rounded(armour[0]*armour_scale));
    // Where the hull keeps its engine, its fuel, its command post and the reserves of its two weapons, in cells from
    // the middle of its floor. A hull as low as the Paladin's keeps them all on its floor and clear of the middle of
    // it, under the front of its tower, where the breech of the gun goes down as the gun is raised: the command post at
    // the front under the glacis, the fuel under the deck, the reserve of the gun behind the front foot of the tower,
    // the engine at the rear and the reserve of the second weapon ahead of it. The Paladin keeps the rounds of its gun
    // in the bustle of its tower. Under a level deck the engine stands a tenth of a metre nearer the rear, clear of
    // the rear foot of the tower on that deck.
    let low=height<1.0;
    let scale=design.map_or(1.0,|design|engine_size(design.power)*engine_scale);
    let cells=(1.05*scale/0.1-1e-9).ceil() as i64;let end=(length/0.2).floor() as i64;
    let front=|metres:f64|((-length/2.0+metres)/0.1-1e-9).ceil() as i64;
    let (engine,fuel,command,reserve,support_reserve)=if low {
        let foot=design.and_then(|design|design.tower).unwrap_or(nose.0+1.0);
        // Its fuel stands right behind the command visor, across the foot of the front of its tower; with plates thicker
        // than written, the metal of that front reaches too far down there over it, and it stands ahead of that foot.
        let fuel=if armour_scale>1.0 {((-length/2.0+foot-0.8)/0.1+1e-9).floor() as i64} else {front(foot-0.5)};
        ([end-cells-2,1],[fuel,1],[front(0.5),2],[front(foot+0.4),1],[end-cells-11,1])
    } else {([end-cells-if level_deck{1}else{2},2],if id=="mortar"{[front(0.4),1]}else{[1,if family=="mortar"{1}else{2}]},
        if fixed{[7,8]}else{[-12,10]},if id=="mortar"{[front(1.4),2]}else{[-16,2]},[-7,2])};
    // What stands where it is built has no engine, nor fuel for one.
    if cab.is_none() && !fixed {
        parts.inside("engine","engine",engine,json!({"sizeScale":scale}))?;
        parts.inside("fuel","fuel",fuel,Value::Null)?;
    }
    if cab.is_none() {
        parts.inside("command","command",command,Value::Null)?;
        if family.is_empty() {return Err("Armamento de modelo desconhecido.".into());}
        // How far the front of the tower leans back from upright: the support weapon stands in it as the gun does.
        let mut lean=0.0;
        if fixed || family=="mortar" {
            // The mortar keeps the middle of the whole roof. With a second weapon standing in its
            // own room on the front of that roof, the middle falls on the stretch behind the room.
            let (plate,t)=if fixed{("hull:front",0.5)}else if dual{
                ("hull:roof",(points[2].0-roof_x(0.5))/(points[2].0-support_x-0.8))}else{("hull:roof",0.5)};
            let weapon=&catalogue["weapons"][preset];
            if plate=="hull:roof" {
                roof_gun=Some((t,weapon["barrel"].as_f64().unwrap_or(0.0)*0.6f64.sin()+weapon["barrelRadius"].as_f64().unwrap_or(0.0)));
            }
            parts.gun("weapon",preset,plate,t,default_mount(family)?,
                json!({"min":if fixed{if family=="autocannon"{-0.5}else{-0.45}}else{-0.6},
                "max":if fixed{if family=="autocannon"{0.5}else{0.45}}else{0.6}}),if fixed{[3,3]}else{reserve})?;
            if id=="outpost" {
                // A few thousand machine-gun rounds, rather than a full-size vehicle magazine: a box with 0.27 of the
                // room of the reference one, 2 153 rounds of the MAG (`room_size`).
                parts.parts.last_mut().unwrap()["sizeScale"]=json!(room_size(0.274625));
            }
        } else {
            // The tower is as long as its family has it, or as the roof leaves with a hand at either end. An elevated
            // gun stands in the middle of a shorter one, its receiver upright, and leaves a deck behind it.
            let bay=bay(family)?;let paladin=family=="howitzer" && !elevated;
            let half=(if elevated {bay.length.min(2.6)} else {bay.length}).min(points[2].0-points[3].0-0.2)/2.0;
            let thickness=bay.armour.map(|mm|rounded(mm*armour_scale)/1000.0);
            let weapon=&catalogue["weapons"][preset];
            let ((width,depth),stroke)=(receiver_dimensions(weapon)?,Stroke::from_weapon(weapon)?);
            // An elevated gun stands its receiver upright under the roof of its tower, and under that the room its
            // recoil takes, both turned with it through its sector: the tower is as high as they reach down at the most,
            // with the clearance of either plate and a hand.
            let base_height=if elevated {
                let floor=rounded(armour[2]*armour_scale)/1000.0;
                let reach=(0..=120).map(|i|{let a=0.01*i as f64-0.6;
                    (width+stroke.at(elevation(PI/2.0+a)))*cos(a)+depth/2.0*sin(a).abs()}).fold(0.0,f64::max);
                ((inset(catalogue,preset,thickness[1])?+reach+floor/2.0+2.0*CLEARANCE+0.05)/0.05).ceil()*0.05
            } else {bay.height};
            let extra=if dual && !elevated{0.85}else{0.0};let bay_height=base_height+extra;
            // A front that leans back has the trunnion below and behind the face of its mount. It leans back by whole
            // cells over the height of the tower, as many as stay short of what its family has (the Paladin's 0.6 rad:
            // 0.597 over its 1.25 m), its foot on a whole cell, so that the gun is laid level at the top of its travel.
            lean=if elevated {0.0} else {atan2(((bay_height*sin(bay.lean)/cos(bay.lean))/CELL+1e-9).floor()*CELL,bay_height)};
            let (along,across)=(sin(lean)/cos(lean),inset(catalogue,preset,thickness[2])?);
            // The tower stands where its design has it, on the roof, a hand within its ends.
            let middle=design.and_then(|design|design.tower).map_or(roof_x(0.5),|foot|-length/2.0+foot+half)
                .min(points[2].0-0.1-half).max(points[3].0+0.1+half);
            let middle=if lean>0.0 {metres(cell(middle-half))+half} else {middle};
            let radius=weapon["barrelRadius"].as_f64().unwrap_or(0.0);
            let ring=if !elevated && !paladin {design.map_or(0.0,|design|design.ring)}else{0.0};
            // The tower of a tank gun stands open to the hull under it, and so does the Paladin's: raised, the breech
            // goes down through the ring. The trunnion stands at half the height of the tower, the Paladin's a little
            // lower: the shield over the port of its gun swings up as far over the trunnion as it swings down under it
            // and more, into the tower as the gun is raised, and its roof must stand clear of that. The Paladin's rear
            // stands upright on its bustle (`BUSTLE`), which juts out over the hull behind the foot it stands on. Any
            // other tower's rear leans in from its foot.
            let face=base_height*if paladin {0.42} else {0.5}+extra+across*sin(lean)-ring;
            let (foot,top)=((-half,-ring),(-half+bay_height*along,bay_height-ring));
            let built=if paladin {
                Tower{middle,outline:[foot,(half-BUSTLE.0,0.0),(half,bay_height),top],
                    armour:thickness.map(|m|m*1000.0),bustle:Some((half,BUSTLE.1)),open:true}
            } else {
                // Over a level deck its rear foot stands on that deck, its front sunk into its ring (`Design::level_deck`).
                Tower{middle,outline:[foot,(half,if level_deck {0.0} else {-ring}),(half-0.2,bay_height-ring),top],
                    armour:thickness.map(|m|m*1000.0),bustle:None,open:family=="cannon" || ring>0.0}
            };
            tower=Some(built);
            let trunnion=(middle+foot.0+(face-foot.1)*along+across*cos(lean),height+face-across*sin(lean));
            let sector=json!({"min":if elevated{-0.6}else{bay.min},
                "max":if elevated {0.6} else if lean>0.0 {lean.min(bay.max)} else {clear_depression(trunnion,&corners,radius,bay.max)}});
            // The Paladin keeps the rounds of its gun in the bustle of its tower [S], a hand behind where its breech runs
            // back to with the gun level, over the roof of its low hull. In a hull as high as a tank's that tower is
            // too short for them, and with a second weapon under it the gun stands so high that its breech keeps out
            // of the hull: they stay in the hull.
            let reserve=if paladin && low && !dual {
                let base=parts.floor;
                [((trunnion.0+width+stroke.long+0.1)/0.1).ceil() as i64,((height+0.05-base)/0.1).ceil() as i64]
            } else {reserve};
            parts.gun("weapon",preset,if elevated{"turret:roof"}else{"turret:front"},
                if elevated{0.5}else{(top.1-face)/(top.1-foot.1)},
                if paladin{"heavy-trunnion"}else{default_mount(family)?},sector,reserve)?;
        }
        if dual {
            let support=if preset=="m2hb"{"mk19"}else{"m2hb"};
            if !fixed && family=="mortar" {
                tower=Some(Tower{middle:support_x,outline:[(-0.8,0.0),(0.8,0.0),(0.6,0.8),(-0.8,0.8)],armour:[12.0,10.0,20.0],
                    bustle:None,open:false});
            }
            let (foot,front)=tower.map_or((0.0,0.0),|tower|(tower.middle+tower.outline[0].0,tower.armour[2]/1000.0));
            // Its trunnion stands 0.4 m over the floor of the tower; in a front that leans back, behind the face as
            // the gun's does, and its travel laid down from the normal of that front.
            let set_back=inset(catalogue,support,front)?;let floor=tower.map_or(0.0,|tower|tower.outline[0].1);
            let face=floor+0.4+set_back*sin(lean);
            let trunnion=(foot+(face-floor)*sin(lean)/cos(lean)+set_back*cos(lean),height+floor+0.4);
            let mount=default_mount(catalogue["weapons"][support]["family"].as_str().unwrap_or(""))?;
            let lowest=clear_depression(trunnion,&corners,catalogue["weapons"][support]["barrelRadius"].as_f64().unwrap_or(0.0),0.2);
            parts.gun("support-weapon",support,if fixed{"hull:front"}else{"turret:front"},
                if fixed{0.8}else{let tower=tower.unwrap();(tower.outline[3].1-face)/(tower.outline[3].1-floor)},mount,
                json!({"min":-0.35,"max":if fixed{0.2}else{(lean+lowest).min(catalogue["mounts"][mount]["max"].as_f64().unwrap_or(0.0))}}),support_reserve)?;
        }
    }
    // Choose the final equipment heights before drawing the Command visor or admitting a weapon sector.
    // These are initial factory poses on actual faces, not parent links or edit-time adjustments.
    let floor=rounded(armour[0]*armour_scale)/2000.0;
    if !fixed {for id in ["engine","fuel"] {parts.on_floor(id,(points[0].0,points[1].0),floor)?;}}
    if cab.is_none() {
        if !(family=="howitzer" && !elevated && low && !dual) {parts.on_floor("weapon-ammo",(points[0].0,points[1].0),floor)?;}
        if dual {parts.on_floor("support-weapon-ammo",(points[0].0,points[1].0),floor)?;}
    }
    if cab.is_some() {parts.on_box("command","engine")?;}
    else if fixed {parts.on_box("command","weapon-ammo")?;}
    else if !fixed {
        if low {parts.on_floor("command",(points[0].0,points[1].0),floor)?;}
        else {parts.on_box("command","weapon-ammo")?;}
    }
    // The mobile radar's smaller base envelope fits a continuous tower roof. Factory layout, collision, contact and
    // artwork use the same sensor catalogue; saved legacy installations retain their own dimensions and mass.
    // Where the sensors stand, with their installed dimensions and a gap (`GAP`) from the next. The
    // camera stands near the front of its roof, the tower's when there is one and the hull's otherwise: four fifths along
    // the roof of a tower, five sixths along that of a hull, three quarters along that of a cab, nine tenths along a fixed
    // roof, which is behind its lines, and at the front edge of a roof the gun stands on, raised on its tower, and of
    // the tower of a howitzer, which runs to the rear of the hull. What else there is stands on that roof behind the
    // camera while there is room: in the middle of what the camera leaves on the roof of a tower, clear of its edges;
    // right behind the camera on the tower of a howitzer, which leaves the rear of its roof the only place for a room;
    // and right behind the camera where a gun stands on the roof of a hull without a tower too, back to two thirds of it
    // or to where its tube reaches, the farther; nothing else where a gun stands raised on the roof of its tower, which
    // its long tube sweeps. The camera goes on to the
    // front edge when that makes the room. A sensor that finds none stands on the free roof behind the tower; what
    // else finds none, on the rear of the hull, one over the other from its top. Each is then laid on the first whole cell
    // clear of its plate (`Equipment::finish`).
    const GAP:f64=0.02;const END:f64=0.02;
    let size=|mode:&str|->Result<(f64,f64),String> {
        let mut part=json!({"sensorMode":mode});if mode=="radar" {part["radarModel"]=json!("mobile");}
        let(w,h,_)=sensor_dimensions(catalogue,&part).map_err(|error|error.to_string())?;Ok((w,h))
    };
    let camera=size("visual")?.0;
    let (roof,roof_length)=match tower {
        Some(tower)=>("turret:roof",tower.outline[2].0-tower.outline[3].0),
        None=>("hull:roof",points[2].0-points[3].0),
    };
    let edge=1.0-(END+camera/2.0)/roof_length;
    let (near,back,centred)=match tower {
        Some(_) if elevated=>(edge,roof_length,false),
        Some(_) if family=="howitzer"=>(edge,END,false),
        Some(_)=>(0.8,END,true),
        None if fixed=>(0.9,END,false),
        None if cab.is_some()=>(0.75,END,false),
        None=>(0.83,roof_gun.map_or(0.65*roof_length,|(t,reach)|(0.65*roof_length).max(t*roof_length+reach)),false),
    };
    // The stretch behind a camera at `t` of the roof, back to where the rest may stand.
    let room=|t:f64|t*roof_length-camera/2.0-GAP-back;
    let (mut on_roof,mut need)=(Vec::new(),-GAP);
    for (i,mode) in modes.iter().enumerate() {
        let width=size(mode)?.0;
        if mode!="visual" && need+GAP+width<=room(edge)+1e-9 {need+=GAP+width;on_roof.push(i);}
    }
    let first=if on_roof.is_empty() || room(near)>=need-1e-9 {near} else {edge};
    // The roof of the hull behind the tower, and how much of it stands clear of a bustle over it.
    let deck=tower.map_or(points[2].0-points[3].0,|tower|points[2].0-(tower.middle+tower.outline[1].0));
    let clear=tower.and_then(|tower|tower.bustle).map_or(deck,|bustle|points[2].0-(tower.unwrap().middle+bustle.0));
    let rear_length=(points[1].0-points[2].0).hypot(points[1].1-points[2].1);
    // How far a sensor reaches along the rear of the hull, which leans: as tall as it is, and a share of its width.
    let reach=|width:f64,height:f64|((points[1].0-points[2].0).abs()*width+(points[1].1-points[2].1).abs()*height)/rear_length;
    let (mut ahead,mut rear,mut deck_used)=(back+if centred{(room(first)+need)/2.0}else{room(first)},rear_length-END,0.0);
    let mut turret_sensors=Vec::new();
    for (i,mode) in modes.iter().enumerate() {
        let (width,height)=size(mode)?;
        let (plate,t)=if mode=="visual" {(roof,first)}
            else if on_roof.contains(&i) {ahead-=width+GAP;(roof,(ahead+GAP+width/2.0)/roof_length)}
            else if !fixed && clear-deck_used>=width+2.0*END-1e-9 {
                let t=(deck_used+END+width/2.0)/deck;deck_used+=width+GAP;("hull:roof",t)}
            else if rear-reach(width,height)>=END-1e-9 {let along=reach(width,height);rear-=along+GAP;("hull:rear",(rear+GAP+along/2.0)/rear_length)}
            else {return Err("Sem lugar para os sensores.".into())};
        let id=format!("sensor-{i}");if plate=="turret:roof" {turret_sensors.push(id.clone());}
        parts.on(&id,"sensor",plate,t,json!({"sensorMode":mode}));
    }
    // The command post keeps its own basic sight through an actual window, independent of optional sensors.
    // Use its real centre and the authored front face. A leftover shorter than the compiler's 8 cm stock becomes
    // glass up to that corner instead of an invalid sliver or an invisible opening. No extra internal camera is fitted.
    let vision=if fixed {None} else {
        let command=parts.parts.iter().find(|part|part["id"]=="command").ok_or("Comando de modelo inválido.")?;
        let height=read(&command["pose"]["y"]);
        let face=if height>=metres(cell(points[4].1)) {3}else{4};
        let actual=|point:(f64,f64)|(metres(cell(point.0)),metres(cell(point.1)));
        let (from,to)=(actual(points[face]),actual(points[(face+1)%points.len()]));
        if height<to.1 || height>from.1 || from.1-to.1<VISION.0 {return Err("O Comando não cabe atrás do visor de modelo.".into());}
        let mut lower=(height-VISION.0/2.0).max(to.1).min(from.1-VISION.0);
        let mut upper=lower+VISION.0;
        let along=(from.0-to.0).hypot(from.1-to.1)/(from.1-to.1);
        if (from.1-upper)*along<0.08 {upper=from.1;}
        if (lower-to.1)*along<0.08 {lower=to.1;}
        let at=|y:f64|(from.0+(y-from.1)*(to.0-from.0)/(to.1-from.1),y);
        Some((face,at(upper),at(lower)))
    };
    // Every corner is a node, and the feet of the tower divide the roof they stand on: the
    // stretch between them is the floor of the tower, one plate for both rooms.
    let corner=|i:usize|format!("hull-{i}");
    let mut nodes=points.iter().enumerate().map(|(i,(x,y))|node(&corner(i),*x,*y)).collect::<Vec<_>>();
    if let Some((_,upper,lower))=vision {
        for (id,at) in [("vision-top",upper),("vision-bottom",lower)] {nodes.push(json!({"id":id,"x":at.0/CELL,"y":at.1/CELL}));}
    }
    let (mut plates,mut walls)=(Vec::new(),Vec::new());
    for i in 0..points.len() {
        if !fixed && i==0 {continue;} // The chassis brings the one real floor, including the useful open bed.
        let side=|name:&str,a:&str,b:&str|plate(name,a,b,if fixed{"concrete"}else{"steel"},armour[i]*armour_scale);
        if let Some((_,upper,lower))=vision.filter(|(face,_,_)|*face==i) {
            let name=format!("hull:{}",labels[i]);
            if upper.1<metres(cell(points[i].1)) {plates.push(side(&name,&corner(i),"vision-top"));}
            plates.push(plate("hull:vision","vision-top","vision-bottom","glass",VISION.1));
            if lower.1>metres(cell(points[(i+1)%points.len()].1)) {plates.push(side(&format!("{name}-foot"),"vision-bottom",&corner((i+1)%points.len())));}
            continue;
        }
        let Some(tower)=tower.filter(|_|i==2) else {
            plates.push(side(&format!("hull:{}",labels[i]),&corner(i),&corner((i+1)%points.len())));continue;
        };
        let named=["turret-front","turret-rear","turret-top-rear","turret-top-front"].into_iter().zip(tower.outline)
            .chain(tower.bustle.into_iter().flat_map(|at|[("turret-bustle-front",(tower.outline[1].0,at.1)),("turret-bustle",at)]));
        for (name,(x,y)) in named {nodes.push(node(name,tower.middle+x,height+y));}
        plates.push(side("hull:roof",&corner(2),"turret-rear"));
        if !tower.open {plates.push(side("turret:floor","turret-rear","turret-front"));}
        plates.push(side("hull:deck","turret-front",&corner(3)));
        let [rear,roof,front]=tower.armour;
        if tower.bustle.is_some() {
            walls.extend([plate("turret:rear-lower","turret-rear","turret-bustle-front","steel",rear),
                plate("turret:bustle","turret-bustle-front","turret-bustle","steel",rear)]);
        }
        walls.push(plate("turret:rear",if tower.bustle.is_some() {"turret-bustle"} else {"turret-rear"},"turret-top-rear","steel",rear));
        walls.push(plate("turret:roof","turret-top-rear","turret-top-front","steel",roof));
        walls.push(plate("turret:front","turret-top-front","turret-front","steel",front));
    }
    plates.extend(walls);
    let mut authored=json!({"version":CONSTRUCTION_VERSION,"preset":if fixed{"bunker"}else{"vehicle"},"name":name,"seed":6173});
    match chassis {
        Some((_,length))=>{authored["chassis"]=factory_frame(id,length,armour_scale,catalogue)?;},
        None=>{},
    }
    authored["appearance"]=json!({"paint":if fixed{"#68765a"}else{design.unwrap().paint}});
    authored["nodes"]=json!(nodes);authored["plates"]=json!(plates);
    // A fixed one has its floor 15 cm over the floor of the construction box, as the other fixed models do; a
    // vehicle's is on its chassis.
    let mut authored=parts.finish(authored,0.15)?;
    // Each gun is given of the sector asked for it as much as the room behind it holds: it is laid no further than
    // where its breech, turned with it and run back as far as it recoils there, meets a plate or a part
    // (game_construction.rs `clear_sector`), to the milliradian within that; the gun first, then the second weapon.
    for id in ["weapon","support-weapon"] {
        let Some(i)=authored["components"].as_array().unwrap().iter().position(|part|part["id"]==id) else {continue;};
        let asked=&authored["components"][i]["mount"]["sector"];
        let wish=(asked["min"].as_f64().unwrap_or(0.0),asked["max"].as_f64().unwrap_or(0.0));
        let (min,max)=clear_sector(&authored,catalogue,id,wish).map_err(|error|error.to_string())?;
        let kept=|got:f64,wanted:f64,round:fn(f64)->f64|if got==wanted {wanted} else {round(got*1000.0)/1000.0};
        authored["components"][i]["mount"]["sector"]=json!({"min":kept(min,wish.0,f64::ceil),"max":kept(max,wish.1,f64::floor)});
    }
    if matches!(family,"cannon"|"autocannon") && tower.is_some() {cannon_roof(&mut authored,catalogue,&turret_sensors)?;}
    // Interior pieces retain these authored poses; the supported enclosure supplies their ordinary internal fixing.
    Ok(authored)
}
pub(crate) fn request(request:&Value)->Result<Value,String> {
    if request["version"]!=1 {return Err("Unsupported template request version".into());}
    source(request["id"].as_str().ok_or("Modelo de construção desconhecido.")?,
        request.get("options").unwrap_or(&json!({})),&request["catalogue"])
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::game_construction::{self,recoil};
    use std::f64::consts::PI;
    // The presets these designs are tried with.
    const WEAPONS:[&str;10]=["m2hb","fnmag","m242","rh120","at4","mk19","m252","m119","m224","m777"];
    pub(crate) fn create(id:&str,options:&Value,catalogue:&Value)->Result<Value,String> {
        Ok(game_construction::compile(&source(id,options,catalogue)?,catalogue).map_err(|error|error.to_string())?["construction"].clone())
    }
    pub(crate) fn fixture()->Value {
        json!({"catalogue":serde_json::from_str::<Value>(include_str!("../../construction-catalogue.json")).unwrap()})
    }
    fn equipment_box(source:&Value,catalogue:&Value,id:&str)->Result<Bounds,String> {
        let part=source["components"].as_array().and_then(|parts|parts.iter().find(|part|part["id"]==id)).ok_or("Peça de modelo inválida.")?;
        part_box(part,catalogue)
    }
    #[test]
    fn the_heavy_equipment_rests_on_real_faces_without_factory_standoffs() {
        let catalogue=fixture()["catalogue"].clone();let authored=source("heavy",&json!({}),&catalogue).unwrap();
        let command=authored["components"].as_array().unwrap().iter().find(|part|part["id"]=="command").unwrap();
        assert!((read(&command["pose"]["x"])+0.95).abs()<1e-9,"the factory keeps its horizontal layout");
        let result=game_construction::compile(&authored,&catalogue).unwrap();
        let plates=result["compiled"]["plates"].as_array().unwrap();let modules=result["compiled"]["modules"].as_array().unwrap();
        let floor=plates.iter().find(|plate|plate["id"]=="chassis:top-0").unwrap();
        assert!(!authored["plates"].as_array().unwrap().iter().any(|plate|plate["id"]=="hull:floor"));
        let face=floor["y"].as_f64().unwrap()+floor["thicknessMm"].as_f64().unwrap()/2000.0;
        for id in ["engine","fuel","weapon-ammo"] {
            let part=modules.iter().find(|part|part["id"]==id).unwrap();
            assert!((part["y"].as_f64().unwrap()-part["height"].as_f64().unwrap()/2.0-face).abs()<1e-9,"{id} stands on the true floor face");
        }
        let command=modules.iter().find(|part|part["id"]=="command").unwrap();let ammo=modules.iter().find(|part|part["id"]=="weapon-ammo").unwrap();
        assert!((command["y"].as_f64().unwrap()-command["height"].as_f64().unwrap()/2.0
            -ammo["y"].as_f64().unwrap()-ammo["height"].as_f64().unwrap()/2.0).abs()<1e-9);
    }
    #[test]
    fn current_authored_designs_compile_without_repairs_and_use_only_basic_sensors() {
        let catalogue=fixture()["catalogue"].clone();
        for item in catalogue["templates"].as_array().unwrap() {
            let id=item["id"].as_str().unwrap();
            let a=create(id,&json!({}),&catalogue).unwrap();
            assert_eq!(a,create(id,&json!({}),&catalogue).unwrap());
            assert_eq!(a["version"],CONSTRUCTION_VERSION);
            let radars=a["components"].as_array().unwrap().iter().filter(|part|part["sensorMode"]=="radar").count();
            assert_eq!(radars,usize::from(id=="recon"),"{id}: only the reconnaissance specialist has radar by default");
            for c in a["components"].as_array().unwrap() {
                assert!(c.get("placement").is_none(),"{id}: {c}");
                // Authored units stay 5 cm; exact physical contacts may use a fraction of one unit.
                assert!(c["pose"]["x"].as_f64().is_some_and(f64::is_finite) && c["pose"]["y"].as_f64().is_some_and(f64::is_finite)
                    && c["pose"]["angle"].as_f64().is_some_and(f64::is_finite),"{id}: {c}");
                if c["kind"]=="sensor" {assert!(matches!(c["sensorMode"].as_str(),Some("visual"|"radar"|"sound")));}
            }
            // What stands out in the open is held as it stands: on the metal it touches, or on its column to the metal
            // under or over it. No factory adds a plate to hold it.
            let compiled=game_construction::compile(&a,&catalogue).unwrap();
            for m in compiled["compiled"]["modules"].as_array().unwrap() {
                if matches!(m["kind"].as_str(),Some("sensor"|"blade"))&&m["exposed"]==true {assert!(m["support"].is_object(),"{id}: {}",m["id"]);}
            }
        }
        for id in ["scout","ifv","heavy"] {
            for preset in WEAPONS {
                let options=json!({"preset":preset});let before=options.clone();
                let a=create(id,&options,&catalogue).unwrap();assert_eq!(a,create(id,&options,&catalogue).unwrap());
                assert_eq!(options,before);
            }
        }
        assert!(create("other",&json!({}),&catalogue).is_err());
        for options in [json!({"preset":"unknown"}),json!({"sensorModes":["camera-track"]}),
            json!({"sensorModes":["radar-track"]}),json!({"stretch":"long"}),json!({"armourScale":0.01})] {
            assert!(create("heavy",&options,&catalogue).is_err(),"{options}");
        }
    }
    #[test]
    fn every_authored_design_sees_out_before_it_and_behind() {
        let catalogue=fixture()["catalogue"].clone();
        let radar_roof=|id:&str,result:&Value| {
            let radar=result["compiled"]["modules"].as_array().unwrap().iter().find(|part|part["sensorMode"]=="radar").unwrap();
            let roof=result["compiled"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]=="turret:roof").unwrap();
            assert_eq!((radar["width"].as_f64(),radar["height"].as_f64(),radar["physicalMass"].as_f64()),
                (Some(0.65),Some(0.546),Some(35.0)),"{id}: the mobile radar uses its real base envelope and mass");
            assert!((radar["y"].as_f64().unwrap()-radar["height"].as_f64().unwrap()/2.0-roof["y"].as_f64().unwrap()
                -roof["thicknessMm"].as_f64().unwrap()/2000.0).abs()<1e-9,"{id}: the continuous roof supports the antenna");
            let plate=result["construction"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]=="turret:roof").unwrap();
            assert_eq!((&plate["a"],&plate["b"]),(&json!("turret-top-rear"),&json!("turret-top-front")),"{id}: no radar recess");
            assert!(!result["construction"]["plates"].as_array().unwrap().iter().any(|plate|plate["id"].as_str().unwrap().starts_with("turret:radar-")));
            let radio=result["compiled"]["sights"].as_array().unwrap().iter().find(|sight|sight["mode"]=="radar").unwrap();
            assert_eq!((radio["range"].as_f64(),radio["left"].as_f64(),radio["right"].as_f64()),
                (Some(8000.0),Some(8000.0),Some(8000.0)),"{id}: both horizontal directions stay clear");
        };
        for item in catalogue["templates"].as_array().unwrap() {
            let id=item["id"].as_str().unwrap();
            let result=game_construction::compile(&source(id,&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
            let eyes=result["compiled"]["eyes"].as_array().unwrap();
            // The roof optic sees to both sides. A vehicle's Command looks ahead through its own real visor at its
            // basic range; no second internal optic supplies a free 4 km eye. A fixed Command can use a real gun port.
            if id=="empty" {assert!(eyes.is_empty());continue;}
            let reach:Vec<_>=eyes.iter().map(|eye|(eye["left"].as_f64().unwrap(),eye["right"].as_f64().unwrap())).collect();
            let vehicle=result["construction"]["preset"]=="vehicle";
            assert_eq!((reach.iter().filter(|r|**r==(4000.0,4000.0)).count(),reach.iter().filter(|r|**r==(4000.0,0.0)).count()),(1,0),"{id}: {eyes:?}");
            if vehicle && result["construction"]["chassis"]["model"]!="aircraft" {
                assert!(reach.contains(&(650.0,0.0)),"{id}: Command sees through its actual visor: {eyes:?}");
                assert!(reach.iter().all(|r|r.0==4000.0 || *r==(650.0,0.0)),"{id}: {eyes:?}");
            }
            assert_eq!(result["compiled"]["modules"].as_array().unwrap().iter().filter(|m|m["kind"]=="command").count(),1,"{id}");
            if id=="recon" {radar_roof(id,&result);}
            if matches!(id,"heavy"|"ifv"|"scout") {
                let roof=result["construction"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]=="turret:roof").unwrap();
                assert_eq!((&roof["a"],&roof["b"]),(&json!("turret-top-rear"),&json!("turret-top-front")),
                    "{id}: the real roof is continuous");
            }
        }
        // Optional radars use the same compact mounting, continuous roof and full detection performance.
        for id in ["heavy","ifv","scout"] {
            let authored=source(id,&json!({"sensorModes":["visual","radar"]}),&catalogue).unwrap();
            radar_roof(id,&game_construction::compile(&authored,&catalogue).unwrap());
        }
    }
    #[test]
    fn the_light_guard_post_sees_with_its_command_through_the_gun_port_only_while_that_port_is_open() {
        let catalogue=fixture()["catalogue"].clone();
        let authored=source("guard-post",&json!({}),&catalogue).unwrap();
        let reach=|source:&Value| {
            let result=game_construction::compile(source,&catalogue).unwrap();
            result["compiled"]["eyes"].as_array().unwrap().iter()
                .map(|eye|(eye["left"].as_f64().unwrap(),eye["right"].as_f64().unwrap())).collect::<Vec<_>>()
        };
        assert_eq!(reach(&authored),[(650.0,0.0),(4000.0,4000.0)]);
        let mut without_camera=authored.clone();
        without_camera["components"].as_array_mut().unwrap().retain(|part|part["kind"]!="sensor");
        assert_eq!(reach(&without_camera),[(650.0,0.0)]);
        // The opening is authored by the weapon: without that mounting the concrete front is shut again.
        let mut without_gun=authored.clone();
        without_gun["components"].as_array_mut().unwrap().retain(|part|part["kind"]!="weapon");
        assert_eq!(reach(&without_gun),[(4000.0,4000.0)]);
        without_gun["components"].as_array_mut().unwrap().retain(|part|part["kind"]!="sensor");
        assert!(reach(&without_gun).is_empty());
    }
    #[test]
    fn every_road_vehicle_command_sees_through_a_real_visor_without_an_optional_camera() {
        let catalogue=fixture()["catalogue"].clone();
        for item in catalogue["templates"].as_array().unwrap() {
            let id=item["id"].as_str().unwrap();
            let authored=source(id,&json!({}),&catalogue).unwrap();
            if authored["preset"]!="vehicle" || authored["chassis"]["model"]=="aircraft" {continue;}
            let plates=authored["plates"].as_array().unwrap();
            let glass=plates.iter().find(|p|p["id"]=="hull:vision").unwrap_or_else(||panic!("{id}: no vision block"));
            let node=|name:&str|read(&authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==name).unwrap()["y"]);
            let gauge=if matches!(id,"chassis"|"truck"|"supply"|"tanker"|"tracked"|"mining-truck"|"construction-truck"|"paver"){40.0}else if id=="grader"{60.0}else{90.0};
            assert_eq!((&glass["material"],glass["thicknessMm"].as_f64()),(&json!("glass"),Some(gauge)),"{id}");
            assert!(node(glass["a"].as_str().unwrap())-node(glass["b"].as_str().unwrap())>=0.15-1e-9,"{id}: actual finite glass");
            assert!(!authored["components"].as_array().unwrap().iter().any(|part|part["id"]=="sensor-vision"),"{id}: no duplicate internal camera");
            let mut blind=authored.clone();
            blind["components"].as_array_mut().unwrap().retain(|c|c["kind"]!="sensor");
            let result=game_construction::compile(&blind,&catalogue).unwrap_or_else(|e|panic!("{id}: {e}"));
            let sight=result["compiled"]["sights"].as_array().unwrap().iter().find(|sight|sight["id"]=="command").unwrap();
            assert_eq!((sight["range"].as_f64(),sight["left"].as_f64(),sight["right"].as_f64()),
                (Some(650.0),Some(650.0),Some(0.0)),"{id}: Command supplies only its basic physical sight");
            let glass=blind["plates"].as_array_mut().unwrap().iter_mut().find(|plate|plate["id"]=="hull:vision").unwrap();
            glass["material"]=json!("steel");
            let shut=game_construction::compile(&blind,&catalogue).unwrap_or_else(|e|panic!("{id}: {e}"));
            let sight=shut["compiled"]["sights"].as_array().unwrap().iter().find(|sight|sight["id"]=="command").unwrap();
            assert_eq!(sight["left"],0.0,"{id}: opaque metal closes the real visor");
        }
        let without_optics=source("scout",&json!({"sensorModes":[]}),&catalogue).unwrap();
        assert!(without_optics["components"].as_array().unwrap().iter().all(|part|part["kind"]!="sensor"));
        assert!(game_construction::compile(&without_optics,&catalogue).unwrap()["compiled"]["eyes"].as_array().unwrap().iter().any(|eye|eye["left"]==650.0));
    }
    #[test]
    fn the_haulers_carry_a_hopper_a_cistern_or_a_supply_piece_and_no_weapon() {
        let catalogue=fixture()["catalogue"].clone();
        // Each load is as big as gives it the room of one of 150 % or 160 % grown in all three axes, as it was sized
        // before its depth across the body stayed that of its kind: 3.375 and 4.096 times the room of one of 100 %.
        for (id,kind,room) in [("truck","hopper",3.375),("tanker","cistern",4.096),("supply","supply",4.096)] {
            let result=game_construction::compile(&source(id,&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
            let modules=result["compiled"]["modules"].as_array().unwrap();
            let count=|kind:&str|modules.iter().filter(|m|m["kind"]==kind).count();
            assert_eq!(result["construction"]["components"].as_array().unwrap().iter().find(|c|c["kind"]==kind).unwrap()["sizeScale"],room_size(room));
            assert!(modules.iter().find(|m|m["kind"]==kind).unwrap()["capacityM3"].as_f64().unwrap()>4.0);
            assert_eq!((count("hopper")+count("cistern")+count("supply"),count("weapon"),count("ammo"),count("wheel")),(1,0,0,if id=="tanker"{4}else{3}));
            assert_eq!((count("engine"),count("fuel"),count("command"),count("sensor")),(1,1,1,1));
            // The load rides on the bed behind the cab, over a rear tandem; the tanker also has a second front axle.
            let load=modules.iter().find(|m|m["kind"]==kind).unwrap();
            assert_eq!(load["exposed"].as_bool(),Some(true),"{id}");
            let floor=result["compiled"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]=="chassis:top-0").unwrap();
            let face=floor["y"].as_f64().unwrap()+floor["thicknessMm"].as_f64().unwrap()/2000.0;
            assert!((load["y"].as_f64().unwrap()-load["height"].as_f64().unwrap()/2.0-face).abs()<1e-9,
                "{id}: the load touches the upper face of the real chassis floor");
            assert_eq!(result["compiled"]["chassis"]["model"],"wheeled");
        }
    }
    #[test]
    fn the_trucks_wear_the_owners_cab_a_low_bonnet_and_a_short_windscreen_between_steel() {
        let catalogue=fixture()["catalogue"].clone();
        for id in ["chassis","truck","supply","tanker","tracked","mining-truck"] {
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let at=|name:&str|{let n=authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==name).unwrap_or_else(||panic!("{id}: {name}"));(read(&n["x"]),read(&n["y"]))};
            let plate=|name:&str|authored["plates"].as_array().unwrap().iter().find(|p|p["id"]==name).unwrap_or_else(||panic!("{id}: {name}")).clone();
            let near=|a:f64,b:f64|(a-b).abs()<1e-9;
            let (front,floor)=at("hull-0");let cab=at("hull-1").0;
            assert!(near(cab-front,design(id).unwrap().cab.unwrap()),"{id}: the cab ends where its design has it, the deck behind it as it was");
            // The cab, 1.7 m long and 1.85 m tall: its rear upright, its roof flat, as the owner drew them.
            let (back,top,roof,hood)=(at("hull-2"),at("hull-3"),at("hull-3").1-floor,at("hood-back"));
            assert!(near(back.0,cab) && near(back.1,top.1) && near(roof,1.85) && near(cab-top.0,1.45) && near(cab-hood.0,1.7),"{id}");
            // The windscreen: 0.35 m of glass, 40 mm, nearly upright, between a sloped brow of steel under the roof and a
            // sloped foot of steel down to the bonnet.
            let (glass,brow,foot)=(plate("hull:vision"),plate("hull:glacis"),plate("hull:glacis-foot"));
            assert_eq!((&glass["material"],glass["thicknessMm"].as_f64(),&glass["a"],&glass["b"]),(&json!("glass"),Some(40.0),&json!("vision-top"),&json!("vision-bottom")),"{id}");
            assert_eq!((&brow["material"],&brow["a"],&brow["b"]),(&json!("steel"),&json!("hull-3"),&json!("vision-top")),"{id}");
            assert_eq!((&foot["material"],&foot["a"],&foot["b"]),(&json!("steel"),&json!("vision-bottom"),&json!("hood-back")),"{id}");
            let (upper,lower)=(at("vision-top"),at("vision-bottom"));
            assert!(near(upper.1-floor,1.5) && near(lower.1-floor,1.15),"{id}: the glass from 1.15 to 1.5 m");
            assert!((upper.0-lower.0)/(upper.1-lower.1)<0.3 && upper.0<top.0 && lower.0<upper.0 && hood.0<lower.0,"{id}: leaning back a little from the bonnet to the roof");
            // The bonnet: low, rising 0.15 m from its nose back to the foot of the cab, well under the windscreen.
            let (nose,brim)=(at("hull-4"),at("hood-front"));
            assert!(near(nose.0,front) && near(nose.1-floor,0.65) && near(brim.1-floor,0.8) && near(hood.1-floor,0.95),"{id}");
            assert!(hood.1<lower.1 && hood.1+0.8<top.1,"{id}: the bonnet stands well under the cab");
            // The engine under the bonnet, the fuel and the command in the cab.
            let box_=|part:&str|equipment_box(&authored,&catalogue,part).unwrap();
            let (engine,fuel,command)=(box_("engine"),box_("fuel"),box_("command"));
            assert!(engine.min_x>front && engine.min_x<hood.0 && engine.max_y<brim.1,"{id}: the engine under the bonnet");
            assert!(fuel.min_x>hood.0 && fuel.max_x<cab && command.min_x>top.0 && command.max_x<fuel.min_x,"{id}: the command and the tank in the cab");
            assert!(command.min_y<upper.1 && command.max_y>lower.1,"{id}: the command looks out through the windscreen");
            // His finish: the crew door with its small window in the cab, the grille upright in the nose.
            let details=authored["appearance"]["details"].as_array().unwrap();
            let door=details.iter().find(|d|d["kind"]=="armour-door").unwrap_or_else(||panic!("{id}: no cab door"));
            assert!(!details.iter().any(|d|matches!(d["kind"].as_str(),Some("cab-door"|"industrial-door"))),"{id}");
            let grille=details.iter().find(|d|d["kind"]=="engine").unwrap();
            let result=game_construction::compile(&authored,&catalogue).unwrap();
            let kept=|wanted:&Value|result["construction"]["appearance"]["details"].as_array().unwrap().iter().find(|d|d["id"]==wanted["id"]).unwrap().clone();
            let (door,grille)=(kept(door),kept(grille));
            assert!(door["x"].as_f64().unwrap()-door["width"].as_f64().unwrap()/2.0>hood.0 && door["x"].as_f64().unwrap()+door["width"].as_f64().unwrap()/2.0<cab,"{id}: the door in the cab: {door}");
            assert!((grille["angle"].as_f64().unwrap().abs()-PI/2.0).abs()<1e-9 && grille["x"].as_f64().unwrap()-front<0.05,"{id}: the grille upright in the nose: {grille}");
            assert_eq!(details.iter().filter(|d|d["kind"]=="cab-step").count(),match id {"tanker"=>0,"tracked"|"mining-truck"=>1,_=>2},"{id}");
        }
        // The constructor and the paver keep their glazed cab ahead of the engine.
        for id in ["construction-truck","paver"] {
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let glass=authored["plates"].as_array().unwrap().iter().find(|p|p["id"]=="hull:vision").unwrap();
            assert_eq!((&glass["b"],authored["appearance"]["details"][0]["kind"].as_str()),(&json!("vision-bottom"),Some("industrial-door")),"{id}");
            let x=|name:&str|read(&authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==name).unwrap()["x"]);
            assert!(x("vision-bottom")<=x("hull-0")+1e-9,"{id}: its glass down at its front");
        }
    }
    #[test]
    fn the_starter_miner_carries_one_excavator_and_a_separate_hopper_on_tracks() {
        let catalogue=fixture()["catalogue"].clone();
        let authored=source("mining-truck",&json!({}),&catalogue).unwrap();
        let result=game_construction::compile(&authored,&catalogue).unwrap();
        let chassis=&result["compiled"]["chassis"];
        assert_eq!(chassis["model"],"tracked");
        assert_eq!(chassis["thicknessMm"].as_f64(),Some(12.0));
        assert!(chassis["limitKg"].as_f64().unwrap()>0.0);
        let loaded=chassis["loadedKg"].as_f64().unwrap();
        assert!(loaded<14_000.0,"the mining carrier remains light enough with its full iron load: {loaded}");
        assert!(loaded>chassis["emptyKg"].as_f64().unwrap() && loaded<=SPARE*chassis["limitKg"].as_f64().unwrap(),"{chassis}");
        let modules=result["compiled"]["modules"].as_array().unwrap();
        let mut kinds:Vec<_>=modules.iter().map(|m|m["kind"].as_str().unwrap()).collect();
        kinds.sort_unstable();
        assert_eq!(kinds,vec!["command","engine","excavator","fuel","hopper","sensor","track"]);
        let hopper=modules.iter().find(|m|m["kind"]=="hopper").unwrap();
        let excavator=modules.iter().find(|m|m["kind"]=="excavator").unwrap();
        assert!(hopper["capacityM3"].as_f64().unwrap()>1.0);
        for piece in [hopper,excavator] {
            assert_eq!(piece["exposed"].as_bool(),Some(true));
            assert_eq!(piece["angle"].as_f64(),Some(0.0));
        }
        let back=hopper["x"].as_f64().unwrap()+hopper["width"].as_f64().unwrap()/2.0;
        let front=excavator["x"].as_f64().unwrap()-excavator["width"].as_f64().unwrap()/2.0;
        assert!(front-back>0.09,"the excavation equipment stays clear of the hopper");
    }
    #[test]
    fn the_motor_grader_hangs_its_blade_between_its_axles_and_the_paver_lays_from_the_rear_of_its_bed() {
        let catalogue=fixture()["catalogue"].clone();
        let made=|id:&str|game_construction::compile(&source(id,&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
        let number=|v:&Value,key:&str|v[key].as_f64().unwrap();
        for id in ["grader","paver"] {
            let result=made(id);let modules=result["compiled"]["modules"].as_array().unwrap();
            let count=|kind:&str|modules.iter().filter(|m|m["kind"]==kind).count();
            assert_eq!((count("weapon"),count("ammo"),count("engine"),count("command"),count("blade")+count("paver")),(0,0,1,1,1),"{id}");
            let chassis=&result["compiled"]["chassis"];
            assert!(number(chassis,"loadedKg")<=SPARE*number(chassis,"limitKg"),"{chassis}");
            // Its engine works it at the full pace.
            let machine=modules.iter().find(|m|m["kind"]=="blade" || m["kind"]=="paver").unwrap();
            assert_eq!(machine["exposed"],true,"{id}");
            assert!(number(&result["compiled"]["powertrain"],"powerKw")>=number(machine,"workKw"),"{id}");
            assert_eq!(game_construction::compile(&result["construction"],&catalogue).unwrap(),result,"{id}");
        }
        // The grader: six wheels, the cab over the tandem, the blade from the front axle to the tandem, clear of both, as
        // a Cat 140's, hung from the neck over the gap of its chassis; an engine of 180 kW, on a frame of 8 mm.
        let grader=made("grader");let chassis=&grader["compiled"]["chassis"];
        assert_eq!((chassis["model"].as_str(),number(chassis,"thicknessMm")),(Some("wheeled"),8.0));
        assert!((number(&grader["compiled"]["powertrain"],"powerKw")-180.0).abs()<1e-6);
        let axles:Vec<f64>=grader["construction"]["chassis"]["axles"].as_array().unwrap().iter().map(read).collect();
        assert_eq!(axles.len(),3);
        let blade=grader["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["kind"]=="blade").unwrap();
        assert_eq!(number(blade,"workKw"),150.0);
        let (x,w)=(number(blade,"x")-12.0,number(blade,"width"));
        let clear=number(chassis,"wheelDiameter")/2.0;
        assert!(x-w/2.0>axles[0]+clear && x+w/2.0<axles[1]-clear,"the blade at {x} between {axles:?}");
        assert!(axles[2]-axles[1]<axles[1]-axles[0],"the rear two axles are a tandem");
        let cab=grader["construction"]["nodes"].as_array().unwrap().iter().map(|n|read(&n["x"])).fold(f64::MIN,f64::max);
        assert!(cab>axles[2],"the cab stands over the tandem");
        // Its chassis leaves a gap under the neck, from the push block to the cab, that the neck bears: lighter than
        // a whole one, it carries no less.
        assert_eq!((&chassis["segments"][1]["gap"],&chassis["segments"][1]["a"]["x"]),(&json!(true),&json!(12.0-2.9)));
        let mut whole=source("grader",&json!({}),&catalogue).unwrap();
        let deck=whole["chassis"]["points"][0]["y"].clone();
        whole["chassis"]["points"]=json!([{"x":cell(-3.8),"y":deck},{"x":cell(4.4),"y":deck}]);
        // The blade hangs by its lift group from the neck, through that gap: no plate of its own holds it, and the
        // neck is one plate. It is admitted as it is made.
        let support=&blade["support"];
        assert_eq!(support["host"],"bay-2:under");
        assert!((number(support,"reach")-1.421).abs()<1e-9 && number(support,"mass")>0.0,"{support}");
        assert!(!grader["construction"]["plates"].as_array().unwrap().iter().any(|plate|plate["id"].as_str().unwrap().starts_with("support")));
        assert_eq!(grader["construction"]["plates"].as_array().unwrap().iter().filter(|plate|plate["id"].as_str().unwrap().starts_with("bay-2:under")).count(),2);
        let built=game_construction::request(&json!({"version":1,"construction":grader["construction"],"catalogue":catalogue,"manufacture":{}})).unwrap();
        assert_eq!(built["compiled"]["admissionIssues"],json!([]));
        // Filling the gap, the blade hangs from the rail of the chassis over it instead, a shorter way.
        let whole=game_construction::compile(&whole,&catalogue).unwrap();
        let hung=&whole["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["kind"]=="blade").unwrap()["support"];
        assert!(hung["host"].as_str().unwrap().starts_with("chassis:"),"{hung}");
        assert!(number(hung,"reach")<number(support,"reach"),"{hung}");
        let whole=&whole["compiled"]["chassis"];
        assert!(number(chassis,"frameKg")<number(whole,"frameKg"));
        assert_eq!(number(chassis,"frameLimitKg"),number(whole,"frameLimitKg"),"the rails bear less than the neck");
        assert!(number(chassis,"limitKg")>=number(whole,"limitKg"),"{} {}",number(chassis,"limitKg"),number(whole,"limitKg"));
        // The paver: on tracks with an engine of 500 kW, the paver at the very rear of the bed and no supply piece — what it
        // lays rides in the hopper built into its paver, the mix of 45 m of asphalt, which its chassis carries full.
        let paver=made("paver");let parts=paver["compiled"]["modules"].as_array().unwrap();
        assert_eq!(paver["compiled"]["chassis"]["model"],"tracked");
        assert!((number(&paver["compiled"]["powertrain"],"powerKw")-500.0).abs()<1e-6);
        assert!(!parts.iter().any(|m|m["kind"]=="supply" || m["kind"]=="hopper"),"it carries nothing but in its paver");
        let machine=parts.iter().find(|m|m["kind"]=="paver").unwrap();
        assert_eq!(number(machine,"workKw"),120.0);
        let rear=number(&paver["compiled"]["chassis"],"rear");
        assert!((number(machine,"x")+number(machine,"width")/2.0-rear).abs()<1e-9,"flush with the rear end");
        let room=number(machine,"capacityM3");
        assert!((room/crate::game_geometry::mix_volume()-45.0).abs()<1e-9,"the mix of 45 m of asphalt: {room} m³");
    }
    #[test]
    fn the_tanker_pumps_with_a_drill_behind_its_cistern_and_the_oil_well_stands_with_its_own_engine_and_tank() {
        let catalogue=fixture()["catalogue"].clone();
        let tanker=game_construction::compile(&source("tanker",&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
        let modules=tanker["compiled"]["modules"].as_array().unwrap();
        let (cistern,drill)=(modules.iter().find(|m|m["kind"]=="cistern").unwrap(),modules.iter().find(|m|m["kind"]=="drill").unwrap());
        assert_eq!(drill["exposed"].as_bool(),Some(true));
        let back=cistern["x"].as_f64().unwrap()+cistern["width"].as_f64().unwrap()/2.0;
        assert!(drill["x"].as_f64().unwrap()-drill["width"].as_f64().unwrap()/2.0-back>0.09,"the drill stays clear of the cistern");
        let chassis=&tanker["compiled"]["chassis"];
        assert!(chassis["loadedKg"].as_f64().unwrap()<=SPARE*chassis["limitKg"].as_f64().unwrap(),"{chassis}");
        // Its engine turns its drill at the full pace: it gives more than the drill asks.
        assert_eq!(drill["workKw"].as_f64(),Some(150.0));
        assert!(tanker["compiled"]["powertrain"]["powerKw"].as_f64().unwrap()>=drill["workKw"].as_f64().unwrap());
        let well=game_construction::compile(&source("oil-well",&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
        assert_eq!((&well["construction"]["preset"],well["construction"].get("chassis")),(&json!("bunker"),None));
        let mut kinds:Vec<_>=well["compiled"]["modules"].as_array().unwrap().iter().map(|m|m["kind"].as_str().unwrap()).collect();
        kinds.sort_unstable();
        assert_eq!(kinds,vec!["command","drill","engine","fuel","sensor"]);
        let part=|kind:&str|well["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["kind"]==kind).unwrap();
        assert!(part("engine")["powerKw"].as_f64().unwrap()>=part("drill")["workKw"].as_f64().unwrap());
        assert!(well["compiled"]["sights"].as_array().unwrap().iter().any(|sight|sight["left"].as_f64().unwrap()>0.0),"it sees ahead");
    }
    #[test]
    fn every_fixed_model_stands_15_cm_over_the_floor_of_the_construction_box() {
        // As the foot of a wheel stands a centimetre over it: the whole box is over what they are built on, three cells.
        let catalogue=fixture()["catalogue"].clone();
        for id in ["guard-post","bunker","outpost","oil-well","mining-site"] {
            let design=source(id,&json!({}),&catalogue).unwrap();
            let lowest=design["nodes"].as_array().unwrap().iter().map(|node|node["y"].as_f64().unwrap()).fold(f64::INFINITY,f64::min);
            assert!((lowest-(game_construction::FLOOR+3) as f64).abs()<1e-12,"{id}: {lowest}");
        }
    }
    #[test]
    fn field_construction_models_use_ordinary_static_geometry_and_a_separate_supply_piece() {
        let catalogue=fixture()["catalogue"].clone();
        let guard=game_construction::compile(&source("guard-post",&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
        assert_eq!(guard["construction"]["preset"],"bunker");
        assert!(guard["construction"].get("chassis").is_none());
        let parts=guard["compiled"]["modules"].as_array().unwrap();
        assert!(parts.iter().any(|part|part["kind"]=="command"));
        assert!(parts.iter().any(|part|part["weaponPreset"]=="minimi"));
        assert!(!parts.iter().any(|part|matches!(part["kind"].as_str(),Some("engine"|"fuel"|"wheel"|"track"))));
        for id in ["bunker","outpost"] {
            let fixed=game_construction::compile(&source(id,&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
            assert!(!fixed["compiled"]["modules"].as_array().unwrap().iter().any(|part|matches!(part["kind"].as_str(),Some("engine"|"fuel"))),"{id}");
        }
        let price=crate::game_cost::construction(&guard["compiled"],&catalogue).unwrap()["total"].as_f64().unwrap();
        assert!(price>0.0 && price<7000.0,"a first defence fits one ordinary supply load: {price}");
        let builder=game_construction::compile(&source("construction-truck",&json!({}),&catalogue).unwrap(),&catalogue).unwrap();
        assert_eq!(builder["compiled"]["chassis"]["model"],"tracked");
        let chassis=&builder["compiled"]["chassis"];
        assert!(chassis["loadedKg"].as_f64().unwrap()<=SPARE*chassis["limitKg"].as_f64().unwrap());
        let parts=builder["compiled"]["modules"].as_array().unwrap();
        assert_eq!(parts.iter().filter(|part|part["kind"]=="builder").count(),1);
        assert_eq!(parts.iter().filter(|part|part["kind"]=="supply").count(),1);
        assert!(!parts.iter().any(|part|matches!(part["kind"].as_str(),Some("weapon"|"ammo"|"excavator"|"drill"))));
        // Its engine turns its arm at the full pace.
        let arm=parts.iter().find(|part|part["kind"]=="builder").unwrap()["workKw"].as_f64().unwrap();
        assert!((arm-110.0).abs()<1e-9 && builder["compiled"]["powertrain"]["powerKw"].as_f64().unwrap()>=arm);
    }
    #[test]
    fn elevated_howitzers_and_frontal_variants_use_the_same_canonical_mount_admission() {
        let catalogue=fixture()["catalogue"].clone();
        for id in ["scout","ifv","heavy","howitzer"] {
            for preset in WEAPONS {
                for dual in [false,true] {for high in [false,true] {
                    let options=json!({"preset":preset,"dual":dual,"highArc":high,
                        "sensorModes":["visual","radar","sound"]});
                    let authored=source(id,&options,&catalogue).unwrap_or_else(|error|panic!("{id}/{preset}/dual={dual}/high={high}: {error}"));
                    let result=game_construction::compile(&authored,&catalogue)
                        .unwrap_or_else(|error|panic!("{id}/{preset}/dual={dual}/high={high}: {error}"));
                    assert_eq!(game_construction::compile(&result["construction"],&catalogue).unwrap(),result);
                    let chassis=&result["compiled"]["chassis"];
                    assert!(chassis["loadedKg"].as_f64().unwrap()<=SPARE*chassis["limitKg"].as_f64().unwrap(),
                        "{id}/{preset}/dual={dual}/high={high}: the admitted armament retains its full-payload margin");
                    let gun=result["compiled"]["modules"].as_array().unwrap().iter()
                        .find(|m|m["id"]=="weapon").unwrap();
                    let elevated=high && catalogue["weapons"][preset]["family"]=="howitzer";
                    if elevated {
                        // Its tower holds its breech through the whole travel of its mount; a second weapon standing
                        // in the front of that tower may cut it short to one side, where the breech meets it.
                        let (min,max)=(gun["weaponMount"]["min"].as_f64().unwrap(),gun["weaponMount"]["max"].as_f64().unwrap());
                        assert_eq!(gun["weaponMount"]["preset"],"elevated-trunnion");
                        assert!(if dual {min>=-0.6 && min<0.0 && max==0.6} else {(min,max)==(-0.6,0.6)},"{id}/{preset}/dual={dual}: {min} {max}");
                        assert!((gun["angle"].as_f64().unwrap()-std::f64::consts::FRAC_PI_2).abs()<1e-12);
                        // The receiver hangs under the trunnion and its recoil below it, turned with the gun: at the
                        // deepest they reach through that travel, a hand over the floor of the tower.
                        let weapon=&catalogue["weapons"][preset];
                        let ((width,height),stroke)=(receiver_dimensions(weapon).unwrap(),Stroke::from_weapon(weapon).unwrap());
                        let reach=(0..=120).map(|i|{let a=0.01*i as f64-0.6;
                            (width+stroke.at(elevation(PI/2.0+a)))*cos(a)+height/2.0*sin(a).abs()}).fold(0.0,f64::max);
                        let roof=read(&result["construction"]["nodes"][2]["y"]);
                        let floor=result["construction"]["plates"].as_array().unwrap().iter().find(|p|p["id"]=="turret:floor").unwrap();
                        let trunnion=gun["y"].as_f64().unwrap()-result["compiled"]["frame"]["origin"]["y"].as_f64().unwrap();
                        let spare=trunnion-reach-roof-floor["thicknessMm"].as_f64().unwrap()/2000.0;
                        assert!(spare>CLEARANCE && spare<CLEARANCE+0.15,"{id}/{preset}/dual={dual}: {spare}");
                    }
                }}
            }
        }
        for preset in ["m119","m777"] {for high in [false,true] {
            for (stretch,armour) in [(0.94,0.55),(1.06,1.35)] {
                let options=json!({"preset":preset,"highArc":high,"dual":true,
                    "stretch":stretch,"armourScale":armour,"sensorModes":["visual","radar","sound"]});
                for id in ["scout","ifv","heavy","howitzer"] {
                    create(id,&options,&catalogue).unwrap_or_else(|error|panic!("{id}/{options}: {error}"));
                }
            }
        }}
        // The Paladin lays its gun in the leaning front of its tower, its breech turned with it; the high arc is the
        // generator's choice.
        let mount=|options:Value|source("howitzer",&options,&catalogue).unwrap()["components"].as_array().unwrap()
            .iter().find(|part|part["id"]=="weapon").unwrap()["mount"].clone();
        assert_eq!(mount(json!({}))["preset"],"heavy-trunnion");
        assert!(mount(json!({})).get("receiverAngle").is_none());
        assert_eq!(mount(json!({"highArc":true}))["preset"],"elevated-trunnion");
    }
    #[test]
    fn the_gun_of_the_heavy_tank_overhangs_its_nose_as_the_l44_of_the_leopard_2_does() {
        let catalogue=fixture()["catalogue"].clone();
        for options in [json!({}),json!({"armourScale":1.35}),json!({"stretch":1.06})] {
            let authored=source("heavy",&options,&catalogue).unwrap();
            let result=game_construction::compile(&authored,&catalogue).unwrap();
            let gun=result["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["id"]=="weapon").unwrap();
            if options["armourScale"]==1.35 {
                let(roof,_,half)=support_wall(&authored,"turret:roof").unwrap();
                assert!((half-0.017).abs()<1e-12,"the reinforced roof retains all 34 mm of armour");
                let feet=gun["materialPolygons"].as_array().unwrap()[2..4].iter().flat_map(|polygon|polygon.as_array().unwrap());
                let top=gun["y"].as_f64().unwrap()-1.3+feet.map(|point|point["y"].as_f64().unwrap()).fold(f64::NEG_INFINITY,f64::max);
                assert!((roof.1-half-top).abs()<1e-8,"only the actual fixed-base deficit raises the turret roof");
                assert!((equipment_box(&authored,&catalogue,"sensor-0").unwrap().min_y-roof.1-half).abs()<1e-9,
                    "the camera keeps its real foot on the raised roof");
            }
            let origin=result["compiled"]["frame"]["origin"]["x"].as_f64().unwrap();
            let nose=authored["nodes"].as_array().unwrap().iter().map(|n|read(&n["x"])).fold(f64::INFINITY,f64::min)+origin;
            // The barrel laid level towards the front: 4.25 m from the trunnion to the muzzle, 1.95 m past the nose
            // of a Leopard 2A4 [D].
            let muzzle=gun["x"].as_f64().unwrap()-catalogue["weapons"]["rh120"]["barrel"].as_f64().unwrap();
            assert!((1.5..=2.0).contains(&(nose-muzzle)),"{options}: {}",nose-muzzle);
            // It is laid from 20 degrees up to 9 down, clear of the plates before it.
            assert_eq!((gun["weaponMount"]["min"].as_f64(),gun["weaponMount"]["max"].as_f64()),
                (Some(-20f64.to_radians()),Some(9f64.to_radians())),"{options}");
        }
        // The front of its deck raised 30 cm, six cells, stands in the sweep of the long barrel laid down, so nearly along
        // it that the port it would need there does not fit on it: refused.
        let mut raised=source("heavy",&json!({}),&catalogue).unwrap();
        let corner=raised["nodes"].as_array_mut().unwrap().iter_mut().find(|n|n["id"]=="hull-3").unwrap();
        corner["y"]=json!(corner["y"].as_f64().unwrap()+6.0);
        let error=game_construction::compile(&raised,&catalogue).unwrap_err();
        assert_eq!((&error["code"],&error["ids"]),(&json!("MOUNT_PORT"),&json!(["hull:deck","weapon"])),"{error}");
    }
    #[test]
    fn the_breech_of_a_tank_gun_or_of_the_paladins_goes_down_through_the_ring_of_a_tower_with_no_floor() {
        let catalogue=fixture()["catalogue"].clone();
        for id in ["heavy","howitzer"] {
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let plates=authored["plates"].as_array().unwrap();
            assert!(plates.iter().all(|p|p["id"]!="turret:floor"),"{id}");
            game_construction::compile(&authored,&catalogue).unwrap_or_else(|e|panic!("{id}: {e}"));
            // Given a floor across the ring, its breech meets that short of the travel asked of the gun: the Leopard's
            // between 10 and 20 degrees up. The floor is laid at the depth of the front foot of the tower: under a rear
            // foot standing on a level deck (`Design::level_deck`), from the foot of a wall down from that one.
            let mut floored=authored.clone();
            let at=plates.iter().position(|p|p["id"]=="hull:roof").unwrap()+1;
            let roof=plates[at-1]["thicknessMm"].clone();
            let node=|id:&str|authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==id).unwrap().clone();
            let (rear,front)=(node("turret-rear"),node("turret-front"));
            let steel=|id:&str,a:&str,b:&str|json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":roof});
            let floor=if rear["y"]==front["y"] {vec![steel("turret:floor","turret-rear","turret-front")]} else {
                floored["nodes"].as_array_mut().unwrap().push(json!({"id":"ring-rear","x":rear["x"],"y":front["y"]}));
                vec![steel("turret:ring-rear","turret-rear","ring-rear"),steel("turret:floor","ring-rear","turret-front")]
            };
            for (i,plate) in floor.into_iter().enumerate() {floored["plates"].as_array_mut().unwrap().insert(at+i,plate);}
            let error=game_construction::compile(&floored,&catalogue).unwrap_err();
            assert_eq!(error["code"],"BREECH_PLATE");assert_eq!(error["surface"],"floor");
            assert!(error["ids"].as_array().unwrap().contains(&json!("turret:floor")));
            if id=="heavy" {assert!((10..20).contains(&error["angleDegrees"].as_i64().unwrap()));}
        }
    }
    #[test]
    fn a_gun_is_laid_no_further_than_where_its_breech_meets_a_plate_or_a_part() {
        let catalogue=fixture()["catalogue"].clone();
        // Exact factory contact changes the old whole-cell angle. The actual boundary must still admit the gun
        // and reject another 0.01 rad against a real plate/component, with full recoil, host and capacity rules.
        for (id,options) in [("howitzer",json!({"preset":"m119"})),("scout",json!({"preset":"m777"}))] {
            let authored=source(id,&options,&catalogue).unwrap();
            let at=authored["components"].as_array().unwrap().iter().position(|c|c["id"]=="weapon").unwrap();
            let min=authored["components"][at]["mount"]["sector"]["min"].as_f64().unwrap();
            let accepted=game_construction::compile(&authored,&catalogue).unwrap_or_else(|e|panic!("{id}: {e}"));
            // Keep the collision probe inside the unchanged mount capacity: exact contact can leave <0.01rad spare.
            let preset=authored["components"][at]["mount"]["preset"].as_str().unwrap();
            let capacity_min=catalogue["mounts"][preset]["min"].as_f64().unwrap();
            let extension=0.01_f64.min((min-capacity_min)/2.0);
            assert!(extension>0.0,"{id}: a physical breech boundary must leave a positive probe inside its mount range");
            let mut further=authored.clone();
            further["components"][at]["mount"]["sector"]["min"]=json!(min-extension);
            let error=game_construction::compile(&further,&catalogue).unwrap_err();
            assert!(["BREECH_PLATE","BREECH_COMPONENT"].contains(&error["code"].as_str().unwrap_or("")),"{id}: {error}");
            let ids=error["ids"].as_array().expect("a physical breech blocker identifies its actual parts");
            let parts=accepted["compiled"]["plates"].as_array().unwrap().iter().chain(accepted["compiled"]["modules"].as_array().unwrap());
            assert!(ids.iter().any(|id|id!="weapon" && parts.clone().any(|part|part["id"]==*id)),"{id}: {error}");
            // Capacity is a separate refusal; it cannot stand in for the physical collision above.
            let mut beyond=authored.clone();beyond["components"][at]["mount"]["sector"]["min"]=json!(capacity_min-0.01);
            let hard=game_construction::compile(&beyond,&catalogue).unwrap_err();
            assert_eq!((&hard["code"],&hard["field"],&hard["within"],&hard["range"][0]),
                (&json!("FIELD"),&json!("min"),&json!("mount.sector"),&json!(capacity_min)),"{id}: {hard}");
        }
    }
    #[test]
    fn the_howitzer_is_drawn_after_the_paladin_and_its_tower_holds_the_whole_recoil_of_its_gun() {
        let catalogue=fixture()["catalogue"].clone();
        for preset in ["m777","m119"] {for stretch in [1.0,0.94,1.06] {
            let authored=source("howitzer",&json!({"preset":preset,"stretch":stretch}),&catalogue).unwrap_or_else(|error|panic!("{preset}/{stretch}: {error}"));
            let result=game_construction::compile(&authored,&catalogue).unwrap_or_else(|e|panic!("{preset}/{stretch}: {e}"));
            assert_eq!(result["compiled"]["chassis"]["model"],"tracked");
            let gun=result["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["id"]=="weapon").unwrap();
            let mount=&gun["weaponMount"];
            // The front of the tower leans back by whole cells nearly 0.6 rad: the gun is laid from level to 68 degrees
            // up, a little short of the whole travel of its mount where its trunnion stands on a whole cell, the M119,
            // which recoils as far at any angle, to where its breech meets the floor of the hull short of that.
            let cells=|id:&str|{let n=authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==id).unwrap();(read(&n["x"]),read(&n["y"]))};
            let (foot,top)=(cells("turret-front"),cells("turret-top-front"));
            let lean=atan2(top.0-foot.0,top.1-foot.1);
            assert!(lean>0.59 && lean<=0.6,"{preset}/{stretch}: {lean}");
            let elevation=|offset:f64|PI-gun["angle"].as_f64().unwrap()-offset;
            assert!(elevation(mount["max"].as_f64().unwrap()).abs()<1e-6,"{preset}/{stretch}: level");
            let highest=elevation(mount["min"].as_f64().unwrap());
            assert!(if preset=="m777" {highest>1.18 && highest<lean+0.6+1e-6} else {highest>1.1 && highest<1.2},"{preset}/{stretch}: {highest}");
            assert!(mount.get("receiverAngle").is_none());
            // Its breech turns with it, and laid level it recoils as far as it can, inside the tower, clear of its
            // upright rear, which stands on a bustle jutting 0.35 m out level behind the foot of the tower 0.4 m over
            // the roof.
            let weapon=&catalogue["weapons"][preset];
            let reach=receiver_dimensions(weapon).unwrap().0+Stroke::from_weapon(weapon).unwrap().long;
            assert!((mount["recoil"].as_f64().unwrap()-recoil(weapon).unwrap()).abs()<1e-12);
            let origin=result["compiled"]["frame"]["origin"]["x"].as_f64().unwrap();
            let node=|id:&str|{let n=authored["nodes"].as_array().unwrap().iter().find(|n|n["id"]==id).unwrap();
                (read(&n["x"])+origin,read(&n["y"]))};
            let (foot,bustle,top)=(node("turret-rear"),node("turret-bustle"),node("turret-top-rear"));
            assert!((bustle.0-foot.0-0.35).abs()<1e-6 && (bustle.1-foot.1-0.4).abs()<1e-6 && (top.0-bustle.0).abs()<1e-6,"{preset}/{stretch}");
            let step=node("turret-bustle-front");
            assert!((step.0-foot.0).abs()<1e-6 && (step.1-bustle.1).abs()<1e-6,"{preset}/{stretch}");
            let breech=gun["x"].as_f64().unwrap()+reach;
            assert!(breech<top.0,"{preset}/{stretch}: the recoil ends at {breech}, the tower at {}",top.0);
            // Its rounds ride in the bustle, behind where the breech runs back to.
            let rounds=result["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["id"]=="weapon-ammo").unwrap();
            assert!(rounds["x"].as_f64().unwrap()-rounds["width"].as_f64().unwrap()/2.0>breech,"{preset}/{stretch}: {rounds}");
            // The Paladin's hull, 6.19 m long [S], over a track from its nose nearly to its tail: on as many road
            // wheels as fit along it, leaving a short overhang of the hull at either end.
            let track=result["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["kind"]=="track").unwrap();
            let size=|key:&str|track[key].as_f64().unwrap();
            let chassis=&result["compiled"]["chassis"];
            let (front,length)=(chassis["front"].as_f64().unwrap(),chassis["length"].as_f64().unwrap());
            let short=front+length-size("x")-size("width")/2.0;
            assert!((size("x")-size("width")/2.0-front-0.1).abs()<1e-9 && (short-0.1).abs()<1e-9,"{preset}/{stretch}: {short}");
            if stretch==1.0 {assert_eq!(ComponentKind::road_wheels(size("width"),size("height")),7.0);}
        }}
    }
    #[test]
    fn every_vehicle_is_written_on_the_chassis_of_its_design_as_long_as_its_hull() {
        let catalogue=fixture()["catalogue"].clone();
        for item in catalogue["templates"].as_array().unwrap() {
            let id=item["id"].as_str().unwrap();
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let result=game_construction::compile(&authored,&catalogue).unwrap();
            let (written,chassis)=(&result["construction"]["chassis"],&result["compiled"]["chassis"]);
            if result["construction"]["preset"]=="vehicle" {
                assert!(written["topPlate"].is_object(),"{id}: one physical chassis floor");
                assert!(authored["plates"].as_array().unwrap().iter().all(|plate|plate["id"]!="hull:floor"),"{id}: no duplicate floor");
                if written["model"]!="aircraft" {
                    assert!(!result["compiled"]["rooms"].as_array().unwrap().is_empty(),"{id}: the chassis floor really closes the body");
                }
            }
            let Some(design)=design(id) else {
                // The motor grader is drawn as a whole (`grader`), its chassis from the nose of its outline to its tail;
                // what stands where it is built has none.
                if id=="grader" {
                    let xs=authored["nodes"].as_array().unwrap().iter().map(|n|n["x"].as_f64().unwrap());
                    let points=written["points"].as_array().unwrap();
                    let first=xs.clone().fold(f64::INFINITY,f64::min);let last=xs.fold(f64::NEG_INFINITY,f64::max);
                    assert_eq!((points[0]["x"].as_f64(),points[points.len()-1]["x"].as_f64()),(Some(first),Some(last)));
                } else if written["model"]!="aircraft" {
                    assert!(written.is_null() && chassis.is_null() && result["compiled"]["beds"]==json!([]),"{id}");
                }
                continue;
            };
            assert_eq!(written["model"],design.model,"{id}");
            let points=written["points"].as_array().unwrap();
            assert_eq!((points.len(),points[0]["x"].as_i64(),points[1]["x"].as_i64()),
                (2,Some(cell(-design.length/2.0)),Some(cell(design.length/2.0))),"{id}");
            // The side boundary meets the generated floor's exact centre line, including fractional authored units.
            let floor=authored["nodes"].as_array().unwrap().iter().find(|node|node["id"]=="hull-0").unwrap()["y"].as_f64().unwrap();
            let gauge=written["topPlate"]["thicknessMm"].as_f64().unwrap();
            assert!(points.iter().all(|p|((floor-p["y"].as_f64().unwrap())*CELL-gauge/2000.0).abs()<1e-12),"{id}: the actual lower surface contacts the chassis");
            // A factory design writes its actual uniform size and every support,
            // with no geometric profile hidden behind a model name.
            let told=&authored["chassis"];
            let base=catalogue["chassis"][design.model][if design.model=="wheeled" {"wheel"} else {"track"}].as_f64().unwrap();
            let gear=fitted_gear(design.model,design.gear,&catalogue["chassis"][design.model]).unwrap();
            assert!(gear<=design.gear+1e-9 && design.gear-gear<CELL,"{id}: a track fitted to the deck is no larger than its design, by less than a cell");
            assert_eq!(told["gearScale"].as_f64(),Some(gear/base),"{id}");
            assert!(told.get(if design.axles.is_some() {"axles"} else {"track"}).is_some(),"{id}");
            assert_eq!((chassis["model"].as_str(),chassis["length"].as_f64()),(Some(design.model),Some(design.length)),"{id}");
            assert!(chassis["loadedKg"].as_f64().unwrap()<=SPARE*chassis["limitKg"].as_f64().unwrap(),"{id}: {chassis}");
            // A cab is still the authored short enclosure at the front; a hull
            // covers the whole frame. Neither claims the remaining deck as an
            // installation permission or a saved free-space projection.
            let rear=authored["nodes"].as_array().unwrap().iter().find(|node|node["id"]=="hull-1").unwrap()["x"].as_i64().unwrap();
            assert_eq!(rear,cell(design.cab.map_or(design.length/2.0,|cab|cab-design.length/2.0)),"{id}");
        }
    }
    #[test]
    fn factory_payload_margins_hold_across_model_dimensions_and_armour_choices() {
        let catalogue=fixture()["catalogue"].clone();
        for item in catalogue["templates"].as_array().unwrap() {
            let id=item["id"].as_str().unwrap();
            // Weapon, mount and payload combinations belong to the strict armament matrix above.
            // Probe dimensions and armour independently instead of crossing both matrices and counting successes.
            let options=[json!({}),json!({"sensorModes":["visual","radar","sound"]}),
                json!({"stretch":0.94,"armourScale":0.55}),json!({"stretch":1.06,"armourScale":1.35}),
                json!({"stretch":1.0,"armourScale":1.35})];
            let default=source(id,&json!({}),&catalogue).unwrap();
            if default.get("chassis").is_none() {continue;}
            let mut tried=0;
            for options in options {
                // A combination the design does not take (a plate too thin, two mounts in one place) is no
                // question of weight.
                let Ok(authored)=source(id,&options,&catalogue) else {continue};
                let chassis=match game_construction::compile(&authored,&catalogue) {
                    Ok(result)=>result["compiled"]["chassis"].clone(),
                    Err(error)=>{assert!(!(error["code"]=="CHASSIS_OVERLOAD"),"{id} {options}: {error}");continue},
                };
                if chassis.is_null() {continue;}
                tried+=1;
                let (loaded,limit)=(chassis["loadedKg"].as_f64().unwrap(),chassis["limitKg"].as_f64().unwrap());
                assert!(loaded<=SPARE*limit,"{id} {options}: {loaded} of {limit} on {}",chassis["model"]);
            }
            assert!(tried>0,"{id}: at least its stock design must be checked");
        }
        // A heavier factory weapon reinforces the same authored chassis instead
        // of selecting a hidden class or lengthening the scout's hull.
        for preset in ["m2hb","rh120","m777"] {
            let authored=source("scout",&json!({"preset":preset}),&catalogue).unwrap();
            let chassis=&authored["chassis"];
            assert_eq!(chassis["model"],"wheeled","{preset}");
            let points=chassis["points"].as_array().unwrap();
            assert_eq!((points.len(),points[0]["x"].as_i64(),points[1]["x"].as_i64()),(2,Some(-48),Some(48)),"{preset}");
            assert_eq!(points[0]["y"],points[1]["y"],"{preset}");
            assert!(chassis["thicknessMm"].as_f64().unwrap()>=catalogue["chassis"]["wheeled"]["frameMm"].as_f64().unwrap(),"{preset}");
        }
    }
    #[test]
    fn factory_designs_write_their_actual_gear_sizes_and_supports_without_geometric_profiles() {
        let catalogue=fixture()["catalogue"].clone();
        for (id,ends,count,diameter) in [("scout",[-1.7,1.65],2,0.95),("recon",[-1.65,1.6],3,1.1),
            ("chassis",[-2.3,2.4],3,1.25),("truck",[-2.5,2.6],3,1.25),("supply",[-2.5,2.6],3,1.25),("tanker",[-3.0,3.1],4,1.25)] {
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let admitted=game_construction::compile(&authored,&catalogue).unwrap();
            let chassis=&admitted["compiled"]["chassis"];
            assert_eq!(chassis["model"],"wheeled","{id}");
            assert!((chassis["wheelDiameter"].as_f64().unwrap()-diameter).abs()<1e-12,"{id}");
            let axles=chassis["axles"].as_array().unwrap();
            assert_eq!(axles.len(),count,"{id}");
            assert_eq!(authored["chassis"]["axles"].as_array().unwrap().len(),count,"{id}");
            assert!((axles.first().unwrap().as_f64().unwrap()-12.0-ends[0]).abs()<1e-9,"{id}");
            assert!((axles.last().unwrap().as_f64().unwrap()-12.0-ends[1]).abs()<1e-9,"{id}");
        }
        // Each fitted to the deck of its model on a whole cell (`fitted_gear`): a few centimetres under its design.
        let spec=&catalogue["chassis"]["tracked"];
        for (id,height) in [("heavy",1.02),("ifv",0.98),("mining-truck",0.7)].map(|(id,gear)|(id,fitted_gear("tracked",gear,spec).unwrap())) {
            let authored=source(id,&json!({}),&catalogue).unwrap();
            let admitted=game_construction::compile(&authored,&catalogue).unwrap();
            let chassis=&admitted["compiled"]["chassis"];
            assert_eq!(chassis["model"],"tracked","{id}");
            assert!((chassis["track"]["height"].as_f64().unwrap()-height).abs()<1e-12,"{id}");
            assert!(authored["chassis"]["track"].is_object(),"{id}");
            let (first,last,y)=(read(&authored["chassis"]["track"]["front"]),read(&authored["chassis"]["track"]["rear"]),read(&authored["chassis"]["track"]["y"]));
            assert!((chassis["track"]["rear"].as_f64().unwrap()-chassis["track"]["front"].as_f64().unwrap()-(last-first)).abs()<1e-12,"{id}: literal physical endpoints");
            assert!((chassis["track"]["y"].as_f64().unwrap()-(1.3+y)).abs()<1e-12,"{id}: literal physical centre");
            assert!((y+1.3-height/2.0-0.01).abs()<1e-12,"{id}: the factory band rests on the floor");
            if id=="heavy" {
                let profile=1.3+read(&authored["chassis"]["points"][0]["y"]);
                assert!((last-first-6.8).abs()<1e-12 && (profile-factory_deck(&authored,&catalogue).unwrap()+0.15).abs()<1e-12,
                    "the body keeps its lower suspension position about the grounded band");
            }
        }
    }
}
