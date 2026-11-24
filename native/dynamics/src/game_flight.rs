//! One flight model for CCD, sensor instruments and target-point assistance,
//! and the one atmosphere of the world (`air_density`), which everything that
//! flies through it reads: rounds, hulls and the jets of thrusters.
//! The air thins with height and a round keeps one drag coefficient at any
//! speed: the catalogue states, for its own mass and calibre, the coefficient
//! that carries the round fired from sea level as far as the real one goes;
//! from higher ground it goes further. These are sandbox approximations, not
//! firing tables.
use serde::{Deserialize, Serialize};
use crate::game_geometry::{Point, atan2, cos, hypot, sin, sqrt};
use rapier2d_f64::prelude::nalgebra::ComplexField;
use serde_json::{Value, json};
use std::f64::consts::PI;

pub const GRAVITY: f64 = 9.81;
/// The density of the air at the sea level of the world, in kg/m³: that of the standard atmosphere. Sea level is
/// the zero of heights, y = 0: the lowest of a landscape stands 20 m over it (game_terrain.rs `WORLD_FLOOR`) and its
/// highest ground a kilometre or so.
pub const AIR_DENSITY: f64 = 1.225;
/// The height over which the air thins to 1/e of its density, in metres: an exponential atmosphere that keeps 0.56
/// of its density at 5 km, 0.31 at 10 km and 0.095 at 20 km, against 0.60, 0.34 and 0.073 in the standard one.
pub const SCALE_HEIGHT: f64 = 8500.0;
/// How high a jet gives all the thrust it is rated for, in metres over sea level, as a jet that is flat rated holds its
/// thrust up to some height: about as high as the highest ground of a landscape, so that over the ground an aircraft
/// flies as the Oficina passed it, at sea level (game_construction.rs `LIFT_MARGIN`), and higher up it thins out.
pub const RATED_ALTITUDE: f64 = 1000.0;
/// How the thrust of a jet falls over `RATED_ALTITUDE` with the air it breathes: as the density to this power, the lapse
/// of a turbojet below the tropopause. A lift jet that holds its aircraft up 2.5 times over at sea level still holds it
/// up at 12 km.
pub const JET_LAPSE: f64 = 0.7;
/// How many scale heights under sea level the air goes on growing denser, at the most: deeper than that, some 540 km
/// down, it is as dense as there, so that no number overflows. Nothing goes nearly so deep.
const DEEPEST: f64 = 64.0;
pub const MODEL: &str = "quadratic-drag-v2";
/// The density of the air `altitude` metres over the sea level of the world, in kg/m³. Under sea level, where no
/// ground of the world lies but where a forecast may follow a round, it grows denser on as it would (`DEEPEST`).
pub fn air_density(altitude: f64) -> f64 {
    AIR_DENSITY * ComplexField::exp((-altitude / SCALE_HEIGHT).min(DEEPEST))
}
/// The share of the density the air has at `from` that it has at `to`, a short climb or fall away from it, as a round
/// climbs or falls within a step: `air_density(to) / air_density(from)` by the series of its exponential, without
/// another one, good to a ten-millionth of the density for a tenth of `SCALE_HEIGHT`.
pub fn thinning(from: f64, to: f64) -> f64 {
    let x = (to - from) / SCALE_HEIGHT;
    1.0 - x * (1.0 - x * (0.5 - x * (1.0 / 6.0 - x / 24.0)))
}
/// The share of the thrust a jet gives at sea level that it gives `altitude` metres over it: all of it up to
/// `RATED_ALTITUDE`, and over that as the air thins from how dense it is there (`JET_LAPSE`).
pub fn thrust_share(altitude: f64) -> f64 {
    ComplexField::powf(air_density(altitude) / air_density(RATED_ALTITUDE), JET_LAPSE).min(1.0)
}
pub const FLIGHT_SAMPLES: usize = 248;
pub const FIRST_FLIGHT_DT: f64 = 1.0 / 240.0;
pub const FORECAST_DT: f64 = 0.5;
/// How far ahead a forecast follows a round: the steep arc of a heavy howitzer
/// at its top charge is in the air for well over a minute. The round itself
/// flies until it strikes; this is only the reach of the samples above.
pub const FLIGHT_HORIZON: f64 = 120.0;
/// The interval that ends at checkpoint `index` of a forecast, counted from one.
fn forecast_step(index: usize) -> f64 {
    if index<=8 {FIRST_FLIGHT_DT*(1_u32<<(index-1)) as f64}else{FORECAST_DT}
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize)]
pub struct Drag {
    /// What the air takes of a round's speed for each metre it flies, as a share of that speed, at sea level: as much
    /// less at a height as the air there is thinner (`Drag::at`).
    pub per_meter: f64,
    pub cd: f64,
}
impl Drag {
    /// A round flies with the coefficient its catalogue entry states, or with
    /// that of its family.
    pub fn admit(mass: f64, caliber_mm: f64, family: &str, coefficient: Option<f64>) -> Result<Self, String> {
        if !mass.is_finite() || mass <= 0.0 || !caliber_mm.is_finite()
            || caliber_mm <= 0.0 || caliber_mm > 1000.0 {
            return Err("Flight requires positive physical mass and caliberMm (at most 1000 mm)".into());
        }
        let cd = coefficient.unwrap_or(match family {
            "machinegun" => 0.30,
            "autocannon" => 0.25,
            "cannon" => 0.20,
            "rocket" => 0.30,
            "grenade" => 0.40,
            "mortar" => 0.35,
            "howitzer" => 0.25,
            "fragment" => 0.60,
            _ => return Err(format!("Unknown aerodynamic family: {family}")),
        });
        if !cd.is_finite() || !(0.005..=2.0).contains(&cd) {
            return Err("Drag coefficient must be in 0.005..2".into());
        }
        let diameter = caliber_mm * 0.001;
        let per_meter = AIR_DENSITY * cd * PI * diameter * diameter / (8.0 * mass);
        if !per_meter.is_finite() || per_meter <= 0.0 {
            return Err("Invalid aerodynamic coefficient".into());
        }
        Ok(Self { per_meter, cd })
    }
    /// What the air takes of a round's speed for each metre it flies `altitude` metres over sea level.
    pub fn at(self, altitude: f64) -> f64 {
        self.per_meter * air_density(altitude) / AIR_DENSITY
    }
    pub fn to_value(self, mass: f64, caliber_mm: f64, family: &str) -> Value {
        json!({"model":MODEL,"mass":mass,"caliberMm":caliber_mm,
            "family":family,"dragCoefficient":self.cd,"airDensity":AIR_DENSITY,"scaleHeight":SCALE_HEIGHT})
    }
    pub fn from_value(v: &Value) -> Result<Self, String> {
        if v["model"] != MODEL { return Err("Unsupported flight model".into()); }
        if required(v,"airDensity")?.to_bits()!=AIR_DENSITY.to_bits()
            || required(v,"scaleHeight")?.to_bits()!=SCALE_HEIGHT.to_bits() {
            return Err("Flight atmosphere must match the canonical model".into());
        }
        Self::admit(required(v, "mass")?, required(v, "caliberMm")?,
            v["family"].as_str().ok_or("Flight family is required")?, Some(required(v,"dragCoefficient")?))
    }
}
pub fn required(v: &Value, key: &str) -> Result<f64, String> {
    v[key].as_f64().filter(|x| x.is_finite()).ok_or_else(|| format!("Finite {key} is required"))
}
pub fn required_point(v: &Value) -> Result<Point, String> {
    let point=Point::new(required(v,"x")?,required(v,"y")?);
    if point.x.abs()>1e8 || point.y.abs()>1e8 {return Err("Flight coordinates exceed the finite instrument range".into());}
    Ok(point)
}

