//! Solver invariants use typed Rapier objects; the host has no second solver protocol.
use super::*;

fn body(
    core: &mut NativeWorld,
    id: u32,
    x: f64,
    y: f64,
    dynamic: bool,
    deferred: bool,
) -> RigidBodyHandle {
    let handle = core.world.insert_body(
        RigidBodyBuilder::new(if dynamic {
            RigidBodyType::Dynamic
        } else {
            RigidBodyType::Fixed
        })
        .translation(Vector::new(x, y))
        .can_sleep(false)
        .ccd_enabled(true)
        .soft_ccd_prediction(0.04)
        .additional_mass_properties(MassProperties::new(Vector::ZERO, 1000.0, 100.0)),
    );
    core.bodies.insert(id, handle);
    if !deferred {
        core.world.bodies[handle].recompute_mass_properties_from_colliders(&core.world.colliders);
    }
    handle
}
fn ball(core: &mut NativeWorld, id: u32, parent: u32, actor: u32) {
    core.insert_collider(
        id,
        parent,
        ColliderBuilder::ball(0.5)
            .density(0.0)
            .friction(0.6)
            .restitution(0.025)
            .contact_skin(0.0002),
        Metadata {
            object: id,
            actor,
            sprung: 0,
        },
    )
    .unwrap();
}
fn frames(core: &mut NativeWorld, count: u32) {
    for frame in 0..count {
        core.solve(1.0 / 60.0, 0.0, frame as f64 / 60.0)
            .unwrap();
        assert_eq!(core.invalid_reason, 0);
    }
}

fn unequal_energy_world() -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    for (i, speed) in [100_000_000.0_f64, 1.0, 1.0].into_iter().enumerate() {
        let handle = core.world.insert_body(
            RigidBodyBuilder::dynamic()
                .translation(Vector::new(i as f64 * 10.0, 3.0))
                .linvel(Vector::new(speed, 0.0))
                .can_sleep(false)
                .additional_mass_properties(MassProperties::new(Vector::ZERO, 2.0, 1.0)),
        );
        core.bodies.insert(i as u32 + 1, handle);
        core.world.bodies[handle].recompute_mass_properties_from_colliders(&core.world.colliders);
    }
    core
}

#[test]
fn stability_snapshot_preserves_arena_order_and_each_existing_energy_term_bit() {
    let core = unequal_energy_world();
    let snapshot = core.stability_snapshot();
    assert_eq!(
        snapshot
            .iter()
            .map(|(handle, _)| *handle)
            .collect::<Vec<_>>(),
        core.world
            .bodies
            .iter()
            .map(|(handle, _)| handle)
            .collect::<Vec<_>>()
    );
    let terms = snapshot
        .iter()
        .map(|(_, motion)| motion.energy())
        .collect::<Vec<_>>();
    let expected = [1e16_f64, 1.0, 1.0];
    assert_eq!(
        terms.iter().map(|term| term.to_bits()).collect::<Vec<_>>(),
        expected
            .iter()
            .map(|term| term.to_bits())
            .collect::<Vec<_>>()
    );
    let forward: f64 = terms.iter().copied().sum();
    let reverse: f64 = terms.iter().rev().copied().sum();
    assert_eq!(forward.to_bits(), 1e16_f64.to_bits());
    assert_eq!(reverse.to_bits(), (1e16_f64 + 2.0).to_bits());
    assert_ne!(forward.to_bits(), reverse.to_bits());
    // Random hash seeds may permute a map, but they cannot affect this snapshot.
    for _ in 0..32 {
        let independent_map: HashMap<_, _> = snapshot.iter().copied().collect();
        let ordered: f64 = snapshot
            .iter()
            .map(|(handle, _)| independent_map[handle].energy())
            .sum();
        assert_eq!(ordered.to_bits(), forward.to_bits());
    }
}

