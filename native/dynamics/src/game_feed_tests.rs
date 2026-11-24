//! The feed of a gun as the field runs it (game_motion.rs `ServoState::feed_step`, game_variant.rs `Feed`): a belt fired
//! out is changed in its time, and one half spent is topped up in a lull; an autoloader fires at its cycle from its
//! magazine and its crew puts a round back at a time; a gun loaded by hand fires as it did; and none holds ready more
//! rounds than its boxes do.
use super::*;
use crate::game_variant::{Feed, FeedKind};
use std::f64::consts::PI;

const STEP: f64 = 1.0 / 60.0;

/// A gun fed by `feed`, come in full with as many rounds aboard as it may hold.
fn fed(feed: Feed) -> ServoState {
    let mut servo = ServoState::from_value(1, &json!({}), Default::default());
    servo.load(feed, u32::MAX);
    servo
}
fn made(id: &str) -> Value {
    let mut weapons = crate::game_damage::fixtures::catalogue().clone();
    crate::game_variant::ensure(&mut weapons, id).unwrap();
    weapons[id].clone()
}

#[test]
fn a_gun_is_fed_as_the_catalogue_states_and_a_launcher_a_round_at_a_time() {
    let catalogue = crate::game_damage::fixtures::catalogue();
    // Of the catalogue: the M2 on its belt of 100, changed in its 15 s; the tank gun loaded by hand; a launcher has no feed.
    assert_eq!(Feed::of(&catalogue["m2hb"]), Feed { kind: FeedKind::Belt, rounds: 100, reload: 15.0, per_round: 0.0 });
    assert_eq!(Feed::of(&catalogue["rh120"]), Feed::HAND);
    assert_eq!(Feed::of(&catalogue["at4"]), Feed::HAND);
    // Made over, as `derive` made it: a longer belt takes the links of the rounds it holds past the reference's.
    let long = Feed::of(&made("m2hb|M400"));
    assert_eq!((long.kind, long.rounds), (FeedKind::Belt, 400));
    assert!((long.reload - (15.0 + crate::game_variant::BELT_LINK * 300.0)).abs() < 1e-9, "{}", long.reload);
    // A barrel changed, the belt as the reference's.
    assert_eq!(Feed::of(&made("m2hb|L91")).reload, 15.0);
    let magazine = Feed::of(&made("m777|M12"));
    assert_eq!((magazine.kind, magazine.rounds, magazine.per_round), (FeedKind::Magazine, 12, 12.0));
}

#[test]
fn a_belt_fired_out_is_changed_in_its_time_and_comes_back_as_full_as_the_boxes_let_it() {
    let belt = Feed { kind: FeedKind::Belt, rounds: 20, reload: 2.0, per_round: 0.0 };
    let (mut gun, mut aboard) = (fed(belt), 30);
    assert_eq!(gun.loaded, 20);
    for _ in 0..20 {
        assert!(gun.fed());
        gun.fired_round();
        aboard -= 1;
        gun.feed_step(STEP, aboard, true);
    }
    // Out: the crew changes the belt, and the gun waits for it with its trigger held.
    assert!(!gun.fed() && gun.loaded == 0);
    assert!((gun.feed_left() - (2.0 - STEP)).abs() < 1e-9 && gun.feed_wait() == gun.feed_left());
    let mut waited = STEP;
    while !gun.fed() {
        gun.feed_step(STEP, aboard, true);
        waited += STEP;
        assert!(waited < 3.0);
    }
    assert!(waited >= 2.0 - 1e-9 && waited < 2.0 + STEP + 1e-9, "{waited}");
    // Ten rounds were left of its cartridge aboard: a belt of ten.
    assert_eq!((gun.loaded, gun.feed_left()), (10, 0.0));
    for _ in 0..10 {
        gun.fired_round();
        aboard -= 1;
        gun.feed_step(STEP, aboard, true);
    }
    // With none left aboard there is no belt to put in: it is out of rounds, not changing one.
    assert_eq!((gun.loaded, gun.feed_left(), gun.fed()), (0, 0.0, false));
    // Rounds brought aboard, the crew changes the belt.
    gun.feed_step(STEP, 50, false);
    assert_eq!(gun.feed_reload, 2.0);
}

