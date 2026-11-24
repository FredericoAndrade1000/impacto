//! Pure canonical authoring compiler. No world, control, sensor or RNG access.
//! The result is a read-only projection, not authoring or runtime snapshot input.
//! Fresh mechanics use this same compiler. Projections are never scenes.
use crate::game_damage::{Material, MassProperties, polygon_properties};
use crate::game_sensors::{Armour, SensorMode, outlooks_as_written};
use crate::game_geometry::{BarrelProfile, Bounds, ComponentKind, MaterialGrid, Point, Polygon,
    Pose, atan2, cos, hypot, rectangle, sin, sqrt};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashSet};
use std::f64::consts::PI;

#[path = "game_chassis.rs"]
mod chassis;
use chassis::Chassis;

pub(crate) const CLEARANCE: f64 = 0.015;
pub(crate) const EPS: f64 = 1e-7;
/// How far, in metres, two plates written that share no end may stand in each other (`Frame::meet`): a millimetre,
/// what is left of two faces laid one against the other by the arithmetic that put them there.
const TOUCH: f64 = 0.001;
/// How far the metal of two plates written that share an end may run into each other along either of them, from that
/// end, as so many times the sum of their half thicknesses (`Frame::meet`): the corner of the joint. Two plates of one
/// thickness open to 28° or more there, a thin one against a thick one to 30°.
const CORNER: f64 = 2.0;
/// How wide every construction is, across the side view, in metres. Nobody authors it.
pub(crate) const BODY_WIDTH: f64 = 2.4;
pub(super) const CONSTRUCTION_ORIGIN: Point = Point::new(12.0,1.3);
/// The length of one authored coordinate unit, in metres. Positions may stand between the workshop's optional snap
/// lines. Stock extensions and counts remain discrete; compiled geometry is always in metres.
pub(crate) const CELL: f64 = 0.05;
/// A whole number of cells in metres: divided by the cells in a metre, so that it reads as the nearest double to the
/// decimal it is.
pub(crate) fn metres(cells:i64)->f64 {cells as f64/(1.0/CELL)}
/// A point written in cells, in metres.
pub(super) fn at_units(x:f64,y:f64)->Point {Point::new(x/(1.0/CELL),y/(1.0/CELL))}
/// The construction box, in cells, the same for every design and fixed in the local reference: `REACH` to either side
/// of the reference and `HEIGHT` up from the workshop floor, `FLOOR` (`CONSTRUCTION_ORIGIN` under the reference), which
/// the running gear stands on (`Chassis::gear`) however large it is and wherever the chassis runs. Nodes and the points
/// of a chassis are written in it; no piece goes under its floor, and equipment stands out of it only to the sides and
/// over it.
pub(super) const REACH: i64 = 120;
pub(super) const FLOOR: i64 = -26;
/// How much more than an aircraft weighs with all it holds full its thrusters push up with at the least, to climb and to
/// steer with what is left (`Chassis::lifted`): a quarter more, which climbs at 2.4 m/s² straight up.
pub(crate) const LIFT_MARGIN: f64 = 1.25;
pub(super) const HEIGHT: i64 = 160;
/// How far from the reference equipment may stand, in cells, either way.
const POSE_REACH: i64 = 240;
/// The step a thruster is turned in, in the hull: an eighth of a turn.
const THRUSTER_TURN: f64 = PI / 4.0;
/// How far a plate may run past either of its nodes, in cells.
const STOCK: i64 = 30;
/// Nodes and plates a construction may be written with.
const LIMIT: usize = 64;
/// The version of what is written: a design of another is not read. Raised whenever what is written changes.
pub const CONSTRUCTION_VERSION: u32 = 10;
fn contract() -> Value {
    json!({"compilerVersion":CONSTRUCTION_VERSION,"constructionVersion":CONSTRUCTION_VERSION,"pure":true,"mechanicalAdmission":true,"drafts":true,"physicalSupport":true,
        "authoring":"grid-node-plate-v10","projection":"read-only-derived-v1"})
}

pub fn request(value: &Value) -> Result<Value,Value> {
    fields(value,&["version","construction","catalogue","draft","manufacture","placement"])?;
    if value["version"] != 1 {return Err(reject("REQUEST_VERSION"));}
    let draft=match value.get("draft") {Some(value)=>value.as_bool().ok_or_else(||reject("DRAFT_MODE"))?,None=>false};
    if let Some(placement)=value.get("placement") {
        if value.get("manufacture").is_some(){return Err(reject("REQUEST_PLACEMENT"));}
        let catalogue=with_variants(&value["construction"],&value["catalogue"])?;
        let (source,component)=seat_weapon(&value["construction"],&catalogue,placement)?;
        return compile_mode(&source,&value["catalogue"],draft).map_err(|mut error|{error["placement"]=component;error});
    }
    match value.get("manufacture") {
        Some(site) if site.is_object()=>compile_for(&value["construction"],&value["catalogue"],draft,Some(site)),
        Some(_)=>Err(reject("SUPPORT_SITE")),
        None=>compile_mode(&value["construction"],&value["catalogue"],draft),
    }
}

/// The ammunition each calibre on a construction is fed. The guns of one calibre are fed one, so that the boxes
/// of it carry rounds of one weight; guns made over fire the rounds of their cartridge (game_variant.rs `cartridge`).
fn fed_ammunition<'a>(components:impl IntoIterator<Item=&'a Value>,catalogue:&Value)->Result<BTreeMap<String,String>,Value> {
    let mut fed=BTreeMap::<String,String>::new();
    for (i,component) in components.into_iter().enumerate().filter(|(_,c)|c["kind"]=="weapon") {
        let preset=named(component,"weaponPreset","rh120").map_err(|e|listed("component","components",i,component,e))?;
        let first=catalogue["weapons"][preset]["allowedAmmo"][0].as_str();
        let Some(ammo)=component.get("weaponAmmo").map_or(first,Value::as_str) else {continue};
        // It is told with the ammunition the other gun of its calibre is fed.
        if let Some(other)=fed.insert(crate::game_variant::cartridge(preset),ammo.to_owned()).filter(|other|other!=ammo) {
            let refusal=json!({"code":"AMMUNITION_MISMATCH","field":"weaponAmmo","value":ammo,"accepted":[other]});
            return Err(listed("component","components",i,component,refusal));
        }
    }
    Ok(fed)
}
/// How far the gun `id` of a design, in a room, may be laid from the axis of its mount within `wish`, `(min, max)`,
/// before its breech, with the recoil it has at each elevation, meets the metal of a plate and its clearance or another
/// part: from the angle of the wish nearest that axis out to either end, a degree at a time and then a twentieth of
/// one. What a design is given honestly: the template does not ask more of a gun than the room behind it holds. Every
/// part stands where it is written.
pub(crate) fn clear_sector(input:&Value,catalogue:&Value,id:&str,wish:(f64,f64))->Result<(f64,f64),Value> {
    let (frame,_)=framed(input,catalogue)?;
    let components=array(input,"components",48)?;
    let fed=fed_ammunition(components.iter(),catalogue)?;
    // The angles of the sector by whole degrees from its rest, the nearest first.
    let rest=0.0f64.clamp(wish.0,wish.1);
    let steps=((wish.1-wish.0)/STROKE_STEP).ceil() as i64;
    let angles:Vec<f64>=(0..=steps).flat_map(|k|[rest-k as f64*STROKE_STEP,rest+k as f64*STROKE_STEP])
        .filter(|a|(wish.0..=wish.1).contains(a)).collect();
    let (mut owner,mut others,mut gun)=(frame.plates.len() as u32+1,Vec::new(),None);
    for component in components {
        if component["id"]==id {
            // Where the gun stands does not hang on its sector: it stands there with the sector asked for it, or,
            // where its breech meets a plate within that, held at the first angle from its rest where it does not.
            let mut part=component.clone();
            let mut placed=position(&part,&frame,catalogue,owner,&fed);
            for &angle in &angles {
                if placed.is_ok() {break;}
                part["mount"]["sector"]=json!({"min":angle,"max":angle});
                placed=position(&part,&frame,catalogue,owner,&fed);
            }
            gun=Some((placed?,part));
        } else {others.push(position(component,&frame,catalogue,owner,&fed)?);}
        owner+=1;
    }
    let Some((Placed{occupancy:Occupancy::Weapon(mount),..},part))=gun else {return Err(reject("UNKNOWN_WEAPON"));};
    let weapon=&catalogue["weapons"][part["weaponPreset"].as_str().unwrap_or("")];
    let ((width,height),stroke)=(receiver_dimensions(weapon).map_err(|_|reject("WEAPON_RECEIVER"))?,Stroke::from_weapon(weapon).map_err(|_|reject("WEAPON_RECOIL_CUTOFF"))?);
    // The breech at an angle as long as it recoils at the lowest elevation within a step of the sector either side of
    // that, which is as long as the compiler holds it however it cuts the sector (`breech`), and met where the compiler
    // meets it.
    let blocked=|angle:f64| {
        let recoil=stroke.at(lowest(mount.pose.angle+angle-STROKE_STEP,mount.pose.angle+angle+STROKE_STEP));
        let shape=Bounds{min_x:-width-recoil,max_x:0.0,min_y:-height/2.0,max_y:height/2.0};
        let posed:Vec<Point>=corners(shape).iter().map(|&p|mount.pose.world_point(rotate(p,angle))).collect();
        frame.plates.iter().any(|plate|intersection_area(&posed,&frame.solid(plate,CLEARANCE))>EPS*EPS)
            || others.iter().any(|other|match &other.occupancy {
                Occupancy::Fixed(polygon)=>intersection_area(polygon,&posed)>EPS*EPS,Occupancy::Weapon(gun)=>gun.intersects(&posed)})
    };
    // From the angle nearest its rest where the breech stands clear, the gun is laid as far either way as it stays so.
    let Some(start)=angles.iter().copied().find(|&angle|!blocked(angle)) else {
        return Err(reject("BREECH_BLOCKED"));
    };
    let reach=|end:f64| {
        let toward=|from:f64,step:f64|if end>=start {(from+step).min(end)} else {(from-step).max(end)};
        let mut clear=start;
        while clear!=end {
            let next=toward(clear,PI/180.0);
            if blocked(next) {
                loop {let finer=toward(clear,PI/3600.0);if finer==next || blocked(finer) {return clear;} clear=finer;}
            }
            clear=next;
        }
        end
    };
    Ok((reach(wish.0),reach(wish.1)))
}

/// Raw authoring and read-only projections are no scene: load_game admits actual scenes only.
pub(crate) fn require_runtime_admission(value: &Value) -> Result<(),String> {
    if value["canonicalVersion"] == CONSTRUCTION_VERSION || value["version"] == CONSTRUCTION_VERSION || value["derived"]==true
        || value["mechanicalAdmission"] == false
        || value["modules"].as_array().is_some_and(|a| a.iter().any(|m| m.get("weaponMount").is_some()))
            && (!value["actors"].is_array() || !value["plates"].is_array())
    {
        return Err("Canonical construction: authoring/projection is not an admitted scene".into());
    }
    Ok(())
}

fn reject(code:&str)->Value {json!({"code":code})}
// Context enriches the refusal at its origin; neither host recovers IDs from diagnostic prose.
fn context(kind:&str,name:&str,mut error:Value)->Value {
    match kind {
        "field"|"chassis"=>error[if kind=="field" {"field"} else {"model"}]=json!(name),
        _=>{
            let key=if kind=="node" {"nodeIds"} else {"ids"};
            let ids=error.as_object_mut().unwrap().entry(key).or_insert_with(||json!([])).as_array_mut().unwrap();
            if !ids.iter().any(|id|id==name) {ids.push(json!(name));}
        },
    }
    error
}
// A refusal of what is written says which key it is and what was written for it (`value`), when it was; a host tells
// the player from those, and from what the key takes: a number within `range`, or the `expected` kind of value.
fn told(v:&Value,key:&str,mut error:Value)->Value {
    if let Some(value)=v.get(key) {error["value"]=value.clone();}
    context("field",key,error)
}
/// Where a refusal arose that the id of a piece does not tell: the object it is in, as a path of keys ("pose",
/// "chassis.track"), or the list of a piece and its place in it.
fn within(place:&str,index:Option<usize>,mut error:Value)->Value {
    if error.get("within").is_none() {
        error["within"]=json!(place);
        if let Some(index)=index {error["index"]=json!(index);}
    }
    error
}
/// The refusal of a piece of a list, told with its place in the list and with its id, when one is written.
fn listed(kind:&str,list:&str,index:usize,piece:&Value,error:Value)->Value {
    let error=within(list,Some(index),error);
    match piece["id"].as_str() {Some(name)=>context(kind,name,error),None=>error}
}
fn mounted_in(error:Value)->Value {within("mount",None,error)}
fn fields(v: &Value, allowed: &[&str]) -> Result<(),Value> {
    let values = v.as_object().ok_or_else(|| reject("AUTHORING_OBJECT"))?;
    let unknown=values.keys().filter(|key| !allowed.contains(&key.as_str())).collect::<Vec<_>>();
    if !unknown.is_empty() {return Err(json!({"code":"AUTHORING_FIELDS","keys":unknown}));}
    Ok(())
}
fn num(v: &Value, key: &str, default: Option<f64>, lo: f64, hi: f64) -> Result<f64,Value> {
    let refused=||told(v,key,json!({"code":"FIELD","range":[lo,hi]}));
    let n = match v.get(key) {
        Some(value) => value.as_f64().ok_or_else(refused)?,
        None => default.ok_or_else(refused)?,
    };
    if !n.is_finite() || n < lo || n > hi { return Err(refused()); }
    Ok(n)
}
/// A refusal of what goes past the construction box, by the side of it: "below" its floor or "above" its top.
pub(super) fn outside(side:&str)->Value {json!({"code":"AUTHORING_EXTENT","side":side})}
/// A position written for `key`: a whole number of cells from `lo` to `hi`. One between two cells is off the grid.
pub(super) fn cells(v:&Value,key:&str,lo:i64,hi:i64)->Result<i64,Value> {
    let refused=||told(v,key,json!({"code":"FIELD","range":[lo,hi]}));
    let n=v.get(key).and_then(Value::as_f64).filter(|n|n.is_finite()).ok_or_else(refused)?;
    if n.fract()!=0.0 {return Err(told(v,key,reject("AUTHORING_GRID")));}
    if n<lo as f64 || n>hi as f64 {return Err(refused());}
    Ok(n as i64)
}
/// A point written in the construction box, in cells of the local reference.
pub(super) fn in_box(v:&Value)->Result<(f64,f64),Value> {
    let x=num(v,"x",None,-(REACH as f64),REACH as f64)?;
    let y=num(v,"y",None,i64::MIN as f64,i64::MAX as f64)?;
    if y<(FLOOR as f64) {return Err(told(v,"y",outside("below")));}
    if y>((FLOOR+HEIGHT) as f64) {return Err(told(v,"y",outside("above")));}
    Ok((x,y))
}
/// Retain authored numbers exactly in the canonical document; conversion to metres never snaps them.
fn node_position(v:&Value)->Result<Point,Value> {
    let (x,y)=in_box(v)?;Ok(at_units(x,y))
}
fn whole(v: &Value, key: &str, default: Option<f64>, lo: f64, hi: f64) -> Result<f64,Value> {
    let n = num(v,key,default,lo,hi)?;
    if n.fract() != 0.0 { return Err(told(v,key,reject("INTEGER"))); }
    Ok(n)
}
fn id(v: &Value, key: &str) -> Result<String,Value> {
    let s = v[key].as_str().ok_or_else(|| told(v,key,json!({"code":"FIELD","expected":"text"})))?;
    if s.is_empty() || s.len()>64 || !s.bytes().all(|c| c.is_ascii_alphanumeric() || c==b'_' || c==b'-' || c==b':') {
        return Err(told(v,key,reject("IDENTITY")));
    }
    Ok(s.to_owned())
}
fn named<'a>(v: &'a Value, key: &str, default: &'a str) -> Result<&'a str,Value> {
    match v.get(key) {
        Some(value) => value.as_str().ok_or_else(||told(v,key,json!({"code":"FIELD","expected":"text"}))),
        None => Ok(default),
    }
}
fn array<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a [Value],Value> {
    let a = v[key].as_array().ok_or_else(|| told(v,key,json!({"code":"FIELD","expected":"list"})))?;
    if a.len()>max { return Err(context("field",key,json!({"code":"AUTHORING_LIMIT","max":max}))); }
    Ok(a)
}
/// A name written for `key` that the catalogue has none of.
fn unknown(v:&Value,key:&str)->Value {told(v,key,reject("FIELD"))}
fn add(a: Point,b: Point)->Point { Point::new(a.x+b.x,a.y+b.y) }
fn sub(a: Point,b: Point)->Point { Point::new(a.x-b.x,a.y-b.y) }
fn mul(a: Point,n:f64)->Point { Point::new(a.x*n,a.y*n) }
fn signed(a:Point,b:Point,p:Point)->f64 { sub(b,a).cross(sub(p,a)) }
fn rotate(p:Point,angle:f64)->Point { Point::new(p.x*cos(angle)-p.y*sin(angle),p.x*sin(angle)+p.y*cos(angle)) }
fn corners(b:Bounds)->[Point;4] {
    [Point::new(b.min_x,b.min_y),Point::new(b.max_x,b.min_y),Point::new(b.max_x,b.max_y),Point::new(b.min_x,b.max_y)]
}

#[derive(Clone)]
struct Plate {
    id: String,
    owner: u32,
    a: usize,
    b: usize,
    material: String,
    thickness: f64,
    /// Authored stock extending beyond each joint, independent of neighbouring pieces, in metres.
    start: f64,
    end: f64,
    /// The part of the chassis it is and the segment of it it lies along, for a plate the chassis brings: none for one
    /// written.
    part: Option<(&'static str,usize)>,
}
impl Plate {
    /// Extra top armour is generated with the chassis but weighs and draws as ordinary full-width armour.
    fn structural_part(&self)->Option<(&'static str,usize)> {self.part.filter(|(part,_)|*part!="top")}
}
/// One side of a plate, as the room it closes sees it: `a` to `b` runs
/// counter-clockwise around the room and the normal points out of it. The
/// bed of a chassis is one too (`Frame::open`), from its rear to its front.
#[derive(Clone)]
struct Wall {
    id: String,
    owner: u32,
    a: Point,
    b: Point,
    length: f64,
    normal: Point,
    material: String,
    thickness: f64,
    /// The far side of the plate is open air, not another room.
    exterior: bool,
}
/// A region the plates close. Nobody authors it: it is whatever the frame encloses.
#[derive(Clone)]
struct Room {
    id: String,
    vertices: Polygon,
    walls: Vec<Wall>,
}
/// The authored construction: endpoints remain independent of the derived room topology.
struct Frame {
    origin: Point,
    width: f64,
    nodes: Vec<(String,Point)>,
    plates: Vec<Plate>,
    rooms: Vec<Room>,
    /// The main frame plate used to identify a vehicle, or its lowest authored plate when fixed.
    root: usize,
    /// The top of the frame of each segment of the chassis that has one, open to what a vehicle carries on it.
    beds: Vec<Wall>,
    /// How many of the nodes and of the plates were written: the chassis brings the rest, after them.
    written: (usize,usize),
    canonical: (Vec<Value>,Vec<Value>),
    /// Real geometric junctions, derived without rewriting authored endpoints.
    anchors: Vec<Vec<Point>>,
}
impl Frame {
    /// Plates written meet only at their ends, and the metal of one does not stand in the metal of another. Each is a
    /// body from node to node, as thick as it is, without the stock it runs past them (`body`). Of two of them:
    /// - they do not lie along one line over a common stretch (`PLATE_OVERLAP`), and no node stands on one between its
    ///   ends, within `EPS` of its line (`PLATE_JUNCTION`): an end that meets a plate there divides it, at a node the
    ///   parts and that end share;
    /// - their lines do not cross between their ends (`PLATE_CROSSING`): there both are divided, at one node;
    /// - where they share no end, neither body runs into the other further than `TOUCH`, so that two laid face to face,
    ///   as far apart as their two half thicknesses, pass (`PLATE_OVERLAP`);
    /// - where they share one, what their bodies have in common stays in the corner of the joint: along neither does it
    ///   reach further from that end than `CORNER` times the sum of their half thicknesses, nor to its other end
    ///   (`PLATE_OVERLAP`, told with the node).
    /// The floor a chassis lays over its frame, and its frame, are not written: the hull stands on them as it does
    /// (`enclose`, `Chassis::attach`).
    fn meet(&self)->Result<(),Value> {
        let (nodes,written)=(&self.nodes[..self.written.0],&self.plates[..self.written.1]);
        let ends=|plate:&Plate|self.ends(plate);
        let on_line=|p:Point,(a,b):(Point,Point)|signed(a,b,p).abs()/a.distance(b)<EPS;
        for (i,plate) in written.iter().enumerate() {
            let (a,b)=ends(plate);let (d,length)=(sub(b,a),a.distance(b));
            for other in &written[..i] {
                let (c,e)=ends(other);
                if !on_line(c,(a,b)) || !on_line(e,(a,b)) {continue;}
                let (lo,hi)=(sub(c,a).dot(d)/length,sub(e,a).dot(d)/length);
                if lo.max(hi).min(length)-lo.min(hi).max(0.0)>EPS {return Err(json!({"code":"PLATE_OVERLAP","ids":[plate.id,other.id]}));}
            }
        }
        for plate in written {
            let (a,b)=ends(plate);
            if let Some((id,_))=nodes.iter().find(|(_,p)|p.distance(a)>=EPS && p.distance(b)>=EPS && segment_distance(*p,a,b)<EPS) {
                return Err(json!({"code":"PLATE_JUNCTION","ids":[plate.id],"nodeIds":[id]}));
            }
        }
        for (i,plate) in written.iter().enumerate() {
            let (a,b)=ends(plate);let (d,body)=(sub(b,a),self.body(plate));
            for other in &written[..i] {
                let (c,e)=ends(other);let q=sub(e,c);let both=[plate.id.clone(),other.id.clone()];
                let shared=[(plate.a,b),(plate.b,a)].into_iter().find(|&(end,_)|{let p=self.nodes[end].1;p.distance(c)<EPS || p.distance(e)<EPS});
                let Some((node,far))=shared else {
                    let cross=d.cross(q);
                    if cross.abs()>EPS*EPS {
                        let (t,u)=(sub(c,a).cross(q)/cross,sub(c,a).cross(d)/cross);
                        if t>0.0 && t<1.0 && u>0.0 && u<1.0 {return Err(json!({"code":"PLATE_CROSSING","ids":both}));}
                    }
                    if penetration(&body,&self.body(other))>TOUCH {return Err(json!({"code":"PLATE_OVERLAP","ids":both}));}
                    continue;
                };
                let at=self.nodes[node].1;let other_far=if c.distance(at)<EPS {e} else {c};
                let common=intersection(&body,&self.body(other));
                if polygon_properties(&common).area<=EPS*EPS {continue;}
                let corner=CORNER*(plate.thickness+other.thickness)/2000.0;
                for far in [far,other_far] {
                    let length=at.distance(far);let along=mul(sub(far,at),1.0/length);
                    let reach=common.iter().map(|p|sub(*p,at).dot(along)).fold(0.0,f64::max);
                    if reach>corner || reach>length-TOUCH {
                        return Err(json!({"code":"PLATE_OVERLAP","ids":both,"nodeIds":[self.nodes[node].0]}));
                    }
                }
            }
        }
        Ok(())
    }
    /// The rooms closed by authored plates and the chassis floor, using the same planar graph. Plates written meet at
    /// their ends alone (`meet`); the floor a chassis lays over its frame is cut where a node written stands on it and
    /// where a plate written crosses it, and a plate written where the floor bends on it.
    fn enclose(&mut self)->Result<(),Value> {
        self.meet()?;
        let (nodes,plates)=(&self.nodes,&self.plates);
        let mut joints:Vec<Point>=Vec::new();
        let joint=|points:&mut Vec<Point>,point:Point|->usize {
            if let Some(i)=points.iter().position(|p|p.distance(point)<EPS) {i} else {points.push(point);points.len()-1}
        };
        let mut cuts:Vec<Vec<f64>>=vec![vec![0.0,1.0];plates.len()];
        let along=|(a,b):(Point,Point),point:Point|{let d=sub(b,a);sub(point,a).dot(d)/d.dot(d)};
        for (i,floor) in plates.iter().enumerate().filter(|(_,plate)|matches!(plate.part,Some(("top",_)))) {
            let (a,b)=self.ends(floor);let d=sub(b,a);
            for (_,point) in &nodes[..self.written.0] {if segment_distance(*point,a,b)<EPS {cuts[i].push(along((a,b),*point));}}
            for (j,plate) in plates[..self.written.1].iter().enumerate() {
                let (c,e)=self.ends(plate);let q=sub(e,c);
                for point in [a,b] {if segment_distance(point,c,e)<EPS {cuts[j].push(along((c,e),point));}}
                let cross=d.cross(q);
                if cross.abs()<=EPS {continue;}
                let(t,u)=(sub(c,a).cross(q)/cross,sub(c,a).cross(d)/cross);
                if t>=-EPS && t<=1.0+EPS && u>=-EPS && u<=1.0+EPS {cuts[i].push(t.clamp(0.0,1.0));cuts[j].push(u.clamp(0.0,1.0));}
            }
        }
        // Each edge remembers the metal it came from, so protection and port owners still refer to real plates.
        let mut edges:Vec<(usize,usize,usize)>=Vec::new();let mut used=HashSet::new();
        let mut anchors:Vec<Vec<Point>>=plates.iter().map(|plate|vec![nodes[plate.a].1,nodes[plate.b].1]).collect();
        for(i,plate) in plates.iter().enumerate().filter(|(_,plate)|plate.structural_part().is_none()) {
            cuts[i].sort_by(f64::total_cmp);cuts[i].dedup_by(|a,b|(*a-*b).abs()<EPS);
            let(a,b)=(nodes[plate.a].1,nodes[plate.b].1);
            anchors[i]=cuts[i].iter().map(|&t|a.lerp(b,t)).collect();
            for pair in cuts[i].windows(2) {let from=joint(&mut joints,a.lerp(b,pair[0]));let to=joint(&mut joints,a.lerp(b,pair[1]));
                // Coincident floor layers are real stock, but only one edge of the planar enclosure.
                if from!=to && used.insert((from.min(to),from.max(to))) {edges.push((i,from,to));}}
        }
        let tail=|h:usize|if h%2==0 {edges[h/2].1} else {edges[h/2].2};
        let bearing=|h:usize|{let d=sub(joints[tail(h^1)],joints[tail(h)]);atan2(d.y,d.x)};
        let mut around:Vec<Vec<usize>>=vec![Vec::new();joints.len()];
        for h in 0..edges.len()*2 {around[tail(h)].push(h);}
        for leaving in &mut around {leaving.sort_by(|a,b|bearing(*a).total_cmp(&bearing(*b)));}
        let next=|h:usize|{let leaving=&around[tail(h^1)];let back=leaving.iter().position(|other|*other==(h^1)).unwrap();leaving[(back+leaving.len()-1)%leaving.len()]};
        let mut face=vec![usize::MAX;edges.len()*2];let mut cycles:Vec<Vec<usize>>=Vec::new();
        for first in 0..face.len() {
            if face[first]!=usize::MAX {continue;}let mut cycle=Vec::new();let mut h=first;
            while face[h]==usize::MAX {face[h]=cycles.len();cycle.push(h);h=next(h);}cycles.push(cycle);
        }
        let closed:Vec<bool>=cycles.iter().map(|cycle|cycle.iter().map(|h|sub(joints[tail(*h)],self.origin).cross(sub(joints[tail(*h^1)],self.origin))).sum::<f64>()/2.0>EPS).collect();
        let mut order:Vec<usize>=(0..cycles.len()).filter(|c|closed[*c]).collect();
        for &c in &order {let first=cycles[c].iter().enumerate().min_by_key(|(_,h)|(edges[**h/2].0,**h)).unwrap().0;cycles[c].rotate_left(first);}
        order.sort_by_key(|&c|(edges[cycles[c][0]/2].0,cycles[c][0]));
        let rooms:Vec<Room>=order.iter().enumerate().map(|(count,&c)| {
            // A dead-end spur belongs to no boundary even when its two sides were walked inside a room.
            let walls:Vec<Wall>=cycles[c].iter().filter(|&&h|face[h]!=face[h^1]).map(|&h|{
                let i=edges[h/2].0;let plate=&plates[i];let(a,b)=(joints[tail(h)],joints[tail(h^1)]);let d=sub(b,a);let length=a.distance(b);
                Wall{id:plate.id.clone(),owner:plate.owner,a,b,length,normal:Point::new(d.y/length,-d.x/length),
                    material:plate.material.clone(),thickness:plate.thickness,exterior:!closed[face[h^1]]}
            }).collect();
            Room{id:format!("room-{}",count+1),vertices:walls.iter().map(|wall|wall.a).collect(),walls}
        }).filter(|room|room.vertices.len()>=3).collect();
        self.rooms=rooms;self.anchors=anchors;Ok(())
    }
    fn ends(&self,plate:&Plate)->(Point,Point) {(self.nodes[plate.a].1,self.nodes[plate.b].1)}
    /// The authored plate stock, including its end extensions, with `margin` around it.
    fn solid(&self,plate:&Plate,margin:f64)->Polygon {
        let (a,b)=self.ends(plate);let along=mul(sub(b,a),1.0/a.distance(b));
        let (a,b)=(sub(a,mul(along,plate.start)),add(b,mul(along,plate.end)));
        let pose=Pose{x:(a.x+b.x)/2.0,y:(a.y+b.y)/2.0,angle:atan2(b.y-a.y,b.x-a.x)};
        rectangle(a.distance(b)+2.0*margin,plate.thickness/1000.0+2.0*margin)
            .into_iter().map(|p|pose.world_point(p)).collect()
    }
    /// The plate from node to node, as thick as it is: the metal of it, without the stock it runs past either.
    fn body(&self,plate:&Plate)->Polygon {
        let (a,b)=self.ends(plate);let half=mul(sub(b,a),plate.thickness/2000.0/a.distance(b));let across=Point::new(-half.y,half.x);
        vec![sub(a,across),sub(b,across),add(b,across),add(a,across)]
    }

}

fn segment_distance(p:Point,a:Point,b:Point)->f64 {
    let d=sub(b,a);let t=(sub(p,a).dot(d)/d.dot(d)).clamp(0.0,1.0);
    p.distance(add(a,mul(d,t)))
}
/// Even-odd containment of a closed room boundary.
fn inside(polygon:&[Point],p:Point)->bool {
    let mut within=false;
    for (i,a) in polygon.iter().enumerate() {
        let b=polygon[(i+1)%polygon.len()];
        if (a.y>p.y)!=(b.y>p.y) && p.x<a.x+(b.x-a.x)*(p.y-a.y)/(b.y-a.y) {within=!within;}
    }
    within
}

/// What is written is named apart from what the chassis brings.
fn written(name:String)->Result<String,Value> {
    if name.starts_with("chassis:") {Err(context("field","id",json!({"code":"CHASSIS_IDENTITY","value":name})))} else {Ok(name)}
}
/// Factories choose an initial deck height; the authored reference never follows it afterwards.
pub(crate) fn factory_deck(input:&Value,catalogue:&Value)->Result<f64,Value> {
    Ok(Chassis::read(input,catalogue)?.map_or(CONSTRUCTION_ORIGIN.y,|chassis|chassis.sizing_deck()))
}
/// The design moved up or down, all of it, by whole cells, for its chassis to stand where its model hangs its gear, as
/// the workshop moves it (`src/chassis-editing.js` `withChassisSuspension`): its nodes, the points of its chassis and its
/// components. As it is where it has no chassis that reads.
#[cfg(test)]
pub(crate) fn seated(input:&Value,catalogue:&Value)->Value {
    let mut input=input.clone();
    let Ok(Some(chassis))=Chassis::read(&input,catalogue) else {return input};
    let lift=-chassis.suspension();
    let raise=|at:&mut Value|{let old=&at["y"];let y=old.as_f64().unwrap_or(0.0)+lift;at["y"]=if old.is_i64() && y.fract()==0.0 {json!(y as i64)}else{json!(y)};};
    for point in input["chassis"]["points"].as_array_mut().into_iter().flatten() {raise(point);}
    for node in input["nodes"].as_array_mut().into_iter().flatten() {raise(node);}
    for part in input["components"].as_array_mut().into_iter().flatten() {raise(&mut part["pose"]);}
    input
}
/// A chosen factory design specifies its joint stock once. Normal authoring and compilation
/// never resize a plate because another piece was moved, deleted, rotated or made thicker.
pub(crate) fn seed_plate_ends(input:&mut Value)->Result<(),Value>{
    fn extension(along:Point,next:Point,own:f64,other:f64)->f64{
        let(turn,cosine)=(along.cross(next).abs(),along.dot(next));
        if turn<=1e-9{return 0.0;}
        let reach=((other-own*cosine.abs())/turn).clamp(0.0,own.max(other)*3.0);
        if cosine>0.0{reach.min(own*turn/cosine)}else{reach}
    }
    let frame=frame(input,CONSTRUCTION_ORIGIN)?;
    for(i,plate)in frame.plates.iter().enumerate(){
        if input["plates"][i].get("ends").is_some(){continue;}
        let reach=|at:usize,from:usize|{
            let here=frame.nodes[at].1;
            let mut others=frame.plates.iter().enumerate().filter(|(j,p)|*j!=i&&(frame.nodes[p.a].1.distance(here)<EPS||frame.nodes[p.b].1.distance(here)<EPS)).map(|(_,p)|p);
            let(Some(other),None)=(others.next(),others.next())else{return 0.0;};
            let far=if frame.nodes[other.a].1.distance(here)<EPS{other.b}else{other.a};
            let unit=|from:usize,to:usize|mul(sub(frame.nodes[to].1,frame.nodes[from].1),1.0/frame.nodes[from].1.distance(frame.nodes[to].1));
            extension(unit(from,at),unit(at,far),plate.thickness/2000.0,other.thickness/2000.0)
        };
        // Written as the cells nearest to it, as every length past a node is.
        let(start,end)=(cell(reach(plate.a,plate.b)),cell(reach(plate.b,plate.a)));
        if start>0||end>0{input["plates"][i]["ends"]=json!({"start":start,"end":end});}
    }
    Ok(())
}
/// The cell nearest to a length or a position in metres, as a factory writes what it lays out.
pub(crate) fn cell(metres:f64)->i64 {(metres/CELL).round() as i64}
fn framed(input:&Value,catalogue:&Value)->Result<(Frame,Option<Chassis>),Value> {
    let chassis=Chassis::read(input,catalogue)?;
    let mut frame=frame(input,CONSTRUCTION_ORIGIN)?;
    if let Some(chassis)=&chassis {chassis.attach(&mut frame)?;}
    frame.enclose()?;
    Ok((frame,chassis))
}
/// Read authored metal independently of enclosure. Rooms and damage junctions come from an
/// ephemeral planar graph: coincident endpoints, and plates on the floor of a chassis, do not weld source IDs.
fn frame(input:&Value,origin:Point)->Result<Frame,Value> {
    let mut names=HashSet::new();let mut nodes:Vec<(String,Point)>=Vec::new();let mut node_values=Vec::new();
    for (i,node) in array(input,"nodes",LIMIT)?.iter().enumerate() {
        let name=fields(node,&["id","x","y"]).and_then(|_|written(id(node,"id")?)).map_err(|e|listed("node","nodes",i,node,e))?;
        if !names.insert(name.clone()) {return Err(context("node",&name,reject("NODE_IDENTITY")));}
        let point=node_position(node).map_err(|e|context("node",&name,e))?;
        node_values.push(json!({"id":name,"x":node["x"],"y":node["y"]}));nodes.push((name,add(origin,point)));
    }
    let mut plates:Vec<Plate>=Vec::new();
    for (i,plate) in array(input,"plates",LIMIT)?.iter().enumerate() {
        let name=fields(plate,&["id","a","b","material","thicknessMm","ends"]).and_then(|_|written(id(plate,"id")?))
            .map_err(|e|listed("plate","plates",i,plate,e))?;
        if !names.insert(name.clone()) {return Err(context("plate",&name,reject("PLATE_IDENTITY")));}
        plates.push((|| {
            let end=|key:&str|{let node=id(plate,key)?;nodes.iter().position(|n|n.0==node).ok_or_else(||told(plate,key,reject("PLATE_NODE")))};
            let (a,b)=(end("a")?,end("b")?);let length=nodes[a].1.distance(nodes[b].1);
            if length<0.08-EPS || length>12.0+EPS {return Err(json!({"code":"PLATE_LENGTH","value":length,"range":[0.08,12.0]}));}
            if let Some(other)=plates.iter().find(|p|{let(c,d)=(nodes[p.a].1,nodes[p.b].1);
                (c.distance(nodes[a].1)<EPS && d.distance(nodes[b].1)<EPS)||(d.distance(nodes[a].1)<EPS && c.distance(nodes[b].1)<EPS)}) {
                return Err(json!({"code":"PLATE_REPEATED","ids":[other.id]}));
            }
            let (material,armour)=plate["material"].as_str().and_then(|name|Material::named(name).map(|armour|(name,armour)))
                .ok_or_else(||told(plate,"material",reject("ARMOUR_MATERIAL")))?;
            // How far the stock runs past either node, in cells: at most 1.5 m, and 15 m in all.
            let(start,end)=if let Some(ends)=plate.get("ends"){
                let within=|e|within("ends",None,e);fields(ends,&["start","end"]).map_err(within)?;
                let start=cells(ends,"start",0,STOCK).map_err(within)?;
                let end=cells(ends,"end",0,STOCK.min(((15.0-length)/CELL+1e-9).floor() as i64-start)).map_err(within)?;
                (start,end)
            }else{(0,0)};
            Ok(Plate{id:name.clone(),owner:i as u32+1,a,b,material:material.to_owned(),
                thickness:num(plate,"thicknessMm",None,armour.least_thickness(),1000.0)?,start:metres(start),end:metres(end),part:None})
        })().map_err(|e|context("plate",&name,e))?);
    }
    let root=(0..plates.len()).min_by(|&a,&b|{
        let height=|i:usize|nodes[plates[i].a].1.y+nodes[plates[i].b].1.y;height(a).total_cmp(&height(b)).then(a.cmp(&b))}).unwrap_or(0);
    let plate_values=plates.iter().map(|plate|{
        let mut value=json!({"id":plate.id,"a":nodes[plate.a].0,"b":nodes[plate.b].0,"material":plate.material,"thicknessMm":plate.thickness});
        if plate.start>0.0||plate.end>0.0{value["ends"]=json!({"start":cell(plate.start),"end":cell(plate.end)});}value
    }).collect();
    let written=(nodes.len(),plates.len());
    Ok(Frame{origin,width:BODY_WIDTH,nodes,plates,rooms:Vec::new(),root,beds:Vec::new(),written,canonical:(node_values,plate_values),anchors:Vec::new()})
}

// Convex construction polygons only. This is admission occupancy, never CCD.
pub(crate) fn intersection_area(subject:&[Point],clip:&[Point])->f64 {polygon_properties(&intersection(subject,clip)).area}
/// What two convex polygons have in common.
fn intersection(subject:&[Point],clip:&[Point])->Polygon {
    let orientation=clip.iter().zip(clip.iter().cycle().skip(1)).take(clip.len()).map(|(a,b)|a.cross(*b)).sum::<f64>().signum();
    let mut out=subject.to_vec();
    for (i,a) in clip.iter().enumerate() {
        let b=clip[(i+1)%clip.len()];let input=std::mem::take(&mut out);
        if input.is_empty() { break; }
        let mut previous=*input.last().unwrap();let mut old=orientation*signed(*a,b,previous);
        for current in input {
            let next=orientation*signed(*a,b,current);
            if (next>=0.0)!=(old>=0.0) {
                out.push(previous.lerp(current,old/(old-next)));
            }
            if next>=0.0 { out.push(current); }
            previous=current;old=next;
        }
    }
    out
}
/// How far two convex polygons stand in each other: the least they overlap across any of their sides, none when apart.
fn penetration(p:&[Point],q:&[Point])->f64 {
    let mut least=f64::INFINITY;
    for polygon in [p,q] {
        for (i,a) in polygon.iter().enumerate() {
            let d=sub(polygon[(i+1)%polygon.len()],*a);let length=hypot(d.x,d.y);
            if length<EPS {continue;}
            let axis=Point::new(-d.y/length,d.x/length);
            let span=|points:&[Point]|points.iter().fold((f64::INFINITY,f64::NEG_INFINITY),|(lo,hi),v|(lo.min(v.dot(axis)),hi.max(v.dot(axis))));
            let ((p_lo,p_hi),(q_lo,q_hi))=(span(p),span(q));
            least=least.min(p_hi.min(q_hi)-p_lo.max(q_lo));
        }
    }
    least.max(0.0)
}

/// Analytic closed-interval extrema; bounded sectors require at most two roots.
pub(crate) fn angular_range(a:f64,b:f64,min:f64,max:f64)->(f64,f64) {
    let start=a*cos(min)+b*sin(min);let end=a*cos(max)+b*sin(max);
    let (mut lo,mut hi)=(start.min(end),start.max(end));
    let phase=atan2(b,a);
    let mut k=((min-phase)/PI).ceil();
    while phase+k*PI<=max {
        let t=phase+k*PI;let n=a*cos(t)+b*sin(t);lo=lo.min(n);hi=hi.max(n);k+=1.0;
    }
    (lo,hi)
}
fn envelope(points:&[Point],min:f64,max:f64,origin:Point,axis:f64)->Bounds {
    let mut result=Bounds::empty();
    for p in points {
        let p=rotate(*p,axis);
        let (lx,hx)=angular_range(p.x,-p.y,min,max);let (ly,hy)=angular_range(p.y,p.x,min,max);
        result.min_x=result.min_x.min(origin.x+lx);result.max_x=result.max_x.max(origin.x+hx);
        result.min_y=result.min_y.min(origin.y+ly);result.max_y=result.max_y.max(origin.y+hy);
    }
    result
}

fn contact_angles(a:f64,b:f64,c:f64,min:f64,max:f64,out:&mut Vec<f64>) {
    let radius=hypot(a,b);if radius<=1e-14 || c.abs()>radius+1e-12 {return;}
    let c=c.clamp(-radius,radius);
    let phase=atan2(b,a);let delta=atan2(sqrt((radius*radius-c*c).max(0.0)),c);
    for root in [phase-delta,phase+delta] {
        let angle=root+((min-root)/(2.0*PI)).ceil()*(2.0*PI);
        if angle>=min-1e-12 && angle<=max+1e-12 {out.push(angle.clamp(min,max));}
    }
}

/// Exact continuous admission sweep. Overlap can change only when a rotating
/// vertex meets a fixed edge or vice versa. Check those analytic boundaries
/// and every interval between them, rather than an AABB or angular samples.
pub(crate) fn swept_box_intersects(shape:Bounds,min:f64,max:f64,obstacle:&[Point])->bool {
    swept_polygon_intersects(&corners(shape),min,max,obstacle)
}
fn swept_polygon_intersects(local:&[Point],min:f64,max:f64,obstacle:&[Point])->bool {
    let bound=envelope(local,min,max,Point::ZERO,0.0);let other=Bounds::points(obstacle);
    if bound.max_x<=other.min_x || other.max_x<=bound.min_x || bound.max_y<=other.min_y || other.max_y<=bound.min_y {return false;}
    let mut angles=vec![min,max];
    for (i,a) in obstacle.iter().enumerate() {
        let d=sub(obstacle[(i+1)%obstacle.len()],*a);let n=Point::new(-d.y,d.x);
        for &p in local {contact_angles(n.dot(p),n.dot(Point::new(-p.y,p.x)),n.dot(*a),min,max,&mut angles);}
    }
    for (i,a) in local.iter().enumerate() {
        let d=sub(local[(i+1)%local.len()],*a);let n=Point::new(-d.y,d.x);
        for p in obstacle {contact_angles(n.dot(*p),Point::new(-n.y,n.x).dot(*p),n.dot(*a),min,max,&mut angles);}
    }
    angles.sort_by(f64::total_cmp);angles.dedup_by(|a,b|(*a-*b).abs()<=1e-12);
    let overlap=|angle| {
        let (c,s)=(cos(angle),sin(angle));
        let posed=local.iter().map(|p|Point::new(c*p.x-s*p.y,s*p.x+c*p.y)).collect::<Vec<_>>();
        intersection_area(&posed,obstacle)>EPS*EPS
    };
    angles.iter().any(|&angle|overlap(angle)) || angles.windows(2).any(|p|overlap((p[0]+p[1])/2.0))
}


/// A solid of a gun turned about its trunnion from `min` to `max`, in the frame of its mount: the breech over the
/// stretch of the sector it recoils as far in, the post of an exposed mount over none.
#[derive(Clone,Copy,Debug,PartialEq)]
pub(crate) struct Sweep {pub shape:Bounds,pub min:f64,pub max:f64}
/// The finest step over which the breech of a gun that recoils less at high angles is reserved as one solid: a degree.
const STROKE_STEP:f64=PI/180.0;
/// What the breech of a gun in a room takes of it: its receiver, `width` behind the trunnion and `height` across the
/// bore, and behind that the room it recoils into, turned with the bore through its sector, from `min` to `max` about
/// the axis of its mount, which is `axis` in the frame of its construction. Where the recoil shortens as the gun is
/// raised the sector is cut into steps of a degree at most, each holding the breech with the longest recoil in it, the
/// one at its lowest elevation; steps that recoil as far are one.
pub(crate) fn breech(width:f64,height:f64,stroke:&Stroke,axis:f64,min:f64,max:f64)->Vec<Sweep> {
    let shape=|recoil:f64|Bounds{min_x:-width-recoil,max_x:0.0,min_y:-height/2.0,max_y:height/2.0};
    if stroke.short==stroke.long {return vec![Sweep{shape:shape(stroke.long),min,max}];}
    let steps=((max-min)/STROKE_STEP).ceil().max(1.0) as usize;
    let mut sweeps:Vec<(f64,Sweep)>=Vec::new();
    for i in 0..steps {
        let lo=min+(max-min)*i as f64/steps as f64;
        let hi=if i+1==steps {max} else {min+(max-min)*(i+1) as f64/steps as f64};
        let recoil=stroke.at(lowest(axis+lo,axis+hi));
        match sweeps.last_mut() {
            Some((last,sweep)) if *last==recoil=>sweep.max=hi,
            _=>sweeps.push((recoil,Sweep{shape:shape(recoil),min:lo,max:hi})),
        }
    }
    sweeps.into_iter().map(|(_,sweep)|sweep).collect()
}
/// How far a bore laid at `angle` in the frame of its construction rises over level, whichever end of it it points
/// to: up is positive, and straight up a quarter turn.
pub(crate) fn elevation(angle:f64)->f64 {atan2(sin(angle),cos(angle).abs())}
/// The lowest elevation of a bore turned from `from` to `to`: at one end, or straight down where it passes that.
fn lowest(from:f64,to:f64)->f64 {
    let down=-PI/2.0;
    if down+2.0*PI*((from-down)/(2.0*PI)).ceil()<=to {down} else {elevation(from).min(elevation(to))}
}
/// The breech as it stands with the bore at `angle`, as long as the longest of its steps that hold that angle.
fn breech_at(breech:&[Sweep],angle:f64)->Option<Bounds> {
    breech.iter().filter(|sweep|sweep.min<=angle && angle<=sweep.max).map(|sweep|sweep.shape).min_by(|a,b|a.min_x.total_cmp(&b.min_x))
}
/// Where in its sector a breech first meets what `meets` tells of its corners, turned out to either end from where the
/// bore lies along the axis of its mount, or from the end of the sector nearer that, a tenth of a degree at a time:
/// what a refusal names. A breech that meets it only between two of those is told at the far end of its sector.
fn contact(breech:&[Sweep],meets:impl Fn(&[Point])->bool)->f64 {
    let min=breech.iter().map(|sweep|sweep.min).fold(f64::INFINITY,f64::min);
    let max=breech.iter().map(|sweep|sweep.max).fold(f64::NEG_INFINITY,f64::max);
    let rest=0.0f64.clamp(min,max);let step=PI/1800.0;
    let at=|angle:f64|breech_at(breech,angle).is_some_and(|shape|meets(&corners(shape).map(|p|rotate(p,angle))));
    let mut i=0.0;
    while rest-i*step>=min || rest+i*step<=max {
        for angle in [rest-i*step,rest+i*step] {if (min..=max).contains(&angle) && at(angle) {return angle;}}
        i+=1.0;
    }
    [min,max].into_iter().find(|&angle|at(angle)).unwrap_or(if max-rest>=rest-min {max} else {min})
}
/// How a crossing is told: the elevation of the bore over level, to the degree.
fn degrees(angle:f64)->i64 {elevation(angle).to_degrees().round() as i64}
/// Which of the plates about a gun one is, from the trunnion at `pivot`: one that lies flatter than half a right
/// angle is a roof over it or a floor under it, any other a wall.
fn side(a:Point,b:Point,pivot:Point)->&'static str {
    let along=sub(b,a);
    if along.y.abs()>=along.x.abs() {"wall"} else if (a.y+b.y)/2.0>=pivot.y {"roof"} else {"floor"}
}

#[derive(Clone)]
struct WeaponOccupancy {
    pose: Pose,
    breech: Vec<Sweep>,
    moving: Vec<Polygon>,
    fixed: Vec<Polygon>,
    min: f64,
    max: f64,
}
impl WeaponOccupancy {
    fn intersects(&self,polygon:&[Point])->bool {self.crosses(polygon,polygon)}
    /// Whether the breech, or the post that stands still, crosses `fixed` or what turns before the trunnion sweeps
    /// across `swept`: the post of an exposed mount stands on the metal of its own plate, while the gun on it swings a
    /// clearance clear of that.
    fn crosses(&self,fixed:&[Point],swept:&[Point])->bool {
        self.mechanism_crosses(fixed,swept) || self.fixed.iter().any(|shape|{
            let posed:Vec<_>=shape.iter().map(|&p|self.pose.world_point(p)).collect();
            intersection_area(&posed,fixed)>EPS*EPS
        })
    }
    fn mechanism_crosses(&self,fixed:&[Point],swept:&[Point])->bool {
        let bounds=corners(self.bounds());
        let local=|polygon:&[Point]|(intersection_area(&bounds,polygon)>EPS*EPS)
            .then(||polygon.iter().map(|&p|self.pose.local_point(p)).collect::<Vec<_>>());
        local(fixed).is_some_and(|local|self.breech.iter().any(|sweep|swept_box_intersects(sweep.shape,sweep.min,sweep.max,&local))) ||
            local(swept).is_some_and(|local|self.moving.iter().any(|shape|swept_polygon_intersects(shape,self.min,self.max,&local)))
    }
    /// The angle of the bore, about the axis of the mount, at which the breech first meets a polygon, if it does.
    fn breech_meets(&self,polygon:&[Point])->Option<f64> {
        let local:Vec<_>=polygon.iter().map(|&p|self.pose.local_point(p)).collect();
        self.breech.iter().any(|sweep|swept_box_intersects(sweep.shape,sweep.min,sweep.max,&local))
            .then(||contact(&self.breech,|posed|intersection_area(posed,&local)>EPS*EPS))
    }
    /// Every solid of it with the stretch of the sector it turns through.
    fn solids(&self)->impl Iterator<Item=(Polygon,f64,f64)>+'_ {
        self.breech.iter().map(|s|(corners(s.shape).to_vec(),s.min,s.max))
            .chain(self.moving.iter().map(|shape|(shape.clone(),self.min,self.max)))
            .chain(self.fixed.iter().map(|shape|(shape.clone(),0.0,0.0)))
    }
    fn bounds(&self)->Bounds {
        let mut bounds=Bounds::empty();
        for (shape,min,max) in self.solids() {bounds.union(envelope(&shape,min,max,Point::new(self.pose.x,self.pose.y),self.pose.angle));}
        bounds
    }
}

