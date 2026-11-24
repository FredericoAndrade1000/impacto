//! Authored chassis geometry and its level running gear. Profile points use the same stable local reference as
//! plates and components; compiling never relocates them. Wheels keep their level floor line; a track authors its
//! continuous span and centre, within the same suspension reach relative to its frame (`Chassis::suspension`); the
//! skids of an aircraft lie on the floor line, their legs as long as the frame stands over it, their runner and their legs
//! where the player puts them along the design, and their tubes as large as the size of the gear. Structural beam, gap and
//! support-load calculations still determine manufacturing capacity, independently of attachment; what an aircraft
//! carries is what its thrusters hold up (`Chassis::lifted`).
use super::{BODY_WIDTH, CELL, EPS, FLOOR, Frame, Plate, REACH, Wall, add, at_units, context, fields, fresh_component, in_box,
    metres, mul, num, outside, reject, signed, sub, told, within};
use crate::game_damage::Material;
use crate::game_flight::GRAVITY;
use crate::game_geometry::{ComponentKind, MAX_ROAD_WHEELS, MIN_ROAD_WHEELS, Metal, Point, atan2, track_wheels};
use crate::game_motion::SPRING_REST;
use serde_json::{Value, json};
use std::f64::consts::PI;

/// The least room between the tyres of two axles, in metres: an axle stands no nearer the next one than a wheel
/// across and this (`src/chassis.js` `AXLE_GAP`).
const AXLE_GAP: f64 = 0.1;
const MAX_CHASSIS_LENGTH: f64 = 12.0;
/// The fewest and the most points a chassis is written with, how near the next one stands behind each at the
/// nearest, in cells, and how steeply a segment between two climbs at the most, in degrees (`src/chassis.js`).
const POINTS: [usize; 2] = [2, 16];
const POINT_SPACING: i64 = 2;
const MAX_SLOPE: f64 = 45.0;
/// How far the line of a chassis stands over or under where its model hangs its gear at the most, in cells
/// (`src/chassis.js` `SUSPENSION_REACH`).
const SUSPENSION_REACH: i64 = 4;
/// The skids of an aircraft, as those of a light helicopter are: a runner of tube this thick across on either side at the
/// size of its model, thinner or thicker with the size of its gear (`gearScale`), its legs no shorter than `SKID_LEG`
/// from the foot of the rails to its top, and, where nothing is written of them, its run on the ground as far in from the
/// front and the rear of the frame as `SKID_INSET` says, its toe turned up ahead of that (`src/chassis.js`). Written
/// (`chassis.skids`), the runner stays between the ends of the frame, each leg stands on it no nearer either end of it
/// than `SKID_END` at the size of the model, as far as the toe it is bent up into, and the two legs no nearer each other
/// than `SKID_SPACING`.
const SKID_TUBE: f64 = 0.08;
const SKID_LEG: f64 = 0.15;
const SKID_INSET: (f64, f64) = (0.3, 0.1);
const SKID_END: f64 = 0.2;
const SKID_SPACING: f64 = 0.5;

