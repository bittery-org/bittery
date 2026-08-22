use bittery_client_core as core;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WebClientRuntime {
    inner: Arc<core::Runtime>,
    cancellations: Mutex<HashMap<String, core::RequestCancellation>>,
    observations: Mutex<HashMap<String, Arc<WebObservation>>>,
}

#[derive(Default)]
struct BufferedSink(Mutex<Vec<core::RuntimeProjection>>);

impl core::ObservationSink for BufferedSink {
    fn publish(&self, projection: core::RuntimeProjection) {
        self.0
            .lock()
            .expect("Web observation buffer lock poisoned")
            .push(projection);
    }
}

struct WebObservation {
    handle: Arc<core::ObservationHandle>,
    sink: Arc<BufferedSink>,
    callback: js_sys::Function,
    closed: AtomicBool,
}

impl WebObservation {
    fn close(&self) {
        if !self.closed.swap(true, Ordering::SeqCst) {
            self.handle.close();
        }
    }
}

#[wasm_bindgen]
impl WebClientRuntime {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: core::Runtime::new(),
            cancellations: Mutex::new(HashMap::new()),
            observations: Mutex::new(HashMap::new()),
        }
    }

    pub async fn request_json(
        &self,
        request_id: String,
        request_json: String,
    ) -> Result<String, JsValue> {
        let request: core::RuntimeRequest = serde_json::from_str(&request_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let cancellation = core::RequestCancellation::new();
        self.cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .insert(request_id.clone(), cancellation.clone());
        let result = self.inner.request(request, cancellation).await;
        self.cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .remove(&request_id);
        self.flush_observations()?;
        serde_json::to_string(&result).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn observe_json(
        &self,
        observation_id: String,
        request_json: String,
        callback: js_sys::Function,
    ) -> Result<(), JsValue> {
        let request: core::ObservationRequest = serde_json::from_str(&request_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let sink = Arc::new(BufferedSink::default());
        let handle = self
            .inner
            .observe(request, sink.clone())
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let observation = Arc::new(WebObservation {
            handle,
            sink,
            callback,
            closed: AtomicBool::new(false),
        });
        let previous = self
            .observations
            .lock()
            .expect("Web observation lock poisoned")
            .insert(observation_id.clone(), Arc::clone(&observation));
        if let Some(previous) = previous {
            previous.close();
        }
        self.flush_observation(&observation_id)
    }

    pub fn unobserve(&self, observation_id: &str) {
        if let Some(observation) = self
            .observations
            .lock()
            .expect("Web observation lock poisoned")
            .remove(observation_id)
        {
            observation.close();
        }
    }

    pub fn cancel(&self, request_id: &str) {
        if let Some(cancellation) = self
            .cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .get(request_id)
        {
            cancellation.cancel();
        }
    }

    pub async fn close(&self) {
        self.inner.close().await;
        for cancellation in self
            .cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .values()
        {
            cancellation.cancel();
        }
        let observations: Vec<_> = self
            .observations
            .lock()
            .expect("Web observation lock poisoned")
            .drain()
            .map(|(_, observation)| observation)
            .collect();
        for observation in observations {
            observation.close();
        }
    }
}

impl WebClientRuntime {
    fn flush_observations(&self) -> Result<(), JsValue> {
        let ids: Vec<_> = self
            .observations
            .lock()
            .expect("Web observation lock poisoned")
            .keys()
            .cloned()
            .collect();
        for id in ids {
            self.flush_observation(&id)?;
        }
        Ok(())
    }

    fn flush_observation(&self, observation_id: &str) -> Result<(), JsValue> {
        let observation = self
            .observations
            .lock()
            .expect("Web observation lock poisoned")
            .get(observation_id)
            .cloned();
        let Some(observation) = observation else {
            return Ok(());
        };
        let projections: Vec<_> = observation
            .sink
            .0
            .lock()
            .expect("Web observation buffer lock poisoned")
            .drain(..)
            .collect();
        for projection in projections {
            if observation.closed.load(Ordering::SeqCst) {
                break;
            }
            let json = serde_json::to_string(&projection)
                .map_err(|error| JsValue::from_str(&error.to_string()))?;
            observation
                .callback
                .call1(&JsValue::UNDEFINED, &JsValue::from_str(&json))?;
        }
        Ok(())
    }
}
