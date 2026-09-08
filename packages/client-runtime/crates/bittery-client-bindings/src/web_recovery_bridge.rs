//! Binary ownership only. Recovery format, Account scope and maintenance admission remain in Core.
#![cfg(target_arch = "wasm32")]
use bittery_client_core as core;
use js_sys::{Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::{JsCast, JsValue};
use wasm_bindgen_futures::JsFuture;
use zeroize::Zeroizing;

pub(crate) struct JsRecoveryExecutor {
    pub invoke: Function,
    pub cancel: Function,
}
struct OwnedJsChunk(Uint8Array);
impl Drop for OwnedJsChunk {
    fn drop(&mut self) {
        self.0.fill(0, 0, self.0.length());
    }
}
fn unavailable() -> core::RuntimeError {
    core::RuntimeError {
        recovery_bound: None,
        code: core::RuntimeErrorCode::StorageUnavailable,
        message: "Recovery storage is unavailable".into(),
    }
}

#[async_trait::async_trait(?Send)]
impl core::SerializedRecoveryExecutor for JsRecoveryExecutor {
    fn cancel(&self, recovery_id: &str) {
        let _ = self
            .cancel
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(recovery_id));
    }
    async fn invoke(
        &self,
        control_json: String,
        binary_chunk: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), core::RuntimeError> {
        let binary_chunk = binary_chunk.map(Zeroizing::new);
        let js_chunk = binary_chunk
            .as_ref()
            .map(|chunk| OwnedJsChunk(Uint8Array::from(chunk.as_slice())));
        let promise = self
            .invoke
            .call2(
                &JsValue::UNDEFINED,
                &JsValue::from_str(&control_json),
                js_chunk
                    .as_ref()
                    .map(|chunk| chunk.0.as_ref())
                    .unwrap_or(&JsValue::UNDEFINED),
            )
            .map_err(|_| unavailable())?
            .dyn_into::<Promise>()
            .map_err(|_| unavailable())?;
        let response = JsFuture::from(promise).await.map_err(|_| unavailable())?;
        let json = Reflect::get(&response, &JsValue::from_str("controlResponseJson"))
            .map_err(|_| unavailable())?
            .as_string()
            .ok_or_else(unavailable)?;
        let binary = Reflect::get(&response, &JsValue::from_str("binaryChunk"))
            .map_err(|_| unavailable())?;
        let bytes = if binary.is_undefined() || binary.is_null() {
            None
        } else {
            let bytes = OwnedJsChunk(binary.dyn_into::<Uint8Array>().map_err(|_| unavailable())?);
            if bytes.0.length() > 256 * 1024 {
                return Err(unavailable());
            }
            Some(bytes.0.to_vec())
        };
        Ok((json, bytes))
    }
}