/// What runs under a chassis.
enum Running {
    /// Wheels `diameter` across on axles at `axles` along the design as written, from the front, under rails
    /// `depth` deep: the frame is their top flange and the rail their bottom one; between the two is the web, which
    /// a shot passes.
    Wheels { axles: Vec<f64>, diameter: f64, depth: f64 },
    /// One track `width` long and `height` high, its centre at (`middle`,`y`) in the authored local frame. Its
    /// support wheels are derived by the same geometry as its belt and contacts, never a length quantizer. The
    /// frame is the plate over the tub it runs beside, and the nose closes the tub ahead, `nose` thick, sloped down
    /// to `clearance` over the ground.
    Track { width: f64, height: f64, middle: f64, y: f64, nose: f64, clearance: f64 },
    /// The skids of an aircraft, under rails `depth` deep as those of wheels: at `struts` along the design as written a
    /// cross tube as an axle is, sized as one of a gear `size` high, and on either side a leg down from the foot of the
    /// rail to the runner, a tube `tube` across, which lies on the ground from `front` to `rear`, its middle at `y` in the
    /// authored local frame. `legs` are those legs, from the foot of the rail to the top of the runner (`Chassis::legs`).
    Skids { struts: Vec<f64>, size: f64, tube: f64, depth: f64, front: f64, rear: f64, y: f64, legs: Vec<(Point,Point)> },
}
impl Running {
    /// Longitudinal support positions, in the authored frame. Each axle,
    /// road wheel or strut is one equal vertical support in the static load envelope.
    fn supports(&self)->Vec<f64> {
        match self {
            Self::Wheels{axles,..}=>axles.clone(),
            Self::Track{width,height,middle,..}=>track_wheels(*width,*height).road.into_iter().map(|x|middle+x).collect(),
            Self::Skids{struts,..}=>struts.clone(),
        }
    }
}
/// The way a segment of a chassis runs, from its front end to its rear end, and the side of it the frame hangs to.
fn heading(a:Point,b:Point)->(Point,Point) {
    let along=mul(sub(b,a),1.0/a.distance(b));(along,Point::new(along.y,-along.x))
}
/// Low, horizontal stretches used only to describe the profile, never to admit running gear.
fn level_runs(points:&[Point],gaps:&[bool])->Vec<(f64,f64)> {
    let low=points.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
    let mut runs:Vec<(f64,f64)>=Vec::new();let mut open=false;
    for (i,ends) in points.windows(2).enumerate() {
        let level=!gaps[i] && (ends[0].y-low).abs()<EPS && (ends[1].y-low).abs()<EPS;
        match runs.last_mut() {Some(run) if level && open=>run.1=ends[1].x,_ if level=>runs.push((ends[0].x,ends[1].x)),_=>{}}
        open=level;
    }
    runs
}
/// Its parts between gaps, each by its first segment and its last.
fn parts(gaps:&[bool])->Vec<(usize,usize)> {
    let mut parts:Vec<(usize,usize)>=Vec::new();
    for (i,&gap) in gaps.iter().enumerate() {
        if gap {continue;}
        match parts.last_mut() {Some(part) if part.1+1==i=>part.1=i,_=>parts.push((i,i))}
    }
    parts
}
pub(super) struct Chassis {
    model: String,
    /// Its points in the construction's stable local reference. The
    /// segment from one to the next is a gap, with no frame, where `gaps` says so.
    points: Vec<Point>,
    gaps: Vec<bool>,
    /// Its ends along the design as written, the front the lesser: its first point and its last.
    front: f64,
    rear: f64,
    /// The armour the running gear wears, in millimetres.
    armour: f64,
    /// Optional extra armour over the profile, with its own material and gauge.
    top_plate: Option<(String,f64)>,
    /// Catalogue sizing reference for the section, not a translation of authored geometry.
    deck: f64,
    /// The metal of the frame, and how thick it is made of it where a shot meets it.
    metal: &'static Metal,
    thickness: f64,
    default_thickness: f64,
    /// One scale for every generated wheel, or for the single complete track.
    gear_scale: f64,
    /// What the whole frame weighs and costs at this length, of its metal.
    mass: f64,
    credits: f64,
    section_area: f64,
    second_moment: f64,
    frame_limit: f64,
    gear_limit: f64,
    rubber_share: f64,
    /// Per-support allowance. The sum is only a nominal uniform-load value;
    /// admission reduces it for the actual full/empty centre-of-mass envelope.
    rating: f64,
    pub(super) limit: f64,
    /// The gap whose plates bear less than the rest of the frame where it is, when that is what it carries (`carry`).
    limiting: Option<usize>,
    travel: f64,
    /// How wide the air meets its frame across the body, and each tube of its axles or its struts (`drag_width`).
    seen: (f64,f64),
    running: Running,
    /// The gear as it is written back, when the player put it elsewhere than the model does.
    shaped: Option<(&'static str,Value)>,
}
/// A pair of numbers of a model: what it has for the model and for each metre of it, or its shortest and longest.
fn pair(spec:&Value,key:&str,lo:f64,hi:f64)->Result<(f64,f64),Value> {
    let both=spec[key].as_array().filter(|both|both.len()==2).ok_or_else(||context("field",key,reject("FIELD")))?;
    let read=|n:&Value|n.as_f64().filter(|n|n.is_finite() && (lo..=hi).contains(n)).ok_or_else(||context("field",key,reject("FIELD")));
    Ok((read(&both[0])?,read(&both[1])?))
}
/// Area and second moment of a channel or a hollow box. Once its walls
/// meet, it is a solid section: no overlapping material is counted twice.
fn section(width:f64,depth:f64,gauge:f64,closed:bool)->(f64,f64) {
    let void_width=(width-gauge*if closed {2.0} else {1.0}).max(0.0);
    let void_depth=(depth-2.0*gauge).max(0.0);
    (width*depth-void_width*void_depth,(width*depth.powi(3)-void_width*void_depth.powi(3))/12.0)
}
struct Structure {
    area:f64, second:f64, mass:f64, frame_limit:f64, gear_limit:f64, rating:f64, rubber_share:f64, seen:(f64,f64),
}
/// Select the section geometry before calculating its mass and capacity.
/// Catalogue dimensions describe an eight-metre reference, not every vehicle.
/// The stock-profile step keeps small gauge edits from reshaping the whole
/// frame by fractions of a millimetre. This sizing convention is not an
/// engineering strength formula: `structure` evaluates the resulting section.
fn profile_depth(spec:&Value,length:f64,scale:f64,thickness:f64,deck:f64)->Result<f64,Value> {
    let rule=&spec["structure"];
    let reference=num(rule,"profileLength",None,1.0,12.0)?;
    let step=num(rule,"profileStep",None,0.005,0.05)?;
    let (base,size)=match spec["kind"].as_str() {
        Some("wheeled")=>(num(spec,"depth",None,0.05,1.0)?,num(spec,"wheel",None,0.3,2.0)?*scale),
        Some("aircraft")=>(num(spec,"depth",None,0.05,1.0)?,num(spec,"skid",None,0.3,2.0)?*scale),
        _=>(num(spec,"deck",None,0.3,2.0)?-num(spec,"clearance",None,0.1,1.5)?,num(spec,"track",None,0.3,2.0)?*scale),
    };
    let desired=base*(length/reference*scale*thickness/num(spec,"frameMm",None,5.0,200.0)?).sqrt();
    // Keep both flanges distinct. The catalogue's sizing clearance bounds the
    // section; the authored profile itself remains where the player placed it.
    let minimum=(2.0*thickness/1000.0/step-1e-9).ceil()*step;
    let maximum=((deck-size*num(rule,"axleDiameterRatio",None,0.01,0.5)?)/step+1e-9).floor()*step;
    if minimum>maximum {return Err(reject("FRAME_SECTION"));}
    Ok(((desired/step-1e-9).ceil()*step).clamp(minimum,maximum))
}
/// The canonical admission-time beam approximation.
/// Uniform loading, material yield, allowable deflection and a dynamic margin
/// approximate the frame's beam capacity. They do not solve a concentrated
/// payload, support rotation or runtime chassis flex. `lengths` are those of its
/// parts between gaps, along their segments: each has its own crossmembers.
fn structure(spec:&Value,metal:&Metal,thickness:f64,(front,rear):(f64,f64),lengths:&[f64],deck:f64,running:&Running)->Result<Structure,Value> {
    // Wheels and skids hang under two rails; a track runs beside a tub.
    let rule=&spec["structure"];let railed=!matches!(running,Running::Track{..});
    let (depth,size)=match running {
        Running::Wheels{depth,diameter,..}=>(*depth,*diameter),
        Running::Track{height,clearance,..}=>(deck-clearance,*height),
        Running::Skids{depth,size,..}=>(*depth,*size),
    };
    let supports=running.supports();
    let gauge=thickness/1000.0;
    let rail_width=num(rule,"railWidth",None,0.01,1.0)?;
    let (a,i)=section(if railed {rail_width} else {BODY_WIDTH},depth,gauge,!railed);
    let (area,second)=(a*if railed {2.0} else {1.0},i*if railed {2.0} else {1.0});
    let modulus=num(&rule["youngModulus"],metal.name,None,1e9,1e12)?;
    let stress=num(&rule["yieldStrength"],metal.name,None,1e6,2e9)?;
    let deflection=num(rule,"deflectionRatio",None,50.0,2000.0)?;
    let dynamic=num(rule,"dynamicFactor",None,1.0,10.0)?;
    let z=second/(depth/2.0);let mut per_metre=f64::INFINITY;
    for ends in supports.windows(2) {
        let span=ends[1]-ends[0];
        per_metre=per_metre.min(8.0*stress*z/span.powi(2))
            .min(384.0*modulus*second/(5.0*deflection*span.powi(3)));
    }
    for span in [supports[0]-front,rear-supports[supports.len()-1]] {
        if span>0.0 {per_metre=per_metre.min(2.0*stress*z/span.powi(2))
            .min(8.0*modulus*second/(deflection*span.powi(3)));}
    }
    let diameter=num(rule,"axleDiameterRatio",None,0.01,0.5)?*size;
    let inside=(diameter-2.0*gauge).max(0.0);
    let axle_area=PI*(diameter.powi(2)-inside.powi(2))/4.0;
    let axle_z=PI*(diameter.powi(4)-inside.powi(4))/(32.0*diameter);
    let rating=2.0*stress*axle_z/(BODY_WIDTH/4.0)/(GRAVITY*dynamic);
    let cross=section(rail_width,depth/2.0,gauge,false).0;
    let pitch=num(rule,"crossMemberPitch",None,0.2,4.0)?;
    let volume=area*lengths.iter().sum::<f64>()+cross*BODY_WIDTH*lengths.iter().map(|length|(length/pitch).ceil()+1.0).sum::<f64>()
        +axle_area*BODY_WIDTH*supports.len() as f64;
    // What the air meets of it across the body (`Chassis::drag_width`): two rails, and the cross members between them as
    // much of it as they cover seen from over or under it; or the tub, as wide as the body. And each tube of its axles.
    let open=if railed {2.0*rail_width+(BODY_WIDTH-2.0*rail_width)*rail_width/pitch} else {BODY_WIDTH};
    Ok(Structure{area,second,mass:volume*Material::from_name(metal.name).density,seen:(open,diameter),
        // Before the construction's weights are known this is the nominal
        // equal-load sum, not its admitted carrying capacity.
        frame_limit:per_metre*(rear-front)/(GRAVITY*dynamic),gear_limit:rating*supports.len() as f64,rating,
        rubber_share:match running {
            Running::Wheels{..}=>num(&rule["rubberShare"],"wheeled",None,0.0,1.0)?,
            Running::Track{..}=>num(&rule["rubberShare"],"tracked",None,0.0,1.0)?,
            // No piece of the gear of skids is apart from the frame: they are all of its metal.
            Running::Skids{..}=>0.0,
        }})
}
/// Its axles where the model puts them: `count` evenly spaced between `overhang` from either end.
fn spaced(front:f64,rear:f64,overhang:(f64,f64),count:usize,diameter:f64)->Vec<f64> {
    // On a chassis too short for them, both overhangs give up what the wheels need between them, as far as a wheel's
    // radius (`src/chassis.js` `spaced`).
    let (half,ahead,behind)=(diameter/2.0,overhang.0.max(diameter/2.0),overhang.1.max(diameter/2.0));
    let short=((count-1) as f64*(diameter+AXLE_GAP)-(rear-front-ahead-behind)).max(0.0)/2.0;
    let (first,last)=(front+(ahead-short).max(half),rear-(behind-short).max(half));
    (0..count).map(|i|first+(last-first)*i as f64/(count-1) as f64).collect()
}
/// A rigid chassis on identical vertical springs: a support's share is
/// 1/n + (centre-mean)*(x-mean)/sum((x-mean)^2). Negative reactions are no
/// ground contact, so remove that end and solve the same two equilibrium
/// equations again. Positions are strictly ordered by chassis admission.
/// With equal supports the largest share is at one of the active ends.
fn max_support_share(supports:&[f64],centre:f64)->f64 {
    if centre<=supports[0] || centre>=supports[supports.len()-1] {return 1.0;}
    let (mut first,mut end)=(0,supports.len());
    loop {
        let active=&supports[first..end];let n=active.len() as f64;
        if active.len()==1 {return 1.0;}
        let mean=active.iter().sum::<f64>()/n;
        let second=active.iter().map(|x|(x-mean).powi(2)).sum::<f64>();
        let slope=(centre-mean)/second;
        let ahead=1.0/n+slope*(active[0]-mean);
        let behind=1.0/n+slope*(active[active.len()-1]-mean);
        if ahead<0.0 {first+=1;}
        else if behind<0.0 {end-=1;}
        else {return ahead.max(behind).clamp(1.0/n,1.0);}
    }
}
/// Its points as written: each in the construction box, as the nodes of a hull are, at least `POINT_SPACING` behind the one before
/// it, no segment steeper than `MAX_SLOPE`, and a gap only between two segments with a frame.
fn read_points(written:&Value)->Result<(Vec<Point>,Vec<bool>),Value> {
    let listed=written["points"].as_array().ok_or_else(||told(written,"points",json!({"code":"FIELD","expected":"list"})))?;
    if !(POINTS[0]..=POINTS[1]).contains(&listed.len()) {return Err(json!({"code":"CHASSIS_POINTS","value":listed.len(),"range":POINTS}));}
    let (mut written,mut gaps)=(Vec::new(),Vec::new());
    for (i,point) in listed.iter().enumerate() {
        let within=|e|within("chassis.points",Some(i),e);
        fields(point,&["x","y","gap"]).map_err(within)?;
        written.push(in_box(point).map_err(within)?);
        gaps.push(match point.get("gap") {
            Some(gap)=>gap.as_bool().ok_or_else(||within(told(point,"gap",json!({"code":"FIELD","expected":"boolean"}))))?,
            None=>false,
        });
    }
    if let Some(index)=(1..written.len()).find(|&i|written[i].0-written[i-1].0<POINT_SPACING as f64) {
        return Err(json!({"code":"CHASSIS_ORDER","index":index}));
    }
    let points:Vec<Point>=written.into_iter().map(|(x,y)|at_units(x,y)).collect();
    for (index,ends) in points.windows(2).enumerate() {
        let slope=atan2((ends[1].y-ends[0].y).abs(),ends[1].x-ends[0].x)*180.0/PI;
        if slope>MAX_SLOPE+1e-9 {return Err(json!({"code":"CHASSIS_SLOPE","index":index,"value":slope,"range":[0.0,MAX_SLOPE]}));}
    }
    // The last point begins no segment; the first and the last segment carry the ends, and no two gaps meet.
    let last=points.len()-1;
    if let Some(index)=(0..=last).find(|&i|gaps[i] && (i==0 || i+1>=last || gaps[i-1])) {
        return Err(json!({"code":"CHASSIS_GAP","index":index}));
    }
    gaps.pop();
    Ok((points,gaps))
}
impl Chassis {
    /// The chassis a construction is written on: one for a vehicle, none for what stands without moving.
    pub(super) fn read(input:&Value,catalogue:&Value)->Result<Option<Self>,Value> {
        let Some(written)=input.get("chassis") else {
            return if input["preset"]=="vehicle" {Err(reject("CHASSIS_REQUIRED"))} else {Ok(None)};
        };
        if input["preset"]!="vehicle" {return Err(reject("CHASSIS_FIXED"));}
        fields(written,&["model","points","armorMm","metal","axles","track","skids","thicknessMm","gearScale","topPlate"]).map_err(|e|within("chassis",None,e))?;
        let unmodelled=||within("chassis",None,told(written,"model",json!({"code":"CHASSIS_MODEL","accepted":["wheeled","tracked","aircraft"]})));
        let model=written["model"].as_str().ok_or_else(unmodelled)?;
        if !["wheeled","tracked","aircraft"].contains(&model) {return Err(unmodelled());}
        let spec=catalogue["chassis"].get(model).filter(|spec|spec.is_object()).ok_or_else(unmodelled)?;
        (|| {
            if spec["kind"]!=model {return Err(reject("CHASSIS_MODEL"));}
            let (shortest,_)=pair(spec,"length",0.5,12.0)?;
            let (points,gaps)=read_points(written)?;
            let (front,rear)=(points[0].x,points[points.len()-1].x);
            let length=rear-front;
            if length<shortest-EPS || length>MAX_CHASSIS_LENGTH+EPS {
                return Err(json!({"code":"CHASSIS_LENGTH","value":length,"range":[shortest,MAX_CHASSIS_LENGTH]}));
            }
            // Steel is the metal that is not written. The frame is of what its running gear may be, which is of it: a
            // metal, never glass fibre nor polyethylene.
            let gear=if model=="tracked" {ComponentKind::Track} else {ComponentKind::Wheel};
            let metal=crate::game_geometry::metal(gear,written).map_err(|_|told(written,"metal",reject("FIELD")))?;
            let default_thickness=num(spec,"frameMm",None,5.0,200.0)?;
            // The flanges cannot occupy one another. A tracked tub uses one top
            // plate, bounded below by the existing material's minimum gauge.
            let maximum=if spec["kind"]=="tracked" {200.0} else {num(spec,"depth",None,0.05,1.0)?*500.0};
            let asked=num(written,"thicknessMm",Some(default_thickness),Material::from_name(metal.name).least_thickness(),maximum)?;
            let thickness=if (asked-default_thickness).abs()<EPS {default_thickness} else {asked};
            let gear_scale=num(written,"gearScale",Some(1.0),0.5,1.5)?;
            let top_plate=written.get("topPlate").map(|plate|{
                fields(plate,&["material","thicknessMm"])?;
                let (name,material)=plate["material"].as_str().and_then(|name|Material::named(name).map(|m|(name,m)))
                    .ok_or_else(||told(plate,"material",reject("ARMOUR_MATERIAL")))?;
                Ok((name.to_owned(),num(plate,"thicknessMm",None,material.least_thickness(),1000.0)?))
            }).transpose().map_err(|e|within("topPlate",None,e))?;
            let mut deck=num(spec,"deck",None,0.3,2.0)?;
            let mut shaped=None;
            let (running,travel)=match spec["kind"].as_str() {
                Some("wheeled")=>{
                    if ["track","skids"].iter().any(|key|written.get(*key).is_some()) {return Err(reject("CHASSIS_GEAR_KIND"));}
                    let travel=num(spec,"travel",None,0.0,0.4)?;
                    let default_diameter=num(spec,"wheel",None,0.3,2.0)?;
                    let diameter=default_diameter*gear_scale;
                    deck+=(diameter-default_diameter)/2.0;
                    let (count,(fewest,most))=(num(spec,"axles",None,2.0,8.0)? as usize,pair(spec,"axleRange",2.0,8.0)?);
                    let (ahead,behind)=pair(spec,"overhang",0.0,3.0)?;
                    let even=spaced(front,rear,(ahead,behind),count,diameter);
                    let axles=match written.get("axles") {
                        None=>even,
                        Some(axles)=>{
                            let refused=||told(written,"axles",reject("AXLES"));
                            // Each where it is written, in cells along the design.
                            let mut positions=axles.as_array().ok_or_else(refused)?.to_vec();
                            for x in &positions {if !x.as_f64().is_some_and(|x|x.is_finite()) {return Err(refused());}}
                            // Preserve each validated number, sorted from the front, without quantizing a position.
                            positions.sort_by(|a,b|a.as_f64().unwrap().total_cmp(&b.as_f64().unwrap()));
                            let axles:Vec<f64>=positions.iter().map(|x|x.as_f64().unwrap()/(1.0/CELL)).collect();
                            // Where the model puts them they are not written.
                            if axles.len()==even.len() && axles.iter().zip(&even).all(|(x,y)|(x-y).abs()<EPS) {even} else {
                                shaped=Some(("axles",json!(positions)));axles
                            }
                        },
                    };
                    if (axles.len() as f64)<fewest || axles.len() as f64>most {
                        return Err(json!({"code":"AXLE_COUNT","value":axles.len(),"range":[fewest,most]}));
                    }
                    // This also validates default positions when larger tyres no
                    // longer fit: every wheel remains whole and separate.
                    if axles.iter().any(|&x|x<front+diameter/2.0-EPS || x>rear-diameter/2.0+EPS) {return Err(reject("AXLE_EXTENT"));}
                    let tube=diameter*num(&spec["structure"],"axleDiameterRatio",None,0.01,0.5)?/2.0;
                    if axles.windows(2).any(|pair|pair[1]-pair[0]<diameter+AXLE_GAP-EPS) {return Err(reject("AXLE_SPACING"));}
                    let depth=profile_depth(spec,length,gear_scale,thickness,deck)?;
                    // Factories may use this initial sizing height to clear the
                    // real section at full bump. It never translates the profile.
                    deck=deck.max(diameter/2.0+0.01+depth+tube+travel*(1.0-SPRING_REST));
                    (Running::Wheels{axles,diameter,depth},travel)
                },
                Some("tracked")=>{
                    if ["axles","skids"].iter().any(|key|written.get(*key).is_some()) {return Err(reject("CHASSIS_GEAR_KIND"));}
                    let default_height=num(spec,"track",None,0.3,2.0)?;
                    let height=default_height*gear_scale;
                    deck+=height-default_height;
                    // Literal physical ends and centre, with no grid or road-wheel quantization. An omitted track
                    // fills the frame up to its permitted aspect envelope. Explicit coordinates remain explicit even
                    // at that default so a subsequent height/profile edit cannot redistribute the assembly.
                    let scale=height/ComponentKind::Track.dimensions().1;
                    let (least,most)=(ComponentKind::track_length(MIN_ROAD_WHEELS)*scale,ComponentKind::track_length(MAX_ROAD_WHEELS)*scale);
                    let width=length.min(most);
                    let (mut width,mut middle,mut y)=(width,front+width/2.0,height/2.0+0.01-super::CONSTRUCTION_ORIGIN.y);
                    if let Some(track)=written.get("track") {
                        let within=|e|within("chassis.track",None,e);
                        fields(track,&["front","rear","y"]).map_err(within)?;
                        let read=|key|num(track,key,None,-(REACH as f64),REACH as f64).map(|n|n/(1.0/CELL)).map_err(within);
                        let (first,last)=(read("front")?,read("rear")?);
                        (width,middle,y)=(last-first,(first+last)/2.0,read("y")?);
                        shaped=Some(("track",json!({"front":track["front"],"rear":track["rear"],"y":track["y"]})));
                    }
                    if width<least-EPS || width>most+EPS {return Err(json!({"code":"TRACK_LENGTH","value":width,"range":[least,most]}));}
                    if middle-width/2.0<front-EPS || middle+width/2.0>rear+EPS {return Err(reject("TRACK_EXTENT"));}
                    // Its springs travel as far as its road wheels stand under its idler and its sprocket as built, as
                    // large as the track is: pressed up to their stop they still stand a third of that under them, and
                    // the belt runs up to each end from the last of them.
                    let wheels=track_wheels(width,height);
                    (Running::Track{width,height,middle,y,nose:num(spec,"noseMm",None,5.0,200.0)?*thickness/num(spec,"frameMm",None,5.0,200.0)?,
                        clearance:deck-profile_depth(spec,length,gear_scale,thickness,deck)?},wheels.end.y-wheels.low)
                },
                Some("aircraft")=>{
                    if ["axles","track"].iter().any(|key|written.get(*key).is_some()) {return Err(reject("CHASSIS_GEAR_KIND"));}
                    // The size of its gear is that of every tube of its skids: the runner, the cross tubes of its struts and
                    // the legs they are bent down into. The rails are of the frame, as deep as for skids of the model's size.
                    let (size,tube)=(num(spec,"skid",None,0.3,2.0)?*gear_scale,SKID_TUBE*gear_scale);
                    // Where nothing is written of them they stand where the model puts them: the struts `overhang` from the
                    // ends of the frame, the runner `SKID_INSET` in from them. Written, the ends of the runner and the place of
                    // each leg along the design, in cells as the track's are, each number kept as it is written and the legs
                    // told from the front; even where the model would put them, they stay written, for an edit of the points
                    // of the frame not to move them.
                    let (mut struts,mut first,mut last)=(spaced(front,rear,pair(spec,"overhang",0.0,3.0)?,2,tube),front+SKID_INSET.0,rear-SKID_INSET.1);
                    if let Some(skids)=written.get("skids") {
                        let within=|e|within("chassis.skids",None,e);
                        fields(skids,&["front","rear","legs"]).map_err(within)?;
                        let read=|key|num(skids,key,None,-(REACH as f64),REACH as f64).map(|n|n/(1.0/CELL)).map_err(within);
                        (first,last)=(read("front")?,read("rear")?);
                        let refused=||within(told(skids,"legs",json!({"code":"FIELD","expected":"list","count":2})));
                        let mut legs=skids["legs"].as_array().filter(|legs|legs.len()==2).ok_or_else(refused)?.to_vec();
                        if !legs.iter().all(|x|x.as_f64().is_some_and(|x|x.is_finite() && x.abs()<=REACH as f64)) {return Err(refused());}
                        legs.sort_by(|a,b|a.as_f64().unwrap().total_cmp(&b.as_f64().unwrap()));
                        struts=legs.iter().map(|x|x.as_f64().unwrap()/(1.0/CELL)).collect();
                        shaped=Some(("skids",json!({"front":skids["front"],"rear":skids["rear"],"legs":legs})));
                    }
                    // The runner goes no further than the frame, as a track does not; a leg stands on it behind its toe and
                    // ahead of its rear end, as far in from either as the tubes are large; and the two stand apart.
                    if first<front-EPS || last>rear+EPS {return Err(reject("SKID_EXTENT"));}
                    let end=SKID_END*gear_scale;
                    if let Some(index)=struts.iter().position(|&x|x<first+end-EPS || x>last-end+EPS) {
                        return Err(json!({"code":"SKID_RUNNER","index":index,"least":end}));
                    }
                    if struts[1]-struts[0]<SKID_SPACING-EPS {return Err(json!({"code":"SKID_SPACING","value":struts[1]-struts[0],"least":SKID_SPACING}));}
                    let depth=profile_depth(spec,length,1.0,thickness,deck)?;
                    deck=deck.max(0.01+tube+SKID_LEG+depth);
                    (Running::Skids{struts,size,tube,depth,front:first,rear:last,y:tube/2.0+0.01-super::CONSTRUCTION_ORIGIN.y,legs:Vec::new()},0.0)
                },
                _=>return Err(reject("CHASSIS_MODEL")),
            };
            let gear=match running {Running::Track{..}=>ComponentKind::Track,_=>ComponentKind::Wheel};
            let lengths:Vec<f64>=parts(&gaps).into_iter().map(|(first,last)|(first..=last).map(|i|points[i].distance(points[i+1])).sum()).collect();
            let structure=structure(spec,metal,thickness,(front,rear),&lengths,deck,&running)?;
            let mut chassis=Self{model:model.to_owned(),
                points,gaps,front,rear,
                armour:num(written,"armorMm",Some(0.0),0.0,num(spec,"armourMm",None,0.0,gear.armour_limit())?)?,
                deck,metal,thickness,default_thickness,gear_scale,top_plate,
                mass:structure.mass,credits:(structure.mass*Material::from_name(metal.name).price-1e-9).ceil(),rating:structure.rating,
                section_area:structure.area,second_moment:structure.second,frame_limit:structure.frame_limit,gear_limit:structure.gear_limit,
                rubber_share:structure.rubber_share,limit:structure.frame_limit.min(structure.gear_limit),limiting:None,
                travel,seen:structure.seen,running,shaped};
            // What hangs under its line, the rails or the tub, goes no lower than the floor either.
            if chassis.outlines().iter().flatten().any(|p|p.y<metres(FLOOR)-EPS) {return Err(outside("below"));}
            // The runners and the legs of skids are tubes of the metal of the frame, as thick across as the runner is and
            // as the cross tubes, of the gauge of the frame, on either side of the body: what they weigh and cost is that
            // of their metal, as long and as large as they are.
            let legs=chassis.legs()?;
            if let Running::Skids{legs:kept,front,rear,size,tube,..}=&mut chassis.running {
                let hollow=|across:f64|{let inside=(across-2.0*thickness/1000.0).max(0.0);PI*(across.powi(2)-inside.powi(2))/4.0};
                let across=num(&spec["structure"],"axleDiameterRatio",None,0.01,0.5)?*(*size);
                let volume=2.0*(hollow(*tube)*(*rear-*front)+hollow(across)*legs.iter().map(|(foot,top)|foot.distance(*top)).sum::<f64>());
                chassis.mass+=volume*Material::from_name(metal.name).density;
                chassis.credits=(chassis.mass*Material::from_name(metal.name).price-1e-9).ceil();
                *kept=legs;
            }
            Ok(chassis)
        })().map(Some).map_err(|e|context("chassis",model,e))
    }
    /// As it is written back: no armour, the steel and the gear where the model puts it are what is not written, and
    /// no point says it begins no gap.
    pub(super) fn canonical(&self,written:&Value)->Value {
        let points:Vec<Value>=self.points.iter().enumerate().map(|(i,_)|{
            let mut point=json!({"x":written["points"][i]["x"],"y":written["points"][i]["y"]});
            if self.gaps.get(i)==Some(&true) {point["gap"]=json!(true);}
            point
        }).collect();
        let mut value=json!({"model":self.model,"points":points});
        if self.armour>0.0 {value["armorMm"]=json!(self.armour);}
        if self.metal.name!="steel" {value["metal"]=json!(self.metal.name);}
        if (self.thickness-self.default_thickness).abs()>=EPS {value["thicknessMm"]=json!(self.thickness);}
        if self.gear_scale!=1.0 {value["gearScale"]=json!(self.gear_scale);}
        if let Some((material,thickness))=&self.top_plate {value["topPlate"]=json!({"material":material,"thicknessMm":thickness});}
        if let Some((key,gear))=&self.shaped {value[*key]=gear.clone();}
        value
    }
    /// Initial factory layout only. Existing authoring coordinates never track this sizing reference.
    pub(super) fn sizing_deck(&self)->f64 {self.deck}
    /// The real suspension offset in cells: its lowest frame line relative to the model sizing zero, adjusted by the
    /// track's actual centre when authored. An arch does not lower that frame reference. Wheels keep their floor line.
    pub(super) fn suspension(&self)->f64 {
        let lowest=self.points.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
        // Only erase conversion round-off at an exact whole unit, never a fractional authored position.
        let units=lowest/CELL;let nearest=units.round();
        let units=if (units-nearest).abs()<1e-9{nearest}else{units};
        let ordinary=units-((self.deck-super::CONSTRUCTION_ORIGIN.y)/CELL-1e-9).ceil();
        let actual=match self.running {
            Running::Track{height,y,..}=>ordinary-(y-(height/2.0+0.01-super::CONSTRUCTION_ORIGIN.y))/CELL,
            Running::Wheels{..}|Running::Skids{..}=>ordinary,
        };
        let nearest=actual.round();if (actual-nearest).abs()<1e-9 {nearest}else{actual}
    }
    /// The legs of its skids, each from the foot of the rail over its strut down to the top of the runner, along the
    /// design as written; none for other gear. Refused where a strut stands under a gap, which no rail crosses, and where
    /// the frame stands so low that a leg would be shorter than `SKID_LEG`.
    fn legs(&self)->Result<Vec<(Point,Point)>,Value> {
        let Running::Skids{struts,depth,y,tube,..}=&self.running else {return Ok(Vec::new())};
        struts.iter().enumerate().map(|(index,&x)|{
            let (i,a,b)=self.framed().find(|(_,a,b)|x>=a.x-EPS && x<=b.x+EPS).ok_or_else(||json!({"code":"SKID_GAP","index":index}))?;
            let foot=self.under_point(i,*depth).lerp(self.under_point(i+1,*depth),(x-a.x)/(b.x-a.x));
            let top=Point::new(foot.x,y+tube/2.0);
            if foot.y-top.y<SKID_LEG-EPS {
                return Err(json!({"code":"SKID_HEIGHT","value":foot.y-top.y,"least":SKID_LEG,"model":self.model}));
            }
            Ok((foot,top))
        }).collect()
    }
    /// Whether it is an aircraft's, on skids.
    pub(super) fn aircraft(&self)->bool {matches!(self.running,Running::Skids{..})}
    /// What an aircraft carries, in kilograms: what its thrusters hold up with the margin its flight computer climbs and
    /// steers with, in place of what its frame would bear on its skids (`game_construction.rs` `LIFT_MARGIN`).
    pub(super) fn lifted(&mut self,kg:f64) {self.limit=kg;}
    /// The top of the runner of its skids, over the construction's origin: in side view the runner lies along the whole
    /// of it, and what hangs lower would come down on it or on the floor under it.
    pub(super) fn skid_top(&self)->Option<f64> {
        if let Running::Skids{y,tube,..}=self.running {Some(y+tube/2.0)} else {None}
    }
    /// Refused where its suspension would not reach its gear: further than `SUSPENSION_REACH` over or under its model,
    /// told in metres.
    pub(super) fn check_suspension(&self)->Result<(),Value> {
        // The legs of skids reach down to the floor however high the frame stands over it (`legs`).
        if matches!(self.running,Running::Skids{..}) {return Ok(());}
        let height=self.suspension();
        if height.abs()>SUSPENSION_REACH as f64+EPS {
            return Err(context("chassis",&self.model,json!({"code":"SUSPENSION_REACH","value":height/(1.0/CELL),
                "range":[metres(-SUSPENSION_REACH),metres(SUSPENSION_REACH)]})));
        }
        Ok(())
    }
    /// How deep the frame is under its deck: the rails of a wheeled one, the tub of a tracked one.
    fn depth(&self)->f64 {
        match self.running {Running::Wheels{depth,..}|Running::Skids{depth,..}=>depth,Running::Track{clearance,..}=>self.deck-clearance}
    }
    /// Where its gear carries it along the design as written: from its first axle to its last, from the first road
    /// wheel of its track to the last, or the whole run of its skids on the ground.
    fn span(&self)->(f64,f64) {
        if let Running::Skids{front,rear,..}=self.running {return (front,rear);}
        let supports=self.running.supports();
        (supports[0],supports[supports.len()-1])
    }
    /// Its segments that have a frame, each by its place among them all and its front and rear ends along the design
    /// as written, over the deck.
    fn framed(&self)->impl Iterator<Item=(usize,Point,Point)>+'_ {
        self.points.windows(2).enumerate().filter(|(i,_)|!self.gaps[*i]).map(|(i,ends)|(i,ends[0],ends[1]))
    }
    /// The way down under the top of the frame at its point `k`, a metre deep for each metre: square to its segment at
    /// an end of a part between gaps, and where the lines as deep under its two segments meet at a knee.
    fn under_way(&self,k:usize)->Point {
        let side=|i:usize|heading(self.points[i],self.points[i+1]).1;
        let before=(k>0 && !self.gaps[k-1]).then(||side(k-1));
        let after=(k<self.gaps.len() && !self.gaps[k]).then(||side(k));
        match (before,after) {
            (Some(a),Some(b))=>mul(add(a,b),1.0/(1.0+a.dot(b))),
            (Some(way),None)|(None,Some(way))=>way,
            (None,None)=>unreachable!("a point between two gaps"),
        }
    }
    /// The point `depth` under the top of the frame at its point `k`, along the design as written.
    fn under_point(&self,k:usize,depth:f64)->Point {add(self.points[k],mul(self.under_way(k),depth))}
    /// The real lower end of the tracked nose, under the front of the profile, its first point. It is shared by the
    /// collision outline and the ballistic plate, not a drawing-only shape.
    fn nose_end(&self)->Option<Point> {
        if !matches!(self.running,Running::Track{..}) {return None;}
        let (along,side)=heading(self.points[0],self.points[1]);
        Some(add(self.points[0],mul(add(along,side),self.depth())))
    }
    /// The existing physical outline split into convex stretches for the one manufacturing contact rule.
    pub(super) fn support_shapes(&self,origin:Point)->Vec<Vec<Point>> {
        self.outlines().into_iter().flat_map(|outline|{
            let n=outline.len()/2;
            (0..n-1).map(move|i|[outline[i],outline[i+1],outline[2*n-2-i],outline[2*n-1-i]]
                .into_iter().map(|p|add(origin,p)).collect())
        }).collect()
    }
    /// The outline of each part between gaps from the side, from the front, along the design as written over the deck:
    /// its top from its front end to its rear end, then as far under each of those points as the frame is deep, from
    /// its rear end to its front end. The tub of a track is closed ahead by its nose, sloped down from the front.
    fn outlines(&self)->Vec<Vec<Point>> {
        let depth=self.depth();
        parts(&self.gaps).into_iter().map(|(first,last)|{
            let mut under:Vec<Point>=(first..=last+1).map(|k|self.under_point(k,depth)).collect();
            if let Some(end)=self.nose_end() && first==0 {under[0]=end;}
            self.points[first..=last+1].iter().copied().chain(under.into_iter().rev()).collect()
        }).collect()
    }
    /// Where the weight of the vehicle falls along the design as written, furthest ahead and furthest behind, however
    /// full or empty what it holds: furthest ahead with all it holds ahead of that point full and the rest empty,
    /// furthest behind the other way. Each piece is where it falls, what it weighs empty and what it weighs with all
    /// it holds full. Refused when either falls beyond the first axle or the last, or beyond the first or the last
    /// road wheel of the track: the vehicle would tip there onto its hull and drag it.
    fn balance_range(&self,pieces:&[(f64,f64,f64)])->(f64,f64) {
        let bare=pieces.iter().fold((0.0,0.0),|(mass,moment),&(x,empty,_)|(mass+empty,moment+empty*x));
        let mut held:Vec<(f64,f64)>=pieces.iter().filter(|piece|piece.2>piece.1).map(|&(x,empty,loaded)|(x,loaded-empty)).collect();
        held.sort_by(|a,b|a.0.total_cmp(&b.0));
        let (mut ahead,mut behind)=(bare,bare);
        for &(x,held) in &held {if x>=ahead.1/ahead.0 {break;} ahead=(ahead.0+held,ahead.1+held*x);}
        for &(x,held) in held.iter().rev() {if x<=behind.1/behind.0 {break;} behind=(behind.0+held,behind.1+held*x);}
        (ahead.1/ahead.0,behind.1/behind.0)
    }
    pub(super) fn check_balance(&self,(front,rear):(f64,f64))->Result<(),Value> {
        let (first,last)=self.span();
        if front<first-EPS {return Err(json!({"code":"CHASSIS_BALANCE","model":self.model,"direction":"front"}));}
        if rear>last+EPS {return Err(json!({"code":"CHASSIS_BALANCE","model":self.model,"direction":"rear"}));}
        Ok(())
    }
    #[cfg(test)]
    fn balance(&self,pieces:&[(f64,f64,f64)])->Result<(f64,f64),Value> {
        let balance=self.balance_range(pieces);self.check_balance(balance)?;Ok(balance)
    }
    /// A conservative static envelope for every independent reserve fill:
    /// their full total mass times the largest support share at either COM
    /// extreme. A partial fill can be lighter, never heavier than that total.
    /// For identical springs/ratings the largest share decreases up to the
    /// mean support position, then increases; contact changes are continuous.
    /// Its maximum over the COM interval is therefore at an endpoint, even
    /// with irregular axle spacing. This does not model dynamic wheel loads.
    pub(super) fn apply_load_envelope(&mut self,pieces:&[(f64,f64,f64)])->(f64,f64) {
        let balance=self.balance_range(pieces);let supports=self.running.supports();
        let share=max_support_share(&supports,balance.0).max(max_support_share(&supports,balance.1));
        self.gear_limit=self.rating/share;
        self.limit=self.frame_limit.min(self.gear_limit);
        balance
    }
    /// Generate the physical frame exactly along its authored profile. Hull support and closure are not authoring
    /// permissions; only actual crossing geometry remains invalid here.
    pub(super) fn attach(&self,frame:&mut Frame)->Result<(),Value> {
        let plates=frame.written.1;let origin=frame.origin;
        let half=self.thickness/2000.0;
        let top=|p:Point|add(origin,p);
        let mut node=|name:String,at:Point|{frame.nodes.push((name,at));frame.nodes.len()-1};
        // Both plates stand where the outline puts the vertex at each point (`under_point`, as `outlines`): the middle of
        // the frame plate half its thickness under the top of the frame there, that of the rail half its thickness over
        // the foot of the frame. Each face of either is on the outline of its stretch, as deep under the stretch on
        // either side of a knee.
        let tops:Vec<usize>=(0..self.points.len()).map(|k|node(format!("chassis:point-{k}"),top(self.under_point(k,half)))).collect();
        let lows:Vec<Option<usize>>=match self.running {
            Running::Wheels{depth,..}|Running::Skids{depth,..}=>(0..self.points.len()).map(|k|Some(node(format!("chassis:low-{k}"),top(self.under_point(k,depth-half))))).collect(),
            Running::Track{..}=>vec![None;self.points.len()],
        };
        // The plate follows the same mitered profile continuously; its lower face is on the frame.
        let cover=self.top_plate.as_ref().map(|(_,thickness)|(0..self.points.len()).map(|k|{
            node(format!("chassis:top-point-{k}"),top(self.under_point(k,-thickness/2000.0)))
        }).collect::<Vec<_>>());
        let nose=match self.running {
            Running::Track{nose,..}=>Some((node("chassis:nose".into(),top(self.nose_end().unwrap())),nose)),
            Running::Wheels{..}|Running::Skids{..}=>None,
        };
        // The runner of skids lies on the floor, its plate as thick as the frame with its foot where the foot of the tube
        // is, and a leg stands from it up to the foot of the rail over each strut.
        let skids=match &self.running {
            Running::Skids{front,rear,y,tube,legs,..}=>{
                let lying=y-tube/2.0+half;
                let runner=(node("chassis:skid-rear".into(),top(Point::new(*rear,lying))),node("chassis:skid-front".into(),top(Point::new(*front,lying))));
                let legs:Vec<(usize,usize)>=legs.iter().enumerate().map(|(k,(foot,above))|(node(format!("chassis:leg-foot-{k}"),top(Point::new(above.x,lying+half))),
                    node(format!("chassis:leg-top-{k}"),top(*foot)))).collect();
                Some((runner,legs))
            },
            _=>None,
        };
        let push=|frame:&mut Frame,part:&'static str,segment:usize,a:usize,b:usize,thickness:f64|{
            let owner=frame.plates.len() as u32+1;
            frame.plates.push(Plate{id:format!("chassis:{part}-{segment}"),owner,a,b,material:self.metal.name.into(),thickness,
                start:0.0,end:0.0,part:Some((part,segment))});
            frame.plates.len()-1
        };
        for (i,..) in self.framed().collect::<Vec<_>>() {
            let plate=push(frame,"frame",i,tops[i+1],tops[i],self.thickness);
            let (a,b)=(frame.nodes[tops[i+1]].1,frame.nodes[tops[i]].1);let length=a.distance(b);let d=sub(b,a);
            frame.beds.push(Wall{id:frame.plates[plate].id.clone(),owner:frame.plates[plate].owner,a,b,length,
                normal:Point::new(d.y/length,-d.x/length),material:self.metal.name.into(),thickness:self.thickness,exterior:true});
            if let (Some(rear),Some(front))=(lows[i+1],lows[i]) {
                push(frame,"rail",i,rear,front,self.thickness);
            }
            if let Some((end,thickness))=nose && i==0 {
                let owner=frame.plates.len() as u32+1;
                frame.plates.push(Plate{id:"chassis:nose".into(),owner,a:tops[0],b:end,material:self.metal.name.into(),thickness,
                    start:0.0,end:0.0,part:Some(("nose",0))});
            }
            if let (Some(points),Some((material,thickness)))=(&cover,&self.top_plate) {
                let (a,b)=(points[i+1],points[i]);
                let along=sub(self.points[i],self.points[i+1]);
                if sub(frame.nodes[b].1,frame.nodes[a].1).dot(along)<=EPS {
                    return Err(context("plate",&format!("chassis:top-{i}"),reject("PLATE_LENGTH")));
                }
                frame.plates.push(Plate{id:format!("chassis:top-{i}"),owner:frame.plates.len() as u32+1,a,b,
                    material:material.clone(),thickness:*thickness,start:0.0,end:0.0,part:Some(("top",i))});
            }
        }
        if let Some(((rear,front),legs))=skids {
            push(frame,"skid",0,rear,front,self.thickness);
            for (k,(foot,top)) in legs.into_iter().enumerate() {push(frame,"leg",k,foot,top,self.thickness);}
        }
        frame.root=plates;
        // No plate written crosses the frame, its rails, its nose or its skids.
        for chassis in frame.plates[plates..].iter().filter(|plate| plate.structural_part().is_some()) {
            let (a,b)=frame.ends(chassis);
            if let Some(other)=frame.plates[..plates].iter().find(|other|{let (c,d)=frame.ends(other);
                signed(a,b,c)*signed(a,b,d)<0.0 && signed(c,d,a)*signed(c,d,b)<0.0}) {
                return Err(json!({"code":"CHASSIS_CROSSING","ids":[other.id]}));
            }
        }
        Ok(())
    }
    /// Its gaps borne by the plates written that cross them, once they are laid: over a gap the beam of the chassis is
    /// those plates, each a flange as wide as the body and as thick as it is, of its own material, about the neutral
    /// line of them all. Sampled across each gap every `POINT_SPACING`, either side of each node written over it and
    /// just inside its edges. Each stretch between two supports and each overhang bears what its weakest section
    /// bears — the rails, or the least moment and the least stiffness across the gaps in it —, as `structure` reckons
    /// them; so the frame carries no more than without its gaps. An unbridged gap has zero manufacturing capacity,
    /// while its source remains editable. Nothing of it bends or breaks in the field.
    pub(super) fn carry(&mut self,frame:&Frame,catalogue:&Value)->Result<(),Value> {
        if !self.gaps.contains(&true) {return Ok(());}
        let rule=&catalogue["chassis"][&self.model]["structure"];
        let modulus=num(&rule["youngModulus"],self.metal.name,None,1e9,1e12)?;
        let stress=num(&rule["yieldStrength"],self.metal.name,None,1e6,2e9)?;
        let deflection=num(rule,"deflectionRatio",None,50.0,2000.0)?;
        let dynamic=num(rule,"dynamicFactor",None,1.0,10.0)?;
        // A plate of a material with no strength told carries nothing: ceramic, glass, concrete.
        let strength=|material:&str|->Result<Option<(f64,f64)>,Value> {
            if rule["plateYieldStrength"].get(material).is_none() {return Ok(None);}
            Ok(Some((num(&rule["plateYoungModulus"],material,None,1e9,1e12)?,num(&rule["plateYieldStrength"],material,None,1e6,3e9)?)))
        };
        let (origin,written)=(frame.origin.x,&frame.plates[..frame.written.1]);
        // Each section sampled, along the design as written: where, in which gap, the moment it bears and its stiffness.
        let mut sections:Vec<(f64,usize,f64,f64)>=Vec::new();
        for (i,ends) in self.points.windows(2).enumerate().filter(|(i,_)|self.gaps[*i]) {
            let (lo,hi)=(ends[0].x,ends[1].x);
            // At a node the plates that meet there end: the section is told either side of it.
            let nodes:Vec<f64>=frame.nodes[..frame.written.0].iter().map(|(_,p)|p.x-origin).collect();
            let mut at:Vec<f64>=vec![lo+1e-6,hi-1e-6];
            at.extend((1..).map(|k|lo+k as f64*metres(POINT_SPACING)).take_while(|&x|x<hi-EPS).filter(|x|nodes.iter().all(|node|(node-x).abs()>1e-6)));
            at.extend(nodes.iter().flat_map(|&node|[node-1e-6,node+1e-6]).filter(|&x|lo<x && x<hi));
            for x in at {
                let mut flanges=Vec::new();
                for plate in written {
                    let (a,b)=frame.ends(plate);let x=origin+x;
                    if !(a.x.min(b.x)<x && x<a.x.max(b.x)) {continue;}
                    if let Some((e,yield_strength))=strength(&plate.material)? {
                        flanges.push((e,yield_strength,plate.thickness/1000.0,a.y+(b.y-a.y)*(x-a.x)/(b.x-a.x)));
                    }
                }
                if flanges.is_empty() {
                    self.frame_limit=0.0;self.limit=0.0;self.limiting=Some(i);
                    return Err(json!({"code":"CHASSIS_GAP_OPEN","index":i,"from":lo,"to":hi}));
                }
                let stiff=|&(e,_,t,_):&(f64,f64,f64,f64)|e*BODY_WIDTH*t;
                let neutral=flanges.iter().map(|f|stiff(f)*f.3).sum::<f64>()/flanges.iter().map(stiff).sum::<f64>();
                let bending=flanges.iter().map(|&(e,_,t,y)|e*(BODY_WIDTH*t.powi(3)/12.0+BODY_WIDTH*t*(y-neutral).powi(2))).sum::<f64>();
                let moment=flanges.iter().map(|&(e,yield_strength,t,y)|yield_strength*bending/(e*((y-neutral).abs()+t/2.0))).fold(f64::INFINITY,f64::min);
                sections.push((x,i,moment,bending));
            }
        }
        // The rails, as `structure` reckons them.
        let rails=(stress*self.second_moment/(self.depth()/2.0),modulus*self.second_moment);
        let supports=self.running.supports();let last=supports[supports.len()-1];
        let spans=std::iter::once((self.front,supports[0],false)).chain(supports.windows(2).map(|pair|(pair[0],pair[1],true)))
            .chain(std::iter::once((last,self.rear,false)));
        let (mut per_metre,mut limiting)=(f64::INFINITY,None);
        for (lo,hi,held) in spans {
            let span=hi-lo;if span<=0.0 {continue;}
            let (by_moment,by_stiffness)=if held {(8.0/span.powi(2),384.0/(5.0*deflection*span.powi(3)))}
                else {(2.0/span.powi(2),8.0/(deflection*span.powi(3)))};
            // The least moment and the least stiffness along it, each with the gap it is in, if not the rails'.
            let (mut moment,mut bending)=((rails.0,None),(rails.1,None));
            for &(x,gap,m,ei) in &sections {
                if x<=lo || x>=hi {continue;}
                if m<moment.0 {moment=(m,Some(gap));}
                if ei<bending.0 {bending=(ei,Some(gap));}
            }
            let (bears,gap)=if by_moment*moment.0<=by_stiffness*bending.0 {(by_moment*moment.0,moment.1)} else {(by_stiffness*bending.0,bending.1)};
            if bears<per_metre {(per_metre,limiting)=(bears,gap);}
        }
        let bears=per_metre*(self.rear-self.front)/(GRAVITY*dynamic);
        if limiting.is_some() && bears<self.frame_limit {
            self.frame_limit=bears;self.limiting=limiting;self.limit=self.frame_limit.min(self.gear_limit);
        }
        Ok(())
    }
    /// The gap of its frame that bears the least of what the chassis carries, when the frame is what bears the least.
    pub(super) fn limiting_gap(&self)->Option<usize> {self.limiting.filter(|_|self.frame_limit<=self.gear_limit)}
    /// The depth of body each plate of the frame weighs for: the mass of the whole frame over the metal of it.
    pub(super) fn mass_scale(&self,frame:&Frame)->f64 {
        self.mass/frame.plates.iter().filter(|plate|plate.structural_part().is_some()).map(|plate|{
            let (a,b)=frame.ends(plate);a.distance(b)*plate.thickness/1000.0*Material::from_name(&plate.material).density
        }).sum::<f64>()
    }
    /// What a plate of the frame tells of it, the segment it lies along; the frame of the first segment also what the
    /// chassis costs and carries, how it runs from the side — its points (`profile`) and the outline of each part
    /// between gaps, from its front end and up from its deck — and where its gear is along it from its front end: its
    /// axles, or the ends of its track.
    /// How wide the air meets across the body what a plate of its `part` stands for, where that is narrower than the body
    /// (game_air.rs `HullAir::read`): the two rails of a frame on wheels or on skids, with the cross members between them
    /// as much of it as they cover seen from over or under it, and the two tubes either side of the body of the runner of
    /// skids and of each of their legs, which are of the tube of their struts. The plate over the tub a track runs beside,
    /// its nose and a plate over its profile are as wide as the body.
    pub(super) fn drag_width(&self,part:&str)->Option<f64> {
        match (part,&self.running) {
            ("frame"|"rail",Running::Wheels{..}|Running::Skids{..})=>Some(self.seen.0),
            ("skid",Running::Skids{tube,..})=>Some(2.0*tube),
            ("leg",Running::Skids{..})=>Some(2.0*self.seen.1),
            _=>None,
        }
    }
    pub(super) fn describe(&self,(part,segment):(&str,usize))->Value {
        let mut value=json!({"model":self.model,"kind":self.model,"part":part,"segment":segment,"depth":self.depth(),
            "material":self.metal.name,"thicknessMm":self.thickness});
        if part=="frame" && segment==0 {
            let baseline=self.points.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
            let drawn=|p:Point|Point::new(p.x-self.front,p.y-baseline);
            value["credits"]=json!(self.credits);value["limitKg"]=json!(self.limit);
            value["frameKg"]=json!(self.mass);value["frameLimitKg"]=json!(self.frame_limit);value["gearLimitKg"]=json!(self.gear_limit);
            value["deck"]=json!(super::CONSTRUCTION_ORIGIN.y+baseline);value["length"]=json!(self.rear-self.front);
            value["suspension"]=json!(self.suspension()/(1.0/CELL));
            value["profile"]=json!(self.points.iter().enumerate().map(|(i,&p)|self.marked(i,drawn(p))).collect::<Vec<_>>());
            value["outlines"]=json!(self.outlines().into_iter().map(|outline|outline.into_iter().map(|p|drawn(p).to_value()).collect::<Vec<_>>()).collect::<Vec<_>>());
            match &self.running {
                Running::Wheels{axles,diameter,..}=>{
                    value["axles"]=json!(axles.iter().map(|x|x-self.front).collect::<Vec<_>>());
                    value["wheelDiameter"]=json!(diameter);
                },
                Running::Track{width,height,middle,y,..}=>{
                    value["track"]=json!({"front":middle-width/2.0-self.front,"rear":middle+width/2.0-self.front,"y":y-baseline,"height":height});
                },
                Running::Skids{front,rear,y,tube,legs,..}=>{
                    value["skids"]=json!({"front":front-self.front,"rear":rear-self.front,"y":y-baseline,"tube":tube,
                        "legs":legs.iter().map(|(foot,top)|json!({"x":foot.x-self.front,"top":foot.y-baseline,"foot":top.y-baseline})).collect::<Vec<_>>()});
                },
            }
        }
        value
    }
    /// A point of it as it is told, `at` where it stands: marked where a gap begins.
    fn marked(&self,i:usize,at:Point)->Value {
        let mut point=at.to_value();
        if self.gaps.get(i)==Some(&true) {point["gap"]=json!(true);}
        point
    }
    /// The plate of the frame a piece of its gear at `x` along the design as written stands under: the rail of the
    /// segment it is in on wheels, the frame of it on a track.
    fn carrier(&self,x:f64)->String {
        let segment=self.framed().find(|(_,a,b)|x>=a.x-EPS && x<=b.x+EPS).map_or(0,|(i,..)|i);
        format!("chassis:{}-{segment}",if matches!(self.running,Running::Wheels{..}) {"rail"} else {"frame"})
    }
    /// The running gear, as pieces of the construction: its owners from `owner` on, after every piece written.
    /// The rim/hub or links use the frame's metal; rubber and optional steel
    /// armour remain their own materials. Reinforced support tubes are already
    /// included in the frame's real volume, mass and installed price.
    pub(super) fn gear(&self,frame:&Frame,catalogue:&Value,owner:u32)->Result<Vec<Value>,Value> {
        let at=|x:f64|frame.origin.x+x;
        let pieces:Vec<(String,ComponentKind,f64,f64,f64,f64,String)>=match &self.running {
            Running::Wheels{axles,diameter,..}=>axles.iter().enumerate().map(|(i,&x)|
                (format!("chassis:wheel-{i}"),ComponentKind::Wheel,at(x),diameter/2.0+0.01,*diameter,*diameter,self.carrier(x))).collect(),
            Running::Track{width,height,middle,y,..}=>vec![("chassis:track".to_owned(),ComponentKind::Track,at(*middle),frame.origin.y+y,*width,*height,self.carrier(*middle))],
            // Skids are plates of the frame (`attach`), no piece of their own.
            Running::Skids{..}=>Vec::new(),
        };
        pieces.into_iter().zip(owner..).map(|((id,kind,x,y,width,height,mount),owner)|{
            let mut module=json!({"id":id,"kind":kind.name(),"owner":owner,"x":x,"y":y,"angle":0.0,
                "width":width,"height":height,"mountId":mount,"attached":true});
            if self.metal.name!="steel" {module["metal"]=json!(self.metal.name);}
            if self.armour>0.0 {module["armorMm"]=json!(self.armour);}
            module["suspension"]=json!({"enabled":true,"travel":self.travel});
            // As deep as the piece of the catalogue it is drawn to the height of.
            let (_,base_h,base_d)=kind.dimensions();
            fresh_component(&mut module,kind,catalogue,None,crate::game_geometry::installed_depth(kind,base_d,height/base_h))?;
            let armour=kind.armour_mass(width,height,self.armour);
            let bare=(module["physicalMass"].as_f64().unwrap()-armour)/self.metal.mass;
            let density=Material::from_name(self.metal.name).density/Material::from_name("steel").density;
            let mass=bare*(self.rubber_share+(1.0-self.rubber_share)*density)+armour;
            module["physicalMass"]=json!(mass);
            module["physicalCenterLocal"]=Point::ZERO.to_value();module["physicalInertia"]=json!(mass*(width*width+height*height)/12.0);
            Ok(module)
        }).collect()
    }
    /// What the workshop is told of it, in the field: its model, ends, points and metal, how thick its frame is, its
    /// plates and its gear — where its axles stand, or where its track ends and on how many road wheels —, each of its
    /// segments, the outline and top face of each part between gaps, what the vehicle
    /// weighs empty and loaded against what it carries, with what each axle or road wheel of the model carries, and
    /// where its weight falls furthest ahead and furthest behind (`balance`).
    pub(super) fn projection(&self,frame:&Frame,modules:&Value,empty:f64,loaded:f64,balance:(f64,f64))->Value {
        let origin=frame.origin.x;
        let deck=frame.origin.y+self.points.iter().map(|p|p.y).fold(f64::INFINITY,f64::min);
        let world=|p:Point|add(frame.origin,p);
        let beds:Vec<Value>=frame.beds.iter().map(|wall|{
            json!({"id":wall.id,"owner":wall.owner,"a":wall.a.to_value(),"b":wall.b.to_value(),"normal":wall.normal.to_value(),
                "length":wall.length,"material":wall.material,"thicknessMm":wall.thickness})
        }).collect();
        let level=level_runs(&self.points,&self.gaps);
        let segments:Vec<Value>=self.points.windows(2).enumerate().map(|(i,ends)|{
            let plates:Vec<&String>=frame.plates.iter().filter(|plate|plate.part.is_some_and(|part|part.1==i)).map(|plate|&plate.id).collect();
            json!({"index":i,"gap":self.gaps[i],"a":world(ends[0]).to_value(),"b":world(ends[1]).to_value(),"plates":plates,
                "low":!self.gaps[i] && level.iter().any(|&(first,last)|ends[0].x>=first-EPS && ends[1].x<=last+EPS)})
        }).collect();
        let outlines:Vec<Vec<Value>>=self.outlines().into_iter().map(|outline|outline.into_iter().map(|p|world(p).to_value()).collect()).collect();
        let mut value=json!({"model":self.model,"kind":self.model,"front":origin+self.front,"rear":origin+self.rear,"length":self.rear-self.front,
            "deck":deck,"suspension":self.suspension()/(1.0/CELL),"depth":self.depth(),"armorMm":self.armour,"metal":self.metal.name,"thicknessMm":self.thickness,
            "points":self.points.iter().enumerate().map(|(i,&p)|self.marked(i,world(p))).collect::<Vec<_>>(),
            "segments":segments,"outlines":outlines,"beds":beds,
            "plates":frame.plates.iter().filter(|plate|plate.part.is_some()).map(|plate|plate.id.clone()).collect::<Vec<_>>(),
            "gear":modules.as_array().into_iter().flatten().filter(|m|m["id"].as_str().is_some_and(|id|id.starts_with("chassis:")))
                .map(|m|m["id"].clone()).collect::<Vec<_>>(),
            "emptyKg":empty,"loadedKg":loaded,"frameKg":self.mass,
            "sectionAreaM2":self.section_area,"secondMomentM4":self.second_moment,
            "frameLimitKg":self.frame_limit,"gearLimitKg":self.gear_limit,"limitKg":self.limit,
            "balance":[origin+balance.0,origin+balance.1]});
        match &self.running {
            Running::Wheels{axles,diameter,..}=>{
                value["axles"]=json!(axles.iter().map(|&x|origin+x).collect::<Vec<_>>());value["axleKg"]=json!(self.rating);
                value["wheelDiameter"]=json!(diameter);
            },
            Running::Track{width,height,middle,y,nose,..}=>{
                value["track"]=json!({"front":origin+middle-width/2.0,"rear":origin+middle+width/2.0,"y":frame.origin.y+y,
                    "wheels":ComponentKind::road_wheels(*width,*height),"height":height});
                value["roadWheelKg"]=json!(self.rating);value["noseMm"]=json!(nose);
            },
            Running::Skids{struts,front,rear,y,tube,..}=>{
                value["skids"]=json!({"front":origin+front,"rear":origin+rear,"y":frame.origin.y+y,"tube":tube,
                    "struts":struts.iter().map(|&x|origin+x).collect::<Vec<_>>()});
                value["strutKg"]=json!(self.rating);
            },
        }
        value
    }
}

