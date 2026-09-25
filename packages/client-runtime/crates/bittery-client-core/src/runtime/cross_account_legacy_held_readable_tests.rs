//! Register beneath cross_account_legacy_remote_progress_tests.rs.
use super::*;
use crate::runtime::dispatch::DispatchPass;

#[tokio::test]
async fn held_cross_read_only_participants_recover_original_proof_without_authorizing_new_work() {
    for source_read_only in [true, false] {
        let mut http = MoveHttp::new();
        if source_read_only {
            Arc::get_mut(&mut http)
                .unwrap()
                .source
                .use_shared_member(&[41; 32]);
        } else {
            Arc::get_mut(&mut http)
                .unwrap()
                .target
                .use_shared_member(&TARGET_KEY);
        }
        let (fixture, original) = admitted_legacy_move_with_http_and_history(
            json!({"status": if source_read_only { "failed" } else { "conflicted" }}),
            None,
            http,
        )
        .await;
        let account = if source_read_only {
            &fixture.source
        } else {
            &fixture.target
        };
        let endpoint = if source_read_only {
            &fixture.http.source
        } else {
            &fixture.http.target
        };
        let before_role = fixture.runtime.require_snapshot(account).unwrap();
        let vault = &before_role.bootstrap.snapshot().visible_vaults[0];
        assert_eq!(vault.role, crate::replica::AuthorityVaultRole::Member);
        assert_eq!(endpoint.current_vault()["vaultType"], "team");
        assert_eq!(endpoint.current_vault()["role"], "member");
        // The exact original target operation really completed while its participant could write.
        let original_request = request(&original, CrossAccountMoveStep::TargetCreate);
        let outcome: Value =
            serde_json::from_slice(&historical_effect(&fixture, &original_request)).unwrap();
        assert_eq!(outcome["result"]["status"], "applied");
        assert_eq!(outcome["result"]["version"], 1);
        endpoint.set_vault_role(crate::server_contract::VaultRole::ReadOnly);
        let cursor = "held-cross-read-only";
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
        let ready = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let snapshot = fixture.runtime.require_snapshot(account).unwrap();
                let authority = snapshot.bootstrap.snapshot();
                if snapshot.bootstrap.state == crate::replica::ReplicaState::Ready
                    && snapshot.bootstrap.active_cursor
                        == (crate::replica::SyncCursor::CapturedValue { id: cursor.into() })
                    && authority.visible_vaults.iter().any(|vault| {
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
        ready.expect(
            "actual Sync must retain the shared RSA key and install current ReadOnly membership",
        );
        let durable = durable_rows(&fixture.database.0, account).await;
        let stored_bootstrap: Value = durable
            .iter()
            .find(|row| row["store"] == "replicaMetadata" && row["key"]["recordId"] == "bootstrap")
            .map(|row| serde_json::from_str(row["payloadJson"].as_str().unwrap()).unwrap())
            .unwrap();
        assert_eq!(stored_bootstrap["state"], "ready");
        assert_eq!(
            stored_bootstrap["activeCursor"],
            json!({"type":"capturedValue", "id":cursor})
        );
        let active_generation = stored_bootstrap["activeGeneration"].as_str().unwrap();
        assert_eq!(
            fixture
                .runtime
                .require_snapshot(account)
                .unwrap()
                .bootstrap
                .active_generation
                .as_ref()
                .unwrap()
                .0,
            active_generation
        );
        // Retained earlier generations may still contain the prior Member row.
        let current_vault_id = format!("{active_generation}/vault-1");
        let current_vault_rows = durable
            .iter()
            .filter(|row| {
                row["store"] == "authorityVaults" && row["key"]["recordId"] == current_vault_id
            })
            .collect::<Vec<_>>();
        assert_eq!(current_vault_rows.len(), 1);
        let stored_vault: Value =
            serde_json::from_str(current_vault_rows[0]["payloadJson"].as_str().unwrap()).unwrap();
        assert_eq!(stored_vault["vaultType"], "team");
        assert_eq!(stored_vault["role"], "readOnly");
        assert_eq!(endpoint.current_vault()["role"], "read-only");
        let source_before = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        let target_before = fixture.runtime.require_snapshot(&fixture.target).unwrap();
        let requests_before = fixture.http.requests.lock().unwrap().len();
        let error = fixture
            .runtime
            .request(
                RuntimeRequest::MoveItem {
                    account_id: fixture.source.clone(),
                    item_id: SOURCE_ITEM.into(),
                    target_account_id: Some(fixture.target.clone()),
                    target_vault_id: "vault-1".into(),
                },
                RequestCancellation::new(),
            )
            .await
            .expect_err("a new cross-Account Move still requires both writable roles");
        assert_eq!(error.code, RuntimeErrorCode::AccessDenied);
        assert!(
            error.message.contains("writable"),
            "normal refusal must come from the changed role: {error:?}"
        );
        assert_eq!(fixture.http.requests.lock().unwrap().len(), requests_before);
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.source).unwrap(),
            source_before
        );
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before
        );
        let source_evidence = server_evidence(&fixture.http.source.server);
        let target_evidence = server_evidence(&fixture.http.target.server);
        let mut parked = false;
        for _ in 0..6 {
            let snapshot = fixture.runtime.require_snapshot(&fixture.source).unwrap();
            if matches!(
                fixture
                    .runtime
                    .dispatch_cross_account_move(&snapshot, SEMANTIC)
                    .await,
                DispatchPass::Parked
            ) {
                parked = true;
                break;
            }
        }
        assert!(parked, "the undecided original source Trash must park");
        let after = current(&fixture);
        assert_eq!(after.stage, CrossAccountMoveStage::SourceTrash);
        assert_eq!(after.children.len(), 2);
        assert!(after.children[0].item().unwrap().result.is_some());
        assert!(after.children[1].item().unwrap().result.is_none());
        assert_eq!(after.legacy_admission, original.legacy_admission);
        let replays = fixture.http.mutations(TARGET_ORIGIN);
        assert_eq!(replays.len(), 1);
        assert_eq!(replays[0].method, original_request.method);
        assert_eq!(replays[0].url, original_request.url);
        assert_eq!(replays[0].body, original_request.body);
        assert_eq!(
            replays[0].header("Idempotency-Key"),
            original_request.header("Idempotency-Key")
        );
        assert!(fixture.http.mutations(SOURCE_ORIGIN).is_empty());
        for (origin, suffix) in [
            (TARGET_ORIGIN, "create-target"),
            (SOURCE_ORIGIN, "trash-source"),
        ] {
            assert!(
                fixture.http.requests.lock().unwrap().iter().any(|request| {
                    request.method == "GET"
                        && request.url == format!("{origin}/api/v1/operations/{SEMANTIC}:{suffix}")
                }),
                "both the original decided target and undecided source child must be looked up"
            );
        }
        assert_eq!(
            server_evidence(&fixture.http.source.server),
            source_evidence
        );
        assert_eq!(
            server_evidence(&fixture.http.target.server),
            target_evidence
        );
        let source_after = fixture.runtime.require_snapshot(&fixture.source).unwrap();
        assert_eq!(source_after.bootstrap, source_before.bootstrap);
        assert_eq!(source_after.items, source_before.items);
        assert_eq!(
            fixture.runtime.require_snapshot(&fixture.target).unwrap(),
            target_before
        );
        fixture.runtime.close().await;
    }
}
