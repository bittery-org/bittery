//! The one delay primitive Runtime policy is allowed to wait on.
//!
//! The Runtime already reads Device wall-clock time through `Clock`, but backoff also has to
//! *wait*. Tokio's timer is not an option: on a `wasm32-unknown-unknown` Worker the platform has
//! no Tokio timer driver and `tokio::time::sleep` panics when it is polled. So the delay is its
//! own tiny seam with one implementation per platform, and a test can hold time still without
//! any host wiring.

use async_trait::async_trait;

#[cfg(not(target_arch = "wasm32"))]
pub(crate) trait TimerRequirements: Send + Sync {}
#[cfg(not(target_arch = "wasm32"))]
impl<T: Send + Sync> TimerRequirements for T {}

#[cfg(target_arch = "wasm32")]
pub(crate) trait TimerRequirements {}
#[cfg(target_arch = "wasm32")]
impl<T> TimerRequirements for T {}

#[cfg_attr(target_arch = "wasm32", async_trait(?Send))]
#[cfg_attr(not(target_arch = "wasm32"), async_trait)]
pub(crate) trait DeviceTimer: TimerRequirements {
    /// Resolves no earlier than `milliseconds` from now. A late wake is always allowed; an early
    /// one only costs one wasted Replica read, because eligibility is re-derived from durable
    /// `not_before_ms` and never from the timer.
    async fn sleep_ms(&self, milliseconds: u64);
}

pub(crate) struct SystemDeviceTimer;

#[cfg(not(target_arch = "wasm32"))]
#[async_trait]
impl DeviceTimer for SystemDeviceTimer {
    async fn sleep_ms(&self, milliseconds: u64) {
        tokio::time::sleep(std::time::Duration::from_millis(milliseconds)).await;
    }
}

#[cfg(target_arch = "wasm32")]
#[async_trait(?Send)]
impl DeviceTimer for SystemDeviceTimer {
    async fn sleep_ms(&self, milliseconds: u64) {
        use wasm_bindgen::{JsCast, JsValue};

        // `setTimeout` lives on the global scope of a Window and of a Worker alike, and its delay
        // argument is a JavaScript number. Authenticated construction validates this primitive.
        // If hostile host mutation removes it later, park instead of turning bounded backoff into
        // a hot loop that can lose cleanup ownership.
        let global = js_sys::global();
        let Ok(set_timeout) = js_sys::Reflect::get(&global, &JsValue::from_str("setTimeout"))
        else {
            std::future::pending::<()>().await;
            return;
        };
        let Ok(set_timeout) = set_timeout.dyn_into::<js_sys::Function>() else {
            std::future::pending::<()>().await;
            return;
        };
        let delay = JsValue::from_f64(milliseconds as f64);
        let promise = js_sys::Promise::new(&mut |resolve, _reject| {
            if set_timeout
                .call2(&JsValue::UNDEFINED, &resolve, &delay)
                .is_err()
            {
                // Leaving the Promise pending is the fail-closed result.
            }
        });
        let _ = wasm_bindgen_futures::JsFuture::from(promise).await;
    }
}