enum Occupancy { Fixed(Polygon), Weapon(WeaponOccupancy) }
impl Occupancy {
    fn overlaps(&self,other:&Self)->bool {
        match (self,other) {
            (Self::Fixed(a),Self::Fixed(b))=>intersection_area(a,b)>EPS,
            (Self::Fixed(p),Self::Weapon(weapon))|(Self::Weapon(weapon),Self::Fixed(p))=>weapon.intersects(p),
            // Every solid of either reserves what it sweeps of its own sector, never the empty corners of a
            // whole-weapon AABB.
            (Self::Weapon(a),Self::Weapon(b))=>a.solids().any(|x|b.solids()
                .any(|y|swept_polygons_overlap(&x.0,a.pose,x.1,x.2,&y.0,b.pose,y.1,y.2))),
        }
    }
}

/// Two independently moving mounts. What `a` sweeps is met exactly by a polygon; `b` is turned through its
/// sector in shorter and shorter turns. Over a turn every point of `b` stays within twice its distance from the
/// pivot times the sine of a quarter of the turn of where it stands at the middle of it: the box grown by that much
/// holds all of it. A hit of the box itself proves the overlap, a miss of the grown box proves clearance over
/// that turn, and a grown box within a tenth of a micrometre of the box is conservative at numerical contact. A
/// bound of the whole swept area would hold the empty corners about a long tube laid at a slant and never clear.
#[cfg(test)]
fn swept_boxes_overlap(a:Bounds,pose_a:Pose,min_a:f64,max_a:f64,b:Bounds,pose_b:Pose,min_b:f64,max_b:f64)->bool {
    swept_polygons_overlap(&corners(a),pose_a,min_a,max_a,&corners(b),pose_b,min_b,max_b)
}
fn swept_polygons_overlap(a:&[Point],pose_a:Pose,min_a:f64,max_a:f64,b:&[Point],pose_b:Pose,min_b:f64,max_b:f64)->bool {
    let reach=b.iter().map(|p|hypot(p.x,p.y)).fold(0.0,f64::max);
    let posed=|shape:Bounds,angle:f64|corners(shape).map(|p|pose_a.local_point(pose_b.world_point(rotate(p,angle))));
    let mut pending=vec![(min_b,max_b)];
    while let Some((lo,hi))=pending.pop() {
        let middle=(lo+hi)/2.0;
        let exact=b.iter().map(|&p|pose_a.local_point(pose_b.world_point(rotate(p,middle)))).collect::<Vec<_>>();
        if swept_polygon_intersects(a,min_a,max_a,&exact) {return true;}
        let grown=2.0*reach*sin((hi-lo)/4.0);
        let cover=Bounds::points(b).padded(grown);
        if !swept_polygon_intersects(a,min_a,max_a,&posed(cover,middle)) {continue;}
        if grown<=1e-7 {return true;}
        pending.push((lo,middle));pending.push((middle,hi));
    }
    false
}

#[derive(Clone)]
struct Mount {
    geometry: crate::game_mounts::WeaponMount,
    projection: Value,
    occupancy: WeaponOccupancy,
    /// The stretch of each plate it fires through that the mount cuts out; an exposed mount cuts none.
    ports: Vec<(u32,(f64,f64))>,
    physical: (f64,Point,f64),
}
/// Catalogue physical capacity and the sector explicitly authored for this mechanism.
struct Capacity<'a> {
    id: &'a str,
    min: f64,
    max: f64,
    speed: f64,
    recoil: f64,
    armour: f64,
    depth: f64,
}
fn capacity<'a>(p:&'a Value,weapon:&Value,catalogue:&'a Value)->Result<Capacity<'a>,Value> {
    let family=weapon["family"].as_str().ok_or_else(|| reject("WEAPON_FAMILY"))?;
    let id=named(p,"preset",default_mount(family)?).map_err(mounted_in)?;
    let profile=&catalogue["mounts"][id];
    if !profile.is_object(){return Err(mounted_in(unknown(p,"preset")));}
    // A mount takes any gun of a kind it is made for: one heavier than it is rated for, it grows to (game_mounts.rs `rated`).
    if !profile["families"].as_array().is_some_and(|a|a.iter().any(|f|f==family)) {
        return Err(reject("MOUNT_KIND"));
    }
    // An exposed barrel turns over its face to below level on either side; an enclosed one stays within its port.
    // An exposed mount has no armour about its gun.
    let exposed=profile["exposed"]==true;
    let reach=if exposed {crate::game_mounts::REACH} else {1.5};
    let capacity_min=num(profile,"min",None,-reach,reach)?;
    let capacity_max=num(profile,"max",None,capacity_min,reach)?;
    let sector=p.get("sector").unwrap_or(profile);
    let written=|e|if p.get("sector").is_some() {within("mount.sector",None,e)} else {e};
    if p.get("sector").is_some() { fields(sector,&["min","max"]).map_err(written)?; }
    let min=num(sector,"min",None,capacity_min,capacity_max).map_err(written)?;
    let max=num(sector,"max",None,min,capacity_max).map_err(written)?;
    Ok(Capacity{id,min,max,speed:crate::game_mounts::effective_speed(profile,weapon).map_err(|_|reject("MOUNT_SPEED"))?,recoil:recoil(weapon).map_err(|_|reject("WEAPON_RECOIL"))?,
        armour:if exposed {0.0} else {num(profile,"armourMm",None,1.0,1000.0)?/1000.0},depth:num(profile,"depthM",Some(0.45),0.05,6.0)?})
}
fn default_mount(family:&str)->Result<&'static str,Value> {
    Ok(match family {
        "machinegun"|"grenade"|"rocket"=>"light-trunnion",
        "autocannon"=>"medium-trunnion", "cannon"=>"heavy-trunnion",
        "howitzer"=>"elevated-trunnion", "mortar"=>"roof-mortar",
        _=>return Err(reject("WEAPON_FAMILY")),
    })
}

/// How long a receiver may be behind its trunnion and how high, in metres: from the foot of a mortar to the breech
/// of a tank gun with its ring.
pub(crate) const RECEIVER_LENGTH:(f64,f64)=(0.1,2.0);
pub(crate) const RECEIVER_HEIGHT:(f64,f64)=(0.1,1.0);
/// How far a gun may run back in its cradle when it fires, in metres.
pub(crate) const RECOIL:(f64,f64)=(0.0,2.0);
/// The receiver of a weapon as the catalogue states it for its preset (weapons.js `receiver`): how long behind the
/// trunnion, along the bore, with what the compartment of its ready rounds reaches behind it (game_variant.rs
/// `compartment`), and how high. Placement and mounting share it.
pub(crate) fn receiver_dimensions(weapon:&Value)->Result<(f64,f64),String> {
    let receiver=&weapon["receiver"];
    let length=num(receiver,"length",None,RECEIVER_LENGTH.0,RECEIVER_LENGTH.1).map_err(|_|reject("WEAPON_RECEIVER_LENGTH").to_string())?;
    let height=num(receiver,"height",None,RECEIVER_HEIGHT.0,RECEIVER_HEIGHT.1).map_err(|_|reject("WEAPON_RECEIVER_HEIGHT").to_string())?;
    let ready=crate::game_variant::compartment(weapon).map_or(0.0,|c|c.behind);
    if !(0.0..=crate::game_variant::COMPARTMENT_LENGTH+1e-9).contains(&ready) {return Err(reject("WEAPON_RECEIVER_LENGTH").to_string());}
    Ok((length+ready,height))
}
/// How far a weapon runs back behind its receiver when it fires, as the catalogue states it (weapons.js `recoil`).
pub(crate) fn recoil(weapon:&Value)->Result<f64,String> {
    num(weapon,"recoil",None,RECOIL.0,RECOIL.1).map_err(|_|reject("WEAPON_RECOIL").to_string())
}
/// How far a gun runs back when it fires with its bore raised to an elevation over its construction: the whole of
/// its recoil (weapons.js `recoil`) or, for a howitzer whose cut-off gear shortens that at high angles so that its
/// breech does not strike what is under it (`recoilCutoff`), the whole of it up to the elevation where the cut-off
/// begins, its short recoil from where it ends and, in between, as much less as it is raised higher.
#[derive(Clone,Copy,Debug,PartialEq)]
pub(crate) struct Stroke {pub long:f64,pub short:f64,from:f64,to:f64}
impl Stroke {
    pub(crate) fn from_weapon(weapon:&Value)->Result<Self,String> {
        let long=recoil(weapon)?;
        let Some(cutoff)=weapon.get("recoilCutoff") else {return Ok(Self{long,short:long,from:PI,to:PI});};
        let refused=|_|reject("WEAPON_RECOIL_CUTOFF").to_string();
        fields(cutoff,&["recoil","fromDeg","toDeg"]).map_err(refused)?;
        let short=num(cutoff,"recoil",None,RECOIL.0,long).map_err(refused)?;
        let from=num(cutoff,"fromDeg",None,0.0,90.0).map_err(refused)?;
        let to=num(cutoff,"toDeg",None,from,90.0).map_err(refused)?;
        Ok(Self{long,short,from:from.to_radians(),to:to.to_radians()})
    }
    /// The recoil at an elevation, in radians.
    pub(crate) fn at(&self,elevation:f64)->f64 {
        if elevation<=self.from {self.long} else if elevation>=self.to {self.short}
        else {self.long+(self.short-self.long)*(elevation-self.from)/(self.to-self.from)}
    }
}

/// The face of a plate a factory lays a part or a gun on: the plate, in the field, and the way out of it.
fn face<'a>(frame:&'a Frame,plate_id:&str)->Result<(&'a Plate,Point),Value> {
    let plate=frame.plates.iter().find(|plate|plate.id==plate_id).ok_or_else(||reject("MOUNT_MISSING"))?;
    let(a,b)=frame.ends(plate);let d=sub(b,a);let length=a.distance(b);
    let wall=frame.rooms.iter().flat_map(|room|room.walls.iter()).find(|wall|wall.id==plate_id&&wall.exterior);
    Ok((plate,wall.map_or_else(||frame.beds.iter().find(|bed|bed.id==plate_id).map_or(Point::new(d.y/length,-d.x/length),|bed|bed.normal),|wall|wall.normal)))
}
/// Factories place a mechanism exactly on a chosen face, its axis out of it: an enclosed one with its mantlet a
/// clearance behind the plate, an exposed one on the shortest post over it. Compilation retains this authored pose and
/// finds the plate it meets from it.
pub(crate) fn mount_on_plate(input:&Value,catalogue:&Value,plate_id:&str,t:f64,preset:&str,mount_preset:&str,sector:(f64,f64))->Result<Value,Value> {
    let(frame,_)=framed(input,catalogue)?;
    let(plate,normal)=face(&frame,plate_id)?;let(a,b)=frame.ends(plate);
    let weapon=&catalogue["weapons"][preset];let(width,height)=receiver_dimensions(weapon).map_err(|_|reject("WEAPON_RECEIVER"))?;
    let barrel=BarrelProfile::from_weapon(weapon).map_err(|_|reject("WEAPON_BARREL"))?;
    let exposed=catalogue["mounts"][mount_preset]["exposed"]==true;
    let thickness=plate.thickness/1000.0;
    let inset=if exposed{thickness/2.0+crate::game_mounts::shortest_post(width,height)}
        else{((height/2.0).max(barrel.radius)+thickness/2.0+CLEARANCE).max(shield_minimum(barrel.radius)+EPS-thickness/2.0-CLEARANCE)};
    let on=a.lerp(b,t);
    let point=if exposed{add(on,mul(normal,inset))}else{sub(on,mul(normal,inset))};
    let local=sub(point,frame.origin);let(x,y)=(local.x/CELL,local.y/CELL);
    let mut mount=json!({"preset":mount_preset,"sector":{"min":sector.0,"max":sector.1}});
    if !exposed{mount["radiusM"]=json!(inset+thickness/2.0+CLEARANCE);}
    Ok(json!({"pose":{"x":x,"y":y,"angle":atan2(normal.y,normal.x)},"mount":mount}))
}

/// The workshop's hand putting a gun in: the gun as the player turned it, set where the mounting made for the face
/// nearest the cursor holds it, if one is within `tolerance` of it. An enclosed gun firing through the face stands
/// with its mantlet a clearance behind it, and one whose bore runs along the face on its lowest foot on it; an exposed
/// one upright on its post over a face it can stand on, as far over it as it was put, as far as a post reaches. The
/// gun keeps its angle; compilation then finds the plates it meets from its pose alone. With no face near, it stays
/// as it was put.
fn seat_weapon(input:&Value,catalogue:&Value,request:&Value)->Result<(Value,Value),Value> {
    fields(request,&["component","tolerance","point"])?;
    let mut part=request["component"].clone();let name=id(&part,"id")?;
    if part["kind"]!="weapon" {return Err(context("component",&name,reject("COMPONENT_KIND")));}
    let tolerance=num(request,"tolerance",Some(0.0),0.0,0.1)?;
    let p=&part["pose"];let coordinate=|e|within("pose",None,e);
    let x=num(p,"x",None,-(POSE_REACH as f64),POSE_REACH as f64).map_err(coordinate)?;
    let y=num(p,"y",None,-(POSE_REACH as f64),POSE_REACH as f64).map_err(coordinate)?;
    let angle=num(p,"angle",Some(0.0),-PI,PI).map_err(coordinate)?;
    let mirrored=match p.get("mirrored"){Some(value)=>value.as_bool().ok_or_else(||coordinate(told(p,"mirrored",reject("FIELD"))))?,None=>false};
    let point=add(CONSTRUCTION_ORIGIN,at_units(x,y));
    let cursor=match request.get("point") {
        Some(cursor)=>{fields(cursor,&["x","y"])?;Point::new(num(cursor,"x",None,-1e6,1e6)?,num(cursor,"y",None,-1e6,1e6)?)}
        None=>point,
    };
    let preset=named(&part,"weaponPreset","rh120")?;let weapon=&catalogue["weapons"][preset];
    if !weapon.is_object(){return Err(context("component",&name,unknown(&part,"weaponPreset")));}
    let(width,height)=receiver_dimensions(weapon).map_err(|_|reject("WEAPON_RECEIVER"))?;
    let(mount,barrel,_,_)=mount_geometry(&part,weapon,catalogue,(width,height),mirrored)?;
    let aim={let axis=angle+if mirrored{PI}else{0.0};Point::new(cos(axis),sin(axis))};
    if tolerance>0.0 {
        let(frame,_)=framed(input,catalogue)?;
        // The nearest face; of as near ones, the one its post would stand shortest on.
        let mut chosen:Option<(f64,f64,Point,Option<f64>)>=None;
        for plate in &frame.plates {
            let(a,b)=frame.ends(plate);let length=a.distance(b);let tangent=mul(sub(b,a),1.0/length);
            let on=a.lerp(b,sub(cursor,a).dot(tangent).clamp(0.0,length)/length);
            let(_,outward)=face(&frame,&plate.id)?;let side=sub(cursor,on).dot(outward);
            // The cursor's side of the plate, or above a level one.
            let normal=if side.abs()>EPS {mul(outward,side.signum())}
                else if outward.y.abs()>EPS {mul(outward,outward.y.signum())}
                else {mul(outward,if aim.dot(outward)>=0.0{1.0}else{-1.0})};
            let(thickness,top)=(plate.thickness/1000.0,add(on,mul(normal,plate.thickness/2000.0)));
            let(target,standoff,radius)=if mount.exposed {
                // Its post stands straight down to the face, which it cannot on one steeper than it stands on, and holds
                // the gun as far off the face as the shortest post at least, so on a slope it is longer.
                let(shortest,longest)=(crate::game_mounts::shortest_post(width,height)/normal.y,crate::game_mounts::longest_post(width,height));
                if normal.y<0.5||shortest>longest {continue;}
                let standoff=(point.y-top.y).clamp(shortest,longest);
                (add(top,Point::new(0.0,standoff)),standoff,None)
            } else if aim.dot(tangent).abs()>std::f64::consts::FRAC_1_SQRT_2 {
                // Its bore along the face: its lowest foot on it.
                let pose=Pose{x:0.0,y:0.0,angle:atan2(aim.y,aim.x)};
                let low=mount.base.unwrap().polygons().iter().flatten().map(|&p|pose.world_point(p).dot(normal)).fold(f64::INFINITY,f64::min);
                (sub(top,mul(normal,low)),0.0,None)
            } else {
                // Behind the face from the way it fires, as near as its feet, turned as the gun is, let it stand, its
                // mantlet a clearance past the plate; the feet grow with the mantlet, so the two are settled together.
                let out=if aim.dot(normal)>=0.0 {normal} else {mul(normal,-1.0)};
                let written=part["mount"]["radiusM"].as_f64();
                let reach=|mount:&crate::game_mounts::WeaponMount|{let pose=Pose{x:0.0,y:0.0,angle:atan2(aim.y,aim.x)};
                    mount.base.unwrap().polygons().iter().flatten().map(|&p|pose.world_point(p).dot(out)).fold(f64::NEG_INFINITY,f64::max)};
                let least=shield_minimum(barrel.radius)+EPS-thickness/2.0-CLEARANCE;
                let mut inset=(reach(&mount)+thickness/2.0).max(least);
                if let Some(radius)=written {inset=inset.max(radius-thickness/2.0-CLEARANCE);}
                else {for _ in 0..64 {
                    let mut trial=part.clone();trial["mount"]["radiusM"]=json!(inset+thickness/2.0+CLEARANCE);
                    let Ok((grown,..))=mount_geometry(&trial,weapon,catalogue,(width,height),mirrored) else{break};
                    let next=(reach(&grown)+thickness/2.0).max(least);
                    if (next-inset).abs()<1e-12 {break;} inset=next;
                }}
                (sub(on,mul(out,inset)),0.0,written.is_none().then_some(inset+thickness/2.0+CLEARANCE))
            };
            let distance=cursor.distance(on).min(point.distance(target));
            if distance<=tolerance+EPS&&chosen.is_none_or(|(best,shortest,..)|distance<best-EPS||distance<best+EPS&&standoff<shortest-EPS) {
                chosen=Some((distance,standoff,target,radius));
            }
        }
        if let Some((_,_,target,radius))=chosen {
            let local=sub(target,frame.origin);
            part["pose"]["x"]=json!(local.x/CELL);part["pose"]["y"]=json!(local.y/CELL);
            if let Some(radius)=radius {part["mount"]["radiusM"]=json!(radius);}
        }
    }
    let mut components=array(input,"components",48)?.to_vec();
    match components.iter().position(|other|other["id"]==name) {Some(index)=>components[index]=part.clone(),None=>components.push(part.clone())}
    let mut source=input.clone();source["components"]=json!(components);
    Ok((source,part))
}
pub(crate) fn part_on_plate(input:&Value,catalogue:&Value,part:&Value,plate_id:&str,t:f64)->Result<Value,Value> {
    let(frame,_)=framed(input,catalogue)?;
    let(plate,normal)=face(&frame,plate_id)?;let(a,b)=frame.ends(plate);
    let kind=ComponentKind::from_name(part["kind"].as_str().unwrap_or("")).map_err(|_|reject("COMPONENT_KIND"))?;
    let(w,h,_)=if kind==ComponentKind::Sensor{sensor_dimensions(catalogue,part)?}else{kind.dimensions()};
    let scale=num(part,"sizeScale",Some(1.0),0.25,kind.largest_scale())?;
    // The camera/radar/listening foot already lies inside its catalogue body: no invisible stand or gap is added.
    let gap=(normal.x.abs()*w+normal.y.abs()*h)*scale/2.0+plate.thickness/2000.0;
    let local=sub(add(a.lerp(b,t),mul(normal,gap)),frame.origin);let(x,y)=(local.x/CELL,local.y/CELL);
    Ok(json!({"x":x,"y":y,"angle":0.0}))
}