#[test]
fn independent_worlds_repeat_identical_energy_audits_and_motion_bits() {
    let mut a = unequal_energy_world();
    let mut b = unequal_energy_world();
    for step in 0..64 {
        a.solve(1.0 / 60.0, 0.0, step as f64 / 60.0).unwrap();
        b.solve(1.0 / 60.0, 0.0, step as f64 / 60.0).unwrap();
        assert_eq!(a.invalid_reason, 0);
        assert_eq!(a.energy_audit.to_value(), b.energy_audit.to_value());
        for ((ha, ma), (hb, mb)) in a.stability_snapshot().iter().zip(b.stability_snapshot()) {
            assert_eq!(*ha, hb);
            for (left, right) in [
                (ma.position.x, mb.position.x),
                (ma.position.y, mb.position.y),
                (ma.rotation.angle(), mb.rotation.angle()),
                (ma.velocity.x, mb.velocity.x),
                (ma.velocity.y, mb.velocity.y),
                (ma.omega, mb.omega),
            ] {
                assert_eq!(left.to_bits(), right.to_bits());
            }
        }
    }
}

#[test]
fn accepted_impulses_and_mass_changes_preserve_the_explicit_com() {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let handle = body(&mut core, 1, 2.0, 3.0, true, false);
    let b = &mut core.world.bodies[handle];
    b.set_additional_mass_properties(
        MassProperties::new(Vector::new(0.25, -0.1), 2000.0, 150.0),
        false,
    );
    b.recompute_mass_properties_from_colliders(&core.world.colliders);
    b.apply_impulse(Vector::new(4000.0, 0.0), true);
    b.apply_torque_impulse(300.0, true);
    assert!((b.mass() - 2000.0).abs() < 0.001);
    assert!((b.angvel() - 2.0).abs() < 1e-6);
    assert!((b.linvel().x - 2.0).abs() < 1e-6);
    assert!(
        (b.center_of_mass().x - 2.25).abs() < 1e-6 && (b.center_of_mass().y - 2.9).abs() < 1e-6
    );
    frames(&mut core, 1);
    assert!(core.world.bodies[handle].translation().x > 2.0);
}
#[test]
fn stability_budget_uses_mass_captured_before_solving() {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let handle = body(&mut core, 1, 0.0, 3.0, true, true);
    ball(&mut core, 1, 1, 1);
    assert_eq!(core.world.bodies[handle].mass(), 0.0);
    core.world.bodies[handle].set_linvel(Vector::new(2.0, 0.0), true);
    frames(&mut core, 1);
    assert!(core.world.bodies[handle].mass() > 900.0 && core.world.bodies[handle].linvel().x > 1.9);
    assert_eq!(core.energy_audit.last.before, 0.0);
}
#[test]
fn gravity_contact_transfers_real_impulse_and_settles_without_creating_energy() {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let handle = body(&mut core, 1, 0.0, 2.0, true, false);
    ball(&mut core, 1, 1, 1);
    core.world.bodies[handle].set_linvel(Vector::new(0.0, -10.0), true);
    let mut impact = false;
    let mut quiet = false;
    for frame in 0..90 {
        let before = Motion::capture(&core.world.bodies[handle]);
        core.solve(1.0 / 60.0, 0.0, frame as f64 / 60.0)
            .unwrap();
        assert_eq!(core.invalid_reason, 0);
        if let Some(pair) = core
            .world
            .narrow_phase
            .contact_pair(core.colliders[&1], core.colliders[&0])
        {
            let impulse = pair
                .manifolds()
                .iter()
                .flat_map(|m| &m.points)
                .map(|point| point.data.impulse as f64)
                .sum::<f64>();
            let closing = -before.velocity.y as f64;
            impact |= impulse > 45.0
                && closing > 10.0
                && before.mass * closing * closing / 2.0 > 50_000.0;
            quiet |= impact
                && core.world.bodies[handle].linvel().length() < 0.12
                && pair
                    .manifolds()
                    .iter()
                    .any(|m| !m.data.solver_contacts.is_empty());
        }
    }
    assert!(impact && quiet);
    assert!((core.world.bodies[handle].translation().y - 0.5).abs() < 0.003);
    let pair = core
        .world
        .narrow_phase
        .contact_pair(core.colliders[&1], core.colliders[&0])
        .unwrap();
    assert!(
        pair.manifolds()
            .iter()
            .any(|m| !m.data.solver_contacts.is_empty())
    );
}
#[test]
fn oriented_polyline_ground_supports_a_body() {
    let mut core = NativeWorld::new(&[10.0, 1.0, -10.0, 1.0], 0.0, -9.81).unwrap();
    let handle = body(&mut core, 1, 0.0, 2.0, true, false);
    ball(&mut core, 1, 1, 1);
    frames(&mut core, 180);
    assert!((core.world.bodies[handle].translation().y - 1.5).abs() < 0.003);
}
fn motor_scene(budget: f64, loaded_impulse: f64) -> NativeWorld {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let a = body(&mut core, 1, 0.0, 4.0, false, false);
    let b = body(&mut core, 2, 0.0, 4.0, true, false);
    core.world.bodies[b].apply_impulse(Vector::new(loaded_impulse, 0.0), true);
    let mut joint: GenericJoint = RevoluteJointBuilder::new().build().into();
    joint
        .set_contacts_enabled(false)
        .set_motor_model(JointAxis::AngX, MotorModel::ForceBased)
        .set_motor_position(JointAxis::AngX, 0.5, 1e8, 0.0)
        .set_motor_max_force(JointAxis::AngX, 1e9);
    core.world.insert_impulse_joint(a, b, joint);
    core.solve(1.0 / 60.0, budget, 0.0).unwrap();
    core
}
#[test]
fn force_motor_budget_and_solver_recovery_keep_game_limits() {
    let rejected = motor_scene(0.0, 0.0);
    let accepted = motor_scene(1e8, 0.0);
    assert_eq!(rejected.invalid_reason, 2);
    let b = &rejected.world.bodies[rejected.bodies[&2]];
    assert_eq!(b.angvel(), 0.0);
    assert_eq!(b.rotation().angle(), 0.0);
    assert_eq!(rejected.energy_audit.last.invalid, 2);
    assert_eq!(rejected.energy_audit.last.constraint_energy, 0.0);
    assert_eq!(accepted.invalid_reason, 0);
    assert!(accepted.world.bodies[accepted.bodies[&2]].angvel().abs() > 0.1);
}
#[test]
fn corrective_work_requires_live_overlap_and_stays_with_its_own_body() {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let touching = body(&mut core, 1, 0.0, 0.4, true, false);
    ball(&mut core, 1, 1, 1);
    core.world.bodies[touching].set_linvel(Vector::new(0.0, -1.0), true);
    let separate = body(&mut core, 2, 5.0, 4.0, true, false);
    let before = core.stability_snapshot();
    core.solve(1.0 / 60.0, 0.0, 0.0).unwrap();
    assert_eq!(core.invalid_reason, 0);
    assert!(core.world.narrow_phase.contact_pairs().any(|pair| pair.has_any_active_contact()));
    let credit = core.corrective_work(&before, &[(touching, 10.0)], 1.0 / 60.0);
    assert!(credit > 0.0 && credit <= 10.0);
    assert_eq!(core.corrective_work(&before, &[(separate, 1e8)], 1.0 / 60.0), 0.0);
    // The old contact's impulse/dist may remain cached after the body has moved clear.
    // Neither the current anchors nor the pre-solve sample now overlap the ground.
    core.world.bodies[touching].set_translation(Vector::new(0.0, 0.7), true);
    let separated = core.stability_snapshot();
    assert_eq!(core.corrective_work(&separated, &[(touching, 1e8)], 1.0 / 60.0), 0.0);
}
#[test]
fn solver_rollback_and_invalid_inputs_preserve_incoming_momentum() {
    let mut core = motor_scene(0.0, 120.0);
    assert_eq!(core.invalid_reason, 2);
    let handle = core.bodies[&2];
    let before = Motion::capture(&core.world.bodies[handle]);
    assert!((before.velocity.x - 0.12).abs() < 1e-7);
    assert_eq!(before.velocity.y, 0.0);
    assert_eq!(before.position, Vector::new(0.0, 4.0));
    assert_eq!(before.rotation.angle(), 0.0);
    assert_eq!(before.omega, 0.0);
    for dt in [f64::NAN, f64::INFINITY, -1.0] {
        assert!(core.solve(dt, 0.0, 0.0).is_err());
        let after = Motion::capture(&core.world.bodies[handle]);
        assert_eq!(after.position, before.position);
        assert_eq!(after.velocity, before.velocity);
        assert_eq!(after.omega, before.omega);
        assert_eq!(after.mass, before.mass);
    }
}
#[test]
fn rotating_rigid_body_transfers_momentum_at_an_offset_without_created_energy() {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let handle = body(&mut core, 1, 0.0, 3.0, true, false);
    core.insert_collider(
        1,
        1,
        ColliderBuilder::cuboid(1.0, 0.01)
            .translation(Vector::new(0.5, 0.0))
            .density(0.0),
        Metadata {
            object: 1,
            actor: 1,
            sprung: 0,
        },
    )
    .unwrap();
    let target = body(&mut core, 2, 1.45, 3.15, true, false);
    core.insert_collider(
        2,
        2,
        ColliderBuilder::ball(0.04).density(0.0),
        Metadata {
            object: 2,
            actor: 2,
            sprung: 0,
        },
    )
    .unwrap();
    core.world.bodies[handle].set_angvel(20.0, true);
    for step in 0..4 {
        core.solve(1.0 / 240.0, 0.0, step as f64 / 240.0)
            .unwrap();
        assert_eq!(core.invalid_reason, 0);
    }
    let body = &core.world.bodies[handle];
    let target = &core.world.bodies[target];
    assert!(
        target.linvel().y > 0.1,
        "the rotating edge reaches the other bullet"
    );
    assert!(body.angvel() < 20.0);
    assert!((body.linvel() + target.linvel()).length() < 0.001);
    assert!(Motion::capture(body).energy() + Motion::capture(target).energy() <= 20_000.0);
}
#[test]
fn prismatic_force_motor_supports_weight_with_travel_budget() {
    let mut core = NativeWorld::new(&[], 0.0, -9.81).unwrap();
    let a = body(&mut core, 1, 0.0, 3.0, false, false);
    let b = body(&mut core, 2, 0.0, 3.0, true, false);
    let mut joint: GenericJoint = PrismaticJointBuilder::new(Vector::Y).build().into();
    joint
        .set_contacts_enabled(false)
        .set_limits(JointAxis::LinX, [-0.2, 0.2])
        .set_motor_model(JointAxis::LinX, MotorModel::ForceBased)
        .set_motor_position(JointAxis::LinX, 0.0, 100_000.0, 15_000.0)
        .set_motor_max_force(JointAxis::LinX, 20_000.0);
    core.world.insert_impulse_joint(a, b, joint);
    for frame in 0..180 {
        core.solve(1.0 / 60.0, 8000.0, frame as f64 / 60.0)
            .unwrap();
        assert_eq!(core.invalid_reason, 0);
    }
    let b = &core.world.bodies[b];
    assert!((b.translation().y - (3.0 - 9810.0 / 100_000.0)).abs() < 0.003);
    assert!(
        b.translation().x.abs() < 1e-6
            && b.rotation().angle().abs() < 1e-6
            && b.linvel().y.abs() < 0.01
    );
}
#[test]
fn invalid_solver_inputs_are_rejected_synchronously() {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    assert!(core.solve(0.0, 0.0, 0.0).is_err());
    assert!(core.solve(1.0 / 60.0, -1.0, 0.0).is_err());
    assert!(core.solve(1.0 / 60.0, 0.0, f64::NAN).is_err());
    assert!(NativeWorld::new(&[1.0], 0.0, 0.0).is_err());
}
