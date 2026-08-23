use bittery_client_core as core;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::JsFuture;

struct JsSerializedReplicaExecutor {
    invoke: js_sys::Function,
}

struct JsSerializedPlatformStorageExecutor {
    invoke: js_sys::Function,
}

#[async_trait::async_trait(?Send)]
impl core::SerializedReplicaExecutor for JsSerializedReplicaExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, core::RuntimeError> {
        invoke_serialized(&self.invoke, request_json, replica_invoke_error).await
    }
}

#[async_trait::async_trait(?Send)]
impl core::SerializedPlatformStorageExecutor for JsSerializedPlatformStorageExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, core::RuntimeError> {
        invoke_serialized(&self.invoke, request_json, platform_storage_invoke_error).await
    }
}

async fn invoke_serialized(
    invoke: &js_sys::Function,
    request_json: String,
    error: fn(&str) -> core::RuntimeError,
) -> Result<String, core::RuntimeError> {
    let promise = invoke
        .call1(&JsValue::UNDEFINED, &JsValue::from_str(&request_json))
        .map_err(|_| error("invocation failed"))?
        .dyn_into::<js_sys::Promise>()
        .map_err(|_| error("did not return a Promise"))?;
    let response = JsFuture::from(promise)
        .await
        .map_err(|_| error("invocation failed"))?;
    response
        .as_string()
        .ok_or_else(|| error("returned a non-string response"))
}

fn replica_invoke_error(reason: &str) -> core::RuntimeError {
    core::RuntimeError {
        code: core::RuntimeErrorCode::InvariantViolation,
        message: format!("Replica persistence {reason}"),
    }
}

fn platform_storage_invoke_error(_reason: &str) -> core::RuntimeError {
    core::RuntimeError {
        code: core::RuntimeErrorCode::InvariantViolation,
        message: "Platform storage invocation failed".into(),
    }
}

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
        Self::from_inner(core::Runtime::new())
    }

    #[wasm_bindgen(js_name = withReplicaExecutor)]
    pub fn with_replica_executor(invoke: js_sys::Function) -> Self {
        Self::from_inner(core::Runtime::with_serialized_replica_executor(Arc::new(
            JsSerializedReplicaExecutor { invoke },
        )))
    }

    #[wasm_bindgen(js_name = withExecutors)]
    pub fn with_executors(
        replica_invoke: js_sys::Function,
        platform_storage_invoke: js_sys::Function,
    ) -> Self {
        Self::from_inner(core::Runtime::with_serialized_executors(
            Arc::new(JsSerializedReplicaExecutor {
                invoke: replica_invoke,
            }),
            Arc::new(JsSerializedPlatformStorageExecutor {
                invoke: platform_storage_invoke,
            }),
        ))
    }

    fn from_inner(inner: Arc<core::Runtime>) -> Self {
        Self {
            inner,
            cancellations: Mutex::new(HashMap::new()),
            observations: Mutex::new(HashMap::new()),
        }
    }

    pub async fn open(&self) -> Result<(), JsValue> {
        self.inner
            .open()
            .await
            .map_err(|error| JsValue::from_str(&error.to_string()))
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