#[cfg(test)]
mod tests {
    use super::super::{CELL, CONSTRUCTION_VERSION, cell, compile, metres, seated};
    use crate::game_damage::{Material, fixtures::full_catalogue};
    use crate::game_geometry::ComponentKind;
    use serde_json::{Value, json};
    fn spec(model:&str)->&'static Value {&full_catalogue()["chassis"][model]}
    fn number(value:&Value,key:&str)->f64 {value[key].as_f64().unwrap_or_else(||panic!("{key}: {value}"))}
    fn whole(value:&Value,key:&str)->i64 {value[key].as_i64().unwrap_or_else(||panic!("{key}: {value}"))}
    /// A box of thin steel as long as the chassis, from end to end, 1.2 m high, with a command post in it, on `chassis`,
    /// where its model hangs its gear (`seated`), or as written (`bare`).
    fn boxed(chassis:Value)->Value {seated(&bare(chassis),full_catalogue())}
    fn bare(chassis:Value)->Value {
        let points=chassis["points"].as_array().unwrap();let end=|i:usize|number(&points[i],"x").round() as i64;let (front,rear)=(end(0),end(points.len()-1));
        let corner=|i:usize|format!("hull-{i}");
        let nodes:Vec<Value>=[(front,0),(rear,0),(rear,24),(front,24)].iter().enumerate()
            .map(|(i,&(x,y))|json!({"id":corner(i),"x":x,"y":y})).collect();
        let plates:Vec<Value>=["floor","rear","roof","front"].iter().enumerate().map(|(i,side)|
            json!({"id":format!("hull:{side}"),"a":corner(i),"b":corner((i+1)%4),"material":"steel","thicknessMm":8})).collect();
        json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":chassis,"nodes":nodes,"plates":plates,
            "components":[{"id":"command","kind":"command","pose":{"x":0,"y":10,"angle":0.0}}]})
    }
    fn compiled(chassis:Value)->Value {compile(&boxed(chassis),full_catalogue()).unwrap_or_else(|e|panic!("{e}"))}
    fn refused(chassis:Value)->Value {compile(&boxed(chassis),full_catalogue()).unwrap_err()}
    fn plate<'a>(result:&'a Value,id:&str)->&'a Value {
        result["compiled"]["plates"].as_array().unwrap().iter().find(|plate|plate["id"]==id).unwrap()
    }
    fn gear(result:&Value)->Vec<Value> {
        result["compiled"]["modules"].as_array().unwrap().iter().filter(|m|m["id"].as_str().unwrap().starts_with("chassis:")).cloned().collect()
    }
    #[test]
    fn only_the_two_current_chassis_ids_are_admitted() {
        for model in ["wheeled-light","wheeled-medium","wheeled-heavy","tracked-light","tracked-medium","tracked-heavy","unknown"] {
            assert!((refused(json!({"model":model,"points":[{"x":-60,"y":0},{"x":60,"y":0}]}))["code"]=="CHASSIS_MODEL"),"{model}");
            // Even an extra catalogue entry is no alias or conversion path.
            let mut catalogue=full_catalogue().clone();
            catalogue["chassis"][model]=spec("wheeled").clone();
            assert!(super::Chassis::read(&boxed(json!({"model":model,"points":[{"x":-60,"y":0},{"x":60,"y":0}]})),&catalogue)
                .is_err(),"{model}");
        }
        for model in ["wheeled","tracked"] {
            let result=compiled(json!({"model":model,"points":[{"x":-60,"y":0},{"x":60,"y":0}]}));
            assert!(plate(&result,"chassis:frame-0")["chassis"].get("topSpeed").is_none());
        }
    }
    #[test]
    fn default_gear_and_steel_keep_geometry_but_explicit_track_coordinates_remain_authored() {
        for model in ["wheeled","tracked"] {
            let s=spec(model);let (shortest,longest)=(s["length"][0].as_f64().unwrap(),s["length"][1].as_f64().unwrap());
            for length in [shortest,(shortest+longest)/2.0,longest] {
                let mut ends=json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}]});
                if model=="wheeled" && length==longest {ends["thicknessMm"]=json!(40.0);}
                let plain=compiled(ends.clone());
                // Capacity comes from its physical section and supports, never
                // from a nominal rating hidden in a model name.
                let chassis=&plain["compiled"]["chassis"];
                assert_eq!(chassis["metal"],"steel");
                assert!(s.get("limitKg").is_none());
                assert_eq!(number(chassis,"limitKg"),number(chassis,"frameLimitKg").min(number(chassis,"gearLimitKg")),"{model} {length}");
                // Written out where the model puts it, the gear and the steel come back unwritten, and the same.
                let mut written=ends.clone();written["metal"]=json!("steel");
                written["gearScale"]=json!(1.0);written["thicknessMm"]=chassis["thicknessMm"].clone();
                if s["kind"]=="wheeled" {
                    written["axles"]=json!(chassis["axles"].as_array().unwrap().iter().map(|a|cell(a.as_f64().unwrap()-12.0)).rev().collect::<Vec<_>>());
                } else {
                    // The fixture writes the exact local default; a displayed world endpoint has already rounded
                    // the addition of the origin and is not a lossless inverse authoring representation.
                    let local=super::Chassis::read(&boxed(ends.clone()),full_catalogue()).unwrap().unwrap();
                    let super::Running::Track{width,y,..}=&local.running else{panic!("expected a tracked default")};
                    written["track"]=json!({"front":ends["points"][0]["x"],"rear":(local.front+width)/CELL,"y":y/CELL});
                }
                let again=compiled(written.clone());let mut expected=boxed(ends.clone())["chassis"].clone();
                if model=="tracked" {expected["track"]=written["track"].clone();}
                assert_eq!(again["construction"]["chassis"],expected,"{model} {length}");
                assert_eq!(again["compiled"],plain["compiled"],"{model} {length}");
            }
        }
    }
    #[test]
    fn extended_frames_keep_the_construction_envelope_and_reinforcement_has_no_class_ceiling() {
        for model in ["wheeled","tracked"] {
            let written=json!({"model":model,"points":[{"x":-120,"y":0},{"x":120,"y":0}]});
            let chassis=super::Chassis::read(&boxed(written),full_catalogue()).unwrap().unwrap();
            assert!(chassis.limit.is_finite() && chassis.limit>0.0);
            assert_eq!(chassis.limit,chassis.frame_limit.min(chassis.gear_limit));
            assert!(super::Chassis::read(&boxed(json!({"model":model,"points":[{"x":-122,"y":0},{"x":120,"y":0}]})),full_catalogue()).is_err());
        }
        let made=|gauge:f64|compiled(json!({"model":"wheeled","points":[{"x":-120,"y":0},{"x":120,"y":0}],"thicknessMm":gauge,
            "gearScale":1.25/1.1,"axles":[-98,-32,34,96]}));
        let ordinary=made(10.0);let reinforced=made(20.0);
        assert!(number(&ordinary["compiled"]["chassis"],"limitKg")>38000.0,"the retired heavy rating is not a cap");
        assert!(number(&reinforced["compiled"]["chassis"],"limitKg")>number(&ordinary["compiled"]["chassis"],"limitKg"));
        assert_eq!(compile(&reinforced["construction"],full_catalogue()).unwrap(),reinforced);
    }
    #[test]
    fn frame_gauge_changes_section_mass_installed_price_and_total_load_capacity() {
        let made=|thickness:f64|compiled(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],"thicknessMm":thickness}));
        let ordinary=made(8.0);let thicker=made(16.0);let thinner=made(5.0);
        let frame_mass=|r:&Value|r["compiled"]["plates"].as_array().unwrap().iter()
            .filter(|p|p.get("chassis").is_some()).map(|p|number(p,"physicalMass")).sum::<f64>();
        let cost=|r:&Value|number(&crate::game_cost::construction(&r["compiled"],full_catalogue()).unwrap(),"chassis");
        assert!(frame_mass(&thicker)>frame_mass(&ordinary) && frame_mass(&ordinary)>frame_mass(&thinner));
        for made in [&ordinary,&thicker,&thinner] {
            assert!((frame_mass(made)-number(&made["compiled"]["chassis"],"frameKg")).abs()<1e-6);
            assert_eq!(cost(made),(frame_mass(made)*Material::from_name("steel").price-1e-9).ceil());
        }
        for key in ["sectionAreaM2","secondMomentM4","frameLimitKg","gearLimitKg","limitKg"] {
            assert!(number(&thicker["compiled"]["chassis"],key)>number(&ordinary["compiled"]["chassis"],key),"{key}");
            assert!(number(&ordinary["compiled"]["chassis"],key)>number(&thinner["compiled"]["chassis"],key),"{key}");
        }
        assert_eq!(number(plate(&thicker,"chassis:frame-0"),"thicknessMm"),16.0);
        assert!(ordinary["construction"]["chassis"].get("thicknessMm").is_none());
        assert_eq!(made(8.0+super::EPS/2.0),ordinary,"an omitted near-default must also normalize the compiled geometry");
        assert_eq!(compile(&thicker["construction"],full_catalogue()).unwrap(),thicker);
        for (model,thickness) in [("wheeled",126.0),("tracked",201.0)] {
            let length=spec(model)["length"][0].as_f64().unwrap();
            assert!(({let refusal=&(refused(json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"thicknessMm":thickness})));refusal["code"]=="FIELD" && refusal["field"]=="thicknessMm"}));
        }
        for bad in [json!(0.0),json!(4.9),json!("8"),Value::Null] {
            assert!(({let refusal=&(refused(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],"thicknessMm":bad})));refusal["code"]=="FIELD" && refusal["field"]=="thicknessMm"}));
        }
    }
    #[test]
    fn one_uniform_gear_scale_reaches_real_modules_on_the_floor_and_hangs_the_deck_as_high_as_it_takes() {
        for model in ["wheeled","tracked"] {
            let s=spec(model);let length=6.0;
            let ordinary=compiled(json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"thicknessMm":40.0}));
            for scale in [0.75,1.5] {
                let made=compiled(json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"gearScale":scale,"thicknessMm":40.0}));
                let chassis=&made["compiled"]["chassis"];let pieces=gear(&made);let originals=gear(&ordinary);
                let tracked=s["kind"]=="tracked";let base_height=number(s,if tracked {"track"} else {"wheel"});
                let height=base_height*scale;
                // The gear stands on the floor and the deck where its model hangs gear of its size, the larger the higher. The
                // compiler moves nothing written: the workshop moves all of it with the gear (`src/chassis-editing.js`).
                assert_eq!(number(chassis,"suspension"),0.0);
                assert_eq!(number(chassis,"deck"),1.3+metres(whole(&made["construction"]["chassis"]["points"][0],"y")));
                assert_eq!(number(chassis,"deck")>number(&ordinary["compiled"]["chassis"],"deck"),scale>1.0,"{model} {scale}");
                assert_eq!(made["compiled"]["frame"]["origin"],ordinary["compiled"]["frame"]["origin"]);
                for piece in &pieces {
                    assert_eq!(number(piece,"height"),height);
                    if !tracked {assert_eq!(number(piece,"width"),height);}
                    assert!((number(piece,"y")-height/2.0-0.01).abs()<1e-12);
                    assert!(number(piece,"physicalMass").is_finite() && number(piece,"physicalMass")>0.0);
                    assert_eq!(piece["kind"],if tracked {json!("track")} else {json!("wheel")});
                }
                if tracked {
                    let wheels=ComponentKind::road_wheels(number(&pieces[0],"width"),height);
                    assert!((3.0..=14.0).contains(&wheels) && (wheels-wheels.round()).abs()<1e-9);
                    assert_eq!(number(&chassis["track"],"height"),height);
                } else {
                    assert_eq!(number(chassis,"wheelDiameter"),height);
                    assert_eq!(number(&plate(&made,"chassis:frame-0")["chassis"],"wheelDiameter"),height);
                    assert_eq!(pieces.len(),originals.len());
                    assert_eq!(number(&pieces[0],"physicalMass")>number(&originals[0],"physicalMass"),scale>1.0);
                }
                assert_eq!(compile(&made["construction"],full_catalogue()).unwrap(),made,"{model} {scale}");
            }
        }
        // Larger tyres cannot overlap: the authored axles must be preserved or refused.
        assert!(({let refusal=&(refused(json!({"model":"wheeled","points":[{"x":-70,"y":0},{"x":70,"y":0}],"gearScale":1.5,
            "axles":[-48,-16,16,48]})));refusal["code"]=="AXLE_SPACING"}));
        for bad in [json!(0.49),json!(1.51),json!([1.0,1.2]),Value::Null] {
            assert!(({let refusal=&(refused(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],"gearScale":bad})));refusal["code"]=="FIELD" && refusal["field"]=="gearScale"}));
        }
        // No per-wheel sizes or alternate gear can bypass the single chassis contract.
        let mut mixed=json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}]});
        mixed["wheelDiameters"]=json!([1.0,1.2,1.0]);
        assert!((refused(mixed)["code"]=="AUTHORING_FIELDS"));
    }
    #[test]
    fn the_springs_of_a_track_travel_as_far_as_its_road_wheels_stand_under_its_ends_and_those_of_wheels_as_the_model_has_it() {
        for scale in [0.5,1.0,1.5] {for model in ["wheeled","tracked"] {
            let made=compiled(json!({"model":model,"points":[{"x":-cell(3.0),"y":0},{"x":cell(3.0),"y":0}],"gearScale":scale,"thicknessMm":40.0}));
            for piece in gear(&made) {
                let travel=number(&piece["suspension"],"travel");
                if model=="wheeled" {assert_eq!(travel,number(spec(model),"travel"));continue;}
                // From 0.11 m on the smallest track to 0.33 m on the largest: 0.28 of its height.
                let height=number(&piece,"height");let wheels=crate::game_geometry::track_wheels(number(&piece,"width"),height);
                assert!((travel-(wheels.end.y-wheels.low)).abs()<1e-12 && (travel-0.28*height).abs()<1e-12,"{scale}: {travel}");
            }
        }}
        assert!(spec("tracked").get("travel").is_none(),"a track has no travel of its model");
    }
    #[test]
    fn the_suspension_reaches_the_gear_on_the_floor_twenty_centimetres_over_or_under_where_the_model_hangs_it() {
        for model in ["wheeled","tracked"] {
            for (length,scale,thickness) in [(3.0,0.5,None),(6.0,1.0,None),(12.0,1.5,Some(40.0))] {
                let mut written=json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"gearScale":scale});
                if let Some(thickness)=thickness {written["thicknessMm"]=json!(thickness);}
                let seated=boxed(written);
                // The whole of it `lift` cells up, or down.
                let lifted=|lift:i64|{let mut input=seated.clone();
                    for point in input["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(whole(point,"y")+lift);}
                    for node in input["nodes"].as_array_mut().unwrap() {node["y"]=json!(whole(node,"y")+lift);}
                    let pose=&mut input["components"][0]["pose"];pose["y"]=json!(whole(pose,"y")+lift);
                    compile(&input,full_catalogue())};
                for lift in [-4,-1,0,3,4] {
                    let made=lifted(lift).unwrap_or_else(|e|panic!("{model} {length} {lift}: {e}"));
                    assert_eq!(number(&made["compiled"]["chassis"],"suspension"),metres(lift),"{model} {length} {lift}");
                    assert_eq!(plate(&made,"chassis:frame-0")["chassis"]["suspension"],made["compiled"]["chassis"]["suspension"]);
                    // The gear stands on the floor however high the chassis is over it.
                    for piece in gear(&made) {assert!((number(&piece,"y")-number(&piece,"height")/2.0-0.01).abs()<1e-12);}
                }
                for lift in [-5,5,20] {
                    let error=lifted(lift).unwrap_err();
                    assert_eq!((&error["code"],&error["model"],&error["range"]),(&json!("SUSPENSION_REACH"),&json!(model),&json!([-0.2,0.2])),"{model} {length} {lift}");
                    assert_eq!(number(&error,"value"),metres(lift),"{error}");
                }
            }
        }
    }
    #[test]
    fn a_wheeled_chassis_runs_on_as_many_axles_as_its_model_takes_where_the_player_puts_them() {
        let wheeled=|axles:Value|json!({"model":"wheeled","points":[{"x":-48,"y":0},{"x":48,"y":0}],"axles":axles});
        // Three axles, written in any order: told from the front, each where it was put, on a wheel of the model.
        let result=compiled(wheeled(json!([36,-32,6])));
        assert_eq!(result["construction"]["chassis"]["axles"],json!([-32,6,36]));
        assert_eq!(compile(&result["construction"],full_catalogue()).unwrap(),result);
        let wheels=gear(&result);
        assert_eq!(wheels.iter().map(|w|w["id"].as_str().unwrap()).collect::<Vec<_>>(),["chassis:wheel-0","chassis:wheel-1","chassis:wheel-2"]);
        for (wheel,x) in wheels.iter().zip([-1.6,0.3,1.8]) {
            assert!((number(wheel,"x")-12.0-x).abs()<1e-12 && wheel["width"]==spec("wheeled")["wheel"] && wheel["mountId"]=="chassis:rail-0");
        }
        let chassis=&result["compiled"]["chassis"];
        assert_eq!(chassis["axles"],json!([10.4,12.3,13.8]));
        assert!(number(chassis,"gearLimitKg")>number(chassis,"axleKg"));
        assert!(number(chassis,"gearLimitKg")<3.0*number(chassis,"axleKg"),"unequal spacing does not imply equal load");
        for key in ["limitKg","frameLimitKg","gearLimitKg"] {
            assert_eq!(plate(&result,"chassis:frame-0")["chassis"][key],chassis[key],"{key}");
        }
        // Another wheel also adds one real support tube to the frame.
        let two=compiled(json!({"model":"wheeled","points":[{"x":-48,"y":0},{"x":48,"y":0}]}));
        let weight=|r:&Value|number(&r["compiled"]["chassis"],"emptyKg");
        let price=|r:&Value|number(&crate::game_cost::construction(&r["compiled"],full_catalogue()).unwrap(),"runningGear");
        let added_support=number(chassis,"frameKg")-number(&two["compiled"]["chassis"],"frameKg");
        assert!(added_support>0.0);
        assert!((weight(&result)-weight(&two)-number(&wheels[0],"physicalMass")-added_support).abs()<1e-6);
        assert_eq!(price(&result),price(&two)*1.5);
        // No fewer and no more than its model takes, each wheel whole under the frame, none nearer the next than a
        // wheel across and a hand's breadth: refused by name.
        for (axles,reason) in [(json!([0]),"AXLE_COUNT"),
            (json!([-36,-12,12,36,40,42,44,46,48]),"AXLE_COUNT"),
            (json!([-40,20]),"AXLE_EXTENT"),(json!([-20,39]),"AXLE_EXTENT"),
            (json!([-20,3]),"AXLE_SPACING"),(json!([-20,"x"]),"AXLES"),
            (json!(2),"AXLES")] {
            let error=refused(wheeled(axles.clone()));assert!((error["code"]==reason || error["field"]==reason),"{axles}: {error}");
        }
        for axles in [json!([-20,4]),json!([-37,37])] {assert!(compile(&boxed(wheeled(axles)),full_catalogue()).is_ok());}
        // A fractional authored axle is physical, not a hidden 5cm snap; all real manufacturing limits still apply.
        let fractional=compiled(wheeled(json!([-20,4.5])));
        assert_eq!(fractional["construction"]["chassis"]["axles"],json!([-20,4.5]));
        assert!((number(&gear(&fractional)[1],"x")-12.225).abs()<1e-12);
        // A tracked chassis has none.
        let error=refused(json!({"model":"tracked","points":[{"x":-48,"y":0},{"x":48,"y":0}],"axles":[-20,20]}));
        assert!((error["code"]=="CHASSIS_GEAR_KIND"),"{error}");
    }
    #[test]
    fn resizing_eight_authored_axles_preserves_them_or_refuses_the_whole_design() {
        let axles=json!([-102,-73,-44,-15,14,43,72,101]);
        let source=boxed(json!({"model":"wheeled","points":[{"x":-120,"y":0},{"x":120,"y":0}],"axles":axles}));
        for scale in [0.75,1.0,1.05] {
            let mut resized=source.clone();resized["chassis"]["gearScale"]=json!(scale);
            let result=compile(&resized,full_catalogue()).unwrap();
            assert_eq!(result["construction"]["chassis"]["axles"],axles,"{scale}");
            assert_eq!(gear(&result).len(),8,"{scale}");
        }
        let mut refused_resize=source.clone();refused_resize["chassis"]["gearScale"]=json!(1.5);
        // Every enlarged wheel is still whole within the ends: only their spacing refuses this edit.
        let radius=number(spec("wheeled"),"wheel")*1.5/2.0;
        assert!(axles.as_array().unwrap().iter().all(|x|(-6.0+radius..=6.0-radius).contains(&metres(x.as_i64().unwrap()))));
        assert!((compile(&refused_resize,full_catalogue()).unwrap_err()["code"]=="AXLE_SPACING"));
        assert_eq!(source["chassis"]["axles"],axles);
        assert!(source["chassis"].get("gearScale").is_none());
    }
    #[test]
    fn a_tracks_literal_span_and_centre_change_physics_without_moving_the_authored_body() {
        let scale=number(spec("tracked"),"track")/0.74;let width=|n:f64|ComponentKind::track_length(n)*scale;
        let tracked=|track:Value|json!({"model":"tracked","points":[{"x":-70,"y":0},{"x":70,"y":0}],"track":track});
        let plain=compiled(json!({"model":"tracked","points":[{"x":-70,"y":0},{"x":70,"y":0}]}));
        let laid=&plain["compiled"]["chassis"]["track"];
        assert_eq!((number(laid,"front"),number(laid,"rear")),(8.5,15.5),"default is a continuous frame span");
        let input=boxed(tracked(json!({"front":-62,"rear":62,"y":-18})));
        let result=compile(&input,full_catalogue()).unwrap();let before=&gear(&result)[0];
        assert_eq!(result["construction"]["chassis"]["track"],input["chassis"]["track"]);
        assert_eq!(compile(&result["construction"],full_catalogue()).unwrap(),result);
        let mut longer=input.clone();longer["chassis"]["track"]["rear"]=json!(62.26);
        let extended=compile(&longer,full_catalogue()).unwrap();let after=&gear(&extended)[0];
        assert!((number(after,"width")-number(before,"width")-0.013).abs()<1e-12,"sub-cell length changes real geometry");
        assert_eq!(ComponentKind::road_wheels(number(after,"width"),number(after,"height")),ComponentKind::road_wheels(number(before,"width"),number(before,"height")));
        assert!((number(after,"physicalMass")/number(before,"physicalMass")-number(after,"width")/number(before,"width")).abs()<1e-12);
        assert!(number(&crate::game_cost::piece(after,full_catalogue()).unwrap(),"runningGear")>number(&crate::game_cost::piece(before,full_catalogue()).unwrap(),"runningGear"));
        for piece in [before,after] {
            // Its steel and its rubber, which is kept as it is whatever the metal (game_cost.rs `kept`).
            let expected=(9000.0*(number(piece,"height")/0.74).powf(1.5)*number(piece,"width")/5.04-1e-9).ceil();
            let price=crate::game_cost::piece(piece,full_catalogue()).unwrap();
            assert_eq!(number(&price,"runningGear")+number(&price,"kept"),expected,"price follows real length, not the rounded support count");
        }
        let mut taller=input.clone();taller["chassis"]["gearScale"]=json!(1.02);
        let resized=compile(&taller,full_catalogue()).unwrap();let grown=&gear(&resized)[0];
        assert!((number(grown,"height")-number(before,"height")*1.02).abs()<1e-12);
        assert_eq!((grown["x"].clone(),grown["y"].clone(),grown["width"].clone()),(before["x"].clone(),before["y"].clone(),before["width"].clone()));
        assert_eq!(resized["construction"]["chassis"]["points"],result["construction"]["chassis"]["points"]);
        let mut lowered=input.clone();lowered["chassis"]["track"]["y"]=json!(-19.2);
        let shifted=compile(&lowered,full_catalogue()).unwrap();let moved=&gear(&shifted)[0];
        assert!((number(moved,"y")-number(before,"y")+0.06).abs()<1e-12);
        assert!((number(&shifted["compiled"]["chassis"],"suspension")-0.06).abs()<1e-12);
        for key in ["nodes","plates","components"] {assert_eq!(shifted["construction"][key],result["construction"][key]);}
        assert_eq!(shifted["construction"]["chassis"]["points"],result["construction"]["chassis"]["points"]);
        assert!((number(&shifted["compiled"]["chassis"]["track"],"y")-number(moved,"y")).abs()<1e-12);
        let picture=&plate(&shifted,"chassis:frame-0")["chassis"];assert!((number(&picture["track"],"y")+number(picture,"deck")-number(moved,"y")).abs()<1e-12);
        let from=|front:f64,length:f64|json!({"front":front/CELL,"rear":(front+length)/CELL,"y":-18});
        for (track,reason) in [(from(-1.0,width(3.0)-0.001),"TRACK_LENGTH"),(from(-(width(14.0)+0.001)/2.0,width(14.0)+0.001),"TRACK_LENGTH"),
            (from(-3.501,6.2),"TRACK_EXTENT"),(json!({"front":-62,"rear":62}),"FIELD"),
            (json!({"front":-62,"rear":62,"y":-18,"wheels":8}),"AUTHORING_FIELDS")] {
            let error=refused(tracked(track.clone()));assert_eq!(error["code"],reason,"{track}: {error}");
        }
        let mut unreachable=input.clone();unreachable["chassis"]["track"]["y"]=json!(-22.02);
        assert_eq!(compile(&unreachable,full_catalogue()).unwrap_err()["code"],"SUSPENSION_REACH");
        let error=refused(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],"track":{"front":-40,"rear":40}}));
        assert!((error["code"]=="CHASSIS_GEAR_KIND"),"{error}");
    }
    #[test]
    fn metal_changes_real_frame_and_gear_without_changing_millimetres_rubber_or_armour() {
        let steel=Material::from_name("steel");
        for model in ["wheeled","tracked"] {
            let length=6.0;
            let made=|metal:&str|compiled(json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"metal":metal,"thicknessMm":20.0,"armorMm":10.0}));
            let base=made("steel");
            assert!(base["construction"]["chassis"].get("metal").is_none());
            let parts=["chassis:frame-0",if model=="wheeled" {"chassis:rail-0"} else {"chassis:nose"}];
            let frame=|r:&Value|parts.iter().map(|id|number(plate(r,id),"physicalMass")).sum::<f64>();
            for metal in ["aluminum","titanium"] {
                let result=made(metal);let other=Material::from_name(metal);
                assert_eq!(result["construction"]["chassis"]["metal"],metal);
                assert_eq!(compile(&result["construction"],full_catalogue()).unwrap(),result);
                let chassis=&result["compiled"]["chassis"];
                assert_eq!((&chassis["metal"],number(chassis,"thicknessMm")),(&json!(metal),20.0));
                for id in parts {assert_eq!(plate(&result,id)["material"],metal);}
                assert_eq!(plate(&result,parts[1])["thicknessMm"],plate(&base,parts[1])["thicknessMm"]);
                assert!((frame(&result)-frame(&base)*other.density/steel.density).abs()<1e-6,"{model} {metal}");
                assert_eq!(chassis["secondMomentM4"],base["compiled"]["chassis"]["secondMomentM4"]);
                assert!(number(chassis,"limitKg")<number(&base["compiled"]["chassis"],"limitKg"));
                let rubber=spec(model)["structure"]["rubberShare"][model].as_f64().unwrap();
                for (wheel,original) in gear(&result).iter().zip(gear(&base)) {
                    assert_eq!(wheel["metal"],metal);
                    let kind=ComponentKind::from_name(wheel["kind"].as_str().unwrap()).unwrap();
                    let armour=kind.armour_mass(number(wheel,"width"),number(wheel,"height"),10.0);
                    let bare=number(&original,"physicalMass")-armour;
                    let expected=bare*(rubber+(1.0-rubber)*other.density/steel.density)+armour;
                    assert!((number(wheel,"physicalMass")-expected).abs()<1e-6);
                    assert!(number(wheel,"physicalMass")>bare*rubber+armour,"rubber and steel armour are not replaced by alloy");
                }
                let price=crate::game_cost::construction(&result["compiled"],full_catalogue()).unwrap();
                assert_eq!(number(&price,"chassis"),(number(chassis,"frameKg")*other.price-1e-9).ceil(),"{model} {metal}");
            }
            for metal in [json!("hha"),json!("ceramic"),json!("fiberglass"),json!("plastic"),json!(""),json!(1)] {
                let error=refused(json!({"model":model,"points":[{"x":-60,"y":0},{"x":60,"y":0}],"metal":metal}));
                assert!(error["code"]=="FIELD" && error["field"]=="metal" && error["model"]==model,"{error}");
            }
        }
    }
    #[test]
    fn material_defaults_use_the_same_millimetres_without_an_implicit_conversion() {
        for model in ["wheeled","tracked"] {
            let s=spec(model);let length=s["length"][1].as_f64().unwrap();
            for metal in ["steel","aluminum","titanium"] {
                let source=boxed(json!({"model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"metal":metal}));let c=super::Chassis::read(&source,full_catalogue()).unwrap().unwrap();
                let thickness=number(s,"frameMm");
                assert!((c.thickness-thickness).abs()<1e-12);
                assert_eq!(c.canonical(&source["chassis"])["model"],model);
                assert!(c.canonical(&source["chassis"]).get("thicknessMm").is_none());
                let expected_deck=if model=="wheeled" {1.1456666666666668} else {number(s,"deck")};
                assert!((c.deck-expected_deck).abs()<1e-12,"gauge defaults and ride height do not depend on metal");
                assert_eq!(c.limit,c.frame_limit.min(c.gear_limit));
                assert!(s.get("limitKg").is_none());
            }
        }
    }
    #[test]
    fn editing_floor_thickness_and_running_gear_preserves_every_authored_position() {
        for model in ["wheeled","tracked"] {
            let mut input=boxed(json!({"model":model,"points":[{"x":-60,"y":-4},{"x":60,"y":-4}]}));
            let plain=compile(&input,full_catalogue()).unwrap();
            input["plates"][0]["thicknessMm"]=json!(30.0);
            input["chassis"]["gearScale"]=json!(0.75);
            let changed=compile(&input,full_catalogue()).unwrap();
            assert_eq!(plain["compiled"]["frame"]["origin"],super::super::CONSTRUCTION_ORIGIN.to_value());
            assert_eq!(plain["construction"]["nodes"],changed["construction"]["nodes"]);
            assert_eq!(plain["construction"]["chassis"]["points"],changed["construction"]["chassis"]["points"]);
            for id in ["hull:floor","hull:roof","chassis:frame-0"] {
                for key in ["x","y","angle"] {assert_eq!(plate(&plain,id)[key],plate(&changed,id)[key],"{model} {id} {key}");}
            }
            assert_eq!(plain["compiled"]["modules"][0]["x"],changed["compiled"]["modules"][0]["x"]);
            assert_eq!(plain["compiled"]["modules"][0]["y"],changed["compiled"]["modules"][0]["y"]);
            assert_eq!(changed["compiled"]["chassis"]["deck"],plain["compiled"]["chassis"]["deck"]);
        }
    }

    #[test]
    fn the_weight_falls_between_the_first_axle_and_the_last_however_full_or_empty_what_it_holds() {
        // Reinforce this balance fixture so the intended tipping refusal is
        // reached before the independent cantilever strength check.
        let wheeled=|axles:Option<Value>|{let mut c=json!({"model":"wheeled","points":[{"x":-48,"y":0},{"x":48,"y":0}],"thicknessMm":20.0});if let Some(a)=axles {c["axles"]=a;}c};
        let refused=|input:&Value,direction:&str|{let error=compile(input,full_catalogue()).unwrap_err();assert_eq!(error["code"],"CHASSIS_BALANCE");assert_eq!(error["direction"],direction);};
        // Its weight in the middle, both axles behind it or both ahead: it would tip onto its hull.
        refused(&boxed(wheeled(Some(json!([6,32])))),"front");
        refused(&boxed(wheeled(Some(json!([-32,-6])))),"rear");
        // With nothing to fill, it falls in one place, where the whole of it does.
        let plain=compiled(wheeled(None));let balance=&plain["compiled"]["chassis"]["balance"];
        let center=12.0+number(&plain["compiled"]["fixedAssembly"]["centerLocal"],"x");
        assert!((balance[0].as_f64().unwrap()-center).abs()<1e-9 && balance[0]==balance[1],"{balance}");
        // A hopper on the roof near the rear: empty, its weight falls between axles at -1.6 and 0.3; full of iron,
        // behind the last.
        let hopper=|axles:Option<Value>|{let mut input=boxed(wheeled(axles));input["components"].as_array_mut().unwrap().push(
            json!({"id":"hopper","kind":"hopper","sizeScale":0.8,"pose":{"x":30,"y":36,"angle":0.0}}));input};
        refused(&hopper(Some(json!([-32,6]))),"rear");
        let carried=compile(&hopper(None),full_catalogue()).unwrap();let balance=&carried["compiled"]["chassis"]["balance"];
        let center=12.0+number(&carried["compiled"]["fixedAssembly"]["centerLocal"],"x");
        assert!(balance[0].as_f64().unwrap()<=center+1e-9 && center<balance[1].as_f64().unwrap()-0.3,"{balance}");
        // A tank ahead and a load behind: furthest ahead with the tank full and the load empty, furthest behind
        // the other way, which is further back than with both full: on axles at -1.6 and 0.3 it falls behind the
        // last, though with all full it would not.
        let pieces=[(0.0,1000.0,1000.0),(-1.0,10.0,110.0),(1.0,50.0,550.0)];
        let on=|axles:Value|super::Chassis::read(&boxed(wheeled(Some(axles))),full_catalogue()).unwrap().unwrap();
        let (ahead,behind)=on(json!([-32,12])).balance(&pieces).unwrap();
        assert_eq!((ahead,behind),(-60.0/1160.0,540.0/1560.0));
        assert!((-110.0+550.0)/1660.0<0.3);
        assert!(({let refusal=&(on(json!([-32,6])).balance(&pieces).unwrap_err());refusal["code"]=="CHASSIS_BALANCE" && refusal["direction"]=="rear"}));
    }
    #[test]
    fn equal_support_shares_match_a_two_axle_lever_and_remove_lifted_contacts() {
        let near=|actual:f64,expected:f64|assert!((actual-expected).abs()<1e-12,"{actual} / {expected}");
        for (centre,expected) in [(0.0,1.0),(0.4,0.9),(2.0,0.5),(3.6,0.9),(4.0,1.0)] {
            near(super::max_support_share(&[0.0,4.0],centre),expected);
        }
        near(super::max_support_share(&[0.0,2.0,4.0],2.0),1.0/3.0);
        near(super::max_support_share(&[0.0,2.0,4.0],1.0),7.0/12.0);
        // At 3.8 m the front spring would pull down. It loses contact, leaving
        // the 2/4 m lever with 10/90 percent rather than a negative reaction.
        near(super::max_support_share(&[0.0,2.0,4.0],3.8),0.9);
    }
    #[test]
    fn stock_profiles_follow_gauge_and_vehicle_size_in_two_centimetre_steps() {
        let read=|model:&str,length:f64,scale:f64,gauge:f64|super::Chassis::read(&boxed(json!({
            "model":model,"points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],"gearScale":scale,"thicknessMm":gauge
        })),full_catalogue()).unwrap().unwrap();
        // Concrete dimensions, independent of the sizing expression: the
        // smaller scout no longer shares a 250 mm rail with a long truck.
        let scout=read("wheeled",4.8,0.95/1.1,8.0);
        assert!((scout.depth()-0.18).abs()<1e-12);
        assert!((read("wheeled",6.0,1.0,8.0).depth()-0.22).abs()<1e-12);
        assert!((read("wheeled",6.0,1.0,16.0).depth()-0.32).abs()<1e-12);
        assert!((read("wheeled",7.4,1.25/1.1,8.0).depth()-0.26).abs()<1e-12);
        assert!((read("tracked",6.4,1.0,20.0).depth()-0.38).abs()<1e-12);
        for model in ["wheeled","tracked"] {
            for scale in [0.75,1.0,1.5] {
                let mut previous=0.0;
                for gauge in [5.0,8.0,12.0,20.0,40.0,80.0,125.0] {
                    let c=read(model,6.0,scale,gauge);
                    assert!(c.depth()>=previous-1e-12 && c.depth()>=2.0*gauge/1000.0);
                    assert!((c.depth()/0.02-(c.depth()/0.02).round()).abs()<1e-10);
                    assert!(c.deck-c.depth()>0.1,"ground clearance is retained");
                    previous=c.depth();
                }
            }
        }
    }
    #[test]
    fn section_sizing_reference_accounts_for_axle_radius_and_full_bump_without_moving_authored_points() {
        let s=spec("wheeled");
        for length in [3.5,6.0,12.0] {for scale in [0.75,1.0,1.5] {for gauge in [5.0,8.0,20.0,80.0,125.0] {
            let chassis=super::Chassis::read(&boxed(json!({"model":"wheeled","points":[{"x":-cell(length/2.0),"y":0},{"x":cell(length/2.0),"y":0}],
                "gearScale":scale,"thicknessMm":gauge})),full_catalogue()).unwrap().unwrap();
            let diameter=number(s,"wheel")*scale;
            let tube=diameter*number(&s["structure"],"axleDiameterRatio")/2.0;
            let bump=chassis.travel*(1.0-crate::game_motion::SPRING_REST);
            let rail_bottom=chassis.deck-chassis.depth();
            assert!(rail_bottom>=diameter/2.0+0.01+tube+bump-1e-12,"{length} m / {scale} / {gauge} mm");
            let baseline=number(s,"deck")+(diameter-number(s,"wheel"))/2.0;
            assert!(chassis.deck>=baseline);
            assert!(chassis.deck<=baseline+1e-12 || (rail_bottom-(diameter/2.0+0.01+tube+bump)).abs()<1e-12,
                "raise only as far as the real section and suspension need");
        }}}
        // No authored ride-height field or second suspension convention. Even
        // a zero-travel catalogue uses its actual axle radius, not a fixed gap.
        let mut rigid=full_catalogue().clone();rigid["chassis"]["wheeled"]["travel"]=json!(0.0);
        let c=super::Chassis::read(&boxed(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}],"thicknessMm":125.0})),&rigid).unwrap().unwrap();
        assert!((c.deck-c.depth()-0.659).abs()<1e-12);
    }
    #[test]
    fn steel_section_matches_an_independent_six_metre_beam_and_axle_reference() {
        // Pin the reference section while the game's ordinary profiles scale
        // with vehicle size. The independent engineering figures stay fixed.
        let mut catalogue=full_catalogue().clone();
        catalogue["chassis"]["wheeled"]["structure"]["profileLength"]=json!(6.0);
        catalogue["chassis"]["wheeled"]["structure"]["profileStep"]=json!(0.01);
        let chassis=super::Chassis::read(&boxed(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}]})),&catalogue).unwrap().unwrap();
        let near=|actual:f64,expected:f64|assert!((actual-expected).abs()<1e-9*expected.abs().max(1.0),"{actual} / {expected}");
        // Two C rails 120*250*8 mm; 6 m frame, 4.4 m between axles,
        // 0.8 m overhangs, 2.4 m width, E=200 GPa, fy=285 MPa.
        // Five crossmembers plus two 198/182 mm axle tubes are included.
        near(chassis.section_area,0.007584);
        near(chassis.second_moment,0.000073325792);
        near(chassis.mass,795.0466680046113);
        // UDL stress permits 69083.804 N/m; L/200 permits 66108.903 N/m,
        // so deflection governs. The existing load factor of two is applied
        // once, to convert the governing force to gross vehicle mass.
        near(chassis.frame_limit,20216.79002474514);
        near(chassis.rating,10557.700598625428);
        // Only the unweighted preliminary value is the uniform sum. The
        // compiler subsequently applies the actual COM/support envelope.
        near(chassis.gear_limit,21115.401197250856);
    }
    #[test]
    fn yield_sets_the_axle_allowance_while_modulus_sets_elastic_deflection() {
        let written=boxed(json!({"model":"wheeled","points":[{"x":-60,"y":0},{"x":60,"y":0}]}));
        let base=super::Chassis::read(&written,full_catalogue()).unwrap().unwrap();
        let mut catalogue=full_catalogue().clone();
        catalogue["chassis"]["wheeled"]["structure"]["youngModulus"]["steel"]=json!(100e9);
        let softer=super::Chassis::read(&written,&catalogue).unwrap().unwrap();
        assert_eq!(softer.rating,base.rating,"modulus is not a yield-strength proxy");
        assert_eq!(softer.mass,base.mass);
        assert!((softer.frame_limit-base.frame_limit/2.0).abs()<1e-9*base.frame_limit);
        catalogue["chassis"]["wheeled"]["structure"]["yieldStrength"]["steel"]=json!(142.5e6);
        let weaker=super::Chassis::read(&written,&catalogue).unwrap().unwrap();
        assert!((weaker.rating-base.rating/2.0).abs()<1e-9*base.rating);
    }
    #[test]
    fn irregular_equal_supports_have_their_largest_share_at_a_com_interval_end() {
        for supports in [vec![-2.0,0.0,2.0],vec![-5.0,-4.9,1.0,5.0],vec![0.0,0.1,0.2,12.0]] {
            let (first,last)=(supports[0],supports[supports.len()-1]);
            for (lo,hi) in [(0.0,1.0),(0.05,0.45),(0.2,0.8),(0.55,0.95)] {
                let (lo,hi)=(first+(last-first)*lo,first+(last-first)*hi);
                let bound=super::max_support_share(&supports,lo).max(super::max_support_share(&supports,hi));
                for step in 0..=100 {
                    let centre=lo+(hi-lo)*step as f64/100.0;
                    assert!(super::max_support_share(&supports,centre)<=bound+1e-12,"{supports:?} {lo}..{hi}: {centre}");
                }
            }
        }
    }
    #[test]
    fn an_off_centre_vehicle_cannot_use_the_sum_of_both_axle_allowances() {
        let mut chassis=super::Chassis::read(&boxed(json!({"model":"wheeled","points":[{"x":-20,"y":0},{"x":100,"y":0}],
            "thicknessMm":20.0,"axles":[0,80]})),full_catalogue()).unwrap().unwrap();
        let rating=chassis.rating;let nominal=2.0*rating;let loaded=nominal*0.9;
        let balance=chassis.apply_load_envelope(&[(3.6,loaded,loaded)]);
        assert!((balance.0-3.6).abs()<1e-12 && (balance.1-3.6).abs()<1e-12);
        assert!(loaded<nominal,"the former total-only check would pass");
        assert!((chassis.gear_limit-rating/0.9).abs()<1e-9*rating);
        assert!(loaded>chassis.gear_limit,"the 90-percent rear reaction exceeds one support allowance");
        assert_eq!(chassis.limit,chassis.frame_limit.min(chassis.gear_limit));
    }
    #[test]
    fn independently_emptying_a_front_reserve_cannot_hide_a_rear_support_overload() {
        let mut chassis=super::Chassis::read(&boxed(json!({"model":"wheeled","points":[{"x":-20,"y":0},{"x":100,"y":0}],
            "thicknessMm":20.0,"axles":[0,80]})),full_catalogue()).unwrap().unwrap();
        let rating=chassis.rating;
        // Both reserves full: 2*rating at COM 2 m, exactly one allowance per
        // axle. Empty the front tank while keeping rear cargo: its 1.5*rating
        // at COM 3 m puts 1.125*rating on the rear axle.
        let pieces=[(2.5,rating,rating),(-1.0,0.0,rating/2.0),(4.0,0.0,rating/2.0)];
        let (ahead,behind)=chassis.apply_load_envelope(&pieces);
        assert!((ahead-4.0/3.0).abs()<1e-12 && (behind-3.0).abs()<1e-12);
        assert!((super::max_support_share(&[0.0,4.0],2.0)-0.5).abs()<1e-12);
        let share=super::max_support_share(&[0.0,4.0],ahead).max(super::max_support_share(&[0.0,4.0],behind));
        assert!((share-0.75).abs()<1e-12);
        let loaded=2.0*rating;
        assert!((chassis.gear_limit-rating/share).abs()<1e-9*rating);
        assert!(loaded>chassis.gear_limit);
        assert!(loaded*share>=1.125*rating,"full total mass conservatively covers the lighter partial fill");
    }
    /// The points of a chassis as written: `(x, y, gap)`.
    fn line(model:&str,points:&[(i64,i64,bool)])->Value {
        json!({"model":model,"points":points.iter().map(|&(x,y,gap)|if gap {json!({"x":x,"y":y,"gap":true})} else {json!({"x":x,"y":y})}).collect::<Vec<_>>()})
    }
    /// A hull of 8 mm steel whose floor runs through `floor` (in cells), from the front, with a rear, a roof 1.5 m up
    /// and a front, and a command post high in it, on `chassis`, where its model hangs its gear.
    fn hull_on(chassis:Value,floor:&[(i64,i64)])->Value {
        let n=floor.len();let (front,rear)=(floor[0].0,floor[n-1].0);
        let corners:Vec<(i64,i64)>=floor.iter().copied().chain([(rear,30),(front,30)]).collect();
        let nodes:Vec<Value>=corners.iter().enumerate().map(|(i,&(x,y))|json!({"id":format!("hull-{i}"),"x":x,"y":y})).collect();
        let plates:Vec<Value>=(0..corners.len()).map(|i|json!({"id":if i+1<n {format!("hull:floor-{i}")} else {format!("hull:side-{i}")},
            "a":format!("hull-{i}"),"b":format!("hull-{}",(i+1)%corners.len()),"material":"steel","thicknessMm":8})).collect();
        seated(&json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":chassis,"nodes":nodes,"plates":plates,
            "components":[{"id":"command","kind":"command","pose":{"x":0,"y":20,"angle":0.0}}]}),full_catalogue())
    }
    fn ids(result:&Value)->Vec<String> {
        result["compiled"]["plates"].as_array().unwrap().iter().filter(|p|p.get("chassis").is_some()).map(|p|p["id"].as_str().unwrap().to_owned()).collect()
    }
    #[test]
    fn the_points_of_a_chassis_are_refused_by_name_as_the_workshop_refuses_them() {
        let level=|xs:&[i64]|xs.iter().map(|&x|(x,0,false)).collect::<Vec<_>>();
        let code=|chassis:Value|refused(chassis)["code"].as_str().unwrap().to_owned();
        let one=refused(line("wheeled",&[(-60,0,false)]));
        assert_eq!((&one["code"],&one["value"],&one["range"],&one["model"]),(&json!("CHASSIS_POINTS"),&json!(1),&json!([2,16]),&json!("wheeled")));
        assert_eq!(code(line("wheeled",&level(&(0..17).map(|i|-80+10*i).collect::<Vec<_>>()))),"CHASSIS_POINTS");
        let close=refused(line("wheeled",&level(&[-60,0,1,60])));
        assert_eq!((&close["code"],&close["index"]),(&json!("CHASSIS_ORDER"),&json!(2)));
        assert!(compile(&boxed(line("wheeled",&level(&[-60,0,2,60]))),full_catalogue()).is_ok(),"ten centimetres apart is enough");
        let steep=refused(line("wheeled",&[(-60,0,false),(-40,0,false),(-30,12,false),(60,12,false)]));
        assert_eq!((&steep["code"],&steep["index"],&steep["range"]),(&json!("CHASSIS_SLOPE"),&json!(1),&json!([0.0,45.0])));
        assert!((number(&steep,"value")-(0.6f64/0.5).atan().to_degrees()).abs()<1e-9);
        for (points,index) in [(vec![(-60,0,true),(0,0,false),(60,0,false)],0),(vec![(-60,0,false),(0,0,true),(60,0,false)],1),
            (vec![(-60,0,false),(0,0,false),(60,0,true)],2),
            (vec![(-60,0,false),(-20,0,true),(0,0,true),(20,0,false),(60,0,false)],2)] {
            let error=refused(line("wheeled",&points));
            assert_eq!((&error["code"],&error["index"]),(&json!("CHASSIS_GAP"),&json!(index)),"{points:?}");
        }
        for (point,code,key) in [(json!({"x":60,"y":super::super::FLOOR-2}),"AUTHORING_EXTENT","y"),
            (json!({"x":60,"y":super::super::FLOOR+super::super::HEIGHT+2}),"AUTHORING_EXTENT","y"),
            (json!({"x":122,"y":0}),"FIELD","x"),(json!({"x":60,"y":0,"gap":1}),"FIELD","gap"),
            (json!({"x":60,"y":"0.5"}),"FIELD","y"),(json!({"x":120.25,"y":0}),"FIELD","x")] {
            let mut chassis=line("wheeled",&level(&[-60]));chassis["points"].as_array_mut().unwrap().push(point.clone());
            let error=refused(chassis);
            assert_eq!((&error["code"],&error["field"],&error["within"],&error["index"]),(&json!(code),&json!(key),&json!("chassis.points"),&json!(1)),"{point}");
        }
        let mut odd=line("wheeled",&level(&[-60,60]));odd["points"][1]["z"]=json!(0);
        assert_eq!(refused(odd)["code"],"AUTHORING_FIELDS");
        let mut ends=boxed(line("wheeled",&level(&[-60,60])));ends["chassis"]=json!({"model":"wheeled","front":-60,"rear":60});
        assert_eq!(compile(&ends,full_catalogue()).unwrap_err()["code"],"AUTHORING_FIELDS");
        // A gap that is not one is not written back.
        let mut plain=line("wheeled",&level(&[-60,60]));plain["points"][0]["gap"]=json!(false);
        assert_eq!(compiled(plain)["construction"]["chassis"]["points"],boxed(line("wheeled",&level(&[-60,60])))["chassis"]["points"]);
    }
    #[test]
    fn a_profile_stands_anywhere_in_the_box_up_to_eight_metres_from_the_floor_and_hangs_no_lower_than_it() {
        let (floor,top)=(super::super::FLOOR,super::super::FLOOR+super::super::HEIGHT);
        // Its lowest stretch as low as the larger wheels let it, on the cell above.
        let high=|y:i64|{let mut source=line("wheeled",&[(-120,y,false),(40,5,false),(120,5,false)]);
            source["axles"]=json!([58,102]);source["gearScale"]=json!(1.5);bare(source)};
        let chassis=super::Chassis::read(&high(top),full_catalogue()).unwrap().unwrap();
        assert!((chassis.points[0].y-metres(top)).abs()<1e-12,"its height is told from the floor, not from its own lowest point");
        let error=super::Chassis::read(&high(top+1),full_catalogue()).err().unwrap();
        assert_eq!((&error["code"],&error["side"],&error["index"],&error["model"]),(&json!("AUTHORING_EXTENT"),&json!("above"),&json!(0),&json!("wheeled")));
        // Its line may come down to the floor only as far as what hangs under it, its rails, stands on the floor too.
        let low=|y:i64|super::Chassis::read(&bare(line("wheeled",&[(-60,y,false),(60,y,false)])),full_catalogue());
        let depth=low(0).unwrap().unwrap().depth();
        // The lowest cell whose rails stand on the floor or above it.
        let lowest=((metres(floor)+depth)/CELL-1e-9).ceil() as i64;
        assert!(low(lowest).is_ok());
        let error=low(lowest-1).err().unwrap();
        assert_eq!((&error["code"],&error["side"],&error["model"]),(&json!("AUTHORING_EXTENT"),&json!("below"),&json!("wheeled")));
        // Read, it stands anywhere in the box; built, its gear stands on the floor, and its suspension reaches only so far.
        let error=compile(&bare(line("wheeled",&[(-60,40,false),(60,40,false)])),full_catalogue()).unwrap_err();
        assert_eq!((&error["code"],&error["model"]),(&json!("SUSPENSION_REACH"),&json!("wheeled")));
    }
    #[test]
    fn points_along_the_deck_lay_one_frame_and_rail_for_each_segment_and_carry_as_two() {
        let two=compiled(line("wheeled",&[(-60,0,false),(60,0,false)]));
        let three=compiled(line("wheeled",&[(-60,0,false),(10,0,false),(60,0,false)]));
        assert_eq!(ids(&two),["chassis:frame-0","chassis:rail-0"]);
        assert_eq!(ids(&three),["chassis:frame-0","chassis:rail-0","chassis:frame-1","chassis:rail-1"]);
        let (a,b)=(&two["compiled"]["chassis"],&three["compiled"]["chassis"]);
        for key in ["frameLimitKg","gearLimitKg","limitKg","deck","depth","length"] {
            assert!((number(a,key)-number(b,key)).abs()<1e-9*number(a,key).abs().max(1.0),"{key}");
        }
        assert!((number(a,"frameKg")-number(b,"frameKg")).abs()<1e-6,"points along a straight frame add no steel");
        // Each segment its plates, its bed and its definition; the frame of the first is the chassis.
        let segments=b["segments"].as_array().unwrap();
        assert_eq!(segments.len(),2);
        assert_eq!(segments[1]["plates"],json!(["chassis:frame-1","chassis:rail-1"]));
        assert!(segments.iter().all(|s|s["gap"]==false && s["low"]==true));
        assert_eq!(b["beds"].as_array().unwrap().iter().map(|bed|bed["id"].clone()).collect::<Vec<_>>(),[json!("chassis:frame-0"),json!("chassis:frame-1")]);
        assert_eq!(three["compiled"]["beds"],b["beds"]);
        assert_eq!(three["compiled"]["vehicle"]["chassisId"],"chassis:frame-0");
        let first=&plate(&three,"chassis:frame-0")["chassis"];let other=&plate(&three,"chassis:frame-1")["chassis"];
        assert_eq!((&first["segment"],&other["segment"],&other["part"]),(&json!(0),&json!(1),&json!("frame")));
        assert!(first.get("credits").is_some() && other.get("credits").is_none() && other.get("profile").is_none());
        assert_eq!(first["profile"],json!([{"x":0.0,"y":0.0},{"x":3.5,"y":0.0},{"x":6.0,"y":0.0}]));
        assert_eq!(number(first,"length"),6.0);
        // The straight chassis is told with one outline and one bed, and no other.
        assert_eq!((a["outlines"].as_array().unwrap().len(),a["beds"].as_array().unwrap().len()),(1,1));
        assert!(a.get("outline").is_none() && a.get("bed").is_none());
        let depth=number(a,"depth");
        let outlines=plate(&two,"chassis:frame-0")["chassis"]["outlines"].as_array().unwrap();
        assert_eq!((outlines.len(),outlines[0].as_array().unwrap().len()),(1,4));
        for (p,(x,y)) in outlines[0].as_array().unwrap().iter().zip([(0.0,0.0),(6.0,0.0),(6.0,-depth),(0.0,-depth)]) {
            assert!((number(p,"x")-x).abs()<1e-12 && (number(p,"y")-y).abs()<1e-12,"{p}");
        }
        assert_eq!(number(&a["points"][0],"x"),number(a,"front"));
        // The wheels are carried by the rail of the segment their axle is in.
        let wheels=gear(&three);
        assert_eq!(wheels.iter().map(|w|w["mountId"].as_str().unwrap()).collect::<Vec<_>>(),["chassis:rail-0","chassis:rail-1"]);
        assert_eq!(compile(&three["construction"],full_catalogue()).unwrap(),three);
    }
    #[test]
    fn a_gap_omits_physical_rails_without_requiring_a_floor_on_each_part() {
        let source=line("wheeled",&[(-60,0,false),(-20,0,true),(20,0,false),(60,0,false)]);
        let input=hull_on(source,&[(20,2),(60,2)]);
        let result=draft(&input);
        assert_eq!(ids(&result),["chassis:frame-0","chassis:rail-0","chassis:frame-2","chassis:rail-2"]);
        let chassis=&result["compiled"]["chassis"];
        assert_eq!(chassis["outlines"].as_array().unwrap().len(),2);
        assert_eq!(chassis["segments"][1]["plates"],json!([]));
        assert_eq!(chassis["segments"][1]["gap"],true);
        // Geometry is editable, but a missing structural bridge still has zero manufacturing capacity.
        assert_eq!(chassis["frameLimitKg"],0.0);
        assert_eq!(chassis["limitKg"],0.0);
        assert!(result["compiled"]["admissionIssues"].as_array().unwrap().iter().any(|issue|issue["code"]=="CHASSIS_GAP_OPEN"));
        assert_eq!(compile(&input,full_catalogue()).unwrap_err()["code"],"CHASSIS_GAP_OPEN");
    }

    #[test]
    fn wheels_remain_level_under_arches_and_between_profile_knuckles() {
        let hump=[(-60,0,false),(-30,0,false),(-20,8,false),(20,8,false),(30,0,false),(60,0,false)];
        for axles in [json!([-44,0]),json!([-29,44]),json!([-32,44])] {
            let mut chassis=line("wheeled",&hump);chassis["axles"]=axles.clone();
            let floor=hump.map(|(x,y,_)|(x,y));
            let result=draft(&hull_on(chassis,&floor));
            let wheels=gear(&result);
            assert_eq!(wheels.len(),2);
            for (wheel,x) in wheels.iter().zip(axles.as_array().unwrap()) {
                assert_eq!(number(wheel,"x"),12.0+metres(x.as_i64().unwrap()));
                assert!((number(wheel,"y")-number(wheel,"height")/2.0-0.01).abs()<1e-12);
                assert_eq!(wheel["angle"],0.0);
            }
            let capacity=&result["compiled"]["chassis"];
            assert_eq!(number(capacity,"limitKg"),number(capacity,"frameLimitKg").min(number(capacity,"gearLimitKg")));
            // The hump over an axle stands further over its line than the suspension reaches, and does not count.
            assert_eq!(number(capacity,"suspension"),0.0);
        }
        // Authoring a floating hull or an overhang does not extend or relocate the chassis.
        let mut floating=boxed(line("wheeled",&[(-40,0,false),(40,0,false)]));
        for node in floating["nodes"].as_array_mut().unwrap() {node["x"]=json!(whole(node,"x")*3/2);node["y"]=json!(whole(node,"y")+6);}
        let compiled=compile(&floating,full_catalogue()).unwrap();
        assert_eq!(compiled["construction"]["chassis"],floating["chassis"]);
    }

    #[test]
    fn tracks_remain_level_under_a_sloped_or_raised_profile() {
        let profile=[(-70,6,false),(-50,0,false),(70,0,false)];
        let scale=number(spec("tracked"),"track")/ComponentKind::Track.dimensions().1;
        let width=ComponentKind::track_length(5.0)*scale;
        for track in [None,Some(json!({"front":-70,"rear":(-3.5+width)/CELL,"y":-18})),Some(json!({"front":-50,"rear":(-2.5+width)/CELL,"y":-18}))] {
            let mut source=line("tracked",&profile);if let Some(track)=track {source["track"]=track;}
            let floor=profile.map(|(x,y,_)|(x,y));
            let result=draft(&hull_on(source,&floor));let gear=gear(&result);
            assert_eq!(gear.len(),1);
            assert!((number(&gear[0],"y")-number(&gear[0],"height")/2.0-0.01).abs()<1e-12);
            assert_eq!(gear[0]["angle"],0.0);
        }
    }

    #[test]
    fn a_tool_has_an_explicit_pose_independent_of_chassis_gaps() {
        let chassis=line("wheeled",&[(-60,0,false),(-20,0,true),(20,0,false),(60,0,false)]);
        let mut input=hull_on(chassis,&[(-60,2),(60,2)]);
        input["components"].as_array_mut().unwrap().push(json!({"id":"blade","kind":"blade","pose":{"x":0,"y":-8,"angle":0.0}}));
        let result=draft(&input);
        let blade=result["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["id"]=="blade").unwrap();
        assert_eq!(blade["x"],12.0);assert!((number(blade,"y")-0.9).abs()<1e-12);
        assert_eq!(result["construction"]["components"][1]["pose"],input["components"][1]["pose"]);
    }

    /// Two boxes of 8 mm steel, one on each part of a chassis of six metres with a gap of two in the middle, its frame
    /// 20 mm thick, and only two plates across the gap, `apart` cells one over the other: the lower `low` (material,
    /// millimetres), the upper `high`.
    fn bridged(low:(&str,f64),high:(&str,f64),apart:i64)->Value {
        let nodes=[("a0",-60,0),("a1",-20,0),("a2",-20,apart),("a3",-20,24),("a4",-60,24),
            ("b0",20,0),("b1",60,0),("b2",60,24),("b3",20,24),("b4",20,apart)]
            .map(|(id,x,y)|json!({"id":id,"x":x,"y":y}));
        let steel=|id:&str,a:&str,b:&str|json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":8});
        let mut plates:Vec<Value>=[("a:floor","a0","a1"),("a:low","a1","a2"),("a:side","a2","a3"),("a:roof","a3","a4"),("a:front","a4","a0"),
            ("b:floor","b0","b1"),("b:rear","b1","b2"),("b:roof","b2","b3"),("b:side","b3","b4"),("b:low","b4","b0")]
            .iter().map(|&(id,a,b)|steel(id,a,b)).collect();
        plates.push(json!({"id":"bridge:low","a":"a1","b":"b0","material":low.0,"thicknessMm":low.1}));
        plates.push(json!({"id":"bridge:high","a":"a2","b":"b4","material":high.0,"thicknessMm":high.1}));
        let mut chassis=line("wheeled",&[(-60,0,false),(-20,0,true),(20,0,false),(60,0,false)]);
        chassis["thicknessMm"]=json!(20.0);
        seated(&json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":chassis,"nodes":nodes,"plates":plates,
            "components":[{"id":"command","kind":"command","pose":{"x":-40,"y":12,"angle":0.0}}]}),full_catalogue())
    }
    fn draft(input:&Value)->Value {super::super::compile_mode(input,full_catalogue(),true).unwrap_or_else(|e|panic!("{e}"))}
    #[test]
    fn over_a_gap_the_plates_of_the_hull_that_cross_it_are_the_beam_as_reckoned_by_hand() {
        use crate::game_flight::GRAVITY;
        // Steel: E 200 GPa, yield 285 MPa; a flange 2.4 m wide and 8 mm thick: A 0.0192 m², I₀ 1.024e-7 m⁴.
        let (e,area,own)=(200e9,2.4*0.008,2.4*0.008f64.powi(3)/12.0);
        // Axles at -2.2 and 2.2: the gap lies in the 4.4 m between them, where L/200 governs (`structure`).
        let (span,stiffness)=(4.4f64,384.0/(5.0*200.0*4.4f64.powi(3)));
        let limit=|bending:f64|stiffness*bending*6.0/(GRAVITY*2.0);
        let near=|actual:f64,expected:f64|assert!((actual-expected).abs()<1e-9*expected,"{actual} / {expected}");
        // Two steel flanges 10 cm apart, about the line halfway: I = 2·(I₀ + A·0.05²) = 9.62048e-5 m⁴, EI 1.924096e7 N·m²,
        // which bends more than the rails; M = 285e6·EI/(E·(0.05+0.004)) = 5.08e5 N·m.
        let close=draft(&bridged(("steel",8.0),("steel",8.0),2));let chassis=&close["compiled"]["chassis"];
        let bending=e*2.0*(own+area*0.05f64.powi(2));
        near(bending,1.924096e7);
        let rails=(285e6*number(chassis,"secondMomentM4")/(number(chassis,"depth")/2.0),e*number(chassis,"secondMomentM4"));
        assert!(bending<rails.1,"the gap is the softer: {rails:?}");
        assert!(8.0*rails.0.min(285e6*bending/(e*0.054))/span.powi(2)>stiffness*bending,"and bends before it yields");
        near(number(chassis,"frameLimitKg"),limit(bending));
        let whole=draft(&{let mut whole=bridged(("steel",8.0),("steel",8.0),2);whole["chassis"]["points"][1].as_object_mut().unwrap().remove("gap");whole});
        assert!(number(chassis,"frameLimitKg")<number(&whole["compiled"]["chassis"],"frameLimitKg"));
        // Wide apart, the rails govern again: the frame carries what it carries without its gap.
        let apart=draft(&bridged(("steel",8.0),("steel",8.0),12));
        near(number(&apart["compiled"]["chassis"],"frameLimitKg"),number(&whole["compiled"]["chassis"],"frameLimitKg"));
        // Of two materials, about the line their stiffness weighs: steel low, aluminium (E 70 GPa) 10 cm over it.
        let mixed=draft(&bridged(("steel",8.0),("aluminum",8.0),2));
        let neutral:f64=0.1*70.0/270.0;
        let bending=e*(own+area*neutral.powi(2))+70e9*(own+area*(0.1-neutral).powi(2));
        near(bending,9.983203555555556e6);
        near(number(&mixed["compiled"]["chassis"],"frameLimitKg"),limit(bending));
        // Glass carries nothing: the steel left alone bears next to nothing, and the overload is told by its gap.
        let glazed=bridged(("steel",8.0),("glass",15.0),2);
        near(number(&draft(&glazed)["compiled"]["chassis"],"frameLimitKg"),limit(e*own));
        let error=compile(&glazed,full_catalogue()).unwrap_err();
        assert_eq!((&error["code"],&error["gap"]),(&json!("CHASSIS_OVERLOAD"),&json!(1)),"{error}");
        // With nothing that carries across it, the gap leaves the chassis in two loose pieces.
        let error=compile(&bridged(("glass",15.0),("ceramic",8.0),2),full_catalogue()).unwrap_err();
        assert_eq!(error,json!({"code":"CHASSIS_GAP_OPEN","index":1,"from":-1.0,"to":1.0}));
        // Where the rails govern no gap is told.
        assert!(compile(&bridged(("steel",8.0),("steel",8.0),12),full_catalogue()).is_ok());
    }
    #[test]
    fn a_stable_profile_produces_real_geometry_and_has_its_nose_at_the_front() {
        for model in ["wheeled","tracked"] {
            let source=json!({"model":model,"points":[{"x":-60,"y":-5},{"x":60,"y":-5}]});
            let plain=compiled(source.clone());
            let deck=number(&plain["compiled"]["chassis"],"deck");
            let frame=plate(&plain,"chassis:frame-0");
            assert!((number(frame,"y")+number(frame,"thicknessMm")/2000.0-deck).abs()<1e-12);
            assert_eq!(plain["compiled"]["chassis"]["points"][0],json!({"x":9.0,"y":deck}));
            assert!(plain["compiled"]["chassis"].get("mirrored").is_none() && gear(&plain).iter().all(|piece|piece.get("mirrored").is_none()));
            if model=="tracked" {
                // The nose closes the tub ahead, at the front of the design; the track runs from its front.
                assert!(number(plate(&plain,"chassis:nose"),"x")<12.0);
                assert!((number(&plain["compiled"]["chassis"]["track"],"front")-9.0).abs()<1e-12);
                let mut placed=source.clone();placed["track"]=json!({"front":-46,"rear":60,"y":-18});
                let explicit=compiled(placed.clone());assert_eq!(explicit["construction"]["chassis"]["track"],placed["track"]);
                assert!((number(&gear(&explicit)[0],"width")-5.3).abs()<1e-12,"literal markers are the physical ends");
                let mut outside=source.clone();outside["track"]=json!({"front":-60.02,"rear":60,"y":-18});
                assert_eq!(refused(outside)["code"],"TRACK_EXTENT","a literal physical end must still fit");
            }
            assert_eq!(compile(&plain["construction"],full_catalogue()).unwrap(),plain);
            // A chassis is never written turned about: its front is its first point, and the key is none of its own.
            for turned in [json!(true),json!(false)] {
                let mut written=source.clone();written["mirrored"]=turned;
                let error=refused(written);
                assert_eq!((&error["code"],&error["within"]),(&json!("AUTHORING_FIELDS"),&json!("chassis")),"{error}");
            }
        }
    }

    #[test]
    fn generated_top_plate_keeps_exact_contact_and_follows_a_fractional_profile_move(){
        let mut chassis=line("wheeled",&[(-60,-8,false),(60,-8,false)]);
        chassis["topPlate"]=json!({"material":"steel","thicknessMm":80});
        let mut authored=seated(&json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":chassis,
            "nodes":[],"plates":[],"components":[]}),full_catalogue());
        let before=draft(&authored);let top=plate(&before,"chassis:top-0");
        let profile_y=1.3+number(&authored["chassis"]["points"][0],"y")/(1.0/CELL);
        assert!((number(top,"y")-0.04-profile_y).abs()<1e-12,"the lower surface rests on the authored profile");
        for point in authored["chassis"]["points"].as_array_mut().unwrap(){point["y"]=json!(number(point,"y")+0.2);}
        let after=draft(&authored);
        assert!((number(plate(&after,"chassis:top-0"),"y")-number(top,"y")-0.01).abs()<1e-12);
        assert!(after["construction"]["plates"].as_array().unwrap().is_empty(),"following remains generated, not frozen authored metal");
        let mut chassis=line("wheeled",&[(-60,-8,false),(0,12,false),(60,-8,false)]);
        chassis["topPlate"]=json!({"material":"steel","thicknessMm":80});
        let authored=seated(&json!({"version":CONSTRUCTION_VERSION,"preset":"vehicle","chassis":chassis,
            "nodes":[],"plates":[],"components":[]}),full_catalogue());
        let sloped=draft(&authored);
        assert!((number(plate(&sloped,"chassis:top-0"),"length")-(10.0_f64.sqrt()+0.04/3.0)).abs()<1e-12,
            "the outward miter extends the sloped 80mm plate instead of rounding its ends to 5cm");
    }

    /// The box on an aircraft six metres long, with `thrusters` on its roof, each `(x, size)` along the design in cells
    /// and upright, or leant by its angle when it says one.
    fn aircraft(thrusters:&[(i64,f64,f64)])->Value {
        let mut source=boxed(json!({"model":"aircraft","points":[{"x":-60,"y":0},{"x":60,"y":0}]}));
        let roof=number(&source["nodes"][2],"y");
        for (i,&(x,size,angle)) in thrusters.iter().enumerate() {
            let half=ComponentKind::Thruster.dimensions().1*size/2.0/super::super::CELL;
            source["components"].as_array_mut().unwrap().push(json!({"id":format!("lift{i}"),"kind":"thruster","metal":"titanium",
                "sizeScale":size,"pose":{"x":x,"y":roof+half+3.0,"angle":angle}}));
        }
        source
    }
    fn issues(result:&Value)->Vec<&str> {
        result["compiled"]["admissionIssues"].as_array().unwrap().iter().map(|issue|issue["code"].as_str().unwrap()).collect()
    }
    #[test]
    fn an_aircraft_stands_on_skids_under_its_rails_and_carries_what_its_thrusters_hold_up() {
        let bare=draft(&aircraft(&[]));
        let ids:Vec<&str>=bare["compiled"]["plates"].as_array().unwrap().iter().filter_map(|p|p["id"].as_str().filter(|id|id.starts_with("chassis:"))).collect();
        assert_eq!(ids,["chassis:frame-0","chassis:rail-0","chassis:skid-0","chassis:leg-0","chassis:leg-1"]);
        assert!(gear(&bare).is_empty(),"no piece of gear: its skids are plates of its frame");
        // The runner lies on the floor, as a tyre does a centimetre over it, and its legs go up from its top to the rails.
        let runner=plate(&bare,"chassis:skid-0");
        assert!((number(runner,"y")-number(runner,"thicknessMm")/2000.0-0.01).abs()<1e-9,"{runner}");
        let rail=plate(&bare,"chassis:rail-0");
        for leg in ["chassis:leg-0","chassis:leg-1"].map(|id|plate(&bare,id)) {
            let (low,high)=(number(leg,"y")-number(leg,"length")/2.0,number(leg,"y")+number(leg,"length")/2.0);
            assert!((low-(number(runner,"y")+number(runner,"thicknessMm")/2000.0)).abs()<1e-9,"{leg}");
            assert!((high-(number(rail,"y")-number(rail,"thicknessMm")/2000.0)).abs()<1e-9,"{leg}");
        }
        let chassis=&bare["compiled"]["chassis"];
        assert_eq!((chassis["model"].as_str(),chassis["limitKg"].as_f64()),(Some("aircraft"),Some(0.0)),"no thruster holds it up");
        assert_eq!(issues(&bare),["AIRCRAFT_LIFT"]);
        assert!(super::super::compile(&aircraft(&[]),full_catalogue()).is_err_and(|e|e["code"]=="AIRCRAFT_LIFT"));
        // Two of the reference thruster at one and a half times its size, either side of its middle, lift it with a
        // quarter to spare: the 52.5 kN of each, 1.5² times the 23.35 kN of the reference one, over 1.25 g.
        let lifted=draft(&aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]));
        let limit=lifted["compiled"]["chassis"]["limitKg"].as_f64().unwrap();
        assert!((limit-2.0*23_350.0*1.5f64.powi(2)/(9.81*1.25)).abs()<1.0,"{limit}");
        assert!(issues(&lifted).is_empty() && lifted["compiled"]["flight"]["lifts"]==true && lifted["compiled"]["flight"]["balanced"]==true);
        // Leant, a thruster lifts by as much as it points up.
        let leant=draft(&aircraft(&[(-30,1.5,std::f64::consts::FRAC_PI_4),(30,1.5,-std::f64::consts::FRAC_PI_4)]))["compiled"]["chassis"]["limitKg"].as_f64().unwrap();
        assert!((leant-limit*std::f64::consts::FRAC_PI_4.cos()).abs()<1.0,"{leant}");
        // Both on one side of its centre of mass, they lift it but cannot hold it level.
        assert_eq!(issues(&draft(&aircraft(&[(30,1.5,0.0),(55,1.5,0.0)]))),["AIRCRAFT_BALANCE"]);
    }
    #[test]
    fn skids_take_no_gear_and_reach_the_floor_from_wherever_the_frame_stands_over_it() {
        for key in ["axles","track"] {
            let mut written=json!({"model":"aircraft","points":[{"x":-60,"y":0},{"x":60,"y":0}]});
            written[key]=if key=="axles" {json!([-20,20])} else {json!({"front":-40,"rear":40,"y":0})};
            assert_eq!(refused(written)["code"],"CHASSIS_GEAR_KIND","{key}");
        }
        // Nor do wheels or a track stand on skids.
        for model in ["wheeled","tracked"] {
            let written=json!({"model":model,"points":[{"x":-60,"y":0},{"x":60,"y":0}],"skids":{"front":-50,"rear":50,"legs":[-30,30]}});
            assert_eq!(refused(written)["code"],"CHASSIS_GEAR_KIND","{model}");
        }
        // Raised a metre, its legs are a metre longer; lowered until they would be shorter than 15 cm, it is refused.
        let seated=aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]);
        let leg=|source:&Value|number(plate(&draft(source),"chassis:leg-0"),"length");
        assert!((leg(&moved(&seated,20.0))-leg(&seated)-1.0).abs()<1e-9);
        let shortest=((leg(&seated)-0.15)/super::super::CELL).floor()+1.0;
        let error=super::super::compile_mode(&moved(&seated,-shortest),full_catalogue(),true).unwrap_err();
        assert_eq!((error["code"].as_str(),error["least"].as_f64()),(Some("SKID_HEIGHT"),Some(0.15)),"{error}");
        // A strut under a gap has no rail to hang from.
        let mut gapped=seated.clone();
        gapped["chassis"]["points"]=json!([{"x":-60,"y":0},{"x":-50,"y":0,"gap":true},{"x":-20,"y":0},{"x":60,"y":0}]);
        let gapped=seated_points(&seated,gapped);
        assert_eq!(super::super::compile_mode(&gapped,full_catalogue(),true).unwrap_err()["code"],"SKID_GAP");
    }
    /// The whole of `source` `dy` cells higher: the points of its chassis, its nodes and its components.
    fn moved(source:&Value,dy:f64)->Value {
        let mut source=source.clone();
        for point in source["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(number(point,"y")+dy);}
        for node in source["nodes"].as_array_mut().unwrap() {node["y"]=json!(number(node,"y")+dy);}
        for part in source["components"].as_array_mut().unwrap() {part["pose"]["y"]=json!(number(&part["pose"],"y")+dy);}
        source
    }
    /// `changed` with the points of its chassis as high as those of `seated` stand.
    fn seated_points(seated:&Value,mut changed:Value)->Value {
        let y=number(&seated["chassis"]["points"][0],"y");
        for point in changed["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(y);}
        changed
    }
    /// What the frame plate of a chassis tells of its skids (`describe`): from its front end, over its deck.
    fn skids_of(result:&Value)->&Value {&plate(result,"chassis:frame-0")["chassis"]["skids"]}
    #[test]
    fn skids_are_as_large_as_the_gear_and_weigh_what_their_tubes_do() {
        // The smallest aircraft, two and a half metres long, on skids half, once and one and a half times the model's size.
        let small=|scale:f64|{
            let mut written=json!({"model":"aircraft","points":[{"x":-25,"y":0},{"x":25,"y":0}]});
            if scale!=1.0 {written["gearScale"]=json!(scale);}
            draft(&boxed(written))
        };
        let [slim,model,large]=[0.5,1.0,1.5].map(small);
        let kg=|result:&Value|number(&result["compiled"]["chassis"],"frameKg");
        for (result,scale) in [(&slim,0.5),(&model,1.0),(&large,1.5)] {
            let skids=skids_of(result);
            // The runner is as thick as the gear is large, lying a centimetre over the floor, its top as high over it as
            // that; the rails are those of the frame, as deep whatever its skids.
            assert!((number(skids,"tube")-0.08*scale).abs()<1e-12,"{skids}");
            let deck=number(&result["compiled"]["chassis"],"deck");
            assert!((number(skids,"y")+deck-(0.01+0.04*scale)).abs()<1e-9,"{skids} {deck}");
            assert_eq!(number(&result["compiled"]["chassis"],"depth"),number(&model["compiled"]["chassis"],"depth"));
            for leg in skids["legs"].as_array().unwrap() {assert!(number(leg,"top")-number(leg,"foot")>=0.15-1e-9,"{leg}");}
            // Written back as it is written, and none at the size of the model.
            assert_eq!(result["construction"]["chassis"].get("gearScale").and_then(Value::as_f64),(scale!=1.0).then_some(scale));
        }
        // Slimmer tubes weigh less, of the same metal, and larger ones more.
        assert!(kg(&slim)<kg(&model) && kg(&model)<kg(&large),"{} {} {}",kg(&slim),kg(&model),kg(&large));
        assert_eq!(refused(json!({"model":"aircraft","points":[{"x":-25,"y":0},{"x":25,"y":0}],"gearScale":0.4}))["field"],"gearScale");
    }
    #[test]
    fn skids_stand_where_they_are_written_on_their_runner_under_the_frame() {
        let seated=aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]);
        let with=|skids:Value|{let mut source=seated.clone();source["chassis"]["skids"]=skids;source};
        // Nothing written, the model puts the runner 30 cm in from the front of the frame and 10 cm from its rear, and
        // its legs 80 cm from either end.
        let plain=skids_of(&draft(&seated)).clone();
        let near=|a:f64,b:f64|(a-b).abs()<1e-9;
        assert!(near(number(&plain,"front"),0.3) && near(number(&plain,"rear"),5.9),"{plain}");
        assert!(near(number(&plain["legs"][0],"x"),0.8) && near(number(&plain["legs"][1],"x"),5.2),"{plain}");
        // Written, from 20 cm behind the front of the frame to half a metre ahead of its rear, the legs a metre and a half
        // either side of the middle, out of order: they stand there, told from the front, and come back as written.
        let placed=draft(&with(json!({"front":-56,"rear":50,"legs":[30,-30]})));
        let skids=skids_of(&placed);
        assert!(near(number(skids,"front"),0.2) && near(number(skids,"rear"),5.5),"{skids}");
        assert!(near(number(&skids["legs"][0],"x"),1.5) && near(number(&skids["legs"][1],"x"),4.5),"{skids}");
        assert_eq!(placed["construction"]["chassis"]["skids"],json!({"front":-56,"rear":50,"legs":[-30,30]}));
        // Where the model would put them, written skids stay written; between two cells, as they are written.
        let written=json!({"front":-54,"rear":58,"legs":[-44,44]});
        assert_eq!(draft(&with(written.clone()))["construction"]["chassis"]["skids"],written);
        let again=skids_of(&draft(&with(written))).clone();
        for key in ["front","rear","y"] {assert!(near(number(&again,key),number(&plain,key)),"{key}: {again} {plain}");}
        for (a,b) in again["legs"].as_array().unwrap().iter().zip(plain["legs"].as_array().unwrap()) {
            for key in ["x","top","foot"] {assert!(near(number(a,key),number(b,key)),"{key}: {a} {b}");}
        }
        let fine=draft(&with(json!({"front":-54.5,"rear":58,"legs":[-44.25,44]})));
        assert!(near(number(skids_of(&fine),"front"),0.275) && near(number(&skids_of(&fine)["legs"][0],"x"),0.7875));
        // The runner stays under the frame.
        for skids in [json!({"front":-61,"rear":50,"legs":[-30,30]}),json!({"front":-50,"rear":61,"legs":[-30,30]})] {
            assert_eq!(refused(with(skids.clone())["chassis"].clone())["code"],"SKID_EXTENT","{skids}");
        }
        // A leg stands on the runner 20 cm or more from either end of it, as large as the model's skids are, and further
        // in on larger ones.
        let error=refused(with(json!({"front":-50,"rear":50,"legs":[-47,30]}))["chassis"].clone());
        assert_eq!((error["code"].as_str(),error["index"].as_u64(),error["least"].as_f64()),(Some("SKID_RUNNER"),Some(0),Some(0.2)),"{error}");
        let error=refused(with(json!({"front":-50,"rear":50,"legs":[-30,47]}))["chassis"].clone());
        assert_eq!((error["code"].as_str(),error["index"].as_u64()),(Some("SKID_RUNNER"),Some(1)),"{error}");
        assert!(draft(&with(json!({"front":-50,"rear":50,"legs":[-46,46]}))).is_object());
        let mut larger=with(json!({"front":-50,"rear":50,"legs":[-46,46]}));larger["chassis"]["gearScale"]=json!(1.5);
        let error=refused(larger["chassis"].clone());
        assert_eq!((error["code"].as_str(),error["least"].as_f64()),(Some("SKID_RUNNER"),Some(0.2*1.5)),"{error}");
        // The two legs stand half a metre apart or more.
        let error=refused(with(json!({"front":-50,"rear":50,"legs":[-4,5]}))["chassis"].clone());
        assert_eq!((error["code"].as_str(),error["least"].as_f64()),(Some("SKID_SPACING"),Some(0.5)),"{error}");
        assert!(draft(&with(json!({"front":-50,"rear":50,"legs":[-5,5]}))).is_object());
        // A leg written under a gap of the frame has no rail to hang from; one clear of it has.
        let mut gapped=with(json!({"front":-60,"rear":56,"legs":[-55,40]}));
        gapped["chassis"]["points"]=json!([{"x":-60,"y":0},{"x":-50,"y":0,"gap":true},{"x":-20,"y":0},{"x":60,"y":0}]);
        let gapped=seated_points(&seated,gapped);
        let mut under=gapped.clone();under["chassis"]["skids"]["legs"]=json!([-40,40]);
        let error=super::super::compile_mode(&under,full_catalogue(),true).unwrap_err();
        assert_eq!((error["code"].as_str(),error["index"].as_u64()),(Some("SKID_GAP"),Some(0)),"{error}");
        assert!(super::super::compile_mode(&gapped,full_catalogue(),true).is_ok());
        // What is written of them is two legs, numbers within the construction box, and the ends of the runner.
        for (skids,field) in [(json!({"front":-50,"rear":50,"legs":[0]}),"legs"),(json!({"front":-50,"rear":50,"legs":[-30,"a"]}),"legs"),
            (json!({"front":-50,"legs":[-30,30]}),"rear"),(json!({"front":-50,"rear":50,"legs":[-30,30],"y":0}),"")] {
            let error=refused(with(skids.clone())["chassis"].clone());
            if field.is_empty() {assert_eq!(error["code"],"AUTHORING_FIELDS","{error}");continue;}
            assert_eq!((error["code"].as_str(),error["field"].as_str(),error["within"].as_str()),(Some("FIELD"),Some(field),Some("chassis.skids")),"{error}");
        }
    }
    #[test]
    fn an_aircraft_balances_over_the_runner_of_its_skids_where_it_is_written() {
        // Its weight about the middle of its frame, it stands on a runner under it, and tips forward off one that begins
        // behind it.
        let seated=aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]);
        let issues_of=|skids:Value|{let mut source=seated.clone();source["chassis"]["skids"]=skids;
            draft(&source)["compiled"]["admissionIssues"].as_array().unwrap().clone()};
        assert!(issues_of(json!({"front":-50,"rear":50,"legs":[-30,30]})).is_empty());
        let tipped=issues_of(json!({"front":10,"rear":60,"legs":[20,50]}));
        assert_eq!((tipped[0]["code"].as_str(),tipped[0]["direction"].as_str()),(Some("CHASSIS_BALANCE"),Some("front")),"{tipped:?}");
        let tipped=issues_of(json!({"front":-60,"rear":-10,"legs":[-50,-20]}));
        assert_eq!((tipped[0]["code"].as_str(),tipped[0]["direction"].as_str()),(Some("CHASSIS_BALANCE"),Some("rear")),"{tipped:?}");
    }
    #[test]
    fn a_gun_under_an_aircraft_stays_over_its_skids_however_it_turns() {
        // On skids a metre and a half taller than its model's, the most the Oficina stands it (`src/chassis.js`
        // `SKID_RISE`), a gun under the middle of its hull, `under` cells under its deck, its bore pointed down, or 45° down
        // and ahead, and turning either way from there.
        let mut raised=aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]);
        for point in raised["chassis"]["points"].as_array_mut().unwrap() {point["y"]=json!(number(point,"y")+30.0);}
        for node in raised["nodes"].as_array_mut().unwrap() {node["y"]=json!(number(node,"y")+30.0);}
        for part in raised["components"].as_array_mut().unwrap() {part["pose"]["y"]=json!(number(&part["pose"],"y")+30.0);}
        let deck=number(&raised["chassis"]["points"][0],"y");
        let gunned=|preset:&str,mount:&str,under:f64,angle:f64,turn:f64|{
            let mut source=raised.clone();
            source["components"].as_array_mut().unwrap().push(json!({"id":"gun","kind":"weapon","weaponPreset":preset,
                "pose":{"x":0,"y":deck-under,"angle":angle},"mount":{"preset":mount,"sector":{"min":-turn,"max":turn}}}));
            source
        };
        // Its front is at the smaller x of the design: 45° down and ahead is 135° down from the larger.
        let (down,quarter)=(-std::f64::consts::FRAC_PI_2,std::f64::consts::FRAC_PI_4);
        let ahead=-3.0*quarter;
        // A machine gun on a pintle hangs on its post from the rail over it, held there: the runner far under it holds
        // no post.
        for (angle,turn) in [(down,0.0),(ahead,0.0),(ahead,quarter)] {
            let made=super::super::request(&json!({"version":1,"construction":gunned("m2hb","pintle",22.0,angle,turn),
                "catalogue":full_catalogue(),"draft":true,"manufacture":{}})).unwrap();
            let gun=made["compiled"]["modules"].as_array().unwrap().iter().find(|m|m["id"]=="gun").unwrap();
            assert_eq!(gun["weaponMount"]["hostId"],"chassis:rail-0","{angle}");
            assert!(!made["compiled"]["admissionIssues"].as_array().unwrap().iter()
                .any(|issue|issue["code"]=="PHYSICAL_SUPPORT"&&issue["ids"].as_array().unwrap().contains(&json!("gun"))),"{angle}: {}",made["compiled"]["admissionIssues"]);
            assert!(number(gun,"y")>number(plate(&made,"chassis:skid-0"),"y"),"{gun}");
        }
        // Lower, its muzzle would pass through their runner pointed down, or turned down from 45°.
        for source in [gunned("m2hb","pintle",32.0,down,0.0),gunned("m2hb","pintle",32.0,ahead,quarter)] {
            let error=super::super::compile_mode(&source,full_catalogue(),true).unwrap_err();
            assert_eq!((error["code"].as_str(),&error["ids"],&error["gun"]),(Some("AIRCRAFT_CLEARANCE"),&json!(["gun"]),&json!(true)),"{error}");
        }
        // Nor does a plate written on it hang as low, past the end of its frame: a cell over the floor of the design, the
        // top of the runner a little higher.
        let mut finned=raised.clone();
        for (id,x) in [("fin-a",-75),("fin-b",-65)] {finned["nodes"].as_array_mut().unwrap().push(json!({"id":id,"x":x,"y":-25.0}));}
        finned["plates"].as_array_mut().unwrap().push(json!({"id":"hull:fin","a":"fin-a","b":"fin-b","material":"steel","thicknessMm":8}));
        let error=super::super::compile_mode(&finned,full_catalogue(),true).unwrap_err();
        assert_eq!((error["code"].as_str(),&error["ids"]),(Some("AIRCRAFT_CLEARANCE"),&json!(["hull:fin"])),"{error}");
    }
    #[test]
    fn a_thruster_is_built_on_an_aircraft_alone() {
        let made=|source:&Value|super::super::request(&json!({"version":1,"construction":source,"catalogue":full_catalogue(),"draft":true,"manufacture":{}})).unwrap();
        let mut wheeled=aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]);
        wheeled["chassis"]["model"]=json!("wheeled");
        let wheeled=seated(&wheeled,full_catalogue());
        let refusal=made(&wheeled)["compiled"]["admissionIssues"].as_array().unwrap().iter().find(|issue|issue["code"]=="THRUSTER_CHASSIS").cloned();
        assert_eq!(refusal.map(|issue|issue["ids"].clone()),Some(json!(["lift0","lift1"])));
        assert!(super::super::compile(&wheeled,full_catalogue()).is_ok(),"what is on a field already is compiled as it was");
        let flier=made(&aircraft(&[(-30,1.5,0.0),(30,1.5,0.0)]));
        assert!(flier["compiled"]["admissionIssues"].as_array().unwrap().iter().all(|issue|issue["code"]!="THRUSTER_CHASSIS"));
    }

}