#[test]
fn a_belt_half_spent_or_more_is_changed_in_a_lull_and_one_fuller_is_not() {
    let belt = Feed { kind: FeedKind::Belt, rounds: 20, reload: 2.0, per_round: 0.0 };
    for (fired, topped) in [(12, true), (10, true), (9, false)] {
        let (mut gun, mut aboard) = (fed(belt), 100);
        for _ in 0..fired {
            gun.fired_round();
            aboard -= 1;
            gun.feed_step(STEP, aboard, true);
        }
        let mut lull = 0.0;
        while lull < crate::game_motion::BELT_LULL - 2.0 * STEP {
            gun.feed_step(STEP, aboard, false);
            lull += STEP;
            assert_eq!(gun.feed_reload, 0.0, "it waits out the lull");
        }
        for _ in 0..((crate::game_motion::BELT_LULL + 3.0) / STEP) as usize { gun.feed_step(STEP, aboard, false); }
        assert_eq!(gun.loaded, if topped { 20 } else { 20 - fired }, "{fired} fired");
        // A gun fed while it fires is never topped up: only a lull.
        let mut firing = fed(belt);
        for _ in 0..fired { firing.fired_round(); }
        for _ in 0..600 { firing.feed_step(STEP, aboard, true); }
        assert_eq!(firing.loaded, 20 - fired);
    }
}

#[test]
fn a_belt_being_topped_up_still_fires_and_its_crew_leaves_it_as_it_is_when_the_trigger_comes_back() {
    // An autocannon's crew takes minutes over its ready boxes: a lull does not hold its gun for them.
    let belt = Feed { kind: FeedKind::Belt, rounds: 20, reload: 300.0, per_round: 0.0 };
    let (mut gun, mut aboard) = (fed(belt), 100);
    for _ in 0..12 {
        gun.fired_round();
        aboard -= 1;
        gun.feed_step(STEP, aboard, true);
    }
    for _ in 0..((crate::game_motion::BELT_LULL + 0.5) / STEP) as usize { gun.feed_step(STEP, aboard, false); }
    assert!(gun.feed_reload > 0.0, "its crew tops it up");
    assert!(gun.fed() && gun.feed_wait() == 0.0, "the gun waits for none of it");
    gun.fired_round();
    gun.feed_step(STEP, aboard - 1, true);
    assert_eq!((gun.loaded, gun.feed_reload), (7, 0.0));
}

#[test]
fn an_autoloader_fires_its_magazine_and_its_crew_puts_a_round_back_at_a_time() {
    let feed = Feed::of(&made("m777|M12"));
    let mut gun = fed(feed);
    // Fired from with the trigger held, the crew puts none back.
    for _ in 0..3 { gun.fired_round(); }
    for _ in 0..600 { gun.feed_step(STEP, 100, true); }
    assert_eq!((gun.loaded, gun.feed_left()), (9, 0.0));
    // Let go, a round every `per_round`: told as how long until it is full.
    gun.feed_step(STEP, 100, false);
    assert!((gun.feed_left() - (3.0 * feed.per_round - STEP)).abs() < 1e-9, "{}", gun.feed_left());
    let mut waited = STEP;
    while gun.loaded < 10 { gun.feed_step(STEP, 100, false); waited += STEP; }
    assert!((waited - feed.per_round).abs() <= STEP + 1e-9, "{waited}");
    for _ in 0..((2.0 * feed.per_round + 1.0) / STEP) as usize { gun.feed_step(STEP, 100, false); }
    assert_eq!((gun.loaded, gun.feed_left(), gun.feed_reload), (12, 0.0, 0.0));
    // Empty, the crew loads it however the trigger is held, and it fires each round as it goes in.
    for _ in 0..12 { gun.fired_round(); }
    assert!(!gun.fed());
    let mut waited = 0.0;
    while !gun.fed() { gun.feed_step(STEP, 100, true); waited += STEP; }
    assert!((waited - feed.per_round).abs() <= STEP + 1e-9, "{waited}");
    assert_eq!(gun.loaded, 1);
    gun.feed_step(STEP, 100, true);
    assert_eq!((gun.loaded, gun.feed_reload), (1, 0.0), "a round ready and the trigger held: it fires that one");
}

