//! The flight computer of a construction with thrusters. It is always on: a vehicle it flies is held up against its
//! weight, still where nothing is asked of it, and pushed the way its keys ask by as much of all it may be pushed that way
//! as they ask; what that takes is shared out between the thrusters that work, each pushing the one way it points in the
//! hull with as much as it has. It is leant as a drone is: to where what they push it with holds it up still with no
//! torque, where they do not hold it so level, and further, up to `LEAN`, to be pushed along the field by more than they
//! push it along level — what they push it along with level they push with first, and it is leant for the rest. Near the
//! ground it is leant no further than keeps the lowest of it clear of the ground (`CLEARANCE`), and set down level — or
//! as near level as they hold it up still at. No speed is set for it:
//! how fast it goes is what its thrust gives against its weight and the air (`Powertrain::air`), and let go it is slowed
//! to a hover with what they give the other way.
//! What they cannot give they do not give: too little thrust and the vehicle sinks, thrust all on one side of its
//! centre of mass and it tips over; asked to climb and to go along with too little for both, it climbs first. A wing holds nothing up here, and nothing else pushes.
//! Its thrusters are jets that breathe the air: higher up they push with less (`thrust_share`), and an aircraft climbs
//! no higher than where they still hold it up, its ceiling. The Oficina tells of a design at sea level (`hover`).
use crate::game_damage::DamageState;
use crate::game_flight::{GRAVITY, thrust_share};
use crate::game_geometry::{ComponentKind, Point, atan2, cos, exp_m1, hypot, sin, sqrt};
use crate::game_motion::{DriveState, FUEL_KG_PER_LITRE, Powertrain};
use serde_json::{Value, json};