#[derive(Clone, Copy, Debug, Default)]
pub struct FlightState {
    pub point: Point,
    pub velocity: Point,
}
// log1p(q)/q without cancellation. The remainder of the small-q series is
// below 2e-16; larger inputs use the deterministic Native/Wasm libm backend.
fn displacement_factor(q: f64) -> f64 {
    if q < 0.001 {
        1.0 + q * (-0.5 + q * (1.0 / 3.0 + q * (-0.25 + q * (0.2 - q / 6.0))))
    } else {
        ComplexField::ln(1.0 + q) / q
    }
}
impl FlightState {
    pub fn new(point: Point, velocity: Point) -> Self { Self { point, velocity } }
    /// `dt` through air that takes `air` of the speed for each metre flown at the height `reference`, and elsewhere as
    /// much less as the air there is thinner (`thinning`).
    fn split(self, dt: f64, reference: f64, air: f64) -> Self {
        if dt == 0.0 { return self; }
        // Strang gravity kicks surround exact quadratic drag-only flow. Unlike
        // explicit Euler drag, any positive dt dissipates drag energy and does
        // not reverse the velocity. Gravity may accelerate a falling round.
        let v = Point::new(self.velocity.x, self.velocity.y - GRAVITY * dt * 0.5);
        let speed = hypot(v.x, v.y);
        // The drag-only flow goes along a straight chord, through the air at the middle of it, which is the middle of
        // it flown the other way too: so the step stays symmetric and the extrapolation below keeps cancelling its
        // cubic error. The air at `reference` tells where that middle is, by the Padé approximant of
        // `displacement_factor`; what that misses of it is a small share of what the air thins by along the chord.
        let guess = air * speed * dt;
        let middle = self.point.y + v.y * dt * 0.5 * (6.0 + guess) / (6.0 + 4.0 * guess);
        let q = air * thinning(reference, middle) * speed * dt;
        let distance = dt * displacement_factor(q);
        Self { point: Point::new(self.point.x + v.x * distance,
                    self.point.y + v.y * distance),
            velocity: Point::new(v.x / (1.0 + q), v.y / (1.0 + q) - GRAVITY * dt * 0.5) }
    }
    pub fn advance(self, dt:f64, drag:Drag)->Self {
        if dt==0.0 {return self;}
        // The air is reckoned at the height the round is at halfway through the step, as gravity alone would take it
        // there: the one exponential of the step (`Drag::at`). Each part of it is flown through the air of its own chord
        // from there (`split`).
        let reference=self.point.y+dt*0.5*(self.velocity.y-GRAVITY*dt*0.25);
        let air=drag.at(reference);
        let coarse=self.split(dt,reference,air);
        let fine=self.split(dt*0.5,reference,air).split(dt*0.5,reference,air);
        // Richardson extrapolation of the symmetric exact-flow composition:
        // cancel its cubic local error without an iterative solver or a clock
        // tied to the number of displayed ray/path samples.
        Self {point:Point::new(fine.point.x+(fine.point.x-coarse.point.x)/3.0,
                fine.point.y+(fine.point.y-coarse.point.y)/3.0),
            velocity:Point::new(fine.velocity.x+(fine.velocity.x-coarse.velocity.x)/3.0,
                fine.velocity.y+(fine.velocity.y-coarse.velocity.y)/3.0)}
    }
    /// The state after `time`, on the clock of the forecast checkpoints.
    pub fn at(self, time: f64, drag: Drag) -> Self {
        self.from_checkpoint(time,drag,0.0,1)
    }
    #[inline]
    fn from_checkpoint(mut self,time:f64,drag:Drag,mut now:f64,mut index:usize)->Self {
        while now<time && index<=FLIGHT_SAMPLES {
            let next=(now+forecast_step(index)).min(time);
            self=self.advance(next-now,drag);now=next;index+=1;
        }
        debug_assert_eq!(now,time);
        self
    }
    /// Two samples of the same launch share only complete canonical intervals.
    /// The later sample must not start at the earlier sample's partial interval:
    /// splitting that interval changes the extrapolated integration and its bits.
    fn at_pair(mut self,first:f64,second:f64,drag:Drag)->(Self,Self) {
        debug_assert!(first>=0.0 && second>=first);
        let (mut now,mut index)=(0.0,1);
        while now<first && index<=FLIGHT_SAMPLES {
            let next=now+forecast_step(index);
            if next>first {break;}
            self=self.advance(next-now,drag);now=next;index+=1;
        }
        (self.from_checkpoint(first,drag,now,index),self.from_checkpoint(second,drag,now,index))
    }
    #[cfg(test)]
    pub fn with_steps(mut self, time: f64, drag: Drag, steps: usize) -> Self {
        let mut previous = 0.0;
        for i in 1..=steps {
            let end = time * i as f64 / steps as f64;
            self = self.advance(end - previous, drag);
            previous = end;
        }
        self
    }
    pub fn to_value(self, time: f64) -> Value {
        json!({"x":self.point.x,"y":self.point.y,
            "vx":self.velocity.x,"vy":self.velocity.y,"time":time})
    }
}