fn shield_minimum(barrel_radius:f64)->f64 {(barrel_radius+CLEARANCE)/(PI/3.0).sin()+EPS}
/// A gun has its own trunnion pose and physical curved armour. A chosen real wall may receive a
/// port, but removing that wall neither removes the gun nor moves it. All other metal is still
/// checked against the complete barrel/receiver sweep.
fn mount_geometry(part:&Value,weapon:&Value,catalogue:&Value,receiver_size:(f64,f64),mirrored:bool)->Result<(crate::game_mounts::WeaponMount,BarrelProfile,String,f64),Value> {
    let p=&part["mount"];fields(p,&["preset","sector","radiusM"]).map_err(|e|within("mount",None,e))?;
    let Capacity{id:mount_id,min:written_min,max:written_max,speed,recoil,armour,depth}=capacity(p,weapon,catalogue)?;
    let(min,max)=if mirrored{(-written_max,-written_min)}else{(written_min,written_max)};
    let exposed=catalogue["mounts"][mount_id]["exposed"]==true;
    let(width,height)=receiver_size;let barrel=BarrelProfile::from_weapon(weapon).map_err(|_|reject("WEAPON_BARREL"))?;
    let shield=if exposed{
        if p.get("radiusM").is_some(){return Err(told(p,"radiusM",reject("EXPOSED_SHIELD")));}None
    }else{
        let minimum=shield_minimum(barrel.radius);
        let default=(height.max(2.0*barrel.radius)/2.0+0.008+2.0*CLEARANCE).max(minimum+EPS);
        let radius=num(p,"radiusM",Some(default),minimum,barrel.end-armour-CLEARANCE)?;
        Some(crate::game_mounts::Shield{radius,thickness:armour,half_angle:PI/3.0,opening:barrel.radius+CLEARANCE})
    };
    let material=Material::named("steel").unwrap();
    let base=shield.map(|shield|crate::game_mounts::Base::derive(&catalogue["mounts"][mount_id],shield,width,height,barrel,depth,
        weapon["installedMassKg"].as_f64().unwrap(),material)).transpose().map_err(|_|reject("MOUNT_BASE"))?;
    // The post of an exposed mount is found where it stands (`derive_mount`).
    let mount=crate::game_mounts::WeaponMount{min,max,max_speed:speed,exposed,post:None,shield,base,depth,material};
    Ok((mount,barrel,mount_id.to_owned(),recoil))
}
fn derive_mount(part:&Value,frame:&Frame,point:Point,axis:f64,weapon:&Value,catalogue:&Value,receiver_size:(f64,f64),mirrored:bool)->Result<Mount,Value> {
    let (mut mount,barrel,mount_id,recoil)=mount_geometry(part,weapon,catalogue,receiver_size,mirrored)?;
    let (min,max,speed,exposed,shield,depth,material)=(mount.min,mount.max,mount.max_speed,mount.exposed,mount.shield,mount.depth,mount.material);
    if frame.width<depth{return Err(reject("MOUNT_FACE_DEPTH"));}
    let(width,height)=receiver_size;
    let pose=Pose{x:point.x,y:point.y,angle:axis};
    let stroke=Stroke::from_weapon(weapon).map_err(|_|reject("WEAPON_RECOIL_CUTOFF"))?;
    let mut projection=json!({"version":3,"preset":mount_id,"min":min,"max":max,"maxSpeed":speed,"exposed":exposed,
        "fireTolerance":crate::game_weapons::servo_fire_tolerance(weapon["family"].as_str().ok_or_else(||reject("WEAPON_FAMILY"))?),
        "mirrored":mirrored,"hostOwner":0,"hostId":null,"hullAxis":axis,
        "recoil":recoil,"bodyWidth":frame.width,"walls":[],
        "materialDepth":depth,"materialDensity":material.density,"material":material.name(),"shield":shield.map(|shield|shield.to_value())});
    let local=|plate:&Plate|{let(a,b)=frame.ends(plate);(pose.local_point(a),pose.local_point(b))};
    // The plates it meets, each with the port cut in it and the stretch of the sector that cuts it.
    let mut walls:Vec<(&Plate,Option<(crate::game_mounts::Port,f64,f64)>)>=Vec::new();
    if exposed {
        // The post stands straight down in the construction to the face of the first plate under the trunnion, as far
        // as a post reaches, its foot on the metal of that plate; with none there, it hangs straight up from the first
        // over it, as a gun under the hull of an aircraft; with neither, it is the shortest.
        mount.post=Some(crate::game_mounts::Post::free(axis,width,height));
        let mut stood=None;
        for way in [crate::game_mounts::Post::on,crate::game_mounts::Post::hung] {
            // The tubes of the skids of an aircraft hold no post.
            for plate in frame.plates.iter().filter(|plate|!matches!(plate.part,Some(("skid"|"leg",_)))) {
                let(a,b)=local(plate);
                let Some(post)=way(a,b,plate.thickness/1000.0,axis,width,height) else{continue};
                let(reach,shape)=(a.distance(b),post.shape());let along=mul(sub(b,a),1.0/reach);
                let on=|p:Point|{let u=sub(p,a).dot(along);u>=-plate.start-EPS&&u<=reach+plate.end+EPS};
                if !on(shape[0])||!on(shape[3])||stood.is_some()&&mount.post.is_some_and(|nearest|nearest.length<=post.length) {continue;}
                mount.post=Some(post);stood=Some(plate);
            }
            if stood.is_some() {break;}
        }
        walls.extend(stood.map(|plate|(plate,None)));
    } else {
        // Each plate it fires through has a port cut in it, at whatever angle the bore meets it, as wide as the sweep is
        // there; one that does not fit in its plate is refused.
        for (plate,from,to) in fired_through(frame,pose,barrel,min,max) {
            let(a,b)=local(plate);
            let port=crate::game_mounts::wall_port(a,b,plate.thickness/1000.0,barrel,from,to,shield.unwrap())
                .ok_or_else(||json!({"code":"MOUNT_PORT","ids":[plate.id]}))?;
            walls.push((plate,Some((port,from,to))));
        }
    }
    if let Some((first,_))=walls.first() {projection["hostOwner"]=json!(first.owner);projection["hostId"]=json!(first.id);}
    projection["walls"]=json!(walls.iter().map(|(plate,cut)|{
        let(a,b)=local(plate);
        let mut wall=json!({"owner":plate.owner,"wallId":plate.id,"thicknessMm":plate.thickness,"a":a.to_value(),"b":b.to_value()});
        if let Some((port,from,to))=cut {wall["port"]=json!({"lo":port.lo,"hi":port.hi,"centerU":port.center,"min":from,"max":to});}
        wall
    }).collect::<Vec<_>>());
    let hosts:Vec<u32>=walls.iter().map(|(plate,_)|plate.owner).collect();
    let ports=walls.iter().filter_map(|(plate,cut)|cut.map(|(port,_,_)|(plate.owner,(port.lo,port.hi)))).collect();
    let moving=mount.polygons(width,height,barrel).into_iter().enumerate()
        .filter(|(i,_)|*i>0&&!crate::game_mounts::role(exposed,*i).fixed()).map(|(_,p)|p).collect::<Vec<_>>();
    let occupancy=WeaponOccupancy{pose,breech:if exposed{Vec::new()}else{breech(width,height,&stroke,axis,min,max)},
        fixed:mount.fixed_polygons(),moving,min,max};
    for plate in &frame.plates {
        let(a,b)=frame.ends(plate);let solid=frame.solid(plate,0.0);let clear=frame.solid(plate,CLEARANCE);
        let conflict=if hosts.contains(&plate.owner){
            // The post of an exposed mount stands on its plate; the gun on it swings a clearance clear of that.
            if exposed{occupancy.crosses(&solid,&clear)}else{
                // Only a port lets the moving barrel/mantlet through a plate; the breech stays behind it.
                occupancy.breech_meets(&clear).is_some()
            }
        }else{occupancy.mechanism_crosses(&clear,&clear)};
        if conflict{
            if let Some(angle)=occupancy.breech_meets(&clear){return Err(json!({"code":"BREECH_PLATE","ids":[plate.id],"surface":side(a,b,point),"angleDegrees":degrees(axis+angle),
                "ready":crate::game_variant::compartment(weapon).is_some()}));}
            // A gun of an aircraft that turns into its skids reaches under them (`AIRCRAFT_CLEARANCE`).
            if matches!(plate.part,Some(("skid"|"leg",_))) {return Err(json!({"code":"AIRCRAFT_CLEARANCE","ids":[part["id"]],"gun":true}));}
            return Err(json!({"code":"WEAPON_SWEEP","ids":[plate.id]}));
        }
    }
    let physical=mount.fixed_properties(num(weapon,"installedMassKg",None,0.0,1e8)?,width,height,barrel);
    Ok(Mount{geometry:mount,projection,occupancy,ports,physical})
}
/// The plates a barrel turned from `min` to `max` about its trunnion fires through, the nearest to the trunnion first,
/// each with the stretch of the sector that fires through it: every plate the barrel itself passes through, over the
/// angles at which it does, and the walls of its own compartment its line of fire leaves by, over the angles at which
/// the bore meets that wall first. A plate past these a shot meets as armour; a gun on an open platform, or out in the
/// open, fires through none but those its barrel passes through.
fn fired_through(frame:&Frame,pose:Pose,barrel:BarrelProfile,min:f64,max:f64)->Vec<(&Plate,f64,f64)> {
    let tube=corners(Bounds{min_x:0.0,max_x:barrel.end,min_y:-barrel.radius,max_y:barrel.radius});
    let local=|plate:&Plate|frame.solid(plate,0.0).iter().map(|&p|pose.local_point(p)).collect::<Vec<_>>();
    let nearest=|solid:&[Point]|if inside(solid,Point::ZERO) {0.0} else {
        (0..solid.len()).map(|i|segment_distance(Point::ZERO,solid[i],solid[(i+1)%solid.len()])).fold(f64::INFINITY,f64::min)};
    // The sector in small steps, its ends as they are: a plate takes from the first step at which it is fired through
    // to the last.
    let steps=((max-min)/0.005).ceil().max(1.0) as usize;
    let angle=|i:usize|if i==steps {max} else {min+(max-min)*i as f64/steps as f64};
    let mut fired:Vec<(f64,&Plate,f64,f64)>=frame.plates.iter().filter_map(|plate|{
        let solid=local(plate);
        if !swept_polygon_intersects(&tube,min,max,&solid) {return None;}
        let crossing:Vec<usize>=(0..steps).filter(|&i|swept_polygon_intersects(&tube,angle(i),angle(i+1),&solid)).collect();
        Some((nearest(&solid),plate,angle(*crossing.first()?),angle(crossing.last()?+1)))
    }).collect();
    // The walls of the room the trunnion stands in that its line of fire leaves by: the bore is followed out at each
    // step to the first wall of the room it meets, and each wall met takes the angles at which it is, a step more to
    // either side where the next angle meets another wall.
    let trunnion=Point::new(pose.x,pose.y);
    if let Some(room)=frame.rooms.iter().find(|room|inside(&room.vertices,trunnion)) {
        let met:Vec<Option<u32>>=(0..=steps).map(|i|{
            let ray=Point::new(cos(angle(i)),sin(angle(i)));
            room.walls.iter().filter_map(|wall|{
                let(a,b)=(pose.local_point(wall.a),pose.local_point(wall.b));let edge=sub(b,a);
                let cross=ray.x*edge.y-ray.y*edge.x;
                if cross.abs()<1e-12 {return None;}
                let(t,u)=((a.x*edge.y-a.y*edge.x)/cross,(a.x*ray.y-a.y*ray.x)/cross);
                (t>0.0&&(-1e-9..=1.0+1e-9).contains(&u)).then_some((t,wall.owner))
            }).min_by(|x,y|x.0.total_cmp(&y.0)).map(|(_,owner)|owner)
        }).collect();
        for plate in &frame.plates {
            let hits:Vec<usize>=(0..=steps).filter(|&i|met[i]==Some(plate.owner)).collect();
            let(Some(&first),Some(&last))=(hits.first(),hits.last()) else{continue};
            let(from,to)=(angle(first.saturating_sub(usize::from(first>0))),angle((last+usize::from(last<steps)).min(steps)));
            // One the barrel passes through too is fired through over both stretches.
            match fired.iter_mut().find(|(_,other,..)|other.owner==plate.owner) {
                Some(crossed)=>{crossed.2=crossed.2.min(from);crossed.3=crossed.3.max(to);}
                None=>fired.push((nearest(&local(plate)),plate,from,to)),
            }
        }
    }
    fired.sort_by(|a,b|a.0.total_cmp(&b.0));
    fired.into_iter().map(|(_,plate,from,to)|(plate,from,to)).collect()
}

/// The same finite sweep rule serves compilation and cold re-admission, including free mounts.
pub(crate) fn mount_plate_conflict(value:&Value,mount:&crate::game_mounts::WeaponMount,weapon:&Value,plate_pose:Pose,length:f64,thickness:f64,host:bool)->Result<bool,String>{
    let raw=&value["weaponMount"];
    let width=value["width"].as_f64().ok_or("Missing mounted receiver width")?;let height=value["height"].as_f64().ok_or("Missing mounted receiver height")?;
    let barrel=BarrelProfile::from_value(value)?;
    let occupancy=WeaponOccupancy{pose:Pose::from_value(value),min:mount.min,max:mount.max,
        breech:if mount.exposed{Vec::new()}else{breech(width,height,&Stroke::from_weapon(weapon)?,raw["hullAxis"].as_f64().ok_or("Missing construction gun axis")?,mount.min,mount.max)},
        moving:mount.polygons(width,height,barrel).into_iter().enumerate()
            .filter(|(i,_)|*i>0&&!crate::game_mounts::role(mount.exposed,*i).fixed()).map(|(_,p)|p).collect(),fixed:Vec::new()};
    let solid=rectangle(length,thickness).into_iter().map(|p|plate_pose.world_point(p)).collect::<Vec<_>>();
    let clear=rectangle(length+2.0*CLEARANCE,thickness+2.0*CLEARANCE).into_iter().map(|p|plate_pose.world_point(p)).collect::<Vec<_>>();
    Ok(if host&&!mount.exposed{occupancy.breech_meets(&clear).is_some()}else if host{occupancy.crosses(&solid,&clear)}else{occupancy.intersects(&clear)})
}

/// A new mobile radar uses the compact reference. Unlabelled saved radars retain their original envelope and mass.
fn sensor_spec<'a>(catalogue:&'a Value,part:&Value)->Result<&'a Value,Value> {
    let mode=named(part,"sensorMode","visual")?;
    let spec=catalogue["sensors"].get(mode).filter(|size|size.is_object())
        .ok_or_else(||context("field","sensorMode",json!({"code":"SENSOR_MODE","value":mode})))?;
    if mode=="radar" {
        match named(part,"radarModel","legacy")? {
            "mobile"=>Ok(spec),"legacy"=>Ok(spec.get("legacy").filter(|value|value.is_object()).unwrap_or(spec)),
            _=>Err(told(part,"radarModel",reject("FIELD"))),
        }
    } else if part.get("radarModel").is_some() {Err(told(part,"radarModel",reject("FIELD")))}else{Ok(spec)}
}
pub(crate) fn sensor_dimensions(catalogue:&Value,part:&Value)->Result<(f64,f64,f64),Value> {
    let size=sensor_spec(catalogue,part)?;
    Ok((num(size,"width",None,0.05,4.0)?,num(size,"height",None,0.05,4.0)?,num(size,"depthM",None,0.05,BODY_WIDTH)?))
}

fn fresh_component(module:&mut Value,kind:ComponentKind,catalogue:&Value,mount:Option<&Mount>,depth:f64)->Result<(),Value> {
    let width=module["width"].as_f64().unwrap();let height=module["height"].as_f64().unwrap();
    let armour=kind.armour_mass(width,height,num(module,"armorMm",Some(0.0),0.0,kind.armour_limit())?);
    let volume=width*height*depth;
    // Another metal than steel, glass fibre or plastic makes the piece lighter and weaker or stronger: its armour, its fuel and
    // its load stay what they are.
    let metal=crate::game_geometry::metal(kind,module)?;
    let mut health=kind.health()*metal.health;
    let mass=match kind {
        ComponentKind::Engine=>{
            module["powerKw"]=json!(crate::game_motion::engine_power_kw(volume));
            880.0*volume/(1.05*0.64*0.65)*metal.mass
        },
        // A tool tells the power it takes from the engines of its construction while it works; a paver, the room of the
        // hopper built into it besides, which comes empty as a hopper does.
        // A thruster tells the most it pushes with.
        ComponentKind::Thruster=>{
            module["thrustN"]=json!(kind.thrust_n(volume));
            kind.empty_mass(volume)*metal.mass
        },
        ComponentKind::Excavator|ComponentKind::Drill|ComponentKind::Builder|ComponentKind::Blade|ComponentKind::Paver=>{
            module["workKw"]=json!(kind.work_power_kw(volume));
            if kind.carrier() {module["capacityM3"]=json!(kind.cargo_room(volume));}
            kind.empty_mass(volume)*metal.mass
        },
        // Only the housing of a sensor or of a command post is of its material (`housing`); what is in it weighs as it does.
        // It stands a hit as its housing does.
        ComponentKind::Command|ComponentKind::Sensor=>{
            let (share,_)=kind.housing(module["sensorMode"].as_str().unwrap_or("visual"));
            let steel=if kind==ComponentKind::Command {8.0} else {num(sensor_spec(catalogue,module)?,"mass",None,0.0,1e6)?};
            if metal.name=="steel" {steel} else {steel*(1.0-share+share*metal.mass)}
        },
        ComponentKind::Wheel=>110.0*ComplexField::powf(height/0.74,2.5)*metal.mass+armour,
        ComponentKind::Track=>2800.0*(width/5.04)*ComplexField::powf(height/0.74,1.5)*metal.mass+armour,
        ComponentKind::Weapon=>{
            let preset=module["weaponPreset"].as_str().unwrap();let weapon=&catalogue["weapons"][preset];
            let (h,receiver,barrel)=match weapon["family"].as_str().unwrap_or("") {
                "machinegun"=>(if num(weapon,"caliberMm",None,0.1,300.0)?>=12.0{220.0}else{120.0},8.0,5.0),
                "autocannon"=>(400.0,35.0,14.0),"cannon"=>(900.0,70.0,22.0),
                "rocket"=>(200.0,10.0,6.0),"grenade"=>(260.0,18.0,9.0),
                "mortar"=>(280.0,18.0,12.0),"howitzer"=>(1000.0,70.0,22.0),
                _=>return Err(reject("WEAPON_DURABILITY")),
            };
            health=h;module["barrelProfile"]=BarrelProfile::from_weapon(weapon).map_err(|_|reject("WEAPON_BARREL"))?.to_value();module["receiverMm"]=json!(receiver);module["barrelMm"]=json!(barrel);
            mount.ok_or_else(||reject("WEAPON_MOUNT"))?.physical.0
        },
        // A fuel tank and an ammunition box are built full.
        ComponentKind::Fuel|ComponentKind::Ammo=>{
            let shell=2.0*(width*height+(width+height)*depth)*(if kind==ComponentKind::Fuel{0.002}else{0.003})*7800.0*metal.mass;
            if kind==ComponentKind::Fuel {
                let capacity=volume*0.78*1000.0;
                module["capacityLitres"]=json!(capacity);module["fuelLitres"]=json!(capacity);
                shell+capacity*0.835
            } else {
                let preset=module["ammoPreset"].as_str().ok_or_else(||reject("AMMUNITION_PRESET"))?;
                let cartridge=&crate::game_weapons::cartridge(&catalogue["weapons"][preset],module["ammoType"].as_str().unwrap_or(""));
                let mass=num(cartridge,"massKg",None,0.001,10000.0)?;
                let litres=num(cartridge,"litres",None,0.00001,1000.0)?;
                let capacity=crate::game_geometry::ammunition_capacity(volume,litres);
                if capacity>u32::MAX as f64 {return Err(reject("AMMUNITION_CAPACITY"));}
                module["capacityRounds"]=json!(capacity as u32);module["rounds"]=json!(capacity as u32);module["roundMass"]=json!(mass);
                shell+capacity*mass
            }
        },
        // A hopper, a cistern and a supply piece come empty: what they carry is taken on in the field.
        ComponentKind::Hopper|ComponentKind::Cistern|ComponentKind::Supply=>{
            module["capacityM3"]=json!(kind.cargo_room(volume));
            kind.empty_mass(volume)*metal.mass
        },
    };
    if !mass.is_finite() || mass>1e9 {return Err(reject("COMPONENT_MASS"));}
    module["health"]=json!(health);module["maxHealth"]=json!(health);module["physicalMass"]=json!(mass);
    module["mechanicalDepth"]=json!(depth);
    Ok(())
}

struct Placed {
    module: Value,
    canonical: Value,
    occupancy: Occupancy,
    /// The stretches cut out of the plates a gun fires through, by plate.
    ports: Vec<(u32,(f64,f64))>,
    /// The steel column it stands on or hangs from off the metal that holds it, if it has one (`stand_off`).
    column: Option<Polygon>,
}
fn position(part:&Value,frame:&Frame,catalogue:&Value,owner:u32,fed:&BTreeMap<String,String>)->Result<Placed,Value> {
    let name=id(part,"id")?;let type_name=part["kind"].as_str().ok_or_else(|| told(part,"kind",reject("COMPONENT_KIND")))?;
    let kind=ComponentKind::from_name(type_name).map_err(|_|told(part,"kind",reject("COMPONENT_KIND")))?;
    if kind.gear() {return Err(told(part,"kind",reject("CHASSIS_GEAR")));}
    let allowed: &[&str] = match kind {
        ComponentKind::Weapon => &["id","kind","weaponPreset","weaponAmmo","pose","mount"],
        ComponentKind::Sensor => &["id","kind","sizeScale","sensorMode","radarModel","metal","pose"],
        ComponentKind::Ammo => &["id","kind","sizeScale","ammoPreset","metal","pose"],
        _ => &["id","kind","sizeScale","metal","pose"],
    };
    fields(part,allowed)?;
    let p=&part["pose"];fields(p,&["x","y","angle","mirrored"]).map_err(|e|within("pose",None,e))?;
    let coordinate=|e|within("pose",None,e);
    let (x,y)=(num(p,"x",None,-(POSE_REACH as f64),POSE_REACH as f64).map_err(coordinate)?,num(p,"y",None,-(POSE_REACH as f64),POSE_REACH as f64).map_err(coordinate)?);
    let point=add(frame.origin,at_units(x,y));
    let mut authored_angle=num(p,"angle",Some(0.0),-PI,PI).map_err(coordinate)?;
    // A thruster pushes the way it points in the hull, which is one of eight, 45° apart: written as the very eighth of a
    // turn it is nearest, and refused off them.
    if kind==ComponentKind::Thruster {
        let eighths=(authored_angle/THRUSTER_TURN).round();
        if (authored_angle-eighths*THRUSTER_TURN).abs()>1e-6 {return Err(within("pose",None,told(p,"angle",reject("THRUSTER_ANGLE"))));}
        authored_angle=eighths*THRUSTER_TURN;
    }
    let mirrored=match p.get("mirrored"){Some(value)=>value.as_bool().ok_or_else(||coordinate(told(p,"mirrored",reject("FIELD"))))?,None=>false};
    let angle=authored_angle+if kind==ComponentKind::Weapon&&mirrored{PI}else{0.0};
    let mut canonical=part.clone();
    let (base_w,base_h,base_d)=if kind==ComponentKind::Sensor {sensor_dimensions(catalogue,part)?}
        else {kind.dimensions()};
    let (width,height,depth)=if kind==ComponentKind::Weapon {
        let preset=named(part,"weaponPreset","rh120")?;
        let weapon=&catalogue["weapons"][preset];
        if !weapon.is_object() {return Err(unknown(part,"weaponPreset"));}
        canonical["weaponPreset"]=json!(preset);
        let (width,height)=receiver_dimensions(weapon).map_err(|_|reject("WEAPON_RECEIVER"))?;
        (width,height,base_d)
    } else {
        // Its size makes it longer and taller; across the body it is as deep as its kind (`installed_depth`).
        let least=if matches!(kind,ComponentKind::Sensor|ComponentKind::Command){1.0}else{0.25};
        let scale=num(part,"sizeScale",Some(1.0),least,kind.largest_scale())?;
        canonical["sizeScale"]=json!(scale);
        (base_w*scale,base_h*scale,crate::game_geometry::installed_depth(kind,base_d,scale))
    };
    // What it is made of, of what its kind may be (`ComponentKind::metals`); steel is the one that is not written.
    crate::game_geometry::metal(kind,part).map_err(|_|told(part,"metal",reject("FIELD")))?;
    if part["metal"]=="steel" {canonical.as_object_mut().unwrap().remove("metal");}
    canonical["pose"]=json!({"x":p["x"],"y":p["y"],"angle":authored_angle});
    if mirrored{canonical["pose"]["mirrored"]=json!(true);}
    let pose=Pose{x:point.x,y:point.y,angle};
    let footprint=rectangle(width,height).into_iter().map(|p|pose.world_point(p)).collect::<Polygon>();
    // Equipment may stand out of the construction box to the sides and over it, never under its floor.
    if footprint.iter().any(|p|p.y<frame.origin.y+metres(FLOOR)-EPS) {return Err(within("pose",None,outside("below")));}
    let mount=if kind==ComponentKind::Weapon {
        let preset=canonical["weaponPreset"].as_str().unwrap();
        Some(derive_mount(part,frame,point,angle,&catalogue["weapons"][preset],catalogue,(width,height),mirrored)?)
    }else{None};
    if mount.as_ref().is_some_and(|mount|mount.occupancy.fixed.iter().flatten()
        .any(|&p|mount.occupancy.pose.world_point(p).y<frame.origin.y+metres(FLOOR)-EPS)) {
        return Err(within("pose",None,outside("below")));
    }

    let occupancy=if let Some(mount)=&mount{Occupancy::Weapon(mount.occupancy.clone())}else{
        if let Some(plate)=frame.plates.iter().find(|plate|intersection_area(&footprint,&frame.solid(plate,0.0))>1e-12){
            return Err(json!({"code":"COMPONENT_PLATE","ids":[plate.id]}));
        }
        Occupancy::Fixed(footprint)
    };
    if let Some(mount)=&mount{
        let raw=&mount.projection;
        canonical["mount"]=json!({"preset":raw["preset"],"sector":{"min":if mirrored{-raw["max"].as_f64().unwrap()}else{raw["min"].as_f64().unwrap()},
            "max":if mirrored{-raw["min"].as_f64().unwrap()}else{raw["max"].as_f64().unwrap()}}});
        if let Some(shield)=raw["shield"].as_object(){canonical["mount"]["radiusM"]=shield["radius"].clone();}
    }
    let mut module=json!({"id":name,"kind":type_name,"owner":owner,"x":point.x,"y":point.y,"angle":angle,
        "width":width,"height":height,"mountId":null,"attached":true});
    if mirrored{module["mirrored"]=json!(true);}
    let outside=!frame.rooms.iter().any(|room|inside(&room.vertices,point));
    for key in ["weaponPreset","sensorMode","ammoPreset","metal"] {
        if let Some(value)=canonical.get(key) {module[key]=value.clone();}
    }
    if kind==ComponentKind::Weapon {
        // The ammunition the gun is fed, chosen in the workshop and kept in the field; the first its feed takes is
        // the one that is not written.
        let feed=catalogue["weapons"][module["weaponPreset"].as_str().unwrap()]["allowedAmmo"].as_array()
            .filter(|feed|!feed.is_empty()).ok_or_else(||reject("AMMUNITION_FEED"))?;
        let ammo=part.get("weaponAmmo").unwrap_or(&feed[0]);
        if !ammo.is_string() || !feed.contains(ammo) {return Err(told(part,"weaponAmmo",json!({"code":"WEAPON_AMMUNITION","accepted":feed})));}
        if *ammo==feed[0] {canonical.as_object_mut().unwrap().remove("weaponAmmo");}
        else {canonical["weaponAmmo"]=ammo.clone();}
        module["weaponAmmo"]=ammo.clone();
    }
    if kind==ComponentKind::Sensor {
        let mode=named(part,"sensorMode","visual")?;
        if !matches!(mode,"visual"|"radar"|"sound") {return Err(told(part,"sensorMode",reject("SENSOR_MODE")));}
        canonical["sensorMode"]=json!(mode);module["sensorMode"]=json!(mode);
        if mode=="radar" {
            let model=named(part,"radarModel","legacy")?;
            canonical["radarModel"]=json!(model);module["radarModel"]=json!(model);
        }
    }
    if kind==ComponentKind::Ammo {
        let preset=named(part,"ammoPreset","rh120")?;
        // A box holds rounds of a cartridge: of a gun as the catalogue has it, or of one made over to another calibre or
        // charge, never of a barrel.
        if !catalogue["weapons"][preset].is_object()||crate::game_variant::cartridge(preset)!=preset {return Err(unknown(part,"ammoPreset"));}
        canonical["ammoPreset"]=json!(preset);module["ammoPreset"]=json!(preset);
        // A box carries the rounds its calibre's guns are fed; one no gun fires, the first they would take.
        let ammo=match fed.get(preset) {
            Some(ammo)=>ammo.as_str(),
            None=>catalogue["weapons"][preset]["allowedAmmo"][0].as_str().ok_or_else(||reject("AMMUNITION_FEED"))?,
        };
        module["ammoType"]=json!(ammo);
    }
    // What stands out in the open shows to whoever looks at the construction from outside, and is struck with no
    // armour before it.
    if outside {module["exposed"]=json!(true);}
    let ports=mount.as_ref().map_or(Vec::new(),|m|m.ports.clone());
    if let Some(mount)=&mount {
        // An enclosed barrel rests along its axis; an exposed one, which turns over its face, level towards the front.
        let rest=if mount.projection["exposed"]==true {crate::game_weapons::angle_difference(if mirrored{0.0}else{PI},angle)} else {0.0};
        let offset=rest.clamp(mount.projection["min"].as_f64().unwrap(),mount.projection["max"].as_f64().unwrap());
        module["weaponMount"]=mount.projection.clone();module["aimOffset"]=json!(offset);
        module["barrelAngle"]=json!(angle+offset);module["targetBarrelAngle"]=module["barrelAngle"].clone();
    }
    fresh_component(&mut module,kind,catalogue,mount.as_ref(),depth)?;
    let (center,inertia)=mount.as_ref().map_or_else(|| {
        let mass=module["physicalMass"].as_f64().unwrap();
        (Point::ZERO,mass*(width*width+height*height)/12.0)
    },|m|(m.physical.1,m.physical.2));
    module["physicalCenterLocal"]=center.to_value();module["physicalInertia"]=json!(inertia);
    if kind==ComponentKind::Weapon {
        let shapes=mount.as_ref().unwrap().geometry.polygons(width,height,BarrelProfile::from_value(&module)?);
        module["materialPolygons"]=json!(shapes.iter().map(|p|p.iter().map(|p|p.to_value()).collect::<Vec<_>>()).collect::<Vec<_>>());
    }
    Ok(Placed{module,canonical,occupancy,ports,column:None})
}

/// Area, centre and polar second moment of the material left in a plate. The
/// grid covers exactly the plate, so each cell that still holds material
/// counts whole: a sum of rectangles, with nothing to clip. This runs for
/// every plate on every edit of a construction.
fn material_properties(grid:&MaterialGrid)->MassProperties {
    let mut result=MassProperties::default();
    for y in 0..grid.ny {for x in 0..grid.nx {
        if !grid.occupied(x,y) {continue;}
        let cell=grid.cell_bounds(x,y);let (w,h)=(cell.max_x-cell.min_x,cell.max_y-cell.min_y);let area=w*h;
        let center=Point::new((cell.min_x+cell.max_x)/2.0,(cell.min_y+cell.max_y)/2.0);
        result.area+=area;result.center=add(result.center,mul(center,area));
        result.second+=area*(center.dot(center)+(w*w+h*h)/12.0);
    }}
    if result.area>0.0 {result.center=mul(result.center,1.0/result.area);}
    result
}

fn fixed_assembly_properties(plates:&[Value],modules:&[Value],origin:Point)->Value {
    let mut mass=0.0;let mut first=Point::ZERO;let mut second=0.0;
    for value in plates.iter().chain(modules) {
        let m=value["physicalMass"].as_f64().unwrap();
        let pose=Pose{x:value["x"].as_f64().unwrap(),y:value["y"].as_f64().unwrap(),angle:value["angle"].as_f64().unwrap()};
        let local=Point::from_value(&value["physicalCenterLocal"]);
        let c=sub(pose.world_point(local),origin);
        mass+=m;first=add(first,mul(c,m));second+=value["physicalInertia"].as_f64().unwrap()+m*c.dot(c);
    }
    let center=if mass>0.0 {mul(first,1.0/mass)}else{Point::ZERO};
    json!({"origin":origin.to_value(),"mass":mass,"centerLocal":center.to_value(),
        "inertia":(second-mass*center.dot(center)).max(0.0)})
}
/// What a piece weighs empty, and with all it holds full: a tank with all the fuel it takes, a magazine with all the
/// rounds, a hopper, a cistern or a supply piece with all of the heaviest it carries, and a paver with all its mix
/// (`ComponentKind::cargo_limit`).
fn reserves(module:&Value)->(f64,f64) {
    let number=|key:&str|module[key].as_f64().unwrap_or(0.0);let mass=number("physicalMass");
    match ComponentKind::from_name(module["kind"].as_str().unwrap_or("")).ok() {
        Some(ComponentKind::Fuel)=>{let dry=mass-number("fuelLitres")*0.835;(dry,dry+number("capacityLitres")*0.835)},
        Some(ComponentKind::Ammo)=>{let dry=mass-number("rounds")*number("roundMass");(dry,dry+number("capacityRounds")*number("roundMass"))},
        Some(kind) if kind.carrier()=>(mass,mass+kind.cargo_limit(number("capacityM3"))),
        _=>(mass,mass),
    }
}

