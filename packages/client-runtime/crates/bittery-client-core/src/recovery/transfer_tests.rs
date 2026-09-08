use super::control::{
    RecoveryControlRequest as Request, RecoveryControlResponse as Response, RecoveryRecord,
    SerializedRecoveryExecutor,
};
use super::transfer::{PhysicalReader, RecoveryPort};
use crate::{AccountId, RequestCancellation, RuntimeError, RuntimeErrorCode};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Mutex,
};

struct Held {
    response: Response,
    entered: tokio::sync::Notify,
    cancelled: tokio::sync::Notify,
    released: tokio::sync::Notify,
    calls: AtomicUsize,
    cancel_ids: Mutex<Vec<String>>,
}
impl Held {
    fn new(response: Response) -> Arc<Self> {
        Arc::new(Self {
            response,
            entered: tokio::sync::Notify::new(),
            cancelled: tokio::sync::Notify::new(),
            released: tokio::sync::Notify::new(),
            calls: AtomicUsize::new(0),
            cancel_ids: Mutex::new(Vec::new()),
        })
    }
}
#[async_trait::async_trait]
impl SerializedRecoveryExecutor for Held {
    fn cancel(&self, id: &str) {
        self.cancel_ids.lock().unwrap().push(id.into());
        self.cancelled.notify_one();
    }
    async fn invoke(
        &self,
        request: String,
        _: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        assert!(!request.is_empty());
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.entered.notify_one();
        self.released.notified().await;
        Ok((serde_json::to_string(&self.response).unwrap(), None))
    }
}

#[tokio::test]
async fn held_source_sink_and_admission_callbacks_cancel_then_drain_and_refuse_late_success() {
    let requests = [
        (
            Request::EnterMaintenance {
                recovery_id: "scope".into(),
            },
            Response::MaintenanceEntered {
                physical_schemas: super::control::TEST_PHYSICAL_SCHEMAS,
            },
        ),
        (
            Request::SourceRead {
                recovery_id: "scope".into(),
                account_id: "account".into(),
                capability_id: "source".into(),
                max_bytes: 256 * 1024,
            },
            Response::SourceEnded,
        ),
        (
            Request::SinkWrite {
                recovery_id: "scope".into(),
                account_id: "account".into(),
                capability_id: "sink".into(),
            },
            Response::SinkWritten,
        ),
    ];
    for (request, response) in requests {
        let executor = Held::new(response);
        let token = RequestCancellation::default();
        let port = Arc::new(RecoveryPort::new(
            executor.clone(),
            "scope".into(),
            token.clone(),
        ));
        let task = tokio::spawn({
            let port = port.clone();
            async move { port.invoke(request, None).await }
        });
        executor.entered.notified().await;
        token.cancel();
        executor.cancelled.notified().await;
        assert!(
            !task.is_finished(),
            "retirement waits for the callback to drain"
        );
        executor.released.notify_one();
        assert_eq!(
            task.await.unwrap().err().unwrap().code,
            RuntimeErrorCode::Cancelled
        );
        assert_eq!(*executor.cancel_ids.lock().unwrap(), vec!["scope"]);
        assert!(port
            .invoke(
                Request::EnterMaintenance {
                    recovery_id: "scope".into()
                },
                None
            )
            .await
            .is_err());
        assert_eq!(
            executor.calls.load(Ordering::SeqCst),
            1,
            "late success cannot reopen the retired capability"
        );
    }
}

#[tokio::test]
async fn cancellation_racing_committed_repair_preserves_the_durable_result() {
    let executor = Held::new(Response::Repaired);
    let token = RequestCancellation::default();
    let port = Arc::new(RecoveryPort::new(
        executor.clone(),
        "scope".into(),
        token.clone(),
    ));
    let request = Request::CommitRepair {
        recovery_id: "scope".into(),
        account_id: "account".into(),
        expected_head_json: "old exact head".into(),
        next_head: crate::replica::persistence_contract::ReplicaHead {
            account_id: "account".into(),
            user_id: "user".into(),
            incarnation: "incarnation".into(),
            replica_revision: 2,
            lock_epoch: 2,
            failure: None,
        },
        staged_row_count: 0,
        expected_row_count: 0,
    };
    let task = tokio::spawn(async move { port.invoke(request, None).await });
    executor.entered.notified().await;
    token.cancel();
    executor.cancelled.notified().await;
    assert!(!task.is_finished());
    executor.released.notify_one();
    assert!(matches!(
        task.await.unwrap().unwrap(),
        (Response::Repaired, None)
    ));
}

#[tokio::test]
async fn dropping_an_inflight_recovery_future_cancels_its_exact_physical_scope() {
    let executor = Held::new(Response::SourceEnded);
    let port = Arc::new(RecoveryPort::new(
        executor.clone(),
        "only-this-scope".into(),
        RequestCancellation::default(),
    ));
    let task = tokio::spawn(async move {
        port.invoke(
            Request::SourceRead {
                recovery_id: "only-this-scope".into(),
                account_id: "account".into(),
                capability_id: "source".into(),
                max_bytes: 1,
            },
            None,
        )
        .await
    });
    executor.entered.notified().await;
    task.abort();
    assert!(task.await.err().unwrap().is_cancelled());
    assert_eq!(
        *executor.cancel_ids.lock().unwrap(),
        vec!["only-this-scope"]
    );
}

struct CursorResponse {
    next: bool,
}
#[async_trait::async_trait]
impl SerializedRecoveryExecutor for CursorResponse {
    async fn invoke(
        &self,
        _: String,
        _: Option<Vec<u8>>,
    ) -> Result<(String, Option<Vec<u8>>), RuntimeError> {
        Ok((
            serde_json::to_string(&Response::Entry {
                cursor: if self.next {
                    "tiny".into()
                } else {
                    "x".repeat(1025)
                },
                next_cursor: self.next.then(|| "y".repeat(1025)),
                record: RecoveryRecord::RawReplicaHead {
                    account_id: "account".into(),
                    payload_json: "{}".into(),
                },
            })
            .unwrap(),
            None,
        ))
    }
}
#[tokio::test]
async fn oversized_physical_continuations_are_refused_before_retaining_them() {
    for next in [false, true] {
        let port = RecoveryPort::new(
            Arc::new(CursorResponse { next }),
            "scope".into(),
            RequestCancellation::default(),
        );
        let account = AccountId::from("account");
        let error = PhysicalReader::new(&port, &account)
            .next()
            .await
            .err()
            .unwrap();
        assert_eq!(error.code, RuntimeErrorCode::SizeRejected);
        assert_eq!(
            error.recovery_bound,
            Some(crate::RecoveryBound::CursorBytes)
        );
    }
}