#[test]
fn a_gun_loaded_by_hand_is_fed_as_it_fires_and_holds_the_round_it_fires_next() {
    let mut gun = fed(Feed::HAND);
    assert_eq!(gun.loaded, 1);
    gun.fired_round();
    assert!(gun.fed(), "its rate alone holds it");
    gun.feed_step(STEP, 3, true);
    assert_eq!((gun.loaded, gun.feed_left(), gun.feed_wait()), (1, 0.0, 0.0));
    gun.feed_step(STEP, 0, true);
    assert_eq!(gun.loaded, 0);
}

#[test]
fn no_feed_holds_ready_more_rounds_than_its_boxes() {
    for feed in [Feed { kind: FeedKind::Belt, rounds: 50, reload: 4.0, per_round: 0.0 }, Feed::of(&made("m777|M12")), Feed::HAND] {
        let mut gun = ServoState::from_value(1, &json!({}), Default::default());
        gun.load(feed, 7);
        assert_eq!(gun.loaded, feed.rounds.min(7));
        // A box shot away takes its rounds from the belt and the magazine as well.
        gun.feed_step(STEP, 2, false);
        assert!(gun.loaded <= 2);
        for _ in 0..3000 { gun.feed_step(STEP, 2, false); assert!(gun.loaded <= 2); }
    }
    // What a construction turned about told of its feed comes back as it was: the rest of a belt change, and of a
    // magazine the round going in out of how long until it is full.
    let belt = Feed { kind: FeedKind::Belt, rounds: 20, reload: 8.0, per_round: 0.0 };
    let mut gun = ServoState::from_value(1, &json!({"loaded":0,"feedReload":5.5}), Default::default());
    gun.load(belt, 100);
    assert_eq!((gun.loaded, gun.feed_reload), (0, 5.5));
    let magazine = Feed::of(&made("m777|M12"));
    let mut gun = fed(magazine);
    for _ in 0..4 { gun.fired_round(); }
    for _ in 0..90 { gun.feed_step(STEP, 100, false); }
    let told = gun.to_value();
    let mut again = ServoState::from_value(1, &told, Default::default());
    again.load(magazine, 100);
    assert_eq!(again.loaded, gun.loaded);
    assert!((again.feed_reload - gun.feed_reload).abs() < 1e-9 && (again.feed_left() - gun.feed_left()).abs() < 1e-9);
}

