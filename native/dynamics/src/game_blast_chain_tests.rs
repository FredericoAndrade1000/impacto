use super::*;

fn impact_chain(together: bool) -> (f64, f64, f64) {
    let mut core = NativeWorld::new(&[], 0.0, 0.0).unwrap();
    let scene = json!({"terrain":"flat","seed":1949,"actors":[
        {"id":"local","handle":1,"vehicle":{"x":0,"y":3,"vx":100,"enabled":true}}],
        "plates":[],"modules":[{"owner":1,"actor":1,"id":"engine","kind":"engine",
        "x":0,"y":3,"width":1,"height":1,"physicalMass":1000,"health":100000,"maxHealth":100000}]});
    core.load_game(&scene.to_string()).unwrap();
    let mut game = core.game.take().unwrap();
    let blast = || crate::game_projectiles::Blast {
        point: Point::new(-1.0, 3.0),
        power: 400.0,
        radius: 4.0,
        source: None,
        actor: None,
        details: json!({}),
    };
    for _ in 0..2 {
        game.projectiles.pending_blasts.push_back(blast());
        if !together {
            game.apply_effects(&mut core, &mut Effects::new(false))
                .unwrap();
        }
    }
    if together {
        game.apply_effects(&mut core, &mut Effects::new(false))
            .unwrap();
    }
    let body = &core.world.bodies[core.bodies[&game.actors[0].body]];
    (body.linvel().x, body.linvel().y, body.angvel())
}

#[test]
fn a_detonation_chain_observes_each_preceding_impulse() {
    let together = impact_chain(true);
    let separate = impact_chain(false);
    assert!(
        together.0 > 100.0,
        "external blasts must still apply a physical impulse"
    );
    assert_eq!(
        together, separate,
        "queueing blasts cannot bypass the moving-body energy budget"
    );
}
