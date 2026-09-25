use bittery_client_core::{
    ObservationHandle, ObservationSink, RequestCancellation, Runtime, RuntimeError,
    RuntimeErrorCode, RuntimeOutcome, RuntimeProjection, RuntimeRequest,
};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};

/// One renderer attachment to a process-owned Runtime. Detachment never closes the owner.
pub(super) struct RuntimeConnection {
    runtime: Arc<Runtime>,
    startup_error: Option<RuntimeError>,
    state: Arc<Mutex<ConnectionState>>,
}

#[derive(Default)]
struct ConnectionState {
    closed: bool,
    observations: HashMap<String, Arc<Registration>>,
    requests: HashMap<String, RequestCancellation>,
}

struct Registration {
    active: AtomicBool,
    handle: Mutex<Option<Arc<ObservationHandle>>>,
    sink: Arc<dyn ObservationSink>,
}

impl Registration {
    fn retire(&self) {
        self.active.store(false, Ordering::SeqCst);
        let handle = self
            .handle
            .lock()
            .expect("Observation registration poisoned")
            .take();
        if let Some(handle) = handle {
            handle.close();
        }
    }
}

impl ObservationSink for Registration {
    fn publish(&self, projection: RuntimeProjection) {
        // Core owns Account/lock publication fencing. This token only prevents new delivery to a
        // detached caller. The renderer also rejects its already in-flight connection messages.
        if self.active.load(Ordering::SeqCst) {
            self.sink.publish(projection);
        }
    }
}

fn failure(code: RuntimeErrorCode, message: &str) -> RuntimeError {
    RuntimeError {
        code,
        message: message.into(),
        recovery_bound: None,
        team_page_problem: None,
    }
}

struct RequestLease {
    state: Arc<Mutex<ConnectionState>>,
    id: String,
    cancellation: RequestCancellation,
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        self.cancellation.cancel();
        self.state
            .lock()
            .expect("Runtime connection state poisoned")
            .requests
            .remove(&self.id);
    }
}

impl RuntimeConnection {
    pub(super) fn new(runtime: Arc<Runtime>) -> Self {
        Self::with_startup_error(runtime, None)
    }

    pub(super) fn with_startup_error(
        runtime: Arc<Runtime>,
        startup_error: Option<RuntimeError>,
    ) -> Self {
        Self {
            runtime,
            startup_error,
            state: Arc::new(Mutex::new(ConnectionState::default())),
        }
    }