/// A box 5.8 m long and 2 m high on wheels, with `preset` through its front wall (to the left), a box of its rounds and a
/// camera on its roof (game_mount_tests.rs `source`).
fn design(preset: &str) -> Value {
    let plate = |id: &str, a: &str, b: &str| json!({"id":id,"a":a,"b":b,"material":"steel","thicknessMm":20});
    let floor = -2;
    json!({"version":crate::CONSTRUCTION_VERSION,"preset":"vehicle","name":"Fed","seed":6173,
        "chassis":{"model":"wheeled","points":[{"x":-58,"y":-2},{"x":58,"y":-2}],"thicknessMm":20.0,"axles":[-42,0,42]},
        "nodes":[{"id":"hull-0","x":-58,"y":floor},{"id":"hull-1","x":58,"y":floor},{"id":"hull-2","x":58,"y":floor+40},{"id":"hull-3","x":-58,"y":floor+40}],
        "plates":[plate("hull:floor","hull-0","hull-1"),plate("hull:rear","hull-1","hull-2"),
            plate("hull:roof","hull-2","hull-3"),plate("hull:front","hull-3","hull-0")],"components":[
        {"id":"command","kind":"command","pose":{"x":5,"y":7,"angle":0}},
        {"id":"engine","kind":"engine","pose":{"x":-13,"y":9,"angle":0}},
        {"id":"ammo","kind":"ammo","ammoPreset":crate::game_variant::cartridge(preset),"pose":{"x":8,"y":23,"angle":0}},
        {"id":"fuel","kind":"fuel","pose":{"x":28,"y":12,"angle":0}},
        {"id":"gun","kind":"weapon","weaponPreset":preset,"pose":{"x":-56,"y":18,"angle":-PI},
            "mount":{"preset":"light-trunnion","sector":{"min":-0.2,"max":0.2}}},
        {"id":"camera","kind":"sensor","sensorMode":"visual","pose":{"x":17,"y":41,"angle":0}}]})
}
struct Duel { core: NativeWorld, game: GameState, index: usize, owner: u32, settings: Settings, aim: Point, clock: f64 }
/// Two of `source` 200 m apart, the first turned to face the second, settled a second; the first's gun made over as
/// `made` asks, if it asks (the gun it was, of the same build, fed as that one), its box holding `rounds` and its gun
/// loaded from it; and the trigger it would hold to fire along its bore.
fn duel(source: &Value, rounds: u32, made: Option<&str>) -> Duel {
    let mut core = crate::game_damage::fixtures::duel([source, source], 200.0);
    let mut game = core.game.take().unwrap();
    let index = game.actors.iter().position(|a| a.handle == 1).unwrap();
    let gun = game.damage.modules.iter().find(|m| m.actor == 1 && m.kind == ComponentKind::Weapon).unwrap();
    let (owner, angle, id) = (gun.owner, gun.barrel_angle, gun.cold["id"].clone());
    let tip = muzzle_point(Point::new(gun.pose.x, gun.pose.y), angle, gun.barrel_end);
    let aim = Point::new(tip.x + 300.0 * cos(angle), tip.y + 300.0 * sin(angle));
    if let Some(made) = made {
        crate::game_variant::ensure(&mut game.catalogue, made).unwrap();
        game.damage.module_mut(owner).unwrap().weapon_preset = made.into();
    }
    let preset = game.damage.module(owner).unwrap().weapon_preset.clone();
    let cartridge = crate::game_variant::cartridge(&preset);
    for (n, ammo) in game.damage.modules.iter_mut().filter(|m| m.actor == 1 && m.kind == ComponentKind::Ammo && m.ammo_preset == cartridge).enumerate() {
        ammo.rounds = if n == 0 { rounds } else { 0 };
    }
    let k = game.servos.iter().position(|s| s.owner == owner).unwrap();
    game.servos[k].loaded = u32::MAX;
    game.servos[k].load(Feed::of(&game.catalogue[&preset]), rounds);
    let settings = Settings::admit(&game.catalogue, &json!({"preset":preset,"componentId":id,"platform":"vehicle",
        "aimAngle":angle,"charge":1.0}), Some(owner), true).unwrap();
    Duel { core, game, index, owner, settings, aim, clock: 0.0 }
}
impl Duel {
    fn servo(&self) -> &ServoState { self.game.servos.iter().find(|s| s.owner == self.owner).unwrap() }
    fn aboard(&self) -> u32 {
        let aboard = rounds_aboard(&self.game.damage);
        aboard_for(&aboard, self.game.damage.module(self.owner).unwrap())
    }
    fn hold(&mut self, held: bool) {
        let a = &mut self.game.actors[self.index];
        a.aim = self.aim;
        a.weapon = Some(self.settings.clone());
        a.trigger = held.then(|| (self.aim, self.settings.clone()));
    }
    /// Steps the field for `seconds`, the first's construction still: when each round of its gun left, s on the clock of
    /// the duel, and how many left in each step.
    fn run(&mut self, seconds: f64) -> (Vec<f64>, Vec<u64>) {
        let (mut times, mut volleys) = (Vec::new(), Vec::new());
        for _ in 0..(seconds / STEP).round() as usize {
            let drive = self.game.actors[self.index].drive.as_mut().unwrap();
            (drive.velocity, drive.omega) = (Point::ZERO, 0.0);
            let before = self.game.actors[self.index].shots;
            self.game.step(&mut self.core, STEP).unwrap();
            let shots = self.game.actors[self.index].shots - before;
            times.extend((0..shots).map(|_| self.clock));
            volleys.push(shots);
            self.clock += STEP;
            assert!(self.servo().loaded <= self.aboard(), "no more ready than its boxes hold");
        }
        (times, volleys)
    }
}

