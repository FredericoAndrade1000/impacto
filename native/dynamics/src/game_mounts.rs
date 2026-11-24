//! One independently positioned mechanism: a receiver with curved armour or an exposed post.
//! Every plate its barrel passes through, and the wall of its own compartment its line of fire leaves by, has a port
//! cut in it at whatever angle the bore meets it; a wall is never a positioning requirement.
//! Projectile/material queries share these physical shapes; guns add no contact bodies.
use serde::{Deserialize, Serialize};
use crate::game_geometry::{BarrelProfile, Bounds, Point, Polygon, Pose, cos, hypot, sin, sqrt, atan2, segment_convex};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use crate::game_construction::CLEARANCE;
use crate::game_damage::{Material, Module, Plate, polygon_properties};
use serde_json::{Value,json};
use std::f64::consts::{PI,TAU};

/// No mount turns its bore further than this from its axis, in radians: an exposed one over its face to a little
/// below level on either side, an enclosed one far less, within its port.
pub(crate) const REACH: f64 = 2.0;
/// How far, in metres, a piece out in the open may stand off the metal that holds it: the post of an exposed mount
/// at its longest, and the column a sensor stands on or a blade hangs from (game_construction.rs `stand_off`).
pub(crate) const STANDOFF: f64 = 1.5;
/// The shortest post: as tall as the gun it carries reaches back from the trunnion and two clearances more, so the
/// receiver swings a clearance clear of the face it stands on however the barrel turns over it. A mount with no
/// plate stands on this one.
pub(crate) fn shortest_post(width:f64,height:f64)->f64 {hypot(width,height/2.0)+2.0*CLEARANCE}
/// The longest post a face takes the gun out to: `STANDOFF`, or the shortest where that is longer.
pub(crate) fn longest_post(width:f64,height:f64)->f64 {shortest_post(width,height).max(STANDOFF)}
/// How wide a post `length` long is under a gun `width` long behind its trunnion and `height` high: a third of the
/// height of the gun on the shortest post, and on a longer one as stiff against the gun's push at its top, its width
/// growing as the three-quarter power of its length (a tube whose walls keep in proportion bends as its length cubed
/// over its width to the fourth).
pub(crate) fn post_width(length:f64,width:f64,height:f64)->f64 {
    height/3.0*ComplexField::powf((length/shortest_post(width,height)).max(1.0),0.75)
}
/// The post an exposed mount bolts on the metal under it, in the frame of the mount: from the trunnion straight down
/// in its construction, whatever way the gun's axis lies, `lean` turned from straight back along that axis; `length`
/// long along its middle, `half` of its width to either side, its foot cut along the face it stands on, which falls
/// back `foot` along the post for each metre across it. With no metal under it, it may hang from the metal over it:
/// straight up to its face, as a gun is hung under the hull of an aircraft (`hung`).
#[derive(Clone,Copy,Debug,PartialEq,Serialize,Deserialize)]
pub struct Post {pub length:f64,pub lean:f64,pub foot:f64,pub half:f64}
impl Post {
    /// The way down of a construction in the frame of a mount whose axis lies at `axis` in it, as a turn from
    /// straight back along that axis.
    pub(crate) fn lean(axis:f64)->f64 {PI/2.0-axis}
    /// The shortest post, with nothing under it.
    pub(crate) fn free(axis:f64,width:f64,height:f64)->Self {
        let length=shortest_post(width,height);
        Self{length,lean:Self::lean(axis),foot:0.0,half:post_width(length,width,height)/2.0}
    }
    /// The post down to the face of the plate from `a` to `b` (its middle, in the frame of the mount), `wall` thick,
    /// if it stands on it: the face lies before the trunnion along the post and no nearer it than the shortest post,
    /// nor further along it than the longest.
    pub(crate) fn on(a:Point,b:Point,wall:f64,axis:f64,width:f64,height:f64)->Option<Self> {
        Self::reaching(a,b,wall,Self::lean(axis),width,height)
    }
    /// The post up to the face of the plate from `a` to `b` it hangs from, as `on` stands it.
    pub(crate) fn hung(a:Point,b:Point,wall:f64,axis:f64,width:f64,height:f64)->Option<Self> {
        Self::reaching(a,b,wall,Self::lean(axis)-PI,width,height)
    }
    /// The post along `lean` to the face of the plate from `a` to `b`.
    fn reaching(a:Point,b:Point,wall:f64,lean:f64,width:f64,height:f64)->Option<Self> {
        let length=a.distance(b);if length<=1e-9 {return None;}
        let (down,across)=(Point::new(-cos(lean),-sin(lean)),Point::new(-sin(lean),cos(lean)));
        let mut normal=Point::new(-(b.y-a.y)/length,(b.x-a.x)/length);
        if normal.dot(a)<0.0 {normal=Point::new(-normal.x,-normal.y);}
        let(face,facing)=(normal.dot(a)-wall/2.0,normal.dot(down));
        if facing<0.5||face<shortest_post(width,height)-1e-7 {return None;}
        let along=face/facing;if along>longest_post(width,height)+1e-7 {return None;}
        Some(Self{length:along,lean,foot:-normal.dot(across)/facing,half:post_width(along,width,height)/2.0})
    }
    /// Its outline, counter-clockwise.
    pub fn shape(self)->Polygon {
        let (down,across)=(Point::new(-cos(self.lean),-sin(self.lean)),Point::new(-sin(self.lean),cos(self.lean)));
        let at=|side:f64,reach:f64|Point::new(side*self.half*across.x+reach*down.x,side*self.half*across.y+reach*down.y);
        vec![at(-1.0,self.length-self.foot*self.half),at(-1.0,0.0),at(1.0,0.0),at(1.0,self.length+self.foot*self.half)]
    }
}
/// What an exposed mount carries on its post and turns with the barrel, in the frame of the bore: the gun's own
/// receiver behind the trunnion, and its barrel support before it. Each is as high above the bore as below it, so
/// the gun is the same solid aimed to either side of its post.
pub(crate) fn carried(width:f64,height:f64)->[Bounds;2] {
    [Bounds{min_x:-width,max_x:0.0,min_y:-height/2.0,max_y:height/2.0},
        Bounds{min_x:0.0,max_x:0.4*height,min_y:-height/4.0,max_y:height/4.0}]
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct WeaponMount {
    pub min: f64,
    pub max: f64,
    pub max_speed: f64,
    pub exposed: bool,
    /// The post an exposed mount stands on; none for an enclosed one.
    pub post: Option<Post>,
    pub shield: Option<Shield>,
    pub base: Option<Base>,
    pub depth: f64,
    pub material: Material,
}

/// Material roles have one order in compilation, live queries and cold snapshots.
#[derive(Clone,Copy,Debug,PartialEq,Eq)]
pub enum Role { Post, Receiver, Tube, Base, Shield, Carried }
pub fn role(exposed:bool,index:usize)->Role {
    match (exposed,index) {
        (true,0)=>Role::Post,(false,0)=>Role::Receiver,(_,1)=>Role::Tube,
        (false,2|3)=>Role::Base,(false,_)=>Role::Shield,(true,_)=>Role::Carried,
    }
}
impl Role {pub fn fixed(self)->bool {matches!(self,Self::Post|Self::Base)}}

/// Two fixed feet of the installation. Its catalogue mass already includes them.
/// Their transverse clearance holds for every axial position, including full recoil.
#[derive(Clone,Copy,Debug,Serialize,Deserialize)]
pub struct Base {pub half_width:f64,pub inner_y:f64,pub thickness:f64,pub depth:f64}
impl Base {
    pub fn derive(profile:&Value,shield:Shield,width:f64,height:f64,barrel:BarrelProfile,depth:f64,installed:f64,material:Material)->Result<Self,String> {
        let angle=scalar(profile,"min")?.abs().max(scalar(profile,"max")?.abs());
        if !(0.0..PI/2.0).contains(&angle) {return Err("Invalid integrated base sector".into());}
        let q=(height/2.0).max(barrel.radius);let half_width=q+CLEARANCE;
        let base=Self{half_width,inner_y:((q+CLEARANCE)/cos(angle)+half_width*sin(angle)/cos(angle))
            .max(shield.radius+shield.thickness+CLEARANCE),thickness:shield.thickness,depth:depth.min(width).min(height)};
        if ![base.half_width,base.inner_y,base.thickness,base.depth].iter().all(|v|v.is_finite()&&*v>0.0)
            || !installed.is_finite() || base.mass(material)>=installed {return Err("Integrated base exceeds installed mass".into());}
        Ok(base)
    }
    pub fn bounds(self,index:usize)->Bounds {
        let (min_y,max_y)=if index==2 {(self.inner_y,self.inner_y+self.thickness)}else{(-self.inner_y-self.thickness,-self.inner_y)};
        Bounds{min_x:-self.half_width,max_x:self.half_width,min_y,max_y}
    }
    pub fn polygons(self)->[Polygon;2] {[vertices(self.bounds(2)).to_vec(),vertices(self.bounds(3)).to_vec()]}
    pub fn mass(self,material:Material)->f64 {4.0*self.half_width*self.thickness*self.depth*material.density}
    pub fn part_at(self,p:Point)->Option<usize> {(2..=3).find(|&i|{
        let b=self.bounds(i);p.x>=b.min_x-1e-10&&p.x<=b.max_x+1e-10&&p.y>=b.min_y-1e-10&&p.y<=b.max_y+1e-10
    })}
}

/// The actual moving armour, in bore space: two curved sheets around a clear
/// opening. Its radial thickness and dimensions never depend on an aim limit.
#[derive(Clone,Copy,Debug,PartialEq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Shield {pub radius:f64,pub thickness:f64,pub half_angle:f64,pub opening:f64}
impl Shield {
    pub(crate) fn from_value(v:&Value)->Result<Self,String> {
        let shield=Self{radius:scalar(v,"radius")?,thickness:scalar(v,"thickness")?,half_angle:scalar(v,"halfAngle")?,opening:scalar(v,"opening")?};
        if !(0.01..=6.0).contains(&shield.radius) || !(0.001..=1.0).contains(&shield.thickness) || !(0.01..PI/2.0).contains(&shield.half_angle)
            || shield.opening<=0.0 || shield.opening>=shield.radius*sin(shield.half_angle) {return Err("Invalid curved mantlet".into());}
        Ok(shield)
    }
    fn gap(self)->f64 {atan2(self.opening,sqrt((self.radius*self.radius-self.opening*self.opening).max(0.0)))}
    /// Convex facets at no more than 2 cm of arc. Holes remove finite angular
    /// intervals through the sheet, rather than weakening the whole shield.
    pub fn polygons(self,holes:&[(f64,f64)])->Vec<Polygon> {
        let gap=self.gap();
        let point=|r:f64,a:f64|Point::new(r*cos(a),r*sin(a));
        let mut polygons=Vec::new();
        for (a,b) in [(-self.half_angle,-gap),(gap,self.half_angle)] {
            let n=(((b-a)*(self.radius+self.thickness)/0.02).ceil() as usize).clamp(1,256);
            for i in 0..n {
                let mut spans=vec![(a+(b-a)*i as f64/n as f64,a+(b-a)*(i+1) as f64/n as f64)];
                for &(lo,hi) in holes {spans=spans.into_iter().flat_map(|(a,b)|{
                    let mut next=Vec::with_capacity(2);
                    if a<lo {next.push((a,b.min(lo)));} if b>hi {next.push((a.max(hi),b));} next
                }).filter(|(a,b)|b-a>1e-10).collect();}
                for (lo,hi) in spans {polygons.push(vec![point(self.radius,lo),point(self.radius+self.thickness,lo),point(self.radius+self.thickness,hi),point(self.radius,hi)]);}
            }
        }
        polygons
    }
    pub fn to_value(self)->Value {json!({"radius":self.radius,"thickness":self.thickness,"halfAngle":self.half_angle,"opening":self.opening})}
}

/// The real port must clear the tube and any part of the curved mask which
/// passes through the wall, here square across the axis at `inset` from the trunnion. Widening a sector cuts a larger
/// opening; it creates no extra armour. At some elevations an opening can therefore be exposed.
pub(crate) fn port_sweep(inset:f64,wall:f64,barrel:BarrelProfile,min:f64,max:f64,shield:Shield)->(f64,f64) {
    let (mut lo,mut hi)=(f64::INFINITY,f64::NEG_INFINITY);
    for z in [inset-wall/2.0,inset+wall/2.0] {
        for theta in [min,max] {for side in [-1.0,1.0] {
            let y=(z*sin(theta)+side*barrel.radius)/cos(theta);lo=lo.min(y);hi=hi.max(y);
        }}
        for sign in [-1.0,1.0] {
            let near=atan2(sqrt((shield.radius*shield.radius-z*z).max(0.0)),z);
            let far=atan2(sqrt(((shield.radius+shield.thickness).powi(2)-z*z).max(0.0)),z);
            let (a,b)=if sign<0.0 {(-far,-near)} else {(near,far)};
            let a=a.max(min-shield.half_angle);let b=b.min(max+shield.half_angle);
            if a<=b {for angle in [a,b] {let y=z*sin(angle)/cos(angle);lo=lo.min(y);hi=hi.max(y);}}
        }
    }
    (lo,hi)
}

/// Where the port a barrel cuts in a plate runs along it, from the middle of its ends: from `lo` to `hi`, the
/// trunnion standing over `center`.
#[derive(Clone,Copy,Debug,PartialEq)]
pub(crate) struct Port {pub lo:f64,pub hi:f64,pub center:f64}
/// The port a barrel turned from `min` to `max` cuts in the plate from `a` to `b` (its middle, in the frame of the
/// mount), `wall` thick, at whatever angle its line of fire passes through it, whether the barrel reaches the plate or
/// ends short of it: the sweep of a wall square across the axis, turned to the face. It grows as the bore meets the
/// plate more aslant and as the gun stands further behind it. None where the plate is not before the trunnion across
/// the whole sector, or where the port would run past the ends of the plate.
pub(crate) fn wall_port(a:Point,b:Point,wall:f64,barrel:BarrelProfile,min:f64,max:f64,shield:Shield)->Option<Port> {
    let length=a.distance(b);if length<=1e-9 {return None;}
    let along=Point::new((b.x-a.x)/length,(b.y-a.y)/length);
    let mut normal=Point::new(-along.y,along.x);if normal.dot(a)<0.0 {normal=Point::new(-normal.x,-normal.y);}
    let(inset,face)=(normal.dot(a),atan2(normal.y,normal.x));let(from,to)=(min-face,max-face);
    if from<=0.05-PI/2.0||to>=PI/2.0-0.05||inset<=wall/2.0+1e-7 {return None;}
    let middle=Point::new((a.x+b.x)/2.0,(a.y+b.y)/2.0);
    let center=Point::new(inset*normal.x-middle.x,inset*normal.y-middle.y).dot(along);
    let(lo,hi)=quantized_port(length,center,along.dot(Point::new(-normal.y,normal.x)),port_sweep(inset,wall,barrel,from,to,shield));
    (lo>=CLEARANCE-length/2.0&&hi<=length/2.0-CLEARANCE&&lo<hi).then_some(Port{lo,hi,center})
}

/// Quantize the real wall opening, independently of the plate's mitred material grid.
/// Translating or reflecting an identical wall can change its measured length by a few ULPs;
/// that must not create another 2 cm column. Both compilation and cold admission use this rule.
pub(crate) fn quantized_port(length:f64,center:f64,direction:f64,sweep:(f64,f64))->(f64,f64) {
    let(lo,hi)=if direction<0.0{(center-sweep.1,center-sweep.0)}else{(center+sweep.0,center+sweep.1)};
    let columns=(length/0.02-1e-9).ceil().clamp(1.0,256.0);let dx=length/columns;
    (((lo+length/2.0)/dx).floor()*dx-length/2.0,((hi+length/2.0)/dx).ceil()*dx-length/2.0)
}

fn scalar(v: &Value, key: &str) -> Result<f64, String> {
    v[key].as_f64().filter(|x| x.is_finite()).ok_or_else(|| format!("Invalid mount {key}"))
}
/// The weight a mount is rated for, kg, and the weight of the gun it carries: a mount takes any gun of a kind it is
/// made for, and grows with one heavier than it is rated for — as much costlier as the gun is heavier (game_cost.rs),
/// and slower to lay by the square root of that (`effective_speed`). The workshop reckons the same (weapon-mounts.ts).
pub(crate) fn rated(profile: &Value, weapon: &Value) -> Result<(f64, f64), String> {
    let (rated, installed) = (scalar(profile, "ratedMass")?, scalar(weapon, "installedMassKg")?);
    if !(rated > 0.0 && installed > 0.0) { return Err("Invalid mount rated mass".into()); }
    Ok((rated, installed))
}
/// The mounting's capacity, limited by the weapon mechanism where its family states one, and slower for a gun heavier
/// than it is rated for (`rated`). Compile and raw-descriptor admission use this same exact rate.
pub(crate) fn effective_speed(profile: &Value, weapon: &Value) -> Result<f64, String> {
    let capacity = scalar(profile, "maxSpeed")?;
    let limit = if weapon.get("servoMaxSpeed").is_some() { scalar(weapon, "servoMaxSpeed")? } else { capacity };
    if !(0.001..=TAU).contains(&capacity) || !(0.001..=TAU).contains(&limit) {
        return Err("Invalid mount sector/rate".into());
    }
    let (rated, installed) = rated(profile, weapon)?;
    Ok(capacity.min(limit) * sqrt(rated / installed).min(1.0))
}
fn vertices(b: Bounds) -> [Point; 4] {
    [Point::new(b.min_x,b.min_y), Point::new(b.max_x,b.min_y),
        Point::new(b.max_x,b.max_y), Point::new(b.min_x,b.max_y)]
}
impl WeaponMount {
    fn descriptor(v: &Value) -> Result<Self, String> {
        let m = &v["weaponMount"];
        if m["version"] != 3 || m.get("mantlet").is_some() {
            return Err("Weapon requires a current physical mount".into());
        }
        let exposed=m["exposed"].as_bool().ok_or("Missing mount exposure")?;
        let material=Material::named(m["material"].as_str().ok_or("Missing mount material")?).ok_or("Invalid mount material")?;
        let shield=if exposed {if !m["shield"].is_null(){return Err("An exposed mount has no shield".into());}None}
            else {Some(Shield::from_value(&m["shield"])?) };
        let result = Self { min: scalar(m,"min")?, max:scalar(m,"max")?,
            max_speed:scalar(m,"maxSpeed")?, depth:scalar(m,"materialDepth")?, material, exposed,post:None,shield,base:None };
        if (scalar(m,"materialDensity")?-material.density).abs()>1e-8 {return Err("Mount density differs from its armour material".into());}
        if result.min>result.max || result.min<=-REACH || result.max>=REACH || result.max_speed<=0.0 || result.max_speed>TAU {
            return Err("Invalid mount sector/rate".into());
        }
        Ok(result)
    }
    pub fn admit(v:&Value,catalogue:&Value,weapon:&Value,width:f64,height:f64,barrel:BarrelProfile)->Result<Self,String> {
        let mut mount=Self::descriptor(v)?;let raw=&v["weaponMount"];
        let preset=raw["preset"].as_str().ok_or("Missing mount preset")?;let profile=&catalogue[preset];
        let family=weapon["family"].as_str().ok_or("Unknown mounted weapon")?;
        if (scalar(raw,"fireTolerance")?-crate::game_weapons::servo_fire_tolerance(family)).abs()>1e-12 {
            return Err("Mount fire tolerance differs from its weapon family".into());
        }
        let dimensions=crate::game_construction::receiver_dimensions(weapon)?;
        if !profile["families"].as_array().is_some_and(|families|families.iter().any(|f|f==family))
            || (width-dimensions.0).abs()>1e-10 || (height-dimensions.1).abs()>1e-10
            || (barrel.end-scalar(weapon,"barrel")?).abs()>1e-10 {return Err("Mount family or weapon dimensions differ from the catalogue".into());}
        let mirrored=raw["mirrored"].as_bool().ok_or("Missing mount parity")?;
        let(min,max)=if mirrored{(-scalar(profile,"max")?,-scalar(profile,"min")?)}else{(scalar(profile,"min")?,scalar(profile,"max")?)};
        if mount.min<min || mount.max>max || (mount.max_speed-effective_speed(profile,weapon)?).abs()>1e-12 {
            return Err("Mount sector/rate exceeds catalogue capacity".into());
        }
        if mount.exposed!=(profile["exposed"]==true)||mount.material.name()!="steel"
            ||(mount.depth-profile["depthM"].as_f64().unwrap_or(0.45)).abs()>1e-10
            ||(scalar(raw,"bodyWidth")?-crate::game_construction::BODY_WIDTH).abs()>1e-10
            ||(scalar(raw,"recoil")?-crate::game_construction::recoil(weapon)?).abs()>1e-12 {
            return Err("Mount material/depth/recoil differs from catalogue geometry".into());
        }
        let axis=scalar(raw,"hullAxis")?;
        if mount.exposed {
            // The post reaches straight down from the trunnion to the face it stands on, or straight up to the one it hangs
            // from. With no plate, the shortest.
            let walls=raw["walls"].as_array().ok_or("Missing mount walls")?;
            mount.post=Some(match walls.as_slice() {
                []=>Post::free(axis,width,height),
                [face]=>{
                    let(a,b,wall)=(Point::from_value(&face["a"]),Point::from_value(&face["b"]),scalar(face,"thicknessMm")?/1000.0);
                    Post::on(a,b,wall,axis,width,height).or_else(||Post::hung(a,b,wall,axis,width,height))
                        .ok_or("Exposed post differs from its real plate face")?
                },
                _=>return Err("An exposed post stands on one face".into()),
            });
        }
        if let Some(shield)=mount.shield {
            if (shield.thickness-scalar(profile,"armourMm")?/1000.0).abs()>1e-12
                ||(shield.half_angle-PI/3.0).abs()>1e-12
                ||(shield.opening-barrel.radius-CLEARANCE).abs()>1e-12
                ||shield.radius+shield.thickness>=barrel.end-CLEARANCE {
                return Err("Mantlet differs from its physical dimensions".into());
            }
            mount.base=Some(Base::derive(profile,shield,width,height,barrel,mount.depth,scalar(weapon,"installedMassKg")?,mount.material)?);
        }
        Ok(mount)
    }
    pub fn carries(&self)->bool {self.exposed}
    /// What stands behind the trunnion: the receiver of an enclosed gun, the post of an exposed one.
    pub fn receiver(&self,width:f64,height:f64)->Polygon {
        match self.post {Some(post)=>post.shape(),None=>vertices(Bounds{min_x:-width,max_x:0.0,min_y:-height/2.0,max_y:height/2.0}).to_vec()}
    }
    /// What of it stays where it was put: the two feet of an enclosed gun, the post of an exposed one.
    pub fn fixed_polygons(&self)->Vec<Polygon> {
        match (self.post,self.base) {(Some(post),_)=>vec![post.shape()],(None,Some(base))=>base.polygons().to_vec(),(None,None)=>Vec::new()}
    }
    pub fn polygons(&self,width:f64,height:f64,barrel:BarrelProfile)->Vec<Polygon> {
        self.remaining_polygons(width,height,barrel,&[])
    }
    fn prefix_polygons(&self,width:f64,height:f64,barrel:BarrelProfile)->Vec<Polygon> {
        let mut shapes=vec![self.receiver(width,height),
            vertices(Bounds{min_x:0.0,max_x:barrel.end,min_y:-barrel.radius,max_y:barrel.radius}).to_vec()];
        if self.exposed {shapes.extend(carried(width,height).into_iter().map(|b|vertices(b).to_vec()));}
        else {shapes.extend(self.base.expect("admitted integrated base").polygons());}
        shapes
    }
    pub fn remaining_polygons(&self,width:f64,height:f64,barrel:BarrelProfile,holes:&[(f64,f64)])->Vec<Polygon> {
        let mut shapes=self.prefix_polygons(width,height,barrel);
        if let Some(shield)=self.shield {shapes.extend(shield.polygons(holes));}
        shapes
    }
    /// Installation mass includes its fixed feet. What remains moves balanced
    /// on the trunnion; mask sheets (or the exposed post) retain their own mass.
    pub fn mass_parts(&self, installed_mass:f64, width:f64, height:f64, barrel:BarrelProfile)->Vec<(f64,Point,f64)> {
        let properties=self.polygons(width,height,barrel).iter().map(|p|polygon_properties(p)).collect::<Vec<_>>();
        let gun=|i:usize|if self.exposed {i>0} else {i<2};
        let moving_mass=installed_mass-self.base.map_or(0.0,|b|b.mass(self.material));
        let (mut rear,mut front)=((0.0,0.0),(0.0,0.0));
        for (_,p) in properties.iter().enumerate().filter(|&(i,_)|gun(i)) {
            let side=if p.center.x<0.0 {&mut rear} else {&mut front};
            side.0+=p.area;side.1+=p.area*p.center.x.abs();
        }
        let (rear_arm,front_arm)=(rear.1/rear.0.max(1e-12),front.1/front.0.max(1e-12));
        properties.iter().enumerate().map(|(i,p)|{
            let mass=if gun(i) {let (side,arm)=if p.center.x<0.0 {(rear.0,front_arm)} else {(front.0,rear_arm)};
                moving_mass*arm/(rear_arm+front_arm)*p.area/side
            } else {p.area*(if role(self.exposed,i)==Role::Base {self.base.unwrap().depth}else{self.depth})*self.material.density};
            (mass,p.center,mass*(p.second/p.area-p.center.dot(p.center)).max(0.0))
        }).collect()
    }
    /// The mounted gun as one rigid piece in the frame of its mount, its barrel along the axis: its mass, the centre
    /// of that and its second moment about the centre.
    pub fn fixed_properties(&self, installed_mass:f64, width:f64, height:f64, barrel:BarrelProfile)->(f64,Point,f64) {
        let parts=self.mass_parts(installed_mass,width,height,barrel);
        let mass=parts.iter().map(|p|p.0).sum::<f64>();
        let center=Point::new(parts.iter().map(|p|p.0*p.1.x).sum::<f64>()/mass,
            parts.iter().map(|p|p.0*p.1.y).sum::<f64>()/mass);
        let inertia=parts.iter().map(|p|p.2+p.0*Point::new(p.1.x-center.x,p.1.y-center.y).dot(Point::new(p.1.x-center.x,p.1.y-center.y))).sum::<f64>();
        (mass,center,inertia)
    }
    // Integrate strongest material on each disjoint chord. The tube stays a
    // placement/mass shape but supplies no ballistic resistance. Curved armour
    // pays only for the actual finite metal crossed, including local holes.
    #[cfg(test)]
    pub fn resistance(&self,a:Point,b:Point,width:f64,height:f64,barrel:BarrelProfile,receiver_mm:f64,cosine:f64,elevation:f64)->f64 {
        self.remaining_resistance(a,b,width,height,barrel,receiver_mm,cosine,elevation,&[])
    }
    pub fn remaining_resistance(&self,a:Point,b:Point,width:f64,height:f64,barrel:BarrelProfile,receiver_mm:f64,cosine:f64,elevation:f64,holes:&[(f64,f64)])->f64 {
        let length=a.distance(b);if length<=1e-12 {return 0.0;}
        let moving = Pose {angle:elevation,..Pose::default()};
        let (moving_a,moving_b)=(moving.local_point(a),moving.local_point(b));
        let mut intervals=Vec::new();let mut breaks=vec![0.0,1.0];
        for (i,polygon) in self.remaining_polygons(width,height,barrel,holes).iter().enumerate() {
            if i==1 {continue;}
            let part=role(self.exposed,i);
            let (a,b)=if part.fixed() {(a,b)} else {(moving_a,moving_b)};
            if let Some(span)=segment_convex(a,b,polygon) {
                let depth=(span.exit-span.enter).max(0.0)*length;
                if depth<=1e-12 {continue;}
                let density=if matches!(part,Role::Base|Role::Shield) {self.material.resistance*1000.0}
                    else {1250.0*receiver_mm/1000.0/cosine.max(0.08)/depth};
                intervals.push((span.enter,span.exit,density.min(self.material.resistance*1000.0)));
                breaks.push(span.enter);breaks.push(span.exit);
            }
        }
        breaks.sort_by(f64::total_cmp);
        let mut cost=0.0;
        for pair in breaks.windows(2) {
            let middle=(pair[0]+pair[1])/2.0;
            let density=intervals.iter().filter(|(lo,hi,_)|middle>=*lo && middle<=*hi).map(|(_,_,d)|*d).fold(0.0,f64::max);
            cost+=(pair[1]-pair[0])*length*density;
        }
        cost
    }
}


/// Validate the plates a mount meets against real metal: those an enclosed barrel fires through, each with its port, or
/// the one an exposed post stands on. A gun without one is a complete physical mechanism too; the descriptor stores
/// no required room or attachment tree.
pub fn admit_runtime(v:&Value,module:&mut Module,weapon:&Value,plates:&[Plate],actor:u32)->Result<(),String> {
    let mount=module.mount.as_ref().ok_or("Missing mounted weapon mechanism")?;
    let width=scalar(v,"width")?;let height=scalar(v,"height")?;let barrel=BarrelProfile::from_value(v)?;
    if !mount.exposed {
        let shapes=v["materialPolygons"].as_array().filter(|p|p.len()>=4).ok_or("Missing integrated weapon material prefix")?;
        for (supplied,expected) in shapes.iter().zip(mount.prefix_polygons(width,height,barrel)) {
            let supplied=supplied.as_array().filter(|p|p.len()==expected.len())
                .ok_or("Integrated weapon material prefix differs from current fixed base geometry")?;
            for (supplied,expected) in supplied.iter().zip(expected) {
                if (scalar(supplied,"x")?-expected.x).abs()>1e-8 || (scalar(supplied,"y")?-expected.y).abs()>1e-8 {
                    return Err("Integrated weapon material prefix differs from current fixed base geometry".into());
                }
            }
        }
    }
    let raw=&v["weaponMount"];let pose=Pose::from_value(v);
    let walls=raw["walls"].as_array().ok_or("Missing mount walls")?;
    let mut hosts=Vec::new();
    for wall in walls {
        let owner=wall["owner"].as_u64().filter(|n|*n>0&&*n<=u32::MAX as u64).ok_or("Invalid mount wall owner")? as u32;
        let plate=plates.iter().find(|plate|plate.owner==owner&&plate.actor==actor).ok_or("Mount wall belongs to another actor")?;
        let thickness=scalar(wall,"thicknessMm")?/1000.0;
        if wall["wallId"]!=plate.cold["id"]||(thickness-plate.thickness).abs()>1e-9||hosts.contains(&owner) {
            return Err("Mount wall differs from its real plate".into());
        }
        let(a,b)=(Point::from_value(&wall["a"]),Point::from_value(&wall["b"]));let length=a.distance(b);
        for end in [a,b] {
            let local=plate.pose.local_point(pose.world_point(end));
            if local.y.abs()>1e-7||local.x.abs()>plate.length/2.0+1e-7 {return Err("Mount wall segment differs from its real plate".into());}
        }
        if length<=1e-8||length>plate.length+1e-7{return Err("Invalid mount wall length".into());}
        if mount.exposed {
            if wall.get("port").is_some() {return Err("Exposed post differs from its real plate face".into());}
        }else{
            // The stretch of the sector that fires through this plate: all of it, or the angles at which its line of fire
            // leaves the gun's compartment by it.
            let(from,to)=(scalar(&wall["port"],"min")?,scalar(&wall["port"],"max")?);
            if from<mount.min-1e-12||to>mount.max+1e-12||from>to {return Err("Port sector lies outside the mount's".into());}
            let port=wall_port(a,b,thickness,barrel,from,to,mount.shield.unwrap()).ok_or("Port does not fit its plate")?;
            let(lo,hi)=(port.lo,port.hi);
            if (scalar(&wall["port"],"lo")?-lo).abs()>1e-8||(scalar(&wall["port"],"hi")?-hi).abs()>1e-8
                ||(scalar(&wall["port"],"centerU")?-port.center).abs()>1e-8{return Err("Port differs from the quantized barrel sweep".into());}
            let middle=plate.pose.local_point(pose.world_point(Point::new((a.x+b.x)/2.0,(a.y+b.y)/2.0))).x;
            for x in 0..plate.grid.nx {
                let cell=plate.grid.cell_bounds(x,0);
                if cell.max_x>lo+middle+1e-10&&cell.min_x<hi+middle-1e-10&&(0..plate.grid.ny).any(|y|plate.grid.occupied(x,y)) {
                    return Err("Mount port was not removed from the real material grid".into());
                }
            }
        }
        hosts.push(owner);
    }
    // The plate it goes with is the first of them: the one its post stands on, or the nearest it fires through.
    if raw["hostOwner"]!=json!(hosts.first().copied().unwrap_or(0))||raw["hostId"]!=walls.first().map_or(Value::Null,|wall|wall["wallId"].clone()) {
        return Err("Mount host differs from its first wall".into());
    }
    for plate in plates.iter().filter(|plate|plate.actor==actor&&plate.attached){
        if crate::game_construction::mount_plate_conflict(v,mount,weapon,plate.pose,plate.length,plate.thickness,hosts.contains(&plate.owner))?
            || base_crosses_grid(mount,pose,plate.pose,&plate.grid) {
            return Err("Weapon sweep crosses real construction metal".into());
        }
    }
    let(mass,center,inertia)=mount.fixed_properties(scalar(weapon,"installedMassKg")?,width,height,barrel);
    let supplied=Point::from_value(&v["physicalCenterLocal"]);
    let supplied_mass=scalar(v,"physicalMass")?;
    let supplied_inertia=scalar(v,"physicalInertia")?;
    let expected_inertia=inertia*supplied_mass/mass;
    // The body batches changes in payload. Its recorded weight may lag the fire,
    // but cannot have lost more than the piece's finite combustible contents.
    let remaining=mass-crate::game_fire::consumed_solid(module);
    let tolerance=1e-8*mass.max(1.0);
    // Older host frames sent the new mass without the corresponding inertia.
    // Recover only that known projection; arbitrary moments remain inadmissible.
    let old_projection=module.burn_age>0.0&&(supplied_inertia-inertia).abs()<=1e-8*inertia.max(1.0);
    if !v["physicalCenterLocal"].is_object()||!supplied.x.is_finite()||!supplied.y.is_finite()
        ||(module.dry_mass-mass).abs()>tolerance||supplied_mass<remaining-tolerance||supplied_mass>mass+tolerance||supplied.distance(center)>1e-8
        ||!old_projection&&(supplied_inertia-expected_inertia).abs()>1e-8*inertia.max(1.0){return Err("Mounted fixed mass properties differ from its solid material roles".into());}
    let offset=crate::game_weapons::angle_difference(scalar(v,"barrelAngle")?,pose.angle);
    let target=crate::game_weapons::angle_difference(scalar(v,"targetBarrelAngle")?,pose.angle);
    if offset<mount.min-1e-9||offset>mount.max+1e-9||target<mount.min-1e-9||target>mount.max+1e-9{return Err("Mounted angle/servo target lies outside the physical sector".into());}
    module.physical_inertia=expected_inertia;
    Ok(())
}

/// Fixed feet and posts use remaining material, never the rectangle before port cuts.
pub(crate) fn base_crosses_grid(mount:&WeaponMount,pose:Pose,plate:Pose,grid:&crate::game_geometry::MaterialGrid)->bool {
    let origin=plate.local_point(Point::new(pose.x,pose.y));
    let relative=Pose{x:origin.x,y:origin.y,angle:pose.angle-plate.angle};
    for shape in mount.fixed_polygons() {
        let local:Vec<_>=shape.into_iter().map(|p|relative.world_point(p)).collect();
        if base_shapes_cross_grid(&local,grid) {return true;}
    }
    false
}
pub(crate) fn base_shapes_cross_grid(local:&[Point],grid:&crate::game_geometry::MaterialGrid)->bool {
    let bounds=Bounds::points(local);
    if !bounds.overlaps(grid.bounds) {return false;}
    let eps=crate::game_construction::EPS;
    for y in 0..grid.ny {for x in 0..grid.nx {
        if !grid.occupied(x,y) {continue;}
        let cell=grid.cell_bounds(x,y);
        // Area EPS² alone mistakes a long, sub-EPS contact sliver for penetration.
        if bounds.max_x<=cell.min_x+eps||bounds.min_x>=cell.max_x-eps
            ||bounds.max_y<=cell.min_y+eps||bounds.min_y>=cell.max_y-eps {continue;}
        if crate::game_construction::intersection_area(local,&vertices(cell))>crate::game_construction::EPS.powi(2) {return true;}
    }}
    false
}
