use crate::{CoreConfig, CoreEvent, TransmuxCore};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(js_name = TransmuxCore)]
pub struct WasmTransmuxCore {
    core: TransmuxCore,
}

#[wasm_bindgen(js_class = TransmuxCore)]
impl WasmTransmuxCore {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            core: TransmuxCore::new(CoreConfig::default()),
        }
    }

    #[wasm_bindgen(js_name = pushChunk)]
    pub fn push_chunk(&mut self, data: &[u8]) -> Result<JsValue, JsValue> {
        let _ = self.core.push_chunk(data);
        self.drain_events()
    }

    pub fn flush(&mut self) -> Result<JsValue, JsValue> {
        let _ = self.core.flush();
        self.drain_events()
    }

    pub fn reset(&mut self) {
        self.core.reset();
    }

    pub fn destroy(&mut self) {
        self.core.reset();
    }
}

impl Default for WasmTransmuxCore {
    fn default() -> Self {
        Self::new()
    }
}

impl WasmTransmuxCore {
    fn drain_events(&mut self) -> Result<JsValue, JsValue> {
        let mut events = Vec::<CoreEvent>::new();
        self.core.drain_events(&mut events);
        serde_wasm_bindgen::to_value(&events).map_err(|error| JsValue::from_str(&error.to_string()))
    }
}
