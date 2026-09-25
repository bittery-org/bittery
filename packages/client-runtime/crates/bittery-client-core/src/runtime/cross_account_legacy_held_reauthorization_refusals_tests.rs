//! Explicit destination authorization must refuse stale and read-only authority before proof I/O.
use super::recovery_tests::{prepare, readded_held_target, readded_held_target_with_http};
use super::*;

fn held(fixture: &AdmittedMoveFixture) -> CrossAccountMoveRecord {
    fixture
        .runtime
        .require_snapshot(&fixture.source)
        .unwrap()
        .cross_account_moves
        .into_iter()
        .filter_map(|entry| entry.into_captured())
        .find(|record| record.operation_id == SEMANTIC)
        .unwrap()
}

#[tokio::test]
async fn held_destination_authorization_refuses_stale_and_independently_owned_source_before_proof()
{
    let (fixture, original, _artifacts) = readded_held_target("failed").await;
    let guard = prepare(&fixture, 1).await;
    let held_before_favorite = held(&fixture);
    let target_before_favorite = fixture.runtime.require_snapshot(&fixture.target).unwrap();
    let RuntimeResponse::Accepted {
        operation_id: favorite_operation_id,
        ..
    } = fixture
        .runtime
        .request(
            RuntimeRequest::SetItemFavorite {
                account_id: fixture.source.clone(),
                item_id: SOURCE_ITEM.into(),
                favorite: !original.source.favorite,
            },
            RequestCancellation::new(),
        )
        .await
        .unwrap()
    else {
        panic!("ordinary same-source Favorite must be accepted beside a held Move");
    };
    assert_ne!(favorite_operation_id, SEMANTIC);
    let source_with_owner = fixture.runtime.require_snapshot(&fixture.source).unwrap();
    assert_eq!(held(&fixture), held_before_favorite);
    assert_eq!(source_with_owner.operations.len(), 1);
    assert_eq!(source_with_owner.items.len(), 1);
    assert_eq!(
        source_with_owner.items[0].operation_id,
        favorite_operation_id
    );

    let requests_before_stale = fixture.http.requests.lock().unwrap().len();
    assert!(fixture
        .runtime
        .request(
            RuntimeRequest::ResumeCrossAccountMove { guard },
            RequestCancellation::new(),
        )
        .await
        .is_err());
    assert_eq!(
        fixture.http.requests.lock().unwrap().len(),
        requests_before_stale
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        source_with_owner
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before_favorite
    );
    assert_eq!(held(&fixture), held_before_favorite);

    let requests_before_fresh_prepare = fixture.http.requests.lock().unwrap().len();
    let error = fixture
        .runtime
        .request(
            RuntimeRequest::PrepareCrossAccountMoveResume {
                account_id: fixture.source.clone(),
                operation_id: SEMANTIC.into(),
                target_account_id: fixture.target.clone(),
                expected_binding_revision: 1,
            },
            RequestCancellation::new(),
        )
        .await
        .expect_err("independent source ownership must refuse fresh authorization before proof");
    assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
    assert_eq!(
        fixture.http.requests.lock().unwrap().len(),
        requests_before_fresh_prepare
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.source).unwrap(),
        source_with_owner
    );
    assert_eq!(
        fixture.runtime.require_snapshot(&fixture.target).unwrap(),
        target_before_favorite
    );
    assert_eq!(held(&fixture), held_before_favorite);
    fixture.runtime.close().await;
}

#[tokio::test]
async fn held_destination_authorization_requires_current_writable_member_authority_before_proof() {
    for (source_read_only, status) in [(true, "failed"), (false, "conflicted")] {
        let mut http = MoveHttp::new();
        let endpoint = Arc::get_mut(&mut http).unwrap();
        endpoint.source.use_shared_member(&[41; 32]);
        endpoint.target.use_shared_member(&TARGET_KEY);
        let (fixture, original, _artifacts) = readded_held_target_with_http(status, http).await;
        let (account, endpoint) = if source_read_only {
            (&fixture.source, &fixture.http.source)
        } else {
            (&fixture.target, &fixture.http.target)
        };
        assert_eq!(
            fixture
                .runtime
                .require_snapshot(account)
                .unwrap()
                .bootstrap
                .snapshot()
                .visible_vaults[0]
                .role,
            crate::replica::AuthorityVaultRole::Member
        );
        assert_eq!(endpoint.current_vault()["role"], "member");
        assert_eq!(
            fixture.http.target.server.created_items(),
            vec![TARGET_ITEM.to_owned()]
        );

        endpoint.set_vault_role(crate::server_contract::VaultRole::ReadOnly);
        let cursor = if source_read_only {
            "held-reauthorization-source-read-only"
        } else {
            "held-reauthorization-target-read-only"
        };
        *endpoint.server.sync_cursor.lock().unwrap() = Some(cursor.into());
        endpoint.server.script_sync_page(
            vec![json!({
                "id":cursor, "type":"vault_updated", "entityType":"vault",
                "entityId":"vault-1", "userId":"user-1", "vaultId":"vault-1",
                "clientId":null, "metadata":null, "timestamp":"1700000000000", "version":1
            })],
            cursor,
            false,
        );
        fixture.http.offline.store(false, Ordering::SeqCst);
        fixture.http.resumed.store(true, Ordering::SeqCst);
        let syncing = tokio::spawn(fixture.runtime.clone().run_live_sync());
        let settled = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = fixture.runtime.require_snapshot(account).unwrap();
                if snapshot.bootstrap.state == crate::replica::ReplicaState::Ready
                    && snapshot.bootstrap.active_cursor
                        == (crate::replica::SyncCursor::CapturedValue { id: cursor.into() })
                    && snapshot
                        .bootstrap
                        .snapshot()
                        .visible_vaults
                        .iter()
                        .any(|vault| {
                            vault.id == "vault-1"
                                && vault.role == crate::replica::AuthorityVaultRole::ReadOnly
                        })
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;
        syncing.abort();
        let _ = syncing.await;
        settled.expect("actual live Sync must install the current shared RSA ReadOnly role");

        let source_before_prepare = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before_prepare = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let held_before_prepare = held(&fixture);
        assert!(source_before_prepare.items.is_empty());
        assert_eq!(
            held_before_prepare.legacy_admission,
            original.legacy_admission
        );
        assert_eq!(held_before_prepare.source, original.source);
        assert_eq!(held_before_prepare.target, original.target);
        assert_eq!(held_before_prepare.children, original.children);
        let requests_before_prepare = fixture.http.requests.lock().unwrap().len();
        let error = fixture
            .runtime
            .request(
                RuntimeRequest::PrepareCrossAccountMoveResume {
                    account_id: fixture.source.clone(),
                    operation_id: SEMANTIC.into(),
                    target_account_id: fixture.target.clone(),
                    expected_binding_revision: 1,
                },
                RequestCancellation::new(),
            )
            .await
            .expect_err("current ReadOnly authority must refuse authorization before proof I/O");
        assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
        assert_eq!(
            fixture.http.requests.lock().unwrap().len(),
            requests_before_prepare
        );
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            source_before_prepare
        );
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before_prepare
        );
        assert_eq!(held(&fixture), held_before_prepare);
        fixture.runtime.close().await;
    }
}