/// What a lift jet burns, in kilograms of fuel for each newton it pushes with for an hour: 1.06 lb/(lbf·h), 108 kg/(kN·h),
/// that of the Rolls-Royce RB.108 lift jet, of the family of the RB162 a thruster is (`ComponentKind::thrust_n`). Pushing
/// with all of its 23.35 kN, one of the reference size burns 0.84 L a second, some 3 000 L an hour: what holds up a
/// vehicle burns more in a minute than an engine that drives it along a road burns in an hour.
pub const SPECIFIC_FUEL: f64 = 0.108;
/// While its construction flies, a thruster that works burns at least what it does at this share of its thrust: a jet
/// that idles turns on.
pub const IDLE_SHARE: f64 = 0.05;
/// The acceleration it is asked for each m/s it goes one way with nothing asked of it that way, in 1/s: how it is
/// slowed to a hover, as hard as its thrusters give from a few m/s up.
const DAMPING: f64 = 2.0;
/// And for each metre it is off where it hovers (`DriveState::station`), in 1/s²: with the damping above, a vehicle
/// pushed off it comes back as fast as it may without swinging past it, most of the way in three seconds.
const STATION: f64 = 1.0;
/// And, along the field, for each m/s² that leaning off where it would hover still speeds it up by: it is leant only as
/// fast as it is turned, and with nothing of this a vehicle slowed by leaning alone would be leant past a hover and back,
/// swinging about where it hovers for a while; with it, it comes to it with no more than a short swing.
const POISE: f64 = 0.7;
/// And, along the field, for each m/s the ring a load hangs by on its sling goes faster than the hook it hangs from
/// (`Body::swing`), in 1/s: it goes the way the top of the load does, as a crane driver takes the swing and the rocking out
/// of what he hangs by moving with it. A load that rocks on a sling of 3 to 15 m, the cable swinging with it, is let be
/// still in a few swings with it where it is not without it; more than this, on a short sling, rocks it more. Not the ring
/// against the centre of mass of the load alone, as it rocks about it: swinging under the hook, the load turns with the
/// cable, its ring going back from its centre of mass as it goes ahead, and so followed it would be swung the more each
/// swing as it is flown along, asked to go with nothing to slow it (`DAMPING`).
const FOLLOW: f64 = 1.0;
/// With a load on its sling off the ground (`Body::hung`), it and the load are sped up and slowed along the field by no
/// more than this share of the pull of gravity, however it is asked: the cable leans by as much as that speeds the load
/// up, about 9°, and the load with it — some 27° at the most as it is started or stopped at once —, where at all its
/// thrusters give it would swing up to the height of the aircraft: as a pilot flies with a load under him.
const SLUNG: f64 = 0.15;
/// Coming down, it is slowed in time to touch the ground at this, in m/s (`descent`): under the 0.886 m/s at which the
/// ground starts to tell on the bare skin of what it stands on (`contact_damage`, 4·g·skin), by as much again as it is
/// off that as it is held to it — its skids, plates of its frame, would be marked, and it taken to be in combat.
pub const TOUCH: f64 = 0.5;
/// And this high over the ground, in metres: the rest of the way it is held at that, slowed at each step to it. Slowed all
/// the way to the ground as hard as its thrusters can, a step at a time, it would touch it faster by what they slow it by
/// in a step — 0.4 m/s at three times its weight —; held so the last of the way, it touches at that, for half a second.
const SETTLING: f64 = 0.25;
/// Going along over ground that rises under it faster than this, in m/s, it is kept off that ground rather than set down
/// on it (`fly`): held at its height, it would run into it at that, and, standing on it, be leant no more to go on.
const RISING: f64 = 0.4;
/// It is let fall with its thrusters idling until slowing it to touch takes `ENGAGE` of `FLARE` of what they can speed it
/// up by upwards over its weight, held up with no torque (`held_up`), and from then on slowed by more and more of that,
/// all of it once it takes that: what is left over is what holds it level as it is slowed, and what slows it more if it is
/// slowed too late. So it comes down as a hoverslam does: falling until it must burn, then burning hard to the ground —
/// from 3 km in a minute or so, on a few tens of litres, where hovering down at 3 m/s it would take a quarter of an hour.
const FLARE: f64 = 0.9;
const ENGAGE: f64 = 0.85;
/// Kept off ground that rises under it as it goes (`RISING`), it is slowed by the first of these shares of what its
/// thrusters can, from when that takes the second of that on, as `FLARE` and `ENGAGE` are for coming down: early and
/// gently — leant to go along, what holds it up comes to push it up only as it is levelled, which takes a second or so
/// (`LEVEL`).
const SKIM: (f64, f64) = (0.5, 0.4);
/// With a load on its sling off the ground (`Body::hung`), it is slowed coming down by these shares in place of `FLARE` and
/// `ENGAGE`: early and gently, as a helicopter sets a load down. The cable is a spring: slowed hard at the last as the
/// aircraft is, the load would stretch it and bounce on it to the ground, some twice as fast as `TOUCH`.
const LOWERING: (f64, f64) = (0.5, 0.4);
/// And it comes down no faster than this, in m/s, however it is asked: the load is lowered, not let fall and caught by
/// the cable at the last.
const LOWERED: f64 = 2.0;
/// Below this speed one way, in m/s, with nothing asked of it that way, it takes where it is as where it hovers.
const SETTLE: f64 = 0.25;
/// How it is held at the lean it is to be at: the angular acceleration asked for each radian it leans off it and for each
/// rad/s it turns.
const LEVEL: (f64, f64) = (12.0, 7.0);
/// The most it is leant either way, in radians: 60°, at which what holds it up pushes it along the field by 1.73 times
/// its weight, as a racing drone is flown — what holds it up there is twice what it weighs, which a fast design has and
/// more. One with less to spare is leant no further than they still hold it up at its height (`fly`): the least thrust
/// the Oficina lets an aircraft have (`LIFT_MARGIN`, 1.25 times its weight) to 36.9°, pushing it along by 0.75 of its weight.
pub const LEAN: f64 = 60.0 * std::f64::consts::PI / 180.0;
/// The most a thruster may point off up, as the hull leans, for what it pushes with to count as holding it up (`held_up`),
/// in radians: one further over — a jet's, laid along the hull — pushes it along the field by nearly four times what it
/// holds it up by, which its flight computer, asked to climb or slowing it to the ground, does not give it; reckoned to
/// hold it up so, it would be slowed coming down too late, and leant further than it is held up at. One upright, leant
/// as far as it is leant (`LEAN`), still does.
const UPRIGHT: f64 = 75.0 * std::f64::consts::PI / 180.0;
/// Asked down while it is asked along the field, it is let fall by no more than this share of its weight: what is left
/// of what holds it up pushes it where it is asked — let fall all of it, nothing would.
const DIVE: f64 = 0.5;
/// What each radian it is to lean weighs as that lean is worked out, against what is asked of its thrusters: so little that
/// it leans as far as what is asked takes, and more than what the thrust it would take instead weighs (`FRUGAL`), so that
/// what they push it along with level they push with first.
const LEANING: f64 = 1e-4;
/// What of its weight along the field, or of the torque its weight gives at the reach of its inertia, its thrusters may
/// leave unmet in a level hull and it still be held level (`leaning`): what they leave so it is pushed off where it hovers
/// by no more than a centimetre (`STATION`), and with thrusters that give the same in more ways than one it is not leant
/// to where some of them would give it instead.
const LEVEL_HELD: f64 = 1e-3;
/// Near the ground it is leant no further than leaves the lowest of it, leant so, `CLEARANCE` metres over the ground under
/// it, and that much more as it closes on that ground in `LEVELLING` seconds — what it takes to be turned level —: low and
/// going along the field it leans as far as its length lets it, and coming down to land it is levelled as it comes, to
/// touch level — or as near level as its thrusters hold it up still at, with its weight off the middle of them. Standing on
/// the ground it is not leant at all.
pub const CLEARANCE: f64 = 0.5;
const LEVELLING: f64 = 1.5;
/// How many points, evenly spread, of the ground it will be over in the next `LEVELLING` seconds are looked at for how fast
/// that ground rises under it as it goes (`fly`).
const AHEAD: usize = 4;
/// The Oficina holds a design balanced when its thrusters hold it up still leant no more than this, each with no more
/// than `BALANCE_SHARE` of its thrust: with room left to lean further and to push harder (`hover`).
const BALANCE_LEAN: f64 = 15.0 * std::f64::consts::PI / 180.0;
const BALANCE_SHARE: f64 = 0.9;
/// Asked along the field by its keys, it goes from leaning no further than it hovers at to leaning further, or back, only
/// for more than this share of its weight pushing it on the way they ask: so that it does not sway from one to the other.
const SWAY: f64 = 0.02;
/// Turned to the lean it is to be at, it is turned no faster than leaves it, in its weight, no more than this more pushed
/// the other way from where it is asked along the field than turning it slower would (`turned_out`): turned as fast as
/// `LEVEL` turns it, the jets that alone turn one back — one with no upright thruster on that side of its centre of mass —
/// would push it the other way from where it is asked as hard as it is asked.
const TURN_COST: f64 = 0.1;
/// The slower turns tried for that: so many shares of the turn `LEVEL` asks, from none, each a share more than the last.
const TURNS: usize = 8;
/// What each of what it asks weighs as the thrust is shared out, along the field, up and turned: held at its lean first,
/// held up next, and pushed along last, so that with too little thrust it sinks before it tips and goes no way before it
/// sinks.
const WEIGHTS: [f64; 3] = [0.3, 1.0, 2.0];
/// And what a way weighs that its keys ask it to go, along the field and up: along, all its thrusters push that way, more
/// than they can while they hold it up and level, weighed so little that what they cannot give does not tip it nor let
/// its height go by more than a few hundredths of its weight; up as much as being held up does, a hundred times along the
/// field, so that asked both ways with too little thrust for both — or with thrusters that push it along only as they push
/// it up — it climbs or comes down as asked before it goes along, and, leant hard to go along, it is not pushed up or down
/// by what pushes it so: what turns it as it is leant over to the other side pushes it up by a few metres, no more, and a
/// thruster lost leant over does not tip it over — ten times less, and both would.
const ASKED: [f64; 2] = [0.01, 1.0];
/// What each newton of thrust weighs against the rest, as a share of its weight: of the ways to give the same, the one
/// that burns least. It is small enough to leave a vehicle that hovers less than a millimetre under where it hovers.
const FRUGAL: f64 = 1e-5;
/// And what each newton weighs of a thruster that pushes it against the way it is asked along the field, for each of
/// the others (`fly`): enough that it is not given what they give as well, little enough that it still is what they
/// cannot give of turning it.
const AGAINST: f64 = 50000.0;
/// And how much more than it is asked up the others are to hold it up by, in its weight, for it to be so: with less to
/// spare, those that turn it as they hold it up do not lean it from one side to the other but as it sinks, nor climb it
/// as fast as it is asked.
const SPARE: f64 = 0.5;
/// How many times each thruster is shared out again in a step, from what it was given in the step before — enough for the
/// lean to come all the way to `LEAN` from level, as it is worked out again from level at each step —; and from none,
/// for the Oficina to tell whether they can hold a design up (`hover`).
const SWEEPS: usize = 48;
const SETTLED_SWEEPS: usize = 400;
/// What of its weight, or of the torque its weight gives at the reach of its inertia, they may leave unmet and still
/// hold it up.
const HELD: f64 = 0.01;
/// It is set down when, on the ground with nothing asked of it upwards, it climbs no faster than this, in m/s.
const SET_DOWN: f64 = 0.5;