#[test]
fn a_held_trigger_fires_out_its_belt_waits_for_the_change_and_fires_again() {
    let mut duel = duel(&design("minimi|M20"), 100, None);
    let feed = duel.servo().feed;
    assert_eq!((feed.kind, feed.rounds, duel.servo().loaded), (FeedKind::Belt, 20, 20));
    assert_eq!(feed.reload, duel.game.catalogue["minimi|M20"]["feed"]["reloadS"].as_f64().unwrap());
    duel.hold(true);
    let (times, _) = duel.run(feed.reload + 4.0);
    assert!(times.len() > 25, "{} rounds", times.len());
    // Its twenty at its rate, then the wait of the change, then at its rate again.
    let period = 60.0 / duel.settings.rate;
    for pair in times[..20].windows(2).chain(times[21..].windows(2)) { assert!(pair[1] - pair[0] <= period + STEP + 1e-9, "{pair:?}"); }
    let gap = times[20] - times[19];
    assert!(gap >= feed.reload - 1e-9 && gap < feed.reload + STEP + 1e-9, "{gap} for {}", feed.reload);
    assert_eq!(duel.aboard() as usize, 100 - times.len());
    // The frames tell it of the gun, beside its reload.
    let frame = duel.game.frame();
    let told = frame["modules"].as_array().unwrap().iter().find(|m| m["owner"] == duel.owner).unwrap();
    assert_eq!((told["loaded"].as_u64(), told["feedReload"].as_f64()), (Some(u64::from(duel.servo().loaded)), Some(duel.servo().feed_left())));
}

#[test]
fn a_belt_half_spent_is_changed_once_the_trigger_has_been_let_go_a_while() {
    let mut duel = duel(&design("minimi|M20"), 100, None);
    let feed = duel.servo().feed;
    duel.hold(true);
    while duel.game.actors[duel.index].shots < 12 { duel.run(STEP); }
    duel.hold(false);
    assert_eq!(duel.servo().loaded, 8);
    duel.run(crate::game_motion::BELT_LULL - 2.0 * STEP);
    assert_eq!((duel.servo().loaded, duel.servo().feed_reload), (8, 0.0));
    duel.run(4.0 * STEP);
    assert!(duel.servo().feed_reload > feed.reload - 4.0 * STEP, "its crew is changing it");
    duel.run(feed.reload);
    assert_eq!((duel.servo().loaded, duel.servo().feed_reload), (20, 0.0));
}

#[test]
fn a_rotary_gun_fires_no_round_past_its_belt_however_many_it_fires_in_a_step() {
    let mut duel = duel(&design("minimi|N7|M20"), 100, None);
    let feed = duel.servo().feed;
    assert!(duel.servo().spin_up > 0.0 && duel.settings.rate > 3600.0, "{}", duel.settings.rate);
    duel.hold(true);
    let (times, volleys) = duel.run(2.0);
    assert!(volleys.iter().any(|n| *n > 1), "it fires more than one round in a step");
    // Its belt out mid-step, it fires the rest of the step none: its belt is being changed.
    assert_eq!(times.len(), 20);
    assert!(duel.servo().feed_reload > feed.reload - 2.0);
    assert_eq!(duel.aboard(), 80);
}

