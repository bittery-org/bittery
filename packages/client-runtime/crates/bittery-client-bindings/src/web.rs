use crate::{
    account_retirement::{retirement_scope, RetirableObservation, RetirementLedger},
    observation_buffer::BufferedSink,
    observation_slots::ObservationSlots,
    web_attachment_move_bridge::{configured_runtime, WebAttachmentMoveResources},
};
use bittery_client_core as core;
use std::{
    collections::HashMap,
    rc::{Rc, Weak},
    sync::{Arc, Mutex},
};
use tokio::sync::Notify;
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::{spawn_local, JsFuture};
use zeroize::Zeroizing;

struct JsSerializedReplicaExecutor {
    invoke: js_sys::Function,
}

struct JsSerializedPlatformStorageExecutor {
    invoke: js_sys::Function,
}

struct JsSerializedHttpExecutor {
    invoke: js_sys::Function,
    cancel: js_sys::Function,
}

#[async_trait::async_trait(?Send)]
impl core::SerializedReplicaExecutor for JsSerializedReplicaExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, core::RuntimeError> {
        invoke_serialized(&self.invoke, &request_json, replica_invoke_error).await
    }
}

#[async_trait::async_trait(?Send)]
impl core::SerializedPlatformStorageExecutor for JsSerializedPlatformStorageExecutor {
    async fn invoke(
        &self,
        request_json: Zeroizing<String>,
    ) -> Result<Zeroizing<String>, core::RuntimeError> {
        // Rust retains zeroizing ownership across the await. Crossing wasm-bindgen necessarily
        // creates JS-engine-managed string copies that Rust cannot inspect or wipe.
        invoke_serialized(&self.invoke, &request_json, platform_storage_invoke_error)
            .await
            .map(Zeroizing::new)
    }
}

#[async_trait::async_trait(?Send)]
impl core::SerializedHttpExecutor for JsSerializedHttpExecutor {
    async fn invoke(&self, request_json: String) -> Result<String, core::RuntimeError> {
        invoke_serialized(&self.invoke, &request_json, http_invoke_error).await
    }

    fn cancel(&self, dispatch_id: &str) {
        // Cancellation is best-effort and must not expose a host exception to Runtime policy.
        let _ = self
            .cancel
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(dispatch_id));
    }
}