    pub(super) fn request(
        &self,
        id: String,
        request_json: &str,
    ) -> impl std::future::Future<Output = Result<String, RuntimeError>> + Send + 'static {
        let pending = self.begin_request(id, request_json);
        async move { pending?.await }
    }

    /// Synchronous admission lets IPC acknowledge registration before a subsequent Cancel.
    pub(super) fn begin_request(
        &self,
        id: String,
        request_json: &str,
    ) -> Result<
        impl std::future::Future<Output = Result<String, RuntimeError>> + Send + 'static,
        RuntimeError,
    > {
        let request: RuntimeRequest = serde_json::from_str(request_json).map_err(|_| {
            failure(
                RuntimeErrorCode::InvariantViolation,
                "Invalid Runtime request",
            )
        })?;
        if let Some(error) = &self.startup_error {
            if !matches!(
                request,
                RuntimeRequest::InspectRecovery { .. }
                    | RuntimeRequest::ExportAccountRecovery { .. }
                    | RuntimeRequest::RepairAccountRecovery { .. }
                    | RuntimeRequest::RebootstrapAccountRecovery { .. }
                    | RuntimeRequest::Wipe
            ) {
                return Err(error.clone());
            }
        }
        let cancellation = RequestCancellation::new();
        {
            let mut state = self
                .state
                .lock()
                .expect("Runtime connection state poisoned");
            if state.closed {
                return Err(failure(
                    RuntimeErrorCode::RuntimeClosed,
                    "Renderer connection is closed",
                ));
            }
            if id.is_empty() || state.requests.contains_key(&id) {
                return Err(failure(
                    RuntimeErrorCode::InvariantViolation,
                    "Request ID is empty or already registered",
                ));
            }
            state.requests.insert(id.clone(), cancellation.clone());
        }
        let _lease = RequestLease {
            state: self.state.clone(),
            id,
            cancellation: cancellation.clone(),
        };
        // The caller owns its wait, while Core owns lifecycle/accepted work. Dropping a renderer
        // future must not abandon a durable commit or teardown halfway through a capability call.
        let runtime = self.runtime.clone();
        Ok(async move {
            let _lease = _lease;
            let execution_cancellation = cancellation.clone();
            let delivery_runtime = runtime.clone();
            let execution = tokio::spawn(async move {
                RuntimeOutcome::from(runtime.request(request, execution_cancellation).await)
            });
            let outcome = tokio::select! {
                biased;
                () = cancellation.cancelled() => {
                    return Err(failure(RuntimeErrorCode::Cancelled, "Renderer request was cancelled"));
                }
                result = execution => result.map_err(|_| {
                    failure(RuntimeErrorCode::InvariantViolation, "Runtime request task failed")
                })?,
            };
            delivery_runtime
                .encode_outcome(outcome)
                .map(|encoded| encoded.to_string())
        })
    }

    pub(super) fn cancel(&self, id: &str) {
        if let Some(cancellation) = self
            .state
            .lock()
            .expect("Runtime connection state poisoned")
            .requests
            .get(id)
        {
            cancellation.cancel();
        }
    }

    pub(super) fn observe(
        &self,
        id: String,
        request_json: &str,
        sink: Arc<dyn ObservationSink>,
    ) -> Result<(), RuntimeError> {
        if let Some(error) = &self.startup_error {
            return Err(error.clone());
        }
        let request = serde_json::from_str(request_json).map_err(|_| {
            failure(
                RuntimeErrorCode::InvariantViolation,
                "Invalid Runtime observation",
            )
        })?;
        let registration = Arc::new(Registration {
            active: AtomicBool::new(true),
            handle: Mutex::new(None),
            sink,
        });
        {
            let mut state = self
                .state
                .lock()
                .expect("Runtime connection state poisoned");
            if state.closed {
                return Err(failure(
                    RuntimeErrorCode::RuntimeClosed,
                    "Renderer connection is closed",
                ));
            }
            if id.is_empty() || state.observations.contains_key(&id) {
                return Err(failure(
                    RuntimeErrorCode::InvariantViolation,
                    "Observation ID is empty or already registered",
                ));
            }
            state.observations.insert(id.clone(), registration.clone());
        }
        let result = self.runtime.observe(request, registration.clone());
        let mut state = self
            .state
            .lock()
            .expect("Runtime connection state poisoned");
        let still_registered = state
            .observations
            .get(&id)
            .is_some_and(|current| Arc::ptr_eq(current, &registration));
        match result {
            Ok(handle) if still_registered => {
                *registration
                    .handle
                    .lock()
                    .expect("Observation registration poisoned") = Some(handle);
                Ok(())
            }
            Ok(handle) => {
                drop(state);
                handle.close();
                Err(failure(
                    RuntimeErrorCode::Cancelled,
                    "Observation detached during registration",
                ))
            }
            Err(error) => {
                if still_registered {
                    state.observations.remove(&id);
                }
                registration.active.store(false, Ordering::SeqCst);
                Err(error)
            }
        }
    }

    pub(super) fn unobserve(&self, id: &str) {
        let registration = {
            let mut state = self
                .state
                .lock()
                .expect("Runtime connection state poisoned");
            let registration = state.observations.remove(id);
            if let Some(registration) = &registration {
                registration.active.store(false, Ordering::SeqCst);
            }
            registration
        };
        if let Some(registration) = registration {
            registration.retire();
        }
    }

    pub(super) fn close(&self) {
        let (observations, requests) = {
            let mut state = self
                .state
                .lock()
                .expect("Runtime connection state poisoned");
            state.closed = true;
            // Retire before releasing the registry, including registrations awaiting Core's
            // synchronous initial callback. Handles are closed outside this lock for reentrancy.
            for registration in state.observations.values() {
                registration.active.store(false, Ordering::SeqCst);
            }
            (
                std::mem::take(&mut state.observations),
                std::mem::take(&mut state.requests),
            )
        };
        for cancellation in requests.into_values() {
            cancellation.cancel();
        }
        for registration in observations.into_values() {
            registration.retire();
        }
    }
}