#[test]
fn an_autoloader_fires_at_its_cycle_until_its_magazine_is_out_then_as_its_crew_loads_it() {
    // The tank gun given a magazine of four (the gun of the stock heavy, fed as one so made), and a crew a little slower
    // than its autoloader.
    let source = crate::game_templates::source("heavy", &json!({}), crate::game_damage::fixtures::full_catalogue()).unwrap();
    let mut duel = duel(&source, 40, Some("rh120|M4"));
    let k = duel.game.servos.iter().position(|s| s.owner == duel.owner).unwrap();
    let cycle = duel.game.catalogue["rh120|M4"]["feed"]["cycleS"].as_f64().unwrap();
    duel.game.servos[k].feed.per_round = cycle + 2.0;
    let feed = duel.servo().feed;
    assert_eq!((feed.kind, feed.rounds, duel.servo().loaded), (FeedKind::Magazine, 4, 4));
    assert!((60.0 / duel.settings.rate - cycle).abs() < 1e-9, "it fires as fast as it rams a round");
    duel.hold(true);
    let mut times = Vec::new();
    while times.len() < 6 {
        times.extend(duel.run(STEP).0);
        assert!(duel.clock < 3.0 * cycle + 2.0 * feed.per_round + 2.0, "{times:?}");
    }
    for pair in times[..4].windows(2) { assert!((pair[1] - pair[0] - cycle).abs() <= STEP + 1e-9, "{pair:?}"); }
    for pair in times[3..].windows(2) { assert!((pair[1] - pair[0] - feed.per_round).abs() <= STEP + 1e-9, "{pair:?}"); }
    // Let go, its crew fills it a round at a time.
    duel.hold(false);
    duel.run(feed.per_round);
    assert_eq!(duel.servo().loaded, 1);
    let left = duel.servo().feed_left();
    assert!(left > 2.0 * feed.per_round && left <= 3.0 * feed.per_round, "{left}");
}

#[test]
fn a_gun_struck_through_its_compartment_loses_its_ready_rounds_in_a_blast_and_is_fed_no_more() {
    // The M2 on a belt of 400: its can as long as its receiver beside it.
    // Its mount, grown for the gun, stands a little farther from the front wall than the M2's.
    let mut source = design("m2hb|M400");
    source["components"][4]["pose"]["x"] = json!(-50);
    let mut duel = duel(&source, 1000, None);
    duel.run(STEP);
    let gun = duel.game.damage.module(duel.owner).unwrap();
    assert!(gun.ready_length > 0.77 - 1e-9 && gun.ready == 400, "its belt ready in its compartment: {}", gun.ready);
    let moving = Pose { angle: gun.barrel_angle, ..gun.pose };
    // Its can as long as its receiver beside it: struck anywhere behind the trunnion, never on the barrel before it.
    let (back, barrel) = (moving.world_point(Point::new(-gun.width + gun.ready_length / 2.0, 0.0)), moving.world_point(Point::new(0.3, 0.0)));
    assert!((gun.ready_length - gun.width).abs() < 1e-9 && gun.ready_strike(back) && !gun.ready_strike(barrel));
    let (most, once) = (gun.max_health, gun.max_health * crate::game_damage::READY_COOKS * 0.6);
    // Hit once, it holds; hit again past what it bears, its rounds go off with it.
    let mut effects = Effects::default();
    duel.game.damage.damage_module(duel.owner, once, back, &mut effects);
    assert!(effects.detonations.is_empty() && !duel.game.damage.module(duel.owner).unwrap().belt_cut);
    duel.game.damage.damage_module(duel.owner, once, back, &mut effects);
    let gun = duel.game.damage.module(duel.owner).unwrap();
    assert!(gun.belt_cut && gun.ready == 0 && gun.health > 0.0 && gun.health < most);
    assert_eq!(effects.detonations.len(), 1);
    // As large a blast as a box of the 400 rounds would make, amid them.
    let blast = &effects.detonations[0];
    let rounds = 400.0 * crate::game_damage::fixtures::catalogue()["m2hb"]["cartridge"]["litres"].as_f64().unwrap() / 1000.0;
    let size = (rounds / crate::game_geometry::AMMUNITION_PACKING / (0.78 * 0.65 * 0.45)).cbrt();
    assert!((blast.power - 540.0 * size).abs() < 1e-9 && blast.point.distance(back) < 1e-9, "{blast:?}");
    // Its boxes still hold rounds, but none is fed to it: from the end of the step it was struck in (here, the next), its
    // trigger held, it fires none.
    assert!(duel.aboard() == 0 && rounds_aboard(&duel.game.damage).values().sum::<u32>() > 0);
    duel.run(STEP);
    assert_eq!(duel.servo().loaded, 0);
    duel.hold(true);
    let (times, _) = duel.run(2.0);
    assert!(times.is_empty() && duel.servo().loaded == 0 && duel.servo().feed_left() == 0.0);
}

