//! A synchronous Node-API binding to the same world exported to WebAssembly.
//! Input slices are borrowed only during the call; worlds own no JS buffers or
//! callbacks and are local to the thread that made them. Output vectors transfer
//! ownership to Node and remain valid after the next step or world disposal.
use crate::NativeWorld;
use napi::{Error, Result};
use napi_derive::napi;
use std::panic::{AssertUnwindSafe, catch_unwind};

#[napi(js_name = "template_source")]
pub fn template_source(request: String) -> Result<String> {
    crate::template_source(&request).map_err(Error::from_reason)
}
#[napi(js_name = "construction_cost")]
pub fn construction_cost(request: String) -> Result<String> {
    crate::construction_cost(&request).map_err(Error::from_reason)
}
#[napi(js_name = "weapon_variant")]
pub fn weapon_variant(request: String) -> Result<String> {
    crate::weapon_variant(&request).map_err(Error::from_reason)
}
#[napi(js_name = "host_contract")]
pub fn host_contract() -> u32 {
    crate::HOST_CONTRACT
}
#[napi(js_name = "compile_construction")]
pub fn compile_construction(request: String) -> Result<String> {
    crate::compile_construction(&request).map_err(Error::from_reason)
}
#[napi(js_name = "ballistic_flight")]
pub fn ballistic_flight(request: String) -> Result<String> {
    crate::ballistic_flight(&request).map_err(Error::from_reason)
}
#[napi(js_name = "ground_response")]
pub fn ground_response(request: String) -> Result<String> {
    crate::ground_response(&request).map_err(Error::from_reason)
}
#[napi(js_name = "fuel_flow")]
pub fn fuel_flow(engine_kw: f64, installed_kw: f64) -> f64 {
    crate::fuel_flow(engine_kw, installed_kw)
}

#[napi(js_name = "NativeWorld")]
pub struct NodeWorld {
    world: Option<NativeWorld>,
}

impl NodeWorld {
    fn call<T>(
        &mut self,
        operation: impl FnOnce(&mut NativeWorld) -> std::result::Result<T, String>,
    ) -> Result<T> {
        let world = self
            .world
            .as_mut()
            .ok_or_else(|| Error::from_reason("Native world has been freed"))?;
        match catch_unwind(AssertUnwindSafe(|| operation(world))) {
            Ok(result) => result.map_err(Error::from_reason),
            Err(_) => {
                // A partially executed solver cannot be reused after unwinding.
                self.world = None;
                Err(Error::from_reason(
                    "Native physics panicked; world discarded",
                ))
            }
        }
    }
}

#[napi]
impl NodeWorld {
    #[napi(constructor, catch_unwind)]
    pub fn new(terrain: &[f64], gx: f64, gy: f64) -> Result<Self> {
        Ok(Self {
            world: Some(NativeWorld::new(terrain, gx, gy).map_err(Error::from_reason)?),
        })
    }
    #[napi(catch_unwind)]
    pub fn free(&mut self) {
        self.world = None;
    }

    #[napi(js_name = "load_game")]
    pub fn load_game(&mut self, request: String) -> Result<()> {
        self.call(|world| world.load_game(&request))
    }
    #[napi(js_name = "current_frame")]
    pub fn current_frame(&mut self) -> Result<String> {
        self.call(|world| world.current_frame())
    }
    #[napi(js_name = "game_step")]
    pub fn game_step(&mut self, dt: f64) -> Result<String> {
        self.call(|world| world.game_step(dt))
    }
    #[napi(js_name = "game_advance")]
    pub fn game_advance(&mut self, dt: f64) -> Result<String> {
        self.call(|world| world.game_advance(dt))
    }
    #[napi(js_name = "shot_block")]
    pub fn shot_block(&mut self) -> Result<napi::bindgen_prelude::Float64Array> {
        self.call(|world| world.shot_block()).map(napi::bindgen_prelude::Float64Array::new)
    }
    #[napi(js_name = "frame_block")]
    pub fn frame_block(&mut self) -> Result<napi::bindgen_prelude::Float64Array> {
        self.call(|world| world.frame_block()).map(napi::bindgen_prelude::Float64Array::new)
    }
    #[napi(js_name = "shot_drags")]
    pub fn shot_drags(&mut self) -> Result<napi::bindgen_prelude::Float64Array> {
        self.call(|world| world.shot_drags()).map(napi::bindgen_prelude::Float64Array::new)
    }
    #[napi(js_name = "game_command")]
    pub fn game_command(&mut self, request: String) -> Result<String> {
        self.call(|world| world.game_command(&request))
    }
    #[napi(js_name = "export_state")]
    pub fn export_state(&mut self) -> Result<napi::bindgen_prelude::Buffer> {
        self.call(|world| world.export_state()).map(napi::bindgen_prelude::Buffer::from)
    }
    #[napi(js_name = "import_state")]
    pub fn import_state(&mut self, state: napi::bindgen_prelude::Buffer) -> Result<()> {
        self.call(|world| world.import_state(&state))
    }
    #[napi(js_name = "copy_from")]
    pub fn copy_from(&mut self, source: &NodeWorld) -> Result<()> {
        // A world is itself already.
        if std::ptr::eq(self as *const NodeWorld, source as *const NodeWorld) {
            return Ok(());
        }
        let source = source.world.as_ref().ok_or_else(|| Error::from_reason("Native world has been freed"))?;
        self.call(|world| world.copy_from(source))
    }
}