// Manufacturing support is derived from fresh metal and its enclosures, never an authored graph or live joints.
struct SupportBody { id:String, shapes:Vec<Polygon>, rooted:bool }
fn support_touch(a:&[Point],b:&[Point])->bool {
    // Convex body surfaces: touching is enough; the margin is numerical, not a hidden stand or weld reach.
    [a,b].into_iter().all(|poly|poly.iter().enumerate().all(|(i,&p)|{
        let edge=sub(poly[(i+1)%poly.len()],p);let n=Point::new(-edge.y,edge.x);
        let range=|shape:&[Point]|shape.iter().map(|p|p.dot(n)).fold((f64::INFINITY,f64::NEG_INFINITY),|(lo,hi),x|(lo.min(x),hi.max(x)));
        let(x,y)=(range(a),range(b));x.0<=y.1+EPS*hypot(n.x,n.y)&&y.0<=x.1+EPS*hypot(n.x,n.y)
    }))
}
fn support_plate(value:&Value)->Vec<Polygon> {
    // Fresh compiler grids differ only by through-port columns; damage is never an input here.
    let grid=MaterialGrid::from_value(&value["ballisticGrid"]).expect("compiled plate grid");let pose=Pose::from_value(value);
    let mut shapes=Vec::new();let mut x=0;
    while x<grid.nx {
        if !grid.occupied(x,0) {x+=1;continue;}
        let start=x;while x<grid.nx&&grid.occupied(x,0){x+=1;}
        let(a,b)=(grid.cell_bounds(start,0),grid.cell_bounds(x-1,grid.ny-1));
        shapes.push(corners(Bounds{min_x:a.min_x,max_x:b.max_x,min_y:a.min_y,max_y:b.max_y})
            .into_iter().map(|p|pose.world_point(p)).collect());
    }
    shapes
}
/// Factory dimensions use actual material in the project's structural axes.
/// A gun's aiming sector and recoil clearance are empty space, not its size;
/// its barrel/receiver are measured at the authored mounting axis instead.
fn manufacturing_envelope(bodies:&[Metal],placed:&[Placed],running:&[Polygon])->Value {
    let mut bounds=Bounds::empty();
    let mut include=|polygon:&[Point]|{for &point in polygon {bounds.include(point);}};
    // Reuse the plate stock and complete physical chassis outline used by support admission.
    for body in bodies.iter().filter(|body|!body.piece) {for polygon in &body.shapes {include(polygon);}}
    for part in placed {
        match &part.occupancy {
            Occupancy::Fixed(polygon)=>include(polygon),
            Occupancy::Weapon(_)=>{
                let pose=Pose::from_value(&part.module);
                for polygon in crate::array(&part.module,"materialPolygons") {
                    let posed:Vec<_>=polygon.as_array().expect("compiled material polygon").iter()
                        .map(|point|pose.world_point(Point::from_value(point))).collect();
                    include(&posed);
                }
            }
        }
        if let Some(column)=&part.column {include(column);}
    }
    for polygon in running {include(polygon);}
    let (length,height)=if bounds.min_x.is_finite() {(bounds.max_x-bounds.min_x,bounds.max_y-bounds.min_y)}else{(0.0,0.0)};
    json!({"lengthM":length,"heightM":height})
}
struct SupportSite { pose:Pose, facing:f64, ground:Vec<Point>, clearance:f64 }
impl SupportSite {
    fn read(value:&Value)->Result<Self,Value> {
        fields(value,&["pose","facing","ground","clearance"])?;
        if value.get("pose").is_none()||value.get("ground").is_none(){return Err(reject("SUPPORT_SITE_REQUIRED"));}
        fields(&value["pose"],&["x","y","angle"])?;
        let p=&value["pose"];let pose=Pose{x:num(p,"x",None,-1e6,1e6)?,y:num(p,"y",None,-1e6,1e6)?,angle:num(p,"angle",Some(0.0),-PI,PI)?};
        let facing=num(value,"facing",None,-1.0,1.0)?;if facing.abs()!=1.0{return Err(reject("SUPPORT_SITE"));}
        // Only the existing cold-placement skin is permitted against terrain; it never connects two parts.
        let clearance=num(value,"clearance",None,0.0,0.04)?;
        let ground=array(value,"ground",4096)?.iter().map(|p|{
            fields(p,&["x","y"])?;Ok(Point::new(num(p,"x",None,-1e6,1e6)?,num(p,"y",None,-1e6,1e6)?))
        }).collect::<Result<Vec<_>,Value>>()?;
        if ground.len()<2||ground.windows(2).any(|p|p[0].x>=p[1].x){return Err(reject("SUPPORT_SITE"));}
        Ok(Self{pose,facing,ground,clearance})
    }
    fn world(&self,p:Point)->Point {self.pose.world_point(Point::new(-self.facing*(p.x-CONSTRUCTION_ORIGIN.x),p.y-CONSTRUCTION_ORIGIN.y))}
    fn grounded(&self,shape:&[Point])->bool {
        let shape:Vec<_>=shape.iter().map(|&p|self.world(p)).collect();
        shape.iter().enumerate().any(|(i,&a)|{
            let b=shape[(i+1)%shape.len()];self.ground.windows(2).any(|ground|{
                let(c,d)=(ground[0],ground[1]);let(lo,hi)=(a.x.min(b.x).max(c.x),a.x.max(b.x).min(d.x));
                if lo>hi+EPS{return false;}
                let gap=|x:f64|{
                    let y=if (b.x-a.x).abs()<EPS{a.y.min(b.y)}else{a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x)};
                    y-(c.y+(d.y-c.y)*(x-c.x)/(d.x-c.x))
                };
                let near=gap(lo).min(gap(hi));near>=-EPS&&near<=self.clearance+EPS
            })
        })
    }
}
/// What of a piece stays where it was put, in the field: the whole of a piece but a gun; of a gun its two fixed feet, in
/// the fixed pose of its mount, never its moving receiver, or the whole post of an exposed one.
fn fixed_shapes(part:&Placed)->Vec<Polygon> {
    match &part.occupancy {
        Occupancy::Fixed(polygon)=>vec![polygon.clone()],
        Occupancy::Weapon(weapon)=>weapon.fixed.iter().map(|shape|shape.iter().map(|&p|weapon.pose.world_point(p)).collect()).collect(),
    }
}

// What holds a piece out in the open off the metal it bears on. A camera, a radar or a microphone stands on a column
// down to the first metal under it, and a blade hangs from one up to the first metal over it, along the piece as it
// stands in its construction, `STANDOFF` long at most; a sensor that touches metal beside it is held there as it is.
// The column is as wide as its flange and its cradle (`column_width`), its foot laid on the face it meets at whatever
// angle that lies; it crosses no other metal on its way, nor running gear. It is the steel of its piece: it weighs with
// it, is paid with it and is struck as it is. The workshop and the field draw it from what is told here (`support`).
const STANDOFF:f64=crate::game_mounts::STANDOFF;
/// How wide the column a piece stands on or hangs from is, across the side view, for a piece this wide: a blade hangs
/// from the lift group of a motor grader, its saddle and its rams; a sensor stands on a mast.
fn column_width(kind:ComponentKind,width:f64)->f64 {
    if kind==ComponentKind::Blade {0.3*width} else {(0.375*width).clamp(0.06,0.2)}
}
/// The steel of a column, by the metre of it, as wide as it is (`column_width`): a square tube of `MAST` of that, its
/// walls a sixteenth as thick as it is wide.
const MAST:f64=0.45;
fn column_section(width:f64)->f64 {let tube=MAST*width;tube*tube*(1.0-(1.0-2.0/16.0)*(1.0-2.0/16.0))}
struct Standoff {
    /// What it bears on.
    host:String,
    /// Where it meets that, from its rear to its front, and the normal of the face there towards the piece, all in the
    /// frame of the piece.
    foot:[Point;2],
    normal:Point,
    /// How far its column reaches from the piece to the face, along its middle: none for a piece held where it touches
    /// beside it.
    reach:Option<f64>,
    /// The column, in the frame of the piece, unless it reaches no way.
    column:Option<Polygon>,
}
/// Metal a column may meet, by its id.
struct Metal {
    id:String,
    shapes:Vec<Polygon>,
    /// Another piece, not a plate nor the frame of a chassis.
    piece:bool,
}
/// The metal a column may meet: the material left of each plate, the frame of a chassis as the chassis is called, and
/// what of each piece stays where it was put.
fn metal_bodies(frame:&Frame,placed:&[Placed],plates:&[Value],chassis:Option<&Chassis>)->Vec<Metal> {
    let mut bodies:Vec<_>=plates.iter().zip(&frame.plates).map(|(value,plate)|Metal{id:plate.id.clone(),shapes:support_plate(value),piece:false}).collect();
    if let Some(chassis)=chassis {bodies.push(Metal{id:frame.plates[frame.root].id.clone(),shapes:chassis.support_shapes(frame.origin),piece:false});}
    bodies.extend(placed.iter().map(|part|Metal{id:part.module["id"].as_str().unwrap().to_owned(),shapes:fixed_shapes(part),piece:true}));
    bodies
}
/// What may hold a piece, the first preferred: none for a piece that stands off nothing.
fn standoffs(part:&Placed,bodies:&[Metal],gear:&[Polygon])->Vec<Standoff> {
    let module=&part.module;let own=module["id"].as_str().unwrap();
    let Ok(kind)=ComponentKind::from_name(module["kind"].as_str().unwrap()) else{return Vec::new()};
    if !matches!(kind,ComponentKind::Sensor|ComponentKind::Blade)||module["exposed"]!=true {return Vec::new();}
    let Occupancy::Fixed(piece)=&part.occupancy else{return Vec::new()};
    let pose=Pose::from_value(module);let(width,height)=(module["width"].as_f64().unwrap(),module["height"].as_f64().unwrap());
    let others=||bodies.iter().filter(|metal|metal.id!=own);
    // What it touches, and of that where it touches best: a plate or a chassis before another piece, then the longest
    // stretch, then the nearest to its middle.
    let mut touched=HashSet::new();let mut contact:Option<(bool,f64,f64,Standoff)>=None;
    for Metal{id,shapes,piece:other} in others() {for shape in shapes {
        if !support_touch(shape,piece) {continue;}
        touched.insert(id.clone());
        let turn=if crate::game_geometry::signed_area(shape)>=0.0 {1.0} else {-1.0};
        for (i,&a) in shape.iter().enumerate() {
            let edge=sub(shape[(i+1)%shape.len()],a);let length=hypot(edge.x,edge.y);if length<=EPS {continue;}
            let along=mul(edge,1.0/length);let out=mul(Point::new(along.y,-along.x),turn);
            let depth=|p:&Point|sub(*p,a).dot(out);
            let least=piece.iter().map(depth).fold(f64::INFINITY,f64::min);
            if least.abs()>1e-6 {continue;}
            let spots:Vec<f64>=piece.iter().filter(|p|depth(p)<=least+1e-6).map(|p|sub(*p,a).dot(along)).collect();
            let lo=spots.iter().copied().fold(f64::INFINITY,f64::min).max(0.0);
            let hi=spots.iter().copied().fold(f64::NEG_INFINITY,f64::max).min(length);
            if lo>hi+1e-6 {continue;}
            let(from,to)=(add(a,mul(along,lo)),add(a,mul(along,hi.max(lo))));
            let near=Point::new((from.x+to.x)/2.0,(from.y+to.y)/2.0).distance(Point::new(pose.x,pose.y));
            let metal=!*other;
            if contact.as_ref().is_some_and(|(held,span,distance,_)|*held&&!metal
                ||*held==metal&&(hi-lo<span-EPS||hi-lo<span+EPS&&near>=*distance)) {continue;}
            let mut foot=[pose.local_point(from),pose.local_point(to)];foot.sort_by(|a,b|a.x.total_cmp(&b.x));
            let normal=rotate(out,-pose.angle);
            contact=Some((metal,hi-lo,near,Standoff{host:id.clone(),foot,normal,reach:None,column:None}));
        }
    }}
    // The column, along the middle of the piece: down from the foot of a sensor, up from the top of a blade.
    let way=if kind==ComponentKind::Blade {1.0} else {-1.0};
    let(half,base)=(column_width(kind,width)/2.0,way*height/2.0);
    let mut first:Option<(f64,&String,Point,Point)>=None;
    for Metal{id,shapes,..} in others() {for shape in shapes {
        let local:Vec<_>=shape.iter().map(|&p|pose.local_point(p)).collect();
        for (i,&a) in local.iter().enumerate() {
            let b=local[(i+1)%local.len()];
            if (a.x-b.x).abs()<1e-12||a.x.min(b.x)>EPS||a.x.max(b.x)< -EPS {continue;}
            let y=a.y-(b.y-a.y)*a.x/(b.x-a.x);let reach=way*(y-base);
            if reach< -EPS||reach>STANDOFF+EPS||first.is_some_and(|(nearest,..)|reach>=nearest-EPS) {continue;}
            first=Some((if reach<EPS {0.0} else {reach},id,Point::new(0.0,y),sub(b,a)));
        }
    }}
    let column=first.and_then(|(reach,host,hit,edge)|{
        let slope=edge.y/edge.x;let foot=|x:f64|Point::new(x,hit.y+slope*x);
        let(rear,front)=(foot(-half),foot(half));let(near,far)=(way*(rear.y-base),way*(front.y-base));
        // The face it meets does not rise into the piece within the column, nor fall away from it steeper than a post.
        if near< -EPS||far< -EPS||near.max(far)>STANDOFF+2.0*half {return None;}
        let(top_rear,top_front)=(Point::new(-half,base),Point::new(half,base));
        let mut shape=if way<0.0 {vec![rear,front,top_front,top_rear]} else {vec![top_rear,top_front,front,rear]};
        shape.dedup_by(|a,b|a.distance(*b)<=EPS);if shape.len()>3&&shape[0].distance(shape[shape.len()-1])<=EPS {shape.pop();}
        let solid=(shape.len()>=3&&polygon_properties(&shape).area>EPS*EPS).then_some(shape);
        if let Some(shape)=&solid {
            let posed:Vec<_>=shape.iter().map(|&p|pose.world_point(p)).collect();
            if others().any(|other|other.shapes.iter().any(|metal|intersection_area(metal,&posed)>EPS*EPS))
                ||gear.iter().any(|gear|intersection_area(gear,&posed)>EPS*EPS) {return None;}
        }
        let length=hypot(edge.x,edge.y);let mut normal=Point::new(-edge.y/length,edge.x/length);
        if normal.y*way>0.0 {normal=mul(normal,-1.0);}
        Some(Standoff{host:host.clone(),foot:[rear,front],normal,reach:Some(reach),column:solid})
    });
    // A sensor beside a plate it touches is held there; under or over it, by the column that fills the room to its face,
    // or, where that column would stand in the way of something, where it touches. Another piece it only touches holds
    // it where no column reaches out of it: two blades side by side each hang from their own.
    let(column,contact)=(column,contact.map(|(metal,_,_,contact)|(metal,contact)));
    match (column,contact) {
        (Some(column),contact) if touched.contains(&column.host)=>std::iter::once(column).chain(contact.map(|(_,contact)|contact)).collect(),
        (_,Some((true,contact)))=>vec![contact],
        (column,contact)=>column.into_iter().chain(contact.map(|(_,contact)|contact)).collect(),
    }
}
/// The column of each piece that stands off its metal, told to its piece: where it meets that, and what the piece weighs
/// with it, where, and how it turns. A column is a solid as its piece is: nothing else stands in it, nor sweeps through
/// it; one that would is left for where its piece touches, if it does.
fn stand_off(placed:&mut [Placed],bodies:&[Metal],gear:&[Polygon])->Result<(),Value> {
    let steel=Material::named("steel").unwrap();
    let candidates:Vec<_>=placed.iter().map(|part|standoffs(part,bodies,gear)).collect();
    let mut chosen:Vec<Option<Standoff>>=Vec::new();let mut columns:Vec<Option<Polygon>>=Vec::new();
    for (i,candidates) in candidates.into_iter().enumerate() {
        let count=candidates.len();let mut picked=None;
        for (k,standoff) in candidates.into_iter().enumerate() {
            let posed=standoff.column.as_ref().map(|column|{let pose=Pose::from_value(&placed[i].module);column.iter().map(|&p|pose.world_point(p)).collect::<Polygon>()});
            let blocked=posed.as_ref().and_then(|column|{
                let solid=Occupancy::Fixed(column.clone());
                placed.iter().enumerate().find(|(j,other)|*j!=i&&(solid.overlaps(&other.occupancy)
                    ||columns.get(*j).and_then(Option::as_ref).is_some_and(|other|intersection_area(column,other)>EPS))).map(|(j,_)|j)
            });
            match blocked {
                None=>{picked=Some((standoff,posed));break}
                Some(j) if k+1==count=>return Err(json!({"code":"CONSTRUCTION_OVERLAP","ids":[placed[i].canonical["id"],placed[j].canonical["id"]]})),
                Some(_)=>{}
            }
        }
        let (standoff,posed)=picked.map_or((None,None),|(standoff,posed)|(Some(standoff),posed));
        chosen.push(standoff);columns.push(posed);
    }
    for ((part,standoff),posed) in placed.iter_mut().zip(chosen).zip(columns) {
        let Some(standoff)=standoff else{continue};let module=&mut part.module;
        let mut support=json!({"host":standoff.host,"foot":standoff.foot.map(|p|p.to_value()),"normal":standoff.normal.to_value()});
        if let Some(reach)=standoff.reach {support["reach"]=json!(reach);}
        if let Some(column)=standoff.column {
            let kind=ComponentKind::from_name(module["kind"].as_str().unwrap()).unwrap();
            let mass=standoff.reach.unwrap()*column_section(column_width(kind,module["width"].as_f64().unwrap()))*steel.density;
            let properties=polygon_properties(&column);
            let(own,center)=(module["physicalMass"].as_f64().unwrap(),Point::from_value(&module["physicalCenterLocal"]));
            let total=own+mass;let joined=mul(add(mul(center,own),mul(properties.center,mass)),1.0/total);
            let spread=mass*(properties.second/properties.area-properties.center.dot(properties.center)).max(0.0);
            let inertia=module["physicalInertia"].as_f64().unwrap()+own*center.distance(joined).powi(2)
                +spread+mass*properties.center.distance(joined).powi(2);
            module["physicalMass"]=json!(total);module["physicalCenterLocal"]=joined.to_value();module["physicalInertia"]=json!(inertia);
            support["mass"]=json!(mass);support["polygon"]=json!(column.iter().map(|p|p.to_value()).collect::<Vec<_>>());
            part.column=posed;
        }
        part.module["support"]=support;
    }
    Ok(())
}
// The tool of a road machine goes down plumb from where it travels to meet the ground (src/road-machine-motion.js), as
// far as it reaches (`toolReach`, told to its piece): as far as the rams of a grader take its blade and those of a paver
// its screed, and at the least as far as the ground its running gear stands on, as the vehicle is built, and a margin
// past it (`slack`) for the field: the bumps its gear stands on, the slopes it leans on and, of a paver, the tail of its
// vehicle rising as its hopper empties. A tool whose working point stands more than `TOOL_HEIGHT` over that ground is
// refused where a design is made, in the workshop and where it is fabricated (`TOOL_GROUND`); one made before that
// comes back to the field as it was, and its machine stands still where it does not reach (server/road-works.js).
struct Tool {
    /// Where on its box it works, as a share of its width from its rear end and of its height from its top
    /// (src/road-tools.js `TOOL_POINT`): the middle of the cutting edge of a blade, at the foot of its box, and the
    /// trailing edge of the screed of a paver.
    point:Point,
    /// How far down it goes at the least, for each of its size: half a metre, as a grader's blade goes, and the
    /// metre and more the three stages of a paver's ram let its screed down.
    least:f64,
    /// How much further than that ground it goes. A blade hangs between the axles of its vehicle: sat on the field at three
    /// thousand places, one hung 1.4 m high stood up to 0.21 m further over the ground under it than as built. A paver's
    /// screed trails behind a long running gear, which pivots over a crest, and its hopper empty the tail of its vehicle
    /// stands higher: one 1.5 m high stood up to 0.64 m further. A half more of each.
    slack:f64,
}
const BLADE:Tool=Tool{point:Point{x:0.5,y:1.0},least:0.52,slack:0.3};
const PAVER:Tool=Tool{point:Point{x:0.0,y:0.9},least:1.15,slack:0.8};
/// How high over the ground its running gear stands on the working point of a road tool may stand, in metres.
const TOOL_HEIGHT:f64=1.5;
/// Tells each road tool how far it reaches over `ground`, the lowest of its running gear (none for a construction that has
/// none: it goes as far as it goes), and refuses, where a design is being made (`made`), one that stands too high.
fn reach_tools(placed:&mut [Placed],ground:Option<f64>,made:bool,issues:&mut Vec<Value>) {
    for part in placed {
        let module=&mut part.module;
        let tool=match module["kind"].as_str() {Some("blade")=>&BLADE,Some("paver")=>&PAVER,_=>continue};
        let(width,height)=(module["width"].as_f64().unwrap(),module["height"].as_f64().unwrap());
        let way=if module["mirrored"]==true {-1.0} else {1.0};
        let at=Pose::from_value(module).world_point(Point::new(way*(tool.point.x-0.5)*width,(0.5-tool.point.y)*height));
        let size=ComponentKind::from_name(module["kind"].as_str().unwrap()).unwrap().scale(width,height);
        let rest=ground.map(|ground|at.y-ground);
        module["toolReach"]=json!((tool.least*size).max(rest.map_or(0.0,|rest|rest.min(TOOL_HEIGHT)+tool.slack)));
        if made&&rest.is_some_and(|rest|rest>TOOL_HEIGHT+EPS) {issues.push(json!({"code":"TOOL_GROUND","ids":[module["id"]]}));}
    }
}
// A gun fires the rounds of the boxes of its own calibre and of no other (game_damage.rs `consume_round`), and the field
// fills only the boxes a construction has: one with no round of its calibre aboard never fires. It is refused where a
// design is fabricated, in the workshop and in the field (`WEAPON_UNFED`), told with the boxes of its calibre it has,
// each too small for a round of it; one made before that comes back to the field as it was. A box of a calibre no gun
// takes is no refusal: the workshop tells of it.
fn unfed_guns(modules:&[Value])->Vec<Value> {
    modules.iter().filter(|gun|gun["kind"]=="weapon").filter_map(|gun|{
        let cartridge=crate::game_variant::cartridge(gun["weaponPreset"].as_str().unwrap_or_default());
        let boxes:Vec<&Value>=modules.iter().filter(|part|part["kind"]=="ammo"&&part["ammoPreset"]==cartridge.as_str()).collect();
        (!boxes.iter().any(|part|part["capacityRounds"].as_u64().is_some_and(|rounds|rounds>0))).then(||
            json!({"code":"WEAPON_UNFED","ids":std::iter::once(&gun["id"]).chain(boxes.iter().map(|part|&part["id"])).collect::<Vec<_>>()}))
    }).collect()
}
fn physical_support(frame:&Frame,placed:&[Placed],plates:&[Value],chassis:Option<&Chassis>,site:&Value)->Result<Vec<Value>,Value> {
    if frame.plates.is_empty()&&placed.is_empty(){return Ok(Vec::new());}
    // Only an explicit query reaches this function. Missing field placement is an advisory finding, never a root.
    let site=if chassis.is_none(){match SupportSite::read(site){
        Ok(site)=>Some(site),
        Err(issue) if issue["code"]=="SUPPORT_SITE_REQUIRED"=>return Ok(vec![issue]),
        Err(error)=>return Err(error),
    }}else{fields(site,&[])?;None};
    let mut bodies:Vec<_>=plates.iter().zip(&frame.plates).map(|(value,plate)|SupportBody{
        id:plate.id.clone(),shapes:support_plate(value),rooted:plate.structural_part().is_some()
    }).collect();
    for part in placed {
        // A piece that stands off its metal reaches it by its column.
        let shapes=fixed_shapes(part).into_iter().chain(part.column.clone()).collect();
        bodies.push(SupportBody{id:part.module["id"].as_str().unwrap().to_owned(),shapes,rooted:false});
    }
    let frame_shapes=chassis.map(|c|c.support_shapes(frame.origin)).unwrap_or_default();
    for body in &mut bodies {
        body.rooted|=body.shapes.iter().any(|shape|frame_shapes.iter().any(|root|support_touch(shape,root))
            ||site.as_ref().is_some_and(|site|site.grounded(shape)));
    }
    // The generated gear is already physically mounted by Chassis; outboard tyres do not support interior equipment.
    let mut reached=bodies.iter().map(|body|body.rooted).collect::<Vec<_>>();
    loop {
        let mut changed=false;
        for i in 0..bodies.len(){if reached[i]{continue;}
            if (0..bodies.len()).any(|j|reached[j]&&
                bodies[i].shapes.iter().any(|a|bodies[j].shapes.iter().any(|b|support_touch(a,b)))) {
                reached[i]=true;changed=true;
            }
        }
        // A body fixes ordinary equipment anywhere inside it once its whole boundary has real support, an enclosed gun
        // as well, its receiver and its feet within it, whatever plate its barrel passes out through.
        // Starting from the reached metal prevents a floating closed box from rooting itself through its contents.
        // Elsewhere guns require their admitted fixed feet or post to touch; no swept or moving part is a mounting face.
        for room in &frame.rooms {
            if !room.walls.iter().all(|wall|reached[wall.owner as usize-1]){continue;}
            for (i,part) in placed.iter().enumerate() {
                let at=plates.len()+i;if reached[at]{continue;}
                let held=match &part.occupancy {
                    Occupancy::Fixed(shape)=>shape.iter().all(|&point|inside(&room.vertices,point)),
                    Occupancy::Weapon(gun) if part.module["weaponMount"]["exposed"]!=true=>{
                        let receiver=corners(Bounds{min_x:-part.module["width"].as_f64().unwrap(),max_x:0.0,
                            min_y:-part.module["height"].as_f64().unwrap()/2.0,max_y:part.module["height"].as_f64().unwrap()/2.0});
                        gun.fixed.iter().flatten().chain(&receiver).all(|&point|inside(&room.vertices,gun.pose.world_point(point)))
                    },
                    Occupancy::Weapon(_)=>false,
                };
                if held {reached[at]=true;changed=true;}
            }
        }
        if !changed{break;}
    }
    let ids=bodies.iter().zip(&reached).filter(|(_,rooted)|!**rooted).map(|(body,_)|body.id.clone()).collect::<Vec<_>>();
    Ok(if ids.is_empty(){Vec::new()}else{vec![json!({"code":"PHYSICAL_SUPPORT","ids":ids})]})
}