impl Drop for RuntimeConnection {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bittery_client_core::{RuntimeErrorCode, RuntimeProjection};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Projections(Mutex<Vec<RuntimeProjection>>);

    impl ObservationSink for Projections {
        fn publish(&self, projection: RuntimeProjection) {
            self.0.lock().unwrap().push(projection);
        }
    }

    const STATUS: &str = r#"{"type":"runtimeStatus","accountId":null}"#;

    #[tokio::test]
    async fn synchronous_admission_makes_cancel_effective_before_the_first_poll() {
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let connection = RuntimeConnection::new(runtime.clone());
        let request = r#"{"type":"lock","accountId":"missing"}"#;
        let pending = connection.begin_request("request".into(), request).unwrap();
        assert!(connection.begin_request("request".into(), request).is_err());
        connection.cancel("request");
        assert_eq!(pending.await.unwrap_err().code, RuntimeErrorCode::Cancelled);
        let dropped = connection.begin_request("request".into(), request).unwrap();
        drop(dropped);
        assert!(connection.request("request".into(), request).await.is_ok());
        runtime.close().await;
    }

    #[tokio::test]
    async fn detached_renderer_cannot_observe_but_another_renderer_keeps_the_same_owner() {
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let first = RuntimeConnection::new(runtime.clone());
        first
            .observe("status".into(), STATUS, Arc::new(Projections::default()))
            .unwrap();
        first.close();
        let error = first
            .observe("later".into(), STATUS, Arc::new(Projections::default()))
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);

