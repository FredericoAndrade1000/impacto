//! A bounded native CPU budget shared by perception and pilot calculations, and the
//! single worker the physics steps on. Worlds borrow their scene in place; workers
//! never own another copy of it.
use std::sync::{Arc, OnceLock};

pub(crate) fn pool() -> &'static Arc<rayon::ThreadPool> {
    static POOL: OnceLock<Arc<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| {
        let threads = std::thread::available_parallelism().map_or(1, usize::from).min(4);
        Arc::new(rayon::ThreadPoolBuilder::new().num_threads(threads)
            .thread_name(|index| format!("impacto-simulation-{index}"))
            .build().expect("Failed to create the simulation worker pool"))
    })
}

/// The pool Rapier steps on: one worker. On a pool of more than one, Rapier 0.36 hands its
/// deferred BVH optimization to `rayon::spawn` and joins it at the next collision detection
/// with a blocking `mpsc::recv` on the worker running the step, which then runs nothing else.
/// Under load that join can wait for good: found on 2026-11-20 with the step's worker parked
/// in that `recv`, the optimization never run and the other workers asleep. With one worker
/// Rapier runs the same pass inline at the join, which leaves the same tree: the field steps
/// as it did on four (a test comparing one and four workers step by step showed it, until
/// four workers were given up).
pub(crate) fn physics_pool() -> &'static Arc<rayon::ThreadPool> {
    static POOL: OnceLock<Arc<rayon::ThreadPool>> = OnceLock::new();
    POOL.get_or_init(|| Arc::new(rayon::ThreadPoolBuilder::new().num_threads(1)
        .thread_name(|_| "impacto-physics".into())
        .build().expect("Failed to create the physics worker")))
}

#[cfg(feature = "native-parallel")]
pub(crate) fn reserve_physics() -> std::sync::MutexGuard<'static, ()> {
    // Rapier's staged solver reserves all pool workers. Concurrent worlds must not
    // enter separate solver barriers on the same workers (live field + replay).
    static STEP: std::sync::Mutex<()> = std::sync::Mutex::new(());
    STEP.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(all(test, feature = "native-parallel"))]
mod tests {
    use super::*;
    use crate::NativeWorld;

    #[test]
    fn physics_worlds_share_the_single_worker_even_after_checkpoint_restore() {
        let mut a = NativeWorld::new(&[],0.0,-9.81).unwrap();
        let b = NativeWorld::new(&[],0.0,-9.81).unwrap();
        assert_eq!(physics_pool().current_num_threads(),1);
        assert!(Arc::ptr_eq(&a.world.thread_pool().unwrap(),physics_pool()));
        assert!(Arc::ptr_eq(&b.world.thread_pool().unwrap(),physics_pool()));
        let state = a.export_state().unwrap(); a.import_state(&state).unwrap();
        assert!(Arc::ptr_eq(&a.world.thread_pool().unwrap(),physics_pool()));
    }

    #[test]
    fn physical_contacts_continue_alike_across_a_checkpoint() {
        let scene = crate::game_damage::fixtures::mounted_scene(&[(1,"one",0.0),(2,"two",3.0),(3,"three",30.0)],4);
        let make = || {
            let mut core = NativeWorld::new(&[],0.0,-9.81).unwrap();
            core.load_game_value(&scene).unwrap(); core
        };
        let (mut a,mut b) = (make(),make());
        for step in 0..120 {
            assert_eq!(a.game_step(1.0/60.0).unwrap(),b.game_step(1.0/60.0).unwrap(),"physical step {step}");
            if step == 59 { let state = a.export_state().unwrap(); a.import_state(&state).unwrap(); }
        }
    }

    #[test]
    fn concurrent_worlds_finish_on_the_shared_physics_pool() {
        let scene = crate::game_damage::fixtures::mounted_scene(&[(1,"one",0.0),(2,"two",3.0),(3,"three",30.0)],4);
        let start = Arc::new(std::sync::Barrier::new(8));
        let (sender,receiver) = std::sync::mpsc::channel();
        let handles: Vec<_> = (0..8).map(|_| {
            let (scene,start,sender) = (scene.clone(),start.clone(),sender.clone());
            std::thread::spawn(move || {
                let mut core = NativeWorld::new(&[],0.0,-9.81).unwrap();
                core.load_game_value(&scene).unwrap(); start.wait();
                for _ in 0..20 { core.game_advance(1.0/60.0).unwrap(); }
                sender.send(core.current_frame().unwrap()).unwrap();
            })
        }).collect();
        drop(sender);
        let frames: Vec<_> = (0..8).map(|_| receiver.recv_timeout(std::time::Duration::from_secs(30))
            .expect("independent worlds must not deadlock the shared physics pool")).collect();
        for handle in handles { handle.join().unwrap(); }
        assert!(frames.iter().all(|frame| *frame == frames[0]));
    }
}