/// What the flight computer reads of the body of the vehicle it flies: its mass, its inertia about its centre of mass,
/// where that is, the gravity of the world, how high the lowest of it is over the ground under it, when that is known —
/// or of what it holds up on a sling, lower —, how the air holds it back by the side it shows the way it goes, the way its
/// design faces (`Powertrain::air`), what the cable it is on pulled it with in the step before (`pull`, as its thrusters
/// push it: on its centre of mass, and about it), the mass it holds up on a sling off the ground (`hung`) and how much
/// faster along the field than its hook the ring that hangs by goes, as the load swings under it and rocks about the ring
/// (`swing`). What a cable pulls it down with it is held up against as against its weight, and the torque it gives is
/// taken off; what it pulls it with along the field it is let pull it with: drawn after a load that swings under it and
/// slowed so as it is (`DAMPING`), it takes the swing out, and however it is asked it goes the way the top of the load
/// goes from under it as well (`FOLLOW`), which takes the swing and the rocking out. Coming down, it is slowed in time for what it holds up to be
/// slowed with it: a load falling with it pulls on it not at all until it is.
#[derive(Clone, Copy, Debug)]
pub struct Body {
    pub mass: f64,
    pub inertia: f64,
    pub center: Point,
    pub gravity: Point,
    pub above: Option<f64>,
    pub air: Option<(Powertrain, f64)>,
    pub pull: Lift,
    pub hung: f64,
    pub swing: f64,
}
/// What its thrusters push the body with over a step: a force at its centre of mass and a torque about it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Lift {
    pub force: Point,
    pub torque: f64,
}
/// The thrust of a thruster that works pointed `angle` in the field: up, at no angle.
fn heading(angle: f64) -> Point {
    Point::new(-sin(angle), cos(angle))
}
/// The measure what is asked of the thrusters of `body` is shared out in: its weight, and the reach of its inertia (its
/// radius of gyration), so that a torque weighs as the force that gives it there.
fn measure(body: &Body) -> (f64, f64) {
    (body.mass * hypot(body.gravity.x, body.gravity.y).max(1.0), sqrt(body.inertia / body.mass).max(0.5))
}
/// What each thruster pushing from `at` along `way` with `most` gives of the three asked of them by all of its thrust:
/// along the field, up and level.
fn column(body: &Body, (weight, reach): (f64, f64), at: Point, way: Point, most: f64) -> [f64; 3] {
    let arm = Point::new(at.x - body.center.x, at.y - body.center.y);
    [most * way.x / weight, most * way.y / weight, most * arm.cross(way) / (weight * reach)]
}
/// What a column of a thruster in a level hull gives with the hull leant `angle`: what it gives along the field and up
/// turns with it, and its torque about the centre of mass does not.
fn turned([x, y, torque]: [f64; 3], (sin, cos): (f64, f64)) -> [f64; 3] {
    [cos * x - sin * y, sin * x + cos * y, torque]
}
/// What is left unmet of `goal` by `columns` at `shares`.
fn unmet(columns: &[[f64; 3]], shares: &[f64], goal: [f64; 3]) -> [f64; 3] {
    let mut left = goal;
    for (column, share) in columns.iter().zip(shares) {
        for k in 0..3 {
            left[k] -= column[k] * share;
        }
    }
    left
}
/// What `columns` give with the hull leant `angle` further (`turned`).
fn leant(columns: &[[f64; 3]], angle: f64) -> Vec<[f64; 3]> {
    let turn = (sin(angle), cos(angle));
    columns.iter().map(|&column| turned(column, turn)).collect()
}
/// Each thruster in turn takes the share of its thrust that leaves the least of what is asked unmet, between none and
/// `most` of all of it, and again from the first, `sweeps` times from the `shares` they had: a least-squares share bounded
/// at both ends, which every host works out alike. Of the ways to give the same, the one that burns least (`FRUGAL`, by the
/// share of the weight each thrust is, `costs`). Given how far the hull may lean (`leans`, the most one way and the most
/// the other), with the thrusters as `columns` gives them in a level hull, the lean it is to be at is shared out along with
/// them, from level, after each of them in each sweep: turned a little further, what they push it with turns with it by
/// that angle times itself a quarter turn on, and it is turned as far as leaves least unmet so, as near level as gives the
/// same (`LEANING`), no further than it may lean. What is left unmet, and at what lean.
fn share_out(columns: &[[f64; 3]], costs: &[f64], goal: [f64; 3], weights: [f64; 3], shares: &mut [f64], most: f64, sweeps: usize,
    leans: Option<(f64, f64)>) -> ([f64; 3], f64) {
    let (level, mut columns, mut lean) = (columns, columns.to_vec(), 0.0);
    let mut left = unmet(&columns, shares, goal);
    for _ in 0..sweeps {
        for (i, column) in columns.iter().enumerate() {
            let square: f64 = (0..3).map(|k| weights[k] * column[k] * column[k]).sum();
            if !(square > 0.0) {
                continue;
            }
            let along: f64 = (0..3).map(|k| weights[k] * column[k] * left[k]).sum();
            let share = (shares[i] + (along - FRUGAL * costs[i]) / square).clamp(0.0, most);
            for k in 0..3 {
                left[k] -= column[k] * (share - shares[i]);
            }
            shares[i] = share;
        }
        let Some(leans) = leans else { continue };
        let turning = [left[1] - goal[1], goal[0] - left[0]];
        let swing = weights[0] * turning[0] * turning[0] + weights[1] * turning[1] * turning[1];
        if !(swing > 0.0) {
            continue;
        }
        let free = lean + (weights[0] * turning[0] * left[0] + weights[1] * turning[1] * left[1]) / swing;
        let next = (free.signum() * (free.abs() - LEANING / (2.0 * swing)).max(0.0)).clamp(leans.0, leans.1);
        if next != lean {
            lean = next;
            let turn = (sin(lean), cos(lean));
            for (column, level) in columns.iter_mut().zip(level) {
                *column = turned(*level, turn);
            }
            left = unmet(&columns, shares, goal);
        }
    }
    (left, lean)
}
/// What `columns` leave unmet of `goal`, weighed by `weights`.
fn weighed(columns: &[[f64; 3]], shares: &[f64], goal: [f64; 3], weights: [f64; 3]) -> f64 {
    let left = unmet(columns, shares, goal);
    (0..3).map(|k| weights[k] * left[k] * left[k]).sum()
}
/// The thrusters' shares moved straight to where they give all of `goal` (`unmet`), by as little as does it, as far as
/// each may go between none and `most`: each one that would go past either end is held there, and the rest moved again,
/// once for each of them — where shared out a thruster at a time they would take many sweeps to get there, as what one
/// gives along the field turns the hull as well. Kept only where it leaves less unmet, weighed by `weights`.
fn settle(columns: &[[f64; 3]], goal: [f64; 3], weights: [f64; 3], shares: &mut [f64], most: f64) {
    let before = weighed(columns, shares, goal, weights);
    let mut moved = shares.to_vec();
    let mut held = vec![false; shares.len()];
    for _ in 0..=shares.len() {
        let left = unmet(columns, &moved, goal);
        // Σ a aᵀ over the thrusters free to move, made a little more than that so that a way none of them gives is not
        // asked of them: the least move that gives `left` is aᵀ of what this matrix turns `left` into.
        let mut m = [[0.0; 3]; 3];
        for column in columns.iter().zip(&held).filter(|&(_, &kept)| !kept).map(|(column, _)| column) {
            for r in 0..3 {
                for c in 0..3 {
                    m[r][c] += column[r] * column[c];
                }
            }
        }
        for r in 0..3 {
            m[r][r] += 1e-9;
        }
        let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
            + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
        if !(det.abs() > 0.0) {
            break;
        }
        let solve = |k: usize| {
            let mut n = m;
            for r in 0..3 {
                n[r][k] = left[r];
            }
            (n[0][0] * (n[1][1] * n[2][2] - n[1][2] * n[2][1]) - n[0][1] * (n[1][0] * n[2][2] - n[1][2] * n[2][0])
                + n[0][2] * (n[1][0] * n[2][1] - n[1][1] * n[2][0])) / det
        };
        let y = [solve(0), solve(1), solve(2)];
        let step: Vec<f64> = columns.iter().enumerate()
            .map(|(i, column)| if held[i] { 0.0 } else { column[0] * y[0] + column[1] * y[1] + column[2] * y[2] }).collect();
        // As far along that move as keeps each share between none and `most`; the first to get to an end is held there.
        let (mut reach, mut stop) = (1.0_f64, None);
        for (i, &delta) in step.iter().enumerate() {
            let room = if delta < 0.0 { -moved[i] / delta } else if delta > 0.0 { (most - moved[i]) / delta } else { f64::INFINITY };
            if room < reach {
                (reach, stop) = (room.max(0.0), Some(i));
            }
        }
        for (share, delta) in moved.iter_mut().zip(&step) {
            *share = (*share + reach * delta).clamp(0.0, most);
        }
        match stop {
            Some(i) => held[i] = true,
            None => break,
        }
    }
    if weighed(columns, &moved, goal, weights) < before {
        shares.copy_from_slice(&moved);
    }
}
/// The lean, between the two of `most`, at which thrusters that give what `level` gives in a level hull give `held`
/// with the torque it asks — none, but what a cable takes off —, as near level as that is: shared out level first, from
/// `shares` moved to where they give it (`settle`), and, where that leaves more than `LEVEL_HELD` unmet along the field or
/// turning it, leant from there (`share_out`) — so that what they push along with level they push with first, and it is
/// leant for the rest, however they pushed before. What is left unmet there, and the lean.
fn leaning(level: &[[f64; 3]], costs: &[f64], held: [f64; 3], weights: [f64; 3], shares: &mut [f64], share: f64, sweeps: usize,
    most: (f64, f64)) -> ([f64; 3], f64) {
    settle(level, held, weights, shares, share);
    let left = share_out(level, costs, held, weights, shares, share, sweeps, None).0;
    if left[0].abs() <= LEVEL_HELD && left[2].abs() <= LEVEL_HELD {
        return (left, 0.0);
    }
    share_out(level, costs, held, weights, shares, share, sweeps, Some(most))
}
/// What the Oficina tells of the thrusters of a compiled construction, of its pieces (`modules`) and its mass, inertia
/// and centre of mass with all it carries full (`assembly`, `fixedAssembly`), and nothing of one with none, at sea level:
/// whether all they push up with is more than it weighs (`lifts`), and whether they hold it up still, leant no more than
/// `BALANCE_LEAN` and each with no more than `BALANCE_SHARE` of its thrust, as its flight computer shares them out and
/// leans it (`balanced`); leant how far (`hoverLean`, in radians) and burning how much (`hoverLitres`, a second); and,
/// for its pilot to reckon how it comes down (squad.js `descentCost`), what they push it up with at the most, level, with
/// no torque (`liftN`, in newtons: `held_up`), and what they burn idling (`idleLitres`, a second).
pub fn hover(modules: &Value, assembly: &Value) -> Option<Value> {
    let number = |value: &Value, key: &str| value[key].as_f64().unwrap_or(0.0);
    let thrusters: Vec<(Point, Point, f64)> = modules.as_array()?.iter().filter(|m| m["kind"] == "thruster")
        .map(|m| (Point::new(number(m, "x"), number(m, "y")), heading(number(m, "angle")), number(m, "thrustN")))
        .collect();
    if thrusters.is_empty() {
        return None;
    }
    let (origin, local) = (&assembly["origin"], &assembly["centerLocal"]);
    let body = Body {
        mass: number(assembly, "mass"),
        inertia: number(assembly, "inertia"),
        center: Point::new(number(origin, "x") + number(local, "x"), number(origin, "y") + number(local, "y")),
        gravity: Point::new(0.0, -GRAVITY),
        above: None,
        air: None,
        pull: Lift::default(),
        hung: 0.0,
        swing: 0.0,
    };
    let lifts = body.mass > 0.0 && thrusters.iter().map(|&(_, way, most)| way.y.max(0.0) * most).sum::<f64>() > body.mass * GRAVITY;
    let scale = measure(&body);
    let level: Vec<[f64; 3]> = thrusters.iter().map(|&(at, way, most)| column(&body, scale, at, way, most)).collect();
    let costs: Vec<f64> = thrusters.iter().map(|t| t.2 / scale.0).collect();
    let mut shares = vec![0.0; thrusters.len()];
    let (left, lean) = leaning(&level, &costs, [0.0, 1.0, 0.0], WEIGHTS, &mut shares, BALANCE_SHARE, SETTLED_SWEEPS, (-BALANCE_LEAN, BALANCE_LEAN));
    // What its thrusters burn holding it up so, in litres a second, as they burn in flight (`fly`).
    let burns = thrusters.iter().zip(&shares).map(|(&(.., most), share)| SPECIFIC_FUEL * share.max(IDLE_SHARE) * most / FUEL_KG_PER_LITRE).sum::<f64>() / 3600.0;
    let balanced = lifts && left.iter().all(|unmet| unmet.abs() < HELD);
    let held = if body.mass > 0.0 { held_up(&level) * scale.0 } else { 0.0 };
    let idles = thrusters.iter().map(|&(.., most)| SPECIFIC_FUEL * IDLE_SHARE * most / FUEL_KG_PER_LITRE).sum::<f64>() / 3600.0;
    Some(json!({"lifts": lifts, "balanced": balanced, "hoverLitres": burns, "hoverLean": lean, "liftN": held, "idleLitres": idles}))
}
/// What `columns` push it up with at the most with no torque about its centre of mass, in its weight: all of each that turns
/// it neither way and of those on the side that turns it the less, and of the others as much as turns it back as much,
/// first those that push it up the most for what they turn it. Of those that point no further off up than `UPRIGHT`.
/// Where those all turn it the same way — its centre of mass gone past all of them on one side, as the tanks of one with
/// its main thruster near that centre run dry —, they would hold it up by nothing that way, while its flight computer
/// still holds it up on them (`leaning`): there those that point further over — a jet laid along the hull —, which hold it
/// up by nothing but turn it as they push, turn it back for as much of them as they can, so long as what they push it
/// along the field with is no more than leaning it `BALANCE_LEAN` bears of all that holds it up — leant so, none of it
/// pushes it along —, or, where the first of the others takes more, than leaning it as far as it hovers on that one alone,
/// and never further than it is leant (`LEAN`); those that push it along the least for what they turn it first. Not
/// elsewhere: pushing it along as it comes down to the ground, where it is not leant, they would carry it off the place it
/// is set down at.
pub(crate) fn held_up(columns: &[[f64; 3]]) -> f64 {
    let upright = |c: &[f64; 3]| c[1] > 0.0 && c[1] >= cos(UPRIGHT) * hypot(c[0], c[1]);
    let (mut up, mut one, mut other) = (0.0, Vec::new(), Vec::new());
    for c in columns.iter().filter(|c| upright(c)) {
        if c[2].abs() < 1e-9 { up += c[1] } else if c[2] > 0.0 { one.push(c) } else { other.push(c) }
    }
    let turns = |side: &[&[f64; 3]]| side.iter().map(|c| c[2].abs()).sum::<f64>();
    let (less, mut more) = if turns(&one) <= turns(&other) { (one, other) } else { (other, one) };
    let mut left = turns(&less);
    up += less.iter().map(|c| c[1]).sum::<f64>();
    more.sort_by(|a, b| (b[1] / b[2].abs()).total_cmp(&(a[1] / a[2].abs())));
    // Where those all turn it one way, those further over that turn it back, each with how much of its torque is left.
    let way = if less.is_empty() { more.first().map_or(0.0, |c| c[2].signum()) } else { 0.0 };
    let mut over: Vec<(&[f64; 3], f64)> = columns.iter().filter(|c| !upright(c) && c[2] * way < 0.0).map(|c| (c, c[2].abs())).collect();
    over.sort_by(|a, b| (a.0[0].abs() / a.1).total_cmp(&(b.0[0].abs() / b.1)));
    let (mut bears, mut along, mut next) = (sin(BALANCE_LEAN) / cos(BALANCE_LEAN), 0.0, 0);
    for c in more {
        let share = (left.max(0.0) / c[2].abs()).min(1.0);
        up += share * c[1];
        left -= share * c[2].abs();
        // What of this one is left, given torque by torque as those further over turn it back: each gives as it is
        // given so much up for each of them, of this one and of itself, and so much along the field.
        let mut rest = (1.0 - share) * c[2].abs();
        while rest > 0.0 && next < over.len() {
            let (o, spare) = (over[next].0, &mut over[next].1);
            let (lifts, pushes) = (c[1] / c[2].abs() + o[1] / o[2].abs(), o[0].abs() / o[2].abs());
            if !(lifts > 0.0) {
                return up;
            }
            if !(up > 0.0) {
                bears = bears.max((pushes / lifts).min(sin(LEAN) / cos(LEAN)));
            }
            let room = if pushes > bears * lifts { (bears * up - along).max(0.0) / (pushes - bears * lifts) } else { f64::INFINITY };
            let given = rest.min(*spare).min(room);
            up += lifts * given;
            along += pushes * given;
            rest -= given;
            *spare -= given;
            if given == room {
                return up;
            }
            if !(*spare > 0.0) {
                next += 1;
            }
        }
        if rest > 0.0 {
            break;
        }
    }
    up
}
/// What it is asked to speed up by upwards in place of `wanted`, `above` the ground and closing on it at `falling`, when
/// its thrusters can speed it up by `climbs` m/s² over its weight and the air holds it back by `held` for each m²/s² it
/// falls at: as much as slows it evenly from how fast it falls to `touch` `last` metres over the ground, the air slowing
/// it too, once that is more than the second of the `shares` of the first of them of what they can, more and more of it
/// until it is that (`FLARE`, `ENGAGE`, `SKIM`); from there, as much as slows it to `touch` within the step of `dt` seconds. Slowed so all
/// the way down, it is asked the same all the way down, and asked more if it falls faster than that.
fn descent(wanted: f64, above: f64, climbs: f64, shares: (f64, f64), falling: f64, touch: f64, held: f64, last: f64, dt: f64) -> f64 {
    let (fast, spare, engage) = (-falling, shares.0 * climbs, shares.1);
    if !(spare > 0.0) {
        return wanted;
    }
    let above = above - last;
    if above <= 0.0 {
        return wanted.max((fast - touch) / dt);
    }
    if fast <= touch {
        return wanted;
    }
    // Slowed by `a` and by the air, it goes from `fast` to `touch` in ln((a + held·fast²)/(a + held·touch²))/(2·held)
    // metres: the `a` that takes all that is left.
    let reach = 2.0 * held * above;
    let needed = if reach > 1e-9 { held * (fast * fast - touch * touch) / exp_m1(reach) - held * touch * touch }
        else { (fast * fast - touch * touch) / (2.0 * above) };
    let share = ((needed / spare - engage) / (1.0 - engage)).clamp(0.0, 1.0);
    wanted + share * (needed - wanted).max(0.0)
}
/// What the flight computer reads of the ground under the vehicle it flies, to lean it no further than keeps it off that
/// ground: the corners of its outline about its centre of mass as they stand in a level hull, and the height of the ground
/// at each point along the field.
pub struct Underneath<'a> {
    pub outline: &'a [Point],
    pub ground: &'a dyn Fn(f64) -> f64,
}
/// The most it may be leant one way and the other, no further than `most`, for the lowest of its outline (`Underneath`),
/// turned about its `center` so, to be `margin` metres over the ground under it: none either way where level it is no
/// higher than that.
fn tilt(under: &Underneath, center: Point, margin: f64, most: f64) -> (f64, f64) {
    let clear = |angle: f64| {
        let (s, c) = (sin(angle), cos(angle));
        under.outline.iter().map(|q| center.y + s * q.x + c * q.y - (under.ground)(center.x + c * q.x - s * q.y)).fold(f64::INFINITY, f64::min)
    };
    if !(clear(0.0) >= margin) {
        return (0.0, 0.0);
    }
    let side = |way: f64| {
        if clear(way * most) >= margin {
            return most;
        }
        let (mut fits, mut not) = (0.0, most);
        for _ in 0..8 {
            let middle = (fits + not) / 2.0;
            if clear(way * middle) >= margin { fits = middle } else { not = middle }
        }
        fits
    };
    (-side(-1.0), side(1.0))
}
/// The thrusters' shares (`share_out`) that give `along` what it is asked along the field and up, its spin held with the
/// torque `steady` and turned with `turning` more — in the measure of `columns` —: turned as fast as that unless it would
/// be pushed the other way from where it is asked along the field by more than `TURN_COST` of its weight more than at one
/// of the slower turns tried (`TURNS`), else as fast as the fastest of those that it would not. Where the only thrusters
/// that turn it back to where it hovers are jets that push it along the hull, turned back as fast as `LEVEL` turns it as
/// it is asked a little less along the field, they would push it the other way as hard as it is asked, and its pilot,
/// seeing it go that way, ask it a little more the round after — it would hang leant over, pushed one way and the other,
/// and come no nearer.
/// Only being pushed the other way counts against a turn. Short of what it is asked along the field, but pushed the way
/// it is asked, it is on its way flat out, and kept leant over for the little more it would be pushed so it would only go
/// slower; short of what it is asked up, as its flight computer shares out its thrust whenever it turns (`WEIGHTS`), kept
/// leant past what holds it up it would only sink. A slower turn, though, is counted as pushing it the other way also by
/// what it leaves it shorter of what it is asked up than the whole turn does: let go at speed, a slower turn would spare
/// it some of being pushed on only by sinking it, and, never turned back, it would not slow.
pub(crate) fn turned_out(columns: &[[f64; 3]], costs: &[f64], along: [f64; 2], weights: [f64; 3], shares: &mut [f64], steady: f64, turning: f64) {
    // How far turned so it is pushed the other way from where it is asked along the field, past none, and left short of
    // what it is asked up.
    let given = |turn: f64, shares: &mut [f64]| {
        let goal = [along[0], along[1], steady + turn * turning];
        share_out(columns, costs, goal, weights, shares, 1.0, SWEEPS, None);
        let left = unmet(columns, shares, goal);
        ((left[0].abs() - along[0].abs()).max(0.0), left[1])
    };
    let mut turned = shares.to_vec();
    let (missed, short) = given(1.0, &mut turned);
    if missed > TURN_COST {
        // A slower turn counted as pushing it the other way also by what it leaves it shorter of what it is asked up.
        let slower: Vec<(f64, Vec<f64>)> = (0..TURNS).map(|i| {
            let mut tried = shares.to_vec();
            let (pushed, under) = given(i as f64 / TURNS as f64, &mut tried);
            (hypot(pushed, (under - short).max(0.0)), tried)
        }).collect();
        let least = slower.iter().map(|t| t.0).fold(missed, f64::min);
        if missed > least + TURN_COST {
            if let Some((_, tried)) = slower.into_iter().filter(|t| t.0 <= least + TURN_COST).last() {
                turned = tried;
            }
        }
    }
    shares.copy_from_slice(&turned);
}
/// The lean at which the thrusters of vehicle `d` of `actor` that work hold it up still with no torque, as its flight
/// computer works it out as it flies (`fly`), in the air they breathe at the height of its centre of mass: where it would
/// hover, level for one whose thrusters hold it up so. Level for one with none that works.
pub fn poise(d: &DriveState, damage: &DamageState, actor: u32, body: Body) -> f64 {
    let breathes = thrust_share(body.center.y);
    let thrusters: Vec<(f64, Point, Point, f64)> = damage.modules.iter()
        .filter(|m| m.actor == actor && m.kind == ComponentKind::Thruster)
        .map(|m| (m.thrust, Point::new(m.pose.x, m.pose.y), heading(m.pose.angle), if m.usable() { m.kind.thrust_n(m.volume) * breathes } else { 0.0 }))
        .collect();
    if !(body.mass > 0.0) || !thrusters.iter().any(|t| t.3 > 0.0) {
        return 0.0;
    }
    let lean = atan2(sin(d.pose.angle), cos(d.pose.angle));
    let scale = measure(&body);
    let columns: Vec<[f64; 3]> = thrusters.iter().map(|&(_, at, way, most)| column(&body, scale, at, way, most)).collect();
    let costs: Vec<f64> = thrusters.iter().map(|t| t.3 / scale.0).collect();
    let mut shares: Vec<f64> = thrusters.iter().map(|&(share, .., most)| if most > 0.0 { share } else { 0.0 }).collect();
    let still = [-body.mass * body.gravity.x / scale.0, -body.mass * body.gravity.y / scale.0, 0.0];
    leaning(&leant(&columns, -lean), &costs, still, WEIGHTS, &mut shares, 1.0, SWEEPS, (-LEAN, LEAN)).1
}
/// What its thrusters push vehicle `d` of `actor` with over `dt`, and the fuel they burn for it, as its flight computer
/// shares it out: nothing while it does not fly. It flies from a climb asked of it with thrusters that work and fuel to
/// burn, until it is set down on the ground — nothing asked of it upwards, nor asked of it at all, and climbing no
/// faster than `SET_DOWN` — or its thrusters or its fuel fail, or it is out of the fight.
pub fn fly(d: &mut DriveState, damage: &mut DamageState, actor: u32, defeated: bool, body: Body, under: Option<Underneath>, dt: f64)
    -> Lift {
    // Each thruster of it: which piece, where it pushes from, which way, and the most it pushes with — none from one
    // destroyed or torn off —, at sea level, as told (`thrust_n`), and in the air it breathes at the height of the centre
    // of mass, which all that follows reads.
    let mut thrusters: Vec<(usize, Point, Point, f64)> = damage.modules.iter().enumerate()
        .filter(|(_, m)| m.actor == actor && m.kind == ComponentKind::Thruster)
        .map(|(i, m)| (i, Point::new(m.pose.x, m.pose.y), heading(m.pose.angle), if m.usable() { m.kind.thrust_n(m.volume) } else { 0.0 }))
        .collect();
    d.thrust_n = thrusters.iter().map(|t| t.3).sum();
    let breathes = thrust_share(body.center.y);
    for thruster in &mut thrusters {
        thruster.3 *= breathes;
    }
    let fueled = damage.modules.iter().any(|m| m.actor == actor && m.kind == ComponentKind::Fuel && m.usable() && m.fuel_litres > 1e-9);
    if !(d.thrust_n > 0.0) || !fueled || defeated || !d.enabled || !(body.mass > 0.0) {
        d.flying = false;
    } else if !d.flying && d.rise > 0.0 {
        d.flying = true;
    } else if d.flying && d.grounded && d.velocity.y <= SET_DOWN && (d.rise < 0.0 || d.rise == 0.0 && d.throttle == 0.0) {
        d.flying = false;
    }
    if !d.flying {
        d.station = (None, None);
        for &(i, ..) in &thrusters {
            damage.modules[i].thrust = 0.0;
        }
        return Lift::default();
    }
    // What it holds up on a sling off the ground it holds up and speeds up and down as a part of itself: its thrusters push
    // up `heavy` times its own mass, the two together. What a cable pulls it down with otherwise — tied to a load still on
    // the ground — it is held up against as against its weight. Either way, the torque the cable gives it about its centre
    // of mass its thrusters take off (`Body`). Its weight, so — `body.gravity` from here on, for its own mass —, is what
    // they hold up with no speed asked of them.
    let heavy = (body.mass + body.hung.max(0.0)) / body.mass;
    let pulled = if body.hung > 0.0 { 0.0 } else { body.pull.force.y.min(0.0) / body.mass };
    let body = Body { gravity: Point::new(body.gravity.x, body.gravity.y * heavy + pulled), ..body };
    // What each thruster gives of what is asked of them as they point now, and as they would in a level hull; shared out
    // from what each gave in the step before. And the lean at which they would hold it up still, as near level as that is
    // (`leaning`).
    let lean = atan2(sin(d.pose.angle), cos(d.pose.angle));
    let scale = measure(&body);
    let untwist = -body.pull.torque / (scale.0 * scale.1);
    let columns: Vec<[f64; 3]> = thrusters.iter().map(|&(_, at, way, most)| column(&body, scale, at, way, most)).collect();
    let level = leant(&columns, -lean);
    let costs: Vec<f64> = thrusters.iter().map(|t| t.3 / scale.0).collect();
    let mut shares: Vec<f64> = thrusters.iter().map(|&(i, .., most)| if most > 0.0 { damage.modules[i].thrust } else { 0.0 }).collect();
    let still = [-body.mass * body.gravity.x / scale.0, -body.mass * body.gravity.y / scale.0, untwist];
    let poised = leaning(&level, &costs, still, WEIGHTS, &mut shares.clone(), 1.0, SWEEPS, (-LEAN, LEAN)).1;
    // How far it may lean one way and the other: as far as `LEAN` up in the air, near the ground as far as keeps the lowest
    // of it over that ground (`CLEARANCE`) — the more, the faster it closes on it, coming down or with the ground rising
    // under it as it goes —, and at least as far as it hovers still at; not at all standing on it. Where no point of it
    // can come down that far as it is turned, the ground is not looked at.
    // How fast it closes on the ground under it: coming down, or with that ground rising under it as it goes (`rising`) —
    // as fast as the ground under it rises there, or as the ground it will be over in `LEVELLING` seconds, going as it
    // goes, rises over that under it now, the steepest of those (`AHEAD`): what it takes to be turned level to climb, so
    // that fast and low it climbs over a rise as it comes to it, not once it is on it.
    let slope = under.as_ref().map_or(0.0, |under| ((under.ground)(body.center.x + 1.0) - (under.ground)(body.center.x - 1.0)) / 2.0);
    let rising = under.as_ref().map_or(0.0, |under| {
        let here = (under.ground)(body.center.x);
        (1..=AHEAD).map(|i| LEVELLING * i as f64 / AHEAD as f64)
            .map(|t| ((under.ground)(body.center.x + d.velocity.x * t) - here) / t)
            .fold(slope * d.velocity.x, f64::max)
    });
    let closing = rising - d.velocity.y;
    let rising = rising.max(0.0);
    let leans = if d.grounded { (0.0, 0.0) } else {
        let tilted = under.as_ref().map_or((-LEAN, LEAN), |under| {
            let at = body.center;
            let margin = CLEARANCE + LEVELLING * closing.max(0.0);
            let span = under.outline.iter().map(|q| hypot(q.x, q.y)).fold(0.0, f64::max);
            if body.above.is_some_and(|above| above > 2.0 * span + margin) { (-LEAN, LEAN) } else { tilt(under, at, margin, LEAN) }
        });
        (tilted.0.min(poised), tilted.1.max(poised))
    };
    // What it is asked up and along the field: the share its keys ask of all it can be sped up by that way — up, what its
    // thrusters push it up with over its weight; down, its weight, with none of them to push it there, or `DIVE` of it
    // while it is also asked along the field, with what holds it up left to push it there —, or, with nothing asked one
    // way, to stop that way and stay where it came to a hover, and along the field to be leant back towards where it
    // would hover still (`POISE`); never more than that, nor less than none, so that what they cannot give takes nothing
    // from what they can. Up first, by what they push it with up its hull, as it is levelled for it: along the field,
    // what they push it with that way level, and what leaning as far as it may adds as they give what it is asked up —
    // no more than is left of all they push it with up its hull —, so that asked both ways with too little thrust for
    // both it goes no way before it sinks (`WEIGHTS`).
    // Up and down, each of these is what speeds up all it holds up with it (`heavy`); along the field, it alone.
    let asked = [d.throttle, d.rise];
    let gravity = hypot(body.gravity.x, body.gravity.y) / heavy;
    let reach = |way: Point| thrusters.iter().map(|&(.., pushes, most)| pushes.dot(way).max(0.0) * most).sum::<f64>() / body.mass;
    // What they speed it up by upwards over its weight with no torque (`held_up`): with its weight off the middle of them,
    // less than all they push it up with — those on the side further from it are held back for it to stay level. The weight
    // is that of all it holds up (`heavy`), and so is what it is sped up by.
    let climbs = held_up(&columns) * gravity - gravity;
    // How hard the air holds it back for the square of how fast it falls, for each kilogram of it and of what it holds up
    // on a sling — the air on that is not reckoned: it is slowed no less for it —, as dense as the air is at its height.
    let falls = body.air.map_or(0.0, |(powertrain, facing)| powertrain.air(d.pose.angle, Point::new(0.0, -1.0), facing, body.center.y) / (body.mass * heavy));
    // Leant the other way from where it is pushed: along the field to the right, leant back to the left (`turned`).
    let along = Point::new(cos(lean), sin(lean));
    // What they push it up with level and with no torque, for each kilogram of it alone, as `reach`: all it holds up is
    // `heavy` times that.
    let lifts = held_up(&level) * gravity * heavy;
    let tipped = |lean: f64, lift: f64| (lift * sin(lean.abs()) / cos(lean)).min(sqrt((lifts * lifts - lift * lift).max(0.0)));
    let side = |way: f64, lift: f64| reach(Point::new(way * along.x, way * along.y)) + tipped(if way > 0.0 { leans.0 } else { leans.1 }, lift);
    let off = (lean - poised).clamp(-2.0 * LEAN, 2.0 * LEAN);
    let swung = -gravity * heavy * sin(off) / cos(off);
    let velocity = [d.velocity.x, d.velocity.y];
    let place = [body.center.x, body.center.y];
    let mut station = [d.station.0, d.station.1];
    let (mut wanted, mut weights, mut free) = ([0.0; 2], WEIGHTS, false);
    let mut bounds = [(0.0, 0.0), (-gravity * if asked[0] != 0.0 { DIVE } else { 1.0 }, (lifts / heavy - gravity).max(0.0))];
    for k in [1, 0] {
        if k == 0 {
            let lift = heavy * (gravity + wanted[1]).max(0.0);
            bounds[0] = (-side(-1.0, lift), side(1.0, lift));
            free = !(lift > 0.0);
        }
        // With a load on its sling, along the field it is asked to speed up or slow down the two of them together by no
        // more than `SLUNG` of their weight — itself `heavy` times as much, as the cable holds the load back —; and over
        // that, within all its thrusters give, to go the way the top of the load goes from under it (`FOLLOW`).
        let gentle = if k == 0 && body.hung > 0.0 { SLUNG * gravity * heavy } else { f64::INFINITY };
        if asked[k] != 0.0 {
            station[k] = None;
            let most = if asked[k] < 0.0 { -bounds[k].0 } else { bounds[k].1 };
            wanted[k] = asked[k] * most.min(gentle);
            weights[k] = ASKED[k];
        } else if k == 0 && free {
            // Falling free, with nothing of its thrusters holding it up, it is not held along the field either: what would
            // push it back to where it hovers would slow its fall too — it falls with them idling (squad.js `descentCost`) —,
            // leant now one way and now the other as the lean that does it best swings with how hard they push in the air
            // up there. It is held where it comes to once they hold it up again.
            station[0] = None;
            wanted[0] = 0.0;
        } else {
            if station[k].is_none() && velocity[k].abs() < SETTLE {
                station[k] = Some(place[k]);
            }
            wanted[k] = (-DAMPING * velocity[k] + station[k].map_or(0.0, |at| STATION * (at - place[k]))).clamp(-gentle, gentle)
                - if k == 0 { POISE * swung } else { 0.0 };
        }
        if k == 0 {
            wanted[0] += FOLLOW * body.swing;
        } else if body.hung > 0.0 {
            wanted[1] = wanted[1].max(-DAMPING * (velocity[1] + LOWERED));
        }
        // However it is asked, it comes down no faster than it can still stop from before the ground — as high as it is
        // over the ground it will be over when it is pushed, a step on. With the ground under it rising faster than
        // `RISING`, it is not set down on it but kept off it: it closes on it no faster than it can stop from before
        // it is `CLEARANCE` over it, and that much more as the ground rises in `LEVELLING`; where that takes it up, it
        // hovers where it comes to once it is let be.
        if k == 1 {
            let (rises, slowed) = match body.above {
                Some(above) if rising > RISING =>
                    (true, descent(wanted[1], above - CLEARANCE - LEVELLING * rising - closing.max(0.0) * dt, climbs, SKIM, -closing, 0.0, 0.0, 0.0, dt)),
                Some(above) => (false, descent(wanted[1], above + velocity[1].min(0.0) * dt, climbs, if body.hung > 0.0 { LOWERING } else { (FLARE, ENGAGE) },
                    velocity[1], TOUCH, falls, SETTLING, dt)),
                None => (false, wanted[1]),
            };
            if slowed > wanted[1] {
                (wanted[1], weights[1]) = (slowed, WEIGHTS[1]);
                if rises {
                    station[1] = None;
                }
            }
        }
        wanted[k] = wanted[k].clamp(bounds[k].0, bounds[k].1);
    }
    d.station = (station[0], station[1]);
    // The lean at which they give what is asked with no torque. Asked along the field by its keys, it is leant so only
    // where that pushes it on the way they ask by more, with the air it meets leant so (`Powertrain::air`), than leaning
    // no further than it hovers at — fast, leant over, a hull shows the air its top or its belly —, and goes from one to
    // the other only for more than `SWAY` of its weight.
    let force = Point::new(body.mass * (wanted[0] - body.gravity.x), body.mass * (heavy * wanted[1] - body.gravity.y));
    let weights = [weights[0], weights[1], WEIGHTS[2]];
    let held = [force.x / scale.0, force.y / scale.0, untwist];
    // Asked along the field, it is leant no further than they still hold it up at the height it is asked to keep, the rest
    // of what they push it with going along: leant further, it would sink as it goes and be climbed back.
    let leans = if asked[0] != 0.0 {
        let lift = heavy * (gravity + wanted[1]).max(0.0);
        let most = atan2(sqrt((lifts * lifts - lift * lift).max(0.0)), lift);
        (leans.0.max(-most).min(poised), leans.1.min(most).max(poised))
    } else { leans };
    // A thruster that pushes it against the way it is asked along the field — by its keys, or to stop where it hovers —
    // however far it is leant, as far as it may lean (`leans`: leant to both ends of that, less than half a turn apart,
    // it does so all the way between), weighs `AGAINST` for each newton, so long as the others hold it up level by
    // `SPARE` more than it is asked up (`held_up`): it is given only what they leave of holding it up and turning it,
    // not what it gives as well as they do. Leant back to slow it, the jets that sped it up point up the way it goes:
    // holding it up or turning it as the rest could, they would push it on, so that it came to where it is sent too
    // fast, went past it, and hung there leant to come back with them pushing it away. One that pushes it that way only
    // as it is leant now — one upright, leant the other way at the start of a swing from one side to the other — does
    // not: leant on, it pushes it the way it is asked.
    let against: Vec<bool> = level.iter()
        .map(|c| [leans.0, leans.1].iter().all(|&angle| held[0] * (cos(angle) * c[0] - sin(angle) * c[1]) < 0.0))
        .collect();
    let rest: Vec<[f64; 3]> = level.iter().zip(&against).map(|(&column, &against)| if against { [0.0; 3] } else { column }).collect();
    let costs: Vec<f64> = if against.contains(&true) && held_up(&rest) > held[1] + SPARE {
        costs.iter().zip(&against).map(|(&cost, &against)| if against { AGAINST * cost } else { cost }).collect()
    } else { costs };
    let mut target = leaning(&level, &costs, held, weights, &mut shares.clone(), 1.0, SWEEPS, leans);
    if let Some((powertrain, facing)) = body.air.filter(|_| asked[0] != 0.0 && target.1 != poised) {
        let speed = hypot(d.velocity.x, d.velocity.y);
        let on = |(left, at): ([f64; 3], f64)| asked[0].signum()
            * (held[0] - left[0] - powertrain.air(at, d.velocity, facing, body.center.y) * speed * d.velocity.x / scale.0);
        let mut tried = shares.clone();
        let upright = (share_out(&leant(&level, poised), &costs, held, weights, &mut tried, 1.0, SWEEPS, None).0, poised);
        let (nearer, further) = if (target.1 - lean).abs() <= (poised - lean).abs() { (target, upright) } else { (upright, target) };
        if on(further) > on(nearer) + SWAY {
            target = further;
        } else {
            target = nearer;
        }
    }
    // Turned to that lean, and its spin damped (`LEVEL`), as fast as costs it no more of what it is asked (`turned_out`).
    let steady = -body.inertia * LEVEL.1 * d.omega / (scale.0 * scale.1) + untwist;
    let turning = -body.inertia * LEVEL.0 * (lean - target.1) / (scale.0 * scale.1);
    turned_out(&columns, &costs, [held[0], held[1]], weights, &mut shares, steady, turning);
    // Each thruster that works burns for the thrust it gives, and at least for the idle of its jet; fuel that runs out
    // in the step lasts for the share of it it does.
    let rate: f64 = thrusters.iter().zip(&shares)
        .map(|(&(.., most), share)| SPECIFIC_FUEL * share.max(IDLE_SHARE) * most / FUEL_KG_PER_LITRE)
        .sum();
    let asked_litres = rate * dt / 3600.0;
    let burned = damage.consume_fuel(actor, asked_litres);
    let lasted = if asked_litres > 0.0 { (burned / asked_litres).min(1.0) } else { 1.0 };
    d.fuel_rate += rate * lasted;
    let mut lift = Lift::default();
    for (&(i, at, way, most), share) in thrusters.iter().zip(&shares) {
        let given = share * lasted;
        damage.modules[i].thrust = given;
        let push = Point::new(way.x * most * given, way.y * most * given);
        lift.force.x += push.x;
        lift.force.y += push.y;
        lift.torque += Point::new(at.x - body.center.x, at.y - body.center.y).cross(push);
    }
    lift
}