#[test]
fn through_blow_out_panels_the_rounds_of_a_compartment_go_off_out_of_its_roof_and_spare_their_own_construction() {
    use crate::game_damage::{add, length, point, scale};
    // What the blast of the 400 rounds of the M2's can, struck, leaves of its own construction: with its can's roof of
    // panels, all of it; without, not.
    let struck = |id: &str| {
        let mut source = design(id);
        source["components"][4]["pose"]["x"] = json!(-50);
        let mut duel = duel(&source, 1000, None);
        duel.run(STEP);
        let gun = duel.game.damage.module(duel.owner).unwrap().clone();
        let back = Pose { angle: gun.barrel_angle, ..gun.pose }.world_point(Point::new(-gun.width + gun.ready_length / 2.0, 0.0));
        let mut effects = Effects::default();
        duel.game.damage.damage_module(duel.owner, gun.max_health * crate::game_damage::READY_COOKS, back, &mut effects);
        assert_eq!(effects.detonations.len(), 1, "{id}");
        let blast = effects.detonations[0].clone();
        let actor = gun.actor;
        let whole = |duel: &Duel| -> (f64, usize) {
            (duel.game.damage.modules.iter().filter(|m| m.actor == actor).map(|m| m.health).sum(),
                duel.game.damage.plates.iter().filter(|p| p.actor == actor).map(|p| p.marks.len()).sum())
        };
        let before = whole(&duel);
        duel.game.projectiles.pending_blasts.push_back(blast.clone());
        duel.run(STEP);
        (gun, back, blast, before, whole(&duel))
    };
    let (_, _, open, before, after) = struck("m2hb|M400");
    assert!(open.details["vented"].is_null());
    assert!(after.0 < before.0 - 1e-6, "it harms its own construction: {before:?} {after:?}");
    let (gun, back, vented, before, after) = struck("m2hb|M400|V1");
    assert!(gun.ready_vented);
    // As large a blast, out of the roof of the can: the face of it that looks up, half its height over amid its rounds.
    assert!((vented.power - open.power).abs() < 1e-9 && vented.details["vented"] == true, "{vented:?}");
    let up = point(vented.details["nx"].as_f64().unwrap(), vented.details["ny"].as_f64().unwrap());
    assert!(up.y > 0.0 && (length(up) - 1.0).abs() < 1e-9);
    assert!(vented.point.distance(add(back, scale(up, gun.height / 2.0))) < 1e-9, "{vented:?}");
    assert_eq!(after, before, "its own construction is spared");
}