/// Owners follow the plates as written, then those of the chassis, then the
/// components and last the running gear. Rooms, walls and mounting faces are
/// all derived from that one frame.
pub fn compile(input:&Value,catalogue:&Value)->Result<Value,Value> {
    compile_mode(input,catalogue,false)
}
// Drafts obey the same geometry and calculate the same physical limits. Only
// manufacturing admission is deferred, and its reasons remain in the projection.
// Appearance is bounded authoring data. It never enters occupancy, mass, cost, contacts or sight calculations.
fn appearance_details(appearance:&Value,catalogue:&Value,frame:&Frame)->Result<Value,Value> {
    let mut identities=HashSet::new();let mut kept=Vec::new();
    for (index,detail) in array(appearance,"details",32)?.iter().enumerate() {
        let mut admit=||->Result<Option<Value>,Value> {
            fields(detail,&["id","kind","surface","host","space","automatic","x","y","angle","width","height","mirrored","text"])?;
            let name=id(detail,"id")?;
            if !identities.insert(name.clone()) {return Err(reject("DETAIL_IDENTITY"));}
            let kind=id(detail,"kind")?;let spec=&catalogue["details"]["kinds"][&kind];
            if !spec.is_object() {return Err(told(detail,"kind",reject("DETAIL_KIND")));}
            let surface=named(detail,"surface","")?;let host=id(detail,"host")?;
            if !matches!(surface,"body"|"chassis"|"part") {return Err(told(detail,"surface",reject("DETAIL_SURFACE")));}
            let angle=num(detail,"angle",Some(0.0),-std::f64::consts::PI,std::f64::consts::PI)?;
            // A cosmetic angle needs no sub-nanoradian tail. Canonical precision keeps repeated mirrors stable
            // and avoids cache misses caused solely by floating-point trigonometry in authoring gestures.
            let angle=((angle*1e9).round()/1e9).clamp(-std::f64::consts::PI,std::f64::consts::PI);
            let mut value=json!({"id":name,"kind":kind,"surface":surface,"host":host,
                "x":num(detail,"x",None,-24.0,24.0)?,"y":num(detail,"y",None,-24.0,24.0)?,
                "angle":angle});
            for field in ["width","height"] {
                let base=spec[field].as_f64().filter(|n|n.is_finite()&&*n>0.0).ok_or_else(||reject("CONSTRUCTION_CATALOGUE"))?;
                let scale=spec["maxScale"].as_f64().unwrap_or(2.0).clamp(0.5,2.5);
                value[field]=json!(num(detail,field,None,(base*0.5).max(0.015),(base*scale).min(6.0))?);
            }
            if let Some(mirror)=detail.get("mirrored") {
                let mirror=mirror.as_bool().ok_or_else(||told(detail,"mirrored",reject("FIELD")))?;
                if mirror {value["mirrored"]=json!(true);}
            }
            if let Some(text)=detail.get("text") {
                let text=text.as_str().filter(|s|kind=="number"&&!s.is_empty()&&s.len()<=3&&s.bytes().all(|c|c.is_ascii_digit()))
                    .ok_or_else(||told(detail,"text",reject("DETAIL_TEXT")))?;
                value["text"]=json!(text);
            }
            if let Some(automatic)=detail.get("automatic") {
                if automatic.as_bool().ok_or_else(||told(detail,"automatic",reject("FIELD")))? {value["automatic"]=json!(true);}
            }
            if let Some(space)=detail.get("space") {
                if space!="project" || surface=="part" {return Err(told(detail,"space",reject("FIELD")));}
                value["space"]=json!("project");
            } else if surface!="part" {
                // Adopt the old plate-local pose once. Fixed project coordinates survive opening a room, moving its
                // edges and deleting/replacing its original plate. Rendering still clips to the current real skin.
                if let Some(plate)=frame.plates.iter().find(|plate|plate.id==host) {
                    let(a,b)=frame.ends(plate);let axis=atan2(b.y-a.y,b.x-a.x);
                    let pose=Pose{x:(a.x+b.x)/2.0,y:(a.y+b.y)/2.0,angle:axis};
                    let point=pose.world_point(Point::new(value["x"].as_f64().unwrap(),value["y"].as_f64().unwrap()));
                    value["x"]=json!(point.x-frame.origin.x);value["y"]=json!(point.y-frame.origin.y);
                    let angle=axis+angle;value["angle"]=json!(((atan2(sin(angle),cos(angle))*1e9).round()/1e9).clamp(-std::f64::consts::PI,std::f64::consts::PI));
                    value["space"]=json!("project");
                }
            }
            // Missing hosts are harmless bounded records, retained for undo, rebuilding and manual relocation.
            Ok(Some(value))
        };
        if let Some(value)=admit().map_err(|error|listed("detail","details",index,detail,error))? {kept.push(value);}
    }
    Ok(json!(kept))
}
fn compile_mode(input:&Value,catalogue:&Value,draft:bool)->Result<Value,Value> {
    compile_for(input,catalogue,draft,None)
}
/// The catalogue with the guns made over in the workshop (game_variant.rs) a construction names, its guns' and its
/// boxes', each refused where it names one that cannot be made; the catalogue itself where it names none.
fn with_variants<'a>(input:&Value,catalogue:&'a Value)->Result<std::borrow::Cow<'a,Value>,Value> {
    let parts=input["components"].as_array().map_or(&[][..],Vec::as_slice);
    let named=|part:&Value,key:&str|part[key].as_str().filter(|id|id.contains('|')).map(str::to_owned);
    if !catalogue["weapons"].is_object()||!parts.iter().any(|part|["weaponPreset","ammoPreset"].iter().any(|key|named(part,key).is_some())) {
        return Ok(std::borrow::Cow::Borrowed(catalogue));
    }
    let mut own=catalogue.clone();
    for (i,part) in parts.iter().enumerate() {
        for key in ["weaponPreset","ammoPreset"] {
            let Some(id)=named(part,key) else {continue};
            crate::game_variant::ensure(&mut own["weapons"],&id).map_err(|_|listed("component","components",i,part,unknown(part,key)))?;
        }
    }
    Ok(std::borrow::Cow::Owned(own))
}
fn compile_for(input:&Value,catalogue:&Value,draft:bool,manufacture:Option<&Value>)->Result<Value,Value> {
    let catalogue=&*with_variants(input,catalogue)?;
    fields(input,&["version","preset","name","seed","launcher","appearance","terrain","chassis","nodes","plates","components"])?;
    if input["version"]!=CONSTRUCTION_VERSION {return Err(told(input,"version",reject("CONSTRUCTION_VERSION")));}
    if !matches!(input["preset"].as_str(),Some("vehicle"|"bunker")) {
        return Err(told(input,"preset",json!({"code":"CONSTRUCTION_VERSION","accepted":["vehicle","bunker"]})));
    }
    if ["weapons","mounts","sensors","chassis"].iter().any(|key|!catalogue[*key].is_object()) {return Err(reject("CONSTRUCTION_CATALOGUE"));}
    let (frame,mut chassis)=framed(input,catalogue)?;
    if let Some(chassis)=&chassis {chassis.check_suspension()?;}
    let mut issues=Vec::new();
    if frame.plates.is_empty()&&array(input,"components",48)?.is_empty(){issues.push(reject("FRAME_EMPTY"));}
    if let Some(chassis)=&mut chassis {if let Err(error)=chassis.carry(&frame,catalogue) {issues.push(error);}}
    let mut names:HashSet<String>=frame.nodes.iter().map(|node|node.0.clone()).chain(frame.plates.iter().map(|plate|plate.id.clone())).collect();
    let mut owner=frame.plates.len() as u32+1;
    let fed=fed_ammunition(array(input,"components",48)?,catalogue)?;
    let mut placed=Vec::new();
    for (i,component) in array(input,"components",48)?.iter().enumerate() {
        let name=id(component,"id").and_then(written).map_err(|e|listed("component","components",i,component,e))?;
        if !names.insert(name.clone()) {return Err(context("component",&name,reject("COMPONENT_IDENTITY")));}
        placed.push(position(component,&frame,catalogue,owner,&fed).map_err(|e|context("component",&name,e))?);
        owner=owner.checked_add(1).ok_or_else(|| reject("OWNER"))?;
    }
    for (i,a) in placed.iter().enumerate() {for b in placed.iter().skip(i+1) {
        if a.occupancy.overlaps(&b.occupancy) {
            let name=|part:&Placed|part.canonical["id"].as_str().unwrap().to_owned();
            // The breech of a gun in a room that turns down or up onto a part is told with where the bore stands then.
            for (gun,other) in [(a,b),(b,a)] {
                if let (Occupancy::Weapon(w),Occupancy::Fixed(polygon),false)=(&gun.occupancy,&other.occupancy,gun.ports.is_empty()) {
                    if let Some(angle)=w.breech_meets(polygon) {
                        let ready=gun.canonical["weaponPreset"].as_str().and_then(|preset|crate::game_variant::compartment(&catalogue["weapons"][preset])).is_some();
                        return Err(json!({"code":"BREECH_COMPONENT","ids":[name(gun),name(other)],"angleDegrees":degrees(w.pose.angle+angle),"ready":ready}));
                    }
                }
            }
            return Err(json!({"code":"CONSTRUCTION_OVERLAP","ids":[name(a),name(b)]}));
        }
    }}
    let gear=match &chassis {Some(chassis)=>chassis.gear(&frame,catalogue,owner)?,None=>Vec::new()};
    // Tyres are outboard of ordinary interior equipment. A road blade instead occupies the
    // working width under the vehicle, so its actual metal must clear the real running gear.
    for blade in placed.iter().filter(|part|part.module["kind"]=="blade") {
        let Occupancy::Fixed(polygon)=&blade.occupancy else{unreachable!()};
        for running in &gear {
            let pose=Pose::from_value(running);let(width,height)=(running["width"].as_f64().unwrap(),running["height"].as_f64().unwrap());
            let intersects=if running["kind"]=="wheel" {
                let center=Point::new(pose.x,pose.y);inside(polygon,center)||polygon.iter().enumerate()
                    .any(|(i,&a)|segment_distance(center,a,polygon[(i+1)%polygon.len()])<height/2.0-EPS)
            }else{
                let shape=crate::game_geometry::component_polygon(ComponentKind::Track,width,height).into_iter().map(|p|pose.world_point(p)).collect::<Vec<_>>();
                intersection_area(polygon,&shape)>EPS*EPS
            };
            if intersects{return Err(json!({"code":"COMPONENT_GEAR","ids":[blade.module["id"],running["id"]]}));}
        }
    }

    let mut ports=BTreeMap::<u32,Vec<(f64,f64)>>::new();
    for p in &placed {for &(host,interval) in &p.ports {ports.entry(host).or_default().push(interval);}}
    // The frame of a chassis weighs what the frame of its model weighs, spread over its plates by their steel.
    let frame_scale=chassis.as_ref().map(|chassis|chassis.mass_scale(&frame));
    let mut plates=Vec::new();let mut armour=Vec::new();
    for (i,plate) in frame.plates.iter().enumerate() {
        let (a,b)=frame.ends(plate);let reach=a.distance(b);let along=mul(sub(b,a),1.0/reach);
        let thickness=plate.thickness/1000.0;
        // Each plate keeps its authored stock beyond the joints. Its own end
        // extensions determine its length and the offset of its middle.
        // Joints stay on the nodes and ports stay where the wall coordinates put them.
        let length=reach+plate.start+plate.end;let offset=(plate.end-plate.start)/2.0;
        let mut grid=MaterialGrid::new(Bounds{min_x:-length/2.0,max_x:length/2.0,min_y:-thickness/2.0,max_y:thickness/2.0});
        if let Some(cuts)=ports.get(&plate.owner) {for x in 0..grid.nx {
            let cell=grid.cell_bounds(x,0);
            if cuts.iter().any(|(lo,hi)|cell.max_x>*lo-offset+1e-10 && cell.min_x<*hi-offset-1e-10) {
                for y in 0..grid.ny {grid.clear_cell(x,y);}
            }
        }}
        let props=material_properties(&grid);
        let scale=plate.structural_part().and(frame_scale).unwrap_or(frame.width);
        let material=Material::from_name(&plate.material);let density=material.density*scale;
        let carrier=if plate.part.is_some()&&i!=frame.root{json!(frame.plates[frame.root].id)}else{Value::Null};
        let pose=Pose{x:(a.x+b.x)/2.0+along.x*offset,y:(a.y+b.y)/2.0+along.y*offset,angle:atan2(b.y-a.y,b.x-a.x)};
        // Feet can touch any real face. Empty port columns are neither obstacles nor support.
        for placed in &placed {
            if let Occupancy::Weapon(gun)=&placed.occupancy {
                if gun.fixed.iter().any(|shape|{
                    let local:Vec<_>=shape.iter().map(|&p|pose.local_point(gun.pose.world_point(p))).collect();
                    crate::game_mounts::base_shapes_cross_grid(&local,&grid)
                }) {return Err(json!({"code":"COMPONENT_PLATE","ids":[placed.module["id"],plate.id]}));}
            }
        }
        // The skids of an aircraft are tubes beside its body, which an optic under it sees out between.
        if !matches!(plate.part,Some(("skid"|"leg",_))) {armour.push((material.clear_to(),Armour::of(pose,&grid)));}
        let mut value=json!({"id":plate.id,"owner":plate.owner,"x":pose.x,"y":pose.y,
            "length":length,"angle":pose.angle,"material":plate.material,
            "thicknessMm":plate.thickness,"widthM":frame.width,
            "anchors":frame.anchors.get(i).map_or_else(||vec![a,b],Clone::clone).iter()
                .map(|point|json!({"u":(sub(*point,a).dot(along)-reach/2.0-offset)/length,"v":0})).collect::<Vec<_>>(),"mountId":carrier,
            "ballisticGrid":grid.to_value(),"originalArea":props.area,"physicalMass":props.area*density,
            "physicalInertia":(props.second-props.area*props.center.dot(props.center)).max(0.0)*density,
            "physicalCenterLocal":props.center.to_value()});
        // A plate of the chassis is as deep as the body, and weighs for the frame it stands for; the air meets of it what
        // that frame shows it across the body (`Chassis::drag_width`).
        if let Some((part,_))=plate.structural_part() {
            value["massScale"]=json!(scale);
            if let Some(width)=chassis.as_ref().and_then(|chassis|chassis.drag_width(part)) {value["dragWidthM"]=json!(width);}
        }
        plates.push(value);
    }
    let running:Vec<Polygon>=gear.iter().map(|running|{
        let pose=Pose::from_value(running);let kind=ComponentKind::from_name(running["kind"].as_str().unwrap()).unwrap();
        crate::game_geometry::component_polygon(kind,running["width"].as_f64().unwrap(),running["height"].as_f64().unwrap())
            .into_iter().map(|p|pose.world_point(p)).collect()
    }).collect();
    let ground=running.iter().flatten().map(|p|p.y).reduce(f64::min);
    // Nothing of an aircraft hangs as low as the runner of its skids: no piece, no plate written on it, and no gun as it
    // turns through its sector — its barrel, its mantlet, its breech. It would pass through the runner, and come down
    // on the floor before the skids do.
    if let Some(top)=chassis.as_ref().and_then(|chassis|chassis.skid_top()).map(|top|frame.origin.y+top-EPS) {
        let lowest=|polygon:&Polygon|polygon.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
        for part in &placed {
            let (low,gun)=match &part.occupancy {Occupancy::Weapon(gun)=>(gun.bounds().min_y,true),Occupancy::Fixed(shape)=>(lowest(shape),false)};
            if low<top {return Err(json!({"code":"AIRCRAFT_CLEARANCE","ids":[part.module["id"]],"gun":gun}));}
        }
        if let Some(plate)=frame.plates.iter().find(|plate|plate.part.is_none() && lowest(&frame.solid(plate,0.0))<top) {
            return Err(json!({"code":"AIRCRAFT_CLEARANCE","ids":[plate.id],"gun":false}));
        }
    }
    reach_tools(&mut placed,ground,draft||manufacture.is_some(),&mut issues);
    let bodies=metal_bodies(&frame,&placed,&plates,chassis.as_ref());
    stand_off(&mut placed,&bodies,&running)?;
    let manufacturing_envelope=manufacturing_envelope(&bodies,&placed,&running);
    let modules:Vec<Value>=placed.iter().map(|p|p.module.clone()).chain(gear).collect();
    // What each piece weighs empty and with all it holds full, where along the design; and the whole of it. No
    // chassis carries more than its model does on its gear, nor has the weight fall beyond its gear.
    let weights:Vec<(f64,f64,f64)>=plates.iter().chain(&modules).map(|piece|{
        let pose=Pose{x:piece["x"].as_f64().unwrap(),y:piece["y"].as_f64().unwrap(),angle:piece["angle"].as_f64().unwrap()};
        let (empty,loaded)=reserves(piece);
        (pose.world_point(Point::from_value(&piece["physicalCenterLocal"])).x-frame.origin.x,empty,loaded)
    }).collect();
    let (empty,loaded)=weights.iter().fold((0.0,0.0),|(empty,loaded),&(_,e,l)|(empty+e,loaded+l));
    let balance=chassis.as_mut().map(|chassis|{
        let balance=chassis.apply_load_envelope(&weights);
        if let Err(error)=chassis.check_balance(balance) {issues.push(error);}
        balance
    });
    // An aircraft carries what its thrusters push up with, as they point in it, over `LIFT_MARGIN`.
    if let Some(chassis)=chassis.as_mut().filter(|chassis|chassis.aircraft()) {
        let up:f64=modules.iter().filter(|m|m["kind"]=="thruster")
            .map(|m|m["thrustN"].as_f64().unwrap_or(0.0)*cos(m["angle"].as_f64().unwrap_or(0.0)).max(0.0)).sum();
        chassis.lifted(up/(crate::game_flight::GRAVITY*LIFT_MARGIN));
    }
    if let Some(chassis)=chassis.as_ref().filter(|chassis|loaded>chassis.limit) {
        let mut issue=json!({"code":if chassis.aircraft() {"AIRCRAFT_LIFT"} else {"CHASSIS_OVERLOAD"},"loadedKg":loaded.ceil(),"limitKg":chassis.limit.round()});
        // A gap of its frame is what bears the least, when it is.
        if let Some(gap)=chassis.limiting_gap().filter(|_|!chassis.aircraft()) {issue["gap"]=json!(gap);}
        issues.push(issue);
    }
    let physical=fixed_assembly_properties(&plates,&modules,frame.origin);
    // One that lifts is held up level by its thrusters as its flight computer shares them out (`game_hover.rs`).
    if chassis.as_ref().is_some_and(|chassis|chassis.aircraft() && loaded<=chassis.limit)
        && crate::game_hover::hover(&json!(modules),&physical).is_some_and(|flight|flight["balanced"]!=true) {
        issues.push(json!({"code":"AIRCRAFT_BALANCE"}));
    }
    if let Some(site)=manufacture {
        issues.extend(physical_support(&frame,&placed,&plates,chassis.as_ref(),site)?);
        issues.extend(unfed_guns(&modules));
        // A thruster lifts an aircraft alone: none is built on wheels, on tracks or into what stands in its place.
        let thrusters:Vec<&Value>=modules.iter().filter(|m|m["kind"]=="thruster").map(|m|&m["id"]).collect();
        if !thrusters.is_empty() && !chassis.as_ref().is_some_and(|chassis|chassis.aircraft()) {
            issues.push(json!({"code":"THRUSTER_CHASSIS","ids":thrusters}));
        }
    }
    if !draft && let Some(issue)=issues.first() {return Err(issue.clone());}
    // Publish the final load envelope once, after all full/empty reserves are known.
    if let Some(chassis)=&chassis {for (value,plate) in plates.iter_mut().zip(&frame.plates) {
        if let Some(part)=plate.structural_part() {value["chassis"]=chassis.describe(part);}
    }}
    let seed=whole(input,"seed",Some(6173.0),0.0,u32::MAX as f64)? as u32;
    // What has a chassis drives; nothing else does.
    let enabled=chassis.is_some();
    if enabled {if let Some(plate)=frame.plates.iter().find(|plate|Material::from_name(&plate.material).fixed()) {
        return Err(context("plate",&plate.id,json!({"code":"ARMOUR_FIXED","field":"material","value":plate.material})));
    }}
    let launcher=if let Some(value)=input.get("launcher") {
        let at=|e|within("launcher",None,e);
        fields(value,&["x","y"]).map_err(at)?;json!({"x":num(value,"x",None,-15.0,50.0).map_err(at)?,"y":num(value,"y",None,0.01,20.0).map_err(at)?})
    }else{json!({"x":1.65,"y":1.42})};
    let mut canonical=json!({"version":CONSTRUCTION_VERSION,"preset":input["preset"],"name":named(input,"name","Veículo estruturado")?.chars().take(80).collect::<String>(),
        "seed":seed,"launcher":launcher});
    if let Some(chassis)=&chassis{canonical["chassis"]=chassis.canonical(&input["chassis"]);}
    canonical["nodes"]=json!(frame.canonical.0);canonical["plates"]=json!(frame.canonical.1);
    canonical["components"]=json!(placed.iter().map(|p|p.canonical.clone()).collect::<Vec<_>>());
    if let Some(appearance)=input.get("appearance") {
        fields(appearance,&["paint","details","automaticDetails"]).map_err(|e|within("appearance",None,e))?;
        let paint=appearance["paint"].as_str().filter(|p|p.len()==7 && p.starts_with('#') && p.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit))
            .ok_or_else(||within("appearance",None,told(appearance,"paint",reject("PAINT"))))?;
        canonical["appearance"]=json!({"paint":paint.to_ascii_lowercase()});
        if let Some(automatic)=appearance.get("automaticDetails") {
            canonical["appearance"]["automaticDetails"]=json!(automatic.as_bool()
                .ok_or_else(||within("appearance",None,told(appearance,"automaticDetails",reject("FIELD"))))?);
        }
        if appearance.get("details").is_some() {
            canonical["appearance"]["details"]=appearance_details(appearance,catalogue,&frame)
                .map_err(|error|within("appearance",None,error))?;
        }
    } else {canonical["appearance"]=json!({"paint":"#68765a"});}
    if let Some(terrain)=input.get("terrain") {
        if terrain.as_str().is_none_or(|s|s.is_empty() || s.len()>64) {return Err(told(input,"terrain",reject("TERRAIN")));}
        canonical["terrain"]=terrain.clone();
    }
    // What the workshop draws and takes hold of: the frame in the field as it was written, and the rooms it closes.
    let nodes_written=frame.written.0;
    let frame_projection=json!({"origin":frame.origin.to_value(),"widthM":frame.width,
        "nodes":frame.nodes.iter().take(nodes_written).chain(frame.nodes.iter().skip(nodes_written).filter(|(id,_)|id.starts_with("chassis:top-point-"))).map(|(id,point)|json!({"id":id,"x":point.x,"y":point.y})).collect::<Vec<_>>(),
        "plates":frame.plates.iter().filter(|plate|plate.structural_part().is_none()).map(|plate|json!({"id":plate.id,"owner":plate.owner,
            "a":frame.nodes[plate.a].0,"b":frame.nodes[plate.b].0})).collect::<Vec<_>>()});
    let rooms=frame.rooms.iter().map(|room|json!({"id":room.id,
        "polygon":room.vertices.iter().map(|p|p.to_value()).collect::<Vec<_>>(),
        "walls":room.walls.iter().map(|w|json!({"id":w.id,"owner":w.owner,"a":w.a.to_value(),"b":w.b.to_value(),
            "normal":w.normal.to_value(),"length":w.length,"material":w.material,"thicknessMm":w.thickness,"exterior":w.exterior})).collect::<Vec<_>>()})).collect::<Vec<_>>();
    // What it sees with: its command post and its cameras, and its radars. Of each the workshop is told how
    // far it reaches, the arcs its own armour hides from it and how far it reaches out level to the left —
    // where the front of what is written lies — and to the right. The eyes are the optics that see out level,
    // as the field will tell of them.
    let sensors:Vec<(&Value,ComponentKind,SensorMode)>=placed.iter().map(|p|&p.module).filter_map(|m|match (m["kind"].as_str(),m["sensorMode"].as_str()) {
        (Some("command"),_)=>Some((m,ComponentKind::Command,SensorMode::Visual)),
        (Some("sensor"),Some(mode@("visual"|"radar")))=>Some((m,ComponentKind::Sensor,SensorMode::from_name(mode))),
        _=>None}).collect();
    let seen=outlooks_as_written(&sensors.iter().map(|&(m,kind,mode)|(kind,mode,
        Pose{x:m["x"].as_f64().unwrap(),y:m["y"].as_f64().unwrap(),angle:m["angle"].as_f64().unwrap()})).collect::<Vec<_>>(),&armour);
    let eyes:Vec<_>=seen.iter().filter_map(|sight|sight.eye).collect();
    let sights:Vec<Value>=sensors.iter().zip(&seen).map(|(&(m,_,mode),sight)|json!({"id":m["id"],"mode":mode.name(),"x":m["x"],"y":m["y"],
        "range":sight.range,"left":sight.left,"right":sight.right,
        "hidden":sight.hidden.iter().map(|arc|json!([arc.0,arc.1])).collect::<Vec<_>>()})).collect();
    let mut compiled=json!({"version":1,"canonicalVersion":CONSTRUCTION_VERSION,"derived":true,"mechanicalAdmission":issues.is_empty(),"admissionIssues":issues,
        "preset":canonical["preset"],"name":canonical["name"],"seed":seed,"launcher":launcher,
        "appearance":canonical["appearance"],"terrain":canonical["terrain"],"vehicle":{"enabled":enabled,"chassisId":frame.plates.get(frame.root).map(|plate|&plate.id)},
        "plates":plates,"modules":modules,"frame":frame_projection,"rooms":rooms,"beds":[],
        "fixedAssembly":physical,"eyes":eyes,"sights":sights,
        "manufacturing":{"emptyKg":empty,"envelope":manufacturing_envelope}});
    // The workshop reads the same drivetrain as the field, using the admitted
    // parts and mass without installing or stepping a dynamics world.
    let mut drive=crate::game_damage::DamageState::default();
    for (index,module) in crate::array(&compiled,"modules").iter().enumerate() {
        if matches!(module["kind"].as_str(),Some("engine"|"fuel"|"wheel"|"track")) {
            drive.insert_module(crate::game_damage::Module::from_value(index as u32+1,0,module,&catalogue["weapons"],&catalogue["mounts"]).map_err(|_|reject("COMPILED_MODULE"))?);
        }
    }
    compiled["powertrain"]=crate::game_motion::Powertrain::project(0,
        compiled["fixedAssembly"]["mass"].as_f64().unwrap(),&drive,
        crate::game_air::HullAir::read(&compiled["plates"],crate::array(&compiled,"modules").iter().filter_map(crate::game_air::Piece::from_value),-1.0,0.0)).to_value();
    // Whether its thrusters hold it up and level, for a construction with any.
    if let Some(flight)=crate::game_hover::hover(&compiled["modules"],&compiled["fixedAssembly"]) {compiled["flight"]=flight;}
    // What a vehicle is built on: its model and ends, the bed it carries on, and what it weighs against what it carries.
    if let (Some(chassis),Some(balance))=(&chassis,balance) {
        let projection=chassis.projection(&frame,&compiled["modules"],empty,loaded,balance);
        compiled["beds"]=projection["beds"].clone();compiled["chassis"]=projection;
    }
    Ok(json!({"contract":contract(),"construction":canonical,"compiled":compiled}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cosmetic_details_are_bounded_and_do_not_change_mechanics() {
        let cat=catalogue();let source=crate::game_templates::source("truck",&json!({}),&cat).unwrap();
        let decorated=compile(&source,&cat).unwrap();let details=&decorated["construction"]["appearance"]["details"];
        assert!(details.as_array().unwrap().iter().any(|d|d["kind"]=="armour-door"));
        let mut plain=source.clone();plain["appearance"].as_object_mut().unwrap().remove("details");
        let plain=compile(&plain,&cat).unwrap();
        for key in ["plates","modules","fixedAssembly","powertrain","sights","eyes","chassis","manufacturing"] {
            assert_eq!(decorated["compiled"][key],plain["compiled"][key],"cosmetic changes {key}");
        }
        let first=details[0].clone();let mut changed=source.clone();
        changed["appearance"]["details"]=json!((0..32).map(|i|{let mut d=first.clone();d["id"]=json!(format!("detail-{i}"));d}).collect::<Vec<_>>());
        assert_eq!(compile(&changed,&cat).unwrap()["construction"]["appearance"]["details"].as_array().unwrap().len(),32);
        changed["appearance"]["details"].as_array_mut().unwrap().push(first.clone());
        assert_eq!(compile(&changed,&cat).unwrap_err()["code"],"AUTHORING_LIMIT");
        for (field,bad) in [("kind",json!("uploaded-image")),("width",json!(100)),("x",json!(25)),("text",json!("<svg>")),("mirrored",json!(1)),("url",json!("https://example.com"))] {
            let mut invalid=source.clone();invalid["appearance"]["details"][0][field]=bad;
            assert!(compile(&invalid,&cat).is_err(),"admitted {field}");
        }
        let mut duplicate=source.clone();duplicate["appearance"]["details"]=json!([first.clone(),first.clone()]);
        assert_eq!(compile(&duplicate,&cat).unwrap_err()["code"],"DETAIL_IDENTITY");
        let mut missing=source.clone();missing["appearance"]["details"]=json!([first]);
        // A temporarily missing surface keeps the bounded cosmetic record without creating any geometry.
        missing["appearance"]["details"][0]["host"]=json!("deleted-plate");
        assert_eq!(compile(&missing,&cat).unwrap()["construction"]["appearance"]["details"].as_array().unwrap().len(),1);
    }
    #[test]
    fn manufacturing_support_is_deferred_for_geometry_and_reaches_through_touching_parts(){
        let cat=catalogue();let(_,height,_)=ComponentKind::Engine.dimensions();
        let mut source=empty();source["preset"]=json!("vehicle");
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-60,"y":-5},{"x":60,"y":-5}]});
        source["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":0,"y":(-0.25+height/2.0)/CELL,"angle":0.0}}]);
        let manufacture=|source:&Value,draft:bool|request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":draft,"manufacture":{}}));
        assert_eq!(manufacture(&source,false).unwrap()["compiled"]["mechanicalAdmission"],true);
        source["components"][0]["pose"]["y"]=json!((-0.25+height/2.0+0.25)/CELL);
        let preview=manufacture(&source,true).unwrap();
        let issue=preview["compiled"]["admissionIssues"].as_array().unwrap().iter().find(|i|i["code"]=="PHYSICAL_SUPPORT").unwrap();
        assert_eq!(issue["ids"],json!(["engine"]));
        assert_eq!(manufacture(&source,false).unwrap_err()["code"],"PHYSICAL_SUPPORT");
        assert_eq!(compile(&source,&cat).unwrap()["compiled"]["mechanicalAdmission"],true,"ordinary reconstruction does not run a new manufacturing gate");
        assert_eq!(preview["construction"]["components"][0]["pose"],source["components"][0]["pose"],"an unsupported pose stays editable");
        source["nodes"]=json!([{"id":"a","x":0,"y":-5},{"id":"b","x":0,"y":0}]);
        source["plates"]=json!([plate("brace","a","b")]);
        assert_eq!(manufacture(&source,false).unwrap()["compiled"]["mechanicalAdmission"],true,"an ordinary open brace reaches the chassis");
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"c","x":80,"y":40}),json!({"id":"d","x":100,"y":40})]);
        source["plates"].as_array_mut().unwrap().push(plate("loose","c","d"));
        let issue=manufacture(&source,false).unwrap_err();assert_eq!(issue["code"],"PHYSICAL_SUPPORT");assert_eq!(issue["ids"],json!(["loose"]));
    }
    #[test]
    fn manufacturing_support_fixes_internal_equipment_inside_rooted_curved_rooms(){
        let cat=catalogue();let mut source=empty();source["preset"]=json!("vehicle");
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":0,"y":8},{"x":60,"y":0}],
            "topPlate":{"material":"steel","thicknessMm":8}});
        let mut source=seated(&source,&cat);
        let (bare,_)=framed(&source,&cat).unwrap();
        let floor=|k|{let p=bare.nodes.iter().find(|(id,_)|id==&format!("chassis:top-point-{k}")).unwrap().1;
            ((p.x-CONSTRUCTION_ORIGIN.x)/CELL,(p.y-CONSTRUCTION_ORIGIN.y)/CELL)};
        let (a,m,b)=(floor(0),floor(1),floor(2));
        source["nodes"]=json!([{"id":"a","x":a.0,"y":a.1},{"id":"b","x":b.0,"y":b.1},
            {"id":"c","x":b.0,"y":40},{"id":"d","x":a.0,"y":40},
            {"id":"m","x":m.0,"y":m.1},{"id":"n","x":m.0,"y":40}]);
        source["plates"]=json!([plate("rear","b","c"),plate("roof","c","n"),plate("roof-2","n","d"),plate("front","d","a"),plate("divider","m","n")]);
        source["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":-30,"y":20,"angle":0.0}},
            {"id":"command","kind":"command","pose":{"x":30,"y":20,"angle":0.0}}]);
        let ordinary=compile(&source,&cat).unwrap();let (frame,chassis)=framed(&source,&cat).unwrap();
        assert_eq!(frame.rooms.len(),2,"the real curved top plate and divider close both compartments");
        assert!(frame.rooms.iter().all(|room|room.walls.iter().any(|wall|wall.id.starts_with("chassis:top-"))));
        let frame_root=chassis.unwrap().support_shapes(frame.origin);
        for component in ordinary["compiled"]["modules"].as_array().unwrap().iter().take(2) {
            let pose=Pose::from_value(component);let shape:Vec<_>=rectangle(component["width"].as_f64().unwrap(),component["height"].as_f64().unwrap())
                .into_iter().map(|p|pose.world_point(p)).collect();
            assert!(frame.plates.iter().all(|plate|!support_touch(&shape,&frame.solid(plate,0.0)))
                && frame_root.iter().all(|root|!support_touch(&shape,root)),"the internal fixture has no individual support");
        }
        let make=|source:&Value,draft|request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":draft,"manufacture":{}}));
        let made=make(&source,false).unwrap();assert_eq!(made["compiled"]["mechanicalAdmission"],true);
        for key in ["nodes","plates","components","chassis"]{assert_eq!(made["construction"][key],ordinary["construction"][key],"fixation never rewrites {key}");}
        for key in ["plates","modules","fixedAssembly","chassis","eyes","sights","manufacturing"]{assert_eq!(made["compiled"][key],ordinary["compiled"][key],"fixation changes no geometry, limits or sensor cover: {key}");}
        source["components"][0]["pose"]["y"]=json!(70);
        let preview=make(&source,true).unwrap();let issue=preview["compiled"]["admissionIssues"].as_array().unwrap().iter().find(|issue|issue["code"]=="PHYSICAL_SUPPORT").unwrap();
        assert_eq!(issue["ids"],json!(["engine"]),"equipment outside the rooted body still needs a real link");
        assert_eq!(make(&source,false).unwrap_err()["code"],"PHYSICAL_SUPPORT");
    }
    #[test]
    fn manufacturing_support_never_roots_a_floating_compartment_through_its_contents(){
        let cat=catalogue();let mut source=box_source();source["preset"]=json!("vehicle");
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],
            "topPlate":{"material":"steel","thicknessMm":8}});
        let mut source=seated(&source,&cat);
        for node in source["nodes"].as_array_mut().unwrap(){node["y"]=json!(node["y"].as_i64().unwrap()+20);}
        source["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":0,"y":40,"angle":0.0}}]);
        let preview=request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":true,"manufacture":{}})).unwrap();
        assert_eq!(preview["compiled"]["rooms"].as_array().unwrap().len(),1);
        let issue=preview["compiled"]["admissionIssues"].as_array().unwrap().iter().find(|issue|issue["code"]=="PHYSICAL_SUPPORT").unwrap();
        assert_eq!(issue["ids"],json!(["floor","rear","roof","front","engine"]));
        assert_eq!(preview["construction"]["components"][0]["pose"],source["components"][0]["pose"]);
        assert_eq!(request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":{}})).unwrap_err()["code"],"PHYSICAL_SUPPORT");
    }
    #[test]
    fn manufacturing_support_fixes_internal_command_in_a_grounded_body_without_opening_its_armour(){
        let cat=catalogue();let mut source=box_source();
        source["components"]=json!([{"id":"command","kind":"command","pose":{"x":0,"y":20,"angle":0.0}}]);
        let ordinary=compile(&source,&cat).unwrap();
        let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let made=request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":site})).unwrap();
        assert_eq!(made["compiled"]["mechanicalAdmission"],true);
        assert_eq!(made["construction"]["components"],ordinary["construction"]["components"]);
        assert_eq!(made["compiled"]["sights"],ordinary["compiled"]["sights"]);
        assert_eq!(made["compiled"]["sights"][0]["range"],0.0,"internal fixation grants no vision through steel");
        assert_eq!(made["compiled"]["eyes"],json!([]));
    }
    #[test]
    fn manufacturing_support_for_fixed_parts_uses_real_terrain_roots(){
        let cat=catalogue();let mut source=empty();
        source["nodes"]=json!([{"id":"a","x":-40,"y":0},{"id":"b","x":-20,"y":0},{"id":"c","x":20,"y":0},{"id":"d","x":40,"y":0}]);
        source["plates"]=json!([plate("left","a","b"),plate("right","c","d")]);
        let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let admit=|source:&Value,site:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":site}));
        assert_eq!(compile(&source,&cat).unwrap()["compiled"]["mechanicalAdmission"],true,"a source without a site remains ordinary compilable geometry");
        let pending=request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":true,"manufacture":{}})).unwrap();
        assert_eq!(pending["compiled"]["admissionIssues"],json!([{"code":"SUPPORT_SITE_REQUIRED"}]));
        assert_eq!(admit(&source,&site).unwrap()["compiled"]["mechanicalAdmission"],true,"separate pieces can each stand on real ground");
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"e","x":-5,"y":20}),json!({"id":"f","x":5,"y":20})]);
        source["plates"].as_array_mut().unwrap().push(plate("floating","e","f"));
        let issue=admit(&source,&site).unwrap_err();assert_eq!(issue["code"],"PHYSICAL_SUPPORT");assert_eq!(issue["ids"],json!(["floating"]));
        assert_eq!(admit(&source,&json!({})).unwrap_err()["code"],"SUPPORT_SITE_REQUIRED");
        let mut single=empty();let(_,height,_)=ComponentKind::Engine.dimensions();
        single["components"]=json!([{"id":"footed","kind":"engine","pose":{"x":0,"y":(0.04+height/2.0-CONSTRUCTION_ORIGIN.y)/CELL,"angle":0.0}}]);
        let stand=json!({"pose":{"x":12,"y":CONSTRUCTION_ORIGIN.y,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        assert_eq!(admit(&single,&stand).unwrap()["compiled"]["mechanicalAdmission"],true,"a single component resting on ground needs no closed hull");
    }
    #[test]
    fn manufacturing_support_keeps_level_running_gear_below_real_arches(){
        let cat=catalogue();let mut source=empty();source["preset"]=json!("vehicle");
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":-20,"y":0},{"x":0,"y":16},{"x":20,"y":0},{"x":60,"y":0}],
            "axles":[-15.25,15.25],"topPlate":{"material":"steel","thicknessMm":8}});
        let source=seated(&source,&cat);
        let made=request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":{}})).unwrap();
        let modules=made["compiled"]["modules"].as_array().unwrap();
        assert_eq!(modules.len(),2);assert_eq!(modules[0]["y"],modules[1]["y"]);
        assert_eq!(made["compiled"]["mechanicalAdmission"],true,"generated suspension mounts level gear without a new axle interval rule");
    }
    #[test]
    fn manufacturing_support_uses_fixed_weapon_feet_and_real_post_contact_after_ports(){
        let cat=catalogue();let mut source=box_source();let mut part=gun("minimi","light-trunnion");
        let mounted=mount_on_plate(&source,&cat,"front",0.5,"minimi","light-trunnion",(-0.2,0.2)).unwrap();
        part["pose"]=mounted["pose"].clone();part["mount"]=mounted["mount"].clone();source["components"]=json!([part]);
        let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let make=|source:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":site}));
        assert_eq!(make(&fed(source.clone(),BY_THE_REAR)).unwrap()["compiled"]["mechanicalAdmission"],true,"fixed feet touch remaining host metal outside the firing port");
        // Keep the same valid port but shorten its wall below both fixed feet. An ordinary arm still roots that wall.
        let full=compile(&source,&cat).unwrap();
        let inner=module(&full)["materialPolygons"][2].as_array().unwrap().iter().map(|p|p["y"].as_f64().unwrap()).fold(f64::INFINITY,f64::min);
        let half=0.175;assert!(half+0.004<inner,"the short host and its arm end below the fixed foot");
        let center=source["components"][0]["pose"]["y"].as_f64().unwrap();let half=half/CELL;
        let mut short=source.clone();
        short["nodes"].as_array_mut().unwrap().extend([json!({"id":"port-low","x":-60,"y":center-half}),
            json!({"id":"port-high","x":-60,"y":center+half}),json!({"id":"arm-back","x":60,"y":center+half})]);
        short["plates"][3]=plate("front","port-high","port-low");
        short["plates"].as_array_mut().unwrap().push(plate("arm","port-high","arm-back"));divide(&mut short,"rear","arm-back","rear-2");
        let compiled=compile(&short,&cat).unwrap();assert_eq!(module(&compiled)["weaponMount"]["hostId"],"front");
        assert!(module(&compiled)["weaponMount"]["walls"][0]["port"].is_object(),"the negative case still has a normally admitted firing port");
        let issue=make(&short).unwrap_err();assert_eq!(issue["code"],"PHYSICAL_SUPPORT");assert_eq!(issue["ids"],json!(["gun"]));
        let mut exposed=box_source();let mut part=gun("m2hb","pintle");
        let mounted=mount_on_plate(&exposed,&cat,"roof",0.5,"m2hb","pintle",(0.0,0.0)).unwrap();
        part["pose"]=mounted["pose"].clone();part["mount"]=mounted["mount"].clone();exposed["components"]=json!([part]);
        assert_eq!(make(&fed(exposed,BY_THE_REAR)).unwrap()["compiled"]["mechanicalAdmission"],true,"the whole exposed post touches the roof exactly");
        // A post 1 mm above a plate fails the existing 15 mm plate-clearance admission before manufacture.
        // Use a real grounded body as the support instead, so both contact and the gap are ordinary valid geometry.
        let(_,height,_)=ComponentKind::Engine.dimensions();let weapon=&cat["weapons"]["m2hb"];
        let(width,gun_height)=receiver_dimensions(weapon).unwrap();let post=crate::game_mounts::shortest_post(width,gun_height);
        let mut free=empty();let mut gun=gun("m2hb","pintle");
        gun["pose"]=json!({"x":0,"y":(0.04+height+post-CONSTRUCTION_ORIGIN.y)/CELL,"angle":PI/2.0});
        free["components"]=json!([{"id":"stand","kind":"engine","pose":{"x":0,"y":(0.04+height/2.0-CONSTRUCTION_ORIGIN.y)/CELL,"angle":0.0}},gun]);
        let ground=json!({"pose":{"x":12,"y":CONSTRUCTION_ORIGIN.y,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let manufacture=|source:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":ground}));
        let(_,rounds,_)=ComponentKind::Ammo.dimensions();
        assert_eq!(manufacture(&fed(free.clone(),(40.0,(0.04+rounds/4.0-CONSTRUCTION_ORIGIN.y)/CELL))).unwrap()["compiled"]["mechanicalAdmission"],true,
            "the real post rests on the grounded component");
        let y=free["components"][1]["pose"]["y"].as_f64().unwrap();free["components"][1]["pose"]["y"]=json!(y+0.001/CELL);
        let ordinary=compile(&free,&cat).unwrap();let modules=ordinary["compiled"]["modules"].as_array().unwrap();
        let pose=Pose::from_value(&modules[1]);
        let foot=modules[1]["materialPolygons"][0].as_array().unwrap().iter().map(|p|pose.world_point(Point::from_value(p)).y).fold(f64::INFINITY,f64::min);
        assert!((foot-modules[0]["y"].as_f64().unwrap()-modules[0]["height"].as_f64().unwrap()/2.0-0.001).abs()<1e-12,"the admitted post really has a 1 mm gap");
        let issue=manufacture(&free).unwrap_err();assert_eq!(issue["code"],"PHYSICAL_SUPPORT");assert_eq!(issue["ids"],json!(["gun"]),"a real 1 mm gap is not numerical contact");
    }
    fn catalogue()->Value{crate::game_damage::fixtures::full_catalogue().clone()}
    fn plate(id:&str,a:&str,b:&str)->Value{json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":8})}
    fn empty()->Value{json!({"version":CONSTRUCTION_VERSION,"preset":"bunker","nodes":[],"plates":[],"components":[]})}
    /// A box 6 m long and 2 m high, in cells.
    fn box_source()->Value{
        let mut source=empty();source["nodes"]=json!([{"id":"a","x":-60,"y":0},{"id":"b","x":60,"y":0},{"id":"c","x":60,"y":40},{"id":"d","x":-60,"y":40}]);
        source["plates"]=json!([plate("floor","a","b"),plate("rear","b","c"),plate("roof","c","d"),plate("front","d","a")]);source
    }
    /// A design whose gun is fabricated for how it stands, given a small box of rounds of its calibre at `at`, in cells
    /// (`WEAPON_UNFED`): by default over the floor of `box_source`, by its rear wall.
    fn fed(mut source:Value,(x,y):(f64,f64))->Value{
        let preset=source["components"].as_array().unwrap().iter().find(|part|part["kind"]=="weapon").unwrap()["weaponPreset"].clone();
        source["components"].as_array_mut().unwrap().push(json!({"id":"rounds","kind":"ammo","ammoPreset":preset,"sizeScale":0.5,"pose":{"x":x,"y":y,"angle":0}}));
        source
    }
    const BY_THE_REAR:(f64,f64)=(50.0,5.0);
    /// The plate `id` of a source divided at its node `at`, the part from there to its last end named `rest`.
    fn divide(source:&mut Value,id:&str,at:&str,rest:&str){
        let plates=source["plates"].as_array_mut().unwrap();let i=plates.iter().position(|plate|plate["id"]==id).unwrap();
        let mut part=plates[i].clone();part["id"]=json!(rest);part["a"]=json!(at);plates[i]["b"]=json!(at);plates.insert(i+1,part);
    }
    fn with_part(part:Value)->Value{let mut source=empty();source["components"]=json!([part]);source}
    fn gun(preset:&str,mount:&str)->Value{json!({"id":"gun","kind":"weapon","weaponPreset":preset,"pose":{"x":0,"y":20,"angle":0},"mount":{"preset":mount,"sector":{"min":0,"max":0}}})}
    fn module(result:&Value)->&Value{&result["compiled"]["modules"][0]}
    #[test]
    fn a_blank_draft_remains_editable_but_cannot_be_manufactured(){
        let cat=catalogue();let source=empty();
        assert_eq!(compile(&source,&cat).unwrap_err()["code"],"FRAME_EMPTY");
        let draft=compile_mode(&source,&cat,true).unwrap();
        assert_eq!(draft["compiled"]["mechanicalAdmission"],false);
        assert_eq!(draft["compiled"]["admissionIssues"],json!([{"code":"FRAME_EMPTY"}]));
    }
    #[test]
    fn geometry_edits_accept_free_parts_without_new_manufacturing_admission(){
        let cat=catalogue();
        for kind in ["engine","fuel","command","ammo","sensor","hopper","cistern","supply","excavator","drill","builder","blade","paver"]{
            let part=json!({"id":"free","kind":kind,"pose":{"x":20,"y":-6,"angle":0.4}});
            let source=with_part(part);let result=compile(&source,&cat).unwrap_or_else(|error|panic!("{kind}: {error}"));
            assert_eq!(result["compiled"]["rooms"],json!([]));assert_eq!(result["compiled"]["vehicle"]["chassisId"],Value::Null);
            assert_eq!(module(&result)["mountId"],Value::Null);assert_eq!(module(&result)["exposed"],true);
            assert!((module(&result)["x"].as_f64().unwrap()-13.0).abs()<1e-12);
            assert!((module(&result)["y"].as_f64().unwrap()-1.0).abs()<1e-12);
            assert_eq!(compile(&result["construction"],&cat).unwrap(),result);
        }
        for(preset,mount)in[("minimi","light-trunnion"),("m2hb","pintle"),("rh120","heavy-trunnion")]{
            assert!(compile(&with_part(gun(preset,mount)),&cat).is_ok());
        }
    }
    #[test]
    fn opening_a_room_keeps_every_unselected_pose_and_exposes_its_equipment(){
        let cat=catalogue();let mut source=box_source();source["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":0,"y":16,"angle":0}}]);
        let closed=compile(&source,&cat).unwrap();assert_eq!(closed["compiled"]["rooms"].as_array().unwrap().len(),1);
        assert!(module(&closed).get("exposed").is_none());source["plates"].as_array_mut().unwrap().pop();
        let open=compile(&source,&cat).unwrap();assert_eq!(open["compiled"]["rooms"],json!([]));
        assert_eq!(open["construction"]["components"],closed["construction"]["components"]);
        assert_eq!(module(&open)["x"],module(&closed)["x"]);assert_eq!(module(&open)["y"],module(&closed)["y"]);assert_eq!(module(&open)["exposed"],true);
        source["plates"][0]["thicknessMm"]=json!(40);
        assert_eq!(module(&compile(&source,&cat).unwrap())["y"],module(&closed)["y"]);
    }
    #[test]
    fn editing_one_plate_keeps_the_other_plates_actual_stock_and_material_properties(){
        let cat=catalogue();let mut source=box_source();
        for plate in source["plates"].as_array_mut().unwrap(){plate["thicknessMm"]=json!(100);}
        // A factory may choose extra stock at its joints once, on whole cells; later editing does not repeat that recipe.
        seed_plate_ends(&mut source).unwrap();
        assert_eq!(source["plates"][0]["ends"],json!({"start":1,"end":1}));
        let baseline=compile(&source,&cat).unwrap();
        let mut moved=source.clone();
        moved["nodes"].as_array_mut().unwrap().extend([
            json!({"id":"roof-a","x":54,"y":48}),json!({"id":"roof-b","x":-66,"y":48})]);
        moved["plates"][2]["a"]=json!("roof-a");moved["plates"][2]["b"]=json!("roof-b");
        let mut thickened=source.clone();thickened["plates"][2]["thicknessMm"]=json!(200);
        let mut opened=source.clone();opened["plates"].as_array_mut().unwrap().remove(2);
        for(label,authored)in[("moved",moved),("thickened",thickened),("removed",opened)]{
            let result=compile(&authored,&cat).unwrap_or_else(|error|panic!("{label}: {error}"));
            for id in ["floor","rear","front"]{
                let find=|result:&Value|result["compiled"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]==id).unwrap().clone();
                let(before,after)=(find(&baseline),find(&result));
                for key in ["x","y","angle","length","thicknessMm","ballisticGrid","originalArea","physicalMass","physicalCenterLocal","physicalInertia"]{
                    assert_eq!(before[key],after[key],"{label}, unselected {id}: {key}");
                }
            }
            assert_eq!(compile(&result["construction"],&cat).unwrap(),result);
        }
    }
    #[test]
    fn free_plate_ends_are_explicit_bounded_dimensions_with_no_automatic_joint_extension(){
        let cat=catalogue();let source=box_source();let plain=compile(&source,&cat).unwrap();
        for plate in plain["compiled"]["plates"].as_array().unwrap(){
            let expected=if plate["id"]=="floor"||plate["id"]=="roof"{6.0}else{2.0};
            assert!((plate["length"].as_f64().unwrap()-expected).abs()<1e-12);
        }
        assert!(plain["construction"]["plates"].as_array().unwrap().iter().all(|plate|plate.get("ends").is_none()));
        let mut longest=empty();longest["nodes"]=json!([{"id":"a","x":-120,"y":0},{"id":"b","x":120,"y":0}]);
        longest["plates"]=json!([plate("stock","a","b")]);longest["plates"][0]["ends"]=json!({"start":30,"end":30});
        let result=compile(&longest,&cat).unwrap();assert_eq!(result["compiled"]["plates"][0]["length"],15.0);
        assert_eq!(result["construction"]["plates"][0]["ends"],longest["plates"][0]["ends"]);
        for (ends,code) in [(json!({"start":-1,"end":0}),"FIELD"),(json!({"start":0,"end":31}),"FIELD"),(json!({"start":0}),"FIELD"),
            (json!({"start":0.5,"end":0}),"AUTHORING_GRID")]{
            longest["plates"][0]["ends"]=ends;let error=compile(&longest,&cat).unwrap_err();
            assert_eq!(error["code"],code);assert_eq!(error["within"],"ends");assert_eq!(error["ids"],json!(["stock"]));
        }
        longest["plates"][0]["ends"]=json!({"start":0,"end":0});
        let result=compile(&longest,&cat).unwrap();assert!(result["construction"]["plates"][0].get("ends").is_none());
        assert_eq!(result["compiled"]["plates"][0]["length"],12.0);
    }
    #[test]
    fn rooms_junctions_and_dividers_are_derived_without_welding_source_ids(){
        let cat=catalogue();let mut source=box_source();
        // Coincident independent endpoints close the same room without sharing authored identity.
        source["nodes"].as_array_mut().unwrap().push(json!({"id":"independent","x":-60,"y":0}));source["plates"][3]["b"]=json!("independent");
        let result=compile(&source,&cat).unwrap();assert_eq!(result["compiled"]["rooms"].as_array().unwrap().len(),1);
        assert_eq!(result["construction"]["plates"][3]["b"],"independent");
        assert_eq!(result["compiled"]["frame"]["plates"][3]["b"],"independent");
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"low","x":0,"y":0}),json!({"id":"high","x":0,"y":40})]);
        source["plates"].as_array_mut().unwrap().push(plate("divider","low","high"));
        // A divider standing on the floor and the roof between their ends meets them only where they are divided.
        let error=compile(&source,&cat).unwrap_err();
        assert_eq!((&error["code"],&error["ids"],&error["nodeIds"]),(&json!("PLATE_JUNCTION"),&json!(["floor"]),&json!(["low"])));
        divide(&mut source,"floor","low","floor-2");divide(&mut source,"roof","high","roof-2");
        let result=compile(&source,&cat).unwrap();assert_eq!(result["compiled"]["rooms"].as_array().unwrap().len(),2);
        assert_eq!(result["compiled"]["plates"][0]["anchors"].as_array().unwrap().len(),2);
        source["nodes"].as_array_mut().unwrap().push(json!({"id":"spur-end","x":20,"y":20}));
        source["plates"].as_array_mut().unwrap().push(plate("spur","low","spur-end"));
        assert_eq!(compile(&source,&cat).unwrap()["compiled"]["rooms"].as_array().unwrap().len(),2);
    }
    #[test]
    fn the_construction_box_stands_on_the_workshop_floor_and_never_follows_the_design(){
        // Six metres to either side of the reference and eight up from the floor the running gear stands on, however
        // the design stands in it: a room may grow under the reference as far as the floor, and no further.
        let cat=catalogue();let mut source=box_source();
        for node in source["nodes"].as_array_mut().unwrap(){node["y"]=json!(node["y"].as_i64().unwrap()+FLOOR);}
        let result=compile(&source,&cat).unwrap();assert_eq!(result["compiled"]["frame"]["origin"],CONSTRUCTION_ORIGIN.to_value());
        assert_eq!(result["compiled"]["rooms"].as_array().unwrap().len(),1);
        assert_eq!(result["compiled"]["frame"]["nodes"][0]["y"],0.0);
        let side=|source:&Value|{let error=compile(source,&cat).unwrap_err();assert_eq!(error["code"],"AUTHORING_EXTENT");
            (error["side"].as_str().unwrap().to_owned(),error["nodeIds"].clone())};
        let mut under=source.clone();under["nodes"][0]["y"]=json!(FLOOR-1);
        assert_eq!(side(&under),("below".to_owned(),json!(["a"])));
        // The top is eight metres over the floor, not over the design: one eight metres tall raised off the floor passes it.
        let mut tall=source.clone();tall["nodes"][2]["y"]=json!(FLOOR+HEIGHT);compile(&tall,&cat).unwrap();
        for node in tall["nodes"].as_array_mut().unwrap(){node["y"]=json!(node["y"].as_i64().unwrap()+1);}
        assert_eq!(side(&tall),("above".to_owned(),json!(["c"])));
        let mut wide=source.clone();wide["nodes"][1]["x"]=json!(REACH+1);
        let refused=compile(&wide,&cat).unwrap_err();
        assert_eq!((&refused["code"],&refused["field"]),(&json!("FIELD"),&json!("x")));
        assert_eq!(refused["range"].as_array().unwrap().iter().map(|n|n.as_f64().unwrap()).collect::<Vec<_>>(),vec![-(REACH as f64),REACH as f64]);
        assert_eq!((REACH,FLOOR,FLOOR+HEIGHT),(120,-26,134));
    }
    #[test]
    fn all_authored_positions_preserve_fractional_units_and_sub_cell_motion(){
        let cat=catalogue();let mut part=with_part(json!({"id":"engine","kind":"engine","pose":{"x":10.125,"y":0.25,"angle":0.0}}));
        let first=compile_mode(&part,&cat,true).unwrap();
        assert_eq!(first["construction"]["components"][0]["pose"],part["components"][0]["pose"]);
        part["components"][0]["pose"]["x"]=json!(10.325);
        let moved=compile_mode(&part,&cat,true).unwrap();
        assert!((module(&moved)["x"].as_f64().unwrap()-module(&first)["x"].as_f64().unwrap()-0.01).abs()<1e-12);
        let mut vehicle=empty();vehicle["preset"]=json!("vehicle");
        vehicle["chassis"]=json!({"model":"wheeled","points":[{"x":-70.25,"y":-4.125},{"x":70.125,"y":-4.125}],"axles":[-40.25,40.125]});
        let wheels=compile_mode(&vehicle,&cat,true).unwrap();
        assert_eq!(wheels["construction"]["chassis"]["points"],vehicle["chassis"]["points"]);
        assert_eq!(wheels["construction"]["chassis"]["axles"],vehicle["chassis"]["axles"]);
        let wheel=&wheels["compiled"]["modules"][0];
        assert!((wheel["x"].as_f64().unwrap()-CONSTRUCTION_ORIGIN.x-(-40.25)/(1.0/CELL)).abs()<1e-12);
        let old=vehicle["chassis"]["points"].clone();
        for point in vehicle["chassis"]["points"].as_array_mut().unwrap(){point["x"]=json!(point["x"].as_f64().unwrap()+0.2);}
        let translated=compile_mode(&vehicle,&cat,true).unwrap();
        let frame_x=|v:&Value|v["compiled"]["plates"][0]["x"].as_f64().unwrap();
        assert!((frame_x(&translated)-frame_x(&wheels)-0.01).abs()<1e-12);
        vehicle["chassis"]["points"]=old;
        vehicle["chassis"].as_object_mut().unwrap().remove("axles");vehicle["chassis"]["model"]=json!("tracked");
        let front=-60.125;let scale=cat["chassis"]["tracked"]["track"].as_f64().unwrap()/ComponentKind::Track.dimensions().1;
        vehicle["chassis"]["track"]=json!({"front":front,"rear":front+ComponentKind::track_length(7.0)*scale/CELL,
            "y":(cat["chassis"]["tracked"]["track"].as_f64().unwrap()/2.0+0.01-CONSTRUCTION_ORIGIN.y)/CELL});
        let track=compile_mode(&vehicle,&cat,true).unwrap();
        assert_eq!(track["construction"]["chassis"]["track"],vehicle["chassis"]["track"]);
        let reopened:Value=serde_json::from_str(&serde_json::to_string(&track["construction"]).unwrap()).unwrap();
        assert_eq!(compile_mode(&reopened,&cat,true).unwrap(),track);
        // This changes accepted numeric precision, not the coordinate unit or the integer count/stock rules.
        assert_eq!(metres(3),0.15);assert_eq!(cell(0.15),3);
    }
    #[test]
    fn free_plate_nodes_keep_length_and_centre_through_compile_and_reopen(){
        let cat=catalogue();let centre=Point::new(0.375,20.125);let half=5.0;
        for angle in [0.0,PI/4.0,0.173,-PI/3.0] {
            let d=Point::new(cos(angle)*half,sin(angle)*half);
            let mut source=empty();source["nodes"]=json!([
                {"id":"a","x":centre.x-d.x,"y":centre.y-d.y},
                {"id":"b","x":centre.x+d.x,"y":centre.y+d.y}]);
            source["plates"]=json!([plate("stock","a","b")]);
            let result=compile(&source,&cat).unwrap();let stock=&result["compiled"]["plates"][0];
            assert_eq!(result["construction"]["nodes"],source["nodes"]);
            assert!((stock["length"].as_f64().unwrap()-0.5).abs()<1e-12);
            assert!((stock["x"].as_f64().unwrap()-CONSTRUCTION_ORIGIN.x-centre.x/(1.0/CELL)).abs()<1e-12);
            assert!((stock["y"].as_f64().unwrap()-CONSTRUCTION_ORIGIN.y-centre.y/(1.0/CELL)).abs()<1e-12);
            let reopened:Value=serde_json::from_str(&serde_json::to_string(&result["construction"]).unwrap()).unwrap();
            assert_eq!(compile(&reopened,&cat).unwrap(),result);
        }
        // Integers and floating JSON numbers follow the same rule; neither is interpreted as metres or truncated.
        let integral=box_source();let mut floating=integral.clone();
        for node in floating["nodes"].as_array_mut().unwrap(){
            for axis in ["x","y"] {node[axis]=json!(node[axis].as_f64().unwrap());}
        }
        assert_eq!(compile(&integral,&cat).unwrap()["compiled"],compile(&floating,&cat).unwrap()["compiled"]);
        assert_eq!(compile(&floating,&cat).unwrap()["construction"]["nodes"],floating["nodes"]);
    }
    #[test]
    fn free_plate_nodes_keep_physical_length_and_construction_bounds(){
        let cat=catalogue();let mut source=empty();
        source["nodes"]=json!([{"id":"a","x":100.0,"y":0.125},{"id":"b","x":101.6,"y":0.125}]);
        source["plates"]=json!([plate("stock","a","b")]);
        // Eight centimetres must not depend on cancellation against the stable origin at X=12 m.
        let result=compile(&source,&cat).unwrap();
        assert!((result["compiled"]["plates"][0]["length"].as_f64().unwrap()-0.08).abs()<1e-12);
        source["nodes"][1]["x"]=json!(101.58);
        assert_eq!(compile(&source,&cat).unwrap_err()["code"],"PLATE_LENGTH");
        source["nodes"][1]["x"]=json!(105.5);
        for value in [Value::Null,json!("100.125"),json!(true)] {
            let mut invalid=source.clone();invalid["nodes"][0]["x"]=value;
            let error=compile(&invalid,&cat).unwrap_err();assert_eq!(error["code"],"FIELD");assert_eq!(error["nodeIds"],json!(["a"]));
        }
        for (axis,value,code,side) in [("x",120.125,"FIELD",None),("y",FLOOR as f64-0.125,"AUTHORING_EXTENT",Some("below")),
            ("y",(FLOOR+HEIGHT) as f64+0.125,"AUTHORING_EXTENT",Some("above"))] {
            let mut invalid=source.clone();invalid["nodes"][0][axis]=json!(value);
            let error=compile(&invalid,&cat).unwrap_err();assert_eq!(error["code"],code);
            if let Some(side)=side {assert_eq!(error["side"],side);}
        }
    }
    #[test]
    fn free_nodes_close_rooms_divided_where_plates_meet_and_keep_the_existing_junction_tolerance(){
        let cat=catalogue();let mut source=empty();
        source["nodes"]=json!([{"id":"a","x":-40.25,"y":0.125},{"id":"b","x":40.5,"y":0.125},
            {"id":"c","x":40.5,"y":40.25},{"id":"d","x":-40.25,"y":40.25}]);
        source["plates"]=json!([plate("floor","a","b"),plate("rear","b","c"),plate("roof","c","d"),plate("front","d","a")]);
        assert_eq!(compile(&source,&cat).unwrap()["compiled"]["rooms"].as_array().unwrap().len(),1);
        let ends=source["nodes"].as_array_mut().unwrap();
        ends.extend([json!({"id":"low","x":0.375,"y":0.125}),json!({"id":"high","x":0.375,"y":40.25})]);
        source["plates"].as_array_mut().unwrap().push(plate("divider","low","high"));
        divide(&mut source,"floor","low","floor-2");divide(&mut source,"roof","high","roof-2");
        let t=compile(&source,&cat).unwrap();assert_eq!(t["compiled"]["rooms"].as_array().unwrap().len(),2);
        source["nodes"].as_array_mut().unwrap().extend([
            json!({"id":"left","x":-40.25,"y":20.1875}),json!({"id":"right","x":40.5,"y":20.1875})]);
        source["plates"].as_array_mut().unwrap().push(plate("crossbar","left","right"));
        let error=compile(&source,&cat).unwrap_err();
        assert_eq!((&error["code"],&error["ids"],&error["nodeIds"]),(&json!("PLATE_JUNCTION"),&json!(["rear"]),&json!(["right"])));
        divide(&mut source,"rear","right","rear-2");divide(&mut source,"front","left","front-2");
        let error=compile(&source,&cat).unwrap_err();
        assert_eq!((&error["code"],&error["ids"]),(&json!("PLATE_CROSSING"),&json!(["crossbar","divider"])));
        // Where they cross, both are divided at one node.
        source["nodes"].as_array_mut().unwrap().push(json!({"id":"middle","x":0.375,"y":20.1875}));
        divide(&mut source,"crossbar","middle","crossbar-2");divide(&mut source,"divider","middle","divider-2");
        let crossed=compile(&source,&cat).unwrap();assert_eq!(crossed["compiled"]["rooms"].as_array().unwrap().len(),4);
        assert_eq!(crossed["construction"]["nodes"],source["nodes"]);
        assert_eq!(compile(&crossed["construction"],&cat).unwrap(),crossed);
        // A numeric coincidence is still joined only within the old EPS. Short of it, the end of the front stands in the
        // metal of the floor; a real gap is not healed by the compiler.
        for (gap,rooms) in [(EPS*0.1,Some(1)),(EPS*100.0,None),(0.01,Some(0))] {
            let mut almost=empty();almost["nodes"]=json!([{"id":"a","x":-40.25,"y":0.125},{"id":"b","x":40.5,"y":0.125},
                {"id":"c","x":40.5,"y":40.25},{"id":"d","x":-40.25,"y":40.25},
                {"id":"close","x":-40.25,"y":0.125+gap/CELL}]);
            almost["plates"]=json!([plate("floor","a","b"),plate("rear","b","c"),plate("roof","c","d"),plate("front","d","close")]);
            let Some(rooms)=rooms else {
                assert_eq!(compile(&almost,&cat).unwrap_err(),json!({"code":"PLATE_OVERLAP","ids":["front","floor"]}),"gap {gap}");
                continue;
            };
            let result=compile(&almost,&cat).unwrap();
            assert_eq!(result["compiled"]["rooms"].as_array().unwrap().len(),rooms,"gap {gap}");
            assert_eq!(result["construction"]["nodes"],almost["nodes"]);
        }
    }
    #[test]
    fn plates_touch_at_their_ends_and_face_to_face_but_never_stand_in_one_another(){
        let cat=catalogue();
        let made=|nodes:Value,plates:Value|{let mut source=empty();source["nodes"]=nodes;source["plates"]=plates;compile(&source,&cat)};
        let sheet=|id:&str,a:&str,b:&str,mm:f64|json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":mm});
        // A corner of plates as thick opens to 28° at the least: there the metal of either runs into the other for twice
        // their two half thicknesses.
        for (degrees,ok) in [(90.0,true),(30.0,true),(29.0,true),(27.0,false),(5.0,false)] {
            let angle=f64::to_radians(degrees);
            let result=made(json!([{"id":"o","x":0,"y":0},{"id":"a","x":40,"y":0},{"id":"b","x":40.0*angle.cos(),"y":40.0*angle.sin()}]),
                json!([sheet("first","o","a",20.0),sheet("second","o","b",20.0)]));
            if ok {result.unwrap_or_else(|e|panic!("{degrees}°: {e}"));}
            else {assert_eq!(result.unwrap_err(),json!({"code":"PLATE_OVERLAP","ids":["second","first"],"nodeIds":["o"]}),"{degrees}°");}
        }
        // A thin plate wholly in the corner of a thick one stands in it.
        let error=made(json!([{"id":"o","x":0,"y":0},{"id":"a","x":40,"y":0},{"id":"b","x":0,"y":2}]),
            json!([sheet("thick","o","a",300.0),sheet("thin","o","b",10.0)])).unwrap_err();
        assert_eq!(error,json!({"code":"PLATE_OVERLAP","ids":["thin","thick"],"nodeIds":["o"]}));
        // Laid face to face, as far apart as their half thicknesses, plates pass; nearer, they stand in each other. An end
        // against a face, off its line, touches it.
        for (apart,ok) in [(0.4,true),(0.6,true),(0.3,false)] {
            let result=made(json!([{"id":"a","x":0,"y":0},{"id":"b","x":40,"y":0},{"id":"c","x":0,"y":apart},{"id":"d","x":40,"y":apart},
                {"id":"e","x":20,"y":-0.2},{"id":"f","x":20,"y":-20}]),
                json!([sheet("under","a","b",20.0),sheet("over","c","d",20.0),sheet("post","e","f",20.0)]));
            if ok {result.unwrap_or_else(|e|panic!("{apart}: {e}"));}
            else {assert_eq!(result.unwrap_err(),json!({"code":"PLATE_OVERLAP","ids":["over","under"]}),"{apart}");}
        }
        // Nor do two plates cross between their ends.
        let error=made(json!([{"id":"a","x":0,"y":0},{"id":"b","x":40,"y":40},{"id":"c","x":0,"y":40},{"id":"d","x":40,"y":0}]),
            json!([sheet("rising","a","b",8.0),sheet("falling","c","d",8.0)])).unwrap_err();
        assert_eq!(error,json!({"code":"PLATE_CROSSING","ids":["falling","rising"]}));
    }
    #[test]
    fn equipment_stands_out_of_the_box_to_the_sides_and_over_it_but_never_under_its_floor(){
        let cat=catalogue();let engine=|x:i64,y:i64|with_part(json!({"id":"engine","kind":"engine","pose":{"x":x,"y":y,"angle":0}}));
        // The first cell its body stands over the floor from, 0.32 m half as high as it is.
        let half=(ComponentKind::Engine.dimensions().1/2.0/CELL).ceil() as i64;
        for (x,y) in [(REACH+10,20),(0,FLOOR+HEIGHT+10),(0,FLOOR+half)] {compile_mode(&engine(x,y),&cat,true).unwrap_or_else(|e|panic!("{x},{y}: {e}"));}
        let error=compile_mode(&engine(0,FLOOR+half-1),&cat,true).unwrap_err();
        assert_eq!((&error["code"],&error["side"],&error["within"],&error["ids"]),(&json!("AUTHORING_EXTENT"),&json!("below"),&json!("pose"),&json!(["engine"])));
        // Turned, it is its turned body that stands on the floor.
        let mut turned=engine(0,FLOOR+half);turned["components"][0]["pose"]["angle"]=json!(0.3);
        assert_eq!(compile_mode(&turned,&cat,true).unwrap_err()["side"],"below");
    }
    #[test]
    fn hull_and_chassis_stand_in_one_box_without_repositioning(){
        let cat=catalogue();let mut source=empty();source["preset"]=json!("vehicle");
        // Six metres long, where its model hangs its gear.
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-60,"y":-5},{"x":60,"y":-5}]});
        source["nodes"]=json!([{"id":"a","x":-20,"y":FLOOR+HEIGHT},{"id":"b","x":20,"y":FLOOR+HEIGHT}]);
        source["plates"]=json!([plate("stock","a","b")]);
        let result=compile(&source,&cat).unwrap();
        assert_eq!(result["compiled"]["mechanicalAdmission"],true);
        assert_eq!(result["construction"]["nodes"],source["nodes"]);
        assert_eq!(result["construction"]["chassis"]["points"],source["chassis"]["points"]);
        assert_eq!(result["compiled"]["frame"]["origin"],CONSTRUCTION_ORIGIN.to_value());
        // Past the box, each list is refused by the side of it it passes, a draft too.
        for draft in [false,true] {
            let mut high=source.clone();high["nodes"][1]["y"]=json!(FLOOR+HEIGHT+2);
            let error=compile_mode(&high,&cat,draft).unwrap_err();
            assert_eq!((error["code"].as_str(),error["side"].as_str(),&error["nodeIds"]),(Some("AUTHORING_EXTENT"),Some("above"),&json!(["b"])));
            let mut low=source.clone();low["chassis"]["points"][1]["y"]=json!(FLOOR-2);
            let error=compile_mode(&low,&cat,draft).unwrap_err();
            assert_eq!((error["code"].as_str(),error["side"].as_str(),error["within"].as_str(),error["index"].as_u64()),
                (Some("AUTHORING_EXTENT"),Some("below"),Some("chassis.points"),Some(1)));
        }
    }
    #[test]
    fn free_placement_still_refuses_real_overlap_and_invalid_authoring(){
        let cat=catalogue();let mut source=box_source();source["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":0,"y":0,"angle":0}}]);
        assert_eq!(compile(&source,&cat).unwrap_err()["code"],"COMPONENT_PLATE");
        source["components"][0]["pose"]["y"]=json!(16);let mut twin=source["components"][0].clone();twin["id"]=json!("twin");source["components"].as_array_mut().unwrap().push(twin);
        assert_eq!(compile(&source,&cat).unwrap_err()["code"],"CONSTRUCTION_OVERLAP");
        for version in [7,8,9] {let mut old=empty();old["version"]=json!(version);assert_eq!(compile(&old,&cat).unwrap_err()["code"],"CONSTRUCTION_VERSION");}
        // The plate a gun meets is found where it stands; no design names it.
        let mut named=with_part(gun("minimi","light-trunnion"));named["components"][0]["mount"]["hostId"]=json!("front");
        assert_eq!(compile(&named,&cat).unwrap_err()["code"],"AUTHORING_FIELDS");
        let mut forged=with_part(gun("minimi","light-trunnion"));forged["components"][0]["physicalMass"]=json!(0);
        assert_eq!(compile(&forged,&cat).unwrap_err()["code"],"AUTHORING_FIELDS");
        let mut unknown=with_part(gun("minimi","torre"));unknown["components"][0]["pose"]["x"]=json!(3);
        let refused=compile(&unknown,&cat).unwrap_err();
        assert_eq!((refused["code"].as_str(),refused["field"].as_str(),refused["within"].as_str()),(Some("FIELD"),Some("preset"),Some("mount")));
        unknown["components"][0]["mount"]["preset"]=json!("light-trunnion");
        assert_eq!(compile(&unknown,&cat).unwrap()["construction"]["components"][0]["pose"]["x"],3);
    }
    #[test]
    fn factory_body_feet_and_exposed_posts_touch_the_selected_plate_exactly(){
        let cat=catalogue();let source=box_source();
        for kind in ["sensor","engine"]{
            let mut part=json!({"id":"seated","kind":kind});
            part["pose"]=part_on_plate(&source,&cat,&part,"roof",0.37).unwrap();
            let mut authored=source.clone();authored["components"]=json!([part]);
            let made=compile(&authored,&cat).unwrap();let body=module(&made);
            let foot=body["y"].as_f64().unwrap()-body["height"].as_f64().unwrap()/2.0;
            assert!((foot-(CONSTRUCTION_ORIGIN.y+2.0+0.004)).abs()<1e-12,"{kind}: {body}");
            assert_eq!(made["construction"]["components"][0]["pose"],authored["components"][0]["pose"]);
        }
        let placed=mount_on_plate(&source,&cat,"roof",0.5,"m2hb","pintle",(0.0,0.0)).unwrap();
        let mut part=gun("m2hb","pintle");part["pose"]=placed["pose"].clone();part["mount"]=placed["mount"].clone();
        let mut authored=source;authored["components"]=json!([part]);
        let made=compile(&authored,&cat).unwrap();let gun=module(&made);
        assert_eq!(gun["weaponMount"]["hostId"],"roof");assert!(gun["weaponMount"]["exposed"].as_bool().unwrap());
        assert!(gun["weaponMount"].get("port").is_none(),"an exposed post needs contact, not a port");
    }
    #[test]
    fn an_exposed_gun_stands_upright_on_the_first_face_under_it_whatever_way_its_axis_lies(){
        let cat=catalogue();let(width,height)=receiver_dimensions(&cat["weapons"]["m2hb"]).unwrap();
        let shortest=crate::game_mounts::shortest_post(width,height);
        let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        // In the box over its floor and on its roof, its axis up or laid aslant, either way round.
        for (host,face) in [("floor",0.004),("roof",2.004)] {for (angle,mirrored) in [(PI/2.0,false),(0.4,false),(-PI/2.0,true),(2.0,true)] {
            let mut source=box_source();let mut part=gun("m2hb","pintle");
            part["pose"]=json!({"x":0,"y":(face+shortest+0.2)/CELL,"angle":angle,"mirrored":mirrored});source["components"]=json!([part]);
            let made=compile(&source,&cat).unwrap_or_else(|e|panic!("{host} {angle}: {e}"));let gun=module(&made);
            assert_eq!(gun["weaponMount"]["hostId"],host,"{angle}");assert!(made["construction"]["components"][0]["mount"].get("hostId").is_none());
            let pose=Pose::from_value(gun);
            let post:Vec<Point>=gun["materialPolygons"][0].as_array().unwrap().iter().map(|p|pose.world_point(Point::from_value(p))).collect();
            // Plumb in the construction from the trunnion down to the face, however the gun is turned.
            assert!((post[0].x-post[1].x).abs()<1e-9&&(post[2].x-post[3].x).abs()<1e-9&&(post[1].y-pose.y).abs()<1e-9,"{host} {angle}: {post:?}");
            for foot in [post[0],post[3]] {assert!((foot.y-CONSTRUCTION_ORIGIN.y-face).abs()<1e-9,"{host} {angle}: {foot:?}");}
            assert!(((post[2].x-post[1].x).abs()-crate::game_mounts::post_width(shortest+0.2,width,height)).abs()<1e-9);
            assert_eq!(request(&json!({"version":1,"construction":fed(source.clone(),BY_THE_REAR),"catalogue":cat,"manufacture":site})).unwrap()["compiled"]["mechanicalAdmission"],true,"{host} {angle}");
            // The field stands it on the same post.
            let live=crate::game_damage::Module::from_value(1,1,gun,&cat["weapons"],&cat["mounts"]).unwrap();
            let shape=live.mount.unwrap().receiver(width,height);
            for (a,b) in shape.iter().zip(gun["materialPolygons"][0].as_array().unwrap()) {assert!(a.distance(Point::from_value(b))<1e-12);}
        }}
    }
    #[test]
    fn an_exposed_gun_on_a_sloping_plate_stands_upright_with_its_foot_along_the_slope_sturdier_the_longer_it_is(){
        let cat=catalogue();let(width,height)=receiver_dimensions(&cat["weapons"]["m2hb"]).unwrap();
        let shortest=crate::game_mounts::shortest_post(width,height);
        // A plate rising a metre over four, 8 mm thick: its upper face over the middle of it.
        let mut source=empty();source["nodes"]=json!([{"id":"a","x":-40,"y":20},{"id":"b","x":40,"y":40}]);source["plates"]=json!([plate("slope","a","b")]);
        let(run,rise)=(4.0,1.0);let length=hypot(run,rise);let face=|x:f64|1.5+x*rise/run+0.004*length/run;
        let try_place=|post:f64|{let mut source=source.clone();let mut part=gun("m2hb","pintle");
            part["pose"]=json!({"x":0,"y":(face(0.0)+post)/CELL,"angle":0.3});source["components"]=json!([part]);compile(&source,&cat)};
        let place=|post:f64|try_place(post).unwrap();
        // As near as the receiver swings clear of the face, square to it: further along the upright post.
        let least=shortest*length/run;
        let(short,long)=(place(least),place(1.45));
        for (made,along) in [(&short,least),(&long,1.45)] {
            let gun=module(made);assert_eq!(gun["weaponMount"]["hostId"],"slope");
            let pose=Pose::from_value(gun);
            let post:Vec<Point>=gun["materialPolygons"][0].as_array().unwrap().iter().map(|p|sub(pose.world_point(Point::from_value(p)),CONSTRUCTION_ORIGIN)).collect();
            for foot in [post[0],post[3]] {assert!((foot.y-face(foot.x)).abs()<1e-9,"its foot on the sloping face: {foot:?}");}
            assert!(((post[2].x-post[1].x).abs()-crate::game_mounts::post_width(along,width,height)).abs()<1e-9);
            let live=crate::game_damage::Module::from_value(1,1,gun,&cat["weapons"],&cat["mounts"]).unwrap();
            assert!((live.mount.unwrap().post.unwrap().length-along).abs()<1e-9);
        }
        assert!(crate::game_mounts::post_width(1.45,width,height)>1.5*height/3.0,"a long post stands wider");
        // Further than the longest post, it stands on nothing; nearer the face than the receiver swings clear of, the
        // shortest post it would stand on cuts into the plate.
        assert!(module(&place(STANDOFF+0.05))["weaponMount"]["hostId"].is_null());
        assert_eq!(try_place(least-0.02).unwrap_err()["code"],"COMPONENT_PLATE");
    }
    #[test]
    fn broad_rocket_tubes_share_a_valid_default_shield_free_and_through_a_plate(){
        let cat=catalogue();let source=box_source();let part=gun("hydra70","light-trunnion");
        // The tube needs an aperture larger than the one implied by its receiver height alone.
        let free=compile(&with_part(part.clone()),&cat).unwrap();
        let radius=module(&free)["weaponMount"]["shield"]["radius"].as_f64().unwrap();
        let barrel=BarrelProfile::from_weapon(&cat["weapons"]["hydra70"]).unwrap();
        assert!(radius>=shield_minimum(barrel.radius));
        let mounted=mount_on_plate(&source,&cat,"front",0.5,"hydra70","light-trunnion",(0.0,0.0)).unwrap();
        let mut through=source.clone();let mut placed=part.clone();placed["pose"]=mounted["pose"].clone();placed["mount"]=mounted["mount"].clone();
        through["components"]=json!([placed]);
        let made=compile(&through,&cat).unwrap();assert_eq!(module(&made)["weaponMount"]["hostId"],"front");
        assert!(module(&made)["weaponMount"]["shield"]["radius"].as_f64().unwrap()>=shield_minimum(barrel.radius));
        let mut bad=part;bad["mount"]["radiusM"]=json!(0.1);
        assert_eq!(compile(&with_part(bad),&cat).unwrap_err()["code"],"FIELD","an explicitly undersized shield stays refused");
    }
    #[test]
    fn a_free_gun_keeps_its_pose_and_ammunition_and_refuses_an_incompatible_mount(){
        let cat=catalogue();let mut part=gun("rh120","heavy-trunnion");
        part["weaponAmmo"]=json!("heat");part["pose"]=json!({"x":3.17,"y":26.43,"angle":0.17,"mirrored":true});
        let fitted=compile_mode(&with_part(part.clone()),&cat,true).unwrap();
        let authored=&fitted["construction"]["components"][0];
        for key in ["id","pose","weaponPreset","weaponAmmo"] {assert_eq!(authored[key],part[key],"{key}");}
        assert_eq!(authored["mount"]["preset"],part["mount"]["preset"]);
        assert_eq!(authored["mount"]["sector"],json!({"min":0.0,"max":0.0}));
        part["mount"]["preset"]=json!("pintle");
        assert_eq!(compile_mode(&with_part(part),&cat,true).unwrap_err()["code"],"MOUNT_KIND");
    }
    #[test]
    fn an_integrated_port_is_optional_and_mantlet_geometry_is_independent_of_it(){
        let cat=catalogue();let mut source=box_source();let mut part=gun("minimi","light-trunnion");
        let mount=mount_on_plate(&source,&cat,"front",0.5,"minimi","light-trunnion",(-0.2,0.2)).unwrap();
        part["pose"]=mount["pose"].clone();part["mount"]=mount["mount"].clone();source["components"]=json!([part]);
        let fitted=compile(&source,&cat).unwrap();let before=module(&fitted);assert_eq!(before["weaponMount"]["hostId"],"front");assert!(before["weaponMount"]["walls"][0]["port"].is_object());
        source["plates"].as_array_mut().unwrap().pop();let free=compile(&source,&cat).unwrap();let after=module(&free);
        assert_eq!(after["weaponMount"]["hostId"],Value::Null);assert!(after["weaponMount"].get("port").is_none());
        for key in ["x","y","angle","physicalMass","physicalCenterLocal","physicalInertia","materialPolygons"]{assert_eq!(before[key],after[key],"{key}");}
        assert_eq!(before["weaponMount"]["shield"],after["weaponMount"]["shield"]);
    }
    #[test]
    fn a_free_blade_clears_real_tyres_without_a_support_or_axle_interval_policy(){
        let cat=catalogue();let mut source=empty();source["preset"]=json!("vehicle");
        let diameter=cat["chassis"]["wheeled"]["wheel"].as_f64().unwrap();
        let axle=cell(ComponentKind::Blade.dimensions().0/2.0+diameter/2.0+0.2);
        let end=axle+cell(diameter/2.0+0.2);
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-end,"y":10},{"x":end,"y":10}],"axles":[-axle,axle],"thicknessMm":40});
        // Where its model hangs its gear: the tyres stand on the floor however high it is.
        let lift=Chassis::read(&source,&cat).unwrap().unwrap().suspension();
        for point in source["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(10.0-lift);}
        source["components"]=json!([{"id":"blade","kind":"blade","pose":{"x":-axle,"y":cell(diameter/2.0+0.01-CONSTRUCTION_ORIGIN.y),"angle":0}}]);
        assert_eq!(compile_mode(&source,&cat,true).unwrap_err()["code"],"COMPONENT_GEAR");
        source["components"][0]["pose"]["x"]=json!(0);
        compile_mode(&source,&cat,true).unwrap_or_else(|error|panic!("blade clear between the tyres: {error}"));
        source["components"][0]["pose"]["x"]=json!(-axle);source["components"][0]["pose"]["y"]=json!(30);
        compile_mode(&source,&cat,true).unwrap_or_else(|error|panic!("the rule checks metal, not a forbidden horizontal axle interval: {error}"));
    }
    #[test]
    fn a_road_tool_reaches_past_the_ground_its_gear_stands_on_and_is_refused_too_high_where_it_is_made(){
        let cat=catalogue();let mut source=empty();source["preset"]=json!("vehicle");
        let diameter=cat["chassis"]["wheeled"]["wheel"].as_f64().unwrap();
        let axle=cell(ComponentKind::Blade.dimensions().0/2.0+diameter/2.0+0.2);
        let end=axle+cell(diameter/2.0+0.2);
        source["chassis"]=json!({"model":"wheeled","points":[{"x":-end,"y":10},{"x":end,"y":10}],"axles":[-axle,axle],"thicknessMm":40});
        let lift=Chassis::read(&source,&cat).unwrap().unwrap().suspension();
        for point in source["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(10.0-lift);}
        // A tool between the axles, `y` cells up, and how high its working point stands over the ground the tyres stand
        // on, 1 cm over the floor.
        let tool=|kind:&str,y:i64,source:&Value|{
            let mut source=source.clone();
            source["components"]=json!([{"id":"tool","kind":kind,"pose":{"x":0,"y":y,"angle":0}}]);
            let(_,height,_)=ComponentKind::from_name(kind).unwrap().dimensions();
            let share=if kind=="blade" {1.0} else {0.9};
            (source,CONSTRUCTION_ORIGIN.y+y as f64*CELL-(share-0.5)*height-0.01)
        };
        for (kind,least,slack) in [("blade",0.52,0.3),("paver",1.15,0.8)] {
            let mut heights=Vec::new();
            for y in -30..60 {
                let (source,rest)=tool(kind,y,&source);
                // Clear of the floor, of the frame and of the tyres.
                let Ok(draft)=compile_mode(&source,&cat,true) else{continue};
                heights.push(rest);
                let reach=module(&draft)["toolReach"].as_f64().unwrap();
                assert!((reach-f64::max(least,rest.min(TOOL_HEIGHT)+slack)).abs()<1e-9,"{kind} {rest} m up reaches {reach} m");
                let high=draft["compiled"]["admissionIssues"].as_array().unwrap().contains(&json!({"code":"TOOL_GROUND","ids":["tool"]}));
                assert_eq!(high,rest>TOOL_HEIGHT+EPS,"{kind} {rest} m up: {}",draft["compiled"]["admissionIssues"]);
                // The field takes back as it was a design it made before; it fabricates none too high.
                let made=compile(&source,&cat);
                assert!(made.as_ref().is_ok_and(|made|(module(made)["toolReach"].as_f64().unwrap()-reach).abs()<1e-12)
                    ||made.as_ref().is_err_and(|issue|issue["code"]!="TOOL_GROUND"),"{kind} {rest}: {made:?}");
                let fabricated=request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":{}}));
                assert_eq!(fabricated.as_ref().err().map(|issue|issue["code"]==json!("TOOL_GROUND")).unwrap_or(false),high,"{kind} {rest}: {fabricated:?}");
            }
            assert!(heights.iter().any(|&rest|rest<TOOL_HEIGHT-0.05)&&heights.iter().any(|&rest|rest>TOOL_HEIGHT+0.2),"{kind}: {heights:?}");
            // Over no running gear it goes as far as it goes.
            let(_,height,_)=ComponentKind::from_name(kind).unwrap().dimensions();
            let alone=compile_mode(&with_part(json!({"id":"tool","kind":kind,"sizeScale":0.5,"pose":{"x":0,"y":cell(height),"angle":0}})),&cat,true).unwrap();
            assert!((module(&alone)["toolReach"].as_f64().unwrap()-least*0.5).abs()<1e-12);
            assert!(alone["compiled"]["admissionIssues"].as_array().unwrap().iter().all(|issue|issue["code"]!="TOOL_GROUND"));
        }
    }
    #[test]
    fn weapon_capacity_sector_recoil_and_finite_metal_sweeps_remain_physical(){
        let cat=catalogue();let mut part=gun("rh120","heavy-trunnion");part["mount"]["sector"]=json!({"min":-0.1,"max":0.1});
        let free=compile(&with_part(part.clone()),&cat).unwrap();let compiled=module(&free);let weapon=&cat["weapons"]["rh120"];
        let native=crate::game_mounts::WeaponMount::admit(compiled,&cat["mounts"],weapon,1.35,0.46,BarrelProfile::from_value(compiled).unwrap()).unwrap();
        assert!(mount_plate_conflict(compiled,&native,weapon,Pose{x:13.0,y:2.3,angle:PI/2.0},0.2,0.02,false).unwrap());
        assert!(mount_plate_conflict(compiled,&native,weapon,Pose{x:11.0,y:2.3,angle:PI/2.0},0.2,0.02,false).unwrap());
        assert!(!mount_plate_conflict(compiled,&native,weapon,Pose{x:20.0,y:8.0,angle:0.0},1.0,0.02,false).unwrap());
        part["mount"]["sector"]["max"]=json!(3.0);assert!(compile(&with_part(part),&cat).is_err());
        assert!(compile(&with_part(gun("rh120","light-trunnion")),&cat).is_err());
    }
    #[test]
    fn scout_minimi_keeps_its_port_material_and_cold_admission_when_translated(){
        let cat=catalogue();
        let source=crate::game_templates::source("scout",&json!({"preset":"minimi","sensorModes":[]}),&cat).unwrap();
        let baseline=compile(&source,&cat).unwrap();
        let base_gun=baseline["compiled"]["modules"].as_array().unwrap().iter().find(|part|part["kind"]=="weapon").unwrap();
        let host_id=base_gun["weaponMount"]["hostId"].as_str().unwrap();
        let base_host=baseline["compiled"]["plates"].as_array().unwrap().iter().find(|part|part["id"]==host_id).unwrap();
        // The wall opening admits the established firing corridor; changing reference arithmetic must not narrow it.
        for(key,want)in[("lo",-0.12),("hi",0.12)]{
            assert!((base_gun["weaponMount"]["walls"][0]["port"][key].as_f64().unwrap()-want).abs()<1e-10,"{key}: {}",base_gun["weaponMount"]["walls"][0]["port"]);
        }
        // Up or down as far as its suspension reaches.
        for shift in [0,1,3,-4,4]{
            let mut authored=source.clone();
            for point in authored["nodes"].as_array_mut().unwrap(){point["y"]=json!(point["y"].as_f64().unwrap()+shift as f64);}
            for part in authored["components"].as_array_mut().unwrap(){let pose=&mut part["pose"];pose["y"]=json!(pose["y"].as_f64().unwrap()+shift as f64);}
            for point in authored["chassis"]["points"].as_array_mut().unwrap(){point["y"]=json!(point["y"].as_f64().unwrap()+shift as f64);}
            let result=compile(&authored,&cat).unwrap_or_else(|error|panic!("shift {shift}: {error}"));
            let gun=result["compiled"]["modules"].as_array().unwrap().iter().find(|part|part["kind"]=="weapon").unwrap();
            let host=result["compiled"]["plates"].as_array().unwrap().iter().find(|part|part["id"]==host_id).unwrap();
            for key in ["lo","hi","centerU"]{assert!((gun["weaponMount"]["walls"][0]["port"][key].as_f64().unwrap()-base_gun["weaponMount"]["walls"][0]["port"][key].as_f64().unwrap()).abs()<1e-10,"shift {shift}, {key}");}
            assert_eq!(host["ballisticGrid"]["bits"],base_host["ballisticGrid"]["bits"],"shift {shift}");
            assert!((host["physicalMass"].as_f64().unwrap()-base_host["physicalMass"].as_f64().unwrap()).abs()<1e-8);
            let scene=crate::game_damage::fixtures::scene(&[(1,"local",authored,12.0,false)],json!("flat"));
            let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();
            world.load_game_value(&scene).unwrap_or_else(|error|panic!("fresh shift {shift}: {error}"));
            let mut cold=scene.clone();let damage=&world.game.as_ref().unwrap().damage;
            cold["plates"]=json!(damage.plates.iter().map(|plate|{let mut value=plate.to_value();value["actor"]=json!(plate.actor);value}).collect::<Vec<_>>());
            cold["modules"]=json!(damage.modules.iter().map(|module|{let mut value=module.to_value();value["owner"]=json!(module.owner);value["actor"]=json!(module.actor);value}).collect::<Vec<_>>());
            world.load_game_value(&cold).unwrap_or_else(|error|panic!("cold shift {shift}: {error}"));
            let restored=world.game.as_ref().unwrap().damage.plates.iter().find(|plate|plate.cold["id"]==format!("local:{host_id}")).unwrap();
            let saved=cold["plates"].as_array().unwrap().iter().find(|plate|plate["id"]==format!("local:{host_id}")).unwrap();
            assert_eq!(restored.to_value()["ballisticGrid"],saved["ballisticGrid"]);
            assert_eq!(restored.to_value()["physicalMass"],saved["physicalMass"]);
        }
    }
    #[test]
    fn mirroring_an_exposed_gun_reflects_its_rest_bore_and_preserves_the_authored_sector(){
        let cat=catalogue();
        for angle in [PI/2.0,0.3,-1.2]{
            let mut part=gun("m2hb","pintle");part["pose"]=json!({"x":-20,"y":20,"angle":angle});
            part["mount"]["sector"]=json!({"min":-1.7,"max":1.6});
            let original=compile(&with_part(part.clone()),&cat).unwrap();
            part["pose"]=json!({"x":20,"y":20,"angle":-angle,"mirrored":true});
            let reflected=compile(&with_part(part),&cat).unwrap();
            let(a,b)=(module(&original),module(&reflected));
            assert_eq!(original["construction"]["components"][0]["mount"]["sector"],reflected["construction"]["components"][0]["mount"]["sector"]);
            assert!((a["aimOffset"].as_f64().unwrap()+b["aimOffset"].as_f64().unwrap()).abs()<1e-12);
            let(before,after)=(a["barrelAngle"].as_f64().unwrap(),b["barrelAngle"].as_f64().unwrap());
            assert!((cos(before)+cos(after)).abs()<1e-12);
            assert!((sin(before)-sin(after)).abs()<1e-12);
        }
    }
    #[test]
    fn mounted_guns_keep_catalogue_mass_balance_and_real_armour_metal(){
        let cat=catalogue();for(preset,name)in[("minimi","light-trunnion"),("rh120","heavy-trunnion"),("m2hb","pintle")]{
            let result=compile(&with_part(gun(preset,name)),&cat).unwrap();let gun=module(&result);let weapon=&cat["weapons"][preset];
            let(width,height)=receiver_dimensions(weapon).unwrap();let barrel=BarrelProfile::from_weapon(weapon).unwrap();
            let mount=crate::game_mounts::WeaponMount::admit(gun,&cat["mounts"],weapon,width,height,barrel).unwrap();
            let installed=weapon["installedMassKg"].as_f64().unwrap();let parts=mount.mass_parts(installed,width,height,barrel);
            let gun_parts=if mount.exposed{&parts[1..]}else{&parts[..4]};let mass=gun_parts.iter().map(|p|p.0).sum::<f64>();
            let moment=gun_parts.iter().fold(Point::ZERO,|sum,p|add(sum,mul(p.1,p.0)));
            assert!((mass-installed).abs()<1e-8*installed);assert!(moment.x.abs()<1e-8*installed&&moment.y.abs()<1e-8*installed);
            assert!(gun["physicalMass"].as_f64().unwrap()>installed);
        }
    }
    #[test]
    fn integrated_feet_keep_full_catalogue_clearance_mass_and_fixed_pose_when_sector_narrows(){
        let cat=catalogue();let mut part=gun("m777","heavy-trunnion");
        part["mount"]["sector"]=json!({"min":-0.5,"max":0.5});
        let wide=compile(&with_part(part.clone()),&cat).unwrap();
        part["mount"]["sector"]=json!({"min":0.0,"max":0.0});
        let narrow=compile(&with_part(part),&cat).unwrap();
        let (a,b)=(module(&wide),module(&narrow));
        for key in ["physicalMass","physicalInertia","physicalCenterLocal","materialPolygons"] {assert_eq!(a[key],b[key],"{key}");}
        let weapon=&cat["weapons"]["m777"];let barrel=BarrelProfile::from_value(a).unwrap();
        let mount=crate::game_mounts::WeaponMount::admit(a,&cat["mounts"],weapon,0.5,0.45,barrel).unwrap();
        let base=mount.base.unwrap();let angle=cat["mounts"]["heavy-trunnion"]["max"].as_f64().unwrap();
        assert!(base.mass(mount.material)>0.0&&base.mass(mount.material)<4200.0);
        // This transverse bound excludes the full mechanism at ALL axial recoil positions.
        assert!(base.inner_y*cos(angle)-base.half_width*sin(angle)>=0.45/2.0+CLEARANCE-1e-12);
        let pose=Pose{x:3.0,y:2.0,angle:0.37};
        for index in [2,3] {assert_eq!(crate::game_geometry::material_pose(pose,Some(0.8),index,false).angle,pose.angle);}
        let grid=MaterialGrid::new(Bounds{min_x:-1.0,max_x:1.0,min_y:-0.01,max_y:0.01});
        let touch=Pose{x:base.half_width+0.01,y:0.0,angle:PI/2.0};
        assert!(!crate::game_mounts::base_crosses_grid(&mount,Pose::default(),touch,&grid),"finite face contact is not penetration");
        let inside=Pose{x:touch.x-0.005,..touch};
        assert!(crate::game_mounts::base_crosses_grid(&mount,Pose::default(),inside,&grid),"real remaining steel blocks the foot");
        let mut void=grid.clone();for y in 0..void.ny {for x in 0..void.nx {void.clear_cell(x,y);}}
        assert!(!crate::game_mounts::base_crosses_grid(&mount,Pose::default(),inside,&void),"an empty real grid is not an obstacle");
        // The same finite contact near the world's far end, in both facing directions.
        let m2=compile(&with_part(gun("m2hb","light-trunnion")),&cat).unwrap();let value=module(&m2);
        let weapon=&cat["weapons"]["m2hb"];let(width,height)=receiver_dimensions(weapon).unwrap();
        let m2mount=crate::game_mounts::WeaponMount::admit(value,&cat["mounts"],weapon,width,height,BarrelProfile::from_value(value).unwrap()).unwrap();
        let m2base=m2mount.base.unwrap();
        for x in [12.5715,255966.5715] {for direction in [-1.0,1.0] {
            let pivot=Pose{x,y:434.4023069000243,angle:if direction<0.0{-PI}else{2.0*PI}};
            let wall=Pose{x:x+direction*(m2base.half_width+0.01),y:pivot.y,
                angle:if direction<0.0{-PI/2.0}else{3.0*PI/2.0}};
            assert!(!crate::game_mounts::base_crosses_grid(&m2mount,pivot,wall,&grid),"translated finite face contact at {x}, {direction}");
            let inside=Pose{x:wall.x-direction*0.001,..wall};
            assert!(crate::game_mounts::base_crosses_grid(&m2mount,pivot,inside,&grid),"real1mm penetration remains refused at {x}, {direction}");
            assert!(!crate::game_mounts::base_crosses_grid(&m2mount,pivot,inside,&void),"missing metal remains empty");
        }}
        // The real feet may stand below the chassis reference, but never below the workshop floor.
        for mirrored in [false,true] {
            let mut floor_gun=gun("m777","heavy-trunnion");
            floor_gun["pose"]=json!({"x":0,"y":(base.inner_y+base.thickness-CONSTRUCTION_ORIGIN.y)/CELL,"angle":0,"mirrored":mirrored});
            let source=with_part(floor_gun);
            let accepted=compile_mode(&source,&cat,true).unwrap();
            assert!(source["components"][0]["pose"]["y"].as_f64().unwrap()<0.0,"below the chassis reference remains free");
            let at=Pose::from_value(module(&accepted));
            let lowest=base.polygons().iter().flatten().map(|&p|at.world_point(p).y).fold(f64::INFINITY,f64::min);
            assert!(lowest.abs()<EPS,"the actual foot can touch the authoring floor");
            let mut below=source.clone();
            below["components"][0]["pose"]["y"]=json!(source["components"][0]["pose"]["y"].as_f64().unwrap()-0.001/CELL);
            let receiver_y=module(&accepted)["y"].as_f64().unwrap()-0.001-0.45/2.0;
            assert!(receiver_y>0.0,"the old receiver-only test would still pass");
            for draft in [false,true] {
                let error=compile_mode(&below,&cat,draft).unwrap_err();
                assert_eq!(error["code"],"AUTHORING_EXTENT");assert_eq!(error["side"],"below");
                assert_eq!(error["within"],"pose");
            }
        }
    }
    #[test]
    fn ammunition_reserves_and_material_mass_keep_their_single_authority(){
        let cat=catalogue();let mut source=with_part(gun("rh120","heavy-trunnion"));source["components"][0]["weaponAmmo"]=cat["weapons"]["rh120"]["allowedAmmo"][1].clone();
        source["components"].as_array_mut().unwrap().push(json!({"id":"box","kind":"ammo","ammoPreset":"rh120","pose":{"x":-60,"y":0,"angle":0}}));
        let result=compile(&source,&cat).unwrap();assert_eq!(result["compiled"]["modules"][1]["ammoType"],source["components"][0]["weaponAmmo"]);
        assert!(result["compiled"]["modules"][1]["rounds"].as_u64().unwrap()>0);
        let mut another=source["components"][0].clone();another["id"]=json!("other");another["weaponAmmo"]=cat["weapons"]["rh120"]["allowedAmmo"][0].clone();source["components"].as_array_mut().unwrap().push(another);
        assert_eq!(compile(&source,&cat).unwrap_err()["code"],"AMMUNITION_MISMATCH");
        let engine=json!({"id":"engine","kind":"engine","pose":{"x":0,"y":0,"angle":0}});let steel=compile(&with_part(engine.clone()),&cat).unwrap();
        let mut aluminium=engine;aluminium["metal"]=json!("aluminum");let alloy=compile(&with_part(aluminium),&cat).unwrap();assert!(module(&alloy)["physicalMass"].as_f64().unwrap()<module(&steel)["physicalMass"].as_f64().unwrap());
    }
    #[test]
    fn each_piece_is_made_of_what_its_kind_may_be_and_weighs_and_stands_that_share_of_the_steel_one(){
        let cat=catalogue();
        let made=|kind:&str,mode:&str,metal:Option<&str>|{
            let mut part=json!({"id":"piece","kind":kind,"pose":{"x":0,"y":0,"angle":0}});
            if kind=="ammo" {part["ammoPreset"]=json!("rh120");}
            if kind=="sensor" {part["sensorMode"]=json!(mode);}
            if let Some(metal)=metal {part["metal"]=json!(metal);}
            compile_mode(&with_part(part),&cat,true)
        };
        // What it holds is what it is, whatever its casing: the fuel of a tank, the rounds of a box.
        let held=|piece:&Value|piece["fuelLitres"].as_f64().unwrap_or(0.0)*0.835+piece["rounds"].as_f64().unwrap_or(0.0)*piece["roundMass"].as_f64().unwrap_or(0.0);
        let (mut fibre,mut plastic)=(Vec::new(),Vec::new());
        for (kind,mode) in [("sensor","radar"),("sensor","visual"),("sensor","sound"),("command",""),("engine",""),("fuel",""),("ammo",""),
            ("hopper",""),("cistern",""),("supply",""),("excavator",""),("drill",""),("builder","")] {
            let k=ComponentKind::from_name(kind).unwrap();
            let steel=made(kind,mode,None).unwrap();let steel=module(&steel).clone();
            for metal in crate::game_geometry::METALS.iter() {
                let result=made(kind,mode,Some(metal.name));
                if !k.metals(mode).contains(&metal.name) {
                    let error=result.unwrap_err();
                    assert_eq!((&error["code"],&error["field"]),(&json!("FIELD"),&json!("metal")),"{kind} {mode} of {}: {error}",metal.name);
                    continue;
                }
                let result=result.unwrap();let piece=module(&result);
                if metal.name=="fiberglass" {fibre.push((kind,mode));}
                if metal.name=="plastic" {plastic.push((kind,mode));}
                assert_eq!(piece.get("metal").and_then(Value::as_str),(metal.name!="steel").then_some(metal.name),"{kind}: steel is not written");
                assert_eq!(result["construction"]["components"][0].get("metal").and_then(Value::as_str),(metal.name!="steel").then_some(metal.name));
                // Of a sensor or a command post only the housing is of it, what is in it weighing as it does.
                let (mass,was)=(piece["physicalMass"].as_f64().unwrap(),steel["physicalMass"].as_f64().unwrap());
                let (share,_)=k.housing(mode);
                assert!((mass-held(piece)-(was-held(&steel))*(1.0-share+share*metal.mass)).abs()<1e-9,"{kind} {mode} of {}: {mass} for {was}",metal.name);
                assert!((held(piece)-held(&steel)).abs()<1e-9,"{kind} of {} holds what steel holds",metal.name);
                assert!((piece["maxHealth"].as_f64().unwrap()-steel["maxHealth"].as_f64().unwrap()*metal.health).abs()<1e-9,"{kind} {mode} of {}",metal.name);
            }
        }
        let cased=[("fuel",""),("cistern",""),("supply","")];
        assert_eq!(fibre,[[("sensor","radar"),("sensor","visual"),("sensor","sound")].as_slice(),&cased[..]].concat(),"glass fibre only where it is used");
        assert_eq!(plastic,[[("sensor","visual"),("sensor","sound")].as_slice(),&cased[..]].concat(),"plastic only where it is used");
        // The lightest and the weakest of them all, and the cheapest.
        let plastic=crate::game_geometry::METALS.iter().find(|metal|metal.name=="plastic").unwrap();
        for metal in crate::game_geometry::METALS.iter().filter(|metal|metal.name!="plastic") {
            assert!(plastic.mass<metal.mass && plastic.health<metal.health && plastic.price<metal.price,"{}",metal.name);
        }
        // A radar with a radome of glass fibre loses half of the three tenths of it that its housing is, and stands half of
        // what it did: the housing takes the hit. A camera in a case of plastic, which is half of it, loses 0.65 of that half.
        let (steel,fibre)=(made("sensor","radar",None).unwrap(),made("sensor","radar",Some("fiberglass")).unwrap());
        let (steel,fibre)=(module(&steel),module(&fibre));
        assert!((fibre["physicalMass"].as_f64().unwrap()-steel["physicalMass"].as_f64().unwrap()*0.85).abs()<1e-9);
        assert!((fibre["maxHealth"].as_f64().unwrap()-steel["maxHealth"].as_f64().unwrap()*0.5).abs()<1e-9);
        let (steel,case)=(made("sensor","visual",None).unwrap(),made("sensor","visual",Some("plastic")).unwrap());
        let (steel,case)=(module(&steel),module(&case));
        assert!((case["physicalMass"].as_f64().unwrap()-steel["physicalMass"].as_f64().unwrap()*0.675).abs()<1e-9);
        assert!((case["maxHealth"].as_f64().unwrap()-steel["maxHealth"].as_f64().unwrap()*0.35).abs()<1e-9);
        // A weapon has no metal to choose.
        let mut part=gun("rh120","heavy-trunnion");part["metal"]=json!("steel");
        assert_eq!(compile_mode(&with_part(part),&cat,true).unwrap_err()["code"],"AUTHORING_FIELDS");
    }
    #[test]
    fn a_gun_made_over_is_fed_by_the_boxes_of_its_cartridge_and_one_that_cannot_be_made_is_refused(){
        let cat=catalogue();let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let mounted=mount_on_plate(&box_source(),&cat,"roof",0.5,"m2hb","pintle",(0.0,0.0)).unwrap();
        let armed=|preset:&str|{let mut part=gun(preset,"pintle");part["pose"]=mounted["pose"].clone();part["mount"]=mounted["mount"].clone();part};
        let reserve=|preset:&str|json!({"id":"box","kind":"ammo","ammoPreset":preset,"pose":{"x":30,"y":8,"angle":0}});
        let with=|components:Value|{let mut source=box_source();source["components"]=components;source};
        let make=|components:Value|request(&json!({"version":1,"construction":with(components),"catalogue":cat,"draft":true,"manufacture":site}));
        let unfed=|made:&Value|made["compiled"]["admissionIssues"].as_array().unwrap().iter().any(|issue|issue["code"]=="WEAPON_UNFED");
        // A longer barrel, or three of them, fires the rounds of the gun it was made of from its boxes.
        let three=make(json!([armed("m2hb|L91"),reserve("m2hb")])).unwrap();
        assert!(!unfed(&three));
        assert_eq!(three["compiled"]["modules"][0]["weaponPreset"],"m2hb|L91");
        // Three of the M2's weigh more than a pintle is rated for: it carries them on a post grown to them, slower to lay
        // and costlier by as much (game_mounts.rs `rated`).
        let mut grown=cat.clone();crate::game_variant::ensure(&mut grown["weapons"],"m2hb|L91|N3").unwrap();
        let (gun_spec,pintle)=(&grown["weapons"]["m2hb|L91|N3"],&grown["mounts"]["pintle"]);
        let (installed,rated)=(gun_spec["installedMassKg"].as_f64().unwrap(),pintle["ratedMass"].as_f64().unwrap());
        assert!(installed>rated,"{installed} kg on a pintle rated for {rated}");
        let seated=mount_on_plate(&box_source(),&grown,"roof",0.5,"m2hb|L91|N3","pintle",(0.0,0.0)).unwrap();
        let mut part=gun("m2hb|L91|N3","pintle");part["pose"]=seated["pose"].clone();part["mount"]=seated["mount"].clone();
        let rotary=make(json!([part,reserve("m2hb")])).unwrap();
        let module=&rotary["compiled"]["modules"][0];
        let full=pintle["maxSpeed"].as_f64().unwrap().min(gun_spec["servoMaxSpeed"].as_f64().unwrap_or(f64::INFINITY));
        let speed=module["weaponMount"]["maxSpeed"].as_f64().unwrap();
        assert!((speed-full*(rated/installed).sqrt()).abs()<1e-12 && speed<full,"{speed} of {full}");
        let mut rerated=grown.clone();rerated["mounts"]["pintle"]["ratedMass"]=json!(installed);
        let (paid,unloaded)=(crate::game_cost::piece(module,&grown).unwrap(),crate::game_cost::piece(module,&rerated).unwrap());
        let cost=pintle["cost"].as_f64().unwrap();
        assert!((paid["weapons"].as_f64().unwrap()-unloaded["weapons"].as_f64().unwrap()-cost*(installed/rated-1.0)).abs()<1e-9);
        // Admitted to a field, its mount is the one it was compiled with.
        let scene=crate::game_damage::fixtures::scene(&[(1,"local",with(json!([part,reserve("m2hb")])),0.0,false)],json!("flat"));
        let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();
        world.load_game_value(&scene).unwrap();
        let gun_module=world.game.as_ref().unwrap().damage.modules.iter().find(|m|m.kind==ComponentKind::Weapon).unwrap();
        assert!((gun_module.mount.as_ref().unwrap().max_speed-speed).abs()<1e-12);
        // Of a calibre of 30 mm, the M2 is an autocannon, heavier than the armoured mounting of its kind is rated for: that
        // still gives it its base (game_mounts.rs `Base::derive`), which weighs less than the gun it is part of.
        let heavy="m2hb|D300|N3";crate::game_variant::ensure(&mut grown["weapons"],heavy).unwrap();
        let (trunnion,weapon)=(grown["mounts"]["medium-trunnion"].clone(),grown["weapons"][heavy].clone());
        assert_eq!(weapon["family"],"autocannon");
        assert!(weapon["installedMassKg"].as_f64().unwrap()>trunnion["ratedMass"].as_f64().unwrap());
        let seated=mount_on_plate(&box_source(),&grown,"front",0.5,heavy,"medium-trunnion",(-0.2,0.2)).unwrap();
        let mut part=gun(heavy,"medium-trunnion");part["pose"]=seated["pose"].clone();part["mount"]=seated["mount"].clone();
        let made=request(&json!({"version":1,"construction":with(json!([part])),"catalogue":grown,"draft":true,"manufacture":site})).unwrap();
        let module=&made["compiled"]["modules"][0];
        assert_eq!(module["weaponMount"]["preset"],"medium-trunnion");
        let full=trunnion["maxSpeed"].as_f64().unwrap().min(weapon["servoMaxSpeed"].as_f64().unwrap_or(f64::INFINITY));
        assert!(module["weaponMount"]["maxSpeed"].as_f64().unwrap()<full);
        // On a heavier charge it fires rounds of its own, which a box of the M2's does not hold.
        assert!(unfed(&make(json!([armed("m2hb|C110"),reserve("m2hb")])).unwrap()));
        assert!(!unfed(&make(json!([armed("m2hb|C110"),reserve("m2hb|C110")])).unwrap()));
        // A box holds rounds, not barrels; a gun that cannot be made is no gun.
        assert_eq!(make(json!([armed("m2hb"),reserve("m2hb|L91")])).unwrap_err()["field"],"ammoPreset");
        assert_eq!(make(json!([armed("m2hb|L10"),reserve("m2hb")])).unwrap_err()["field"],"weaponPreset");
    }
    #[test]
    fn a_gun_with_no_round_of_its_calibre_aboard_is_refused_where_it_is_fabricated_and_kept_where_it_was_made(){
        // A post on the roof of the grounded box, and a box of rounds over its floor.
        let cat=catalogue();let site=json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let mut part=gun("m2hb","pintle");let mounted=mount_on_plate(&box_source(),&cat,"roof",0.5,"m2hb","pintle",(0.0,0.0)).unwrap();
        part["pose"]=mounted["pose"].clone();part["mount"]=mounted["mount"].clone();
        let reserve=|preset:&str|json!({"id":"box","kind":"ammo","ammoPreset":preset,"pose":{"x":30,"y":8,"angle":0}});
        let with=|components:&Value|{let mut source=box_source();source["components"]=components.clone();source};
        let make=|components:&Value,draft:bool|request(&json!({"version":1,"construction":with(components),"catalogue":cat,"draft":draft,"manufacture":site}));
        let unfed=|made:&Value|made["compiled"]["admissionIssues"].as_array().unwrap().iter().filter(|issue|issue["code"]=="WEAPON_UNFED").cloned().collect::<Vec<_>>();
        assert_eq!(make(&json!([part,reserve("m2hb")]),false).unwrap()["compiled"]["mechanicalAdmission"],true,"fed by a box of its calibre");
        // A box of the calibre of the gun it was put in for, as one replaced leaves it, and no box at all.
        for components in [json!([part,reserve("minimi")]),json!([part])] {
            assert_eq!(make(&components,false).unwrap_err(),json!({"code":"WEAPON_UNFED","ids":["gun"]}),"{components}");
            assert_eq!(unfed(&make(&components,true).unwrap()),vec![json!({"code":"WEAPON_UNFED","ids":["gun"]})]);
            // Made before, it comes back to the field as it was, and a draft is told of it only as it would be fabricated.
            assert_eq!(compile(&with(&components),&cat).unwrap()["compiled"]["mechanicalAdmission"],true);
            assert!(unfed(&compile_mode(&with(&components),&cat,true).unwrap()).is_empty());
        }
        // A box of its calibre too small for a round of it is told with it; a box no gun takes is no refusal.
        let mut cannon=with_part(gun("rh120","heavy-trunnion"));
        cannon["components"].as_array_mut().unwrap().push(json!({"id":"box","kind":"ammo","ammoPreset":"rh120","sizeScale":0.25,"pose":{"x":-60,"y":0,"angle":0}}));
        let review=|source:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":true,"manufacture":{}})).unwrap();
        let small=review(&cannon);assert_eq!(small["compiled"]["modules"][1]["capacityRounds"],0);
        assert_eq!(unfed(&small),vec![json!({"code":"WEAPON_UNFED","ids":["gun","box"]})]);
        cannon["components"][1]["sizeScale"]=json!(1.0);assert!(unfed(&review(&cannon)).is_empty());
        cannon["components"].as_array_mut().unwrap().push(json!({"id":"spare","kind":"ammo","ammoPreset":"minimi","pose":{"x":60,"y":0,"angle":0}}));
        assert!(unfed(&review(&cannon)).is_empty());
        assert_eq!(make(&json!([part,reserve("m2hb"),{"id":"spare","kind":"ammo","ammoPreset":"minimi","pose":{"x":-30,"y":8,"angle":0}}]),false)
            .unwrap()["compiled"]["mechanicalAdmission"],true);
    }
    #[test]
    fn analytic_sector_extrema_include_stationary_boundary_and_sector_subset() {
        let (lo,hi)=angular_range(1.0,0.0,-0.2,0.2);assert_eq!(hi.to_bits(),1.0_f64.to_bits());
        assert_eq!(lo.to_bits(),cos(0.2).to_bits());
        let (lo,hi)=angular_range(0.0,1.0,-0.2,0.2);
        assert_eq!(lo.to_bits(),sin(-0.2).to_bits());assert_eq!(hi.to_bits(),sin(0.2).to_bits());
        let a=envelope(&[Point::new(1.0,0.0)],0.0,0.0,Point::new(2.0,3.0),0.0);
        assert_eq!(a.min_x.to_bits(),3.0_f64.to_bits());assert_eq!(a.max_y.to_bits(),3.0_f64.to_bits());
    }
    #[test]
    fn continuous_sweep_finds_a_thin_wall_between_endpoints_and_rejects_empty_aabb_corners() {
        let tube=Bounds{min_x:0.0,max_x:5.0,min_y:-0.002,max_y:0.002};
        let p=rotate(Point::new(4.0,0.0),0.1234);
        let target=rectangle(0.0001,0.0001).into_iter().map(|q|add(q,p)).collect::<Vec<_>>();
        assert!(!swept_box_intersects(tube,0.1,0.1,&target));
        assert!(!swept_box_intersects(tube,0.15,0.15,&target));
        assert!(!swept_box_intersects(tube,0.125,0.125,&target));
        assert!(swept_box_intersects(tube,0.1,0.15,&target));
        let empty_corner=rectangle(0.02,0.02).into_iter().map(|q|add(q,Point::new(4.98,1.0))).collect::<Vec<_>>();
        assert!(intersection_area(&corners(envelope(&corners(tube),0.0,0.4,Point::ZERO,0.0)),&empty_corner)>EPS);
        assert!(!swept_box_intersects(tube,0.0,0.4,&empty_corner));
        let reversed:Vec<_>=target.into_iter().rev().collect();
        assert!(swept_box_intersects(tube,0.1,0.15,&reversed));
    }
    #[test]
    fn two_tubes_laid_past_each_other_are_told_apart_by_what_they_sweep_not_by_its_bounds() {
        // The 4.25 m tube of a tank gun laid from 20 degrees up to 9 down, a metre over the 0.88 m tube of a heavy
        // machine gun laid from 20 up to 9 down, both towards the left: the bounds of the long slanting tube hold
        // the short one, the tubes never meet.
        let (long,short)=(Bounds{min_x:0.0,max_x:4.25,min_y:-0.115,max_y:0.115},Bounds{min_x:0.0,max_x:0.88,min_y:-0.0225,max_y:0.0225});
        let (upper,lower)=(Pose{x:0.0,y:1.0,angle:PI},Pose{x:-0.13,y:0.0,angle:PI});
        let (up,down)=(-20f64.to_radians(),9f64.to_radians());
        assert!(!swept_boxes_overlap(long,upper,up,down,short,lower,up,down));
        assert!(!swept_boxes_overlap(short,lower,up,down,long,upper,up,down));
        // Raised to 30 cm under the long one, the short one laid up meets it laid down.
        let near=Pose{y:0.7,..lower};
        assert!(swept_boxes_overlap(long,upper,up,down,short,near,up,down));
        assert!(swept_boxes_overlap(short,near,up,down,long,upper,up,down));
        // Held, the long one up and the short one down, they do not.
        assert!(!swept_boxes_overlap(long,upper,up,up,short,near,down,down));
    }
    /// A bunker on the ground of the workshop, where its floor lies.
    fn grounded()->Value{json!({"pose":{"x":12,"y":0.044,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]})}
    /// A camera over the roof of `box_source`, its foot `gap` over the face of the roof, `x` cells along it.
    fn camera_over(source:&mut Value,cat:&Value,id:&str,x:f64,gap:f64){
        let(_,height,_)=sensor_dimensions(cat,&json!({"sensorMode":"visual"})).unwrap();
        source["components"].as_array_mut().unwrap().push(json!({"id":id,"kind":"sensor","sensorMode":"visual",
            "pose":{"x":x,"y":(2.004+gap+height/2.0)/CELL,"angle":0}}));
    }
    #[test]
    fn an_outside_sensor_stands_on_a_column_down_to_the_first_metal_within_the_standoff(){
        let cat=catalogue();let site=grounded();
        let make=|source:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":site}));
        let(width,height,_)=sensor_dimensions(&cat,&json!({"sensorMode":"visual"})).unwrap();
        let camera=|gap:f64|{let mut source=box_source();camera_over(&mut source,&cat,"camera",10.0,gap);source};
        // Flush on the roof, it stands on a column of no length.
        let flush=make(&camera(0.0)).unwrap();let support=&module(&flush)["support"];
        assert_eq!((&support["host"],&support["reach"]),(&json!("roof"),&json!(0.0)));
        assert!(support.get("polygon").is_none()&&support.get("mass").is_none(),"{support}");
        // Half a metre over it, on half a metre of steel tube, which it weighs and carries lower down.
        let raised=make(&camera(0.5)).unwrap();let piece=module(&raised);let support=&piece["support"];
        assert_eq!(raised["compiled"]["mechanicalAdmission"],true);
        assert!((support["reach"].as_f64().unwrap()-0.5).abs()<1e-9&&support["host"]=="roof","{support}");
        let mass=support["mass"].as_f64().unwrap();
        let steel=Material::named("steel").unwrap().density;
        assert!((mass-0.5*column_section(column_width(ComponentKind::Sensor,width))*steel).abs()<1e-9,"{mass}");
        assert!((mass/0.5-5.4).abs()<0.2,"a camera mast of 54 mm steel tube, about 5.4 kg a metre: {mass}");
        assert!((piece["physicalMass"].as_f64().unwrap()-mass-module(&flush)["physicalMass"].as_f64().unwrap()).abs()<1e-9);
        assert!(piece["physicalCenterLocal"]["y"].as_f64().unwrap()<0.0&&piece["physicalInertia"].as_f64().unwrap()>module(&flush)["physicalInertia"].as_f64().unwrap());
        for p in support["foot"].as_array().unwrap() {assert!((p["y"].as_f64().unwrap()+height/2.0+0.5).abs()<1e-9,"its foot on the roof: {p}");}
        assert!((support["normal"]["y"].as_f64().unwrap()-1.0).abs()<1e-12);
        assert_eq!(support["polygon"].as_array().unwrap().len(),4);
        // It is paid as the steel it is, with the camera, whatever the housing of that is made of.
        let(alone,held)=(crate::game_cost::piece(module(&flush),&cat).unwrap(),crate::game_cost::piece(piece,&cat).unwrap());
        assert!(held["kept"].as_f64().unwrap()>alone["kept"].as_f64().unwrap());
        assert_eq!(held["command"],alone["command"]);
        // Past the standoff it stands on nothing, and is told so.
        let far=camera(STANDOFF+0.1);
        let issue=make(&far).unwrap_err();assert_eq!((&issue["code"],&issue["ids"]),(&json!("PHYSICAL_SUPPORT"),&json!(["camera"])));
        assert!(module(&compile(&far,&cat).unwrap())["support"].is_null());
        assert!(make(&camera(STANDOFF-0.01)).is_ok());
        // The first metal under it holds it: here an engine on the roof, which the roof holds.
        let mut stacked=box_source();let(_,engine,_)=ComponentKind::Engine.dimensions();
        stacked["components"]=json!([{"id":"engine","kind":"engine","pose":{"x":10,"y":(2.004+engine/2.0)/CELL,"angle":0}}]);
        camera_over(&mut stacked,&cat,"camera",10.0,engine+0.3);
        let made=make(&stacked).unwrap();let support=&made["compiled"]["modules"][1]["support"];
        assert_eq!(support["host"],"engine");assert!((support["reach"].as_f64().unwrap()-0.3).abs()<1e-9,"{support}");
    }
    #[test]
    fn a_level_camera_on_a_sloping_face_stands_on_a_column_whose_foot_lies_along_the_slope(){
        let cat=catalogue();let mut source=empty();
        source["nodes"]=json!([{"id":"a","x":-40,"y":20},{"id":"b","x":40,"y":40}]);source["plates"]=json!([plate("slope","b","a")]);
        let mut part=json!({"id":"camera","kind":"sensor","sensorMode":"visual"});
        part["pose"]=part_on_plate(&source,&cat,&part,"slope",0.5).unwrap();source["components"]=json!([part]);
        let result=compile(&source,&cat).unwrap();let piece=module(&result);let support=&piece["support"];
        assert_eq!((&support["host"],&piece["angle"]),(&json!("slope"),&json!(0.0)),"the camera stays level: {support}");
        let(rise,run)=(1.0,4.0);let length=hypot(rise,run);
        assert!((support["normal"]["x"].as_f64().unwrap()+rise/length).abs()<1e-9&&(support["normal"]["y"].as_f64().unwrap()-run/length).abs()<1e-9,"{support}");
        let foot:Vec<Point>=support["foot"].as_array().unwrap().iter().map(Point::from_value).collect();
        assert!(((foot[1].y-foot[0].y)/(foot[1].x-foot[0].x)-rise/run).abs()<1e-9,"its foot lies along the slope");
        let reach=support["reach"].as_f64().unwrap();
        assert!(reach>0.0&&reach<0.1,"it fills the wedge under the camera, which touches the slope at one corner: {reach}");
        assert_eq!(support["polygon"].as_array().unwrap().len(),4);
    }
    #[test]
    fn a_sensor_touching_a_wall_beside_it_is_held_there_without_a_column(){
        let cat=catalogue();let mut source=box_source();
        let mut part=json!({"id":"ear","kind":"sensor","sensorMode":"sound"});
        part["pose"]=part_on_plate(&source,&cat,&part,"rear",0.6).unwrap();source["components"]=json!([part]);
        let made=request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":grounded()})).unwrap();
        let support=&module(&made)["support"];
        assert_eq!(support["host"],"rear");assert!(support.get("reach").is_none()&&support.get("polygon").is_none(),"{support}");
        assert!((support["normal"]["x"].as_f64().unwrap()-1.0).abs()<1e-12,"the wall's face, towards the sensor");
        // An engine against its other side touches it as far: the wall still holds it.
        let ear=source["components"][0]["pose"].clone();let(width,_,_)=sensor_dimensions(&cat,&json!({"sensorMode":"sound"})).unwrap();
        let(engine,_,_)=ComponentKind::Engine.dimensions();
        source["components"].as_array_mut().unwrap().push(json!({"id":"engine","kind":"engine","pose":{
            "x":ear["x"].as_f64().unwrap()+(width+engine)/2.0/CELL,"y":ear["y"],"angle":0}}));
        let compiled=compile(&source,&cat).unwrap();let support=&module(&compiled)["support"];
        assert_eq!(support["host"],"rear","{support}");
    }
    #[test]
    fn a_column_crosses_no_other_metal_and_nothing_sweeps_through_it(){
        let cat=catalogue();
        // Its foot on a shelf under a plate that juts into it: no column passes that plate's edge.
        let mut source=box_source();camera_over(&mut source,&cat,"camera",0.0,0.8);
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"e","x":0,"y":48}),json!({"id":"f","x":-1,"y":56})]);
        source["plates"].as_array_mut().unwrap().push(plate("jut","e","f"));
        let jutting=compile(&source,&cat).unwrap();
        assert!(module(&jutting)["support"].is_null(),
            "{}",module(&jutting)["support"]);
        // A gun turning on its post beside it would sweep its barrel through the column.
        let mut source=box_source();let mut part=gun("m2hb","pintle");
        let mounted=mount_on_plate(&source,&cat,"roof",0.5+1.0/6.0,"m2hb","pintle",(-1.75,1.75)).unwrap();
        part["pose"]=mounted["pose"].clone();part["mount"]=mounted["mount"].clone();source["components"]=json!([part]);
        camera_over(&mut source,&cat,"camera",-3.0,1.49);
        let issue=compile(&source,&cat).unwrap_err();
        assert_eq!((&issue["code"],&issue["ids"]),(&json!("CONSTRUCTION_OVERLAP"),&json!(["camera","gun"])),"{issue}");
        source["components"][1]["pose"]["x"]=json!(12.0);
        assert!(module(&compile(&source,&cat).unwrap()).is_object(),"clear of its sweep the camera stands");
    }
    #[test]
    fn a_blade_hangs_from_a_column_up_to_the_metal_over_it_within_the_standoff(){
        let cat=catalogue();let site=json!({"pose":{"x":12,"y":1.33,"angle":0},"facing":-1,"clearance":0.04,"ground":[{"x":0,"y":0},{"x":24,"y":0}]});
        let(width,height,_)=ComponentKind::Blade.dimensions();
        // A box 2 m up on legs to the ground, a blade under its floor, `gap` under the face of it.
        let hung=|gap:f64|{
            let mut source=empty();
            source["nodes"]=json!([{"id":"a","x":-60,"y":-26},{"id":"b","x":-60,"y":40},{"id":"c","x":60,"y":40},{"id":"d","x":60,"y":-26}]);
            source["plates"]=json!([plate("leg","a","b"),plate("deck","b","c"),plate("other-leg","c","d")]);
            source["components"]=json!([{"id":"blade","kind":"blade","pose":{"x":0,"y":(1.996-gap-height/2.0)/CELL,"angle":0}}]);
            source
        };
        let make=|source:&Value|request(&json!({"version":1,"construction":source,"catalogue":cat,"manufacture":site}));
        let made=make(&hung(1.2)).unwrap();let piece=module(&made);let support=&piece["support"];
        assert_eq!(support["host"],"deck");assert!((support["reach"].as_f64().unwrap()-1.2).abs()<1e-9,"{support}");
        assert!((support["normal"]["y"].as_f64().unwrap()+1.0).abs()<1e-12,"the underside of the deck, towards the blade");
        let column:Vec<Point>=support["polygon"].as_array().unwrap().iter().map(Point::from_value).collect();
        let bounds=Bounds::points(&column);
        assert!((bounds.max_x-bounds.min_x-column_width(ComponentKind::Blade,width)).abs()<1e-9&&(bounds.min_y-height/2.0).abs()<1e-9);
        assert!(piece["physicalCenterLocal"]["y"].as_f64().unwrap()>0.0);
        let issue=make(&hung(STANDOFF+0.05)).unwrap_err();assert_eq!((&issue["code"],&issue["ids"]),(&json!("PHYSICAL_SUPPORT"),&json!(["blade"])));
        // Two half blades side by side touch only each other: each hangs from the deck by its own column.
        let mut pair=hung(1.0);
        pair["components"]=Value::Array([-1.0f64,1.0].iter().enumerate().map(|(i,side)|json!({"id":format!("blade{i}"),"kind":"blade",
            "sizeScale":0.5,"pose":{"x":side*width/4.0/CELL,"y":(1.996-1.0-height/4.0)/CELL,"angle":0}})).collect());
        let made=make(&pair).unwrap();let blades:Vec<_>=made["compiled"]["modules"].as_array().unwrap().iter().filter(|m|m["kind"]=="blade").collect();
        assert_eq!(blades.len(),2);
        for blade in blades {let support=&blade["support"];assert!(support["host"]=="deck"&&(support["reach"].as_f64().unwrap()-1.0).abs()<1e-9,"{support}");}
        // Struck where its column stands: the field takes the column for the steel of its piece.
        let blade=crate::game_damage::Module::from_value(1,1,piece,&cat["weapons"],&cat["mounts"]).unwrap();
        let shapes=blade.local_polygons();assert_eq!(shapes.len(),2);assert_eq!(shapes[1],column);
        let mut wrong=piece.clone();wrong["support"]["polygon"]=json!([{"x":0,"y":0},{"x":1,"y":0},{"x":0,"y":1},{"x":1,"y":1}]);
        assert!(crate::game_damage::Module::from_value(1,1,&wrong,&cat["weapons"],&cat["mounts"]).is_err(),"a column that is no convex counter-clockwise outline");
    }
    #[test]
    fn an_exposed_gun_drawn_off_its_face_stands_on_a_longer_post_up_to_the_standoff(){
        let cat=catalogue();let weapon=&cat["weapons"]["m2hb"];let(width,height)=receiver_dimensions(weapon).unwrap();
        let shortest=crate::game_mounts::shortest_post(width,height);
        let place=|lift:f64|{
            let mut part=gun("m2hb","pintle");let y=2.004+shortest+lift;
            part["pose"]=json!({"x":0,"y":y/CELL,"angle":PI/2.0});let mut source=box_source();source["components"]=json!([part]);
            compile_mode(&source,&cat,true).unwrap()
        };
        let post=|result:&Value|{let shape:Vec<Point>=module(result)["materialPolygons"][0].as_array().unwrap().iter().map(Point::from_value).collect();
            let b=Bounds::points(&shape);b.max_x-b.min_x};
        let(short,long)=(place(0.0),place(0.4));
        assert_eq!(module(&long)["weaponMount"]["hostId"],"roof","the gun stays on the roof, raised on its post");
        assert!((post(&short)-shortest).abs()<1e-9&&(post(&long)-shortest-0.4).abs()<1e-9,"{} {}",post(&short),post(&long));
        let steel=Material::named("steel").unwrap().density;
        let wide=crate::game_mounts::post_width(shortest+0.4,width,height);
        assert!((module(&long)["physicalMass"].as_f64().unwrap()-module(&short)["physicalMass"].as_f64().unwrap()
            -((shortest+0.4)*wide-shortest*height/3.0)*0.05*steel).abs()<1e-6);
        let made=request(&json!({"version":1,"construction":fed(long["construction"].clone(),BY_THE_REAR),"catalogue":cat,"manufacture":grounded()})).unwrap();
        assert_eq!(made["compiled"]["mechanicalAdmission"],true);
        let live=crate::game_damage::Module::from_value(1,1,module(&long),&cat["weapons"],&cat["mounts"]).unwrap();
        assert!((live.mount.unwrap().post.unwrap().length-shortest-0.4).abs()<1e-9,"the field stands it on the same post");
        // Further off than the longest post, it is put where it was, on no face, and stands on nothing.
        let far=place(STANDOFF-shortest+0.2);assert!(module(&far)["weaponMount"]["hostId"].is_null());
        let issue=request(&json!({"version":1,"construction":far["construction"],"catalogue":cat,"manufacture":grounded()})).unwrap_err();
        assert_eq!(issue["code"],"PHYSICAL_SUPPORT");
        let mut stretched=module(&long).clone();
        for end in ["a","b"] {let at=&mut stretched["weaponMount"]["walls"][0][end];at["x"]=json!(at["x"].as_f64().unwrap()-STANDOFF);}
        assert!(crate::game_damage::Module::from_value(1,1,&stretched,&cat["weapons"],&cat["mounts"]).is_err(),"no post longer than the standoff");
    }
    /// A box like `box_source` with its front sloping back a metre at the top, and a machine gun in it, its receiver well
    /// inside, turned `angle` from straight out of the box ahead (to the left), `back` further from the front than 30 cm,
    /// its sector 0.2 either side.
    fn sloped_front(angle:f64,back:f64)->Value{
        let mut source=box_source();source["nodes"][3]["x"]=json!(-40);
        let turn=if PI+angle>PI {angle-PI} else {PI+angle};
        let mut part=gun("m2hb","light-trunnion");part["pose"]=json!({"x":-44.0+back/CELL,"y":20,"angle":turn});
        part["mount"]["sector"]=json!({"min":-0.2,"max":0.2});
        source["components"]=json!([part]);source
    }
    #[test]
    fn an_enclosed_gun_fires_out_through_whatever_plate_its_barrel_crosses_at_whatever_angle(){
        let cat=catalogue();
        let port=|source:&Value|{let made=compile(source,&cat).unwrap_or_else(|e|panic!("{e}"));let gun=module(&made).clone();
            assert_eq!(gun["weaponMount"]["hostId"],"front");assert!(made["construction"]["components"][0]["mount"].get("hostId").is_none());
            let cut=&gun["weaponMount"]["walls"][0]["port"];(cut["hi"].as_f64().unwrap()-cut["lo"].as_f64().unwrap(),made)};
        // Rotated 20 degrees down through the front sloping 26.6 degrees back: aslant, square, and aslant the other way.
        let(square,_)=port(&sloped_front(-0.4636,0.0));
        let(aslant,made)=port(&sloped_front(0.0,0.0));let(steeper,_)=port(&sloped_front(0.3,0.0));
        assert!(square<=aslant&&aslant<steeper&&square<steeper,"the port grows the more aslant the barrel crosses: {square} {aslant} {steeper}");
        // Further back the same aslant barrel cuts a longer port.
        let(back,_)=port(&sloped_front(0.0,0.3));assert!(back>aslant,"{back} {aslant}");
        // The port is cut out of the plate, and the field takes it back as it was cut.
        let front=made["compiled"]["plates"].as_array().unwrap().iter().find(|p|p["id"]=="front").unwrap();
        let grid=MaterialGrid::from_value(&front["ballisticGrid"]).unwrap();
        assert!((0..grid.nx).any(|x|(0..grid.ny).all(|y|!grid.occupied(x,y))));
        let scene=crate::game_damage::fixtures::scene(&[(1,"local",sloped_front(0.0,0.0),12.0,false)],json!("flat"));
        let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();world.load_game_value(&scene).unwrap();
        // A sector too wide for the port to fit on the plate is told.
        let mut wide=sloped_front(0.3,0.0);wide["components"][0]["mount"]["sector"]=json!({"min":-0.65,"max":0.65});
        let issue=compile(&wide,&cat).unwrap_err();assert_eq!((&issue["code"],&issue["ids"]),(&json!("MOUNT_PORT"),&json!(["front","gun"])),"{issue}");
    }
    /// `sloped_front` with a partition from the floor to the roof 1.9 m ahead of the middle, 0.6 m behind the middle of
    /// the front.
    fn partitioned(angle:f64,back:f64)->Value{
        let mut source=sloped_front(angle,back);
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"p","x":-38,"y":0}),json!({"id":"q","x":-38,"y":40})]);
        divide(&mut source,"floor","p","floor-rear");divide(&mut source,"roof","q","roof-front");
        source["plates"].as_array_mut().unwrap().push(plate("partition","p","q"));source
    }
    fn port_walls(made:&Value)->Vec<(String,f64)>{
        module(made)["weaponMount"]["walls"].as_array().unwrap().iter()
            .map(|wall|(wall["wallId"].as_str().unwrap().to_owned(),wall["port"]["hi"].as_f64().unwrap()-wall["port"]["lo"].as_f64().unwrap())).collect()
    }
    #[test]
    fn a_barrel_through_a_partition_and_then_the_armour_fires_through_a_port_in_each(){
        let cat=catalogue();
        // 15 cm behind the partition, the barrel passes out through it and then, over its whole sector, through the
        // sloping front.
        let source=partitioned(0.0,0.45);let made=compile(&source,&cat).unwrap_or_else(|e|panic!("{e}"));
        let walls=port_walls(&made);
        assert_eq!(walls.iter().map(|(id,_)|id.as_str()).collect::<Vec<_>>(),["partition","front"],"the nearest first");
        assert_eq!(module(&made)["weaponMount"]["hostId"],"partition");
        // Each is cut as wide as the sweep is there: the front, further off and aslant, wider.
        assert!(walls[0].1<walls[1].1,"{walls:?}");
        for id in ["partition","front"] {
            let plate=made["compiled"]["plates"].as_array().unwrap().iter().find(|p|p["id"]==id).unwrap();
            let grid=MaterialGrid::from_value(&plate["ballisticGrid"]).unwrap();
            assert!((0..grid.nx).any(|x|(0..grid.ny).all(|y|!grid.occupied(x,y))),"{id}");
        }
        // The field takes both back as they were cut, either way the construction faces.
        let scene=crate::game_damage::fixtures::scene(&[(1,"local",source.clone(),12.0,false),(2,"other",source,24.0,true)],json!("flat"));
        let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();world.load_game_value(&scene).unwrap();
    }
    #[test]
    fn a_gun_whose_barrel_ends_short_of_its_compartment_wall_fires_through_a_port_where_its_line_of_fire_leaves(){
        let cat=catalogue();let ported=|source:&Value|port_walls(&compile(source,&cat).unwrap_or_else(|e|panic!("{e}")));
        // 1.3 m behind the front, its 0.88 m barrel ends 0.4 m short of it: the front is cut all the same, wider the
        // further back the gun stands.
        let(crossing,short,shorter)=(ported(&sloped_front(0.0,0.3)),ported(&sloped_front(0.0,1.0)),ported(&sloped_front(0.0,1.5)));
        assert_eq!(short[0].0,"front");assert!(crossing[0].1<short[0].1&&short[0].1<shorter[0].1,"{crossing:?} {short:?} {shorter:?}");
        let scene=crate::game_damage::fixtures::scene(&[(1,"local",sloped_front(0.0,1.0),12.0,false),(2,"other",sloped_front(0.0,1.0),24.0,true)],json!("flat"));
        let mut world=crate::NativeWorld::new(&[],0.0,-9.81).unwrap();world.load_game_value(&scene).unwrap();
        // Behind a partition it ends short of, only the partition, the wall of its own compartment, is cut: the front past
        // it is armour a shot meets.
        assert_eq!(ported(&partitioned(0.0,1.5)).iter().map(|(id,_)|id.as_str()).collect::<Vec<_>>(),["partition"]);
        // With no wall before it, as on an open platform, nothing is cut.
        let mut open=sloped_front(0.0,1.0);open["plates"]=json!([plate("floor","a","b")]);
        open["components"][0]["pose"]["y"]=json!(10);
        assert!(port_walls(&compile_mode(&open,&cat,true).unwrap()).is_empty());
    }
    #[test]
    fn a_barrel_through_the_front_and_a_spaced_plate_past_it_fires_through_both(){
        let cat=catalogue();let mut source=sloped_front(0.0,0.0);
        // A spaced plate before the front, out of the box: the barrel passes out through the front and through it.
        source["nodes"].as_array_mut().unwrap().extend([json!({"id":"e","x":-60,"y":10}),json!({"id":"f","x":-60,"y":32})]);
        source["plates"].as_array_mut().unwrap().push(plate("skirt","f","e"));
        assert_eq!(port_walls(&compile(&source,&cat).unwrap()).iter().map(|(id,_)|id.as_str()).collect::<Vec<_>>(),["front","skirt"]);
    }
    #[test]
    fn a_gun_put_in_near_a_face_is_seated_where_its_mounting_holds_it_and_keeps_its_angle(){
        let cat=catalogue();
        let seat=|source:&Value,part:Value,cursor:Point|request(&json!({"version":1,"construction":source,"catalogue":cat,"draft":true,
            "placement":{"component":part,"tolerance":0.08,"point":{"x":cursor.x,"y":cursor.y}}}));
        let at=|made:&Value|{let gun=module(made);(gun["x"].as_f64().unwrap(),gun["y"].as_f64().unwrap(),gun["angle"].as_f64().unwrap())};
        let mut source=box_source();source["components"]=json!([]);
        // On the front, from outside: behind it, its mantlet a clearance behind it, firing through it as it was turned.
        let front=add(CONSTRUCTION_ORIGIN,at_units(-60.0,20.0));
        let mut gun=gun("m2hb","light-trunnion");gun["pose"]=json!({"x":-60,"y":20,"angle":PI-0.1});
        let made=seat(&source,gun.clone(),Point::new(front.x-0.02,front.y)).unwrap();let(x,y,angle)=at(&made);
        assert!(x>front.x+0.1&&x<front.x+0.2&&(y-front.y).abs()<1e-9&&(angle-PI+0.1).abs()<1e-12,"{x} {y} {angle}");
        assert_eq!(module(&made)["weaponMount"]["hostId"],"front");
        assert!(made["construction"]["components"][0]["mount"]["radiusM"].is_number());
        // Over the roof, a pintle stands upright on its post as far over it as it was put, within what a post reaches.
        let roof=add(CONSTRUCTION_ORIGIN,at_units(0.0,40.0));
        let mut pintle=gun.clone();pintle["mount"]=json!({"preset":"pintle","sector":{"min":0,"max":0}});
        let(width,height)=receiver_dimensions(&cat["weapons"]["m2hb"]).unwrap();
        let shortest=crate::game_mounts::shortest_post(width,height);
        for (over,stands) in [(shortest+0.2,shortest+0.2),(0.1,shortest),(3.0,crate::game_mounts::STANDOFF)] {
            pintle["pose"]=json!({"x":0,"y":40.0+(over+0.004)/CELL,"angle":PI/2.0});
            let made=seat(&source,pintle.clone(),Point::new(roof.x,roof.y+0.01)).unwrap();let(x,y,_)=at(&made);
            assert!((x-roof.x).abs()<1e-9&&(y-roof.y-0.004-stands).abs()<1e-9,"{over}: {x} {y}");
            assert_eq!(module(&made)["weaponMount"]["hostId"],"roof");
        }
        // Over a slope, its post is long enough to hold it as far off the face as the shortest one does off a level one.
        let mut ramp=source.clone();ramp["nodes"].as_array_mut().unwrap().extend([json!({"id":"e","x":-100,"y":10}),json!({"id":"f","x":-70,"y":25})]);
        ramp["plates"].as_array_mut().unwrap().push(plate("ramp","e","f"));
        pintle["pose"]=json!({"x":-85,"y":30,"angle":PI});
        let on=add(CONSTRUCTION_ORIGIN,at_units(-85.0,17.5));
        let made=seat(&ramp,pintle.clone(),Point::new(on.x,on.y+0.01)).unwrap();let(x,y,_)=at(&made);
        let normal=Point::new(-1.0/5f64.sqrt(),2.0/5f64.sqrt());
        assert!((sub(Point::new(x,y),on).dot(normal)-0.004-shortest).abs()<1e-9,"{x} {y}");
        assert_eq!(module(&made)["weaponMount"]["hostId"],"ramp");
        // It cannot stand on the front: by it, it stays as it was put.
        pintle["pose"]=json!({"x":-70,"y":20,"angle":PI});
        let issue=seat(&source,pintle,Point::new(front.x-0.02,front.y)).unwrap_or_else(|error|error);
        assert_eq!(issue["placement"]["pose"]["x"].as_f64().or(issue["construction"]["components"][0]["pose"]["x"].as_f64()),Some(-70.0));
    }
    #[test]
    fn an_enclosed_gun_in_a_supported_room_is_held_there_like_any_other_piece(){
        let cat=catalogue();let site=grounded();
        // Rotated in the box, its feet touching nothing, its barrel out through the sloping front.
        let source=sloped_front(0.0,0.0);
        let made=request(&json!({"version":1,"construction":fed(source.clone(),BY_THE_REAR),"catalogue":cat,"manufacture":site})).unwrap();
        assert_eq!(made["compiled"]["mechanicalAdmission"],true);
        // Out of the box, on nothing, it is told.
        let mut open=source.clone();open["components"][0]["pose"]["x"]=json!(-90);
        open["components"][0]["pose"]["angle"]=json!(PI);
        let issue=request(&json!({"version":1,"construction":open,"catalogue":cat,"manufacture":site})).unwrap_err();
        assert_eq!((&issue["code"],&issue["ids"]),(&json!("PHYSICAL_SUPPORT"),&json!(["gun"])));
    }

}
