//! Held missing-source work accepts readable scopes and remains held after destination replacement.
use super::super::lifecycle_tests::account_lifecycle_case;
use super::*;

#[tokio::test]
async fn failed_readonly_scopes_preserve_legacy_hold_across_actual_destination_remove_and_readd() {
    let oracle = failed_independent_deletion_oracle();
    let (mut source, command, mut network) = protected_crash_source_from(&oracle);
    // Protected key roles and the matching genuine authentication/bootstrap responses are host
    // scaffolding; immutable producer account/cache/queue pages are unchanged. This demonstrates
    // the existing readable-scope policy, not the producer's historical membership provenance.
    let fixture = Arc::get_mut(&mut source).unwrap();
    let frozen_store = fixture.inner.store.clone();
    let frozen_sync = fixture.inner.sync.clone();
    for keys in [
        &mut fixture.inner.credentials[4],
        &mut fixture.second_credentials.as_mut().unwrap()[3],
    ] {
        let mut decoded: Value = serde_json::from_str(keys.as_ref().unwrap()).unwrap();
        assert_eq!(decoded.as_array().unwrap().len(), 1);
        decoded[0]["role"] = json!("read-only");
        *keys = Some(decoded.to_string());
    }
    let peers = Arc::get_mut(&mut network).unwrap();
    peers.source.vault_role = "read-only";
    peers.target.vault_role = "read-only";
    assert_eq!(fixture.inner.store, frozen_store);
    assert_eq!(fixture.inner.sync, frozen_sync);
    account_lifecycle_case(source, command, network, assert_failed_projection).await;
}