/// The checkpoints of one forecast, cached in no world. Geometry ray
/// count and display count cannot change the integration clock. Eight initial
/// geometrically increasing intervals resolve nearby obstacles; half-second
/// chords follow, as many as the horizon needs.
pub struct Trajectory {
    pub states:[FlightState;FLIGHT_SAMPLES+1],
    pub times:[f64;FLIGHT_SAMPLES+1],
    pub len:usize,
    drag:Drag,
}
impl Trajectory {
    pub fn new(initial:FlightState,end:f64,drag:Drag)->Self {
        let mut result=Self {states:[initial;FLIGHT_SAMPLES+1],times:[0.0;FLIGHT_SAMPLES+1],len:1,drag};
        while result.grow(end) {}
        debug_assert_eq!(result.times[result.len-1],end);
        result
    }
    /// One more checkpoint on the way to `end`; false once the forecast is there.
    fn grow(&mut self,end:f64)->bool {
        let previous=self.len-1;
        if self.times[previous]>=end || self.len>FLIGHT_SAMPLES {return false;}
        let time=(self.times[previous]+forecast_step(self.len)).min(end);
        self.states[self.len]=self.states[previous].advance(time-self.times[previous],self.drag);
        self.times[self.len]=time;self.len+=1;
        true
    }
    pub fn sample(&self,time:f64)->FlightState {
        let i=self.times[..self.len].partition_point(|t| *t<=time).saturating_sub(1);
        self.states[i].advance((time-self.times[i]).max(0.0),self.drag)
    }
    /// Grows the forecast towards `end` until the round has `reached` a mark between two checkpoints, then
    /// halves the time it is `past` the mark down 24 times. It gives the checkpoint before, its time, and the
    /// last bracket, low and high; none if the round never gets there.
    fn bracket(&mut self,end:f64,reached:impl Fn(FlightState,FlightState)->bool,past:impl Fn(FlightState)->bool)
        ->Option<(FlightState,f64,f64,f64)> {
        while self.grow(end) {
            let i=self.len-1;
            let state=self.states[i-1];let time=self.times[i-1];
            if reached(state,self.states[i]) {
                let (mut low,mut high)=(time,self.times[i]);
                for _ in 0..24 {
                    let mid=(low+high)*0.5;
                    if past(state.advance(mid-time,self.drag)) {high=mid;}else{low=mid;}
                }
                return Some((state,time,low,high));
            }
        }
        None
    }
}

