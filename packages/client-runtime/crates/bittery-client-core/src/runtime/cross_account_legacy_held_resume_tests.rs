//! Active destination bindings cannot be explicitly reauthorized.
use super::*;

#[tokio::test]
async fn held_cross_active_binding_resume_preserves_the_hold_without_http() {
    for status in ["failed", "conflicted"] {
        let (fixture, _) = admitted_legacy_move_with_history(json!({"status":status}), None).await;
        fixture.http.offline.store(false, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        let source = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let before = durable_rows(&fixture.database.0, &fixture.source).await;
        let requests_before = fixture.http.requests.lock().unwrap().len();
        let revision = 0;
        let confirmation = crate::protocol::CrossAccountMoveResumeGuard {
            account_id: fixture.source.clone(),
            source_incarnation: source.incarnation.clone(),
            source_lock_epoch: source.lock_epoch,
            target_account_id: fixture.target.clone(),
            target_incarnation: target.incarnation.clone(),
            target_lock_epoch: target.lock_epoch,
            operation_id: SEMANTIC.into(),
            binding_revision: revision,
            source_replica_revision: source.revision,
            owner_incarnation: fixture.runtime.native_authority.owner_incarnation().into(),
        };
        for request in [
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: fixture.source.clone(),
                operation_id: SEMANTIC.into(),
                target_account_id: fixture.target.clone(),
                expected_binding_revision: revision,
            },
            RuntimeRequest::ResumeCrossAccountMove {
                guard: confirmation,
            },
        ] {
            let accepted = AtomicBool::new(false);
            let result = fixture
                .runtime
                .request_cross_account_move_resume(
                    request,
                    crate::RequestCancellation::new(),
                    || {
                        accepted.store(true, Ordering::SeqCst);
                    },
                )
                .await;
            assert_eq!(result.unwrap_err().code, RuntimeErrorCode::AccessDenied);
            assert!(!accepted.load(Ordering::SeqCst));
            assert_eq!(fixture.http.requests.lock().unwrap().len(), requests_before);
            assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
            assert!(fixture.http.mutations(TARGET_ORIGIN).is_empty());
            assert_eq!(
                fixture.runtime.require_snapshot(&fixture.source).unwrap(),
                source
            );
            assert_eq!(
                fixture.runtime.require_snapshot(&fixture.target).unwrap(),
                target
            );
            assert_eq!(
                durable_rows(&fixture.database.0, &fixture.source).await,
                before
            );
        }
        let RuntimeProjection::Operations(operations) = fixture
            .runtime
            .projection(&ObservationRequest::Operations {
                account_id: fixture.source.clone(),
            })
            .unwrap()
            .projection
        else {
            panic!("expected Operations");
        };
        let projection = operations
            .operations
            .iter()
            .find(|operation| operation.operation_id == SEMANTIC)
            .unwrap();
        assert_eq!(
            projection.resolution,
            if status == "failed" {
                OperationResolution::LegacyFailed
            } else {
                OperationResolution::LegacyConflicted
            }
        );
        assert_eq!(projection.next_attempt_at_ms, None);
        assert_eq!(projection.rejection_code, None);
        assert_eq!(
            serde_json::to_value(&projection.cross_account_move.as_ref().unwrap().disposition)
                .unwrap(),
            json!({"type":"legacyHeld"})
        );
        fixture.runtime.close().await;
    }
}
