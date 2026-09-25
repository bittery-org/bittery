//! Stopped workflows cannot send an undecided original child.
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[path = "cross_account_legacy_held_resume_tests.rs"]
mod resume_tests;

#[tokio::test]
async fn held_cross_count_zero_missing_target_proof_parks_without_creating_an_item() {
    for status in ["failed", "conflicted"] {
        let (fixture, original) = admitted_legacy_move_with_history(
            json!({"status":status,"retryCount":"0","lastError":"departed failure without a receipt"}),
            None,
        ).await;
        let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let rows_before = durable_rows(&fixture.database.0, &fixture.source).await;
        assert_eq!(original.children.len(), 1);
        assert!(original.children[0].item().unwrap().result.is_none());
        assert!(source_before.items.is_empty());
        assert!(!source_before.item_has_optimistic_owner(SOURCE_ITEM));
        fixture.http.offline.store(false, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        let result = fixture
            .runtime
            .dispatch_cross_account_move(&source_before, SEMANTIC)
            .await;
        assert!(
            fixture.http.mutations(TARGET_ORIGIN).is_empty(),
            "{status}: Missing proof cannot authorize Create"
        );
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        assert!(matches!(result, DispatchPass::Parked));
        assert!(fixture
            .http
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|request| request.method == "GET"
                && request.url
                    == format!("{TARGET_ORIGIN}/api/v1/operations/{SEMANTIC}:create-target")));
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            source_before
        );
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before
        );
        assert_eq!(
            durable_rows(&fixture.database.0, &fixture.source).await,
            rows_before
        );
        assert!(fixture.http.target.server.created_items().is_empty());
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
        assert_source_visible(
            &fixture.runtime,
            &fixture.source,
            crate::ItemProjectionStatus::Authoritative,
        );
        fixture.runtime.close().await;
    }
}

#[path = "cross_account_legacy_held_reauthorization_tests.rs"]
mod reauthorization_tests;