#[derive(Clone, Copy)]
pub struct ShotLaunch {
    pub origin: Point,
    pub speed: f64,
    pub barrel: f64,
    /// Velocity at the launcher pivot, before the angular barrel offset.
    pub inherited: Point,
    pub omega: f64,
    pub life: f64,
    pub drag: Drag,
}
#[derive(Clone, Copy)]
pub struct Intercept { pub angle: f64, pub time: f64, pub flight: FlightState }
impl ShotLaunch {
    pub fn initial(self, angle: f64) -> FlightState {
        let (c,s) = (cos(angle),sin(angle));
        FlightState::new(Point::new(self.origin.x+c*self.barrel,self.origin.y+s*self.barrel),
            Point::new(c*self.speed+self.inherited.x-self.omega*s*self.barrel,
                       s*self.speed+self.inherited.y+self.omega*c*self.barrel))
    }
    /// Bounded shooting solver. Analytic gravity arcs are initial guesses only;
    /// a result is admitted exclusively against the shared dragged trajectory.
    /// No target/obstacle selection occurs here. The clock starts at the muzzle:
    /// a point just past it is met in a fraction of a millisecond, and one the
    /// muzzle already stands beyond is met by no flight.
    pub fn intercept(self, target: Point, velocity: Point, high: bool) -> Option<Intercept> {
        self.intercept_with_budget(target, velocity, high, 20, 1e-8)
    }
    /// Automatic pilots may accept a centimetre of forecast error and give up
    /// difficult searches earlier. Manual laying retains the strict budget above;
    /// actual projectile integration and path admission use their usual rules.
    pub(super) fn pilot_intercept(self, target: Point, velocity: Point, high: bool) -> Option<Intercept> {
        self.intercept_with_budget(target, velocity, high, 10, 0.01)
    }
    fn intercept_with_budget(self, target: Point, velocity: Point, high: bool, iterations: usize, tolerance: f64) -> Option<Intercept> {
        let delta = Point::new(target.x-self.origin.x,target.y-self.origin.y);
        let direction = if delta.x<0.0 {-1.0} else {1.0};
        let x = delta.x.abs().max(0.001);
        let speed2 = self.speed*self.speed;
        let discriminant = speed2*speed2-GRAVITY*(GRAVITY*x*x+2.0*delta.y*speed2);
        let seed = if discriminant>=0.0 {
            let elevation = atan2(speed2+if high {sqrt(discriminant)} else {-sqrt(discriminant)},GRAVITY*x);
            if direction>0.0 {elevation} else {PI-elevation}
        } else if high { atan2(1.0,direction*0.2) } else {atan2(delta.y,delta.x)};
        let mut angle = seed;
        let mut time = ((x-self.barrel*cos(angle).abs()).max(0.001)
            /(self.speed*cos(angle).abs()).max(0.01)).min(self.life);
        let error_at = |f:FlightState,time:f64| {
            Point::new(f.point.x-target.x-velocity.x*time,
                       f.point.y-target.y-velocity.y*time)
        };
        for _ in 0..iterations {
            let dt=(time*0.00001).max(0.00001);
            // The time finite difference repeats the same launch and nearly all
            // its integration. Reuse its checkpoints, keeping both endpoints exact.
            let (flight,later)=self.initial(angle).at_pair(time,time+dt,self.drag);
            let error=error_at(flight,time);
            if hypot(error.x,error.y)<tolerance {
                if high && sin(angle)<std::f64::consts::FRAC_1_SQRT_2 {return None;}
                return Some(Intercept { angle: crate::game_weapons::angle_difference(angle,0.0),time,flight });
            }
            let da=0.00001;
            let ea=error_at(self.initial(angle+da).at(time,self.drag),time);
            let et=error_at(later,time+dt);
            let ax=(ea.x-error.x)/da; let ay=(ea.y-error.y)/da;
            let tx=(et.x-error.x)/dt; let ty=(et.y-error.y)/dt;
            let determinant=ax*ty-ay*tx;
            if !determinant.is_finite() || determinant.abs()<1e-10 { return None; }
            let angle_step=((error.x*ty-error.y*tx)/determinant).clamp(-0.35,0.35);
            let time_step=((ax*error.y-ay*error.x)/determinant).clamp(-self.life*0.25,self.life*0.25);
            angle-=angle_step;
            time=(time-time_step).clamp(0.0,self.life);
            // Preserve the requested side; a converged backward shot is not an
            // alternative to an unreachable forward target.
            if cos(angle)*direction < -0.001 { return None; }
        }
        None
    }
    /// Flight time to a chosen horizontal coordinate, without changing bearing.
    pub fn crossing_time(self, angle: f64, target_x: f64) -> f64 {
        let initial=self.initial(angle);
        let direction=(target_x-initial.point.x).signum();
        if initial.velocity.x*direction<=0.0 {return self.life;}
        // The forecast is followed no further than the crossing: a flat shot is there in a few checkpoints.
        let past=|f:FlightState| (f.point.x-target_x)*direction>=0.0;
        Trajectory::new(initial,0.0,self.drag).bracket(self.life,|_,next| past(next),past)
            .map_or(self.life,|(_,_,low,high)| (low+high)*0.5)
    }
    /// How far a shot at this bearing lands from a point, and when: where it
    /// comes down through the height of the point or, never rising to it, where
    /// it passes nearest. Ground is unknown here; the height of the point stands for it.
    pub fn nearest(self, angle: f64, target: Point) -> (f64, f64) {
        // The forecast is followed no further than the landing: most shots come down long before the horizon.
        let mut trajectory=Trajectory::new(self.initial(angle),0.0,self.drag);
        let landing=trajectory.bracket(self.life,
            |state,next| state.point.y>=target.y && next.point.y<target.y && next.velocity.y<0.0,
            |f| f.point.y<target.y);
        if let Some((state,time,low,high))=landing {
            let landing=(low+high)*0.5;
            return ((state.advance(landing-time,self.drag).point.x-target.x).abs(),landing);
        }
        let mut best=(trajectory.states[0].point.distance(target),0.0);
        for i in 1..trajectory.len {
            let a=trajectory.states[i-1].point;let b=trajectory.states[i].point;
            let chord=Point::new(b.x-a.x,b.y-a.y);
            let length=chord.x*chord.x+chord.y*chord.y;
            let along=if length>0.0 {(((target.x-a.x)*chord.x+(target.y-a.y)*chord.y)/length).clamp(0.0,1.0)}else{0.0};
            let distance=Point::new(a.x+chord.x*along,a.y+chord.y*along).distance(target);
            if distance<best.0 {
                best=(distance,trajectory.times[i-1]+(trajectory.times[i]-trajectory.times[i-1])*along);
            }
        }
        best
    }
    /// Of the bearings from one to another, the one whose shot lands nearest a
    /// point: that bearing, the distance and the time. From the line of sight up
    /// to the steepest arc the distance has one valley, at the longest shot of a
    /// round that falls short, so a golden section finds it in a fixed number of
    /// flights; a parabola through its last three then places the bottom.
    pub fn closest(self, from: f64, to: f64, target: Point) -> (f64, f64, f64) {
        const SECTION: f64 = 0.618_033_988_749_894_9;
        let span=crate::game_weapons::angle_difference(to,from);
        let shot=|share:f64| {
            let angle=from+span*share;
            let (distance,time)=self.nearest(angle,target);
            (angle,distance,time)
        };
        if span.abs()<1e-9 {return shot(0.0);}
        // Shares of the travel: the ends of the bracket, with the distance once it is known, and two shots inside.
        let (mut low,mut high):((f64,Option<f64>),(f64,Option<f64>))=((0.0,None),(1.0,None));
        let (mut a,mut b)=(1.0-SECTION,SECTION);
        let (mut left,mut right)=(shot(a),shot(b));
        for _ in 0..8 {
            if left.1<=right.1 {
                high=(b,Some(right.1));b=a;right=left;
                a=high.0-(high.0-low.0)*SECTION;left=shot(a);
            } else {
                low=(a,Some(left.1));a=b;left=right;
                b=low.0+(high.0-low.0)*SECTION;right=shot(b);
            }
        }
        let (best,at,other,beside)=if left.1<=right.1 {(left,a,(b,right.1),low)} else {(right,b,(a,left.1),high)};
        let refined=match beside.1 {
            // The valley lies against an end of the travel: the end itself is the answer.
            None => shot(beside.0),
            Some(outer) => {
                let (p,q)=(at-beside.0,at-other.0);
                let (r,s)=(p*(best.1-other.1),q*(best.1-outer));
                if (r-s).abs()<1e-12 {best} else {shot((at-0.5*(p*r-q*s)/(r-s)).clamp(low.0,high.0))}
            }
        };
        if refined.1<=best.1 {refined} else {best}
    }
    /// How far forward a shot at this bearing is when it comes down through a height under the
    /// muzzle, or, still above it, at the end of the forecast: the furthest it is at that height or over it.
    fn downrange(self, angle: f64, height: f64) -> f64 {
        let mut trajectory=Trajectory::new(self.initial(angle),0.0,self.drag);
        let height=self.origin.y+height;
        let below=|f:FlightState| f.point.y<height;
        if let Some((state,time,_,high))=trajectory.bracket(self.life,|_,next| below(next),below) {
            return state.advance(high-time,self.drag).point.x-self.origin.x;
        }
        trajectory.states[trajectory.len-1].point.x-self.origin.x
    }
}
/// The furthest a round leaving a muzzle `altitude` metres over sea level at `speed`, or slower, is from it at
/// `height` (zero or less: under the muzzle) or above, at any bearing to one side: a point further off at that height
/// is out of its reach, whatever the bearing. A muzzle higher up fires through thinner air, and reaches further. From
/// the line of fire below the level to the vertical the distance has one crest, at the longest shot, so a golden
/// section finds it in a fixed number of flights.
pub fn farthest(speed: f64, altitude: f64, height: f64, drag: Drag) -> f64 {
    const SECTION: f64 = 0.618_033_988_749_894_9;
    let launch=ShotLaunch {origin:Point::new(0.0,altitude),speed,barrel:0.0,inherited:Point::ZERO,omega:0.0,life:FLIGHT_HORIZON,drag};
    let (mut low,mut high)=(-PI/4.0,PI/2.0);
    let (mut a,mut b)=(high-(high-low)*SECTION,low+(high-low)*SECTION);
    let (mut left,mut right)=(launch.downrange(a,height),launch.downrange(b,height));
    for _ in 0..30 {
        if left>=right {
            high=b;b=a;right=left;
            a=high-(high-low)*SECTION;left=launch.downrange(a,height);
        } else {
            low=a;a=b;left=right;
            b=low+(high-low)*SECTION;right=launch.downrange(b,height);
        }
    }
    left.max(right)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn mortar() -> Drag { Drag::admit(2.2,81.0,"mortar",None).unwrap() }
    #[test]
    fn pilot_budget_admits_only_bounded_residuals_across_catalogue_reach_and_motion() {
        use crate::game_weapons::Settings;
        // Numerical queries only: include both sides, motion and near/far sides
        // of the physical range boundary. The strict solver is a comparison,
        // not a claim that a forecast can bypass mounts, terrain or allies.
        let mut rows=Vec::new();
        for preset in ["m252","m119","m777","rh120"] {
            let s=Settings::admit(crate::game_damage::fixtures::catalogue(),&json!({"preset":preset}),None,true).unwrap();
            let (mut queries,mut strict,mut pilot,mut lost,mut gained)=(0,0,0,0,0);
            let mut maximum=0.0_f64;
            for charge in &s.charges {
                let speed=s.speed*sqrt(*charge);
                let range=farthest(speed,2.0,0.0,s.drag);
                for fraction in [0.02,0.3,0.7,0.95,0.995,1.005] {
                    for height in [-30.0,0.0,30.0] {
                        for bearing in [-1.0,1.0] {
                            for (own,target,omega) in [(0.0,0.0,0.0),(8.0,8.0,0.1),(8.0,-8.0,-0.1)] {
                                let launch=ShotLaunch {origin:Point::new(0.0,2.0),speed,barrel:s.barrel,
                                    inherited:Point::new(bearing*own,0.0),omega:bearing*omega,life:s.life,drag:s.drag};
                                let target=Point::new(bearing*target,0.0);
                                let aim=Point::new(bearing*range*fraction,2.0+height);
                                for high in [false,true] {
                                    queries+=1;
                                    let before=launch.intercept(aim,target,high);
                                    let after=launch.pilot_intercept(aim,target,high);
                                    strict+=usize::from(before.is_some());pilot+=usize::from(after.is_some());
                                    lost+=usize::from(before.is_some()&&after.is_none());
                                    gained+=usize::from(before.is_none()&&after.is_some());
                                    if let Some(hit)=after {
                                        assert!(hit.time.is_finite()&&(0.0..=s.life).contains(&hit.time));
                                        assert!(cos(hit.angle)*bearing>=-0.001);
                                        let forecast=launch.initial(hit.angle).at(hit.time,s.drag);
                                        let miss=forecast.point.distance(Point::new(aim.x+target.x*hit.time,aim.y+target.y*hit.time));
                                        maximum=maximum.max(miss);
                                        assert!(miss<0.01,"{preset}: {miss}m");
                                    }
                                }
                            }
                        }
                    }
                }
            }
            assert!(strict>0&&pilot>0);
            rows.push(json!({"preset":preset,"queries":queries,"strictSolutions":strict,"pilotSolutions":pilot,
                "lostSolutions":lost,"gainedSolutions":gained,"maximumResidualMetres":maximum}));
        }
        println!("pilot-budget-corpus {}",json!(rows));
    }
    #[test]
    fn paired_flight_samples_preserve_independent_integration_bits_at_checkpoint_boundaries() {
        // The original independent forecast is the numeric oracle. A continuation
        // from the first (usually partial) endpoint would fail this contract.
        let independent=|mut state:FlightState,time:f64,drag:Drag| {
            let (mut now,mut index)=(0.0,1);
            while now<time && index<=FLIGHT_SAMPLES {
                let next=(now+forecast_step(index)).min(time);
                state=state.advance(next-now,drag);now=next;index+=1;
            }
            assert_eq!(now,time);state
        };
        let bits=|f:FlightState| [f.point.x.to_bits(),f.point.y.to_bits(),f.velocity.x.to_bits(),f.velocity.y.to_bits()];
        let mut times=vec![0.0,f64::from_bits(1),0.00001,0.1,2.7,45.0,90.0,120.0];
        let mut checkpoint=0.0_f64;
        for index in 1..=FLIGHT_SAMPLES {
            checkpoint+=forecast_step(index);
            if checkpoint>FLIGHT_HORIZON {break;}
            times.extend([f64::from_bits(checkpoint.to_bits()-1),checkpoint,f64::from_bits(checkpoint.to_bits()+1)]);
        }
        let drags=[mortar(),Drag::admit(43.0,155.0,"howitzer",None).unwrap(),Drag::admit(5.0,120.0,"cannon",Some(0.025)).unwrap()];
        for drag in drags { for (point,velocity) in [
            (Point::new(0.0,2.0),Point::new(55.0,60.0)),
            (Point::new(-12000.0,950.0),Point::new(-700.0,180.0)),
            (Point::new(6200.0,80.0),Point::new(12.0,-50.0)),
        ] {for &first in &times {
            let initial=FlightState::new(point,velocity);
            for second in [first,first+(first*0.00001).max(0.00001)] {
                let (early,later)=initial.at_pair(first,second,drag);
                assert_eq!(bits(early),bits(independent(initial,first,drag)),"first {first}");
                assert_eq!(bits(later),bits(independent(initial,second,drag)),"second {first} -> {second}");
                assert_eq!(bits(initial.at(first,drag)),bits(early));
            }
        }}}
    }
    #[test]
    fn physical_inputs_are_required_and_visual_fields_cannot_replace_them() {
        assert!(Drag::admit(0.0,81.0,"mortar",None).is_err());
        assert!(Drag::admit(2.2,0.0,"mortar",None).is_err());
        assert!(Drag::admit(2.2,81.0,"vacuum",None).is_err());
        assert!(Drag::admit(2.2,81.0,"vacuum",Some(0.1)).is_err());
        for coefficient in [0.0,-0.1,2.5,f64::NAN] {assert!(Drag::admit(2.2,81.0,"mortar",Some(coefficient)).is_err());}
        // A round with a coefficient of its own keeps it through its record.
        let slick=Drag::admit(5.0,120.0,"cannon",Some(0.025)).unwrap();
        assert!(slick.per_meter<Drag::admit(5.0,120.0,"cannon",None).unwrap().per_meter*0.2);
        assert_eq!(Drag::from_value(&slick.to_value(5.0,120.0,"cannon")).unwrap().per_meter,slick.per_meter);
        assert!(Drag::from_value(&json!({"radius":0.04,"life":45.0})).is_err());
        let d=mortar(); assert!(d.per_meter>0.0);
        assert_eq!(d.per_meter,Drag::admit(2.2,81.0,"mortar",None).unwrap().per_meter);
    }
    #[test]
    fn drag_dissipates_mechanical_energy_and_gravity_may_increase_falling_speed() {
        let drag=mortar(); let mut p=FlightState::new(Point::new(0.0,1000.0),Point::new(72.0,40.0));
        for _ in 0..1200 {
            let before=0.5*(p.velocity.x*p.velocity.x+p.velocity.y*p.velocity.y)+GRAVITY*p.point.y;
            let q=p.advance(1.0/240.0,drag);
            let after=0.5*(q.velocity.x*q.velocity.x+q.velocity.y*q.velocity.y)+GRAVITY*q.point.y;
            assert!(after<=before+1e-8,"{before} -> {after}"); p=q;
        }
        let falling=FlightState::new(Point::new(0.0,100.0),Point::new(0.0,-1.0));
        assert!(falling.advance(1.0/60.0,drag).velocity.y < -1.0);
    }
    #[test]
    fn mortar_preview_is_bounded_and_converges_to_the_ccd_timestep() {
        for charge in [0.08,0.25,0.4,0.6,1.0] {
            let launch=ShotLaunch {origin:Point::new(0.0,2.0),speed:72.0*sqrt(charge),barrel:0.85,
                inherited:Point::new(3.0,-0.2),omega:0.07,life:45.0,drag:mortar()};
            let p=launch.initial(1.0);
            let horizon=2.0*launch.speed*sin(1.0)/GRAVITY;
            let fine=p.with_steps(horizon,mortar(),(horizon*240.0).ceil() as usize);
            let live=p.with_steps(horizon,mortar(),(horizon*60.0).ceil() as usize);
            let preview=p.at(horizon,mortar());
            assert!(live.point.distance(fine.point)<0.002);
            assert!(preview.point.distance(fine.point)<0.05,"charge {charge}: {}",preview.point.distance(fine.point));
            let coarse=p.with_steps(horizon,mortar(),horizon.ceil() as usize);
            assert!(preview.point.distance(fine.point)<=coarse.point.distance(fine.point));
        }
    }
    #[test]
    fn nearest_measures_a_round_that_cannot_reach_its_point() {
        let launch=ShotLaunch {origin:Point::new(0.0,2.0),speed:72.0,barrel:0.85,
            inherited:Point::ZERO,omega:0.0,life:45.0,drag:mortar()};
        let angle=PI/4.0;
        // Too far: the round comes down through the height of the point, short of it.
        let far=Point::new(900.0,0.0);
        let (miss,time)=launch.nearest(angle,far);
        let landing=launch.initial(angle).at(time,mortar()).point;
        assert!(landing.y.abs()<0.1,"{}",landing.y);
        assert!(miss>400.0 && (far.x-landing.x-miss).abs()<0.1,"{miss}");
        // Too high: the round never comes down through that height, so its nearest pass counts.
        let high=Point::new(100.0,5000.0);
        let (gap,when)=launch.nearest(angle,high);
        let pass=launch.initial(angle).at(when,mortar()).point;
        assert!((pass.distance(high)-gap).abs()<0.5 && gap<high.distance(launch.origin));
        // A point the round does reach is missed by nothing, at the time of the interception.
        let aim=Point::new(200.0,0.0);
        let hit=launch.intercept(aim,Point::ZERO,true).unwrap();
        let (none,at)=launch.nearest(hit.angle,aim);
        assert!(none<0.05 && (at-hit.time).abs()<0.01,"{none} {at} {}",hit.time);
    }
    #[test]
    fn closest_finds_the_longest_shot_of_a_round_that_falls_short() {
        let launch=ShotLaunch {origin:Point::new(0.0,2.0),speed:300.0,barrel:0.85,
            inherited:Point::ZERO,omega:0.0,life:FLIGHT_HORIZON,drag:mortar()};
        let far=Point::new(50000.0,0.0);
        let (angle,miss,time)=launch.closest(0.0,PI/2.0,far);
        // No elevation of a whole sweep does better, and drag has brought the best one below 45 degrees.
        for i in 0..=180 {assert!(launch.nearest(PI/360.0*i as f64,far).0>=miss-1e-3,"{i}");}
        assert!(angle>0.3 && angle<PI/4.0,"{angle}");
        assert_eq!(launch.nearest(angle,far),(miss,time));
        // Travel that ends before that elevation, or begins past it, is answered with its end.
        assert_eq!(launch.closest(0.0,0.2,far).0,0.2);
        assert_eq!(launch.closest(1.0,1.5,far).0,1.0);
        assert_eq!(launch.closest(0.7,0.7,far).0,0.7);
        // A point within reach is found by the same search: the low arc to it.
        let aim=Point::new(2000.0,0.0);
        let low=launch.intercept(aim,Point::ZERO,false).unwrap();
        let (found,gap,_)=launch.closest(0.0,angle,aim);
        assert!(gap<5.0 && (found-low.angle).abs()<0.01,"{gap} {found} {}",low.angle);
    }
    #[test]
    fn all_catalogue_families_and_allowed_charges_agree_with_long_flight_ccd() {
        use crate::game_weapons::Settings;
        use crate::game_projectiles::{Projectile,ProjectileState};
        use crate::game_damage::{DamageState,Effects};
        use crate::game_geometry::{Geometry,Terrain};
        for preset in ["minimi","fnmag","m2hb","mk44","m242","rh202","m230lf","mk35",
            "rh120","at4","carlgustaf","mk19","m224","m252","m119","m777","hydra70"] {
            let s=Settings::admit(crate::game_damage::fixtures::catalogue(),&serde_json::json!({"preset":preset}),None,true).unwrap();
            for (i,charge) in s.charges.iter().enumerate() {
                // From sea level, up through air that thins as it climbs and thickens again as it comes down, under sea
                // level too; and from high enough that two minutes of falling do not reach the ground, for the loop of
                // the field below.
                let shot=|y:f64| FlightState::new(Point::new(0.0,y),Point::new(
                    cos(0.9)*s.speed*sqrt(*charge)+3.0,sin(0.9)*s.speed*sqrt(*charge)-0.5));
                for p in [shot(0.0),shot(100000.0)] {
                    let trajectory=Trajectory::new(p,s.life,s.drag);
                    assert!(trajectory.len<=FLIGHT_SAMPLES+1);
                    assert_eq!(trajectory.times[trajectory.len-1],s.life);
                    let preview=p.at(s.life,s.drag);
                    let fine=p.with_steps(s.life,s.drag,(s.life*240.0) as usize);
                    let live=p.with_steps(s.life,s.drag,(s.life*60.0) as usize);
                    let error=preview.point.distance(fine.point);
                    let velocity_error=preview.velocity.distance(fine.velocity);
                    eprintln!("flight-error preset={preset} chargeIndex={i} from={} seconds={} metres={error:.12} mps={velocity_error:.12} live={:.12}",
                        p.point.y,s.life,live.point.distance(fine.point));
                    assert!(error<0.02,"{preset} charge{charge}: {error}m");
                    assert!(velocity_error<0.002,"{preset} charge{charge}: {velocity_error}m/s");
                    assert!(live.point.distance(fine.point)<0.00002,"{preset} charge{charge}: {}m",live.point.distance(fine.point));
                }
                let p=shot(100000.0);
                // The actual CCD loop, empty material/remote ground, must use
                // exactly the same states as the mechanical1/60 kernel.
                let family=match preset {"minimi"|"fnmag"|"m2hb"=>"machinegun",
                    "mk44"|"m242"|"rh202"|"m230lf"|"mk35"=>"autocannon",
                    "rh120"=>"cannon","at4"|"carlgustaf"|"hydra70"=>"rocket",
                    "mk19"=>"grenade","m224"|"m252"=>"mortar",_=>"howitzer"};
                let mut round=Projectile::from_value(&json!({"x":p.point.x,"y":p.point.y,
                    "vx":p.velocity.x,"vy":p.velocity.y,"mass":s.mass,"caliberMm":s.caliber_mm,
                    "power":s.power,"weapon":family,"ammo":"he","life":s.life,
                    "flight":s.drag.to_value(s.mass,s.caliber_mm,family)})).unwrap();
                let mut collector=ProjectileState::default();
                collector.min_x=-100000.0;collector.max_x=100000.0;
                let (mut damage,mut geometry,terrain,mut effects)=(DamageState::default(),Geometry::new(),Terrain::new("flat").unwrap(),Effects::new(false));
                let mut reference=p;
                for step in 0..(s.life*60.0) as usize {
                    let dt=1.0/60.0;
                    assert!(collector.move_projectile(&[], &mut round,|_| false,dt,step as f64*dt,
                        &mut damage,&mut geometry,&terrain,&mut effects));
                    reference=reference.advance(dt,s.drag);
                    assert_eq!(round.point,reference.point);assert_eq!(round.velocity,reference.velocity);
                    assert_eq!(round.power,s.power,"HE explosive fill must not decay with airspeed");
                }
            }
        }
    }
    #[test]
    fn the_farthest_shot_is_the_crest_of_a_whole_sweep_of_bearings() {
        // Mortars, a grenade launcher and howitzers at their weakest and strongest charges, to a point level
        // with the muzzle and to points far under it.
        let howitzer=Drag::admit(12.0,155.0,"howitzer",Some(0.054)).unwrap();
        // From a muzzle at sea level and from one 3 km up, which fires through thinner air and reaches further.
        for (speed,drag) in [(72.0*0.2_f64.sqrt(),mortar()),(72.0,mortar()),(241.0,Drag::admit(0.34,40.0,"grenade",None).unwrap()),
            (827.0*0.4_f64.sqrt(),howitzer),(827.0,howitzer)] {
            for altitude in [0.0,3000.0] {
                let launch=ShotLaunch {origin:Point::new(0.0,altitude),speed,barrel:0.0,inherited:Point::ZERO,omega:0.0,life:FLIGHT_HORIZON,drag};
                for height in [0.0,-3.0,-128.0,-1024.0,-4096.0] {
                    let reach=farthest(speed,altitude,height,drag);
                    // It is a shot flown, and no bearing of the sweep goes further.
                    let sweep=(0..=1080).map(|i| launch.downrange(-PI/4.0+PI*0.75*i as f64/1080.0,height)).fold(0.0,f64::max);
                    assert!(reach>=sweep,"{speed} m/s, {altitude} m, {height} m: {reach} {sweep}");
                    // A point just past it is out of reach of the arcs that go by it, and one just short of it is in reach.
                    let point=|share:f64| Point::new(reach*share,altitude+height);
                    let at=|share:f64| {let (low,high)=(launch.intercept(point(share),Point::ZERO,false),
                        launch.intercept(point(share),Point::ZERO,true));(low.is_some(),high.is_some())};
                    assert_eq!(at(1.0005),(false,false),"{speed} m/s, {altitude} m, {height} m");
                    assert!(at(0.98).0,"{speed} m/s, {altitude} m, {height} m");
                }
            }
            assert!(farthest(speed,3000.0,0.0,drag)>farthest(speed,0.0,0.0,drag),"{speed} m/s");
        }
    }
    #[test]
    fn mirrored_flight_and_measured_target_intercepts_use_the_same_model() {
        let a=ShotLaunch {origin:Point::new(1.0,2.0),speed:72.0,barrel:0.85,
            inherited:Point::new(3.0,0.2),omega:0.1,life:45.0,drag:mortar()};
        let b=ShotLaunch {origin:Point::new(-1.0,2.0),inherited:Point::new(-3.0,0.2),omega:-0.1,..a};
        let pa=a.initial(0.6).at(3.0,a.drag);
        let pb=b.initial(PI-0.6).at(3.0,b.drag);
        assert!((pa.point.x+pb.point.x).abs()<1e-10);
        assert!((pa.point.y-pb.point.y).abs()<1e-10);
        let velocity=Point::new(1.5,0.1);
        let target=Point::new(pa.point.x-velocity.x*3.0,pa.point.y-velocity.y*3.0);
        let solved=a.intercept(target,velocity,false).unwrap();
        assert!(solved.flight.point.distance(Point::new(target.x+velocity.x*solved.time,
                    target.y+velocity.y*solved.time))<0.0001);
    }
}