async fn invoke_serialized(
    invoke: &js_sys::Function,
    request_json: &str,
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

fn http_invoke_error(_reason: &str) -> core::RuntimeError {
    core::RuntimeError {
        code: core::RuntimeErrorCode::InvariantViolation,
        message: "HTTP transport invocation failed".into(),
    }
}

#[wasm_bindgen]
pub struct WebClientRuntime {
    inner: Arc<core::Runtime>,
    cancellations: Mutex<HashMap<String, core::RequestCancellation>>,
    // The drain task holds a weak reference to this table and nothing else, so it can never keep
    // a freed Runtime alive: it stops the first time it wakes and finds the table gone.
    observations: Rc<ObservationSlots<WebObservation>>,
    retirements: RetirementLedger,
    wake: Arc<Notify>,
    attachment_move_resources: Option<WebAttachmentMoveResources>,
}

struct WebObservation {
    handle: Arc<core::ObservationHandle>,
    sink: Arc<BufferedSink>,
    callback: js_sys::Function,
    account_id: Option<core::AccountId>,
}

impl RetirableObservation for WebObservation {
    fn retired_account(&self) -> Option<&core::AccountId> {
        self.account_id.as_ref()
    }

    fn begin_retirement(&self) {
        self.sink.begin_retirement();
    }

    fn end_retirement(&self) {
        self.sink.end_retirement();
    }
}

impl WebObservation {
    fn close(&self) {
        if !self.sink.is_closed() {
            self.sink.close();
            self.handle.close();
        }
    }

    fn deliver(&self) -> Result<(), JsValue> {
        self.sink.drain(|projection| {
            let json = Zeroizing::new(
                serde_json::to_string(&projection)
                    .map_err(|error| JsValue::from_str(&error.to_string()))?,
            );
            self.callback
                .call1(&JsValue::UNDEFINED, &JsValue::from_str(&json))?;
            Ok(())
        })
    }
}

/// Delivers what the Runtime publishes when no host call is in flight.
///
/// The wasm-bindgen executor polls this task from a microtask, which is the one place where the
/// Runtime holds no borrow, no publication ordering, and no plaintext delivery lease. Publishing
/// only wakes the task; it never calls the host itself.
async fn drain_published_observations(
    observations: Weak<ObservationSlots<WebObservation>>,
    wake: Arc<Notify>,
) {
    loop {
        wake.notified().await;
        let Some(observations) = observations.upgrade() else {
            return;
        };
        for id in observations.ids() {
            let Some(observation) = observations.get(&id) else {
                continue;
            };
            // Nobody is waiting on this drain, so a host callback that throws can only be
            // reported to the host that threw. The projection it refused is dropped; the next
            // publication wakes this task again.
            let _ = observation.deliver();
        }
    }
}

#[wasm_bindgen]
impl WebClientRuntime {
    #[wasm_bindgen(js_name = normalizeAccountEmail)]
    pub fn normalize_account_email(input: String) -> Result<String, JsValue> {
        core::normalize_account_email(&input)
            .map(core::NormalizedAccountEmail::into_string)
            .map_err(|_| JsValue::from_str("Account deletion confirmation email is invalid"))
    }

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
        http_invoke: js_sys::Function,
        http_cancel: js_sys::Function,
    ) -> Self {
        Self::from_inner(core::Runtime::with_serialized_executors(
            Arc::new(JsSerializedReplicaExecutor {
                invoke: replica_invoke,
            }),
            Arc::new(JsSerializedPlatformStorageExecutor {
                invoke: platform_storage_invoke,
            }),
            Arc::new(JsSerializedHttpExecutor {
                invoke: http_invoke,
                cancel: http_cancel,
            }),
        ))
    }

    #[wasm_bindgen(js_name = withConfiguredExecutors)]
    pub fn with_configured_executors(
        replica_invoke: js_sys::Function,
        platform_storage_invoke: js_sys::Function,
        http_invoke: js_sys::Function,
        http_cancel: js_sys::Function,
        client_id: String,
        platform: String,
        version: String,
    ) -> Result<Self, JsValue> {
        let platform = client_platform(&platform)?;
        let config = core::AuthClientConfig::new(client_id, platform, version)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        Ok(Self::from_inner(
            core::Runtime::with_configured_serialized_executors(
                Arc::new(JsSerializedReplicaExecutor {
                    invoke: replica_invoke,
                }),
                Arc::new(JsSerializedPlatformStorageExecutor {
                    invoke: platform_storage_invoke,
                }),
                Arc::new(JsSerializedHttpExecutor {
                    invoke: http_invoke,
                    cancel: http_cancel,
                }),
                config,
            ),
        ))
    }

    #[doc(hidden)]
    #[wasm_bindgen(js_name = withConfiguredAttachmentMovePreparation)]
    #[allow(
        clippy::too_many_arguments,
        reason = "the fixed browser composition receives each closed primitive executor explicitly"
    )]
    pub fn with_configured_attachment_move_preparation(
        replica_invoke: js_sys::Function,
        platform_storage_invoke: js_sys::Function,
        http_invoke: js_sys::Function,
        http_cancel: js_sys::Function,
        artifact_executor: JsValue,
        binary_executor: JsValue,
        lease_executor: JsValue,
        client_id: String,
        platform: String,
        version: String,
        lifecycle_error: js_sys::Function,
        download_sink_executor: JsValue,
    ) -> Result<Self, JsValue> {
        let platform = client_platform(&platform)?;
        let config = core::AuthClientConfig::new(client_id, platform, version)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let (inner, resources) = configured_runtime(
            Arc::new(JsSerializedReplicaExecutor {
                invoke: replica_invoke,
            }),
            Arc::new(JsSerializedPlatformStorageExecutor {
                invoke: platform_storage_invoke,
            }),
            Arc::new(JsSerializedHttpExecutor {
                invoke: http_invoke,
                cancel: http_cancel,
            }),
            config,
            artifact_executor,
            binary_executor,
            lease_executor,
            lifecycle_error,
            download_sink_executor,
        )?;
        Ok(Self::from_inner_with_attachment_move_resources(
            inner, resources,
        ))
    }

    fn from_inner(inner: Arc<core::Runtime>) -> Self {
        let observations = Rc::new(ObservationSlots::new());
        let wake = Arc::new(Notify::new());
        spawn_local(drain_published_observations(
            Rc::downgrade(&observations),
            Arc::clone(&wake),
        ));
        // The Runtime owns every accepted Operation until an authoritative outcome, and it has no
        // scheduler of its own. This is the Worker's executor lending it one: the loop is not tied
        // to any host call, so an Operation accepted offline keeps being retried while the page
        // does nothing at all. It returns when the Runtime closes.
        spawn_local(Arc::clone(&inner).run_operation_dispatch());
        Self {
            inner,
            cancellations: Mutex::new(HashMap::new()),
            observations,
            retirements: RetirementLedger::default(),
            wake,
            attachment_move_resources: None,
        }
    }

    fn from_inner_with_attachment_move_resources(
        inner: Arc<core::Runtime>,
        resources: WebAttachmentMoveResources,
    ) -> Self {
        let mut runtime = Self::from_inner(inner);
        runtime.attachment_move_resources = Some(resources);
        runtime
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
        let retired = retirement_scope(&request);
        if let Some(scope) = &retired {
            self.retirements.begin(scope, &self.live_observations());
        }
        let cancellation = core::RequestCancellation::new();
        self.cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .insert(request_id.clone(), cancellation.clone());
        let result = self.inner.request(request, cancellation).await;
        if let Some(scope) = &retired {
            // The Runtime may have closed some of these part-way through a destructive scope.
            // Resuming a closed sink is silent, and the ledger stays balanced either way.
            self.retirements.end(scope, &self.live_observations());
        }
        self.cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .remove(&request_id);
        self.flush_observations()?;
        // The declared outcome envelope, not Serde's implicit `Result` spelling, is the contract.
        let outcome = core::RuntimeOutcome::from(result);
        serde_json::to_string(&outcome).map_err(|error| JsValue::from_str(&error.to_string()))
    }

    pub fn observe_json(
        &self,
        observation_id: String,
        request_json: String,
        callback: js_sys::Function,
    ) -> Result<(), JsValue> {
        let request: core::ObservationRequest = serde_json::from_str(&request_json)
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let account_id = request.account_id().cloned();
        let sink = Arc::new(BufferedSink::new(Arc::clone(&self.wake)));
        let handle = self
            .inner
            .observe(request, sink.clone())
            .map_err(|error| JsValue::from_str(&error.to_string()))?;
        let observation = Arc::new(WebObservation {
            handle,
            sink,
            callback,
            account_id,
        });
        // Nothing awaits between this catch-up and publication, so no in-flight retirement can
        // finish in between and resume a sink it never suspended.
        self.retirements.admit(&observation);
        // A repeated id is a host defect. Closing the previous handle instead would strand
        // its consumer and hand its `unobserve` to whoever claimed the id last.
        self.observations
            .insert_new(observation_id.clone(), Arc::clone(&observation))
            .map_err(|error| {
                observation.close();
                JsValue::from_str(&error.to_string())
            })?;
        self.flush_observation(&observation_id)
    }

    pub fn unobserve(&self, observation_id: &str) {
        if let Some(observation) = self.observations.remove(observation_id) {
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
        let cancellations: Vec<_> = self
            .cancellations
            .lock()
            .expect("cancellation lock poisoned")
            .drain()
            .map(|(_, cancellation)| cancellation)
            .collect();
        for cancellation in cancellations {
            cancellation.cancel();
        }
        if let Some(resources) = &self.attachment_move_resources {
            resources.close();
        }
        self.inner.close().await;
        for observation in self.observations.drain() {
            observation.close();
        }
    }
}

