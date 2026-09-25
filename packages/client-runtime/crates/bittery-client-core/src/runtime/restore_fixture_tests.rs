use super::*;
use crate::VaultImageArtifactPort;
use sha2::{Digest, Sha256};

#[tokio::test]
async fn bare_identity_fixture_restore_preserves_raw_work_without_authorizing_image_upgrade() {
    let (runtime, persistence, _) = super::super::teardown_tests::create_vault_teardown_harness();
    super::super::create_vault_tests::seed_image_cleanup(&persistence, "accepted-image", false)
        .await;
    let account = AccountId::from("account-1");
    runtime.replica.load(&account).await.unwrap();
    let before = runtime.replica.snapshot(&account).unwrap();
    assert!(runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .is_none());
    let artifacts = Arc::new(crate::MemoryVaultImageArtifactStore::default());
    let metadata = crate::VaultImageArtifactMetadata::new(
        crate::VaultImageArtifactScope::new(account.clone(), "accepted-image").unwrap(),
        "vault-cleanup",
        11,
        "image/png",
        format!("{:x}", Sha256::digest(b"image-bytes")),
    )
    .unwrap();
    artifacts.begin(metadata.scope()).await.unwrap();
    artifacts
        .write_chunk(metadata.scope(), 0, b"image-bytes")
        .await
        .unwrap();
    artifacts.publish(&metadata).await.unwrap();
    runtime.install_vault_image_ingress(
        crate::VaultImageIngressFacade::new(
            "fixture-restore",
            Arc::new(super::super::create_vault_tests::ExactImageSourcePort),
            artifacts.clone(),
        )
        .unwrap(),
    );

    runtime
        .restore_known_accounts(vec![account.clone()])
        .await
        .unwrap();

    assert_eq!(runtime.replica.snapshot(&account).unwrap(), before);
    assert_eq!(persistence.snapshot(&account).unwrap(), before);
    assert_eq!(
        artifacts.read_chunk(&metadata, 0).await.unwrap().unwrap(),
        b"image-bytes"
    );
    assert!(artifacts
        .read_generation(metadata.scope(), Some(""))
        .await
        .unwrap()
        .is_none());
    assert!(runtime
        .platform_storage
        .load_device_key()
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        runtime.account_access_state(&account),
        Some(AccountAccessState::SignedOut)
    );
}