        let second = RuntimeConnection::new(runtime.clone());
        let projections = Arc::new(Projections::default());
        second
            .observe("status".into(), STATUS, projections.clone())
            .unwrap();
        assert_eq!(projections.0.lock().unwrap().len(), 1);
        runtime.close().await;
    }

    #[tokio::test]
    async fn duplicate_observation_cannot_replace_a_live_registration() {
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let connection = RuntimeConnection::new(runtime.clone());
        connection
            .observe("status".into(), STATUS, Arc::new(Projections::default()))
            .unwrap();
        let error = connection
            .observe("status".into(), STATUS, Arc::new(Projections::default()))
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::InvariantViolation);
        connection.unobserve("status");
        connection
            .observe("status".into(), STATUS, Arc::new(Projections::default()))
            .unwrap();
        runtime.close().await;
    }

    #[tokio::test]
    async fn renderer_request_uses_the_generated_core_outcome_and_rejects_after_detach() {
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let connection = RuntimeConnection::new(runtime.clone());
        let answer = connection
            .request(
                "request-1".into(),
                r#"{"type":"lock","accountId":"missing"}"#,
            )
            .await
            .unwrap();
        let outcome: bittery_client_core::RuntimeOutcome = serde_json::from_str(&answer).unwrap();
        assert!(
            matches!(outcome, bittery_client_core::RuntimeOutcome::Succeeded(bittery_client_core::RuntimeResponse::AccessChanged { account_id, access: bittery_client_core::AccountAccessState::SignedOut }) if account_id.as_str() == "missing")
        );
        connection.close();
        let error = connection
            .request(
                "request-2".into(),
                r#"{"type":"lock","accountId":"missing"}"#,
            )
            .await
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::RuntimeClosed);
        runtime.close().await;
    }

    #[tokio::test]
    async fn detachment_during_initial_projection_does_not_leave_a_live_registration() {
        struct CloseOnPublish(std::sync::Weak<RuntimeConnection>);
        impl ObservationSink for CloseOnPublish {
            fn publish(&self, _projection: RuntimeProjection) {
                self.0.upgrade().unwrap().close();
            }
        }
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let connection = Arc::new(RuntimeConnection::new(runtime.clone()));
        let error = connection
            .observe(
                "status".into(),
                STATUS,
                Arc::new(CloseOnPublish(Arc::downgrade(&connection))),
            )
            .unwrap_err();
        assert_eq!(error.code, RuntimeErrorCode::Cancelled);
        // Observation close and Runtime close both wait for deliveries. Reentrant detachment
        // must leave neither a live handle nor a delivery deadlock behind.
        tokio::time::timeout(std::time::Duration::from_secs(1), runtime.close())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn malformed_renderer_protocol_is_rejected_without_poisoning_the_connection() {
        let runtime = Runtime::new();
        runtime.open().await.unwrap();
        let connection = RuntimeConnection::new(runtime.clone());
        assert_eq!(
            connection
                .request("bad".into(), "{")
                .await
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        assert_eq!(
            connection
                .observe("bad".into(), "{", Arc::new(Projections::default()))
                .unwrap_err()
                .code,
            RuntimeErrorCode::InvariantViolation
        );
        connection
            .observe("status".into(), STATUS, Arc::new(Projections::default()))
            .unwrap();
        runtime.close().await;
    }

    #[tokio::test]
    async fn cancelled_or_dropped_waiter_does_not_abort_runtime_cleanup() {
        use async_trait::async_trait;
        use bittery_client_core::{
            PlatformStorageArea, PlatformStorageRequest, PlatformStorageResponse,
            SerializedPlatformStorageExecutor, SqliteReplica,
        };
        use tokio::sync::Notify;
        use zeroize::Zeroizing;

        #[derive(Default)]
        struct CleanupGate {
            entered: Notify,
            release: Notify,
            completed: Notify,
        }

        #[async_trait]
        impl SerializedPlatformStorageExecutor for CleanupGate {
            async fn invoke(
                &self,
                request: Zeroizing<String>,
            ) -> Result<Zeroizing<String>, RuntimeError> {
                let request: PlatformStorageRequest = serde_json::from_str(&request).unwrap();
                let response = match &request {
                    PlatformStorageRequest::Get { .. } => {
                        PlatformStorageResponse::Value { value: None }
                    }
                    PlatformStorageRequest::DeletePrefix { area, .. } => {
                        if *area == PlatformStorageArea::DevicePlain {
                            self.entered.notify_one();
                            self.release.notified().await;
                        }
                        if *area == PlatformStorageArea::SessionSecret {
                            self.completed.notify_one();
                        }
                        PlatformStorageResponse::Done
                    }
                    _ => PlatformStorageResponse::Done,
                };
                Ok(Zeroizing::new(serde_json::to_string(&response).unwrap()))
            }
        }

        for mode in ["cancel", "close", "drop"] {
            let directory = tempfile::tempdir().unwrap();
            let gate = Arc::new(CleanupGate::default());
            let runtime = Runtime::with_serialized_executors(
                Arc::new(SqliteReplica::open(directory.path().join("replica.sqlite")).unwrap()),
                gate.clone(),
                Arc::new(super::super::http::NativeHttpExecutor::new().unwrap()),
            );
            runtime.open().await.unwrap();
            let connection = RuntimeConnection::new(runtime.clone());
            let mut request = Box::pin(connection.request("cleanup".into(), r#"{"type":"wipe"}"#));
            tokio::select! {
                () = gate.entered.notified() => {}
                result = &mut request => panic!("cleanup did not reach its capability gate: {result:?}"),
            }
            match mode {
                "cancel" => connection.cancel("cleanup"),
                "close" => connection.close(),
                "drop" => {}
                _ => unreachable!(),
            }
            if mode != "drop" {
                let result =
                    tokio::time::timeout(std::time::Duration::from_secs(1), &mut request).await;
                if result.is_err() {
                    gate.release.notify_one();
                }
                assert_eq!(
                    result
                        .expect("caller cancellation must not wait for cleanup storage")
                        .unwrap_err()
                        .code,
                    RuntimeErrorCode::Cancelled,
                    "{mode}"
                );
            }
            drop(request);
            gate.release.notify_one();
            // This verifies continuation at the platform capability seam. Artifact and host
            // cleanup are deliberately absent; this test does not claim complete Wipe acceptance.
            tokio::time::timeout(std::time::Duration::from_secs(1), gate.completed.notified())
                .await
                .expect("Core cleanup must continue after its caller stops waiting");
            tokio::time::timeout(std::time::Duration::from_secs(1), runtime.close())
                .await
                .unwrap();
        }
    }
}