// Freeing the Runtime from JavaScript leaves the drain task parked on a wake that nothing will
// send. One last wake lets it observe the dropped table and finish.
impl Drop for WebClientRuntime {
    fn drop(&mut self) {
        if let Some(resources) = &self.attachment_move_resources {
            resources.close();
        }
        self.wake.notify_one();
    }
}

fn client_platform(platform: &str) -> Result<core::ClientPlatform, JsValue> {
    match platform {
        "web" => Ok(core::ClientPlatform::Web),
        "desktop" => Ok(core::ClientPlatform::Desktop),
        "mobile" => Ok(core::ClientPlatform::Mobile),
        "extension" => Ok(core::ClientPlatform::Extension),
        _ => Err(JsValue::from_str(
            "authentication client platform is invalid",
        )),
    }
}

impl WebClientRuntime {
    fn live_observations(&self) -> Vec<Arc<WebObservation>> {
        self.observations
            .ids()
            .iter()
            .filter_map(|id| self.observations.get(id))
            .collect()
    }

    fn flush_observations(&self) -> Result<(), JsValue> {
        for id in self.observations.ids() {
            self.flush_observation(&id)?;
        }
        Ok(())
    }

    fn flush_observation(&self, observation_id: &str) -> Result<(), JsValue> {
        match self.observations.get(observation_id) {
            Some(observation) => observation.deliver(),
            None => Ok(()),
        }
    }
}
